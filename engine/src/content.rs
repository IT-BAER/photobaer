//! Fill layer content, smart objects, smart filters, document patterns, global light and layer
//! comps (docs/M3.md sections 1, 4, 6, 7, 8). Scales and opacities are fractions (1 = 100 %),
//! angles degrees, offsets and sizes document px.

use serde::{Deserialize, Serialize};

use crate::blend::Blend;
use crate::doc::{Mask, Tiles};
use crate::gradient;
use crate::styles::Style;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColorStop {
    pub position: f32,
    pub color: [u8; 3],
    pub midpoint: f32,
    /// The 32-bit Color Picker's Intensity in stops: the color times 2^intensity in linear light, in 32-bit
    /// documents only.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub intensity: f32,
}

fn is_zero(v: &f32) -> bool {
    *v == 0.0
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OpacityStop {
    pub position: f32,
    pub opacity: f32,
    pub midpoint: f32,
}

/// A gradient's stops and interpolation method, without geometry.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GradientDef {
    pub method: gradient::Method,
    pub color_stops: Vec<ColorStop>,
    pub opacity_stops: Vec<OpacityStop>,
}

/// A gradient laid out over the layer or document box (fill layers, overlays, strokes).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GradientFill {
    pub gradient: GradientDef,
    pub style: gradient::Style,
    pub angle: f32,
    pub scale: f32,
    pub reverse: bool,
    pub dither: bool,
    pub align_with_layer: bool,
    pub offset: [f32; 2],
}

/// A tiled document pattern (`Document::patterns` id); `linked` = origin moves with the layer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatternFill {
    pub pattern_id: String,
    pub scale: f32,
    pub angle: f32,
    pub linked: bool,
    pub offset: [f32; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SolidFill {
    pub color: [u8; 3],
}

/// Fill layer content and stroke fill.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum FillContent {
    Solid(SolidFill),
    Gradient(GradientFill),
    Pattern(PatternFill),
}

impl GradientDef {
    /// The normalized (and optionally reversed) stops as a gradient LUT; `hdr` (a 32-bit document) applies
    /// the stops' Intensity.
    pub fn lut(&self, reverse: bool, hdr: bool) -> Vec<[f32; 4]> {
        let cs = self.color_stops(reverse, hdr);
        let os = self.opacity_stops.iter().map(|s| gradient::OpacityStop {
            position: s.position,
            opacity: s.opacity,
            midpoint: s.midpoint,
        });
        let mut os = gradient::normalize_opacity_stops(os.collect());
        if reverse {
            os = gradient::reverse_opacity_stops(&os);
        }
        gradient::build_lut(&cs, &os, self.method)
    }

    /// `n` colours of the normalized (and optionally reversed) color stops, opacity ignored.
    pub fn color_table(&self, reverse: bool, n: usize) -> Vec<[f32; 3]> {
        gradient::color_table(&self.color_stops(reverse, false), self.method, n)
    }

    fn color_stops(&self, reverse: bool, hdr: bool) -> Vec<gradient::ColorStop> {
        let cs = self.color_stops.iter().map(|s| {
            let k = if hdr && s.intensity != 0.0 { s.intensity.clamp(-20.0, 20.0).exp2() } else { 1.0 };
            gradient::ColorStop {
                position: s.position,
                rgb: s.color.map(|v| v as f32 / 255.0).map(|c| if k == 1.0 { c } else { gradient::exposed(c, k) }),
                midpoint: s.midpoint,
            }
        });
        let cs = gradient::normalize_color_stops(cs.collect());
        if reverse { gradient::reverse_color_stops(&cs) } else { cs }
    }
}

impl GradientFill {
    /// Straight RGBA at document point (x, y), laid out over the box [x, y, w, h] (docs/M3.md
    /// section 5): center = box center + offset * half size, length (|w cos A| + |h sin A|) * scale. `hdr`: a
    /// 32-bit document (stop Intensity applies, dither keeps values above 1).
    pub fn sampler(&self, bx: [f64; 4], hdr: bool) -> impl Fn(f64, f64) -> [f32; 4] {
        let lut = self.gradient.lut(self.reverse, hdr);
        let a = (self.angle as f64).to_radians();
        let (dx, dy) = (a.cos(), -a.sin());
        let half = (bx[2] * dx.abs() + bx[3] * dy.abs()) * self.scale as f64 / 2.0;
        let cx = bx[0] + bx[2] / 2.0 * (1.0 + self.offset[0] as f64);
        let cy = bx[1] + bx[3] / 2.0 * (1.0 + self.offset[1] as f64);
        // Linear runs through the center; the other styles start at it.
        let (sx, sy) = if self.style == gradient::Style::Linear { (cx - dx * half, cy - dy * half) } else { (cx, cy) };
        let (vx, vy) = (cx + dx * half - sx, cy + dy * half - sy);
        let (style, dither) = (self.style, self.dither);
        move |x, y| {
            let t = gradient::style_t(style, x - sx, y - sy, vx, vy, vx * vx + vy * vy);
            let mut c = gradient::lut_lookup(&lut, t);
            if dither {
                let d = gradient::dither_delta(x.floor() as i32, y.floor() as i32);
                let top = if hdr { f32::MAX } else { 1.0 };
                c[..3].iter_mut().for_each(|v| *v = (*v + d).clamp(0.0, top));
            }
            c
        }
    }
}

impl PatternFill {
    /// Straight RGBA at document point (x, y): the `w` x `h` RGBA8 pattern rotated clockwise by
    /// `angle`, `scale` px per texel, tiled from `origin` + offset, nearest texel. Transparent
    /// when `rgba` is not `w * h * 4` bytes long.
    pub fn sampler<'a>(&self, w: u32, h: u32, rgba: &'a [u8], origin: [f64; 2]) -> impl Fn(f64, f64) -> [f32; 4] + 'a {
        let ok = rgba.len() == w as usize * h as usize * 4;
        let a = (self.angle as f64).to_radians();
        let (c, s) = (a.cos(), a.sin());
        let scale = (self.scale as f64).max(1e-6);
        let (ox, oy) = (origin[0] + self.offset[0] as f64, origin[1] + self.offset[1] as f64);
        move |x, y| {
            if !ok {
                return [0.0; 4];
            }
            let (qx, qy) = (x - ox, y - oy);
            let u = ((qx * c + qy * s) / scale).floor() as i64;
            let v = ((qy * c - qx * s) / scale).floor() as i64;
            let o = ((v.rem_euclid(h as i64) * w as i64 + u.rem_euclid(w as i64)) * 4) as usize;
            std::array::from_fn(|i| rgba[o + i] as f32 / 255.0)
        }
    }
}

impl FillContent {
    pub fn pattern_id(&self) -> Option<&str> {
        match self {
            FillContent::Pattern(p) => Some(&p.pattern_id),
            _ => None,
        }
    }
}

/// A document pattern: `width * height` RGBA 8-bit pixels in blob `blob`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatternEntry {
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub blob: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GlobalLight {
    pub angle: f32,
    pub altitude: f32,
}

impl Default for GlobalLight {
    fn default() -> GlobalLight {
        GlobalLight { angle: 120.0, altitude: 30.0 }
    }
}

/// One layer's state in a comp; `position` is the bounds origin, none for empty bounds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompLayer {
    pub id: u32,
    pub visible: bool,
    pub position: Option<[i32; 2]>,
    pub opacity: f32,
    pub fill: f32,
    pub blend: Blend,
    pub style: Option<Style>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayerComp {
    pub id: u32,
    pub name: String,
    pub comment: String,
    pub apply_visibility: bool,
    pub apply_position: bool,
    pub apply_appearance: bool,
    pub layers: Vec<CompLayer>,
}

/// Embedded (`id` names the placed content) or linked through a stored file handle (D7).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Link {
    Embedded { id: String },
    Linked { name: String, handle: String },
}

/// The M2 warp mesh: (3 cols + 1) x (3 rows + 1) control points in document px, row-major.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WarpMesh {
    pub cols: u32,
    pub rows: u32,
    pub points: Vec<[f64; 2]>,
    pub column_stops: Vec<f64>,
    pub row_stops: Vec<f64>,
}

/// Stored and round-tripped only (D11).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StackMode {
    Entropy,
    Kurtosis,
    Maximum,
    Mean,
    Median,
    Minimum,
    Range,
    Skewness,
    StandardDeviation,
    Summation,
    Variance,
}

pub use crate::filters::Filter;

/// One entry of a smart object's filter stack, which runs bottom to top in array order.
#[derive(Clone)]
pub struct SmartFilter {
    pub id: u32,
    pub filter: Filter,
    pub enabled: bool,
    pub opacity: f32,
    pub blend: Blend,
    pub mask: Option<Mask>,
    /// The imported PSD filter record for lossless write-back; byte arrays inside it are
    /// `{ "$blob": id }` references.
    pub psd: Option<serde_json::Value>,
}

const MAX_PSD_BYTES: usize = 8 << 20;

/// Validates a `SmartFilter::psd` value and returns the blob ids it references.
pub fn check_psd(v: &serde_json::Value) -> Result<Vec<u64>, String> {
    fn walk(v: &serde_json::Value, out: &mut Vec<u64>) -> Result<(), String> {
        match v {
            serde_json::Value::Array(a) => a.iter().try_for_each(|x| walk(x, out)),
            serde_json::Value::Object(o) => match (o.len(), o.get("$blob")) {
                (1, Some(id)) => {
                    out.push(id.as_u64().ok_or("a PSD blob reference must be a blob id")?);
                    Ok(())
                }
                _ => o.values().try_for_each(|x| walk(x, out)),
            },
            _ => Ok(()),
        }
    }
    if !v.is_object() || v.to_string().len() > MAX_PSD_BYTES {
        return Err("the PSD filter record must be an object of at most 8 MiB".into());
    }
    let mut out = Vec::new();
    walk(v, &mut out)?;
    Ok(out)
}

/// A smart object (section 6). `source_blob` holds the source file bytes (none for a linked
/// object), `source_tiles` its flattened pixels in source px; `cache` is in document space.
#[derive(Clone)]
pub struct Smart {
    pub link: Link,
    pub source_blob: Option<u64>,
    pub source_tiles: Tiles,
    pub source_size: [u32; 2],
    pub transform: [f64; 9],
    pub warp: Option<WarpMesh>,
    pub filters: Vec<SmartFilter>,
    pub stack_mask: Option<Mask>,
    pub stack_mode: Option<StackMode>,
    pub cache: Tiles,
    /// The layer mask fingerprint `cache` was rendered with (0 = unknown; see `settle_smart`).
    pub mask_key: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn def(intensity: f32) -> GradientDef {
        serde_json::from_value(serde_json::json!({
            "method": "classic",
            "color_stops": [
                { "position": 0.0, "color": [128, 64, 32], "midpoint": 0.5, "intensity": intensity },
                { "position": 1.0, "color": [255, 255, 255], "midpoint": 0.5 }
            ],
            "opacity_stops": [{ "position": 0.0, "opacity": 1.0, "midpoint": 0.5 }, { "position": 1.0, "opacity": 1.0, "midpoint": 0.5 }]
        }))
        .unwrap()
    }

    #[test]
    fn a_stop_intensity_exposes_its_color_in_32_bit_documents_only() {
        let c = [128.0f32, 64.0, 32.0].map(|v| v / 255.0);
        let hdr = def(1.0).lut(false, true)[0];
        for i in 0..3 {
            assert!((hdr[i] - gradient::exposed(c[i], 2.0)).abs() < 1e-5, "{hdr:?}");
        }
        assert!(hdr[0] > 1.0 - 1e-6 || hdr[0] > c[0], "brighter than the stop color");
        let flat = def(1.0).lut(false, false)[0];
        assert!((0..3).all(|i| (flat[i] - c[i]).abs() < 1e-6), "8/16-bit documents ignore it: {flat:?}");
        // Zero is not written, and files without the field read as zero.
        let j = serde_json::to_value(def(0.0)).unwrap();
        assert!(j["color_stops"][0].get("intensity").is_none());
        assert_eq!(serde_json::to_value(def(2.0)).unwrap()["color_stops"][0]["intensity"], 2.0);
        let hdr_dither = GradientFill {
            gradient: def(3.0), style: gradient::Style::Linear, angle: 0.0, scale: 1.0, reverse: false, dither: true, align_with_layer: true, offset: [0.0, 0.0],
        }
        .sampler([0.0, 0.0, 100.0, 1.0], true)(0.5, 0.5);
        assert!(hdr_dither[0] > 1.0, "dither keeps values above 1: {hdr_dither:?}");
    }

    #[test]
    fn a_32_bit_gradient_fill_layer_composites_its_stop_intensity() {
        let fill = |depth: u8| {
            let mut d = crate::doc::Document::new(16, 16, depth).unwrap();
            let g = serde_json::json!({ "name": "g", "content": { "type": "gradient", "gradient": def(2.0), "style": "linear", "angle": 0.0, "scale": 1.0,
                "reverse": false, "dither": false, "align_with_layer": false, "offset": [0.0, 0.0] } });
            d.add_fill_layer(1, &g.to_string()).unwrap();
            d
        };
        let hdr = fill(32).flatten_tile_f32(0, 0).unwrap();
        let want = gradient::exposed(128.0 / 255.0, 4.0);
        assert!((hdr[0] - want).abs() < 0.01, "the left edge holds the stop color times 4 in linear light: {:?} vs {want}", &hdr[..4]);
        let eight = fill(8).flatten_tile_rgba8(0, 0).unwrap();
        assert!(eight[0] < 160, "8-bit documents ignore it: {:?}", &eight[..4]);
    }
}
