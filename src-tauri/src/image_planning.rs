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
    timeout_ms: Option<u64>,
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
        || !matches!(
            request.stage.as_str(),
            "select" | "search" | "read" | "merge" | "compose"
        )
        || request.context.len() > 256_000
        || request
            .timeout_ms
            .is_some_and(|value| !(1_000..=240_000).contains(&value))
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
        || (request.stage != "compose" && enabled != Some(true))
        || evidence.is_none_or(|items| items.len() > 96)
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
    let valid = match stage {
        "select" => {
            fields.len() == 3
                && valid_strings(&value["queries"], 3, 300)
                && valid_strings(&value["noteIds"], 4, 200)
                && valid_strings(&value["sourceIds"], 4, 200)
        }
        "search" => {
            fields.len() == 2
                && valid_strings(&value["queries"], 6, 300)
                && valid_text(&value["focus"], 600)
        }
        "read" | "merge" => {
            fields.len() == 4
                && valid_strings(&value["evidenceIds"], 96, 200)
                && valid_strings(&value["queries"], 3, 300)
                && value["complete"].is_boolean()
                && ((valid_text(&value["summary"], 3_200)
                    && value["evidenceIds"]
                        .as_array()
                        .is_some_and(|items| !items.is_empty()))
                    || (value["summary"].as_str() == Some("")
                        && value["evidenceIds"].as_array().is_some_and(Vec::is_empty)))
        }
        "compose" => {
            fields.len() == 3
                && valid_text(&value["visualBrief"], 6_000)
                && valid_text(&value["alt"], 240)
                && valid_strings(&value["evidenceIds"], 96, 200)
        }
        _ => false,
    };
    if valid {
        Ok(value)
    } else {
        Err(invalid())
    }
}

fn stage_label(stage: &str) -> &str {
    match stage {
        "select" => "Context selection",
        "search" => "Context search",
        "read" => "Evidence reading",
        "merge" => "Evidence merging",
        _ => "Image brief preparation",
    }
}

fn timeout_ms(request: &ImagePlanningRequest) -> u64 {
    request.timeout_ms.unwrap_or_else(|| {
        if request.stage == "compose" {
            if matches!(request.effort.as_deref(), Some("high" | "xhigh" | "max")) {
                240_000
            } else {
                120_000
            }
        } else {
            60_000
        }
    })
}

fn timeout_message(stage: &str, milliseconds: u64) -> String {
    format!(
        "{} did not finish within {} {}. Retry to resume from completed work.",
        stage_label(stage),
        milliseconds.div_ceil(1_000),
        if milliseconds <= 1_000 {
            "second"
        } else {
            "seconds"
        }
    )
}

fn token_budget(request: &ImagePlanningRequest) -> usize {
    if matches!(request.effort.as_deref(), Some("high" | "xhigh" | "max")) {
        24_000
    } else if request.stage == "compose" || request.effort.as_deref() == Some("medium") {
        12_000
    } else {
        6_000
    }
}

// Unlike the older shared helper, supported OpenAI models must receive explicit None.
fn planning_effort(model: &str, effort: Option<String>) -> Result<Option<String>, String> {
    let none = effort
        .as_deref()
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("none"));
    if none {
        if model == "gpt-6-astra" || model.starts_with("gpt-6-astra-") {
            return Err("GPT-6 Astra requires at least Low reasoning for image planning.".into());
        }
        let supported = model
            .strip_prefix("gpt-5.")
            .and_then(|suffix| suffix.chars().next())
            .is_some_and(|digit| ('1'..='9').contains(&digit))
            || model.starts_with("gpt-6-")
            || model.starts_with("gpt-6.");
        if supported {
            return Ok(Some("none".into()));
        }
    }
    normalize_effort(effort)
}

fn provider_body(
    request: &ImagePlanningRequest,
    model: &str,
    context: Value,
) -> Result<Value, String> {
    let protocol = protocol();
    let mut schema = protocol[format!("{}Schema", request.stage)].clone();
    let payload = json!({ "stage": request.stage, "context": context });
    let effort = planning_effort(model, request.effort.clone())?;
    let tokens = token_budget(request);
    if is_anthropic_model(model) {
        strip_anthropic_unsupported_schema_keywords(&mut schema);
        let mut output = json!({ "format": { "type": "json_schema", "schema": schema } });
        if let Some(effort) = effort {
            output["effort"] = json!(effort);
        }
        Ok(
            json!({ "model": model, "max_tokens": tokens, "system": protocol["instructions"],
            "messages": [{ "role": "user", "content": payload.to_string() }], "output_config": output }),
        )
    } else {
        let mut body = json!({ "model": model, "store": false, "max_output_tokens": tokens,
            "instructions": protocol["instructions"], "input": payload.to_string(),
            "text": { "format": { "type": "json_schema", "name": "orion_image_plan", "strict": true, "schema": schema } } });
        if let Some(effort) = effort {
            body["reasoning"] = json!({ "effort": effort });
        }
        Ok(body)
    }
}

async fn run(
    client: &Client,
    request: ImagePlanningRequest,
    context: Value,
) -> Result<Value, String> {
    let model = normalize_model(request.model.clone())?;
    let anthropic = is_anthropic_model(&model);
    let body = provider_body(&request, &model, context)?;
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
    let deadline = timeout_ms(&request);
    let label = stage_label(&request.stage);
    let call = if anthropic {
        client
            .post(ANTHROPIC_MESSAGES_URL)
            .header("x-api-key", key.as_str())
            .header("anthropic-version", "2023-06-01")
    } else {
        client.post(OPENAI_RESPONSES_URL).bearer_auth(key.as_str())
    };
    let mut response = call
        .header(reqwest::header::ACCEPT, "application/json")
        .json(&body)
        .timeout(Duration::from_millis(deadline))
        .send()
        .await
        .map_err(|error| if error.is_timeout() { timeout_message(&request.stage, deadline) }
            else { format!("{label} could not reach the planning provider. Retry to resume from completed work.") })?;
    if !response.status().is_success() {
        return Err(if anthropic {
            anthropic_error(response, &format!("finish {}", label.to_lowercase())).await
        } else {
            openai_error(response, &format!("finish {}", label.to_lowercase())).await
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| {
        if error.is_timeout() {
            timeout_message(&request.stage, deadline)
        } else {
            format!("{label} response was interrupted. Retry to resume from completed work.")
        }
    })? {
        if bytes.len() + chunk.len() > 2 * 1024 * 1024 {
            return Err(format!("{label} response exceeded its limit."));
        }
        bytes.extend_from_slice(&chunk);
    }
    let response: Value =
        serde_json::from_slice(&bytes).map_err(|_| format!("{label} returned invalid data."))?;
    let text = if anthropic {
        extract_anthropic_output_text(&response, "plan this illustration")
    } else {
        extract_output_text(&response, "plan this illustration")
    }
    .map_err(|_| {
        format!("{label} did not return a complete plan. Retry to resume from completed work.")
    })?;
    parse_result(&text, &request.stage).map_err(|_| {
        format!(
            "{label} returned invalid structured evidence or an invalid visual brief. Try again."
        )
    })
}

async fn await_stage<F>(
    work: F,
    mut cancelled: tokio::sync::watch::Receiver<bool>,
    stage: &str,
    deadline: u64,
) -> Result<Value, String>
where
    F: std::future::Future<Output = Result<Value, String>>,
{
    if *cancelled.borrow() {
        return Err("Image planning was cancelled.".into());
    }
    tokio::select! {
        result = work => result,
        _ = cancelled.changed() => Err("Image planning was cancelled.".to_string()),
        _ = tokio::time::sleep(Duration::from_millis(deadline)) => Err(timeout_message(stage, deadline)),
    }
}

#[tauri::command]
pub(crate) async fn plan_note_image(
    client: State<'_, OpenAiClient>,
    cancellation: State<'_, KnowledgeCancellation>,
    request: ImagePlanningRequest,
) -> Result<Value, String> {
    let context = validate_context(&request)?;
    let deadline = timeout_ms(&request);
    let stage = request.stage.clone();
    let request_id = request.request_id.clone();
    let registration = cancellation.register(&request_id);
    let generation = registration.generation;
    let result = await_stage(
        run(&client.0, request, context),
        registration.receiver,
        &stage,
        deadline,
    )
    .await;
    cancellation.finish(&request_id, generation);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn planning_schemas_have_no_write_authority() {
        let protocol = protocol();
        for key in [
            "selectSchema",
            "searchSchema",
            "readSchema",
            "mergeSchema",
            "composeSchema",
        ] {
            assert_eq!(protocol[key]["additionalProperties"], false);
            assert!(!protocol[key]["required"].as_array().unwrap().is_empty());
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
            model: Some("gpt-5.6-sol".into()), effort: Some("low".into()), timeout_ms: None };
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
    fn request(stage: &str, effort: &str) -> ImagePlanningRequest {
        ImagePlanningRequest {
            request_id: "image:plan:test".into(),
            stage: stage.into(),
            context: json!({"selectedPassage":"A claim", "contextEnabled":true,"evidence":[]})
                .to_string(),
            model: Some("gpt-5.6-sol".into()),
            effort: Some(effort.into()),
            timeout_ms: None,
        }
    }

    #[test]
    fn adaptive_stage_results_retain_only_bounded_read_authority() {
        assert!(parse_result(r#"{"focus":"Resolve the claim","queries":[]}"#, "search").is_ok());
        for stage in ["read", "merge"] {
            assert!(parse_result(r#"{"summary":"Sources disagree.","evidenceIds":["note:a","source:b"],"queries":[],"complete":false}"#, stage).is_ok());
            assert!(parse_result(
                r#"{"summary":"","evidenceIds":[],"queries":[],"complete":true}"#,
                stage
            )
            .is_ok());
            assert!(parse_result(
                r#"{"summary":"","evidenceIds":["note:a"],"queries":[],"complete":true}"#,
                stage
            )
            .is_err());
            assert!(parse_result(r#"{"summary":"Evidence","evidenceIds":["note:a","note:a"],"queries":[],"complete":true}"#, stage).is_err());
            assert!(parse_result(r#"{"summary":"Evidence","evidenceIds":[],"queries":[],"complete":true,"noteActions":[]}"#, stage).is_err());
            assert!(parse_result(
                &json!({"summary":"x".repeat(3201),"evidenceIds":[],"queries":[],"complete":true})
                    .to_string(),
                stage
            )
            .is_err());
        }
        for stage in ["read", "merge"] {
            assert!(parse_result(r#"{"summary":"An unsupported assertion","evidenceIds":[],"queries":[],"complete":true}"#, stage).is_err());
        }
        let mut value = request("search", "low");
        value.context =
            json!({"selectedPassage":"A claim", "contextEnabled":false,"evidence":[]}).to_string();
        for stage in ["select", "search", "read", "merge"] {
            value.stage = stage.into();
            assert!(validate_context(&value).is_err());
        }
        value.context = json!({"selectedPassage":"A claim", "contextEnabled":true,"evidence":vec![json!({}); 97]}).to_string();
        assert!(validate_context(&value).is_err());
        value.context = json!({"selectedPassage":"A claim", "contextEnabled":true,"evidence":[],"padding":"界".repeat(86000)}).to_string();
        assert!(validate_context(&value).is_err());
    }

    #[test]
    fn explicit_effort_and_stage_budget_are_preserved_for_both_providers() {
        let context = json!({"selectedPassage":"A claim", "contextEnabled":true,"evidence":[]});
        let body =
            provider_body(&request("compose", "none"), "gpt-5.6-sol", context.clone()).unwrap();
        assert_eq!(body["reasoning"]["effort"], "none");
        assert_eq!(body["max_output_tokens"], 12000);
        let body =
            provider_body(&request("compose", "xhigh"), "gpt-6-astra", context.clone()).unwrap();
        assert_eq!(body["model"], "gpt-6-astra");
        assert_eq!(body["max_output_tokens"], 24000);
        assert_eq!(body["store"], false);
        assert!(
            provider_body(&request("compose", "none"), "gpt-6-astra", context.clone()).is_err()
        );
        let body = provider_body(&request("read", "low"), "claude-sonnet-5", context).unwrap();
        assert_eq!(body["max_tokens"], 6000);
        assert_eq!(body["output_config"]["effort"], "low");
        assert!(body["output_config"]["format"]["schema"]["properties"]
            .get("summary")
            .is_some());
        assert_eq!(timeout_ms(&request("search", "low")), 60000);
        assert_eq!(timeout_ms(&request("compose", "xhigh")), 240000);
        let mut value = request("read", "low");
        value.timeout_ms = Some(17000);
        assert_eq!(timeout_ms(&value), 17000);
        for invalid in [0, 999, 240001] {
            value.timeout_ms = Some(invalid);
            assert!(validate_context(&value).is_err());
        }
    }

    #[tokio::test]
    async fn stage_deadline_and_cancellation_stop_pending_work() {
        let (_sender, receiver) = tokio::sync::watch::channel(false);
        let pending = std::future::pending::<Result<Value, String>>();
        let error = await_stage(pending, receiver, "read", 1).await.unwrap_err();
        assert!(error.starts_with("Evidence reading did not finish"));
        let (sender, receiver) = tokio::sync::watch::channel(false);
        sender.send(true).unwrap();
        let error = await_stage(std::future::pending(), receiver, "merge", 60_000)
            .await
            .unwrap_err();
        assert!(error.contains("cancelled"));
        let (sender, receiver) = tokio::sync::watch::channel(false);
        let work = await_stage(std::future::pending(), receiver, "merge", 60_000);
        let cancel = async {
            tokio::task::yield_now().await;
            sender.send(true).unwrap();
        };
        let (result, _) = tokio::join!(work, cancel);
        assert!(result.unwrap_err().contains("cancelled"));
    }
}
