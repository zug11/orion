//! A custom layout connects independently chosen values to existing content.
use super::super::{array, object, string};
use super::{fields, index, invalid, list, literal, Value};
use serde_json::json;
use std::collections::HashSet;

pub(super) fn validate(layout: &Value, blocks: &[Value]) -> Result<(), String> {
    fields(layout, &["controls", "rows"])?;
    let controls = list(&layout["controls"], 0, 4)?;
    let mut option_counts = Vec::with_capacity(controls.len());
    for control in controls {
        fields(control, &["label", "options", "initial"])?;
        literal(&control["label"], 100, false)?;
        let options = list(&control["options"], 2, 8)?;
        let mut labels = HashSet::new();
        for option in options {
            if !labels.insert(literal(option, 80, false)?) {
                return Err(invalid("choice labels must be distinct"));
            }
        }
        if let Some(initial) = control.get("initial") {
            index(initial, options.len())?;
        }
        option_counts.push(options.len());
    }

    let mut placed_blocks = HashSet::new();
    let mut placed_controls = HashSet::new();
    let mut used_controls = HashSet::new();
    let mut binding = |value: &Value| -> Result<usize, String> {
        let i = index(value, controls.len())?;
        used_controls.insert(i);
        Ok(i)
    };
    for row in list(&layout["rows"], 1, 16)? {
        for cell in list(row, 1, 3)? {
            if let Some(control) = cell.get("control") {
                fields(cell, &["control"])?;
                if !placed_controls.insert(index(control, controls.len())?) {
                    return Err(invalid("control placed more than once"));
                }
                continue;
            }
            if let Some(conditions) = cell.get("when") {
                let mut tested = HashSet::new();
                for condition in list(conditions, 1, controls.len())? {
                    fields(condition, &["control", "is"])?;
                    let i = binding(&condition["control"])?;
                    index(&condition["is"], option_counts[i])?;
                    if !tested.insert(i) {
                        return Err(invalid("duplicate condition on a choice"));
                    }
                }
            }
            if let Some(block) = cell.get("block") {
                fields(cell, &["block", "stageControls", "when"])?;
                let i = index(block, blocks.len())?;
                if !placed_blocks.insert(i) {
                    return Err(invalid("block placed more than once"));
                }
                if let Some(axes) = cell.get("stageControls") {
                    let mut seen = HashSet::new();
                    let mut count = 1;
                    for axis in list(axes, 1, controls.len())? {
                        let control = binding(axis)?;
                        if !seen.insert(control) {
                            return Err(invalid("duplicate scene control"));
                        }
                        count *= option_counts[control];
                    }
                    if blocks[i]["kind"] != "scene"
                        || blocks[i]["frames"].as_array().map(Vec::len) != Some(count)
                    {
                        return Err(invalid(
                            "scene frame count must match its choice combinations",
                        ));
                    }
                }
            } else {
                fields(cell, &["readout", "label", "values", "when"])?;
                let count = option_counts[binding(&cell["readout"])?];
                literal(&cell["label"], 100, false)?;
                for v in list(&cell["values"], count, count)? {
                    literal(v, 200, false)?;
                }
            }
        }
    }
    if placed_blocks.len() != blocks.len()
        || placed_controls.len() != controls.len()
        || used_controls.len() != controls.len()
    {
        return Err(invalid(
            "place all blocks and controls and bind every choice",
        ));
    }
    Ok(())
}

pub(crate) fn definition() -> Value {
    let reference = |max: u8| json!({"type":"integer","minimum":0,"maximum":max});
    let when = array(
        object(
            json!({"control":reference(3),"is":reference(7)}),
            &["control", "is"],
        ),
        1,
        4,
    );
    let control = object(
        json!({"label":string(100),"options":array(string(80),2,8),"initial":reference(7)}),
        &["label", "options"],
    );
    let cell = json!({"oneOf":[
        object(json!({"control":reference(3)}), &["control"]),
        object(json!({"block":reference(11),"stageControls":array(reference(3),1,4),"when":when}), &["block"]),
        object(json!({"readout":reference(3),"label":string(100),"values":array(string(200),2,8),"when":when}), &["readout","label","values"])
    ]});
    object(
        json!({"controls":array(control,0,4),"rows":array(array(cell,1,3),1,16)}),
        &["controls", "rows"],
    )
}
