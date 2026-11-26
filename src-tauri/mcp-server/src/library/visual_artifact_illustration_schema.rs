use super::visual_artifact::illustration::{GLYPHS, PAINTS, TONES};
use super::{array, json, object, string, Value};

fn coord() -> Value {
    json!({"type":"number","minimum":0,"maximum":640})
}
fn positive() -> Value {
    json!({"type":"number","exclusiveMinimum":0,"maximum":640})
}
fn level() -> Value {
    json!({"type":"number","minimum":0,"maximum":1})
}

pub(super) fn shape_definition() -> Value {
    let paint = json!({"type":"string","enum":PAINTS});
    let tag = |kind: &str, mut props: Value, keys: &[&str]| {
        props["type"] = json!({"const":kind});
        props["paint"] = paint.clone();
        let mut required = vec!["type", "paint"];
        required.extend_from_slice(keys);
        object(props, &required)
    };
    let points = |min| array(array(coord(), 2, 2), min, 80);
    json!({"oneOf":[
        tag("rect",json!({"x":coord(),"y":coord(),"w":positive(),"h":positive(),"r":coord()}),&["x","y","w","h"]),
        tag("circle",json!({"cx":coord(),"cy":coord(),"r":positive()}),&["cx","cy","r"]),
        tag("ellipse",json!({"cx":coord(),"cy":coord(),"rx":positive(),"ry":positive()}),&["cx","cy","rx","ry"]),
        tag("line",json!({"x1":coord(),"y1":coord(),"x2":coord(),"y2":coord()}),&["x1","y1","x2","y2"]),
        tag("polygon",json!({"points":points(3)}),&["points"]),tag("polyline",json!({"points":points(2)}),&["points"]),
        tag("path",json!({"d":{"type":"string","minLength":1,"maxLength":4000,"description":"Complete explicit absolute M/L/H/V/Q/C/A/Z commands, separated numbers; maximum 96 commands, bounded to the declared canvas."}}),&["d"])
    ]})
}
pub(super) fn definition() -> Value {
    let flag = json!({"type":"boolean"});
    let id = json!({"type":"string","pattern":"^[a-z][a-z0-9-]*$","minLength":1,"maxLength":40});
    let shapes = array(json!({"$ref":"#/$defs/illustrationShape"}), 1, 60);
    let icon = object(
        json!({"name":{"type":"string","enum":GLYPHS},"x":coord(),"y":coord(),"size":positive()}),
        &["name", "x", "y", "size"],
    );
    let part = object(
        json!({"id":id,"name":string(80),"tone":{"type":"string","enum":TONES},"selectable":flag,"about":string(600),"quote":string(400),"shapes":shapes,"icon":icon,"level":level(),"layer":{"type":"integer","minimum":-3,"maximum":3}}),
        &["id", "name", "tone", "selectable"],
    );
    let change = object(
        json!({"part":id,"shapes":shapes,"level":level(),"hidden":flag,"emphasis":flag}),
        &["part"],
    );
    let item = object(
        json!({"label":string(80),"caption":string(600),"changes":array(change,0,28)}),
        &["label", "caption", "changes"],
    );
    let states = object(
        json!({"label":string(80),"items":array(item,2,8)}),
        &["label", "items"],
    );
    let mut schema = object(
        json!({"kind":{"const":"illustration"},"passage":string(12000),"view":{"type":"string","enum":["landscape","square","portrait"]},"parts":array(part,1,28),"states":states}),
        &["kind", "passage", "view", "parts"],
    );
    schema["description"]=json!("One composition in shared canvas coordinates: landscape 640 x 400, square 480 x 480, portrait 400 x 560. At least one selectable part. Every part needs shapes or icon; selectable parts need about and an exact quote from passage. Stage changes name unique existing parts. At most 520 shapes total.");
    schema
}
