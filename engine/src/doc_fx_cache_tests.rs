//! Layer effects cached in layer space: a moved layer reuses its effect planes, and every tile
//! matches the per-document-tile path (`FX_LEGACY`).

use super::compositor::{FX_LEGACY, FX_RENDERS};
use super::*;
use serde_json::{json, Value};

const W: u32 = 600;
const H: u32 = 500;

fn contour() -> Value {
    json!({ "name": "Linear", "points": [[0.0, 0.0], [255.0, 255.0]], "mode": "point", "anti_alias": false })
}

fn gradient(align: bool) -> Value {
    json!({
        "gradient": {
            "method": "classic",
            "color_stops": [
                { "position": 0.0, "color": [255, 0, 0], "midpoint": 0.5 },
                { "position": 1.0, "color": [0, 0, 255], "midpoint": 0.5 }
            ],
            "opacity_stops": [
                { "position": 0.0, "opacity": 1.0, "midpoint": 0.5 },
                { "position": 1.0, "opacity": 0.5, "midpoint": 0.5 }
            ]
        },
        "style": "linear", "angle": 30.0, "scale": 1.0, "reverse": false, "dither": false,
        "align_with_layer": align, "offset": [0.0, 0.0]
    })
}

fn pattern(linked: bool) -> Value {
    json!({ "pattern_id": "p", "scale": 1.0, "angle": 0.0, "linked": linked, "offset": [0.0, 0.0] })
}

fn shadow(noise: f64) -> Value {
    json!({
        "present": true, "enabled": true, "blend": "multiply", "opacity": 0.75, "color": [0, 0, 0],
        "use_global_light": true, "angle": 120.0, "distance": 4.0, "spread": 0.2, "size": 6.0,
        "contour": contour(), "noise": noise, "knocks_out": false
    })
}

fn glow(technique: &str, source: &str) -> Value {
    json!({
        "present": true, "enabled": true, "blend": "screen", "opacity": 0.8,
        "fill": { "type": "color", "color": [255, 255, 0] }, "technique": technique, "spread": 0.1,
        "size": 6.0, "range": 0.5, "jitter": 0.0, "noise": 0.0, "contour": contour(), "source": source
    })
}

fn stroke(position: &str, fill: Value) -> Value {
    json!({
        "present": true, "enabled": true, "size": 3.0, "position": position, "blend": "normal",
        "opacity": 1.0, "overprint": false, "fill": fill
    })
}

fn bevel(style: &str, technique: &str) -> Value {
    json!({
        "present": true, "enabled": true, "style": style, "technique": technique, "depth": 1.0,
        "direction": "up", "size": 5.0, "soften": 1.0, "use_global_light": true, "angle": 60.0,
        "altitude": 30.0, "gloss_contour": contour(), "highlight_blend": "screen",
        "highlight_color": [255, 255, 255], "highlight_opacity": 0.75, "shadow_blend": "multiply",
        "shadow_color": [0, 0, 0], "shadow_opacity": 0.75
    })
}

/// A style with no effects, then `f`.
fn style(f: impl Fn(&mut Value)) -> String {
    let mut s = json!({
        "enabled": true, "scale": 1.0, "drop_shadows": [], "inner_shadows": [], "color_overlays": [],
        "gradient_overlays": [], "pattern_overlays": [], "strokes": [], "outer_glow": null, "inner_glow": null,
        "bevel": null, "contour": null, "texture": null, "satin": null
    });
    f(&mut s);
    s.to_string()
}

fn overlay(v: Value, key: &str) -> Value {
    let mut o = json!({ "present": true, "enabled": true, "blend": "normal", "opacity": 0.7 });
    o[key] = v;
    o
}

/// Every effect alone, some together, and the cases that stay on the per-tile path.
fn styles() -> Vec<(&'static str, String)> {
    let mut grad = gradient(true);
    grad["type"] = "gradient".into();
    let mut pat = pattern(true);
    pat["type"] = "pattern".into();
    vec![
        ("drop shadow", style(|s| s["drop_shadows"] = json!([shadow(0.0)]))),
        ("outer glow precise", style(|s| s["outer_glow"] = glow("precise", "edge"))),
        ("outer glow softer", style(|s| s["outer_glow"] = glow("softer", "edge"))),
        ("inner glow center", style(|s| s["inner_glow"] = glow("precise", "center"))),
        ("stroke outside", style(|s| s["strokes"] = json!([stroke("outside", json!({ "type": "solid", "color": [0, 128, 0] }))]))),
        ("stroke inside gradient", style(|s| s["strokes"] = json!([stroke("inside", grad.clone())]))),
        ("stroke center pattern", style(|s| s["strokes"] = json!([stroke("center", pat.clone())]))),
        ("bevel inner smooth", style(|s| s["bevel"] = bevel("inner", "smooth"))),
        ("bevel outer chisel", style(|s| s["bevel"] = bevel("outer", "chisel_hard"))),
        ("satin", style(|s| {
            s["satin"] = json!({
                "present": true, "enabled": true, "blend": "multiply", "opacity": 0.5, "color": [0, 0, 0],
                "angle": 19.0, "distance": 5.0, "size": 6.0, "contour": contour(), "invert": false
            })
        })),
        ("color overlay", style(|s| s["color_overlays"] = json!([overlay(json!([0, 200, 0]), "color")]))),
        ("gradient overlay aligned", style(|s| s["gradient_overlays"] = json!([overlay(gradient(true), "gradient")]))),
        ("pattern overlay linked", style(|s| s["pattern_overlays"] = json!([overlay(pattern(true), "pattern")]))),
        ("shadow, gradient, stroke", style(|s| {
            s["drop_shadows"] = json!([shadow(0.0)]);
            s["gradient_overlays"] = json!([overlay(gradient(true), "gradient")]);
            s["strokes"] = json!([stroke("outside", json!({ "type": "solid", "color": [0, 0, 0] }))]);
        })),
        // Read the absolute position: these stay on the per-tile path.
        ("noise", style(|s| s["drop_shadows"] = json!([shadow(0.4)]))),
        ("gradient overlay on the document", style(|s| s["gradient_overlays"] = json!([overlay(gradient(false), "gradient")]))),
        ("pattern overlay unlinked", style(|s| s["pattern_overlays"] = json!([overlay(pattern(false), "pattern")]))),
        ("inner shadow", style(|s| s["inner_shadows"] = json!([shadow(0.0)]))),
    ]
}

/// A soft-edged, colored ellipse of 140 x 110 px at (60, 50) on a layer above a white background.
fn doc_with(style: &str) -> (Document, u32) {
    let mut d = Document::new(W, H, 8).unwrap();
    d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    let id = d.add_layer("fx", 1).unwrap();
    let (w, h) = (140usize, 110usize);
    let mut px = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let (u, v) = ((x as f64 + 0.5) / w as f64 * 2.0 - 1.0, (y as f64 + 0.5) / h as f64 * 2.0 - 1.0);
            let r = (u * u + v * v).sqrt();
            let a = ((1.0 - r) * 12.0).clamp(0.0, 1.0);
            let o = (y * w + x) * 4;
            px[o..o + 4].copy_from_slice(&[(x * 255 / w) as u8, (y * 255 / h) as u8, 90, (a * 255.0).round() as u8]);
        }
    }
    d.put_rgba8(id, 60, 50, w as u32, h as u32, &px).unwrap();
    let pat: Vec<u8> = (0..16 * 16).flat_map(|i| [(i * 13 % 256) as u8, (i * 7 % 256) as u8, 40, 255]).collect();
    let blob = d.blob_add(&pat).unwrap();
    d.set_document_m3(&json!({ "patterns": [{ "id": "p", "name": "P", "width": 16, "height": 16, "blob": blob }] }).to_string())
        .unwrap();
    d.set_style(id, style).unwrap();
    (d, id)
}

/// Every tile of levels 0-3 as premultiplied f32, through the layer-space path or the legacy one.
fn render(d: &Document, legacy: bool) -> Vec<Vec<f32>> {
    FX_LEGACY.with(|c| c.set(legacy));
    let mut out = Vec::new();
    for level in 0..4 {
        let (nx, ny) = d.level_tiles(level);
        for ty in 0..ny {
            for tx in 0..nx {
                out.push(Document::run_program(&d.program(level, tx, ty).unwrap()));
            }
        }
    }
    FX_LEGACY.with(|c| c.set(false));
    out
}

fn assert_same(new: &[Vec<f32>], old: &[Vec<f32>], what: &str) {
    for (t, (a, b)) in new.iter().zip(old).enumerate() {
        if let Some(i) = (0..a.len()).find(|&i| a[i].to_bits() != b[i].to_bits()) {
            let max = a.iter().zip(b).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
            panic!("{what}: tile #{t} differs first at float {i} ({} vs {}), max diff {max}", a[i], b[i]);
        }
    }
}

// Cumulative moves: odd offsets, a whole tile, partly off the right and bottom edges, then off the top left.
const MOVES: [(i32, i32); 6] = [(37, 13), (-21, 77), (256, 0), (5, -3), (300, 280), (-760, -500)];

#[test]
fn a_moved_layer_reuses_its_effect_planes() {
    for name in ["shadow, gradient, stroke", "drop shadow", "stroke outside"] {
        moved_layer_reuses(name);
    }
}

fn moved_layer_reuses(name: &str) {
    let (mut d, id) = doc_with(&styles().into_iter().find(|s| s.0 == name).unwrap().1);
    render(&d, false);
    for (dx, dy) in [(37, 13), (256, 0), (-5, 3)] {
        d.offset_layer(id, dx, dy).unwrap();
        FX_RENDERS.with(|c| c.set(0));
        let (nx, ny) = d.level_tiles(0);
        for ty in 0..ny {
            for tx in 0..nx {
                Document::run_program(&d.program(0, tx, ty).unwrap());
            }
        }
        assert_eq!(FX_RENDERS.with(|c| c.get()), 0, "{name} moved by ({dx}, {dy}): no effect plane renders again");
    }
}

#[test]
fn layer_space_effects_match_the_per_tile_path_after_moves() {
    for (name, s) in styles() {
        let (mut d, id) = doc_with(&s);
        assert_same(&render(&d, false), &render(&d, true), name);
        for (dx, dy) in MOVES {
            d.offset_layer(id, dx, dy).unwrap();
            assert_same(&render(&d, false), &render(&d, true), &format!("{name} after ({dx}, {dy})"));
        }
    }
}

#[test]
fn masks_and_layer_options_match_the_per_tile_path() {
    let base = styles().into_iter().find(|s| s.0 == "shadow, gradient, stroke").unwrap().1;
    let cases: Vec<(&str, Box<dyn Fn(&mut Document, u32)>)> = vec![
        ("raster mask hiding effects", Box::new(|d, id| {
            d.add_mask(id, true).unwrap();
            let m: Vec<u8> = (0..TILE * TILE).map(|i| (255 - (i % TILE) * 255 / TILE) as u8).collect();
            d.set_mask_tile8(id, 0, 0, &m).unwrap();
            let mut b = serde_json::to_value(Blending::default()).unwrap();
            b["layer_mask_hides_effects"] = true.into();
            d.set_blending(id, &b.to_string()).unwrap();
        })),
        ("transparent shapes off", Box::new(|d, id| {
            let mut b = serde_json::to_value(Blending::default()).unwrap();
            b["transparency_shapes"] = false.into();
            d.set_blending(id, &b.to_string()).unwrap();
        })),
        ("knockout", Box::new(|d, id| {
            let mut b = serde_json::to_value(Blending::default()).unwrap();
            b["knockout"] = "shallow".into();
            d.set_blending(id, &b.to_string()).unwrap();
        })),
        ("vector mask", Box::new(|d, id| {
            let p = |x: f64, y: f64| json!([x, y, x, y, x, y]);
            let vm = json!({
                "path": { "fill_rule": "nonzero", "subpaths": [
                    { "closed": true, "op": "combine", "points": [p(70.0, 55.0), p(180.0, 60.0), p(150.0, 150.0), p(65.0, 140.0)] }
                ] },
                "enabled": true, "linked": true, "inverted": false, "density": 1.0, "feather": 2.0
            });
            d.set_vector_mask(id, &vm.to_string()).unwrap();
        })),
        ("fill 0.5 in multiply", Box::new(|d, id| d.set_props(id, r#"{"fill":0.5,"blend":"multiply"}"#).unwrap())),
    ];
    for (name, setup) in cases {
        let (mut d, id) = doc_with(&base);
        setup(&mut d, id);
        assert_same(&render(&d, false), &render(&d, true), name);
        for (dx, dy) in MOVES {
            d.offset_layer(id, dx, dy).unwrap();
            assert_same(&render(&d, false), &render(&d, true), &format!("{name} after ({dx}, {dy})"));
        }
    }
}


#[test]
fn a_layer_over_many_tiles_reuses_its_effect_planes() {
    let s = styles().into_iter().find(|s| s.0 == "shadow, gradient, stroke").unwrap().1;
    let mut d = Document::new(1400, 1100, 8).unwrap();
    let id = d.add_layer("big", 1).unwrap();
    let (w, h) = (900usize, 700usize);
    let px: Vec<u8> = (0..w * h).flat_map(|i| [(i % 251) as u8, (i / w % 253) as u8, 9, if (i % w + i / w) % 97 < 80 { 255 } else { 0 }]).collect();
    d.put_rgba8(id, 150, 120, w as u32, h as u32, &px).unwrap();
    d.set_style(id, &s).unwrap();
    let all = |d: &Document| {
        let (nx, ny) = d.level_tiles(0);
        (0..ny).flat_map(|ty| (0..nx).map(move |tx| (tx, ty))).map(|(tx, ty)| Document::run_program(&d.program(0, tx, ty).unwrap())).collect::<Vec<_>>()
    };
    all(&d);
    d.offset_layer(id, 37, 13).unwrap();
    FX_RENDERS.with(|c| c.set(0));
    let moved = all(&d);
    let renders = FX_RENDERS.with(|c| c.get());
    assert_same(&moved, &render(&d, true)[..moved.len()], "big layer");
    assert!(renders <= 8, "moved by (37, 13): only the windows at the new edge render, got {renders}");
}
