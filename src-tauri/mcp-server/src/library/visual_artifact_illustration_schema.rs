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
fn dynamics(id: &Value) -> (Value, Value) {
    let point = array(coord(), 2, 2);
    let angle = |max: i32| json!({"type":"number","minimum":-max,"maximum":max});
    let track = json!({"oneOf":[
        object(json!({"from":point,"to":point}),&["from","to"]),
        object(json!({"from":point,"pivot":point,"turn":angle(330)}),&["from","pivot","turn"])
    ]});
    let mut targets = array(id.clone(), 1, 28);
    targets["uniqueItems"] = json!(true);
    let range = array(level(), 2, 2);
    let effect = json!({"oneOf":[
        object(json!({"parts":targets,"move":array(angle(640),2,2)}), &["parts","move"]),
        object(json!({"parts":targets,"pivot":point,"turn":angle(720)}),&["parts","pivot","turn"]),
        object(json!({"parts":targets,"opacity":range}),&["parts","opacity"]),
        object(json!({"parts":targets,"level":range}),&["parts","level"])
    ]});
    let mut spec = object(
        json!({"label":string(80),"ends":array(string(64),2,2),"quote":string(400),"track":track,
        "initial":level(),"effects":array(effect.clone(),1,12)}),
        &["label", "ends", "quote", "track", "effects"],
    );
    spec["description"] = json!("A draggable point on a straight or circular track. Normalized travel, initially 0 unless specified. Supply an exact source quote. Translations add after a single rotation per part. Opacity or fill level set by independent controls or animation tracks multiply. Levels act on responsive glyphs or level rectangles.");
    let key = json!({"type":"array","minItems":2,"maxItems":2,"prefixItems":[{"type":"number","minimum":0,"maximum":60},level()]});
    let driven = object(
        json!({"keys":array(key.clone(),2,32),"handle":{"type":"integer","minimum":0,"maximum":3}}),
        &["keys", "handle"],
    );
    let affected = object(
        json!({"keys":array(key,2,32),"effects":array(effect,1,12)}),
        &["keys", "effects"],
    );
    let animated = json!({"oneOf":[affected,driven]});
    let mut animation = object(
        json!({"label":string(80),"quote":string(400),"duration":{"type":"number","minimum":0.5,"maximum":60},"loop":{"type":"boolean"},"tracks":array(animated,1,8)}),
        &["label", "quote", "duration", "tracks"],
    );
    animation["description"] = json!("An optional locally playable and scrubbable sequence. Keys are [seconds, normalized drive] with increasing times from zero to duration. Looping tracks return to their initial drive. Each track must change.");
    (array(spec, 1, 4), animation)
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
    let (handles, animation) = dynamics(&id);
    let mut schema = object(
        json!({"kind":{"const":"illustration"},"passage":string(12000),"view":{"type":"string","enum":["landscape","square","portrait"]},"parts":array(part,1,28),"states":states,"handles":handles,"animation":animation}),
        &["kind", "passage", "view", "parts"],
    );
    schema["description"]=json!("One composition in shared canvas coordinates: landscape 640 x 400, square 480 x 480, portrait 400 x 560. At least one selectable part. Every part needs shapes or icon; selectable parts need about and an exact quote from passage. Stage changes name unique existing parts. At most 520 shapes total.");
    schema
}
