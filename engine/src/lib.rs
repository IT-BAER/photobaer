mod blend;
mod doc;
mod livewire;
mod region;
mod selection;
mod stroke;

use blend::PaintMode;
use doc::{Document, EngineCore, Target};
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
}
