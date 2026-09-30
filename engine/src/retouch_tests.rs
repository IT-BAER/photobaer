//! Clone, pattern and healing strokes, red eye, patch, content-aware move, clone overlay (docs/M5.md batch B10).

use super::*;
use serde_json::json;

// A doc whose layer 1 holds `f(x, y)` as opaque 8-bit RGBA.
fn doc_with(w: u32, h: u32, f: impl Fn(i32, i32) -> [u8; 4]) -> Document {
    let mut d = Document::new(w, h, 8).unwrap();
    for ty in 0..d.tiles_y() {
        for tx in 0..d.tiles_x() {
            let mut buf = vec![0u8; TILE_BYTES_U8];
            for p in 0..TILE_PIXELS {
                let (x, y) = ((tx as usize * TILE + p % TILE) as i32, (ty as usize * TILE + p / TILE) as i32);
                if x < w as i32 && y < h as i32 {
                    buf[p * 4..p * 4 + 4].copy_from_slice(&f(x, y));
                }
            }
            d.set_tile_rgba8(1, tx, ty, &buf).unwrap();
        }
    }
    d
}

fn gray(v: u8) -> [u8; 4] {
    [v, v, v, 255]
}

fn at(d: &Document, x: i32, y: i32) -> [u8; 4] {
    let t = d.node(1).unwrap().pixel_tiles().unwrap().get(x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
    let p = (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize;
    t.map_or([0; 4], |t| t.px.rgba_f32(p).map(|v| (v * 255.0).round() as u8))
}

// One aliased, full-opacity dab of `size` at pixel (x, y); `extra` members join the params.
fn dab(e: &mut EngineCore, size: f32, x: i32, y: i32, extra: serde_json::Value) -> Result<(), String> {
    let mut p = json!({ "rgba": [0, 0, 0, 255], "mode": "normal", "size": size, "aliased": true });
    for (k, v) in extra.as_object().unwrap() {
        p[k] = v.clone();
    }
    e.stroke_begin(1, "pixels", &p.to_string())?;
    e.stroke_to(&[x as f64 + 0.5, y as f64 + 0.5, 1.0])?;
    e.stroke_end()
}

fn clone_src(anchor: [i32; 2], origin: [i32; 2], m: [i32; 4]) -> serde_json::Value {
    json!({ "kind": "clone", "anchor": anchor, "origin": origin, "m": m, "sample": "currentLayer", "ignoreAdjustments": false })
}

fn ramp() -> EngineCore {
    EngineCore::new(doc_with(100, 100, |x, y| [x as u8, y as u8, 0, 255]))
}

#[test]
fn red_eye_darkens_reddish_pixels_inside_the_circle_only() {
    let mut d = doc_with(60, 60, |x, y| match (x, y) {
        (21, 20) => gray(100),
        _ if x < 40 && y < 40 => [200, 40, 40, 255],
        _ => gray(255),
    });
    assert!(d.red_eye(1, 0, 0, 40, 40, 1.0, 0.5).unwrap());
    assert_eq!(at(&d, 20, 20), [20, 20, 20, 255]);
    assert_eq!(at(&d, 21, 20), gray(100), "a gray pixel has no red excess");
    assert_eq!(at(&d, 1, 1), [200, 40, 40, 255], "a corner is outside the circle");
    assert!(!d.red_eye(1, 45, 45, 10, 10, 1.0, 0.5).unwrap(), "nothing red there");
}

#[test]
fn clone_stroke_reads_the_source_through_the_map() {
    let mut e = ramp();
    dab(&mut e, 1.0, 50, 50, json!({ "source": clone_src([10, 10], [50, 50], [1, 0, 0, 1]) })).unwrap();
    assert_eq!(at(&e.doc, 50, 50), [10, 10, 0, 255]);
    assert_eq!(at(&e.doc, 51, 50), [51, 50, 0, 255], "a one px dab leaves its neighbours");
    dab(&mut e, 1.0, 60, 50, json!({ "source": clone_src([10, 10], [50, 50], [1, 0, 0, 1]) })).unwrap();
    assert_eq!(at(&e.doc, 60, 50), [20, 10, 0, 255], "aligned: the origin is kept");
    dab(&mut e, 1.0, 60, 51, json!({ "source": clone_src([10, 10], [60, 51], [1, 0, 0, 1]) })).unwrap();
    assert_eq!(at(&e.doc, 60, 51), [10, 10, 0, 255], "not aligned: the origin is the stroke start");
}

#[test]
fn clone_scale_maps_the_destination_offset_divided_by_scale() {
    let mut e = ramp();
    dab(&mut e, 1.0, 60, 50, json!({ "source": clone_src([10, 10], [50, 50], [2, 0, 0, 2]) })).unwrap();
    assert_eq!(at(&e.doc, 60, 50), [30, 10, 0, 255]);
}

#[test]
fn clone_from_outside_the_document_paints_transparent_source() {
    let mut e = ramp();
    dab(&mut e, 1.0, 50, 50, json!({ "source": clone_src([-20, -20], [50, 50], [1, 0, 0, 1]) })).unwrap();
    assert_eq!(at(&e.doc, 50, 50), [50, 50, 0, 255], "source alpha 0 leaves the pixel");
}

#[test]
fn clone_sample_returns_the_source_pixels_at_the_overlay_points() {
    let e = ramp();
    let params = clone_src([10, 10], [50, 50], [1, 0, 0, 1]).to_string();
    let out = e.doc.clone_sample(1, &params, 50.0, 50.0, 2.0, 1.0, 2, 1).unwrap();
    assert_eq!(out, vec![10, 10, 0, 255, 11, 10, 0, 255]);
    assert!(e.doc.clone_sample(1, &params, 0.0, 0.0, 2.0, 2.0, 513, 1).is_err());
}

#[test]
fn clone_below_ignores_the_layers_above_the_source() {
    let mut e = EngineCore::new(doc_with(20, 20, |_, _| gray(50)));
    let top = e.doc.add_layer("top", 1).unwrap();
    e.doc
        .paint_coverage(top, Target::Pixels, 0, 0, 20, 20, &[1.0; 400], [200, 200, 200, 255], PaintMode::Blend(Blend::Normal), 1.0)
        .unwrap();
    let mut src = clone_src([5, 5], [10, 10], [1, 0, 0, 1]);
    src["sample"] = json!("currentBelow");
    assert_eq!(e.doc.clone_sample(1, &src.to_string(), 10.0, 10.0, 1.0, 1.0, 1, 1).unwrap(), gray(50));
    src["sample"] = json!("allLayers");
    assert_eq!(e.doc.clone_sample(1, &src.to_string(), 10.0, 10.0, 1.0, 1.0, 1, 1).unwrap(), gray(200));
}

#[test]
fn spot_heal_replaces_a_dot_with_the_flat_surroundings() {
    for kind in ["contentAware", "proximityMatch"] {
        let mut e = EngineCore::new(doc_with(64, 64, |x, y| if (31..34).contains(&x) && (31..34).contains(&y) { gray(0) } else { gray(128) }));
        dab(&mut e, 9.0, 32, 32, json!({ "heal": kind })).unwrap();
        for y in 0..64 {
            for x in 0..64 {
                let v = at(&e.doc, x, y);
                assert!(v[0].abs_diff(128) <= 2 && v[3] == 255, "{kind}: ({x}, {y}) is {v:?}");
            }
        }
    }
}

#[test]
fn healing_brush_keeps_the_target_level_while_taking_the_source_texture() {
    let mut e = EngineCore::new(doc_with(64, 64, |x, _| if x < 32 { gray(100) } else { gray(150) }));
    dab(&mut e, 9.0, 48, 32, json!({ "heal": "healing", "source": clone_src([16, 32], [48, 32], [1, 0, 0, 1]) })).unwrap();
    for (x, y) in [(48, 32), (46, 32), (50, 33), (48, 35)] {
        assert!(at(&e.doc, x, y)[0].abs_diff(150) <= 2, "({x}, {y}) is {:?}", at(&e.doc, x, y));
    }
}

#[test]
fn pattern_stamp_tiles_the_pattern_from_its_origin() {
    let mut e = EngineCore::new(doc_with(32, 32, |_, _| gray(255)));
    let data: Vec<u8> = (0..16).flat_map(|i| [(i % 4) as u8 * 40 + 10, (i / 4) as u8 * 40 + 10, 5, 255]).collect();
    let id = e.pattern_add(4, 4, &data, 4).unwrap();
    let src = json!({ "kind": "pattern", "patternId": id, "origin": [0, 0], "impressionist": false });
    dab(&mut e, 10.0, 15, 15, json!({ "source": src })).unwrap();
    for (x, y) in [(15, 15), (13, 15), (17, 14), (12, 18), (19, 15)] {
        assert_eq!(at(&e.doc, x, y), [(x % 4) as u8 * 40 + 10, (y % 4) as u8 * 40 + 10, 5, 255], "({x}, {y})");
    }
    let src = json!({ "kind": "pattern", "patternId": id, "origin": [0, 0], "impressionist": true });
    dab(&mut e, 10.0, 15, 15, json!({ "source": src })).unwrap();
    assert_ne!(at(&e.doc, 15, 15), [(15 % 4) as u8 * 40 + 10, (15 % 4) as u8 * 40 + 10, 5, 255], "the impressionist pattern is blurred");
}

const PATCH: &str = r#"{"mode":"source","contentAware":false,"structure":4,"color":2}"#;

fn blob() -> Document {
    let mut d = doc_with(100, 100, |x, y| if (10..20).contains(&x) && (10..20).contains(&y) { gray(200) } else { gray(100) });
    d.select_rect(10.0, 10.0, 10.0, 10.0, Mode::New).unwrap();
    d
}

#[test]
fn patch_source_replaces_the_selection_with_the_dragged_to_area() {
    let mut d = blob();
    assert!(d.patch(1, 30, 0, PATCH).unwrap());
    for (x, y) in [(10, 10), (15, 15), (19, 19), (12, 17)] {
        assert!(at(&d, x, y)[0].abs_diff(100) <= 2, "({x}, {y}) is {:?}", at(&d, x, y));
    }
    assert!(d.has_selection(), "the selection stays");
    assert!(!d.patch(1, 0, 0, PATCH).unwrap(), "a zero drag does nothing");
}

#[test]
fn patch_needs_a_selection() {
    let mut d = doc_with(20, 20, |_, _| gray(100));
    assert_eq!(d.patch(1, 5, 0, PATCH).unwrap_err(), "Make a selection first.");
    assert_eq!(d.content_aware_move(1, 5, 0, r#"{"extend":false,"structure":4,"color":2}"#).unwrap_err(), "Make a selection first.");
}

#[test]
fn patch_destination_and_content_aware_move_carry_the_object_and_heal_the_hole() {
    let mut d = blob();
    assert!(d.patch(1, 30, 0, r#"{"mode":"destination","contentAware":false,"structure":4,"color":2}"#).unwrap());
    assert!(at(&d, 45, 15)[0] >= 190, "the object arrives: {:?}", at(&d, 45, 15));
    assert_eq!(at(&d, 15, 15)[0], 200, "extend keeps the original");

    let mut d = blob();
    assert!(d.content_aware_move(1, 30, 0, r#"{"extend":false,"structure":4,"color":2}"#).unwrap());
    assert!(at(&d, 45, 15)[0] >= 190, "the object arrives: {:?}", at(&d, 45, 15));
    for y in 10..20 {
        for x in 10..20 {
            assert!(at(&d, x, y)[0] <= 105, "the vacated ({x}, {y}) is {:?}", at(&d, x, y));
        }
    }
}

#[test]
fn heal_and_source_params_are_validated() {
    let mut e = ramp();
    let err = dab(&mut e, 5.0, 10, 10, json!({ "heal": "healing" })).unwrap_err();
    assert_eq!(err, "the healing brush needs a clone source");
    let err = dab(&mut e, 5.0, 10, 10, json!({ "heal": "contentAware", "source": clone_src([1, 1], [2, 2], [1, 0, 0, 1]) })).unwrap_err();
    assert_eq!(err, "a spot heal takes no source");
    let snap = e.snapshot();
    let err = dab(&mut e, 5.0, 10, 10, json!({ "eraseToHistory": snap, "source": clone_src([1, 1], [2, 2], [1, 0, 0, 1]) })).unwrap_err();
    assert_eq!(err, "erase to history can't use a source");
    let mut bad = clone_src([1, 1], [2, 2], [1, 0, 0, 1]);
    bad["layerId"] = json!(99);
    assert_eq!(dab(&mut e, 5.0, 10, 10, json!({ "source": bad })).unwrap_err(), "The clone source layer is gone.");
}

// A hard dab of `size` at pixel (x, y) carrying `effect`.
fn fx(e: &mut EngineCore, size: f32, x: i32, y: i32, effect: serde_json::Value) -> Result<(), String> {
    dab(e, size, x, y, json!({ "effect": effect, "hardness": 1 }))
}

fn tone(tool: &str, range: &str, protect: bool) -> serde_json::Value {
    json!({ "kind": "toning", "tool": tool, "range": range, "exposure": 0.5, "protectTones": protect })
}

fn flat(v: [u8; 4]) -> EngineCore {
    EngineCore::new(doc_with(40, 40, |_, _| v))
}

fn hsb(c: [u8; 4]) -> (f32, f32) {
    let (r, g, b) = (c[0] as f32, c[1] as f32, c[2] as f32);
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let d = max - min;
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        60.0 * (((g - b) / d).rem_euclid(6.0))
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h, if max == 0.0 { 0.0 } else { d / max })
}

fn hist_src(id: u32) -> serde_json::Value {
    json!({ "kind": "history", "snapshotId": id })
}

#[test]
fn dodge_and_burn_midtones_move_gray_by_a_quarter_exposure() {
    let mut e = flat(gray(128));
    fx(&mut e, 9.0, 20, 20, tone("dodge", "midtones", false)).unwrap();
    assert!((at(&e.doc, 20, 20)[0] as i32 - 144).abs() <= 1, "{:?}", at(&e.doc, 20, 20));
    let mut e = flat(gray(128));
    fx(&mut e, 9.0, 20, 20, tone("burn", "midtones", false)).unwrap();
    assert!((at(&e.doc, 20, 20)[0] as i32 - 112).abs() <= 1, "{:?}", at(&e.doc, 20, 20));
}

#[test]
fn dodge_highlights_leaves_black_alone() {
    let mut e = flat(gray(0));
    fx(&mut e, 9.0, 20, 20, tone("dodge", "highlights", false)).unwrap();
    assert_eq!(at(&e.doc, 20, 20), gray(0));
}

#[test]
fn protect_tones_keeps_the_hue() {
    let mut e = flat([200, 100, 50, 255]);
    fx(&mut e, 9.0, 20, 20, tone("dodge", "midtones", true)).unwrap();
    let c = at(&e.doc, 20, 20);
    let (h0, _) = hsb([200, 100, 50, 255]);
    assert!((hsb(c).0 - h0).abs() <= 1.0, "hue {} vs {h0}", hsb(c).0);
    assert!(c[0] as u32 + c[1] as u32 + c[2] as u32 > 350, "lighter: {c:?}");
}

#[test]
fn sponge_desaturate_keeps_the_max_channel() {
    let mut e = flat([200, 100, 50, 255]);
    fx(&mut e, 9.0, 20, 20, json!({ "kind": "sponge", "mode": "desaturate", "vibrance": true, "flow": 1 })).unwrap();
    let c = at(&e.doc, 20, 20);
    assert!((c[0] as i32 - 200).abs() <= 1, "{c:?}");
    assert!(hsb(c).1 < hsb([200, 100, 50, 255]).1, "{c:?}");
}

#[test]
fn blur_and_sharpen_leave_a_flat_color_alone() {
    for tool in ["blur", "sharpen"] {
        let mut e = flat([90, 120, 200, 255]);
        fx(&mut e, 9.0, 20, 20, json!({ "kind": "focus", "tool": tool, "allLayers": false })).unwrap();
        for (x, y) in [(20, 20), (17, 20), (24, 24)] {
            assert_eq!(at(&e.doc, x, y), [90, 120, 200, 255], "{tool}");
        }
    }
}

#[test]
fn blur_compounds_per_dab() {
    let mut e = EngineCore::new(doc_with(41, 41, |x, _| if x == 20 { [0, 0, 0, 255] } else { gray(255) }));
    let blur = json!({ "kind": "focus", "tool": "blur", "allLayers": false });
    fx(&mut e, 9.0, 20, 20, blur.clone()).unwrap();
    let once = at(&e.doc, 20, 20)[0];
    assert!(once > 0, "the line gets lighter");
    fx(&mut e, 9.0, 20, 20, blur).unwrap();
    assert!(at(&e.doc, 20, 20)[0] > once);
}

#[test]
fn history_brush_restores_the_source_state_exactly() {
    let mut e = ramp();
    let snap = e.snapshot();
    dab(&mut e, 5.0, 50, 50, json!({ "rgba": [255, 0, 0, 255] })).unwrap();
    assert_eq!(at(&e.doc, 50, 50), [255, 0, 0, 255]);
    dab(&mut e, 5.0, 50, 50, json!({ "source": hist_src(snap) })).unwrap();
    for y in 46..55 {
        for x in 46..55 {
            assert_eq!(at(&e.doc, x, y), [x as u8, y as u8, 0, 255]);
        }
    }
}

#[test]
fn history_source_rejects_an_unknown_snapshot() {
    let mut e = ramp();
    assert_eq!(dab(&mut e, 5.0, 10, 10, json!({ "source": hist_src(7) })).unwrap_err(), "unknown snapshot 7");
}

fn smudge(strength: f32, finger: Option<[u8; 3]>) -> serde_json::Value {
    let mut v = json!({ "kind": "smudge", "strength": strength, "allLayers": false, "blend": "normal" });
    if let Some(f) = finger {
        v["fingerPaint"] = json!(f);
    }
    v
}

fn drag(e: &mut EngineCore, p: serde_json::Value, (x0, x1): (f64, f64), y: f64) {
    let mut q = json!({ "rgba": [0, 0, 0, 255], "mode": "normal", "size": 9, "aliased": true, "hardness": 1, "spacing": 0.02 });
    q["effect"] = p;
    e.stroke_begin(1, "pixels", &q.to_string()).unwrap();
    e.stroke_to(&[x0, y, 1.0, x1, y, 1.0]).unwrap();
    e.stroke_end().unwrap();
}

fn red_left() -> EngineCore {
    EngineCore::new(doc_with(60, 21, |x, _| if x < 30 { [255, 0, 0, 255] } else { gray(255) }))
}

#[test]
fn smudge_strength_zero_is_identity_and_one_drags_color() {
    let mut e = red_left();
    drag(&mut e, smudge(0.0, None), (20.5, 40.5), 10.5);
    for x in 0..60 {
        assert_eq!(at(&e.doc, x, 10), if x < 30 { [255, 0, 0, 255] } else { gray(255) });
    }
    let mut e = red_left();
    drag(&mut e, smudge(1.0, None), (20.5, 40.5), 10.5);
    let c = at(&e.doc, 36, 10);
    assert!(c[0] == 255 && c[1] < 100, "{c:?}");
}

#[test]
fn smudge_finger_paint_starts_with_the_color() {
    let mut e = flat(gray(255));
    fx(&mut e, 9.0, 20, 20, smudge(1.0, Some([0, 0, 255]))).unwrap();
    assert_eq!(at(&e.doc, 20, 20), [0, 0, 255, 255]);
    let mut e = flat(gray(255));
    fx(&mut e, 9.0, 20, 20, smudge(1.0, None)).unwrap();
    assert_eq!(at(&e.doc, 20, 20), gray(255), "the first dab without finger paint does nothing");
}

fn art(style: &str, tolerance: f32) -> serde_json::Value {
    json!({ "source": hist_src(0), "art": { "style": style, "area": 50, "tolerance": tolerance } })
}

#[test]
fn art_history_restores_the_dab_center_and_tolerance_skips_close_pixels() {
    let mut e = ramp();
    assert_eq!(e.snapshot(), 0);
    dab(&mut e, 5.0, 50, 50, json!({ "rgba": [255, 0, 0, 255] })).unwrap();
    dab(&mut e, 5.0, 50, 50, art("dab", 0.0)).unwrap();
    assert_eq!(at(&e.doc, 50, 50), [50, 50, 0, 255]);
    dab(&mut e, 5.0, 50, 50, json!({ "rgba": [255, 0, 0, 255] })).unwrap();
    dab(&mut e, 5.0, 50, 50, art("tightLong", 1.0)).unwrap();
    assert_eq!(at(&e.doc, 50, 50), [255, 0, 0, 255], "tolerance 100 % skips every dab");
    let mut e = ramp();
    e.snapshot();
    dab(&mut e, 5.0, 50, 50, art("tightShort", 1.0)).unwrap();
    assert_eq!(at(&e.doc, 50, 50), [50, 50, 0, 255]);
}

#[test]
fn cancel_after_an_effect_stroke_restores_the_tiles() {
    let mut e = flat(gray(128));
    let before = at(&e.doc, 20, 20);
    let q = json!({ "rgba": [0, 0, 0, 255], "mode": "normal", "size": 9, "effect": tone("dodge", "midtones", false) });
    e.stroke_begin(1, "pixels", &q.to_string()).unwrap();
    e.stroke_to(&[20.5, 20.5, 1.0]).unwrap();
    assert_ne!(at(&e.doc, 20, 20), before);
    e.stroke_cancel().unwrap();
    assert_eq!(at(&e.doc, 20, 20), before);
}

#[test]
fn effect_and_art_params_are_validated() {
    let mut e = flat(gray(128));
    let eff = tone("dodge", "midtones", false);
    let err = dab(&mut e, 5.0, 10, 10, json!({ "effect": eff, "source": clone_src([1, 1], [2, 2], [1, 0, 0, 1]) })).unwrap_err();
    assert!(err.contains("effect"), "{err}");
    let q = json!({ "rgba": [0, 0, 0, 255], "mode": "normal", "size": 5, "effect": eff });
    assert!(e.stroke_begin(1, "selection", &q.to_string()).unwrap_err().contains("effect"));
    let q = json!({ "rgba": [0, 0, 0, 255], "mode": "normal", "size": 5, "art": { "style": "dab", "area": 50, "tolerance": 0 } });
    assert_eq!(e.stroke_begin(1, "pixels", &q.to_string()).unwrap_err(), "the art history brush needs a history source");
}
