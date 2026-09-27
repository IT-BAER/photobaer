mod adjust;
mod blend;
mod content;
mod doc;
mod gradient;
mod livewire;
mod pattern;
mod region;
mod resample;
mod selection;
mod stroke;
mod styles;

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

    /// Renders a fill layer into pixel tiles over the document bounds, keeping its id.
    pub fn rasterize_fill(&mut self, id: u32) -> Result<(), JsError> {
        self.0.doc.rasterize_fill(id).map_err(err)
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
}
