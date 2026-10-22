//! Finite reference-only access to existing voice workers. No audio or write authority.
use serde::{Deserialize, Serialize};

pub const REQUEST_TIMEOUT_MS: u64 = 3_000;
pub const MAX_CHARS: usize = 12_000;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub fn identifier(value: &str, max: usize) -> Result<(), String> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().count() > max
        || value.chars().any(char::is_control)
    {
        Err("Voice work-order identifiers must be exact nonempty bounded text without control characters.".into())
    } else {
        Ok(())
    }
}
fn revision(value: u64) -> Result<(), String> {
    if value == 0 || value > MAX_SAFE_INTEGER {
        Err("An exact positive safe-integer revision is required.".into())
    } else {
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskView {
    #[default]
    Working,
    History,
}
fn default_limit() -> usize {
    20
}
fn default_chars() -> usize {
    4_000
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceListRequest {
    pub space_id: String,
    pub voice_target_id: String,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
    #[serde(default)]
    pub inventory_version: Option<String>,
    #[serde(default)]
    pub task_view: TaskView,
}
impl VoiceListRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.voice_target_id, 200)?;
        if self.limit == 0 || self.limit > 50 || self.offset as u64 > MAX_SAFE_INTEGER {
            return Err(
                "Voice inventory limit must be 1–50 and offset a nonnegative safe integer.".into(),
            );
        }
        if let Some(v) = &self.inventory_version {
            identifier(v, 200)?;
        }
        if self.offset > 0 && self.inventory_version.is_none() {
            return Err(
                "Further pages require the exact inventory_version returned by the first page."
                    .into(),
            );
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceGetRequest {
    pub space_id: String,
    pub voice_target_id: String,
    pub work_order_id: String,
    pub expected_revision: u64,
    #[serde(default)]
    pub task_view: TaskView,
    #[serde(default = "default_chars")]
    pub max_chars: usize,
}
impl VoiceGetRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.voice_target_id, 200)?;
        identifier(&self.work_order_id, 200)?;
        revision(self.expected_revision)?;
        if self.max_chars == 0 || self.max_chars > MAX_CHARS {
            return Err("max_chars must be between 1 and 12000 Unicode characters.".into());
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VoiceAction {
    Cancel,
    Retry,
    Steer,
}
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceControlRequest {
    pub space_id: String,
    pub voice_target_id: String,
    pub work_order_id: String,
    pub expected_revision: u64,
    pub expected_control_version: String,
    pub request_id: String,
    pub action: VoiceAction,
    #[serde(default)]
    pub direction: Option<String>,
    #[serde(default)]
    pub task_view: TaskView,
}
impl VoiceControlRequest {
    pub fn uses_ai(&self) -> bool {
        self.action != VoiceAction::Cancel
    }
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.voice_target_id, 200)?;
        identifier(&self.work_order_id, 200)?;
        identifier(&self.expected_control_version, 200)?;
        identifier(&self.request_id, 128)?;
        revision(self.expected_revision)?;
        match (&self.action, &self.direction) {
            (VoiceAction::Steer, Some(text)) if !text.trim().is_empty() && text.chars().count() <= 2_000 && !text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) => Ok(()),
            (VoiceAction::Cancel | VoiceAction::Retry, None) => Ok(()),
            _ => Err("Only steer accepts direction, and requires 1–2000 Unicode characters of explicit direction.".into()),
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VoiceLookupRequest {
    pub space_id: String,
    pub request_id: String,
}
impl VoiceLookupRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifier(&self.space_id, 200)?;
        identifier(&self.request_id, 200)
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "operation", rename_all = "lowercase")]
pub enum VoiceRequest {
    List(VoiceListRequest),
    Get(VoiceGetRequest),
    Control(VoiceControlRequest),
}
impl VoiceRequest {
    pub fn space_id(&self) -> &str {
        match self {
            Self::List(r) => &r.space_id,
            Self::Get(r) => &r.space_id,
            Self::Control(r) => &r.space_id,
        }
    }
    pub fn target_id(&self) -> &str {
        match self {
            Self::List(r) => &r.voice_target_id,
            Self::Get(r) => &r.voice_target_id,
            Self::Control(r) => &r.voice_target_id,
        }
    }
    pub fn uses_ai(&self) -> bool {
        matches!(self, Self::Control(r) if r.uses_ai())
    }
}

use serde_json::{Map, Value};
fn fields<'a>(
    v: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Map<String, Value>, String> {
    let object = v.as_object().ok_or("Voice projection must be an object.")?;
    if required.iter().any(|key| !object.contains_key(*key))
        || object
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err("Voice projection has missing or unknown fields.".into());
    }
    Ok(object)
}
fn string<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    let text = v[key]
        .as_str()
        .ok_or_else(|| format!("{key} must be text."))?;
    if text.chars().count() > max {
        return Err(format!("{key} exceeds its bound."));
    }
    Ok(text)
}
fn id(v: &Value, key: &str) -> Result<(), String> {
    identifier(string(v, key, 200)?, 200)
}
fn number(v: &Value, key: &str) -> Result<u64, String> {
    v[key]
        .as_u64()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
        .ok_or_else(|| format!("{key} must be a nonnegative safe integer."))
}
fn boolean(v: &Value, key: &str) -> Result<bool, String> {
    v[key]
        .as_bool()
        .ok_or_else(|| format!("{key} must be boolean."))
}
fn choice<'a>(v: &'a Value, key: &str, choices: &[&str]) -> Result<&'a str, String> {
    let text = v[key]
        .as_str()
        .filter(|text| choices.contains(text))
        .ok_or_else(|| format!("{key} has an unsupported value."))?;
    Ok(text)
}
fn array<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a Vec<Value>, String> {
    v[key]
        .as_array()
        .filter(|items| items.len() <= max)
        .ok_or_else(|| format!("{key} exceeds its array bound."))
}
const SUMMARY: &[&str] = &[
    "id",
    "revision",
    "state",
    "taskView",
    "subject",
    "subjectTruncated",
    "stage",
    "current",
    "checkpointSequence",
    "savedNoteIds",
    "historyWithheld",
    "controlVersion",
];
const DETAIL: &[&str] = &[
    "referenceOnly",
    "findings",
    "decisions",
    "openQuestions",
    "nextSteps",
    "completedOperations",
    "omissions",
];
fn summary(v: &Value, view: TaskView, detail: bool) -> Result<usize, String> {
    let required = if detail {
        [SUMMARY, DETAIL].concat()
    } else {
        SUMMARY.to_vec()
    };
    fields(
        v,
        &required,
        if detail {
            &["phase", "withheld", "result"]
        } else {
            &["phase"]
        },
    )?;
    id(v, "id")?;
    id(v, "controlVersion")?;
    revision(number(v, "revision")?)?;
    let state = choice(v, "state", &["running", "completed", "failed", "cancelled"])?;
    let task_view = choice(v, "taskView", &["working", "history"])?;
    let stage = choice(
        v,
        "stage",
        &[
            "routing",
            "clarifying",
            "queued",
            "researching",
            "completed",
            "failed",
            "cancelled",
        ],
    )?;
    if v.get("phase").is_some() {
        let phase = choice(v, "phase", &["routing", "clarifying", "queued"])?;
        if state != "running" || phase != stage {
            return Err("A voice phase requires its matching running stage.".into());
        }
    } else if stage
        != if state == "running" {
            "researching"
        } else {
            state
        }
    {
        return Err("Voice stage does not match its state.".into());
    }
    boolean(v, "subjectTruncated")?;
    boolean(v, "current")?;
    number(v, "checkpointSequence")?;
    for saved in array(v, "savedNoteIds", 3)? {
        identifier(
            saved.as_str().ok_or("Saved note identity must be text.")?,
            200,
        )?;
    }
    let withheld = boolean(v, "historyWithheld")?;
    if withheld != (view == TaskView::Working && task_view == "history") {
        return Err("Historical work must be withheld from ordinary working context.".into());
    }
    let subject = string(v, "subject", 120)?;
    if withheld && !"History research".starts_with(subject) {
        return Err("Historical subject text is not available in working view.".into());
    }
    Ok(subject.chars().count())
}
fn public_text(v: &Value) -> Result<usize, String> {
    fields(v, &["fragments", "complete", "omittedChars"], &[])?;
    let omitted = number(v, "omittedChars")?;
    let complete = boolean(v, "complete")?;
    if complete != (omitted == 0) {
        return Err("Public text completeness does not match omissions.".into());
    }
    let mut last = 0;
    let mut chars = 0;
    for f in array(v, "fragments", 2)? {
        fields(f, &["from", "to", "text"], &[])?;
        let from = number(f, "from")?;
        let to = number(f, "to")?;
        let text = string(f, "text", MAX_CHARS)?;
        if from < last
            || from >= to
            || to - from != text.encode_utf16().count() as u64
            || complete && from != last
        {
            return Err("A public finding fragment has invalid UTF-16 coordinates.".into());
        }
        last = to;
        chars += text.chars().count();
    }
    Ok(chars)
}
fn coverage(v: &Value) -> Result<(), String> {
    fields(
        v,
        &[
            "availableNotes",
            "availableSources",
            "openedNotes",
            "openedSources",
            "searches",
            "limited",
        ],
        &["webSearches"],
    )?;
    for key in [
        "availableNotes",
        "availableSources",
        "openedNotes",
        "openedSources",
        "searches",
    ] {
        number(v, key)?;
    }
    if v.get("webSearches").is_some() && number(v, "webSearches")? > 3 {
        return Err("Invalid web search count.".into());
    }
    boolean(v, "limited")?;
    Ok(())
}
fn finding(v: &Value) -> Result<usize, String> {
    fields(
        v,
        &["text", "evidence", "omittedEvidence"],
        &["sequence", "coverage"],
    )?;
    if v.get("sequence").is_some() {
        revision(number(v, "sequence")?)?;
    }
    if let Some(c) = v.get("coverage") {
        coverage(c)?;
    }
    number(v, "omittedEvidence")?;
    let mut chars = public_text(&v["text"])?;
    let mut ids = std::collections::HashSet::new();
    for e in array(v, "evidence", 12)? {
        fields(
            e,
            &[
                "id",
                "kind",
                "entityId",
                "title",
                "version",
                "start",
                "end",
                "text",
                "offsetUnit",
                "complete",
                "omittedChars",
            ],
            &["web"],
        )?;
        for key in ["id", "entityId", "version"] {
            id(e, key)?;
        }
        if !ids.insert(e["id"].as_str().unwrap()) {
            return Err("Evidence identities must be unique within one finding.".into());
        }
        choice(e, "kind", &["note", "source", "web"])?;
        if e["kind"] == "web" {
            let web = &e["web"];
            fields(web, &["url", "retrievedAt"], &["publishedAt"])?;
            let url = string(web, "url", 2048)?;
            if !(url.starts_with("https://") || url.starts_with("http://"))
                || url.chars().any(|c| c.is_control() || c.is_whitespace())
                || number(e, "start")? != 0
            {
                return Err("Invalid retained web reference.".into());
            }
            chars += url.chars().count() + string(web, "retrievedAt", 40)?.chars().count();
            if web.get("publishedAt").is_some() {
                chars += string(web, "publishedAt", 100)?.chars().count();
            }
        } else if e.get("web").is_some() {
            return Err("Local evidence cannot carry web provenance.".into());
        }
        choice(e, "offsetUnit", &["utf16"])?;
        let start = number(e, "start")?;
        let end = number(e, "end")?;
        let text = string(e, "text", MAX_CHARS)?;
        if end < start
            || end - start != text.encode_utf16().count() as u64
            || boolean(e, "complete")? != (number(e, "omittedChars")? == 0)
        {
            return Err("An evidence passage does not match its exact range or omissions.".into());
        }
        chars += text.chars().count() + string(e, "title", MAX_CHARS)?.chars().count();
    }
    Ok(chars)
}
fn operations(v: &Value, key: &str, max: usize) -> Result<(), String> {
    for op in array(v, key, max)? {
        fields(op, &["kind"], &["entityId"])?;
        choice(
            op,
            "kind",
            &[
                "search",
                "cluster",
                "note",
                "source",
                "note-full",
                "source-full",
                "related",
                "web",
            ],
        )?;
        if op.get("entityId").is_some() {
            id(op, "entityId")?;
        }
    }
    Ok(())
}
/// Validate the whole renderer projection, not arbitrary provider output. No
/// extra transcript/selection/checkpoint/request fields can cross this boundary.
pub fn validate_result(request: &VoiceRequest, result: &Value) -> Result<(), String> {
    if serde_json::to_vec(result)
        .map_err(|_| "Cannot encode voice projection.")?
        .len()
        > 180_000
    {
        return Err("Voice projection exceeds the encoded bound.".into());
    }
    match request {
        VoiceRequest::List(r) => {
            fields(
                result,
                &[
                    "spaceId",
                    "voiceTargetId",
                    "taskView",
                    "inventoryVersion",
                    "offset",
                    "limit",
                    "total",
                    "nextOffset",
                    "items",
                ],
                &[],
            )?;
            scope(result, &r.space_id, &r.voice_target_id, Some(r.task_view))?;
            id(result, "inventoryVersion")?;
            if number(result, "offset")? != r.offset as u64
                || number(result, "limit")? != r.limit as u64
                || r.inventory_version
                    .as_ref()
                    .is_some_and(|v| result["inventoryVersion"].as_str() != Some(v))
            {
                return Err("Inventory page does not match its exact request/version.".into());
            }
            let items = array(result, "items", r.limit)?;
            let total = number(result, "total")?;
            let end = (r.offset as u64)
                .checked_add(items.len() as u64)
                .ok_or("Inventory page overflow.")?;
            if end > total
                || items.len() != r.limit.min(total.saturating_sub(r.offset as u64) as usize)
            {
                return Err("Inventory page count is inconsistent.".into());
            }
            if end < total {
                if result["nextOffset"].as_u64() != Some(end) {
                    return Err("Inventory continuation is invalid.".into());
                }
            } else if !result["nextOffset"].is_null() {
                return Err("Completed inventory page must not have another offset.".into());
            }
            let mut ids = std::collections::HashSet::new();
            for item in items {
                summary(item, r.task_view, false)?;
                if !ids.insert(item["id"].as_str().unwrap()) {
                    return Err("Duplicate voice identity in one page.".into());
                }
            }
        }
        VoiceRequest::Get(r) => {
            fields(
                result,
                &["spaceId", "voiceTargetId", "taskView", "workOrder"],
                &[],
            )?;
            scope(result, &r.space_id, &r.voice_target_id, Some(r.task_view))?;
            let d = &result["workOrder"];
            let mut chars = summary(d, r.task_view, true)?;
            if d["id"].as_str() != Some(&r.work_order_id)
                || d["revision"].as_u64() != Some(r.expected_revision)
                || d["referenceOnly"] != json_true()
            {
                return Err(
                    "Voice detail does not match its exact requested identity/revision.".into(),
                );
            }
            let hidden = d["historyWithheld"] == json_true();
            let stale = d["current"] == Value::Bool(false);
            if let Some(reason) = d.get("withheld") {
                if reason.as_str()
                    != Some(if hidden {
                        "history"
                    } else if stale {
                        "stale"
                    } else {
                        return Err("Current visible detail cannot be withheld.".into());
                    })
                {
                    return Err("Invalid withholding reason.".into());
                }
            } else if hidden || stale {
                return Err("Historical or stale detail must be explicitly withheld.".into());
            }
            let fs = array(d, "findings", 6)?;
            let decisions = array(d, "decisions", 8)?;
            let questions = array(d, "openQuestions", 4)?;
            operations(d, "nextSteps", 4)?;
            operations(d, "completedOperations", 32)?;
            if hidden || stale {
                if d.get("result").is_some()
                    || !fs.is_empty()
                    || !decisions.is_empty()
                    || !questions.is_empty()
                    || !d["nextSteps"].as_array().unwrap().is_empty()
                    || !d["completedOperations"].as_array().unwrap().is_empty()
                {
                    return Err("Withheld voice context cannot carry research content.".into());
                }
            }
            if let Some(f) = d.get("result") {
                chars += finding(f)?;
            }
            for f in fs {
                chars += finding(f)?;
            }
            for t in decisions.iter().chain(questions) {
                chars += public_text(t)?;
            }
            let o = &d["omissions"];
            let names = &[
                "findings",
                "decisions",
                "openQuestions",
                "nextSteps",
                "completedOperations",
            ];
            fields(o, names, &[])?;
            for key in names {
                number(o, key)?;
            }
            if chars > r.max_chars {
                return Err("Voice detail exceeds the shared Unicode-character budget.".into());
            }
        }
        VoiceRequest::Control(r) => {
            fields(
                result,
                &[
                    "spaceId",
                    "voiceTargetId",
                    "requestId",
                    "controlVersion",
                    "id",
                    "revision",
                    "action",
                    "state",
                    "changed",
                ],
                &["readOnly"],
            )?;
            scope(result, &r.space_id, &r.voice_target_id, None)?;
            id(result, "controlVersion")?;
            revision(number(result, "revision")?)?;
            if result["requestId"].as_str() != Some(&r.request_id)
                || result["id"].as_str() != Some(&r.work_order_id)
                || serde_json::from_value::<VoiceAction>(result["action"].clone()).ok()
                    != Some(r.action)
            {
                return Err("Voice control receipt does not match the exact request.".into());
            }
            choice(
                result,
                "state",
                &["running", "completed", "failed", "cancelled"],
            )?;
            boolean(result, "changed")?;
            if r.uses_ai() {
                if result["readOnly"] != json_true() {
                    return Err(
                        "Externally admitted voice work must be explicitly read-only.".into(),
                    );
                }
            } else if result["revision"].as_u64() != Some(r.expected_revision)
                || result.get("readOnly").is_some()
            {
                return Err(
                    "Cancellation cannot admit another revision or execution authority.".into(),
                );
            }
        }
    }
    Ok(())
}
fn json_true() -> Value {
    Value::Bool(true)
}
fn scope(v: &Value, space: &str, target: &str, view: Option<TaskView>) -> Result<(), String> {
    if v["spaceId"].as_str() != Some(space)
        || v["voiceTargetId"].as_str() != Some(target)
        || view.is_some_and(|task| {
            serde_json::from_value::<TaskView>(v["taskView"].clone()).ok() != Some(task)
        })
    {
        Err("Voice projection belongs to a different Space, target or task view.".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn voice_work_orders_strict_requests_and_unicode_bounds() {
        let base = json!({"space_id":"s","voice_target_id":"t","work_order_id":"w","expected_revision":1,"expected_control_version":"c","request_id":"r","action":"steer","direction":"🧭".repeat(2000)});
        let r: VoiceControlRequest = serde_json::from_value(base.clone()).unwrap();
        assert!(r.validate().is_ok());
        for (key, value) in [
            ("direction", json!("🧭".repeat(2001))),
            ("expected_revision", json!(0)),
            ("expected_control_version", json!(" c")),
            ("action", json!("retry")),
        ] {
            let mut bad = base.clone();
            bad[key] = value;
            assert!(
                serde_json::from_value::<VoiceControlRequest>(bad)
                    .unwrap()
                    .validate()
                    .is_err(),
                "{key}"
            );
        }
        for key in ["microphone", "checkpoint", "save", "focus"] {
            let mut bad = base.clone();
            bad[key] = json!(true);
            assert!(serde_json::from_value::<VoiceControlRequest>(bad).is_err());
        }
        let list: VoiceListRequest =
            serde_json::from_value(json!({"space_id":"s","voice_target_id":"t"})).unwrap();
        assert_eq!(list.limit, 20);
        assert_eq!(list.task_view, TaskView::Working);
        assert!(list.validate().is_ok());
        assert!(VoiceListRequest { offset: 1, ..list }.validate().is_err());
        let get: VoiceGetRequest = serde_json::from_value(
            json!({"space_id":"s","voice_target_id":"t","work_order_id":"w","expected_revision":1}),
        )
        .unwrap();
        assert_eq!(get.max_chars, 4000);
        assert!(get.validate().is_ok());
    }
    fn detail() -> Value {
        json!({"spaceId":"s","voiceTargetId":"t","taskView":"working","workOrder":{"id":"w","revision":1,"controlVersion":"v1","state":"completed","taskView":"working","subject":"A","subjectTruncated":false,"stage":"completed","current":true,"checkpointSequence":1,"savedNoteIds":[],"historyWithheld":false,"referenceOnly":true,"findings":[],"decisions":[],"openQuestions":[],"nextSteps":[],"completedOperations":[],"omissions":{"findings":0,"decisions":0,"openQuestions":0,"nextSteps":0,"completedOperations":0},"result":{"text":{"fragments":[{"from":0,"to":3,"text":"🧭a"}],"complete":true,"omittedChars":0},"evidence":[{"id":"e1","kind":"note","entityId":"n","title":"T","version":"v","start":2,"end":4,"text":"🧭","offsetUnit":"utf16","complete":true,"omittedChars":0}],"omittedEvidence":0}}})
    }
    #[test]
    fn voice_web_findings_preserve_provenance_and_count_it_in_the_budget() {
        let request = VoiceRequest::Get(serde_json::from_value(json!({"space_id":"s","voice_target_id":"t","work_order_id":"w","expected_revision":1,"max_chars":4000})).unwrap());
        let mut value = detail();
        let evidence = &mut value["workOrder"]["result"]["evidence"][0];
        evidence["kind"] = json!("web");
        evidence["start"] = json!(0);
        evidence["end"] = json!(2);
        evidence["web"] =
            json!({"url":"https://example.org/paper", "retrievedAt":"2026-10-22T02:00:00Z"});
        value["workOrder"]["completedOperations"] = json!([{"kind":"web"}]);
        assert!(validate_result(&request, &value).is_ok());
        value["workOrder"]["result"]["evidence"][0]["web"]["url"] = json!("javascript:alert(1)");
        assert!(validate_result(&request, &value).is_err());
    }
    #[test]
    fn voice_work_orders_projection_is_finite_exact_and_has_one_unicode_budget() {
        let r=VoiceRequest::Get(serde_json::from_value(json!({"space_id":"s","voice_target_id":"t","work_order_id":"w","expected_revision":1,"max_chars":5})).unwrap());
        let v = detail();
        assert!(validate_result(&r, &v).is_ok());
        for path in [
            "/workOrder/transcript",
            "/workOrder/result/reasoning",
            "/workOrder/result/evidence/0/body",
        ] {
            let mut bad = v.clone();
            let parent = path.rsplit_once('/').unwrap();
            bad.pointer_mut(parent.0)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(parent.1.into(), json!("private"));
            assert!(validate_result(&r, &bad).is_err());
        }
        for (path, value) in [
            ("/spaceId", json!("other")),
            ("/workOrder/revision", json!(2)),
            ("/workOrder/result/evidence/0/end", json!(3)),
            ("/workOrder/result/text/fragments/0/to", json!(2)),
            ("/workOrder/result/evidence/0/title", json!("too much text")),
        ] {
            let mut bad = v.clone();
            *bad.pointer_mut(path).unwrap() = value;
            assert!(validate_result(&r, &bad).is_err(), "{path}");
        }
    }
    #[test]
    fn voice_work_orders_history_and_stale_projection_cannot_smuggle_content() {
        let r=VoiceRequest::Get(serde_json::from_value(json!({"space_id":"s","voice_target_id":"t","work_order_id":"w","expected_revision":1})).unwrap());
        let mut v = detail();
        v["workOrder"]["taskView"] = json!("history");
        assert!(validate_result(&r, &v).is_err());
        v["workOrder"]["historyWithheld"] = json!(true);
        v["workOrder"]["subject"] = json!("History research");
        v["workOrder"]["withheld"] = json!("history");
        assert!(validate_result(&r, &v).is_err());
        v["workOrder"].as_object_mut().unwrap().remove("result");
        assert!(validate_result(&r, &v).is_ok());
        v["workOrder"]["subject"] = json!("Completed private task");
        assert!(validate_result(&r, &v).is_err());
        let mut stale = detail();
        stale["workOrder"]["current"] = json!(false);
        stale["workOrder"]["withheld"] = json!("stale");
        assert!(validate_result(&r, &stale).is_err());
    }

    #[test]
    fn voice_work_orders_accept_actual_renderer_projection_contract() {
        // The renderer test derives these fixtures from the real research
        // engine. This checks both languages against the same wire payloads.
        let cases: Value = serde_json::from_str(include_str!(
            "../../src/lib/assistant/voiceWorkOrders.contract.json"
        ))
        .unwrap();
        let cases = cases.as_array().unwrap();
        assert!(!cases.is_empty());
        for (index, case) in cases.iter().enumerate() {
            let request: VoiceRequest = serde_json::from_value(case["request"].clone()).unwrap();
            validate_result(&request, &case["result"])
                .unwrap_or_else(|error| panic!("Renderer projection {index}: {error}"));
        }
    }
}
