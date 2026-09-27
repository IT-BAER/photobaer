//! Manifest v5 and the node kinds of docs/M4.md section 1.

use super::m3_tests::{v4_fixture, load as load_v4};
use super::*;
use crate::path::{ArtboardBackground, Axis, Live};
use crate::resample::Interp;
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

// ---------- guides and grid (docs/M4.md section 12) ----------

fn guide_positions(d: &Document) -> Vec<f64> {
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    let mut out: Vec<f64> = v["guides"].as_array().unwrap().iter().map(|g| g["pos"].as_f64().unwrap()).collect();
    out.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out
}

#[test]
fn add_move_delete_and_lock_a_guide() {
    let mut d = Document::new(300, 300, 8).unwrap();
    let id = d.add_guide("x", 42.0, 0).unwrap();
    assert_eq!(id, 1);
    let second = d.add_guide("y", 10.0, 0).unwrap();
    assert_eq!(second, 2, "guide ids keep counting up");

    d.move_guide(id, 100.0).unwrap();
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    assert_eq!(v["guides"], json!([{ "id": 1, "axis": "x", "pos": 100.0 }, { "id": 2, "axis": "y", "pos": 10.0 }]));

    d.set_grid_and_locks(r#"{"guidesLocked":true}"#).unwrap();
    let e = d.move_guide(id, 5.0).unwrap_err();
    assert!(e.contains("locked"), "{e}");
    d.set_grid_and_locks(r#"{"guidesLocked":false}"#).unwrap();

    d.delete_guide(id).unwrap();
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    assert_eq!(v["guides"], json!([{ "id": 2, "axis": "y", "pos": 10.0 }]));
    assert!(d.delete_guide(id).unwrap_err().contains("unknown guide"));
}

#[test]
fn clear_guides_scopes_canvas_and_artboard_separately() {
    let mut d = Document::new(300, 300, 8).unwrap();
    let gid = d.add_group("Artboard 1", 0).unwrap();
    d.node_mut(gid).unwrap().artboard = Some(Artboard {
        rect: [0.0, 0.0, 50.0, 50.0],
        background: ArtboardBackground::None,
        preset_name: String::new(),
        guide_ids: Vec::new(),
    });
    d.add_guide("x", 5.0, 0).unwrap();
    let board_guide = d.add_guide("y", 5.0, gid).unwrap();
    assert_eq!(d.node(gid).unwrap().artboard.as_ref().unwrap().guide_ids, vec![board_guide]);

    d.clear_guides("canvas", 0).unwrap();
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    let guides = v["guides"].as_array().unwrap();
    assert_eq!(guides.len(), 1);
    assert_eq!(guides[0]["id"], board_guide);

    let more = d.add_guide("x", 6.0, 0).unwrap();
    d.clear_guides("artboard", gid).unwrap();
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    let guides = v["guides"].as_array().unwrap();
    assert_eq!(guides.len(), 1);
    assert_eq!(guides[0]["id"], more);
    assert!(d.node(gid).unwrap().artboard.as_ref().unwrap().guide_ids.is_empty());

    d.clear_guides("all", 0).unwrap();
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    assert_eq!(v["guides"], json!([]));
}

#[test]
fn new_guide_layout_places_column_and_row_guides() {
    let mut d = Document::new(1000, 500, 8).unwrap();
    let ids = d
        .new_guide_layout(r#"{"rect":[0,0,1000,500],"columns":3,"columnGutter":20,"rows":0,"rowGutter":20,"margins":null,"clearExisting":false,"artboard":0}"#)
        .unwrap();
    assert_eq!(ids.len(), 6, "3 columns without margins make 6 vertical guides, rows 0 adds none");
    assert_eq!(guide_positions(&d), vec![0.0, 320.0, 340.0, 660.0, 680.0, 1000.0]);

    // clear_existing replaces rather than accumulating.
    let ids2 = d
        .new_guide_layout(r#"{"rect":[0,0,1000,500],"columns":1,"columnGutter":0,"rows":0,"rowGutter":0,"margins":null,"clearExisting":true,"artboard":0}"#)
        .unwrap();
    assert_eq!(ids2.len(), 2);
    assert_eq!(guide_positions(&d), vec![0.0, 1000.0]);
}

#[test]
fn new_guide_layout_offsets_by_the_target_rect_origin() {
    // "guide relative to an artboard at x 200 lands at 200 + pos": exercised as a pure origin
    // offset (artboard targeting needs B18's artboard selection).
    let mut d = Document::new(2000, 500, 8).unwrap();
    let ids = d
        .new_guide_layout(r#"{"rect":[200,0,1000,500],"columns":1,"columnGutter":0,"rows":0,"rowGutter":0,"margins":null,"clearExisting":false,"artboard":0}"#)
        .unwrap();
    assert_eq!(ids.len(), 2);
    assert_eq!(guide_positions(&d), vec![200.0, 1200.0], "0 and 1000 relative to the rect land at 200 + pos");
}

#[test]
fn new_guides_from_shape_uses_the_union_of_content_bounds() {
    let mut d = Document::new(300, 300, 8).unwrap();
    let a = d.add_layer("a", 0).unwrap();
    let b = d.add_layer("b", 0).unwrap();
    d.select_rect(10.0, 10.0, 20.0, 20.0, Mode::New).unwrap();
    d.fill(a, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.deselect().unwrap();
    d.select_rect(50.0, 50.0, 10.0, 10.0, Mode::New).unwrap();
    d.fill(b, Target::Pixels, 0, 255, 0, 255).unwrap();
    d.deselect().unwrap();

    d.new_guides_from_shape(&[a, b]).unwrap();
    assert_eq!(guide_positions(&d), vec![10.0, 10.0, 60.0, 60.0]);

    assert!(d.new_guides_from_shape(&[]).unwrap_err().contains("at least one layer"));
    let empty = d.add_layer("empty", 0).unwrap();
    assert!(d.new_guides_from_shape(&[empty]).unwrap_err().contains("visible content"));
}

#[test]
fn add_special_adds_a_validated_shape_layer() {
    let mut d = Document::new(64, 64, 8).unwrap();
    let shape = json!({ "path": rect_path(1.0, 2.0, 30.0, 40.0), "live": null, "fill": { "type": "solid", "color": [1, 2, 3] }, "stroke": stroke() });
    let id = d.add_special(0, &json!({ "name": "s", "shape": shape }).to_string()).unwrap();
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    let n = v["layers"].as_array().unwrap().iter().find(|n| n["id"] == id).unwrap();
    assert_eq!(n["kind"], "shape");
    assert_eq!(norm(&n["shape"]), norm(&shape));
    let mut bad = shape.clone();
    bad["path"]["subpaths"][0]["points"][0][0] = json!(1e9);
    assert!(d.add_special(0, &json!({ "name": "s", "shape": bad }).to_string()).is_err());
    let two = json!({ "name": "s", "shape": shape, "content": { "type": "solid", "color": [0, 0, 0] } });
    assert!(d.add_special(0, &two.to_string()).is_err());
}

#[test]
fn set_vector_mask_validates_and_clears() {
    let mut d = Document::new(64, 64, 8).unwrap();
    let vm = json!({ "path": rect_path(1.0, 2.0, 30.0, 40.0), "enabled": true, "linked": false, "inverted": true, "density": 0.5, "feather": 4.0 });
    d.set_vector_mask(1, &vm.to_string()).unwrap();
    let v: Value = serde_json::from_str(&d.manifest()).unwrap();
    assert_eq!(norm(&v["layers"][0]["vector_mask"]), norm(&vm));
    let mut bad = vm.clone();
    bad["density"] = json!(1.5);
    assert!(d.set_vector_mask(1, &bad.to_string()).is_err());
    assert!(d.set_vector_mask(99, &vm.to_string()).is_err());
    d.set_vector_mask(1, "null").unwrap();
    assert!(d.node(1).unwrap().vector_mask.is_none());
}

#[test]
fn set_document_vector_and_set_artboard_check_guides_and_nesting() {
    let mut d = Document::new(64, 64, 8).unwrap();
    let doc = json!({
        "resolution": 300.0, "paths": [{ "id": 1, "name": "Path 1", "path": rect_path(0.0, 0.0, 4.0, 4.0), "work": false }],
        "guides": [{ "id": 3, "axis": "x", "pos": 100.5 }], "grid": { "spacing_x": 18.0, "spacing_y": 18.0 },
        "guides_locked": false, "artboards_locked": true
    });
    d.set_document_vector(&doc.to_string()).unwrap();
    assert_eq!(norm(&serde_json::from_str::<Value>(&d.vector_json()).unwrap()), norm(&doc));
    let mut bad = doc.clone();
    bad["resolution"] = json!(0.0);
    assert!(d.set_document_vector(&bad.to_string()).is_err());

    let g = d.add_group("Artboard 1", 0).unwrap();
    let inner = d.add_group("inner", 0).unwrap();
    d.move_node(inner, g, 0).unwrap();
    let board = json!({ "rect": [0.0, 0.0, 50.0, 50.0], "background": { "type": "white" }, "preset_name": "", "guide_ids": [3] });
    d.set_artboard(g, &board.to_string()).unwrap();
    assert_eq!(d.node(g).unwrap().artboard.as_ref().unwrap().guide_ids, vec![3]);
    assert!(d.set_artboard(inner, &board.to_string()).unwrap_err().contains("top-level group"));
    assert!(d.set_artboard(1, &board.to_string()).unwrap_err().contains("top-level group"));
    let mut unknown = board.clone();
    unknown["guide_ids"] = json!([9]);
    assert!(d.set_artboard(g, &unknown.to_string()).is_err());
    let mut no_guides = doc.clone();
    no_guides["guides"] = json!([]);
    assert!(d.set_document_vector(&no_guides.to_string()).is_err(), "the artboard still names guide 3");
    d.set_artboard(g, "null").unwrap();
    d.set_document_vector(&no_guides.to_string()).unwrap();
}

#[test]
fn canvas_ops_move_vector_data_with_the_canvas() {
    let mut d = load(&v5_fixture().to_string()).unwrap();
    let cache = d.layer_bounds(3).unwrap().unwrap();
    d.apply_crop([10.0, 20.0, 200.0, 200.0], false).unwrap();
    let moved = d.layer_bounds(3).unwrap().unwrap();
    assert_eq!(moved, [cache[0] - 10, cache[1] - 20, cache[2], cache[3]], "the text cache moves with the canvas");
    let Kind::Text(t) = &d.node(3).unwrap().kind else { panic!() };
    assert_eq!(t.data.transform, [1.0, 0.0, 0.0, 1.0, 10.0, 20.5]);

    // Clockwise on the 200 x 200 canvas: (x, y) -> (200 - y, x).
    d.rotate_canvas_exact(Remap::Cw).unwrap();
    let Kind::Shape(s) = &d.node(2).unwrap().kind else { panic!() };
    assert_eq!(s.path.subpaths[0].points[0], [210.0, 0.0, 210.0, 0.0, 210.0, 0.0]);
    assert_eq!(s.path.subpaths[1].points[0], [218.0, -8.5, 218.0, -9.5, 216.75, -7.5], "handles map too");
    assert_eq!(s.live, Some(Live::RoundedRectangle { bounds: [150.0, 0.0, 210.0, 100.0], radii: [5.0, 10.0, 15.0, 20.0] }));
    let Kind::Shape(l) = &d.node(10).unwrap().kind else { panic!() };
    assert_eq!(l.live, Some(Live::Line { start: [130.0, 0.0], end: [210.0, 80.0] }));
    assert_eq!(d.node(1).unwrap().vector_mask.as_ref().unwrap().path.subpaths[0].points[0][..2], [218.0, -9.0]);
    let Kind::Text(t) = &d.node(3).unwrap().kind else { panic!() };
    assert_eq!(t.data.transform, [0.0, 1.0, -1.0, 0.0, 179.5, 10.0]);
    assert_eq!(d.layer_bounds(3).unwrap().unwrap()[2..], [moved[3], moved[2]], "the cache turns with the canvas");
    assert_eq!(d.vector.paths[0].path.subpaths[0].points[0][..2], [220.0, -10.0]);
    let g: Vec<(Axis, f64)> = d.vector.guides.iter().map(|g| (g.axis, g.pos)).collect();
    assert_eq!(g, [(Axis::Y, 90.5), (Axis::X, 200.0)], "a vertical guide turns horizontal and back");
    assert_eq!(d.node(5).unwrap().artboard.as_ref().unwrap().rect, [170.0, -10.0, 220.0, 40.0]);

    // An arbitrary angle leaves guides alone (neither axis survives); paths still turn.
    let before = d.vector.guides.clone();
    d.rotate_canvas(30.0, Interp::Bilinear).unwrap();
    assert_eq!(d.vector.guides, before);
    let Kind::Shape(s) = &d.node(2).unwrap().kind else { panic!() };
    assert_ne!(s.path.subpaths[0].points[0], [210.0, 0.0, 210.0, 0.0, 210.0, 0.0]);

    // An axis-aligned perspective crop moves vector data like a plain crop.
    let mut p = load(&v5_fixture().to_string()).unwrap();
    p.perspective_crop(&[10.0, 20.0, 210.0, 20.0, 210.0, 220.0, 10.0, 220.0], 200, 200, Interp::Bilinear).unwrap();
    let Kind::Shape(s) = &p.node(2).unwrap().kind else { panic!() };
    assert_eq!(s.path.subpaths[0].points[0], [0.0, -10.0, 0.0, -10.0, 0.0, -10.0]);
    assert_eq!(p.layer_bounds(3).unwrap(), Some([0, 0, 200, 200]), "the text cache is warped and clipped like layer pixels");
}

// ---------- Paths panel ops (docs/M4.md section 4, B5) ----------

fn square(x0: f64, y0: f64, x1: f64, y1: f64) -> String {
    let p = |x: f64, y: f64| json!([x, y, x, y, x, y]);
    json!({ "fill_rule": "nonzero", "subpaths": [{ "closed": true, "op": "combine", "points": [p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1)] }] })
        .to_string()
}

fn path_names(d: &Document) -> Vec<(String, bool)> {
    d.vector.paths.iter().map(|p| (p.name.clone(), p.work)).collect()
}

#[test]
fn make_selection_from_a_rect_path_equals_the_rect_marquee() {
    let mut d = Document::new(40, 40, 8).unwrap();
    let wp = d.set_path("document", 0, &square(10.0, 10.0, 20.0, 20.0)).unwrap();
    d.make_selection_from_path("document", wp, Mode::New).unwrap();
    let from_path = d.selection_values();
    d.select_rect(10.0, 10.0, 10.0, 10.0, Mode::New).unwrap();
    assert_eq!(from_path, d.selection_values());
    d.set_path("document", 0, &square(15.0, 0.0, 30.0, 40.0)).unwrap();
    d.make_selection_from_path("document", wp, Mode::Intersect).unwrap();
    d.select_rect(15.0, 10.0, 5.0, 10.0, Mode::Subtract).unwrap();
    assert!(d.selection_values().iter().all(|&v| v == 0.0), "intersect keeps x 15..20");
}

#[test]
fn fill_path_on_an_empty_layer_equals_the_shape_render_and_keeps_the_selection() {
    let tri = json!({ "fill_rule": "nonzero", "subpaths": [{ "closed": true, "op": "combine",
        "points": [[5.5, 3.0, 5.5, 3.0, 5.5, 3.0], [30.0, 12.25, 30.0, 12.25, 30.0, 12.25], [8.0, 28.0, 20.0, 40.0, 8.0, 28.0]] }] })
    .to_string();
    let mut a = Document::new(40, 40, 8).unwrap();
    a.select_rect(0.0, 0.0, 2.0, 2.0, Mode::New).unwrap();
    let before = a.selection_values();
    let wp = a.set_path("document", 0, &tri).unwrap();
    a.fill_path("document", wp, 1, [200, 10, 30, 255]).unwrap();
    assert_eq!(a.selection_values(), before, "the selection is restored");
    let mut b = Document::new(40, 40, 8).unwrap();
    let shape = json!({ "path": serde_json::from_str::<Value>(&tri).unwrap(), "live": null, "fill": { "type": "solid", "color": [200, 10, 30] }, "stroke": null });
    b.add_special(0, &json!({ "name": "s", "shape": shape }).to_string()).unwrap();
    assert_eq!(a.flatten_tile_rgba8(0, 0).unwrap(), b.flatten_tile_rgba8(0, 0).unwrap());
    assert!(a.fill_path("document", wp, 99, [0, 0, 0, 255]).is_err());
}

#[test]
fn stroke_path_paints_a_centered_line_of_the_given_width() {
    let mut d = Document::new(40, 40, 8).unwrap();
    let line = json!({ "fill_rule": "nonzero", "subpaths": [{ "closed": false, "op": "combine",
        "points": [[5.0, 20.0, 5.0, 20.0, 5.0, 20.0], [35.0, 20.0, 35.0, 20.0, 35.0, 20.0]] }] })
    .to_string();
    let wp = d.set_path("document", 0, &line).unwrap();
    d.stroke_path("document", wp, 1, 2.0, [0, 0, 255, 255]).unwrap();
    let t = d.flatten_tile_rgba8(0, 0).unwrap();
    let a = |x: usize, y: usize| t[(y * TILE + x) * 4 + 3];
    assert_eq!((a(20, 19), a(20, 20), a(20, 18), a(20, 21)), (255, 255, 0, 0));
    assert!(d.stroke_path("document", wp, 1, 0.0, [0, 0, 0, 255]).is_err());
}

#[test]
fn saved_and_work_paths_follow_the_panel_rules() {
    let mut d = Document::new(40, 40, 8).unwrap();
    let p1 = d.new_path().unwrap();
    let wp = d.set_path("document", 0, &square(1.0, 1.0, 5.0, 5.0)).unwrap();
    assert_eq!(d.set_path("document", 0, &square(2.0, 2.0, 6.0, 6.0)).unwrap(), wp, "one work path, replaced");
    assert_eq!(path_names(&d), vec![("Path 1".into(), false), ("Work Path".into(), true)]);
    d.save_path(wp).unwrap();
    assert_eq!(path_names(&d)[1], ("Path 2".into(), false));
    assert!(d.save_path(wp).is_err());
    d.delete_path(p1).unwrap();
    let wp2 = d.set_path("document", 0, &square(1.0, 1.0, 5.0, 5.0)).unwrap();
    d.save_path(wp2).unwrap();
    assert_eq!(path_names(&d), vec![("Path 2".into(), false), ("Path 1".into(), false)], "lowest free N");
    d.rename_path(wp2, "Outline").unwrap();
    assert_eq!(path_names(&d)[1].0, "Outline");
    assert!(d.delete_path(999).is_err());
}

#[test]
fn set_path_role_vector_mask_edits_only_the_mask_path() {
    let mut d = Document::new(40, 40, 8).unwrap();
    let shape = json!({ "path": serde_json::from_str::<Value>(&square(1.0, 1.0, 9.0, 9.0)).unwrap(),
        "live": { "type": "rectangle", "bounds": [1.0, 1.0, 9.0, 9.0], "radii": [0.0, 0.0, 0.0, 0.0] },
        "fill": { "type": "solid", "color": [1, 2, 3] }, "stroke": null });
    let id = d.add_special(0, &json!({ "name": "s", "shape": shape }).to_string()).unwrap();
    let vm = json!({ "path": serde_json::from_str::<Value>(&square(0.0, 0.0, 4.0, 4.0)).unwrap(), "enabled": true, "linked": true, "inverted": false, "density": 1.0, "feather": 0.0 });
    d.set_vector_mask(id, &vm.to_string()).unwrap();
    let before = d.role_path("shape", id).unwrap().clone();
    d.set_path("vectorMask", id, &square(3.0, 3.0, 7.0, 7.0)).unwrap();
    assert_eq!(d.role_path("shape", id).unwrap(), &before);
    let Kind::Shape(s) = &d.node(id).unwrap().kind else { panic!() };
    assert!(s.live.is_some());
    assert_eq!(d.node(id).unwrap().vector_mask.as_ref().unwrap().path.subpaths[0].points[0][0], 3.0);
    d.set_path("shape", id, &square(2.0, 2.0, 8.0, 8.0)).unwrap();
    let Kind::Shape(s) = &d.node(id).unwrap().kind else { panic!() };
    assert!(s.live.is_none(), "an edited shape path drops live");
    assert!(d.set_path("vectorMask", 1, &square(0.0, 0.0, 1.0, 1.0)).is_err(), "layer 1 has no vector mask");
    assert!(d.set_path("shape", 1, &square(0.0, 0.0, 1.0, 1.0)).is_err());
    assert!(d.set_path("document", 42, &square(0.0, 0.0, 1.0, 1.0)).is_err());
}

#[test]
fn make_work_path_traces_the_selection_and_convert_makes_a_foreground_shape() {
    let mut d = Document::new(40, 40, 8).unwrap();
    assert!(d.make_work_path(2.0).is_err(), "no selection");
    d.select_rect(10.0, 10.0, 20.0, 20.0, Mode::New).unwrap();
    let wp = d.make_work_path(2.0).unwrap();
    let p = d.role_path("document", wp).unwrap().clone();
    assert_eq!((p.subpaths.len(), p.subpaths[0].points.len()), (1, 4));
    assert_eq!(d.make_work_path(50.0).unwrap(), wp, "replaces the work path");
    let id = d.convert_path_to_shape("document", wp, [9, 8, 7]).unwrap();
    let n = d.node(id).unwrap();
    assert_eq!(n.name, "Shape");
    let Kind::Shape(s) = &n.kind else { panic!() };
    assert_eq!(s.fill, Some(FillContent::Solid(crate::content::SolidFill { color: [9, 8, 7] })));
    assert_eq!(&s.path, d.role_path("document", wp).unwrap());
    let empty = d.new_path().unwrap();
    assert!(d.convert_path_to_shape("document", empty, [0, 0, 0]).is_err());
}

#[test]
fn a_traced_ring_keeps_its_hole_under_nonzero() {
    let mut d = Document::new(40, 40, 8).unwrap();
    d.select_rect(5.0, 5.0, 30.0, 30.0, Mode::New).unwrap();
    d.select_rect(15.0, 15.0, 10.0, 10.0, Mode::Subtract).unwrap();
    let ring = d.selection_values();
    let wp = d.make_work_path(2.0).unwrap();
    assert_eq!(d.role_path("document", wp).unwrap().fill_rule, crate::path::FillRule::Nonzero);
    d.make_selection_from_path("document", wp, Mode::New).unwrap();
    assert_eq!(d.selection_values(), ring);
}

// ---------- artboards (docs/M4.md section 11, B18) ----------

fn rect_of(d: &Document, id: u32) -> [f64; 4] {
    d.node(id).unwrap().artboard.as_ref().unwrap().rect
}

#[test]
fn new_artboards_place_right_of_the_last_and_grow_the_canvas() {
    let mut d = Document::new(64, 40, 8).unwrap();
    let a = d.new_artboard("Artboard 1", 64.0, 40.0, r#"{"type":"white"}"#, 0).unwrap();
    assert_eq!(rect_of(&d, a), [0.0, 0.0, 64.0, 40.0]);
    let b = d.new_artboard("Artboard 2", 30.0, 50.0, r#"{"type":"transparent"}"#, 0).unwrap();
    assert_eq!(rect_of(&d, b), [164.0, 0.0, 194.0, 50.0], "100 px right of the last one");
    assert_eq!((d.width, d.height), (194, 50));
    let c = d.new_artboard("Artboard 3", 10.0, 10.0, r#"{"type":"white"}"#, a).unwrap();
    assert_eq!(rect_of(&d, c)[0], 164.0, "right of the selected artboard");
    assert!(d.new_artboard("x", 0.0, 10.0, r#"{"type":"white"}"#, 0).is_err());
    assert!(d.new_artboard("x", 10.0, 10.0, r#"{"type":"white"}"#, 1).is_err(), "layer 1 is not an artboard");
}

#[test]
fn artboard_from_layers_wraps_them_with_their_bounds_and_nesting_is_refused() {
    let mut d = Document::new(64, 64, 8).unwrap();
    d.select_rect(10.0, 12.0, 20.0, 8.0, Mode::New).unwrap();
    d.fill_ex(1, Target::Pixels, &FillSource::Solid([255, 0, 0, 255]), PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    d.deselect().unwrap();
    let l2 = d.add_layer("b", 0).unwrap();
    d.select_rect(40.0, 30.0, 5.0, 5.0, Mode::New).unwrap();
    d.fill_ex(l2, Target::Pixels, &FillSource::Solid([0, 0, 255, 255]), PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    d.deselect().unwrap();
    let ab = d.artboard_from_layers(&[1, l2], "Board").unwrap();
    assert_eq!(rect_of(&d, ab), [10.0, 12.0, 45.0, 35.0]);
    assert_eq!(d.node(ab).unwrap().name, "Board");
    let g = d.add_group("g", 0).unwrap();
    assert!(d.move_node(ab, g, 0).unwrap_err().contains("nested"));
    assert!(d.group_nodes(&[ab]).unwrap_err().contains("nested"));
    let outer = d.group_nodes(&[g]).unwrap();
    let inner = d.add_group("inner", 0).unwrap();
    d.move_node(inner, outer, 0).unwrap();
    d.artboard_from_group(inner, "").unwrap();
    assert_eq!(d.find_path(inner).unwrap().len(), 1, "a nested group moves to the top level");
    assert_eq!(rect_of(&d, inner), [0.0, 0.0, 64.0, 64.0], "an empty group gets the canvas rect");
    assert!(d.artboard_from_group(ab, "").is_err(), "an artboard cannot hold an artboard");
}

#[test]
fn offset_artboard_moves_its_rect_and_guides_and_reparent_follows_the_layer_centre() {
    let mut d = Document::new(200, 100, 8).unwrap();
    let a = d.new_artboard("A", 50.0, 50.0, r#"{"type":"white"}"#, 0).unwrap();
    let g = d.add_guide("x", 20.0, a).unwrap();
    let canvas = d.add_guide("y", 5.0, 0).unwrap();
    d.offset_artboard(a, 10.0, 0.0).unwrap();
    assert_eq!(rect_of(&d, a), [10.0, 0.0, 60.0, 50.0]);
    let pos = |d: &Document, id: u32| d.vector.guides.iter().find(|x| x.id == id).unwrap().pos;
    assert_eq!((pos(&d, g), pos(&d, canvas)), (30.0, 5.0));

    d.select_rect(20.0, 20.0, 10.0, 10.0, Mode::New).unwrap();
    d.fill_ex(1, Target::Pixels, &FillSource::Solid([0, 0, 0, 255]), PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    d.deselect().unwrap();
    assert!(d.reparent_to_artboard(1).unwrap());
    assert_eq!(d.find_path(1).unwrap().len(), 2, "moved into A");
    assert!(!d.reparent_to_artboard(1).unwrap(), "already in A");
    d.offset_layer(1, 100, 0).unwrap();
    assert!(d.reparent_to_artboard(1).unwrap());
    assert_eq!(d.find_path(1).unwrap(), vec![d.nodes.len() - 1], "back to the root top");
}

// ---------- Shape tools and live shapes (docs/M4.md section 5, B7) ----------

fn shape_of(d: &Document, id: u32) -> crate::path::ShapeData {
    let Kind::Shape(s) = &d.node(id).unwrap().kind else { panic!("not a shape") };
    (**s).clone()
}

fn red() -> Value {
    json!({ "type": "solid", "color": [255, 0, 0] })
}

#[test]
fn new_shape_builds_the_path_from_live_on_top() {
    let mut d = Document::new(200, 200, 8).unwrap();
    let live = json!({ "type": "rectangle", "bounds": [10.0, 10.0, 110.0, 70.0], "radii": [0.0, 0.0, 0.0, 0.0] });
    let id = d.new_shape(&json!({ "name": "Rectangle", "live": live, "fill": red(), "stroke": null }).to_string()).unwrap();
    assert_eq!(d.nodes.last().unwrap().id, id, "on top");
    assert_eq!(d.node(id).unwrap().name, "Rectangle");
    let s = shape_of(&d, id);
    assert_eq!(crate::geom::bounds(&s.path), Some([10.0, 10.0, 110.0, 70.0]), "100 x 60");
    assert!(matches!(s.live, Some(Live::Rectangle { bounds: [10.0, 10.0, 110.0, 70.0], .. })));
    let star = json!({ "type": "polygon", "bounds": [0.0, 0.0, 100.0, 100.0], "sides": 6, "star_inset": 0.5, "radius": 0.0 });
    let p = d.new_shape(&json!({ "name": "Polygon", "live": star, "fill": red(), "stroke": null }).to_string()).unwrap();
    assert_eq!(shape_of(&d, p).path.subpaths[0].points.len(), 12, "6 sides star 50 % -> 12 anchors");
    let line = json!({ "type": "line", "start": [10.0, 20.0], "end": [90.0, 20.0] });
    let l = d.new_shape(&json!({ "name": "Line", "live": line, "fill": null, "stroke": null }).to_string()).unwrap();
    let lp = shape_of(&d, l).path;
    assert_eq!((lp.subpaths[0].closed, lp.subpaths[0].points.len()), (false, 2), "a line is an open segment");
    let custom = json!({ "type": "custom", "bounds": [0.0, 0.0, 1.0, 1.0] });
    assert!(d.new_shape(&json!({ "name": "Shape", "live": custom, "fill": red(), "stroke": null }).to_string()).is_err());
}

#[test]
fn set_shape_regenerates_the_path_only_when_live_changes() {
    let mut d = Document::new(200, 200, 8).unwrap();
    let live = json!({ "type": "rectangle", "bounds": [0.0, 0.0, 100.0, 60.0], "radii": [0.0, 0.0, 0.0, 0.0] });
    let id = d.new_shape(&json!({ "name": "Rectangle", "live": live, "fill": red(), "stroke": null }).to_string()).unwrap();
    let rounded = json!({ "type": "rectangle", "bounds": [0.0, 0.0, 100.0, 60.0], "radii": [20.0, 20.0, 20.0, 20.0] });
    d.set_shape(id, &json!({ "live": rounded, "fill": red(), "stroke": null }).to_string()).unwrap();
    assert_eq!(shape_of(&d, id).path.subpaths[0].points.len(), 8, "four rounded corners");
    // An imported path whose live is unchanged stays as it is.
    d.set_path("shape", id, &square(1.0, 1.0, 9.0, 9.0)).unwrap();
    let kept = shape_of(&d, id).path;
    let stroke = json!({ "enabled": true, "width": 3.0, "align": "outside", "cap": "butt", "join": "miter", "miter_limit": 4.0,
        "dash": [], "dash_offset": 0.0, "content": red(), "opacity": 1.0, "blend": "normal" });
    d.set_shape(id, &json!({ "live": null, "fill": null, "stroke": stroke }).to_string()).unwrap();
    let s = shape_of(&d, id);
    assert_eq!((s.path, s.fill.is_none(), s.stroke.unwrap().width), (kept, true, 3.0));
    assert!(d.set_shape(1, &json!({ "live": null, "fill": null, "stroke": null }).to_string()).is_err(), "not a shape layer");
}

#[test]
fn axis_aligned_transforms_keep_live_and_rotation_drops_it() {
    let mut d = Document::new(200, 200, 8).unwrap();
    let live = json!({ "type": "ellipse", "bounds": [10.0, 10.0, 50.0, 30.0] });
    let id = d.new_shape(&json!({ "name": "Ellipse", "live": live, "fill": red(), "stroke": null }).to_string()).unwrap();
    d.transform_layer(id, &[2.0, 0.0, -10.0, 0.0, 2.0, -10.0, 0.0, 0.0, 1.0], Interp::Bicubic).unwrap();
    let s = shape_of(&d, id);
    assert_eq!(s.live, Some(Live::Ellipse { bounds: [10.0, 10.0, 90.0, 50.0] }), "scale 200 % keeps live");
    assert_eq!(crate::geom::bounds(&s.path), Some([10.0, 10.0, 90.0, 50.0]));
    let (c, sn) = (10f64.to_radians().cos(), 10f64.to_radians().sin());
    d.transform_layer(id, &[c, -sn, 0.0, sn, c, 0.0, 0.0, 0.0, 1.0], Interp::Bicubic).unwrap();
    let s = shape_of(&d, id);
    assert!(s.live.is_none(), "rotate 10 degrees drops live");
    let p = s.path.subpaths[0].points[0];
    assert!((p[0] - (c * 50.0 - sn * 10.0)).abs() < 1e-9 && (p[1] - (sn * 50.0 + c * 10.0)).abs() < 1e-9, "the path is mapped");
}

#[test]
fn a_shape_transform_session_hides_the_shape_and_previews_its_render() {
    let mut d = Document::new(64, 64, 8).unwrap();
    let live = json!({ "type": "rectangle", "bounds": [8.0, 8.0, 24.0, 24.0], "radii": [0.0, 0.0, 0.0, 0.0] });
    let id = d.new_shape(&json!({ "name": "Rectangle", "live": live, "fill": red(), "stroke": null }).to_string()).unwrap();
    let id3 = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    let pv = d.transform_preview(id, &id3, 1.0, false, [8, 8, 16, 16]).unwrap();
    assert_eq!(&pv[0..4], &[255, 0, 0, 255], "the preview is the shape's render");
    d.clear_lifted(id, Target::Pixels).unwrap();
    assert!(shape_of(&d, id).path.subpaths.is_empty(), "lifted: the shape draws nothing");
}

#[test]
fn fill_shape_paints_fill_and_stroke_like_a_shape_layer() {
    let live = json!({ "type": "rectangle", "bounds": [5.0, 5.0, 25.5, 20.0], "radii": [0.0, 0.0, 0.0, 0.0] });
    let mut a = Document::new(40, 40, 8).unwrap();
    a.fill_shape(1, &json!({ "live": live, "fill": [255, 0, 0, 255], "stroke": { "width": 2.0, "color": [0, 0, 255, 255] } }).to_string()).unwrap();
    let mut b = Document::new(40, 40, 8).unwrap();
    let stroke = json!({ "enabled": true, "width": 2.0, "align": "center", "cap": "butt", "join": "miter", "miter_limit": 100.0,
        "dash": [], "dash_offset": 0.0, "content": { "type": "solid", "color": [0, 0, 255] }, "opacity": 1.0, "blend": "normal" });
    b.new_shape(&json!({ "name": "Rectangle", "live": live, "fill": red(), "stroke": stroke }).to_string()).unwrap();
    let (ta, tb) = (a.flatten_tile_rgba8(0, 0).unwrap(), b.flatten_tile_rgba8(0, 0).unwrap());
    assert!(ta.iter().zip(&tb).all(|(x, y)| x.abs_diff(*y) <= 1), "within 1/255 of the shape layer");
    assert!(a.fill_shape(99, &json!({ "live": live, "fill": [0, 0, 0, 255], "stroke": null }).to_string()).is_err());
}
