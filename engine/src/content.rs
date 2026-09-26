//! Fill layer content, smart objects, smart filters, document patterns, global light and layer
//! comps (docs/M3.md sections 1, 4, 6, 7, 8). Scales and opacities are fractions (1 = 100 %),
//! angles degrees, offsets and sizes document px.

use serde::{Deserialize, Serialize};

use crate::adjust::{
    BlackWhite, BrightnessContrast, ChannelMixer, ColorBalance, ColorLookup, Curves, Exposure, GradientMap,
    HueSaturation, Invert, Levels, PhotoFilter, Posterize, SelectiveColor, Threshold, Vibrance,
};
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
    /// The normalized (and optionally reversed) stops as a gradient LUT.
    pub fn lut(&self, reverse: bool) -> Vec<[f32; 4]> {
        let cs = self.color_stops.iter().map(|s| gradient::ColorStop {
            position: s.position,
            rgb: s.color.map(|v| v as f32 / 255.0),
            midpoint: s.midpoint,
        });
        let os = self.opacity_stops.iter().map(|s| gradient::OpacityStop {
            position: s.position,
            opacity: s.opacity,
            midpoint: s.midpoint,
        });
        let mut cs = gradient::normalize_color_stops(cs.collect());
        let mut os = gradient::normalize_opacity_stops(os.collect());
        if reverse {
            cs = gradient::reverse_color_stops(&cs);
            os = gradient::reverse_opacity_stops(&os);
        }
        gradient::build_lut(&cs, &os, self.method)
    }
}

impl GradientFill {
    /// Straight RGBA at document point (x, y), laid out over the box [x, y, w, h] (docs/M3.md
    /// section 5): center = box center + offset * half size, length (|w cos A| + |h sin A|) * scale.
    pub fn sampler(&self, bx: [f64; 4]) -> impl Fn(f64, f64) -> [f32; 4] {
        let lut = self.gradient.lut(self.reverse);
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
                c[..3].iter_mut().for_each(|v| *v = (*v + d).clamp(0.0, 1.0));
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GaussianBlur {
    pub radius: f32,
}

/// A command a smart filter hosts in M3 (D8): the 16 adjustment kinds plus Gaussian blur.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "params", rename_all = "snake_case", deny_unknown_fields)]
pub enum Filter {
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
    GaussianBlur(GaussianBlur),
}

impl Filter {
    pub fn blob(&self) -> Option<u64> {
        match self {
            Filter::ColorLookup(c) => c.table,
            _ => None,
        }
    }
}

/// One entry of a smart object's filter stack, which runs bottom to top in array order.
#[derive(Clone)]
pub struct SmartFilter {
    pub id: u32,
    pub filter: Filter,
    pub enabled: bool,
    pub opacity: f32,
    pub blend: Blend,
    pub mask: Option<Mask>,
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
}
