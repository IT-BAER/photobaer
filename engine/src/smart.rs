//! Smart objects (docs/M3.md section 6): the cache is always rendered from the source tiles,
//! through the placement transform or, when set, the warp mesh (whose parameter square spans
//! the source rect). A child module of `doc`, so it reaches the document's private tile storage.

use super::canvas::mul3;
use super::transform::{check_area, tile_rect};
use super::*;
use crate::resample::{Interp, Resampler};

const EMPTY: &str = "That file has no pixels to place.";
const NO_SOURCE: &str = "This Smart Object has no source pixels; use Replace Contents first.";
const GONE: &str = "That smart filter is no longer in the stack.";
const NO_MASK: &str = "The selected smart filters have no filter mask.";

fn filter_at(filters: &mut [SmartFilter], fid: u32) -> Result<&mut SmartFilter, String> {
    filters.iter_mut().find(|f| f.id == fid).ok_or_else(|| GONE.to_string())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilterPatch {
    #[serde(default)]
    filter: Option<Filter>,
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    opacity: Option<f32>,
    #[serde(default)]
    blend: Option<Blend>,
    #[serde(default)]
    psd: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForFiltersIn {
    link_id: String,
    source_blob: Option<u64>,
}
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
fn union(a: [i32; 4], b: [i32; 4]) -> [i32; 4] {
    let (x, y) = (a[0].min(b[0]), a[1].min(b[1]));
    [x, y, (a[0] + a[2]).max(b[0] + b[2]) - x, (a[1] + a[3]).max(b[1] + b[3]) - y]
}

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

    /// `base` (an unfiltered cache) through the enabled filters bottom to top, over its tile rect
    /// grown by the blur reach: each result mixes onto its input by opacity x filter mask x stack
    /// mask in the filter's mode (disabled masks count as 1). No enabled filter returns `base`.
    pub(super) fn filtered(&mut self, base: Tiles, filters: &[SmartFilter], stack: Option<&Mask>, layer: Option<&Mask>) -> Result<Tiles, String> {
        let on: Vec<&SmartFilter> = filters.iter().filter(|f| f.enabled).collect();
        let Some(b) = tile_rect(&base).filter(|_| !on.is_empty()) else { return Ok(base) };
        // The plane grows by each reach from `b`; a warp adds where it can move the content (`t`).
        let tight = tiles_bounds(&base).unwrap_or(b);
        let (mut r, mut t) = (b, tight);
        for f in &on {
            let n = f.filter.extent(t)?;
            r = if f.filter.spec()?.extent.is_some() { union(r, n) } else { f.filter.extent(r)? };
            t = n;
        }
        check_area(r)?;
        let (w, h) = (r[2] as usize, r[3] as usize);
        // Premultiplied RGBA.
        let mut px = self.rgba_plane(&base, r, None).data;
        let plane = |m: Option<&Mask>| m.filter(|m| m.enabled).map(|m| self.mask_plane(&m.tiles, m.default, r).data);
        let stack = plane(stack);
        // The filter context matches a destructive apply: tight bounds and the layer mask.
        let lmask = layer.map(|m| self.mask_plane(&m.tiles, m.default, r).data);
        let lm_default = layer.map_or(0.0, |m| m.default as f32 / self.max());
        let mask_at = lmask.as_ref().map(|m| {
            move |x: i32, y: i32| {
                let (lx, ly) = (x - r[0], y - r[1]);
                if lx < 0 || ly < 0 || lx >= r[2] || ly >= r[3] { lm_default } else { m[ly as usize * w + lx as usize] }
            }
        });
        // 32-bit: results keep color above 1 and blend in the 32-bit modes.
        let hdr = self.depth == 32;
        let mix = |m: Blend, cb: [f32; 3], cs: [f32; 3]| if hdr { blend_hdr(m, cb, cs) } else { blend_rgb(m, cb, cs) };
        for f in on {
            let own = plane(f.mask.as_ref());
            let weight = |i: usize| f.opacity * own.as_ref().map_or(1.0, |m| m[i]) * stack.as_ref().map_or(1.0, |m| m[i]);
            let spec = f.filter.spec()?;
            if !spec.adjustment {
                let mut plane = filters::Plane { x: r[0], y: r[1], w, h, data: px.clone() };
                plane.unpremultiply();
                filters::apply(&f.filter, &mut plane, &filters::Ctx { blobs: &self.blobs, cov: None, bounds: tight, scale: 1.0, mask: mask_at.as_ref().map(|f| f as &dyn Fn(i32, i32) -> f32) })?;
                for i in 0..w * h {
                    let a = weight(i);
                    if a <= 0.0 {
                        continue;
                    }
                    let old: [f32; 4] = px[i * 4..i * 4 + 4].try_into().expect("4 channels");
                    let n = &plane.data[i * 4..i * 4 + 4];
                    let na = if spec.keep_alpha { old[3] } else { n[3].clamp(0.0, 1.0) };
                    let nc: [f32; 3] = std::array::from_fn(|c| if hdr { n[c].max(0.0) } else { n[c].clamp(0.0, 1.0) });
                    let src = if f.blend == Blend::Normal || na <= 0.0 || old[3] <= 0.0 {
                        [nc[0] * na, nc[1] * na, nc[2] * na, na]
                    } else {
                        let un = [old[0] / old[3], old[1] / old[3], old[2] / old[3]];
                        let c = mix(f.blend, un, nc);
                        [c[0] * na, c[1] * na, c[2] * na, na]
                    };
                    for c in 0..4 {
                        px[i * 4 + c] = old[c] + (src[c] - old[c]) * a;
                    }
                }
                continue;
            }
            let adj = f.filter.adjustment().expect("every other filter is an adjustment");
            let Some(k) = adj.compile(&self.blobs, self.depth == 32)? else { continue };
            for i in 0..w * h {
                let (a, alpha) = (weight(i), px[i * 4 + 3]);
                if a <= 0.0 || alpha <= 0.0 {
                    continue;
                }
                let rgb = [px[i * 4] / alpha, px[i * 4 + 1] / alpha, px[i * 4 + 2] / alpha];
                let (x, y) = (r[0] + (i % w) as i32, r[1] + (i / w) as i32);
                let nw = mix(f.blend, rgb, adjust::apply(k.opcode, &k.data, rgb, x as u32, y as u32));
                for c in 0..3 {
                    px[i * 4 + c] = (rgb[c] + (nw[c] - rgb[c]) * a) * alpha;
                }
            }
        }
        self.render_tiles_with(r, None, false, |ox, oy, buf| {
            buf.fill(0.0);
            let mut hit = false;
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32 - r[0], oy + (p / TILE) as i32 - r[1]);
                if x < 0 || y < 0 || x >= r[2] || y >= r[3] {
                    continue;
                }
                let s = &px[(y as usize * w + x as usize) * 4..][..4];
                if s[3] > 0.0 {
                    buf[p * 4..p * 4 + 4].copy_from_slice(&[s[0] / s[3], s[1] / s[3], s[2] / s[3], s[3]]);
                    hit = true;
                }
            }
            hit
        })
    }

    /// `smart_render` through smart object `id`'s filter stack.
    pub(super) fn smart_cache(&mut self, id: u32, src: &Tiles, size: [u32; 2], t: &[f64; 9], warp: Option<&WarpMesh>) -> Result<Tiles, String> {
        let base = self.smart_render(src, size, t, warp)?;
        let s = self.smart(id)?;
        let (filters, stack) = (s.filters.clone(), s.stack_mask.clone());
        let layer = self.node(id)?.mask.clone();
        self.filtered(base, &filters, stack.as_ref(), layer.as_ref())
    }

    // Edits a copy of the filter stack and stack mask with `f`, then re-renders the whole stack
    // from the source; nothing changes when either step fails.
    fn edit_filters<R>(&mut self, id: u32, f: impl FnOnce(&mut Vec<SmartFilter>, &mut Option<Mask>) -> Result<R, String>) -> Result<R, String> {
        self.check_idle()?;
        let (src, size) = self.placement_source(id)?;
        let s = self.smart(id)?;
        let (t, warp, mut filters, mut stack) = (s.transform, s.warp.clone(), s.filters.clone(), s.stack_mask.clone());
        let out = f(&mut filters, &mut stack)?;
        let base = self.smart_render(&src, size, &t, warp.as_ref())?;
        let layer = self.node(id)?.mask.clone();
        let cache = self.filtered(base, &filters, stack.as_ref(), layer.as_ref())?;
        let s = self.smart_node_mut(id)?;
        (s.filters, s.stack_mask, s.cache) = (filters, stack, cache);
        Ok(out)
    }

    // Appends an enabled normal filter at full opacity; returns its id.
    pub(super) fn push_filter(&mut self, id: u32, filter: Filter, mask: Option<Mask>, psd: Option<serde_json::Value>) -> Result<u32, String> {
        let filter = filter.normalized()?;
        self.check_blob(filter.blob())?;
        self.check_psd_value(psd.as_ref())?;
        self.edit_filters(id, |filters, _| {
            let fid = filters.iter().map(|f| f.id).max().unwrap_or(0) + 1;
            filters.push(SmartFilter { id: fid, filter, enabled: true, opacity: 1.0, blend: Blend::Normal, mask, psd });
            Ok(fid)
        })
    }

    // The PSD record's blob references must exist.
    fn check_psd_value(&self, psd: Option<&serde_json::Value>) -> Result<(), String> {
        for b in psd.map(check_psd).transpose()?.unwrap_or_default() {
            self.check_blob(Some(b))?;
        }
        Ok(())
    }

    /// Appends filter `json` (`{ kind, params, psd? }`) to smart object `id`'s stack; returns its id.
    pub fn add_smart_filter(&mut self, id: u32, json: &str) -> Result<u32, String> {
        let mut v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("invalid filter: {e}"))?;
        let psd = v.as_object_mut().and_then(|o| o.remove("psd"));
        self.push_filter(id, Filter::parse(&v.to_string())?, None, psd)
    }

    /// Applying a hosted adjustment to a smart object: a new filter masked to the selection.
    pub(super) fn apply_as_filter(&mut self, id: u32, a: &Adjustment) -> Result<(), String> {
        let mask = self.selection.as_ref().map(|s| Mask { enabled: true, default: s.default, tiles: s.tiles.clone() });
        self.push_filter(id, Filter::from_adjustment(a), mask, None).map(|_| ())
    }

    /// JSON `{ filter?, enabled?, opacity?, blend?, psd? }` for filter `fid`.
    pub fn set_smart_filter(&mut self, id: u32, fid: u32, json: &str) -> Result<(), String> {
        let mut p: FilterPatch = serde_json::from_str(json).map_err(|e| format!("invalid smart filter: {e}"))?;
        if let Some(f) = p.filter.take() {
            let f = f.normalized()?;
            self.check_blob(f.blob())?;
            p.filter = Some(f);
        }
        self.check_psd_value(p.psd.as_ref())?;
        if let Some(o) = p.opacity {
            unit(o, "filter opacity")?;
        }
        if p.blend == Some(Blend::PassThrough) {
            return Err("pass through is only allowed on groups".into());
        }
        self.edit_filters(id, |filters, _| {
            let f = filter_at(filters, fid)?;
            if let Some(v) = p.filter {
                f.filter = v;
            }
            f.enabled = p.enabled.unwrap_or(f.enabled);
            f.opacity = p.opacity.unwrap_or(f.opacity);
            f.blend = p.blend.unwrap_or(f.blend);
            if p.psd.is_some() {
                f.psd = p.psd;
            }
            Ok(())
        })
    }

    pub fn remove_smart_filter(&mut self, id: u32, fid: u32) -> Result<(), String> {
        self.edit_filters(id, |filters, _| {
            let i = filters.iter().position(|f| f.id == fid).ok_or(GONE)?;
            filters.remove(i);
            Ok(())
        })
    }

    /// Clear Smart Filters: the stack and its stack mask.
    pub fn clear_smart_filters(&mut self, id: u32) -> Result<(), String> {
        self.edit_filters(id, |filters, stack| {
            filters.clear();
            *stack = None;
            Ok(())
        })
    }

    /// Any filter enabled: all off; else all on.
    pub fn toggle_smart_filters(&mut self, id: u32) -> Result<(), String> {
        self.edit_filters(id, |filters, _| {
            if filters.is_empty() {
                return Err("This smart object has no smart filters.".into());
            }
            let on = !filters.iter().any(|f| f.enabled);
            filters.iter_mut().for_each(|f| f.enabled = on);
            Ok(())
        })
    }

    /// Adds filter `fid`'s mask, or the stack mask for `fid` 0: reveal all or hide all.
    pub fn add_filter_mask(&mut self, id: u32, fid: u32, reveal: bool) -> Result<(), String> {
        let m = Mask { enabled: true, default: if reveal { max_value(self.depth) } else { 0 }, tiles: Tiles::default() };
        self.edit_filters(id, |filters, stack| {
            let slot = if fid == 0 { stack } else { &mut filter_at(filters, fid)?.mask };
            if slot.is_some() {
                return Err("That smart filter already has a mask.".into());
            }
            *slot = Some(m);
            Ok(())
        })
    }

    /// Delete Filter Mask: the stack mask and every filter's mask.
    pub fn delete_filter_masks(&mut self, id: u32) -> Result<(), String> {
        self.edit_filters(id, |filters, stack| {
            let any = stack.take().is_some() | filters.iter_mut().fold(false, |any, f| f.mask.take().is_some() | any);
            if any { Ok(()) } else { Err(NO_MASK.into()) }
        })
    }

    /// Disable/Enable Filter Mask: any mask enabled -> all off, else all on.
    pub fn toggle_filter_masks(&mut self, id: u32) -> Result<(), String> {
        self.edit_filters(id, |filters, stack| {
            let mut masks: Vec<&mut Mask> = stack.iter_mut().chain(filters.iter_mut().filter_map(|f| f.mask.as_mut())).collect();
            if masks.is_empty() {
                return Err(NO_MASK.into());
            }
            let on = !masks.iter().any(|m| m.enabled);
            masks.iter_mut().for_each(|m| m.enabled = on);
            Ok(())
        })
    }

    // The pixels of a layer Convert for Smart Filters accepts.
    fn for_filters_pixels(&self, id: u32) -> Result<Tiles, String> {
        let n = self.node(id)?;
        match &n.kind {
            Kind::Pixel(t) => Ok(t.clone()),
            Kind::Smart(_) => Err(format!("\"{}\" is already a smart object.", n.name)),
            _ => Err(format!("Cannot convert {} layer for smart filters.", n.kind_name())),
        }
    }

    /// Pixel layer `id` alone, with default layer properties, cropped to its tight bounds (min 1x1).
    pub fn extract_layer(&self, id: u32) -> Result<Document, String> {
        self.for_filters_pixels(id)?;
        let (mut sub, _) = self.extract_document(&[id])?;
        let n = &mut sub.nodes[0];
        *n = Node::new(n.id, &n.name, std::mem::replace(&mut n.kind, Kind::Pixel(Tiles::default())));
        Ok(sub)
    }

    /// PSD import: one 8-bit tile of filter `fid`'s mask (0 = the stack mask), without a re-render.
    pub fn set_filter_mask_tile8(&mut self, id: u32, fid: u32, tx: u32, ty: u32, data: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        self.check_tile_coord(tx, ty)?;
        if data.len() != MASK_BYTES_U8 {
            return Err(format!("expected {MASK_BYTES_U8} bytes, got {}", data.len()));
        }
        let (depth, tid) = (self.depth, self.alloc_tile_id());
        let s = self.smart_node_mut(id)?;
        let m = if fid == 0 { s.stack_mask.as_mut() } else { s.filters.iter_mut().find(|f| f.id == fid).and_then(|f| f.mask.as_mut()) };
        m.ok_or(NO_MASK)?.tiles.put(tx as i32, ty as i32, Some(Tile { id: tid, px: Arc::new(Pixels::from_mask8(depth, data)) }));
        Ok(())
    }

    /// Filter > Convert for Smart Filters: pixel layer `id` becomes a smart object in place (same
    /// id and layer properties) whose source is its pixels at their tight bounds (min 1x1).
    /// `json` carries the embedded link id and the source bytes blob.
    pub fn convert_for_smart_filters(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let c: ForFiltersIn = serde_json::from_str(json).map_err(|e| format!("invalid smart object: {e}"))?;
        if c.link_id.is_empty() {
            return Err("a smart object link id must not be empty".into());
        }
        self.check_blob(c.source_blob)?;
        let pixels = self.for_filters_pixels(id)?;
        let b = tiles_bounds(&pixels).unwrap_or([0, 0, 1, 1]);
        let size = [b[2] as u32, b[3] as u32];
        check_size(size)?;
        let src = self.shift_tiles(&pixels, -b[0], -b[1], None);
        self.node_mut(id)?.kind = Kind::Smart(Box::new(Smart {
            link: Link::Embedded { id: c.link_id },
            source_blob: c.source_blob,
            source_tiles: src,
            source_size: size,
            transform: translate(b[0] as f64, b[1] as f64),
            warp: None,
            filters: Vec::new(),
            stack_mask: None,
            stack_mode: None,
            cache: pixels,
            mask_key: 0,
        }));
        Ok(())
    }

    /// Maps every filter mask and the stack mask of `id` (none for other kinds) through `f`.
    pub(super) fn map_filter_masks(&mut self, id: u32, mut f: impl FnMut(&mut Document, &Mask) -> Tiles) -> Result<(), String> {
        let Kind::Smart(s) = &self.node(id)?.kind else { return Ok(()) };
        let (mut filters, mut stack) = (s.filters.clone(), s.stack_mask.clone());
        for m in stack.iter_mut().chain(filters.iter_mut().filter_map(|f| f.mask.as_mut())) {
            m.tiles = f(self, m);
        }
        let s = self.smart_node_mut(id)?;
        (s.filters, s.stack_mask) = (filters, stack);
        Ok(())
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
        let cache = self.smart_cache(id, &src, size, &t, warp.as_ref())?;
        self.smart_node_mut(id)?.cache = cache;
        Ok(())
    }

    /// After each committed edit: re-renders every smart object whose enabled filters read the layer
    /// mask when that mask changed since its cache was rendered.
    // ponytail: key 0 (never settled) costs one extra render; stamp the key at every cache write if that matters.
    pub fn settle_smart(&mut self) -> Result<(), String> {
        if self.loading.is_some() {
            return Ok(());
        }
        fn walk(nodes: &[Node], out: &mut Vec<(u32, u64)>) {
            for n in nodes {
                match &n.kind {
                    Kind::Smart(s) if s.filters.iter().any(|f| f.enabled && f.filter.reads_mask()) => {
                        let key = mask_key(n.mask.as_ref());
                        if key != s.mask_key {
                            out.push((n.id, key));
                        }
                    }
                    Kind::Group(ch) => walk(ch, out),
                    _ => {}
                }
            }
        }
        let mut stale = Vec::new();
        walk(&self.nodes, &mut stale);
        for (id, key) in stale {
            self.render_smart(id)?;
            self.smart_node_mut(id)?.mask_key = key;
        }
        Ok(())
    }

    /// Sets a smart object's transform and warp (none = placed by the transform) and re-renders.
    pub fn set_smart_placement(&mut self, id: u32, t: &[f64; 9], warp: Option<WarpMesh>) -> Result<(), String> {
        self.check_idle()?;
        let (src, size) = self.placement_source(id)?;
        let cache = self.smart_cache(id, &src, size, t, warp.as_ref())?;
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
            mask_key: 0,
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
        let cache = self.smart_cache(id, &src, r.source_size, &t, warp.as_ref())?;
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
            caches.push(self.smart_cache(n, &src, r.source_size, &t, warp.as_ref())?);
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
            Kind::Text(t) => t.cache.as_ref().and_then(tiles_bounds),
            // ponytail: path bounds arrive with path.rs geometry.
            Kind::Shape(_) => None,
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

    // `sub`'s composite as straight pixels at this document's depth, tile (tx, ty) put at (ox + tx, oy + ty).
    fn straight_tiles(&mut self, sub: &Document, ox: i32, oy: i32) -> Tiles {
        let mut out = Tiles::default();
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
                    out.put(ox + tx as i32, oy + ty as i32, Some(Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
                }
            }
        }
        out
    }

    /// Merges the sibling `ids` into a new pixel layer of their composite over transparency, named
    /// after the bottom-most. `keep`: they stay and it goes above the top-most, else it takes their
    /// place. `clip`: canvas only, else content past the canvas is kept.
    pub fn merge_nodes(&mut self, ids: &[u32], keep: bool, clip: bool) -> Result<u32, String> {
        self.check_idle()?;
        let paths = self.sibling_paths(ids)?;
        let nodes: Vec<Node> = paths.iter().map(|p| node_at(&self.nodes, p).clone()).collect();
        let (t, canvas) = (TILE as i32, [0, 0, self.width as i32, self.height as i32]);
        let mut r = canvas;
        if !clip {
            for b in nodes.iter().filter_map(|n| self.content_bounds(n)) {
                r = [r[0].min(b[0]), r[1].min(b[1]), r[2].max(b[0] + b[2]), r[3].max(b[1] + b[3])];
            }
        }
        // A tile-aligned origin keeps the sub-document's tiles on the layer tile grid.
        let (x0, y0) = (r[0].div_euclid(t) * t, r[1].div_euclid(t) * t);
        let (name, clipping) = (nodes[0].name.clone(), nodes[0].clipping && !keep);
        let mut sub = self.clone();
        sub.nodes = nodes;
        (sub.selection, sub.last_selection) = (None, None);
        sub.channels.clear();
        sub.layer_comps.clear();
        if [x0, y0, r[2], r[3]] != canvas {
            sub.apply_crop([x0, y0, r[2] - x0, r[3] - y0].map(|v| v as f64), false)?;
        }
        let tiles = self.straight_tiles(&sub, x0 / t, y0 / t);
        let prefix = paths[0][..paths[0].len() - 1].to_vec();
        let idx: Vec<usize> = paths.iter().map(|p| *p.last().expect("a path")).collect();
        let id = self.alloc_node_id();
        let mut node = Node::new(id, &name, Kind::Pixel(tiles));
        node.clipping = clipping;
        let list = list_mut(&mut self.nodes, &prefix);
        if keep {
            list.insert(idx[idx.len() - 1] + 1, node);
        } else {
            for &i in idx.iter().rev() {
                list.remove(i);
            }
            list.insert(idx[0], node);
        }
        Ok(id)
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
        let src = self.straight_tiles(&sub, 0, 0);
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
            mask_key: 0,
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

// A fingerprint of a layer mask's default and tile ids (every tile write takes a new id); never 0.
fn mask_key(m: Option<&Mask>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    if let Some(m) = m {
        m.default.hash(&mut h);
        for (x, y) in m.tiles.coords() {
            (x, y, m.tiles.get(x, y).map_or(0, |t| t.id)).hash(&mut h);
        }
    }
    h.finish() | 1
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
    fn image_size_re_renders_a_smart_object_from_its_source() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 6, 4, translate(10.0, 20.0), "a");
        assert!(d.image_size(128, 128, Interp::Nearest, false).unwrap());
        assert_eq!(smart_of(&d, id).transform, [2.0, 0.0, 20.0, 0.0, 2.0, 40.0, 0.0, 0.0, 1.0]);
        let after = grid(&d, id, [16, 36, 16, 12]);
        d.render_smart(id).unwrap();
        assert_eq!(grid(&d, id, [16, 36, 16, 12]), after, "the cache is the source rendered through the new placement");
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

    // ---------- smart filters (section 7) ----------

    const INVERT: &str = r#"{"kind":"invert","params":{}}"#;

    fn cache_bytes(d: &Document, id: u32) -> Vec<((i32, i32), Vec<u8>)> {
        let c = &smart_of(d, id).cache;
        c.coords().into_iter().map(|(x, y)| ((x, y), c.get(x, y).unwrap().px.to_bytes())).collect()
    }

    fn flat_grid(d: &Document, r: [i32; 4]) -> Vec<[u8; 4]> {
        (r[1]..r[1] + r[3])
            .flat_map(|y| (r[0]..r[0] + r[2]).map(move |x| (x, y)))
            .map(|(x, y)| {
                let t = d.flatten_tile_rgba8(x as u32 / TILE as u32, y as u32 / TILE as u32).unwrap();
                let o = ((y as usize % TILE) * TILE + x as usize % TILE) * 4;
                [t[o], t[o + 1], t[o + 2], t[o + 3]]
            })
            .collect()
    }

    #[test]
    fn an_invert_filter_at_half_opacity_equals_the_invert_adjustment_layer() {
        let gray = [200u8, 200, 200, 255].repeat(16 * 16);
        let placed = |d: &mut Document, rgba: &[u8], w: u32| {
            let j = json!({ "name": "P", "link": { "type": "embedded", "id": "a" }, "source_blob": null, "source_size": [w, w], "transform": ID });
            d.place_smart(0, &j.to_string(), rgba).unwrap()
        };
        let mut a = Document::new(32, 32, 8).unwrap();
        let sa = placed(&mut a, &gray, 16);
        let f = a.add_smart_filter(sa, INVERT).unwrap();
        a.set_smart_filter(sa, f, r#"{"opacity":0.5}"#).unwrap();
        let mut b = Document::new(32, 32, 8).unwrap();
        let sb = placed(&mut b, &gray, 16);
        let adj = b.add_special(sb, &json!({ "name": "Invert", "adjustment": { "kind": "invert", "params": {} } }).to_string()).unwrap();
        b.set_props(adj, r#"{"opacity":0.5}"#).unwrap();
        assert_eq!(flat_grid(&a, [0, 0, 16, 16]), flat_grid(&b, [0, 0, 16, 16]));
        assert_eq!(flat_grid(&a, [3, 3, 1, 1])[0], [128, 128, 128, 255], "the B3 midpoint");
        // Noise with alpha too.
        let n: Vec<u8> = noise(16, 16, 7).chunks(4).enumerate().flat_map(|(i, p)| [p[0], p[1], p[2], (i * 7 % 256) as u8]).collect();
        let mut a = Document::new(32, 32, 8).unwrap();
        let sa = placed(&mut a, &n, 16);
        let f = a.add_smart_filter(sa, INVERT).unwrap();
        a.set_smart_filter(sa, f, r#"{"opacity":0.5}"#).unwrap();
        let mut b = Document::new(32, 32, 8).unwrap();
        let sb = placed(&mut b, &n, 16);
        let adj = b.add_special(sb, &json!({ "name": "Invert", "adjustment": { "kind": "invert", "params": {} } }).to_string()).unwrap();
        b.set_props(adj, r#"{"opacity":0.5}"#).unwrap();
        assert_eq!(flat_grid(&a, [0, 0, 16, 16]), flat_grid(&b, [0, 0, 16, 16]));
    }

    #[test]
    fn a_zero_filter_mask_leaves_the_source_and_disable_all_restores_the_cache() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 20, 12, translate(5.0, 7.0), "a");
        let plain = cache_bytes(&d, id);
        let f = d.add_smart_filter(id, INVERT).unwrap();
        assert_ne!(cache_bytes(&d, id), plain);
        d.add_filter_mask(id, f, false).unwrap();
        assert_eq!(grid(&d, id, [0, 0, 32, 32]), grid(&d.clone_unfiltered(id), id, [0, 0, 32, 32]), "a hide-all filter mask");
        d.delete_filter_masks(id).unwrap();
        d.add_smart_filter(id, r#"{"kind":"gaussian_blur","params":{"radius":3.0}}"#).unwrap();
        assert_eq!(d.layer_bounds(id).unwrap(), Some([2, 4, 26, 18]), "bounds grow by the blur reach");
        d.toggle_smart_filters(id).unwrap();
        assert!(smart_of(&d, id).filters.iter().all(|f| !f.enabled));
        assert_eq!(cache_bytes(&d, id), plain, "disable all restores the unfiltered cache exactly");
        d.toggle_smart_filters(id).unwrap();
        assert!(smart_of(&d, id).filters.iter().all(|f| f.enabled));
        d.clear_smart_filters(id).unwrap();
        assert!(smart_of(&d, id).filters.is_empty());
        assert_eq!(cache_bytes(&d, id), plain);
    }

    impl Document {
        // A copy with the smart object's filters cleared.
        fn clone_unfiltered(&self, id: u32) -> Document {
            let mut d = self.clone();
            d.clear_smart_filters(id).unwrap();
            d
        }
    }

    #[test]
    fn filter_ops_edit_the_stack_and_refuse_bad_input() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 8, 8, ID, "a");
        let a = d.add_smart_filter(id, INVERT).unwrap();
        let b = d.add_smart_filter(id, r#"{"kind":"posterize","params":{"levels":4}}"#).unwrap();
        assert_eq!((a, b), (1, 2));
        d.set_smart_filter(id, b, r#"{"enabled":false,"blend":"multiply","opacity":0.25}"#).unwrap();
        let f = &smart_of(&d, id).filters[1];
        assert_eq!((f.enabled, f.blend, f.opacity), (false, Blend::Multiply, 0.25));
        d.set_smart_filter(id, b, r#"{"filter":{"kind":"posterize","params":{"levels":8}}}"#).unwrap();
        let f = &smart_of(&d, id).filters[1].filter;
        assert_eq!((f.kind.as_str(), f.num("levels")), ("posterize", 8.0));
        let gone = "That smart filter is no longer in the stack.";
        assert_eq!(d.set_smart_filter(id, 9, r#"{"enabled":true}"#).unwrap_err(), gone);
        assert!(d.set_smart_filter(id, a, r#"{"opacity":2}"#).is_err());
        assert!(d.set_smart_filter(id, a, r#"{"blend":"pass through"}"#).is_err());
        assert!(d.set_smart_filter(id, a, r#"{"sigma":1}"#).is_err());
        assert!(d.add_smart_filter(id, r#"{"kind":"posterize","params":{"levels":1}}"#).unwrap_err().contains("levels"));
        assert!(d.add_smart_filter(id, r#"{"kind":"gaussian_blur","params":{"radius":0}}"#).unwrap_err().contains("radius"));
        assert!(d.add_smart_filter(1, INVERT).unwrap_err().contains("not a smart object"));
        d.remove_smart_filter(id, a).unwrap();
        assert_eq!(smart_of(&d, id).filters.iter().map(|f| f.id).collect::<Vec<_>>(), vec![b]);
        assert_eq!(d.remove_smart_filter(id, a).unwrap_err(), gone);
        // Masks: per filter and the stack mask (0); delete and toggle act on all of them.
        assert_eq!(d.delete_filter_masks(id).unwrap_err(), "The selected smart filters have no filter mask.");
        d.add_filter_mask(id, 0, true).unwrap();
        d.add_filter_mask(id, b, true).unwrap();
        assert!(d.add_filter_mask(id, b, true).is_err());
        d.toggle_filter_masks(id).unwrap();
        let s = smart_of(&d, id);
        assert!(!s.stack_mask.as_ref().unwrap().enabled && !s.filters[0].mask.as_ref().unwrap().enabled);
        d.toggle_filter_masks(id).unwrap();
        assert!(smart_of(&d, id).stack_mask.as_ref().unwrap().enabled);
        d.delete_filter_masks(id).unwrap();
        let s = smart_of(&d, id);
        assert!(s.stack_mask.is_none() && s.filters[0].mask.is_none());
    }

    #[test]
    fn a_hosted_adjustment_on_a_smart_object_appends_a_filter_masked_to_the_selection() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let id = place(&mut d, 30, 30, ID, "a");
        let before = grid(&d, id, [0, 0, 30, 30]);
        d.select_rect(20.0, 20.0, 1.0, 1.0, Mode::New).unwrap();
        d.apply_adjustment(id, Target::Pixels, INVERT).unwrap();
        let s = smart_of(&d, id);
        assert_eq!(s.filters.len(), 1);
        assert!(s.filters[0].mask.is_some(), "the selection becomes the filter mask");
        let inv = |p: [u8; 4]| [255 - p[0], 255 - p[1], 255 - p[2], p[3]];
        assert_eq!(get_px(&d, id, 20, 20), inv(before[20 * 30 + 20]));
        assert_eq!(get_px(&d, id, 21, 20), before[20 * 30 + 21]);
        d.invert(id, Target::Pixels).unwrap();
        assert_eq!(smart_of(&d, id).filters.len(), 2, "Invert appends a filter too");
        d.remove_smart_filter(id, 2).unwrap();
        let err = d.apply_destructive(id, r#"{"kind":"equalize","params":{}}"#).unwrap_err();
        assert!(err.contains("smart object"), "{err}");
        // A crop moves the filter mask with the layer; a re-render agrees.
        d.selection = None;
        d.apply_crop([4.0, 7.0, 50.0, 50.0], false).unwrap();
        assert_eq!(get_px(&d, id, 16, 13), inv(before[20 * 30 + 20]));
        assert_eq!(get_px(&d, id, 17, 13), before[20 * 30 + 21]);
        d.render_smart(id).unwrap();
        assert_eq!(get_px(&d, id, 16, 13), inv(before[20 * 30 + 20]));
        assert_eq!(get_px(&d, id, 17, 13), before[20 * 30 + 21]);
        // Exact rotation and a layer move keep them in step too.
        d.rotate_canvas_exact(Remap::FlipH).unwrap();
        d.offset_layer(id, 2, 1).unwrap();
        let moved = grid(&d, id, [0, 0, 50, 50]);
        d.render_smart(id).unwrap();
        assert_eq!(grid(&d, id, [0, 0, 50, 50]), moved);
    }

    #[test]
    fn convert_for_smart_filters_keeps_the_id_and_the_pixels() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let a = d.add_layer("A", 1).unwrap();
        put_px(&mut d, a, 10, 12, [9, 8, 7, 255]);
        put_px(&mut d, a, 14, 13, [1, 2, 3, 128]);
        d.set_props(a, r#"{"opacity":0.5}"#).unwrap();
        let flat = flat_grid(&d, [0, 0, 20, 20]);
        let j = json!({ "link_id": "l", "source_blob": null }).to_string();
        d.convert_for_smart_filters(a, &j).unwrap();
        let n = d.node(a).unwrap();
        assert_eq!((n.name.as_str(), n.opacity), ("A", 0.5));
        let s = smart_of(&d, a);
        assert_eq!((s.source_size, s.transform), ([5, 2], translate(10.0, 12.0)));
        assert_eq!(flat_grid(&d, [0, 0, 20, 20]), flat);
        d.render_smart(a).unwrap();
        assert_eq!(flat_grid(&d, [0, 0, 20, 20]), flat);
        assert_eq!(d.convert_for_smart_filters(a, &j).unwrap_err(), "\"A\" is already a smart object.");
        let g = d.add_group("G", a).unwrap();
        assert_eq!(d.convert_for_smart_filters(g, &j).unwrap_err(), "Cannot convert group layer for smart filters.");
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

    #[test]
    fn merge_nodes_keeps_content_past_the_canvas_and_the_document_depth() {
        let mut d = Document::new(64, 64, 8).unwrap();
        let a = d.add_layer("a", 1).unwrap();
        let b = d.add_layer("b", a).unwrap();
        put_px(&mut d, a, -3, 5, [255, 0, 0, 255]);
        put_px(&mut d, b, 10, 10, [0, 0, 255, 128]);
        assert!(d.merge_nodes(&[1, 99], false, false).is_err());
        let m = d.merge_nodes(&[b, a], false, false).unwrap();
        assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), [1, m]);
        assert_eq!(d.nodes[1].name, "a");
        assert_eq!(get_px(&d, m, -3, 5), [255, 0, 0, 255]);
        assert_eq!(get_px(&d, m, 10, 10), [0, 0, 255, 128]);
        let s = d.merge_nodes(&[m], true, true).unwrap();
        assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), [1, m, s]);
        assert_eq!(get_px(&d, s, -3, 5), [0; 4]);
        assert_eq!(get_px(&d, s, 10, 10), [0, 0, 255, 128]);
        let mut d16 = Document::new(8, 8, 16).unwrap();
        d16.put_rgba8(1, 0, 0, 1, 1, &[1, 2, 3, 255]).unwrap();
        let m = d16.merge_nodes(&[1], false, true).unwrap();
        let px = d16.node(m).unwrap().pixel_tiles().unwrap().get(0, 0).unwrap().px.clone();
        assert!(matches!(px.as_ref(), Pixels::U16(_)));
    }
}
