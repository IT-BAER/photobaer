//! Layer style and blending options model (docs/M3.md section 5). Opacity, spread, choke, range,
//! jitter, noise, depth and scale are fractions (1 = 100 %), sizes and distances document px,
//! angles degrees. An effect renders only when both `present` and `enabled` are true.

use serde::{Deserialize, Serialize};

use crate::blend::Blend;
use crate::content::{FillContent, GradientDef, GradientFill, PatternFill};

/// At most this many instances per multi-instance effect list.
pub const MAX_INSTANCES: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContourMode {
    Point,
    Pencil,
}

/// A contour curve: points (input, output) in 0..255, turned into a table by the curves spline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contour {
    pub name: String,
    pub points: Vec<[f32; 2]>,
    pub mode: ContourMode,
    pub anti_alias: bool,
}

/// Drop and inner shadow; `knocks_out` (layer knocks out drop shadow) is read by drop shadows only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shadow {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub color: [u8; 3],
    pub use_global_light: bool,
    pub angle: f32,
    pub distance: f32,
    pub spread: f32,
    pub size: f32,
    pub contour: Contour,
    pub noise: f32,
    pub knocks_out: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum GlowFill {
    Color { color: [u8; 3] },
    Gradient { gradient: GradientDef },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlowTechnique {
    Softer,
    Precise,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlowSource {
    Edge,
    Center,
}

/// Outer and inner glow; `source` is read by inner glows only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Glow {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub fill: GlowFill,
    pub technique: GlowTechnique,
    pub spread: f32,
    pub size: f32,
    pub range: f32,
    pub jitter: f32,
    pub noise: f32,
    pub contour: Contour,
    pub source: GlowSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BevelStyle {
    Outer,
    Inner,
    Emboss,
    Pillow,
    StrokeEmboss,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BevelTechnique {
    Smooth,
    ChiselHard,
    ChiselSoft,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BevelDirection {
    Up,
    Down,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bevel {
    pub present: bool,
    pub enabled: bool,
    pub style: BevelStyle,
    pub technique: BevelTechnique,
    pub depth: f32,
    pub direction: BevelDirection,
    pub size: f32,
    pub soften: f32,
    pub use_global_light: bool,
    pub angle: f32,
    pub altitude: f32,
    pub gloss_contour: Contour,
    pub highlight_blend: Blend,
    pub highlight_color: [u8; 3],
    pub highlight_opacity: f32,
    pub shadow_blend: Blend,
    pub shadow_color: [u8; 3],
    pub shadow_opacity: f32,
}

/// The bevel's Contour sub-effect.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BevelContour {
    pub present: bool,
    pub enabled: bool,
    pub contour: Contour,
    pub range: f32,
}

/// The bevel's Texture sub-effect; `depth` is -10..10 (-1000..1000 %).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BevelTexture {
    pub present: bool,
    pub enabled: bool,
    pub pattern_id: String,
    pub scale: f32,
    pub depth: f32,
    pub invert: bool,
    pub linked: bool,
    pub offset: [f32; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Satin {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub color: [u8; 3],
    pub angle: f32,
    pub distance: f32,
    pub size: f32,
    pub contour: Contour,
    pub invert: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColorOverlay {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub color: [u8; 3],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GradientOverlay {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub gradient: GradientFill,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatternOverlay {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub pattern: PatternFill,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrokePosition {
    Outside,
    Inside,
    Center,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    pub present: bool,
    pub enabled: bool,
    pub size: f32,
    pub position: StrokePosition,
    pub blend: Blend,
    pub opacity: f32,
    pub overprint: bool,
    pub fill: FillContent,
}

/// A layer style. Single effects are none when the layer never had them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Style {
    pub enabled: bool,
    pub scale: f32,
    pub drop_shadows: Vec<Shadow>,
    pub inner_shadows: Vec<Shadow>,
    pub color_overlays: Vec<ColorOverlay>,
    pub gradient_overlays: Vec<GradientOverlay>,
    pub pattern_overlays: Vec<PatternOverlay>,
    pub strokes: Vec<Stroke>,
    pub outer_glow: Option<Glow>,
    pub inner_glow: Option<Glow>,
    pub bevel: Option<Bevel>,
    pub contour: Option<BevelContour>,
    pub texture: Option<BevelTexture>,
    pub satin: Option<Satin>,
}

impl Style {
    /// Every document pattern id the style reads.
    pub fn pattern_ids(&self) -> impl Iterator<Item = &str> {
        let overlays = self.pattern_overlays.iter().map(|p| p.pattern.pattern_id.as_str());
        let strokes = self.strokes.iter().filter_map(|s| s.fill.pattern_id());
        let texture = self.texture.iter().map(|t| t.pattern_id.as_str());
        overlays.chain(strokes).chain(texture)
    }

    /// The list length limit of section 5.
    pub fn check(&self) -> Result<(), String> {
        let lens = [
            self.drop_shadows.len(),
            self.inner_shadows.len(),
            self.color_overlays.len(),
            self.gradient_overlays.len(),
            self.pattern_overlays.len(),
            self.strokes.len(),
        ];
        if lens.iter().any(|&n| n > MAX_INSTANCES) {
            return Err(format!("a layer style holds at most {MAX_INSTANCES} instances per effect"));
        }
        Ok(())
    }
}

/// Blend-if split ranges [black outer, black inner, white inner, white outer] in 0..255.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlendRange {
    pub source: [u8; 4],
    pub destination: [u8; 4],
}

impl Default for BlendRange {
    fn default() -> BlendRange {
        BlendRange { source: [0, 0, 255, 255], destination: [0, 0, 255, 255] }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlendIf {
    pub gray: BlendRange,
    pub red: BlendRange,
    pub green: BlendRange,
    pub blue: BlendRange,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Knockout {
    #[default]
    None,
    Shallow,
    Deep,
}

/// Advanced blending options of every node; fill opacity is `Node::fill`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Blending {
    pub blend_if: BlendIf,
    pub channels: [bool; 3],
    pub knockout: Knockout,
    pub blend_interior: bool,
    pub blend_clipped: bool,
    pub transparency_shapes: bool,
    pub layer_mask_hides_effects: bool,
    pub vector_mask_hides_effects: bool,
}

impl Default for Blending {
    fn default() -> Blending {
        Blending {
            blend_if: BlendIf::default(),
            channels: [true; 3],
            knockout: Knockout::None,
            blend_interior: false,
            blend_clipped: true,
            transparency_shapes: true,
            layer_mask_hides_effects: false,
            vector_mask_hides_effects: false,
        }
    }
}
