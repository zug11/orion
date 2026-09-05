//! Bounded local knowledge tools. Reads share one validated snapshot; edits
//! recheck exact content versions under the existing cross-process vault lock.
use super::*;
use std::collections::{hash_map::DefaultHasher, VecDeque};
use std::hash::{Hash, Hasher};

mod read;
#[cfg(test)]
mod tests;
mod text;
mod write;

pub const NAMES: [&str; 20] = [
    "orion_list_sources",
    "orion_search_sources",
    "orion_get_source_passage",
    "orion_get_note_section",
    "orion_get_notes",
    "orion_list_concepts",
    "orion_get_concept",
    "orion_resolve_link",
    "orion_get_related_notes",
    "orion_get_provenance",
    "orion_list_tags",
    "orion_list_tasks",
    "orion_set_task_completion",
    "orion_edit_note_text",
    "orion_append_to_note",
    "orion_batch_update_metadata",
    "orion_find_duplicate_notes",
    "orion_check_space_integrity",
    "orion_get_recent_changes",
    "orion_get_link_path",
];
const WRITES: [&str; 4] = [
    "orion_set_task_completion",
    "orion_edit_note_text",
    "orion_append_to_note",
    "orion_batch_update_metadata",
];
const MAX_SCAN_NOTES: usize = 2_000;
const MAX_SCAN_BYTES: usize = 8 * 1024 * 1024;

pub fn recognizes(name: &str) -> bool {
    NAMES.contains(&name)
}

pub fn call(path: &Path, name: &str, args: &Map<String, Value>) -> ToolResult {
    let definition = definitions()
        .into_iter()
        .find(|tool| tool["name"] == name)
        .ok_or_else(|| ToolFailure::new("Unknown local knowledge tool."))?;
    validate_arguments(args, &definition["inputSchema"])?;
    let result = if WRITES.contains(&name) {
        write::call(path, name, args)?
    } else {
        let vault = read_vault(path)?;
        let scope = read_space_from_arguments(&vault, args)?;
        if vault
            .spaces
            .iter()
            .filter(|space| space.workspace.id == scope.workspace.id)
            .count()
            != 1
        {
            return Err(ToolFailure::new(
                "Duplicate Space IDs make this read ambiguous.",
            ));
        }
        if args
            .get("expected_revision")
            .is_some_and(|revision| revision != &vault.updated_at)
        {
            return Err(ToolFailure::new(
                "The vault changed between pages. Restart pagination from the current revision.",
            ));
        }
        let mut result = read::call(scope, name, args)?;
        result["spaceId"] = json!(scope.workspace.id);
        result["vaultRevision"] = json!(vault.updated_at);
        result
    };
    if serde_json::to_vec(&result)
        .map_err(|_| ToolFailure::new("Cannot encode result."))?
        .len()
        > 2 * 1024 * 1024
    {
        return Err(ToolFailure::new(
            "Result exceeds 2 MiB. Request fewer items or a smaller text range.",
        ));
    }
    Ok(result)
}

// The advertised schema is also the input validator. This keeps exact IDs,
// bounds, required fields and unknown-field rejection identical on both clients.
fn validate_arguments(args: &Map<String, Value>, schema: &Value) -> Result<(), ToolFailure> {
    validate_value(&Value::Object(args.clone()), schema, "arguments")
}
fn validate_value(value: &Value, schema: &Value, field: &str) -> Result<(), ToolFailure> {
    let invalid = || ToolFailure::new(format!("Invalid {field}; follow the tool's input schema."));
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.contains(value) {
            return Err(invalid());
        }
    }
    match schema["type"].as_str().unwrap_or("") {
        "object" => {
            let object = value.as_object().ok_or_else(invalid)?;
            let properties = schema["properties"].as_object().ok_or_else(invalid)?;
            if let Some(required) = schema["required"].as_array() {
                for key in required {
                    if !object.contains_key(key.as_str().unwrap()) {
                        return Err(invalid());
                    }
                }
            }
            for (key, item) in object {
                let property = properties.get(key).ok_or_else(invalid)?;
                validate_value(item, property, &format!("{field}.{key}"))?;
            }
        }
        "string" => {
            let text = value.as_str().ok_or_else(invalid)?;
            let count = text.chars().count() as u64;
            if count < schema["minLength"].as_u64().unwrap_or(0)
                || count > schema["maxLength"].as_u64().unwrap_or(50_000)
                || text
                    .chars()
                    .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
            {
                return Err(invalid());
            }
        }
        "integer" => {
            let number = value.as_u64().ok_or_else(invalid)?;
            if number < schema["minimum"].as_u64().unwrap_or(0)
                || number > schema["maximum"].as_u64().unwrap_or(u64::MAX)
            {
                return Err(invalid());
            }
        }
        "boolean" => {
            if !value.is_boolean() {
                return Err(invalid());
            }
        }
        "array" => {
            let items = value.as_array().ok_or_else(invalid)?;
            if items.len() < schema["minItems"].as_u64().unwrap_or(0) as usize
                || items.len() > schema["maxItems"].as_u64().unwrap_or(50) as usize
            {
                return Err(invalid());
            }
            for (index, item) in items.iter().enumerate() {
                if schema["uniqueItems"] == true && items[..index].contains(item) {
                    return Err(invalid());
                }
                validate_value(item, &schema["items"], field)?;
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

fn string(max: usize) -> Value {
    json!({"type":"string","minLength":1,"maxLength":max})
}
fn integer(default: usize, min: usize, max: usize) -> Value {
    json!({"type":"integer","default":default,"minimum":min,"maximum":max})
}
fn array(item: Value, min: usize, max: usize) -> Value {
    json!({"type":"array","items":item,"minItems":min,"maxItems":max,"uniqueItems":true})
}
fn choice(values: &[&str], default: &str) -> Value {
    json!({"type":"string","enum":values,"default":default})
}
fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

pub fn definitions() -> Vec<Value> {
    let id = string(200);
    let version = string(100);
    let page = json!({"offset":integer(0,0,1_000_000),"limit":integer(30,1,100),"expected_revision":string(200)});
    let specs = vec![
        (NAMES[0], "Page through source metadata, optionally filtering kind, title, or source URL. No source body upload.", json!({"query":string(300),"kind":string(40)}), vec![], true),
        (NAMES[1], "Find literal evidence in preserved sources, with Unicode character offsets and source versions. Search is local and case-sensitive; results do not establish AI claims.", json!({"query":string(300),"source_ids":array(id.clone(),1,12),"kind":string(40)}), vec!["query"], true),
        (NAMES[2], "Read an exact source range, including material beyond ordinary source previews. Offsets count Unicode scalar values, not bytes or UTF-16. Optional version rejects stale ranges.", json!({"source_id":id,"start":integer(0,0,256_000_000),"max_chars":integer(6000,1,20000),"expected_version":version}), vec!["source_id"], false),
        (NAMES[3], "Retrieve one Markdown section by heading and occurrence, including its subsections. Ignores fenced code and frontmatter; supports ATX and setext headings. Lists matching headings on ambiguity.", json!({"note_id":id,"heading":string(500),"occurrence":integer(1,1,10000),"max_chars":integer(6000,1,20000),"expected_version":version}), vec!["note_id","heading"], false),
        (NAMES[4], "Read up to 12 exact notes from one consistent vault snapshot, sharing a 60,000-character body budget. Returns versions for guarded edits and citations for every note.", json!({"note_ids":array(id.clone(),1,12),"max_chars_per_note":integer(4000,1,5000)}), vec!["note_ids"], false),
        (NAMES[5], "Browse the Space's existing concept vocabulary, with canonical destinations and aliases. Tags remain a separate organizing facet.", json!({"query":string(300)}), vec![], true),
        (NAMES[6], "Open an exact concept's description, aliases, canonical article, and related note citations. Reports dangling IDs without resolving them in another Space.", json!({"concept_id":id}), vec!["concept_id"], true),
        (NAMES[7], "Resolve a phrase using exact normalized note titles, aliases, and canonical concept vocabulary. Returns all distinct destinations when ambiguous; never guesses across Spaces.", json!({"phrase":string(300)}), vec!["phrase"], false),
        (NAMES[8], "Rank related notes by explicit links, shared concepts, and shared source provenance. Gives derivation reasons; similarity is not proof of agreement.", json!({"note_id":id}), vec!["note_id"], true),
        (NAMES[9], "Trace one note to preserved sources and other notes derived from them. Distinguishes forward note references and source backreferences; does not assert that a source supports every claim.", json!({"note_id":id}), vec!["note_id"], true),
        (NAMES[10], "List exact tags and note counts, optionally filtering by tag text. Tags do not create automatic concepts.", json!({"query":string(100)}), vec![], true),
        (NAMES[11], "List portable Markdown tasks with exact note versions and line indices. Ignores code/frontmatter; optionally collapses copies with shared provenance while retaining unrelated recurring tasks.", json!({"note_id":id,"state":choice(&["open","completed","all"],"open"),"collapse_derived":json!({"type":"boolean","default":true})}), vec![], true),
        (NAMES[12], "Set one exact Markdown task checkbox. Requires its current note version, zero-based line index, and exact raw task text. Does not change another copy of the task.", json!({"note_id":id,"expected_version":version,"line_index":integer(0,0,500000),"expected_text":string(50000),"completed":json!({"type":"boolean"})}), vec!["note_id","expected_version","line_index","expected_text","completed"], false),
        (NAMES[13], "Replace one unique exact substring in a note, guarded by the current note version. Rejects missing or ambiguous selections; preserves all other text and metadata.", json!({"note_id":id,"expected_version":version,"old_text":string(50000),"new_text":json!({"type":"string","maxLength":50000})}), vec!["note_id","expected_version","old_text","new_text"], false),
        (NAMES[14], "Append exact Markdown to a note with a current-version guard. Inserts no implicit separator. Replaying a completed append with its old version fails instead of duplicating content.", json!({"note_id":id,"expected_version":version,"text":string(50000)}), vec!["note_id","expected_version","text"], false),
        (NAMES[15], "Atomically set tags and/or pinned state on up to 20 exact versioned notes. Every version must match before anything saves. Preserves bodies, titles, aliases, and unrelated notes.", json!({"notes":array(object(json!({"note_id":id,"expected_version":version}), &["note_id","expected_version"]),1,20),"tags":array(string(100),0,50),"pinned":json!({"type":"boolean"})}), vec!["notes"], false),
        (NAMES[16], "Find duplicate candidates by identical nonempty bodies or normalized titles. Reports the matching basis and bounded scan coverage; never merges or deletes notes.", json!({"basis":choice(&["body","title"],"body")}), vec![], true),
        (NAMES[17], "Audit Space-local references, duplicate IDs, missing canonical targets, and broken explicit Orion links. Reports bounded diagnostics without changing knowledge.", json!({}), vec![], true),
        (NAMES[18], "List current notes changed since an RFC3339 timestamp, sorted chronologically. This is current-state metadata, not a historical audit log; deletions and prior bodies are unavailable.", json!({"since":string(80)}), vec!["since"], true),
        (NAMES[19], "Find one shortest directed connection path between two exact notes using existing Orion links and persisted relationships. Search has explicit node, edge, text, and hop bounds; returns cited steps and no graph UI.", json!({"from_note_id":id,"to_note_id":id,"max_hops":integer(4,1,8)}), vec!["from_note_id","to_note_id"], false),
    ];
    specs.into_iter().map(|(name, description, mut fields, mut required, paged)| {
        let writes = WRITES.contains(&name);
        fields["space_id"] = json!({"type":"string","minLength":1,"maxLength":200,"description":if writes {"Exact explicit Space ID; required for edits."} else {"Exact Space ID; omission reads only the active Space."}});
        if writes { required.push("space_id"); }
        if paged { fields.as_object_mut().unwrap().extend(page.as_object().unwrap().clone()); }
        json!({"name":name,"description":description,"inputSchema":object(fields,&required),
            "outputSchema":output_schema(name),
            "annotations":{"readOnlyHint":!writes,"destructiveHint":writes,"idempotentHint":true,"openWorldHint":false}})
    }).collect()
}

fn output_schema(name: &str) -> Value {
    let mut properties = json!({"spaceId":{"type":"string"},"vaultRevision":{"type":"string"},"offset":{"type":"integer"},"total":{"type":"integer"},"nextOffset":{"type":["integer","null"]},"truncated":{"type":"boolean"}});
    let (field, kind) = match name {
        "orion_list_sources" | "orion_get_provenance" => ("sources", "array"),
        "orion_search_sources" => ("matches", "array"),
        "orion_get_notes"
        | "orion_get_related_notes"
        | "orion_get_concept"
        | "orion_get_recent_changes" => ("notes", "array"),
        "orion_list_concepts" => ("concepts", "array"),
        "orion_list_tags" => ("tags", "array"),
        "orion_list_tasks" => ("tasks", "array"),
        "orion_find_duplicate_notes" => ("groups", "array"),
        "orion_check_space_integrity" => ("issues", "array"),
        "orion_get_link_path" => ("path", "array"),
        "orion_resolve_link" => ("destinations", "array"),
        "orion_get_source_passage" => ("source", "object"),
        "orion_get_note_section" => ("note", "object"),
        _ => ("notes", "array"),
    };
    properties[field] = if kind == "array" {
        json!({"type":"array","items":{"type":"object"}})
    } else {
        json!({"type":"object"})
    };
    for key in ["start", "end", "totalChars", "sectionEnd"] {
        properties[key] = json!({"type":"integer"});
    }
    properties["text"] = json!({"type":"string"});
    properties["coverage"] = json!({"type":"object"});
    if WRITES.contains(&name) {
        properties["changed"] = json!({"type":"boolean"});
        properties["atomic"] = json!({"type":"boolean","const":true});
    }
    json!({"type":"object","properties":properties,"required":["spaceId","vaultRevision",field],"additionalProperties":true})
}

fn fingerprint(value: impl Hash) -> String {
    let mut hash = DefaultHasher::new();
    value.hash(&mut hash);
    format!("v1-{:016x}", hash.finish())
}
pub(super) fn note_version(note: &Note) -> String {
    fingerprint(
        json!([
            note.id,
            note.title,
            note.body,
            note.summary,
            note.slug,
            note.aliases,
            note.tags,
            note.source_ids,
            note.concept_ids,
            note.created_at,
            note.updated_at,
            note.pinned,
            note.color
        ])
        .to_string(),
    )
}
fn source_version(source: &Source) -> String {
    fingerprint(
        json!([
            source.id,
            source.title,
            source.kind,
            source.imported_at,
            source.source_url,
            source.text,
            source.note_ids
        ])
        .to_string(),
    )
}
fn citation(space: &Space, note: &Note) -> Value {
    let title = truncate_chars(&note.title, 300).0;
    json!({"id":note.id,"title":title,"version":note_version(note),"orionUrl":orion_note_url(&space.workspace.id,&note.id),"citation":citation_markdown(&title,&space.workspace.id,&note.id)})
}
fn source_ref(source: &Source) -> Value {
    json!({"id":source.id,"title":truncate_chars(&source.title,300).0,"kind":source.kind,"version":source_version(source),"importedAt":source.imported_at,"sourceUrl":source.source_url.as_ref().map(|url|truncate_chars(url,4096).0),"textLength":source.text.chars().count()})
}
fn note<'a>(scope: &'a Space, id: &str) -> Result<&'a Note, ToolFailure> {
    let found: Vec<_> = scope.notes.iter().filter(|note| note.id == id).collect();
    if found.len() > 1 {
        return Err(ToolFailure::new(
            "Duplicate note IDs make this target ambiguous.",
        ));
    }
    found
        .first()
        .copied()
        .ok_or_else(|| ToolFailure::note_not_found(id, &scope.workspace.id))
}
fn source<'a>(scope: &'a Space, id: &str) -> Result<&'a Source, ToolFailure> {
    let found: Vec<_> = scope
        .sources
        .iter()
        .filter(|source| source.id == id)
        .collect();
    if found.len() > 1 {
        return Err(ToolFailure::new(
            "Duplicate source IDs make this target ambiguous.",
        ));
    }
    found
        .first()
        .copied()
        .ok_or_else(|| ToolFailure::source_not_found(id, &scope.workspace.id))
}
fn arg<'a>(args: &'a Map<String, Value>, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}
fn number(args: &Map<String, Value>, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default)
}
fn expected(args: &Map<String, Value>, current: &str) -> Result<(), ToolFailure> {
    if args
        .get("expected_version")
        .is_some_and(|value| value != current)
    {
        return Err(conflict());
    }
    Ok(())
}
fn conflict() -> ToolFailure {
    ToolFailure { message:"The note or source changed. Read it again and use its current version; nothing was saved.".into(),error_code:Some("version_conflict"),recovery:None }
}
fn page(args: &Map<String, Value>, key: &str, items: Vec<Value>) -> Value {
    let total = items.len();
    let offset = number(args, "offset", 0);
    let limit = number(args, "limit", 30);
    let slice: Vec<_> = items.into_iter().skip(offset).take(limit).collect();
    let next = offset.saturating_add(slice.len());
    json!({key:slice,"total":total,"offset":offset,"nextOffset":if next<total {Some(next)} else {None},"truncated":offset>0 || next<total})
}
fn scanned_notes(scope: &Space) -> (Vec<&Note>, Value) {
    let mut bytes = 0;
    let mut notes = Vec::new();
    for note in &scope.notes {
        if notes.len() >= MAX_SCAN_NOTES || bytes + note.body.len() > MAX_SCAN_BYTES {
            break;
        }
        bytes += note.body.len();
        notes.push(note);
    }
    let coverage = json!({"scannedNotes":notes.len(),"totalNotes":scope.notes.len(),"scannedBodyBytes":bytes,"complete":notes.len()==scope.notes.len(),"maxNotes":MAX_SCAN_NOTES,"maxBodyBytes":MAX_SCAN_BYTES});
    (notes, coverage)
}
