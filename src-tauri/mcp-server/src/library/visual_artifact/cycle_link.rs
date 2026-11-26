//! A shared control drives typed keyframed paths in one cycle or two linked views.
use super::super::{array, object, string};
use super::{fields, illustration, invalid, list, literal, number, Value};
use serde_json::json;

const POSE: [(&str, f64, f64, f64); 6] = [
    ("x", -240., 240., 0.),
    ("y", -160., 160., 0.),
    ("angle", -1440., 1440., 0.),
    ("scaleX", 0., 4., 1.),
    ("scaleY", 0., 4., 1.),
    ("opacity", 0., 1., 1.),
];

fn positions(items: &[Value], period: f64) -> Result<(), String> {
    let mut previous = None;
    for item in items {
        let at = number(&item["at"], 0., period)?;
        if previous.map_or(at != 0., |last| at <= last) {
            return Err(invalid(
                "positions must start at zero and strictly increase",
            ));
        }
        previous = Some(at);
    }
    Ok(())
}

fn mark(raw: &Value, period: f64, wraps: bool) -> Result<bool, String> {
    fields(raw, &["d", "tone", "filled", "pivot", "motion"])?;
    literal(&raw["d"], 1800, false)?;
    illustration::path(&raw["d"], (240., 160.))?;
    if !raw["tone"]
        .as_str()
        .is_some_and(|tone| illustration::TONES.contains(&tone))
    {
        return Err(invalid("unknown motion drawing tone"));
    }
    if raw.get("filled").is_some_and(|v| !v.is_boolean()) {
        return Err(invalid("expected a boolean fill"));
    }
    if let Some(pivot) = raw.get("pivot") {
        let xy = list(pivot, 2, 2)?;
        number(&xy[0], 0., 240.)?;
        number(&xy[1], 0., 160.)?;
    }
    let Some(track) = raw.get("motion") else {
        return Ok(false);
    };
    let frames = list(track, 2, 24)?;
    positions(frames, period)?;
    if frames[frames.len() - 1]["at"].as_f64() != Some(period) {
        return Err(invalid("movement must reach the end of the control range"));
    }
    let mut first = [0.; 6];
    let mut previous = [0.; 6];
    let mut moves = false;
    for (i, frame) in frames.iter().enumerate() {
        fields(
            frame,
            &["at", "x", "y", "angle", "scaleX", "scaleY", "opacity"],
        )?;
        let mut pose = [0.; 6];
        for (j, (key, low, high, default)) in POSE.iter().enumerate() {
            pose[j] = match frame.get(*key) {
                Some(value) => number(value, *low, *high)?,
                None => *default,
            };
        }
        if i == 0 {
            first = pose;
        } else if pose != previous {
            moves = true;
        }
        previous = pose;
    }
    if wraps {
        for (j, (key, ..)) in POSE.iter().enumerate() {
            let diff = previous[j] - first[j];
            let closed = if *key == "angle" {
                let turns = diff / 360.;
                (turns - turns.round()).abs() <= 1e-9
            } else {
                diff == 0.
            };
            if !closed {
                return Err(invalid("a cycle must close at its starting pose"));
            }
        }
    }
    Ok(moves)
}

pub(super) fn validate(raw: &Value) -> Result<(), String> {
    fields(
        raw,
        &[
            "kind", "label", "unit", "period", "passage", "phases", "views",
        ],
    )?;
    let count = match raw["kind"].as_str() {
        Some("cycle") => 1,
        Some("linkedViews") => 2,
        _ => return Err(invalid("unknown motion block")),
    };
    literal(&raw["label"], 80, false)?;
    literal(&raw["unit"], 24, true)?;
    let period = number(&raw["period"], 0., 1e9)?;
    if period <= 0. {
        return Err(invalid("expected a positive control range"));
    }
    let passage = literal(&raw["passage"], 12000, false)?;
    let phases = list(&raw["phases"], 2, 12)?;
    positions(phases, period)?;
    for phase in phases {
        fields(phase, &["at", "label", "caption", "quote"])?;
        literal(&phase["label"], 80, false)?;
        literal(&phase["caption"], 600, false)?;
        let quote = literal(&phase["quote"], 400, false)?;
        if !passage.contains(quote) || count == 1 && phase["at"].as_f64() == Some(period) {
            return Err(invalid("invalid phase quotation or boundary"));
        }
    }
    for view in list(&raw["views"], count, count)? {
        fields(view, &["label", "marks"])?;
        literal(&view["label"], 80, false)?;
        let mut moves = false;
        for item in list(&view["marks"], 1, 32)? {
            moves |= mark(item, period, count == 1)?;
        }
        if !moves {
            return Err(invalid("each view must respond to the shared control"));
        }
    }
    Ok(())
}

pub(crate) fn definitions() -> Vec<Value> {
    let bounded = |min: f64, max: f64| json!({"type":"number","minimum":min,"maximum":max});
    let at = bounded(0., 1e9);
    let mut pose = json!({"at": at});
    for (key, min, max, _) in POSE {
        pose[key] = bounded(min, max);
    }
    let drawing = object(
        json!({
            "d": string(1800), "tone": {"type":"string","enum":illustration::TONES},
            "filled":{"type":"boolean"},
            "pivot":{"type":"array","minItems":2,"maxItems":2,"prefixItems":[bounded(0.,240.),bounded(0.,160.)]},
            "motion":array(object(pose,&["at"]),2,24)
        }),
        &["d", "tone"],
    );
    let view = object(
        json!({"label":string(80),"marks":array(drawing,1,32)}),
        &["label", "marks"],
    );
    let phase = object(
        json!({"at":at,"label":string(80),"caption":string(600),"quote":string(400)}),
        &["at", "label", "caption", "quote"],
    );
    [("cycle", 1), ("linkedViews", 2)].into_iter().map(|(kind, count)| {
        object(json!({
            "kind":{"type":"string","const":kind},"label":string(80),"unit":{"type":"string","maxLength":24},
            "period":{"type":"number","exclusiveMinimum":0,"maximum":1000000000}, "passage":string(12000),
            "phases":array(phase.clone(),2,12), "views":array(view.clone(),count,count)
        }), &["kind","label","unit","period","passage","phases","views"])
    }).collect()
}
