// ============================================================
// Moov — Stretch Blocker (Vanilla JS)
//
// Drives the 4-step break flow that runs whenever the Tauri backend
// puts the window into "lock" mode (fullscreen + always-on-top):
//
//   1. THE INTERRUPTION — "Stand up and step back", 5s countdown (camera off)
//   2. THE PROMPT       — pick a stretch, "Get ready to do this", PiP fades in
//   3. THE CHALLENGE     — MoveNet checks the pose; a circular ring fills over
//                          10s of *valid* holding (pauses when the pose drops)
//   4. THE RELEASE       — green flash, "Great job, back to work!", stop the
//                          camera, tell Tauri to release the window.
//
// TensorFlow.js + MoveNet arrive as UMD globals (window.tf / window.poseDetection)
// from the CDN <script> tags in index.html. Tauri APIs come from the
// withGlobalTauri global (window.__TAURI__).
// ============================================================

const tf = window.tf;
const poseDetection = window.poseDetection;

// ============================================================
// DEV-ONLY DEBUG LOGGING
// Gated on Vite's dev build (`import.meta.env.DEV`), which lines up with the
// Rust backend's `debug_assertions` dev mode. Stripped from production builds.
// Flip on manually anytime with `localStorage.moovDebug = "1"`.
// ============================================================
const DEBUG = (() => {
  try {
    if (import.meta.env?.DEV) return true;
  } catch {
    /* import.meta not available (plain browser) */
  }
  try {
    return localStorage.getItem("moovDebug") === "1";
  } catch {
    return false;
  }
})();

const dlog = (...a) => {
  if (DEBUG) console.log("%c[moov]", "color:#64d2ff;font-weight:600", ...a);
};
const dwarn = (...a) => {
  if (DEBUG) console.warn("%c[moov]", "color:#ffd60a;font-weight:600", ...a);
};
const dtime = (label) => {
  if (DEBUG) console.time(`[moov] ${label}`);
};
const dtimeEnd = (label) => {
  if (DEBUG) console.timeEnd(`[moov] ${label}`);
};

// ---------- Tuning ----------
const INTERRUPTION_SECS = 5; // step 1 countdown
const GET_READY_MS = 2200; // "Get ready to do this." pause before step 3
const HOLD_MS = 10000; // required valid-hold time in step 3
const DETECT_INTERVAL_MS = 120; // pose sampling cadence
const KP_MIN_SCORE = 0.3; // keypoint confidence gate
const SUCCESS_HOLD_MS = 2200; // how long "Great job" stays before releasing

const RING_CIRCUMFERENCE = 2 * Math.PI * 100; // r=100 in the SVG

const STRETCHES = {
  overhead: {
    gif: "https://cdn.jefit.com/assets/img/exercises/gifs/793.gif",
    name: "Overhead Decompression",
    cue: "Reach both arms straight overhead",
    check: isOverheadPose,
  },
  lumbar: {
    gif: "https://media.post.rvohealth.io/wp-content/uploads/2020/11/Standing-extension.gif",
    name: "Lumbar Extension",
    cue: "Hands on your lower back, gently lean back",
    check: isLumbarPose,
  },
};

// ---------- State ----------
const state = {
  isLocked: false,
  stretch: null, // key into STRETCHES
  detector: null,
  detectorStatus: "idle", // idle | loading | ready | failed
  stream: null,
  interruptTimer: null,
  detectLoop: null,
  heldMs: 0,
  lastTick: 0,
  timerIntervalSecs: 1800,
  countdownRemaining: 1800,
  countdownInterval: null,
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
let el = {};

window.addEventListener("DOMContentLoaded", init);

async function init() {
  dlog("init: DOMContentLoaded", {
    debug: DEBUG,
    tf: !!tf,
    poseDetection: !!poseDetection,
    tauri: !!tauri(),
  });
  el = {
    idleScreen: $("idle-screen"),
    lockScreen: $("lock-screen"),
    countdownTimer: $("countdown-timer"),
    ringProgress: $("ring-progress"),
    btnTestLock: $("btn-test-lock"),

    greenFlash: $("green-flash"),
    interruptCount: $("interrupt-count"),
    promptTitle: $("prompt-title"),
    promptSub: $("prompt-sub"),
    chooser: $("stretch-chooser"),
    challengeTitle: $("challenge-title"),
    challengeGif: $("challenge-gif"),
    ringFill: $("progress-ring-fill"),
    holdRemaining: $("hold-remaining"),
    poseHint: $("pose-hint"),

    pip: $("pip"),
    webcam: $("webcam"),
    overlay: $("overlay"),
  };

  // Ring starts empty.
  el.ringFill.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  el.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE);

  // Ask the backend how long between breaks (falls back to 30 min).
  try {
    state.timerIntervalSecs = await invokeTauri("get_timer_interval");
    state.countdownRemaining = state.timerIntervalSecs;
    dlog("backend timer interval:", state.timerIntervalSecs, "secs");
  } catch (e) {
    dwarn("get_timer_interval failed — using default", state.timerIntervalSecs, e);
  }

  startIdleCountdown();

  // The Rust backend emits these when the break timer fires / is released.
  await listenTauri("screen-locked", () => {
    dlog("event: screen-locked (isLocked=%s)", state.isLocked);
    if (!state.isLocked) startFlow();
  });
  await listenTauri("screen-unlocked", () => {
    dlog("event: screen-unlocked (isLocked=%s)", state.isLocked);
    if (state.isLocked) resetToIdle();
  });

  // Manual trigger for testing.
  el.btnTestLock.addEventListener("click", async () => {
    dlog("test-lock clicked");
    try {
      await invokeTauri("lock_screen");
    } catch (e) {
      dwarn("lock_screen failed — running flow directly", e);
      startFlow(); // no backend — run the flow directly
    }
  });

  dlog("init complete");

  // Stretch selection (step 2).
  el.chooser.querySelectorAll(".stretch-card").forEach((card) => {
    card.addEventListener("click", () => chooseStretch(card.dataset.stretch, card));
  });
}

// ============================================================
// IDLE SCREEN — countdown to next break
// ============================================================
function startIdleCountdown() {
  state.countdownRemaining = state.timerIntervalSecs;
  renderCountdown();
  clearInterval(state.countdownInterval);
  state.countdownInterval = setInterval(() => {
    if (state.isLocked) return;
    state.countdownRemaining = Math.max(0, state.countdownRemaining - 1);
    renderCountdown();
  }, 1000);
}

function renderCountdown() {
  const m = Math.floor(state.countdownRemaining / 60);
  const s = state.countdownRemaining % 60;
  el.countdownTimer.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const circ = 2 * Math.PI * 90; // r=90
  const frac = state.timerIntervalSecs ? state.countdownRemaining / state.timerIntervalSecs : 0;
  el.ringProgress.style.strokeDashoffset = String(circ * (1 - frac));
}

// ============================================================
// FLOW ORCHESTRATION
// ============================================================
function showPhase(name) {
  dlog("→ phase:", name);
  el.lockScreen
    .querySelectorAll(".phase")
    .forEach((p) => p.classList.toggle("active", p.dataset.phase === name));
}

function startFlow() {
  dlog("startFlow");
  state.isLocked = true;
  state.stretch = null;
  state.heldMs = 0;

  // Reset visuals.
  el.idleScreen.classList.remove("active");
  el.lockScreen.classList.add("active");
  el.pip.classList.remove("visible");
  el.greenFlash.classList.remove("flash");
  el.chooser.querySelectorAll(".stretch-card").forEach((c) => c.classList.remove("selected"));
  el.promptTitle.textContent = "Pick your stretch";
  el.promptSub.textContent = "Choose one to get started";
  el.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
  el.holdRemaining.textContent = String(HOLD_MS / 1000);

  // Warm up the pose model in the background so step 3 is snappy.
  loadDetector();

  stepInterruption();
}

// ---------- STEP 1 — THE INTERRUPTION ----------
function stepInterruption() {
  showPhase("interruption");
  let remaining = INTERRUPTION_SECS;
  el.interruptCount.textContent = String(remaining);

  clearInterval(state.interruptTimer);
  state.interruptTimer = setInterval(() => {
    remaining -= 1;
    el.interruptCount.textContent = String(Math.max(0, remaining));
    if (remaining <= 0) {
      clearInterval(state.interruptTimer);
      stepPrompt();
    }
  }, 1000);
}

// ---------- STEP 2 — THE PROMPT ----------
async function stepPrompt() {
  showPhase("prompt");
  // Fade the webcam in as picture-in-picture so the user can frame themselves.
  await startWebcam();
  el.pip.classList.add("visible");
  dlog("prompt shown, awaiting stretch choice");
}

function chooseStretch(key, card) {
  if (!STRETCHES[key] || state.stretch) {
    dwarn("chooseStretch ignored", { key, alreadyChosen: state.stretch });
    return; // ignore double clicks
  }
  state.stretch = key;
  dlog("stretch chosen:", key);
  card.classList.add("selected");

  const s = STRETCHES[key];
  el.challengeGif.src = s.gif;
  el.promptTitle.textContent = "Get ready to do this.";
  el.promptSub.textContent = s.name;

  setTimeout(stepChallenge, GET_READY_MS);
}

// ---------- STEP 3 — THE CHALLENGE ----------
function stepChallenge() {
  showPhase("challenge");
  const s = STRETCHES[state.stretch];
  el.challengeTitle.textContent = "Hold this position for 10 seconds";
  el.challengeGif.src = s.gif;

  state.heldMs = 0;
  state.lastTick = now();
  updateRing(0);

  dlog("stepChallenge", { stretch: state.stretch, detectorStatus: state.detectorStatus });

  if (state.detectorStatus === "failed") {
    // No model — don't trap the user. Fall back to a plain timed hold.
    dwarn("detector failed → timed fallback");
    setHint(`${s.cue} (pose check unavailable — just hold)`, "warn");
    startTimedFallback();
    return;
  }

  setHint(state.detectorStatus === "ready" ? s.cue : "Warming up the pose detector…");
  state.tickCount = 0;
  clearInterval(state.detectLoop);
  state.detectLoop = setInterval(detectTick, DETECT_INTERVAL_MS);
}

async function detectTick() {
  if (!state.isLocked) return;

  const t = now();
  const dt = t - state.lastTick;
  state.lastTick = t;
  state.tickCount = (state.tickCount || 0) + 1;

  if (state.detectorStatus === "loading") {
    setHint("Warming up the pose detector…");
    return;
  }
  if (state.detectorStatus === "failed") {
    clearInterval(state.detectLoop);
    startTimedFallback();
    return;
  }

  const keypoints = await estimatePose();
  const s = STRETCHES[state.stretch];
  const valid = keypoints ? s.check(keypoints) : false;
  if (keypoints) drawSkeleton(keypoints);

  if (valid) {
    // Accumulate valid-hold time (cap dt so a stalled frame can't jump the bar).
    state.heldMs = Math.min(HOLD_MS, state.heldMs + Math.min(dt, DETECT_INTERVAL_MS * 3));
    setHint("Holding it — nice! Keep going ✓", "ok");
  } else {
    // Dropped the pose: pause the ring and decay slightly so it must be re-earned.
    state.heldMs = Math.max(0, state.heldMs - dt * 0.5);
    setHint(s.cue, "warn");
  }

  // Per-tick trace — the workhorse for troubleshooting pose detection.
  if (DEBUG) {
    dlog(
      `tick#${state.tickCount} valid=${valid} held=${Math.round(state.heldMs)}/${HOLD_MS}ms dt=${Math.round(dt)}`,
      keypoints ? summarizeKeypoints(keypoints) : "no keypoints"
    );
  }

  updateRing(state.heldMs / HOLD_MS);

  if (state.heldMs >= HOLD_MS) {
    dlog("hold complete → release");
    clearInterval(state.detectLoop);
    stepRelease();
  }
}

// Compact keypoint snapshot for debug logs (which joints were confident + y's).
function summarizeKeypoints(kp) {
  const names = Object.keys(kp);
  const round = (p) => (p ? { x: Math.round(p.x), y: Math.round(p.y), s: +(p.score ?? 0).toFixed(2) } : null);
  return {
    seen: names,
    left_wrist: round(kp.left_wrist),
    right_wrist: round(kp.right_wrist),
    eyes_y: avgY(kp.left_eye, kp.right_eye, kp.nose),
    shoulders_y: avgY(kp.left_shoulder, kp.right_shoulder),
    hips_y: avgY(kp.left_hip, kp.right_hip),
    torsoScale: Math.round(torsoScale(kp)),
  };
}

// Timed fallback when the detector can't load — still requires 10s.
function startTimedFallback() {
  dlog("startTimedFallback (no pose check)");
  state.lastTick = now();
  clearInterval(state.detectLoop);
  state.detectLoop = setInterval(() => {
    const t = now();
    state.heldMs = Math.min(HOLD_MS, state.heldMs + (t - state.lastTick));
    state.lastTick = t;
    updateRing(state.heldMs / HOLD_MS);
    if (state.heldMs >= HOLD_MS) {
      clearInterval(state.detectLoop);
      stepRelease();
    }
  }, 150);
}

function updateRing(frac) {
  const clamped = Math.max(0, Math.min(1, frac));
  el.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
  el.holdRemaining.textContent = String(Math.ceil((HOLD_MS - state.heldMs) / 1000));
}

function setHint(text, tone) {
  el.poseHint.textContent = text;
  el.poseHint.classList.toggle("ok", tone === "ok");
  el.poseHint.classList.toggle("warn", tone === "warn");
}

// ---------- STEP 4 — THE RELEASE ----------
async function stepRelease() {
  dlog("stepRelease");
  showPhase("release");
  el.greenFlash.classList.add("flash");
  el.pip.classList.remove("visible");

  stopWebcam(); // stop the camera tracks
  await sleep(SUCCESS_HOLD_MS);

  // Tell Tauri to release the window (exits fullscreen / always-on-top and
  // emits screen-unlocked, which routes back to resetToIdle). Fall back to
  // hiding the window directly, then to a local reset.
  try {
    await invokeTauri("unlock_screen");
    dlog("unlock_screen ok");
  } catch (e) {
    dwarn("unlock_screen failed — trying hideWindow()", e);
    try {
      await hideWindow();
      dlog("hideWindow ok");
    } catch (e2) {
      dwarn("hideWindow failed too", e2);
    }
    resetToIdle();
  }
}

function resetToIdle() {
  dlog("resetToIdle");
  state.isLocked = false;
  clearInterval(state.interruptTimer);
  clearInterval(state.detectLoop);
  stopWebcam();
  el.pip.classList.remove("visible");
  el.lockScreen.classList.remove("active");
  el.idleScreen.classList.add("active");
  startIdleCountdown();
}

// ============================================================
// WEBCAM
// ============================================================
async function startWebcam() {
  if (state.stream) {
    dlog("startWebcam: already running");
    return;
  }
  try {
    dlog("startWebcam: requesting getUserMedia…");
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
      audio: false,
    });
    el.webcam.srcObject = state.stream;
    await el.webcam.play();
    el.webcam.addEventListener(
      "loadedmetadata",
      () => {
        el.overlay.width = el.webcam.videoWidth;
        el.overlay.height = el.webcam.videoHeight;
        dlog("webcam ready", { w: el.webcam.videoWidth, h: el.webcam.videoHeight });
      },
      { once: true }
    );
    dlog("startWebcam: stream acquired", state.stream.getVideoTracks().map((t) => t.label));
  } catch (err) {
    console.error("Webcam access failed:", err);
    dwarn("startWebcam failed", err);
    setHint("Camera unavailable — we'll just time your hold.", "warn");
  }
}

function stopWebcam() {
  if (state.stream) {
    dlog("stopWebcam: stopping tracks");
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  el.webcam.srcObject = null;
  const ctx = el.overlay.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
}

// ============================================================
// POSE DETECTION (MoveNet)
// ============================================================
async function loadDetector() {
  if (state.detector || state.detectorStatus === "loading") {
    dlog("loadDetector: skip", state.detectorStatus);
    return;
  }
  state.detectorStatus = "loading";
  dtime("loadDetector");
  try {
    // WebGL first (fast); fall back to CPU (WebGL often fails in WKWebView).
    let ok = false;
    for (const backend of ["webgl", "cpu"]) {
      try {
        await tf.setBackend(backend);
        await tf.ready();
        ok = true;
        dlog("tfjs backend active:", tf.getBackend());
        break;
      } catch (e) {
        dwarn(`tfjs backend "${backend}" failed`, e);
      }
    }
    if (!ok) throw new Error("no tfjs backend");

    state.detector = await poseDetection.createDetector(
      poseDetection.SupportedModels.MoveNet,
      { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING }
    );
    state.detectorStatus = "ready";
    dlog("✅ MoveNet ready");
  } catch (err) {
    console.error("❌ MoveNet failed to load:", err);
    dwarn("loadDetector failed", err);
    state.detectorStatus = "failed";
  } finally {
    dtimeEnd("loadDetector");
  }
}

// Returns a name->keypoint map (only keypoints above the score gate), or null.
async function estimatePose() {
  if (!state.detector || !state.stream) return null;
  if (el.webcam.readyState < 2 || el.webcam.videoWidth === 0) return null;
  try {
    const result = await state.detector.estimatePoses(el.webcam, { flipHorizontal: false });
    if (!result || result.length === 0) return null;
    const map = {};
    for (const kp of result[0].keypoints) {
      if ((kp.score ?? 0) >= KP_MIN_SCORE) map[kp.name] = kp;
    }
    return map;
  } catch (err) {
    dwarn("estimatePoses error", err);
    return null;
  }
}

// ---------- Pose heuristics ----------
// NOTE: image coordinates put y=0 at the TOP, so "higher" means a SMALLER y.

function avgY(...pts) {
  const ys = pts.filter(Boolean).map((p) => p.y);
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
}

// Rough torso length (shoulder→hip) used to scale "significant" margins so the
// checks work regardless of how close the user stands to the camera.
function torsoScale(kp) {
  const sY = avgY(kp.left_shoulder, kp.right_shoulder);
  const hY = avgY(kp.left_hip, kp.right_hip);
  if (sY != null && hY != null) return Math.abs(hY - sY) || 120;
  return 120; // sensible pixel fallback
}

// OVERHEAD DECOMPRESSION: both wrists significantly higher than the eyes
// (and, as a backstop, above the shoulders).
function isOverheadPose(kp) {
  const lw = kp.left_wrist;
  const rw = kp.right_wrist;
  if (!lw || !rw) return false;

  const eyeY = avgY(kp.left_eye, kp.right_eye, kp.nose);
  const shoulderY = avgY(kp.left_shoulder, kp.right_shoulder);
  const ref = eyeY ?? shoulderY;
  if (ref == null) return false;

  const margin = torsoScale(kp) * 0.2; // "significantly" higher
  const aboveEyes = lw.y < ref - margin && rw.y < ref - margin;
  const aboveShoulders =
    shoulderY == null || (lw.y < shoulderY && rw.y < shoulderY);
  return aboveEyes && aboveShoulders;
}

// LUMBAR EXTENSION (standing back extension): hands rest on the lower back, so
// both wrists sit roughly at hip height and clearly below the shoulders.
// A proxy heuristic — tune the band to taste.
function isLumbarPose(kp) {
  const lw = kp.left_wrist;
  const rw = kp.right_wrist;
  const hipY = avgY(kp.left_hip, kp.right_hip);
  const shoulderY = avgY(kp.left_shoulder, kp.right_shoulder);
  if (!lw || !rw || hipY == null || shoulderY == null) return false;

  const band = torsoScale(kp) * 0.45; // vertical tolerance around the hips
  const nearHips =
    Math.abs(lw.y - hipY) < band && Math.abs(rw.y - hipY) < band;
  const belowShoulders = lw.y > shoulderY && rw.y > shoulderY;
  return nearHips && belowShoulders;
}

// ---------- Skeleton overlay ----------
// A few limb connections drawn by keypoint name (MoveNet naming).
const SKELETON_BONES = [
  ["left_shoulder", "right_shoulder"],
  ["left_shoulder", "left_elbow"],
  ["left_elbow", "left_wrist"],
  ["right_shoulder", "right_elbow"],
  ["right_elbow", "right_wrist"],
  ["left_shoulder", "left_hip"],
  ["right_shoulder", "right_hip"],
  ["left_hip", "right_hip"],
];

function drawSkeleton(kp) {
  const ctx = el.overlay.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);

  ctx.strokeStyle = "rgba(100, 210, 255, 0.8)";
  ctx.lineWidth = 3;
  for (const [a, b] of SKELETON_BONES) {
    const pa = kp[a];
    const pb = kp[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  ctx.fillStyle = "#64d2ff";
  for (const name in kp) {
    const p = kp[name];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ============================================================
// TAURI BRIDGE (via withGlobalTauri) + helpers
// ============================================================
function tauri() {
  return typeof window !== "undefined" ? window.__TAURI__ : undefined;
}

async function invokeTauri(cmd, args) {
  const t = tauri();
  if (!t?.core?.invoke) throw new Error("Tauri unavailable");
  return t.core.invoke(cmd, args);
}

async function listenTauri(event, handler) {
  const t = tauri();
  if (!t?.event?.listen) return; // no-op in a plain browser
  return t.event.listen(event, handler);
}

async function hideWindow() {
  const t = tauri();
  if (t?.window?.getCurrentWindow) {
    return t.window.getCurrentWindow().hide();
  }
  throw new Error("window API unavailable");
}

function now() {
  return performance.now();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
