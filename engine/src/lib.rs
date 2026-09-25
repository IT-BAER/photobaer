mod doc;

use doc::{Document, EngineCore};
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
    pub fn layer_count(&self) -> u32 {
        self.0.doc.layer_count()
    }
    pub fn max_level(&self) -> u32 {
        self.0.doc.max_level()
    }

    pub fn add_layer(&mut self, name: &str) -> u32 {
        self.0.doc.add_layer(name)
    }

    pub fn set_layer_props(&mut self, index: usize, visible: bool, opacity: f32) -> Result<(), JsError> {
        self.0.doc.set_layer_props(index, visible, opacity).map_err(err)
    }

    pub fn set_tile_rgba8(&mut self, layer: usize, tx: u32, ty: u32, data: &[u8]) -> Result<(), JsError> {
        self.0.doc.set_tile_rgba8(layer, tx, ty, data).map_err(err)
    }

    pub fn fill(&mut self, layer: usize, r: u8, g: u8, b: u8, a: u8) -> Result<(), JsError> {
        self.0.doc.fill(layer, r, g, b, a).map_err(err)
    }

    pub fn invert(&mut self, layer: usize) -> Result<(), JsError> {
        self.0.doc.invert(layer).map_err(err)
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
