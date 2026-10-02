//! Image > Mode beyond RGB and Grayscale. Pixels stay RGBA: Bitmap and Duotone keep gray pixels,
//! and Bitmap, Duotone and Indexed Color map the composite when it is displayed or exported.

use super::*;
use super::canvas::At;
use filters::Plane;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// The document's color mode when it is not RGB or plain Grayscale.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ColorMode {
    Bitmap,
    /// 1 to 4 inks; each lays its color over white by the gray's density.
    Duotone { inks: Vec<[u8; 3]> },
    /// 1 to 256 colors; every displayed pixel shows the nearest one.
    Indexed { table: Vec<[u8; 3]> },
    Cmyk,
    Lab,
    Multichannel,
}

impl ColorMode {
    pub fn check(&self) -> Result<(), String> {
        match self {
            ColorMode::Duotone { inks } if !(1..=4).contains(&inks.len()) => Err("duotone needs 1 to 4 inks".into()),
            ColorMode::Indexed { table } if !(1..=256).contains(&table.len()) => Err("a color table holds 1 to 256 colors".into()),
            _ => Ok(()),
        }
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum BitmapMethod {
    Threshold,
    Pattern,
    Diffusion,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Palette {
    Exact,
    Uniform,
    Web,
    Adaptive,
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
    Bitmap {
        method: BitmapMethod,
    },
    Duotone {
        inks: Vec<[u8; 3]>,
    },
    /// `amount` in 0..=1 scales diffusion, pattern and noise dither.
    Indexed {
        palette: Palette,
        colors: u32,
        #[serde(default)]
        forced: Forced,
        transparency: bool,
        dither: Dither,
        amount: f32,
    },
    Cmyk,
    Lab,
    Multichannel,
}

// Rec. 601 luma, as Grayscale uses.
fn luma(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

/// Duotone color of gray `g`: each ink multiplies white by its color at density 1 - g.
pub fn duotone(inks: &[[u8; 3]], g: f32) -> [f32; 3] {
    let d = 1.0 - g.clamp(0.0, 1.0);
    let mut out = [1.0f32; 3];
    for ink in inks {
        for (o, c) in out.iter_mut().zip(ink) {
            *o *= 1.0 - d * (1.0 - *c as f32 / 255.0);
        }
    }
    out
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

    // Weighted 8-bit colors of every own pixel layer inside the canvas; without `transparency`
    // over white.
    fn color_histogram(&self, transparency: bool) -> Result<HashMap<u32, u32>, String> {
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
                    let Some(c) = flat(px.rgba_f32(p), transparency) else { continue };
                    let q = c.map(|v| (v.clamp(0.0, 1.0) * 255.0).round() as u32);
                    *hist.entry(q[0] << 16 | q[1] << 8 | q[2]).or_insert(0) += 1;
                }
            }
        }
        Ok(hist)
    }

    fn build_table(&self, palette: Palette, colors: u32, forced: Forced, transparency: bool) -> Result<Vec<[u8; 3]>, String> {
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
                let hist = self.color_histogram(transparency)?;
                if hist.len() > 256 {
                    return Err(format!("the image has {} colors; Exact needs 256 or fewer", hist.len()));
                }
                let mut v: Vec<u32> = hist.into_keys().collect();
                v.sort_unstable();
                v.into_iter().map(rgb).collect()
            }
            Palette::Web => levels(6),
            Palette::Uniform => levels(((n as f64).cbrt() + 1e-9).floor().max(2.0) as u32),
            Palette::Adaptive => median_cut(&self.color_histogram(transparency)?, n.saturating_sub(table.len()).max(1)),
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
        if let ModeSpec::Duotone { inks } = spec {
            ColorMode::Duotone { inks: inks.clone() }.check()?;
            if self.vector.mode == Some(ColorMode::Duotone { inks: inks.clone() }) {
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
        if let Some(ColorMode::Duotone { inks }) = &d.vector.mode {
            if !matches!(to, "gray" | "duotone") {
                let inks = inks.clone();
                d.map_layers(|c| {
                    let o = duotone(&inks, luma([c[0], c[1], c[2]]));
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
            ModeSpec::Bitmap { method } => {
                let method = *method;
                for id in d.own_pixel_layers() {
                    d.dither_layer(id, method == BitmapMethod::Diffusion, 1.0, |x, y, c| {
                        let t = if method == BitmapMethod::Pattern { bayer(x, y) } else { 0.5 };
                        let v = if luma([c[0], c[1], c[2]]) >= t { 1.0 } else { 0.0 };
                        [v, v, v, c[3].clamp(0.0, 1.0)]
                    })?;
                }
                (true, Some(ColorMode::Bitmap))
            }
            ModeSpec::Duotone { inks } => (true, Some(ColorMode::Duotone { inks: inks.clone() })),
            ModeSpec::Indexed { palette, colors, forced, transparency, dither, amount } => {
                let table = d.build_table(*palette, *colors, *forced, *transparency)?;
                let (dither, amount, transparency) = (*dither, amount.clamp(0.0, 1.0), *transparency);
                // Ordered and noise offsets span about one palette step.
                let spread = amount / (table.len() as f32).cbrt().max(1.0);
                let mut near = Nearest::new(&table);
                for id in d.own_pixel_layers() {
                    d.dither_layer(id, dither == Dither::Diffusion, amount, |x, y, c| {
                        let Some(mut s) = flat(c, transparency) else { return [0.0; 4] };
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
        for p in v.chunks_exact_mut(4) {
            let a = p[3];
            if a <= 0.0 {
                continue;
            }
            let s = [p[0] / a, p[1] / a, p[2] / a];
            let out = match (mode, &mut near) {
                (_, Some(n)) => n.pick(s),
                (Some(ColorMode::Duotone { inks }), _) => duotone(inks, luma(s)),
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

// Straight color for indexing: over white without `transparency`, None where it stays transparent.
fn flat(c: [f32; 4], transparency: bool) -> Option<[f32; 3]> {
    let a = c[3].clamp(0.0, 1.0);
    if transparency {
        (a >= 0.5).then_some([c[0], c[1], c[2]])
    } else {
        Some([0, 1, 2].map(|i| c[i] * a + 1.0 - a))
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

    #[test]
    fn duotone_shows_inks_bakes_them_into_rgb_and_reloads() {
        let mut d = Document::new(32, 32, 8).unwrap();
        fill(&mut d, 1, [128, 128, 128, 255]);
        d.set_color_mode(&ModeSpec::Gray).unwrap();
        d.set_color_mode(&spec(r#"{"mode":"duotone","inks":[[0,0,0],[255,0,0]]}"#)).unwrap();
        let g = 128.0 / 255.0;
        let want = duotone(&[[0, 0, 0], [255, 0, 0]], g).map(|v| (v * 255.0).round() as u8);
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
