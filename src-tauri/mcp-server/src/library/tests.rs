use super::*;

fn record(id: &str, title: &str, body: &str) -> Value {
    json!({"id":id,"title":title,"slug":id,"body":body,"summary":"","kind":"article","status":"ready","aliases":[],"tags":["work"],"conceptIds":[],"sourceIds":[],"createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-02T00:00:00Z","pinned":false})
}
fn fixture() -> Value {
    let mut first=record("n1","Alpha","---\nignored: yes\n---\n# Overview\nalpha 🧭 evidence\n## Detail\n- [ ] Check [Beta](orion-note://n2)\n~~~txt\n- [ ] ignore\n~~~\n## Detail\nsecond detail\n");
    first["sourceIds"] = json!(["s1"]);
    first["conceptIds"] = json!(["c1"]);
    first["aliases"] = json!(["First"]);
    let mut second = record(
        "n2",
        "Beta",
        "# Beta\n[Next](orion-note://n3)\n- [ ] Repeat\n",
    );
    second["sourceIds"] = json!(["s1"]);
    let mut copy = record(
        "copy",
        "Canonical copy",
        "- [ ] Check [Beta](orion-note://n2)\n",
    );
    copy["kind"] = json!("wiki");
    let scope = json!({"schemaVersion":1,"workspace":{"id":"a","name":"Alpha Space","createdAt":"2026-09-01T00:00:00Z"},"notes":[first,second,record("n3","Gamma","- [ ] Repeat\n"),copy,record("dupe","Gamma duplicate","- [ ] Repeat\n")],"sources":[{"id":"s1","title":"Source one","kind":"text","text":"é😀 source evidence\nsecond evidence","noteIds":["n1","n2"],"importedAt":"2026-09-01T00:00:00Z","sourceUrl":"https://example.org/source"}],"concepts":[{"id":"c1","label":"Alpha","aliases":["First"],"description":"The first idea","noteIds":["n1"],"canonicalNoteId":"n1","autoLink":true}],"relationships":[],"spaceOverview":{"title":"Summary","body":"Orientation","relatedNoteIds":["n1"],"generatedAt":"2026-09-01T00:00:00Z","stale":false},"settings":{"privateSetting":"preserve"},"updatedAt":"2026-09-02T00:00:00Z"});
    let mut other = scope.clone();
    other["workspace"]["id"] = json!("b");
    other["notes"] = json!([record("secret", "SECRET OTHER SPACE", "foreign secret")]);
    other["sources"] = json!([]);
    other["concepts"] = json!([]);
    other["spaceOverview"] = Value::Null;
    json!({"schemaVersion":2,"activeSpaceId":"a","spaces":[scope,other],"updatedAt":"2026-09-02T00:00:00Z"})
}
fn server(vault: &Value) -> (tempfile::TempDir, Server) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("vault.json");
    fs::write(&path, serde_json::to_vec(vault).unwrap()).unwrap();
    (
        dir,
        Server {
            vault_path: path,
            uses_default_vault_path: false,
        },
    )
}
fn run(server: &Server, name: &str, args: Value) -> Value {
    server.call_tool(name, args.as_object().unwrap()).unwrap()
}
fn version(server: &Server, id: &str) -> String {
    run(server, "orion_get_notes", json!({"note_ids":[id]}))["notes"][0]["version"]
        .as_str()
        .unwrap()
        .into()
}

fn editor_command(server: &Server, fields: Value) -> Value {
    let mut args = json!({"space_id":"a","note_id":"n1","expected_version":version(server,"n1")});
    args.as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    args
}

fn saved_body(server: &Server) -> String {
    let vault: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    vault["spaces"][0]["notes"][0]["body"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn note_commands_use_portable_blocks_and_keep_guarded_edits_atomic() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] =
        json!("Lead paragraph.\n\nreplace-me\n\nTail paragraph.");
    let (_dir, server) = server(&initial);
    let args = editor_command(
        &server,
        json!({"command":"h3","placement":"replace","anchor":"replace-me","text":"A *literal* heading"}),
    );
    let result = run(&server, NAMES[20], args.clone());
    assert_eq!(result["changed"], true);
    assert_eq!(result["atomic"], true);
    assert_eq!(
        saved_body(&server),
        "Lead paragraph.\n\n### A \\*literal\\* heading\n\nTail paragraph."
    );
    let before = fs::read(&server.vault_path).unwrap();
    assert!(server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);

    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"block","placement":"replace","anchor":"Tail paragraph."}),
        ),
    );
    assert!(saved_body(&server)
        .contains("<!-- orion-block:v1 -->\nTail paragraph.\n<!-- /orion-block -->\n\n"));
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"todo","items":[{"text":"Review *draft*"},{"text":"Publish","checked":true}]}),
        ),
    );
    let tasks = run(
        &server,
        "orion_list_tasks",
        json!({"note_id":"n1","state":"all"}),
    );
    assert_eq!(tasks["tasks"].as_array().unwrap().len(), 2);
    assert!(saved_body(&server).contains("- [ ] Review \\*draft\\*\n- [x] Publish"));
    let after: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(after["spaces"][1], initial["spaces"][1]);
    assert_eq!(
        after["spaces"][0]["settings"],
        initial["spaces"][0]["settings"]
    );
    assert_eq!(
        after["spaces"][0]["sources"],
        initial["spaces"][0]["sources"]
    );
    assert_eq!(after["spaces"][0]["spaceOverview"]["stale"], true);
}

#[test]
fn note_commands_preserve_literal_lists_code_tables_and_all_heading_levels() {
    let (_dir, server) = server(&fixture());
    for level in 1..=6 {
        let command = format!("h{level}");
        run(
            &server,
            NAMES[20],
            editor_command(
                &server,
                json!({"command":command,"text":format!("Heading {level}")}),
            ),
        );
        assert!(saved_body(&server).contains(&format!("{} Heading {level}", "#".repeat(level))));
    }
    for fields in [
        json!({"command":"heading","level":4,"text":"Explicit level"}),
        json!({"command":"text","text":"1. Literal paragraph"}),
        json!({"command":"text","text":"Literal &amp; and &#35; words."}),
        json!({"command":"bullet","items":[{"text":"Same"},{"text":"Same"}]}),
        json!({"command":"numbered","items":[{"text":"First"},{"text":"Second"}]}),
        json!({"command":"divider"}),
        json!({"command":"quote","text":"A *literal* quote.\nSecond line"}),
        json!({"command":"code","language":"rust","text":"````\n<!-- orion-block:v1 -->\n````"}),
        json!({"command":"table","header":false,"rows":[["A | B","First\nsecond"],["C","D"]]}),
    ] {
        run(&server, NAMES[20], editor_command(&server, fields));
    }
    let body = saved_body(&server);
    assert!(body.contains("#### Explicit level"));
    assert!(body.contains("1\\. Literal paragraph"));
    assert!(body.contains("Literal \\&amp; and \\&\\#35; words\\."));
    assert!(body.contains("- Same\n- Same"));
    assert!(body.contains("1. First\n2. Second"));
    assert!(body.contains("> A \\*literal\\* quote\\.\n> Second line"));
    assert!(body.contains("`````rust\n````\n<!-- orion-block:v1 -->\n````\n`````"));
    assert!(body.contains("<!-- orion-table:v1 {\"banded\":true,\"columns\":[null,null],\"header\":false,\"width\":100} -->"));
    assert!(body.contains("| A \\| B | First<br>second |"));
}

#[test]
fn note_commands_flatten_balanced_blocks_but_preserve_fenced_examples() {
    let (_dir, server) = server(&fixture());
    let content = "<!-- orion-block:v1 -->\nBefore\n<!-- orion-block:v1 -->\nInside\n<!-- /orion-block -->\n<!-- /orion-block -->\n\n```html\n<!-- orion-block:v1 -->\n<!-- /orion-block -->\n```";
    run(
        &server,
        NAMES[20],
        editor_command(&server, json!({"command":"block","text":content})),
    );
    let body = saved_body(&server);
    assert_eq!(body.matches("<!-- orion-block:v1 -->").count(), 2);
    assert_eq!(body.matches("<!-- /orion-block -->").count(), 2);
    assert!(body.contains("```html\n<!-- orion-block:v1 -->\n<!-- /orion-block -->\n```"));
    for text in [
        "<!-- /orion-block -->",
        "<!-- orion-block:v1 -->\nUnclosed",
        "```\nUnclosed",
    ] {
        let args = editor_command(&server, json!({"command":"block","text":text}));
        let before = fs::read(&server.vault_path).unwrap();
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

#[test]
fn note_commands_validate_link_excerpt_and_managed_image_sources_in_the_locked_space() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][1]["body"] = json!("A precise 🧭 quotation.\n\n![Local image](orion-image://localhost/local_asset_1234 \"Image title\")");
    let (_dir, server) = server(&initial);
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"link","target_note_id":"n2","placement":"replace","anchor":"alpha 🧭 evidence","text":"Read Beta"}),
        ),
    );
    assert!(saved_body(&server).contains("[Read Beta](orion-note://n2)"));
    let source_version = version(&server, "n2");
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"excerpt","target_note_id":"n2","target_expected_version":source_version,"text":"A precise 🧭 quotation."}),
        ),
    );
    let body = saved_body(&server);
    assert!(body.contains("> A precise 🧭 quotation\\."));
    assert!(body.contains("orion-note://n2 \"orion-excerpt:v2:"));
    assert!(body.contains("%22noteId%22%3A%22n2%22"));
    assert!(body.contains("%22passages%22%3A%5B%7B%22text%22"));
    assert!(!body.contains("%22from%22"));
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"image","image_url":"orion-image://localhost/local_asset_1234","alt":"Existing [image]"}),
        ),
    );
    assert!(saved_body(&server)
        .contains("![Existing \\[image\\]](orion-image://localhost/local_asset_1234)"));
    let after: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(
        after["spaces"][0]["notes"][1],
        initial["spaces"][0]["notes"][1]
    );
    for fields in [
        json!({"command":"link","target_note_id":"secret"}),
        json!({"command":"excerpt","target_note_id":"n2","target_expected_version":"stale","text":"A precise 🧭 quotation."}),
        json!({"command":"excerpt","target_note_id":"n2","target_expected_version":source_version,"text":"Fabricated words"}),
        json!({"command":"image","image_url":"orion-image://localhost/foreign_asset_1234"}),
        json!({"command":"image","image_url":"https://example.org/private.png"}),
        json!({"command":"image","image_url":"file:///private.png"}),
    ] {
        let args = editor_command(&server, fields);
        let before = fs::read(&server.vault_path).unwrap();
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

#[test]
fn note_commands_reject_ambiguous_malformed_irrelevant_and_oversized_inputs_without_writes() {
    let (_dir, server) = server(&fixture());
    for fields in [
        json!({"command":"text","text":"Safe","placement":"replace","anchor":"Detail"}),
        json!({"command":"text","text":"Safe","placement":"before","anchor":"Missing"}),
        json!({"command":"text","text":"Safe","placement":"replace"}),
        json!({"command":"text","text":"Safe","anchor":"unused"}),
        json!({"command":"divider","text":"unused"}),
        json!({"command":"h2","text":"Heading\nInjected paragraph"}),
        json!({"command":"bullet","items":[{"text":"Item","checked":true}]}),
        json!({"command":"table","rows":[["A","B"],["C"]]}),
        json!({"command":"table","rows":[vec!["A";13]]}),
        json!({"command":"code","text":"body","language":"rust\nmalicious"}),
        json!({"command":"text","text":"X".repeat(50001)}),
        json!({"command":"text","text":"    Would become code"}),
        json!({"command":"quote","text":"\tWould become code"}),
        json!({"command":"text","text":"Control\u{007f}character"}),
        json!({"command":"table","rows":[]}),
        json!({"command":"table","rows":[[]]}),
        json!({"command":"table","rows":["wrong-type"]}),
        json!({"command":"todo","items":[]}),
        json!({"command":"todo","items":[{"checked":true}]}),
        json!({"command":"delete-row"}),
        json!({"command":"/shell","text":"rm -rf anything"}),
        json!({"command":"text","text":"Safe","extra_field":true}),
        json!({"command":"text","text":"Safe","space_id":"b"}),
    ] {
        let args = editor_command(&server, fields);
        let before = fs::read(&server.vault_path).unwrap();
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "{args}"
        );
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

#[test]
fn note_commands_keep_frontmatter_and_reject_insertions_inside_code_or_existing_blocks() {
    let (_dir, server) = server(&fixture());
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"heading","placement":"prepend","text":"First visible heading"}),
        ),
    );
    assert!(saved_body(&server)
        .starts_with("---\nignored: yes\n---\n\n## First visible heading\n\n# Overview"));
    for fields in [
        json!({"command":"heading","placement":"before","anchor":"ignored: yes","text":"No metadata corruption"}),
        json!({"command":"heading","placement":"after","anchor":"- [ ] ignore","text":"No literal heading inside code"}),
    ] {
        let args = editor_command(&server, fields);
        let before = fs::read(&server.vault_path).unwrap();
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"block","text":"Existing writing block"}),
        ),
    );
    for placement in ["before", "after", "replace"] {
        let args = editor_command(
            &server,
            json!({"command":"block","placement":placement,"anchor":"Existing writing block","text":"Nested block"}),
        );
        let before = fs::read(&server.vault_path).unwrap();
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
    for unfinished in [
        "```\nUnclosed code",
        "<!-- orion-block:v1 -->\nUnclosed block",
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(unfinished);
        let (_dir, broken) = self::server(&initial);
        let args = editor_command(
            &broken,
            json!({"command":"block","text":"New writing block"}),
        );
        assert!(broken
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
    }
}

#[test]
fn note_commands_do_not_reuse_images_from_markdown_examples_or_other_spaces() {
    let url = "orion-image://localhost/example_asset_1234";
    for example in [
        format!("`![Example]({url})`"),
        format!("``multi-line\n![Example]({url})\nexample``"),
        format!("\\![Example]({url})"),
        format!("    ![Example]({url})"),
        format!("```markdown\n![Example]({url})\n```"),
        format!("<!-- ![Example]({url}) -->"),
        format!("<!--\n![Example]({url})\n-->"),
        format!("![Incomplete]({url} \"No closing title"),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][1]["body"] = json!(example);
        initial["spaces"][1]["notes"][0]["body"] = json!(format!("![Real, other Space]({url})"));
        let (_dir, server) = server(&initial);
        let args = editor_command(&server, json!({"command":"image","image_url":url}));
        let before = fs::read(&server.vault_path).unwrap();
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "{example}"
        );
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}
fn read_cases() -> Vec<(&'static str, Value)> {
    vec![
        (NAMES[0], json!({})),
        (NAMES[1], json!({"query":"evidence"})),
        (NAMES[2], json!({"source_id":"s1","start":1,"max_chars":2})),
        (
            NAMES[3],
            json!({"note_id":"n1","heading":"Detail","occurrence":2}),
        ),
        (NAMES[4], json!({"note_ids":["n1","n2"]})),
        (NAMES[5], json!({})),
        (NAMES[6], json!({"concept_id":"c1"})),
        (NAMES[7], json!({"phrase":"First"})),
        (NAMES[8], json!({"note_id":"n1"})),
        (NAMES[9], json!({"note_id":"n1"})),
        (NAMES[10], json!({})),
        (NAMES[11], json!({})),
        (NAMES[16], json!({})),
        (NAMES[17], json!({})),
        (NAMES[18], json!({"since":"2026-09-01T00:00:00Z"})),
        (NAMES[19], json!({"from_note_id":"n1","to_note_id":"n3"})),
    ]
}

#[test]
fn all_library_tools_have_distinct_validated_contracts_and_read_calls_preserve_the_vault() {
    let (_dir, server) = server(&fixture());
    let before = fs::read(&server.vault_path).unwrap();
    assert_eq!(definitions().len(), 21);
    assert_eq!(tool_definitions().len(), 44);
    let unique: BTreeSet<_> = definitions()
        .iter()
        .map(|def| def["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(unique.len(), 21);
    for (name, args) in read_cases() {
        let value = run(&server, name, args.clone());
        assert_eq!(value["spaceId"], "a", "{name}");
        assert!(!value.to_string().contains("SECRET OTHER SPACE"), "{name}");
        let mut invalid = args;
        invalid["grant_access"] = json!(true);
        assert!(server
            .call_tool(name, invalid.as_object().unwrap())
            .is_err());
    }
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
}

#[test]
fn source_ranges_and_search_use_exact_unicode_offsets_and_reject_stale_versions() {
    let (_dir, server) = server(&fixture());
    let value = run(
        &server,
        NAMES[2],
        json!({"source_id":"s1","start":1,"max_chars":2}),
    );
    assert_eq!(value["text"], "😀 ");
    assert_eq!(value["end"], 3);
    assert_eq!(value["nextStart"], 3);
    let found = run(&server, NAMES[1], json!({"query":"evidence"}));
    let text = fixture()["spaces"][0]["sources"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned();
    for found in found["matches"].as_array().unwrap() {
        let start = found["matchStart"].as_u64().unwrap() as usize;
        let end = found["matchEnd"].as_u64().unwrap() as usize;
        assert_eq!(
            text.chars()
                .skip(start)
                .take(end - start)
                .collect::<String>(),
            "evidence"
        );
    }
    assert!(server
        .call_tool(
            NAMES[2],
            json!({"source_id":"s1","expected_version":"stale"})
                .as_object()
                .unwrap()
        )
        .is_err());
    assert!(server
        .call_tool(
            NAMES[2],
            json!({"source_id":"s1","start":999999})
                .as_object()
                .unwrap()
        )
        .is_err());
    assert!(server
        .call_tool(
            NAMES[1],
            json!({"query":"evidence","source_ids":["foreign"]})
                .as_object()
                .unwrap()
        )
        .is_err());
}

#[test]
fn headings_tasks_and_provenance_keep_identity_and_ambiguity_explicit() {
    let (_dir, server) = server(&fixture());
    let ambiguous = run(
        &server,
        NAMES[3],
        json!({"note_id":"n1","heading":"Detail"}),
    );
    assert_eq!(ambiguous["ambiguous"], true);
    let second = run(
        &server,
        NAMES[3],
        json!({"note_id":"n1","heading":"Detail","occurrence":2}),
    );
    assert!(second["text"].as_str().unwrap().contains("second detail"));
    assert!(!second["text"].as_str().unwrap().contains("Check"));
    let tasks = run(&server, NAMES[11], json!({}));
    let tasks = tasks["tasks"].as_array().unwrap();
    assert_eq!(tasks.len(), 4);
    assert_eq!(
        tasks.iter().filter(|task| task["text"] == "Repeat").count(),
        3
    );
    let check = tasks
        .iter()
        .find(|task| task["note"]["id"] == "n1")
        .unwrap();
    assert_eq!(check["lineIndex"], 6);
    assert_eq!(check["derivedCopies"][0]["id"], "copy");
    let provenance = run(&server, NAMES[9], json!({"note_id":"n1"}));
    assert_eq!(provenance["sources"][0]["id"], "s1");
    assert_eq!(provenance["sources"][0]["noteReferencesSource"], true);
    assert_eq!(
        run(&server, NAMES[7], json!({"phrase":"First"}))["destinations"][0]["id"],
        "n1"
    );
    let path = run(
        &server,
        NAMES[19],
        json!({"from_note_id":"n1","to_note_id":"n3"}),
    );
    assert_eq!(
        path["path"]
            .as_array()
            .unwrap()
            .iter()
            .map(|step| step["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["n1", "n2", "n3"]
    );
    assert_eq!(
        run(
            &server,
            NAMES[19],
            json!({"from_note_id":"n3","to_note_id":"n1"})
        )["found"],
        false
    );
    assert_eq!(
        run(
            &server,
            NAMES[19],
            json!({"from_note_id":"n1","to_note_id":"n3","max_hops":1})
        )["found"],
        false
    );
    let duplicates = run(&server, NAMES[16], json!({}));
    assert_eq!(duplicates["groups"][0]["noteCount"], 2);
    assert_eq!(run(&server, NAMES[17], json!({}))["issueCount"], 0);
}

#[test]
fn guarded_edits_preserve_other_text_and_retries_cannot_double_append() {
    let initial = fixture();
    let (_dir, server) = server(&initial);
    let ver = version(&server, "n1");
    let args = json!({"space_id":"a","note_id":"n1","expected_version":ver,"line_index":6,"expected_text":"Check [Beta](orion-note://n2)","completed":true});
    let result = run(&server, NAMES[12], args.clone());
    assert_eq!(result["changed"], true);
    assert!(server
        .call_tool(NAMES[12], args.as_object().unwrap())
        .is_err());
    let after: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(
        after["spaces"][0]["notes"][0]["body"],
        initial["spaces"][0]["notes"][0]["body"]
            .as_str()
            .unwrap()
            .replacen("- [ ] Check", "- [x] Check", 1)
    );
    assert_eq!(after["spaces"][1], initial["spaces"][1]);
    assert_eq!(
        after["spaces"][0]["settings"],
        initial["spaces"][0]["settings"]
    );
    assert_eq!(after["spaces"][0]["spaceOverview"]["stale"], true);
    run(
        &server,
        NAMES[13],
        json!({"space_id":"a","note_id":"n1","expected_version":version(&server,"n1"),"old_text":"alpha 🧭 evidence","new_text":"revised 🧭 evidence"}),
    );
    let args = json!({"space_id":"a","note_id":"n1","expected_version":version(&server,"n1"),"text":"\nA final paragraph."});
    run(&server, NAMES[14], args.clone());
    assert!(server
        .call_tool(NAMES[14], args.as_object().unwrap())
        .is_err());
    let value = run(&server, NAMES[4], json!({"note_ids":["n1"]}));
    assert_eq!(
        value["notes"][0]["body"]
            .as_str()
            .unwrap()
            .matches("A final paragraph.")
            .count(),
        1
    );
}

#[test]
fn batch_metadata_is_all_or_nothing_and_pin_only_does_not_stale_overview() {
    let (_dir, server) = server(&fixture());
    let before = fs::read(&server.vault_path).unwrap();
    let invalid = json!({"space_id":"a","notes":[{"note_id":"n1","expected_version":version(&server,"n1")},{"note_id":"n2","expected_version":"stale"}],"tags":["new"]});
    assert!(server
        .call_tool(NAMES[15], invalid.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    let selection = json!([{"note_id":"n1","expected_version":version(&server,"n1")},{"note_id":"n2","expected_version":version(&server,"n2")}]);
    let result = run(
        &server,
        NAMES[15],
        json!({"space_id":"a","notes":selection,"pinned":true}),
    );
    assert_eq!(result["notes"].as_array().unwrap().len(), 2);
    let value: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(value["spaces"][0]["spaceOverview"]["stale"], false);
    run(
        &server,
        NAMES[15],
        json!({"space_id":"a","notes":[{"note_id":"n1","expected_version":version(&server,"n1")}],"tags":["durable"]}),
    );
    assert_eq!(
        run(&server, NAMES[10], json!({"query":"durable"}))["tags"][0]["noteCount"],
        1
    );
}

#[test]
fn markdown_parsing_handles_crlf_long_fences_and_setext_without_editing_examples() {
    let markdown="---\r\n- [ ] metadata\r\n---\r\nTitle\r\n=====\r\n````md\r\n```\r\n- [ ] example\r\n````\r\n## Child\r\n  + [X] 🧭 keep  \r\n~~~\r\n- [ ] other example\r\n~~~\r\n";
    let tasks = text::tasks(markdown);
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].line, 10);
    assert_eq!(tasks[0].raw, "🧭 keep");
    assert_eq!(
        &markdown[tasks[0].marker_byte..tasks[0].marker_byte + 1],
        "X"
    );
    let sections = text::sections(markdown);
    assert_eq!(sections.len(), 2);
    assert_eq!(sections[0].title, "Title");
    assert_eq!(sections[1].title, "Child");
}

#[test]
fn validation_rejects_cross_space_targets_ambiguous_edits_and_stale_pagination() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!("aaa");
    let (_dir, server) = server(&initial);
    for (name, mut args) in read_cases() {
        args["space_id"] = json!("missing");
        assert!(
            server.call_tool(name, args.as_object().unwrap()).is_err(),
            "{name}"
        );
    }
    assert!(server
        .call_tool(
            NAMES[4],
            json!({"note_ids":["n1","secret"]}).as_object().unwrap()
        )
        .is_err());
    assert!(server
        .call_tool(
            NAMES[4],
            json!({"note_ids":["n1","n1"]}).as_object().unwrap()
        )
        .is_err());
    let old = fs::read(&server.vault_path).unwrap();
    assert!(server.call_tool(NAMES[13],json!({"space_id":"a","note_id":"n1","expected_version":version(&server,"n1"),"old_text":"aa","new_text":"z"}).as_object().unwrap()).is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), old);
    assert!(server
        .call_tool(
            NAMES[14],
            json!({"note_id":"n1","expected_version":version(&server,"n1"),"text":"missing Space"})
                .as_object()
                .unwrap()
        )
        .is_err());
    let first = run(&server, NAMES[10], json!({"limit":1}));
    run(
        &server,
        NAMES[14],
        json!({"space_id":"a","note_id":"n1","expected_version":version(&server,"n1"),"text":"changed"}),
    );
    assert!(server
        .call_tool(
            NAMES[10],
            json!({"expected_revision":first["vaultRevision"]})
                .as_object()
                .unwrap()
        )
        .is_err());
    assert!(server
        .call_tool(NAMES[18], json!({"since":"yesterday"}).as_object().unwrap())
        .is_err());
    assert!(server
        .call_tool(NAMES[0], json!({"limit":101}).as_object().unwrap())
        .is_err());
}

#[test]
fn integrity_reports_dangling_links_without_resolving_other_spaces() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] =
        json!("[missing](orion-note://secret)\n`[code](orion-note://ignore)`");
    initial["spaces"][0]["notes"][0]["sourceIds"] = json!(["gone"]);
    initial["spaces"][0]["concepts"][0]["canonicalNoteId"] = json!("secret");
    let (_dir, server) = server(&initial);
    let audit = run(&server, NAMES[17], json!({}));
    assert_eq!(audit["issueCount"], 3);
    assert!(!audit.to_string().contains("ignore"));
    assert!(audit["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|issue| issue["kind"] == "missing_canonical_note"));
}

#[test]
fn bounded_scans_report_incomplete_coverage() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!("x".repeat(MAX_SCAN_BYTES + 1));
    let (_dir, server) = server(&initial);
    assert_eq!(
        run(&server, NAMES[16], json!({}))["coverage"]["complete"],
        false
    );
    assert_eq!(
        run(
            &server,
            NAMES[19],
            json!({"from_note_id":"n1","to_note_id":"n2"})
        )["bounded"],
        true
    );
}

#[test]
fn concurrent_writers_recheck_the_version_under_the_advisory_lock() {
    let (_dir, server) = server(&fixture());
    let expected = version(&server, "n1");
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let writers: Vec<_> = ["\nWriter one", "\nWriter two"]
        .into_iter()
        .map(|text| {
            let path = server.vault_path.clone();
            let barrier = barrier.clone();
            let expected = expected.clone();
            std::thread::spawn(move || {
                barrier.wait();
                call(
                    &path,
                    "orion_append_to_note",
                    json!({"space_id":"a","note_id":"n1","expected_version":expected,"text":text})
                        .as_object()
                        .unwrap(),
                )
            })
        })
        .collect();
    let results: Vec<_> = writers
        .into_iter()
        .map(|writer| writer.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert_eq!(
        results
            .iter()
            .filter(|result| result
                .as_ref()
                .err()
                .is_some_and(|error| error.error_code == Some("version_conflict")))
            .count(),
        1
    );
    let body = run(&server, "orion_get_notes", json!({"note_ids":["n1"]}))["notes"][0]["body"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(body.matches("Writer ").count(), 1);
}

#[test]
fn content_changes_are_detected_even_when_an_external_writer_preserves_the_timestamp() {
    let mut initial = fixture();
    let (_dir, server) = server(&initial);
    let expected = version(&server, "n1");
    initial["spaces"][0]["notes"][0]["body"] =
        json!("Changed outside Orion without a new timestamp");
    fs::write(&server.vault_path, serde_json::to_vec(&initial).unwrap()).unwrap();
    let result = server.call_tool(
        "orion_append_to_note",
        json!({"space_id":"a","note_id":"n1","expected_version":expected,"text":"stale text"})
            .as_object()
            .unwrap(),
    );
    assert_eq!(result.unwrap_err().error_code, Some("version_conflict"));
    let after: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(after, initial);
}
