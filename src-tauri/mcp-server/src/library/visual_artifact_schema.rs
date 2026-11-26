//! MCP discovery schema for the v1 document. Cross-field constraints, bounded
//! expressions and range evaluation are enforced by the artifact validator.
use super::{array, json, object, string, Value};

pub(super) const DOCUMENT_REF: &str = "#/$defs/visualArtifact";

fn tagged(kind: &str, mut properties: Value, required: &[&str]) -> Value {
    properties["kind"] = json!({"type":"string","const":kind});
    let mut keys = vec!["kind"];
    keys.extend_from_slice(required);
    object(properties, &keys)
}

pub(super) fn definitions() -> Value {
    let unit = json!({"type":"string","maxLength":32});
    let quantity = json!({"type":"number","minimum":-1e9,"maximum":1e9});
    let coordinate = json!({"type":"number","minimum":0,"maximum":100});
    let paint =
        json!({"type":"string","enum":["none","ink","muted","accent","warm","cool","surface"]});
    let expression = json!({"$ref":"#/$defs/expression"});
    let index = |max: u8| json!({"type":"integer","minimum":0,"maximum":max});
    let blank_text = |max: usize| json!({"type":"string","maxLength":max});

    let step = object(
        json!({"label":string(80),"heading":string(180),"text":string(1200)}),
        &["label", "heading", "text"],
    );
    let question = object(
        json!({"question":string(500),"choices":array(string(350),2,6),
        "answer":index(5),"explanation":string(800)}),
        &["question", "choices", "answer", "explanation"],
    );
    let card = object(
        json!({"front":string(500),"back":string(1200)}),
        &["front", "back"],
    );
    let input = object(
        json!({"label":string(100),"unit":unit,"min":quantity,"max":quantity,
        "step":quantity,"initial":quantity}),
        &["label", "unit", "min", "max", "step", "initial"],
    );
    let output = object(
        json!({"label":string(100),"unit":unit,"expression":expression}),
        &["label", "unit", "expression"],
    );
    let node = object(
        json!({"label":string(80),"alt":string(300),"x":coordinate,"y":coordinate,
        "shapes":array(json!({"$ref":"#/$defs/shape"}),1,24)}),
        &["label", "alt", "x", "y", "shapes"],
    );
    let flow = object(
        json!({"from":index(7),"to":index(7),"label":blank_text(80)}),
        &["from", "to", "label"],
    );
    let level = json!({"type":["number","null"],"minimum":0,"maximum":1});
    let frame = object(
        json!({"label":string(80),"caption":string(1000),"values":array(blank_text(100),1,8),
        "levels":array(level,1,8),"flows":array(flow,0,16)}),
        &["label", "caption", "values", "levels", "flows"],
    );

    let document = object(
        json!({"version":{"type":"integer","const":1},"title":string(160),"summary":string(600),
        "format":{"type":"string","enum":["timeline","explainer","quiz","comparison","flashcards","calculator"]},
        "blocks":array(json!({"$ref":"#/$defs/block"}),1,12)}),
        &["version", "format", "title", "blocks"],
    );
    json!({
        "visualArtifact":document,
        "block":{"oneOf":[
            tagged("text",json!({"heading":string(160),"text":string(2000)}),&["text"]),
            tagged("steps",json!({"items":array(step,1,24)}),&["items"]),
            tagged("table",json!({"columns":array(blank_text(100),2,6),"rows":array(array(blank_text(400),2,6),1,24)}),&["columns","rows"]),
            tagged("quiz",json!({"items":array(question,1,20)}),&["items"]),
            tagged("cards",json!({"items":array(card,1,32)}),&["items"]),
            tagged("calculator",json!({"inputs":array(input,1,6),"outputs":array(output,1,6)}),&["inputs","outputs"]),
            tagged("scene",json!({"nodes":array(node,1,8),"frames":array(frame,1,12)}),&["nodes","frames"])
        ]},
        "shape":{"oneOf":[
            tagged("path",json!({"d":string(1200),"fill":paint,"stroke":paint}),&["d","fill","stroke"]),
            tagged("rect",json!({"x":coordinate,"y":coordinate,"width":coordinate,"height":coordinate,
                "level":{"type":"boolean"},"fill":paint,"stroke":paint}),&["x","y","width","height","fill","stroke"]),
            tagged("circle",json!({"cx":coordinate,"cy":coordinate,"r":coordinate,"fill":paint,"stroke":paint}),&["cx","cy","r","fill","stroke"])
        ]},
        "expression":{"description":"At most 63 nodes, nesting depth 5. Input references are zero-based. periodicPayment uses principal, fractional rate per period and a positive whole payment count.","oneOf":[
            quantity,
            object(json!({"input":index(5)}), &["input"]),
            object(json!({"op":{"type":"string","enum":["add","subtract","multiply","divide","min","max"]},
                "left":expression,"right":expression}), &["op","left","right"]),
            object(json!({"op":{"type":"string","const":"periodicPayment"},"principal":expression,
                "ratePerPeriod":expression,"periods":expression}), &["op","principal","ratePerPeriod","periods"])
        ]}
    })
}
