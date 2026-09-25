use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

pub const TILE: usize = 256;
const TILE_PIXELS: usize = TILE * TILE;
const TILE_BYTES_U8: usize = TILE_PIXELS * 4;
const TILE_BYTES_U16: usize = TILE_PIXELS * 4 * 2;
const MANIFEST_FORMAT: &str = "photobaer-manifest";
const MANIFEST_VERSION: u32 = 1;

#[derive(Clone)]
pub enum Pixels {
    U8(Box<[u8]>),
    U16(Box<[u16]>),
}

impl Pixels {
    fn get_f32(&self, p: usize) -> [f32; 4] {
        let o = p * 4;
        match self {
            Pixels::U8(d) => [
                d[o] as f32 / 255.0,
                d[o + 1] as f32 / 255.0,
                d[o + 2] as f32 / 255.0,
                d[o + 3] as f32 / 255.0,
            ],
            Pixels::U16(d) => [
                d[o] as f32 / 65535.0,
                d[o + 1] as f32 / 65535.0,
                d[o + 2] as f32 / 65535.0,
                d[o + 3] as f32 / 65535.0,
            ],
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        match self {
            Pixels::U8(d) => d.to_vec(),
            Pixels::U16(d) => {
                let mut out = Vec::with_capacity(d.len() * 2);
                for v in d.iter() {
                    out.extend_from_slice(&v.to_le_bytes());
                }
                out
            }
        }
    }

    fn from_bytes(depth: u8, bytes: &[u8]) -> Result<Pixels, String> {
        if depth == 8 {
            if bytes.len() != TILE_BYTES_U8 {
                return Err(format!("expected {TILE_BYTES_U8} bytes, got {}", bytes.len()));
            }
            Ok(Pixels::U8(bytes.to_vec().into_boxed_slice()))
        } else {
            if bytes.len() != TILE_BYTES_U16 {
                return Err(format!("expected {TILE_BYTES_U16} bytes, got {}", bytes.len()));
            }
            let mut out = Vec::with_capacity(bytes.len() / 2);
            for chunk in bytes.chunks_exact(2) {
                out.push(u16::from_le_bytes([chunk[0], chunk[1]]));
            }
            Ok(Pixels::U16(out.into_boxed_slice()))
        }
    }

    fn from_rgba8(depth: u8, rgba8: &[u8]) -> Pixels {
        if depth == 8 {
            Pixels::U8(rgba8.to_vec().into_boxed_slice())
        } else {
            let mut out = Vec::with_capacity(rgba8.len());
            for v in rgba8 {
                out.push(*v as u16 * 257);
            }
            Pixels::U16(out.into_boxed_slice())
        }
    }

    fn inverted(&self) -> Pixels {
        match self {
            Pixels::U8(d) => {
                let mut out = d.clone();
                for p in 0..TILE_PIXELS {
                    let o = p * 4;
                    out[o] = 255 - d[o];
                    out[o + 1] = 255 - d[o + 1];
                    out[o + 2] = 255 - d[o + 2];
                    out[o + 3] = d[o + 3];
                }
                Pixels::U8(out)
            }
            Pixels::U16(d) => {
                let mut out = d.clone();
                for p in 0..TILE_PIXELS {
                    let o = p * 4;
                    out[o] = 65535 - d[o];
                    out[o + 1] = 65535 - d[o + 1];
                    out[o + 2] = 65535 - d[o + 2];
                    out[o + 3] = d[o + 3];
                }
                Pixels::U16(out)
            }
        }
    }
}

#[derive(Clone)]
pub struct Tile {
    pub id: u64,
    pub px: Arc<Pixels>,
}

#[derive(Clone)]
pub struct Layer {
    pub name: String,
    pub visible: bool,
    pub opacity: f32,
    pub tiles: Vec<Option<Tile>>,
}

#[derive(Clone)]
struct Loading {
    // id -> (layer_idx, slot_idx) pairs still waiting for pixel data.
    id_to_slots: HashMap<u64, Vec<(usize, usize)>>,
    pending_ids: HashSet<u64>,
    max_referenced_id: u64,
}

#[derive(Clone)]
pub struct Document {
    width: u32,
    height: u32,
    depth: u8,
    layers: Vec<Layer>,
    next_id: u64,
    loading: Option<Loading>,
}

#[derive(Serialize)]
struct ManifestLayerOut<'a> {
    name: &'a str,
    visible: bool,
    opacity: f32,
    tiles: Vec<u64>,
}

#[derive(Serialize)]
struct ManifestOut<'a> {
    format: &'a str,
    version: u32,
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
    next_id: u64,
    layers: Vec<ManifestLayerOut<'a>>,
}

#[derive(Deserialize)]
struct ManifestLayerIn {
    name: String,
    visible: bool,
    opacity: f32,
    tiles: Vec<u64>,
}

#[derive(Deserialize)]
struct ManifestIn {
    format: String,
    version: u32,
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
    next_id: u64,
    layers: Vec<ManifestLayerIn>,
}

fn validate_dims(width: u32, height: u32, depth: u8) -> Result<(), String> {
    if !(1..=65536).contains(&width) || !(1..=65536).contains(&height) {
        return Err("width and height must be in 1..=65536".into());
    }
    if depth != 8 && depth != 16 {
        return Err("depth must be 8 or 16".into());
    }
    Ok(())
}

fn tiles_for(size: u32) -> u32 {
    (size as u64).div_ceil(TILE as u64) as u32
}

impl Document {
    pub fn new(width: u32, height: u32, depth: u8) -> Result<Document, String> {
        validate_dims(width, height, depth)?;
        let tx = tiles_for(width);
        let ty = tiles_for(height);
        Ok(Document {
            width,
            height,
            depth,
            layers: vec![Layer {
                name: "Background".to_string(),
                visible: true,
                opacity: 1.0,
                tiles: vec![None; (tx * ty) as usize],
            }],
            next_id: 1,
            loading: None,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn depth(&self) -> u8 {
        self.depth
    }
    pub fn tiles_x(&self) -> u32 {
        tiles_for(self.width)
    }
    pub fn tiles_y(&self) -> u32 {
        tiles_for(self.height)
    }
    pub fn layer_count(&self) -> u32 {
        self.layers.len() as u32
    }

    pub fn max_level(&self) -> u32 {
        let m = self.width.max(self.height) as u64;
        for l in 0..=8u32 {
            let span = (TILE as u64) << l;
            if m.div_ceil(span) == 1 {
                return l;
            }
        }
        8
    }

    fn check_layer(&self, layer: usize) -> Result<(), String> {
        if layer >= self.layers.len() {
            return Err(format!("layer index {layer} out of range"));
        }
        Ok(())
    }

    pub fn add_layer(&mut self, name: &str) -> u32 {
        let tx = self.tiles_x();
        let ty = self.tiles_y();
        self.layers.push(Layer {
            name: name.to_string(),
            visible: true,
            opacity: 1.0,
            tiles: vec![None; (tx * ty) as usize],
        });
        (self.layers.len() - 1) as u32
    }

    pub fn set_layer_props(&mut self, layer: usize, visible: bool, opacity: f32) -> Result<(), String> {
        self.check_layer(layer)?;
        self.layers[layer].visible = visible;
        self.layers[layer].opacity = opacity;
        Ok(())
    }

    pub fn set_tile_rgba8(&mut self, layer: usize, tx: u32, ty: u32, data: &[u8]) -> Result<(), String> {
        self.check_layer(layer)?;
        if tx >= self.tiles_x() || ty >= self.tiles_y() {
            return Err("tile coordinate out of range".into());
        }
        if data.len() != TILE_BYTES_U8 {
            return Err(format!("expected {TILE_BYTES_U8} bytes, got {}", data.len()));
        }
        let slot = (ty * self.tiles_x() + tx) as usize;
        let transparent = data.chunks_exact(4).all(|px| px[3] == 0);
        if transparent {
            self.layers[layer].tiles[slot] = None;
        } else {
            let id = self.next_id;
            self.next_id += 1;
            let px = Arc::new(Pixels::from_rgba8(self.depth, data));
            self.layers[layer].tiles[slot] = Some(Tile { id, px });
        }
        Ok(())
    }

    pub fn fill(&mut self, layer: usize, r: u8, g: u8, b: u8, a: u8) -> Result<(), String> {
        self.check_layer(layer)?;
        let slots = self.layers[layer].tiles.len();
        if a == 0 {
            for slot in self.layers[layer].tiles.iter_mut() {
                *slot = None;
            }
            return Ok(());
        }
        let mut rgba = vec![0u8; TILE_BYTES_U8];
        for px in rgba.chunks_exact_mut(4) {
            px[0] = r;
            px[1] = g;
            px[2] = b;
            px[3] = a;
        }
        let id = self.next_id;
        self.next_id += 1;
        let px = Arc::new(Pixels::from_rgba8(self.depth, &rgba));
        for i in 0..slots {
            self.layers[layer].tiles[i] = Some(Tile { id, px: px.clone() });
        }
        Ok(())
    }

    pub fn invert(&mut self, layer: usize) -> Result<(), String> {
        self.check_layer(layer)?;
        let mut memo: HashMap<u64, Tile> = HashMap::new();
        for slot in self.layers[layer].tiles.iter_mut() {
            if let Some(tile) = slot {
                if let Some(new_tile) = memo.get(&tile.id) {
                    *slot = Some(new_tile.clone());
                } else {
                    let id = self.next_id;
                    self.next_id += 1;
                    let new_tile = Tile {
                        id,
                        px: Arc::new(tile.px.inverted()),
                    };
                    memo.insert(tile.id, new_tile.clone());
                    *slot = Some(new_tile);
                }
            }
        }
        Ok(())
    }

    fn slot_has_visible_tile(&self, tx: u32, ty: u32) -> bool {
        let slot = (ty * self.tiles_x() + tx) as usize;
        self.layers
            .iter()
            .any(|l| l.visible && l.opacity > 0.0 && l.tiles[slot].is_some())
    }

    // Composites one level-0 tile bottom-to-top into a premultiplied f32 buffer.
    // Pixels outside the document rect (in an edge tile) are left as 0 (transparent).
    fn composite_tile_premul(&self, tx: u32, ty: u32) -> Vec<f32> {
        let mut out = vec![0f32; TILE_PIXELS * 4];
        let slot = (ty * self.tiles_x() + tx) as usize;
        let valid_w = ((self.width - tx * TILE as u32).min(TILE as u32)) as usize;
        let valid_h = ((self.height - ty * TILE as u32).min(TILE as u32)) as usize;
        for layer in &self.layers {
            if !layer.visible || layer.opacity <= 0.0 {
                continue;
            }
            let Some(tile) = &layer.tiles[slot] else {
                continue;
            };
            let op = layer.opacity;
            for y in 0..valid_h {
                for x in 0..valid_w {
                    let p = y * TILE + x;
                    let [r, g, b, a] = tile.px.get_f32(p);
                    let sa = a * op;
                    let o = p * 4;
                    out[o] = r * sa + out[o] * (1.0 - sa);
                    out[o + 1] = g * sa + out[o + 1] * (1.0 - sa);
                    out[o + 2] = b * sa + out[o + 2] * (1.0 - sa);
                    out[o + 3] = sa + out[o + 3] * (1.0 - sa);
                }
            }
        }
        out
    }

    pub fn display_tile(&self, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        if level > 8 {
            return Err("level must be <= 8".into());
        }
        let n = 1u32 << level;
        let sub = (TILE as u32) >> level;
        let tiles_x = self.tiles_x();
        let tiles_y = self.tiles_y();
        let mut out = vec![0f32; TILE_PIXELS * 4];
        for lj in 0..n {
            let sy = ty * n + lj;
            if sy >= tiles_y {
                continue;
            }
            for li in 0..n {
                let sx = tx * n + li;
                if sx >= tiles_x || !self.slot_has_visible_tile(sx, sy) {
                    continue;
                }
                let src = self.composite_tile_premul(sx, sy);
                let cnt = (n * n) as f32;
                for oy in 0..sub {
                    for ox in 0..sub {
                        let mut acc = [0f32; 4];
                        for dy in 0..n {
                            for dx in 0..n {
                                let spx = (oy * n + dy) as usize * TILE + (ox * n + dx) as usize;
                                let o = spx * 4;
                                acc[0] += src[o];
                                acc[1] += src[o + 1];
                                acc[2] += src[o + 2];
                                acc[3] += src[o + 3];
                            }
                        }
                        let ooy = (lj * sub + oy) as usize;
                        let oox = (li * sub + ox) as usize;
                        let oo = (ooy * TILE + oox) * 4;
                        out[oo] = acc[0] / cnt;
                        out[oo + 1] = acc[1] / cnt;
                        out[oo + 2] = acc[2] / cnt;
                        out[oo + 3] = acc[3] / cnt;
                    }
                }
            }
        }
        let mut bytes = vec![0u8; TILE_BYTES_U8];
        let mut any_alpha = false;
        for p in 0..TILE_PIXELS {
            let o = p * 4;
            for c in 0..4 {
                bytes[o + c] = (out[o + c] * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            if bytes[o + 3] != 0 {
                any_alpha = true;
            }
        }
        if !any_alpha {
            return Ok(None);
        }
        Ok(Some(bytes))
    }

    pub fn flatten_tile_rgba8(&self, tx: u32, ty: u32) -> Result<Vec<u8>, String> {
        if tx >= self.tiles_x() || ty >= self.tiles_y() {
            return Err("tile coordinate out of range".into());
        }
        let premul = self.composite_tile_premul(tx, ty);
        let mut bytes = vec![0u8; TILE_BYTES_U8];
        for p in 0..TILE_PIXELS {
            let o = p * 4;
            let a = premul[o + 3];
            let (r, g, b) = if a > 0.0 {
                (premul[o] / a, premul[o + 1] / a, premul[o + 2] / a)
            } else {
                (0.0, 0.0, 0.0)
            };
            bytes[o] = (r * 255.0).round().clamp(0.0, 255.0) as u8;
            bytes[o + 1] = (g * 255.0).round().clamp(0.0, 255.0) as u8;
            bytes[o + 2] = (b * 255.0).round().clamp(0.0, 255.0) as u8;
            bytes[o + 3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        Ok(bytes)
    }

    pub fn manifest(&self) -> String {
        let m = ManifestOut {
            format: MANIFEST_FORMAT,
            version: MANIFEST_VERSION,
            width: self.width,
            height: self.height,
            depth: self.depth,
            tiles_x: self.tiles_x(),
            tiles_y: self.tiles_y(),
            next_id: self.next_id,
            layers: self
                .layers
                .iter()
                .map(|l| ManifestLayerOut {
                    name: &l.name,
                    visible: l.visible,
                    opacity: l.opacity,
                    tiles: l.tiles.iter().map(|t| t.as_ref().map_or(0, |t| t.id)).collect(),
                })
                .collect(),
        };
        serde_json::to_string(&m).expect("manifest serialization cannot fail")
    }

    pub fn tile_bytes(&self, id: u64) -> Result<Vec<u8>, String> {
        for layer in &self.layers {
            for slot in &layer.tiles {
                if let Some(t) = slot {
                    if t.id == id {
                        return Ok(t.px.to_bytes());
                    }
                }
            }
        }
        Err(format!("unknown tile id {id}"))
    }

    pub fn from_manifest(json: &str) -> Result<Document, String> {
        let m: ManifestIn = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
        if m.format != MANIFEST_FORMAT {
            return Err(format!("unexpected format {}", m.format));
        }
        if m.version != MANIFEST_VERSION {
            return Err(format!("unsupported version {}", m.version));
        }
        validate_dims(m.width, m.height, m.depth)?;
        let tx = tiles_for(m.width);
        let ty = tiles_for(m.height);
        if tx != m.tiles_x || ty != m.tiles_y {
            return Err("tiles_x/tiles_y do not match width/height".into());
        }
        let expected_tiles = (tx * ty) as usize;
        let mut layers = Vec::with_capacity(m.layers.len());
        let mut id_to_slots: HashMap<u64, Vec<(usize, usize)>> = HashMap::new();
        // Ids travel as JS numbers; anything above 2^53 would lose precision or overflow next_id.
        const MAX_ID: u64 = 1 << 53;
        if m.next_id > MAX_ID {
            return Err("next_id out of range".into());
        }
        let mut max_referenced_id = 0u64;
        for (li, in_layer) in m.layers.iter().enumerate() {
            if in_layer.tiles.len() != expected_tiles {
                return Err("layer tile count does not match tiles_x*tiles_y".into());
            }
            for (slot, &id) in in_layer.tiles.iter().enumerate() {
                if id > MAX_ID {
                    return Err(format!("tile id {id} out of range"));
                }
                if id != 0 {
                    id_to_slots.entry(id).or_default().push((li, slot));
                    max_referenced_id = max_referenced_id.max(id);
                }
            }
            layers.push(Layer {
                name: in_layer.name.clone(),
                visible: in_layer.visible,
                opacity: in_layer.opacity,
                tiles: vec![None; expected_tiles],
            });
        }
        let pending_ids: HashSet<u64> = id_to_slots.keys().copied().collect();
        Ok(Document {
            width: m.width,
            height: m.height,
            depth: m.depth,
            layers,
            next_id: m.next_id,
            loading: Some(Loading {
                id_to_slots,
                pending_ids,
                max_referenced_id,
            }),
        })
    }

    pub fn put_tile(&mut self, id: u64, bytes: &[u8]) -> Result<(), String> {
        let depth = self.depth;
        let loading = self.loading.as_mut().ok_or("document is not loading")?;
        let slots = loading
            .id_to_slots
            .get(&id)
            .ok_or_else(|| format!("unknown tile id {id}"))?
            .clone();
        let px = Arc::new(Pixels::from_bytes(depth, bytes)?);
        for (li, slot) in slots {
            self.layers[li].tiles[slot] = Some(Tile { id, px: px.clone() });
        }
        self.loading.as_mut().unwrap().pending_ids.remove(&id);
        Ok(())
    }

    pub fn finish_load(&mut self) -> Result<(), String> {
        let loading = self.loading.take().ok_or("document is not loading")?;
        if !loading.pending_ids.is_empty() {
            self.loading = Some(loading);
            return Err("not all referenced tiles were loaded".into());
        }
        self.next_id = self.next_id.max(loading.max_referenced_id + 1);
        Ok(())
    }
}

/// Host-testable core behind the wasm `Engine`: current document plus live
/// snapshots. Kept here (not in lib.rs) so `cargo test` covers it directly.
pub struct EngineCore {
    pub doc: Document,
    snapshots: HashMap<u32, Document>,
    next_snapshot_id: u32,
}

impl EngineCore {
    pub fn new(doc: Document) -> EngineCore {
        EngineCore {
            doc,
            snapshots: HashMap::new(),
            next_snapshot_id: 0,
        }
    }

    pub fn snapshot(&mut self) -> u32 {
        let id = self.next_snapshot_id;
        self.next_snapshot_id += 1;
        self.snapshots.insert(id, self.doc.clone());
        id
    }

    pub fn restore(&mut self, id: u32) -> Result<(), String> {
        let snap = self.snapshots.get(&id).ok_or_else(|| format!("unknown snapshot {id}"))?;
        // next_id must never go backwards, so ids stay unique across restores.
        let next_id = self.doc.next_id.max(snap.next_id);
        let mut restored = snap.clone();
        restored.next_id = next_id;
        self.doc = restored;
        Ok(())
    }

    pub fn drop_snapshot(&mut self, id: u32) {
        self.snapshots.remove(&id);
    }

    // Searches the current document first, then every live snapshot: an
    // autosave can hold a snapshot's tile ids after the live doc drops them.
    pub fn tile_bytes(&self, id: u64) -> Result<Vec<u8>, String> {
        if let Ok(bytes) = self.doc.tile_bytes(id) {
            return Ok(bytes);
        }
        for snap in self.snapshots.values() {
            if let Ok(bytes) = snap.tile_bytes(id) {
                return Ok(bytes);
            }
        }
        Err(format!("unknown tile id {id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opaque(r: u8, g: u8, b: u8) -> Vec<u8> {
        let mut v = vec![0u8; TILE_BYTES_U8];
        for px in v.chunks_exact_mut(4) {
            px[0] = r;
            px[1] = g;
            px[2] = b;
            px[3] = 255;
        }
        v
    }

    #[test]
    fn new_doc_tile_grid_and_max_level() {
        let d = Document::new(600, 300, 8).unwrap();
        assert_eq!(d.tiles_x(), 3);
        assert_eq!(d.tiles_y(), 2);
        assert_eq!(d.max_level(), 2);
        assert_eq!(d.display_tile(0, 0, 0).unwrap(), None);
    }

    #[test]
    fn invalid_dims_rejected() {
        assert!(Document::new(0, 10, 8).is_err());
        assert!(Document::new(10, 65537, 8).is_err());
        assert!(Document::new(10, 10, 12).is_err());
    }

    #[test]
    fn bad_layer_index_errors() {
        let mut d = Document::new(10, 10, 8).unwrap();
        assert!(d.fill(1, 0, 0, 0, 255).is_err());
        assert!(d.invert(5).is_err());
        assert!(d.set_layer_props(2, true, 1.0).is_err());
    }

    #[test]
    fn fill_and_manifest_share_id() {
        let mut d = Document::new(300, 300, 8).unwrap();
        d.fill(0, 255, 0, 0, 255).unwrap();
        let px = d.display_tile(0, 0, 0).unwrap().unwrap();
        assert_eq!(&px[0..4], &[255, 0, 0, 255]);
        let manifest: serde_json::Value = serde_json::from_str(&d.manifest()).unwrap();
        let ids: Vec<u64> = manifest["layers"][0]["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        assert!(ids.iter().all(|&id| id == ids[0] && id != 0));
    }

    #[test]
    fn snapshot_isolation_and_id_growth() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.fill(0, 255, 0, 0, 255).unwrap();
        let snap = d.clone();
        d.invert(0).unwrap();
        assert_eq!(&d.display_tile(0, 0, 0).unwrap().unwrap()[0..4], &[0, 255, 255, 255]);
        let mut restored = snap.clone();
        assert_eq!(&restored.display_tile(0, 0, 0).unwrap().unwrap()[0..4], &[255, 0, 0, 255]);
        let ids_before = restored.next_id;
        restored.invert(0).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&restored.manifest()).unwrap();
        let new_id = manifest["layers"][0]["tiles"][0].as_u64().unwrap();
        assert!(new_id >= ids_before, "new id {new_id} must be >= every earlier id {ids_before}");
    }

    #[test]
    fn blend_two_layers() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.fill(0, 255, 255, 255, 255).unwrap();
        d.add_layer("top");
        d.fill(1, 255, 0, 0, 128).unwrap();
        d.set_layer_props(1, true, 0.5).unwrap();
        let px = d.display_tile(0, 0, 0).unwrap().unwrap();
        assert_eq!(&px[0..4], &[255, 191, 191, 255]);
    }

    #[test]
    fn hidden_layer_ignored() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.fill(0, 255, 255, 255, 255).unwrap();
        d.add_layer("top");
        d.fill(1, 255, 0, 0, 128).unwrap();
        d.set_layer_props(1, false, 1.0).unwrap();
        let px = d.display_tile(0, 0, 0).unwrap().unwrap();
        assert_eq!(&px[0..4], &[255, 255, 255, 255]);
    }

    #[test]
    fn box_filter_checkerboard() {
        let mut d = Document::new(512, 512, 8).unwrap();
        d.set_tile_rgba8(0, 0, 0, &opaque(0, 0, 0)).unwrap();
        d.set_tile_rgba8(0, 1, 1, &opaque(0, 0, 0)).unwrap();
        d.set_tile_rgba8(0, 1, 0, &opaque(255, 255, 255)).unwrap();
        d.set_tile_rgba8(0, 0, 1, &opaque(255, 255, 255)).unwrap();
        let out = d.display_tile(1, 0, 0).unwrap().unwrap();
        let px = |x: usize, y: usize| -> [u8; 4] {
            let o = (y * TILE + x) * 4;
            [out[o], out[o + 1], out[o + 2], out[o + 3]]
        };
        assert_eq!(px(0, 0), [0, 0, 0, 255]);
        assert_eq!(px(200, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn box_filter_edge_of_document() {
        let mut d = Document::new(300, 300, 8).unwrap();
        d.fill(0, 255, 255, 255, 255).unwrap();
        let out = d.display_tile(1, 0, 0).unwrap().unwrap();
        let px = |x: usize, y: usize| -> [u8; 4] {
            let o = (y * TILE + x) * 4;
            [out[o], out[o + 1], out[o + 2], out[o + 3]]
        };
        assert_eq!(px(0, 0), [255, 255, 255, 255]);
        assert_eq!(px(149, 0), [255, 255, 255, 255]);
        assert_eq!(px(150, 0), [0, 0, 0, 0]);
    }

    #[test]
    fn depth16_invert() {
        let mut d = Document::new(256, 256, 16).unwrap();
        d.fill(0, 255, 255, 255, 255).unwrap();
        d.invert(0).unwrap();
        let out = d.display_tile(0, 0, 0).unwrap().unwrap();
        assert_eq!(&out[0..4], &[0, 0, 0, 255]);
        let manifest: serde_json::Value = serde_json::from_str(&d.manifest()).unwrap();
        let id = manifest["layers"][0]["tiles"][0].as_u64().unwrap();
        assert_eq!(d.tile_bytes(id).unwrap().len(), TILE_BYTES_U16);
    }

    #[test]
    fn round_trip_manifest_and_tiles() {
        let mut d = Document::new(600, 300, 8).unwrap();
        d.fill(0, 10, 20, 30, 255).unwrap();
        d.add_layer("top");
        d.set_tile_rgba8(1, 1, 1, &opaque(9, 9, 9)).unwrap();
        d.invert(1).unwrap();

        let manifest = d.manifest();
        let mut loaded = Document::from_manifest(&manifest).unwrap();
        let m: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let mut ids: HashSet<u64> = HashSet::new();
        for layer in m["layers"].as_array().unwrap() {
            for id in layer["tiles"].as_array().unwrap() {
                let id = id.as_u64().unwrap();
                if id != 0 {
                    ids.insert(id);
                }
            }
        }
        assert!(loaded.finish_load().is_err());
        for id in ids {
            loaded.put_tile(id, &d.tile_bytes(id).unwrap()).unwrap();
        }
        loaded.finish_load().unwrap();

        assert_eq!(loaded.manifest(), manifest);
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                assert_eq!(loaded.display_tile(0, tx, ty).unwrap(), d.display_tile(0, tx, ty).unwrap());
            }
        }
    }

    #[test]
    fn transparent_tile_write_clears_slot() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.set_tile_rgba8(0, 0, 0, &vec![0u8; TILE_BYTES_U8]).unwrap();
        let manifest: serde_json::Value = serde_json::from_str(&d.manifest()).unwrap();
        assert_eq!(manifest["layers"][0]["tiles"][0].as_u64().unwrap(), 0);
    }

    #[test]
    fn flatten_round_trips_straight_alpha() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let mut data = vec![0u8; TILE_BYTES_U8];
        data[0] = 200;
        data[1] = 100;
        data[2] = 50;
        data[3] = 128;
        d.set_tile_rgba8(0, 0, 0, &data).unwrap();
        let flat = d.flatten_tile_rgba8(0, 0).unwrap();
        for i in 0..4 {
            assert!((flat[i] as i32 - data[i] as i32).abs() <= 1, "channel {i}: {} vs {}", flat[i], data[i]);
        }
    }

    #[test]
    fn tile_bytes_falls_back_to_live_snapshot() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.fill(0, 255, 0, 0, 255).unwrap();
        let old_id = {
            let m: serde_json::Value = serde_json::from_str(&d.manifest()).unwrap();
            m["layers"][0]["tiles"][0].as_u64().unwrap()
        };
        let mut engine = EngineCore::new(d);
        let snap = engine.snapshot();
        engine.doc.invert(0).unwrap();
        assert!(engine.doc.tile_bytes(old_id).is_err());
        assert!(engine.tile_bytes(old_id).is_ok());
        engine.drop_snapshot(snap);
        assert!(engine.tile_bytes(old_id).is_err());
    }

    #[test]
    #[ignore]
    fn bench_display_tile() {
        use std::time::Instant;
        let mut d = Document::new(8000, 8000, 8).unwrap();
        d.fill(0, 128, 64, 32, 200).unwrap();

        let start = Instant::now();
        for i in 0..16 {
            let tx = i % 4;
            let ty = i / 4;
            d.display_tile(0, tx, ty).unwrap();
        }
        let level0_ms = start.elapsed().as_secs_f64() * 1000.0;

        let start = Instant::now();
        d.display_tile(3, 0, 0).unwrap();
        let level3_ms = start.elapsed().as_secs_f64() * 1000.0;

        println!("bench_display_tile: 16x level0 = {level0_ms:.3}ms, level3(0,0) = {level3_ms:.3}ms");
    }

    #[test]
    fn manifest_ids_beyond_js_safe_integers_are_rejected() {
        let d = Document::new(256, 256, 8).unwrap();
        let big = format!("{}", 1u64 << 60);
        let json = d.manifest().replacen(&format!("\"next_id\":{}", d.next_id), &format!("\"next_id\":{big}"), 1);
        assert!(json.contains(&big));
        assert!(Document::from_manifest(&json).is_err());
        let json = d.manifest().replacen("\"tiles\":[0]", &format!("\"tiles\":[{big}]"), 1);
        assert!(json.contains(&big));
        assert!(Document::from_manifest(&json).is_err());
    }

    #[test]
    fn loaded_empty_manifest_with_next_id_zero_still_allocates_nonzero_ids() {
        let d = Document::new(256, 256, 8).unwrap();
        let json = d.manifest().replacen(&format!("\"next_id\":{}", d.next_id), "\"next_id\":0", 1);
        let mut l = Document::from_manifest(&json).unwrap();
        l.finish_load().unwrap();
        l.fill(0, 1, 2, 3, 255).unwrap();
        assert!(!l.manifest().contains("\"tiles\":[0]"));
    }
}
