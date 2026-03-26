/**
 * Attention Detection Module v2
 * Scoring-based system with per-frame numeric scores (0–1).
 *
 * - 10–15 checks/second
 * - Eye score: open=1, closed=0 (weight 0.6)
 * - Head score: forward=1, slight turn=0.5, away/down=0 (weight 0.4)
 * - Sliding window smoothing (last 2–3 sec)
 * - Blink ignore (<300ms), grace time (<2s looking away)
 * - Per-user calibration (first 3–5 sec)
 * - Confidence threshold (skip low-confidence frames)
 *
 * Privacy: All inference runs in-browser. Only score + status sent over network.
 */
(function () {
  "use strict";

  /* ── Constants ─────────────────────────────────────────────── */
  const DETECT_INTERVAL_MS = 80;        // ~12 fps (10–15 checks/sec)
  const EMIT_INTERVAL_MS = 1000;        // send to server every 1s
  const WINDOW_SIZE = 30;               // sliding window: ~2.5 sec at 12fps
  const EAR_CLOSED = 0.19;             // EAR below this = eyes closed
  const BLINK_IGNORE_MS = 300;          // blinks shorter than this → still score 1
  const GRACE_MS = 2000;                // looking away < 2s → still active
  const CALIBRATION_FRAMES = 40;        // ~3 sec at 12fps for calibration
  const CONFIDENCE_MIN = 0.5;           // skip frame if face detection confidence below this

  /* Weight */
  const EYE_WEIGHT = 0.6;
  const HEAD_WEIGHT = 0.4;

  /* Head pose thresholds (degrees — applied relative to calibrated baseline) */
  const YAW_SLIGHT = 15;               // slight turn
  const YAW_AWAY = 35;                 // fully looking away
  const PITCH_DOWN = 25;               // head down
  const PITCH_AWAY = 35;               // extreme up/down

  /* ── MediaPipe Face Landmark indices ───────────────────────── */
  const LEFT_EYE = [362, 385, 387, 263, 373, 380];
  const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
  const LEFT_IRIS = 468;
  const RIGHT_IRIS = 473;
  const NOSE_TIP = 1;
  const CHIN = 152;
  const LEFT_EYE_CORNER = 263;
  const RIGHT_EYE_CORNER = 33;
  const LEFT_MOUTH = 287;
  const RIGHT_MOUTH = 57;

  /* ── State ─────────────────────────────────────────────────── */
  let detector = null;
  let running = false;
  let videoEl = null;
  let socketRef = null;
  let rafId = null;
  let lastDetectTime = 0;
  let lastEmitTime = 0;
  let onStatusChange = null;

  // Sliding window of { score, ts }
  const scoreWindow = [];

  // Blink tracking
  let eyesClosedSince = 0;             // timestamp when eyes first closed, 0 = open

  // Grace time tracking
  let headAwaySince = 0;               // timestamp when head first turned away, 0 = forward
  let lastGoodHeadScore = 1;           // last head score before grace period

  // Calibration
  let calibrating = true;
  let calibrationData = [];            // { yaw, pitch } samples
  let baselineYaw = 0;
  let baselinePitch = 0;

  // Current state
  let currentScore = 0;
  let currentStatus = "Unknown";

  /* ── Math helpers ──────────────────────────────────────────── */
  function dist(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  function computeEAR(eyePoints) {
    const v1 = dist(eyePoints[1], eyePoints[5]);
    const v2 = dist(eyePoints[2], eyePoints[4]);
    const h = dist(eyePoints[0], eyePoints[3]);
    if (h < 1e-6) return 0;
    return (v1 + v2) / (2.0 * h);
  }

  function estimateHeadPose(kp) {
    const nose = kp[NOSE_TIP];
    const chin = kp[CHIN];
    const leftEye = kp[LEFT_EYE_CORNER];
    const rightEye = kp[RIGHT_EYE_CORNER];
    if (!nose || !chin || !leftEye || !rightEye) return { yaw: 0, pitch: 0 };

    const leftDist = dist([nose[0], nose[1]], [leftEye[0], leftEye[1]]);
    const rightDist = dist([nose[0], nose[1]], [rightEye[0], rightEye[1]]);
    const total = leftDist + rightDist;
    const yawRatio = total > 1e-6 ? (rightDist / total) : 0.5;
    const yaw = (yawRatio - 0.5) * 100;

    const eyeMidY = (leftEye[1] + rightEye[1]) / 2;
    const faceH = dist([chin[0], chin[1]], [(leftEye[0] + rightEye[0]) / 2, eyeMidY]);
    const noseOff = nose[1] - eyeMidY;
    const pitchRatio = faceH > 1e-6 ? (noseOff / faceH) : 0.4;
    const pitch = (pitchRatio - 0.4) * 120;

    return { yaw, pitch };
  }

  /* ── Scoring functions ─────────────────────────────────────── */

  /**
   * Eye score: 1 = open, 0 = closed
   * Blinks < 300ms are ignored (score stays 1)
   */
  function scoreEyes(earLeft, earRight, now) {
    const avgEAR = (earLeft + earRight) / 2;
    const eyesClosed = avgEAR < EAR_CLOSED;

    if (eyesClosed) {
      if (eyesClosedSince === 0) {
        eyesClosedSince = now;
      }
      const closedDuration = now - eyesClosedSince;
      // Short blink → ignore, still score 1
      if (closedDuration < BLINK_IGNORE_MS) return 1;
      return 0;
    } else {
      eyesClosedSince = 0;
      return 1;
    }
  }

  /**
   * Head score: forward=1, slight turn=0.5, looking away/down=0
   * With grace time: looking away < 2s → keep last good score
   */
  function scoreHead(yaw, pitch, now) {
    // Apply calibration offset
    const adjYaw = Math.abs(yaw - baselineYaw);
    const adjPitch = pitch - baselinePitch; // signed: positive = looking down

    let rawScore;
    if (adjYaw > YAW_AWAY || Math.abs(adjPitch) > PITCH_AWAY) {
      rawScore = 0;           // fully looking away
    } else if (adjPitch > PITCH_DOWN) {
      rawScore = 0;           // head down
    } else if (adjYaw > YAW_SLIGHT) {
      rawScore = 0.5;         // slight turn
    } else {
      rawScore = 1;           // forward
    }

    // Grace time: if head just turned away, keep previous good score for 2s
    if (rawScore < 1) {
      if (headAwaySince === 0) {
        headAwaySince = now;
      }
      const awayDuration = now - headAwaySince;
      if (awayDuration < GRACE_MS) {
        return lastGoodHeadScore;
      }
      return rawScore;
    } else {
      headAwaySince = 0;
      lastGoodHeadScore = rawScore;
      return rawScore;
    }
  }

  /**
   * Sliding window average score
   */
  function getSmoothedScore(now) {
    // Remove frames older than window
    const cutoff = now - (WINDOW_SIZE * DETECT_INTERVAL_MS);
    while (scoreWindow.length > 0 && scoreWindow[0].ts < cutoff) {
      scoreWindow.shift();
    }
    if (scoreWindow.length === 0) return 0;
    let sum = 0;
    for (const f of scoreWindow) sum += f.score;
    return sum / scoreWindow.length;
  }

  /**
   * Convert smoothed score to status string
   */
  function scoreToStatus(score) {
    if (score > 0.7) return "Active";
    if (score >= 0.4) return "Semi-active";
    return "Not active";
  }

  /* ── Calibration ───────────────────────────────────────────── */
  function addCalibrationSample(yaw, pitch) {
    calibrationData.push({ yaw, pitch });
    if (calibrationData.length >= CALIBRATION_FRAMES) {
      // Average the samples to find baseline
      let sumY = 0, sumP = 0;
      for (const s of calibrationData) { sumY += s.yaw; sumP += s.pitch; }
      baselineYaw = sumY / calibrationData.length;
      baselinePitch = sumP / calibrationData.length;
      calibrating = false;
      console.log("[attention] calibrated — baseline yaw:", baselineYaw.toFixed(1),
        "pitch:", baselinePitch.toFixed(1));
    }
  }

  /* ── Detection loop ────────────────────────────────────────── */
  let _lastDebug = 0;

  async function detectLoop() {
    if (!running || !detector || !videoEl) return;

    const now = performance.now();

    if (now - lastDetectTime >= DETECT_INTERVAL_MS) {
      lastDetectTime = now;

      try {
        if (videoEl.readyState >= 2) {
          const faces = await detector.estimateFaces(videoEl, { flipHorizontal: false });

          if (faces.length > 0) {
            const face = faces[0];

            // Confidence threshold: skip low-confidence frames
            const confidence = face.box ? 1 : (face.score || face.confidence || 1);
            if (typeof confidence === "number" && confidence < CONFIDENCE_MIN) {
              rafId = requestAnimationFrame(detectLoop);
              return; // skip this frame
            }

            const kp = face.keypoints.map(p => [p.x, p.y, p.z || 0]);

            // EAR
            const leftEyePts = LEFT_EYE.map(i => kp[i]);
            const rightEyePts = RIGHT_EYE.map(i => kp[i]);
            const earLeft = computeEAR(leftEyePts);
            const earRight = computeEAR(rightEyePts);

            // Head pose
            const { yaw, pitch } = estimateHeadPose(kp);

            // Calibration phase: learn baseline
            if (calibrating) {
              addCalibrationSample(yaw, pitch);
              // During calibration, assume active
              scoreWindow.push({ score: 1, ts: now });
            } else {
              // Score this frame
              const eyeScore = scoreEyes(earLeft, earRight, now);
              const headScore = scoreHead(yaw, pitch, now);
              const frameScore = (eyeScore * EYE_WEIGHT) + (headScore * HEAD_WEIGHT);

              scoreWindow.push({ score: frameScore, ts: now });
            }

            // Trim window
            const cutoff = now - (WINDOW_SIZE * DETECT_INTERVAL_MS);
            while (scoreWindow.length > 0 && scoreWindow[0].ts < cutoff) {
              scoreWindow.shift();
            }

            // Smoothed score
            currentScore = getSmoothedScore(now);
            currentStatus = scoreToStatus(currentScore);

            // Debug log every 5 seconds
            if (now - _lastDebug > 5000) {
              _lastDebug = now;
              const eyeS = scoreEyes(earLeft, earRight, now);
              const headS = calibrating ? 1 : scoreHead(yaw, pitch, now);
              console.log("[attention] eye:", eyeS.toFixed(2),
                "head:", headS.toFixed(2),
                "combined:", currentScore.toFixed(2),
                "→", currentStatus,
                calibrating ? "(calibrating)" : "");
            }

          } else {
            // No face detected → score 0
            scoreWindow.push({ score: 0, ts: now });
            const cutoff = now - (WINDOW_SIZE * DETECT_INTERVAL_MS);
            while (scoreWindow.length > 0 && scoreWindow[0].ts < cutoff) {
              scoreWindow.shift();
            }
            currentScore = getSmoothedScore(now);
            currentStatus = scoreToStatus(currentScore);
          }

          // Notify callback
          if (onStatusChange) onStatusChange(currentStatus, currentScore);

          // Emit to server at throttled rate
          if (socketRef && socketRef.connected && (now - lastEmitTime >= EMIT_INTERVAL_MS)) {
            lastEmitTime = now;
            socketRef.emit("attention:status", {
              status: currentStatus,
              score: Math.round(currentScore * 100) / 100, // 2 decimal places
            });
          }
        }
      } catch (err) {
        console.warn("[attention] detection error:", err.message);
      }
    }

    rafId = requestAnimationFrame(detectLoop);
  }

  /* ── Public API ────────────────────────────────────────────── */
  async function start(video, socket, statusCallback) {
    if (running) return;

    videoEl = video;
    socketRef = socket;
    onStatusChange = statusCallback || null;
    scoreWindow.length = 0;
    calibrationData = [];
    calibrating = true;
    baselineYaw = 0;
    baselinePitch = 0;
    eyesClosedSince = 0;
    headAwaySince = 0;
    lastGoodHeadScore = 1;
    currentScore = 0;
    currentStatus = "Unknown";
    lastDetectTime = 0;
    lastEmitTime = 0;
    _lastDebug = 0;

    // Dynamically load TF.js and face landmarks model
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

    const model = faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh;
    detector = await faceLandmarksDetection.createDetector(model, {
      runtime: "tfjs",
      refineLandmarks: true,
      maxFaces: 1,
    });

    running = true;
    rafId = requestAnimationFrame(detectLoop);
    console.log("[attention] started (12fps, calibrating first 3s...)");
  }

  function stop() {
    running = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (detector) { detector.dispose(); detector = null; }
    videoEl = null;
    socketRef = null;
    onStatusChange = null;
    scoreWindow.length = 0;
    calibrationData = [];
    currentScore = 0;
    currentStatus = "Unknown";
    console.log("[attention] stopped");
  }

  function isRunning() { return running; }
  function getStatus() { return currentStatus; }
  function getScore() { return currentScore; }

  /* ── Script loader ─────────────────────────────────────────── */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(s);
    });
  }

  /* ── Export ─────────────────────────────────────────────────── */
  window.AttentionDetection = { start, stop, isRunning, getStatus, getScore };
})();
