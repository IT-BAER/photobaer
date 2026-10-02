//! Blur Gallery (docs/M5.md sections 5 and 14). Field, Iris and Tilt-Shift give every pixel a blur
//! radius from their handles and run the round bokeh blur; Path Blur smears along the nearest path
//! segment and Spin Blur along arcs. All five share light bokeh and seeded grain. Handle positions
//! are fractions of the layer bounds (`Ctx::bounds`).

use super::blur::{bilinear, bokeh, iris, premultiplied, split};
use super::render::Frame;
use super::{gauss, hash, Ctx, Filter, Plane};

fn round_kernel(a: f64) -> Vec<(isize, isize)> {
    iris(a, 12.0, 0.0, 1.0)
}

fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    if a == b {
        return if x < a { 0.0 } else { 1.0 };
    }
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn luma(px: &[f32]) -> f32 {
    0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2]
}

// Plane pixel i in plane px of the document (the frame's coordinates).
fn at(p: &Plane, i: usize) -> (f64, f64) {
    (f64::from(p.x + (i % p.w) as i32), f64::from(p.y + (i / p.w) as i32))
}

// Light bokeh blurs the bright pixels over twice the reach.
fn reach(max: f64, f: &Filter) -> i32 {
    let m = if f.num("lightBokeh") > 0.0 { 2.0 } else { 1.0 };
    (max.max(0.0) * m).ceil() as i32
}

// Pins in plane px, blur scaled with the plane.
fn pins(f: &Filter, fr: &Frame) -> Vec<(f64, f64, f64)> {
    let c = |q: &serde_json::Value, k: &str| q.get(k).and_then(serde_json::Value::as_f64).unwrap_or(0.0);
    f.params["pins"].as_array().into_iter().flatten().map(|q| {
        let (x, y) = fr.at(c(q, "x"), c(q, "y"));
        (x, y, c(q, "blur").max(0.0) * fr.s)
    }).collect()
}

fn field_max(f: &Filter) -> f64 {
    f.params["pins"].as_array().into_iter().flatten().filter_map(|q| q.get("blur")?.as_f64()).fold(0.0, f64::max)
}

pub fn field_reach(f: &Filter) -> i32 {
    reach(field_max(f), f)
}

/// One pin blurs everything by its value; more pins mix their blur by inverse distance 1 / d^4.
pub fn field(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let pins = pins(f, &fr);
    let radii: Vec<f32> = (0..p.w * p.h).map(|i| {
        if pins.len() == 1 {
            return pins[0].2 as f32;
        }
        let (x, y) = at(p, i);
        let (mut wsum, mut bsum) = (0.0, 0.0);
        for &(px, py, b) in &pins {
            let d2 = (px - x).powi(2) + (py - y).powi(2);
            if d2 < 1e-6 {
                return b as f32;
            }
            let w = 1.0 / (d2 * d2);
            wsum += w;
            bsum += w * b;
        }
        if wsum > 0.0 { (bsum / wsum) as f32 } else { 0.0 }
    }).collect();
    gallery(p, f, &radii, field_max(f) * fr.s);
    Ok(())
}

pub fn blur_reach(f: &Filter) -> i32 {
    reach(f.num("blur"), f)
}

/// Sharp inside a superellipse (roundness 0 = ellipse, 1 = near rectangle) of `radius` x short
/// side, blur rising over the feather band to the edge.
pub fn iris_blur(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let (fx, fy) = f.point("center");
    let (cx, cy) = fr.at(fx, fy);
    let r = (f.num("radius") * fr.short()).max(1.0);
    let (ax, ay) = (r * f.num("aspect").max(0.01), r);
    let (sn, cs) = f.num("rotation").to_radians().sin_cos();
    let u = 2.0 + f.num("roundness").clamp(0.0, 1.0) * 4.0;
    let (inner, blur) = ((1.0 - f.num("feather")).clamp(0.0, 1.0), f.num("blur"));
    let radii: Vec<f32> = (0..p.w * p.h).map(|i| {
        let (x, y) = at(p, i);
        let (dx, dy) = (x - cx, y - cy);
        let (ex, ey) = ((dx * cs + dy * sn) / ax, (-dx * sn + dy * cs) / ay);
        let d = (ex.abs().powf(u) + ey.abs().powf(u)).powf(1.0 / u);
        (smoothstep(inner, 1.0, d) * blur) as f32
    }).collect();
    gallery(p, f, &radii, blur);
    Ok(())
}

fn tilt_max(f: &Filter) -> f64 {
    let d = f.num("distortion");
    f.num("blur") * if f.flag("symmetricDistortion") { (1.0 + d * 0.5).max(0.0) } else { 1.0 + d.abs() * 0.5 }
}

pub fn tilt_reach(f: &Filter) -> i32 {
    reach(tilt_max(f), f)
}

/// Sharp within `focusWidth` of the line through the center at `rotation`, blur rising over the
/// feather; distortion scales the blur on one side (both when symmetric).
pub fn tilt_shift(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let (fx, fy) = f.point("center");
    let (cx, cy) = fr.at(fx, fy);
    let (sn, cs) = f.num("rotation").to_radians().sin_cos();
    let short = fr.w.min(fr.h);
    let (focus, feather) = (f.num("focusWidth") * short, (f.num("featherWidth") * short).max(0.001));
    let (blur, dist, sym) = (f.num("blur"), f.num("distortion"), f.flag("symmetricDistortion"));
    let radii: Vec<f32> = (0..p.w * p.h).map(|i| {
        let (x, y) = at(p, i);
        let d = -(x - cx) * sn + (y - cy) * cs;
        let mut r = smoothstep(focus, focus + feather, d.abs()) * blur;
        if dist != 0.0 {
            r *= 1.0 + dist * if sym || d >= 0.0 { 0.5 } else { -0.5 };
        }
        r.max(0.0) as f32
    }).collect();
    gallery(p, f, &radii, tilt_max(f));
    Ok(())
}

// The round bokeh blur at the per-pixel radii (quantized against `max`, the same for every tile),
// light bokeh, then grain faded in with the blur.
fn gallery(p: &mut Plane, f: &Filter, radii: &[f32], max: f64) {
    premultiplied(p, |p| bokeh(p, radii, max as f32, round_kernel));
    light_bokeh(p, f, max);
    if max > 0.0 {
        let mask: Vec<f32> = radii.iter().map(|&r| (f64::from(r) / max) as f32).collect();
        grain(p, f, Some(&mask));
    }
}

/// Smears along the nearest segment of any path by `speed` % of a quarter of the short side,
/// scaled from the start to the end point speed along the path.
pub fn path_blur(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let paths: Vec<Vec<(f64, f64)>> = f.params["paths"].as_array().into_iter().flatten()
        .map(|v| Filter::points(v).into_iter().map(|(x, y)| fr.at(x, y)).collect()).collect();
    let totals: Vec<f64> = paths.iter().map(|pts| pts.windows(2).map(|s| (s[1].0 - s[0].0).hypot(s[1].1 - s[0].1)).sum()).collect();
    let (start, end, speed) = (f.num("endPointSpeedStart"), f.num("endPointSpeedEnd"), f.num("speed") / 100.0 * fr.w.min(fr.h) * 0.25);
    let n = p.w * p.h;
    let (mut angles, mut lengths) = (vec![0f64; n], vec![0f64; n]);
    for i in 0..n {
        let (x, y) = at(p, i);
        let (mut best, mut u) = (f64::INFINITY, 0.0);
        for (pts, &total) in paths.iter().zip(&totals) {
            let mut run = 0.0;
            for s in pts.windows(2) {
                let ((x0, y0), (x1, y1)) = (s[0], s[1]);
                let (dx, dy) = (x1 - x0, y1 - y0);
                let l2 = dx * dx + dy * dy;
                let t = if l2 <= 0.0 { 0.0 } else { (((x - x0) * dx + (y - y0) * dy) / l2).clamp(0.0, 1.0) };
                let d2 = (x0 + dx * t - x).powi(2) + (y0 + dy * t - y).powi(2);
                if d2 < best {
                    best = d2;
                    angles[i] = dy.atan2(dx);
                    let along = if total <= 0.0 { 0.0 } else { (run + l2.sqrt() * t) / total };
                    u = (start + (end - start) * along) / 100.0;
                }
                run += l2.sqrt();
            }
        }
        lengths[i] = (speed * u).max(0.0);
    }
    let one_sided = !f.flag("centeredBlur") || f.text("blurShape") == "rearSync";
    let strobe = (f.num("strobeFlashes").round(), f.num("strobeStrength") / 100.0);
    premultiplied(p, |p| smear(p, &angles, &lengths, f.num("taper") / 100.0 * 3.0, strobe, one_sided));
    light_bokeh(p, f, lengths.iter().copied().fold(0.0, f64::max));
    grain(p, f, None);
    Ok(())
}

// Flashes > 1 cut the samples into on/off bands; off samples weigh 1 - strength.
fn strobe_weight(pos: f64, (flashes, strength): (f64, f64)) -> f64 {
    if flashes <= 1.0 || strength <= 0.0 {
        return 1.0;
    }
    let q = pos * flashes;
    1.0 - strength + strength * f64::from(u8::from(q - q.floor() < 0.5))
}

// Each pixel with length >= 1 becomes the weighted mean of bilinear samples along its angle,
// -n..n (or 0..n one-sided); taper fades the far samples by (1 - |k| / (n + 1))^taper.
fn smear(p: &mut Plane, angles: &[f64], lengths: &[f64], taper: f64, strobe: (f64, f64), one_sided: bool) {
    let src = p.data.clone();
    for (i, (&a, &len)) in angles.iter().zip(lengths).enumerate() {
        if len < 1.0 {
            continue;
        }
        let n = len.round().max(1.0) as i32;
        let lo = if one_sided { 0 } else { -n };
        let (sn, cs) = a.sin_cos();
        let (x, y) = ((i % p.w) as f64, (i / p.w) as f64);
        let (mut acc, mut tot) = ([0f64; 4], 0.0);
        for k in lo..=n {
            let mut w = if taper <= 0.0 { 1.0 } else { (1.0 - f64::from(k.abs()) / f64::from(n + 1)).powf(taper) };
            w *= strobe_weight(f64::from(k - lo) / f64::from(n - lo + 1), strobe);
            if w <= 0.0 {
                continue;
            }
            let ((ix, fx), (iy, fy)) = (split(x + cs * f64::from(k)), split(y + sn * f64::from(k)));
            for c in 0..4 {
                acc[c] += f64::from(bilinear(&src, p.w, p.h, ix, iy, fx, fy, c)) * w;
            }
            tot += w;
        }
        if tot > 0.0 {
            for c in 0..4 {
                p.data[i * 4 + c] = (acc[c] / tot) as f32;
            }
        }
    }
}

/// Inside an ellipse of `radius` x short side (times `aspect` across), each pixel becomes the mean
/// along its arc around the center over `blurAngle`, fading out over the feather.
pub fn spin_blur(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let (fx, fy) = f.point("center");
    let (cx, cy) = fr.at(fx, fy);
    let g = (f.num("radius") * fr.w.min(fr.h)).max(1.0);
    let (ax, ay) = (g * f.num("aspect").max(0.01), g);
    let (inner, angle) = ((1.0 - f.num("feather")).clamp(0.0, 1.0), f.num("blurAngle").to_radians());
    let strobe = (f.num("strobeFlashes").round().max(1.0), f.num("strobeStrength").clamp(0.0, 100.0) / 100.0);
    let mut weights = vec![0f32; p.w * p.h];
    premultiplied(p, |p| {
        let src = p.data.clone();
        for (i, wt) in weights.iter_mut().enumerate() {
            let (x, y) = at(p, i);
            let (dx, dy) = (x - cx, y - cy);
            let w = 1.0 - smoothstep(inner, 1.0, (dx / ax).hypot(dy / ay));
            *wt = w as f32;
            if w <= 0.0 || angle == 0.0 {
                continue;
            }
            let (t, r, a0) = (angle * w, dx.hypot(dy), dy.atan2(dx));
            let k = ((t * r / 1.5).round() + 2.0).clamp(2.0, 96.0) as usize;
            let (mut acc, mut tot) = ([0f64; 4], 0.0);
            for s in 0..k {
                let z = strobe_weight(s as f64 / k as f64, strobe);
                if z <= 0.0 {
                    continue;
                }
                let aa = a0 + (s as f64 / (k - 1) as f64 - 0.5) * t;
                let sx = ((cx + aa.cos() * r).round() as i32 - p.x).clamp(0, p.w as i32 - 1) as usize;
                let sy = ((cy + aa.sin() * r).round() as i32 - p.y).clamp(0, p.h as i32 - 1) as usize;
                for c in 0..4 {
                    acc[c] += f64::from(src[(sy * p.w + sx) * 4 + c]) * z;
                }
                tot += z;
            }
            if tot > 0.0 {
                for c in 0..4 {
                    p.data[i * 4 + c] = (acc[c] / tot) as f32;
                }
            }
        }
    });
    light_bokeh(p, f, (g * 0.05).max(2.0));
    grain(p, f, Some(&weights));
    Ok(())
}

// Pixels inside the light range (linear luminance window), desaturated toward their luminance by
// 1 - bokehColor, blurred with a flat disc of `radius` and screened at `lightBokeh` %.
fn light_bokeh(p: &mut Plane, f: &Filter, radius: f64) {
    let amount = (f.num("lightBokeh") / 100.0) as f32;
    let (lo, hi) = ((f.num("lightRangeMin") / 255.0) as f32, (f.num("lightRangeMax") / 255.0) as f32);
    if amount <= 0.0 || radius < 0.5 || hi <= lo {
        return;
    }
    let color = (f.num("bokehColor") / 100.0) as f32;
    let mut lights = p.clone();
    for px in lights.data.chunks_exact_mut(4) {
        let t = ((luma(px) - lo) / (hi - lo)).clamp(0.0, 1.0);
        px[..3].iter_mut().for_each(|v| *v *= t);
        let l = luma(px);
        px[..3].iter_mut().for_each(|v| *v = l + (*v - l) * color);
    }
    let radii = vec![radius as f32; p.w * p.h];
    premultiplied(&mut lights, |q| bokeh(q, &radii, radius as f32, round_kernel));
    for (px, b) in p.data.chunks_exact_mut(4).zip(lights.data.chunks_exact(4)) {
        for c in 0..3 {
            px[c] = 1.0 - (1.0 - px[c]) * (1.0 - (b[c] * amount).clamp(0.0, 1.0));
        }
    }
}

// Seeded grain in cells of noiseSize / 20 + 1 px on the document lattice: a shared value mixed
// toward per-channel values by noiseColor, faded on bright pixels by 1 - noiseHighlights.
fn grain(p: &mut Plane, f: &Filter, mask: Option<&[f32]>) {
    let amount = (f.num("noiseAmount") / 100.0 * 0.25) as f32;
    if amount <= 0.0 {
        return;
    }
    let size = (f.num("noiseSize") / 20.0 + 1.0).max(1.0);
    let (color, hi) = ((f.num("noiseColor") / 100.0) as f32, (f.num("noiseHighlights") / 100.0) as f32);
    let (seed, gaussian) = (f.num("seed") as u32, f.text("noiseDistribution") != "uniform");
    for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
        let m = mask.map_or(1.0, |m| m[i].clamp(0.0, 1.0));
        if m <= 0.0 {
            continue;
        }
        let (x, y) = (f64::from(p.x + (i % p.w) as i32), f64::from(p.y + (i / p.w) as i32));
        let (gx, gy) = ((x / size).floor() as i32, (y / size).floor() as i32);
        let rnd = |c: u32| if gaussian { gauss(seed, gx, gy, c) * 0.35 } else { hash(seed, gx, gy, c) - 0.5 };
        let base = rnd(0);
        for c in 0..3 {
            let n = base + (rnd(c as u32 + 1) - base) * color;
            let v = px[c];
            px[c] = v + n * amount * m * (1.0 - (1.0 - hi) * v.clamp(0.0, 1.0));
        }
    }
}
