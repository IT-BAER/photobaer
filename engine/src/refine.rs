//! Select > Select and Mask: refines a selection against the image.
//!
//! Edge Detection: inside the band within Radius of the selection edge, a pixel's alpha is its color projected
//! onto the line between the mean colors of the surely selected and surely unselected pixels nearby, trusted as
//! far as those two colors differ. Smart Radius narrows the band where that alpha shows a clean edge. Then, in
//! Photoshop's order: Smooth, Feather, Contrast and Shift Edge. Brush edits add, subtract, force refinement
//! (Refine Edge Brush) or keep the original edge (its erase mode).

#[cfg(test)]
#[path = "refine_tests.rs"]
mod tests;

use std::collections::VecDeque;

/// Brush edit codes: Brush subtract and add, Refine Edge Brush and its erase mode, and no edit.
pub const SUBTRACT: u8 = 0;
pub const REFINE: u8 = 64;
pub const NONE: u8 = 128;
pub const KEEP_EDGE: u8 = 192;
pub const ADD: u8 = 255;

// The band radius the Refine Edge Brush uses when Radius is smaller.
const FORCE_R: f32 = 4.0;
// Smooth 100 blurs the hard edge with this sigma before it is cut again.
const SMOOTH_SIGMA: f32 = 4.0;
// Shift Edge moves at most this far.
const SHIFT_MAX: f32 = 64.0;
// Color distance (0..1 RGB) from which the projected alpha is fully trusted.
const SURE: f32 = 0.25;
const LEVEL: f32 = 1.0 / 255.0;

/// Global settings in Photoshop's units.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Params {
    /// Edge Detection Radius, 0..250 px.
    pub radius: f32,
    pub smart: bool,
    /// 0..100.
    pub smooth: f32,
    /// 0..1000 px.
    pub feather: f32,
    /// 0..100 %.
    pub contrast: f32,
    /// -100..100 %: a share of max(4 px, Radius).
    pub shift: f32,
}

impl Params {
    /// From `[radius, smart (0 or 1), smooth, feather, contrast, shift edge]`.
    pub fn from_slice(v: &[f32]) -> Result<Params, String> {
        let [radius, smart, smooth, feather, contrast, shift] = v else {
            return Err("Select and Mask takes 6 settings".into());
        };
        let check = |v: f32, lo: f32, hi: f32, name: &str| {
            if v.is_finite() && (lo..=hi).contains(&v) { Ok(v) } else { Err(format!("{name} must be between {lo} and {hi}")) }
        };
        Ok(Params {
            radius: check(*radius, 0.0, 250.0, "Radius")?,
            smart: *smart != 0.0,
            smooth: check(*smooth, 0.0, 100.0, "Smooth")?,
            feather: check(*feather, 0.0, 1000.0, "Feather")?,
            contrast: check(*contrast, 0.0, 100.0, "Contrast")?,
            shift: check(*shift, -100.0, 100.0, "Shift Edge")?,
        })
    }
}

pub struct Refined {
    pub alpha: Vec<f32>,
    /// Where Edge Detection changed the selection (Show Edge).
    pub band: Vec<bool>,
}

/// Refines coverage `sel` (`w x h`, 0..1) against the straight RGBA8 `rgba`; `k` scales every pixel setting (a
/// preview at a smaller size), `edits` is empty or `w x h` edit codes.
pub fn refine(sel: &[f32], rgba: &[u8], w: usize, h: usize, p: &Params, k: f32, edits: &[u8]) -> Refined {
    let n = w * h;
    let mut s = sel.to_vec();
    if edits.len() == n {
        for (v, &e) in s.iter_mut().zip(edits) {
            match e {
                ADD => *v = 1.0,
                SUBTRACT => *v = 0.0,
                _ => {}
            }
        }
    }
    let band = edges(&mut s, rgba, w, h, p.radius * k, p.smart, if edits.len() == n { edits } else { &[] });
    if p.smooth > 0.0 {
        let sigma = p.smooth / 100.0 * SMOOTH_SIGMA * k;
        let hard: Vec<f32> = s.iter().map(|&v| if v >= 0.5 { 1.0 } else { 0.0 }).collect();
        let gain = (sigma * (2.0 * std::f32::consts::PI).sqrt()).max(1.0);
        for ((v, b), hv) in s.iter_mut().zip(gauss(&hard, w, h, sigma)).zip(hard) {
            let cut = ((b - 0.5) * gain + 0.5).clamp(0.0, 1.0);
            *v = (*v + cut - hv).clamp(0.0, 1.0);
        }
    }
    if p.feather > 0.0 {
        // Sigma a third of the radius, as Select > Modify > Feather.
        s = gauss(&s, w, h, p.feather * k / 3.0);
    }
    if p.contrast >= 100.0 {
        s.iter_mut().for_each(|v| *v = if *v >= 0.5 { 1.0 } else { 0.0 });
    } else if p.contrast > 0.0 {
        let g = 1.0 / (1.0 - p.contrast / 100.0);
        s.iter_mut().for_each(|v| *v = ((*v - 0.5) * g + 0.5).clamp(0.0, 1.0));
    }
    let d = ((p.shift.abs() / 100.0 * p.radius.max(4.0)).min(SHIFT_MAX) * k).round() as usize;
    if d > 0 {
        s = disc(&s, w, h, d, p.shift > 0.0);
    }
    Refined { alpha: s, band }
}

// Edge Detection over the bounding box of the edge and the forced pixels plus the reach of its windows.
fn edges(s: &mut [f32], rgba: &[u8], w: usize, h: usize, r: f32, smart: bool, edits: &[u8]) -> Vec<bool> {
    let n = w * h;
    let any_force = edits.contains(&REFINE);
    let mut band = vec![false; n];
    if r < 0.5 && !any_force {
        return band;
    }
    let rw = r.max(if any_force { FORCE_R } else { 0.0 }).ceil() as usize;
    let hard = |i: usize| s[i] >= 0.5;
    let mut bb: Option<[usize; 4]> = None;
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            let edge = (x + 1 < w && hard(i) != hard(i + 1)) || (y + 1 < h && hard(i) != hard(i + w)) || edits.get(i) == Some(&REFINE);
            if edge {
                bb = Some(bb.map_or([x, y, x + 2, y + 2], |b| [b[0].min(x), b[1].min(y), b[2].max(x + 2), b[3].max(y + 2)]));
            }
        }
    }
    let Some(b) = bb else { return band };
    let m = 3 * rw + 2;
    let (x0, y0, x1, y1) = (b[0].saturating_sub(m), b[1].saturating_sub(m), (b[2] + m).min(w), (b[3] + m).min(h));
    let (cw, ch) = (x1 - x0, y1 - y0);
    let crop = |f: &dyn Fn(usize) -> f32| -> Vec<f32> { (0..cw * ch).map(|j| f((y0 + j / cw) * w + x0 + j % cw)).collect() };
    let cs = crop(&|i| s[i]);
    let ce: Vec<u8> = if edits.is_empty() { Vec::new() } else { (0..cw * ch).map(|j| edits[(y0 + j / cw) * w + x0 + j % cw]).collect() };
    let rgb: [Vec<f32>; 3] = std::array::from_fn(|c| {
        crop(&|i| {
            let a = rgba[i * 4 + 3] as f32 / 255.0;
            (rgba[i * 4 + c] as f32 * a + 128.0 * (1.0 - a)) / 255.0
        })
    });
    let (alpha, weight) = edges_in(&cs, &rgb, cw, ch, r, rw, smart, &ce);
    for j in 0..cw * ch {
        let i = (y0 + j / cw) * w + x0 + j % cw;
        if weight[j] > 0.0 {
            s[i] += (alpha[j] - s[i]) * weight[j];
            band[i] = true;
        }
    }
    band
}

// The projected alpha and its weight per pixel of a crop; `rw` is the window radius (>= r).
#[allow(clippy::too_many_arguments)]
fn edges_in(s: &[f32], rgb: &[Vec<f32>; 3], w: usize, h: usize, r: f32, rw: usize, smart: bool, edits: &[u8]) -> (Vec<f32>, Vec<f32>) {
    let n = w * h;
    let code = |i: usize| edits.get(i).copied().unwrap_or(NONE);
    let hard: Vec<f32> = s.iter().map(|&v| if v >= 0.5 { 1.0 } else { 0.0 }).collect();
    // The share of the other class in each window: 0 deep inside either class, about 1/2 at the edge.
    let other: Vec<f32> = box_mean(&hard, w, h, rw).into_iter().zip(&hard).map(|(m, &hv)| if hv > 0.0 { 1.0 - m } else { m }).collect();
    let sure = |i: usize, class: f32| hard[i] == class && other[i] == 0.0 && code(i) != REFINE;
    let kf: Vec<f32> = (0..n).map(|i| sure(i, 1.0) as u8 as f32).collect();
    let kb: Vec<f32> = (0..n).map(|i| sure(i, 0.0) as u8 as f32).collect();
    // Mean colors of the sure pixels within reach of the far side of the band.
    let rr = 2 * rw + 1;
    let (cf, cb) = (box_mean(&kf, w, h, rr), box_mean(&kb, w, h, rr));
    let (mut num, mut den) = (vec![0f32; n], vec![0f32; n]);
    for ch in rgb {
        let f = box_mean(&ch.iter().zip(&kf).map(|(v, k)| v * k).collect::<Vec<_>>(), w, h, rr);
        let b = box_mean(&ch.iter().zip(&kb).map(|(v, k)| v * k).collect::<Vec<_>>(), w, h, rr);
        for i in 0..n {
            if cf[i] > 0.0 && cb[i] > 0.0 {
                let (fi, bi) = (f[i] / cf[i], b[i] / cb[i]);
                num[i] += (ch[i] - bi) * (fi - bi);
                den[i] += (fi - bi) * (fi - bi);
            }
        }
    }
    let alpha: Vec<f32> = (0..n)
        .map(|i| {
            // Mean colors less than one 8-bit level apart carry no information.
            if den[i] < LEVEL * LEVEL {
                return s[i];
            }
            let trust = (den[i].sqrt() / SURE).min(1.0);
            (num[i] / den[i]).clamp(0.0, 1.0) * trust + s[i] * (1.0 - trust)
        })
        .collect();
    // Distance to the edge from the window share: d = rw + 1/2 - other * (2 rw + 1) on a straight edge.
    let side = (2 * rw + 1) as f32;
    let reach: Vec<f32> = if smart {
        // Where the alpha is mostly 0 or 1 near a pixel the edge is clean: a quarter of the radius is enough.
        let soft: Vec<f32> = alpha.iter().map(|a| 4.0 * a * (1.0 - a)).collect();
        box_mean(&soft, w, h, (rw / 2).max(1)).into_iter().map(|m| r * (2.0 * m).clamp(0.25, 1.0)).collect()
    } else {
        vec![r; n]
    };
    let weight = (0..n)
        .map(|i| match code(i) {
            REFINE => 1.0,
            KEEP_EDGE => 0.0,
            _ => (reach[i] + 0.5 - (rw as f32 + 0.5 - other[i] * side)).clamp(0.0, 1.0),
        })
        .collect();
    (alpha, weight)
}

/// Mean over a (2r + 1)^2 window clipped to the image.
fn box_mean(v: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    if r == 0 || v.is_empty() {
        return v.to_vec();
    }
    let mut tmp = vec![0f32; w * h];
    for (row, out) in v.chunks_exact(w).zip(tmp.chunks_exact_mut(w)) {
        let (mut sum, mut lo, mut hi) = (0f64, 0usize, 0usize);
        for (x, o) in out.iter_mut().enumerate() {
            while hi < (x + r + 1).min(w) {
                sum += row[hi] as f64;
                hi += 1;
            }
            while lo < x.saturating_sub(r) {
                sum -= row[lo] as f64;
                lo += 1;
            }
            *o = (sum / (hi - lo) as f64) as f32;
        }
    }
    let mut out = vec![0f32; w * h];
    let mut sum = vec![0f64; w];
    let (mut lo, mut hi) = (0usize, 0usize);
    for y in 0..h {
        while hi < (y + r + 1).min(h) {
            sum.iter_mut().zip(&tmp[hi * w..(hi + 1) * w]).for_each(|(s, &t)| *s += t as f64);
            hi += 1;
        }
        while lo < y.saturating_sub(r) {
            sum.iter_mut().zip(&tmp[lo * w..(lo + 1) * w]).for_each(|(s, &t)| *s -= t as f64);
            lo += 1;
        }
        let cnt = (hi - lo) as f64;
        out[y * w..(y + 1) * w].iter_mut().zip(&sum).for_each(|(o, &s)| *o = (s / cnt) as f32);
    }
    out
}

/// Gaussian blur with windows clipped to the image (no fading at the canvas edge): an exact kernel for small
/// sigmas, three box passes (W. Jarosz, "Fast Image Convolutions", 2001) for large ones.
fn gauss(v: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    if sigma <= 0.0 {
        return v.to_vec();
    }
    if sigma >= 2.0 {
        // Box widths whose three passes give the variance sigma^2.
        let n = 3.0;
        let ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
        let mut wl = ideal.floor() as i32;
        if wl % 2 == 0 {
            wl -= 1;
        }
        let m = ((12.0 * sigma * sigma - n * (wl * wl) as f32 - 4.0 * n * wl as f32 - 3.0 * n) / (-4.0 * wl as f32 - 4.0)).round() as i32;
        let mut out = v.to_vec();
        for i in 0..3 {
            let width = if i < m { wl } else { wl + 2 };
            out = box_mean(&out, w, h, ((width - 1) / 2).max(0) as usize);
        }
        return out;
    }
    let kernel = crate::selection::gaussian_kernel((3.0 * sigma) as f64);
    let k = kernel.len() / 2;
    let pass = |src: &[f32], horizontal: bool| -> Vec<f32> {
        let mut out = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                let (mut acc, mut wsum) = (0f32, 0f32);
                for (j, &kv) in kernel.iter().enumerate() {
                    let (sx, sy) = if horizontal { ((x + j) as isize - k as isize, y as isize) } else { (x as isize, (y + j) as isize - k as isize) };
                    if sx >= 0 && sy >= 0 && (sx as usize) < w && (sy as usize) < h {
                        acc += src[sy as usize * w + sx as usize] * kv;
                        wsum += kv;
                    }
                }
                out[y * w + x] = acc / wsum;
            }
        }
        out
    };
    pass(&pass(v, true), false)
}

/// Grey dilation (`grow`) or erosion by a disc of radius `d`, windows clipped to the image: one windowed
/// maximum (or minimum) per row offset, as wide as the disc at that offset.
fn disc(v: &[f32], w: usize, h: usize, d: usize, grow: bool) -> Vec<f32> {
    let key = |x: f32| if grow { x } else { -x };
    let mut out: Vec<f32> = v.iter().map(|&x| key(x)).collect();
    let src = out.clone();
    let mut row = vec![0f32; w];
    let mut dq = VecDeque::new();
    for dy in -(d as isize)..=d as isize {
        let half = (((d * d) as isize - dy * dy) as f64).sqrt().floor() as usize;
        for y in 0..h {
            let sy = y as isize + dy;
            if sy < 0 || sy >= h as isize {
                continue;
            }
            window_max(&src[sy as usize * w..(sy as usize + 1) * w], half, &mut row, &mut dq);
            out[y * w..(y + 1) * w].iter_mut().zip(&row).for_each(|(o, &r)| *o = o.max(r));
        }
    }
    out.iter_mut().for_each(|x| *x = key(*x));
    out
}

// out[x] = max(v[x - half ..= x + half]) clipped to the row, with a monotonic queue.
fn window_max(v: &[f32], half: usize, out: &mut [f32], dq: &mut VecDeque<usize>) {
    dq.clear();
    let mut next = 0;
    for (x, o) in out.iter_mut().enumerate() {
        while next <= (x + half).min(v.len() - 1) {
            while dq.back().is_some_and(|&b| v[b] <= v[next]) {
                dq.pop_back();
            }
            dq.push_back(next);
            next += 1;
        }
        while dq.front().is_some_and(|&f| f + half < x) {
            dq.pop_front();
        }
        *o = v[dq[0]];
    }
}

/// Area mean of `v` (`w x h`) at `mw x mh`.
pub fn downscale_mean(v: &[f32], w: usize, h: usize, mw: usize, mh: usize) -> Vec<f32> {
    let xs: Vec<(usize, usize)> = (0..mw).map(|o| crate::matte::span(o, mw, 0, w as i32, w)).collect();
    let mut out = vec![0f32; mw * mh];
    for oy in 0..mh {
        let (y0, y1) = crate::matte::span(oy, mh, 0, h as i32, h);
        for (ox, &(x0, x1)) in xs.iter().enumerate() {
            let sum: f32 = (y0..y1).map(|y| v[y * w + x0..y * w + x1].iter().sum::<f32>()).sum();
            out[oy * mw + ox] = sum / ((y1 - y0) * (x1 - x0)) as f32;
        }
    }
    out
}

/// Working-size edits (`mw x mh`) at `w x h`: the Brush's add and subtract areas interpolated so their outlines
/// stay smooth, the Refine Edge Brush codes from the nearest working pixel. Empty stays empty.
pub fn upsample_edits(e: &[u8], mw: usize, mh: usize, w: usize, h: usize) -> Vec<u8> {
    if e.is_empty() || mw == 0 || mh == 0 {
        return Vec::new();
    }
    let at = |i: usize, len: usize, n: usize| {
        let f = ((i as f32 + 0.5) * n as f32 / len as f32 - 0.5).clamp(0.0, (n - 1) as f32);
        let i0 = f as usize;
        (i0, (i0 + 1).min(n - 1), f - i0 as f32)
    };
    let mut out = vec![NONE; w * h];
    for y in 0..h {
        let (r0, r1, ty) = at(y, h, mh);
        for x in 0..w {
            let (c0, c1, tx) = at(x, w, mw);
            let share = |code: u8| {
                let v = |r: usize, c: usize| (e[r * mw + c] == code) as u8 as f32;
                let top = v(r0, c0) + (v(r0, c1) - v(r0, c0)) * tx;
                let bot = v(r1, c0) + (v(r1, c1) - v(r1, c0)) * tx;
                top + (bot - top) * ty
            };
            let near = e[if ty < 0.5 { r0 } else { r1 } * mw + if tx < 0.5 { c0 } else { c1 }];
            out[y * w + x] = if share(ADD) >= 0.5 {
                ADD
            } else if share(SUBTRACT) >= 0.5 {
                SUBTRACT
            } else if near == REFINE || near == KEEP_EDGE {
                near
            } else {
                NONE
            };
        }
    }
    out
}
