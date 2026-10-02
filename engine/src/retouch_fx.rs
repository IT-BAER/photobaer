//! Per-dab effect tools (dodge, burn, sponge, blur, sharpen, smudge) and the art history brush
//! dab expansion. A child module of `doc`.

use super::*;

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum EffectIn {
    #[serde(rename_all = "camelCase")]
    Toning { tool: String, range: String, exposure: f32, protect_tones: bool },
    #[serde(rename_all = "camelCase")]
    Sponge { mode: String, vibrance: bool, flow: f32 },
    #[serde(rename_all = "camelCase")]
    Focus { tool: String, all_layers: bool },
    #[serde(rename_all = "camelCase")]
    Smudge {
        strength: f32,
        all_layers: bool,
        blend: String,
        #[serde(default)]
        finger_paint: Option<[f32; 3]>,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ArtIn {
    style: String,
    area: f32,
    tolerance: f32,
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Range {
    Shadows,
    Midtones,
    Highlights,
}

/// A dab's effect with its strength already folded in (Dodge/Burn exposure * 0.25, Sponge flow * 0.3).
#[derive(Clone, Copy)]
pub(super) enum Effect {
    Toning { dodge: bool, range: Range, strength: f32, protect: bool },
    Sponge { saturate: bool, vibrance: bool, strength: f32 },
    Focus { sharpen: bool, all: bool },
    Smudge { strength: f32, all: bool, blend: Blend, finger: Option<[f32; 3]> },
}

impl EffectIn {
    pub(super) fn build(self) -> Result<Effect, String> {
        let unit = |v: f32| if v.is_finite() { Ok(v.clamp(0.0, 1.0)) } else { Err("effect params must be finite".to_string()) };
        Ok(match self {
            EffectIn::Toning { tool, range, exposure, protect_tones } => Effect::Toning {
                dodge: match tool.as_str() {
                    "dodge" => true,
                    "burn" => false,
                    other => return Err(format!("unknown toning tool {other}")),
                },
                range: match range.as_str() {
                    "shadows" => Range::Shadows,
                    "midtones" => Range::Midtones,
                    "highlights" => Range::Highlights,
                    other => return Err(format!("unknown toning range {other}")),
                },
                strength: unit(exposure)? * 0.25,
                protect: protect_tones,
            },
            EffectIn::Sponge { mode, vibrance, flow } => Effect::Sponge {
                saturate: match mode.as_str() {
                    "saturate" => true,
                    "desaturate" => false,
                    other => return Err(format!("unknown sponge mode {other}")),
                },
                vibrance,
                strength: unit(flow)? * 0.3,
            },
            EffectIn::Focus { tool, all_layers } => Effect::Focus {
                sharpen: match tool.as_str() {
                    "sharpen" => true,
                    "blur" => false,
                    other => return Err(format!("unknown focus tool {other}")),
                },
                all: all_layers,
            },
            EffectIn::Smudge { strength, all_layers, blend, finger_paint } => {
                let mode = Blend::parse(&blend)?;
                if !matches!(mode, Blend::Normal | Blend::Darken | Blend::Lighten | Blend::Hue | Blend::Saturation | Blend::Color | Blend::Luminosity) {
                    return Err(format!("unknown smudge mode {blend}"));
                }
                if finger_paint.is_some_and(|c| c.iter().any(|v| !v.is_finite())) {
                    return Err("effect params must be finite".into());
                }
                Effect::Smudge {
                    strength: unit(strength)?,
                    all: all_layers,
                    blend: mode,
                    finger: finger_paint.map(|c| c.map(|v| v.clamp(0.0, 255.0) / 255.0)),
                }
            }
        })
    }
}

/// Art history brush settings: the style's point walk plus area and tolerance.
pub(super) struct Art {
    steps: u32,
    curl: f32,
    wander: f32,
    area: f32,
    tolerance: f32,
}

impl Art {
    pub(super) fn build(p: ArtIn) -> Result<Art, String> {
        if !p.area.is_finite() || !p.tolerance.is_finite() {
            return Err("art history params must be finite".into());
        }
        let (steps, curl, wander) = match p.style.as_str() {
            "dab" => (1, 0.0, 0.0),
            "tightShort" => (4, 0.0, 12.0),
            "tightMedium" => (9, 0.0, 12.0),
            "tightLong" => (18, 0.0, 12.0),
            "looseMedium" => (9, 0.0, 45.0),
            "looseLong" => (18, 0.0, 45.0),
            "tightCurl" => (10, 28.0, 8.0),
            "tightCurlLong" => (22, 28.0, 8.0),
            "looseCurl" => (10, 28.0, 40.0),
            "looseCurlLong" => (22, 28.0, 40.0),
            other => return Err(format!("unknown art history style {other}")),
        };
        Ok(Art { steps, curl, wander, area: p.area.clamp(1.0, 500.0), tolerance: p.tolerance.clamp(0.0, 1.0) })
    }
}

fn smoothstep(t: f32) -> f32 {
    let t = t.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn tone(back: [f32; 3], dodge: bool, range: Range, protect: bool) -> Option<[f32; 3]> {
    let l = blend::lum(back);
    let w = smoothstep(match range {
        Range::Shadows => 1.0 - 2.0 * l,
        Range::Highlights => 2.0 * l - 1.0,
        Range::Midtones => 1.0 - (2.0 * l - 1.0).abs(),
    });
    if w <= 0.0 {
        return None;
    }
    Some(if protect {
        let t = if dodge { l + (1.0 - l) * w } else { l * (1.0 - w) };
        blend::set_lum(back, t.clamp(0.0, 1.0)).map(|c| c.clamp(0.0, 1.0))
    } else {
        back.map(|c| (if dodge { c + (1.0 - c) * w } else { c * (1.0 - w) }).clamp(0.0, 1.0))
    })
}

// Saturation moves in HSB; the max channel (B) and the hue stay, so a gray stays gray.
fn sponge(back: [f32; 3], saturate: bool, vibrance: bool) -> [f32; 3] {
    let (max, min) = (back[0].max(back[1]).max(back[2]), back[0].min(back[1]).min(back[2]));
    if max <= 0.0 || max <= min {
        return back;
    }
    let s = (max - min) / max;
    let k = if vibrance { 1.0 - s } else { 1.0 };
    let s2 = (if saturate { s + (1.0 - s) * k } else { s * (1.0 - k) }).clamp(0.0, 1.0);
    back.map(|c| max - (max - c) * (s2 / s))
}

// Separable Gaussian over `w` x `h` straight RGBA, edges clamped.
fn gaussian(data: &mut [[f32; 4]], w: usize, h: usize, sigma: f32) {
    let r = ((3.0 * sigma).ceil() as usize).max(1);
    let mut k: Vec<f32> = (0..=2 * r).map(|i| (-((i as f32 - r as f32).powi(2)) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = k.iter().sum();
    k.iter_mut().for_each(|v| *v /= sum);
    let pass = |src: &[[f32; 4]], dst: &mut [[f32; 4]], horizontal: bool| {
        let (n, m) = if horizontal { (w, h) } else { (h, w) };
        for line in 0..m {
            for i in 0..n {
                let mut acc = [0f32; 4];
                for (j, kv) in k.iter().enumerate() {
                    let t = (i as i64 + j as i64 - r as i64).clamp(0, n as i64 - 1) as usize;
                    let px = if horizontal { src[line * w + t] } else { src[t * w + line] };
                    (0..4).for_each(|c| acc[c] += px[c] * kv);
                }
                dst[if horizontal { line * w + i } else { i * w + line }] = acc;
            }
        }
    };
    let mut tmp = data.to_vec();
    pass(data, &mut tmp, true);
    pass(&tmp, data, false);
}

pub(super) fn bilinear(fetch: impl Fn(i32, i32) -> [f32; 4], x: f64, y: f64) -> [f32; 4] {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = ((x - x0) as f32, (y - y0) as f32);
    let (x0, y0) = (x0 as i32, y0 as i32);
    let (p00, p10, p01, p11) = (fetch(x0, y0), fetch(x0 + 1, y0), fetch(x0, y0 + 1), fetch(x0 + 1, y0 + 1));
    std::array::from_fn(|i| {
        let top = p00[i] + (p10[i] - p00[i]) * fx;
        let bot = p01[i] + (p11[i] - p01[i]) * fx;
        top + (bot - top) * fy
    })
}

impl Document {
    // Straight RGBA over `r` ([x0, y0, x1, y1], inside the canvas) from the layer or the visible composite.
    fn read_region(&self, layer: u32, all: bool, r: [i32; 4]) -> Result<Vec<[f32; 4]>, String> {
        let (ti, w) = (TILE as i32, (r[2] - r[0]) as usize);
        let mut out = vec![[0f32; 4]; w * (r[3] - r[1]) as usize];
        for (tx, ty) in self.tiles_of_rect(r[0], r[1], r[2], r[3]) {
            let comp = if all { Some(self.flatten_tile_rgba8(tx as u32, ty as u32)?) } else { None };
            let tile = if all { None } else { self.node(layer)?.pixel_tiles()?.get(tx, ty) };
            for y in r[1].max(ty * ti)..r[3].min((ty + 1) * ti) {
                for x in r[0].max(tx * ti)..r[2].min((tx + 1) * ti) {
                    let p = (y.rem_euclid(ti) * ti + x.rem_euclid(ti)) as usize;
                    out[(y - r[1]) as usize * w + (x - r[0]) as usize] = match (&comp, tile) {
                        (Some(c), _) => std::array::from_fn(|i| c[p * 4 + i] as f32 / 255.0),
                        (_, Some(t)) => t.px.rgba_f32(p),
                        _ => [0.0; 4],
                    };
                }
            }
        }
        Ok(out)
    }

    fn grown(&self, r: [i32; 4], pad: i32) -> [i32; 4] {
        [(r[0] - pad).max(0), (r[1] - pad).max(0), (r[2] + pad).min(self.width as i32), (r[3] + pad).min(self.height as i32)]
    }

    // Per pixel of `r`, the value the effect mixes towards: the blurred pixel (focus) or the
    // un-premultiplied smudge source; None when this dab changes nothing.
    fn effect_aux(&self, st: &mut Stroke, effect: Effect, d: &stroke::PlacedDab, r: [i32; 4]) -> Result<Option<Vec<[f32; 4]>>, String> {
        let (w, n) = ((r[2] - r[0]) as usize, ((r[2] - r[0]) * (r[3] - r[1])) as usize);
        match effect {
            Effect::Focus { all, .. } => {
                let s = (d.radius * 2.0 / 8.0).max(1.0);
                let g = self.grown(r, s.ceil() as i32 + 2);
                let gw = (g[2] - g[0]) as usize;
                let mut plane = self.read_region(st.layer, all, g)?;
                gaussian(&mut plane, gw, (g[3] - g[1]) as usize, s / 3.0);
                let mut out = Vec::with_capacity(n);
                for y in r[1]..r[3] {
                    let row = (y - g[1]) as usize * gw + (r[0] - g[0]) as usize;
                    out.extend_from_slice(&plane[row..row + w]);
                }
                Ok(Some(out))
            }
            Effect::Smudge { all, finger, .. } => {
                let pos = (d.x, d.y);
                let Some(prev) = st.smudge_prev.replace(pos) else {
                    return Ok(finger.map(|c| vec![[c[0], c[1], c[2], 1.0]; n]));
                };
                let (dx, dy) = (pos.0 - prev.0, pos.1 - prev.1);
                if dx.hypot(dy) < 1e-6 {
                    return Ok(None);
                }
                let g = self.grown(r, dx.abs().max(dy.abs()).ceil() as i32 + 2);
                let gw = (g[2] - g[0]) as usize;
                let plane = self.read_region(st.layer, all, g)?;
                let (cw, ch) = (self.width as i32, self.height as i32);
                let fetch = |x: i32, y: i32| -> [f32; 4] {
                    if x < 0 || y < 0 || x >= cw || y >= ch {
                        return [0.0; 4];
                    }
                    let p = plane[(y - g[1]) as usize * gw + (x - g[0]) as usize];
                    [p[0] * p[3], p[1] * p[3], p[2] * p[3], p[3]]
                };
                let mut out = Vec::with_capacity(n);
                for y in r[1]..r[3] {
                    for x in r[0]..r[2] {
                        let s = bilinear(fetch, x as f64 - dx, y as f64 - dy);
                        out.push(if s[3] > 0.0 { [s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3]] } else { [0.0; 4] });
                    }
                }
                Ok(Some(out))
            }
            _ => Ok(Some(Vec::new())),
        }
    }

    /// Applies the stroke's effect to the layer at once for one placed dab; `cov` is the dab's
    /// tip coverage over `r` ([x0, y0, x1, y1]).
    pub(super) fn effect_dab(&mut self, st: &mut Stroke, d: &stroke::PlacedDab, r: [i32; 4], cov: &[f32]) -> Result<(), String> {
        let Some(effect) = st.effect else { return Ok(()) };
        let Some(aux) = self.effect_aux(st, effect, d, r)? else { return Ok(()) };
        let sel = self.selection_plane(r);
        let cap = (st.opacity * if st.pressure_opacity { d.pressure } else { 1.0 } * d.cap_mul).clamp(0.0, 1.0);
        let flow = (st.flow * d.flow_mul).clamp(0.0, 1.0);
        let (w, keep) = ((r[2] - r[0]) as usize, st.keep_alpha);
        self.edit_rect(st.layer, r, keep, |x, y, back| {
            let i = (y - r[1]) as usize * w + (x - r[0]) as usize;
            let tip = cov[i] * sel[i];
            let a = back[3];
            if tip <= 0.0 || (keep && a <= 0.0) {
                return None;
            }
            let rgb = [back[0], back[1], back[2]];
            // Straight mix towards `(out, dest)`.
            let straight = |f: f32, out: [f32; 3], dest: f32| {
                [back[0] + (out[0] - back[0]) * f, back[1] + (out[1] - back[1]) * f, back[2] + (out[2] - back[2]) * f, a + (dest - a) * f]
            };
            Some(match effect {
                Effect::Toning { dodge, range, strength, protect } => {
                    let out = tone(rgb, dodge, range, protect)?;
                    straight(tip * strength, out, a)
                }
                Effect::Sponge { saturate, vibrance, strength } => straight(tip * strength, sponge(rgb, saturate, vibrance), a),
                Effect::Focus { sharpen, .. } => {
                    let b = aux[i];
                    if sharpen {
                        straight(tip * flow, std::array::from_fn(|c| (rgb[c] + (rgb[c] - b[c]) * 1.5).clamp(0.0, 1.0)), a)
                    } else {
                        straight(tip * flow, [b[0], b[1], b[2]], b[3])
                    }
                }
                Effect::Smudge { strength, blend, .. } => {
                    let (s, f) = (aux[i], tip * strength * cap * flow);
                    let src = [s[0], s[1], s[2]];
                    let m = blend_rgb(blend, rgb, src);
                    let out: [f32; 3] = std::array::from_fn(|c| src[c] + (m[c] - src[c]) * a);
                    let w = a + (s[3] - a) * f;
                    if w > 0.0 {
                        let mix = |c: usize| (rgb[c] * a * (1.0 - f) + out[c] * s[3] * f) / w;
                        [mix(0), mix(1), mix(2), w]
                    } else {
                        [if keep { rgb[0] } else { 0.0 }, if keep { rgb[1] } else { 0.0 }, if keep { rgb[2] } else { 0.0 }, 0.0]
                    }
                }
            })
        })?;
        Ok(())
    }

    fn layer_px(&self, layer: u32, x: i32, y: i32) -> [f32; 4] {
        let ti = TILE as i32;
        let tile = self.node(layer).ok().and_then(|n| n.pixel_tiles().ok()).and_then(|t| t.get(x.div_euclid(ti), y.div_euclid(ti)));
        tile.map_or([0.0; 4], |t| t.px.rgba_f32((y.rem_euclid(ti) * ti + x.rem_euclid(ti)) as usize))
    }

    /// The art history brush: each dab is skipped within the tolerance of the history pixel, else
    /// followed by the style's walk of extra dabs.
    pub(super) fn art_expand(&self, st: &Stroke, dabs: Vec<stroke::PlacedDab>) -> Vec<stroke::PlacedDab> {
        let Some(art) = &st.art else { return dabs };
        let mut out = Vec::with_capacity(dabs.len());
        for d in dabs {
            if art.tolerance > 0.0 {
                let cur = self.layer_px(st.layer, d.x.round() as i32, d.y.round() as i32);
                let src = st.source.as_ref().map_or(cur, |s| s.sample(d.x.floor() as i32, d.y.floor() as i32));
                if (0..4).map(|i| (cur[i] - src[i]).abs()).fold(0.0, f32::max) <= art.tolerance {
                    continue;
                }
            }
            let mut rng = stroke::Prng::new(st.seed ^ d.dab_index.wrapping_mul(0x9E37_79B1));
            let (step, mut theta, mut at) = ((art.area / 8.0).max(1.0) as f64, d.dir as f64, (d.x, d.y));
            out.push(d.clone());
            for _ in 0..art.steps {
                theta += (art.curl + (2.0 * rng.next() - 1.0) * art.wander) as f64;
                at = (at.0 + step * theta.to_radians().cos(), at.1 + step * theta.to_radians().sin());
                out.push(stroke::PlacedDab { x: at.0, y: at.1, ..d.clone() });
            }
        }
        out
    }
}
