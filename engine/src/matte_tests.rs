use super::{downscale_rgba, upsample_mask};

fn disc(w: usize, h: usize, cx: f32, cy: f32, r: f32) -> Vec<u8> {
    let mut px = vec![0u8; w * h * 4];
    for y in 0..h {
        for x in 0..w {
            let inside = (x as f32 + 0.5 - cx).hypot(y as f32 + 0.5 - cy) < r;
            let c = if inside { [40, 30, 160] } else { [230, 225, 210] };
            px[(y * w + x) * 4..][..4].copy_from_slice(&[c[0], c[1], c[2], 255]);
        }
    }
    px
}

#[test]
fn downscale_averages_areas_over_the_matte() {
    // 4 x 2: left half red, right half transparent; the matte shows through the transparent half.
    let mut px = vec![0u8; 4 * 2 * 4];
    for y in 0..2 {
        for x in 0..2 {
            px[(y * 4 + x) * 4..][..4].copy_from_slice(&[255, 0, 0, 255]);
        }
    }
    let out = downscale_rgba(&px, 4, 2, [0, 0, 4, 2], 2, 1, 128);
    assert_eq!(out, vec![255, 0, 0, 255, 128, 128, 128, 255]);
    // A rect picks its own area; an upscale repeats pixels.
    let out = downscale_rgba(&px, 4, 2, [2, 0, 2, 2], 4, 4, 0);
    assert!(out.chunks(4).all(|c| c == [0, 0, 0, 255]));
}

#[test]
fn upsample_snaps_a_coarse_mask_to_the_full_size_edge_inside_the_rect() {
    let (w, h) = (400usize, 300usize);
    let full = disc(w, h, 200.0, 150.0, 90.0);
    // The model's view: the rect [100, 50, 200, 200] at 50 x 50, with a soft and slightly too large disc.
    let (mw, mh) = (50usize, 50usize);
    let mut mask = vec![0u8; mw * mh];
    for y in 0..mh {
        for x in 0..mw {
            let (dx, dy) = (100.0 + (x as f32 + 0.5) * 4.0, 50.0 + (y as f32 + 0.5) * 4.0);
            let d = (dx - 200.0).hypot(dy - 150.0) - 93.0;
            mask[y * mw + x] = (255.0 * (0.5 - d / 8.0).clamp(0.0, 1.0)) as u8;
        }
    }
    let cov = upsample_mask(&mask, mw, mh, &full, w, h, [100, 50, 200, 200]);
    assert_eq!(cov.len(), w * h);
    assert!(cov.iter().all(|v| (0.0..=1.0).contains(v)));
    let (mut inter, mut union) = (0f32, 0f32);
    for y in 0..h {
        for x in 0..w {
            let truth = (x as f32 + 0.5 - 200.0).hypot(y as f32 + 0.5 - 150.0) < 90.0;
            let v = cov[y * w + x];
            if !(100..300).contains(&x) || !(50..250).contains(&y) {
                assert_eq!(v, 0.0, "outside the rect at {x},{y}");
            }
            inter += if truth { v } else { 0.0 };
            union += if truth { 1.0 } else { v };
        }
    }
    let iou = inter / union;
    assert!(iou > 0.97, "IoU {iou}");
    // The edge follows the image (radius 90), not the mask (radius 93).
    assert!(cov[150 * w + 200 + 92] < 0.5, "outside the true edge: {}", cov[150 * w + 292]);
    assert!(cov[150 * w + 200 + 87] > 0.5, "inside the true edge: {}", cov[150 * w + 287]);
}

#[test]
fn upsample_keeps_soft_values_where_the_image_has_no_edge() {
    // A flat image: the mask's own soft ramp survives (hair, fur and blur edges stay partial).
    let (w, h) = (64usize, 8usize);
    let flat = vec![128u8; w * h * 4];
    let mask: Vec<u8> = (0..16).map(|x| (x * 17) as u8).collect();
    let cov = upsample_mask(&mask, 16, 1, &flat, w, h, [0, 0, 64, 8]);
    let row: Vec<f32> = (0..w).map(|x| cov[4 * w + x]).collect();
    assert!(row.windows(2).all(|p| p[1] >= p[0] - 1e-4), "monotone");
    assert!(row[32] > 0.3 && row[32] < 0.7, "middle stays soft: {}", row[32]);
}
