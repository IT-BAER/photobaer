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
fn a_styled_clipping_base_drops_its_knockout() {
    let mut d = gray_doc(8, 8, 200);
    let l = d.add_layer("base", 1).unwrap();
    d.fill(l, Target::Pixels, 255, 0, 0, 128).unwrap();
    d.set_blending(l, &blending_with(|b| b["knockout"] = "shallow".into())).unwrap();
    d.set_style(l, &overlay_style(true)).unwrap();
    let c = d.add_layer("clipped", l).unwrap();
    d.fill(c, Target::Pixels, 0, 0, 255, 255).unwrap();
    d.set_props(c, r#"{"clipping":true}"#).unwrap();
    // A knockout would leave the backdrop at alpha 0.5 under the half-covering base (191).
    assert_eq!(px(&d, 1, 1)[3], 255);
    d.set_props(c, r#"{"clipping":false,"visible":false}"#).unwrap();
    assert_eq!(px(&d, 1, 1)[3], 191, "unclipped, the same layer knocks out");
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
    d
}

#[test]
fn program_v2_round_trips_and_matches_the_display_tile() {
    let d = v2_doc();
    let bytes = d.display_program(0, 0, 0, &[]).unwrap();
    assert_eq!(u32::from_le_bytes(bytes[0..4].try_into().unwrap()), 2, "program version");
    let p = Program::decode(&bytes);
    let adjusts: Vec<&Step> = p.steps.iter().filter(|s| s.op == Op::Adjust).collect();
    assert_eq!(adjusts.len(), 2);
    assert!(p.steps.iter().any(|s| s.op == Op::Knockout));
    assert_eq!(adjusts[0].opcode, adjust::OP_INVERT);
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
