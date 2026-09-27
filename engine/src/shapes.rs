//! Shape tool and live shape ops (docs/M4.md sections 5 and 6): new shape layers from live
//! parameters, Properties edits, the tools' Pixels mode, Combine Shapes and Pathfinder, and the
//! Rasterize commands for shapes, type and vector masks. A child module of `doc`.

use super::*;
use crate::geom;
use crate::geom::BoolOp;
use crate::path::{Cap, Join, Live, PathOp, ShapeStroke, StrokeAlign, Subpath, VectorPath};

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
    #[serde(default)]
    live: Option<Live>,
    #[serde(default)]
    path: Option<VectorPath>,
    fill: Option<[u8; 4]>,
    stroke: Option<PixelStroke>,
}

/// The geometry of a live shape; custom shapes have no generator here.
pub fn live_path(live: &Live) -> Result<VectorPath, String> {
    live.validate()?;
    geom::live(live).ok_or_else(|| "a custom shape needs its shape data".into())
}

fn bool_op(op: &str) -> Result<BoolOp, String> {
    match op {
        "unite" => Ok(BoolOp::Unite),
        "subtract" => Ok(BoolOp::SubtractFront),
        "intersect" => Ok(BoolOp::Intersect),
        "exclude" => Ok(BoolOp::Exclude),
        _ => Err(format!("unknown shape operation {op}")),
    }
}

impl Document {
    fn shape_mut(&mut self, id: u32) -> Result<&mut ShapeData, String> {
        match &mut self.node_mut(id)?.kind {
            Kind::Shape(s) => Ok(s),
            _ => Err(format!("node {id} is not a shape layer")),
        }
    }

    /// The shape layers among `ids`, bottom first.
    fn shapes_in_order(&self, ids: &[u32]) -> Vec<u32> {
        let mut v: Vec<(Vec<usize>, u32)> = ids
            .iter()
            .filter(|&&id| matches!(self.node(id).map(|n| &n.kind), Ok(Kind::Shape(_))))
            .filter_map(|&id| self.find_path(id).ok().map(|p| (p, id)))
            .collect();
        v.sort();
        v.dedup();
        v.into_iter().map(|(_, id)| id).collect()
    }

    fn shape_path(&self, id: u32) -> VectorPath {
        match &self.node(id).expect("a listed shape").kind {
            Kind::Shape(s) => s.path.clone(),
            _ => unreachable!("filtered to shapes"),
        }
    }

    /// Layer > Combine Shapes: the bottom shape layer's path combined with each one above it in
    /// stack order (flattened, corner anchors); the others are removed. Returns the kept id.
    pub fn combine_shapes(&mut self, ids: &[u32], op: &str) -> Result<u32, String> {
        self.check_idle()?;
        let op = bool_op(op)?;
        let order = self.shapes_in_order(ids);
        if order.len() < 2 {
            return Err("Select two or more shape layers to combine them.".into());
        }
        let path = order[1..].iter().fold(self.shape_path(order[0]), |acc, &id| geom::boolean(&acc, &self.shape_path(id), op));
        let s = self.shape_mut(order[0])?;
        s.path = path;
        s.live = None;
        for &id in &order[1..] {
            self.delete_node(id)?;
        }
        Ok(order[0])
    }

    /// Properties Pathfinder on one layer: its first subpath combined with each next one in order.
    /// Fewer than two subpaths leave it unchanged.
    pub fn pathfinder(&mut self, id: u32, op: &str) -> Result<(), String> {
        self.check_idle()?;
        let op = bool_op(op)?;
        let s = self.shape_mut(id)?;
        if s.path.subpaths.len() < 2 {
            return Ok(());
        }
        let rule = s.path.fill_rule;
        let one = |sub: &Subpath| VectorPath { fill_rule: rule, subpaths: vec![Subpath { op: PathOp::Combine, ..sub.clone() }] };
        let path = s.path.subpaths[1..].iter().fold(one(&s.path.subpaths[0]), |acc, sub| geom::boolean(&acc, &one(sub), op));
        s.path = path;
        s.live = None;
        Ok(())
    }

    /// Layer > Combine Shapes > Merge Shape Components: each shape's filled region as plain loops.
    pub fn merge_shape_components(&mut self, ids: &[u32]) -> Result<(), String> {
        self.check_idle()?;
        let order = self.shapes_in_order(ids);
        if order.is_empty() {
            return Err("Select a shape layer first.".into());
        }
        for id in order {
            let s = self.shape_mut(id)?;
            s.path = geom::merge_components(&s.path);
            s.live = None;
        }
        Ok(())
    }

    /// Layer > Rasterize > Shape: the shape's render becomes the pixels of a pixel layer (same id,
    /// mask, vector mask, style and blending).
    pub fn rasterize_shape(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let node = self.node(id)?;
        let Kind::Shape(s) = &node.kind else { return Err(format!("{} is not a shape layer.", node.name)) };
        let rendered = self.shape_tiles(s);
        let mut tiles = Tiles::default();
        for (&(tx, ty), t) in rendered.iter() {
            let tid = self.alloc_tile_id();
            tiles.put(tx, ty, Some(Tile { id: tid, px: t.px.clone() }));
        }
        self.node_mut(id)?.kind = Kind::Pixel(tiles);
        Ok(())
    }

    /// Layer > Rasterize > Type: the text layer's rendered cache becomes its pixels.
    pub fn rasterize_type(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let node = self.node_mut(id)?;
        let name = node.name.clone();
        let Kind::Text(t) = &mut node.kind else { return Err(format!("{name} is not a type layer.")) };
        let tiles = t.cache.take().filter(|c| !c.coords().is_empty()).ok_or_else(|| format!("{name} has no text to rasterize."))?;
        node.kind = Kind::Pixel(tiles);
        Ok(())
    }

    /// Layer > Rasterize > Vector Mask: the vector mask (inverted, feather, density applied)
    /// multiplied into the raster mask, which is created when absent; the vector mask is removed.
    pub fn rasterize_vector_mask(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let node = self.node(id)?;
        let vm = node.vector_mask.as_ref().ok_or_else(|| format!("{} has no vector mask.", node.name))?;
        let max = max_value(self.depth) as f32;
        let (enabled, old_default) = node.mask.as_ref().map_or((true, max), |m| (m.enabled, m.default as f32));
        let mut planes = vec![];
        for ty in 0..self.tiles_y() {
            for tx in 0..self.tiles_x() {
                let (x0, y0) = ((tx as usize * TILE) as i64, (ty as usize * TILE) as i64);
                let mut v = self.vector_plane(vm, 0, x0, y0, TILE, TILE);
                let old = node.mask.as_ref().and_then(|m| m.tiles.get(tx as i32, ty as i32));
                for (p, x) in v.iter_mut().enumerate() {
                    *x *= old.map_or(old_default / max, |t| t.px.mask_f32(p));
                }
                let (vw, vh) = self.level_valid(0, tx, ty);
                planes.push((tx as i32, ty as i32, v, (0..vh).flat_map(move |y| (0..vw).map(move |x| y * TILE + x)).collect::<Vec<_>>()));
            }
        }
        // The default (and the Layers chip) is whichever of hidden or revealed covers more of the
        // canvas; tiles holding only that value on the canvas are left out.
        let shown: usize = planes.iter().map(|(_, _, v, at)| at.iter().filter(|&&p| v[p] >= 0.5).count()).sum();
        let reveal = shown * 2 >= (self.width as usize) * (self.height as usize);
        let d = if reveal { 1.0 } else { 0.0 };
        let mut tiles = Tiles::default();
        for (tx, ty, v, at) in planes {
            if at.iter().any(|&p| v[p] != d) {
                let tid = self.alloc_tile_id();
                tiles.put(tx, ty, Some(Tile { id: tid, px: Arc::new(Pixels::mask_from_norm(self.depth, &v)) }));
            }
        }
        let default = if reveal { max_value(self.depth) } else { 0 };
        let node = self.node_mut(id)?;
        node.mask = Some(Mask { enabled, default, tiles });
        node.vector_mask = None;
        Ok(())
    }

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

    /// The tools' Pixels mode ("Fill Shape"): the fill of the live shape or given path (exactly
    /// one), then a centered butt/miter stroke, painted on a pixel layer, ignoring the selection.
    pub fn fill_shape(&mut self, layer: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let s: FillShapeIn = serde_json::from_str(json).map_err(|e| format!("invalid shape: {e}"))?;
        let path = match (&s.live, s.path) {
            (Some(l), None) => live_path(l)?,
            (None, Some(p)) => {
                p.validate()?;
                p
            }
            _ => return Err("a shape needs exactly one of live or path".into()),
        };
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
