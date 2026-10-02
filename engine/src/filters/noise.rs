//! Noise group (docs/M5.md sections 3 and 14). Straight RGBA; Median also filters alpha, the others
//! change color only. Plane edges clamp (the runner reads the reach, so they never show).

use super::blur::{edges, gauss_reach};
use super::sharpen::mix_toward;
use super::{gauss, hash, Ctx, Filter, Plane};
use crate::styles;

/// Per pixel and channel `amount x (u - 0.5)` (uniform) or `amount x 0.4 x g` (gaussian), one
/// value for all channels when monochromatic.
pub fn add_noise(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (amount, gaussian, mono, seed) = (f.num("amount") as f32 / 100.0, f.text("distribution") == "gaussian", f.flag("monochromatic"), f.num("seed") as u32);
    for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
        let (x, y) = (p.x + (i % p.w) as i32, p.y + (i / p.w) as i32);
        let rnd = |c: u32| if gaussian { gauss(seed, x, y, c) * 0.4 } else { hash(seed, x, y, c) - 0.5 };
        let base = rnd(0);
        for (c, v) in px[..3].iter_mut().enumerate() {
            *v += if mono { base } else { rnd(c as u32 + 1) } * amount;
        }
    }
    Ok(())
}

pub fn radius_reach(f: &Filter) -> i32 {
    f.num("radius").round() as i32
}

const BINS: usize = 4096;

// The median over a (2r+1)^2 square per channel, edges clamped. Radii up to 2 sort exactly; larger
// ones slide a histogram along each row (values quantized to 1/4095, below 8-bit precision).
pub(super) fn median(p: &Plane, r: usize) -> Vec<f32> {
    let (w, h, r) = (p.w as isize, p.h as isize, r as isize);
    let at = |x: isize, y: isize, c: usize| p.data[((y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) * 4) as usize + c];
    let mut out = vec![0f32; p.data.len()];
    let half = ((2 * r + 1) * (2 * r + 1) / 2) as u32;
    let mut win = Vec::new();
    for c in 0..4 {
        for y in 0..h {
            if r <= 2 {
                for x in 0..w {
                    win.clear();
                    win.extend((-r..=r).flat_map(|dy| (-r..=r).map(move |dx| (dx, dy))).map(|(dx, dy)| at(x + dx, y + dy, c)));
                    out[((y * w + x) * 4) as usize + c] = *win.select_nth_unstable_by(half as usize, f32::total_cmp).1;
                }
                continue;
            }
            let q = |v: f32| (v.clamp(0.0, 1.0) * (BINS - 1) as f32).round() as usize;
            let mut hist = vec![0u32; BINS];
            for dy in -r..=r {
                for dx in -r..=r {
                    hist[q(at(dx, y + dy, c))] += 1;
                }
            }
            // `m` is the median bin and `lt` the count below it: lt <= half < lt + hist[m].
            let (mut m, mut lt) = (0usize, 0u32);
            for x in 0..w {
                if x > 0 {
                    for dy in -r..=r {
                        let old = q(at(x - r - 1, y + dy, c));
                        hist[old] -= 1;
                        lt -= (old < m) as u32;
                        let new = q(at(x + r, y + dy, c));
                        hist[new] += 1;
                        lt += (new < m) as u32;
                    }
                }
                while lt > half {
                    m -= 1;
                    lt -= hist[m];
                }
                while lt + hist[m] <= half {
                    lt += hist[m];
                    m += 1;
                }
                out[((y * w + x) * 4) as usize + c] = m as f32 / (BINS - 1) as f32;
            }
        }
    }
    out
}

pub fn median_filter(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    p.data = median(p, f.num("radius").round() as usize);
    Ok(())
}

/// The 1 px median, kept off edges (weight 1 - 4 x the Sobel strength).
pub fn despeckle(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    let (m, e) = (median(p, 1), edges(p));
    mix_toward(p, &m, |i| 1.0 - (e[i] * 4.0).clamp(0.0, 1.0));
    Ok(())
}

/// Colors farther than the threshold from the radius median become the median.
pub fn dust_and_scratches(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (m, thr) = (median(p, f.num("radius").round() as usize), f.num("threshold") as f32 / 255.0);
    for (px, m) in p.data.chunks_exact_mut(4).zip(m.chunks_exact(4)) {
        for c in 0..3 {
            if (m[c] - px[c]).abs() > thr {
                px[c] = m[c];
            }
        }
    }
    Ok(())
}

fn levels(f: &Filter) -> u32 {
    if f.flag("removeJpegArtifact") {
        4
    } else {
        3
    }
}

fn channel_pass(f: &Filter) -> bool {
    ["redStrength", "greenStrength", "blueStrength"].iter().any(|k| f.num(k) > 0.0)
}

pub fn reduce_reach(f: &Filter) -> i32 {
    let one: i32 = (1..=levels(f)).map(|l| gauss_reach((1 << l) as f32)).sum();
    one * if channel_pass(f) { 2 } else { 1 }
}

// Wavelet shrink: detail bands from gaussians of 2, 4, 8 (16) px, each soft-thresholded by
// strength x 0.004 x (0.5 + preserve / 2)^level, the finest band gained by 1 + 2 x sharpen.
fn shrink(v: &mut [f32], w: usize, h: usize, strength: f32, preserve: f32, sharpen: f32, levels: u32) {
    if strength <= 0.0 && sharpen <= 0.0 {
        return;
    }
    let mut rest = styles::Plane { w, h, v: v.to_vec() };
    let mut bands = Vec::new();
    for l in 0..levels {
        let low = styles::gaussian(&rest, (2u32 << l) as f32);
        bands.push(rest.v.iter().zip(&low.v).map(|(a, b)| a - b).collect::<Vec<f32>>());
        rest = low;
    }
    v.copy_from_slice(&rest.v);
    for (l, band) in bands.into_iter().enumerate() {
        let t = strength * 0.004 * (0.5 + preserve * 0.5).powi(l as i32);
        let gain = if l == 0 { 1.0 + sharpen * 2.0 } else { 1.0 };
        for (o, d) in v.iter_mut().zip(band) {
            *o += (if d > t { d - t } else if d < -t { d + t } else { 0.0 }) * gain;
        }
    }
}

/// Luminance and two color differences shrunk (color by strength + 10 x color noise, half the
/// preserve), then each color channel by its own strength.
pub fn reduce_noise(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (w, h, n) = (p.w, p.h, levels(f));
    let pct = |k: &str| (f.num(k) / 100.0) as f32;
    let (strength, preserve, sharpen, color) = (f.num("strength") as f32, pct("preserveDetails"), pct("sharpenDetails"), pct("reduceColorNoise"));
    let lum = |px: &[f32]| 0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2];
    let mut y: Vec<f32> = p.data.chunks_exact(4).map(lum).collect();
    let mut cb: Vec<f32> = p.data.chunks_exact(4).zip(&y).map(|(px, l)| px[2] - l).collect();
    let mut cr: Vec<f32> = p.data.chunks_exact(4).zip(&y).map(|(px, l)| px[0] - l).collect();
    shrink(&mut y, w, h, strength, preserve, sharpen, n);
    shrink(&mut cb, w, h, strength + color * 10.0, preserve * 0.5, 0.0, n);
    shrink(&mut cr, w, h, strength + color * 10.0, preserve * 0.5, 0.0, n);
    for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
        let (r, b) = (y[i] + cr[i], y[i] + cb[i]);
        px[0] = r;
        px[1] = (y[i] - 0.3 * r - 0.11 * b) / 0.59;
        px[2] = b;
    }
    for (c, k) in ["redStrength", "greenStrength", "blueStrength"].into_iter().enumerate() {
        let s = f.num(k) as f32;
        if s <= 0.0 {
            continue;
        }
        let mut v: Vec<f32> = p.data.iter().skip(c).step_by(4).copied().collect();
        shrink(&mut v, w, h, s, preserve, 0.0, n);
        for (i, v) in v.into_iter().enumerate() {
            p.data[i * 4 + c] = v;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{apply, Ctx, Filter, Plane};
    use serde_json::{json, Value};
    use std::collections::HashMap;

    fn run(kind: &str, params: Value, p: &mut Plane) {
        let f = Filter::parse(&json!({ "kind": kind, "params": params }).to_string()).unwrap();
        let blobs = HashMap::new();
        apply(&f, p, &Ctx { blobs: &blobs, cov: None, bounds: [0, 0, p.w as i32, p.h as i32], scale: 1.0, mask: None }).unwrap();
    }

    // w x h gray plane at `bg` with `fg` at (cx, cy).
    fn spot(w: usize, h: usize, bg: f32, fg: f32) -> Plane {
        let mut data = vec![bg; w * h * 4];
        let c = (h / 2 * w + w / 2) * 4;
        data[c..c + 3].fill(fg);
        data.chunks_exact_mut(4).for_each(|px| px[3] = 1.0);
        Plane { x: 0, y: 0, w, h, data }
    }

    fn noisy() -> Plane {
        let data = (0..16 * 12).flat_map(|i| [((i * 37) % 97) as f32 / 97.0, ((i * 11) % 89) as f32 / 89.0, ((i * 53) % 83) as f32 / 83.0, 1.0]).collect();
        Plane { x: 3, y: -5, w: 16, h: 12, data }
    }

    #[test]
    fn median_removes_a_one_pixel_spike_at_every_radius_path() {
        for r in [1, 3] {
            let mut p = spot(9, 9, 0.0, 1.0);
            run("noise.median", json!({ "radius": r }), &mut p);
            assert!(p.data.chunks_exact(4).all(|px| px[..3] == [0.0; 3] && px[3] == 1.0), "radius {r}");
        }
    }

    #[test]
    fn histogram_median_matches_the_exact_one_in_8_bits() {
        let p = noisy();
        // Radius 3 is the histogram path; compare it to a sorted radius-3 median.
        let fast = super::median(&p, 3);
        let (w, h) = (p.w as isize, p.h as isize);
        for y in 0..h {
            for x in 0..w {
                for c in 0..4 {
                    let mut win: Vec<f32> = (-3..=3isize).flat_map(|dy| (-3..=3isize).map(move |dx| (dx, dy))).map(|(dx, dy)| p.data[(((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) * 4) as usize + c]).collect();
                    win.sort_by(f32::total_cmp);
                    let i = ((y * w + x) * 4) as usize + c;
                    assert!((fast[i] - win[24]).abs() < 0.5 / 255.0, "{x},{y},{c}");
                }
            }
        }
    }

    #[test]
    fn dust_and_scratches_radius_1_threshold_0_removes_a_spike() {
        let mut p = spot(5, 5, 0.2, 0.9);
        run("noise.dust_and_scratches", json!({ "radius": 1, "threshold": 0 }), &mut p);
        assert!(p.data.chunks_exact(4).all(|px| (px[0] - 0.2).abs() < 1e-6));
        let mut p = spot(5, 5, 0.2, 0.9);
        run("noise.dust_and_scratches", json!({ "radius": 1, "threshold": 255 }), &mut p);
        assert_eq!(p, spot(5, 5, 0.2, 0.9), "a spike within the threshold stays");
    }

    #[test]
    fn despeckle_smooths_flat_noise_but_keeps_a_hard_edge() {
        let mut p = spot(5, 5, 0.5, 0.52);
        run("noise.despeckle", json!({}), &mut p);
        assert!(p.data[12 * 4] < 0.52, "a faint speck moves toward the median");
        let edge = Plane { x: 0, y: 0, w: 4, h: 3, data: (0..12).flat_map(|i| if i % 4 < 2 { [0.0, 0.0, 0.0, 1.0] } else { [1.0, 1.0, 1.0, 1.0] }).collect() };
        let mut p = edge.clone();
        run("noise.despeckle", json!({}), &mut p);
        assert_eq!(p, edge);
    }

    #[test]
    fn add_noise_is_seeded_positional_and_keeps_alpha() {
        for (dist, mono) in [("uniform", false), ("gaussian", false), ("uniform", true)] {
            let params = json!({ "amount": 50, "distribution": dist, "monochromatic": mono, "seed": 7 });
            let (mut a, mut b) = (noisy(), noisy());
            run("noise.add_noise", params.clone(), &mut a);
            run("noise.add_noise", params.clone(), &mut b);
            assert_eq!(a, b, "same seed twice");
            // Rows 4.. of the plane alone equal the same rows of the whole plane.
            let mut part = noisy();
            part.data.drain(..4 * 16 * 4);
            (part.y, part.h) = (part.y + 4, 8);
            run("noise.add_noise", params, &mut part);
            assert_eq!(part.data, a.data[4 * 16 * 4..], "tile equals whole");
            assert!(a.data.chunks_exact(4).all(|px| px[3] == 1.0), "alpha unchanged");
            let d: Vec<[f32; 3]> = a.data.chunks_exact(4).zip(noisy().data.chunks_exact(4)).map(|(n, o)| [n[0] - o[0], n[1] - o[1], n[2] - o[2]]).collect();
            assert_eq!(d.iter().all(|d| (d[0] - d[1]).abs() < 1e-6 && (d[1] - d[2]).abs() < 1e-6), mono, "{dist} mono {mono}");
        }
    }

    #[test]
    fn reduce_noise_flattens_small_noise_and_zero_strength_is_identity() {
        let mut p = noisy();
        run("noise.reduce_noise", json!({ "strength": 0, "reduceColorNoise": 0, "sharpenDetails": 0 }), &mut p);
        assert!(p.data.iter().zip(noisy().data.iter()).all(|(a, b)| (a - b).abs() < 1e-5));
        let spread = |p: &Plane| {
            let g: Vec<f32> = p.data.chunks_exact(4).map(|px| px[1]).collect();
            g.iter().map(|v| (v - 0.5).abs()).sum::<f32>()
        };
        let mut p = noisy();
        run("noise.reduce_noise", json!({ "strength": 10, "preserveDetails": 0, "greenStrength": 10 }), &mut p);
        assert!(spread(&p) < spread(&noisy()) * 0.8, "noise shrinks");
    }
}
