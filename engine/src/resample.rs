//! Inverse-mapping resampler for transforms. Planes hold 1 channel (masks, selection) or 4
//! premultiplied RGBA channels in 0..1; `render` writes straight values.

/// A forward 3x3 matrix from a JS array.
pub fn matrix(m: &[f64]) -> Result<[f64; 9], String> {
    let m: [f64; 9] = m.try_into().map_err(|_| "transform matrix must have 9 finite values".to_string())?;
    if !m.iter().all(|v| v.is_finite()) {
        return Err("transform matrix must have 9 finite values".into());
    }
    Ok(m)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Interp {
    Nearest,
    Bilinear,
    Bicubic,
    BicubicSharper,
    BicubicSmoother,
    Lanczos3,
}

impl Interp {
    pub fn parse(s: &str) -> Result<Interp, String> {
        Ok(match s {
            "nearest" => Interp::Nearest,
            "bilinear" => Interp::Bilinear,
            "bicubic" => Interp::Bicubic,
            "bicubicSharper" => Interp::BicubicSharper,
            "bicubicSmoother" => Interp::BicubicSmoother,
            "lanczos3" => Interp::Lanczos3,
            other => return Err(format!("unknown interpolation {other}")),
        })
    }

    fn radius(self) -> i64 {
        match self {
            Interp::Nearest => 0,
            Interp::Bilinear => 1,
            Interp::Lanczos3 => 3,
            _ => 2,
        }
    }

    fn weight(self, t: f64) -> f64 {
        let x = t.abs();
        match self {
            Interp::Nearest => (x <= 0.5) as u8 as f64,
            Interp::Bilinear => (1.0 - x).max(0.0),
            Interp::Bicubic => keys(x, -0.5),
            Interp::BicubicSharper => keys(x, -0.75),
            Interp::BicubicSmoother => keys(x, -0.25),
            Interp::Lanczos3 => {
                if x < 3.0 {
                    sinc(x) * sinc(x / 3.0)
                } else {
                    0.0
                }
            }
        }
    }

    // Tap weights for taps x0 .. x0 + n at plane coordinate t.
    fn weights(self, x0: i64, t: f64, out: &mut [f64; 6]) {
        let n = (2 * self.radius()) as usize;
        let d = |k: usize| (x0 + k as i64) as f64 - t;
        // Cubic taps 0 and 3 lie at 1 <= |d| <= 2, taps 1 and 2 at |d| <= 1; both pieces are
        // exactly 0 at |d| = 1 and 2, so this equals `keys` without its branches.
        let cubic = |a: f64, out: &mut [f64; 6]| {
            *out = [keys_far(-d(0), a), keys_near(-d(1), a), keys_near(d(2), a), keys_far(d(3), a), 0.0, 0.0];
        };
        match self {
            Interp::Bicubic => cubic(-0.5, out),
            Interp::BicubicSharper => cubic(-0.75, out),
            Interp::BicubicSmoother => cubic(-0.25, out),
            _ => (0..n).for_each(|k| out[k] = self.weight(d(k))),
        }
    }
}

// `t.floor() as i64` (saturating, NaN -> 0) without the floor library call.
#[inline(always)]
fn floor_i64(t: f64) -> i64 {
    let i = t as i64;
    if (i as f64) > t { i.saturating_sub(1) } else { i }
}

fn keys(x: f64, a: f64) -> f64 {
    if x < 1.0 {
        keys_near(x, a)
    } else if x < 2.0 {
        keys_far(x, a)
    } else {
        0.0
    }
}

#[inline(always)]
fn keys_near(x: f64, a: f64) -> f64 {
    (a + 2.0) * x * x * x - (a + 3.0) * x * x + 1.0
}

// Zero at x = 1 and x = 2 exactly for the three `a` values used.
#[inline(always)]
fn keys_far(x: f64, a: f64) -> f64 {
    a * x * x * x - 5.0 * a * x * x + 8.0 * a * x - 4.0 * a
}

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        1.0
    } else {
        let t = std::f64::consts::PI * x;
        t.sin() / t
    }
}

/// A dense source plane covering the document rect at (x, y), `sx` x `sy` plane pixels per
/// document pixel (1 for full resolution, below 1 for a preview proxy).
pub struct Plane {
    pub x: i32,
    pub y: i32,
    pub w: usize,
    pub h: usize,
    pub ch: usize,
    pub sx: f64,
    pub sy: f64,
    pub data: Vec<f32>,
}

// One sampling level: the plane or a downscaled copy, with its pixels per document pixel.
struct Level {
    w: usize,
    h: usize,
    sx: f64,
    sy: f64,
    data: Vec<f32>,
}

// Inverse map, dest document point -> source document point.
enum Map {
    Affine([f64; 6]),
    Projective([f64; 9]),
}

pub struct Resampler {
    levels: Vec<Level>,
    ch: usize,
    ox: f64,
    oy: f64,
    map: Map,
    interp: Interp,
    edge: f32,
    rect: [i32; 4],
}

// Separable resize weights (clamped edges): per output index the first source index and weights.
fn resize_weights(src: usize, dst: usize, boxed: bool) -> Vec<(i64, Vec<f64>)> {
    let n = dst as f64 / src as f64;
    let k = n.min(1.0);
    let support = if boxed { 0.5 } else { 2.0 } / k;
    let f = |t: f64| if boxed { (-0.5..0.5).contains(&t) as u8 as f64 } else { keys(t.abs(), -0.5) };
    (0..dst)
        .map(|s| {
            let g = (s as f64 + 0.5) / n - 0.5;
            let lo = (g - support).ceil() as i64;
            let hi = ((g + support).floor() as i64).max(lo);
            let mut w: Vec<f64> = (lo..=hi).map(|i| f((i as f64 - g) * k)).collect();
            let mut sum: f64 = w.iter().sum();
            if sum == 0.0 {
                let at = ((g.round() as i64 - lo).max(0) as usize).min(w.len() - 1);
                w[at] = 1.0;
                sum = 1.0;
            }
            w.iter_mut().for_each(|v| *v /= sum);
            (lo, w)
        })
        .collect()
}

fn resize(l: &Level, ch: usize, nw: usize, nh: usize, boxed: bool) -> Level {
    let (w, h) = (l.w, l.h);
    let clamp = |i: i64, n: usize| i.clamp(0, n as i64 - 1) as usize;
    let wx = resize_weights(w, nw, boxed);
    let mut rows = vec![0f32; nw * h * ch];
    for y in 0..h {
        for (x, (lo, ws)) in wx.iter().enumerate() {
            for c in 0..ch {
                let v: f64 = ws.iter().enumerate().map(|(i, wt)| l.data[(y * w + clamp(lo + i as i64, w)) * ch + c] as f64 * wt).sum();
                rows[(y * nw + x) * ch + c] = v as f32;
            }
        }
    }
    let wy = resize_weights(h, nh, boxed);
    let mut data = vec![0f32; nw * nh * ch];
    for (y, (lo, ws)) in wy.iter().enumerate() {
        for x in 0..nw {
            for c in 0..ch {
                let v: f64 = ws.iter().enumerate().map(|(i, wt)| rows[(clamp(lo + i as i64, h) * nw + x) * ch + c] as f64 * wt).sum();
                data[(y * nw + x) * ch + c] = v as f32;
            }
        }
    }
    Level { w: nw, h: nh, sx: l.sx * nw as f64 / w as f64, sy: l.sy * nh as f64 / h as f64, data }
}

impl Resampler {
    /// `m` is the forward 3x3 matrix (row-major, source -> dest document px). `edge` is the
    /// value of every channel outside the source (0, or a mask's default value).
    pub fn new(src: Plane, m: &[f64; 9], interp: Interp, edge: f32) -> Result<Resampler, String> {
        if !m.iter().all(|v| v.is_finite()) {
            return Err("transform matrix must have 9 finite values".into());
        }
        let bad = || "transform matrix is not invertible".to_string();
        let affine = m[6].abs() <= 1e-12 && m[7].abs() <= 1e-12 && m[8] != 0.0;
        let map = if affine {
            let a: Vec<f64> = m[..6].iter().map(|v| v / m[8]).collect();
            let det = a[0] * a[4] - a[1] * a[3];
            if det == 0.0 || !det.is_finite() {
                return Err(bad());
            }
            let (i0, i1, i3, i4) = (a[4] / det, -a[1] / det, -a[3] / det, a[0] / det);
            Map::Affine([i0, i1, -(i0 * a[2] + i1 * a[5]), i3, i4, -(i3 * a[2] + i4 * a[5])])
        } else {
            let [a, b, c, d, e, f, g, h, i] = *m;
            let (r, s, t) = (e * i - f * h, f * g - d * i, d * h - e * g);
            let det = a * r + b * s + c * t;
            if det == 0.0 || !det.is_finite() {
                return Err(bad());
            }
            let q = 1.0 / det;
            Map::Projective([
                r * q,
                (c * h - b * i) * q,
                (b * f - c * e) * q,
                s * q,
                (a * i - c * g) * q,
                (c * d - a * f) * q,
                t * q,
                (b * g - a * h) * q,
                (a * e - b * d) * q,
            ])
        };
        // Output rect: floor/ceil of the transformed source corners, which must all lie on one
        // side of the projective horizon.
        let (x0, y0) = (src.x as f64, src.y as f64);
        let (x1, y1) = (x0 + src.w as f64 / src.sx, y0 + src.h as f64 / src.sy);
        let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        let mut sign = 0.0;
        for (x, y) in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)] {
            let w = m[6] * x + m[7] * y + m[8];
            if w == 0.0 || !w.is_finite() || (sign != 0.0 && w.signum() != sign) {
                return Err("transform maps the layer through infinity".into());
            }
            sign = w.signum();
            let (px, py) = ((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w);
            bb = [bb[0].min(px), bb[1].min(py), bb[2].max(px), bb[3].max(py)];
        }
        if !bb.iter().all(|v| v.is_finite() && v.abs() < (1u64 << 29) as f64) {
            return Err("transform result is too large".into());
        }
        let (rx, ry) = (bb[0].floor(), bb[1].floor());
        let rect = [rx as i32, ry as i32, (bb[2].ceil() - rx) as i32, (bb[3].ceil() - ry) as i32];
        let base = Level { w: src.w, h: src.h, sx: src.sx, sy: src.sy, data: src.data };
        let mut rs =
            Resampler { levels: Vec::new(), ch: src.ch, ox: x0, oy: y0, map, interp, edge, rect };
        if base.w == 0 || base.h == 0 {
            rs.levels.push(base);
            return Ok(rs);
        }
        match rs.map {
            Map::Affine(_) => {
                // Uniform minification from the forward matrix columns, one prefiltered level.
                let (ex, ey) = ((m[0] / m[8]).hypot(m[3] / m[8]), (m[1] / m[8]).hypot(m[4] / m[8]));
                let fx = if ex > 0.0 { base.sx / ex } else { 1.0 }.max(1.0);
                let fy = if ey > 0.0 { base.sy / ey } else { 1.0 }.max(1.0);
                let nw = ((base.w as f64 / fx).round() as usize).max(1);
                let nh = ((base.h as f64 / fy).round() as usize).max(1);
                if nw == base.w && nh == base.h {
                    rs.levels.push(base);
                } else {
                    rs.levels.push(resize(&base, rs.ch, nw, nh, fx.max(fy) >= 2.0));
                }
            }
            Map::Projective(_) => {
                // Box-halved mip pyramid sized by the largest minification on a 3x3 dest grid.
                let [dx, dy, dw, dh] = rect.map(|v| v as f64);
                let mut most: f64 = 0.0;
                for x in [dx + 0.5, dx + dw / 2.0, dx + dw - 0.5] {
                    for y in [dy + 0.5, dy + dh / 2.0, dy + dh - 0.5] {
                        let v = rs.minification(&base, x, y);
                        if v.is_finite() {
                            most = most.max(v);
                        }
                    }
                }
                rs.push_pyramid(base, most);
            }
        }
        Ok(rs)
    }

    /// A source for per-point sampling (warps): a box-halved mip pyramid deep enough for
    /// minification `most` (source px per dest px).
    pub fn pyramid(src: Plane, interp: Interp, edge: f32, most: f64) -> Resampler {
        let map = Map::Affine([1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        let rect = [src.x, src.y, src.w as i32, src.h as i32];
        let (ox, oy) = (src.x as f64, src.y as f64);
        let mut rs = Resampler { levels: Vec::new(), ch: src.ch, ox, oy, map, interp, edge, rect };
        let base = Level { w: src.w, h: src.h, sx: src.sx, sy: src.sy, data: src.data };
        rs.push_pyramid(base, most);
        rs
    }

    // Levels base, base/2, ... : ceil(log2(most)) + 2 of them when minifying, else just the base.
    fn push_pyramid(&mut self, base: Level, most: f64) {
        let count = if most > 1.0 { most.log2().ceil() as usize + 2 } else { 1 };
        self.levels.push(base);
        while self.levels.len() < count {
            let l = self.levels.last().expect("the base level");
            if l.w <= 1 && l.h <= 1 {
                break;
            }
            let next = resize(l, self.ch, l.w.div_ceil(2).max(1), l.h.div_ceil(2).max(1), true);
            self.levels.push(next);
        }
    }

    /// Samples the source at document point (x, y) with minification `m` (source document px
    /// per dest px) into `px` (straight). Returns false, leaving `px` alone, when no tap hit.
    pub fn sample_point(&self, x: f64, y: f64, m: f64, px: &mut [f32]) -> bool {
        let l = &self.levels[0];
        self.pixel(x, y, || m * (l.sx * l.sy).sqrt(), px)
    }

    /// Dest rect [x, y, w, h] in document pixels.
    pub fn rect(&self) -> [i32; 4] {
        self.rect
    }

    // Source plane pixels per dest pixel at a dest point (sqrt |det J| of the inverse map).
    fn minification(&self, base: &Level, x: f64, y: f64) -> f64 {
        let Map::Projective(e) = &self.map else { return 1.0 };
        let n = e[6] * x + e[7] * y + e[8];
        if n == 0.0 {
            return 1.0;
        }
        let (i, o, s) = (e[0] * x + e[1] * y + e[2], e[3] * x + e[4] * y + e[5], 1.0 / n);
        let g = s * s;
        let j = [e[0] * s - i * e[6] * g, e[3] * s - o * e[6] * g, e[1] * s - i * e[7] * g, e[4] * s - o * e[7] * g];
        let det = (j[0] * j[3] - j[1] * j[2]).abs() * base.sx * base.sy;
        if det > 0.0 { det.sqrt() } else { 1.0 }
    }

    fn inverse(&self, x: f64, y: f64) -> Option<(f64, f64)> {
        match &self.map {
            Map::Affine(t) => Some((t[0] * x + t[1] * y + t[2], t[3] * x + t[4] * y + t[5])),
            Map::Projective(e) => {
                let w = e[6] * x + e[7] * y + e[8];
                if w == 0.0 || !w.is_finite() {
                    return None;
                }
                Some(((e[0] * x + e[1] * y + e[2]) / w, (e[3] * x + e[4] * y + e[5]) / w))
            }
        }
    }
}

// The filter sum of `CH` channels over N x N taps at (x0, y0) of a level into `o`; out-of-range
// taps read `edge` and count in the weight sum, which normalizes the result. Zero-weight taps
// add exact zeros, so the interior loop does not skip them.
fn taps<const CH: usize, const N: usize>(l: &Level, x0: i64, y0: i64, wx: &[f64; 6], wy: &[f64; 6], edge: f64, o: &mut [f64; 4]) {
    let (w, h, n) = (l.w as i64, l.h as i64, N);
    let mut sum = 0.0;
    if x0 >= 0 && y0 >= 0 && x0 + N as i64 <= w && y0 + N as i64 <= h {
        let wx: &[f64; N] = wx[..N].try_into().expect("N <= 6");
        for (j, wyj) in wy[..N].iter().enumerate() {
            let at = ((y0 + j as i64) * w + x0) as usize * CH;
            let row = &l.data[at..at + N * CH];
            for k in 0..N {
                let p = wx[k] * wyj;
                sum += p;
                for c in 0..CH {
                    o[c] += row[k * CH + c] as f64 * p;
                }
            }
        }
    } else {
        for (j, wyj) in wy[..n].iter().enumerate() {
            if *wyj == 0.0 {
                continue;
            }
            let y = y0 + j as i64;
            for (k, wxk) in wx[..n].iter().enumerate() {
                if *wxk == 0.0 {
                    continue;
                }
                let p = wxk * wyj;
                sum += p;
                let x = x0 + k as i64;
                if x >= 0 && y >= 0 && x < w && y < h {
                    let at = (y * w + x) as usize * CH;
                    for c in 0..CH {
                        o[c] += l.data[at + c] as f64 * p;
                    }
                } else {
                    for v in o[..CH].iter_mut() {
                        *v += edge * p;
                    }
                }
            }
        }
    }
    if sum != 0.0 && (sum - 1.0).abs() > 1e-9 {
        for v in o[..CH].iter_mut() {
            *v /= sum;
        }
    }
}

impl Resampler {
    // Samples level `l` at plane point (t, u) (pixel centres at integers) into `o`, premultiplied.
    // Returns false (and leaves `o` at the edge value) when every tap lies outside the level.
    fn sample(&self, l: &Level, t: f64, u: f64, o: &mut [f64; 4]) -> bool {
        let ch = self.ch;
        let edge = self.edge as f64;
        let (w, h) = (l.w as i64, l.h as i64);
        *o = [0.0; 4];
        if self.interp == Interp::Nearest {
            let (x, y) = (floor_i64(t + 0.5), floor_i64(u + 0.5));
            let inside = x >= 0 && y >= 0 && x < w && y < h;
            for c in 0..ch {
                o[c] = if inside { l.data[(y * w + x) as usize * ch + c] as f64 } else { edge };
            }
            return inside;
        }
        if !(t.is_finite() && u.is_finite()) {
            o[..ch].fill(edge);
            return false;
        }
        // Taps floor(t) - r + 1 .. + 2r.
        let r = self.interp.radius();
        let n = (2 * r) as usize;
        let (x0, y0) = (floor_i64(t) - r + 1, floor_i64(u) - r + 1);
        if x0 >= w || y0 >= h || x0 + n as i64 <= 0 || y0 + n as i64 <= 0 {
            o[..ch].fill(edge);
            return false;
        }
        let (mut wx, mut wy) = ([0f64; 6], [0f64; 6]);
        self.interp.weights(x0, t, &mut wx);
        self.interp.weights(y0, u, &mut wy);
        match (ch, n) {
            (4, 2) => taps::<4, 2>(l, x0, y0, &wx, &wy, edge, o),
            (4, 4) => taps::<4, 4>(l, x0, y0, &wx, &wy, edge, o),
            (4, _) => taps::<4, 6>(l, x0, y0, &wx, &wy, edge, o),
            (_, 2) => taps::<1, 2>(l, x0, y0, &wx, &wy, edge, o),
            (_, 4) => taps::<1, 4>(l, x0, y0, &wx, &wy, edge, o),
            _ => taps::<1, 6>(l, x0, y0, &wx, &wy, edge, o),
        }
        true
    }

    // Columns i in 0..w of dest row y whose taps can reach level 0 under affine map `t`, widened
    // by 2 so rounding never drops one; `sample` still decides each pixel exactly.
    fn row_span(&self, t: &[f64; 6], x: i32, y: i32, w: usize) -> (usize, usize) {
        let l = &self.levels[0];
        let r = self.interp.radius().max(1) as f64;
        let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
        let (mut lo, mut hi) = (f64::NEG_INFINITY, f64::INFINITY);
        for (k, sc, org, n) in [(0, l.sx, self.ox, l.w), (3, l.sy, self.oy, l.h)] {
            // Plane coordinate s0 + i * ds; a pixel can read the level only while -r - 1 < s < n + r.
            let s0 = (t[k] * cx + t[k + 1] * cy + t[k + 2] - org) * sc - 0.5;
            let ds = t[k] * sc;
            let (min, max) = (-r - 1.0, n as f64 + r);
            if ds == 0.0 {
                if !(s0 > min && s0 < max) {
                    return (0, 0);
                }
                continue;
            }
            let (p, q) = ((min - s0) / ds, (max - s0) / ds);
            (lo, hi) = (lo.max(p.min(q)), hi.min(p.max(q)));
        }
        if !(lo < hi) {
            return (0, 0);
        }
        let clamp = |v: f64| v.clamp(0.0, w as f64) as usize;
        (clamp(lo.floor() - 2.0), clamp(hi.ceil() + 2.0))
    }

    // One dest pixel from source document point (sx, sy); `minification` gives the plane
    // minification for level selection. Writes straight values; false when no tap hit.
    fn pixel(&self, sx: f64, sy: f64, minification: impl FnOnce() -> f64, px: &mut [f32]) -> bool {
        let ch = self.ch;
        let (mut a, mut b) = ([0f64; 4], [0f64; 4]);
        let (sx, sy) = (sx - self.ox, sy - self.oy);
        let at = |l: &Level| (sx * l.sx - 0.5, sy * l.sy - 0.5);
        if self.levels.len() == 1 {
            let (t, u) = at(&self.levels[0]);
            if !self.sample(&self.levels[0], t, u, &mut a) {
                return false;
            }
        } else {
            let m = minification();
            let lm = if m > 1.0 { m.log2() } else { 0.0 };
            let last = self.levels.len() - 1;
            let l0 = (lm.floor() as usize).min(last);
            let l1 = (l0 + 1).min(last);
            let frac = if l0 == l1 { 0.0 } else { lm - l0 as f64 };
            let (t, u) = at(&self.levels[l0]);
            let mut hit = self.sample(&self.levels[l0], t, u, &mut a);
            if frac > 0.0 {
                let (t, u) = at(&self.levels[l1]);
                hit |= self.sample(&self.levels[l1], t, u, &mut b);
                for c in 0..ch {
                    a[c] = a[c] * (1.0 - frac) + b[c] * frac;
                }
            }
            if !hit {
                return false;
            }
        }
        if ch == 4 {
            if a[3] <= 0.0 {
                a = [0.0; 4];
            } else {
                for c in 0..3 {
                    a[c] /= a[3];
                }
            }
        }
        for c in 0..ch {
            px[c] = a[c] as f32;
        }
        true
    }

    /// Renders the dest pixels of the document rect (x, y, w, h) into `out` (w * h * channels,
    /// straight values). Pixels outside `rect()` or without a source point get the edge value.
    /// Returns false when no pixel read the source, so `out` holds only the edge value.
    pub fn render(&self, x: i32, y: i32, w: usize, h: usize, out: &mut [f32]) -> bool {
        let ch = self.ch;
        let [rx, ry, rw, rh] = self.rect;
        let single = self.levels.len() == 1;
        let mut touched = false;
        for j in 0..h {
            let (i0, i1) = match &self.map {
                Map::Affine(t) if single => self.row_span(t, x, y + j as i32, w),
                _ => (0, w),
            };
            out[j * w * ch..(j + 1) * w * ch].fill(self.edge);
            for i in i0..i1 {
                let px = &mut out[(j * w + i) * ch..(j * w + i + 1) * ch];
                let (dx, dy) = (x + i as i32, y + j as i32);
                if dx < rx || dy < ry || dx >= rx + rw || dy >= ry + rh {
                    continue;
                }
                let (cx, cy) = (dx as f64 + 0.5, dy as f64 + 0.5);
                let Some((sx, sy)) = self.inverse(cx, cy) else { continue };
                if self.pixel(sx, sy, || self.minification(&self.levels[0], cx, cy), px) {
                    touched = true;
                }
            }
        }
        touched
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [Interp; 6] = [
        Interp::Nearest,
        Interp::Bilinear,
        Interp::Bicubic,
        Interp::BicubicSharper,
        Interp::BicubicSmoother,
        Interp::Lanczos3,
    ];

    fn plane1(w: usize, h: usize, data: Vec<f32>) -> Plane {
        Plane { x: 0, y: 0, w, h, ch: 1, sx: 1.0, sy: 1.0, data }
    }

    fn render_all(rs: &Resampler) -> Vec<f32> {
        let [x, y, w, h] = rs.rect();
        let mut out = vec![0f32; w as usize * h as usize * rs.ch];
        rs.render(x, y, w as usize, h as usize, &mut out);
        out
    }

    const HALF_RIGHT: [f64; 9] = [1.0, 0.0, 0.5, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

    fn impulse() -> Vec<f32> {
        let mut v = vec![0f32; 16];
        v[4 + 1] = 1.0;
        v
    }

    fn close(got: &[f32], want: &[f32]) {
        assert_eq!(got.len(), want.len(), "got {got:?}");
        for (g, w) in got.iter().zip(want) {
            assert!((g - w).abs() < 1e-6, "got {got:?}, want {want:?}");
        }
    }

    #[test]
    fn kernels_on_a_half_pixel_shifted_impulse() {
        let rows: [(Interp, [f32; 5]); 6] = [
            (Interp::Nearest, [0.0, 1.0, 0.0, 0.0, 0.0]),
            (Interp::Bilinear, [0.0, 0.5, 0.5, 0.0, 0.0]),
            (Interp::Bicubic, [-0.0625, 0.5625, 0.5625, -0.0625, 0.0]),
            (Interp::BicubicSharper, [-0.09375, 0.59375, 0.59375, -0.09375, 0.0]),
            (Interp::BicubicSmoother, [-0.03125, 0.53125, 0.53125, -0.03125, 0.0]),
            (Interp::Lanczos3, [-0.1358696, 0.611413, 0.611413, -0.1358696, 0.0244565]),
        ];
        for (k, want) in rows {
            let rs = Resampler::new(plane1(4, 4, impulse()), &HALF_RIGHT, k, 0.0).unwrap();
            assert_eq!(rs.rect(), [0, 0, 5, 4], "{k:?}");
            let out = render_all(&rs);
            close(&out[5..10], &want);
            assert!(out[..5].iter().chain(&out[10..]).all(|v| v.abs() < 1e-6), "{k:?}: {out:?}");
        }
    }

    #[test]
    fn bicubic_ramp_fades_into_the_zero_edge() {
        let ramp: Vec<f32> = (0..16).map(|i| (i % 4) as f32 / 3.0).collect();
        let rs = Resampler::new(plane1(4, 4, ramp), &HALF_RIGHT, Interp::Bicubic, 0.0).unwrap();
        let out = render_all(&rs);
        close(&out[..5], &[-0.0625 / 3.0, 0.5625 / 3.0 - 0.0625 * 2.0 / 3.0, 0.5, 0.5625 * 2.0 / 3.0 + 0.5625 - 0.0625 / 3.0, 0.5625 - 0.0625 / 3.0 * 2.0]);
    }

    #[test]
    fn edge_value_fills_outside_like_a_mask_default() {
        let rs = Resampler::new(plane1(4, 4, vec![1.0; 16]), &HALF_RIGHT, Interp::Bicubic, 1.0).unwrap();
        assert!(render_all(&rs).iter().all(|v| (v - 1.0).abs() < 1e-6));
    }

    #[test]
    fn identity_and_integer_translate_are_exact_for_every_kernel() {
        let data: Vec<f32> = (0..16).map(|i| i as f32 / 15.0).collect();
        for k in ALL {
            let id = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
            let rs = Resampler::new(plane1(4, 4, data.clone()), &id, k, 0.0).unwrap();
            close(&render_all(&rs), &data);
            let tr = [1.0, 0.0, -7.0, 0.0, 1.0, 3.0, 0.0, 0.0, 1.0];
            let rs = Resampler::new(plane1(4, 4, data.clone()), &tr, k, 0.0).unwrap();
            assert_eq!(rs.rect(), [-7, 3, 4, 4]);
            close(&render_all(&rs), &data);
        }
    }

    #[test]
    fn singular_and_non_finite_matrices_are_refused() {
        let z = [0.0; 9];
        assert_eq!(Resampler::new(plane1(1, 1, vec![1.0]), &z, Interp::Bilinear, 0.0).err().unwrap(), "transform matrix is not invertible");
        let n = [f64::NAN, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        assert!(Resampler::new(plane1(1, 1, vec![1.0]), &n, Interp::Bilinear, 0.0).is_err());
        // The horizon w = 0 crosses the source rect.
        let p = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, -1.0, 0.0, 2.0];
        assert_eq!(
            Resampler::new(plane1(4, 4, vec![1.0; 16]), &p, Interp::Bilinear, 0.0).err().unwrap(),
            "transform maps the layer through infinity"
        );
    }

    #[test]
    fn downscale_prefilters_instead_of_aliasing() {
        // A 1-px checker scaled to 1/4 averages to 0.5 instead of picking one phase.
        let data: Vec<f32> = (0..64 * 64).map(|i| ((i % 64 + i / 64) % 2) as f32).collect();
        let m = [0.25, 0.0, 0.0, 0.0, 0.25, 0.0, 0.0, 0.0, 1.0];
        let rs = Resampler::new(plane1(64, 64, data.clone()), &m, Interp::Bicubic, 0.0).unwrap();
        assert_eq!(rs.levels[0].w, 16);
        let out = render_all(&rs);
        let [_, _, w, h] = rs.rect();
        for y in 2..h as usize - 2 {
            for x in 2..w as usize - 2 {
                assert!((out[y * w as usize + x] - 0.5).abs() < 1e-4, "{x},{y}: {}", out[y * w as usize + x]);
            }
        }
        // Projective minification builds a pyramid and blends levels.
        let p = [0.25, 0.0, 0.0, 0.0, 0.25, 0.0, 0.0001, 0.0, 1.0];
        let rs = Resampler::new(plane1(64, 64, data), &p, Interp::Bilinear, 0.0).unwrap();
        assert!(rs.levels.len() >= 4, "{}", rs.levels.len());
        let out = render_all(&rs);
        let [_, _, w, _] = rs.rect();
        let v = out[5 * w as usize + 5];
        assert!((v - 0.5).abs() < 0.05, "{v}");
    }
}
