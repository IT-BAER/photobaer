//! Sharpen group (docs/M5.md sections 3 and 14). Color channels only on straight RGBA, alpha kept;
//! plane edges clamp (the runner reads the reach, so they never show).

use super::blur::{bokeh, edges, gauss_reach, gaussian_all, iris, motion_all, motion_span};
use super::{Ctx, Filter, Plane};
use crate::styles;

const SHARPEN: [f32; 9] = [0.0, -1.0, 0.0, -1.0, 5.0, -1.0, 0.0, -1.0, 0.0];
const MORE: [f32; 9] = [-1.0, -1.0, -1.0, -1.0, 9.0, -1.0, -1.0, -1.0, -1.0];

pub fn one(_: &Filter) -> i32 {
    1
}

// A 3x3 kernel over the color channels, edges clamped.
fn convolve3(p: &mut Plane, k: &[f32; 9]) {
    let src = p.data.clone();
    let (w, h) = (p.w as isize, p.h as isize);
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let mut s = 0f32;
                for dy in -1..=1isize {
                    for dx in -1..=1isize {
                        let kv = k[((dy + 1) * 3 + dx + 1) as usize];
                        if kv != 0.0 {
                            s += kv * src[(((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) * 4) as usize + c];
                        }
                    }
                }
                p.data[((y * w + x) * 4) as usize + c] = s;
            }
        }
    }
}

// Moves each pixel's color toward `target` by `wgt(i)`.
pub(super) fn mix_toward(p: &mut Plane, target: &[f32], wgt: impl Fn(usize) -> f32) {
    for (i, (px, t)) in p.data.chunks_exact_mut(4).zip(target.chunks_exact(4)).enumerate() {
        let a = wgt(i);
        if a > 0.0 {
            for c in 0..3 {
                px[c] += (t[c] - px[c]) * a;
            }
        }
    }
}

pub fn sharpen(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    convolve3(p, &SHARPEN);
    Ok(())
}

pub fn sharpen_more(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    convolve3(p, &MORE);
    Ok(())
}

/// Sharpen weighted by 3 x the Sobel edge strength (clamped to 1).
pub fn sharpen_edges(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    let mut t = p.clone();
    convolve3(&mut t, &SHARPEN);
    let e = edges(p);
    mix_toward(p, &t.data, |i| (e[i] * 3.0).clamp(0.0, 1.0));
    Ok(())
}

pub fn unsharp_reach(f: &Filter) -> i32 {
    gauss_reach(f.num("radius") as f32)
}

/// `x + amount x (x - gaussian(x, radius))` where `|x - blur|` reaches the threshold.
pub fn unsharp(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (amount, thr) = (f.num("amount") as f32 / 100.0, f.num("threshold") as f32 / 255.0);
    let mut b = p.clone();
    gaussian_all(&mut b, f.num("radius") as f32);
    for (px, bl) in p.data.chunks_exact_mut(4).zip(b.data.chunks_exact(4)) {
        for c in 0..3 {
            let d = px[c] - bl[c];
            if d.abs() >= thr {
                px[c] += d * amount;
            }
        }
    }
    Ok(())
}

fn fades(f: &Filter) -> bool {
    f.num("fadeAmountShadow") > 0.0 || f.num("fadeAmountHighlight") > 0.0
}

pub fn smart_reach(f: &Filter) -> i32 {
    let r = f.num("radius");
    let blur = match f.text("remove") {
        "lensBlur" => r.max(1.0).round() as i32,
        "motionBlur" => motion_span((r * 2.0).max(2.0)),
        _ => gauss_reach(r as f32),
    };
    if !fades(f) {
        return blur;
    }
    let tone = |k: &str| gauss_reach(f.num(k).max(1.0) as f32);
    blur.max(tone("radiusShadow")).max(tone("radiusHighlight"))
}

// The share of the amount kept at tone `v`: full outside the tonal width, down to 1 - fade at the
// darkest (shadow) or brightest (highlight) end.
fn fade(v: f32, amount: f32, width: f32, shadow: bool) -> f32 {
    if amount <= 0.0 {
        return 1.0;
    }
    let o = if shadow { v } else { 1.0 - v };
    1.0 - amount * (1.0 - o / width.max(0.01)).clamp(0.0, 1.0)
}

/// Unsharp against the chosen blur (Gaussian, a round lens disc, or motion over twice the radius),
/// differences within the noise floor dropped, the amount faded in shadows and highlights by the
/// blurred luminance.
pub fn smart_sharpen(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let r = f.num("radius");
    let mut b = p.clone();
    match f.text("remove") {
        "lensBlur" => {
            let a = r.max(1.0) as f32;
            bokeh(&mut b, &vec![a; p.w * p.h], a, |a| iris(a, 12.0, 0.0, 1.0));
        }
        "motionBlur" => motion_all(&mut b, (r * 2.0).max(2.0), f.num("angle")),
        _ => gaussian_all(&mut b, r as f32),
    }
    let pct = |k: &str| (f.num(k) / 100.0) as f32;
    let (amount, floor) = (pct("amount"), pct("reduceNoise") * 0.05);
    let tone = |k: &str| {
        let l = styles::Plane { w: p.w, h: p.h, v: p.data.chunks_exact(4).map(|px| 0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2]).collect() };
        styles::gaussian(&l, f.num(k).max(1.0) as f32).v
    };
    let tones = fades(f).then(|| (tone("radiusShadow"), tone("radiusHighlight")));
    for (i, (px, bl)) in p.data.chunks_exact_mut(4).zip(b.data.chunks_exact(4)).enumerate() {
        let k = match &tones {
            Some((s, h)) => amount * fade(s[i], pct("fadeAmountShadow"), pct("tonalWidthShadow"), true) * fade(h[i], pct("fadeAmountHighlight"), pct("tonalWidthHighlight"), false),
            None => amount,
        };
        for c in 0..3 {
            let d = px[c] - bl[c];
            if d.abs() > floor {
                px[c] += (d - floor.copysign(d)) * k;
            }
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

    // 5x5 gray plane at `bg` with `fg` at the center.
    fn spot(bg: f32, fg: f32) -> Plane {
        let mut data = vec![bg; 5 * 5 * 4];
        data[12 * 4..12 * 4 + 3].fill(fg);
        data.chunks_exact_mut(4).for_each(|px| px[3] = 1.0);
        Plane { x: 0, y: 0, w: 5, h: 5, data }
    }

    // Red at (x, y) as the runner stores it in 8 bits.
    fn v(p: &Plane, x: usize, y: usize) -> u8 {
        (p.data[(y * p.w + x) * 4].clamp(0.0, 1.0) * 255.0).round() as u8
    }

    #[test]
    fn sharpen_is_the_cross_kernel_and_sharpen_more_the_full_one() {
        let (fg, bg) = (100.0 / 255.0, 50.0 / 255.0);
        let mut p = spot(bg, fg);
        run("sharpen.sharpen", json!({}), &mut p);
        assert_eq!((v(&p, 2, 2), v(&p, 1, 2), v(&p, 1, 1)), (255, 0, 50), "center 255, 4-neighbors 0, diagonal kept");
        let mut p = spot(bg, fg);
        run("sharpen.sharpen_more", json!({}), &mut p);
        assert_eq!((v(&p, 2, 2), v(&p, 1, 2), v(&p, 1, 1)), (255, 0, 0), "center 255, 8-neighbors 0");
    }

    #[test]
    fn flat_input_is_unchanged_by_every_sharpen() {
        for (kind, params) in [
            ("sharpen.sharpen", json!({})),
            ("sharpen.sharpen_more", json!({})),
            ("sharpen.sharpen_edges", json!({})),
            ("sharpen.unsharp_mask", json!({ "amount": 500, "radius": 3 })),
            ("sharpen.smart_sharpen", json!({ "amount": 500, "remove": "gaussianBlur", "fadeAmountShadow": 50 })),
            ("sharpen.smart_sharpen", json!({ "remove": "lensBlur" })),
            ("sharpen.smart_sharpen", json!({ "remove": "motionBlur", "angle": 30 })),
        ] {
            let mut p = spot(0.4, 0.4);
            run(kind, params, &mut p);
            assert!(p.data.chunks_exact(4).all(|px| (px[0] - 0.4).abs() < 1e-5 && px[3] == 1.0), "{kind}");
        }
    }

    #[test]
    fn unsharp_threshold_255_is_identity_and_0_sharpens() {
        let mut p = spot(0.2, 0.8);
        run("sharpen.unsharp_mask", json!({ "amount": 500, "radius": 1, "threshold": 255 }), &mut p);
        assert_eq!(p, spot(0.2, 0.8));
        run("sharpen.unsharp_mask", json!({ "amount": 100, "radius": 1 }), &mut p);
        assert!(v(&p, 2, 2) > 204 && v(&p, 1, 2) < 51, "center up, neighbors down: {} {}", v(&p, 2, 2), v(&p, 1, 2));
    }

    #[test]
    fn smart_sharpen_drops_differences_under_the_noise_floor_and_fades_shadows() {
        // A 1/255 step stays under the 20 % noise floor (0.01).
        let mut p = spot(0.5, 0.5 + 1.0 / 255.0);
        let before = p.clone();
        run("sharpen.smart_sharpen", json!({ "remove": "gaussianBlur" }), &mut p);
        assert_eq!(p, before);
        let dark = |fade: f64| {
            let mut p = spot(0.05, 0.1);
            run("sharpen.smart_sharpen", json!({ "remove": "gaussianBlur", "radius": 3, "reduceNoise": 0, "fadeAmountShadow": fade }), &mut p);
            v(&p, 2, 2)
        };
        assert!(dark(100.0) < dark(0.0), "a full shadow fade sharpens dark areas less: {} vs {}", dark(100.0), dark(0.0));
    }
}
