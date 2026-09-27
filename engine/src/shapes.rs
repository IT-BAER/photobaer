//! Shape tool and live shape ops (docs/M4.md section 5): new shape layers from live parameters,
//! Properties edits, and the tools' Pixels mode. A child module of `doc`.

use super::*;
use crate::geom;
use crate::path::{Cap, Join, Live, ShapeStroke, StrokeAlign, VectorPath};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewShapeIn {
    name: String,
    #[serde(default)]
    live: Option<Live>,
    #[serde(default)]
    path: Option<VectorPath>,
    fill: Option<FillContent>,
    stroke: Option<ShapeStroke>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ShapeIn {
    live: Option<Live>,
    fill: Option<FillContent>,
    stroke: Option<ShapeStroke>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PixelStroke {
    width: f64,
    color: [u8; 4],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FillShapeIn {
    live: Live,
    fill: Option<[u8; 4]>,
    stroke: Option<PixelStroke>,
}

/// The geometry of a live shape; custom shapes have no generator here.
pub fn live_path(live: &Live) -> Result<VectorPath, String> {
    live.validate()?;
    geom::live(live).ok_or_else(|| "a custom shape needs its shape data".into())
}

impl Document {
    /// A shape layer on top whose path is generated from `live` or given as `path` (exactly one;
    /// the shape and pen tools' new shape layer).
    pub fn new_shape(&mut self, json: &str) -> Result<u32, String> {
        self.check_idle()?;
        let s: NewShapeIn = serde_json::from_str(json).map_err(|e| format!("invalid shape: {e}"))?;
        let path = match (&s.live, s.path) {
            (Some(l), None) => live_path(l)?,
            (None, Some(p)) => p,
            _ => return Err("a new shape needs exactly one of live or path".into()),
        };
        let shape = ShapeData { path, live: s.live, fill: s.fill, stroke: s.stroke };
        shape.validate(|id| self.patterns.iter().any(|p| p.id == id))?;
        self.add_node(&s.name, 0, Kind::Shape(Box::new(shape)))
    }

    /// Replaces a shape layer's live parameters, fill and stroke. The path is regenerated only when
    /// `live` differs from the stored one, so an unchanged imported path stays exact.
    pub fn set_shape(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let s: ShapeIn = serde_json::from_str(json).map_err(|e| format!("invalid shape: {e}"))?;
        let node = self.node(id)?;
        let Kind::Shape(old) = &node.kind else {
            return Err(format!("node {id} is a {} layer, not a shape layer", node.kind_name()));
        };
        let path = match &s.live {
            Some(l) if old.live.as_ref() != Some(l) => live_path(l)?,
            _ => old.path.clone(),
        };
        let shape = ShapeData { path, live: s.live, fill: s.fill, stroke: s.stroke };
        shape.validate(|id| self.patterns.iter().any(|p| p.id == id))?;
        let Kind::Shape(dst) = &mut self.node_mut(id)?.kind else { unreachable!("checked above") };
        **dst = shape;
        Ok(())
    }

    /// The tools' Pixels mode ("Fill Shape"): the live shape's fill, then a centered butt/miter
    /// stroke, painted on a pixel layer, ignoring the selection.
    pub fn fill_shape(&mut self, layer: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let s: FillShapeIn = serde_json::from_str(json).map_err(|e| format!("invalid shape: {e}"))?;
        let path = live_path(&s.live)?;
        self.check_pixel_paint(layer)?;
        let (w, h) = (self.width as usize, self.height as usize);
        let cov = |m: Vec<u8>| m.into_iter().map(|v| v as f32 / 255.0).collect::<Vec<f32>>();
        if let Some(rgba) = s.fill {
            self.paint_path_coverage(layer, cov(geom::fill_mask(&path, 0, 0, w, h)), rgba)?;
        }
        if let Some(st) = s.stroke.filter(|st| st.width > 0.0) {
            crate::path::range(st.width, 0.0, 1000.0, "stroke width")?;
            let m = geom::stroke_mask(&path, st.width, StrokeAlign::Center, Cap::Butt, Join::Miter, 100.0, &[], 0.0, 0, 0, w, h);
            self.paint_path_coverage(layer, cov(m), st.color)?;
        }
        Ok(())
    }
}
