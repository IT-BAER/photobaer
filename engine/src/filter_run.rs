//! Filter runner and Fade (docs/M5.md sections 1-2). A destructive filter writes its output rect
//! tile by tile in document coordinates; each tile reads its neighbors for the filter's reach,
//! so the result equals one whole-layer run. Reads outside the document repeat its edge pixels.

use super::transform::{all_default, intersect, tile_span};
use super::*;
use crate::filters::{Ctx, Exec, PKind, Plane};
use crate::liquify::{Liquify, Mesh};

const NOTHING: &str = "There is nothing to filter here.";
const NO_MATCH: &str = "The previous state has no matching layer to fade toward.";
const TI: i32 = TILE as i32;

fn grow(r: [i32; 4], n: i32) -> [i32; 4] {
    [r[0] - n, r[1] - n, r[2] + 2 * n, r[3] + 2 * n]
}

fn empty(r: [i32; 4]) -> bool {
    r[2] <= 0 || r[3] <= 0
}

// The rect of the tiles present: a preview's cheap stand-in for the tight layer bounds.
fn tile_bounds(t: &Tiles) -> Option<[i32; 4]> {
    let c = t.coords();
    let (x0, y0) = (c.iter().map(|c| c.0).min()?, c.iter().map(|c| c.1).min()?);
    let (x1, y1) = (c.iter().map(|c| c.0).max()?, c.iter().map(|c| c.1).max()?);
    Some([x0 * TI, y0 * TI, (x1 - x0 + 1) * TI, (y1 - y0 + 1) * TI])
}

// A filter target: a layer's pixels, or a single-channel plane (layer mask, quick mask) with its
// default value, read as opaque gray.
enum Src {
    Pixels(Tiles),
    Gray(Tiles, f32),
}

impl Src {
    fn tiles(&self) -> &Tiles {
        match self {
            Src::Pixels(t) | Src::Gray(t, _) => t,
        }
    }

    fn value(&self, t: Option<&Tile>, p: usize) -> [f32; 4] {
        match self {
            Src::Pixels(_) => t.map_or([0.0; 4], |t| t.px.rgba_f32(p)),
            Src::Gray(_, def) => {
                let v = t.map_or(*def, |t| t.px.mask_f32(p));
                [v, v, v, 1.0]
            }
        }
    }

    fn read(&self, x: i32, y: i32) -> [f32; 4] {
        self.value(self.tiles().get(x.div_euclid(TI), y.div_euclid(TI)), (y.rem_euclid(TI) * TI + x.rem_euclid(TI)) as usize)
    }

    // Straight RGBA over `r`, coordinates clamped into `doc`.
    fn plane(&self, r: [i32; 4], doc: [i32; 4]) -> Plane {
        let (w, h) = (r[2] as usize, r[3] as usize);
        let mut data = vec![0f32; w * h * 4];
        for j in 0..h {
            let y = (r[1] + j as i32).clamp(doc[1], doc[1] + doc[3] - 1);
            for i in 0..w {
                let x = (r[0] + i as i32).clamp(doc[0], doc[0] + doc[2] - 1);
                data[(j * w + i) * 4..][..4].copy_from_slice(&self.read(x, y));
            }
        }
        Plane { x: r[0], y: r[1], w, h, data }
    }
}

// Channel `c` of a filter result kept in range: 0..1, color only floored at 0 when `hdr` (32-bit).
fn unit(v: f32, c: usize, hdr: bool) -> f32 {
    if hdr && c < 3 {
        v.max(0.0)
    } else {
        v.clamp(0.0, 1.0)
    }
}

fn at(p: &Plane, x: i32, y: i32, hdr: bool) -> [f32; 4] {
    let i = ((y - p.y) as usize * p.w + (x - p.x) as usize) * 4;
    std::array::from_fn(|c| unit(p.data[i + c], c, hdr))
}

// A filter result: a full-resolution plane, or a preview proxy sampled back bilinearly.
enum Res {
    Full(Plane),
    Proxy { small: Plane, cols: Vec<(usize, usize, f32)>, rows: Vec<(usize, usize, f32)>, out: [i32; 4] },
}

impl Res {
    fn at(&self, x: i32, y: i32, hdr: bool) -> [f32; 4] {
        match self {
            Res::Full(p) => at(p, x, y, hdr),
            Res::Proxy { small, cols, rows, out } => {
                let ((u0, u1, fu), (v0, v1, fv)) = (cols[(x - out[0]) as usize], rows[(y - out[1]) as usize]);
                let px = |u: usize, v: usize| &small.data[(v * small.w + u) * 4..][..4];
                std::array::from_fn(|c| {
                    let top = px(u0, v0)[c] * (1.0 - fu) + px(u1, v0)[c] * fu;
                    let bot = px(u0, v1)[c] * (1.0 - fu) + px(u1, v1)[c] * fu;
                    unit(top * (1.0 - fv) + bot * fv, c, hdr)
                })
            }
        }
    }
}

// Bilinear taps along one axis: output offsets from `o` in a proxy of `n` samples scaled by `s`
// from origin `r`.
fn taps(r: i32, o: i32, len: i32, n: usize, s: f64) -> Vec<(usize, usize, f32)> {
    (0..len)
        .map(|k| {
            let u = ((o - r) as f64 + k as f64 + 0.5) * s - 0.5;
            let u0 = u.floor().clamp(0.0, (n - 1) as f64) as usize;
            (u0, (u0 + 1).min(n - 1), (u - u.floor()) as f32)
        })
        .collect()
}

// A straight RGBA proxy of `r` at `s` px per document px: premultiplied averages of a strided
// sample grid (about 2 samples per proxy pixel per axis).
fn downsample(src: &Src, r: [i32; 4], doc: [i32; 4], s: f64) -> Plane {
    let (pw, ph) = (((r[2] as f64 * s).ceil() as usize).max(1), ((r[3] as f64 * s).ceil() as usize).max(1));
    let step = ((0.5 / s) as usize).max(1);
    let mut acc = vec![0f64; pw * ph * 5];
    for j in (0..r[3] as usize).step_by(step) {
        let pj = ((j as f64 * s) as usize).min(ph - 1);
        let y = (r[1] + j as i32).clamp(doc[1], doc[1] + doc[3] - 1);
        let mut tile = (i32::MIN, None);
        for i in (0..r[2] as usize).step_by(step) {
            let pi = ((i as f64 * s) as usize).min(pw - 1);
            let x = (r[0] + i as i32).clamp(doc[0], doc[0] + doc[2] - 1);
            if tile.0 != x.div_euclid(TI) {
                tile = (x.div_euclid(TI), src.tiles().get(x.div_euclid(TI), y.div_euclid(TI)));
            }
            let v = src.value(tile.1, (y.rem_euclid(TI) * TI + x.rem_euclid(TI)) as usize);
            let a = &mut acc[(pj * pw + pi) * 5..][..5];
            for c in 0..3 {
                a[c] += (v[c] * v[3]) as f64;
            }
            a[3] += v[3] as f64;
            a[4] += 1.0;
        }
    }
    let mut small = Plane { x: (r[0] as f64 * s) as i32, y: (r[1] as f64 * s) as i32, w: pw, h: ph, data: vec![0.0; pw * ph * 4] };
    for (k, a) in acc.chunks_exact(5).enumerate() {
        let n = a[4].max(1.0);
        let alpha = a[3] / n;
        for c in 0..3 {
            small.data[k * 4 + c] = if alpha > 0.0 { (a[c] / n / alpha) as f32 } else { 0.0 };
        }
        small.data[k * 4 + 3] = alpha as f32;
    }
    small
}

// The preview proxy of `r`, filtered with px params scaled by `s`, sampled back over `out`.
fn proxy(src: &Src, f: &Filter, r: [i32; 4], out: [i32; 4], doc: [i32; 4], s: f64, ctx: &Ctx) -> Result<Res, String> {
    let mut small = downsample(src, r, doc, s);
    let (pw, ph) = (small.w, small.h);
    filters::apply(&f.scaled(s), &mut small, &Ctx { scale: s, ..*ctx })?;
    Ok(Res::Proxy { cols: taps(r[0], out[0], out[2], pw, s), rows: taps(r[1], out[1], out[3], ph, s), small, out })
}

// One preview tile of layer pixels without a selection: `old` (or transparent) with the proxy
// written over `o`. Rows are interpolated once over the proxy columns the tile needs, clamped (`unit`)
// and scaled to `max` there, so a pixel costs one lerp and a cast per channel.
#[allow(clippy::too_many_arguments)]
fn preview_tile<T: Copy + Default>(old: Option<&[T]>, o: [i32; 4], at: (i32, i32), res: &Res, keep_alpha: bool, max: f32, hdr: bool, cast: impl Fn(f32) -> T, alpha: impl Fn(T) -> f32) -> Box<[T]> {
    let Res::Proxy { small, cols, rows, out } = res else { unreachable!("preview tiles come from a proxy") };
    let whole = o[2] == TI && o[3] == TI;
    let mut buf: Box<[T]> = match old {
        Some(d) if !whole || keep_alpha => d.into(),
        _ => vec![T::default(); TILE_PIXELS * 4].into(),
    };
    let (c0, c1) = ((o[0] - out[0]) as usize, (o[0] + o[2] - out[0]) as usize);
    let (lo, hi) = (cols[c0].0, cols[c1 - 1].1);
    let mut line = vec![0f32; (hi - lo + 1) * 4];
    for y in o[1]..o[1] + o[3] {
        let (v0, v1, fv) = rows[(y - out[1]) as usize];
        let (a, b) = (&small.data[(v0 * small.w + lo) * 4..], &small.data[(v1 * small.w + lo) * 4..]);
        for (k, l) in line.iter_mut().enumerate() {
            *l = unit(a[k] + (b[k] - a[k]) * fv, k % 4, hdr) * max + 0.5;
        }
        let base = ((y - at.1 * TI) * TI + o[0] - at.0 * TI) as usize * 4;
        for (px, &(u0, u1, fu)) in buf[base..base + o[2] as usize * 4].chunks_exact_mut(4).zip(&cols[c0..c1]) {
            let (a, b) = (&line[(u0 - lo) * 4..][..4], &line[(u1 - lo) * 4..][..4]);
            for c in 0..3 {
                px[c] = cast(a[c] + (b[c] - a[c]) * fu);
            }
            if !keep_alpha {
                px[3] = cast(a[3] + (b[3] - a[3]) * fu);
            } else if alpha(px[3]) == 0.0 {
                px[..3].fill(T::default());
            }
        }
    }
    buf
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FadeIn {
    opacity: f32,
    mode: String,
}

impl Document {
    /// Destructive filter `json` on layer `id`'s pixels or mask, or on the quick mask. With a
    /// selection the result mixes by its coverage. `view` limits the output to a rect (a live
    /// preview); `scale` below 1 runs a downsampled proxy there. On a smart object the filter is
    /// appended to its stack instead, masked to the selection.
    pub fn apply_filter(&mut self, id: u32, target: Target, json: &str, view: Option<[i32; 4]>, scale: f32) -> Result<(), String> {
        self.check_idle()?;
        if !(scale > 0.0 && scale <= 1.0) {
            return Err("the preview scale must be in (0, 1]".into());
        }
        let f = Filter::parse(json)?;
        self.check_blob(f.blob())?;
        let spec = f.spec()?;
        if self.depth == 32 && !spec.hdr() {
            return Err(format!("{} is not available for 32-bit images.", spec.label));
        }
        let doc = [0, 0, self.width as i32, self.height as i32];
        let max = self.max();
        let (src, bounds, refb) = match target {
            Target::Pixels => {
                self.check_pixel_edit(id)?;
                if matches!(self.node(id)?.kind, Kind::Smart(_)) {
                    let mask = self.selection.as_ref().map(|s| Mask { enabled: true, default: s.default, tiles: s.tiles.clone() });
                    return self.push_filter(id, f, mask, None).map(|_| ());
                }
                let grown = |b: [i32; 4]| if spec.keep_alpha || spec.exec == Exec::Global { b } else { grow(b, f.reach()) };
                let tiles = self.node(id)?.pixel_tiles()?.clone();
                // Point, pin and path params are fractions of the tight bounds, so only they pay for them in a preview.
                let exact = spec.params.iter().any(|p| matches!(p.kind, PKind::Point | PKind::Pins | PKind::Paths));
                // Render filters fill empty layers; Liquify and the warps move pixels into empty
                // areas (the warps read the tight bounds as their source rect).
                let b = if spec.group == "render" || spec.id == "liquify" || spec.extent.is_some() {
                    Some(doc)
                } else if scale < 1.0 && !exact {
                    tile_bounds(&tiles)
                } else {
                    self.layer_bounds(id)?
                };
                let refb = if spec.extent.is_some() { self.layer_bounds(id)?.unwrap_or(doc) } else { b.unwrap_or(doc) };
                (Src::Pixels(tiles), b.map(grown), refb)
            }
            Target::Mask => {
                let m = self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?;
                (Src::Gray(m.tiles.clone(), m.default as f32 / max), Some(doc), doc)
            }
            Target::Selection => {
                let s = self.selection.clone().unwrap_or_default();
                (Src::Gray(s.tiles, s.default as f32 / max), Some(doc), doc)
            }
        };
        let mask = match target {
            Target::Pixels => self.node(id)?.mask.as_ref().map(|m| Src::Gray(m.tiles.clone(), m.default as f32 / max)),
            _ => None,
        };
        let mask_at = mask.as_ref().map(|m| move |x: i32, y: i32| m.read(x, y)[0]);
        let selected = target != Target::Selection && self.selection.is_some();
        let sel_rect = if selected { Some(self.selection_bounds().unwrap_or([0, 0, 0, 0])) } else { None };
        let full = bounds.map(|b| sel_rect.map_or(intersect(b, doc), |s| intersect(intersect(b, doc), s))).filter(|r| !empty(*r));
        let out = full.map(|r| view.map_or(r, |v| intersect(r, v))).filter(|r| !empty(*r));
        let (Some(full), Some(out)) = (full, out) else {
            return if view.is_some() { Ok(()) } else { Err(NOTHING.into()) };
        };
        let reach = f.reach().max(0);
        let ctx = Ctx { blobs: &self.blobs, cov: None, bounds: refb, scale: 1.0, mask: mask_at.as_ref().map(|f| f as &dyn Fn(i32, i32) -> f32) };
        let shared = if scale < 1.0 {
            Some(proxy(&src, &f, intersect(grow(out, reach), grow(doc, reach)), out, doc, scale as f64, &ctx)?)
        } else if spec.exec == Exec::Global {
            // The whole layer, not just the selection rect: the coverage keeps the output inside.
            let whole = bounds.map_or(full, |b| intersect(b, doc));
            let mut p = src.plane(whole, doc);
            let cov: Option<Vec<f32>> = self.selection.as_ref().filter(|_| selected).map(|sel| {
                (0..p.w * p.h).map(|i| self.sel_at(sel, whole[0] + (i % p.w) as i32, whole[1] + (i / p.w) as i32)).collect()
            });
            filters::apply(&f, &mut p, &Ctx { cov: cov.as_deref(), ..ctx })?;
            Some(Res::Full(p))
        } else {
            None
        };
        let depth = self.depth;
        if let (Some(res @ Res::Proxy { .. }), Src::Pixels(tiles), false) = (&shared, &src, selected) {
            let max = max_value(depth) as f32;
            let mut put = Vec::new();
            for (tx, ty) in tile_span(out) {
                let o = intersect([tx * TI, ty * TI, TI, TI], out);
                let old = tiles.get(tx, ty).map(|t| &*t.px);
                let px = if depth == 8 {
                    let d = if let Some(Pixels::U8(d)) = old { Some(&d[..]) } else { None };
                    Pixels::U8(preview_tile(d, o, (tx, ty), res, spec.keep_alpha, max, false, |v| v as u8, |a| a as f32))
                } else if depth == 32 {
                    let d = if let Some(Pixels::F32(d)) = old { Some(&d[..]) } else { None };
                    Pixels::F32(preview_tile(d, o, (tx, ty), res, spec.keep_alpha, 1.0, true, |v| (v - 0.5).max(0.0), |a| a))
                } else {
                    let d = if let Some(Pixels::U16(d)) = old { Some(&d[..]) } else { None };
                    Pixels::U16(preview_tile(d, o, (tx, ty), res, spec.keep_alpha, max, false, |v| v as u16, |a| a as f32))
                };
                put.push(((tx, ty), px.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
            }
            let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
            for ((tx, ty), t) in put {
                tiles.put(tx, ty, t);
            }
            return Ok(());
        }
        let mut fresh: Vec<((i32, i32), Vec<f32>)> = Vec::new();
        for (tx, ty) in tile_span(out) {
            let o = intersect([tx * TI, ty * TI, TI, TI], out);
            let local;
            let res = match &shared {
                Some(p) => p,
                None => {
                    let mut p = src.plane(grow(o, reach), doc);
                    filters::apply(&f, &mut p, &ctx)?;
                    local = Res::Full(p);
                    &local
                }
            };
            let cov = selected.then(|| self.coverage(tx, ty));
            let c_at = |p: usize| cov.as_ref().map_or(1.0, |c| c.at(p).clamp(0.0, 1.0));
            let tile = match &src {
                Src::Pixels(tiles) => {
                    let mut buf = vec![0f32; TILE_PIXELS * 4];
                    if let Some(t) = tiles.get(tx, ty) {
                        for p in 0..TILE_PIXELS {
                            buf[p * 4..p * 4 + 4].copy_from_slice(&t.px.rgba_f32(p));
                        }
                    }
                    for y in o[1]..o[1] + o[3] {
                        for x in o[0]..o[0] + o[2] {
                            let p = ((y - ty * TI) * TI + x - tx * TI) as usize;
                            let (n, c) = (res.at(x, y, depth == 32), c_at(p));
                            let old: [f32; 4] = buf[p * 4..p * 4 + 4].try_into().expect("4 channels");
                            let v = if spec.keep_alpha {
                                [old[0] + (n[0] - old[0]) * c, old[1] + (n[1] - old[1]) * c, old[2] + (n[2] - old[2]) * c, old[3]]
                            } else {
                                let a = old[3] + (n[3] - old[3]) * c;
                                let m = |k: usize| if a > 0.0 { (old[k] * old[3] + (n[k] * n[3] - old[k] * old[3]) * c) / a } else { 0.0 };
                                [m(0), m(1), m(2), a]
                            };
                            buf[p * 4..p * 4 + 4].copy_from_slice(&v);
                        }
                    }
                    buf
                }
                Src::Gray(tiles, def) => {
                    let mut vals = vec![*def; TILE_PIXELS];
                    if let Some(t) = tiles.get(tx, ty) {
                        for (p, v) in vals.iter_mut().enumerate() {
                            *v = t.px.mask_f32(p);
                        }
                    }
                    for y in o[1]..o[1] + o[3] {
                        for x in o[0]..o[0] + o[2] {
                            let p = ((y - ty * TI) * TI + x - tx * TI) as usize;
                            let n = res.at(x, y, false);
                            vals[p] += ((n[0] + n[1] + n[2]) / 3.0 - vals[p]) * c_at(p);
                        }
                    }
                    vals
                }
            };
            fresh.push(((tx, ty), tile));
        }
        match target {
            Target::Pixels => {
                let mut put = Vec::with_capacity(fresh.len());
                for (at, buf) in fresh {
                    let px = Pixels::from_straight(depth, &buf);
                    put.push((at, px.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
                }
                let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
                for ((tx, ty), t) in put {
                    tiles.put(tx, ty, t);
                }
            }
            Target::Mask => {
                let def = self.node(id)?.mask.as_ref().expect("checked").default;
                let mut put = Vec::with_capacity(fresh.len());
                for (at, vals) in fresh {
                    let px = Pixels::mask_from_norm(depth, &vals);
                    put.push((at, (!all_default(&px, def)).then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
                }
                let m = self.node_mut(id)?.mask.as_mut().expect("checked");
                for ((tx, ty), t) in put {
                    m.tiles.put(tx, ty, t);
                }
            }
            Target::Selection => {
                let mut sel = self.selection.take().unwrap_or_default();
                for ((tx, ty), vals) in fresh {
                    self.set_sel_tile(&mut sel, tx, ty, &vals);
                }
                self.selection = Some(sel);
            }
        }
        Ok(())
    }

    /// A Liquify session on layer `id`: its pixels over the document rect as a proxy of at most
    /// `max_side` px, and an empty mesh; or, re-editing Liquify smart filter `filter_id`, its mesh
    /// over the smart object rendered through the filters below it.
    pub fn liquify_begin(&mut self, id: u32, max_side: u32, spacing: u32, filter_id: Option<u32>) -> Result<Liquify, String> {
        self.check_pixel_edit(id)?;
        let (mesh, tiles) = match filter_id {
            None => (Mesh::new(self.width, self.height, spacing), self.node(id)?.pixel_tiles()?.clone()),
            Some(fid) => {
                let s = self.smart(id)?;
                let i = s.filters.iter().position(|f| f.id == fid).ok_or_else(|| format!("smart object {id} has no filter {fid}"))?;
                let f = &s.filters[i].filter;
                let mesh = match f.kind.as_str() {
                    "liquify" => {
                        let b = f.blob().ok_or("Liquify needs a mesh")?;
                        Mesh::from_bytes(self.blobs.get(&b).ok_or_else(|| format!("unknown blob {b}"))?)?
                    }
                    // The Vanishing Point dialog reads the same proxy of the input below its filter.
                    "vanishing_point" => Mesh::new(self.width, self.height, spacing),
                    _ => return Err("That smart filter is not Liquify.".into()),
                };
                let (t, warp, below, stack) = (s.transform, s.warp.clone(), s.filters[..i].to_vec(), s.stack_mask.clone());
                let (src, size) = self.placement_source(id)?;
                let base = self.smart_render(&src, size, &t, warp.as_ref())?;
                let layer = self.node(id)?.mask.clone();
                (mesh, self.filtered(base, &below, stack.as_ref(), layer.as_ref())?)
            }
        };
        let doc = [0, 0, self.width as i32, self.height as i32];
        let s = (max_side.max(1) as f64 / self.width.max(self.height) as f64).min(1.0);
        let mut p = downsample(&Src::Pixels(tiles), doc, doc, s);
        p.premultiply();
        Ok(Liquify::new(mesh, p.data, p.w, p.h, s as f32))
    }

    /// A Puppet Warp mesh (JSON of `puppet::Grid`) over layer `id`'s opaque pixels, read from a
    /// proxy whose long side is at most 768 px.
    pub fn puppet_mesh(&self, id: u32, density: &str, expansion: f64) -> Result<String, String> {
        self.check_pixel_edit(id)?;
        let b = self.layer_bounds(id)?.ok_or(crate::puppet::EMPTY)?;
        let s = (768.0 / b[2].max(b[3]) as f64).min(1.0);
        let p = downsample(&Src::Pixels(self.node(id)?.pixel_tiles()?.clone()), b, b, s);
        let alpha: Vec<f32> = p.data.chunks_exact(4).map(|px| px[3]).collect();
        let g = crate::puppet::build(&alpha, p.w, p.h, (b[0] as f64, b[1] as f64), s, density, expansion.clamp(-50.0, 50.0)).ok_or(crate::puppet::EMPTY)?;
        serde_json::to_string(&g).map_err(|e| e.to_string())
    }

    /// Mask Options from the selection (`source` "selection") or layer `id`'s transparency, read
    /// at the mesh nodes and combined by `op` (replace, add, subtract, intersect, invertSelection).
    pub fn liquify_mask(&self, l: &mut Liquify, id: u32, source: &str, op: &str) -> Result<(), String> {
        let m = l.mesh();
        let (cols, rows, sp) = (m.cols, m.rows, m.spacing as i32);
        let (w, h) = (self.width as i32 - 1, self.height as i32 - 1);
        let at = |u: usize, v: usize| ((u as i32 * sp).clamp(0, w), (v as i32 * sp).clamp(0, h));
        let vals: Vec<f32> = match source {
            "selection" => match &self.selection {
                Some(sel) => (0..cols * rows).map(|k| { let (x, y) = at(k % cols, k / cols); self.sel_at(sel, x, y) }).collect(),
                None => vec![0.0; cols * rows],
            },
            "transparency" => {
                let src = Src::Pixels(self.node(id)?.pixel_tiles()?.clone());
                (0..cols * rows).map(|k| { let (x, y) = at(k % cols, k / cols); src.read(x, y)[3] }).collect()
            }
            _ => return Err(format!("unknown mask source \"{source}\"")),
        };
        l.mesh_mut().mask(op, &vals)
    }

    /// Edit > Fade: blends layer `id` toward its pixels in `prev` (the state before the last step)
    /// by JSON `{ opacity (0..100), mode }`.
    pub fn fade(&mut self, id: u32, prev: &Document, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let p: FadeIn = serde_json::from_str(json).map_err(|e| format!("invalid fade: {e}"))?;
        if !(0.0..=100.0).contains(&p.opacity) {
            return Err("Fade opacity must be in 0..=100".into());
        }
        let mode = Blend::parse(&p.mode)?;
        if mode == Blend::PassThrough {
            return Err("pass through is only allowed on groups".into());
        }
        let Kind::Pixel(cur) = &self.node(id)?.kind else { return Err("Fade needs a pixel layer.".into()) };
        let cur = cur.clone();
        self.check_pixel_edit(id)?;
        let old = match prev.node(id).map(|n| &n.kind) {
            Ok(Kind::Pixel(t)) if prev.depth == self.depth => t.clone(),
            _ => return Err(NO_MATCH.into()),
        };
        let d = p.opacity / 100.0;
        let mut coords = cur.coords();
        coords.extend(old.coords());
        coords.sort_unstable();
        coords.dedup();
        let mut put = Vec::with_capacity(coords.len());
        for (tx, ty) in coords {
            let (c, o) = (cur.get(tx, ty), old.get(tx, ty));
            let mut buf = vec![0f32; TILE_PIXELS * 4];
            for (px, v) in buf.chunks_exact_mut(4).enumerate() {
                let c = c.map_or([0.0; 4], |t| t.px.rgba_f32(px));
                let o = o.map_or([0.0; 4], |t| t.px.rgba_f32(px));
                let out = if mode == Blend::Normal {
                    let (x, b) = (c[3] * d, o[3] * (1.0 - d));
                    let s = x + b;
                    let m = |k: usize| if s > 0.0 { (c[k] * x + o[k] * b) / s } else { 0.0 };
                    [m(0), m(1), m(2), s]
                } else {
                    paint_pixel_hdr(PaintMode::Blend(mode), o, [c[0], c[1], c[2]], c[3] * d, false, self.depth == 32)
                };
                v.copy_from_slice(&out);
            }
            let px = Pixels::from_straight(self.depth, &buf);
            put.push(((tx, ty), px.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in put {
            tiles.put(tx, ty, t);
        }
        Ok(())
    }
}
