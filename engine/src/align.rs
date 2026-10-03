//! Edit > Auto-Align Layers and Auto-Blend Layers, File > Automate > Photomerge and Merge to HDR Pro.
//! Alignment matches Harris corners by normalized 9x9 patches and fits a homography by RANSAC
//! (or the median shift); blending gives every layer a seam mask or a sharpest-pixel mask.

use super::transform::check_area;
use super::*;
use crate::pwarp::homography;
use crate::resample::Interp;
use crate::seam::min_seam;

// A w x h single-channel plane.
struct Gray {
    w: usize,
    h: usize,
    v: Vec<f32>,
}

// One mean pass of window 2r + 1 along x or y; edges replicate.
fn box_pass(v: &[f32], w: usize, h: usize, r: usize, along_x: bool) -> Vec<f32> {
    let mut out = vec![0f32; v.len()];
    let (len, lines) = if along_x { (w, h) } else { (h, w) };
    let at = |line: usize, i: usize| if along_x { line * w + i } else { i * w + line };
    let n = (2 * r + 1) as f64;
    for line in 0..lines {
        let get = |i: isize| v[at(line, i.clamp(0, len as isize - 1) as usize)] as f64;
        let mut s: f64 = (-(r as isize)..=r as isize).map(get).sum();
        for i in 0..len {
            out[at(line, i)] = (s / n) as f32;
            s += get(i as isize + r as isize + 1) - get(i as isize - r as isize);
        }
    }
    out
}

fn box_blur(v: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    box_pass(&box_pass(v, w, h, r, true), w, h, r, false)
}

// Separable convolution with a normalized odd kernel; edges replicate.
fn convolve(v: &[f32], w: usize, h: usize, k: &[f32]) -> Vec<f32> {
    let r = (k.len() / 2) as isize;
    let pass = |v: &[f32], along_x: bool| {
        let mut out = vec![0f32; v.len()];
        for y in 0..h {
            for x in 0..w {
                out[y * w + x] = k
                    .iter()
                    .enumerate()
                    .map(|(j, kv)| {
                        let d = j as isize - r;
                        let (sx, sy) = if along_x { ((x as isize + d).clamp(0, w as isize - 1) as usize, y) } else { (x, (y as isize + d).clamp(0, h as isize - 1) as usize) };
                        kv * v[sy * w + sx]
                    })
                    .sum();
            }
        }
        out
    };
    pass(&pass(v, true), false)
}

fn luminance(rgba: &[f32]) -> Vec<f32> {
    rgba.chunks_exact(4).map(|c| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).collect()
}

// Harris corners (k 0.04, window 2, 4 px non-maximum suppression), strongest first.
fn harris(g: &Gray, max: usize) -> Vec<(usize, usize)> {
    let (w, h) = (g.w, g.h);
    if w < 3 || h < 3 {
        return Vec::new();
    }
    let (mut xx, mut yy, mut xy) = (vec![0f32; w * h], vec![0f32; w * h], vec![0f32; w * h]);
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let k = y * w + x;
            let (dx, dy) = (g.v[k + 1] - g.v[k - 1], g.v[k + w] - g.v[k - w]);
            (xx[k], yy[k], xy[k]) = (dx * dx, dy * dy, dx * dy);
        }
    }
    let (xx, yy, xy) = (box_blur(&xx, w, h, 2), box_blur(&yy, w, h, 2), box_blur(&xy, w, h, 2));
    let r: Vec<f32> = (0..w * h)
        .map(|i| {
            let t = xx[i] + yy[i];
            xx[i] * yy[i] - xy[i] * xy[i] - 0.04 * t * t
        })
        .collect();
    const S: usize = 4;
    const B: usize = 5;
    let mut out = Vec::new();
    for y in B..h.saturating_sub(B) {
        for x in B..w.saturating_sub(B) {
            let v = r[y * w + x];
            if v <= 0.0 {
                continue;
            }
            let peak = (y - S..=y + S).all(|ny| (x - S..=x + S).all(|nx| (nx == x && ny == y) || r[ny * w + nx] <= v));
            if peak {
                out.push((x, y, v));
            }
        }
    }
    out.sort_by(|a, b| b.2.total_cmp(&a.2));
    out.into_iter().take(max).map(|(x, y, _)| (x, y)).collect()
}

// The mean-free, unit-length 9x9 patch around (x, y); None near the edge or on a flat patch.
fn patch(g: &Gray, x: usize, y: usize) -> Option<[f32; 81]> {
    if x < 4 || y < 4 || x + 4 >= g.w || y + 4 >= g.h {
        return None;
    }
    let mut p = [0f32; 81];
    for (i, v) in p.iter_mut().enumerate() {
        *v = g.v[(y + i / 9 - 4) * g.w + x + i % 9 - 4];
    }
    let mean = p.iter().sum::<f32>() / 81.0;
    let mut ss = 0.0;
    for v in p.iter_mut() {
        *v -= mean;
        ss += *v * *v;
    }
    if ss < 1e-8 {
        return None;
    }
    let k = 1.0 / ss.sqrt();
    p.iter_mut().for_each(|v| *v *= k);
    Some(p)
}

type Pair = ((f64, f64), (f64, f64));

// Mutual best matches by patch correlation (at least 0.8, second best below 0.9 of the best).
fn match_features(a: &Gray, fa: &[(usize, usize)], b: &Gray, fb: &[(usize, usize)]) -> Vec<Pair> {
    let da: Vec<_> = fa.iter().map(|&(x, y)| patch(a, x, y)).collect();
    let db: Vec<_> = fb.iter().map(|&(x, y)| patch(b, x, y)).collect();
    let (mut best_a, mut s1, mut s2) = (vec![usize::MAX; fa.len()], vec![0f32; fa.len()], vec![0f32; fa.len()]);
    let (mut best_b, mut sb) = (vec![usize::MAX; fb.len()], vec![0f32; fb.len()]);
    for (k, v) in da.iter().enumerate() {
        let Some(v) = v else { continue };
        for (j, c) in db.iter().enumerate() {
            let Some(c) = c else { continue };
            let w: f32 = v.iter().zip(c.iter()).map(|(p, q)| p * q).sum();
            if w > s1[k] {
                (s2[k], s1[k], best_a[k]) = (s1[k], w, j);
            } else if w > s2[k] {
                s2[k] = w;
            }
            if w > sb[j] {
                (sb[j], best_b[j]) = (w, k);
            }
        }
    }
    (0..fa.len())
        .filter(|&k| best_a[k] != usize::MAX && best_b[best_a[k]] == k && s1[k] >= 0.8 && !(s2[k] > 0.0 && s2[k] / s1[k] > 0.9))
        .map(|k| {
            let (f, t) = (fa[k], fb[best_a[k]]);
            ((f.0 as f64, f.1 as f64), (t.0 as f64, t.1 as f64))
        })
        .collect()
}

fn map(m: &[f64; 9], (x, y): (f64, f64)) -> (f64, f64) {
    let d = m[6] * x + m[7] * y + m[8];
    ((m[0] * x + m[1] * y + m[2]) / d, (m[3] * x + m[4] * y + m[5]) / d)
}

fn inliers(m: &[f64; 9], pairs: &[Pair]) -> usize {
    pairs.iter().filter(|(f, t)| {
        let p = map(m, *f);
        (p.0 - t.0).hypot(p.1 - t.1) <= 3.0
    }).count()
}

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    let n = v.len() / 2;
    if v.len() % 2 == 0 { (v[n - 1] + v[n]) / 2.0 } else { v[n] }
}

// The median shift, or the RANSAC homography (500 seeded draws of 4) when it has over 10% more inliers.
fn fit(pairs: &[Pair], reposition: bool) -> Option<[f64; 9]> {
    if pairs.is_empty() {
        return None;
    }
    let dx = median(pairs.iter().map(|(f, t)| t.0 - f.0).collect());
    let dy = median(pairs.iter().map(|(f, t)| t.1 - f.1).collect());
    let shift = [1.0, 0.0, dx, 0.0, 1.0, dy, 0.0, 0.0, 1.0];
    if reposition || pairs.len() < 4 {
        return Some(shift);
    }
    let mut seed = 12345u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed % 1_000_000) as f64 / 1e6
    };
    let mut best: Option<([f64; 9], usize)> = None;
    for _ in 0..500 {
        let mut pick: Vec<usize> = Vec::with_capacity(4);
        while pick.len() < 4 {
            let i = (next() * pairs.len() as f64) as usize % pairs.len();
            if !pick.contains(&i) {
                pick.push(i);
            }
        }
        let corner = |f: fn(&Pair) -> (f64, f64)| std::array::from_fn(|k| <[f64; 2]>::from(f(&pairs[pick[k]])));
        let Some(h) = homography(corner(|p| p.0), corner(|p| p.1)) else { continue };
        let n = inliers(&h, pairs);
        if best.is_none_or(|(_, b)| n > b) {
            best = Some((h, n));
        }
    }
    match best {
        Some((h, n)) if n as f64 > inliers(&shift, pairs) as f64 * 1.1 => Some(h),
        _ => Some(shift),
    }
}

fn invertible(m: &[f64; 9]) -> bool {
    let det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    m.iter().all(|v| v.is_finite()) && det.abs() > 1e-12
}

fn transpose(v: &[f32], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![0f32; v.len()];
    for y in 0..h {
        for x in 0..w {
            out[x * h + y] = v[y * w + x];
        }
    }
    out
}

// 1 on the `side` (true: right of / below) of the cheapest seam through `cost`, 0 elsewhere.
fn seam_mask(cost: &[f32], w: usize, h: usize, vertical: bool, side: bool) -> Vec<f32> {
    let (tw, th, c) = if vertical { (w, h, cost.to_vec()) } else { (h, w, transpose(cost, w, h)) };
    let cols = min_seam(c, tw, th);
    let m: Vec<f32> = (0..tw * th).map(|i| if (i % tw > cols[i / tw]) == side { 1.0 } else { 0.0 }).collect();
    if vertical { m } else { transpose(&m, tw, th) }
}

// One layer over the blend region: straight RGBA and alpha.
struct Src {
    id: u32,
    rgba: Vec<f32>,
    alpha: Vec<f32>,
}

// Each layer is drawn over the ones below; where it overlaps them, a seam through the least
// color difference splits the overlap, the side away from its new area going to the layers below.
fn panorama_masks(s: &[Src], w: usize, h: usize) -> Vec<Vec<f32>> {
    let n = w * h;
    let mut o = vec![vec![0f32; n]; s.len()];
    let mut cov = vec![false; n];
    let mut comp = vec![0f32; n * 4];
    for (si, l) in s.iter().enumerate() {
        if si > 0 {
            let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0, 0);
            let (mut sx, mut sy, mut cnt) = (0f64, 0f64, 0usize);
            for y in 0..h {
                for x in 0..w {
                    let u = y * w + x;
                    if l.alpha[u] <= 0.0 {
                        continue;
                    }
                    if cov[u] {
                        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
                    } else {
                        (sx, sy, cnt) = (sx + x as f64, sy + y as f64, cnt + 1);
                    }
                }
            }
            if x0 != usize::MAX {
                let (cw, ch) = (x1 - x0 + 1, y1 - y0 + 1);
                let at = |i: usize| (y0 + i / cw) * w + x0 + i % cw;
                let cost: Vec<f32> = (0..cw * ch)
                    .map(|i| {
                        let k = at(i);
                        if cov[k] && l.alpha[k] > 0.0 { (0..3).map(|c| (comp[k * 4 + c] - l.rgba[k * 4 + c]).abs()).sum() } else { 1000.0 }
                    })
                    .collect();
                let vertical = ch >= cw;
                let side = cnt > 0
                    && if vertical { sx / cnt as f64 > x0 as f64 + cw as f64 / 2.0 } else { sy / cnt as f64 > y0 as f64 + ch as f64 / 2.0 };
                let a = seam_mask(&cost, cw, ch, vertical, side);
                for (i, v) in a.into_iter().enumerate() {
                    let k = at(i);
                    if l.alpha[k] > 0.0 && cov[k] {
                        o[si][k] = v;
                        for below in o.iter_mut().take(si) {
                            below[k] *= 1.0 - v;
                        }
                    }
                }
            }
        }
        for u in 0..n {
            if l.alpha[u] <= 0.0 {
                continue;
            }
            if !cov[u] {
                o[si][u] = 1.0;
            }
            cov[u] = true;
            let hv = o[si][u];
            for c in 0..4 {
                comp[u * 4 + c] = comp[u * 4 + c] * (1.0 - hv) + l.rgba[u * 4 + c] * hv;
            }
        }
    }
    o
}

// Every pixel goes to the layer with the most local contrast there (luminance std over 7x7).
fn stack_masks(s: &[Src], w: usize, h: usize) -> Vec<Vec<f32>> {
    let contrast: Vec<Vec<f32>> = s
        .iter()
        .map(|l| {
            let lum = luminance(&l.rgba);
            let sq: Vec<f32> = lum.iter().map(|v| v * v).collect();
            let (mean, sq) = (box_blur(&lum, w, h, 3), box_blur(&sq, w, h, 3));
            mean.iter().zip(sq).map(|(m, q)| (q - m * m).max(0.0).sqrt()).collect()
        })
        .collect();
    let mut o = vec![vec![0f32; w * h]; s.len()];
    for u in 0..w * h {
        let best = (0..s.len()).filter(|&i| s[i].alpha[u] > 0.0).fold(None, |b: Option<usize>, i| match b {
            Some(j) if contrast[j][u] >= contrast[i][u] => Some(j),
            _ => Some(i),
        });
        if let Some(i) = best {
            o[i][u] = 1.0;
        }
    }
    o
}

// Gain and offset per color channel (gain 0.5..2) so `l` matches the mean and spread of `base`
// where `weight` is set.
fn tone_match(l: &mut [f32], base: &[f32], weight: &[f32]) {
    for c in 0..3 {
        let (mut u, mut s, mut t, mut ss, mut tt) = (0f64, 0f64, 0f64, 0f64, 0f64);
        for (i, &wt) in weight.iter().enumerate() {
            if wt <= 0.0 {
                continue;
            }
            let (a, b) = (l[i * 4 + c] as f64, base[i * 4 + c] as f64);
            (u, s, t, ss, tt) = (u + wt as f64, s + wt as f64 * a, t + wt as f64 * b, ss + wt as f64 * a * a, tt + wt as f64 * b * b);
        }
        if u <= 0.0 {
            continue;
        }
        let (ma, mb) = (s / u, t / u);
        let (va, vb) = ((ss / u - ma * ma).max(0.0), (tt / u - mb * mb).max(0.0));
        let k = if va > 1e-8 { (vb / va).sqrt() } else { 1.0 }.clamp(0.5, 2.0);
        let off = mb - k * ma;
        for px in l.chunks_exact_mut(4) {
            px[c] = (px[c] as f64 * k + off) as f32;
        }
    }
}

/// Merge to HDR Pro, one tile at a time: every exposure adds its tile, then `write` stores the
/// weighted mean (hat weights, each exposure scaled by 2^-stops) in the new 32-bit layer "HDR".
pub struct HdrAcc {
    pub doc: Document,
    sum: Vec<f64>,
    wsum: Vec<f64>,
}

impl HdrAcc {
    pub fn new(width: u32, height: u32) -> Result<HdrAcc, String> {
        let mut doc = Document::new(width, height, 32)?;
        doc.nodes[0].name = "HDR".into();
        Ok(HdrAcc { doc, sum: vec![0.0; TILE_PIXELS * 3], wsum: vec![0.0; TILE_PIXELS * 3] })
    }

    pub fn add(&mut self, src: &Document, tx: u32, ty: u32, stops: f64) -> Result<(), String> {
        if (src.width, src.height) != (self.doc.width, self.doc.height) {
            return Err("Merge to HDR Pro needs every exposure at the same pixel size.".into());
        }
        let px = src.composite_tile_premul(tx, ty);
        let f = 2f64.powf(-stops);
        for p in 0..TILE_PIXELS {
            let a = px[p * 4 + 3];
            for c in 0..3 {
                let v = if a > 0.0 { (px[p * 4 + c] / a) as f64 } else { 0.0 };
                let wt = 1.0 - (2.0 * v.clamp(0.0, 1.0) - 1.0).abs();
                self.sum[p * 3 + c] += wt * v * f;
                self.wsum[p * 3 + c] += wt;
            }
        }
        Ok(())
    }

    pub fn write(&mut self, tx: u32, ty: u32) {
        let (w, h) = (self.doc.width as usize, self.doc.height as usize);
        let mut buf = vec![0f32; TILE_PIXELS * 4];
        for p in 0..TILE_PIXELS {
            if tx as usize * TILE + p % TILE >= w || ty as usize * TILE + p / TILE >= h {
                continue;
            }
            for c in 0..3 {
                let ws = self.wsum[p * 3 + c];
                buf[p * 4 + c] = if ws > 0.0 { (self.sum[p * 3 + c] / ws) as f32 } else { 0.0 };
            }
            buf[p * 4 + 3] = 1.0;
        }
        self.sum.fill(0.0);
        self.wsum.fill(0.0);
        let tile = Tile { id: self.doc.alloc_tile_id(), px: Arc::new(Pixels::from_straight(32, &buf)) };
        if let Kind::Pixel(t) = &mut self.doc.nodes[0].kind {
            t.put(tx as i32, ty as i32, Some(tile));
        }
    }
}

impl Document {
    // The pixel layers among `ids` (all of them for None), bottom first.
    fn pixel_stack(&self, ids: Option<&[u32]>) -> Vec<u32> {
        fn walk(nodes: &[Node], want: Option<&HashSet<u32>>, out: &mut Vec<u32>) {
            for n in nodes {
                match &n.kind {
                    Kind::Group(c) => walk(c, want, out),
                    Kind::Pixel(_) if want.is_none_or(|w| w.contains(&n.id)) => out.push(n.id),
                    _ => {}
                }
            }
        }
        let want: Option<HashSet<u32>> = ids.map(|i| i.iter().copied().collect());
        let mut out = Vec::new();
        walk(&self.nodes, want.as_ref(), &mut out);
        out
    }

    // Straight RGBA of layer `id` over document rect `r`.
    fn straight_plane(&self, id: u32, r: [i32; 4]) -> Result<Vec<f32>, String> {
        let mut d = self.rgba_plane(self.node(id)?.pixel_tiles()?, r, None).data;
        for px in d.chunks_exact_mut(4) {
            if px[3] > 0.0 {
                for c in 0..3 {
                    px[c] /= px[3];
                }
            }
        }
        Ok(d)
    }

    // The homography taking each layer above the bottom one onto it; layers without a fit are left out.
    fn align_fits(&self, layers: &[u32], reposition: bool, max_features: usize) -> Result<Vec<(u32, [f64; 9])>, String> {
        for &id in layers {
            self.check_pixel_edit(id)?;
            if self.node(id)?.locks.position {
                return Err("layer position is locked".into());
            }
        }
        let gray = |id: u32| -> Result<Option<(Gray, (f64, f64))>, String> {
            let Some(b) = self.layer_bounds(id)? else { return Ok(None) };
            check_area(b)?;
            let v = luminance(&self.straight_plane(id, b)?);
            Ok(Some((Gray { w: b[2] as usize, h: b[3] as usize, v }, (b[0] as f64, b[1] as f64))))
        };
        let Some((rg, ro)) = gray(layers[0])? else { return Ok(Vec::new()) };
        let rf = harris(&rg, max_features);
        let mut fits = Vec::new();
        for &id in &layers[1..] {
            let Some((g, o)) = gray(id)? else { continue };
            let pairs: Vec<Pair> = match_features(&g, &harris(&g, max_features), &rg, &rf)
                .into_iter()
                .map(|(f, t)| ((f.0 + o.0, f.1 + o.1), (t.0 + ro.0, t.1 + ro.1)))
                .collect();
            if let Some(m) = fit(&pairs, reposition).filter(invertible) {
                fits.push((id, m));
            }
        }
        Ok(fits)
    }

    /// Edit > Auto-Align Layers: moves every selected pixel layer onto the bottom one, by shift only
    /// with `reposition`. Returns how many layers moved.
    pub fn auto_align(&mut self, ids: &[u32], reposition: bool) -> Result<u32, String> {
        self.check_idle()?;
        let layers = self.pixel_stack(Some(ids));
        if layers.len() < 2 {
            return Err("Select at least two pixel layers to align.".into());
        }
        let fits = self.align_fits(&layers, reposition, 400)?;
        if fits.is_empty() {
            return Err("No layer could be aligned.".into());
        }
        for (id, m) in &fits {
            self.transform_layer_with(*id, m, Interp::Bicubic, false)?;
        }
        Ok(fits.len() as u32)
    }

    /// Edit > Auto-Blend Layers: gives every selected pixel layer a (feathered) mask, by seams for a
    /// panorama or by local contrast for a stack; `seamless` first matches each layer's tones to
    /// the bottom one where they overlap.
    pub fn auto_blend(&mut self, ids: &[u32], stack: bool, seamless: bool) -> Result<(), String> {
        self.check_idle()?;
        let layers = self.pixel_stack(Some(ids));
        let fail = || "Auto-Blend needs at least two overlapping pixel layers.".to_string();
        if layers.len() < 2 {
            return Err(fail());
        }
        let mut region: Option<[i32; 4]> = None;
        for &id in &layers {
            self.check_pixel_edit(id)?;
            if let Some(b) = self.layer_bounds(id)? {
                region = Some(region.map_or(b, |r| {
                    let (x0, y0) = (r[0].min(b[0]), r[1].min(b[1]));
                    [x0, y0, (r[0] + r[2]).max(b[0] + b[2]) - x0, (r[1] + r[3]).max(b[1] + b[3]) - y0]
                }));
            }
        }
        let r = region.ok_or_else(fail)?;
        check_area(r)?;
        let (w, h) = (r[2] as usize, r[3] as usize);
        let mut srcs = Vec::with_capacity(layers.len());
        for &id in &layers {
            let rgba = self.straight_plane(id, r)?;
            let alpha = rgba.chunks_exact(4).map(|c| c[3]).collect();
            srcs.push(Src { id, rgba, alpha });
        }
        let masks = if stack { stack_masks(&srcs, w, h) } else { panorama_masks(&srcs, w, h) };
        let (base, rest) = srcs.split_first_mut().expect("two layers");
        if seamless {
            for l in rest.iter_mut() {
                let overlap: Vec<f32> = base.alpha.iter().zip(&l.alpha).map(|(a, b)| if *a > 0.0 && *b > 0.0 { 1.0 } else { 0.0 }).collect();
                tone_match(&mut l.rgba, &base.rgba, &overlap);
            }
        }
        let kernel = gaussian_kernel(3.0);
        let fill = |data: &[f32], ch: usize, ox: i32, oy: i32, buf: &mut [f32]| {
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32 - r[0], oy + (p / TILE) as i32 - r[1]);
                if x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h {
                    let at = (y as usize * w + x as usize) * ch;
                    buf[p * ch..(p + 1) * ch].copy_from_slice(&data[at..at + ch]);
                }
            }
            true
        };
        for (i, l) in srcs.iter().enumerate() {
            if seamless && i > 0 {
                let t = self.render_tiles_with(r, None, true, |ox, oy, buf| fill(&l.rgba, 4, ox, oy, buf))?;
                *self.node_mut(l.id)?.pixel_tiles_mut()? = t;
            }
            let m = convolve(&masks[i], w, h, &kernel);
            let tiles = self.render_tiles_with(r, Some(0), true, |ox, oy, buf| fill(&m, 1, ox, oy, buf))?;
            self.node_mut(l.id)?.mask = Some(Mask { enabled: true, default: 0, tiles });
        }
        Ok(())
    }

    /// File > Automate > Photomerge: Auto-Align (perspective) of all pixel layers, then, with
    /// `blend`, a seamless panorama Auto-Blend. Returns how many layers moved; without `blend`
    /// a merge that aligns nothing fails.
    pub fn photomerge(&mut self, blend: bool) -> Result<u32, String> {
        self.check_idle()?;
        let layers = self.pixel_stack(None);
        if layers.len() < 2 {
            return Err("Photomerge needs at least two pixel layers.".into());
        }
        let fits = self.align_fits(&layers, false, 800)?;
        if fits.is_empty() && !blend {
            return Err("No layer could be aligned.".into());
        }
        for (id, m) in &fits {
            self.transform_layer_with(*id, m, Interp::Bicubic, false)?;
        }
        if blend {
            self.auto_blend(&layers, false, true)?;
        }
        Ok(fits.len() as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A deterministic texture of overlapping gray rectangles, sampled at document pixel (x, y).
    fn texture(x: i32, y: i32) -> u8 {
        let mut v = 40u32;
        let mut s = 7u32;
        for _ in 0..60 {
            s = s.wrapping_mul(1_103_515_245).wrapping_add(12345);
            let (rx, ry) = ((s >> 8) % 300, (s >> 16) % 300);
            let (rw, rh, g) = (10 + (s >> 4) % 40, 10 + (s >> 12) % 40, (s >> 20) % 200);
            if (x as u32).wrapping_sub(rx) < rw && (y as u32).wrapping_sub(ry) < rh {
                v = (v + g) % 256;
            }
        }
        v as u8
    }

    // Fills layer `id` over [x0, x1) x [y0, y1) with `f(x, y)` as opaque RGB.
    fn paint(d: &mut Document, id: u32, rect: [i32; 4], f: impl Fn(i32, i32) -> [u8; 3]) {
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                let mut buf = vec![0u8; TILE_BYTES_U8];
                for p in 0..TILE_PIXELS {
                    let (x, y) = ((tx as usize * TILE + p % TILE) as i32, (ty as usize * TILE + p / TILE) as i32);
                    if x >= rect[0] && x < rect[2] && y >= rect[1] && y < rect[3] {
                        let c = f(x, y);
                        buf[p * 4..p * 4 + 4].copy_from_slice(&[c[0], c[1], c[2], 255]);
                    }
                }
                d.set_tile_rgba8(id, tx, ty, &buf).unwrap();
            }
        }
    }

    fn px(d: &Document, id: u32, x: i32, y: i32) -> [f32; 4] {
        let t = d.node(id).unwrap().pixel_tiles().unwrap().get(x / TILE as i32, y / TILE as i32);
        t.map_or([0.0; 4], |t| t.px.rgba_f32(((y % TILE as i32) * TILE as i32 + x % TILE as i32) as usize))
    }

    fn mask(d: &Document, id: u32, x: i32, y: i32) -> f32 {
        let m = d.node(id).unwrap().mask.as_ref().expect("mask");
        m.tiles.get(x / TILE as i32, y / TILE as i32).map_or(m.default as f32, |t| t.px.mask_f32(((y % TILE as i32) * TILE as i32 + x % TILE as i32) as usize))
    }

    #[test]
    fn auto_align_moves_a_shifted_copy_back_onto_the_bottom_layer() {
        for reposition in [false, true] {
            let mut d = Document::new(256, 256, 8).unwrap();
            paint(&mut d, 1, [0, 0, 256, 256], |x, y| [texture(x, y); 3]);
            let top = d.add_layer("shifted", 1).unwrap();
            // The top layer shows the texture moved by (+7, -5).
            paint(&mut d, top, [20, 20, 230, 230], |x, y| [texture(x - 7, y + 5); 3]);
            assert_eq!(d.auto_align(&[top, 1], reposition).unwrap(), 1);
            let mut off = 0;
            for (x, y) in [(60, 60), (100, 140), (150, 90), (190, 180)] {
                let (a, b) = (px(&d, 1, x, y)[0], px(&d, top, x, y)[0]);
                if (a - b).abs() > 2.0 / 255.0 {
                    off += 1;
                }
            }
            assert_eq!(off, 0, "reposition {reposition}: the aligned layer matches the bottom one");
            assert_eq!(d.layer_bounds(top).unwrap().map(|b| [b[0], b[1]]), Some([13, 25]));
        }
    }

    #[test]
    fn auto_align_refuses_featureless_layers_and_single_layers() {
        let mut d = Document::new(64, 64, 8).unwrap();
        paint(&mut d, 1, [0, 0, 64, 64], |_, _| [128; 3]);
        let top = d.add_layer("flat", 1).unwrap();
        paint(&mut d, top, [0, 0, 64, 64], |_, _| [90; 3]);
        assert_eq!(d.auto_align(&[1, top], false).unwrap_err(), "No layer could be aligned.");
        assert_eq!(d.auto_align(&[1], false).unwrap_err(), "Select at least two pixel layers to align.");
    }

    #[test]
    fn auto_blend_panorama_splits_the_overlap_by_a_seam() {
        let mut d = Document::new(128, 64, 8).unwrap();
        paint(&mut d, 1, [0, 0, 80, 64], |_, _| [255, 0, 0]);
        let top = d.add_layer("right", 1).unwrap();
        paint(&mut d, top, [48, 0, 128, 64], |_, _| [0, 0, 255]);
        d.auto_blend(&[1, top], false, false).unwrap();
        assert!(mask(&d, 1, 10, 30) > 0.99 && mask(&d, top, 120, 30) > 0.99);
        assert!(mask(&d, 1, 120, 30) < 0.01, "the bottom mask hides its empty side");
        // In the overlap the masks split the pixels between the layers.
        let (a, b) = (mask(&d, 1, 50, 30), mask(&d, top, 50, 30));
        assert!(a > 0.9 && b < 0.1 || a < 0.1 && b > 0.9, "{a} {b}");
        let (a, b) = (mask(&d, 1, 77, 30), mask(&d, top, 77, 30));
        assert!(a < 0.1 && b > 0.9, "{a} {b}: the right edge of the overlap goes to the right layer");
        assert!(d.auto_blend(&[1], false, false).is_err());
    }

    #[test]
    fn auto_blend_stack_keeps_the_sharpest_layer_per_pixel_and_seamless_matches_tones() {
        let mut d = Document::new(64, 32, 8).unwrap();
        let checker = |x: i32, y: i32| if (x / 2 + y / 2) % 2 == 0 { [250; 3] } else { [10; 3] };
        paint(&mut d, 1, [0, 0, 64, 32], move |x, y| if x < 32 { checker(x, y) } else { [128; 3] });
        let top = d.add_layer("b", 1).unwrap();
        paint(&mut d, top, [0, 0, 64, 32], move |x, y| if x >= 32 { checker(x, y) } else { [128; 3] });
        d.auto_blend(&[1, top], true, false).unwrap();
        assert!(mask(&d, 1, 8, 16) > 0.99 && mask(&d, top, 8, 16) < 0.01);
        assert!(mask(&d, top, 56, 16) > 0.99 && mask(&d, 1, 56, 16) < 0.01);

        let mut d = Document::new(64, 32, 8).unwrap();
        paint(&mut d, 1, [0, 0, 64, 32], |x, _| [(x * 4) as u8; 3]);
        let top = d.add_layer("dark", 1).unwrap();
        paint(&mut d, top, [16, 0, 64, 32], |x, _| [(x * 2) as u8; 3]);
        d.auto_blend(&[1, top], false, true).unwrap();
        for x in [20, 40, 60] {
            let (a, b) = (px(&d, 1, x, 5)[0], px(&d, top, x, 5)[0]);
            assert!((a - b).abs() < 2.0 / 255.0, "x {x}: {a} vs {b}");
        }
    }

    #[test]
    fn photomerge_aligns_and_blends_every_pixel_layer() {
        let mut d = Document::new(256, 256, 8).unwrap();
        paint(&mut d, 1, [0, 0, 160, 256], |x, y| [texture(x, y); 3]);
        let top = d.add_layer("right", 1).unwrap();
        paint(&mut d, top, [90, 0, 256, 256], |x, y| [texture(x - 4, y - 3); 3]);
        assert_eq!(d.photomerge(true).unwrap(), 1);
        assert!(d.node(1).unwrap().mask.is_some() && d.node(top).unwrap().mask.is_some());
        let (a, b) = (px(&d, 1, 130, 120)[0], px(&d, top, 130, 120)[0]);
        assert!((a - b).abs() < 3.0 / 255.0, "{a} vs {b}");
        let mut one = Document::new(32, 32, 8).unwrap();
        assert_eq!(one.photomerge(true).unwrap_err(), "Photomerge needs at least two pixel layers.");
    }

    #[test]
    fn hdr_merge_weights_each_exposure_by_its_hat_and_stops() {
        let mut dark = Document::new(300, 20, 8).unwrap();
        paint(&mut dark, 1, [0, 0, 300, 20], |_, _| [64; 3]);
        let mut bright = Document::new(300, 20, 8).unwrap();
        paint(&mut bright, 1, [0, 0, 300, 20], |_, _| [128; 3]);
        let mut acc = HdrAcc::new(300, 20).unwrap();
        for tx in 0..2 {
            acc.add(&dark, tx, 0, 0.0).unwrap();
            acc.add(&bright, tx, 0, 1.0).unwrap();
            acc.write(tx, 0);
        }
        let (v0, v1) = (64.0 / 255.0f64, 128.0 / 255.0f64);
        let hat = |v: f64| 1.0 - (2.0 * v - 1.0).abs();
        let want = (hat(v0) * v0 + hat(v1) * v1 * 0.5) / (hat(v0) + hat(v1));
        let d = &acc.doc;
        assert_eq!((d.depth, d.nodes[0].name.as_str()), (32, "HDR"));
        for x in [5, 290] {
            let p = px(d, 1, x, 10);
            assert!((p[0] as f64 - want).abs() < 1e-5 && p[3] == 1.0, "{p:?}");
        }
        assert_eq!(px(d, 1, 300, 10)[3], 0.0, "off-canvas pixels stay empty");
        let small = Document::new(10, 10, 8).unwrap();
        assert!(acc.add(&small, 0, 0, 0.0).is_err());
    }
}
