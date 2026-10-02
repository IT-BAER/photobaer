//! Render group (docs/M5.md sections 3 and 14). The runner hands render filters the document rect
//! as `Ctx::bounds`, so they also draw on an empty layer. Clouds and Fibers are value noise on the
//! document lattice and render tile-exact; Tree and Flame build shapes from a seeded generator and
//! paint them as anti-aliased polygons.

use std::f64::consts::{PI, TAU};

use serde_json::{json, Value};

use super::blur::gaussian_all;
use super::{hash, parse_hex, Ctx, Filter, Plane, Rng};
use crate::selection::{Polygon, Shape};

// The document rect in plane px and the plane px per document px.
pub(super) struct Frame {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub s: f64,
}

impl Frame {
    pub fn of(ctx: &Ctx) -> Frame {
        let (b, s) = (ctx.bounds, ctx.scale);
        Frame { x: f64::from(b[0]) * s, y: f64::from(b[1]) * s, w: f64::from(b[2]) * s, h: f64::from(b[3]) * s, s }
    }

    pub fn short(&self) -> f64 {
        self.w.min(self.h).max(1.0)
    }

    // A point given as fractions of the rect, in plane px.
    pub fn at(&self, fx: f64, fy: f64) -> (f64, f64) {
        (self.x + fx * self.w, self.y + fy * self.h)
    }
}

fn smooth(t: f64) -> f64 {
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}

// Value noise in 0..1 between the hashed integer lattice points around (u, v).
pub(super) fn value_noise(seed: u32, u: f64, v: f64) -> f64 {
    let (i, j) = (u.floor(), v.floor());
    let (fu, fv) = (smooth(u - i), smooth(v - j));
    let (i, j) = (i as i32, j as i32);
    let n = |a: i32, b: i32| f64::from(hash(seed, a, b, 0));
    let top = n(i, j) + (n(i + 1, j) - n(i, j)) * fu;
    let bot = n(i, j + 1) + (n(i + 1, j + 1) - n(i, j + 1)) * fu;
    top + (bot - top) * fv
}

// Octaves of value noise at doubling frequency and halving weight, normalized to 0..1.
fn fbm(seed: u32, u: f64, v: f64, octaves: u32) -> f64 {
    let (mut sum, mut amp, mut norm, mut f) = (0.0, 1.0, 0.0, 1.0);
    for o in 0..octaves {
        sum += value_noise(seed.wrapping_add(o.wrapping_mul(0x9e37_79b9)), u * f, v * f) * amp;
        norm += amp;
        amp *= 0.5;
        f *= 2.0;
    }
    sum / norm
}

// Writes `px(pixel, v)` for every pixel with `v` from `field(doc x, doc y)`.
fn per_doc_px(p: &mut Plane, s: f64, field: impl Fn(f64, f64) -> f32, px: impl Fn(&mut [f32], f32)) {
    for j in 0..p.h {
        for i in 0..p.w {
            let v = field(f64::from(p.x + i as i32) / s, f64::from(p.y + j as i32) / s);
            px(&mut p.data[(j * p.w + i) * 4..][..4], v);
        }
    }
}

// Clouds in 0..1: six octaves over a lattice of a quarter of the short document side (16 px at least).
fn clouds_at(f: &Filter, ctx: &Ctx) -> impl Fn(f64, f64) -> f32 {
    let period = (f64::from(ctx.bounds[2].min(ctx.bounds[3])) / 4.0).max(16.0);
    let seed = f.num("seed") as u32;
    move |x, y| ((fbm(seed, x / period, y / period, 6) - 0.5) * 2.5 + 0.5).clamp(0.0, 1.0) as f32
}

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    std::array::from_fn(|c| a[c] + (b[c] - a[c]) * t)
}

/// Clouds between the foreground and background colors, opaque.
pub fn clouds(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let (fg, bg) = (f.color("foreground"), f.color("background"));
    per_doc_px(p, ctx.scale, clouds_at(f, ctx), |px, v| {
        px[..3].copy_from_slice(&mix(fg, bg, v));
        px[3] = 1.0;
    });
    Ok(())
}

/// Clouds in Difference over the pixels (transparent counts as black), opaque.
pub fn difference_clouds(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let (fg, bg) = (f.color("foreground"), f.color("background"));
    per_doc_px(p, ctx.scale, clouds_at(f, ctx), |px, v| {
        let c = mix(fg, bg, v);
        for k in 0..3 {
            px[k] = (px[k] * px[3] - c[k]).abs();
        }
        px[3] = 1.0;
    });
    Ok(())
}

/// Vertical fibers: noise stretched along y by `strength`, with `variance` setting the column
/// frequency and contrast; opaque between the two colors.
pub fn fibers(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let (fg, bg, seed) = (f.color("foreground"), f.color("background"), f.num("seed") as u32);
    let (var, strength) = (f.num("variance"), f.num("strength"));
    let (fx, fy, k) = (0.3 + var / 40.0, 1.0 / (strength * 3.0), 1.0 + var / 24.0);
    let field = move |x: f64, y: f64| {
        let n = fbm(seed, x * fx, y * fy, 3) * 0.7 + f64::from(hash(seed, (x * fx).floor() as i32, 0, 13)) * 0.3;
        ((n - 0.5) * 2.0 * k + 0.5).clamp(0.0, 1.0) as f32
    };
    per_doc_px(p, ctx.scale, field, |px, v| {
        px[..3].copy_from_slice(&mix(fg, bg, v));
        px[3] = 1.0;
    });
    Ok(())
}

// A lens: ray count, halo and streak weights, and ghosts (offset along the axis through the image
// center, radius per short side, color, strength).
struct Lens {
    rays: f64,
    halo: f64,
    streak: f64,
    ghosts: &'static [(f64, f64, [f32; 3], f64)],
}

fn lens(t: &str) -> Lens {
    match t {
        "prime35" => Lens { rays: 6.0, halo: 0.8, streak: 0.0, ghosts: &[(0.4, 0.05, [0.4, 0.9, 0.5], 0.32), (0.75, 0.08, [0.95, 0.55, 0.3], 0.28), (1.3, 0.13, [0.4, 0.6, 1.0], 0.22)] },
        "prime105" => Lens { rays: 8.0, halo: 0.55, streak: 0.0, ghosts: &[(0.55, 0.04, [1.0, 0.8, 0.45], 0.36), (1.15, 0.07, [0.5, 0.8, 1.0], 0.28)] },
        "moviePrime" => Lens { rays: 4.0, halo: 0.35, streak: 1.0, ghosts: &[(0.85, 0.06, [0.5, 0.7, 1.0], 0.3)] },
        _ => Lens {
            rays: 12.0,
            halo: 1.0,
            streak: 0.0,
            ghosts: &[(0.3, 0.035, [1.0, 0.45, 0.4], 0.3), (0.6, 0.06, [0.45, 1.0, 0.55], 0.28), (1.0, 0.09, [0.45, 0.6, 1.0], 0.28), (1.45, 0.15, [1.0, 0.85, 0.55], 0.18)],
        },
    }
}

fn smoothstep(a: f64, b: f64, x: f64) -> f64 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// A flare at `center` (fractions of the document) screened over the pixels: a warm core with
/// rays, a halo ring and a streak, plus colored ghosts toward the image center. Alpha rises with
/// the flare, so it also shows on transparency.
pub fn lens_flare(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let (l, b, e) = (lens(f.text("lensType")), f.num("brightness") / 100.0, fr.short());
    let (fx, fy) = f.point("center");
    let (cx, cy) = fr.at(fx, fy);
    let (mx, my) = fr.at(0.5, 0.5);
    for j in 0..p.h {
        for i in 0..p.w {
            let (x, y) = (f64::from(p.x + i as i32) + 0.5, f64::from(p.y + j as i32) + 0.5);
            let (dx, dy) = (x - cx, y - cy);
            let r = dx.hypot(dy) / e;
            let mut main = (-(r * 28.0).powi(2)).exp() * 1.5 + (-r * 7.0).exp() * 0.4;
            main += (dy.atan2(dx) * l.rays / 2.0).cos().abs().powi(10) * (-r * 4.5).exp() * 0.5;
            main += (-((r - 0.24) * 20.0).powi(2)).exp() * 0.2 * l.halo;
            main += (-(dy / (e * 0.005)).powi(2)).exp() * (-dx.abs() / (e * 0.45)).exp() * 0.6 * l.streak;
            let mut keep = [1f64; 3];
            for (k, w) in [0.88f64, 0.96, 1.0].iter().enumerate() {
                keep[k] *= 1.0 - (main * b * w).min(1.0);
            }
            for &(off, rad, col, st) in l.ghosts {
                let (gx, gy, gr) = (cx + (mx - cx) * off, cy + (my - cy) * off, rad * e);
                let d = (x - gx).hypot(y - gy);
                let g = ((1.0 - smoothstep(gr * 0.85, gr, d)) * 0.5 + (-((d - gr * 0.9) / (gr * 0.12).max(1.0)).powi(2)).exp() * 0.6) * st * b;
                for k in 0..3 {
                    keep[k] *= 1.0 - (g * f64::from(col[k])).min(1.0);
                }
            }
            let px = &mut p.data[(j * p.w + i) * 4..][..4];
            let a = px[3];
            let na = 1.0 - (1.0 - a) * keep.iter().copied().fold(1.0f64, f64::min) as f32;
            for k in 0..3 {
                let c = 1.0 - (1.0 - px[k] * a) * keep[k] as f32;
                px[k] = if na > 0.0 { (c / na).min(1.0) } else { 0.0 };
            }
            px[3] = na;
        }
    }
    Ok(())
}

/// The fields of one light, as stored.
pub(crate) const LIGHT_KEYS: [&str; 10] = ["type", "intensity", "hotspot", "x", "y", "z", "targetX", "targetY", "color", "enabled"];

pub(crate) fn default_light() -> Value {
    json!({ "type": "spot", "intensity": 100.0, "hotspot": 0.6, "x": 0.3, "y": 0.3, "z": 0.6, "targetX": 0.6, "targetY": 0.6, "color": "#ffffff", "enabled": true })
}

/// One stored light with missing fields from the default light; positions are fractions of the
/// document, `z` the height above it per short side.
pub(crate) fn check_light(v: &Value) -> Result<Value, String> {
    let o = v.as_object().ok_or("must be objects { type, intensity, hotspot, x, y, z, targetX, targetY, color, enabled }")?;
    let mut out = default_light();
    for (k, val) in o {
        let num = |lo: f64, hi: f64| val.as_f64().filter(|n| (lo..=hi).contains(n)).map(|n| json!(n));
        let ok = match k.as_str() {
            "type" => val.as_str().filter(|t| ["point", "spot", "infinite"].contains(t)).map(|t| json!(t)),
            "enabled" => val.as_bool().map(Value::Bool),
            "color" => val.as_str().filter(|c| parse_hex(c).is_some()).map(|c| json!(c.to_ascii_lowercase())),
            "intensity" => num(-100.0, 100.0),
            "z" => num(0.01, 1.0),
            k if LIGHT_KEYS.contains(&k) => num(0.0, 1.0),
            _ => return Err(format!("has an unknown field \"{k}\"")),
        };
        out[k.as_str()] = ok.ok_or_else(|| format!("{k} is not valid: {val}"))?;
    }
    Ok(out)
}

struct Light {
    kind: String,
    power: f64,
    hotspot: f64,
    pos: [f64; 3],
    target: (f64, f64),
    color: [f64; 3],
}

fn norm(v: [f64; 3]) -> [f64; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt().max(1e-9);
    [v[0] / l, v[1] / l, v[2] / l]
}

fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

// The texture channel as a height field in 0..1, softened, or None.
fn heights(p: &Plane, f: &Filter) -> Option<Vec<f32>> {
    let ch = f.text("textureChannel");
    let pick: fn(&[f32]) -> f32 = match ch {
        "red" => |q| q[0],
        "green" => |q| q[1],
        "blue" => |q| q[2],
        "luminance" => |q| 0.299 * q[0] + 0.587 * q[1] + 0.114 * q[2],
        _ => return None,
    };
    let inv = f.flag("invertTexture");
    let mut t = Plane { data: p.data.chunks_exact(4).flat_map(|q| [if inv { 1.0 - pick(q) } else { pick(q) }, 0.0, 0.0, 1.0]).collect(), ..p.clone() };
    gaussian_all(&mut t, 3.0);
    Some(t.data.chunks_exact(4).map(|q| q[0]).collect())
}

/// Lights (point, spot, infinite) over the pixels with ambient light, a gloss highlight tinted
/// toward the pixel color by `material`, `exposure` as stops/2, and an optional texture channel as
/// relief. No lights at ambience 100 leaves the pixels as they are.
pub fn lighting_effects(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let e = fr.short();
    let lights: Vec<Light> = f.params["lights"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|l| l["enabled"].as_bool() != Some(false))
        .map(|l| {
            let n = |k: &str| l[k].as_f64().unwrap_or(0.0);
            let (x, y) = fr.at(n("x"), n("y"));
            let c = parse_hex(l["color"].as_str().unwrap_or("#ffffff")).unwrap_or([1.0; 3]);
            Light { kind: l["type"].as_str().unwrap_or("spot").into(), power: n("intensity") / 100.0, hotspot: n("hotspot"), pos: [x, y, n("z") * e], target: fr.at(n("targetX"), n("targetY")), color: c.map(f64::from) }
        })
        .collect();
    let amb = f.num("ambience") / 100.0;
    let expo = 2f64.powf(f.num("exposure") / 50.0);
    let metal = ((f.num("material") + 100.0) / 200.0) as f32;
    let gloss = f.num("gloss");
    let (shine, spec_w) = (2f64.powf(3.0 + gloss / 25.0), 0.5 * (gloss + 100.0) / 200.0);
    let hf = heights(p, f);
    let bump = f.num("textureHeight") / 100.0 * 4.0;
    let (w, h) = (p.w as isize, p.h as isize);
    let hat = |hf: &[f32], i: isize, j: isize| f64::from(hf[(j.clamp(0, h - 1) * w + i.clamp(0, w - 1)) as usize]);
    for j in 0..h {
        for i in 0..w {
            let n = hf.as_deref().map_or([0.0, 0.0, 1.0], |hf| norm([-(hat(hf, i + 1, j) - hat(hf, i - 1, j)) * bump, -(hat(hf, i, j + 1) - hat(hf, i, j - 1)) * bump, 1.0]));
            let (x, y) = (f64::from(p.x + i as i32) + 0.5, f64::from(p.y + j as i32) + 0.5);
            let (mut lit, mut spec) = ([amb; 3], [0f64; 3]);
            for l in &lights {
                let to = [l.pos[0] - x, l.pos[1] - y, l.pos[2]];
                let dist = dot(to, to).sqrt().max(1e-9);
                let (dir, att) = match l.kind.as_str() {
                    "infinite" => (norm([l.pos[0] - l.target.0, l.pos[1] - l.target.1, l.pos[2]]), 1.0),
                    "point" => (norm(to), 1.0 / (1.0 + 4.0 * (dist / e).powi(2))),
                    _ => {
                        let d = norm(to);
                        let axis = norm([l.target.0 - l.pos[0], l.target.1 - l.pos[1], -l.pos[2]]);
                        let half = (20.0 + 60.0 * l.hotspot).to_radians();
                        (d, smoothstep(half.cos(), (half * 0.5).cos(), -dot(d, axis)) / (1.0 + (dist / e).powi(2)))
                    }
                };
                let k = l.power * att;
                let diff = dot(n, dir).max(0.0) * k;
                let s = dot(n, norm([dir[0], dir[1], dir[2] + 1.0])).max(0.0).powf(shine) * k * spec_w;
                for c in 0..3 {
                    lit[c] += diff * l.color[c];
                    spec[c] += s * l.color[c];
                }
            }
            let px = &mut p.data[((j * w + i) * 4) as usize..][..3];
            for c in 0..3 {
                px[c] = px[c] * (lit[c] * expo) as f32 + spec[c] as f32 * (metal * px[c] + 1.0 - metal);
            }
        }
    }
    Ok(())
}

// Normal blending of `col` at `k` over a straight pixel.
fn over(px: &mut [f32], col: [f32; 3], k: f32) {
    let a = k + px[3] * (1.0 - k);
    for c in 0..3 {
        px[c] = if a > 0.0 { (col[c] * k + px[c] * px[3] * (1.0 - k)) / a } else { 0.0 };
    }
    px[3] = a;
}

// Paints the polygon `pts` (flat plane px, even-odd) anti-aliased in `col` at opacity `k`.
fn fill(p: &mut Plane, pts: &[f64], col: [f32; 3], k: f32) {
    let Ok(poly) = Polygon::new(pts, true) else { return };
    let (x0, y0, x1, y1) = poly.bounds();
    let (px1, py1) = (p.x + p.w as i32, p.y + p.h as i32);
    let (i0, i1) = ((x0.floor() as i32).max(p.x), (x1.ceil() as i32).min(px1));
    let (j0, j1) = ((y0.floor() as i32).max(p.y), (y1.ceil() as i32).min(py1));
    if i0 >= i1 || j0 >= j1 {
        return;
    }
    let mut row = vec![0f32; (i1 - i0) as usize];
    for y in j0..j1 {
        poly.row(y, i0, &mut row);
        let base = (y - p.y) as usize * p.w + (i0 - p.x) as usize;
        for (n, &c) in row.iter().enumerate().filter(|(_, c)| **c > 0.0) {
            over(&mut p.data[(base + n) * 4..][..4], col, c * k);
        }
    }
}

// One flame: a tongue of `len` along angle `a` (0 = up) and half-width `w`, its edges wobbling
// with `jag` at frequency `turb`.
fn flame_shape(x: f64, y: f64, len: f64, w: f64, a: f64, jag: f64, turb: f64, seed: u32) -> Vec<f64> {
    let (ux, uy, nx, ny) = (a.sin(), -a.cos(), a.cos(), a.sin());
    let (mut left, mut right) = (Vec::new(), Vec::new());
    for k in 0..=20 {
        let t = f64::from(k) / 20.0;
        let prof = (PI * t.powf(0.65)).sin() * (1.0 - 0.4 * t) * w;
        let wob = |s: u32| (value_noise(seed.wrapping_add(s), t * turb * 1.5, 0.0) - 0.5) * jag * w * 2.5;
        let (l, r) = (wob(0), wob(1));
        let (cx, cy) = (x + ux * t * len + nx * l * 0.5, y + uy * t * len + ny * l * 0.5);
        left.extend([cx - nx * (prof - l), cy - ny * (prof - l)]);
        right.push([cx + nx * (prof + r), cy + ny * (prof + r)]);
    }
    left.extend(right.into_iter().rev().flatten());
    left
}

/// Flames along `path` (fractions of the document): one per segment (one flame, candle) or one
/// every `interval`, pointing at `angle` (0 = up) plus the path direction, a random spread or an
/// arc fan; each draws `flameLines / 4` nested tongues from red outside to pale yellow inside.
pub fn flame(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let e = fr.short();
    let path: Vec<(f64, f64)> = f.params["path"].as_array().into_iter().flatten().map(|q| fr.at(q["x"].as_f64().unwrap_or(0.0), q["y"].as_f64().unwrap_or(0.0))).collect();
    let mut rng = Rng::new(f.num("seed") as u32);
    let kind = f.text("flameType");
    let (single, candle) = (kind == "oneFlameAlongPath" || kind == "candle", kind == "candle");
    let size = if candle { 0.6 } else { 1.0 };
    let (len, wid) = (f.num("length") / 100.0 * e * 0.45 * size, f.num("width") / 100.0 * e * 0.04 * size);
    let gap = (f.num("interval") / 100.0 * e * 0.25).max(2.0 * fr.s);
    let base = f.num("angle").to_radians();
    let mut at = Vec::new();
    for s in path.windows(2) {
        let ((x0, y0), (x1, y1)) = (s[0], s[1]);
        if single {
            at.push(((x0 + x1) / 2.0, (y0 + y1) / 2.0, base));
            continue;
        }
        let n = (((x1 - x0).hypot(y1 - y0) / gap).floor() as usize).max(1);
        for k in 0..n {
            let t = if n == 1 { 0.5 } else { k as f64 / (n - 1) as f64 };
            let turn = match kind {
                "multipleFlamesPathDirection" => (y1 - y0).atan2(x1 - x0),
                "multipleFlamesVarious" => rng.range(-0.6, 0.6),
                "arc" => (t - 0.5) * 1.2,
                _ => 0.0,
            };
            at.push((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, base + turn));
        }
    }
    let lines = (f.num("flameLines") / 4.0).round().max(1.0) as usize;
    let (jag, turb, opacity) = (f.num("jagAmount") / 10.0, f.num("turbulentAmount"), f.num("opacity") / 100.0);
    let custom = f.flag("useCustomColor").then(|| f.color("foreground"));
    for (x, y, a) in at {
        for l in 0..lines {
            let t = if lines == 1 { 1.0 } else { l as f64 / (lines - 1) as f64 };
            let h = len * (0.55 + 0.45 * (1.0 - t)) * rng.range(0.85, 1.15);
            let w = wid * (1.0 - 0.65 * t) * rng.range(0.85, 1.15);
            let pts = flame_shape(x, y, h, w, a, jag, turb, (rng.next() * 1e6) as u32);
            let col = custom.unwrap_or([1.0, (0.25 + 0.65 * t) as f32, (0.04 + 0.7 * t) as f32]);
            fill(p, &pts, col, (opacity * (0.35 + 0.5 * t)) as f32);
        }
    }
    Ok(())
}

// An ornament's coverage at `along` the band and depth `d` into a frame `fw` wide, repeating every `period`.
fn ornament(kind: &str, along: f64, d: f64, fw: f64, period: f64) -> bool {
    let m = along.rem_euclid(period);
    match kind {
        "doubleLine" => {
            let t = (fw * 0.06).max(0.5);
            (d - fw / 3.0).abs() < t || (d - fw * 2.0 / 3.0).abs() < t
        }
        "beads" => (m - period / 2.0).hypot(d - fw / 2.0) < fw * 0.3,
        "ivy" => (d - fw / 2.0 - (along / period * TAU).sin() * fw * 0.28).abs() < fw * 0.1,
        "ribbon" => (along + d).rem_euclid(period) < period / 2.0,
        "scallop" => (m - period / 2.0).hypot(d - fw) < (period / 2.0).min(fw),
        _ => false,
    }
}

/// A frame band `frameWidth` % of the short side at the document edges with a matte band
/// `margin` % inside it; ornaments in the matte color decorate the frame.
pub fn picture_frame(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let e = fr.short();
    let (margin, fw) = ((f.num("margin") / 100.0 * e).round(), (f.num("frameWidth") / 100.0 * e).round().max(1.0));
    let frame_c = match f.text("frameColor") {
        "gilt" => [0.79, 0.64, 0.15],
        "black" => [0.1; 3],
        "white" => [0.96; 3],
        _ => [0.23, 0.16, 0.11],
    };
    let matte_c = match f.text("matteColor") {
        "white" => [1.0; 3],
        "charcoal" => [0.06; 3],
        _ => [0.95, 0.93, 0.88],
    };
    let (rows, cols) = (f.text("arrangement") != "vertical", f.text("arrangement") != "horizontal");
    let density = f.num("ornamentDensity") / 100.0;
    let kind = f.text("frameType");
    let period = (fw * (1.6 - density)).max(4.0);
    for j in 0..p.h {
        for i in 0..p.w {
            let (u, v) = (f64::from(p.x + i as i32) + 0.5 - fr.x, f64::from(p.y + j as i32) + 0.5 - fr.y);
            let (mut d, mut along) = (f64::INFINITY, 0.0);
            if cols {
                (d, along) = (u.min(fr.w - u), v);
            }
            if rows && v.min(fr.h - v) < d {
                (d, along) = (v.min(fr.h - v), u);
            }
            let px = &mut p.data[(j * p.w + i) * 4..][..4];
            if d < fw {
                over(px, frame_c, 1.0);
                if density > 0.0 && ornament(kind, along, d, fw, period) {
                    let grain = 0.4 + 0.6 * hash(0x5eed, (u / fr.s) as i32, (v / fr.s) as i32, 61);
                    over(px, matte_c, 0.85 * grain);
                }
            } else if d < fw + margin {
                over(px, matte_c, 1.0);
            }
        }
    }
    Ok(())
}

// Branch spread (rad), length ratio per level, splits, droop (rad) and leaf spread (rad).
fn species(t: &str) -> (f64, f64, u32, f64, f64) {
    match t {
        "birch" => (0.4, 0.75, 2, 0.0, 0.7),
        "poplar" => (0.22, 0.8, 2, -0.1, 0.45),
        "oak" => (0.7, 0.66, 3, 0.05, 1.2),
        "willow" => (0.5, 0.78, 2, 0.6, 1.1),
        "pine" => (0.9, 0.6, 2, 0.35, 0.4),
        _ => (0.55, 0.7, 2, 0.05, 1.0),
    }
}

struct Grower {
    rng: Rng,
    spec: (f64, f64, u32, f64, f64),
    random: bool,
    leaf_chance: f64,
    leaf_size: f64,
    light: (f64, f64),
    min: f64,
    bark: Vec<(Vec<f64>, f32)>,
    leaves: Vec<Vec<f64>>,
}

impl Grower {
    fn grow(&mut self, x: f64, y: f64, a: f64, len: f64, w: f64, depth: u32) {
        let (spread, ratio, splits, droop, leaf) = self.spec;
        if depth > 7 || len < 2.0 * self.min || w < 0.35 * self.min {
            let (r, rot) = (self.rng.next(), a + self.rng.range(-leaf, leaf));
            if r < self.leaf_chance {
                let s = self.leaf_size;
                self.leaves.push((0..8).flat_map(|k| {
                    let t = f64::from(k) / 8.0 * TAU;
                    let (lx, ly) = (t.cos() * s * 0.45, t.sin() * s);
                    [x + lx * rot.cos() - ly * rot.sin(), y + lx * rot.sin() + ly * rot.cos()]
                }).collect());
            }
            return;
        }
        let (ex, ey, cx, cy, w2) = (x + a.sin() * len, y - a.cos() * len, a.cos(), a.sin(), w * ratio);
        let shade = 0.35 + 0.65 * (cx * self.light.0 + cy * self.light.1).max(0.0);
        self.bark.push((vec![x - cx * w, y - cy * w, x + cx * w, y + cy * w, ex + cx * w2, ey + cy * w2, ex - cx * w2, ey - cy * w2], shade as f32));
        let n = splits + u32::from(self.random && self.rng.next() < 0.3);
        for k in 0..n {
            let off = if n == 1 { 0.0 } else { spread * (f64::from(k) / f64::from(n - 1) * 2.0 - 1.0) };
            let jitter = if self.random { self.rng.range(-0.25, 0.25) } else { self.rng.range(-0.08, 0.08) };
            let next = len * ratio * self.rng.range(0.85, 1.05);
            self.grow(ex, ey, a + off + jitter + droop * if off < 0.0 { -1.0 } else { 1.0 }, next, w2, depth + 1);
        }
    }
}

/// A tree from the bottom center of the document: recursive branches shaded by the light
/// direction, leaves at the tips; `arrangement` picks the variation.
pub fn tree(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let fr = Frame::of(ctx);
    let e = fr.short();
    let light = f.num("lightDirection").to_radians();
    let mut g = Grower {
        rng: Rng::new((f.num("arrangement") as u32).wrapping_mul(7919).wrapping_add(17)),
        spec: species(f.text("treeType")),
        random: f.flag("randomizeShapes"),
        leaf_chance: if f.flag("defoliate") { 0.0 } else { f.num("leavesAmount") / 100.0 },
        leaf_size: (f.num("leavesSize") / 100.0 * e * 0.035).max(1.5 * fr.s),
        light: (light.cos(), -light.sin()),
        min: fr.s,
        bark: Vec::new(),
        leaves: Vec::new(),
    };
    let trunk = f.num("branchesHeight") / 100.0 * fr.h * 0.25;
    let thick = (f.num("branchesThickness") / 100.0 * e * 0.05).max(fr.s);
    let (x, y) = fr.at(0.5, 0.96);
    g.grow(x, y, 0.0, trunk, thick, 0);
    for (pts, shade) in &g.bark {
        fill(p, pts, [0.32 * shade, 0.23 * shade, 0.16 * shade], 1.0);
    }
    for pts in &g.leaves {
        let l = g.rng.range(0.7, 1.15) as f32;
        fill(p, pts, [0.22 * l, 0.48 * l, 0.2 * l], 0.9);
    }
    Ok(())
}
