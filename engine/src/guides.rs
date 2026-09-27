//! Guide and grid ops (docs/M4.md section 12: New Guide, New Guide Layout, New Guides From
//! Shape, move/delete/clear). A child module of `doc`. `artboard` parameters use `0` for "no
//! artboard" (the sentinel already used for `above` elsewhere in this module).

use super::*;
use crate::path::{finite, range, Artboard, Axis, DocVector, Guide, VectorMask};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GuideLayoutParams {
    rect: [f64; 4],
    columns: u32,
    column_gutter: f64,
    rows: u32,
    row_gutter: f64,
    /// `[top, left, bottom, right]`; absent = the margin toggle is off (0 on every side).
    margins: Option<[f64; 4]>,
    clear_existing: bool,
    artboard: u32,
}

// Left and right edge of every cell across `extent` starting at `start`, sorted and deduplicated
// (a zero gutter can make a cell's right edge coincide with the next cell's left edge).
fn layout_edges(start: f64, extent: f64, count: u32, gutter: f64) -> Vec<f64> {
    if count == 0 || extent <= 0.0 {
        return Vec::new();
    }
    let cell = (extent - (count.saturating_sub(1)) as f64 * gutter) / count as f64;
    let mut out = Vec::with_capacity(count as usize * 2);
    for i in 0..count {
        let left = start + i as f64 * (cell + gutter);
        out.push(left);
        out.push(left + cell);
    }
    out.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    out.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    out
}

impl Document {
    fn axis(s: &str) -> Result<Axis, String> {
        match s {
            "x" => Ok(Axis::X),
            "y" => Ok(Axis::Y),
            other => Err(format!("unknown guide axis {other}")),
        }
    }

    fn artboard_mut(&mut self, id: u32) -> Result<&mut Artboard, String> {
        self.node_mut(id)?.artboard.as_mut().ok_or_else(|| format!("node {id} is not an artboard"))
    }

    fn walk_artboards(nodes: &[Node], f: &mut impl FnMut(&Artboard)) {
        for n in nodes {
            if let Some(a) = &n.artboard {
                f(a);
            }
            if let Kind::Group(ch) = &n.kind {
                Document::walk_artboards(ch, f);
            }
        }
    }

    fn walk_artboards_mut(nodes: &mut [Node], f: &mut impl FnMut(&mut Artboard)) {
        for n in nodes {
            if let Some(a) = n.artboard.as_mut() {
                f(a);
            }
            if let Kind::Group(ch) = &mut n.kind {
                Document::walk_artboards_mut(ch, f);
            }
        }
    }

    fn all_artboard_guide_ids(&self) -> HashSet<u32> {
        let mut ids = HashSet::new();
        Document::walk_artboards(&self.nodes, &mut |a| ids.extend(a.guide_ids.iter().copied()));
        ids
    }

    fn untrack_guide(&mut self, id: u32) {
        Document::walk_artboards_mut(&mut self.nodes, &mut |a| a.guide_ids.retain(|g| *g != id));
    }

    fn next_guide_id(&self) -> u32 {
        self.vector.guides.iter().map(|g| g.id).max().unwrap_or(0) + 1
    }

    /// `artboard` 0 = a canvas guide; the position is already document px (the caller adds the
    /// targeted artboard's origin before calling, docs/M4.md Q10).
    fn insert_guide(&mut self, axis: Axis, pos: f64, artboard: u32) -> Result<u32, String> {
        finite(pos, "a guide position")?;
        if artboard != 0 {
            self.artboard_mut(artboard)?;
        }
        let id = self.next_guide_id();
        self.vector.guides.push(Guide { id, axis, pos });
        if artboard != 0 {
            self.artboard_mut(artboard)?.guide_ids.push(id);
        }
        Ok(id)
    }

    /// "New Guide".
    pub fn add_guide(&mut self, axis: &str, pos: f64, artboard: u32) -> Result<u32, String> {
        self.check_idle()?;
        let axis = Document::axis(axis)?;
        self.insert_guide(axis, pos, artboard)
    }

    /// "Move Guide"; refused while guides are locked.
    pub fn move_guide(&mut self, id: u32, pos: f64) -> Result<(), String> {
        self.check_idle()?;
        if self.vector.guides_locked {
            return Err("guides are locked".into());
        }
        finite(pos, "a guide position")?;
        let g = self.vector.guides.iter_mut().find(|g| g.id == id).ok_or_else(|| format!("unknown guide {id}"))?;
        g.pos = pos;
        Ok(())
    }

    /// "Delete Guide".
    pub fn delete_guide(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let before = self.vector.guides.len();
        self.vector.guides.retain(|g| g.id != id);
        if self.vector.guides.len() == before {
            return Err(format!("unknown guide {id}"));
        }
        self.untrack_guide(id);
        Ok(())
    }

    /// "Clear Guides": `scope` is "all", "canvas" (every guide not owned by an artboard) or
    /// "artboard" (the guides owned by `artboard`, which must then be non-zero).
    pub fn clear_guides(&mut self, scope: &str, artboard: u32) -> Result<(), String> {
        self.check_idle()?;
        match scope {
            "all" => {
                self.vector.guides.clear();
                Document::walk_artboards_mut(&mut self.nodes, &mut |a| a.guide_ids.clear());
            }
            "canvas" => {
                // Canvas guides are the ones no artboard names.
                let owned = self.all_artboard_guide_ids();
                self.vector.guides.retain(|g| owned.contains(&g.id));
            }
            "artboard" => {
                if artboard == 0 {
                    return Err("clearing an artboard's guides needs an artboard id".into());
                }
                let ids = std::mem::take(&mut self.artboard_mut(artboard)?.guide_ids);
                self.vector.guides.retain(|g| !ids.contains(&g.id));
            }
            other => return Err(format!("unknown guide clear scope {other}")),
        }
        Ok(())
    }

    /// "New Guide Layout" (docs/M4.md section 12): `rect` is the target (the canvas, or the
    /// targeted artboard's rect with `artboard` set); returns the new guide ids.
    pub fn new_guide_layout(&mut self, json: &str) -> Result<Vec<u32>, String> {
        self.check_idle()?;
        let p: GuideLayoutParams = serde_json::from_str(json).map_err(|e| format!("invalid guide layout: {e}"))?;
        p.rect.iter().try_for_each(|&v| finite(v, "a guide layout rect value"))?;
        range(p.columns as f64, 0.0, 100.0, "guide layout columns")?;
        range(p.rows as f64, 0.0, 100.0, "guide layout rows")?;
        range(p.column_gutter, 0.0, 500.0, "guide layout column gutter")?;
        range(p.row_gutter, 0.0, 500.0, "guide layout row gutter")?;
        if let Some(m) = p.margins {
            m.iter().try_for_each(|&v| range(v, 0.0, 2000.0, "a guide layout margin"))?;
        }
        if p.clear_existing {
            let scope = if p.artboard == 0 { "canvas" } else { "artboard" };
            self.clear_guides(scope, p.artboard)?;
        }
        let [x, y, w, h] = p.rect;
        let [top, left, bottom, right] = p.margins.unwrap_or([0.0; 4]);
        let mut ids = Vec::new();
        for pos in layout_edges(x + left, w - left - right, p.columns, p.column_gutter) {
            ids.push(self.insert_guide(Axis::X, pos, p.artboard)?);
        }
        for pos in layout_edges(y + top, h - top - bottom, p.rows, p.row_gutter) {
            ids.push(self.insert_guide(Axis::Y, pos, p.artboard)?);
        }
        Ok(ids)
    }

    /// "New Guides From Shape": 4 guides at the union of `ids`' content bounds' edges (no
    /// stroke/antialiasing inclusion, gap B16). Refuses when none has visible content.
    pub fn new_guides_from_shape(&mut self, ids: &[u32]) -> Result<Vec<u32>, String> {
        self.check_idle()?;
        if ids.is_empty() {
            return Err("new_guides_from_shape needs at least one layer".into());
        }
        let mut union: Option<[i32; 4]> = None;
        for &id in ids {
            let Some(b) = self.layer_bounds(id)? else { continue };
            union = Some(match union {
                None => b,
                Some(u) => {
                    let x0 = u[0].min(b[0]);
                    let y0 = u[1].min(b[1]);
                    let x1 = (u[0] + u[2]).max(b[0] + b[2]);
                    let y1 = (u[1] + u[3]).max(b[1] + b[3]);
                    [x0, y0, x1 - x0, y1 - y0]
                }
            });
        }
        let Some([x, y, w, h]) = union else {
            return Err("no selected layer has visible content".into());
        };
        Ok(vec![
            self.insert_guide(Axis::X, x as f64, 0)?,
            self.insert_guide(Axis::X, (x + w) as f64, 0)?,
            self.insert_guide(Axis::Y, y as f64, 0)?,
            self.insert_guide(Axis::Y, (y + h) as f64, 0)?,
        ])
    }

    /// Sets a node's vector mask, or removes it for `null`.
    pub fn set_vector_mask(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let vm: Option<VectorMask> = serde_json::from_str(json).map_err(|e| format!("invalid vector mask: {e}"))?;
        if let Some(v) = &vm {
            v.validate()?;
        }
        self.node_mut(id)?.vector_mask = vm;
        Ok(())
    }

    /// Sets a top-level group's artboard, or removes it for `null`; its guide ids must exist.
    pub fn set_artboard(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let a: Option<Artboard> = serde_json::from_str(json).map_err(|e| format!("invalid artboard: {e}"))?;
        if !self.nodes.iter().any(|n| n.id == id && n.is_group()) {
            return Err(format!("node {id}: an artboard is only allowed on a top-level group"));
        }
        if let Some(a) = &a {
            self.vector.check_artboard(a)?;
        }
        self.node_mut(id)?.artboard = a;
        Ok(())
    }

    /// Replaces the document's resolution, saved paths, guides, grid and locks (manifest v5 field
    /// names); every artboard's guide ids must stay known.
    pub fn set_document_vector(&mut self, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let v: DocVector = serde_json::from_str(json).map_err(|e| format!("invalid document vector data: {e}"))?;
        v.validate()?;
        let mut err = Ok(());
        Document::walk_artboards(&self.nodes, &mut |a| {
            if err.is_ok() {
                err = v.check_artboard(a);
            }
        });
        err?;
        self.vector = v;
        Ok(())
    }

    /// The document's resolution, guides, grid and locks for the UI (a projection of `manifest`).
    pub fn vector_json(&self) -> String {
        serde_json::to_string(&self.vector).expect("vector serialization cannot fail")
    }

    /// Sets `spacing_x`/`spacing_y` (px, > 0) and/or the lock flags. JSON: `{ grid?: { spacing_x,
    /// spacing_y }, guidesLocked?, artboardsLocked? }`.
    pub fn set_grid_and_locks(&mut self, json: &str) -> Result<(), String> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Patch {
            grid: Option<crate::path::Grid>,
            guides_locked: Option<bool>,
            artboards_locked: Option<bool>,
        }
        let p: Patch = serde_json::from_str(json).map_err(|e| format!("invalid grid/locks patch: {e}"))?;
        if let Some(g) = p.grid {
            range(g.spacing_x, f64::MIN_POSITIVE, f64::MAX, "grid spacing_x")?;
            range(g.spacing_y, f64::MIN_POSITIVE, f64::MAX, "grid spacing_y")?;
            self.vector.grid = g;
        }
        if let Some(v) = p.guides_locked {
            self.vector.guides_locked = v;
        }
        if let Some(v) = p.artboards_locked {
            self.vector.artboards_locked = v;
        }
        Ok(())
    }
}
