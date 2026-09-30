//! Distort group (docs/M5.md sections 3 and 14). Each filter maps an output pixel to a source point
//! and samples a copy of the premultiplied plane bilinearly; "keep" means the source is the pixel itself.

use std::f64::consts::{FRAC_2_PI, FRAC_PI_2, PI, TAU};

use super::blur::premultiplied;
use super::{hash, Ctx, Filter, Plane};

#[derive(Clone, Copy)]
enum Edge {
    Clamp,
    Wrap,
}

fn edge(f: &Filter) -> Edge {
    if f.text("undefinedAreas") == "wrapAround" {
        Edge::Wrap
    } else {
        Edge::Clamp
    }
}

// Output (x, y) becomes the bilinear sample of the plane at `map(x, y)`; taps outside follow `edge`.
fn remap(p: &mut Plane, edge: Edge, map: impl Fn(f64, f64) -> (f64, f64)) {
    let (w, h) = (p.w as i64, p.h as i64);
    let src = p.data.clone();
    let tap = |i: i64, n: i64| match edge {
        Edge::Clamp => i.clamp(0, n - 1),
        Edge::Wrap => i.rem_euclid(n),
    } as usize;
    for y in 0..h {
        for x in 0..w {
            let (sx, sy) = map(x as f64, y as f64);
            let (x0, y0) = (sx.floor(), sy.floor());
            let (fx, fy) = ((sx - x0) as f32, (sy - y0) as f32);
            let out = &mut p.data[((y * w + x) * 4) as usize..][..4];
            out.fill(0.0);
            for (dy, wy) in [(0, 1.0 - fy), (1, fy)] {
                for (dx, wx) in [(0, 1.0 - fx), (1, fx)] {
                    let k = wx * wy;
                    if k > 0.0 {
                        let at = (tap(y0 as i64 + dy, h) * p.w + tap(x0 as i64 + dx, w)) * 4;
                        for c in 0..4 {
                            out[c] += src[at + c] * k;
                        }
                    }
                }
            }
        }
    }
}

fn run(p: &mut Plane, edge: Edge, map: impl Fn(f64, f64) -> (f64, f64)) {
    premultiplied(p, |p| remap(p, edge, map));
}

fn center(p: &Plane) -> (f64, f64) {
    (p.w as f64 / 2.0, p.h as f64 / 2.0)
}

/// The reference UI gives Displace no map source, so without one the plane is unchanged.
pub fn displace(_: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    Ok(())
}

pub fn pinch(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let a = f.num("amount") / 100.0;
    if a == 0.0 {
        return Ok(());
    }
    let (cx, cy) = center(p);
    let (ox, oy) = (cx.max(1.0), cy.max(1.0));
    run(p, Edge::Clamp, |x, y| {
        let (dx, dy) = ((x - cx) / ox, (y - cy) / oy);
        let d = dx.hypot(dy);
        if d >= 1.0 || d == 0.0 {
            return (x, y);
        }
        let h = 1.0 + a * (1.0 - d) * (d * FRAC_PI_2).cos();
        (cx + dx * h * ox, cy + dy * h * oy)
    });
    Ok(())
}

pub fn polar(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (cx, cy) = center(p);
    let (w, h, r) = (p.w as f64, p.h as f64, cx.hypot(cy));
    if f.text("conversion") == "polarToRect" {
        run(p, Edge::Clamp, |x, y| {
            let (t, d) = (x / w * TAU, y / h * r);
            (cx + d * t.sin(), cy - d * t.cos())
        });
    } else {
        run(p, Edge::Clamp, |x, y| {
            let (u, v) = (x - cx, y - cy);
            let t = u.atan2(-v);
            (if t < 0.0 { t + TAU } else { t } / TAU * w, u.hypot(v) / r * h)
        });
    }
    Ok(())
}

// Value noise in 0..1 at (u, v): smoothstepped bilinear mix of the four surrounding lattice hashes.
fn value_noise(seed: u32, u: f64, v: f64) -> f64 {
    let (i, j) = (u.floor(), v.floor());
    let s = |e: f64| e * e * (3.0 - 2.0 * e);
    let (tx, ty) = (s(u - i), s(v - j));
    let at = |di: f64, dj: f64| hash(seed, (i + di) as i32, (j + dj) as i32, 0) as f64;
    let top = at(0.0, 0.0) + (at(1.0, 0.0) - at(0.0, 0.0)) * tx;
    let bottom = at(0.0, 1.0) + (at(1.0, 1.0) - at(0.0, 1.0)) * tx;
    top + (bottom - top) * ty
}

pub fn ripple(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let n = match f.text("size") {
        "small" => 6.0,
        "large" => 40.0,
        _ => 16.0,
    };
    let o = f.num("amount") / 100.0 * n / 8.0;
    if o == 0.0 {
        return Ok(());
    }
    let (px, py, k) = (p.x as f64, p.y as f64, 1.0 / n);
    run(p, Edge::Clamp, |x, y| {
        let (u, v) = ((px + x) * k, (py + y) * k);
        (x + 2.0 * (value_noise(0, u, v) - 0.5) * o, y + 2.0 * (value_noise(977, u, v) - 0.5) * o)
    });
    Ok(())
}

// The shear offset at `t` (0..1) along the sorted points: flat beyond the ends, linear between.
fn curve_at(pts: &[(f64, f64)], t: f64) -> f64 {
    if t <= pts[0].0 {
        return pts[0].1;
    }
    match pts.windows(2).find(|w| t < w[1].0) {
        Some(w) => w[0].1 + (w[1].1 - w[0].1) * (t - w[0].0) / (w[1].0 - w[0].0),
        None => pts[pts.len() - 1].1,
    }
}

pub fn shear(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let pts = f.curve("shearCurve");
    if pts.len() < 2 || pts.iter().all(|q| q.1 == 0.0) {
        return Ok(());
    }
    let (w, r) = (p.w as f64, (p.h as f64 - 1.0).max(1.0));
    run(p, edge(f), |x, y| (x - curve_at(&pts, y / r) * w, y));
    Ok(())
}

pub fn spherize(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let a = f.num("amount") / 100.0;
    if a == 0.0 {
        return Ok(());
    }
    let (cx, cy) = center(p);
    let (ix, iy) = (cx.max(1.0), cy.max(1.0));
    let (hz, vt) = (f.text("mode") != "verticalOnly", f.text("mode") != "horizontalOnly");
    run(p, Edge::Clamp, |x, y| {
        let (u, v) = (if hz { (x - cx) / ix } else { 0.0 }, if vt { (y - cy) / iy } else { 0.0 });
        let d = u.hypot(v);
        if d >= 1.0 || d == 0.0 {
            return (x, y);
        }
        let k = if a >= 0.0 { FRAC_2_PI * d.min(1.0).asin() } else { (d * FRAC_PI_2).sin() };
        let s = (d + a.abs() * (k - d)) / d;
        (if hz { cx + u * ix * s } else { x }, if vt { cy + v * iy * s } else { y })
    });
    Ok(())
}

pub fn twirl(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let s = f.num("angle") * PI / 180.0;
    if s == 0.0 {
        return Ok(());
    }
    let (cx, cy) = center(p);
    let r = cx.min(cy);
    run(p, Edge::Clamp, |x, y| {
        let (u, v) = (x - cx, y - cy);
        let d = u.hypot(v);
        if d >= r || d == 0.0 {
            return (x, y);
        }
        let a = 1.0 - d / r;
        let m = v.atan2(u) - s * a * a;
        (cx + m.cos() * d, cy + m.sin() * d)
    });
    Ok(())
}

// 32-bit generator behind the Wave patterns: a seed hash, then a counter-based mixer.
struct Rng(u32);

impl Rng {
    fn new(seed: u32) -> Rng {
        Rng((seed ^ 0x9E37_79B9).wrapping_mul(0x85EB_CA6B) ^ (seed >> 13))
    }

    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut o = self.0;
        o = (o ^ (o >> 15)).wrapping_mul(o | 1);
        o ^= o.wrapping_add((o ^ (o >> 7)).wrapping_mul(o | 61));
        (o ^ (o >> 14)) as f64 / 4_294_967_296.0
    }

    fn range(&mut self, a: f64, b: f64) -> f64 {
        a + self.next() * (b - a)
    }
}

fn wave_at(kind: &str, t: f64) -> f64 {
    let a = t - t.floor();
    match kind {
        "triangle" => {
            if a < 0.5 {
                4.0 * a - 1.0
            } else {
                3.0 - 4.0 * a
            }
        }
        "square" => {
            if a < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
        _ => (TAU * a).sin(),
    }
}

// A vertical generator shifts x and reads y, a horizontal one the reverse.
pub fn wave(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let mut rng = Rng::new((f.num("randomize") as u32).wrapping_mul(7919));
    let g = f.num("generators").round().max(1.0) as usize;
    let span = |a: &str, b: &str| (f.num(a).min(f.num(b)), f.num(a).max(f.num(b)));
    let ((wl0, wl1), (am0, am1)) = (span("wavelengthMin", "wavelengthMax"), span("amplitudeMin", "amplitudeMax"));
    // (wavelength, amplitude, phase, vertical)
    let gens: Vec<(f64, f64, f64, bool)> = (0..g)
        .map(|_| {
            let wl = rng.range(wl0, wl1).max(1.0);
            (wl, rng.range(am0, am1), rng.next(), rng.next() < 0.5)
        })
        .collect();
    let kind = f.text("type");
    let (kx, ky) = (f.num("horizontalScale") / 100.0 / g as f64, f.num("verticalScale") / 100.0 / g as f64);
    run(p, edge(f), |x, y| {
        let (mut m, mut n) = (0.0, 0.0);
        for &(wl, amp, phase, vertical) in &gens {
            let b = wave_at(kind, if vertical { y } else { x } / wl + phase) * amp;
            if vertical {
                m += b;
            } else {
                n += b;
            }
        }
        (x + m * kx, y + n * ky)
    });
    Ok(())
}

pub fn zigzag(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (cx, cy) = center(p);
    let r = cx.min(cy).max(1.0);
    let l = f.num("amount") / 100.0 * r / 8.0;
    if l == 0.0 {
        return Ok(());
    }
    let (s, style) = (f.num("ridges").round().max(0.0), f.text("style"));
    run(p, Edge::Clamp, |x, y| {
        let (u, v) = (x - cx, y - cy);
        let d = u.hypot(v);
        if d == 0.0 || d > r {
            return (x, y);
        }
        let (m, k) = (d / r, 1.0 - d / r);
        let ripple = (m * s * TAU).sin();
        if style == "aroundCenter" {
            let w = v.atan2(u) + ripple * l * k / r * PI;
            return (cx + w.cos() * d, cy + w.sin() * d);
        }
        let c = if style == "outFromCenter" { k * l } else { ripple * l * k };
        (x + u / d * c, y + v / d * c)
    });
    Ok(())
}
