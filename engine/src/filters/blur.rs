//! Blur group (docs/M5.md section 3). Kernels run on premultiplied color so transparent pixels do
//! not bleed their color; plane edges clamp (the runner reads the reach, so they never show).

use super::{Ctx, Filter, Plane};
use crate::styles;

pub fn blur_reach(_: &Filter) -> i32 {
    1
}

pub fn blur_more_reach(_: &Filter) -> i32 {
    3
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
    p.premultiply();
    blur3(p);
    p.unpremultiply();
    Ok(())
}

pub fn blur_more(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    p.premultiply();
    for _ in 0..3 {
        blur3(p);
    }
    p.unpremultiply();
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
    let size = f.num("radius") as f32;
    if size <= 12.0 {
        (size.ceil() as i32).max(1)
    } else {
        styles::gauss_boxes(size as f64 / 3.0).iter().sum::<usize>() as i32
    }
}

pub fn gaussian(p: &mut Plane, f: &Filter, _: &Ctx) -> Result<(), String> {
    let radius = f.num("radius") as f32;
    p.premultiply();
    for c in 0..4 {
        let ch = styles::Plane { w: p.w, h: p.h, v: p.data.iter().skip(c).step_by(4).copied().collect() };
        for (i, v) in styles::gaussian(&ch, radius).v.into_iter().enumerate() {
            p.data[i * 4 + c] = v;
        }
    }
    p.unpremultiply();
    Ok(())
}
