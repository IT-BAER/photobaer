use super::{work_size, Focus, RANGE_MAX};

// A deterministic noise value in -amp..=amp.
fn noise(i: usize, amp: f32) -> f32 {
    let v = (i as u32).wrapping_mul(2_654_435_761).wrapping_add(0x9e37_79b9) >> 8;
    (v % 1000) as f32 / 999.0 * 2.0 * amp - amp
}

// w x h RGBA8: a sharp 2 px checker on the left half; on the right half a smooth ramp plus `amp` noise.
fn halves(w: usize, h: usize, amp: f32) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let v = if x < w / 2 {
                if (x / 2 + y / 2) % 2 == 0 { 30.0 } else { 220.0 }
            } else {
                100.0 + 50.0 * (x - w / 2) as f32 / (w / 2) as f32 + noise(y * w + x, amp)
            };
            let c = v.round().clamp(0.0, 255.0) as u8;
            px[(y * w + x) * 4..][..4].copy_from_slice(&[c, c, c, 255]);
        }
    }
    px
}

// Share of selected mask pixels in columns x0..x1, skipping a band of `skip` columns at both ends.
fn share(m: &[u8], w: usize, x0: usize, x1: usize, skip: usize) -> f32 {
    let h = m.len() / w;
    let cols = (x0 + skip)..(x1 - skip);
    let n = cols.len() * h;
    let on: usize = (0..h).map(|y| cols.clone().filter(|&x| m[y * w + x] == 255).count()).sum();
    on as f32 / n as f32
}

#[test]
fn work_size_fits_1024_and_never_upscales() {
    assert_eq!(work_size(4000, 3000), (1024, 768));
    assert_eq!(work_size(3000, 4000), (768, 1024));
    assert_eq!(work_size(300, 200), (300, 200));
    assert_eq!(work_size(5000, 3), (1024, 1));
}

#[test]
fn auto_selects_the_sharp_half_and_the_range_slider_widens_or_narrows_it() {
    let (w, h) = (192, 96);
    let f = Focus::new(&halves(w, h, 0.0), w, h);
    assert_eq!((f.w, f.h), (w, h));
    let (range, noise) = f.auto();
    assert!(range > 0.0 && range < RANGE_MAX, "auto range {range}");
    assert!(noise < 0.1, "a clean image needs almost no noise level: {noise}");
    let m = f.mask(range, noise, &[]);
    assert_eq!(m.len(), w * h);
    assert!(share(&m, w, 0, w / 2, 8) > 0.99, "sharp half {}", share(&m, w, 0, w / 2, 8));
    assert!(share(&m, w, w / 2, w, 8) < 0.01, "blurred half {}", share(&m, w, w / 2, w, 8));
    assert!(f.mask(0.0, 0.0, &[]).iter().all(|&v| v == 255), "range 0 selects everything");
    let all: usize = f.mask(RANGE_MAX, 0.0, &[]).iter().filter(|&&v| v == 255).count();
    assert!(all < m.iter().filter(|&&v| v == 255).count() + 1, "the top of the range selects no more");
}

#[test]
fn the_noise_level_keeps_a_noisy_blurred_background_out() {
    let (w, h) = (192, 96);
    let f = Focus::new(&halves(w, h, 8.0), w, h);
    let (range, noise) = f.auto();
    assert!(noise > 0.0, "auto noise level {noise}");
    let clean = f.mask(range, noise, &[]);
    assert!(share(&clean, w, w / 2, w, 8) < 0.01, "noisy half with the noise level {}", share(&clean, w, w / 2, w, 8));
    assert!(share(&clean, w, 0, w / 2, 8) > 0.99);
    let raw = f.mask(1.0, 0.0, &[]);
    assert!(share(&raw, w, w / 2, w, 8) > 0.5, "noise reads as detail without it: {}", share(&raw, w, w / 2, w, 8));
}

#[test]
fn a_flat_image_has_nothing_in_focus_and_edits_add_or_remove() {
    let (w, h) = (64, 32);
    let f = Focus::new(&vec![128u8; w * h * 4], w, h);
    let (range, noise) = f.auto();
    assert!(range.is_finite() && noise.is_finite());
    assert!(f.mask(range, noise, &[]).iter().all(|&v| v == 0), "flat: nothing in focus");
    // Edits: 255 adds, 0 removes, anything else keeps.
    let mut edits = vec![128u8; w * h];
    edits[5] = 255;
    assert_eq!(f.mask(range, noise, &edits)[5], 255);
    assert!(f.mask(0.0, 0.0, &[]).iter().all(|&v| v == 0), "range 0 still finds nothing on a flat image");
    let sharp = Focus::new(&halves(192, 96, 0.0), 192, 96);
    let mut edits = vec![128u8; 192 * 96];
    edits[10] = 0;
    assert_eq!(sharp.mask(0.0, 0.0, &edits)[10], 0);
}
