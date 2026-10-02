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

// 64x64 flat 90 with a black 16x16 hole at (24, 24), the hole selected.
fn hole_doc() -> Document {
    let mut d = doc_with(64, 64, |x, y| if (24..40).contains(&x) && (24..40).contains(&y) { gray(0) } else { gray(90) });
    d.select_rect(24.0, 24.0, 16.0, 16.0, Mode::New).unwrap();
    d
}

#[test]
fn content_aware_fill_fills_a_flat_hole_with_the_flat_value() {
    let mut d = hole_doc();
    assert!(d.content_aware_fill(1, 4.0, 5.0, None, false).unwrap());
    for y in 0..64 {
        for x in 0..64 {
            assert_eq!(lpx(&d, 1, x, y), gray(90), "({x}, {y})");
        }
    }
    assert!(d.has_selection());
}

#[test]
fn content_aware_fill_at_half_opacity_is_the_half_mix_of_old_and_fill() {
    let mut d = hole_doc();
    d.content_aware_fill(1, 4.0, 5.0, Some((PaintMode::Blend(Blend::Normal), 0.5, false)), false).unwrap();
    assert_eq!(lpx(&d, 1, 30, 30), gray(45));
    assert_eq!(lpx(&d, 1, 10, 10), gray(90));
}

#[test]
fn content_aware_fill_mixes_a_feathered_edge_by_its_coverage_once() {
    let mut d = hole_doc();
    d.feather_selection(4.0).unwrap();
    d.content_aware_fill(1, 4.0, 5.0, None, false).unwrap();
    let sel = d.selection.clone().unwrap();
    let mut partial = 0;
    for (x, y) in (0..64).flat_map(|y| (0..64).map(move |x| (x, y))) {
        let u = d.sel_at(&sel, x, y);
        let old = if (24..40).contains(&x) && (24..40).contains(&y) { 0.0 } else { 90.0 };
        let want = old + (90.0 - old) * u;
        let got = lpx(&d, 1, x, y)[0] as f32;
        partial += (u > 0.0 && u < 1.0 && old == 0.0) as usize;
        assert!((got - want).abs() <= 1.0, "({x}, {y}) u {u}: {got} vs {want}");
    }
    assert!(partial > 0);
}

#[test]
fn content_aware_fill_of_a_layer_with_every_pixel_in_the_hole_keeps_transparency() {
    let sq = |x: i32, y: i32, a: i32| (a..a + 2).contains(&x) && (a..a + 2).contains(&y);
    let mut d = doc_with(64, 64, |x, y| if sq(x, y, 30) || sq(x, y, 34) { gray(90) } else { [0; 4] });
    d.select_rect(24.0, 24.0, 16.0, 16.0, Mode::New).unwrap();
    assert!(!d.content_aware_fill(1, 4.0, 5.0, None, false).unwrap());
    assert_eq!((lpx(&d, 1, 34, 30), lpx(&d, 1, 30, 30)), ([0; 4], gray(90)));
}

#[test]
fn content_aware_fill_deselect_clears_the_selection() {
    let mut d = hole_doc();
    assert!(d.content_aware_fill(1, 4.0, 5.0, None, true).unwrap());
    assert!(!d.has_selection());
}

#[test]
fn content_aware_fill_without_a_source_or_on_a_locked_or_non_pixel_layer_changes_nothing() {
    let mut d = doc_with(64, 64, |x, y| if x < 20 && y < 20 { gray(90) } else { [0; 4] });
    d.select_rect(40.0, 40.0, 16.0, 16.0, Mode::New).unwrap();
    assert!(!d.content_aware_fill(1, 4.0, 5.0, None, true).unwrap());
    assert!(d.has_selection());
    assert_eq!((lpx(&d, 1, 45, 45), lpx(&d, 1, 10, 10)), ([0; 4], gray(90)));
    let mut d = doc_with(64, 64, |x, y| if (30..34).contains(&x) && (30..34).contains(&y) { gray(90) } else { [0; 4] });
    d.select_rect(24.0, 24.0, 16.0, 16.0, Mode::New).unwrap();
    assert!(!d.content_aware_fill(1, 4.0, 5.0, None, true).unwrap(), "every opaque pixel is in the hole");
    assert_eq!((lpx(&d, 1, 31, 31), lpx(&d, 1, 26, 26)), (gray(90), [0; 4]));
    let mut d = hole_doc();
    d.node_mut(1).unwrap().locks.pixels = true;
    let name = d.node(1).unwrap().name.clone();
    assert_eq!(d.content_aware_fill(1, 4.0, 5.0, None, false).unwrap_err(), format!("{name} is locked."));
    let g = d.add_group("g", 0).unwrap();
    assert_eq!(d.content_aware_fill(g, 4.0, 5.0, None, false).unwrap_err(), "Content-Aware Fill needs a pixel layer.");
    assert_eq!(lpx(&d, 1, 30, 30), gray(0));
}

// ---- B5: pixelate and stylize ----

// An 8 x 1 doc with `vals` as opaque gray from doc x `x0`, transparent elsewhere.
fn row_doc(x0: i32, vals: &[u8]) -> Document {
    doc_with(8, 1, |x, _| if x >= x0 && ((x - x0) as usize) < vals.len() { gray(vals[(x - x0) as usize]) } else { [0; 4] })
}

fn row(d: &Document, from: i32, to: i32) -> Vec<u8> {
    (from..to).map(|x| lpx(d, 1, x, 0)[0]).collect()
}

#[test]
fn mosaic_cells_align_to_the_document_origin() {
    let at0 = filtered(&row_doc(0, &[0, 100, 200, 250]), "pixelate.mosaic", json!({ "cellSize": 2 }));
    assert_eq!(row(&at0, 0, 4), [50, 50, 225, 225]);
    let at1 = filtered(&row_doc(1, &[0, 100, 200, 250]), "pixelate.mosaic", json!({ "cellSize": 2 }));
    assert_eq!(row(&at1, 1, 5), [0, 150, 150, 250], "the cell edges moved by one");
}

#[test]
fn find_edges_emboss_trace_contour_and_oil_paint_on_flat_and_step_layers() {
    let flat = doc_with(12, 12, |_, _| gray(100));
    assert_eq!(lpx(&filtered(&flat, "stylize.find_edges", json!({})), 1, 5, 5), gray(255));
    assert!(lpx(&filtered(&flat, "stylize.emboss", json!({})), 1, 5, 5)[0].abs_diff(128) <= 1);
    assert_eq!(lpx(&filtered(&flat, "stylize.trace_contour", json!({})), 1, 5, 5), gray(255));
    for params in [json!({ "stylization": 0.1 }), json!({}), json!({ "stylization": 10, "scale": 10, "shine": 10, "cleanliness": 10 })] {
        let o = filtered(&flat, "stylize.oil_paint", params.clone());
        assert!(same(&flat, &o, 12, 12), "{params}");
    }
    let step = doc_with(12, 6, |x, _| gray(if x < 6 { 0 } else { 255 }));
    for edge in ["lower", "upper"] {
        let o = filtered(&step, "stylize.trace_contour", json!({ "edge": edge }));
        for y in 0..6 {
            let dark: Vec<i32> = (0..12).filter(|&x| lpx(&o, 1, x, y)[0] == 0).collect();
            assert_eq!(dark, [if edge == "lower" { 5 } else { 6 }], "{edge} row {y}");
        }
    }
    let e = filtered(&step, "stylize.find_edges", json!({}));
    assert!(lpx(&e, 1, 5, 3)[0] < 128 && lpx(&e, 1, 1, 3) == gray(255), "an edge is dark on white");
}

#[test]
fn flat_layers_survive_wind_blast_stagger_diffuse_facet_fragment_and_mosaic() {
    let flat = doc_with(60, 40, |_, _| gray(100));
    for (kind, params) in [
        ("stylize.wind", json!({})),
        ("stylize.wind", json!({ "method": "blast", "direction": "fromTheLeft" })),
        ("stylize.wind", json!({ "method": "stagger" })),
        ("stylize.diffuse", json!({ "mode": "darkenOnly" })),
        ("stylize.diffuse", json!({ "mode": "anisotropic" })),
        ("pixelate.facet", json!({})),
        ("pixelate.fragment", json!({})),
        ("pixelate.mosaic", json!({ "cellSize": 7 })),
        ("pixelate.crystallize", json!({})),
    ] {
        assert!(same(&flat, &filtered(&flat, kind, params.clone()), 60, 40), "{kind} {params}");
    }
}

#[test]
fn mezzotint_writes_only_0_and_255_for_every_type() {
    let d = ramp(40, 30);
    for t in ["fineDots", "mediumDots", "grainyDots", "coarseDots", "shortLines", "mediumLines", "longLines", "shortStrokes", "mediumStrokes", "longStrokes"] {
        let o = filtered(&d, "pixelate.mezzotint", json!({ "type": t, "seed": 3 }));
        let mut dark = 0;
        for (x, y) in (0..30).flat_map(|y| (0..40).map(move |x| (x, y))) {
            let p = lpx(&o, 1, x, y);
            assert!(p[..3].iter().all(|&v| v == 0 || v == 255) && p[3] == 255, "{t} {p:?}");
            dark += (p[0] == 0) as usize;
        }
        assert!(dark > 0 && dark < 1200, "{t}: both values appear, {dark} dark");
    }
}

#[test]
fn random_filters_repeat_with_a_seed_and_differ_with_another() {
    let d = ramp(60, 40);
    for (kind, params) in [
        ("pixelate.crystallize", json!({})),
        ("pixelate.pointillize", json!({})),
        ("pixelate.mezzotint", json!({ "type": "grainyDots" })),
        ("stylize.diffuse", json!({})),
        ("stylize.wind", json!({})),
        ("stylize.wind", json!({ "method": "stagger" })),
        ("stylize.extrude", json!({ "size": 10, "depth": 255 })),
        ("stylize.tiles", json!({ "numberOfTiles": 4, "maxOffset": 40 })),
    ] {
        let with = |seed: u32| {
            let mut p = params.clone();
            p["seed"] = seed.into();
            filtered(&d, kind, p)
        };
        assert!(same(&with(5), &with(5), 60, 40), "{kind}");
        assert!(!same(&with(5), &with(6), 60, 40), "{kind} seeds differ");
    }
}

#[test]
fn tile_by_tile_equals_whole_layer_for_pixelate_and_stylize() {
    for (kind, params, m) in [
        ("pixelate.crystallize", json!({ "cellSize": 10, "seed": 3 }), 20),
        ("pixelate.pointillize", json!({ "cellSize": 8, "seed": 3 }), 16),
        ("pixelate.mosaic", json!({ "cellSize": 7 }), 7),
        ("pixelate.facet", json!({}), 1),
        ("pixelate.mezzotint", json!({ "type": "mediumStrokes", "seed": 2 }), 0),
        ("pixelate.mezzotint", json!({ "type": "grainyDots", "seed": 2 }), 0),
        ("pixelate.color_halftone", json!({ "maxRadius": 4 }), 12),
        ("stylize.diffuse", json!({ "seed": 4 }), 1),
        ("stylize.diffuse", json!({ "mode": "lightenOnly", "seed": 4 }), 1),
        ("stylize.diffuse", json!({ "mode": "anisotropic" }), 1),
        ("stylize.emboss", json!({ "angle": 30 }), 2),
        ("stylize.find_edges", json!({}), 1),
        ("stylize.trace_contour", json!({ "level": 100 }), 1),
        ("stylize.oil_paint", json!({ "stylization": 2, "scale": 1, "shine": 4 }), 8),
        ("stylize.wind", json!({ "seed": 4 }), 12),
        ("stylize.wind", json!({ "method": "blast", "direction": "fromTheLeft", "seed": 4 }), 40),
        ("stylize.wind", json!({ "method": "stagger", "seed": 4 }), 8),
        ("stylize.extrude", json!({ "seed": 4 }), 0),
        ("stylize.tiles", json!({ "numberOfTiles": 3, "maxOffset": 30, "seed": 4 }), 0),
    ] {
        assert_eq!(whole_layer_diff(kind, params.clone(), m), 0, "{kind} {params}");
    }
    // A mean of four 8-bit values lands on x.5 often, and the runner's `old + (new - old)` mix then rounds either way.
    assert!(whole_layer_diff("pixelate.fragment", json!({}), 4) <= 1);
}

#[test]
fn tiles_with_a_zero_offset_is_the_identity_and_gaps_follow_the_fill() {
    let d = ramp(40, 40);
    // The offset is trunc(hash x maxOffset % x tile size): 0 for one 40 px tile at 1 %.
    assert!(same(&d, &filtered(&d, "stylize.tiles", json!({ "numberOfTiles": 1, "maxOffset": 1 })), 40, 40));
    let shifted = |fill: &str| filtered(&d, "stylize.tiles", json!({ "numberOfTiles": 2, "maxOffset": 50, "fillEmptyAreaWith": fill, "seed": 1 }));
    let bg = shifted("background");
    assert!((0..40).any(|x| lpx(&bg, 1, x, 5) == gray(255)), "the background fills the gaps");
    assert!(!same(&d, &bg, 40, 40));
    let fg = shifted("foreground");
    assert!((0..40).any(|x| lpx(&fg, 1, x, 5)[..3] == [0, 0, 0]), "the foreground fills the gaps");
    let unaltered = shifted("unalteredImage");
    assert!((0..40).all(|x| lpx(&unaltered, 1, x, 5)[3] == 255) && !same(&unaltered, &bg, 40, 40), "unaltered gaps show the source");
}

#[test]
fn extrude_masks_incomplete_blocks_and_solid_fronts_are_cell_means() {
    let d = ramp(25, 25);
    let solid = |mask: bool| filtered(&d, "stylize.extrude", json!({ "size": 10, "depth": 1, "solidFrontFaces": true, "maskIncompleteBlocks": mask }));
    assert_eq!(lpx(&solid(true), 1, 22, 22), lpx(&d, 1, 22, 22), "a cell cut by the layer bounds keeps its pixels");
    assert_ne!(lpx(&solid(false), 1, 20, 20), lpx(&d, 1, 20, 20));
    assert_ne!(lpx(&solid(true), 1, 2, 2), lpx(&d, 1, 2, 2));
    assert_eq!(lpx(&solid(true), 1, 2, 2), lpx(&solid(true), 1, 7, 7), "one cell, one color");
    let pyr = filtered(&d, "stylize.extrude", json!({ "type": "pyramids", "size": 10, "depth": 1 }));
    assert_ne!(lpx(&pyr, 1, 5, 1), lpx(&pyr, 1, 5, 8), "pyramid faces are shaded differently");
}

#[test]
fn color_halftone_pointillize_and_oil_paint_change_a_ramp() {
    let d = ramp(48, 48);
    for (kind, params) in [
        ("pixelate.color_halftone", json!({})),
        ("pixelate.pointillize", json!({})),
        ("pixelate.fragment", json!({})),
        ("stylize.oil_paint", json!({ "stylization": 8 })),
        ("stylize.emboss", json!({})),
        ("stylize.find_edges", json!({})),
    ] {
        assert!(!same(&d, &filtered(&d, kind, params.clone()), 48, 48), "{kind}");
    }
    let noisy = seam_doc();
    assert!(!same(&noisy, &filtered(&noisy, "pixelate.facet", json!({})), 300, 20), "the median of a noisy 3x3 differs");
    let h = filtered(&d, "pixelate.color_halftone", json!({ "maxRadius": 8 }));
    assert!((0..48).any(|x| lpx(&h, 1, x, 20)[0] == 255) && (0..48).any(|x| lpx(&h, 1, x, 20)[0] < 100), "dots on white");
}

#[test]
fn pixelate_and_stylize_menus_list_the_reference_order() {
    let v: Value = serde_json::from_str(&filters::schema_json()).unwrap();
    let ids = |g: &str| v.as_array().unwrap().iter().filter(|e| e["group"] == g).map(|e| e["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids("pixelate"), [
        "pixelate.color_halftone", "pixelate.crystallize", "pixelate.facet", "pixelate.fragment", "pixelate.mezzotint", "pixelate.mosaic", "pixelate.pointillize",
    ]);
    assert_eq!(ids("stylize"), [
        "stylize.diffuse", "stylize.emboss", "stylize.extrude", "stylize.find_edges", "stylize.oil_paint", "stylize.solarize", "stylize.tiles", "stylize.trace_contour", "stylize.wind",
    ]);
}

// `kind` run straight on a transparent plane over `r` of a `w` x `h` document.
fn render_plane(kind: &str, params: Value, r: [i32; 4], w: i32, h: i32) -> filters::Plane {
    let mut p = filters::Plane { x: r[0], y: r[1], w: r[2] as usize, h: r[3] as usize, data: vec![0.0; (r[2] * r[3] * 4) as usize] };
    let f = filters::Filter::parse(&filter(kind, params)).unwrap();
    let blobs = HashMap::new();
    filters::apply(&f, &mut p, &Ctx { blobs: &blobs, cov: None, bounds: [0, 0, w, h], scale: 1.0, mask: None }).unwrap();
    p
}

fn pixels(w: i32, h: i32) -> impl Iterator<Item = (i32, i32)> {
    (0..h).flat_map(move |y| (0..w).map(move |x| (x, y)))
}

#[test]
fn render_filters_draw_at_document_size_on_an_empty_layer() {
    let d = Document::new(40, 30, 8).unwrap();
    for (kind, params) in [
        ("render.clouds", json!({ "seed": 1 })),
        ("render.difference_clouds", json!({ "seed": 1 })),
        ("render.fibers", json!({ "seed": 1 })),
        ("render.picture_frame", json!({})),
    ] {
        let o = filtered(&d, kind, params);
        assert!(lpx(&o, 1, 0, 0)[3] > 0 && lpx(&o, 1, 39, 29)[3] > 0, "{kind} reaches the document corners");
    }
    let flare = filtered(&d, "render.lens_flare", json!({}));
    assert!(lpx(&flare, 1, 20, 15)[3] > 200, "the flare center is drawn on transparency");
    let big = Document::new(120, 120, 8).unwrap();
    let tree = filtered(&big, "render.tree", json!({}));
    assert!((0..120).any(|y| lpx(&tree, 1, 60, y)[3] == 255), "the trunk is opaque");
    let flame = filtered(&big, "render.flame", json!({ "seed": 2 }));
    assert!(pixels(120, 120).any(|(x, y)| lpx(&flame, 1, x, y)[3] > 0));
}

#[test]
fn clouds_stay_between_the_colors_repeat_with_a_seed_and_render_tile_exact() {
    let d = Document::new(64, 48, 8).unwrap();
    let c = |seed: u32| filtered(&d, "render.clouds", json!({ "foreground": "#204080", "background": "#c0a010", "seed": seed }));
    let a = c(7);
    let (mut lo, mut hi) = ([255u8; 3], [0u8; 3]);
    for (x, y) in pixels(64, 48) {
        let p = lpx(&a, 1, x, y);
        assert_eq!(p[3], 255);
        for k in 0..3 {
            let (f, b) = ([0x20u8, 0x40, 0x80][k], [0xc0u8, 0xa0, 0x10][k]);
            assert!(p[k] >= f.min(b) && p[k] <= f.max(b), "channel {k} = {} at {x},{y}", p[k]);
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    assert!(hi[0] - lo[0] > 60, "clouds vary: {lo:?}..{hi:?}");
    assert!(same(&a, &c(7), 64, 48));
    assert!(!same(&a, &c(8), 64, 48));
    for kind in ["render.clouds", "render.difference_clouds", "render.fibers"] {
        let whole = render_plane(kind, json!({ "seed": 3 }), [0, 0, 300, 40], 300, 40);
        let part = render_plane(kind, json!({ "seed": 3 }), [130, 10, 70, 20], 300, 40);
        for (i, j) in pixels(70, 20) {
            let (w, p) = (&whole.data[(((10 + j) * 300 + 130 + i) * 4) as usize..][..4], &part.data[((j * 70 + i) * 4) as usize..][..4]);
            assert_eq!(w, p, "{kind} at {i},{j}");
        }
    }
}

#[test]
fn difference_clouds_twice_with_one_seed_on_black_is_black() {
    let mut d = doc_with(50, 40, |_, _| gray(0));
    for _ in 0..2 {
        d.apply_filter(1, Target::Pixels, &filter("render.difference_clouds", json!({ "seed": 11 })), None, 1.0).unwrap();
    }
    for (x, y) in pixels(50, 40) {
        let p = lpx(&d, 1, x, y);
        assert!(p[..3].iter().all(|&v| v <= 1) && p[3] == 255, "{p:?} at {x},{y}");
    }
}

#[test]
fn lens_flare_brightness_raises_the_center_peak() {
    let d = doc_with(80, 60, |_, _| gray(40));
    let peak = |b: f64| lpx(&filtered(&d, "render.lens_flare", json!({ "brightness": b, "center": { "x": 0.5, "y": 0.5 } })), 1, 40, 30)[0];
    let (p10, p20, p40, p100, p300) = (peak(10.0), peak(20.0), peak(40.0), peak(100.0), peak(300.0));
    assert!(40 < p10 && p10 < p20 && p20 < p40 && p40 <= p100 && p100 <= p300, "{p10} {p20} {p40} {p100} {p300}");
    let looks: Vec<Document> = ["zoom50to300", "prime35", "prime105", "moviePrime"].iter().map(|t| filtered(&d, "render.lens_flare", json!({ "lensType": t }))).collect();
    for i in 0..4 {
        assert!(!same(&d, &looks[i], 80, 60) && !same(&looks[i], &looks[(i + 1) % 4], 80, 60), "lens type {i}");
    }
}

#[test]
fn lighting_effects_without_lights_at_full_ambience_is_the_identity() {
    let d = ramp(40, 30);
    let o = filtered(&d, "render.lighting_effects", json!({ "lights": [], "ambience": 100 }));
    for (x, y) in pixels(40, 30) {
        let (a, b) = (lpx(&d, 1, x, y), lpx(&o, 1, x, y));
        assert!((0..4).all(|c| a[c].abs_diff(b[c]) <= 1), "{a:?} -> {b:?} at {x},{y}");
    }
    let lit = filtered(&d, "render.lighting_effects", json!({}));
    assert!(!same(&d, &lit, 40, 30), "the default spot light changes the layer");
    let point = |x: f64| json!({ "lights": [{ "type": "point", "x": x, "y": 0.5, "z": 0.3 }], "ambience": 0 });
    let left = filtered(&d, "render.lighting_effects", point(0.1));
    assert!(lpx(&left, 1, 4, 15)[2] > lpx(&left, 1, 36, 15)[2], "a point light is brighter near it");
    let infinite = filtered(&d, "render.lighting_effects", json!({ "lights": [{ "type": "infinite", "color": "#ff0000" }], "ambience": 0 }));
    assert_eq!(lpx(&infinite, 1, 30, 10)[1], 0, "a red light leaves green dark");
    let bump = filtered(&d, "render.lighting_effects", json!({ "textureChannel": "red", "textureHeight": 100 }));
    assert!(!same(&lit, &bump, 40, 30), "a texture channel adds relief");
    for bad in [json!([{ "type": "laser" }]), json!([{ "x": 2 }]), json!([{ "glow": 1 }])] {
        let e = d.clone().apply_filter(1, Target::Pixels, &filter("render.lighting_effects", json!({ "lights": bad })), None, 1.0).unwrap_err();
        assert!(e.contains("Lighting Effects") && e.contains("lights"), "{e}");
    }
}

#[test]
fn tree_flame_and_picture_frame_repeat_per_seed() {
    let d = Document::new(100, 100, 8).unwrap();
    for (kind, a, b) in [
        ("render.tree", json!({ "arrangement": 4 }), json!({ "arrangement": 5 })),
        ("render.tree", json!({ "treeType": "willow", "randomizeShapes": true, "arrangement": 1 }), json!({ "treeType": "willow", "randomizeShapes": true, "arrangement": 2 })),
        ("render.flame", json!({ "seed": 4 }), json!({ "seed": 5 })),
        ("render.flame", json!({ "flameType": "multipleFlamesVarious", "seed": 4 }), json!({ "flameType": "multipleFlamesVarious", "seed": 5 })),
        ("render.picture_frame", json!({ "frameType": "beads" }), json!({ "frameType": "ivy" })),
    ] {
        assert!(same(&filtered(&d, kind, a.clone()), &filtered(&d, kind, a.clone()), 100, 100), "{kind} {a}");
        assert!(!same(&filtered(&d, kind, a.clone()), &filtered(&d, kind, b.clone()), 100, 100), "{kind} {a} vs {b}");
    }
    for t in ["simple", "doubleLine", "beads", "ivy", "ribbon", "scallop"] {
        let o = filtered(&d, "render.picture_frame", json!({ "frameType": t, "margin": 10, "frameWidth": 10 }));
        assert_eq!(lpx(&o, 1, 50, 50)[3], 0, "{t}: the inside stays untouched");
        assert_eq!(lpx(&o, 1, 50, 15)[3], 255, "{t}: the matte band");
        assert_eq!(lpx(&o, 1, 2, 50)[3], 255, "{t}: the frame band");
    }
    let flame = filtered(&d, "render.flame", json!({ "path": [{ "x": 0.2, "y": 0.9 }, { "x": 0.4, "y": 0.9 }], "seed": 1 }));
    assert!(pixels(100, 100).all(|(x, y)| x < 60 || lpx(&flame, 1, x, y)[3] == 0), "flames stay near their path");
}

#[test]
fn render_menu_lists_the_reference_order_and_colors_are_hidden_params() {
    let v: Value = serde_json::from_str(&filters::schema_json()).unwrap();
    let render: Vec<&Value> = v.as_array().unwrap().iter().filter(|e| e["group"] == "render").collect();
    let ids: Vec<&str> = render.iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, [
        "render.clouds", "render.difference_clouds", "render.fibers", "render.lens_flare", "render.lighting_effects", "render.flame", "render.picture_frame", "render.tree",
    ]);
    assert_eq!(render[0]["preview"], false);
    assert_eq!(render[0]["params"][0]["kind"], "color");
    assert_eq!(render[4]["params"][0]["kind"], "lights");
    assert_eq!(render[5]["params"][1]["kind"], "path");
    let e = Document::new(8, 8, 8).unwrap().apply_filter(1, Target::Pixels, &filter("render.clouds", json!({ "foreground": "red" })), None, 1.0).unwrap_err();
    assert!(e.contains("Clouds") && e.contains("foreground"), "{e}");
    let e = Document::new(8, 8, 8).unwrap().apply_filter(1, Target::Pixels, &filter("render.flame", json!({ "path": [{ "x": 0.5, "y": 0.5 }] })), None, 1.0).unwrap_err();
    assert!(e.contains("Flame") && e.contains("path"), "{e}");
}

// ---- B7: blur gallery ----

// A seeded texture, so every blur changes pixels.
fn texture(w: u32, h: u32) -> Document {
    doc_with(w, h, |x, y| {
        let h = (x as u32).wrapping_mul(2654435761) ^ (y as u32).wrapping_mul(40503);
        [(h >> 3) as u8, (h >> 11) as u8, (h >> 19) as u8, 255]
    })
}

#[test]
fn neutral_blur_gallery_settings_change_nothing() {
    let d = texture(40, 30);
    for (kind, params) in [
        ("blur_gallery.field_blur", json!({ "pins": [{ "x": 0.5, "y": 0.5, "blur": 0 }] })),
        ("blur_gallery.iris_blur", json!({ "blur": 0 })),
        ("blur_gallery.tilt_shift", json!({ "blur": 0 })),
        ("blur_gallery.path_blur", json!({ "speed": 0 })),
        ("blur_gallery.spin_blur", json!({ "blurAngle": 0 })),
    ] {
        assert!(same(&d, &filtered(&d, kind, params), 40, 30), "{kind}");
    }
}

#[test]
fn iris_keeps_its_center_sharp_and_blurs_outside() {
    let d = texture(40, 40);
    let o = filtered(&d, "blur_gallery.iris_blur", json!({ "blur": 4, "radius": 0.3 }));
    assert_eq!(lpx(&o, 1, 20, 20), lpx(&d, 1, 20, 20));
    assert_ne!(lpx(&o, 1, 2, 2), lpx(&d, 1, 2, 2));
}

#[test]
fn tilt_shift_keeps_the_focus_band_and_blurs_past_the_feather_like_a_flat_disc() {
    let d = texture(40, 60);
    // Short side 40: focus 6 px and feather 10 px around row 30.
    let o = filtered(&d, "blur_gallery.tilt_shift", json!({ "blur": 4 }));
    let flat = filtered(&d, "blur_gallery.field_blur", json!({ "pins": [{ "x": 0.5, "y": 0.5, "blur": 4 }] }));
    for x in 0..40 {
        for y in 25..=35 {
            assert_eq!(lpx(&o, 1, x, y), lpx(&d, 1, x, y), "focus row {y}");
        }
        for y in (0..=13).chain(47..60) {
            let (a, b) = (lpx(&o, 1, x, y), lpx(&flat, 1, x, y));
            assert!((0..4).all(|c| a[c].abs_diff(b[c]) <= 2), "row {y}: {a:?} vs {b:?}");
        }
    }
    assert!((0..40).any(|x| lpx(&o, 1, x, 5) != lpx(&d, 1, x, 5)), "blurred");
}

#[test]
fn field_pins_weight_by_inverse_distance() {
    let d = texture(60, 20);
    let pins = json!([{ "x": 0.0, "y": 0.5, "blur": 0 }, { "x": 1.0, "y": 0.5, "blur": 6 }]);
    let o = filtered(&d, "blur_gallery.field_blur", json!({ "pins": pins }));
    assert_eq!(lpx(&o, 1, 0, 10), lpx(&d, 1, 0, 10), "a 0 px pin keeps its spot sharp");
    assert_ne!(lpx(&o, 1, 58, 10), lpx(&d, 1, 58, 10));
}

#[test]
fn blur_gallery_noise_repeats_with_a_seed_and_differs_with_another() {
    let d = texture(40, 30);
    for kind in ["blur_gallery.iris_blur", "blur_gallery.path_blur", "blur_gallery.spin_blur"] {
        let with = |seed: u32| filtered(&d, kind, json!({ "noiseAmount": 60, "seed": seed }));
        assert!(same(&with(5), &with(5), 40, 30), "{kind}");
        assert!(!same(&with(5), &with(6), 40, 30), "{kind} seeds differ");
    }
}

#[test]
fn path_and_spin_blur_and_light_bokeh_change_pixels() {
    let d = texture(40, 30);
    for (kind, params) in [
        ("blur_gallery.path_blur", json!({})),
        ("blur_gallery.path_blur", json!({ "centeredBlur": false, "taper": 50, "strobeFlashes": 4, "strobeStrength": 100 })),
        ("blur_gallery.path_blur", json!({ "blurShape": "rearSync", "paths": [[{ "x": 0.1, "y": 0.1 }, { "x": 0.9, "y": 0.9 }], [{ "x": 0.1, "y": 0.9 }, { "x": 0.5, "y": 0.5 }, { "x": 0.9, "y": 0.1 }]] })),
        ("blur_gallery.spin_blur", json!({ "strobeFlashes": 3 })),
    ] {
        assert!(!same(&d, &filtered(&d, kind, params.clone()), 40, 30), "{kind} {params}");
    }
    let iris = |extra: Value| filtered(&d, "blur_gallery.iris_blur", json!({ "blur": 3, "lightBokeh": extra }));
    assert!(!same(&iris(json!(0)), &iris(json!(100)), 40, 30), "light bokeh brightens");
}

#[test]
fn tile_by_tile_equals_whole_layer_for_the_blur_gallery() {
    for (kind, params, m) in [
        ("blur_gallery.field_blur", json!({ "pins": [{ "x": 0.2, "y": 0.5, "blur": 0 }, { "x": 0.9, "y": 0.2, "blur": 5 }], "noiseAmount": 40, "seed": 3 }), 5),
        ("blur_gallery.iris_blur", json!({ "blur": 5, "radius": 0.2, "roundness": 0.5, "rotation": 30 }), 5),
        ("blur_gallery.tilt_shift", json!({ "blur": 4, "rotation": 80, "distortion": 0.5, "lightBokeh": 50 }), 10),
    ] {
        assert_eq!(whole_layer_diff(kind, params, m), 0, "{kind}");
    }
}

#[test]
fn blur_gallery_menu_lists_the_reference_order_and_pins_and_paths_validate() {
    let v: Value = serde_json::from_str(&filters::schema_json()).unwrap();
    let bg: Vec<&Value> = v.as_array().unwrap().iter().filter(|e| e["group"] == "blurGallery").collect();
    let ids: Vec<&str> = bg.iter().map(|e| e["id"].as_str().unwrap()).collect();
    assert_eq!(ids, ["blur_gallery.field_blur", "blur_gallery.iris_blur", "blur_gallery.tilt_shift", "blur_gallery.path_blur", "blur_gallery.spin_blur"]);
    assert_eq!(bg[0]["params"][0]["kind"], "pins");
    assert_eq!(bg[3]["params"][0]["kind"], "paths");
    let mut d = Document::new(8, 8, 8).unwrap();
    let e = d.apply_filter(1, Target::Pixels, &filter("blur_gallery.field_blur", json!({ "pins": [{ "x": 2, "y": 0.5, "blur": 1 }] })), None, 1.0).unwrap_err();
    assert!(e.contains("Field Blur") && e.contains("pins"), "{e}");
    let e = d.apply_filter(1, Target::Pixels, &filter("blur_gallery.field_blur", json!({ "pins": [] })), None, 1.0).unwrap_err();
    assert!(e.contains("pins"), "{e}");
    let e = d.apply_filter(1, Target::Pixels, &filter("blur_gallery.path_blur", json!({ "paths": [[{ "x": 0.5, "y": 0.5 }]] })), None, 1.0).unwrap_err();
    assert!(e.contains("Path Blur") && e.contains("paths"), "{e}");
}

#[test]
fn a_proxy_preview_places_pins_and_paths_on_the_tight_layer_bounds() {
    // Content x 0..40 of a 300 px doc: black left of 20, white right; tile bounds would be far wider.
    let mut d = doc_with(300, 40, |x, _| if x < 40 { gray(if x < 20 { 0 } else { 255 }) } else { [0; 4] });
    let pins = json!([{ "x": 0.0, "y": 0.5, "blur": 0 }, { "x": 1.0, "y": 0.5, "blur": 16 }]);
    d.apply_filter(1, Target::Pixels, &filter("blur_gallery.field_blur", json!({ "pins": pins })), Some([0, 0, 300, 40]), 0.5).unwrap();
    assert!(lpx(&d, 1, 18, 20)[0] > 30, "the 16 px pin sits on the layer's right edge and blurs the edge at x 20");
}

// ---------- B8 Filter Gallery ----------

fn gallery_kinds() -> Vec<String> {
    let v: Value = serde_json::from_str(&filters::schema_json()).unwrap();
    v.as_array().unwrap().iter().filter(|e| e["group"].as_str().unwrap().starts_with("gallery.")).map(|e| e["id"].as_str().unwrap().to_string()).collect()
}

fn stack(layers: &[(&str, Value)]) -> Value {
    json!({ "stack": layers.iter().map(|(k, p)| json!({ "kind": k, "enabled": true, "params": p })).collect::<Vec<_>>(), "seed": 5 })
}

#[test]
fn the_gallery_lists_47_effects_in_six_groups() {
    let v: Value = serde_json::from_str(&filters::schema_json()).unwrap();
    let count = |g: &str| v.as_array().unwrap().iter().filter(|e| e["group"] == g).count();
    let groups = [("gallery.artistic", 15), ("gallery.brushStrokes", 8), ("gallery.distort", 3), ("gallery.sketch", 14), ("gallery.stylize", 1), ("gallery.texture", 6)];
    assert_eq!(groups.map(|(g, _)| count(g)), groups.map(|(_, n)| n));
    assert_eq!(gallery_kinds().len(), 47);
}

#[test]
fn every_gallery_effect_is_deterministic_per_seed_and_changes_the_ramp() {
    let d = ramp(48, 40);
    for kind in gallery_kinds() {
        let a = filtered(&d, &kind, json!({ "seed": 9 }));
        assert!(same(&a, &filtered(&d, &kind, json!({ "seed": 9 })), 48, 40), "{kind} is deterministic");
        assert!(!same(&a, &d, 48, 40), "{kind} changes the layer");
    }
}

#[test]
fn every_gallery_effect_on_the_whole_layer_equals_its_plane_run() {
    // Palette Knife averages sector pixels; an exact .5 mean may store either way at 8 bits.
    for kind in gallery_kinds() {
        let tie = u8::from(kind.ends_with("palette_knife"));
        let params = if kind.ends_with("mosaic_tiles") { json!({ "seed": 4, "tileSize": 4 }) } else { json!({ "seed": 4 }) };
        assert!(whole_layer_diff(&kind, params, 0) <= tie, "{kind}");
    }
}

#[test]
fn neutral_gallery_settings_leave_the_layer_unchanged() {
    let d = ramp(40, 30);
    for (kind, params) in [
        ("gallery.brushStrokes.spatter", json!({ "sprayRadius": 0 })),
        ("gallery.distort.glass", json!({ "distortion": 0 })),
        ("gallery.distort.ocean_ripple", json!({ "rippleMagnitude": 0 })),
        ("gallery.texture.grain", json!({ "intensity": 0, "contrast": 50 })),
    ] {
        assert!(same(&filtered(&d, kind, params), &d, 40, 30), "{kind}");
    }
}

#[test]
fn a_stack_of_one_equals_the_effect_and_order_matters() {
    let d = ramp(48, 40);
    let alone = filtered(&d, "gallery.artistic.cutout", json!({ "seed": 5 }));
    assert!(same(&filtered(&d, "gallery.filter_gallery", stack(&[("gallery.artistic.cutout", json!({}))])), &alone, 48, 40));
    let (a, b) = (("gallery.artistic.cutout", json!({})), ("gallery.stylize.glowing_edges", json!({})));
    let ab = filtered(&d, "gallery.filter_gallery", stack(&[a.clone(), b.clone()]));
    assert!(!same(&ab, &filtered(&d, "gallery.filter_gallery", stack(&[b, a])), 48, 40), "Cutout then Glowing Edges differs from the reverse");
    let off = json!({ "stack": [{ "kind": "gallery.artistic.cutout", "enabled": false, "params": {} }] });
    assert!(same(&filtered(&d, "gallery.filter_gallery", off), &d, 48, 40), "a disabled layer does nothing");
}

#[test]
fn gallery_stack_entries_validate_and_store_only_their_own_params() {
    let f = filters::Filter::parse(&filter("gallery.filter_gallery", stack(&[("gallery.texture.grain", json!({ "intensity": 10, "seed": 3 }))]))).unwrap();
    let p = &f.params["stack"][0]["params"];
    assert_eq!(p["intensity"], 10);
    assert!(p.get("seed").is_none() && p.get("foreground").is_none(), "{p}");
    for (layer, needle) in [
        (json!({ "kind": "blur.blur", "enabled": true, "params": {} }), "not a Filter Gallery effect"),
        (json!({ "kind": "gallery.texture.grain", "enabled": true, "params": { "intensity": 500 } }), "intensity"),
        (json!({ "kind": "gallery.texture.grain", "params": {} }), "kind, enabled, params"),
    ] {
        let e = filters::Filter::parse(&filter("gallery.filter_gallery", json!({ "stack": [layer] }))).unwrap_err();
        assert!(e.contains("Filter Gallery") && e.contains("entry 1") && e.contains(needle), "{e}");
    }
}


// A mesh over `d` that shifts every node by (dx, 0): output x shows source x + dx.
fn shift_mesh(d: &mut Document, dx: f32) -> u64 {
    let mut m = crate::liquify::Mesh::new(d.width, d.height, 4);
    m.disp.chunks_exact_mut(2).for_each(|v| v[0] = dx);
    d.blob_add(&m.to_bytes()).unwrap()
}

#[test]
fn liquify_moves_pixels_into_empty_areas_and_needs_its_mesh() {
    let mut d = doc_with(16, 8, |x, _| if x < 8 { gray(200) } else { [0; 4] });
    let blob = shift_mesh(&mut d, -4.0);
    d.apply_filter(1, Target::Pixels, &filter("liquify", json!({ "mesh": blob, "reach": 4 })), None, 1.0).unwrap();
    assert_eq!(lpx(&d, 1, 11, 3), gray(200), "the layer content moved right past its bounds");
    assert_eq!(lpx(&d, 1, 12, 3), [0; 4]);
    assert!(d.apply_filter(1, Target::Pixels, &filter("liquify", json!({ "mesh": 999 })), None, 1.0).unwrap_err().contains("unknown blob"));
}

#[test]
fn a_liquify_smart_filter_renders_like_the_destructive_liquify() {
    let mut d = doc_with(16, 8, |x, y| [(x * 15) as u8, (y * 30) as u8, 90, 255]);
    let blob = shift_mesh(&mut d, 2.5);
    let mut flat = d.clone();
    let f = filter("liquify", json!({ "mesh": blob, "reach": 3 }));
    d.convert_for_smart_filters(1, &json!({ "link_id": "l", "source_blob": null }).to_string()).unwrap();
    d.apply_filter(1, Target::Pixels, &f, None, 1.0).unwrap();
    flat.apply_filter(1, Target::Pixels, &f, None, 1.0).unwrap();
    // Interior only: past the document edge a smart object reads transparency, a layer its edge pixels.
    for (x, y) in [(0, 0), (5, 3), (12, 7), (9, 4)] {
        assert_eq!(lpx(&d, 1, x, y), lpx(&flat, 1, x, y), "{x},{y}");
    }
}

#[test]
fn liquify_sessions_read_the_layer_proxy_and_the_selection_mask() {
    let mut d = doc_with(32, 16, |x, _| if x < 16 { gray(255) } else { [0; 4] });
    let mut s = d.liquify_begin(1, 16, 8, None).unwrap();
    assert_eq!((s.proxy_width(), s.proxy_height(), s.scale()), (16, 8, 0.5));
    let px = s.render();
    assert_eq!((px[3], px[(8 * 4 + 15) * 4 + 3]), (255, 0), "the proxy covers the document rect");
    d.liquify_mask(&mut s, 1, "transparency", "replace").unwrap();
    assert_eq!(s.frozen()[..5], [1.0, 1.0, 0.0, 0.0, 0.0], "nodes at x 0 and 8 lie on opaque pixels");
    d.select_rect(20.0, 0.0, 12.0, 16.0, Mode::New).unwrap();
    d.liquify_mask(&mut s, 1, "selection", "add").unwrap();
    assert_eq!(s.frozen()[..5], [1.0, 1.0, 0.0, 1.0, 1.0], "add keeps the opaque nodes and adds the selected ones");
}

#[test]
fn re_editing_a_liquify_smart_filter_previews_the_input_below_it() {
    let mut d = doc_with(16, 8, |x, y| [(x * 15) as u8, (y * 30) as u8, 90, 255]);
    let plain = d.liquify_begin(1, 16, 4, None).unwrap().render();
    d.convert_for_smart_filters(1, &json!({ "link_id": "l", "source_blob": null }).to_string()).unwrap();
    let blob = shift_mesh(&mut d, 2.5);
    d.apply_filter(1, Target::Pixels, &filter("liquify", json!({ "mesh": blob, "reach": 3 })), None, 1.0).unwrap();
    run(&mut d, "stylize.solarize");
    let fid = d.smart(1).unwrap().filters[0].id;
    let again = d.liquify_begin(1, 16, 8, Some(fid)).unwrap();
    assert_eq!(again.bytes(), d.blobs[&blob].as_slice(), "re-editing reads the stored mesh");
    let mut flat = again;
    flat.restore_all();
    assert_eq!(flat.render(), plain, "the source is the layer before this Liquify and the filters above it");
}
