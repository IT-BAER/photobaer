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
fn tile_by_tile_equals_whole_layer_for_sharpen_and_noise() {
    for (kind, params, m) in [
        ("sharpen.sharpen", json!({}), 1),
        ("sharpen.sharpen_edges", json!({}), 1),
        ("sharpen.sharpen_more", json!({}), 1),
        ("sharpen.unsharp_mask", json!({ "amount": 200, "radius": 2.5, "threshold": 4 }), 3),
        ("sharpen.smart_sharpen", json!({ "radius": 2, "fadeAmountShadow": 40, "fadeAmountHighlight": 30, "radiusShadow": 5 }), 5),
        ("sharpen.smart_sharpen", json!({ "radius": 2, "remove": "motionBlur", "angle": 20 }), 4),
        ("noise.add_noise", json!({ "amount": 40, "distribution": "gaussian", "seed": 9 }), 0),
        ("noise.dust_and_scratches", json!({ "radius": 2, "threshold": 10 }), 2),
        ("noise.median", json!({ "radius": 4 }), 4),
        ("noise.reduce_noise", json!({ "strength": 8, "removeJpegArtifact": true, "redStrength": 5 }), 80),
    ] {
        assert_eq!(whole_layer_diff(kind, params, m), 0, "{kind}");
    }
}

#[test]
fn sharpen_and_noise_menus_list_the_reference_order() {
    let v: Value = serde_json::from_str(&filters::schema_json()).unwrap();
    let ids = |g: &str| v.as_array().unwrap().iter().filter(|e| e["group"] == g).map(|e| e["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids("sharpen"), ["sharpen.sharpen", "sharpen.sharpen_edges", "sharpen.sharpen_more", "sharpen.smart_sharpen", "sharpen.unsharp_mask"]);
    assert_eq!(ids("noise"), ["noise.add_noise", "noise.despeckle", "noise.dust_and_scratches", "noise.median", "noise.reduce_noise"]);
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
    let mut part = doc_with(64, 64, |x, _| gray(if x < 32 { 0 } else { 255 }));
    part.apply_filter(1, Target::Pixels, &g, Some([0, 0, 16, 64]), 0.5).unwrap();
    assert_eq!(lpx(&part, 1, 40, 10), gray(255), "pixels outside the view keep their value");
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

#[test]
fn a_global_filter_reads_past_the_selection_rect() {
    let mut d = doc_with(40, 40, |x, y| gray(((x * 37 + y * 11) % 256) as u8));
    let mut flat = d.clone();
    let spin = filter("blur.radial_blur", json!({ "amount": 30 }));
    flat.apply_filter(1, Target::Pixels, &spin, None, 1.0).unwrap();
    d.select_rect(22.0, 22.0, 12.0, 12.0, Mode::New).unwrap();
    d.apply_filter(1, Target::Pixels, &spin, None, 1.0).unwrap();
    for (x, y) in [(22, 22), (33, 22), (27, 33), (33, 33)] {
        assert_eq!(lpx(&d, 1, x, y), lpx(&flat, 1, x, y), "{x},{y}");
    }
}

// Layer 1 as a smart object with `kind` as its only smart filter, next to the same filter
// applied destructively; `mask` fills a layer mask on both first.
fn smart_and_flat(d: Document, kind: &str, params: Value, mask: Option<[f64; 4]>) -> (Document, Document) {
    let (mut d, mut flat) = (d.clone(), d);
    for doc in [&mut d, &mut flat] {
        if let Some([x, y, w, h]) = mask {
            doc.add_mask(1, true).unwrap();
            doc.select_rect(x, y, w, h, Mode::New).unwrap();
            doc.fill(1, Target::Mask, 0, 0, 0, 255).unwrap();
            doc.selection = None;
        }
    }
    d.convert_for_smart_filters(1, &json!({ "link_id": "l", "source_blob": null }).to_string()).unwrap();
    d.add_smart_filter(1, &filter(kind, params.clone())).unwrap();
    flat.apply_filter(1, Target::Pixels, &filter(kind, params), None, 1.0).unwrap();
    (d, flat)
}

#[test]
fn a_smart_radial_blur_centers_on_the_tight_layer_bounds() {
    let d = doc_with(64, 64, |x, y| if (10..50).contains(&x) && (10..40).contains(&y) { gray(((x * 37 + y * 11) % 256) as u8) } else { [0; 4] });
    let (d, flat) = smart_and_flat(d, "blur.radial_blur", json!({ "amount": 30 }), None);
    // Inside the content, clear of its edges (the center is (30, 25)).
    for (x, y) in [(25, 25), (35, 28), (30, 20)] {
        assert_eq!(lpx(&d, 1, x, y), lpx(&flat, 1, x, y), "{x},{y}");
    }
}

#[test]
fn a_smart_lens_blur_reads_the_layer_mask_as_its_depth_map() {
    let d = doc_with(40, 20, |x, y| if (10..30).contains(&x) && (5..15).contains(&y) { gray(if x % 2 == 0 { 0 } else { 255 }) } else { [0; 4] });
    let (d, flat) = smart_and_flat(d, "blur.lens_blur", json!({ "radius": 3, "depthMapSource": "layerMask" }), Some([0.0, 0.0, 20.0, 20.0]));
    assert_eq!(lpx(&d, 1, 15, 10), gray(255), "mask 0: in focus");
    for (x, y) in [(14, 10), (25, 10)] {
        assert_eq!(lpx(&d, 1, x, y), lpx(&flat, 1, x, y), "{x},{y}");
    }
}

#[test]
fn settle_re_renders_a_smart_cache_whose_depth_mask_changed() {
    let d = doc_with(40, 20, |x, y| if (10..30).contains(&x) && (5..15).contains(&y) { gray(if x % 2 == 0 { 0 } else { 255 }) } else { [0; 4] });
    let lens = json!({ "radius": 3, "depthMapSource": "layerMask" });
    let (mut d, _) = smart_and_flat(d, "blur.lens_blur", lens.clone(), Some([0.0, 0.0, 20.0, 20.0]));
    let before = lpx(&d, 1, 25, 10);
    d.fill(1, Target::Mask, 0, 0, 0, 255).unwrap();
    d.settle_smart().unwrap();
    // The flat twin: the same mask edit on the unfiltered layer, then the filter.
    let flat = {
        let mut f = doc_with(40, 20, |x, y| if (10..30).contains(&x) && (5..15).contains(&y) { gray(if x % 2 == 0 { 0 } else { 255 }) } else { [0; 4] });
        f.add_mask(1, true).unwrap();
        f.fill(1, Target::Mask, 0, 0, 0, 255).unwrap();
        f.apply_filter(1, Target::Pixels, &filter("blur.lens_blur", lens), None, 1.0).unwrap();
        f
    };
    assert_ne!(lpx(&d, 1, 25, 10), before, "an all-black mask puts everything in focus");
    for (x, y) in [(14, 10), (25, 10)] {
        assert_eq!(lpx(&d, 1, x, y), lpx(&flat, 1, x, y), "{x},{y}");
    }
}

// ---- B4: distort, other, video ----

// A smooth two-channel ramp with a constant blue, opaque.
fn ramp(w: u32, h: u32) -> Document {
    doc_with(w, h, |x, y| [(x as u32 * 255 / w) as u8, (y as u32 * 255 / h) as u8, 90, 255])
}

fn filtered(d: &Document, kind: &str, params: Value) -> Document {
    let mut o = d.clone();
    o.apply_filter(1, Target::Pixels, &filter(kind, params), None, 1.0).unwrap();
    o
}

fn same(a: &Document, b: &Document, w: i32, h: i32) -> bool {
    (0..h).all(|y| (0..w).all(|x| lpx(a, 1, x, y) == lpx(b, 1, x, y)))
}

#[test]
fn neutral_distorts_change_nothing() {
    let d = ramp(40, 30);
    for (kind, params) in [
        ("distort.twirl", json!({ "angle": 0 })),
        ("distort.pinch", json!({ "amount": 0 })),
        ("distort.spherize", json!({ "amount": 0 })),
        ("distort.ripple", json!({ "amount": 0 })),
        ("distort.shear", json!({ "shearCurve": [{ "y": 0, "offset": 0 }, { "y": 1, "offset": 0 }] })),
        ("distort.zigzag", json!({ "amount": 0 })),
        ("distort.displace", json!({})),
    ] {
        assert!(same(&d, &filtered(&d, kind, params), 40, 30), "{kind}");
    }
}

#[test]
fn distorts_move_pixels_when_not_neutral() {
    let d = ramp(40, 30);
    for (kind, params) in [
        ("distort.twirl", json!({ "angle": 90 })),
        ("distort.pinch", json!({ "amount": 80 })),
        ("distort.spherize", json!({ "amount": 100 })),
        ("distort.ripple", json!({ "amount": 300 })),
        ("distort.shear", json!({ "shearCurve": [{ "y": 0, "offset": -0.3 }, { "y": 1, "offset": 0.3 }] })),
        ("distort.zigzag", json!({ "amount": 50 })),
        ("distort.zigzag", json!({ "amount": 50, "style": "aroundCenter" })),
        ("distort.wave", json!({})),
        ("distort.polar_coordinates", json!({})),
    ] {
        assert!(!same(&d, &filtered(&d, kind, params.clone()), 40, 30), "{kind} {params}");
    }
}

#[test]
fn polar_round_trip_is_close_inside_the_circle() {
    let d = ramp(128, 128);
    let back = filtered(&filtered(&d, "distort.polar_coordinates", json!({ "conversion": "rectToPolar" })), "distort.polar_coordinates", json!({ "conversion": "polarToRect" }));
    for y in 40..80 {
        for x in 6..122 {
            let (a, b) = (lpx(&d, 1, x, y), lpx(&back, 1, x, y));
            assert!((0..3).all(|c| a[c].abs_diff(b[c]) <= 2), "{x},{y}: {a:?} vs {b:?}");
        }
    }
}

#[test]
fn offset_wraps_repeats_and_clears() {
    let d = doc_with(3, 1, |x, _| gray(x as u8 * 100));
    let row = |d: &Document| (0..3).map(|x| lpx(d, 1, x, 0)[0]).collect::<Vec<_>>();
    assert_eq!(row(&filtered(&d, "other.offset", json!({ "horizontal": 1 }))), [200, 0, 100]);
    assert_eq!(row(&filtered(&d, "other.offset", json!({ "horizontal": 1, "undefinedAreas": "repeatEdgePixels" }))), [0, 0, 100]);
    let c = filtered(&d, "other.offset", json!({ "horizontal": 1, "undefinedAreas": "setToBackground" }));
    assert_eq!((lpx(&c, 1, 0, 0), lpx(&c, 1, 1, 0)), ([0; 4], gray(0)));
}

#[test]
fn custom_identity_and_scale() {
    let d = ramp(20, 20);
    let mut id = vec![0.0; 25];
    id[12] = 1.0;
    assert!(same(&d, &filtered(&d, "other.custom", json!({ "kernel": id })), 20, 20));
    let half = filtered(&d, "other.custom", json!({ "scale": 2 }));
    for (x, y) in [(3, 3), (10, 12)] {
        let (a, b) = (lpx(&d, 1, x, y), lpx(&half, 1, x, y));
        assert!((0..3).all(|c| (a[c] as i32 - 2 * b[c] as i32).abs() <= 1) && b[3] == 255, "{a:?} {b:?}");
    }
}

#[test]
fn high_pass_of_a_flat_layer_is_mid_gray() {
    let d = doc_with(12, 12, |_, _| gray(200));
    let o = filtered(&d, "other.high_pass", json!({ "radius": 3 }));
    assert!(lpx(&o, 1, 5, 5)[0].abs_diff(128) <= 1, "{:?}", lpx(&o, 1, 5, 5));
}

#[test]
fn high_pass_and_custom_offset_ignore_alpha() {
    let d = doc_with(12, 12, |_, _| [100, 100, 100, 128]);
    let o = filtered(&d, "other.high_pass", json!({ "radius": 3 }));
    assert!(lpx(&o, 1, 5, 5)[0].abs_diff(128) <= 1, "{:?}", lpx(&o, 1, 5, 5));
    let o = filtered(&d, "other.custom", json!({ "offset": 10 }));
    assert!(lpx(&o, 1, 5, 5)[0].abs_diff(110) <= 1, "{:?}", lpx(&o, 1, 5, 5));
}

#[test]
fn maximum_grows_a_dot_and_minimum_removes_it() {
    let dot = doc_with(9, 9, |x, y| gray(if (x, y) == (4, 4) { 255 } else { 0 }));
    for preserve in ["squareness", "roundness"] {
        let m = filtered(&dot, "other.maximum", json!({ "radius": 1, "preserve": preserve }));
        let lit = (0..9).flat_map(|y| (0..9).map(move |x| (x, y))).filter(|&(x, y)| lpx(&m, 1, x, y)[0] == 255).count();
        assert_eq!(lit, if preserve == "squareness" { 9 } else { 5 }, "{preserve}");
        let n = filtered(&dot, "other.minimum", json!({ "radius": 1, "preserve": preserve }));
        assert!((0..9).all(|y| (0..9).all(|x| lpx(&n, 1, x, y)[0] == 0)), "{preserve}");
    }
}

#[test]
fn de_interlace_odd_duplication_copies_the_even_rows() {
    let d = doc_with(2, 6, |_, y| gray(y as u8 * 10));
    let o = filtered(&d, "video.de_interlace", json!({ "eliminate": "oddFields", "createNewFields": "duplication" }));
    assert_eq!((0..6).map(|y| lpx(&o, 1, 0, y)[0]).collect::<Vec<_>>(), [0, 0, 20, 20, 40, 40]);
    let i = filtered(&d, "video.de_interlace", json!({ "eliminate": "oddFields" }));
    assert_eq!((0..6).map(|y| lpx(&i, 1, 0, y)[0]).collect::<Vec<_>>(), [0, 10, 20, 30, 40, 40], "interpolated: the mean of neighbors, the last row copies");
}

#[test]
fn ntsc_colors_clamps_luma_and_scales_chroma() {
    let d = doc_with(2, 1, |x, _| if x == 0 { [255, 0, 0, 255] } else { gray(250) });
    let o = filtered(&d, "video.ntsc_colors", json!({}));
    assert_eq!(lpx(&o, 1, 1, 0), gray(235), "luma clamped to 235");
    let r = lpx(&o, 1, 0, 0);
    assert!(r[0] <= 235 && r[1] >= 16 && r[2] >= 16, "{r:?}");
}

#[test]
fn tile_by_tile_equals_whole_layer_for_the_other_local_filters() {
    let mut id = vec![0.0; 25];
    id[12] = 1.0;
    id[0] = -1.0;
    id[24] = 2.0;
    for (kind, params, m) in [
        ("other.custom", json!({ "kernel": id, "scale": 3, "offset": 10 }), 2),
        ("other.high_pass", json!({ "radius": 3 }), 3),
        ("other.maximum", json!({ "radius": 2, "preserve": "squareness" }), 2),
        ("other.maximum", json!({ "radius": 2, "preserve": "roundness" }), 2),
        ("other.minimum", json!({ "radius": 2, "preserve": "squareness" }), 2),
        ("other.minimum", json!({ "radius": 2, "preserve": "roundness" }), 2),
    ] {
        assert_eq!(whole_layer_diff(kind, params, m), 0, "{kind}");
    }
}

#[test]
fn ripple_is_deterministic_and_wave_follows_its_randomize() {
    let d = ramp(60, 40);
    let a = filtered(&d, "distort.ripple", json!({ "amount": 200 }));
    assert!(same(&a, &filtered(&d, "distort.ripple", json!({ "amount": 200 })), 60, 40));
    let w = |r: i32| filtered(&d, "distort.wave", json!({ "randomize": r }));
    assert!(same(&w(0), &w(0), 60, 40));
    assert!(!same(&w(0), &w(1), 60, 40));
}

#[test]
fn video_distort_and_other_menus_list_the_reference_order() {
    let v: Value = serde_json::from_str(&filters::schema_json()).unwrap();
    let ids = |g: &str| v.as_array().unwrap().iter().filter(|e| e["group"] == g).map(|e| e["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids("distort"), [
        "distort.displace", "distort.pinch", "distort.polar_coordinates", "distort.ripple", "distort.shear", "distort.spherize", "distort.twirl", "distort.wave", "distort.zigzag",
    ]);
    assert_eq!(ids("video"), ["video.de_interlace", "video.ntsc_colors"]);
    assert_eq!(ids("other"), ["other.custom", "other.hsb_hsl", "other.high_pass", "other.maximum", "other.minimum", "other.offset"]);
    let find = |id: &str| v.as_array().unwrap().iter().find(|e| e["id"] == id).unwrap().clone();
    let k = &find("other.custom")["params"][0];
    assert_eq!((k["kind"].as_str(), k["default"].as_array().map(Vec::len), k["default"][12].as_f64()), (Some("kernel"), Some(25), Some(1.0)));
    assert_eq!(find("distort.shear")["params"][0]["kind"], "curve");
}

#[test]
fn kernel_and_curve_params_validate() {
    let mut d = doc_with(4, 4, |_, _| gray(100));
    let e = d.apply_filter(1, Target::Pixels, &filter("other.custom", json!({ "kernel": vec![0.0; 24] })), None, 1.0).unwrap_err();
    assert!(e.contains("Custom") && e.contains("kernel"), "{e}");
    let e = d.apply_filter(1, Target::Pixels, &filter("other.custom", json!({ "kernel": vec!["x"; 25] })), None, 1.0).unwrap_err();
    assert!(e.contains("kernel"), "{e}");
    let e = d.apply_filter(1, Target::Pixels, &filter("other.custom", json!({ "kernel": vec![1e300; 25] })), None, 1.0).unwrap_err();
    assert!(e.contains("-999..=999"), "{e}");
    let e = d.apply_filter(1, Target::Pixels, &filter("distort.shear", json!({ "shearCurve": [{ "y": 0, "offset": 0 }] })), None, 1.0).unwrap_err();
    assert!(e.contains("Shear") && e.contains("shearCurve"), "{e}");
    let f = filters::Filter::parse(&filter("distort.shear", json!({ "shearCurve": [{ "y": 2, "offset": 5 }, { "y": -1, "offset": -5 }] }))).unwrap();
    assert_eq!(f.params["shearCurve"], json!([{ "y": 0.0, "offset": -1.0 }, { "y": 1.0, "offset": 1.0 }]), "clamped and sorted");
}

#[test]
fn v6_round_trips_kernel_and_curve_params() {
    let mut v = v6_fixture();
    let filters = v["layers"][3]["smart"]["filters"].as_array_mut().unwrap();
    let mut k = vec![0.0; 25];
    k[12] = 2.0;
    k[3] = -1.0;
    for (id, kind, params) in [
        (5, "other.custom", json!({ "kernel": k })),
        (6, "distort.shear", json!({ "shearCurve": [{ "y": 0.0, "offset": 0.25 }, { "y": 0.5, "offset": -0.5 }, { "y": 1.0, "offset": 0.0 }] })),
    ] {
        filters.push(json!({ "id": id, "filter": { "kind": kind, "params": params }, "enabled": true, "opacity": 1.0, "blend": "normal", "mask": null }));
    }
    let first = load_v4(&v.to_string()).unwrap().manifest();
    assert_eq!(load_v4(&first).unwrap().manifest(), first);
    let m: Value = serde_json::from_str(&first).unwrap();
    let fl = m["layers"][3]["smart"]["filters"].as_array().unwrap();
    assert_eq!(fl[fl.len() - 2]["filter"]["params"]["kernel"][3], -1.0);
    assert_eq!(fl[fl.len() - 1]["filter"]["params"]["shearCurve"][1]["offset"], -0.5);
    v["layers"][3]["smart"]["filters"][4]["filter"]["params"]["kernel"] = json!([1, 2]);
    assert!(load_v4(&v.to_string()).err().expect("rejected").contains("kernel"));
}
