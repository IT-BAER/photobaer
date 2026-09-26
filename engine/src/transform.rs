//! Layer, mask and selection transforms (resampled) and exact 90/180/flip remaps.
//! A child module of `doc`, so it reaches the document's private tile storage.

use super::*;
use crate::resample::{Interp, Plane, Resampler};
use std::collections::BTreeSet;

/// Exact index remaps in a layer's content-bounds frame.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Remap {
    Cw,
    Ccw,
    R180,
    FlipH,
    FlipV,
}

impl Remap {
    pub fn parse(s: &str) -> Result<Remap, String> {
        Ok(match s {
            "cw" => Remap::Cw,
            "ccw" => Remap::Ccw,
            "180" => Remap::R180,
            "flipH" => Remap::FlipH,
            "flipV" => Remap::FlipV,
            other => return Err(format!("unknown remap {other}")),
        })
    }
}

// Same limit as warp: a dense f32 plane of this size already needs 1.6 GB of wasm32's 4 GiB.
const MAX_PIXELS: i64 = 100_000_000;

pub(super) fn check_area(r: [i32; 4]) -> Result<(), String> {
    if r[2] as i64 * r[3] as i64 > MAX_PIXELS {
        return Err("transform result is too large".into());
    }
    Ok(())
}
const TI: i32 = TILE as i32;

// Tile coords covering a document rect, not clipped to the canvas.
fn tile_span(r: [i32; 4]) -> Vec<(i32, i32)> {
    if r[2] <= 0 || r[3] <= 0 {
        return Vec::new();
    }
    let t = |v: i32| v.div_euclid(TI);
    let mut out = Vec::new();
    for ty in t(r[1])..=t(r[1] + r[3] - 1) {
        for tx in t(r[0])..=t(r[0] + r[2] - 1) {
            out.push((tx, ty));
        }
    }
    out
}

fn intersect(a: [i32; 4], b: [i32; 4]) -> [i32; 4] {
    let (x0, y0) = (a[0].max(b[0]), a[1].max(b[1]));
    let (x1, y1) = ((a[0] + a[2]).min(b[0] + b[2]), (a[1] + a[3]).min(b[1] + b[3]));
    [x0, y0, (x1 - x0).max(0), (y1 - y0).max(0)]
}

// The rect of all stored tiles, or None.
pub(super) fn tile_rect(tiles: &Tiles) -> Option<[i32; 4]> {
    let c = tiles.coords();
    let x0 = c.iter().map(|t| t.0).min()?;
    let y0 = c.iter().map(|t| t.1).min()?;
    let x1 = c.iter().map(|t| t.0).max()? + 1;
    let y1 = c.iter().map(|t| t.1).max()? + 1;
    Some([x0 * TI, y0 * TI, (x1 - x0) * TI, (y1 - y0) * TI])
}

fn check_tile_range(tx0: i64, ty0: i64, tx1: i64, ty1: i64) -> Result<(), String> {
    let lim = MAX_TILE_COORD as i64;
    if tx0 < -lim || ty0 < -lim || tx1 + 1 > lim || ty1 + 1 > lim {
        return Err("transform moves the layer too far".into());
    }
    Ok(())
}

fn all_default(px: &Pixels, default: u32) -> bool {
    match px {
        Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == default),
        Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == default),
        _ => false,
    }
}

fn px_at(tiles: &Tiles, x: i32, y: i32) -> [f32; 4] {
    let p = (y.rem_euclid(TI) * TI + x.rem_euclid(TI)) as usize;
    tiles.get(x.div_euclid(TI), y.div_euclid(TI)).map_or([0.0; 4], |t| t.px.rgba_f32(p))
}

impl Document {
    // Premultiplied RGBA of a layer over a rect; with `lift` the alpha is min(alpha, coverage)
    // of the canvas-clipped selection.
    pub(super) fn rgba_plane(&self, tiles: &Tiles, r: [i32; 4], lift: Option<&SelMask>) -> Plane {
        let (w, h) = (r[2] as usize, r[3] as usize);
        let mut data = vec![0f32; w * h * 4];
        for (tx, ty) in tile_span(r) {
            let Some(t) = tiles.get(tx, ty) else { continue };
            let (ox, oy) = (tx * TI, ty * TI);
            let o = intersect(r, [ox, oy, TI, TI]);
            for y in o[1]..o[1] + o[3] {
                let at = ((y - r[1]) as usize * w + (o[0] - r[0]) as usize) * 4;
                let row = &mut data[at..at + o[2] as usize * 4];
                let src = ((y - oy) * TI + o[0] - ox) as usize;
                for (i, out) in row.chunks_exact_mut(4).enumerate() {
                    let mut v = t.px.rgba_f32(src + i);
                    if let Some(sel) = lift {
                        v[3] = v[3].min(self.sel_at(sel, o[0] + i as i32, y));
                    }
                    out.copy_from_slice(&[v[0] * v[3], v[1] * v[3], v[2] * v[3], v[3]]);
                }
            }
        }
        Plane { x: r[0], y: r[1], w, h, ch: 4, sx: 1.0, sy: 1.0, data }
    }

    pub(super) fn mask_plane(&self, tiles: &Tiles, default: u32, r: [i32; 4]) -> Plane {
        let (w, h) = (r[2] as usize, r[3] as usize);
        let mut data = vec![default as f32 / self.max(); w * h];
        for (tx, ty) in tile_span(r) {
            let Some(t) = tiles.get(tx, ty) else { continue };
            let (ox, oy) = (tx * TI, ty * TI);
            let o = intersect(r, [ox, oy, TI, TI]);
            for y in o[1]..o[1] + o[3] {
                for x in o[0]..o[0] + o[2] {
                    data[(y - r[1]) as usize * w + (x - r[0]) as usize] = t.px.mask_f32(((y - oy) * TI + x - ox) as usize);
                }
            }
        }
        Plane { x: r[0], y: r[1], w, h, ch: 1, sx: 1.0, sy: 1.0, data }
    }

    // Renders the resampler's dest rect (clipped to `clip`) into fresh tiles; mask tiles that are
    // all default and fully transparent pixel tiles are dropped.
    pub(super) fn render_tiles(&mut self, rs: &Resampler, mask_default: Option<u32>, clip: Option<[i32; 4]>) -> Result<Tiles, String> {
        let r = clip.map_or(rs.rect(), |c| intersect(rs.rect(), c));
        self.render_tiles_with(r, mask_default, clip.is_some(), |ox, oy, buf| rs.render(ox, oy, TILE, TILE, buf))
    }

    // Renders the tiles over rect `r` with `render(ox, oy, buf)`, which fills one tile and returns
    // false when it holds only the edge value; with `clip` pixels outside `r` get the edge value.
    pub(super) fn render_tiles_with(
        &mut self,
        r: [i32; 4],
        mask_default: Option<u32>,
        clip: bool,
        mut render: impl FnMut(i32, i32, &mut [f32]) -> bool,
    ) -> Result<Tiles, String> {
        let mut out = Tiles::default();
        if r[2] <= 0 || r[3] <= 0 {
            return Ok(out);
        }
        check_area(r)?;
        let t = |v: i32| v.div_euclid(TI) as i64;
        check_tile_range(t(r[0]), t(r[1]), t(r[0] + r[2] - 1), t(r[1] + r[3] - 1))?;
        let ch = if mask_default.is_some() { 1 } else { 4 };
        let def = mask_default.unwrap_or(0);
        let mut buf = vec![0f32; TILE_PIXELS * ch];
        for (tx, ty) in tile_span(r) {
            let (ox, oy) = (tx * TI, ty * TI);
            if !render(ox, oy, &mut buf) {
                continue;
            }
            if clip {
                let edge = def as f32 / self.max();
                for p in 0..TILE_PIXELS {
                    let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                    if x < r[0] || y < r[1] || x >= r[0] + r[2] || y >= r[1] + r[3] {
                        buf[p * ch..(p + 1) * ch].fill(edge);
                    }
                }
            }
            let px = match mask_default {
                Some(d) => {
                    let px = Pixels::mask_from_norm(self.depth, &buf);
                    if all_default(&px, d) {
                        continue;
                    }
                    px
                }
                None => {
                    let px = Pixels::from_straight(self.depth, &buf);
                    if !px.any_alpha() {
                        continue;
                    }
                    px
                }
            };
            out.put(tx, ty, Some(Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
        }
        Ok(out)
    }

    /// Resamples a layer's pixels (all of them, off-canvas included, no dest clip) and its mask,
    /// whose area outside the old mask content keeps the mask default.
    pub fn transform_layer(&mut self, id: u32, m: &[f64; 9], interp: Interp) -> Result<(), String> {
        self.transform_layer_with(id, m, interp, true)
    }

    /// `transform_layer`; with `with_mask` false the layer mask is left as it is.
    pub fn transform_layer_with(&mut self, id: u32, m: &[f64; 9], interp: Interp, with_mask: bool) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_edit(id)?;
        if self.node(id)?.locks.position {
            return Err("layer position is locked".into());
        }
        let pixels = match self.layer_bounds(id)? {
            Some(b) => {
                check_area(b)?;
                let plane = self.rgba_plane(self.node(id)?.pixel_tiles()?, b, None);
                let rs = Resampler::new(plane, m, interp, 0.0)?;
                Some(self.render_tiles(&rs, None, None)?)
            }
            None => None,
        };
        let mask = self.node(id)?.mask.as_ref().filter(|_| with_mask).map(|mk| (mk.default, mk.tiles.clone()));
        let mask = match mask.and_then(|(def, tiles)| tile_rect(&tiles).map(|r| (def, tiles, r))) {
            Some((def, tiles, r)) => {
                check_area(r)?;
                let plane = self.mask_plane(&tiles, def, r);
                let rs = Resampler::new(plane, m, interp, def as f32 / self.max())?;
                Some(self.render_tiles(&rs, Some(def), None)?)
            }
            None => None,
        };
        if let Some(t) = pixels {
            *self.node_mut(id)?.pixel_tiles_mut()? = t;
        }
        if let Some(t) = mask {
            self.node_mut(id)?.mask.as_mut().expect("checked").tiles = t;
        }
        Ok(())
    }

    /// Resamples the selection coverage (edge zero, clipped to the canvas).
    pub fn transform_selection(&mut self, m: &[f64; 9], interp: Interp) -> Result<(), String> {
        self.check_idle()?;
        if self.selection.is_none() {
            return Err("nothing is selected".into());
        }
        let tiles = self.transformed_selection(m, interp)?;
        self.selection = Some(SelMask { default: 0, tiles });
        Ok(())
    }

    fn transformed_selection(&mut self, m: &[f64; 9], interp: Interp) -> Result<Tiles, String> {
        let sel = self.selection.clone().expect("a selection exists");
        let Some(b) = self.selection_bounds() else { return Ok(Tiles::default()) };
        let (w, h) = (b[2] as usize, b[3] as usize);
        let mut data = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                data[y * w + x] = self.sel_at(&sel, b[0] + x as i32, b[1] + y as i32);
            }
        }
        let plane = Plane { x: b[0], y: b[1], w, h, ch: 1, sx: 1.0, sy: 1.0, data };
        let rs = Resampler::new(plane, m, interp, 0.0)?;
        self.render_tiles(&rs, Some(0), Some([0, 0, self.width as i32, self.height as i32]))
    }

    /// Transforms the selected pixels of a layer and the selection with them. Lifted alpha is
    /// min(alpha, coverage); the hole is filled with `bg` (background layer) or loses the lifted
    /// alpha; the moved pixels are composited source-over.
    pub fn transform_selected_pixels(
        &mut self,
        id: u32,
        m: &[f64; 9],
        interp: Interp,
        bg: Option<[u8; 3]>,
        copy: bool,
    ) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_edit(id)?;
        let sel = self.selection.clone().ok_or("nothing is selected")?;
        let Some(b) = self.selection_bounds() else { return Ok(()) };
        check_area(b)?;
        let old = self.node(id)?.pixel_tiles()?.clone();
        let rs = Resampler::new(self.rgba_plane(&old, b, Some(&sel)), m, interp, 0.0)?;
        let moved = self.render_tiles(&rs, None, None)?;
        let outline = self.transformed_selection(m, interp)?;
        let bg = bg.map(|c| [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0, 1.0]);
        let mut layer = old.clone();
        let mut buf = vec![0f32; TILE_PIXELS * 4];
        // A copy leaves no hole.
        for (tx, ty) in tile_span(b).into_iter().filter(|_| !copy) {
            let Some(t) = old.get(tx, ty) else { continue };
            let (ox, oy) = (tx * TI, ty * TI);
            let mut changed = false;
            for p in 0..TILE_PIXELS {
                let mut v = t.px.rgba_f32(p);
                let l = v[3].min(self.sel_at(&sel, ox + (p % TILE) as i32, oy + (p / TILE) as i32));
                if l > 0.0 {
                    changed = true;
                    match bg {
                        Some(c) => (0..4).for_each(|i| v[i] = v[i] * (1.0 - l) + c[i] * l),
                        None => {
                            v[3] -= l;
                            if v[3] <= 0.0 {
                                v = [0.0; 4];
                            }
                        }
                    }
                }
                buf[p * 4..p * 4 + 4].copy_from_slice(&v);
            }
            if changed {
                let px = Pixels::from_straight(self.depth, &buf);
                let tile = px.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
                layer.put(tx, ty, tile);
            }
        }
        for (tx, ty) in moved.coords() {
            let s = moved.get(tx, ty).expect("a listed tile");
            let tile = match layer.get(tx, ty) {
                None => s.clone(),
                Some(d) => {
                    for p in 0..TILE_PIXELS {
                        let (a, e) = (s.px.rgba_f32(p), d.px.rgba_f32(p));
                        let ao = a[3] + e[3] * (1.0 - a[3]);
                        let v = if ao <= 0.0 {
                            [0.0; 4]
                        } else {
                            let c = |i: usize| (a[i] * a[3] + e[i] * e[3] * (1.0 - a[3])) / ao;
                            [c(0), c(1), c(2), ao]
                        };
                        buf[p * 4..p * 4 + 4].copy_from_slice(&v);
                    }
                    Tile { id: self.alloc_tile_id(), px: Arc::new(Pixels::from_straight(self.depth, &buf)) }
                }
            };
            layer.put(tx, ty, Some(tile));
        }
        *self.node_mut(id)?.pixel_tiles_mut()? = layer;
        self.selection = Some(SelMask { default: 0, tiles: outline });
        Ok(())
    }

    // Every pixel of `src` moved by an exact integer map (`fwd`, inverse `inv`, document px); a
    // missing source tile reads as empty or as the mask default.
    pub(super) fn remap_exact(
        &mut self,
        src: &Tiles,
        fwd: &dyn Fn(i64, i64) -> (i64, i64),
        inv: &dyn Fn(i64, i64) -> (i64, i64),
        mask_default: Option<u32>,
    ) -> Result<Tiles, String> {
        let t = TILE as i64;
        let mut dest: BTreeSet<(i32, i32)> = BTreeSet::new();
        for (tx, ty) in src.coords() {
            let (x0, y0) = (tx as i64 * t, ty as i64 * t);
            let c = [fwd(x0, y0), fwd(x0 + t - 1, y0), fwd(x0, y0 + t - 1), fwd(x0 + t - 1, y0 + t - 1)];
            let (lx, ly) = (c.iter().map(|p| p.0).min().expect("4"), c.iter().map(|p| p.1).min().expect("4"));
            let (hx, hy) = (c.iter().map(|p| p.0).max().expect("4"), c.iter().map(|p| p.1).max().expect("4"));
            let (lo, hi) = ((lx.div_euclid(t), ly.div_euclid(t)), (hx.div_euclid(t), hy.div_euclid(t)));
            check_tile_range(lo.0, lo.1, hi.0, hi.1)?;
            for dty in lo.1..=hi.1 {
                for dtx in lo.0..=hi.0 {
                    dest.insert((dtx as i32, dty as i32));
                }
            }
        }
        let def = mask_default.map_or(0.0, |d| d as f32 / self.max());
        let ch = if mask_default.is_some() { 1 } else { 4 };
        let mut buf = vec![0f32; TILE_PIXELS * ch];
        let mut out = Tiles::default();
        for (dtx, dty) in dest {
            for p in 0..TILE_PIXELS {
                let (sx, sy) = inv(dtx as i64 * t + (p % TILE) as i64, dty as i64 * t + (p / TILE) as i64);
                let tile = src.get(sx.div_euclid(t) as i32, sy.div_euclid(t) as i32);
                let sp = (sy.rem_euclid(t) * t + sx.rem_euclid(t)) as usize;
                if mask_default.is_some() {
                    buf[p] = tile.map_or(def, |t| t.px.mask_f32(sp));
                } else {
                    buf[p * 4..p * 4 + 4].copy_from_slice(&tile.map_or([0.0; 4], |t| t.px.rgba_f32(sp)));
                }
            }
            let px = match mask_default {
                Some(d) => Some(Pixels::mask_from_norm(self.depth, &buf)).filter(|px| !all_default(px, d)),
                None => Some(Pixels::from_straight(self.depth, &buf)).filter(|px| px.any_alpha()),
            };
            if let Some(px) = px {
                out.put(dtx, dty, Some(Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
            }
        }
        Ok(out)
    }

    /// Rotates or flips a layer and its mask exactly in the layer's content-bounds frame; the
    /// new frame is centred on the old one.
    pub fn rotate_layer_exact(&mut self, id: u32, kind: Remap) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_edit(id)?;
        let Some([x0, y0, w, h]) = self.layer_bounds(id)? else { return Ok(()) };
        let (x0, y0, w, h) = (x0 as i64, y0 as i64, w as i64, h as i64);
        let (nw, nh) = if matches!(kind, Remap::Cw | Remap::Ccw) { (h, w) } else { (w, h) };
        let round = |v: f64| (v + 0.5).floor() as i64;
        let nx = round(x0 as f64 + w as f64 / 2.0 - nw as f64 / 2.0);
        let ny = round(y0 as f64 + h as f64 / 2.0 - nh as f64 / 2.0);
        let fwd = move |x: i64, y: i64| {
            let (x, y) = (x - x0, y - y0);
            let (a, b) = match kind {
                Remap::Cw => (h - 1 - y, x),
                Remap::Ccw => (y, w - 1 - x),
                Remap::R180 => (w - 1 - x, h - 1 - y),
                Remap::FlipH => (w - 1 - x, y),
                Remap::FlipV => (x, h - 1 - y),
            };
            (a + nx, b + ny)
        };
        let inv = move |a: i64, b: i64| {
            let (a, b) = (a - nx, b - ny);
            let (x, y) = match kind {
                Remap::Cw => (b, h - 1 - a),
                Remap::Ccw => (w - 1 - b, a),
                Remap::R180 => (w - 1 - a, h - 1 - b),
                Remap::FlipH => (w - 1 - a, b),
                Remap::FlipV => (a, h - 1 - b),
            };
            (x + x0, y + y0)
        };
        let tiles = self.node(id)?.pixel_tiles()?.clone();
        let px = self.remap_exact(&tiles, &fwd, &inv, None)?;
        let mask = self.node(id)?.mask.as_ref().map(|mk| (mk.default, mk.tiles.clone()));
        let mask = match mask {
            Some((def, tiles)) => Some(self.remap_exact(&tiles, &fwd, &inv, Some(def))?),
            None => None,
        };
        *self.node_mut(id)?.pixel_tiles_mut()? = px;
        if let Some(t) = mask {
            self.node_mut(id)?.mask.as_mut().expect("checked").tiles = t;
        }
        Ok(())
    }

    /// Cheap preview: the layer (or its lifted selection) transformed by `m` into a proxy of the
    /// document scaled by `f` (0 < f <= 1), bilinear, straight RGBA8 for the proxy-pixel rect.
    /// Output past the canvas + 64 px stays transparent.
    pub fn transform_preview(&self, id: u32, m: &[f64; 9], f: f64, selected: bool, rect: [i32; 4]) -> Result<Vec<u8>, String> {
        if !(f > 0.0 && f <= 1.0) {
            return Err("preview scale must be in (0, 1]".into());
        }
        if rect[2] < 0 || rect[3] < 0 || rect[2] as i64 * rect[3] as i64 > 1 << 26 {
            return Err("preview rect is too large".into());
        }
        // The proxy is skipped when it would be almost full size.
        let f = if f >= 0.9 { 1.0 } else { f };
        let (w, h) = (rect[2] as usize, rect[3] as usize);
        let mut out = vec![0u8; w * h * 4];
        let tiles = self.node(id)?.pixel_tiles()?;
        let sel = if selected { Some(self.selection.as_ref().ok_or("nothing is selected")?) } else { None };
        let bounds = if selected { self.selection_bounds() } else { self.layer_bounds(id)? };
        let Some(b) = bounds else { return Ok(out) };
        // Nearest proxy of the source.
        let pw = ((b[2] as f64 * f).round() as usize).max(1);
        let ph = ((b[3] as f64 * f).round() as usize).max(1);
        let (sx, sy) = (pw as f64 / b[2] as f64, ph as f64 / b[3] as f64);
        let mut data = vec![0f32; pw * ph * 4];
        for j in 0..ph {
            let y = b[1] + (((j as f64 + 0.5) / sy) as i32).min(b[3] - 1);
            for i in 0..pw {
                let x = b[0] + (((i as f64 + 0.5) / sx) as i32).min(b[2] - 1);
                let mut v = px_at(tiles, x, y);
                if let Some(s) = sel {
                    v[3] = v[3].min(self.sel_at(s, x, y));
                }
                let at = (j * pw + i) * 4;
                data[at..at + 4].copy_from_slice(&[v[0] * v[3], v[1] * v[3], v[2] * v[3], v[3]]);
            }
        }
        let plane = Plane { x: b[0], y: b[1], w: pw, h: ph, ch: 4, sx, sy, data };
        let pm = [m[0] * f, m[1] * f, m[2] * f, m[3] * f, m[4] * f, m[5] * f, m[6], m[7], m[8]];
        let rs = Resampler::new(plane, &pm, Interp::Bilinear, 0.0)?;
        let mut buf = vec![0f32; w * h * 4];
        rs.render(rect[0], rect[1], w, h, &mut buf);
        let lo = (-64.0 * f).floor() as i32;
        let (hx, hy) = (((self.width as f64 + 64.0) * f).ceil() as i32, ((self.height as f64 + 64.0) * f).ceil() as i32);
        for j in 0..h {
            for i in 0..w {
                let (x, y) = (rect[0] + i as i32, rect[1] + j as i32);
                if x < lo || y < lo || x >= hx || y >= hy {
                    continue;
                }
                for c in 0..4 {
                    let at = (j * w + i) * 4 + c;
                    out[at] = (buf[at] * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use crate::resample::matrix;

    const T: i32 = TILE as i32;
    const ID: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    const ALL: [Interp; 6] = [
        Interp::Nearest,
        Interp::Bilinear,
        Interp::Bicubic,
        Interp::BicubicSharper,
        Interp::BicubicSmoother,
        Interp::Lanczos3,
    ];

    fn tr(dx: f64, dy: f64) -> [f64; 9] {
        [1.0, 0.0, dx, 0.0, 1.0, dy, 0.0, 0.0, 1.0]
    }

    fn at(x: i32, y: i32) -> ((i32, i32), usize) {
        ((x.div_euclid(T), y.div_euclid(T)), (y.rem_euclid(T) * T + x.rem_euclid(T)) as usize)
    }

    pub(crate) fn put_px(d: &mut Document, id: u32, x: i32, y: i32, v: [u8; 4]) {
        let ((tx, ty), p) = at(x, y);
        let tid = d.alloc_tile_id();
        let tiles = d.node_mut(id).unwrap().pixel_tiles_mut().unwrap();
        let mut data = match tiles.get(tx, ty).map(|t| (*t.px).clone()) {
            Some(Pixels::U8(b)) => b.to_vec(),
            _ => vec![0; TILE_PIXELS * 4],
        };
        data[p * 4..p * 4 + 4].copy_from_slice(&v);
        tiles.put(tx, ty, Some(Tile { id: tid, px: Arc::new(Pixels::U8(data.into_boxed_slice())) }));
    }

    pub(crate) fn get_px(d: &Document, id: u32, x: i32, y: i32) -> [u8; 4] {
        let ((tx, ty), p) = at(x, y);
        match d.node(id).unwrap().pixel_tiles().unwrap().get(tx, ty).map(|t| t.px.clone()) {
            Some(px) => match px.as_ref() {
                Pixels::U8(b) => [b[p * 4], b[p * 4 + 1], b[p * 4 + 2], b[p * 4 + 3]],
                _ => panic!("8-bit test document"),
            },
            None => [0; 4],
        }
    }

    pub(crate) fn put_mask(d: &mut Document, id: u32, x: i32, y: i32, v: u8) {
        let ((tx, ty), p) = at(x, y);
        let tid = d.alloc_tile_id();
        let m = d.node_mut(id).unwrap().mask.as_mut().unwrap();
        let mut data = match m.tiles.get(tx, ty).map(|t| (*t.px).clone()) {
            Some(Pixels::Mask8(b)) => b.to_vec(),
            _ => vec![m.default as u8; TILE_PIXELS],
        };
        data[p] = v;
        m.tiles.put(tx, ty, Some(Tile { id: tid, px: Arc::new(Pixels::Mask8(data.into_boxed_slice())) }));
    }

    pub(crate) fn get_mask(d: &Document, id: u32, x: i32, y: i32) -> u8 {
        let ((tx, ty), p) = at(x, y);
        let m = d.node(id).unwrap().mask.as_ref().unwrap();
        m.tiles.get(tx, ty).map_or(m.default as u8, |t| (t.px.mask_f32(p) * 255.0).round() as u8)
    }

    fn grid(d: &Document, id: u32, r: [i32; 4]) -> Vec<[u8; 4]> {
        let mut v = Vec::new();
        for y in r[1]..r[1] + r[3] {
            for x in r[0]..r[0] + r[2] {
                v.push(get_px(d, id, x, y));
            }
        }
        v
    }

    fn mask_grid(d: &Document, id: u32, r: [i32; 4]) -> Vec<u8> {
        let mut v = Vec::new();
        for y in r[1]..r[1] + r[3] {
            for x in r[0]..r[0] + r[2] {
                v.push(get_mask(d, id, x, y));
            }
        }
        v
    }

    // Layer 1 with a 3x3 block of varied colour and alpha at (5, 5) and a reveal-all mask with
    // two painted values.
    fn sample_doc() -> Document {
        let mut d = Document::new(256, 256, 8).unwrap();
        for y in 0..3 {
            for x in 0..3 {
                let i = (y * 3 + x) as u8;
                put_px(&mut d, 1, 5 + x, 5 + y, [20 * i + 7, 255 - 25 * i, 3 * i, 255 - 28 * i]);
            }
        }
        d.add_mask(1, true).unwrap();
        put_mask(&mut d, 1, 6, 6, 0);
        put_mask(&mut d, 1, 7, 5, 99);
        d
    }

    #[test]
    fn a_result_over_the_pixel_limit_is_refused_before_rendering() {
        let mut d = sample_doc();
        let before = grid(&d, 1, [0, 0, 16, 16]);
        // 3x3 content scaled 4000x is about 1.4e8 px, over the 1e8 limit.
        let e = d.transform_layer(1, &[4000.0, 0.0, 0.0, 0.0, 4000.0, 0.0, 0.0, 0.0, 1.0], Interp::Bilinear).unwrap_err();
        assert_eq!(e, "transform result is too large");
        assert_eq!(grid(&d, 1, [0, 0, 16, 16]), before);
    }

    #[test]
    fn identity_is_a_byte_identical_copy_for_every_kernel() {
        let base = sample_doc();
        let r = [0, 0, 16, 16];
        for k in ALL {
            let mut d = base.clone();
            d.transform_layer(1, &ID, k).unwrap();
            assert_eq!(grid(&d, 1, r), grid(&base, 1, r), "{k:?}");
            assert_eq!(mask_grid(&d, 1, r), mask_grid(&base, 1, r), "{k:?}");
            assert_eq!(get_mask(&d, 1, 200, 200), 255);
        }
    }

    #[test]
    fn integer_translate_is_an_exact_shift_of_pixels_and_mask() {
        let base = sample_doc();
        for k in ALL {
            let mut d = base.clone();
            d.transform_layer(1, &tr(3.0, -2.0), k).unwrap();
            assert_eq!(grid(&d, 1, [8, 3, 3, 3]), grid(&base, 1, [5, 5, 3, 3]), "{k:?}");
            assert_eq!(d.layer_bounds(1).unwrap(), Some([8, 3, 3, 3]), "{k:?}");
            assert_eq!(mask_grid(&d, 1, [8, 3, 3, 3]), mask_grid(&base, 1, [5, 5, 3, 3]), "{k:?}");
            // Outside the old mask content the mask keeps its default.
            assert_eq!(get_mask(&d, 1, 6, 6), 255, "{k:?}");
        }
    }

    #[test]
    fn a_pixels_only_transform_leaves_the_mask_untouched() {
        let base = sample_doc();
        let mut d = base.clone();
        d.transform_layer_with(1, &tr(3.0, -2.0), Interp::Bicubic, false).unwrap();
        assert_eq!(grid(&d, 1, [8, 3, 3, 3]), grid(&base, 1, [5, 5, 3, 3]));
        assert_eq!(mask_grid(&d, 1, [0, 0, 16, 16]), mask_grid(&base, 1, [0, 0, 16, 16]));
    }

    #[test]
    fn off_canvas_pixels_survive_a_translate_out_and_back() {
        let base = sample_doc();
        let mut d = base.clone();
        d.transform_layer(1, &tr(-300.0, 0.0), Interp::Bicubic).unwrap();
        assert_eq!(d.layer_bounds(1).unwrap(), Some([-295, 5, 3, 3]));
        assert_eq!(d.flatten_tile_rgba8(0, 0).unwrap().chunks_exact(4).filter(|p| p[3] > 0).count(), 0);
        d.transform_layer(1, &tr(300.0, 0.0), Interp::Bicubic).unwrap();
        assert_eq!(grid(&d, 1, [0, 0, 16, 16]), grid(&base, 1, [0, 0, 16, 16]));
        assert_eq!(mask_grid(&d, 1, [0, 0, 16, 16]), mask_grid(&base, 1, [0, 0, 16, 16]));
    }

    #[test]
    fn rotate_90_by_resampling_equals_the_exact_remap_with_nearest() {
        let mut base = Document::new(256, 256, 8).unwrap();
        for y in 0..3 {
            for x in 0..5 {
                put_px(&mut base, 1, 10 + x, 20 + y, [(x * 40) as u8, (y * 80) as u8, 9, 255]);
            }
        }
        let mut exact = base.clone();
        exact.rotate_layer_exact(1, Remap::Cw).unwrap();
        let b = exact.layer_bounds(1).unwrap().unwrap();
        assert_eq!(b, [11, 19, 3, 5]);
        // Pixel centres of the 5x3 frame at (10, 20) onto the 3x5 frame at (11, 19), clockwise.
        let (s, c) = std::f64::consts::FRAC_PI_2.sin_cos();
        let (tx, ty) = (11.0 + 3.0 + 20.0, 19.0 - 10.0);
        let m = [c, -s, tx, s, c, ty, 0.0, 0.0, 1.0];
        let mut resampled = base.clone();
        resampled.transform_layer(1, &m, Interp::Nearest).unwrap();
        assert_eq!(resampled.layer_bounds(1).unwrap().unwrap(), b);
        assert_eq!(grid(&resampled, 1, b), grid(&exact, 1, b));
    }

    #[test]
    fn projective_quad_of_a_checker_matches_the_bilinear_golden() {
        let mut d = Document::new(256, 256, 8).unwrap();
        for y in 0..4 {
            for x in 0..4 {
                let v = if (x + y) % 2 == 0 { 255 } else { 0 };
                put_px(&mut d, 1, x, y, [v, v, v, 255]);
            }
        }
        let h = [2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.05, 0.02, 1.0];
        d.transform_layer(1, &h, Interp::Bilinear).unwrap();
        let gray: [[u8; 7]; 8] = [
            [255, 183, 41, 109, 242, 75, 0],
            [186, 150, 94, 123, 158, 113, 105],
            [51, 94, 197, 133, 38, 199, 245],
            [86, 116, 139, 128, 137, 109, 81],
            [226, 170, 30, 131, 183, 82, 86],
            [140, 125, 152, 123, 82, 211, 255],
            [0, 86, 238, 111, 60, 242, 255],
            [0, 88, 242, 105, 0, 0, 0],
        ];
        let alpha: [[u8; 7]; 8] = [
            [145, 194, 196, 198, 200, 202, 122],
            [193, 255, 255, 255, 255, 255, 140],
            [194, 255, 255, 255, 255, 255, 128],
            [194, 255, 255, 255, 255, 255, 115],
            [195, 255, 255, 255, 255, 255, 102],
            [196, 255, 255, 255, 255, 255, 87],
            [192, 224, 198, 170, 140, 108, 22],
            [77, 70, 39, 6, 0, 0, 0],
        ];
        let got = grid(&d, 1, [0, 0, 7, 8]);
        let want: Vec<[u8; 4]> =
            (0..8).flat_map(|y| (0..7).map(move |x| (y, x))).map(|(y, x)| {
                let (g, a) = (gray[y][x], alpha[y][x]);
                [g, g, g, a]
            }).collect();
        assert_eq!(got, want);
        assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 7, 8]));
    }

    #[test]
    fn premultiplied_filtering_leaves_no_red_fringe() {
        let mut d = Document::new(256, 256, 8).unwrap();
        put_px(&mut d, 1, 0, 0, [255, 0, 0, 0]);
        put_px(&mut d, 1, 1, 0, [0, 0, 255, 255]);
        put_px(&mut d, 1, 0, 1, [0, 0, 255, 255]);
        d.transform_layer(1, &tr(0.5, 0.0), Interp::Bicubic).unwrap();
        let g = grid(&d, 1, [0, 0, 3, 2]);
        assert!(g.iter().all(|p| p[3] == 0 || p[0] == 0), "{g:?}");
        assert_eq!(g[1][2], 255, "{g:?}");
    }

    #[test]
    fn exact_remaps_are_byte_exact_on_a_3x2_layer_and_mask() {
        // a b c / d e f at (10, 20); the mask holds 10 * the same letters.
        let mut base = Document::new(256, 256, 8).unwrap();
        base.add_mask(1, false).unwrap();
        for y in 0..2 {
            for x in 0..3 {
                let i = (y * 3 + x + 1) as u8;
                put_px(&mut base, 1, 10 + x, 20 + y, [i, 0, 0, 255]);
                put_mask(&mut base, 1, 10 + x, 20 + y, i * 10);
            }
        }
        let (a, b, c, dd, e, f) = (1, 2, 3, 4, 5, 6);
        let cases: [(Remap, [i32; 4], Vec<u8>); 5] = [
            (Remap::Cw, [11, 20, 2, 3], vec![dd, a, e, b, f, c]),
            (Remap::Ccw, [11, 20, 2, 3], vec![c, f, b, e, a, dd]),
            (Remap::R180, [10, 20, 3, 2], vec![f, e, dd, c, b, a]),
            (Remap::FlipH, [10, 20, 3, 2], vec![c, b, a, f, e, dd]),
            (Remap::FlipV, [10, 20, 3, 2], vec![dd, e, f, a, b, c]),
        ];
        for (kind, r, want) in cases {
            let mut d = base.clone();
            d.rotate_layer_exact(1, kind).unwrap();
            assert_eq!(d.layer_bounds(1).unwrap(), Some(r), "{kind:?}");
            let px: Vec<u8> = grid(&d, 1, r).iter().map(|p| p[0]).collect();
            assert_eq!(px, want, "{kind:?}");
            let m: Vec<u8> = mask_grid(&d, 1, r).iter().map(|v| v / 10).collect();
            assert_eq!(m, want, "{kind:?} mask");
            assert!(grid(&d, 1, r).iter().all(|p| p[3] == 255));
        }
    }

    // One opaque red and one half-alpha red pixel selected, an opaque blue pixel where the
    // half-alpha one lands after a (4, 0) move.
    fn lift_doc() -> Document {
        let mut d = Document::new(256, 256, 8).unwrap();
        put_px(&mut d, 1, 0, 0, [255, 0, 0, 255]);
        put_px(&mut d, 1, 1, 0, [255, 0, 0, 128]);
        put_px(&mut d, 1, 5, 0, [0, 0, 255, 255]);
        d.select_rect(0.0, 0.0, 2.0, 1.0, Mode::New).unwrap();
        d
    }

    #[test]
    fn lifted_selection_leaves_a_transparent_hole_in_a_normal_layer() {
        let mut d = lift_doc();
        d.transform_selected_pixels(1, &tr(4.0, 0.0), Interp::Nearest, None, false).unwrap();
        assert_eq!(grid(&d, 1, [0, 0, 6, 1]), vec![[0; 4], [0; 4], [0; 4], [0; 4], [255, 0, 0, 255], [128, 0, 127, 255]]);
        assert_eq!(d.selection_bounds(), Some([4, 0, 2, 1]));
    }

    #[test]
    fn lifted_selection_fills_the_hole_of_a_background_layer_with_the_background_colour() {
        let mut d = lift_doc();
        d.transform_selected_pixels(1, &tr(4.0, 0.0), Interp::Nearest, Some([255, 255, 255]), false).unwrap();
        assert_eq!(
            grid(&d, 1, [0, 0, 6, 1]),
            vec![[255, 255, 255, 255], [255, 128, 128, 192], [0; 4], [0; 4], [255, 0, 0, 255], [128, 0, 127, 255]]
        );
    }

    #[test]
    fn a_selected_pixel_copy_leaves_the_source_in_place() {
        let mut d = lift_doc();
        d.transform_selected_pixels(1, &tr(4.0, 0.0), Interp::Nearest, None, true).unwrap();
        assert_eq!(
            grid(&d, 1, [0, 0, 6, 1]),
            vec![[255, 0, 0, 255], [255, 0, 0, 128], [0; 4], [0; 4], [255, 0, 0, 255], [128, 0, 127, 255]]
        );
        assert_eq!(d.selection_bounds(), Some([4, 0, 2, 1]));
    }

    #[test]
    fn transform_selection_resamples_the_coverage() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.select_rect(2.0, 2.0, 4.0, 4.0, Mode::New).unwrap();
        let mut moved = d.clone();
        moved.transform_selection(&tr(10.0, 0.0), Interp::Bicubic).unwrap();
        assert_eq!(moved.selection_bounds(), Some([12, 2, 4, 4]));
        let mut scaled = d.clone();
        scaled.transform_selection(&[2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 1.0], Interp::Nearest).unwrap();
        assert_eq!(scaled.selection_bounds(), Some([4, 4, 8, 8]));
        // Coverage past the canvas edge is dropped.
        let mut out = d.clone();
        out.transform_selection(&tr(252.0, 0.0), Interp::Nearest).unwrap();
        assert_eq!(out.selection_bounds(), Some([254, 2, 2, 4]));
        assert_eq!(Document::new(8, 8, 8).unwrap().transform_selection(&ID, Interp::Nearest).unwrap_err(), "nothing is selected");
    }

    #[test]
    fn each_op_is_one_snapshot_step() {
        let ops: [fn(&mut Document); 4] = [
            |d| d.transform_layer(1, &tr(1.5, 0.0), Interp::Bicubic).unwrap(),
            |d| d.transform_selection(&tr(1.0, 0.0), Interp::Nearest).unwrap(),
            |d| d.transform_selected_pixels(1, &tr(4.0, 0.0), Interp::Nearest, None, false).unwrap(),
            |d| d.rotate_layer_exact(1, Remap::Cw).unwrap(),
        ];
        for op in ops {
            // Restores keep tile ids growing, so `next_id` is left out of the comparison.
            let state = |d: &Document| {
                let mut v: serde_json::Value = serde_json::from_str(&d.manifest()).unwrap();
                v.as_object_mut().unwrap().remove("next_id");
                v
            };
            let mut core = EngineCore::new(lift_doc());
            let before = state(&core.doc);
            let snap = core.snapshot();
            op(&mut core.doc);
            assert_ne!(state(&core.doc), before);
            core.restore(snap).unwrap();
            assert_eq!(state(&core.doc), before);
        }
    }

    #[test]
    fn locks_and_bad_input_are_refused() {
        let mut d = sample_doc();
        d.set_props(1, r#"{"locks":{"transparency":false,"pixels":false,"position":true}}"#).unwrap();
        assert_eq!(d.transform_layer(1, &ID, Interp::Bicubic).unwrap_err(), "layer position is locked");
        assert_eq!(matrix(&[1.0; 8]).unwrap_err(), "transform matrix must have 9 finite values");
        assert_eq!(Interp::parse("cubic").unwrap_err(), "unknown interpolation cubic");
        assert_eq!(Remap::parse("cw90").unwrap_err(), "unknown remap cw90");
    }

    #[test]
    fn preview_renders_the_layer_into_a_proxy_rect() {
        let d = sample_doc();
        let out = d.transform_preview(1, &ID, 1.0, false, [5, 5, 3, 3]).unwrap();
        let want: Vec<u8> = grid(&d, 1, [5, 5, 3, 3]).concat();
        assert_eq!(out, want);
        // Half-size proxy: the 3x3 block becomes about 2x2 at (2.5, 2.5), bilinear.
        let half = d.transform_preview(1, &ID, 0.5, false, [0, 0, 8, 8]).unwrap();
        assert_eq!(half.len(), 8 * 8 * 4);
        assert!(half[(3 * 8 + 3) * 4 + 3] > 0);
        assert_eq!(half[(7 * 8 + 7) * 4 + 3], 0);
        // Clipped to the canvas + 64 px.
        let far = d.transform_preview(1, &tr(-100.0, 0.0), 1.0, false, [-95, 5, 3, 3]).unwrap();
        assert!(far.iter().all(|v| *v == 0));
    }

    // Deterministic noise over a w x h layer; alpha 255, or noise too when `alpha` is set.
    fn noise_doc(w: u32, h: u32, alpha: bool) -> Document {
        let mut d = Document::new(w, h, 8).unwrap();
        let mut seed = 1u32;
        for ty in 0..h.div_ceil(T as u32) {
            for tx in 0..w.div_ceil(T as u32) {
                let data: Vec<u8> = (0..TILE_PIXELS * 4)
                    .map(|i| {
                        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                        let (x, y) = (tx * T as u32 + (i / 4 % TILE) as u32, ty * T as u32 + (i / 4 / TILE) as u32);
                        match (i % 4 == 3, x < w && y < h) {
                            (true, false) => 0,
                            (true, true) if !alpha => 255,
                            _ => (seed >> 24) as u8,
                        }
                    })
                    .collect();
                d.set_tile_rgba8(1, tx, ty, &data).unwrap();
            }
        }
        d
    }

    // FNV-1a over the layer's tiles in coordinate order.
    fn layer_hash(d: &Document, id: u32) -> u64 {
        let tiles = d.node(id).unwrap().pixel_tiles().unwrap();
        let mut h = 0xcbf29ce484222325u64;
        for (tx, ty) in tiles.coords() {
            let bytes = tiles.get(tx, ty).unwrap().px.to_bytes();
            for b in tx.to_le_bytes().iter().chain(&ty.to_le_bytes()).chain(&bytes) {
                h = (h ^ *b as u64).wrapping_mul(0x100000001b3);
            }
        }
        h
    }

    fn rotation(deg: f64, cx: f64, cy: f64) -> [f64; 9] {
        let (s, c) = deg.to_radians().sin_cos();
        [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0.0, 0.0, 1.0]
    }

    #[test]
    #[ignore]
    fn timing_4k_bicubic_rotate() {
        let mut d = noise_doc(3840, 2160, false);
        let m = rotation(30.0, 1920.0, 1080.0);
        let t = std::time::Instant::now();
        d.transform_layer(1, &m, Interp::Bicubic).unwrap();
        println!("4K bicubic rotate: {} ms, hash {:016x}", t.elapsed().as_millis(), layer_hash(&d, 1));
    }
}
