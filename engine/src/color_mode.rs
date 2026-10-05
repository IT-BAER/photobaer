//! Image > Mode beyond RGB and Grayscale. Pixels stay RGBA: Bitmap and Duotone keep gray pixels,
//! and Bitmap, Duotone and Indexed Color map the composite when it is displayed or exported.

use super::*;
use super::canvas::At;
use crate::resample::Interp;
use filters::Plane;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The document's color mode when it is not RGB or plain Grayscale.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ColorMode {
    Bitmap,
    /// 1 to 4 inks; each lays its color over white by the gray's density through its curve.
    /// Empty `curves` are linear and empty `overprints` multiply the inks.
    Duotone {
        inks: Vec<[u8; 3]>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        curves: Vec<InkCurve>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        overprints: Vec<[u8; 3]>,
    },
    /// 1 to 256 colors; every displayed pixel shows the nearest one.
    Indexed { table: Vec<[u8; 3]> },
    Cmyk,
    Lab,
    Multichannel,
}

impl ColorMode {
    pub fn check(&self) -> Result<(), String> {
        match self {
            ColorMode::Duotone { inks, .. } if !(1..=4).contains(&inks.len()) => Err("duotone needs 1 to 4 inks".into()),
            ColorMode::Duotone { inks, curves, overprints } => {
                if !curves.is_empty() && curves.len() != inks.len() {
                    return Err(format!("{} inks need {} curves, got {}", inks.len(), inks.len(), curves.len()));
                }
                if curves.iter().flatten().flatten().any(|v| !(0.0..=100.0).contains(v)) {
                    return Err("ink curve values are 0 to 100 %".into());
                }
                let n = overprint_sets(inks.len()).len();
                if !overprints.is_empty() && overprints.len() != n {
                    return Err(format!("{} inks need {n} overprint colors, got {}", inks.len(), overprints.len()));
                }
                Ok(())
            }
            ColorMode::Indexed { table } if !(1..=256).contains(&table.len()) => Err("a color table holds 1 to 256 colors".into()),
            _ => Ok(()),
        }
    }
}

/// Bitmap screening; JSON tag `method`.
#[derive(Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "method", rename_all = "snake_case")]
pub enum BitmapMethod {
    Threshold,
    Pattern,
    Diffusion,
    /// `frequency` 1..=999 lines per `unit`, `angle` -180..=180 degrees.
    Halftone {
        frequency: f64,
        #[serde(default)]
        unit: LineUnit,
        angle: f64,
        shape: Shape,
    },
    /// A document pattern's luminance, tiled from the origin, is the threshold map.
    Custom {
        pattern: String,
    },
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum LineUnit {
    #[default]
    Inch,
    Cm,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Shape {
    Round,
    Ellipse,
    Line,
    Square,
    Cross,
    Diamond,
}

impl Shape {
    // PostScript-style spot function over cell coords u, v in -1..1; high values turn black first.
    fn spot(self, u: f64, v: f64) -> f64 {
        let (a, b) = (u.abs(), v.abs());
        match self {
            Shape::Round => 1.0 - (u * u + v * v) / 2.0,
            Shape::Ellipse => 1.0 - (u * u + v * v / 0.5625) / (1.0 + 1.0 / 0.5625),
            Shape::Line => 1.0 - b,
            Shape::Square => 1.0 - a.max(b),
            Shape::Cross => 1.0 - a.min(b),
            Shape::Diamond => 1.0 - (a + b) / 2.0,
        }
    }
}

// Halftone threshold in 0..1 at pixel (x, y): the rank of the pixel's spot value among the
// spot values of a finely sampled cell, so gray g leaves a 1 - g black share.
struct Screen {
    shape: Shape,
    cell: f64,
    cos: f64,
    sin: f64,
    ranks: Vec<f64>,
}

impl Screen {
    const N: usize = 128;

    fn new(shape: Shape, cell: f64, angle: f64) -> Screen {
        let n = Screen::N;
        let at = |i: usize| (i as f64 + 0.5) / n as f64 * 2.0 - 1.0;
        let mut ranks: Vec<f64> = (0..n * n).map(|i| shape.spot(at(i % n), at(i / n))).collect();
        ranks.sort_unstable_by(f64::total_cmp);
        let (sin, cos) = angle.to_radians().sin_cos();
        Screen { shape, cell, cos, sin, ranks }
    }

    fn threshold(&self, x: i32, y: i32) -> f32 {
        let (px, py) = (x as f64 + 0.5, y as f64 + 0.5);
        let local = |t: f64| (t / self.cell).rem_euclid(1.0) * 2.0 - 1.0;
        let s = self.shape.spot(local(px * self.cos + py * self.sin), local(py * self.cos - px * self.sin));
        let lo = self.ranks.partition_point(|&r| r < s);
        let hi = self.ranks.partition_point(|&r| r <= s);
        let n = self.ranks.len() as f64;
        (((lo + hi) as f64 / 2.0).clamp(0.5, n - 0.5) / n) as f32
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Palette {
    Exact,
    Uniform,
    Web,
    Adaptive,
    /// The spec's `table` as given.
    Custom,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug, Default)]
#[serde(rename_all = "snake_case")]
pub enum Forced {
    #[default]
    None,
    BlackWhite,
    Primaries,
    Web,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Dither {
    None,
    Diffusion,
    Pattern,
    Noise,
}

/// An Image > Mode target with its dialog options.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ModeSpec {
    Rgb,
    Gray,
    /// `resolution`: output ppi; absent keeps the document's.
    Bitmap {
        #[serde(flatten)]
        method: BitmapMethod,
        #[serde(default)]
        resolution: Option<f64>,
    },
    Duotone {
        inks: Vec<[u8; 3]>,
        #[serde(default)]
        curves: Vec<InkCurve>,
        #[serde(default)]
        overprints: Vec<[u8; 3]>,
    },
    /// `amount` in 0..=1 scales diffusion, pattern and noise dither; `table` is the Custom palette;
    /// `matte` fills partly transparent edges (all transparency without `transparency`).
    Indexed {
        palette: Palette,
        #[serde(default)]
        table: Vec<[u8; 3]>,
        colors: u32,
        #[serde(default)]
        forced: Forced,
        transparency: bool,
        dither: Dither,
        amount: f32,
        #[serde(default)]
        matte: Option<[u8; 3]>,
    },
    Cmyk,
    Lab,
    Multichannel,
}

// Rec. 601 luma, as Grayscale uses.
fn luma(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

/// Duotone Curve: output % at input ink 0, 5, 10, 20 ... 90, 95, 100 %; empty fields are skipped.
pub type InkCurve = [Option<f32>; 13];
pub const INK_CURVE_INPUTS: [f32; 13] = [0.0, 5.0, 10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 95.0, 100.0];
pub const IDENTITY_CURVE: InkCurve = [Some(0.0), None, None, None, None, None, None, None, None, None, None, None, Some(100.0)];

/// Ink bit masks of the overprint colors: by ink count, then in order (1+2, 1+3, 2+3, 1+2+3).
pub fn overprint_sets(n: usize) -> Vec<u32> {
    let bits = |m: u32| (0..n).filter(move |i| m & (1 << i) != 0);
    let mut v: Vec<u32> = (0..1u32 << n).filter(|m| m.count_ones() >= 2).collect();
    v.sort_by_key(|&m| (m.count_ones(), bits(m).collect::<Vec<_>>()));
    v
}

// Ink fraction 0..1 printed at ink fraction `x`: a monotone cubic (Fritsch-Carlson PCHIP) through
// the set points; an empty end point keeps its identity value.
fn ink_curve(c: &InkCurve, x: f32) -> f32 {
    let x = x.clamp(0.0, 1.0) * 100.0;
    let at = |i: usize| c[i].or(match i {
        0 => Some(0.0),
        12 => Some(100.0),
        _ => None,
    });
    let pts: Vec<(f32, f32)> = (0..13).filter_map(|i| at(i).map(|v| (INK_CURVE_INPUTS[i], v))).collect();
    let n = pts.len();
    let h: Vec<f32> = pts.windows(2).map(|w| w[1].0 - w[0].0).collect();
    let d: Vec<f32> = pts.windows(2).map(|w| (w[1].1 - w[0].1) / (w[1].0 - w[0].0)).collect();
    // End slopes by the three-point formula, kept to the secant's sign; inner ones by the weighted harmonic mean.
    let end = |h0: f32, h1: f32, d0: f32, d1: f32| {
        let m = ((2.0 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
        if m * d0 <= 0.0 { 0.0 } else if d0 * d1 < 0.0 && m.abs() > 3.0 * d0.abs() { 3.0 * d0 } else { m }
    };
    let m: Vec<f32> = (0..n)
        .map(|i| match i {
            _ if n == 2 => d[0],
            0 => end(h[0], h[1], d[0], d[1]),
            _ if i == n - 1 => end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]),
            _ if d[i - 1] * d[i] <= 0.0 => 0.0,
            _ => {
                let (w1, w2) = (2.0 * h[i] + h[i - 1], h[i] + 2.0 * h[i - 1]);
                (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
            }
        })
        .collect();
    let k = pts.partition_point(|p| p.0 < x).clamp(1, n - 1);
    let ((x0, y0), (x1, y1)) = (pts[k - 1], pts[k]);
    let (hk, t) = (x1 - x0, (x - x0) / (x1 - x0));
    let (t2, t3) = (t * t, t * t * t);
    let y = (2.0 * t3 - 3.0 * t2 + 1.0) * y0 + (t3 - 2.0 * t2 + t) * hk * m[k - 1] + (-2.0 * t3 + 3.0 * t2) * y1 + (t3 - t2) * hk * m[k];
    (y / 100.0).clamp(0.0, 1.0)
}

/// A Duotone document's display: each ink's density through its curve, then n-linear
/// interpolation between white, the inks and the overprint colors.
pub struct DuotoneMap {
    curves: Vec<InkCurve>,
    // Color per ink bit mask.
    corners: Vec<[f32; 3]>,
}

impl DuotoneMap {
    pub fn new(inks: &[[u8; 3]], curves: &[InkCurve], overprints: &[[u8; 3]]) -> DuotoneMap {
        let n = inks.len();
        let unit = |c: &[u8; 3]| c.map(|v| v as f32 / 255.0);
        let mut corners = vec![[1.0f32; 3]; 1 << n];
        for (m, corner) in corners.iter_mut().enumerate() {
            for i in (0..n).filter(|i| m & (1 << i) != 0) {
                let c = unit(&inks[i]);
                (0..3).for_each(|k| corner[k] *= c[k]);
            }
        }
        for (m, c) in overprint_sets(n).into_iter().zip(overprints) {
            corners[m as usize] = unit(c);
        }
        let curves = if curves.len() == n { curves.to_vec() } else { vec![IDENTITY_CURVE; n] };
        DuotoneMap { curves, corners }
    }

    pub fn color(&self, g: f32) -> [f32; 3] {
        let d: Vec<f32> = self.curves.iter().map(|c| ink_curve(c, 1.0 - g)).collect();
        let mut out = [0.0f32; 3];
        for (m, corner) in self.corners.iter().enumerate() {
            let w: f32 = d.iter().enumerate().map(|(i, &d)| if m & (1 << i) != 0 { d } else { 1.0 - d }).product();
            (0..3).for_each(|k| out[k] += w * corner[k]);
        }
        out
    }
}

impl ColorMode {
    // Duotone with default curves and overprints left empty, so equal looks compare equal.
    fn duotone(inks: &[[u8; 3]], curves: &[InkCurve], overprints: &[[u8; 3]]) -> Result<ColorMode, String> {
        let products: Vec<[u8; 3]> = if overprints.is_empty() || inks.len() > 4 {
            vec![]
        } else {
            let map = DuotoneMap::new(inks, &[], &[]);
            overprint_sets(inks.len()).iter().map(|&m| map.corners[m as usize].map(|v| (v * 255.0).round() as u8)).collect()
        };
        ColorMode::Duotone { inks: inks.to_vec(), curves: curves.to_vec(), overprints: overprints.to_vec() }.check()?;
        Ok(ColorMode::Duotone {
            inks: inks.to_vec(),
            curves: if curves.iter().all(|c| *c == IDENTITY_CURVE) { vec![] } else { curves.to_vec() },
            overprints: if overprints == products { vec![] } else { overprints.to_vec() },
        })
    }
}

const BAYER8: [u8; 64] = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11, 43, 1,
    33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
];

// Ordered-dither threshold in 0..1 at (x, y).
fn bayer(x: i32, y: i32) -> f32 {
    (BAYER8[(y.rem_euclid(8) * 8 + x.rem_euclid(8)) as usize] as f32 + 0.5) / 64.0
}

// Hash noise in 0..1 at (x, y).
fn noise(x: i32, y: i32) -> f32 {
    let h = (x as u32).wrapping_mul(0x9E37_79B1) ^ (y as u32).wrapping_mul(0x85EB_CA77);
    let h = (h ^ (h >> 15)).wrapping_mul(0x2C1B_3C6D);
    (h >> 8) as f32 / (1u32 << 24) as f32
}

/// Nearest table color, cached by 8-bit RGB.
pub struct Nearest {
    table: Vec<[f32; 3]>,
    cache: HashMap<u32, usize>,
}

impl Nearest {
    pub fn new(table: &[[u8; 3]]) -> Nearest {
        Nearest { table: table.iter().map(|c| c.map(|v| v as f32 / 255.0)).collect(), cache: HashMap::new() }
    }

    pub fn index(&mut self, c: [f32; 3]) -> usize {
        let q = c.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u32);
        let key = q[0] << 16 | q[1] << 8 | q[2];
        let table = &self.table;
        *self.cache.entry(key).or_insert_with(|| {
            let c = q.map(|v| v as f32 / 255.0);
            let dist = |t: &[f32; 3]| (0..3).map(|i| (t[i] - c[i]) * (t[i] - c[i])).sum::<f32>();
            (0..table.len()).min_by(|&a, &b| dist(&table[a]).total_cmp(&dist(&table[b]))).expect("a table is never empty")
        })
    }

    pub fn pick(&mut self, c: [f32; 3]) -> [f32; 3] {
        let i = self.index(c);
        self.table[i]
    }
}

// Median cut over weighted 8-bit colors down to at most `n` colors.
fn median_cut(hist: &HashMap<u32, u32>, n: usize) -> Vec<[u8; 3]> {
    let rgb = |k: u32| [(k >> 16) as u8, (k >> 8) as u8, k as u8];
    let mut boxes: Vec<Vec<([u8; 3], u32)>> = vec![hist.iter().map(|(&k, &w)| (rgb(k), w)).collect()];
    boxes[0].sort_unstable_by_key(|e| e.0);
    while boxes.len() < n {
        let range = |b: &Vec<([u8; 3], u32)>| {
            (0..3)
                .map(|c| (b.iter().map(|e| e.0[c]).max().unwrap() - b.iter().map(|e| e.0[c]).min().unwrap(), c))
                .max()
                .unwrap()
        };
        let Some((i, (_, ch))) = boxes.iter().enumerate().filter(|(_, b)| b.len() > 1).map(|(i, b)| (i, range(b))).max_by_key(|(_, r)| r.0) else {
            break;
        };
        let mut b = boxes.swap_remove(i);
        b.sort_unstable_by_key(|e| e.0[ch]);
        let total: u64 = b.iter().map(|e| e.1 as u64).sum();
        let (mut acc, mut cut) = (0u64, 1);
        for (j, e) in b.iter().enumerate() {
            acc += e.1 as u64;
            if acc * 2 >= total {
                cut = (j + 1).clamp(1, b.len() - 1);
                break;
            }
        }
        let rest = b.split_off(cut);
        boxes.push(b);
        boxes.push(rest);
    }
    boxes
        .iter()
        .map(|b| {
            let w: f64 = b.iter().map(|e| e.1 as f64).sum();
            [0, 1, 2].map(|c| (b.iter().map(|e| e.0[c] as f64 * e.1 as f64).sum::<f64>() / w).round() as u8)
        })
        .collect()
}

fn levels(k: u32) -> Vec<[u8; 3]> {
    let step = |i: u32| (i * 255 / (k - 1)) as u8;
    let mut out = Vec::new();
    for r in 0..k {
        for g in 0..k {
            for b in 0..k {
                out.push([step(r), step(g), step(b)]);
            }
        }
    }
    out
}

impl Document {
    fn mode_key(&self) -> &'static str {
        match &self.vector.mode {
            None if self.vector.gray => "gray",
            None => "rgb",
            Some(ColorMode::Bitmap) => "bitmap",
            Some(ColorMode::Duotone { .. }) => "duotone",
            Some(ColorMode::Indexed { .. }) => "indexed",
            Some(ColorMode::Cmyk) => "cmyk",
            Some(ColorMode::Lab) => "lab",
            Some(ColorMode::Multichannel) => "multichannel",
        }
    }

    // Pixel layers with their own pixels (placed smart objects take theirs from the source).
    pub(super) fn own_pixel_layers(&self) -> Vec<u32> {
        self.planes()
            .into_iter()
            .filter_map(|at| if let At::Pixels(id) = at { Some(id) } else { None })
            .filter(|&id| self.placement_source(id).is_err())
            .collect()
    }

    // Straight RGBA `f` over every own pixel layer, ignoring the selection.
    pub(super) fn map_layers(&mut self, f: impl Fn([f32; 4]) -> [f32; 4]) -> Result<(), String> {
        let sel = self.selection.take();
        let r = (|| {
            for id in self.own_pixel_layers() {
                let area = self.node(id)?.pixel_tiles()?.coords();
                self.edit_pixel_tiles(id, &area, true, &f)?;
            }
            Ok(())
        })();
        self.selection = sel;
        r
    }

    // Rewrites the canvas area of layer `id` a tile row at a time in row-major order. `pick` gets
    // (x, y, straight RGBA plus carried error) and returns the new pixel; with `diffuse` the color
    // error spreads Floyd-Steinberg style, scaled by `amount`.
    fn dither_layer(&mut self, id: u32, diffuse: bool, amount: f32, mut pick: impl FnMut(i32, i32, [f32; 4]) -> [f32; 4]) -> Result<(), String> {
        let (w, h, ti) = (self.width as i32, self.height as i32, TILE as i32);
        let wu = w as usize;
        let (mut cur, mut next) = (vec![[0f32; 3]; wu + 2], vec![[0f32; 3]; wu + 2]);
        for band in (0..h).step_by(TILE) {
            let r = [0, band, w, (band + ti).min(h)];
            let mut p: Plane = self.layer_plane(id, r)?;
            for y in 0..p.h {
                for x in 0..wu {
                    let i = (y * wu + x) * 4;
                    let mut v = [p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]];
                    if diffuse {
                        for c in 0..3 {
                            v[c] += cur[x + 1][c];
                        }
                    }
                    let out = pick(x as i32, band + y as i32, v);
                    if diffuse && v[3] > 0.0 {
                        for c in 0..3 {
                            let e = (v[c] - out[c]) * amount;
                            cur[x + 2][c] += e * 7.0 / 16.0;
                            next[x][c] += e * 3.0 / 16.0;
                            next[x + 1][c] += e * 5.0 / 16.0;
                            next[x + 2][c] += e / 16.0;
                        }
                    }
                    p.data[i..i + 4].copy_from_slice(&out);
                }
                std::mem::swap(&mut cur, &mut next);
                next.iter_mut().for_each(|e| *e = [0.0; 3]);
            }
            self.edit_rect(id, r, false, |x, y, _| {
                let i = ((y - r[1]) as usize * wu + x as usize) * 4;
                Some([p.data[i], p.data[i + 1], p.data[i + 2], p.data[i + 3]])
            })?;
        }
        Ok(())
    }

    // Weighted 8-bit colors of every own pixel layer inside the canvas, flattened as `flat` does.
    fn color_histogram(&self, transparency: bool, matte: Option<[f32; 3]>) -> Result<HashMap<u32, u32>, String> {
        let mut hist = HashMap::new();
        let (w, h) = (self.width as i32, self.height as i32);
        for id in self.own_pixel_layers() {
            let tiles = self.node(id)?.pixel_tiles()?;
            for (tx, ty) in tiles.coords() {
                let px = &tiles.get(tx, ty).expect("a listed tile").px;
                for p in 0..TILE_PIXELS {
                    let (x, y) = (tx * TILE as i32 + (p % TILE) as i32, ty * TILE as i32 + (p / TILE) as i32);
                    if x < 0 || y < 0 || x >= w || y >= h {
                        continue;
                    }
                    let Some(c) = flat(px.rgba_f32(p), transparency, matte) else { continue };
                    let q = c.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u32);
                    *hist.entry(q[0] << 16 | q[1] << 8 | q[2]).or_insert(0) += 1;
                }
            }
        }
        Ok(hist)
    }

    fn build_table(&self, palette: Palette, colors: u32, forced: Forced, transparency: bool, matte: Option<[f32; 3]>) -> Result<Vec<[u8; 3]>, String> {
        let n = colors.clamp(2, 256) as usize;
        let mut table: Vec<[u8; 3]> = match forced {
            Forced::None => vec![],
            Forced::BlackWhite => vec![[0, 0, 0], [255, 255, 255]],
            Forced::Primaries => levels(2),
            Forced::Web => levels(6),
        };
        let rgb = |k: u32| [(k >> 16) as u8, (k >> 8) as u8, k as u8];
        let more = match palette {
            Palette::Exact => {
                let hist = self.color_histogram(transparency, matte)?;
                if hist.len() > 256 {
                    return Err(format!("the image has {} colors; Exact needs 256 or fewer", hist.len()));
                }
                let mut v: Vec<u32> = hist.into_keys().collect();
                v.sort_unstable();
                v.into_iter().map(rgb).collect()
            }
            Palette::Web => levels(6),
            Palette::Uniform => levels(((n as f64).cbrt() + 1e-9).floor().max(2.0) as u32),
            Palette::Adaptive => median_cut(&self.color_histogram(transparency, matte)?, n.saturating_sub(table.len()).max(1)),
            Palette::Custom => return Err("a Custom palette brings its own table".into()),
        };
        for c in more {
            if table.len() < 256 && !table.contains(&c) {
                table.push(c);
            }
        }
        if table.is_empty() {
            table.push([255, 255, 255]);
        }
        Ok(table)
    }

    /// The color table an Indexed Color `spec` converts with, for Custom to start from.
    pub fn indexed_table(&self, spec: &ModeSpec) -> Result<Vec<[u8; 3]>, String> {
        let ModeSpec::Indexed { palette, table, colors, forced, transparency, matte, .. } = spec else {
            return Err("not an Indexed Color mode".into());
        };
        match palette {
            Palette::Custom => Ok(table.clone()),
            _ => self.build_table(*palette, *colors, *forced, *transparency, matte.map(|m| m.map(|v| v as f32 / 255.0))),
        }
    }

    /// Image > Mode: converts to `spec`; false when the document is already in that mode.
    pub fn set_color_mode(&mut self, spec: &ModeSpec) -> Result<bool, String> {
        self.check_idle()?;
        let from = self.mode_key();
        let to = match spec {
            ModeSpec::Rgb => "rgb",
            ModeSpec::Gray => "gray",
            ModeSpec::Bitmap { .. } => "bitmap",
            ModeSpec::Duotone { .. } => "duotone",
            ModeSpec::Indexed { .. } => "indexed",
            ModeSpec::Cmyk => "cmyk",
            ModeSpec::Lab => "lab",
            ModeSpec::Multichannel => "multichannel",
        };
        let duo = match spec {
            ModeSpec::Duotone { inks, curves, overprints } => Some(ColorMode::duotone(inks, curves, overprints)?),
            _ => None,
        };
        if duo.is_some() {
            if self.vector.mode == duo {
                return Ok(false);
            }
        } else if from == to {
            return Ok(false);
        }
        if self.depth == 32 && !matches!(to, "rgb" | "gray") {
            return Err("32-bit documents are RGB or Grayscale only".into());
        }
        if matches!(to, "bitmap" | "duotone") && !matches!(from, "gray" | "duotone") {
            return Err(format!("{} needs a Grayscale document", if to == "bitmap" { "Bitmap" } else { "Duotone" }));
        }
        if to == "indexed" && (self.depth != 8 || !matches!(from, "rgb" | "gray")) {
            return Err("Indexed Color needs an 8-bit RGB or Grayscale document".into());
        }
        if from == "bitmap" && to != "gray" {
            return Err("convert Bitmap to Grayscale first".into());
        }
        let mut d = self.clone();
        if let Some(ColorMode::Duotone { inks, curves, overprints }) = &d.vector.mode {
            if !matches!(to, "gray" | "duotone") {
                let map = DuotoneMap::new(inks, curves, overprints);
                d.map_layers(|c| {
                    let o = map.color(luma([c[0], c[1], c[2]]));
                    [o[0], o[1], o[2], c[3]]
                })?;
            }
        }
        let gray_pixels = d.vector.gray;
        let (gray, mode) = match spec {
            ModeSpec::Rgb => (false, None),
            ModeSpec::Gray => {
                if !gray_pixels {
                    d.map_layers(|c| {
                        let g = luma([c[0], c[1], c[2]]);
                        [g, g, g, c[3]]
                    })?;
                }
                (true, None)
            }
            ModeSpec::Bitmap { method, resolution } => {
                if let Some(res) = *resolution {
                    if !(res.is_finite() && res > 0.0) {
                        return Err("the output resolution must be above 0".into());
                    }
                    let k = res / d.vector.resolution;
                    let size = |v: u32| ((v as f64 * k).round() as u32).max(1);
                    d.image_size(size(d.width), size(d.height), Interp::Bicubic, false)?;
                    d.vector.resolution = res;
                }
                let threshold: Box<dyn Fn(i32, i32) -> f32> = match method {
                    BitmapMethod::Threshold | BitmapMethod::Diffusion => Box::new(|_, _| 0.5),
                    BitmapMethod::Pattern => Box::new(bayer),
                    BitmapMethod::Halftone { frequency, unit, angle, shape } => {
                        if !(1.0..=999.0).contains(frequency) {
                            return Err("the screen frequency must be 1 to 999".into());
                        }
                        if !(-180.0..=180.0).contains(angle) {
                            return Err("the screen angle must be -180 to 180 degrees".into());
                        }
                        let per = if *unit == LineUnit::Cm { d.vector.resolution / 2.54 } else { d.vector.resolution };
                        let screen = Screen::new(*shape, per / frequency, *angle);
                        Box::new(move |x, y| screen.threshold(x, y))
                    }
                    BitmapMethod::Custom { pattern } => {
                        let e = d.patterns.iter().find(|p| p.id == *pattern).ok_or_else(|| format!("no pattern {pattern}"))?;
                        let (w, h) = (e.width as i32, e.height as i32);
                        let px = d.blobs.get(&e.blob).filter(|b| b.len() == (w * h * 4) as usize).ok_or("the pattern has no pixels")?.clone();
                        Box::new(move |x, y| {
                            let i = (y.rem_euclid(h) * w + x.rem_euclid(w)) as usize * 4;
                            let l = 0.3 * px[i] as f32 + 0.59 * px[i + 1] as f32 + 0.11 * px[i + 2] as f32;
                            (l + 0.5) / 256.0
                        })
                    }
                };
                for id in d.own_pixel_layers() {
                    d.dither_layer(id, *method == BitmapMethod::Diffusion, 1.0, |x, y, c| {
                        let v = if luma([c[0], c[1], c[2]]) >= threshold(x, y) { 1.0 } else { 0.0 };
                        [v, v, v, c[3].clamp(0.0, 1.0)]
                    })?;
                }
                (true, Some(ColorMode::Bitmap))
            }
            ModeSpec::Duotone { .. } => (true, duo),
            ModeSpec::Indexed { palette, table, colors, forced, transparency, dither, amount, matte } => {
                let matte = matte.map(|m| m.map(|v| v as f32 / 255.0));
                let table = match palette {
                    Palette::Custom if !(1..=256).contains(&table.len()) => return Err("a color table holds 1 to 256 colors".into()),
                    Palette::Custom => table.clone(),
                    _ => d.build_table(*palette, *colors, *forced, *transparency, matte)?,
                };
                let (dither, amount, transparency) = (*dither, amount.clamp(0.0, 1.0), *transparency);
                // Ordered and noise offsets span about one palette step.
                let spread = amount / (table.len() as f32).cbrt().max(1.0);
                let mut near = Nearest::new(&table);
                for id in d.own_pixel_layers() {
                    d.dither_layer(id, dither == Dither::Diffusion, amount, |x, y, c| {
                        let Some(mut s) = flat(c, transparency, matte) else { return [0.0; 4] };
                        let off = match dither {
                            Dither::Pattern => (bayer(x, y) - 0.5) * spread,
                            Dither::Noise => (noise(x, y) - 0.5) * spread,
                            _ => 0.0,
                        };
                        s.iter_mut().for_each(|v| *v += off);
                        let o = near.pick(s);
                        [o[0], o[1], o[2], 1.0]
                    })?;
                }
                (false, Some(ColorMode::Indexed { table }))
            }
            ModeSpec::Cmyk => (false, Some(ColorMode::Cmyk)),
            ModeSpec::Lab => (false, Some(ColorMode::Lab)),
            ModeSpec::Multichannel => (false, Some(ColorMode::Multichannel)),
        };
        d.vector.gray = gray;
        if matches!(mode, Some(ColorMode::Bitmap | ColorMode::Duotone { .. } | ColorMode::Multichannel | ColorMode::Lab)) {
            d.vector.profile = None;
        }
        d.vector.mode = mode;
        *self = d;
        Ok(true)
    }

    /// Image > Mode > Color Table: every pixel showing table entry i takes `table[i]`.
    pub fn set_color_table(&mut self, table: Vec<[u8; 3]>) -> Result<bool, String> {
        self.check_idle()?;
        let Some(ColorMode::Indexed { table: old }) = &self.vector.mode else {
            return Err("Color Table needs an Indexed Color document".into());
        };
        if table.len() != old.len() {
            return Err(format!("the color table has {} entries, got {}", old.len(), table.len()));
        }
        if &table == old {
            return Ok(false);
        }
        let near = std::cell::RefCell::new(Nearest::new(old));
        let new = table.clone();
        self.map_layers(|c| {
            let o = new[near.borrow_mut().index([c[0], c[1], c[2]])].map(|v| v as f32 / 255.0);
            [o[0], o[1], o[2], c[3]]
        })?;
        self.vector.mode = Some(ColorMode::Indexed { table });
        Ok(true)
    }

    // Premultiplied composite `v` as the mode displays it; `level` 0 is full size.
    pub(super) fn mode_map(&self, level: u32, mut v: Vec<f32>) -> Vec<f32> {
        let mode = self.vector.mode.as_ref();
        if !self.vector.gray && !matches!(mode, Some(ColorMode::Indexed { .. })) {
            return v;
        }
        let mut near = match mode {
            Some(ColorMode::Indexed { table }) => Some(Nearest::new(table)),
            _ => None,
        };
        let duo = match mode {
            Some(ColorMode::Duotone { inks, curves, overprints }) => Some(DuotoneMap::new(inks, curves, overprints)),
            _ => None,
        };
        for p in v.chunks_exact_mut(4) {
            let a = p[3];
            if a <= 0.0 {
                continue;
            }
            let s = [p[0] / a, p[1] / a, p[2] / a];
            let out = match (mode, &mut near) {
                (_, Some(n)) => n.pick(s),
                (Some(ColorMode::Duotone { .. }), _) => duo.as_ref().expect("a Duotone map").color(luma(s)),
                (Some(ColorMode::Bitmap), _) if level == 0 => [if luma(s) >= 0.5 { 1.0 } else { 0.0 }; 3],
                _ => [luma(s); 3],
            };
            for c in 0..3 {
                p[c] = out[c] * a;
            }
        }
        v
    }
}

// Straight color for indexing, None where it stays transparent. With `transparency` a matte blends
// partly transparent pixels over it, else alpha thresholds at 50%; without, all is over matte or white.
fn flat(c: [f32; 4], transparency: bool, matte: Option<[f32; 3]>) -> Option<[f32; 3]> {
    let a = c[3].clamp(0.0, 1.0);
    let over = |m: [f32; 3]| [0, 1, 2].map(|i| c[i] * a + m[i] * (1.0 - a));
    match (transparency, matte) {
        (true, None) => (a >= 0.5).then_some([c[0], c[1], c[2]]),
        (true, Some(m)) => (a > 0.0).then(|| over(m)),
        (false, m) => Some(over(m.unwrap_or([1.0; 3]))),
    }
}

#[cfg(test)]
mod tests {
    use super::super::transform::tests::{get_px, put_px};
    use super::*;

    fn spec(json: &str) -> ModeSpec {
        serde_json::from_str(json).unwrap()
    }

    fn fill(d: &mut Document, id: u32, c: [u8; 4]) {
        for y in 0..d.height as i32 {
            for x in 0..d.width as i32 {
                put_px(d, id, x, y, c);
            }
        }
    }

    fn shown(d: &Document, x: usize, y: usize) -> [u8; 4] {
        let t = d.flatten_tile_rgba8(0, 0).unwrap();
        let i = (y * TILE + x) * 4;
        [t[i], t[i + 1], t[i + 2], t[i + 3]]
    }

    #[test]
    fn bitmap_needs_grayscale_and_dithers_to_black_and_white() {
        let mut d = Document::new(64, 64, 8).unwrap();
        fill(&mut d, 1, [64, 64, 64, 255]);
        assert!(d.set_color_mode(&spec(r#"{"mode":"bitmap","method":"threshold"}"#)).is_err(), "RGB cannot go to Bitmap");
        d.set_color_mode(&ModeSpec::Gray).unwrap();
        let mut t = d.clone();
        t.set_color_mode(&spec(r#"{"mode":"bitmap","method":"threshold"}"#)).unwrap();
        assert_eq!(get_px(&t, 1, 9, 9), [0, 0, 0, 255]);
        for method in ["pattern", "diffusion"] {
            let mut b = d.clone();
            b.set_color_mode(&spec(&format!(r#"{{"mode":"bitmap","method":"{method}"}}"#))).unwrap();
            let mut white = 0;
            for y in 0..64 {
                for x in 0..64 {
                    let p = get_px(&b, 1, x, y);
                    assert!(p == [0, 0, 0, 255] || p == [255, 255, 255, 255], "{method} gives only black and white");
                    white += (p[0] == 255) as u32;
                }
            }
            let share = white as f32 / 4096.0;
            assert!((share - 64.0 / 255.0).abs() < 0.03, "{method}: white share {share}");
            assert_eq!(b.vector.mode, Some(ColorMode::Bitmap));
            assert!(b.set_color_mode(&ModeSpec::Rgb).is_err(), "Bitmap goes back through Grayscale");
        }
    }

    fn gray_doc(n: u32, v: u8) -> Document {
        let mut d = Document::new(n, n, 8).unwrap();
        fill(&mut d, 1, [v, v, v, 255]);
        d.set_color_mode(&ModeSpec::Gray).unwrap();
        d
    }

    // Black share over the canvas of layer 1.
    fn black_share(d: &Document) -> f32 {
        let (w, h) = (d.width as i32, d.height as i32);
        let mut black = 0;
        for y in 0..h {
            for x in 0..w {
                let p = get_px(d, 1, x, y);
                assert!(p == [0, 0, 0, 255] || p == [255, 255, 255, 255], "only black and white: {p:?}");
                black += (p[0] == 0) as u32;
            }
        }
        black as f32 / (w * h) as f32
    }

    #[test]
    fn bitmap_halftone_screen_covers_by_gray_and_shapes_differ() {
        let ht = |shape: &str, angle: f64| spec(&format!(r#"{{"mode":"bitmap","method":"halftone","frequency":8,"angle":{angle},"shape":"{shape}"}}"#));
        let mut m = gray_doc(64, 128);
        assert_eq!(m.vector.resolution, 72.0);
        m.set_color_mode(&ht("round", 45.0)).unwrap();
        let share = black_share(&m);
        assert!((share - 0.5).abs() <= 0.05, "mid gray black share {share}");
        for (v, want) in [(0u8, 1.0f32), (255, 0.0)] {
            let mut d = gray_doc(32, v);
            d.set_color_mode(&ht("round", 45.0)).unwrap();
            assert_eq!(black_share(&d), want, "gray {v}");
        }
        let mut seen: Vec<Vec<[u8; 4]>> = vec![];
        for shape in ["round", "ellipse", "line", "square", "cross", "diamond"] {
            let mut d = gray_doc(48, 90);
            d.set_color_mode(&ht(shape, 0.0)).unwrap();
            let px: Vec<[u8; 4]> = (0..48 * 48).map(|i| get_px(&d, 1, i % 48, i / 48)).collect();
            assert!(!seen.contains(&px), "{shape} differs from the shapes before it");
            seen.push(px);
        }
        let cm = spec(r#"{"mode":"bitmap","method":"halftone","frequency":8,"unit":"cm","angle":0,"shape":"line"}"#);
        let mut d = gray_doc(48, 128);
        d.set_color_mode(&cm).unwrap();
        // 72 ppi / 2.54 / 8 = 3.54 px per line: rows alternate within 4 px.
        let col: Vec<u8> = (0..8).map(|y| get_px(&d, 1, 0, y)[0]).collect();
        assert!(col.windows(4).all(|w| w.contains(&0) && w.contains(&255)), "lines/cm cells: {col:?}");
        for bad in [r#""frequency":0,"angle":0"#, r#""frequency":1000,"angle":0"#, r#""frequency":8,"angle":181"#] {
            let s = spec(&format!(r#"{{"mode":"bitmap","method":"halftone",{bad},"shape":"round"}}"#));
            assert!(gray_doc(8, 128).set_color_mode(&s).is_err(), "{bad} is out of range");
        }
    }

    #[test]
    fn bitmap_custom_pattern_thresholds_by_the_tiled_pattern_luminance() {
        let mut d = gray_doc(8, 128);
        let blob = d.blob_add(&[0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255]).unwrap();
        d.set_document_m3(&format!(r#"{{"patterns":[{{"id":"p2","name":"P","width":2,"height":2,"blob":{blob}}}]}}"#)).unwrap();
        assert!(d.clone().set_color_mode(&spec(r#"{"mode":"bitmap","method":"custom","pattern":"nope"}"#)).is_err());
        d.set_color_mode(&spec(r#"{"mode":"bitmap","method":"custom","pattern":"p2"}"#)).unwrap();
        for (x, y) in [(0, 0), (1, 0), (0, 1), (1, 1), (6, 4), (7, 7)] {
            let want = if (x % 2) + 2 * (y % 2) < 2 { 255 } else { 0 };
            assert_eq!(get_px(&d, 1, x, y)[0], want, "at {x},{y}");
        }
    }

    #[test]
    fn bitmap_output_resolution_resamples_first_and_old_json_keeps_the_resolution() {
        let mut d = gray_doc(32, 128);
        d.set_color_mode(&spec(r#"{"mode":"bitmap","method":"threshold","resolution":144}"#)).unwrap();
        assert_eq!((d.width, d.height, d.vector.resolution), (64, 64, 144.0));
        assert_eq!(get_px(&d, 1, 63, 63), [255, 255, 255, 255]);
        let mut k = gray_doc(32, 128);
        k.set_color_mode(&spec(r#"{"mode":"bitmap","method":"diffusion"}"#)).unwrap();
        assert_eq!((k.width, k.vector.resolution), (32, 72.0));
        assert!(gray_doc(8, 128).set_color_mode(&spec(r#"{"mode":"bitmap","method":"threshold","resolution":0}"#)).is_err());
    }

    #[test]
    fn duotone_shows_inks_bakes_them_into_rgb_and_reloads() {
        let mut d = Document::new(32, 32, 8).unwrap();
        fill(&mut d, 1, [128, 128, 128, 255]);
        d.set_color_mode(&ModeSpec::Gray).unwrap();
        d.set_color_mode(&spec(r#"{"mode":"duotone","inks":[[0,0,0],[255,0,0]]}"#)).unwrap();
        let g = 128.0 / 255.0;
        let want = multiplied(&[[0, 0, 0], [255, 0, 0]], g).map(|v| (v * 255.0).round() as u8);
        assert_eq!(want, [128, 64, 64]);
        assert_eq!(shown(&d, 3, 3), [want[0], want[1], want[2], 255]);
        assert_eq!(get_px(&d, 1, 3, 3), [128, 128, 128, 255], "pixels stay gray");
        let (m, again) = super::super::m3_tests::reload(&d);
        assert_eq!(m, again);
        assert!(m.contains(r#""mode":{"kind":"duotone","inks":[[0,0,0],[255,0,0]]}"#));
        d.set_color_mode(&ModeSpec::Rgb).unwrap();
        assert_eq!(get_px(&d, 1, 3, 3), [want[0], want[1], want[2], 255], "RGB bakes the inks");
        assert!(!d.manifest().contains("\"mode\""));
    }

    // Each ink multiplies white by its color at density 1 - g.
    fn multiplied(inks: &[[u8; 3]], g: f32) -> [f32; 3] {
        let mut out = [1.0f32; 3];
        for ink in inks {
            for (o, c) in out.iter_mut().zip(ink) {
                *o *= 1.0 - (1.0 - g) * (1.0 - *c as f32 / 255.0);
            }
        }
        out
    }

    #[test]
    fn duotone_overprint_sets_follow_photoshop_order() {
        let names = |n: usize| -> Vec<String> {
            overprint_sets(n).iter().map(|m| (0..4).filter(|i| m & (1 << i) != 0).map(|i| (i + 1).to_string()).collect::<Vec<_>>().join("+")).collect()
        };
        assert!(names(1).is_empty());
        assert_eq!(names(2), ["1+2"]);
        assert_eq!(names(3), ["1+2", "1+3", "2+3", "1+2+3"]);
        assert_eq!(names(4), ["1+2", "1+3", "1+4", "2+3", "2+4", "3+4", "1+2+3", "1+2+4", "1+3+4", "2+3+4", "1+2+3+4"]);
    }

    #[test]
    fn duotone_default_curves_and_overprints_match_multiplied_inks() {
        let all = [[0, 0, 0], [228, 120, 40], [40, 110, 190], [230, 200, 40]];
        for n in 1..=4 {
            let inks = &all[..n];
            let products: Vec<[u8; 3]> = overprint_sets(n)
                .iter()
                .map(|m| multiplied(&(0..n).filter(|i| m & (1 << i) != 0).map(|i| inks[i]).collect::<Vec<_>>(), 0.0).map(|v| (v * 255.0).round() as u8))
                .collect();
            for map in [DuotoneMap::new(inks, &[], &[]), DuotoneMap::new(inks, &vec![IDENTITY_CURVE; n], &[])] {
                for g in [0.0, 0.1, 0.37, 0.5, 0.8, 1.0] {
                    let (a, b) = (map.color(g), multiplied(inks, g));
                    assert!((0..3).all(|c| (a[c] - b[c]).abs() < 1e-5), "{n} inks at {g}: {a:?} vs {b:?}");
                }
            }
            let explicit = DuotoneMap::new(inks, &[], &products);
            let b = multiplied(inks, 0.3);
            assert!((0..3).all(|c| (explicit.color(0.3)[c] - b[c]).abs() < 0.01), "{n} inks with explicit products");
        }
    }

    #[test]
    fn duotone_ink_curves_interpolate_the_set_points_and_skip_empty_ones() {
        let black = [[0, 0, 0]];
        let mut c = IDENTITY_CURVE;
        c[6] = Some(80.0); // 50% ink prints 80%
        let map = DuotoneMap::new(&black, &[c], &[]);
        let at = |g: f32| map.color(g)[0];
        assert!((at(0.5) - 0.2).abs() < 1e-5, "{}", at(0.5));
        // Monotone cubic (Fritsch-Carlson) through (0, 0), (50, 80), (100, 100): 49.75 % at 25 %, 94 % at 75 %.
        assert!((at(0.75) - 0.5025).abs() < 1e-4, "25% ink: smooth, above the 40% chord, {}", at(0.75));
        assert!((at(0.25) - 0.06).abs() < 1e-4, "75% ink: 94% output, {}", at(0.25));
        assert_eq!((at(1.0), at(0.0)), (1.0, 0.0));
        let mut flat = [None; 13];
        flat[0] = Some(10.0);
        flat[12] = Some(60.0);
        let m = DuotoneMap::new(&black, &[flat], &[]);
        assert!((m.color(1.0)[0] - 0.9).abs() < 1e-5 && (m.color(0.0)[0] - 0.4).abs() < 1e-5);
    }

    #[test]
    fn duotone_overprints_show_where_inks_overlap_and_curves_reach_the_document() {
        let map = DuotoneMap::new(&[[255, 0, 0], [0, 0, 255]], &[], &[[0, 255, 0]]);
        assert_eq!(map.color(0.0), [0.0, 1.0, 0.0], "both inks solid show the overprint");
        assert_eq!(map.color(1.0), [1.0, 1.0, 1.0]);
        let mid = map.color(0.5);
        assert!(mid.iter().all(|v| (v - 0.5).abs() < 1e-5), "bilinear mix of white, red, blue, green: {mid:?}");

        let mut d = gray_doc(16, 128);
        let mut curve = IDENTITY_CURVE;
        curve[6] = Some(20.0);
        let s = |curves: &str, over: &str| spec(&format!(r#"{{"mode":"duotone","inks":[[255,0,0],[0,0,255]]{curves}{over}}}"#));
        let cv = format!(r#","curves":[{},{}]"#, serde_json::to_string(&curve).unwrap(), serde_json::to_string(&IDENTITY_CURVE).unwrap());
        assert!(d.set_color_mode(&s(&cv, r#","overprints":[[0,255,0]]"#)).unwrap());
        assert!(!d.set_color_mode(&s(&cv, r#","overprints":[[0,255,0]]"#)).unwrap(), "same inks, curves and overprints");
        let want = DuotoneMap::new(&[[255, 0, 0], [0, 0, 255]], &[curve, IDENTITY_CURVE], &[[0, 255, 0]]).color(128.0 / 255.0).map(|v| (v * 255.0).round() as u8);
        assert_eq!(shown(&d, 2, 2), [want[0], want[1], want[2], 255]);
        let (m, again) = super::super::m3_tests::reload(&d);
        assert_eq!(m, again);
        assert!(m.contains(r#""overprints":[[0,255,0]]"#) && m.contains(r#""curves":[[0.0,null,null,null,null,null,20.0,null,null,null,null,null,100.0],[0.0,"#), "{m}");
        let mut rgb = d.clone();
        rgb.set_color_mode(&ModeSpec::Rgb).unwrap();
        assert_eq!(get_px(&rgb, 1, 2, 2), [want[0], want[1], want[2], 255], "RGB bakes curves and overprints");

        // Defaults spelled out are stored like the plain inks.
        let mut plain = gray_doc(8, 128);
        let products = r#","overprints":[[0,0,0]]"#;
        let ident = format!(r#","curves":[{0},{0}]"#, serde_json::to_string(&IDENTITY_CURVE).unwrap());
        plain.set_color_mode(&s(&ident, products)).unwrap();
        assert!(plain.manifest().contains(r#""mode":{"kind":"duotone","inks":[[255,0,0],[0,0,255]]}"#));
        assert!(!plain.set_color_mode(&s("", "")).unwrap(), "same as the defaults");

        for bad in [r#","overprints":[[0,0,0],[1,1,1]]"#, r#","curves":[[0,null,null,null,null,null,null,null,null,null,null,null,100]]"#, r#","curves":[[0,null,null,null,null,null,120,null,null,null,null,null,100],[0,null,null,null,null,null,50,null,null,null,null,null,100]]"#] {
            assert!(gray_doc(8, 128).set_color_mode(&s(bad, "")).is_err(), "{bad}");
        }
    }

    #[test]
    fn indexed_palettes_dither_display_and_color_table() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let colors = [[250, 10, 10, 255], [10, 250, 10, 255], [10, 10, 250, 255], [200, 200, 30, 255]];
        for y in 0..64 {
            for x in 0..64 {
                put_px(&mut d, 1, x, y, colors[((x / 32) + 2 * (y / 32)) as usize]);
            }
        }
        let idx = |p: &str, n: u32, dither: &str| spec(&format!(r#"{{"mode":"indexed","palette":"{p}","colors":{n},"transparency":false,"dither":"{dither}","amount":1}}"#));
        let mut e = d.clone();
        e.set_color_mode(&idx("exact", 256, "none")).unwrap();
        let Some(ColorMode::Indexed { table }) = &e.vector.mode else { panic!() };
        assert_eq!(table.len(), 4);
        assert_eq!(get_px(&e, 1, 40, 40), [200, 200, 30, 255]);
        let mut a = d.clone();
        a.set_color_mode(&idx("adaptive", 4, "diffusion")).unwrap();
        let Some(ColorMode::Indexed { table }) = &a.vector.mode else { panic!() };
        assert_eq!(table.len(), 4);
        assert!(table.contains(&[10, 250, 10]), "adaptive finds the image colors: {table:?}");
        let mut u = d.clone();
        u.set_color_mode(&idx("uniform", 8, "none")).unwrap();
        let Some(ColorMode::Indexed { table }) = &u.vector.mode else { panic!() };
        assert_eq!(table.len(), 8);
        assert_eq!(get_px(&u, 1, 5, 5), [255, 0, 0, 255]);
        let mut w = d.clone();
        w.set_color_mode(&idx("web", 256, "pattern")).unwrap();
        let Some(ColorMode::Indexed { table }) = &w.vector.mode else { panic!() };
        assert_eq!(table.len(), 216);
        // Paint off the palette: the display shows the nearest entry.
        put_px(&mut u, 1, 2, 2, [240, 20, 30, 255]);
        assert_eq!(shown(&u, 2, 2), [255, 0, 0, 255]);
        let Some(ColorMode::Indexed { table }) = u.vector.mode.clone() else { panic!() };
        let mut t = table.clone();
        let red = t.iter().position(|c| *c == [255, 0, 0]).unwrap();
        t[red] = [0, 128, 255];
        assert!(u.set_color_table(t).unwrap());
        assert_eq!(get_px(&u, 1, 5, 5), [0, 128, 255, 255]);
        assert!(u.set_color_table(vec![[0, 0, 0]]).is_err(), "same length only");
        assert!(u.convert_depth(16).is_err(), "Indexed Color stays 8-bit");
        let mut many = Document::new(64, 64, 8).unwrap();
        for y in 0..64 {
            for x in 0..64 {
                put_px(&mut many, 1, x, y, [x as u8 * 4, y as u8 * 4, 0, 255]);
            }
        }
        assert!(many.set_color_mode(&idx("exact", 256, "none")).is_err(), "4096 colors are not exact");
        let mut deep = Document::new(8, 8, 16).unwrap();
        assert!(deep.set_color_mode(&idx("web", 256, "none")).is_err(), "8-bit only");
    }

    #[test]
    fn indexed_custom_table_and_matte() {
        let mut d = Document::new(8, 8, 8).unwrap();
        fill(&mut d, 1, [0, 0, 0, 0]);
        put_px(&mut d, 1, 0, 0, [255, 0, 0, 128]);
        put_px(&mut d, 1, 1, 0, [0, 0, 255, 255]);
        let table = "[[255,255,255],[255,128,128],[0,0,0],[0,0,255],[255,0,0]]";
        let custom = |tr: bool, matte: &str| spec(&format!(r#"{{"mode":"indexed","palette":"custom","table":{table},"colors":256,"forced":"web","transparency":{tr},"dither":"none","amount":1{matte}}}"#));
        let mut a = d.clone();
        a.set_color_mode(&custom(true, r#","matte":[255,255,255]"#)).unwrap();
        let Some(ColorMode::Indexed { table: t }) = &a.vector.mode else { panic!() };
        assert_eq!(t, &vec![[255, 255, 255], [255, 128, 128], [0, 0, 0], [0, 0, 255], [255, 0, 0]], "the custom table as given");
        assert_eq!(get_px(&a, 1, 0, 0), [255, 128, 128, 255], "the edge blends over the white matte");
        assert_eq!(get_px(&a, 1, 1, 0), [0, 0, 255, 255]);
        assert_eq!(get_px(&a, 1, 3, 3)[3], 0, "transparent stays transparent");
        let mut n = d.clone();
        n.set_color_mode(&custom(true, "")).unwrap();
        assert_eq!(get_px(&n, 1, 0, 0), [255, 0, 0, 255], "no matte: hard edge at 50% alpha");
        let mut b = d.clone();
        b.set_color_mode(&custom(false, r#","matte":[0,0,0]"#)).unwrap();
        assert_eq!(get_px(&b, 1, 3, 3), [0, 0, 0, 255], "transparent areas over the black matte");
        let mut w = d.clone();
        w.set_color_mode(&custom(false, "")).unwrap();
        assert_eq!(get_px(&w, 1, 3, 3), [255, 255, 255, 255], "no matte: over white");
        let bad = |t: &str| spec(&format!(r#"{{"mode":"indexed","palette":"custom","table":{t},"colors":256,"transparency":false,"dither":"none","amount":1}}"#));
        assert!(d.clone().set_color_mode(&bad("[]")).is_err(), "a custom table holds 1 to 256 colors");
        assert!(d.clone().set_color_mode(&bad(&format!("[{}]", vec!["[1,2,3]"; 257].join(",")))).is_err());
    }

    #[test]
    fn duotone_bitmap_multichannel_carry_no_profile() {
        let gray = crate::icc::Profile::builtin("Gray Gamma 2.2").unwrap();
        let mut d = Document::new(16, 16, 8).unwrap();
        d.set_color_mode(&ModeSpec::Gray).unwrap();
        d.assign_profile(Some(&gray)).unwrap();
        let duo = ModeSpec::Duotone { inks: vec![[0, 0, 0]], curves: vec![], overprints: vec![] };
        for s in [duo, ModeSpec::Bitmap { method: BitmapMethod::Threshold, resolution: None }] {
            assert!(d.set_color_mode(&s).unwrap());
            assert!(d.profile().is_none(), "{s:?} drops the tag");
            assert!(d.assign_profile(Some(&gray)).is_err(), "{s:?} refuses a profile");
            d.set_color_mode(&ModeSpec::Gray).unwrap();
            d.assign_profile(Some(&gray)).unwrap();
        }
        d.set_color_mode(&ModeSpec::Rgb).unwrap();
        d.assign_profile(Some(&crate::icc::Profile::builtin(crate::icc::SRGB).unwrap())).unwrap();
        assert!(d.set_color_mode(&ModeSpec::Multichannel).unwrap());
        assert!(d.profile().is_none());
        assert!(d.assign_profile(Some(&gray)).is_err());
        d.set_color_mode(&ModeSpec::Rgb).unwrap();
        d.assign_profile(Some(&crate::icc::Profile::builtin(crate::icc::SRGB).unwrap())).unwrap();
        assert!(d.set_color_mode(&ModeSpec::Lab).unwrap());
        assert!(d.profile().is_none(), "Lab drops the RGB tag");
    }

    #[test]
    fn cmyk_lab_multichannel_are_flags_and_32_bit_stays_rgb_or_gray() {
        let mut d = Document::new(16, 16, 8).unwrap();
        put_px(&mut d, 1, 1, 1, [200, 50, 10, 255]);
        for (s, kind) in [(ModeSpec::Cmyk, "cmyk"), (ModeSpec::Lab, "lab"), (ModeSpec::Multichannel, "multichannel")] {
            assert!(d.set_color_mode(&s).unwrap());
            assert!(!d.set_color_mode(&s).unwrap(), "same mode is no change");
            assert_eq!(get_px(&d, 1, 1, 1), [200, 50, 10, 255]);
            assert!(d.manifest().contains(&format!(r#""mode":{{"kind":"{kind}"}}"#)));
            assert!(d.convert_depth(32).is_err(), "{kind} has no 32-bit");
        }
        d.set_color_mode(&ModeSpec::Rgb).unwrap();
        d.convert_depth(32).unwrap();
        assert!(d.set_color_mode(&ModeSpec::Lab).is_err());
        assert!(d.set_color_mode(&ModeSpec::Gray).unwrap());
    }
}
