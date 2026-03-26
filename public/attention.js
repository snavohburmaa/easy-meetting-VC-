/**
 * Attention Detection v9
 * Gets its OWN camera stream via getUserMedia (separate from the meeting stream).
 * This guarantees full-resolution video frames for face detection.
 */
(function () {
  "use strict";

  const DETECT_INTERVAL_MS = 300;
  const EMIT_INTERVAL_MS = 1000;
  const WINDOW_SECONDS = 3;
  const EAR_CLOSED = 0.17;
  const BLINK_IGNORE_MS = 350;
  const GRACE_MS = 2000;
  const CALIBRATION_SEC = 3;
  const EYE_WEIGHT = 0.6, HEAD_WEIGHT = 0.4;
  const YAW_SLIGHT = 18, YAW_AWAY = 40, PITCH_DOWN = 28, PITCH_AWAY = 40;

  const LEFT_EYE = [362, 385, 387, 263, 373, 380];
  const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
  const NOSE_TIP = 1, CHIN = 152, L_EYE_C = 263, R_EYE_C = 33;

  let faceLandmarker = null;
  let running = false;
  let myStream = null;
  let myVideo = null;
  let canvasEl = null;
  let ctxEl = null;
  let socketRef = null;
  let loopTimer = null;
  let lastEmitTime = 0;
  let onStatusChange = null;
  let busy = false;

  const scoreWindow = [];
  let eyesClosedSince = 0, headAwaySince = 0, lastGoodHeadScore = 1;
  let calibrating = true, calSamples = [], baseYaw = 0, basePitch = 0;
  let currentScore = 0, currentStatus = "Unknown";
  let _dbg = 0, _tickCount = 0, _faceCount = 0;

  function dist(a, b) { return Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2); }
  function computeEAR(pts) {
    const v1 = dist(pts[1], pts[5]), v2 = dist(pts[2], pts[4]), h = dist(pts[0], pts[3]);
    return h < 1e-6 ? 0 : (v1 + v2) / (2 * h);
  }
  function headPose(kp) {
    const nose = kp[NOSE_TIP], chin = kp[CHIN], le = kp[L_EYE_C], re = kp[R_EYE_C];
    if (!nose || !chin || !le || !re) return { yaw: 0, pitch: 0 };
    const ld = dist(nose, le), rd = dist(nose, re), t = ld + rd;
    const yaw = t > 1e-6 ? ((rd / t) - 0.5) * 100 : 0;
    const eyeY = (le[1] + re[1]) / 2;
    const fh = dist(chin, [(le[0]+re[0])/2, eyeY]);
    const pitch = fh > 1e-6 ? (((nose[1] - eyeY) / fh) - 0.4) * 120 : 0;
    return { yaw, pitch };
  }
  function scoreEyes(earL, earR, now) {
    if ((earL + earR) / 2 < EAR_CLOSED) {
      if (!eyesClosedSince) eyesClosedSince = now;
      return (now - eyesClosedSince < BLINK_IGNORE_MS) ? 1 : 0;
    }
    eyesClosedSince = 0; return 1;
  }
  function scoreHead(yaw, pitch, now) {
    const ay = Math.abs(yaw - baseYaw), ap = pitch - basePitch;
    let raw = 1;
    if (ay > YAW_AWAY || Math.abs(ap) > PITCH_AWAY) raw = 0;
    else if (ap > PITCH_DOWN) raw = 0;
    else if (ay > YAW_SLIGHT) raw = 0.5;
    if (raw < 1) {
      if (!headAwaySince) headAwaySince = now;
      return (now - headAwaySince < GRACE_MS) ? lastGoodHeadScore : raw;
    }
    headAwaySince = 0; lastGoodHeadScore = raw; return raw;
  }
  function windowAvg(now) {
    const cutoff = now - WINDOW_SECONDS * 1000;
    while (scoreWindow.length && scoreWindow[0].ts < cutoff) scoreWindow.shift();
    if (!scoreWindow.length) return 0;
    let s = 0; for (const f of scoreWindow) s += f.score; return s / scoreWindow.length;
  }
  function toStatus(s) { return s > 0.7 ? "Active" : s >= 0.4 ? "Semi-active" : "Not active"; }

  function tick() {
    if (!running || !faceLandmarker || !myVideo || !canvasEl || busy) return;
    if (myVideo.readyState < 2) return;
    busy = true;
    _tickCount++;
    const now = Date.now();

    try {
      ctxEl.drawImage(myVideo, 0, 0, canvasEl.width, canvasEl.height);
      const result = faceLandmarker.detect(canvasEl);
      const has = result && result.faceLandmarks && result.faceLandmarks.length > 0;

      if (_tickCount <= 5) {
        console.log("[attention] tick#" + _tickCount, "faces:" + (has ? result.faceLandmarks.length : 0));
      }

      if (has) {
        _faceCount++;
        const lm = result.faceLandmarks[0];
        const w = canvasEl.width, h = canvasEl.height;
        const kp = lm.map(p => [p.x * w, p.y * h, p.z || 0]);
        const earL = computeEAR(LEFT_EYE.map(i => kp[i]));
        const earR = computeEAR(RIGHT_EYE.map(i => kp[i]));
        const { yaw, pitch } = headPose(kp);

        if (calibrating) {
          calSamples.push({ yaw, pitch });
          scoreWindow.push({ score: 1, ts: now });
          if (calSamples.length >= Math.floor(CALIBRATION_SEC * (1000 / DETECT_INTERVAL_MS))) {
            let sy = 0, sp = 0;
            for (const c of calSamples) { sy += c.yaw; sp += c.pitch; }
            baseYaw = sy / calSamples.length; basePitch = sp / calSamples.length;
            calibrating = false;
            console.log("[attention] calibrated: yaw=" + baseYaw.toFixed(1) + " pitch=" + basePitch.toFixed(1));
          }
        } else {
          const es = scoreEyes(earL, earR, now);
          const hs = scoreHead(yaw, pitch, now);
          scoreWindow.push({ score: es * EYE_WEIGHT + hs * HEAD_WEIGHT, ts: now });
          if (now - _dbg > 5000) {
            _dbg = now;
            console.log("[attention] ear:" + ((earL+earR)/2).toFixed(3),
              "eye:" + es, "head:" + hs.toFixed(1),
              "score:" + currentScore.toFixed(2), "→", currentStatus,
              "faces:" + _faceCount + "/" + _tickCount);
          }
        }
      } else {
        scoreWindow.push({ score: 0, ts: now });
      }
    } catch (err) {
      if (_tickCount <= 5) console.warn("[attention] tick error:", err.message);
    }

    currentScore = windowAvg(now);
    currentStatus = toStatus(currentScore);
    if (onStatusChange) onStatusChange(currentStatus, currentScore);

    if (socketRef && socketRef.connected && now - lastEmitTime >= EMIT_INTERVAL_MS) {
      lastEmitTime = now;
      socketRef.emit("attention:status", { status: currentStatus, score: Math.round(currentScore * 100) / 100 });
    }
    busy = false;
  }

  async function start(video, socket, statusCallback) {
    if (running) return;
    socketRef = socket;
    onStatusChange = statusCallback || null;
    scoreWindow.length = 0; calSamples = []; calibrating = true;
    baseYaw = 0; basePitch = 0;
    eyesClosedSince = 0; headAwaySince = 0; lastGoodHeadScore = 1;
    currentScore = 0; currentStatus = "Unknown";
    lastEmitTime = 0; _dbg = 0; _tickCount = 0; _faceCount = 0; busy = false;

    // Get a SEPARATE camera stream just for detection (low res is fine)
    console.log("[attention] requesting camera for detection...");
    try {
      myStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 5 } },
        audio: false,
      });
    } catch (e) {
      console.error("[attention] camera request failed:", e.message);
      return;
    }

    // Create video element — visible size so browser decodes frames
    myVideo = document.createElement("video");
    myVideo.playsInline = true;
    myVideo.autoplay = true;
    myVideo.muted = true;
    myVideo.srcObject = myStream;
    myVideo.style.cssText = "position:fixed;bottom:0;right:0;width:320px;height:240px;opacity:0.01;pointer-events:none;z-index:-1;";
    document.body.appendChild(myVideo);
    await myVideo.play().catch(() => {});

    // Wait for real frames
    await new Promise(resolve => {
      const check = () => {
        if (myVideo.videoWidth > 10 && myVideo.readyState >= 2) return resolve();
        setTimeout(check, 100);
      };
      check();
      setTimeout(resolve, 5000);
    });

    const w = myVideo.videoWidth;
    const h = myVideo.videoHeight;
    console.log("[attention] detection camera:", w, "x", h);

    // Canvas
    canvasEl = document.createElement("canvas");
    canvasEl.width = w;
    canvasEl.height = h;
    ctxEl = canvasEl.getContext("2d", { willReadFrequently: true });

    // Test draw
    ctxEl.drawImage(myVideo, 0, 0, w, h);
    const px = ctxEl.getImageData(Math.floor(w/2), Math.floor(h/2), 1, 1).data;
    console.log("[attention] test pixel:", px[0], px[1], px[2], px[3]);

    // Load MediaPipe
    console.log("[attention] loading MediaPipe...");
    const vision = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/+esm");
    const { FaceLandmarker, FilesetResolver } = vision;
    const fsr = await FilesetResolver.forVisionTasks("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm");

    faceLandmarker = await FaceLandmarker.createFromOptions(fsr, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "IMAGE",
      numFaces: 1,
    });

    // Test detect
    ctxEl.drawImage(myVideo, 0, 0, w, h);
    const testResult = faceLandmarker.detect(canvasEl);
    console.log("[attention] TEST:", testResult.faceLandmarks.length, "faces");

    running = true;
    loopTimer = setInterval(tick, DETECT_INTERVAL_MS);
    console.log("[attention] RUNNING");
  }

  function stop() {
    running = false;
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    if (faceLandmarker) { try { faceLandmarker.close(); } catch (_) {} faceLandmarker = null; }
    if (myStream) { myStream.getTracks().forEach(t => t.stop()); myStream = null; }
    if (myVideo) { myVideo.srcObject = null; myVideo.remove(); myVideo = null; }
    canvasEl = null; ctxEl = null;
    socketRef = null; onStatusChange = null;
    scoreWindow.length = 0; calSamples = [];
    currentScore = 0; currentStatus = "Unknown";
    console.log("[attention] stopped");
  }

  function isRunning() { return running; }
  function getStatus() { return currentStatus; }
  function getScore() { return currentScore; }

  window.AttentionDetection = { start, stop, isRunning, getStatus, getScore };
})();
