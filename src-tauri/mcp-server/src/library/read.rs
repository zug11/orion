use super::*;

pub(super) fn call(scope: &Space, name: &str, args: &Map<String, Value>) -> ToolResult {
    match name {
        "orion_list_sources" => {
            let query = arg(args, "query").to_lowercase();
            let kind = arg(args, "kind");
            Ok(page(
                args,
                "sources",
                scope
                    .sources
                    .iter()
                    .filter(|source| {
                        (kind.is_empty() || source.kind == kind)
                            && (query.is_empty()
                                || source.title.to_lowercase().contains(&query)
                                || source
                                    .source_url
                                    .as_ref()
                                    .is_some_and(|url| url.to_lowercase().contains(&query)))
                    })
                    .map(source_ref)
                    .collect(),
            ))
        }
        "orion_search_sources" => search_sources(scope, args),
        "orion_get_source_passage" => {
            let source = source(scope, arg(args, "source_id"))?;
            expected(args, &source_version(source))?;
            let start = number(args, "start", 0);
            let total = source.text.chars().count();
            if start > total {
                return Err(ToolFailure::new("start is beyond the current source text."));
            }
            let text: String = source
                .text
                .chars()
                .skip(start)
                .take(number(args, "max_chars", 6000))
                .collect();
            let end = start + text.chars().count();
            let notes: Vec<_> = scope
                .notes
                .iter()
                .filter(|note| {
                    note.source_ids.contains(&source.id) || source.note_ids.contains(&note.id)
                })
                .take(50)
                .map(|note| citation(scope, note))
                .collect();
            Ok(
                json!({"source":source_ref(source),"text":text,"start":start,"end":end,"totalChars":total,"offsetUnit":"unicode-scalar","nextStart":if end<total{Some(end)}else{None},"partial":start>0||end<total,"notes":notes}),
            )
        }
        "orion_get_note_section" => {
            let note = note(scope, arg(args, "note_id"))?;
            expected(args, &note_version(note))?;
            let all = text::sections(&note.body);
            let wanted = normalize_link_query(arg(args, "heading"));
            let matches: Vec<_> = all
                .iter()
                .filter(|section| normalize_link_query(&section.title) == wanted)
                .collect();
            if matches.len() > 1 && !args.contains_key("occurrence") {
                return Ok(
                    json!({"note":citation(scope,note),"ambiguous":true,"matchingSections":matches.iter().take(100).enumerate().map(|(i,s)|json!({"occurrence":i+1,"heading":s.title,"level":s.level})).collect::<Vec<_>>(),"matchCount":matches.len(),"instruction":"Pass occurrence to choose one repeated heading."}),
                );
            }
            let section = matches
                .get(number(args, "occurrence", 1) - 1)
                .ok_or_else(|| {
                    ToolFailure::new("No matching heading occurrence exists in this note.")
                })?;
            let start = note.body[..section.start].chars().count();
            let total = note.body[section.start..section.end].chars().count();
            let (body, truncated) = truncate_chars(
                &note.body[section.start..section.end],
                number(args, "max_chars", 6000),
            );
            Ok(
                json!({"note":citation(scope,note),"heading":section.title,"level":section.level,"text":body,"start":start,"end":start+body.chars().count(),"sectionEnd":start+total,"offsetUnit":"unicode-scalar","truncated":truncated,"ambiguous":false}),
            )
        }
        "orion_get_notes" => {
            let mut values = Vec::new();
            for id in args["note_ids"].as_array().unwrap() {
                let note = note(scope, id.as_str().unwrap())?;
                let mut value = citation(scope, note);
                let (body, truncated) =
                    truncate_chars(&note.body, number(args, "max_chars_per_note", 4000));
                value["body"] = json!(body);
                value["bodyTruncated"] = json!(truncated);
                value["bodyLength"] = json!(note.body.chars().count());
                value["tags"] = json!(note
                    .tags
                    .iter()
                    .take(50)
                    .map(|tag| truncate_chars(tag, 100).0)
                    .collect::<Vec<_>>());
                value["pinned"] = json!(note.pinned);
                values.push(value);
            }
            Ok(json!({"notes":values,"consistentSnapshot":true}))
        }
        "orion_list_concepts" => {
            let query = arg(args, "query").to_lowercase();
            Ok(page(
                args,
                "concepts",
                scope
                    .concepts
                    .iter()
                    .filter(|concept| {
                        query.is_empty()
                            || concept.label.to_lowercase().contains(&query)
                            || concept
                                .aliases
                                .iter()
                                .any(|alias| alias.to_lowercase().contains(&query))
                    })
                    .map(|concept| concept_ref(scope, concept))
                    .collect(),
            ))
        }
        "orion_get_concept" => {
            let id = arg(args, "concept_id");
            let matches: Vec<_> = scope
                .concepts
                .iter()
                .filter(|concept| concept.id == id)
                .collect();
            if matches.len() != 1 {
                return Err(ToolFailure::new(
                    "The exact concept is missing or has a duplicate ID in this Space.",
                ));
            }
            let concept = matches[0];
            let mut result = page(
                args,
                "notes",
                scope
                    .notes
                    .iter()
                    .filter(|note| {
                        concept.note_ids.contains(&note.id)
                            || note.concept_ids.contains(&concept.id)
                            || concept.canonical_note_id.as_deref() == Some(&note.id)
                    })
                    .map(|note| citation(scope, note))
                    .collect(),
            );
            result["concept"] = concept_ref(scope, concept);
            result["description"] = json!(truncate_chars(&concept.description, 6000).0);
            result["descriptionTruncated"] = json!(concept.description.chars().count() > 6000);
            result["missingNoteIds"] = json!(concept
                .note_ids
                .iter()
                .filter(|id| !scope.notes.iter().any(|note| note.id == **id))
                .take(100)
                .collect::<Vec<_>>());
            Ok(result)
        }
        "orion_resolve_link" => {
            let phrase = arg(args, "phrase");
            if normalize_link_query(phrase).is_empty() {
                return Err(ToolFailure::new("Use a nonempty link phrase."));
            }
            let mut ids = BTreeSet::new();
            let mut matched = Vec::new();
            let mut unresolved = 0;
            for concept in scope
                .concepts
                .iter()
                .filter(|concept| concept_matches_link_query(concept, phrase))
            {
                matched.push(concept_ref(scope, concept));
                if let Some(id) = concept
                    .canonical_note_id
                    .as_ref()
                    .filter(|id| scope.notes.iter().any(|note| &note.id == *id))
                {
                    ids.insert(id.clone());
                } else {
                    unresolved += 1;
                    for id in &concept.note_ids {
                        if scope.notes.iter().any(|note| &note.id == id) {
                            ids.insert(id.clone());
                        }
                    }
                }
            }
            for note in scope
                .notes
                .iter()
                .filter(|note| note_matches_link_query(note, phrase))
            {
                ids.insert(note.id.clone());
            }
            let total = ids.len();
            let destinations: Vec<_> = ids
                .iter()
                .take(50)
                .filter_map(|id| scope.notes.iter().find(|note| &note.id == id))
                .map(|note| citation(scope, note))
                .collect();
            Ok(
                json!({"phrase":phrase,"resolution":if total==0{"unresolved"}else if total==1&&unresolved==0{"resolved"}else{"ambiguous"},"destinations":destinations,"destinationCount":total,"truncated":total>50||matched.len()>50,"concepts":matched.into_iter().take(50).collect::<Vec<_>>()}),
            )
        }
        "orion_get_related_notes" => related(scope, args),
        "orion_get_provenance" => {
            let origin = note(scope, arg(args, "note_id"))?;
            let sources: Vec<_> = scope
                .sources
                .iter()
                .filter(|source| {
                    origin.source_ids.contains(&source.id) || source.note_ids.contains(&origin.id)
                })
                .collect();
            let mut result = page(
                args,
                "sources",
                sources
                    .iter()
                    .map(|source| {
                        let mut value = source_ref(source);
                        let related: Vec<_> = scope
                            .notes
                            .iter()
                            .filter(|candidate| {
                                candidate.id != origin.id
                                    && (candidate.source_ids.contains(&source.id)
                                        || source.note_ids.contains(&candidate.id))
                            })
                            .collect();
                        value["noteReferencesSource"] =
                            json!(origin.source_ids.contains(&source.id));
                        value["sourceReferencesNote"] = json!(source.note_ids.contains(&origin.id));
                        value["relatedNotes"] = json!(related
                            .iter()
                            .take(20)
                            .map(|note| citation(scope, note))
                            .collect::<Vec<_>>());
                        value["relatedNotesTruncated"] = json!(related.len() > 20);
                        value
                    })
                    .collect(),
            );
            result["note"] = citation(scope, origin);
            result["missingSourceIds"] = json!(origin
                .source_ids
                .iter()
                .filter(|id| !scope.sources.iter().any(|source| source.id == **id))
                .take(100)
                .collect::<Vec<_>>());
            result["evidenceNotice"]=json!("Stored provenance establishes derivation, not claim-level support. Open exact source passages to verify claims.");
            Ok(result)
        }
        "orion_list_tags" => {
            let mut counts = BTreeMap::<&str, usize>::new();
            for note in &scope.notes {
                for tag in note.tags.iter().collect::<BTreeSet<_>>() {
                    *counts.entry(tag).or_default() += 1;
                }
            }
            let query = arg(args, "query").to_lowercase();
            Ok(page(
                args,
                "tags",
                counts
                    .into_iter()
                    .filter(|(tag, _)| query.is_empty() || tag.to_lowercase().contains(&query))
                    .map(|(tag, count)| json!({"tag":truncate_chars(tag,100).0,"noteCount":count}))
                    .collect(),
            ))
        }
        "orion_list_tasks" => tasks(scope, args),
        "orion_find_duplicate_notes" => duplicates(scope, args),
        "orion_check_space_integrity" => integrity(scope, args),
        "orion_get_recent_changes" => {
            let since = OffsetDateTime::parse(arg(args, "since"), &Rfc3339)
                .map_err(|_| ToolFailure::new("since must be a valid RFC3339 timestamp."))?;
            let mut invalid = 0;
            let mut values: Vec<_> = scope
                .notes
                .iter()
                .filter_map(
                    |note| match OffsetDateTime::parse(&note.updated_at, &Rfc3339) {
                        Ok(time) if time > since => Some((time, note)),
                        Err(_) => {
                            invalid += 1;
                            None
                        }
                        _ => None,
                    },
                )
                .collect();
            values.sort_by(|(a, na), (b, nb)| a.cmp(b).then_with(|| na.id.cmp(&nb.id)));
            let mut result = page(
                args,
                "notes",
                values
                    .into_iter()
                    .map(|(_, note)| {
                        let mut value = citation(scope, note);
                        value["updatedAt"] = json!(note.updated_at);
                        value
                    })
                    .collect(),
            );
            result["invalidTimestamps"] = json!(invalid);
            result["historyAvailable"] = json!(false);
            result["notice"]=json!("Current saved notes only; deletions and previous note versions are not recorded by this tool.");
            Ok(result)
        }
        "orion_get_link_path" => link_path(scope, args),
        _ => Err(ToolFailure::new("Unknown library read.")),
    }
}

fn concept_ref(scope: &Space, concept: &Concept) -> Value {
    let canonical = concept
        .canonical_note_id
        .as_ref()
        .and_then(|id| scope.notes.iter().find(|note| &note.id == id));
    json!({"id":concept.id,"label":truncate_chars(&concept.label,300).0,"aliases":concept.aliases.iter().take(30).map(|alias|truncate_chars(alias,200).0).collect::<Vec<_>>(),"aliasesTruncated":concept.aliases.len()>30,"autoLink":concept.auto_link,"canonicalNote":canonical.map(|note|citation(scope,note)),"canonicalMissing":concept.canonical_note_id.is_some()&&canonical.is_none(),"storedNoteCount":concept.note_ids.len()})
}

fn search_sources(scope: &Space, args: &Map<String, Value>) -> ToolResult {
    let query = arg(args, "query");
    let kind = arg(args, "kind");
    let selected = args.get("source_ids").and_then(Value::as_array);
    if let Some(ids) = selected {
        for id in ids {
            source(scope, id.as_str().unwrap())?;
        }
    }
    let sources: Vec<_> = scope
        .sources
        .iter()
        .filter(|source| {
            (kind.is_empty() || source.kind == kind)
                && selected.is_none_or(|ids| ids.iter().any(|id| id == &source.id))
        })
        .collect();
    let mut matches = Vec::new();
    let mut bytes = 0;
    let mut scanned = 0;
    let mut capped = false;
    for source in &sources {
        if bytes + source.text.len() > MAX_SCAN_BYTES || scanned >= MAX_SCAN_NOTES {
            break;
        }
        bytes += source.text.len();
        scanned += 1;
        let version = source_version(source);
        let mut last_byte = 0;
        let mut start = 0;
        for (byte, _) in source.text.match_indices(query) {
            if matches.len() >= 5000 {
                capped = true;
                break;
            }
            start += source.text[last_byte..byte].chars().count();
            last_byte = byte;
            let preview_start = start.saturating_sub(120);
            let preview_byte = source.text[..byte]
                .char_indices()
                .rev()
                .take(120)
                .last()
                .map(|(index, _)| index)
                .unwrap_or(byte);
            let text: String = source.text[preview_byte..]
                .chars()
                .take(query.chars().count() + 240)
                .collect();
            matches.push(json!({"sourceId":source.id,"sourceTitle":truncate_chars(&source.title,300).0,"sourceVersion":version,"matchStart":start,"matchEnd":start+query.chars().count(),"start":preview_start,"end":preview_start+text.chars().count(),"text":text,"offsetUnit":"unicode-scalar"}));
        }
        if capped {
            break;
        }
    }
    let mut result = page(args, "matches", matches);
    result["coverage"] = json!({"scannedSources":scanned,"selectedSources":sources.len(),"scannedBytes":bytes,"complete":scanned==sources.len()&&!capped,"matchesCapped":capped,"maxMatches":5000,"maxBodyBytes":MAX_SCAN_BYTES});
    Ok(result)
}

fn related(scope: &Space, args: &Map<String, Value>) -> ToolResult {
    let origin = note(scope, arg(args, "note_id"))?;
    if origin.body.len() > MAX_SCAN_BYTES {
        return Err(ToolFailure::new(
            "This note exceeds the automatic scan budget. Read specific sections instead.",
        ));
    }
    let forward = note_content_links(scope, origin);
    let (scanned, coverage) = scanned_notes(scope);
    let mut results = Vec::new();
    for candidate in scanned {
        if candidate.id == origin.id {
            continue;
        }
        let mut reasons = Vec::new();
        let mut score = 0;
        if forward.contains_key(&candidate.id) {
            reasons.push("links_to");
            score += 4;
        }
        if note_content_links(scope, candidate).contains_key(&origin.id) {
            reasons.push("linked_from");
            score += 4;
        }
        if scope.relationships.iter().any(|relation| {
            (relation.from_note_id == origin.id && relation.to_note_id == candidate.id)
                || (relation.to_note_id == origin.id && relation.from_note_id == candidate.id)
        }) {
            reasons.push("stored_relationship");
            score += 4;
        }
        if origin.source_ids.iter().any(|id| {
            scope.sources.iter().any(|source| &source.id == id) && candidate.source_ids.contains(id)
        }) {
            reasons.push("shared_source");
            score += 3;
        }
        if origin.concept_ids.iter().any(|id| {
            scope.concepts.iter().any(|concept| &concept.id == id)
                && candidate.concept_ids.contains(id)
        }) {
            reasons.push("shared_concept");
            score += 2;
        }
        if score > 0 {
            let mut value = citation(scope, candidate);
            value["score"] = json!(score);
            value["reasons"] = json!(reasons);
            results.push((score, candidate.id.as_str(), value));
        }
    }
    results.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(b.1)));
    let mut result = page(
        args,
        "notes",
        results.into_iter().map(|(_, _, value)| value).collect(),
    );
    result["origin"] = citation(scope, origin);
    result["coverage"] = coverage;
    Ok(result)
}

fn tasks(scope: &Space, args: &Map<String, Value>) -> ToolResult {
    let (scanned, coverage) = if args.contains_key("note_id") {
        let note = note(scope, arg(args, "note_id"))?;
        if note.body.len() > MAX_SCAN_BYTES {
            return Err(ToolFailure::new("This note exceeds the task scan budget."));
        }
        (
            vec![note],
            json!({"scannedNotes":1,"totalNotes":1,"complete":true}),
        )
    } else {
        scanned_notes(scope)
    };
    let collapse = args
        .get("collapse_derived")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut values: Vec<(&Note, text::Task, Vec<Value>)> = Vec::new();
    let references: BTreeMap<_, _> = scanned
        .iter()
        .map(|note| (note.id.as_str(), citation(scope, note)))
        .collect();
    let mut task_groups = BTreeMap::<String, Vec<usize>>::new();
    let mut copies_truncated = false;
    let mut capped = false;
    for note in scanned {
        for task in text::tasks(&note.body) {
            if values.len() >= 5000 {
                capped = true;
                break;
            }
            let task_text = text::plain(&task.raw);
            let duplicate = if collapse {
                task_groups
                    .get(&task_text)
                    .into_iter()
                    .flatten()
                    .copied()
                    .find(|index| {
                        let (other, _, _) = &values[*index];
                        other.id != note.id
                            && (matches!(other.kind, LegacyNoteKind::Wiki)
                                || matches!(note.kind, LegacyNoteKind::Wiki)
                                || other.source_ids.iter().any(|id| {
                                    scope.sources.iter().any(|source| &source.id == id)
                                        && note.source_ids.contains(id)
                                }))
                    })
            } else {
                None
            };
            if let Some(index) = duplicate {
                let (other, existing, copies) = &mut values[index];
                let mut copy = references[note.id.as_str()].clone();
                copy["lineIndex"] = json!(task.line);
                copy["completed"] = json!(task.checked);
                if matches!(other.kind, LegacyNoteKind::Wiki)
                    && !matches!(note.kind, LegacyNoteKind::Wiki)
                {
                    copy = references[other.id.as_str()].clone();
                    copy["lineIndex"] = json!(existing.line);
                    copy["completed"] = json!(existing.checked);
                    *other = note;
                    *existing = task;
                }
                if copies.len() < 20 {
                    copies.push(copy);
                } else {
                    copies_truncated = true;
                }
            } else {
                task_groups.entry(task_text).or_default().push(values.len());
                values.push((note, task, Vec::new()));
            }
        }
        if capped {
            break;
        }
    }
    let state = if args.contains_key("state") {
        arg(args, "state")
    } else {
        "open"
    };
    let mut result=page(args,"tasks",values.into_iter().filter(|(_,task,_)|state=="all"||task.checked==(state=="completed")).map(|(note,task,copies)|json!({"taskId":format!("{}:{}",note.id,task.line),"note":references[note.id.as_str()],"lineIndex":task.line,"rawText":truncate_chars(&task.raw,50000).0,"text":truncate_chars(&text::plain(&task.raw),2000).0,"textTruncated":task.raw.chars().count()>50000,"completed":task.checked,"concept":text::task_concept(scope,note,&task.raw).map(|concept|concept_ref(scope,concept)),"derivedCopies":copies,"derivedCopiesLimit":20})).collect());
    result["coverage"] = coverage;
    if capped {
        result["coverage"]["complete"] = json!(false);
    }
    result["derivedCopiesTruncated"] = json!(copies_truncated);
    result["tasksCapped"] = json!(capped);
    result["collapseDerived"] = json!(collapse);
    Ok(result)
}

fn duplicates(scope: &Space, args: &Map<String, Value>) -> ToolResult {
    let basis = if args.contains_key("basis") {
        arg(args, "basis")
    } else {
        "body"
    };
    let (notes, coverage) = scanned_notes(scope);
    let mut groups = BTreeMap::<String, Vec<&Note>>::new();
    for note in notes {
        let key = if basis == "title" {
            normalize_link_query(&note.title)
        } else {
            note.body.clone()
        };
        if !key.trim().is_empty() {
            groups.entry(key).or_default().push(note);
        }
    }
    let mut result=page(args,"groups",groups.into_values().filter(|group|group.len()>1).map(|group|json!({"basis":basis,"notes":group.iter().take(30).map(|note|citation(scope,note)).collect::<Vec<_>>(),"noteCount":group.len(),"truncated":group.len()>30,"automaticMerge":false})).collect());
    result["coverage"] = coverage;
    Ok(result)
}

fn integrity(scope: &Space, args: &Map<String, Value>) -> ToolResult {
    let (notes, coverage) = scanned_notes(scope);
    let note_ids: BTreeSet<_> = scope.notes.iter().map(|note| note.id.as_str()).collect();
    let source_ids: BTreeSet<_> = scope
        .sources
        .iter()
        .map(|source| source.id.as_str())
        .collect();
    let concept_ids: BTreeSet<_> = scope
        .concepts
        .iter()
        .map(|concept| concept.id.as_str())
        .collect();
    let mut issues = Vec::new();
    let mut total = 0;
    let mut add = |kind: &str, owner: &str, target: &str| {
        total += 1;
        if issues.len() < 5000 {
            issues.push(json!({"kind":kind,"ownerId":truncate_chars(owner,200).0,"targetId":truncate_chars(target,200).0}));
        }
    };
    for (kind, ids) in [
        (
            "duplicate_note_id",
            scope
                .notes
                .iter()
                .map(|n| n.id.as_str())
                .collect::<Vec<_>>(),
        ),
        (
            "duplicate_source_id",
            scope.sources.iter().map(|n| n.id.as_str()).collect(),
        ),
        (
            "duplicate_concept_id",
            scope.concepts.iter().map(|n| n.id.as_str()).collect(),
        ),
        (
            "duplicate_relationship_id",
            scope.relationships.iter().map(|n| n.id.as_str()).collect(),
        ),
    ] {
        let mut seen = BTreeSet::new();
        for id in ids {
            if !seen.insert(id) {
                add(kind, id, id);
            }
        }
    }
    for note in &scope.notes {
        for id in &note.source_ids {
            if !source_ids.contains(id.as_str()) {
                add("missing_source", &note.id, id);
            }
        }
        for id in &note.concept_ids {
            if !concept_ids.contains(id.as_str()) {
                add("missing_concept", &note.id, id);
            }
        }
    }
    for source in &scope.sources {
        for id in &source.note_ids {
            if !note_ids.contains(id.as_str()) {
                add("source_missing_note", &source.id, id);
            }
        }
    }
    for concept in &scope.concepts {
        for id in &concept.note_ids {
            if !note_ids.contains(id.as_str()) {
                add("concept_missing_note", &concept.id, id);
            }
        }
        if let Some(id) = &concept.canonical_note_id {
            if !note_ids.contains(id.as_str()) {
                add("missing_canonical_note", &concept.id, id);
            }
        }
    }
    for relation in &scope.relationships {
        for id in [&relation.from_note_id, &relation.to_note_id] {
            if !note_ids.contains(id.as_str()) {
                add("relationship_missing_note", &relation.id, id);
            }
        }
        if let Some(id) = &relation.source_id {
            if !source_ids.contains(id.as_str()) {
                add("relationship_missing_source", &relation.id, id);
            }
        }
        if let Some(id) = &relation.concept_id {
            if !concept_ids.contains(id.as_str()) {
                add("relationship_missing_concept", &relation.id, id);
            }
        }
    }
    for note in notes {
        let body = text::lines(&note.body)
            .into_iter()
            .filter(|line| line.visible)
            .map(|line| mask_inline_code(line.text))
            .collect::<Vec<_>>()
            .join("\n");
        for (prefix, ids, kind) in [
            ("](orion-note://", &note_ids, "broken_note_link"),
            ("](orion-concept://", &concept_ids, "broken_concept_link"),
        ] {
            for tail in body.split(prefix).skip(1) {
                let Some((id, _)) = tail.split_once(')') else {
                    continue;
                };
                if !ids.contains(id) {
                    add(kind, &note.id, id);
                }
            }
        }
    }
    let mut result = page(args, "issues", issues);
    result["issueCount"] = json!(total);
    result["issuesCapped"] = json!(total > 5000);
    result["bodyScanCoverage"] = coverage;
    result["metadataScanComplete"] = json!(true);
    result["mutated"] = json!(false);
    Ok(result)
}

fn link_path(scope: &Space, args: &Map<String, Value>) -> ToolResult {
    let origin = note(scope, arg(args, "from_note_id"))?;
    let target = note(scope, arg(args, "to_note_id"))?;
    let hops = number(args, "max_hops", 4);
    let mut queue = VecDeque::from([(origin.id.clone(), 0)]);
    let mut parents = BTreeMap::<String, (String, Vec<String>)>::new();
    let mut seen = BTreeSet::from([origin.id.clone()]);
    let mut bytes = 0;
    let mut edges = 0;
    let mut expanded = 0;
    let mut bounded = false;
    while let Some((id, depth)) = queue.pop_front() {
        if id == target.id {
            break;
        }
        if depth >= hops {
            continue;
        }
        let current = note(scope, &id)?;
        if expanded >= 500 || bytes + current.body.len() > MAX_SCAN_BYTES {
            bounded = true;
            break;
        }
        expanded += 1;
        bytes += current.body.len();
        let mut links = note_content_links(scope, current);
        for relation in scope.relationships.iter().filter(|relation| {
            relation.from_note_id == id
                && scope
                    .notes
                    .iter()
                    .any(|note| note.id == relation.to_note_id)
        }) {
            links
                .entry(relation.to_note_id.clone())
                .or_default()
                .insert("stored_relationship");
        }
        for (next, kinds) in links {
            edges += 1;
            if edges > 10000 {
                bounded = true;
                break;
            }
            if seen.insert(next.clone()) {
                parents.insert(
                    next.clone(),
                    (id.clone(), kinds.into_iter().map(str::to_owned).collect()),
                );
                queue.push_back((next, depth + 1));
            }
        }
        if bounded {
            break;
        }
    }
    let found = seen.contains(&target.id);
    let mut path = Vec::new();
    if found {
        let mut id = target.id.clone();
        loop {
            let mut value = citation(scope, note(scope, &id)?);
            if let Some((parent, kinds)) = parents.get(&id) {
                value["via"] = json!(kinds);
                path.push(value);
                id = parent.clone();
            } else {
                path.push(value);
                break;
            }
        }
        path.reverse();
    }
    Ok(
        json!({"found":found,"path":path,"directed":true,"maxHops":hops,"expandedNotes":expanded,"examinedEdges":edges,"scannedBodyBytes":bytes,"bounded":bounded,"searchCompleteWithinHops":!bounded,"notice":"A connection path establishes navigation, not logical entailment or agreement."}),
    )
}
