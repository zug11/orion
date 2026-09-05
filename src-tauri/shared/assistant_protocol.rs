//! Shared, credential-free contract for the desktop app and its MCP executable.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BRIDGE_VERSION: u32 = 1;
pub const BRIDGE_DESCRIPTOR: &str = "assistant-bridge.json";
pub const MAX_BRIDGE_REQUEST_BYTES: u64 = 8 * 1024 * 1024;
pub const MAX_BRIDGE_RESULT_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BridgeDescriptor {
    pub version: u32,
    pub socket_path: String,
    pub vault_path: String,
    pub token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StartRequest {
    pub space_id: String,
    pub request_id: String,
    pub operation: Operation,
    pub input: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Operation {
    Context,
    Research,
    Import,
    Reprocess,
    Generate,
    DevelopConcept,
    EnrichKnowledge,
    RefreshOverview,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct Access {
    pub enabled: bool,
    #[serde(rename = "allowAI")]
    pub allow_ai: bool,
    pub allow_writes: bool,
    pub space_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContextInput {
    pub query: String,
    #[serde(default)]
    pub note_ids: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default = "default_depth")]
    pub depth: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResearchInput {
    pub question: String,
    #[serde(default)]
    pub material: String,
    #[serde(default)]
    pub note_ids: Vec<String>,
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default = "default_depth")]
    pub depth: String,
    #[serde(default = "default_research_mode")]
    pub mode: String,
    #[serde(default)]
    pub previous_job_id: Option<String>,
}

fn default_depth() -> String {
    "standard".into()
}
fn default_research_mode() -> String {
    "answer".into()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ImportInput {
    Text { title: String, text: String },
    File { path: String },
    Url { url: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImportRequest {
    pub inputs: Vec<ImportInput>,
    #[serde(default)]
    pub guidance: String,
    #[serde(default = "default_import_mode")]
    pub mode: String,
}
fn default_import_mode() -> String {
    "ai".into()
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReprocessInput {
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub guidance: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GenerateInput {
    pub kind: String,
    pub instruction: String,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConceptInput {
    pub title: String,
    pub origin_note_id: String,
    #[serde(default)]
    pub instruction: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnrichInput {
    pub note_id: String,
}

fn parse<T: serde::de::DeserializeOwned>(value: &Value) -> Result<T, String> {
    serde_json::from_value(value.clone())
        .map_err(|_| "The workflow input does not match its declared schema.".into())
}

pub fn bounded_text(value: &str, name: &str, max: usize, required: bool) -> Result<(), String> {
    if (required && value.trim().is_empty())
        || value.chars().count() > max
        || value
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(format!(
            "{name} must contain {}at most {max} characters without control codes.",
            if required { "nonempty text of " } else { "" }
        ));
    }
    Ok(())
}

fn identifiers(values: &[String], max: usize) -> Result<(), String> {
    if values.len() > max {
        return Err(format!("Select at most {max} exact IDs."));
    }
    let mut seen = std::collections::HashSet::new();
    for value in values {
        bounded_text(value, "ID", 200, true)?;
        if value.trim() != value || !seen.insert(value) {
            return Err("IDs must be exact and unique.".into());
        }
    }
    Ok(())
}

fn depth(value: &str) -> Result<(), String> {
    if matches!(value, "standard" | "deep") {
        Ok(())
    } else {
        Err("Depth must be standard or deep.".into())
    }
}

impl StartRequest {
    pub fn validate(&self) -> Result<(), String> {
        identifiers(std::slice::from_ref(&self.space_id), 1)?;
        bounded_text(&self.request_id, "request_id", 128, true)?;
        match self.operation {
            Operation::Context => {
                let input: ContextInput = parse(&self.input)?;
                bounded_text(&input.query, "query", 8_000, true)?;
                identifiers(&input.note_ids, 16)?;
                identifiers(&input.source_ids, 8)?;
                depth(&input.depth)
            }
            Operation::Research => {
                let input: ResearchInput = parse(&self.input)?;
                bounded_text(&input.question, "question", 8_000, true)?;
                bounded_text(&input.material, "material", 24_000, false)?;
                identifiers(&input.note_ids, 16)?;
                identifiers(&input.source_ids, 8)?;
                depth(&input.depth)?;
                if let Some(id) = input.previous_job_id {
                    bounded_text(&id, "previous_job_id", 128, true)?;
                }
                if !matches!(
                    input.mode.as_str(),
                    "answer" | "compare" | "gaps" | "review" | "brief"
                ) {
                    return Err(
                        "Research mode must be answer, compare, gaps, review, or brief.".into(),
                    );
                }
                Ok(())
            }
            Operation::Import => {
                let input: ImportRequest = parse(&self.input)?;
                if input.inputs.is_empty() || input.inputs.len() > 12 {
                    return Err("An import accepts one to twelve inputs.".into());
                }
                if !matches!(input.mode.as_str(), "ai" | "local") {
                    return Err("Import mode must be ai or local.".into());
                }
                bounded_text(&input.guidance, "guidance", 2_000, false)?;
                let mut text_bytes = 0;
                for item in input.inputs {
                    match item {
                        ImportInput::Text { title, text } => {
                            bounded_text(&title, "title", 200, true)?;
                            bounded_text(&text, "text", 1_800_000, true)?;
                            text_bytes += text.len();
                        }
                        ImportInput::File { path } => {
                            bounded_text(&path, "path", 4_096, true)?;
                            if !std::path::Path::new(&path).is_absolute() {
                                return Err("File inputs require an absolute local path.".into());
                            }
                        }
                        ImportInput::Url { url } => {
                            bounded_text(&url, "url", 4_096, true)?;
                            if !url.starts_with("https://") {
                                return Err("URL inputs require HTTPS.".into());
                            }
                        }
                    }
                }
                if text_bytes > 1_800_000 {
                    return Err(
                        "Pasted source text exceeds the 1,800,000-byte import bound.".into(),
                    );
                }
                Ok(())
            }
            Operation::Reprocess => {
                let input: ReprocessInput = parse(&self.input)?;
                if input.source_ids.is_empty() {
                    return Err("Select preserved sources to reprocess.".into());
                }
                identifiers(&input.source_ids, 12)?;
                bounded_text(&input.guidance, "guidance", 2_000, false)
            }
            Operation::Generate => {
                let input: GenerateInput = parse(&self.input)?;
                if !matches!(
                    input.kind.as_str(),
                    "note" | "podcast" | "slide-deck" | "slide-deck-narrated"
                ) {
                    return Err("Unknown generation kind.".into());
                }
                bounded_text(&input.instruction, "instruction", 1_250, true)?;
                if let Some(title) = input.title {
                    bounded_text(&title, "title", 200, true)?;
                }
                Ok(())
            }
            Operation::DevelopConcept => {
                let input: ConceptInput = parse(&self.input)?;
                bounded_text(&input.title, "title", 200, true)?;
                identifiers(&[input.origin_note_id], 1)?;
                bounded_text(&input.instruction, "instruction", 2_000, false)
            }
            Operation::EnrichKnowledge => {
                let input: EnrichInput = parse(&self.input)?;
                identifiers(&[input.note_id], 1)
            }
            Operation::RefreshOverview => {
                if self
                    .input
                    .as_object()
                    .is_some_and(|object| object.is_empty())
                {
                    Ok(())
                } else {
                    Err("Overview refresh takes no workflow input.".into())
                }
            }
        }
    }

    pub fn writes(&self) -> bool {
        !matches!(self.operation, Operation::Context | Operation::Research)
    }

    pub fn uses_ai(&self) -> bool {
        match self.operation {
            Operation::Context => false,
            Operation::Import => self.input.get("mode").and_then(Value::as_str) != Some("local"),
            _ => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validates_workflow_intent_without_accepting_privilege_flags() {
        let mut request = StartRequest {
            space_id: "space-a".into(),
            request_id: "research-1".into(),
            operation: Operation::Research,
            input: json!({"question":"What is supported?"}),
        };
        assert!(request.validate().is_ok());
        assert!(!request.writes());
        assert!(request.uses_ai());
        request.input["allow_write"] = json!(true);
        assert!(request.validate().is_err());
    }

    #[test]
    fn bounds_imports_and_keeps_local_mode_keyless() {
        let mut request = StartRequest {
            space_id: "space-a".into(),
            request_id: "import-1".into(),
            operation: Operation::Import,
            input: json!({"mode":"local", "inputs":[{"kind":"text","title":"A","text":"Evidence"}]}),
        };
        assert!(request.validate().is_ok());
        assert!(request.writes());
        assert!(!request.uses_ai());
        request.input["inputs"][0] = json!({"kind":"file","path":"../../vault.json"});
        assert!(request.validate().is_err());
        request.input["inputs"] = json!([]);
        assert!(request.validate().is_err());
    }

    #[test]
    fn rejects_extra_or_duplicate_ids_and_unicode_overflow() {
        let mut request = StartRequest {
            space_id: "space-a".into(),
            request_id: "context-1".into(),
            operation: Operation::Context,
            input: json!({"query":"Find", "note_ids":["n", "n"]}),
        };
        assert!(request.validate().is_err());
        request.input = json!({"query":"é".repeat(8_001)});
        assert!(request.validate().is_err());
        request.input = json!({"query":"Find", "depth":"unlimited"});
        assert!(request.validate().is_err());
    }
}
