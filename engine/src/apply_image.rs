//! Image > Apply Image and Image > Calculations: blend a channel of a layer or of the merged
//! image into a layer, or two such channels into a new saved channel.

use super::*;
use serde::Deserialize;

/// One source: `layer` None reads the merged image. `channel` is "rgb", "red", "green", "blue",
/// "gray" (luminosity), "alpha" (transparency) or "channel:<id>" (a saved channel).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageSource {
    pub layer: Option<u32>,
    pub channel: String,
    #[serde(default)]
    pub invert: bool,
}

#[derive(Clone, Copy)]
enum Pick {
    Rgb,
    Ch(usize),
    Gray,
    Alpha,
    Saved(u32),
}

fn pick(s: &str) -> Result<Pick, String> {
    Ok(match s {
        "rgb" => Pick::Rgb,
        "red" => Pick::Ch(0),
        "green" => Pick::Ch(1),
        "blue" => Pick::Ch(2),
        "gray" => Pick::Gray,
        "alpha" => Pick::Alpha,
        _ => Pick::Saved(s.strip_prefix("channel:").and_then(|v| v.parse().ok()).ok_or_else(|| format!("unknown channel {s}"))?),
    })
}

impl Document {
    // The source's straight color and its weight (its alpha) for every pixel of one canvas tile.
    fn source_tile(&self, s: &ImageSource, tx: i32, ty: i32) -> Result<Vec<[f32; 4]>, String> {
        let p = pick(&s.channel)?;
        let mut out = vec![[0f32; 4]; TILE_PIXELS];
        if let Pick::Saved(id) = p {
            let ch = self.channels.iter().find(|c| c.id == id).ok_or_else(|| format!("unknown channel {id}"))?;
            let def = ch.mask.default as f32 / self.max();
            let t = ch.mask.tiles.get(tx, ty);
            for (i, v) in out.iter_mut().enumerate() {
                let g = t.map_or(def, |t| t.px.mask_f32(i));
                *v = [g, g, g, 1.0];
            }
        } else {
            match s.layer {
                None => {
                    let premul = self.composite_tile_premul(tx as u32, ty as u32);
                    for (i, v) in out.iter_mut().enumerate() {
                        let a = premul[i * 4 + 3];
                        *v = if a > 0.0 { [premul[i * 4] / a, premul[i * 4 + 1] / a, premul[i * 4 + 2] / a, a] } else { [0.0; 4] };
                    }
                }
                Some(id) => {
                    if let Some(t) = self.node(id)?.pixel_tiles()?.get(tx, ty) {
                        for (i, v) in out.iter_mut().enumerate() {
                            *v = t.px.rgba_f32(i);
                        }
                    }
                }
            }
            for v in out.iter_mut() {
                let g = match p {
                    Pick::Ch(c) => v[c],
                    Pick::Gray => 0.3 * v[0] + 0.59 * v[1] + 0.11 * v[2],
                    Pick::Alpha => {
                        *v = [v[3], v[3], v[3], 1.0];
                        continue;
                    }
                    _ => continue,
                };
                *v = [g, g, g, v[3]];
            }
        }
        if s.invert {
            for v in out.iter_mut() {
                *v = [1.0 - v[0], 1.0 - v[1], 1.0 - v[2], v[3]];
            }
        }
        Ok(out)
    }

    fn canvas_tiles(&self) -> Vec<(i32, i32)> {
        (0..self.tiles_y() as i32).flat_map(|ty| (0..self.tiles_x() as i32).map(move |tx| (tx, ty))).collect()
    }

    /// Reads `s` over the whole canvas, for an Apply Image or Calculations in this or another
    /// document of the same pixel size.
    pub fn image_source(&self, s: &ImageSource) -> Result<SourceTiles, String> {
        if let Some(l) = s.layer {
            self.node(l)?.pixel_tiles()?;
        }
        pick(&s.channel)?;
        let mut tiles = HashMap::new();
        for (tx, ty) in self.canvas_tiles() {
            tiles.insert((tx, ty), self.source_tile(s, tx, ty)?);
        }
        Ok(SourceTiles { size: (self.width, self.height), rgb: matches!(pick(&s.channel)?, Pick::Rgb), tiles })
    }

    fn check_source(&self, s: &SourceTiles) -> Result<(), String> {
        if s.size != (self.width, self.height) {
            return Err("The source document must have the same pixel size.".into());
        }
        Ok(())
    }

    /// Blends `src` into pixel layer `id` by `op`, limited to the selection and scaled by `mask`.
    /// `preserve` keeps the layer's transparency; otherwise the source also fills transparent areas.
    pub fn apply_image(&mut self, id: u32, src: &SourceTiles, mask: Option<&SourceTiles>, op: &CalcOp, preserve: bool) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_paint(id)?;
        self.check_source(src)?;
        if let Some(m) = mask {
            self.check_source(m)?;
        }
        let area = self.selected_tiles().unwrap_or_else(|| self.canvas_tiles());
        self.edit_pixel_tiles_at(id, &area, preserve, |at, p, b| {
            let s = src.tiles[&at][p];
            let w = op.opacity * s[3] * mask.map_or(1.0, |m| mask_weight(m.tiles[&at][p]));
            let cb = [b[0], b[1], b[2]];
            let mixed = op.mix(cb, [s[0], s[1], s[2]]);
            if preserve {
                let c = |k: usize| cb[k] + (mixed[k] - cb[k]) * w;
                return [c(0), c(1), c(2), b[3]];
            }
            let ab = b[3];
            let a = ab + w * (1.0 - ab);
            if a <= 0.0 {
                return [0.0; 4];
            }
            let c = |k: usize| (((1.0 - w) * cb[k] * ab + w * ((1.0 - ab) * s[k] + ab * mixed[k])) / a).clamp(0.0, 1.0);
            [c(0), c(1), c(2), a]
        })
    }

    // Source 1 (on top) blended into source 2 as gray values per canvas tile; transparent areas read as white.
    fn calc_values(&self, s1: &SourceTiles, s2: &SourceTiles, mask: Option<&SourceTiles>, op: &CalcOp) -> Result<Vec<((i32, i32), Vec<f32>)>, String> {
        for s in [Some(s1), Some(s2), mask].into_iter().flatten() {
            self.check_source(s)?;
        }
        if s1.rgb || s2.rgb {
            return Err("Calculations needs a single channel, not RGB".into());
        }
        let gray = |v: [f32; 4]| v[0] * v[3] + (1.0 - v[3]);
        Ok(self
            .canvas_tiles()
            .into_iter()
            .map(|at| {
                let (a, b) = (&s1.tiles[&at], &s2.tiles[&at]);
                let vals = (0..TILE_PIXELS)
                    .map(|p| {
                        let (top, base) = (gray(a[p]), gray(b[p]));
                        let w = op.opacity * mask.map_or(1.0, |m| mask_weight(m.tiles[&at][p]));
                        base + (op.mix([base; 3], [top; 3])[0] - base) * w
                    })
                    .collect();
                (at, vals)
            })
            .collect())
    }

    /// Image > Calculations into a new saved channel named `name`; returns its id.
    pub fn calculations(&mut self, s1: &SourceTiles, s2: &SourceTiles, mask: Option<&SourceTiles>, op: &CalcOp, name: &str) -> Result<u32, String> {
        self.check_idle()?;
        let vals = self.calc_values(s1, s2, mask, op)?;
        let mut sel = SelMask::default();
        for ((tx, ty), v) in vals {
            self.set_sel_tile(&mut sel, tx, ty, &v);
        }
        let id = self.next_channel_id();
        self.channels.push(Channel { id, name: name.to_string(), mask: sel, spot: None });
        Ok(id)
    }

    /// Image > Calculations into a new grayscale document of this size and depth.
    pub fn calculations_document(&self, s1: &SourceTiles, s2: &SourceTiles, mask: Option<&SourceTiles>, op: &CalcOp) -> Result<Document, String> {
        let vals: HashMap<(i32, i32), Vec<f32>> = self.calc_values(s1, s2, mask, op)?.into_iter().collect();
        let mut d = Document::new(self.width, self.height, self.depth)?;
        d.convert_mode(true)?;
        let tiles = d.render_tiles_with([0, 0, self.width as i32, self.height as i32], None, true, |ox, oy, buf| {
            let v = &vals[&(ox / TILE as i32, oy / TILE as i32)];
            for (p, g) in v.iter().enumerate() {
                buf[p * 4..p * 4 + 4].copy_from_slice(&[*g, *g, *g, 1.0]);
            }
            true
        })?;
        *d.node_mut(1)?.pixel_tiles_mut()? = tiles;
        Ok(d)
    }
}

/// One Apply Image or Calculations source read over a whole canvas: straight color and alpha.
pub struct SourceTiles {
    size: (u32, u32),
    rgb: bool,
    tiles: HashMap<(i32, i32), Vec<[f32; 4]>>,
}

// A mask source pixel as an effect weight: its gray value, transparent areas 0.
fn mask_weight(v: [f32; 4]) -> f32 {
    (0.3 * v[0] + 0.59 * v[1] + 0.11 * v[2]) * v[3]
}

#[derive(Clone, Copy)]
enum CalcMode {
    Blend(Blend),
    Add,
    Subtract,
}

/// The blending of Apply Image and Calculations: a layer blend mode, or Add / Subtract, which
/// divide the sum or difference by `scale` (1..2) and add `offset` (-1..1).
#[derive(Clone, Copy)]
pub struct CalcOp {
    mode: CalcMode,
    opacity: f32,
    scale: f32,
    offset: f32,
}

impl CalcOp {
    pub fn parse(mode: &str, opacity: f32, scale: f32, offset: f32) -> Result<CalcOp, String> {
        let mode = match mode {
            "add" => CalcMode::Add,
            "subtract" => CalcMode::Subtract,
            m => CalcMode::Blend(Blend::parse(m)?),
        };
        if !(1.0..=2.0).contains(&scale) || !(-1.0..=1.0).contains(&offset) {
            return Err("scale must be 1 to 2 and offset -255 to 255".into());
        }
        Ok(CalcOp { mode, opacity: opacity.clamp(0.0, 1.0), scale, offset })
    }

    fn mix(&self, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
        let scaled = |f: fn(f32, f32) -> f32| std::array::from_fn(|k| (f(cb[k], cs[k]) / self.scale + self.offset).clamp(0.0, 1.0));
        match self.mode {
            CalcMode::Blend(b) => blend_rgb(b, cb, cs),
            CalcMode::Add => scaled(|b, s| b + s),
            CalcMode::Subtract => scaled(|b, s| b - s),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(layer: Option<u32>, channel: &str, invert: bool) -> ImageSource {
        ImageSource { layer, channel: channel.into(), invert }
    }

    fn op(mode: &str, opacity: f32) -> CalcOp {
        CalcOp::parse(mode, opacity, 1.0, 0.0).unwrap()
    }

    fn apply(d: &mut Document, id: u32, s: ImageSource, mode: &str, opacity: f32, preserve: bool) -> Result<(), String> {
        let t = d.image_source(&s)?;
        d.apply_image(id, &t, None, &op(mode, opacity), preserve)
    }

    fn calc(d: &mut Document, a: ImageSource, b: ImageSource, mode: &str, opacity: f32, name: &str) -> Result<u32, String> {
        let (x, y) = (d.image_source(&a)?, d.image_source(&b)?);
        d.calculations(&x, &y, None, &op(mode, opacity), name)
    }

    // Layer `id` filled with one straight 8-bit RGBA value over columns [x0, x1) of every tile.
    fn fill_cols(d: &mut Document, id: u32, c: [u8; 4], x0: usize, x1: usize) {
        let mut buf = vec![0u8; TILE_BYTES_U8];
        for p in (0..TILE_PIXELS).filter(|p| (x0..x1).contains(&(p % TILE))) {
            buf[p * 4..p * 4 + 4].copy_from_slice(&c);
        }
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                d.set_tile_rgba8(id, tx, ty, &buf).unwrap();
            }
        }
    }

    fn fill(d: &mut Document, id: u32, c: [u8; 4]) {
        fill_cols(d, id, c, 0, TILE);
    }

    fn at(d: &Document, id: u32, x: i32, y: i32) -> [u8; 4] {
        let t = d.node(id).unwrap().pixel_tiles().unwrap().get(x / TILE as i32, y / TILE as i32);
        let p = ((y % TILE as i32) * TILE as i32 + x % TILE as i32) as usize;
        t.map_or([0; 4], |t| t.px.rgba_f32(p).map(|v| (v * 255.0).round() as u8))
    }

    #[test]
    fn apply_image_inverted_red_of_the_merged_image_in_normal_mode() {
        let mut d = Document::new(64, 64, 8).unwrap();
        fill(&mut d, 1, [200, 50, 10, 255]);
        apply(&mut d, 1, src(None, "red", true), "normal", 1.0, true).unwrap();
        assert_eq!(at(&d, 1, 5, 5), [55, 55, 55, 255]);
    }

    #[test]
    fn apply_image_multiply_at_half_opacity_from_another_layer() {
        let mut d = Document::new(64, 64, 8).unwrap();
        fill(&mut d, 1, [200, 200, 200, 255]);
        let top = d.add_layer("top", 1).unwrap();
        fill(&mut d, top, [0, 0, 0, 255]);
        apply(&mut d, 1, src(Some(top), "rgb", false), "multiply", 0.5, true).unwrap();
        assert_eq!(at(&d, 1, 0, 0), [100, 100, 100, 255]);
        assert!(apply(&mut d, 1, src(Some(999), "rgb", false), "normal", 1.0, true).is_err());
        assert!(apply(&mut d, 1, src(None, "nope", false), "normal", 1.0, true).is_err());
    }

    #[test]
    fn apply_image_preserve_transparency_and_selection() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let empty = d.add_layer("empty", 1).unwrap();
        fill(&mut d, 1, [255, 0, 0, 255]);
        apply(&mut d, empty, src(Some(1), "rgb", false), "normal", 1.0, true).unwrap();
        assert_eq!(at(&d, empty, 3, 3)[3], 0, "transparent pixels stay transparent");
        d.select_rect(0.0, 0.0, 10.0, 64.0, Mode::New).unwrap();
        apply(&mut d, empty, src(Some(1), "rgb", false), "normal", 1.0, false).unwrap();
        assert_eq!(at(&d, empty, 3, 3), [255, 0, 0, 255], "without preserve the source fills them");
        assert_eq!(at(&d, empty, 20, 3)[3], 0, "outside the selection nothing changes");
    }

    #[test]
    fn apply_image_add_and_subtract_use_scale_and_offset() {
        let mut d = Document::new(64, 64, 8).unwrap();
        fill(&mut d, 1, [100, 100, 100, 255]);
        let top = d.add_layer("top", 1).unwrap();
        fill(&mut d, top, [60, 60, 60, 255]);
        let s = d.image_source(&src(Some(top), "rgb", false)).unwrap();
        d.apply_image(1, &s, None, &CalcOp::parse("add", 1.0, 2.0, 0.0).unwrap(), true).unwrap();
        assert_eq!(at(&d, 1, 1, 1)[0], 80, "(100 + 60) / 2");
        d.apply_image(1, &s, None, &CalcOp::parse("subtract", 1.0, 1.0, 40.0 / 255.0).unwrap(), true).unwrap();
        assert_eq!(at(&d, 1, 1, 1)[0], 60, "80 - 60 + 40");
        assert!(CalcOp::parse("add", 1.0, 2.5, 0.0).is_err());
    }

    #[test]
    fn apply_image_mask_scales_the_effect_and_sources_come_from_another_document() {
        let mut d = Document::new(64, 64, 8).unwrap();
        fill(&mut d, 1, [255, 255, 255, 255]);
        let m = d.add_layer("mask", 1).unwrap();
        let mut buf = vec![0u8; TILE_BYTES_U8];
        for p in 0..TILE_PIXELS {
            let v = if p % TILE < 32 { 255 } else { 0 };
            buf[p * 4..p * 4 + 4].copy_from_slice(&[v, v, v, 255]);
        }
        d.set_tile_rgba8(m, 0, 0, &buf).unwrap();
        let mut other = Document::new(64, 64, 8).unwrap();
        fill(&mut other, 1, [0, 0, 0, 255]);
        let black = other.image_source(&src(None, "rgb", false)).unwrap();
        let mask = d.image_source(&src(Some(m), "gray", false)).unwrap();
        d.apply_image(1, &black, Some(&mask), &op("normal", 1.0), true).unwrap();
        assert_eq!((at(&d, 1, 5, 5)[0], at(&d, 1, 40, 5)[0]), (0, 255), "white mask applies, black mask keeps");
        let small = Document::new(32, 32, 8).unwrap().image_source(&src(None, "rgb", false)).unwrap();
        assert_eq!(d.apply_image(1, &small, None, &op("normal", 1.0), true).unwrap_err(), "The source document must have the same pixel size.");
    }

    #[test]
    fn calculations_multiplies_two_channels_into_a_new_channel() {
        let mut d = Document::new(64, 64, 8).unwrap();
        fill(&mut d, 1, [255, 128, 0, 255]);
        let id = calc(&mut d, src(None, "red", false), src(None, "green", false), "multiply", 1.0, "Alpha 1").unwrap();
        let t = d.channel_tile(id, 0, 0, 0).unwrap().unwrap();
        assert_eq!(t[0], 128);
        let inv = calc(&mut d, src(None, "blue", true), src(None, "alpha", false), "normal", 1.0, "b").unwrap();
        assert_eq!(d.channel_tile(inv, 0, 0, 0).unwrap().unwrap()[0], 255, "inverted blue 0 is white");
        assert!(calc(&mut d, src(None, "rgb", false), src(None, "red", false), "normal", 1.0, "x").is_err());
    }

    #[test]
    fn calculations_into_a_new_grayscale_document() {
        let mut d = Document::new(300, 20, 8).unwrap();
        fill(&mut d, 1, [255, 128, 0, 255]);
        let (a, b) = (d.image_source(&src(None, "red", false)).unwrap(), d.image_source(&src(None, "green", false)).unwrap());
        let n = d.calculations_document(&a, &b, None, &op("multiply", 1.0)).unwrap();
        assert_eq!((n.width, n.height, n.depth), (300, 20, 8));
        assert_eq!(at(&n, 1, 290, 10), [128, 128, 128, 255]);
        assert!(d.channels.is_empty(), "the source document keeps no channel");
    }
}
