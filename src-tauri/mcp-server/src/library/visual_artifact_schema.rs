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
        json!({"label":string(100),"unit":unit,"expression":expression,"labels":array(object(json!({"value":quantity,"label":string(80)}), &["value","label"]),1,12)}),
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

    let references = |min, max| array(index(23), min, max);
    let calculator = tagged(
        "calculator",
        json!({
            "inputs":array(input,1,6), "outputs":array(output,1,24),
            "explanation":array(json!({"oneOf":[blank_text(400),object(json!({"input":index(5)}), &["input"]),object(json!({"output":index(23)}), &["output"])]}),1,32),
            "presets":array(object(json!({"label":string(80),"values":array(quantity.clone(),1,6)}), &["label","values"]),1,12),
            "chart":object(json!({"input":index(5),"outputs":references(1,3),"dragInput":index(5),"settleOutput":index(23)}),&["input","outputs"]),
            "recipe":object(json!({"input":index(5),"ingredients":references(1,24),"cookingNote":string(500)}),&["input","ingredients"]),
            "counts":object(json!({"total":{"type":"integer","minimum":1,"maximum":1000},"outputs":references(2,6)}),&["total","outputs"]),
            "flow":object(json!({"source":string(100),"destinations":references(2,6),"capacity":{"type":"number","exclusiveMinimum":0,"maximum":1e9}}),&["source","destinations","capacity"])
        }),
        &["inputs", "outputs"],
    );
    let target = object(
        json!({"block":index(11),"field":{"type":"string","enum":["input","output","step","cell"]},"index":index(143)}),
        &["block", "field", "index"],
    );
    let evidence = object(
        json!({"passage":string(12000),"claims":array(object(json!({"label":string(200),"quotes":array(string(500),0,4),"target":target}),&["label","quotes"]),1,48)}),
        &["passage", "claims"],
    );
    let document = object(
        json!({"version":{"type":"integer","const":1},"title":string(160),"summary":string(600),"evidence":evidence,
        "format":{"type":"string","enum":["timeline","explainer","quiz","comparison","flashcards","calculator","cycle","linkedViews","argument","scaleZoom","deepTime"]},
        "blocks":array(json!({"$ref":"#/$defs/block"}),1,12)}),
        &["version", "format", "title", "blocks"],
    );
    let mut blocks = vec![
        tagged(
            "text",
            json!({"heading":string(160),"text":string(2000)}),
            &["text"],
        ),
        tagged("steps", json!({"items":array(step,1,24)}), &["items"]),
        tagged(
            "table",
            json!({"columns":array(blank_text(100),2,6),"rows":array(array(blank_text(400),2,6),1,24)}),
            &["columns", "rows"],
        ),
        tagged("quiz", json!({"items":array(question,1,20)}), &["items"]),
        tagged("cards", json!({"items":array(card,1,32)}), &["items"]),
        calculator,
        super::visual_artifact_illustration_schema::definition(),
        tagged(
            "scene",
            json!({"nodes":array(node,1,8),"frames":array(frame,1,12)}),
            &["nodes", "frames"],
        ),
    ];
    blocks.extend(super::visual_artifact::cycle_link::definitions());
    blocks.push(super::visual_artifact::argument::definition());
    blocks.extend(super::visual_artifact::scale_time::definitions());
    json!({
        "visualArtifact":document,
        "block":{"oneOf":blocks},
        "illustrationShape":super::visual_artifact_illustration_schema::shape_definition(),
        "shape":{"oneOf":[
            tagged("path",json!({"d":string(1200),"fill":paint,"stroke":paint}),&["d","fill","stroke"]),
            tagged("rect",json!({"x":coordinate,"y":coordinate,"width":coordinate,"height":coordinate,
                "level":{"type":"boolean"},"fill":paint,"stroke":paint}),&["x","y","width","height","fill","stroke"]),
            tagged("circle",json!({"cx":coordinate,"cy":coordinate,"r":coordinate,"fill":paint,"stroke":paint}),&["cx","cy","r","fill","stroke"])
        ]},
        "expression":{"description":"At most 63 nodes, nesting depth 8. Input references are zero-based. periodicPayment uses principal, fractional rate per period and a positive whole payment count.","oneOf":[
            quantity,
            object(json!({"input":index(5)}), &["input"]),
            object(json!({"op":{"type":"string","enum":["add","subtract","multiply","divide","min","max"]},
                "left":expression,"right":expression}), &["op","left","right"]),
            object(json!({"op":{"type":"string","const":"round"},"value":expression}), &["op","value"]),
            object(json!({"op":{"type":"string","const":"ifLess"},"left":expression,"right":expression,"then":expression,"else":expression}), &["op","left","right","then","else"]),
            object(json!({"op":{"type":"string","const":"periodicPayment"},"principal":expression,
                "ratePerPeriod":expression,"periods":expression}), &["op","principal","ratePerPeriod","periods"])
        ]}
    })
}
