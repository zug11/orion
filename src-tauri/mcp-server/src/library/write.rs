use super::*;

pub(super) fn call(path: &Path, name: &str, args: &Map<String, Value>) -> ToolResult {
    let space_id = required_write_space_id(args)?;
    if name == "orion_batch_update_metadata"
        && !args.contains_key("tags")
        && !args.contains_key("pinned")
    {
        return Err(ToolFailure::new("Provide tags, pinned, or both."));
    }
    mutate_vault(path, |raw| {
        let vault = validate_vault_value(raw.clone())?;
        let scope = require_space(&vault, &space_id)?;
        if vault
            .spaces
            .iter()
            .filter(|space| space.workspace.id == space_id)
            .count()
            != 1
        {
            return Err(ToolFailure::new(
                "Duplicate Space IDs make this edit ambiguous.",
            ));
        }
        let requests: Vec<_> = if name == "orion_batch_update_metadata" {
            args["notes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    (
                        item["note_id"].as_str().unwrap(),
                        item["expected_version"].as_str().unwrap(),
                    )
                })
                .collect()
        } else {
            vec![(arg(args, "note_id"), arg(args, "expected_version"))]
        };
        let mut seen = BTreeSet::new();
        let mut changes = Vec::new();
        let mut content_changed = false;
        for (id, version) in requests {
            if !seen.insert(id) {
                return Err(ToolFailure::new(
                    "Each note ID must occur exactly once in a batch.",
                ));
            }
            let current = note(scope, id)?;
            if note_version(current) != version {
                return Err(conflict());
            }
            let mut fields = Map::new();
            if name == "orion_batch_update_metadata" {
                if args.contains_key("tags") {
                    let tags = optional_string_array(args, "tags", 50, 100)?.unwrap();
                    if tags != current.tags {
                        fields.insert("tags".into(), json!(tags));
                        content_changed = true;
                    }
                }
                if let Some(pinned) = optional_bool(args, "pinned")? {
                    if pinned != current.pinned {
                        fields.insert("pinned".into(), json!(pinned));
                    }
                }
            } else {
                let body = match name {
                    "orion_append_to_note" => format!("{}{}", current.body, arg(args, "text")),
                    "orion_edit_note_text" => {
                        let old = arg(args, "old_text");
                        // Overlapping occurrences are ambiguous too: aa in aaa.
                        let mut occurrences = current
                            .body
                            .char_indices()
                            .filter(|(index, _)| current.body[*index..].starts_with(old));
                        let index =
                            occurrences.next().map(|(index, _)| index).ok_or_else(|| {
                                ToolFailure::new(
                                    "The exact selected text is absent. Nothing was saved.",
                                )
                            })?;
                        if occurrences.next().is_some() {
                            return Err(ToolFailure::new("The selected text occurs more than once. Supply a longer unique selection."));
                        }
                        let mut body = current.body.clone();
                        body.replace_range(index..index + old.len(), arg(args, "new_text"));
                        body
                    }
                    "orion_set_task_completion" => {
                        let task = text::tasks(&current.body)
                            .into_iter()
                            .find(|task| task.line == number(args, "line_index", 0))
                            .ok_or_else(|| {
                                ToolFailure::new("That line is not an editable Markdown task.")
                            })?;
                        if task.raw != arg(args, "expected_text") {
                            return Err(ToolFailure::new("The task text does not match the selected line. Nothing was saved."));
                        }
                        let completed = args["completed"].as_bool().unwrap();
                        let mut body = current.body.clone();
                        if task.checked != completed {
                            body.replace_range(
                                task.marker_byte..task.marker_byte + 1,
                                if completed { "x" } else { " " },
                            );
                        }
                        body
                    }
                    _ => return Err(ToolFailure::new("Unknown guarded edit.")),
                };
                if body.chars().count() > MAX_NOTE_BODY_CHARS {
                    return Err(ToolFailure::new(
                        "The edited body exceeds Orion's 500,000-character note limit.",
                    ));
                }
                if body != current.body {
                    fields.insert("body".into(), json!(body));
                    content_changed = true;
                }
            }
            changes.push((id.to_string(), fields));
        }
        // Apply only after every selection/version validates under the vault lock.
        let changed = changes.iter().any(|(_, fields)| !fields.is_empty());
        let now = now_iso()?;
        let target = require_space_value_mut(raw, &space_id)?;
        let records = required_array_mut(target, "notes")?;
        for (id, fields) in &changes {
            if fields.is_empty() {
                continue;
            }
            let record = records
                .iter_mut()
                .find(|record| record["id"] == *id)
                .and_then(Value::as_object_mut)
                .unwrap();
            record.extend(fields.clone());
            set_updated_at(record, &now);
        }
        if changed {
            if content_changed {
                mark_space_overview_stale(target);
            }
            set_updated_at(target, &now);
            set_updated_at(raw.as_object_mut().unwrap(), &now);
        }
        let after = validate_vault_value(raw.clone())?;
        let scope = require_space(&after, &space_id)?;
        let mut results = Vec::new();
        for (id, fields) in &changes {
            let current = note(scope, id)?;
            let mut result = citation(scope, current);
            result["changed"] = json!(!fields.is_empty());
            result["pinned"] = json!(current.pinned);
            result["tags"] = json!(current
                .tags
                .iter()
                .take(50)
                .map(|tag| truncate_chars(tag, 100).0)
                .collect::<Vec<_>>());
            let links = note_link_projection(scope, id);
            result["linksTo"] = json!(links.links_to);
            result["linkedFrom"] = json!(links.linked_from);
            result["linksToTruncated"] = json!(links.links_to_truncated);
            result["linkedFromTruncated"] = json!(links.linked_from_truncated);
            results.push(result);
        }
        let result = json!({"spaceId":space_id,"changed":changed,"notes":results,"vaultRevision":after.updated_at,"atomic":true});
        if serde_json::to_vec(&result).unwrap().len() > 2 * 1024 * 1024 {
            return Err(ToolFailure::new(
                "Edit receipt exceeds the result bound. Nothing was saved; select fewer notes.",
            ));
        }
        Ok(result)
    })
}
