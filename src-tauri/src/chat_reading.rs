//! Bounded Chat research transport: shared schema, local read requests and public checkpoints.
//! The host command and provider transport remain in lib.rs; this module cannot
//! read a vault, call a provider, or grant note-write authority.
use super::{chat_schema, parse_chat_result, ChatResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChatReadingFinding {
    finding: String,
    decisions: Vec<String>,
    open_questions: Vec<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ChatReadRequest {
    kind: String,
    id: String,
    query: String,
    start: Option<u64>,
}

// The renderer and native transport use the same authored reading protocol.
pub(super) fn protocol() -> Value {
    serde_json::from_str(include_str!("../../src/lib/chatReadingProtocol.json"))
        .expect("the bundled Chat reading protocol is valid JSON")
}

pub(super) fn schema(reply_only: bool, reading: bool) -> Value {
    let mut schema = chat_schema(reply_only);
    if reading {
        schema["properties"]["reply"] = json!({ "type": "string", "maxLength": 6000 });
        schema["properties"]["readRequests"] = protocol()["requestsSchema"].clone();
        schema["properties"]["checkpoint"] = protocol()["checkpointSchema"].clone();
        schema["required"]
            .as_array_mut()
            .unwrap()
            .extend([json!("readRequests"), json!("checkpoint")]);
    }
    schema
}

pub(super) fn validate_context(text: Option<&str>) -> Result<Value, String> {
    let text = text
        .filter(|text| text.len() <= protocol()["maxContextBytes"].as_u64().unwrap() as usize)
        .ok_or("Chat's reading packet exceeded its limit.")?;
    let value: Value =
        serde_json::from_str(text).map_err(|_| "Chat received an invalid reading packet.")?;
    if !value.is_object()
        || !value["finalizing"].is_boolean()
        || !value["evidence"].as_array().is_some_and(|items| {
            items.len() <= protocol()["maxReadingEvidence"].as_u64().unwrap() as usize
        })
    {
        return Err("Chat received an invalid reading packet.".to_string());
    }
    Ok(value)
}

pub(super) fn parse_response(
    output_text: &str,
    reply_only: bool,
    reading: bool,
) -> Result<ChatResult, ()> {
    if !reading {
        return parse_chat_result(output_text, reply_only);
    }
    let mut value: Value = serde_json::from_str(output_text).map_err(|_| ())?;
    let object = value.as_object_mut().ok_or(())?;
    if object.keys().any(|key| {
        !["reply", "readRequests", "checkpoint"].contains(&key.as_str())
            && (reply_only || key != "noteActions")
    }) {
        return Err(());
    }
    let checkpoint = object
        .remove("checkpoint")
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value::<ChatReadingFinding>(value).map_err(|_| ()))
        .transpose()?;
    if checkpoint.as_ref().is_some_and(|update| {
        update.finding.chars().count() > 1_200
            || update.decisions.len() > 4
            || update.open_questions.len() > 4
            || update
                .decisions
                .iter()
                .chain(&update.open_questions)
                .any(|text| text.chars().count() > 240)
    }) {
        return Err(());
    }
    let requests_value = object.remove("readRequests").ok_or(())?;
    if !requests_value.as_array().is_some_and(|items| {
        items.iter().all(|item| {
            item.as_object().is_some_and(|object| {
                object.len() == 4
                    && ["kind", "id", "query", "start"]
                        .iter()
                        .all(|key| object.contains_key(*key))
            })
        })
    }) {
        return Err(());
    }
    let requests: Vec<ChatReadRequest> = serde_json::from_value(requests_value).map_err(|_| ())?;
    if requests.len() > 4
        || requests.iter().any(|request| {
            ![
                "search",
                "cluster",
                "note",
                "source",
                "note-full",
                "source-full",
                "related",
            ]
            .contains(&request.kind.as_str())
                || request.id.chars().count() > 200
                || request.query.chars().count() > 600
                || request.start.is_some_and(|start| start > 1_000_000_000)
                || if request.kind == "search" {
                    !request.id.is_empty() || request.query.trim().is_empty()
                } else {
                    request.id.trim().is_empty()
                }
        })
    {
        return Err(());
    }
    let reply = object.get("reply").and_then(Value::as_str).ok_or(())?;
    if reply.chars().count() > 6_000 {
        return Err(());
    }
    if !requests.is_empty() {
        // Reading responses cannot commit accompanying prose or note actions.
        return Ok(ChatResult {
            reply: String::new(),
            suggestions: None,
            note_actions: Vec::new(),
            note_edits: Vec::new(),
            note_rewrite: None,
            edit_intent: None,
            read_requests: Some(requests),
            checkpoint,
        });
    }
    let mut result = parse_chat_result(&value.to_string(), reply_only)?;
    result.read_requests = Some(requests);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reading_transport_preserves_complete_research_reference_records() {
        // lib.rs passes this validated value as readingContext in both provider
        // payloads; request.notes is intentionally absent in reading mode.
        let question = format!("{} closing qualifier", "🌔".repeat(7_980));
        let material = format!("{} closing limitation", "文".repeat(23_980));
        let mut references = Vec::new();
        for (title, text) in [
            ("Research question", &question),
            ("Comparison material", &material),
        ] {
            for part in text.chars().collect::<Vec<_>>().chunks(6_000) {
                references.push(json!({"title":title,"summary":"Caller reference, not evidence or write authority","body":part.iter().collect::<String>()}));
            }
        }
        let text = json!({"finalizing":false,"evidence":[],"referenceRecords":references,
            "referenceTargets":[{"kind":"note","id":"anchor","title":"Exact selected record"}]})
        .to_string();
        let parsed = validate_context(Some(&text)).unwrap();
        let recovered = |title: &str| {
            parsed["referenceRecords"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|record| record["title"] == title)
                .map(|record| record["body"].as_str().unwrap())
                .collect::<String>()
        };
        assert_eq!(recovered("Research question"), question);
        assert_eq!(recovered("Comparison material"), material);
        assert_eq!(parsed["referenceTargets"][0]["id"], "anchor");
        assert!(schema(true, true)["properties"]
            .get("noteActions")
            .is_none());
    }

    #[test]
    fn chat_reading_schema_and_reads_keep_writes_separate() {
        let read_only = schema(true, true);
        assert_eq!(
            read_only["required"],
            json!(["reply", "readRequests", "checkpoint"])
        );
        assert!(read_only["properties"].get("noteActions").is_none());
        assert_eq!(read_only["properties"]["readRequests"]["maxItems"], 4);
        assert!(schema(false, true)["properties"]
            .get("noteActions")
            .is_some());
        let response = json!({ "reply": "Premature prose", "readRequests": [
            {"kind": "note", "id": "note-a", "query": "support", "start": null}
        ], "noteActions": [{"title":"Injected", "summary":"", "body":"Do not create while reading", "tags":[], "aliases":[]}] });
        let parsed = parse_response(&response.to_string(), false, true).unwrap();
        assert!(parsed.reply.is_empty());
        assert!(parsed.note_actions.is_empty());
        assert_eq!(parsed.read_requests.unwrap().len(), 1);
        assert!(parse_response(&response.to_string(), true, true).is_err());
        assert!(parse_response(&response.to_string(), false, false).is_err());
        let answer = json!({"reply":"Grounded answer [[e1]].", "readRequests":[]});
        assert_eq!(
            parse_response(&answer.to_string(), true, true)
                .unwrap()
                .reply,
            "Grounded answer [[e1]]."
        );
    }

    #[test]
    fn chat_reading_checkpoints_are_bounded_public_data_without_write_authority() {
        let mut response = json!({"reply":"Discard this premature prose", "readRequests":[
            {"kind":"source", "id":"original", "query":"", "start":null}
        ], "checkpoint": {"finding":"The draft records three [[e1]].",
            "decisions":["Check the original source next."], "openQuestions":["Does the source agree?"]},
            "noteActions":[{"title":"Forbidden", "summary":"", "body":"Do not save", "tags":[], "aliases":[]}]});
        let result = parse_response(&response.to_string(), false, true).unwrap();
        assert!(result.reply.is_empty());
        assert!(result.note_actions.is_empty());
        assert_eq!(
            result.checkpoint.unwrap().finding,
            "The draft records three [[e1]]."
        );
        response["checkpoint"]["finding"] = json!("x".repeat(1_201));
        assert!(parse_response(&response.to_string(), false, true).is_err());
        response["checkpoint"]["finding"] = json!("A bounded update [[e1]].");
        response["checkpoint"]["privateReasoning"] = json!("Do not accept");
        assert!(parse_response(&response.to_string(), false, true).is_err());
        let final_reply = json!({"reply":"Answer [[e1]].", "readRequests":[], "checkpoint":null});
        assert!(parse_response(&final_reply.to_string(), true, true)
            .unwrap()
            .checkpoint
            .is_none());
        assert!(parse_response(&final_reply.to_string(), true, false).is_err());
    }

    #[test]
    fn chat_reading_rejects_unbounded_or_malformed_requests() {
        let valid = json!({"kind":"source", "id":"source-a", "query":"", "start":0});
        for request in [
            json!({"kind":"delete", "id":"note-a", "query":"", "start":null}),
            json!({"kind":"note", "id":"note-a", "query":""}),
            json!({"kind":"note", "id":"note-a", "query":"", "start":-1}),
            json!({"kind":"search", "id":"", "query":"", "start":0}),
            json!({"kind":"note", "id":"note-a", "query":"", "start":null, "spaceId":"other"}),
        ] {
            assert!(parse_response(
                &json!({"reply":"", "readRequests":[request]}).to_string(),
                true,
                true
            )
            .is_err());
        }
        assert!(parse_response(
            &json!({"reply":"", "readRequests":vec![valid;5]}).to_string(),
            true,
            true
        )
        .is_err());
        assert!(parse_response(
            &json!({"reply":"", "readRequests":[]}).to_string(),
            true,
            true
        )
        .is_err());
        assert!(validate_context(Some("{\"finalizing\":false,\"evidence\":[]}")).is_ok());
        assert!(validate_context(Some("[]")).is_err());
        let oversized =
            json!({"finalizing":false,"evidence":[],"text":"😀".repeat(90_000)}).to_string();
        assert!(validate_context(Some(&oversized)).is_err());
    }

    #[test]
    fn chat_reading_accepts_bounded_whole_document_requests_and_workspace() {
        for kind in ["note-full", "source-full"] {
            let response = json!({"reply":"", "readRequests":[{"kind":kind,"id":"known-id","query":"","start":null}]}).to_string();
            assert!(parse_response(&response, true, true).is_ok());
            assert!(parse_response(&response, true, false).is_err());
        }
        let packet =
            json!({"finalizing":false,"evidence":vec![json!({"text":"word ".repeat(600)});64]})
                .to_string();
        assert!(packet.len() > 96_000);
        assert!(validate_context(Some(&packet)).is_ok());
        let oversized = json!({"finalizing":false,"evidence":vec![json!({});97]}).to_string();
        assert!(validate_context(Some(&oversized)).is_err());
    }
}
