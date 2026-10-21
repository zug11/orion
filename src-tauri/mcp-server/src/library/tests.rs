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
fn note_command_web_links_normalize_like_the_editor_and_escape_literal_labels() {
    for (input, expected) in [
        (
            "https://example.com/articles?a=1&b=2#source",
            "https://example.com/articles?a=1&b=2#source",
        ),
        (" HTTP://EXAMPLE.COM/source ", "http://example.com/source"),
        ("example.com", "https://example.com/"),
        ("www.example.com/writing", "https://www.example.com/writing"),
        (
            "example.com:8080/writing",
            "https://example.com:8080/writing",
        ),
        ("https://例え.jp/文", "https://xn--r8jz45g.jp/%E6%96%87"),
        ("例え.jp/文", "https://xn--r8jz45g.jp/%E6%96%87"),
        ("https://localhost:1423/note", "https://localhost:1423/note"),
        ("https://example.com/a)b(c", "https://example.com/a%29b%28c"),
    ] {
        let initial = fixture();
        let (_dir, server) = server(&initial);
        let result = run(
            &server,
            NAMES[20],
            editor_command(
                &server,
                json!({"command":"link","url":input,"text":"Read [more] *now* & <safe>","placement":"replace","anchor":"alpha 🧭 evidence"}),
            ),
        );
        assert_eq!(result["changed"], true);
        assert!(
            saved_body(&server)
                .contains(&format!(r"[Read \[more\] \*now\* \& \<safe\>]({expected})")),
            "{input}"
        );
        let saved: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
        assert_eq!(saved["spaces"][1], initial["spaces"][1]);
        assert_eq!(
            saved["spaces"][0]["notes"][1],
            initial["spaces"][0]["notes"][1]
        );
        assert_eq!(
            saved["spaces"][0]["concepts"],
            initial["spaces"][0]["concepts"]
        );
        assert_eq!(
            saved["spaces"][0]["sources"],
            initial["spaces"][0]["sources"]
        );
    }
}

#[test]
fn note_command_web_links_preserve_replaced_words_and_guard_stale_replays() {
    let (_dir, server) = server(&fixture());
    let args = editor_command(
        &server,
        json!({"command":"link","url":"example.com/source","placement":"replace","anchor":"alpha 🧭 evidence"}),
    );
    run(&server, NAMES[20], args.clone());
    assert!(saved_body(&server).contains("[alpha 🧭 evidence](https://example.com/source)"));
    let before = fs::read(&server.vault_path).unwrap();
    assert!(server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    run(
        &server,
        NAMES[20],
        editor_command(&server, json!({"command":"link","url":"example.org"})),
    );
    assert!(saved_body(&server).contains(r"[https://example\.org/](https://example.org/)"));
    // Existing direct note links still use their same-Space target title.
    run(
        &server,
        NAMES[20],
        editor_command(&server, json!({"command":"link","target_note_id":"n2"})),
    );
    assert!(saved_body(&server).contains("[Beta](orion-note://n2)"));
    let args = editor_command(
        &server,
        json!({"space_id":"b","command":"link","url":"example.com"}),
    );
    let before = fs::read(&server.vault_path).unwrap();
    assert!(server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
}

#[test]
fn note_command_web_links_reject_unsafe_ambiguous_and_oversized_destinations_atomically() {
    let (_dir, server) = server(&fixture());
    for input in [
        "",
        "Project notes",
        "localhost",
        "/relative/path",
        "//example.com/path",
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "data:text/html,<script>",
        "file:///Users/me/note",
        "mailto:reader@example.com",
        "orion://note/private",
        "https://name:secret@example.com/",
        "https://example.com@evil.test/",
        "https://example.com/\nscript",
        "https://example.com/path with spaces",
        "https://example.com\\@evil.test/",
        "https://",
        "https:///",
        "https:example.com",
        "example.com:65536/path",
        "https://exa%mple.com/",
        "https://example.com/\u{7f}",
        "https://example.com/\tpath",
        "-example.com",
        "example-.com",
        "example.123",
    ] {
        let args = editor_command(
            &server,
            json!({"command":"link","url":input,"text":"Must not save"}),
        );
        let before = fs::read(&server.vault_path).unwrap();
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "Accepted {input:?}"
        );
        assert_eq!(fs::read(&server.vault_path).unwrap(), before, "{input:?}");
    }
    for fields in [
        json!({"command":"link","url":"example.com","target_note_id":"n2"}),
        json!({"command":"link","url":"example.com","target_note_id":"secret"}),
        json!({"command":"link","text":"Missing destination"}),
        json!({"command":"link","url":"example.com","target_expected_version":version(&server,"n2")}),
        json!({"command":"text","url":"example.com","text":"Wrong command"}),
        json!({"command":"excerpt","url":"example.com","text":"Wrong command"}),
        json!({"command":"link","url":format!("https://example.com/{}", "a".repeat(2048))}),
        // Scalar input length fits the schema, but UTF-16/normalized URL bounds do not.
        json!({"command":"link","url":format!("https://example.com/{}", "😀".repeat(1020))}),
        json!({"command":"link","url":format!("https://example.com/{}", "文".repeat(250))}),
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
    assert_eq!(definitions().len(), 23);
    assert_eq!(tool_definitions().len(), 57);
    let unique: BTreeSet<_> = definitions()
        .iter()
        .map(|def| def["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(unique.len(), 23);
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

#[test]
fn working_reads_hide_completed_actions_and_derivatives_but_preserve_guarded_coordinates() {
    let mut initial = fixture();
    let body = "# Work\r\n- [x] secret-finished 🧭\r\n  secret-detail\r\n- [ ] Next task\r\n\r\nRequirement: keep backups.\r\n";
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    initial["spaces"][0]["notes"][0]["summary"] = json!("secret-finished summary");
    initial["spaces"][0]["spaceOverview"]["body"] = json!("secret-finished overview");
    initial["spaces"][0]["sources"][0]["text"] = json!(body);
    let (_dir, server) = server(&initial);
    let before = fs::read(&server.vault_path).unwrap();
    for (name, args) in [
        ("orion_get_note", json!({"note_id":"n1"})),
        ("orion_get_notes", json!({"note_ids":["n1"]})),
        ("orion_browse_space", json!({})),
        ("orion_search", json!({"query":"Next"})),
        (
            "orion_get_note_section",
            json!({"note_id":"n1","heading":"Work"}),
        ),
        ("orion_get_source_passage", json!({"source_id":"s1"})),
        ("orion_get_space_summary", json!({})),
    ] {
        let result = run(&server, name, args);
        assert!(!result.to_string().contains("secret-"), "{name}: {result}");
        assert_eq!(result["taskView"], "working");
    }
    let version = version(&server, "n1");
    let history = run(
        &server,
        "orion_get_note",
        json!({"note_id":"n1","task_view":"history"}),
    );
    assert!(history.to_string().contains("secret-finished"));
    assert_eq!(history["note"]["version"], version);
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    let working = crate::working_view::mask(body);
    assert_eq!(working.chars().count(), body.chars().count());
    assert!(working.contains("Requirement: keep backups"));
    let tasks = run(&server, "orion_list_tasks", json!({"note_id":"n1"}));
    assert_eq!(tasks["tasks"][0]["lineIndex"], 3);
    assert_eq!(tasks["tasks"][0]["note"]["version"], version);
    run(
        &server,
        "orion_set_task_completion",
        json!({"space_id":"a","note_id":"n1","expected_version":version,"line_index":3,"expected_text":"Next task","completed":true}),
    );
    assert!(!run(&server, "orion_get_note", json!({"note_id":"n1"}))
        .to_string()
        .contains("Next task"));
    assert!(run(
        &server,
        "orion_list_tasks",
        json!({"note_id":"n1","state":"completed"})
    )
    .to_string()
    .contains("Next task"));
    assert!(saved_body(&server).contains("secret-finished"));
    assert!(server
        .call_tool(
            "orion_update_note",
            json!({"space_id":"a","note_id":"n1","body":working})
                .as_object()
                .unwrap()
        )
        .is_err());
    assert!(server
        .call_tool(
            "orion_get_note",
            json!({"note_id":"n1","task_view":true})
                .as_object()
                .unwrap()
        )
        .is_err());
}

#[test]
fn layout_commands_patch_only_requested_fields_and_preserve_prose_and_raw_metadata() {
    let mut initial = fixture();
    let anchor = "Café 🧭 prose. <!-- future-format:v9 keep -->";
    let body = format!("---\r\ntitle: Untouched\r\n---\r\n\r\n<!-- orion-block:v1 -->\r\n\r\n{anchor}\r\n\r\n<!-- /orion-block:v1 -->\r\n");
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    initial["spaces"][0]["notes"][0]["futureData"] = json!({"keep":[1,true]});
    let (_dir, server) = server(&initial);
    let args = editor_command(
        &server,
        json!({"command":"paragraph_format","anchor":anchor,"alignment":"justify","margin_left":4,"margin_right":6}),
    );
    run(&server, NAMES[20], args.clone());
    let formatted =
        format!("{anchor} <!-- orion-text:v1 justify --> <!-- orion-paragraph-margins:v1 4 6 -->");
    assert_eq!(saved_body(&server), body.replace(anchor, &formatted));
    let after = fs::read(&server.vault_path).unwrap();
    assert_eq!(
        server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .unwrap_err()
            .error_code,
        Some("version_conflict")
    );
    assert_eq!(fs::read(&server.vault_path).unwrap(), after);
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"paragraph_format","anchor":formatted,"margin_left":0}),
        ),
    );
    let partial =
        format!("{anchor} <!-- orion-text:v1 justify --> <!-- orion-paragraph-margins:v1 0 6 -->");
    assert!(saved_body(&server).contains(&partial));
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"paragraph_format","anchor":partial,"alignment":"left","margin_right":0}),
        ),
    );
    assert_eq!(saved_body(&server), body);
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"document_margins","margin_left":8,"margin_right":11}),
        ),
    );
    assert_eq!(
        saved_body(&server),
        body.replacen(
            "<!-- orion-block",
            "<!-- orion-document-margins:v1 8 11 -->\r\n\r\n<!-- orion-block",
            1
        )
    );
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"document_margins","margin_left":0}),
        ),
    );
    assert!(saved_body(&server).contains("<!-- orion-document-margins:v1 0 11 -->"));
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"document_margins","margin_right":0}),
        ),
    );
    assert_eq!(saved_body(&server), body);
    let saved: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(
        saved["spaces"][0]["notes"][0]["futureData"],
        initial["spaces"][0]["notes"][0]["futureData"]
    );
    assert_eq!(
        saved["spaces"][0]["settings"],
        initial["spaces"][0]["settings"]
    );
    assert_eq!(saved["spaces"][1], initial["spaces"][1]);
}

#[test]
fn paragraph_layout_preserves_heading_closers_and_complete_task_or_quoted_paragraphs() {
    for (anchor, expected) in [
        (
            "## Heading 🧭 ##",
            "## Heading 🧭 <!-- orion-text:v1 justify --> ##",
        ),
        (
            "- [ ] A task",
            "- [ ] A task <!-- orion-text:v1 justify -->",
        ),
        (
            "> First line\n> second line",
            "> First line\n> second line <!-- orion-text:v1 justify -->",
        ),
        (
            "First line\nsecond line",
            "First line\nsecond line <!-- orion-text:v1 justify -->",
        ),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(anchor);
        let (_dir, server) = server(&initial);
        run(
            &server,
            NAMES[20],
            editor_command(
                &server,
                json!({"command":"paragraph_format","anchor":anchor,"alignment":"justify"}),
            ),
        );
        assert_eq!(saved_body(&server), expected);
    }
}

#[test]
fn paragraph_layout_rejects_partial_structural_or_hidden_ranges_atomically() {
    for (body, anchor) in [
        ("First line\nsecond line", "First line"),
        ("A sentence with an inline word.", "inline"),
        ("Same.\n\nSame.", "Same."),
        ("---\nprivate: value\n---\n\nVisible.", "private: value"),
        ("```md\nCode 🧭\n```", "Code 🧭"),
        ("> ```\n> Code 🧭\n> ```", "> Code 🧭"),
        ("- ```\n  literal 🧭\n  ```\n", "  literal 🧭"),
        ("> 1. ```\n>    literal 🧭\n>    ```\n", ">    literal 🧭"),
        ("<!--\nHidden 🧭\n-->", "Hidden 🧭"),
        ("Visible <!-- unfinished", "Visible <!-- unfinished"),
        ("<script>\n\nHidden 🧭\n\n</script>", "Hidden 🧭"),
        ("<script\t>\n\nHidden 🧭\n\n</script>", "Hidden 🧭"),
        ("<http-widget>\nHidden 🧭\n</http-widget>", "Hidden 🧭"),
        ("- <div>\n  literal 🧭\n  </div>", "  literal 🧭"),
        ("| A | B |\n| --- | --- |\n| C | D |", "| C | D |"),
        ("Title\n====", "Title"),
        ("    Code 🧭", "    Code 🧭"),
        ("- First line\n  continuation", "- First line"),
        ("[ref]: https://example.com", "[ref]: https://example.com"),
        ("[ref]:\n  https://example.com", "  https://example.com"),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let before = fs::read(&server.vault_path).unwrap();
        let args = editor_command(
            &server,
            json!({"command":"paragraph_format","anchor":anchor,"margin_left":5}),
        );
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "unexpected mutation for {body}"
        );
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

#[test]
fn layout_schema_rejects_coercion_and_irrelevant_fields_without_writes() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!("A complete paragraph.");
    let (_dir, server) = server(&initial);
    let before = fs::read(&server.vault_path).unwrap();
    for fields in [
        json!({"command":"paragraph_format","anchor":"A complete paragraph.","margin_left":1.5}),
        json!({"command":"paragraph_format","anchor":"A complete paragraph.","margin_left":"4"}),
        json!({"command":"paragraph_format","anchor":"A complete paragraph.","margin_left":-1}),
        json!({"command":"paragraph_format","anchor":"A complete paragraph.","margin_right":26}),
        json!({"command":"paragraph_format","anchor":"A complete paragraph.","alignment":"center"}),
        json!({"command":"paragraph_format","anchor":"A complete paragraph.","alignment":"justify","placement":"append"}),
        json!({"command":"paragraph_format","anchor":"A complete paragraph."}),
        json!({"command":"document_margins","margin_left":3,"anchor":"A complete paragraph."}),
        json!({"command":"document_margins"}),
    ] {
        let args = editor_command(&server, fields);
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
    }
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    for body in [
        "---\nmissing closing",
        "<!-- orion-document-margins:v9 1 2 -->\n\nProse.",
    ] {
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = self::server(&initial);
        let before = fs::read(&server.vault_path).unwrap();
        let args = editor_command(
            &server,
            json!({"command":"document_margins","margin_left":3}),
        );
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

fn image_metadata(body: &str) -> Value {
    let encoded = body
        .split("orion-image-layout:v1:")
        .nth(1)
        .unwrap()
        .split('"')
        .next()
        .unwrap();
    let decoded = url::form_urlencoded::parse(encoded.as_bytes())
        .next()
        .unwrap()
        .0;
    serde_json::from_str(&decoded).unwrap()
}

#[test]
fn image_layout_preserves_asset_alt_title_unknown_metadata_and_explicit_resets() {
    let url = "orion-image://localhost/image_Abc-123456789";
    let metadata = json!({"placement":"wrap","alignment":"left","widthPercent":40,"xPercent":12.5,"offsetY":50,"gap":18,"caption":"Legacy caption","futureOptics":{"keep":[1,"🧭"]},"title":"Existing diagram"});
    let anchor = format!(
        "![A \\[literal\\] diagram]({url} \"orion-image-layout:v1:{}\")",
        editor::percent_encode(&metadata.to_string())
    );
    let body = format!("Lead.\n\n{anchor}\n\nTail.");
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    let (_dir, server) = server(&initial);
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"image_layout","anchor":anchor,"layout":{"widthPercent":37,"xPercent":24.5,"offsetY":97,"caption":"A preserved café 🪐 caption","showCaption":false}}),
        ),
    );
    let result = saved_body(&server);
    let parsed = image_metadata(&result);
    assert_eq!(parsed["futureOptics"], metadata["futureOptics"]);
    assert_eq!(parsed["title"], metadata["title"]);
    assert_eq!(parsed["widthPercent"], 37);
    assert_eq!(parsed["xPercent"], 24.5);
    assert_eq!(parsed["offsetY"], 97);
    assert_eq!(parsed["showCaption"], false);
    assert!(result.starts_with(&format!("Lead.\n\n![A \\[literal\\] diagram]({url} \"")));
    assert!(result.ends_with("\n\nTail."));
    let updated_anchor = result.lines().find(|line| line.starts_with("![")).unwrap();
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"image_layout","anchor":updated_anchor,"layout":{"xPercent":null,"placement":"inline","alignment":"center","widthPercent":100,"caption":"","showCaption":false}}),
        ),
    );
    let parsed = image_metadata(&saved_body(&server));
    assert_eq!(parsed["xPercent"], Value::Null);
    assert_eq!(parsed["offsetY"], 0);
    assert_eq!(parsed["futureOptics"], metadata["futureOptics"]);
}

#[test]
fn image_layout_round_trips_ordinary_title_and_restores_default_metadata() {
    let anchor =
        "![Original](orion-image://localhost/image_Abc-123456789 \"Existing \\\"diagram\\\"\")";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(anchor);
    let (_dir, server) = server(&initial);
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"image_layout","anchor":anchor,"layout":{"widthPercent":37,"caption":"Visible","showCaption":true}}),
        ),
    );
    let updated = saved_body(&server);
    assert_eq!(image_metadata(&updated)["title"], "Existing \"diagram\"");
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"image_layout","anchor":updated,"layout":{"widthPercent":100,"caption":"","showCaption":false}}),
        ),
    );
    assert_eq!(saved_body(&server), anchor);
}

#[test]
fn image_layout_rejects_unsafe_fields_and_non_managed_or_hidden_images_atomically() {
    let anchor = "![Diagram](orion-image://localhost/image_Abc-123456789)";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(anchor);
    let (_dir, server) = server(&initial);
    let before = fs::read(&server.vault_path).unwrap();
    for layout in [
        json!({}),
        json!({"widthPercent":14}),
        json!({"widthPercent":37.5}),
        json!({"widthPercent":"37"}),
        json!({"xPercent":0.001}),
        json!({"widthPercent":40,"xPercent":61}),
        json!({"offsetY":3}),
        json!({"xPercent":null,"offsetY":3}),
        json!({"showCaption":"true"}),
        json!({"caption":"🪐".repeat(251)}),
        json!({"src":"file:///private.png"}),
        json!({"widthPercent":true}),
        json!({"gap":41}),
    ] {
        let args = editor_command(
            &server,
            json!({"command":"image_layout","anchor":anchor,"layout":layout}),
        );
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "accepted {args}"
        );
    }
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    for (body, anchor) in [
        (format!("```md\n{anchor}\n```"), anchor.to_owned()),
        (format!("- ```\n\n{anchor}\n\n  ```"), anchor.to_owned()),
        (format!("{anchor}\n\n{anchor}"), anchor.to_owned()),
        (format!("Some prose {anchor}"), anchor.to_owned()),
        (
            "![Not local](https://example.com/image.png)".into(),
            "![Not local](https://example.com/image.png)".into(),
        ),
        (
            "![Title](orion-image://localhost/image_Abc-123456789 \"Fish &amp; chips\")".into(),
            "![Title](orion-image://localhost/image_Abc-123456789 \"Fish &amp; chips\")".into(),
        ),
        (
            "![Bad](orion-image://localhost/image_Abc-123456789 \"orion-image-layout:v1:%ZZ\")"
                .into(),
            "![Bad](orion-image://localhost/image_Abc-123456789 \"orion-image-layout:v1:%ZZ\")"
                .into(),
        ),
    ] {
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = self::server(&initial);
        let before = fs::read(&server.vault_path).unwrap();
        let args = editor_command(
            &server,
            json!({"command":"image_layout","anchor":anchor,"layout":{"widthPercent":37}}),
        );
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "accepted {body}"
        );
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

fn table_command(server: &Server, fields: Value) -> Value {
    let mut fields = fields.as_object().unwrap().clone();
    fields.insert("anchor".into(), json!(saved_body(server)));
    run(
        server,
        NAMES[20],
        editor_command(server, Value::Object(fields)),
    )
}

fn table_metadata(body: &str) -> Value {
    serde_json::from_str(
        body.lines()
            .find(|line| line.starts_with("<!-- orion-table:v1 "))
            .unwrap()
            .strip_prefix("<!-- orion-table:v1 ")
            .unwrap()
            .strip_suffix(" -->")
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn table_layout_preserves_cells_unknown_metadata_and_scales_only_measured_columns() {
    let raw = "| A | B |\r\n| :--- | ---: |\r\n| **Café 🧭** | [D](https://example.com/a) |";
    let marker="<!-- orion-table:v1 {\"width\":100,\"header\":true,\"banded\":true,\"columns\":[100,220],\"future\":{\"keep\":\"🪐\"}} -->";
    let anchor = format!("{marker}\r\n{raw}");
    let body = format!("Before.\r\n\r\n{anchor}\r\n\r\nAfter.");
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    let (_dir, server) = server(&initial);
    let args = editor_command(
        &server,
        json!({"command":"table_layout","anchor":anchor,"table_layout":{"width":74,"banded":false}}),
    );
    run(&server, NAMES[20], args.clone());
    let result = saved_body(&server);
    let layout = table_metadata(&result);
    assert_eq!(layout["columns"], json!([74, 163]));
    assert_eq!(layout["width"], 74);
    assert_eq!(layout["future"], json!({"keep":"🪐"}));
    assert!(result.contains(raw));
    assert!(result.starts_with("Before.\r\n\r\n"));
    assert!(result.ends_with("\r\n\r\nAfter."));
    let before = fs::read(&server.vault_path).unwrap();
    assert_eq!(
        server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .unwrap_err()
            .error_code,
        Some("version_conflict")
    );
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    let changed_anchor = result
        .strip_prefix("Before.\r\n\r\n")
        .unwrap()
        .strip_suffix("\r\n\r\nAfter.")
        .unwrap();
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"table_layout","anchor":changed_anchor,"table_layout":{"width":35,"columns":[null,127]}}),
        ),
    );
    assert_eq!(
        table_metadata(&saved_body(&server))["columns"],
        json!([null, 127])
    );
}

#[test]
fn table_header_changes_preserve_real_blank_rows_and_data() {
    let original="<!-- orion-table:v1 {\"header\":false} -->\n| | |\n| --- | --- |\n|  |  |\n| Café 🧭 | B |";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(original);
    let (_dir, server) = server(&initial);
    table_command(
        &server,
        json!({"command":"table_layout","table_layout":{"header":true}}),
    );
    let headed = saved_body(&server);
    assert_eq!(headed, "|  |  |\n| --- | --- |\n| Café 🧭 | B |");
    table_command(
        &server,
        json!({"command":"table_layout","table_layout":{"header":false}}),
    );
    let unheaded = saved_body(&server);
    assert!(unheaded.contains("| | |\n| --- | --- |\n|  |  |\n| Café 🧭 | B |"));
    table_command(
        &server,
        json!({"command":"table_edit","operation":"set_cell","row_index":0,"column_index":1,"text":"The first REAL row"}),
    );
    assert!(saved_body(&server).contains("|  | The first REAL row |\n| Café 🧭 | B |"));
}

#[test]
fn table_edits_preserve_raw_unaffected_cells_and_shift_widths_with_columns() {
    let original="<!-- orion-table:v1 {\"width\":74,\"columns\":[127,220]} -->\n| A | B |\n| :--- | ---: |\n| **Café** | `a|b` and [note](orion-note://n2) |\n| Literal \\| bar | End |";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(original);
    let (_dir, server) = server(&initial);
    table_command(
        &server,
        json!({"command":"table_edit","operation":"insert_row","row_index":2,"values":["new *literal*","é🧭\nline"]}),
    );
    assert!(saved_body(&server).contains("| new \\*literal\\* | é🧭<br>line |"));
    table_command(
        &server,
        json!({"command":"table_edit","operation":"insert_column","column_index":1,"values":["Heading","Row","Inserted","Final"]}),
    );
    assert_eq!(
        table_metadata(&saved_body(&server))["columns"],
        json!([127, null, 220])
    );
    assert!(saved_body(&server).contains("| **Café** | Row | `a|b` and [note](orion-note://n2) |"));
    table_command(
        &server,
        json!({"command":"table_edit","operation":"set_cell","row_index":2,"column_index":1,"text":"[not](https://example.com) | 🪐"}),
    );
    assert!(saved_body(&server).contains("\\[not\\](https://example\\.com) \\| 🪐"));
    table_command(
        &server,
        json!({"command":"table_edit","operation":"delete_column","column_index":1}),
    );
    assert_eq!(
        table_metadata(&saved_body(&server))["columns"],
        json!([127, 220])
    );
    table_command(
        &server,
        json!({"command":"table_edit","operation":"delete_row","row_index":2}),
    );
    assert!(saved_body(&server).ends_with("| A | B |\n| :--- | ---: |\n| **Café** | `a|b` and [note](orion-note://n2) |\n| Literal \\| bar | End |"));
}

#[test]
fn table_resize_requires_explicit_content_removal_and_preserves_oversized_axes() {
    let original = "| A | B |\n| --- | --- |\n| One | Two |";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(original);
    let (_dir, server) = server(&initial);
    let before = fs::read(&server.vault_path).unwrap();
    let args = editor_command(
        &server,
        json!({"command":"table_edit","operation":"resize","anchor":original,"row_count":1,"column_count":1}),
    );
    assert!(server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    table_command(
        &server,
        json!({"command":"table_edit","operation":"resize","row_count":3,"column_count":3}),
    );
    table_command(
        &server,
        json!({"command":"table_edit","operation":"resize","row_count":2,"column_count":2}),
    );
    assert_eq!(saved_body(&server), original);
    table_command(
        &server,
        json!({"command":"table_edit","operation":"resize","row_count":1,"column_count":1,"allow_content_removal":true}),
    );
    assert_eq!(saved_body(&server), "| A |\n| --- |");
    let oversized = format!(
        "| A | B |\n| --- | --- |\n{}",
        (0..24)
            .map(|i| format!("| {i} | value |"))
            .collect::<Vec<_>>()
            .join("\n")
    );
    initial["spaces"][0]["notes"][0]["body"] = json!(oversized);
    let (_dir, server) = self::server(&initial);
    table_command(
        &server,
        json!({"command":"table_edit","operation":"resize","column_count":3}),
    );
    assert!(saved_body(&server).contains("| 23 | value | |"));
    assert_eq!(saved_body(&server).lines().count(), 26);
    let before = fs::read(&server.vault_path).unwrap();
    let args = editor_command(
        &server,
        json!({"command":"table_edit","operation":"resize","anchor":saved_body(&server),"row_count":26}),
    );
    assert!(server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
}

#[test]
fn table_explicit_deletion_and_unchanged_layout_follow_existing_write_semantics() {
    for fields in [
        json!({"operation":"delete"}),
        json!({"operation":"delete_row","row_index":0}),
        json!({"operation":"delete_column","column_index":0}),
    ] {
        let anchor = "| Only |\n| --- |";
        let body = format!("Before.\n\n{anchor}\n\nAfter.");
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let mut command = json!({"command":"table_edit","anchor":anchor});
        command
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        run(&server, NAMES[20], editor_command(&server, command));
        assert_eq!(saved_body(&server), "Before.\n\n\n\nAfter.");
    }
    let body = "<!-- orion-table:v1 {\"header\":false} -->\n\n|   |  |\n| --- | --- |\n| A | B |";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    let (_dir, server) = server(&initial);
    let before: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    table_command(
        &server,
        json!({"command":"table_layout","table_layout":{"header":false,"width":100}}),
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&server.vault_path).unwrap()).unwrap(),
        before
    );
    assert_eq!(saved_body(&server), body);
}

#[test]
fn table_commands_reject_partial_hidden_or_ambiguous_structures_atomically() {
    let complete = "| A | B |\n| --- | --- |\n| One | Two |";
    for (body, anchor) in [
        (format!("{complete}\n| Three | Four |"), complete.to_owned()),
        (format!("{complete}\n\n{complete}"), complete.to_owned()),
        (format!("```md\n{complete}\n```"), complete.to_owned()),
        (format!("- ```\n\n{complete}\n\n  ```"), complete.to_owned()),
        (
            format!("<script>\n\n{complete}\n\n</script>"),
            complete.to_owned(),
        ),
        (format!("---\n{complete}\n---"), complete.to_owned()),
        (
            format!("<!-- orion-table:v1 {{\"width\":74}} -->\n{complete}"),
            complete.to_owned(),
        ),
        (
            format!("<!-- orion-table:v1 {{\"width\":74}} -->\n\n{complete}"),
            complete.to_owned(),
        ),
        (
            "| A | B |\n| --- | --- |\n| Too few |".into(),
            "| A | B |\n| --- | --- |\n| Too few |".into(),
        ),
        (
            "| A | B |\n| ::--- | --- |".into(),
            "| A | B |\n| ::--- | --- |".into(),
        ),
        (
            format!("<!-- orion-table:v2 {{}} -->\n{complete}"),
            format!("<!-- orion-table:v2 {{}} -->\n{complete}"),
        ),
        (format!("- Item\n\n  {complete}"), format!("  {complete}")),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let before = fs::read(&server.vault_path).unwrap();
        let args = editor_command(
            &server,
            json!({"command":"table_layout","anchor":anchor,"table_layout":{"width":74}}),
        );
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "accepted {body}"
        );
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

#[test]
fn table_commands_validate_dimensions_fields_and_portable_metadata_budget_before_saving() {
    let body = "| A | B |\n| --- | --- |\n| One | Two |";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    let (_dir, server) = server(&initial);
    let before = fs::read(&server.vault_path).unwrap();
    for fields in [
        json!({"command":"table_layout","table_layout":{}}),
        json!({"command":"table_layout","table_layout":{"width":34}}),
        json!({"command":"table_layout","table_layout":{"width":74.2}}),
        json!({"command":"table_layout","table_layout":{"width":"74"}}),
        json!({"command":"table_layout","table_layout":{"header":"false"}}),
        json!({"command":"table_layout","table_layout":{"columns":[127]}}),
        json!({"command":"table_layout","table_layout":{"columns":[47,220]}}),
        json!({"command":"table_layout","table_layout":{"columns":[null,2001]}}),
        json!({"command":"table_layout","table_layout":{"width":74},"placement":"replace"}),
        json!({"command":"table_edit","operation":"insert_row","row_index":3}),
        json!({"command":"table_edit","operation":"insert_row","row_index":1,"values":["one"]}),
        json!({"command":"table_edit","operation":"insert_column","column_index":1,"values":["one"]}),
        json!({"command":"table_edit","operation":"delete_row","row_index":2}),
        json!({"command":"table_edit","operation":"delete_column","column_index":2}),
        json!({"command":"table_edit","operation":"set_cell","row_index":0,"column_index":0}),
        json!({"command":"table_edit","operation":"resize","row_count":0}),
        json!({"command":"table_edit","operation":"resize","row_count":21}),
        json!({"command":"table_edit","operation":"resize","column_count":13}),
        json!({"command":"table_edit","operation":"delete","text":"unexpected"}),
    ] {
        let mut fields = fields.as_object().unwrap().clone();
        fields.insert("anchor".into(), json!(body));
        let args = editor_command(&server, Value::Object(fields));
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "accepted {args}"
        );
    }
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    let mut metadata =
        json!({"width":100,"header":true,"banded":true,"columns":[null,null],"future":""});
    metadata["future"] = json!("x".repeat(1590 - metadata.to_string().len()));
    let body = format!("<!-- orion-table:v1 {metadata} -->\n{body}");
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    let (_dir, server) = self::server(&initial);
    let before = fs::read(&server.vault_path).unwrap();
    let args = editor_command(
        &server,
        json!({"command":"table_edit","anchor":body,"operation":"resize","column_count":12}),
    );
    assert!(server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
}

#[test]
fn table_reduction_keeps_bare_edge_gfm_as_an_actual_one_column_table() {
    for fields in [
        json!({"operation":"delete_column","column_index":1}),
        json!({"operation":"resize","column_count":1,"allow_content_removal":true}),
    ] {
        let body = "A | B\n--- | ---\nOne | Two";
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let mut command = fields.as_object().unwrap().clone();
        command.insert("command".into(), json!("table_edit"));
        table_command(&server, Value::Object(command));
        assert_eq!(saved_body(&server), "|A |\n|--- |\n|One |");
        table_command(
            &server,
            json!({"command":"table_edit","operation":"set_cell","row_index":1,"column_index":0,"text":"Still a table"}),
        );
        assert!(saved_body(&server).contains("| Still a table |"));
    }
}

#[test]
fn table_unknown_metadata_cannot_end_its_html_comment_when_reserialized() {
    let body="<!-- orion-table:v1 {\"future\":\"\\u002d\\u002d> <script> & other 🪐\"} -->\n| A | B |\n| --- | --- |\n| One | Two |";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    let (_dir, server) = server(&initial);
    table_command(
        &server,
        json!({"command":"table_layout","table_layout":{"width":74}}),
    );
    let saved = saved_body(&server);
    assert_eq!(saved.lines().next().unwrap().matches("-->").count(), 1);
    assert_eq!(table_metadata(&saved)["future"], "--> <script> & other 🪐");
    table_command(
        &server,
        json!({"command":"table_layout","table_layout":{"banded":false}}),
    );
    assert_eq!(
        table_metadata(&saved_body(&server))["future"],
        "--> <script> & other 🪐"
    );
}

#[test]
fn table_commands_cannot_treat_markdown_block_starts_as_bare_edge_cells() {
    for block in [
        "# A | B",
        "- A | B",
        "+ A | B",
        "* A | B",
        "1. A | B",
        "2) A | B",
        "```lang | B",
        "~~~lang | B",
        "<div>A | B",
        "[ref]: A | B",
    ] {
        for body in [
            format!("{block}\n--- | ---\nOne | Two"),
            format!("A | B\n--- | ---\n{block}"),
        ] {
            let mut initial = fixture();
            initial["spaces"][0]["notes"][0]["body"] = json!(body);
            let (_dir, server) = server(&initial);
            let before = fs::read(&server.vault_path).unwrap();
            let args = editor_command(
                &server,
                json!({"command":"table_layout","anchor":body,"table_layout":{"width":74}}),
            );
            assert!(
                server
                    .call_tool(NAMES[20], args.as_object().unwrap())
                    .is_err(),
                "accepted {body}"
            );
            assert_eq!(fs::read(&server.vault_path).unwrap(), before);
        }
    }
}

#[test]
fn deleting_a_bare_edge_first_column_cannot_expose_a_cell_as_markdown_structure() {
    let body = "A | # B | C\n--- | --- | ---\nOne | - item | Three";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(body);
    let (_dir, server) = server(&initial);
    table_command(
        &server,
        json!({"command":"table_edit","operation":"delete_column","column_index":0}),
    );
    assert_eq!(
        saved_body(&server),
        "| # B | C|\n| --- | ---|\n| - item | Three|"
    );
    table_command(
        &server,
        json!({"command":"table_edit","operation":"insert_row","row_index":2}),
    );
    assert!(saved_body(&server).ends_with("| | |"));
}

#[test]
fn inline_commands_change_only_requested_marks_and_keep_text() {
    for (body, anchor, mark, enabled, expected) in [
        ("A tick ` here.", "tick ` here", "code", true, "A ``tick ` here``."),
        ("A spaced phrase.", " spaced ", "code", true, "A`  spaced  `phrase."),
        ("A careful thought.", " careful", "code", true, "A` careful` thought."),
        ("A careful thought.", "careful ", "code", true, "A `careful `thought."),
        ("A\tcareful thought.", "\tcareful", "code", true, "A`\tcareful` thought."),
        ("A careful\tthought.", "careful\t", "code", true, "A `careful\t`thought."),
        ("A\u{feff}careful thought.", "\u{feff}careful", "code", true, "A`\u{feff}careful` thought."),
        ("A careful thought.", "careful", "bold", true, "A **careful** thought."),
        ("A careful thought.", "careful", "italic", true, "A *careful* thought."),
        ("A careful thought.", "careful", "strike", true, "A ~~careful~~ thought."),
        ("A **careful** thought.", "**careful**", "bold", false, "A careful thought."),
        ("A ***careful*** thought.", "***careful***", "bold", false, "A *careful* thought."),
        ("A ***careful*** thought.", "***careful***", "italic", false, "A **careful** thought."),
        ("A ~~**careful**~~ thought.", "~~**careful**~~", "strike", false, "A **careful** thought."),
        ("A **careful** thought.", "careful", "bold", true, "A **careful** thought."),
        ("A careful thought.", "careful", "bold", false, "A careful thought."),
        ("A *careful* thought.", "*careful*", "bold", true, "A ***careful*** thought."),
        ("A [**careful**](https://example.com) thought.", "**careful**", "bold", false, "A [careful](https://example.com) thought."),
        ("A café 🧭 thought.", "café 🧭", "bold", true, "A **café 🧭** thought."),
        ("A &amp; thought.", "&amp;", "bold", true, "A **&amp;** thought."),
        ("A \\*literal\\* thought.", "\\*literal\\*", "code", true, "A `*literal*` thought."),
        ("A `*literal*` thought.", "`*literal*`", "code", false, "A \\*literal\\* thought."),
        ("A `a&b` thought.", "`a&b`", "code", false, "A a\\&b thought."),
        ("# A careful thought. ###", "careful", "bold", true, "# A **careful** thought. ###"),
        ("<!-- orion-block:v1 -->\r\n\r\nA careful thought. <!-- orion-text:v1 justify -->\r\n\r\n<!-- /orion-block -->", "careful", "italic", true, "<!-- orion-block:v1 -->\r\n\r\nA *careful* thought. <!-- orion-text:v1 justify -->\r\n\r\n<!-- /orion-block -->"),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let args = editor_command(&server, json!({"command":"inline_format","anchor":anchor,"mark":mark,"enabled":enabled}));
        let result = server.call_tool(NAMES[20], args.as_object().unwrap()).unwrap_or_else(|error| panic!("{body:?} / {mark} {enabled}: {error:?}"));
        assert_eq!(saved_body(&server), expected, "{body:?} / {mark} {enabled}");
        assert_eq!(result["changed"], body != expected);
        let saved: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
        assert_eq!(saved["spaces"][1], initial["spaces"][1]);
        assert_eq!(saved["spaces"][0]["settings"], initial["spaces"][0]["settings"]);
    }
}

#[test]
fn inline_commands_reject_partial_ambiguous_hidden_and_structural_selections_atomically() {
    for (body, anchor, mark, enabled) in [
        ("A **careful longer** thought.", "careful", "bold", false),
        ("A **careful** thought.", "*careful", "italic", true),
        ("A &amp; thought.", "amp", "bold", true),
        ("A \\*literal\\* thought.", "*literal", "bold", true),
        ("A `literal` thought.", "literal", "bold", true),
        ("A **literal** thought.", "**literal**", "code", true),
        (
            "A [literal](https://example.com) thought.",
            "[literal](https://example.com)",
            "code",
            true,
        ),
        (
            "A [literal](https://example.com) thought.",
            "example.com",
            "bold",
            true,
        ),
        ("A literal literal thought.", "literal", "bold", true),
        ("---\nname: literal\n---\nBody.", "literal", "bold", true),
        ("```md\nliteral\n```", "literal", "bold", true),
        ("    literal", "literal", "bold", true),
        ("<div>literal</div>", "literal", "bold", true),
        ("A <!-- literal --> thought.", "literal", "bold", true),
        (
            "A literal <!-- orion-text:v1 justify -->",
            "literal <!-- orion-text:v1 justify -->",
            "bold",
            true,
        ),
        (
            "A literal.\n\nAnother paragraph.",
            "literal.\n\nAnother",
            "bold",
            true,
        ),
        ("- literal", "literal", "bold", true),
        ("> literal", "literal", "bold", true),
        ("Heading\n=======", "Heading", "bold", true),
        (
            "A [literal][ref] thought.\n\n[ref]: https://example.com",
            "literal",
            "bold",
            true,
        ),
        (
            "Read [literal][ref].\n\n[ref]: https://example.com",
            "[literal][ref]",
            "code",
            true,
        ),
        (
            "Read [literal][].\n\n[literal]: https://example.com",
            "[literal][]",
            "code",
            true,
        ),
        (
            "Read [literal].\n\n[literal]: https://example.com",
            "[literal]",
            "code",
            true,
        ),
        (
            "Visit https://example.com today.",
            "https://example.com",
            "code",
            true,
        ),
        ("Visit www.example.com today.", "example", "bold", true),
        (
            "Write name@example.com today.",
            "name@example.com",
            "code",
            true,
        ),
        (
            "Visit `https://example.com` today.",
            "`https://example.com`",
            "code",
            false,
        ),
        (
            "Write `name@example.com` today.",
            "`name@example.com`",
            "code",
            false,
        ),
        (
            "Claim [1](orion-source://s1).\n\n## References\n\n1. [Alpha](orion-source://s1)",
            "References",
            "bold",
            true,
        ),
        (
            "Claim [1](orion-source://s1).",
            "[1](orion-source://s1)",
            "bold",
            true,
        ),
        ("&nbsp;", "&nbsp;", "bold", true),
        (
            "&nbsp; <!-- orion-text:v1 justify -->",
            "&nbsp;",
            "code",
            true,
        ),
        (
            "Claim [1](orion-source://s1).\n\n##\tReferences\n\n1. [Alpha](orion-source://s1)",
            "References",
            "bold",
            true,
        ),
        (
            "Claim [1](orion-source://s1).\n\n   ##  References\t\n\n1. [Alpha](orion-source://s1)",
            "References",
            "bold",
            true,
        ),
        ("A **`literal`** thought.", "**`literal`**", "code", false),
        (
            "A [`literal`](https://example.com) thought.",
            "`literal`",
            "code",
            false,
        ),
        ("A ~literal~ thought.", "literal", "bold", true),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let old = fs::read(&server.vault_path).unwrap();
        let args = editor_command(
            &server,
            json!({"command":"inline_format","anchor":anchor,"mark":mark,"enabled":enabled}),
        );
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "accepted {body:?} / {anchor:?}"
        );
        assert_eq!(fs::read(&server.vault_path).unwrap(), old);
    }
}

#[test]
fn inline_unlink_preserves_label_marks_and_rejects_citations() {
    for (body, anchor, expected) in [
        (
            "Read [**Beta**](orion-note://n2).",
            "[**Beta**](orion-note://n2)",
            Some("Read **Beta**."),
        ),
        (
            "Read [*Beta*](https://example.com \"ordinary title\").",
            "[*Beta*](https://example.com \"ordinary title\")",
            Some("Read *Beta*."),
        ),
        (
            "Read [Beta](orion-concept://c1).",
            "[Beta](orion-concept://c1)",
            Some("Read Beta."),
        ),
        (
            "Read [1](orion-source://s1).",
            "[1](orion-source://s1)",
            None,
        ),
        (
            "Read [Beta](orion-note://n2 \"orion-excerpt:v1:payload\").",
            "[Beta](orion-note://n2 \"orion-excerpt:v1:payload\")",
            None,
        ),
        (
            "Read [Beta](orion-note://n2 \"orion-passage:v1:payload\").",
            "[Beta](orion-note://n2 \"orion-passage:v1:payload\")",
            None,
        ),
        (
            "Read [Beta](javascript:alert).",
            "[Beta](javascript:alert)",
            None,
        ),
        ("Read [Beta](https://example.com).", "Beta", None),
        (
            "Read [Beta][ref].\n\n[ref]: https://example.com",
            "[Beta][ref]",
            None,
        ),
        (
            "Read ![Beta](https://example.com).",
            "![Beta](https://example.com)",
            None,
        ),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let old = fs::read(&server.vault_path).unwrap();
        let args = editor_command(&server, json!({"command":"unlink","anchor":anchor}));
        let result = server.call_tool(NAMES[20], args.as_object().unwrap());
        if let Some(expected) = expected {
            result.unwrap_or_else(|e| panic!("{body}: {e:?}"));
            assert_eq!(saved_body(&server), expected);
        } else {
            assert!(result.is_err(), "accepted {body}");
            assert_eq!(fs::read(&server.vault_path).unwrap(), old);
        }
        let saved: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
        assert_eq!(
            saved["spaces"][0]["concepts"],
            initial["spaces"][0]["concepts"]
        );
        assert_eq!(
            saved["spaces"][0]["sources"],
            initial["spaces"][0]["sources"]
        );
    }
}

#[test]
fn inline_commands_keep_version_bounds_and_field_contracts() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!("A careful thought.");
    let (_dir, server) = server(&initial);
    let args = editor_command(
        &server,
        json!({"command":"inline_format","anchor":"careful","mark":"bold","enabled":true}),
    );
    run(&server, NAMES[20], args.clone());
    let old = fs::read(&server.vault_path).unwrap();
    assert!(server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    for fields in [
        json!({"command":"inline_format","anchor":"careful","mark":"bold"}),
        json!({"command":"inline_format","anchor":"careful","mark":"bold","enabled":true,"placement":"replace"}),
        json!({"command":"inline_format","anchor":"careful","mark":"bold","enabled":true,"text":"replacement"}),
        json!({"command":"inline_format","anchor":"x".repeat(20_001),"mark":"bold","enabled":true}),
        json!({"command":"unlink","anchor":"careful","enabled":false}),
        json!({"command":"inline_format","anchor":"careful","mark":"bold","enabled":true,"space_id":"b"}),
    ] {
        let args = editor_command(&server, fields);
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), old);
    }
}

#[test]
fn inline_commands_bound_container_and_nested_mark_work() {
    for body in [
        format!("{} target", "a".repeat(50_001)),
        format!("{}target{}", "*".repeat(100), "*".repeat(100)),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let old = fs::read(&server.vault_path).unwrap();
        let args = editor_command(
            &server,
            json!({"command":"inline_format","anchor":"target","mark":"strike","enabled":true}),
        );
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), old);
    }
}

fn citation_source_version(server: &Server, id: &str) -> String {
    let raw: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    let vault = validate_vault_value(raw).unwrap();
    source_version(source(require_space(&vault, "a").unwrap(), id).unwrap())
}

#[test]
fn source_citation_attaches_both_sides_and_returns_fresh_source_version_atomically() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!("A café 🧭 claim.");
    initial["spaces"][0]["notes"][0]["sourceIds"] = json!([]);
    initial["spaces"][0]["sources"][0]["noteIds"] = json!(["n2"]);
    initial["spaces"][0]["sources"][0]["future"] = json!({"opaque":[1,2]});
    initial["spaces"][0]["sources"][0]["title"] = json!("Source [one] \\ evidence");
    let (_dir, server) = server(&initial);
    let old_source = citation_source_version(&server, "s1");
    let args = editor_command(
        &server,
        json!({"command":"source_citation","citation_action":"insert","source_id":"s1","source_expected_version":old_source,"placement":"after","anchor":"claim"}),
    );
    let result = run(&server, NAMES[20], args.clone());
    assert_eq!(saved_body(&server),"A café 🧭 claim [1](orion-source://s1).\n\n## References\n\n1. [Source \\[one\\] \\\\ evidence](orion-source://s1)");
    let saved: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(saved["spaces"][0]["notes"][0]["sourceIds"], json!(["s1"]));
    let mut expected_source = initial["spaces"][0]["sources"][0].clone();
    expected_source["noteIds"] = json!(["n2", "n1"]);
    assert_eq!(saved["spaces"][0]["sources"][0], expected_source);
    assert_eq!(saved["spaces"][1], initial["spaces"][1]);
    assert_eq!(
        result["sourceAttachments"][0]["source"]["version"],
        citation_source_version(&server, "s1")
    );
    assert_ne!(old_source, citation_source_version(&server, "s1"));
    assert_eq!(result["sourceAttachments"][0]["changed"], true);
    let before = fs::read(&server.vault_path).unwrap();
    assert!(server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    let fresh_note_stale_source = editor_command(
        &server,
        json!({"command":"source_citation","citation_action":"insert","source_id":"s1","source_expected_version":old_source}),
    );
    assert!(server
        .call_tool(NAMES[20], fresh_note_stale_source.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
}

#[test]
fn source_citation_renumbers_first_appearances_and_removes_one_without_detaching() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!("First [Old](orion-source://s1). Again [Old](orion-source://s1). Last [Lost](orion-source://missing).\n\n## References\n\n1. [Old](orion-source://s1)\n2. [Lost saved title](orion-source://missing)");
    let (_dir, server) = server(&initial);
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"source_citation","citation_action":"insert","source_id":"s1","source_expected_version":citation_source_version(&server,"s1"),"placement":"prepend"}),
        ),
    );
    assert!(saved_body(&server).starts_with("[1](orion-source://s1)\n\nFirst [1](orion-source://s1). Again [1](orion-source://s1). Last [2](orion-source://missing)."));
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"source_citation","citation_action":"remove","source_id":"s1","anchor":"First [1](orion-source://s1)."}),
        ),
    );
    assert!(saved_body(&server).contains("First. Again [1](orion-source://s1)."));
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"source_citation","citation_action":"remove","source_id":"missing","anchor":"[2](orion-source://missing)"}),
        ),
    );
    assert!(!saved_body(&server).contains("orion-source://missing"));
    assert!(saved_body(&server).contains("Again [1](orion-source://s1)"));
    let saved: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(
        saved["spaces"][0]["sources"],
        initial["spaces"][0]["sources"]
    );
    assert_eq!(
        saved["spaces"][0]["notes"][0]["sourceIds"],
        initial["spaces"][0]["notes"][0]["sourceIds"]
    );
}

#[test]
fn source_citation_preserves_authored_labels_references_code_metadata_and_frontmatter() {
    for (body, anchor, expected) in [
        (
            "Read [**bold** and *italic*](orion-source://missing).",
            "[**bold** and *italic*](orion-source://missing)",
            "Read **bold** and *italic*.",
        ),
        (
            "Read [an escaped \\` tick](orion-source://missing).",
            "[an escaped \\` tick](orion-source://missing)",
            "Read an escaped \\` tick.",
        ),
        (
            "Year [2024](orion-source://missing).",
            "[2024](orion-source://missing)",
            "Year 2024.",
        ),
        (
            "Read [older words](orion-source://missing).",
            "[older words](orion-source://missing)",
            "Read older words.",
        ),
        (
            "Read [a \\[literal\\] label](orion-source://missing).",
            "[a \\[literal\\] label](orion-source://missing)",
            "Read a \\[literal\\] label.",
        ),
        (
            "Read [2024](orion-source://missing).\n\n## References\n\nAn authored essay section.",
            "[2024](orion-source://missing)",
            "Read 2024.\n\n## References\n\nAn authored essay section.",
        ),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        run(
            &server,
            NAMES[20],
            editor_command(
                &server,
                json!({"command":"source_citation","citation_action":"remove","source_id":"missing","anchor":anchor}),
            ),
        );
        assert_eq!(saved_body(&server), expected);
    }
    let prefix = "---\r\nsecret: '[literal](orion-source://private)'\r\n---\r\n\r\n";
    let prose = "<!-- orion-block:v1 -->\r\n\r\nA claim. <!-- orion-paragraph-margins:v1 4 6 -->\r\n\r\n`[code](orion-source://s1)`\r\n\r\n~~~md\r\n[example](orion-source://s1)\r\n~~~\r\n\r\n<!-- /orion-block -->";
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!(format!("{prefix}{prose}"));
    let (_dir, server) = server(&initial);
    run(
        &server,
        NAMES[20],
        editor_command(
            &server,
            json!({"command":"source_citation","citation_action":"insert","source_id":"s1","source_expected_version":citation_source_version(&server,"s1"),"placement":"after","anchor":"claim"}),
        ),
    );
    assert_eq!(
        saved_body(&server),
        format!(
            "{prefix}{}\n\n## References\n\n1. [Source one](orion-source://s1)",
            prose.replace("claim.", "claim [1](orion-source://s1).")
        )
    );
}

#[test]
fn source_citation_rejects_ambiguous_unsafe_hidden_and_unversioned_edits_without_writes() {
    let cases = [
        ("Claim.", json!({"placement":"replace","anchor":"Claim."})),
        ("Claim.", json!({"text":"forged label"})),
        ("Claim.", json!({"source_expected_version":"stale"})),
        ("Claim.", json!({"source_id":"foreign"})),
        ("Claim.", json!({"source_id":"s1)bad"})),
        (
            "Claim. Claim.",
            json!({"placement":"after","anchor":"Claim"}),
        ),
        ("`Claim`", json!({"placement":"after","anchor":"Claim"})),
        (
            "[Claim](https://example.com)",
            json!({"placement":"after","anchor":"Claim"}),
        ),
        ("Claim.\n\n<!-- [hidden](orion-source://s1) -->", json!({})),
        ("[claim][ref]\n\n[ref]: orion-source://s1", json!({})),
        ("[claim](orion-source://s1 \"title\")", json!({})),
        ("```md\nUnclosed code", json!({})),
        ("    [code](orion-source://s1)", json!({})),
        (
            "Visit https://example.com today.",
            json!({"placement":"after","anchor":"example"}),
        ),
        (
            "Visit https://example.com?a=1&amp;query=word today.",
            json!({"placement":"after","anchor":"word"}),
        ),
        (
            "Visit www.example.com today.",
            json!({"placement":"after","anchor":"example"}),
        ),
        (
            "Write name@example.com today.",
            json!({"placement":"after","anchor":"name"}),
        ),
        (
            "A &amp; claim.",
            json!({"placement":"after","anchor":"amp"}),
        ),
        (
            "![alt [hidden](orion-source://s1)](https://example.com/image)",
            json!({}),
        ),
        ("`code\n[hidden](orion-source://s1)`", json!({})),
        (
            "~~~md\n[hidden](orion-source://s1)\n~~~~\nVisible.",
            json!({}),
        ),
        ("- ```md\n  [code](orion-source://s1)\n  ```", json!({})),
    ];
    for (body, extra) in cases {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let mut fields = json!({"command":"source_citation","citation_action":"insert","source_id":"s1","source_expected_version":citation_source_version(&server,"s1")});
        fields
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let args = editor_command(&server, fields);
        let before = fs::read(&server.vault_path).unwrap();
        assert!(
            server
                .call_tool(NAMES[20], args.as_object().unwrap())
                .is_err(),
            "accepted {body} / {extra}"
        );
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
    for duplicate in [false, true] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!("Claim.");
        let src = initial["spaces"][0]["sources"][0].clone();
        if duplicate {
            initial["spaces"][0]["sources"]
                .as_array_mut()
                .unwrap()
                .push(src);
        } else {
            initial["spaces"][1]["sources"] = json!([src]);
            initial["spaces"][0]["sources"] = json!([]);
        }
        let (_dir, server) = server(&initial);
        let args = editor_command(
            &server,
            json!({"command":"source_citation","citation_action":"insert","source_id":"s1","source_expected_version":"not-trusted"}),
        );
        let before = fs::read(&server.vault_path).unwrap();
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

#[test]
fn source_citation_large_result_and_partial_removal_leave_both_records_untouched() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] = json!("Claim.");
    initial["spaces"][0]["notes"][0]["sourceIds"] = json!([]);
    initial["spaces"][0]["sources"][0]["noteIds"] = json!([]);
    initial["spaces"][0]["sources"][0]["title"] = json!("文".repeat(MAX_NOTE_BODY_CHARS));
    let (_dir, large_server) = server(&initial);
    let before = fs::read(&large_server.vault_path).unwrap();
    let args = editor_command(
        &large_server,
        json!({"command":"source_citation","citation_action":"insert","source_id":"s1","source_expected_version":citation_source_version(&large_server,"s1")}),
    );
    assert!(large_server
        .call_tool(NAMES[20], args.as_object().unwrap())
        .is_err());
    assert_eq!(fs::read(&large_server.vault_path).unwrap(), before);
    for (body, anchor) in [
        (
            "A [1](orion-source://s1) and [2](orion-source://missing).",
            "A [1](orion-source://s1) and [2](orion-source://missing).",
        ),
        ("A [1](orion-source://s1).", "[1]"),
        ("`[1](orion-source://s1)`", "[1](orion-source://s1)"),
        (
            "A [1](orion-source://s1). A [1](orion-source://s1).",
            "[1](orion-source://s1)",
        ),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!(body);
        let (_dir, server) = server(&initial);
        let before = fs::read(&server.vault_path).unwrap();
        let args = editor_command(
            &server,
            json!({"command":"source_citation","citation_action":"remove","source_id":"s1","anchor":anchor}),
        );
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

#[test]
fn source_citation_preserves_exact_unicode_ids_and_javascript_title_whitespace() {
    for (title, expected) in [
        ("\u{feff}Evidence\u{feff}", "Evidence"),
        ("\u{0085}Evidence\u{0085}", "\u{0085}Evidence\u{0085}"),
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!("Claim.");
        initial["spaces"][0]["sources"][0]["id"] = json!("citation-証拠");
        initial["spaces"][0]["sources"][0]["title"] = json!(title);
        let (_dir, server) = server(&initial);
        run(
            &server,
            NAMES[20],
            editor_command(
                &server,
                json!({"command":"source_citation","citation_action":"insert","source_id":"citation-証拠","source_expected_version":citation_source_version(&server,"citation-証拠")}),
            ),
        );
        assert!(saved_body(&server)
            .ends_with(&format!("1. [{expected}](orion-source://citation-証拠)")));
    }
    for id in [
        "source&copy;",
        "source&#49;",
        "source|column",
        "source`tick",
    ] {
        let mut initial = fixture();
        initial["spaces"][0]["notes"][0]["body"] = json!("Claim.");
        initial["spaces"][0]["sources"][0]["id"] = json!(id);
        let (_dir, server) = server(&initial);
        let before = fs::read(&server.vault_path).unwrap();
        let args = editor_command(
            &server,
            json!({"command":"source_citation","citation_action":"insert","source_id":id,"source_expected_version":citation_source_version(&server,id)}),
        );
        assert!(server
            .call_tool(NAMES[20], args.as_object().unwrap())
            .is_err());
        assert_eq!(fs::read(&server.vault_path).unwrap(), before);
    }
}

#[test]
fn passage_comments_are_pending_metadata_with_scoped_atomic_version_guards() {
    let initial = fixture();
    let (_dir, server) = server(&initial);
    let args = json!({"space_id":"a","note_id":"n1","expected_version":version(&server,"n1"),"thread_id":"t1","message_id":"m1","quote":"alpha 🧭 evidence","comment":"Clarify this evidence.","proposal":{"kind":"rewrite","text":"Stronger evidence."}});
    run(&server, "orion_propose_passage_comment", args.clone());
    assert_eq!(
        saved_body(&server),
        initial["spaces"][0]["notes"][0]["body"]
    );
    let saved: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    assert_eq!(saved["spaces"][1], initial["spaces"][1]);
    assert_eq!(
        saved["spaces"][0]["spaceOverview"],
        initial["spaces"][0]["spaceOverview"]
    );
    let read = run(
        &server,
        "orion_get_passage_threads",
        json!({"note_id":"n1"}),
    );
    assert_eq!(read["threads"][0]["state"], "proposed");
    assert_eq!(read["threads"][0]["anchorCurrent"], true);
    assert_eq!(
        read["threads"][0]["messages"][0]["proposal"]["text"],
        "Stronger evidence."
    );
    let before = fs::read(&server.vault_path).unwrap();
    assert!(server
        .call_tool("orion_propose_passage_comment", args.as_object().unwrap())
        .is_err());
    let mut foreign = args.clone();
    foreign["space_id"] = json!("b");
    assert!(server
        .call_tool(
            "orion_propose_passage_comment",
            foreign.as_object().unwrap()
        )
        .is_err());
    let mut duplicate = args;
    duplicate["expected_version"] = json!(version(&server, "n1"));
    assert!(server
        .call_tool(
            "orion_propose_passage_comment",
            duplicate.as_object().unwrap()
        )
        .is_err());
    assert_eq!(fs::read(&server.vault_path).unwrap(), before);
}

#[test]
fn passage_comments_reject_ambiguous_hidden_and_malformed_targets() {
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["body"] =
        json!("Same. Same.\n\nVisible.\n\n- [x] Hidden task");
    let (_dir, server) = server(&initial);
    let mut args = json!({"space_id":"a","note_id":"n1","expected_version":version(&server,"n1"),"thread_id":"t","message_id":"m","quote":"Same.","comment":"Discuss."});
    for quote in ["Same.", "Hidden task", "missing"] {
        args["quote"] = json!(quote);
        assert!(server
            .call_tool("orion_propose_passage_comment", args.as_object().unwrap())
            .is_err());
    }
    args["quote"] = json!("Visible.");
    run(&server, "orion_propose_passage_comment", args);
    let read = run(
        &server,
        "orion_get_passage_threads",
        json!({"note_id":"n1"}),
    );
    assert_eq!(read["threads"], json!([]));
    assert_eq!(read["discussionOmitted"], true);
    let history = run(
        &server,
        "orion_get_passage_threads",
        json!({"note_id":"n1","task_view":"history"}),
    );
    assert_eq!(history["threads"].as_array().unwrap().len(), 1);
    let mut raw: Value = serde_json::from_slice(&fs::read(&server.vault_path).unwrap()).unwrap();
    raw["spaces"][0]["notes"][0]["discussionThreads"][0]["messages"] = json!([]);
    assert!(validate_vault_value(raw).is_err());
}

#[test]
fn standalone_note_comments_validate_without_fake_passages() {
    let thread = json!({"id":"general","anchor":{"scope":"note","quote":"","text":""},"state":"open","createdAt":"now","updatedAt":"now","messages":[{"id":"m","role":"user","content":"A thought for later.","createdAt":"now"}]});
    assert!(threads::valid(&[thread.clone()]));
    let mut malformed = thread.clone();
    malformed["anchor"]["quote"] = json!("invented");
    assert!(!threads::valid(&[malformed]));
    let mut initial = fixture();
    initial["spaces"][0]["notes"][0]["discussionThreads"] = json!([thread]);
    assert!(validate_vault_value(initial).is_ok());
}

#[test]
fn comment_cursor_metadata_is_bounded_and_optional() {
    let mut thread = json!({"id":"cursor","anchor":{"scope":"note","quote":"","text":"","cursor":{"before":"Earlier.\n\n","after":"Later."}},"state":"open","createdAt":"now","updatedAt":"now","messages":[{"id":"m","role":"user","content":"A thought.","createdAt":"now"}]});
    assert!(threads::valid(&[thread.clone()]));
    thread["anchor"]["cursor"]["before"] = json!("x".repeat(257));
    assert!(!threads::valid(&[thread.clone()]));
    thread["anchor"]["cursor"] = json!({"before":""});
    assert!(!threads::valid(&[thread]));
}
