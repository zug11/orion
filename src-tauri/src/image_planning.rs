//! Read-only illustration planning, separate from Chat and note-writing schemas.
use super::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ImagePlanningRequest {
    request_id: String,
    stage: String,
    context: String,
    model: Option<String>,
    effort: Option<String>,
}

fn protocol() -> Value {
    serde_json::from_str(include_str!("../../src/lib/aiImagePlanningProtocol.json"))
        .expect("the bundled image planning protocol is valid JSON")
}

fn valid_text(value: &Value, limit: usize) -> bool {
    value.as_str().is_some_and(|text| {
        !text.trim().is_empty()
            && text.chars().count() <= limit
            && !text
                .chars()
                .any(|c| c.is_control() && !matches!(c, '\n' | '\t'))
    })
}

fn valid_strings(value: &Value, limit: usize, width: usize) -> bool {
    value.as_array().is_some_and(|items| {
        items.len() <= limit
            && items
                .iter()
                .enumerate()
                .all(|(index, item)| valid_text(item, width) && !items[..index].contains(item))
    })
}

fn validate_context(request: &ImagePlanningRequest) -> Result<Value, String> {
    if !valid_knowledge_request_id(&request.request_id)
        || !request.request_id.starts_with("image:")
        || !matches!(request.stage.as_str(), "select" | "compose")
        || request.context.len() > 256_000
    {
        return Err("Orion received an invalid or oversized image planning request.".into());
    }
    let context: Value = serde_json::from_str(&request.context)
        .map_err(|_| "Orion received invalid image planning context.".to_string())?;
    let enabled = context["contextEnabled"].as_bool();
    let evidence = context["evidence"].as_array();
    if !context.is_object()
        || !valid_text(&context["selectedPassage"], 32_000)
        || enabled.is_none()
        || (request.stage == "select" && enabled != Some(true))
        || evidence.is_none_or(|items| items.len() > 11)
        || (enabled == Some(false)
            && (!evidence.unwrap().is_empty()
                || context.as_object().unwrap().keys().any(|key| {
                    !matches!(
                        key.as_str(),
                        "selectedPassage"
                            | "activeNoteTitle"
                            | "visualDirection"
                            | "contextEnabled"
                            | "evidence"
                    )
                })))
    {
        return Err("Orion received invalid image planning context.".into());
    }
    Ok(context)
}

fn parse_result(text: &str, stage: &str) -> Result<Value, String> {
    let invalid =
        || "The illustration planner returned an invalid visual plan. Try again.".to_string();
    let value: Value = serde_json::from_str(text).map_err(|_| invalid())?;
    let Some(fields) = value.as_object() else {
        return Err(invalid());
    };
    let valid = fields.len() == 3
        && match stage {
            "select" => {
                valid_strings(&value["queries"], 3, 300)
                    && valid_strings(&value["noteIds"], 4, 200)
                    && valid_strings(&value["sourceIds"], 4, 200)
            }
            "compose" => {
                valid_text(&value["visualBrief"], 6_000)
                    && valid_text(&value["alt"], 240)
                    && valid_strings(&value["evidenceIds"], 11, 200)
            }
            _ => false,
        };
    if valid {
        Ok(value)
    } else {
        Err(invalid())
    }
}

async fn run(
    client: &Client,
    request: ImagePlanningRequest,
    context: Value,
) -> Result<Value, String> {
    let model = normalize_model(request.model)?;
    let anthropic = is_anthropic_model(&model);
    let effort = normalize_effort(request.effort)?;
    let key = if anthropic {
        stored_anthropic_api_key().await?
    } else {
        stored_api_key().await?
    };
    let Some(key) = key else {
        return Err(format!(
            "Add an {} API key in Settings for the selected illustration planning model.",
            if anthropic { "Anthropic" } else { "OpenAI" }
        ));
    };
    let protocol = protocol();
    let schema_key = if request.stage == "select" {
        "selectSchema"
    } else {
        "composeSchema"
    };
    let payload = json!({ "stage": request.stage, "context": context });
    let mut schema = protocol[schema_key].clone();
    let body;
    let call;
    if anthropic {
        strip_anthropic_unsupported_schema_keywords(&mut schema);
        let mut output = json!({ "format": { "type": "json_schema", "schema": schema } });
        if let Some(effort) = effort {
            output["effort"] = json!(effort);
        }
        body = json!({ "model": model, "max_tokens": 6_000, "system": protocol["instructions"],
            "messages": [{ "role": "user", "content": payload.to_string() }], "output_config": output });
        call = client
            .post(ANTHROPIC_MESSAGES_URL)
            .header("x-api-key", key.as_str())
            .header("anthropic-version", "2023-06-01");
    } else {
        let mut value = json!({ "model": model, "store": false, "max_output_tokens": 6_000,
            "instructions": protocol["instructions"], "input": payload.to_string(),
            "text": { "format": { "type": "json_schema", "name": "orion_image_plan", "strict": true, "schema": schema } } });
        if let Some(effort) = effort {
            value["reasoning"] = json!({ "effort": effort });
        }
        body = value;
        call = client.post(OPENAI_RESPONSES_URL).bearer_auth(key.as_str());
    }
    let mut response = call
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&body)
        .timeout(Duration::from_secs(90))
        .send()
        .await
        .map_err(|_| {
            "Orion could not reach the illustration planning provider. Try again.".to_string()
        })?;
    if !response.status().is_success() {
        return Err(if anthropic {
            anthropic_error(response, "plan this illustration").await
        } else {
            openai_error(response, "plan this illustration").await
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The illustration planning response was interrupted.".to_string())?
    {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err("The illustration planning response exceeded its limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let response: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "The illustration planner returned invalid data.".to_string())?;
    let text = if anthropic {
        extract_anthropic_output_text(&response, "plan this illustration")?
    } else {
        extract_output_text(&response, "plan this illustration")?
    };
    parse_result(&text, &request.stage)
}

#[tauri::command]
pub(crate) async fn plan_note_image(
    client: State<'_, OpenAiClient>,
    cancellation: State<'_, KnowledgeCancellation>,
    request: ImagePlanningRequest,
) -> Result<Value, String> {
    let context = validate_context(&request)?;
    let request_id = request.request_id.clone();
    let registration = cancellation.register(&request_id);
    let generation = registration.generation;
    let mut cancelled = registration.receiver;
    let result = if *cancelled.borrow() {
        Err("Image planning was cancelled.".to_string())
    } else {
        tokio::select! {
            result = run(&client.0, request, context) => result,
            _ = cancelled.changed() => Err("Image planning was cancelled.".to_string()),
            _ = tokio::time::sleep(Duration::from_secs(90)) => Err("The illustration planner did not finish within 90 seconds. Try again.".to_string()),
        }
    };
    cancellation.finish(&request_id, generation);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn planning_schemas_have_no_write_authority() {
        let protocol = protocol();
        for key in ["selectSchema", "composeSchema"] {
            assert_eq!(protocol[key]["additionalProperties"], false);
            assert_eq!(protocol[key]["required"].as_array().unwrap().len(), 3);
            assert!(!protocol[key].to_string().contains("noteActions"));
        }
        assert!(parse_result(
            r#"{"queries":[],"noteIds":["a"],"sourceIds":["s"]}"#,
            "select"
        )
        .is_ok());
        assert!(parse_result(
            r#"{"visualBrief":"A bounded scene","alt":"A scene","evidenceIds":["source:s"]}"#,
            "compose"
        )
        .is_ok());
        assert!(parse_result(
            r#"{"queries":[],"noteIds":["a","a"],"sourceIds":[]}"#,
            "select"
        )
        .is_err());
        assert!(parse_result(
            r#"{"visualBrief":"x","alt":"x","evidenceIds":[],"noteActions":[]}"#,
            "compose"
        )
        .is_err());
        assert!(parse_result(
            &json!({"visualBrief":"x".repeat(6001),"alt":"x","evidenceIds":[]}).to_string(),
            "compose"
        )
        .is_err());
        assert!(parse_result(r#"{"queries":[],"noteIds":[],"sourceIds":[]}"#, "compose").is_err());
    }
    #[test]
    fn planning_packet_enforces_bounds_and_context_opt_out() {
        let mut request = ImagePlanningRequest { request_id: "image:plan:test".into(), stage: "compose".into(),
            context: json!({"selectedPassage":"A highlighted thought", "contextEnabled":false,"evidence":[]}).to_string(),
            model: Some("gpt-5.6-sol".into()), effort: Some("low".into()) };
        assert!(validate_context(&request).is_ok());
        request.stage = "select".into();
        assert!(validate_context(&request).is_err());
        request.stage = "compose".into();
        request.context =
            json!({"selectedPassage":"x", "contextEnabled":false,"evidence":[],"directory":[]})
                .to_string();
        assert!(validate_context(&request).is_err());
        request.context = json!({"selectedPassage":"x", "contextEnabled":true,"evidence":[],"padding":"x".repeat(256_000)}).to_string();
        assert!(validate_context(&request).is_err());
        request.context = "[]".into();
        assert!(validate_context(&request).is_err());
    }
}
