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
