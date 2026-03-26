/**
 * Attention Detection Module v2
 * Scoring-based: each frame gets a numeric score 0–1.
 * Eye score (weight 0.6) + Head score (weight 0.4)
 * Smoothed over sliding window, emitted every 1s.
 */
(function () {
  "use strict";

  /* ── Config ──────────────────────────────────────────────── */
  const DETECT_INTERVAL_MS = 200;       // 5 fps (realistic for TF.js FaceMesh)
  const EMIT_INTERVAL_MS = 1000;        // emit to server every 1s
  const WINDOW_SECONDS = 3;             // sliding window: 3 seconds
  const EAR_CLOSED = 0.17;             // EAR below = eyes closed
  const BLINK_IGNORE_MS = 350;          // ignore blinks shorter than this
  const GRACE_MS = 2000;                // head away <2s = still active
  const CALIBRATION_SEC = 3;            // calibrate for first 3 seconds

  const EYE_WEIGHT = 0.6;
  const HEAD_WEIGHT = 0.4;

  // Head thresholds (relative to calibrated baseline)
  const YAW_SLIGHT = 18;
  const YAW_AWAY = 40;
  const PITCH_DOWN = 28;
  const PITCH_AWAY = 40;

  /* ── Landmark indices ──────────────────────────────────────── */
  const LEFT_EYE = [362, 385, 387, 263, 373, 380];
  const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
  const NOSE_TIP = 1;
  const CHIN = 152;
  const LEFT_EYE_CORNER = 263;
  const RIGHT_EYE_CORNER = 33;

  /* ── State ─────────────────────────────────────────────────── */
  let detector = null;
  let running = false;
  let videoEl = null;
  let socketRef = null;
  let loopTimer = null;
  let lastEmitTime = 0;
  let onStatusChange = null;
  let detecting = false; // prevent overlapping detect calls

  const scoreWindow = [];   // { score, ts } — ts is Date.now()
  let eyesClosedSince = 0;
  let headAwaySince = 0;
  let lastGoodHeadScore = 1;

  // Calibration
  let calibrating = true;
  let calSamples = [];
  let baseYaw = 0;
  let basePitch = 0;

  let currentScore = 0;
  let currentStatus = "Unknown";
  let _dbg = 0;

  /* ── Math ──────────────────────────────────────────────────── */
  function dist(a, b) {
    return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
  }

  function computeEAR(pts) {
    const v1 = dist(pts[1], pts[5]);
    const v2 = dist(pts[2], pts[4]);
    const h = dist(pts[0], pts[3]);
    return h < 1e-6 ? 0 : (v1 + v2) / (2 * h);
  }

  function headPose(kp) {
    const nose = kp[NOSE_TIP], chin = kp[CHIN];
    const le = kp[LEFT_EYE_CORNER], re = kp[RIGHT_EYE_CORNER];
    if (!nose || !chin || !le || !re) return { yaw: 0, pitch: 0 };

    const ld = dist([nose[0], nose[1]], [le[0], le[1]]);
    const rd = dist([nose[0], nose[1]], [re[0], re[1]]);
    const t = ld + rd;
    const yaw = t > 1e-6 ? ((rd / t) - 0.5) * 100 : 0;

    const eyeY = (le[1] + re[1]) / 2;
    const fh = dist([chin[0], chin[1]], [(le[0] + re[0]) / 2, eyeY]);
    const nr = fh > 1e-6 ? ((nose[1] - eyeY) / fh) : 0.4;
    const pitch = (nr - 0.4) * 120;

    return { yaw, pitch };
  }

  /* ── Scoring ───────────────────────────────────────────────── */
  function scoreEyes(earL, earR, now) {
    const avg = (earL + earR) / 2;
    if (avg < EAR_CLOSED) {
      if (!eyesClosedSince) eyesClosedSince = now;
      return (now - eyesClosedSince < BLINK_IGNORE_MS) ? 1 : 0;
    }
    eyesClosedSince = 0;
    return 1;
  }

  function scoreHead(yaw, pitch, now) {
    const ay = Math.abs(yaw - baseYaw);
    const ap = pitch - basePitch;
    let raw;

    if (ay > YAW_AWAY || Math.abs(ap) > PITCH_AWAY) raw = 0;
    else if (ap > PITCH_DOWN) raw = 0;
    else if (ay > YAW_SLIGHT) raw = 0.5;
    else raw = 1;

    if (raw < 1) {
      if (!headAwaySince) headAwaySince = now;
      if (now - headAwaySince < GRACE_MS) return lastGoodHeadScore;
      return raw;
    }
    headAwaySince = 0;
    lastGoodHeadScore = raw;
    return raw;
  }

  function windowAvg(now) {
    const cutoff = now - WINDOW_SECONDS * 1000;
    while (scoreWindow.length && scoreWindow[0].ts < cutoff) scoreWindow.shift();
    if (!scoreWindow.length) return 0;
    let s = 0;
    for (const f of scoreWindow) s += f.score;
    return s / scoreWindow.length;
  }

  function toStatus(s) {
    if (s > 0.7) return "Active";
    if (s >= 0.4) return "Semi-active";
    return "Not active";
  }

  /* ── Detection loop (setInterval, not rAF) ─────────────────── */
  async function tick() {
    if (!running || !detector || !videoEl || detecting) return;
    detecting = true;
    const now = Date.now();

    try {
      if (videoEl.readyState < 2) { detecting = false; return; }

      const faces = await detector.estimateFaces(videoEl, { flipHorizontal: false });

      if (faces.length > 0) {
        const kp = faces[0].keypoints.map(p => [p.x, p.y, p.z || 0]);
        const earL = computeEAR(LEFT_EYE.map(i => kp[i]));
        const earR = computeEAR(RIGHT_EYE.map(i => kp[i]));
        const { yaw, pitch } = headPose(kp);

        if (calibrating) {
          calSamples.push({ yaw, pitch });
          scoreWindow.push({ score: 1, ts: now });
          if (calSamples.length >= Math.floor(CALIBRATION_SEC * (1000 / DETECT_INTERVAL_MS))) {
            let sy = 0, sp = 0;
            for (const c of calSamples) { sy += c.yaw; sp += c.pitch; }
            baseYaw = sy / calSamples.length;
            basePitch = sp / calSamples.length;
            calibrating = false;
            console.log("[attention] calibrated: yaw=" + baseYaw.toFixed(1) + " pitch=" + basePitch.toFixed(1));
          }
        } else {
          const es = scoreEyes(earL, earR, now);
          const hs = scoreHead(yaw, pitch, now);
          const fs = es * EYE_WEIGHT + hs * HEAD_WEIGHT;
          scoreWindow.push({ score: fs, ts: now });

          // Debug every 5s
          if (now - _dbg > 5000) {
            _dbg = now;
            console.log("[attention] ear:" + ((earL + earR) / 2).toFixed(3),
              "eye:" + es, "head:" + hs.toFixed(1),
              "score:" + currentScore.toFixed(2), "→", currentStatus);
          }
        }
      } else {
        // No face → 0
        scoreWindow.push({ score: 0, ts: now });
      }

      currentScore = windowAvg(now);
      currentStatus = toStatus(currentScore);
      if (onStatusChange) onStatusChange(currentStatus, currentScore);

      // Emit to server
      if (socketRef && socketRef.connected && now - lastEmitTime >= EMIT_INTERVAL_MS) {
        lastEmitTime = now;
        socketRef.emit("attention:status", {
          status: currentStatus,
          score: Math.round(currentScore * 100) / 100,
        });
      }
    } catch (err) {
      console.warn("[attention] error:", err.message);
    }
    detecting = false;
  }

  /* ── Public API ────────────────────────────────────────────── */
  async function start(video, socket, statusCallback) {
    if (running) return;
    videoEl = video;
    socketRef = socket;
    onStatusChange = statusCallback || null;
    scoreWindow.length = 0;
    calSamples = [];
    calibrating = true;
    baseYaw = 0; basePitch = 0;
    eyesClosedSince = 0; headAwaySince = 0; lastGoodHeadScore = 1;
    currentScore = 0; currentStatus = "Unknown";
    lastEmitTime = 0; _dbg = 0; detecting = false;

    if (!window.tf) {
      await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-core@4.22.0/dist/tf-core.min.js");
      await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-converter@4.22.0/dist/tf-converter.min.js");
      await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-backend-webgl@4.22.0/dist/tf-backend-webgl.min.js");
      await tf.setBackend("webgl");
      await tf.ready();
    }
    if (!window.faceLandmarksDetection) {
      await loadScript("https://cdn.jsdelivr.net/npm/@tensorflow-models/face-landmarks-detection@1.0.5/dist/face-landmarks-detection.min.js");
    }

    detector = await faceLandmarksDetection.createDetector(
      faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh,
      { runtime: "tfjs", refineLandmarks: true, maxFaces: 1 }
    );

    running = true;
    loopTimer = setInterval(tick, DETECT_INTERVAL_MS);
    console.log("[attention] started (5fps, calibrating " + CALIBRATION_SEC + "s)");
  }

  function stop() {
    running = false;
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    if (detector) { try { detector.dispose(); } catch (_) {} detector = null; }
    videoEl = null; socketRef = null; onStatusChange = null;
    scoreWindow.length = 0; calSamples = [];
    currentScore = 0; currentStatus = "Unknown";
    console.log("[attention] stopped");
  }

  function isRunning() { return running; }
  function getStatus() { return currentStatus; }
  function getScore() { return currentScore; }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement("script");
      s.src = src; s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(s);
    });
  }

  window.AttentionDetection = { start, stop, isRunning, getStatus, getScore };
})();
