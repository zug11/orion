use serde::{Deserialize, Serialize};
use serde_json::Value;
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteTarget {
    space_id: String,
    note_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum NavigationPassage {
    Range(NavigationRange),
    Text(NavigationText),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NavigationRange {
    from: u64,
    to: u64,
    text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NavigationText {
    locator: TextLocator,
    text: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
enum TextLocator {
    #[serde(rename = "unique-text")]
    UniqueText,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
struct NoteNavigation {
    #[serde(flatten)]
    target: NoteTarget,
    #[serde(skip_serializing_if = "Option::is_none")]
    passages: Option<Vec<NavigationPassage>>,
}

impl From<NoteTarget> for NoteNavigation {
    fn from(target: NoteTarget) -> Self {
        Self {
            target,
            passages: None,
        }
    }
}

fn validate_navigation_passages(passages: Option<&[NavigationPassage]>) -> Result<(), String> {
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
    let Some(passages) = passages else {
        return Ok(());
    };
    if passages.len() > 16 {
        return Err("This excerpt has too many passages to open.".into());
    }
    let mut characters = 0;
    for passage in passages {
        let text = match passage {
            NavigationPassage::Range(range) => {
                if range.from > range.to || range.to > MAX_SAFE_INTEGER {
                    return Err("This excerpt has an invalid text range.".into());
                }
                &range.text
            }
            NavigationPassage::Text(passage) => &passage.text,
        };
        // Match the renderer's string-length unit and bound the complete event.
        characters += text.encode_utf16().count();
        if characters > 32_000 {
            return Err("This excerpt is too large to open in another window.".into());
        }
    }
    Ok(())
}

#[derive(Default)]
struct WindowRouting {
    focused: Option<String>,
    last_library: Option<String>,
    writing: HashMap<String, NoteTarget>,
    navigation_ready: HashSet<String>,
    pending_navigation: HashMap<String, NoteNavigation>,
}

impl WindowRouting {
    fn preferred_library(&self, available: &[String]) -> Option<String> {
        let is_library =
            |label: &String| available.contains(label) && !self.writing.contains_key(label);
        self.focused
            .as_ref()
            .filter(|label| is_library(label))
            .or_else(|| self.last_library.as_ref().filter(|label| is_library(label)))
            .cloned()
            .or_else(|| {
                available
                    .iter()
                    .find(|label| label.as_str() == "main" && is_library(label))
                    .cloned()
            })
            .or_else(|| available.iter().find(|label| is_library(label)).cloned())
    }

    fn focus(&mut self, label: &str) {
        self.focused = Some(label.into());
        if !self.writing.contains_key(label) {
            self.last_library = Some(label.into());
        }
    }

    fn route_note(&mut self, label: &str, target: &NoteNavigation) -> bool {
        if self.writing.contains_key(label) {
            return false;
        }
        if self.navigation_ready.contains(label) {
            return true;
        }
        self.pending_navigation.insert(label.into(), target.clone());
        false
    }

    fn set_navigation_ready(&mut self, label: &str, ready: bool) -> Option<NoteNavigation> {
        if self.writing.contains_key(label) {
            return None;
        }
        if ready {
            self.navigation_ready.insert(label.into());
            self.pending_navigation.remove(label)
        } else {
            self.navigation_ready.remove(label);
            None
        }
    }

    fn remove(&mut self, label: &str) {
        self.writing.remove(label);
        self.navigation_ready.remove(label);
        self.pending_navigation.remove(label);
        if self.focused.as_deref() == Some(label) {
            self.focused = None;
        }
        if self.last_library.as_deref() == Some(label) {
            self.last_library = None;
        }
    }
}

#[derive(Default)]
pub struct DesktopWindows {
    next_id: AtomicU64,
    routing: Mutex<WindowRouting>,
    creation: tokio::sync::Mutex<()>,
    quit: Mutex<QuitState>,
    overviews: Mutex<HashMap<String, (String, String)>>,
}

pub fn preferred_window(app: &AppHandle) -> Option<WebviewWindow> {
    let state = app.state::<DesktopWindows>();
    let label = state
        .routing
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .focused
        .clone();
    label
        .and_then(|id| app.get_webview_window(&id))
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| app.webview_windows().into_values().next())
}

pub fn preferred_library_window(app: &AppHandle) -> Option<WebviewWindow> {
    let mut available: Vec<_> = app.webview_windows().into_keys().collect();
    available.sort();
    let label = app
        .state::<DesktopWindows>()
        .routing
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .preferred_library(&available)?;
    app.get_webview_window(&label)
}

pub fn focused(app: &AppHandle, label: &str) {
    app.state::<DesktopWindows>()
        .routing
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .focus(label);
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() || id.len() > 512 || id.chars().any(char::is_control) {
        return Err("This note or Space cannot be opened in another window.".into());
    }
    Ok(())
}

fn validate_note_target(vault: &Value, target: &NoteTarget) -> Result<(), String> {
    validate_id(&target.space_id)?;
    validate_id(&target.note_id)?;
    if vault.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
        return Err("The Orion library has an invalid or unsupported schema.".into());
    }
    let spaces = vault
        .get("spaces")
        .and_then(Value::as_array)
        .ok_or("The Orion library has no valid Space directory.")?;
    let mut matching_spaces = spaces.iter().filter(|space| {
        space.pointer("/workspace/id").and_then(Value::as_str) == Some(target.space_id.as_str())
    });
    let space = matching_spaces
        .next()
        .ok_or("This Space is no longer available.")?;
    if matching_spaces.next().is_some()
        || space.get("schemaVersion").and_then(Value::as_u64) != Some(1)
    {
        return Err("The exact Space has an invalid schema.".into());
    }
    let notes = space
        .get("notes")
        .and_then(Value::as_array)
        .ok_or("The Space has no valid note directory.")?;
    if notes
        .iter()
        .filter(|note| note.get("id").and_then(Value::as_str) == Some(target.note_id.as_str()))
        .count()
        != 1
    {
        return Err("This note is no longer available in this Space.".into());
    }
    Ok(())
}

async fn validate_saved_target(app: &AppHandle, target: &NoteTarget) -> Result<(), String> {
    validate_id(&target.space_id)?;
    validate_id(&target.note_id)?;
    let vault = crate::load_vault(app.clone())
        .await?
        .ok_or("Open Orion once to create its local library.")?;
    validate_note_target(&vault, target)
}

fn ensure_not_quitting(app: &AppHandle) -> Result<(), String> {
    if app
        .state::<DesktopWindows>()
        .quit
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .quitting
    {
        return Err("Orion is saving its windows before quitting.".into());
    }
    Ok(())
}

fn window_url(space_id: &str, note_id: Option<&str>, writing: bool) -> tauri::WebviewUrl {
    let mut url = tauri::Url::parse("http://localhost/index.html").expect("constant URL is valid");
    url.query_pairs_mut().append_pair("space", space_id);
    if let Some(note_id) = note_id {
        url.query_pairs_mut().append_pair("note", note_id);
    }
    if writing {
        url.query_pairs_mut().append_pair("view", "writing");
    }
    tauri::WebviewUrl::App(format!("index.html?{}", url.query().unwrap_or_default()).into())
}

fn create_window(
    app: &AppHandle,
    origin: Option<&WebviewWindow>,
    space_id: &str,
    note_id: Option<&str>,
    writing: bool,
    pending_navigation: Option<NoteNavigation>,
) -> Result<WebviewWindow, String> {
    ensure_not_quitting(app)?;
    let mut config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or("Orion's window configuration is missing.")?;
    let state = app.state::<DesktopWindows>();
    let sequence = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    config.label = format!("orion-window-{sequence}");
    config.url = window_url(space_id, note_id, writing);
    if writing {
        config.width = 900.0;
        config.height = 820.0;
        config.min_width = Some(520.0);
        config.min_height = Some(480.0);
        config.title = "Orion — Writing".into();
        state
            .routing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .writing
            .insert(
                config.label.clone(),
                NoteTarget {
                    space_id: space_id.into(),
                    note_id: note_id.ok_or("A writing window needs a note.")?.into(),
                },
            );
    } else if let Some(origin) = origin {
        if let (Ok(size), Ok(scale)) = (origin.inner_size(), origin.scale_factor()) {
            config.width = (size.width as f64 / scale).clamp(1024.0, 1440.0);
            config.height = (size.height as f64 / scale).clamp(680.0, 900.0);
        }
    }
    if let Some(navigation) = pending_navigation {
        state
            .routing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending_navigation
            .insert(config.label.clone(), navigation);
    }
    config.focus = true;
    let opened = WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| e.to_string())
        .and_then(|builder| {
            builder
                .build()
                .map_err(|e| format!("Orion couldn't open another window: {e}"))
        });
    if opened.is_err() {
        state
            .routing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&config.label);
    }
    let opened = opened?;
    focused(app, opened.label());
    reveal_window(&opened)?;
    Ok(opened)
}

fn reveal_window(window: &WebviewWindow) -> Result<(), String> {
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn new_orion_window(
    app: AppHandle,
    window: WebviewWindow,
    space_id: String,
) -> Result<(), String> {
    validate_id(&space_id)?;
    let state = app.state::<DesktopWindows>();
    let _creation = state.creation.lock().await;
    create_window(&app, Some(&window), &space_id, None, false, None).map(|_| ())
}

#[tauri::command]
pub async fn open_writing_window(
    app: AppHandle,
    window: WebviewWindow,
    space_id: String,
    note_id: String,
) -> Result<(), String> {
    let target = NoteTarget { space_id, note_id };
    validate_saved_target(&app, &target).await?;
    let state = app.state::<DesktopWindows>();
    let _creation = state.creation.lock().await;
    ensure_not_quitting(&app)?;
    let existing = state
        .routing
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .writing
        .iter()
        .find_map(|(label, candidate)| (candidate == &target).then(|| label.clone()));
    if let Some(existing) = existing.and_then(|label| app.get_webview_window(&label)) {
        focused(&app, existing.label());
        return reveal_window(&existing);
    }
    create_window(
        &app,
        Some(&window),
        &target.space_id,
        Some(&target.note_id),
        true,
        None,
    )
    .map(|_| ())
}

async fn show_target_in_library(app: AppHandle, navigation: NoteNavigation) -> Result<(), String> {
    validate_navigation_passages(navigation.passages.as_deref())?;
    validate_saved_target(&app, &navigation.target).await?;
    let state = app.state::<DesktopWindows>();
    let _creation = state.creation.lock().await;
    ensure_not_quitting(&app)?;
    if let Some(window) = preferred_library_window(&app) {
        let ready = state
            .routing
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .route_note(window.label(), &navigation);
        if ready {
            window
                .emit("orion-open-note", &navigation)
                .map_err(|e| e.to_string())?;
        }
        focused(&app, window.label());
        reveal_window(&window)
    } else {
        let pending = navigation.passages.as_ref().map(|_| navigation.clone());
        create_window(
            &app,
            None,
            &navigation.target.space_id,
            Some(&navigation.target.note_id),
            false,
            pending,
        )
        .map(|_| ())
    }
}

#[tauri::command]
pub async fn show_note_in_library(
    app: AppHandle,
    space_id: String,
    note_id: String,
    passages: Option<Vec<NavigationPassage>>,
) -> Result<(), String> {
    show_target_in_library(
        app,
        NoteNavigation {
            target: NoteTarget { space_id, note_id },
            passages: passages.filter(|items| !items.is_empty()),
        },
    )
    .await
}

#[tauri::command]
pub fn set_library_navigation_ready(
    window: WebviewWindow,
    state: State<'_, DesktopWindows>,
    ready: bool,
) -> Result<(), String> {
    let pending = state
        .routing
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .set_navigation_ready(window.label(), ready);
    if let Some(target) = pending {
        window
            .emit("orion-open-note", target)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn citation_target(url: &tauri::Url) -> Option<NoteTarget> {
    if url.scheme() != "orion" || url.host_str() != Some("open") {
        return None;
    }
    let mut space_id = None;
    let mut note_id = None;
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "space_id" if space_id.is_none() => space_id = Some(value.trim().to_string()),
            "note_id" if note_id.is_none() => note_id = Some(value.trim().to_string()),
            "space_id" | "note_id" => return None,
            _ => {}
        }
    }
    let target = NoteTarget {
        space_id: space_id?,
        note_id: note_id?,
    };
    validate_id(&target.space_id).ok()?;
    validate_id(&target.note_id).ok()?;
    Some(target)
}

/// Existing library renderers consume the normal deep-link event. If only
/// writing windows remain, create a library with the target in its launch URL.
/// A still-loading library queues the target until its listener is ready, so no
/// citation can replace a detached draft or be lost during hydration.
pub fn install_citation_routing(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        if let Some(window) = preferred_library_window(&handle) {
            if handle
                .state::<DesktopWindows>()
                .routing
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .navigation_ready
                .contains(window.label())
            {
                return;
            }
        }
        if let Some(target) = event.urls().iter().find_map(citation_target) {
            let app = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = show_target_in_library(app, target.into()).await {
                    eprintln!("Orion couldn't open a citation: {error}");
                }
            });
        }
    });
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
    preferred_library_window(&app).is_some_and(|target| target.label() == window.label())
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
        drop(quit);
        return media_ready_to_exit(app);
    }
    let attempt = quit.begin();
    drop(quit);
    if let Some(attempt) = attempt {
        let _ = app.emit("orion-quit-requested", attempt);
    }
    false
}

/// The existing renderer/vault save handshake finishes first. Keep the event
/// loop alive while native cancellation reaps children and drops their media.
/// There is no timeout that can force an exit with an owned child still alive.
fn media_ready_to_exit(app: &AppHandle) -> bool {
    let jobs = app.state::<crate::media_jobs::MediaJobs>().inner().clone();
    let first = jobs.start_shutdown();
    if jobs.is_drained() {
        return true;
    }
    if first {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            jobs.wait_until_drained();
            app.exit(0);
        });
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
    state
        .routing
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(label);
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
    fn target(space_id: &str, note_id: &str) -> NoteTarget {
        NoteTarget {
            space_id: space_id.into(),
            note_id: note_id.into(),
        }
    }

    #[test]
    fn citations_prefer_last_library_and_never_a_writing_window() {
        let mut routing = WindowRouting::default();
        routing
            .writing
            .insert("orion-window-2".into(), target("space-a", "note-a"));
        let available = vec![
            "main".into(),
            "orion-window-1".into(),
            "orion-window-2".into(),
        ];
        routing.focus("orion-window-1");
        routing.focus("orion-window-2");
        assert_eq!(
            routing.preferred_library(&available).as_deref(),
            Some("orion-window-1")
        );
        routing.remove("orion-window-1");
        assert_eq!(
            routing
                .preferred_library(&["main".into(), "orion-window-2".into()])
                .as_deref(),
            Some("main")
        );
        assert_eq!(routing.preferred_library(&["orion-window-2".into()]), None);
    }

    #[test]
    fn navigation_waits_for_a_library_listener_and_discards_closed_targets() {
        let mut routing = WindowRouting::default();
        let first = NoteNavigation::from(target("space-a", "note-a"));
        let latest = NoteNavigation::from(target("space-a", "note-b"));
        assert!(!routing.route_note("main", &first));
        assert!(!routing.route_note("main", &latest));
        assert_eq!(
            routing.set_navigation_ready("main", true),
            Some(latest.clone())
        );
        assert_eq!(routing.set_navigation_ready("main", true), None);
        assert!(routing.route_note("main", &first));
        routing.set_navigation_ready("main", false);
        assert!(!routing.route_note("main", &latest));
        routing.remove("main");
        assert_eq!(routing.set_navigation_ready("main", true), None);
        routing
            .writing
            .insert("writing".into(), first.target.clone());
        assert_eq!(routing.set_navigation_ready("writing", true), None);
        assert!(!routing.route_note("writing", &latest));
        assert!(!routing.pending_navigation.contains_key("writing"));
    }

    fn fixture_vault() -> Value {
        serde_json::json!({"schemaVersion": 2, "spaces": [
            {"schemaVersion": 1, "workspace": {"id": "a"}, "notes": [{"id": "a-note"}]},
            {"schemaVersion": 1, "workspace": {"id": "b"}, "notes": [{"id": "b-note"}]}
        ]})
    }

    #[test]
    fn writing_targets_require_one_note_in_the_exact_space() {
        let vault = fixture_vault();
        assert!(validate_note_target(&vault, &target("a", "a-note")).is_ok());
        assert!(validate_note_target(&vault, &target("a", "b-note")).is_err());
        assert!(validate_note_target(&vault, &target("absent", "a-note")).is_err());
        assert!(validate_note_target(&vault, &target("a", "deleted")).is_err());
        let mut invalid = vault.clone();
        invalid["schemaVersion"] = serde_json::json!(3);
        assert!(validate_note_target(&invalid, &target("a", "a-note")).is_err());
        invalid = vault.clone();
        invalid["spaces"][0]["schemaVersion"] = serde_json::json!(2);
        assert!(validate_note_target(&invalid, &target("a", "a-note")).is_err());
        invalid = vault.clone();
        invalid["spaces"][0]["notes"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id": "a-note"}));
        assert!(validate_note_target(&invalid, &target("a", "a-note")).is_err());
        invalid = vault.clone();
        invalid["spaces"]
            .as_array_mut()
            .unwrap()
            .push(vault["spaces"][0].clone());
        assert!(validate_note_target(&invalid, &target("a", "a-note")).is_err());
    }

    #[test]
    fn window_ids_and_citations_are_bounded_and_unambiguous() {
        for invalid in ["", " ", "a\nb", "a\0b", &"x".repeat(513)] {
            assert!(validate_id(invalid).is_err());
        }
        let url = tauri::Url::parse("orion://open?space_id=a%26b&note_id=n%3D2").unwrap();
        assert_eq!(citation_target(&url), Some(target("a&b", "n=2")));
        for raw in [
            "https://open?space_id=a&note_id=b",
            "orion://other?space_id=a&note_id=b",
            "orion://open?space_id=a",
            "orion://open?space_id=a&note_id=",
            "orion://open?space_id=a&note_id=b&note_id=c",
            "orion://open?space_id=a%0Ab&note_id=c",
        ] {
            assert!(citation_target(&tauri::Url::parse(raw).unwrap()).is_none());
        }
        let tauri::WebviewUrl::App(path) = window_url("a&b", Some("n=2"), true) else {
            panic!("expected app URL")
        };
        let encoded =
            tauri::Url::parse(&format!("http://localhost/{}", path.to_string_lossy())).unwrap();
        let pairs: HashMap<_, _> = encoded.query_pairs().collect();
        assert_eq!(pairs.get("space").map(|value| value.as_ref()), Some("a&b"));
        assert_eq!(pairs.get("note").map(|value| value.as_ref()), Some("n=2"));
        assert_eq!(
            pairs.get("view").map(|value| value.as_ref()),
            Some("writing")
        );
    }
    #[test]
    fn excerpt_navigation_preserves_exact_locators_until_library_ready() {
        let passages: Vec<NavigationPassage> = serde_json::from_value(serde_json::json!([
            {"from": 3, "to": 15, "text": "Exact words."},
            {"locator": "unique-text", "text": "Another exact passage."}
        ]))
        .unwrap();
        assert!(validate_navigation_passages(Some(&passages)).is_ok());
        let navigation = NoteNavigation {
            target: target("a", "a-note"),
            passages: Some(passages),
        };
        let mut routing = WindowRouting::default();
        assert!(!routing.route_note("library", &navigation));
        assert_eq!(
            routing.set_navigation_ready("library", true),
            Some(navigation.clone())
        );
        let value = serde_json::to_value(&navigation).unwrap();
        assert_eq!(value["spaceId"], "a");
        assert_eq!(value["noteId"], "a-note");
        assert_eq!(value["passages"][0]["from"], 3);
        assert_eq!(value["passages"][1]["locator"], "unique-text");
        let tauri::WebviewUrl::App(path) = window_url("a", Some("a-note"), false) else {
            panic!("expected app URL")
        };
        assert!(!path.to_string_lossy().contains("passage"));
        assert!(!path.to_string_lossy().contains("Exact"));
    }

    #[test]
    fn excerpt_navigation_rejects_unbounded_or_invalid_locators() {
        let text = NavigationPassage::Text(NavigationText {
            locator: TextLocator::UniqueText,
            text: "passage".into(),
        });
        assert!(validate_navigation_passages(Some(&vec![text.clone(); 16])).is_ok());
        assert!(validate_navigation_passages(Some(&vec![text; 17])).is_err());
        for (from, to) in [(3, 2), (0, 9_007_199_254_740_992)] {
            assert!(
                validate_navigation_passages(Some(&[NavigationPassage::Range(NavigationRange {
                    from,
                    to,
                    text: "a".into()
                })]))
                .is_err()
            );
        }
        let too_long = NavigationPassage::Text(NavigationText {
            locator: TextLocator::UniqueText,
            text: "😀".repeat(16_001),
        });
        assert!(validate_navigation_passages(Some(&[too_long])).is_err());
        for invalid in [
            serde_json::json!({"from": -1, "to": 1, "text": "x"}),
            serde_json::json!({"from": 0.5, "to": 1, "text": "x"}),
            serde_json::json!({"locator": "text", "text": "x"}),
            serde_json::json!({"locator": "unique-text", "text": "x", "from": 0}),
            serde_json::json!({"from": 0, "to": 1, "text": "x", "path": "/tmp/file"}),
        ] {
            assert!(serde_json::from_value::<NavigationPassage>(invalid).is_err());
        }
    }
}
