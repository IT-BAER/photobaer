//! Canvas operations: crop, trim, reveal all, canvas rotation and perspective crop.
//! A child module of `doc`, so it reaches the document's private tile storage.

use super::transform::{check_area, intersect, tile_rect, tile_span};
use super::*;
use crate::path::{Axis, Bounds, Live, VectorPath};
use crate::resample::{Interp, Plane, Resampler};

const DEGENERATE: &str = "Those four corners are degenerate; move one and try again.";
const TOO_FAR: &str = "the canvas change moves a layer too far";
const TI: i32 = TILE as i32;

/// One raster plane of the document: a node's pixels or mask, the selection, the last
/// selection, or a saved channel (by index).
#[derive(Clone, Copy)]
enum At {
    Pixels(u32),
    Mask(u32),
    // A smart object's filter mask (filter index) or its stack mask.
    FilterMask(u32, usize),
    StackMask(u32),
    // A text layer's rendered or imported pixels.
    TextCache(u32),
    Selection,
    LastSelection,
    Channel(usize),
}

impl At {
    // The selection and saved channels are canvas-sized and keep no tile off the canvas.
    fn canvas_bound(self) -> bool {
        matches!(self, At::Selection | At::LastSelection | At::Channel(_))
    }
}

fn collect_ids(nodes: &[Node], out: &mut Vec<u32>) {
    for n in nodes {
        out.push(n.id);
        if let Kind::Group(ch) = &n.kind {
            collect_ids(ch, out);
        }
    }
}

// Row-major 3x3 product a * b.
pub(super) fn mul3(a: &[f64; 9], b: &[f64; 9]) -> [f64; 9] {
    let mut o = [0.0; 9];
    for r in 0..3 {
        for c in 0..3 {
            o[r * 3 + c] = (0..3).map(|k| a[r * 3 + k] * b[k * 3 + c]).sum();
        }
    }
    o
}

// `m` (old canvas px -> new canvas px, projective) applied to one point.
pub(super) fn map_pt(m: &[f64; 9], x: f64, y: f64) -> (f64, f64) {
    let w = m[6] * x + m[7] * y + m[8];
    ((m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w)
}

// Every anchor and handle through `m`. ponytail: under a perspective `m` the mapped handles
// only approximate the projected curve; subdivide first if perspective crops of curves matter.
pub(super) fn map_path(m: &[f64; 9], p: &mut VectorPath) {
    for pt in p.subpaths.iter_mut().flat_map(|s| s.points.iter_mut()) {
        for i in [0, 2, 4] {
            (pt[i], pt[i + 1]) = map_pt(m, pt[i], pt[i + 1]);
        }
    }
}

// The bbox of rect [l, t, r, b] under `m`.
pub(super) fn map_bounds(m: &[f64; 9], b: &mut Bounds) {
    let c = [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3])].map(|(x, y)| map_pt(m, x, y));
    let (xs, ys) = (c.map(|p| p.0), c.map(|p| p.1));
    *b = [xs.iter().copied().fold(f64::INFINITY, f64::min), ys.iter().copied().fold(f64::INFINITY, f64::min),
        xs.iter().copied().fold(f64::NEG_INFINITY, f64::max), ys.iter().copied().fold(f64::NEG_INFINITY, f64::max)];
}

// Moves every node's vector data with the canvas: smart placements, shape paths (live bounds as
// their mapped bbox), vector masks, text transforms (the affine part of `m`) and artboard rects.
fn remap_nodes(nodes: &mut [Node], m: &[f64; 9]) {
    for n in nodes {
        if let Some(vm) = &mut n.vector_mask {
            map_path(m, &mut vm.path);
        }
        if let Some(a) = &mut n.artboard {
            map_bounds(m, &mut a.rect);
        }
        match &mut n.kind {
            Kind::Group(ch) => remap_nodes(ch, m),
            Kind::Smart(s) => (s.transform, s.warp) = super::smart::moved(s, m),
            Kind::Shape(s) => {
                map_path(m, &mut s.path);
                match &mut s.live {
                    Some(Live::Line { start, end }) => {
                        for p in [start, end] {
                            (p[0], p[1]) = map_pt(m, p[0], p[1]);
                        }
                    }
                    Some(
                        Live::Rectangle { bounds, .. }
                        | Live::RoundedRectangle { bounds, .. }
                        | Live::Ellipse { bounds }
                        | Live::Triangle { bounds, .. }
                        | Live::Polygon { bounds, .. }
                        | Live::Custom { bounds },
                    ) => map_bounds(m, bounds),
                    None => {}
                }
            }
            Kind::Text(t) => {
                // ponytail: affine part only; a perspective crop keeps the warped cache exact.
                let [a, b, c, d, e, f] = t.data.transform;
                t.data.transform = [
                    m[0] * a + m[1] * b,
                    m[3] * a + m[4] * b,
                    m[0] * c + m[1] * d,
                    m[3] * c + m[4] * d,
                    m[0] * e + m[1] * f + m[2],
                    m[3] * e + m[4] * f + m[5],
                ];
            }
            _ => {}
        }
    }
}

// floor(x0), floor(y0), ceil(x1), ceil(y1) as [x, y, w, h]; w and h are at least 0.
fn round_out(x0: f64, y0: f64, x1: f64, y1: f64) -> Result<[i32; 4], String> {
    let lim = (1u64 << 29) as f64;
    let (a, b, c, d) = (x0.floor(), y0.floor(), x1.ceil(), y1.ceil());
    if ![a, b, c, d].iter().all(|v| v.abs() < lim) {
        return Err(TOO_FAR.into());
    }
    Ok([a as i32, b as i32, (c - a).max(0.0) as i32, (d - b).max(0.0) as i32])
}

fn check_shift(tiles: &Tiles, dx: i32, dy: i32) -> Result<(), String> {
    let (t, lim) = (TILE as i64, MAX_TILE_COORD as i64);
    for (tx, ty) in tiles.coords() {
        for (v, d) in [(tx, dx), (ty, dy)] {
            let lo = (v as i64 * t + d as i64).div_euclid(t);
            if lo < -lim || lo + 1 > lim {
                return Err(TOO_FAR.into());
            }
        }
    }
    Ok(())
}

// Forward canvas rotation by `a` degrees (normalized to [0, 360), clockwise in y-down) as a
// 3x3 matrix moved so the new canvas starts at 0, and the new canvas rect.
fn canvas_turn(w: f64, h: f64, a: f64) -> ([f64; 9], [i32; 4]) {
    let mut m = if a == 90.0 {
        [0.0, -1.0, h, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]
    } else if a == 180.0 {
        [-1.0, 0.0, w, 0.0, -1.0, h, 0.0, 0.0, 1.0]
    } else if a == 270.0 {
        [0.0, 1.0, 0.0, -1.0, 0.0, w, 0.0, 0.0, 1.0]
    } else if a == 0.0 {
        [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    } else {
        // T(c) R T(-c), c = canvas centre, R = [cos, -sin; sin, cos].
        let (s, c) = a.to_radians().sin_cos();
        let (cx, cy) = (w / 2.0, h / 2.0);
        [c, -s, cx - c * cx + s * cy, s, c, cy - s * cx - c * cy, 0.0, 0.0, 1.0]
    };
    let r = bbox(&m, [0.0, 0.0, w, h]);
    m[2] -= r[0] as f64;
    m[5] -= r[1] as f64;
    (m, [0, 0, r[2], r[3]])
}

// Rounded-out bbox of rect [x, y, w, h] under the affine `m`, saturated to the i32 range.
fn bbox(m: &[f64; 9], r: [f64; 4]) -> [i32; 4] {
    let (mut lo, mut hi) = ((f64::INFINITY, f64::INFINITY), (f64::NEG_INFINITY, f64::NEG_INFINITY));
    for (x, y) in [(r[0], r[1]), (r[0] + r[2], r[1]), (r[0] + r[2], r[1] + r[3]), (r[0], r[1] + r[3])] {
        let p = (m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
        lo = (lo.0.min(p.0), lo.1.min(p.1));
        hi = (hi.0.max(p.0), hi.1.max(p.1));
    }
    let (x0, y0) = (lo.0.floor(), lo.1.floor());
    [x0 as i32, y0 as i32, (hi.0.ceil() - x0) as i32, (hi.1.ceil() - y0) as i32]
}

// The homography taking src[i] to dst[i]: the 8x8 DLT system with h33 = 1, Gaussian
// elimination with partial pivoting; None when a pivot is below 1e-14.
fn homography(src: &[(f64, f64); 4], dst: &[(f64, f64); 4]) -> Option<[f64; 9]> {
    let mut a = [[0f64; 9]; 8];
    for i in 0..4 {
        let ((x, y), (u, v)) = (src[i], dst[i]);
        a[2 * i] = [x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u, u];
        a[2 * i + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v, v];
    }
    for c in 0..8 {
        let mut p = c;
        for r in c + 1..8 {
            if a[r][c].abs() > a[p][c].abs() {
                p = r;
            }
        }
        if a[p][c].abs() < 1e-14 {
            return None;
        }
        a.swap(p, c);
        for r in c + 1..8 {
            let f = a[r][c] / a[c][c];
            if f != 0.0 {
                for k in c..9 {
                    a[r][k] -= f * a[c][k];
                }
            }
        }
    }
    let mut h = [0f64; 9];
    for r in (0..8).rev() {
        let s = a[r][8] - (r + 1..8).map(|k| a[r][k] * h[k]).sum::<f64>();
        h[r] = s / a[r][r];
    }
    h[8] = 1.0;
    Some(h)
}

// `p` grown by `pad` [left, top, right, bottom] plane px of replicated edge pixels.
fn clamp_pad(p: Plane, pad: [usize; 4]) -> Plane {
    let (w, h) = (p.w + pad[0] + pad[2], p.h + pad[1] + pad[3]);
    let mut data = Vec::with_capacity(w * h * p.ch);
    for y in 0..h {
        let sy = y.saturating_sub(pad[1]).min(p.h - 1);
        for x in 0..w {
            let sx = x.saturating_sub(pad[0]).min(p.w - 1);
            data.extend_from_slice(&p.data[(sy * p.w + sx) * p.ch..][..p.ch]);
        }
    }
    Plane { x: p.x - pad[0] as i32, y: p.y - pad[1] as i32, w, h, data, ..p }
}

// Straight `s` over straight `c`.
fn over(s: [f32; 4], c: [f32; 4]) -> [f32; 4] {
    let k = c[3] * (1.0 - s[3]);
    let a = s[3] + k;
    if a <= 0.0 {
        return [0.0; 4];
    }
    let mix = |i: usize| (s[i] * s[3] + c[i] * k) / a;
    [mix(0), mix(1), mix(2), a]
}

// Multiplies every layer style's scale by `k`, kept in the Scale Effects range.
fn scale_styles(nodes: &mut [Node], k: f32) {
    for n in nodes {
        if let Some(s) = &mut n.style {
            s.scale = (s.scale * k).clamp(0.01, 10.0);
        }
        if let Kind::Group(ch) = &mut n.kind {
            scale_styles(ch, k);
        }
    }
}

fn invert3(m: &[f64; 9]) -> Option<[f64; 9]> {
    let [a, b, c, d, e, f, g, h, i] = *m;
    let (r, s, t) = (e * i - f * h, f * g - d * i, d * h - e * g);
    let det = a * r + b * s + c * t;
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let q = 1.0 / det;
    Some([
        r * q,
        (c * h - b * i) * q,
        (b * f - c * e) * q,
        s * q,
        (a * i - c * g) * q,
        (c * d - a * f) * q,
        t * q,
        (b * g - a * h) * q,
        (a * e - b * d) * q,
    ])
}

// Source px per dest px at dest point (x, y) under the inverse homography `e`: sqrt |det J|.
fn minification(e: &[f64; 9], x: f64, y: f64) -> f64 {
    let n = e[6] * x + e[7] * y + e[8];
    if n == 0.0 || !n.is_finite() {
        return 1.0;
    }
    let (i, o, s) = (e[0] * x + e[1] * y + e[2], e[3] * x + e[4] * y + e[5], 1.0 / n);
    let g = s * s;
    let j = [e[0] * s - i * e[6] * g, e[3] * s - o * e[6] * g, e[1] * s - i * e[7] * g, e[4] * s - o * e[7] * g];
    let det = (j[0] * j[3] - j[1] * j[2]).abs();
    if det > 0.0 && det.is_finite() { det.sqrt() } else { 1.0 }
}

impl Document {
    // Vector data follows the canvas (`m`: old canvas px -> new): nodes, saved paths, and guides
    // whose line stays horizontal or vertical (others keep their position).
    fn remap_vectors(&mut self, m: &[f64; 9]) {
        remap_nodes(&mut self.nodes, m);
        for p in &mut self.vector.paths {
            map_path(m, &mut p.path);
        }
        for g in &mut self.vector.guides {
            let (a, b) = match g.axis {
                Axis::X => (map_pt(m, g.pos, 0.0), map_pt(m, g.pos, 1.0)),
                Axis::Y => (map_pt(m, 0.0, g.pos), map_pt(m, 1.0, g.pos)),
            };
            if (a.1 - b.1).abs() < 1e-9 {
                (g.axis, g.pos) = (Axis::Y, a.1);
            } else if (a.0 - b.0).abs() < 1e-9 {
                (g.axis, g.pos) = (Axis::X, a.0);
            }
        }
    }

    fn planes(&self) -> Vec<At> {
        let mut ids = Vec::new();
        collect_ids(&self.nodes, &mut ids);
        let mut out = Vec::new();
        for id in ids {
            let n = self.node(id).expect("a listed node");
            if n.pixel_tiles().is_ok() {
                out.push(At::Pixels(id));
            }
            if n.mask.is_some() {
                out.push(At::Mask(id));
            }
            if matches!(&n.kind, Kind::Text(t) if t.cache.is_some()) {
                out.push(At::TextCache(id));
            }
            if let Kind::Smart(s) = &n.kind {
                out.extend(s.filters.iter().enumerate().filter(|(_, f)| f.mask.is_some()).map(|(i, _)| At::FilterMask(id, i)));
                if s.stack_mask.is_some() {
                    out.push(At::StackMask(id));
                }
            }
        }
        if self.selection.is_some() {
            out.push(At::Selection);
        }
        if self.last_selection.is_some() {
            out.push(At::LastSelection);
        }
        out.extend((0..self.channels.len()).map(At::Channel));
        out
    }

    // A copy of the plane's tiles and, for every mask kind, its default value.
    fn plane(&self, at: At) -> (Tiles, Option<u32>) {
        let sel = |s: Option<&SelMask>| {
            let s = s.expect("a listed plane");
            (s.tiles.clone(), Some(s.default))
        };
        match at {
            At::Pixels(id) => (self.node(id).and_then(|n| n.pixel_tiles()).expect("a listed plane").clone(), None),
            At::TextCache(id) => match &self.node(id).expect("a listed plane").kind {
                Kind::Text(t) => (t.cache.clone().expect("a listed plane"), None),
                _ => unreachable!("a text cache plane points at a text node"),
            },
            At::Mask(_) | At::FilterMask(..) | At::StackMask(_) => {
                let m = self.plane_mask(at).expect("a listed plane");
                (m.tiles.clone(), Some(m.default))
            }
            At::Selection => sel(self.selection.as_ref()),
            At::LastSelection => sel(self.last_selection.as_ref()),
            At::Channel(i) => sel(Some(&self.channels[i].mask)),
        }
    }

    // Installs the new tiles of every plane and the new canvas size.
    fn replace_planes(&mut self, planes: Vec<(At, Tiles)>, w: u32, h: u32) {
        self.width = w;
        self.height = h;
        for (at, mut tiles) in planes {
            if at.canvas_bound() {
                for (tx, ty) in tiles.coords() {
                    if !self.on_canvas(tx, ty) {
                        tiles.put(tx, ty, None);
                    }
                }
            }
            let slot = match at {
                At::Pixels(id) => self.node_mut(id).and_then(|n| n.pixel_tiles_mut()).expect("a listed plane"),
                At::Mask(id) => &mut self.node_mut(id).expect("a listed plane").mask.as_mut().expect("a listed plane").tiles,
                At::FilterMask(id, i) => {
                    &mut self.node_mut(id).expect("a listed plane").smart_mut().filters[i].mask.as_mut().expect("a listed plane").tiles
                }
                At::StackMask(id) => &mut self.node_mut(id).expect("a listed plane").smart_mut().stack_mask.as_mut().expect("a listed plane").tiles,
                At::TextCache(id) => match &mut self.node_mut(id).expect("a listed plane").kind {
                    Kind::Text(t) => t.cache.as_mut().expect("a listed plane"),
                    _ => unreachable!("a text cache plane points at a text node"),
                },
                At::Selection => &mut self.selection.as_mut().expect("a listed plane").tiles,
                At::LastSelection => &mut self.last_selection.as_mut().expect("a listed plane").tiles,
                At::Channel(i) => &mut self.channels[i].mask.tiles,
            };
            *slot = tiles;
        }
    }

    // `src` with every pixel outside rect `r` transparent or the mask default.
    fn clip_tiles(&mut self, src: &Tiles, r: [i32; 4], mask_default: Option<u32>) -> Tiles {
        let def = mask_default.map_or(0.0, |d| d as f32 / self.max());
        let ch = if mask_default.is_some() { 1 } else { 4 };
        let mut buf = vec![0f32; TILE_PIXELS * ch];
        let mut out = Tiles::default();
        for (tx, ty) in src.coords() {
            let t = src.get(tx, ty).expect("a listed tile");
            let (ox, oy) = (tx * TI, ty * TI);
            let (x0, y0) = (r[0].max(ox), r[1].max(oy));
            let (x1, y1) = ((r[0] + r[2]).min(ox + TI), (r[1] + r[3]).min(oy + TI));
            if x0 >= x1 || y0 >= y1 {
                continue;
            }
            if (x0, y0, x1, y1) == (ox, oy, ox + TI, oy + TI) {
                out.put(tx, ty, Some(t.clone()));
                continue;
            }
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                let inside = x >= x0 && x < x1 && y >= y0 && y < y1;
                match mask_default {
                    Some(_) => buf[p] = if inside { t.px.mask_f32(p) } else { def },
                    None => buf[p * 4..p * 4 + 4].copy_from_slice(&if inside { t.px.rgba_f32(p) } else { [0.0; 4] }),
                }
            }
            let px = match mask_default {
                Some(_) => Pixels::mask_from_norm(self.depth, &buf),
                None => Pixels::from_straight(self.depth, &buf),
            };
            if mask_default.is_none() && !px.any_alpha() {
                continue;
            }
            out.put(tx, ty, Some(Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
        }
        out
    }

    // A node mask plane's mask.
    fn plane_mask(&self, at: At) -> Option<&Mask> {
        match at {
            At::Mask(id) => self.node(id).ok()?.mask.as_ref(),
            At::FilterMask(id, i) => self.smart(id).ok()?.filters[i].mask.as_ref(),
            At::StackMask(id) => self.smart(id).ok()?.stack_mask.as_ref(),
            _ => None,
        }
    }

    // Tight bounds of the mask pixels that differ from its default.
    fn mask_bounds(&self, at: At) -> Option<[i32; 4]> {
        let m = self.plane_mask(at)?;
        let def = m.default as f32 / self.max();
        let mut bb: Option<(i32, i32, i32, i32)> = None;
        for (tx, ty) in m.tiles.coords() {
            let px = &m.tiles.get(tx, ty).expect("a listed tile").px;
            for p in 0..TILE_PIXELS {
                if px.mask_f32(p) == def {
                    continue;
                }
                let (x, y) = (tx * TI + (p % TILE) as i32, ty * TI + (p / TILE) as i32);
                bb = Some(bb.map_or((x, y, x + 1, y + 1), |b| (b.0.min(x), b.1.min(y), b.2.max(x + 1), b.3.max(y + 1))));
            }
        }
        bb.map(|(x0, y0, x1, y1)| [x0, y0, x1 - x0, y1 - y0])
    }

    // Clips every plane to `r` when `delete`, moves it by (-r.x, -r.y) and makes the canvas
    // r.w x r.h; `r` is not empty.
    pub(super) fn crop_to(&mut self, r: [i32; 4], delete: bool) -> Result<(), String> {
        validate_dims(r[2] as u32, r[3] as u32, self.depth)?;
        let mut out = Vec::new();
        for at in self.planes() {
            let (tiles, def) = self.plane(at);
            let tiles = if delete { self.clip_tiles(&tiles, r, def) } else { tiles };
            let tiles = if r[0] == 0 && r[1] == 0 {
                tiles
            } else {
                check_shift(&tiles, -r[0], -r[1])?;
                self.shift_tiles(&tiles, -r[0], -r[1], def)
            };
            out.push((at, tiles));
        }
        self.replace_planes(out, r[2] as u32, r[3] as u32);
        self.remap_vectors(&[1.0, 0.0, -r[0] as f64, 0.0, 1.0, -r[1] as f64, 0.0, 0.0, 1.0]);
        Ok(())
    }

    /// Crops the canvas to `rect` [x, y, w, h], rounded out. Every plane (layer pixels, layer
    /// masks, saved channels, the selection) is clipped to it when `delete_cropped`, then moved
    /// by (-x, -y). Area past the old canvas is transparent. False when the rect is empty.
    pub fn apply_crop(&mut self, rect: [f64; 4], delete_cropped: bool) -> Result<bool, String> {
        self.check_idle()?;
        if !rect.iter().all(|v| v.is_finite()) {
            return Err("crop rect must be finite".into());
        }
        let r = round_out(rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3])?;
        if r[2] == 0 || r[3] == 0 {
            return Ok(false);
        }
        self.crop_to(r, delete_cropped)?;
        Ok(true)
    }

    /// The crop tool commit: with a non-zero angle the canvas is first rotated by -angle
    /// (bicubic) and the rect becomes the rounded-out bbox of its rotated corners. False when
    /// nothing changes (angle 0 and the rect is the canvas, or an empty rect).
    pub fn crop_rotated(&mut self, rect: [f64; 4], angle_deg: f64, delete_cropped: bool) -> Result<bool, String> {
        self.check_idle()?;
        if !rect.iter().all(|v| v.is_finite()) {
            return Err("crop rect must be finite".into());
        }
        if !angle_deg.is_finite() {
            return Err("angle must be finite".into());
        }
        let r = round_out(rect[0], rect[1], rect[0] + rect[2], rect[1] + rect[3])?;
        if r[2] == 0 || r[3] == 0 {
            return Ok(false);
        }
        let a = (-angle_deg % 360.0 + 360.0) % 360.0;
        if a == 0.0 {
            if r == [0, 0, self.width as i32, self.height as i32] {
                return Ok(false);
            }
            self.crop_to(r, delete_cropped)?;
            return Ok(true);
        }
        let (m, _) = canvas_turn(self.width as f64, self.height as f64, a);
        let mapped = bbox(&m, r.map(|v| v as f64));
        // Rotate and crop on a copy, so a refused crop leaves the document alone.
        let mut d = self.clone();
        d.rotate_canvas(-angle_deg, Interp::Bicubic)?;
        d.crop_to(mapped, delete_cropped)?;
        *self = d;
        Ok(true)
    }

    /// The rect Image > Trim crops to. `based_on` is "transparent" (alpha <= 0 is empty),
    /// "topLeftPixel" or "bottomRightPixel" (within 1/512 of that composite pixel is empty).
    /// Sides turned off keep the canvas edge; an all-empty canvas gives a 1 px strip.
    pub fn trim_rect(&self, based_on: &str, top: bool, bottom: bool, left: bool, right: bool) -> Result<[i32; 4], String> {
        self.check_idle()?;
        let (w, h) = (self.width as i32, self.height as i32);
        let at = match based_on {
            "transparent" => None,
            "topLeftPixel" => Some((0, 0)),
            "bottomRightPixel" => Some((w - 1, h - 1)),
            other => return Err(format!("unknown trim mode {other}")),
        };
        if !(top || bottom || left || right) {
            return Ok([0, 0, w, h]);
        }
        let straight = |p: &[f32]| if p[3] > 0.0 { [p[0] / p[3], p[1] / p[3], p[2] / p[3], p[3]] } else { [0.0; 4] };
        let reference = at.map(|(x, y): (i32, i32)| {
            let c = self.composite_tile_premul((x / TI) as u32, (y / TI) as u32);
            let p = ((y % TI) * TI + x % TI) as usize * 4;
            straight(&c[p..p + 4])
        });
        let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
        for ty in 0..self.tiles_y() {
            for tx in 0..self.tiles_x() {
                let c = self.composite_tile_premul(tx, ty);
                for p in 0..TILE_PIXELS {
                    let (x, y) = (tx as i32 * TI + (p % TILE) as i32, ty as i32 * TI + (p / TILE) as i32);
                    if x >= w || y >= h {
                        continue;
                    }
                    let v = &c[p * 4..p * 4 + 4];
                    let empty = match reference {
                        None => v[3] <= 0.0,
                        Some(r) => {
                            let s = straight(v);
                            (0..4).all(|i| (s[i] - r[i]).abs() <= 1.0 / 512.0)
                        }
                    };
                    if !empty {
                        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
                    }
                }
            }
        }
        if x0 == i32::MAX {
            return Ok([
                if left { w - 1 } else { 0 },
                if top { h - 1 } else { 0 },
                if left || right { 1 } else { w },
                if top || bottom { 1 } else { h },
            ]);
        }
        if !left {
            x0 = 0;
        }
        if !top {
            y0 = 0;
        }
        if !right {
            x1 = w - 1;
        }
        if !bottom {
            y1 = h - 1;
        }
        Ok([x0, y0, x1 - x0 + 1, y1 - y0 + 1])
    }

    /// Image > Trim: crops to `trim_rect` with hidden pixels kept. False when that is the canvas.
    pub fn trim(&mut self, based_on: &str, top: bool, bottom: bool, left: bool, right: bool) -> Result<bool, String> {
        let r = self.trim_rect(based_on, top, bottom, left, right)?;
        if r == [0, 0, self.width as i32, self.height as i32] {
            return Ok(false);
        }
        self.crop_to(r, false)?;
        Ok(true)
    }

    /// Image > Reveal All: grows the canvas to the union of the canvas, every layer's tight
    /// pixel bounds and every mask's tight content bounds. False when that is the canvas.
    pub fn reveal_all(&mut self) -> Result<bool, String> {
        self.check_idle()?;
        let (w, h) = (self.width as i32, self.height as i32);
        let (mut x0, mut y0, mut x1, mut y1) = (0, 0, w, h);
        for at in self.planes() {
            let b = match at {
                At::Pixels(id) | At::TextCache(id) => self.layer_bounds(id)?,
                At::Mask(_) | At::FilterMask(..) | At::StackMask(_) => self.mask_bounds(at),
                _ => None,
            };
            if let Some(b) = b {
                (x0, y0, x1, y1) = (x0.min(b[0]), y0.min(b[1]), x1.max(b[0] + b[2]), y1.max(b[1] + b[3]));
            }
        }
        if (x0, y0, x1, y1) == (0, 0, w, h) {
            return Ok(false);
        }
        self.crop_to([x0, y0, x1 - x0, y1 - y0], false)?;
        Ok(true)
    }

    /// Image Rotation exact ops on every plane with the old W, H: cw (x, y) -> (H-1-y, x),
    /// ccw (y, W-1-x), 180 (W-1-x, H-1-y), flipH (W-1-x, y), flipV (x, H-1-y).
    pub fn rotate_canvas_exact(&mut self, kind: Remap) -> Result<(), String> {
        self.check_idle()?;
        let (w, h) = (self.width as i64, self.height as i64);
        let fwd = move |x: i64, y: i64| match kind {
            Remap::Cw => (h - 1 - y, x),
            Remap::Ccw => (y, w - 1 - x),
            Remap::R180 => (w - 1 - x, h - 1 - y),
            Remap::FlipH => (w - 1 - x, y),
            Remap::FlipV => (x, h - 1 - y),
        };
        let inv = move |a: i64, b: i64| match kind {
            Remap::Cw => (b, h - 1 - a),
            Remap::Ccw => (w - 1 - b, a),
            Remap::R180 => (w - 1 - a, h - 1 - b),
            Remap::FlipH => (w - 1 - a, b),
            Remap::FlipV => (a, h - 1 - b),
        };
        let mut out = Vec::new();
        for at in self.planes() {
            let (tiles, def) = self.plane(at);
            out.push((at, self.remap_exact(&tiles, &fwd, &inv, def)?));
        }
        let (nw, nh) = if matches!(kind, Remap::Cw | Remap::Ccw) { (h, w) } else { (w, h) };
        self.replace_planes(out, nw as u32, nh as u32);
        let (fw, fh) = (w as f64, h as f64);
        let m = match kind {
            Remap::Cw => canvas_turn(fw, fh, 90.0).0,
            Remap::Ccw => canvas_turn(fw, fh, 270.0).0,
            Remap::R180 => canvas_turn(fw, fh, 180.0).0,
            Remap::FlipH => [-1.0, 0.0, fw, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
            Remap::FlipV => [1.0, 0.0, 0.0, 0.0, -1.0, fh, 0.0, 0.0, 1.0],
        };
        self.remap_vectors(&m);
        Ok(())
    }

    /// Image Rotation > Arbitrary: `deg` clockwise about the canvas centre; multiples of 90 use
    /// the exact ops. Every plane is resampled with transparent (mask default) edges into the
    /// rounded-out bbox of the rotated canvas. False for a multiple of 360.
    pub fn rotate_canvas(&mut self, deg: f64, interp: Interp) -> Result<bool, String> {
        self.check_idle()?;
        if !deg.is_finite() {
            return Err("angle must be finite".into());
        }
        let a = (deg % 360.0 + 360.0) % 360.0;
        let exact = if a == 0.0 {
            return Ok(false);
        } else if a == 90.0 {
            Some(Remap::Cw)
        } else if a == 180.0 {
            Some(Remap::R180)
        } else if a == 270.0 {
            Some(Remap::Ccw)
        } else {
            None
        };
        if let Some(kind) = exact {
            self.rotate_canvas_exact(kind)?;
            return Ok(true);
        }
        let (m, size) = canvas_turn(self.width as f64, self.height as f64, a);
        validate_dims(size[2] as u32, size[3] as u32, self.depth)?;
        let mut out = Vec::new();
        for at in self.planes() {
            let (tiles, def) = self.plane(at);
            let bounds = match at {
                At::Pixels(id) | At::TextCache(id) => self.layer_bounds(id)?,
                _ => tile_rect(&tiles),
            };
            let Some(b) = bounds else {
                out.push((at, tiles));
                continue;
            };
            check_area(b)?;
            let (plane, edge) = match def {
                Some(d) => (self.mask_plane(&tiles, d, b), d as f32 / self.max()),
                None => (self.rgba_plane(&tiles, b, None), 0.0),
            };
            let rs = Resampler::new(plane, &m, interp, edge)?;
            let clip = at.canvas_bound().then_some(size);
            out.push((at, self.render_tiles(&rs, def, clip)?));
        }
        self.replace_planes(out, size[2] as u32, size[3] as u32);
        self.remap_vectors(&m);
        Ok(true)
    }

    /// Perspective crop: maps quad corners c0..c3 (flat x, y) onto (0,0), (W,0), (W,H), (0,H)
    /// and warps every pixel layer into a W x H canvas at offset 0. Masks and saved channels
    /// stay, the selection is cleared. Only a singular homography is refused.
    pub fn perspective_crop(&mut self, quad: &[f64], out_w: u32, out_h: u32, interp: Interp) -> Result<(), String> {
        self.check_idle()?;
        if quad.len() != 8 || !quad.iter().all(|v| v.is_finite()) {
            return Err("perspective crop needs 4 finite corners".into());
        }
        validate_dims(out_w, out_h, self.depth)?;
        let (w, h) = (out_w as f64, out_h as f64);
        let src = [(quad[0], quad[1]), (quad[2], quad[3]), (quad[4], quad[5]), (quad[6], quad[7])];
        let fwd = homography(&src, &[(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)]).ok_or(DEGENERATE)?;
        let inv = invert3(&fwd).ok_or(DEGENERATE)?;
        let mut most: f64 = 0.0;
        for x in [0.5, w / 2.0, w - 0.5] {
            for y in [0.5, h / 2.0, h - 0.5] {
                most = most.max(minification(&inv, x, y));
            }
        }
        let rect = [0, 0, out_w as i32, out_h as i32];
        let mut out = Vec::new();
        for at in self.planes() {
            let (At::Pixels(id) | At::TextCache(id)) = at else {
                // Unchanged, but listed so replace_planes clips them to the new canvas.
                if matches!(at, At::LastSelection | At::Channel(_)) {
                    out.push((at, self.plane(at).0));
                }
                continue;
            };
            let Some(b) = self.layer_bounds(id)? else {
                out.push((at, Tiles::default()));
                continue;
            };
            check_area(b)?;
            let rs = Resampler::pyramid(self.rgba_plane(&self.plane(at).0, b, None), interp, 0.0, most);
            let tiles = self.render_tiles_with(rect, None, false, |ox, oy, buf| {
                buf.fill(0.0);
                let mut hit = false;
                for p in 0..TILE_PIXELS {
                    let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                    if x >= rect[2] || y >= rect[3] {
                        continue;
                    }
                    let (cx, cy) = (x as f64 + 0.5, y as f64 + 0.5);
                    let n = inv[6] * cx + inv[7] * cy + inv[8];
                    if n == 0.0 || !n.is_finite() {
                        continue;
                    }
                    let (sx, sy) = ((inv[0] * cx + inv[1] * cy + inv[2]) / n, (inv[3] * cx + inv[4] * cy + inv[5]) / n);
                    hit |= rs.sample_point(sx, sy, minification(&inv, cx, cy), &mut buf[p * 4..p * 4 + 4]);
                }
                hit
            })?;
            out.push((at, tiles));
        }
        self.selection = None;
        self.replace_planes(out, out_w, out_h);
        self.remap_vectors(&fwd);
        Ok(())
    }
    /// Image > Canvas Size: the old canvas sits at `anchor` (-1|0|1 per axis: left/top, centre,
    /// right/bottom; an odd centred difference grows left/top, shrinks right/bottom). Pixels past
    /// the new canvas are deleted; `fill` (straight 0..1) goes under a bottom pixel layer's added area.
    pub fn canvas_size(&mut self, w: u32, h: u32, anchor: (i8, i8), fill: Option<[f32; 4]>) -> Result<bool, String> {
        self.check_idle()?;
        if ![anchor.0, anchor.1].iter().all(|a| (-1..=1).contains(a)) {
            return Err("anchor must be -1, 0 or 1 on each axis".into());
        }
        if fill.is_some_and(|c| !c.iter().all(|v| (0.0..=1.0).contains(v))) {
            return Err("fill must be 4 values in 0..1".into());
        }
        validate_dims(w, h, self.depth)?;
        if (w, h) == (self.width, self.height) {
            return Ok(false);
        }
        let (ow, oh) = (self.width as i32, self.height as i32);
        let off = |a: i8, o: i32, n: i32| match a {
            -1 => 0,
            0 => (o - n).div_euclid(2),
            _ => o - n,
        };
        let r = [off(anchor.0, ow, w as i32), off(anchor.1, oh, h as i32), w as i32, h as i32];
        let mut d = self.clone();
        d.crop_to(r, true)?;
        if let (Some(c), Some(n)) = (fill, d.nodes.first()) {
            if matches!(n.kind, Kind::Pixel(_)) {
                d.fill_added(n.id, [-r[0], -r[1], ow, oh], c)?;
            }
        }
        *self = d;
        Ok(true)
    }

    // Puts `c` under pixel layer `id` on the canvas outside rect `old`.
    fn fill_added(&mut self, id: u32, old: [i32; 4], c: [f32; 4]) -> Result<(), String> {
        let mut tiles = self.node(id)?.pixel_tiles()?.clone();
        let (w, h) = (self.width as i32, self.height as i32);
        let inside_old = |x: i32, y: i32| x >= old[0] && y >= old[1] && x < old[0] + old[2] && y < old[1] + old[3];
        let mut buf = vec![0f32; TILE_PIXELS * 4];
        for (tx, ty) in tile_span([0, 0, w, h]) {
            let (ox, oy) = (tx * TI, ty * TI);
            if inside_old(ox, oy) && inside_old(ox + TI - 1, oy + TI - 1) {
                continue;
            }
            let t = tiles.get(tx, ty);
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                let s = t.map_or([0.0; 4], |t| t.px.rgba_f32(p));
                let added = x < w && y < h && !inside_old(x, y);
                buf[p * 4..p * 4 + 4].copy_from_slice(&if added { over(s, c) } else { s });
            }
            let px = Pixels::from_straight(self.depth, &buf);
            let tile = px.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
            tiles.put(tx, ty, tile);
        }
        *self.node_mut(id)?.pixel_tiles_mut()? = tiles;
        Ok(())
    }

    /// Image > Image Size (resample): scales every plane to w x h, off-canvas pixels included,
    /// clamped at the canvas edges. Smart objects re-render from source; type layers keep a
    /// resampled cache under their scaled transform until `render_text`.
    pub fn image_size(&mut self, w: u32, h: u32, interp: Interp, scale_styles: bool) -> Result<bool, String> {
        self.check_idle()?;
        validate_dims(w, h, self.depth)?;
        if (w, h) == (self.width, self.height) {
            return Ok(false);
        }
        let canvas = [0, 0, self.width as i32, self.height as i32];
        let (sx, sy) = (w as f64 / canvas[2] as f64, h as f64 / canvas[3] as f64);
        let m = [sx, 0.0, 0.0, 0.0, sy, 0.0, 0.0, 0.0, 1.0];
        let size = [0, 0, w as i32, h as i32];
        // Edge padding covers the filter support (3 dest px) in source px.
        let (px, py) = ((3.0 / sx).max(3.0).ceil() as i32, (3.0 / sy).max(3.0).ceil() as i32);
        let mut d = self.clone();
        let (mut out, mut smart) = (Vec::new(), Vec::new());
        for at in d.planes() {
            let (tiles, def) = d.plane(at);
            let bounds = match at {
                At::Pixels(id) if d.placement_source(id).is_ok() => {
                    smart.push(id);
                    continue;
                }
                At::Pixels(id) | At::TextCache(id) => d.layer_bounds(id)?,
                At::Mask(_) | At::FilterMask(..) | At::StackMask(_) => d.mask_bounds(at),
                _ => tile_rect(&tiles).map(|r| intersect(r, canvas)).filter(|r| r[2] > 0 && r[3] > 0),
            };
            let Some(b) = bounds else {
                out.push((at, Tiles::default()));
                continue;
            };
            let touch = [b[0] == 0, b[1] == 0, b[0] + b[2] == canvas[2], b[1] + b[3] == canvas[3]];
            let along = [px.min(b[2]), py.min(b[3]), px.min(b[2]), py.min(b[3])];
            let pad: [usize; 4] = std::array::from_fn(|i| if touch[i] { along[i] as usize } else { 0 });
            check_area([0, 0, b[2] + (pad[0] + pad[2]) as i32, b[3] + (pad[1] + pad[3]) as i32])?;
            let (plane, edge) = match def {
                Some(v) => (d.mask_plane(&tiles, v, b), v as f32 / d.max()),
                None => (d.rgba_plane(&tiles, b, None), 0.0),
            };
            let rs = Resampler::new(clamp_pad(plane, pad), &m, interp, edge)?;
            let clip = bbox(&m, b.map(|v| v as f64));
            let clip = if at.canvas_bound() { intersect(clip, size) } else { clip };
            out.push((at, d.render_tiles(&rs, def, Some(clip))?));
        }
        d.replace_planes(out, w, h);
        d.remap_vectors(&m);
        for id in smart {
            d.render_smart(id)?;
        }
        if scale_styles {
            self::scale_styles(&mut d.nodes, (sx * sy).sqrt() as f32);
        }
        *self = d;
        Ok(true)
    }
}


#[cfg(test)]
mod tests {
    use super::super::transform::tests::{get_mask, get_px, put_mask, put_px};
    use super::*;

    const T: i32 = TILE as i32;

    fn grid(d: &Document, id: u32, r: [i32; 4]) -> Vec<[u8; 4]> {
        (r[1]..r[1] + r[3]).flat_map(|y| (r[0]..r[0] + r[2]).map(move |x| (x, y))).map(|(x, y)| get_px(d, id, x, y)).collect()
    }

    fn mask_grid(d: &Document, id: u32, r: [i32; 4]) -> Vec<u8> {
        (r[1]..r[1] + r[3]).flat_map(|y| (r[0]..r[0] + r[2]).map(move |x| (x, y))).map(|(x, y)| get_mask(d, id, x, y)).collect()
    }

    fn sel_grid(d: &Document, sel: &SelMask, r: [i32; 4]) -> Vec<u8> {
        (r[1]..r[1] + r[3])
            .flat_map(|y| (r[0]..r[0] + r[2]).map(move |x| (x, y)))
            .map(|(x, y)| (d.sel_at(sel, x, y) * 255.0).round() as u8)
            .collect()
    }

    fn canvas(d: &Document) -> [i32; 4] {
        [0, 0, d.width as i32, d.height as i32]
    }

    fn put_sel(d: &mut Document, x: i32, y: i32, v: u8) {
        let ((tx, ty), p) = ((x.div_euclid(T), y.div_euclid(T)), (y.rem_euclid(T) * T + x.rem_euclid(T)) as usize);
        let tid = d.alloc_tile_id();
        let s = d.selection.get_or_insert_with(SelMask::default);
        let mut data = match s.tiles.get(tx, ty).map(|t| (*t.px).clone()) {
            Some(Pixels::Mask8(b)) => b.to_vec(),
            _ => vec![s.default as u8; TILE_PIXELS],
        };
        data[p] = v;
        s.tiles.put(tx, ty, Some(Tile { id: tid, px: Arc::new(Pixels::Mask8(data.into_boxed_slice())) }));
    }

    // A w x h document whose layer 1 holds `f(x, y)` on the canvas and nothing past it.
    fn pattern_doc(w: u32, h: u32, f: impl Fn(i32, i32) -> [u8; 4]) -> Document {
        let mut d = Document::new(w, h, 8).unwrap();
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                let mut data = vec![0u8; TILE_PIXELS * 4];
                for p in 0..TILE_PIXELS {
                    let (x, y) = (tx as i32 * T + (p % TILE) as i32, ty as i32 * T + (p / TILE) as i32);
                    if x < w as i32 && y < h as i32 {
                        data[p * 4..p * 4 + 4].copy_from_slice(&f(x, y));
                    }
                }
                d.set_tile_rgba8(1, tx, ty, &data).unwrap();
            }
        }
        d
    }

    // 6x4, every canvas pixel set, one pixel off the canvas at (-3, 0), a reveal-all mask with
    // three painted values, a partial selection and a saved copy of it.
    fn crop_doc() -> Document {
        let mut d = pattern_doc(6, 4, |x, y| [(10 * x + 1) as u8, (10 * y + 1) as u8, 7, 255]);
        put_px(&mut d, 1, -3, 0, [1, 2, 3, 255]);
        d.add_mask(1, true).unwrap();
        put_mask(&mut d, 1, 0, 0, 11);
        put_mask(&mut d, 1, 4, 2, 22);
        put_mask(&mut d, 1, 2, 2, 33);
        put_sel(&mut d, 0, 0, 200);
        put_sel(&mut d, 2, 1, 100);
        d.save_selection("saved").unwrap();
        d
    }

    #[test]
    fn crop_with_delete_off_keeps_every_plane_and_translates_it() {
        let base = crop_doc();
        let mut d = base.clone();
        // Rounded out to [1, 0, 3, 3].
        assert!(d.apply_crop([1.5, 0.2, 2.2, 2.6], false).unwrap());
        assert_eq!((d.width, d.height), (3, 3));
        assert_eq!(grid(&d, 1, [0, 0, 3, 3]), grid(&base, 1, [1, 0, 3, 3]));
        assert_eq!(d.layer_bounds(1).unwrap(), Some([-4, 0, 9, 4]));
        assert_eq!(get_px(&d, 1, -1, 0), [1, 1, 7, 255]);
        assert_eq!(get_px(&d, 1, -4, 0), [1, 2, 3, 255]);
        assert_eq!(get_mask(&d, 1, -1, 0), 11);
        assert_eq!(get_mask(&d, 1, 3, 2), 22);
        assert_eq!(get_mask(&d, 1, 1, 2), 33);
        assert_eq!(get_mask(&d, 1, 0, 0), 255);
        let sel = d.selection.clone().unwrap();
        assert_eq!(sel_grid(&d, &sel, [0, 0, 3, 3]), vec![0, 0, 0, 0, 100, 0, 0, 0, 0]);
        assert_eq!(sel_grid(&d, &d.channels[0].mask, [0, 0, 3, 3]), vec![0, 0, 0, 0, 100, 0, 0, 0, 0]);
        // Canvas-sized masks keep no tile off the new canvas.
        assert!(sel.tiles.coords().iter().all(|t| d.on_canvas(t.0, t.1)));
        assert!(d.channels[0].mask.tiles.coords().iter().all(|t| d.on_canvas(t.0, t.1)));
    }

    #[test]
    fn crop_with_delete_on_clips_every_plane_to_the_rect() {
        let base = crop_doc();
        let mut d = base.clone();
        assert!(d.apply_crop([1.5, 0.2, 2.2, 2.6], true).unwrap());
        assert_eq!((d.width, d.height), (3, 3));
        assert_eq!(grid(&d, 1, [0, 0, 3, 3]), grid(&base, 1, [1, 0, 3, 3]));
        assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 3, 3]));
        assert_eq!(get_px(&d, 1, -1, 0), [0; 4]);
        assert_eq!(get_px(&d, 1, -4, 0), [0; 4]);
        assert_eq!(get_mask(&d, 1, -1, 0), 255);
        assert_eq!(get_mask(&d, 1, 3, 2), 255);
        assert_eq!(get_mask(&d, 1, 1, 2), 33);
        let sel = d.selection.clone().unwrap();
        assert_eq!(sel_grid(&d, &sel, [0, 0, 3, 3]), vec![0, 0, 0, 0, 100, 0, 0, 0, 0]);
    }

    #[test]
    fn an_empty_crop_rect_is_a_no_op_and_bad_rects_are_refused() {
        let mut d = crop_doc();
        assert!(!d.apply_crop([2.0, 1.0, 0.0, 3.0], true).unwrap());
        assert_eq!((d.width, d.height), (6, 4));
        assert_eq!(d.apply_crop([f64::NAN, 0.0, 1.0, 1.0], true).unwrap_err(), "crop rect must be finite");
        assert_eq!(d.apply_crop([0.0, 0.0, 70000.0, 1.0], true).unwrap_err(), "width and height must be in 1..=65536");
        assert_eq!((d.width, d.height), (6, 4));
    }

    #[test]
    fn crop_extension_is_transparent_even_on_the_background_layer() {
        let base = pattern_doc(4, 3, |x, y| [50 + x as u8, 60 + y as u8, 70, 255]);
        let mut d = base.clone();
        assert!(d.apply_crop([-2.0, -1.0, 8.0, 5.0], true).unwrap());
        assert_eq!((d.width, d.height), (8, 5));
        assert_eq!(d.node(1).unwrap().name, "Background");
        assert_eq!(get_px(&d, 1, 0, 0), [0; 4]);
        assert_eq!(get_px(&d, 1, 7, 4), [0; 4]);
        assert_eq!(grid(&d, 1, [2, 1, 4, 3]), grid(&base, 1, [0, 0, 4, 3]));
        assert_eq!(d.flatten_tile_rgba8(0, 0).unwrap()[3], 0);
    }

    #[test]
    fn crop_then_reveal_all_restores_the_original_canvas() {
        let f = |x: i32, y: i32| [(x * 7 + y) as u8, (y * 3) as u8, (x ^ y) as u8, 255];
        let mut base = pattern_doc(300, 260, f);
        base.add_mask(1, true).unwrap();
        put_mask(&mut base, 1, 5, 5, 9);
        put_mask(&mut base, 1, 290, 250, 19);
        let mut d = base.clone();
        assert!(d.apply_crop([37.0, 20.0, 100.0, 90.0], false).unwrap());
        assert_eq!((d.width, d.height), (100, 90));
        assert!(d.reveal_all().unwrap());
        assert_eq!((d.width, d.height), (300, 260));
        assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 300, 260]));
        assert_eq!(grid(&d, 1, [0, 0, 300, 260]), grid(&base, 1, [0, 0, 300, 260]));
        assert_eq!(mask_grid(&d, 1, [0, 0, 300, 260]), mask_grid(&base, 1, [0, 0, 300, 260]));
        // Nothing past the canvas: a second reveal is a no-op.
        assert!(!d.reveal_all().unwrap());
    }

    #[test]
    fn reveal_all_uses_the_tight_bounds_of_mask_content() {
        let mut d = pattern_doc(6, 4, |_, _| [9, 9, 9, 255]);
        d.add_mask(1, true).unwrap();
        put_mask(&mut d, 1, 10, 2, 0);
        put_px(&mut d, 1, 2, -3, [1, 1, 1, 255]);
        assert!(d.reveal_all().unwrap());
        assert_eq!((d.width, d.height), (11, 7));
        assert_eq!(get_mask(&d, 1, 10, 5), 0);
        assert_eq!(get_px(&d, 1, 2, 0), [1, 1, 1, 255]);
        assert_eq!(get_px(&d, 1, 0, 3), [9, 9, 9, 255]);
    }

    // 8x6: a 3x3 opaque blue block at (2, 1) on transparency.
    fn trim_transparent_doc() -> Document {
        pattern_doc(8, 6, |x, y| if (2..5).contains(&x) && (1..4).contains(&y) { [0, 0, 255, 255] } else { [0; 4] })
    }

    // 8x6 opaque red with the same blue block and a green bottom-right pixel.
    fn trim_color_doc() -> Document {
        pattern_doc(8, 6, |x, y| match (x, y) {
            (7, 5) => [0, 255, 0, 255],
            _ if (2..5).contains(&x) && (1..4).contains(&y) => [0, 0, 255, 255],
            _ => [255, 0, 0, 255],
        })
    }

    #[test]
    fn trim_rect_for_each_mode_and_side() {
        let d = trim_transparent_doc();
        let all = |d: &Document, m: &str| d.trim_rect(m, true, true, true, true).unwrap();
        assert_eq!(all(&d, "transparent"), [2, 1, 3, 3]);
        assert_eq!(d.trim_rect("transparent", false, true, true, true).unwrap(), [2, 0, 3, 4]);
        assert_eq!(d.trim_rect("transparent", true, false, true, true).unwrap(), [2, 1, 3, 5]);
        assert_eq!(d.trim_rect("transparent", true, true, false, true).unwrap(), [0, 1, 5, 3]);
        assert_eq!(d.trim_rect("transparent", true, true, true, false).unwrap(), [2, 1, 6, 3]);
        assert_eq!(d.trim_rect("transparent", false, false, false, false).unwrap(), [0, 0, 8, 6]);
        let c = trim_color_doc();
        assert_eq!(all(&c, "topLeftPixel"), [2, 1, 6, 5]);
        assert_eq!(all(&c, "bottomRightPixel"), [0, 0, 8, 6]);
        assert_eq!(all(&c, "transparent"), [0, 0, 8, 6]);
        assert_eq!(c.trim_rect("middle", true, true, true, true).unwrap_err(), "unknown trim mode middle");
    }

    #[test]
    fn trim_of_an_all_empty_canvas_is_a_one_pixel_strip() {
        let d = Document::new(8, 6, 8).unwrap();
        assert_eq!(d.trim_rect("transparent", true, true, true, true).unwrap(), [7, 5, 1, 1]);
        assert_eq!(d.trim_rect("transparent", true, true, false, false).unwrap(), [0, 5, 8, 1]);
        assert_eq!(d.trim_rect("transparent", false, false, true, false).unwrap(), [7, 0, 1, 6]);
        assert_eq!(d.trim_rect("transparent", false, false, false, true).unwrap(), [0, 0, 1, 6]);
    }

    #[test]
    fn trim_crops_with_delete_off() {
        let mut d = trim_color_doc();
        assert!(d.trim("topLeftPixel", true, true, true, true).unwrap());
        assert_eq!((d.width, d.height), (6, 5));
        assert_eq!(get_px(&d, 1, 0, 0), [0, 0, 255, 255]);
        assert_eq!(get_px(&d, 1, -2, -1), [255, 0, 0, 255]);
        assert!(!d.trim("transparent", true, true, true, true).unwrap());
    }

    // 3x2: pixels a..f = 1..6 in red, mask 10 * letter, selection and a saved channel 20 * letter.
    fn letters_doc() -> Document {
        let mut d = pattern_doc(3, 2, |x, y| [(y * 3 + x + 1) as u8, 0, 0, 255]);
        d.add_mask(1, false).unwrap();
        for y in 0..2 {
            for x in 0..3 {
                let i = (y * 3 + x + 1) as u8;
                put_mask(&mut d, 1, x, y, i * 10);
                put_sel(&mut d, x, y, i * 20);
            }
        }
        d.save_selection("letters").unwrap();
        d
    }

    fn letters(d: &Document) -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
        let r = canvas(d);
        let px = grid(d, 1, r).iter().map(|p| p[0]).collect();
        let m = mask_grid(d, 1, r).iter().map(|v| v / 10).collect();
        let s = sel_grid(d, d.selection.as_ref().unwrap(), r).iter().map(|v| v / 20).collect();
        let c = sel_grid(d, &d.channels[0].mask, r).iter().map(|v| v / 20).collect();
        (px, m, s, c)
    }

    #[test]
    fn exact_canvas_rotations_are_byte_exact_on_every_plane() {
        let base = letters_doc();
        let (a, b, c, dd, e, f) = (1, 2, 3, 4, 5, 6);
        let cases: [(Remap, (u32, u32), Vec<u8>); 5] = [
            (Remap::Cw, (2, 3), vec![dd, a, e, b, f, c]),
            (Remap::Ccw, (2, 3), vec![c, f, b, e, a, dd]),
            (Remap::R180, (3, 2), vec![f, e, dd, c, b, a]),
            (Remap::FlipH, (3, 2), vec![c, b, a, f, e, dd]),
            (Remap::FlipV, (3, 2), vec![dd, e, f, a, b, c]),
        ];
        for (kind, size, want) in cases {
            let mut d = base.clone();
            d.rotate_canvas_exact(kind).unwrap();
            assert_eq!((d.width, d.height), size, "{kind:?}");
            assert_eq!(d.layer_bounds(1).unwrap(), Some(canvas(&d)), "{kind:?}");
            assert_eq!(letters(&d), (want.clone(), want.clone(), want.clone(), want), "{kind:?}");
            assert!(grid(&d, 1, canvas(&d)).iter().all(|p| p[3] == 255));
            assert!(d.selection.as_ref().unwrap().tiles.coords().iter().all(|t| d.on_canvas(t.0, t.1)));
        }
    }

    #[test]
    fn arbitrary_multiples_of_90_route_to_the_exact_ops() {
        let base = letters_doc();
        for (deg, kind) in [(90.0, Remap::Cw), (-270.0, Remap::Cw), (450.0, Remap::Cw), (180.0, Remap::R180), (270.0, Remap::Ccw), (-90.0, Remap::Ccw)] {
            let (mut a, mut b) = (base.clone(), base.clone());
            assert!(a.rotate_canvas(deg, Interp::Bicubic).unwrap());
            b.rotate_canvas_exact(kind).unwrap();
            assert_eq!((a.width, a.height), (b.width, b.height), "{deg}");
            assert_eq!(letters(&a), letters(&b), "{deg}");
        }
        for deg in [0.0, 360.0, -720.0] {
            let mut d = base.clone();
            assert!(!d.rotate_canvas(deg, Interp::Bicubic).unwrap());
            assert_eq!(letters(&d), letters(&base));
        }
        assert_eq!(base.clone().rotate_canvas(f64::INFINITY, Interp::Bicubic).unwrap_err(), "angle must be finite");
    }

    #[test]
    fn arbitrary_30_degrees_grows_the_canvas_to_the_rounded_out_bbox() {
        let mut d = pattern_doc(100, 50, |_, _| [200, 100, 50, 255]);
        d.add_mask(1, true).unwrap();
        d.select_all().unwrap();
        assert!(d.rotate_canvas(30.0, Interp::Bicubic).unwrap());
        assert_eq!((d.width, d.height), (112, 94));
        // Exposed corners are transparent, the mask keeps its default, the selection stays all.
        assert_eq!(get_px(&d, 1, 0, 0), [0; 4]);
        assert_eq!(get_px(&d, 1, 111, 93), [0; 4]);
        assert_eq!(get_px(&d, 1, 56, 47), [200, 100, 50, 255]);
        assert_eq!(get_mask(&d, 1, 0, 0), 255);
        assert_eq!(sel_grid(&d, d.selection.as_ref().unwrap(), [0, 0, 1, 1]), vec![255]);
        let b = d.layer_bounds(1).unwrap().unwrap();
        assert!(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= 112 && b[1] + b[3] <= 94, "{b:?}");
    }

    #[test]
    fn crop_rotated_rotates_by_minus_the_angle_then_crops_the_mapped_bbox() {
        let base = pattern_doc(100, 50, |_, _| [10, 20, 30, 255]);
        let mut d = base.clone();
        assert!(!d.crop_rotated([0.0, 0.0, 100.0, 50.0], 0.0, true).unwrap());
        assert_eq!((d.width, d.height), (100, 50));
        assert!(d.crop_rotated([10.0, 10.0, 50.0, 20.0], 10.0, true).unwrap());
        assert_eq!((d.width, d.height), (53, 29));
        assert_eq!(get_px(&d, 1, 26, 14), [10, 20, 30, 255]);
        // Angle 0 with a smaller rect is a plain crop.
        let mut p = base.clone();
        assert!(p.crop_rotated([10.0, 10.0, 50.0, 20.0], 0.0, true).unwrap());
        assert_eq!((p.width, p.height), (50, 20));
    }

    fn varied_doc() -> Document {
        pattern_doc(16, 12, |x, y| [(x * 15) as u8, (y * 20) as u8, ((x * y) % 256) as u8, (128 + x * 8) as u8])
    }

    #[test]
    fn perspective_crop_of_an_axis_aligned_quad_equals_a_plain_crop() {
        let mut p = varied_doc();
        p.select_all().unwrap();
        let mut c = p.clone();
        p.perspective_crop(&[3.0, 2.0, 11.0, 2.0, 11.0, 9.0, 3.0, 9.0], 8, 7, Interp::Bilinear).unwrap();
        c.apply_crop([3.0, 2.0, 8.0, 7.0], true).unwrap();
        assert_eq!((p.width, p.height), (8, 7));
        assert_eq!(p.layer_bounds(1).unwrap(), c.layer_bounds(1).unwrap());
        for (a, b) in grid(&p, 1, [0, 0, 8, 7]).iter().zip(grid(&c, 1, [0, 0, 8, 7])) {
            assert!(a.iter().zip(b).all(|(u, v)| u.abs_diff(v) <= 1), "{a:?} vs {b:?}");
        }
        assert!(p.selection.is_none());
    }

    #[test]
    fn perspective_crop_leaves_masks_and_channels_alone() {
        let mut d = letters_doc();
        let before_mask = mask_grid(&d, 1, [0, 0, 3, 2]);
        d.perspective_crop(&[0.0, 0.0, 3.0, 0.0, 3.0, 2.0, 0.0, 2.0], 6, 4, Interp::Bicubic).unwrap();
        assert_eq!((d.width, d.height), (6, 4));
        assert_eq!(mask_grid(&d, 1, [0, 0, 3, 2]), before_mask);
        assert_eq!(d.channels.len(), 1);
        // A self-intersecting quad is accepted.
        d.perspective_crop(&[0.0, 0.0, 6.0, 4.0, 6.0, 0.0, 0.0, 4.0], 5, 5, Interp::Bicubic).unwrap();
        assert_eq!((d.width, d.height), (5, 5));
    }

    #[test]
    fn perspective_crop_drops_off_canvas_channel_and_last_selection_tiles() {
        let mut d = Document::new(600, 600, 8).unwrap();
        put_sel(&mut d, 400, 400, 255);
        d.save_selection("far").unwrap();
        d.deselect().unwrap();
        d.perspective_crop(&[0.0, 0.0, 100.0, 0.0, 100.0, 100.0, 0.0, 100.0], 100, 100, Interp::Bilinear).unwrap();
        Document::from_manifest(&d.manifest()).unwrap();
    }

    #[test]
    fn crop_rotated_by_a_full_turn_on_the_canvas_rect_is_a_no_op() {
        let mut d = crop_doc();
        assert!(!d.crop_rotated([0.0, 0.0, 6.0, 4.0], 360.0, true).unwrap());
        assert!(!d.crop_rotated([0.0, 0.0, 6.0, 4.0], -720.0, true).unwrap());
    }

    #[test]
    fn a_collinear_quad_is_refused_and_changes_nothing() {
        let mut d = varied_doc();
        let before = grid(&d, 1, [0, 0, 16, 12]);
        let e = d.perspective_crop(&[0.0, 0.0, 1.0, 1.0, 2.0, 2.0, 3.0, 3.0], 8, 8, Interp::Bicubic).unwrap_err();
        assert_eq!(e, "Those four corners are degenerate; move one and try again.");
        assert_eq!((d.width, d.height), (16, 12));
        assert_eq!(grid(&d, 1, [0, 0, 16, 12]), before);
        assert_eq!(d.perspective_crop(&[0.0; 6], 8, 8, Interp::Bicubic).unwrap_err(), "perspective crop needs 4 finite corners");
        assert_eq!(
            d.perspective_crop(&[0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0], 0, 8, Interp::Bicubic).unwrap_err(),
            "width and height must be in 1..=65536"
        );
    }

    fn coord_px(x: i32, y: i32) -> [u8; 4] {
        [(10 * x + 1) as u8, (10 * y + 1) as u8, 7, 255]
    }

    #[test]
    fn canvas_size_places_the_old_canvas_by_the_anchor() {
        let base = pattern_doc(10, 10, coord_px);
        for ay in -1i8..=1 {
            for ax in -1i8..=1 {
                let mut d = base.clone();
                assert!(d.canvas_size(14, 12, (ax, ay), None).unwrap());
                assert_eq!((d.width, d.height), (14, 12));
                let (ox, oy) = ([0, 2, 4][(ax + 1) as usize], [0, 1, 2][(ay + 1) as usize]);
                assert_eq!(grid(&d, 1, [ox, oy, 10, 10]), grid(&base, 1, [0, 0, 10, 10]), "{ax} {ay}");
                assert_eq!(d.layer_bounds(1).unwrap(), Some([ox, oy, 10, 10]), "{ax} {ay}");
            }
        }
        // An odd difference puts the extra pixel left/top when growing, right/bottom when shrinking.
        let mut g = base.clone();
        assert!(g.canvas_size(13, 13, (0, 0), None).unwrap());
        assert_eq!(get_px(&g, 1, 2, 2), coord_px(0, 0));
        let mut s = base.clone();
        assert!(s.canvas_size(7, 7, (0, 0), None).unwrap());
        assert_eq!(grid(&s, 1, [0, 0, 7, 7]), grid(&base, 1, [1, 1, 7, 7]));
    }

    #[test]
    fn canvas_size_shrink_deletes_pixels_outside_the_new_canvas() {
        let mut base = pattern_doc(10, 10, coord_px);
        put_px(&mut base, 1, -3, 0, [1, 2, 3, 255]);
        let mut d = base.clone();
        assert!(d.canvas_size(6, 6, (0, 0), None).unwrap());
        assert_eq!((d.width, d.height), (6, 6));
        assert_eq!(grid(&d, 1, [0, 0, 6, 6]), grid(&base, 1, [2, 2, 6, 6]));
        assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 6, 6]));
        assert!(!d.canvas_size(6, 6, (1, 1), Some([1.0, 0.0, 0.0, 1.0])).unwrap());
        assert_eq!(d.canvas_size(0, 6, (0, 0), None).unwrap_err(), "width and height must be in 1..=65536");
        assert!(d.canvas_size(8, 8, (2, 0), None).is_err());
        assert!(d.canvas_size(8, 8, (0, 0), Some([f32::NAN, 0.0, 0.0, 1.0])).is_err());
        assert_eq!((d.width, d.height), (6, 6));
    }

    #[test]
    fn canvas_size_fill_paints_only_the_added_area_of_the_bottom_pixel_layer() {
        let base = pattern_doc(4, 4, |_, _| [10, 20, 30, 255]);
        let mut d = base.clone();
        let top = d.add_layer("top", 1).unwrap();
        put_px(&mut d, top, 0, 0, [5, 5, 5, 255]);
        assert!(d.canvas_size(6, 5, (-1, -1), Some([1.0, 0.0, 0.0, 1.0])).unwrap());
        assert_eq!(grid(&d, 1, [0, 0, 4, 4]), grid(&base, 1, [0, 0, 4, 4]));
        for (x, y) in [(4, 0), (5, 4), (0, 4), (3, 4)] {
            assert_eq!(get_px(&d, 1, x, y), [255, 0, 0, 255], "({x}, {y})");
            assert_eq!(get_px(&d, top, x, y), [0; 4]);
        }
        assert_eq!(get_px(&d, top, 0, 0), [5, 5, 5, 255]);
        assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 6, 5]));
    }

    fn one_point_path(x: f64, y: f64) -> crate::path::SavedPath {
        let pt = [x, y, x, y, x, y];
        let sub = crate::path::Subpath { closed: false, op: crate::path::PathOp::Combine, points: vec![pt] };
        crate::path::SavedPath { id: 1, name: "p".into(), path: VectorPath { fill_rule: crate::path::FillRule::Nonzero, subpaths: vec![sub] }, work: false }
    }

    #[test]
    fn canvas_size_shifts_guides_and_saved_paths_by_the_anchor_offset() {
        let mut d = pattern_doc(10, 10, coord_px);
        d.add_guide("x", 3.0, 0).unwrap();
        d.add_guide("y", 5.0, 0).unwrap();
        d.vector.paths.push(one_point_path(2.0, 3.0));
        assert!(d.canvas_size(14, 12, (1, 1), None).unwrap());
        assert_eq!(d.vector.guides.iter().map(|g| g.pos).collect::<Vec<_>>(), vec![7.0, 7.0]);
        assert_eq!(d.vector.paths[0].path.subpaths[0].points[0], [6.0, 5.0, 6.0, 5.0, 6.0, 5.0]);
    }

    #[test]
    fn image_size_upscales_a_solid_layer_to_a_solid_canvas() {
        let mut d = pattern_doc(10, 6, |_, _| [200, 100, 50, 255]);
        assert!(!d.image_size(10, 6, Interp::Bicubic, false).unwrap());
        assert!(d.image_size(20, 12, Interp::Bicubic, false).unwrap());
        assert_eq!((d.width, d.height), (20, 12));
        assert!(grid(&d, 1, [0, 0, 20, 12]).iter().all(|p| *p == [200, 100, 50, 255]));
        assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 20, 12]));
        assert_eq!(d.image_size(0, 12, Interp::Bicubic, false).unwrap_err(), "width and height must be in 1..=65536");
        assert_eq!(d.image_size(20_000, 20_000, Interp::Bicubic, false).unwrap_err(), "transform result is too large");
        assert_eq!((d.width, d.height), (20, 12));
    }

    #[test]
    fn image_size_downscale_of_a_checker_averages_to_mid_grey() {
        let mut d = pattern_doc(2, 2, |x, y| if (x + y) % 2 == 0 { [0, 0, 0, 255] } else { [255, 255, 255, 255] });
        assert!(d.image_size(1, 1, Interp::Bilinear, false).unwrap());
        let p = get_px(&d, 1, 0, 0);
        assert!(p[..3].iter().all(|v| v.abs_diff(128) <= 1) && p[3] == 255, "{p:?}");
    }

    #[test]
    fn image_size_scales_masks_offcanvas_pixels_paths_and_guides() {
        let mut d = pattern_doc(10, 10, |_, _| [9, 9, 9, 255]);
        put_px(&mut d, 1, -2, 0, [1, 2, 3, 255]);
        d.add_mask(1, true).unwrap();
        put_mask(&mut d, 1, 4, 4, 0);
        d.add_guide("x", 3.0, 0).unwrap();
        d.add_guide("y", 5.0, 0).unwrap();
        d.vector.paths.push(one_point_path(2.0, 3.0));
        assert!(d.image_size(20, 30, Interp::Nearest, false).unwrap());
        assert_eq!(mask_grid(&d, 1, [8, 12, 2, 3]), vec![0; 6]);
        assert_eq!(get_mask(&d, 1, 7, 12), 255);
        assert_eq!(get_mask(&d, 1, 10, 15), 255);
        assert_eq!(get_px(&d, 1, -4, 0), [1, 2, 3, 255]);
        assert_eq!(get_px(&d, 1, -3, 2), [1, 2, 3, 255]);
        assert_eq!(d.vector.guides.iter().map(|g| g.pos).collect::<Vec<_>>(), vec![6.0, 15.0]);
        assert_eq!(d.vector.paths[0].path.subpaths[0].points[0], [4.0, 9.0, 4.0, 9.0, 4.0, 9.0]);
    }

    #[test]
    fn image_size_scale_styles_scales_the_effects() {
        let style = r#"{"enabled":true,"scale":1.5,"drop_shadows":[],"inner_shadows":[],"color_overlays":[],
            "gradient_overlays":[],"pattern_overlays":[],"strokes":[]}"#;
        let mut d = pattern_doc(10, 10, |_, _| [9, 9, 9, 255]);
        d.set_style(1, style).unwrap();
        let scale = |d: &Document| d.node(1).unwrap().style.as_ref().unwrap().scale;
        let mut off = d.clone();
        assert!(off.image_size(20, 20, Interp::Bilinear, false).unwrap());
        assert_eq!(scale(&off), 1.5);
        assert!(d.image_size(20, 20, Interp::Bilinear, true).unwrap());
        assert_eq!(scale(&d), 3.0);
        // sqrt(sx * sy), clamped to the Scale Effects range.
        assert!(d.image_size(80, 20, Interp::Bilinear, true).unwrap());
        assert_eq!(scale(&d), 6.0);
        assert!(d.image_size(800, 200, Interp::Nearest, true).unwrap());
        assert_eq!(scale(&d), 10.0);
    }

    #[test]
    fn each_canvas_op_is_one_snapshot_step() {
        let ops: [(fn() -> Document, fn(&mut Document)); 7] = [
            (crop_doc, |d| assert!(d.apply_crop([1.0, 1.0, 3.0, 2.0], true).unwrap())),
            (crop_doc, |d| assert!(d.crop_rotated([1.0, 0.0, 3.0, 3.0], 5.0, false).unwrap())),
            (trim_transparent_doc, |d| assert!(d.trim("transparent", true, true, true, true).unwrap())),
            (crop_doc, |d| assert!(d.reveal_all().unwrap())),
            (crop_doc, |d| d.rotate_canvas_exact(Remap::Cw).unwrap()),
            (crop_doc, |d| assert!(d.rotate_canvas(30.0, Interp::Bicubic).unwrap())),
            (crop_doc, |d| d.perspective_crop(&[0.0, 0.0, 5.0, 1.0, 6.0, 4.0, 1.0, 3.0], 4, 3, Interp::Bicubic).unwrap()),
        ];
        let state = |d: &Document| {
            let mut v: serde_json::Value = serde_json::from_str(&d.manifest()).unwrap();
            v.as_object_mut().unwrap().remove("next_id");
            v
        };
        for (fixture, op) in ops {
            let mut core = EngineCore::new(fixture());
            let before = state(&core.doc);
            let snap = core.snapshot();
            op(&mut core.doc);
            assert_ne!(state(&core.doc), before);
            core.restore(snap).unwrap();
            assert_eq!(state(&core.doc), before);
        }
    }
}
