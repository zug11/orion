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
    fields(block, &["kind", "passage", "premises", "conclusions"])?;
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
        json!({"id":id,"text":string(500),"quote":string(400),"supports":array(group,1,4)}),
        &["id", "text", "quote", "supports"],
    );
    let mut block = object(
        json!({"kind":{"const":"argument"},"passage":string(12000),"premises":array(json!({"oneOf":[stated,unstated]}),1,8),"conclusions":array(conclusion,1,6)}),
        &["kind", "passage", "premises", "conclusions"],
    );
    block["description"] = json!("Use unique IDs and at least one stated premise. Stated premises and conclusions quote the passage exactly. Each support group requires all its named premises or earlier conclusions. Any complete group supports the conclusion. 'without' explains the effect of withholding a premise.");
    block
}
