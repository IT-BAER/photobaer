//! Adjustment layer kinds and their typed params (docs/M3.md section 3). Values use the dialog
//! units of that section; unknown kinds and unknown params keys fail to deserialize.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::blend::{dissolve_hash, lum, set_lum};
use crate::content::GradientDef;
use crate::gradient::{linear_to_srgb, srgb_to_linear};

/// One of the 16 layer adjustment kinds, stored as `{ "kind": ..., "params": {...} }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "snake_case", deny_unknown_fields)]
pub enum Adjustment {
    BrightnessContrast(BrightnessContrast),
    Levels(Levels),
    Curves(Curves),
    Exposure(Exposure),
    Vibrance(Vibrance),
    HueSaturation(HueSaturation),
    ColorBalance(ColorBalance),
    BlackWhite(BlackWhite),
    PhotoFilter(PhotoFilter),
    ChannelMixer(ChannelMixer),
    ColorLookup(ColorLookup),
    Invert(Invert),
    Posterize(Posterize),
    Threshold(Threshold),
    GradientMap(GradientMap),
    SelectiveColor(SelectiveColor),
}

/// Draw-program `Adjust` opcodes (docs/M3.md section 2), shared with the WGSL compositor. Each
/// comment gives the f32 data block the opcode reads; color values are fractions (1 = 100 %).
/// No data.
pub const OP_INVERT: u32 = 1;
/// `[nearest (0|1), n, R table n, G table n, B table n]`, entry `i` at input `i / (n - 1)`.
pub const OP_TABLE: u32 = 2;
/// `[vibrance, saturation]` in -100..100.
pub const OP_VIBRANCE: u32 = 3;
/// `[colorize, master h s l, colorize h s l, 6 x (bands a b c d, h s l)]`: degrees and -100..100.
pub const OP_HUE_SATURATION: u32 = 4;
/// `[preserve, shadows (cr, mg, yb), midtones (..), highlights (..)]` as fractions.
pub const OP_COLOR_BALANCE: u32 = 5;
/// `[reds, yellows, greens, cyans, blues, magentas, tint, tint hue (degrees), tint saturation]`.
pub const OP_BLACK_WHITE: u32 = 6;
/// `[preserve, factor r, g, b]` with `factor = 1 - d + d * color`.
pub const OP_PHOTO_FILTER: u32 = 7;
/// `[3 output rows x (w_r, w_g, w_b, constant)]`; monochrome repeats the gray row.
pub const OP_CHANNEL_MIXER: u32 = 8;
/// `[absolute, 9 families (reds..magentas, whites, neutrals, blacks) x (C, M, Y, K)]`.
pub const OP_SELECTIVE_COLOR: u32 = 9;
/// `[dither, 4096 x RGB]`.
pub const OP_GRADIENT_MAP: u32 = 10;
/// `[n, domain min RGB, domain max RGB, trilinear (0|1), dither, n^3 x RGB]`, red fastest.
pub const OP_COLOR_LOOKUP: u32 = 11;
/// `[exposure, offset, gamma]`, unclamped: 32-bit documents only, so the WGSL compositor never sees it.
pub const OP_EXPOSURE: u32 = 12;

/// Compositor tables have this many entries per channel (docs/M3.md section 2).
const TABLE_N: usize = 65536;
const GRADIENT_N: usize = 4096;
const LUT_BYTES: usize = 16 << 20;

/// An `Adjust` opcode and its data block.
#[derive(Clone, Debug, PartialEq)]
pub struct Compiled {
    pub opcode: u32,
    pub data: Vec<f32>,
}

impl Adjustment {
    /// The blob this kind reads (the color lookup table), if any.
    pub fn blob(&self) -> Option<u64> {
        match self {
            Adjustment::ColorLookup(c) => c.table,
            _ => None,
        }
    }

    /// Trust-boundary range check (docs/M3.md section 3); errors name the field. Kinds whose
    /// fields are already bounded by type or by a later clamp (invert, gradient map, color
    /// lookup beyond its own LUT-size check) have nothing to add here.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Adjustment::BrightnessContrast(p) => {
                let (b, c) = if p.legacy { (100.0, 100.0) } else { (150.0, 100.0) };
                range("brightness", p.brightness, -b, b)?;
                range("contrast", p.contrast, if p.legacy { -c } else { -50.0 }, c)
            }
            Adjustment::Levels(p) => {
                let recs = [("levels.composite", Some(&p.composite)), ("levels.red", p.red.as_ref()), ("levels.green", p.green.as_ref()), ("levels.blue", p.blue.as_ref())];
                for (field, r) in recs {
                    let Some(r) = r else { continue };
                    range(&format!("{field}.gamma"), r.gamma, 0.01, 9.99)?;
                }
                Ok(())
            }
            Adjustment::Curves(p) => {
                for (field, pts) in [("curves.composite", Some(&p.composite))]
                    .into_iter()
                    .chain([("curves.red", p.red.as_ref()), ("curves.green", p.green.as_ref()), ("curves.blue", p.blue.as_ref())])
                {
                    let Some(pts) = pts else { continue };
                    // Pencil curves hold one sample per input value.
                    let max = if p.mode == CurveMode::Pencil { 256 } else { 16 };
                    if pts.is_empty() || pts.len() > max {
                        return Err(format!("{field} must have between 1 and {max} points, got {}", pts.len()));
                    }
                }
                Ok(())
            }
            Adjustment::Exposure(p) => {
                range("exposure", p.exposure, -20.0, 20.0)?;
                range("offset", p.offset, -0.5, 0.5)?;
                range("gamma", p.gamma, 0.1, 9.99)
            }
            Adjustment::Vibrance(p) => {
                range("vibrance", p.vibrance, -100.0, 100.0)?;
                range("saturation", p.saturation, -100.0, 100.0)
            }
            Adjustment::HueSaturation(p) => {
                range("master.hue", p.master.hue, -180.0, 180.0)?;
                range("master.saturation", p.master.saturation, -100.0, 100.0)?;
                range("master.lightness", p.master.lightness, -100.0, 100.0)?;
                for (i, r) in p.ranges.iter().enumerate() {
                    range(&format!("ranges[{i}].hue"), r.hue, -100.0, 100.0)?;
                    range(&format!("ranges[{i}].saturation"), r.saturation, -100.0, 100.0)?;
                    range(&format!("ranges[{i}].lightness"), r.lightness, -100.0, 100.0)?;
                }
                range("colorize_values.hue", p.colorize_values.hue, 0.0, 360.0)?;
                range("colorize_values.saturation", p.colorize_values.saturation, 0.0, 100.0)?;
                range("colorize_values.lightness", p.colorize_values.lightness, -100.0, 100.0)
            }
            Adjustment::ColorBalance(p) => {
                for (field, row) in [("shadows", p.shadows), ("midtones", p.midtones), ("highlights", p.highlights)] {
                    for (i, v) in row.into_iter().enumerate() {
                        range(&format!("{field}[{i}]"), v, -100.0, 100.0)?;
                    }
                }
                Ok(())
            }
            Adjustment::BlackWhite(p) => {
                for (field, v) in
                    [("reds", p.reds), ("yellows", p.yellows), ("greens", p.greens), ("cyans", p.cyans), ("blues", p.blues), ("magentas", p.magentas)]
                {
                    range(field, v, -200.0, 300.0)?;
                }
                Ok(())
            }
            Adjustment::PhotoFilter(p) => range("density", p.density, 0.0, 100.0),
            Adjustment::ChannelMixer(p) => {
                for (field, row) in [("red", p.red), ("green", p.green), ("blue", p.blue), ("gray", p.gray)] {
                    for (i, v) in row.into_iter().enumerate() {
                        range(&format!("{field}[{i}]"), v, -200.0, 200.0)?;
                    }
                }
                Ok(())
            }
            Adjustment::Posterize(p) => {
                if p.levels < 2 {
                    return Err(format!("levels must be between 2 and 255, got {}", p.levels));
                }
                Ok(())
            }
            Adjustment::Threshold(p) => {
                if p.level < 1 {
                    return Err(format!("level must be between 1 and 255, got {}", p.level));
                }
                Ok(())
            }
            Adjustment::SelectiveColor(p) => {
                for (field, row) in [
                    ("reds", p.reds),
                    ("yellows", p.yellows),
                    ("greens", p.greens),
                    ("cyans", p.cyans),
                    ("blues", p.blues),
                    ("magentas", p.magentas),
                    ("whites", p.whites),
                    ("neutrals", p.neutrals),
                    ("blacks", p.blacks),
                ] {
                    for (i, v) in row.into_iter().enumerate() {
                        range(&format!("{field}[{i}]"), v, -100.0, 100.0)?;
                    }
                }
                Ok(())
            }
            // Invert has no params; gradient map's stops are clamped, not rejected; color
            // lookup's table-size bound already runs in `parse_cube`/`parse_3dl`.
            Adjustment::Invert(_) | Adjustment::GradientMap(_) | Adjustment::ColorLookup(_) => Ok(()),
        }
    }

    /// The `Adjust` opcode and data, or none when the params are neutral. `hdr` (a 32-bit
    /// document) lets Exposure read and write values above 1.
    pub fn compile(&self, blobs: &HashMap<u64, Arc<Vec<u8>>>, hdr: bool) -> Result<Option<Compiled>, String> {
        let per_pixel = |opcode, data| Ok(Some(Compiled { opcode, data }));
        match self {
            Adjustment::Invert(_) => per_pixel(OP_INVERT, Vec::new()),
            Adjustment::BrightnessContrast(p) => {
                if p.brightness == 0.0 && p.contrast == 0.0 {
                    return Ok(None);
                }
                let f = |x| brightness_contrast(x, p);
                Ok(Some(table(false, [&f, &f, &f])))
            }
            Adjustment::Levels(p) => {
                let recs = [&p.red, &p.green, &p.blue];
                if level_neutral(&p.composite) && recs.iter().all(|r| r.as_ref().is_none_or(level_neutral)) {
                    return Ok(None);
                }
                let f = |ch: usize| {
                    move |x| {
                        let x = recs[ch].as_ref().map_or(x, |r| level(x, r));
                        level(x, &p.composite)
                    }
                };
                let (r, g, b) = (f(0), f(1), f(2));
                Ok(Some(table(false, [&r, &g, &b])))
            }
            Adjustment::Curves(p) => {
                let curves = [&p.red, &p.green, &p.blue];
                if curve_neutral(&p.composite) && curves.iter().all(|c| c.as_deref().is_none_or(curve_neutral)) {
                    return Ok(None);
                }
                let pencil = p.mode == CurveMode::Pencil;
                let comp = Curve::new(&p.composite, pencil);
                let chans = curves.map(|c| c.as_deref().map(|pts| Curve::new(pts, pencil)));
                let f = |ch: usize| {
                    let (comp, c) = (&comp, &chans[ch]);
                    move |x| comp.at(c.as_ref().map_or(x, |c| c.at(x)))
                };
                let (r, g, b) = (f(0), f(1), f(2));
                Ok(Some(table(pencil, [&r, &g, &b])))
            }
            Adjustment::Exposure(p) => {
                if p.exposure == 0.0 && p.offset == 0.0 && p.gamma == 1.0 {
                    return Ok(None);
                }
                if hdr {
                    return per_pixel(OP_EXPOSURE, vec![p.exposure, p.offset, p.gamma]);
                }
                let f = |x| exposure(x, p);
                Ok(Some(table(false, [&f, &f, &f])))
            }
            Adjustment::Posterize(p) => {
                let n = p.levels.max(2) as f64 - 1.0;
                let f = |x: f64| (x * n).round() / n;
                Ok(Some(table(true, [&f, &f, &f])))
            }
            Adjustment::Threshold(p) => {
                // Entries sit 1/257 apart in 0..255 units, so the epsilon only absorbs rounding.
                let level = p.level.max(1) as f64;
                let f = |x: f64| if x * 255.0 >= level - 1e-7 { 1.0 } else { 0.0 };
                Ok(Some(table(true, [&f, &f, &f])))
            }
            Adjustment::Vibrance(p) => {
                if p.vibrance == 0.0 && p.saturation == 0.0 {
                    return Ok(None);
                }
                per_pixel(OP_VIBRANCE, vec![p.vibrance, p.saturation])
            }
            Adjustment::HueSaturation(p) => {
                let zero = |h: &Hsl| h.hue == 0.0 && h.saturation == 0.0 && h.lightness == 0.0;
                let ranges_zero = p.ranges.iter().all(|r| r.hue == 0.0 && r.saturation == 0.0 && r.lightness == 0.0);
                if !p.colorize && zero(&p.master) && ranges_zero {
                    return Ok(None);
                }
                let (m, c) = (&p.master, &p.colorize_values);
                let mut data = vec![p.colorize as u8 as f32, m.hue, m.saturation, m.lightness, c.hue, c.saturation, c.lightness];
                for r in &p.ranges {
                    data.extend(r.bands);
                    data.extend([r.hue, r.saturation, r.lightness]);
                }
                per_pixel(OP_HUE_SATURATION, data)
            }
            Adjustment::ColorBalance(p) => {
                let rows = [p.shadows, p.midtones, p.highlights];
                if rows.iter().flatten().all(|&v| v == 0.0) {
                    return Ok(None);
                }
                let mut data = vec![p.preserve_luminosity as u8 as f32];
                data.extend(rows.iter().flatten().map(|v| v / 100.0));
                per_pixel(OP_COLOR_BALANCE, data)
            }
            Adjustment::BlackWhite(p) => {
                let [h, s, _] = rgb_to_hsl(p.tint_color.map(|v| v as f32 / 255.0));
                let w = [p.reds, p.yellows, p.greens, p.cyans, p.blues, p.magentas].map(|v| v / 100.0);
                let mut data = w.to_vec();
                data.extend([p.tint as u8 as f32, h, s]);
                per_pixel(OP_BLACK_WHITE, data)
            }
            Adjustment::PhotoFilter(p) => {
                if p.density == 0.0 || p.color == [255; 3] {
                    return Ok(None);
                }
                let d = p.density / 100.0;
                let mut data = vec![p.preserve_luminosity as u8 as f32];
                data.extend(p.color.map(|c| 1.0 - d + d * c as f32 / 255.0));
                per_pixel(OP_PHOTO_FILTER, data)
            }
            Adjustment::ChannelMixer(p) => {
                let rows = if p.monochrome { [p.gray; 3] } else { [p.red, p.green, p.blue] };
                if rows == [[100.0, 0.0, 0.0, 0.0], [0.0, 100.0, 0.0, 0.0], [0.0, 0.0, 100.0, 0.0]] {
                    return Ok(None);
                }
                per_pixel(OP_CHANNEL_MIXER, rows.iter().flatten().map(|v| v / 100.0).collect())
            }
            Adjustment::SelectiveColor(p) => {
                let fams = [p.reds, p.yellows, p.greens, p.cyans, p.blues, p.magentas, p.whites, p.neutrals, p.blacks];
                if fams.iter().flatten().all(|&v| v == 0.0) {
                    return Ok(None);
                }
                let mut data = vec![(p.mode == SelectiveMode::Absolute) as u8 as f32];
                data.extend(fams.iter().flatten().map(|v| v / 100.0));
                per_pixel(OP_SELECTIVE_COLOR, data)
            }
            Adjustment::GradientMap(p) => {
                let mut data = vec![p.dither as u8 as f32];
                data.extend(p.gradient.color_table(p.reverse, GRADIENT_N).into_iter().flatten());
                per_pixel(OP_GRADIENT_MAP, data)
            }
            Adjustment::ColorLookup(p) => {
                let Some(id) = p.table else { return Ok(None) };
                let bytes = blobs.get(&id).ok_or_else(|| format!("missing lookup table blob {id}"))?;
                let lut = match p.format {
                    LutFormat::Cube => parse_cube(bytes)?,
                    LutFormat::ThreeDl => parse_3dl(bytes)?,
                };
                Ok(Some(lut.compile(p.interpolation, p.dither)))
            }
        }
    }
}

fn range(field: &str, v: f32, lo: f32, hi: f32) -> Result<(), String> {
    if v < lo || v > hi {
        return Err(format!("{field} must be between {lo} and {hi}, got {v}"));
    }
    Ok(())
}

// A TABLE block sampling each channel function at `i / (TABLE_N - 1)`, clamped to 0..1.
fn table(nearest: bool, fs: [&dyn Fn(f64) -> f64; 3]) -> Compiled {
    let mut data = Vec::with_capacity(2 + 3 * TABLE_N);
    data.extend([nearest as u8 as f32, TABLE_N as f32]);
    for f in fs {
        data.extend((0..TABLE_N).map(|i| f(i as f64 / (TABLE_N - 1) as f64).clamp(0.0, 1.0) as f32));
    }
    Compiled { opcode: OP_TABLE, data }
}

fn brightness_contrast(x: f64, p: &BrightnessContrast) -> f64 {
    let (b, c) = (p.brightness as f64, p.contrast as f64);
    if p.legacy {
        // Contrast 100 is a step at 0.5; the floor keeps the slope finite.
        let f = if c >= 0.0 { 1.0 / (1.0 - c / 100.0).max(1e-6) } else { 1.0 + c / 100.0 };
        return (x + b / 200.0 - 0.5) * f + 0.5;
    }
    let b = b / 150.0;
    let x = if b >= 0.0 { x.powf(1.0 / (1.0 + 2.0 * b)) } else { x.powf(1.0 - 2.0 * b) };
    let m = 127.0 / 255.0;
    if c > 0.0 {
        let k = 1.0 + 3.0 * c / 100.0;
        if x < m { m * (x / m).powf(k) } else { 1.0 - (1.0 - m) * ((1.0 - x) / (1.0 - m)).powf(k) }
    } else {
        m + (x - m) * (1.0 + c / 100.0)
    }
}

fn level_neutral(r: &LevelsRecord) -> bool {
    (r.input_black, r.input_white, r.gamma, r.output_black, r.output_white) == (0, 255, 1.0, 0, 255)
}

fn level(x: f64, r: &LevelsRecord) -> f64 {
    let (ib, iw) = (r.input_black as f64 / 255.0, r.input_white as f64 / 255.0);
    let v = if iw <= ib { (x >= ib) as u8 as f64 } else { ((x - ib) / (iw - ib)).clamp(0.0, 1.0) };
    let v = v.powf(1.0 / (r.gamma as f64).clamp(0.01, 9.99));
    (r.output_black as f64 + v * (r.output_white as f64 - r.output_black as f64)) / 255.0
}

fn exposure(x: f64, p: &Exposure) -> f64 {
    expose(x, p.exposure, p.offset, p.gamma)
}

fn expose(x: f64, exposure: f32, offset: f32, gamma: f32) -> f64 {
    let v = srgb_to_linear(x as f32) as f64 * (exposure as f64).exp2() + offset as f64;
    let v = v.signum() * v.abs().powf(1.0 / (gamma as f64).clamp(0.1, 9.99));
    linear_to_srgb(v as f32) as f64
}

// Identity when every point lies on the diagonal and both ends are present.
fn curve_neutral(pts: &[[u8; 2]]) -> bool {
    pts.iter().all(|p| p[0] == p[1]) && pts.iter().any(|p| p[0] == 0) && pts.iter().any(|p| p[0] == 255)
}

/// A curve through (input, output) points in 0..255: natural cubic spline or, for pencil,
/// linear; flat beyond the end points.
pub(crate) struct Curve {
    pts: Vec<(f64, f64)>,
    y2: Vec<f64>,
    pencil: bool,
}

impl Curve {
    pub(crate) fn new(points: &[[u8; 2]], pencil: bool) -> Curve {
        let mut sorted = points.to_vec();
        sorted.sort_by_key(|p| p[0]);
        let mut pts: Vec<(f64, f64)> = Vec::new();
        for p in sorted {
            let q = (p[0] as f64, p[1] as f64);
            match pts.last_mut() {
                Some(last) if last.0 == q.0 => *last = q,
                _ => pts.push(q),
            }
        }
        // Natural spline second derivatives (tridiagonal solve, zero at both ends).
        let n = pts.len();
        let mut y2 = vec![0.0; n];
        if n > 2 {
            let mut u = vec![0.0; n];
            for i in 1..n - 1 {
                let sig = (pts[i].0 - pts[i - 1].0) / (pts[i + 1].0 - pts[i - 1].0);
                let p = sig * y2[i - 1] + 2.0;
                y2[i] = (sig - 1.0) / p;
                let d = (pts[i + 1].1 - pts[i].1) / (pts[i + 1].0 - pts[i].0)
                    - (pts[i].1 - pts[i - 1].1) / (pts[i].0 - pts[i - 1].0);
                u[i] = (6.0 * d / (pts[i + 1].0 - pts[i - 1].0) - sig * u[i - 1]) / p;
            }
            for i in (1..n - 1).rev() {
                y2[i] = y2[i] * y2[i + 1] + u[i];
            }
        }
        Curve { pts, y2, pencil }
    }

    pub(crate) fn at(&self, x: f64) -> f64 {
        let pts = &self.pts;
        let Some(&(x0, y0)) = pts.first() else { return x };
        let (xn, yn) = pts[pts.len() - 1];
        let x = x * 255.0;
        let y = if x <= x0 {
            y0
        } else if x >= xn {
            yn
        } else {
            let hi = pts.iter().position(|p| p.0 >= x).expect("x is inside the points");
            let ((xa, ya), (xb, yb)) = (pts[hi - 1], pts[hi]);
            let h = xb - xa;
            let (a, b) = ((xb - x) / h, (x - xa) / h);
            if self.pencil {
                ya * a + yb * b
            } else {
                a * ya + b * yb + ((a * a * a - a) * self.y2[hi - 1] + (b * b * b - b) * self.y2[hi]) * h * h / 6.0
            }
        };
        (y / 255.0).clamp(0.0, 1.0)
    }
}

// ---------- per-pixel kernels (the WGSL `adjust_rgb` mirrors these) ----------

/// One straight color (0..1) through an `Adjust` opcode and its data; `(x, y)` are document px
/// for the dither hash.
pub fn apply(opcode: u32, d: &[f32], c: [f32; 3], x: u32, y: u32) -> [f32; 3] {
    let clamp = |c: [f32; 3]| c.map(|v| v.clamp(0.0, 1.0));
    match opcode {
        OP_INVERT => c.map(|v| 1.0 - v),
        OP_EXPOSURE => c.map(|v| expose(v as f64, d[0], d[1], d[2]) as f32),
        OP_TABLE => {
            let n = d[1] as usize;
            std::array::from_fn(|ch| {
                let t = &d[2 + ch * n..2 + (ch + 1) * n];
                let pos = c[ch].clamp(0.0, 1.0) * (n - 1) as f32;
                if d[0] != 0.0 {
                    return t[pos.round() as usize];
                }
                let i = (pos.floor() as usize).min(n - 2);
                t[i] + (t[i + 1] - t[i]) * (pos - i as f32)
            })
        }
        OP_VIBRANCE => {
            let [h, s, l] = rgb_to_hsl(c);
            if s <= 0.0 && d[0] >= 0.0 && d[1] >= 0.0 {
                return c;
            }
            let s1 = sat_by(s, d[1]);
            let dist = (h - 25.0).rem_euclid(360.0);
            let dist = dist.min(360.0 - dist);
            let skin = if dist >= 40.0 { 1.0 } else { 0.5 + 0.5 * dist / 40.0 };
            hsl_to_rgb(h, sat_by(s1, d[0] * (1.0 - s1) * skin), l)
        }
        OP_HUE_SATURATION => {
            let [h, s, l] = rgb_to_hsl(c);
            if d[0] != 0.0 {
                return hsl_to_rgb(d[4], d[5] / 100.0, light_by(l, d[6]));
            }
            let (mut dh, mut ds, mut dl) = (d[1], d[2], d[3]);
            for r in d[7..].chunks_exact(7) {
                let w = hue_weight(h, [r[0], r[1], r[2], r[3]]);
                dh += r[4] * w;
                ds += r[5] * w;
                dl += r[6] * w;
            }
            hsl_to_rgb(h + dh, sat_by(s, ds), light_by(l, dl))
        }
        OP_COLOR_BALANCE => {
            let out = clamp(std::array::from_fn(|i| {
                let v = c[i];
                let ws = ((v - 0.333) / -0.25 + 0.5).clamp(0.0, 1.0) * 0.7;
                let wm = ((v - 0.333) / 0.25 + 0.5).clamp(0.0, 1.0) * ((v - 0.667) / -0.25 + 0.5).clamp(0.0, 1.0) * 0.7;
                let wh = ((v - 0.667) / 0.25 + 0.5).clamp(0.0, 1.0) * 0.7;
                v + d[1 + i] * ws + d[4 + i] * wm + d[7 + i] * wh
            }));
            if d[0] != 0.0 { clamp(set_lum(out, lum(c))) } else { out }
        }
        OP_BLACK_WHITE => {
            let [hi, mid, lo] = order(c);
            // Families: 0 reds, 1 yellows, 2 greens, 3 cyans, 4 blues, 5 magentas.
            let primary = [0, 2, 4][hi];
            let secondary = [3, 5, 1][lo];
            let g = (c[lo] + (c[hi] - c[mid]) * d[primary] + (c[mid] - c[lo]) * d[secondary]).clamp(0.0, 1.0);
            if d[6] != 0.0 { hsl_to_rgb(d[7], d[8], g) } else { [g; 3] }
        }
        OP_PHOTO_FILTER => {
            let out = clamp(std::array::from_fn(|i| c[i] * d[1 + i]));
            if d[0] != 0.0 { clamp(set_lum(out, lum(c))) } else { out }
        }
        OP_CHANNEL_MIXER => clamp(std::array::from_fn(|i| {
            let r = &d[i * 4..i * 4 + 4];
            r[3] + r[0] * c[0] + r[1] * c[1] + r[2] * c[2]
        })),
        OP_SELECTIVE_COLOR => {
            let [hi, mid, lo] = order(c);
            let (max, min) = (c[hi], c[lo]);
            let mut w = [0f32; 9];
            w[[0, 2, 4][hi]] = max - c[mid];
            w[[3, 5, 1][lo]] = c[mid] - min;
            w[6] = (2.0 * min - 1.0).max(0.0);
            w[8] = (1.0 - 2.0 * max).max(0.0);
            w[7] = 1.0 - w[6] - w[8];
            let k = 1.0 - max;
            let mut v = [1.0 - c[0] - k, 1.0 - c[1] - k, 1.0 - c[2] - k, k];
            for (j, v) in v.iter_mut().enumerate() {
                let adj: f32 = (0..9).map(|f| d[1 + f * 4 + j] * w[f]).sum();
                *v = (*v + if d[0] != 0.0 { adj } else { *v * adj }).clamp(0.0, 1.0);
            }
            clamp([1.0 - v[0] - v[3], 1.0 - v[1] - v[3], 1.0 - v[2] - v[3]])
        }
        OP_GRADIENT_MAP => {
            let mut t = lum(c);
            if d[0] != 0.0 {
                t += (dissolve_hash(x, y, 0) - 0.5) / (GRADIENT_N - 1) as f32;
            }
            let pos = t.clamp(0.0, 1.0) * (GRADIENT_N - 1) as f32;
            let i = (pos.floor() as usize).min(GRADIENT_N - 2);
            let f = pos - i as f32;
            std::array::from_fn(|ch| d[1 + i * 3 + ch] + (d[1 + (i + 1) * 3 + ch] - d[1 + i * 3 + ch]) * f)
        }
        OP_COLOR_LOOKUP => lookup_3d(d, c, x, y),
        _ => c,
    }
}

// Channel indices of the largest, middle and smallest value.
fn order(c: [f32; 3]) -> [usize; 3] {
    let mut i = [0usize, 1, 2];
    i.sort_by(|&a, &b| c[b].partial_cmp(&c[a]).unwrap_or(std::cmp::Ordering::Equal));
    i
}

fn sat_by(s: f32, g: f32) -> f32 {
    let v = if g == 0.0 {
        s
    } else if g < 0.0 {
        s * (1.0 + g / 100.0)
    } else if g >= 100.0 {
        1.0
    } else {
        s / (1.0 - g / 100.0)
    };
    v.clamp(0.0, 1.0)
}

fn light_by(l: f32, g: f32) -> f32 {
    let v = if g < 0.0 { l * (1.0 + g / 100.0) } else { l + (1.0 - l) * g / 100.0 };
    v.clamp(0.0, 1.0)
}

// Weight 1 inside b..c, linear ramps a..b and c..d, positions measured mod 360 from a.
fn hue_weight(h: f32, [a, b, c, d]: [f32; 4]) -> f32 {
    let m = |v: f32| (v - a).rem_euclid(360.0);
    let (u, b, c, d) = (m(h), m(b), m(c), m(d));
    if u < b {
        u / b
    } else if u <= c {
        1.0
    } else if u < d {
        (d - u) / (d - c)
    } else {
        0.0
    }
}

/// Standard HSL: hue in degrees 0..360, saturation and lightness 0..1.
pub fn rgb_to_hsl([r, g, b]: [f32; 3]) -> [f32; 3] {
    let (mx, mn) = (r.max(g).max(b), r.min(g).min(b));
    let l = (mx + mn) / 2.0;
    let d = mx - mn;
    if d <= 0.0 {
        return [0.0, 0.0, l];
    }
    let s = if l > 0.5 { d / (2.0 - mx - mn) } else { d / (mx + mn) };
    let h = if mx == r {
        (g - b) / d + if g < b { 6.0 } else { 0.0 }
    } else if mx == g {
        (b - r) / d + 2.0
    } else {
        (r - g) / d + 4.0
    };
    [h * 60.0, s, l]
}

pub fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    let a = s * l.min(1.0 - l);
    let f = |n: f32| {
        let k = (n + h.rem_euclid(360.0) / 30.0) % 12.0;
        (l - a * (k - 3.0).min(9.0 - k).clamp(-1.0, 1.0)).clamp(0.0, 1.0)
    };
    [f(0.0), f(8.0), f(4.0)]
}

// The OP_COLOR_LOOKUP kernel: index `clamp((v - dmin)/(dmax - dmin)) * (n - 1)`, optional dither
// `(hash - 0.5)/(n - 1)`, then tetrahedral or trilinear interpolation.
fn lookup_3d(d: &[f32], c: [f32; 3], x: u32, y: u32) -> [f32; 3] {
    let n = d[0] as usize;
    let dither = if d[8] != 0.0 { (dissolve_hash(x, y, 0) - 0.5) / (n - 1) as f32 } else { 0.0 };
    let pos: [f32; 3] = std::array::from_fn(|i| {
        let span = d[4 + i] - d[1 + i];
        let t = if span > 0.0 { (c[i] - d[1 + i]) / span } else { 0.0 };
        (t.clamp(0.0, 1.0) + dither).clamp(0.0, 1.0) * (n - 1) as f32
    });
    let i0 = pos.map(|p| (p.floor() as usize).min(n - 2));
    let [fr, fg, fb]: [f32; 3] = std::array::from_fn(|i| pos[i] - i0[i] as f32);
    let t = &d[9..];
    let at = |r: usize, g: usize, b: usize| -> [f32; 3] {
        let o = (((i0[2] + b) * n + i0[1] + g) * n + i0[0] + r) * 3;
        [t[o], t[o + 1], t[o + 2]]
    };
    let sum = |terms: &[(f32, [f32; 3])]| -> [f32; 3] {
        std::array::from_fn(|ch| terms.iter().map(|(w, v)| w * v[ch]).sum::<f32>().clamp(0.0, 1.0))
    };
    let (c000, c111) = (at(0, 0, 0), at(1, 1, 1));
    if d[7] != 0.0 {
        let lerp = |a: [f32; 3], b: [f32; 3], f: f32| -> [f32; 3] { std::array::from_fn(|i| a[i] + (b[i] - a[i]) * f) };
        let r00 = lerp(c000, at(1, 0, 0), fr);
        let r10 = lerp(at(0, 1, 0), at(1, 1, 0), fr);
        let r01 = lerp(at(0, 0, 1), at(1, 0, 1), fr);
        let r11 = lerp(at(0, 1, 1), c111, fr);
        return sum(&[(1.0, lerp(lerp(r00, r10, fg), lerp(r01, r11, fg), fb))]);
    }
    if fr > fg {
        if fg > fb {
            sum(&[(1.0 - fr, c000), (fr - fg, at(1, 0, 0)), (fg - fb, at(1, 1, 0)), (fb, c111)])
        } else if fr > fb {
            sum(&[(1.0 - fr, c000), (fr - fb, at(1, 0, 0)), (fb - fg, at(1, 0, 1)), (fg, c111)])
        } else {
            sum(&[(1.0 - fb, c000), (fb - fr, at(0, 0, 1)), (fr - fg, at(1, 0, 1)), (fg, c111)])
        }
    } else if fb > fg {
        sum(&[(1.0 - fb, c000), (fb - fg, at(0, 0, 1)), (fg - fr, at(0, 1, 1)), (fr, c111)])
    } else if fb > fr {
        sum(&[(1.0 - fg, c000), (fg - fb, at(0, 1, 0)), (fb - fr, at(0, 1, 1)), (fr, c111)])
    } else {
        sum(&[(1.0 - fg, c000), (fg - fr, at(0, 1, 0)), (fr - fb, at(1, 1, 0)), (fb, c111)])
    }
}

// ---------- .cube / .3dl ----------

/// A parsed lookup table: `size` entries per axis (3D, red fastest) or per channel (1D), RGB.
#[derive(Clone, Debug, PartialEq)]
pub struct Lut {
    pub size: usize,
    pub one_d: bool,
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
    pub data: Vec<f32>,
}

impl Lut {
    fn compile(&self, interpolation: LutInterpolation, dither: bool) -> Compiled {
        if self.one_d {
            // A 1D table resampled onto the compositor table; dither does not apply to it.
            let n = self.size;
            let f = |ch: usize| {
                move |x: f64| {
                    let span = (self.domain_max[ch] - self.domain_min[ch]) as f64;
                    let t = if span > 0.0 { (x - self.domain_min[ch] as f64) / span } else { 0.0 };
                    let pos = t.clamp(0.0, 1.0) * (n - 1) as f64;
                    let i = (pos.floor() as usize).min(n - 2);
                    let (a, b) = (self.data[i * 3 + ch] as f64, self.data[(i + 1) * 3 + ch] as f64);
                    a + (b - a) * (pos - i as f64)
                }
            };
            let (r, g, b) = (f(0), f(1), f(2));
            return table(false, [&r, &g, &b]);
        }
        let mut data = vec![self.size as f32];
        data.extend(self.domain_min);
        data.extend(self.domain_max);
        data.extend([(interpolation == LutInterpolation::Trilinear) as u8 as f32, dither as u8 as f32]);
        data.extend(&self.data);
        Compiled { opcode: OP_COLOR_LOOKUP, data }
    }
}

fn numbers(line: usize, toks: &[&str]) -> Result<Vec<f32>, String> {
    toks.iter()
        .map(|t| t.parse::<f32>().ok().filter(|v| v.is_finite()).ok_or_else(|| format!("line {line}: not a number: {t}")))
        .collect()
}

fn check_size(line: usize, n: usize, one_d: bool) -> Result<(), String> {
    let entries = if one_d { n } else { n.saturating_pow(3) };
    if n < 2 || entries.saturating_mul(12) > LUT_BYTES {
        return Err(format!("line {line}: table size {n} is below 2 or above 16 MB"));
    }
    Ok(())
}

/// A `.cube` file: `TITLE`, `LUT_1D_SIZE` or `LUT_3D_SIZE`, `DOMAIN_MIN`/`DOMAIN_MAX`, then RGB
/// rows (red fastest); `#` starts a comment.
pub fn parse_cube(bytes: &[u8]) -> Result<Lut, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "the lookup table is not UTF-8 text".to_string())?;
    let mut lut = Lut { size: 0, one_d: false, domain_min: [0.0; 3], domain_max: [1.0; 3], data: Vec::new() };
    let mut last = 0;
    for (i, raw) in text.lines().enumerate() {
        let line = i + 1;
        let body = raw.split('#').next().unwrap_or("").trim();
        if body.is_empty() {
            continue;
        }
        last = line;
        let toks: Vec<&str> = body.split_whitespace().collect();
        match toks[0] {
            "TITLE" => {}
            "LUT_1D_SIZE" | "LUT_3D_SIZE" => {
                if lut.size != 0 {
                    return Err(format!("line {line}: a second table size"));
                }
                let n = toks.get(1).and_then(|t| t.parse::<usize>().ok()).ok_or(format!("line {line}: bad table size"))?;
                lut.one_d = toks[0] == "LUT_1D_SIZE";
                check_size(line, n, lut.one_d)?;
                lut.size = n;
            }
            "DOMAIN_MIN" | "DOMAIN_MAX" => {
                let v = numbers(line, &toks[1..])?;
                let v: [f32; 3] = v.try_into().map_err(|_| format!("line {line}: {} needs three numbers", toks[0]))?;
                if toks[0] == "DOMAIN_MIN" {
                    lut.domain_min = v;
                } else {
                    lut.domain_max = v;
                }
            }
            "LUT_1D_INPUT_RANGE" | "LUT_3D_INPUT_RANGE" => {
                let v = numbers(line, &toks[1..])?;
                let [lo, hi]: [f32; 2] = v.try_into().map_err(|_| format!("line {line}: {} needs two numbers", toks[0]))?;
                (lut.domain_min, lut.domain_max) = ([lo; 3], [hi; 3]);
            }
            _ => {
                if lut.size == 0 {
                    return Err(format!("line {line}: data before the table size"));
                }
                if toks.len() != 3 {
                    return Err(format!("line {line}: expected three numbers"));
                }
                if lut.data.len() >= 3 * if lut.one_d { lut.size } else { lut.size.pow(3) } {
                    return Err(format!("line {line}: more rows than the table size"));
                }
                lut.data.extend(numbers(line, &toks)?);
            }
        }
    }
    let want = 3 * if lut.one_d { lut.size } else { lut.size.pow(3) };
    if lut.size == 0 || lut.data.len() != want {
        return Err(format!("line {}: expected {} rows, found {}", last + 1, want / 3, lut.data.len() / 3));
    }
    Ok(lut)
}

/// A `.3dl` file: an optional shaper line of input values, then RGB rows (blue fastest). The node
/// count is the cube root of the row count; the scale is the smallest of 1, 255, 1023, 4095 and
/// 65535 holding the largest value.
pub fn parse_3dl(bytes: &[u8]) -> Result<Lut, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "the lookup table is not UTF-8 text".to_string())?;
    let mut rows: Vec<[f32; 3]> = Vec::new();
    let mut last = 0;
    for (i, raw) in text.lines().enumerate() {
        let line = i + 1;
        let body = raw.split('#').next().unwrap_or("").trim();
        let keyword = ["3DMESH", "Mesh", "LUT8", "gamma"].iter().any(|k| body.starts_with(k));
        if body.is_empty() || keyword {
            continue;
        }
        last = line;
        let toks: Vec<&str> = body.split_whitespace().collect();
        let v = numbers(line, &toks)?;
        match v.len() {
            3 => rows.push([v[0], v[1], v[2]]),
            n if n != 3 && rows.is_empty() => {} // the shaper line
            _ => return Err(format!("line {line}: expected three numbers")),
        }
        if rows.len() * 12 > LUT_BYTES {
            return Err(format!("line {line}: the table is larger than 16 MB"));
        }
    }
    let n = (rows.len() as f64).cbrt().round() as usize;
    if n < 2 || n * n * n != rows.len() {
        return Err(format!("line {}: {} rows is not a cube of at least 2", last + 1, rows.len()));
    }
    let max = rows.iter().flatten().fold(0f32, |m, &v| m.max(v));
    let scale = [1.0, 255.0, 1023.0, 4095.0, 65535.0].into_iter().find(|&s| max <= s).unwrap_or(65535.0);
    let mut data = vec![0f32; rows.len() * 3];
    for (k, row) in rows.iter().enumerate() {
        let (r, g, b) = (k / (n * n), (k / n) % n, k % n);
        let o = ((b * n + g) * n + r) * 3;
        for ch in 0..3 {
            data[o + ch] = row[ch] / scale;
        }
    }
    Ok(Lut { size: n, one_d: false, domain_min: [0.0; 3], domain_max: [1.0; 3], data })
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrightnessContrast {
    pub brightness: f32,
    pub contrast: f32,
    pub legacy: bool,
}

/// Input black/white 0..255, gamma 0.01..9.99, output black/white 0..255.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LevelsRecord {
    pub input_black: u8,
    pub input_white: u8,
    pub gamma: f32,
    pub output_black: u8,
    pub output_white: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Levels {
    pub composite: LevelsRecord,
    pub red: Option<LevelsRecord>,
    pub green: Option<LevelsRecord>,
    pub blue: Option<LevelsRecord>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CurveMode {
    Point,
    Pencil,
}

/// Points are (input, output) pairs in 0..255.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Curves {
    pub mode: CurveMode,
    pub composite: Vec<[u8; 2]>,
    pub red: Option<Vec<[u8; 2]>>,
    pub green: Option<Vec<[u8; 2]>>,
    pub blue: Option<Vec<[u8; 2]>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exposure {
    pub exposure: f32,
    pub offset: f32,
    pub gamma: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vibrance {
    pub vibrance: f32,
    pub saturation: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hsl {
    pub hue: f32,
    pub saturation: f32,
    pub lightness: f32,
}

/// One of the six hue ranges: bands [a, b, c, d] in degrees and its deltas.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HueRange {
    pub bands: [f32; 4],
    pub hue: f32,
    pub saturation: f32,
    pub lightness: f32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HueSaturation {
    pub master: Hsl,
    pub ranges: [HueRange; 6],
    pub colorize: bool,
    pub colorize_values: Hsl,
}

/// Each tone row is cyan-red, magenta-green, yellow-blue in -100..100.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColorBalance {
    pub shadows: [f32; 3],
    pub midtones: [f32; 3],
    pub highlights: [f32; 3],
    pub preserve_luminosity: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlackWhite {
    pub reds: f32,
    pub yellows: f32,
    pub greens: f32,
    pub cyans: f32,
    pub blues: f32,
    pub magentas: f32,
    pub tint: bool,
    pub tint_color: [u8; 3],
}

/// The filter color (a preset or custom), density 0..100.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhotoFilter {
    pub color: [u8; 3],
    pub density: f32,
    pub preserve_luminosity: bool,
}

/// Each row is the red, green and blue weights and the constant, in percent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelMixer {
    pub red: [f32; 4],
    pub green: [f32; 4],
    pub blue: [f32; 4],
    pub gray: [f32; 4],
    pub monochrome: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LutFormat {
    Cube,
    #[serde(rename = "3dl")]
    ThreeDl,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LutInterpolation {
    Tetrahedral,
    Trilinear,
}

/// `table` is the blob holding the `.cube`/`.3dl` file bytes; none = identity.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColorLookup {
    pub name: String,
    pub format: LutFormat,
    pub table: Option<u64>,
    pub interpolation: LutInterpolation,
    pub dither: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invert {}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Posterize {
    pub levels: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Threshold {
    pub level: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GradientMap {
    pub gradient: GradientDef,
    pub reverse: bool,
    pub dither: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectiveMode {
    Relative,
    Absolute,
}

/// Each family is the cyan, magenta, yellow and black adjustment in -100..100 %.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectiveColor {
    pub mode: SelectiveMode,
    pub reds: [f32; 4],
    pub yellows: [f32; 4],
    pub greens: [f32; 4],
    pub cyans: [f32; 4],
    pub blues: [f32; 4],
    pub magentas: [f32; 4],
    pub whites: [f32; 4],
    pub neutrals: [f32; 4],
    pub blacks: [f32; 4],
}

// ---------- destructive-only kinds (docs/M3.md section 3, kinds 17-25) ----------

/// A kind that only exists as an Image menu command, never as a layer: `{ "kind", "params" }`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "snake_case", deny_unknown_fields)]
pub enum Destructive {
    ShadowsHighlights(ShadowsHighlights),
    HdrToning(HdrToning),
    Desaturate(NoParams),
    MatchColor(MatchColor),
    ReplaceColor(ReplaceColor),
    Equalize(NoParams),
    AutoTone(NoParams),
    AutoContrast(NoParams),
    AutoColor(NoParams),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoParams {}

/// Amount and tone in percent, radius in px.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ToneRange {
    pub amount: f32,
    pub tone: f32,
    pub radius: f32,
}

/// Clips are percent of the pixels (0..50).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShadowsHighlights {
    pub shadows: ToneRange,
    pub highlights: ToneRange,
    pub color_correction: f32,
    pub midtone_contrast: f32,
    pub black_clip: f32,
    pub white_clip: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HdrMethod {
    LocalAdaptation,
    ExposureGamma,
    HighlightCompression,
    EqualizeHistogram,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HdrToning {
    pub method: HdrMethod,
    pub radius: f32,
    pub strength: f32,
    pub detail: f32,
    pub shadow: f32,
    pub highlight: f32,
    pub exposure: f32,
    pub gamma: f32,
    pub vibrance: f32,
    pub saturation: f32,
}

/// Luminance and color intensity 0..200 %, fade 0..100 %; the source is the image itself.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MatchColor {
    pub luminance: f32,
    pub color_intensity: f32,
    pub fade: f32,
    pub neutralize: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReplaceColor {
    pub target_color: [u8; 3],
    pub fuzziness: f32,
    pub range: f32,
    pub localized: bool,
    pub hue: f32,
    pub saturation: f32,
    pub lightness: f32,
}

impl Destructive {
    /// Trust-boundary range check (docs/M3.md section 3); errors name the field.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Destructive::ShadowsHighlights(p) => {
                for (name, t) in [("shadows", &p.shadows), ("highlights", &p.highlights)] {
                    range(&format!("{name}.amount"), t.amount, 0.0, 100.0)?;
                    range(&format!("{name}.tone"), t.tone, 0.0, 100.0)?;
                    range(&format!("{name}.radius"), t.radius, 0.0, 2500.0)?;
                }
                range("color_correction", p.color_correction, -100.0, 100.0)?;
                range("midtone_contrast", p.midtone_contrast, -100.0, 100.0)?;
                range("black_clip", p.black_clip, 0.0, 50.0)?;
                range("white_clip", p.white_clip, 0.0, 50.0)
            }
            Destructive::HdrToning(p) => {
                range("radius", p.radius, 1.0, 500.0)?;
                range("strength", p.strength, 0.0, 1.0)?;
                range("detail", p.detail, -100.0, 300.0)?;
                range("shadow", p.shadow, -100.0, 100.0)?;
                range("highlight", p.highlight, -100.0, 100.0)?;
                range("exposure", p.exposure, -20.0, 20.0)?;
                range("gamma", p.gamma, 0.1, 9.99)?;
                range("vibrance", p.vibrance, -100.0, 100.0)?;
                range("saturation", p.saturation, -100.0, 100.0)
            }
            Destructive::MatchColor(p) => {
                range("luminance", p.luminance, 0.0, 200.0)?;
                range("color_intensity", p.color_intensity, 0.0, 200.0)?;
                range("fade", p.fade, 0.0, 100.0)
            }
            Destructive::ReplaceColor(p) => {
                range("fuzziness", p.fuzziness, 0.0, 200.0)?;
                range("range", p.range, 0.0, 100.0)?;
                range("hue", p.hue, -180.0, 180.0)?;
                range("saturation", p.saturation, -100.0, 100.0)?;
                range("lightness", p.lightness, -100.0, 100.0)
            }
            _ => Ok(()),
        }
    }
}

/// Runs a destructive kind over a straight RGBA buffer (`w x h`, 0..1) in place; alpha is never
/// written. Histograms skip pixels with alpha 0; blurs and means see every pixel.
pub fn destructive(kind: &Destructive, px: &mut [f32], w: usize, h: usize) {
    match kind {
        Destructive::Desaturate(_) => map_rgb(px, |c| {
            let [hi, _, lo] = order(c);
            [(c[hi] + c[lo]) / 2.0; 3]
        }),
        Destructive::Equalize(_) => {
            let hist = histograms(px)[0];
            let Some(first) = hist.iter().position(|&n| n > 0) else { return };
            let cdf = cumulative(&hist);
            let cdf0 = cdf[first];
            if cdf0 >= 1.0 {
                return;
            }
            map_rgb(px, |c| c.map(|v| ((cdf[bin(v)] - cdf0) / (1.0 - cdf0)).clamp(0.0, 1.0)));
        }
        Destructive::AutoTone(_) | Destructive::AutoContrast(_) | Destructive::AutoColor(_) => {
            let hs = histograms(px);
            let rec = |hist: &[u32; 256], midtone: bool| {
                let (mut b, mut wt) = (from_bottom(hist, 0.1), from_top(hist, 0.1));
                if wt <= b {
                    (b, wt) = (0, 255);
                }
                let mut gamma = 1.0;
                if midtone {
                    let p = (from_bottom(hist, 50.0) as f32 - b as f32) / (wt - b) as f32;
                    if p > 0.0 && p < 1.0 {
                        gamma = (p.ln() / (128.0f32 / 255.0).ln()).clamp(0.01, 9.99);
                    }
                }
                LevelsRecord { input_black: b as u8, input_white: wt as u8, gamma, output_black: 0, output_white: 255 }
            };
            let levels = match kind {
                Destructive::AutoContrast(_) => Levels { composite: rec(&hs[0], false), red: None, green: None, blue: None },
                _ => {
                    let color = matches!(kind, Destructive::AutoColor(_));
                    let [r, g, b] = [1, 2, 3].map(|ch| Some(rec(&hs[ch], color)));
                    let composite = LevelsRecord { input_black: 0, input_white: 255, gamma: 1.0, output_black: 0, output_white: 255 };
                    Levels { composite, red: r, green: g, blue: b }
                }
            };
            if let Ok(Some(t)) = Adjustment::Levels(levels).compile(&HashMap::new(), false) {
                map_rgb(px, |c| apply(t.opcode, &t.data, c, 0, 0));
            }
        }
        Destructive::MatchColor(p) => {
            let hs = histograms(px);
            let n = hs[1].iter().sum::<u32>() as f32;
            if n == 0.0 {
                return;
            }
            let means: [f32; 3] =
                std::array::from_fn(|ch| hs[ch + 1].iter().enumerate().map(|(i, &c)| i as f32 * c as f32).sum::<f32>() / n / 255.0);
            let gray = means.iter().sum::<f32>() / 3.0;
            let keep = 1.0 - p.fade / 100.0;
            // The source is the image itself: its deviation equals the target's, so the
            // intensity scale `1 + (src / std - 1) * intensity` stays 1.
            map_rgb(px, |c| {
                std::array::from_fn(|ch| {
                    let mean = means[ch];
                    let target = if p.neutralize { gray } else { mean };
                    let v = mean + (target - mean) * p.luminance / 100.0;
                    (c[ch] + (v + (c[ch] - mean) - c[ch]) * keep).clamp(0.0, 1.0)
                })
            });
        }
        Destructive::ReplaceColor(p) => {
            let hsb = |c: [f32; 3]| {
                let (mx, mn) = (c[0].max(c[1]).max(c[2]), c[0].min(c[1]).min(c[2]));
                [rgb_to_hsl(c)[0], if mx > 0.0 { (mx - mn) / mx } else { 0.0 }, mx]
            };
            let t = hsb(p.target_color.map(|v| v as f32 / 255.0));
            let radius = p.fuzziness * if p.localized { 1.0 - p.range / 100.0 * 0.5 } else { 1.0 } / 200.0;
            map_rgb(px, |c| {
                let s = hsb(c);
                let dh = (s[0] - t[0]).rem_euclid(360.0);
                let dh = dh.min(360.0 - dh) / 180.0;
                let d = (dh * dh * s[1].min(t[1]) + (s[1] - t[1]).powi(2) + (s[2] - t[2]).powi(2)).sqrt();
                let w = if radius >= 1.0 {
                    1.0
                } else if radius <= 0.0 {
                    (d == 0.0) as u8 as f32
                } else {
                    (1.0 - d / radius).clamp(0.0, 1.0)
                };
                if w <= 0.0 {
                    return c;
                }
                let [h, s, l] = rgb_to_hsl(c);
                hsl_to_rgb(h + p.hue * w, sat_by(s, p.saturation * w), light_by(l, p.lightness * w))
            });
        }
        Destructive::ShadowsHighlights(p) => shadows_highlights(p, px, w, h),
        Destructive::HdrToning(p) => hdr_toning(p, px, w, h),
    }
}

fn map_rgb(px: &mut [f32], f: impl Fn([f32; 3]) -> [f32; 3]) {
    for c in px.chunks_exact_mut(4) {
        let out = f([c[0], c[1], c[2]]);
        c[..3].copy_from_slice(&out);
    }
}

fn luma(c: &[f32]) -> f32 {
    lum([c[0], c[1], c[2]])
}

fn bin(v: f32) -> usize {
    (v.clamp(0.0, 1.0) * 255.0).round() as usize
}

// Luminosity, R, G and B counts of the pixels with alpha above 0.
fn histograms(px: &[f32]) -> [[u32; 256]; 4] {
    let mut h = [[0u32; 256]; 4];
    for c in px.chunks_exact(4).filter(|c| c[3] > 0.0) {
        h[0][bin(luma(c))] += 1;
        for ch in 0..3 {
            h[ch + 1][bin(c[ch])] += 1;
        }
    }
    h
}

// Cumulative count / total per bin.
fn cumulative(h: &[u32; 256]) -> [f32; 256] {
    let total = h.iter().sum::<u32>().max(1) as f32;
    let mut acc = 0;
    std::array::from_fn(|i| {
        acc += h[i];
        acc as f32 / total
    })
}

// The first non-empty bin whose cumulative count reaches `pct` % of the total, from the dark end.
fn from_bottom(h: &[u32; 256], pct: f32) -> usize {
    let need = h.iter().sum::<u32>() as f32 * pct / 100.0;
    let mut acc = 0;
    (0..256)
        .find(|&i| {
            acc += h[i];
            acc > 0 && acc as f32 >= need
        })
        .unwrap_or(0)
}

// The same from the light end.
fn from_top(h: &[u32; 256], pct: f32) -> usize {
    let need = h.iter().sum::<u32>() as f32 * pct / 100.0;
    let mut acc = 0;
    (0..256)
        .rev()
        .find(|&i| {
            acc += h[i];
            acc > 0 && acc as f32 >= need
        })
        .unwrap_or(255)
}

// Gaussian with sigma = radius / 2 as three running-sum box passes, edges clamp.
fn blur(v: &[f32], w: usize, h: usize, radius: f32) -> Vec<f32> {
    let mut out = v.to_vec();
    if radius <= 0.0 {
        return out;
    }
    for r in crate::styles::gauss_boxes(radius as f64 / 2.0) {
        let r = r.min(w.max(h));
        if r > 0 {
            out = box_pass(&box_pass(&out, w, h, r, true), w, h, r, false);
        }
    }
    out
}

fn box_pass(src: &[f32], w: usize, h: usize, r: usize, horizontal: bool) -> Vec<f32> {
    let (len, lines, step, stride) = if horizontal { (w, h, 1, w) } else { (h, w, w, 1) };
    let mut out = vec![0f32; src.len()];
    let n = (2 * r + 1) as f64;
    let r = r as isize;
    for line in 0..lines {
        let at = |i: isize| src[line * stride + i.clamp(0, len as isize - 1) as usize * step] as f64;
        let mut sum: f64 = (-r..=r).map(at).sum();
        for i in 0..len as isize {
            out[line * stride + i as usize * step] = (sum / n) as f32;
            sum += at(i + r + 1) - at(i - r);
        }
    }
    out
}

fn smoothstep(x: f32) -> f32 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

// Scales a pixel's channels from luminance `old` to `new`, keeping the hue.
fn scale_lum(c: &mut [f32], old: f32, new: f32) {
    for v in &mut c[..3] {
        *v = if old <= 0.0 { new } else { *v * new / old }.clamp(0.0, 1.0);
    }
}

fn shadows_highlights(p: &ShadowsHighlights, px: &mut [f32], w: usize, h: usize) {
    let (ls, lh) = (p.shadows.amount / 100.0, p.highlights.amount / 100.0);
    if ls > 0.0 || lh > 0.0 {
        let u: Vec<f32> = px.chunks_exact(4).map(|c| luma(c).clamp(0.0, 1.0)).collect();
        let sb = (ls > 0.0).then(|| blur(&u, w, h, p.shadows.radius));
        let hb = (lh > 0.0).then(|| blur(&u, w, h, p.highlights.radius));
        let (ts, th) = ((p.shadows.tone / 100.0).max(0.02), (p.highlights.tone / 100.0).max(0.02));
        let f = p.color_correction / 100.0;
        for (i, c) in px.chunks_exact_mut(4).enumerate() {
            let wl = u[i];
            let mut e = 1.0;
            if let Some(b) = &sb {
                let k = smoothstep((ts - b[i]) / ts);
                if k > 0.0 {
                    e /= 1.0 + 2.0 * ls * k;
                }
            }
            if let Some(b) = &hb {
                let k = smoothstep((b[i] - (1.0 - th)) / th);
                if k > 0.0 {
                    e *= 1.0 + 2.0 * lh * k;
                }
            }
            if e == 1.0 || wl <= 0.0 {
                continue;
            }
            let s = wl.powf(e);
            let mut out = [c[0], c[1], c[2]].map(|v| (v * s / wl).clamp(0.0, 1.0));
            if f != 0.0 {
                let [hh, ss, l] = rgb_to_hsl(out);
                out = hsl_to_rgb(hh, (ss * (1.0 + f * (s - wl).abs() * 2.0)).clamp(0.0, 1.0), l);
            }
            c[..3].copy_from_slice(&out);
        }
    }
    if p.midtone_contrast != 0.0 {
        let u = p.midtone_contrast / 100.0;
        let k = if u >= 0.0 { 1.0 + 2.0 * u } else { 1.0 / (1.0 - 2.0 * u) };
        map_rgb(px, |c| c.map(|v| if v < 0.5 { 0.5 * (v / 0.5).powf(k) } else { 1.0 - 0.5 * ((1.0 - v) / 0.5).powf(k) }));
    }
    if p.black_clip > 0.0 || p.white_clip > 0.0 {
        let hist = histograms(px)[0];
        let (b, t) = (from_bottom(&hist, p.black_clip), from_top(&hist, p.white_clip));
        if t > b && (b > 0 || t < 255) {
            let (b, t) = (b as f32 / 255.0, t as f32 / 255.0);
            map_rgb(px, |c| c.map(|v| ((v - b) / (t - b)).clamp(0.0, 1.0)));
        }
    }
}

fn hdr_toning(p: &HdrToning, px: &mut [f32], w: usize, h: usize) {
    match p.method {
        HdrMethod::ExposureGamma => {
            if p.exposure != 0.0 || p.gamma != 1.0 {
                let (a, n) = (p.exposure.exp2(), 1.0 / p.gamma);
                map_rgb(px, |c| c.map(|v| linear_to_srgb((srgb_to_linear(v) * a).max(0.0).powf(n)).clamp(0.0, 1.0)));
            }
        }
        // Reinhard per channel with white = the brightest value, as View > 32-bit Preview Options;
        // an identity when nothing exceeds 1 (8/16-bit data).
        HdrMethod::HighlightCompression => {
            let max = px.chunks_exact(4).filter(|c| c[3] > 0.0).fold(0f32, |m, c| m.max(c[0]).max(c[1]).max(c[2]));
            if max > 1.0 {
                map_rgb(px, |c| c.map(|v| (v * (1.0 + v / (max * max)) / (1.0 + v)).min(1.0)));
            }
        }
        // Bins span 0..max(1, brightest luminance), so 32-bit values above 1 keep their order.
        HdrMethod::EqualizeHistogram => {
            let top = px.chunks_exact(4).filter(|c| c[3] > 0.0).fold(1f32, |m, c| m.max(luma(c)));
            let mut hist = [0u32; 256];
            for c in px.chunks_exact(4).filter(|c| c[3] > 0.0) {
                hist[bin(luma(c) / top)] += 1;
            }
            if hist.iter().any(|&n| n > 0) {
                let cdf = cumulative(&hist);
                for c in px.chunks_exact_mut(4) {
                    let o = luma(c).max(0.0);
                    scale_lum(c, o, cdf[bin(o / top)]);
                }
            }
        }
        HdrMethod::LocalAdaptation => {
            let l: Vec<f32> = px.chunks_exact(4).map(|c| luma(c).max(1e-4).ln()).collect();
            let b = blur(&l, w, h, p.radius);
            let mean = (b.iter().map(|&v| v as f64).sum::<f64>() / b.len().max(1) as f64) as f32;
            let (k, d) = (1.0 - p.strength.clamp(0.0, 1.0) * 0.5, 1.0 + p.detail / 100.0);
            for (i, c) in px.chunks_exact_mut(4).enumerate() {
                let m = mean + (b[i] - mean) * k + (l[i] - b[i]) * d;
                let mut f = m.exp().clamp(0.0, 1.0);
                let base = b[i].exp().clamp(0.0, 1.0);
                if p.shadow != 0.0 {
                    f = f.powf(1.0 / (1.0 + p.shadow / 100.0 * (1.0 - base))).clamp(0.0, 1.0);
                }
                if p.highlight != 0.0 {
                    f = f.powf(1.0 + p.highlight / 100.0 * base).clamp(0.0, 1.0);
                }
                if p.exposure != 0.0 {
                    f = (f * p.exposure.exp2()).clamp(0.0, 1.0);
                }
                if p.gamma != 1.0 {
                    f = f.powf(1.0 / p.gamma).clamp(0.0, 1.0);
                }
                let o = luma(c).max(0.0);
                scale_lum(c, o, f);
            }
        }
    }
    if p.vibrance != 0.0 || p.saturation != 0.0 {
        map_rgb(px, |c| {
            let [hh, s, l] = rgb_to_hsl(c);
            let mut s = sat_by(s, p.saturation);
            if p.vibrance != 0.0 {
                let dist = (hh - 25.0).rem_euclid(360.0);
                let dist = dist.min(360.0 - dist);
                let skin = if dist >= 40.0 { 1.0 } else { 1.0 - 0.5 * (1.0 - dist / 40.0) };
                s = sat_by(s, p.vibrance * (1.0 - s) * skin);
            }
            hsl_to_rgb(hh, s, l)
        });
    }
}
