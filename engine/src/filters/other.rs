//! Other and Video groups (docs/M5.md sections 3 and 14). Neighborhood filters run on premultiplied
//! color; plane edges clamp (the runner reads the reach, so they never show).

use std::collections::VecDeque;

use super::blur::{gaussian_all, premultiplied};
use super::{Ctx, Filter, Plane};

pub fn two(_: &Filter) -> i32 {
    2
}

/// A 5x5 kernel over the color channels: `sum / scale + offset / 255`, alpha kept by the runner.
pub fn custom(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (k, scale, offset) = (f.kernel("kernel"), f.num("scale"), f.num("offset") as f32 / 255.0);
    if k.iter().enumerate().all(|(i, v)| *v == f32::from(i == 12)) && scale == 1.0 && offset == 0.0 {
        return Ok(());
    }
    let div = if scale == 0.0 { 1.0 } else { scale as f32 };
    premultiplied(p, |p| {
        let src = p.data.clone();
        let (w, h) = (p.w as isize, p.h as isize);
        for y in 0..h {
            for x in 0..w {
                for c in 0..3 {
                    let mut s = 0f32;
                    for dy in -2..=2isize {
                        for dx in -2..=2isize {
                            s += k[((dy + 2) * 5 + dx + 2) as usize] * src[(((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) * 4) as usize + c];
                        }
                    }
                    let i = ((y * w + x) * 4) as usize;
                    p.data[i + c] = s / div + offset * src[i + 3];
                }
            }
        }
    });
    Ok(())
}

fn hue_to_rgb(p: f32, q: f32, t: f32) -> f32 {
    let t = t.rem_euclid(1.0);
    if t < 1.0 / 6.0 {
        p + (q - p) * 6.0 * t
    } else if t < 0.5 {
        q
    } else if t < 2.0 / 3.0 {
        p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
        p
    }
}

// (h in 0..1, s, v or l) to rgb.
fn to_rgb(hsl: bool, [h, s, v]: [f32; 3]) -> [f32; 3] {
    if hsl {
        if s <= 0.0 {
            return [v; 3];
        }
        let q = if v < 0.5 { v * (1.0 + s) } else { v + s - v * s };
        let p = 2.0 * v - q;
        return [hue_to_rgb(p, q, h + 1.0 / 3.0), hue_to_rgb(p, q, h), hue_to_rgb(p, q, h - 1.0 / 3.0)];
    }
    let h = (h * 360.0).rem_euclid(360.0) / 60.0;
    let (i, f) = (h.floor(), h - h.floor());
    let (p, q, t) = (v * (1.0 - s), v * (1.0 - f * s), v * (1.0 - (1.0 - f) * s));
    match i as i32 % 6 {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

fn from_rgb(hsl: bool, [r, g, b]: [f32; 3]) -> [f32; 3] {
    let (max, min) = (r.max(g).max(b), r.min(g).min(b));
    let d = max - min;
    let h = if d == 0.0 {
        0.0
    } else if max == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if max == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    } / 6.0;
    if !hsl {
        return [h, if max <= 0.0 { 0.0 } else { d / max }, max];
    }
    let l = (max + min) / 2.0;
    [h, if d == 0.0 { 0.0 } else if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) }, l]
}

/// Reads the color channels as `input` (rgb, hsb or hsl) and writes them as `output`.
pub fn hsb_hsl(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (input, output) = (f.text("input"), f.text("output"));
    if input == output {
        return Ok(());
    }
    for px in p.data.chunks_exact_mut(4) {
        let rgb = if input == "rgb" { [px[0], px[1], px[2]] } else { to_rgb(input == "hsl", [px[0], px[1], px[2]]) };
        px[..3].copy_from_slice(&if output == "rgb" { rgb } else { from_rgb(output == "hsl", rgb) });
    }
    Ok(())
}

/// The plane minus its Gaussian blur, plus mid gray.
pub fn high_pass(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    premultiplied(p, |p| {
        let mut b = p.clone();
        gaussian_all(&mut b, f.num("radius") as f32);
        for (px, bl) in p.data.chunks_exact_mut(4).zip(b.data.chunks_exact(4)) {
            for c in 0..3 {
                px[c] = px[c] - bl[c] + 0.5 * px[3];
            }
        }
    });
    Ok(())
}

// The max (or min) over the window [i - r, i + r] of a line read through `at` (clamped), emitted to `put`.
fn slide(len: usize, r: usize, max: bool, at: impl Fn(usize) -> f32, mut put: impl FnMut(usize, f32)) {
    if len == 0 {
        return;
    }
    let mut q: VecDeque<(isize, f32)> = VecDeque::new();
    let worse = |a: f32, b: f32| if max { a <= b } else { a >= b };
    for k in -(r as isize)..(len + r) as isize {
        let v = at(k.clamp(0, len as isize - 1) as usize);
        while q.back().is_some_and(|b| worse(b.1, v)) {
            q.pop_back();
        }
        q.push_back((k, v));
        let x = k - r as isize;
        if x >= 0 {
            while q.front().is_some_and(|f| f.0 < x - r as isize) {
                q.pop_front();
            }
            put(x as usize, q[0].1);
        }
    }
}

// Separable extremum over all four channels.
fn square_extreme(p: &mut Plane, r: usize, max: bool) {
    let (w, h) = (p.w, p.h);
    for c in 0..4 {
        let src: Vec<f32> = p.data.iter().skip(c).step_by(4).copied().collect();
        let mut mid = src.clone();
        for y in 0..h {
            slide(w, r, max, |x| src[y * w + x], |x, v| mid[y * w + x] = v);
        }
        for x in 0..w {
            slide(h, r, max, |y| mid[y * w + x], |y, v| p.data[(y * w + x) * 4 + c] = v);
        }
    }
}

// The extremum over the disc dx^2 + dy^2 <= r^2 on the color channels. ponytail: O(r^2) per pixel, per-row windows beat it past r ~ 50.
fn round_extreme(p: &mut Plane, r: usize, max: bool) {
    let src = p.data.clone();
    let (w, h, r) = (p.w as isize, p.h as isize, r as isize);
    let spans: Vec<(isize, isize)> = (-r..=r).map(|dy| (dy, ((r * r - dy * dy) as f64).sqrt() as isize)).collect();
    for y in 0..h {
        for x in 0..w {
            for c in 0..3 {
                let mut e = if max { f32::MIN } else { f32::MAX };
                for &(dy, hw) in &spans {
                    let row = (y + dy).clamp(0, h - 1) * w;
                    for dx in -hw..=hw {
                        let v = src[((row + (x + dx).clamp(0, w - 1)) * 4) as usize + c];
                        e = if max { e.max(v) } else { e.min(v) };
                    }
                }
                p.data[((y * w + x) * 4) as usize + c] = e;
            }
        }
    }
}

fn extreme(p: &mut Plane, f: &Filter, max: bool) {
    let r = f.num("radius").round() as usize;
    let square = f.text("preserve") != "roundness";
    premultiplied(p, |p| if square { square_extreme(p, r, max) } else { round_extreme(p, r, max) });
}

pub fn maximum(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    extreme(p, f, true);
    Ok(())
}

pub fn minimum(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    extreme(p, f, false);
    Ok(())
}

/// Shifts the plane by (horizontal, vertical) whole px; uncovered areas wrap, repeat the edge or clear.
pub fn offset(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (dx, dy) = (f.num("horizontal").round() as i64, f.num("vertical").round() as i64);
    if dx == 0 && dy == 0 {
        return Ok(());
    }
    let (w, h, mode) = (p.w as i64, p.h as i64, f.text("undefinedAreas"));
    let src = p.data.clone();
    for y in 0..h {
        for x in 0..w {
            let (sx, sy) = (x - dx, y - dy);
            let (sx, sy) = match mode {
                "repeatEdgePixels" => (sx.clamp(0, w - 1), sy.clamp(0, h - 1)),
                "setToBackground" if !(0..w).contains(&sx) || !(0..h).contains(&sy) => {
                    p.data[((y * w + x) * 4) as usize..][..4].fill(0.0);
                    continue;
                }
                _ => (sx.rem_euclid(w), sy.rem_euclid(h)),
            };
            let at = ((sy * w + sx) * 4) as usize;
            p.data[((y * w + x) * 4) as usize..][..4].copy_from_slice(&src[at..at + 4]);
        }
    }
    Ok(())
}

/// Replaces the odd or even rows top to bottom by the row above, or the mean of the rows around it.
pub fn de_interlace(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (w, h) = (p.w, p.h);
    let (odd, mean) = (f.text("eliminate") != "evenFields", f.text("createNewFields") != "duplication");
    premultiplied(p, |p| {
        for y in (0..h).filter(|y| (y % 2 == 1) == odd) {
            for i in 0..w * 4 {
                let (up, down) = (y.checked_sub(1).map(|u| p.data[u * w * 4 + i]), (y + 1 < h).then(|| p.data[(y + 1) * w * 4 + i]));
                if let Some(v) = match (up, down) {
                    (Some(u), Some(d)) if mean => Some((u + d) / 2.0),
                    (Some(u), _) => Some(u),
                    (None, d) => d,
                } {
                    p.data[y * w * 4 + i] = v;
                }
            }
        }
    });
    Ok(())
}

/// Luma clamped to 16..235 (of 255); chroma scaled back until every channel fits the same range.
pub fn ntsc_colors(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    let (lo, hi) = (16.0 / 255.0, 235.0 / 255.0);
    for px in p.data.chunks_exact_mut(4) {
        let y = 0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2];
        let l = y.clamp(lo, hi);
        let mut c = 1f32;
        for v in &px[..3] {
            let u = l + (v - y);
            if u > hi {
                c = c.min((hi - l) / (u - l));
            }
            if u < lo {
                c = c.min((l - lo) / (l - u));
            }
        }
        for v in &mut px[..3] {
            *v = l + (*v - y) * c;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{apply, Ctx, Filter, Plane};
    use serde_json::json;
    use std::collections::HashMap;

    fn run(params: serde_json::Value, p: &mut Plane) {
        let f = Filter::parse(&json!({ "kind": "other.hsb_hsl", "params": params }).to_string()).unwrap();
        let blobs = HashMap::new();
        apply(&f, p, &Ctx { blobs: &blobs, cov: None, bounds: [0, 0, p.w as i32, p.h as i32], scale: 1.0, mask: None }).unwrap();
    }

    #[test]
    fn hsb_and_hsl_round_trip_within_one_8_bit_step() {
        let data: Vec<f32> = (0..16 * 16).flat_map(|i| [(i % 16) as f32 / 15.0, (i / 16) as f32 / 15.0, ((i * 7) % 16) as f32 / 15.0, 1.0]).collect();
        for mid in ["hsb", "hsl"] {
            let mut p = Plane { x: 0, y: 0, w: 16, h: 16, data: data.clone() };
            run(json!({ "input": "rgb", "output": mid }), &mut p);
            assert_ne!(p.data, data, "{mid} changes the channels");
            run(json!({ "input": mid, "output": "rgb" }), &mut p);
            assert!(p.data.iter().zip(&data).all(|(a, b)| (a - b).abs() <= 1.0 / 255.0), "{mid}");
        }
    }
}
