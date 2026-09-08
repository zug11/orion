use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WebviewWindowBuilder};

#[derive(Default)]
struct QuitState {
    ready: HashSet<String>,
    pending: HashSet<String>,
    attempt: u64,
    quitting: bool,
    allowed: bool,
}

impl QuitState {
    fn begin(&mut self) -> Option<u64> {
        if self.allowed || self.ready.is_empty() || self.quitting {
            return None;
        }
        self.attempt += 1;
        self.pending = self.ready.clone();
        self.quitting = true;
        Some(self.attempt)
    }
    fn complete(&mut self, label: &str, attempt: u64) -> bool {
        if !self.quitting || self.attempt != attempt {
            return false;
        }
        self.pending.remove(label);
        if self.pending.is_empty() {
            self.allowed = true;
        }
        self.allowed
    }
    fn cancel(&mut self, attempt: u64) -> bool {
        if !self.quitting || self.attempt != attempt {
            return false;
        }
        self.quitting = false;
        self.pending.clear();
        self.allowed = false;
        true
    }
}

#[derive(Default)]
pub struct DesktopWindows {
    next_id: AtomicU64,
    focused: Mutex<Option<String>>,
    quit: Mutex<QuitState>,
    overviews: Mutex<HashMap<String, (String, String)>>,
}

pub fn preferred_window(app: &AppHandle) -> Option<WebviewWindow> {
    let state = app.state::<DesktopWindows>();
    let label = state
        .focused
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    label
        .and_then(|id| app.get_webview_window(&id))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next())
}

pub fn focused(app: &AppHandle, label: &str) {
    *app.state::<DesktopWindows>()
        .focused
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(label.into());
}

#[tauri::command]
pub async fn new_orion_window(
    app: AppHandle,
    window: WebviewWindow,
    space_id: String,
) -> Result<(), String> {
    if app
        .state::<DesktopWindows>()
        .quit
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .quitting
    {
        return Err("Orion is saving its windows before quitting.".into());
    }
    if space_id.is_empty() || space_id.len() > 512 || space_id.chars().any(char::is_control) {
        return Err("This Space cannot be opened in another window.".into());
    }
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("Orion's window configuration is missing.")?;
    let sequence = app
        .state::<DesktopWindows>()
        .next_id
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    config.label = format!("orion-window-{sequence}");
    let mut url = tauri::Url::parse("http://localhost/index.html").map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("space", &space_id);
    config.url =
        tauri::WebviewUrl::App(format!("index.html?{}", url.query().unwrap_or_default()).into());
    if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
        config.width = (size.width as f64 / scale).clamp(1024.0, 1440.0);
        config.height = (size.height as f64 / scale).clamp(680.0, 900.0);
    }
    config.focus = true;
    let opened = WebviewWindowBuilder::from_config(&app, &config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| format!("Orion couldn't open another window: {e}"))?;
    focused(&app, opened.label());
    opened.set_focus().map_err(|e| e.to_string())
}

pub fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    let new_window = MenuItem::with_id(
        app,
        "orion-new-window",
        "New Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            if submenu.text()? == "File" {
                submenu.insert(&new_window, 0)?;
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "orion-new-window" {
            if let Some(window) = preferred_window(app) {
                let _ = window.emit("orion-new-window", ());
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn is_citation_window(app: AppHandle, window: WebviewWindow) -> bool {
    preferred_window(&app).is_some_and(|target| target.label() == window.label())
}

#[tauri::command]
pub fn set_exit_guard_ready(window: WebviewWindow, state: State<'_, DesktopWindows>, ready: bool) {
    let mut quit = state.quit.lock().unwrap_or_else(|e| e.into_inner());
    if ready {
        quit.ready.insert(window.label().into());
        if quit.quitting {
            quit.pending.insert(window.label().into());
            let _ = window.emit("orion-quit-requested", quit.attempt);
        }
    } else {
        quit.ready.remove(window.label());
    }
}

/// True only after every participating renderer has flushed its own changes.
pub fn may_exit(app: &AppHandle) -> bool {
    let state = app.state::<DesktopWindows>();
    let mut quit = state.quit.lock().unwrap_or_else(|e| e.into_inner());
    if quit.allowed || quit.ready.is_empty() {
        return true;
    }
    let attempt = quit.begin();
    drop(quit);
    if let Some(attempt) = attempt {
        let _ = app.emit("orion-quit-requested", attempt);
    }
    false
}

#[tauri::command]
pub fn complete_app_exit(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopWindows>,
    attempt: u64,
) {
    let finished = state
        .quit
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .complete(window.label(), attempt);
    if finished {
        app.exit(0);
    }
}

#[tauri::command]
pub fn cancel_app_exit(app: AppHandle, state: State<'_, DesktopWindows>, attempt: u64) {
    let cancelled = state
        .quit
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .cancel(attempt);
    if cancelled {
        let _ = app.emit("orion-quit-cancelled", ());
    }
}

#[tauri::command]
pub async fn close_orion_window(window: WebviewWindow) -> Result<(), String> {
    window.destroy().map_err(|e| e.to_string())
}

pub fn destroyed(app: &AppHandle, label: &str) {
    let state = app.state::<DesktopWindows>();
    let mut quit = state.quit.lock().unwrap_or_else(|e| e.into_inner());
    quit.ready.remove(label);
    quit.pending.remove(label);
    let finished = quit.quitting && quit.pending.is_empty();
    if finished {
        quit.allowed = true;
    }
    drop(quit);
    state
        .overviews
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .retain(|_, (owner, _)| owner != label);
    if finished {
        app.exit(0);
    }
}

#[tauri::command]
pub fn claim_space_overview(
    window: WebviewWindow,
    state: State<'_, DesktopWindows>,
    space_id: String,
    request_id: String,
) -> bool {
    let mut jobs = state.overviews.lock().unwrap_or_else(|e| e.into_inner());
    if jobs.contains_key(&space_id) {
        return false;
    }
    jobs.insert(space_id, (window.label().into(), request_id));
    true
}

#[tauri::command]
pub fn release_space_overview(
    window: WebviewWindow,
    state: State<'_, DesktopWindows>,
    space_id: String,
    request_id: String,
) {
    let mut jobs = state.overviews.lock().unwrap_or_else(|e| e.into_inner());
    if jobs
        .get(&space_id)
        .is_some_and(|(owner, id)| owner == window.label() && id == &request_id)
    {
        jobs.remove(&space_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn two_windows() -> QuitState {
        QuitState {
            ready: ["main".into(), "orion-window-1".into()].into(),
            ..Default::default()
        }
    }
    #[test]
    fn quit_waits_for_every_window() {
        let mut state = two_windows();
        let attempt = state.begin().unwrap();
        assert!(!state.complete("main", attempt));
        assert!(!state.complete("main", attempt));
        assert!(state.complete("orion-window-1", attempt));
    }
    #[test]
    fn cancelled_or_stale_attempts_cannot_quit() {
        let mut state = two_windows();
        let old = state.begin().unwrap();
        assert!(state.cancel(old));
        assert!(!state.complete("main", old));
        let current = state.begin().unwrap();
        assert!(!state.complete("main", old));
        assert!(!state.cancel(old));
        assert!(!state.complete("main", current));
        assert!(state.complete("orion-window-1", current));
    }
}
