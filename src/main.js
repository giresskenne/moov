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

// ---------- Onboarding ----------
const CAL_HOLD_MS = 3000; // valid-pose hold to pass the live calibration
const CAL_RING_CIRC = 2 * Math.PI * 54; // r=54 in the calibration SVG
const OB_STEPS = ["welcome", "how", "camera", "stretch", "calibrate", "done"];
const LS_ONBOARDED = "moov.onboarded";
const LS_DEFAULT_STRETCH = "moov.defaultStretch";

// Each stretch is scored one of two ways:
//   mode:"hold" — hold a valid static pose for `holdMs` (e.g. arms overhead).
//   mode:"reps" — perform a real repeated MOVEMENT; we count reps from the
//                 rise/fall of a body signal. A static pose earns nothing —
//                 you have to actually do the motion that relieves the back.
const STRETCHES = {
  overhead: {
    gif: "https://cdn.jefit.com/assets/img/exercises/gifs/793.gif",
    name: "Overhead Decompression",
    title: "Reach up and hold for 10 seconds",
    cue: "Reach both arms straight overhead",
    mode: "hold",
    check: isOverheadPose,
  },
  lumbar: {
    gif: "https://media.post.rvohealth.io/wp-content/uploads/2020/11/Standing-extension.gif",
    name: "Lumbar Extension",
    title: "Do 5 slow back extensions",
    cue: "Hands on your lower back — gently lean back, then return",
    mode: "reps",
    repTarget: 5,
    gate: lumbarGate, // torso must be in frame
    signal: lumbarSignal, // vertical torso position we watch oscillate
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
  evaluator: null, // active StretchEvaluator during the challenge
  lastTick: 0,
  timerIntervalSecs: 1800,
  countdownRemaining: 1800,
  countdownInterval: null,

  // onboarding
  onboarding: false,
  obStep: 0,
  obDefault: "overhead", // preferred stretch chosen during onboarding
  obCameraOk: false,
  obCalLoop: null,
  obEval: null, // active StretchEvaluator during onboarding calibration
  obLastTick: 0,
  obDone: false,
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
    ringUnit: $("ring-unit"),
    poseHint: $("pose-hint"),

    webcam: $("webcam"),
    overlay: $("overlay"),

    // onboarding
    onboarding: $("onboarding-screen"),
    obDots: $("ob-dots"),
    obCamPreview: $("ob-cam-preview"),
    obCamState: $("ob-cam-state"),
    obBtnEnableCam: $("ob-enable-cam"),
    obCamStep: $("ob-step-camera"),
    obStretchCards: $("ob-stretch-cards"),
    obCalVideo: $("ob-cal-video"),
    obCalOverlay: $("ob-cal-overlay"),
    obCalRing: $("ob-cal-ring-fill"),
    obCalHint: $("ob-cal-hint"),
    obCalStretchName: $("ob-cal-stretch-name"),
    obConfetti: $("ob-confetti"),
    btnReplayOnboarding: $("btn-replay-onboarding"),
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
    dlog("event: screen-locked (isLocked=%s, onboarding=%s)", state.isLocked, state.onboarding);
    // Don't hijack the first-run onboarding — push the break out and keep going.
    if (state.onboarding) {
      invokeTauri("snooze_break", { secs: 120 }).catch(() => {});
      return;
    }
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

  // Stretch selection (break-flow step 2).
  el.chooser.querySelectorAll(".stretch-card").forEach((card) => {
    card.addEventListener("click", () => chooseStretch(card.dataset.stretch, card));
  });

  // Remember the user's preferred stretch across sessions.
  try {
    const saved = localStorage.getItem(LS_DEFAULT_STRETCH);
    if (saved && STRETCHES[saved]) state.obDefault = saved;
  } catch {
    /* ignore */
  }

  wireOnboarding();

  // First run? Roll out the red carpet. Otherwise land on the idle screen.
  if (shouldOnboard()) {
    startOnboarding();
  }

  dlog("init complete", { willOnboard: shouldOnboard() });
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
  state.evaluator = null;

  // Reset visuals.
  el.idleScreen.classList.remove("active");
  el.lockScreen.classList.add("active");
  el.greenFlash.classList.remove("flash");
  el.chooser.querySelectorAll(".stretch-card").forEach((c) => {
    c.classList.remove("selected");
    // Badge the user's onboarding pick as their go-to.
    c.classList.toggle("is-default", c.dataset.stretch === state.obDefault);
  });
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
  // Warm the camera now so it's live the instant the challenge (with its
  // inline camera view) appears.
  await startWebcam();
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
  el.challengeTitle.textContent = s.title;
  el.challengeGif.src = s.gif;

  state.evaluator = makeEvaluator(state.stretch);
  state.lastTick = now();
  state.tickCount = 0;
  applyChallengeUI(state.evaluator.snapshot());

  dlog("stepChallenge", {
    stretch: state.stretch,
    mode: s.mode,
    detectorStatus: state.detectorStatus,
  });

  if (state.detectorStatus === "failed") {
    // No model — don't trap the user. Fall back to a plain timed hold.
    dwarn("detector failed → timed fallback");
    startTimedFallback();
    return;
  }

  setHint(state.detectorStatus === "ready" ? s.cue : "Warming up the pose detector…");
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

  const kp = await estimatePose();
  const r = state.evaluator.update(kp, dt);
  if (kp) drawSkeleton(kp, r.valid ? "#30d158" : "#64d2ff");
  applyChallengeUI(r);

  // Per-tick trace — now includes the MOVEMENT signal the score is based on.
  if (DEBUG) {
    dlog(
      `tick#${state.tickCount} valid=${r.valid} progress=${(r.progress * 100).toFixed(0)}% dt=${Math.round(dt)}`,
      { ...r.debug, kp: kp ? summarizeKeypoints(kp) : "no keypoints" }
    );
  }

  if (r.done) {
    dlog("challenge complete → release", r.debug);
    clearInterval(state.detectLoop);
    stepRelease();
  }
}

// Compact keypoint snapshot for debug logs (which joints were confident + y's).
function summarizeKeypoints(kp) {
  const round = (p) => (p ? { x: Math.round(p.x), y: Math.round(p.y), s: +(p.score ?? 0).toFixed(2) } : null);
  return {
    seen: Object.keys(kp),
    left_wrist: round(kp.left_wrist),
    right_wrist: round(kp.right_wrist),
    eyes_y: Math.round(avgY(kp.left_eye, kp.right_eye, kp.nose) ?? -1),
    shoulders_y: Math.round(avgY(kp.left_shoulder, kp.right_shoulder) ?? -1),
    hips_y: Math.round(avgY(kp.left_hip, kp.right_hip) ?? -1),
    torsoScale: Math.round(torsoScale(kp)),
  };
}

// Timed fallback when the detector can't load — still requires 10s of standing.
function startTimedFallback() {
  dlog("startTimedFallback (no pose check)");
  let held = 0;
  state.lastTick = now();
  setHint("Pose check unavailable — take your stretch, unlocking on the timer.", "warn");
  clearInterval(state.detectLoop);
  state.detectLoop = setInterval(() => {
    const t = now();
    held = Math.min(HOLD_MS, held + (t - state.lastTick));
    state.lastTick = t;
    applyChallengeUI({
      progress: held / HOLD_MS,
      big: String(Math.ceil((HOLD_MS - held) / 1000)),
      unit: "seconds",
    });
    if (held >= HOLD_MS) {
      clearInterval(state.detectLoop);
      stepRelease();
    }
  }, 150);
}

// Paint the ring + numbers + hint from an evaluator result.
function applyChallengeUI(r) {
  const clamped = Math.max(0, Math.min(1, r.progress));
  el.ringFill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped));
  if (r.big != null) el.holdRemaining.textContent = r.big;
  if (r.unit != null) el.ringUnit.textContent = r.unit;
  if (r.hint != null) setHint(r.hint, r.tone);
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
  el.lockScreen.classList.remove("active");
  el.idleScreen.classList.add("active");
  startIdleCountdown();
}

// ============================================================
// WEBCAM
// ============================================================
// One shared MediaStream can feed multiple <video> elements (the break-flow
// PiP and the onboarding calibration view), so acquisition is factored out.
async function acquireCamera() {
  if (state.stream) return state.stream;
  dlog("acquireCamera: requesting getUserMedia…");
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
    audio: false,
  });
  dlog("acquireCamera: stream acquired", state.stream.getVideoTracks().map((t) => t.label));
  return state.stream;
}

// Attach the shared stream to a <video>, sizing its companion <canvas> (if any)
// to the true frame dimensions so keypoint overlays line up.
async function attachStream(video, canvas) {
  video.srcObject = state.stream;
  await video.play().catch(() => {});
  const size = () => {
    if (canvas) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    dlog("video ready", { id: video.id, w: video.videoWidth, h: video.videoHeight });
  };
  if (video.readyState >= 1 && video.videoWidth) size();
  else video.addEventListener("loadedmetadata", size, { once: true });
}

async function startWebcam() {
  if (state.stream) {
    dlog("startWebcam: already running");
    await attachStream(el.webcam, el.overlay);
    return;
  }
  try {
    await acquireCamera();
    await attachStream(el.webcam, el.overlay);
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
  clearCanvas(el.overlay);
}

function clearCanvas(canvas) {
  const ctx = canvas?.getContext("2d");
  if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
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
async function estimatePoseFrom(video) {
  if (!state.detector || !state.stream) return null;
  if (video.readyState < 2 || video.videoWidth === 0) return null;
  try {
    const result = await state.detector.estimatePoses(video, { flipHorizontal: false });
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

const estimatePose = () => estimatePoseFrom(el.webcam);

// ---------- Pose heuristics ----------
// NOTE: image coordinates put y=0 at the TOP, so "higher" means a SMALLER y.

function avgY(...pts) {
  const ys = pts.filter(Boolean).map((p) => p.y);
  return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
}

// Every keypoint the check needs must be confidently present, otherwise we
// bail (a face-only detection while seated must NOT count as a valid stretch).
function have(kp, ...names) {
  return names.every((n) => kp[n]);
}

// Rough torso length (shoulder→hip) used to scale "significant" margins so the
// checks work regardless of how close the user stands to the camera.
function torsoScale(kp) {
  const sY = avgY(kp.left_shoulder, kp.right_shoulder);
  const hY = avgY(kp.left_hip, kp.right_hip);
  if (sY != null && hY != null) return Math.abs(hY - sY) || 120;
  return 120; // sensible pixel fallback
}

// OVERHEAD DECOMPRESSION: arms genuinely reaching up — both WRISTS above the
// eyes AND both ELBOWS above the shoulders. Requiring the elbows to clear the
// shoulders rejects "hands resting near the face", which wrists-above-eyes
// alone would accept.
function isOverheadPose(kp) {
  if (!have(kp, "left_wrist", "right_wrist", "left_elbow", "right_elbow", "left_shoulder", "right_shoulder"))
    return false;

  const ref = avgY(kp.left_eye, kp.right_eye, kp.nose) ?? avgY(kp.left_shoulder, kp.right_shoulder);
  if (ref == null) return false;

  const margin = torsoScale(kp) * 0.2; // "significantly" higher than the eyes
  const wristsUp = kp.left_wrist.y < ref - margin && kp.right_wrist.y < ref - margin;
  const elbowsUp =
    kp.left_elbow.y < kp.left_shoulder.y && kp.right_elbow.y < kp.right_shoulder.y;
  return wristsUp && elbowsUp;
}

// LUMBAR EXTENSION is scored as MOVEMENT, not a static pose — a held position
// isn't the therapy, the repeated extension is. We require the torso to be in
// frame (so the user is standing back) and then count reps from the vertical
// oscillation of the torso as they lean back and return.
function lumbarGate(kp) {
  return have(kp, "left_shoulder", "right_shoulder", "left_hip", "right_hip");
}

// Vertical position of the torso "core". As you lean back and straighten up,
// this rises and falls; those swings are the reps we count.
function lumbarSignal(kp) {
  const sY = avgY(kp.left_shoulder, kp.right_shoulder);
  const hY = avgY(kp.left_hip, kp.right_hip);
  if (sY == null || hY == null) return null;
  return (sY + hY) / 2;
}

// ============================================================
// STRETCH EVALUATORS — turn each tick's keypoints into progress
// ============================================================
function makeEvaluator(key, opts = {}) {
  const s = STRETCHES[key];
  if (s.mode === "reps") return new RepEvaluator(s, opts.reps ?? s.repTarget);
  return new HoldEvaluator(s, opts.holdMs ?? HOLD_MS);
}

// HOLD: accumulate time while a valid static pose is held; decays if dropped.
class HoldEvaluator {
  constructor(s, holdMs) {
    this.s = s;
    this.holdMs = holdMs;
    this.held = 0;
  }
  result(valid) {
    const progress = this.held / this.holdMs;
    return {
      valid,
      progress,
      done: this.held >= this.holdMs,
      big: String(Math.max(0, Math.ceil((this.holdMs - this.held) / 1000))),
      unit: "seconds",
      hint: valid ? "Holding it — nice! Keep going ✓" : this.s.cue,
      tone: valid ? "ok" : "warn",
      debug: { mode: "hold", heldMs: Math.round(this.held) },
    };
  }
  snapshot() {
    return this.result(false);
  }
  update(kp, dt) {
    const valid = kp ? this.s.check(kp) : false;
    if (valid) this.held = Math.min(this.holdMs, this.held + Math.min(dt, DETECT_INTERVAL_MS * 3));
    else this.held = Math.max(0, this.held - dt * 0.5);
    return this.result(valid);
  }
}

// REPS: count real repetitions via a zig-zag reversal detector on a body
// signal. Each direction reversal that clears a minimum amplitude (scaled to
// the user's torso, so it ignores jitter) is one rep. Reps don't decay — the
// work is banked once it's done.
class RepEvaluator {
  constructor(s, target) {
    this.s = s;
    this.target = target;
    this.reps = 0;
    this.ema = null;
    this.maxV = null;
    this.minV = null;
    this.dir = null; // "up" | "down"
    this.minAmp = 24;
    this.justRepped = false;
  }
  result(gated) {
    const progress = Math.min(1, this.reps / this.target);
    let hint, tone;
    if (!gated) {
      hint = "Step back so I can see your whole torso";
      tone = "warn";
    } else if (this.justRepped) {
      hint = `Good rep! ${this.reps}/${this.target}`;
      tone = "ok";
    } else {
      hint = this.s.cue;
      tone = this.reps > 0 ? "ok" : "warn";
    }
    return {
      valid: gated,
      progress,
      done: this.reps >= this.target,
      big: String(this.reps),
      unit: `of ${this.target} reps`,
      hint,
      tone,
      debug: {
        mode: "reps",
        reps: this.reps,
        signal: this.ema == null ? null : Math.round(this.ema),
        minAmp: Math.round(this.minAmp),
        dir: this.dir,
      },
    };
  }
  snapshot() {
    return this.result(false);
  }
  update(kp, _dt) {
    this.justRepped = false;
    const gated = kp ? this.s.gate(kp) : false;
    if (gated) {
      const raw = this.s.signal(kp);
      if (raw != null) {
        this.minAmp = Math.max(18, torsoScale(kp) * 0.15);
        this.ema = this.ema == null ? raw : this.ema * 0.6 + raw * 0.4;
        this.justRepped = this._zigzag(this.ema);
      }
    }
    return this.result(gated);
  }
  // Count a rep on each direction reversal whose swing exceeds minAmp.
  _zigzag(v) {
    if (this.maxV == null) {
      this.maxV = this.minV = v;
      return false;
    }
    this.maxV = Math.max(this.maxV, v);
    this.minV = Math.min(this.minV, v);

    if (this.dir == null) {
      if (v <= this.maxV - this.minAmp) {
        this.dir = "down";
        this.minV = v;
        this.reps += 1;
        return true;
      }
      if (v >= this.minV + this.minAmp) {
        this.dir = "up";
        this.maxV = v;
        this.reps += 1;
        return true;
      }
    } else if (this.dir === "down" && v >= this.minV + this.minAmp) {
      this.dir = "up";
      this.maxV = v;
      this.reps += 1;
      return true;
    } else if (this.dir === "up" && v <= this.maxV - this.minAmp) {
      this.dir = "down";
      this.minV = v;
      this.reps += 1;
      return true;
    }
    return false;
  }
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

function drawSkeletonOn(canvas, kp, color = "#64d2ff") {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (const [a, b] of SKELETON_BONES) {
    const pa = kp[a];
    const pb = kp[b];
    if (!pa || !pb) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  for (const name in kp) {
    const p = kp[name];
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

const drawSkeleton = (kp) => drawSkeletonOn(el.overlay, kp);

// ============================================================
// ONBOARDING — the coolest first run ever
//
//   welcome → how it works → camera access → pick your go-to stretch →
//   LIVE calibration (raise your arms, watch the skeleton + ring) → confetti.
//
// The calibration step is the wow moment: it proves the on-device pose
// detection actually works on *you* before your first real break.
// ============================================================
function shouldOnboard() {
  try {
    return localStorage.getItem(LS_ONBOARDED) !== "1";
  } catch {
    return true;
  }
}

function wireOnboarding() {
  if (!el.onboarding) return;

  // Build the progress dots.
  el.obDots.innerHTML = "";
  OB_STEPS.forEach((_, i) => {
    const dot = document.createElement("span");
    dot.className = "ob-dot";
    dot.dataset.index = String(i);
    el.obDots.appendChild(dot);
  });

  // Next / back / skip buttons (data-driven).
  el.onboarding.querySelectorAll("[data-ob-next]").forEach((b) =>
    b.addEventListener("click", () => obGoto(state.obStep + 1))
  );
  el.onboarding.querySelectorAll("[data-ob-back]").forEach((b) =>
    b.addEventListener("click", () => obGoto(state.obStep - 1))
  );
  el.onboarding.querySelectorAll("[data-ob-skip]").forEach((b) =>
    b.addEventListener("click", finishOnboarding)
  );

  // Camera permission.
  el.obBtnEnableCam.addEventListener("click", obEnableCamera);

  // Choose default stretch.
  el.obStretchCards.querySelectorAll(".stretch-card").forEach((card) => {
    card.addEventListener("click", () => obChooseDefault(card.dataset.stretch));
  });

  // Replay from the idle screen.
  if (el.btnReplayOnboarding) {
    el.btnReplayOnboarding.addEventListener("click", () => {
      try {
        localStorage.removeItem(LS_ONBOARDED);
      } catch {
        /* ignore */
      }
      startOnboarding();
    });
  }
}

function startOnboarding() {
  dlog("startOnboarding");
  state.onboarding = true;
  state.obDone = false;
  el.idleScreen.classList.remove("active");
  el.lockScreen.classList.remove("active");
  el.onboarding.classList.add("active");
  // Warm up MoveNet in the background so calibration is instant.
  loadDetector();
  obGoto(0);
}

function obGoto(index) {
  const clamped = Math.max(0, Math.min(OB_STEPS.length - 1, index));

  // Leaving the calibration step: stop the loop + camera preview.
  if (OB_STEPS[state.obStep] === "calibrate" && OB_STEPS[clamped] !== "calibrate") {
    stopCalibration();
  }

  state.obStep = clamped;
  const name = OB_STEPS[clamped];
  dlog("ob step →", name);

  el.onboarding
    .querySelectorAll(".ob-step")
    .forEach((s) => s.classList.toggle("active", s.dataset.step === name));

  // Progress dots.
  el.obDots.querySelectorAll(".ob-dot").forEach((d, i) => {
    d.classList.toggle("done", i < clamped);
    d.classList.toggle("current", i === clamped);
  });

  // Per-step enter hooks.
  if (name === "camera") obReflectCameraState();
  if (name === "stretch") obReflectStretchChoice();
  if (name === "calibrate") startCalibration();
  if (name === "done") finishOnboardingSoon();
}

// ---------- Camera permission step ----------
async function obEnableCamera() {
  el.obBtnEnableCam.disabled = true;
  el.obCamState.textContent = "Requesting camera…";
  el.obCamState.className = "ob-cam-state";
  try {
    await acquireCamera();
    await attachStream(el.obCamPreview, null);
    state.obCameraOk = true;
    dlog("onboarding camera enabled");
  } catch (err) {
    state.obCameraOk = false;
    dwarn("onboarding camera denied", err);
  }
  el.obBtnEnableCam.disabled = false;
  obReflectCameraState();
}

function obReflectCameraState() {
  const camStep = el.obCamStep;
  if (state.obCameraOk) {
    camStep.classList.add("cam-ok");
    el.obCamState.textContent = "Camera connected — that's you! Nothing leaves this device.";
    el.obCamState.className = "ob-cam-state ok";
    el.obBtnEnableCam.classList.add("hidden");
  } else {
    camStep.classList.remove("cam-ok");
    el.obCamState.textContent =
      "Camera is off. Moov needs it to check your form — but you can continue without it.";
    el.obCamState.className = "ob-cam-state";
    el.obBtnEnableCam.classList.remove("hidden");
  }
}

// ---------- Choose default stretch ----------
function obChooseDefault(key) {
  if (!STRETCHES[key]) return;
  state.obDefault = key;
  try {
    localStorage.setItem(LS_DEFAULT_STRETCH, key);
  } catch {
    /* ignore */
  }
  dlog("onboarding default stretch:", key);
  obReflectStretchChoice();
}

function obReflectStretchChoice() {
  el.obStretchCards.querySelectorAll(".stretch-card").forEach((c) => {
    c.classList.toggle("selected", c.dataset.stretch === state.obDefault);
  });
}

// ---------- LIVE calibration (the wow moment) ----------
// A lighter version of the real challenge: hold a shorter beat, or do just a
// couple of reps — enough to prove the pose detection works on the user.
function startCalibration() {
  const s = STRETCHES[state.obDefault];
  el.obCalStretchName.textContent = s.name;
  state.obEval = makeEvaluator(state.obDefault, { holdMs: CAL_HOLD_MS, reps: 2 });
  state.obLastTick = now();
  el.obCalRing.style.strokeDasharray = String(CAL_RING_CIRC);
  el.obCalRing.style.strokeDashoffset = String(CAL_RING_CIRC);
  el.onboarding.querySelector('[data-step="calibrate"]').classList.remove("cal-done");

  // No camera or no model? Turn calibration into a friendly "you're all set".
  if (!state.stream || state.detectorStatus === "failed") {
    dwarn("calibration unavailable → auto-pass", {
      stream: !!state.stream,
      detector: state.detectorStatus,
    });
    el.obCalHint.textContent = state.stream
      ? "Skipping the live check — we'll verify during real breaks."
      : "No camera — we'll just time your holds during breaks.";
    setTimeout(calibrationPassed, 900);
    return;
  }

  attachStream(el.obCalVideo, el.obCalOverlay);
  el.obCalHint.textContent = "Warming up…";
  clearInterval(state.obCalLoop);
  state.obCalLoop = setInterval(calibrationTick, DETECT_INTERVAL_MS);
}

async function calibrationTick() {
  if (!state.onboarding) return;
  const t = now();
  const dt = t - state.obLastTick;
  state.obLastTick = t;

  if (state.detectorStatus === "loading") {
    el.obCalHint.textContent = "Warming up the pose detector…";
    return;
  }
  if (state.detectorStatus === "failed") {
    stopCalibration();
    el.obCalHint.textContent = "Pose check unavailable — you're all set.";
    setTimeout(calibrationPassed, 600);
    return;
  }

  const kp = await estimatePoseFrom(el.obCalVideo);
  const r = state.obEval.update(kp, dt);
  if (kp) drawSkeletonOn(el.obCalOverlay, kp, r.valid ? "#30d158" : "#64d2ff");

  el.obCalHint.textContent = r.hint;
  el.obCalHint.className = `pose-hint ${r.tone || ""}`;
  el.obCalRing.style.strokeDashoffset = String(CAL_RING_CIRC * (1 - Math.max(0, Math.min(1, r.progress))));

  if (r.done) {
    stopCalibration();
    calibrationPassed();
  }
}

function calibrationPassed() {
  dlog("calibration passed");
  el.obCalHint.textContent = "Nailed it! 🎯";
  el.obCalHint.className = "pose-hint ok";
  el.onboarding.querySelector('[data-step="calibrate"]').classList.add("cal-done");
  burstConfetti(el.obConfetti, 24);
  setTimeout(() => {
    if (OB_STEPS[state.obStep] === "calibrate") obGoto(state.obStep + 1);
  }, 1400);
}

function stopCalibration() {
  clearInterval(state.obCalLoop);
  state.obCalLoop = null;
  clearCanvas(el.obCalOverlay);
  el.obCalVideo.srcObject = null;
}

// ---------- Finish ----------
function finishOnboardingSoon() {
  burstConfetti(el.obConfetti, 60);
}

function finishOnboarding() {
  if (state.obDone) return;
  state.obDone = true;
  dlog("finishOnboarding");
  try {
    localStorage.setItem(LS_ONBOARDED, "1");
  } catch {
    /* ignore */
  }
  stopCalibration();
  // Release the shared camera; the real break flow re-acquires on demand.
  stopWebcam();
  state.onboarding = false;
  el.onboarding.classList.remove("active");
  el.idleScreen.classList.add("active");
  startIdleCountdown();
}

// ---------- Confetti ----------
function burstConfetti(container, count) {
  if (!container) return;
  const colors = ["#64d2ff", "#5e5ce6", "#bf5af2", "#30d158", "#ffd60a", "#ff6b6b"];
  for (let i = 0; i < count; i++) {
    const bit = document.createElement("span");
    bit.className = "confetti-bit";
    bit.style.left = `${Math.random() * 100}%`;
    bit.style.background = colors[Math.floor(Math.random() * colors.length)];
    bit.style.setProperty("--dx", `${(Math.random() - 0.5) * 240}px`);
    bit.style.setProperty("--rot", `${Math.random() * 720 - 360}deg`);
    bit.style.animationDelay = `${Math.random() * 0.25}s`;
    bit.style.animationDuration = `${1.4 + Math.random() * 0.9}s`;
    container.appendChild(bit);
    setTimeout(() => bit.remove(), 2600);
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
