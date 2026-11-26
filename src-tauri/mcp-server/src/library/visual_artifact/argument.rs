use super::super::{array, object, string};
use super::{fields, invalid, list, literal};
use serde_json::{json, Value};
use std::collections::HashSet;

fn claim_id(value: &Value) -> Result<&str, String> {
    let id = literal(value, 32, false)?;
    let mut bytes = id.bytes();
    if !bytes.next().is_some_and(|ch| ch.is_ascii_alphabetic())
        || !bytes.all(|ch| ch.is_ascii_alphanumeric() || ch == b'_' || ch == b'-')
    {
        return Err(invalid("invalid argument claim identifier"));
    }
    Ok(id)
}

fn source_quote(value: &Value, passage: &str) -> Result<(), String> {
    if !passage.contains(literal(value, 400, false)?) {
        return Err(invalid("an argument quote is missing from its passage"));
    }
    Ok(())
}

pub(super) fn validate(block: &Value) -> Result<(), String> {
    fields(
        block,
        &["kind", "passage", "premises", "conclusions", "reading"],
    )?;
    if block["kind"] != "argument" {
        return Err(invalid("expected an argument"));
    }
    let passage = literal(&block["passage"], 12000, false)?;
    let mut available = HashSet::new();
    let mut has_stated = false;
    for p in list(&block["premises"], 1, 8)? {
        fields(p, &["id", "text", "quote", "without", "unstated"])?;
        literal(&p["text"], 500, false)?;
        literal(&p["without"], 500, false)?;
        if !available.insert(claim_id(&p["id"])?) {
            return Err(invalid("argument claims need distinct identifiers"));
        }
        if let Some(unstated) = p.get("unstated") {
            if unstated.as_bool() != Some(true) || p.get("quote").is_some() {
                return Err(invalid(
                    "an unstated premise must be marked true and omit its quote",
                ));
            }
        } else {
            source_quote(&p["quote"], passage)?;
            has_stated = true;
        }
    }
    if !has_stated {
        return Err(invalid("an argument needs a premise from its passage"));
    }

    for conclusion in list(&block["conclusions"], 1, 6)? {
        fields(conclusion, &["id", "text", "quote", "supports"])?;
        literal(&conclusion["text"], 500, false)?;
        source_quote(&conclusion["quote"], passage)?;
        for group in list(&conclusion["supports"], 1, 4)? {
            let mut unique = HashSet::new();
            for reference in list(group, 1, 8)? {
                let id = claim_id(reference)?;
                if !available.contains(id) || !unique.insert(id) {
                    return Err(invalid("each support group needs distinct references to premises or earlier conclusions"));
                }
            }
        }
        if !available.insert(claim_id(&conclusion["id"])?) {
            return Err(invalid("argument claims need distinct identifiers"));
        }
    }
    if let Some(reading) = block.get("reading") {
        let mut has_variants = false;
        for paragraph in list(reading, 1, 8)? {
            if paragraph.is_string() {
                literal(paragraph, 1200, false)?;
                continue;
            }
            fields(paragraph, &["variants", "fallback"])?;
            if paragraph.get("fallback") != Some(&Value::Null) {
                literal(&paragraph["fallback"], 1200, false)?;
            }
            let mut conditions = HashSet::new();
            let mut changes_text = false;
            for variant in list(&paragraph["variants"], 1, 8)? {
                fields(variant, &["requires", "text"])?;
                literal(&variant["text"], 1200, false)?;
                changes_text |= variant["text"] != paragraph["fallback"];
                let mut ids = Vec::new();
                for reference in list(&variant["requires"], 1, 8)? {
                    let id = claim_id(reference)?;
                    if !available.contains(id) || ids.contains(&id) {
                        return Err(invalid(
                            "paragraph variants need distinct references to existing claims",
                        ));
                    }
                    ids.push(id);
                }
                ids.sort_unstable();
                if !conditions.insert(ids) {
                    return Err(invalid(
                        "duplicate support condition in an argument paragraph",
                    ));
                }
            }
            if !changes_text {
                return Err(invalid("a paragraph variant must change the reading"));
            }
            has_variants = true;
        }
        if !has_variants {
            return Err(invalid(
                "a reading needs at least one paragraph with variants",
            ));
        }
    }
    Ok(())
}

pub(crate) fn definition() -> Value {
    let id = json!({"type":"string","pattern":"^[A-Za-z][A-Za-z0-9_-]{0,31}$","maxLength":32});
    let stated = object(
        json!({"id":id,"text":string(500),"quote":string(400),"without":string(500)}),
        &["id", "text", "quote", "without"],
    );
    let unstated = object(
        json!({"id":id,"text":string(500),"unstated":{"const":true},"without":string(500)}),
        &["id", "text", "unstated", "without"],
    );
    let mut group = array(id.clone(), 1, 8);
    group["uniqueItems"] = json!(true);
    let conclusion = object(
        json!({"id":id,"text":string(500),"quote":string(400),"supports":array(group.clone(),1,4)}),
        &["id", "text", "quote", "supports"],
    );
    let variant = object(
        json!({"requires":group,"text":string(1200)}),
        &["requires", "text"],
    );
    let paragraph = object(
        json!({"variants":array(variant,1,8),"fallback":{"anyOf":[string(1200),{"type":"null"}]}}),
        &["variants", "fallback"],
    );
    let mut block = object(
        json!({"kind":{"const":"argument"},"passage":string(12000),"premises":array(json!({"oneOf":[stated,unstated]}),1,8),"conclusions":array(conclusion,1,6),"reading":array(json!({"oneOf":[string(1200),paragraph]}),1,8)}),
        &["kind", "passage", "premises", "conclusions"],
    );
    block["description"] = json!("Use unique IDs and at least one stated premise. Stated premises and conclusions quote the passage exactly. Any complete support group establishes its conclusion. For an adaptive reading, write complete paragraph variants with requires referencing premises or conclusions. All listed claims must hold. The longest matching list wins, with ties in written order. Fallback is the reading when no variant applies. Use a null fallback to omit the whole paragraph. A string is a fixed paragraph.");
    block
}
