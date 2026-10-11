//! Native-owned finite rich-editor actions. No automatic edits, provider calls or vault writes.
use crate::{
    assistant_bridge::{self, AssistantBridge},
    editor_actions_protocol::{
        self as protocol, ActionStage, ActionState, CaptureRequest, EditorAction,
        EditorActionGrant, ImageContext, ImageQuality, LookupRequest, Receipt, RichRange,
        SavedResult, StartRequest,
    },
    note_version,
};
use fs2::FileExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, State, WebviewWindow};
const MAX_PENDING: usize = 8;
const MAX_RECEIPTS: usize = 32;
const MAX_TARGETS: usize = 64;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const LEASE: Duration = Duration::from_secs(30);
const CAPTURE_DEADLINE: Duration = Duration::from_millis(protocol::REQUEST_TIMEOUT_MS);
const ACTION_DEADLINE: Duration = Duration::from_secs(20 * 60);
const RETENTION: Duration = Duration::from_secs(60 * 60);
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorActionSurface {
    space_id: String,
    note_id: String,
    ready: bool,
    document_version: String,
    selection_version: String,
}
#[derive(Clone)]
struct Target {
    id: String,
    window: String,
    session: String,
    surface: EditorActionSurface,
    seen: Instant,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorCapture {
    document_version: String,
    selection_version: String,
    selection: RichRange,
    effective_target: RichRange,
    base_note: Value,
    captured_body: String,
}
struct Entry {
    receipt: Receipt,
    request: CaptureRequest,
    start_request: Option<StartRequest>,
    target: Target,
    base_note: Option<Value>,
    base_version: String,
    captured_body: Option<String>,
    accepted_body: Option<String>,
    delivered: bool,
    started: Instant,
    touched: Instant,
}
#[derive(Default)]
struct Mailbox {
    targets: HashMap<String, Target>,
    sessions: HashMap<String, (String, Instant)>,
    retired: HashMap<String, HashSet<String>>,
    entries: HashMap<String, Entry>,
    order: VecDeque<String>,
}
#[derive(Clone)]
pub(crate) struct EditorActionsStore {
    path: PathBuf,
    state: Arc<Mutex<Mailbox>>,
}
fn allowed(vault: &Value, space_id: &str, generation: bool) -> Result<(), String> {
    assistant_bridge::space(vault, space_id)?;
    let a = assistant_bridge::access(vault)?;
    if !a.enabled || !a.space_ids.iter().any(|s| s == space_id) {
        return Err(
            "Enable desktop workflows for this exact Space in Orion Settings → Connections.".into(),
        );
    }
    if generation && (!a.allow_ai || !a.allow_writes) {
        return Err("Editor generation requires both AI and workflow-write permission. Acceptance remains local.".into());
    }
    Ok(())
}
fn note<'a>(vault: &'a Value, space: &str, id: &str) -> Result<&'a Value, String> {
    let notes = assistant_bridge::space(vault, space)?["notes"]
        .as_array()
        .ok_or("Invalid note directory.")?;
    let mut m = notes.iter().filter(|n| n["id"].as_str() == Some(id));
    let n = m
        .next()
        .ok_or("The exact note is no longer in this Space.")?;
    if m.next().is_some() {
        return Err("The note identity is ambiguous.".into());
    }
    note_version::note_version(n)?;
    Ok(n)
}
fn text<'a>(n: &'a Value, key: &str) -> &'a str {
    n[key].as_str().unwrap_or("")
}
// An autosave of the captured unsaved body may advance updatedAt, but no other
// versioned field. It cannot turn an externally edited title/tag/source into consent.
fn equivalent_after_autosave(current: &Value, base: &Value, captured: &str) -> bool {
    if text(current, "body") != captured {
        return false;
    }
    let mut n = current.clone();
    n["body"] = base["body"].clone();
    n["updatedAt"] = base["updatedAt"].clone();
    note_version::note_version(&n).ok() == note_version::note_version(base).ok()
}
fn fresh(vault: &Value, e: &Entry) -> Result<(), String> {
    allowed(vault, &e.receipt.space_id, true)?;
    let n = note(vault, &e.receipt.space_id, &e.receipt.note_id)?;
    if note_version::note_version(n)? != e.base_version
        && !e
            .base_note
            .as_ref()
            .zip(e.captured_body.as_deref())
            .is_some_and(|(base, body)| equivalent_after_autosave(n, base, body))
    {
        return Err(
            "The stored note changed beyond the captured draft. Capture this editor again.".into(),
        );
    }
    if e.receipt.action.uses_space_context()
        && assistant_bridge::space(vault, &e.receipt.space_id)?["settings"]
            ["includeExistingNotesInAIContext"]
            != json!(true)
    {
        return Err("Related-Space context is disabled in Orion Settings.".into());
    }
    Ok(())
}
fn end(e: &mut Entry, state: ActionState, error: Option<String>) {
    e.receipt.state = state;
    e.receipt.error = error;
    e.receipt.updated_at = assistant_bridge::now();
    e.touched = Instant::now();
    if !e.receipt.state.pending() {
        e.base_note = None;
        e.captured_body = None;
        e.accepted_body = None;
    }
}
fn owner_lost(e: &mut Entry, message: &str) {
    let s = match e.receipt.state {
        ActionState::AcceptedInEditor => ActionState::SaveFailed,
        ActionState::Accepting => ActionState::Failed,
        _ => ActionState::Stale,
    };
    end(e, s, Some(message.into()));
}
fn sweep_time(s: &mut Mailbox) {
    s.targets.retain(|_, t| t.seen.elapsed() <= LEASE);
    for e in s.entries.values_mut().filter(|e| e.receipt.state.pending()) {
        let before = e.receipt.state.before_decision();
        let owner = if before {
            s.targets
                .get(&e.target.window)
                .is_some_and(|t| t.id == e.target.id && t.session == e.target.session)
        } else {
            s.sessions
                .get(&e.target.window)
                .is_some_and(|(session, seen)| {
                    session == &e.target.session && seen.elapsed() <= LEASE
                })
        };
        if !owner {
            owner_lost(
                e,
                "The editor owner disconnected or changed note. No saved result was confirmed.",
            );
            continue;
        }
        if e.started.elapsed() > ACTION_DEADLINE {
            owner_lost(
                e,
                "The editor action reached its 20-minute limit. No saved result was confirmed.",
            );
            continue;
        }
        if e.receipt.state == ActionState::CapturePending && e.started.elapsed() > CAPTURE_DEADLINE
        {
            end(
                e,
                ActionState::Failed,
                Some("The editor did not capture the target within three seconds.".into()),
            );
            continue;
        }
        if e.receipt.state == ActionState::Captured && e.touched.elapsed() > LEASE {
            end(
                e,
                ActionState::Stale,
                Some("This unused capture expired after thirty seconds.".into()),
            );
            continue;
        }
        if before {
            if let Some(t) = s.targets.get(&e.target.window) {
                let changed = t.surface.document_version != e.target.surface.document_version;
                let unclaimed = matches!(
                    e.receipt.state,
                    ActionState::CapturePending | ActionState::Captured | ActionState::Submitted
                );
                if changed
                    || (unclaimed
                        && (!t.surface.ready
                            || t.surface.selection_version != e.target.surface.selection_version))
                {
                    end(
                        e,
                        ActionState::Stale,
                        Some(
                            "The captured document, selection or editor availability changed."
                                .into(),
                        ),
                    );
                }
            }
        }
    }
    s.entries
        .retain(|_, e| e.receipt.state.pending() || e.touched.elapsed() <= RETENTION);
    s.order.retain(|id| s.entries.contains_key(id));
}
fn sweep(s: &mut Mailbox, v: &Value) {
    sweep_time(s);
    for e in s
        .entries
        .values_mut()
        .filter(|e| e.receipt.state.before_decision())
    {
        // The in-flight capture response may attest an exact unsaved draft that
        // autosaved since this request. Validate that body before rejecting it.
        let result = if e.receipt.state == ActionState::CapturePending {
            allowed(v, &e.receipt.space_id, true)
                .and_then(|_| note(v, &e.receipt.space_id, &e.receipt.note_id).map(|_| ()))
        } else {
            fresh(v, e)
        };
        if let Err(error) = result {
            end(e, ActionState::Stale, Some(error));
        }
    }
}
fn validate_stage(e: &Entry, stage: ActionStage) -> Result<(), String> {
    let valid = match stage {
        ActionStage::ImageSaving => {
            e.receipt.state == ActionState::Accepting
                && matches!(e.receipt.action, EditorAction::Image { .. })
        }
        ActionStage::Writing => {
            e.receipt.state == ActionState::Generating
                && !matches!(e.receipt.action, EditorAction::Image { .. })
        }
        ActionStage::ImagePlanning | ActionStage::ImageRendering => {
            e.receipt.state == ActionState::Generating
                && matches!(e.receipt.action, EditorAction::Image { .. })
        }
        ActionStage::Publish => e.receipt.state == ActionState::Generating,
    };
    if valid {
        Ok(())
    } else {
        Err("The native editor grant does not authorize this action stage.".into())
    }
}
fn encoded(r: &Receipt) -> Result<Value, String> {
    r.validate()?;
    serde_json::to_value(r).map_err(|_| "Cannot encode editor receipt.".into())
}
fn retained(s: &Mailbox) -> usize {
    s.entries
        .values()
        .map(|e| {
            e.base_note
                .as_ref()
                .and_then(|n| serde_json::to_vec(n).ok())
                .map_or(0, |v| v.len())
                + e.captured_body.as_ref().map_or(0, String::len)
                + e.accepted_body.as_ref().map_or(0, String::len)
        })
        .sum()
}
impl EditorActionsStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Arc::new(Mutex::new(Mailbox::default())),
        }
    }
    fn locked<T>(
        &self,
        f: impl FnOnce(&mut Mailbox, &Value) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut s = self
            .state
            .lock()
            .map_err(|_| "The editor action mailbox was interrupted.")?;
        let file = crate::vault_lock_file(&self.path)?;
        FileExt::lock_shared(&file).map_err(|_| "The library is busy.")?;
        let v =
            crate::read_vault_file(&self.path)?.ok_or("Open Orion once to create its library.")?;
        if v["schemaVersion"] != json!(2) {
            return Err("Invalid library schema.".into());
        }
        sweep(&mut s, &v);
        f(&mut s, &v)
    }
    pub(crate) fn capabilities(&self) -> Result<Value, String> {
        self.locked(|s,v|{
let mut targets=s.targets.values().filter(|t|allowed(v,&t.surface.space_id,true).is_ok()).map(|t|json!({
"id":t.id,"spaceId":t.surface.space_id,"noteId":t.surface.note_id,"ready":t.surface.ready&&!s.entries.values().any(|e|e.target.id==t.id&&e.receipt.state.pending())}
)).collect::<Vec<_>>();
targets.sort_by_key(|t|t["id"].as_str().unwrap_or("").to_owned());
Ok(json!({
"editorActionTargets":targets,"editorActionLimits":{
"pending":MAX_PENDING,"retained":MAX_RECEIPTS,"captureTimeoutMs":protocol::REQUEST_TIMEOUT_MS,"captureLeaseSeconds":30,"instructionChars":protocol::MAX_INSTRUCTION_CHARS,"localAcceptanceRequired":true}
}
))}
)
    }
    pub(crate) fn handle(&self, method: &str, args: Value) -> Result<Value, String> {
        match method {
            "editor_action_capture" => {
                let r: CaptureRequest =
                    serde_json::from_value(args).map_err(|_| "Invalid editor capture schema.")?;
                r.validate()?;
                self.submit_capture(r)
            }
            "editor_action_start" => {
                let r: StartRequest =
                    serde_json::from_value(args).map_err(|_| "Invalid editor start schema.")?;
                r.validate()?;
                self.start(r)
            }
            "editor_action_get" | "editor_action_cancel" => {
                let r: LookupRequest =
                    serde_json::from_value(args).map_err(|_| "Invalid editor lookup schema.")?;
                r.validate()?;
                self.locked(|s, v| {
                    allowed(v, &r.space_id, false)?;
                    let e = s
                        .entries
                        .get_mut(&r.action_id)
                        .filter(|e| e.receipt.space_id == r.space_id)
                        .ok_or("This action is not retained in the exact Space.")?;
                    if method == "editor_action_cancel" {
                        if matches!(
                            e.receipt.state,
                            ActionState::Accepting | ActionState::AcceptedInEditor | ActionState::Saved | ActionState::SaveFailed
                        ) {
                            return Err("Local acceptance has already been claimed. Cancellation cannot undo an accepted editor change.".into());
                        }
                        if e.receipt.state.before_decision() {
                            end(e, ActionState::Cancelled, None);
                        }
                    }
                    encoded(&e.receipt)
                })
            }
            _ => Err("Unknown editor action method.".into()),
        }
    }
    fn submit_capture(&self, r: CaptureRequest) -> Result<Value, String> {
        self.locked(|s, v| {
            allowed(v, &r.space_id, true)?;
            if let Some(e) = s
                .entries
                .values()
                .find(|e| e.request.space_id == r.space_id && e.request.request_id == r.request_id)
            {
                if e.request != r {
                    return Err("This capture request_id already identifies different work.".into());
                }
                return encoded(&e.receipt);
            }
            if r.action.uses_space_context()
                && assistant_bridge::space(v, &r.space_id)?["settings"]
                    ["includeExistingNotesInAIContext"]
                    != json!(true)
            {
                return Err(
                    "Enable existing-note AI context before capturing this action with related-Space context."
                        .into(),
                );
            }
            let target = s
                .targets
                .values()
                .find(|t| {
                    t.id == r.editor_target_id
                        && t.surface.space_id == r.space_id
                        && t.surface.note_id == r.note_id
                        && t.surface.ready
                })
                .cloned()
                .ok_or(
                    "That exact ready rich editor is not available. Refresh Orion capabilities.",
                )?;
            if s.entries
                .values()
                .any(|e| e.target.id == target.id && e.receipt.state.pending())
            {
                return Err(
                    "This editor already owns a capture or action. Finish or cancel it first."
                        .into(),
                );
            }
            if s.entries
                .values()
                .filter(|e| e.receipt.state.pending())
                .count()
                >= MAX_PENDING
            {
                return Err("Eight editor actions are pending. Finish one first.".into());
            }
            let n = note(v, &r.space_id, &r.note_id)?;
            let bytes = serde_json::to_vec(n)
                .map_err(|_| "Cannot capture note version.")?
                .len();
            if text(n, "body").len() > protocol::MAX_BODY_BYTES
                || bytes > protocol::MAX_BODY_BYTES + 65_536
                || retained(s) + bytes > MAX_BYTES
            {
                return Err(
                    "The editor capture exceeds the bounded local mailbox capacity.".into(),
                );
            }
            while s.entries.len() >= MAX_RECEIPTS {
                let id = s
                    .order
                    .iter()
                    .find(|id| {
                        s.entries
                            .get(*id)
                            .is_some_and(|e| !e.receipt.state.pending())
                    })
                    .cloned()
                    .ok_or("The editor receipt mailbox is full.")?;
                s.entries.remove(&id);
                s.order.retain(|v| v != &id);
            }
            let id = format!("editor_action_{}", assistant_bridge::random_token()?);
            let now = assistant_bridge::now();
            let e = Entry {
                receipt: Receipt {
                    id: id.clone(),
                    space_id: r.space_id.clone(),
                    note_id: r.note_id.clone(),
                    editor_target_id: target.id.clone(),
                    state: ActionState::CapturePending,
                    action: r.action.clone(),
                    created_at: now,
                    updated_at: now,
                    capture_id: None,
                    document_version: None,
                    selection: None,
                    effective_target: None,
                    stage: None,
                    error: None,
                    result: None,
                },
                request: r,
                start_request: None,
                target,
                base_note: Some(n.clone()),
                base_version: note_version::note_version(n)?,
                captured_body: None,
                accepted_body: None,
                delivered: false,
                started: Instant::now(),
                touched: Instant::now(),
            };
            let result = encoded(&e.receipt)?;
            s.order.push_back(id.clone());
            s.entries.insert(id, e);
            Ok(result)
        })
    }
    fn start(&self, r: StartRequest) -> Result<Value, String> {
        self.locked(|s, v| {
            allowed(v, &r.space_id, true)?;
            if let Some(e) = s.entries.values().find(|e| {
                e.receipt.space_id == r.space_id
                    && e.start_request
                        .as_ref()
                        .is_some_and(|old| old.request_id == r.request_id)
            }) {
                if e.start_request.as_ref() != Some(&r) {
                    return Err(
                        "This start request_id already identifies a different capture.".into(),
                    );
                }
                return encoded(&e.receipt);
            }
            let e = s
                .entries
                .values_mut()
                .find(|e| {
                    e.receipt.space_id == r.space_id
                        && e.receipt.note_id == r.note_id
                        && e.target.id == r.editor_target_id
                        && e.receipt.capture_id.as_deref() == Some(&r.capture_id)
                })
                .ok_or("This capture does not belong to the exact target.")?;
            if e.receipt.state != ActionState::Captured
                || e.receipt.document_version.as_deref() != Some(&r.expected_document_version)
            {
                return Err(
                    "This capture is stale, already used, or has a different document version."
                        .into(),
                );
            }
            fresh(v, e)?;
            e.start_request = Some(r);
            e.delivered = false;
            end(e, ActionState::Submitted, None);
            encoded(&e.receipt)
        })
    }
    pub(crate) fn poll(
        &self,
        window: &str,
        session: &str,
        surface: Option<EditorActionSurface>,
    ) -> Result<Value, String> {
        protocol::identifier(session, 128)?;
        if let Some(t) = &surface {
            for value in [
                &t.space_id,
                &t.note_id,
                &t.document_version,
                &t.selection_version,
            ] {
                protocol::identifier(value, 200)?;
            }
        }
        self.locked(|s,v|{
 if s.retired.get(window).is_some_and(|r|r.contains(session))||(surface.is_none()&&s.sessions.get(window).is_none_or(|(id,_)|id!=session)){
return Ok(json!({
"targetId":null,"captures":[],"deliveries":[],"receipts":[]}
));
}
 if let Some((old,_))=s.sessions.get(window).filter(|(old,_)|old!=session){
let retired=s.retired.entry(window.into()).or_default();
if retired.len()>=128{
return Err("This editor session restarted too often. Reopen its window.".into());
}
retired.insert(old.clone());
}
 if !s.sessions.contains_key(window)&&s.sessions.len()>=MAX_TARGETS{
return Err("Too many editor action owners.".into());
}
s.sessions.insert(window.into(),(session.into(),Instant::now()));
 let keep=surface.as_ref().is_some_and(|t|s.targets.get(window).is_some_and(|old|old.session==session&&old.surface.space_id==t.space_id&&old.surface.note_id==t.note_id));
if !keep{
s.targets.remove(window);
}
 if let Some(surface)=surface{
if allowed(v,&surface.space_id,true).is_ok()&&note(v,&surface.space_id,&surface.note_id).is_ok(){
if let Some(t)=s.targets.get_mut(window){
t.surface=surface;
t.seen=Instant::now();
}
else{
s.targets.insert(window.into(),Target{
id:format!("editor_action_target_{}",assistant_bridge::random_token()?),window:window.into(),session:session.into(),surface,seen:Instant::now()}
);
}
}
else{
s.targets.remove(window);
}
}
 sweep(s,v);
let target_id=s.targets.get(window).filter(|t|t.session==session).map(|t|t.id.clone());
let mut captures=vec![];
let mut deliveries=vec![];
let mut receipts=vec![];
 for id in &s.order{
let e=s.entries.get_mut(id).expect("retained order");
if e.target.window==window&&e.target.session==session{
 if matches!(e.receipt.state,ActionState::CapturePending|ActionState::Submitted){
e.delivered=true;
let d=json!({
"id":e.receipt.id,"editorTargetId":e.target.id,"spaceId":e.receipt.space_id,"noteId":e.receipt.note_id,"action":e.receipt.action,"documentVersion":e.target.surface.document_version,"selectionVersion":e.target.surface.selection_version,"baseNoteVersion":e.base_version,"captureId":e.receipt.capture_id}
);
if e.receipt.state==ActionState::CapturePending{
captures.push(d);
}
else{
deliveries.push(d);
}
}
 receipts.push(encoded(&e.receipt)?);
 }
}
Ok(json!({
"targetId":target_id,"captures":captures,"deliveries":deliveries,"receipts":receipts}
))
 }
)
    }
    fn owner<'a>(
        s: &'a mut Mailbox,
        window: &str,
        session: &str,
        id: &str,
    ) -> Result<&'a mut Entry, String> {
        protocol::identifier(session, 128)?;
        protocol::identifier(id, 200)?;
        s.entries
            .get_mut(id)
            .filter(|e| e.target.window == window && e.target.session == session)
            .ok_or_else(|| {
                "This editor action belongs to another window/session or expired.".into()
            })
    }
    pub(crate) fn capture(
        &self,
        window: &str,
        session: &str,
        id: &str,
        target: &str,
        c: EditorCapture,
    ) -> Result<Value, String> {
        protocol::identifier(&c.document_version, 200)?;
        protocol::identifier(&c.selection_version, 200)?;
        c.selection.validate()?;
        c.effective_target.validate()?;
        if c.captured_body.len() > protocol::MAX_BODY_BYTES
            || serde_json::to_vec(&c.base_note)
                .map_err(|_| "Invalid captured base.")?
                .len()
                > protocol::MAX_BODY_BYTES + 65_536
        {
            return Err("The private capture body exceeds its bound.".into());
        }
        self.locked(|s, v| {
            if retained(s) + c.captured_body.len() > MAX_BYTES {
                return Err("The local capture mailbox is full.".into());
            }
            let e = Self::owner(s, window, session, id)?;
            if e.receipt.state != ActionState::CapturePending
                || !e.delivered
                || e.target.id != target
            {
                return Err("This capture is not awaiting its exact owning editor.".into());
            }
            let renderer_base_is_current = note_version::note_version(&c.base_note)?
                == e.base_version
                || e.base_note.as_ref().is_some_and(|base| {
                    equivalent_after_autosave(&c.base_note, base, &c.captured_body)
                });
            if c.document_version != e.target.surface.document_version
                || c.selection_version != e.target.surface.selection_version
                || !renderer_base_is_current
            {
                return Err(
                    "The displayed capture or its persisted base changed before capture completed."
                        .into(),
                );
            }
            if matches!(e.receipt.action, EditorAction::Write { .. }) {
                let empty_placeholder = c.captured_body.trim().is_empty()
                    && c.selection.from == 1
                    && c.selection.to == 1
                    && c.effective_target.from == 0
                    && c.effective_target.to == 2;
                if c.effective_target.from != c.effective_target.to && !empty_placeholder {
                    return Err(
                        "Write requires an exact insertion target or the sole empty paragraph."
                            .into(),
                    );
                }
            } else if c.selection.from == c.selection.to
                || c.effective_target.from == c.effective_target.to
            {
                return Err(
                    "Rewrite and image generation require a nonempty rich selection.".into(),
                );
            }
            e.captured_body = Some(c.captured_body);
            fresh(v, e)?;
            e.receipt.capture_id = Some(format!(
                "editor_capture_{}",
                assistant_bridge::random_token()?
            ));
            e.receipt.document_version = Some(c.document_version);
            e.receipt.selection = Some(c.selection);
            e.receipt.effective_target = Some(c.effective_target);
            end(e, ActionState::Captured, None);
            encoded(&e.receipt)
        })
    }
    pub(crate) fn claim(&self, window: &str, session: &str, id: &str) -> Result<Value, String> {
        self.locked(|s, v| {
            let e = Self::owner(s, window, session, id)?;
            if e.receipt.state != ActionState::Submitted || !e.delivered {
                return Err("This action has not been submitted to its owning editor, or was already claimed.".into());
            }
            fresh(v, e)?;
            end(e, ActionState::Generating, None);
            encoded(&e.receipt)
        })
    }
    pub(crate) fn authorize(
        &self,
        window: &str,
        g: &EditorActionGrant,
        stage: ActionStage,
    ) -> Result<Value, String> {
        self.locked(|s, v| {
            let e = Self::owner(s, window, &g.session_id, &g.action_id)?;
            fresh(v, e)?;
            validate_stage(e, stage)?;
            e.receipt.stage = Some(stage);
            e.receipt.updated_at = assistant_bridge::now();
            Ok(json!({
            "ok":true}
            ))
        })
    }
    pub(crate) fn provider(
        &self,
        window: &str,
        g: &EditorActionGrant,
        stage: ActionStage,
        model: Option<&str>,
        effort: Option<&str>,
        context: Option<bool>,
        quality: Option<ImageQuality>,
        image_phase: Option<&str>,
    ) -> Result<(), String> {
        self.locked(|s, v| {
            let e = Self::owner(s, window, &g.session_id, &g.action_id)?;
            fresh(v, e)?;
            validate_stage(e, stage)?;
            e.receipt.stage = Some(stage);
            e.receipt.updated_at = assistant_bridge::now();
            let settings = &assistant_bridge::space(v, &e.receipt.space_id)?["settings"];
            if matches!(stage, ActionStage::Writing | ActionStage::ImagePlanning) {
                let configured = settings["model"].as_str().unwrap_or("gpt-5.6-sol");
                let configured_effort = settings["reasoningEffort"].as_str().unwrap_or("low");
                let expected_effort = if stage == ActionStage::ImagePlanning {
                    match image_phase {
                        Some("select" | "search" | "read" | "merge") => "low",
                        Some("compose") => configured_effort,
                        _ => return Err("The image planning stage is unsupported.".into()),
                    }
                } else {
                    configured_effort
                };
                if model != Some(configured) || effort != Some(expected_effort) {
                    return Err("The provider model or reasoning setting changed. Capture the editor action again.".into());
                }
            }
            if context == Some(true) && settings["includeExistingNotesInAIContext"] != json!(true) {
                return Err("This external action cannot override the existing-note context preference.".into());
            }
            if let Some(q) = quality {
                if !matches!(&e.receipt.action, EditorAction::Image { quality, .. } if *quality == q)
                {
                    return Err("The image quality differs from the captured action.".into());
                }
            }
            if let EditorAction::Image {
                context: ImageContext::Selection,
                ..
            } = e.receipt.action
            {
                if context == Some(true) {
                    return Err("This action captured selection-only image context.".into());
                }
            }
            Ok(())
        })
    }
    pub(crate) fn review(&self, window: &str, session: &str, id: &str) -> Result<Value, String> {
        self.locked(|s, v| {
            let e = Self::owner(s, window, session, id)?;
            if e.receipt.state != ActionState::Generating {
                return Err("This action is no longer generating a preview.".into());
            }
            fresh(v, e)?;
            end(e, ActionState::AwaitingReview, None);
            encoded(&e.receipt)
        })
    }
    pub(crate) fn decide(
        &self,
        window: &str,
        session: &str,
        id: &str,
        accept: bool,
    ) -> Result<Value, String> {
        self.locked(|s, v| {
            let e = Self::owner(s, window, session, id)?;
            if !accept {
                if matches!(
                    e.receipt.state,
                    ActionState::Accepting
                        | ActionState::AcceptedInEditor
                        | ActionState::Saved
                        | ActionState::SaveFailed
                ) {
                    return Err("The local acceptance decision was already claimed.".into());
                }
                if e.receipt.state.before_decision() {
                    end(e, ActionState::Discarded, None);
                }
                return encoded(&e.receipt);
            }
            if e.receipt.state != ActionState::AwaitingReview {
                return Err("No current local review is awaiting acceptance.".into());
            }
            fresh(v, e)?;
            end(e, ActionState::Accepting, None);
            encoded(&e.receipt)
        })
    }
    pub(crate) fn accepted(
        &self,
        window: &str,
        session: &str,
        id: &str,
        body: String,
    ) -> Result<Value, String> {
        if body.len() > protocol::MAX_BODY_BYTES {
            return Err("The accepted body exceeds the local receipt bound.".into());
        }
        self.locked(|s, _| {
            if retained(s) + body.len() > MAX_BYTES {
                return Err("The accepted receipt exceeds local memory bounds. Keep the local change and resolve its save.".into());
            }
            let e = Self::owner(s, window, session, id)?;
            if e.receipt.state == ActionState::AcceptedInEditor && e.accepted_body.as_ref() == Some(&body) {
                return encoded(&e.receipt);
            }
            if e.receipt.state != ActionState::Accepting {
                return Err("No local acceptance claim exists for this editor action.".into());
            }
            if e.captured_body.as_ref() == Some(&body) {
                return Err("The editor reported no accepted change.".into());
            }
            e.base_note = None;
            e.captured_body = None;
            e.accepted_body = Some(body);
            end(e, ActionState::AcceptedInEditor, None);
            encoded(&e.receipt)
        })
    }
    pub(crate) fn saved(&self, window: &str, session: &str, id: &str) -> Result<Value, String> {
        self.locked(|s, v| {
            let e = Self::owner(s, window, session, id)?;
            if e.receipt.state == ActionState::Saved {
                return encoded(&e.receipt);
            }
            if e.receipt.state != ActionState::AcceptedInEditor {
                return Err("No accepted editor change awaits verified persistence.".into());
            }
            let n = note(v, &e.receipt.space_id, &e.receipt.note_id)?;
            if n["body"].as_str() != e.accepted_body.as_deref() {
                return Err("The accepted editor text is not yet confirmed on disk. Keep it and resolve or retry the ordinary save.".into());
            }
            let mut url = reqwest::Url::parse("orion://open").expect("static URI");
            url.query_pairs_mut()
                .append_pair("space_id", &e.receipt.space_id)
                .append_pair("note_id", &e.receipt.note_id);
            let title = text(n, "title")
                .chars()
                .take(240)
                .collect::<String>()
                .replace('\\', "\\\\")
                .replace('[', "\\[")
                .replace(']', "\\]")
                .replace(['\n', '\r'], " ");
            e.receipt.result = Some(SavedResult {
                note_id: e.receipt.note_id.clone(),
                version: note_version::note_version(n)?,
                url: url.to_string(),
                citation: format!("[{title}]({url})"),
            });
            end(e, ActionState::Saved, None);
            encoded(&e.receipt)
        })
    }
    pub(crate) fn fail(
        &self,
        window: &str,
        session: &str,
        id: &str,
        error: &str,
    ) -> Result<Value, String> {
        if error.chars().count() > 1000 {
            return Err("Editor errors are limited to 1000 characters.".into());
        }
        self.locked(|s, _| {
            let e = Self::owner(s, window, session, id)?;
            if e.receipt.state.pending() {
                let status = if e.receipt.state == ActionState::AcceptedInEditor {
                    ActionState::SaveFailed
                } else {
                    ActionState::Failed
                };
                end(e, status, Some(error.into()));
            }
            encoded(&e.receipt)
        })
    }
    pub(crate) fn expire(&self) {
        if let Ok(mut s) = self.state.lock() {
            sweep_time(&mut s);
        }
    }
    pub(crate) fn close_window(&self, window: &str) {
        if let Ok(mut s) = self.state.lock() {
            s.targets.remove(window);
            s.sessions.remove(window);
            s.retired.remove(window);
            for e in s
                .entries
                .values_mut()
                .filter(|e| e.target.window == window && e.receipt.state.pending())
            {
                owner_lost(
                    e,
                    "The editor window closed. No saved result was confirmed.",
                );
            }
        }
    }
}
#[tauri::command]
pub fn editor_actions_poll(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    target: Option<EditorActionSurface>,
) -> Result<Value, String> {
    if let Some(t) = &target {
        if !crate::desktop_windows::review_target_matches(
            window.app_handle(),
            window.label(),
            &t.space_id,
            &t.note_id,
        ) {
            return Err("This writing window does not own the exact note.".into());
        }
    }
    bridge
        .editor_actions
        .poll(window.label(), &session_id, target)
}
#[tauri::command]
pub fn editor_actions_capture(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    target_id: String,
    capture: EditorCapture,
) -> Result<Value, String> {
    bridge
        .editor_actions
        .capture(window.label(), &session_id, &id, &target_id, capture)
}
#[tauri::command]
pub fn editor_actions_claim(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
) -> Result<Value, String> {
    bridge
        .editor_actions
        .claim(window.label(), &session_id, &id)
}
#[tauri::command]
pub fn editor_actions_authorize(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    grant: EditorActionGrant,
    stage: ActionStage,
) -> Result<Value, String> {
    bridge
        .editor_actions
        .authorize(window.label(), &grant, stage)
}
#[tauri::command]
pub fn editor_actions_review(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
) -> Result<Value, String> {
    bridge
        .editor_actions
        .review(window.label(), &session_id, &id)
}
#[tauri::command]
pub fn editor_actions_decide(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    accept: bool,
) -> Result<Value, String> {
    bridge
        .editor_actions
        .decide(window.label(), &session_id, &id, accept)
}
#[tauri::command]
pub fn editor_actions_accepted(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    body: String,
) -> Result<Value, String> {
    bridge
        .editor_actions
        .accepted(window.label(), &session_id, &id, body)
}
#[tauri::command]
pub fn editor_actions_saved(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
) -> Result<Value, String> {
    bridge
        .editor_actions
        .saved(window.label(), &session_id, &id)
}
#[tauri::command]
pub fn editor_actions_fail(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    error: String,
) -> Result<Value, String> {
    bridge
        .editor_actions
        .fail(window.label(), &session_id, &id, &error)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({
        "schemaVersion":2,"activeSpaceId":"a","updatedAt":"1","spaces":[{
        "schemaVersion":1,"workspace":{
        "id":"a"}
        ,"notes":[{
        "id":"n","title":"Draft","body":"Original body.","createdAt":"1","updatedAt":"1"}
        ,{
        "id":"other","title":"Other","body":"Other text.","createdAt":"1","updatedAt":"1"}
        ],"settings":{
        "model":"gpt-5.6-sol","reasoningEffort":"low","includeExistingNotesInAIContext":true,"assistantAccess":{
        "enabled":true,"allowAI":true,"allowWrites":true,"spaceIds":["a"]}
        }
        }
        ,{
        "schemaVersion":1,"workspace":{
        "id":"b"}
        ,"notes":[{
        "id":"n","title":"Private","body":"Other Space secret","createdAt":"1","updatedAt":"1"}
        ],"settings":{
        }
        }
        ]}
        )
    }
    fn store() -> (tempfile::TempDir, EditorActionsStore) {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("vault.json");
        crate::write_vault_file(&p, &fixture()).unwrap();
        (d, EditorActionsStore::new(p))
    }
    fn change(s: &EditorActionsStore, f: impl FnOnce(&mut Value)) {
        let mut v = crate::read_vault_file(&s.path).unwrap().unwrap();
        f(&mut v);
        crate::write_vault_file(&s.path, &v).unwrap();
    }
    fn surface() -> Option<EditorActionSurface> {
        Some(EditorActionSurface {
            space_id: "a".into(),
            note_id: "n".into(),
            ready: true,
            document_version: "displayed-v1:rich".into(),
            selection_version: "selection-1".into(),
        })
    }
    fn register(s: &EditorActionsStore) -> String {
        s.poll("main", "session", surface()).unwrap()["targetId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn action() -> Value {
        json!({
        "kind":"rewrite","preset":"clarify"}
        )
    }
    fn request(target: &str, key: &str, action: Value) -> Value {
        json!({
        "space_id":"a","note_id":"n","editor_target_id":target,"request_id":key,"action":action}
        )
    }
    fn begin(s: &EditorActionsStore, target: &str, key: &str, action: Value) -> String {
        s.handle("editor_action_capture", request(target, key, action))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn captured(body: &str) -> EditorCapture {
        EditorCapture {
            document_version: "displayed-v1:rich".into(),
            selection_version: "selection-1".into(),
            selection: RichRange {
                coordinate_system: "prosemirror".into(),
                from: 1,
                to: 4,
            },
            effective_target: RichRange {
                coordinate_system: "prosemirror".into(),
                from: 1,
                to: 4,
            },
            base_note: fixture()["spaces"][0]["notes"][0].clone(),
            captured_body: body.into(),
        }
    }
    fn capture(s: &EditorActionsStore, target: &str, id: &str) -> Value {
        s.poll("main", "session", surface()).unwrap();
        s.capture(
            "main",
            "session",
            id,
            target,
            captured("Unsaved selected draft."),
        )
        .unwrap()
    }
    fn start_args(target: &str, c: &Value, key: &str) -> Value {
        json!({
        "space_id":"a","note_id":"n","editor_target_id":target,"capture_id":c["captureId"],"expected_document_version":c["documentVersion"],"request_id":key}
        )
    }
    fn admit(s: &EditorActionsStore, action: Value) -> (String, String, EditorActionGrant) {
        let t = register(s);
        let id = begin(s, &t, "capture-key", action);
        let c = capture(s, &t, &id);
        s.handle("editor_action_start", start_args(&t, &c, "start-key"))
            .unwrap();
        s.poll("main", "session", surface()).unwrap();
        s.claim("main", "session", &id).unwrap();
        (
            t,
            id.clone(),
            EditorActionGrant {
                action_id: id,
                session_id: "session".into(),
            },
        )
    }
    fn get(s: &EditorActionsStore, id: &str) -> Value {
        s.handle(
            "editor_action_get",
            json!({
            "space_id":"a","action_id":id}
            ),
        )
        .unwrap()
    }
    #[test]
    fn editor_actions_require_finite_native_capture_and_one_use_start() {
        let (_d, s) = store();
        let before = std::fs::read(&s.path).unwrap();
        let t = register(&s);
        let args = request(&t, "c", action());
        let r = s.handle("editor_action_capture", args.clone()).unwrap();
        let id = r["id"].as_str().unwrap();
        assert_eq!(r["state"], "capture_pending");
        assert_eq!(
            s.handle("editor_action_capture", args.clone()).unwrap()["id"],
            id
        );
        let mut changed = args;
        changed["action"]["preset"] = json!("expand");
        assert!(s.handle("editor_action_capture", changed).is_err());
        assert!(s
            .capture(
                "main",
                "session",
                id,
                &t,
                captured("Unsaved selected draft.")
            )
            .is_err());
        let c = capture(&s, &t, id);
        assert_eq!(c["state"], "captured");
        let start = start_args(&t, &c, "start");
        assert_eq!(
            s.handle("editor_action_start", start.clone()).unwrap()["state"],
            "submitted"
        );
        assert_eq!(s.handle("editor_action_start", start).unwrap()["id"], id);
        assert!(s
            .handle("editor_action_start", start_args(&t, &c, "another"))
            .is_err());
        assert!(s.claim("main", "session", id).is_err());
        s.poll("main", "session", surface()).unwrap();
        assert_eq!(
            s.claim("main", "session", id).unwrap()["state"],
            "generating"
        );
        assert!(s.claim("main", "session", id).is_err());
        assert!(s
            .capture(
                "main",
                "session",
                id,
                &t,
                captured("Unsaved selected draft.")
            )
            .is_err());
        assert_eq!(std::fs::read(&s.path).unwrap(), before);
        for secret in ["Original body", "Unsaved selected", "Other Space"] {
            assert!(!get(&s, id).to_string().contains(secret));
            assert!(!s.capabilities().unwrap().to_string().contains(secret));
        }
    }
    #[test]
    fn editor_actions_capture_base_is_actual_persisted_note_and_unsaved_autosave_is_exact() {
        let (_d, s) = store();
        let t = register(&s);
        let id = begin(&s, &t, "c", action());
        s.poll("main", "session", surface()).unwrap();
        let mut stale = captured("Unsaved selected draft.");
        stale.base_note["body"] = json!("Invisible newer baseline");
        assert!(s.capture("main", "session", &id, &t, stale).is_err());
        change(&s, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("Unsaved selected draft.");
            v["spaces"][0]["notes"][0]["updatedAt"] = json!("2");
        });
        let c = s
            .capture(
                "main",
                "session",
                &id,
                &t,
                captured("Unsaved selected draft."),
            )
            .unwrap();
        assert_eq!(c["state"], "captured");
        assert_eq!(get(&s, &id)["state"], "captured");
        change(&s, |v| {
            v["spaces"][0]["notes"][0]["title"] = json!("Changed independently")
        });
        assert_eq!(get(&s, &id)["state"], "stale");
        assert!(s
            .handle("editor_action_start", start_args(&t, &c, "s"))
            .is_err());
    }
    #[test]
    fn editor_actions_capture_rejects_wrong_selection_document_window_and_task_target() {
        let (_d, s) = store();
        let t = register(&s);
        let id = begin(&s, &t, "c", action());
        s.poll("main", "session", surface()).unwrap();
        for variant in 0..5 {
            let mut c = captured("Unsaved selected draft.");
            match variant {
                0 => c.selection_version = "selection-2".into(),
                1 => c.document_version = "displayed-v1:other".into(),
                2 => c.selection.coordinate_system = "dom-text-utf16".into(),
                3 => c.selection.to = c.selection.from,
                _ => c.effective_target.to = c.effective_target.from,
            };
            assert!(s.capture("main", "session", &id, &t, c).is_err());
        }
        assert!(s
            .capture("other-window", "session", &id, &t, captured("x"))
            .is_err());
        assert!(s
            .capture("main", "other-session", &id, &t, captured("x"))
            .is_err());
        let mut nav = surface().unwrap();
        nav.selection_version = "selection-2".into();
        s.poll("main", "session", Some(nav)).unwrap();
        assert_eq!(get(&s, &id)["state"], "stale");
    }
    #[test]
    fn editor_actions_write_insertion_range_must_be_collapsed() {
        for amount in ["sentence", "paragraph", "section"] {
            let (_d, s) = store();
            let t = register(&s);
            let id = begin(
                &s,
                &t,
                "c",
                json!({
                "kind":"write","amount":amount}
                ),
            );
            s.poll("main", "session", surface()).unwrap();
            assert!(s
                .capture(
                    "main",
                    "session",
                    &id,
                    &t,
                    captured("Unsaved selected draft.")
                )
                .is_err());
            let mut c = captured("Unsaved selected draft.");
            c.effective_target.from = c.effective_target.to;
            assert_eq!(
                s.capture("main", "session", &id, &t, c).unwrap()["state"],
                "captured"
            );
        }
    }
    #[test]
    fn editor_actions_permissions_revoke_authority_without_revival() {
        for setting in ["allowAI", "allowWrites", "enabled"] {
            let (_d, s) = store();
            let (_, id, g) = admit(&s, action());
            s.authorize("main", &g, ActionStage::Writing).unwrap();
            change(&s, |v| {
                v["spaces"][0]["settings"]["assistantAccess"][setting] = json!(false)
            });
            assert!(s.authorize("main", &g, ActionStage::Writing).is_err());
            change(&s, |v| {
                v["spaces"][0]["settings"]["assistantAccess"][setting] = json!(true)
            });
            assert!(s.authorize("main", &g, ActionStage::Writing).is_err());
            assert_eq!(get(&s, &id)["state"], "stale");
        }
    }
    #[test]
    fn editor_actions_provider_stages_bind_action_model_effort_context_and_quality() {
        let (_d, s) = store();
        let (_, _, g) = admit(&s, action());
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::Writing,
                Some("gpt-5.6-sol"),
                Some("low"),
                None,
                None,
                None
            )
            .is_ok());
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::Writing,
                Some("other"),
                Some("low"),
                None,
                None,
                None
            )
            .is_err());
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::Writing,
                Some("gpt-5.6-sol"),
                Some("high"),
                None,
                None,
                None
            )
            .is_err());
        for stage in [
            ActionStage::ImagePlanning,
            ActionStage::ImageRendering,
            ActionStage::ImageSaving,
        ] {
            assert!(s.authorize("main", &g, stage).is_err());
        }
        let (_d, s) = store();
        let (_, id, g) = admit(
            &s,
            json!({
            "kind":"image","quality":"fast","context":"selection"}
            ),
        );
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::ImagePlanning,
                Some("gpt-5.6-sol"),
                Some("low"),
                Some(false),
                None,
                Some("compose")
            )
            .is_ok());
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::ImagePlanning,
                Some("gpt-5.6-sol"),
                Some("low"),
                Some(true),
                None,
                Some("compose")
            )
            .is_err());
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::ImageRendering,
                None,
                None,
                None,
                Some(ImageQuality::Detailed),
                None
            )
            .is_err());
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::ImageRendering,
                None,
                None,
                None,
                Some(ImageQuality::Fast),
                None
            )
            .is_ok());
        assert!(s.authorize("main", &g, ActionStage::ImageSaving).is_err());
        s.review("main", "session", &id).unwrap();
        assert!(s.authorize("main", &g, ActionStage::ImageSaving).is_err());
        s.decide("main", "session", &id, true).unwrap();
        assert!(s.authorize("main", &g, ActionStage::ImageSaving).is_ok());
        assert!(s
            .authorize("main", &g, ActionStage::ImageRendering)
            .is_err());
    }
    #[test]
    fn editor_actions_space_context_cannot_override_saved_preference() {
        let (_d, s) = store();
        let t = register(&s);
        change(&s, |v| {
            v["spaces"][0]["settings"]["includeExistingNotesInAIContext"] = json!(false)
        });
        assert!(s
            .handle(
                "editor_action_capture",
                request(
                    &t,
                    "c",
                    json!({
                    "kind":"image","quality":"fast","context":"space"}
                    )
                )
            )
            .is_err());
        assert!(s
            .handle(
                "editor_action_capture",
                request(&t, "enrich", json!({"kind":"rewrite","preset":"enrich"}))
            )
            .is_err());
        let id = begin(&s, &t, "s", action());
        let c = capture(&s, &t, &id);
        s.handle("editor_action_start", start_args(&t, &c, "normal-writing"))
            .unwrap();
        s.poll("main", "session", surface()).unwrap();
        s.claim("main", "session", &id).unwrap();
        assert!(s
            .provider(
                "main",
                &EditorActionGrant {
                    action_id: id,
                    session_id: "session".into()
                },
                ActionStage::Writing,
                Some("gpt-5.6-sol"),
                Some("low"),
                None,
                None,
                None
            )
            .is_ok());
    }
    #[test]
    fn editor_actions_cancel_is_idempotent_and_fences_late_claim_publish_and_accept() {
        let (_d, s) = store();
        let (_, id, g) = admit(&s, action());
        let lookup = json!({
        "space_id":"a","action_id":id}
        );
        assert_eq!(
            s.handle("editor_action_cancel", lookup.clone()).unwrap()["state"],
            "cancelled"
        );
        assert_eq!(
            s.handle("editor_action_cancel", lookup).unwrap()["state"],
            "cancelled"
        );
        assert!(s.authorize("main", &g, ActionStage::Publish).is_err());
        assert!(s.review("main", "session", &id).is_err());
        assert!(s.decide("main", "session", &id, true).is_err());
        assert!(s
            .accepted("main", "session", &id, "Injected edit".into())
            .is_err());
        assert_eq!(
            s.fail("main", "session", &id, "Late failure").unwrap()["state"],
            "cancelled"
        );
    }
    #[test]
    fn editor_actions_acceptance_and_saved_receipts_are_distinct_and_exact() {
        let (_d, s) = store();
        let (_, id, g) = admit(&s, action());
        assert!(s.decide("main", "session", &id, true).is_err());
        s.review("main", "session", &id).unwrap();
        assert_eq!(
            s.decide("main", "session", &id, true).unwrap()["state"],
            "accepting"
        );
        assert!(s
            .handle(
                "editor_action_cancel",
                json!({
                "space_id":"a","action_id":id}
                )
            )
            .is_err());
        assert!(s.authorize("main", &g, ActionStage::Writing).is_err());
        assert!(s
            .accepted("main", "session", &id, "Unsaved selected draft.".into())
            .is_err());
        let r = s
            .accepted("main", "session", &id, "Accepted edit.".into())
            .unwrap();
        assert_eq!(r["state"], "accepted_in_editor");
        assert!(r.get("result").is_none());
        assert!(s.saved("main", "session", &id).is_err());
        change(&s, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("Further typing after accepted edit.")
        });
        assert!(s.saved("main", "session", &id).is_err());
        change(&s, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("Accepted edit.")
        });
        let r = s.saved("main", "session", &id).unwrap();
        assert_eq!(r["state"], "saved");
        assert_eq!(r["result"]["url"], "orion://open?space_id=a&note_id=n");
        assert!(!r.to_string().contains("Accepted edit"));
        assert_eq!(s.saved("main", "session", &id).unwrap()["state"], "saved");
        assert!(s.state.lock().unwrap().entries[&id].accepted_body.is_none());
    }
    #[test]
    fn editor_actions_navigation_before_accept_is_stale_but_admitted_save_can_finish() {
        let (_d, s) = store();
        let (_, id, _) = admit(&s, action());
        let mut nav = surface().unwrap();
        nav.note_id = "other".into();
        s.poll("main", "session", Some(nav)).unwrap();
        assert_eq!(get(&s, &id)["state"], "stale");
        let (_d, s) = store();
        let (_, id, _) = admit(&s, action());
        s.review("main", "session", &id).unwrap();
        s.decide("main", "session", &id, true).unwrap();
        s.poll("main", "session", None).unwrap();
        assert_eq!(
            s.accepted("main", "session", &id, "Accepted edit.".into())
                .unwrap()["state"],
            "accepted_in_editor"
        );
        assert_eq!(
            s.fail(
                "main",
                "session",
                &id,
                "Save conflict; local text retained."
            )
            .unwrap()["state"],
            "save_failed"
        );
    }
    #[test]
    fn editor_actions_busy_generation_is_allowed_but_authored_changes_invalidate() {
        let (_d, s) = store();
        let (_, id, g) = admit(&s, action());
        let mut busy = surface().unwrap();
        busy.ready = false;
        busy.selection_version = "moved-after-claim".into();
        s.poll("main", "session", Some(busy.clone())).unwrap();
        assert!(s.authorize("main", &g, ActionStage::Writing).is_ok());
        busy.document_version = "displayed-v1:changed".into();
        s.poll("main", "session", Some(busy)).unwrap();
        assert_eq!(get(&s, &id)["state"], "stale");
        assert!(s.authorize("main", &g, ActionStage::Publish).is_err());
    }
    #[test]
    fn editor_actions_sessions_retire_and_stale_cleanup_cannot_withdraw_new_owner() {
        let (_d, s) = store();
        let t = register(&s);
        let id = begin(&s, &t, "c", action());
        s.poll("main", "new-session", surface()).unwrap();
        let newer = s.capabilities().unwrap()["editorActionTargets"][0]["id"].clone();
        assert_ne!(newer, t);
        assert_eq!(get(&s, &id)["state"], "stale");
        assert!(s.poll("main", "session", None).unwrap()["targetId"].is_null());
        assert!(s.poll("main", "session", surface()).unwrap()["targetId"].is_null());
        assert_eq!(
            s.capabilities().unwrap()["editorActionTargets"][0]["id"],
            newer
        );
    }
    #[test]
    fn editor_actions_pending_capture_lease_retention_and_bounds_are_finite() {
        let (_d, s) = store();
        let t = register(&s);
        let id = begin(&s, &t, "c", action());
        s.state
            .lock()
            .unwrap()
            .entries
            .get_mut(&id)
            .unwrap()
            .started = Instant::now() - Duration::from_secs(4);
        s.expire();
        assert_eq!(get(&s, &id)["state"], "failed");
        let id2 = begin(&s, &t, "c2", action());
        capture(&s, &t, &id2);
        s.state
            .lock()
            .unwrap()
            .entries
            .get_mut(&id2)
            .unwrap()
            .touched = Instant::now() - Duration::from_secs(31);
        s.expire();
        assert_eq!(get(&s, &id2)["state"], "stale");
        for i in 0..36 {
            let id = begin(&s, &t, &format!("c{i}"), action());
            s.handle(
                "editor_action_cancel",
                json!({
                "space_id":"a","action_id":id}
                ),
            )
            .unwrap();
        }
        assert_eq!(s.state.lock().unwrap().entries.len(), MAX_RECEIPTS);
        let id = begin(&s, &t, "active", action());
        s.state
            .lock()
            .unwrap()
            .targets
            .get_mut("main")
            .unwrap()
            .seen = Instant::now() - Duration::from_secs(31);
        s.expire();
        assert_eq!(get(&s, &id)["state"], "stale");
        for e in s.state.lock().unwrap().entries.values_mut() {
            e.touched = Instant::now() - Duration::from_secs(3601);
        }
        s.expire();
        assert!(s.state.lock().unwrap().entries.is_empty());
    }
    #[test]
    fn editor_actions_provider_revocation_after_queue_prevents_dispatch() {
        let (_d, s) = store();
        let (_, id, g) = admit(&s, action());
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::Writing,
                Some("gpt-5.6-sol"),
                Some("low"),
                None,
                None,
                None
            )
            .is_ok());
        change(&s, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("Changed externally while queued.")
        });
        assert!(s
            .provider(
                "main",
                &g,
                ActionStage::Writing,
                Some("gpt-5.6-sol"),
                Some("low"),
                None,
                None,
                None
            )
            .is_err());
        assert_eq!(get(&s, &id)["state"], "stale");
    }
    #[test]
    fn editor_actions_socket_lane_is_authenticated_immediate_and_does_not_write() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;
        let (d, s) = store();
        let bridge = AssistantBridge::new(s.path.clone());
        let t = register(&bridge.editor_actions);
        bridge.start().unwrap();
        let desc: Value = serde_json::from_slice(
            &std::fs::read(d.path().join(crate::assistant_protocol::BRIDGE_DESCRIPTOR)).unwrap(),
        )
        .unwrap();
        let call = |method: &str, args: Value, token: &str| -> Value {
            let mut stream = UnixStream::connect(desc["socket_path"].as_str().unwrap()).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            serde_json::to_writer(
                &mut stream,
                &json!({
                "version":1,"token":token,"method":method,"arguments":args}
                ),
            )
            .unwrap();
            stream.write_all(b"\n").unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };
        let token = desc["token"].as_str().unwrap();
        let before = std::fs::read(&s.path).unwrap();
        assert_eq!(call("capabilities", json!({}), "wrong")["ok"], false);
        let caps = call("capabilities", json!({}), token);
        assert_eq!(caps["result"]["editorActionTargets"][0]["id"], t);
        assert_eq!(caps["result"]["available"], true);
        let now = Instant::now();
        let r = call("editor_action_capture", request(&t, "c", action()), token);
        let id = r["result"]["id"].as_str().unwrap();
        assert_eq!(
            call(
                "editor_action_get",
                json!({
                "space_id":"a","action_id":id}
                ),
                token
            )["result"]["state"],
            "capture_pending"
        );
        assert_eq!(call("capabilities", json!({}), token)["ok"], true);
        assert!(now.elapsed() < Duration::from_secs(1));
        assert_eq!(std::fs::read(&s.path).unwrap(), before);
    }
    #[test]
    fn editor_actions_empty_note_write_uses_exact_empty_paragraph_replacement() {
        let (_d, s) = store();
        let target = register(&s);
        let id = begin(
            &s,
            &target,
            "empty",
            json!({
            "kind":"write","amount":"paragraph"}
            ),
        );
        s.poll("main", "session", surface()).unwrap();
        let mut c = captured("");
        c.selection.to = 1;
        c.effective_target.from = 0;
        c.effective_target.to = 2;
        assert_eq!(
            s.capture("main", "session", &id, &target, c).unwrap()["state"],
            "captured"
        );
        let (_d, s) = store();
        let target = register(&s);
        let id = begin(
            &s,
            &target,
            "nonempty",
            json!({
            "kind":"write","amount":"paragraph"}
            ),
        );
        s.poll("main", "session", surface()).unwrap();
        let mut c = captured("Real content.");
        c.selection.to = 1;
        c.effective_target.from = 0;
        c.effective_target.to = 2;
        assert!(s.capture("main", "session", &id, &target, c).is_err());
    }

    #[test]
    fn editor_actions_image_planning_uses_existing_research_effort_policy() {
        let (_d, s) = store();
        let (_, _, grant) = admit(
            &s,
            json!({
            "kind":"image","quality":"detailed","context":"space"}
            ),
        );
        change(&s, |v| {
            v["spaces"][0]["settings"]["reasoningEffort"] = json!("high")
        });
        for phase in ["select", "search", "read", "merge"] {
            assert!(s
                .provider(
                    "main",
                    &grant,
                    ActionStage::ImagePlanning,
                    Some("gpt-5.6-sol"),
                    Some("low"),
                    Some(true),
                    None,
                    Some(phase)
                )
                .is_ok());
            assert!(s
                .provider(
                    "main",
                    &grant,
                    ActionStage::ImagePlanning,
                    Some("gpt-5.6-sol"),
                    Some("high"),
                    Some(true),
                    None,
                    Some(phase)
                )
                .is_err());
        }
        assert!(s
            .provider(
                "main",
                &grant,
                ActionStage::ImagePlanning,
                Some("gpt-5.6-sol"),
                Some("high"),
                Some(true),
                None,
                Some("compose")
            )
            .is_ok());
        for phase in [None, Some("arbitrary")] {
            assert!(s
                .provider(
                    "main",
                    &grant,
                    ActionStage::ImagePlanning,
                    Some("gpt-5.6-sol"),
                    Some("low"),
                    Some(true),
                    None,
                    phase
                )
                .is_err());
        }
        change(&s, |v| {
            v["spaces"][0]["settings"]["reasoningEffort"] = json!("none")
        });
        assert!(s
            .provider(
                "main",
                &grant,
                ActionStage::ImagePlanning,
                Some("gpt-5.6-sol"),
                Some("none"),
                Some(true),
                None,
                Some("compose")
            )
            .is_ok());
    }

    #[test]
    fn editor_actions_global_pending_bound_and_native_scope_are_enforced() {
        let (_d, s) = store();
        for i in 0..MAX_PENDING {
            let owner = format!("window-{i}");
            let target = s.poll(&owner, "session", surface()).unwrap()["targetId"]
                .as_str()
                .unwrap()
                .to_owned();
            begin(&s, &target, &format!("request-{i}"), action());
        }
        let target = register(&s);
        assert!(s
            .handle("editor_action_capture", request(&target, "ninth", action()))
            .is_err());
        let mut foreign = request(&target, "foreign", action());
        foreign["space_id"] = json!("b");
        assert!(s.handle("editor_action_capture", foreign).is_err());
        let mut foreign = request(&target, "other-note", action());
        foreign["note_id"] = json!("other");
        assert!(s.handle("editor_action_capture", foreign).is_err());
        assert_eq!(
            s.state
                .lock()
                .unwrap()
                .entries
                .values()
                .filter(|e| e.receipt.state.pending())
                .count(),
            MAX_PENDING
        );
    }

    #[test]
    fn editor_actions_oversized_private_capture_is_rejected_without_retaining_body() {
        let (_d, s) = store();
        let target = register(&s);
        let id = begin(&s, &target, "large", action());
        s.poll("main", "session", surface()).unwrap();
        let c = captured(&"🧭".repeat(protocol::MAX_BODY_BYTES / 4 + 1));
        assert!(s.capture("main", "session", &id, &target, c).is_err());
        assert!(s.state.lock().unwrap().entries[&id].captured_body.is_none());
        let mut c = captured("Unsaved selected draft.");
        c.base_note["unrelated"] = json!("x".repeat(protocol::MAX_BODY_BYTES + 65_537));
        assert!(s.capture("main", "session", &id, &target, c).is_err());
    }
    #[test]
    fn editor_actions_autosaved_renderer_baseline_must_equal_the_same_captured_body() {
        let (_d, s) = store();
        let target = register(&s);
        let id = begin(&s, &target, "autosaved", action());
        s.poll("main", "session", surface()).unwrap();
        change(&s, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("Unsaved selected draft.");
            v["spaces"][0]["notes"][0]["updatedAt"] = json!("2");
        });
        let mut c = captured("Unsaved selected draft.");
        c.base_note["body"] = json!("Unsaved selected draft.");
        c.base_note["updatedAt"] = json!("2");
        assert_eq!(
            s.capture("main", "session", &id, &target, c).unwrap()["state"],
            "captured"
        );
    }
    #[test]
    fn editor_actions_actual_browser_capture_and_acceptance_payloads_complete_native_lifecycle() {
        let accepted: Value = serde_json::from_str(include_str!(
            "../shared/fixtures/editor-action-browser-acceptances.json"
        ))
        .unwrap();
        for (case, captured_json) in [
            (
                "rewrite",
                include_str!("../shared/fixtures/editor-action-rewrite.json"),
            ),
            (
                "empty-write",
                include_str!("../shared/fixtures/editor-action-empty-write.json"),
            ),
        ] {
            // These exact payloads were emitted by the actual RichNoteEditor and
            // production mailbox. Only simulated routing IDs are replaced by
            // IDs minted by this real native store; capture data is unchanged.
            let browser: Value = serde_json::from_str(captured_json).unwrap();
            let capture = &browser["capture"];
            let expected = &accepted[case];
            let space_id = expected["spaceId"].as_str().unwrap();
            let note_id = capture["baseNote"]["id"].as_str().unwrap();
            let session = browser["sessionId"].as_str().unwrap();
            let mut vault = fixture();
            vault["activeSpaceId"] = json!(space_id);
            vault["spaces"][0]["workspace"]["id"] = json!(space_id);
            vault["spaces"][0]["notes"] = json!([capture["baseNote"].clone()]);
            vault["spaces"][0]["settings"]["assistantAccess"]["spaceIds"] = json!([space_id]);
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("vault.json");
            crate::write_vault_file(&path, &vault).unwrap();
            let store = EditorActionsStore::new(path);
            let before = std::fs::read(&store.path).unwrap();
            let surface = || {
                Some(EditorActionSurface {
                    space_id: space_id.into(),
                    note_id: note_id.into(),
                    ready: true,
                    document_version: capture["documentVersion"].as_str().unwrap().into(),
                    selection_version: capture["selectionVersion"].as_str().unwrap().into(),
                })
            };
            let target = store.poll("browser-fixture", session, surface()).unwrap()["targetId"]
                .as_str()
                .unwrap()
                .to_owned();
            assert_ne!(target, browser["targetId"].as_str().unwrap());
            let request = store
                .handle(
                    "editor_action_capture",
                    json!({
                        "space_id":space_id, "note_id":note_id, "editor_target_id":target,
                        "request_id":format!("browser-{case}-capture"), "action":expected["action"],
                    }),
                )
                .unwrap();
            let id = request["id"].as_str().unwrap().to_owned();
            assert_ne!(id, browser["id"].as_str().unwrap());
            let delivery = store.poll("browser-fixture", session, surface()).unwrap();
            assert_eq!(
                delivery["captures"][0]["documentVersion"],
                capture["documentVersion"]
            );
            assert_eq!(
                delivery["captures"][0]["selectionVersion"],
                capture["selectionVersion"]
            );
            let captured = store
                .capture(
                    "browser-fixture",
                    session,
                    &id,
                    &target,
                    serde_json::from_value(capture.clone()).unwrap(),
                )
                .unwrap();
            assert_eq!(captured["state"], "captured");
            for key in ["documentVersion", "selection", "effectiveTarget"] {
                assert_eq!(
                    captured[key], capture[key],
                    "Native capture changed actual browser {key}"
                );
            }
            let started = store.handle("editor_action_start", json!({
                "space_id":space_id, "note_id":note_id, "editor_target_id":target,
                "capture_id":captured["captureId"], "expected_document_version":capture["documentVersion"],
                "request_id":format!("browser-{case}-start"),
            })).unwrap();
            assert_eq!(started["state"], "submitted");
            store.poll("browser-fixture", session, surface()).unwrap();
            assert_eq!(
                store.claim("browser-fixture", session, &id).unwrap()["state"],
                "generating"
            );
            let grant = EditorActionGrant {
                action_id: id.clone(),
                session_id: session.into(),
            };
            store
                .provider(
                    "browser-fixture",
                    &grant,
                    ActionStage::Writing,
                    Some("gpt-5.6-sol"),
                    Some("low"),
                    None,
                    None,
                    None,
                )
                .unwrap();
            assert_eq!(
                store.review("browser-fixture", session, &id).unwrap()["state"],
                "awaiting_review"
            );
            assert_eq!(
                store.decide("browser-fixture", session, &id, true).unwrap()["state"],
                "accepting"
            );
            let body = expected["acceptedBody"].as_str().unwrap();
            assert_eq!(
                store
                    .accepted("browser-fixture", session, &id, body.into())
                    .unwrap()["state"],
                "accepted_in_editor"
            );
            assert!(store.saved("browser-fixture", session, &id).is_err());
            assert_eq!(
                std::fs::read(&store.path).unwrap(),
                before,
                "Native action lane must not write the synthetic vault"
            );
            // The browser already tested the real one-Undo editor transaction.
            // Here emulate only its ordinary save to test fresh disk equality.
            change(&store, |v| {
                v["spaces"][0]["notes"][0]["body"] = json!(body);
                v["spaces"][0]["notes"][0]["updatedAt"] = json!("2026-10-11T12:01:00.000Z");
            });
            let saved = store.saved("browser-fixture", session, &id).unwrap();
            assert_eq!(saved["state"], "saved");
            let receipt: Receipt = serde_json::from_value(saved.clone()).unwrap();
            receipt
                .validate_lookup(&LookupRequest {
                    space_id: space_id.into(),
                    action_id: id.clone(),
                })
                .unwrap();
            for public in [&captured, &started, &saved] {
                let encoded = public.to_string();
                for private in [
                    "PRIVATEDONEMARKER",
                    "PRIVATECHILDMARKER",
                    "baseNote",
                    "capturedBody",
                    "acceptedBody",
                ] {
                    assert!(
                        !encoded.contains(private),
                        "Private fixture data appeared in a public receipt"
                    );
                }
            }
            let retained = store.state.lock().unwrap();
            let entry = &retained.entries[&id];
            assert!(
                entry.base_note.is_none()
                    && entry.captured_body.is_none()
                    && entry.accepted_body.is_none()
            );
        }
    }
}
