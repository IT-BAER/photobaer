//! Select > Subject without a learned model: a salient-object mask for a distinct subject on a
//! calmer background. Built from the public papers: SLIC superpixels (Achanta et al., TPAMI 2012),
//! boundary-connectivity saliency optimization (Zhu, Liang, Wei, Sun, CVPR 2014), frequency-tuned
//! saliency (Achanta et al., CVPR 2009) and an iterated graph cut (GrabCut, Rother et al. 2004)
//! solved with Boykov-Kolmogorov max-flow. Not a semantic segmenter.

mod maxflow;

use maxflow::Graph;

#[cfg(test)]
#[path = "subject_tests.rs"]
mod tests;

// Working image area; everything up to the final upsample runs at this size.
const WORK_PX: f64 = 100_000.0;
const SUPERPIXELS: usize = 300;
const COMPACTNESS: f32 = 10.0;
const SLIC_ITERS: usize = 8;
// Zhu et al. 2014: colour sigma (Lab), boundary-connectivity sigma, spatial sigma (image units), smoothness floor.
const SIGMA_CLR: f32 = 10.0;
const SIGMA_BND: f32 = 1.0;
const SIGMA_SPA: f32 = 0.25;
const MU: f32 = 0.1;
// Lab steps below this add no geodesic distance, so a noisy or softly textured background stays one region.
const GEO_CLIP: f32 = 3.0;
// No two superpixels further apart than this (Lab) means a flat image.
const FLAT_DE: f32 = 8.0;
// Saliency of the subject guess must exceed the rest by this much.
const MIN_CONTRAST: f32 = 0.2;
const FT_WEIGHT: f32 = 0.2;
// Below this saliency a pixel is fixed background for the graph cut.
const FIXED_BG: f32 = 0.08;
const GRAPH_ITERS: usize = 4;
// GrabCut smoothness weight and the weight of the saliency prior next to the colour model.
const GAMMA: f32 = 50.0;
const SALIENCY_PRIOR: f32 = 1.0;
const HARD: f32 = 1.0e4;
// Guided upsample (He et al. 2010): radius in working pixels and regularization in luma^2.
const GUIDE_R: usize = 2;
const GUIDE_EPS: f32 = 0.0025;

/// The subject mask (0..1 per pixel, `w * h`) of a straight RGBA8 image, or None when the image has
/// no distinct subject (flat, empty or no salient region).
pub fn select_subject(src: &[u8], w: u32, h: u32) -> Option<Vec<f32>> {
    let (w, h) = (w as usize, h as usize);
    if w < 2 || h < 2 || src.len() < w * h * 4 {
        return None;
    }
    let work = Work::new(src, w, h);
    let sp = Superpixels::new(&work);
    let sal = saliency(&work, &sp)?;
    let init = initial_guess(&sal)?;
    let mask = graph_cut(&work, &sal, init);
    let mask = cleanup(mask, work.w, work.h)?;
    Some(upsample(&work, &mask, src, w, h))
}

// ---------- working image ----------

struct Work {
    w: usize,
    h: usize,
    rgb: Vec<[f32; 3]>,
    lab: Vec<[f32; 3]>,
    matte: f32,
}

// Colour over a grey `matte` (0..255), so transparency reads as background.
fn over(src: &[u8], p: usize, matte: f32) -> [f32; 3] {
    let a = src[p * 4 + 3] as f32 / 255.0;
    [0, 1, 2].map(|i| src[p * 4 + i] as f32 * a + matte * (1.0 - a))
}

// White under dark layer content, black under light content: a dark shape on transparency stands out.
fn matte_for(src: &[u8], n: usize) -> f32 {
    let (mut sum, mut wsum) = (0f64, 0f64);
    for p in 0..n {
        let a = src[p * 4 + 3] as f64;
        sum += a * luma([src[p * 4] as f32, src[p * 4 + 1] as f32, src[p * 4 + 2] as f32]) as f64;
        wsum += a;
    }
    if wsum > 0.0 && sum / wsum < 0.5 { 255.0 } else { 0.0 }
}

fn luma(c: [f32; 3]) -> f32 {
    (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255.0
}

fn to_lab(c: [f32; 3]) -> [f32; 3] {
    let lin = |v: f32| {
        let v = v / 255.0;
        if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (lin(c[0]), lin(c[1]), lin(c[2]));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn dist2(a: [f32; 3], b: [f32; 3]) -> f32 {
    (a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)
}

impl Work {
    // Area-average downscale to about WORK_PX pixels.
    fn new(src: &[u8], w: usize, h: usize) -> Work {
        let s = (WORK_PX / (w * h) as f64).sqrt().min(1.0);
        let ww = ((w as f64 * s).round() as usize).clamp(1, w);
        let wh = ((h as f64 * s).round() as usize).clamp(1, h);
        let matte = matte_for(src, w * h);
        let xmap: Vec<usize> = (0..w).map(|x| x * ww / w).collect();
        let mut acc = vec![[0f32; 3]; ww * wh];
        let mut cnt = vec![0u32; ww * wh];
        for y in 0..h {
            let row = (y * wh / h) * ww;
            for (x, &wx) in xmap.iter().enumerate() {
                let c = over(src, y * w + x, matte);
                let k = row + wx;
                for i in 0..3 {
                    acc[k][i] += c[i];
                }
                cnt[k] += 1;
            }
        }
        let rgb: Vec<[f32; 3]> = acc.iter().zip(&cnt).map(|(a, &n)| a.map(|v| v / n.max(1) as f32)).collect();
        let lab = rgb.iter().map(|&c| to_lab(c)).collect();
        Work { w: ww, h: wh, rgb, lab, matte }
    }
}

// ---------- SLIC superpixels ----------

struct Superpixels {
    label: Vec<u32>,
    n: usize,
    lab: Vec<[f32; 3]>,
    // Centroid in units of the longer image side.
    pos: Vec<[f32; 2]>,
    boundary: Vec<bool>,
    adj: Vec<Vec<usize>>,
}

impl Superpixels {
    fn new(work: &Work) -> Superpixels {
        let label = slic(work);
        let n = label.iter().max().map_or(0, |&m| m as usize + 1);
        let (w, h) = (work.w, work.h);
        let side = w.max(h) as f32;
        let mut sum = vec![[0f64; 6]; n];
        let mut boundary = vec![false; n];
        let mut adj = vec![Vec::new(); n];
        for y in 0..h {
            for x in 0..w {
                let p = y * w + x;
                let l = label[p] as usize;
                let c = work.lab[p];
                let s = &mut sum[l];
                s[0] += c[0] as f64;
                s[1] += c[1] as f64;
                s[2] += c[2] as f64;
                s[3] += x as f64 + 0.5;
                s[4] += y as f64 + 0.5;
                s[5] += 1.0;
                if x == 0 || y == 0 || x == w - 1 || y == h - 1 {
                    boundary[l] = true;
                }
                for q in [(x + 1 < w).then(|| p + 1), (y + 1 < h).then(|| p + w)].into_iter().flatten() {
                    let m = label[q] as usize;
                    if m != l {
                        adj[l].push(m);
                        adj[m].push(l);
                    }
                }
            }
        }
        for a in &mut adj {
            a.sort_unstable();
            a.dedup();
        }
        let lab = sum.iter().map(|s| [(s[0] / s[5]) as f32, (s[1] / s[5]) as f32, (s[2] / s[5]) as f32]).collect();
        let pos = sum.iter().map(|s| [(s[3] / s[5]) as f32 / side, (s[4] / s[5]) as f32 / side]).collect();
        Superpixels { label, n, lab, pos, boundary, adj }
    }
}

// Labels 0..n of k-means in (Lab, xy) seeded on a grid, then made connected.
fn slic(work: &Work) -> Vec<u32> {
    let (w, h) = (work.w, work.h);
    let n = w * h;
    let step = (n as f32 / SUPERPIXELS as f32).sqrt().max(1.0);
    let nx = ((w as f32 / step).round() as usize).max(1);
    let ny = ((h as f32 / step).round() as usize).max(1);
    let (sx, sy) = (w as f32 / nx as f32, h as f32 / ny as f32);
    let grad = |x: usize, y: usize| {
        let at = |x: usize, y: usize| work.lab[y * w + x];
        let (xl, xr, yu, yd) = (x.saturating_sub(1), (x + 1).min(w - 1), y.saturating_sub(1), (y + 1).min(h - 1));
        dist2(at(xr, y), at(xl, y)) + dist2(at(x, yd), at(x, yu))
    };
    // Centre: l, a, b, x, y. Seeds move to the lowest gradient in their 3x3 so none starts on an edge.
    let mut centers: Vec<[f32; 5]> = Vec::with_capacity(nx * ny);
    for j in 0..ny {
        for i in 0..nx {
            let cx = (((i as f32 + 0.5) * sx) as usize).min(w - 1);
            let cy = (((j as f32 + 0.5) * sy) as usize).min(h - 1);
            let mut best = (grad(cx, cy), cx, cy);
            for y in cy.saturating_sub(1)..=(cy + 1).min(h - 1) {
                for x in cx.saturating_sub(1)..=(cx + 1).min(w - 1) {
                    let g = grad(x, y);
                    if g < best.0 {
                        best = (g, x, y);
                    }
                }
            }
            let c = work.lab[best.2 * w + best.1];
            centers.push([c[0], c[1], c[2], best.1 as f32, best.2 as f32]);
        }
    }
    let s = sx.max(sy);
    let m2 = (COMPACTNESS / s).powi(2);
    let mut label = vec![u32::MAX; n];
    let mut dist = vec![f32::INFINITY; n];
    for _ in 0..SLIC_ITERS {
        dist.fill(f32::INFINITY);
        for (k, c) in centers.iter().enumerate() {
            let x0 = (c[3] - s).floor().max(0.0) as usize;
            let x1 = ((c[3] + s).ceil() as usize).min(w - 1);
            let y0 = (c[4] - s).floor().max(0.0) as usize;
            let y1 = ((c[4] + s).ceil() as usize).min(h - 1);
            for y in y0..=y1 {
                let dy = y as f32 - c[4];
                for x in x0..=x1 {
                    let p = y * w + x;
                    let dx = x as f32 - c[3];
                    let d = dist2(work.lab[p], [c[0], c[1], c[2]]) + (dx * dx + dy * dy) * m2;
                    if d < dist[p] {
                        dist[p] = d;
                        label[p] = k as u32;
                    }
                }
            }
        }
        let mut sum = vec![[0f64; 6]; centers.len()];
        for (p, &l) in label.iter().enumerate() {
            if l != u32::MAX {
                let c = work.lab[p];
                let s = &mut sum[l as usize];
                s[0] += c[0] as f64;
                s[1] += c[1] as f64;
                s[2] += c[2] as f64;
                s[3] += (p % w) as f64;
                s[4] += (p / w) as f64;
                s[5] += 1.0;
            }
        }
        for (c, s) in centers.iter_mut().zip(&sum) {
            if s[5] > 0.0 {
                *c = [0, 1, 2, 3, 4].map(|i| (s[i] / s[5]) as f32);
            }
        }
    }
    connect(&label, w, h, (n / centers.len().max(1) / 4).max(1))
}

// Relabels 4-connected pieces of one label; pieces under `min` merge into the label met before them.
fn connect(label: &[u32], w: usize, h: usize, min: usize) -> Vec<u32> {
    let n = w * h;
    let mut out = vec![u32::MAX; n];
    let mut next = 0u32;
    let mut comp = Vec::new();
    for start in 0..n {
        if out[start] != u32::MAX {
            continue;
        }
        let (sx, sy) = (start % w, start / w);
        let before = if sx > 0 { Some(out[start - 1]) } else if sy > 0 { Some(out[start - w]) } else { None };
        comp.clear();
        comp.push(start);
        out[start] = next;
        let mut i = 0;
        while i < comp.len() {
            let p = comp[i];
            i += 1;
            let (x, y) = (p % w, p / w);
            let nb = [(x > 0).then(|| p - 1), (x + 1 < w).then(|| p + 1), (y > 0).then(|| p - w), (y + 1 < h).then(|| p + w)];
            for q in nb.into_iter().flatten() {
                if out[q] == u32::MAX && label[q] == label[start] {
                    out[q] = next;
                    comp.push(q);
                }
            }
        }
        match before {
            Some(b) if comp.len() < min => {
                for &p in &comp {
                    out[p] = b;
                }
            }
            _ => next += 1,
        }
    }
    out
}

// ---------- saliency ----------

// Per-pixel saliency 0..1 at the working size, or None for a flat image.
fn saliency(work: &Work, sp: &Superpixels) -> Option<Vec<f32>> {
    let n = sp.n;
    if n < 2 {
        return None;
    }
    let d = |i: usize, j: usize| dist2(sp.lab[i], sp.lab[j]).sqrt();
    let spread = (0..n).flat_map(|i| (i + 1..n).map(move |j| (i, j))).map(|(i, j)| d(i, j)).fold(0f32, f32::max);
    if spread < FLAT_DE {
        return None;
    }

    // Geodesic distances over the adjacency graph, with every pair of boundary regions joined
    // (Zhu et al. 2014) so the background reads as one connected region.
    let mut geo = vec![f32::INFINITY; n * n];
    for i in 0..n {
        geo[i * n + i] = 0.0;
        for &j in &sp.adj[i] {
            geo[i * n + j] = (d(i, j) - GEO_CLIP).max(0.0);
        }
    }
    let bnd: Vec<usize> = (0..n).filter(|&i| sp.boundary[i]).collect();
    for &i in &bnd {
        for &j in &bnd {
            if i != j {
                geo[i * n + j] = geo[i * n + j].min((d(i, j) - GEO_CLIP).max(0.0));
            }
        }
    }
    for k in 0..n {
        let row_k: Vec<f32> = geo[k * n..(k + 1) * n].to_vec();
        for i in 0..n {
            let dik = geo[i * n + k];
            if dik.is_infinite() {
                continue;
            }
            let row = &mut geo[i * n..(i + 1) * n];
            for (v, &kj) in row.iter_mut().zip(&row_k) {
                let t = dik + kj;
                if t < *v {
                    *v = t;
                }
            }
        }
    }

    // Boundary connectivity: how much of a region's spanning area lies on the image boundary.
    let w_bg: Vec<f32> = (0..n)
        .map(|i| {
            let (mut area, mut len) = (0f32, 0f32);
            for j in 0..n {
                let g = geo[i * n + j];
                let s = (-g * g / (2.0 * SIGMA_CLR * SIGMA_CLR)).exp();
                area += s;
                if sp.boundary[j] {
                    len += s;
                }
            }
            let b = len / area.sqrt();
            1.0 - (-b * b / (2.0 * SIGMA_BND * SIGMA_BND)).exp()
        })
        .collect();

    // Background-weighted contrast as the foreground cue.
    let mut w_fg: Vec<f32> = (0..n)
        .map(|i| {
            (0..n)
                .map(|j| {
                    let (dx, dy) = (sp.pos[i][0] - sp.pos[j][0], sp.pos[i][1] - sp.pos[j][1]);
                    d(i, j) * (-(dx * dx + dy * dy) / (2.0 * SIGMA_SPA * SIGMA_SPA)).exp() * w_bg[j]
                })
                .sum()
        })
        .collect();
    let top = w_fg.iter().copied().fold(0f32, f32::max);
    if top <= 0.0 {
        return None;
    }
    w_fg.iter_mut().for_each(|v| *v /= top);

    // Minimize sum w_bg s^2 + w_fg (s - 1)^2 + sum w_ij (s_i - s_j)^2 by Gauss-Seidel; the system is
    // diagonally dominant, so it converges.
    let wij: Vec<Vec<f32>> = (0..n)
        .map(|i| sp.adj[i].iter().map(|&j| (-d(i, j).powi(2) / (2.0 * SIGMA_CLR * SIGMA_CLR)).exp() + MU).collect())
        .collect();
    let mut s = w_fg.clone();
    for _ in 0..200 {
        for i in 0..n {
            let (mut num, mut den) = (w_fg[i], w_bg[i] + w_fg[i]);
            for (&j, &wv) in sp.adj[i].iter().zip(&wij[i]) {
                num += wv * s[j];
                den += wv;
            }
            s[i] = if den > 0.0 { num / den } else { 0.0 };
        }
    }

    // Frequency-tuned saliency: distance of the blurred Lab image to its mean.
    let ft = frequency_tuned(work);
    Some(sp.label.iter().zip(&ft).map(|(&l, &f)| ((1.0 - FT_WEIGHT) * s[l as usize] + FT_WEIGHT * f).clamp(0.0, 1.0)).collect())
}

fn frequency_tuned(work: &Work) -> Vec<f32> {
    let (w, h) = (work.w, work.h);
    let k = [1.0f32, 4.0, 6.0, 4.0, 1.0];
    let blur = |src: &[[f32; 3]], horizontal: bool| -> Vec<[f32; 3]> {
        let mut out = vec![[0f32; 3]; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut acc = [0f32; 3];
                for (t, &kv) in k.iter().enumerate() {
                    let o = t as isize - 2;
                    let (qx, qy) = if horizontal {
                        ((x as isize + o).clamp(0, w as isize - 1) as usize, y)
                    } else {
                        (x, (y as isize + o).clamp(0, h as isize - 1) as usize)
                    };
                    let c = src[qy * w + qx];
                    for i in 0..3 {
                        acc[i] += c[i] * kv / 16.0;
                    }
                }
                out[y * w + x] = acc;
            }
        }
        out
    };
    let b = blur(&blur(&work.lab, true), false);
    let mut mean = [0f64; 3];
    for c in &work.lab {
        for i in 0..3 {
            mean[i] += c[i] as f64;
        }
    }
    let mean = mean.map(|v| (v / work.lab.len() as f64) as f32);
    let mut out: Vec<f32> = b.iter().map(|&c| dist2(c, mean).sqrt()).collect();
    let top = out.iter().copied().fold(0f32, f32::max);
    if top > 0.0 {
        out.iter_mut().for_each(|v| *v /= top);
    }
    out
}

// Otsu's threshold on the saliency, clamped to 0.15..0.85; None when the guess does not stand out.
fn initial_guess(sal: &[f32]) -> Option<Vec<bool>> {
    let mut hist = [0f64; 256];
    for &v in sal {
        hist[(v * 255.0).round() as usize] += 1.0;
    }
    let total = sal.len() as f64;
    let sum_all: f64 = hist.iter().enumerate().map(|(i, &c)| i as f64 * c).sum();
    let (mut w0, mut sum0, mut best, mut thr) = (0f64, 0f64, -1f64, 0usize);
    for (i, &c) in hist.iter().enumerate() {
        w0 += c;
        sum0 += i as f64 * c;
        let w1 = total - w0;
        if w0 == 0.0 || w1 == 0.0 {
            continue;
        }
        let (m0, m1) = (sum0 / w0, (sum_all - sum0) / w1);
        let between = w0 * w1 * (m0 - m1).powi(2);
        if between > best {
            best = between;
            thr = i;
        }
    }
    let t = (thr as f32 / 255.0).clamp(0.15, 0.85);
    let fg: Vec<bool> = sal.iter().map(|&v| v > t).collect();
    let (mut sf, mut nf, mut sb, mut nb) = (0f64, 0f64, 0f64, 0f64);
    for (&v, &f) in sal.iter().zip(&fg) {
        if f {
            sf += v as f64;
            nf += 1.0;
        } else {
            sb += v as f64;
            nb += 1.0;
        }
    }
    if nf == 0.0 {
        return None;
    }
    let contrast = sf / nf - if nb > 0.0 { sb / nb } else { 0.0 };
    (contrast >= MIN_CONTRAST as f64).then_some(fg)
}

// ---------- graph cut refinement ----------

// RGB histogram bin (16 levels per channel).
fn bin(c: [f32; 3]) -> usize {
    let q = |v: f32| ((v / 16.0) as usize).min(15);
    (q(c[0]) << 8) | (q(c[1]) << 4) | q(c[2])
}

// -ln p(colour bin) of a histogram smoothed with [1 2 1] along each axis.
fn colour_cost(work: &Work, fg: &[bool], side: bool) -> Vec<f32> {
    let mut h = vec![0f32; 4096];
    for (c, &f) in work.rgb.iter().zip(fg) {
        if f == side {
            h[bin(*c)] += 1.0;
        }
    }
    for axis in [1usize, 16, 256] {
        let src = h.clone();
        for (i, v) in h.iter_mut().enumerate() {
            let coord = (i / axis) % 16;
            let lo = if coord > 0 { src[i - axis] } else { src[i] };
            let hi = if coord < 15 { src[i + axis] } else { src[i] };
            *v = (lo + 2.0 * src[i] + hi) / 4.0;
        }
    }
    let total: f32 = h.iter().sum::<f32>().max(1.0);
    h.iter().map(|&v| -((v / total).max(1e-6)).ln()).collect()
}

fn graph_cut(work: &Work, sal: &[f32], init: Vec<bool>) -> Vec<bool> {
    let (w, h) = (work.w, work.h);
    let n = w * h;
    // Neighbour offsets: right, down, down-right, down-left.
    let dirs: [(isize, isize, f32); 4] = [(1, 0, 1.0), (0, 1, 1.0), (1, 1, std::f32::consts::SQRT_2), (-1, 1, std::f32::consts::SQRT_2)];
    let neighbour = |p: usize, (dx, dy, _): (isize, isize, f32)| {
        let (x, y) = ((p % w) as isize + dx, (p / w) as isize + dy);
        (x >= 0 && x < w as isize && y < h as isize).then(|| y as usize * w + x as usize)
    };
    let (mut sum, mut cnt) = (0f64, 0f64);
    for p in 0..n {
        for &dir in &dirs {
            if let Some(q) = neighbour(p, dir) {
                sum += dist2(work.rgb[p], work.rgb[q]) as f64;
                cnt += 1.0;
            }
        }
    }
    let beta = if sum > 0.0 { (cnt / (2.0 * sum)) as f32 } else { 0.0 };
    let links: Vec<(usize, usize, f32)> = (0..n)
        .flat_map(|p| dirs.iter().filter_map(move |&dir| neighbour(p, dir).map(|q| (p, q, dir.2))))
        .map(|(p, q, len)| (p, q, GAMMA * (-beta * dist2(work.rgb[p], work.rgb[q])).exp() / len))
        .collect();
    let fixed: Vec<bool> = (0..n)
        .map(|p| {
            let (x, y) = (p % w, p / w);
            let border = x == 0 || y == 0 || x == w - 1 || y == h - 1;
            sal[p] < FIXED_BG || (border && !init[p])
        })
        .collect();

    let mut fg = init;
    for _ in 0..GRAPH_ITERS {
        let (cf, cb) = (colour_cost(work, &fg, true), colour_cost(work, &fg, false));
        let mut g = Graph::with_edges(n, links.len());
        for p in 0..n {
            if fixed[p] {
                g.add_tweights(p, 0.0, HARD);
                continue;
            }
            let b = bin(work.rgb[p]);
            let s = sal[p].clamp(0.02, 0.98);
            let d_fg = cf[b] - SALIENCY_PRIOR * s.ln();
            let d_bg = cb[b] - SALIENCY_PRIOR * (1.0 - s).ln();
            g.add_tweights(p, d_bg, d_fg);
        }
        for &(p, q, wv) in &links {
            g.add_edge(p, q, wv, wv);
        }
        g.maxflow();
        let next: Vec<bool> = (0..n).map(|p| g.in_source(p)).collect();
        let same = next == fg;
        fg = next;
        if same || !fg.iter().any(|&f| f) {
            break;
        }
    }
    fg
}

// ---------- cleanup ----------

// Component ids of the pixels equal to `side`, their sizes and whether they touch the border.
fn components(mask: &[bool], w: usize, h: usize, side: bool, eight: bool) -> (Vec<u32>, Vec<usize>, Vec<bool>) {
    let mut id = vec![u32::MAX; w * h];
    let (mut sizes, mut border) = (Vec::new(), Vec::new());
    let mut stack = Vec::new();
    for start in 0..w * h {
        if mask[start] != side || id[start] != u32::MAX {
            continue;
        }
        let c = sizes.len() as u32;
        let (mut size, mut touches) = (0usize, false);
        id[start] = c;
        stack.push(start);
        while let Some(p) = stack.pop() {
            size += 1;
            let (x, y) = ((p % w) as isize, (p / w) as isize);
            touches |= x == 0 || y == 0 || x == w as isize - 1 || y == h as isize - 1;
            for dy in -1..=1isize {
                for dx in -1..=1isize {
                    if (dx == 0 && dy == 0) || (!eight && dx != 0 && dy != 0) {
                        continue;
                    }
                    let (qx, qy) = (x + dx, y + dy);
                    if qx < 0 || qy < 0 || qx >= w as isize || qy >= h as isize {
                        continue;
                    }
                    let q = qy as usize * w + qx as usize;
                    if mask[q] == side && id[q] == u32::MAX {
                        id[q] = c;
                        stack.push(q);
                    }
                }
            }
        }
        sizes.push(size);
        border.push(touches);
    }
    (id, sizes, border)
}

// Drops islands under 5 % of the largest piece and fills enclosed holes under 2 % of the subject.
fn cleanup(mut fg: Vec<bool>, w: usize, h: usize) -> Option<Vec<bool>> {
    let (id, sizes, _) = components(&fg, w, h, true, true);
    let largest = *sizes.iter().max()?;
    for (f, &c) in fg.iter_mut().zip(&id) {
        if *f && (sizes[c as usize] as f32) < 0.05 * largest as f32 {
            *f = false;
        }
    }
    let area = fg.iter().filter(|&&f| f).count();
    let (id, sizes, border) = components(&fg, w, h, false, false);
    for (f, &c) in fg.iter_mut().zip(&id) {
        if !*f && !border[c as usize] && (sizes[c as usize] as f32) < 0.02 * area as f32 {
            *f = true;
        }
    }
    Some(fg)
}

// ---------- upsample ----------

// Box mean of radius r with clamped window (divides by the in-image count).
fn box_mean(v: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
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

// Fast guided upsample against the full-size luma: the linear coefficients come from the working
// image, so the edge snaps to the full-size luma edge; then a hard cut and a 1-pixel feather.
fn upsample(work: &Work, fg: &[bool], src: &[u8], w: usize, h: usize) -> Vec<f32> {
    let (ww, wh) = (work.w, work.h);
    let guide: Vec<f32> = work.rgb.iter().map(|&c| luma(c)).collect();
    let p: Vec<f32> = fg.iter().map(|&f| f as u8 as f32).collect();
    let ip: Vec<f32> = guide.iter().zip(&p).map(|(a, b)| a * b).collect();
    let ii: Vec<f32> = guide.iter().map(|a| a * a).collect();
    let (mi, mp, mip, mii) = (box_mean(&guide, ww, wh, GUIDE_R), box_mean(&p, ww, wh, GUIDE_R), box_mean(&ip, ww, wh, GUIDE_R), box_mean(&ii, ww, wh, GUIDE_R));
    let a: Vec<f32> = (0..ww * wh).map(|k| (mip[k] - mi[k] * mp[k]) / ((mii[k] - mi[k] * mi[k]).max(0.0) + GUIDE_EPS)).collect();
    let b: Vec<f32> = (0..ww * wh).map(|k| mp[k] - a[k] * mi[k]).collect();
    let (ma, mb) = (box_mean(&a, ww, wh, GUIDE_R), box_mean(&b, ww, wh, GUIDE_R));

    let coord = |i: usize, full: usize, small: usize| {
        let f = ((i as f32 + 0.5) * small as f32 / full as f32 - 0.5).clamp(0.0, (small - 1) as f32);
        let i0 = f as usize;
        (i0, (i0 + 1).min(small - 1), f - i0 as f32)
    };
    let xs: Vec<(usize, usize, f32)> = (0..w).map(|x| coord(x, w, ww)).collect();
    let mut hard = vec![0f32; w * h];
    for y in 0..h {
        let (y0, y1, ty) = coord(y, h, wh);
        let (r0, r1) = (y0 * ww, y1 * ww);
        for (x, &(x0, x1, tx)) in xs.iter().enumerate() {
            let lerp = |m: &[f32]| {
                let top = m[r0 + x0] + (m[r0 + x1] - m[r0 + x0]) * tx;
                let bot = m[r1 + x0] + (m[r1 + x1] - m[r1 + x0]) * tx;
                top + (bot - top) * ty
            };
            let q = lerp(&ma) * luma(over(src, y * w + x, work.matte)) + lerp(&mb);
            hard[y * w + x] = if q >= 0.5 { 1.0 } else { 0.0 };
        }
    }
    crate::region::feather1(&hard, w, h)
}
