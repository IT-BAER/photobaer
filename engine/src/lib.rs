mod blend;
mod doc;

use doc::{Document, EngineCore, Target};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Engine(EngineCore);

fn err(e: String) -> JsError {
    JsError::new(&e)
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
