//! Adjustment layer kinds and their typed params (docs/M3.md section 3). Values use the dialog
//! units of that section; unknown kinds and unknown params keys fail to deserialize.

use serde::{Deserialize, Serialize};

use crate::content::GradientDef;

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

impl Adjustment {
    /// The blob this kind reads (the color lookup table), if any.
    pub fn blob(&self) -> Option<u64> {
        match self {
            Adjustment::ColorLookup(c) => c.table,
            _ => None,
        }
    }
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
