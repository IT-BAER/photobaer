//! Flood fill, selection modify, quick mask, fill_ex, stroke_selection, gradient, color range
//! and stroke engine tests. A child of the `doc` tests module.

use super::*;

// ---------- B3 E1: flood fill family (docs/M2.md magic wand, paint bucket) ----------

// 256x256 doc, background split red (x<4) / blue (x>=4) inside an 8x8 corner.
fn two_region_doc() -> Document {
    let mut d = doc_bg(0, 0, 255);
    d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.deselect().unwrap();
    d
}

#[test]
fn magic_wand_selects_the_contiguous_region_only() {
    let mut d = two_region_doc();
    d.select_rect(7.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap(); // a stray red pixel, not 4-connected
    d.deselect().unwrap();
    d.magic_wand(0, 0, 32, false, true, false, 1, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]));
}

#[test]
fn magic_wand_non_contiguous_reaches_a_disconnected_match() {
    let mut d = two_region_doc();
    d.select_rect(7.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.deselect().unwrap();
    d.magic_wand(0, 0, 32, false, false, false, 1, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 8, 8]), "the stray pixel widens the bounds");
}

#[test]
fn magic_wand_tolerance_edge_cases() {
    let mut d = two_region_doc();
    d.magic_wand(0, 0, 0, false, true, false, 1, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]), "exact match only");
    d.magic_wand(0, 0, 255, false, true, false, 1, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 256, 256]), "tolerance 255 reaches everything");
}

#[test]
fn magic_wand_works_on_a_16_bit_document() {
    let mut d = Document::new(8, 8, 16).unwrap();
    d.fill(1, Target::Pixels, 0, 0, 255, 255).unwrap();
    d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.deselect().unwrap();
    d.magic_wand(0, 0, 32, false, true, false, 1, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]));
}

#[test]
fn magic_wand_sample_all_floods_the_flattened_composite_not_the_active_layer() {
    let mut d = Document::new(8, 8, 8).unwrap();
    d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 0, 0, 255, 255).unwrap();
    d.select_rect(4.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 0, 255, 0, 255).unwrap();
    d.deselect().unwrap();
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 128).unwrap();

    d.magic_wand(0, 0, 0, false, true, false, top, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 8, 8]), "the active layer is uniform");

    d.magic_wand(0, 0, 0, false, true, true, top, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]), "the composite differs across the bg split");
}

#[test]
fn grow_is_contiguous_and_similar_is_not_on_a_three_region_fixture() {
    let mut d = Document::new(7, 1, 8).unwrap();
    let vals = [0u8, 40, 200, 200, 0, 200, 200];
    for (x, v) in vals.iter().enumerate() {
        d.select_rect(x as f64, 0.0, 1.0, 1.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, *v, 0, 0, 255).unwrap();
    }
    let sel_at = |d: &Document, x: usize| -> u8 { d.selection_tile(0, 0, 0).unwrap().map_or(0, |b| b[x]) };

    d.select_rect(0.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
    d.grow(40, false, 1).unwrap();
    assert_eq!(
        (0..7).map(|x| sel_at(&d, x) > 0).collect::<Vec<_>>(),
        vec![true, true, false, false, false, false, false],
        "grow is contiguous"
    );

    d.select_rect(0.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
    d.similar(40, false, 1).unwrap();
    assert_eq!(
        (0..7).map(|x| sel_at(&d, x) > 0).collect::<Vec<_>>(),
        vec![true, true, false, false, true, false, false],
        "similar reaches the disconnected match"
    );
}

#[test]
fn grow_and_similar_error_when_nothing_is_selected() {
    let mut d = doc_bg(1, 2, 3);
    assert_eq!(d.grow(10, false, 1).unwrap_err(), "nothing is selected");
    assert_eq!(d.similar(10, false, 1).unwrap_err(), "nothing is selected");
}

#[test]
fn bucket_normal_mode_blends_at_the_given_opacity() {
    let mut d = doc_bg(100, 150, 200);
    d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Blend(Blend::Normal), 0.5, 32, false, true, false).unwrap();
    near(at(&d, 0, 0), [178, 75, 100, 255]);
}

#[test]
fn bucket_behind_only_paints_transparent_pixels() {
    let mut d = Document::new(4, 4, 8).unwrap();
    d.bucket(1, Target::Pixels, 0, 0, [0, 255, 0, 255], PaintMode::Behind, 1.0, 0, false, false, false).unwrap();
    assert_eq!(at(&d, 0, 0), [0, 255, 0, 255]);
    d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Behind, 1.0, 255, false, false, false).unwrap();
    assert_eq!(at(&d, 0, 0), [0, 255, 0, 255], "opaque already, behind changes nothing");
}

#[test]
fn bucket_clear_mode_erases_towards_transparent() {
    let mut d = doc_bg(10, 20, 30);
    d.bucket(1, Target::Pixels, 0, 0, [0, 0, 0, 0], PaintMode::Clear, 0.5, 0, false, true, false).unwrap();
    assert_eq!(at(&d, 0, 0)[3], 128, "50% opacity clear halves alpha");
}

#[test]
fn bucket_respects_the_transparency_lock() {
    let mut d = doc_bg(10, 20, 30);
    set(&mut d, 1, r#"{"locks":{"transparency":true}}"#);
    d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Blend(Blend::Normal), 1.0, 32, false, true, false).unwrap();
    let px = at(&d, 0, 0);
    assert_eq!(px[3], 255, "alpha stays locked");
    assert_eq!(px[0], 255, "color still paints under the lock");
}

#[test]
fn bucket_errors_when_pixels_are_locked() {
    let mut d = doc_bg(10, 20, 30);
    set(&mut d, 1, r#"{"locks":{"pixels":true}}"#);
    assert_eq!(
        d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Blend(Blend::Normal), 1.0, 32, false, true, false)
            .unwrap_err(),
        "layer pixels are locked"
    );
}

#[test]
fn bucket_is_clipped_to_the_selection() {
    let mut d = doc_bg(10, 20, 30);
    d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
    d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Blend(Blend::Normal), 1.0, 32, false, true, false).unwrap();
    assert_eq!(at(&d, 0, 0)[0], 255, "painted inside the selection");
    assert_eq!(at(&d, 5, 0), [10, 20, 30, 255], "untouched outside the selection");
}

// ---------- B3 E2: Select > Modify ----------

#[test]
fn modify_selection_expand_contract_border_smooth() {
    let mut d = Document::new(256, 256, 8).unwrap();
    assert_eq!(d.modify_selection("expand", 2.0, true).unwrap_err(), "nothing is selected");

    d.select_rect(10.0, 10.0, 4.0, 4.0, Mode::New).unwrap();
    d.modify_selection("expand", 2.0, true).unwrap();
    assert_eq!(d.selection_bounds(), Some([8, 8, 8, 8]), "grew by 2px on every side");

    d.select_rect(10.0, 10.0, 4.0, 4.0, Mode::New).unwrap();
    d.modify_selection("contract", 1.0, true).unwrap();
    assert_eq!(d.selection_bounds(), Some([11, 11, 2, 2]), "shrank by 1px on every side");

    d.select_rect(10.0, 10.0, 20.0, 20.0, Mode::New).unwrap();
    d.modify_selection("border", 2.0, true).unwrap();
    assert_eq!(sel(&d, 19, 19), 0.0, "the far interior is untouched");
    assert!(sel(&d, 10, 19) > 0.0, "the band straddles the original edge");

    d.select_rect(10.0, 10.0, 4.0, 4.0, Mode::New).unwrap();
    d.modify_selection("smooth", 1.0, true).unwrap();
    assert_eq!(d.selection_bounds(), Some([10, 10, 4, 4]));

    assert_eq!(d.modify_selection("nonsense", 1.0, true).unwrap_err(), "unknown modify op nonsense");
}

// ---------- B3 E2: quick mask (Target::Selection) ----------

#[test]
fn quick_mask_fill_invert_clear_target_selection() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.fill(1, Target::Selection, 200, 0, 0, 0).unwrap();
    assert_eq!(sel(&d, 5, 5), 200.0 / 255.0);
    d.invert(1, Target::Selection).unwrap();
    assert!((sel(&d, 5, 5) - (1.0 - 200.0 / 255.0)).abs() < 1e-6);
    d.clear(1, Target::Selection).unwrap();
    assert_eq!(sel(&d, 5, 5), 0.0);
}

#[test]
fn quick_mask_round_trips_through_paint_coverage() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.select_rect(0.0, 0.0, 10.0, 8.0, Mode::New).unwrap();
    let tile = d.selection_tile(0, 0, 0).unwrap().unwrap();
    let coverage: Vec<f32> = tile.iter().map(|&v| v as f32 / 255.0).collect();
    let mut d2 = Document::new(256, 256, 8).unwrap();
    d2.paint_coverage(
        1,
        Target::Selection,
        0,
        0,
        256,
        256,
        &coverage,
        [255, 255, 255, 255],
        PaintMode::Blend(Blend::Normal),
        1.0,
    )
    .unwrap();
    assert_eq!(d2.selection_tile(0, 0, 0).unwrap().unwrap(), tile, "quick mask round trip reproduces the same bytes");
}

#[test]
fn quick_mask_bucket_paints_the_selection_channel() {
    let mut d = Document::new(4, 4, 8).unwrap();
    d.bucket(1, Target::Selection, 0, 0, [255, 255, 255, 255], PaintMode::Blend(Blend::Normal), 1.0, 0, false, true, false)
        .unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 4, 4]));
}

// ---------- B6 Part E: fill_ex ----------

#[test]
fn fill_ex_solid_no_selection_is_plain_source_over() {
    let mut d = doc_bg(10, 20, 30);
    d.fill_ex(1, Target::Pixels, &FillSource::Solid([200, 100, 50, 255]), PaintMode::Blend(Blend::Normal), 1.0, false)
        .unwrap();
    assert_eq!(at(&d, 5, 5), [200, 100, 50, 255]);
}

#[test]
fn fill_ex_soft_selection_weights_coverage_by_u_times_opacity() {
    let mut d = doc_bg(0, 0, 0);
    // A 50%-coverage selection tile via a half-alpha rect (fractional edge -> antialiased row),
    // simplified here to a hard rect covering the whole canvas so u = 1, and opacity carries
    // the weighting: p = srcA(1.0) * u(1.0) * opacity(0.4).
    d.select_rect(0.0, 0.0, 256.0, 256.0, Mode::New).unwrap();
    d.fill_ex(1, Target::Pixels, &FillSource::Solid([255, 255, 255, 255]), PaintMode::Blend(Blend::Normal), 0.4, false)
        .unwrap();
    near(at(&d, 5, 5), [102, 102, 102, 255]); // 0*0.6 + 255*0.4 = 102
}

#[test]
fn fill_ex_preserve_transparency_keeps_dest_alpha_and_skips_empty_pixels() {
    let mut d = Document::new(256, 256, 8).unwrap();
    // Half the tile opaque red, half transparent.
    d.set_tile_rgba8(1, 0, 0, &{
        let mut v = vec![0u8; TILE_BYTES_U8];
        for y in 0..TILE {
            for x in 0..TILE {
                let o = (y * TILE + x) * 4;
                if x < 128 {
                    v[o..o + 4].copy_from_slice(&[255, 0, 0, 255]);
                }
            }
        }
        v
    })
    .unwrap();
    d.fill_ex(1, Target::Pixels, &FillSource::Solid([0, 0, 255, 255]), PaintMode::Blend(Blend::Normal), 1.0, true).unwrap();
    assert_eq!(at(&d, 5, 5), [0, 0, 255, 255], "opaque pixel repaints, alpha unchanged");
    assert_eq!(at(&d, 200, 5), [0, 0, 0, 0], "transparent pixel stays empty under preserve transparency");
}

#[test]
fn fill_ex_layer_transparency_lock_ors_into_preserve() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.set_tile_rgba8(1, 0, 0, &opaque(255, 0, 0)).unwrap();
    set(&mut d, 1, r#"{"locks":{"transparency":true}}"#);
    d.fill_ex(1, Target::Pixels, &FillSource::Solid([0, 0, 255, 128]), PaintMode::Blend(Blend::Normal), 1.0, false)
        .unwrap();
    assert_eq!(at(&d, 5, 5)[3], 255, "the layer lock forces preserve transparency even though the param is false");
}

#[test]
fn fill_ex_blend_mode_multiply_darkens() {
    let mut d = doc_bg(200, 200, 200);
    d.fill_ex(1, Target::Pixels, &FillSource::Solid([100, 150, 250, 255]), PaintMode::Blend(Blend::Multiply), 1.0, false)
        .unwrap();
    // multiply(200/255, 100/255)*255 rounds to 78.
    near(at(&d, 5, 5), [78, 118, 196, 255]);
}

#[test]
fn fill_ex_pattern_source_uses_the_pattern_rgba_tiled_from_the_origin() {
    let mut d = doc_bg(0, 0, 0);
    // 2x2 colour checker, tiled from the document origin (0, 0).
    let data = [255, 0, 0, 0, 0, 255, 0, 0, 0, 0, 255, 0, 255, 255, 0, 0];
    let pattern = std::sync::Arc::new(Pattern::new(2, 2, &data, 4).unwrap());
    d.fill_ex(1, Target::Pixels, &FillSource::Pattern(pattern), PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    assert_eq!(at(&d, 0, 0), [255, 0, 0, 255]);
    assert_eq!(at(&d, 1, 0), [0, 255, 0, 255]);
    assert_eq!(at(&d, 0, 1), [0, 0, 255, 255]);
    assert_eq!(at(&d, 1, 1), [255, 255, 0, 255]);
    assert_eq!(at(&d, 2, 0), [255, 0, 0, 255], "tiles every 2px from the origin");
}

#[test]
fn fill_ex_history_source_reads_the_snapshot_pixels() {
    let mut ec = EngineCore::new(doc_bg(1, 2, 3));
    ec.doc.set_tile_rgba8(1, 0, 0, &opaque(9, 8, 7)).unwrap();
    let snap = ec.doc.clone();
    ec.snapshots.insert(0, snap);
    ec.doc.set_tile_rgba8(1, 0, 0, &opaque(50, 50, 50)).unwrap();
    ec.fill_ex(
        1,
        "pixels",
        r#"{"source":"history","snapshotId":0,"mode":"normal","opacity":1.0,"preserveTransparency":false}"#,
    )
    .unwrap();
    assert_eq!(at(&ec.doc, 5, 5), [9, 8, 7, 255]);
}

#[test]
fn fill_ex_history_missing_snapshot_errors_with_the_generic_message() {
    let mut ec = EngineCore::new(doc_bg(1, 2, 3));
    let err = ec
        .fill_ex(1, "pixels", r#"{"source":"history","mode":"normal","opacity":1.0,"preserveTransparency":false}"#)
        .unwrap_err();
    assert_eq!(err, "Fill needs a pixel layer.");
}

#[test]
fn fill_ex_mask_target_paints_the_masks_luminance_through_the_selection() {
    let mut d = doc_bg(0, 0, 0);
    d.add_mask(1, true).unwrap();
    d.select_rect(0.0, 0.0, 128.0, 256.0, Mode::New).unwrap();
    d.fill_ex(1, Target::Mask, &FillSource::Solid([0, 0, 0, 255]), PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    // Black over a white mask, full coverage inside the selection: mask goes to 0.
    assert_eq!(mask_at(&d, 1, 5, 5), 0);
    assert_eq!(mask_at(&d, 1, 200, 5), 255, "outside the selection the mask is untouched");
}

#[test]
fn fill_ex_selection_target_paints_the_quick_mask_with_no_outer_clip() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.select_rect(0.0, 0.0, 10.0, 10.0, Mode::New).unwrap(); // an existing selection must not clip this
    d.fill_ex(1, Target::Selection, &FillSource::Solid([200, 200, 200, 255]), PaintMode::Blend(Blend::Normal), 1.0, false)
        .unwrap();
    assert!((sel(&d, 5, 5) - 200.0 / 255.0).abs() < 1e-6);
    assert!((sel(&d, 200, 200) - 200.0 / 255.0).abs() < 1e-6, "the whole document is repainted, not just the old selection");
}

// ---------- B6 Part E: stroke_selection ----------

// The ring the spec formula predicts (B6 spec v1 Part E2), read straight off `Document`'s own
// private helpers so the golden checks the wiring, not a re-derivation of the EDT math (already
// covered by region.rs's own tests).
fn expected_ring(d: &Document, location: &str, w_px: f32) -> Vec<u8> {
    let s = d.selection_values();
    let (w, h) = (d.width, d.height);
    let sub = |a: &[f32], b: &[f32]| -> Vec<f32> { a.iter().zip(b).map(|(&x, &y)| (x - y).max(0.0)).collect() };
    let ring = match location {
        "outside" => {
            let e = region::expand_soft(&s, w, h, w_px, false);
            sub(&e, &s)
        }
        "center" => {
            let e = region::expand_soft(&s, w, h, (w_px / 2.0).ceil(), false);
            let c = region::contract_soft(&s, w, h, (w_px / 2.0).floor(), false);
            sub(&e, &c)
        }
        "inside" => {
            let c = region::contract_soft(&s, w, h, w_px, false);
            sub(&s, &c)
        }
        other => panic!("unknown location {other}"),
    };
    ring.iter().map(|&v| (v.clamp(0.0, 1.0) * 255.0).round() as u8).collect()
}

fn painted_alpha(d: &Document, w: usize, h: usize) -> Vec<u8> {
    let f = d.flatten_tile_rgba8(0, 0).unwrap();
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            out.push(f[(y * TILE + x) * 4 + 3]);
        }
    }
    out
}

#[test]
fn stroke_selection_ring_matches_the_region_formula_for_a_10x10_square() {
    for &w_px in &[1.0f32, 2.0, 3.0] {
        for location in ["inside", "center", "outside"] {
            let mut d = Document::new(40, 40, 8).unwrap();
            d.select_rect(15.0, 15.0, 10.0, 10.0, Mode::New).unwrap();
            let expected = expected_ring(&d, location, w_px);
            d.stroke_selection(1, w_px, [255, 255, 255, 255], location, PaintMode::Blend(Blend::Normal), 1.0, false)
                .unwrap();
            assert_eq!(painted_alpha(&d, 40, 40), expected, "location={location} w={w_px}");
        }
    }
}

#[test]
fn stroke_selection_center_at_width_one_equals_outside() {
    let mut inside_d = Document::new(40, 40, 8).unwrap();
    inside_d.select_rect(15.0, 15.0, 10.0, 10.0, Mode::New).unwrap();
    let mut outside_d = inside_d.clone();
    inside_d.stroke_selection(1, 1.0, [255, 255, 255, 255], "center", PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    outside_d.stroke_selection(1, 1.0, [255, 255, 255, 255], "outside", PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    assert_eq!(painted_alpha(&inside_d, 40, 40), painted_alpha(&outside_d, 40, 40));
}

#[test]
fn stroke_selection_no_inside_ring_along_a_canvas_touching_edge() {
    let mut d = Document::new(40, 40, 8).unwrap();
    d.select_rect(0.0, 15.0, 10.0, 10.0, Mode::New).unwrap(); // touches x = 0
    d.stroke_selection(1, 3.0, [255, 255, 255, 255], "inside", PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    // Rows away from the selection's own top/bottom edge (which do erode, corner effects
    // aside): the canvas-edge column itself gets no inside ring.
    for y in 19..21 {
        assert_eq!(at(&d, 0, y)[3], 0, "no inside ring at the canvas edge, y={y}");
    }
    assert!(at(&d, 9, 20)[3] > 0, "the ring still paints along the non-edge sides");
}

#[test]
fn stroke_selection_requires_a_selection() {
    let mut d = Document::new(40, 40, 8).unwrap();
    let err = d.stroke_selection(1, 3.0, [0, 0, 0, 255], "inside", PaintMode::Blend(Blend::Normal), 1.0, false).unwrap_err();
    assert_eq!(err, "Make a selection to stroke.");
}

#[test]
fn stroke_selection_empty_ring_errors() {
    let mut d = Document::new(40, 40, 8).unwrap();
    d.select_rect(0.0, 0.0, 40.0, 40.0, Mode::New).unwrap(); // full-canvas selection: outside expands into nothing new
    let err = d.stroke_selection(1, 3.0, [0, 0, 0, 255], "outside", PaintMode::Blend(Blend::Normal), 1.0, false).unwrap_err();
    assert_eq!(err, "Stroke produced no pixels.");
}

#[test]
fn stroke_selection_width_rounds_and_clamps_1_to_250() {
    let mut d = Document::new(40, 40, 8).unwrap();
    d.select_rect(15.0, 15.0, 10.0, 10.0, Mode::New).unwrap();
    let expected = expected_ring(&d, "outside", 1.0);
    d.stroke_selection(1, 0.4, [255, 255, 255, 255], "outside", PaintMode::Blend(Blend::Normal), 1.0, false).unwrap();
    assert_eq!(painted_alpha(&d, 40, 40), expected, "0.4 rounds and clamps up to 1");
}

// ---------- B6 Part E: gradient ----------

fn bw_stops() -> Vec<gradient::ColorStop> {
    vec![
        gradient::ColorStop { position: 0.0, rgb: [0.0; 3], midpoint: 0.5 },
        gradient::ColorStop { position: 1.0, rgb: [1.0; 3], midpoint: 0.5 },
    ]
}

fn painted_rgba(d: &Document, w: usize, h: usize) -> Vec<[u8; 4]> {
    let f = d.flatten_tile_rgba8(0, 0).unwrap();
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h {
        for x in 0..w {
            let o = (y * TILE + x) * 4;
            out.push([f[o], f[o + 1], f[o + 2], f[o + 3]]);
        }
    }
    out
}

// The style-t/LUT math the gradient formula predicts (B6 spec v1 Part E3), read straight off
// gradient.rs's own public functions so the golden checks the wiring, not a re-derivation of
// the math (already covered by gradient.rs's own tests).
#[allow(clippy::too_many_arguments)]
fn expected_gradient(
    style: gradient::Style,
    method: gradient::Method,
    color_stops: &[gradient::ColorStop],
    opacity_stops: &[gradient::OpacityStop],
    start: (f64, f64),
    end: (f64, f64),
    reverse: bool,
    dither: bool,
    transparency: bool,
    w: i32,
    h: i32,
) -> Vec<[u8; 4]> {
    let mut cs = gradient::normalize_color_stops(color_stops.to_vec());
    let mut os = gradient::normalize_opacity_stops(opacity_stops.to_vec());
    if reverse {
        cs = gradient::reverse_color_stops(&cs);
        os = gradient::reverse_opacity_stops(&os);
    }
    let lut = gradient::build_lut(&cs, &os, method);
    let (dx, dy) = (end.0 - start.0, end.1 - start.1);
    let l2 = dx * dx + dy * dy;
    let mut out = Vec::with_capacity((w * h) as usize);
    for gy in 0..h {
        for gx in 0..w {
            let (px, py) = (gx as f64 + 0.5 - start.0, gy as f64 + 0.5 - start.1);
            let t = gradient::style_t(style, px, py, dx, dy, l2);
            let [mut r, mut g, mut b, mut a] = gradient::lut_lookup(&lut, t);
            if dither {
                let d = gradient::dither_delta(gx, gy);
                r = (r + d).clamp(0.0, 1.0);
                g = (g + d).clamp(0.0, 1.0);
                b = (b + d).clamp(0.0, 1.0);
            }
            if !transparency {
                a = 1.0;
            }
            // Source-over onto a fully transparent backdrop: when the composited alpha ends
            // up at 0, `paint_pixel` discards the colour too (there is nothing to show it).
            if a <= 0.0 {
                r = 0.0;
                g = 0.0;
                b = 0.0;
            }
            out.push([
                (r * 255.0).round() as u8,
                (g * 255.0).round() as u8,
                (b * 255.0).round() as u8,
                (a * 255.0).round() as u8,
            ]);
        }
    }
    out
}

#[test]
fn gradient_five_styles_classic_on_an_8x8() {
    for style_name in ["linear", "radial", "angle", "reflected", "diamond"] {
        let mut d = Document::new(8, 8, 8).unwrap();
        let style = gradient::Style::parse(style_name).unwrap();
        let expected =
            expected_gradient(style, gradient::Method::Classic, &bw_stops(), &[], (0.5, 0.5), (7.5, 7.5), false, false, true, 8, 8);
        d.gradient(
            1,
            Target::Pixels,
            bw_stops(),
            vec![],
            gradient::Method::Classic,
            style,
            (0.5, 0.5),
            (7.5, 7.5),
            false,
            false,
            true,
            1.0,
        )
        .unwrap();
        assert_eq!(painted_rgba(&d, 8, 8), expected, "style={style_name}");
    }
}

#[test]
fn gradient_three_methods_on_a_black_to_white_linear_row() {
    for method_name in ["classic", "linear", "perceptual"] {
        let mut d = Document::new(8, 1, 8).unwrap();
        let method = gradient::Method::parse(method_name).unwrap();
        let expected =
            expected_gradient(gradient::Style::Linear, method, &bw_stops(), &[], (0.5, 0.0), (7.5, 0.0), false, false, true, 8, 1);
        d.gradient(
            1,
            Target::Pixels,
            bw_stops(),
            vec![],
            method,
            gradient::Style::Linear,
            (0.5, 0.0),
            (7.5, 0.0),
            false,
            false,
            true,
            1.0,
        )
        .unwrap();
        assert_eq!(painted_rgba(&d, 8, 1), expected, "method={method_name}");
    }
}

#[test]
fn gradient_midpoint_0_25_moves_the_50pct_point() {
    let mut stops = bw_stops();
    stops[0].midpoint = 0.25;
    let mut d = Document::new(8, 1, 8).unwrap();
    let expected =
        expected_gradient(gradient::Style::Linear, gradient::Method::Classic, &stops, &[], (0.5, 0.0), (7.5, 0.0), false, false, true, 8, 1);
    d.gradient(
        1,
        Target::Pixels,
        stops,
        vec![],
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.5, 0.0),
        (7.5, 0.0),
        false,
        false,
        true,
        1.0,
    )
    .unwrap();
    assert_eq!(painted_rgba(&d, 8, 1), expected);
}

#[test]
fn gradient_reverse_flips_the_ramp() {
    let mut d = Document::new(8, 1, 8).unwrap();
    let expected =
        expected_gradient(gradient::Style::Linear, gradient::Method::Classic, &bw_stops(), &[], (0.5, 0.0), (7.5, 0.0), true, false, true, 8, 1);
    d.gradient(
        1,
        Target::Pixels,
        bw_stops(),
        vec![],
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.5, 0.0),
        (7.5, 0.0),
        true,
        false,
        true,
        1.0,
    )
    .unwrap();
    let got = painted_rgba(&d, 8, 1);
    assert_eq!(got, expected);
    assert_eq!(got[0], [255, 255, 255, 255], "reversed: white first");
    assert_eq!(got[7], [0, 0, 0, 255], "reversed: black last");
}

#[test]
fn gradient_dither_on_vs_off_exact_bytes() {
    for dither in [false, true] {
        let mut d = Document::new(8, 8, 8).unwrap();
        let expected = expected_gradient(
            gradient::Style::Linear,
            gradient::Method::Classic,
            &bw_stops(),
            &[],
            (0.5, 0.0),
            (7.5, 0.0),
            false,
            dither,
            true,
            8,
            8,
        );
        d.gradient(
            1,
            Target::Pixels,
            bw_stops(),
            vec![],
            gradient::Method::Classic,
            gradient::Style::Linear,
            (0.5, 0.0),
            (7.5, 0.0),
            false,
            dither,
            true,
            1.0,
        )
        .unwrap();
        assert_eq!(painted_rgba(&d, 8, 8), expected, "dither={dither}");
    }
    let mut off = Document::new(8, 8, 8).unwrap();
    off.gradient(
        1,
        Target::Pixels,
        bw_stops(),
        vec![],
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.5, 0.0),
        (7.5, 0.0),
        false,
        false,
        true,
        1.0,
    )
    .unwrap();
    let mut on = Document::new(8, 8, 8).unwrap();
    on.gradient(
        1,
        Target::Pixels,
        bw_stops(),
        vec![],
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.5, 0.0),
        (7.5, 0.0),
        false,
        true,
        true,
        1.0,
    )
    .unwrap();
    assert_ne!(painted_rgba(&off, 8, 8), painted_rgba(&on, 8, 8), "dither changes at least one byte");
}

#[test]
fn gradient_transparency_off_forces_alpha_1() {
    let stops = vec![
        gradient::ColorStop { position: 0.0, rgb: [1.0, 0.0, 0.0], midpoint: 0.5 },
        gradient::ColorStop { position: 1.0, rgb: [0.0, 0.0, 1.0], midpoint: 0.5 },
    ];
    let ops = vec![
        gradient::OpacityStop { position: 0.0, opacity: 0.0, midpoint: 0.5 },
        gradient::OpacityStop { position: 1.0, opacity: 1.0, midpoint: 0.5 },
    ];
    let mut d = Document::new(8, 1, 8).unwrap();
    d.gradient(
        1,
        Target::Pixels,
        stops,
        ops,
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.5, 0.0),
        (7.5, 0.0),
        false,
        false,
        false,
        1.0,
    )
    .unwrap();
    let got = painted_rgba(&d, 8, 1);
    assert!(got.iter().all(|p| p[3] == 255), "transparency:false forces every sampled alpha to 1 before compositing");
}

#[test]
fn gradient_opacity_stops_scale_the_painted_alpha() {
    let stops =
        vec![gradient::ColorStop { position: 0.0, rgb: [1.0, 0.0, 0.0], midpoint: 0.5 }, gradient::ColorStop {
            position: 1.0,
            rgb: [1.0, 0.0, 0.0],
            midpoint: 0.5,
        }];
    let ops = vec![
        gradient::OpacityStop { position: 0.0, opacity: 0.0, midpoint: 0.5 },
        gradient::OpacityStop { position: 1.0, opacity: 1.0, midpoint: 0.5 },
    ];
    let mut d = Document::new(8, 1, 8).unwrap();
    let expected = expected_gradient(
        gradient::Style::Linear,
        gradient::Method::Classic,
        &stops,
        &ops,
        (0.5, 0.0),
        (7.5, 0.0),
        false,
        false,
        true,
        8,
        1,
    );
    d.gradient(
        1,
        Target::Pixels,
        stops,
        ops,
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.5, 0.0),
        (7.5, 0.0),
        false,
        false,
        true,
        1.0,
    )
    .unwrap();
    let got = painted_rgba(&d, 8, 1);
    assert_eq!(got, expected);
    assert_eq!(got[0][3], 0, "opacity stop 0 at position 0");
    assert_eq!(got[7][3], 255, "opacity stop 1 at position 1");
}

#[test]
fn gradient_without_a_selection_fills_the_whole_canvas() {
    let mut d = Document::new(20, 20, 8).unwrap();
    // Paint only a 4x4 opaque block: the layer's tight bounds.
    d.set_tile_rgba8(1, 0, 0, &{
        let mut v = vec![0u8; TILE_BYTES_U8];
        for y in 2..6 {
            for x in 2..6 {
                let o = (y * TILE + x) * 4;
                v[o..o + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
        v
    })
    .unwrap();
    d.gradient(
        1,
        Target::Pixels,
        bw_stops(),
        vec![],
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.0, 0.0),
        (20.0, 0.0),
        false,
        false,
        true,
        1.0,
    )
    .unwrap();
    assert_eq!(at(&d, 10, 10)[3], 255, "outside the painted block the gradient fills the transparent pixel");
    assert_eq!(at(&d, 19, 19)[3], 255, "the gradient reaches the canvas corner");
    assert_ne!(at(&d, 3, 3), [0, 0, 0, 255], "the gradient repainted the block");
}

#[test]
fn gradient_layer_transparency_lock_keeps_dest_alpha_and_skips_empty_pixels() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.set_tile_rgba8(1, 0, 0, &{
        let mut v = vec![0u8; TILE_BYTES_U8];
        for y in 0..TILE {
            for x in 0..TILE {
                let o = (y * TILE + x) * 4;
                if x < 128 {
                    v[o..o + 4].copy_from_slice(&[255, 0, 0, 255]);
                }
            }
        }
        v
    })
    .unwrap();
    set(&mut d, 1, r#"{"locks":{"transparency":true}}"#);
    let stops = vec![
        gradient::ColorStop { position: 0.0, rgb: [0.0, 0.0, 1.0], midpoint: 0.5 },
        gradient::ColorStop { position: 1.0, rgb: [0.0, 0.0, 1.0], midpoint: 0.5 },
    ];
    d.gradient(
        1,
        Target::Pixels,
        stops,
        vec![],
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.0, 0.0),
        (256.0, 0.0),
        false,
        false,
        true,
        1.0,
    )
    .unwrap();
    assert_eq!(at(&d, 5, 5)[3], 255, "opaque pixel keeps its alpha under the layer's transparency lock");
    assert_eq!(at(&d, 200, 5), [0, 0, 0, 0], "transparent pixel stays empty under the layer's transparency lock");
}

#[test]
fn gradient_mask_target_paints_the_masks_luminance() {
    let mut d = Document::new(8, 1, 8).unwrap();
    d.add_mask(1, true).unwrap();
    d.gradient(
        1,
        Target::Mask,
        bw_stops(),
        vec![],
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.5, 0.0),
        (7.5, 0.0),
        false,
        false,
        true,
        1.0,
    )
    .unwrap();
    assert_eq!(mask_at(&d, 1, 0, 0), 0, "black end of the ramp painted into the mask");
    assert_eq!(mask_at(&d, 1, 7, 0), 255, "white end of the ramp painted into the mask");
}

#[test]
fn gradient_selection_target_paints_the_quick_mask() {
    let mut d = Document::new(8, 1, 8).unwrap();
    d.gradient(
        1,
        Target::Selection,
        bw_stops(),
        vec![],
        gradient::Method::Classic,
        gradient::Style::Linear,
        (0.5, 0.0),
        (7.5, 0.0),
        false,
        false,
        true,
        1.0,
    )
    .unwrap();
    assert!((sel(&d, 0, 0) - 0.0).abs() < 1e-6);
    assert!((sel(&d, 7, 0) - 1.0).abs() < 1e-6);
}

#[test]
fn engine_gradient_parses_camelcase_json_params_and_paints() {
    let mut ec = EngineCore::new(Document::new(8, 1, 8).unwrap());
    ec.gradient(
        1,
        "pixels",
        r#"{"stops":[{"position":0.0,"rgb":[0,0,0]},{"position":1.0,"rgb":[255,255,255]}],
                "opacityStops":[],"method":"classic","style":"linear",
                "start":{"x":0.5,"y":0.0},"end":{"x":7.5,"y":0.0},
                "reverse":false,"dither":false,"transparency":true,"opacity":1.0}"#,
    )
    .unwrap();
    assert_eq!(at(&ec.doc, 0, 0), [0, 0, 0, 255]);
    assert_eq!(at(&ec.doc, 7, 0), [255, 255, 255, 255]);
}

// ---------- B3 E2: color range ----------

#[test]
fn color_range_selects_the_sampled_region_and_preview_leaves_the_selection_alone() {
    let d = two_region_doc(); // left half red, right half blue
    assert_eq!(
        d.color_range_preview(0, false, 1, "bogus preset", &[], 0, 0, &[], false, false).unwrap_err(),
        "unknown color range preset bogus preset"
    );
    let preview = d.color_range_preview(0, false, 1, "sampled", &[[255, 0, 0]], 50, 0, &[], false, false).unwrap();
    assert!(!d.has_selection(), "the preview does not touch the selection");
    assert_eq!(preview[0], 255, "the red half previews fully covered");
    assert_eq!(preview[preview.len() - 1], 0, "the blue half previews uncovered");

    let mut d = d;
    d.color_range(false, 1, "sampled", &[[255, 0, 0]], 50, 0, &[], false, false, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]), "the sampled preset selects the red half");
}

// Left half red, right half blue.
fn split_doc() -> Document {
    let mut d = Document::new(8, 8, 8).unwrap();
    d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 230, 60, 40, 255).unwrap();
    d.select_rect(4.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 30, 40, 210, 255).unwrap();
    d.deselect().unwrap();
    d
}

#[test]
fn quick_select_takes_the_stroked_side_and_subtract_gives_it_back() {
    let mut d = split_doc();
    d.quick_select(&[1.5, 2.5, 1.5, 5.5], 1.0, false, 1, Mode::New, false).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]), "the stroked side only");

    d.select_all().unwrap();
    d.quick_select(&[1.5, 2.5, 1.5, 5.5], 1.0, false, 1, Mode::Subtract, false).unwrap();
    assert_eq!(d.selection_bounds(), Some([4, 0, 4, 8]), "subtract leaves the other side");

    assert!(d.quick_select(&[1.0], 1.0, false, 1, Mode::New, false).is_err());
    assert!(d.quick_select(&[f64::NAN, 1.0], 1.0, false, 1, Mode::New, false).is_err());
    assert!(d.quick_select(&[], 1.0, false, 1, Mode::New, false).is_err());
}

#[test]
fn quick_select_auto_enhance_feathers_the_border() {
    let mut d = split_doc();
    d.quick_select(&[1.5, 2.5, 1.5, 5.5], 1.0, false, 1, Mode::New, true).unwrap();
    let tile = d.selection_tile(0, 0, 0).unwrap().expect("a selection tile");
    assert!(tile[4 * 256 + 1] > 230, "the stroked side stays selected");
    let soft = (0..8).any(|x| { let v = tile[4 * 256 + x]; v > 0 && v < 255 });
    assert!(soft, "auto enhance leaves partial coverage at the border");
}

#[test]
fn magnetic_handles_live_from_begin_to_end() {
    let mut d = Document::new(40, 40, 8).unwrap();
    d.fill(1, Target::Pixels, 20, 20, 20, 255).unwrap();
    d.select_rect(10.0, 10.0, 20.0, 20.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 240, 240, 240, 255).unwrap();
    d.deselect().unwrap();
    let mut e = EngineCore::new(d);

    assert!(e.magnetic_path(0, 10, 25, 25, 10, 12, 0).is_err(), "no handle yet");
    let h = e.magnetic_begin(false, 1).unwrap();
    let path = e.magnetic_path(h, 10, 25, 25, 10, 12, 0).unwrap();
    assert_eq!(path.len() % 2, 0);
    assert_eq!(&path[..2], &[10, 25]);
    assert_eq!(&path[path.len() - 2..], &[25, 10]);
    // Every point sits on the bright square's boundary ring, within a pixel.
    for p in path.chunks_exact(2) {
        let (x, y) = (p[0], p[1]);
        let on_ring = (9..=30).contains(&x)
            && (9..=30).contains(&y)
            && (x <= 10 || x >= 29 || y <= 10 || y >= 29);
        assert!(on_ring, "({x}, {y}) left the edge");
    }
    assert_eq!(livewire::suggest_anchor(&[(0, 0), (10, 0), (20, 0)], 91), Some(1));

    e.magnetic_end(h).unwrap();
    assert!(e.magnetic_end(h).is_err(), "the handle is freed once");
    assert!(e.magnetic_path(h, 10, 25, 25, 10, 12, 0).is_err());
}

// ---------- B4 stroke engine (M2.md section 4) ----------

// Full-coverage aliased brush params, so goldens read the exact paint value; `extra` is a
// JSON fragment (`,"flow":0.5`) whose fields win over the defaults.
fn hard(extra: &str) -> String {
    let mut base: Value =
        serde_json::from_str(r#"{"rgba":[0,0,0,255],"mode":"normal","size":10,"aliased":true}"#).unwrap();
    let over: Value = serde_json::from_str(&format!(r#"{{"_":0{extra}}}"#)).unwrap();
    for (k, v) in over.as_object().unwrap() {
        if k != "_" {
            base[k] = v.clone();
        }
    }
    base.to_string()
}

fn core_bg(r: u8, g: u8, b: u8) -> EngineCore {
    EngineCore::new(doc_bg(r, g, b))
}

fn stroke(e: &mut EngineCore, params: &str, samples: &[f64]) -> Vec<i32> {
    e.stroke_begin(1, "pixels", params).unwrap();
    let rect = e.stroke_to(samples).unwrap();
    e.stroke_end().unwrap();
    rect
}

#[test]
fn stroke_paints_a_hard_dab() {
    let mut e = core_bg(255, 255, 255);
    stroke(&mut e, &hard(r#","size":5"#), &[10.5, 10.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 10), [0, 0, 0, 255]);
    assert_eq!(at(&e.doc, 12, 10), [0, 0, 0, 255], "2 px out is inside a size 5 tip");
    assert_eq!(at(&e.doc, 13, 10), [255, 255, 255, 255], "3 px out is past the tip");
}

#[test]
fn stroke_opacity_caps_however_often_it_overlaps() {
    let mut e = core_bg(255, 255, 255);
    let mut samples = Vec::new();
    for _ in 0..20 {
        samples.extend_from_slice(&[10.5, 10.5, 1.0]);
    }
    stroke(&mut e, &hard(r#","opacity":0.5,"airbrush":true"#), &samples);
    assert_eq!(at(&e.doc, 10, 10), [128, 128, 128, 255], "20 dabs stay at the 50 % opacity");
}

#[test]
fn stroke_flow_builds_up_per_dab() {
    let mut e = core_bg(255, 255, 255);
    // Two dabs on the same spot at flow 50 %: 0.5 then 0.75 of the full opacity.
    stroke(&mut e, &hard(r#","flow":0.5,"airbrush":true"#), &[10.5, 10.5, 1.0, 10.5, 10.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 10), [64, 64, 64, 255]);
}

#[test]
fn stroke_multiply_sees_the_pre_stroke_backdrop() {
    let mut e = core_bg(128, 128, 128);
    stroke(&mut e, &hard(r#","rgba":[128,128,128,255],"mode":"multiply","airbrush":true"#), &[10.5, 10.5, 1.0, 10.5, 10.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 10), [64, 64, 64, 255], "the second dab must not multiply twice");
}

#[test]
fn stroke_is_clipped_by_the_selection() {
    let mut e = core_bg(255, 255, 255);
    e.doc.select_shape(&Rect::new(0.0, 0.0, 10.0, 10.0), Mode::New).unwrap();
    stroke(&mut e, &hard(""), &[5.5, 5.5, 1.0, 30.5, 5.5, 1.0]);
    assert_eq!(at(&e.doc, 5, 5), [0, 0, 0, 255]);
    assert_eq!(at(&e.doc, 20, 5), [255, 255, 255, 255], "outside the selection stays clean");
}

#[test]
fn stroke_honors_the_transparency_lock() {
    let mut e = EngineCore::new(Document::new(256, 256, 8).unwrap());
    e.doc.fill(1, Target::Pixels, 255, 0, 0, 128).unwrap();
    set(&mut e.doc, 1, r#"{"locks":{"transparency":true}}"#);
    stroke(&mut e, &hard(""), &[10.5, 10.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 10), [0, 0, 0, 128], "alpha is kept, color is painted");
}

#[test]
fn stroke_begin_errors_on_the_pixel_lock() {
    let mut e = core_bg(255, 255, 255);
    set(&mut e.doc, 1, r#"{"locks":{"pixels":true}}"#);
    let err = e.stroke_begin(1, "pixels", &hard("")).unwrap_err();
    assert!(err.contains("locked"), "{err}");
    assert!(e.stroke_to(&[0.0, 0.0, 1.0]).is_err(), "no stroke was opened");
}

#[test]
fn stroke_clear_erases() {
    let mut e = core_bg(255, 255, 255);
    stroke(&mut e, &hard(r#","mode":"clear""#), &[10.5, 10.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 10), [0, 0, 0, 0]);
    assert_eq!(at(&e.doc, 30, 10), [255, 255, 255, 255]);
}

#[test]
fn stroke_erase_to_history_restores_the_snapshot() {
    let mut e = core_bg(255, 255, 255);
    let snap = e.snapshot();
    e.doc.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
    let p = hard(&format!(r#","eraseToHistory":{snap}"#));
    stroke(&mut e, &p, &[10.5, 10.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 10), [255, 255, 255, 255], "full coverage restores exactly");
    assert_eq!(at(&e.doc, 30, 10), [255, 0, 0, 255]);
    let other = e.doc.add_layer("other", 1).unwrap();
    let err = e.stroke_begin(other, "pixels", &p).unwrap_err();
    assert!(err.contains("snapshot"), "{err}");
}

#[test]
fn aliased_stroke_keeps_alpha_binary() {
    let mut e = EngineCore::new(Document::new(256, 256, 8).unwrap());
    stroke(&mut e, &hard(r#","size":9"#), &[20.5, 20.5, 1.0, 40.5, 30.5, 1.0]);
    let f = e.doc.flatten_tile_rgba8(0, 0).unwrap();
    assert!(f.chunks_exact(4).any(|p| p[3] == 255), "the pencil painted");
    assert!(f.chunks_exact(4).all(|p| p[3] == 0 || p[3] == 255), "no soft edge");
}

#[test]
fn stroke_on_a_16_bit_document() {
    let mut e = EngineCore::new(Document::new(256, 256, 16).unwrap());
    e.doc.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    stroke(&mut e, &hard(r#","opacity":0.5"#), &[10.5, 10.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 10), [128, 128, 128, 255]);
}

#[test]
fn stroke_only_rewrites_tiles_under_the_dabs() {
    let mut e = EngineCore::new(Document::new(512, 512, 8).unwrap());
    e.doc.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    let ids = |e: &EngineCore| {
        let list = manifest_value(&e.doc)["layers"][0]["tiles"].clone();
        (tile_id(&list, 0, 0), tile_id(&list, 1, 1))
    };
    let (a0, b0) = ids(&e);
    stroke(&mut e, &hard(""), &[10.5, 10.5, 1.0]);
    let (a1, b1) = ids(&e);
    assert_ne!(a1, a0, "the painted tile is new");
    assert_eq!(b1, b0, "an untouched tile keeps its id");
}

#[test]
fn stroke_cancel_restores_the_original_tiles() {
    let mut e = core_bg(255, 255, 255);
    let id0 = tile_id(&manifest_value(&e.doc)["layers"][0]["tiles"], 0, 0);
    e.stroke_begin(1, "pixels", &hard("")).unwrap();
    e.stroke_to(&[10.5, 10.5, 1.0, 60.5, 60.5, 1.0]).unwrap();
    assert_eq!(at(&e.doc, 10, 10), [0, 0, 0, 255]);
    e.stroke_cancel().unwrap();
    assert_eq!(at(&e.doc, 10, 10), [255, 255, 255, 255]);
    assert_eq!(tile_id(&manifest_value(&e.doc)["layers"][0]["tiles"], 0, 0), id0, "the same tile id is back");
    assert!(e.stroke_cancel().is_err(), "the stroke is closed");
}

#[test]
fn stroke_into_the_quick_mask_target() {
    let mut e = core_bg(255, 255, 255);
    e.stroke_begin(1, "selection", &hard(r#","rgba":[255,255,255,255],"size":20"#)).unwrap();
    e.stroke_to(&[10.5, 10.5, 1.0]).unwrap();
    e.stroke_end().unwrap();
    let sel = e.doc.selection.as_ref().expect("the stroke created a selection");
    assert_eq!(e.doc.sel_at(sel, 10, 10), 1.0);
    assert_eq!(e.doc.sel_at(sel, 40, 10), 0.0);
    assert_eq!(at(&e.doc, 10, 10), [255, 255, 255, 255], "the layer is untouched");
}

#[test]
fn stroke_cancel_drops_a_quick_mask_selection_it_created() {
    let mut e = core_bg(255, 255, 255);
    e.stroke_begin(1, "selection", &hard("")).unwrap();
    e.stroke_to(&[10.5, 10.5, 1.0]).unwrap();
    e.stroke_cancel().unwrap();
    assert!(!e.doc.has_selection(), "there was no selection before the stroke");
}

#[test]
fn stroke_to_returns_the_dirty_rect_and_nothing_when_idle() {
    let mut e = core_bg(255, 255, 255);
    e.stroke_begin(1, "pixels", &hard(r#","size":10"#)).unwrap();
    let r = e.stroke_to(&[100.5, 100.5, 1.0]).unwrap();
    assert_eq!(r.len(), 4);
    assert!(r[0] <= 95 && r[1] <= 95 && r[0] + r[2] >= 106 && r[1] + r[3] >= 106, "{r:?}");
    assert!(e.stroke_to(&[100.5, 100.5, 1.0]).unwrap().is_empty(), "a still pointer paints nothing");
    assert!(e.stroke_begin(1, "pixels", &hard("")).is_err(), "only one stroke at a time");
    e.stroke_end().unwrap();
    assert!(e.stroke_end().is_err());
}

#[test]
fn stroke_rejects_bad_params() {
    let mut e = core_bg(255, 255, 255);
    assert!(e.stroke_begin(1, "pixels", r#"{"rgba":[0,0,0,255],"mode":"normal","size":10,"wet":true}"#).is_err());
    assert!(e.stroke_begin(1, "pixels", r#"{"rgba":[0,0,0,255],"mode":"nope","size":10}"#).is_err());
    assert!(e.stroke_begin(1, "pixels", r#"{"rgba":[0,0,0,255],"mode":"normal","size":0}"#).is_err());
    assert!(e.stroke_begin(1, "mask", &hard("")).is_err());
    e.stroke_begin(1, "pixels", &hard("")).unwrap();
    assert!(e.stroke_to(&[1.0, 2.0]).is_err(), "samples are x, y, pressure triples");
    assert!(e.stroke_to(&[1.0, f64::NAN, 1.0]).is_err());
}

#[test]
fn pressure_scales_size_and_opacity() {
    let mut e = core_bg(255, 255, 255);
    stroke(&mut e, &hard(r#","size":20,"pressureSize":true,"pressureOpacity":true"#), &[30.5, 30.5, 0.5]);
    assert_eq!(at(&e.doc, 30, 30), [128, 128, 128, 255], "half pressure, half opacity");
    assert_eq!(at(&e.doc, 34, 30), [128, 128, 128, 255], "radius 5 at half size");
    assert_eq!(at(&e.doc, 36, 30), [255, 255, 255, 255]);
}

// ---------- B5 Part E1 (dynamics, scattering, color, pose, sampled tips, preview) ----------

#[test]
fn all_dynamics_off_matches_the_bare_default_params() {
    let explicit_off = hard(
        r#","shapeDyn":{"enabled":false},"scatter":{"enabled":false},"transfer":{"enabled":false},"color":{"enabled":false},"pose":{"enabled":false},"noise":0,"wetEdges":false,"texture":{"enabled":false},"dualBrush":{"enabled":false}"#,
    );
    let bare = hard("");
    let samples = [10.5, 10.5, 1.0, 20.5, 15.5, 0.6, 15.5, 25.5, 0.9];
    let mut e1 = core_bg(255, 255, 255);
    stroke(&mut e1, &explicit_off, &samples);
    let mut e2 = core_bg(255, 255, 255);
    stroke(&mut e2, &bare, &samples);
    assert_eq!(e1.doc.flatten_tile_rgba8(0, 0).unwrap(), e2.doc.flatten_tile_rgba8(0, 0).unwrap());
}

#[test]
fn same_seed_paints_identically_different_seed_differs() {
    let with_seed = |seed: u32| {
        hard(&format!(
            r#","seed":{seed},"shapeDyn":{{"enabled":true,"size":{{"jitter":1,"minimum":0}},"angleJitter":0.5}}"#
        ))
    };
    let samples = [10.5, 10.5, 1.0, 20.5, 12.5, 0.8, 15.5, 22.5, 0.6];
    let mut a = core_bg(255, 255, 255);
    stroke(&mut a, &with_seed(5), &samples);
    let mut b = core_bg(255, 255, 255);
    stroke(&mut b, &with_seed(5), &samples);
    assert_eq!(a.doc.flatten_tile_rgba8(0, 0).unwrap(), b.doc.flatten_tile_rgba8(0, 0).unwrap(), "same seed paints identically");
    let mut c = core_bg(255, 255, 255);
    stroke(&mut c, &with_seed(6), &samples);
    assert_ne!(a.doc.flatten_tile_rgba8(0, 0).unwrap(), c.doc.flatten_tile_rgba8(0, 0).unwrap(), "a different seed paints differently");
}

#[test]
fn scatter_count_3_places_3x_dabs_perpendicular_only_without_both_axes() {
    let anchor = Sample::new(0.0, 0.0, 1.0);
    let dyn_ = stroke::Dynamics {
        scatter: stroke::ScatterDynamics { enabled: true, count: 3, amount: 1.0, both_axes: false, ..Default::default() },
        ..Default::default()
    };
    let mut prng = stroke::Prng::new(1);
    let mut idx = 0u32;
    let dabs = stroke::place_dabs(&anchor, 0.0, 10.0, 0.0, 1.0, false, false, &dyn_, [0.0; 3], &mut prng, &mut idx);
    assert_eq!(dabs.len(), 3, "count 3 places 3x the dabs of one anchor");
    assert_eq!(idx, 3);
    assert!(dabs.iter().all(|d| d.x == anchor.x), "dir 0's perpendicular is the y axis: x never moves");
    assert!(dabs.iter().any(|d| d.y != anchor.y), "the perpendicular offset moves y");
}

#[test]
fn hue_jitter_changes_color_per_sub_dab_with_per_tip_on_one_color_off() {
    let anchor = Sample::new(0.0, 0.0, 1.0);
    let fg = [1.0, 0.0, 0.0];
    let color =
        stroke::ColorDynamics { enabled: true, bg: fg, fg_bg: 0.0, hue_jitter: 1.0, per_tip: true, ..Default::default() };
    let scatter =
        stroke::ScatterDynamics { enabled: true, count: 3, amount: 1.0, both_axes: false, ..Default::default() };
    let dyn_on = stroke::Dynamics { scatter: scatter.clone(), color: color.clone(), ..Default::default() };
    let mut prng = stroke::Prng::new(3);
    let mut idx = 0u32;
    let dabs = stroke::place_dabs(&anchor, 0.0, 10.0, 0.0, 1.0, false, false, &dyn_on, fg, &mut prng, &mut idx);
    let colors: Vec<[f32; 3]> = dabs.iter().map(|d| d.rgb.unwrap()).collect();
    assert!(colors.windows(2).any(|w| w[0] != w[1]), "perTip on: every sub-dab draws its own color");

    let dyn_off = stroke::Dynamics {
        scatter,
        color: stroke::ColorDynamics { per_tip: false, ..color },
        ..Default::default()
    };
    let mut prng2 = stroke::Prng::new(3);
    let mut idx2 = 0u32;
    let dabs2 = stroke::place_dabs(&anchor, 0.0, 10.0, 0.0, 1.0, false, false, &dyn_off, fg, &mut prng2, &mut idx2);
    let colors2: Vec<[f32; 3]> = dabs2.iter().map(|d| d.rgb.unwrap()).collect();
    assert!(colors2.windows(2).all(|w| w[0] == w[1]), "perTip off: one color for the whole spaced position");
}

#[test]
fn pose_pressure_override_changes_size_under_pressure_size_control() {
    let mut raw = core_bg(255, 255, 255);
    stroke(&mut raw, &hard(r#","size":20,"pressureSize":true"#), &[30.5, 30.5, 0.1]);
    assert_eq!(at(&raw.doc, 34, 30), [255, 255, 255, 255], "raw low pressure keeps the dab small");

    let mut overridden = core_bg(255, 255, 255);
    stroke(
        &mut overridden,
        &hard(r#","size":20,"pressureSize":true,"pose":{"enabled":true,"pressure":1.0}"#),
        &[30.5, 30.5, 0.1],
    );
    assert_eq!(at(&overridden.doc, 34, 30), [0, 0, 0, 255], "the pose override, not the raw sample, drives the size");
}

#[test]
fn stride_6_tilt_drives_pen_tilt() {
    let params = hard(r#","stride":6,"transfer":{"enabled":true,"opacityDyn":{"control":"penTilt","minimum":0}}"#);
    let mut no_tilt = core_bg(255, 255, 255);
    no_tilt.stroke_begin(1, "pixels", &params).unwrap();
    no_tilt.stroke_to(&[30.5, 30.5, 1.0, 0.0, 0.0, 0.0]).unwrap();
    no_tilt.stroke_end().unwrap();
    assert_eq!(at(&no_tilt.doc, 30, 30), [255, 255, 255, 255], "no tilt: penTilt control is 0, so is the opacity");

    let mut tilted = core_bg(255, 255, 255);
    tilted.stroke_begin(1, "pixels", &params).unwrap();
    tilted.stroke_to(&[30.5, 30.5, 1.0, 90.0, 0.0, 0.0]).unwrap();
    tilted.stroke_end().unwrap();
    assert_eq!(at(&tilted.doc, 30, 30), [0, 0, 0, 255], "a stride-6 tilt sample drives the penTilt control");
}

#[test]
fn brush_preview_is_deterministic_nonempty_and_sized() {
    let e = core_bg(255, 255, 255);
    let params = hard(r#","size":20"#);
    let a = e.brush_preview(&params, 64, 32).unwrap();
    let b = e.brush_preview(&params, 64, 32).unwrap();
    assert_eq!(a.len(), 64 * 32 * 4);
    assert_eq!(a, b, "the same params always preview the same, regardless of the brush's own seed");
    assert!(a.iter().any(|&v| v != 0), "the pressure ramp paints something");
}

#[test]
fn tip_add_rejects_bad_sizes_and_length() {
    let mut e = core_bg(255, 255, 255);
    assert!(e.tip_add(0, 3, vec![0; 3]).is_err(), "a 0 px side is rejected");
    assert!(e.tip_add(2501, 3, vec![0; 2501 * 3]).is_err(), "over 2500 px per side is rejected");
    assert!(e.tip_add(3, 3, vec![0; 8]).is_err(), "alpha must be exactly w * h long");
    assert!(e.tip_add(3, 3, vec![0; 9]).is_ok());
}

// ---------- B5 Part E2 (patterns, texture, dual brush) ----------

#[test]
fn pattern_add_rejects_bad_sizes_and_length() {
    let mut e = core_bg(255, 255, 255);
    assert!(e.pattern_add(0, 3, &[0; 3], 1).is_err(), "a 0 px side is rejected");
    assert!(e.pattern_add(4097, 3, &[0; 4097 * 3], 1).is_err(), "over 4096 px per side is rejected");
    assert!(e.pattern_add(3, 3, &[0; 8], 1).is_err(), "gray bytes must be w * h long");
    assert!(e.pattern_add(3, 3, &[0; 9], 1).is_ok());
    assert!(e.pattern_add(2, 2, &[0; 16], 4).is_ok());
}

// A period-2 checker pattern (dark, light) used by every texture golden below.
fn checker(e: &mut EngineCore) -> u32 {
    e.pattern_add(2, 1, &[0, 255], 1).unwrap()
}

#[test]
fn texture_multiply_at_depth_1_leaves_dark_texels_unpainted() {
    let mut e = core_bg(255, 255, 255);
    let pid = checker(&mut e);
    let params = hard(&format!(
        r#","size":5,"texture":{{"enabled":true,"patternId":{pid},"mode":"multiply","scale":1,"depth":1}}"#
    ));
    stroke(&mut e, &params, &[12.5, 12.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 12), [255, 255, 255, 255], "even x samples the dark (0) texel: multiply gives zero");
    assert_eq!(at(&e.doc, 13, 12), [0, 0, 0, 255], "odd x samples the light (1) texel: multiply is a no-op");
}

#[test]
fn texture_invert_flips_which_texels_paint() {
    let mut e = core_bg(255, 255, 255);
    let pid = checker(&mut e);
    let params = hard(&format!(
        r#","size":5,"texture":{{"enabled":true,"patternId":{pid},"mode":"multiply","scale":1,"depth":1,"invert":true}}"#
    ));
    stroke(&mut e, &params, &[12.5, 12.5, 1.0]);
    assert_eq!(at(&e.doc, 10, 12), [0, 0, 0, 255], "inverted: the dark texel now reads as light");
    assert_eq!(at(&e.doc, 13, 12), [255, 255, 255, 255], "inverted: the light texel now reads as dark");
}

#[test]
fn texture_scale_2_doubles_the_period() {
    let mut e = core_bg(255, 255, 255);
    let pid = checker(&mut e);
    let scale1 = hard(&format!(
        r#","size":5,"texture":{{"enabled":true,"patternId":{pid},"mode":"multiply","scale":1,"depth":1}}"#
    ));
    stroke(&mut e, &scale1, &[12.5, 12.5, 1.0]);
    assert_ne!(at(&e.doc, 12, 12), at(&e.doc, 13, 12), "scale 1: adjacent columns land on different texels");

    let mut e2 = core_bg(255, 255, 255);
    let pid2 = checker(&mut e2);
    let scale2 = hard(&format!(
        r#","size":5,"texture":{{"enabled":true,"patternId":{pid2},"mode":"multiply","scale":2,"depth":1}}"#
    ));
    stroke(&mut e2, &scale2, &[12.5, 12.5, 1.0]);
    assert_eq!(at(&e2.doc, 12, 12), at(&e2.doc, 13, 12), "scale 2: the period doubled, so they now agree");
}

#[test]
fn texture_each_tip_samples_the_dab_local_rect_not_the_document() {
    let pid_params = |each_tip: bool, pid: u32| {
        hard(&format!(
            r#","size":5,"texture":{{"enabled":true,"patternId":{pid},"mode":"multiply","scale":1,"depth":1,"eachTip":{each_tip}}}"#
        ))
    };
    // Anchor x = 12.5, size 5 (radius 2.5): the dab's pixel rect starts at document x = 9 (odd),
    // so a document-anchored sample and a dab-local sample (offset from x = 9) land on opposite
    // texels of the period-2 checker at document x = 10.
    let mut doc_anchored = core_bg(255, 255, 255);
    let pid = checker(&mut doc_anchored);
    stroke(&mut doc_anchored, &pid_params(false, pid), &[12.5, 12.5, 1.0]);
    let mut dab_local = core_bg(255, 255, 255);
    let pid2 = checker(&mut dab_local);
    stroke(&mut dab_local, &pid_params(true, pid2), &[12.5, 12.5, 1.0]);
    assert_ne!(at(&doc_anchored.doc, 10, 12), at(&dab_local.doc, 10, 12), "eachTip and the document anchor sample differently");
}

#[test]
fn dual_brush_multiply_with_no_secondary_coverage_leaves_zero() {
    let mut e = core_bg(255, 255, 255);
    // A tiny, widely spaced secondary tip: no grid point's stamp reaches the primary dab's rect.
    let params = hard(
        r#","size":5,"dualBrush":{"enabled":true,"tip":"round","mode":"multiply","size":1,"spacing":100,"scatter":0,"count":1}"#,
    );
    stroke(&mut e, &params, &[12.5, 12.5, 1.0]);
    assert_eq!(at(&e.doc, 12, 12), [255, 255, 255, 255], "multiply by zero secondary coverage paints nothing");
}

#[test]
fn dual_brush_mask_uses_max_compositing_not_a_sum() {
    // step = size * spacing = 3, so grid points at document x = 0, 3, 6, ...; scatter 0 keeps
    // them exact. A soft (hardness 0.5) tip of radius 5 overlaps its neighbor at x = 1.
    let dual = DualBrush {
        enabled: true,
        shape: TipShape::Round,
        hardness: 0.5,
        roundness: 1.0,
        angle: 0.0,
        flip_x: false,
        flip_y: false,
        mode: Blend::Multiply,
        size: 10.0,
        spacing: 0.3,
        scatter: 0.0,
        both_axes: false,
        count: 1,
    };
    let mask = stroke::dual_brush_mask(&dual, (0, 0, 20, 20), 0, 0);
    let tip = Tip::new(5.0, 0.5, 0.0, 1.0, false, TipShape::Round, false, false);
    let (x, y) = (1usize, 0usize);
    let v0 = tip.cov(x as f32 + 0.5, y as f32 + 0.5);
    let v1 = tip.cov(x as f32 + 0.5 - 3.0, y as f32 + 0.5);
    assert!(v0 > 0.0 && v1 > 0.0, "both grid stamps reach this pixel");
    let got = mask[y * 20 + x];
    assert!((got - v0.max(v1)).abs() < 1e-4, "max compositing: got {got}, want max {}", v0.max(v1));
    assert!(got < v0 + v1 - 1e-3, "not a sum of the two overlapping stamps");
}

#[test]
#[ignore = "timing guide, not a gate"]
fn stroke_latency_on_a_4k_canvas() {
    let mut e = EngineCore::new(Document::new(3840, 2160, 8).unwrap());
    e.doc.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    let pid = e.pattern_add(2, 2, &[0, 255, 255, 0], 1).unwrap();
    let params = format!(
        r#"{{"rgba":[0,0,0,255],"mode":"normal","size":30,
            "texture":{{"enabled":true,"patternId":{pid},"mode":"multiply","scale":4}},
            "dualBrush":{{"enabled":true,"tip":"round","mode":"multiply","size":15,"spacing":0.5,"scatter":2,"count":2}}}}"#
    );
    e.stroke_begin(1, "pixels", &params).unwrap();
    let t0 = std::time::Instant::now();
    let segments = 60;
    for i in 0..segments {
        let x = 100.0 + (i * 20) as f64;
        e.stroke_to(&[x, 500.0, 1.0]).unwrap();
    }
    let ms = t0.elapsed().as_secs_f64() * 1000.0 / segments as f64;
    println!("stroke_to (texture + dual brush): {ms:.3} ms per 20 px segment");
    e.stroke_end().unwrap();
}

// ---------- Channels panel targeting ----------

fn channel_at(e: &EngineCore, id: u32, x: i32, y: i32) -> f32 {
    let ch = e.doc.channels.iter().find(|c| c.id == id).unwrap();
    e.doc.sel_at(&ch.mask, x, y)
}

#[test]
fn a_fill_on_one_targeted_color_channel_keeps_the_others() {
    let mut e = core_bg(10, 20, 30);
    e.color_target = [false, true, false];
    e.fill_ex(1, "pixels", r#"{"source":"solid","rgba":[200,200,200,255],"mode":"normal","opacity":1.0,"preserveTransparency":false}"#)
        .unwrap();
    assert_eq!(at(&e.doc, 5, 5), [10, 200, 30, 255]);
}

#[test]
fn a_stroke_on_one_targeted_color_channel_keeps_the_others() {
    let mut e = core_bg(0, 0, 0);
    e.color_target = [true, false, false];
    e.stroke_begin(1, "pixels", &hard(r#","rgba":[255,255,255,255],"size":20"#)).unwrap();
    e.stroke_to(&[10.5, 10.5, 1.0]).unwrap();
    e.stroke_end().unwrap();
    assert_eq!(at(&e.doc, 10, 10), [255, 0, 0, 255]);
}

#[test]
fn a_selection_target_stroke_paints_the_targeted_alpha_channel_inside_the_selection_and_keeps_it() {
    let mut e = core_bg(255, 255, 255);
    let c = e.doc.new_channel("Alpha 1").unwrap();
    e.doc.select_rect(100.0, 100.0, 20.0, 20.0, Mode::New).unwrap();
    e.alpha_targets = vec![c];
    for p in [10.5, 110.5] {
        e.stroke_begin(1, "selection", &hard(r#","rgba":[255,255,255,255],"size":40"#)).unwrap();
        e.stroke_to(&[p, p, 1.0]).unwrap();
        e.stroke_end().unwrap();
    }
    assert_eq!(channel_at(&e, c, 10, 10), 0.0, "outside the selection");
    assert_eq!(channel_at(&e, c, 110, 110), 1.0);
    assert_eq!(channel_at(&e, c, 95, 110), 0.0, "under the brush but outside the selection");
    assert_eq!(e.doc.selection_bounds(), Some([100, 100, 20, 20]), "the selection is untouched");
    assert_eq!(at(&e.doc, 10, 10), [255, 255, 255, 255], "the layer is untouched");
}

#[test]
fn a_saved_channel_reads_its_live_values_during_a_stroke() {
    let mut e = core_bg(255, 255, 255);
    let c = e.doc.new_channel("Alpha 1").unwrap();
    e.alpha_targets = vec![c];
    e.stroke_begin(1, "selection", &hard(r#","rgba":[255,255,255,255],"size":20"#)).unwrap();
    e.stroke_to(&[10.5, 10.5, 1.0]).unwrap();
    let live = e.channel_tile(c, 0, 0, 0).unwrap().expect("painted");
    assert_eq!(live[10 * 256 + 10], 255);
    e.stroke_end().unwrap();
    assert_eq!(e.channel_tile(c, 0, 0, 0).unwrap().expect("painted")[10 * 256 + 10], 255);
}

#[test]
fn a_cancelled_alpha_channel_stroke_restores_the_channel_and_the_selection() {
    let mut e = core_bg(255, 255, 255);
    let c = e.doc.new_channel("Alpha 1").unwrap();
    e.alpha_targets = vec![c];
    e.stroke_begin(1, "selection", &hard("")).unwrap();
    e.stroke_to(&[10.5, 10.5, 1.0]).unwrap();
    e.stroke_cancel().unwrap();
    assert_eq!(channel_at(&e, c, 10, 10), 0.0);
    assert!(!e.doc.has_selection());
}

#[test]
fn a_selection_target_fill_fills_the_targeted_alpha_channel() {
    let mut e = core_bg(0, 0, 0);
    let c = e.doc.new_channel("Alpha 1").unwrap();
    e.alpha_targets = vec![c];
    e.fill_ex(1, "selection", r#"{"source":"solid","rgba":[255,255,255,255],"mode":"normal","opacity":1.0,"preserveTransparency":false}"#)
        .unwrap();
    assert_eq!(channel_at(&e, c, 5, 5), 1.0);
    assert!(!e.doc.has_selection());
}

#[test]
fn several_targeted_alpha_channels_take_the_same_stroke_and_fill_inside_the_selection() {
    let mut e = core_bg(255, 255, 255);
    let (a, b) = (e.doc.new_channel("Alpha 1").unwrap(), e.doc.new_channel("Alpha 2").unwrap());
    e.alpha_targets = vec![a, b];
    e.stroke_begin(1, "selection", &hard(r#","rgba":[255,255,255,255],"size":20"#)).unwrap();
    e.stroke_to(&[10.5, 10.5, 1.0]).unwrap();
    e.stroke_end().unwrap();
    for c in [a, b] {
        assert_eq!((channel_at(&e, c, 10, 10), channel_at(&e, c, 40, 10)), (1.0, 0.0), "channel {c}");
    }
    assert!(!e.doc.has_selection());
    e.doc.select_rect(100.0, 100.0, 20.0, 20.0, Mode::New).unwrap();
    e.fill_ex(1, "selection", r#"{"source":"solid","rgba":[255,255,255,255],"mode":"normal","opacity":1.0,"preserveTransparency":false}"#)
        .unwrap();
    for c in [a, b] {
        assert_eq!((channel_at(&e, c, 110, 110), channel_at(&e, c, 50, 50)), (1.0, 0.0), "fill in channel {c}");
    }
    assert_eq!(e.doc.selection_bounds(), Some([100, 100, 20, 20]));
}

#[test]
fn spot_channels_start_without_ink_take_options_duplicate_and_list_their_ink() {
    let mut d = Document::new(16, 16, 8).unwrap();
    let ink = Spot { color: [0, 153, 230], solidity: 0.0 };
    let s = d.new_spot_channel("Spot Color 1", ink).unwrap();
    let ch = d.channels.iter().find(|c| c.id == s).unwrap();
    assert_eq!(ch.mask.default, 255, "white: no ink");
    d.set_spot(s, "Gold", Spot { color: [200, 160, 40], solidity: 0.5 }).unwrap();
    let dup = d.duplicate_channel(s, "Gold copy").unwrap();
    let v: serde_json::Value = serde_json::from_str(&d.channels_json()).unwrap();
    assert_eq!(v["channels"][0]["name"], "Gold");
    assert_eq!(v["channels"][0]["spot"], serde_json::json!({ "color": [200, 160, 40], "solidity": 0.5 }));
    assert_eq!(v["channels"][1]["id"], dup);
    assert_eq!(v["channels"][1]["spot"]["color"], serde_json::json!([200, 160, 40]));
    assert!(d.set_spot(s, "x", Spot { color: [0, 0, 0], solidity: 1.5 }).is_err(), "solidity is 0..1");
    let a = d.new_channel("Alpha 1").unwrap();
    assert!(d.set_spot(a, "x", ink).is_err(), "an alpha channel is not a spot channel");
}

#[test]
fn spot_channels_survive_the_manifest_and_need_v8() {
    let mut d = Document::new(16, 16, 8).unwrap();
    d.new_spot_channel("Spot Color 1", Spot { color: [1, 2, 3], solidity: 0.25 }).unwrap();
    d.new_channel("Alpha 1").unwrap();
    let (first, second) = crate::doc::m3_tests::reload(&d);
    assert_eq!(first, second, "write -> read -> write is byte identical");
    let mut v: serde_json::Value = serde_json::from_str(&first).unwrap();
    assert_eq!(v["version"], 8);
    assert!(v["channels"][1].get("spot").is_none(), "alpha channels write no spot");
    v["version"] = 7.into();
    assert!(Document::from_manifest(&v.to_string()).err().unwrap().contains("v8"));
}

#[test]
fn float_tiles_write_and_flatten_with_over_range_kept() {
    let mut d = Document::new(300, 10, 32).unwrap();
    let mut t = vec![0f32; TILE_PIXELS * 4];
    t[..8].copy_from_slice(&[2.5, 0.5, 0.25, 1.0, 1.0, 0.0, 0.0, 0.5]);
    d.set_tile_f32(1, 1, 0, &t).unwrap();
    let f = d.flatten_tile_f32(1, 0).unwrap();
    assert_eq!(&f[..8], &[2.5, 0.5, 0.25, 1.0, 1.0, 0.0, 0.0, 0.5]);
    assert_eq!(d.flatten_tile_f32(0, 0).unwrap()[3], 0.0);
    assert!(Document::new(8, 8, 8).unwrap().set_tile_f32(1, 0, 0, &t).is_err());
    assert!(d.set_tile_f32(1, 0, 0, &t[..4]).is_err());
}

// A 32-bit document whose Background holds the straight gray values `vs` in the first pixels.
fn float_doc(vs: &[f32]) -> Document {
    let mut d = Document::new(16, 1, 32).unwrap();
    let mut t = vec![0f32; TILE_PIXELS * 4];
    for (i, v) in vs.iter().enumerate() {
        t[i * 4..i * 4 + 4].copy_from_slice(&[*v, *v, *v, 1.0]);
    }
    d.set_tile_f32(1, 0, 0, &t).unwrap();
    d
}

fn exposure_json(ev: f32) -> String {
    serde_json::json!({ "kind": "exposure", "params": { "exposure": ev, "offset": 0.0, "gamma": 1.0 } }).to_string()
}

fn exposed(v: f32, ev: f32) -> f32 {
    use crate::gradient::{linear_to_srgb, srgb_to_linear};
    linear_to_srgb(srgb_to_linear(v) * ev.exp2())
}

#[test]
fn exposure_on_32_bit_documents_keeps_values_above_one() {
    let mut d = float_doc(&[0.8, 2.0]);
    let a = d.add_special(1, &format!(r#"{{ "name": "Exposure", "adjustment": {} }}"#, exposure_json(1.0))).unwrap();
    let f = d.flatten_tile_f32(0, 0).unwrap();
    assert!((f[0] - exposed(0.8, 1.0)).abs() < 1e-4 && f[0] > 1.0, "layer: {}", f[0]);
    assert!((f[4] - exposed(2.0, 1.0)).abs() < 1e-3, "layer reads above 1: {}", f[4]);
    d.delete_node(a).unwrap();
    let b = d.add_special(1, &format!(r#"{{ "name": "Exposure", "adjustment": {} }}"#, exposure_json(-1.0))).unwrap();
    let f = d.flatten_tile_f32(0, 0).unwrap();
    assert!((f[4] - exposed(2.0, -1.0)).abs() < 1e-3, "darkening reads the stored 2.0: {}", f[4]);
    d.add_special(b, r#"{ "name": "Invert", "adjustment": { "kind": "invert", "params": {} } }"#).unwrap();
    assert_eq!(d.flatten_tile_f32(0, 0).unwrap()[4], 0.0, "inverting a value above 1 stops at 0");

    let mut d = float_doc(&[0.8]);
    d.apply_adjustment(1, Target::Pixels, &exposure_json(1.0)).unwrap();
    let v = d.flatten_tile_f32(0, 0).unwrap()[0];
    assert!((v - exposed(0.8, 1.0)).abs() < 1e-4, "destructive: {v}");
}

// Backdrop 2.0 (8-bit: 0.8) under a top layer of `top` in `blend`; the composite red value.
fn blend_over_two(depth: u8, blend: &str, top: f32) -> f32 {
    let mut d = if depth == 32 { float_doc(&[2.0]) } else { Document::new(16, 1, 8).unwrap() };
    let id = d.add_layer("top", 1).unwrap();
    if depth == 32 {
        d.set_tile_f32(id, 0, 0, &[[top, top, top, 1.0]; TILE_PIXELS].concat()).unwrap();
    } else {
        let q = |v: f32| (v * 255.0).round() as u8;
        d.set_tile_rgba8(1, 0, 0, &[[204u8, 204, 204, 255]; TILE_PIXELS].concat()).unwrap();
        d.set_tile_rgba8(id, 0, 0, &[[q(top), q(top), q(top), 255]; TILE_PIXELS].concat()).unwrap();
    }
    d.set_props(id, &format!(r#"{{"blend":"{blend}"}}"#)).unwrap();
    d.flatten_tile_f32(0, 0).unwrap()[0]
}

#[test]
fn photoshop_32_bit_blend_modes_keep_values_above_one() {
    for (blend, top, want) in [("multiply", 0.5, 1.0), ("linear dodge", 1.5, 3.5), ("lighten", 3.0, 3.0), ("darken", 3.0, 2.0),
        ("difference", 3.0, 1.0), ("luminosity", 2.5, 2.5), ("color", 0.5, 2.0)] {
        let v = blend_over_two(32, blend, top);
        assert!((v - want).abs() < 1e-4, "{blend}: {v}, want {want}");
    }
    assert!((blend_over_two(32, "screen", 0.5) - 1.0).abs() < 1e-6, "modes Photoshop hides in 32-bit still clamp");
    assert!((blend_over_two(8, "multiply", 0.5) - 0.4).abs() < 1.0 / 255.0, "8-bit unchanged");

    let mut d = float_doc(&[2.0]);
    let a = d.add_special(1, &format!(r#"{{ "name": "Exposure", "adjustment": {} }}"#, exposure_json(1.0))).unwrap();
    d.set_props(a, r#"{"blend":"multiply"}"#).unwrap();
    let (v, want) = (d.flatten_tile_f32(0, 0).unwrap()[0], 2.0 * exposed(2.0, 1.0));
    assert!((v - want).abs() < 1e-3, "adjustment layer in Multiply: {v}, want {want}");
}

// A 2.0 pixel under one Color Overlay of gray 128 in `blend` at `opacity`; the composite red value.
fn overlay_over_two(blend: &str, opacity: f32) -> f32 {
    let mut d = float_doc(&[2.0]);
    let overlay = serde_json::json!({ "present": true, "enabled": true, "blend": blend, "opacity": opacity, "color": [128, 128, 128] });
    let style = serde_json::json!({ "enabled": true, "scale": 1.0, "drop_shadows": [], "inner_shadows": [], "color_overlays": [overlay],
        "gradient_overlays": [], "pattern_overlays": [], "strokes": [], "outer_glow": null, "inner_glow": null, "bevel": null,
        "contour": null, "texture": null, "satin": null });
    d.set_style(1, &style.to_string()).unwrap();
    d.flatten_tile_f32(0, 0).unwrap()[0]
}

#[test]
fn layer_effects_on_32_bit_documents_keep_values_above_one() {
    let g = 128.0 / 255.0;
    for (blend, opacity, want) in [("normal", 0.5, 1.0 + g / 2.0), ("linear dodge", 1.0, 2.0 + g), ("multiply", 1.0, 2.0 * g), ("lighten", 1.0, 2.0)] {
        let v = overlay_over_two(blend, opacity);
        assert!((v - want).abs() < 1e-4, "{blend}: {v}, want {want}");
    }
    assert!((overlay_over_two("screen", 1.0) - 1.0).abs() < 1e-6, "modes Photoshop hides in 32-bit still clamp");
}

fn hdr_json(method: &str) -> String {
    serde_json::json!({ "kind": "hdr_toning", "params": { "method": method, "radius": 16.0, "strength": 0.5, "detail": 30.0,
        "shadow": 0.0, "highlight": 0.0, "exposure": 0.0, "gamma": 1.0, "vibrance": 0.0, "saturation": 0.0 } })
    .to_string()
}

// Extended Reinhard on the linear value with white = the linear brightest, back to encoded.
fn reinhard_linear(v: f32, max: f32) -> f32 {
    use crate::gradient::{linear_to_srgb, srgb_to_linear};
    let (l, w) = (srgb_to_linear(v), srgb_to_linear(max));
    linear_to_srgb(l * (1.0 + l / (w * w)) / (1.0 + l))
}

#[test]
fn hdr_toning_compresses_32_bit_values_above_one() {
    let mut d = float_doc(&[0.5, 1.0, 2.0, 4.0]);
    d.apply_destructive(1, &hdr_json("highlight_compression")).unwrap();
    let f = d.flatten_tile_f32(0, 0).unwrap();
    let g: Vec<f32> = (0..4).map(|i| f[i * 4]).collect();
    assert!((g[3] - 1.0).abs() < 1e-5, "the brightest maps to white: {g:?}");
    assert!(g[0] < 0.5 && g.windows(2).all(|w| w[0] < w[1]), "monotonic and compressed: {g:?}");
    assert!((g[0] - reinhard_linear(0.5, 4.0)).abs() < 1e-4, "compressed in linear light: {g:?}");

    let mut d = float_doc(&[0.5, 1.5, 3.0]);
    d.apply_destructive(1, &hdr_json("equalize_histogram")).unwrap();
    let f = d.flatten_tile_f32(0, 0).unwrap();
    assert!(f[4] < f[8] && f[8] <= 1.0, "values above 1 keep their order: {} {}", f[4], f[8]);
}

// A 64x64 32-bit document whose layer "L" is gray 0.25 left of x = 32 and 4.0 from there.
fn hdr_step_doc() -> (Document, u32) {
    let mut d = Document::new(64, 64, 32).unwrap();
    let id = d.add_layer("L", 1).unwrap();
    let t: Vec<f32> = (0..TILE_PIXELS).flat_map(|p| { let v = if p % TILE >= 32 { 4.0 } else { 0.25 }; [v, v, v, 1.0] }).collect();
    d.set_tile_f32(id, 0, 0, &t).unwrap();
    (d, id)
}

// The brightest composite channel inside the 64x64 document.
fn brightest(d: &Document) -> f32 {
    let f = d.flatten_tile_f32(0, 0).unwrap();
    (0..64 * 64).map(|i| (i / 64) * TILE + i % 64).flat_map(|p| f[p * 4..p * 4 + 3].to_vec()).fold(0.0, f32::max)
}

#[test]
fn photoshop_32_bit_filters_keep_values_above_one() {
    let v: serde_json::Value = serde_json::from_str(&crate::filters::schema_json()).unwrap();
    let menu = ["blur", "blurGallery", "distort", "noise", "pixelate", "render", "sharpen", "stylize", "video", "other", "tool", "liquify", "vanishing", "gallery"];
    // Their output is a color, a threshold or a legal range by construction, also in Photoshop.
    let bounded = ["pixelate.color_halftone", "pixelate.mezzotint", "render.clouds", "render.fibers", "stylize.trace_contour", "video.ntsc_colors"];
    let (mut ran, mut low) = (0, Vec::new());
    for e in v.as_array().unwrap().iter().filter(|e| menu.contains(&e["group"].as_str().unwrap().split('.').next().unwrap())) {
        let id = e["id"].as_str().unwrap();
        let json = serde_json::json!({ "kind": id, "params": {} }).to_string();
        let (mut d, l) = hdr_step_doc();
        if e["hdr"] != true {
            let err = d.apply_filter(l, Target::Pixels, &json, None, 1.0).unwrap_err();
            assert!(err.contains("not available for 32-bit images") || err.contains("is required"), "{id}: {err}");
            continue;
        }
        if d.apply_filter(l, Target::Pixels, &json, None, 1.0).is_err() {
            continue; // a required map or blob
        }
        ran += 1;
        let flat = brightest(&d);
        let (mut s, l) = hdr_step_doc();
        s.convert_for_smart_filters(l, r#"{ "link_id": "l", "source_blob": null }"#).unwrap();
        s.apply_filter(l, Target::Pixels, &json, None, 1.0).unwrap();
        let smart = brightest(&s);
        if !bounded.contains(&id) && !(flat > 1.01 && smart > 1.01) {
            low.push(format!("{id}: destructive {flat}, smart {smart}"));
        }
    }
    assert!(low.is_empty(), "{low:#?}");
    assert!(ran > 40, "{ran} filters ran");
    let (mut d, l) = hdr_step_doc();
    d.apply_filter(l, Target::Pixels, r#"{ "kind": "gaussian_blur", "params": {} }"#, Some([0, 0, 64, 64]), 0.5).unwrap();
    assert!(brightest(&d) > 3.9, "a preview proxy: {}", brightest(&d));
}

#[test]
fn paint_modes_of_the_32_bit_list_keep_values_above_one() {
    for mode in [Blend::Multiply, Blend::Lighten, Blend::Color] {
        let (mut d, l) = hdr_step_doc();
        d.fill_ex(l, Target::Pixels, &FillSource::Solid([255, 255, 255, 255]), PaintMode::Blend(mode), 1.0, false).unwrap();
        assert!(brightest(&d) > 3.9, "{mode:?}: {}", brightest(&d));
    }
}

#[test]
fn destructive_adjustments_store_full_float_in_32_bit() {
    let vs = [0.25, 1.0 + 1e-5, 2.5];
    let mut d = float_doc(&vs);
    d.apply_destructive(1, r#"{"kind":"desaturate","params":{}}"#).unwrap();
    let f = d.flatten_tile_f32(0, 0).unwrap();
    for (i, v) in vs.iter().enumerate() {
        assert_eq!(f[i * 4], *v, "gray {v} through Desaturate");
    }
}
