//! Guide and grid ops (docs/M4.md section 12: New Guide, New Guide Layout, New Guides From
//! Shape, move/delete/clear). A child module of `doc`. `artboard` parameters use `0` for "no
//! artboard" (the sentinel already used for `above` elsewhere in this module).

use super::*;
use crate::path::{finite, range, Artboard, ArtboardBackground, Axis, DocVector, Guide, VectorMask};
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
    /// stroke/antialiasing inclusion). Refuses when none has visible content.
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

    fn artboard_ids(&self) -> Vec<u32> {
        self.nodes.iter().filter(|n| n.artboard.is_some()).map(|n| n.id).collect()
    }

    /// Union `[x, y, w, h]` of every leaf's content bounds under `id` (itself included).
    fn subtree_bounds(&self, id: u32) -> Result<Option<[i32; 4]>, String> {
        let mut ids = vec![];
        fn leaves(n: &Node, out: &mut Vec<u32>) {
            match &n.kind {
                Kind::Group(ch) => ch.iter().for_each(|c| leaves(c, out)),
                _ => out.push(n.id),
            }
        }
        leaves(self.node(id)?, &mut ids);
        let mut u: Option<[i32; 4]> = None;
        for id in ids {
            let Ok(Some(b)) = self.layer_bounds(id) else { continue };
            u = Some(match u {
                None => b,
                Some(a) => {
                    let (x0, y0) = (a[0].min(b[0]), a[1].min(b[1]));
                    [x0, y0, (a[0] + a[2]).max(b[0] + b[2]) - x0, (a[1] + a[3]).max(b[1] + b[3]) - y0]
                }
            });
        }
        Ok(u)
    }

    /// Grows the canvas right and down to cover every artboard (the reference keeps them inside).
    fn fit_canvas_to_artboards(&mut self) -> Result<(), String> {
        let (mut w, mut h) = (self.width as i32, self.height as i32);
        for n in self.nodes.iter().filter_map(|n| n.artboard.as_ref()) {
            w = w.max(n.rect[2].ceil() as i32);
            h = h.max(n.rect[3].ceil() as i32);
        }
        if (w, h) != (self.width as i32, self.height as i32) {
            self.crop_to([0, 0, w, h], false)?;
        }
        Ok(())
    }

    /// "New Artboard": a top-level artboard group of `w` x `h` placed 100 px right of `after`
    /// (a selected artboard), else of the topmost artboard, else at (0, 0).
    pub fn new_artboard(&mut self, name: &str, w: f64, h: f64, background: &str, after: u32) -> Result<u32, String> {
        self.check_idle()?;
        range(w, 1.0, 300000.0, "artboard width")?;
        range(h, 1.0, 300000.0, "artboard height")?;
        let background: ArtboardBackground = serde_json::from_str(background).map_err(|e| format!("invalid artboard background: {e}"))?;
        let from = if after != 0 { Some(after) } else { self.artboard_ids().last().copied() };
        let (x, y) = match from {
            Some(id) => {
                let r = self.node(id)?.artboard.as_ref().ok_or_else(|| format!("node {id} is not an artboard"))?.rect;
                (r[2] + 100.0, r[1])
            }
            None => (0.0, 0.0),
        };
        let id = self.add_group(name, 0)?;
        self.node_mut(id)?.artboard =
            Some(Artboard { rect: [x, y, x + w, y + h], background, preset_name: String::new(), guide_ids: Vec::new() });
        self.fit_canvas_to_artboards()?;
        Ok(id)
    }

    /// "Artboard from Group": the group moves to the top of the root list and gets the rect of
    /// its content bounds (the canvas when empty) and no background.
    pub fn artboard_from_group(&mut self, id: u32, name: &str) -> Result<(), String> {
        self.check_idle()?;
        let n = self.node(id)?;
        if !n.is_group() {
            return Err("Select a group to convert to an artboard.".into());
        }
        if n.holds_artboard() {
            return Err("Artboards cannot contain other artboards.".into());
        }
        if n.locks.position {
            return Err("Unlock the group before converting it to an artboard.".into());
        }
        let [x, y, w, h] = self.subtree_bounds(id)?.unwrap_or([0, 0, self.width as i32, self.height as i32]);
        if self.find_path(id)?.len() > 1 {
            let top = self.nodes.len() as u32;
            self.move_node(id, 0, top)?;
        }
        let rect = [x as f64, y as f64, (x + w) as f64, (y + h) as f64];
        let node = self.node_mut(id)?;
        if !name.is_empty() {
            node.name = name.to_string();
        }
        node.artboard = Some(Artboard { rect, background: ArtboardBackground::None, preset_name: String::new(), guide_ids: Vec::new() });
        self.fit_canvas_to_artboards()
    }

    /// "Artboard from Layers": groups the layers (same parent), then Artboard from Group.
    pub fn artboard_from_layers(&mut self, ids: &[u32], name: &str) -> Result<u32, String> {
        let gid = self.group_nodes(ids)?;
        self.artboard_from_group(gid, name)?;
        Ok(gid)
    }

    /// Moves an artboard's rect and its guides by (dx, dy); its layers move with the Move tool.
    pub fn offset_artboard(&mut self, id: u32, dx: f64, dy: f64) -> Result<(), String> {
        self.check_idle()?;
        finite(dx, "dx")?;
        finite(dy, "dy")?;
        let a = self.artboard_mut(id)?;
        a.rect = [a.rect[0] + dx, a.rect[1] + dy, a.rect[2] + dx, a.rect[3] + dy];
        let guides = a.guide_ids.clone();
        for g in self.vector.guides.iter_mut().filter(|g| guides.contains(&g.id)) {
            g.pos += if g.axis == Axis::X { dx } else { dy };
        }
        self.fit_canvas_to_artboards()
    }

    /// After a move: a layer whose bounds centre now lies in another artboard (topmost visible
    /// first) moves to the top of that artboard, or to the root top when it left every artboard.
    /// Returns whether it moved.
    pub fn reparent_to_artboard(&mut self, id: u32) -> Result<bool, String> {
        self.check_idle()?;
        let n = self.node(id)?;
        if n.holds_artboard() || n.locks.position || self.artboard_ids().is_empty() {
            return Ok(false);
        }
        let Some([x, y, w, h]) = self.subtree_bounds(id)? else { return Ok(false) };
        let (cx, cy) = (x as f64 + w as f64 / 2.0, y as f64 + h as f64 / 2.0);
        let target = self
            .nodes
            .iter()
            .rev()
            .find(|n| n.visible && n.artboard.as_ref().is_some_and(|a| cx >= a.rect[0] && cy >= a.rect[1] && cx < a.rect[2] && cy < a.rect[3]))
            .map_or(0, |n| n.id);
        // The artboard the layer is in now (0 = none); artboards are always top level.
        let root = &self.nodes[self.find_path(id)?[0]];
        let current = if root.artboard.is_some() { root.id } else { 0 };
        if target == current {
            return Ok(false);
        }
        // The source list is never the destination list here, so the top index is its length.
        let top = match &self.node(target).map(|n| &n.kind) {
            Ok(Kind::Group(ch)) => ch.len(),
            _ => self.nodes.len(),
        };
        self.move_node(id, target, top as u32)?;
        self.node_mut(id)?.clipping = false;
        Ok(true)
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

    /// Replaces the document's Vanishing Point planes (JSON array of `vanishing::VPlane`).
    pub fn set_vanishing_planes(&mut self, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let p: Vec<crate::vanishing::VPlane> = serde_json::from_str(json).map_err(|e| format!("invalid vanishing planes: {e}"))?;
        crate::vanishing::check_planes(&p)?;
        self.vector.vanishing_planes = p;
        Ok(())
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
