//! Select > Focus Area: where an image is sharp, from the local energy of its Laplacian at a working size of
//! at most 1024 px per side. In-Focus Range (0..7.5) sets the share of the sharpest detail an area needs, from
//! everything at 0 to only the sharpest at 7.5; Image Noise Level (0..1) subtracts a noise floor from the
//! energy first. A majority filter turns the per-pixel decision into areas; edits from the Add and Remove
//! brushes override it.

#[cfg(test)]
#[path = "focus_tests.rs"]
mod tests;

use crate::matte::box_mean;

/// In-Focus Range and Image Noise Level maxima.
pub const RANGE_MAX: f32 = 7.5;
pub const NOISE_MAX: f32 = 1.0;
const WORK: usize = 1024;
// Laplacian energy (luma 0..255 units) that Image Noise Level 1 removes.
const NOISE_SCALE: f32 = 24.0;
// The sharpest detail below this score (energy 2) means the image has nothing in focus.
const FLAT: f32 = 1.0986;

/// The working size for a w x h image: at most 1024 px per side, never larger than the image.
pub fn work_size(w: usize, h: usize) -> (usize, usize) {
    let k = (WORK as f64 / w.max(h).max(1) as f64).min(1.0);
    (((w as f64 * k).round() as usize).max(1), ((h as f64 * k).round() as usize).max(1))
}

// The `q` quantile (0..1) of `v`.
fn quantile(v: &[f32], q: f32) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    let k = ((s.len() - 1) as f32 * q).round() as usize;
    *s.select_nth_unstable_by(k, f32::total_cmp).1
}

// Otsu's threshold of `v` over 256 bins in 0..=top.
fn otsu(v: &[f32], top: f32) -> f32 {
    let mut hist = [0f64; 256];
    for &x in v {
        hist[((x / top * 255.0).round().clamp(0.0, 255.0)) as usize] += 1.0;
    }
    let total: f64 = hist.iter().sum();
    let sum: f64 = hist.iter().enumerate().map(|(i, &n)| i as f64 * n).sum();
    let (mut w0, mut s0, mut best, mut at) = (0f64, 0f64, -1f64, 0usize);
    for (i, &n) in hist.iter().enumerate() {
        w0 += n;
        s0 += i as f64 * n;
        let w1 = total - w0;
        if w0 == 0.0 || w1 == 0.0 {
            continue;
        }
        let d = s0 / w0 - (sum - s0) / w1;
        let between = w0 * w1 * d * d;
        if between > best {
            best = between;
            at = i;
        }
    }
    (at as f32 + 0.5) / 255.0 * top
}

fn round2(v: f32) -> f32 {
    (v * 100.0).round() / 100.0
}

/// One analysis of an image; masks for any slider values come from it without reading the image again.
pub struct Focus {
    pub w: usize,
    pub h: usize,
    // RMS Laplacian of the luma over 5 x 5 pixels, per working pixel.
    energy: Vec<f32>,
}

impl Focus {
    /// Analyses a straight RGBA8 image (`w x h`); transparent pixels count as flat grey.
    pub fn new(src: &[u8], w: usize, h: usize) -> Focus {
        let (mw, mh) = work_size(w, h);
        let small = crate::matte::downscale_rgba(src, w, h, [0, 0, w as i32, h as i32], mw, mh, 128);
        let l: Vec<f32> = small.chunks(4).map(|p| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32).collect();
        let at = |x: usize, y: usize| l[y * mw + x];
        let mut d2 = vec![0f32; mw * mh];
        for y in 0..mh {
            for x in 0..mw {
                let lap = at(x.saturating_sub(1), y) + at((x + 1).min(mw - 1), y) + at(x, y.saturating_sub(1)) + at(x, (y + 1).min(mh - 1)) - 4.0 * at(x, y);
                d2[y * mw + x] = lap * lap;
            }
        }
        let energy = box_mean(&d2, mw, mh, 2).into_iter().map(f32::sqrt).collect();
        Focus { w: mw, h: mh, energy }
    }

    fn score(&self, noise: f32) -> Vec<f32> {
        let floor = noise.clamp(0.0, NOISE_MAX) * NOISE_SCALE;
        self.energy.iter().map(|&e| (e - floor).max(0.0).ln_1p()).collect()
    }

    /// Automatic In-Focus Range and Image Noise Level, rounded to hundredths: the noise floor is the energy of
    /// the flattest quarter of the image; the range splits the scores in two classes (Otsu).
    pub fn auto(&self) -> (f32, f32) {
        let noise = round2((quantile(&self.energy, 0.25) * 1.2 / NOISE_SCALE).clamp(0.0, NOISE_MAX));
        let s = self.score(noise);
        let top = quantile(&s, 0.99);
        if top < FLAT {
            return (RANGE_MAX / 2.0, noise);
        }
        (round2((otsu(&s, top) / top * RANGE_MAX).clamp(0.0, RANGE_MAX)), noise)
    }

    /// The in-focus mask (`w x h`, 0 or 255): all 0 when nothing in the image has detail. `edits` is empty or
    /// `w x h`: 255 adds, 0 removes, other values keep.
    pub fn mask(&self, range: f32, noise: f32, edits: &[u8]) -> Vec<u8> {
        let s = self.score(noise);
        let top = quantile(&s, 0.99);
        let mut out = vec![0u8; self.w * self.h];
        if top >= FLAT {
            let thr = range.clamp(0.0, RANGE_MAX) / RANGE_MAX * top;
            let b: Vec<f32> = s.iter().map(|&v| if v >= thr { 1.0 } else { 0.0 }).collect();
            let m = box_mean(&b, self.w, self.h, (self.w.max(self.h) / 48).max(2));
            for (o, v) in out.iter_mut().zip(m) {
                *o = if v >= 0.5 { 255 } else { 0 };
            }
        }
        if edits.len() == out.len() {
            for (o, &e) in out.iter_mut().zip(edits) {
                if e == 0 || e == 255 {
                    *o = e;
                }
            }
        }
        out
    }
}
