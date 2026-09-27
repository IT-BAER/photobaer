//! Type layer data model (docs/M4.md sections 1 and 9). Lengths in pt unless named px; spans
//! count UTF-16 code units of `text`. Fonts are referenced by name, never embedded (D4).

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::path::{finite, range, VectorPath};

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Caps {
    Normal,
    All,
    Small,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Baseline {
    Normal,
    Super,
    Sub,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AntiAlias {
    None,
    Sharp,
    Crisp,
    Strong,
    Smooth,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kerning {
    Metrics,
    Optical,
    None,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    pub length: u32,
    pub family: String,
    pub style: String,
    pub postscript_name: String,
    pub size: f64,
    /// 1/1000 em.
    pub tracking: f64,
    /// None = auto (1.2 x size).
    pub leading: Option<f64>,
    pub color: [u8; 3],
    pub faux_bold: bool,
    pub faux_italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub caps: Caps,
    pub baseline: Baseline,
    pub baseline_shift: f64,
    pub horizontal_scale: f64,
    pub vertical_scale: f64,
    pub anti_alias: AntiAlias,
    pub ligatures: bool,
    pub discretionary_ligatures: bool,
    pub kerning: Kerning,
    pub language: String,
    pub no_break: bool,
    pub tsume: f64,
    /// OpenType feature tag -> on (D6).
    pub features: BTreeMap<String, bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Alignment {
    Left,
    Center,
    Right,
    JustifyLeft,
    JustifyCenter,
    JustifyRight,
    JustifyAll,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Composer {
    SingleLine,
    EveryLine,
}

/// Minimum, desired, maximum as fractions (word 0.8/1/1.33, letter 0/0/0, glyph 1/1/1).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Justification {
    pub word: [f64; 3],
    pub letter: [f64; 3],
    pub glyph: [f64; 3],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hyphenation {
    pub min_word: u32,
    pub after_first: u32,
    pub before_last: u32,
    pub limit: u32,
    pub zone: f64,
    pub capitalized: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Paragraph {
    pub length: u32,
    pub alignment: Alignment,
    pub indent_left: f64,
    pub indent_right: f64,
    pub indent_first: f64,
    pub space_before: f64,
    pub space_after: f64,
    pub hyphenate: bool,
    pub rtl: bool,
    pub composer: Composer,
    pub justification: Justification,
    pub hyphenation: Hyphenation,
    pub hanging_punctuation: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum TextShape {
    Point,
    /// `[left, top, right, bottom]` in text space.
    Paragraph {
        #[serde(rename = "box")]
        rect: [f64; 4],
    },
    OnPath { path: VectorPath, start: f64, end: f64, flip: bool },
    InShape { path: VectorPath },
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Orientation {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WarpStyle {
    Arc,
    ArcLower,
    ArcUpper,
    Arch,
    Bulge,
    ShellLower,
    ShellUpper,
    Flag,
    Wave,
    Fish,
    Rise,
    Fisheye,
    Inflate,
    Squeeze,
    Twist,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextWarp {
    pub style: WarpStyle,
    /// Fractions -1..1.
    pub bend: f64,
    pub horizontal: f64,
    pub vertical: f64,
    pub axis: Orientation,
}

/// A text layer without its `cache` tiles (the manifest stores those as the node's `tiles`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TextData {
    pub text: String,
    pub runs: Vec<Run>,
    pub paragraphs: Vec<Paragraph>,
    pub shape: TextShape,
    pub orientation: Orientation,
    /// 2x3 affine `[a, b, c, d, e, f]`, text space to document px.
    pub transform: [f64; 6],
    pub warp: Option<TextWarp>,
    /// The imported PSD text object, kept for lossless write-back.
    pub psd: Option<serde_json::Value>,
}

impl TextData {
    pub fn validate(&self) -> Result<(), String> {
        let len = self.text.encode_utf16().count() as u64;
        let spans = |ls: &mut dyn Iterator<Item = u32>, what: &str| {
            let (n, sum) = ls.fold((0, 0u64), |(n, s), l| (n + 1, s + l as u64));
            if n == 0 || sum != len {
                return Err(format!("text {what} must be non-empty and cover the text exactly"));
            }
            Ok(())
        };
        spans(&mut self.runs.iter().map(|r| r.length), "runs")?;
        spans(&mut self.paragraphs.iter().map(|p| p.length), "paragraphs")?;
        for r in &self.runs {
            range(r.size, 0.01, 10000.0, "run size")?;
            r.leading.map_or(Ok(()), |l| range(l, 0.0, 10000.0, "run leading"))?;
            [r.tracking, r.baseline_shift, r.tsume].iter().try_for_each(|&v| finite(v, "a run value"))?;
            range(r.horizontal_scale, 0.0, 100.0, "run horizontal_scale")?;
            range(r.vertical_scale, 0.0, 100.0, "run vertical_scale")?;
        }
        for p in &self.paragraphs {
            let j = &p.justification;
            [p.indent_left, p.indent_right, p.indent_first, p.space_before, p.space_after, p.hyphenation.zone]
                .iter()
                .chain(j.word.iter().chain(&j.letter).chain(&j.glyph))
                .try_for_each(|&v| finite(v, "a paragraph value"))?;
        }
        self.transform.iter().try_for_each(|&v| finite(v, "the text transform"))?;
        match &self.shape {
            TextShape::Point => {}
            TextShape::Paragraph { rect } => rect.iter().try_for_each(|&v| finite(v, "the text box"))?,
            TextShape::OnPath { path, start, end, .. } => {
                path.validate()?;
                finite(*start, "text path start")?;
                finite(*end, "text path end")?;
            }
            TextShape::InShape { path } => path.validate()?,
        }
        if let Some(w) = &self.warp {
            for v in [w.bend, w.horizontal, w.vertical] {
                range(v, -1.0, 1.0, "a text warp value")?;
            }
        }
        Ok(())
    }
}
