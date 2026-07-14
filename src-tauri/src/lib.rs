use tauri::{AppHandle, Manager, Emitter, WebviewWindow};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

// 30 minutes in seconds for production, configurable via DEV mode
#[cfg(debug_assertions)]
const TIMER_INTERVAL_SECS: u64 = 15; // 15 seconds in dev for testing
#[cfg(not(debug_assertions))]
const TIMER_INTERVAL_SECS: u64 = 1800; // 30 minutes in production

/// Managed state to track whether screen is currently locked
struct AppState {
    is_locked: AtomicBool,
    timer_paused: AtomicBool,
    /// When > 0, the next break fires after this many seconds instead of the
    /// full interval (set by a snooze). Consumed once, then reset to 0.
    snooze_secs: AtomicU64,
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
    app.emit("screen-unlocked", ()).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        release_lock(&window);
    }
    Ok(())
}

/// Snooze the current break: unlock now, but schedule the next break to fire
/// after `secs` instead of the full interval. This is the escape valve for
/// meetings / incidents / "I genuinely can't stand right now".
#[tauri::command]
fn snooze_break(secs: u64, app: AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.snooze_secs.store(secs, Ordering::SeqCst);
    state.is_locked.store(false, Ordering::SeqCst);
    app.emit("screen-unlocked", ()).map_err(|e| e.to_string())?;
    if let Some(window) = app.get_webview_window("main") {
        release_lock(&window);
    }
    Ok(())
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

/// Returns the timer interval in seconds
#[tauri::command]
fn get_timer_interval() -> u64 {
    TIMER_INTERVAL_SECS
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = Arc::new(AppState {
        is_locked: AtomicBool::new(false),
        timer_paused: AtomicBool::new(false),
        snooze_secs: AtomicU64::new(0),
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
                let mut wait_secs = TIMER_INTERVAL_SECS;

                loop {
                    // Wait until the next break is due.
                    std::thread::sleep(Duration::from_secs(wait_secs));

                    // Fire the break, unless paused or already locked.
                    if !state.timer_paused.load(Ordering::SeqCst)
                        && !state.is_locked.load(Ordering::SeqCst)
                    {
                        state.is_locked.store(true, Ordering::SeqCst);
                        if let Some(window) = app_handle.get_webview_window("main") {
                            engage_lock(&window);
                        }
                        let _ = app_handle.emit("screen-locked", ());
                    }

                    // Block here until the user gets out (stretch, snooze, or manual unlock).
                    while state.is_locked.load(Ordering::SeqCst) {
                        std::thread::sleep(Duration::from_millis(500));
                    }

                    // A snooze shortens the wait to the next break; otherwise full interval.
                    let snoozed = state.snooze_secs.swap(0, Ordering::SeqCst);
                    wait_secs = if snoozed > 0 { snoozed } else { TIMER_INTERVAL_SECS };
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
