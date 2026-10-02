//! Filter Gallery (docs/M5.md sections 4 and 14): a stack of effect layers applied bottom to top, and
//! the shared painterly primitives the 47 effects (`effects.rs`) are built from. Every effect runs
//! over the whole layer on premultiplied color; randomness comes from `hash` at document positions.

mod effects;

use serde_json::{json, Value};

use super::blur::{bilinear, gaussian_all, premultiplied, split, surface};
use super::blur_gallery::smear;
use super::noise::median;
use super::render::value_noise;
use super::{hash, lookup, Ctx, Filter, Params, Plane};
use crate::styles::{self, Plane as Map};

/// Keys every effect takes from the gallery filter instead of its stored params.
const INJECTED: [&str; 3] = ["seed", "foreground", "background"];

/// One stored effect layer `{ kind, enabled, params }`: a gallery effect kind and its normalized params.
pub(super) fn check_layer(e: &Value) -> Result<Value, String> {
    let o = e.as_object().filter(|o| o.len() == 3).ok_or("must be { kind, enabled, params }")?;
    let kind = o.get("kind").and_then(Value::as_str).ok_or("needs a kind")?;
    if !lookup(kind).is_some_and(|s| s.group.starts_with("gallery.")) {
        return Err(format!("\"{kind}\" is not a Filter Gallery effect"));
    }
    let enabled = o.get("enabled").and_then(Value::as_bool).ok_or("needs enabled true or false")?;
    let params = o.get("params").and_then(Value::as_object).ok_or("needs params")?;
    let mut f = Filter { kind: kind.into(), params: params.clone() }.normalized()?;
    INJECTED.iter().for_each(|k| _ = f.params.remove(*k));
    Ok(json!({ "kind": kind, "enabled": enabled, "params": f.params }))
}

/// The gallery filter: each enabled layer in order, layer t seeded `seed + t * 7919`.
pub fn filter_gallery(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let seed = f.num("seed") as u32;
    for (t, e) in f.params["stack"].as_array().into_iter().flatten().enumerate() {
        if e["enabled"] != true {
            continue;
        }
        let mut params: Params = e["params"].as_object().cloned().unwrap_or_default();
        params.insert("seed".into(), json!(seed.wrapping_add((t as u32).wrapping_mul(7919))));
        for k in ["foreground", "background"] {
            params.insert(k.into(), f.params[k].clone());
        }
        effect(p, &Filter { kind: e["kind"].as_str().unwrap_or("").into(), params }, ctx)?;
    }
    Ok(())
}

/// One effect on premultiplied color, then back to straight color clamped to 0..1.
pub fn effect(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let neutral = match f.kind.rsplit('.').next() {
        Some("spatter") => f.num("sprayRadius") <= 0.0,
        Some("glass") => f.num("distortion") <= 0.0,
        Some("ocean_ripple") => f.num("rippleMagnitude") <= 0.0,
        Some("grain") => f.num("intensity") <= 0.0 && f.num("contrast") == 50.0,
        Some("texturizer") => f.num("relief") <= 0.0,
        _ => false,
    };
    if neutral {
        return Ok(());
    }
    let fx = Fx { seed: f.num("seed") as u32, ox: p.x, oy: p.y, fg: f.color("foreground"), bg: f.color("background") };
    let mut res = Ok(());
    premultiplied(p, |p| res = effects::run(p, f, &fx));
    p.data.iter_mut().for_each(|v| *v = v.clamp(0.0, 1.0));
    res
}

/// Per-run inputs: the seed, the plane's document origin, the current colors.
pub(super) struct Fx {
    seed: u32,
    ox: i32,
    oy: i32,
    fg: [f32; 3],
    bg: [f32; 3],
}

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    if a == b {
        return if x < a { 0.0 } else { 1.0 };
    }
    let t = clamp01((x - a) / (b - a));
    t * t * (3.0 - 2.0 * t)
}

fn map(p: &Plane, v: impl Fn(&[f32]) -> f32) -> Map {
    Map { w: p.w, h: p.h, v: p.data.chunks_exact(4).map(v).collect() }
}

fn luma(p: &Plane) -> Map {
    map(p, |c| 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2])
}

// Each color channel through `f(value, map value)`.
fn each(p: &mut Plane, m: &Map, f: impl Fn(f32, f32) -> f32) {
    for (c, &v) in p.data.chunks_exact_mut(4).zip(&m.v) {
        c[..3].iter_mut().for_each(|x| *x = f(*x, v));
    }
}

fn colors(p: &mut Plane, f: impl Fn(f32) -> f32) {
    p.data.chunks_exact_mut(4).for_each(|c| c[..3].iter_mut().for_each(|x| *x = f(*x)));
}

fn blurred(m: &Map, size: f32) -> Map {
    if size > 0.0 { styles::gaussian(m, size) } else { m.clone() }
}

fn blur(p: &mut Plane, size: f32) {
    if size > 0.0 {
        gaussian_all(p, size);
    }
}

fn at(m: &Map, x: isize, y: isize) -> f32 {
    m.v[y.clamp(0, m.h as isize - 1) as usize * m.w + x.clamp(0, m.w as isize - 1) as usize]
}

fn from_fn(w: usize, h: usize, f: impl Fn(usize, usize) -> f32) -> Map {
    Map { w, h, v: (0..w * h).map(|i| f(i % w, i / w)).collect() }
}

// Value noise and a plain hash at a document position.
fn noise(seed: u32, u: f64, v: f64) -> f32 {
    value_noise(seed, u, v) as f32
}

/// Posterizes the color channels to `levels` values.
fn posterize(p: &mut Plane, levels: f64) {
    let n = (levels.round().max(2.0) - 1.0) as f32;
    colors(p, |v| (clamp01(v) * n).round() / n);
}

/// Saturation around the channel mean.
fn saturate(p: &mut Plane, k: f32) {
    for c in p.data.chunks_exact_mut(4) {
        let m = (c[0] + c[1] + c[2]) / 3.0;
        c[..3].iter_mut().for_each(|x| *x = m + (*x - m) * k);
    }
}

/// Darkens by `k` where the map is low: color x (1 - (1 - m) k).
fn darken(p: &mut Plane, m: &Map, k: f32) {
    each(p, m, |c, v| c * (1.0 - (1.0 - clamp01(v)) * k.clamp(0.0, 1.0)));
}

/// Screens the map over the color at strength `k`.
fn screen(p: &mut Plane, m: &Map, k: f32) {
    each(p, m, |c, v| {
        let b = clamp01(v) * k.clamp(0.0, 1.0);
        if b <= 0.0 { c } else { 1.0 - (1.0 - c) * (1.0 - b) }
    });
}

/// Foreground where the map is 0, background where it is 1.
fn duotone(p: &mut Plane, m: &Map, fx: &Fx) {
    for (c, &v) in p.data.chunks_exact_mut(4).zip(&m.v) {
        let v = clamp01(v);
        (0..3).for_each(|k| c[k] = fx.fg[k] + (fx.bg[k] - fx.fg[k]) * v);
    }
}

fn gray(p: &mut Plane, m: &Map) {
    each(p, m, |_, v| v);
}

/// Luma blurred by `smooth` px.
fn soft_luma(p: &Plane, smooth: f32) -> Map {
    blurred(&luma(p), smooth)
}

/// The map minus its blur over max(a + 0.5, size) px.
fn high_pass(m: &Map, a: f32, size: f32) -> Map {
    let b = styles::gaussian(m, (a + 0.5).max(size));
    Map { w: m.w, h: m.h, v: m.v.iter().zip(&b.v).map(|(x, y)| x - y).collect() }
}

/// Central-difference gradient magnitude of a map.
fn gradient(m: &Map) -> Map {
    from_fn(m.w, m.h, |x, y| {
        let (x, y) = (x as isize, y as isize);
        (at(m, x + 1, y) - at(m, x - 1, y)).hypot(at(m, x, y + 1) - at(m, x, y - 1))
    })
}

/// Relief of a height map lit from `angle` degrees: the slope along the light times `k`.
fn relief(m: &Map, angle: f32, k: f32) -> Map {
    let (s, c) = angle.to_radians().sin_cos();
    from_fn(m.w, m.h, |x, y| {
        let (x, y) = (x as isize, y as isize);
        let (gx, gy) = ((at(m, x + 1, y) - at(m, x - 1, y)) * 0.5, (at(m, x, y + 1) - at(m, x, y - 1)) * 0.5);
        -(gx * c - gy * s) * k
    })
}

/// The strongest Sobel magnitude over the color channels.
fn sobel(p: &Plane) -> Map {
    let (w, h) = (p.w as isize, p.h as isize);
    let v = |x: isize, y: isize, c: usize| p.data[((y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) * 4) as usize + c];
    from_fn(p.w, p.h, |x, y| {
        let (x, y) = (x as isize, y as isize);
        (0..3).fold(0f32, |m, c| {
            let gx = v(x + 1, y - 1, c) + 2.0 * v(x + 1, y, c) + v(x + 1, y + 1, c) - (v(x - 1, y - 1, c) + 2.0 * v(x - 1, y, c) + v(x - 1, y + 1, c));
            let gy = v(x - 1, y + 1, c) + 2.0 * v(x, y + 1, c) + v(x + 1, y + 1, c) - (v(x - 1, y - 1, c) + 2.0 * v(x, y - 1, c) + v(x + 1, y - 1, c));
            m.max(gx.hypot(gy))
        })
    })
}

/// Sobel edges blurred by `smooth` px and scaled so the strongest is 1.
fn edges(p: &Plane, smooth: f32) -> Map {
    normalized(blurred(&sobel(p), smooth))
}

fn normalized(mut m: Map) -> Map {
    let top = m.v.iter().copied().fold(0f32, f32::max);
    if top > 0.0 {
        m.v.iter_mut().for_each(|v| *v /= top);
    }
    m
}

/// Stroke directions: the structure tensor of the map over `size` px, turned 90 degrees (radians).
fn orientation(m: &Map, size: f32) -> Vec<f64> {
    let g = |x: usize, y: usize| {
        let (x, y) = (x as isize, y as isize);
        ((at(m, x + 1, y) - at(m, x - 1, y)) * 0.5, (at(m, x, y + 1) - at(m, x, y - 1)) * 0.5)
    };
    let r = size.max(1.0);
    let xx = blurred(&from_fn(m.w, m.h, |x, y| g(x, y).0.powi(2)), r);
    let yy = blurred(&from_fn(m.w, m.h, |x, y| g(x, y).1.powi(2)), r);
    let xy = blurred(&from_fn(m.w, m.h, |x, y| g(x, y).0 * g(x, y).1), r);
    (0..m.v.len()).map(|i| 0.5 * f64::from(2.0 * xy.v[i]).atan2(f64::from(xx.v[i] - yy.v[i])) + std::f64::consts::FRAC_PI_2).collect()
}

/// Smears every pixel along its angle over `len` px each way (flat weights).
fn streak(p: &mut Plane, angles: &[f64], len: f64) {
    smear(p, angles, &vec![len; angles.len()], 0.0, (1.0, 0.0), false);
}

fn along(p: &Plane, deg: f64) -> Vec<f64> {
    vec![deg.to_radians(); p.w * p.h]
}

/// A one-channel map smeared like `streak`.
fn streak_map(m: &Map, angles: &[f64], len: f64) -> Map {
    let mut p = Plane { x: 0, y: 0, w: m.w, h: m.h, data: m.v.iter().flat_map(|&v| [v, v, v, 1.0]).collect() };
    streak(&mut p, angles, len);
    map(&p, |c| c[0])
}

/// Each color channel the mean of the disc sector (of `sectors`) around it with the lowest luma
/// variance (a Kuwahara filter); very large runs fall back to a surface blur and posterize.
fn kuwahara(p: &mut Plane, radius: f64, sectors: f64) {
    let r = radius.round().max(1.0) as isize;
    let t = sectors.round().max(4.0) as usize;
    if (p.w * p.h * 4) as f64 * std::f64::consts::PI * (r * r) as f64 >= 32e6 {
        surface(p, r as f64, 0.2, (p.w * p.h) as f64);
        posterize(p, (t * 2).max(12) as f64);
        return;
    }
    let l = luma(p);
    let step = std::f64::consts::TAU / t as f64;
    let taps: Vec<(isize, isize, usize)> = (-r..=r)
        .flat_map(|dy| (-r..=r).map(move |dx| (dx, dy)))
        .filter(|&(dx, dy)| dx * dx + dy * dy <= r * r && (dx, dy) != (0, 0))
        .map(|(dx, dy)| (dx, dy, (((dy as f64).atan2(dx as f64) + std::f64::consts::PI) / step).floor().min((t - 1) as f64) as usize))
        .collect();
    let mut count = vec![0usize; t];
    taps.iter().for_each(|&(_, _, s)| count[s] += 1);
    let (w, h) = (p.w as isize, p.h as isize);
    let src = p.data.clone();
    let (mut sum, mut sq, mut mean) = (vec![0f64; t * 3], vec![0f64; t], vec![0f64; t]);
    for y in 0..h {
        for x in 0..w {
            sum.fill(0.0);
            sq.fill(0.0);
            mean.fill(0.0);
            for &(dx, dy, s) in &taps {
                let j = ((y + dy).clamp(0, h - 1) * w + (x + dx).clamp(0, w - 1)) as usize;
                (0..3).for_each(|c| sum[s * 3 + c] += f64::from(src[j * 4 + c]));
                let b = f64::from(l.v[j]);
                sq[s] += b * b;
                mean[s] += b;
            }
            let best = (0..t).filter(|&s| count[s] > 0).min_by(|&a, &b| {
                let var = |s: usize| sq[s] / count[s] as f64 - (mean[s] / count[s] as f64).powi(2);
                var(a).total_cmp(&var(b))
            });
            if let Some(s) = best {
                let i = (y * w + x) as usize * 4;
                (0..3).for_each(|c| p.data[i + c] = (sum[s * 3 + c] / count[s] as f64) as f32);
            }
        }
    }
}

/// Voronoi cells of about `size` px, one jittered site per grid cell anchored to the document.
struct Cells {
    owner: Vec<usize>,
    keys: Vec<(i32, i32)>,
    count: usize,
}

fn cells(p: &Plane, size: f64, seed: u32, jitter: f64) -> Cells {
    let q = size.max(1.0);
    let cell = |v: i32| (f64::from(v) / q).floor() as i32;
    let (cx0, cy0) = (cell(p.x) - 1, cell(p.y) - 1);
    let (nx, ny) = ((cell(p.x + p.w as i32) + 1 - cx0 + 1) as usize, (cell(p.y + p.h as i32) + 1 - cy0 + 1) as usize);
    let site = |cx: i32, cy: i32| {
        let j = |c| (f64::from(hash(seed, cx, cy, c)) - 0.5) * jitter;
        ((f64::from(cx) + 0.5 + j(1)) * q, (f64::from(cy) + 0.5 + j(2)) * q)
    };
    let mut owner = vec![0usize; p.w * p.h];
    for y in 0..p.h {
        let dy = f64::from(p.y) + y as f64;
        let gy = cell(p.y + y as i32);
        for x in 0..p.w {
            let dx = f64::from(p.x) + x as f64;
            let gx = cell(p.x + x as i32);
            let mut best = (f64::INFINITY, 0usize);
            for cy in gy - 1..=gy + 1 {
                for cx in gx - 1..=gx + 1 {
                    let (sx, sy) = site(cx, cy);
                    let d = (sx - dx).powi(2) + (sy - dy).powi(2);
                    if d < best.0 {
                        best = (d, (cy - cy0) as usize * nx + (cx - cx0) as usize);
                    }
                }
            }
            owner[y * p.w + x] = best.1;
        }
    }
    let keys = (0..nx * ny).map(|k| (cx0 + (k % nx) as i32, cy0 + (k / nx) as i32)).collect();
    Cells { owner, keys, count: nx * ny }
}

/// Every pixel takes its cell's mean over all four channels.
fn cell_mean(p: &mut Plane, c: &Cells) {
    let (mut sum, mut n) = (vec![0f64; c.count * 4], vec![0f64; c.count]);
    for (px, &o) in p.data.chunks_exact(4).zip(&c.owner) {
        n[o] += 1.0;
        (0..4).for_each(|k| sum[o * 4 + k] += f64::from(px[k]));
    }
    for (px, &o) in p.data.chunks_exact_mut(4).zip(&c.owner) {
        (0..4).for_each(|k| px[k] = (sum[o * 4 + k] / n[o]) as f32);
    }
}

/// 1 where the right or lower neighbor belongs to another cell.
fn borders(c: &Cells, w: usize, h: usize) -> Map {
    from_fn(w, h, |x, y| {
        let o = c.owner[y * w + x];
        let r = if x + 1 < w { c.owner[y * w + x + 1] } else { o };
        let d = if y + 1 < h { c.owner[(y + 1) * w + x] } else { o };
        f32::from(u8::from(o != r || o != d))
    })
}

/// Samples the plane (bilinear, edges clamped) at `src(x, y)` for every pixel.
fn displace(p: &mut Plane, src: impl Fn(f64, f64) -> (f64, f64)) {
    let old = p.data.clone();
    for y in 0..p.h {
        for x in 0..p.w {
            let (sx, sy) = src(x as f64, y as f64);
            let ((ix, fx), (iy, fy)) = (split(sx), split(sy));
            for c in 0..4 {
                p.data[(y * p.w + x) * 4 + c] = bilinear(&old, p.w, p.h, ix, iy, fx, fy, c);
            }
        }
    }
}

/// Displaces along the slope of a height map by `k`.
fn bump(p: &mut Plane, m: &Map, k: f64) {
    if k == 0.0 {
        return;
    }
    displace(p, |x, y| {
        let (i, j) = (x as isize, y as isize);
        (x + f64::from(at(m, i + 1, j) - at(m, i - 1, j)) * k, y + f64::from(at(m, i, j + 1) - at(m, i, j - 1)) * k)
    });
}

/// Brick, burlap, canvas or sandstone, 0..1, `scaling` % and anchored to the document.
fn texture(kind: &str, w: usize, h: usize, scaling: f64, fx: &Fx) -> Map {
    let b = 100.0 / scaling.max(1.0);
    let s = fx.seed;
    from_fn(w, h, |x, y| {
        let (u, v) = ((f64::from(fx.ox) + x as f64) * b, (f64::from(fx.oy) + y as f64) * b);
        let h1 = |c| f64::from(hash(s, u.floor() as i32, v.floor() as i32, c));
        let n = |s, k: f64| f64::from(noise(s, u * k, v * k));
        let t = match kind {
            "brick" => {
                let off = if (v / 12.0).floor().rem_euclid(2.0) == 0.0 { 0.0 } else { 14.0 };
                let (bx, by) = ((u + off).rem_euclid(28.0), v.rem_euclid(12.0));
                0.25 + f64::from(smoothstep(0.0, 1.6, bx.min(28.0 - bx).min(by).min(12.0 - by) as f32)) * 0.6 + h1(71) * 0.15
            }
            "burlap" => {
                let (a, c) = ((u * 0.7).sin().abs() > 0.5, (v * 0.7).sin().abs() > 0.5);
                (if a == c { 0.75 } else { 0.35 }) + n(s, 0.35) * 0.25
            }
            "sandstone" => 0.35 + n(s, 0.5) * 0.5 + n(s.wrapping_add(7), 1.7) * 0.3 + h1(73) * 0.2,
            "frosted" => n(s, 0.6),
            "tinyLens" => {
                let d = (u.rem_euclid(12.0) - 6.0).hypot(v.rem_euclid(12.0) - 6.0) / 6.0;
                if d >= 1.0 { 0.0 } else { (1.0 - d * d).sqrt() }
            }
            _ => 0.4 + ((u * 1.6).sin() * 0.5 + 0.5) * ((v * 1.6).sin() * 0.5 + 0.5) * 0.4 + n(s, 0.8) * 0.2,
        };
        clamp01(t as f32)
    })
}

fn light_angle(dir: &str) -> f32 {
    match dir {
        "right" => 0.0,
        "topRight" => 45.0,
        "topLeft" => 135.0,
        "left" => 180.0,
        "bottomLeft" => 225.0,
        "bottom" => 270.0,
        "bottomRight" => 315.0,
        _ => 90.0,
    }
}

/// Embosses a texture into the color: `relief` x 3 along the light (Texturizer and its users).
fn texturize(p: &mut Plane, kind: &str, scaling: f64, relief_amt: f64, light: &str, invert: bool, fx: &Fx) {
    if relief_amt <= 0.0 {
        return;
    }
    let mut t = texture(kind, p.w, p.h, scaling, fx);
    if invert {
        t.v.iter_mut().for_each(|v| *v = 1.0 - *v);
    }
    let r = relief(&t, light_angle(light), relief_amt as f32 * 3.0);
    each(p, &r, |c, v| clamp01(c + v));
}

/// Paper grain: value noise of `scale` px mixed with per-pixel noise.
fn grain_map(w: usize, h: usize, scale: f64, fx: &Fx) -> Map {
    let o = 1.0 / scale.max(0.5);
    from_fn(w, h, |x, y| {
        let (dx, dy) = (fx.ox + x as i32, fx.oy + y as i32);
        clamp01(noise(fx.seed, f64::from(dx) * o, f64::from(dy) * o) * 0.7 + hash(fx.seed, dx, dy, 3) * 0.3)
    })
}

/// Hatching: strokes of `len` x `width` px at `angle` degrees, each with a random tone.
fn strokes(w: usize, h: usize, angle: f64, len: f64, width: f64, seed: u32, fx: &Fx) -> Map {
    let (s, c) = angle.to_radians().sin_cos();
    let (n, k) = (len.max(1.0), width.max(1.0));
    from_fn(w, h, |x, y| {
        let (dx, dy) = (f64::from(fx.ox) + x as f64, f64::from(fx.oy) + y as f64);
        let (l, v) = (dx * c + dy * s, -dx * s + dy * c);
        let tone = f64::from(hash(seed, (l / n).floor() as i32, (v / k).floor() as i32, 5));
        let across = (v.rem_euclid(k) / k - 0.5).abs() * 2.0;
        clamp01((tone * (1.0 - across * 0.7)) as f32)
    })
}
