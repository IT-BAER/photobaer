//! Pixelate group (docs/M5.md sections 3, 14 and 16). Cell grids sit on the document origin and
//! every random value comes from `hash(seed, doc_x, doc_y, channel)`, so a tile equals the whole
//! layer. Reads outside the plane clamp (the runner reads the reach, so they never show).

use super::blur::premultiplied;
use super::{hash, Ctx, Filter, Plane};

// The straight RGBA of plane px (x, y), clamped into the plane.
pub(super) fn at(p: &Plane, x: isize, y: isize) -> [f32; 4] {
    let (x, y) = (x.clamp(0, p.w as isize - 1) as usize, y.clamp(0, p.h as isize - 1) as usize);
    p.data[(y * p.w + x) * 4..][..4].try_into().expect("4 channels")
}

fn seed(f: &Filter) -> u32 {
    f.num("seed") as u32
}

pub fn halftone_reach(f: &Filter) -> i32 {
    (f.num("maxRadius") * 1.5).ceil() as i32 + 2
}

/// Per color channel a screen of dots on a grid of `2 x maxRadius` rotated by the channel angle;
/// the dot area follows the channel's darkness at the cell center, ink is 0 and paper 1 (channel 4,
/// the black plate, has no channel of an RGB layer).
pub fn color_halftone(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let (r, src) = (f.num("maxRadius") as f32, p.clone());
    let s = 2.0 * r;
    for (c, key) in ["channel1", "channel2", "channel3"].into_iter().enumerate() {
        let (sin, cos) = (f.num(key) as f32).to_radians().sin_cos();
        for j in 0..p.h {
            for i in 0..p.w {
                let (x, y) = ((p.x + i as i32) as f32 + 0.5, (p.y + j as i32) as f32 + 0.5);
                let (u, v) = (x * cos + y * sin, y * cos - x * sin);
                let (uc, vc) = (((u / s).floor() + 0.5) * s, ((v / s).floor() + 0.5) * s);
                let (xc, yc) = (uc * cos - vc * sin, vc * cos + uc * sin);
                let center = at(&src, (xc.floor() as i32 - p.x) as isize, (yc.floor() as i32 - p.y) as isize);
                let radius = r * (1.0 - center[c]).clamp(0.0, 1.0).sqrt();
                p.data[(j * p.w + i) * 4 + c] = 1.0 - (radius - (u - uc).hypot(v - vc) + 0.5).clamp(0.0, 1.0);
            }
        }
    }
    Ok(())
}

pub fn voronoi_reach(f: &Filter) -> i32 {
    2 * f.num("cellSize").round() as i32
}

// The nearest of the jittered seeds (one per `cs` px cell) around doc px (x, y): its position and distance.
fn nearest(seed: u32, cs: i32, x: i32, y: i32) -> (i32, i32, f32) {
    let (cx, cy) = (x.div_euclid(cs), y.div_euclid(cs));
    let mut best = (0, 0, f32::MAX);
    for gy in cy - 1..=cy + 1 {
        for gx in cx - 1..=cx + 1 {
            let jitter = |c| ((hash(seed, gx, gy, c) * cs as f32) as i32).min(cs - 1);
            let (sx, sy) = (gx * cs + jitter(0), gy * cs + jitter(1));
            let d = ((sx - x) as f32).hypot((sy - y) as f32);
            if d < best.2 {
                best = (sx, sy, d);
            }
        }
    }
    best
}

// Each pixel takes the color of its nearest seed's pixel where `inside(distance)`, else `gap`.
fn voronoi(p: &mut Plane, f: &Filter, inside: impl Fn(f32) -> bool, gap: [f32; 3]) {
    let (cs, seed, src) = (f.num("cellSize").round() as i32, seed(f), p.clone());
    for j in 0..p.h {
        for i in 0..p.w {
            let (sx, sy, d) = nearest(seed, cs, p.x + i as i32, p.y + j as i32);
            let s = at(&src, (sx - p.x) as isize, (sy - p.y) as isize);
            let px = &mut p.data[(j * p.w + i) * 4..][..3];
            if !inside(d) {
                px.copy_from_slice(&gap);
            } else if s[3] > 0.0 {
                px.copy_from_slice(&s[..3]);
            }
        }
    }
}

/// Voronoi cells, one jittered seed per `cellSize` cell, each filled with its seed pixel.
pub fn crystallize(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    voronoi(p, f, |_| true, [0.0; 3]);
    Ok(())
}

/// Round dots of radius `cellSize / 2` at the Voronoi seeds on white paper (Ctx has no colors).
pub fn pointillize(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let r = f.num("cellSize") as f32 / 2.0;
    voronoi(p, f, |d| d <= r, [1.0; 3]);
    Ok(())
}

pub fn one(_: &Filter) -> i32 {
    1
}

/// The per-channel median of the 3x3 window.
pub fn facet(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    let src = p.clone();
    for j in 0..p.h {
        for i in 0..p.w {
            for c in 0..3 {
                let mut w = [0f32; 9];
                for (k, v) in w.iter_mut().enumerate() {
                    *v = at(&src, i as isize + (k % 3) as isize - 1, j as isize + (k / 3) as isize - 1)[c];
                }
                w.sort_by(f32::total_cmp);
                p.data[(j * p.w + i) * 4 + c] = w[4];
            }
        }
    }
    Ok(())
}

pub fn four(_: &Filter) -> i32 {
    4
}

/// The mean of four copies offset by (+-4, +-4) px.
pub fn fragment(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    premultiplied(p, |p| {
        let src = p.clone();
        for j in 0..p.h as isize {
            for i in 0..p.w as isize {
                let mut acc = [0f32; 4];
                for (dx, dy) in [(-4, -4), (4, -4), (-4, 4), (4, 4)] {
                    let s = at(&src, i + dx, j + dy);
                    acc.iter_mut().zip(s).for_each(|(a, v)| *a += v / 4.0);
                }
                p.data[(j as usize * p.w + i as usize) * 4..][..4].copy_from_slice(&acc);
            }
        }
    });
    Ok(())
}

// How the threshold of a pixel is drawn.
enum Cells {
    Dots(i32),
    Grain,
    Lines(i32),
    Strokes(i32),
}

/// Per color channel 1 where the value exceeds a seeded threshold, else 0. Dots: threshold cells of
/// 1/2/3 px; grainy: the mean of the 3x3 per-pixel thresholds; lines: horizontal runs and strokes
/// 45-degree runs of 4/8/16 px sharing one threshold.
pub fn mezzotint(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let cells = match f.text("type") {
        "fineDots" => Cells::Dots(1),
        "coarseDots" => Cells::Dots(3),
        "grainyDots" => Cells::Grain,
        "shortLines" => Cells::Lines(4),
        "mediumLines" => Cells::Lines(8),
        "longLines" => Cells::Lines(16),
        "shortStrokes" => Cells::Strokes(4),
        "mediumStrokes" => Cells::Strokes(8),
        "longStrokes" => Cells::Strokes(16),
        _ => Cells::Dots(2),
    };
    let seed = seed(f);
    for (k, px) in p.data.chunks_exact_mut(4).enumerate() {
        let (x, y) = (p.x + (k % p.w) as i32, p.y + (k / p.w) as i32);
        for (c, v) in px[..3].iter_mut().enumerate() {
            let c = c as u32;
            let threshold = match cells {
                Cells::Dots(n) => hash(seed, x.div_euclid(n), y.div_euclid(n), c),
                Cells::Grain => (0..9).map(|k| hash(seed, x + k % 3 - 1, y + k / 3 - 1, c)).sum::<f32>() / 9.0,
                Cells::Lines(n) => hash(seed, x.div_euclid(n), y, c),
                Cells::Strokes(n) => hash(seed, x.div_euclid(n), x - y, c),
            };
            *v = f32::from(*v > threshold);
        }
    }
    Ok(())
}

pub fn mosaic_reach(f: &Filter) -> i32 {
    f.num("cellSize").round() as i32
}

/// Every `cellSize` cell (on the document origin) becomes its mean color.
pub fn mosaic(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let cs = (f.num("cellSize").round() as i32).max(1);
    let (w, h) = (p.w as i32, p.h as i32);
    premultiplied(p, |p| {
        for cy in p.y.div_euclid(cs)..=(p.y + h - 1).div_euclid(cs) {
            for cx in p.x.div_euclid(cs)..=(p.x + w - 1).div_euclid(cs) {
                let (x0, x1) = ((cx * cs - p.x).max(0), ((cx + 1) * cs - p.x).min(w));
                let (y0, y1) = ((cy * cs - p.y).max(0), ((cy + 1) * cs - p.y).min(h));
                let mut sum = [0f32; 4];
                for y in y0..y1 {
                    for x in x0..x1 {
                        sum.iter_mut().zip(&p.data[(y * w + x) as usize * 4..]).for_each(|(s, v)| *s += v);
                    }
                }
                let n = ((x1 - x0) * (y1 - y0)) as f32;
                for y in y0..y1 {
                    for x in x0..x1 {
                        p.data[(y * w + x) as usize * 4..][..4].iter_mut().zip(sum).for_each(|(d, s)| *d = s / n);
                    }
                }
            }
        }
    });
    Ok(())
}
