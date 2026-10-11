//! Window-owned external edit review. No provider calls and no vault writes.
//! A local Accept claims the decision before the editor transaction; persistence
//! is acknowledged only after ordinary autosave and an exact fresh disk read.
use crate::{
    assistant_bridge::{self, AssistantBridge},
    assistant_review_protocol::{
        self as protocol, ReviewEdit, ReviewLookupRequest, ReviewSubmitRequest, ReviewTaskView,
    },
    note_version,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    hash::{Hash, Hasher},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, State, WebviewWindow};

const MAX_PENDING: usize = 8;
const MAX_RECEIPTS: usize = 32;
const MAX_TARGETS: usize = 64;
const MAX_RETAINED_BYTES: usize = 16 * 1024 * 1024;
const TARGET_LEASE: Duration = Duration::from_secs(30);
const REVIEW_DEADLINE: Duration = Duration::from_secs(20 * 60);
const RETENTION: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewSurface {
    space_id: String,
    note_id: String,
    ready: bool,
}
#[derive(Clone)]
struct Target {
    id: String,
    window: String,
    session: String,
    surface: ReviewSurface,
    seen: Instant,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    id: String,
    space_id: String,
    note_id: String,
    review_target_id: String,
    state: String,
    created_at: u64,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
}
struct Entry {
    receipt: Receipt,
    request_id: String,
    fingerprint: u64,
    expected_version: String,
    window: String,
    session: String,
    edit: Option<ReviewEdit>,
    task_view: ReviewTaskView,
    title: String,
    base_body: Option<String>,
    accepted_body: Option<String>,
    started: Instant,
    touched: Instant,
}
#[derive(Default)]
struct Reviews {
    targets: HashMap<String, Target>, // Native window label, never supplied by MCP.
    sessions: HashMap<String, (String, Instant)>,
    retired_sessions: HashMap<String, HashSet<String>>,
    entries: HashMap<String, Entry>,
    order: VecDeque<String>,
}
#[derive(Clone)]
pub(crate) struct ReviewStore {
    path: PathBuf,
    state: Arc<Mutex<Reviews>>,
}
fn before_decision(state: &str) -> bool {
    matches!(state, "submitted" | "awaiting_review")
}
fn pending(state: &str) -> bool {
    before_decision(state) || matches!(state, "accepting" | "accepted_in_editor")
}
fn allowed(vault: &Value, space_id: &str) -> Result<(), String> {
    assistant_bridge::space(vault, space_id)?;
    let access = assistant_bridge::access(vault)?;
    if !access.enabled || !access.allow_writes || !access.space_ids.iter().any(|id| id == space_id)
    {
        return Err("Enable desktop workflows and workflow writes for this exact Space in Orion Settings → Connections.".into());
    }
    Ok(())
}
fn note<'a>(vault: &'a Value, space_id: &str, note_id: &str) -> Result<&'a Value, String> {
    let notes = assistant_bridge::space(vault, space_id)?
        .get("notes")
        .and_then(Value::as_array)
        .ok_or("The Space has no valid note directory.")?;
    let mut matches = notes
        .iter()
        .filter(|n| n.get("id").and_then(Value::as_str) == Some(note_id));
    let note = matches
        .next()
        .ok_or("The exact note is no longer available in this Space.")?;
    if matches.next().is_some() {
        return Err("The note ID is ambiguous in this Space.".into());
    }
    note_version::note_version(note)?;
    Ok(note)
}
fn current<'a>(vault: &'a Value, entry: &Entry) -> Result<&'a Value, String> {
    allowed(vault, &entry.receipt.space_id)?;
    let note = note(vault, &entry.receipt.space_id, &entry.receipt.note_id)?;
    if note_version::note_version(note)? != entry.expected_version {
        return Err(
            "The note changed. Read its current version and submit a new review request.".into(),
        );
    }
    Ok(note)
}
fn end(entry: &mut Entry, state: &str, error: Option<String>) {
    entry.receipt.state = state.into();
    entry.receipt.updated_at = assistant_bridge::now();
    entry.receipt.error = error;
    entry.touched = Instant::now();
    if !pending(state) {
        entry.edit = None;
        entry.base_body = None;
        entry.accepted_body = None;
    }
}
fn lost_owner(entry: &mut Entry, reason: &str) {
    let state = if entry.receipt.state == "accepted_in_editor" {
        "save_failed"
    } else if entry.receipt.state == "accepting" {
        "failed"
    } else {
        "stale"
    };
    end(entry, state, Some(reason.into()));
}
fn sweep(state: &mut Reviews, vault: &Value) {
    state
        .targets
        .retain(|_, target| target.seen.elapsed() <= TARGET_LEASE);
    for entry in state
        .entries
        .values_mut()
        .filter(|e| pending(&e.receipt.state))
    {
        let owner = if before_decision(&entry.receipt.state) {
            state.targets.get(&entry.window).is_some_and(|t| {
                t.id == entry.receipt.review_target_id && t.session == entry.session
            })
        } else {
            state
                .sessions
                .get(&entry.window)
                .is_some_and(|(session, seen)| {
                    session == &entry.session && seen.elapsed() <= TARGET_LEASE
                })
        };
        if !owner {
            lost_owner(entry, "The review window disconnected or changed its note. No saved result was confirmed.");
        } else if entry.started.elapsed() > REVIEW_DEADLINE {
            lost_owner(
                entry,
                "This review reached its 20-minute limit. No saved result was confirmed.",
            );
        } else if before_decision(&entry.receipt.state) {
            if let Err(error) = current(vault, entry) {
                end(entry, "stale", Some(error));
            }
        }
    }
    state
        .entries
        .retain(|_, entry| pending(&entry.receipt.state) || entry.touched.elapsed() <= RETENTION);
    state.order.retain(|id| state.entries.contains_key(id));
}
fn encoded<T: Serialize>(value: T) -> Result<Value, String> {
    let value =
        serde_json::to_value(value).map_err(|_| "Cannot encode the review receipt.".to_string())?;
    if serde_json::to_vec(&value)
        .map_err(|_| "Cannot encode the review result.")?
        .len()
        > crate::assistant_protocol::MAX_BRIDGE_RESULT_BYTES
    {
        return Err("The review result exceeds its 2 MiB transport bound.".into());
    }
    Ok(value)
}
fn targets(state: &Reviews, vault: &Value) -> Vec<Value> {
    state.targets.values().filter(|target| target.surface.ready
        && allowed(vault, &target.surface.space_id).is_ok()
        && !state.entries.values().any(|entry| pending(&entry.receipt.state) && entry.receipt.review_target_id == target.id))
        .filter_map(|target| {
            let note = note(vault, &target.surface.space_id, &target.surface.note_id).ok()?;
            Some(json!({"id":target.id,"spaceId":target.surface.space_id,"noteId":target.surface.note_id,"title":note["title"].as_str().unwrap_or("").chars().take(240).collect::<String>(),"noteVersion":note_version::note_version(note).ok()?}))
        }).collect()
}
fn fingerprint(request: &ReviewSubmitRequest) -> Result<u64, String> {
    let bytes =
        serde_json::to_vec(request).map_err(|_| "Cannot encode this review.".to_string())?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Ok(hasher.finish())
}

impl ReviewStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self {
            path,
            state: Arc::new(Mutex::new(Reviews::default())),
        }
    }
    // Hold the shared vault lock through each version check and decision claim.
    // No function here writes the file; ordinary editor autosave owns persistence.
    fn locked<T>(
        &self,
        work: impl FnOnce(&mut Reviews, &Value) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "The edit review queue was interrupted.")?;
        let file = crate::vault_lock_file(&self.path)?;
        FileExt::lock_shared(&file).map_err(|_| "The library is busy.")?;
        let vault = crate::read_vault_file(&self.path)?
            .ok_or("Open Orion once to create its local library.")?;
        if vault.get("schemaVersion").and_then(Value::as_u64) != Some(2) {
            return Err("The library has an invalid schema.".into());
        }
        sweep(&mut state, &vault);
        work(&mut state, &vault)
    }
    pub(crate) fn capabilities(&self) -> Result<Value, String> {
        self.locked(|state, vault| Ok(json!({"reviewTargets":targets(state,vault),"reviewLimits":{"pending":MAX_PENDING,"retained":MAX_RECEIPTS,"retentionSeconds":RETENTION.as_secs(),"providerCalls":0}})))
    }
    pub(crate) fn handle(&self, method: &str, arguments: Value) -> Result<Value, String> {
        match method {
            "review_submit" => {
                let request: ReviewSubmitRequest = serde_json::from_value(arguments)
                    .map_err(|_| "The edit review request has an invalid schema.")?;
                request.validate()?;
                self.submit(request)
            }
            "review_get" | "review_cancel" => {
                let request: ReviewLookupRequest = serde_json::from_value(arguments)
                    .map_err(|_| "The edit review lookup has an invalid schema.")?;
                request.validate()?;
                self.locked(|state,vault| {
                    allowed(vault, &request.space_id)?;
                    let entry = state.entries.get_mut(&request.review_id).filter(|e| e.receipt.space_id == request.space_id).ok_or("This review is not available in the exact Space.")?;
                    if method == "review_cancel" {
                        if matches!(entry.receipt.state.as_str(), "accepting" | "accepted_in_editor") { return Err("The user has already accepted this review. Cancellation cannot undo the editor change.".into()); }
                        if before_decision(&entry.receipt.state) { end(entry,"cancelled",None); }
                    }
                    encoded(&entry.receipt)
                })
            }
            _ => Err("Unknown edit review method.".into()),
        }
    }
    fn submit(&self, request: ReviewSubmitRequest) -> Result<Value, String> {
        let fingerprint = fingerprint(&request)?;
        self.locked(|state,vault| {
            allowed(vault,&request.space_id)?;
            if let Some(entry) = state.entries.values().find(|e| e.receipt.space_id == request.space_id && e.request_id == request.request_id) {
                if entry.fingerprint != fingerprint { return Err("This request_id already identifies a different edit review. Use a new request_id.".into()); }
                return encoded(&entry.receipt);
            }
            let target = state.targets.values().find(|t| t.id == request.review_target_id && t.surface.ready && t.surface.space_id == request.space_id && t.surface.note_id == request.note_id).cloned().ok_or("That ready review target is no longer showing the exact note. Refresh Orion's capabilities.")?;
            if state.entries.values().any(|e| pending(&e.receipt.state) && e.receipt.review_target_id == target.id) { return Err("This window already has an edit review. Finish it first.".into()); }
            if state.entries.values().filter(|e| pending(&e.receipt.state)).count() >= MAX_PENDING { return Err("Orion has eight pending edit reviews. Finish one before submitting another.".into()); }
            let note = note(vault,&request.space_id,&request.note_id)?;
            if note_version::note_version(note)? != request.expected_version { return Err("The note version is stale. Read the current note before proposing edits.".into()); }
            let body = note.get("body").and_then(Value::as_str).unwrap_or("");
            if body.len() > protocol::MAX_REVIEW_BODY_BYTES { return Err("This note exceeds the 2,000,000-byte review bound.".into()); }
            if matches!(request.edit, ReviewEdit::Rewrite{..}) && request.task_view != ReviewTaskView::History && protocol::contains_completed_task(body) { return Err("A whole-note rewrite could remove hidden completed tasks. Explicitly read task_view history and submit this rewrite with task_view history, or use focused edits.".into()); }
            let retained: usize = state.entries.values().map(|e| e.base_body.as_ref().map_or(0,String::len)+e.accepted_body.as_ref().map_or(0,String::len)+e.edit.as_ref().and_then(|v|serde_json::to_vec(v).ok()).map_or(0,|v|v.len())).sum();
            if retained + body.len() + serde_json::to_vec(&request).map_err(|_|"Cannot encode review.")?.len() > MAX_RETAINED_BYTES { return Err("The edit review queue is full. Finish an existing review first.".into()); }
            let id = format!("review_{}",assistant_bridge::random_token()?);
            let timestamp = assistant_bridge::now();
            let entry = Entry {receipt:Receipt{id:id.clone(),space_id:request.space_id,note_id:request.note_id,review_target_id:target.id,state:"submitted".into(),created_at:timestamp,updated_at:timestamp,error:None,result:None},request_id:request.request_id,fingerprint,expected_version:request.expected_version,window:target.window,session:target.session,edit:Some(request.edit),task_view:request.task_view,title:note["title"].as_str().unwrap_or("").chars().take(240).collect(),base_body:Some(body.into()),accepted_body:None,started:Instant::now(),touched:Instant::now()};
            delivery(&entry)?; // Validate complete encoded payload before retaining anything.
            while state.entries.len() >= MAX_RECEIPTS {
                let id = state.order.iter().find(|id|state.entries.get(*id).is_some_and(|e|!pending(&e.receipt.state))).cloned().ok_or("The review receipt store is full.")?;
                state.entries.remove(&id); state.order.retain(|v|v!=&id);
            }
            let receipt = encoded(&entry.receipt)?;
            state.order.push_back(id.clone()); state.entries.insert(id,entry);
            Ok(receipt)
        })
    }
    pub(crate) fn poll(
        &self,
        window: &str,
        session: &str,
        surface: Option<ReviewSurface>,
    ) -> Result<Value, String> {
        protocol::identifier(session, 128)?;
        if let Some(s) = &surface {
            protocol::identifier(&s.space_id, 200)?;
            protocol::identifier(&s.note_id, 200)?;
        }
        self.locked(|state, vault| {
            // A disposed adapter may finish an old asynchronous poll after its
            // replacement has registered. It cannot withdraw or revive its target.
            if state.retired_sessions.get(window).is_some_and(|ids| ids.contains(session))
                || (surface.is_none() && state.sessions.get(window).is_none_or(|(active,_)| active != session)) {
                return encoded(json!({"targetId":null,"deliveries":[],"receipts":[]}));
            }
            if let Some((active,_))=state.sessions.get(window).filter(|(active,_)|active!=session) {
                let retired=state.retired_sessions.entry(window.into()).or_default();
                if retired.len()>=128 {return Err("This window has restarted its review session too many times. Close and reopen the window before another review.".into());}
                retired.insert(active.clone());
            }
            if !state.sessions.contains_key(window) && state.sessions.len() >= MAX_TARGETS {
                return Err("Too many open review sessions.".into());
            }
            state
                .sessions
                .insert(window.into(), (session.into(), Instant::now()));
            let keep = surface.as_ref().is_some_and(|surface| {
                state.targets.get(window).is_some_and(|t| {
                    t.session == session
                        && t.surface.space_id == surface.space_id
                        && t.surface.note_id == surface.note_id
                })
            });
            if !keep {
                state.targets.remove(window);
            }
            if let Some(surface) = surface {
                if allowed(vault, &surface.space_id).is_ok()
                    && note(vault, &surface.space_id, &surface.note_id).is_ok()
                {
                    if let Some(target) = state.targets.get_mut(window) {
                        target.surface.ready = surface.ready;
                        target.seen = Instant::now();
                    } else if state.targets.len() < MAX_TARGETS {
                        state.targets.insert(
                            window.into(),
                            Target {
                                id: format!("review_target_{}", assistant_bridge::random_token()?),
                                window: window.into(),
                                session: session.into(),
                                surface,
                                seen: Instant::now(),
                            },
                        );
                    } else {
                        return Err("Too many open review targets.").map_err(String::from);
                    }
                } else {
                    state.targets.remove(window);
                }
            }
            sweep(state, vault);
            let target_id = state
                .targets
                .get(window)
                .filter(|t| t.session == session)
                .map(|t| t.id.clone());
            let mut deliveries = Vec::new();
            let mut receipts = Vec::new();
            for id in &state.order {
                let entry = &state.entries[id];
                if entry.window == window && entry.session == session {
                    if entry.receipt.state == "submitted" && state.targets.get(window).is_some_and(|target|target.surface.ready) {
                        deliveries.push(delivery(entry)?);
                    }
                    receipts.push(encoded(&entry.receipt)?);
                }
            }
            encoded(json!({"targetId":target_id,"deliveries":deliveries,"receipts":receipts}))
        })
    }
    pub(crate) fn close_window(&self, window: &str) {
        if let Ok(mut state) = self.state.lock() {
            state.targets.remove(window);
            state.sessions.remove(window);
            state.retired_sessions.remove(window);
            for entry in state
                .entries
                .values_mut()
                .filter(|e| e.window == window && pending(&e.receipt.state))
            {
                lost_owner(
                    entry,
                    "The review window closed. No saved result was confirmed.",
                );
            }
        }
    }
    fn owner<'a>(
        state: &'a mut Reviews,
        window: &str,
        session: &str,
        id: &str,
    ) -> Result<&'a mut Entry, String> {
        protocol::identifier(session, 128)?;
        protocol::identifier(id, 200)?;
        state
            .entries
            .get_mut(id)
            .filter(|e| e.window == window && e.session == session)
            .ok_or_else(|| "This renderer does not own that edit review.".into())
    }
    pub(crate) fn stage(&self, window: &str, session: &str, id: &str) -> Result<Value, String> {
        self.locked(|state, vault| {
            let entry = Self::owner(state, window, session, id)?;
            if !before_decision(&entry.receipt.state) {
                return Err("This review is no longer available to stage.".into());
            }
            current(vault, entry)?;
            end(entry, "awaiting_review", None);
            encoded(&entry.receipt)
        })
    }
    pub(crate) fn decide(
        &self,
        window: &str,
        session: &str,
        id: &str,
        accept: bool,
    ) -> Result<Value, String> {
        self.locked(|state, vault| {
            let entry = Self::owner(state, window, session, id)?;
            if !accept {
                if matches!(
                    entry.receipt.state.as_str(),
                    "accepting" | "accepted_in_editor" | "saved"
                ) {
                    return Err("The acceptance decision was already claimed.".into());
                }
                if before_decision(&entry.receipt.state) {
                    end(entry, "discarded", None);
                }
                return encoded(&entry.receipt);
            }
            if entry.receipt.state != "awaiting_review" {
                return Err("This edit is no longer awaiting a local acceptance decision.".into());
            }
            current(vault, entry)?;
            end(entry, "accepting", None);
            encoded(&entry.receipt)
        })
    }
    pub(crate) fn accepted(
        &self,
        window: &str,
        session: &str,
        id: &str,
        body: String,
    ) -> Result<Value, String> {
        if body.len() > protocol::MAX_REVIEW_BODY_BYTES {
            return Err("The accepted note exceeds the 2,000,000-byte receipt bound.".into());
        }
        self.locked(|state,_|{
            let others: usize = state.entries.iter().filter(|(key,_)|key.as_str()!=id).map(|(_,e)|e.base_body.as_ref().map_or(0,String::len)+e.accepted_body.as_ref().map_or(0,String::len)+e.edit.as_ref().and_then(|v|serde_json::to_vec(v).ok()).map_or(0,|v|v.len())).sum();
            if others+body.len()>MAX_RETAINED_BYTES {return Err("The accepted-body receipt exceeds the retained review memory bound. The local edit remains available.".into());}
            let entry=Self::owner(state,window,session,id)?;
            if entry.receipt.state=="accepted_in_editor" && entry.accepted_body.as_deref()==Some(&body) {return encoded(&entry.receipt);}
            if entry.receipt.state!="accepting" {return Err("No current local acceptance claim exists for this review.".into());}
            if entry.base_body.as_deref()==Some(&body) {return Err("The editor reported no accepted change.".into());}
            entry.base_body=None; entry.edit=None; entry.accepted_body=Some(body);
            end(entry,"accepted_in_editor",None); encoded(&entry.receipt)
        })
    }
    pub(crate) fn saved(&self, window: &str, session: &str, id: &str) -> Result<Value, String> {
        self.locked(|state,vault|{
            let entry=Self::owner(state,window,session,id)?;
            if entry.receipt.state=="saved" { return encoded(&entry.receipt); }
            if entry.receipt.state!="accepted_in_editor" {return Err("This review has no accepted editor change awaiting persistence.".into());}
            let note=note(vault,&entry.receipt.space_id,&entry.receipt.note_id)?;
            if note.get("body").and_then(Value::as_str)!=entry.accepted_body.as_deref() {
                return Err("The accepted text has not been confirmed on disk. Keep the local edit and resolve or retry its normal save.".into());
            }
            let mut url=reqwest::Url::parse("orion://open").expect("static Orion URL");
            url.query_pairs_mut().append_pair("space_id",&entry.receipt.space_id).append_pair("note_id",&entry.receipt.note_id);
            let title=note["title"].as_str().unwrap_or("").replace('\\',"\\\\").replace('[',"\\[").replace(']',"\\]").replace(['\n','\r']," ");
            entry.receipt.result=Some(json!({"noteId":entry.receipt.note_id,"version":note_version::note_version(note)?,"url":url.as_str(),"citation":format!("[{title}]({url})")}));
            end(entry,"saved",None); encoded(&entry.receipt)
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
            return Err("Review errors must be bounded to 1000 characters.".into());
        }
        self.locked(|state, _| {
            let entry = Self::owner(state, window, session, id)?;
            if pending(&entry.receipt.state) {
                let status = if entry.receipt.state == "accepted_in_editor" {
                    "save_failed"
                } else {
                    "failed"
                };
                end(entry, status, Some(error.into()));
            }
            encoded(&entry.receipt)
        })
    }
}
fn delivery(entry: &Entry) -> Result<Value, String> {
    encoded(
        json!({"id":entry.receipt.id,"spaceId":entry.receipt.space_id,"noteId":entry.receipt.note_id,"expectedVersion":entry.expected_version,"title":entry.title,"baseBody":entry.base_body,"edit":entry.edit,"taskView":entry.task_view}),
    )
}

#[tauri::command]
pub fn assistant_review_poll(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    target: Option<ReviewSurface>,
) -> Result<Value, String> {
    if let Some(target) = &target {
        if !crate::desktop_windows::review_target_matches(
            window.app_handle(),
            window.label(),
            &target.space_id,
            &target.note_id,
        ) {
            return Err("That note is not owned by this writing window.".into());
        }
    }
    bridge.reviews.poll(window.label(), &session_id, target)
}
#[tauri::command]
pub fn assistant_review_stage(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
) -> Result<Value, String> {
    bridge.reviews.stage(window.label(), &session_id, &id)
}
#[tauri::command]
pub fn assistant_review_decide(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    accept: bool,
) -> Result<Value, String> {
    bridge
        .reviews
        .decide(window.label(), &session_id, &id, accept)
}
#[tauri::command]
pub fn assistant_review_accepted(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    body: String,
) -> Result<Value, String> {
    bridge
        .reviews
        .accepted(window.label(), &session_id, &id, body)
}
#[tauri::command]
pub fn assistant_review_saved(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
) -> Result<Value, String> {
    bridge.reviews.saved(window.label(), &session_id, &id)
}
#[tauri::command]
pub fn assistant_review_fail(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    error: String,
) -> Result<Value, String> {
    bridge
        .reviews
        .fail(window.label(), &session_id, &id, &error)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"schemaVersion":2,"activeSpaceId":"a","updatedAt":"v1","spaces":[
            {"schemaVersion":1,"workspace":{"id":"a"},"notes":[{"id":"n","title":"Draft 🧭","body":"Old sentence.","createdAt":"a","updatedAt":"a"},{"id":"other","title":"Other","body":"Other text","createdAt":"a","updatedAt":"a"}],"settings":{"assistantAccess":{"enabled":true,"allowAI":false,"allowWrites":true,"spaceIds":["a"]}}},
            {"schemaVersion":1,"workspace":{"id":"b"},"notes":[{"id":"n","title":"Private","body":"Other Space","createdAt":"a","updatedAt":"a"}],"settings":{}}]})
    }
    fn store() -> (tempfile::TempDir, ReviewStore) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        crate::write_vault_file(&path, &fixture()).unwrap();
        (dir, ReviewStore::new(path))
    }
    fn surface(ready: bool) -> Option<ReviewSurface> {
        Some(ReviewSurface {
            space_id: "a".into(),
            note_id: "n".into(),
            ready,
        })
    }
    fn register(store: &ReviewStore) -> String {
        store.poll("main", "session", surface(true)).unwrap()["targetId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn request(target: &str) -> ReviewSubmitRequest {
        serde_json::from_value(json!({"space_id":"a","request_id":"one","review_target_id":target,"note_id":"n","expected_version":note_version::note_version(&fixture()["spaces"][0]["notes"][0]).unwrap(),"edit":{"kind":"focused","edits":[{"before":"Old sentence.","after":"New sentence."}]}})).unwrap()
    }
    fn submit(store: &ReviewStore) -> (String, ReviewSubmitRequest) {
        let request = request(&register(store));
        let value = store.submit(request.clone()).unwrap();
        (value["id"].as_str().unwrap().into(), request)
    }
    fn save_fixture(store: &ReviewStore, edit: impl FnOnce(&mut Value)) {
        let mut value = crate::read_vault_file(&store.path).unwrap().unwrap();
        edit(&mut value);
        crate::write_vault_file(&store.path, &value).unwrap();
    }
    fn lookup(id: &str) -> Value {
        json!({"space_id":"a","review_id":id})
    }
    #[test]
    fn review_is_window_bound_read_only_and_keeps_its_target_while_staged() {
        let (_dir, store) = store();
        let before = std::fs::read(&store.path).unwrap();
        let (id, _) = submit(&store);
        assert!(store.stage("other-window", "session", &id).is_err());
        assert!(store.stage("main", "other-session", &id).is_err());
        let delivery = store.poll("main", "session", surface(true)).unwrap();
        assert_eq!(delivery["deliveries"][0]["baseBody"], "Old sentence.");
        assert_eq!(
            store.stage("main", "session", &id).unwrap()["state"],
            "awaiting_review"
        );
        assert_eq!(
            store.poll("main", "session", surface(false)).unwrap()["receipts"][0]["state"],
            "awaiting_review"
        );
        assert_eq!(store.capabilities().unwrap()["reviewTargets"], json!([]));
        assert_eq!(std::fs::read(&store.path).unwrap(), before);
        assert!(store
            .handle("review_get", json!({"space_id":"b","review_id":id}))
            .is_err());
        let receipt = store.handle("review_get", lookup(&id)).unwrap();
        assert!(receipt.get("baseBody").is_none());
        assert!(receipt.get("edit").is_none());
    }
    #[test]
    fn retries_are_bounded_idempotent_and_cannot_restage_a_cancelled_review() {
        let (_dir, store) = store();
        let (id, request) = submit(&store);
        assert_eq!(store.submit(request.clone()).unwrap()["id"], id);
        let mut different = request.clone();
        different.edit = ReviewEdit::Rewrite {
            body: "Different".into(),
        };
        assert!(store.submit(different).is_err());
        let mut second = request.clone();
        second.request_id = "two".into();
        assert!(store.submit(second).is_err());
        assert_eq!(
            store.handle("review_cancel", lookup(&id)).unwrap()["state"],
            "cancelled"
        );
        assert_eq!(store.submit(request).unwrap()["state"], "cancelled");
        assert!(store.stage("main", "session", &id).is_err());
        assert!(store.decide("main", "session", &id, true).is_err());
        assert_eq!(
            store.decide("main", "session", &id, false).unwrap()["state"],
            "cancelled"
        );
    }
    #[test]
    fn acceptance_claim_wins_cancel_race_but_never_claims_saved_before_exact_disk_body() {
        let (_dir, store) = store();
        let (id, _) = submit(&store);
        store.stage("main", "session", &id).unwrap();
        assert_eq!(
            store.decide("main", "session", &id, true).unwrap()["state"],
            "accepting"
        );
        assert!(store.handle("review_cancel", lookup(&id)).is_err());
        assert!(store.decide("main", "session", &id, true).is_err());
        assert_eq!(
            store
                .accepted("main", "session", &id, "New sentence.".into())
                .unwrap()["state"],
            "accepted_in_editor"
        );
        assert!(store.saved("main", "session", &id).is_err());
        assert_eq!(
            store.handle("review_get", lookup(&id)).unwrap()["state"],
            "accepted_in_editor"
        );
        save_fixture(&store, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("New sentence.");
            v["spaces"][0]["notes"][0]["updatedAt"] = json!("b");
        });
        let result = store.saved("main", "session", &id).unwrap();
        assert_eq!(result["state"], "saved");
        assert!(result["result"]["url"]
            .as_str()
            .unwrap()
            .contains("space_id=a&note_id=n"));
        assert_eq!(store.saved("main", "session", &id).unwrap(), result);
    }
    #[test]
    fn changed_disk_versions_invalidate_stage_and_decision_without_writes() {
        for stage_first in [false, true] {
            let (_dir, store) = store();
            let (id, _) = submit(&store);
            if stage_first {
                store.stage("main", "session", &id).unwrap();
            }
            save_fixture(&store, |v| {
                v["spaces"][0]["notes"][0]["body"] = json!("External addition.")
            });
            let disk = std::fs::read(&store.path).unwrap();
            assert!(store.stage("main", "session", &id).is_err());
            assert!(store.decide("main", "session", &id, true).is_err());
            assert_eq!(
                store.handle("review_get", lookup(&id)).unwrap()["state"],
                "stale"
            );
            assert_eq!(std::fs::read(&store.path).unwrap(), disk);
        }
    }
    #[test]
    fn unrelated_note_changes_do_not_invalidate_review_but_permissions_do() {
        let (_dir, store) = store();
        let (id, _) = submit(&store);
        save_fixture(&store, |v| {
            v["spaces"][0]["notes"][1]["body"] = json!("Unrelated")
        });
        store.stage("main", "session", &id).unwrap();
        save_fixture(&store, |v| {
            v["spaces"][0]["settings"]["assistantAccess"]["allowWrites"] = json!(false)
        });
        assert!(store.decide("main", "session", &id, true).is_err());
        assert_eq!(
            store.poll("main", "session", surface(false)).unwrap()["receipts"][0]["state"],
            "stale"
        );
        assert_eq!(store.capabilities().unwrap()["reviewTargets"], json!([]));
        assert!(store.handle("review_get", lookup(&id)).is_err());
    }
    #[test]
    fn accepted_transaction_can_report_save_after_navigation_or_grant_revocation() {
        let (_dir, store) = store();
        let (id, _) = submit(&store);
        store.stage("main", "session", &id).unwrap();
        store.decide("main", "session", &id, true).unwrap();
        save_fixture(&store, |v| {
            v["spaces"][0]["settings"]["assistantAccess"]["enabled"] = json!(false)
        });
        store.poll("main", "session", None).unwrap();
        store
            .accepted("main", "session", &id, "New sentence.".into())
            .unwrap();
        save_fixture(&store, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("New sentence.")
        });
        assert_eq!(
            store.saved("main", "session", &id).unwrap()["state"],
            "saved"
        );
        assert!(store.handle("review_get", lookup(&id)).is_err());
    }
    #[test]
    fn navigation_session_replacement_and_window_close_stop_unaccepted_work() {
        for action in ["navigation", "session", "closed", "expired"] {
            let (_dir, store) = store();
            let (id, _) = submit(&store);
            store.stage("main", "session", &id).unwrap();
            match action {
                "navigation" => {
                    store.poll("main", "session", None).unwrap();
                }
                "session" => {
                    store.poll("main", "new-session", surface(true)).unwrap();
                }
                "closed" => store.close_window("main"),
                _ => {
                    let mut state = store.state.lock().unwrap();
                    state.targets.get_mut("main").unwrap().seen =
                        Instant::now() - TARGET_LEASE - Duration::from_secs(1);
                }
            }
            assert!(store.decide("main", "session", &id, true).is_err());
            assert_eq!(
                store.handle("review_get", lookup(&id)).unwrap()["state"],
                "stale"
            );
        }
    }
    #[test]
    fn save_failures_and_window_loss_do_not_relabel_accepted_edits_cancelled() {
        for close in [false, true] {
            let (_dir, store) = store();
            let (id, _) = submit(&store);
            store.stage("main", "session", &id).unwrap();
            store.decide("main", "session", &id, true).unwrap();
            store
                .accepted("main", "session", &id, "New sentence.".into())
                .unwrap();
            if close {
                store.close_window("main");
            } else {
                store
                    .fail(
                        "main",
                        "session",
                        &id,
                        "Save conflict: local text remains available.",
                    )
                    .unwrap();
            }
            assert_eq!(
                store.handle("review_get", lookup(&id)).unwrap()["state"],
                "save_failed"
            );
            assert_eq!(
                store.fail("main", "session", &id, "late failure").unwrap()["state"],
                "save_failed"
            );
            assert_eq!(
                note(
                    &crate::read_vault_file(&store.path).unwrap().unwrap(),
                    "a",
                    "n"
                )
                .unwrap()["body"],
                "Old sentence."
            );
        }
    }
    #[test]
    fn duplicate_scope_and_note_ids_and_ungranted_targets_fail_closed() {
        for mutation in ["space", "note", "grant", "writes"] {
            let (_dir, store) = store();
            let target = register(&store);
            save_fixture(&store, |v| match mutation {
                "space" => {
                    let duplicate = v["spaces"][0].clone();
                    v["spaces"].as_array_mut().unwrap().push(duplicate);
                }
                "note" => {
                    let duplicate = v["spaces"][0]["notes"][0].clone();
                    v["spaces"][0]["notes"]
                        .as_array_mut()
                        .unwrap()
                        .push(duplicate);
                }
                "grant" => v["spaces"][0]["settings"]["assistantAccess"]["spaceIds"] = json!(["b"]),
                _ => v["spaces"][0]["settings"]["assistantAccess"]["allowWrites"] = json!(false),
            });
            assert!(store.submit(request(&target)).is_err());
        }
    }
    #[test]
    fn full_rewrite_of_working_view_requires_deliberate_history() {
        let (_dir, store) = store();
        save_fixture(&store, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("- [x] Done privately\n\nOpen prose")
        });
        let mut request = request(&register(&store));
        request.expected_version = note_version::note_version(
            &crate::read_vault_file(&store.path).unwrap().unwrap()["spaces"][0]["notes"][0],
        )
        .unwrap();
        request.edit = ReviewEdit::Rewrite {
            body: "Replacement".into(),
        };
        assert!(store.submit(request.clone()).is_err());
        request.task_view = ReviewTaskView::History;
        assert!(store.submit(request).is_ok());
    }
    #[test]
    fn long_focused_notes_remain_local_and_retention_is_bounded() {
        let (_dir, store) = store();
        save_fixture(&store, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("word ".repeat(20_000))
        });
        let mut request = request(&register(&store));
        request.expected_version = note_version::note_version(
            &crate::read_vault_file(&store.path).unwrap().unwrap()["spaces"][0]["notes"][0],
        )
        .unwrap();
        assert!(store.submit(request).is_ok());
        let caps = store.capabilities().unwrap();
        assert!(!caps.to_string().contains("word word"));
        let (_dir, store) = self::store();
        for index in 0..35 {
            let mut request = self::request(&register(&store));
            request.request_id = index.to_string();
            let id = store.submit(request).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            store.handle("review_cancel", lookup(&id)).unwrap();
        }
        assert_eq!(store.state.lock().unwrap().entries.len(), MAX_RECEIPTS);
    }
    #[test]
    fn autosave_before_accept_receipt_and_concurrent_newer_text_are_reported_honestly() {
        let (_dir, store) = store();
        let (id, _) = submit(&store);
        store.stage("main", "session", &id).unwrap();
        store.decide("main", "session", &id, true).unwrap();
        save_fixture(&store, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("New sentence.")
        });
        store
            .accepted("main", "session", &id, "New sentence.".into())
            .unwrap();
        save_fixture(&store, |v| {
            v["spaces"][0]["notes"][0]["body"] = json!("New sentence. Later typing.")
        });
        assert!(store.saved("main", "session", &id).is_err());
        assert_eq!(
            store.handle("review_get", lookup(&id)).unwrap()["state"],
            "accepted_in_editor"
        );
    }
    #[test]
    fn submission_size_failure_and_expiration_do_not_leave_live_review_or_write() {
        let (_dir, store) = store();
        save_fixture(&store, |v| {
            v["spaces"][0]["notes"][0]["body"] =
                json!("x".repeat(protocol::MAX_REVIEW_BODY_BYTES + 1))
        });
        let mut request = request(&register(&store));
        request.expected_version = note_version::note_version(
            &crate::read_vault_file(&store.path).unwrap().unwrap()["spaces"][0]["notes"][0],
        )
        .unwrap();
        let before = std::fs::read(&store.path).unwrap();
        assert!(store.submit(request).is_err());
        assert!(store.state.lock().unwrap().entries.is_empty());
        assert_eq!(std::fs::read(&store.path).unwrap(), before);
        let (_dir, store) = self::store();
        let (id, _) = submit(&store);
        store
            .state
            .lock()
            .unwrap()
            .entries
            .get_mut(&id)
            .unwrap()
            .started = Instant::now() - REVIEW_DEADLINE - Duration::from_secs(1);
        assert_eq!(
            store.handle("review_get", lookup(&id)).unwrap()["state"],
            "stale"
        );
    }
    #[test]
    fn accepted_payload_cannot_bypass_memory_budget_or_claim_for_another_session() {
        let (_dir, store) = store();
        let (id, _) = submit(&store);
        store.stage("main", "session", &id).unwrap();
        store.decide("main", "session", &id, true).unwrap();
        assert!(store
            .accepted("other-window", "session", &id, "New sentence.".into())
            .is_err());
        assert!(store
            .accepted("main", "new-session", &id, "New sentence.".into())
            .is_err());
        assert!(store
            .accepted(
                "main",
                "session",
                &id,
                "x".repeat(protocol::MAX_REVIEW_BODY_BYTES + 1)
            )
            .is_err());
        assert_eq!(
            store.handle("review_get", lookup(&id)).unwrap()["state"],
            "accepting"
        );
        store
            .poll("main", "replacement-session", surface(true))
            .unwrap();
        assert!(store
            .accepted("main", "session", &id, "New sentence.".into())
            .is_err());
        assert_eq!(
            store.handle("review_get", lookup(&id)).unwrap()["state"],
            "failed"
        );
    }
    #[cfg(unix)]
    #[test]
    fn real_private_socket_routes_reviews_without_claiming_background_executor_or_writing() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;
        let (dir, store) = store();
        let bridge = AssistantBridge::new(store.path.clone());
        let target = register(&bridge.reviews);
        bridge.start().unwrap();
        let descriptor: Value = serde_json::from_slice(
            &std::fs::read(
                dir.path()
                    .join(crate::assistant_protocol::BRIDGE_DESCRIPTOR),
            )
            .unwrap(),
        )
        .unwrap();
        let call = |method: &str, arguments: Value, token: &str| -> Value {
            let mut stream =
                UnixStream::connect(descriptor["socket_path"].as_str().unwrap()).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            serde_json::to_writer(
                &mut stream,
                &json!({"version":1,"token":token,"method":method,"arguments":arguments}),
            )
            .unwrap();
            stream.write_all(b"\n").unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            serde_json::from_str(&line).unwrap()
        };
        let token = descriptor["token"].as_str().unwrap();
        let before = std::fs::read(&store.path).unwrap();
        assert_eq!(call("capabilities", json!({}), "wrong")["ok"], false);
        let caps = call("capabilities", json!({}), token);
        assert_eq!(caps["result"]["available"], false);
        assert_eq!(caps["result"]["reviewTargets"][0]["id"], target);
        let request = request(&target);
        let started = call(
            "review_submit",
            serde_json::to_value(&request).unwrap(),
            token,
        );
        assert_eq!(started["ok"], true);
        let id = started["result"]["id"].as_str().unwrap();
        assert_eq!(
            call(
                "review_submit",
                serde_json::to_value(request).unwrap(),
                token
            ),
            started
        );
        bridge.reviews.stage("main", "session", id).unwrap();
        assert_eq!(
            call("review_get", lookup(id), token)["result"]["state"],
            "awaiting_review"
        );
        assert_eq!(
            call("review_cancel", lookup(id), token)["result"]["state"],
            "cancelled"
        );
        assert!(bridge.reviews.decide("main", "session", id, true).is_err());
        assert_eq!(std::fs::read(&store.path).unwrap(), before);
    }
    #[test]
    fn retired_session_polls_cannot_withdraw_or_restore_over_the_new_window_owner() {
        let (_dir, store) = store();
        register(&store);
        let target = store.poll("main", "replacement", surface(true)).unwrap()["targetId"]
            .as_str()
            .unwrap()
            .to_owned();
        let id = store.submit(request(&target)).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned();
        for late_target in [None, surface(true), surface(false)] {
            let old = store.poll("main", "session", late_target).unwrap();
            assert!(old["targetId"].is_null());
            assert_eq!(store.capabilities().unwrap()["reviewTargets"], json!([])); // Still the same pending review.
            assert_eq!(
                store.handle("review_get", lookup(&id)).unwrap()["state"],
                "submitted"
            );
            assert_eq!(store.state.lock().unwrap().targets["main"].id, target);
        }
        store.stage("main", "replacement", &id).unwrap();
        assert_eq!(
            store.decide("main", "replacement", &id, true).unwrap()["state"],
            "accepting"
        );
    }
    #[test]
    fn busy_surface_defers_delivery_without_losing_pending_ownership() {
        let (_dir, store) = store();
        let (id, _) = submit(&store);
        assert_eq!(
            store.poll("main", "session", surface(false)).unwrap()["deliveries"],
            json!([])
        );
        assert_eq!(
            store.poll("main", "session", surface(true)).unwrap()["deliveries"][0]["id"],
            id
        );
        store.stage("main", "session", &id).unwrap();
        assert_eq!(
            store.poll("main", "session", surface(false)).unwrap()["receipts"][0]["state"],
            "awaiting_review"
        );
    }
}
