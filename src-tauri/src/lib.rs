use tauri::{AppHandle, Manager, Emitter, WebviewWindow};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

// Default time between breaks. The live value lives in `AppState.interval_secs`
// (settable from the frontend); this is only the startup default.
#[cfg(debug_assertions)]
const TIMER_INTERVAL_SECS: u64 = 15; // 15 seconds in dev for testing
#[cfg(not(debug_assertions))]
const TIMER_INTERVAL_SECS: u64 = 1800; // 30 minutes in production

// Floor for a user-chosen interval, so Settings can't set breaks so frequently
// they're unusable. Lower in dev to keep testing fast.
#[cfg(debug_assertions)]
const MIN_INTERVAL_SECS: u64 = 5;
#[cfg(not(debug_assertions))]
const MIN_INTERVAL_SECS: u64 = 60;

// Cumulative snooze allowed since the last completed stretch. Once the user has
// deferred breaks for this long without moving, snooze is refused and the break
// becomes mandatory. Shorter in dev so the cap is reachable during testing.
#[cfg(debug_assertions)]
const SNOOZE_CAP_SECS: u64 = 30 * 60;
#[cfg(not(debug_assertions))]
const SNOOZE_CAP_SECS: u64 = 2 * 60 * 60; // 2 hours

/// Countdown snapshot handed to the frontend so its idle ring matches the real
/// (backend) timer instead of running an independent clock.
#[derive(Clone, serde::Serialize)]
struct Countdown {
    remaining: u64, // seconds until the next break
    cycle: u64,     // length of the current wait cycle (interval or snooze)
    paused: bool,
}

/// Managed state to track whether screen is currently locked
struct AppState {
    is_locked: AtomicBool,
    timer_paused: AtomicBool,
    /// When > 0, the next break fires after this many seconds instead of the
    /// full interval (set by a snooze). Consumed once, then reset to 0.
    snooze_secs: AtomicU64,
    /// Live time between breaks, in seconds. Seeded from `TIMER_INTERVAL_SECS`
    /// and updated by `set_timer_interval` when the user changes it in Settings.
    interval_secs: AtomicU64,
    /// Seconds until the next break, republished by the timer each tick.
    remaining_secs: AtomicU64,
    /// Length of the current wait cycle (interval, or a snooze if pending).
    cycle_secs: AtomicU64,
    /// Cumulative snooze taken since the last completed stretch. Reset on
    /// unlock_screen (a real stretch), grown by snooze_break, capped at
    /// SNOOZE_CAP_SECS.
    snooze_used_secs: AtomicU64,
}

/// Put the window into "break blocker" mode: fullscreen, always-on-top, and
/// un-escapable (no close/minimize).
fn engage_lock(window: &WebviewWindow) {
    let _ = window.set_fullscreen(true);
    let _ = window.set_always_on_top(true);
    let _ = window.set_closable(false);
    let _ = window.set_minimizable(false);
    let _ = window.show();
    let _ = window.set_focus();
}

/// Restore the window to its normal, dismissable state.
fn release_lock(window: &WebviewWindow) {
    let _ = window.set_closable(true);
    let _ = window.set_minimizable(true);
    let _ = window.set_always_on_top(false);
    let _ = window.set_fullscreen(false);
}

/// Called from the frontend when face detection confirms the user has stretched,
/// or via the manual "I've stretched" escape hatch.
#[tauri::command]
fn unlock_screen(app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.is_locked.store(false, Ordering::SeqCst);
    // Completing a real stretch clears the snooze debt.
    state.snooze_used_secs.store(0, Ordering::SeqCst);
    app.emit("screen-unlocked", ()).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        release_lock(&window);
    }
    Ok(())
}

/// Snooze the current break: unlock now, but schedule the next break to fire
/// after `secs` instead of the full interval. This is the escape valve for
/// meetings / incidents / "I genuinely can't stand right now".
///
/// Snooze is capped: the requested duration is clamped to the remaining budget
/// (SNOOZE_CAP_SECS minus what's already been snoozed since the last stretch),
/// and the call is refused once that budget is exhausted. Returns the seconds
/// actually snoozed.
#[tauri::command]
fn snooze_break(secs: u64, app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<u64, String> {
    let used = state.snooze_used_secs.load(Ordering::SeqCst);
    let budget = SNOOZE_CAP_SECS.saturating_sub(used);
    let eff = secs.min(budget);
    if eff == 0 {
        return Err("snooze budget exhausted".into());
    }
    state.snooze_used_secs.store(used + eff, Ordering::SeqCst);
    state.snooze_secs.store(eff, Ordering::SeqCst);
    state.is_locked.store(false, Ordering::SeqCst);
    app.emit("screen-unlocked", ()).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        release_lock(&window);
    }
    Ok(eff)
}

/// Called by the timer (or "Stretch now") to lock the screen.
#[tauri::command]
fn lock_screen(app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    if state.is_locked.load(Ordering::SeqCst) {
        return Ok(()); // Already locked
    }
    state.is_locked.store(true, Ordering::SeqCst);
    if let Some(window) = app.get_webview_window("main") {
        engage_lock(&window);
    }
    app.emit("screen-locked", ()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Returns whether the screen is currently locked
#[tauri::command]
fn is_locked(state: tauri::State<'_, Arc<AppState>>) -> bool {
    state.is_locked.load(Ordering::SeqCst)
}

/// Pause/resume the timer (from the tray menu)
#[tauri::command]
fn set_timer_paused(paused: bool, state: tauri::State<'_, Arc<AppState>>) {
    state.timer_paused.store(paused, Ordering::SeqCst);
}

/// Returns the current timer interval in seconds.
#[tauri::command]
fn get_timer_interval(state: tauri::State<'_, Arc<AppState>>) -> u64 {
    state.interval_secs.load(Ordering::SeqCst)
}

/// Set the time between breaks (from Settings). Clamped to `MIN_INTERVAL_SECS`.
/// Takes effect on the current countdown — no restart needed.
#[tauri::command]
fn set_timer_interval(secs: u64, state: tauri::State<'_, Arc<AppState>>) -> u64 {
    let clamped = secs.max(MIN_INTERVAL_SECS);
    state.interval_secs.store(clamped, Ordering::SeqCst);
    clamped
}

/// Authoritative countdown for the idle screen — reflects the real timer.
#[tauri::command]
fn get_countdown(state: tauri::State<'_, Arc<AppState>>) -> Countdown {
    Countdown {
        remaining: state.remaining_secs.load(Ordering::SeqCst),
        cycle: state.cycle_secs.load(Ordering::SeqCst),
        paused: state.timer_paused.load(Ordering::SeqCst),
    }
}

/// Seconds of snooze the user still has before the cap forces a break.
#[tauri::command]
fn get_snooze_budget(state: tauri::State<'_, Arc<AppState>>) -> u64 {
    SNOOZE_CAP_SECS.saturating_sub(state.snooze_used_secs.load(Ordering::SeqCst))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState {
        is_locked: AtomicBool::new(false),
        timer_paused: AtomicBool::new(false),
        snooze_secs: AtomicU64::new(0),
        interval_secs: AtomicU64::new(TIMER_INTERVAL_SECS),
        remaining_secs: AtomicU64::new(TIMER_INTERVAL_SECS),
        cycle_secs: AtomicU64::new(TIMER_INTERVAL_SECS),
        snooze_used_secs: AtomicU64::new(0),
    });

    let timer_state = Arc::clone(&state);
    let tray_state = Arc::clone(&state);

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            lock_screen,
            unlock_screen,
            snooze_break,
            is_locked,
            set_timer_paused,
            get_timer_interval,
            set_timer_interval,
            get_countdown,
            get_snooze_budget,
        ])
        .setup(move |app| {
            // In dev, pop open the WebView DevTools so frontend console.log()
            // output (the `[moov]` debug logs) is visible — those go to the
            // WebView console, NOT the `tauri dev` terminal (which is Rust only).
            #[cfg(debug_assertions)]
            if let Some(window) = app.get_webview_window("main") {
                window.open_devtools();
            }

            // ---- Menu-bar (tray) icon: pause without quitting ----
            let pause_i = MenuItemBuilder::with_id("pause", "Pause Moov").build(app)?;
            let stretch_i = MenuItemBuilder::with_id("stretch", "Stretch now").build(app)?;
            let quit_i = MenuItemBuilder::with_id("quit", "Quit Moov").build(app)?;
            let menu = MenuBuilder::new(app)
                .items(&[&pause_i, &stretch_i, &quit_i])
                .build()?;

            let pause_item = pause_i.clone();
            let menu_state = Arc::clone(&tray_state);
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Moov — stretch reminder")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "quit" => app.exit(0),
                    "stretch" => {
                        if !menu_state.is_locked.load(Ordering::SeqCst) {
                            menu_state.is_locked.store(true, Ordering::SeqCst);
                            if let Some(window) = app.get_webview_window("main") {
                                engage_lock(&window);
                            }
                            let _ = app.emit("screen-locked", ());
                        }
                    }
                    "pause" => {
                        let now_paused = !menu_state.timer_paused.load(Ordering::SeqCst);
                        menu_state.timer_paused.store(now_paused, Ordering::SeqCst);
                        let _ = pause_item.set_text(if now_paused {
                            "Resume Moov"
                        } else {
                            "Pause Moov"
                        });
                    }
                    _ => {}
                })
                .build(app)?;

            // ---- Break timer ----
            let app_handle = app.handle().clone();
            let state = timer_state;

            std::thread::spawn(move || {
                // Poll once a second and count elapsed idle time toward the
                // target. Polling (vs. one long sleep) lets an interval change
                // from Settings take effect on the current countdown, and lets
                // pause freeze it, without waiting out a stale duration.
                let mut elapsed: u64 = 0;

                loop {
                    std::thread::sleep(Duration::from_secs(1));

                    // A break is on screen — wait it out, then start fresh.
                    if state.is_locked.load(Ordering::SeqCst) {
                        elapsed = 0;
                        continue;
                    }
                    // Frozen while paused (tray toggle).
                    if state.timer_paused.load(Ordering::SeqCst) {
                        continue;
                    }

                    elapsed += 1;

                    // A pending snooze shortens just this cycle; otherwise use
                    // the live, user-configurable interval.
                    let snooze = state.snooze_secs.load(Ordering::SeqCst);
                    let target = if snooze > 0 {
                        snooze
                    } else {
                        state.interval_secs.load(Ordering::SeqCst)
                    };

                    // Publish the countdown so the idle screen can mirror it.
                    state.cycle_secs.store(target, Ordering::SeqCst);
                    state.remaining_secs.store(target.saturating_sub(elapsed), Ordering::SeqCst);

                    if elapsed >= target {
                        state.snooze_secs.store(0, Ordering::SeqCst); // consume the snooze
                        elapsed = 0;
                        state.is_locked.store(true, Ordering::SeqCst);
                        if let Some(window) = app_handle.get_webview_window("main") {
                            engage_lock(&window);
                        }
                        let _ = app_handle.emit("screen-locked", ());
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
