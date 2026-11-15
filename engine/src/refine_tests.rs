use super::{refine, upsample_edits, Params, ADD, KEEP_EDGE, REFINE, SUBTRACT};

const BLUE: [u8; 3] = [30, 40, 200];
const GOLD: [u8; 3] = [220, 180, 40];

// w x h RGBA8: blue left of column `edge`, gold from `edge` on.
fn two_tone(w: usize, h: usize, edge: usize) -> Vec<u8> {
    let mut px = vec![255u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            px[(y * w + x) * 4..][..3].copy_from_slice(if x < edge { &BLUE } else { &GOLD });
        }
    }
    px
}

// Hard selection of columns `x0..x1` (all rows).
fn cols(w: usize, h: usize, x0: usize, x1: usize) -> Vec<f32> {
    (0..w * h).map(|i| if (x0..x1).contains(&(i % w)) { 1.0 } else { 0.0 }).collect()
}

fn none() -> Params {
    Params::default()
}

#[test]
fn default_params_keep_the_selection_and_mark_no_edge() {
    let (w, h) = (48, 16);
    let sel: Vec<f32> = (0..w * h).map(|i| (i % w) as f32 / (w - 1) as f32).collect();
    let r = refine(&sel, &two_tone(w, h, 20), w, h, &none(), 1.0, &[]);
    assert_eq!(r.alpha, sel);
    assert!(r.band.iter().all(|&b| !b));
}

#[test]
fn edge_detection_snaps_an_offset_selection_to_the_object_edge() {
    let (w, h) = (96, 24);
    let img = two_tone(w, h, 40);
    let sel = cols(w, h, 44, w);
    let r = refine(&sel, &img, w, h, &Params { radius: 8.0, ..none() }, 1.0, &[]);
    let at = |x: usize| r.alpha[12 * w + x];
    for x in 40..44 {
        assert!(at(x) > 0.95, "object column {x} is selected: {}", at(x));
    }
    for x in 34..40 {
        assert!(at(x) < 0.05, "background column {x} stays out: {}", at(x));
    }
    assert_eq!((at(5), at(90)), (0.0, 1.0), "far from the edge nothing changes");
    assert!(r.band[12 * w + 44] && !r.band[12 * w + 5] && !r.band[12 * w + 90]);
}

#[test]
fn a_mixed_edge_pixel_gets_a_partial_alpha() {
    let (w, h) = (64, 16);
    let mut img = two_tone(w, h, 32);
    for y in 0..h {
        let p = &mut img[(y * w + 32) * 4..][..3];
        for c in 0..3 {
            p[c] = ((BLUE[c] as u16 + GOLD[c] as u16) / 2) as u8;
        }
    }
    let r = refine(&cols(w, h, 32, w), &img, w, h, &Params { radius: 4.0, ..none() }, 1.0, &[]);
    let a = r.alpha[8 * w + 32];
    assert!((0.35..0.65).contains(&a), "half blue, half gold: {a}");
}

#[test]
fn smart_radius_narrows_the_band_on_a_clean_edge() {
    let (w, h) = (96, 24);
    let img = two_tone(w, h, 48);
    let sel = cols(w, h, 48, w);
    let wide = refine(&sel, &img, w, h, &Params { radius: 20.0, ..none() }, 1.0, &[]);
    let smart = refine(&sel, &img, w, h, &Params { radius: 20.0, smart: true, ..none() }, 1.0, &[]);
    let count = |b: &[bool]| b.iter().filter(|&&v| v).count();
    assert!(count(&smart.band) * 2 < count(&wide.band), "smart {} vs fixed {}", count(&smart.band), count(&wide.band));
    assert!(smart.alpha[12 * w + 47] < 0.05 && smart.alpha[12 * w + 48] > 0.95);
}

#[test]
fn smooth_rounds_off_a_thin_spike() {
    let (w, h) = (64, 64);
    let mut sel = vec![0f32; w * h];
    for y in 16..48 {
        for x in 16..48 {
            sel[y * w + x] = 1.0;
        }
    }
    for x in 48..56 {
        sel[32 * w + x] = 1.0;
    }
    let r = refine(&sel, &two_tone(w, h, 0), w, h, &Params { smooth: 100.0, ..none() }, 1.0, &[]);
    assert!(r.alpha[32 * w + 54] < 0.5, "the spike's tip goes: {}", r.alpha[32 * w + 54]);
    assert_eq!(r.alpha[32 * w + 32], 1.0, "the inside stays");
    assert_eq!(r.alpha[4 * w + 4], 0.0, "the outside stays");
}

#[test]
fn feather_softens_and_full_contrast_hardens_again() {
    let (w, h) = (64, 8);
    let sel = cols(w, h, 32, w);
    let img = two_tone(w, h, 0);
    let soft = refine(&sel, &img, w, h, &Params { feather: 6.0, ..none() }, 1.0, &[]);
    let row: Vec<f32> = (24..40).map(|x| soft.alpha[4 * w + x]).collect();
    assert!(row.windows(2).all(|p| p[0] <= p[1] + 1e-6), "monotonic ramp {row:?}");
    assert!(row.iter().filter(|&&v| v > 0.02 && v < 0.98).count() >= 4, "a soft ramp {row:?}");
    let hard = refine(&sel, &img, w, h, &Params { feather: 6.0, contrast: 100.0, ..none() }, 1.0, &[]);
    assert!(hard.alpha.iter().all(|&v| v == 0.0 || v == 1.0));
    assert_eq!(hard.alpha[4 * w + 32], 1.0);
    assert_eq!(hard.alpha[4 * w + 31], 0.0);
    let half = refine(&sel, &img, w, h, &Params { feather: 6.0, contrast: 50.0, ..none() }, 1.0, &[]);
    let soft_n = soft.alpha.iter().filter(|&&v| v > 0.02 && v < 0.98).count();
    let half_n = half.alpha.iter().filter(|&&v| v > 0.02 && v < 0.98).count();
    assert!(half_n < soft_n, "contrast narrows the ramp: {half_n} vs {soft_n}");
}

#[test]
fn shift_edge_moves_the_border_out_or_in() {
    let (w, h) = (64, 8);
    let sel = cols(w, h, 20, 40);
    let img = two_tone(w, h, 0);
    // Without a radius, 100 % moves the edge 4 px.
    let out = refine(&sel, &img, w, h, &Params { shift: 100.0, ..none() }, 1.0, &[]);
    let a = |r: &super::Refined, x: usize| r.alpha[4 * w + x];
    assert_eq!((a(&out, 15), a(&out, 16), a(&out, 43), a(&out, 44)), (0.0, 1.0, 1.0, 0.0));
    let inn = refine(&sel, &img, w, h, &Params { shift: -50.0, ..none() }, 1.0, &[]);
    assert_eq!((a(&inn, 21), a(&inn, 22), a(&inn, 37), a(&inn, 38)), (0.0, 1.0, 1.0, 0.0));
    // A soft edge keeps its profile and moves.
    let soft = refine(&sel, &img, w, h, &Params { feather: 6.0, ..none() }, 1.0, &[]);
    let moved = refine(&sel, &img, w, h, &Params { feather: 6.0, shift: 100.0, ..none() }, 1.0, &[]);
    for x in 12..20 {
        assert!((a(&moved, x - 4) - a(&soft, x)).abs() < 1e-5, "x {x}: {} vs {}", a(&moved, x - 4), a(&soft, x));
    }
}

#[test]
fn edits_add_subtract_force_or_keep_the_edge() {
    let (w, h) = (96, 24);
    let img = two_tone(w, h, 40);
    let sel = cols(w, h, 44, w);
    let mut edits = vec![128u8; w * h];
    edits[12 * w + 5] = ADD;
    edits[12 * w + 80] = SUBTRACT;
    let r = refine(&sel, &img, w, h, &none(), 1.0, &edits);
    assert_eq!((r.alpha[12 * w + 5], r.alpha[12 * w + 80]), (1.0, 0.0));
    // The Refine Edge Brush refines without a radius.
    let mut force = vec![128u8; w * h];
    for y in 0..h {
        for x in 38..46 {
            force[y * w + x] = REFINE;
        }
    }
    let r = refine(&sel, &img, w, h, &none(), 1.0, &force);
    assert!(r.alpha[12 * w + 41] > 0.95 && r.alpha[12 * w + 39] < 0.05, "{} {}", r.alpha[12 * w + 41], r.alpha[12 * w + 39]);
    assert!(r.band[12 * w + 41] && !r.band[12 * w + 60]);
    // Erasing the refine area keeps the original edge inside the radius.
    let mut keep = vec![128u8; w * h];
    for y in 0..h {
        for x in 36..52 {
            keep[y * w + x] = KEEP_EDGE;
        }
    }
    let r = refine(&sel, &img, w, h, &Params { radius: 8.0, ..none() }, 1.0, &keep);
    assert_eq!(r.alpha[12 * w + 41], 0.0);
    assert!(!r.band[12 * w + 41]);
}

#[test]
fn the_scale_shrinks_pixel_parameters_for_the_preview() {
    let (w, h) = (64, 8);
    let sel = cols(w, h, 20, 40);
    let img = two_tone(w, h, 0);
    // 100 % at radius 16 is 16 px; at half scale 8 working pixels.
    let r = refine(&sel, &img, w, h, &Params { radius: 16.0, shift: 100.0, ..none() }, 0.5, &[]);
    assert_eq!((r.alpha[4 * w + 11], r.alpha[4 * w + 12]), (0.0, 1.0));
}

#[test]
fn edits_upsample_smoothly_and_keep_refine_codes() {
    // 2 x 1 working edits: add on the left, refine on the right, to 8 x 2.
    let up = upsample_edits(&[ADD, REFINE], 2, 1, 8, 2);
    assert_eq!(up.len(), 16);
    assert_eq!(&up[..4], &[ADD, ADD, ADD, ADD]);
    assert_eq!(&up[4..8], &[REFINE; 4]);
    assert_eq!(upsample_edits(&[], 2, 1, 8, 2), Vec::<u8>::new(), "no edits stay none");
}
