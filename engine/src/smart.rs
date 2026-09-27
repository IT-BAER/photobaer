//! Smart objects (docs/M3.md section 6): the cache is always rendered from the source tiles,
//! through the placement transform or, when set, the warp mesh (whose parameter square spans
//! the source rect). A child module of `doc`, so it reaches the document's private tile storage.

use super::canvas::mul3;
use super::transform::check_area;
use super::*;
use crate::resample::{Interp, Resampler};

const EMPTY: &str = "That file has no pixels to place.";
const NO_SOURCE: &str = "This Smart Object has no source pixels; use Replace Contents first.";
// Same limit as transforms and warps.
const MAX_SOURCE: u64 = 100_000_000;

// Entries within 1e-9 of an integer are that integer, so a transform and its inverse cancel.
fn snap(m: [f64; 9]) -> [f64; 9] {
    m.map(|v| if (v - v.round()).abs() < 1e-9 { v.round() } else { v })
}

fn apply(m: &[f64; 9], x: f64, y: f64) -> Option<(f64, f64)> {
    let w = m[6] * x + m[7] * y + m[8];
    (w != 0.0 && w.is_finite()).then(|| ((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w))
}

/// The placement after document map `m`: the transform composed with it and the warp points
/// mapped by it.
pub(super) fn moved(s: &Smart, m: &[f64; 9]) -> ([f64; 9], Option<WarpMesh>) {
    let warp = s.warp.as_ref().map(|w| WarpMesh {
        points: w.points.iter().map(|p| apply(m, p[0], p[1]).map_or(*p, |(x, y)| [x, y])).collect(),
        ..w.clone()
    });
    (snap(mul3(m, &s.transform)), warp)
}

fn check_size(size: [u32; 2]) -> Result<(), String> {
    if size[0] == 0 || size[1] == 0 {
        return Err(EMPTY.into());
    }
    if size[0] as u64 * size[1] as u64 > MAX_SOURCE {
        return Err("the smart object source is too large".into());
    }
    Ok(())
}

// Row-major source px -> document px translation.
fn translate(x: f64, y: f64) -> [f64; 9] {
    [1.0, 0.0, x, 0.0, 1.0, y, 0.0, 0.0, 1.0]
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PlaceIn {
    name: String,
    link: Link,
    source_blob: Option<u64>,
    source_size: [u32; 2],
    transform: [f64; 9],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplaceIn {
    #[serde(default)]
    link: Option<Link>,
    source_blob: Option<u64>,
    source_size: [u32; 2],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LinkIn {
    link: Link,
    source_blob: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ConvertIn {
    name: String,
    link_id: String,
    source_blob: Option<u64>,
}

impl Document {
    pub(super) fn smart(&self, id: u32) -> Result<&Smart, String> {
        let n = self.node(id)?;
        match &n.kind {
            Kind::Smart(s) => Ok(s),
            _ => Err(format!("node {id} is a {} layer, not a smart object", n.kind_name())),
        }
    }

    fn smart_node_mut(&mut self, id: u32) -> Result<&mut Smart, String> {
        self.smart(id)?;
        Ok(self.node_mut(id)?.smart_mut())
    }

    // Source tiles from straight RGBA8 of `size`; fully transparent tiles stay absent.
    fn source_tiles(&mut self, size: [u32; 2], rgba: &[u8]) -> Result<Tiles, String> {
        check_size(size)?;
        let (w, h) = (size[0] as usize, size[1] as usize);
        if rgba.len() != w * h * 4 {
            return Err("source pixels must be width x height x 4 bytes".into());
        }
        let mut out = Tiles::default();
        for ty in 0..h.div_ceil(TILE) {
            for tx in 0..w.div_ceil(TILE) {
                let mut buf = vec![0u8; TILE_BYTES_U8];
                let (x0, x1) = (tx * TILE, (tx * TILE + TILE).min(w));
                for y in ty * TILE..(ty * TILE + TILE).min(h) {
                    let s = (y * w + x0) * 4;
                    let d = ((y - ty * TILE) * TILE) * 4;
                    buf[d..d + (x1 - x0) * 4].copy_from_slice(&rgba[s..s + (x1 - x0) * 4]);
                }
                if buf.chunks_exact(4).any(|p| p[3] > 0) {
                    let px = Pixels::from_rgba8(self.depth, &buf);
                    out.put(tx as i32, ty as i32, Some(Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
                }
            }
        }
        Ok(out)
    }

    // The cache of a source placed by `t`, or by `warp` when one is set (bicubic).
    pub(super) fn smart_render(&mut self, src: &Tiles, size: [u32; 2], t: &[f64; 9], warp: Option<&WarpMesh>) -> Result<Tiles, String> {
        check_size(size)?;
        let r = [0, 0, size[0] as i32, size[1] as i32];
        check_area(r)?;
        let plane = self.rgba_plane(src, r, None);
        match warp {
            None => {
                let rs = Resampler::new(plane, t, Interp::Bicubic, 0.0)?;
                self.render_tiles(&rs, None, None)
            }
            Some(w) => self.mesh_render(w, plane, [0.0, 0.0, size[0] as f64, size[1] as f64], Interp::Bicubic),
        }
    }

    /// The source a placement change renders from; refuses when only a stored rendering exists
    /// (an imported smart object whose source could not be read).
    pub(super) fn placement_source(&self, id: u32) -> Result<(Tiles, [u32; 2]), String> {
        let s = self.smart(id)?;
        if s.source_tiles.coords().is_empty() && !s.cache.coords().is_empty() {
            return Err(NO_SOURCE.into());
        }
        Ok((s.source_tiles.clone(), s.source_size))
    }

    /// Regenerates a smart object's cache from its source.
    pub fn render_smart(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let (src, size) = self.placement_source(id)?;
        let s = self.smart(id)?;
        let (t, warp) = (s.transform, s.warp.clone());
        let cache = self.smart_render(&src, size, &t, warp.as_ref())?;
        self.smart_node_mut(id)?.cache = cache;
        Ok(())
    }

    /// Sets a smart object's transform and warp (none = placed by the transform) and re-renders.
    pub fn set_smart_placement(&mut self, id: u32, t: &[f64; 9], warp: Option<WarpMesh>) -> Result<(), String> {
        self.check_idle()?;
        let (src, size) = self.placement_source(id)?;
        let cache = self.smart_render(&src, size, t, warp.as_ref())?;
        let s = self.smart_node_mut(id)?;
        (s.transform, s.warp, s.cache) = (*t, warp, cache);
        Ok(())
    }

    /// `set_smart_placement` with the warp as `warp_layer` JSON, empty for none.
    pub fn set_smart_placement_json(&mut self, id: u32, t: &[f64; 9], warp_json: &str) -> Result<(), String> {
        let warp = if warp_json.is_empty() { None } else { Some(warp::parse_warp(warp_json)?) };
        self.set_smart_placement(id, t, warp)
    }

    /// The placement after map `m` (source of a free transform on a smart object), or None
    /// for other kinds.
    pub(super) fn smart_moved(&self, id: u32, m: &[f64; 9]) -> Result<Option<([f64; 9], Option<WarpMesh>)>, String> {
        Ok(match &self.node(id)?.kind {
            Kind::Smart(s) => Some(moved(s, m)),
            _ => None,
        })
    }

    /// Places a new smart object above `above` (0 = on top) from straight RGBA8 source pixels.
    pub fn place_smart(&mut self, above: u32, json: &str, rgba: &[u8]) -> Result<u32, String> {
        self.check_idle()?;
        let p: PlaceIn = serde_json::from_str(json).map_err(|e| format!("invalid smart object: {e}"))?;
        self.check_blob(p.source_blob)?;
        let src = self.source_tiles(p.source_size, rgba)?;
        let cache = self.smart_render(&src, p.source_size, &p.transform, None)?;
        let kind = Kind::Smart(Box::new(Smart {
            link: p.link,
            source_blob: p.source_blob,
            source_tiles: src,
            source_size: p.source_size,
            transform: p.transform,
            warp: None,
            filters: Vec::new(),
            stack_mask: None,
            stack_mode: None,
            cache,
        }));
        self.add_node(&p.name, above, kind)
    }

    /// Stores source pixels (straight RGBA8 of the source size) without touching the cache.
    pub fn load_smart_source(&mut self, id: u32, rgba: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        let size = self.smart(id)?.source_size;
        let src = self.source_tiles(size, rgba)?;
        self.smart_node_mut(id)?.source_tiles = src;
        Ok(())
    }

    /// Duplicates a smart object above itself; an embedded copy gets link id `link_id`, so it
    /// no longer shares its source.
    pub fn smart_via_copy(&mut self, id: u32, link_id: &str) -> Result<u32, String> {
        self.check_idle()?;
        self.smart(id)?;
        if link_id.is_empty() {
            return Err("a smart object link id must not be empty".into());
        }
        let copy = self.duplicate_node(id)?;
        let s = self.node_mut(copy)?.smart_mut();
        if let Link::Embedded { id } = &mut s.link {
            *id = link_id.to_string();
        }
        Ok(copy)
    }

    /// Turns a smart object into a pixel layer holding its cache, keeping its id.
    pub fn rasterize_smart(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let cache = self.smart(id)?.cache.clone();
        self.node_mut(id)?.kind = Kind::Pixel(cache);
        Ok(())
    }

    /// Replaces the source (Replace Contents, Relink): the transform is rescaled so the
    /// placement keeps its on-canvas corners; the link changes only when `json` names one.
    pub fn replace_smart_contents(&mut self, id: u32, json: &str, rgba: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        let r: ReplaceIn = serde_json::from_str(json).map_err(|e| format!("invalid smart object source: {e}"))?;
        self.check_blob(r.source_blob)?;
        let s = self.smart(id)?;
        let (old, t, warp) = (s.source_size, s.transform, s.warp.clone());
        let src = self.source_tiles(r.source_size, rgba)?;
        let fit = [
            old[0] as f64 / r.source_size[0] as f64, 0.0, 0.0,
            0.0, old[1] as f64 / r.source_size[1] as f64, 0.0,
            0.0, 0.0, 1.0,
        ];
        let t = snap(mul3(&t, &fit));
        let cache = self.smart_render(&src, r.source_size, &t, warp.as_ref())?;
        let s = self.smart_node_mut(id)?;
        if let Some(link) = r.link {
            s.link = link;
        }
        (s.source_blob, s.source_tiles, s.source_size, s.transform, s.cache) = (r.source_blob, src, r.source_size, t, cache);
        Ok(())
    }

    /// Edit Contents write-back: every smart object sharing `id`'s link gets the new source and
    /// re-renders through its unchanged transform and warp. Returns the updated ids.
    pub fn update_smart_source(&mut self, id: u32, json: &str, rgba: &[u8]) -> Result<Vec<u32>, String> {
        self.check_idle()?;
        let r: ReplaceIn = serde_json::from_str(json).map_err(|e| format!("invalid smart object source: {e}"))?;
        if r.link.is_some() {
            return Err("an update keeps the link".into());
        }
        self.check_blob(r.source_blob)?;
        let link = self.smart(id)?.link.clone();
        let src = self.source_tiles(r.source_size, rgba)?;
        fn walk(nodes: &[Node], link: &Link, out: &mut Vec<u32>) {
            for n in nodes {
                match &n.kind {
                    Kind::Smart(s) if s.link == *link => out.push(n.id),
                    Kind::Group(ch) => walk(ch, link, out),
                    _ => {}
                }
            }
        }
        let mut ids = Vec::new();
        walk(&self.nodes, &link, &mut ids);
        let mut caches = Vec::with_capacity(ids.len());
        for &n in &ids {
            let s = self.smart(n)?;
            let (t, warp) = (s.transform, s.warp.clone());
            caches.push(self.smart_render(&src, r.source_size, &t, warp.as_ref())?);
        }
        for (&n, cache) in ids.iter().zip(caches) {
            let s = self.smart_node_mut(n)?;
            (s.source_blob, s.source_tiles, s.source_size, s.cache) = (r.source_blob, src.clone(), r.source_size, cache);
        }
        Ok(ids)
    }

    /// Convert to Linked / Embedded: sets the link and the stored source bytes.
    pub fn set_smart_link(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let l: LinkIn = serde_json::from_str(json).map_err(|e| format!("invalid smart object link: {e}"))?;
        self.check_blob(l.source_blob)?;
        let s = self.smart_node_mut(id)?;
        (s.link, s.source_blob) = (l.link, l.source_blob);
        Ok(())
    }

    /// Stored and round-tripped only (D11); JSON `null` clears it.
    pub fn set_stack_mode(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let mode: Option<StackMode> = serde_json::from_str(json).map_err(|e| format!("invalid stack mode: {e}"))?;
        self.smart_node_mut(id)?.stack_mode = mode;
        Ok(())
    }

    // Content bounds for Convert to Smart Object; adjustment and fill layers cover the canvas.
    fn content_bounds(&self, n: &Node) -> Option<[i32; 4]> {
        match &n.kind {
            Kind::Pixel(t) => tiles_bounds(t),
            Kind::Smart(s) => tiles_bounds(&s.cache),
            Kind::Adjustment(_) | Kind::Fill(_) => Some([0, 0, self.width as i32, self.height as i32]),
            Kind::Group(ch) => ch.iter().filter_map(|c| self.content_bounds(c)).reduce(|a, b| {
                let (x0, y0) = (a[0].min(b[0]), a[1].min(b[1]));
                [x0, y0, (a[0] + a[2]).max(b[0] + b[2]) - x0, (a[1] + a[3]).max(b[1] + b[3]) - y0]
            }),
        }
    }

    // Paths of `ids` sharing one parent, ascending.
    fn sibling_paths(&self, ids: &[u32]) -> Result<Vec<Vec<usize>>, String> {
        if ids.is_empty() {
            return Err("Select a layer to convert.".into());
        }
        let mut seen = HashSet::new();
        let mut paths = Vec::with_capacity(ids.len());
        for &id in ids {
            if !seen.insert(id) {
                return Err(format!("node {id} listed twice"));
            }
            paths.push(self.find_path(id)?);
        }
        let parent = &paths[0][..paths[0].len() - 1];
        if paths.iter().any(|p| p[..p.len() - 1] != *parent) {
            return Err("Select layers at the same level to convert them.".into());
        }
        paths.sort();
        Ok(paths)
    }

    /// A new document at the union bounds of `ids` (siblings; min 1x1, same depth) holding deep
    /// copies of them moved by minus the bounds origin, and those bounds.
    pub fn extract_document(&self, ids: &[u32]) -> Result<(Document, [i32; 4]), String> {
        self.check_idle()?;
        let paths = self.sibling_paths(ids)?;
        let nodes: Vec<Node> = paths.iter().map(|p| node_at(&self.nodes, p).clone()).collect();
        let b = nodes.iter().filter_map(|n| self.content_bounds(n)).reduce(|a, b| {
            let (x0, y0) = (a[0].min(b[0]), a[1].min(b[1]));
            [x0, y0, (a[0] + a[2]).max(b[0] + b[2]) - x0, (a[1] + a[3]).max(b[1] + b[3]) - y0]
        });
        let b = b.unwrap_or([0, 0, 1, 1]);
        let mut sub = self.clone();
        sub.nodes = nodes;
        (sub.selection, sub.last_selection) = (None, None);
        sub.channels.clear();
        sub.layer_comps.clear();
        sub.apply_crop(b.map(|v| v as f64), false)?;
        Ok((sub, b))
    }

    /// Convert to Smart Object: the sibling layers `ids` move into a source at their union
    /// bounds; the new smart object takes their place at the lowest index. `json` carries the
    /// name, the embedded link id and the source bytes blob (a PSB of `extract_document`).
    pub fn convert_to_smart(&mut self, ids: &[u32], json: &str) -> Result<u32, String> {
        self.check_idle()?;
        let c: ConvertIn = serde_json::from_str(json).map_err(|e| format!("invalid smart object: {e}"))?;
        if c.link_id.is_empty() {
            return Err("a smart object link id must not be empty".into());
        }
        self.check_blob(c.source_blob)?;
        let (sub, b) = self.extract_document(ids)?;
        let size = [b[2] as u32, b[3] as u32];
        let mut src = Tiles::default();
        let mut buf = vec![0f32; TILE_PIXELS * 4];
        for ty in 0..sub.tiles_y() {
            for tx in 0..sub.tiles_x() {
                let premul = sub.composite_tile_premul(tx, ty);
                for (o, p) in buf.chunks_exact_mut(4).zip(premul.chunks_exact(4)) {
                    let a = p[3];
                    o.copy_from_slice(&if a > 0.0 { [p[0] / a, p[1] / a, p[2] / a, a] } else { [0.0; 4] });
                }
                let px = Pixels::from_straight(self.depth, &buf);
                if px.any_alpha() {
                    src.put(tx as i32, ty as i32, Some(Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
                }
            }
        }
        let t = translate(b[0] as f64, b[1] as f64);
        let cache = self.smart_render(&src, size, &t, None)?;
        let paths = self.sibling_paths(ids)?;
        let prefix = paths[0][..paths[0].len() - 1].to_vec();
        let idx: Vec<usize> = paths.iter().map(|p| *p.last().expect("a path")).collect();
        let id = self.alloc_node_id();
        let mut node = Node::new(id, &c.name, Kind::Smart(Box::new(Smart {
            link: Link::Embedded { id: c.link_id },
            source_blob: c.source_blob,
            source_tiles: src,
            source_size: size,
            transform: t,
            warp: None,
            filters: Vec::new(),
            stack_mask: None,
            stack_mode: None,
            cache,
        })));
        let list = list_mut(&mut self.nodes, &prefix);
        node.blending = list[*idx.last().expect("one id")].blending.clone();
        for &i in idx.iter().rev() {
            list.remove(i);
        }
        list.insert(idx[0], node);
        Ok(id)
    }
}

#[cfg(test)]
mod tests {
    use super::super::transform::tests::{get_px, put_px};
    use super::*;
    use serde_json::json;

    const ID: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

    // Deterministic opaque noise, w x h straight RGBA8.
    fn noise(w: usize, h: usize, seed: u32) -> Vec<u8> {
        let mut s = seed;
        (0..w * h * 4)
            .map(|i| {
                s = s.wrapping_mul(1664525).wrapping_add(1013904223);
                if i % 4 == 3 { 255 } else { (s >> 24) as u8 }
            })
            .collect()
    }

    fn place(d: &mut Document, w: u32, h: u32, t: [f64; 9], link: &str) -> u32 {
        let j = json!({ "name": "Placed", "link": { "type": "embedded", "id": link }, "source_blob": null, "source_size": [w, h], "transform": t });
        d.place_smart(0, &j.to_string(), &noise(w as usize, h as usize, w + h)).unwrap()
    }

    fn smart_of(d: &Document, id: u32) -> &Smart {
        d.smart(id).unwrap()
    }

    // Straight RGBA8 of the source tiles over the source rect.
    fn source_grid(d: &Document, id: u32) -> Vec<[u8; 4]> {
        let s = smart_of(d, id);
        let mut v = Vec::new();
        for y in 0..s.source_size[1] as i32 {
            for x in 0..s.source_size[0] as i32 {
                let p = (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize;
                let t = s.source_tiles.get(x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
                v.push(t.map_or([0; 4], |t| t.px.rgba_f32(p).map(|c| (c * 255.0).round() as u8)));
            }
        }
        v
    }

    fn grid(d: &Document, id: u32, r: [i32; 4]) -> Vec<[u8; 4]> {
        (r[1]..r[1] + r[3]).flat_map(|y| (r[0]..r[0] + r[2]).map(move |x| (x, y))).map(|(x, y)| get_px(d, id, x, y)).collect()
    }

    fn corners(s: &Smart) -> Vec<(f64, f64)> {
        let (w, h) = (s.source_size[0] as f64, s.source_size[1] as f64);
        [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)].iter().map(|&(x, y)| apply(&s.transform, x, y).unwrap()).collect()
    }

    #[test]
    fn scale_to_ten_percent_and_back_returns_the_source_tiles_exactly() {
        let mut d = Document::new(300, 200, 8).unwrap();
        let id = place(&mut d, 180, 120, ID, "a");
        assert_eq!(grid(&d, id, [0, 0, 180, 120]), source_grid(&d, id), "an identity placement is the source");
        let about = |f: f64| [f, 0.0, 90.0 * (1.0 - f), 0.0, f, 60.0 * (1.0 - f), 0.0, 0.0, 1.0];
        d.transform_layer(id, &about(0.1), Interp::Bicubic).unwrap();
        assert_eq!(d.layer_bounds(id).unwrap(), Some([81, 54, 18, 12]));
        d.transform_layer(id, &about(10.0), Interp::Bicubic).unwrap();
        assert_eq!(smart_of(&d, id).transform, ID);
        let s = smart_of(&d, id);
        assert_eq!(s.cache.coords(), s.source_tiles.coords());
        for (tx, ty) in s.cache.coords() {
            assert_eq!(s.cache.get(tx, ty).unwrap().px.to_bytes(), s.source_tiles.get(tx, ty).unwrap().px.to_bytes(), "tile {tx},{ty}");
        }
    }

    #[test]
    fn a_placement_renders_bicubic_with_a_box_prefilter_when_minifying() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 40, 40, [0.5, 0.0, 10.0, 0.0, 0.5, 10.0, 0.0, 0.0, 1.0], "a");
        assert_eq!(d.layer_bounds(id).unwrap(), Some([10, 10, 20, 20]));
        // The same source through the resampler directly gives the same cache.
        let s = smart_of(&d, id).clone();
        let plane = d.rgba_plane(&s.source_tiles, [0, 0, 40, 40], None);
        let rs = Resampler::new(plane, &s.transform, Interp::Bicubic, 0.0).unwrap();
        let want = d.render_tiles(&rs, None, None).unwrap();
        assert_eq!(want.get(0, 0).unwrap().px.to_bytes(), s.cache.get(0, 0).unwrap().px.to_bytes());
    }

    #[test]
    fn a_render_over_the_pixel_limit_is_refused_and_changes_nothing() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 10, 10, ID, "a");
        let before = grid(&d, id, [0, 0, 12, 12]);
        let big = [2000.0, 0.0, 0.0, 0.0, 2000.0, 0.0, 0.0, 0.0, 1.0];
        assert_eq!(d.transform_layer(id, &big, Interp::Bicubic).unwrap_err(), "transform result is too large");
        assert_eq!(smart_of(&d, id).transform, ID);
        assert_eq!(grid(&d, id, [0, 0, 12, 12]), before);
        let j = json!({ "name": "x", "link": { "type": "embedded", "id": "b" }, "source_blob": null, "source_size": [20000, 20000], "transform": ID });
        assert_eq!(d.place_smart(0, &j.to_string(), &[]).unwrap_err(), "the smart object source is too large");
    }

    #[test]
    fn replace_keeps_the_corners_and_refuses_an_empty_source() {
        let mut d = Document::new(200, 200, 8).unwrap();
        let t = [0.8, 0.3, 20.0, -0.2, 0.9, 40.0, 0.0, 0.0, 1.0];
        let id = place(&mut d, 60, 30, t, "a");
        let before = corners(smart_of(&d, id));
        let j = json!({ "source_blob": null, "source_size": [90, 120] });
        d.replace_smart_contents(id, &j.to_string(), &noise(90, 120, 3)).unwrap();
        let s = smart_of(&d, id);
        assert_eq!(s.source_size, [90, 120]);
        for (a, b) in before.iter().zip(corners(s)) {
            assert!((a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9, "{a:?} vs {b:?}");
        }
        assert_eq!(s.link, Link::Embedded { id: "a".into() }, "the link stays unless a new one is given");
        let empty = json!({ "source_blob": null, "source_size": [0, 10] });
        assert_eq!(d.replace_smart_contents(id, &empty.to_string(), &[]).unwrap_err(), "That file has no pixels to place.");
        let relink = json!({ "link": { "type": "linked", "name": "b.png", "handle": "h" }, "source_blob": null, "source_size": [4, 4] });
        d.replace_smart_contents(id, &relink.to_string(), &noise(4, 4, 1)).unwrap();
        assert_eq!(smart_of(&d, id).link, Link::Linked { name: "b.png".into(), handle: "h".into() });
    }

    #[test]
    fn update_of_a_shared_source_updates_both_layers_and_keeps_the_transform() {
        let mut d = Document::new(200, 200, 8).unwrap();
        let a = place(&mut d, 20, 20, translate(10.0, 10.0), "shared");
        let b = d.duplicate_node(a).unwrap();
        d.offset_layer(b, 50, 0).unwrap();
        let other = place(&mut d, 20, 20, translate(100.0, 100.0), "other");
        let other_cache = smart_of(&d, other).cache.out();
        let red: Vec<u8> = [255, 0, 0, 255].repeat(30 * 10);
        let ids = d.update_smart_source(a, &json!({ "source_blob": null, "source_size": [30, 10] }).to_string(), &red).unwrap();
        assert_eq!(ids, vec![a, b]);
        assert_eq!(smart_of(&d, a).transform, translate(10.0, 10.0), "the transform stays unscaled");
        assert_eq!(smart_of(&d, b).transform, translate(60.0, 10.0));
        assert_eq!(d.layer_bounds(a).unwrap(), Some([10, 10, 30, 10]));
        assert_eq!(d.layer_bounds(b).unwrap(), Some([60, 10, 30, 10]));
        assert_eq!(get_px(&d, b, 75, 15), [255, 0, 0, 255]);
        assert_eq!(smart_of(&d, other).cache.out(), other_cache, "another source is untouched");
    }

    #[test]
    fn convert_then_rasterize_equals_the_flattened_originals() {
        let mut d = Document::new(300, 280, 8).unwrap();
        d.fill(1, Target::Pixels, 20, 40, 60, 255).unwrap();
        let a = d.add_layer("A", 1).unwrap();
        let b = d.add_layer("B", a).unwrap();
        let top = d.add_layer("Top", b).unwrap();
        for y in 0..40 {
            for x in 0..30 {
                put_px(&mut d, a, 250 + x, 230 + y, [(x * 8) as u8, (y * 6) as u8, 7, 255]);
                put_px(&mut d, b, 240 + y, 245 + x, [9, (x * 5) as u8, (y * 3) as u8, 255]);
            }
        }
        put_px(&mut d, top, 5, 5, [1, 2, 3, 255]);
        d.set_blending(b, &json!({
            "blend_if": { "gray": { "source": [0, 0, 255, 255], "destination": [0, 0, 255, 255] },
              "red": { "source": [0, 0, 255, 255], "destination": [0, 0, 255, 255] },
              "green": { "source": [0, 0, 255, 255], "destination": [0, 0, 255, 255] },
              "blue": { "source": [0, 0, 255, 255], "destination": [0, 0, 255, 255] } },
            "channels": [true, true, true], "knockout": "none", "blend_interior": true, "blend_clipped": true,
            "transparency_shapes": true, "layer_mask_hides_effects": false, "vector_mask_hides_effects": false
        }).to_string()).unwrap();
        let flat = |d: &Document| (0..2).flat_map(|ty| (0..2).map(move |tx| (tx, ty))).map(|(tx, ty)| d.flatten_tile_rgba8(tx, ty).unwrap()).collect::<Vec<_>>();
        let before = flat(&d);
        let blob = d.blob_add(b"8BPS").unwrap();
        let s = d.convert_to_smart(&[b, a], &json!({ "name": "Group", "link_id": "l1", "source_blob": blob }).to_string()).unwrap();
        let ids: Vec<u32> = d.nodes.iter().map(|n| n.id).collect();
        assert_eq!(ids, vec![1, s, top], "inserted at the first original's index");
        let sm = smart_of(&d, s);
        assert_eq!(sm.source_size, [40, 45]);
        assert_eq!(sm.transform, translate(240.0, 230.0));
        assert!(d.node(s).unwrap().blending.blend_interior, "the top layer's blending");
        assert_eq!(d.node(s).unwrap().name, "Group");
        assert_eq!(flat(&d), before, "the smart object renders like the originals");
        d.rasterize_smart(s).unwrap();
        assert!(matches!(d.node(s).unwrap().kind, Kind::Pixel(_)), "same id, now pixels");
        assert_eq!(flat(&d), before);
    }

    #[test]
    fn extract_document_moves_copies_to_the_bounds_origin() {
        let mut d = Document::new(100, 100, 8).unwrap();
        let a = d.add_layer("A", 1).unwrap();
        put_px(&mut d, a, 30, 40, [9, 9, 9, 255]);
        put_px(&mut d, a, 32, 41, [8, 8, 8, 255]);
        let (sub, b) = d.extract_document(&[a]).unwrap();
        assert_eq!(b, [30, 40, 3, 2]);
        assert_eq!((sub.width(), sub.height()), (3, 2));
        assert_eq!(sub.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![a]);
        assert_eq!(get_px(&sub, a, 0, 0), [9, 9, 9, 255]);
        assert_eq!(get_px(&sub, a, 2, 1), [8, 8, 8, 255]);
        let empty = d.add_layer("E", a).unwrap();
        assert_eq!(d.extract_document(&[empty]).unwrap().1, [0, 0, 1, 1], "min 1x1");
        let g = d.add_group("G", empty).unwrap();
        let inner = d.add_layer("I", 0).unwrap();
        d.move_node(inner, g, 0).unwrap();
        assert_eq!(d.extract_document(&[]).err().unwrap(), "Select a layer to convert.");
        assert_eq!(d.extract_document(&[a, inner]).err().unwrap(), "Select layers at the same level to convert them.");
    }

    #[test]
    fn via_copy_gets_a_new_embedded_id_and_a_linked_copy_keeps_its_link() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 8, 8, ID, "a");
        let copy = d.smart_via_copy(id, "b").unwrap();
        assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![1, id, copy]);
        assert_eq!(smart_of(&d, copy).link, Link::Embedded { id: "b".into() });
        assert_eq!(smart_of(&d, id).link, Link::Embedded { id: "a".into() });
        assert_eq!(d.node(copy).unwrap().name, "Placed copy");
        d.set_smart_link(id, &json!({ "link": { "type": "linked", "name": "x.psd", "handle": "h1" }, "source_blob": null }).to_string()).unwrap();
        let linked = d.smart_via_copy(id, "c").unwrap();
        assert_eq!(smart_of(&d, linked).link, Link::Linked { name: "x.psd".into(), handle: "h1".into() });
        assert!(d.smart_via_copy(1, "d").unwrap_err().contains("not a smart object"));
        assert!(d.set_smart_link(id, &json!({ "link": { "type": "embedded", "id": "e" }, "source_blob": 999 }).to_string()).is_err());
    }

    #[test]
    fn stack_mode_is_stored_and_cleared() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 8, 8, ID, "a");
        d.set_stack_mode(id, "\"median\"").unwrap();
        assert_eq!(smart_of(&d, id).stack_mode, Some(StackMode::Median));
        d.set_stack_mode(id, "null").unwrap();
        assert_eq!(smart_of(&d, id).stack_mode, None);
        assert!(d.set_stack_mode(id, "\"average\"").is_err());
    }

    fn mesh_json(w: f64, h: f64, f: impl Fn(f64, f64) -> (f64, f64)) -> String {
        let pts: Vec<[f64; 2]> = (0..16).map(|k| {
            let (x, y) = f((k % 4) as f64 / 3.0 * w, (k / 4) as f64 / 3.0 * h);
            [x, y]
        }).collect();
        json!({ "cols": 1, "rows": 1, "points": pts, "columnStops": [0.0, 1.0], "rowStops": [0.0, 1.0] }).to_string()
    }

    #[test]
    fn a_warp_is_stored_over_the_source_and_moves_with_later_transforms() {
        let mut d = Document::new(128, 128, 8).unwrap();
        let id = place(&mut d, 20, 10, translate(5.0, 5.0), "a");
        let before = grid(&d, id, [0, 0, 64, 64]);
        // A translate by (7, 3) as a mesh over the source.
        d.warp_layer(id, &mesh_json(20.0, 10.0, |x, y| (x + 12.0, y + 8.0)), Interp::Bicubic).unwrap();
        let s = smart_of(&d, id);
        assert!(s.warp.is_some());
        assert_eq!(s.transform, translate(5.0, 5.0), "the transform stays");
        assert_eq!(d.layer_bounds(id).unwrap(), Some([12, 8, 20, 10]));
        assert_eq!(grid(&d, id, [14, 10, 16, 6]), grid_of(&before, 64, [7, 7, 16, 6]));
        d.transform_layer(id, &translate(10.0, 0.0), Interp::Bicubic).unwrap();
        let s = smart_of(&d, id);
        assert_eq!(s.transform, translate(15.0, 5.0));
        assert_eq!(s.warp.as_ref().unwrap().points[0], [22.0, 8.0]);
        assert_eq!(d.layer_bounds(id).unwrap(), Some([22, 8, 20, 10]));
        d.set_smart_placement(id, &translate(15.0, 5.0), None).unwrap();
        assert_eq!(d.layer_bounds(id).unwrap(), Some([15, 5, 20, 10]));
    }

    fn grid_of(all: &[[u8; 4]], w: i32, r: [i32; 4]) -> Vec<[u8; 4]> {
        (r[1]..r[1] + r[3]).flat_map(|y| (r[0]..r[0] + r[2]).map(move |x| all[(y * w + x) as usize])).collect()
    }

    #[test]
    fn move_rotate_and_canvas_ops_keep_the_placement_in_step_with_the_cache() {
        let mut d = Document::new(128, 128, 8).unwrap();
        let id = place(&mut d, 6, 4, translate(10.0, 20.0), "a");
        d.offset_layer(id, 3, -2).unwrap();
        assert_eq!(smart_of(&d, id).transform, translate(13.0, 18.0));
        let moved = grid(&d, id, [13, 18, 6, 4]);
        d.render_smart(id).unwrap();
        assert_eq!(grid(&d, id, [13, 18, 6, 4]), moved);
        d.rotate_layer_exact(id, Remap::Cw).unwrap();
        assert_eq!(d.layer_bounds(id).unwrap(), Some([14, 17, 4, 6]));
        let turned = grid(&d, id, [14, 17, 4, 6]);
        d.render_smart(id).unwrap();
        assert_eq!(grid(&d, id, [14, 17, 4, 6]), turned);
        // The top-left source pixel lands at the top-right after a clockwise turn.
        assert_eq!(get_px(&d, id, 17, 17), grid_of(&moved, 6, [0, 0, 1, 1])[0]);
        d.apply_crop([4.0, 7.0, 100.0, 100.0], false).unwrap();
        let cropped = grid(&d, id, [10, 10, 4, 6]);
        assert_eq!(cropped, turned);
        d.render_smart(id).unwrap();
        assert_eq!(grid(&d, id, [10, 10, 4, 6]), cropped);
    }

    #[test]
    fn a_smart_op_is_one_snapshot_step_and_loads_back() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 8, 8, translate(3.0, 3.0), "a");
        let m = d.manifest();
        let mut e = Document::from_manifest(&m).unwrap();
        let ids: Vec<u64> = e.loading.as_ref().unwrap().pending_ids.iter().copied().collect();
        for t in ids {
            e.put_tile(t, &d.tile_bytes(t).unwrap()).unwrap();
        }
        e.finish_load().unwrap();
        assert_eq!(e.manifest(), m);
        e.render_smart(id).unwrap();
        assert_eq!(grid(&e, id, [0, 0, 16, 16]), grid(&d, id, [0, 0, 16, 16]), "a loaded source re-renders the same cache");
        let mut core = EngineCore::new(d);
        let snap = core.snapshot();
        core.doc.transform_layer(id, &translate(1.5, 0.0), Interp::Bicubic).unwrap();
        assert_ne!(core.doc.manifest(), m);
        core.restore(snap).unwrap();
        let mut a: serde_json::Value = serde_json::from_str(&core.doc.manifest()).unwrap();
        let mut b: serde_json::Value = serde_json::from_str(&m).unwrap();
        a.as_object_mut().unwrap().remove("next_id");
        b.as_object_mut().unwrap().remove("next_id");
        assert_eq!(a, b);
    }

    #[test]
    fn load_smart_source_keeps_the_cache() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let j = json!({ "name": "Placed", "smart": { "link": { "type": "embedded", "id": "x" }, "source_blob": null, "source_size": [4, 4], "transform": ID } });
        let id = d.add_special(0, &j.to_string()).unwrap();
        d.load_smart_source(id, &noise(4, 4, 9)).unwrap();
        assert!(smart_of(&d, id).cache.coords().is_empty());
        assert_eq!(source_grid(&d, id)[0], [noise(4, 4, 9)[0], noise(4, 4, 9)[1], noise(4, 4, 9)[2], 255]);
        assert!(d.load_smart_source(id, &[0; 12]).is_err());
    }

    #[test]
    fn a_placement_change_without_a_source_keeps_the_stored_rendering() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let j = json!({ "name": "Imported", "smart": { "link": { "type": "embedded", "id": "x" }, "source_blob": null, "source_size": [4, 4], "transform": ID } });
        let id = d.add_special(0, &j.to_string()).unwrap();
        put_px(&mut d, id, 1, 1, [9, 9, 9, 255]);
        let msg = "This Smart Object has no source pixels; use Replace Contents first.";
        assert_eq!(d.transform_layer(id, &translate(2.0, 0.0), Interp::Bicubic).unwrap_err(), msg);
        assert_eq!(d.render_smart(id).unwrap_err(), msg);
        assert_eq!(get_px(&d, id, 1, 1), [9, 9, 9, 255]);
        d.offset_layer(id, 1, 0).unwrap();
        assert_eq!(get_px(&d, id, 2, 1), [9, 9, 9, 255], "an exact move needs no source");
    }
}
