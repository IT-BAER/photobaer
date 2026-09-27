//! Paths panel ops (docs/M4.md section 4): the path-edit op with roles, saved and work paths,
//! Fill Path, Stroke Path, Make Selection, Make Work Path and Convert Path to Shape.
//! A child module of `doc`. Coverage buffers are full document size, like `stroke_selection`.

use super::*;
use crate::content::SolidFill;
use crate::geom;
use crate::path::{Cap, Join, SavedPath, StrokeAlign, VectorPath};

impl Document {
    /// The path a role names: `shape` (node id), `vectorMask` (node id) or `document` (path id).
    pub(super) fn role_path(&self, role: &str, id: u32) -> Result<&VectorPath, String> {
        match role {
            "shape" => match &self.node(id)?.kind {
                Kind::Shape(s) => Ok(&s.path),
                _ => Err(format!("node {id} is not a shape layer")),
            },
            "vectorMask" => self.node(id)?.vector_mask.as_ref().map(|m| &m.path).ok_or_else(|| format!("node {id} has no vector mask")),
            "document" => self.saved_path(id).map(|p| &p.path),
            other => Err(format!("unknown path role {other}")),
        }
    }

    fn saved_path(&self, id: u32) -> Result<&SavedPath, String> {
        self.vector.paths.iter().find(|p| p.id == id).ok_or_else(|| format!("unknown path {id}"))
    }

    fn saved_path_mut(&mut self, id: u32) -> Result<&mut SavedPath, String> {
        self.vector.paths.iter_mut().find(|p| p.id == id).ok_or_else(|| format!("unknown path {id}"))
    }

    fn lowest_free_path_name(&self, except: u32) -> String {
        let used: HashSet<&str> = self.vector.paths.iter().filter(|p| p.id != except).map(|p| p.name.as_str()).collect();
        (1..).map(|n| format!("Path {n}")).find(|n| !used.contains(n.as_str())).expect("a free name")
    }

    fn push_path(&mut self, name: String, path: VectorPath, work: bool) -> u32 {
        let id = self.vector.paths.iter().map(|p| p.id).max().unwrap_or(0) + 1;
        self.vector.paths.push(SavedPath { id, name, path, work });
        id
    }

    /// Replaces the path a role names. `document` with id 0 sets the work path (created as
    /// "Work Path" when there is none). A shape's edited path drops its live parameters.
    /// Returns the edited path or node id.
    pub fn set_path(&mut self, role: &str, id: u32, json: &str) -> Result<u32, String> {
        self.check_idle()?;
        let path: VectorPath = serde_json::from_str(json).map_err(|e| format!("invalid path: {e}"))?;
        path.validate()?;
        if !(role == "document" && id == 0) {
            self.role_path(role, id)?;
        }
        match role {
            "shape" => {
                let Kind::Shape(s) = &mut self.node_mut(id)?.kind else { unreachable!("checked by role_path") };
                s.path = path;
                s.live = None;
            }
            "vectorMask" => self.node_mut(id)?.vector_mask.as_mut().expect("checked by role_path").path = path,
            _ if id == 0 => {
                return Ok(match self.vector.paths.iter_mut().find(|p| p.work) {
                    Some(w) => {
                        w.path = path;
                        w.id
                    }
                    None => self.push_path("Work Path".into(), path, true),
                });
            }
            _ => self.saved_path_mut(id)?.path = path,
        }
        Ok(id)
    }

    /// "New Path": an empty saved path named "Path N", lowest free N.
    pub fn new_path(&mut self) -> Result<u32, String> {
        self.check_idle()?;
        let name = self.lowest_free_path_name(0);
        Ok(self.push_path(name, VectorPath { fill_rule: crate::path::FillRule::Nonzero, subpaths: Vec::new() }, false))
    }

    /// "Save Path": the work path becomes "Path N", lowest free N.
    pub fn save_path(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        if !self.saved_path(id)?.work {
            return Err("There is no work path to save.".into());
        }
        let name = self.lowest_free_path_name(id);
        let p = self.saved_path_mut(id)?;
        p.name = name;
        p.work = false;
        Ok(())
    }

    /// "Rename Path"; a renamed work path becomes a saved path.
    pub fn rename_path(&mut self, id: u32, name: &str) -> Result<(), String> {
        self.check_idle()?;
        let p = self.saved_path_mut(id)?;
        p.name = name.to_string();
        p.work = false;
        Ok(())
    }

    pub fn delete_path(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        self.saved_path(id)?;
        self.vector.paths.retain(|p| p.id != id);
        Ok(())
    }

    fn path_coverage(&self, role: &str, id: u32, stroke_width: Option<f64>) -> Result<Vec<f32>, String> {
        let p = self.role_path(role, id)?;
        let (w, h) = (self.width as usize, self.height as usize);
        let m = match stroke_width {
            None => geom::fill_mask(p, 0, 0, w, h),
            Some(sw) => geom::stroke_mask(p, sw, StrokeAlign::Center, Cap::Round, Join::Round, 100.0, &[], 0.0, 0, 0, w, h),
        };
        Ok(m.into_iter().map(|v| v as f32 / 255.0).collect())
    }

    // Paints `rgba` through the coverage on a pixel layer, ignoring the current selection.
    pub(super) fn paint_path_coverage(&mut self, layer: u32, cov: Vec<f32>, rgba: [u8; 4]) -> Result<(), String> {
        self.check_pixel_paint(layer)?;
        let saved = self.selection.take();
        let r = self
            .select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), Mode::New)
            .and_then(|_| self.fill_ex(layer, Target::Pixels, &FillSource::Solid(rgba), PaintMode::Blend(Blend::Normal), 1.0, false));
        self.selection = saved;
        r
    }

    /// "Fill Path": the path's anti-aliased coverage filled with `rgba` on a pixel layer.
    pub fn fill_path(&mut self, role: &str, id: u32, layer: u32, rgba: [u8; 4]) -> Result<(), String> {
        self.check_idle()?;
        let cov = self.path_coverage(role, id, None)?;
        self.paint_path_coverage(layer, cov, rgba)
    }

    /// "Stroke Path": a centered round-cap round-join stroke of `width` px (the reference's
    /// fixed style, default 1) in `rgba` on a pixel layer.
    pub fn stroke_path(&mut self, role: &str, id: u32, layer: u32, width: f64, rgba: [u8; 4]) -> Result<(), String> {
        self.check_idle()?;
        crate::path::range(width, 0.1, 1000.0, "stroke width")?;
        let cov = self.path_coverage(role, id, Some(width))?;
        self.paint_path_coverage(layer, cov, rgba)
    }

    /// "Make Selection from Path": the path's anti-aliased coverage, feather 0, combined by `mode`.
    pub fn make_selection_from_path(&mut self, role: &str, id: u32, mode: Mode) -> Result<(), String> {
        self.check_idle()?;
        let cov = self.path_coverage(role, id, None)?;
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), mode)
    }

    /// "Make Work Path from Selection": traces the selection (tolerance clamped 0.5..10 px) into
    /// the work path, replacing it. Returns the work path id.
    pub fn make_work_path(&mut self, tolerance: f64) -> Result<u32, String> {
        self.check_idle()?;
        if self.selection.is_none() {
            return Err("Make a selection first.".into());
        }
        let mask: Vec<u8> = self.selection_values().into_iter().map(|v| (v * 255.0).round() as u8).collect();
        let path = geom::trace(&mask, self.width as usize, self.height as usize, 0, 0, tolerance.clamp(0.5, 10.0));
        if path.subpaths.is_empty() {
            return Err("Make a selection first.".into());
        }
        self.set_path("document", 0, &serde_json::to_string(&path).expect("path serializes"))
    }

    /// "Convert Path to Shape": a shape layer "Shape" on top, filled with `rgb`.
    pub fn convert_path_to_shape(&mut self, role: &str, id: u32, rgb: [u8; 3]) -> Result<u32, String> {
        self.check_idle()?;
        let path = self.role_path(role, id)?.clone();
        if path.subpaths.is_empty() {
            return Err("There is no path to convert.".into());
        }
        let shape = ShapeData { path, live: None, fill: Some(FillContent::Solid(SolidFill { color: rgb })), stroke: None };
        self.add_node("Shape", 0, Kind::Shape(Box::new(shape)))
    }
}
