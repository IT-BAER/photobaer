//! Segmentation model input and output: a document region downscaled to the model's size, and the
//! model's coarse mask upsampled to document pixels with a fast guided filter (He and Sun, "Fast
//! Guided Filter", 2015) whose guide is the full-size luma, so hard edges snap to the image while soft
//! mask edges (hair, fur, blur) stay soft.

#[cfg(test)]
#[path = "matte_tests.rs"]
mod tests;

// Box radius of the guided filter in mask pixels, and its regularization in luma^2.
const GUIDE_R: usize = 2;
const GUIDE_EPS: f32 = 1.0e-3;

// The source span of output index `o` of `n` over `len` source pixels starting at `start`, at least one pixel.
pub(crate) fn span(o: usize, n: usize, start: i32, len: i32, limit: usize) -> (usize, usize) {
    let a = start as i64 + (o as i64 * len as i64) / n as i64;
    let b = (start as i64 + ((o as i64 + 1) * len as i64) / n as i64).max(a + 1);
    let clamp = |v: i64| v.clamp(0, limit as i64) as usize;
    let (a, b) = (clamp(a), clamp(b));
    if a < b { (a, b) } else { (a.min(limit.saturating_sub(1)), a.min(limit.saturating_sub(1)) + 1) }
}

/// `rect` (`[x, y, w, h]` in `src` pixels) of a straight RGBA8 image (`w x h`) as an opaque `ow x oh` RGBA8 image:
/// each output pixel averages its source area, composited over the grey `matte`.
pub fn downscale_rgba(src: &[u8], w: usize, h: usize, rect: [i32; 4], ow: usize, oh: usize, matte: u8) -> Vec<u8> {
    let mut out = vec![0u8; ow * oh * 4];
    if w == 0 || h == 0 || rect[2] <= 0 || rect[3] <= 0 {
        return out;
    }
    let xs: Vec<(usize, usize)> = (0..ow).map(|o| span(o, ow, rect[0], rect[2], w)).collect();
    for oy in 0..oh {
        let (y0, y1) = span(oy, oh, rect[1], rect[3], h);
        for (ox, &(x0, x1)) in xs.iter().enumerate() {
            let mut acc = [0f32; 4];
            for y in y0..y1 {
                for x in x0..x1 {
                    let p = &src[(y * w + x) * 4..][..4];
                    let a = p[3] as f32 / 255.0;
                    for c in 0..3 {
                        acc[c] += p[c] as f32 * a;
                    }
                    acc[3] += a;
                }
            }
            let n = ((y1 - y0) * (x1 - x0)) as f32;
            let rest = matte as f32 * (1.0 - acc[3] / n);
            let o = &mut out[(oy * ow + ox) * 4..][..4];
            for c in 0..3 {
                o[c] = (acc[c] / n + rest).round().clamp(0.0, 255.0) as u8;
            }
            o[3] = 255;
        }
    }
    out
}

fn luma(p: &[u8]) -> f32 {
    let a = p[3] as f32 / 255.0;
    let l = (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) / 255.0;
    l * a + 0.5 * (1.0 - a)
}

/// The mean of `v` (`w x h`) over a (2r + 1)^2 box, shrunk at the borders.
pub fn box_mean(v: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut sat = vec![0f64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0f64;
        for x in 0..w {
            row += v[y * w + x] as f64;
            sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(h));
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(w));
            let s = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
            out[y * w + x] = (s / ((x1 - x0) * (y1 - y0)) as f64) as f32;
        }
    }
    out
}

/// Coverage (0..1, `w x h`) from a model mask (0..255, `mw x mh`) that covers `rect` (`[x, y, w, h]`) of the
/// RGBA8 `guide`; zero outside the rect.
pub fn upsample_mask(mask: &[u8], mw: usize, mh: usize, guide: &[u8], w: usize, h: usize, rect: [i32; 4]) -> Vec<f32> {
    let mut out = vec![0f32; w * h];
    if mw == 0 || mh == 0 || mask.len() < mw * mh || rect[2] <= 0 || rect[3] <= 0 {
        return out;
    }
    // The guide at mask resolution: the luma average of each mask pixel's area.
    let small = downscale_rgba(guide, w, h, rect, mw, mh, 128);
    let i_low: Vec<f32> = small.chunks(4).map(luma).collect();
    let p: Vec<f32> = mask[..mw * mh].iter().map(|&v| v as f32 / 255.0).collect();
    let ip: Vec<f32> = i_low.iter().zip(&p).map(|(a, b)| a * b).collect();
    let ii: Vec<f32> = i_low.iter().map(|a| a * a).collect();
    let (mi, mp, mip, mii) = (box_mean(&i_low, mw, mh, GUIDE_R), box_mean(&p, mw, mh, GUIDE_R), box_mean(&ip, mw, mh, GUIDE_R), box_mean(&ii, mw, mh, GUIDE_R));
    let a: Vec<f32> = (0..mw * mh).map(|k| (mip[k] - mi[k] * mp[k]) / ((mii[k] - mi[k] * mi[k]).max(0.0) + GUIDE_EPS)).collect();
    let b: Vec<f32> = (0..mw * mh).map(|k| mp[k] - a[k] * mi[k]).collect();
    let (ma, mb) = (box_mean(&a, mw, mh, GUIDE_R), box_mean(&b, mw, mh, GUIDE_R));

    let (x0, y0) = (rect[0].max(0) as usize, rect[1].max(0) as usize);
    let (x1, y1) = (((rect[0] + rect[2]).max(0) as usize).min(w), ((rect[1] + rect[3]).max(0) as usize).min(h));
    // Document pixel `i` in mask coordinates (pixel centres), clamped to the mask.
    let coord = |i: usize, start: i32, len: i32, n: usize| {
        let f = ((i as f32 + 0.5 - start as f32) * n as f32 / len as f32 - 0.5).clamp(0.0, (n - 1) as f32);
        let i0 = f as usize;
        (i0, (i0 + 1).min(n - 1), f - i0 as f32)
    };
    let xs: Vec<(usize, usize, f32)> = (x0..x1).map(|x| coord(x, rect[0], rect[2], mw)).collect();
    for y in y0..y1 {
        let (r0, r1, ty) = coord(y, rect[1], rect[3], mh);
        let (r0, r1) = (r0 * mw, r1 * mw);
        for (k, &(c0, c1, tx)) in xs.iter().enumerate() {
            let lerp = |m: &[f32]| {
                let top = m[r0 + c0] + (m[r0 + c1] - m[r0 + c0]) * tx;
                let bot = m[r1 + c0] + (m[r1 + c1] - m[r1 + c0]) * tx;
                top + (bot - top) * ty
            };
            let x = x0 + k;
            let q = lerp(&ma) * luma(&guide[(y * w + x) * 4..][..4]) + lerp(&mb);
            // Doubled contrast around 0.5 drops the faint halo where the coarse mask overshoots; mid values stay soft.
            out[y * w + x] = ((q - 0.5) * 2.0 + 0.5).clamp(0.0, 1.0);
        }
    }
    out
}
