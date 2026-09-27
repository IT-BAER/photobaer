//! Compositor goldens for shape, text, vector mask and artboard layers (docs/M4.md section 3).

use super::super::m4_tests::text;
use super::super::*;
use crate::geom;
use crate::path::{ArtboardBackground, Cap, Join, ShapeStroke, StrokeAlign, VectorPath};
use serde_json::json;

fn doc(w: u32, h: u32, white: bool) -> Document {
    let mut d = Document::new(w, h, 8).unwrap();
    if white {
        d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    }
    d
}

// A pixel layer holding `rgba` inside [x0, x1) x [y0, y1).
fn rect_layer(d: &mut Document, above: u32, [x0, y0, x1, y1]: [usize; 4], rgba: [u8; 4]) -> u32 {
    let l = d.add_layer("r", above).unwrap();
    let (ntx, nty) = d.level_tiles(0);
    for ty in 0..nty {
        for tx in 0..ntx {
            let mut t = vec![0u8; TILE_BYTES_U8];
            for p in 0..TILE_PIXELS {
                let (x, y) = (tx as usize * TILE + p % TILE, ty as usize * TILE + p / TILE);
                if x >= x0 && x < x1 && y >= y0 && y < y1 {
                    t[p * 4..p * 4 + 4].copy_from_slice(&rgba);
                }
            }
            d.set_tile_rgba8(l, tx, ty, &t).unwrap();
        }
    }
    l
}

fn rect(l: f64, t: f64, r: f64, b: f64) -> VectorPath {
    geom::rect([l, t, r, b], [0.0; 4])
}

fn solid(color: [u8; 3]) -> FillContent {
    FillContent::Solid(crate::content::SolidFill { color })
}

fn shape_layer(d: &mut Document, above: u32, path: VectorPath, fill: Option<[u8; 3]>, stroke: Option<ShapeStroke>) -> u32 {
    let l = d.add_layer("s", above).unwrap();
    d.node_mut(l).unwrap().kind = Kind::Shape(Box::new(ShapeData { path, live: None, fill: fill.map(solid), stroke }));
    l
}

fn outside_stroke(width: f64, join: Join, dash: Vec<f64>) -> ShapeStroke {
    ShapeStroke {
        enabled: true,
        width,
        align: StrokeAlign::Outside,
        cap: Cap::Butt,
        join,
        miter_limit: 4.0,
        dash,
        dash_offset: 0.0,
        content: solid([0, 0, 0]),
        opacity: 1.0,
        blend: Blend::Normal,
    }
}

fn vmask(path: VectorPath, inverted: bool, density: f64, feather: f64) -> Option<VectorMask> {
    Some(VectorMask { path, enabled: true, linked: true, inverted, density, feather })
}

fn tile(d: &Document, level: u32) -> Vec<u8> {
    d.display_tile(level, 0, 0).unwrap().unwrap_or_else(|| vec![0; TILE_BYTES_U8])
}

fn at(t: &[u8], x: usize, y: usize) -> [u8; 4] {
    let o = (y * TILE + x) * 4;
    t[o..o + 4].try_into().unwrap()
}

fn max_diff(a: &[u8], b: &[u8]) -> u8 {
    a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap()
}

#[test]
fn a_solid_shape_rect_equals_a_pixel_square_at_levels_0_and_1() {
    let mut a = doc(40, 40, true);
    shape_layer(&mut a, 1, rect(10.0, 10.0, 20.0, 20.0), Some([255, 0, 0]), None);
    let mut b = doc(40, 40, true);
    rect_layer(&mut b, 1, [10, 10, 20, 20], [255, 0, 0, 255]);
    for level in [0, 1] {
        assert_eq!(max_diff(&tile(&a, level), &tile(&b, level)), 0, "level {level}");
    }
    assert_eq!(at(&tile(&a, 0), 15, 15), [255, 0, 0, 255]);
    assert_eq!(at(&tile(&a, 0), 9, 15), [255, 255, 255, 255]);
}

#[test]
fn a_vector_mask_equals_a_raster_mask_of_the_same_coverage() {
    let path = rect(5.5, 4.25, 20.75, 17.0);
    let mut a = doc(40, 40, true);
    let l = rect_layer(&mut a, 1, [0, 0, 40, 40], [0, 0, 255, 255]);
    a.node_mut(l).unwrap().vector_mask = vmask(path.clone(), false, 1.0, 0.0);
    let mut b = doc(40, 40, true);
    let l = rect_layer(&mut b, 1, [0, 0, 40, 40], [0, 0, 255, 255]);
    b.add_mask(l, false).unwrap();
    b.set_mask_tile8(l, 0, 0, &geom::fill_mask(&path, 0, 0, TILE, TILE)).unwrap();
    assert_eq!(max_diff(&tile(&a, 0), &tile(&b, 0)), 0);
    assert_eq!(at(&tile(&a, 0), 4, 10), [255, 255, 255, 255]);
    assert_eq!(at(&tile(&a, 0), 10, 10), [0, 0, 255, 255]);
}

#[test]
fn vector_mask_density_inversion_and_disable() {
    let mut d = doc(40, 40, false);
    let l = rect_layer(&mut d, 1, [0, 0, 40, 40], [0, 0, 0, 255]);
    d.node_mut(l).unwrap().vector_mask = vmask(rect(10.0, 10.0, 20.0, 20.0), false, 0.5, 0.0);
    assert_eq!(at(&tile(&d, 0), 2, 2)[3], 128);
    assert_eq!(at(&tile(&d, 0), 15, 15)[3], 255);
    d.node_mut(l).unwrap().vector_mask = vmask(rect(10.0, 10.0, 20.0, 20.0), true, 1.0, 0.0);
    assert_eq!(at(&tile(&d, 0), 2, 2)[3], 255);
    assert_eq!(at(&tile(&d, 0), 15, 15)[3], 0);
    d.node_mut(l).unwrap().vector_mask.as_mut().unwrap().enabled = false;
    assert_eq!(at(&tile(&d, 0), 15, 15)[3], 255);
}

#[test]
fn vector_mask_feather_is_a_gaussian_before_density() {
    // Half plane x < 20, feather 6 (sigma 2): symmetric about the edge, density lifts the far side.
    let mut d = doc(40, 40, false);
    let l = rect_layer(&mut d, 1, [0, 0, 40, 40], [0, 0, 0, 255]);
    d.node_mut(l).unwrap().vector_mask = vmask(rect(-100.0, -100.0, 20.0, 140.0), false, 1.0, 6.0);
    let t = tile(&d, 0);
    let (a19, a20) = (at(&t, 19, 20)[3] as i32, at(&t, 20, 20)[3] as i32);
    assert!((a19 + a20 - 255).abs() <= 1, "{a19} + {a20}");
    let k = gaussian_kernel(6.0);
    assert_eq!(a19, (k[..=k.len() / 2].iter().sum::<f32>() * 255.0).round() as i32);
    assert_eq!(at(&t, 13, 20)[3], 255);
    assert_eq!(at(&t, 26, 20)[3], 0);
    d.node_mut(l).unwrap().vector_mask.as_mut().unwrap().density = 0.5;
    assert_eq!(at(&tile(&d, 0), 30, 20)[3], 128);
}

#[test]
fn an_artboard_clips_its_children_and_draws_its_background() {
    let mut d = doc(100, 60, false);
    let g = d.add_group("Artboard 1", 1).unwrap();
    let c = rect_layer(&mut d, 1, [40, 10, 60, 20], [255, 0, 0, 255]);
    d.move_node(c, g, 0).unwrap();
    d.node_mut(g).unwrap().artboard = Some(Artboard {
        rect: [0.0, 0.0, 50.0, 50.0],
        background: ArtboardBackground::White,
        preset_name: String::new(),
        guide_ids: vec![],
    });
    let t = tile(&d, 0);
    let row: Vec<u8> = (38..62).map(|x| at(&t, x, 15)[3]).collect();
    let red: Vec<usize> = (38..62).filter(|&x| at(&t, x, 15) == [255, 0, 0, 255]).collect();
    assert_eq!(red, (40..50).collect::<Vec<_>>(), "{row:?}");
    assert_eq!(at(&t, 30, 30), [255, 255, 255, 255]);
    assert_eq!(at(&t, 55, 15), [0, 0, 0, 0]);
    assert_eq!(at(&t, 20, 55), [0, 0, 0, 0]);
    // The stored child pixels stay.
    assert_eq!(tiles_bounds(d.node(c).unwrap().pixel_tiles().unwrap()), Some([40, 10, 20, 10]));
}

#[test]
fn an_outside_shape_stroke_equals_the_stroke_effect() {
    let mut a = doc(40, 40, false);
    shape_layer(&mut a, 1, rect(10.0, 10.0, 20.0, 20.0), Some([255, 0, 0]), Some(outside_stroke(3.0, Join::Round, vec![])));
    let mut b = doc(40, 40, false);
    let l = rect_layer(&mut b, 1, [10, 10, 20, 20], [255, 0, 0, 255]);
    let style = json!({
        "enabled": true, "scale": 1.0, "drop_shadows": [], "inner_shadows": [], "color_overlays": [],
        "gradient_overlays": [], "pattern_overlays": [], "outer_glow": null, "inner_glow": null,
        "bevel": null, "contour": null, "texture": null, "satin": null,
        "strokes": [{
            "present": true, "enabled": true, "size": 3.0, "position": "outside", "blend": "normal",
            "opacity": 1.0, "overprint": false, "fill": { "type": "solid", "color": [0, 0, 0] }
        }]
    });
    b.set_style(l, &style.to_string()).unwrap();
    // Edges match within 1/255. The round-join corners are exact area coverage here, where the
    // effect's distance ramp runs up to 45/255 lower (pixel (8, 7): 146, exact 147, vs 101).
    let (ta, tb) = (tile(&a, 0), tile(&b, 0));
    let corner = |v: usize| (7..10).contains(&v) || (20..23).contains(&v);
    for p in 0..40 * TILE {
        let (x, y) = (p % TILE, p / TILE);
        let d = max_diff(&ta[p * 4..p * 4 + 4], &tb[p * 4..p * 4 + 4]);
        let limit = if corner(x) && corner(y) { 48 } else { 1 };
        assert!(d <= limit, "({x}, {y}): {:?} vs {:?}", at(&ta, x, y), at(&tb, x, y));
    }
}

#[test]
fn an_all_zero_dash_strokes_solid() {
    let mut a = doc(40, 40, false);
    shape_layer(&mut a, 1, rect(10.0, 10.0, 20.0, 20.0), None, Some(outside_stroke(2.0, Join::Miter, vec![0.0, 0.0])));
    let mut b = doc(40, 40, false);
    shape_layer(&mut b, 1, rect(10.0, 10.0, 20.0, 20.0), None, Some(outside_stroke(2.0, Join::Miter, vec![])));
    assert_eq!(max_diff(&tile(&a, 0), &tile(&b, 0)), 0);
    assert_eq!(at(&tile(&a, 0), 9, 15), [0, 0, 0, 255]);
}

fn text_layer(d: &mut Document, transform: [f64; 6]) -> u32 {
    let l = rect_layer(d, 1, [10, 10, 20, 20], [0, 128, 0, 255]);
    let mut data: TextData = serde_json::from_value(text(json!({ "type": "point" }))).unwrap();
    data.transform = transform;
    let n = d.node_mut(l).unwrap();
    let Kind::Pixel(cache) = std::mem::replace(&mut n.kind, Kind::Group(vec![])) else { unreachable!() };
    n.kind = Kind::Text(Box::new(Text { data, cache: Some(cache) }));
    l
}

#[test]
fn a_text_cache_draws_like_pixels_and_a_singular_transform_draws_nothing() {
    let mut a = doc(40, 40, true);
    text_layer(&mut a, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]);
    let mut b = doc(40, 40, true);
    rect_layer(&mut b, 1, [10, 10, 20, 20], [0, 128, 0, 255]);
    for level in [0, 1] {
        assert_eq!(max_diff(&tile(&a, level), &tile(&b, level)), 0, "level {level}");
    }
    let mut s = doc(40, 40, true);
    text_layer(&mut s, [1.0, 2.0, 0.5, 1.0, 0.0, 0.0]);
    assert_eq!(at(&tile(&s, 0), 15, 15), [255, 255, 255, 255]);
}

#[test]
fn shape_and_vector_mask_programs_use_version_2_payload_kinds() {
    let mut d = doc(40, 40, true);
    let s = shape_layer(&mut d, 1, rect(10.0, 10.0, 20.0, 20.0), Some([255, 0, 0]), None);
    d.node_mut(s).unwrap().vector_mask = vmask(rect(12.0, 0.0, 40.0, 40.0), false, 1.0, 2.0);
    let p = Program::decode(&d.display_program(0, 0, 0, &[]).unwrap());
    let draw = p.steps.iter().find(|st| st.src != 0 && st.node == s).expect("the shape draw");
    assert!(draw.op == Op::Draw && draw.mask_kind == 2);
    assert!(matches!(p.payloads.iter().find(|(k, _)| *k == draw.src).unwrap().1.as_ref(), Pixels::U8(_)));
    assert!(matches!(p.payloads.iter().find(|(k, _)| *k == draw.mask).unwrap().1.as_ref(), Pixels::Mask8(_)));
    // Same pixels as the CPU tile.
    let run = quantize_premul(&Document::run_program(&p)).unwrap();
    assert_eq!(run, tile(&d, 0));
}

#[test]
fn a_large_feather_blurred_coarser_stays_within_2_of_the_exact_gaussian() {
    for feather in [40.0, 400.0] {
        let m = vmask(rect(64.5, 80.0, 192.0, 200.25), false, 0.75, feather).unwrap();
        let q = |v: Vec<f32>| v.into_iter().map(|v| (v * 255.0).round() as i32).collect::<Vec<_>>();
        let fast = q(super::feather_plane(&m, (256, 256), 0, 0, 0, 256, 256, super::FEATHER_MAX));
        let exact = q(super::feather_plane(&m, (256, 256), 0, 0, 0, 256, 256, f64::INFINITY));
        let d = fast.iter().zip(&exact).map(|(a, b)| (a - b).abs()).max().unwrap();
        assert!(d <= 2, "feather {feather}: max diff {d}");
    }
}

#[test]
fn a_feather_of_1000_renders_a_tile_quickly() {
    let mut d = doc(2048, 2048, true);
    d.node_mut(1).unwrap().vector_mask = vmask(rect(500.0, 500.0, 1500.0, 1500.0), false, 1.0, 1000.0);
    let t = std::time::Instant::now();
    d.display_tile(0, 3, 3).unwrap();
    let s = t.elapsed().as_secs_f64();
    let limit = if cfg!(debug_assertions) { 20.0 } else { 2.0 };
    assert!(s < limit, "{s} s");
}
