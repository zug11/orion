//! The connector transports typed requests to Orion. It never loads provider keys.
use crate::assistant_protocol::{self as protocol, BridgeDescriptor, Operation, StartRequest};
use crate::{ToolFailure, ToolResult};
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    time::Duration,
};

fn operation(name: &str) -> Option<Operation> {
    Some(match name {
        "orion_get_context" => Operation::Context,
        "orion_research" => Operation::Research,
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
            "orion_get_capabilities" | "orion_get_job" | "orion_list_jobs" | "orion_cancel_job"
        )
}

pub fn call(path: &Path, name: &str, arguments: &Map<String, Value>) -> ToolResult {
    let mut input = arguments.clone();
    let (method, payload) = if let Some(operation) = operation(name) {
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

#[cfg(unix)]
fn exchange(vault: &Path, method: &str, arguments: Value) -> ToolResult {
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
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|_| unavailable())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
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
fn exchange(_vault: &Path, _method: &str, _arguments: Value) -> ToolResult {
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

pub fn definitions() -> Vec<Value> {
    let context = json!({"query":string(8_000),"note_ids":ids(16),"source_ids":ids(8),"depth":{"enum":["standard","deep"],"default":"standard"}});
    let research = json!({"question":string(8_000),"material":{"type":"string","maxLength":24_000},
        "mode":{"enum":["answer","compare","gaps","review","brief"],"default":"answer"},
        "note_ids":ids(16),"source_ids":ids(8),"depth":{"enum":["standard","deep"],"default":"standard"},"previous_job_id":string(128)});
    let mut definitions = vec![
        json!({"name":"orion_get_capabilities","description":"Check whether Orion is open, which desktop workflows and Spaces are enabled, and the configured AI/context policy. Does not reveal credentials or start AI work.",
            "inputSchema":{"type":"object","properties":{},"additionalProperties":false},"outputSchema":{"type":"object"},
            "annotations":{"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false}}),
        tool("orion_get_context","Build a bounded, versioned context packet using Orion's Space hierarchy and exact note/source excerpts. Runs locally without an AI API call; coverage is explicitly partial.",context,&["query"],false,false),
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
    definitions
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_workflow_is_scoped_and_has_a_structured_result() {
        let tools = definitions();
        assert_eq!(tools.len(), 12);
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
