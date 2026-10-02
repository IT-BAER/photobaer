mod adjust;
mod blend;
mod content;
mod doc;
mod filters;
mod font;
mod glyph_cells;
mod heal;
mod gradient;
mod livewire;
mod liquify;
mod puppet;
mod pwarp;
mod geom;
mod path;
mod pattern;
mod region;
mod resample;
mod selection;
mod stroke;
mod styles;
mod text;
mod typeset;

// dlmalloc grows wasm memory by what one request needs, and V8 makes each memory.grow cost
// time proportional to the heap; when a request grows memory, reserve 1/8 of the heap in one grow.
#[cfg(target_arch = "wasm32")]
mod heap {
    use core::arch::wasm32::memory_size;
    use std::alloc::{GlobalAlloc, Layout, System};

    pub struct Headroom;

    unsafe fn reserve_if_grown(before: usize) {
        if memory_size(0) != before {
            unsafe {
                let r = Layout::from_size_align_unchecked(before * 65536 / 8, 16);
                let p = System.alloc(r);
                if !p.is_null() {
                    System.dealloc(p, r);
                }
            }
        }
    }

    unsafe impl GlobalAlloc for Headroom {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            let before = memory_size(0);
            unsafe {
                let p = System.alloc(l);
                reserve_if_grown(before);
                p
            }
        }
        unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
            let before = memory_size(0);
            unsafe {
                let p = System.alloc_zeroed(l);
                reserve_if_grown(before);
                p
            }
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
            let before = memory_size(0);
            unsafe {
                let q = System.realloc(p, l, size);
                reserve_if_grown(before);
                q
            }
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            unsafe { System.dealloc(p, l) }
        }
    }

    #[global_allocator]
    static A: Headroom = Headroom;
}

use blend::PaintMode;
use doc::{Document, EngineCore, Remap, Target};
use resample::Interp;
use selection::Mode;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Engine(EngineCore);

fn err(e: String) -> JsError {
    JsError::new(&e)
}

fn rect_js(r: Option<[i32; 4]>) -> JsValue {
    match r {
        Some(r) => js_sys::Int32Array::from(r.as_slice()).into(),
        None => JsValue::NULL,
    }
}

// Color Range's sample colors and localized-falloff centers cross wasm as flat arrays
// (wasm-bindgen has no `Vec<[u8; 3]>` / `Vec<(f64, f64)>` binding).
fn to_samples(flat: &[u8]) -> Result<Vec<[u8; 3]>, JsError> {
    if flat.len() % 3 != 0 {
        return Err(err("color range samples must be flat r,g,b triples".into()));
    }
    Ok(flat.chunks_exact(3).map(|c| [c[0], c[1], c[2]]).collect())
}

fn to_points(flat: &[f64]) -> Result<Vec<(f64, f64)>, JsError> {
    if flat.len() % 2 != 0 {
        return Err(err("color range center must be flat x,y pairs".into()));
    }
    Ok(flat.chunks_exact(2).map(|c| (c[0], c[1])).collect())
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, depth: u8) -> Result<Engine, JsError> {
        Ok(Engine(EngineCore::new(Document::new(width, height, depth).map_err(err)?)))
    }

    pub fn width(&self) -> u32 {
        self.0.doc.width()
    }
    pub fn height(&self) -> u32 {
        self.0.doc.height()
    }
    pub fn depth(&self) -> u8 {
        self.0.doc.depth()
    }
    pub fn tiles_x(&self) -> u32 {
        self.0.doc.tiles_x()
    }
    pub fn tiles_y(&self) -> u32 {
        self.0.doc.tiles_y()
    }
    pub fn max_level(&self) -> u32 {
        self.0.doc.max_level()
    }

    /// The layer tree for the UI (manifest fields without the tile arrays).
    pub fn layers_json(&self) -> String {
        self.0.doc.layers_json()
    }

    pub fn add_layer(&mut self, name: &str, above: u32) -> Result<u32, JsError> {
        self.0.doc.add_layer(name, above).map_err(err)
    }

    pub fn add_group(&mut self, name: &str, above: u32) -> Result<u32, JsError> {
        self.0.doc.add_group(name, above).map_err(err)
    }

    pub fn group_nodes(&mut self, ids: Vec<u32>) -> Result<u32, JsError> {
        self.0.doc.group_nodes(&ids).map_err(err)
    }

    pub fn ungroup(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.ungroup(id).map_err(err)
    }

    pub fn delete_node(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.delete_node(id).map_err(err)
    }

    pub fn duplicate_node(&mut self, id: u32) -> Result<u32, JsError> {
        self.0.doc.duplicate_node(id).map_err(err)
    }

    pub fn move_node(&mut self, id: u32, parent: u32, index: u32) -> Result<(), JsError> {
        self.0.doc.move_node(id, parent, index).map_err(err)
    }

    /// Partial JSON: name, visible, opacity, fill, blend, clipping, locks, mask_enabled.
    pub fn set_props(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_props(id, json).map_err(err)
    }

    pub fn set_style(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_style(id, json).map_err(err)
    }

    /// Sets the style scale, 0.01..10; refuses fully locked layers.
    pub fn scale_effects(&mut self, id: u32, factor: f32) -> Result<(), JsError> {
        self.0.doc.scale_effects(id, factor).map_err(err)
    }

    /// Turns every style off, or on when all are off; returns the new state.
    pub fn hide_all_effects(&mut self) -> Result<bool, JsError> {
        self.0.doc.hide_all_effects().map_err(err)
    }

    /// The layer's style JSON (never its blending options).
    pub fn copy_style(&self, id: u32) -> Result<String, JsError> {
        self.0.doc.copy_style(id).map_err(err)
    }

    /// A deep copy of the style JSON on every id; refuses fully locked and adjustment layers.
    pub fn paste_style(&mut self, ids: Vec<u32>, json: &str) -> Result<(), JsError> {
        self.0.doc.paste_style(&ids, json).map_err(err)
    }

    pub fn clear_style(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.clear_style(id).map_err(err)
    }

    /// Splits the behind planes into pixel layers below and bakes the rest; returns the new ids.
    pub fn create_layers_from_style(&mut self, id: u32) -> Result<Vec<u32>, JsError> {
        self.0.doc.create_layers_from_style(id).map_err(err)
    }

    pub fn blob_add(&mut self, bytes: &[u8]) -> Result<u64, JsError> {
        self.0.doc.blob_add(bytes).map_err(err)
    }

    pub fn add_special(&mut self, above: u32, json: &str) -> Result<u32, JsError> {
        self.0.doc.add_special(above, json).map_err(err)
    }

    /// Adds a fill layer, masks it to the selection (or reveals all) and drops the selection.
    pub fn add_fill_layer(&mut self, above: u32, json: &str) -> Result<u32, JsError> {
        self.0.doc.add_fill_layer(above, json).map_err(err)
    }

    /// Replaces a fill layer's content; refuses other kinds and unknown pattern ids.
    pub fn set_content(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_content(id, json).map_err(err)
    }

    /// Replaces an adjustment layer's params; refuses other kinds.
    pub fn set_adjustment(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_adjustment(id, json).map_err(err)
    }

    /// Destructive apply of one adjustment kind onto a pixel layer's color channels.
    pub fn apply_adjustment(&mut self, id: u32, target: &str, json: &str) -> Result<(), JsError> {
        self.0.doc.apply_adjustment(id, Target::parse(target).map_err(err)?, json).map_err(err)
    }

    /// Destructive apply of a destructive-only kind (shadows/highlights .. auto color).
    pub fn apply_destructive(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.apply_destructive(id, json).map_err(err)
    }

    /// Opens a Liquify session on layer `id` (docs/M5.md section 6): a proxy of at most
    /// `max_side` px and a mesh of `spacing` px, or re-editing Liquify smart filter `filter_id`.
    pub fn liquify_begin(&mut self, id: u32, max_side: u32, spacing: u32, filter_id: Option<u32>) -> Result<liquify::Liquify, JsError> {
        self.0.doc.liquify_begin(id, max_side, spacing, filter_id).map_err(err)
    }

    /// A Puppet Warp mesh JSON over layer `id`'s opaque pixels (density fewerPoints, normal or
    /// morePoints; expansion -50..50 px).
    pub fn puppet_mesh(&self, id: u32, density: &str, expansion: f64) -> Result<String, JsError> {
        self.0.doc.puppet_mesh(id, density, expansion).map_err(err)
    }

    /// Liquify Mask Options from "selection" or "transparency" (layer `id`) by `op`.
    pub fn liquify_mask(&self, session: &mut liquify::Liquify, id: u32, source: &str, op: &str) -> Result<(), JsError> {
        self.0.doc.liquify_mask(session, id, source, op).map_err(err)
    }

    /// Destructive filter `{ kind, params }` (docs/M5.md section 1) on `target` of layer `id`;
    /// `view` `[x, y, w, h]` (empty for none) limits a live preview, `scale` below 1 runs a proxy.
    pub fn apply_filter(&mut self, id: u32, target: &str, json: &str, view: Vec<i32>, scale: f32) -> Result<(), JsError> {
        let view = match view.as_slice() {
            [] => None,
            &[x, y, w, h] => Some([x, y, w, h]),
            _ => return Err(JsError::new("view must be empty or [x, y, w, h]")),
        };
        self.0.doc.apply_filter(id, Target::parse(target).map_err(err)?, json, view, scale).map_err(err)
    }

    /// Edit > Fade: JSON `{ opacity, mode }` toward layer `id` in snapshot `snap`.
    pub fn fade(&mut self, id: u32, snap: u32, json: &str) -> Result<(), JsError> {
        self.0.fade(id, snap, json).map_err(err)
    }

    /// Renders a fill layer into pixel tiles over the document bounds, keeping its id.
    pub fn rasterize_fill(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.rasterize_fill(id).map_err(err)
    }

    // ---------- smart objects (docs/M3.md section 6) ----------

    /// Places a smart object above `above` (0 = on top). JSON `{ name, link, source_blob,
    /// source_size, transform }`; `rgba` is the straight RGBA8 source (source_size w x h x 4).
    pub fn place_smart(&mut self, above: u32, json: &str, rgba: &[u8]) -> Result<u32, JsError> {
        self.0.doc.place_smart(above, json, rgba).map_err(err)
    }

    /// Stores a smart object's source pixels without re-rendering its cache (PSD import).
    pub fn load_smart_source(&mut self, id: u32, rgba: &[u8]) -> Result<(), JsError> {
        self.0.doc.load_smart_source(id, rgba).map_err(err)
    }

    pub fn render_smart(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.render_smart(id).map_err(err)
    }

    /// Re-renders smart objects whose filters read a layer mask that changed; history runs it
    /// after each committed step.
    pub fn settle_smart(&mut self) -> Result<(), JsError> {
        self.0.doc.settle_smart().map_err(err)
    }

    /// Sets the transform (3x3, source px -> document px) and warp (`warp_layer` mesh JSON over
    /// the source, empty for none) and re-renders.
    pub fn set_smart_placement(&mut self, id: u32, m: Vec<f64>, warp: &str) -> Result<(), JsError> {
        let m = resample::matrix(&m).map_err(err)?;
        self.0.doc.set_smart_placement_json(id, &m, warp).map_err(err)
    }

    /// A copy above; an embedded copy gets `link_id` and no longer shares its source.
    pub fn smart_via_copy(&mut self, id: u32, link_id: &str) -> Result<u32, JsError> {
        self.0.doc.smart_via_copy(id, link_id).map_err(err)
    }

    pub fn rasterize_smart(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.rasterize_smart(id).map_err(err)
    }

    /// JSON `{ link?, source_blob, source_size }`; keeps the on-canvas corners.
    pub fn replace_smart_contents(&mut self, id: u32, json: &str, rgba: &[u8]) -> Result<(), JsError> {
        self.0.doc.replace_smart_contents(id, json, rgba).map_err(err)
    }

    /// JSON `{ source_blob, source_size }` for every smart object sharing `id`'s link; returns their ids.
    pub fn update_smart_source(&mut self, id: u32, json: &str, rgba: &[u8]) -> Result<Vec<u32>, JsError> {
        self.0.doc.update_smart_source(id, json, rgba).map_err(err)
    }

    /// JSON `{ link, source_blob }`.
    pub fn set_smart_link(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_smart_link(id, json).map_err(err)
    }

    /// A stack mode name as a JSON string, or `null`.
    pub fn set_stack_mode(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_stack_mode(id, json).map_err(err)
    }

    /// Merges sibling `ids` into one pixel layer of their composite (see `Document::merge_nodes`).
    pub fn merge_nodes(&mut self, ids: Vec<u32>, keep: bool, clip: bool) -> Result<u32, JsError> {
        self.0.doc.merge_nodes(&ids, keep, clip).map_err(err)
    }

    /// The sibling layers `ids` as a new document at their union bounds (the Convert to Smart
    /// Object source).
    pub fn extract_document(&self, ids: Vec<u32>) -> Result<Engine, JsError> {
        Ok(Engine(EngineCore::new(self.0.doc.extract_document(&ids).map_err(err)?.0)))
    }

    /// JSON `{ name, link_id, source_blob }`; returns the new smart object's id.
    pub fn convert_to_smart(&mut self, ids: Vec<u32>, json: &str) -> Result<u32, JsError> {
        self.0.doc.convert_to_smart(&ids, json).map_err(err)
    }

    // ---------- smart filters (docs/M3.md section 7) ----------

    /// Appends filter JSON `{ kind, params }`; returns the filter id.
    pub fn add_smart_filter(&mut self, id: u32, json: &str) -> Result<u32, JsError> {
        self.0.doc.add_smart_filter(id, json).map_err(err)
    }

    /// JSON `{ filter?, enabled?, opacity?, blend? }`.
    pub fn set_smart_filter(&mut self, id: u32, filter_id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_smart_filter(id, filter_id, json).map_err(err)
    }

    pub fn remove_smart_filter(&mut self, id: u32, filter_id: u32) -> Result<(), JsError> {
        self.0.doc.remove_smart_filter(id, filter_id).map_err(err)
    }

    pub fn clear_smart_filters(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.clear_smart_filters(id).map_err(err)
    }

    pub fn toggle_smart_filters(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.toggle_smart_filters(id).map_err(err)
    }

    /// Filter `filter_id`'s mask, or the stack mask for 0.
    pub fn add_filter_mask(&mut self, id: u32, filter_id: u32, reveal: bool) -> Result<(), JsError> {
        self.0.doc.add_filter_mask(id, filter_id, reveal).map_err(err)
    }

    /// PSD import: one 8-bit mask tile of filter `filter_id` (0 = the stack mask), no re-render.
    pub fn set_filter_mask_tile8(&mut self, id: u32, filter_id: u32, tx: u32, ty: u32, data: &[u8]) -> Result<(), JsError> {
        self.0.doc.set_filter_mask_tile8(id, filter_id, tx, ty, data).map_err(err)
    }

    pub fn delete_filter_masks(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.delete_filter_masks(id).map_err(err)
    }

    pub fn toggle_filter_masks(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.toggle_filter_masks(id).map_err(err)
    }

    /// The pixel layer `id` alone with neutral layer properties, at its bounds (the Convert for
    /// Smart Filters source).
    pub fn extract_layer(&self, id: u32) -> Result<Engine, JsError> {
        Ok(Engine(EngineCore::new(self.0.doc.extract_layer(id).map_err(err)?)))
    }

    /// JSON `{ link_id, source_blob }`; keeps the layer id.
    pub fn convert_for_smart_filters(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.convert_for_smart_filters(id, json).map_err(err)
    }

    pub fn set_blending(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_blending(id, json).map_err(err)
    }

    pub fn set_document_m3(&mut self, json: &str) -> Result<(), JsError> {
        self.0.doc.set_document_m3(json).map_err(err)
    }

    /// Captures a new layer comp under `name`, returning its id.
    pub fn capture_layer_comp(&mut self, name: &str) -> Result<u32, JsError> {
        self.0.doc.capture_layer_comp(name).map_err(err)
    }

    /// Restores a comp's flagged visibility, position and appearance; an unknown id errs.
    pub fn apply_layer_comp(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.apply_layer_comp(id).map_err(err)
    }

    pub fn delete_layer_comp(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.delete_layer_comp(id).map_err(err)
    }

    /// Partial JSON: name, comment, apply_visibility, apply_position, apply_appearance.
    pub fn update_layer_comp(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.update_layer_comp(id, json).map_err(err)
    }

    pub fn add_mask(&mut self, id: u32, reveal: bool) -> Result<(), JsError> {
        self.0.doc.add_mask(id, reveal).map_err(err)
    }

    pub fn delete_mask(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.delete_mask(id).map_err(err)
    }

    /// `target` is "pixels" or "mask"; a mask fill uses the red channel as its value.
    pub fn fill(&mut self, id: u32, target: &str, r: u8, g: u8, b: u8, a: u8) -> Result<(), JsError> {
        self.0.doc.fill(id, Target::parse(target).map_err(err)?, r, g, b, a).map_err(err)
    }

    pub fn invert(&mut self, id: u32, target: &str) -> Result<(), JsError> {
        self.0.doc.invert(id, Target::parse(target).map_err(err)?).map_err(err)
    }

    /// Pixels become transparent, a mask becomes 0; the selection limits the effect.
    pub fn clear(&mut self, id: u32, target: &str) -> Result<(), JsError> {
        self.0.doc.clear(id, Target::parse(target).map_err(err)?).map_err(err)
    }

    /// `clear` for a whole-layer transform session: allowed on a smart object's cache.
    pub fn clear_lifted(&mut self, id: u32, target: &str) -> Result<(), JsError> {
        self.0.doc.clear_lifted(id, Target::parse(target).map_err(err)?).map_err(err)
    }

    /// Moves a pixel layer and its mask by whole pixels, keeping pixels outside the canvas.
    pub fn offset_layer(&mut self, id: u32, dx: i32, dy: i32) -> Result<(), JsError> {
        self.0.doc.offset_layer(id, dx, dy).map_err(err)
    }

    /// Tight bounds of the layer's non-transparent pixels as [x, y, w, h], or null.
    pub fn layer_bounds(&self, id: u32) -> Result<JsValue, JsError> {
        Ok(rect_js(self.0.doc.layer_bounds(id).map_err(err)?))
    }

    // ---------- selection ----------

    /// `mode` is "new", "add", "subtract" or "intersect".
    pub fn select_rect(&mut self, x: f64, y: f64, w: f64, h: f64, mode: &str) -> Result<(), JsError> {
        self.0.doc.select_rect(x, y, w, h, Mode::parse(mode).map_err(err)?).map_err(err)
    }

    pub fn select_ellipse(&mut self, x: f64, y: f64, w: f64, h: f64, antialias: bool, mode: &str) -> Result<(), JsError> {
        self.0.doc.select_ellipse(x, y, w, h, antialias, Mode::parse(mode).map_err(err)?).map_err(err)
    }

    /// `points` are flat document pixels x0, y0, x1, y1, ...; the polygon fills even-odd.
    pub fn select_polygon(&mut self, points: Vec<f64>, antialias: bool, mode: &str) -> Result<(), JsError> {
        self.0.doc.select_polygon(&points, antialias, Mode::parse(mode).map_err(err)?).map_err(err)
    }

    pub fn select_all(&mut self) -> Result<(), JsError> {
        self.0.doc.select_all().map_err(err)
    }

    pub fn deselect(&mut self) -> Result<(), JsError> {
        self.0.doc.deselect().map_err(err)
    }

    pub fn reselect(&mut self) -> Result<(), JsError> {
        self.0.doc.reselect().map_err(err)
    }

    pub fn invert_selection(&mut self) -> Result<(), JsError> {
        self.0.doc.invert_selection().map_err(err)
    }

    /// Gaussian blur of the selection mask with sigma = radius / 3.
    pub fn feather_selection(&mut self, radius: f64) -> Result<(), JsError> {
        self.0.doc.feather_selection(radius).map_err(err)
    }

    /// Magic wand (docs/M2.md section 3): flood fill from (x, y), `mode` is a selection mode.
    #[allow(clippy::too_many_arguments)]
    pub fn magic_wand(
        &mut self,
        x: i32,
        y: i32,
        tolerance: u8,
        antialias: bool,
        contiguous: bool,
        sample_all: bool,
        layer_id: u32,
        mode: &str,
    ) -> Result<(), JsError> {
        self.0
            .doc
            .magic_wand(x, y, tolerance, antialias, contiguous, sample_all, layer_id, Mode::parse(mode).map_err(err)?)
            .map_err(err)
    }

    /// Adds a contiguous flood from the selection's seed colors' range to the selection.
    pub fn grow(&mut self, tolerance: u8, sample_all: bool, layer_id: u32) -> Result<(), JsError> {
        self.0.doc.grow(tolerance, sample_all, layer_id).map_err(err)
    }

    /// Adds every pixel within the selection's seed colors' range, regardless of connectivity.
    pub fn similar(&mut self, tolerance: u8, sample_all: bool, layer_id: u32) -> Result<(), JsError> {
        self.0.doc.similar(tolerance, sample_all, layer_id).map_err(err)
    }

    /// Quick selection (docs/M2.md section 3): `points` are the stroke's flat document x, y
    /// samples, `radius` the brush radius; `mode` is a selection mode.
    #[allow(clippy::too_many_arguments)]
    pub fn quick_select(
        &mut self,
        points: Vec<f64>,
        radius: f64,
        sample_all: bool,
        layer_id: u32,
        mode: &str,
        auto_enhance: bool,
    ) -> Result<(), JsError> {
        self.0
            .doc
            .quick_select(&points, radius, sample_all, layer_id, Mode::parse(mode).map_err(err)?, auto_enhance)
            .map_err(err)
    }

    /// Magnetic lasso (docs/M2.md section 3): builds the gradient field once and returns the
    /// handle for `magnetic_path`; free it with `magnetic_end`.
    pub fn magnetic_begin(&mut self, sample_all: bool, layer_id: u32) -> Result<u32, JsError> {
        self.0.magnetic_begin(sample_all, layer_id).map_err(err)
    }

    /// The live wire from (x0, y0) to (x1, y1) as flat x, y document pixels; `width` is the
    /// search corridor's half-width, `contrast` (0..100 %) ignores weaker edges.
    #[allow(clippy::too_many_arguments)]
    pub fn magnetic_path(
        &self,
        handle: u32,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
        width: u32,
        contrast: u8,
    ) -> Result<Vec<i32>, JsError> {
        self.0.magnetic_path(handle, x0, y0, x1, y1, width, contrast).map_err(err)
    }

    pub fn magnetic_end(&mut self, handle: u32) -> Result<(), JsError> {
        self.0.magnetic_end(handle).map_err(err)
    }

    /// Index into a `magnetic_path` result (as point count, not array index) where the next
    /// automatic anchor belongs, or -1 while the path is still shorter than the spacing.
    pub fn magnetic_suggest_anchor(&self, path: Vec<i32>, frequency: u8) -> i32 {
        let pts: Vec<(i32, i32)> = path.chunks_exact(2).map(|p| (p[0], p[1])).collect();
        livewire::suggest_anchor(&pts, frequency).map_or(-1, |i| i as i32)
    }

    /// Opens a stroke (docs/M2.md section 4) on `layer_id`. `target` is "pixels" or "selection"
    /// (quick mask). `params_json` is `{ rgba, mode, size, opacity, flow, hardness, spacing,
    /// angle, roundness, tip, aliased, wetEdges, airbrush, pressureSize, pressureOpacity,
    /// eraseToHistory }`; only rgba, mode and size are required.
    pub fn stroke_begin(&mut self, layer_id: u32, target: &str, params_json: &str) -> Result<(), JsError> {
        self.0.stroke_begin(layer_id, target, params_json).map_err(err)
    }

    /// One batch of input samples as flat x, y, pressure triples. Returns the changed document
    /// rect as [x, y, w, h], empty when the stroke placed no dab.
    pub fn stroke_to(&mut self, samples: Vec<f64>) -> Result<Vec<i32>, JsError> {
        self.0.stroke_to(&samples).map_err(err)
    }

    pub fn stroke_end(&mut self) -> Result<(), JsError> {
        self.0.stroke_end().map_err(err)
    }

    /// Ends the stroke and puts the stroke-start tiles back.
    pub fn stroke_cancel(&mut self) -> Result<(), JsError> {
        self.0.stroke_cancel().map_err(err)
    }

    /// Registers a sampled brush tip (E1.11): 8-bit coverage, row-major, `1..=2500` per side.
    pub fn tip_add(&mut self, w: u32, h: u32, alpha: Vec<u8>) -> Result<u32, JsError> {
        self.0.tip_add(w, h, alpha).map_err(err)
    }

    pub fn tip_remove(&mut self, id: u32) {
        self.0.tip_remove(id)
    }

    /// Registers a fill/texture pattern (E2.1): `1..=4096` px per side, `channels` 1 (gray) or 4
    /// (RGBA, alpha ignored).
    pub fn pattern_add(&mut self, w: u32, h: u32, data: Vec<u8>, channels: u8) -> Result<u32, JsError> {
        self.0.pattern_add(w, h, &data, channels).map_err(err)
    }

    pub fn pattern_remove(&mut self, id: u32) {
        self.0.pattern_remove(id)
    }

    /// Renders a brush preview (E1.12) as RGBA8, `w * h * 4` bytes, capped at 1024 x 256.
    pub fn brush_preview(&self, params_json: &str, w: u32, h: u32) -> Result<Vec<u8>, JsError> {
        self.0.brush_preview(params_json, w, h).map_err(err)
    }

    /// Paints a solid color into the layer through `coverage` (0..1, `w * h` long) at document
    /// rect (x, y, w, h); `mode` is a blend mode name, "behind" or "clear". `target` is "pixels"
    /// or "selection" (quick mask: paints the selection itself, `r` is the mask value).
    #[allow(clippy::too_many_arguments)]
    pub fn paint_coverage(
        &mut self,
        id: u32,
        target: &str,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        coverage: Vec<f32>,
        r: u8,
        g: u8,
        b: u8,
        a: u8,
        mode: &str,
        opacity: f32,
    ) -> Result<(), JsError> {
        self.0
            .doc
            .paint_coverage(
                id,
                Target::parse(target).map_err(err)?,
                x,
                y,
                w,
                h,
                &coverage,
                [r, g, b, a],
                PaintMode::parse(mode).map_err(err)?,
                opacity,
            )
            .map_err(err)
    }

    /// Paint bucket (docs/M2.md section 4): flood fill from (x, y) then `paint_coverage`.
    /// `target` is "pixels" or "selection" (quick mask).
    #[allow(clippy::too_many_arguments)]
    pub fn bucket(
        &mut self,
        id: u32,
        target: &str,
        x: i32,
        y: i32,
        r: u8,
        g: u8,
        b: u8,
        a: u8,
        mode: &str,
        opacity: f32,
        tolerance: u8,
        antialias: bool,
        contiguous: bool,
        all_layers: bool,
    ) -> Result<(), JsError> {
        self.0
            .doc
            .bucket(
                id,
                Target::parse(target).map_err(err)?,
                x,
                y,
                [r, g, b, a],
                PaintMode::parse(mode).map_err(err)?,
                opacity,
                tolerance,
                antialias,
                contiguous,
                all_layers,
            )
            .map_err(err)
    }

    /// Fill (B6 spec v1 Part E1): `target` is "pixels". `params_json` is `{source: "solid" |
    /// "pattern" | "history", rgba?, patternId?, snapshotId?, mode, opacity, preserveTransparency}`.
    pub fn fill_ex(&mut self, id: u32, target: &str, params_json: &str) -> Result<(), JsError> {
        self.0.fill_ex(id, target, params_json).map_err(err)
    }

    /// Edit > Content-Aware Fill (docs/M5.md section 10): `params_json` is `{structure 1..7, color
    /// 0..10, mode?, opacity?, preserveTransparency?, deselect?}`; true when a pixel changed.
    pub fn content_aware_fill(&mut self, id: u32, params_json: &str) -> Result<bool, JsError> {
        self.0.content_aware_fill(id, params_json).map_err(err)
    }

    /// Red Eye: darkens the reddish pixels inside the circle of the `w` x `h` box at (`x`, `y`);
    /// `pupil` and `darken` are 0..1. True when a pixel changed.
    #[allow(clippy::too_many_arguments)]
    pub fn red_eye(&mut self, id: u32, x: i32, y: i32, w: u32, h: u32, pupil: f32, darken: f32) -> Result<bool, JsError> {
        self.0.doc.red_eye(id, x, y, w, h, pupil, darken).map_err(err)
    }

    /// Patch: repairs the selection by the drag (`dx`, `dy`); `params_json` is `{mode: "source" |
    /// "destination", contentAware, structure, color}`. Needs a selection; true when a pixel changed.
    pub fn patch(&mut self, id: u32, dx: i32, dy: i32, params_json: &str) -> Result<bool, JsError> {
        self.0.doc.patch(id, dx, dy, params_json).map_err(err)
    }

    /// Content-Aware Move: moves the selection by the drag; `params_json` is `{extend, structure,
    /// color}`. Needs a selection; true when a pixel changed.
    pub fn content_aware_move(&mut self, id: u32, dx: i32, dy: i32, params_json: &str) -> Result<bool, JsError> {
        self.0.doc.content_aware_move(id, dx, dy, params_json).map_err(err)
    }

    /// The clone overlay for destination layer `layer_id`: straight RGBA8 `out_w` x `out_h` (1..=512)
    /// of the clone source (`{kind: "clone", ...}`, the stroke's) over the document rect (x, y, w, h).
    #[allow(clippy::too_many_arguments)]
    pub fn clone_sample(&self, layer_id: u32, params_json: &str, x: f64, y: f64, w: f64, h: f64, out_w: u32, out_h: u32) -> Result<Vec<u8>, JsError> {
        self.0.doc.clone_sample(layer_id, params_json, x, y, w, h, out_w, out_h).map_err(err)
    }

    /// Stroke ring (B6 spec v1 Part E2): `params_json` is `{width, rgba, location: "inside" |
    /// "center" | "outside", mode, opacity, preserveTransparency}`. Needs a selection.
    pub fn stroke_selection(&mut self, id: u32, params_json: &str) -> Result<(), JsError> {
        self.0.stroke_selection(id, params_json).map_err(err)
    }

    /// Gradient render (B6 spec v1 Part E3): `target` is "pixels", "mask" or "selection".
    /// `params_json` is `{stops[{position, rgb, midpoint}], opacityStops[{position, opacity,
    /// midpoint}], method: "perceptual" | "linear" | "classic", style: "linear" | "radial" |
    /// "angle" | "reflected" | "diamond", start: {x, y}, end: {x, y}, reverse, dither,
    /// transparency, opacity}`.
    pub fn gradient(&mut self, id: u32, target: &str, params_json: &str) -> Result<(), JsError> {
        self.0.gradient(id, target, params_json).map_err(err)
    }

    pub fn has_selection(&self) -> bool {
        self.0.doc.has_selection()
    }

    /// Tight bounds of the selected pixels as [x, y, w, h], or null.
    pub fn selection_bounds(&self) -> JsValue {
        rect_js(self.0.doc.selection_bounds())
    }

    /// The selection coverage of one display tile as 8-bit bytes, or null when it is fully
    /// the mask default.
    pub fn selection_tile(&self, level: u32, tx: u32, ty: u32) -> Result<JsValue, JsError> {
        match self.0.doc.selection_tile(level, tx, ty).map_err(err)? {
            Some(bytes) => Ok(js_sys::Uint8Array::from(bytes.as_slice()).into()),
            None => Ok(JsValue::NULL),
        }
    }

    pub fn save_selection(&mut self, name: &str) -> Result<u32, JsError> {
        self.0.doc.save_selection(name).map_err(err)
    }

    pub fn load_selection(&mut self, channel: u32, invert: bool, mode: &str) -> Result<(), JsError> {
        self.0.doc.load_selection(channel, invert, Mode::parse(mode).map_err(err)?).map_err(err)
    }

    pub fn delete_channel(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.delete_channel(id).map_err(err)
    }

    pub fn combine_into_channel(&mut self, channel: u32, mode: &str) -> Result<(), JsError> {
        self.0.doc.combine_into_channel(channel, Mode::parse(mode).map_err(err)?).map_err(err)
    }

    /// Select > Modify (docs/M2.md section 3): `op` is "border", "smooth", "expand" or "contract".
    pub fn modify_selection(&mut self, op: &str, r: f64, canvas_bounds: bool) -> Result<(), JsError> {
        self.0.doc.modify_selection(op, r, canvas_bounds).map_err(err)
    }

    /// Color Range (docs/M2.md section 3): `preset` is "sampled", a hue name (reds/yellows/
    /// greens/cyans/blues/magentas), a luminance band (highlights/midtones/shadows) or
    /// "skin tones". `samples` is flat r,g,b triples, `center` flat x,y pairs (localized falloff
    /// origins); `mode` is a selection mode.
    #[allow(clippy::too_many_arguments)]
    pub fn color_range(
        &mut self,
        sample_all: bool,
        layer_id: u32,
        preset: &str,
        samples: Vec<u8>,
        fuzziness: u8,
        range: u8,
        center: Vec<f64>,
        localized: bool,
        invert: bool,
        mode: &str,
    ) -> Result<(), JsError> {
        let samples = to_samples(&samples)?;
        let center = to_points(&center)?;
        self.0
            .doc
            .color_range(sample_all, layer_id, preset, &samples, fuzziness, range, &center, localized, invert, Mode::parse(mode).map_err(err)?)
            .map_err(err)
    }

    /// Grayscale preview of `color_range` for the dialog; does not touch the selection.
    #[allow(clippy::too_many_arguments)]
    pub fn color_range_preview(
        &self,
        level: u32,
        sample_all: bool,
        layer_id: u32,
        preset: &str,
        samples: Vec<u8>,
        fuzziness: u8,
        range: u8,
        center: Vec<f64>,
        localized: bool,
        invert: bool,
    ) -> Result<Vec<u8>, JsError> {
        let samples = to_samples(&samples)?;
        let center = to_points(&center)?;
        self.0
            .doc
            .color_range_preview(level, sample_all, layer_id, preset, &samples, fuzziness, range, &center, localized, invert)
            .map_err(err)
    }

    /// `{ selection: null | { default, bounds }, has_last_selection, channels: [{ id, name }] }`.
    pub fn channels_json(&self) -> String {
        self.0.doc.channels_json()
    }

    pub fn set_tile_rgba8(&mut self, id: u32, tx: u32, ty: u32, data: &[u8]) -> Result<(), JsError> {
        self.0.doc.set_tile_rgba8(id, tx, ty, data).map_err(err)
    }

    /// Straight RGBA8 (w x h) written into a pixel layer at (x, y), past the canvas too.
    pub fn put_rgba8(&mut self, id: u32, x: i32, y: i32, w: u32, h: u32, data: &[u8]) -> Result<(), JsError> {
        self.0.doc.put_rgba8(id, x, y, w, h, data).map_err(err)
    }

    pub fn set_mask_tile8(&mut self, id: u32, tx: u32, ty: u32, data: &[u8]) -> Result<(), JsError> {
        self.0.doc.set_mask_tile8(id, tx, ty, data).map_err(err)
    }

    pub fn snapshot(&mut self) -> u32 {
        self.0.snapshot()
    }

    pub fn restore(&mut self, id: u32) -> Result<(), JsError> {
        self.0.restore(id).map_err(err)
    }

    pub fn drop_snapshot(&mut self, id: u32) {
        self.0.drop_snapshot(id)
    }

    /// Returns null when the tile is fully transparent or out of the document's tile range.
    pub fn display_tile(&self, level: u32, tx: u32, ty: u32) -> Result<JsValue, JsError> {
        match self.0.doc.display_tile(level, tx, ty).map_err(err)? {
            Some(bytes) => Ok(js_sys::Uint8Array::from(bytes.as_slice()).into()),
            None => Ok(JsValue::NULL),
        }
    }

    /// The encoded draw program for one display tile (8-bit only); `known` lists payload keys
    /// the caller already holds, whose bytes are then left out.
    pub fn display_program(&self, level: u32, tx: u32, ty: u32, known: Vec<u64>) -> Result<Vec<u8>, JsError> {
        self.0.doc.display_program(level, tx, ty, &known).map_err(err)
    }

    pub fn flatten_tile_rgba8(&self, tx: u32, ty: u32) -> Result<Vec<u8>, JsError> {
        self.0.doc.flatten_tile_rgba8(tx, ty).map_err(err)
    }

    /// Luminosity, R, G, B counts (4 x 256) of a layer's pixels, or of the composite for id 0.
    pub fn histogram(&self, id: u32) -> Result<Vec<u32>, JsError> {
        self.0.doc.histogram(id).map_err(err)
    }

    pub fn manifest(&self) -> String {
        self.0.doc.manifest()
    }

    pub fn tile_bytes(&self, id: u64) -> Result<Vec<u8>, JsError> {
        self.0.tile_bytes(id).map_err(err)
    }

    pub fn from_manifest(json: &str) -> Result<Engine, JsError> {
        Ok(Engine(EngineCore::new(Document::from_manifest(json).map_err(err)?)))
    }

    pub fn put_tile(&mut self, id: u64, bytes: &[u8]) -> Result<(), JsError> {
        self.0.doc.put_tile(id, bytes).map_err(err)
    }

    pub fn finish_load(&mut self) -> Result<(), JsError> {
        self.0.doc.finish_load().map_err(err)
    }

    /// Resamples a layer's pixels and mask by a forward 3x3 matrix (row-major, source -> dest
    /// document px): `interp` is nearest|bilinear|bicubic|bicubicSharper|bicubicSmoother|lanczos3;
    /// `mask` false leaves the layer mask as it is.
    pub fn transform_layer(&mut self, id: u32, m: Vec<f64>, interp: &str, mask: bool) -> Result<(), JsError> {
        let m = resample::matrix(&m).map_err(err)?;
        self.0.doc.transform_layer_with(id, &m, Interp::parse(interp).map_err(err)?, mask).map_err(err)
    }

    pub fn transform_selection(&mut self, m: Vec<f64>, interp: &str) -> Result<(), JsError> {
        let m = resample::matrix(&m).map_err(err)?;
        self.0.doc.transform_selection(&m, Interp::parse(interp).map_err(err)?).map_err(err)
    }

    /// `bg` is empty for a normal layer, or r,g,b that fills the hole of a background layer; `copy` leaves no hole.
    pub fn transform_selected_pixels(&mut self, id: u32, m: Vec<f64>, interp: &str, bg: Vec<u8>, copy: bool) -> Result<(), JsError> {
        let m = resample::matrix(&m).map_err(err)?;
        let bg = match bg.as_slice() {
            [] => None,
            [r, g, b] => Some([*r, *g, *b]),
            _ => return Err(err("background colour must be empty or r,g,b".into())),
        };
        self.0.doc.transform_selected_pixels(id, &m, Interp::parse(interp).map_err(err)?, bg, copy).map_err(err)
    }

    /// Moves the selected pixels by whole pixels; a drag that restores one base per step lifts it once.
    pub fn move_selected_pixels(&mut self, id: u32, dx: i32, dy: i32, copy: bool) -> Result<(), JsError> {
        self.0.move_selected_pixels(id, dx, dy, copy).map_err(err)
    }

    /// `kind` is cw|ccw|180|flipH|flipV.
    pub fn rotate_layer_exact(&mut self, id: u32, kind: &str) -> Result<(), JsError> {
        self.0.doc.rotate_layer_exact(id, Remap::parse(kind).map_err(err)?).map_err(err)
    }

    /// Bilinear preview into a proxy scaled by `f`: straight RGBA8 of the proxy-pixel rect.
    #[allow(clippy::too_many_arguments)]
    pub fn transform_preview(
        &self,
        id: u32,
        m: Vec<f64>,
        f: f64,
        selected: bool,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
    ) -> Result<Vec<u8>, JsError> {
        let m = resample::matrix(&m).map_err(err)?;
        self.0.doc.transform_preview(id, &m, f, selected, [x, y, w as i32, h as i32]).map_err(err)
    }

    /// Warps a layer's pixels and mask by a Bezier mesh: JSON `{cols, rows, points: [[x, y], ...]
    /// ((3 cols + 1) x (3 rows + 1), row-major, document px), columnStops, rowStops}`.
    pub fn warp_layer(&mut self, id: u32, mesh: &str, interp: &str) -> Result<(), JsError> {
        self.0.doc.warp_layer(id, mesh, Interp::parse(interp).map_err(err)?).map_err(err)
    }

    // ---------- canvas ----------

    /// Crops to the rounded-out rect: every plane is clipped to it when `delete_cropped`, then
    /// moved by (-x, -y); the canvas becomes w x h. False when the rect is empty.
    pub fn apply_crop(&mut self, x: f64, y: f64, w: f64, h: f64, delete_cropped: bool) -> Result<bool, JsError> {
        self.0.doc.apply_crop([x, y, w, h], delete_cropped).map_err(err)
    }

    /// Crop tool commit: a non-zero `angle` (degrees) first rotates the canvas by -angle. False
    /// when nothing changes (angle 0 and the rect is the canvas, or an empty rect).
    #[allow(clippy::too_many_arguments)]
    pub fn crop_rotated(&mut self, x: f64, y: f64, w: f64, h: f64, angle: f64, delete_cropped: bool) -> Result<bool, JsError> {
        self.0.doc.crop_rotated([x, y, w, h], angle, delete_cropped).map_err(err)
    }

    /// `based_on` is transparent|topLeftPixel|bottomRightPixel; returns [x, y, w, h].
    pub fn trim_rect(&self, based_on: &str, top: bool, bottom: bool, left: bool, right: bool) -> Result<Vec<i32>, JsError> {
        Ok(self.0.doc.trim_rect(based_on, top, bottom, left, right).map_err(err)?.to_vec())
    }

    /// Crops to `trim_rect` keeping hidden pixels. False when that rect is the canvas.
    pub fn trim(&mut self, based_on: &str, top: bool, bottom: bool, left: bool, right: bool) -> Result<bool, JsError> {
        self.0.doc.trim(based_on, top, bottom, left, right).map_err(err)
    }

    /// False when every layer and mask already fits the canvas.
    pub fn reveal_all(&mut self) -> Result<bool, JsError> {
        self.0.doc.reveal_all().map_err(err)
    }

    /// `kind` is cw|ccw|180|flipH|flipV.
    pub fn rotate_canvas_exact(&mut self, kind: &str) -> Result<(), JsError> {
        self.0.doc.rotate_canvas_exact(Remap::parse(kind).map_err(err)?).map_err(err)
    }

    /// Arbitrary canvas rotation, `deg` clockwise; false for a multiple of 360.
    pub fn rotate_canvas(&mut self, deg: f64, interp: &str) -> Result<bool, JsError> {
        self.0.doc.rotate_canvas(deg, Interp::parse(interp).map_err(err)?).map_err(err)
    }

    /// `quad` is flat x0, y0 .. x3, y3 for the corners that map to (0,0), (W,0), (W,H), (0,H).
    pub fn perspective_crop(&mut self, quad: Vec<f64>, out_w: u32, out_h: u32, interp: &str) -> Result<(), JsError> {
        self.0.doc.perspective_crop(&quad, out_w, out_h, Interp::parse(interp).map_err(err)?).map_err(err)
    }

    /// Image > Canvas Size; anchors are -1|0|1, `fill` straight RGBA 0..1 for the added area of a
    /// bottom pixel layer (else transparent). False when w x h is the current size.
    pub fn canvas_size(&mut self, w: u32, h: u32, anchor_x: i32, anchor_y: i32, fill: Option<Vec<f32>>) -> Result<bool, JsError> {
        let a = |v: i32| i8::try_from(v).ok().filter(|v| (-1..=1).contains(v)).ok_or_else(|| JsError::new("anchor must be -1, 0 or 1"));
        let fill = fill.map(|f| <[f32; 4]>::try_from(f).map_err(|_| JsError::new("fill must be 4 values"))).transpose()?;
        self.0.doc.canvas_size(w, h, (a(anchor_x)?, a(anchor_y)?), fill).map_err(err)
    }

    /// Image > Image Size (resample); type layers need `render_text` afterwards for crisp text.
    pub fn image_size(&mut self, w: u32, h: u32, interp: &str, scale_styles: bool) -> Result<bool, JsError> {
        self.0.doc.image_size(w, h, Interp::parse(interp).map_err(err)?, scale_styles).map_err(err)
    }

    // ---------- guides and grid (docs/M4.md section 12) ----------

    /// The document's `resolution`, `paths`, `guides`, `grid` and locks, as JSON.
    pub fn vector_json(&self) -> String {
        self.0.doc.vector_json()
    }

    /// `{ grid?: { spacing_x, spacing_y }, guidesLocked?, artboardsLocked? }`.
    pub fn set_grid_and_locks(&mut self, json: &str) -> Result<(), JsError> {
        self.0.doc.set_grid_and_locks(json).map_err(err)
    }

    /// `axis` is "x" or "y"; `artboard` 0 = a canvas guide, else the targeted artboard's id
    /// (`pos` is already document px, offset by the caller). Returns the new guide's id.
    pub fn add_guide(&mut self, axis: &str, pos: f64, artboard: u32) -> Result<u32, JsError> {
        self.0.doc.add_guide(axis, pos, artboard).map_err(err)
    }

    /// Refused while guides are locked.
    pub fn move_guide(&mut self, id: u32, pos: f64) -> Result<(), JsError> {
        self.0.doc.move_guide(id, pos).map_err(err)
    }

    pub fn delete_guide(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.delete_guide(id).map_err(err)
    }

    /// `scope` is "all", "canvas" or "artboard" (needs a non-zero `artboard`).
    pub fn clear_guides(&mut self, scope: &str, artboard: u32) -> Result<(), JsError> {
        self.0.doc.clear_guides(scope, artboard).map_err(err)
    }

    /// `{ rect: [x,y,w,h], columns, columnGutter, rows, rowGutter, margins: [top,left,bottom,right]
    /// | null, clearExisting, artboard }`. Returns the new guide ids.
    pub fn new_guide_layout(&mut self, json: &str) -> Result<Vec<u32>, JsError> {
        self.0.doc.new_guide_layout(json).map_err(err)
    }

    /// 4 guides at the union of `ids`' content bounds' edges.
    pub fn new_guides_from_shape(&mut self, ids: Vec<u32>) -> Result<Vec<u32>, JsError> {
        self.0.doc.new_guides_from_shape(&ids).map_err(err)
    }

    // ---------- paths (docs/M4.md section 4) ----------
    // `role` is "shape" or "vectorMask" (a node id) or "document" (a saved path id).

    /// Replaces a role's path (`VectorPath` JSON); "document" with id 0 sets the work path.
    /// Returns the edited path or node id.
    pub fn set_path(&mut self, role: &str, id: u32, json: &str) -> Result<u32, JsError> {
        self.0.doc.set_path(role, id, json).map_err(err)
    }

    pub fn new_path(&mut self) -> Result<u32, JsError> {
        self.0.doc.new_path().map_err(err)
    }

    pub fn save_path(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.save_path(id).map_err(err)
    }

    pub fn rename_path(&mut self, id: u32, name: &str) -> Result<(), JsError> {
        self.0.doc.rename_path(id, name).map_err(err)
    }

    pub fn delete_path(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.delete_path(id).map_err(err)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn fill_path(&mut self, role: &str, id: u32, layer: u32, r: u8, g: u8, b: u8, a: u8) -> Result<(), JsError> {
        self.0.doc.fill_path(role, id, layer, [r, g, b, a]).map_err(err)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn stroke_path(&mut self, role: &str, id: u32, layer: u32, width: f64, r: u8, g: u8, b: u8, a: u8) -> Result<(), JsError> {
        self.0.doc.stroke_path(role, id, layer, width, [r, g, b, a]).map_err(err)
    }

    pub fn make_selection_from_path(&mut self, role: &str, id: u32, mode: &str) -> Result<(), JsError> {
        self.0.doc.make_selection_from_path(role, id, Mode::parse(mode).map_err(err)?).map_err(err)
    }

    /// Returns the work path id.
    pub fn make_work_path(&mut self, tolerance: f64) -> Result<u32, JsError> {
        self.0.doc.make_work_path(tolerance).map_err(err)
    }

    /// Returns the new shape layer id.
    pub fn convert_path_to_shape(&mut self, role: &str, id: u32, r: u8, g: u8, b: u8) -> Result<u32, JsError> {
        self.0.doc.convert_path_to_shape(role, id, [r, g, b]).map_err(err)
    }

    /// A `VectorMask` JSON (manifest v5 `vector_mask`), or `null` to remove it.
    pub fn set_vector_mask(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_vector_mask(id, json).map_err(err)
    }

    /// `background` is an `ArtboardBackground` JSON; `after` a selected artboard or 0. Returns its id.
    pub fn new_artboard(&mut self, name: &str, w: f64, h: f64, background: &str, after: u32) -> Result<u32, JsError> {
        self.0.doc.new_artboard(name, w, h, background, after).map_err(err)
    }

    /// An empty `name` keeps the group's name.
    pub fn artboard_from_group(&mut self, id: u32, name: &str) -> Result<(), JsError> {
        self.0.doc.artboard_from_group(id, name).map_err(err)
    }

    /// Returns the new artboard group's id.
    pub fn artboard_from_layers(&mut self, ids: Vec<u32>, name: &str) -> Result<u32, JsError> {
        self.0.doc.artboard_from_layers(&ids, name).map_err(err)
    }

    /// Moves the rect and its guides; the caller moves its layers.
    pub fn offset_artboard(&mut self, id: u32, dx: f64, dy: f64) -> Result<(), JsError> {
        self.0.doc.offset_artboard(id, dx, dy).map_err(err)
    }

    /// After a move; returns whether the layer changed artboard.
    pub fn reparent_to_artboard(&mut self, id: u32) -> Result<bool, JsError> {
        self.0.doc.reparent_to_artboard(id).map_err(err)
    }

    /// An `Artboard` JSON (manifest v5 `artboard`) on a top-level group, or `null`.
    pub fn set_artboard(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_artboard(id, json).map_err(err)
    }

    /// `{ resolution, paths, guides, grid, guides_locked, artboards_locked }` (manifest v5 names).
    pub fn set_document_vector(&mut self, json: &str) -> Result<(), JsError> {
        self.0.doc.set_document_vector(json).map_err(err)
    }

    /// Replaces a type layer's model (TextData JSON) and drops its cache; call `render_text` next.
    pub fn set_text(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_text(id, json).map_err(err)
    }

    /// Renders a type layer's cache at `resolution` ppi with the fonts in `fonts`.
    pub fn render_text(&mut self, id: u32, fonts: &Fonts, resolution: f64) -> Result<(), JsError> {
        self.0.doc.render_text(id, &fonts.0, resolution).map_err(err)
    }

    /// "Create Work Path" from a type layer; returns the work path id.
    pub fn text_work_path(&mut self, id: u32, fonts: &Fonts, resolution: f64) -> Result<u32, JsError> {
        self.0.doc.text_work_path(id, &fonts.0, resolution).map_err(err)
    }

    /// "Convert to Shape": the type layer becomes a shape layer with the same id.
    pub fn convert_text_to_shape(&mut self, id: u32, fonts: &Fonts, resolution: f64) -> Result<(), JsError> {
        self.0.doc.convert_text_to_shape(id, &fonts.0, resolution).map_err(err)
    }

    /// Whether document point (x, y) hits the type layer's outline (2 px tolerance).
    pub fn text_hit(&self, id: u32, fonts: &Fonts, resolution: f64, x: f64, y: f64) -> Result<bool, JsError> {
        self.0.doc.text_hit(id, &fonts.0, resolution, x, y).map_err(err)
    }

    /// The type layer's layout in text space: `{ transform, overflow, lines }` for caret math.
    pub fn text_layout(&self, id: u32, fonts: &Fonts, resolution: f64) -> Result<String, JsError> {
        self.0.doc.text_layout(id, &fonts.0, resolution).map_err(err)
    }

    /// Type Mask commit: the type layer's outline coverage becomes the selection per `mode`.
    pub fn select_text(&mut self, id: u32, fonts: &Fonts, resolution: f64, mode: &str) -> Result<(), JsError> {
        self.0.doc.select_text(id, &fonts.0, resolution, Mode::parse(mode).map_err(err)?).map_err(err)
    }

    /// `{ name, live | path, fill, stroke }`: a shape layer on top with the path generated from `live` or given.
    pub fn new_shape(&mut self, json: &str) -> Result<u32, JsError> {
        self.0.doc.new_shape(json).map_err(err)
    }

    /// `{ live, fill, stroke }` replaces a shape layer's parameters; a changed `live` regenerates the path.
    pub fn set_shape(&mut self, id: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.set_shape(id, json).map_err(err)
    }

    /// `{ live | path, fill: [r, g, b, a] | null, stroke: { width, color } | null }` painted on a pixel layer.
    pub fn fill_shape(&mut self, layer: u32, json: &str) -> Result<(), JsError> {
        self.0.doc.fill_shape(layer, json).map_err(err)
    }

    /// Combine Shapes (`unite | subtract | intersect | exclude`) into the bottom shape layer; returns its id.
    pub fn combine_shapes(&mut self, ids: Vec<u32>, op: &str) -> Result<u32, JsError> {
        self.0.doc.combine_shapes(&ids, op).map_err(err)
    }

    /// Properties Pathfinder on one shape layer's subpaths.
    pub fn pathfinder(&mut self, id: u32, op: &str) -> Result<(), JsError> {
        self.0.doc.pathfinder(id, op).map_err(err)
    }

    pub fn merge_shape_components(&mut self, ids: Vec<u32>) -> Result<(), JsError> {
        self.0.doc.merge_shape_components(&ids).map_err(err)
    }

    pub fn rasterize_shape(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.rasterize_shape(id).map_err(err)
    }

    pub fn rasterize_type(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.rasterize_type(id).map_err(err)
    }

    pub fn rasterize_vector_mask(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.rasterize_vector_mask(id).map_err(err)
    }
}

/// The filter registry as JSON (docs/M5.md section 1, D3).
#[wasm_bindgen]
pub fn filter_schema() -> String {
    filters::schema_json()
}

/// `{ rest, deformed, triangles }` of a Puppet Warp rig JSON, for the session overlay.
#[wasm_bindgen]
pub fn puppet_geometry(rig_json: &str) -> Result<String, JsError> {
    puppet::geometry(rig_json).map_err(|e| JsError::new(&e))
}

/// The path JSON a live shape JSON generates (the shape tools' Path mode).
#[wasm_bindgen]
pub fn live_path(json: &str) -> Result<String, JsError> {
    let live: path::Live = serde_json::from_str(json).map_err(|e| JsError::new(&format!("invalid live shape: {e}")))?;
    Ok(serde_json::to_string(&doc::shapes::live_path(&live).map_err(err)?).unwrap())
}

/// Subpath JSON fit to freehand points JSON `[[x, y], ...]` (RDP, then cubics; tolerance 0.5..10 px).
#[wasm_bindgen]
pub fn fit_path(points_json: &str, tolerance: f64, closed: bool) -> Result<String, JsError> {
    let pts: Vec<[f64; 2]> = serde_json::from_str(points_json).map_err(|e| JsError::new(&format!("invalid points: {e}")))?;
    if !tolerance.is_finite() {
        return Err(JsError::new("fit_path needs a finite tolerance"));
    }
    Ok(serde_json::to_string(&geom::fit_points(&pts, tolerance.clamp(0.5, 10.0), closed)).unwrap())
}

/// App-scope font registry (one per worker, shared by every document).
#[wasm_bindgen]
#[derive(Default)]
pub struct Fonts(font::Registry);

#[wasm_bindgen]
impl Fonts {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Fonts {
        Fonts::default()
    }

    /// Registers a font file; returns the added faces as JSON `[{ id, family, style, weight, italic, postscript, source, color }]`.
    pub fn add(&mut self, bytes: Vec<u8>, source: &str) -> Result<String, JsError> {
        let faces = self.0.add(bytes, source).map_err(err)?;
        Ok(serde_json::to_string(&faces).unwrap())
    }

    pub fn faces_json(&self) -> String {
        serde_json::to_string(&self.0.faces()).unwrap()
    }

    pub fn families_json(&self) -> String {
        serde_json::to_string(&self.0.families()).unwrap()
    }

    /// Face id for a family (or PostScript name) and style; undefined when the family is missing.
    pub fn resolve(&self, family: &str, style: &str) -> Option<u32> {
        self.0.resolve(family, style)
    }

    /// Face id per character of `text` with the default fallback chain; -1 where no face draws it.
    pub fn char_faces(&self, face: u32, text: &str) -> Vec<i32> {
        self.0.fallback_faces(face, text).into_iter().map(|f| f.map_or(-1, |f| f as i32)).collect()
    }

    /// `pairs` is JSON `[[family, style], ...]`; returns the pairs whose family resolves to no face.
    pub fn missing_json(&self, pairs: &str) -> Result<String, JsError> {
        let pairs: Vec<(String, String)> = serde_json::from_str(pairs).map_err(|e| err(e.to_string()))?;
        Ok(serde_json::to_string(&self.0.missing(&pairs)).unwrap())
    }

    pub fn default_family(&self, family: &str) -> Option<String> {
        self.0.default_family(family)
    }

    /// The outline `VectorPath` JSON of a TextData JSON at `resolution` ppi (the Type Mask tools).
    pub fn text_outline(&self, json: &str, resolution: f64) -> Result<String, JsError> {
        let t: text::TextData = serde_json::from_str(json).map_err(|e| err(format!("invalid text: {e}")))?;
        t.validate().map_err(err)?;
        Ok(serde_json::to_string(&doc::glyphs::outline(&t, &self.0, resolution).path()).unwrap())
    }

    /// Glyphs panel cells: `sel` JSON `{ from, to } | { gids }`; JSON `{ missing, size, cells }`
    /// (`cells: [{ gid, cp, name }]`). Pair with `glyph_cells_alpha` for the matching coverage.
    pub fn glyph_cells_json(&self, family: &str, style: &str, sel: &str) -> Result<String, JsError> {
        let sel: glyph_cells::Selection = serde_json::from_str(sel).map_err(|e| err(e.to_string()))?;
        let r = glyph_cells::glyph_cells(&self.0, family, style, sel);
        Ok(serde_json::to_string(&serde_json::json!({ "missing": r.missing, "size": glyph_cells::CELL, "cells": r.cells })).unwrap())
    }

    /// The same cells' 8-bit coverage, row-major per cell, `cells.len() * size * size` bytes.
    pub fn glyph_cells_alpha(&self, family: &str, style: &str, sel: &str) -> Result<Vec<u8>, JsError> {
        let sel: glyph_cells::Selection = serde_json::from_str(sel).map_err(|e| err(e.to_string()))?;
        Ok(glyph_cells::glyph_cells(&self.0, family, style, sel).alpha)
    }

    /// Alternate glyph ids for `gid` from the salt, swsh, titl and ornm GSUB features.
    pub fn glyph_alternates(&self, family: &str, style: &str, gid: u16) -> Vec<u16> {
        glyph_cells::glyph_alternates(&self.0, family, style, gid)
    }

    /// True when the resolved face (no fallback) has a glyph for every non-whitespace character.
    pub fn font_covers(&self, family: &str, style: &str, text: &str) -> bool {
        self.0.covers(family, style, text)
    }
}
