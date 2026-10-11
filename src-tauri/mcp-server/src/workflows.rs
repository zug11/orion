//! The connector transports typed requests to Orion. It never loads provider keys.
use crate::assistant_protocol::{self as protocol, BridgeDescriptor, Operation, StartRequest};
use crate::assistant_review_protocol::{self as review, ReviewLookupRequest, ReviewSubmitRequest};
use crate::editor_actions_protocol::{
    self as editor_action, CaptureRequest, LookupRequest as EditorActionLookupRequest,
    StartRequest as EditorActionStartRequest,
};
use crate::editor_context_protocol::{self as editor, EditorContextRequest};
use crate::voice_work_orders_protocol::{
    self as voice, VoiceControlRequest, VoiceGetRequest, VoiceListRequest,
};
use crate::{ToolFailure, ToolResult};
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    time::{Duration, Instant},
};

fn operation(name: &str) -> Option<Operation> {
    Some(match name {
        "orion_get_context" => Operation::Context,
        "orion_research" => Operation::Research,
        "orion_search_space" => Operation::Search,
        "orion_export_word" => Operation::Export,
        "orion_import" => Operation::Import,
        "orion_reprocess_sources" => Operation::Reprocess,
        "orion_generate" => Operation::Generate,
        "orion_develop_concept" => Operation::DevelopConcept,
        "orion_enrich_knowledge" => Operation::EnrichKnowledge,
        "orion_refresh_overview" => Operation::RefreshOverview,
        _ => return None,
    })
}

pub fn recognizes(name: &str) -> bool {
    operation(name).is_some()
        || matches!(
            name,
            "orion_get_capabilities"
                | "orion_get_job"
                | "orion_list_jobs"
                | "orion_cancel_job"
                | "orion_propose_note_edit"
                | "orion_get_edit_review"
                | "orion_cancel_edit_review"
                | "orion_get_editor_context"
                | "orion_capture_editor_action"
                | "orion_start_editor_action"
                | "orion_get_editor_action"
                | "orion_cancel_editor_action"
                | "orion_list_voice_work_orders"
                | "orion_get_voice_work_order"
                | "orion_control_voice_work_order"
        )
}

pub fn call(path: &Path, name: &str, arguments: &Map<String, Value>) -> ToolResult {
    if let Some(method) = editor_action_method(name) {
        return editor_action_call(path, method, arguments);
    }
    if let Some(method) = voice_method(name) {
        return voice_call(path, method, arguments);
    }
    if name == "orion_get_editor_context" {
        let request: EditorContextRequest =
            serde_json::from_value(Value::Object(arguments.clone())).map_err(|_| {
                ToolFailure::new("The editor context request does not match its schema.")
            })?;
        request.validate().map_err(ToolFailure::new)?;
        crate::read_vault(path)?;
        let started = Instant::now();
        let response = editor_exchange(
            path,
            "editor_context_request",
            serde_json::to_value(&request)
                .map_err(|_| ToolFailure::new("Invalid editor context request."))?,
            started,
        )?;
        let id = response["id"]
            .as_str()
            .ok_or_else(|| ToolFailure::new("Orion returned an invalid editor read identity."))?;
        editor::identifier(id, 200).map_err(ToolFailure::new)?;
        loop {
            if started.elapsed() >= Duration::from_millis(editor::REQUEST_TIMEOUT_MS) {
                return Err(ToolFailure::new(
                    "The editor did not respond in time. Read the current editor target again.",
                ));
            }
            let reply = editor_exchange(
                path,
                "editor_context_get",
                json!({"space_id":request.space_id,"request_id":id}),
                started,
            )?;
            match reply["state"].as_str() {
                Some("ready") if reply["context"].is_object() => {
                    return Ok(reply["context"].clone())
                }
                Some("pending") => std::thread::sleep(Duration::from_millis(200)),
                _ => {
                    return Err(ToolFailure::new(
                        "Orion returned an invalid editor context response.",
                    ))
                }
            }
        }
    }
    let mut input = arguments.clone();
    let (method, payload) = if name == "orion_propose_note_edit" {
        let request: ReviewSubmitRequest =
            serde_json::from_value(Value::Object(input)).map_err(|_| {
                ToolFailure::new("The note-edit review request does not match its schema.")
            })?;
        request.validate().map_err(ToolFailure::new)?;
        (
            "review_submit",
            serde_json::to_value(request)
                .map_err(|_| ToolFailure::new("Invalid note-edit review request."))?,
        )
    } else if matches!(name, "orion_get_edit_review" | "orion_cancel_edit_review") {
        let request: ReviewLookupRequest =
            serde_json::from_value(Value::Object(input)).map_err(|_| {
                ToolFailure::new("The note-edit review lookup does not match its schema.")
            })?;
        request.validate().map_err(ToolFailure::new)?;
        (
            if name == "orion_get_edit_review" {
                "review_get"
            } else {
                "review_cancel"
            },
            serde_json::to_value(request)
                .map_err(|_| ToolFailure::new("Invalid note-edit review lookup."))?,
        )
    } else if let Some(operation) = operation(name) {
        let request = StartRequest {
            space_id: take_id(&mut input, "space_id")?,
            request_id: take_id(&mut input, "request_id")?,
            operation,
            input: Value::Object(input),
        };
        request.validate().map_err(ToolFailure::new)?;
        (
            "start",
            serde_json::to_value(request)
                .map_err(|_| ToolFailure::new("Invalid workflow request."))?,
        )
    } else {
        let method = match name {
            "orion_get_capabilities" => "capabilities",
            "orion_get_job" => "get_job",
            "orion_list_jobs" => "list_jobs",
            "orion_cancel_job" => "cancel_job",
            _ => return Err(ToolFailure::new("Unknown workflow tool.")),
        };
        if method == "capabilities" {
            if !input.is_empty() {
                return Err(ToolFailure::new("Capabilities takes no arguments."));
            }
        } else {
            take_id(&mut input, "space_id")?;
            if method != "list_jobs" {
                take_id(&mut input, "job_id")?;
            }
            if !input.is_empty() {
                return Err(ToolFailure::new("Unknown job-control arguments."));
            }
        }
        (method, Value::Object(arguments.clone()))
    };
    // Every call still validates the exact library before connecting to a host.
    crate::read_vault(path)?;
    match exchange(path, method, payload) {
        Err(error) if method == "capabilities" => Ok(json!({
            "available":false,
            "localVaultToolsAvailable":true,
            "instruction":error.message,
        })),
        result => result,
    }
}

fn editor_action_method(name: &str) -> Option<&'static str> {
    match name {
        "orion_capture_editor_action" => Some("editor_action_capture"),
        "orion_start_editor_action" => Some("editor_action_start"),
        "orion_get_editor_action" => Some("editor_action_get"),
        "orion_cancel_editor_action" => Some("editor_action_cancel"),
        _ => None,
    }
}

fn editor_action_call(path: &Path, method: &str, arguments: &Map<String, Value>) -> ToolResult {
    // Parse the same closed request types as the host before touching the library
    // or private socket. Captures and start receipts never carry source bodies.
    let input = Value::Object(arguments.clone());
    let malformed = |_| ToolFailure::new("The editor action request does not match its schema.");
    let payload = match method {
        "editor_action_capture" => {
            let request: CaptureRequest = serde_json::from_value(input).map_err(malformed)?;
            request.validate().map_err(ToolFailure::new)?;
            serde_json::to_value(request)
        }
        "editor_action_start" => {
            let request: EditorActionStartRequest =
                serde_json::from_value(input).map_err(malformed)?;
            request.validate().map_err(ToolFailure::new)?;
            serde_json::to_value(request)
        }
        "editor_action_get" | "editor_action_cancel" => {
            let request: EditorActionLookupRequest =
                serde_json::from_value(input).map_err(malformed)?;
            request.validate().map_err(ToolFailure::new)?;
            serde_json::to_value(request)
        }
        _ => return Err(ToolFailure::new("Unknown editor action operation.")),
    }
    .map_err(|_| ToolFailure::new("Invalid editor action request."))?;
    crate::read_vault(path)?;
    let started = Instant::now();
    let mut response = exchange_timeout(
        path,
        method,
        payload.clone(),
        editor_action_remaining(started)?,
    )?;
    validate_editor_action_response(method, &payload, &response)?;
    if method != "editor_action_capture" {
        return Ok(response);
    }
    let id = response["id"].as_str().unwrap().to_owned();
    while response["state"] == "capture_pending" {
        std::thread::sleep(Duration::from_millis(200).min(editor_action_remaining(started)?));
        response = exchange_timeout(
            path,
            "editor_action_get",
            json!({"space_id":payload["space_id"],"action_id":id}),
            editor_action_remaining(started)?,
        )?;
        validate_editor_action_response(method, &payload, &response)?;
        if response["id"].as_str() != Some(id.as_str()) {
            return Err(ToolFailure::new(
                "Orion returned a different editor action identity.",
            ));
        }
    }
    Ok(response)
}

fn editor_action_remaining(started: Instant) -> Result<Duration, ToolFailure> {
    Duration::from_millis(editor_action::REQUEST_TIMEOUT_MS).checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| ToolFailure::new("The editor action owner did not respond in time. Retry the same request_id with identical input; do not create another action to retry uncertain delivery."))
}

fn validate_editor_action_response(
    method: &str,
    payload: &Value,
    response: &Value,
) -> Result<(), ToolFailure> {
    let receipt: editor_action::Receipt = serde_json::from_value(response.clone())
        .map_err(|_| ToolFailure::new("Orion returned an invalid editor action receipt."))?;
    let validation = match method {
        "editor_action_capture" => receipt.validate_capture(
            &serde_json::from_value(payload.clone())
                .map_err(|_| ToolFailure::new("Invalid editor capture input."))?,
        ),
        "editor_action_start" => receipt.validate_start(
            &serde_json::from_value(payload.clone())
                .map_err(|_| ToolFailure::new("Invalid editor start input."))?,
        ),
        _ => receipt.validate_lookup(
            &serde_json::from_value(payload.clone())
                .map_err(|_| ToolFailure::new("Invalid editor lookup input."))?,
        ),
    };
    validation.map_err(ToolFailure::new)?;
    Ok(())
}

fn voice_method(name: &str) -> Option<&'static str> {
    match name {
        "orion_list_voice_work_orders" => Some("voice_list"),
        "orion_get_voice_work_order" => Some("voice_get"),
        "orion_control_voice_work_order" => Some("voice_control"),
        _ => None,
    }
}

fn voice_call(path: &Path, method: &str, arguments: &Map<String, Value>) -> ToolResult {
    // Native and stdio use the same strict request structs. In particular, the
    // connector cannot manufacture write/audio authority or a window identity.
    let input = Value::Object(arguments.clone());
    let malformed = |_| ToolFailure::new("The voice work-order request does not match its schema.");
    let request = match method {
        "voice_list" => {
            let request: VoiceListRequest = serde_json::from_value(input).map_err(malformed)?;
            request.validate().map_err(ToolFailure::new)?;
            voice::VoiceRequest::List(request)
        }
        "voice_get" => {
            let request: VoiceGetRequest = serde_json::from_value(input).map_err(malformed)?;
            request.validate().map_err(ToolFailure::new)?;
            voice::VoiceRequest::Get(request)
        }
        "voice_control" => {
            let request: VoiceControlRequest = serde_json::from_value(input).map_err(malformed)?;
            request.validate().map_err(ToolFailure::new)?;
            voice::VoiceRequest::Control(request)
        }
        _ => return Err(ToolFailure::new("Unknown voice work-order operation.")),
    };
    let payload = match &request {
        voice::VoiceRequest::List(request) => serde_json::to_value(request),
        voice::VoiceRequest::Get(request) => serde_json::to_value(request),
        voice::VoiceRequest::Control(request) => serde_json::to_value(request),
    }
    .map_err(|_| ToolFailure::new("Invalid voice work-order request."))?;
    crate::read_vault(path)?;
    let started = Instant::now();
    let mut response = voice_exchange(path, method, payload.clone(), started)?;
    let id = response["id"]
        .as_str()
        .ok_or_else(|| ToolFailure::new("Orion returned an invalid voice request identity."))?
        .to_owned();
    voice::identifier(&id, 200).map_err(ToolFailure::new)?;
    loop {
        if response["id"].as_str() != Some(id.as_str()) {
            return Err(ToolFailure::new(
                "Orion returned a different voice request identity.",
            ));
        }
        match response["state"].as_str() {
            Some("succeeded") if response["result"].is_object() => {
                voice::validate_result(&request, &response["result"]).map_err(ToolFailure::new)?;
                return Ok(response["result"].clone());
            }
            Some("failed") => return Err(ToolFailure::new(response["error"].as_str()
                .filter(|message| !message.is_empty() && message.chars().count() <= 500)
                .unwrap_or("The voice request could not finish. Discover the current target and read its latest state."))),
            Some("pending") => {},
            _ => return Err(ToolFailure::new("Orion returned an invalid voice work-order response.")),
        }
        // The private socket listener remains free between immediate mailbox
        // requests. Polling never holds a vault lock or occupies a native wait.
        let remaining = voice_remaining(started)?;
        std::thread::sleep(Duration::from_millis(200).min(remaining));
        response = voice_exchange(
            path,
            "voice_request_get",
            json!({"space_id":payload["space_id"],"request_id":id}),
            started,
        )?;
    }
}

fn voice_remaining(started: Instant) -> Result<Duration, ToolFailure> {
    Duration::from_millis(voice::REQUEST_TIMEOUT_MS).checked_sub(started.elapsed())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| ToolFailure::new("The voice work-order owner did not respond in time. For a control request, retry the same request_id and identical input; never invent a new request to retry uncertain work."))
}

fn voice_exchange(path: &Path, method: &str, arguments: Value, started: Instant) -> ToolResult {
    exchange_timeout(path, method, arguments, voice_remaining(started)?)
}

fn take_id(input: &mut Map<String, Value>, key: &str) -> Result<String, ToolFailure> {
    let value = input
        .remove(key)
        .and_then(|value| value.as_str().map(str::to_owned))
        .ok_or_else(|| ToolFailure::new(format!("An exact {key} is required.")))?;
    protocol::bounded_text(&value, key, 200, true).map_err(ToolFailure::new)?;
    if value.trim() != value {
        return Err(ToolFailure::new("IDs must be exact."));
    }
    Ok(value)
}

fn editor_exchange(vault: &Path, method: &str, arguments: Value, started: Instant) -> ToolResult {
    let remaining = Duration::from_millis(editor::REQUEST_TIMEOUT_MS)
        .checked_sub(started.elapsed())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| {
            ToolFailure::new("The editor did not respond in time. Read its current target again.")
        })?;
    exchange_timeout(vault, method, arguments, remaining)
}
fn exchange(vault: &Path, method: &str, arguments: Value) -> ToolResult {
    exchange_timeout(vault, method, arguments, Duration::from_secs(5))
}
#[cfg(unix)]
fn exchange_timeout(vault: &Path, method: &str, arguments: Value, timeout: Duration) -> ToolResult {
    use std::os::unix::{
        fs::{MetadataExt, PermissionsExt},
        net::UnixStream,
    };
    let directory = vault
        .parent()
        .ok_or_else(|| ToolFailure::new("No library directory."))?;
    let unavailable = || {
        ToolFailure::new("Open Orion and enable desktop workflows in Settings → Connections. Existing local vault tools remain available while Orion is closed.")
    };
    let descriptor_path = directory.join(protocol::BRIDGE_DESCRIPTOR);
    let metadata = fs::symlink_metadata(&descriptor_path).map_err(|_| unavailable())?;
    if !metadata.is_file()
        || metadata.len() > 16_384
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.uid() != fs::metadata(vault).map_err(|_| unavailable())?.uid()
    {
        return Err(ToolFailure::new(
            "Orion's private connection descriptor is not protected. Reopen Orion to recreate it.",
        ));
    }
    let file = fs::File::open(&descriptor_path).map_err(|_| unavailable())?;
    let descriptor: BridgeDescriptor = serde_json::from_reader(file.take(16_385))
        .map_err(|_| ToolFailure::new("Orion's connection descriptor is invalid. Reopen Orion."))?;
    validate_descriptor(vault, &descriptor)?;
    let mut stream = UnixStream::connect(&descriptor.socket_path).map_err(|_| unavailable())?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|_| unavailable())?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|_| unavailable())?;
    let request = json!({"version":protocol::BRIDGE_VERSION,"token":descriptor.token,"method":method,"arguments":arguments});
    serde_json::to_writer(&mut stream, &request).map_err(|_| unavailable())?;
    stream.write_all(b"\n").map_err(|_| unavailable())?;
    let mut response = String::new();
    // The job envelope adds a small amount beyond the bounded result itself.
    let limit = protocol::MAX_BRIDGE_RESULT_BYTES + 16_384;
    BufReader::new(stream.take(limit as u64 + 1)).read_line(&mut response)
        .map_err(|_| ToolFailure::new("Orion did not answer in time. Retry with the same request_id to avoid duplicate work."))?;
    if response.len() > limit || !response.ends_with('\n') {
        return Err(ToolFailure::new(
            "Orion returned an incomplete or oversized workflow response.",
        ));
    }
    let response: Value = serde_json::from_str(&response)
        .map_err(|_| ToolFailure::new("Orion returned an invalid workflow response."))?;
    if response["ok"] == true && response["result"].is_object() {
        Ok(response["result"].clone())
    } else {
        Err(ToolFailure::new(
            response
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Orion could not perform this workflow."),
        ))
    }
}

fn validate_descriptor(vault: &Path, descriptor: &BridgeDescriptor) -> Result<(), ToolFailure> {
    let invalid = || {
        ToolFailure::new("This desktop connection belongs to a different library or protocol. Open the matching Orion library before starting workflows.")
    };
    let canonical_vault = fs::canonicalize(vault).map_err(|_| invalid())?;
    let expected_socket = canonical_vault
        .parent()
        .ok_or_else(invalid)?
        .join("assistant.sock");
    if descriptor.version != protocol::BRIDGE_VERSION
        || descriptor.token.len() != 64
        || !descriptor.token.bytes().all(|c| c.is_ascii_hexdigit())
        || fs::canonicalize(&descriptor.vault_path).map_err(|_| invalid())? != canonical_vault
        || fs::canonicalize(&descriptor.socket_path).map_err(|_| invalid())? != expected_socket
    {
        return Err(invalid());
    }
    Ok(())
}

#[cfg(not(unix))]
fn exchange_timeout(
    _vault: &Path,
    _method: &str,
    _arguments: Value,
    _timeout: Duration,
) -> ToolResult {
    Err(ToolFailure::new(
        "Desktop workflows currently require Orion on macOS.",
    ))
}

fn string(max: usize) -> Value {
    json!({"type":"string","minLength":1,"maxLength":max})
}
fn ids(max: usize) -> Value {
    json!({"type":"array","maxItems":max,"uniqueItems":true,"items":string(200)})
}

fn job_schema() -> Value {
    json!({"type":"object","properties":{
        "id":string(128),"spaceId":string(200),"operation":{"type":"string"},
        "state":{"enum":["queued","running","committing","succeeded","failed","cancelled"]},
        "stage":{"type":"string"},"createdAt":{"type":"integer"},"updatedAt":{"type":"integer"},
        "result":{"type":"object","description":"Completed operation result, with exact citations and coverage when applicable."},
        "error":{"type":"string"}
    },"required":["id","spaceId","operation","state","stage","createdAt","updatedAt"]})
}

fn review_schema() -> Value {
    json!({"type":"object","description":"Transient review receipt, separate from desktop workflow jobs. accepted_in_editor means the user's editor transaction applied; only saved confirms native verification of the persisted result. A proposal never authorizes automatic acceptance.","properties":{
        "id":string(200),"spaceId":string(200),"noteId":string(200),"reviewTargetId":string(200),
        "state":{"enum":["submitted","awaiting_review","accepting","accepted_in_editor","saved","discarded","cancelled","stale","failed","save_failed"]},
        "createdAt":{"type":"integer"},"updatedAt":{"type":"integer"},
        "error":{"type":"string"},"result":{"type":"object"}
    },"required":["id","spaceId","noteId","reviewTargetId","state","createdAt","updatedAt"]})
}

fn review_definitions() -> Vec<Value> {
    let edit = json!({"oneOf":[
        {"type":"object","properties":{"kind":{"const":"focused"},"edits":{"type":"array","minItems":1,"maxItems":review::MAX_REVIEW_EDITS,
            "description":"Disjoint exact unique quotations of the current authored Markdown. before and after together must not exceed 24000 Unicode characters. Empty after removes the quoted passage; protected metadata cannot be edited.",
            "items":{"type":"object","properties":{"before":string(review::MAX_EDIT_CHARS),"after":{"type":"string","maxLength":review::MAX_EDIT_CHARS}},"required":["before","after"],"additionalProperties":false}}},
            "required":["kind","edits"],"additionalProperties":false},
        {"type":"object","properties":{"kind":{"const":"rewrite"},"body":string(review::MAX_REWRITE_CHARS)},"required":["kind","body"],"additionalProperties":false}
    ]});
    let mut result = vec![json!({"name":"orion_propose_note_edit",
        "description":"Offer a focused edit or authored-body rewrite for user review in the actual open Orion note. First get a native-issued ready target from orion_get_capabilities.reviewTargets and read the current note. Supply that exact target, Space, note and opaque note version. Requires desktop workflows, note-write permission and this exact enabled Space; AI permission is not required. Makes no provider call and writes no note. Orion displays highlighted changes with Accept changes and Discard. Only the user can accept; use orion_get_edit_review to distinguish accepted_in_editor from saved. Whole rewrites of notes containing hidden completed tasks require deliberate task_view history; read that full historical body first. Focused edits need no history access. Never insert frontmatter, generated evidence footers, or change protected Orion control metadata. No cursor, arbitrary slash-command or voice automation. A review is not an ordinary workflow job.",
        "inputSchema":{"type":"object","properties":{
            "space_id":string(200),"request_id":{"type":"string","minLength":1,"maxLength":128,"description":"Unique caller-chosen ID. Identical retries return the same retained receipt; never reuse it for different input. Receipts expire after one hour, 32 retained reviews, or app restart."},
            "review_target_id":string(200),"note_id":string(200),"expected_version":{"type":"string","minLength":1,"maxLength":64,"description":"Exact opaque noteVersion issued with the ready review target; a changed note or target fails instead of overwriting edits."},
            "task_view":{"enum":["working","history"],"default":"working","description":"Working is the default. A rewrite of a note with completed tasks requires explicit history and an intentional read of its complete historical body; never rewrite from a filtered working view."},"edit":edit
        },"required":["space_id","request_id","review_target_id","note_id","expected_version","edit"],"additionalProperties":false},
        "outputSchema":review_schema(),"annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})];
    for (name, description, read_only) in [
        ("orion_get_edit_review", "Read one review receipt in its exact enabled Space. This is separate from orion_get_job. submitted/awaiting_review is not acceptance; accepted_in_editor is not persistence. Only saved confirms native verification of the note saved by the user's ordinary editor flow. save_failed retains the user's local changes and needs attention in Orion.", true),
        ("orion_cancel_edit_review", "Withdraw one pending note-edit proposal in its exact enabled Space. Never accepts a proposal, writes a note, undoes an accepted edit or interrupts an acceptance already in progress; retrieve the returned receipt state. User Discard and caller cancellation remain distinct outcomes.", false),
    ] {
        result.push(json!({"name":name,"description":description,
            "inputSchema":{"type":"object","properties":{"space_id":string(200),"review_id":string(200)},"required":["space_id","review_id"],"additionalProperties":false},
            "outputSchema":review_schema(),"annotations":{"readOnlyHint":read_only,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}));
    }
    result
}

fn tool(
    name: &str,
    description: &str,
    mut properties: Value,
    required: &[&str],
    writes: bool,
    ai: bool,
) -> Value {
    let map = properties.as_object_mut().unwrap();
    map.insert("space_id".into(), string(200));
    map.insert("request_id".into(), json!({"type":"string","minLength":1,"maxLength":128,
        "description":"Unique caller-chosen ID. Reuse this exact ID and input when retrying; never reuse it for different work. Deduplication lasts while the job is retained (up to one hour, 32 jobs, or app restart)."}));
    let mut required: Vec<_> = required
        .iter()
        .map(|v| Value::String((*v).into()))
        .collect();
    required.extend([json!("space_id"), json!("request_id")]);
    json!({"name":name,"description":format!("{description} Requires the running Orion app and an enabled exact Space. Returns a job immediately; retrieve it with orion_get_job. AI work uses Orion's configured API account and settings."),
        "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},
        "outputSchema":job_schema(),
        "annotations":{"readOnlyHint":!writes,"destructiveHint":false,"idempotentHint":false,"openWorldHint":ai}})
}

fn editor_action_schema() -> Value {
    let instruction = json!({"type":"string","maxLength":editor_action::MAX_INSTRUCTION_CHARS,"description":"Optional direction for this exact captured action. Ordinary context hides completed tasks; only this explicit instruction can deliberately request their history. Note text cannot grant that authority."});
    json!({"oneOf":[
        {"type":"object","properties":{"kind":{"const":"write"},"amount":{"enum":["sentence","paragraph","section"]},"instruction":instruction},"required":["kind","amount"],"additionalProperties":false},
        {"type":"object","properties":{"kind":{"const":"rewrite"},"preset":{"enum":["rewrite","clarify","tighten","simplify","expand","enrich"]},"instruction":instruction},"required":["kind","preset"],"additionalProperties":false},
        {"type":"object","properties":{"kind":{"const":"image"},"quality":{"enum":["fast","detailed"]},"context":{"enum":["selection","space"]},"instruction":instruction},"required":["kind","quality","context"],"additionalProperties":false}
    ]})
}

fn editor_action_receipt_schema() -> Value {
    let position = json!({"type":"integer","minimum":0,"maximum":editor_action::MAX_SAFE_INTEGER});
    let range = json!({"type":"object","properties":{"coordinateSystem":{"const":"prosemirror"},"from":position,"to":position},"required":["coordinateSystem","from","to"],"additionalProperties":false});
    json!({"type":"object","description":"Bounded transient action receipt without selected text, generated prose or image bytes. captured grants no provider call. awaiting_review is an unsaved proposal; accepted_in_editor is not disk persistence. Only saved carries the native-verified note result. These are separate from jobs and edit-review receipts.","properties":{
        "id":string(200),"spaceId":string(200),"noteId":string(200),"editorTargetId":string(200),
        "state":{"enum":["capture_pending","captured","submitted","generating","awaiting_review","accepting","accepted_in_editor","saved","cancelled","discarded","stale","failed","save_failed"]},"action":editor_action_schema(),
        "createdAt":position,"updatedAt":position,"captureId":string(200),"documentVersion":string(200),"selection":range,"effectiveTarget":range,
        "stage":{"enum":["writing","image_planning","image_rendering","image_saving","publish"]},"error":{"type":"string","maxLength":1000},
        "result":{"type":"object","properties":{"noteId":string(200),"version":string(200),"url":string(1000),"citation":string(2000)},"required":["noteId","version","url","citation"],"additionalProperties":false}
    },"required":["id","spaceId","noteId","editorTargetId","state","action","createdAt","updatedAt"],"additionalProperties":false})
}

fn editor_action_definitions() -> Vec<Value> {
    let request_id = json!({"type":"string","minLength":1,"maxLength":128,"description":"Unique caller-chosen ID. Retry uncertain delivery only with this same ID and identical input while retained; never reuse it for another action."});
    let scope = json!({"space_id":string(200),"note_id":string(200),"editor_target_id":string(200),"request_id":request_id});
    let mut capture = scope.clone();
    capture["action"] = editor_action_schema();
    let mut start = scope;
    start["capture_id"] = string(200);
    start["expected_document_version"] = string(200);
    let mut result = vec![
        json!({"name":"orion_capture_editor_action","description":"Capture the real rich-editor target for one finite Write, selected Rewrite or image action without starting a provider call or editing the note. First discover an exact ready editorActionTargets entry through capabilities. Supply its Space, note and target with the complete action. The host captures actual selection/cursor and effective rich range, not caller text or offsets. Enrich and related-Space images also require the saved existing-note context preference; an instruction cannot override it. A capture belongs to that action, document and window; later highlights cannot retarget it. Returns captureId/documentVersion only after renderer attestation. Unavailable or stale targets are never navigated to or replaced with a direct write. Requires enabled desktop access plus API and write permission for that exact Space, but makes no provider call. Only an explicit start may request generation; only the user can accept.","inputSchema":{"type":"object","properties":capture,"required":["space_id","note_id","editor_target_id","request_id","action"],"additionalProperties":false},"outputSchema":editor_action_receipt_schema(),"annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}),
        json!({"name":"orion_start_editor_action","description":"Start the exact previously captured inline action using Orion's configured provider and existing editor generation pipeline. Supply captureId and documentVersion from its captured receipt, plus the same Space/note/editor target and a new start request_id. No action, text, range, model or acceptance overrides. Requires enabled desktop workflows, the exact allowed Space, AI and write permission, and the required configured providers. Every stage rechecks authority and freshness. Generated text/image remains an in-note unsaved preview for user Accept/Discard with one Undo. This receipt is separate from ordinary jobs; poll orion_get_editor_action. Idempotent uncertain retries use identical input and request_id; a new ID must not replay the captured action. No microphone, navigation, Chat message or automatic save.","inputSchema":{"type":"object","properties":start,"required":["space_id","note_id","editor_target_id","request_id","capture_id","expected_document_version"],"additionalProperties":false},"outputSchema":editor_action_receipt_schema(),"annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}}),
    ];
    for (name, description, read_only) in [
        ("orion_get_editor_action", "Read one exact selected-editor-action receipt in its enabled Space. It exposes finite progress and capture metadata, not source text, generated bodies or provider internals. awaiting_review is not accepted; accepted_in_editor is not saved. Only saved confirms native verification of the ordinary editor save. save_failed retains local edits for recovery. This is separate from orion_get_job and edit-review receipts.", true),
        ("orion_cancel_editor_action", "Cancel one exact captured or generating editor action, or withdraw its unaccepted preview. Cancellation prevents later stages and late publication, but does not undo an acceptance already claimed or a saved edit. Provider work already in flight may still consume usage. Repeating cancellation is safe and cannot replay the action. Cancellation after local acceptance has been claimed returns an explicit error and never rewinds it. Never accepts, starts another action, controls audio, or changes Chat.", false),
    ] {
        result.push(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":{"space_id":string(200),"action_id":string(200)},"required":["space_id","action_id"],"additionalProperties":false},"outputSchema":editor_action_receipt_schema(),"annotations":{"readOnlyHint":read_only,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}));
    }
    result
}

fn editor_context_definition() -> Value {
    let position = json!({"type":"integer","minimum":0,"maximum":9_007_199_254_740_991u64});
    json!({"name":"orion_get_editor_context","description":"Read an explicitly selected passage or cursor from one currently open Orion editor. First discover a native-issued editorTargets ID through orion_get_capabilities. Requires desktop workflows enabled for the exact Space; no AI or write permission. Returns reference-only local displayed documentVersion, never a persisted expected_version. Selection ranges use declared DOM UTF-16 offsets; cursor uses its declared coordinate system. Working view hides completed tasks; deliberate history includes them. Pending, none and unavailable return no text. No surrounding prose, note writes, automatic edit/navigation, providers or microphone. Read the note separately for broader context. The displayed version cannot authorize a saved-note write.",
    "inputSchema":{"type":"object","properties":{"space_id":string(200),"editor_target_id":string(200),"task_view":{"enum":["working","history"],"default":"working"},"max_chars":{"type":"integer","minimum":1,"maximum":editor::MAX_CHARS,"default":4000}},"required":["space_id","editor_target_id"],"additionalProperties":false},
    "outputSchema":{"type":"object","properties":{"referenceOnly":{"const":true},"spaceId":string(200),"noteId":string(200),"editorTargetId":string(200),"taskView":{"enum":["working","history"]},"state":{"enum":["selected","cursor","none","pending","unavailable"]},"documentVersion":string(200),"selection":{"type":"object","properties":{"coordinateSystem":{"enum":["dom-text-utf16","prosemirror-position"]},"from":position,"to":position},"required":["coordinateSystem","from","to"],"additionalProperties":false},"fragments":{"type":"array","maxItems":editor::MAX_FRAGMENTS,"items":{"type":"object","properties":{"text":{"type":"string","maxLength":editor::MAX_CHARS},"from":position,"to":position},"required":["text","from","to"],"additionalProperties":false}},"truncated":{"type":"boolean"},"omittedChars":position,"completedTasksOmitted":{"type":"boolean"},"completedTaskChars":position,"reason":{"enum":["flow","preview","not-ready","stale-document","invalid-range","completed-task"]}},"required":["referenceOnly","spaceId","noteId","editorTargetId","taskView","state","fragments","truncated","omittedChars","completedTasksOmitted","completedTaskChars"],"additionalProperties":false},
    "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}})
}

fn voice_definitions() -> Vec<Value> {
    let common = json!({"space_id":string(200),"voice_target_id":{"type":"string","minLength":1,"maxLength":200,"description":"Exact native-issued ID from current orion_get_capabilities.voiceTargets. Identifies one window/session/Space, not an audio call or ordinary workflow executor."}});
    let task_view = json!({"enum":["working","history"],"default":"working","description":"Working withholds history-derived prose. Use history only for deliberate access to completed-task history; filtering citations cannot safely remove paraphrased history."});
    let revision = json!({"type":"integer","minimum":1,"maximum":9_007_199_254_740_991u64});
    let mut list = common.clone();
    list["offset"] =
        json!({"type":"integer","minimum":0,"maximum":9_007_199_254_740_991u64,"default":0});
    list["task_view"] = task_view.clone();
    list["limit"] = json!({"type":"integer","minimum":1,"maximum":50,"default":20});
    list["inventory_version"] = json!({"type":"string","minLength":1,"maxLength":200,"description":"Exact inventoryVersion from the first page. Required when offset is positive. A changed inventory fails; restart from offset zero instead of combining pages from different inventories."});
    let mut get = common.clone();
    get["work_order_id"] = string(200);
    get["expected_revision"] = revision.clone();
    get["task_view"] = task_view.clone();
    get["max_chars"] = json!({"type":"integer","minimum":1,"maximum":12000,"default":4000});
    let mut control = common;
    control["work_order_id"] = string(200);
    control["expected_revision"] = revision;
    control["expected_control_version"] = json!({"type":"string","minLength":1,"maxLength":200,"description":"Exact controlVersion from the latest inventory/detail. Also guards a waiting worker's reservation generation."});
    control["request_id"] = json!({"type":"string","minLength":1,"maxLength":128,"description":"Unique caller-chosen control ID. Reuse this same ID and identical input after uncertain delivery. A different payload with a retained ID fails; deduplication is transient, not durable across app restart."});
    control["action"] = json!({"enum":["cancel","retry","steer"]});
    control["direction"] = json!({"type":"string","minLength":1,"maxLength":2000,"description":"Required only for steer. The explicit new research direction; prior assignments and evidence remain reference data. Cannot authorize saving, editing, audio, navigation or creating unrelated workers."});
    control["task_view"] = task_view;
    let position = json!({"type":"integer","minimum":0,"maximum":voice::MAX_SAFE_INTEGER});
    let summary = json!({"type":"object","properties":{
        "id":string(200),"revision":{"type":"integer","minimum":1,"maximum":voice::MAX_SAFE_INTEGER},"controlVersion":string(200),
        "state":{"enum":["running","completed","failed","cancelled"]},"phase":{"enum":["routing","clarifying","queued"]},
        "taskView":{"enum":["working","history"]},"subject":{"type":"string","maxLength":120},"subjectTruncated":{"type":"boolean"},
        "stage":{"enum":["routing","clarifying","queued","researching","completed","failed","cancelled"]},
        "current":{"type":"boolean"},"checkpointSequence":position,"savedNoteIds":ids(3),"historyWithheld":{"type":"boolean"}
    },"required":["id","revision","controlVersion","state","taskView","subject","subjectTruncated","stage","current","checkpointSequence","savedNoteIds","historyWithheld"],"additionalProperties":false});
    let text = json!({"type":"object","properties":{"fragments":{"type":"array","maxItems":2,"items":{"type":"object","properties":{"from":position,"to":position,"text":{"type":"string","maxLength":12000}},"required":["from","to","text"],"additionalProperties":false}},"complete":{"type":"boolean"},"omittedChars":position},"required":["fragments","complete","omittedChars"],"additionalProperties":false});
    let evidence = json!({"type":"object","properties":{"id":string(200),"kind":{"enum":["note","source"]},"entityId":string(200),"title":{"type":"string","maxLength":12000},"version":string(200),"start":position,"end":position,"text":{"type":"string","maxLength":12000},"offsetUnit":{"const":"utf16"},"complete":{"type":"boolean"},"omittedChars":position},"required":["id","kind","entityId","title","version","start","end","text","offsetUnit","complete","omittedChars"],"additionalProperties":false});
    let finding = json!({"type":"object","properties":{"sequence":position,"text":text,"evidence":{"type":"array","maxItems":12,"items":evidence},"coverage":{"type":"object"},"omittedEvidence":position},"required":["text","evidence","omittedEvidence"],"additionalProperties":false});
    let operation = json!({"type":"object","properties":{"kind":string(200),"entityId":string(200)},"required":["kind"],"additionalProperties":false});
    let mut detail = summary.clone();
    detail["properties"]["referenceOnly"] = json!({"const":true});
    detail["properties"]["withheld"] = json!({"enum":["history","stale"]});
    detail["properties"]["result"] = finding.clone();
    detail["properties"]["findings"] = json!({"type":"array","maxItems":6,"items":finding});
    detail["properties"]["decisions"] = json!({"type":"array","maxItems":8,"items":text});
    detail["properties"]["openQuestions"] = json!({"type":"array","maxItems":4,"items":text});
    detail["properties"]["nextSteps"] = json!({"type":"array","maxItems":4,"items":operation});
    detail["properties"]["completedOperations"] =
        json!({"type":"array","maxItems":32,"items":operation});
    detail["properties"]["omissions"] = json!({"type":"object","properties":{"findings":position,"decisions":position,"openQuestions":position,"nextSteps":position,"completedOperations":position},"required":["findings","decisions","openQuestions","nextSteps","completedOperations"],"additionalProperties":false});
    detail["required"].as_array_mut().unwrap().extend(
        [
            "referenceOnly",
            "findings",
            "decisions",
            "openQuestions",
            "nextSteps",
            "completedOperations",
            "omissions",
        ]
        .map(|key| json!(key)),
    );
    let list_output = json!({"type":"object","properties":{"spaceId":string(200),"voiceTargetId":string(200),"taskView":{"enum":["working","history"]},"inventoryVersion":string(200),"offset":position,"limit":{"type":"integer","minimum":1,"maximum":50},"total":position,"nextOffset":{"type":["integer","null"],"minimum":0,"maximum":voice::MAX_SAFE_INTEGER},"items":{"type":"array","maxItems":50,"items":summary}},"required":["spaceId","voiceTargetId","taskView","inventoryVersion","offset","limit","total","nextOffset","items"],"additionalProperties":false});
    let get_output = json!({"type":"object","properties":{"spaceId":string(200),"voiceTargetId":string(200),"taskView":{"enum":["working","history"]},"workOrder":detail},"required":["spaceId","voiceTargetId","taskView","workOrder"],"additionalProperties":false});
    let control_output = json!({"type":"object","properties":{"spaceId":string(200),"voiceTargetId":string(200),"requestId":string(128),"controlVersion":string(200),"id":string(200),"revision":{"type":"integer","minimum":1,"maximum":voice::MAX_SAFE_INTEGER},"action":{"enum":["cancel","retry","steer"]},"state":{"enum":["running","completed","failed","cancelled"]},"changed":{"type":"boolean"},"readOnly":{"const":true}},"required":["spaceId","voiceTargetId","requestId","controlVersion","id","revision","action","state","changed"],"additionalProperties":false});
    vec![
        json!({"name":"orion_list_voice_work_orders","description":"List existing voice work orders in one explicitly discovered Orion window and Space, including queued, researching and waiting-for-details workers. Requires desktop access enabled for that Space, not AI or write permission. Returns bounded metadata and an inventoryVersion for consistent pagination, never raw transcripts, selections, evidence bodies or internal model context. Voice work orders are separate from ordinary workflow jobs. Discovery and reading never start microphone/audio or create work. Do not guess IDs or silently select a different window.",
            "inputSchema":{"type":"object","properties":list,"required":["space_id","voice_target_id"],"additionalProperties":false},
            "outputSchema":list_output,
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}),
        json!({"name":"orion_get_voice_work_order","description":"Read one exact revision of an existing voice worker as bounded reference material: supported findings, cited passages and versions, public decisions, open questions, next steps and operation summaries. Requires read-enabled exact target/Space; no AI or write permission. Inspect current/historyWithheld and omissions: stale or history-derived prose may be withheld in working view. No raw transcript, saved conversation, selected-text capture, hidden reasoning, provider request or full internal checkpoint. Results do not establish that a finding was spoken or heard. Native target and work revision are rechecked; stale requests never read a replacement worker.",
            "inputSchema":{"type":"object","properties":get,"required":["space_id","voice_target_id","work_order_id","expected_revision"],"additionalProperties":false},
            "outputSchema":get_output,
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}),
        json!({"name":"orion_control_voice_work_order","description":"Cancel, retry or steer one explicitly identified voice work order at its exact revision and controlVersion. Requires enabled desktop access and exact Space; retry/steer also require configured AI permission. External revisions are host-enforced read-only research, even if an earlier spoken request requested saves or edits; write permission is not required and cannot be added here. Cancel targets only that worker/reservation, never the voice call. Retry/steer use the existing worker identity and captured reference, do not create unrelated jobs, and cannot start microphone/audio, switch focus, navigate, save notes or accept edits. Controls are separate from ordinary workflow jobs. Reuse request_id with identical input on uncertain delivery; a succeeded control receipt means admission or cancellation, not completed research.",
            "inputSchema":{"type":"object","properties":control,"required":["space_id","voice_target_id","work_order_id","expected_revision","expected_control_version","request_id","action"],"additionalProperties":false,
                "allOf":[{"if":{"properties":{"action":{"const":"steer"}}},"then":{"required":["direction"]},"else":{"not":{"required":["direction"]}}}]},
            "outputSchema":control_output,
            "annotations":{"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true}}),
    ]
}

pub fn definitions() -> Vec<Value> {
    let context = json!({"task_view":crate::working_view::schema(),"query":string(8_000),"note_ids":ids(16),"source_ids":ids(8),"depth":{"enum":["standard","deep"],"default":"standard"}});
    let research = json!({"question":string(8_000),"material":{"type":"string","maxLength":24_000},
        "mode":{"enum":["answer","compare","gaps","review","brief"],"default":"answer"},
        "task_view":crate::working_view::schema(),"note_ids":ids(16),"source_ids":ids(8),"depth":{"enum":["standard","deep"],"default":"standard"},"previous_job_id":string(128)});
    let mut definitions = vec![
        json!({"name":"orion_get_capabilities","description":"Check whether Orion is open, which desktop workflows and Spaces are enabled, and the configured AI/context policy. reviewTargets lists native-issued targets only for currently open ready notes in enabled Spaces, with their exact noteVersion; it grants no cursor, automatic acceptance or write authority. voiceTargets independently lists exact read-enabled window/Space owners for existing voice work orders, without starting audio or research. editorTargets independently lists read-enabled exact open-note targets, including temporarily unavailable targets with ready:false. Editor context requires no AI or write permission. editorActionTargets separately identifies ready rich editors for explicit capture/start of inline generation; capture makes no provider call and never grants acceptance. available may be true for an editor mailbox even when workflowExecutorAvailable is false. Does not reveal credentials or start AI work.",
            "inputSchema":{"type":"object","properties":{},"additionalProperties":false},"outputSchema":{"type":"object","properties":{
                "available":{"type":"boolean"},"voiceTargets":{"type":"array","maxItems":64,"items":{"type":"object","properties":{"id":string(200),"spaceId":string(200)},"required":["id","spaceId"]}},"voiceWorkOrderLimits":{"type":"object"},"workflowExecutorAvailable":{"type":"boolean"},"editorTargets":{"type":"array","maxItems":64,"items":{"type":"object","properties":{"id":string(200),"spaceId":string(200),"noteId":string(200),"title":{"type":"string","maxLength":240},"ready":{"type":"boolean"}},"required":["id","spaceId","noteId","title","ready"]}},"editorContextLimits":{"type":"object"},"editorActionTargets":{"type":"array","maxItems":64,"items":{"type":"object","properties":{"id":string(200),"spaceId":string(200),"noteId":string(200),"ready":{"type":"boolean"}},"required":["id","spaceId","noteId","ready"],"additionalProperties":false}},"editorActionLimits":{"type":"object"},"reviewTargets":{"type":"array","items":{"type":"object","properties":{"id":string(200),"spaceId":string(200),"noteId":string(200),"title":{"type":"string"},"noteVersion":string(64)},"required":["id","spaceId","noteId","title","noteVersion"]}},
                "reviewLimits":{"type":"object","properties":{"pending":{"type":"integer"},"retained":{"type":"integer"},"retentionSeconds":{"type":"integer"},"providerCalls":{"const":0}}}
            }},
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}),
        tool("orion_get_context","Build a bounded, versioned context packet using Orion's Space hierarchy and exact note/source excerpts. Runs locally without an AI API call; coverage is explicitly partial.",context,&["query"],false,false),
        tool("orion_search_space", "Ask an explicit natural-language question across one Space. Orion adaptively searches and reads relevant notes and preserved sources, returning an AI answer with exact versioned passages, citations, and coverage. Never changes notes, settings, or Chat.", json!({"task_view":crate::working_view::schema(),"query":string(600)}), &["query"], false, true),
        tool("orion_export_word", "Export an exact note, its linked notes, or the whole Space as one editable Word document. Opens Orion's native save dialog; the user chooses the destination. No caller-supplied filesystem paths, no AI use, and no vault changes. Requires desktop workflows; cancellation before saving prevents the export.", json!({"scope":{"enum":["note","linked","space"]}, "note_id":string(200)}), &["scope"], true, false),
        tool("orion_research","Ask Orion AI to answer, compare supplied material, find gaps, review an argument, or prepare a brief grounded in the selected Space. Returns evidence references, uncertainty, and coverage. Does not save notes or alter Chat.",research,&["question"],false,true),
        tool("orion_import","Process text, an absolute local document/image/media path, or a public HTTPS webpage/YouTube URL through Orion's import flow. Preserves original extracted sources. AI mode synthesizes ideas and can revise matching canonical notes; local mode preserves source notes without provider use. Successful notes are saved atomically.",
            json!({"inputs":{"type":"array","minItems":1,"maxItems":12,"items":{"oneOf":[
                {"type":"object","properties":{"kind":{"const":"text"},"title":string(200),"text":string(1_800_000)},"required":["kind","title","text"],"additionalProperties":false},
                {"type":"object","properties":{"kind":{"const":"file"},"path":string(4_096)},"required":["kind","path"],"additionalProperties":false},
                {"type":"object","properties":{"kind":{"const":"url"},"url":string(4_096)},"required":["kind","url"],"additionalProperties":false}]}},
                "guidance":{"type":"string","maxLength":2_000},"mode":{"enum":["ai","local"],"default":"ai"}}),&["inputs"],true,true),
        tool("orion_reprocess_sources","Reinterpret exact preserved sources with new guidance through Orion's import flow. Reuses original provenance IDs and can extend canonical knowledge without importing another source copy.",json!({"source_ids":ids(12),"guidance":{"type":"string","maxLength":2_000}}),&["source_ids"],true,true),
        tool("orion_generate","Generate and save a note, podcast script, slide deck, or narrated slide deck using Orion's existing generation pipeline. Uses Space context only when enabled in Orion. Scripts and decks remain ordinary editable notes; audio playback uses Orion's normal controls.",json!({"kind":{"enum":["note","podcast","slide-deck","slide-deck-narrated"]},"instruction":string(1_250),"title":string(200)}),&["kind","instruction"],true,true),
        tool("orion_develop_concept","Develop a canonical article from an exact origin note and concept title using Orion's scoped concept workflow. Existing canonical ownership and links are preserved.",json!({"title":string(200),"origin_note_id":string(200),"instruction":{"type":"string","maxLength":2_000}}),&["title","origin_note_id"],true,true),
        tool("orion_enrich_knowledge","Run Orion's knowledge enrichment for an exact note, connecting and extending relevant Space knowledge through the existing validated merge.",json!({"note_id":string(200)}),&["note_id"],true,true),
        tool("orion_refresh_overview","Refresh the persistent Space hierarchy and its Across this Space overview using bounded incremental synthesis. Existing-note AI context must be enabled.",json!({}),&[],true,true),
    ];
    for (name, description, job_id, write) in [
        ("orion_get_job","Retrieve a job's current stage or completed result. Results are transient and retained for up to one hour, 32 jobs, or app restart. Use exact citations only from completed results.",true,false),
        ("orion_list_jobs","List recent jobs in an exact enabled Space, without their result bodies.",false,false),
        ("orion_cancel_job","Cancel queued or running work. Late model results cannot save notes. An atomic commit that already began must finish; retrieve its result.",true,true),
    ] {
        let mut properties=json!({"space_id":string(200)});let mut required=vec!["space_id"];
        if job_id {properties["job_id"]=string(128);required.push("job_id");}
        definitions.push(json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false},
            "outputSchema":if job_id {job_schema()}else{json!({"type":"object","properties":{"spaceId":string(200),"jobs":{"type":"array","maxItems":32,"items":job_schema()}},"required":["spaceId","jobs"]})},
            "annotations":{"readOnlyHint":!write,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}));
    }
    definitions.extend(review_definitions());
    definitions.push(editor_context_definition());
    definitions.extend(voice_definitions());
    definitions.extend(editor_action_definitions());
    definitions
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editor_action_inputs_are_strict_before_library_or_socket_access() {
        let capture = json!({"space_id":"space","note_id":"note","editor_target_id":"target","request_id":"capture-1","action":{"kind":"rewrite","preset":"tighten"}});
        let start = json!({"space_id":"space","note_id":"note","editor_target_id":"target","request_id":"start-1","capture_id":"capture","expected_document_version":"displayed-v1:exact"});
        let lookup = json!({"space_id":"space","action_id":"action"});
        let mut malformed = vec![];
        for (tool, base) in [
            ("orion_capture_editor_action", capture.clone()),
            ("orion_start_editor_action", start.clone()),
            ("orion_get_editor_action", lookup.clone()),
            ("orion_cancel_editor_action", lookup.clone()),
        ] {
            assert!(recognizes(tool));
            assert!(operation(tool).is_none());
            for forbidden in [
                "window_label",
                "model",
                "body",
                "selection",
                "from",
                "to",
                "accept",
                "allow_write",
                "task_view",
                "job_id",
            ] {
                let mut args = base.clone();
                args[forbidden] = json!("caller override");
                malformed.push((tool, args));
            }
            for bad_id in ["", " space", "space\n", "space\u{0000}"] {
                let mut args = base.clone();
                args["space_id"] = json!(bad_id);
                malformed.push((tool, args));
            }
        }
        for action in [
            json!({"kind":"rewrite","preset":"tighten","body":"caller target"}),
            json!({"kind":"rewrite","preset":"unknown"}),
            json!({"kind":"write","amount":"chapter"}),
            json!({"kind":"image","quality":"fast","context":"web"}),
            json!({"kind":"image","quality":"fast","context":"selection","url":"https://example.com"}),
            json!({"kind":"rewrite","preset":"rewrite","instruction":"x".repeat(20_001)}),
        ] {
            let mut args = capture.clone();
            args["action"] = action;
            malformed.push(("orion_capture_editor_action", args));
        }
        for (tool, args) in malformed {
            let failure = call(
                Path::new("missing-editor-action-fixture"),
                tool,
                args.as_object().unwrap(),
            )
            .unwrap_err();
            assert!(
                !failure.message.contains("vault"),
                "{tool}: {}",
                failure.message
            );
            assert!(
                !failure.message.contains("Open Orion"),
                "{tool}: {}",
                failure.message
            );
        }
    }

    #[test]
    fn editor_action_tools_are_finite_and_do_not_offer_acceptance_or_text_targets() {
        let tools = editor_action_definitions();
        assert_eq!(tools.len(), 4);
        for definition in tools {
            let name = definition["name"].as_str().unwrap();
            assert!(recognizes(name));
            assert_eq!(definition["inputSchema"]["additionalProperties"], false);
            assert_eq!(definition["annotations"]["idempotentHint"], true);
            assert_eq!(
                definition["annotations"]["openWorldHint"],
                name == "orion_start_editor_action"
            );
            assert!(definition["inputSchema"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("space_id")));
            for field in [
                "body",
                "from",
                "to",
                "selection",
                "accept",
                "model",
                "allow_write",
                "window_label",
                "task_view",
            ] {
                assert!(definition["inputSchema"]["properties"].get(field).is_none());
            }
            assert_eq!(definition["outputSchema"]["additionalProperties"], false);
        }
    }
    #[test]
    fn every_workflow_is_scoped_and_has_a_structured_result() {
        let tools = definitions();
        assert_eq!(tools.len(), 25);
        for tool in &tools {
            assert!(recognizes(tool["name"].as_str().unwrap()));
            assert!(tool["outputSchema"].is_object());
            if operation(tool["name"].as_str().unwrap()).is_some() {
                assert!(tool["inputSchema"]["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("space_id")));
                assert!(tool["inputSchema"]["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("request_id")));
            }
        }
    }
    #[test]
    fn rejects_arguments_before_connecting() {
        let args = json!({"space_id":"a","request_id":"x","question":"why","allow_write":true});
        assert!(call(
            Path::new("missing"),
            "orion_research",
            args.as_object().unwrap()
        )
        .unwrap_err()
        .message
        .contains("schema"));
    }
    #[test]
    fn review_tools_are_finite_scoped_and_separate_from_provider_jobs() {
        let tools = review_definitions();
        assert_eq!(tools.len(), 3);
        for tool in &tools {
            let name = tool["name"].as_str().unwrap();
            assert!(recognizes(name));
            assert!(operation(name).is_none());
            assert_eq!(tool["annotations"]["openWorldHint"], false);
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            assert!(tool["inputSchema"]["required"]
                .as_array()
                .unwrap()
                .contains(&json!("space_id")));
            let states = tool["outputSchema"]["properties"]["state"]["enum"]
                .as_array()
                .unwrap();
            assert!(states.contains(&json!("accepted_in_editor")));
            assert!(states.contains(&json!("saved")));
            assert!(states.contains(&json!("save_failed")));
        }
        let properties = &tools[0]["inputSchema"]["properties"];
        assert!(properties.get("auto_accept").is_none());
        assert!(properties.get("window_label").is_none());
        assert!(properties.get("cursor").is_none());
        assert_eq!(
            properties["edit"]["oneOf"][0]["properties"]["edits"]["maxItems"],
            review::MAX_REVIEW_EDITS
        );
        assert_eq!(
            properties["edit"]["oneOf"][1]["properties"]["body"]["maxLength"],
            review::MAX_REWRITE_CHARS
        );
    }
    #[test]
    fn review_submission_rejects_extra_authority_and_malformed_edits_before_vault_access() {
        let base = json!({"space_id":"space-a","request_id":"review-one","review_target_id":"target-one", "note_id":"note-a","expected_version":"v1-1234567890abcdef", "edit":{"kind":"focused","edits":[{"before":"Current words","after":"Revised words"}]}});
        for field in [
            "auto_accept",
            "allow_write",
            "window_label",
            "cursor",
            "api_key",
        ] {
            let mut input = base.clone();
            input[field] = json!(true);
            let error = call(
                Path::new("missing-review-fixture"),
                "orion_propose_note_edit",
                input.as_object().unwrap(),
            )
            .unwrap_err();
            assert!(
                error.message.contains("schema"),
                "{field}: {}",
                error.message
            );
        }
        for edit in [
            json!({"kind":"focused","edits":[],"auto_accept":true}),
            json!({"kind":"focused","edits":[{"before":"A","after":"B","note_id":"other"}]}),
            json!({"kind":"rewrite","body":"New body","note_id":"other"}),
            json!({"kind":"slash","body":"/write"}),
        ] {
            let mut input = base.clone();
            input["edit"] = edit;
            let error = call(
                Path::new("missing-review-fixture"),
                "orion_propose_note_edit",
                input.as_object().unwrap(),
            )
            .unwrap_err();
            assert!(error.message.contains("schema"), "{}", error.message);
        }
    }
    #[test]
    fn review_controls_reject_job_ids_privilege_flags_and_missing_scope() {
        for name in ["orion_get_edit_review", "orion_cancel_edit_review"] {
            for input in [
                json!({"review_id":"review-one"}),
                json!({"space_id":"space-a","job_id":"review-one"}),
                json!({"space_id":"space-a","review_id":"review-one","accept":true}),
            ] {
                let error = call(
                    Path::new("missing-review-fixture"),
                    name,
                    input.as_object().unwrap(),
                )
                .unwrap_err();
                assert!(error.message.contains("schema"), "{}", error.message);
            }
        }
    }
    #[test]
    fn editor_context_schema_and_parser_offer_only_bounded_reference_reads() {
        let tool = editor_context_definition();
        assert!(recognizes("orion_get_editor_context"));
        assert_eq!(tool["annotations"]["readOnlyHint"], true);
        assert_eq!(
            tool["inputSchema"]["properties"]["max_chars"]["maximum"],
            12000
        );
        for input in [
            json!({"space_id":"a","editor_target_id":"target","body":"text"}),
            json!({"space_id":"a","editor_target_id":"target","max_chars":12001}),
            json!({"space_id":"a","editor_target_id":"target","task_view":"all"}),
            json!({"space_id":" a","editor_target_id":"target"}),
        ] {
            let error = call(
                Path::new("missing-editor-fixture"),
                "orion_get_editor_context",
                input.as_object().unwrap(),
            )
            .unwrap_err();
            assert!(!error.message.contains("library"), "{}", error.message);
        }
    }
    #[test]
    fn voice_schemas_are_finite_targeted_and_separate_from_audio_and_writes() {
        let tools = voice_definitions();
        assert_eq!(tools.len(), 3);
        for tool in &tools {
            assert!(recognizes(tool["name"].as_str().unwrap()));
            assert_eq!(tool["inputSchema"]["additionalProperties"], false);
            let required = tool["inputSchema"]["required"].as_array().unwrap();
            assert!(required.contains(&json!("space_id")));
            assert!(required.contains(&json!("voice_target_id")));
            for field in [
                "window_label",
                "api_key",
                "allow_write",
                "start_audio",
                "focus",
                "checkpoint",
                "selection",
                "save",
            ] {
                assert!(tool["inputSchema"]["properties"].get(field).is_none());
            }
        }
        assert_eq!(
            tools[0]["inputSchema"]["properties"]["limit"]["maximum"],
            50
        );
        assert_eq!(
            tools[1]["inputSchema"]["properties"]["max_chars"]["maximum"],
            12000
        );
        assert_eq!(
            tools[2]["inputSchema"]["properties"]["direction"]["maxLength"],
            2000
        );
        assert_eq!(
            tools[2]["inputSchema"]["properties"]["action"]["enum"],
            json!(["cancel", "retry", "steer"])
        );
        assert_eq!(tools[0]["annotations"]["readOnlyHint"], true);
        assert_eq!(tools[1]["annotations"]["readOnlyHint"], true);
        assert_eq!(tools[2]["annotations"]["readOnlyHint"], false);
    }
    #[test]
    fn voice_input_rejects_extra_authority_and_stale_shape_before_reading_vault() {
        let control = json!({"space_id":"a","voice_target_id":"target","work_order_id":"job","expected_revision":1,"expected_control_version":"control-1","request_id":"once","action":"cancel"});
        for field in [
            "save",
            "allowAI",
            "api_key",
            "window_label",
            "selection",
            "checkpoint",
            "body",
            "start_audio",
        ] {
            let mut input = control.clone();
            input[field] = json!(true);
            let error = call(
                Path::new("missing-voice-fixture"),
                "orion_control_voice_work_order",
                input.as_object().unwrap(),
            )
            .unwrap_err();
            assert!(
                error.message.contains("schema"),
                "{field}: {}",
                error.message
            );
        }
        for (name, input) in [
            (
                "orion_list_voice_work_orders",
                json!({"space_id":"a","voice_target_id":"target","offset":1}),
            ),
            (
                "orion_list_voice_work_orders",
                json!({"space_id":"a","voice_target_id":"target","limit":51}),
            ),
            (
                "orion_list_voice_work_orders",
                json!({"space_id":"a","voice_target_id":"target","task_view":"all"}),
            ),
            (
                "orion_get_voice_work_order",
                json!({"space_id":"a","voice_target_id":"target","work_order_id":"job","expected_revision":0}),
            ),
            (
                "orion_get_voice_work_order",
                json!({"space_id":"a","voice_target_id":"target","work_order_id":"job","expected_revision":1,"max_chars":12001}),
            ),
            ("orion_control_voice_work_order", {
                let mut input = control.clone();
                input["direction"] = json!("New direction");
                input
            }),
            ("orion_control_voice_work_order", {
                let mut input = control.clone();
                input["action"] = json!("steer");
                input
            }),
            ("orion_control_voice_work_order", {
                let mut input = control.clone();
                input["request_id"] = json!(" padded");
                input
            }),
            ("orion_control_voice_work_order", {
                let mut input = control.clone();
                input["expected_revision"] = json!(9_007_199_254_740_992u64);
                input
            }),
        ] {
            let error = call(
                Path::new("missing-voice-fixture"),
                name,
                input.as_object().unwrap(),
            )
            .unwrap_err();
            assert!(
                !error.message.contains("library"),
                "{name}: {}",
                error.message
            );
        }
    }
    #[test]
    fn descriptor_cannot_redirect_an_override_to_another_library() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault.json");
        let other = dir.path().join("other.json");
        fs::write(&vault, "{}").unwrap();
        fs::write(&other, "{}").unwrap();
        fs::write(dir.path().join("assistant.sock"), "").unwrap();
        let mut descriptor = BridgeDescriptor {
            version: protocol::BRIDGE_VERSION,
            vault_path: vault.to_string_lossy().into(),
            socket_path: dir.path().join("assistant.sock").to_string_lossy().into(),
            token: "a".repeat(64),
        };
        assert!(validate_descriptor(&vault, &descriptor).is_ok());
        descriptor.vault_path = other.to_string_lossy().into();
        assert!(validate_descriptor(&vault, &descriptor).is_err());
    }
}
