//! Healing core (docs/M5.md sections 8 and 10): patch search, multi-scale hole fill, Poisson
//! blending, proximity match, create texture and Content-Aware Fill over straight RGBA planes.
//! Masks are w*h slices, on above 0.5 unless stated otherwise.

use std::collections::VecDeque;

use crate::filters::{box_blur, Plane, Rng};

pub const PATCH: usize = 7;
pub const ITERATIONS: usize = 5;
pub const SEARCH_ALPHA: f32 = 0.5;
pub const PASSES: usize = 6;
pub const LEVELS: usize = 7;
pub const SEED: u32 = 1;
const VOTE_EPS: f32 = 0.001;

fn on(m: Option<&[f32]>, i: usize) -> bool {
    m.map_or(true, |m| m[i] > 0.5)
}

/// Nearest-neighbor field: the matched source center per target pixel (-1 = none, err inf).
#[derive(Clone, Debug, PartialEq)]
pub struct Nnf {
    pub w: usize,
    pub h: usize,
    pub ox: Vec<i32>,
    pub oy: Vec<i32>,
    pub err: Vec<f32>,
}

impl Nnf {
    fn empty(w: usize, h: usize) -> Nnf {
        Nnf { w, h, ox: vec![-1; w * h], oy: vec![-1; w * h], err: vec![f32::INFINITY; w * h] }
    }
}

#[derive(Clone, Copy)]
pub struct SearchOpts<'a> {
    pub patch: usize,
    pub iterations: usize,
    pub seed: u32,
    pub alpha: f32,
    /// Valid source centers and source pixels.
    pub source_mask: Option<&'a [f32]>,
    /// Target pixels to search; the others keep their initial entry.
    pub target_mask: Option<&'a [f32]>,
    /// Per target pixel, the hole: its patch terms weigh `unknown_weight` instead of 1.
    pub unknown: Option<&'a [f32]>,
    pub unknown_weight: f32,
    pub initial: Option<&'a Nnf>,
}

impl Default for SearchOpts<'_> {
    fn default() -> Self {
        SearchOpts {
            patch: PATCH,
            iterations: ITERATIONS,
            seed: SEED,
            alpha: SEARCH_ALPHA,
            source_mask: None,
            target_mask: None,
            unknown: None,
            unknown_weight: 1.0,
            initial: None,
        }
    }
}

struct Search<'a> {
    t: &'a Plane,
    s: &'a Plane,
    r: i32,
    /// Per source pixel: inside the source mask.
    sok: Vec<bool>,
    /// Per target pixel: its term weight, `unknown_weight` inside the unknown mask, else 1.
    wt: Vec<f32>,
}

// Flat cost of a patch term whose source pixel is outside the source mask (the channel count).
const MASKED_TERM: f32 = 4.0;

impl Search<'_> {
    fn ok(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as usize) < self.s.w && (y as usize) < self.s.h && self.sok[y as usize * self.s.w + x as usize]
    }

    // Weighted squared RGBA difference summed over the patch, target and source coordinates
    // edge-clamped. Returns early once the sum reaches `best` (terms are never negative).
    fn dist(&self, tx: i32, ty: i32, sx: i32, sy: i32, best: f32) -> f32 {
        let (tw, th, sw, sh) = (self.t.w as i32, self.t.h as i32, self.s.w as i32, self.s.h as i32);
        let r = self.r;
        let mut sum = 0f32;
        // Both patches inside their planes: no clamping, same term order as the clamped loop.
        if tx >= r && ty >= r && tx + r < tw && ty + r < th && sx >= r && sy >= r && sx + r < sw && sy + r < sh {
            let n = (2 * r + 1) as usize;
            for dy in -r..=r {
                let (t0, s0) = (((ty + dy) * tw + tx - r) as usize, ((sy + dy) * sw + sx - r) as usize);
                let terms = self.t.data[t0 * 4..(t0 + n) * 4]
                    .chunks_exact(4)
                    .zip(self.s.data[s0 * 4..(s0 + n) * 4].chunks_exact(4))
                    .zip(&self.wt[t0..t0 + n])
                    .zip(&self.sok[s0..s0 + n]);
                for (((a, b), &w), &ok) in terms {
                    if !ok {
                        sum += MASKED_TERM;
                        continue;
                    }
                    let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
                    sum += w * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + d[3] * d[3]);
                }
                if sum >= best {
                    return sum;
                }
            }
            return sum;
        }
        for dy in -r..=r {
            let (trow, srow) = ((ty + dy).clamp(0, th - 1) * tw, (sy + dy).clamp(0, sh - 1) * sw);
            for dx in -self.r..=self.r {
                let si = (srow + (sx + dx).clamp(0, sw - 1)) as usize;
                if !self.sok[si] {
                    sum += MASKED_TERM;
                    continue;
                }
                let ti = (trow + (tx + dx).clamp(0, tw - 1)) as usize;
                let (a, b) = (&self.t.data[ti * 4..ti * 4 + 4], &self.s.data[si * 4..si * 4 + 4]);
                let d = [a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]];
                sum += self.wt[ti] * (d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + d[3] * d[3]);
            }
            if sum >= best {
                return sum;
            }
        }
        sum
    }

    fn consider(&self, nnf: &mut Nnf, i: usize, x: i32, y: i32, cx: i32, cy: i32) {
        if !self.ok(cx, cy) {
            return;
        }
        let e = self.dist(x, y, cx, cy, nnf.err[i]);
        if e < nnf.err[i] {
            (nnf.ox[i], nnf.oy[i], nnf.err[i]) = (cx, cy, e);
        }
    }
}

/// PatchMatch nearest-neighbor field of `target` patches in `source` (docs/M5.md section 8).
pub fn patch_search(target: &Plane, source: &Plane, o: &SearchOpts) -> Nnf {
    let (w, h, sw) = (target.w, target.h, source.w);
    let mut nnf = match o.initial {
        Some(n) if n.w == w && n.h == h => n.clone(),
        _ => Nnf::empty(w, h),
    };
    let pool: Vec<usize> = (0..sw * source.h).filter(|&i| on(o.source_mask, i)).collect();
    if pool.is_empty() {
        return nnf;
    }
    let s = Search {
        t: target,
        s: source,
        r: (o.patch.max(1) as i32 - 1) / 2,
        sok: (0..sw * source.h).map(|i| on(o.source_mask, i)).collect(),
        wt: (0..w * h).map(|i| if o.unknown.is_some_and(|u| u[i] > 0.5) { o.unknown_weight } else { 1.0 }).collect(),
    };
    let mut rng = Rng::new(o.seed);
    let targets: Vec<usize> = (0..w * h).filter(|&i| on(o.target_mask, i)).collect();
    for &i in &targets {
        let (x, y) = ((i % w) as i32, (i / w) as i32);
        if !s.ok(nnf.ox[i], nnf.oy[i]) {
            let at = pool[((rng.next() * pool.len() as f64) as usize).min(pool.len() - 1)];
            (nnf.ox[i], nnf.oy[i]) = ((at % sw) as i32, (at / sw) as i32);
        }
        nnf.err[i] = s.dist(x, y, nnf.ox[i], nnf.oy[i], f32::INFINITY);
    }
    // Below 1 so the random search radius always shrinks.
    let alpha = o.alpha.clamp(0.0, 0.9) as f64;
    for it in 0..o.iterations {
        let step: i32 = if it % 2 == 0 { 1 } else { -1 };
        for k in 0..targets.len() {
            let i = if step > 0 { targets[k] } else { targets[targets.len() - 1 - k] };
            let (x, y) = ((i % w) as i32, (i / w) as i32);
            for (nx, ny) in [(x - step, y), (x, y - step)] {
                if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                    continue;
                }
                let j = ny as usize * w + nx as usize;
                let (mx, my) = (nnf.ox[j], nnf.oy[j]);
                if mx >= 0 {
                    s.consider(&mut nnf, i, x, y, mx + x - nx, my + y - ny);
                }
            }
            let mut radius = sw.max(source.h) as f64;
            while radius >= 1.0 {
                let (bx, by) = (nnf.ox[i], nnf.oy[i]);
                let cx = bx + (radius * rng.range(-1.0, 1.0)).round() as i32;
                let cy = by + (radius * rng.range(-1.0, 1.0)).round() as i32;
                s.consider(&mut nnf, i, x, y, cx, cy);
                radius *= alpha;
            }
        }
    }
    nnf
}

pub struct FillOpts<'a> {
    pub patch: usize,
    pub iterations: usize,
    pub seed: u32,
    pub source_mask: Option<&'a [f32]>,
    /// Alpha handling: transparent pixels are no source, and the hole ends opaque.
    pub alpha: bool,
    /// The finest level's last vote and the output also cover the hole dilated by 1.
    pub boundary_context: bool,
    /// Initial source offset in full-resolution px.
    pub offset: Option<(f32, f32)>,
}

impl Default for FillOpts<'_> {
    fn default() -> Self {
        FillOpts { patch: PATCH, iterations: ITERATIONS, seed: SEED, source_mask: None, alpha: true, boundary_context: false, offset: None }
    }
}

struct Level {
    img: Plane,
    hole: Vec<bool>,
    valid: Vec<bool>,
}

fn level_seed(seed: u32, level: usize, pass: i32) -> u32 {
    seed.wrapping_mul(2654435761) ^ (level as u32 + 1).wrapping_mul(2246822507) ^ ((pass + 1) as u32).wrapping_mul(3266489909)
}

fn px(p: &Plane, i: usize) -> [f32; 4] {
    std::array::from_fn(|c| p.data[i * 4 + c])
}

fn set_px(p: &mut Plane, i: usize, v: [f32; 4]) {
    p.data[i * 4..i * 4 + 4].copy_from_slice(&v);
}

fn to_f32(m: &[bool]) -> Vec<f32> {
    m.iter().map(|&b| if b { 1.0 } else { 0.0 }).collect()
}

// 2x2 box average (edge clamp); a coarse pixel is hole if any child is, invalid if any child is.
fn downsample(l: &Level) -> Level {
    let (w, h) = (l.img.w, l.img.h);
    let (nw, nh) = (w >> 1, h >> 1);
    let mut img = Plane { x: 0, y: 0, w: nw, h: nh, data: vec![0.0; nw * nh * 4] };
    let (mut hole, mut valid) = (vec![false; nw * nh], vec![true; nw * nh]);
    for y in 0..nh {
        for x in 0..nw {
            let o = y * nw + x;
            let mut acc = [0f32; 4];
            for (i, j) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let c = (2 * y + j).min(h - 1) * w + (2 * x + i).min(w - 1);
                for (a, v) in acc.iter_mut().zip(px(&l.img, c)) {
                    *a += v * 0.25;
                }
                hole[o] |= l.hole[c];
                valid[o] &= l.valid[c];
            }
            set_px(&mut img, o, acc);
        }
    }
    Level { img, hole, valid }
}

// Box dilation of radius r, separable.
fn dilate(m: &[bool], w: usize, h: usize, r: usize) -> Vec<bool> {
    if r == 0 {
        return m.to_vec();
    }
    let pass = |src: &[bool], len: usize, lines: usize, idx: &dyn Fn(usize, usize) -> usize| -> Vec<bool> {
        let mut out = vec![false; w * h];
        let mut pre = vec![0usize; len + 1];
        for line in 0..lines {
            for k in 0..len {
                pre[k + 1] = pre[k] + src[idx(line, k)] as usize;
            }
            for k in 0..len {
                out[idx(line, k)] = pre[(k + r + 1).min(len)] > pre[k.saturating_sub(r)];
            }
        }
        out
    };
    let horiz = pass(m, w, h, &|line, k| line * w + k);
    pass(&horiz, h, w, &|line, k| k * w + line)
}

// Bilinear with pixel-center mapping.
fn upsample(p: &Plane, w: usize, h: usize) -> Plane {
    let (sx, sy) = (p.w as f32 / w as f32, p.h as f32 / h as f32);
    let axis = |v: usize, s: f32, n: usize| {
        let f = ((v as f32 + 0.5) * s - 0.5).clamp(0.0, (n - 1) as f32);
        let i0 = f.floor() as usize;
        (i0, (i0 + 1).min(n - 1), f - i0 as f32)
    };
    let mut out = Plane { x: 0, y: 0, w, h, data: vec![0.0; w * h * 4] };
    for y in 0..h {
        let (y0, y1, ty) = axis(y, sy, p.h);
        for x in 0..w {
            let (x0, x1, tx) = axis(x, sx, p.w);
            let (a, b, c, d) = (px(p, y0 * p.w + x0), px(p, y0 * p.w + x1), px(p, y1 * p.w + x0), px(p, y1 * p.w + x1));
            let v = std::array::from_fn(|k| (a[k] * (1.0 - tx) + b[k] * tx) * (1.0 - ty) + (c[k] * (1.0 - tx) + d[k] * tx) * ty);
            set_px(&mut out, y * w + x, v);
        }
    }
    out
}

// Nearest parent, its offset scaled and rounded; errors reset, the search re-scores or replaces it.
fn upsample_nnf(f: &Nnf, w: usize, h: usize) -> Nnf {
    let (sx, sy) = (w as f32 / f.w as f32, h as f32 / f.h as f32);
    let mut out = Nnf::empty(w, h);
    for y in 0..h {
        for x in 0..w {
            let (px_, py) = ((x * f.w / w).min(f.w - 1), (y * f.h / h).min(f.h - 1));
            let j = py * f.w + px_;
            if f.ox[j] < 0 {
                continue;
            }
            let mx = x as i32 + ((f.ox[j] - px_ as i32) as f32 * sx).round() as i32;
            let my = y as i32 + ((f.oy[j] - py as i32) as f32 * sy).round() as i32;
            (out.ox[y * w + x], out.oy[y * w + x]) = (mx, my);
        }
    }
    out
}

const N4: [(i32, i32); 4] = [(-1, 0), (1, 0), (0, -1), (0, 1)];

// Best matches first, BFS into the hole: a hole pixel takes its parent's match shifted by the
// same step when that source is valid, and that source color.
fn seed_from_best(f: &mut Nnf, img: &mut Plane, hole: &[bool], valid: &[bool]) {
    let (w, h) = (img.w as i32, img.h as i32);
    let mut order: Vec<usize> = (0..f.ox.len()).filter(|&i| f.ox[i] >= 0).collect();
    order.sort_by(|&a, &b| f.err[a].total_cmp(&f.err[b]));
    let mut done = vec![false; f.ox.len()];
    for &i in &order {
        done[i] = true;
    }
    let mut queue: VecDeque<usize> = order.into();
    while let Some(p) = queue.pop_front() {
        let (x, y) = (p as i32 % w, p as i32 / w);
        for (dx, dy) in N4 {
            let (qx, qy) = (x + dx, y + dy);
            if qx < 0 || qy < 0 || qx >= w || qy >= h {
                continue;
            }
            let q = (qy * w + qx) as usize;
            if !hole[q] || done[q] {
                continue;
            }
            let (sx, sy) = (f.ox[p] + dx, f.oy[p] + dy);
            if sx < 0 || sy < 0 || sx >= w || sy >= h || !valid[(sy * w + sx) as usize] {
                continue;
            }
            (f.ox[q], f.oy[q], f.err[q]) = (sx, sy, f.err[p]);
            let c = px(img, (sy * w + sx) as usize);
            set_px(img, q, c);
            done[q] = true;
            queue.push_back(q);
        }
    }
}

// Every matched patch votes its source colors (weight 1/(err+eps)) into the mask pixels it covers;
// source pixels off the plane are skipped, as in the patch distance.
fn vote(img: &mut Plane, f: &Nnf, mask: &[bool], valid: &[bool], r: i32) {
    let (w, h) = (img.w as i32, img.h as i32);
    let mut acc = vec![0f64; img.data.len()];
    let mut wsum = vec![0f64; mask.len()];
    for p in 0..mask.len() {
        if f.ox[p] < 0 || !f.err[p].is_finite() {
            continue;
        }
        let wgt = 1.0 / (f.err[p] as f64 + VOTE_EPS as f64);
        let (x, y) = (p as i32 % w, p as i32 / w);
        for dy in -r..=r {
            for dx in -r..=r {
                let (qx, qy) = (x + dx, y + dy);
                if qx < 0 || qy < 0 || qx >= w || qy >= h || !mask[(qy * w + qx) as usize] {
                    continue;
                }
                let (sx, sy) = ((f.ox[p] + dx).clamp(0, w - 1), (f.oy[p] + dy).clamp(0, h - 1));
                let s = (sy * w + sx) as usize;
                if !valid[s] {
                    continue;
                }
                let q = (qy * w + qx) as usize;
                for c in 0..4 {
                    acc[q * 4 + c] += wgt * img.data[s * 4 + c] as f64;
                }
                wsum[q] += wgt;
            }
        }
    }
    for q in 0..mask.len() {
        if wsum[q] > 0.0 {
            for c in 0..4 {
                img.data[q * 4 + c] = (acc[q * 4 + c] / wsum[q]) as f32;
            }
        }
    }
}

/// Multi-scale PatchMatch hole fill (docs/M5.md section 8): the hole pixels come from the valid
/// pixels of `img`; the rest of the output equals the input.
pub fn hole_fill(img: &Plane, hole: &[f32], o: &FillOpts) -> Plane {
    let (w, h, n) = (img.w, img.h, img.w * img.h);
    let hole0: Vec<bool> = hole.iter().map(|&v| v > 0.5).collect();
    let mut out = img.clone();
    if !hole0.iter().any(|&b| b) {
        return out;
    }
    if hole0.iter().all(|&b| b) {
        if o.alpha {
            out.data.chunks_exact_mut(4).for_each(|p| p[3] = 1.0);
        }
        return out;
    }
    let valid0: Vec<bool> = (0..n).map(|i| !hole0[i] && on(o.source_mask, i) && (!o.alpha || img.data[i * 4 + 3] > 1e-6)).collect();
    if !valid0.iter().any(|&b| b) {
        return out;
    }
    let patch = o.patch.max(1) | 1;
    let r = patch / 2;
    let mut levels = vec![Level { img: Plane { x: 0, y: 0, ..img.clone() }, hole: hole0.clone(), valid: valid0 }];
    while levels.len() < LEVELS {
        let last = levels.last().expect("finest level");
        if (last.img.w >> 1) < 2 * patch || (last.img.h >> 1) < 2 * patch {
            break;
        }
        let next = downsample(last);
        if next.hole.iter().all(|&b| b) || !next.valid.iter().any(|&b| b) {
            break;
        }
        levels.push(next);
    }
    let coarsest = levels.len() - 1;
    let mut cur = levels[coarsest].img.clone();
    {
        let l = &levels[coarsest];
        let (lw, lh) = (l.img.w as i32, l.img.h as i32);
        let mut done: Vec<bool> = l.hole.iter().map(|&b| !b).collect();
        let mut queue: VecDeque<usize> = (0..done.len()).filter(|&i| done[i]).collect();
        while let Some(p) = queue.pop_front() {
            let (x, y) = (p as i32 % lw, p as i32 / lw);
            for (dx, dy) in N4 {
                let (qx, qy) = (x + dx, y + dy);
                if qx < 0 || qy < 0 || qx >= lw || qy >= lh || done[(qy * lw + qx) as usize] {
                    continue;
                }
                let q = (qy * lw + qx) as usize;
                let c = px(&cur, p);
                set_px(&mut cur, q, c);
                done[q] = true;
                queue.push_back(q);
            }
        }
    }
    let mut nnf: Option<Nnf> = None;
    for li in (0..levels.len()).rev() {
        let l = &levels[li];
        let (lw, lh) = (l.img.w, l.img.h);
        if li != coarsest {
            cur = upsample(&cur, lw, lh);
            for i in (0..lw * lh).filter(|&i| !l.hole[i]) {
                set_px(&mut cur, i, px(&l.img, i));
            }
            nnf = nnf.map(|f| upsample_nnf(&f, lw, lh));
        }
        if let (None, Some((dx, dy))) = (&nnf, o.offset) {
            let (dx, dy) = ((dx * lw as f32 / w as f32).round() as i32, (dy * lh as f32 / h as f32).round() as i32);
            let mut f = Nnf::empty(lw, lh);
            for i in 0..lw * lh {
                let (mx, my) = ((i % lw) as i32 + dx, (i / lw) as i32 + dy);
                if mx >= 0 && my >= 0 && (mx as usize) < lw && (my as usize) < lh && l.valid[my as usize * lw + mx as usize] {
                    (f.ox[i], f.oy[i]) = (mx, my);
                }
            }
            nnf = Some(f);
        }
        let hole_m = to_f32(&l.hole);
        let valid_m = to_f32(&l.valid);
        let dil = dilate(&l.hole, lw, lh, r);
        let ring: Vec<f32> = (0..lw * lh).map(|i| if dil[i] && !l.hole[i] { 1.0 } else { 0.0 }).collect();
        let dil_m = to_f32(&dil);
        let base = SearchOpts { patch, iterations: o.iterations, source_mask: Some(&valid_m), unknown: Some(&hole_m), ..SearchOpts::default() };
        let mut f = patch_search(
            &cur,
            &cur,
            &SearchOpts { seed: level_seed(o.seed, li, -1), target_mask: Some(&ring), unknown_weight: 0.0, initial: nnf.as_ref(), ..base },
        );
        seed_from_best(&mut f, &mut cur, &l.hole, &l.valid);
        for t in 0..PASSES {
            f = patch_search(
                &cur,
                &cur,
                &SearchOpts {
                    seed: level_seed(o.seed, li, t as i32),
                    target_mask: Some(&dil_m),
                    unknown_weight: 0.1 + 0.5 * t as f32 / PASSES as f32,
                    initial: Some(&f),
                    ..base
                },
            );
            let ring1 = li == 0 && t == PASSES - 1 && o.boundary_context;
            let mask = if ring1 { dilate(&l.hole, lw, lh, 1) } else { l.hole.clone() };
            vote(&mut cur, &f, &mask, &l.valid, r as i32);
        }
        nnf = Some(f);
    }
    let take = if o.boundary_context { dilate(&hole0, w, h, 1) } else { hole0.clone() };
    for i in (0..n).filter(|&i| take[i]) {
        set_px(&mut out, i, px(&cur, i));
    }
    if o.alpha {
        for i in (0..n).filter(|&i| hole0[i]) {
            out.data[i * 4 + 3] = 1.0;
        }
    }
    out
}

pub struct PoissonOpts {
    pub max_iter: usize,
    pub tol: f32,
    pub omega: f32,
    /// Mixed gradients: per edge the larger of the source and destination gradient.
    pub mixed: bool,
    /// Healing Diffusion: the correction (solution - source) keeps its mean; its variation fades as
    /// exp(-d / fade) with the distance d (px) from the region edge; None keeps it whole.
    pub fade: Option<f32>,
}

impl Default for PoissonOpts {
    fn default() -> Self {
        PoissonOpts { max_iter: 300, tol: 5e-4, omega: 1.8, mixed: false, fade: None }
    }
}

/// SOR Poisson solve of `src` gradients into `dest` over coverage > 0.5 (RGB, Dirichlet boundary
/// = dest), then `dest` lerps to the solution by the coverage. Returns (iterations, last largest
/// update, converged), the worst channel's.
pub fn poisson(dest: &mut Plane, src: &Plane, cov: &[f32], o: &PoissonOpts) -> (usize, f32, bool) {
    let (w, h) = (dest.w as i32, dest.h as i32);
    let omega = o.omega.clamp(0.05, 1.99);
    let interior: Vec<usize> = (0..cov.len()).filter(|&i| cov[i] > 0.5).collect();
    let (mut iters, mut resid, mut converged) = (0usize, 0f32, true);
    let mut solved = dest.clone();
    for c in 0..3 {
        let d = |i: usize| dest.data[i * 4 + c];
        let s = |i: usize| src.data[i * 4 + c];
        let eqs: Vec<(usize, Vec<usize>, f32)> = interior
            .iter()
            .map(|&p| {
                let (x, y) = (p as i32 % w, p as i32 / w);
                let nb: Vec<usize> = N4
                    .iter()
                    .map(|&(dx, dy)| (x + dx, y + dy))
                    .filter(|&(qx, qy)| qx >= 0 && qy >= 0 && qx < w && qy < h)
                    .map(|(qx, qy)| (qy * w + qx) as usize)
                    .collect();
                let rhs = nb
                    .iter()
                    .map(|&q| {
                        let (gs, gd) = (s(p) - s(q), d(p) - d(q));
                        if o.mixed && gd.abs() > gs.abs() { gd } else { gs }
                    })
                    .sum();
                (p, nb, rhs)
            })
            .filter(|e| !e.1.is_empty())
            .collect();
        let mut f: Vec<f32> = (0..cov.len()).map(d).collect();
        let (mut it, mut last, mut ok) = (0, 0f32, eqs.is_empty());
        while it < o.max_iter && !ok {
            last = 0.0;
            for (p, nb, rhs) in &eqs {
                let sum: f32 = nb.iter().map(|&q| f[q]).sum();
                let step = omega * ((sum + rhs) / nb.len() as f32 - f[*p]);
                f[*p] += step;
                last = last.max(step.abs());
            }
            it += 1;
            ok = last < o.tol;
        }
        for (i, v) in f.into_iter().enumerate() {
            solved.data[i * 4 + c] = v;
        }
        iters = iters.max(it);
        resid = resid.max(last);
        converged &= ok;
    }
    if let Some(l) = o.fade {
        let d = edge_distance(&cov.iter().map(|&m| m > 0.5).collect::<Vec<_>>(), dest.w, dest.h);
        let n = interior.len().max(1) as f32;
        let mean: [f32; 3] = std::array::from_fn(|c| interior.iter().map(|&p| solved.data[p * 4 + c] - src.data[p * 4 + c]).sum::<f32>() / n);
        for &p in &interior {
            let k = (-d[p] / l.max(1e-3)).exp();
            for (c, m) in mean.iter().enumerate() {
                let i = p * 4 + c;
                solved.data[i] = src.data[i] + m + (solved.data[i] - src.data[i] - m) * k;
            }
        }
    }
    for (i, &m) in cov.iter().enumerate() {
        let m = m.clamp(0.0, 1.0);
        for c in 0..3 {
            let k = i * 4 + c;
            dest.data[k] += (solved.data[k] - dest.data[k]) * m;
        }
    }
    (iters, resid, converged)
}

// Chamfer distance (1, sqrt 2) of each `inside` pixel to the nearest outside one; 0 outside.
fn edge_distance(inside: &[bool], w: usize, h: usize) -> Vec<f32> {
    let mut d: Vec<f32> = inside.iter().map(|&i| if i { f32::INFINITY } else { 0.0 }).collect();
    let (wi, hi) = (w as i32, h as i32);
    let mut relax = |x: i32, y: i32, nb: &[(i32, i32, f32)]| {
        let p = (y * wi + x) as usize;
        for &(dx, dy, c) in nb {
            let (qx, qy) = (x + dx, y + dy);
            // Outside the plane counts as outside the region.
            let q = if qx < 0 || qy < 0 || qx >= wi || qy >= hi { 0.0 } else { d[(qy * wi + qx) as usize] };
            d[p] = d[p].min(q + c);
        }
    };
    let s = std::f32::consts::SQRT_2;
    for y in 0..hi {
        for x in 0..wi {
            relax(x, y, &[(-1, 0, 1.0), (0, -1, 1.0), (-1, -1, s), (1, -1, s)]);
        }
    }
    for y in (0..hi).rev() {
        for x in (0..wi).rev() {
            relax(x, y, &[(1, 0, 1.0), (0, 1, 1.0), (1, 1, s), (-1, 1, s)]);
        }
    }
    d
}

/// Proximity Match: the mask (coverage 0..1) takes the mean color of the known pixels bordering
/// it, then 8 shrinking box blurs, each followed by restoring the unmasked part.
pub fn proximity_match(img: &Plane, mask: &[f32]) -> Plane {
    let (w, h) = (img.w as i32, img.h as i32);
    let inside: Vec<usize> = (0..mask.len()).filter(|&i| mask[i] > 0.5).collect();
    if inside.is_empty() {
        return img.clone();
    }
    let (mut sum, mut count) = ([0f64; 4], 0usize);
    for i in (0..mask.len()).filter(|&i| mask[i] <= 0.5) {
        let (x, y) = (i as i32 % w, i as i32 / w);
        let touches = N4.iter().any(|&(dx, dy)| {
            let (qx, qy) = (x + dx, y + dy);
            qx >= 0 && qy >= 0 && qx < w && qy < h && mask[(qy * w + qx) as usize] > 0.5
        });
        if touches {
            px(img, i).iter().enumerate().for_each(|(c, &v)| sum[c] += v as f64);
            count += 1;
        }
    }
    let mean: [f32; 4] = std::array::from_fn(|c| if count > 0 { (sum[c] / count as f64) as f32 } else { 0.0 });
    let span = |v: Vec<i32>| v.iter().max().unwrap() - v.iter().min().unwrap() + 1;
    let extent = span(inside.iter().map(|&i| i as i32 % w).collect()).max(span(inside.iter().map(|&i| i as i32 / w).collect()));
    let mut out = img.clone();
    for (i, &m) in mask.iter().enumerate() {
        for c in 0..4 {
            out.data[i * 4 + c] = out.data[i * 4 + c] * (1.0 - m) + mean[c] * m;
        }
    }
    let r0 = ((extent as f32 / 3.0).round()).max(2.0);
    for round in 0..8 {
        let radius = ((r0 * (1.0 - round as f32 / 8.0)).round() as usize).max(1);
        box_blur(&mut out, radius);
        for (i, &m) in mask.iter().enumerate() {
            if m < 1.0 {
                for c in 0..4 {
                    out.data[i * 4 + c] = out.data[i * 4 + c] * m + img.data[i * 4 + c] * (1.0 - m);
                }
            }
        }
    }
    out
}

/// Create Texture: proximity match plus the image's own high-frequency detail from a seeded
/// offset, weighted by the mask (RGB).
#[allow(dead_code)]
pub fn create_texture(img: &Plane, mask: &[f32], seed: u32) -> Plane {
    let mut out = proximity_match(img, mask);
    let (w, h) = (img.w, img.h);
    if w < 4 || h < 4 {
        return out;
    }
    let mut blur = img.clone();
    box_blur(&mut blur, 3);
    let (dx, dy) = (7 + seed as usize % 5, 11 + (seed as usize >> 3) % 5);
    for (i, &m) in mask.iter().enumerate() {
        if m <= 0.0 {
            continue;
        }
        let j = ((i / w + dy) % h) * w + (i % w + dx) % w;
        for c in 0..3 {
            let detail = img.data[j * 4 + c] - blur.data[j * 4 + c];
            out.data[i * 4 + c] = (out.data[i * 4 + c] + detail * m).clamp(0.0, 1.0);
        }
    }
    out
}

#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum HealKind {
    ContentAware,
    Proximity,
    Texture,
}

/// Spot healing of the mask (coverage) by kind.
#[allow(dead_code)]
pub fn spot_heal(img: &Plane, mask: &[f32], kind: HealKind, seed: u32) -> Plane {
    match kind {
        HealKind::ContentAware => {
            let hole: Vec<f32> = mask.iter().map(|&m| if m > 0.0 { 1.0 } else { 0.0 }).collect();
            let src: Vec<f32> = img.data.chunks_exact(4).map(|p| if p[3] > 1e-6 { 1.0 } else { 0.0 }).collect();
            hole_fill(img, &hole, &FillOpts { seed, source_mask: Some(&src), alpha: false, ..FillOpts::default() })
        }
        HealKind::Proximity => proximity_match(img, mask),
        HealKind::Texture => create_texture(img, mask, seed),
    }
}

/// Content-Aware Fill of the coverage (docs/M5.md section 10): structure 1..7 sets the patch size
/// and iterations, color 0..10 the Poisson color adaptation; the result mixes in by coverage.
pub fn content_aware_fill(img: &Plane, cov: &[f32], structure: f32, color: f32, seed: u32, source_mask: Option<&[f32]>) -> Plane {
    let n = img.w * img.h;
    let hole: Vec<f32> = cov.iter().map(|&v| if v > 0.0 { 1.0 } else { 0.0 }).collect();
    let s = structure.round().clamp(1.0, 7.0) as usize;
    let a = color.clamp(0.0, 10.0) / 10.0;
    let src: Vec<f32> = (0..n).map(|i| if on(source_mask, i) && img.data[i * 4 + 3] > 1e-6 { 1.0 } else { 0.0 }).collect();
    let opts = FillOpts {
        patch: 5 + 2 * (s - 1),
        iterations: 3 + s,
        seed,
        source_mask: Some(&src),
        alpha: false,
        boundary_context: a > 0.0,
        offset: None,
    };
    let fill = hole_fill(img, &hole, &opts);
    let adapted = (a > 0.0).then(|| {
        let mut r = img.clone();
        for i in (0..n).filter(|&i| hole[i] > 0.5) {
            set_px(&mut r, i, px(&fill, i));
        }
        poisson(&mut r, &fill, &hole, &PoissonOpts::default());
        r
    });
    let mut out = img.clone();
    for i in 0..n {
        let l = cov[i].clamp(0.0, 1.0);
        if l <= 0.0 {
            continue;
        }
        let (a0, a1) = (img.data[i * 4 + 3], fill.data[i * 4 + 3]);
        let alpha = a0 * (1.0 - l) + a1 * l;
        for c in 0..3 {
            let k = i * 4 + c;
            let f = adapted.as_ref().map_or(fill.data[k], |r| fill.data[k] * (1.0 - a) + r.data[k] * a);
            out.data[k] = if alpha <= 1e-8 { 0.0 } else { (img.data[k] * a0 * (1.0 - l) + f * a1 * l) / alpha };
        }
        out.data[i * 4 + 3] = alpha;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane(w: usize, h: usize, f: impl Fn(usize, usize) -> [f32; 4]) -> Plane {
        Plane { x: 0, y: 0, w, h, data: (0..w * h).flat_map(|i| f(i % w, i / w)).collect() }
    }

    fn square(w: usize, h: usize, x0: usize, y0: usize, s: usize) -> Vec<f32> {
        (0..w * h).map(|i| if (x0..x0 + s).contains(&(i % w)) && (y0..y0 + s).contains(&(i / w)) { 1.0 } else { 0.0 }).collect()
    }

    fn u8v(v: f32) -> u8 {
        (v.clamp(0.0, 1.0) * 255.0).round() as u8
    }

    fn stripe(x: usize) -> f32 {
        if (x / 4) % 2 == 0 { 40.0 / 255.0 } else { 200.0 / 255.0 }
    }

    // `img` with the mask pixels overwritten by `px`.
    fn punch(mut img: Plane, mask: &[f32], px: [f32; 4]) -> Plane {
        for (i, m) in mask.iter().enumerate() {
            if *m > 0.5 {
                img.data[i * 4..i * 4 + 4].copy_from_slice(&px);
            }
        }
        img
    }

    // Patch errors at identity offsets, 16x16, patch 3; expected values measured on the reference kernel.
    #[test]
    fn patch_error_sums_clamped_weighted_terms_with_a_flat_masked_cost() {
        let err = |src: Plane, smask: Option<&[f32]>, unknown: Option<&[f32]>, uw: f32, x: usize, y: usize| {
            let ident = Nnf { w: 16, h: 16, ox: (0..256).map(|i| i % 16).collect(), oy: (0..256).map(|i| i / 16).collect(), err: vec![0.0; 256] };
            let zero = plane(16, 16, |_, _| [0.0; 4]);
            let o = SearchOpts { patch: 3, iterations: 0, source_mask: smask, unknown, unknown_weight: uw, initial: Some(&ident), ..SearchOpts::default() };
            patch_search(&zero, &src, &o).err[y * 16 + x]
        };
        let half = || plane(16, 16, |_, _| [0.5, 0.0, 0.0, 0.0]);
        assert_eq!(err(half(), None, None, 1.0, 8, 8), 2.25);
        assert_eq!(err(half(), None, None, 1.0, 0, 0), 2.25);
        assert_eq!(err(plane(16, 16, |_, _| [0.5; 4]), None, None, 1.0, 8, 8), 9.0);
        let ramp = plane(16, 16, |x, _| [x as f32 / 16.0, 0.0, 0.0, 0.0]);
        assert_eq!(err(ramp, None, None, 1.0, 0, 8), 0.01171875);
        let spot = plane(16, 16, |x, y| [if (x, y) == (8, 8) { 0.5 } else { 0.0 }, 0.0, 0.0, 0.0]);
        let center: Vec<f32> = (0..256).map(|i| if i == 8 * 16 + 8 { 1.0 } else { 0.0 }).collect();
        assert_eq!(err(spot, None, Some(&center), 0.5, 8, 8), 0.125);
        let edge: Vec<f32> = (0..256).map(|i| if i == 8 * 16 { 1.0 } else { 0.0 }).collect();
        assert_eq!(err(half(), None, Some(&edge), 0.0, 0, 8), 1.75);
        let mut m = vec![1.0; 256];
        m[8 * 16 + 9] = 0.0;
        assert_eq!(err(half(), Some(&m), None, 1.0, 8, 8), 6.0);
        let mut m = vec![1.0; 256];
        m[7 * 16] = 0.0;
        assert_eq!(err(half(), Some(&m), None, 1.0, 0, 8), 9.75);
    }

    #[test]
    fn a_flat_hole_fills_with_exactly_the_flat_value() {
        let hole = square(64, 64, 24, 24, 16);
        let v = 90.0 / 255.0;
        let img = punch(plane(64, 64, |_, _| [v, v, v, 1.0]), &hole, [0.0; 4]);
        let out = hole_fill(&img, &hole, &FillOpts::default());
        for i in 0..64 * 64 {
            assert_eq!(out.data[i * 4..i * 4 + 4].iter().map(|&c| u8v(c)).collect::<Vec<_>>(), [90, 90, 90, 255], "pixel {i}");
        }
    }

    #[test]
    fn vertical_stripes_continue_through_the_hole() {
        let hole = square(64, 64, 24, 24, 16);
        let img = punch(plane(64, 64, |x, _| [stripe(x), stripe(x), stripe(x), 1.0]), &hole, [0.0, 0.0, 0.0, 1.0]);
        let out = hole_fill(&img, &hole, &FillOpts::default());
        let worst = (0..64 * 64)
            .filter(|&i| hole[i] > 0.5)
            .flat_map(|i| (0..3).map(move |c| (i, c)))
            .map(|(i, c)| (out.data[i * 4 + c] - stripe(i % 64)).abs())
            .fold(0.0f32, f32::max);
        assert!(worst <= 8.0 / 255.0, "max diff {}", worst * 255.0);
    }

    #[test]
    fn the_same_seed_gives_the_same_fill() {
        let hole = square(48, 40, 14, 12, 14);
        let img = plane(48, 40, |x, y| {
            let v = crate::filters::hash(3, x as i32, y as i32, 0);
            [v, stripe(x), (y as f32 / 40.0), 1.0]
        });
        let o = FillOpts { seed: 9, ..FillOpts::default() };
        assert_eq!(hole_fill(&img, &hole, &o), hole_fill(&img, &hole, &o));
    }

    #[test]
    fn poisson_with_a_flat_source_keeps_a_flat_region_flat() {
        let cov = square(32, 32, 11, 11, 10);
        let mut dest = plane(32, 32, |_, _| [150.0 / 255.0, 150.0 / 255.0, 150.0 / 255.0, 1.0]);
        let src = plane(32, 32, |_, _| [100.0 / 255.0, 100.0 / 255.0, 100.0 / 255.0, 1.0]);
        let (_, _, converged) = poisson(&mut dest, &src, &cov, &PoissonOpts::default());
        assert!(converged);
        for (i, px) in dest.data.chunks_exact(4).enumerate() {
            for c in 0..3 {
                assert!((px[c] * 255.0 - 150.0).abs() <= 1.0, "pixel {i}: {}", px[c] * 255.0);
            }
        }
    }

    #[test]
    fn proximity_match_keeps_a_flat_layer_flat() {
        let hole = square(40, 40, 10, 12, 15);
        let v = 90.0 / 255.0;
        let img = punch(plane(40, 40, |_, _| [v, v, v, 1.0]), &hole, [0.0, 0.0, 0.0, 1.0]);
        let out = proximity_match(&img, &hole);
        for px in out.data.chunks_exact(4) {
            assert!(px[..3].iter().all(|&c| (c - v).abs() < 1e-4), "{px:?}");
        }
    }

    #[test]
    fn content_aware_fill_at_structure_1_and_7_leaves_no_hole_pixel_untouched() {
        let hole = square(64, 56, 20, 18, 18);
        let base = plane(64, 56, |x, y| [stripe(x), y as f32 / 56.0, 0.3, 1.0]);
        let img = punch(base, &hole, [1.0, 0.0, 1.0, 1.0]);
        for structure in [1.0, 7.0] {
            let out = content_aware_fill(&img, &hole, structure, 5.0, 1346916180, None);
            let marked = (0..64 * 56)
                .filter(|&i| hole[i] > 0.5 && [0, 1, 2].map(|c| u8v(out.data[i * 4 + c])) == [255, 0, 255])
                .count();
            assert_eq!(marked, 0, "structure {structure}");
        }
    }

    #[test]
    #[ignore = "timing probe: cargo test --release -- --ignored --nocapture"]
    fn probe_content_aware_fill_400_with_a_200_hole() {
        let hole = square(400, 400, 100, 100, 200);
        let img = plane(400, 400, |x, y| [stripe(x), y as f32 / 400.0, crate::filters::hash(5, x as i32, y as i32, 0), 1.0]);
        let t = std::time::Instant::now();
        let out = content_aware_fill(&img, &hole, 4.0, 5.0, 1346916180, None);
        eprintln!("content_aware_fill 400x400, 200x200 hole: {} ms", t.elapsed().as_millis());
    }
}
