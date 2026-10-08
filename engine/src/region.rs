//! Flood fill for the magic wand and paint bucket (docs/M2.md section 3 "Magic wand" and
//! section 4 "Paint bucket"): both share the same color-distance test and flood.

fn px_at(src: &[u8], p: usize) -> [u8; 4] {
    let o = p * 4;
    [src[o], src[o + 1], src[o + 2], src[o + 3]]
}

// Max channel difference over R,G,B,A, in 8-bit units: the magic wand / paint bucket color test.
fn dist(a: [u8; 4], b: [u8; 4]) -> u8 {
    (0..4).map(|i| a[i].abs_diff(b[i])).max().expect("4 channels")
}

fn hard_mask(src: &[u8], w: i32, h: i32, color: [u8; 4], tol: u8, contiguous: bool, seed: (i32, i32)) -> Vec<u8> {
    let within = |p: usize| dist(px_at(src, p), color) <= tol;
    let mut out = vec![0u8; (w * h) as usize];
    if !contiguous {
        for (p, v) in out.iter_mut().enumerate() {
            *v = within(p) as u8;
        }
        return out;
    }
    // 4-connected fill from the seed pixel (equivalent result to a scanline fill).
    let mut stack = vec![seed];
    out[(seed.1 * w + seed.0) as usize] = 1;
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let idx = (ny * w + nx) as usize;
            if out[idx] == 0 && within(idx) {
                out[idx] = 1;
                stack.push((nx, ny));
            }
        }
    }
    out
}

// 3x3 box average of the hard mask, restricted to border pixels (a hard pixel with a
// differently-valued 4-neighbour); interior pixels keep their hard 0/1 value.
fn soften_border(hard: &[u8], w: i32, h: i32) -> Vec<f32> {
    let at = |x: i32, y: i32| -> u8 {
        if x < 0 || y < 0 || x >= w || y >= h {
            0
        } else {
            hard[(y * w + x) as usize]
        }
    };
    let mut out = vec![0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let v = at(x, y);
            let border = [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|&(dx, dy)| at(x + dx, y + dy) != v);
            out[(y * w + x) as usize] = if border {
                let mut sum = 0u32;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        sum += at(x + dx, y + dy) as u32;
                    }
                }
                sum as f32 / 9.0
            } else {
                v as f32
            };
        }
    }
    out
}

/// Coverage (0..1) of a flood fill from `seed` over an RGBA8 buffer (16-bit sources are
/// normalized down to 8-bit units by the caller, so tolerance stays in one scale). Contiguous is
/// a 4-connected fill from the seed pixel; non-contiguous takes every pixel within tolerance.
/// Antialias gives the hard mask's border pixels (see `soften_border`) a soft 1-pixel edge.
pub fn flood(src: &[u8], w: u32, h: u32, seed: (u32, u32), tolerance: u8, contiguous: bool, antialias: bool) -> Vec<f32> {
    let (w, h) = (w as i32, h as i32);
    let color = px_at(src, (seed.1 as i32 * w + seed.0 as i32) as usize);
    let hard = hard_mask(src, w, h, color, tolerance, contiguous, (seed.0 as i32, seed.1 as i32));
    if antialias {
        soften_border(&hard, w, h)
    } else {
        hard.iter().map(|&v| v as f32).collect()
    }
}

// Per-channel min/max of the pixels `seeds` marks, used by grow/similar as a single widened
// tolerance band instead of testing every seed color individually (too slow per docs/M2.md).
fn seed_range(src: &[u8], seeds: &[bool]) -> ([u8; 4], [u8; 4]) {
    let mut lo = [255u8; 4];
    let mut hi = [0u8; 4];
    for (p, &is_seed) in seeds.iter().enumerate() {
        if !is_seed {
            continue;
        }
        let c = px_at(src, p);
        for i in 0..4 {
            lo[i] = lo[i].min(c[i]);
            hi[i] = hi[i].max(c[i]);
        }
    }
    (lo, hi)
}

fn in_range(c: [u8; 4], lo: [u8; 4], hi: [u8; 4], tol: u8) -> bool {
    (0..4).all(|i| c[i].saturating_add(tol) >= lo[i] && c[i] <= hi[i].saturating_add(tol))
}

/// Grow (contiguous) / similar (non-contiguous): pixels within `tolerance` of the seed colors'
/// per-channel range join the result, docs/M2.md magic wand family. `seeds` are the pixels
/// already selected (>= 0.5 coverage); the result is meant to be added to the selection.
pub fn grow_similar(src: &[u8], w: u32, h: u32, seeds: &[bool], tolerance: u8, contiguous: bool) -> Vec<f32> {
    let (w, h) = (w as i32, h as i32);
    let (lo, hi) = seed_range(src, seeds);
    let within = |p: usize| in_range(px_at(src, p), lo, hi, tolerance);
    if !contiguous {
        return (0..seeds.len()).map(|p| within(p) as u8 as f32).collect();
    }
    let mut out = vec![0u8; seeds.len()];
    let mut stack = Vec::new();
    for (p, &s) in seeds.iter().enumerate() {
        if s {
            out[p] = 1;
            stack.push((p as i32 % w, p as i32 / w));
        }
    }
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let idx = (ny * w + nx) as usize;
            if out[idx] == 0 && within(idx) {
                out[idx] = 1;
                stack.push((nx, ny));
            }
        }
    }
    out.iter().map(|&v| v as f32).collect()
}

// ---------- Select > Modify (docs/M2.md section 3) ----------

// One pass of the Felzenszwalb & Huttenlocher exact squared-distance transform along a line.
fn edt_1d(f: &[f64]) -> Vec<f64> {
    let n = f.len();
    let mut d = vec![0f64; n];
    let mut v = vec![0usize; n];
    let mut z = vec![0f64; n + 1];
    let mut k = 0usize;
    z[0] = f64::NEG_INFINITY;
    z[1] = f64::INFINITY;
    for q in 1..n {
        let mut s;
        loop {
            s = ((f[q] + (q * q) as f64) - (f[v[k]] + (v[k] * v[k]) as f64)) / (2.0 * (q as f64 - v[k] as f64));
            if s <= z[k] && k > 0 {
                k -= 1;
            } else {
                break;
            }
        }
        k += 1;
        v[k] = q;
        z[k] = s;
        z[k + 1] = f64::INFINITY;
    }
    k = 0;
    for (q, slot) in d.iter_mut().enumerate() {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let dx = q as f64 - v[k] as f64;
        *slot = dx * dx + f[v[k]];
    }
    d
}

// Squared Euclidean distance from every cell to the nearest cell where `inside` is true
// (columns then rows, per Felzenszwalb & Huttenlocher).
pub(crate) fn edt2(inside: &[bool], w: usize, h: usize) -> Vec<f64> {
    const INF: f64 = 1e20;
    let mut g = vec![0f64; w * h];
    for x in 0..w {
        let col: Vec<f64> = (0..h).map(|y| if inside[y * w + x] { 0.0 } else { INF }).collect();
        let d = edt_1d(&col);
        for y in 0..h {
            g[y * w + x] = d[y];
        }
    }
    let mut out = vec![0f64; w * h];
    for y in 0..h {
        let d = edt_1d(&g[y * w..y * w + w]);
        out[y * w..y * w + w].copy_from_slice(&d);
    }
    out
}

// A canvas sample extended past the edges: `apply_at_canvas_bounds` true treats the outside as
// unselected (0), so an edge selection erodes/grows like any interior edge; false clamps to the
// nearest canvas pixel, so a selection that already reaches the edge is not bordered by it.
fn hard_extended(mask: &[f32], w: i32, h: i32, x: i32, y: i32, apply_at_canvas_bounds: bool) -> bool {
    if apply_at_canvas_bounds {
        if x < 0 || y < 0 || x >= w || y >= h {
            return false;
        }
        mask[(y * w + x) as usize] >= 0.5
    } else {
        let (cx, cy) = (x.clamp(0, w - 1), y.clamp(0, h - 1));
        mask[(cy * w + cx) as usize] >= 0.5
    }
}

/// Dilates the selection by `r` pixels (circular structuring element, via the exact distance
/// transform thresholded at 0.5); result is hard 0/1.
pub fn expand(mask: &[f32], w: u32, h: u32, r: f32, apply_at_canvas_bounds: bool) -> Vec<f32> {
    let (w, h) = (w as i32, h as i32);
    let pad = r.ceil().max(0.0) as i32 + 1;
    let (pw, ph) = ((w + 2 * pad) as usize, (h + 2 * pad) as usize);
    let mut inside = vec![false; pw * ph];
    for py in 0..ph as i32 {
        for px in 0..pw as i32 {
            inside[(py * pw as i32 + px) as usize] = hard_extended(mask, w, h, px - pad, py - pad, apply_at_canvas_bounds);
        }
    }
    let dist2 = edt2(&inside, pw, ph);
    let r2 = (r as f64) * (r as f64);
    let mut out = vec![0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let p = ((y + pad) as usize) * pw + (x + pad) as usize;
            out[(y * w + x) as usize] = if inside[p] || dist2[p] <= r2 { 1.0 } else { 0.0 };
        }
    }
    out
}

/// Erodes the selection by `r` pixels: the inverse distance transform (distance to the nearest
/// unselected cell) thresholded at `r`; result is hard 0/1.
pub fn contract(mask: &[f32], w: u32, h: u32, r: f32, apply_at_canvas_bounds: bool) -> Vec<f32> {
    let (w, h) = (w as i32, h as i32);
    let pad = r.ceil().max(0.0) as i32 + 1;
    let (pw, ph) = ((w + 2 * pad) as usize, (h + 2 * pad) as usize);
    let mut background = vec![false; pw * ph];
    for py in 0..ph as i32 {
        for px in 0..pw as i32 {
            background[(py * pw as i32 + px) as usize] =
                !hard_extended(mask, w, h, px - pad, py - pad, apply_at_canvas_bounds);
        }
    }
    let dist2 = edt2(&background, pw, ph);
    let r2 = (r as f64) * (r as f64);
    let mut out = vec![0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let p = ((y + pad) as usize) * pw + (x + pad) as usize;
            out[(y * w + x) as usize] = if !background[p] && dist2[p] > r2 { 1.0 } else { 0.0 };
        }
    }
    out
}

/// Soft (1-px antialiased) expand for the stroke ring (B6 spec v1 Part E2): same padding and exact
/// EDT as `expand`, but the threshold is a `clamp(r + 0.5 - d, 0, 1)` ramp instead of a hard cut.
/// `r <= 0` is the identity (expanding by nothing is no change), not a half-pixel erosion of `mask`
/// itself: the stroke ring's `center` formula at width 1 relies on `E(1) - C(0) == E(1) - mask`.
pub fn expand_soft(mask: &[f32], w: u32, h: u32, r: f32, apply_at_canvas_bounds: bool) -> Vec<f32> {
    if r <= 0.0 {
        return mask.to_vec();
    }
    let (w, h) = (w as i32, h as i32);
    let pad = r.ceil().max(0.0) as i32 + 2;
    let (pw, ph) = ((w + 2 * pad) as usize, (h + 2 * pad) as usize);
    let mut inside = vec![false; pw * ph];
    for py in 0..ph as i32 {
        for px in 0..pw as i32 {
            inside[(py * pw as i32 + px) as usize] = hard_extended(mask, w, h, px - pad, py - pad, apply_at_canvas_bounds);
        }
    }
    let dist2 = edt2(&inside, pw, ph);
    let mut out = vec![0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let p = ((y + pad) as usize) * pw + (x + pad) as usize;
            let d = dist2[p].max(0.0).sqrt() as f32;
            out[(y * w + x) as usize] = (r + 0.5 - d).clamp(0.0, 1.0);
        }
    }
    out
}

/// Soft (1-px antialiased) contract for the stroke ring (B6 spec v1 Part E2): the inverse distance
/// transform (to the nearest cell with `S < 0.5`), `1 - clamp(r + 0.5 - d_out, 0, 1)`. `r <= 0` is
/// the identity, for the same reason as `expand_soft`.
pub fn contract_soft(mask: &[f32], w: u32, h: u32, r: f32, apply_at_canvas_bounds: bool) -> Vec<f32> {
    if r <= 0.0 {
        return mask.to_vec();
    }
    let (w, h) = (w as i32, h as i32);
    let pad = r.ceil().max(0.0) as i32 + 2;
    let (pw, ph) = ((w + 2 * pad) as usize, (h + 2 * pad) as usize);
    let mut background = vec![false; pw * ph];
    for py in 0..ph as i32 {
        for px in 0..pw as i32 {
            background[(py * pw as i32 + px) as usize] =
                !hard_extended(mask, w, h, px - pad, py - pad, apply_at_canvas_bounds);
        }
    }
    let dist2 = edt2(&background, pw, ph);
    let mut out = vec![0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let p = ((y + pad) as usize) * pw + (x + pad) as usize;
            let d = dist2[p].max(0.0).sqrt() as f32;
            out[(y * w + x) as usize] = 1.0 - (r + 0.5 - d).clamp(0.0, 1.0);
        }
    }
    out
}

// 3x3 box average with the canvas edge clamped (no falloff invented at the canvas border); the
// 1-pixel feather of `border` and of quick selection's auto enhance.
pub fn feather1(mask: &[f32], w: usize, h: usize) -> Vec<f32> {
    let at = |x: i32, y: i32| -> f32 { mask[y.clamp(0, h as i32 - 1) as usize * w + x.clamp(0, w as i32 - 1) as usize] };
    let mut out = vec![0f32; w * h];
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let mut sum = 0.0;
            for dy in -1..=1 {
                for dx in -1..=1 {
                    sum += at(x + dx, y + dy);
                }
            }
            out[y as usize * w + x as usize] = sum / 9.0;
        }
    }
    out
}

/// A soft band of width `r` centered on the selection edge: `expand(r/2) - contract(r/2)`, then a
/// 1-pixel feather.
pub fn border(mask: &[f32], w: u32, h: u32, r: f32, apply_at_canvas_bounds: bool) -> Vec<f32> {
    let half = r / 2.0;
    let e = expand(mask, w, h, half, apply_at_canvas_bounds);
    let c = contract(mask, w, h, half, apply_at_canvas_bounds);
    let band: Vec<f32> = e.iter().zip(&c).map(|(&e, &c)| e - c).collect();
    feather1(&band, w as usize, h as usize)
}

/// Rounds off the selection: each pixel becomes selected when at least half of its
/// `(2r+1)x(2r+1)` window (of the thresholded mask) is selected; window sums via a summed-area table.
pub fn smooth(mask: &[f32], w: u32, h: u32, r: u32, apply_at_canvas_bounds: bool) -> Vec<f32> {
    let (w, h, r) = (w as i32, h as i32, r as i32);
    let (pw, ph) = ((w + 2 * r) as usize, (h + 2 * r) as usize);
    // sat[(y + 1) * (pw + 1) + x + 1] = selected cells in the padded rows 0..=y, columns 0..=x.
    let mut sat = vec![0u64; (pw + 1) * (ph + 1)];
    for py in 0..ph {
        let mut row = 0u64;
        for px in 0..pw {
            row += hard_extended(mask, w, h, px as i32 - r, py as i32 - r, apply_at_canvas_bounds) as u64;
            sat[(py + 1) * (pw + 1) + px + 1] = sat[py * (pw + 1) + px + 1] + row;
        }
    }
    let win = ((2 * r + 1) * (2 * r + 1)) as u64;
    let side = (2 * r + 1) as usize;
    let mut out = vec![0f32; (w * h) as usize];
    for y in 0..h as usize {
        for x in 0..w as usize {
            let at = |yy: usize, xx: usize| sat[yy * (pw + 1) + xx];
            let sum = at(y + side, x + side) + at(y, x) - at(y, x + side) - at(y + side, x);
            out[y * w as usize + x] = if sum * 2 >= win { 1.0 } else { 0.0 };
        }
    }
    out
}

// ---------- Color Range (docs/M2.md section 3) ----------

use crate::gradient::srgb_to_linear;

// sRGB (D65) to CIE Lab, used only to measure a perceptual color distance.
fn rgb_to_lab(rgb: [u8; 3]) -> [f32; 3] {
    let (r, g, b) =
        (srgb_to_linear(rgb[0] as f32 / 255.0), srgb_to_linear(rgb[1] as f32 / 255.0), srgb_to_linear(rgb[2] as f32 / 255.0));
    let x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
    let y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750;
    let z = (r * 0.0193339 + g * 0.1191920 + b * 0.9503041) / 1.08883;
    let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn lab_dist(a: [f32; 3], b: [f32; 3]) -> f32 {
    ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
}

fn luminance01(rgb: [u8; 3]) -> f32 {
    (0.3 * rgb[0] as f32 + 0.59 * rgb[1] as f32 + 0.11 * rgb[2] as f32) / 255.0
}

// HSL hue (0..360 degrees) and saturation (0..1) of an sRGB color.
fn hue_sat(rgb: [u8; 3]) -> (f32, f32) {
    let (r, g, b) = (rgb[0] as f32 / 255.0, rgb[1] as f32 / 255.0, rgb[2] as f32 / 255.0);
    let (maxc, minc) = (r.max(g).max(b), r.min(g).min(b));
    let d = maxc - minc;
    if d <= 1e-6 {
        return (0.0, 0.0);
    }
    let l = (maxc + minc) / 2.0;
    let s = if l > 0.5 { d / (2.0 - maxc - minc) } else { d / (maxc + minc) };
    let h = if maxc == r {
        60.0 * (((g - b) / d).rem_euclid(6.0))
    } else if maxc == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h.rem_euclid(360.0), s)
}

/// Color range (docs/M2.md section 3): coverage of one preset over an RGBA8 image.
/// - "sampled": `1 - (Lab distance to the nearest sample) / fuzziness`.
/// - "reds"/"yellows"/"greens"/"cyans"/"blues"/"magentas": a 60 degree hue sector (0/60/120/180/
///   240/300) with a soft 15 degree ramp on each side, weighted by saturation.
/// - "highlights"/"midtones"/"shadows": luminance bands (> 0.75, 0.25..0.75, < 0.25) with 0.1
///   soft ramps.
/// - "skin tones": a fixed Lab ellipse (center L=70, a=15, b=40; radii 35, 25, 30 — a rough
///   light-to-tan skin range, not calibrated against a corpus).
/// `localized` multiplies by a linear spatial falloff from the nearest `center` point, reaching 0
/// at `range` percent of the document diagonal.
#[allow(clippy::too_many_arguments)]
pub fn color_range(
    src: &[u8],
    w: u32,
    h: u32,
    preset: &str,
    samples: &[[u8; 3]],
    fuzziness: u8,
    range: u8,
    center: &[(f64, f64)],
    localized: bool,
    invert: bool,
) -> Result<Vec<f32>, String> {
    let (wu, hu) = (w as usize, h as usize);
    let n = wu * hu;
    let rgb_at = |p: usize| -> [u8; 3] { [src[p * 4], src[p * 4 + 1], src[p * 4 + 2]] };
    let mut out = vec![0f32; n];
    let hue_center = match preset {
        "reds" => Some(0.0),
        "yellows" => Some(60.0),
        "greens" => Some(120.0),
        "cyans" => Some(180.0),
        "blues" => Some(240.0),
        "magentas" => Some(300.0),
        _ => None,
    };
    if preset == "sampled" {
        if samples.is_empty() {
            return Err("sampled color range needs at least one sample".into());
        }
        let labs: Vec<[f32; 3]> = samples.iter().map(|&s| rgb_to_lab(s)).collect();
        let fuzz = (fuzziness as f32).max(1.0);
        for (p, slot) in out.iter_mut().enumerate() {
            let dist = labs.iter().map(|&s| lab_dist(rgb_to_lab(rgb_at(p)), s)).fold(f32::INFINITY, f32::min);
            *slot = (1.0 - dist / fuzz).clamp(0.0, 1.0);
        }
    } else if let Some(hc) = hue_center {
        for (p, slot) in out.iter_mut().enumerate() {
            let (hue, sat) = hue_sat(rgb_at(p));
            let raw = (hue - hc).abs();
            let d = raw.min(360.0 - raw);
            let t = if d <= 15.0 { 1.0 } else if d >= 45.0 { 0.0 } else { 1.0 - (d - 15.0) / 30.0 };
            *slot = t * sat;
        }
    } else if matches!(preset, "highlights" | "midtones" | "shadows") {
        for (p, slot) in out.iter_mut().enumerate() {
            let l = luminance01(rgb_at(p));
            let hi = ((l - 0.65) / 0.1).clamp(0.0, 1.0);
            let sh = ((0.35 - l) / 0.1).clamp(0.0, 1.0);
            *slot = match preset {
                "highlights" => hi,
                "shadows" => sh,
                _ => (1.0 - hi - sh).clamp(0.0, 1.0),
            };
        }
    } else if preset == "skin tones" {
        let (center_lab, radii) = ([70.0, 15.0, 40.0], [35.0, 25.0, 30.0]);
        for (p, slot) in out.iter_mut().enumerate() {
            let lab = rgb_to_lab(rgb_at(p));
            let d = (0..3).map(|i| ((lab[i] - center_lab[i]) / radii[i]).powi(2)).sum::<f32>().sqrt();
            *slot = (1.0 - d).clamp(0.0, 1.0);
        }
    } else {
        return Err(format!("unknown color range preset {preset}"));
    }
    if localized {
        if center.is_empty() {
            return Err("localized color range needs at least one center point".into());
        }
        let diag = ((w * w + h * h) as f64).sqrt();
        let reach = (range as f64 / 100.0 * diag).max(1e-6);
        for y in 0..hu {
            for x in 0..wu {
                let d = center
                    .iter()
                    .map(|&(cx, cy)| ((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)).sqrt())
                    .fold(f64::INFINITY, f64::min);
                out[y * wu + x] *= (1.0 - d / reach).clamp(0.0, 1.0) as f32;
            }
        }
    }
    if invert {
        for v in out.iter_mut() {
            *v = 1.0 - *v;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 8x8 fixture: left half red (255,0,0,255), right half blue (0,0,255,255).
    fn two_regions() -> Vec<u8> {
        let mut buf = vec![0u8; 8 * 8 * 4];
        for y in 0..8 {
            for x in 0..8 {
                let o = (y * 8 + x) * 4;
                let c: [u8; 4] = if x < 4 { [255, 0, 0, 255] } else { [0, 0, 255, 255] };
                buf[o..o + 4].copy_from_slice(&c);
            }
        }
        buf
    }

    #[test]
    fn contiguous_flood_selects_only_the_seed_region() {
        let buf = two_regions();
        let cov = flood(&buf, 8, 8, (0, 0), 32, true, false);
        for y in 0..8 {
            for x in 0..8 {
                assert_eq!(cov[y * 8 + x], if x < 4 { 1.0 } else { 0.0 }, "x={x} y={y}");
            }
        }
    }

    #[test]
    fn non_contiguous_flood_needs_no_shared_border() {
        // A red pixel disconnected from the seed region still joins when non-contiguous.
        let mut buf = two_regions();
        let o = (0 * 8 + 7) * 4;
        buf[o..o + 4].copy_from_slice(&[255, 0, 0, 255]);
        let contiguous = flood(&buf, 8, 8, (0, 0), 32, true, false);
        assert_eq!(contiguous[7], 0.0, "the stray red pixel is not 4-connected to the seed");
        let non_contiguous = flood(&buf, 8, 8, (0, 0), 32, false, false);
        assert_eq!(non_contiguous[7], 1.0, "non-contiguous ignores connectivity");
    }

    #[test]
    fn tolerance_edge_cases_0_and_255() {
        let buf = two_regions();
        // Tolerance 0: only exact matches to the seed color.
        let cov0 = flood(&buf, 8, 8, (0, 0), 0, false, false);
        assert_eq!(cov0.iter().filter(|&&v| v > 0.0).count(), 32, "exactly the red half");
        // Tolerance 255: everything within reach, i.e. the whole image.
        let cov255 = flood(&buf, 8, 8, (0, 0), 255, false, false);
        assert!(cov255.iter().all(|&v| v == 1.0));
    }

    #[test]
    fn antialias_softens_only_the_border() {
        let buf = two_regions();
        let cov = flood(&buf, 8, 8, (0, 0), 32, true, true);
        // Interior of the red region stays hard 1.
        assert_eq!(cov[1 * 8 + 1], 1.0);
        // The border column (x=3, next to the blue region) gets partial coverage: a 3x3 box of
        // an 8-wide hard edge at x=3/4 has 6 of 9 cells inside (excluding the top/bottom rows'
        // out-of-canvas neighbours only at y=0/7).
        assert!(cov[3 * 8 + 3] > 0.0 && cov[3 * 8 + 3] < 1.0, "{}", cov[3 * 8 + 3]);
        assert_eq!(cov[3 * 8 + 7], 0.0, "far side of the blue region stays hard 0");
    }

    #[test]
    fn grow_widens_by_the_seed_colors_range_contiguous() {
        // Three vertical stripes: 0, 40, 200 (channel R only, G=B=A fixed).
        let w = 6u32;
        let mut buf = vec![0u8; (w * 1 * 4) as usize];
        let vals = [0u8, 0, 40, 40, 200, 200];
        for (x, v) in vals.iter().enumerate() {
            let o = x * 4;
            buf[o..o + 4].copy_from_slice(&[*v, 0, 0, 255]);
        }
        let mut seeds = vec![false; 6];
        seeds[0] = true; // seed color 0
        let cov = grow_similar(&buf, w, 1, &seeds, 40, true);
        // Range is [0,0] widened by 40 -> [0,40], reaching x=2,3 (value 40) but not x=4,5 (200).
        assert_eq!(cov, vec![1.0, 1.0, 1.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn similar_ignores_connectivity() {
        let w = 4u32;
        let buf: Vec<u8> = [0u8, 0, 0, 255, 200, 0, 0, 255, 0, 0, 0, 255, 200, 0, 0, 255].to_vec();
        let seeds = vec![true, false, false, false];
        let cov = grow_similar(&buf, w, 1, &seeds, 0, false);
        assert_eq!(cov, vec![1.0, 0.0, 1.0, 0.0], "the disconnected matching pixel still joins");
    }

    // ---------- B3 E2: Select > Modify ----------

    #[test]
    fn expand_grows_a_single_pixel_circularly() {
        let mut mask = vec![0f32; 9 * 9];
        mask[4 * 9 + 4] = 1.0;
        let out = expand(&mask, 9, 9, 2.0, true);
        assert_eq!(out[4 * 9 + 4], 1.0);
        assert_eq!(out[6 * 9 + 4], 1.0, "distance 2, exactly at the radius");
        assert_eq!(out[7 * 9 + 4], 0.0, "distance 3, past the radius");
        assert_eq!(out[5 * 9 + 5], 1.0, "distance sqrt(2), inside the circle");
        assert_eq!(out[6 * 9 + 6], 0.0, "distance 2*sqrt(2), outside the circle");
    }

    #[test]
    fn contract_erodes_and_apply_at_canvas_bounds_controls_the_edge() {
        let mask = vec![1f32; 7 * 7];
        let eroded = contract(&mask, 7, 7, 1.0, true);
        assert_eq!(eroded[0], 0.0, "the canvas edge counts as background and erodes");
        assert_eq!(eroded[3 * 7 + 3], 1.0, "the interior survives");
        let kept = contract(&mask, 7, 7, 1.0, false);
        assert!(kept.iter().all(|&v| v == 1.0), "edges do not shrink when the canvas bound doesn't apply");
    }

    // ---------- B6 E: Stroke ring E(r)/C(r) ----------

    #[test]
    fn expand_soft_is_a_one_pixel_aa_ramp_at_the_radius() {
        let mut mask = vec![0f32; 9 * 9];
        mask[4 * 9 + 4] = 1.0;
        let out = expand_soft(&mask, 9, 9, 2.0, true);
        assert_eq!(out[4 * 9 + 4], 1.0, "distance 0: clamp(2.5-0)=1");
        assert!((out[6 * 9 + 4] - 0.5).abs() < 1e-6, "distance 2: clamp(2.5-2)=0.5");
        assert_eq!(out[7 * 9 + 4], 0.0, "distance 3: clamp(2.5-3,0,1)=0");
        assert!((out[5 * 9 + 4] - 1.0).abs() < 1e-6, "distance 1: clamp(2.5-1,0,1)=1");
    }

    #[test]
    fn contract_soft_erodes_and_replicates_the_edge() {
        let mask = vec![1f32; 7 * 7];
        // apply_at_canvas_bounds = true: the canvas edge counts as background, so it erodes.
        let eroded = contract_soft(&mask, 7, 7, 1.0, true);
        assert!((eroded[0] - 0.5).abs() < 1e-6, "corner, distance 1 to the background: 1-clamp(1.5-1,0,1)=0.5");
        assert!((eroded[1] - 0.5).abs() < 1e-6, "distance 1 straight up to the background: 1-clamp(1.5-1,0,1)=0.5");
        assert_eq!(eroded[3 * 7 + 3], 1.0, "far interior: no background within reach, stays 1");
        // apply_at_canvas_bounds = false: edge replication means no background exists at all.
        let kept = contract_soft(&mask, 7, 7, 1.0, false);
        assert!(kept.iter().all(|&v| v == 1.0), "no unselected pixel anywhere, so nothing erodes");
    }

    #[test]
    fn expand_soft_and_contract_soft_are_the_identity_at_radius_zero() {
        // A non-0/1 value at 0.7 checks this returns the original soft mask, not a re-thresholded one.
        let mask = vec![0.0, 0.7, 1.0, 0.0];
        assert_eq!(expand_soft(&mask, 2, 2, 0.0, true), mask);
        assert_eq!(contract_soft(&mask, 2, 2, 0.0, true), mask);
        assert_eq!(expand_soft(&mask, 2, 2, -1.0, true), mask, "a negative radius is also the identity");
    }

    #[test]
    fn border_is_a_soft_band_at_the_selection_edge() {
        let mask = vec![1f32; 7 * 7];
        let band = border(&mask, 7, 7, 2.0, true);
        assert!(band[0] > 0.0, "the edge is on the band");
        assert_eq!(band[3 * 7 + 3], 0.0, "the far interior is not");
    }

    #[test]
    fn smooth_removes_a_speck_and_fills_a_pinhole() {
        let mut speck = vec![0f32; 5 * 5];
        speck[2 * 5 + 2] = 1.0;
        assert_eq!(smooth(&speck, 5, 5, 1, true)[2 * 5 + 2], 0.0, "an isolated pixel is a minority");
        let mut hole = vec![1f32; 5 * 5];
        hole[2 * 5 + 2] = 0.0;
        assert_eq!(smooth(&hole, 5, 5, 1, true)[2 * 5 + 2], 1.0, "a lone hole is a minority");
    }

    #[test]
    fn edt_1d_matches_brute_force_on_a_long_line() {
        let n = 9000;
        let f: Vec<f64> = (0..n).map(|i| ((i * 7919) % 97) as f64).collect();
        let d = edt_1d(&f);
        for q in (0..n).step_by(7) {
            let want = (0..n).map(|i| (q as f64 - i as f64).powi(2) + f[i]).fold(f64::INFINITY, f64::min);
            assert_eq!(d[q], want, "q = {q}");
        }
    }

    #[test]
    fn smooth_matches_the_window_rule_and_scales_to_a_large_radius() {
        let (w, h) = (23u32, 17u32);
        let mask: Vec<f32> = (0..w * h).map(|i| ((i * 31 + i / 7) % 5 < 2) as u8 as f32).collect();
        for bounds in [true, false] {
            let out = smooth(&mask, w, h, 3, bounds);
            for y in 0..h as i32 {
                for x in 0..w as i32 {
                    let mut sum = 0;
                    for dy in -3..=3 {
                        for dx in -3..=3 {
                            sum += hard_extended(&mask, w as i32, h as i32, x + dx, y + dy, bounds) as u32;
                        }
                    }
                    assert_eq!(out[(y * w as i32 + x) as usize], (sum * 2 >= 49) as u8 as f32, "({x},{y}) bounds={bounds}");
                }
            }
        }
        let big = vec![1f32; 2000 * 2000];
        assert_eq!(smooth(&big, 2000, 2000, 200, true)[1000 * 2000 + 1000], 1.0);
    }

    // ---------- B3 E2: Color Range ----------

    fn rgba_row(colors: &[[u8; 3]]) -> Vec<u8> {
        colors.iter().flat_map(|c| [c[0], c[1], c[2], 255]).collect()
    }

    #[test]
    fn sampled_falls_off_with_lab_distance_and_invert_flips_it() {
        let buf = rgba_row(&[[255, 0, 0], [0, 0, 255]]);
        let cov = color_range(&buf, 2, 1, "sampled", &[[255, 0, 0]], 50, 0, &[], false, false).unwrap();
        assert_eq!(cov[0], 1.0, "an exact match is fully covered");
        assert_eq!(cov[1], 0.0, "red to blue is far past the fuzziness");
        let inv = color_range(&buf, 2, 1, "sampled", &[[255, 0, 0]], 50, 0, &[], false, true).unwrap();
        assert_eq!(inv[0], 0.0);
        assert_eq!(inv[1], 1.0);
        assert!(color_range(&buf, 2, 1, "sampled", &[], 50, 0, &[], false, false).is_err());
    }

    #[test]
    fn hue_presets_pick_out_their_sector_weighted_by_saturation() {
        let buf = rgba_row(&[[255, 0, 0], [255, 255, 0], [0, 255, 255]]);
        let cov = color_range(&buf, 3, 1, "reds", &[], 0, 0, &[], false, false).unwrap();
        assert_eq!(cov[0], 1.0, "pure red is dead center of the reds sector, fully saturated");
        assert_eq!(cov[1], 0.0, "yellow is 60 degrees away, past the ramp");
        assert_eq!(cov[2], 0.0, "cyan is the opposite hue");
    }

    #[test]
    fn luminance_bands_split_shadows_midtones_and_highlights() {
        let buf = rgba_row(&[[0, 0, 0], [128, 128, 128], [255, 255, 255]]);
        let shadows = color_range(&buf, 3, 1, "shadows", &[], 0, 0, &[], false, false).unwrap();
        let highlights = color_range(&buf, 3, 1, "highlights", &[], 0, 0, &[], false, false).unwrap();
        assert_eq!(shadows[0], 1.0, "black is a shadow");
        assert_eq!(shadows[2], 0.0);
        assert_eq!(highlights[2], 1.0, "white is a highlight");
        assert_eq!(highlights[0], 0.0);
    }

    #[test]
    fn skin_tones_prefers_skin_over_saturated_blue() {
        let buf = rgba_row(&[[224, 172, 105], [0, 0, 255]]);
        let cov = color_range(&buf, 2, 1, "skin tones", &[], 0, 0, &[], false, false).unwrap();
        assert!(cov[0] > 0.3, "a typical skin tone scores well: {}", cov[0]);
        assert_eq!(cov[1], 0.0, "saturated blue is far outside the ellipse");
    }

    #[test]
    fn localized_adds_a_spatial_falloff_from_the_nearest_center() {
        let buf = rgba_row(&[[255, 0, 0]; 10]);
        let cov = color_range(&buf, 10, 1, "sampled", &[[255, 0, 0]], 50, 20, &[(0.0, 0.0)], true, false).unwrap();
        assert_eq!(cov[0], 1.0, "at the center, full coverage");
        assert_eq!(cov[9], 0.0, "far from the center, the falloff zeroes it out");
        assert!(color_range(&buf, 10, 1, "sampled", &[[255, 0, 0]], 50, 20, &[], true, false).is_err());
    }

    #[test]
    fn unknown_preset_is_rejected() {
        let buf = rgba_row(&[[255, 0, 0]]);
        assert!(color_range(&buf, 1, 1, "nonsense", &[], 0, 0, &[], false, false).is_err());
    }
}
