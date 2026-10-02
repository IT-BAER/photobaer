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

    /// Blends `src` into pixel layer `id` with `mode` at `opacity` (0..1), limited to the selection.
    /// `preserve` keeps the layer's transparency; otherwise the source also fills transparent areas.
    pub fn apply_image(&mut self, id: u32, src: &ImageSource, mode: Blend, opacity: f32, preserve: bool) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_paint(id)?;
        if let Some(l) = src.layer {
            self.node(l)?.pixel_tiles()?;
        }
        pick(&src.channel)?;
        let opacity = opacity.clamp(0.0, 1.0);
        let area = self.selected_tiles().unwrap_or_else(|| self.canvas_tiles());
        let mut srcs = HashMap::new();
        for &(tx, ty) in &area {
            srcs.insert((tx, ty), self.source_tile(src, tx, ty)?);
        }
        self.edit_pixel_tiles_at(id, &area, preserve, |at, p, b| {
            let s = srcs[&at][p];
            let w = opacity * s[3];
            let cb = [b[0], b[1], b[2]];
            let mixed = blend_rgb(mode, cb, [s[0], s[1], s[2]]);
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

    /// Blends source 1 (on top) into source 2 as gray values and stores the result as a new saved
    /// channel named `name`; returns its id. Transparent areas read as white.
    pub fn calculations(&mut self, s1: &ImageSource, s2: &ImageSource, mode: Blend, opacity: f32, name: &str) -> Result<u32, String> {
        self.check_idle()?;
        for s in [s1, s2] {
            if let Some(l) = s.layer {
                self.node(l)?.pixel_tiles()?;
            }
            if matches!(pick(&s.channel)?, Pick::Rgb) {
                return Err("Calculations needs a single channel, not RGB".into());
            }
        }
        let opacity = opacity.clamp(0.0, 1.0);
        let gray = |v: [f32; 4]| v[0] * v[3] + (1.0 - v[3]);
        let mut mask = SelMask::default();
        for (tx, ty) in self.canvas_tiles() {
            let (a, b) = (self.source_tile(s1, tx, ty)?, self.source_tile(s2, tx, ty)?);
            let vals: Vec<f32> = (0..TILE_PIXELS)
                .map(|p| {
                    let (top, base) = (gray(a[p]), gray(b[p]));
                    base + (blend_rgb(mode, [base; 3], [top; 3])[0] - base) * opacity
                })
                .collect();
            self.set_sel_tile(&mut mask, tx, ty, &vals);
        }
        let id = self.next_channel_id();
        self.channels.push(Channel { id, name: name.to_string(), mask });
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn src(layer: Option<u32>, channel: &str, invert: bool) -> ImageSource {
        ImageSource { layer, channel: channel.into(), invert }
    }

    // Layer `id` filled with one straight 8-bit RGBA value over the whole canvas.
    fn fill(d: &mut Document, id: u32, c: [u8; 4]) {
        let mut buf = vec![0u8; TILE_BYTES_U8];
        for p in 0..TILE_PIXELS {
            buf[p * 4..p * 4 + 4].copy_from_slice(&c);
        }
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                d.set_tile_rgba8(id, tx, ty, &buf).unwrap();
            }
        }
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
        d.apply_image(1, &src(None, "red", true), Blend::Normal, 1.0, true).unwrap();
        assert_eq!(at(&d, 1, 5, 5), [55, 55, 55, 255]);
    }

    #[test]
    fn apply_image_multiply_at_half_opacity_from_another_layer() {
        let mut d = Document::new(64, 64, 8).unwrap();
        fill(&mut d, 1, [200, 200, 200, 255]);
        let top = d.add_layer("top", 1).unwrap();
        fill(&mut d, top, [0, 0, 0, 255]);
        d.apply_image(1, &src(Some(top), "rgb", false), Blend::Multiply, 0.5, true).unwrap();
        assert_eq!(at(&d, 1, 0, 0), [100, 100, 100, 255]);
        assert!(d.apply_image(1, &src(Some(999), "rgb", false), Blend::Normal, 1.0, true).is_err());
        assert!(d.apply_image(1, &src(None, "nope", false), Blend::Normal, 1.0, true).is_err());
    }

    #[test]
    fn apply_image_preserve_transparency_and_selection() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let empty = d.add_layer("empty", 1).unwrap();
        fill(&mut d, 1, [255, 0, 0, 255]);
        d.apply_image(empty, &src(Some(1), "rgb", false), Blend::Normal, 1.0, true).unwrap();
        assert_eq!(at(&d, empty, 3, 3)[3], 0, "transparent pixels stay transparent");
        d.select_rect(0.0, 0.0, 10.0, 64.0, Mode::New).unwrap();
        d.apply_image(empty, &src(Some(1), "rgb", false), Blend::Normal, 1.0, false).unwrap();
        assert_eq!(at(&d, empty, 3, 3), [255, 0, 0, 255], "without preserve the source fills them");
        assert_eq!(at(&d, empty, 20, 3)[3], 0, "outside the selection nothing changes");
    }

    #[test]
    fn calculations_multiplies_two_channels_into_a_new_channel() {
        let mut d = Document::new(64, 64, 8).unwrap();
        fill(&mut d, 1, [255, 128, 0, 255]);
        let id = d.calculations(&src(None, "red", false), &src(None, "green", false), Blend::Multiply, 1.0, "Alpha 1").unwrap();
        let t = d.channel_tile(id, 0, 0, 0).unwrap().unwrap();
        assert_eq!(t[0], 128);
        let inv = d.calculations(&src(None, "blue", true), &src(None, "alpha", false), Blend::Normal, 1.0, "b").unwrap();
        assert_eq!(d.channel_tile(inv, 0, 0, 0).unwrap().unwrap()[0], 255, "inverted blue 0 is white");
        assert!(d.calculations(&src(None, "rgb", false), &src(None, "red", false), Blend::Normal, 1.0, "x").is_err());
    }
}
