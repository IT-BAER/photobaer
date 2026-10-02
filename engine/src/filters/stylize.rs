//! Stylize group (docs/M5.md sections 3, 14 and 16). Color-only filters keep alpha; random values
//! come from `hash(seed, doc_x, doc_y, channel)` so a tile equals the whole layer; reads outside
//! the plane clamp (the runner reads the reach, so they never show).

use super::pixelate::at;
use super::{hash, Ctx, Filter, Plane};

fn luma(p: [f32; 4]) -> f32 {
    0.3 * p[0] + 0.59 * p[1] + 0.11 * p[2]
}

// Bilinear luminance at the continuous plane position (x, y), pixel centers on whole numbers.
fn luma_at(p: &Plane, x: f32, y: f32) -> f32 {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let l = |dx: isize, dy: isize| luma(at(p, x0 as isize + dx, y0 as isize + dy));
    (l(0, 0) * (1.0 - fx) + l(1, 0) * fx) * (1.0 - fy) + (l(0, 1) * (1.0 - fx) + l(1, 1) * fx) * fy
}

// The unit vector toward a light at `angle` degrees (135 is the upper left), y down.
fn toward(angle: f64) -> (f32, f32) {
    let (s, c) = angle.to_radians().sin_cos();
    (c as f32, -s as f32)
}

// Luminance one px away on the lit side minus one px away on the far side, at plane px (i, j).
fn relief(p: &Plane, d: (f32, f32), i: usize, j: usize) -> f32 {
    let (x, y) = (i as f32, j as f32);
    luma_at(p, x - d.0, y - d.1) - luma_at(p, x + d.0, y + d.1)
}

/// `v < 0.5 ? 2v : 2(1 - v)` per color channel.
pub fn solarize(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    for px in p.data.chunks_exact_mut(4) {
        for v in &mut px[..3] {
            *v = if *v < 0.5 { 2.0 * *v } else { 2.0 * (1.0 - *v) };
        }
    }
    Ok(())
}

/// Each pixel takes a random neighbor within 1 px (hash draws); darken/lighten only take it when
/// it is darker/lighter; anisotropic takes the neighbor closest in color.
pub fn diffuse(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (mode, seed, src) = (f.text("mode"), f.num("seed") as u32, p.clone());
    for j in 0..p.h {
        for i in 0..p.w {
            let (x, y) = (p.x + i as i32, p.y + j as i32);
            let me = at(&src, i as isize, j as isize);
            let dist = |n: [f32; 4]| (0..3).map(|c| (n[c] - me[c]).abs()).sum::<f32>();
            let pick = |dx: isize, dy: isize| at(&src, i as isize + dx, j as isize + dy);
            let n = if mode == "anisotropic" {
                (0..9).filter(|k| *k != 4).map(|k| pick(k % 3 - 1, k / 3 - 1)).min_by(|a, b| dist(*a).total_cmp(&dist(*b))).unwrap_or(me)
            } else {
                let d = |c| ((hash(seed, x, y, c) * 3.0) as isize - 1).clamp(-1, 1);
                pick(d(0), d(1))
            };
            let take = match mode {
                "darkenOnly" => luma(n) < luma(me),
                "lightenOnly" => luma(n) > luma(me),
                _ => true,
            };
            if take {
                p.data[(j * p.w + i) * 4..][..3].copy_from_slice(&n[..3]);
            }
        }
    }
    Ok(())
}

pub fn emboss_reach(_: &Filter) -> i32 {
    2
}

/// Gray 0.5 plus `amount x height / 2` x the luminance slope toward the light angle.
pub fn emboss(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (d, k, src) = (toward(f.num("angle")), (f.num("amount") / 100.0 * f.num("height") / 2.0) as f32, p.clone());
    for j in 0..p.h {
        for i in 0..p.w {
            p.data[(j * p.w + i) * 4..][..3].fill((0.5 + k * relief(&src, d, i, j)).clamp(0.0, 1.0));
        }
    }
    Ok(())
}

/// `1 - |sobel|` per color channel.
pub fn find_edges(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    let src = p.clone();
    for j in 0..p.h as isize {
        for i in 0..p.w as isize {
            for c in 0..3 {
                let u = |dx: isize, dy: isize| at(&src, i + dx, j + dy)[c];
                let gx = u(1, -1) + 2.0 * u(1, 0) + u(1, 1) - u(-1, -1) - 2.0 * u(-1, 0) - u(-1, 1);
                let gy = u(-1, 1) + 2.0 * u(0, 1) + u(1, 1) - u(-1, -1) - 2.0 * u(0, -1) - u(1, -1);
                p.data[(j as usize * p.w + i as usize) * 4 + c] = (1.0 - gx.hypot(gy)).clamp(0.0, 1.0);
            }
        }
    }
    Ok(())
}

/// Per channel white, except 0 where the channel crosses `level`: lower marks a pixel below it with
/// a 4-neighbor at or above it, upper the reverse.
pub fn trace_contour(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (level, lower, src) = (f.num("level") as i32, f.text("edge") != "upper", p.clone());
    let v8 = |i: isize, j: isize, c: usize| (at(&src, i, j)[c] * 255.0).round() as i32;
    for j in 0..p.h as isize {
        for i in 0..p.w as isize {
            for c in 0..3 {
                let above = v8(i, j, c) >= level;
                let crosses = [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|(dx, dy)| (v8(i + dx, j + dy, c) >= level) != above);
                p.data[(j as usize * p.w + i as usize) * 4 + c] = f32::from(!(crosses && above != lower));
            }
        }
    }
    Ok(())
}

fn oil_radius(f: &Filter) -> i32 {
    ((f.num("stylization") * f.num("scale") * 0.5).round() as i32).max(1)
}

pub fn oil_reach(f: &Filter) -> i32 {
    oil_radius(f) + 3
}

// Summed-area table (w + 1 columns) of `v` per plane pixel.
fn sat(p: &Plane, v: impl Fn(&[f32]) -> f64) -> Vec<f64> {
    let mut s = vec![0f64; (p.w + 1) * (p.h + 1)];
    for y in 0..p.h {
        let mut row = 0.0;
        for x in 0..p.w {
            row += v(&p.data[(y * p.w + x) * 4..][..4]);
            s[(y + 1) * (p.w + 1) + x + 1] = s[y * (p.w + 1) + x + 1] + row;
        }
    }
    s
}

fn box3(p: &Plane) -> Plane {
    let mut o = p.clone();
    for j in 0..p.h as isize {
        for i in 0..p.w as isize {
            for c in 0..3 {
                o.data[(j as usize * p.w + i as usize) * 4 + c] = (0..9).map(|k| at(p, i + k % 3 - 1, j + k / 3 - 1)[c]).sum::<f32>() / 9.0;
            }
        }
    }
    o
}

/// Kuwahara smoothing (the quadrant of least luminance variance within `stylization x scale / 2`
/// px), cleanliness blending toward the 3x3 mean, bristle detail returning the 3x3 high pass, and
/// shine as the luminance slope toward `angularDirection`.
pub fn oil_paint(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (r, w, h) = (oil_radius(f) as isize, p.w as isize, p.h as isize);
    let orig = p.clone();
    let l = |v: &[f32]| f64::from(luma([v[0], v[1], v[2], 0.0]));
    let sums = [sat(p, |v| f64::from(v[0])), sat(p, |v| f64::from(v[1])), sat(p, |v| f64::from(v[2])), sat(p, l), sat(p, |v| l(v).powi(2))];
    let area = |s: &[f64], x0: isize, y0: isize, x1: isize, y1: isize| {
        let at = |x: isize, y: isize| s[(y * (w + 1) + x) as usize];
        at(x1, y1) - at(x1, y0) - at(x0, y1) + at(x0, y0)
    };
    for y in 0..h {
        for x in 0..w {
            let mut best = (f64::MAX, [0f32; 3]);
            for (qx, qy) in [(-r, -r), (0, -r), (-r, 0), (0, 0)] {
                let (x0, x1, y0, y1) = ((x + qx).max(0), (x + qx + r + 1).min(w), (y + qy).max(0), (y + qy + r + 1).min(h));
                let n = ((x1 - x0) * (y1 - y0)) as f64;
                let m = |k: usize| area(&sums[k], x0, y0, x1, y1) / n;
                let var = m(4) - m(3) * m(3);
                // The tolerance keeps equal variances from flipping on the summed-area rounding.
                if var < best.0 - 1e-9 {
                    best = (var, [m(0) as f32, m(1) as f32, m(2) as f32]);
                }
            }
            p.data[(y * w + x) as usize * 4..][..3].copy_from_slice(&best.1);
        }
    }
    let (clean, bristle, shine) = ((f.num("cleanliness") / 10.0) as f32, (f.num("bristleDetail") / 20.0) as f32, (f.num("shine") / 10.0) as f32);
    let (smooth, flat) = (box3(p), box3(&orig));
    let d = toward(f.num("angularDirection"));
    let mut out = p.clone();
    for (k, px) in out.data.chunks_exact_mut(4).enumerate() {
        for c in 0..3 {
            px[c] += (smooth.data[k * 4 + c] - px[c]) * clean + (orig.data[k * 4 + c] - flat.data[k * 4 + c]) * bristle;
        }
    }
    for j in 0..p.h {
        for i in 0..p.w {
            let lit = shine * relief(&out, d, i, j);
            for c in 0..3 {
                p.data[(j * p.w + i) * 4 + c] = (out.data[(j * p.w + i) * 4 + c] + lit).clamp(0.0, 1.0);
            }
        }
    }
    Ok(())
}

pub fn wind_reach(f: &Filter) -> i32 {
    match f.text("method") {
        "blast" => 40,
        "stagger" => 8,
        _ => 12,
    }
}

/// Wind and Blast: a pixel whose hash is below 0.25 starts a streak downwind (up to 12 or 40 px)
/// in its color, lighten-only and fading linearly (Blast does not fade). Stagger: rows cut into
/// 16 px segments on the document origin, each shifted 0..8 px downwind, edges repeated.
pub fn wind(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (method, seed, src) = (f.text("method"), f.num("seed") as u32, p.clone());
    // Toward the side the wind comes from: +x for "from the right".
    let up: i32 = if f.text("direction") == "fromTheLeft" { -1 } else { 1 };
    let len_max = wind_reach(f);
    for j in 0..p.h as isize {
        for i in 0..p.w as isize {
            let (x, y) = (p.x + i as i32, p.y + j as i32);
            let out = &mut p.data[(j as usize * p.w + i as usize) * 4..][..3];
            if method == "stagger" {
                let shift = (hash(seed, x.div_euclid(16), y, 0) * 9.0) as isize;
                out.copy_from_slice(&at(&src, i + up as isize * shift, j)[..3]);
                continue;
            }
            for k in 1..=len_max {
                let sx = i as i32 + up * k;
                if !(0..src.w as i32).contains(&sx) || hash(seed, x + up * k, y, 0) >= 0.25 {
                    continue;
                }
                let len = (hash(seed, x + up * k, y, 1) * len_max as f32) as i32 + 1;
                if k > len {
                    continue;
                }
                let fade = if method == "blast" { 1.0 } else { 1.0 - (k - 1) as f32 / len as f32 };
                let s = at(&src, sx as isize, j);
                for c in 0..3 {
                    out[c] = out[c].max(out[c] + (s[c] - out[c]) * fade);
                }
            }
        }
    }
    Ok(())
}

/// Tiles of `min(layer w, h) / numberOfTiles` px on the document origin; each is offset by up to
/// `maxOffset` % of its size (truncated, so an offset below 1 px is none) and clipped to its cell;
/// gaps take white, black (Ctx carries no colors), the inverse image or the unaltered image.
pub fn tiles(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let short = f64::from(ctx.bounds[2].min(ctx.bounds[3])) * ctx.scale;
    let ts = ((short / f.num("numberOfTiles")).floor() as i32).max(1);
    let (m, seed, fill, src) = (f.num("maxOffset") / 100.0 * f64::from(ts), f.num("seed") as u32, f.text("fillEmptyAreaWith"), p.clone());
    for j in 0..p.h as i32 {
        for i in 0..p.w as i32 {
            let (x, y) = (p.x + i, p.y + j);
            let (tx, ty) = (x.div_euclid(ts), y.div_euclid(ts));
            let off = |c| ((f64::from(hash(seed, tx, ty, c)) * 2.0 - 1.0) * m) as i32;
            let (sx, sy) = (x - off(0), y - off(1));
            let inside = sx.div_euclid(ts) == tx && sy.div_euclid(ts) == ty && (0..p.w as i32).contains(&(sx - p.x)) && (0..p.h as i32).contains(&(sy - p.y));
            let me = at(&src, i as isize, j as isize);
            let c = if inside {
                at(&src, (sx - p.x) as isize, (sy - p.y) as isize)
            } else {
                match fill {
                    "foreground" => [0.0, 0.0, 0.0, 1.0],
                    "inverseImage" => [1.0 - me[0], 1.0 - me[1], 1.0 - me[2], 1.0],
                    "unalteredImage" => me,
                    _ => [1.0; 4],
                }
            };
            p.data[(j as usize * p.w + i as usize) * 4..][..3].copy_from_slice(&c[..3]);
        }
    }
    Ok(())
}

// Whether the offset (u, v) from a cell's corner lies on the cell swept from (0, 0) to (dx, dy).
fn swept(u: i32, v: i32, dx: i32, dy: i32, cs: i32) -> bool {
    let (mut lo, mut hi) = (0f64, 1f64);
    for (a, d) in [(u, dx), (v, dy)] {
        if d == 0 {
            if !(0..cs).contains(&a) {
                return false;
            }
        } else {
            let (t0, t1) = (f64::from(a - (cs - 1)) / f64::from(d), f64::from(a) / f64::from(d));
            lo = lo.max(t0.min(t1));
            hi = hi.min(t0.max(t1));
        }
    }
    lo <= hi
}

/// Blocks or pyramids over cells of `size` px on the document origin. Depth is a seeded random or
/// the cell's mean luminance, times `depth`; the front face moves away from the layer center by
/// depth / 255 x 25 % of its distance, side faces are the cell mean x 0.8 (left, right) and x 0.6
/// (top, bottom), pyramid faces x 1.0 / 0.85 / 0.65 / 0.5 (top, left, right, bottom); deeper
/// blocks draw on top. ponytail: each cell scans its swept rect, slow with large offsets.
pub fn extrude(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let cs = (f.num("size").round() as i32).max(1);
    let (pyramids, level, solid, mask) = (f.text("type") == "pyramids", f.text("depthMode") == "level", f.flag("solidFrontFaces"), f.flag("maskIncompleteBlocks"));
    let (depth, seed, src) = (f.num("depth") as f32, f.num("seed") as u32, p.clone());
    let (w, h) = (p.w as i32, p.h as i32);
    let b = ctx.bounds;
    let (lx, ly) = ((f64::from(b[0]) + f64::from(b[2]) / 2.0) * ctx.scale, (f64::from(b[1]) + f64::from(b[3]) / 2.0) * ctx.scale);
    let mut z = vec![-1f32; (w * h) as usize];
    for cy in p.y.div_euclid(cs)..=(p.y + h - 1).div_euclid(cs) {
        for cx in p.x.div_euclid(cs)..=(p.x + w - 1).div_euclid(cs) {
            let (bx, by) = (cx * cs, cy * cs);
            let (x0, x1, y0, y1) = ((bx - p.x).max(0), (bx + cs - p.x).min(w), (by - p.y).max(0), (by + cs - p.y).min(h));
            if mask && (x1 - x0 < cs || y1 - y0 < cs) {
                continue;
            }
            let (mut mean, n) = ([0f32; 3], ((x1 - x0) * (y1 - y0)) as f32);
            for y in y0..y1 {
                for x in x0..x1 {
                    mean.iter_mut().zip(&src.data[(y * w + x) as usize * 4..]).for_each(|(m, v)| *m += v / n);
                }
            }
            let base = if level { luma([mean[0], mean[1], mean[2], 0.0]) } else { hash(seed, cx, cy, 0) };
            let dv = base * depth;
            let k = f64::from(dv) / 255.0 * 0.25;
            let (dx, dy) = (((f64::from(bx) + f64::from(cs) / 2.0 - lx) * k).round() as i32, ((f64::from(by) + f64::from(cs) / 2.0 - ly) * k).round() as i32);
            for y in (by + dy.min(0)).max(p.y)..(by + cs + dy.max(0)).min(p.y + h) {
                for x in (bx + dx.min(0)).max(p.x)..(bx + cs + dx.max(0)).min(p.x + w) {
                    let (u, v) = (x - bx, y - by);
                    let at_z = ((y - p.y) * w + x - p.x) as usize;
                    if dv < z[at_z] || !swept(u, v, dx, dy, cs) {
                        continue;
                    }
                    let (fu, fv) = (u - dx, v - dy);
                    let shade = if pyramids {
                        let (vx, vy) = (fu as f32 + 0.5 - cs as f32 / 2.0, fv as f32 + 0.5 - cs as f32 / 2.0);
                        match (vy.abs() > vx.abs(), vx < 0.0, vy < 0.0) {
                            (true, _, true) => 1.0,
                            (true, _, false) => 0.5,
                            (false, true, _) => 0.85,
                            _ => 0.65,
                        }
                    } else if (0..cs).contains(&fu) && (0..cs).contains(&fv) {
                        if !solid {
                            let s = at(&src, (x - dx - p.x) as isize, (y - dy - p.y) as isize);
                            p.data[at_z * 4..][..3].copy_from_slice(&s[..3]);
                            z[at_z] = dv;
                            continue;
                        }
                        1.0
                    } else if (0..cs).contains(&fu) {
                        0.6
                    } else {
                        0.8
                    };
                    p.data[at_z * 4..][..3].iter_mut().zip(mean).for_each(|(d, m)| *d = m * shade);
                    z[at_z] = dv;
                }
            }
        }
    }
    Ok(())
}
