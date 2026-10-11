//! Transient window-owned editor mailbox. No provider calls, note writes or surrounding prose.
use crate::{
    assistant_bridge::{self, AssistantBridge},
    editor_context_protocol::{
        self as protocol, EditorContextLookup, EditorContextReference, EditorContextRequest,
        ReferenceState,
    },
};
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, State, WebviewWindow};
const MAX_PENDING: usize = 8;
const MAX_TARGETS: usize = 64;
const LEASE: Duration = Duration::from_secs(30);
const DEADLINE: Duration = Duration::from_millis(protocol::REQUEST_TIMEOUT_MS);
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorSurface {
    space_id: String,
    note_id: String,
    ready: bool,
}
#[derive(Clone)]
struct Target {
    id: String,
    window: String,
    session: String,
    surface: EditorSurface,
    seen: Instant,
}
struct Entry {
    request: EditorContextRequest,
    target: Target,
    started: Instant,
    delivered: bool,
    reference: Option<EditorContextReference>,
}
#[derive(Default)]
struct Mailbox {
    targets: HashMap<String, Target>,
    sessions: HashMap<String, String>,
    retired: HashMap<String, HashSet<String>>,
    entries: HashMap<String, Entry>,
}
#[derive(Clone)]
pub(crate) struct EditorContextStore {
    path: PathBuf,
    state: Arc<Mutex<Mailbox>>,
}
fn allowed(vault: &Value, space_id: &str) -> Result<(), String> {
    assistant_bridge::space(vault, space_id)?;
    let a = assistant_bridge::access(vault)?;
    if !a.enabled || !a.space_ids.iter().any(|id| id == space_id) {
        return Err("Enable desktop workflows for this exact Space in Orion Settings → Connections. Editor reads require neither AI nor write permission.".into());
    }
    Ok(())
}
fn note<'a>(vault: &'a Value, space_id: &str, note_id: &str) -> Result<&'a Value, String> {
    let notes = assistant_bridge::space(vault, space_id)?["notes"]
        .as_array()
        .ok_or("The Space has no valid note directory.")?;
    let mut matches = notes.iter().filter(|n| n["id"].as_str() == Some(note_id));
    let n = matches
        .next()
        .ok_or("The exact note is no longer in this Space.")?;
    if matches.next().is_some() {
        return Err("The note ID is ambiguous in this Space.".into());
    }
    Ok(n)
}
fn sweep(state: &mut Mailbox, vault: &Value) {
    state.targets.retain(|_, t| {
        t.seen.elapsed() <= LEASE
            && allowed(vault, &t.surface.space_id).is_ok()
            && note(vault, &t.surface.space_id, &t.surface.note_id).is_ok()
    });
    state.entries.retain(|_, e| {
        e.started.elapsed() < DEADLINE
            && state
                .targets
                .get(&e.target.window)
                .is_some_and(|t| t.id == e.target.id && t.session == e.target.session)
    });
}
impl EditorContextStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Arc::new(Mutex::new(Mailbox::default())),
        }
    }
    fn locked<T>(
        &self,
        work: impl FnOnce(&mut Mailbox, &Value) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The editor context mailbox was interrupted.")?;
        let file = crate::vault_lock_file(&self.path)?;
        FileExt::lock_shared(&file).map_err(|_| "The library is busy.")?;
        let vault = crate::read_vault_file(&self.path)?
            .ok_or("Open Orion once to create its local library.")?;
        if vault["schemaVersion"].as_u64() != Some(2) {
            return Err("The library has an invalid schema.".into());
        }
        sweep(&mut state, &vault);
        work(&mut state, &vault)
    }
    pub(crate) fn capabilities(&self) -> Result<Value, String> {
        self.locked(|state, vault| {
            let mut targets = Vec::new();
            for t in state.targets.values() {
                let n = note(vault, &t.surface.space_id, &t.surface.note_id)?;
                targets.push(json!({
                    "id": t.id, "spaceId": t.surface.space_id, "noteId": t.surface.note_id,
                    "title": n["title"].as_str().unwrap_or("").chars().take(240).collect::<String>(),
                    "ready": t.surface.ready
                }));
            }
            targets.sort_by_key(|v| v["id"].as_str().unwrap_or("").to_owned());
            Ok(json!({
                "editorTargets": targets,
                "editorContextLimits": {
                    "maxChars": protocol::MAX_CHARS, "maxFragments": protocol::MAX_FRAGMENTS,
                    "pending": MAX_PENDING, "timeoutMs": protocol::REQUEST_TIMEOUT_MS, "providerCalls": 0
                }
            }))
        })
    }
    pub(crate) fn handle(&self, method: &str, args: Value) -> Result<Value, String> {
        match method {
            "editor_context_request" => {
                let request: EditorContextRequest = serde_json::from_value(args)
                    .map_err(|_| "The editor context request has an invalid schema.")?;
                request.validate()?;
                self.locked(|state, vault| {
                    allowed(vault, &request.space_id)?;
                    let target = state.targets.values().find(|t| {
                        t.id == request.editor_target_id && t.surface.space_id == request.space_id
                    }).cloned().ok_or("That editor target is no longer available. Refresh Orion's capabilities.")?;
                    if state.entries.len() >= MAX_PENDING {
                        return Err("Eight editor reads are pending. Wait briefly and retry.".into());
                    }
                    let id = format!("editor_read_{}", assistant_bridge::random_token()?);
                    state.entries.insert(id.clone(), Entry {
                        request, target, started: Instant::now(), delivered: false, reference: None,
                    });
                    Ok(json!({"id": id, "state": "pending"}))
                })
            }
            "editor_context_get" => {
                let lookup: EditorContextLookup = serde_json::from_value(args)
                    .map_err(|_| "The editor context lookup has an invalid schema.")?;
                lookup.validate()?;
                self.locked(|state, vault| {
                    allowed(vault, &lookup.space_id)?;
                    let entry = state.entries.get(&lookup.request_id)
                        .filter(|e| e.request.space_id == lookup.space_id)
                        .ok_or("The editor read expired or its window changed. Read the current target again.")?;
                    let Some(reference) = &entry.reference else {
                        return Ok(json!({"state": "pending"}));
                    };
                    if matches!(reference.state, ReferenceState::Selected | ReferenceState::Cursor)
                        && state.targets.get(&entry.target.window).is_none_or(|t| !t.surface.ready) {
                        state.entries.remove(&lookup.request_id);
                        return Err("The editor became unavailable. Read its current target again.".into());
                    }
                    let mut context = serde_json::to_value(reference)
                        .map_err(|_| "Cannot encode editor context.")?;
                    context["referenceOnly"] = json!(true);
                    context["spaceId"] = json!(entry.request.space_id);
                    context["noteId"] = json!(entry.target.surface.note_id);
                    context["editorTargetId"] = json!(entry.target.id);
                    context["taskView"] = json!(entry.request.task_view);
                    state.entries.remove(&lookup.request_id); // One use; no text receipt or history.
                    Ok(json!({"state": "ready", "context": context}))
                })
            }
            _ => Err("Unknown editor context method.".into()),
        }
    }
    pub(crate) fn poll(
        &self,
        window: &str,
        session: &str,
        surface: Option<EditorSurface>,
    ) -> Result<Value, String> {
        protocol::identifier(session, 128)?;
        if let Some(s) = &surface {
            protocol::identifier(&s.space_id, 200)?;
            protocol::identifier(&s.note_id, 200)?;
        }
        self.locked(|state, vault| {
            let retired = state.retired.get(window).is_some_and(|s| s.contains(session));
            let stale_disposal = surface.is_none()
                && state.sessions.get(window).is_none_or(|s| s != session);
            if retired || stale_disposal {
                return Ok(json!({"targetId": null, "requests": []}));
            }
            if let Some(old) = state.sessions.get(window).filter(|s| *s != session) {
                let retired = state.retired.entry(window.into()).or_default();
                if retired.len() >= 128 {
                    return Err("This editor window restarted too often. Close and reopen it before another editor read.".into());
                }
                retired.insert(old.clone());
            }
            if !state.sessions.contains_key(window) && state.sessions.len() >= MAX_TARGETS {
                return Err("Too many editor sessions.".into());
            }
            state.sessions.insert(window.into(), session.into());
            let keep = surface.as_ref().is_some_and(|s| {
                state.targets.get(window).is_some_and(|t| {
                    t.session == session && t.surface.space_id == s.space_id && t.surface.note_id == s.note_id
                })
            });
            if !keep { state.targets.remove(window); }
            if let Some(surface) = surface {
                if allowed(vault, &surface.space_id).is_ok()
                    && note(vault, &surface.space_id, &surface.note_id).is_ok() {
                    if let Some(t) = state.targets.get_mut(window) {
                        t.surface.ready = surface.ready;
                        t.seen = Instant::now();
                    } else {
                        state.targets.insert(window.into(), Target {
                            id: format!("editor_target_{}", assistant_bridge::random_token()?),
                            window: window.into(), session: session.into(), surface, seen: Instant::now(),
                        });
                    }
                } else { state.targets.remove(window); }
            }
            sweep(state, vault);
            let target = state.targets.get(window).filter(|t| t.session == session);
            let mut requests = Vec::new();
            for (id, e) in state.entries.iter_mut() {
                if e.target.window == window && e.target.session == session && e.reference.is_none() {
                    e.delivered = true;
                    requests.push(json!({
                        "id": id, "targetId": e.target.id, "spaceId": e.request.space_id,
                        "noteId": e.target.surface.note_id, "taskView": e.request.task_view,
                        "maxChars": e.request.max_chars
                    }));
                }
            }
            Ok(json!({"targetId": target.map(|t| &t.id), "requests": requests}))
        })
    }
    pub(crate) fn respond(
        &self,
        window: &str,
        session: &str,
        id: &str,
        target_id: &str,
        reference: EditorContextReference,
    ) -> Result<Value, String> {
        protocol::identifier(session, 128)?;
        protocol::identifier(id, 200)?;
        protocol::identifier(target_id, 200)?;
        self.locked(|state, _| {
            let entry = state
                .entries
                .get_mut(id)
                .filter(|e| {
                    e.target.window == window
                        && e.target.session == session
                        && e.target.id == target_id
                        && e.delivered
                })
                .ok_or("This editor read expired or belongs to a different window or target.")?;
            if entry.reference.is_some() {
                return Err("This editor read already has its response.".into());
            }
            reference.validate(&entry.request)?;
            if state.targets.get(window).is_none_or(|t| !t.surface.ready)
                && matches!(
                    reference.state,
                    ReferenceState::Selected | ReferenceState::Cursor
                )
            {
                return Err("This editor is temporarily unavailable for a text reference.".into());
            }
            entry.reference = Some(reference);
            Ok(json!({"ok":true}))
        })
    }
    // The private socket loop calls this without touching the vault, including
    // when a caller abandons a read. Expired text is not retained until a later read.
    pub(crate) fn expire(&self) {
        if let Ok(mut s) = self.state.lock() {
            s.entries.retain(|_, e| e.started.elapsed() < DEADLINE);
            s.targets.retain(|_, t| t.seen.elapsed() <= LEASE);
        }
    }
    pub(crate) fn close_window(&self, window: &str) {
        if let Ok(mut s) = self.state.lock() {
            s.targets.remove(window);
            s.sessions.remove(window);
            s.retired.remove(window);
            s.entries.retain(|_, e| e.target.window != window);
        }
    }
}
#[tauri::command]
pub fn editor_context_poll(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    target: Option<EditorSurface>,
) -> Result<Value, String> {
    if let Some(t) = &target {
        if !crate::desktop_windows::review_target_matches(
            window.app_handle(),
            window.label(),
            &t.space_id,
            &t.note_id,
        ) {
            return Err("That note is not owned by this editor window.".into());
        }
    }
    bridge
        .editor_context
        .poll(window.label(), &session_id, target)
}
#[tauri::command]
pub fn editor_context_respond(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    target_id: String,
    reference: EditorContextReference,
) -> Result<Value, String> {
    bridge
        .editor_context
        .respond(window.label(), &session_id, &id, &target_id, reference)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"schemaVersion":2,"activeSpaceId":"a","updatedAt":"1","spaces":[{"schemaVersion":1,"workspace":{"id":"a"},"notes":[{"id":"n","title":"Open draft","body":"Persisted only, not the unsaved selection."},{"id":"other","title":"Another note","body":"Other"}],"settings":{"assistantAccess":{"enabled":true,"allowAI":false,"allowWrites":false,"spaceIds":["a"]}}},{"schemaVersion":1,"workspace":{"id":"b"},"notes":[{"id":"n","title":"Foreign","body":"Never expose"}],"settings":{}}]})
    }
    fn store() -> (tempfile::TempDir, EditorContextStore) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("vault.json");
        crate::write_vault_file(&p, &fixture()).unwrap();
        (d, EditorContextStore::new(p))
    }
    fn surface(ready: bool) -> Option<EditorSurface> {
        Some(EditorSurface {
            space_id: "a".into(),
            note_id: "n".into(),
            ready,
        })
    }
    fn register(s: &EditorContextStore) -> String {
        s.poll("main", "session", surface(true)).unwrap()["targetId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn start(s: &EditorContextStore, target: &str) -> String {
        s.handle(
            "editor_context_request",
            json!({"space_id":"a","editor_target_id":target}),
        )
        .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn get(s: &EditorContextStore, id: &str) -> Result<Value, String> {
        s.handle(
            "editor_context_get",
            json!({"space_id":"a","request_id":id}),
        )
    }
    fn reference() -> EditorContextReference {
        serde_json::from_value(json!({"state":"selected","documentVersion":"displayed-v1:unsaved","selection":{"coordinateSystem":"dom-text-utf16","from":2,"to":5},"fragments":[{"text":"🧭a","from":2,"to":5}],"truncated":false,"omittedChars":0,"completedTasksOmitted":false,"completedTaskChars":0})).unwrap()
    }
    fn unavailable() -> EditorContextReference {
        serde_json::from_value(json!({"state":"unavailable","reason":"flow","fragments":[],"truncated":false,"omittedChars":0,"completedTasksOmitted":false,"completedTaskChars":0})).unwrap()
    }
    fn change(s: &EditorContextStore, edit: impl FnOnce(&mut Value)) {
        let mut v = crate::read_vault_file(&s.path).unwrap().unwrap();
        edit(&mut v);
        crate::write_vault_file(&s.path, &v).unwrap();
    }
    #[test]
    fn editor_context_read_grant_needs_no_ai_or_write_permission_and_never_writes() {
        let (_d, s) = store();
        let before = std::fs::read(&s.path).unwrap();
        let target = register(&s);
        let caps = s.capabilities().unwrap();
        assert_eq!(caps["editorTargets"][0]["id"], target);
        assert!(caps.to_string().find("Persisted only").is_none());
        assert!(caps.to_string().find("Version").is_none());
        let id = start(&s, &target);
        assert_eq!(get(&s, &id).unwrap()["state"], "pending");
        assert!(
            s.respond("main", "session", &id, &target, reference())
                .is_err(),
            "Must deliver the request first"
        );
        let poll = s.poll("main", "session", surface(true)).unwrap();
        assert_eq!(poll["requests"][0]["id"], id);
        assert!(!poll.to_string().contains("Persisted only"));
        s.respond("main", "session", &id, &target, reference())
            .unwrap();
        let r = get(&s, &id).unwrap();
        assert_eq!(r["context"]["referenceOnly"], true);
        assert_eq!(r["context"]["documentVersion"], "displayed-v1:unsaved");
        assert_eq!(r["context"]["fragments"][0]["text"], "🧭a");
        assert_eq!(r["context"]["noteId"], "n");
        assert!(r["context"].get("expected_version").is_none());
        assert!(get(&s, &id).is_err());
        assert!(s.state.lock().unwrap().entries.is_empty());
        assert_eq!(std::fs::read(&s.path).unwrap(), before);
    }
    #[test]
    fn editor_context_exact_space_window_target_and_session_are_required() {
        let (_d, s) = store();
        let target = register(&s);
        let id = start(&s, &target);
        s.poll("main", "session", surface(true)).unwrap();
        assert!(s
            .handle(
                "editor_context_request",
                json!({"space_id":"b","editor_target_id":target})
            )
            .is_err());
        assert!(s
            .handle(
                "editor_context_get",
                json!({"space_id":"b","request_id":id})
            )
            .is_err());
        for (window, session, t) in [
            ("other", "session", target.as_str()),
            ("main", "other", target.as_str()),
            ("main", "session", "invented"),
        ] {
            assert!(s.respond(window, session, &id, t, reference()).is_err());
        }
        s.respond("main", "session", &id, &target, reference())
            .unwrap();
        assert!(s
            .respond("main", "session", &id, &target, reference())
            .is_err());
    }
    #[test]
    fn editor_context_session_aba_and_old_disposal_cannot_remove_new_target() {
        let (_d, s) = store();
        let old = register(&s);
        let fresh = s.poll("main", "new-session", surface(true)).unwrap()["targetId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_ne!(old, fresh);
        let id = start(&s, &fresh);
        s.poll("main", "session", None).unwrap();
        s.poll("main", "session", surface(true)).unwrap();
        assert_eq!(s.capabilities().unwrap()["editorTargets"][0]["id"], fresh);
        assert_eq!(get(&s, &id).unwrap()["state"], "pending");
        assert_eq!(
            s.poll("main", "new-session", surface(true)).unwrap()["requests"][0]["id"],
            id
        );
    }
    #[test]
    fn editor_context_busy_target_stays_discoverable_but_only_returns_unavailable() {
        let (_d, s) = store();
        let target = register(&s);
        let id = start(&s, &target);
        assert_eq!(
            s.poll("main", "session", surface(false)).unwrap()["targetId"],
            target
        );
        assert_eq!(
            s.capabilities().unwrap()["editorTargets"][0]["ready"],
            false
        );
        assert!(s
            .respond("main", "session", &id, &target, reference())
            .is_err());
        s.respond("main", "session", &id, &target, unavailable())
            .unwrap();
        assert_eq!(get(&s, &id).unwrap()["context"]["state"], "unavailable");
        assert_eq!(
            s.poll("main", "session", surface(true)).unwrap()["targetId"],
            target
        );
    }
    #[test]
    fn editor_context_busy_after_response_does_not_release_stale_text() {
        let (_d, s) = store();
        let target = register(&s);
        let id = start(&s, &target);
        s.poll("main", "session", surface(true)).unwrap();
        s.respond("main", "session", &id, &target, reference())
            .unwrap();
        s.poll("main", "session", surface(false)).unwrap();
        assert!(get(&s, &id).is_err());
        assert!(s.state.lock().unwrap().entries.is_empty());
    }
    #[test]
    fn editor_context_navigation_close_revocation_and_ambiguous_note_destroy_queued_text() {
        for case in ["navigate", "close", "revoke", "duplicate", "delete"] {
            let (_d, s) = store();
            let t = register(&s);
            let id = start(&s, &t);
            s.poll("main", "session", surface(true)).unwrap();
            s.respond("main", "session", &id, &t, reference()).unwrap();
            match case {
                "navigate" => {
                    s.poll(
                        "main",
                        "session",
                        Some(EditorSurface {
                            space_id: "a".into(),
                            note_id: "other".into(),
                            ready: true,
                        }),
                    )
                    .unwrap();
                }
                "close" => s.close_window("main"),
                "revoke" => change(&s, |v| {
                    v["spaces"][0]["settings"]["assistantAccess"]["enabled"] = json!(false)
                }),
                "duplicate" => change(&s, |v| {
                    let n = v["spaces"][0]["notes"][0].clone();
                    v["spaces"][0]["notes"].as_array_mut().unwrap().push(n)
                }),
                "delete" => change(&s, |v| {
                    v["spaces"][0]["notes"].as_array_mut().unwrap().remove(0);
                }),
                _ => unreachable!(),
            }
            assert!(get(&s, &id).is_err(), "{case}");
            assert!(s.state.lock().unwrap().entries.is_empty(), "{case}");
            assert!(s.respond("main", "session", &id, &t, reference()).is_err());
        }
    }
    #[test]
    fn editor_context_timeouts_drop_text_and_pending_queue_is_bounded() {
        let (_d, s) = store();
        let t = register(&s);
        let id = start(&s, &t);
        s.poll("main", "session", surface(true)).unwrap();
        s.respond("main", "session", &id, &t, reference()).unwrap();
        s.state
            .lock()
            .unwrap()
            .entries
            .get_mut(&id)
            .unwrap()
            .started = Instant::now() - DEADLINE;
        s.expire();
        assert!(s.state.lock().unwrap().entries.is_empty());
        assert!(get(&s, &id).is_err());
        assert!(s.respond("main", "session", &id, &t, reference()).is_err());
        for _ in 0..MAX_PENDING {
            start(&s, &t);
        }
        assert!(s
            .handle(
                "editor_context_request",
                json!({"space_id":"a","editor_target_id":t})
            )
            .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn editor_context_real_private_socket_is_authenticated_nonblocking_and_read_only() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;
        let (d, s) = store();
        let bridge = AssistantBridge::new(s.path.clone());
        let target = register(&bridge.editor_context);
        bridge.start().unwrap();
        let descriptor: Value = serde_json::from_slice(
            &std::fs::read(d.path().join(crate::assistant_protocol::BRIDGE_DESCRIPTOR)).unwrap(),
        )
        .unwrap();
        let call = |method: &str, args: Value, token: &str| -> Value {
            let mut stream =
                UnixStream::connect(descriptor["socket_path"].as_str().unwrap()).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            serde_json::to_writer(
                &mut stream,
                &json!({"version":1,"token":token,"method":method,"arguments":args}),
            )
            .unwrap();
            stream.write_all(b"\n").unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };
        let token = descriptor["token"].as_str().unwrap();
        let before = std::fs::read(&s.path).unwrap();
        assert_eq!(call("capabilities", json!({}), "wrong")["ok"], false);
        let caps = call("capabilities", json!({}), token);
        assert_eq!(caps["result"]["available"], true);
        assert_eq!(caps["result"]["workflowExecutorAvailable"], false);
        assert_eq!(caps["result"]["editorTargets"][0]["id"], target);
        let read = call(
            "editor_context_request",
            json!({"space_id":"a","editor_target_id":target}),
            token,
        );
        let id = read["result"]["id"].as_str().unwrap();
        let elapsed = Instant::now();
        assert_eq!(
            call(
                "editor_context_get",
                json!({"space_id":"a","request_id":id}),
                token
            )["result"]["state"],
            "pending"
        );
        assert_eq!(call("capabilities", json!({}), token)["ok"], true);
        assert!(
            elapsed.elapsed() < Duration::from_secs(1),
            "Renderer wait blocked native socket"
        );
        bridge
            .editor_context
            .poll("main", "session", surface(true))
            .unwrap();
        bridge
            .editor_context
            .respond("main", "session", id, &target, reference())
            .unwrap();
        assert_eq!(
            call(
                "editor_context_get",
                json!({"space_id":"a","request_id":id}),
                token
            )["result"]["context"]["fragments"][0]["text"],
            "🧭a"
        );
        assert_eq!(std::fs::read(&s.path).unwrap(), before);
    }
}
