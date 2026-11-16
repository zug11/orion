use super::*;

pub(super) fn resolve_id(scope: &Space, args: &Map<String, Value>) -> Result<String, ToolFailure> {
    let id = arg(args, "ticket_id");
    let code = arg(args, "ticket_code");
    if id.is_empty() == code.is_empty() {
        return Err(ToolFailure::new(
            "Supply exactly one ticket_id or ticket_code.",
        ));
    }
    if !id.is_empty() {
        return if valid_id(id) {
            Ok(id.into())
        } else {
            Err(ToolFailure::new("Invalid ticket ID."))
        };
    }
    let matches: Vec<_> = scope.ticket_codes["assigned"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(id, _)| {
            ticket_codes::code(&scope.ticket_codes, id)
                .is_some_and(|value| value.eq_ignore_ascii_case(code))
        })
        .map(|(id, _)| id.clone())
        .collect();
    if matches.len() != 1 {
        return Err(ToolFailure::new(
            "That ticket code is missing or ambiguous in this Space.",
        ));
    }
    Ok(matches[0].clone())
}

pub(super) fn matches_query(scope: &Space, ticket: &Ticket, query: &str) -> bool {
    ticket.id == query
        || ticket_codes::code(&scope.ticket_codes, &ticket.id)
            .is_some_and(|code| code.eq_ignore_ascii_case(query))
        || ticket.title.to_lowercase().contains(&query.to_lowercase())
}

pub(super) fn require_unique(scope: &Space, id: &str, note_id: &str) -> Result<(), ToolFailure> {
    let (entries, coverage) = index(scope);
    let matches: Vec<_> = entries
        .iter()
        .flat_map(|(note, work)| {
            work.tickets
                .iter()
                .filter(|ticket| ticket.id == id)
                .map(move |_| note.id.as_str())
        })
        .collect();
    if coverage["complete"] != true || matches != [note_id] {
        return Err(ToolFailure::new("The ticket identity is missing, duplicated or outside complete Space coverage. Nothing was saved."));
    }
    Ok(())
}

fn children<'a>(work: &'a Work, ticket: &Ticket) -> Vec<&'a Ticket> {
    work.tickets
        .iter()
        .filter(|child| {
            child.id.is_empty()
                && child.range.start > ticket.range.start
                && child.range.end <= ticket.range.end
                && !work.tickets.iter().any(|other| {
                    !other.id.is_empty()
                        && other.id != ticket.id
                        && other.range.start > ticket.range.start
                        && other.range.start < child.range.start
                        && other.range.end >= child.range.end
                })
        })
        .collect()
}

pub(super) fn read(
    scope: &Space,
    args: &Map<String, Value>,
    entries: &[(&Note, Work)],
    coverage: &Value,
    boards: &BTreeSet<String>,
) -> ToolResult {
    if coverage["complete"] != true {
        return Err(ToolFailure::new(
            "Cannot resolve a unique ticket outside complete Space coverage.",
        ));
    }
    let id = resolve_id(scope, args)?;
    let found: Vec<_> = entries
        .iter()
        .flat_map(|(note, work)| {
            work.tickets
                .iter()
                .filter(|t| t.id == id)
                .map(move |t| (*note, work, t))
        })
        .collect();
    if found.len() != 1 {
        return Err(ToolFailure::new(
            "Ticket unavailable or duplicated. For completed tickets request task_view: history.",
        ));
    }
    let (note, work, ticket) = found[0];
    let max = number(args, "max_chars", 6000);
    let (markdown, truncated) = truncate_chars(&note.body[ticket.range.clone()], max);
    let children = children(work, ticket);
    let checklist: Vec<_> = children.iter().take(2000).enumerate().map(|(index, item)| json!({"index":index,"title":item.title,"completed":item.status=="done","lineIndex":item.line})).collect();
    let mut value = ticket_json(scope, note, ticket, boards);
    value["markdown"] = json!(markdown);
    value["truncated"] = json!(truncated);
    value["checklist"] = json!(checklist);
    value["checklistTruncated"] = json!(children.len() > 2000);
    value["url"] = json!(format!(
        "{}&ticket_id={}",
        orion_note_url(&scope.workspace.id, &note.id),
        encode(&ticket.id)
    ));
    let links = note_link_projection(scope, &note.id);
    let (context, context_truncated) = truncate_chars(&note.body, max);
    Ok(
        json!({"ticket":value,"sourceNote": {"note":citation(scope,note),"body":context,"truncated":context_truncated},
        "linksTo":links.links_to,"linkedFrom":links.linked_from,"linksToTruncated":links.links_to_truncated,"linkedFromTruncated":links.linked_from_truncated,
        "verificationNotice":"To report implementation, send implementation_summary and verification checks to orion_update_ticket with this source note's current version. Done requires passing checks and no open checklist items. Orion records caller-supplied evidence; it does not execute commands or independently verify the implementation."}),
    )
}

fn verification(
    args: &Map<String, Value>,
    completing: bool,
) -> Result<Option<&Vec<Value>>, ToolFailure> {
    let summary = arg(args, "implementation_summary");
    let checks = args.get("verification").and_then(Value::as_array);
    if checks.is_some() && summary.trim().is_empty()
        || completing && (summary.trim().is_empty() || checks.is_none_or(Vec::is_empty))
    {
        return Err(ToolFailure::new("Completion requires an implementation_summary and at least one passing verification check with concrete evidence."));
    }
    if let Some(checks) = checks {
        for check in checks {
            if ["label", "evidence"]
                .iter()
                .any(|key| check[*key].as_str().is_none_or(|v| v.trim().is_empty()))
                || completing && check["outcome"] != "passed"
            {
                return Err(ToolFailure::new("Every completion check must pass and include a label and concrete evidence. Failed checks can be reported while work remains open."));
            }
        }
    }
    Ok(checks)
}

pub(super) fn apply(
    _scope: &Space,
    note: &Note,
    ticket: &Ticket,
    args: &Map<String, Value>,
    status: &str,
) -> Result<String, ToolFailure> {
    let work = scan(&note.body);
    let checklist = children(&work, ticket);
    let mut body = note.body.clone();
    if let Some(changes) = args.get("checklist").and_then(Value::as_array) {
        let mut seen = BTreeSet::new();
        for change in changes {
            let index = change["line_index"].as_u64().unwrap() as usize;
            let item = checklist
                .iter()
                .find(|item| item.line == index)
                .ok_or_else(|| {
                    ToolFailure::new("Checklist index is no longer valid. Read the current ticket.")
                })?;
            if !seen.insert(index) || change["expected_title"] != item.title {
                return Err(ToolFailure::new(
                    "Checklist text changed or an index is repeated. Nothing was saved.",
                ));
            }
            body.replace_range(
                item.marker..item.marker + 1,
                if change["completed"] == true {
                    "x"
                } else {
                    " "
                },
            );
        }
    }
    let completing = status == "done" && ticket.status != "done";
    let checks = verification(args, completing)?;
    if completing
        && checklist
            .iter()
            .any(|item| &body[item.marker..item.marker + 1] == " ")
    {
        return Err(ToolFailure::new("Complete or explicitly revise the remaining checklist before marking this ticket Done."));
    }
    let summary = arg(args, "implementation_summary").trim();
    if !summary.is_empty() {
        let start = body[..ticket.range.start].rfind('\n').map_or(0, |p| p + 1);
        let indent = body[start..]
            .chars()
            .take_while(|c| *c == ' ' || *c == '\t')
            .collect::<String>()
            + "  ";
        let nl = if body.contains("\r\n") { "\r\n" } else { "\n" };
        let mut lines = vec![
            format!("Implementation report · MCP · {}", now_iso()?),
            String::new(),
            literal(summary),
        ];
        if let Some(checks) = checks {
            lines.push(String::new());
            lines.push("Verification evidence (reported by the coding agent):".into());
            for check in checks {
                lines.push(format!(
                    "- {} — {}: {}",
                    literal(check["label"].as_str().unwrap()),
                    check["outcome"].as_str().unwrap(),
                    literal(check["evidence"].as_str().unwrap())
                ));
            }
        }
        let report = lines
            .join("\n")
            .lines()
            .map(|line| {
                if line.is_empty() {
                    String::new()
                } else {
                    format!("{indent}{line}")
                }
            })
            .collect::<Vec<_>>()
            .join(nl);
        // Item ranges may own trailing newlines. Insert before them so a report
        // stays inside this task and never captures the next sibling's prose.
        let end = ticket.range.end - body[ticket.range.clone()].len()
            + body[ticket.range.clone()]
                .trim_end_matches(['\r', '\n'])
                .len();
        body.insert_str(end, &format!("{nl}{nl}{report}"));
    }
    Ok(body)
}

/// All direct MCP writers share this boundary, including generic exact edits.
/// Only the validated ticket operation can authorize an open-to-done transition.
pub(crate) fn validate_completions(
    before: &Value,
    after: &Value,
    result: &Value,
) -> Result<(), ToolFailure> {
    let allowed = result.get("verifiedTicketIds").and_then(Value::as_array);
    for space in after["spaces"].as_array().into_iter().flatten() {
        let Some(old) = before["spaces"].as_array().and_then(|spaces| {
            spaces
                .iter()
                .find(|s| s["workspace"]["id"] == space["workspace"]["id"])
        }) else {
            continue;
        };
        let earlier: Vec<_> = old["notes"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|note| scan(note["body"].as_str().unwrap_or("")).tickets)
            .collect();
        for note in space["notes"].as_array().into_iter().flatten() {
            for ticket in scan(note["body"].as_str().unwrap_or("")).tickets {
                if !ticket.id.is_empty()
                    && ticket.status == "done"
                    && earlier
                        .iter()
                        .any(|t| t.id == ticket.id && t.status != "done")
                    && !(result["spaceId"] == space["workspace"]["id"]
                        && allowed.is_some_and(|ids| ids.iter().any(|id| id == &ticket.id)))
                {
                    return Err(ToolFailure::new("Ticket completion requires orion_update_ticket with a current note version, implementation summary and passing verification evidence. Nothing was saved."));
                }
            }
        }
    }
    Ok(())
}
