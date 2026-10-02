//! Content-Aware Scale (docs/M5.md section 11): seams of least energy removed or inserted along
//! each axis, then a plain bicubic resample to the target size; registry entry `content_aware_scale`.

use crate::filters::{Ctx, Filter, Plane};
use crate::resample::{Interp, Plane as RPlane, Resampler};

const LIMIT: &str = "Content-Aware Scale exceeds the rendering limit.";

// Straight RGBA rows.
struct Img {
    w: usize,
    h: usize,
    d: Vec<f32>,
}

impl Img {
    fn px(&self, x: usize, y: usize) -> &[f32] {
        &self.d[(y * self.w + x) * 4..][..4]
    }

    fn transposed(&self) -> Img {
        let mut d = vec![0.0; self.d.len()];
        for y in 0..self.h {
            for x in 0..self.w {
                d[(x * self.h + y) * 4..][..4].copy_from_slice(self.px(x, y));
            }
        }
        Img { w: self.h, h: self.w, d }
    }
}

fn skin(p: &[f32]) -> bool {
    let (r, g, b) = (p[0], p[1], p[2]);
    let (hi, lo) = (r.max(g).max(b), r.min(g).min(b));
    r > 0.35 && g > 0.2 && b > 0.15 && r > g && g > b && hi - lo > 0.05 && r - g > 0.04 && r - b < 0.6
}

fn energy(img: &Img, protect: bool) -> Vec<f32> {
    let lum = |x: usize, y: usize| {
        let p = img.px(x, y);
        0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]
    };
    let mut e = Vec::with_capacity(img.w * img.h);
    for y in 0..img.h {
        for x in 0..img.w {
            let (xl, xr, yu, yd) = (x.saturating_sub(1), (x + 1).min(img.w - 1), y.saturating_sub(1), (y + 1).min(img.h - 1));
            let mut v = (lum(xr, y) - lum(xl, y)).hypot(lum(x, yd) - lum(x, yu));
            let p = img.px(x, y);
            if p[3] < 0.5 {
                v *= 0.1;
            }
            if protect && skin(p) {
                v += 250.0;
            }
            e.push(v);
        }
    }
    e
}

// The column of the cheapest vertical seam in every row.
fn seam(img: &Img, protect: bool) -> Vec<usize> {
    let (w, h) = (img.w, img.h);
    let mut m = energy(img, protect);
    for y in 1..h {
        for x in 0..w {
            let up = |c: usize| m[(y - 1) * w + c];
            let mut best = up(x);
            if x > 0 && up(x - 1) < best {
                best = up(x - 1);
            }
            if x + 1 < w && up(x + 1) < best {
                best = up(x + 1);
            }
            m[y * w + x] += best;
        }
    }
    let mut at = (0..w).fold(0, |a, x| if m[(h - 1) * w + x] < m[(h - 1) * w + a] { x } else { a });
    let mut cols = vec![0; h];
    for y in (0..h).rev() {
        cols[y] = at;
        if y > 0 {
            let up = |c: usize| m[(y - 1) * w + c];
            let mut next = at;
            if at > 0 && up(at - 1) < up(next) {
                next = at - 1;
            }
            if at + 1 < w && up(at + 1) < up(next) {
                next = at + 1;
            }
            at = next;
        }
    }
    cols
}

// `n` seams removed one by one; the second value counts, per original pixel, the seams through it.
fn remove(img: &Img, protect: bool, n: usize) -> (Img, Vec<u32>) {
    let (w0, h) = (img.w, img.h);
    let mut hits = vec![0u32; w0 * h];
    let mut origin: Vec<usize> = (0..w0 * h).map(|i| i % w0).collect();
    let mut cur = Img { w: w0, h, d: img.d.clone() };
    for _ in 0..n.min(w0 - 1) {
        let cols = seam(&cur, protect);
        let w = cur.w;
        let (mut d, mut o) = (Vec::with_capacity((w - 1) * h * 4), Vec::with_capacity((w - 1) * h));
        for (y, c) in cols.iter().enumerate() {
            hits[y * w0 + origin[y * w + c]] += 1;
            for x in (0..w).filter(|x| x != c) {
                d.extend_from_slice(cur.px(x, y));
                o.push(origin[y * w + x]);
            }
        }
        (cur, origin) = (Img { w: w - 1, h, d }, o);
    }
    (cur, hits)
}

fn insert(img: &Img, protect: bool, n: usize) -> Img {
    let n = n.min(img.w - 1);
    let (_, hits) = remove(img, protect, n);
    let w = img.w + n;
    let mut d = Vec::with_capacity(w * img.h * 4);
    for y in 0..img.h {
        let start = d.len();
        for x in 0..img.w {
            let p = img.px(x, y);
            d.extend_from_slice(p);
            let q = img.px((x + 1).min(img.w - 1), y);
            let a = (p[3] + q[3]) / 2.0;
            let mix = |c: usize| if a > 0.0 { (p[c] * p[3] + q[c] * q[3]) / (2.0 * a) } else { 0.0 };
            for _ in 0..hits[y * img.w + x] {
                d.extend_from_slice(&[mix(0), mix(1), mix(2), a]);
            }
        }
        let last = img.px(img.w - 1, y);
        while d.len() < start + w * 4 {
            d.extend_from_slice(last);
        }
    }
    Img { w, h: img.h, d }
}

// One axis of the seam pass: the width of `img` carved to `to`.
fn carve_axis(img: Img, protect: bool, to: usize) -> Img {
    if to < img.w {
        remove(&img, protect, img.w - to).0
    } else if to > img.w {
        insert(&img, protect, to - img.w)
    } else {
        img
    }
}

fn target(len: usize, percent: f64) -> usize {
    ((len as f64 * percent / 100.0).round() as usize).max(1)
}

fn lerp(from: usize, to: usize, amount: f64) -> usize {
    ((from as f64 + (to as f64 - from as f64) * amount).round() as usize).max(1)
}

// `src` scaled to `tw` x `th`: seams carved by `amount` (0..1) of the way, the rest bicubic.
fn carve(src: Img, tw: usize, th: usize, amount: f64, protect: bool) -> Result<Img, String> {
    let (w, h) = (src.w, src.h);
    let img = carve_axis(src, protect, lerp(w, tw, amount));
    let img = carve_axis(img.transposed(), protect, lerp(h, th, amount)).transposed();
    if (img.w, img.h) == (tw, th) {
        return Ok(img);
    }
    let mut d = img.d;
    for p in d.chunks_exact_mut(4) {
        let a = p[3];
        p[..3].iter_mut().for_each(|c| *c *= a);
    }
    let m = [tw as f64 / img.w as f64, 0.0, 0.0, 0.0, th as f64 / img.h as f64, 0.0, 0.0, 0.0, 1.0];
    let rs = Resampler::new(RPlane { x: 0, y: 0, w: img.w, h: img.h, ch: 4, sx: 1.0, sy: 1.0, data: d }, &m, Interp::Bicubic, 0.0)?;
    let mut out = vec![0f32; tw * th * 4];
    rs.render(0, 0, tw, th, &mut out);
    Ok(Img { w: tw, h: th, d: out })
}

fn size(f: &Filter, r: [i32; 4]) -> Result<[usize; 2], String> {
    let (w, h) = (target(r[2].max(0) as usize, f.num("width")), target(r[3].max(0) as usize, f.num("height")));
    if w > 1 << 20 || h > 1 << 20 || w * h > 100_000_000 {
        return Err(LIMIT.into());
    }
    Ok([w, h])
}

/// The document rect the result can cover: the source rect `r` and the scaled rect at its top-left.
pub fn extent(f: &Filter, r: [i32; 4]) -> Result<[i32; 4], String> {
    let [w, h] = size(f, r)?;
    Ok([r[0], r[1], r[2].max(w as i32), r[3].max(h as i32)])
}

/// The registry entry `content_aware_scale`: the layer's tight bounds (`ctx.bounds`, clipped to the
/// plane) carved and scaled, anchored at their top-left; the rest of the plane becomes transparent.
pub fn apply(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let b = ctx.bounds.map(|v| (v as f64 * ctx.scale).round() as i32);
    let (x0, y0) = (b[0].max(p.x), b[1].max(p.y));
    let (x1, y1) = ((b[0] + b[2]).min(p.x + p.w as i32), (b[1] + b[3]).min(p.y + p.h as i32));
    if x1 <= x0 || y1 <= y0 {
        return Ok(());
    }
    let (sw, sh) = ((x1 - x0) as usize, (y1 - y0) as usize);
    let [tw, th] = size(f, [x0, y0, sw as i32, sh as i32])?;
    let mut d = Vec::with_capacity(sw * sh * 4);
    for y in y0..y1 {
        let o = ((y - p.y) as usize * p.w + (x0 - p.x) as usize) * 4;
        d.extend_from_slice(&p.data[o..o + sw * 4]);
    }
    let out = carve(Img { w: sw, h: sh, d }, tw, th, f.num("amount") / 100.0, f.flag("protectSkinTones"))?;
    p.data.fill(0.0);
    let (cw, ch) = (out.w.min((p.x + p.w as i32 - x0) as usize), out.h.min((p.y + p.h as i32 - y0) as usize));
    for y in 0..ch {
        let o = ((y0 - p.y) as usize + y) * p.w + (x0 - p.x) as usize;
        p.data[o * 4..(o + cw) * 4].copy_from_slice(&out.d[y * out.w * 4..][..cw * 4]);
    }
    Ok(())
}
