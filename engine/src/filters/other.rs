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

/// Camera Raw Filter: white balance, exposure, contrast, tone ranges by luminance weight, vibrance,
/// saturation and a vignette over the layer bounds, all sliders at 0 are a no-op.
pub fn camera_raw(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let n = |k| f.num(k) as f32;
    let (temp, tint, sat, vib, vig) = (n("temperature"), n("tint"), n("saturation"), n("vibrance"), n("vignette"));
    let (gain, contrast) = (n("exposure").exp2(), (n("contrast") / 100.0).exp2());
    let (sh, hi, bl, wh) = (n("shadows"), n("highlights"), n("blacks"), n("whites"));
    if [temp, tint, sat, vib, vig, n("exposure"), n("contrast"), sh, hi, bl, wh].iter().all(|v| *v == 0.0) {
        return Ok(());
    }
    let wb = [(temp + tint / 2.0) / 200.0, -tint / 200.0, (-temp + tint / 2.0) / 200.0].map(f32::exp2);
    let fr = super::render::Frame::of(ctx);
    let luma = |c: &[f32]| c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
    for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
        let l = (luma(px) * gain).clamp(0.0, 1.0);
        let (lo, up) = ((1.0 - l).powi(2), l * l);
        let tone = (sh * lo + hi * up + bl * lo * lo + wh * up * up) / 400.0;
        for c in 0..3 {
            px[c] = (((px[c] * gain * wb[c] - 0.5) * contrast + 0.5 + tone)).clamp(0.0, 1.0);
        }
        let l = luma(px);
        let spread = px[0].max(px[1]).max(px[2]) - px[0].min(px[1]).min(px[2]);
        let m = (1.0 + sat / 100.0) * (1.0 + vib / 100.0 * (1.0 - spread));
        for c in 0..3 {
            px[c] = (l + (px[c] - l) * m).clamp(0.0, 1.0);
        }
        if vig != 0.0 {
            let x = 2.0 * ((p.x as f64 + (i % p.w) as f64 + 0.5 - fr.x) / fr.w.max(1.0)) - 1.0;
            let y = 2.0 * ((p.y as f64 + (i / p.w) as f64 + 0.5 - fr.y) / fr.h.max(1.0)) - 1.0;
            let v = vig / 100.0 * (((x * x + y * y) / 2.0) as f32).clamp(0.0, 1.0);
            for c in &mut px[..3] {
                *c = if v < 0.0 { *c * (1.0 + v) } else { *c + (1.0 - *c) * v };
            }
        }
    }
    Ok(())
}

// Radial distortion factor 1 + k1 r^2 + k2 r^4 + k3 r^6.
fn lens_r(k: [f64; 3], r: f64) -> f64 {
    let e = r * r;
    r * (1.0 + k[0] * e + k[1] * e * e + k[2] * e * e * e)
}

/// Lens Correction: radial distortion, per-channel fringe scale, vignette, perspective, rotation and
/// scale about the plane center; each output px samples the source bilinearly.
pub fn lens_correction(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let n = |k| f.num(k);
    let k = [n("removeDistortion") / 100.0, n("k2") / 400.0, n("k3") / 1600.0];
    let (rc, gm, by) = (n("chromaticRedCyan"), n("chromaticGreenMagenta"), n("chromaticBlueYellow"));
    let (vp, hp, angle, vig) = (n("verticalPerspective") / 200.0, n("horizontalPerspective") / 200.0, n("angle").to_radians(), n("vignetteAmount") / 100.0);
    if k == [0.0; 3] && rc == 0.0 && gm == 0.0 && by == 0.0 && vig == 0.0 && vp == 0.0 && hp == 0.0 && angle == 0.0 && n("scale") == 100.0 {
        return Ok(());
    }
    let fringe = [1.0 + rc / 2000.0 + gm / 4000.0, 1.0 - gm / 2000.0, 1.0 + by / 2000.0 - gm / 4000.0];
    let mut scale = (n("scale") / 100.0).max(0.01);
    if f.flag("autoScale") && lens_r(k, 1.0) > 1.0 {
        // The smallest zoom whose corner maps inside the source.
        let (mut lo, mut hi) = (1.0, 4.0);
        for _ in 0..40 {
            let mid = (lo + hi) / 2.0;
            if lens_r(k, 1.0 / mid) <= 1.0 { hi = mid } else { lo = mid }
        }
        scale *= hi;
    }
    let mid = (n("vignetteMidpoint").clamp(0.0, 100.0)) / 100.0;
    let mode = f.text("edgeMode");
    let fill = if mode == "white" { 1.0 } else { 0.0 };
    let (w, h) = (p.w, p.h);
    let (cx, cy) = ((w as f64 - 1.0) / 2.0, (h as f64 - 1.0) / 2.0);
    let diag = cx.hypot(cy).max(1.0);
    let (cos, sin) = (angle.cos(), angle.sin());
    let src = p.data.clone();
    let sample = |x: f64, y: f64, c: usize| -> Option<f32> {
        if mode != "edgeExtension" && (x < -0.5 || y < -0.5 || x > w as f64 - 0.5 || y > h as f64 - 0.5) {
            return None;
        }
        let (x, y) = (x.clamp(0.0, w as f64 - 1.0), y.clamp(0.0, h as f64 - 1.0));
        let (x0, y0) = (x.floor() as usize, y.floor() as usize);
        let (x1, y1, fx, fy) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1), (x - x0 as f64) as f32, (y - y0 as f64) as f32);
        let at = |x: usize, y: usize| src[(y * w + x) * 4 + c];
        let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
        let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
        Some(top + (bot - top) * fy)
    };
    for py in 0..h {
        for px in 0..w {
            let (bx, by_) = ((px as f64 - cx) / diag / scale, (py as f64 - cy) / diag / scale);
            let (rx, ry) = (bx * cos + by_ * sin, -bx * sin + by_ * cos);
            let d = 1.0 + vp * ry + hp * rx;
            let inv = if d.abs() < 1e-6 { 0.0 } else { 1.0 / d };
            let (u, v) = (rx * inv, ry * inv);
            let r = u.hypot(v);
            let z = if r == 0.0 { 1.0 } else { lens_r(k, r) / r };
            let o = (py * w + px) * 4;
            for c in 0..3 {
                p.data[o + c] = sample(cx + u * z * fringe[c] * diag, cy + v * z * fringe[c] * diag, c).unwrap_or(fill);
            }
            p.data[o + 3] = sample(cx + u * z * diag, cy + v * z * diag, 3).unwrap_or(if mode == "transparency" { 0.0 } else { 1.0 });
            if vig != 0.0 {
                let t = ((r - mid) / (1.0 - mid).max(0.001)).max(0.0);
                let g = (1.0 + vig * t * t) as f32;
                for c in &mut p.data[o..o + 3] {
                    *c = (*c * g).clamp(0.0, 1.0);
                }
            }
        }
    }
    Ok(())
}

// Source radius over output radius for a projection model; `fov` is the half angle of the diagonal.
fn wide_angle_k(model: &str, r: f64, fov: f64) -> f64 {
    if r == 0.0 {
        return 1.0;
    }
    let fish = (r * fov.tan()).atan() / fov.max(1e-6) / r;
    match model {
        "fisheye" => fish,
        "fullSpherical" => (r * fov).min(std::f64::consts::FRAC_PI_2 - 0.001).tan() / fov.tan().max(1e-6) / r,
        "perspective" => 1.0,
        _ => fish * 0.5 + 0.5,
    }
}

/// Adaptive Wide Angle: remaps the plane through a fisheye, spherical or perspective model from the
/// focal length and crop factor; outside the source is transparent.
pub fn adaptive_wide_angle(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let model = f.text("correction");
    let scale = (f.num("scale") / 100.0).max(0.01);
    if model == "perspective" && scale == 1.0 {
        return Ok(());
    }
    let fov = (21.63 / (f.num("focalLength") * f.num("cropFactor").max(0.01)).max(1.0)).atan();
    let (w, h) = (p.w, p.h);
    let (cx, cy) = ((w as f64 - 1.0) / 2.0, (h as f64 - 1.0) / 2.0);
    let diag = cx.hypot(cy).max(1.0);
    let src = p.data.clone();
    for py in 0..h {
        for px in 0..w {
            let (u, v) = ((px as f64 - cx) / (diag * scale), (py as f64 - cy) / (diag * scale));
            let k = wide_angle_k(model, u.hypot(v), fov);
            let (x, y) = (cx + u * k * diag, cy + v * k * diag);
            let o = (py * w + px) * 4;
            if x < -0.5 || y < -0.5 || x > w as f64 - 0.5 || y > h as f64 - 0.5 {
                p.data[o..o + 4].fill(0.0);
                continue;
            }
            let (x, y) = (x.clamp(0.0, w as f64 - 1.0), y.clamp(0.0, h as f64 - 1.0));
            let (x0, y0) = (x.floor() as usize, y.floor() as usize);
            let (x1, y1, fx, fy) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1), (x - x0 as f64) as f32, (y - y0 as f64) as f32);
            for c in 0..4 {
                let at = |x: usize, y: usize| src[(y * w + x) * 4 + c];
                let top = at(x0, y0) + (at(x1, y0) - at(x0, y0)) * fx;
                let bot = at(x0, y1) + (at(x1, y1) - at(x0, y1)) * fx;
                p.data[o + c] = top + (bot - top) * fy;
            }
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

    fn camera_raw(params: serde_json::Value, p: &mut Plane) {
        let f = Filter::parse(&json!({ "kind": "tool.camera_raw", "params": params }).to_string()).unwrap();
        let blobs = HashMap::new();
        apply(&f, p, &Ctx { blobs: &blobs, cov: None, bounds: [0, 0, p.w as i32, p.h as i32], scale: 1.0, mask: None }).unwrap();
    }

    #[test]
    fn camera_raw_exposure_temperature_and_vignette() {
        let gray = |w: usize, h: usize, v: f32| Plane { x: 0, y: 0, w, h, data: [v, v, v, 1.0].repeat(w * h) };
        let mut p = gray(1, 1, 0.2);
        camera_raw(json!({}), &mut p);
        assert_eq!(p.data, [0.2, 0.2, 0.2, 1.0], "neutral params change nothing");
        camera_raw(json!({ "exposure": 1.0 }), &mut p);
        assert!(p.data[..3].iter().all(|v| (v - 0.4).abs() < 1e-5), "+1 EV doubles: {:?}", p.data);
        let mut p = gray(1, 1, 0.5);
        camera_raw(json!({ "temperature": 50 }), &mut p);
        assert!(p.data[0] > 0.5 && p.data[2] < 0.5, "warmer: {:?}", p.data);
        let mut p = gray(9, 9, 0.5);
        camera_raw(json!({ "vignette": -100 }), &mut p);
        let (center, corner) = (p.data[(4 * 9 + 4) * 4], p.data[0]);
        assert!(center > 0.49 && corner < 0.3, "center {center} corner {corner}");
    }

    fn run_kind(kind: &str, params: serde_json::Value, p: &mut Plane) {
        let f = Filter::parse(&json!({ "kind": kind, "params": params }).to_string()).unwrap();
        let blobs = HashMap::new();
        apply(&f, p, &Ctx { blobs: &blobs, cov: None, bounds: [0, 0, p.w as i32, p.h as i32], scale: 1.0, mask: None }).unwrap();
    }

    #[test]
    fn lens_correction_rotates_vignettes_and_fills_edges() {
        let ramp: Vec<f32> = (0..9).flat_map(|i| [i as f32 / 8.0, 0.5, 0.5, 1.0]).collect();
        let mut p = Plane { x: 0, y: 0, w: 3, h: 3, data: ramp.clone() };
        run_kind("tool.lens_correction", json!({}), &mut p);
        assert_eq!(p.data, ramp, "neutral");
        run_kind("tool.lens_correction", json!({ "angle": 180 }), &mut p);
        assert!((p.data[0] - 1.0).abs() < 1e-5 && p.data[8 * 4].abs() < 1e-5, "180 degrees swaps corners: {:?}", &p.data[..4]);
        let mut p = Plane { x: 0, y: 0, w: 9, h: 9, data: [0.5, 0.5, 0.5, 1.0].repeat(81) };
        run_kind("tool.lens_correction", json!({ "vignetteAmount": -100 }), &mut p);
        assert!(p.data[0] < 0.1 && (p.data[40 * 4] - 0.5).abs() < 1e-5, "corner {} center {}", p.data[0], p.data[160]);
        let mut p = Plane { x: 0, y: 0, w: 9, h: 9, data: [0.5, 0.5, 0.5, 1.0].repeat(81) };
        run_kind("tool.lens_correction", json!({ "scale": 50, "edgeMode": "white" }), &mut p);
        assert_eq!(&p.data[..4], &[1.0, 1.0, 1.0, 1.0], "outside the source is white");
    }

    #[test]
    fn adaptive_wide_angle_fisheye_magnifies_the_center() {
        let ramp: Vec<f32> = (0..121).flat_map(|i| [(i % 11) as f32 / 10.0, 0.5, 0.5, 1.0]).collect();
        let mut p = Plane { x: 0, y: 0, w: 11, h: 11, data: ramp.clone() };
        run_kind("tool.adaptive_wide_angle", json!({ "correction": "perspective" }), &mut p);
        assert_eq!(p.data, ramp, "perspective at 100% is neutral");
        run_kind("tool.adaptive_wide_angle", json!({ "correction": "fisheye", "focalLength": 8 }), &mut p);
        let row = 5 * 11 * 4;
        assert!((p.data[row + 5 * 4] - 0.5).abs() < 1e-5, "center stays");
        assert!(p.data[row + 7 * 4] > 0.8, "samples farther out: {}", p.data[row + 7 * 4]);
        assert_eq!(p.data[row + 9 * 4 + 3], 0.0, "past the source rim is transparent");
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
