//! Opt-in local workflow broker. It never executes model-supplied commands.
//! The renderer runs shared workflows; this host owns access, jobs, and commit.
use crate::assistant_protocol::{
    self as protocol, Access, BridgeDescriptor, Operation, StartRequest,
};
use fs2::FileExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{hash_map::DefaultHasher, HashMap, VecDeque},
    fs::{self, File},
    hash::{Hash, Hasher},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, State};

const MAX_JOBS: usize = 32;
const MAX_QUEUED: usize = 8;
const MAX_RETAINED_INPUT_BYTES: usize = 16 * 1024 * 1024;
const RESULT_TTL: Duration = Duration::from_secs(3_600);
const RENDERER_LEASE: Duration = Duration::from_secs(30);
const JOB_DEADLINE: Duration = Duration::from_secs(20 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    id: String,
    space_id: String,
    operation: Operation,
    state: String,
    stage: String,
    created_at: u64,
    updated_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

struct Job {
    view: JobView,
    request: StartRequest,
    fingerprint: u64,
    input_bytes: usize,
    policy: Value,
    base_content: Option<u64>,
    session_id: Option<String>,
    touched: Instant,
}

#[derive(Default)]
struct Jobs {
    entries: HashMap<String, Job>,
    order: VecDeque<String>,
    renderer: Option<(String, Instant)>,
}

#[derive(Clone)]
pub struct AssistantBridge {
    path: PathBuf,
    jobs: Arc<Mutex<Jobs>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn terminal(state: &str) -> bool {
    matches!(state, "succeeded" | "failed" | "cancelled")
}

fn failure(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "error": {"code": code, "message": message.into()}})
}

fn success(value: Value) -> Value {
    json!({"ok": true, "result": value})
}

fn read_vault(path: &Path) -> Result<Value, String> {
    let lock = crate::vault_lock_file(path)?;
    lock.lock_shared()
        .map_err(|_| "The library is busy.".to_string())?;
    let value = crate::read_vault_file(path)?
        .ok_or_else(|| "Open Orion once to create its local library.".to_string())?;
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(2)
        || !value.get("spaces").is_some_and(Value::is_array)
    {
        return Err("The Orion library has an invalid or unsupported schema.".into());
    }
    Ok(value)
}

fn space<'a>(vault: &'a Value, space_id: &str) -> Result<&'a Value, String> {
    let spaces = vault
        .get("spaces")
        .and_then(Value::as_array)
        .ok_or("The Orion library has no valid Space directory.")?;
    let matches: Vec<_> = spaces
        .iter()
        .filter(|space| space.pointer("/workspace/id").and_then(Value::as_str) == Some(space_id))
        .collect();
    if matches.len() != 1 || matches[0].get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("The exact Space does not exist or has an invalid schema.".into());
    }
    Ok(matches[0])
}

fn access(vault: &Value) -> Result<Access, String> {
    let active_id = vault
        .get("activeSpaceId")
        .and_then(Value::as_str)
        .ok_or("The library has no active Space.")?;
    let settings = space(vault, active_id)?
        .get("settings")
        .ok_or("The Space has no settings.")?;
    let value = settings
        .get("assistantAccess")
        .cloned()
        .unwrap_or(json!({}));
    let access: Access =
        serde_json::from_value(value).map_err(|_| "Invalid assistant permissions.")?;
    if access.space_ids.len() > 500 {
        return Err("Invalid assistant Space selection.".into());
    }
    Ok(access)
}

fn policy(vault: &Value, request: &StartRequest) -> Result<Value, String> {
    let scope = space(vault, &request.space_id)?;
    let access = access(vault)?;
    if !access.enabled || !access.space_ids.contains(&request.space_id) {
        return Err(
            "Enable desktop workflows for this Space in Orion Settings → Connections.".into(),
        );
    }
    if request.uses_ai() && !access.allow_ai {
        return Err("Allow connected assistants to use Orion AI in Settings → Connections.".into());
    }
    if request.writes() && !access.allow_writes {
        return Err("Allow workflow writes in Orion Settings → Connections before importing or generating notes.".into());
    }
    let settings = scope.get("settings").ok_or("The Space has no settings.")?;
    if matches!(
        request.operation,
        Operation::Research
            | Operation::EnrichKnowledge
            | Operation::DevelopConcept
            | Operation::RefreshOverview
    ) && settings.get("includeExistingNotesInAIContext") != Some(&json!(true))
    {
        return Err("Existing-note AI context is off. Enable it in Orion to research or enrich Space knowledge.".into());
    }
    Ok(json!({
        "model": settings.get("model"),
        "reasoningEffort": settings.get("reasoningEffort"),
        "includeExistingNotesInAIContext": settings.get("includeExistingNotesInAIContext"),
        "organizationInstructions": settings.get("organizationInstructions"),
        "providerFailoverEnabled": settings.get("providerFailoverEnabled"),
    }))
}

impl AssistantBridge {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            jobs: Arc::new(Mutex::new(Jobs::default())),
        }
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Jobs>, String> {
        self.jobs
            .lock()
            .map_err(|_| "Orion's desktop workflow queue was interrupted.".into())
    }

    fn expire(jobs: &mut Jobs) {
        for job in jobs.entries.values_mut().filter(|job| {
            matches!(job.view.state.as_str(), "queued" | "running")
                && job.touched.elapsed() > JOB_DEADLINE
        }) {
            Self::end_job(job, "cancelled", None, Some("This workflow reached its 20-minute limit. Remaining stages and late note commits were stopped.".into()));
        }
        let expired: Vec<_> = jobs
            .entries
            .iter()
            .filter(|(_, job)| terminal(&job.view.state) && job.touched.elapsed() > RESULT_TTL)
            .map(|(id, _)| id.clone())
            .collect();
        for id in expired {
            jobs.entries.remove(&id);
            jobs.order.retain(|value| value != &id);
        }
        if jobs
            .renderer
            .as_ref()
            .is_none_or(|(_, seen)| seen.elapsed() > RENDERER_LEASE)
        {
            for job in jobs
                .entries
                .values_mut()
                .filter(|job| job.view.state == "running")
            {
                Self::end_job(job, "failed", None, Some("Orion's workflow executor disconnected. The job was stopped; start a new request after reopening Orion.".into()));
            }
        }
    }

    fn end_job(job: &mut Job, state: &str, result: Option<Value>, error: Option<String>) {
        job.view.state = state.into();
        job.view.updated_at = now();
        job.view.result = result;
        job.view.error = error;
        job.request.input = json!({});
        job.input_bytes = 0;
        job.touched = Instant::now();
    }

    pub fn handle(&self, method: &str, arguments: Value) -> Value {
        let result = (|| -> Result<Value, String> {
            let vault = read_vault(&self.path)?;
            let mut jobs = self.lock()?;
            Self::expire(&mut jobs);
            match method {
                "capabilities" => {
                    let access = access(&vault)?;
                    let active_id = vault["activeSpaceId"].as_str().unwrap_or("");
                    let settings = &space(&vault, active_id)?["settings"];
                    Ok(json!({
                        "protocolVersion": protocol::BRIDGE_VERSION,
                        "appVersion": env!("CARGO_PKG_VERSION"),
                        "available": jobs.renderer.as_ref().is_some_and(|(_, seen)| seen.elapsed() <= RENDERER_LEASE),
                        "access": access,
                        "model": settings.get("model"),
                        "reasoningEffort": settings.get("reasoningEffort"),
                        "existingNoteContextEnabled": settings.get("includeExistingNotesInAIContext"),
                        "limits": {"queuedJobs":MAX_QUEUED,"retainedJobs":MAX_JOBS,"sourceInputs":12,"providerCalls":6},
                        "operations":["context","research","import","reprocess","generate","develop_concept","enrich_knowledge","refresh_overview"],
                        "notice":"Orion executes workflows while open. AI uses Orion's configured provider account. Context/results returned here are also shared with the calling assistant."
                    }))
                }
                "start" => {
                    let request: StartRequest = serde_json::from_value(arguments)
                        .map_err(|_| "The workflow request has an invalid schema.")?;
                    request.validate()?;
                    let captured_policy = policy(&vault, &request)?;
                    let encoded =
                        serde_json::to_vec(&request).map_err(|_| "Cannot encode this workflow.")?;
                    let mut hash = DefaultHasher::new();
                    encoded.hash(&mut hash);
                    let fingerprint = hash.finish();
                    if let Some(job) = jobs.entries.values().find(|job| {
                        job.request.space_id == request.space_id
                            && job.request.request_id == request.request_id
                    }) {
                        if job.fingerprint != fingerprint {
                            return Err("This request_id already identifies different work. Use a new request_id.".into());
                        }
                        return Ok(serde_json::to_value(&job.view).unwrap());
                    }
                    if jobs
                        .renderer
                        .as_ref()
                        .is_none_or(|(_, seen)| seen.elapsed() > RENDERER_LEASE)
                    {
                        return Err("Open Orion and wait for its library to finish loading before starting workflows.".into());
                    }
                    if jobs
                        .entries
                        .values()
                        .filter(|job| !terminal(&job.view.state))
                        .count()
                        >= MAX_QUEUED
                        || jobs
                            .entries
                            .values()
                            .map(|job| job.input_bytes)
                            .sum::<usize>()
                            + encoded.len()
                            > MAX_RETAINED_INPUT_BYTES
                    {
                        return Err(
                            "Orion's workflow queue is full. Wait for a job to finish.".into()
                        );
                    }
                    while jobs.entries.len() >= MAX_JOBS {
                        let Some(id) = jobs
                            .order
                            .iter()
                            .find(|id| {
                                jobs.entries
                                    .get(*id)
                                    .is_some_and(|job| terminal(&job.view.state))
                            })
                            .cloned()
                        else {
                            break;
                        };
                        jobs.order.retain(|value| value != &id);
                        jobs.entries.remove(&id);
                    }
                    let id = format!("job_{}", random_token()?);
                    let timestamp = now();
                    let view = JobView {
                        id: id.clone(),
                        space_id: request.space_id.clone(),
                        operation: request.operation,
                        state: "queued".into(),
                        stage: "Waiting for Orion".into(),
                        created_at: timestamp,
                        updated_at: timestamp,
                        result: None,
                        error: None,
                    };
                    jobs.order.push_back(id.clone());
                    jobs.entries.insert(
                        id,
                        Job {
                            view: view.clone(),
                            request,
                            fingerprint,
                            input_bytes: encoded.len(),
                            policy: captured_policy,
                            base_content: None,
                            session_id: None,
                            touched: Instant::now(),
                        },
                    );
                    Ok(serde_json::to_value(view).unwrap())
                }
                "get_job" | "cancel_job" => {
                    let space_id = arguments
                        .get("space_id")
                        .and_then(Value::as_str)
                        .ok_or("An exact space_id is required.")?;
                    let id = arguments
                        .get("job_id")
                        .and_then(Value::as_str)
                        .ok_or("An exact job_id is required.")?;
                    let job = jobs
                        .entries
                        .get_mut(id)
                        .filter(|job| job.view.space_id == space_id)
                        .ok_or(
                            "This job does not exist in the selected Space or its result expired.",
                        )?;
                    if method == "cancel_job" {
                        if job.view.state == "committing" {
                            return Err("This job is already committing its atomic save. Retrieve its result.".into());
                        }
                        if !terminal(&job.view.state) {
                            Self::end_job(
                                job,
                                "cancelled",
                                None,
                                Some("Cancelled by the connected assistant.".into()),
                            );
                        }
                    } else {
                        let grant = access(&vault)?;
                        if !grant.enabled || !grant.space_ids.contains(&space_id.to_string()) {
                            return Err("Workflow access to this Space is disabled.".into());
                        }
                    }
                    let mut view = serde_json::to_value(&job.view).unwrap();
                    // Cancellation remains available after access is revoked,
                    // but it must not become an alternate result-reading path.
                    if method == "cancel_job" {
                        view.as_object_mut().unwrap().remove("result");
                    }
                    if let Some(base) = &job.base_content {
                        view["freshness"] =
                            json!(if *base == knowledge_content(space(&vault, space_id)?) {
                                "current"
                            } else {
                                "stale"
                            });
                    }
                    Ok(view)
                }
                "list_jobs" => {
                    let space_id = arguments
                        .get("space_id")
                        .and_then(Value::as_str)
                        .ok_or("An exact space_id is required.")?;
                    let grant = access(&vault)?;
                    if !grant.enabled || !grant.space_ids.contains(&space_id.to_string()) {
                        return Err("Workflow access to this Space is disabled.".into());
                    }
                    let values: Vec<_> = jobs
                        .order
                        .iter()
                        .rev()
                        .filter_map(|id| jobs.entries.get(id))
                        .filter(|job| job.view.space_id == space_id)
                        .map(|job| {
                            let mut view = job.view.clone();
                            view.result = None;
                            view
                        })
                        .collect();
                    Ok(json!({"spaceId":space_id,"jobs":values}))
                }
                _ => Err("Unknown desktop workflow operation.".into()),
            }
        })();
        match result {
            Ok(value) => success(value),
            Err(message) => failure("workflow_unavailable", message),
        }
    }

    #[cfg(test)]
    pub fn poll(&self, session_id: &str) -> Result<Value, String> {
        self.poll_ready(session_id, true)
    }

    fn poll_ready(&self, session_id: &str, ready: bool) -> Result<Value, String> {
        protocol::bounded_text(session_id, "session_id", 128, true)?;
        // An idle heartbeat must not deserialize a mature vault every second.
        {
            let mut jobs = self.lock()?;
            Self::expire(&mut jobs);
            if !jobs.entries.values().any(|job| !terminal(&job.view.state)) {
                if jobs
                    .renderer
                    .as_ref()
                    .is_some_and(|(id, seen)| id != session_id && seen.elapsed() <= RENDERER_LEASE)
                {
                    return Err("Another Orion window owns the workflow executor.".into());
                }
                jobs.renderer = Some((session_id.into(), Instant::now()));
                let activity = activity(&jobs);
                let stopped: Vec<_> = jobs
                    .entries
                    .values()
                    .filter(|job| job.session_id.as_deref() == Some(session_id))
                    .map(|job| job.view.id.clone())
                    .collect();
                return Ok(json!({"jobs":[],"stoppedJobIds":stopped,"activity":activity}));
            }
        }
        let vault = read_vault(&self.path)?;
        let mut jobs = self.lock()?;
        Self::expire(&mut jobs);
        if jobs
            .renderer
            .as_ref()
            .is_some_and(|(id, seen)| id != session_id && seen.elapsed() <= RENDERER_LEASE)
        {
            return Err("Another Orion window owns the workflow executor.".into());
        }
        jobs.renderer = Some((session_id.into(), Instant::now()));
        for job in jobs
            .entries
            .values_mut()
            .filter(|job| matches!(job.view.state.as_str(), "queued" | "running"))
        {
            if let Err(error) = policy(&vault, &job.request).and_then(|current| {
                if current == job.policy {
                    Ok(())
                } else {
                    Err("Orion's AI or context settings changed during this job.".into())
                }
            }) {
                Self::end_job(job, "cancelled", None, Some(error));
            }
        }
        let cancelled: Vec<_> = jobs
            .entries
            .values()
            .filter(|job| {
                job.session_id.as_deref() == Some(session_id) && terminal(&job.view.state)
            })
            .map(|job| job.view.id.clone())
            .collect();
        let mut claimed = Vec::new();
        if ready
            && !jobs
                .entries
                .values()
                .any(|job| matches!(job.view.state.as_str(), "running" | "committing"))
        {
            if let Some(id) = jobs
                .order
                .iter()
                .find(|id| {
                    jobs.entries
                        .get(*id)
                        .is_some_and(|job| job.view.state == "queued")
                })
                .cloned()
            {
                let job = jobs.entries.get_mut(&id).unwrap();
                job.view.state = "running".into();
                job.view.stage = "Preparing".into();
                job.view.updated_at = now();
                job.session_id = Some(session_id.into());
                job.touched = Instant::now();
                claimed.push(json!({"id":id,"request":job.request}));
            }
        }
        Ok(json!({"jobs":claimed,"stoppedJobIds":cancelled,"activity":activity(&jobs)}))
    }

    pub fn assert_running(&self, id: &str, session_id: &str) -> Result<StartRequest, String> {
        let vault = read_vault(&self.path)?;
        let jobs = self.lock()?;
        let job = jobs
            .entries
            .get(id)
            .filter(|job| {
                job.view.state == "running" && job.session_id.as_deref() == Some(session_id)
            })
            .ok_or("This workflow is no longer running.")?;
        if policy(&vault, &job.request)? != job.policy {
            return Err("Orion's AI or context settings changed during this job.".into());
        }
        if job.base_content.as_ref().is_some_and(|base| {
            *base != knowledge_content(space(&vault, &job.request.space_id).unwrap_or(&Value::Null))
        }) {
            return Err("The Space changed while Orion was working. Start a new request against current knowledge.".into());
        }
        Ok(job.request.clone())
    }

    fn finish(
        &self,
        id: &str,
        session_id: &str,
        result: Option<Value>,
        error: Option<String>,
    ) -> Result<(), String> {
        let mut jobs = self.lock()?;
        let job = jobs
            .entries
            .get_mut(id)
            .filter(|job| job.session_id.as_deref() == Some(session_id))
            .ok_or("Unknown workflow execution.")?;
        if terminal(&job.view.state) {
            return Ok(());
        }
        if result.is_some() && job.request.writes() {
            return Err("A writing workflow must complete through its atomic save.".into());
        }
        if let Some(ref value) = result {
            validate_result(value)?;
        }
        Self::end_job(
            job,
            if error.is_some() {
                "failed"
            } else {
                "succeeded"
            },
            result,
            error.map(|value| value.chars().take(1_000).collect()),
        );
        Ok(())
    }

    #[cfg(unix)]
    pub fn start(&self) -> Result<(), String> {
        use std::os::unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        };
        let directory = self.path.parent().ok_or("No library directory.")?;
        fs::create_dir_all(directory)
            .map_err(|_| "Cannot prepare the local workflow connection.")?;
        let socket_path = directory.join("assistant.sock");
        if socket_path.exists() {
            if UnixStream::connect(&socket_path).is_ok() {
                return Err("Another Orion process already owns the workflow connection.".into());
            }
            fs::remove_file(&socket_path)
                .map_err(|_| "Cannot clear the expired workflow connection.")?;
        }
        let listener = UnixListener::bind(&socket_path)
            .map_err(|_| "Cannot start Orion's private workflow connection.")?;
        fs::set_permissions(&socket_path, fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot protect the workflow connection.")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Cannot configure the workflow connection.")?;
        let token = random_token()?;
        let descriptor = BridgeDescriptor {
            version: protocol::BRIDGE_VERSION,
            socket_path: socket_path.to_string_lossy().into(),
            vault_path: self.path.to_string_lossy().into(),
            token: token.clone(),
        };
        let mut temporary = tempfile::NamedTempFile::new_in(directory)
            .map_err(|_| "Cannot prepare the workflow descriptor.")?;
        temporary
            .as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|_| "Cannot protect the workflow descriptor.")?;
        serde_json::to_writer(temporary.as_file_mut(), &descriptor)
            .map_err(|_| "Cannot encode the workflow descriptor.")?;
        temporary
            .as_file_mut()
            .flush()
            .map_err(|_| "Cannot flush the workflow descriptor.")?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| "Cannot sync the workflow descriptor.")?;
        temporary
            .persist(directory.join(protocol::BRIDGE_DESCRIPTOR))
            .map_err(|_| "Cannot publish the workflow descriptor.")?;
        let weak = Arc::downgrade(&self.jobs);
        let path = self.path.clone();
        std::thread::spawn(move || {
            while let Some(jobs) = weak.upgrade() {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
                        let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
                        let bridge = AssistantBridge {
                            path: path.clone(),
                            jobs,
                        };
                        let mut line = String::new();
                        let read = BufReader::new(
                            (&mut stream).take(protocol::MAX_BRIDGE_REQUEST_BYTES + 1),
                        )
                        .read_line(&mut line);
                        let reply = if read.is_err()
                            || line.len() as u64 > protocol::MAX_BRIDGE_REQUEST_BYTES
                        {
                            failure(
                                "invalid_request",
                                "The desktop request is incomplete or too large.",
                            )
                        } else {
                            match serde_json::from_str::<Value>(&line) {
                                Ok(value) if value["version"]==json!(protocol::BRIDGE_VERSION) && token_matches(value["token"].as_str().unwrap_or(""),&token)=> {
                                    bridge.handle(value["method"].as_str().unwrap_or(""),value["arguments"].clone())
                                }
                                _=>failure("unauthorized","The private desktop connection could not authenticate this request."),
                            }
                        };
                        let _ = serde_json::to_writer(&mut stream, &reply);
                        let _ = stream.write_all(b"\n");
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(40))
                    }
                    Err(_) => break,
                }
            }
            let _ = fs::remove_file(socket_path);
        });
        Ok(())
    }

    #[cfg(not(unix))]
    pub fn start(&self) -> Result<(), String> {
        Ok(())
    }
}

fn activity(jobs: &Jobs) -> Vec<JobView> {
    jobs.order
        .iter()
        .rev()
        .take(8)
        .filter_map(|id| jobs.entries.get(id))
        .map(|job| {
            let mut view = job.view.clone();
            view.result = None;
            view
        })
        .collect()
}

fn knowledge_content(space: &Value) -> u64 {
    let mut notes = space["notes"].clone();
    if let Some(notes) = notes.as_array_mut() {
        for note in notes {
            if let Some(note) = note.as_object_mut() {
                note.remove("lastOpenedAt");
            }
        }
    }
    let value = json!({"workspace":space["workspace"],"notes":notes,"sources":space["sources"],"concepts":space["concepts"],"relationships":space["relationships"]});
    let mut hash = DefaultHasher::new();
    value.to_string().hash(&mut hash);
    hash.finish()
}

fn validate_result(value: &Value) -> Result<(), String> {
    if !value.is_object()
        || serde_json::to_vec(value)
            .map_err(|_| "Invalid result.")?
            .len()
            > protocol::MAX_BRIDGE_RESULT_BYTES
    {
        return Err("The workflow result exceeds its bounded object contract.".into());
    }
    Ok(())
}

fn token_matches(left: &str, right: &str) -> bool {
    left.len() == right.len()
        && left
            .bytes()
            .zip(right.bytes())
            .fold(0u8, |sum, (a, b)| sum | (a ^ b))
            == 0
}

#[cfg(unix)]
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| "Cannot create a private workflow token.".to_string())?;
    Ok(bytes.iter().map(|value| format!("{value:02x}")).collect())
}
#[cfg(not(unix))]
fn random_token() -> Result<String, String> {
    Err("Desktop workflows currently require macOS.".into())
}

#[tauri::command]
pub fn assistant_poll(
    bridge: State<'_, AssistantBridge>,
    session_id: String,
    ready: Option<bool>,
) -> Result<Value, String> {
    bridge.poll_ready(&session_id, ready.unwrap_or(true))
}

#[tauri::command]
pub fn assistant_assert_job(
    bridge: State<'_, AssistantBridge>,
    job_id: String,
    session_id: String,
) -> Result<(), String> {
    bridge.assert_running(&job_id, &session_id).map(|_| ())
}

#[tauri::command]
pub fn assistant_begin_context(
    bridge: State<'_, AssistantBridge>,
    job_id: String,
    session_id: String,
    expected_updated_at: String,
) -> Result<(), String> {
    let request = bridge.assert_running(&job_id, &session_id)?;
    let vault = read_vault(&bridge.path)?;
    if vault["updatedAt"].as_str() != Some(&expected_updated_at) {
        return Err(
            "The library changed before this workflow began. Retry with a new request_id.".into(),
        );
    }
    let mut jobs = bridge.lock()?;
    let job = jobs
        .entries
        .get_mut(&job_id)
        .filter(|job| job.view.state == "running")
        .ok_or("This workflow stopped.")?;
    if job.base_content.is_some() {
        return Err("This workflow already captured its context.".into());
    }
    job.base_content = Some(knowledge_content(space(&vault, &request.space_id)?));
    Ok(())
}

#[tauri::command]
pub fn assistant_previous_result(
    bridge: State<'_, AssistantBridge>,
    job_id: String,
    session_id: String,
    previous_job_id: String,
) -> Result<Value, String> {
    let request = bridge.assert_running(&job_id, &session_id)?;
    if request.operation != Operation::Research
        || request.input["previous_job_id"].as_str() != Some(&previous_job_id)
    {
        return Err("This job did not request that prior result.".into());
    }
    let jobs = bridge.lock()?;
    let prior = jobs
        .entries
        .get(&previous_job_id)
        .filter(|job| {
            job.view.space_id == request.space_id
                && job.view.state == "succeeded"
                && job.view.operation == Operation::Research
        })
        .ok_or("The prior research result is unavailable in this exact Space.")?;
    prior
        .view
        .result
        .clone()
        .ok_or("The prior research result expired.".into())
}

#[tauri::command]
pub fn assistant_cancel(
    bridge: State<'_, AssistantBridge>,
    space_id: String,
    job_id: String,
) -> Result<Value, String> {
    let result = bridge.handle("cancel_job", json!({"space_id":space_id,"job_id":job_id}));
    if result["ok"] == true {
        Ok(result["result"].clone())
    } else {
        Err(result["error"]["message"]
            .as_str()
            .unwrap_or("Cannot cancel this workflow.")
            .into())
    }
}

/// Reads only a file explicitly present in this job's validated import request.
#[tauri::command]
pub async fn assistant_read_input(
    app: AppHandle,
    bridge: State<'_, AssistantBridge>,
    job_id: String,
    session_id: String,
    index: usize,
) -> Result<Value, String> {
    use base64::Engine as _;
    let request = bridge.assert_running(&job_id, &session_id)?;
    if request.operation != Operation::Import {
        return Err("This job is not a file import.".into());
    }
    let input: protocol::ImportRequest =
        serde_json::from_value(request.input).map_err(|_| "Invalid import input.")?;
    let Some(protocol::ImportInput::File { path }) = input.inputs.get(index) else {
        return Err("This job did not request that file.".into());
    };
    let path = fs::canonicalize(path).map_err(|_| "The selected import file is unavailable.")?;
    let metadata = fs::metadata(&path).map_err(|_| "Cannot inspect the import file.")?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err("Choose a nonempty regular file.".into());
    }
    if crate::media_extension(&path).is_some() {
        let vault = read_vault(&bridge.path)?;
        let config = crate::WhisperConfig {
            language: space(&vault, &request.space_id)?["settings"]["whisperLanguage"]
                .as_str()
                .map(str::to_owned),
        };
        let runtime = crate::bundled_transcription_runtime(&app)?;
        let transcript = crate::transcribe_path(&runtime, &config, &path, None, None).await?;
        bridge.assert_running(&job_id, &session_id)?;
        return Ok(json!({"kind":"transcript","transcript":transcript}));
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ![
        "txt", "md", "markdown", "json", "csv", "tsv", "html", "htm", "pdf", "docx", "png", "jpg",
        "jpeg", "heic", "heif",
    ]
    .contains(&extension.as_str())
        || metadata.len() > 25 * 1024 * 1024
    {
        return Err("Choose a supported document or image no larger than 25 MB.".into());
    }
    let file_name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let file = File::open(path).map_err(|_| "Cannot open the import file.")?;
        let mut bytes = Vec::new();
        file.take(25 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read the import file.")?;
        if bytes.len() > 25 * 1024 * 1024 {
            return Err("The import file grew beyond its 25 MB limit.");
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| "The file reader was interrupted.")??;
    bridge.assert_running(&job_id, &session_id)?;
    Ok(
        json!({"kind":"file","fileName":file_name,"base64Data":base64::engine::general_purpose::STANDARD.encode(bytes)}),
    )
}

#[tauri::command]
pub fn assistant_progress(
    bridge: State<'_, AssistantBridge>,
    job_id: String,
    session_id: String,
    stage: String,
) -> Result<(), String> {
    protocol::bounded_text(&stage, "stage", 200, true)?;
    bridge.assert_running(&job_id, &session_id)?;
    let mut jobs = bridge.lock()?;
    let job = jobs.entries.get_mut(&job_id).ok_or("Unknown workflow.")?;
    if job.view.state != "running" {
        return Err("This workflow stopped.".into());
    }
    job.view.stage = stage;
    job.view.updated_at = now();
    Ok(())
}

#[tauri::command]
pub fn assistant_finish(
    bridge: State<'_, AssistantBridge>,
    job_id: String,
    session_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    if error.is_none() {
        bridge.assert_running(&job_id, &session_id)?;
    }
    bridge.finish(&job_id, &session_id, result, error)
}

/// Reuse the app's advisory lock, revision check, and flushed atomic writer.
#[tauri::command]
pub async fn assistant_commit_vault(
    app: AppHandle,
    bridge: State<'_, AssistantBridge>,
    write_lock: State<'_, crate::VaultWriteLock>,
    job_id: String,
    session_id: String,
    vault: Value,
    expected_updated_at: String,
    result: Value,
) -> Result<(), String> {
    if crate::vault_path(&app)? != bridge.path {
        return Err("Workflow library mismatch.".into());
    }
    let bridge = bridge.inner().clone();
    let lock = Arc::clone(&write_lock.0);
    tauri::async_runtime::spawn_blocking(move || {
        perform_commit(
            &bridge,
            &lock,
            &job_id,
            &session_id,
            vault,
            &expected_updated_at,
            result,
        )
    })
    .await
    .map_err(|_| "The workflow save task was interrupted.".to_string())?
}

fn perform_commit(
    bridge: &AssistantBridge,
    lock: &Mutex<()>,
    job_id: &str,
    session_id: &str,
    vault: Value,
    expected_updated_at: &str,
    result: Value,
) -> Result<(), String> {
    validate_result(&result)?;
    let request = bridge.assert_running(job_id, session_id)?;
    if !request.writes() {
        return Err("Research and context workflows cannot change the library.".into());
    }
    let path = &bridge.path;
    let _guard = lock
        .lock()
        .map_err(|_| "The vault save queue was interrupted.")?;
    let file_lock = crate::vault_lock_file(&path)?;
    file_lock
        .lock_exclusive()
        .map_err(|_| "The library is busy.")?;
    let current = crate::read_vault_file(&path)?.ok_or("The library is missing.")?;
    let current_policy = policy(&current, &request)?;
    validate_commit_scope(&current, &vault, &request.space_id)?;
    {
        let mut jobs = bridge.lock()?;
        let job = jobs
            .entries
            .get_mut(job_id)
            .filter(|job| {
                job.view.state == "running" && job.session_id.as_deref() == Some(session_id)
            })
            .ok_or("This workflow stopped before saving.")?;
        if job.policy != current_policy {
            return Err("Orion's settings changed before saving.".into());
        }
        if job.base_content.as_ref()
            != Some(&knowledge_content(space(&current, &request.space_id)?))
        {
            return Err("The Space changed before saving this workflow.".into());
        }
        job.view.state = "committing".into();
        job.view.stage = "Saving".into();
    }
    let saved = crate::write_vault_file_if_current(&path, &vault, Some(expected_updated_at));
    let mut jobs = bridge.lock()?;
    let job = jobs
        .entries
        .get_mut(job_id)
        .ok_or("The workflow disappeared during its save.")?;
    match saved {
        Ok(()) => {
            job.base_content = Some(knowledge_content(space(&vault, &request.space_id)?));
            AssistantBridge::end_job(job, "succeeded", Some(result), None);
            Ok(())
        }
        Err(error) => {
            AssistantBridge::end_job(job, "failed", None, Some(error.clone()));
            Err(error)
        }
    }
}

fn validate_commit_scope(before: &Value, after: &Value, space_id: &str) -> Result<(), String> {
    let mut expected = before.clone();
    let proposed = space(after, space_id)?;
    let original = space(before, space_id)?;
    for field in ["notes", "sources"] {
        let old = original[field]
            .as_array()
            .ok_or("Invalid original Space content.")?;
        let new = proposed[field]
            .as_array()
            .ok_or("Invalid workflow Space content.")?;
        if old
            .iter()
            .any(|record| !new.iter().any(|item| item.get("id") == record.get("id")))
        {
            return Err("Desktop workflows cannot delete existing notes or sources.".into());
        }
    }
    let target = expected["spaces"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|candidate| {
            candidate.pointer("/workspace/id").and_then(Value::as_str) == Some(space_id)
        })
        .unwrap();
    for field in [
        "notes",
        "sources",
        "concepts",
        "relationships",
        "spaceKnowledge",
        "spaceOverview",
        "updatedAt",
    ] {
        match proposed.get(field) {
            Some(value) => {
                target
                    .as_object_mut()
                    .unwrap()
                    .insert(field.into(), value.clone());
            }
            None => {
                target.as_object_mut().unwrap().remove(field);
            }
        }
    }
    expected["updatedAt"] = after["updatedAt"].clone();
    if &expected != after {
        return Err("A workflow may change only knowledge inside its exact Space.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        json!({"schemaVersion":2,"activeSpaceId":"a","updatedAt":"v1","spaces":[
        {"schemaVersion":1,"workspace":{"id":"a"},"notes":[{"id":"n"}],"sources":[],"concepts":[],"relationships":[],"updatedAt":"v1",
        "settings":{"model":"selected-model","reasoningEffort":"high","includeExistingNotesInAIContext":true,"assistantAccess":{"enabled":true,"allowAI":true,"allowWrites":true,"spaceIds":["a"]}}},
        {"schemaVersion":1,"workspace":{"id":"b"},"notes":[],"sources":[],"settings":{}}]})
    }
    fn broker() -> (tempfile::TempDir, AssistantBridge) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        crate::write_vault_file(&path, &fixture()).unwrap();
        (dir, AssistantBridge::new(path))
    }

    #[test]
    fn jobs_are_scoped_idempotent_and_cancellable() {
        let (_dir, bridge) = broker();
        bridge.poll("renderer").unwrap();
        let args = json!({"space_id":"a","request_id":"one","operation":"research","input":{"question":"Why?"}});
        let first = bridge.handle("start", args.clone());
        assert_eq!(first["ok"], true);
        assert_eq!(first, bridge.handle("start", args.clone()));
        let mut changed = args.clone();
        changed["input"]["question"] = json!("Different");
        assert_eq!(bridge.handle("start", changed)["ok"], false);
        let id = first["result"]["id"].as_str().unwrap();
        assert_eq!(
            bridge.handle("get_job", json!({"space_id":"b","job_id":id}))["ok"],
            false
        );
        assert_eq!(
            bridge.poll("renderer").unwrap()["jobs"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(bridge.assert_running(id, "renderer").is_ok());
        assert_eq!(
            bridge.handle("cancel_job", json!({"space_id":"a","job_id":id}))["result"]["state"],
            "cancelled"
        );
        assert!(bridge.assert_running(id, "renderer").is_err());
    }

    #[test]
    fn permission_off_blocks_jobs_and_revocation_stops_running_work() {
        let (_dir, bridge) = broker();
        bridge.poll("renderer").unwrap();
        let args = json!({"space_id":"a","request_id":"one","operation":"research","input":{"question":"Why?"}});
        let first = bridge.handle("start", args.clone());
        let id = first["result"]["id"].as_str().unwrap();
        bridge.poll("renderer").unwrap();
        let mut vault = fixture();
        vault["spaces"][0]["settings"]["assistantAccess"]["allowAI"] = json!(false);
        crate::write_vault_file(&bridge.path, &vault).unwrap();
        assert!(bridge.assert_running(id, "renderer").is_err());
        assert_eq!(bridge.handle("start", args)["ok"], false);
        assert_eq!(bridge.poll("renderer").unwrap()["stoppedJobIds"][0], id);
    }

    #[test]
    fn cancellation_does_not_disclose_retained_results_after_revocation() {
        let (_dir, bridge) = broker();
        bridge.poll("renderer").unwrap();
        let started = bridge.handle("start", json!({"space_id":"a","request_id":"private-result","operation":"context","input":{"query":"Find"}}));
        let id = started["result"]["id"].as_str().unwrap();
        bridge.poll("renderer").unwrap();
        bridge
            .finish(
                id,
                "renderer",
                Some(json!({"evidence":"private context"})),
                None,
            )
            .unwrap();
        let mut vault = fixture();
        vault["spaces"][0]["settings"]["assistantAccess"]["enabled"] = json!(false);
        crate::write_vault_file(&bridge.path, &vault).unwrap();
        let arguments = json!({"space_id":"a","job_id":id});
        assert_eq!(bridge.handle("get_job", arguments.clone())["ok"], false);
        let cancelled = bridge.handle("cancel_job", arguments);
        assert_eq!(cancelled["ok"], true);
        assert_eq!(cancelled["result"]["state"], "succeeded");
        assert!(cancelled["result"].get("result").is_none());
    }

    #[test]
    fn commits_cannot_cross_spaces_change_settings_or_delete_notes() {
        let before = fixture();
        let mut after = before.clone();
        after["spaces"][0]["notes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"new"}));
        assert!(validate_commit_scope(&before, &after, "a").is_ok());
        after["spaces"][1]["notes"] = json!([{"id":"leak"}]);
        assert!(validate_commit_scope(&before, &after, "a").is_err());
        after = before.clone();
        after["spaces"][0]["settings"]["model"] = json!("other");
        assert!(validate_commit_scope(&before, &after, "a").is_err());
        after = before.clone();
        after["spaces"][0]["notes"] = json!([]);
        assert!(validate_commit_scope(&before, &after, "a").is_err());
    }

    #[test]
    fn read_only_jobs_cannot_finish_with_oversized_results() {
        assert!(
            validate_result(&json!({"body":"x".repeat(protocol::MAX_BRIDGE_RESULT_BYTES)}))
                .is_err()
        );
        assert!(!token_matches("wrong", "secret"));
        assert!(token_matches("secret", "secret"));
    }

    #[test]
    fn atomic_commit_uses_the_real_revision_writer_and_never_replays_after_cancel() {
        let (_dir, bridge) = broker();
        bridge.poll("renderer").unwrap();
        let start = bridge.handle("start", json!({"space_id":"a","request_id":"import","operation":"import","input":{"mode":"local","inputs":[{"kind":"text","title":"A","text":"B"}]}}));
        let id = start["result"]["id"].as_str().unwrap();
        bridge.poll("renderer").unwrap();
        bridge
            .lock()
            .unwrap()
            .entries
            .get_mut(id)
            .unwrap()
            .base_content = Some(knowledge_content(&fixture()["spaces"][0]));
        let mut proposed = fixture();
        proposed["updatedAt"] = json!("v2");
        proposed["spaces"][0]["notes"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"created"}));
        let lock = Mutex::new(());
        assert!(perform_commit(
            &bridge,
            &lock,
            id,
            "renderer",
            proposed.clone(),
            "wrong",
            json!({"saved":true})
        )
        .is_err());
        assert_eq!(
            crate::read_vault_file(&bridge.path).unwrap().unwrap(),
            fixture()
        );
        assert_eq!(
            bridge.handle("get_job", json!({"space_id":"a","job_id":id}))["result"]["state"],
            "failed"
        );
        let start = bridge.handle("start", json!({"space_id":"a","request_id":"import-two","operation":"import","input":{"mode":"local","inputs":[{"kind":"text","title":"A","text":"B"}]}}));
        let id = start["result"]["id"].as_str().unwrap();
        bridge.poll("renderer").unwrap();
        bridge
            .lock()
            .unwrap()
            .entries
            .get_mut(id)
            .unwrap()
            .base_content = Some(knowledge_content(&fixture()["spaces"][0]));
        perform_commit(
            &bridge,
            &lock,
            id,
            "renderer",
            proposed.clone(),
            "v1",
            json!({"saved":true}),
        )
        .unwrap();
        assert_eq!(
            crate::read_vault_file(&bridge.path).unwrap().unwrap(),
            proposed
        );
        assert_eq!(
            bridge.handle("get_job", json!({"space_id":"a","job_id":id}))["result"]["state"],
            "succeeded"
        );
        assert!(
            perform_commit(&bridge, &lock, id, "renderer", fixture(), "v2", json!({})).is_err()
        );
    }

    #[test]
    fn queue_bounds_renderer_ownership_and_snapshot_changes_are_enforced() {
        let (_dir, bridge) = broker();
        bridge.poll("renderer").unwrap();
        for index in 0..MAX_QUEUED {
            assert_eq!(bridge.handle("start",json!({"space_id":"a","request_id":format!("request-{index}"),"operation":"context","input":{"query":"Find"}}))["ok"],true);
        }
        assert_eq!(bridge.handle("start",json!({"space_id":"a","request_id":"overflow","operation":"context","input":{"query":"Find"}}))["ok"],false);
        assert!(bridge.poll("other-renderer").is_err());
        assert_eq!(
            bridge.poll_ready("renderer", false).unwrap()["jobs"],
            json!([])
        );
        let claim = bridge.poll("renderer").unwrap();
        let id = claim["jobs"][0]["id"].as_str().unwrap();
        bridge
            .lock()
            .unwrap()
            .entries
            .get_mut(id)
            .unwrap()
            .base_content = Some(knowledge_content(&fixture()["spaces"][0]));
        let mut changed = fixture();
        changed["spaces"][0]["notes"][0]["body"] = json!("New external edit");
        crate::write_vault_file(&bridge.path, &changed).unwrap();
        assert!(bridge.assert_running(id, "renderer").is_err());
        assert_eq!(
            bridge.handle("get_job", json!({"space_id":"a","job_id":id}))["result"]["freshness"],
            "stale"
        );
    }

    #[cfg(unix)]
    #[test]
    fn real_socket_authenticates_and_returns_native_job_state() {
        use std::os::unix::{fs::PermissionsExt, net::UnixStream};
        let (_dir, bridge) = broker();
        bridge.poll("renderer").unwrap();
        bridge.start().unwrap();
        let descriptor_path = bridge
            .path
            .parent()
            .unwrap()
            .join(protocol::BRIDGE_DESCRIPTOR);
        assert_eq!(
            fs::metadata(&descriptor_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let descriptor: BridgeDescriptor =
            serde_json::from_reader(File::open(&descriptor_path).unwrap()).unwrap();
        let exchange = |token: &str, method: &str, arguments: Value| {
            let mut stream = UnixStream::connect(&descriptor.socket_path).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            writeln!(stream,"{}",json!({"version":protocol::BRIDGE_VERSION,"token":token,"method":method,"arguments":arguments})).unwrap();
            let mut line = String::new();
            BufReader::new(stream).read_line(&mut line).unwrap();
            serde_json::from_str::<Value>(&line).unwrap()
        };
        assert_eq!(
            exchange("wrong", "capabilities", json!({}))["error"]["code"],
            "unauthorized"
        );
        assert_eq!(
            exchange(&descriptor.token, "capabilities", json!({}))["result"]["available"],
            true
        );
        let started = exchange(
            &descriptor.token,
            "start",
            json!({"space_id":"a","request_id":"wire","operation":"context","input":{"query":"Find"}}),
        );
        let id = started["result"]["id"].as_str().unwrap();
        bridge.poll("renderer").unwrap();
        bridge
            .finish(
                id,
                "renderer",
                Some(json!({"evidence":[],"coverage":{"exhaustive":false}})),
                None,
            )
            .unwrap();
        let result = exchange(
            &descriptor.token,
            "get_job",
            json!({"space_id":"a","job_id":id}),
        );
        assert_eq!(result["result"]["state"], "succeeded");
        assert!(!result.to_string().contains(&descriptor.token));
    }
}
