//! Manifest v4 and the node kinds of docs/M3.md section 1.

use super::*;
use crate::resample::Interp;
use serde_json::{json, Value};

fn contour() -> Value {
    json!({ "name": "Linear", "points": [[0.0, 0.0], [255.0, 255.0]], "mode": "point", "anti_alias": false })
}

fn gradient_def() -> Value {
    json!({
        "method": "perceptual",
        "color_stops": [
            { "position": 0.0, "color": [0, 0, 0], "midpoint": 0.5 },
            { "position": 1.0, "color": [255, 255, 255], "midpoint": 0.5 }
        ],
        "opacity_stops": [
            { "position": 0.0, "opacity": 1.0, "midpoint": 0.5 },
            { "position": 1.0, "opacity": 0.5, "midpoint": 0.25 }
        ]
    })
}

fn gradient_fill() -> Value {
    json!({
        "gradient": gradient_def(), "style": "radial", "angle": 90.0, "scale": 1.5, "reverse": true,
        "dither": true, "align_with_layer": false, "offset": [3.0, -2.0]
    })
}

fn pattern_fill(id: &str) -> Value {
    json!({ "pattern_id": id, "scale": 2.0, "angle": 15.0, "linked": false, "offset": [1.0, 2.0] })
}

fn shadow(knocks_out: bool) -> Value {
    json!({
        "present": true, "enabled": true, "blend": "multiply", "opacity": 0.75, "color": [0, 0, 0],
        "use_global_light": true, "angle": 120.0, "distance": 5.0, "spread": 0.25, "size": 5.0,
        "contour": contour(), "noise": 0.5, "knocks_out": knocks_out
    })
}

fn glow(source: &str, fill: Value) -> Value {
    json!({
        "present": true, "enabled": false, "blend": "screen", "opacity": 0.75, "fill": fill,
        "technique": "precise", "spread": 0.0, "size": 5.0, "range": 0.5, "jitter": 0.25, "noise": 0.0,
        "contour": contour(), "source": source
    })
}

/// A style using every effect, list and field.
fn full_style(pattern: &str) -> Value {
    let mut solid_stroke = json!({
        "present": true, "enabled": true, "size": 3.0, "position": "outside", "blend": "normal",
        "opacity": 1.0, "overprint": false, "fill": { "type": "solid", "color": [0, 0, 0] }
    });
    let mut gradient_stroke = solid_stroke.clone();
    gradient_stroke["position"] = "center".into();
    let mut g = gradient_fill();
    g["type"] = "gradient".into();
    gradient_stroke["fill"] = g;
    let mut pattern_stroke = solid_stroke.clone();
    pattern_stroke["position"] = "inside".into();
    let mut p = pattern_fill(pattern);
    p["type"] = "pattern".into();
    pattern_stroke["fill"] = p;
    solid_stroke["overprint"] = true.into();
    json!({
        "enabled": true, "scale": 2.0,
        "drop_shadows": [shadow(true), shadow(false)],
        "inner_shadows": [shadow(false)],
        "color_overlays": [{ "present": true, "enabled": true, "blend": "normal", "opacity": 1.0, "color": [128, 128, 128] }],
        "gradient_overlays": [{ "present": true, "enabled": true, "blend": "overlay", "opacity": 0.5, "gradient": gradient_fill() }],
        "pattern_overlays": [{ "present": false, "enabled": true, "blend": "normal", "opacity": 1.0, "pattern": pattern_fill(pattern) }],
        "strokes": [solid_stroke, gradient_stroke, pattern_stroke],
        "outer_glow": glow("edge", json!({ "type": "color", "color": [255, 255, 190] })),
        "inner_glow": glow("center", json!({ "type": "gradient", "gradient": gradient_def() })),
        "bevel": {
            "present": true, "enabled": true, "style": "stroke_emboss", "technique": "chisel_soft", "depth": 1.0,
            "direction": "down", "size": 5.0, "soften": 2.0, "use_global_light": false, "angle": 60.0,
            "altitude": 30.0, "gloss_contour": contour(), "highlight_blend": "screen",
            "highlight_color": [255, 255, 255], "highlight_opacity": 0.75, "shadow_blend": "multiply",
            "shadow_color": [0, 0, 0], "shadow_opacity": 0.75
        },
        "contour": { "present": true, "enabled": true, "contour": { "name": "Steps", "points": [[0.0, 0.0], [128.0, 64.0], [255.0, 255.0]], "mode": "pencil", "anti_alias": true }, "range": 1.0 },
        "texture": { "present": true, "enabled": false, "pattern_id": pattern, "scale": 1.0, "depth": -2.5, "invert": true, "linked": true, "offset": [0.0, 0.0] },
        "satin": {
            "present": true, "enabled": true, "blend": "multiply", "opacity": 0.5, "color": [0, 0, 0],
            "angle": 19.0, "distance": 11.0, "size": 14.0, "contour": contour(), "invert": true
        }
    })
}

fn levels_record(gamma: f64) -> Value {
    json!({ "input_black": 20, "input_white": 235, "gamma": gamma, "output_black": 0, "output_white": 255 })
}

/// The 16 adjustment kinds with non-default params.
fn adjustments() -> Vec<Value> {
    let hue_range = |a: f64| json!({ "bands": [a, a + 30.0, a + 60.0, a + 90.0], "hue": 10.0, "saturation": -5.0, "lightness": 0.0 });
    vec![
        json!({ "kind": "brightness_contrast", "params": { "brightness": 100.0, "contrast": -50.0, "legacy": true } }),
        json!({ "kind": "levels", "params": { "composite": levels_record(1.5), "red": levels_record(2.0), "green": null, "blue": null } }),
        json!({ "kind": "curves", "params": { "mode": "pencil", "composite": [[0, 0], [128, 160], [255, 255]], "red": null, "green": [[0, 10], [255, 245]], "blue": null } }),
        json!({ "kind": "exposure", "params": { "exposure": 1.0, "offset": -0.25, "gamma": 1.5 } }),
        json!({ "kind": "vibrance", "params": { "vibrance": 30.0, "saturation": -10.0 } }),
        json!({ "kind": "hue_saturation", "params": {
            "master": { "hue": 180.0, "saturation": 0.0, "lightness": 0.0 },
            "ranges": [hue_range(315.0), hue_range(15.0), hue_range(75.0), hue_range(135.0), hue_range(195.0), hue_range(255.0)],
            "colorize": true, "colorize_values": { "hue": 0.0, "saturation": 25.0, "lightness": 0.0 }
        } }),
        json!({ "kind": "color_balance", "params": { "shadows": [0.0, 0.0, 0.0], "midtones": [50.0, 0.0, -20.0], "highlights": [0.0, 10.0, 0.0], "preserve_luminosity": false } }),
        json!({ "kind": "black_white", "params": { "reds": 40.0, "yellows": 60.0, "greens": 40.0, "cyans": 60.0, "blues": 20.0, "magentas": 80.0, "tint": true, "tint_color": [206, 185, 155] } }),
        json!({ "kind": "photo_filter", "params": { "color": [236, 138, 0], "density": 25.0, "preserve_luminosity": true } }),
        json!({ "kind": "channel_mixer", "params": { "red": [100.0, 0.0, 0.0, 0.0], "green": [0.0, 100.0, 0.0, 0.0], "blue": [0.0, 0.0, 100.0, 0.0], "gray": [40.0, 40.0, 20.0, 0.0], "monochrome": true } }),
        json!({ "kind": "color_lookup", "params": { "name": "warm.cube", "format": "cube", "table": 12, "interpolation": "trilinear", "dither": true } }),
        json!({ "kind": "invert", "params": {} }),
        json!({ "kind": "posterize", "params": { "levels": 4 } }),
        json!({ "kind": "threshold", "params": { "level": 128 } }),
        json!({ "kind": "gradient_map", "params": { "gradient": gradient_def(), "reverse": false, "dither": true } }),
        json!({ "kind": "selective_color", "params": {
            "mode": "absolute", "reds": [10.0, 0.0, 0.0, 0.0], "yellows": [0.0, 0.0, 0.0, 0.0], "greens": [0.0, 0.0, 0.0, 0.0], "cyans": [0.0, 0.0, 0.0, 0.0],
            "blues": [0.0, 0.0, 0.0, 0.0], "magentas": [0.0, 0.0, 0.0, 0.0], "whites": [0.0, 0.0, 0.0, 0.0], "neutrals": [0.0, 0.0, 0.0, -5.0], "blacks": [0.0, 0.0, 0.0, 0.0]
        } }),
    ]
}

fn locks() -> Value {
    json!({ "transparency": false, "pixels": false, "position": false })
}

fn blending() -> Value {
    json!({
        "blend_if": {
            "gray": { "source": [0, 128, 255, 255], "destination": [0, 0, 200, 230] },
            "red": { "source": [0, 0, 255, 255], "destination": [0, 0, 255, 255] },
            "green": { "source": [10, 20, 255, 255], "destination": [0, 0, 255, 255] },
            "blue": { "source": [0, 0, 255, 255], "destination": [0, 0, 250, 255] }
        },
        "channels": [true, false, true], "knockout": "shallow", "blend_interior": true, "blend_clipped": false,
        "transparency_shapes": false, "layer_mask_hides_effects": true, "vector_mask_hides_effects": true
    })
}

fn node(id: u32, name: &str, kind: &str) -> Value {
    json!({
        "id": id, "name": name, "kind": kind, "visible": true, "opacity": 1.0, "fill": 1.0, "blend": "normal",
        "clipping": false, "locks": locks(), "mask": null, "style": null, "blending": blending()
    })
}

fn mask(tile: u64) -> Value {
    json!({ "enabled": true, "default": 255, "tiles": [[0, 0, tile]] })
}

// Tile ids: 1 bg, 2 adjustment mask, 3 smart cache, 4 smart source, 5 filter mask, 6 stack mask.
// Blob ids: 10 smart source bytes, 11 filter LUT, 12 layer LUT, 13 pattern pixels.
const RGBA_TILES: [u64; 3] = [1, 3, 4];
const MASK_TILES: [u64; 3] = [2, 5, 6];

fn blob(id: u64) -> Vec<u8> {
    match id {
        10 => vec![1, 2, 3],
        13 => vec![9, 8, 7, 255],
        _ => format!("LUT_3D_SIZE 2 # {id}").into_bytes(),
    }
}

/// A v4 manifest using every new field.
pub(super) fn v4_fixture() -> Value {
    let mut bg = node(1, "bg", "pixel");
    bg["tiles"] = json!([[0, 0, 1]]);
    bg["style"] = full_style("p1");
    let mut adj = node(2, "Levels", "adjustment");
    adj["mask"] = mask(2);
    adj["opacity"] = 0.5.into();
    adj["blend"] = "multiply".into();
    adj["adjustment"] = adjustments()[1].clone();
    let mut fill = node(3, "Pattern Fill", "fill");
    fill["content"] = json!({ "type": "pattern", "pattern_id": "p1", "scale": 1.0, "angle": 0.0, "linked": true, "offset": [0.0, 0.0] });
    fill["style"] = full_style("p1");
    fill["clipping"] = true.into();
    let mut smart = node(4, "Smart", "smart");
    smart["tiles"] = json!([[0, 0, 3]]);
    smart["style"] = json!({
        "enabled": false, "scale": 1.0, "drop_shadows": [], "inner_shadows": [], "color_overlays": [],
        "gradient_overlays": [], "pattern_overlays": [], "strokes": [], "outer_glow": null, "inner_glow": null,
        "bevel": null, "contour": null, "texture": null, "satin": null
    });
    let points: Vec<Value> = (0..16).map(|i| json!([(i % 4) as f64 * 10.0, (i / 4) as f64 * 10.0])).collect();
    smart["smart"] = json!({
        "link": { "type": "embedded", "id": "a1b2" },
        "source": { "blob": 10, "tiles": [[0, 0, 4]] },
        "source_size": [100, 50],
        "transform": [1.0, 0.0, 5.0, 0.0, 1.0, 7.0, 0.0, 0.0, 1.0],
        "warp": { "cols": 1, "rows": 1, "points": points, "column_stops": [0.0, 1.0], "row_stops": [0.0, 1.0] },
        "filters": [
            { "id": 1, "filter": { "kind": "color_lookup", "params": { "name": "cool.3dl", "format": "3dl", "table": 11, "interpolation": "tetrahedral", "dither": false } },
              "enabled": true, "opacity": 0.5, "blend": "screen", "mask": mask(5) },
            { "id": 2, "filter": { "kind": "gaussian_blur", "params": { "radius": 2.5 } },
              "enabled": false, "opacity": 1.0, "blend": "normal", "mask": null }
        ],
        "stack_mask": mask(6),
        "stack_mode": "median"
    });
    let mut linked = node(5, "Linked", "smart");
    linked["tiles"] = json!([]);
    linked["smart"] = json!({
        "link": { "type": "linked", "name": "photo.psd", "handle": "h-1" },
        "source": { "blob": null, "tiles": [] },
        "source_size": [1, 1],
        "transform": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        "warp": null, "filters": [], "stack_mask": null, "stack_mode": null
    });
    let mut group = node(6, "g", "group");
    group["blend"] = "pass through".into();
    let mut children: Vec<Value> = adjustments()
        .into_iter()
        .enumerate()
        .map(|(i, a)| {
            let mut n = node(10 + i as u32, "adj", "adjustment");
            n["adjustment"] = a;
            n
        })
        .collect();
    let mut solid = node(7, "Color Fill", "fill");
    solid["content"] = json!({ "type": "solid", "color": [255, 0, 0] });
    let mut grad = node(8, "Gradient Fill", "fill");
    let mut g = gradient_fill();
    g["type"] = "gradient".into();
    grad["content"] = g;
    children.push(solid);
    children.push(grad);
    group["children"] = Value::Array(children);
    json!({
        "format": "photobaer-manifest", "version": 4, "width": 256, "height": 256, "depth": 8,
        "tiles_x": 1, "tiles_y": 1, "next_id": 20, "next_node_id": 30,
        "layers": [bg, adj, fill, smart, linked, group],
        "selection": null, "last_selection": null, "channels": [],
        "global_light": { "angle": 90.0, "altitude": 45.0 },
        "patterns": [{ "id": "p1", "name": "Dots", "width": 1, "height": 1, "blob": 13 }],
        "layer_comps": [{
            "id": 1, "name": "Layer Comp 1", "comment": "", "apply_visibility": true, "apply_position": true,
            "apply_appearance": false,
            "layers": [
                { "id": 1, "visible": false, "position": [0, 0], "opacity": 0.5, "fill": 1.0, "blend": "screen", "style": full_style("p1") },
                { "id": 2, "visible": true, "position": null, "opacity": 1.0, "fill": 0.25, "blend": "normal", "style": null }
            ]
        }],
        "blobs": [10, 11, 12, 13]
    })
}

fn tile(id: u64) -> Vec<u8> {
    if MASK_TILES.contains(&id) {
        vec![200u8; MASK_BYTES_U8]
    } else {
        vec![id as u8 * 40; TILE_BYTES_U8]
    }
}

pub(super) fn load(json: &str) -> Result<Document, String> {
    let mut d = Document::from_manifest(json)?;
    for id in RGBA_TILES.iter().chain(MASK_TILES.iter()) {
        d.put_tile(*id, &tile(*id))?;
    }
    for id in [10, 11, 12, 13] {
        d.put_tile(id, &blob(id))?;
    }
    d.finish_load()?;
    Ok(d)
}

// Every number as f64, so an integer-valued float compares equal to its integer spelling.
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn fixture_doc() -> Document {
    load(&v4_fixture().to_string()).unwrap()
}

fn rejects(f: impl Fn(&mut Value), what: &str) -> String {
    let mut v = v4_fixture();
    f(&mut v);
    match load(&v.to_string()) {
        Ok(_) => panic!("{what} must be rejected"),
        Err(e) => e,
    }
}

#[test]
fn v4_round_trip_of_every_new_field_is_byte_identical() {
    let d = fixture_doc();
    let first = d.manifest();
    let v5 = |v: &mut Value| {
        fn add_vector_mask(nodes: &mut Value) {
            for n in nodes.as_array_mut().unwrap() {
                n["vector_mask"] = Value::Null;
                if let Some(ch) = n.get_mut("children") {
                    add_vector_mask(ch);
                }
            }
        }
        add_vector_mask(&mut v["layers"]);
        v["version"] = 6.into();
        let extra = json!({ "resolution": 72.0, "paths": [], "guides": [], "grid": { "spacing_x": 100.0, "spacing_y": 100.0 },
            "guides_locked": false, "artboards_locked": false });
        v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    };
    let mut expected = v4_fixture();
    v5(&mut expected);
    assert_eq!(norm(&serde_json::from_str(&first).unwrap()), norm(&expected), "no field is dropped or changed");
    let again = load(&first).unwrap();
    assert_eq!(again.manifest(), first, "write -> read -> write is byte identical");
    assert_eq!(again.tile_bytes(10).unwrap(), vec![1, 2, 3], "a 3-byte blob keeps its bytes");
    assert_eq!(again.tile_bytes(3).unwrap(), tile(3), "the smart cache tile");
    assert_eq!(again.tile_bytes(4).unwrap(), tile(4), "the smart source tile");
    assert_eq!(again.tile_bytes(5).unwrap(), tile(5), "the filter mask tile");
    assert_eq!(again.tile_bytes(6).unwrap(), tile(6), "the stack mask tile");
    // Nodes without pixels composite as nothing until the compositor learns them.
    again.flatten_tile_rgba8(0, 0).unwrap();
    again.display_program(0, 0, 0, &[]).unwrap();
}

#[test]
fn a_duplicated_node_keeps_its_new_fields() {
    let mut d = fixture_doc();
    let copy = d.duplicate_node(3).unwrap();
    let (a, b) = (d.node(3).unwrap(), d.node(copy).unwrap());
    assert_eq!(a.style, b.style);
    assert_eq!(a.blending, b.blending);
    assert!(matches!((&a.kind, &b.kind), (Kind::Fill(x), Kind::Fill(y)) if x == y));
}

#[test]
fn v1_to_v3_documents_get_the_m3_defaults() {
    let mut old = Document::new(256, 256, 8).unwrap();
    old.fill(1, Target::Pixels, 1, 2, 3, 255).unwrap();
    let mut v: Value = serde_json::from_str(&old.manifest()).unwrap();
    v["version"] = 3.into();
    for k in ["global_light", "patterns", "layer_comps", "blobs", "resolution", "paths", "guides", "grid", "guides_locked", "artboards_locked"] {
        v.as_object_mut().unwrap().remove(k);
    }
    for k in ["style", "blending", "vector_mask"] {
        v["layers"][0].as_object_mut().unwrap().remove(k);
    }
    let id = v["layers"][0]["tiles"][0][2].as_u64().unwrap();
    let mut d = Document::from_manifest(&v.to_string()).unwrap();
    d.put_tile(id, &old.tile_bytes(id).unwrap()).unwrap();
    d.finish_load().unwrap();
    let n = d.node(1).unwrap();
    assert!(n.style.is_none());
    assert_eq!(n.blending, Blending::default());
    assert_eq!(d.global_light, GlobalLight { angle: 120.0, altitude: 30.0 });
    let m: Value = serde_json::from_str(&d.manifest()).unwrap();
    assert_eq!(m["version"], 6);
    assert_eq!(m["layers"][0]["blending"]["blend_clipped"], true);
    assert_eq!(m["layers"][0]["blending"]["transparency_shapes"], true);
    assert_eq!(m["layers"][0]["blending"]["blend_if"]["gray"]["source"], json!([0, 0, 255, 255]));
    // A v3 manifest never carries an M3 field.
    v["layers"][0]["blending"] = blending();
    assert!(Document::from_manifest(&v.to_string()).is_err(), "blending needs v4");
}

#[test]
fn unknown_kinds_are_rejected() {
    let e = rejects(|v| v["layers"][0]["kind"] = "text".into(), "an unknown node kind");
    assert!(e.contains("text"), "{e}");
    rejects(|v| v["layers"][1]["adjustment"]["kind"] = "glow".into(), "an unknown adjustment kind");
    rejects(|v| v["layers"][3]["smart"]["filters"][1]["filter"]["kind"] = "liquify".into(), "an unknown filter");
    rejects(|v| v["layers"][2]["content"]["type"] = "noise".into(), "an unknown fill type");
    rejects(|v| v["layers"][3]["smart"]["stack_mode"] = "average".into(), "an unknown stack mode");
    rejects(|v| v["layers"][0]["style"]["bevel"]["style"] = "bumpy".into(), "an unknown bevel style");
    rejects(|v| v["layers"][0]["style"]["satin"]["blend"] = "glow".into(), "an unknown effect blend");
}

#[test]
fn unknown_params_keys_are_rejected() {
    let e = rejects(|v| v["layers"][1]["adjustment"]["params"]["composite"]["extra"] = 1.into(), "a levels record key");
    assert!(e.contains("extra"), "{e}");
    rejects(|v| v["layers"][1]["adjustment"]["params"]["extra"] = 1.into(), "a levels params key");
    rejects(|v| v["layers"][1]["adjustment"]["extra"] = 1.into(), "an adjustment key");
    rejects(|v| v["layers"][5]["children"][11]["adjustment"]["params"]["extra"] = 1.into(), "an invert params key");
    rejects(|v| v["layers"][3]["smart"]["filters"][1]["filter"]["params"]["sigma"] = 1.into(), "a filter params key");
    rejects(|v| v["layers"][2]["content"]["extra"] = 1.into(), "a fill content key");
    rejects(|v| v["layers"][0]["style"]["extra"] = 1.into(), "a style key");
    rejects(|v| v["layers"][0]["style"]["drop_shadows"][0]["extra"] = 1.into(), "an effect key");
    rejects(|v| v["layers"][0]["style"]["strokes"][0]["fill"]["extra"] = 1.into(), "a stroke fill key");
    rejects(|v| v["layers"][0]["blending"]["extra"] = 1.into(), "a blending key");
    rejects(|v| v["layers"][3]["smart"]["extra"] = 1.into(), "a smart key");
    rejects(|v| v["layer_comps"][0]["layers"][0]["extra"] = 1.into(), "a comp layer key");
    rejects(|v| v["global_light"]["extra"] = 1.into(), "a global light key");
    rejects(|v| v["patterns"][0]["extra"] = 1.into(), "a pattern key");
}

#[test]
fn v4_structure_rejections() {
    rejects(|v| v["layers"][0].as_object_mut().unwrap().remove("blending").map(|_| ()).unwrap(), "a node without blending");
    rejects(|v| v["layers"][1]["tiles"] = json!([]), "an adjustment with tiles");
    rejects(|v| v["layers"][1].as_object_mut().unwrap().remove("adjustment").map(|_| ()).unwrap(), "an adjustment without params");
    rejects(|v| v["layers"][0]["content"] = v["layers"][2]["content"].clone(), "fill content on a pixel node");
    rejects(|v| v["layers"][3].as_object_mut().unwrap().remove("tiles").map(|_| ()).unwrap(), "a smart object without cache tiles");
    rejects(|v| v["layers"][1]["blend"] = "pass through".into(), "pass through on an adjustment");
    let e = rejects(|v| v["layers"][1]["style"] = full_style("p1"), "a style on an adjustment layer");
    assert!(e.contains("adjustment"), "{e}");
    let e = rejects(|v| v["layers"][2]["content"]["pattern_id"] = "nope".into(), "a fill with a missing pattern");
    assert!(e.contains("nope"), "{e}");
    rejects(|v| v["layers"][0]["style"]["texture"]["pattern_id"] = "nope".into(), "a texture with a missing pattern");
    rejects(|v| v["layer_comps"][0]["layers"][0]["style"]["pattern_overlays"][0]["pattern"]["pattern_id"] = "nope".into(), "a comp style with a missing pattern");
    rejects(|v| { let p = v["patterns"][0].clone(); v["patterns"].as_array_mut().unwrap().push(p) }, "a duplicate pattern id");
    rejects(|v| v["layers"][0]["style"]["drop_shadows"] = json!(vec![shadow(true); 11]), "eleven drop shadows");
    let e = rejects(|v| v["blobs"] = json!([10, 12, 13]), "a blob reference missing from the blob list");
    assert!(e.contains("11"), "{e}");
    rejects(|v| v["blobs"] = json!([1, 10, 11, 12, 13]), "a blob id that is also a tile id");
    rejects(|v| v["blobs"] = json!([0, 10, 11, 12, 13]), "blob id 0");
    rejects(|v| v["blobs"] = json!([10, 10, 11, 12, 13]), "a duplicate blob id");
}

#[test]
fn v4_load_range_checks_params_and_comps() {
    let e = rejects(|v| v["layers"][3]["smart"]["filters"][1]["filter"]["params"]["radius"] = 1e9.into(), "a blur radius of 1e9");
    assert!(e.contains("radius"), "{e}");
    let e = rejects(|v| v["layers"][1]["adjustment"] = bc(500.0, 0.0, false), "brightness 500");
    assert!(e.contains("brightness"), "{e}");
    let e = rejects(|v| v["layers"][5]["children"][0]["adjustment"] = bc(0.0, 500.0, false), "a nested contrast of 500");
    assert!(e.contains("contrast"), "{e}");
    let e = rejects(|v| v["layer_comps"][0]["layers"][0]["opacity"] = 5.into(), "a comp opacity of 5");
    assert!(e.contains("opacity"), "{e}");
    let e = rejects(|v| v["layer_comps"][0]["layers"][1]["fill"] = (-1).into(), "a comp fill of -1");
    assert!(e.contains("fill"), "{e}");

    let mut d = fixture_doc();
    let mut comps = v4_fixture()["layer_comps"].clone();
    comps[0]["layers"][0]["opacity"] = 5.into();
    let e = d.set_document_m3(&json!({ "layer_comps": comps }).to_string()).unwrap_err();
    assert!(e.contains("opacity"), "{e}");
    d.layer_comps[0].layers[0].opacity = 5.0;
    let e = d.apply_layer_comp(1).unwrap_err();
    assert!(e.contains("opacity"), "{e}");
    assert!(d.node(1).unwrap().visible, "a refused comp changes nothing");
}

#[test]
fn a_loading_document_waits_for_its_blobs() {
    let mut d = Document::from_manifest(&v4_fixture().to_string()).unwrap();
    for id in RGBA_TILES.iter().chain(MASK_TILES.iter()) {
        d.put_tile(*id, &tile(*id)).unwrap();
    }
    assert!(d.finish_load().is_err(), "blobs are still missing");
    for id in [10, 11, 12, 13] {
        d.put_tile(id, &blob(id)).unwrap();
    }
    d.finish_load().unwrap();
    assert!(d.next_id >= 20);
}

#[test]
fn pixel_ops_on_adjustment_and_fill_layers_err_naming_the_kind() {
    let mut d = fixture_doc();
    let m = [1.0, 0.0, 3.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    for (id, kind) in [(2, "adjustment layer"), (3, "fill layer")] {
        let errs = [
            d.fill(id, Target::Pixels, 1, 2, 3, 255).unwrap_err(),
            d.clear(id, Target::Pixels).unwrap_err(),
            d.invert(id, Target::Pixels).unwrap_err(),
            d.offset_layer(id, 1, 1).unwrap_err(),
            d.transform_layer(id, &m, Interp::Bilinear).unwrap_err(),
            d.set_tile_rgba8(id, 0, 0, &tile(1)).unwrap_err(),
        ];
        for e in errs {
            assert!(e.contains(kind), "{e} names the {kind}");
        }
    }
    let mut e = EngineCore::new(fixture_doc());
    let err = e.stroke_begin(2, "pixels", "{}").unwrap_err();
    assert!(err.contains("adjustment layer"), "painting: {err}");
}

#[test]
fn smart_object_refuses_direct_pixel_paint_but_allows_filters_and_transforms() {
    let mut d = fixture_doc();
    let smart_json = json!({ "name": "Placed", "smart": {
        "link": { "type": "embedded", "id": "x" }, "source_blob": null, "source_size": [4, 4],
        "transform": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    } });
    let id = d.add_special(1, &smart_json.to_string()).unwrap();
    d.load_smart_source(id, &[100u8; 4 * 4 * 4]).unwrap();
    d.render_smart(id).unwrap();
    let cache_id = |d: &Document| d.node(id).unwrap().pixel_tiles().unwrap().get(0, 0).unwrap().id;
    let before = cache_id(&d);
    let refusal = "This smart object must be rasterized before its pixels can be edited.";

    assert_eq!(d.fill(id, Target::Pixels, 1, 2, 3, 255).unwrap_err(), refusal);
    assert_eq!(d.clear(id, Target::Pixels).unwrap_err(), refusal);
    assert_eq!(
        d.bucket(id, Target::Pixels, 0, 0, [1, 2, 3, 255], PaintMode::Blend(Blend::Normal), 1.0, 32, false, true, false).unwrap_err(),
        refusal
    );
    assert_eq!(
        d.gradient(
            id,
            Target::Pixels,
            vec![
                gradient::ColorStop { position: 0.0, rgb: [0.0, 0.0, 0.0], midpoint: 0.5 },
                gradient::ColorStop { position: 1.0, rgb: [1.0, 1.0, 1.0], midpoint: 0.5 },
            ],
            vec![
                gradient::OpacityStop { position: 0.0, opacity: 1.0, midpoint: 0.5 },
                gradient::OpacityStop { position: 1.0, opacity: 1.0, midpoint: 0.5 },
            ],
            gradient::Method::Classic,
            gradient::Style::Linear,
            (0.0, 0.0),
            (1.0, 0.0),
            false,
            false,
            true,
            1.0,
        )
        .unwrap_err(),
        refusal
    );
    d.select_all().unwrap();
    assert_eq!(
        d.stroke_selection(id, 3.0, [1, 2, 3, 255], "inside", PaintMode::Blend(Blend::Normal), 1.0, false).unwrap_err(),
        refusal
    );
    d.selection = None;
    let mut e = EngineCore::new(d);
    assert_eq!(e.stroke_begin(id, "pixels", "{}").unwrap_err(), refusal);
    let mut d = e.doc;
    assert_eq!(cache_id(&d), before, "a refused paint changes nothing");

    // Legitimate smart workflows keep working: whole-layer move/transform, filters, a mask fill.
    d.offset_layer(id, 1, 1).unwrap();
    d.invert(id, Target::Pixels).unwrap();
    d.apply_adjustment(id, Target::Pixels, r#"{"kind":"invert","params":{}}"#).unwrap();
    d.add_smart_filter(id, r#"{"kind":"gaussian_blur","params":{"radius":2.5}}"#).unwrap();
    assert!(
        matches!(&d.node(id).unwrap().kind, Kind::Smart(s) if s.filters.len() == 3),
        "invert, adjustment and blur all appended a filter"
    );
    d.add_mask(id, true).unwrap();
    d.fill(id, Target::Mask, 0, 0, 0, 255).unwrap();
    let m = [1.0, 0.0, 3.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    d.transform_layer(id, &m, Interp::Bilinear).unwrap();
}

#[test]
fn masks_and_layer_props_work_on_every_kind() {
    let mut d = fixture_doc();
    for id in [2, 3, 4, 7] {
        d.set_props(id, r#"{"opacity":0.5,"visible":false,"blend":"screen","clipping":true,"locks":{"pixels":true}}"#)
            .unwrap();
    }
    d.fill(2, Target::Mask, 0, 0, 0, 255).unwrap();
    d.invert(2, Target::Mask).unwrap();
    d.add_mask(7, false).unwrap();
    d.delete_mask(2).unwrap();
    let n = d.node(3).unwrap();
    assert_eq!((n.opacity, n.visible, n.blend, n.clipping, n.locks.pixels), (0.5, false, Blend::Screen, true, true));
}

#[test]
fn canvas_ops_keep_adjustment_masks_aligned() {
    let mut d = fixture_doc();
    d.rotate_canvas_exact(Remap::Cw).unwrap();
    assert!(d.node(2).unwrap().mask.is_some());
    assert!(matches!(d.node(2).unwrap().kind, Kind::Adjustment(_)));
}

#[test]
fn styles_are_refused_on_adjustment_layers_only() {
    let mut d = fixture_doc();
    let style = full_style("p1").to_string();
    let e = d.set_style(2, &style).unwrap_err();
    assert!(e.contains("adjustment layer"), "{e}");
    for id in [1, 3, 4, 7, 6] {
        d.set_style(id, &style).unwrap();
        assert!(d.node(id).unwrap().style.is_some());
    }
    d.set_style(3, "null").unwrap();
    assert!(d.node(3).unwrap().style.is_none());
    d.set_style(2, "null").unwrap();
}

#[test]
fn a_style_naming_a_missing_pattern_is_refused() {
    let mut d = fixture_doc();
    let before = d.node(3).unwrap().style.clone();
    let e = d.set_style(3, &full_style("nope").to_string()).unwrap_err();
    assert!(e.contains("nope"), "{e}");
    assert_eq!(d.node(3).unwrap().style, before, "a refused op changes nothing");
    let mut bad = full_style("p1");
    bad["strokes"][0]["extra"] = 1.into();
    assert!(d.set_style(3, &bad.to_string()).is_err(), "unknown keys are refused by the op too");
}

fn smart_transform(d: &Document, id: u32) -> [f64; 9] {
    match &d.node(id).unwrap().kind {
        Kind::Smart(s) => s.transform,
        _ => panic!("node {id} is not smart"),
    }
}

// Writes the manifest, loads it with every tile and blob, and writes it again.
fn reload(d: &Document) -> (String, String) {
    let m = d.manifest();
    let mut e = Document::from_manifest(&m).unwrap();
    let ids: Vec<u64> = e.loading.as_ref().unwrap().pending_ids.iter().copied().collect();
    for id in ids {
        e.put_tile(id, &d.tile_bytes(id).unwrap()).unwrap();
    }
    e.finish_load().unwrap();
    (m, e.manifest())
}

#[test]
fn add_special_creates_each_kind_above_a_node() {
    let mut d = fixture_doc();
    let b = d.blob_add(&[1, 2, 3]).unwrap();
    assert!(b >= 20, "blob ids come from the tile counter");
    assert!(d.blob_add(&[]).is_err());
    let a = d.add_special(1, &json!({ "name": "Invert", "adjustment": { "kind": "invert", "params": {} } }).to_string()).unwrap();
    let f = d.add_special(a, &json!({ "name": "Fill", "content": { "type": "solid", "color": [1, 2, 3] } }).to_string()).unwrap();
    let smart = json!({ "name": "Placed", "smart": {
        "link": { "type": "embedded", "id": "x" }, "source_blob": b, "source_size": [2, 2],
        "transform": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    } });
    let s = d.add_special(f, &smart.to_string()).unwrap();
    let ids: Vec<u32> = d.nodes.iter().map(|n| n.id).collect();
    assert_eq!(&ids[..4], &[1, a, f, s]);
    assert!(matches!(d.node(a).unwrap().kind, Kind::Adjustment(_)));
    assert!(matches!(d.node(f).unwrap().kind, Kind::Fill(_)));
    d.set_tile_rgba8(s, 0, 0, &tile(1)).unwrap();
    assert!(d.node(s).unwrap().pixel_tiles().unwrap().get(0, 0).is_some(), "a smart node's pixels are its cache");
    let (m, again) = reload(&d);
    assert_eq!(m, again);
    assert!(m.contains(&format!("\"source\":{{\"blob\":{b}")), "{m}");
}

#[test]
fn add_special_rejections() {
    let mut d = fixture_doc();
    let cases = [
        json!({ "name": "x" }),
        json!({ "name": "x", "adjustment": { "kind": "invert", "params": {} }, "content": { "type": "solid", "color": [0, 0, 0] } }),
        json!({ "name": "x", "adjustment": { "kind": "invert", "params": {} }, "extra": 1 }),
        json!({ "name": "x", "adjustment": { "kind": "invert", "params": { "extra": 1 } } }),
        json!({ "name": "x", "content": { "type": "pattern", "pattern_id": "nope", "scale": 1.0, "angle": 0.0, "linked": true, "offset": [0.0, 0.0] } }),
        json!({ "name": "x", "adjustment": { "kind": "color_lookup", "params": { "name": "a", "format": "cube", "table": 999, "interpolation": "trilinear", "dither": false } } }),
        json!({ "name": "x", "smart": { "link": { "type": "embedded", "id": "x" }, "source_blob": 999, "source_size": [1, 1], "transform": [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] } }),
    ];
    let before = d.manifest();
    for c in cases {
        assert!(d.add_special(1, &c.to_string()).is_err(), "{c} must be refused");
    }
    assert_eq!(d.manifest(), before, "a refused op changes nothing");
}

#[test]
fn set_blending_and_document_fields() {
    let mut d = fixture_doc();
    for id in [1, 2, 3] {
        d.set_blending(id, &blending().to_string()).unwrap();
        assert_eq!(d.node(id).unwrap().blending, serde_json::from_value::<Blending>(blending()).unwrap());
    }
    let mut bad = blending();
    bad["extra"] = 1.into();
    assert!(d.set_blending(1, &bad.to_string()).is_err());
    d.set_document_m3(&json!({ "global_light": { "angle": 10.0, "altitude": 20.0 } }).to_string()).unwrap();
    assert_eq!((d.global_light.angle, d.global_light.altitude), (10.0, 20.0));
    assert_eq!(d.patterns.len(), 1, "absent fields stay");
    let comp = |layer: u32| json!({ "layer_comps": [{
        "id": 1, "name": "c", "comment": "", "apply_visibility": true, "apply_position": false, "apply_appearance": false,
        "layers": [{ "id": layer, "visible": true, "position": null, "opacity": 1.0, "fill": 1.0, "blend": "normal", "style": null }]
    }] });
    assert!(d.set_document_m3(&comp(999).to_string()).is_err(), "a comp naming a missing layer is refused");
    d.set_document_m3(&comp(3).to_string()).unwrap();
    assert_eq!(d.layer_comps.len(), 1);
    let pat = |blob: u64| json!({ "patterns": [{ "id": "q", "name": "Q", "width": 1, "height": 1, "blob": blob }] });
    assert!(d.set_document_m3(&pat(999).to_string()).is_err(), "a pattern naming a missing blob is refused");
    assert!(d.set_document_m3(&json!({ "extra": 1 }).to_string()).is_err());
}

#[test]
fn canvas_ops_move_smart_transforms() {
    let mut d = fixture_doc();
    assert_eq!(smart_transform(&d, 4), [1.0, 0.0, 5.0, 0.0, 1.0, 7.0, 0.0, 0.0, 1.0]);
    d.apply_crop([10.0, 20.0, 100.0, 100.0], false).unwrap();
    assert_eq!(smart_transform(&d, 4), [1.0, 0.0, -5.0, 0.0, 1.0, -13.0, 0.0, 0.0, 1.0]);
    let mut d = fixture_doc();
    d.rotate_canvas_exact(Remap::Cw).unwrap();
    assert_eq!(smart_transform(&d, 4), [0.0, -1.0, 249.0, 1.0, 0.0, 5.0, 0.0, 0.0, 1.0]);
    let mut d = fixture_doc();
    d.rotate_canvas_exact(Remap::FlipH).unwrap();
    assert_eq!(smart_transform(&d, 4), [-1.0, 0.0, 251.0, 0.0, 1.0, 7.0, 0.0, 0.0, 1.0]);
}

// ---------- draw program v2 (docs/M3.md section 2) ----------

fn px(d: &Document, x: usize, y: usize) -> [u8; 4] {
    let t = d.flatten_tile_rgba8((x / TILE) as u32, (y / TILE) as u32).unwrap();
    let o = ((y % TILE) * TILE + x % TILE) * 4;
    t[o..o + 4].try_into().unwrap()
}

fn gray_doc(w: u32, h: u32, v: u8) -> Document {
    let mut d = Document::new(w, h, 8).unwrap();
    d.fill(1, Target::Pixels, v, v, v, 255).unwrap();
    d
}

fn special(d: &mut Document, above: u32, v: Value) -> u32 {
    d.add_special(above, &v.to_string()).unwrap()
}

fn invert(d: &mut Document, above: u32) -> u32 {
    special(d, above, json!({ "name": "Invert", "adjustment": { "kind": "invert", "params": {} } }))
}

fn set_fill(d: &mut Document, id: u32, v: Value) {
    let Kind::Fill(c) = &mut d.node_mut(id).unwrap().kind else { panic!("not a fill layer") };
    *c = serde_json::from_value(v).unwrap();
}

fn blending_with(f: impl Fn(&mut Value)) -> String {
    let mut b = serde_json::to_value(Blending::default()).unwrap();
    f(&mut b);
    b.to_string()
}

/// One color overlay: an interior effect, so fill 0 still hides everything once effects render.
fn overlay_style(enabled: bool) -> String {
    json!({
        "enabled": true, "scale": 1.0, "drop_shadows": [], "inner_shadows": [],
        "color_overlays": [{ "present": true, "enabled": enabled, "blend": "normal", "opacity": 1.0, "color": [0, 255, 0] }],
        "gradient_overlays": [], "pattern_overlays": [], "strokes": [], "outer_glow": null, "inner_glow": null,
        "bevel": null, "contour": null, "texture": null, "satin": null
    })
    .to_string()
}

#[test]
fn invert_adjustment_goldens() {
    let mut d = gray_doc(8, 8, 200);
    let a = invert(&mut d, 1);
    assert_eq!(px(&d, 3, 3), [55, 55, 55, 255]);
    d.set_props(a, r#"{"opacity":0.25}"#).unwrap();
    assert_eq!(px(&d, 3, 3), [164, 164, 164, 255]);
    // Straight color is adjusted, alpha is never changed.
    let mut d = Document::new(8, 8, 8).unwrap();
    d.fill(1, Target::Pixels, 200, 200, 200, 128).unwrap();
    invert(&mut d, 1);
    assert_eq!(px(&d, 0, 0), [55, 55, 55, 128]);
}

#[test]
fn adjust_blends_the_adjusted_color_onto_the_original() {
    // subtract(original 204, inverted 51) = 153; the swapped order would clamp to 0.
    let mut d = gray_doc(8, 8, 204);
    let a = invert(&mut d, 1);
    d.set_props(a, r#"{"blend":"subtract"}"#).unwrap();
    assert_eq!(px(&d, 0, 0), [153, 153, 153, 255]);
    // Dissolve turns the weight into all or nothing per pixel.
    d.set_props(a, r#"{"blend":"dissolve","opacity":0.5}"#).unwrap();
    let vals: HashSet<u8> = (0..8).flat_map(|y| (0..8).map(move |x| (x, y))).map(|(x, y)| px(&d, x, y)[0]).collect();
    assert_eq!(vals, HashSet::from([51, 204]));
}

#[test]
fn a_clipped_adjustment_weights_by_the_base_alpha() {
    let mut d = gray_doc(8, 8, 200);
    let l = d.add_layer("base", 1).unwrap();
    d.fill(l, Target::Pixels, 100, 100, 100, 128).unwrap();
    let a = invert(&mut d, l);
    d.set_props(a, r#"{"clipping":true}"#).unwrap();
    // Base 100 -> 100 + 55 * a (a = 128/255), then over 200: 164. Unclipped gives 105.
    assert_eq!(px(&d, 0, 0), [164, 164, 164, 255]);
    d.set_props(a, r#"{"clipping":false}"#).unwrap();
    assert_eq!(px(&d, 0, 0), [105, 105, 105, 255]);
}

#[test]
fn blend_if_goldens() {
    let range = |s: [u8; 4]| {
        let mut b = BlendIf::default();
        b.gray.source = s;
        b
    };
    let g = 64.0 / 255.0;
    assert!((blend_if_weight(&range([0, 128, 255, 255]), [g; 3], [0.0; 3]) - 0.5).abs() < 1e-6);
    assert_eq!(blend_if_weight(&BlendIf::default(), [0.0; 3], [1.0; 3]), 1.0);
    // Draw: source alpha times the weight, over black.
    let mut d = gray_doc(8, 8, 0);
    let l = d.add_layer("l", 1).unwrap();
    d.fill(l, Target::Pixels, 64, 64, 64, 255).unwrap();
    d.set_blending(l, &blending_with(|b| b["blend_if"]["gray"]["source"] = json!([0, 128, 255, 255]))).unwrap();
    assert_eq!(px(&d, 0, 0), [32, 32, 32, 255]);
    // Adjust: "This Layer" is the mixed result (40 -> 84 at opacity 0.25), not the raw invert (215).
    let mut d = gray_doc(8, 8, 40);
    let a = invert(&mut d, 1);
    d.set_props(a, r#"{"opacity":0.25}"#).unwrap();
    d.set_blending(a, &blending_with(|b| b["blend_if"]["gray"]["source"] = json!([0, 0, 150, 150]))).unwrap();
    assert_eq!(px(&d, 0, 0), [84, 84, 84, 255]);
    // "Underlying Layer" reads the original: 40 is outside [100, 255], so nothing changes.
    d.set_blending(a, &blending_with(|b| b["blend_if"]["gray"]["destination"] = json!([100, 100, 255, 255]))).unwrap();
    assert_eq!(px(&d, 0, 0), [40, 40, 40, 255]);
}

#[test]
fn knockout_punches_to_transparent() {
    let mut d = gray_doc(8, 8, 200);
    let l = d.add_layer("k", 1).unwrap();
    d.fill(l, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.set_props(l, r#"{"fill":0}"#).unwrap();
    d.set_blending(l, &blending_with(|b| b["knockout"] = "shallow".into())).unwrap();
    assert_eq!(px(&d, 1, 1), [200, 200, 200, 255], "a layer without an enabled effect does not knock out");
    d.set_style(l, &overlay_style(false)).unwrap();
    assert_eq!(px(&d, 1, 1), [200, 200, 200, 255], "a disabled effect does not count");
    d.set_style(l, &overlay_style(true)).unwrap();
    assert_eq!(px(&d, 1, 1)[3], 0, "shallow over an opaque backdrop");
    d.set_blending(l, &blending_with(|b| b["knockout"] = "deep".into())).unwrap();
    assert_eq!(px(&d, 1, 1)[3], 0, "deep punches like shallow");
    d.set_props(l, r#"{"opacity":0.6}"#).unwrap();
    assert_eq!(px(&d, 1, 1), [200, 200, 200, 102], "alpha times 1 - shape * opacity, color kept");
    d.set_props(l, r#"{"opacity":1}"#).unwrap();
    let g = d.group_nodes(&[l]).unwrap();
    d.set_props(g, r#"{"blend":"normal"}"#).unwrap();
    assert_eq!(px(&d, 1, 1), [200, 200, 200, 255], "an isolated group bounds the knockout");
    d.set_props(g, r#"{"blend":"pass through"}"#).unwrap();
    assert_eq!(px(&d, 1, 1)[3], 0, "a pass-through group passes it on");
    // A styled group knocks out by its composite alpha.
    d.set_style(l, "null").unwrap();
    d.set_props(l, r#"{"fill":1}"#).unwrap();
    d.set_props(g, r#"{"blend":"normal","fill":0}"#).unwrap();
    d.set_blending(g, &blending_with(|b| b["knockout"] = "shallow".into())).unwrap();
    d.set_style(g, &overlay_style(true)).unwrap();
    assert_eq!(px(&d, 1, 1)[3], 0, "a group knocks out");
}

#[test]
fn a_styled_clipping_base_keeps_its_knockout() {
    let mut d = gray_doc(8, 8, 200);
    let l = d.add_layer("base", 1).unwrap();
    d.fill(l, Target::Pixels, 255, 0, 0, 128).unwrap();
    d.set_blending(l, &blending_with(|b| b["knockout"] = "shallow".into())).unwrap();
    d.set_style(l, &overlay_style(true)).unwrap();
    let c = d.add_layer("clipped", l).unwrap();
    d.fill(c, Target::Pixels, 0, 0, 255, 255).unwrap();
    d.set_props(c, r#"{"clipping":true}"#).unwrap();
    // The base knocks out as if unclipped (alpha 0.875), then the opaque clipped layer draws
    // through the raw shape 0.5: 0.5 * 0.875 + 0.5 = 0.9375.
    assert_eq!(px(&d, 1, 1)[3], 239);
    d.set_props(c, r#"{"clipping":false,"visible":false}"#).unwrap();
    // The overlay raises the content alpha to 0.75 (union), over the 0.5 left: 0.875.
    assert_eq!(px(&d, 1, 1)[3], 223, "unclipped, the same layer knocks out");
}

fn put_pattern(d: &mut Document, w: u32, h: u32, bytes: &[u8]) {
    let blob = d.blob_add(bytes).unwrap();
    let p = json!({ "patterns": [{ "id": "p", "name": "P", "width": w, "height": h, "blob": blob }] });
    d.set_document_m3(&p.to_string()).unwrap();
}

fn gradient_content(angle: f32, reverse: bool) -> Value {
    json!({ "type": "gradient", "gradient": {
        "method": "classic",
        "color_stops": [
            { "position": 0.0, "color": [0, 0, 0], "midpoint": 0.5 },
            { "position": 1.0, "color": [255, 255, 255], "midpoint": 0.5 }
        ],
        "opacity_stops": [
            { "position": 0.0, "opacity": 1.0, "midpoint": 0.5 },
            { "position": 1.0, "opacity": 1.0, "midpoint": 0.5 }
        ]
    }, "style": "linear", "angle": angle, "scale": 1.0, "reverse": reverse, "dither": false,
       "align_with_layer": true, "offset": [0.0, 0.0] })
}

#[test]
fn fill_layers_render_their_content() {
    // Solid at opacity 0.5 over white matches a pixel layer of the same color.
    let mut d = gray_doc(300, 8, 255);
    let f = special(&mut d, 1, json!({ "name": "F", "content": { "type": "solid", "color": [10, 20, 30] } }));
    d.set_props(f, r#"{"opacity":0.5}"#).unwrap();
    let mut e = gray_doc(300, 8, 255);
    let p = e.add_layer("p", 1).unwrap();
    e.fill(p, Target::Pixels, 10, 20, 30, 255).unwrap();
    e.set_props(p, r#"{"opacity":0.5}"#).unwrap();
    for tx in 0..2 {
        assert_eq!(d.flatten_tile_rgba8(tx, 0), e.flatten_tile_rgba8(tx, 0), "tile {tx}");
    }
    // Linear gradient over the document box: angle 0 runs left to right, t = (x + 0.5) / 256.
    let mut d = Document::new(256, 4, 8).unwrap();
    d.set_props(1, r#"{"visible":false}"#).unwrap();
    let g = special(&mut d, 1, json!({ "name": "G", "content": gradient_content(0.0, false) }));
    assert_eq!(px(&d, 64, 1), [64, 64, 64, 255]);
    assert_eq!(px(&d, 127, 1), [127, 127, 127, 255]);
    set_fill(&mut d, g, gradient_content(0.0, true));
    assert_eq!(px(&d, 64, 1), [191, 191, 191, 255], "reverse");
    // Angle 90 runs bottom to top.
    let mut d = Document::new(4, 256, 8).unwrap();
    d.set_props(1, r#"{"visible":false}"#).unwrap();
    special(&mut d, 1, json!({ "name": "G", "content": gradient_content(90.0, false) }));
    assert_eq!(px(&d, 1, 128), [127, 127, 127, 255]);
    assert!(px(&d, 1, 0)[0] > 250 && px(&d, 1, 255)[0] < 5);
}

#[test]
fn pattern_fills_tile_the_document_pattern() {
    let mut d = Document::new(6, 2, 8).unwrap();
    d.set_props(1, r#"{"visible":false}"#).unwrap();
    put_pattern(&mut d, 2, 1, &[255, 0, 0, 255, 0, 0, 255, 255]);
    let pat = |scale: f32| json!({ "type": "pattern", "pattern_id": "p", "scale": scale, "angle": 0.0, "linked": false, "offset": [0.0, 0.0] });
    let f = special(&mut d, 1, json!({ "name": "P", "content": pat(1.0) }));
    let row = |d: &Document| (0..6).map(|x| px(d, x, 1)).collect::<Vec<_>>();
    let (r, b) = ([255, 0, 0, 255], [0, 0, 255, 255]);
    assert_eq!(row(&d), [r, b, r, b, r, b]);
    set_fill(&mut d, f, pat(2.0));
    assert_eq!(row(&d), [r, r, b, b, r, r]);
    // A pattern whose blob is shorter than width * height * 4 renders transparent.
    put_pattern(&mut d, 2, 2, &[1, 2, 3, 4]);
    assert_eq!(px(&d, 0, 0)[3], 0);
}

#[test]
fn set_content_rejects_wrong_kind_and_unknown_pattern() {
    let mut d = Document::new(8, 8, 8).unwrap();
    let f = special(&mut d, 1, json!({ "name": "F", "content": { "type": "solid", "color": [1, 2, 3] } }));
    let err = d.set_content(1, &json!({ "type": "solid", "color": [4, 5, 6] }).to_string()).unwrap_err();
    assert!(err.contains("pixel"), "the error names the kind: {err}");
    let pat = json!({ "type": "pattern", "pattern_id": "nope", "scale": 1.0, "angle": 0.0, "linked": true, "offset": [0.0, 0.0] });
    assert!(d.set_content(f, &pat.to_string()).is_err(), "an unknown pattern id is refused");
    d.set_content(f, &json!({ "type": "solid", "color": [4, 5, 6] }).to_string()).unwrap();
    let Kind::Fill(c) = &d.node(f).unwrap().kind else { panic!("still a fill layer") };
    assert_eq!(*c, serde_json::from_value(json!({ "type": "solid", "color": [4, 5, 6] })).unwrap());
}

#[test]
fn rasterize_fill_keeps_the_render_and_becomes_pixels() {
    let mut d = gray_doc(300, 8, 255);
    let f = special(&mut d, 1, json!({ "name": "F", "content": { "type": "solid", "color": [10, 20, 30] } }));
    d.set_props(f, r#"{"opacity":0.5}"#).unwrap();
    let before: Vec<Vec<u8>> = (0..2).map(|tx| d.flatten_tile_rgba8(tx, 0).unwrap()).collect();
    assert!(d.rasterize_fill(1).is_err(), "a pixel layer refuses rasterize");
    d.rasterize_fill(f).unwrap();
    assert!(matches!(d.node(f).unwrap().kind, Kind::Pixel(_)));
    assert_eq!(d.node(f).unwrap().opacity, 0.5, "props are kept");
    for tx in 0..2 {
        assert_eq!(d.flatten_tile_rgba8(tx, 0).unwrap(), before[tx as usize], "tile {tx}");
    }
}

#[test]
fn add_fill_layer_masks_the_selection_and_clears_it() {
    let mut d = Document::new(20, 20, 8).unwrap();
    d.select_rect(2.0, 3.0, 5.0, 6.0, Mode::New).unwrap();
    let solid = json!({ "name": "Color Fill", "content": { "type": "solid", "color": [0, 0, 0] } }).to_string();
    let f = d.add_fill_layer(1, &solid).unwrap();
    assert!(d.selection.is_none(), "the selection is dropped");
    assert!(d.last_selection.is_some(), "reselect can still restore it");
    let mask = d.node(f).unwrap().mask.as_ref().unwrap();
    assert_eq!(mask.default, 0, "outside the rect is not revealed");
    assert!(!mask.tiles.coords().is_empty(), "the rect is carried in tiles");
    // Without a selection the mask reveals everything.
    let g = d.add_fill_layer(f, &solid).unwrap();
    let mask_g = d.node(g).unwrap().mask.as_ref().unwrap();
    assert_eq!(mask_g.default, 255);
    assert!(mask_g.tiles.coords().is_empty());
}

fn v2_doc() -> Document {
    let mut d = Document::new(300, 260, 8).unwrap();
    for ty in 0..2 {
        for tx in 0..2 {
            let t: Vec<u8> =
                (0..TILE_PIXELS).flat_map(|p| [(p % 251) as u8, (p / 256) as u8, (tx * 90 + ty * 40) as u8, 255]).collect();
            d.set_tile_rgba8(1, tx, ty, &t).unwrap();
        }
    }
    let f = special(&mut d, 1, json!({ "name": "G", "content": gradient_content(30.0, false) }));
    d.set_props(f, r#"{"opacity":0.5,"blend":"multiply"}"#).unwrap();
    let a = invert(&mut d, f);
    d.set_props(a, r#"{"opacity":0.7,"blend":"color"}"#).unwrap();
    d.set_blending(a, &blending_with(|b| b["blend_if"]["red"]["destination"] = json!([10, 60, 200, 240]))).unwrap();
    let l = d.add_layer("k", a).unwrap();
    d.fill(l, Target::Pixels, 0, 200, 0, 180).unwrap();
    d.set_props(l, r#"{"fill":0.3}"#).unwrap();
    d.set_blending(l, &blending_with(|b| {
        b["knockout"] = "shallow".into();
        b["blend_if"]["gray"]["source"] = json!([0, 40, 180, 255]);
    }))
    .unwrap();
    d.set_style(l, &overlay_style(true)).unwrap();
    let base = d.add_layer("base", l).unwrap();
    d.fill(base, Target::Pixels, 90, 90, 200, 150).unwrap();
    let c = invert(&mut d, base);
    d.set_props(c, r#"{"clipping":true,"opacity":0.8}"#).unwrap();
    let lv = special(&mut d, c, json!({ "name": "L", "adjustment": levels(20, 235, 1.3) }));
    let hs = special(&mut d, lv, json!({ "name": "H", "adjustment": hue_sat(40.0) }));
    d.set_props(hs, r#"{"opacity":0.9,"blend":"overlay"}"#).unwrap();
    let gm = special(&mut d, hs, json!({ "name": "G", "adjustment": gradient_map() }));
    d.set_props(gm, r#"{"opacity":0.4}"#).unwrap();
    d
}

#[test]
fn program_v2_round_trips_and_matches_the_display_tile() {
    let d = v2_doc();
    let bytes = d.display_program(0, 0, 0, &[]).unwrap();
    assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 2, "program version");
    let p = Program::decode(&bytes);
    let adjusts: Vec<&Step> = p.steps.iter().filter(|s| s.op == Op::Adjust).collect();
    assert_eq!(adjusts.len(), 5);
    assert!(p.steps.iter().any(|s| s.op == Op::Knockout));
    let opcodes: Vec<u32> = adjusts.iter().map(|s| s.opcode).collect();
    assert_eq!(opcodes, [adjust::OP_INVERT, adjust::OP_INVERT, adjust::OP_TABLE, adjust::OP_HUE_SATURATION, adjust::OP_GRADIENT_MAP]);
    assert_eq!((adjusts[0].src, adjusts[1].src), (0, 0), "invert has no data");
    let data: Vec<u64> = adjusts[2..].iter().map(|s| s.src).collect();
    assert_eq!(p.data.iter().map(|d| d.0).collect::<Vec<_>>(), data);
    assert_eq!(p.data[2].1.len(), 1 + 4096 * 3);
    let q = Program::decode(&d.display_program(0, 0, 0, &data).unwrap());
    assert!(q.data.is_empty(), "known data keys are left out");
    assert_eq!(adjusts[0].blend_if.red.destination, [10, 60, 200, 240]);
    assert_eq!((adjusts[0].flags & FLAG_CLIP, adjusts[1].flags & FLAG_CLIP), (0, FLAG_CLIP));
    for level in [0, 2] {
        let (ntx, nty) = d.level_tiles(level);
        for ty in 0..nty {
            for tx in 0..ntx {
                let bytes = d.display_program(level, tx, ty, &[]).unwrap();
                let run = Document::run_program(&Program::decode(&bytes));
                assert_eq!(quantize_premul(&run), d.display_tile(level, tx, ty).unwrap(), "level {level} tile ({tx}, {ty})");
            }
        }
    }
}

#[test]
fn fill_payload_keys_follow_the_content() {
    let mut d = Document::new(64, 64, 8).unwrap();
    let f = special(&mut d, 1, json!({ "name": "F", "content": { "type": "solid", "color": [1, 2, 3] } }));
    let keys = |d: &Document| {
        Program::decode(&d.display_program(0, 0, 0, &[]).unwrap()).payloads.iter().map(|p| p.0).collect::<Vec<_>>()
    };
    let first = keys(&d);
    assert_eq!(first.len(), 1, "the empty background ships nothing");
    assert_eq!(keys(&d), first, "the same content gives the same key");
    set_fill(&mut d, f, json!({ "type": "solid", "color": [1, 2, 4] }));
    assert_ne!(keys(&d), first);
}

// ---------- adjustment kinds on the compositor (docs/M3.md section 3) ----------

/// The 8-bit color of an opaque `bg` pixel under one adjustment layer.
fn adjusted(bg: [u8; 3], adjustment: Value) -> [u8; 3] {
    let mut d = Document::new(4, 4, 8).unwrap();
    d.fill(1, Target::Pixels, bg[0], bg[1], bg[2], 255).unwrap();
    special(&mut d, 1, json!({ "name": "A", "adjustment": adjustment }));
    let p = px(&d, 1, 1);
    [p[0], p[1], p[2]]
}

fn kind(kind: &str, params: Value) -> Value {
    json!({ "kind": kind, "params": params })
}

fn bc(brightness: f64, contrast: f64, legacy: bool) -> Value {
    kind("brightness_contrast", json!({ "brightness": brightness, "contrast": contrast, "legacy": legacy }))
}

fn levels(ib: u8, iw: u8, gamma: f64) -> Value {
    let r = json!({ "input_black": ib, "input_white": iw, "gamma": gamma, "output_black": 0, "output_white": 255 });
    kind("levels", json!({ "composite": r, "red": null, "green": null, "blue": null }))
}

fn hue_sat(hue: f64) -> Value {
    let ranges: Vec<Value> = (0..6)
        .map(|i| {
            let a = (315.0 + 60.0 * i as f64) % 360.0;
            json!({ "bands": [a, (a + 30.0) % 360.0, (a + 60.0) % 360.0, (a + 90.0) % 360.0], "hue": 0.0, "saturation": 0.0, "lightness": 0.0 })
        })
        .collect();
    kind("hue_saturation", json!({
        "master": { "hue": hue, "saturation": 0.0, "lightness": 0.0 }, "ranges": ranges,
        "colorize": false, "colorize_values": { "hue": 0.0, "saturation": 25.0, "lightness": 0.0 }
    }))
}

fn black_white() -> Value {
    kind("black_white", json!({ "reds": 40.0, "yellows": 60.0, "greens": 40.0, "cyans": 60.0, "blues": 20.0, "magentas": 80.0, "tint": false, "tint_color": [206, 185, 155] }))
}

fn gradient_map() -> Value {
    let mut g = gradient_content(0.0, false)["gradient"].clone();
    g["method"] = "classic".into();
    kind("gradient_map", json!({ "gradient": g, "reverse": false, "dither": false }))
}

fn gray3(v: u8) -> [u8; 3] {
    [v; 3]
}

#[test]
fn table_adjustment_goldens() {
    assert_eq!(adjusted(gray3(128), bc(150.0, 0.0, false)), gray3(203));
    assert_eq!(adjusted(gray3(100), bc(0.0, 100.0, false)), gray3(49));
    assert_eq!(adjusted(gray3(100), bc(50.0, 0.0, true)), gray3(164), "legacy");
    assert_eq!(adjusted(gray3(100), levels(20, 235, 1.0)), gray3(95));
    assert_eq!(adjusted(gray3(64), levels(0, 255, 2.0)), gray3(128));
    assert_eq!(adjusted(gray3(128), kind("exposure", json!({ "exposure": 1.0, "offset": 0.0, "gamma": 1.0 }))), gray3(176));
    assert_eq!(adjusted(gray3(100), kind("posterize", json!({ "levels": 4 }))), gray3(85));
    assert_eq!(adjusted([127, 128, 200], kind("threshold", json!({ "level": 128 }))), [0, 255, 255]);
}

#[test]
fn per_pixel_adjustment_goldens() {
    let photo = kind("photo_filter", json!({ "color": [236, 138, 0], "density": 25.0, "preserve_luminosity": false }));
    assert_eq!(adjusted(gray3(128), photo), [126, 113, 96]);
    let balance = kind("color_balance", json!({ "shadows": [0.0, 0.0, 0.0], "midtones": [50.0, 0.0, 0.0], "highlights": [0.0, 0.0, 0.0], "preserve_luminosity": false }));
    assert_eq!(adjusted(gray3(128), balance)[0], 217);
    let mixer = kind("channel_mixer", json!({ "red": [100.0, 0.0, 0.0, 0.0], "green": [0.0, 100.0, 0.0, 0.0], "blue": [0.0, 0.0, 100.0, 0.0], "gray": [40.0, 40.0, 20.0, 0.0], "monochrome": true }));
    assert_eq!(adjusted([255, 0, 0], mixer), gray3(102));
    assert_eq!(adjusted([255, 0, 0], black_white()), gray3(102));
    assert_eq!(adjusted([255, 255, 0], black_white()), gray3(153));
    assert_eq!(adjusted([255, 0, 0], gradient_map()), gray3(77));
    assert_eq!(adjusted([255, 0, 0], hue_sat(180.0)), [0, 255, 255]);
}

#[test]
fn a_cube_with_a_bad_line_errs_naming_it() {
    let err = adjust::parse_cube(b"TITLE \"t\"\nLUT_3D_SIZE 2\n0 0 0\n1 0 x\n").unwrap_err();
    assert!(err.starts_with("line 4:"), "{err}");
    let err = adjust::parse_cube(b"LUT_3D_SIZE 2\n0 0 0\n").unwrap_err();
    assert!(err.starts_with("line 3:"), "{err}");
    let lut = adjust::parse_cube(b"# c\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n").unwrap();
    assert_eq!((lut.size, lut.one_d, lut.data.len()), (2, false, 24));
    let err = adjust::parse_3dl(b"0 1023\n0 0 0\nfoo 1 2\n").unwrap_err();
    assert!(err.starts_with("line 3:"), "{err}");
}

#[test]
fn a_color_lookup_renders_its_cube() {
    // An inverting 3D table: every node maps to 1 - its input.
    let mut cube = String::from("LUT_3D_SIZE 2\n");
    for b in 0..2 {
        for g in 0..2 {
            for r in 0..2 {
                cube += &format!("{} {} {}\n", 1 - r, 1 - g, 1 - b);
            }
        }
    }
    let mut d = Document::new(4, 4, 8).unwrap();
    d.fill(1, Target::Pixels, 200, 100, 0, 255).unwrap();
    let blob = d.blob_add(cube.as_bytes()).unwrap();
    for interp in ["tetrahedral", "trilinear"] {
        let a = special(&mut d, 1, json!({ "name": "L", "adjustment": kind("color_lookup", json!({ "name": "inv.cube", "format": "cube", "table": blob, "interpolation": interp, "dither": false })) }));
        assert_eq!(px(&d, 1, 1), [55, 155, 255, 255], "{interp}");
        d.delete_node(a).unwrap();
    }
}

#[test]
fn neutral_params_emit_no_adjust_step() {
    let identity = kind("curves", json!({ "mode": "point", "composite": [[0, 0], [255, 255]], "red": null, "green": null, "blue": null }));
    for a in [bc(0.0, 0.0, false), levels(0, 255, 1.0), identity, hue_sat(0.0), kind("exposure", json!({ "exposure": 0.0, "offset": 0.0, "gamma": 1.0 }))] {
        let mut d = gray_doc(8, 8, 90);
        special(&mut d, 1, json!({ "name": "A", "adjustment": a.clone() }));
        let p = Program::decode(&d.display_program(0, 0, 0, &[]).unwrap());
        assert!(p.steps.iter().all(|s| s.op != Op::Adjust), "{a}");
    }
}

// ---------- styled layers on the compositor (docs/M3.md section 5) ----------

/// A pixel layer above `above` holding `rgba` on x in x0..x1, y in y0..y1.
fn rect_layer(d: &mut Document, above: u32, [x0, y0, x1, y1]: [usize; 4], rgba: [u8; 4]) -> u32 {
    let l = d.add_layer("r", above).unwrap();
    let (ntx, nty) = d.level_tiles(0);
    for ty in 0..nty {
        for tx in 0..ntx {
            let mut t = vec![0u8; TILE_BYTES_U8];
            let mut any = false;
            for p in 0..TILE_PIXELS {
                let (x, y) = (tx as usize * TILE + p % TILE, ty as usize * TILE + p / TILE);
                if x >= x0 && x < x1 && y >= y0 && y < y1 {
                    t[p * 4..p * 4 + 4].copy_from_slice(&rgba);
                    any = true;
                }
            }
            if any {
                d.set_tile_rgba8(l, tx, ty, &t).unwrap();
            }
        }
    }
    l
}

fn style_with(f: impl FnOnce(&mut Value)) -> String {
    let mut s: Value = serde_json::from_str(&overlay_style(true)).unwrap();
    s["color_overlays"] = json!([]);
    f(&mut s);
    s.to_string()
}

fn stroke_fx(size: f32, color: [u8; 3]) -> Value {
    json!({
        "present": true, "enabled": true, "size": size, "position": "outside", "blend": "normal",
        "opacity": 1.0, "overprint": false, "fill": { "type": "solid", "color": color }
    })
}

fn drop_fx(angle: f32, distance: f32, size: f32) -> Value {
    let mut s = shadow(true);
    s["use_global_light"] = false.into();
    s["angle"] = angle.into();
    s["distance"] = distance.into();
    s["size"] = size.into();
    s["spread"] = 0.0.into();
    s["noise"] = 0.0.into();
    s
}

fn overlay_fx(color: [u8; 3], opacity: f32) -> Value {
    json!({ "present": true, "enabled": true, "blend": "normal", "opacity": opacity, "color": color })
}

#[test]
fn styled_layer_goldens_through_the_compositor() {
    // Stroke outside 3 on a 10x10 square over transparency: 1 at 1..3 px outside, 0 at 4 px.
    let mut d = Document::new(40, 40, 8).unwrap();
    let l = rect_layer(&mut d, 1, [10, 10, 20, 20], [255, 0, 0, 255]);
    d.set_style(l, &style_with(|s| s["strokes"] = json!([stroke_fx(3.0, [0, 0, 0])]))).unwrap();
    let row: Vec<u8> = (5..11).map(|x| px(&d, x, 15)[3]).collect();
    assert_eq!(row, [0, 0, 255, 255, 255, 255]);
    assert_eq!(px(&d, 8, 15), [0, 0, 0, 255]);
    let col: Vec<u8> = (19..25).map(|y| px(&d, 15, y)[3]).collect();
    assert_eq!(col, [255, 255, 255, 255, 0, 0]);
    // Drop shadow angle 180 (global off), distance 5, size 0, multiply 0.75 black over white.
    let mut d = gray_doc(40, 40, 255);
    let l = rect_layer(&mut d, 1, [10, 10, 20, 20], [255, 0, 0, 255]);
    d.set_style(l, &style_with(|s| s["drop_shadows"] = json!([drop_fx(180.0, 5.0, 0.0)]))).unwrap();
    assert_eq!(px(&d, 19, 15), [255, 0, 0, 255]);
    assert_eq!(px(&d, 22, 15), [64, 64, 64, 255]);
    assert_eq!(px(&d, 24, 15), [64, 64, 64, 255]);
    assert_eq!(px(&d, 25, 15), [255, 255, 255, 255]);
    // Color overlay red at 0.25 over blue content.
    let mut d = gray_doc(40, 40, 255);
    let l = rect_layer(&mut d, 1, [10, 10, 20, 20], [0, 0, 255, 255]);
    d.set_style(l, &style_with(|s| s["color_overlays"] = json!([overlay_fx([255, 0, 0], 0.25)]))).unwrap();
    assert_eq!(px(&d, 15, 15), [64, 0, 191, 255]);
    assert_eq!(px(&d, 5, 5), [255, 255, 255, 255]);
}

fn fx_style() -> String {
    style_with(|s| {
        s["drop_shadows"] = json!([drop_fx(150.0, 6.0, 4.0)]);
        s["strokes"] = json!([stroke_fx(3.0, [0, 0, 0])]);
    })
}

#[test]
fn a_style_across_a_tile_border_renders_like_one_tile() {
    // The same square inside tile 0 and across x = 256: every pixel matches, shifted.
    let make = |x0: usize| {
        let mut d = Document::new(300, 40, 8).unwrap();
        let l = rect_layer(&mut d, 1, [x0, 12, x0 + 20, 28], [30, 160, 90, 255]);
        d.set_style(l, &fx_style()).unwrap();
        d
    };
    let (a, b) = (make(100), make(246));
    for y in 0..40 {
        for x in 80..145 {
            assert_eq!(px(&b, x + 146, y), px(&a, x, y), "x {x} y {y}");
        }
    }
    assert_eq!(px(&b, 256, 20), [30, 160, 90, 255]);
    assert_eq!(px(&b, 244, 20), [0, 0, 0, 255], "the stroke left of the square");
}

#[test]
fn a_styled_clip_base_draws_clipped_layers_over_its_style() {
    let mut d = gray_doc(40, 40, 255);
    let base = rect_layer(&mut d, 1, [10, 10, 20, 20], [255, 0, 0, 255]);
    let c = rect_layer(&mut d, base, [0, 0, 40, 15], [0, 0, 255, 255]);
    d.set_props(c, r#"{"clipping":true}"#).unwrap();
    assert_eq!(px(&d, 15, 12), [0, 0, 255, 255], "unstyled: the clipped layer shows");
    d.set_style(base, &style_with(|s| {
        s["strokes"] = json!([stroke_fx(2.0, [0, 0, 0])]);
        s["color_overlays"] = json!([overlay_fx([0, 255, 0], 0.5)]);
    }))
    .unwrap();
    // The clipped layer covers the styled base inside the raw shape; the overlay stays below it.
    assert_eq!(px(&d, 15, 12), [0, 0, 255, 255]);
    assert_eq!(px(&d, 15, 17), [128, 128, 0, 255]);
    // The outside stroke is past the raw shape: the clipped layer leaves it alone.
    assert_eq!(px(&d, 15, 9), [0, 0, 0, 255]);
    assert_eq!(px(&d, 9, 12), [0, 0, 0, 255]);
    assert_eq!(px(&d, 8, 15), [0, 0, 0, 255]);
    assert_eq!(px(&d, 7, 15), [255, 255, 255, 255]);
    assert_eq!(px(&d, 15, 5), [255, 255, 255, 255], "clipped pixels outside the base stay hidden");
    // Fill scales the base's content, not the clipped layer's coverage.
    d.set_props(base, r#"{"fill":0.1}"#).unwrap();
    assert_eq!(px(&d, 15, 12), [0, 0, 255, 255]);
    assert_eq!(px(&d, 15, 9), [0, 0, 0, 255]);
}

#[test]
fn a_clipped_adjustment_on_a_styled_base_mixes_by_the_shape_once() {
    let mut d = gray_doc(8, 8, 200);
    let base = d.add_layer("base", 1).unwrap();
    d.fill(base, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.set_props(base, r#"{"opacity":0.5}"#).unwrap();
    d.set_style(base, &overlay_style(true)).unwrap();
    let inv = json!({ "name": "Invert", "adjustment": { "kind": "invert", "params": {} } });
    let a = d.add_special(base, &inv.to_string()).unwrap();
    d.set_props(a, r#"{"clipping":true}"#).unwrap();
    // S = 0.5: dst + 0.5 (255 - 2 dst) = 127.5 on every channel, whatever dst is.
    for v in &px(&d, 3, 3)[..3] {
        assert!((127..=128).contains(v), "{:?}", px(&d, 3, 3));
    }
}

#[test]
fn a_styled_group_styles_its_composite() {
    let mut d = gray_doc(40, 40, 255);
    let a = rect_layer(&mut d, 1, [10, 10, 15, 20], [255, 0, 0, 255]);
    let b = rect_layer(&mut d, a, [15, 10, 20, 20], [0, 0, 255, 255]);
    let g = d.group_nodes(&[a, b]).unwrap();
    d.set_style(g, &style_with(|s| s["strokes"] = json!([stroke_fx(2.0, [0, 0, 0])]))).unwrap();
    let (k, w, r, u) = ([0, 0, 0, 255], [255; 4], [255, 0, 0, 255], [0, 0, 255, 255]);
    for blend in ["pass through", "normal"] {
        d.set_props(g, &json!({ "blend": blend }).to_string()).unwrap();
        let row: Vec<[u8; 4]> = (7..23).map(|x| px(&d, x, 15)).collect();
        assert_eq!(row, [w, k, k, r, r, r, r, r, u, u, u, u, u, k, k, w], "{blend}: no stroke between the children");
    }
}

fn styled_doc() -> Document {
    let mut d = gray_doc(600, 300, 255);
    let l = rect_layer(&mut d, 1, [240, 100, 280, 270], [30, 160, 90, 255]);
    d.set_style(l, &fx_style()).unwrap();
    d.set_blending(l, &blending_with(|b| b["knockout"] = "shallow".into())).unwrap();
    d.set_props(l, r#"{"opacity":0.8,"fill":0.6}"#).unwrap();
    let base = rect_layer(&mut d, l, [300, 20, 380, 280], [200, 0, 0, 200]);
    let c = rect_layer(&mut d, base, [300, 0, 600, 150], [0, 0, 255, 255]);
    d.set_props(c, r#"{"clipping":true}"#).unwrap();
    let mut g = glow("edge", json!({ "type": "color", "color": [255, 255, 0] }));
    g["enabled"] = true.into();
    d.set_style(base, &style_with(|s| s["outer_glow"] = g)).unwrap();
    let a = rect_layer(&mut d, c, [420, 240, 520, 290], [90, 90, 0, 255]);
    let b = rect_layer(&mut d, a, [500, 250, 590, 280], [0, 90, 90, 255]);
    let g = d.group_nodes(&[a, b]).unwrap();
    d.set_style(g, &style_with(|s| s["drop_shadows"] = json!([drop_fx(90.0, 9.0, 3.0)]))).unwrap();
    d
}

#[test]
fn styled_programs_match_the_display_tile_at_levels_0_and_2() {
    let d = styled_doc();
    let p = Program::decode(&d.display_program(0, 0, 0, &[]).unwrap());
    assert!(p.steps.iter().any(|s| s.op == Op::Knockout));
    for level in [0, 2] {
        let (ntx, nty) = d.level_tiles(level);
        for ty in 0..nty {
            for tx in 0..ntx {
                let bytes = d.display_program(level, tx, ty, &[]).unwrap();
                let run = Document::run_program(&Program::decode(&bytes));
                assert_eq!(quantize_premul(&run), d.display_tile(level, tx, ty).unwrap(), "level {level} tile ({tx}, {ty})");
            }
        }
    }
}

#[test]
fn styled_payload_keys_follow_the_style() {
    let mut d = gray_doc(64, 64, 255);
    let l = rect_layer(&mut d, 1, [10, 10, 20, 20], [255, 0, 0, 255]);
    d.set_style(l, &fx_style()).unwrap();
    let keys = |d: &Document| {
        Program::decode(&d.display_program(0, 0, 0, &[]).unwrap()).payloads.iter().map(|p| p.0).collect::<Vec<_>>()
    };
    let first = keys(&d);
    assert_eq!(first.len(), 3, "background, shadow and content");
    assert_eq!(keys(&d), first, "the same style gives the same keys");
    d.set_style(l, &style_with(|s| s["strokes"] = json!([stroke_fx(4.0, [0, 0, 0])]))).unwrap();
    assert_ne!(keys(&d), first);
}

// ---------- layer comps (M3.md section 8) ----------

#[test]
fn layer_comp_capture_and_apply_restores_visibility_position_opacity_fill_blend_and_style() {
    let mut d = gray_doc(64, 64, 200);
    let l = rect_layer(&mut d, 1, [10, 10, 20, 20], [255, 0, 0, 255]);
    d.set_style(l, &overlay_style(true)).unwrap();
    let g = d.add_group("g", 0).unwrap();
    let comp = d.capture_layer_comp("Layer Comp 1").unwrap();
    assert_eq!(comp, 1);

    d.set_props(l, r#"{"visible":false,"opacity":0.4,"fill":0.3,"blend":"multiply"}"#).unwrap();
    d.offset_layer(l, 5, 7).unwrap();
    d.set_style(l, &overlay_style(false)).unwrap();
    assert!(d.layer_bounds(g).is_err(), "an empty group has no pixel bounds to move");

    d.apply_layer_comp(comp).unwrap();
    let n = d.node(l).unwrap();
    assert!(n.visible);
    assert_eq!((n.opacity, n.fill, n.blend), (1.0, 1.0, Blend::Normal));
    assert_eq!(n.style, Some(serde_json::from_str(&overlay_style(true)).unwrap()));
    assert_eq!(d.layer_bounds(l).unwrap(), Some([10, 10, 10, 10]), "position restored");

    assert_eq!(d.apply_layer_comp(999).unwrap_err(), "unknown layer comp 999");
}

#[test]
fn layer_comp_flags_off_skip_their_part_and_a_deleted_layer_is_skipped() {
    let mut d = gray_doc(64, 64, 200);
    let a = rect_layer(&mut d, 1, [0, 0, 5, 5], [255, 0, 0, 255]);
    let b = rect_layer(&mut d, 1, [30, 30, 35, 35], [0, 255, 0, 255]);
    let comp = d.capture_layer_comp("Layer Comp 1").unwrap();
    d.update_layer_comp(comp, &json!({ "apply_position": false, "apply_appearance": false }).to_string()).unwrap();

    d.set_props(a, r#"{"visible":false,"opacity":0.5}"#).unwrap();
    d.offset_layer(a, 1, 1).unwrap();
    d.delete_node(b).unwrap();

    d.apply_layer_comp(comp).unwrap();
    let n = d.node(a).unwrap();
    assert!(n.visible, "visibility flag stayed on");
    assert_eq!(n.opacity, 0.5, "appearance flag off: opacity untouched");
    assert_eq!(d.layer_bounds(a).unwrap(), Some([1, 1, 5, 5]), "position flag off: no move");
    assert!(d.node(b).is_err(), "a layer deleted since capture stays deleted, no error");
}

#[test]
fn layer_comp_apply_skips_the_position_of_locked_and_non_pixel_layers() {
    let mut d = gray_doc(64, 64, 200);
    let a = rect_layer(&mut d, 1, [0, 0, 5, 5], [255, 0, 0, 255]);
    let b = rect_layer(&mut d, a, [10, 10, 15, 15], [0, 255, 0, 255]);
    let g = d.add_group("g", 0).unwrap();
    let comp = d.capture_layer_comp("Layer Comp 1").unwrap();
    d.layer_comps[0].layers.iter_mut().find(|l| l.id == g).unwrap().position = Some([1, 1]);
    d.offset_layer(a, 3, 3).unwrap();
    d.offset_layer(b, 3, 3).unwrap();
    d.set_props(a, r#"{"opacity":0.5,"locks":{"position":true}}"#).unwrap();
    d.set_props(b, r#"{"opacity":0.5,"locks":{"pixels":true}}"#).unwrap();

    d.apply_layer_comp(comp).unwrap();
    assert_eq!(d.layer_bounds(a).unwrap(), Some([3, 3, 5, 5]), "a position-locked layer stays put");
    assert_eq!(d.layer_bounds(b).unwrap(), Some([13, 13, 5, 5]), "a pixel-locked layer stays put");
    assert_eq!((d.node(a).unwrap().opacity, d.node(b).unwrap().opacity), (1.0, 1.0), "appearance still applies");
}

#[test]
fn layer_comp_options_rename_and_delete() {
    let mut d = gray_doc(8, 8, 90);
    let comp = d.capture_layer_comp("Layer Comp 1").unwrap();
    d.update_layer_comp(comp, &json!({ "name": "Home", "comment": "start" }).to_string()).unwrap();
    let c = d.layer_comps.iter().find(|c| c.id == comp).unwrap();
    assert_eq!((c.name.as_str(), c.comment.as_str()), ("Home", "start"));
    assert_eq!(d.update_layer_comp(999, "{}").unwrap_err(), "unknown layer comp 999");

    d.delete_layer_comp(comp).unwrap();
    assert!(d.layer_comps.is_empty());
    assert_eq!(d.delete_layer_comp(comp).unwrap_err(), "unknown layer comp 1");
}

// ---------- adjustments UI: destructive apply and set_adjustment (M3.md section 3, B5) ----------

fn invert_json() -> Value {
    json!({ "kind": "invert", "params": {} })
}

#[test]
fn apply_adjustment_out_of_range_field_names_it_and_leaves_pixels_untouched() {
    let mut d = gray_doc(8, 8, 200);
    let bad = json!({ "kind": "brightness_contrast", "params": { "brightness": 200.0, "contrast": 0.0, "legacy": false } });
    let err = d.apply_adjustment(1, Target::Pixels, &bad.to_string()).unwrap_err();
    assert!(err.contains("brightness"), "{err}");
    assert_eq!(px(&d, 3, 3), [200, 200, 200, 255], "a rejected apply changes nothing");

    let bad = json!({ "kind": "threshold", "params": { "level": 0 } });
    assert!(d.apply_adjustment(1, Target::Pixels, &bad.to_string()).unwrap_err().contains("level"));
    let bad = json!({ "kind": "posterize", "params": { "levels": 1 } });
    assert!(d.apply_adjustment(1, Target::Pixels, &bad.to_string()).unwrap_err().contains("levels"));
    let bad = json!({ "kind": "exposure", "params": { "exposure": 100.0, "offset": 0.0, "gamma": 1.0 } });
    assert!(d.apply_adjustment(1, Target::Pixels, &bad.to_string()).unwrap_err().contains("exposure"));
}

#[test]
fn apply_adjustment_half_coverage_selection_mixes_half_way() {
    let mut d = gray_doc(8, 8, 200);
    d.fill(0, Target::Selection, 128, 128, 128, 255).unwrap(); // uniform ~50% coverage
    d.apply_adjustment(1, Target::Pixels, &invert_json().to_string()).unwrap();
    assert_eq!(px(&d, 3, 3), [127, 127, 127, 255], "200 and its invert 55 average to the midpoint");
}

#[test]
fn apply_adjustment_alpha_untouched_and_requires_pixels_target() {
    let mut d = Document::new(4, 4, 8).unwrap();
    d.fill(1, Target::Pixels, 200, 200, 200, 128).unwrap();
    d.apply_adjustment(1, Target::Pixels, &invert_json().to_string()).unwrap();
    assert_eq!(px(&d, 1, 1), [55, 55, 55, 128], "straight color inverted, alpha kept");

    let err = d.apply_adjustment(1, Target::Mask, &invert_json().to_string()).unwrap_err();
    assert!(err.contains("pixels"), "{err}");
}

#[test]
fn set_adjustment_refuses_other_kinds_and_validates() {
    let mut d = gray_doc(8, 8, 200);
    let a = invert(&mut d, 1);
    let err = d.set_adjustment(1, &json!({ "kind": "invert", "params": {} }).to_string()).unwrap_err();
    assert!(err.contains("pixel") && err.contains('1'), "{err}");

    let bad = json!({ "kind": "threshold", "params": { "level": 0 } });
    assert!(d.set_adjustment(a, &bad.to_string()).unwrap_err().contains("level"));

    d.set_adjustment(a, &json!({ "kind": "posterize", "params": { "levels": 4 } }).to_string()).unwrap();
    let Kind::Adjustment(p) = &d.node(a).unwrap().kind else { panic!("still an adjustment layer") };
    assert_eq!(*p, Adjustment::Posterize(crate::adjust::Posterize { levels: 4 }));
}

#[test]
fn histogram_counts_luminosity_and_channels_of_opaque_pixels() {
    let mut d = Document::new(4, 4, 8).unwrap();
    assert!(d.histogram(1).unwrap().iter().all(|&n| n == 0), "transparent pixels are not counted");
    assert!(d.histogram(0).unwrap().iter().all(|&n| n == 0));
    d.fill(1, Target::Pixels, 200, 100, 0, 255).unwrap();
    for id in [1, 0] {
        let h = d.histogram(id).unwrap();
        assert_eq!(h.len(), 4 * 256);
        // Lum = 0.3r + 0.59g + 0.11b = 119; then R, G, B.
        assert_eq!((h[119], h[256 + 200], h[512 + 100], h[768]), (16, 16, 16, 16), "id {id}");
        assert_eq!(h.iter().sum::<u32>(), 64, "id {id}");
    }
    let a = invert(&mut d, 1);
    assert_eq!(d.histogram(0).unwrap()[256 + 55], 16, "the composite includes adjustments");
    assert!(d.histogram(a).unwrap_err().contains("no pixels"));
}

#[test]
fn curves_point_mode_caps_at_16_points_and_pencil_takes_256_samples() {
    let mut d = gray_doc(4, 4, 100);
    let a = invert(&mut d, 1);
    let samples: Vec<[u8; 2]> = (0..=255).map(|i| [i as u8, 255 - i as u8]).collect();
    let curves = |mode: &str, pts: &[[u8; 2]]| json!({ "kind": "curves", "params": { "mode": mode, "composite": pts } }).to_string();
    let err = d.set_adjustment(a, &curves("point", &samples)).unwrap_err();
    assert!(err.contains("between 1 and 16"), "{err}");
    d.set_adjustment(a, &curves("pencil", &samples)).unwrap();
    assert_eq!(px(&d, 1, 1)[0], 155);
    assert!(d.set_adjustment(a, &curves("pencil", &[])).unwrap_err().contains("between 1 and 256"));
}

fn flat(d: &Document) -> Vec<u8> {
    let (ntx, nty) = d.level_tiles(0);
    (0..nty).flat_map(|ty| (0..ntx).flat_map(move |tx| d.flatten_tile_rgba8(tx, ty).unwrap())).collect()
}

#[test]
fn scale_effects_scales_every_px_parameter() {
    let make = |k: f32, scale: f32| {
        let mut d = gray_doc(60, 60, 255);
        let l = rect_layer(&mut d, 1, [20, 20, 40, 40], [255, 0, 0, 255]);
        d.set_style(l, &style_with(|s| {
            s["strokes"] = json!([stroke_fx(3.0 * k, [0, 0, 255])]);
            s["drop_shadows"] = json!([drop_fx(150.0, 3.0 * k, 2.0 * k)]);
        }))
        .unwrap();
        d.scale_effects(l, scale).unwrap();
        assert_eq!(d.node(l).unwrap().style.as_ref().unwrap().scale, scale);
        d
    };
    let (a, b) = (make(1.0, 2.0), make(2.0, 1.0));
    assert_eq!(px(&a, 15, 30), [0, 0, 255, 255], "stroke 3 at scale 2 reaches 6 px out");
    assert_eq!(flat(&a), flat(&b));
    let mut d = gray_doc(8, 8, 255);
    assert!(d.scale_effects(1, 2.0).unwrap_err().contains("no layer style"));
    d.set_style(1, &overlay_style(true)).unwrap();
    assert!(d.scale_effects(1, 11.0).unwrap_err().contains("1 % and 1000 %"));
    assert!(d.scale_effects(1, 0.001).is_err());
}

#[test]
fn hide_all_effects_toggles_every_styled_layer() {
    let mut d = gray_doc(8, 8, 255);
    let a = d.add_layer("a", 1).unwrap();
    let b = d.add_layer("b", a).unwrap();
    d.set_style(1, &overlay_style(true)).unwrap();
    d.set_style(b, &overlay_style(true)).unwrap();
    let on = |d: &Document, id: u32| d.node(id).unwrap().style.as_ref().unwrap().enabled;
    assert!(!d.hide_all_effects().unwrap());
    assert!(!on(&d, 1) && !on(&d, b));
    assert!(d.node(a).unwrap().style.is_none());
    // With every style off the command shows them all again; one on hides them all.
    assert!(d.hide_all_effects().unwrap());
    assert!(on(&d, 1) && on(&d, b));
    let mut s = d.node(1).unwrap().style.clone().unwrap();
    s.enabled = false;
    d.set_style(1, &serde_json::to_string(&s).unwrap()).unwrap();
    assert!(!d.hide_all_effects().unwrap());
    assert!(!on(&d, 1) && !on(&d, b));
    assert!(Document::new(8, 8, 8).unwrap().hide_all_effects().unwrap_err().contains("no layer has layer effects"));
}

#[test]
fn copy_paste_and_clear_style_carry_the_style_only() {
    let mut d = gray_doc(8, 8, 255);
    let a = d.add_layer("a", 1).unwrap();
    let b = d.add_layer("b", a).unwrap();
    d.set_style(1, &overlay_style(true)).unwrap();
    d.set_blending(1, &blending_with(|v| v["knockout"] = "shallow".into())).unwrap();
    d.set_props(1, r#"{"fill":0.5}"#).unwrap();
    let json = d.copy_style(1).unwrap();
    assert!(d.copy_style(a).unwrap_err().contains("no layer style"));
    d.paste_style(&[a, b], &json).unwrap();
    for id in [a, b] {
        let n = d.node(id).unwrap();
        assert_eq!(n.style, d.node(1).unwrap().style);
        assert_eq!(n.blending, Blending::default(), "blending options never travel");
        assert_eq!(n.fill, 1.0);
    }
    // Deep copies: editing one pasted style leaves the other.
    d.scale_effects(a, 3.0).unwrap();
    assert_eq!(d.node(b).unwrap().style.as_ref().unwrap().scale, 1.0);
    d.clear_style(a).unwrap();
    assert!(d.node(a).unwrap().style.is_none());
    assert_eq!(d.node(1).unwrap().blending.knockout, Knockout::Shallow);
    // A refused target leaves every layer as it was.
    let inv = invert(&mut d, b);
    let before = d.node(a).unwrap().style.clone();
    assert!(d.paste_style(&[a, inv], &json).unwrap_err().contains("adjustment layer"));
    assert_eq!(d.node(a).unwrap().style, before);
}

#[test]
fn style_commands_refuse_fully_locked_layers() {
    let mut d = gray_doc(8, 8, 255);
    d.set_style(1, &overlay_style(true)).unwrap();
    d.set_props(1, r#"{"locks":{"transparency":true,"pixels":true,"position":true}}"#).unwrap();
    let json = d.copy_style(1).unwrap();
    for e in [
        d.clone().paste_style(&[1], &json).unwrap_err(),
        d.clone().clear_style(1).unwrap_err(),
        d.clone().scale_effects(1, 2.0).unwrap_err(),
        d.clone().create_layers_from_style(1).unwrap_err(),
    ] {
        assert!(e.contains("fully locked"), "{e}");
    }
    // Partial locks do not refuse.
    d.set_props(1, r#"{"locks":{"position":false}}"#).unwrap();
    d.clear_style(1).unwrap();
}

#[test]
fn create_layers_splits_behind_planes_and_keeps_the_render() {
    // A square across the tile border at x = 256 with every behind kind and interior effects.
    let mut d = gray_doc(300, 60, 200);
    let l = rect_layer(&mut d, 1, [240, 15, 270, 45], [30, 160, 90, 255]);
    let mut glow = glow("edge", json!({ "type": "color", "color": [255, 255, 0] }));
    glow["enabled"] = true.into();
    glow["jitter"] = 0.0.into();
    d.set_style(l, &style_with(|s| {
        s["drop_shadows"] = json!([drop_fx(150.0, 6.0, 4.0), drop_fx(30.0, 3.0, 0.0)]);
        s["outer_glow"] = glow;
        s["strokes"] = json!([stroke_fx(2.0, [0, 0, 255])]);
        s["color_overlays"] = json!([overlay_fx([255, 0, 0], 0.5)]);
    }))
    .unwrap();
    d.set_props(l, r#"{"fill":0.6,"opacity":0.9,"name":"Sq"}"#).unwrap();
    let before = flat(&d);
    let ids = d.create_layers_from_style(l).unwrap();
    assert_eq!(ids.len(), 3, "one layer per behind plane");
    let names: Vec<String> = ids.iter().map(|&i| d.node(i).unwrap().name.clone()).collect();
    assert_eq!(names, ["Sq's Drop Shadow", "Sq's Drop Shadow 2", "Sq's Outer Glow"]);
    let n = d.node(ids[2]).unwrap();
    assert_eq!((n.blend, n.opacity), (Blend::Screen, 0.75 * 0.9));
    let n = d.node(l).unwrap();
    assert!(n.style.is_none() && n.mask.is_none());
    assert_eq!((n.fill, n.opacity), (1.0, 0.9));
    // Draw order: the behind layers sit directly below, in plane order.
    let order: Vec<u32> = d.nodes.iter().map(|n| n.id).collect();
    assert_eq!(order, [1, ids[0], ids[1], ids[2], l]);
    let after = flat(&d);
    let worst = before.iter().zip(&after).map(|(a, b)| a.abs_diff(*b)).max().unwrap();
    assert!(worst <= 1, "flattened result moved by {worst}");
    assert!(d.create_layers_from_style(l).unwrap_err().contains("no layer effects"));
}

// ---------- destructive-only adjustments (M3.md section 3 kinds 17-25, B6) ----------

// A w x h document whose layer 1 holds `rgb` (3 bytes per pixel, row-major) at full alpha.
fn rgb_doc(w: usize, h: usize, rgb: &[u8]) -> Document {
    let mut d = Document::new(w as u32, h as u32, 8).unwrap();
    let mut t = vec![0u8; TILE_BYTES_U8];
    for (i, c) in rgb.chunks_exact(3).enumerate() {
        let o = ((i / w) * TILE + i % w) * 4;
        t[o..o + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
    }
    d.set_tile_rgba8(1, 0, 0, &t).unwrap();
    d
}

fn destructive(d: &mut Document, kind: &str, params: Value) {
    d.apply_destructive(1, &json!({ "kind": kind, "params": params }).to_string()).unwrap();
}

fn shadows_highlights() -> Value {
    json!({
        "shadows": { "amount": 35.0, "tone": 50.0, "radius": 30.0 },
        "highlights": { "amount": 0.0, "tone": 50.0, "radius": 30.0 },
        "color_correction": 20.0, "midtone_contrast": 0.0, "black_clip": 0.01, "white_clip": 0.01
    })
}

#[test]
fn desaturate_takes_the_mean_of_max_and_min() {
    let mut d = rgb_doc(2, 2, &[200, 100, 50].repeat(4));
    destructive(&mut d, "desaturate", json!({}));
    assert_eq!(px(&d, 1, 1), [125, 125, 125, 255]);
}

#[test]
fn equalize_maps_a_two_value_image_to_black_and_white() {
    let mut d = rgb_doc(4, 1, &[[60; 3], [60; 3], [180; 3], [180; 3]].concat());
    destructive(&mut d, "equalize", json!({}));
    assert_eq!((px(&d, 0, 0), px(&d, 3, 0)), ([0, 0, 0, 255], [255, 255, 255, 255]));
}

#[test]
fn equalize_builds_its_histogram_over_the_selection_region() {
    let mut d = rgb_doc(6, 1, &[[60; 3], [60; 3], [120; 3], [120; 3], [180; 3], [180; 3]].concat());
    d.select_rect(0.0, 0.0, 4.0, 1.0, Mode::New).unwrap();
    destructive(&mut d, "equalize", json!({}));
    let row: Vec<u8> = (0..6).map(|x| px(&d, x, 0)[0]).collect();
    assert_eq!(row, [0, 0, 255, 255, 180, 180], "180 is outside the region and the selection");
}

#[test]
fn auto_contrast_stretches_a_50_to_200_ramp_to_full_range() {
    let ramp: Vec<u8> = (50..=200u8).flat_map(|v| [v; 3]).collect();
    let mut d = rgb_doc(151, 1, &ramp);
    destructive(&mut d, "auto_contrast", json!({}));
    let row: Vec<u8> = (0..151).map(|x| px(&d, x, 0)[0]).collect();
    assert_eq!((row[0], row[150]), (0, 255));
    assert!(row.windows(2).all(|w| w[0] <= w[1]), "monotonic");
    assert_eq!(row[75], ((125.0 - 50.0) / 150.0 * 255.0f64).round() as u8);
}

#[test]
fn auto_tone_stretches_each_channel_and_auto_color_moves_the_median_to_128() {
    let px5 = [[0, 10, 20], [10, 20, 30], [20, 30, 40], [30, 40, 50], [255, 240, 230]];
    let mut d = rgb_doc(5, 1, &px5.concat());
    destructive(&mut d, "auto_tone", json!({}));
    assert_eq!(px(&d, 0, 0), [0, 0, 0, 255]);
    assert_eq!(px(&d, 4, 0), [255, 255, 255, 255]);

    let mut d = rgb_doc(5, 1, &[[0; 3], [10; 3], [20; 3], [30; 3], [255; 3]].concat());
    destructive(&mut d, "auto_color", json!({}));
    let row: Vec<u8> = (0..5).map(|x| px(&d, x, 0)[0]).collect();
    assert_eq!((row[0], row[2], row[4]), (0, 128, 255), "median 20 lands on the 128 target");
}

#[test]
fn shadows_highlights_defaults_lift_gray_02_to_03305() {
    let mut d = rgb_doc(2, 2, &[51; 12]);
    destructive(&mut d, "shadows_highlights", shadows_highlights());
    assert_eq!(px(&d, 0, 0), [84, 84, 84, 255], "0.3305 * 255 = 84.3");
    let kind = serde_json::from_value(json!({ "kind": "shadows_highlights", "params": shadows_highlights() })).unwrap();
    let mut buf = [0.2, 0.2, 0.2, 1.0].repeat(4);
    crate::adjust::destructive(&kind, &mut buf, 2, 2);
    assert!((buf[0] - 0.3305).abs() < 1e-4, "{}", buf[0]);
}

#[test]
fn hdr_toning_matches_the_independent_node_reference() {
    let r: Value = serde_json::from_str(include_str!("testdata/hdr_toning.json")).unwrap();
    let (w, h) = (r["w"].as_u64().unwrap() as usize, r["h"].as_u64().unwrap() as usize);
    let input: Vec<u8> = r["input"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap() as u8).collect();
    for case in r["cases"].as_array().unwrap() {
        let mut d = rgb_doc(w, h, &input);
        destructive(&mut d, "hdr_toning", case["params"].clone());
        let want = case["out"].as_array().unwrap();
        let mut worst = 0;
        for i in 0..w * h {
            let got = px(&d, i % w, i / w);
            for ch in 0..3 {
                worst = worst.max(got[ch].abs_diff(want[i * 3 + ch].as_u64().unwrap() as u8));
            }
        }
        assert!(worst <= 1, "{}: max diff {worst}/255", case["name"]);
    }
}

#[test]
fn destructive_half_coverage_selection_mixes_half_way() {
    let mut d = rgb_doc(4, 4, &[200, 100, 50].repeat(16));
    d.fill(0, Target::Selection, 128, 128, 128, 255).unwrap(); // coverage 128/255
    destructive(&mut d, "desaturate", json!({}));
    assert_eq!(px(&d, 2, 2), [162, 113, 88, 255], "halfway to 125 gray");
}

#[test]
fn match_color_neutralize_and_fade() {
    let params = |fade: f32| json!({ "luminance": 100.0, "color_intensity": 100.0, "fade": fade, "neutralize": true });
    let mut d = rgb_doc(2, 2, &[200, 100, 50].repeat(4));
    destructive(&mut d, "match_color", params(0.0));
    assert_eq!(px(&d, 0, 0), [117, 117, 117, 255], "every channel moves to the mean of the means");
    let mut d = rgb_doc(2, 2, &[200, 100, 50].repeat(4));
    destructive(&mut d, "match_color", params(50.0));
    assert_eq!(px(&d, 0, 0), [158, 108, 83, 255]);
}

#[test]
fn replace_color_shifts_the_matching_hue_only() {
    let mut d = rgb_doc(2, 1, &[255, 0, 0, 0, 0, 255]);
    let p = json!({ "target_color": [255, 0, 0], "fuzziness": 40.0, "range": 0.0, "localized": false, "hue": 120.0, "saturation": 0.0, "lightness": 0.0 });
    destructive(&mut d, "replace_color", p);
    assert_eq!((px(&d, 0, 0), px(&d, 1, 0)), ([0, 255, 0, 255], [0, 0, 255, 255]));
}

#[test]
fn destructive_alpha_untouched_and_params_validated() {
    let mut d = Document::new(4, 4, 8).unwrap();
    d.fill(1, Target::Pixels, 200, 100, 50, 128).unwrap();
    destructive(&mut d, "desaturate", json!({}));
    let t = d.node(1).unwrap().pixel_tiles().unwrap().get(0, 0).unwrap().px.rgba_f32(0);
    assert_eq!(t.map(|v| (v * 255.0).round() as u8), [125, 125, 125, 128]);

    let mut bad = shadows_highlights();
    bad["shadows"]["amount"] = 150.0.into();
    let err = d.apply_destructive(1, &json!({ "kind": "shadows_highlights", "params": bad }).to_string()).unwrap_err();
    assert!(err.contains("shadows.amount"), "{err}");
    let hdr = json!({ "kind": "hdr_toning", "params": { "method": "local_adaptation", "radius": 16.0, "strength": 0.5, "detail": 30.0,
        "shadow": 0.0, "highlight": 0.0, "exposure": 0.0, "gamma": 0.0, "vibrance": 20.0, "saturation": 20.0 } });
    assert!(d.apply_destructive(1, &hdr.to_string()).unwrap_err().contains("gamma"));
    assert!(d.apply_destructive(1, r#"{"kind":"invert","params":{}}"#).unwrap_err().contains("invalid"));
}
