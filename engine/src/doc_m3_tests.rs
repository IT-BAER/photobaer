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
        json!({ "kind": "brightness_contrast", "params": { "brightness": 150.0, "contrast": -50.0, "legacy": true } }),
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
fn v4_fixture() -> Value {
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

fn load(json: &str) -> Result<Document, String> {
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
    assert_eq!(norm(&serde_json::from_str(&first).unwrap()), norm(&v4_fixture()), "no field is dropped or changed");
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
    for k in ["global_light", "patterns", "layer_comps", "blobs"] {
        v.as_object_mut().unwrap().remove(k);
    }
    for k in ["style", "blending"] {
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
    assert_eq!(m["version"], 4);
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
