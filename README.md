# Moov — Stretch Blocker

A lightweight **Tauri + Vanilla JS** desktop app that forces you to take stretch
breaks for your lower back. Every 30 minutes it takes over your screen with a
fullscreen, always-on-top window and won't let you back to work until you've
actually held a stretch — verified in real time with your webcam and
[TensorFlow.js MoveNet](https://github.com/tensorflow/tfjs-models/tree/master/pose-detection)
pose detection.

## The break flow

When the break window appears, it runs a 4-step sequence:

1. **The Interruption** — camera off. Big text: _"Time for your back. Stand up
   and step back."_ with a 5-second countdown.
2. **The Prompt** — pick a stretch (Overhead Decompression or Lumbar Extension).
   The webcam fades in as a picture-in-picture so you can frame yourself.
3. **The Challenge** — _"Hold this position for 10 seconds."_ MoveNet checks your
   pose (e.g. both wrists raised well above your eyes/shoulders for the overhead
   stretch). A circular progress ring fills only while a **valid** pose is held,
   and pauses the moment you drop it.
4. **The Release** — the screen flashes green, shows _"Great job, back to work!"_,
   stops the camera, and releases the window.

If the camera is denied or the model can't load, it falls back to a plain timed
hold so you're never trapped.

## Tech stack

- **[Tauri 2](https://tauri.app/)** (Rust) — window management, the 30-minute
  break timer, tray icon, and fullscreen/always-on-top "lock" mode.
- **Vanilla JS + HTML/CSS** — no framework. The UI flow lives in
  [`src/main.js`](src/main.js).
- **[TensorFlow.js](https://www.tensorflow.org/js) + MoveNet** — loaded from a CDN
  as UMD globals; runs entirely on-device.
- **[Vite](https://vite.dev/)** — dev server and production bundler.

## Project layout

```
index.html          # screens + the 4 phase sections, loads TF.js/MoveNet from CDN
src/main.js          # break-flow orchestration + MoveNet pose logic
src/styles.css       # styling (SVG progress ring, PiP webcam, green flash)
src-tauri/           # Rust backend: timer, tray, window lock/unlock commands
```

## Getting started

Prerequisites: [Node.js](https://nodejs.org/), [Rust](https://www.rust-lang.org/tools/install),
and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
npm install

# Run in development (hot reload; break timer fires every 15s for testing)
npm run tauri dev

# Build a production desktop bundle (break timer every 30 min)
npm run tauri build
```

> **macOS note:** the app needs camera access. Grant permission when prompted
> (backed by `NSCameraUsageDescription` in `src-tauri/Info.plist`). MoveNet also
> downloads its model weights on first run, so the first break needs a network
> connection.

## Debugging

Dev builds log the full lifecycle to the console (startup, phase transitions,
webcam, model load, and a per-tick pose trace showing keypoint confidence and
the y-values feeding the pose checks). In a production build you can opt in with:

```js
localStorage.moovDebug = "1"; // then reload
```

## Configuration

- **Break interval** — `TIMER_INTERVAL_SECS` in
  [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs) (15s in dev, 1800s in release).
- **Hold time & pose thresholds** — the tuning constants and `isOverheadPose` /
  `isLumbarPose` heuristics at the top of [`src/main.js`](src/main.js).
