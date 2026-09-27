//! Manifest v5 and the node kinds of docs/M4.md section 1.

use super::m3_tests::{v4_fixture, load as load_v4};
use super::*;
use crate::path::Live;
use serde_json::{json, Value};

fn locks() -> Value {
    json!({ "transparency": false, "pixels": false, "position": false })
}

fn blending() -> Value {
    serde_json::to_value(Blending::default()).unwrap()
}

fn node(id: u32, name: &str, kind: &str) -> Value {
    json!({
        "id": id, "name": name, "kind": kind, "visible": true, "opacity": 1.0, "fill": 1.0, "blend": "normal",
        "clipping": false, "locks": locks(), "mask": null, "style": null, "blending": blending(),
        "vector_mask": null
    })
}

fn rect_path(x0: f64, y0: f64, x1: f64, y1: f64) -> Value {
    let p = |x: f64, y: f64| json!([x, y, x, y, x, y]);
    json!({
        "fill_rule": "nonzero",
        "subpaths": [
            { "closed": true, "op": "combine", "points": [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)] },
            { "closed": false, "op": "subtract", "points": [[1.5, 2.0, 0.5, 2.0, 2.5, 3.25], p(9.0, 9.0)] }
        ]
    })
}

fn run(length: u32, bold: bool) -> Value {
    json!({
        "length": length, "family": "Noto Sans", "style": if bold { "Bold" } else { "Regular" },
        "postscript_name": if bold { "NotoSans-Bold" } else { "NotoSans-Regular" }, "size": 24.0, "tracking": 50.0,
        "leading": if bold { json!(30.0) } else { Value::Null }, "color": [10, 20, 30], "faux_bold": bold,
        "faux_italic": false, "underline": true, "strikethrough": false, "caps": "small", "baseline": "super",
        "baseline_shift": 1.5, "horizontal_scale": 1.0, "vertical_scale": 0.9, "anti_alias": "crisp",
        "ligatures": true, "discretionary_ligatures": false, "kerning": "optical", "language": "en-US",
        "no_break": false, "tsume": 0.0, "features": { "salt": true, "swsh": false }
    })
}

fn paragraph(length: u32) -> Value {
    json!({
        "length": length, "alignment": "justify_left", "indent_left": 10.0, "indent_right": 0.0, "indent_first": 5.0,
        "space_before": 0.0, "space_after": 2.0, "hyphenate": false, "rtl": false, "composer": "every_line",
        "justification": { "word": [0.8, 1.0, 1.33], "letter": [0.0, 0.0, 0.0], "glyph": [1.0, 1.0, 1.0] },
        "hyphenation": { "min_word": 5, "after_first": 2, "before_last": 2, "limit": 2, "zone": 36.0, "capitalized": true },
        "hanging_punctuation": false
    })
}

pub(super) fn text(shape: Value) -> Value {
    json!({
        "text": "Hi\nthere",
        "runs": [run(3, false), run(5, true)],
        "paragraphs": [paragraph(3), paragraph(5)],
        "shape": shape,
        "orientation": "horizontal",
        "transform": [1.0, 0.0, 0.0, 1.0, 20.0, 40.5],
        "warp": { "style": "arc_lower", "bend": 0.5, "horizontal": -0.25, "vertical": 0.0, "axis": "horizontal" },
        "psd": { "antiAlias": "smooth", "unknown": [1, 2] }
    })
}

fn stroke() -> Value {
    json!({
        "enabled": true, "width": 3.0, "align": "outside", "cap": "round", "join": "bevel", "miter_limit": 4.0,
        "dash": [2.0, 1.0], "dash_offset": 0.5, "content": { "type": "solid", "color": [0, 0, 255] },
        "opacity": 0.75, "blend": "multiply"
    })
}

// Tile ids 1..=3: the text cache (RGBA), 4: the pixel layer (RGBA).
fn v5_fixture() -> Value {
    let mut bg = node(1, "bg", "pixel");
    bg["tiles"] = json!([[0, 0, 4]]);
    bg["vector_mask"] = json!({
        "path": rect_path(1.0, 2.0, 30.0, 40.0), "enabled": false, "linked": true, "inverted": true,
        "density": 0.5, "feather": 4.0
    });
    let mut shape = node(2, "Rectangle 1", "shape");
    shape["shape"] = json!({
        "path": rect_path(10.0, 10.0, 110.0, 70.0),
        "live": { "type": "roundedRectangle", "bounds": [10.0, 10.0, 110.0, 70.0], "radii": [5.0, 10.0, 15.0, 20.0] },
        "fill": { "type": "solid", "color": [255, 0, 0] },
        "stroke": stroke()
    });
    let mut txt = node(3, "Hi", "text");
    txt["tiles"] = json!([[0, 0, 1], [1, 0, 2], [-1, 2, 3]]);
    txt["text"] = text(json!({ "type": "paragraph", "box": [0.0, 0.0, 200.0, 50.0] }));
    let mut on_path = node(4, "path text", "text");
    on_path["text"] = text(json!({ "type": "onPath", "path": rect_path(0.0, 0.0, 5.0, 5.0), "start": 0.0, "end": 12.5, "flip": true }));
    on_path["text"]["warp"] = Value::Null;
    on_path["text"]["psd"] = Value::Null;
    on_path["text"]["orientation"] = "vertical".into();
    let mut star = node(6, "Polygon 1", "shape");
    star["shape"] = json!({
        "path": rect_path(0.0, 0.0, 1.0, 1.0),
        "live": { "type": "polygon", "bounds": [0.0, 0.0, 1.0, 1.0], "sides": 6, "star_inset": 0.5, "radius": 2.0 },
        "fill": null, "stroke": null
    });
    let mut in_shape = node(7, "in shape", "text");
    in_shape["text"] = text(json!({ "type": "inShape", "path": rect_path(0.0, 0.0, 50.0, 50.0) }));
    let mut point = node(8, "point", "text");
    point["text"] = text(json!({ "type": "point" }));
    let mut board = node(5, "Artboard 1", "group");
    board["blend"] = "pass through".into();
    board["artboard"] = json!({
        "rect": [0.0, 0.0, 50.0, 50.0], "background": { "type": "color", "color": [1, 2, 3] },
        "preset_name": "iPhone", "guide_ids": [2]
    });
    board["children"] = json!([star, in_shape, point]);
    let mut line = node(10, "Line 1", "shape");
    line["shape"] = json!({
        "path": rect_path(10.0, 88.0, 90.0, 92.0),
        "live": { "type": "line", "start": [10.0, 90.0], "end": [90.0, 10.0] },
        "fill": null, "stroke": stroke()
    });
    let mut plain = node(9, "g", "group");
    plain["blend"] = "pass through".into();
    plain["children"] = json!([]);
    json!({
        "format": "photobaer-manifest", "version": 5, "width": 256, "height": 256, "depth": 8,
        "tiles_x": 1, "tiles_y": 1, "next_id": 20, "next_node_id": 30,
        "layers": [bg, shape, txt, on_path, board, plain, line],
        "selection": null, "last_selection": null, "channels": [],
        "global_light": { "angle": 90.0, "altitude": 45.0 },
        "patterns": [], "layer_comps": [], "blobs": [],
        "resolution": 300.0,
        "paths": [
            { "id": 1, "name": "Path 1", "path": rect_path(0.0, 0.0, 4.0, 4.0), "work": false },
            { "id": 2, "name": "Work Path", "path": rect_path(1.0, 1.0, 3.0, 3.0), "work": true }
        ],
        "guides": [{ "id": 1, "axis": "x", "pos": 100.5 }, { "id": 2, "axis": "y", "pos": 20.0 }],
        "grid": { "spacing_x": 18.0, "spacing_y": 24.0 },
        "guides_locked": true,
        "artboards_locked": true
    })
}

fn tile(id: u64) -> Vec<u8> {
    vec![id as u8 * 30; TILE_BYTES_U8]
}

fn load(json: &str) -> Result<Document, String> {
    let mut d = Document::from_manifest(json)?;
    for id in 1..=4 {
        d.put_tile(id, &tile(id))?;
    }
    d.finish_load()?;
    Ok(d)
}

fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn rejects(f: impl Fn(&mut Value), what: &str) -> String {
    let mut v = v5_fixture();
    f(&mut v);
    match load(&v.to_string()) {
        Ok(_) => panic!("{what} must be rejected"),
        Err(e) => e,
    }
}

#[test]
fn v5_round_trip_of_every_new_field_is_byte_identical() {
    let d = load(&v5_fixture().to_string()).unwrap();
    let first = d.manifest();
    assert_eq!(norm(&serde_json::from_str(&first).unwrap()), norm(&v5_fixture()), "no field is dropped or changed");
    let again = load(&first).unwrap();
    assert_eq!(again.manifest(), first, "write -> read -> write is byte identical");
    for id in 1..=3 {
        assert_eq!(again.tile_bytes(id).unwrap(), tile(id), "text cache tile {id}");
    }
    let Kind::Shape(line) = &again.node(10).unwrap().kind else { panic!("node 10 is a shape") };
    assert_eq!(line.live, Some(Live::Line { start: [10.0, 90.0], end: [90.0, 10.0] }), "the line runs bottom-left to top-right");
    again.flatten_tile_rgba8(0, 0).unwrap();
    again.display_program(0, 0, 0, &[]).unwrap();
}

#[test]
fn v4_documents_open_with_the_m4_defaults() {
    let d = load_v4(&v4_fixture().to_string()).unwrap();
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    assert_eq!(v["version"], 5);
    assert_eq!(v["resolution"], 72.0);
    assert_eq!(v["paths"], json!([]));
    assert_eq!(v["guides"], json!([]));
    assert_eq!(v["grid"], json!({ "spacing_x": 100.0, "spacing_y": 100.0 }));
    assert_eq!((v["guides_locked"].clone(), v["artboards_locked"].clone()), (json!(false), json!(false)));
    assert_eq!(v["layers"][0]["vector_mask"], Value::Null);
    assert!(v["layers"][5].get("artboard").is_none(), "a plain group writes no artboard");
}

#[test]
fn v5_rejections() {
    let e = rejects(|v| v["layers"][2]["text"]["runs"][0]["weight"] = 700.into(), "an unknown run key");
    assert!(e.contains("weight"), "{e}");
    rejects(|v| v["layers"][2]["text"]["paragraphs"][0]["columns"] = 2.into(), "an unknown paragraph key");
    let e = rejects(|v| v["layers"][1]["shape"]["live"]["type"] = "heart".into(), "an unknown live type");
    assert!(e.contains("heart"), "{e}");
    let e = rejects(|v| v["layers"][1]["shape"]["path"]["subpaths"][0]["points"][0][0] = 1e8.into(), "a coordinate beyond 1e7");
    assert!(e.contains("path coordinate"), "{e}");
    let e = rejects(|v| v["paths"][0]["work"] = true.into(), "two work paths");
    assert!(e.contains("work path"), "{e}");
    rejects(|v| v["paths"][1]["id"] = 1.into(), "duplicate path ids");
    rejects(|v| v["guides"][1]["id"] = 1.into(), "duplicate guide ids");
    rejects(|v| v["guides"][0]["pos"] = json!(f64::NAN), "a missing guide position");
    rejects(|v| v["layers"][4]["artboard"]["guide_ids"] = json!([9]), "an artboard naming an unknown guide");
    rejects(|v| v["layers"][0]["artboard"] = v["layers"][4]["artboard"].clone(), "an artboard on a pixel layer");
    rejects(
        |v| {
            let board = v["layers"][4].clone();
            v["layers"][5]["children"] = json!([board]);
            v["layers"][5]["children"][0]["id"] = 40.into();
            v["next_node_id"] = 41.into();
        },
        "a nested artboard",
    );
    rejects(|v| v["layers"][2]["text"]["runs"][1]["length"] = 4.into(), "runs not covering the text");
    rejects(|v| v["layers"][2]["text"]["paragraphs"][0]["length"] = 2.into(), "paragraphs not covering the text");
    rejects(|v| v["layers"][2]["text"]["cache"] = json!([]), "a cache key inside text");
    rejects(|v| v["layers"][0]["vector_mask"]["density"] = 1.5.into(), "a density above 1");
    rejects(|v| v["layers"][0]["vector_mask"]["feather"] = json!(-1.0), "a negative feather");
    rejects(|v| v["layers"][1]["shape"]["live"] = json!({ "type": "polygon", "bounds": [0.0, 0.0, 1.0, 1.0], "sides": 2, "star_inset": 0.0, "radius": 0.0 }), "a 2-sided polygon");
    rejects(|v| v["layers"][1]["shape"]["stroke"]["dash"] = json!([-1.0]), "a negative dash");
    rejects(|v| v["layers"][1]["shape"]["stroke"]["content"] = json!({ "type": "pattern", "pattern_id": "nope", "scale": 1.0, "angle": 0.0, "linked": true, "offset": [0.0, 0.0] }), "an unknown stroke pattern");
    rejects(|v| v["layers"][1]["shape"]["path"]["subpaths"][0]["points"][0] = json!([1.0, 2.0, 3.0]), "a 3-number point");
    rejects(|v| v["layers"][1]["tiles"] = json!([]), "tiles on a shape layer");
    rejects(|v| v["layers"][1]["shape"] = Value::Null, "a shape layer without shape");
    rejects(|v| v["layers"][2]["shape"] = v["layers"][1]["shape"].clone(), "shape data on a text layer");
    rejects(|v| v["resolution"] = 0.into(), "resolution 0");
    rejects(|v| v["grid"]["spacing_x"] = 0.into(), "grid spacing 0");
    rejects(|v| { v.as_object_mut().unwrap().remove("guides"); }, "a v5 file without guides");
    let e = rejects(
        |v| {
            let vm = v5_fixture()["layers"][0]["vector_mask"].clone();
            *v = v4_fixture();
            v["layers"][0]["vector_mask"] = vm;
        },
        "a vector mask in v4",
    );
    assert!(e.contains("v5"), "{e}");
    rejects(|v| { *v = v4_fixture(); v["resolution"] = 72.into(); }, "resolution in v4");
}

#[test]
fn paint_fill_filters_and_adjustments_refuse_shape_and_text_layers() {
    let d = load(&v5_fixture().to_string()).unwrap();
    for (id, kind) in [(2, "shape layer"), (3, "text layer")] {
        let mut d = d.clone();
        let errs = [
            d.fill(id, Target::Pixels, 1, 2, 3, 255).unwrap_err(),
            d.apply_adjustment(id, Target::Pixels, r#"{"kind":"invert","params":{}}"#).unwrap_err(),
            d.apply_destructive(id, r#"{"kind":"gaussian_blur","params":{"radius":2.0}}"#).unwrap_err(),
            d.invert(id, Target::Pixels).unwrap_err(),
            d.set_tile_rgba8(id, 0, 0, &tile(1)).unwrap_err(),
        ];
        for e in errs {
            assert!(e.contains(kind) && e.contains("rasterized"), "{e} names the {kind}");
        }
        let mut e = EngineCore::new(d);
        let err = e.stroke_begin(id, "pixels", "{}").unwrap_err();
        assert_eq!(err, format!("This {kind} must be rasterized before its pixels can be edited."));
    }
}

#[test]
fn offset_moves_shape_paths_and_text_transform_and_cache() {
    let mut d = load(&v5_fixture().to_string()).unwrap();
    let before = d.clone();
    d.offset_layer(2, 10, 5).unwrap();
    let (Kind::Shape(a), Kind::Shape(b)) = (&before.node(2).unwrap().kind, &d.node(2).unwrap().kind) else { panic!() };
    for (sa, sb) in a.path.subpaths.iter().zip(&b.path.subpaths) {
        for (pa, pb) in sa.points.iter().zip(&sb.points) {
            let want: Vec<f64> = pa.iter().enumerate().map(|(i, v)| v + if i % 2 == 0 { 10.0 } else { 5.0 }).collect();
            assert_eq!(pb.to_vec(), want, "anchor and both handles move by (10, 5)");
        }
    }
    assert_eq!(b.live, Some(Live::RoundedRectangle { bounds: [20.0, 15.0, 120.0, 75.0], radii: [5.0, 10.0, 15.0, 20.0] }));
    d.offset_layer(10, 10, 5).unwrap();
    let Kind::Shape(l) = &d.node(10).unwrap().kind else { panic!() };
    assert_eq!(l.live, Some(Live::Line { start: [20.0, 95.0], end: [100.0, 15.0] }));

    let bounds = d.layer_bounds(3).unwrap().unwrap();
    d.offset_layer(3, 10, 5).unwrap();
    let Kind::Text(t) = &d.node(3).unwrap().kind else { panic!() };
    assert_eq!(t.data.transform, [1.0, 0.0, 0.0, 1.0, 30.0, 45.5]);
    let moved = d.layer_bounds(3).unwrap().unwrap();
    assert_eq!([moved[0] - bounds[0], moved[1] - bounds[1], moved[2], moved[3]], [10, 5, bounds[2], bounds[3]], "the cache moves with it");

    d.offset_layer(1, 10, 5).unwrap();
    let vm = d.node(1).unwrap().vector_mask.clone().unwrap();
    assert_eq!(vm.path.subpaths[0].points[0], [11.0, 7.0, 11.0, 7.0, 11.0, 7.0], "a linked vector mask moves with its layer");

    d.set_props(2, r#"{"locks":{"position":true}}"#).unwrap();
    assert!(d.offset_layer(2, 1, 1).unwrap_err().contains("locked"));
}
