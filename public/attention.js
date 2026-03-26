/**
 * Attention Detection Module
 * Uses TensorFlow.js Face Landmarks Detection (MediaPipe FaceMesh)
 * to detect eye state, gaze direction, and head pose in real time.
 *
 * Privacy: All inference runs in-browser. Only the computed status string
 * is sent over the network — no video frames leave the client.
 */
(function () {
  "use strict";

  /* ── Constants ─────────────────────────────────────────────── */
  const ROLLING_WINDOW = 5;           // frames for smoothing (5 sec at 1 fps)
  const DETECT_INTERVAL_MS = 1000;    // 1 fps detection (every second)
  const EAR_THRESHOLD = 0.21;         // below = eyes closed
  const GAZE_THRESHOLD = 0.06;        // iris offset ratio to be "centered"
  const YAW_THRESHOLD = 25;           // degrees — beyond = turned away
  const PITCH_THRESHOLD = 20;         // degrees — beyond = looking up/down
  const EMIT_INTERVAL_MS = 1000;      // send status to server every 1s

  /* ── MediaPipe Face Landmark indices ───────────────────────── */
  // Left eye upper/lower lid landmarks (6 points for EAR)
  const LEFT_EYE = [362, 385, 387, 263, 373, 380];
  // Right eye upper/lower lid landmarks
  const RIGHT_EYE = [33, 160, 158, 133, 153, 144];
  // Left iris center
  const LEFT_IRIS = 468;
  // Right iris center
  const RIGHT_IRIS = 473;
  // Left eye corners (inner, outer)
  const LEFT_EYE_INNER = 362;
  const LEFT_EYE_OUTER = 263;
  // Right eye corners (inner, outer)
  const RIGHT_EYE_INNER = 133;
  const RIGHT_EYE_OUTER = 33;

  // Head pose reference points
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

  /** Rolling buffer of recent frame statuses */
  const statusBuffer = [];

  /** Current smoothed status */
  let currentStatus = "Unknown";

  /* ── Math helpers ──────────────────────────────────────────── */
  function dist(a, b) {
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Eye Aspect Ratio (EAR)
   * EAR = (|p2-p6| + |p3-p5|) / (2 * |p1-p4|)
   * where p1..p6 are the 6 eye landmarks in order.
   */
  function computeEAR(eyePoints) {
    const vertical1 = dist(eyePoints[1], eyePoints[5]);
    const vertical2 = dist(eyePoints[2], eyePoints[4]);
    const horizontal = dist(eyePoints[0], eyePoints[3]);
    if (horizontal < 1e-6) return 0;
    return (vertical1 + vertical2) / (2.0 * horizontal);
  }

  /**
   * Iris position ratio: how far the iris is from eye center
   * Returns value in [-1, 1] range. ~0 = centered, <0 = left, >0 = right
   */
  function irisRatio(irisPos, innerCorner, outerCorner) {
    const eyeWidth = dist(innerCorner, outerCorner);
    if (eyeWidth < 1e-6) return 0;
    const eyeCenterX = (innerCorner[0] + outerCorner[0]) / 2;
    return (irisPos[0] - eyeCenterX) / eyeWidth;
  }

  /**
   * Estimate head yaw and pitch from key facial landmarks.
   * Uses a simplified geometric approach without a full PnP solve.
   */
  function estimateHeadPose(kp) {
    const nose = kp[NOSE_TIP];
    const chin = kp[CHIN];
    const leftEye = kp[LEFT_EYE_CORNER];
    const rightEye = kp[RIGHT_EYE_CORNER];
    const leftMouth = kp[LEFT_MOUTH];
    const rightMouth = kp[RIGHT_MOUTH];

    if (!nose || !chin || !leftEye || !rightEye) {
      return { yaw: 0, pitch: 0 };
    }

    // Yaw: ratio of left-to-nose vs nose-to-right distances
    const leftDist = dist([nose[0], nose[1]], [leftEye[0], leftEye[1]]);
    const rightDist = dist([nose[0], nose[1]], [rightEye[0], rightEye[1]]);
    const totalDist = leftDist + rightDist;
    // When facing forward, ratio ~ 0.5. Deviation indicates yaw.
    const yawRatio = totalDist > 1e-6 ? (rightDist / totalDist) : 0.5;
    // Map to approximate degrees: 0.5 = 0 degrees, 0.3 = ~-40deg, 0.7 = ~40deg
    const yaw = (yawRatio - 0.5) * 100;

    // Pitch: vertical relationship between nose tip and eye midpoint
    const eyeMidY = (leftEye[1] + rightEye[1]) / 2;
    const faceHeight = dist([chin[0], chin[1]], [(leftEye[0] + rightEye[0]) / 2, eyeMidY]);
    const noseOffset = nose[1] - eyeMidY;
    const pitchRatio = faceHeight > 1e-6 ? (noseOffset / faceHeight) : 0.4;
    // Neutral pitch ratio ~ 0.35-0.45. Map deviation to degrees.
    const pitch = (pitchRatio - 0.4) * 120;

    return { yaw, pitch };
  }

  /**
   * Classify a single frame into a status.
   */
  function classifyFrame(earLeft, earRight, gazeOffset, yaw, pitch) {
    const avgEAR = (earLeft + earRight) / 2;
    const absGaze = Math.abs(gazeOffset);
    const absYaw = Math.abs(yaw);
    const absPitch = Math.abs(pitch);

    if (avgEAR < EAR_THRESHOLD) {
      return "Eyes Closed";
    }
    if (absYaw > YAW_THRESHOLD || absPitch > PITCH_THRESHOLD) {
      return "Distracted";
    }
    if (absGaze > GAZE_THRESHOLD) {
      return "Distracted";
    }
    return "Active";
  }

  /**
   * Apply rolling-window majority vote to smooth predictions.
   */
  function smoothStatus() {
    if (statusBuffer.length === 0) return "Unknown";

    const counts = {};
    for (const s of statusBuffer) {
      counts[s] = (counts[s] || 0) + 1;
    }

    // Priority: if many "Eyes Closed" frames, report that
    let best = "Active";
    let bestCount = 0;
    for (const [status, count] of Object.entries(counts)) {
      if (count > bestCount) {
        bestCount = count;
        best = status;
      }
    }
    return best;
  }

  /* ── Detection loop ────────────────────────────────────────── */
  async function detectLoop() {
    if (!running || !detector || !videoEl) return;

    const now = performance.now();

    if (now - lastDetectTime >= DETECT_INTERVAL_MS) {
      lastDetectTime = now;

      try {
        if (videoEl.readyState >= 2) {
          const faces = await detector.estimateFaces(videoEl, {
            flipHorizontal: false,
          });

          if (faces.length > 0) {
            const kp = faces[0].keypoints.map(p => [p.x, p.y, p.z || 0]);

            // Compute EAR for both eyes
            const leftEyePts = LEFT_EYE.map(i => kp[i]);
            const rightEyePts = RIGHT_EYE.map(i => kp[i]);
            const earLeft = computeEAR(leftEyePts);
            const earRight = computeEAR(rightEyePts);

            // Compute gaze direction from iris
            let gazeOffset = 0;
            if (kp.length > 473) {
              // Model has iris landmarks (478 keypoints)
              const leftIris = kp[LEFT_IRIS];
              const rightIris = kp[RIGHT_IRIS];
              const leftInner = kp[LEFT_EYE_INNER];
              const leftOuter = kp[LEFT_EYE_OUTER];
              const rightInner = kp[RIGHT_EYE_INNER];
              const rightOuter = kp[RIGHT_EYE_OUTER];

              const leftGaze = irisRatio(leftIris, leftInner, leftOuter);
              const rightGaze = irisRatio(rightIris, rightInner, rightOuter);
              gazeOffset = (leftGaze + rightGaze) / 2;
            }

            // Estimate head pose
            const { yaw, pitch } = estimateHeadPose(kp);

            // Classify this frame
            const frameStatus = classifyFrame(earLeft, earRight, gazeOffset, yaw, pitch);

            // Add to rolling buffer
            statusBuffer.push(frameStatus);
            while (statusBuffer.length > ROLLING_WINDOW) {
              statusBuffer.shift();
            }

            // Smooth
            currentStatus = smoothStatus();
          } else {
            // No face detected
            statusBuffer.push("Distracted");
            while (statusBuffer.length > ROLLING_WINDOW) {
              statusBuffer.shift();
            }
            currentStatus = smoothStatus();
          }

          // Notify local UI callback
          if (onStatusChange) {
            onStatusChange(currentStatus);
          }

          // Emit to server at throttled rate
          if (socketRef && socketRef.connected && (now - lastEmitTime >= EMIT_INTERVAL_MS)) {
            lastEmitTime = now;
            socketRef.emit("attention:status", { status: currentStatus });
          }
        }
      } catch (err) {
        // Silently continue — detection errors are non-fatal
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
    statusBuffer.length = 0;
    currentStatus = "Unknown";
    lastDetectTime = 0;
    lastEmitTime = 0;

    // Dynamically load TF.js and the face landmarks model
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

    // Create the detector with MediaPipe FaceMesh
    const model = faceLandmarksDetection.SupportedModels.MediaPipeFaceMesh;
    detector = await faceLandmarksDetection.createDetector(model, {
      runtime: "tfjs",
      refineLandmarks: true,   // enables iris landmarks (478 keypoints)
      maxFaces: 1,
    });

    running = true;
    rafId = requestAnimationFrame(detectLoop);
    console.log("[attention] started");
  }

  function stop() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (detector) {
      detector.dispose();
      detector = null;
    }
    videoEl = null;
    socketRef = null;
    onStatusChange = null;
    statusBuffer.length = 0;
    currentStatus = "Unknown";
    console.log("[attention] stopped");
  }

  function isRunning() {
    return running;
  }

  function getStatus() {
    return currentStatus;
  }

  /* ── Script loader helper ──────────────────────────────────── */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      // Don't load twice
      if (document.querySelector('script[src="' + src + '"]')) {
        return resolve();
      }
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Failed to load: " + src));
      document.head.appendChild(s);
    });
  }

  /* ── Export ─────────────────────────────────────────────────── */
  window.AttentionDetection = { start, stop, isRunning, getStatus };
})();
