//! Blur group (docs/M5.md sections 3 and 14). Kernels run on premultiplied color so transparent
//! pixels do not bleed their color; plane edges clamp (the runner reads the reach, so they never show).

use std::f64::consts::PI;

use super::{gauss, hash, Ctx, Filter, Plane};
use crate::styles;

pub fn blur_reach(_: &Filter) -> i32 {
    1
}

pub fn blur_more_reach(_: &Filter) -> i32 {
    3
}

pub(super) fn premultiplied(p: &mut Plane, f: impl FnOnce(&mut Plane)) {
    p.premultiply();
    f(p);
    p.unpremultiply();
}

// 1-2-1 along x then y: the 3x3 kernel 1-2-1 / 2-4-2 / 1-2-1 over 16.
fn blur3(p: &mut Plane) {
    let (w, h) = (p.w, p.h);
    let mut tmp = vec![0f32; p.data.len()];
    for y in 0..h {
        for x in 0..w {
            let (l, r) = (x.saturating_sub(1), (x + 1).min(w - 1));
            for c in 0..4 {
                let at = |xx: usize| p.data[(y * w + xx) * 4 + c];
                tmp[(y * w + x) * 4 + c] = (at(l) + 2.0 * at(x) + at(r)) / 4.0;
            }
        }
    }
    for y in 0..h {
        let (u, d) = (y.saturating_sub(1), (y + 1).min(h - 1));
        for x in 0..w {
            for c in 0..4 {
                let at = |yy: usize| tmp[(yy * w + x) * 4 + c];
                p.data[(y * w + x) * 4 + c] = (at(u) + 2.0 * at(y) + at(d)) / 4.0;
            }
        }
    }
}

pub fn blur(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    premultiplied(p, blur3);
    Ok(())
}

pub fn blur_more(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    premultiplied(p, |p| (0..3).for_each(|_| blur3(p)));
    Ok(())
}

/// Every pixel becomes the alpha-weighted mean color of the plane (weighted by the selection
/// coverage when given); alpha is kept by the runner.
pub fn average(p: &mut Plane, _: &Filter, ctx: &Ctx) -> Result<(), String> {
    let (mut sum, mut wsum) = ([0f64; 3], 0f64);
    for (i, px) in p.data.chunks_exact(4).enumerate() {
        let wgt = px[3] as f64 * ctx.cov.map_or(1.0, |c| c[i] as f64);
        for c in 0..3 {
            sum[c] += px[c] as f64 * wgt;
        }
        wsum += wgt;
    }
    if wsum <= 0.0 {
        return Ok(());
    }
    for px in p.data.chunks_exact_mut(4) {
        for c in 0..3 {
            px[c] = (sum[c] / wsum) as f32;
        }
    }
    Ok(())
}

// Pixels a `styles::gaussian` of `size` reaches past the content on each side.
pub fn gaussian_reach(f: &Filter) -> i32 {
    gauss_reach(f.num("radius") as f32)
}

pub(super) fn gauss_reach(size: f32) -> i32 {
    if size <= 12.0 {
        (size.ceil() as i32).max(1)
    } else {
        styles::gauss_boxes(size as f64 / 3.0).iter().sum::<usize>() as i32
    }
}

pub fn gaussian(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    premultiplied(p, |p| gaussian_all(p, f.num("radius") as f32));
    Ok(())
}

// Every channel through `styles::gaussian` of `size`, as stored.
pub(super) fn gaussian_all(p: &mut Plane, size: f32) {
    for c in 0..4 {
        let ch = styles::Plane { w: p.w, h: p.h, v: p.data.iter().skip(c).step_by(4).copied().collect() };
        for (i, v) in styles::gaussian(&ch, size).v.into_iter().enumerate() {
            p.data[i * 4 + c] = v;
        }
    }
}

// A box of radius `r` along x (or y), edges clamped. The running sum is f64 so a tile and the
// whole layer round alike.
fn box_pass(p: &mut Plane, r: usize, along_x: bool) {
    let (w, h) = (p.w, p.h);
    let (len, lines) = if along_x { (w, h) } else { (h, w) };
    let idx = |line: usize, k: usize| if along_x { line * w + k } else { k * w + line };
    let src = p.data.clone();
    let n = (2 * r + 1) as f64;
    for line in 0..lines {
        for c in 0..4 {
            let at = |k: isize| src[idx(line, k.clamp(0, len as isize - 1) as usize) * 4 + c] as f64;
            let r = r as isize;
            let mut sum: f64 = (-r..=r).map(at).sum();
            for k in 0..len as isize {
                p.data[idx(line, k as usize) * 4 + c] = (sum / n) as f32;
                sum += at(k + r + 1) - at(k - r);
            }
        }
    }
}

pub(crate) fn box_blur(p: &mut Plane, r: usize) {
    box_pass(p, r, true);
    box_pass(p, r, false);
}

pub fn box_reach(f: &Filter) -> i32 {
    f.num("radius").round() as i32
}

pub fn boxed(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let r = f.num("radius").round() as usize;
    premultiplied(p, |p| box_blur(p, r));
    Ok(())
}

// Clamped bilinear read of channel `c` at integer (x, y) plus fractions (fx, fy).
pub(super) fn bilinear(d: &[f32], w: usize, h: usize, x: isize, y: isize, fx: f32, fy: f32, c: usize) -> f32 {
    let at = |xx: isize, yy: isize| d[(yy.clamp(0, h as isize - 1) as usize * w + xx.clamp(0, w as isize - 1) as usize) * 4 + c];
    let top = at(x, y) + (at(x + 1, y) - at(x, y)) * fx;
    let bot = at(x, y + 1) + (at(x + 1, y + 1) - at(x, y + 1)) * fx;
    top + (bot - top) * fy
}

// Split a position into its floor and fraction.
pub(super) fn split(v: f64) -> (isize, f32) {
    let f = v.floor();
    (f as isize, (v - f) as f32)
}

fn motion_samples(distance: f64) -> usize {
    distance.round().max(1.0) as usize
}

pub fn motion_reach(f: &Filter) -> i32 {
    motion_span(f.num("distance"))
}

pub(super) fn motion_span(distance: f64) -> i32 {
    ((motion_samples(distance) - 1) as f64 / 2.0).ceil() as i32 + 1
}

/// The mean of `distance` samples on a line through the pixel at `angle` (counterclockwise).
pub fn motion(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    premultiplied(p, |p| motion_all(p, f.num("distance"), f.num("angle")));
    Ok(())
}

// Every channel as stored.
pub(super) fn motion_all(p: &mut Plane, distance: f64, angle: f64) {
    let n = motion_samples(distance);
    let a = angle.to_radians();
    let snap = |v: f64| if v.abs() < 1e-9 { 0.0 } else { v };
    let (u, v) = (snap(a.cos()), snap(-a.sin()));
    let half = (n - 1) as f64 / 2.0;
    // Per sample: whole-pixel offsets and fractions, the same for every pixel.
    let taps: Vec<_> = (0..n).map(|k| (split(u * (k as f64 - half)), split(v * (k as f64 - half)))).collect();
    let src = p.data.clone();
    for y in 0..p.h {
        for x in 0..p.w {
            for c in 0..4 {
                let sum: f32 = taps.iter().map(|&((dx, fx), (dy, fy))| bilinear(&src, p.w, p.h, x as isize + dx, y as isize + dy, fx, fy, c)).sum();
                p.data[(y * p.w + x) * 4 + c] = sum / n as f32;
            }
        }
    }
}

/// Spin: samples along the arc around the center over `amount` degrees; zoom: along the ray over
/// `amount` %. Good and Best add passes at half and a quarter of the amount.
pub fn radial(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let (fx, fy) = f.point("center");
    let b = ctx.bounds;
    let cx = (b[0] as f64 + fx * b[2] as f64) * ctx.scale - p.x as f64;
    let cy = (b[1] as f64 + fy * b[3] as f64) * ctx.scale - p.y as f64;
    let amount = f.num("amount");
    let spin = f.text("method") == "spin";
    let passes: &[f64] = match f.text("quality") {
        "draft" => &[1.0],
        "best" => &[1.0, 0.5, 0.25],
        _ => &[1.0, 0.5],
    };
    premultiplied(p, |p| {
        for k in passes {
            radial_pass(p, amount * k, spin, cx, cy);
        }
    });
    Ok(())
}

fn radial_pass(p: &mut Plane, t: f64, spin: bool, cx: f64, cy: f64) {
    let n = (t.round() as usize).max(2);
    let src = p.data.clone();
    for y in 0..p.h {
        for x in 0..p.w {
            let (dx, dy) = (x as f64 - cx, y as f64 - cy);
            let (dist, ang) = (dx.hypot(dy), dy.atan2(dx));
            let mut acc = [0f32; 4];
            for k in 0..n {
                let r = k as f64 / (n - 1) as f64 - 0.5;
                let (sx, sy) = if spin {
                    let a = ang + r * t * PI / 180.0;
                    (cx + a.cos() * dist, cy + a.sin() * dist)
                } else {
                    let s = 1.0 + r * t / 100.0;
                    (cx + dx * s, cy + dy * s)
                };
                let ((ix, fx), (iy, fy)) = (split(sx), split(sy));
                for (c, a) in acc.iter_mut().enumerate() {
                    *a += bilinear(&src, p.w, p.h, ix, iy, fx, fy, c);
                }
            }
            for c in 0..4 {
                p.data[(y * p.w + x) * 4 + c] = acc[c] / n as f32;
            }
        }
    }
}

fn shape_radius(f: &Filter) -> i32 {
    (f.num("radius").round() as i32).max(1)
}

pub fn shape_reach(f: &Filter) -> i32 {
    shape_radius(f)
}

// Offsets inside `shape` scaled to radius `a`.
fn shape_taps(a: i32, shape: &str) -> Vec<(isize, isize)> {
    let mut out = Vec::new();
    for dy in -a..=a {
        for dx in -a..=a {
            let (s, l) = (dx as f64 / a as f64, dy as f64 / a as f64);
            let (d, ang) = (s.hypot(l), l.atan2(s));
            let inside = match shape {
                "square" => true,
                "diamond" => s.abs() + l.abs() <= 1.0,
                "triangle" => l >= -1.0 + 2.0 * s.abs(),
                "hexagon" => d <= (PI / 6.0).cos() / (ang.rem_euclid(PI / 3.0) - PI / 6.0).cos(),
                "cross" => s.abs() <= 0.3 || l.abs() <= 0.3,
                "star" => d <= 0.4 + 0.6 * (0.5 + 0.5 * (5.0 * ang).cos()),
                "ring" => (0.6..=1.0).contains(&d),
                _ => d <= 1.0,
            };
            if inside {
                out.push((dx as isize, dy as isize));
            }
        }
    }
    out
}

// The mean over `taps` around each pixel, edges clamped.
fn mean_over(p: &mut Plane, taps: &[(isize, isize)]) {
    if taps.is_empty() {
        return;
    }
    let src = p.data.clone();
    let (w, h) = (p.w as isize, p.h as isize);
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0f32; 4];
            for &(dx, dy) in taps {
                let i = (((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) * 4) as usize;
                for c in 0..4 {
                    acc[c] += src[i + c];
                }
            }
            for c in 0..4 {
                p.data[((y * w + x) * 4) as usize + c] = acc[c] / taps.len() as f32;
            }
        }
    }
}

pub fn shape(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let taps = shape_taps(shape_radius(f), f.text("shape"));
    premultiplied(p, |p| mean_over(p, &taps));
    Ok(())
}

// Surface blur: neighbors within `radius` differing from the pixel by less than `thr` weigh
// 1 - diff / thr. When the layer area times the window area reaches 8e6, one box blur stands in
// for the neighborhood (the reference's fast path).
pub(super) fn surface(p: &mut Plane, radius: f64, thr: f32, area: f64) {
    if radius <= 0.0 || thr <= 0.0 {
        return;
    }
    let l = (radius.round() as usize).max(1);
    let win = (2 * l + 1) as f64;
    let src = p.data.clone();
    if area * win * win >= 8e6 {
        box_blur(p, l);
        for (v, s) in p.data.iter_mut().zip(&src) {
            let d = (*v - s).abs();
            let k = if d >= thr { 0.0 } else { 1.0 - d / thr };
            *v = s + (*v - s) * k;
        }
        return;
    }
    let (w, h, l) = (p.w as isize, p.h as isize, l as isize);
    for y in 0..h {
        for x in 0..w {
            for c in 0..4 {
                let v = src[((y * w + x) * 4) as usize + c];
                let (mut acc, mut wsum) = (0f32, 0f32);
                for dy in -l..=l {
                    let yy = (y + dy).clamp(0, h - 1);
                    for dx in -l..=l {
                        let n = src[((yy * w + (x + dx).clamp(0, w - 1)) * 4) as usize + c];
                        let d = (n - v).abs();
                        if d < thr {
                            let k = 1.0 - d / thr;
                            acc += n * k;
                            wsum += k;
                        }
                    }
                }
                p.data[((y * w + x) * 4) as usize + c] = if wsum > 0.0 { acc / wsum } else { v };
            }
        }
    }
}

// The layer area in plane px, the same for every tile of one run.
fn area(ctx: &Ctx) -> f64 {
    ctx.bounds[2] as f64 * ctx.bounds[3] as f64 * ctx.scale * ctx.scale
}

pub fn surface_reach(f: &Filter) -> i32 {
    (f.num("radius").round() as i32).max(1)
}

pub fn surface_blur(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let (r, thr) = (f.num("radius"), f.num("threshold") as f32 / 255.0);
    premultiplied(p, |p| surface(p, r, thr, area(ctx)));
    Ok(())
}

fn smart_passes(f: &Filter) -> i32 {
    match f.text("quality") {
        "low" => 1,
        "medium" => 2,
        _ => 3,
    }
}

pub fn smart_reach(f: &Filter) -> i32 {
    if f.text("mode") == "edgeOnly" {
        1
    } else {
        surface_reach(f) * smart_passes(f)
    }
}

// Sobel magnitude per pixel, the largest over the color channels.
pub(super) fn edges(p: &Plane) -> Vec<f32> {
    let (w, h) = (p.w as isize, p.h as isize);
    let mut out = vec![0f32; p.w * p.h];
    for y in 0..h {
        for x in 0..w {
            let mut m = 0f32;
            for c in 0..3 {
                let u = |dx: isize, dy: isize| p.data[(((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) * 4) as usize + c];
                let gx = u(1, -1) + 2.0 * u(1, 0) + u(1, 1) - u(-1, -1) - 2.0 * u(-1, 0) - u(-1, 1);
                let gy = u(-1, 1) + 2.0 * u(0, 1) + u(1, 1) - u(-1, -1) - 2.0 * u(0, -1) - u(1, -1);
                m = m.max(gx.hypot(gy));
            }
            out[(y * w + x) as usize] = m;
        }
    }
    out
}

/// Normal: surface blur passes (threshold in %); Edge Only: white edges on black; Overlay Edge:
/// the blur with white edges over it. Edge strength is the Sobel magnitude over 4 x threshold.
pub fn smart(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let thr = (f.num("threshold") / 100.0).clamp(0.001, 1.0) as f32;
    let (r, n, mode) = (f.num("radius"), smart_passes(f), f.text("mode"));
    let blur = |p: &mut Plane| premultiplied(p, |p| (0..n).for_each(|_| surface(p, r, thr, area(ctx))));
    if mode == "normal" {
        blur(p);
        return Ok(());
    }
    let e: Vec<f32> = edges(p).into_iter().map(|v| (v / (thr * 4.0)).clamp(0.0, 1.0)).collect();
    if mode == "overlayEdge" {
        blur(p);
    }
    for (px, e) in p.data.chunks_exact_mut(4).zip(e) {
        for v in &mut px[..3] {
            *v = if mode == "edgeOnly" { e } else { *v * (1.0 - e) + e };
        }
    }
    Ok(())
}

// The largest per-pixel bokeh radius a Lens Blur can ask for: every tile quantizes against it.
fn lens_max(f: &Filter) -> f64 {
    let r = f.num("radius").max(0.0);
    if f.text("depthMapSource") == "none" {
        return r;
    }
    let focal = f.num("blurFocalDistance") / 255.0;
    2.0 * r * focal.max(1.0 - focal)
}

pub fn lens_reach(f: &Filter) -> i32 {
    lens_max(f).round() as i32
}

// Offsets inside an iris of `blades` straight sides (rotated by `rot` radians) at radius `a`;
// `curve` 0..1 rounds the sides out toward the circle.
pub(super) fn iris(a: f64, blades: f64, rot: f64, curve: f64) -> Vec<(isize, isize)> {
    let a = a.round().max(0.0);
    let seg = 2.0 * PI / blades;
    let mut out = Vec::new();
    let r = a as isize;
    for dy in -r..=r {
        for dx in -r..=r {
            let d = (dx as f64).hypot(dy as f64);
            if d > a {
                continue;
            }
            let side = a * (PI / blades).cos() / (((dy as f64).atan2(dx as f64) - rot).rem_euclid(seg) - seg / 2.0).cos();
            if d == 0.0 || d <= side + (a - side) * curve {
                out.push((dx, dy));
            }
        }
    }
    out
}

/// Bokeh blur with an iris kernel sized per pixel by the depth map (8 kernel sizes), bright
/// highlights boosted first, then seeded noise.
pub fn lens(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let radius = f.num("radius").max(0.0);
    let focal = (f.num("blurFocalDistance") / 255.0) as f32;
    let doc = |i: usize| (((p.x + (i % p.w) as i32) as f64 / ctx.scale).floor() as i32, ((p.y + (i / p.w) as i32) as f64 / ctx.scale).floor() as i32);
    let depth = |i: usize, px: &[f32]| -> Option<f32> {
        match (f.text("depthMapSource"), ctx.mask) {
            ("transparency", _) => Some(px[3]),
            ("layerMask", Some(m)) => {
                let (x, y) = doc(i);
                Some(m(x, y))
            }
            _ => None,
        }
    };
    let radii: Vec<f32> = p
        .data
        .chunks_exact(4)
        .enumerate()
        .map(|(i, px)| match depth(i, px) {
            None => radius as f32,
            Some(d) => {
                let d = if f.flag("invertDepthMap") { 1.0 - d } else { d };
                (d.clamp(0.0, 1.0) - focal).abs() * 2.0 * radius as f32
            }
        })
        .collect();
    specular(p, f.num("specularThreshold") as f32 / 255.0, f.num("specularBrightness") as f32);
    let blades = match f.text("irisShape") {
        "triangle" => 3.0,
        "square" => 4.0,
        "pentagon" => 5.0,
        "heptagon" => 7.0,
        "octagon" => 8.0,
        _ => 6.0,
    };
    let (rot, curve) = (f.num("rotation").to_radians(), f.num("bladeCurvature") / 100.0);
    premultiplied(p, |p| bokeh(p, &radii, lens_max(f) as f32, |a| iris(a, blades, rot, curve)));
    let amount = f.num("noiseAmount") as f32 / 100.0 * 0.25;
    if amount > 0.0 {
        let (seed, gaussian, mono) = (f.num("seed") as u32, f.text("noiseDistribution") == "gaussian", f.flag("monochromaticNoise"));
        for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
            let (x, y) = (p.x + (i % p.w) as i32, p.y + (i / p.w) as i32);
            let rnd = |c: u32| {
                if gaussian {
                    gauss(seed, x, y, c) * 0.35
                } else {
                    hash(seed, x, y, c) - 0.5
                }
            };
            let base = rnd(0);
            for (c, v) in px[..3].iter_mut().enumerate() {
                *v += if mono { base } else { rnd(c as u32 + 1) } * amount;
            }
        }
    }
    Ok(())
}

// Pixels with luminance at or over `thr` get brighter, up to 1 + 8 x brightness %.
fn specular(p: &mut Plane, thr: f32, brightness: f32) {
    if brightness <= 0.0 {
        return;
    }
    let gain = brightness / 100.0 * 8.0;
    for px in p.data.chunks_exact_mut(4) {
        let l = 0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2];
        if l < thr {
            continue;
        }
        let t = if thr >= 1.0 { 1.0 } else { ((l - thr) / (1.0 - thr).max(1e-4)).clamp(0.0, 1.0) };
        for v in &mut px[..3] {
            *v *= 1.0 + gain * t;
        }
    }
}

// Each pixel with radius r >= 0.5 becomes the mean over the nearest of 8 kernels sized up to
// `max`, reading only inside the plane.
pub(super) fn bokeh(p: &mut Plane, radii: &[f32], max: f32, kernel: impl Fn(f64) -> Vec<(isize, isize)>) {
    if max < 0.5 {
        return;
    }
    let kernels: Vec<_> = (1..=8).map(|m| kernel((max * m as f32 / 8.0) as f64)).collect();
    let src = p.data.clone();
    let (w, h) = (p.w as isize, p.h as isize);
    for (i, &r) in radii.iter().enumerate() {
        if r < 0.5 {
            continue;
        }
        let k = &kernels[((r / max * 8.0).round() as usize).clamp(1, 8) - 1];
        let (x, y) = ((i % p.w) as isize, (i / p.w) as isize);
        let (mut acc, mut n) = ([0f32; 4], 0);
        for &(dx, dy) in k {
            let (xx, yy) = (x + dx, y + dy);
            if xx < 0 || xx >= w || yy < 0 || yy >= h {
                continue;
            }
            let j = ((yy * w + xx) * 4) as usize;
            for c in 0..4 {
                acc[c] += src[j + c];
            }
            n += 1;
        }
        if n > 0 {
            for c in 0..4 {
                p.data[i * 4 + c] = acc[c] / n as f32;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Ctx, Filter, Plane};
    use serde_json::{json, Value};
    use std::collections::HashMap;

    fn plane(w: usize, h: usize, f: impl Fn(usize, usize) -> [f32; 4]) -> Plane {
        let data = (0..w * h).flat_map(|i| f(i % w, i / w)).collect();
        Plane { x: 0, y: 0, w, h, data }
    }

    fn gray(v: f32) -> [f32; 4] {
        [v / 255.0, v / 255.0, v / 255.0, 1.0]
    }

    fn run_with(kind: &str, params: Value, p: &mut Plane, bounds: [i32; 4], mask: Option<&dyn Fn(i32, i32) -> f32>) {
        let f = Filter::parse(&json!({ "kind": kind, "params": params }).to_string()).unwrap();
        let blobs = HashMap::new();
        super::super::apply(&f, p, &Ctx { blobs: &blobs, cov: None, bounds, scale: 1.0, mask }).unwrap();
    }

    fn run(kind: &str, params: Value, p: &mut Plane) {
        let b = [p.x, p.y, p.w as i32, p.h as i32];
        run_with(kind, params, p, b, None);
    }

    fn v8(p: &Plane, x: usize, y: usize) -> u8 {
        (p.data[(y * p.w + x) * 4].clamp(0.0, 1.0) * 255.0).round() as u8
    }

    fn impulse() -> Plane {
        plane(9, 9, |x, y| gray(if (x, y) == (4, 4) { 255.0 } else { 0.0 }))
    }

    #[test]
    fn box_radius_1_spreads_an_impulse_over_nine_cells() {
        let mut p = impulse();
        run("blur.box_blur", json!({ "radius": 1 }), &mut p);
        for y in 0..9usize {
            for x in 0..9usize {
                let want: u8 = if x.abs_diff(4usize) <= 1 && y.abs_diff(4usize) <= 1 { 28 } else { 0 };
                assert!(v8(&p, x, y).abs_diff(want) <= 1, "{x},{y}: {}", v8(&p, x, y));
            }
        }
    }

    #[test]
    fn motion_blur_spreads_along_its_angle_only() {
        let mut p = impulse();
        run("blur.motion_blur", json!({ "angle": 0, "distance": 3 }), &mut p);
        let row: u32 = (0..9).map(|x| v8(&p, x, 4) as u32).sum();
        assert!(row.abs_diff(255) <= 3, "the row keeps the energy: {row}");
        assert!((0..9).all(|y| y == 4 || (0..9).all(|x| v8(&p, x, y) == 0)), "only the impulse row changes");
        let mut q = impulse();
        run("blur.motion_blur", json!({ "angle": 90, "distance": 3 }), &mut q);
        assert!((0..9).all(|x| x == 4 || (0..9).all(|y| v8(&q, x, y) == 0)), "90 degrees spreads only vertically");
        assert!(v8(&q, 4, 3) > 0 && v8(&q, 4, 5) > 0);
    }

    #[test]
    fn shape_blur_circle_radius_1_matches_box_on_flat_and_shapes_differ() {
        let mut a = plane(8, 8, |_, _| gray(77.0));
        let mut b = a.clone();
        run("blur.shape_blur", json!({ "radius": 1, "shape": "circle" }), &mut a);
        run("blur.box_blur", json!({ "radius": 1 }), &mut b);
        assert!((0..64).all(|i| v8(&a, i % 8, i / 8) == 77 && v8(&b, i % 8, i / 8) == 77));
        let (mut c, mut s) = (impulse(), impulse());
        run("blur.shape_blur", json!({ "radius": 3, "shape": "circle" }), &mut c);
        run("blur.shape_blur", json!({ "radius": 3, "shape": "square" }), &mut s);
        assert_eq!(v8(&c, 1, 1), 0, "the circle skips the corner");
        assert!(v8(&s, 1, 1) > 0, "the square reaches the corner");
    }

    fn surface_keeps_the_edge_and_smooths_noise(bounds: [i32; 4]) {
        let step = plane(40, 12, |x, _| gray(if x >= 20 { 255.0 } else { 0.0 }));
        let mut p = step.clone();
        run_with("blur.surface_blur", json!({ "radius": 5, "threshold": 15 }), &mut p, bounds, None);
        assert_eq!(p, step, "a hard 0/255 edge stays");
        let noise = plane(40, 12, |x, y| gray(100.0 + if (x * 7 + y * 3) % 2 == 0 { 5.0 } else { -5.0 }));
        let mut q = noise.clone();
        run_with("blur.surface_blur", json!({ "radius": 5, "threshold": 15 }), &mut q, bounds, None);
        let dev = |q: &Plane| (0..480).map(|i| v8(q, i % 40, i / 40).abs_diff(100) as u32).sum::<u32>();
        assert!(dev(&q) * 4 < dev(&noise) * 3, "noise shrinks: {} vs {}", dev(&q), dev(&noise));
    }

    #[test]
    fn surface_blur_keeps_hard_edges_and_smooths_noise_exact_and_on_large_layers() {
        surface_keeps_the_edge_and_smooths_noise([0, 0, 40, 12]);
        surface_keeps_the_edge_and_smooths_noise([0, 0, 4000, 3000]);
    }

    #[test]
    fn smart_blur_edge_modes_draw_white_edges() {
        let step = || plane(10, 4, |x, _| gray(if x >= 5 { 255.0 } else { 0.0 }));
        let mut e = step();
        run("blur.smart_blur", json!({ "mode": "edgeOnly" }), &mut e);
        assert_eq!((v8(&e, 1, 1), v8(&e, 4, 1), v8(&e, 8, 1)), (0, 255, 0), "white edges on black");
        let mut o = step();
        run("blur.smart_blur", json!({ "mode": "overlayEdge" }), &mut o);
        assert_eq!((v8(&o, 1, 1), v8(&o, 4, 1), v8(&o, 8, 1)), (0, 255, 255), "white edges over the image");
    }

    #[test]
    fn radial_blur_spins_around_the_layer_point_and_keeps_the_center() {
        let grad = || plane(20, 20, |x, y| gray((x * 10 + y) as f32));
        let mut p = grad();
        run("blur.radial_blur", json!({ "amount": 100, "method": "spin", "center": { "x": 0.5, "y": 0.5 } }), &mut p);
        assert_eq!(v8(&p, 10, 10), v8(&grad(), 10, 10), "the spin center stays");
        assert!(v8(&p, 0, 10).abs_diff(v8(&grad(), 0, 10)) >= 5, "pixels off center move along the arc");
        // Zoom averages along the ray, so it needs a curved ramp to show.
        let bowl = || plane(20, 20, |x, y| gray(((x * x + y * y) / 3) as f32));
        let mut z = bowl();
        run("blur.radial_blur", json!({ "amount": 40, "method": "zoom", "center": { "x": 0.0, "y": 0.0 } }), &mut z);
        assert_eq!(v8(&z, 0, 0), v8(&bowl(), 0, 0), "the zoom center (layer corner) stays");
        assert!(v8(&z, 15, 15) > v8(&bowl(), 15, 15));
        let mut flat = plane(9, 9, |_, _| gray(60.0));
        run("blur.radial_blur", json!({ "amount": 1, "method": "spin" }), &mut flat);
        assert!((0..81).all(|i| v8(&flat, i % 9, i / 9) == 60));
    }

    #[test]
    fn lens_blur_radius_0_is_identity_and_noise_is_seeded() {
        let src = plane(12, 12, |x, y| gray(((x * 37 + y * 11) % 256) as f32));
        let mut p = src.clone();
        run("blur.lens_blur", json!({ "radius": 0 }), &mut p);
        assert_eq!(p, src);
        let noisy = |seed: u32, mono: bool| {
            let mut q = plane(12, 12, |_, _| gray(128.0));
            run("blur.lens_blur", json!({ "radius": 0, "noiseAmount": 50, "seed": seed, "monochromaticNoise": mono }), &mut q);
            q
        };
        assert_eq!(noisy(3, false), noisy(3, false));
        assert_ne!(noisy(3, false), noisy(4, false));
        let m = noisy(3, true);
        assert!(m.data.chunks_exact(4).all(|px| px[0] == px[1] && px[1] == px[2] && px[3] == 1.0), "monochromatic: R = G = B, alpha kept");
        assert!(m.data.chunks_exact(4).any(|px| px[0] != 128.0 / 255.0));
    }

    #[test]
    fn lens_blur_depth_map_keeps_the_focal_plane_sharp() {
        // Mask 0 on the left (in focus at distance 0), 1 on the right (blurred by 2 x radius).
        let src = plane(20, 6, |x, _| gray(if x % 2 == 0 { 0.0 } else { 255.0 }));
        let mask = |x: i32, _: i32| if x >= 10 { 1.0 } else { 0.0 };
        let mut p = src.clone();
        run_with("blur.lens_blur", json!({ "radius": 3, "depthMapSource": "layerMask" }), &mut p, [0, 0, 20, 6], Some(&mask));
        assert_eq!((v8(&p, 3, 3), v8(&p, 4, 3), v8(&p, 5, 3)), (255, 0, 255), "focal plane stays sharp");
        assert!((60..=200).contains(&v8(&p, 15, 3)), "far plane blurs: {}", v8(&p, 15, 3));
        let mut inv = src.clone();
        run_with("blur.lens_blur", json!({ "radius": 3, "depthMapSource": "layerMask", "invertDepthMap": true }), &mut inv, [0, 0, 20, 6], Some(&mask));
        assert_eq!(v8(&inv, 15, 3), 255, "inverted: the right half is in focus");
    }

    #[test]
    fn every_blur_leaves_flat_input_unchanged() {
        for (kind, params) in [
            ("blur.box_blur", json!({})),
            ("gaussian_blur", json!({})),
            ("blur.lens_blur", json!({ "specularBrightness": 50 })),
            ("blur.motion_blur", json!({ "angle": 33 })),
            ("blur.radial_blur", json!({ "method": "zoom", "quality": "best" })),
            ("blur.radial_blur", json!({})),
            ("blur.shape_blur", json!({ "shape": "ring" })),
            ("blur.smart_blur", json!({})),
            ("blur.surface_blur", json!({})),
            ("blur.blur_more", json!({})),
            ("blur.average", json!({})),
        ] {
            let mut p = plane(16, 16, |_, _| gray(90.0));
            run(kind, params, &mut p);
            assert!((0..256).all(|i| v8(&p, i % 16, i / 16) == 90), "{kind}");
        }
    }

    #[test]
    fn point_params_validate_their_range() {
        let e = Filter::parse(r#"{"kind":"blur.radial_blur","params":{"center":{"x":1.5,"y":0.5}}}"#).unwrap_err();
        assert!(e.contains("Radial Blur") && e.contains("center"), "{e}");
        let f = Filter::parse(r#"{"kind":"blur.radial_blur","params":{}}"#).unwrap();
        assert_eq!(f.params["center"], json!({ "x": 0.5, "y": 0.5 }));
    }
}
