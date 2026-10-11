//! Window-owned voice-worker mailbox. No microphone, navigation, provider transport or vault writes.
use crate::{
    assistant_bridge::{self, AssistantBridge},
    voice_work_orders_protocol::{
        self as protocol, VoiceControlRequest, VoiceGetRequest, VoiceListRequest,
        VoiceLookupRequest, VoiceRequest,
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
const MAX_RECEIPTS: usize = 32;
const MAX_TARGETS: usize = 64;
const MAX_GRANTS: usize = 128;
const LEASE: Duration = Duration::from_secs(30);
const DEADLINE: Duration = Duration::from_millis(protocol::REQUEST_TIMEOUT_MS);
const RETENTION: Duration = Duration::from_secs(3_600);
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceSurface {
    space_id: String,
    ready: bool,
}
#[derive(Clone)]
struct Target {
    id: String,
    window: String,
    session: String,
    surface: VoiceSurface,
    seen: Instant,
}
#[derive(Clone)]
struct Grant {
    id: String,
    target: Target,
    work_order_id: String,
    revision: u64,
}
struct Entry {
    request: VoiceRequest,
    target: Target,
    started: Instant,
    delivered: bool,
    claimed: bool,
    grant: Option<Grant>,
    result: Option<Value>,
    error: Option<String>,
}
impl Entry {
    fn pending(&self) -> bool {
        self.result.is_none() && self.error.is_none()
    }
    fn view(&self, id: &str) -> Value {
        let mut v = json!({"id":id,"state":if self.result.is_some(){"succeeded"}else if self.error.is_some(){"failed"}else{"pending"}});
        if let Some(r) = &self.result {
            v["result"] = r.clone();
        }
        if let Some(e) = &self.error {
            v["error"] = json!(e);
        }
        v
    }
}
#[derive(Default)]
struct Mailbox {
    targets: HashMap<String, Target>,
    sessions: HashMap<String, String>,
    retired: HashMap<String, HashSet<String>>,
    entries: HashMap<String, Entry>,
    grants: HashMap<String, Grant>,
}
#[derive(Clone)]
pub(crate) struct VoiceWorkOrdersStore {
    path: PathBuf,
    state: Arc<Mutex<Mailbox>>,
}
fn allowed(vault: &Value, space: &str, ai: bool) -> Result<(), String> {
    let scope = assistant_bridge::space(vault, space)?;
    let a = assistant_bridge::access(vault)?;
    if !a.enabled || !a.space_ids.iter().any(|id| id == space) {
        return Err(
            "Enable desktop workflows for this exact Space in Orion Settings → Connections.".into(),
        );
    }
    if ai && (!a.allow_ai || scope["settings"]["includeExistingNotesInAIContext"] != json!(true)) {
        return Err("Allow connected assistants to use Orion AI and enable existing-note context before retrying or steering research.".into());
    }
    Ok(())
}
fn target_current(state: &Mailbox, target: &Target) -> bool {
    state.targets.get(&target.window).is_some_and(|t| {
        t.id == target.id
            && t.session == target.session
            && t.surface.space_id == target.surface.space_id
    })
}
fn sweep_time(state: &mut Mailbox) {
    state.targets.retain(|_, t| t.seen.elapsed() <= LEASE);
    state.grants.retain(|_, g| {
        state
            .targets
            .get(&g.target.window)
            .is_some_and(|t| t.id == g.target.id && t.session == g.target.session)
    });
    for e in state.entries.values_mut().filter(|e| e.pending()) {
        if e.started.elapsed() >= DEADLINE {
            e.error=Some("The voice owner did not finish this request within three seconds. Refresh the inventory before trying again.".into());
        }
    }
    state.entries.retain(|_, e| e.started.elapsed() < RETENTION);
}
fn sweep(state: &mut Mailbox, vault: &Value) {
    sweep_time(state);
    state
        .targets
        .retain(|_, t| allowed(vault, &t.surface.space_id, false).is_ok());
    state.grants.retain(|_, g| {
        state
            .targets
            .get(&g.target.window)
            .is_some_and(|t| t.id == g.target.id && t.session == g.target.session)
            && allowed(vault, &g.target.surface.space_id, true).is_ok()
    });
    for e in state.entries.values_mut() {
        if !state
            .targets
            .get(&e.target.window)
            .is_some_and(|t| t.id == e.target.id && t.session == e.target.session)
            || allowed(vault, e.request.space_id(), e.request.uses_ai()).is_err()
        {
            e.result = None;
            e.error=Some("This voice target or its permission is no longer current. Refresh Orion capabilities.".into());
        }
    }
}
impl VoiceWorkOrdersStore {
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
            .map_err(|_| "Voice work-order mailbox was interrupted.")?;
        let lock = crate::vault_lock_file(&self.path)?;
        FileExt::lock_shared(&lock).map_err(|_| "The library is busy.")?;
        let vault =
            crate::read_vault_file(&self.path)?.ok_or("Open Orion once to create its library.")?;
        if vault["schemaVersion"].as_u64() != Some(2) {
            return Err("The library has an invalid schema.".into());
        }
        sweep(&mut state, &vault);
        work(&mut state, &vault)
    }
    pub(crate) fn capabilities(&self) -> Result<Value, String> {
        self.locked(|s,_| {
        let mut targets=s.targets.values().map(|t|json!({"id":t.id,"spaceId":t.surface.space_id,"ready":t.surface.ready})).collect::<Vec<_>>();
        targets.sort_by_key(|v|v["id"].as_str().unwrap_or("").to_owned());
        Ok(json!({"voiceTargets":targets,"voiceWorkOrderLimits":{"pending":MAX_PENDING,"retained":MAX_RECEIPTS,"leaseSeconds":30,"timeoutMs":protocol::REQUEST_TIMEOUT_MS,"maxChars":protocol::MAX_CHARS,"activeExternalGrants":MAX_GRANTS}}))
    })
    }
    pub(crate) fn handle(&self, method: &str, args: Value) -> Result<Value, String> {
        if method == "voice_request_get" {
            let r: VoiceLookupRequest =
                serde_json::from_value(args).map_err(|_| "Invalid voice request lookup schema.")?;
            r.validate()?;
            return self.locked(|s, v| {
                allowed(v, &r.space_id, false)?;
                let e = s
                    .entries
                    .get(&r.request_id)
                    .filter(|e| e.request.space_id() == r.space_id)
                    .ok_or("That voice request expired or belongs to another Space.")?;
                Ok(e.view(&r.request_id))
            });
        }
        let request = match method {
            "voice_list" => {
                let r: VoiceListRequest =
                    serde_json::from_value(args).map_err(|_| "Invalid voice inventory schema.")?;
                r.validate()?;
                VoiceRequest::List(r)
            }
            "voice_get" => {
                let r: VoiceGetRequest =
                    serde_json::from_value(args).map_err(|_| "Invalid voice detail schema.")?;
                r.validate()?;
                VoiceRequest::Get(r)
            }
            "voice_control" => {
                let r: VoiceControlRequest =
                    serde_json::from_value(args).map_err(|_| "Invalid voice control schema.")?;
                r.validate()?;
                VoiceRequest::Control(r)
            }
            _ => return Err("Unknown voice work-order method.".into()),
        };
        self.locked(|s,v|{
            allowed(v,request.space_id(),request.uses_ai())?;
            if let VoiceRequest::Control(r)=&request {
                if let Some((id,e))=s.entries.iter().find(|(_,e)|matches!(&e.request,VoiceRequest::Control(old) if old.space_id==r.space_id && old.voice_target_id==r.voice_target_id && old.request_id==r.request_id)) {
                    if e.request!=request {return Err("This request_id already identifies a different voice control. Use a new request_id.".into());}
                    return Ok(e.view(id));
                }
            }
            let target=s.targets.values().find(|t|t.id==request.target_id() && t.surface.space_id==request.space_id()).cloned().ok_or("That voice target is no longer available. Refresh Orion capabilities.")?;
            if request.uses_ai() && !target.surface.ready {return Err("This voice research owner is not ready. Open the Space and check its AI settings.".into());}
            if s.entries.values().filter(|e|e.pending()).count()>=MAX_PENDING{return Err("Eight voice requests are pending. Wait briefly and retry.".into());}
            while s.entries.len()>=MAX_RECEIPTS {
                let id=s.entries.iter().filter(|(_,e)|!e.pending()).min_by_key(|(_,e)|e.started).map(|(id,_)|id.clone()).ok_or("Voice receipt storage is full.")?;s.entries.remove(&id);
            }
            let id=format!("voice_request_{}",assistant_bridge::random_token()?);
            s.entries.insert(id.clone(),Entry{request,target,started:Instant::now(),delivered:false,claimed:false,grant:None,result:None,error:None});
            Ok(json!({"id":id,"state":"pending"}))
        })
    }
    pub(crate) fn poll(
        &self,
        window: &str,
        session: &str,
        surface: Option<VoiceSurface>,
    ) -> Result<Value, String> {
        protocol::identifier(session, 128)?;
        if let Some(t) = &surface {
            protocol::identifier(&t.space_id, 200)?;
        }
        self.locked(|s,v|{
            let empty=||json!({"targetId":null,"requests":[],"grants":[],"allowAI":false});
            if s.retired.get(window).is_some_and(|set|set.contains(session)) || surface.is_none() && s.sessions.get(window).is_none_or(|old|old!=session) {return Ok(empty());}
            if let Some(old)=s.sessions.get(window).filter(|old|*old!=session){let retired=s.retired.entry(window.into()).or_default();if retired.len()>=128{return Err("This voice owner restarted too often. Close and reopen its window.".into());}retired.insert(old.clone());}
            if !s.sessions.contains_key(window)&&s.sessions.len()>=MAX_TARGETS{return Err("Too many voice owners.".into());}
            s.sessions.insert(window.into(),session.into());
            let keep=surface.as_ref().is_some_and(|new|s.targets.get(window).is_some_and(|t|t.session==session&&t.surface.space_id==new.space_id));
            if !keep{s.targets.remove(window);}
            if let Some(surface)=surface {
                if allowed(v,&surface.space_id,false).is_ok() {
                    if let Some(t)=s.targets.get_mut(window){t.surface.ready=surface.ready;t.seen=Instant::now();}
                    else{s.targets.insert(window.into(),Target{id:format!("voice_target_{}",assistant_bridge::random_token()?),window:window.into(),session:session.into(),surface,seen:Instant::now()});}
                }else{s.targets.remove(window);}
            }
            sweep(s,v);
            let target=s.targets.get(window).filter(|t|t.session==session);
            let mut requests=Vec::new();
            for (id,e) in s.entries.iter_mut().filter(|(_,e)|e.target.window==window&&e.target.session==session&&e.pending()) {e.delivered=true;requests.push(json!({"id":id,"targetId":e.target.id,"request":e.request}));}
            let grants=s.grants.values().filter(|g|g.target.window==window&&g.target.session==session).map(|g|json!({"id":g.id,"workOrderId":g.work_order_id,"revision":g.revision})).collect::<Vec<_>>();
            Ok(json!({"targetId":target.map(|t|&t.id),"requests":requests,"grants":grants,"allowAI":target.is_some_and(|t|t.surface.ready&&allowed(v,&t.surface.space_id,true).is_ok())}))
        })
    }
    pub(crate) fn claim(
        &self,
        window: &str,
        session: &str,
        id: &str,
        target_id: &str,
        admitted_revision: Option<u64>,
    ) -> Result<Value, String> {
        identifiers(session, id, target_id)?;
        self.locked(|s,v|{
            let e=s.entries.get(id).filter(|e|e.target.window==window&&e.target.session==session&&e.target.id==target_id&&e.delivered&&e.pending()&&target_current(s,&e.target)).ok_or("This voice control is expired or belongs to another owner.")?;
            let VoiceRequest::Control(r)=&e.request else{return Err("Only a control requires admission claim.".into());};
            allowed(v,&r.space_id,r.uses_ai())?;
            if e.claimed {return Err("This voice control was already claimed. Retrieve its receipt; do not execute it twice.".into());}
            let grant=if r.uses_ai(){
                if !s.targets.get(window).is_some_and(|t|t.surface.ready){return Err("This voice research owner is not ready.".into());}
                let revision=admitted_revision.ok_or("The renderer must claim the exact revision it will admit.")?;
                if revision==0||revision>protocol::MAX_SAFE_INTEGER||!(revision==r.expected_revision||revision==r.expected_revision.saturating_add(1)){return Err("The claimed revision does not follow this exact work order.".into());}
                if s.grants.len()>=MAX_GRANTS{return Err("Too many external voice revisions are active. Let work finish before steering more.".into());}
                Some(Grant{id:format!("voice_grant_{}",assistant_bridge::random_token()?),target:e.target.clone(),work_order_id:r.work_order_id.clone(),revision})
            }else{if admitted_revision.is_some(){return Err("Cancel cannot admit a research revision.".into());}None};
            let response=json!({"claimed":true,"grantId":grant.as_ref().map(|g|&g.id)});
            let e=s.entries.get_mut(id).unwrap();e.claimed=true;e.grant=grant.clone();if let Some(g)=grant{s.grants.insert(g.id.clone(),g);}Ok(response)
        })
    }
    pub(crate) fn respond(
        &self,
        window: &str,
        session: &str,
        id: &str,
        target_id: &str,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<Value, String> {
        identifiers(session, id, target_id)?;
        if result.is_some() == error.is_some() {
            return Err("Respond with exactly one result or error.".into());
        }
        if let Some(error) = &error {
            if error.is_empty() || error.chars().count() > 500 {
                return Err("Voice request errors must contain 1–500 characters.".into());
            }
        }
        self.locked(|s, v| {
            let e = s
                .entries
                .get(id)
                .filter(|e| {
                    e.target.window == window
                        && e.target.session == session
                        && e.target.id == target_id
                        && e.delivered
                        && e.pending()
                        && target_current(s, &e.target)
                })
                .ok_or("This voice response expired or belongs to another owner.")?;
            allowed(v, e.request.space_id(), e.request.uses_ai())?;
            if let Some(result) = &result {
                if matches!(e.request, VoiceRequest::Control(_)) && !e.claimed {
                    return Err("A voice control must be claimed before execution.".into());
                }
                protocol::validate_result(&e.request, result)?;
                if let Some(g) = &e.grant {
                    // Terminal cleanup may release execution before the small
                    // admission receipt arrives. Its immutable claim remains;
                    // owner/permission revocation already invalidates the entry.
                    if result["revision"].as_u64() != Some(g.revision) {
                        return Err(
                            "This admitted revision or its external grant is no longer current."
                                .into(),
                        );
                    }
                }
            }
            if error.is_some() {
                if let Some(g) = &e.grant {
                    s.grants.remove(&g.id);
                }
            }
            let e = s.entries.get_mut(id).unwrap();
            e.result = result;
            e.error = error;
            Ok(json!({"ok":true}))
        })
    }
    pub(crate) fn authorize(
        &self,
        window: &str,
        session: &str,
        target_id: &str,
        grant_id: &str,
    ) -> Result<bool, String> {
        identifiers(session, grant_id, target_id)?;
        self.locked(|s, v| {
            let g = s
                .grants
                .get(grant_id)
                .filter(|g| {
                    g.target.window == window
                        && g.target.session == session
                        && g.target.id == target_id
                        && target_current(s, &g.target)
                })
                .ok_or("The external voice authorization was revoked or its owner changed.")?;
            allowed(v, &g.target.surface.space_id, true)?;
            Ok(true)
        })
    }
    pub(crate) fn release(
        &self,
        window: &str,
        session: &str,
        target_id: &str,
        grant_id: &str,
    ) -> Result<(), String> {
        identifiers(session, grant_id, target_id)?;
        let mut s = self
            .state
            .lock()
            .map_err(|_| "Voice work-order mailbox was interrupted.")?;
        if s.grants.get(grant_id).is_some_and(|g| {
            g.target.window == window && g.target.session == session && g.target.id == target_id
        }) {
            s.grants.remove(grant_id);
        }
        Ok(())
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
            s.grants.retain(|_, g| g.target.window != window);
            s.entries.retain(|_, e| e.target.window != window);
        }
    }
}
fn identifiers(session: &str, id: &str, target: &str) -> Result<(), String> {
    protocol::identifier(session, 128)?;
    protocol::identifier(id, 200)?;
    protocol::identifier(target, 200)
}

#[tauri::command]
pub fn voice_work_orders_poll(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    target: Option<VoiceSurface>,
) -> Result<Value, String> {
    if let Some(t) = &target {
        if !crate::desktop_windows::voice_target_matches(
            window.app_handle(),
            window.label(),
            &t.space_id,
        ) {
            return Err("This Space is not owned by this voice window.".into());
        }
    }
    bridge
        .voice_work_orders
        .poll(window.label(), &session_id, target)
}
#[tauri::command]
pub fn voice_work_orders_claim(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    target_id: String,
    admitted_revision: Option<u64>,
) -> Result<Value, String> {
    bridge.voice_work_orders.claim(
        window.label(),
        &session_id,
        &id,
        &target_id,
        admitted_revision,
    )
}
#[tauri::command]
pub fn voice_work_orders_respond(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    id: String,
    target_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<Value, String> {
    bridge
        .voice_work_orders
        .respond(window.label(), &session_id, &id, &target_id, result, error)
}
#[tauri::command]
pub fn voice_work_orders_authorize(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    target_id: String,
    grant_id: String,
) -> Result<bool, String> {
    bridge
        .voice_work_orders
        .authorize(window.label(), &session_id, &target_id, &grant_id)
}
#[tauri::command]
pub fn voice_work_orders_release(
    window: WebviewWindow,
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    target_id: String,
    grant_id: String,
) -> Result<(), String> {
    bridge
        .voice_work_orders
        .release(window.label(), &session_id, &target_id, &grant_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn vault() -> Value {
        json!({"schemaVersion":2,"activeSpaceId":"a","updatedAt":"1","spaces":[{"schemaVersion":1,"workspace":{"id":"a"},"notes":[],"settings":{"includeExistingNotesInAIContext":true,"assistantAccess":{"enabled":true,"allowAI":true,"allowWrites":false,"spaceIds":["a","b"]}}},{"schemaVersion":1,"workspace":{"id":"b"},"notes":[],"settings":{"includeExistingNotesInAIContext":true}}]})
    }
    fn store() -> (tempfile::TempDir, VoiceWorkOrdersStore) {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("vault.json");
        crate::write_vault_file(&path, &vault()).unwrap();
        (d, VoiceWorkOrdersStore::new(path))
    }
    fn surface(space: &str) -> Option<VoiceSurface> {
        Some(VoiceSurface {
            space_id: space.into(),
            ready: true,
        })
    }
    fn register(s: &VoiceWorkOrdersStore, window: &str, session: &str, space: &str) -> String {
        s.poll(window, session, surface(space)).unwrap()["targetId"]
            .as_str()
            .unwrap()
            .into()
    }
    fn change(s: &VoiceWorkOrdersStore, key: &str, value: Value) {
        let mut v = crate::read_vault_file(&s.path).unwrap().unwrap();
        v["spaces"][0]["settings"]["assistantAccess"][key] = value;
        crate::write_vault_file(&s.path, &v).unwrap();
    }
    fn list(s: &VoiceWorkOrdersStore, t: &str) -> String {
        s.handle("voice_list", json!({"space_id":"a","voice_target_id":t}))
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn get(s: &VoiceWorkOrdersStore, id: &str) -> Result<Value, String> {
        s.handle("voice_request_get", json!({"space_id":"a","request_id":id}))
    }
    fn control(t: &str, action: &str) -> Value {
        let mut v = json!({"space_id":"a","voice_target_id":t,"work_order_id":"w","expected_revision":1,"expected_control_version":"v1","request_id":"r1","action":action});
        if action == "steer" {
            v["direction"] = json!("Investigate the opposing interpretation.");
        }
        v
    }
    fn submitted(s: &VoiceWorkOrdersStore, t: &str, action: &str) -> String {
        s.handle("voice_control", control(t, action)).unwrap()["id"]
            .as_str()
            .unwrap()
            .into()
    }
    fn empty(t: &str) -> Value {
        json!({"spaceId":"a","voiceTargetId":t,"taskView":"working","inventoryVersion":"i1","offset":0,"limit":20,"total":0,"nextOffset":null,"items":[]})
    }
    fn receipt(t: &str, action: &str, revision: u64) -> Value {
        let mut v = json!({"spaceId":"a","voiceTargetId":t,"requestId":"r1","controlVersion":"v2","id":"w","revision":revision,"action":action,"state":"running","changed":true});
        if action != "cancel" {
            v["readOnly"] = json!(true);
        } else {
            v["state"] = json!("cancelled");
        }
        v
    }
    #[test]
    fn voice_work_orders_reads_and_cancel_need_no_ai_or_write_and_never_mutate_vault() {
        let (_d, s) = store();
        change(&s, "allowAI", json!(false));
        let before = std::fs::read(&s.path).unwrap();
        let t = register(&s, "main", "session", "a");
        let id = list(&s, &t);
        assert_eq!(get(&s, &id).unwrap()["state"], "pending");
        assert!(s
            .respond("main", "session", &id, &t, Some(empty(&t)), None)
            .is_err());
        s.poll("main", "session", surface("a")).unwrap();
        s.respond("main", "session", &id, &t, Some(empty(&t)), None)
            .unwrap();
        assert_eq!(get(&s, &id).unwrap()["state"], "succeeded");
        let id = submitted(&s, &t, "cancel");
        s.poll("main", "session", surface("a")).unwrap();
        assert!(s
            .respond(
                "main",
                "session",
                &id,
                &t,
                Some(receipt(&t, "cancel", 1)),
                None
            )
            .is_err());
        assert_eq!(
            s.claim("main", "session", &id, &t, None).unwrap()["grantId"],
            Value::Null
        );
        s.respond(
            "main",
            "session",
            &id,
            &t,
            Some(receipt(&t, "cancel", 1)),
            None,
        )
        .unwrap();
        assert!(s.handle("voice_control", control(&t, "retry")).is_err());
        assert_eq!(std::fs::read(&s.path).unwrap(), before);
    }
    #[test]
    fn voice_work_orders_control_identity_claim_and_receipt_are_idempotent() {
        let (_d, s) = store();
        let t = register(&s, "main", "session", "a");
        let request = control(&t, "steer");
        let id = submitted(&s, &t, "steer");
        assert_eq!(
            s.handle("voice_control", request.clone()).unwrap()["id"],
            id
        );
        let mut changed = request.clone();
        changed["direction"] = json!("Different instruction");
        assert!(s.handle("voice_control", changed).is_err());
        assert!(s.claim("main", "session", &id, &t, Some(2)).is_err());
        s.poll("main", "session", surface("a")).unwrap();
        assert!(s.claim("main", "session", &id, &t, Some(3)).is_err());
        let grant = s.claim("main", "session", &id, &t, Some(2)).unwrap()["grantId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(s.claim("main", "session", &id, &t, Some(2)).is_err());
        assert!(s.authorize("main", "session", &t, &grant).unwrap());
        assert!(s
            .respond(
                "main",
                "session",
                &id,
                &t,
                Some(receipt(&t, "steer", 1)),
                None
            )
            .is_err());
        s.respond(
            "main",
            "session",
            &id,
            &t,
            Some(receipt(&t, "steer", 2)),
            None,
        )
        .unwrap();
        let done = s.handle("voice_control", request).unwrap();
        assert_eq!(done["state"], "succeeded");
        assert_eq!(done["result"]["revision"], 2);
        s.release("main", "session", &t, &grant).unwrap();
        assert!(s.authorize("main", "session", &t, &grant).is_err());
    }
    #[test]
    fn voice_work_orders_grants_revoke_on_fresh_permissions_and_do_not_revive() {
        let (_d, s) = store();
        let t = register(&s, "main", "session", "a");
        let id = submitted(&s, &t, "retry");
        s.poll("main", "session", surface("a")).unwrap();
        let grant = s.claim("main", "session", &id, &t, Some(2)).unwrap()["grantId"]
            .as_str()
            .unwrap()
            .to_owned();
        change(&s, "allowAI", json!(false));
        assert!(s.authorize("main", "session", &t, &grant).is_err());
        let poll = s.poll("main", "session", surface("a")).unwrap();
        assert_eq!(poll["targetId"], t);
        assert_eq!(poll["grants"], json!([]));
        assert_eq!(poll["allowAI"], false);
        assert_eq!(get(&s, &id).unwrap()["state"], "failed");
        change(&s, "allowAI", json!(true));
        assert!(s.authorize("main", "session", &t, &grant).is_err());
        assert!(s
            .respond(
                "main",
                "session",
                &id,
                &t,
                Some(receipt(&t, "retry", 2)),
                None
            )
            .is_err());
        assert!(s
            .handle("voice_list", json!({"space_id":"a","voice_target_id":t}))
            .is_ok());
    }
    #[test]
    fn voice_work_orders_terminal_release_preserves_receipt_but_not_execution_authority() {
        for revoked in [false, true] {
            let (_d, s) = store();
            let target = register(&s, "main", "session", "a");
            let id = submitted(&s, &target, "retry");
            s.poll("main", "session", surface("a")).unwrap();
            let grant = s.claim("main", "session", &id, &target, Some(2)).unwrap()["grantId"]
                .as_str()
                .unwrap()
                .to_owned();
            s.release("main", "session", &target, &grant).unwrap();
            assert!(s.authorize("main", "session", &target, &grant).is_err());
            if revoked {
                change(&s, "allowAI", json!(false));
                s.poll("main", "session", surface("a")).unwrap();
                change(&s, "allowAI", json!(true));
            }
            let result = s.respond(
                "main",
                "session",
                &id,
                &target,
                Some(receipt(&target, "retry", 2)),
                None,
            );
            assert_eq!(result.is_ok(), !revoked);
            assert_eq!(
                get(&s, &id).unwrap()["state"],
                if revoked { "failed" } else { "succeeded" }
            );
        }
    }
    #[test]
    fn voice_work_orders_external_grants_are_bounded_and_reserved_revision_one_is_valid() {
        let (_d, s) = store();
        let target = register(&s, "main", "session", "a");
        for index in 0..MAX_GRANTS {
            let mut request = control(&target, "steer");
            request["request_id"] = json!(format!("r{index}"));
            request["work_order_id"] = json!(format!("w{index}"));
            let id = s.handle("voice_control", request).unwrap()["id"]
                .as_str()
                .unwrap()
                .to_owned();
            s.poll("main", "session", surface("a")).unwrap();
            s.claim("main", "session", &id, &target, Some(1)).unwrap();
            let mut result = receipt(&target, "steer", 1);
            result["requestId"] = json!(format!("r{index}"));
            result["id"] = json!(format!("w{index}"));
            s.respond("main", "session", &id, &target, Some(result), None)
                .unwrap();
        }
        let id = submitted(&s, &target, "retry");
        s.poll("main", "session", surface("a")).unwrap();
        assert!(s.claim("main", "session", &id, &target, Some(2)).is_err());
        assert_eq!(s.state.lock().unwrap().grants.len(), MAX_GRANTS);
        s.close_window("main");
        assert!(s.state.lock().unwrap().grants.is_empty());
    }
    #[test]
    fn voice_work_orders_window_session_space_and_retired_session_are_exact() {
        let (_d, s) = store();
        let t = register(&s, "main", "old", "a");
        let t2 = register(&s, "other", "session", "a");
        assert_ne!(t, t2);
        let id = submitted(&s, &t, "retry");
        s.poll("main", "old", surface("a")).unwrap();
        for (window, session, target) in [
            ("other", "session", t.as_str()),
            ("main", "old", t2.as_str()),
            ("main", "fresh", t.as_str()),
        ] {
            assert!(s.claim(window, session, &id, target, Some(2)).is_err());
        }
        assert!(s
            .handle("voice_list", json!({"space_id":"b","voice_target_id":t}))
            .is_err());
        let fresh = register(&s, "main", "fresh", "a");
        s.poll("main", "old", None).unwrap();
        s.poll("main", "old", surface("a")).unwrap();
        assert_eq!(
            s.poll("main", "fresh", surface("a")).unwrap()["targetId"],
            fresh
        );
        assert_eq!(get(&s, &id).unwrap()["state"], "failed");
        let next = register(&s, "main", "fresh", "b");
        assert_ne!(next, fresh);
        assert!(s
            .handle(
                "voice_list",
                json!({"space_id":"a","voice_target_id":fresh})
            )
            .is_err());
        s.close_window("main");
        assert!(s
            .handle("voice_list", json!({"space_id":"b","voice_target_id":next}))
            .is_err());
    }
    #[test]
    fn voice_work_orders_request_deadline_lease_and_memory_bounds() {
        let (_d, s) = store();
        let t = register(&s, "main", "session", "a");
        let id = list(&s, &t);
        s.state
            .lock()
            .unwrap()
            .entries
            .get_mut(&id)
            .unwrap()
            .started = Instant::now() - DEADLINE;
        s.expire();
        assert_eq!(get(&s, &id).unwrap()["state"], "failed");
        for _ in 0..MAX_PENDING {
            list(&s, &t);
        }
        assert!(s
            .handle("voice_list", json!({"space_id":"a","voice_target_id":t}))
            .is_err());
        {
            let mut state = s.state.lock().unwrap();
            for e in state.entries.values_mut() {
                e.started = Instant::now() - DEADLINE;
            }
        }
        s.expire();
        for _ in 0..40 {
            let id = list(&s, &t);
            s.poll("main", "session", surface("a")).unwrap();
            s.respond("main", "session", &id, &t, Some(empty(&t)), None)
                .unwrap();
        }
        assert!(s.state.lock().unwrap().entries.len() <= MAX_RECEIPTS);
        s.state
            .lock()
            .unwrap()
            .targets
            .get_mut("main")
            .unwrap()
            .seen = Instant::now() - LEASE - Duration::from_secs(1);
        s.expire();
        assert_eq!(s.capabilities().unwrap()["voiceTargets"], json!([]));
    }
    #[test]
    fn voice_work_orders_readiness_and_invalid_renderer_payload_fail_closed() {
        let (_d, s) = store();
        let t = s
            .poll(
                "main",
                "session",
                Some(VoiceSurface {
                    space_id: "a".into(),
                    ready: false,
                }),
            )
            .unwrap()["targetId"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(s.handle("voice_control", control(&t, "retry")).is_err());
        let id = list(&s, &t);
        s.poll("main", "session", surface("a")).unwrap();
        let mut bad = empty(&t);
        bad["transcript"] = json!("Not public");
        assert!(s
            .respond("main", "session", &id, &t, Some(bad), None)
            .is_err());
        s.respond(
            "main",
            "session",
            &id,
            &t,
            None,
            Some("Inventory changed. Refresh it.".into()),
        )
        .unwrap();
        assert_eq!(get(&s, &id).unwrap()["state"], "failed");
    }
    #[cfg(unix)]
    #[test]
    fn voice_work_orders_real_socket_is_authenticated_nonblocking_and_read_only() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixStream;
        let (d, s) = store();
        let bridge = AssistantBridge::new(s.path.clone());
        let t = register(&bridge.voice_work_orders, "main", "session", "a");
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
                &json!({"version":1,"token":token,"method":method,"arguments":args}),
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
        assert_eq!(caps["result"]["voiceTargets"][0]["id"], t);
        assert_eq!(caps["result"]["available"], true);
        assert_eq!(caps["result"]["workflowExecutorAvailable"], false);
        let now = Instant::now();
        let r = call(
            "voice_list",
            json!({"space_id":"a","voice_target_id":t}),
            token,
        );
        let id = r["result"]["id"].as_str().unwrap();
        assert_eq!(
            call(
                "voice_request_get",
                json!({"space_id":"a","request_id":id}),
                token
            )["result"]["state"],
            "pending"
        );
        assert_eq!(call("capabilities", json!({}), token)["ok"], true);
        assert!(now.elapsed() < Duration::from_secs(1));
        bridge
            .voice_work_orders
            .poll("main", "session", surface("a"))
            .unwrap();
        bridge
            .voice_work_orders
            .respond("main", "session", id, &t, Some(empty(&t)), None)
            .unwrap();
        assert_eq!(
            call(
                "voice_request_get",
                json!({"space_id":"a","request_id":id}),
                token
            )["result"]["state"],
            "succeeded"
        );
        assert_eq!(std::fs::read(&s.path).unwrap(), before);
    }
}
