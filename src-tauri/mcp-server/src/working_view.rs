//! Transient agent working views. The stored vault and write coordinates are untouched.
use super::*;

pub fn schema() -> Value {
    json!({"type":"string","enum":["working","history"],"default":"working","description":"Working omits completed task text and cached summaries. Use history explicitly for a scoped audit, regression or completed-work lookup. Original versions/line numbers remain authoritative; filtered bodies are not whole-note replacements."})
}

pub fn history(args: &Map<String, Value>) -> Result<bool, ToolFailure> {
    match args.get("task_view") {
        None => Ok(false),
        Some(Value::String(value)) if value == "working" => Ok(false),
        Some(Value::String(value)) if value == "history" => Ok(true),
        _ => Err(ToolFailure::new("task_view must be working or history.")),
    }
}

pub fn mask(body: &str) -> String {
    let lines = library::text::lines(body);
    let tasks: BTreeMap<_, _> = library::text::tasks(body)
        .into_iter()
        .map(|task| (task.line, task.checked))
        .collect();
    let mut active: Option<usize> = None;
    let mut blank = false;
    let mut output = String::new();
    for line in lines {
        let trimmed = line.text.trim_start();
        let indent = line.text.len() - trimmed.len();
        let mut hide = false;
        if let Some(checked) = tasks.get(&line.index) {
            active = if *checked { Some(indent) } else { None };
            hide = *checked;
            blank = false;
        } else if let Some(level) = active {
            if trimmed.is_empty() {
                blank = true;
            } else if indent > level
                || (!blank
                    && !trimmed.starts_with(['#', '-', '+', '*'])
                    && !trimmed.starts_with("<!--"))
            {
                hide = true;
            } else {
                active = None;
            }
        }
        if hide {
            output.extend(line.text.chars().map(|_| ' '));
        } else {
            output.push_str(line.text);
        }
        let end = line.byte + line.text.len();
        if body[end..].starts_with("\r\n") {
            output.push_str("\r\n");
        } else if body[end..].starts_with('\n') {
            output.push('\n');
        }
    }
    output
}

pub fn apply(vault: &mut Vault) {
    for space in &mut vault.spaces {
        let changed = space.notes.iter().any(|note| mask(&note.body) != note.body)
            || space
                .sources
                .iter()
                .any(|source| mask(&source.text) != source.text);
        if !changed {
            continue;
        }
        space.space_overview = None;
        for note in &mut space.notes {
            note.view_version = Some(library::note_version(note));
            note.body = mask(&note.body);
            note.summary.clear();
        }
        for source in &mut space.sources {
            source.view_version = Some(library::source_version(source));
            source.text = mask(&source.text);
        }
        for concept in &mut space.concepts {
            concept.description.clear();
        }
        for relationship in &mut space.relationships {
            relationship.context = None;
        }
    }
}

pub fn receipt(result: &mut Value, historical: bool) {
    result["taskView"] = json!(if historical { "history" } else { "working" });
    if !historical {
        result["viewNotice"] = json!("Completed task text is omitted before retrieval; whitespace preserves original Unicode-scalar offsets and task line numbers. Versions refer to stored originals. Do not replace a whole note with a filtered body; use exact edits or explicitly read task_view history. Standalone requirements and verification prose remain available.");
    }
}
