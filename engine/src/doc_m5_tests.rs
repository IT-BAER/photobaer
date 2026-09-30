//! Filter registry, runner, Fade and manifest v6 (docs/M5.md sections 1-2, batch B1).

use super::m3_tests::{load as load_v4, v4_fixture};
use super::*;
use crate::filters::{self, Ctx};
use serde_json::{json, Value};

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

// Layer `id`'s own pixel at (x, y), 8-bit.
fn lpx(d: &Document, id: u32, x: i32, y: i32) -> [u8; 4] {
    let tiles = d.node(id).unwrap().pixel_tiles().unwrap();
    let t = tiles.get(x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
    let p = (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize;
    t.map_or([0; 4], |t| t.px.rgba_f32(p).map(|v| (v * 255.0).round() as u8))
}

fn filter(kind: &str, params: Value) -> String {
    json!({ "kind": kind, "params": params }).to_string()
}

fn run(d: &mut Document, kind: &str) {
    d.apply_filter(1, Target::Pixels, &filter(kind, json!({})), None, 1.0).unwrap();
}

#[test]
fn schema_lists_the_first_entries_in_menu_order() {
    let v: Value = serde_json::from_str(&filters::schema_json()).unwrap();
    let ids: Vec<&str> = v.as_array().unwrap().iter().filter(|e| e["group"] == "blur").map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [
        "blur.average", "blur.blur", "blur.blur_more", "blur.box_blur", "gaussian_blur", "blur.lens_blur", "blur.motion_blur", "blur.radial_blur",
        "blur.shape_blur", "blur.smart_blur", "blur.surface_blur",
    ]);
    let sol = v.as_array().unwrap().iter().find(|e| e["id"] == "stylize.solarize").unwrap();
    assert_eq!((sol["label"].as_str(), sol["alpha"].as_str(), sol["exec"].as_str()), (Some("Solarize"), Some("kept"), Some("point")));
    let g = v.as_array().unwrap().iter().find(|e| e["id"] == "gaussian_blur").unwrap();
    assert_eq!(g["params"][0], json!({ "key": "radius", "label": "Radius", "kind": "number", "min": 0.1, "max": 250.0, "step": 0.1, "unit": "px", "default": 1.0 }));
    assert!(v.as_array().unwrap().iter().any(|e| e["id"] == "levels" && e["editor"] == "adjustment"), "the M3 kinds are entries");
}

#[test]
fn unknown_kind_key_and_out_of_range_values_err_naming_them() {
    let mut d = doc_with(4, 4, |_, _| gray(100));
    let e = d.apply_filter(1, Target::Pixels, &filter("blur.nope", json!({})), None, 1.0).unwrap_err();
    assert!(e.contains("blur.nope"), "{e}");
    let e = d.apply_filter(1, Target::Pixels, &filter("blur.blur", json!({ "radius": 1 })), None, 1.0).unwrap_err();
    assert!(e.contains("Blur") && e.contains("radius"), "{e}");
    let e = d.apply_filter(1, Target::Pixels, &filter("gaussian_blur", json!({ "radius": 900.0 })), None, 1.0).unwrap_err();
    assert!(e.contains("Gaussian Blur") && e.contains("radius"), "{e}");
    let e = d.apply_filter(1, Target::Pixels, &filter("gaussian_blur", json!({ "radius": "big" })), None, 1.0).unwrap_err();
    assert!(e.contains("radius"), "{e}");
    assert_eq!(lpx(&d, 1, 1, 1), gray(100), "a rejected filter changes nothing");
}

#[test]
fn blur_on_an_impulse_is_the_1_2_1_kernel() {
    let mut d = doc_with(8, 8, |x, y| gray(if (x, y) == (4, 4) { 255 } else { 0 }));
    run(&mut d, "blur.blur");
    assert_eq!(lpx(&d, 1, 4, 4), gray(64));
    for (x, y) in [(3, 4), (5, 4), (4, 3), (4, 5)] {
        assert_eq!(lpx(&d, 1, x, y), gray(32), "edge neighbor {x},{y}");
    }
    for (x, y) in [(3, 3), (5, 3), (3, 5), (5, 5)] {
        assert_eq!(lpx(&d, 1, x, y), gray(16), "corner {x},{y}");
    }
    assert_eq!(lpx(&d, 1, 0, 0), gray(0));
}

#[test]
fn solarize_folds_the_upper_half() {
    let mut d = doc_with(2, 1, |x, _| gray(if x == 0 { 64 } else { 200 }));
    run(&mut d, "stylize.solarize");
    assert_eq!(lpx(&d, 1, 0, 0), gray(128));
    assert_eq!(lpx(&d, 1, 1, 0), gray(110));
}

#[test]
fn solarize_keeps_alpha() {
    let mut d = doc_with(1, 1, |_, _| [200, 200, 200, 128]);
    run(&mut d, "stylize.solarize");
    assert_eq!(lpx(&d, 1, 0, 0), [110, 110, 110, 128]);
}

#[test]
fn average_fills_the_mean_color() {
    let mut d = doc_with(2, 1, |x, _| gray(if x == 0 { 0 } else { 200 }));
    run(&mut d, "blur.average");
    assert_eq!((lpx(&d, 1, 0, 0), lpx(&d, 1, 1, 0)), (gray(100), gray(100)));
}

#[test]
fn half_coverage_selection_mixes_half_way() {
    let mut d = doc_with(8, 8, |_, _| gray(200));
    d.fill(0, Target::Selection, 128, 128, 128, 255).unwrap();
    run(&mut d, "stylize.solarize");
    let v = lpx(&d, 1, 3, 3)[0];
    assert!(v.abs_diff(155) <= 1, "200 and its solarize 110 mix to 155, got {v}");
}

#[test]
fn filters_on_the_mask_and_the_quick_mask() {
    let mut d = doc_with(4, 4, |_, _| gray(10));
    d.add_mask(1, true).unwrap();
    d.fill(1, Target::Mask, 200, 200, 200, 255).unwrap();
    d.apply_filter(1, Target::Mask, &filter("stylize.solarize", json!({})), None, 1.0).unwrap();
    let m = d.node(1).unwrap().mask.as_ref().unwrap();
    let v = m.tiles.get(0, 0).map_or(m.default as f32 / 255.0, |t| t.px.mask_f32(TILE + 1));
    assert_eq!((v * 255.0).round() as u8, 110, "the mask value is solarized");
    assert_eq!(lpx(&d, 1, 1, 1), gray(10), "the pixels stay");

    d.fill(0, Target::Selection, 64, 64, 64, 255).unwrap();
    d.apply_filter(1, Target::Selection, &filter("stylize.solarize", json!({})), None, 1.0).unwrap();
    let sel = d.selection.as_ref().unwrap();
    let v = sel.tiles.get(0, 0).map_or(sel.default as f32 / 255.0, |t| t.px.mask_f32(TILE + 1));
    assert_eq!((v * 255.0).round() as u8, 128, "the quick mask is solarized, not mixed by itself");
}

// A seeded pattern across the seam between tiles (0, 0) and (1, 0).
fn seam_doc() -> Document {
    doc_with(300, 20, |x, y| {
        let h = (x as u32).wrapping_mul(2654435761) ^ (y as u32).wrapping_mul(40503);
        [(h >> 3) as u8, (h >> 11) as u8, (h >> 19) as u8, 255]
    })
}

// Worst 8-bit difference between `kind` run tile by tile on the seam doc and one plane over the
// whole layer grown by `m`, reads outside repeating the edge.
fn whole_layer_diff(kind: &str, params: Value, m: usize) -> u8 {
    let mut d = seam_doc();
    let src = d.clone();
    d.apply_filter(1, Target::Pixels, &filter(kind, params.clone()), None, 1.0).unwrap();
    let (w, h) = (300usize, 20usize);
    let (pw, ph) = (w + 2 * m, h + 2 * m);
    let mut plane = filters::Plane { x: -(m as i32), y: -(m as i32), w: pw, h: ph, data: vec![0.0; pw * ph * 4] };
    for y in 0..ph {
        for x in 0..pw {
            let (sx, sy) = ((x as i32 - m as i32).clamp(0, w as i32 - 1), (y as i32 - m as i32).clamp(0, h as i32 - 1));
            plane.data[(y * pw + x) * 4..][..4].copy_from_slice(&lpx(&src, 1, sx, sy).map(|c| c as f32 / 255.0));
        }
    }
    let f = filters::Filter::parse(&filter(kind, params)).unwrap();
    let blobs = HashMap::new();
    filters::apply(&f, &mut plane, &Ctx { blobs: &blobs, cov: None, bounds: [0, 0, 300, 20], scale: 1.0, mask: None }).unwrap();
    let mut worst = 0u8;
    for y in 0..h {
        for x in 0..w {
            let want = plane.data[((y + m) * pw + x + m) * 4..][..4].iter().map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u8).collect::<Vec<_>>();
            let got = lpx(&d, 1, x as i32, y as i32);
            worst = worst.max((0..4).map(|c| got[c].abs_diff(want[c])).max().unwrap());
        }
    }
    assert!((0..20).any(|y| lpx(&d, 1, 255, y) != lpx(&src, 1, 255, y)), "{kind}: the seam column changed");
    worst
}

#[test]
fn tile_by_tile_equals_whole_layer_for_blur_more_across_a_seam() {
    assert_eq!(whole_layer_diff("blur.blur_more", json!({}), 3), 0, "tile runs read their neighbors for the reach");
}

#[test]
fn tile_by_tile_equals_whole_layer_for_the_local_blurs() {
    for (kind, params, m) in [
        ("blur.box_blur", json!({ "radius": 3 }), 3),
        ("blur.motion_blur", json!({ "angle": 30, "distance": 9 }), 6),
        ("blur.shape_blur", json!({ "radius": 3, "shape": "star" }), 3),
        ("blur.surface_blur", json!({ "radius": 2, "threshold": 60 }), 2),
        ("blur.surface_blur", json!({ "radius": 100, "threshold": 60 }), 100),
        ("blur.smart_blur", json!({ "radius": 1.5, "threshold": 40, "mode": "overlayEdge" }), 6),
        ("blur.lens_blur", json!({ "radius": 4, "noiseAmount": 30, "seed": 7 }), 4),
    ] {
        assert_eq!(whole_layer_diff(kind, params, m), 0, "{kind}");
    }
}

#[test]
fn blur_spreads_past_a_small_layer_and_clamps_at_the_document_edge() {
    let mut d = Document::new(8, 8, 8).unwrap();
    d.select_rect(2.0, 2.0, 2.0, 2.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    d.selection = None;
    run(&mut d, "blur.blur");
    assert!(lpx(&d, 1, 1, 2)[3] > 0, "the blur reaches one pixel out");

    let mut e = doc_with(4, 4, |_, _| gray(90));
    run(&mut e, "blur.blur_more");
    assert_eq!(lpx(&e, 1, 0, 0), gray(90), "a flat layer stays flat up to the document edge");
}

#[test]
fn a_preview_clip_limits_the_output_rect() {
    let mut d = doc_with(8, 8, |_, _| gray(200));
    d.apply_filter(1, Target::Pixels, &filter("stylize.solarize", json!({})), Some([0, 0, 4, 8]), 1.0).unwrap();
    assert_eq!((lpx(&d, 1, 3, 3), lpx(&d, 1, 4, 3)), (gray(110), gray(200)));
}

#[test]
fn a_proxy_preview_scales_px_params_and_covers_the_view() {
    let mut d = doc_with(64, 64, |x, _| gray(if x < 32 { 0 } else { 255 }));
    let mut full = d.clone();
    let g = filter("gaussian_blur", json!({ "radius": 4.0 }));
    d.apply_filter(1, Target::Pixels, &g, Some([0, 0, 64, 64]), 0.5).unwrap();
    full.apply_filter(1, Target::Pixels, &g, None, 1.0).unwrap();
    for x in [20, 30, 34, 44] {
        let (a, b) = (lpx(&d, 1, x, 10)[0], lpx(&full, 1, x, 10)[0]);
        assert!(a.abs_diff(b) <= 24, "proxy near full resolution at x {x}: {a} vs {b}");
    }
    assert_eq!(lpx(&d, 1, 5, 10), gray(0));
    assert!(d.apply_filter(1, Target::Pixels, &g, None, 0.0).is_err(), "scale 0 is refused");
}

#[test]
fn a_strided_proxy_stays_near_full_resolution_and_keeps_alpha() {
    let mut d = doc_with(512, 512, |x, y| if y >= 500 { [0; 4] } else { gray(if x < 256 { 0 } else { 255 }) });
    let mut full = d.clone();
    let g = filter("gaussian_blur", json!({ "radius": 8.0 }));
    d.apply_filter(1, Target::Pixels, &g, Some([0, 0, 512, 512]), 0.125).unwrap();
    full.apply_filter(1, Target::Pixels, &g, None, 1.0).unwrap();
    for x in [100, 240, 250, 262, 272, 400] {
        let (a, b) = (lpx(&d, 1, x, 200)[0], lpx(&full, 1, x, 200)[0]);
        assert!(a.abs_diff(b) <= 40, "proxy near full resolution at x {x}: {a} vs {b}");
    }
    let mut s = doc_with(512, 512, |x, y| if y >= 500 { [0; 4] } else { gray(if x < 256 { 64 } else { 200 }) });
    s.apply_filter(1, Target::Pixels, &filter("stylize.solarize", json!({})), Some([0, 0, 512, 512]), 0.125).unwrap();
    assert_eq!((lpx(&s, 1, 50, 200), lpx(&s, 1, 50, 505)), (gray(128), [0; 4]), "alpha kept, transparent stays empty");
}

#[test]
fn filters_refuse_locked_and_non_pixel_layers_and_empty_layers() {
    let mut d = doc_with(4, 4, |_, _| gray(9));
    d.set_props(1, &json!({ "locks": { "transparency": false, "pixels": true, "position": false } }).to_string()).unwrap();
    assert!(d.apply_filter(1, Target::Pixels, &filter("blur.blur", json!({})), None, 1.0).unwrap_err().contains("locked"));
    let mut e = Document::new(4, 4, 8).unwrap();
    let err = e.apply_filter(1, Target::Pixels, &filter("blur.blur", json!({})), None, 1.0).unwrap_err();
    assert_eq!(err, "There is nothing to filter here.");
    e.apply_filter(1, Target::Pixels, &filter("blur.blur", json!({})), Some([0, 0, 4, 4]), 1.0).unwrap();
}

#[test]
fn fade_normal_half_after_invert() {
    let mut d = doc_with(4, 4, |_, _| gray(200));
    let prev = d.clone();
    d.invert(1, Target::Pixels).unwrap();
    d.fade(1, &prev, &json!({ "opacity": 50.0, "mode": "normal" }).to_string()).unwrap();
    let v = lpx(&d, 1, 1, 1)[0];
    assert!(v.abs_diff(128) <= 1, "55 and 200 mix to 128, got {v}");
}

#[test]
fn fade_modes_opacity_ends_and_messages() {
    let mut d = doc_with(2, 2, |_, _| gray(200));
    let prev = d.clone();
    d.invert(1, Target::Pixels).unwrap();
    let mut z = d.clone();
    z.fade(1, &prev, &json!({ "opacity": 0.0, "mode": "normal" }).to_string()).unwrap();
    assert_eq!(lpx(&z, 1, 0, 0), gray(200), "opacity 0 is the previous state");
    let mut m = d.clone();
    m.fade(1, &prev, &json!({ "opacity": 100.0, "mode": "multiply" }).to_string()).unwrap();
    assert_eq!(lpx(&m, 1, 0, 0), gray(43), "55 multiplied over 200");
    let e = d.fade(1, &prev, &json!({ "opacity": 101.0, "mode": "normal" }).to_string()).unwrap_err();
    assert!(e.contains("opacity"), "{e}");
    let mut other = Document::new(2, 2, 8).unwrap();
    other.add_layer("x", 1).unwrap();
    other.delete_node(1).unwrap();
    let e = d.fade(1, &other, &json!({ "opacity": 50.0, "mode": "normal" }).to_string()).unwrap_err();
    assert_eq!(e, "The previous state has no matching layer to fade toward.");
}

#[test]
fn a_filter_on_a_smart_object_appends_a_smart_filter() {
    let mut d = doc_with(4, 4, |_, _| gray(200));
    d.convert_for_smart_filters(1, &json!({ "link_id": "l", "source_blob": null }).to_string()).unwrap();
    let before = d.smart(1).unwrap().filters.len();
    d.apply_filter(1, Target::Pixels, &filter("stylize.solarize", json!({})), None, 1.0).unwrap();
    assert_eq!(lpx(&d, 1, 1, 1), gray(110), "the stack re-rendered");
    let s = d.smart(1).unwrap();
    assert_eq!(s.filters.len(), before + 1);
    assert_eq!(s.filters.last().unwrap().filter.kind, "stylize.solarize");
}

#[test]
fn a_blur_smart_filter_renders_like_the_destructive_blur() {
    let mut d = doc_with(8, 8, |x, y| gray(if (x, y) == (4, 4) { 255 } else { 0 }));
    let mut flat = d.clone();
    d.convert_for_smart_filters(1, &json!({ "link_id": "l", "source_blob": null }).to_string()).unwrap();
    d.add_smart_filter(1, &filter("blur.blur", json!({}))).unwrap();
    run(&mut flat, "blur.blur");
    for (x, y) in [(4, 4), (3, 4), (3, 3)] {
        assert_eq!(lpx(&d, 1, x, y), lpx(&flat, 1, x, y), "{x},{y}");
    }
}

fn v6_fixture() -> Value {
    let mut v = v4_fixture();
    v["version"] = 6.into();
    fn add_vector_mask(nodes: &mut Value) {
        for n in nodes.as_array_mut().unwrap() {
            n["vector_mask"] = Value::Null;
            if let Some(ch) = n.get_mut("children") {
                add_vector_mask(ch);
            }
        }
    }
    add_vector_mask(&mut v["layers"]);
    let extra = json!({ "resolution": 72.0, "paths": [], "guides": [], "grid": { "spacing_x": 100.0, "spacing_y": 100.0 },
        "guides_locked": false, "artboards_locked": false });
    v.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
    let filters = v["layers"][3]["smart"]["filters"].as_array_mut().unwrap();
    filters.push(json!({ "id": 3, "filter": { "kind": "blur.blur", "params": {} }, "enabled": true, "opacity": 1.0, "blend": "normal", "mask": null }));
    filters.push(json!({ "id": 4, "filter": { "kind": "stylize.solarize", "params": {} }, "enabled": true, "opacity": 0.5, "blend": "normal", "mask": null }));
    v
}

#[test]
fn v6_round_trip_of_a_stack_with_blur_solarize_and_a_blob_param_is_byte_identical() {
    let d = load_v4(&v6_fixture().to_string()).unwrap();
    let first = d.manifest();
    let v: Value = serde_json::from_str(&first).unwrap();
    assert_eq!(v["version"], 6);
    let kinds: Vec<&str> = v["layers"][3]["smart"]["filters"].as_array().unwrap().iter().map(|f| f["filter"]["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["color_lookup", "gaussian_blur", "blur.blur", "stylize.solarize"]);
    assert_eq!(v["layers"][3]["smart"]["filters"][0]["filter"]["params"]["table"], 11, "the blob param is kept");
    let again = load_v4(&first).unwrap();
    assert_eq!(again.manifest(), first, "write -> read -> write is byte identical");
    assert_eq!(again.tile_bytes(11).unwrap(), d.tile_bytes(11).unwrap(), "the blob bytes");
}

#[test]
fn v6_load_validates_filters_and_v5_refuses_registry_kinds() {
    let bad = |f: &dyn Fn(&mut Value)| {
        let mut v = v6_fixture();
        f(&mut v);
        load_v4(&v.to_string()).err().expect("must be rejected")
    };
    let e = bad(&|v| v["layers"][3]["smart"]["filters"][2]["filter"]["kind"] = "blur.nope".into());
    assert!(e.contains("blur.nope"), "{e}");
    let e = bad(&|v| v["layers"][3]["smart"]["filters"][3]["filter"]["params"] = json!({ "x": 1 }));
    assert!(e.contains("Solarize") && e.contains('x'), "{e}");
    let e = bad(&|v| v["layers"][3]["smart"]["filters"][1]["filter"]["params"]["radius"] = 0.into());
    assert!(e.contains("radius"), "{e}");
    let e = bad(&|v| v["version"] = 5.into());
    assert!(e.contains("v6") && e.contains("blur.blur"), "{e}");
}

#[test]
fn adjustment_filters_keep_the_shortest_float_form() {
    let a: crate::adjust::Adjustment = serde_json::from_value(json!({ "kind": "exposure", "params": { "exposure": 0.1, "offset": 0.0, "gamma": 1.1 } })).unwrap();
    let s = serde_json::to_string(&filters::Filter::from_adjustment(&a).normalized().unwrap()).unwrap();
    assert!(s.contains("\"exposure\":0.1,") && s.contains("\"gamma\":1.1"), "{s}");
}

#[test]
fn lens_blur_reads_the_layer_mask_as_its_depth_map() {
    let mut d = doc_with(20, 6, |x, _| gray(if x % 2 == 0 { 0 } else { 255 }));
    d.add_mask(1, true).unwrap();
    d.select_rect(0.0, 0.0, 10.0, 6.0, Mode::New).unwrap();
    d.fill(1, Target::Mask, 0, 0, 0, 255).unwrap();
    d.selection = None;
    d.apply_filter(1, Target::Pixels, &filter("blur.lens_blur", json!({ "radius": 3, "depthMapSource": "layerMask" })), None, 1.0).unwrap();
    assert_eq!((lpx(&d, 1, 4, 3), lpx(&d, 1, 5, 3)), (gray(0), gray(255)), "mask 0: in focus");
    assert!((60..=200).contains(&lpx(&d, 1, 15, 3)[0]), "mask 255: blurred, got {:?}", lpx(&d, 1, 15, 3));
}
