//! Vector data model (docs/M4.md sections 1 and 2): paths, shape layers, vector masks, saved
//! paths, guides, grid and artboards. Coordinates are f64 document px.

use serde::{Deserialize, Serialize};

use crate::blend::Blend;
use crate::content::FillContent;

/// Largest accepted coordinate magnitude: moves and transforms stay far from overflow to infinity.
pub(crate) const MAX_COORD: f64 = 1e7;

pub(crate) fn finite(v: f64, what: &str) -> Result<(), String> {
    if v.is_finite() && v.abs() <= MAX_COORD {
        Ok(())
    } else {
        Err(format!("{what} must be a finite number within +-{MAX_COORD}"))
    }
}

pub(crate) fn range(v: f64, lo: f64, hi: f64, what: &str) -> Result<(), String> {
    if (lo..=hi).contains(&v) {
        Ok(())
    } else {
        Err(format!("{what} must be in {lo}..={hi}"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillRule {
    Nonzero,
    Evenodd,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PathOp {
    Combine,
    Subtract,
    Intersect,
    Exclude,
}

/// One anchor: `[x, y, inX, inY, outX, outY]`, handles absolute; handle == anchor is a corner.
pub type Point = [f64; 6];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Subpath {
    pub closed: bool,
    pub op: PathOp,
    pub points: Vec<Point>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VectorPath {
    pub fill_rule: FillRule,
    pub subpaths: Vec<Subpath>,
}

impl VectorPath {
    pub fn validate(&self) -> Result<(), String> {
        self.subpaths.iter().flat_map(|s| s.points.iter().flatten()).try_for_each(|&v| finite(v, "a path coordinate"))
    }

    /// Moves every anchor and handle by (dx, dy).
    pub fn translate(&mut self, dx: f64, dy: f64) {
        for p in self.subpaths.iter_mut().flat_map(|s| s.points.iter_mut()) {
            for (i, v) in p.iter_mut().enumerate() {
                *v += if i % 2 == 0 { dx } else { dy };
            }
        }
    }
}

/// Rect as `[left, top, right, bottom]`.
pub type Bounds = [f64; 4];

fn check_bounds(b: &Bounds, what: &str) -> Result<(), String> {
    b.iter().try_for_each(|&v| finite(v, what))?;
    if b[2] < b[0] || b[3] < b[1] {
        return Err(format!("{what} must have right >= left and bottom >= top"));
    }
    Ok(())
}

/// The parametric origin of a shape layer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Live {
    /// Corner radii TL, TR, BL, BR.
    Rectangle { bounds: Bounds, radii: [f64; 4] },
    RoundedRectangle { bounds: Bounds, radii: [f64; 4] },
    Ellipse { bounds: Bounds },
    Triangle { bounds: Bounds, radius: f64 },
    Polygon { bounds: Bounds, sides: u32, star_inset: f64, radius: f64 },
    /// Weight = the stroke width.
    Line { start: [f64; 2], end: [f64; 2] },
    Custom { bounds: Bounds },
}

impl Live {
    fn translate(&mut self, dx: f64, dy: f64) {
        match self {
            Live::Line { start, end } => {
                for p in [start, end] {
                    (p[0], p[1]) = (p[0] + dx, p[1] + dy);
                }
            }
            Live::Rectangle { bounds, .. }
            | Live::RoundedRectangle { bounds, .. }
            | Live::Ellipse { bounds }
            | Live::Triangle { bounds, .. }
            | Live::Polygon { bounds, .. }
            | Live::Custom { bounds } => {
                for (i, v) in bounds.iter_mut().enumerate() {
                    *v += if i % 2 == 0 { dx } else { dy };
                }
            }
        }
    }

    pub(crate) fn validate(&self) -> Result<(), String> {
        let (bounds, radii): (&Bounds, &[f64]) = match self {
            Live::Rectangle { bounds, radii } | Live::RoundedRectangle { bounds, radii } => (bounds, radii),
            Live::Triangle { bounds, radius } => (bounds, std::slice::from_ref(radius)),
            Live::Polygon { bounds, sides, star_inset, radius } => {
                if !(3..=100).contains(sides) {
                    return Err("polygon sides must be in 3..=100".into());
                }
                range(*star_inset, 0.0, 0.99, "polygon star_inset")?;
                (bounds, std::slice::from_ref(radius))
            }
            Live::Ellipse { bounds } | Live::Custom { bounds } => (bounds, &[]),
            Live::Line { start, end } => return start.iter().chain(end).try_for_each(|&v| finite(v, "a line end")),
        };
        check_bounds(bounds, "live shape bounds")?;
        radii.iter().try_for_each(|&r| range(r, 0.0, f64::MAX, "a corner radius"))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrokeAlign {
    Inside,
    Center,
    Outside,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Cap {
    Butt,
    Round,
    Square,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Join {
    Miter,
    Round,
    Bevel,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShapeStroke {
    pub enabled: bool,
    pub width: f64,
    pub align: StrokeAlign,
    pub cap: Cap,
    pub join: Join,
    pub miter_limit: f64,
    /// Dash and gap lengths in px; empty = solid.
    pub dash: Vec<f64>,
    pub dash_offset: f64,
    pub content: FillContent,
    pub opacity: f32,
    pub blend: Blend,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShapeData {
    pub path: VectorPath,
    pub live: Option<Live>,
    /// None = no fill.
    pub fill: Option<FillContent>,
    pub stroke: Option<ShapeStroke>,
}

impl ShapeData {
    pub fn translate(&mut self, dx: f64, dy: f64) {
        self.path.translate(dx, dy);
        if let Some(l) = &mut self.live {
            l.translate(dx, dy);
        }
    }

    /// `has_pattern` answers whether a document pattern id exists.
    pub fn validate(&self, has_pattern: impl Fn(&str) -> bool) -> Result<(), String> {
        self.path.validate()?;
        self.live.as_ref().map_or(Ok(()), Live::validate)?;
        let stroke_content = self.stroke.as_ref().map(|s| &s.content);
        if let Some(id) = self.fill.iter().chain(stroke_content).filter_map(|c| c.pattern_id()).find(|id| !has_pattern(id)) {
            return Err(format!("unknown pattern {id}"));
        }
        let Some(s) = &self.stroke else { return Ok(()) };
        range(s.width, 0.0, 1000.0, "stroke width")?;
        range(s.miter_limit, 0.0, f64::MAX, "stroke miter_limit")?;
        s.dash.iter().try_for_each(|&d| range(d, 0.0, f64::MAX, "a stroke dash length"))?;
        finite(s.dash_offset, "stroke dash_offset")?;
        range(s.opacity as f64, 0.0, 1.0, "stroke opacity")?;
        if s.blend == Blend::PassThrough {
            return Err("pass through is only allowed on groups".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VectorMask {
    pub path: VectorPath,
    pub enabled: bool,
    pub linked: bool,
    pub inverted: bool,
    pub density: f64,
    pub feather: f64,
}

impl VectorMask {
    pub fn validate(&self) -> Result<(), String> {
        self.path.validate()?;
        range(self.density, 0.0, 1.0, "vector mask density")?;
        range(self.feather, 0.0, 1000.0, "vector mask feather")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ArtboardBackground {
    None,
    White,
    Black,
    Transparent,
    Color { color: [u8; 3] },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Artboard {
    pub rect: Bounds,
    pub background: ArtboardBackground,
    pub preset_name: String,
    pub guide_ids: Vec<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedPath {
    pub id: u32,
    pub name: String,
    pub path: VectorPath,
    /// The one work path; at most one per document.
    pub work: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Axis {
    X,
    Y,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Guide {
    pub id: u32,
    pub axis: Axis,
    pub pos: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grid {
    pub spacing_x: f64,
    pub spacing_y: f64,
}

impl Default for Grid {
    // The reference's "Gridline Every" default.
    fn default() -> Self {
        Grid { spacing_x: 100.0, spacing_y: 100.0 }
    }
}

/// The document-level vector state v5 adds; v1 to v4 load with the defaults.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocVector {
    /// Pixels per inch.
    pub resolution: f64,
    pub paths: Vec<SavedPath>,
    pub guides: Vec<Guide>,
    pub grid: Grid,
    pub guides_locked: bool,
    pub artboards_locked: bool,
}

impl Default for DocVector {
    fn default() -> Self {
        DocVector {
            resolution: 72.0,
            paths: Vec::new(),
            guides: Vec::new(),
            grid: Grid::default(),
            guides_locked: false,
            artboards_locked: false,
        }
    }
}

impl DocVector {
    pub fn validate(&self) -> Result<(), String> {
        range(self.resolution, 1.0, 30000.0, "resolution")?;
        range(self.grid.spacing_x, f64::MIN_POSITIVE, f64::MAX, "grid spacing_x")?;
        range(self.grid.spacing_y, f64::MIN_POSITIVE, f64::MAX, "grid spacing_y")?;
        let mut ids = std::collections::HashSet::new();
        for p in &self.paths {
            if !ids.insert(p.id) {
                return Err(format!("duplicate path id {}", p.id));
            }
            p.path.validate()?;
        }
        if self.paths.iter().filter(|p| p.work).count() > 1 {
            return Err("a document has at most one work path".into());
        }
        let mut ids = std::collections::HashSet::new();
        for g in &self.guides {
            if !ids.insert(g.id) {
                return Err(format!("duplicate guide id {}", g.id));
            }
            finite(g.pos, "a guide position")?;
        }
        Ok(())
    }

    pub fn check_artboard(&self, a: &Artboard) -> Result<(), String> {
        check_bounds(&a.rect, "artboard rect")?;
        match a.guide_ids.iter().find(|id| !self.guides.iter().any(|g| g.id == **id)) {
            Some(id) => Err(format!("artboard names unknown guide {id}")),
            None => Ok(()),
        }
    }
}
