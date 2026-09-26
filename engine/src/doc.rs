use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::blend::{blend_rgb, dissolve_hash, paint_mask_value, paint_pixel, Blend, PaintMode};
use crate::livewire::{self, LiveWire};
use crate::region;
use crate::selection::{gaussian_kernel, Ellipse, MaskShape, Mode, Polygon, Rect, Shape};
use crate::stroke::{self, Sample, Spacer, Tip, TipShape};

pub const TILE: usize = 256;
const TILE_PIXELS: usize = TILE * TILE;
const TILE_BYTES_U8: usize = TILE_PIXELS * 4;
const TILE_BYTES_U16: usize = TILE_PIXELS * 4 * 2;
const MASK_BYTES_U8: usize = TILE_PIXELS;
const MASK_BYTES_U16: usize = TILE_PIXELS * 2;
const MANIFEST_FORMAT: &str = "photobaer-manifest";
const MANIFEST_VERSION: u32 = 3;
// A tile coordinate far outside the largest canvas is a broken file, not a moved layer.
const MAX_TILE_COORD: u32 = 1 << 20;
// Ids travel as JS numbers; anything above 2^53 would lose precision or overflow next_id.
const MAX_ID: u64 = 1 << 53;

fn max_value(depth: u8) -> u32 {
    if depth == 8 {
        255
    } else {
        65535
    }
}

#[derive(Clone)]
pub enum Pixels {
    U8(Box<[u8]>),
    U16(Box<[u16]>),
    Mask8(Box<[u8]>),
    Mask16(Box<[u16]>),
}

impl Pixels {
    #[inline(always)]
    fn rgba_f32(&self, p: usize) -> [f32; 4] {
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
            _ => [0.0; 4],
        }
    }

    fn mask_f32(&self, p: usize) -> f32 {
        match self {
            Pixels::Mask8(d) => d[p] as f32 / 255.0,
            Pixels::Mask16(d) => d[p] as f32 / 65535.0,
            _ => 1.0,
        }
    }

    // Writes one straight RGBA pixel back, quantized like `from_straight`.
    #[inline(always)]
    fn set_rgba_f32(&mut self, p: usize, v: [f32; 4]) {
        let o = p * 4;
        match self {
            Pixels::U8(d) => {
                for i in 0..4 {
                    d[o + i] = (v[i] * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
            Pixels::U16(d) => {
                for i in 0..4 {
                    d[o + i] = (v[i] * 65535.0).round().clamp(0.0, 65535.0) as u16;
                }
            }
            _ => {}
        }
    }

    fn transparent(depth: u8) -> Pixels {
        if depth == 8 {
            Pixels::U8(vec![0u8; TILE_PIXELS * 4].into_boxed_slice())
        } else {
            Pixels::U16(vec![0u16; TILE_PIXELS * 4].into_boxed_slice())
        }
    }

    fn any_alpha(&self) -> bool {
        match self {
            Pixels::U8(d) => d.chunks_exact(4).any(|p| p[3] > 0),
            Pixels::U16(d) => d.chunks_exact(4).any(|p| p[3] > 0),
            _ => true,
        }
    }

    fn byte_len(&self) -> usize {
        match self {
            Pixels::U8(d) | Pixels::Mask8(d) => d.len(),
            Pixels::U16(d) => d.len() * 2,
            Pixels::Mask16(d) => d.len() * 2,
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        match self {
            Pixels::U8(d) | Pixels::Mask8(d) => d.to_vec(),
            Pixels::U16(d) | Pixels::Mask16(d) => {
                let mut out = Vec::with_capacity(d.len() * 2);
                for v in d.iter() {
                    out.extend_from_slice(&v.to_le_bytes());
                }
                out
            }
        }
    }

    fn from_bytes(depth: u8, mask: bool, bytes: &[u8]) -> Result<Pixels, String> {
        let want = match (depth, mask) {
            (8, false) => TILE_BYTES_U8,
            (8, true) => MASK_BYTES_U8,
            (_, false) => TILE_BYTES_U16,
            (_, true) => MASK_BYTES_U16,
        };
        if bytes.len() != want {
            return Err(format!("expected {want} bytes, got {}", bytes.len()));
        }
        Ok(match (depth, mask) {
            (8, false) => Pixels::U8(bytes.to_vec().into_boxed_slice()),
            (8, true) => Pixels::Mask8(bytes.to_vec().into_boxed_slice()),
            (_, m) => {
                let mut out = Vec::with_capacity(bytes.len() / 2);
                for chunk in bytes.chunks_exact(2) {
                    out.push(u16::from_le_bytes([chunk[0], chunk[1]]));
                }
                let b = out.into_boxed_slice();
                if m {
                    Pixels::Mask16(b)
                } else {
                    Pixels::U16(b)
                }
            }
        })
    }

    fn from_rgba8(depth: u8, rgba8: &[u8]) -> Pixels {
        if depth == 8 {
            Pixels::U8(rgba8.to_vec().into_boxed_slice())
        } else {
            Pixels::U16(rgba8.iter().map(|v| *v as u16 * 257).collect::<Vec<_>>().into_boxed_slice())
        }
    }

    fn from_mask8(depth: u8, data: &[u8]) -> Pixels {
        if depth == 8 {
            Pixels::Mask8(data.to_vec().into_boxed_slice())
        } else {
            Pixels::Mask16(data.iter().map(|v| *v as u16 * 257).collect::<Vec<_>>().into_boxed_slice())
        }
    }

    // Straight RGBA in 0..1, quantized to the document depth.
    fn from_straight(depth: u8, v: &[f32]) -> Pixels {
        let max = max_value(depth) as f32;
        let q = |x: &f32| (x * max).round().clamp(0.0, max);
        if depth == 8 {
            Pixels::U8(v.iter().map(|x| q(x) as u8).collect::<Vec<_>>().into_boxed_slice())
        } else {
            Pixels::U16(v.iter().map(|x| q(x) as u16).collect::<Vec<_>>().into_boxed_slice())
        }
    }

    fn mask_from_norm(depth: u8, v: &[f32]) -> Pixels {
        let max = max_value(depth) as f32;
        let q = |x: &f32| (x * max).round().clamp(0.0, max);
        if depth == 8 {
            Pixels::Mask8(v.iter().map(|x| q(x) as u8).collect::<Vec<_>>().into_boxed_slice())
        } else {
            Pixels::Mask16(v.iter().map(|x| q(x) as u16).collect::<Vec<_>>().into_boxed_slice())
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
                }
                Pixels::U16(out)
            }
            Pixels::Mask8(d) => Pixels::Mask8(d.iter().map(|v| 255 - v).collect::<Vec<_>>().into_boxed_slice()),
            Pixels::Mask16(d) => Pixels::Mask16(d.iter().map(|v| 65535 - v).collect::<Vec<_>>().into_boxed_slice()),
        }
    }

    // Replaces color but keeps every pixel's alpha (transparency lock).
    fn recolored(&self, r: u8, g: u8, b: u8) -> Pixels {
        match self {
            Pixels::U8(d) => {
                let mut out = d.clone();
                for p in 0..TILE_PIXELS {
                    let o = p * 4;
                    out[o] = r;
                    out[o + 1] = g;
                    out[o + 2] = b;
                }
                Pixels::U8(out)
            }
            Pixels::U16(d) => {
                let mut out = d.clone();
                for p in 0..TILE_PIXELS {
                    let o = p * 4;
                    out[o] = r as u16 * 257;
                    out[o + 1] = g as u16 * 257;
                    out[o + 2] = b as u16 * 257;
                }
                Pixels::U16(out)
            }
            other => other.clone(),
        }
    }
}

#[derive(Clone)]
pub struct Tile {
    pub id: u64,
    pub px: Arc<Pixels>,
}

/// Selection coverage over one tile.
enum Cov {
    Uniform(f32),
    Tile(Arc<Pixels>),
}

impl Cov {
    #[inline(always)]
    fn at(&self, p: usize) -> f32 {
        match self {
            Cov::Uniform(v) => *v,
            Cov::Tile(px) => px.mask_f32(p),
        }
    }
}

// One edited RGBA tile: `f` maps straight old RGBA to straight new RGBA, and the coverage lerps
// between them (premultiplied, so a partial edge keeps its colour). None when nothing is left.
fn edit_rgba(
    depth: u8,
    old: Option<&Pixels>,
    cov: &Cov,
    keep_alpha: bool,
    f: &impl Fn([f32; 4]) -> [f32; 4],
) -> Option<Pixels> {
    let mut out = vec![0f32; TILE_PIXELS * 4];
    let mut any = false;
    for p in 0..TILE_PIXELS {
        let o = p * 4;
        let ob = old.map_or([0.0; 4], |px| px.rgba_f32(p));
        let c = cov.at(p).clamp(0.0, 1.0);
        let px = if c <= 0.0 {
            ob
        } else {
            let nw = f(ob);
            if keep_alpha {
                [ob[0] + (nw[0] - ob[0]) * c, ob[1] + (nw[1] - ob[1]) * c, ob[2] + (nw[2] - ob[2]) * c, ob[3]]
            } else {
                let a = ob[3] + (nw[3] - ob[3]) * c;
                if a <= 0.0 {
                    [0.0; 4]
                } else {
                    let ch = |i: usize| {
                        let (pb, pn) = (ob[i] * ob[3], nw[i] * nw[3]);
                        ((pb + (pn - pb) * c) / a).clamp(0.0, 1.0)
                    };
                    [ch(0), ch(1), ch(2), a]
                }
            }
        };
        any |= px[3] > 0.0;
        out[o..o + 4].copy_from_slice(&px);
    }
    any.then(|| Pixels::from_straight(depth, &out))
}

// The same for a single-channel mask; `f` maps the old value in 0..1 to the new one.
// None when the whole tile ends up at the mask default.
fn edit_mask(depth: u8, old: Option<&Pixels>, default: u32, cov: &Cov, f: &impl Fn(f32) -> f32) -> Option<Pixels> {
    let max = max_value(depth) as f32;
    let def = default as f32 / max;
    let mut out = vec![0f32; TILE_PIXELS];
    for (p, v) in out.iter_mut().enumerate() {
        let ov = old.map_or(def, |px| px.mask_f32(p));
        *v = (ov + (f(ov) - ov) * cov.at(p).clamp(0.0, 1.0)).clamp(0.0, 1.0);
    }
    let px = Pixels::mask_from_norm(depth, &out);
    let uniform = match &px {
        Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == default),
        Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == default),
        _ => false,
    };
    (!uniform).then_some(px)
}

/// Sparse tile grid, signed tile coordinates on the canvas tile grid. A missing tile is fully
/// transparent (pixels) or the mask default; tiles outside the canvas are kept but never displayed.
#[derive(Clone, Default)]
pub struct Tiles(HashMap<(i32, i32), Tile>);

impl Tiles {
    fn get(&self, tx: i32, ty: i32) -> Option<&Tile> {
        self.0.get(&(tx, ty))
    }

    fn id_at(&self, tx: i32, ty: i32) -> u64 {
        self.get(tx, ty).map_or(0, |t| t.id)
    }

    fn put(&mut self, tx: i32, ty: i32, tile: Option<Tile>) {
        match tile {
            Some(t) => {
                self.0.insert((tx, ty), t);
            }
            None => {
                self.0.remove(&(tx, ty));
            }
        }
    }

    fn coords(&self) -> Vec<(i32, i32)> {
        let mut v: Vec<(i32, i32)> = self.0.keys().copied().collect();
        v.sort_unstable_by_key(|(tx, ty)| (*ty, *tx));
        v
    }

    fn iter(&self) -> impl Iterator<Item = (&(i32, i32), &Tile)> {
        self.0.iter()
    }

    fn clear(&mut self) {
        self.0.clear();
    }

    fn out(&self) -> Vec<(i32, i32, u64)> {
        self.coords().into_iter().map(|(tx, ty)| (tx, ty, self.id_at(tx, ty))).collect()
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Locks {
    pub transparency: bool,
    pub pixels: bool,
    pub position: bool,
}

#[derive(Clone)]
pub struct Mask {
    pub enabled: bool,
    pub default: u32,
    pub tiles: Tiles,
}

/// A selection or saved channel: one canvas-sized single-channel mask at document depth.
#[derive(Clone, Default)]
pub struct SelMask {
    pub default: u32,
    pub tiles: Tiles,
}

#[derive(Clone)]
pub struct Channel {
    pub id: u32,
    pub name: String,
    pub mask: SelMask,
}

#[derive(Clone)]
pub enum Kind {
    Pixel(Tiles),
    Group(Vec<Node>),
}

#[derive(Clone)]
pub struct Node {
    pub id: u32,
    pub name: String,
    pub visible: bool,
    pub opacity: f32,
    pub fill: f32,
    pub blend: Blend,
    pub clipping: bool,
    pub locks: Locks,
    pub mask: Option<Mask>,
    pub kind: Kind,
}

impl Node {
    fn new(id: u32, name: &str, kind: Kind) -> Node {
        Node {
            id,
            name: name.to_string(),
            visible: true,
            opacity: 1.0,
            fill: 1.0,
            blend: if matches!(kind, Kind::Group(_)) { Blend::PassThrough } else { Blend::Normal },
            clipping: false,
            locks: Locks::default(),
            mask: None,
            kind,
        }
    }

    fn is_group(&self) -> bool {
        matches!(self.kind, Kind::Group(_))
    }

    fn pixel_tiles(&self) -> Result<&Tiles, String> {
        match &self.kind {
            Kind::Pixel(t) => Ok(t),
            Kind::Group(_) => Err(format!("node {} is a group and has no pixels", self.id)),
        }
    }

    fn pixel_tiles_mut(&mut self) -> Result<&mut Tiles, String> {
        let id = self.id;
        match &mut self.kind {
            Kind::Pixel(t) => Ok(t),
            Kind::Group(_) => Err(format!("node {id} is a group and has no pixels")),
        }
    }
}

fn find_path_in(nodes: &[Node], id: u32, cur: &mut Vec<usize>) -> bool {
    for (i, n) in nodes.iter().enumerate() {
        cur.push(i);
        if n.id == id {
            return true;
        }
        if let Kind::Group(ch) = &n.kind {
            if find_path_in(ch, id, cur) {
                return true;
            }
        }
        cur.pop();
    }
    false
}

fn list_mut<'a>(nodes: &'a mut Vec<Node>, path: &[usize]) -> &'a mut Vec<Node> {
    let mut cur = nodes;
    for &i in path {
        cur = match &mut cur[i].kind {
            Kind::Group(ch) => ch,
            Kind::Pixel(_) => unreachable!("a node path only walks through groups"),
        };
    }
    cur
}

fn node_at<'a>(nodes: &'a [Node], path: &[usize]) -> &'a Node {
    let (last, prefix) = path.split_last().expect("a node path is never empty");
    let mut cur = nodes;
    for &i in prefix {
        cur = match &cur[i].kind {
            Kind::Group(ch) => ch,
            Kind::Pixel(_) => unreachable!("a node path only walks through groups"),
        };
    }
    &cur[*last]
}

fn node_at_mut<'a>(nodes: &'a mut Vec<Node>, path: &[usize]) -> &'a mut Node {
    let (last, prefix) = path.split_last().expect("a node path is never empty");
    &mut list_mut(nodes, prefix)[*last]
}

// Where a loading tile belongs: a node's pixels or mask, the selection, the last selection,
// or a saved channel.
#[derive(Clone)]
enum Slot {
    Pixels(Vec<usize>),
    Mask(Vec<usize>),
    Selection,
    LastSelection,
    Channel(usize),
}

#[derive(Clone)]
struct Loading {
    // tile id -> (is_mask, [(slot, tx, ty)]) still waiting for pixel data.
    slots: HashMap<u64, (bool, Vec<(Slot, i32, i32)>)>,
    pending_ids: HashSet<u64>,
    max_referenced_id: u64,
}

#[derive(Clone)]
pub struct Document {
    width: u32,
    height: u32,
    depth: u8,
    nodes: Vec<Node>,
    selection: Option<SelMask>,
    last_selection: Option<SelMask>,
    channels: Vec<Channel>,
    next_id: u64,
    next_node_id: u32,
    loading: Option<Loading>,
    // Reduced tiles for display levels >= 1, keyed by content, shared by clones. Never persisted.
    tile_cache: Arc<RefCell<TileCache>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Pixels,
    Mask,
    Selection,
}

impl Target {
    pub fn parse(s: &str) -> Result<Target, String> {
        match s {
            "pixels" => Ok(Target::Pixels),
            "mask" => Ok(Target::Mask),
            "selection" => Ok(Target::Selection),
            other => Err(format!("unknown target {other}")),
        }
    }
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

fn unit(v: f32, what: &str) -> Result<f32, String> {
    if v.is_nan() || !(0.0..=1.0).contains(&v) {
        return Err(format!("{what} must be in 0..=1"));
    }
    Ok(v)
}

// ---------- compositing ----------

struct TileCtx {
    level: u32,
    // Top-left of the tile in level-`level` pixels.
    ox: u32,
    oy: u32,
    vw: usize,
    vh: usize,
}

enum MaskSrc<'a> {
    Full,
    Const(f32),
    Tile(&'a Pixels),
}

impl MaskSrc<'_> {
    #[inline(always)]
    fn at(&self, p: usize) -> f32 {
        match self {
            MaskSrc::Full => 1.0,
            MaskSrc::Const(v) => *v,
            MaskSrc::Tile(px) => px.mask_f32(p),
        }
    }
}

#[derive(Clone, Copy)]
enum Src<'a> {
    Tile(&'a Pixels),
    Buf(&'a [f32]),
}

impl Src<'_> {
    // Straight (unpremultiplied) RGBA.
    #[inline(always)]
    fn at(&self, p: usize) -> [f32; 4] {
        match self {
            Src::Tile(px) => px.rgba_f32(p),
            Src::Buf(b) => {
                let o = p * 4;
                let a = b[o + 3];
                if a > 0.0 {
                    [b[o] / a, b[o + 1] / a, b[o + 2] / a, a]
                } else {
                    [0.0; 4]
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw(
    dst: &mut [f32],
    src: Src,
    mask: &MaskSrc,
    scale: f32,
    mode: Blend,
    node_id: u32,
    c: &TileCtx,
) {
    if scale <= 0.0 {
        return;
    }
    let dissolve = mode == Blend::Dissolve;
    let plain = mode.is_passthrough_of_source();
    for y in 0..c.vh {
        for x in 0..c.vw {
            let p = y * TILE + x;
            let [r, g, b, a] = src.at(p);
            if a <= 0.0 {
                continue;
            }
            let mut cov = a * scale * mask.at(p);
            if cov <= 0.0 {
                continue;
            }
            if dissolve {
                // Document coordinates of the sample's top-left source pixel.
                let (dx, dy) = ((c.ox + x as u32) << c.level, (c.oy + y as u32) << c.level);
                if dissolve_hash(dx, dy, node_id) < cov {
                    cov = 1.0;
                } else {
                    continue;
                }
            }
            let o = p * 4;
            let ab = dst[o + 3];
            // W3C: Cm = (1 - ab) * Cs + ab * B(Cb, Cs); with ab = 0 that is Cs.
            let cm = if plain || ab <= 0.0 {
                [r, g, b]
            } else {
                let inv = 1.0 / ab;
                let cb = [
                    (dst[o] * inv).clamp(0.0, 1.0),
                    (dst[o + 1] * inv).clamp(0.0, 1.0),
                    (dst[o + 2] * inv).clamp(0.0, 1.0),
                ];
                let bl = blend_rgb(mode, cb, [r, g, b]);
                [
                    (1.0 - ab) * r + ab * bl[0],
                    (1.0 - ab) * g + ab * bl[1],
                    (1.0 - ab) * b + ab * bl[2],
                ]
            };
            let inv = 1.0 - cov;
            dst[o] = cov * cm[0] + inv * dst[o];
            dst[o + 1] = cov * cm[1] + inv * dst[o + 1];
            dst[o + 2] = cov * cm[2] + inv * dst[o + 2];
            dst[o + 3] = cov + inv * ab;
        }
    }
}

// ---------- pyramid reduction ----------

// One level-up tile from the four quadrant tiles below it: each output pixel is the
// alpha-weighted mean colour and the mean alpha of the valid source pixels in its 2x2 block,
// rounded half up; a block with no alpha stays transparent. Integer maths throughout.
fn reduce_rgba<T: Copy + Default + Into<u64>>(
    kids: [Option<&[T]>; 4],
    valid: &[(usize, usize); 4],
    cast: fn(u64) -> T,
) -> Box<[T]> {
    let half = TILE / 2;
    // 8-bit sums fit in 32 bits, and a 32-bit division is much cheaper than a 64-bit one.
    let div = |n: u64, d: u64| if size_of::<T>() == 1 { ((n as u32) / (d as u32)) as u64 } else { n / d };
    let mut out = vec![T::default(); TILE_PIXELS * 4];
    for (q, px) in kids.into_iter().enumerate() {
        let Some(px) = px else { continue };
        let (qx, qy) = (q & 1, q >> 1);
        let (vw, vh) = valid[q];
        for oy in 0..half.min(vh.div_ceil(2)) {
            for ox in 0..half.min(vw.div_ceil(2)) {
                let o = ((qy * half + oy) * TILE + qx * half + ox) * 4;
                let at = |sx: usize, sy: usize| (sy * TILE + sx) * 4;
                let (x, y) = (ox * 2, oy * 2);
                if x + 1 < vw && y + 1 < vh {
                    let i = [at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)];
                    let a0: u64 = px[i[0] + 3].into();
                    if i[1..].iter().all(|&j| px[j + 3].into() == a0) {
                        // Equal weights: the weighted mean is the plain mean.
                        if a0 > 0 {
                            for k in 0..3 {
                                let sum: u64 = i.iter().map(|&j| px[j + k].into()).sum();
                                out[o + k] = cast((sum + 2) / 4);
                            }
                            out[o + 3] = px[i[0] + 3];
                        }
                        continue;
                    }
                }
                let (mut c, mut a) = ([0u64; 3], 0u64);
                for (sx, sy) in [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)] {
                    if sx >= vw || sy >= vh {
                        continue;
                    }
                    let i = at(sx, sy);
                    let pa: u64 = px[i + 3].into();
                    for k in 0..3 {
                        c[k] += px[i + k].into() * pa;
                    }
                    a += pa;
                }
                if a == 0 {
                    continue;
                }
                for k in 0..3 {
                    out[o + k] = cast(div(2 * c[k] + a, 2 * a));
                }
                out[o + 3] = cast((a + 2) / 4);
            }
        }
    }
    out.into_boxed_slice()
}

// The mask counterpart: the mean of the 2x2 block, where pixels outside the document or under a
// missing tile count as the mask default.
fn reduce_mask<T: Copy + Into<u64>>(
    kids: [Option<&[T]>; 4],
    valid: &[(usize, usize); 4],
    default: T,
    cast: fn(u64) -> T,
) -> Box<[T]> {
    let half = TILE / 2;
    let mut out = vec![default; TILE_PIXELS];
    for (q, px) in kids.into_iter().enumerate() {
        let Some(px) = px else { continue };
        let (qx, qy) = (q & 1, q >> 1);
        let (vw, vh) = valid[q];
        for oy in 0..half {
            for ox in 0..half {
                let mut sum = 0u64;
                for (sx, sy) in [(ox * 2, oy * 2), (ox * 2 + 1, oy * 2), (ox * 2, oy * 2 + 1), (ox * 2 + 1, oy * 2 + 1)] {
                    sum += if sx < vw && sy < vh { px[sy * TILE + sx] } else { default }.into();
                }
                out[(qy * half + oy) * TILE + qx * half + ox] = cast((sum + 2) / 4);
            }
        }
    }
    out.into_boxed_slice()
}

// ---------- draw program ----------

#[derive(Clone, Copy, PartialEq, Eq)]
enum Op {
    Draw = 0,
    PushTransparent = 1,
    PushCopy = 2,
    Pop = 3,
    PopLerp = 4,
    PushShape = 5,
    DivShape = 6,
    MulShape = 7,
    SubBackdrop = 8,
    PopAddBackdrop = 9,
    PopShape = 10,
}

#[cfg(test)]
const OPS: [Op; 11] = [
    Op::Draw,
    Op::PushTransparent,
    Op::PushCopy,
    Op::Pop,
    Op::PopLerp,
    Op::PushShape,
    Op::DivShape,
    Op::MulShape,
    Op::SubBackdrop,
    Op::PopAddBackdrop,
    Op::PopShape,
];

/// One step; `src` 0 means the top of the stack (`Draw` pops it, `PushShape` reads it),
/// `mask_kind` is 0 full, 1 `mask_const`, 2 the tile `mask`.
struct Step {
    op: Op,
    src: u64,
    mask: u64,
    mask_kind: u8,
    mask_const: f32,
    scale: f32,
    mode: Blend,
    node: u32,
}

impl Step {
    fn new(op: Op) -> Step {
        Step { op, src: 0, mask: 0, mask_kind: 0, mask_const: 0.0, scale: 1.0, mode: Blend::Normal, node: 0 }
    }
}

/// The ordered stack-machine ops for one display tile plus the level tiles they reference.
/// Binary layout (docs/M1.md section 3): 32-byte header, `steps` 32-byte records, then for each
/// payload a u64 key, u32 kind (0 RGBA8, 1 mask8), u32 byte length and that many bytes.
struct Program {
    level: u32,
    tx: u32,
    ty: u32,
    ox: u32,
    oy: u32,
    vw: usize,
    vh: usize,
    steps: Vec<Step>,
    payloads: Vec<(u64, Arc<Pixels>)>,
}

fn put32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

impl Program {
    fn encode(&self, known: &[u64]) -> Vec<u8> {
        let send: Vec<&(u64, Arc<Pixels>)> = self.payloads.iter().filter(|(k, _)| !known.contains(k)).collect();
        let mut out = Vec::with_capacity(32 + self.steps.len() * 32 + send.len() * TILE_BYTES_U8);
        for v in [1, self.level, self.ox, self.oy, self.vw as u32, self.vh as u32, self.steps.len() as u32, send.len() as u32] {
            put32(&mut out, v);
        }
        for s in &self.steps {
            out.extend_from_slice(&[s.op as u8, s.mask_kind, s.mode.index(), 0]);
            put32(&mut out, s.node);
            out.extend_from_slice(&s.scale.to_le_bytes());
            out.extend_from_slice(&s.mask_const.to_le_bytes());
            put64(&mut out, s.src);
            put64(&mut out, s.mask);
        }
        for (key, px) in send {
            let bytes = px.to_bytes();
            put64(&mut out, *key);
            put32(&mut out, u32::from(matches!(px.as_ref(), Pixels::Mask8(_) | Pixels::Mask16(_))));
            put32(&mut out, bytes.len() as u32);
            out.extend_from_slice(&bytes);
        }
        out
    }

    #[cfg(test)]
    fn decode(b: &[u8]) -> Program {
        let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let u64at = |o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
        let f32at = |o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        assert_eq!(u32at(0), 1, "program version");
        let (n_steps, n_payloads) = (u32at(24) as usize, u32at(28) as usize);
        let steps = (0..n_steps)
            .map(|i| {
                let o = 32 + i * 32;
                Step {
                    op: OPS[b[o] as usize],
                    mask_kind: b[o + 1],
                    mode: Blend::from_index(b[o + 2]).expect("a known blend mode"),
                    node: u32at(o + 4),
                    scale: f32at(o + 8),
                    mask_const: f32at(o + 12),
                    src: u64at(o + 16),
                    mask: u64at(o + 24),
                }
            })
            .collect();
        let mut o = 32 + n_steps * 32;
        let mut payloads = Vec::new();
        for _ in 0..n_payloads {
            let (key, kind, len) = (u64at(o), u32at(o + 8), u32at(o + 12) as usize);
            let px = Pixels::from_bytes(8, kind == 1, &b[o + 16..o + 16 + len]).expect("payload bytes");
            payloads.push((key, Arc::new(px)));
            o += 16 + len;
        }
        Program {
            level: u32at(4),
            tx: 0,
            ty: 0,
            ox: u32at(8),
            oy: u32at(12),
            vw: u32at(16) as usize,
            vh: u32at(20) as usize,
            steps,
            payloads,
        }
    }
}

/// Reduced display tiles, bounded by bytes. Eviction takes the lowest level first (rebuilding a
/// level-1 tile costs one reduction, a level-5 tile its whole subtree), then the least recently used.
#[derive(Default)]
struct TileCache {
    map: HashMap<u64, (Arc<Pixels>, u32, u64)>,
    bytes: usize,
    clock: u64,
}

const CACHE_BYTES: usize = 256 << 20;

impl TileCache {
    fn get(&mut self, key: u64) -> Option<Arc<Pixels>> {
        self.clock += 1;
        let clock = self.clock;
        let e = self.map.get_mut(&key)?;
        e.2 = clock;
        Some(e.0.clone())
    }

    fn insert(&mut self, key: u64, px: Arc<Pixels>, level: u32) {
        self.clock += 1;
        self.bytes += px.byte_len();
        if let Some(old) = self.map.insert(key, (px, level, self.clock)) {
            self.bytes -= old.0.byte_len();
        }
        if self.bytes <= CACHE_BYTES {
            return;
        }
        let mut order: Vec<(u32, u64, u64)> = self.map.iter().map(|(k, (_, l, u))| (*l, *u, *k)).collect();
        order.sort_unstable();
        for (_, _, k) in order {
            if self.bytes * 4 <= CACHE_BYTES * 3 {
                break;
            }
            if let Some(old) = self.map.remove(&k) {
                self.bytes -= old.0.byte_len();
            }
        }
    }
}

// A 64-bit mixer for content keys (splitmix64 finalizer).
fn mix(h: u64, v: u64) -> u64 {
    let mut z = h ^ v.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Document {
    pub fn new(width: u32, height: u32, depth: u8) -> Result<Document, String> {
        validate_dims(width, height, depth)?;
        Ok(Document {
            width,
            height,
            depth,
            nodes: vec![Node::new(1, "Background", Kind::Pixel(Tiles::default()))],
            selection: None,
            last_selection: None,
            channels: Vec::new(),
            next_id: 1,
            next_node_id: 2,
            loading: None,
            tile_cache: Arc::new(RefCell::new(TileCache::default())),
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

    // ---------- tree access ----------

    fn find_path(&self, id: u32) -> Result<Vec<usize>, String> {
        let mut path = Vec::new();
        if id != 0 && find_path_in(&self.nodes, id, &mut path) {
            Ok(path)
        } else {
            Err(format!("unknown node {id}"))
        }
    }

    pub fn node(&self, id: u32) -> Result<&Node, String> {
        let path = self.find_path(id)?;
        Ok(node_at(&self.nodes, &path))
    }

    fn node_mut(&mut self, id: u32) -> Result<&mut Node, String> {
        let path = self.find_path(id)?;
        Ok(node_at_mut(&mut self.nodes, &path))
    }

    // While a manifest is loading the tree is a skeleton whose tile slots still expect
    // `put_tile`; only `put_tile` and `finish_load` may run.
    fn check_idle(&self) -> Result<(), String> {
        if self.loading.is_some() {
            return Err("document is still loading".into());
        }
        Ok(())
    }

    fn alloc_node_id(&mut self) -> u32 {
        let id = self.next_node_id;
        self.next_node_id += 1;
        id
    }

    fn alloc_tile_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    // ---------- commands (M1.md section 4) ----------

    fn add_node(&mut self, name: &str, above: u32, group: bool) -> Result<u32, String> {
        self.check_idle()?;
        let at = if above == 0 {
            None
        } else {
            Some(self.find_path(above)?)
        };
        let id = self.alloc_node_id();
        let kind = if group { Kind::Group(Vec::new()) } else { Kind::Pixel(Tiles::default()) };
        let node = Node::new(id, name, kind);
        match at {
            None => self.nodes.push(node),
            Some(path) => {
                let (last, prefix) = path.split_last().expect("path");
                let list = list_mut(&mut self.nodes, prefix);
                list.insert(last + 1, node);
            }
        }
        Ok(id)
    }

    pub fn add_layer(&mut self, name: &str, above: u32) -> Result<u32, String> {
        self.add_node(name, above, false)
    }

    pub fn add_group(&mut self, name: &str, above: u32) -> Result<u32, String> {
        self.add_node(name, above, true)
    }

    pub fn group_nodes(&mut self, ids: &[u32]) -> Result<u32, String> {
        self.check_idle()?;
        if ids.is_empty() {
            return Err("group_nodes needs at least one node".into());
        }
        let mut seen = HashSet::new();
        let mut paths = Vec::with_capacity(ids.len());
        for &id in ids {
            if !seen.insert(id) {
                return Err(format!("node {id} listed twice"));
            }
            paths.push(self.find_path(id)?);
        }
        let prefix = paths[0][..paths[0].len() - 1].to_vec();
        if paths.iter().any(|p| p[..p.len() - 1] != prefix[..]) {
            return Err("every node must have the same parent".into());
        }
        let mut idx: Vec<usize> = paths.iter().map(|p| *p.last().expect("path")).collect();
        idx.sort_unstable();
        let pos = idx[idx.len() - 1] + 1 - idx.len();
        let gid = self.alloc_node_id();
        let list = list_mut(&mut self.nodes, &prefix);
        let mut taken: Vec<Node> = idx.iter().rev().map(|&i| list.remove(i)).collect();
        taken.reverse();
        list.insert(pos, Node::new(gid, "Group", Kind::Group(taken)));
        Ok(gid)
    }

    pub fn ungroup(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let path = self.find_path(id)?;
        let node = node_at(&self.nodes, &path);
        if !node.is_group() {
            return Err(format!("node {id} is not a group"));
        }
        let empty = match &node.kind {
            Kind::Group(ch) => ch.is_empty(),
            _ => false,
        };
        if empty && path.len() == 1 && self.nodes.len() == 1 {
            return Err("the document must keep at least one root node".into());
        }
        let (last, prefix) = path.split_last().expect("path");
        let list = list_mut(&mut self.nodes, prefix);
        let node = list.remove(*last);
        let Kind::Group(children) = node.kind else { unreachable!("checked above") };
        for (k, c) in children.into_iter().enumerate() {
            list.insert(last + k, c);
        }
        Ok(())
    }

    pub fn delete_node(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let path = self.find_path(id)?;
        if path.len() == 1 && self.nodes.len() == 1 {
            return Err("the document must keep at least one root node".into());
        }
        let (last, prefix) = path.split_last().expect("path");
        list_mut(&mut self.nodes, prefix).remove(*last);
        Ok(())
    }

    fn renumber(&mut self, node: &mut Node) {
        node.id = self.alloc_node_id();
        if let Kind::Group(children) = &mut node.kind {
            for c in children.iter_mut() {
                self.renumber(c);
            }
        }
    }

    pub fn duplicate_node(&mut self, id: u32) -> Result<u32, String> {
        self.check_idle()?;
        let path = self.find_path(id)?;
        let mut copy = node_at(&self.nodes, &path).clone();
        copy.name = format!("{} copy", copy.name);
        self.renumber(&mut copy);
        let new_id = copy.id;
        let (last, prefix) = path.split_last().expect("path");
        list_mut(&mut self.nodes, prefix).insert(last + 1, copy);
        Ok(new_id)
    }

    pub fn move_node(&mut self, id: u32, parent: u32, index: u32) -> Result<(), String> {
        self.check_idle()?;
        let src = self.find_path(id)?;
        let mut dst: Vec<usize> = if parent == 0 {
            Vec::new()
        } else {
            let p = self.find_path(parent)?;
            if !node_at(&self.nodes, &p).is_group() {
                return Err(format!("node {parent} is not a group"));
            }
            if p.len() >= src.len() && p[..src.len()] == src[..] {
                return Err("cannot move a node into itself or its own descendant".into());
            }
            p
        };
        if src.len() == 1 && self.nodes.len() == 1 && !dst.is_empty() {
            return Err("the document must keep at least one root node".into());
        }
        let (last, prefix) = src.split_last().expect("path");
        let same_list = dst[..] == prefix[..];
        let room = list_mut(&mut self.nodes, &dst).len() - usize::from(same_list);
        let index = index as usize;
        if index > room {
            return Err(format!("index {index} is out of range 0..={room}"));
        }
        // Removing from the source list shifts a destination path that walks through it.
        if dst.len() > prefix.len() && dst[..prefix.len()] == prefix[..] && dst[prefix.len()] > *last {
            dst[prefix.len()] -= 1;
        }
        let node = list_mut(&mut self.nodes, prefix).remove(*last);
        list_mut(&mut self.nodes, &dst).insert(index, node);
        Ok(())
    }

    pub fn set_props(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let p: PropsIn = serde_json::from_str(json).map_err(|e| format!("invalid props: {e}"))?;
        let blend = match &p.blend {
            Some(s) => Some(Blend::parse(s)?),
            None => None,
        };
        let opacity = match p.opacity {
            Some(v) => Some(unit(v, "opacity")?),
            None => None,
        };
        let fill = match p.fill {
            Some(v) => Some(unit(v, "fill")?),
            None => None,
        };
        let node = self.node_mut(id)?;
        let group = node.is_group();
        if blend == Some(Blend::PassThrough) && !group {
            return Err("pass through is only allowed on groups".into());
        }
        if let Some(f) = fill {
            node.fill = f;
        }
        if let Some(n) = p.name {
            node.name = n;
        }
        if let Some(v) = p.visible {
            node.visible = v;
        }
        if let Some(v) = opacity {
            node.opacity = v;
        }
        if let Some(b) = blend {
            node.blend = b;
        }
        if let Some(c) = p.clipping {
            node.clipping = c;
        }
        if let Some(l) = p.locks {
            if let Some(v) = l.transparency {
                node.locks.transparency = v;
            }
            if let Some(v) = l.pixels {
                node.locks.pixels = v;
            }
            if let Some(v) = l.position {
                node.locks.position = v;
            }
        }
        if let Some(v) = p.mask_enabled {
            let m = node.mask.as_mut().ok_or_else(|| format!("node {id} has no mask"))?;
            m.enabled = v;
        }
        Ok(())
    }

    pub fn add_mask(&mut self, id: u32, reveal: bool) -> Result<(), String> {
        self.check_idle()?;
        let max = max_value(self.depth);
        let node = self.node_mut(id)?;
        if node.mask.is_some() {
            return Err(format!("node {id} already has a mask"));
        }
        node.mask = Some(Mask {
            enabled: true,
            default: if reveal { max } else { 0 },
            tiles: Tiles::default(),
        });
        Ok(())
    }

    pub fn delete_mask(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let node = self.node_mut(id)?;
        if node.mask.take().is_none() {
            return Err(format!("node {id} has no mask"));
        }
        Ok(())
    }

    fn check_pixel_edit(&self, id: u32) -> Result<(), String> {
        let node = self.node(id)?;
        if node.is_group() {
            return Err(format!("node {id} is a group and has no pixels"));
        }
        if node.locks.pixels {
            return Err("layer pixels are locked".into());
        }
        Ok(())
    }

    // Canvas tiles plus the layer's tiles outside the canvas: the whole layer of an unselected edit.
    fn whole_layer(&self, tiles: &Tiles) -> Vec<(i32, i32)> {
        let mut out: Vec<(i32, i32)> = tiles.coords().into_iter().filter(|(tx, ty)| !self.on_canvas(*tx, *ty)).collect();
        for ty in 0..self.tiles_y() as i32 {
            for tx in 0..self.tiles_x() as i32 {
                out.push((tx, ty));
            }
        }
        out
    }

    fn on_canvas(&self, tx: i32, ty: i32) -> bool {
        tx >= 0 && ty >= 0 && (tx as u32) < self.tiles_x() && (ty as u32) < self.tiles_y()
    }

    /// The canvas tiles the selection covers at all, or None when nothing is selected and an
    /// edit acts on the whole layer.
    fn selected_tiles(&self) -> Option<Vec<(i32, i32)>> {
        let sel = self.selection.as_ref()?;
        if sel.default > 0 {
            return Some(
                (0..self.tiles_y() as i32)
                    .flat_map(|ty| (0..self.tiles_x() as i32).map(move |tx| (tx, ty)))
                    .collect(),
            );
        }
        Some(sel.tiles.coords().into_iter().filter(|(tx, ty)| self.on_canvas(*tx, *ty)).collect())
    }

    // The selection coverage of one canvas tile; only called for tiles `selected_tiles` listed.
    fn coverage(&self, tx: i32, ty: i32) -> Cov {
        let sel = self.selection.as_ref().expect("a selection exists");
        match sel.tiles.get(tx, ty) {
            Some(t) => Cov::Tile(t.px.clone()),
            None => Cov::Uniform(sel.default as f32 / max_value(self.depth) as f32),
        }
    }

    // Rewrites the listed tiles of a pixel layer, `f` mapping straight old RGBA to straight new
    // RGBA, weighted by the selection coverage (premultiplied lerp, or straight when alpha is kept).
    fn edit_pixel_tiles(
        &mut self,
        id: u32,
        area: &[(i32, i32)],
        keep_alpha: bool,
        f: impl Fn([f32; 4]) -> [f32; 4],
    ) -> Result<(), String> {
        let depth = self.depth;
        let selected = self.selection.is_some();
        let mut fresh: Vec<((i32, i32), Option<Pixels>)> = Vec::with_capacity(area.len());
        for &(tx, ty) in area {
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let old = self.node(id)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
            let px = edit_rgba(depth, old.as_deref(), &cov, keep_alpha, &f);
            fresh.push(((tx, ty), px));
        }
        let mut out = Vec::with_capacity(fresh.len());
        for (at, px) in fresh {
            out.push((at, px.map(|px| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in out {
            tiles.put(tx, ty, t);
        }
        Ok(())
    }

    // The same for a single-channel mask; `f` maps the old value in 0..1 to the new one.
    fn edit_mask_tiles(
        &mut self,
        id: u32,
        area: &[(i32, i32)],
        f: impl Fn(f32) -> f32,
    ) -> Result<(), String> {
        let depth = self.depth;
        let selected = self.selection.is_some();
        let default = self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?.default;
        let mut fresh: Vec<((i32, i32), Option<Pixels>)> = Vec::with_capacity(area.len());
        for &(tx, ty) in area {
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let old = self.node(id)?.mask.as_ref().expect("checked").tiles.get(tx, ty).map(|t| t.px.clone());
            fresh.push(((tx, ty), edit_mask(depth, old.as_deref(), default, &cov, &f)));
        }
        let mut out = Vec::with_capacity(fresh.len());
        for (at, px) in fresh {
            out.push((at, px.map(|px| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let m = self.node_mut(id)?.mask.as_mut().expect("checked");
        for ((tx, ty), t) in out {
            m.tiles.put(tx, ty, t);
        }
        Ok(())
    }

    pub fn fill(&mut self, id: u32, target: Target, r: u8, g: u8, b: u8, a: u8) -> Result<(), String> {
        self.check_idle()?;
        let depth = self.depth;
        let max = max_value(depth) as f32;
        // Quick mask (docs/M2.md section 3): the selection itself is the mask being filled, so
        // there is no further selection to clip it by.
        if target == Target::Selection {
            let value = if depth == 8 { r as u32 } else { r as u32 * 257 };
            self.selection = Some(SelMask { default: value, tiles: Tiles::default() });
            return Ok(());
        }
        if target == Target::Mask {
            let value = if depth == 8 { r as u32 } else { r as u32 * 257 };
            self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?;
            let area = match self.selected_tiles() {
                Some(a) => a,
                None => {
                    let m = self.node_mut(id)?.mask.as_mut().expect("checked");
                    m.default = value;
                    m.tiles.clear();
                    return Ok(());
                }
            };
            let v = value as f32 / max;
            return self.edit_mask_tiles(id, &area, move |_| v);
        }
        self.check_pixel_edit(id)?;
        let keep_alpha = self.node(id)?.locks.transparency;
        let area = match self.selected_tiles() {
            Some(a) => a,
            None if keep_alpha => {
                let fresh = self.remap_tiles(id, Target::Pixels, |px| px.recolored(r, g, b))?;
                let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
                for ((tx, ty), t) in fresh {
                    tiles.put(tx, ty, Some(t));
                }
                return Ok(());
            }
            None => {
                let area = self.whole_layer(self.node(id)?.pixel_tiles()?);
                let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
                tiles.clear();
                if a == 0 {
                    return Ok(());
                }
                let mut rgba = vec![0u8; TILE_BYTES_U8];
                for px in rgba.chunks_exact_mut(4) {
                    px.copy_from_slice(&[r, g, b, a]);
                }
                let px = Arc::new(Pixels::from_rgba8(depth, &rgba));
                let tile_id = self.alloc_tile_id();
                let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
                for (tx, ty) in area {
                    tiles.put(tx, ty, Some(Tile { id: tile_id, px: px.clone() }));
                }
                return Ok(());
            }
        };
        let new = [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, a as f32 / 255.0];
        self.edit_pixel_tiles(id, &area, keep_alpha, move |_| new)
    }

    /// Pixels become transparent, a mask becomes 0; the selection limits the effect.
    pub fn clear(&mut self, id: u32, target: Target) -> Result<(), String> {
        self.check_idle()?;
        if target == Target::Mask || target == Target::Selection {
            return self.fill(id, target, 0, 0, 0, 0);
        }
        self.check_pixel_edit(id)?;
        let area = match self.selected_tiles() {
            Some(a) => a,
            None => {
                self.node_mut(id)?.pixel_tiles_mut()?.clear();
                return Ok(());
            }
        };
        self.edit_pixel_tiles(id, &area, false, |_| [0.0; 4])
    }

    // Copy on write: every source tile id maps to one new tile, so shared tiles stay shared.
    fn remap_tiles(
        &mut self,
        id: u32,
        target: Target,
        f: impl Fn(&Pixels) -> Pixels,
    ) -> Result<Vec<((i32, i32), Tile)>, String> {
        let node = self.node(id)?;
        let tiles = match target {
            Target::Pixels => node.pixel_tiles()?,
            Target::Mask => &node.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?.tiles,
            Target::Selection => unreachable!("callers never remap the selection through a node"),
        };
        let src: Vec<((i32, i32), u64, Arc<Pixels>)> = tiles
            .coords()
            .into_iter()
            .map(|at| {
                let t = tiles.get(at.0, at.1).expect("a listed tile");
                (at, t.id, t.px.clone())
            })
            .collect();
        let mut memo: HashMap<u64, Tile> = HashMap::new();
        let mut out = Vec::with_capacity(src.len());
        for (at, tid, px) in src {
            let tile = match memo.get(&tid) {
                Some(t) => t.clone(),
                None => {
                    let t = Tile { id: self.alloc_tile_id(), px: Arc::new(f(&px)) };
                    memo.insert(tid, t.clone());
                    t
                }
            };
            out.push((at, tile));
        }
        Ok(out)
    }

    pub fn invert(&mut self, id: u32, target: Target) -> Result<(), String> {
        self.check_idle()?;
        if target == Target::Selection {
            return self.invert_selection();
        }
        if target == Target::Pixels {
            self.check_pixel_edit(id)?;
        } else if self.node(id)?.mask.is_none() {
            return Err(format!("node {id} has no mask"));
        }
        let max = max_value(self.depth);
        if let Some(area) = self.selected_tiles() {
            return match target {
                // Only the selected pixels flip, so the mask default stays as it is.
                Target::Mask => self.edit_mask_tiles(id, &area, |v| 1.0 - v),
                Target::Pixels => {
                    let tiles = self.node(id)?.pixel_tiles()?;
                    let area: Vec<(i32, i32)> =
                        area.into_iter().filter(|(tx, ty)| tiles.get(*tx, *ty).is_some()).collect();
                    self.edit_pixel_tiles(id, &area, true, |[r, g, b, a]| [1.0 - r, 1.0 - g, 1.0 - b, a])
                }
                Target::Selection => unreachable!("handled above"),
            };
        }
        let fresh = self.remap_tiles(id, target, |px| px.inverted())?;
        let node = self.node_mut(id)?;
        match target {
            Target::Pixels => {
                let tiles = node.pixel_tiles_mut()?;
                for ((tx, ty), t) in fresh {
                    tiles.put(tx, ty, Some(t));
                }
            }
            Target::Mask => {
                let m = node.mask.as_mut().expect("checked");
                m.default = max - m.default;
                for ((tx, ty), t) in fresh {
                    m.tiles.put(tx, ty, Some(t));
                }
            }
            Target::Selection => unreachable!("handled above"),
        }
        Ok(())
    }

    fn check_tile_coord(&self, tx: u32, ty: u32) -> Result<(), String> {
        if tx >= self.tiles_x() || ty >= self.tiles_y() {
            return Err("tile coordinate out of range".into());
        }
        Ok(())
    }

    pub fn set_tile_rgba8(&mut self, id: u32, tx: u32, ty: u32, data: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        self.check_tile_coord(tx, ty)?;
        if data.len() != TILE_BYTES_U8 {
            return Err(format!("expected {TILE_BYTES_U8} bytes, got {}", data.len()));
        }
        self.node(id)?.pixel_tiles()?;
        let transparent = data.chunks_exact(4).all(|px| px[3] == 0);
        let tile_id = if transparent { 0 } else { self.alloc_tile_id() };
        let depth = self.depth;
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        let tile = (!transparent).then(|| Tile { id: tile_id, px: Arc::new(Pixels::from_rgba8(depth, data)) });
        tiles.put(tx as i32, ty as i32, tile);
        Ok(())
    }

    pub fn set_mask_tile8(&mut self, id: u32, tx: u32, ty: u32, data: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        self.check_tile_coord(tx, ty)?;
        if data.len() != MASK_BYTES_U8 {
            return Err(format!("expected {MASK_BYTES_U8} bytes, got {}", data.len()));
        }
        let depth = self.depth;
        let default8 = {
            let m = self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?;
            if depth == 8 {
                m.default
            } else {
                m.default / 257
            }
        };
        let uniform = data.iter().all(|v| *v as u32 == default8);
        let tile_id = if uniform { 0 } else { self.alloc_tile_id() };
        let m = self.node_mut(id)?.mask.as_mut().expect("checked");
        let tile = (!uniform).then(|| Tile { id: tile_id, px: Arc::new(Pixels::from_mask8(depth, data)) });
        m.tiles.put(tx as i32, ty as i32, tile);
        Ok(())
    }

    // ---------- selection (M2.md section 3) ----------

    fn max(&self) -> f32 {
        max_value(self.depth) as f32
    }

    // The selection value in 0..1 at a document pixel; outside the canvas it is 0.
    fn sel_at(&self, sel: &SelMask, x: i32, y: i32) -> f32 {
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return 0.0;
        }
        let (tx, ty) = (x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
        let p = (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize;
        match sel.tiles.get(tx, ty) {
            Some(t) => t.px.mask_f32(p),
            None => sel.default as f32 / self.max(),
        }
    }

    // Canvas tiles overlapping a document pixel rect (upper bounds exclusive).
    fn tiles_of_rect(&self, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<(i32, i32)> {
        if x1 <= x0 || y1 <= y0 {
            return Vec::new();
        }
        let t = |v: i32| v.div_euclid(TILE as i32);
        let (tx0, ty0) = (t(x0).max(0), t(y0).max(0));
        let (tx1, ty1) = (t(x1 - 1).min(self.tiles_x() as i32 - 1), t(y1 - 1).min(self.tiles_y() as i32 - 1));
        let mut out = Vec::new();
        for ty in ty0..=ty1 {
            for tx in tx0..=tx1 {
                out.push((tx, ty));
            }
        }
        out
    }

    fn set_sel_tile(&mut self, sel: &mut SelMask, tx: i32, ty: i32, values: &[f32]) {
        let px = Pixels::mask_from_norm(self.depth, values);
        let uniform = match &px {
            Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == sel.default),
            Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == sel.default),
            _ => false,
        };
        let tile = (!uniform).then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
        sel.tiles.put(tx, ty, tile);
    }

    /// Rasterizes a shape into the selection with one of the four boolean modes. The shape is
    /// clipped to the canvas; an empty result stays an (empty) selection, not "no selection".
    pub fn select_shape(&mut self, shape: &dyn Shape, mode: Mode) -> Result<(), String> {
        self.check_idle()?;
        let (bx0, by0, bx1, by1) = shape.bounds();
        if ![bx0, by0, bx1, by1].iter().all(|v| v.is_finite()) {
            return Err("shape bounds must be finite".into());
        }
        let clamp = |v: f64, hi: u32| v.clamp(0.0, hi as f64) as i32;
        let (x0, y0) = (clamp(bx0.floor(), self.width), clamp(by0.floor(), self.height));
        let (x1, y1) = (clamp(bx1.ceil(), self.width), clamp(by1.ceil(), self.height));
        let old = self.selection.take().unwrap_or_default();
        let mut sel = if mode.keeps_untouched() {
            old.clone()
        } else {
            SelMask { default: 0, tiles: Tiles::default() }
        };
        let mut row = vec![0f32; TILE];
        let mut values = vec![0f32; TILE_PIXELS];
        for (tx, ty) in self.tiles_of_rect(x0, y0, x1, y1) {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for y in 0..TILE as i32 {
                let inside = oy + y >= y0 && oy + y < y1;
                if inside {
                    shape.row(oy + y, ox, &mut row);
                } else {
                    row.fill(0.0);
                }
                for x in 0..TILE as i32 {
                    let c = if inside && ox + x >= x0 && ox + x < x1 { row[x as usize] } else { 0.0 };
                    values[(y * TILE as i32 + x) as usize] =
                        mode.combine(self.sel_at(&old, ox + x, oy + y), c.clamp(0.0, 1.0)).clamp(0.0, 1.0);
                }
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    pub fn select_rect(&mut self, x: f64, y: f64, w: f64, h: f64, mode: Mode) -> Result<(), String> {
        self.select_shape(&Rect::new(x, y, w, h), mode)
    }

    pub fn select_ellipse(&mut self, x: f64, y: f64, w: f64, h: f64, aa: bool, mode: Mode) -> Result<(), String> {
        self.select_shape(&Ellipse::new(x, y, w, h, aa), mode)
    }

    pub fn select_polygon(&mut self, points: &[f64], aa: bool, mode: Mode) -> Result<(), String> {
        self.select_shape(&Polygon::new(points, aa)?, mode)
    }

    pub fn select_all(&mut self) -> Result<(), String> {
        self.check_idle()?;
        self.selection = Some(SelMask { default: max_value(self.depth), tiles: Tiles::default() });
        Ok(())
    }

    /// Drops the selection and keeps it for `reselect`.
    pub fn deselect(&mut self) -> Result<(), String> {
        self.check_idle()?;
        if let Some(sel) = self.selection.take() {
            self.last_selection = Some(sel);
        }
        Ok(())
    }

    pub fn reselect(&mut self) -> Result<(), String> {
        self.check_idle()?;
        let last = self.last_selection.clone().ok_or("there is no selection to restore")?;
        self.selection = Some(last);
        Ok(())
    }

    /// Inverts the selection; nothing selected inverts to everything.
    pub fn invert_selection(&mut self) -> Result<(), String> {
        self.check_idle()?;
        let old = self.selection.take().unwrap_or_default();
        let mut sel = SelMask { default: max_value(self.depth) - old.default, tiles: Tiles::default() };
        for (tx, ty) in old.tiles.coords() {
            let px = old.tiles.get(tx, ty).expect("a listed tile").px.inverted();
            let uniform = match &px {
                Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == sel.default),
                Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == sel.default),
                _ => false,
            };
            let tile = (!uniform).then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
            sel.tiles.put(tx, ty, tile);
        }
        self.selection = Some(sel);
        Ok(())
    }

    /// Gaussian blur of the selection mask (`selection::gaussian_kernel`); outside the canvas
    /// counts as 0, so an edge of the canvas fades like any other edge.
    pub fn feather_selection(&mut self, radius: f64) -> Result<(), String> {
        self.check_idle()?;
        if !radius.is_finite() || radius <= 0.0 {
            return Err("feather radius must be greater than 0".into());
        }
        let old = self.selection.clone().ok_or("nothing is selected")?;
        let kernel = gaussian_kernel(radius);
        let k = (kernel.len() / 2) as i32;
        let (w, h) = (self.width as i32, self.height as i32);
        // Only tiles within the blur reach of a stored tile change, unless the default is not 0,
        // which the canvas edge then fades.
        let mut area = Vec::new();
        if old.default > 0 {
            area = self.tiles_of_rect(0, 0, w, h);
        } else {
            let mut bb: Option<(i32, i32, i32, i32)> = None;
            for (tx, ty) in old.tiles.coords() {
                let (x0, y0) = (tx * TILE as i32, ty * TILE as i32);
                let b = bb.unwrap_or((x0, y0, x0 + TILE as i32, y0 + TILE as i32));
                bb = Some((b.0.min(x0), b.1.min(y0), b.2.max(x0 + TILE as i32), b.3.max(y0 + TILE as i32)));
            }
            if let Some((x0, y0, x1, y1)) = bb {
                area = self.tiles_of_rect(x0 - k, y0 - k, x1 + k, y1 + k);
            }
        }
        let mut sel = old.clone();
        let mut values = vec![0f32; TILE_PIXELS];
        // ponytail: one horizontal pass per output tile; a shared per-tile-row band would cut the
        // repeated work if a large radius ever shows up in a profile.
        let mut band = vec![0f32; (TILE + 2 * k as usize) * TILE];
        for (tx, ty) in area {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let bw = TILE;
            for (i, row) in band.chunks_exact_mut(bw).enumerate() {
                let y = oy - k + i as i32;
                for (j, v) in row.iter_mut().enumerate() {
                    let x = ox + j as i32;
                    *v = (-k..=k).map(|d| self.sel_at(&old, x + d, y) * kernel[(d + k) as usize]).sum();
                }
            }
            for y in 0..TILE as i32 {
                for x in 0..TILE as i32 {
                    let v: f32 = (-k..=k)
                        .map(|d| {
                            let sy = oy + y + d;
                            if sy < 0 || sy >= h || ox + x >= w {
                                0.0
                            } else {
                                band[((y + d + k) as usize) * bw + x as usize] * kernel[(d + k) as usize]
                            }
                        })
                        .sum();
                    values[(y * TILE as i32 + x) as usize] = v.clamp(0.0, 1.0);
                }
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    // ---------- flood fill family (docs/M2.md section 3 magic wand, section 4 paint bucket) ----------

    // The document's RGBA8 buffer for flood fill / paint bucket sampling: the flattened
    // composite when `sample_all`, or one layer's straight pixels (offset aware; outside its
    // tiles is transparent) otherwise. Depths above 8 bit are normalized down to 8-bit units so
    // the flood fill's tolerance stays in one scale.
    fn sample_rgba8(&self, sample_all: bool, layer_id: u32) -> Result<Vec<u8>, String> {
        let (w, h) = (self.width as i32, self.height as i32);
        let mut out = vec![0u8; (self.width * self.height * 4) as usize];
        if sample_all {
            for ty in 0..self.tiles_y() {
                for tx in 0..self.tiles_x() {
                    let tile = self.flatten_tile_rgba8(tx, ty)?;
                    let (ox, oy) = (tx as i32 * TILE as i32, ty as i32 * TILE as i32);
                    for y in 0..TILE as i32 {
                        if oy + y >= h {
                            break;
                        }
                        for x in 0..TILE as i32 {
                            if ox + x >= w {
                                break;
                            }
                            let so = ((y * TILE as i32 + x) * 4) as usize;
                            let dst = (((oy + y) * w + ox + x) * 4) as usize;
                            out[dst..dst + 4].copy_from_slice(&tile[so..so + 4]);
                        }
                    }
                }
            }
            return Ok(out);
        }
        let node = self.node(layer_id)?;
        if node.is_group() {
            return Err(format!("node {layer_id} is a group and has no pixels"));
        }
        let tiles = node.pixel_tiles()?;
        for y in 0..h {
            for x in 0..w {
                let (tx, ty) = (x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
                let p = (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize;
                let rgba = tiles.get(tx, ty).map_or([0.0; 4], |t| t.px.rgba_f32(p));
                let o = ((y * w + x) * 4) as usize;
                for c in 0..4 {
                    out[o + c] = (rgba[c] * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        Ok(out)
    }

    /// Magic wand (docs/M2.md section 3): flood fill from (x, y) plugged into the shared
    /// selection combine path.
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
        mode: Mode,
    ) -> Result<(), String> {
        self.check_idle()?;
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return Err("magic wand seed must be inside the canvas".into());
        }
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = region::flood(&src, self.width, self.height, (x as u32, y as u32), tolerance, contiguous, antialias);
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), mode)
    }

    /// Color Range (docs/M2.md section 3), plugged into the shared selection combine path.
    #[allow(clippy::too_many_arguments)]
    pub fn color_range(
        &mut self,
        sample_all: bool,
        layer_id: u32,
        preset: &str,
        samples: &[[u8; 3]],
        fuzziness: u8,
        range: u8,
        center: &[(f64, f64)],
        localized: bool,
        invert: bool,
        mode: Mode,
    ) -> Result<(), String> {
        self.check_idle()?;
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = region::color_range(&src, self.width, self.height, preset, samples, fuzziness, range, center, localized, invert)?;
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), mode)
    }

    /// Grayscale preview of `color_range`'s coverage for the dialog, without touching the
    /// selection; `level` downsamples by `2^level` (nearest-neighbour) so a big canvas stays
    /// cheap to redraw live.
    #[allow(clippy::too_many_arguments)]
    pub fn color_range_preview(
        &self,
        level: u32,
        sample_all: bool,
        layer_id: u32,
        preset: &str,
        samples: &[[u8; 3]],
        fuzziness: u8,
        range: u8,
        center: &[(f64, f64)],
        localized: bool,
        invert: bool,
    ) -> Result<Vec<u8>, String> {
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = region::color_range(&src, self.width, self.height, preset, samples, fuzziness, range, center, localized, invert)?;
        let step = 1usize << level.min(8);
        let (w, h) = (self.width as usize, self.height as usize);
        let (pw, ph) = (w.div_ceil(step), h.div_ceil(step));
        let mut out = vec![0u8; pw * ph];
        for py in 0..ph {
            for px in 0..pw {
                let (x, y) = ((px * step).min(w - 1), (py * step).min(h - 1));
                out[py * pw + px] = (cov[y * w + x] * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
        Ok(out)
    }

    // Whether each canvas pixel is >= 0.5 selected, doc-sized; used as the seed set of grow/similar.
    fn selection_seed_mask(&self) -> Result<Vec<bool>, String> {
        let sel = self.selection.as_ref().ok_or("nothing is selected")?;
        let (w, h) = (self.width as i32, self.height as i32);
        let mut out = vec![false; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                out[(y * w + x) as usize] = self.sel_at(sel, x, y) >= 0.5;
            }
        }
        Ok(out)
    }

    fn grow_or_similar(&mut self, tolerance: u8, sample_all: bool, layer_id: u32, contiguous: bool) -> Result<(), String> {
        self.check_idle()?;
        let seeds = self.selection_seed_mask()?;
        if !seeds.iter().any(|&s| s) {
            return Err("nothing is selected".into());
        }
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = region::grow_similar(&src, self.width, self.height, &seeds, tolerance, contiguous);
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), Mode::Add)
    }

    /// Grows the selection with a contiguous flood from the seed colors' per-channel range.
    pub fn grow(&mut self, tolerance: u8, sample_all: bool, layer_id: u32) -> Result<(), String> {
        self.grow_or_similar(tolerance, sample_all, layer_id, true)
    }

    /// Adds every pixel within the seed colors' per-channel range, regardless of connectivity.
    pub fn similar(&mut self, tolerance: u8, sample_all: bool, layer_id: u32) -> Result<(), String> {
        self.grow_or_similar(tolerance, sample_all, layer_id, false)
    }

    /// Quick selection (docs/M2.md section 3): `points` are the stroke's flat document x, y
    /// samples, `radius` the brush radius in document pixels.
    #[allow(clippy::too_many_arguments)]
    pub fn quick_select(
        &mut self,
        points: &[f64],
        radius: f64,
        sample_all: bool,
        layer_id: u32,
        mode: Mode,
        auto_enhance: bool,
    ) -> Result<(), String> {
        self.check_idle()?;
        if points.len() % 2 != 0 {
            return Err("quick selection points need an x and a y each".into());
        }
        if points.iter().any(|v| !v.is_finite()) {
            return Err("quick selection points must be finite".into());
        }
        let stroke: Vec<(f64, f64)> = points.chunks_exact(2).map(|p| (p[0], p[1])).collect();
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = livewire::quick_select(&src, self.width, self.height, &stroke, radius, auto_enhance)?;
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), mode)
    }

    /// Quick mask (docs/M2.md section 3): paints into the selection itself, as if it were a
    /// layer mask, through `blend::paint_mask_value`; `value` (the fill color's red channel) is
    /// the painted mask value. There is no outer selection to clip this by.
    fn paint_coverage_selection(
        &mut self,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        coverage: &[f32],
        value: u8,
        mode: PaintMode,
        opacity: f32,
    ) -> Result<(), String> {
        let opacity = opacity.clamp(0.0, 1.0);
        let target = value as f32 / 255.0;
        let mut sel = self.selection.take().unwrap_or_default();
        for (tx, ty) in self.tiles_of_rect(x, y, x + w as i32, y + h as i32) {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let cell = |px_: i32, py: i32| -> f32 {
                let (dx, dy) = (ox + px_ - x, oy + py - y);
                if dx < 0 || dx >= w as i32 || dy < 0 || dy >= h as i32 {
                    0.0
                } else {
                    coverage[(dy * w as i32 + dx) as usize]
                }
            };
            let touches = (0..TILE as i32).any(|py| (0..TILE as i32).any(|px_| cell(px_, py) > 0.0));
            if !touches {
                continue;
            }
            let mut values = vec![0f32; TILE_PIXELS];
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let old = self.sel_at(&sel, ox + px_, oy + py);
                    let c = (cell(px_, py) * opacity).clamp(0.0, 1.0);
                    values[p] = paint_mask_value(mode, old, target, c);
                }
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    /// One frame of an open stroke: places the dabs of `samples` (flat x, y, pressure triples)
    /// into the stroke's coverage buffer, then recomputes every tile under those dabs from the
    /// tile as it was at stroke start. Returns the changed document rect as [x, y, w, h].
    fn stroke_apply(&mut self, st: &mut Stroke, samples: &[f64]) -> Result<Vec<i32>, String> {
        self.check_idle()?;
        if samples.len() % 3 != 0 {
            return Err("stroke samples need an x, a y and a pressure each".into());
        }
        if samples.iter().any(|v| !v.is_finite()) {
            return Err("stroke samples must be finite".into());
        }
        let pts: Vec<Sample> = samples
            .chunks_exact(3)
            .map(|c| Sample { x: c[0], y: c[1], p: (c[2] as f32).clamp(0.0, 1.0) })
            .collect();
        let dabs = st.spacer.feed(&pts, st.step, st.airbrush);
        if dabs.is_empty() {
            return Ok(Vec::new());
        }
        // Per touched tile the local pixel box the new dabs cover; only those pixels are repainted.
        let mut dirty: Vec<((i32, i32), [i32; 4])> = Vec::new();
        let mut rect: Option<[i32; 4]> = None;
        for d in &dabs {
            let dia = if st.pressure_size { (st.size * d.p).max(1.0) } else { st.size };
            let r = dia / 2.0;
            let tip = Tip::new(r, st.hardness, st.angle, st.roundness, st.aliased, st.shape, st.wet_edges);
            let cap = st.opacity * if st.pressure_opacity { d.p } else { 1.0 };
            let (rf, w, h) = (r as f64 + 1.0, self.width as i32, self.height as i32);
            let x0 = ((d.x - rf).floor() as i32).clamp(0, w);
            let y0 = ((d.y - rf).floor() as i32).clamp(0, h);
            let x1 = ((d.x + rf).ceil() as i32 + 1).clamp(0, w);
            let y1 = ((d.y + rf).ceil() as i32 + 1).clamp(0, h);
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            rect = Some(match rect {
                None => [x0, y0, x1, y1],
                Some(b) => [b[0].min(x0), b[1].min(y0), b[2].max(x1), b[3].max(y1)],
            });
            for (tx, ty) in self.tiles_of_rect(x0, y0, x1, y1) {
                let key = (tx, ty);
                if !st.tiles.contains_key(&key) {
                    let orig = match st.target {
                        Target::Pixels => self.node(st.layer)?.pixel_tiles()?.get(tx, ty).cloned(),
                        _ => self.selection.as_ref().and_then(|s| s.tiles.get(tx, ty)).cloned(),
                    };
                    st.tiles.insert(key, StrokeTile { s: vec![0f32; TILE_PIXELS], orig });
                }
                let t = st.tiles.get_mut(&key).expect("the tile is present");
                let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
                let (lx0, ly0) = ((x0 - ox).max(0), (y0 - oy).max(0));
                let (lx1, ly1) = ((x1 - ox).min(TILE as i32), (y1 - oy).min(TILE as i32));
                for py in ly0..ly1 {
                    let dy = ((oy + py) as f64 + 0.5 - d.y) as f32;
                    for px in lx0..lx1 {
                        let dx = ((ox + px) as f64 + 0.5 - d.x) as f32;
                        let cov = tip.cov(dx, dy);
                        if cov <= 0.0 {
                            continue;
                        }
                        let p = (py * TILE as i32 + px) as usize;
                        t.s[p] = stroke::accumulate(t.s[p], cap, st.flow, cov, st.wet_edges);
                    }
                }
                match dirty.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, b)) => {
                        *b = [b[0].min(lx0), b[1].min(ly0), b[2].max(lx1), b[3].max(ly1)];
                    }
                    None => dirty.push((key, [lx0, ly0, lx1, ly1])),
                }
            }
        }
        let Some(rect) = rect else {
            return Ok(Vec::new());
        };
        for (key, b) in &dirty {
            self.stroke_flush_tile(st, *key, *b)?;
        }
        Ok(vec![rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]])
    }

    // Recomputes the box `b` of one tile from the stroke-start tile plus the stroke coverage.
    fn stroke_flush_tile(&mut self, st: &Stroke, (tx, ty): (i32, i32), b: [i32; 4]) -> Result<(), String> {
        let t = st.tiles.get(&(tx, ty)).expect("the tile was accumulated");
        if st.target == Target::Selection {
            let mut sel = self.selection.take().unwrap_or_default();
            let def = sel.default as f32 / self.max();
            let mut values = vec![0f32; TILE_PIXELS];
            for (p, v) in values.iter_mut().enumerate() {
                let old = t.orig.as_ref().map_or(def, |o| o.px.mask_f32(p));
                *v = paint_mask_value(st.mode, old, st.value, t.s[p].clamp(0.0, 1.0));
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
            self.selection = Some(sel);
            return Ok(());
        }
        let cov = if self.selection.is_some() { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
        let cur = self.node(st.layer)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
        let hist = st.hist.as_ref().map(|h| h.get(tx, ty).map(|t| t.px.clone()));
        let mut data = cur.as_deref().cloned().unwrap_or_else(|| Pixels::transparent(self.depth));
        for py in b[1]..b[3] {
            for px in b[0]..b[2] {
                let p = (py * TILE as i32 + px) as usize;
                let c = (t.s[p] * cov.at(p)).clamp(0.0, 1.0);
                let old = t.orig.as_ref().map_or([0.0; 4], |o| o.px.rgba_f32(p));
                let new = match &hist {
                    // Erase to history: move towards the snapshot's pixel in straight RGBA.
                    Some(h) => {
                        let dst = h.as_deref().map_or([0.0; 4], |px| px.rgba_f32(p));
                        let mut out = [0f32; 4];
                        for i in 0..4 {
                            out[i] = old[i] + (dst[i] - old[i]) * c;
                        }
                        if st.keep_alpha {
                            out[3] = old[3];
                        }
                        out
                    }
                    None => paint_pixel(st.mode, old, st.rgb, c, st.keep_alpha),
                };
                data.set_rgba_f32(p, new);
            }
        }
        let tile = data.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(data) });
        self.node_mut(st.layer)?.pixel_tiles_mut()?.put(tx, ty, tile);
        Ok(())
    }

    /// Paints a solid color into the layer at document rect (x, y, w, h) through `coverage`
    /// (0..1, `coverage.len() == w * h`) times `opacity` times the selection, using the blend
    /// math in `blend::paint_pixel`. Honors the transparency lock and errors on the pixel lock;
    /// only tiles the rect and a nonzero coverage cell overlap are rewritten.
    #[allow(clippy::too_many_arguments)]
    pub fn paint_coverage(
        &mut self,
        id: u32,
        target: Target,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        coverage: &[f32],
        rgba: [u8; 4],
        mode: PaintMode,
        opacity: f32,
    ) -> Result<(), String> {
        self.check_idle()?;
        if coverage.len() != (w * h) as usize {
            return Err("paint coverage buffer must match w*h".into());
        }
        if target == Target::Selection {
            return self.paint_coverage_selection(x, y, w, h, coverage, rgba[0], mode, opacity);
        }
        if target != Target::Pixels {
            return Err("paint_coverage only supports the pixels or selection target".into());
        }
        self.check_pixel_edit(id)?;
        let keep_alpha = self.node(id)?.locks.transparency;
        let depth = self.depth;
        let rgb = [rgba[0] as f32 / 255.0, rgba[1] as f32 / 255.0, rgba[2] as f32 / 255.0];
        let opacity = opacity.clamp(0.0, 1.0);
        let selected = self.selection.is_some();
        let mut out: Vec<((i32, i32), Option<Pixels>)> = Vec::new();
        for (tx, ty) in self.tiles_of_rect(x, y, x + w as i32, y + h as i32) {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let cell = |px_: i32, py: i32| -> f32 {
                let (dx, dy) = (ox + px_ - x, oy + py - y);
                if dx < 0 || dx >= w as i32 || dy < 0 || dy >= h as i32 {
                    0.0
                } else {
                    coverage[(dy * w as i32 + dx) as usize]
                }
            };
            let touches = (0..TILE as i32).any(|py| (0..TILE as i32).any(|px_| cell(px_, py) > 0.0));
            if !touches {
                continue;
            }
            let old_tile = self.node(id)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let mut fresh = vec![0f32; TILE_PIXELS * 4];
            let mut any = false;
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let old = old_tile.as_deref().map_or([0.0; 4], |px| px.rgba_f32(p));
                    let c = (cell(px_, py) * opacity * cov.at(p)).clamp(0.0, 1.0);
                    let new = paint_pixel(mode, old, rgb, c, keep_alpha);
                    any |= new[3] > 0.0;
                    fresh[p * 4..p * 4 + 4].copy_from_slice(&new);
                }
            }
            out.push(((tx, ty), any.then(|| Pixels::from_straight(depth, &fresh))));
        }
        let mut tiles_out = Vec::with_capacity(out.len());
        for (at, px) in out {
            tiles_out.push((at, px.map(|px| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in tiles_out {
            tiles.put(tx, ty, t);
        }
        Ok(())
    }

    /// Paint bucket (docs/M2.md section 4): flood fill from (x, y) on the chosen source, then
    /// `paint_coverage` over the whole canvas.
    #[allow(clippy::too_many_arguments)]
    pub fn bucket(
        &mut self,
        id: u32,
        target: Target,
        x: i32,
        y: i32,
        rgba: [u8; 4],
        mode: PaintMode,
        opacity: f32,
        tolerance: u8,
        antialias: bool,
        contiguous: bool,
        all_layers: bool,
    ) -> Result<(), String> {
        self.check_idle()?;
        if target == Target::Pixels {
            self.check_pixel_edit(id)?;
        }
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return Err("bucket seed must be inside the canvas".into());
        }
        let src = self.sample_rgba8(all_layers, id)?;
        let cov = region::flood(&src, self.width, self.height, (x as u32, y as u32), tolerance, contiguous, antialias);
        self.paint_coverage(id, target, 0, 0, self.width, self.height, &cov, rgba, mode, opacity)
    }

    pub fn has_selection(&self) -> bool {
        self.selection.is_some()
    }

    /// Tight bounds of the selected (non-zero) pixels as [x, y, w, h], or None.
    pub fn selection_bounds(&self) -> Option<[i32; 4]> {
        let sel = self.selection.as_ref()?;
        let mut bb: Option<(i32, i32, i32, i32)> = None;
        let grow = |bb: &mut Option<(i32, i32, i32, i32)>, x0: i32, y0: i32, x1: i32, y1: i32| {
            *bb = Some(match *bb {
                None => (x0, y0, x1, y1),
                Some(b) => (b.0.min(x0), b.1.min(y0), b.2.max(x1), b.3.max(y1)),
            });
        };
        for (tx, ty) in self.tiles_of_rect(0, 0, self.width as i32, self.height as i32) {
            let Some(t) = sel.tiles.get(tx, ty) else {
                // A missing tile is the default, which covers the whole tile when it is not 0.
                if sel.default > 0 {
                    let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
                    grow(
                        &mut bb,
                        ox,
                        oy,
                        (ox + TILE as i32).min(self.width as i32),
                        (oy + TILE as i32).min(self.height as i32),
                    );
                }
                continue;
            };
            let px = &t.px;
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for y in 0..TILE as i32 {
                for x in 0..TILE as i32 {
                    if ox + x >= self.width as i32 || oy + y >= self.height as i32 {
                        continue;
                    }
                    if px.mask_f32((y * TILE as i32 + x) as usize) <= 0.0 {
                        continue;
                    }
                    let (gx, gy) = (ox + x, oy + y);
                    bb = Some(match bb {
                        None => (gx, gy, gx + 1, gy + 1),
                        Some(b) => (b.0.min(gx), b.1.min(gy), b.2.max(gx + 1), b.3.max(gy + 1)),
                    });
                }
            }
        }
        bb.map(|(x0, y0, x1, y1)| [x0, y0, x1 - x0, y1 - y0])
    }

    /// The selection mask of one display tile as 8-bit coverage, or None when the whole tile is
    /// the mask default. Level 0 is exact, higher levels are box reduced like layer masks.
    pub fn selection_tile(&self, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        if level > 8 {
            return Err("level must be <= 8".into());
        }
        let Some(sel) = &self.selection else { return Ok(None) };
        let Some((_, px)) = self.level_tile(&sel.tiles, Some(sel.default), level, tx, ty) else {
            return Ok(None);
        };
        Ok(Some(match px.as_ref() {
            Pixels::Mask8(d) => d.to_vec(),
            Pixels::Mask16(d) => d.iter().map(|v| (v >> 8) as u8).collect(),
            _ => return Err("a selection tile is always a mask".into()),
        }))
    }

    /// Saves the selection as a named channel and returns its id.
    pub fn save_selection(&mut self, name: &str) -> Result<u32, String> {
        self.check_idle()?;
        let mask = self.selection.clone().ok_or("nothing is selected")?;
        let id = self.channels.iter().map(|c| c.id).max().unwrap_or(0) + 1;
        self.channels.push(Channel { id, name: name.to_string(), mask });
        Ok(id)
    }

    /// Combines a saved channel into the selection.
    pub fn load_selection(&mut self, channel: u32, invert: bool, mode: Mode) -> Result<(), String> {
        self.check_idle()?;
        let src = self
            .channels
            .iter()
            .find(|c| c.id == channel)
            .ok_or_else(|| format!("unknown channel {channel}"))?
            .mask
            .clone();
        let old = self.selection.take().unwrap_or_default();
        let max = self.max();
        let src_def = src.default as f32 / max;
        let old_def = old.default as f32 / max;
        let src_def = if invert { 1.0 - src_def } else { src_def };
        let mut sel = SelMask {
            default: (mode.combine(old_def, src_def).clamp(0.0, 1.0) * max).round() as u32,
            tiles: Tiles::default(),
        };
        let mut area: Vec<(i32, i32)> = src.tiles.coords();
        for at in old.tiles.coords() {
            if !area.contains(&at) {
                area.push(at);
            }
        }
        let mut values = vec![0f32; TILE_PIXELS];
        for (tx, ty) in area {
            if !self.on_canvas(tx, ty) {
                continue;
            }
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                let mut c = self.sel_at(&src, x, y);
                if invert {
                    c = 1.0 - c;
                }
                values[p] = mode.combine(self.sel_at(&old, x, y), c).clamp(0.0, 1.0);
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    /// Full doc-sized selection coverage, 0..1, defaulting to unselected when nothing is selected.
    fn selection_values(&self) -> Vec<f32> {
        let sel = self.selection.clone().unwrap_or_default();
        let (w, h) = (self.width as i32, self.height as i32);
        let mut out = vec![0f32; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                out[(y * w + x) as usize] = self.sel_at(&sel, x, y);
            }
        }
        out
    }

    /// Select > Modify (docs/M2.md section 3): `op` is "border", "smooth", "expand" or "contract".
    pub fn modify_selection(&mut self, op: &str, r: f64, canvas_bounds: bool) -> Result<(), String> {
        self.check_idle()?;
        self.selection.as_ref().ok_or("nothing is selected")?;
        let vals = self.selection_values();
        let (w, h) = (self.width, self.height);
        let out = match op {
            "expand" => region::expand(&vals, w, h, r as f32, canvas_bounds),
            "contract" => region::contract(&vals, w, h, r as f32, canvas_bounds),
            "border" => region::border(&vals, w, h, r as f32, canvas_bounds),
            "smooth" => region::smooth(&vals, w, h, r as u32, canvas_bounds),
            other => return Err(format!("unknown modify op {other}")),
        };
        self.select_shape(&MaskShape::new(w as i32, h as i32, out), Mode::New)
    }

    pub fn delete_channel(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let at = self
            .channels
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| format!("unknown channel {id}"))?;
        self.channels.remove(at);
        Ok(())
    }

    /// Combines the current selection into an existing saved channel (M2.md "combine into an
    /// existing channel").
    pub fn combine_into_channel(&mut self, channel: u32, mode: Mode) -> Result<(), String> {
        self.check_idle()?;
        let sel = self.selection.clone().unwrap_or_default();
        let old = self
            .channels
            .iter()
            .find(|c| c.id == channel)
            .ok_or_else(|| format!("unknown channel {channel}"))?
            .mask
            .clone();
        let max = self.max();
        let mut merged = SelMask {
            default: (mode.combine(old.default as f32 / max, sel.default as f32 / max).clamp(0.0, 1.0) * max).round() as u32,
            tiles: Tiles::default(),
        };
        let mut area: Vec<(i32, i32)> = sel.tiles.coords();
        for at in old.tiles.coords() {
            if !area.contains(&at) {
                area.push(at);
            }
        }
        let mut values = vec![0f32; TILE_PIXELS];
        for (tx, ty) in area {
            if !self.on_canvas(tx, ty) {
                continue;
            }
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                values[p] = mode.combine(self.sel_at(&old, x, y), self.sel_at(&sel, x, y)).clamp(0.0, 1.0);
            }
            self.set_sel_tile(&mut merged, tx, ty, &values);
        }
        self.channels.iter_mut().find(|c| c.id == channel).expect("checked above").mask = merged;
        Ok(())
    }

    // ---------- layer bounds (M2.md section 5) ----------

    /// Tight bounds of the layer's non-transparent pixels as [x, y, w, h], canvas coordinates
    /// that may be negative or reach past the canvas.
    pub fn layer_bounds(&self, id: u32) -> Result<Option<[i32; 4]>, String> {
        let tiles = self.node(id)?.pixel_tiles()?;
        let mut bb: Option<(i32, i32, i32, i32)> = None;
        for (tx, ty) in tiles.coords() {
            let px = &tiles.get(tx, ty).expect("a listed tile").px;
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for p in 0..TILE_PIXELS {
                if px.rgba_f32(p)[3] <= 0.0 {
                    continue;
                }
                let (gx, gy) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                bb = Some(match bb {
                    None => (gx, gy, gx + 1, gy + 1),
                    Some(b) => (b.0.min(gx), b.1.min(gy), b.2.max(gx + 1), b.3.max(gy + 1)),
                });
            }
        }
        Ok(bb.map(|(x0, y0, x1, y1)| [x0, y0, x1 - x0, y1 - y0]))
    }

    // Every tile of `src` moved by (dx, dy); a missing source tile reads as empty or as the
    // mask default, so an empty area stays empty.
    fn shift_tiles(&mut self, src: &Tiles, dx: i32, dy: i32, mask_default: Option<u32>) -> Tiles {
        let t = |v: i32| v.div_euclid(TILE as i32);
        let mut dest: Vec<(i32, i32)> = Vec::new();
        for (tx, ty) in src.coords() {
            let (x0, y0) = (tx * TILE as i32 + dx, ty * TILE as i32 + dy);
            for at in [
                (t(x0), t(y0)),
                (t(x0 + TILE as i32 - 1), t(y0)),
                (t(x0), t(y0 + TILE as i32 - 1)),
                (t(x0 + TILE as i32 - 1), t(y0 + TILE as i32 - 1)),
            ] {
                if !dest.contains(&at) {
                    dest.push(at);
                }
            }
        }
        let max = self.max();
        let def = mask_default.map_or(0.0, |d| d as f32 / max);
        let mut out = Tiles::default();
        let mut buf = vec![0f32; TILE_PIXELS * if mask_default.is_some() { 1 } else { 4 }];
        for (dtx, dty) in dest {
            let mut any = false;
            for p in 0..TILE_PIXELS {
                let sx = dtx * TILE as i32 + (p % TILE) as i32 - dx;
                let sy = dty * TILE as i32 + (p / TILE) as i32 - dy;
                let sp = (sy.rem_euclid(TILE as i32) * TILE as i32 + sx.rem_euclid(TILE as i32)) as usize;
                let tile = src.get(t(sx), t(sy));
                match mask_default {
                    Some(_) => {
                        let v = tile.map_or(def, |t| t.px.mask_f32(sp));
                        any |= (v - def).abs() > f32::EPSILON;
                        buf[p] = v;
                    }
                    None => {
                        let v = tile.map_or([0.0; 4], |t| t.px.rgba_f32(sp));
                        any |= v[3] > 0.0;
                        buf[p * 4..p * 4 + 4].copy_from_slice(&v);
                    }
                }
            }
            if !any {
                continue;
            }
            let px = match mask_default {
                Some(_) => Pixels::mask_from_norm(self.depth, &buf),
                None => Pixels::from_straight(self.depth, &buf),
            };
            out.put(dtx, dty, Some(Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
        }
        out
    }

    /// Moves a pixel layer and its mask by whole pixels. Pixels outside the canvas are kept.
    pub fn offset_layer(&mut self, id: u32, dx: i32, dy: i32) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_edit(id)?;
        if self.node(id)?.locks.position {
            return Err("layer position is locked".into());
        }
        if dx == 0 && dy == 0 {
            return Ok(());
        }
        // The shifted tiles must stay within the coordinates a manifest may store.
        let node = self.node(id)?;
        let mask_coords = node.mask.as_ref().map_or(Vec::new(), |m| m.tiles.coords());
        let lim = MAX_TILE_COORD as i64;
        let fits = |t: i32, d: i32| {
            let lo = (t as i64 * TILE as i64 + d as i64).div_euclid(TILE as i64);
            lo >= -lim && lo + 1 <= lim
        };
        if !node.pixel_tiles()?.coords().into_iter().chain(mask_coords).all(|(tx, ty)| fits(tx, dx) && fits(ty, dy)) {
            return Err("offset moves the layer too far".into());
        }
        let src = self.node(id)?.pixel_tiles()?.clone();
        let moved = self.shift_tiles(&src, dx, dy, None);
        *self.node_mut(id)?.pixel_tiles_mut()? = moved;
        let mask = self.node(id)?.mask.as_ref().map(|m| (m.default, m.tiles.clone()));
        if let Some((default, tiles)) = mask {
            let moved = self.shift_tiles(&tiles, dx, dy, Some(default));
            self.node_mut(id)?.mask.as_mut().expect("checked").tiles = moved;
        }
        Ok(())
    }

    // ---------- level pyramid ----------

    /// Document size in level-`level` pixels.
    fn level_size(&self, level: u32) -> (u32, u32) {
        (self.width.div_ceil(1 << level), self.height.div_ceil(1 << level))
    }

    fn level_tiles(&self, level: u32) -> (u32, u32) {
        let (w, h) = self.level_size(level);
        (tiles_for(w), tiles_for(h))
    }

    /// Valid (inside the document rect) level-`level` pixels of tile (tx, ty).
    fn level_valid(&self, level: u32, tx: u32, ty: u32) -> (usize, usize) {
        let (w, h) = self.level_size(level);
        let v = |size: u32, t: u32| size.saturating_sub(t * TILE as u32).min(TILE as u32) as usize;
        (v(w, tx), v(h, ty))
    }

    // A node's tile at `level`: level 0 is the stored tile, every higher level a lazily built
    // 2x2 box average of the level below (premultiplied for pixels, plain for masks). The key is
    // derived from the child keys, so an edit (which allocates new tile ids) yields a new key and
    // the cache never serves stale content. Outside the document rect: transparent / mask default.
    fn level_tile(
        &self,
        tiles: &Tiles,
        mask_default: Option<u32>,
        level: u32,
        tx: u32,
        ty: u32,
    ) -> Option<(u64, Arc<Pixels>)> {
        let (ntx, nty) = self.level_tiles(level);
        if tx >= ntx || ty >= nty {
            return None;
        }
        if level == 0 {
            let t = tiles.get(tx as i32, ty as i32)?;
            return Some((t.id, t.px.clone()));
        }
        let (key, empty) = self.footprint_key(tiles, mask_default, level, tx, ty);
        if empty {
            return None;
        }
        let hit = self.tile_cache.borrow_mut().get(key);
        if let Some(px) = hit {
            return Some((key, px));
        }
        let kids: [Option<(u64, Arc<Pixels>)>; 4] = std::array::from_fn(|q| {
            self.level_tile(tiles, mask_default, level - 1, tx * 2 + (q as u32 & 1), ty * 2 + (q as u32 >> 1))
        });
        let valid: [(usize, usize); 4] = std::array::from_fn(|q| {
            self.level_valid(level - 1, tx * 2 + (q as u32 & 1), ty * 2 + (q as u32 >> 1))
        });
        let px = Arc::new(self.reduce(&kids, &valid, mask_default));
        self.tile_cache.borrow_mut().insert(key, px.clone(), level);
        Some((key, px))
    }

    // The key mixes the level-0 tile ids under the tile, so a cache hit costs no rebuild of the
    // subtree, and an edit (which always allocates a new tile id) misses. `empty` means no stored
    // tile at all, which is a `None` tile at every level above it.
    fn footprint_key(
        &self,
        tiles: &Tiles,
        mask_default: Option<u32>,
        level: u32,
        tx: u32,
        ty: u32,
    ) -> (u64, bool) {
        let (n0x, n0y) = self.level_tiles(0);
        let n = 1u32 << level;
        let mut key = mix(0x9E37_79B9_7F4A_7C15, level as u64);
        key = mix(key, mask_default.map_or(u64::MAX, |d| d as u64));
        let mut empty = true;
        for j in 0..n {
            for i in 0..n {
                let (sx, sy) = (tx * n + i, ty * n + j);
                let id = if sx < n0x && sy < n0y { tiles.id_at(sx as i32, sy as i32) } else { 0 };
                empty &= id == 0;
                key = mix(key, id);
            }
        }
        (key | (1 << 63), empty)
    }

    fn reduce(
        &self,
        kids: &[Option<(u64, Arc<Pixels>)>; 4],
        valid: &[(usize, usize); 4],
        mask_default: Option<u32>,
    ) -> Pixels {
        fn u8s(p: &Pixels) -> &[u8] {
            match p {
                Pixels::U8(d) | Pixels::Mask8(d) => d,
                _ => unreachable!("tile depth differs from the document depth"),
            }
        }
        fn u16s(p: &Pixels) -> &[u16] {
            match p {
                Pixels::U16(d) | Pixels::Mask16(d) => d,
                _ => unreachable!("tile depth differs from the document depth"),
            }
        }
        let k8 = || kids.each_ref().map(|k| k.as_ref().map(|(_, p)| u8s(p)));
        let k16 = || kids.each_ref().map(|k| k.as_ref().map(|(_, p)| u16s(p)));
        match (self.depth, mask_default) {
            (8, None) => Pixels::U8(reduce_rgba(k8(), valid, |v| v as u8)),
            (_, None) => Pixels::U16(reduce_rgba(k16(), valid, |v| v as u16)),
            (8, Some(d)) => Pixels::Mask8(reduce_mask(k8(), valid, d as u8, |v| v as u8)),
            (_, Some(d)) => Pixels::Mask16(reduce_mask(k16(), valid, d as u16, |v| v as u16)),
        }
    }

    // The float reduction the integer one replaced; kept as the oracle for its test.
    #[cfg(test)]
    fn reduce_f32(
        &self,
        kids: &[Option<(u64, Arc<Pixels>)>; 4],
        valid: &[(usize, usize); 4],
        mask_default: Option<u32>,
    ) -> Pixels {
        let max = max_value(self.depth);
        let half = TILE / 2;
        if let Some(def) = mask_default {
            let def = def as f32 / max as f32;
            let mut out = vec![def; TILE_PIXELS];
            for q in 0..4 {
                let (qx, qy) = (q & 1, q >> 1);
                let (vw, vh) = valid[q];
                let px = kids[q].as_ref().map(|(_, p)| p.clone());
                for oy in 0..half {
                    for ox in 0..half {
                        let mut acc = 0.0;
                        for dy in 0..2 {
                            for dx in 0..2 {
                                let (sx, sy) = (ox * 2 + dx, oy * 2 + dy);
                                acc += match &px {
                                    Some(p) if sx < vw && sy < vh => p.mask_f32(sy * TILE + sx),
                                    _ => def,
                                };
                            }
                        }
                        out[(qy * half + oy) * TILE + qx * half + ox] = acc / 4.0;
                    }
                }
            }
            return Pixels::mask_from_norm(self.depth, &out);
        }
        let mut out = vec![0f32; TILE_PIXELS * 4];
        for q in 0..4 {
            let Some((_, px)) = &kids[q] else { continue };
            let (qx, qy) = (q & 1, q >> 1);
            let (vw, vh) = valid[q];
            for oy in 0..half {
                for ox in 0..half {
                    let mut acc = [0f32; 4];
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let (sx, sy) = (ox * 2 + dx, oy * 2 + dy);
                            if sx >= vw || sy >= vh {
                                continue;
                            }
                            let [r, g, b, a] = px.rgba_f32(sy * TILE + sx);
                            acc[0] += r * a;
                            acc[1] += g * a;
                            acc[2] += b * a;
                            acc[3] += a;
                        }
                    }
                    if acc[3] <= 0.0 {
                        continue;
                    }
                    let inv = 1.0 / acc[3];
                    let o = ((qy * half + oy) * TILE + qx * half + ox) * 4;
                    out[o] = acc[0] * inv;
                    out[o + 1] = acc[1] * inv;
                    out[o + 2] = acc[2] * inv;
                    out[o + 3] = acc[3] / 4.0;
                }
            }
        }
        Pixels::from_straight(self.depth, &out)
    }

    // ---------- draw program (M1.md section 3) ----------

    fn payload(&self, prog: &mut Program, t: (u64, Arc<Pixels>)) -> u64 {
        if !prog.payloads.iter().any(|(k, _)| *k == t.0) {
            prog.payloads.push(t.clone());
        }
        t.0
    }

    fn node_tile(&self, node: &Node, prog: &mut Program) -> Option<u64> {
        let Kind::Pixel(tiles) = &node.kind else { return None };
        let t = self.level_tile(tiles, None, prog.level, prog.tx, prog.ty)?;
        Some(self.payload(prog, t))
    }

    // (kind, tile key, const value) matching `MaskSrc`.
    fn node_mask(&self, node: &Node, prog: &mut Program) -> (u8, u64, f32) {
        match &node.mask {
            Some(m) if m.enabled => {
                match self.level_tile(&m.tiles, Some(m.default), prog.level, prog.tx, prog.ty) {
                    Some(t) => (2, self.payload(prog, t), 0.0),
                    None => (1, 0, m.default as f32 / max_value(self.depth) as f32),
                }
            }
            _ => (0, 0, 0.0),
        }
    }

    fn emit_node(&self, node: &Node, scale: f32, mode: Blend, prog: &mut Program) {
        let (mk, mkey, mc) = self.node_mask(node, prog);
        if mode == Blend::PassThrough {
            let Kind::Group(children) = &node.kind else { return };
            prog.steps.push(Step::new(Op::PushCopy));
            self.emit_list(children, prog);
            let mut s = Step::new(Op::PopLerp);
            (s.mask_kind, s.mask, s.mask_const, s.scale) = (mk, mkey, mc, scale);
            prog.steps.push(s);
            return;
        }
        let src = match &node.kind {
            Kind::Pixel(_) => match self.node_tile(node, prog) {
                Some(k) => k,
                None => return,
            },
            Kind::Group(children) => {
                prog.steps.push(Step::new(Op::PushTransparent));
                self.emit_list(children, prog);
                0
            }
        };
        let mut s = Step::new(Op::Draw);
        (s.src, s.mask_kind, s.mask, s.mask_const, s.scale, s.mode, s.node) =
            (src, mk, mkey, mc, scale, mode, node.id);
        prog.steps.push(s);
    }

    // A clipping group: base B plus the consecutive clipped nodes above it (M1.md section 3).
    // S is B's coverage. B's share of each pixel is divided by S, the clipped nodes draw onto it
    // normally, and the result is multiplied by S again (source-atop at full fill).
    fn emit_clipping(&self, base: &Node, clipped: &[Node], prog: &mut Program) {
        let (mk, mkey, mc) = self.node_mask(base, prog);
        let pass = base.blend == Blend::PassThrough;
        // A pass-through base stays in place, so its opacity and fill are part of its share.
        let k = if pass { base.opacity * base.fill } else { 1.0 };
        let mut shape = Step::new(Op::PushShape);
        (shape.mask_kind, shape.mask, shape.mask_const, shape.scale) = (mk, mkey, mc, k);
        match &base.kind {
            Kind::Pixel(_) => {
                let Some(src) = self.node_tile(base, prog) else { return };
                shape.src = src;
                prog.steps.push(shape);
                prog.steps.push(Step::new(Op::PushTransparent));
                let mut s = Step::new(Op::Draw);
                (s.src, s.mask_kind, s.mask, s.mask_const, s.scale, s.node) =
                    (src, mk, mkey, mc, base.fill, base.id);
                prog.steps.push(s);
            }
            Kind::Group(children) if !pass => {
                prog.steps.push(Step::new(Op::PushTransparent)); // the group's share
                prog.steps.push(Step::new(Op::PushTransparent)); // the base composited alone
                self.emit_list(children, prog);
                prog.steps.push(shape);
                let mut s = Step::new(Op::Draw);
                (s.mask_kind, s.mask, s.mask_const, s.scale, s.node) = (mk, mkey, mc, base.fill, base.id);
                prog.steps.push(s);
            }
            Kind::Group(children) => {
                prog.steps.push(Step::new(Op::PushTransparent));
                self.emit_list(children, prog);
                prog.steps.push(shape);
                prog.steps.push(Step::new(Op::Pop));
                prog.steps.push(Step::new(Op::PushCopy)); // the in-place result
                prog.steps.push(Step::new(Op::PushCopy));
                self.emit_list(children, prog);
                let mut s = Step::new(Op::PopLerp);
                (s.mask_kind, s.mask, s.mask_const, s.scale) = (mk, mkey, mc, k);
                prog.steps.push(s);
                prog.steps.push(Step::new(Op::SubBackdrop));
            }
        }
        prog.steps.push(Step::new(Op::DivShape));
        for n in clipped {
            if n.visible && n.opacity > 0.0 {
                self.emit_node(n, n.opacity * n.fill, n.blend, prog);
            }
        }
        prog.steps.push(Step::new(Op::MulShape));
        if pass {
            prog.steps.push(Step::new(Op::PopAddBackdrop));
        } else {
            let mut s = Step::new(Op::Draw);
            (s.scale, s.mode, s.node) = (base.opacity, base.blend, base.id);
            prog.steps.push(s);
        }
        prog.steps.push(Step::new(Op::PopShape));
    }

    fn emit_list(&self, nodes: &[Node], prog: &mut Program) {
        let mut i = 0;
        while i < nodes.len() {
            let mut j = i + 1;
            while j < nodes.len() && nodes[j].clipping {
                j += 1;
            }
            let base = &nodes[i];
            if j == i + 1 {
                if base.visible && base.opacity > 0.0 {
                    self.emit_node(base, base.opacity * base.fill, base.blend, prog);
                }
            } else if base.visible {
                self.emit_clipping(base, &nodes[i + 1..j], prog);
            }
            i = j;
        }
    }

    /// The ordered draw program for one display tile, with the level tiles it references.
    fn program(&self, level: u32, tx: u32, ty: u32) -> Result<Program, String> {
        if level > 8 {
            return Err("level must be <= 8".into());
        }
        let (vw, vh) = self.level_valid(level, tx, ty);
        let mut prog = Program {
            level,
            tx,
            ty,
            ox: tx * TILE as u32,
            oy: ty * TILE as u32,
            vw,
            vh,
            steps: Vec::new(),
            payloads: Vec::new(),
        };
        self.emit_list(&self.nodes, &mut prog);
        Ok(prog)
    }

    /// One display tile as premultiplied f32 RGBA, by running its draw program.
    fn run_program(prog: &Program) -> Vec<f32> {
        let tiles: HashMap<u64, &Pixels> = prog.payloads.iter().map(|(k, p)| (*k, p.as_ref())).collect();
        let c = TileCtx { level: prog.level, ox: prog.ox, oy: prog.oy, vw: prog.vw, vh: prog.vh };
        let mut stack: Vec<Vec<f32>> = vec![vec![0f32; TILE_PIXELS * 4]];
        let mut shapes: Vec<Vec<f32>> = Vec::new();
        for s in &prog.steps {
            let mask = match s.mask_kind {
                1 => MaskSrc::Const(s.mask_const),
                2 => MaskSrc::Tile(tiles[&s.mask]),
                _ => MaskSrc::Full,
            };
            match s.op {
                Op::PushTransparent => stack.push(vec![0f32; TILE_PIXELS * 4]),
                Op::PushCopy => {
                    let top = stack.last().expect("stack is never empty").clone();
                    stack.push(top);
                }
                Op::Pop => {
                    stack.pop();
                }
                Op::Draw => {
                    if s.src != 0 {
                        let src = Src::Tile(tiles[&s.src]);
                        draw(stack.last_mut().expect("stack"), src, &mask, s.scale, s.mode, s.node, &c);
                    } else {
                        let g = stack.pop().expect("stack");
                        let dst = stack.last_mut().expect("stack");
                        draw(dst, Src::Buf(&g), &mask, s.scale, s.mode, s.node, &c);
                    }
                }
                Op::PopLerp => {
                    let r = stack.pop().expect("stack");
                    let dst = stack.last_mut().expect("stack");
                    for y in 0..c.vh {
                        for x in 0..c.vw {
                            let p = y * TILE + x;
                            let k = s.scale * mask.at(p);
                            if k <= 0.0 {
                                continue;
                            }
                            let o = p * 4;
                            for ch in 0..4 {
                                dst[o + ch] += (r[o + ch] - dst[o + ch]) * k;
                            }
                        }
                    }
                }
                Op::PushShape => {
                    let src = if s.src != 0 {
                        Src::Tile(tiles[&s.src])
                    } else {
                        Src::Buf(stack.last().expect("stack"))
                    };
                    let mut shape = vec![0f32; TILE_PIXELS];
                    for y in 0..c.vh {
                        for x in 0..c.vw {
                            let p = y * TILE + x;
                            shape[p] = src.at(p)[3] * mask.at(p) * s.scale;
                        }
                    }
                    shapes.push(shape);
                }
                Op::DivShape | Op::MulShape => {
                    let shape = shapes.last().expect("shape stack");
                    let dst = stack.last_mut().expect("stack");
                    for p in 0..TILE_PIXELS {
                        let f = match s.op {
                            Op::MulShape => shape[p],
                            _ if shape[p] > 0.0 => 1.0 / shape[p],
                            _ => 0.0,
                        };
                        dst[p * 4..p * 4 + 4].iter_mut().for_each(|v| *v *= f);
                    }
                }
                Op::SubBackdrop => {
                    let shape = shapes.last().expect("shape stack");
                    let (dst, rest) = stack.split_last_mut().expect("stack");
                    let back = rest.last().expect("a backdrop below the top");
                    for p in 0..TILE_PIXELS {
                        for ch in 0..4 {
                            let o = p * 4 + ch;
                            dst[o] -= (1.0 - shape[p]) * back[o];
                        }
                    }
                }
                Op::PopAddBackdrop => {
                    let shape = shapes.last().expect("shape stack");
                    let g = stack.pop().expect("stack");
                    let dst = stack.last_mut().expect("stack");
                    for p in 0..TILE_PIXELS {
                        for ch in 0..4 {
                            let o = p * 4 + ch;
                            dst[o] = (1.0 - shape[p]) * dst[o] + g[o];
                        }
                    }
                }
                Op::PopShape => {
                    shapes.pop();
                }
            }
        }
        stack.pop().expect("the program leaves exactly the destination")
    }

    // ---------- compositing ----------

    // Composites one level-0 tile bottom-to-top into a premultiplied f32 buffer.
    // Pixels outside the document rect (in an edge tile) are left as 0 (transparent).
    fn composite_tile_premul(&self, tx: u32, ty: u32) -> Vec<f32> {
        Document::run_program(&self.program(0, tx, ty).expect("level 0 is valid"))
    }

    /// The level-`level` display tile as premultiplied RGBA8, or None when it is fully
    /// transparent. Level 0 is exact; higher levels composite the layers' pyramid tiles.
    pub fn display_tile(&self, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        Ok(quantize_premul(&Document::run_program(&self.program(level, tx, ty)?)))
    }

    /// The encoded draw program for one display tile (8-bit documents only). `known` lists
    /// payload keys the caller already has; their bytes are left out. See `Program` for the layout.
    pub fn display_program(&self, level: u32, tx: u32, ty: u32, known: &[u64]) -> Result<Vec<u8>, String> {
        if self.depth != 8 {
            return Err("draw programs need an 8-bit document".into());
        }
        Ok(self.program(level, tx, ty)?.encode(known))
    }

    #[cfg(test)]
    fn level_tile_bytes(&self, id: u32, mask: bool, level: u32, tx: u32, ty: u32) -> Option<Vec<u8>> {
        let node = self.node(id).unwrap();
        let t = if mask {
            let m = node.mask.as_ref().unwrap();
            self.level_tile(&m.tiles, Some(m.default), level, tx, ty)?
        } else {
            self.level_tile(node.pixel_tiles().unwrap(), None, level, tx, ty)?
        };
        Some(t.1.to_bytes())
    }
}

fn quantize_premul(out: &[f32]) -> Option<Vec<u8>> {
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
        return None;
    }
    Some(bytes)
}

impl Document {
    pub fn flatten_tile_rgba8(&self, tx: u32, ty: u32) -> Result<Vec<u8>, String> {
        self.check_tile_coord(tx, ty)?;
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

    // ---------- persistence ----------

    fn node_out<'a>(n: &'a Node, tiles_out: bool) -> NodeOut<'a> {
        NodeOut {
            id: n.id,
            name: &n.name,
            kind: if n.is_group() { "group" } else { "pixel" },
            visible: n.visible,
            opacity: n.opacity,
            fill: n.fill,
            blend: n.blend.name(),
            clipping: n.clipping,
            locks: n.locks,
            mask: n.mask.as_ref().map(|m| MaskOut {
                enabled: m.enabled,
                default: m.default,
                tiles: if tiles_out { Some(m.tiles.out()) } else { None },
            }),
            tiles: match (&n.kind, tiles_out) {
                (Kind::Pixel(t), true) => Some(t.out()),
                _ => None,
            },
            children: match &n.kind {
                Kind::Group(ch) => Some(ch.iter().map(|c| Document::node_out(c, tiles_out)).collect()),
                Kind::Pixel(_) => None,
            },
        }
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
            next_node_id: self.next_node_id,
            layers: self.nodes.iter().map(|n| Document::node_out(n, true)).collect(),
            selection: self.selection.as_ref().map(sel_out),
            last_selection: self.last_selection.as_ref().map(sel_out),
            channels: self
                .channels
                .iter()
                .map(|c| ChannelOut { id: c.id, name: &c.name, default: c.mask.default, tiles: c.mask.tiles.out() })
                .collect(),
        };
        serde_json::to_string(&m).expect("manifest serialization cannot fail")
    }

    /// The selection state and the saved channels for the UI.
    pub fn channels_json(&self) -> String {
        let v = serde_json::json!({
            "selection": self.selection.as_ref().map(|s| serde_json::json!({
                "default": s.default,
                "bounds": self.selection_bounds(),
            })),
            "has_last_selection": self.last_selection.is_some(),
            "channels": self.channels.iter().map(|c| serde_json::json!({ "id": c.id, "name": c.name })).collect::<Vec<_>>(),
        });
        v.to_string()
    }

    /// The layer tree for the UI: manifest fields without the tile arrays.
    pub fn layers_json(&self) -> String {
        let tree: Vec<NodeOut> = self.nodes.iter().map(|n| Document::node_out(n, false)).collect();
        serde_json::to_string(&tree).expect("layer tree serialization cannot fail")
    }

    fn tile_bytes_in(nodes: &[Node], id: u64) -> Option<Vec<u8>> {
        for n in nodes {
            if let Kind::Pixel(tiles) = &n.kind {
                if let Some(b) = find_tile(tiles, id) {
                    return Some(b);
                }
            }
            if let Some(m) = &n.mask {
                if let Some(b) = find_tile(&m.tiles, id) {
                    return Some(b);
                }
            }
            if let Kind::Group(ch) = &n.kind {
                if let Some(b) = Document::tile_bytes_in(ch, id) {
                    return Some(b);
                }
            }
        }
        None
    }

    pub fn tile_bytes(&self, id: u64) -> Result<Vec<u8>, String> {
        Document::tile_bytes_in(&self.nodes, id)
            .or_else(|| {
                self.selection
                    .iter()
                    .chain(self.last_selection.iter())
                    .chain(self.channels.iter().map(|c| &c.mask))
                    .find_map(|s| find_tile(&s.tiles, id))
            })
            .ok_or_else(|| format!("unknown tile id {id}"))
    }

    pub fn from_manifest(json: &str) -> Result<Document, String> {
        let probe: VersionProbe = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
        if probe.format != MANIFEST_FORMAT {
            return Err(format!("unexpected format {}", probe.format));
        }
        match probe.version {
            1 => {
                let m: ManifestV1In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                let nodes: Vec<NodeIn<u64>> = m
                    .layers
                    .iter()
                    .enumerate()
                    .map(|(i, l)| NodeIn {
                        id: i as u32 + 1,
                        name: l.name.clone(),
                        kind: "pixel".into(),
                        visible: l.visible,
                        opacity: l.opacity,
                        fill: 1.0,
                        blend: "normal".into(),
                        clipping: false,
                        locks: Locks::default(),
                        mask: None,
                        tiles: Some(l.tiles.clone()),
                        children: None,
                    })
                    .collect();
                let layers = spread_nodes(nodes, m.tiles_x, m.tiles_y)?;
                Document::build(
                    Head { width: m.width, height: m.height, depth: m.depth, tiles_x: m.tiles_x, tiles_y: m.tiles_y },
                    m.next_id,
                    layers.len() as u32 + 1,
                    layers,
                    None,
                    None,
                    Vec::new(),
                )
            }
            2 => {
                let m: ManifestV2In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                let layers = spread_nodes(m.layers, m.tiles_x, m.tiles_y)?;
                Document::build(
                    Head { width: m.width, height: m.height, depth: m.depth, tiles_x: m.tiles_x, tiles_y: m.tiles_y },
                    m.next_id,
                    m.next_node_id,
                    layers,
                    None,
                    None,
                    Vec::new(),
                )
            }
            3 => {
                let m: ManifestV3In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                Document::build(
                    Head { width: m.width, height: m.height, depth: m.depth, tiles_x: m.tiles_x, tiles_y: m.tiles_y },
                    m.next_id,
                    m.next_node_id,
                    m.layers,
                    m.selection,
                    m.last_selection,
                    m.channels,
                )
            }
            v => Err(format!("unsupported version {v}")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        head: Head,
        next_id: u64,
        next_node_id: u32,
        layers: Vec<NodeIn<Coord>>,
        selection: Option<SelIn>,
        last_selection: Option<SelIn>,
        channels: Vec<ChannelIn>,
    ) -> Result<Document, String> {
        let Head { width, height, depth, tiles_x, tiles_y } = head;
        validate_dims(width, height, depth)?;
        if tiles_for(width) != tiles_x || tiles_for(height) != tiles_y {
            return Err("tiles_x/tiles_y do not match width/height".into());
        }
        if next_id > MAX_ID {
            return Err("next_id out of range".into());
        }
        if layers.is_empty() {
            return Err("the document must have at least one root node".into());
        }
        let mut ctx = LoadCtx {
            max_mask: max_value(depth),
            canvas: (tiles_x, tiles_y),
            node_ids: HashSet::new(),
            max_node_id: 0,
            kinds: HashMap::new(),
            slots: HashMap::new(),
            max_referenced_id: 0,
        };
        let mut path = Vec::new();
        let nodes = build_nodes(&layers, &mut path, &mut ctx)?;
        if next_node_id <= ctx.max_node_id {
            return Err("next_node_id must be greater than every node id".into());
        }
        let take_sel = |s: &SelIn, slot: Slot, ctx: &mut LoadCtx| -> Result<SelMask, String> {
            if s.default > max_value(depth) {
                return Err("mask default out of range".into());
            }
            Ok(SelMask { default: s.default, tiles: take_tiles(&s.tiles, true, slot, true, ctx)? })
        };
        let selection = selection.as_ref().map(|s| take_sel(s, Slot::Selection, &mut ctx)).transpose()?;
        let last_selection =
            last_selection.as_ref().map(|s| take_sel(s, Slot::LastSelection, &mut ctx)).transpose()?;
        let mut chans = Vec::with_capacity(channels.len());
        let mut chan_ids = HashSet::new();
        for (i, c) in channels.iter().enumerate() {
            if c.id == 0 {
                return Err("channel id 0 is not allowed".into());
            }
            if !chan_ids.insert(c.id) {
                return Err(format!("duplicate channel id {}", c.id));
            }
            let mask = take_sel(&SelIn { default: c.default, tiles: c.tiles.clone() }, Slot::Channel(i), &mut ctx)?;
            chans.push(Channel { id: c.id, name: c.name.clone(), mask });
        }
        let pending_ids: HashSet<u64> = ctx.slots.keys().copied().collect();
        Ok(Document {
            width,
            height,
            depth,
            nodes,
            selection,
            last_selection,
            channels: chans,
            next_id,
            next_node_id,
            loading: Some(Loading {
                slots: ctx.slots,
                pending_ids,
                max_referenced_id: ctx.max_referenced_id,
            }),
            tile_cache: Arc::new(RefCell::new(TileCache::default())),
        })
    }

    pub fn put_tile(&mut self, id: u64, bytes: &[u8]) -> Result<(), String> {
        let depth = self.depth;
        let loading = self.loading.as_ref().ok_or("document is not loading")?;
        let (is_mask, slots) = loading
            .slots
            .get(&id)
            .ok_or_else(|| format!("unknown tile id {id}"))?
            .clone();
        let px = Arc::new(Pixels::from_bytes(depth, is_mask, bytes)?);
        for (slot, tx, ty) in slots {
            let tile = Some(Tile { id, px: px.clone() });
            match slot {
                Slot::Pixels(path) => node_at_mut(&mut self.nodes, &path).pixel_tiles_mut()?.put(tx, ty, tile),
                Slot::Mask(path) => node_at_mut(&mut self.nodes, &path)
                    .mask
                    .as_mut()
                    .expect("mask exists when a mask tile refers to it")
                    .tiles
                    .put(tx, ty, tile),
                Slot::Selection => self.selection.as_mut().expect("a selection exists").tiles.put(tx, ty, tile),
                Slot::LastSelection => {
                    self.last_selection.as_mut().expect("a last selection exists").tiles.put(tx, ty, tile)
                }
                Slot::Channel(i) => self.channels[i].mask.tiles.put(tx, ty, tile),
            }
        }
        self.loading.as_mut().expect("still loading").pending_ids.remove(&id);
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

fn find_tile(tiles: &Tiles, id: u64) -> Option<Vec<u8>> {
    tiles.iter().find(|(_, t)| t.id == id).map(|(_, t)| t.px.to_bytes())
}

struct LoadCtx {
    max_mask: u32,
    canvas: (u32, u32),
    node_ids: HashSet<u32>,
    max_node_id: u32,
    // tile id -> is_mask, so no id is used as both RGBA and mask data.
    kinds: HashMap<u64, bool>,
    slots: HashMap<u64, (bool, Vec<(Slot, i32, i32)>)>,
    max_referenced_id: u64,
}

// A tile grid of a v1/v2 manifest, dense and canvas sized, as sparse entries.
fn spread(ids: &[u64], tiles_x: u32, tiles_y: u32) -> Result<Vec<Coord>, String> {
    if ids.len() != (tiles_x as usize) * (tiles_y as usize) {
        return Err("tile array length does not match tiles_x*tiles_y".into());
    }
    Ok(ids
        .iter()
        .enumerate()
        .filter(|(_, id)| **id != 0)
        .map(|(i, id)| ((i as u32 % tiles_x) as i32, (i as u32 / tiles_x) as i32, *id))
        .collect())
}

fn spread_nodes(nodes: Vec<NodeIn<u64>>, tiles_x: u32, tiles_y: u32) -> Result<Vec<NodeIn<Coord>>, String> {
    nodes
        .into_iter()
        .map(|n| {
            Ok(NodeIn {
                id: n.id,
                name: n.name,
                kind: n.kind,
                visible: n.visible,
                opacity: n.opacity,
                fill: n.fill,
                blend: n.blend,
                clipping: n.clipping,
                locks: n.locks,
                mask: match n.mask {
                    None => None,
                    Some(m) => Some(MaskIn {
                        enabled: m.enabled,
                        default: m.default,
                        tiles: spread(&m.tiles, tiles_x, tiles_y)?,
                    }),
                },
                tiles: n.tiles.as_deref().map(|t| spread(t, tiles_x, tiles_y)).transpose()?,
                children: n.children.map(|c| spread_nodes(c, tiles_x, tiles_y)).transpose()?,
            })
        })
        .collect()
}

fn take_tiles(list: &[Coord], is_mask: bool, slot: Slot, on_canvas: bool, ctx: &mut LoadCtx) -> Result<Tiles, String> {
    let mut seen = HashSet::new();
    for &(tx, ty, id) in list {
        if !seen.insert((tx, ty)) {
            return Err(format!("duplicate tile coordinate ({tx}, {ty})"));
        }
        if tx.unsigned_abs() > MAX_TILE_COORD || ty.unsigned_abs() > MAX_TILE_COORD {
            return Err(format!("tile coordinate ({tx}, {ty}) out of range"));
        }
        if on_canvas && (tx < 0 || ty < 0 || tx as u32 >= ctx.canvas.0 || ty as u32 >= ctx.canvas.1) {
            return Err(format!("tile coordinate ({tx}, {ty}) is outside the canvas"));
        }
        if id == 0 {
            return Err("tile id 0 is not allowed".into());
        }
        if id > MAX_ID {
            return Err(format!("tile id {id} out of range"));
        }
        match ctx.kinds.insert(id, is_mask) {
            Some(prev) if prev != is_mask => {
                return Err(format!("tile id {id} is used as both pixel and mask data"))
            }
            _ => {}
        }
        let entry = ctx.slots.entry(id).or_insert_with(|| (is_mask, Vec::new()));
        entry.1.push((slot.clone(), tx, ty));
        ctx.max_referenced_id = ctx.max_referenced_id.max(id);
    }
    Ok(Tiles::default())
}

fn build_nodes(in_nodes: &[NodeIn<Coord>], path: &mut Vec<usize>, ctx: &mut LoadCtx) -> Result<Vec<Node>, String> {
    let mut out = Vec::with_capacity(in_nodes.len());
    for (i, n) in in_nodes.iter().enumerate() {
        if n.id == 0 {
            return Err("node id 0 is not allowed".into());
        }
        if !ctx.node_ids.insert(n.id) {
            return Err(format!("duplicate node id {}", n.id));
        }
        ctx.max_node_id = ctx.max_node_id.max(n.id);
        let blend = Blend::parse(&n.blend)?;
        unit(n.opacity, "opacity")?;
        unit(n.fill, "fill")?;
        path.push(i);
        let kind = match n.kind.as_str() {
            "pixel" => {
                if blend == Blend::PassThrough {
                    return Err("pass through is only allowed on groups".into());
                }
                if n.children.is_some() {
                    return Err("a pixel node cannot have children".into());
                }
                let ids = n.tiles.as_ref().ok_or("a pixel node needs a tiles array")?;
                Kind::Pixel(take_tiles(ids, false, Slot::Pixels(path.clone()), false, ctx)?)
            }
            "group" => {
                if n.tiles.is_some() {
                    return Err("a group cannot have a tiles array".into());
                }
                let children = n.children.as_deref().ok_or("a group needs a children array")?;
                Kind::Group(build_nodes(children, path, ctx)?)
            }
            other => return Err(format!("unknown node kind {other}")),
        };
        let mask = match &n.mask {
            None => None,
            Some(m) => {
                if m.default > ctx.max_mask {
                    return Err("mask default out of range".into());
                }
                Some(Mask {
                    enabled: m.enabled,
                    default: m.default,
                    tiles: take_tiles(&m.tiles, true, Slot::Mask(path.clone()), false, ctx)?,
                })
            }
        };
        path.pop();
        out.push(Node {
            id: n.id,
            name: n.name.clone(),
            visible: n.visible,
            opacity: n.opacity,
            fill: n.fill,
            blend,
            clipping: n.clipping,
            locks: n.locks,
            mask,
            kind,
        });
    }
    Ok(out)
}

// ---------- serde types ----------

#[derive(Deserialize)]
struct VersionProbe {
    format: String,
    version: u32,
}

/// One stored tile in a manifest: signed tile coordinates and the tile id.
type Coord = (i32, i32, u64);

#[derive(Serialize)]
struct MaskOut {
    enabled: bool,
    default: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tiles: Option<Vec<Coord>>,
}

#[derive(Serialize)]
struct SelOut {
    default: u32,
    tiles: Vec<Coord>,
}

#[derive(Serialize)]
struct ChannelOut<'a> {
    id: u32,
    name: &'a str,
    default: u32,
    tiles: Vec<Coord>,
}

fn sel_out(s: &SelMask) -> SelOut {
    SelOut { default: s.default, tiles: s.tiles.out() }
}

struct Head {
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
}

#[derive(Serialize)]
struct NodeOut<'a> {
    id: u32,
    name: &'a str,
    kind: &'static str,
    visible: bool,
    opacity: f32,
    fill: f32,
    blend: &'static str,
    clipping: bool,
    locks: Locks,
    mask: Option<MaskOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tiles: Option<Vec<Coord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<NodeOut<'a>>>,
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
    next_node_id: u32,
    layers: Vec<NodeOut<'a>>,
    selection: Option<SelOut>,
    last_selection: Option<SelOut>,
    channels: Vec<ChannelOut<'a>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MaskIn<T> {
    enabled: bool,
    default: u32,
    tiles: Vec<T>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeIn<T> {
    id: u32,
    name: String,
    kind: String,
    visible: bool,
    opacity: f32,
    fill: f32,
    blend: String,
    clipping: bool,
    locks: Locks,
    #[serde(default = "no_mask")]
    mask: Option<MaskIn<T>>,
    #[serde(default)]
    tiles: Option<Vec<T>>,
    #[serde(default = "no_children")]
    children: Option<Vec<NodeIn<T>>>,
}

fn no_mask<T>() -> Option<MaskIn<T>> {
    None
}

fn no_children<T>() -> Option<Vec<NodeIn<T>>> {
    None
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelIn {
    default: u32,
    tiles: Vec<Coord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelIn {
    id: u32,
    name: String,
    default: u32,
    tiles: Vec<Coord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestV2In {
    #[allow(dead_code)]
    format: String,
    #[allow(dead_code)]
    version: u32,
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
    next_id: u64,
    next_node_id: u32,
    layers: Vec<NodeIn<u64>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestV3In {
    #[allow(dead_code)]
    format: String,
    #[allow(dead_code)]
    version: u32,
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
    next_id: u64,
    next_node_id: u32,
    layers: Vec<NodeIn<Coord>>,
    #[serde(default)]
    selection: Option<SelIn>,
    #[serde(default)]
    last_selection: Option<SelIn>,
    #[serde(default)]
    channels: Vec<ChannelIn>,
}

#[derive(Deserialize)]
struct ManifestV1LayerIn {
    name: String,
    visible: bool,
    opacity: f32,
    tiles: Vec<u64>,
}

#[derive(Deserialize)]
struct ManifestV1In {
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
    next_id: u64,
    layers: Vec<ManifestV1LayerIn>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocksIn {
    #[serde(default)]
    transparency: Option<bool>,
    #[serde(default)]
    pixels: Option<bool>,
    #[serde(default)]
    position: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PropsIn {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    opacity: Option<f32>,
    #[serde(default)]
    fill: Option<f32>,
    #[serde(default)]
    blend: Option<String>,
    #[serde(default)]
    clipping: Option<bool>,
    #[serde(default)]
    locks: Option<LocksIn>,
    #[serde(default)]
    mask_enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrokeIn {
    rgba: [u8; 4],
    mode: String,
    size: f32,
    #[serde(default = "one")]
    opacity: f32,
    #[serde(default = "one")]
    flow: f32,
    #[serde(default = "one")]
    hardness: f32,
    #[serde(default = "quarter")]
    spacing: f32,
    #[serde(default)]
    angle: f32,
    #[serde(default = "one")]
    roundness: f32,
    #[serde(default = "round_tip")]
    tip: String,
    #[serde(default)]
    aliased: bool,
    #[serde(default)]
    wet_edges: bool,
    #[serde(default)]
    airbrush: bool,
    #[serde(default)]
    pressure_size: bool,
    #[serde(default)]
    pressure_opacity: bool,
    #[serde(default)]
    erase_to_history: Option<u32>,
}

fn one() -> f32 {
    1.0
}

fn quarter() -> f32 {
    0.25
}

fn round_tip() -> String {
    "round".into()
}

// One tile a stroke has touched: the accumulated stroke coverage and the tile as it was at
// stroke start, which every frame recomputes from (so the opacity caps the whole stroke).
struct StrokeTile {
    s: Vec<f32>,
    orig: Option<Tile>,
}

/// An open stroke (docs/M2.md section 4). Lives in `EngineCore`, outside the document, so
/// snapshots and autosaves never see a half stroke.
pub struct Stroke {
    layer: u32,
    target: Target,
    mode: PaintMode,
    rgb: [f32; 3],
    value: f32,
    keep_alpha: bool,
    opacity: f32,
    flow: f32,
    size: f32,
    hardness: f32,
    angle: f32,
    roundness: f32,
    shape: TipShape,
    aliased: bool,
    wet_edges: bool,
    airbrush: bool,
    pressure_size: bool,
    pressure_opacity: bool,
    step: f64,
    spacer: Spacer,
    // Erase to history: the same layer's tiles in the chosen snapshot.
    hist: Option<Tiles>,
    // A quick-mask stroke that created the selection removes it again on cancel.
    sel_was_none: bool,
    tiles: HashMap<(i32, i32), StrokeTile>,
}

/// Host-testable core behind the wasm `Engine`: current document plus live
/// snapshots. Kept here (not in lib.rs) so `cargo test` covers it directly.
pub struct EngineCore {
    pub doc: Document,
    snapshots: HashMap<u32, Document>,
    next_snapshot_id: u32,
    // The open stroke, outside the document for the same reason as the live wires.
    stroke: Option<Stroke>,
    // Magnetic lasso gradient fields, one per open lasso; they are derived from the image, so
    // they live outside the document and never travel into a snapshot.
    livewires: HashMap<u32, LiveWire>,
    next_livewire_id: u32,
}

impl EngineCore {
    pub fn new(doc: Document) -> EngineCore {
        EngineCore {
            doc,
            snapshots: HashMap::new(),
            next_snapshot_id: 0,
            stroke: None,
            livewires: HashMap::new(),
            next_livewire_id: 0,
        }
    }

    /// Magnetic lasso (docs/M2.md section 3): computes the gradient field of the sampled image
    /// once and returns the handle the following `magnetic_path` calls use.
    pub fn magnetic_begin(&mut self, sample_all: bool, layer_id: u32) -> Result<u32, String> {
        self.doc.check_idle()?;
        let src = self.doc.sample_rgba8(sample_all, layer_id)?;
        let lw = LiveWire::new(&src, self.doc.width, self.doc.height);
        let id = self.next_livewire_id;
        self.next_livewire_id += 1;
        self.livewires.insert(id, lw);
        Ok(id)
    }

    /// The live wire from the last anchor to the pointer as flat x, y document pixels.
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
    ) -> Result<Vec<i32>, String> {
        self.doc.check_idle()?;
        let lw = self.livewires.get(&handle).ok_or_else(|| format!("unknown magnetic lasso {handle}"))?;
        Ok(lw.path((x0, y0), (x1, y1), width, contrast).into_iter().flat_map(|(x, y)| [x, y]).collect())
    }

    pub fn magnetic_end(&mut self, handle: u32) -> Result<(), String> {
        self.livewires.remove(&handle).map(|_| ()).ok_or_else(|| format!("unknown magnetic lasso {handle}"))
    }

    /// Opens a stroke (docs/M2.md section 4) on `layer_id`; `target` is "pixels" or "selection"
    /// (quick mask). `params_json` is the brush: sizes in document pixels, angle in degrees,
    /// every other amount a 0..1 fraction.
    pub fn stroke_begin(&mut self, layer_id: u32, target: &str, params_json: &str) -> Result<(), String> {
        self.doc.check_idle()?;
        if self.stroke.is_some() {
            return Err("a stroke is already open".into());
        }
        let target = Target::parse(target)?;
        if target == Target::Mask {
            return Err("a stroke only supports the pixels or selection target".into());
        }
        let p: StrokeIn = serde_json::from_str(params_json).map_err(|e| format!("bad stroke params: {e}"))?;
        if ![p.size, p.opacity, p.flow, p.hardness, p.spacing, p.angle, p.roundness].iter().all(|v| v.is_finite()) {
            return Err("stroke params must be finite".into());
        }
        if p.size <= 0.0 {
            return Err("stroke size must be positive".into());
        }
        let mode = PaintMode::parse(&p.mode)?;
        let shape = TipShape::parse(&p.tip)?;
        let keep_alpha = if target == Target::Pixels {
            self.doc.check_pixel_edit(layer_id)?;
            self.doc.node(layer_id)?.locks.transparency
        } else {
            false
        };
        let hist = match p.erase_to_history {
            None => None,
            Some(id) => {
                if target != Target::Pixels {
                    return Err("erase to history needs the pixels target".into());
                }
                let snap = self.snapshots.get(&id).ok_or_else(|| format!("unknown snapshot {id}"))?;
                let tiles = snap
                    .node(layer_id)
                    .and_then(|n| n.pixel_tiles())
                    .map_err(|_| format!("layer {layer_id} has no pixels in snapshot {id}"))?;
                Some(tiles.clone())
            }
        };
        let sel_was_none = self.doc.selection.is_none();
        if target == Target::Selection && sel_was_none {
            self.doc.selection = Some(SelMask::default());
        }
        self.stroke = Some(Stroke {
            layer: layer_id,
            target,
            mode,
            rgb: [p.rgba[0] as f32 / 255.0, p.rgba[1] as f32 / 255.0, p.rgba[2] as f32 / 255.0],
            value: p.rgba[0] as f32 / 255.0,
            keep_alpha,
            opacity: p.opacity.clamp(0.0, 1.0),
            flow: p.flow.clamp(0.0, 1.0),
            size: p.size,
            hardness: p.hardness,
            angle: p.angle,
            roundness: p.roundness,
            shape,
            aliased: p.aliased,
            wet_edges: p.wet_edges,
            airbrush: p.airbrush,
            pressure_size: p.pressure_size,
            pressure_opacity: p.pressure_opacity,
            step: (p.spacing as f64 * p.size as f64).max(1.0),
            spacer: Spacer::default(),
            hist,
            sel_was_none,
            tiles: HashMap::new(),
        });
        Ok(())
    }

    /// Adds `samples` (flat x, y, pressure triples) to the open stroke and returns the changed
    /// document rect as [x, y, w, h], empty when nothing moved.
    pub fn stroke_to(&mut self, samples: &[f64]) -> Result<Vec<i32>, String> {
        let st = self.stroke.as_mut().ok_or_else(|| "no stroke is open".to_string())?;
        self.doc.stroke_apply(st, samples)
    }

    pub fn stroke_end(&mut self) -> Result<(), String> {
        self.stroke.take().map(|_| ()).ok_or_else(|| "no stroke is open".to_string())
    }

    /// Drops the stroke and puts the stroke-start tiles back, ids included.
    pub fn stroke_cancel(&mut self) -> Result<(), String> {
        let st = self.stroke.take().ok_or_else(|| "no stroke is open".to_string())?;
        if st.target == Target::Pixels {
            let tiles = self.doc.node_mut(st.layer)?.pixel_tiles_mut()?;
            for ((tx, ty), t) in st.tiles {
                tiles.put(tx, ty, t.orig);
            }
        } else if st.sel_was_none {
            self.doc.selection = None;
        } else if let Some(sel) = self.doc.selection.as_mut() {
            for ((tx, ty), t) in st.tiles {
                sel.tiles.put(tx, ty, t.orig);
            }
        }
        Ok(())
    }

    pub fn snapshot(&mut self) -> u32 {
        let id = self.next_snapshot_id;
        self.next_snapshot_id += 1;
        self.snapshots.insert(id, self.doc.clone());
        id
    }

    pub fn restore(&mut self, id: u32) -> Result<(), String> {
        let snap = self.snapshots.get(&id).ok_or_else(|| format!("unknown snapshot {id}"))?;
        // Ids must never go backwards, so they stay unique across restores.
        let next_id = self.doc.next_id.max(snap.next_id);
        let next_node_id = self.doc.next_node_id.max(snap.next_node_id);
        let mut restored = snap.clone();
        restored.next_id = next_id;
        restored.next_node_id = next_node_id;
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
    use serde_json::Value;
    use crate::blend::BLEND_NAMES;

    fn rgba(r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
        let mut v = vec![0u8; TILE_BYTES_U8];
        for px in v.chunks_exact_mut(4) {
            px.copy_from_slice(&[r, g, b, a]);
        }
        v
    }

    fn opaque(r: u8, g: u8, b: u8) -> Vec<u8> {
        rgba(r, g, b, 255)
    }

    fn set(d: &mut Document, id: u32, json: &str) {
        d.set_props(id, json).unwrap();
    }

    // Straight (unpremultiplied) pixel from the composited tile (0, 0).
    fn at(d: &Document, x: usize, y: usize) -> [u8; 4] {
        let f = d.flatten_tile_rgba8(0, 0).unwrap();
        let o = (y * TILE + x) * 4;
        [f[o], f[o + 1], f[o + 2], f[o + 3]]
    }

    fn near(got: [u8; 4], want: [u8; 4]) {
        for i in 0..4 {
            assert!(
                (got[i] as i32 - want[i] as i32).abs() <= 1,
                "channel {i}: got {got:?}, want {want:?}"
            );
        }
    }

    // 256x256 document with an opaque Background (id 1) of the given color.
    fn doc_bg(r: u8, g: u8, b: u8) -> Document {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.fill(1, Target::Pixels, r, g, b, 255).unwrap();
        d
    }

    fn manifest_value(d: &Document) -> Value {
        serde_json::from_str(&d.manifest()).unwrap()
    }

    // The tile id at (tx, ty) of a v3 sparse tile list, or 0 when the tile is absent.
    fn tile_id(list: &Value, tx: i64, ty: i64) -> u64 {
        list.as_array()
            .expect("a sparse tile list")
            .iter()
            .find(|e| e[0].as_i64() == Some(tx) && e[1].as_i64() == Some(ty))
            .map_or(0, |e| e[2].as_u64().expect("a tile id"))
    }

    // ---------- M0 behaviour ----------

    #[test]
    fn new_doc_tile_grid_and_max_level() {
        let d = Document::new(600, 300, 8).unwrap();
        assert_eq!(d.tiles_x(), 3);
        assert_eq!(d.tiles_y(), 2);
        assert_eq!(d.max_level(), 2);
        assert_eq!(d.display_tile(0, 0, 0).unwrap(), None);
        assert_eq!(d.node(1).unwrap().name, "Background");
    }

    #[test]
    fn invalid_dims_rejected() {
        assert!(Document::new(0, 10, 8).is_err());
        assert!(Document::new(10, 65537, 8).is_err());
        assert!(Document::new(10, 10, 12).is_err());
    }

    #[test]
    fn unknown_node_errors() {
        let mut d = Document::new(10, 10, 8).unwrap();
        assert!(d.fill(9, Target::Pixels, 0, 0, 0, 255).is_err());
        assert!(d.invert(0, Target::Pixels).is_err());
        assert!(d.set_props(9, "{}").is_err());
        assert!(d.delete_node(9).is_err());
    }

    #[test]
    fn fill_and_manifest_share_id() {
        let mut d = Document::new(300, 300, 8).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        let px = d.display_tile(0, 0, 0).unwrap().unwrap();
        assert_eq!(&px[0..4], &[255, 0, 0, 255]);
        let list = manifest_value(&d)["layers"][0]["tiles"].clone();
        let ids: Vec<u64> = list.as_array().unwrap().iter().map(|v| v[2].as_u64().unwrap()).collect();
        assert_eq!(ids.len(), 4, "a 300x300 canvas has 2x2 tiles");
        assert!(ids.iter().all(|&id| id == ids[0] && id != 0));
    }

    #[test]
    fn snapshot_isolation_and_id_growth() {
        let mut d = doc_bg(255, 0, 0);
        let snap = d.clone();
        d.invert(1, Target::Pixels).unwrap();
        assert_eq!(at(&d, 0, 0), [0, 255, 255, 255]);
        let mut restored = snap.clone();
        assert_eq!(at(&restored, 0, 0), [255, 0, 0, 255]);
        let ids_before = restored.next_id;
        restored.invert(1, Target::Pixels).unwrap();
        let new_id = tile_id(&manifest_value(&restored)["layers"][0]["tiles"], 0, 0);
        assert!(new_id >= ids_before, "new id {new_id} must be >= every earlier id {ids_before}");
    }

    #[test]
    fn engine_core_restore_keeps_node_ids_growing() {
        let mut e = EngineCore::new(Document::new(256, 256, 8).unwrap());
        let snap = e.snapshot();
        let a = e.doc.add_layer("a", 0).unwrap();
        e.restore(snap).unwrap();
        let b = e.doc.add_layer("b", 0).unwrap();
        assert!(b > a, "node ids must never go backwards ({b} after {a})");
    }

    #[test]
    fn blend_two_layers() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 128).unwrap();
        set(&mut d, top, r#"{"opacity":0.5}"#);
        let px = d.display_tile(0, 0, 0).unwrap().unwrap();
        assert_eq!(&px[0..4], &[255, 191, 191, 255]);
    }

    #[test]
    fn hidden_layer_ignored() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 128).unwrap();
        set(&mut d, top, r#"{"visible":false}"#);
        assert_eq!(at(&d, 0, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn box_filter_checkerboard() {
        let mut d = Document::new(512, 512, 8).unwrap();
        d.set_tile_rgba8(1, 0, 0, &opaque(0, 0, 0)).unwrap();
        d.set_tile_rgba8(1, 1, 1, &opaque(0, 0, 0)).unwrap();
        d.set_tile_rgba8(1, 1, 0, &opaque(255, 255, 255)).unwrap();
        d.set_tile_rgba8(1, 0, 1, &opaque(255, 255, 255)).unwrap();
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
        d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
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
        d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
        d.invert(1, Target::Pixels).unwrap();
        assert_eq!(at(&d, 0, 0), [0, 0, 0, 255]);
        let id = tile_id(&manifest_value(&d)["layers"][0]["tiles"], 0, 0);
        assert_eq!(d.tile_bytes(id).unwrap().len(), TILE_BYTES_U16);
    }

    #[test]
    fn transparent_tile_write_clears_slot() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.set_tile_rgba8(1, 0, 0, &vec![0u8; TILE_BYTES_U8]).unwrap();
        assert!(manifest_value(&d)["layers"][0]["tiles"].as_array().unwrap().is_empty());
    }

    #[test]
    fn flatten_round_trips_straight_alpha() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let mut data = vec![0u8; TILE_BYTES_U8];
        data[0..4].copy_from_slice(&[200, 100, 50, 128]);
        d.set_tile_rgba8(1, 0, 0, &data).unwrap();
        near(at(&d, 0, 0), [200, 100, 50, 128]);
    }

    #[test]
    fn tile_bytes_falls_back_to_live_snapshot() {
        let d = doc_bg(255, 0, 0);
        let old_id = tile_id(&manifest_value(&d)["layers"][0]["tiles"], 0, 0);
        let mut engine = EngineCore::new(d);
        let snap = engine.snapshot();
        engine.doc.invert(1, Target::Pixels).unwrap();
        assert!(engine.doc.tile_bytes(old_id).is_err());
        assert!(engine.tile_bytes(old_id).is_ok());
        engine.drop_snapshot(snap);
        assert!(engine.tile_bytes(old_id).is_err());
    }

    #[test]
    fn tile_bytes_finds_mask_and_nested_tiles() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let g = d.add_group("g", 0).unwrap();
        let child = d.add_layer("child", 0).unwrap();
        d.move_node(child, g, 0).unwrap();
        d.set_tile_rgba8(child, 0, 0, &opaque(1, 2, 3)).unwrap();
        d.add_mask(child, false).unwrap();
        d.set_mask_tile8(child, 0, 0, &vec![200u8; MASK_BYTES_U8]).unwrap();
        let m = manifest_value(&d);
        let pix = tile_id(&m["layers"][1]["children"][0]["tiles"], 0, 0);
        let msk = tile_id(&m["layers"][1]["children"][0]["mask"]["tiles"], 0, 0);
        assert_ne!(pix, 0);
        assert_ne!(msk, 0);
        assert_eq!(d.tile_bytes(pix).unwrap().len(), TILE_BYTES_U8);
        assert_eq!(d.tile_bytes(msk).unwrap().len(), MASK_BYTES_U8);
    }

    // ---------- compositor ----------

    #[test]
    fn compositor_applies_a_blend_mode() {
        // Cb = (0.6, 0.4, 0.2), Cs = (0.2, 0.8, 0.2), multiply -> (0.12, 0.32, 0.04).
        let mut d = doc_bg(153, 102, 51);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 51, 204, 51, 255).unwrap();
        set(&mut d, top, r#"{"blend":"multiply"}"#);
        near(at(&d, 0, 0), [31, 82, 10, 255]);
    }

    #[test]
    fn blend_against_a_transparent_backdrop_is_the_source() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.fill(1, Target::Pixels, 51, 204, 51, 255).unwrap();
        set(&mut d, 1, r#"{"blend":"multiply"}"#);
        near(at(&d, 0, 0), [51, 204, 51, 255]);
    }

    #[test]
    fn pass_through_group_differs_from_an_isolated_group() {
        let mut d = doc_bg(0, 255, 0);
        let g = d.add_group("g", 1).unwrap();
        let c = d.add_layer("c", 0).unwrap();
        d.move_node(c, g, 0).unwrap();
        d.fill(c, Target::Pixels, 255, 0, 0, 255).unwrap();
        set(&mut d, c, r#"{"blend":"multiply"}"#);
        // pass through (the group default): the child multiplies with the green backdrop.
        near(at(&d, 0, 0), [0, 0, 0, 255]);
        set(&mut d, g, r#"{"blend":"normal"}"#);
        // isolated: the child multiplies with transparency, the group lands normally.
        near(at(&d, 0, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn group_opacity_applies_to_both_group_modes() {
        let mut d = doc_bg(255, 255, 255);
        let g = d.add_group("g", 1).unwrap();
        let c = d.add_layer("c", 0).unwrap();
        d.move_node(c, g, 0).unwrap();
        d.fill(c, Target::Pixels, 255, 0, 0, 255).unwrap();
        set(&mut d, g, r#"{"opacity":0.5}"#);
        near(at(&d, 0, 0), [255, 128, 128, 255]);
        set(&mut d, g, r#"{"blend":"normal"}"#);
        near(at(&d, 0, 0), [255, 128, 128, 255]);
    }

    #[test]
    fn layer_mask_hides_pixels_and_can_be_disabled() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
        d.add_mask(top, false).unwrap();
        let mut m = vec![0u8; MASK_BYTES_U8];
        for y in 0..TILE {
            for x in 0..128 {
                m[y * TILE + x] = 255;
            }
        }
        d.set_mask_tile8(top, 0, 0, &m).unwrap();
        near(at(&d, 0, 0), [255, 0, 0, 255]);
        near(at(&d, 200, 0), [255, 255, 255, 255]);
        set(&mut d, top, r#"{"mask_enabled":false}"#);
        near(at(&d, 200, 0), [255, 0, 0, 255]);
    }

    #[test]
    fn mask_default_covers_missing_tiles() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
        d.add_mask(top, false).unwrap();
        near(at(&d, 10, 10), [255, 255, 255, 255]);
        d.delete_mask(top).unwrap();
        d.add_mask(top, true).unwrap();
        near(at(&d, 10, 10), [255, 0, 0, 255]);
    }

    #[test]
    fn mask_invert_flips_default_and_tiles() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
        d.add_mask(top, false).unwrap();
        d.invert(top, Target::Mask).unwrap();
        assert_eq!(d.node(top).unwrap().mask.as_ref().unwrap().default, 255);
        near(at(&d, 10, 10), [255, 0, 0, 255]);
    }

    #[test]
    fn mask_fill_uses_the_red_channel() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
        d.add_mask(top, true).unwrap();
        d.fill(top, Target::Mask, 128, 9, 9, 9).unwrap();
        near(at(&d, 10, 10), [255, 127, 127, 255]);
    }

    // ---------- clipping groups ----------

    fn clip_doc() -> (Document, u32, u32) {
        let mut d = doc_bg(255, 255, 255);
        let base = d.add_layer("base", 1).unwrap();
        let mut half = vec![0u8; TILE_BYTES_U8];
        for y in 0..TILE {
            for x in 0..128 {
                let o = (y * TILE + x) * 4;
                half[o..o + 4].copy_from_slice(&[255, 0, 0, 255]);
            }
        }
        d.set_tile_rgba8(base, 0, 0, &half).unwrap();
        let clip = d.add_layer("clip", base).unwrap();
        d.fill(clip, Target::Pixels, 0, 0, 255, 255).unwrap();
        set(&mut d, clip, r#"{"clipping":true}"#);
        (d, base, clip)
    }

    #[test]
    fn clipped_layer_is_limited_by_the_base_alpha() {
        let (d, _, _) = clip_doc();
        near(at(&d, 10, 10), [0, 0, 255, 255]);
        near(at(&d, 200, 10), [255, 255, 255, 255]);
    }

    #[test]
    fn base_opacity_applies_to_the_whole_clipping_group() {
        let (mut d, base, _) = clip_doc();
        set(&mut d, base, r#"{"opacity":0.5}"#);
        near(at(&d, 10, 10), [128, 128, 255, 255]);
        near(at(&d, 200, 10), [255, 255, 255, 255]);
    }

    #[test]
    fn a_hidden_base_hides_its_clipped_layers() {
        let (mut d, base, _) = clip_doc();
        set(&mut d, base, r#"{"visible":false}"#);
        near(at(&d, 10, 10), [255, 255, 255, 255]);
    }

    #[test]
    fn clipping_on_the_lowest_node_is_ignored() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        set(&mut d, 1, r#"{"clipping":true}"#);
        near(at(&d, 10, 10), [255, 0, 0, 255]);
    }

    #[test]
    fn base_fill_applies_inside_the_group() {
        // Base fill fades the base inside G; a half transparent clipped layer lets it show.
        let (mut d, base, clip) = clip_doc();
        set(&mut d, clip, r#"{"clipping":true,"opacity":0.5}"#);
        near(at(&d, 10, 10), [128, 0, 128, 255]);
        set(&mut d, base, r#"{"fill":0.5}"#);
        near(at(&d, 10, 10), [128, 64, 191, 255]);
    }

    // Clipped layers paint source-atop: full color over a soft base edge, base alpha kept (corpus clipping-mask.psd).
    #[test]
    fn clipped_layer_paints_atop_a_soft_base_edge() {
        let (mut d, base, _) = clip_doc();
        d.fill(base, Target::Pixels, 255, 0, 0, 128).unwrap();
        near(at(&d, 10, 10), [127, 127, 255, 255]);
    }

    // Background, a pass-through group holding one filled layer, and an empty clipped layer above the group.
    fn pass_base(bg: [u8; 3], child: [u8; 4], blend: &str) -> (Document, u32, u32) {
        let mut d = doc_bg(bg[0], bg[1], bg[2]);
        let g = d.add_group("g", 1).unwrap();
        let c = d.add_layer("c", 0).unwrap();
        d.move_node(c, g, 0).unwrap();
        d.fill(c, Target::Pixels, child[0], child[1], child[2], child[3]).unwrap();
        set(&mut d, c, &format!(r#"{{"blend":"{blend}"}}"#));
        let clip = d.add_layer("clip", g).unwrap();
        set(&mut d, clip, r#"{"clipping":true}"#);
        (d, g, clip)
    }

    // A pass-through base stays non-isolated: its children still blend with the backdrop.
    #[test]
    fn pass_through_clipping_base_stays_in_place() {
        let (d, _, _) = pass_base([125, 125, 125], [255, 0, 0, 255], "linear dodge");
        near(at(&d, 10, 10), [255, 125, 125, 255]);
    }

    // The clipped layer replaces only the base's share of the pixel; the backdrop share stays.
    #[test]
    fn clipped_layer_over_pass_through_base_recolors_only_the_base_share() {
        let (mut d, _, clip) = pass_base([255, 255, 255], [255, 0, 0, 128], "normal");
        d.fill(clip, Target::Pixels, 0, 255, 0, 255).unwrap();
        near(at(&d, 10, 10), [127, 255, 127, 255]);
    }

    // The clipped layer blends with the in-place result (cyan from exclusion), not with the isolated base (red).
    #[test]
    fn clipped_layer_over_pass_through_base_blends_with_the_in_place_color() {
        let (mut d, _, clip) = pass_base([255, 255, 255], [255, 0, 0, 255], "exclusion");
        d.fill(clip, Target::Pixels, 0, 255, 0, 255).unwrap();
        set(&mut d, clip, r#"{"blend":"lighter color"}"#);
        near(at(&d, 10, 10), [0, 255, 255, 255]);
    }

    // Group fill fades the group like opacity (corpus passthrough_fill_blendmode.psd).
    #[test]
    fn group_fill_fades_like_opacity() {
        for mode in ["pass through", "normal"] {
            let (mut d, g, clip) = pass_base([255, 255, 255], [255, 0, 0, 255], "normal");
            d.delete_node(clip).unwrap();
            set(&mut d, g, &format!(r#"{{"blend":"{mode}","fill":0.5}}"#));
            near(at(&d, 10, 10), [255, 127, 127, 255]);
        }
    }

    // ---------- dissolve, fill, depth ----------

    #[test]
    fn dissolve_is_deterministic_and_binary() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
        set(&mut d, top, r#"{"blend":"dissolve","opacity":0.5}"#);
        let a = d.flatten_tile_rgba8(0, 0).unwrap();
        let b = d.flatten_tile_rgba8(0, 0).unwrap();
        assert_eq!(a, b, "dissolve must be stable across renders");
        let mut red = 0;
        for p in 0..TILE_PIXELS {
            let px = [a[p * 4], a[p * 4 + 1], a[p * 4 + 2]];
            assert!(px == [255, 0, 0] || px == [255, 255, 255], "pixel {p} is {px:?}");
            if px == [255, 0, 0] {
                red += 1;
            }
        }
        let share = red as f32 / TILE_PIXELS as f32;
        assert!((share - 0.5).abs() < 0.05, "share {share}");
    }

    #[test]
    fn fill_and_opacity_both_multiply_coverage() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
        set(&mut d, top, r#"{"opacity":0.5,"fill":0.5}"#);
        let both = at(&d, 0, 0);
        set(&mut d, top, r#"{"opacity":0.25,"fill":1.0}"#);
        near(both, at(&d, 0, 0));
        near(both, [255, 191, 191, 255]);
    }

    #[test]
    fn depth16_blend_matches_the_8_bit_result() {
        let mut d = Document::new(256, 256, 16).unwrap();
        d.fill(1, Target::Pixels, 153, 102, 51, 255).unwrap();
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 51, 204, 51, 255).unwrap();
        set(&mut d, top, r#"{"blend":"multiply"}"#);
        near(at(&d, 0, 0), [31, 82, 10, 255]);
    }

    // ---------- locks ----------

    #[test]
    fn pixel_lock_blocks_fill_and_invert() {
        let mut d = doc_bg(255, 0, 0);
        set(&mut d, 1, r#"{"locks":{"pixels":true}}"#);
        assert_eq!(
            d.fill(1, Target::Pixels, 0, 0, 0, 255).unwrap_err(),
            "layer pixels are locked"
        );
        assert_eq!(d.invert(1, Target::Pixels).unwrap_err(), "layer pixels are locked");
    }

    #[test]
    fn transparency_lock_keeps_alpha_and_empty_tiles() {
        let mut d = Document::new(512, 256, 8).unwrap();
        let mut data = vec![0u8; TILE_BYTES_U8];
        data[0..8].copy_from_slice(&[10, 20, 30, 128, 0, 0, 0, 0]);
        d.set_tile_rgba8(1, 0, 0, &data).unwrap();
        set(&mut d, 1, r#"{"locks":{"transparency":true}}"#);
        d.fill(1, Target::Pixels, 0, 255, 0, 255).unwrap();
        near(at(&d, 0, 0), [0, 255, 0, 128]);
        assert_eq!(at(&d, 1, 0)[3], 0, "an empty pixel stays empty");
        let ids = manifest_value(&d)["layers"][0]["tiles"].clone();
        assert_eq!(tile_id(&ids, 1, 0), 0, "the empty tile stays empty");
    }

    // ---------- commands ----------

    #[test]
    fn add_layer_inserts_above_a_node_or_on_top() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let a = d.add_layer("a", 0).unwrap();
        let b = d.add_layer("b", 1).unwrap();
        let order: Vec<u32> = d.nodes.iter().map(|n| n.id).collect();
        assert_eq!(order, vec![1, b, a]);
        assert!(d.add_layer("x", 999).is_err());
        assert!(d.add_group("g", 999).is_err());
    }

    #[test]
    fn group_nodes_and_ungroup_keep_order() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let a = d.add_layer("a", 0).unwrap();
        let b = d.add_layer("b", 0).unwrap();
        let g = d.group_nodes(&[1, b]).unwrap();
        assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![a, g]);
        let children = match &d.node(g).unwrap().kind {
            Kind::Group(ch) => ch.iter().map(|n| n.id).collect::<Vec<_>>(),
            _ => panic!("group"),
        };
        assert_eq!(children, vec![1, b]);
        d.ungroup(g).unwrap();
        assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![a, 1, b]);
        assert!(d.ungroup(1).is_err(), "a pixel layer cannot be ungrouped");
    }

    #[test]
    fn group_nodes_needs_one_parent() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let g = d.add_group("g", 0).unwrap();
        let c = d.add_layer("c", 0).unwrap();
        d.move_node(c, g, 0).unwrap();
        assert!(d.group_nodes(&[1, c]).is_err());
        assert!(d.group_nodes(&[]).is_err());
        assert!(d.group_nodes(&[1, 1]).is_err());
    }

    #[test]
    fn delete_node_keeps_one_root_node() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let a = d.add_layer("a", 0).unwrap();
        d.delete_node(a).unwrap();
        assert_eq!(d.delete_node(1).unwrap_err(), "the document must keep at least one root node");
    }

    #[test]
    fn duplicate_node_copies_the_subtree_and_shares_tiles() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let g = d.add_group("g", 0).unwrap();
        let c = d.add_layer("c", 0).unwrap();
        d.move_node(c, g, 0).unwrap();
        d.set_tile_rgba8(c, 0, 0, &opaque(1, 2, 3)).unwrap();
        let copy = d.duplicate_node(g).unwrap();
        assert_ne!(copy, g);
        assert_eq!(d.node(copy).unwrap().name, "g copy");
        let m = manifest_value(&d);
        let src = tile_id(&m["layers"][1]["children"][0]["tiles"], 0, 0);
        let dup = tile_id(&m["layers"][2]["children"][0]["tiles"], 0, 0);
        assert_eq!(src, dup, "duplicated layers share their tiles");
        let dup_id = m["layers"][2]["children"][0]["id"].as_u64().unwrap() as u32;
        assert_ne!(dup_id, c, "every copied node gets a new id");
    }

    #[test]
    fn move_node_rejects_itself_its_descendants_and_bad_targets() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let g = d.add_group("g", 0).unwrap();
        let inner = d.add_group("inner", 0).unwrap();
        d.move_node(inner, g, 0).unwrap();
        assert!(d.move_node(g, g, 0).is_err());
        assert!(d.move_node(g, inner, 0).is_err(), "cannot move into a descendant");
        assert!(d.move_node(g, 1, 0).is_err(), "a pixel layer is not a group");
        assert!(d.move_node(g, 0, 9).is_err(), "index out of range");
        d.move_node(g, 0, 0).unwrap();
        assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![g, 1]);
    }

    #[test]
    fn move_node_keeps_at_least_one_root_node() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let g = d.add_group("g", 0).unwrap();
        d.move_node(1, g, 0).unwrap();
        assert_eq!(d.nodes.len(), 1);
        let inner = d.node(g).unwrap();
        assert!(matches!(&inner.kind, Kind::Group(ch) if ch.len() == 1));
        assert!(d.move_node(g, 0, 0).is_ok());
        let mut d2 = Document::new(256, 256, 8).unwrap();
        let g2 = d2.add_group("g", 0).unwrap();
        d2.delete_node(g2).unwrap();
        let g3 = d2.add_group("g", 0).unwrap();
        d2.move_node(1, g3, 0).unwrap();
        assert!(d2.move_node(g3, g3, 0).is_err());
    }

    #[test]
    fn set_props_validates_its_input() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let g = d.add_group("g", 0).unwrap();
        assert!(d.set_props(1, r#"{"blend":"pass through"}"#).is_err());
        d.set_props(g, r#"{"blend":"pass through"}"#).unwrap();
        assert!(d.set_props(1, r#"{"opacity":1.5}"#).is_err());
        assert!(d.set_props(1, r#"{"fill":-0.1}"#).is_err());
        assert!(d.set_props(1, r#"{"blend":"glow"}"#).is_err());
        assert!(d.set_props(1, r#"{"nope":1}"#).is_err());
        assert!(d.set_props(1, r#"{"mask_enabled":true}"#).is_err());
        assert!(d.set_props(g, r#"{"fill":1.5}"#).is_err());
        d.set_props(1, r#"{"name":"bg","visible":false,"locks":{"position":true}}"#).unwrap();
        let n = d.node(1).unwrap();
        assert_eq!(n.name, "bg");
        assert!(!n.visible);
        assert!(n.locks.position && !n.locks.pixels);
    }

    #[test]
    fn mask_commands_report_conflicts() {
        let mut d = Document::new(256, 256, 8).unwrap();
        assert!(d.delete_mask(1).is_err());
        assert!(d.invert(1, Target::Mask).is_err());
        assert!(d.fill(1, Target::Mask, 1, 1, 1, 1).is_err());
        assert!(d.set_mask_tile8(1, 0, 0, &vec![0u8; MASK_BYTES_U8]).is_err());
        d.add_mask(1, true).unwrap();
        assert!(d.add_mask(1, true).is_err());
        d.delete_mask(1).unwrap();
    }

    #[test]
    fn pixel_commands_reject_groups_and_bad_targets() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let g = d.add_group("g", 0).unwrap();
        assert!(d.fill(g, Target::Pixels, 0, 0, 0, 255).is_err());
        assert!(d.invert(g, Target::Pixels).is_err());
        assert!(d.set_tile_rgba8(g, 0, 0, &opaque(1, 1, 1)).is_err());
        assert!(d.set_tile_rgba8(1, 5, 0, &opaque(1, 1, 1)).is_err());
        assert!(d.set_tile_rgba8(1, 0, 0, &[0u8; 8]).is_err());
        assert!(Target::parse("pixels").is_ok());
        assert!(Target::parse("mask").is_ok());
        assert!(Target::parse("alpha").is_err());
    }

    #[test]
    fn layers_json_is_the_tree_without_tiles() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let g = d.add_group("g", 0).unwrap();
        let c = d.add_layer("c", 0).unwrap();
        d.move_node(c, g, 0).unwrap();
        d.add_mask(c, true).unwrap();
        let v: Value = serde_json::from_str(&d.layers_json()).unwrap();
        assert_eq!(v[0]["id"].as_u64().unwrap(), 1);
        assert_eq!(v[0]["kind"], "pixel");
        assert!(v[0]["tiles"].is_null(), "the UI tree carries no tile ids");
        assert_eq!(v[1]["kind"], "group");
        assert_eq!(v[1]["blend"], "pass through");
        let child = &v[1]["children"][0];
        assert_eq!(child["id"].as_u64().unwrap() as u32, c);
        assert_eq!(child["mask"]["enabled"], true);
        assert_eq!(child["mask"]["default"].as_u64().unwrap(), 255);
        assert!(child["mask"]["tiles"].is_null());
    }

    // ---------- persistence ----------

    fn collect_ids(v: &Value, ids: &mut HashSet<u64>) {
        for list in [&v["tiles"], &v["mask"]["tiles"]] {
            if let Some(a) = list.as_array() {
                ids.extend(a.iter().filter_map(|e| e[2].as_u64()));
            }
        }
        if let Some(ch) = v["children"].as_array() {
            for c in ch {
                collect_ids(c, ids);
            }
        }
    }

    // Every tile id a v3 manifest references: layers, masks, both selections and the channels.
    fn all_ids(m: &Value) -> HashSet<u64> {
        let mut ids: HashSet<u64> = HashSet::new();
        for n in m["layers"].as_array().expect("layers") {
            collect_ids(n, &mut ids);
        }
        let mut sel = |v: &Value| {
            if let Some(a) = v["tiles"].as_array() {
                ids.extend(a.iter().filter_map(|e| e[2].as_u64()));
            }
        };
        sel(&m["selection"]);
        sel(&m["last_selection"]);
        for c in m["channels"].as_array().expect("channels") {
            sel(c);
        }
        ids
    }

    fn loaded_copy(d: &Document) -> Document {
        let manifest = d.manifest();
        let mut l = Document::from_manifest(&manifest).unwrap();
        let m: Value = serde_json::from_str(&manifest).unwrap();
        let ids = all_ids(&m);
        assert!(l.finish_load().is_err(), "loading is not done before every tile arrived");
        for id in ids {
            l.put_tile(id, &d.tile_bytes(id).unwrap()).unwrap();
        }
        l.finish_load().unwrap();
        assert_eq!(l.manifest(), manifest, "a v3 manifest must round trip byte for byte");
        l
    }

    fn rich_doc() -> Document {
        let mut d = Document::new(600, 300, 8).unwrap();
        d.fill(1, Target::Pixels, 10, 20, 30, 255).unwrap();
        let g = d.add_group("g", 1).unwrap();
        let c = d.add_layer("c", 0).unwrap();
        d.move_node(c, g, 0).unwrap();
        d.set_tile_rgba8(c, 1, 1, &opaque(9, 9, 9)).unwrap();
        d.invert(c, Target::Pixels).unwrap();
        d.add_mask(c, false).unwrap();
        d.set_mask_tile8(c, 1, 1, &vec![180u8; MASK_BYTES_U8]).unwrap();
        set(&mut d, c, r#"{"blend":"soft light","opacity":0.75,"fill":0.5,"locks":{"position":true}}"#);
        set(&mut d, g, r#"{"opacity":0.9}"#);
        d
    }

    #[test]
    fn round_trip_manifest_and_tiles() {
        let d = rich_doc();
        let l = loaded_copy(&d);
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                assert_eq!(l.display_tile(0, tx, ty).unwrap(), d.display_tile(0, tx, ty).unwrap());
            }
        }
    }

    #[test]
    fn v1_manifest_loads_as_pixel_nodes() {
        let mut old = Document::new(256, 256, 8).unwrap();
        old.fill(1, Target::Pixels, 7, 8, 9, 255).unwrap();
        let tile_id = tile_id(&manifest_value(&old)["layers"][0]["tiles"], 0, 0);
        let v1 = format!(
            r#"{{"format":"photobaer-manifest","version":1,"width":256,"height":256,"depth":8,"tiles_x":1,"tiles_y":1,"next_id":{},"layers":[{{"name":"bg","visible":true,"opacity":1.0,"tiles":[{tile_id}]}},{{"name":"top","visible":false,"opacity":0.5,"tiles":[0]}}]}}"#,
            tile_id + 1
        );
        let mut d = Document::from_manifest(&v1).unwrap();
        d.put_tile(tile_id, &old.tile_bytes(tile_id).unwrap()).unwrap();
        d.finish_load().unwrap();
        assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![1, 2]);
        let n = d.node(2).unwrap();
        assert_eq!(n.name, "top");
        assert!(!n.visible);
        assert_eq!(n.blend, Blend::Normal);
        assert_eq!(n.fill, 1.0);
        assert!(n.mask.is_none());
        assert_eq!(n.locks, Locks::default());
        assert_eq!(at(&d, 0, 0), [7, 8, 9, 255]);
        let m = manifest_value(&d);
        assert_eq!(m["version"].as_u64().unwrap(), 3);
        assert_eq!(m["next_node_id"].as_u64().unwrap(), 3);
    }

    #[test]
    fn v1_rejections_still_apply() {
        let bad = r#"{"format":"photobaer-manifest","version":1,"width":256,"height":256,"depth":8,"tiles_x":1,"tiles_y":1,"next_id":2,"layers":[{"name":"bg","visible":true,"opacity":1.0,"tiles":[1,2]}]}"#;
        assert!(Document::from_manifest(bad).is_err());
        let empty = r#"{"format":"photobaer-manifest","version":1,"width":256,"height":256,"depth":8,"tiles_x":1,"tiles_y":1,"next_id":1,"layers":[]}"#;
        assert!(Document::from_manifest(empty).is_err());
        let wrong = r#"{"format":"other","version":1,"width":256,"height":256,"depth":8,"tiles_x":1,"tiles_y":1,"next_id":1,"layers":[]}"#;
        assert!(Document::from_manifest(wrong).is_err());
    }

    #[test]
    fn manifest_ids_beyond_js_safe_integers_are_rejected() {
        let d = Document::new(256, 256, 8).unwrap();
        let big = format!("{}", 1u64 << 60);
        let json = d.manifest().replacen(&format!("\"next_id\":{}", d.next_id), &format!("\"next_id\":{big}"), 1);
        assert!(json.contains(&big));
        assert!(Document::from_manifest(&json).is_err());
        let json = d.manifest().replacen("\"tiles\":[]", &format!("\"tiles\":[[0,0,{big}]]"), 1);
        assert!(json.contains(&big));
        assert!(Document::from_manifest(&json).is_err());
    }

    #[test]
    fn loaded_empty_manifest_with_next_id_zero_still_allocates_nonzero_ids() {
        let d = Document::new(256, 256, 8).unwrap();
        let json = d.manifest().replacen(&format!("\"next_id\":{}", d.next_id), "\"next_id\":0", 1);
        let mut l = Document::from_manifest(&json).unwrap();
        l.finish_load().unwrap();
        l.fill(1, Target::Pixels, 1, 2, 3, 255).unwrap();
        assert_ne!(tile_id(&manifest_value(&l)["layers"][0]["tiles"], 0, 0), 0);
    }

    fn broken(f: impl Fn(&mut Value)) -> String {
        let d = rich_doc();
        let mut v: Value = serde_json::from_str(&d.manifest()).unwrap();
        f(&mut v);
        v.to_string()
    }

    #[test]
    fn manifest_rejections() {
        let cases: Vec<(&str, String)> = vec![
            ("duplicate node id", broken(|v| v["layers"][1]["id"] = 1.into())),
            ("node id 0", broken(|v| v["layers"][0]["id"] = 0.into())),
            ("next_node_id too small", broken(|v| v["next_node_id"] = 1.into())),
            ("unknown blend", broken(|v| v["layers"][0]["blend"] = "glow".into())),
            ("pass through on a pixel node", broken(|v| v["layers"][0]["blend"] = "pass through".into())),
            ("tile id 0", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([[0, 0, 0]]))),
            ("duplicate tile coordinate", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([[1, 1, 5], [1, 1, 6]]))),
            ("tile coordinate out of range", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([[1 << 21, 0, 5]]))),
            ("malformed tile entry", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([[1, 2]]))),
            ("group with tiles", broken(|v| v["layers"][1]["tiles"] = serde_json::json!([[0, 0, 7]]))),
            ("pixel node with children", broken(|v| v["layers"][0]["children"] = serde_json::json!([]))),
            ("unknown kind", broken(|v| v["layers"][0]["kind"] = "text".into())),
            ("opacity out of range", broken(|v| v["layers"][0]["opacity"] = 2.into())),
            ("unknown field", broken(|v| v["layers"][0]["extra"] = 1.into())),
            ("unsupported version", broken(|v| v["version"] = 4.into())),
            ("tiles_x mismatch", broken(|v| v["tiles_x"] = 9.into())),
        ];
        for (what, json) in cases {
            assert!(Document::from_manifest(&json).is_err(), "{what} must be rejected");
        }
        let d = rich_doc();
        let m: Value = serde_json::from_str(&d.manifest()).unwrap();
        let pixel_id = tile_id(&m["layers"][1]["children"][0]["tiles"], 1, 1);
        let json = broken(|v| {
            let mask = v["layers"][1]["children"][0]["mask"]["tiles"].as_array_mut().unwrap();
            mask[0][2] = pixel_id.into();
        });
        assert!(
            matches!(Document::from_manifest(&json), Err(e) if e.contains("both pixel and mask")),
            "a tile id must not be used as both pixel and mask data"
        );
        let mut l = Document::from_manifest(&d.manifest()).unwrap();
        assert!(l.put_tile(pixel_id, &vec![0u8; MASK_BYTES_U8]).is_err());
        let mask_id = tile_id(&m["layers"][1]["children"][0]["mask"]["tiles"], 1, 1);
        assert!(l.put_tile(mask_id, &vec![0u8; TILE_BYTES_U8]).is_err());
        l.put_tile(mask_id, &vec![7u8; MASK_BYTES_U8]).unwrap();
        assert!(l.put_tile(999_999, &vec![7u8; MASK_BYTES_U8]).is_err());
    }

    #[test]
    fn commands_are_refused_while_the_document_is_loading() {
        let d = rich_doc();
        let manifest = d.manifest();
        let m: Value = serde_json::from_str(&manifest).unwrap();
        let ids = all_ids(&m);
        let mut l = Document::from_manifest(&manifest).unwrap();
        let group = l.nodes[1].id;
        let child = match &l.nodes[1].kind {
            Kind::Group(ch) => ch[0].id,
            _ => panic!("group"),
        };
        for (what, r) in [
            ("add_layer", l.add_layer("x", 0).map(|_| ())),
            ("add_group", l.add_group("x", 0).map(|_| ())),
            ("group_nodes", l.group_nodes(&[1]).map(|_| ())),
            ("ungroup", l.ungroup(group)),
            ("delete_node", l.delete_node(1)),
            ("duplicate_node", l.duplicate_node(1).map(|_| ())),
            ("move_node", l.move_node(1, group, 0)),
            ("set_props", l.set_props(1, r#"{"visible":false}"#)),
            ("add_mask", l.add_mask(1, true)),
            ("delete_mask", l.delete_mask(child)),
            ("fill pixels", l.fill(1, Target::Pixels, 1, 2, 3, 255)),
            ("fill mask", l.fill(child, Target::Mask, 1, 2, 3, 255)),
            ("invert pixels", l.invert(1, Target::Pixels)),
            ("invert mask", l.invert(child, Target::Mask)),
            ("set_tile_rgba8", l.set_tile_rgba8(1, 0, 0, &opaque(1, 2, 3))),
            ("set_mask_tile8", l.set_mask_tile8(child, 0, 0, &vec![1u8; MASK_BYTES_U8])),
        ] {
            assert_eq!(r.unwrap_err(), "document is still loading", "{what} must be refused");
        }
        for id in ids {
            l.put_tile(id, &d.tile_bytes(id).unwrap()).unwrap();
        }
        l.finish_load().unwrap();
        assert_eq!(l.manifest(), manifest, "the tree survives a refused command");
        l.set_props(1, r#"{"visible":false}"#).unwrap();
    }

    // ---------- pyramid, display levels and draw program ----------

    fn pattern(seed: u32, tx: u32, ty: u32) -> Vec<u8> {
        let mut v = vec![0u8; TILE_BYTES_U8];
        let s = seed as usize;
        for y in 0..TILE {
            for x in 0..TILE {
                let gx = tx as usize * TILE + x;
                let gy = ty as usize * TILE + y;
                let o = (y * TILE + x) * 4;
                v[o] = (gx * 3 + s * 17) as u8;
                v[o + 1] = (gy * 5 + s * 29) as u8;
                v[o + 2] = ((gx ^ gy) as u8) ^ (s as u8);
                v[o + 3] = (((gx / 7 + gy / 5 + s) % 5) * 60) as u8;
            }
        }
        v
    }

    fn mask_pattern(seed: u32, tx: u32, ty: u32) -> Vec<u8> {
        let mut v = vec![0u8; MASK_BYTES_U8];
        let s = seed as usize;
        for y in 0..TILE {
            for x in 0..TILE {
                let gx = tx as usize * TILE + x;
                let gy = ty as usize * TILE + y;
                v[y * TILE + x] = (gx * 2 + gy * 3 + s * 11) as u8;
            }
        }
        v
    }

    fn paint(d: &mut Document, id: u32, seed: u32) {
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                d.set_tile_rgba8(id, tx, ty, &pattern(seed, tx, ty)).unwrap();
            }
        }
    }

    // A mask with a painted first tile and the reveal default everywhere else.
    fn paint_mask(d: &mut Document, id: u32, seed: u32) {
        d.add_mask(id, true).unwrap();
        d.set_mask_tile8(id, 0, 0, &mask_pattern(seed, 0, 0)).unwrap();
        let (tx, ty) = (d.tiles_x() - 1, d.tiles_y() - 1);
        d.set_mask_tile8(id, tx, ty, &mask_pattern(seed, tx, ty)).unwrap();
    }

    fn add_painted(d: &mut Document, above: &mut u32, name: &str, seed: u32) -> u32 {
        let id = d.add_layer(name, *above).unwrap();
        paint(d, id, seed);
        *above = id;
        id
    }

    // Every blend mode, dissolve, masks, nested groups, a pass-through group with
    // fill < 1, and clipping groups with a pixel, group, pass-through and hidden base.
    fn program_doc() -> Document {
        let mut d = Document::new(600, 300, 8).unwrap();
        paint(&mut d, 1, 1);
        // clipping on the lowest node is ignored
        set(&mut d, 1, r#"{"clipping":true}"#);
        let mut above = 1;
        for (i, (_, name)) in BLEND_NAMES.iter().enumerate() {
            if *name == "pass through" {
                continue;
            }
            let id = add_painted(&mut d, &mut above, name, i as u32 + 2);
            set(&mut d, id, &format!(r#"{{"blend":"{name}","opacity":0.7,"fill":0.9}}"#));
        }

        let a = add_painted(&mut d, &mut above, "ga", 40);
        let b = add_painted(&mut d, &mut above, "gb", 41);
        set(&mut d, b, r#"{"blend":"screen"}"#);
        let g = d.group_nodes(&[a, b]).unwrap();
        set(&mut d, g, r#"{"blend":"multiply","opacity":0.8,"fill":0.6}"#);
        paint_mask(&mut d, g, 7);
        above = g;

        let n1 = add_painted(&mut d, &mut above, "n1", 42);
        let n2 = add_painted(&mut d, &mut above, "n2", 43);
        let inner = d.group_nodes(&[n2]).unwrap();
        set(&mut d, inner, r#"{"blend":"normal","opacity":0.9}"#);
        let outer = d.group_nodes(&[n1, inner]).unwrap();
        set(&mut d, outer, r#"{"blend":"pass through","opacity":0.8,"fill":0.5}"#);
        paint_mask(&mut d, outer, 8);
        above = outer;

        let pb = add_painted(&mut d, &mut above, "pixbase", 50);
        set(&mut d, pb, r#"{"blend":"overlay","opacity":0.9,"fill":0.8}"#);
        paint_mask(&mut d, pb, 9);
        let pc1 = add_painted(&mut d, &mut above, "clip1", 51);
        set(&mut d, pc1, r#"{"clipping":true,"blend":"multiply","opacity":0.8,"fill":0.7}"#);
        let pc2 = add_painted(&mut d, &mut above, "clip2", 52);
        set(&mut d, pc2, r#"{"clipping":true}"#);
        paint_mask(&mut d, pc2, 10);

        let gb1 = add_painted(&mut d, &mut above, "gb1", 53);
        let gb2 = add_painted(&mut d, &mut above, "gb2", 54);
        let gbase = d.group_nodes(&[gb1, gb2]).unwrap();
        set(&mut d, gbase, r#"{"blend":"hard light","opacity":0.9,"fill":0.7}"#);
        paint_mask(&mut d, gbase, 11);
        above = gbase;
        let gc = add_painted(&mut d, &mut above, "gclip", 55);
        set(&mut d, gc, r#"{"clipping":true,"blend":"color dodge"}"#);

        let pt1 = add_painted(&mut d, &mut above, "pt1", 56);
        let ptbase = d.group_nodes(&[pt1]).unwrap();
        set(&mut d, ptbase, r#"{"blend":"pass through","opacity":0.8,"fill":0.6}"#);
        paint_mask(&mut d, ptbase, 12);
        above = ptbase;
        let ptc = add_painted(&mut d, &mut above, "ptclip", 57);
        set(&mut d, ptc, r#"{"clipping":true,"blend":"difference","opacity":0.9}"#);

        let hb = add_painted(&mut d, &mut above, "hidden", 58);
        set(&mut d, hb, r#"{"visible":false}"#);
        let hc = add_painted(&mut d, &mut above, "hidclip", 59);
        set(&mut d, hc, r#"{"clipping":true}"#);
        d
    }

    fn fnv(bytes: &[u8], mut h: u64) -> u64 {
        for b in bytes {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
        h
    }

    fn scene_checksum(d: &Document) -> u64 {
        let mut h = 0xcbf2_9ce4_8422_2325u64;
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                h = fnv(&d.flatten_tile_rgba8(tx, ty).unwrap(), h);
                h = match d.display_tile(0, tx, ty).unwrap() {
                    Some(b) => fnv(&b, h),
                    None => fnv(&[0], h),
                };
            }
        }
        h
    }

    // Four source pixels at the top-left corner; the rest of the tile stays transparent.
    fn corner_doc() -> Document {
        let mut d = Document::new(1024, 1024, 8).unwrap();
        let mut t = vec![0u8; TILE_BYTES_U8];
        t[4..8].copy_from_slice(&[200, 100, 50, 255]);
        let row = TILE * 4;
        t[row..row + 4].copy_from_slice(&[100, 255, 0, 128]);
        t[row + 4..row + 8].copy_from_slice(&[40, 60, 80, 64]);
        d.set_tile_rgba8(1, 0, 0, &t).unwrap();
        d
    }

    #[test]
    fn pyramid_box_averages_premultiplied() {
        let d = corner_doc();
        // (0,0,0,0), (200,100,50,255), (100,255,0,128), (40,60,80,64):
        // premultiplied sums 66360 / 61980 / 17870 over alpha sum 447, alpha 447/4.
        let l1 = d.level_tile_bytes(1, false, 1, 0, 0).unwrap();
        assert_eq!(&l1[0..4], &[148, 139, 40, 112]);
        assert_eq!(&l1[4..8], &[0, 0, 0, 0], "the neighbouring 2x2 block is empty");
        // Level 2 averages one opaque-ish sample with three empty ones: color kept, alpha / 4.
        let l2 = d.level_tile_bytes(1, false, 2, 0, 0).unwrap();
        assert_eq!(&l2[0..4], &[148, 139, 40, 28]);
        assert!(d.level_tile_bytes(1, false, 1, 1, 0).is_none(), "an all-empty 2x2 stays None");
    }

    #[test]
    fn pyramid_masks_average_and_keep_the_default() {
        let mut d = corner_doc();
        d.add_mask(1, true).unwrap();
        let mut m = vec![0u8; MASK_BYTES_U8];
        m[1] = 100;
        m[TILE] = 200;
        m[TILE + 1] = 255;
        d.set_mask_tile8(1, 0, 0, &m).unwrap();
        let l1 = d.level_tile_bytes(1, true, 1, 0, 0).unwrap();
        assert_eq!(l1[0], 139, "(0 + 100 + 200 + 255) / 4");
        assert_eq!(l1[1], 0);
        assert!(d.level_tile_bytes(1, true, 1, 1, 0).is_none(), "a missing mask tile stays the default");
    }

    #[test]
    fn pyramid_follows_edits_and_snapshot_restore() {
        let mut d = Document::new(512, 512, 8).unwrap();
        d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
        let white = d.display_tile(1, 0, 0).unwrap().unwrap();
        assert_eq!(&white[0..4], &[255, 255, 255, 255]);
        let mut e = EngineCore::new(d);
        let snap = e.snapshot();
        e.doc.fill(1, Target::Pixels, 0, 0, 0, 255).unwrap();
        let black = e.doc.display_tile(1, 0, 0).unwrap().unwrap();
        assert_eq!(&black[0..4], &[0, 0, 0, 255], "an edit shows at level 1");
        e.restore(snap).unwrap();
        assert_eq!(e.doc.display_tile(1, 0, 0).unwrap().unwrap(), white, "restore shows at level 1");
    }

    fn payload_keys(b: &[u8]) -> Vec<u64> {
        let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let mut o = 32 + u32at(24) as usize * 32;
        let mut keys = Vec::new();
        for _ in 0..u32at(28) {
            keys.push(u64::from_le_bytes(b[o..o + 8].try_into().unwrap()));
            o += 16 + u32at(o + 12) as usize;
        }
        keys
    }

    #[test]
    fn display_program_matches_the_display_tile() {
        let d = program_doc();
        for level in [0, 2] {
            let (ntx, nty) = d.level_tiles(level);
            for ty in 0..nty {
                for tx in 0..ntx {
                    let bytes = d.display_program(level, tx, ty, &[]).unwrap();
                    let run = Document::run_program(&Program::decode(&bytes));
                    assert_eq!(
                        quantize_premul(&run),
                        d.display_tile(level, tx, ty).unwrap(),
                        "level {level} tile ({tx}, {ty})"
                    );
                    let known = payload_keys(&bytes);
                    assert!(!known.is_empty());
                    let again = d.display_program(level, tx, ty, &known).unwrap();
                    assert!(payload_keys(&again).is_empty(), "known payloads are not resent");
                    assert!(again.len() < bytes.len());
                }
            }
        }
    }

    #[test]
    fn depth16_documents_display_but_have_no_draw_program() {
        let mut d = Document::new(512, 512, 16).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        assert_eq!(&d.display_tile(1, 0, 0).unwrap().unwrap()[0..4], &[255, 0, 0, 255]);
        assert_eq!(
            d.display_program(0, 0, 0, &[]).unwrap_err(),
            "draw programs need an 8-bit document"
        );
    }

    #[test]
    fn display_tile_level0_is_unchanged() {
        // Frozen before the pyramid rewrite: level 0 must stay bit-identical.
        assert_eq!(scene_checksum(&program_doc()), 9894974724174265876);
    }

    // cargo test --release bench_pan_zoom -- --ignored --nocapture
    #[test]
    #[ignore]
    fn bench_pan_zoom() {
        use std::time::Instant;
        let mut d = Document::new(8000, 8000, 8).unwrap();
        // Distinct content per tile, so every tile has its own id and its own pyramid entries.
        let paint_all = |d: &mut Document, id: u32, seed: u32| {
            for ty in 0..d.tiles_y() {
                for tx in 0..d.tiles_x() {
                    let c = [(tx * 7 + seed) as u8, (ty * 5 + seed) as u8, (tx + ty) as u8, 220];
                    let mut px = vec![0u8; TILE_BYTES_U8];
                    for p in px.chunks_exact_mut(4) {
                        p.copy_from_slice(&c);
                    }
                    d.set_tile_rgba8(id, tx, ty, &px).unwrap();
                }
            }
        };
        paint_all(&mut d, 1, 1);
        for i in 0..9u32 {
            let id = d.add_layer(&format!("L{i}"), 0).unwrap();
            paint_all(&mut d, id, i * 13 + 2);
        }
        let sweep = |level: u32, n: u32| {
            let start = Instant::now();
            for ty in 0..n {
                for tx in 0..n {
                    d.display_tile(level, tx, ty).unwrap();
                }
            }
            start.elapsed().as_secs_f64() * 1000.0 / (n * n) as f64
        };
        println!("bench_pan_zoom: level 0 {:.2} ms/tile", sweep(0, 4));
        println!("bench_pan_zoom: level 3 cold {:.2} ms/tile", sweep(3, 4));
        println!("bench_pan_zoom: level 3 warm {:.2} ms/tile", sweep(3, 4));
        println!("bench_pan_zoom: level 5 cold {:.2} ms/tile", sweep(5, 1));
        println!("bench_pan_zoom: level 5 warm {:.2} ms/tile", sweep(5, 1));
        println!("bench_pan_zoom: level 3 after zoom out {:.2} ms/tile", sweep(3, 4));
    }

    #[test]
    #[ignore]
    fn bench_display_tile() {
        use std::time::Instant;
        let mut d = Document::new(8000, 8000, 8).unwrap();
        d.fill(1, Target::Pixels, 128, 64, 32, 200).unwrap();

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
    fn integer_reduce_matches_the_float_reduction() {
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut rnd = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for depth in [8u8, 16] {
            let d = Document::new(300, 300, depth).unwrap();
            let max = max_value(depth) as u64;
            for mask in [None, Some(max as u32 / 3)] {
                let len = if mask.is_some() { TILE_PIXELS } else { TILE_PIXELS * 4 };
                // Few distinct values, so equal-weight blocks and rounding ties are common.
                // `opaque` sets every alpha to the maximum, the equal-weight path of the pixel reduction.
                let mut tile = |opaque: bool| {
                    let mut v: Vec<u16> = (0..len).map(|_| [0, 1, 2, max / 2, max - 1, max][(rnd() % 6) as usize] as u16).collect();
                    if opaque && mask.is_none() {
                        v.iter_mut().skip(3).step_by(4).for_each(|a| *a = max as u16);
                    }
                    Arc::new(match (depth, mask.is_some()) {
                        (8, false) => Pixels::U8(v.iter().map(|x| *x as u8).collect()),
                        (8, true) => Pixels::Mask8(v.iter().map(|x| *x as u8).collect()),
                        (_, false) => Pixels::U16(v.into_boxed_slice()),
                        (_, true) => Pixels::Mask16(v.into_boxed_slice()),
                    })
                };
                let kids = [Some((1, tile(false))), None, Some((3, tile(true))), Some((4, tile(false)))];
                let valid = [(TILE, TILE), (TILE, TILE), (TILE, 77), (133, 1)];
                let (a, b) = (d.reduce(&kids, &valid, mask).to_bytes(), d.reduce_f32(&kids, &valid, mask).to_bytes());
                let step = if depth == 8 { 1 } else { 2 };
                let (mut worst, mut differ) = (0i64, 0usize);
                for i in (0..a.len()).step_by(step) {
                    let v = |x: &[u8]| if depth == 8 { x[i] as i64 } else { u16::from_le_bytes([x[i], x[i + 1]]) as i64 };
                    let diff = (v(&a) - v(&b)).abs();
                    worst = worst.max(diff);
                    differ += (diff > 0) as usize;
                }
                assert!(worst <= 1, "depth {depth} mask {mask:?}: max difference {worst}");
                assert!(differ * 100 < a.len() / step, "depth {depth} mask {mask:?}: {differ} values differ");
            }
        }
    }

    // ---------- selection (M2.md section 3) ----------

    fn sel(d: &Document, x: i32, y: i32) -> f32 {
        d.sel_at(d.selection.as_ref().expect("a selection"), x, y)
    }

    fn sel_mass(d: &Document) -> f64 {
        let mut m = 0.0;
        for y in 0..d.height as i32 {
            for x in 0..d.width as i32 {
                m += sel(d, x, y) as f64;
            }
        }
        m
    }

    #[test]
    fn select_rect_is_hard_edged_and_exact_at_a_fractional_edge() {
        let mut d = Document::new(256, 256, 8).unwrap();
        assert!(!d.has_selection());
        d.select_rect(10.0, 20.0, 30.0, 40.0, Mode::New).unwrap();
        assert!(d.has_selection());
        assert_eq!(d.selection_bounds(), Some([10, 20, 30, 40]));
        assert_eq!(sel(&d, 10, 20), 1.0);
        assert_eq!(sel(&d, 9, 20), 0.0);
        assert_eq!(sel(&d, 39, 59), 1.0);
        assert_eq!(sel(&d, 40, 59), 0.0);
        d.select_rect(0.0, 0.0, 10.5, 4.0, Mode::New).unwrap();
        assert!((sel(&d, 10, 0) - 0.5).abs() <= 1.0 / 255.0);
        assert!((sel_mass(&d) - 42.0).abs() < 0.05, "10.5 x 4 pixels: {}", sel_mass(&d));
    }

    #[test]
    fn boolean_modes_combine_two_rects() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let cases = [
            (Mode::Add, [0, 0, 150, 100], 15000.0),
            (Mode::Intersect, [50, 0, 50, 100], 5000.0),
            (Mode::Subtract, [0, 0, 50, 100], 5000.0),
            (Mode::New, [50, 0, 100, 100], 10000.0),
        ];
        for (mode, bounds, mass) in cases {
            d.select_rect(0.0, 0.0, 100.0, 100.0, Mode::New).unwrap();
            d.select_rect(50.0, 0.0, 100.0, 100.0, mode).unwrap();
            assert_eq!(d.selection_bounds(), Some(bounds), "{mode:?}");
            assert!((sel_mass(&d) - mass).abs() < 0.5, "{mode:?}: {}", sel_mass(&d));
        }
    }

    #[test]
    fn ellipse_selection_covers_its_area_and_intersects() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.select_ellipse(28.0, 40.0, 200.0, 120.0, true, Mode::New).unwrap();
        let area = std::f64::consts::PI * 100.0 * 60.0;
        assert!((sel_mass(&d) - area).abs() < area * 5e-3, "{} vs {area}", sel_mass(&d));
        assert_eq!(d.selection_bounds(), Some([28, 40, 200, 120]));
        // The centre is at x = 128, so half the canvas cuts the ellipse in half.
        d.select_rect(0.0, 0.0, 128.0, 256.0, Mode::Intersect).unwrap();
        assert!((sel_mass(&d) - area / 2.0).abs() < area * 5e-3, "{}", sel_mass(&d));
        d.select_ellipse(28.0, 40.0, 200.0, 120.0, false, Mode::New).unwrap();
        for v in [sel(&d, 128, 100), sel(&d, 28, 40)] {
            assert!(v == 0.0 || v == 1.0, "centre sampling is binary: {v}");
        }
    }

    #[test]
    fn polygon_selection_fills_even_odd_and_clips_to_the_canvas() {
        let mut d = Document::new(64, 64, 8).unwrap();
        d.select_polygon(&[-20.0, -20.0, 84.0, -20.0, 32.0, 40.0], true, Mode::New).unwrap();
        let b = d.selection_bounds().unwrap();
        assert!(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= 64 && b[1] + b[3] <= 64, "{b:?}");
        assert_eq!(sel(&d, 32, 0), 1.0);
        assert_eq!(sel(&d, 32, 45), 0.0);
        assert!(d.select_polygon(&[0.0, 0.0, 1.0, 1.0], true, Mode::New).is_err());
        assert!(d.select_polygon(&[0.0, 0.0, 1.0], true, Mode::New).is_err());
    }

    #[test]
    fn feather_keeps_the_mass_and_stays_symmetric() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.select_rect(64.0, 64.0, 128.0, 128.0, Mode::New).unwrap();
        let before = sel_mass(&d);
        assert!(d.feather_selection(0.0).is_err());
        d.feather_selection(12.0).unwrap();
        let after = sel_mass(&d);
        assert!((after - before).abs() < before * 5e-3, "{before} -> {after}");
        for k in 0..24 {
            let (l, r) = (sel(&d, 52 + k, 128), sel(&d, 203 - k, 128));
            assert!((l - r).abs() <= 1.0 / 255.0, "k {k}: {l} vs {r}");
        }
        assert!((sel(&d, 63, 128) + sel(&d, 64, 128) - 1.0).abs() < 0.02, "the edge fades through 0.5");
        assert!(sel(&d, 128, 128) > 0.99);
        assert_eq!(sel(&d, 40, 128), 0.0, "beyond the radius nothing changes");
        // The edge spreads by about the radius; the outermost ring quantizes to 0.
        let b = d.selection_bounds().unwrap();
        assert!((52..=54).contains(&b[0]) && (52..=54).contains(&b[1]), "{b:?}");
        assert_eq!([b[0] + b[2], b[1] + b[3]], [256 - b[0], 256 - b[1]], "symmetric growth: {b:?}");
    }

    #[test]
    fn select_all_invert_deselect_and_reselect() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.select_all().unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 256, 256]));
        d.select_rect(0.0, 0.0, 100.0, 256.0, Mode::New).unwrap();
        d.invert_selection().unwrap();
        assert_eq!(d.selection_bounds(), Some([100, 0, 156, 256]));
        assert_eq!(sel(&d, 0, 0), 0.0);
        assert_eq!(sel(&d, 100, 0), 1.0);
        d.deselect().unwrap();
        assert!(!d.has_selection());
        assert_eq!(d.selection_bounds(), None);
        d.reselect().unwrap();
        assert_eq!(d.selection_bounds(), Some([100, 0, 156, 256]));
        let mut e = Document::new(64, 64, 8).unwrap();
        assert!(e.reselect().is_err());
        e.invert_selection().unwrap();
        assert_eq!(e.selection_bounds(), Some([0, 0, 64, 64]), "nothing selected inverts to everything");
    }

    #[test]
    fn fill_and_clear_honour_a_partial_selection() {
        let mut d = doc_bg(255, 255, 255);
        d.select_rect(0.0, 0.0, 10.5, 256.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        near(at(&d, 0, 0), [255, 0, 0, 255]);
        near(at(&d, 10, 0), [255, 128, 128, 255]);
        near(at(&d, 11, 0), [255, 255, 255, 255]);
        d.clear(1, Target::Pixels).unwrap();
        assert_eq!(at(&d, 0, 0)[3], 0);
        let half = at(&d, 10, 0);
        assert!((half[3] as i32 - 127).abs() <= 1, "half coverage keeps half the alpha: {half:?}");
        near(at(&d, 11, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn invert_pixels_only_inside_the_selection() {
        let mut d = doc_bg(255, 0, 0);
        d.select_rect(0.0, 0.0, 128.0, 256.0, Mode::New).unwrap();
        d.invert(1, Target::Pixels).unwrap();
        near(at(&d, 10, 10), [0, 255, 255, 255]);
        near(at(&d, 200, 10), [255, 0, 0, 255]);
    }

    #[test]
    fn mask_edits_inside_a_selection_keep_the_default() {
        let mut d = doc_bg(255, 255, 255);
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
        d.add_mask(top, true).unwrap();
        d.select_rect(0.0, 0.0, 128.0, 256.0, Mode::New).unwrap();
        d.clear(top, Target::Mask).unwrap();
        assert_eq!(d.node(top).unwrap().mask.as_ref().unwrap().default, 255);
        near(at(&d, 10, 10), [255, 255, 255, 255]);
        near(at(&d, 200, 10), [255, 0, 0, 255]);
        d.invert(top, Target::Mask).unwrap();
        assert_eq!(d.node(top).unwrap().mask.as_ref().unwrap().default, 255, "only the selection flips");
        near(at(&d, 10, 10), [255, 0, 0, 255]);
    }

    #[test]
    fn an_empty_selection_stops_every_edit() {
        let mut d = doc_bg(255, 255, 255);
        d.select_rect(0.0, 0.0, 10.0, 10.0, Mode::New).unwrap();
        d.select_rect(100.0, 100.0, 10.0, 10.0, Mode::Intersect).unwrap();
        assert!(d.has_selection());
        assert_eq!(d.selection_bounds(), None);
        d.fill(1, Target::Pixels, 0, 0, 0, 255).unwrap();
        d.clear(1, Target::Pixels).unwrap();
        near(at(&d, 0, 0), [255, 255, 255, 255]);
    }

    #[test]
    fn snapshot_restores_the_selection() {
        let mut e = EngineCore::new(Document::new(256, 256, 8).unwrap());
        e.doc.select_rect(10.0, 10.0, 50.0, 50.0, Mode::New).unwrap();
        let snap = e.snapshot();
        e.doc.deselect().unwrap();
        assert!(!e.doc.has_selection());
        e.restore(snap).unwrap();
        assert_eq!(e.doc.selection_bounds(), Some([10, 10, 50, 50]));
    }

    #[test]
    fn selection_tile_reports_coverage_per_level() {
        let mut d = Document::new(512, 512, 8).unwrap();
        assert_eq!(d.selection_tile(0, 0, 0).unwrap(), None, "no selection, no overlay");
        d.select_rect(0.0, 0.0, 256.0, 256.0, Mode::New).unwrap();
        let t = d.selection_tile(0, 0, 0).unwrap().unwrap();
        assert_eq!(t.len(), MASK_BYTES_U8);
        assert!(t.iter().all(|v| *v == 255));
        assert_eq!(d.selection_tile(0, 1, 0).unwrap(), None, "an unselected tile is the default");
        let l1 = d.selection_tile(1, 0, 0).unwrap().unwrap();
        assert_eq!(l1[0], 255);
        assert_eq!(l1[200], 0);
        d.select_all().unwrap();
        assert_eq!(d.selection_tile(0, 0, 0).unwrap(), None, "select all needs no tile");
        assert!(d.selection_tile(9, 0, 0).is_err());
    }

    #[test]
    fn channels_save_load_and_delete() {
        let mut d = Document::new(256, 256, 8).unwrap();
        assert!(d.save_selection("none").is_err());
        d.select_rect(0.0, 0.0, 100.0, 100.0, Mode::New).unwrap();
        let ch = d.save_selection("left").unwrap();
        d.select_rect(50.0, 50.0, 100.0, 100.0, Mode::New).unwrap();
        d.load_selection(ch, false, Mode::Intersect).unwrap();
        assert_eq!(d.selection_bounds(), Some([50, 50, 50, 50]));
        d.load_selection(ch, true, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 256, 256]));
        assert_eq!(sel(&d, 10, 10), 0.0);
        assert_eq!(sel(&d, 200, 200), 1.0);
        let v: Value = serde_json::from_str(&d.channels_json()).unwrap();
        assert_eq!(v["channels"][0]["name"], "left");
        assert_eq!(v["channels"][0]["id"].as_u64().unwrap() as u32, ch);
        assert_eq!(v["selection"]["default"].as_u64().unwrap(), 255);
        d.delete_channel(ch).unwrap();
        assert!(d.delete_channel(ch).is_err());
        assert!(d.load_selection(ch, false, Mode::New).is_err());
    }

    #[test]
    fn combine_into_channel_unions_the_selection_into_a_saved_channel() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.select_rect(0.0, 0.0, 50.0, 50.0, Mode::New).unwrap();
        let ch = d.save_selection("a").unwrap();
        d.select_rect(100.0, 100.0, 50.0, 50.0, Mode::New).unwrap();
        d.combine_into_channel(ch, Mode::Add).unwrap();
        d.select_rect(0.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
        d.load_selection(ch, false, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 150, 150]), "both rects joined into the channel");
        assert!(d.combine_into_channel(999, Mode::Add).is_err());
    }

    // ---------- layer bounds (M2.md section 5) ----------

    #[test]
    fn offset_layer_keeps_pixels_outside_the_canvas() {
        let mut d = Document::new(256, 256, 8).unwrap();
        let mut data = vec![0u8; TILE_BYTES_U8];
        for y in 0..TILE {
            for x in 0..TILE {
                let o = (y * TILE + x) * 4;
                data[o..o + 4].copy_from_slice(&[(x % 251) as u8, (y % 253) as u8, 7, 255]);
            }
        }
        d.set_tile_rgba8(1, 0, 0, &data).unwrap();
        d.add_mask(1, false).unwrap();
        d.set_mask_tile8(1, 0, 0, &mask_pattern(3, 0, 0)).unwrap();
        let before = d.flatten_tile_rgba8(0, 0).unwrap();
        let mask_before = d.node(1).unwrap().mask.as_ref().unwrap().tiles.get(0, 0).unwrap().px.to_bytes();
        assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 256, 256]));
        d.offset_layer(1, 300, 20).unwrap();
        assert_eq!(d.display_tile(0, 0, 0).unwrap(), None, "the pixels moved off the canvas");
        assert_eq!(d.layer_bounds(1).unwrap(), Some([300, 20, 256, 256]));
        d.offset_layer(1, -300, -20).unwrap();
        assert_eq!(d.flatten_tile_rgba8(0, 0).unwrap(), before, "moving back restores the pixels");
        assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 256, 256]));
        let mask_after = d.node(1).unwrap().mask.as_ref().unwrap().tiles.get(0, 0).unwrap().px.to_bytes();
        assert_eq!(mask_after, mask_before, "the mask travels with the pixels");
        d.offset_layer(1, 0, 0).unwrap();
        set(&mut d, 1, r#"{"locks":{"position":true}}"#);
        assert_eq!(d.offset_layer(1, 1, 0).unwrap_err(), "layer position is locked");
    }

    #[test]
    fn a_filled_mask_keeps_its_value_where_offset_layer_shifts_in_new_area() {
        let mut d = Document::new(512, 256, 8).unwrap();
        d.add_mask(1, true).unwrap();
        d.fill(1, Target::Mask, 0, 0, 0, 255).unwrap();
        d.offset_layer(1, 100, 0).unwrap();
        let m = d.node(1).unwrap().mask.as_ref().unwrap();
        let at = |tx, ty| m.tiles.get(tx, ty).map_or(vec![m.default as u8; MASK_BYTES_U8], |t| t.px.to_bytes());
        assert!(at(0, 0).iter().all(|&v| v == 0), "the shifted-in column stays hidden");
    }

    #[test]
    fn offset_layer_refuses_offsets_the_manifest_cannot_store() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.set_tile_rgba8(1, 0, 0, &vec![255u8; TILE_BYTES_U8]).unwrap();
        assert!(d.offset_layer(1, i32::MAX, 0).is_err());
        assert!(d.offset_layer(1, 0, -((MAX_TILE_COORD as i32 + 1) * TILE as i32)).is_err());
        d.offset_layer(1, (MAX_TILE_COORD as i32 - 1) * TILE as i32, 0).unwrap();
        assert!(Document::from_manifest(&d.manifest()).is_ok(), "a stored offset reopens");
    }

    #[test]
    fn layer_bounds_are_tight_and_empty_layers_have_none() {
        let mut d = Document::new(512, 512, 8).unwrap();
        assert_eq!(d.layer_bounds(1).unwrap(), None);
        let mut data = vec![0u8; TILE_BYTES_U8];
        let o = (5 * TILE + 7) * 4;
        data[o..o + 4].copy_from_slice(&[1, 2, 3, 255]);
        d.set_tile_rgba8(1, 1, 1, &data).unwrap();
        assert_eq!(d.layer_bounds(1).unwrap(), Some([256 + 7, 256 + 5, 1, 1]));
        let g = d.add_group("g", 0).unwrap();
        assert!(d.layer_bounds(g).is_err());
    }

    // ---------- manifest v3 ----------

    #[test]
    fn v3_round_trip_keeps_selection_channels_and_offset_tiles() {
        let mut d = rich_doc();
        d.select_rect(20.0, 30.0, 100.0, 40.0, Mode::New).unwrap();
        let ch = d.save_selection("saved").unwrap();
        d.deselect().unwrap();
        d.select_ellipse(0.0, 0.0, 200.0, 100.0, true, Mode::New).unwrap();
        d.offset_layer(1, -300, -40).unwrap();
        let m = manifest_value(&d);
        assert_eq!(m["version"].as_u64().unwrap(), 3);
        assert!(
            m["layers"][0]["tiles"].as_array().unwrap().iter().any(|e| e[0].as_i64().unwrap() < 0),
            "a tile outside the canvas is stored"
        );
        assert_eq!(m["channels"][0]["name"], "saved");
        assert_eq!(m["channels"][0]["id"].as_u64().unwrap() as u32, ch);
        assert!(!m["last_selection"].is_null());
        let l = loaded_copy(&d);
        assert_eq!(l.selection_bounds(), d.selection_bounds());
        assert_eq!(l.channels.len(), 1);
        assert!(l.last_selection.is_some());
        assert_eq!(l.layer_bounds(1).unwrap(), d.layer_bounds(1).unwrap());
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                assert_eq!(l.display_tile(0, tx, ty).unwrap(), d.display_tile(0, tx, ty).unwrap());
            }
        }
        for (x, y) in [(10, 10), (100, 60), (250, 200)] {
            assert_eq!(sel(&l, x, y), sel(&d, x, y), "selection at ({x}, {y})");
        }
    }

    #[test]
    fn v2_manifest_still_loads() {
        let mut old = Document::new(512, 256, 8).unwrap();
        old.fill(1, Target::Pixels, 7, 8, 9, 255).unwrap();
        let id = tile_id(&manifest_value(&old)["layers"][0]["tiles"], 1, 0);
        let v2 = format!(
            r#"{{"format":"photobaer-manifest","version":2,"width":512,"height":256,"depth":8,"tiles_x":2,"tiles_y":1,"next_id":{},"next_node_id":2,"layers":[{{"id":1,"name":"bg","kind":"pixel","visible":true,"opacity":1.0,"fill":1.0,"blend":"normal","clipping":false,"locks":{{"transparency":false,"pixels":false,"position":false}},"mask":{{"enabled":true,"default":255,"tiles":[0,0]}},"tiles":[0,{id}]}}]}}"#,
            id + 1
        );
        let mut d = Document::from_manifest(&v2).unwrap();
        d.put_tile(id, &old.tile_bytes(id).unwrap()).unwrap();
        d.finish_load().unwrap();
        assert_eq!(at(&d, 0, 0)[3], 0, "the empty dense slot stays empty");
        assert_eq!(d.flatten_tile_rgba8(1, 0).unwrap()[0..4], [7, 8, 9, 255]);
        let m = manifest_value(&d);
        assert_eq!(m["version"].as_u64().unwrap(), 3);
        assert_eq!(tile_id(&m["layers"][0]["tiles"], 1, 0), id, "dense slot 1 became tile (1, 0)");
        assert!(m["selection"].is_null());
        assert!(m["last_selection"].is_null());
        assert!(m["channels"].as_array().unwrap().is_empty());
        assert!(d.node(1).unwrap().mask.is_some());
    }

    #[test]
    fn v3_selection_and_channel_rejections() {
        let base = || {
            let mut d = Document::new(300, 300, 8).unwrap();
            d.fill(1, Target::Pixels, 1, 2, 3, 255).unwrap();
            d.select_rect(0.0, 0.0, 50.0, 50.0, Mode::New).unwrap();
            d.save_selection("c").unwrap();
            d
        };
        assert!(Document::from_manifest(&base().manifest()).is_ok());
        let broken3 = |f: &dyn Fn(&mut Value)| {
            let mut v = manifest_value(&base());
            f(&mut v);
            v.to_string()
        };
        let cases: Vec<(&str, String)> = vec![
            ("selection tile outside the canvas", broken3(&|v| v["selection"]["tiles"] = serde_json::json!([[9, 0, 5]]))),
            ("negative selection tile", broken3(&|v| v["selection"]["tiles"] = serde_json::json!([[-1, 0, 5]]))),
            ("selection tile id 0", broken3(&|v| v["selection"]["tiles"] = serde_json::json!([[0, 0, 0]]))),
            ("duplicate selection coordinate", broken3(&|v| v["selection"]["tiles"] = serde_json::json!([[0, 0, 5], [0, 0, 6]]))),
            ("selection default out of range", broken3(&|v| v["selection"]["default"] = 300.into())),
            ("unknown field in the selection", broken3(&|v| v["selection"]["extra"] = 1.into())),
            ("channel id 0", broken3(&|v| v["channels"][0]["id"] = 0.into())),
            ("duplicate channel id", broken3(&|v| {
                let c = v["channels"][0].clone();
                v["channels"].as_array_mut().unwrap().push(c);
            })),
            ("channel tile outside the canvas", broken3(&|v| v["channels"][0]["tiles"] = serde_json::json!([[0, 7, 5]]))),
        ];
        for (what, json) in cases {
            assert!(Document::from_manifest(&json).is_err(), "{what} must be rejected");
        }
    }

    // ---------- B3 E1: flood fill family (docs/M2.md magic wand, paint bucket) ----------

    // 256x256 doc, background split red (x<4) / blue (x>=4) inside an 8x8 corner.
    fn two_region_doc() -> Document {
        let mut d = doc_bg(0, 0, 255);
        d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        d.deselect().unwrap();
        d
    }

    #[test]
    fn magic_wand_selects_the_contiguous_region_only() {
        let mut d = two_region_doc();
        d.select_rect(7.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap(); // a stray red pixel, not 4-connected
        d.deselect().unwrap();
        d.magic_wand(0, 0, 32, false, true, false, 1, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]));
    }

    #[test]
    fn magic_wand_non_contiguous_reaches_a_disconnected_match() {
        let mut d = two_region_doc();
        d.select_rect(7.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        d.deselect().unwrap();
        d.magic_wand(0, 0, 32, false, false, false, 1, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 8, 8]), "the stray pixel widens the bounds");
    }

    #[test]
    fn magic_wand_tolerance_edge_cases() {
        let mut d = two_region_doc();
        d.magic_wand(0, 0, 0, false, true, false, 1, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]), "exact match only");
        d.magic_wand(0, 0, 255, false, true, false, 1, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 256, 256]), "tolerance 255 reaches everything");
    }

    #[test]
    fn magic_wand_works_on_a_16_bit_document() {
        let mut d = Document::new(8, 8, 16).unwrap();
        d.fill(1, Target::Pixels, 0, 0, 255, 255).unwrap();
        d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        d.deselect().unwrap();
        d.magic_wand(0, 0, 32, false, true, false, 1, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]));
    }

    #[test]
    fn magic_wand_sample_all_floods_the_flattened_composite_not_the_active_layer() {
        let mut d = Document::new(8, 8, 8).unwrap();
        d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 0, 0, 255, 255).unwrap();
        d.select_rect(4.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 0, 255, 0, 255).unwrap();
        d.deselect().unwrap();
        let top = d.add_layer("top", 1).unwrap();
        d.fill(top, Target::Pixels, 255, 0, 0, 128).unwrap();

        d.magic_wand(0, 0, 0, false, true, false, top, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 8, 8]), "the active layer is uniform");

        d.magic_wand(0, 0, 0, false, true, true, top, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]), "the composite differs across the bg split");
    }

    #[test]
    fn grow_is_contiguous_and_similar_is_not_on_a_three_region_fixture() {
        let mut d = Document::new(7, 1, 8).unwrap();
        let vals = [0u8, 40, 200, 200, 0, 200, 200];
        for (x, v) in vals.iter().enumerate() {
            d.select_rect(x as f64, 0.0, 1.0, 1.0, Mode::New).unwrap();
            d.fill(1, Target::Pixels, *v, 0, 0, 255).unwrap();
        }
        let sel_at = |d: &Document, x: usize| -> u8 { d.selection_tile(0, 0, 0).unwrap().map_or(0, |b| b[x]) };

        d.select_rect(0.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
        d.grow(40, false, 1).unwrap();
        assert_eq!(
            (0..7).map(|x| sel_at(&d, x) > 0).collect::<Vec<_>>(),
            vec![true, true, false, false, false, false, false],
            "grow is contiguous"
        );

        d.select_rect(0.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
        d.similar(40, false, 1).unwrap();
        assert_eq!(
            (0..7).map(|x| sel_at(&d, x) > 0).collect::<Vec<_>>(),
            vec![true, true, false, false, true, false, false],
            "similar reaches the disconnected match"
        );
    }

    #[test]
    fn grow_and_similar_error_when_nothing_is_selected() {
        let mut d = doc_bg(1, 2, 3);
        assert_eq!(d.grow(10, false, 1).unwrap_err(), "nothing is selected");
        assert_eq!(d.similar(10, false, 1).unwrap_err(), "nothing is selected");
    }

    #[test]
    fn bucket_normal_mode_blends_at_the_given_opacity() {
        let mut d = doc_bg(100, 150, 200);
        d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Blend(Blend::Normal), 0.5, 32, false, true, false).unwrap();
        near(at(&d, 0, 0), [178, 75, 100, 255]);
    }

    #[test]
    fn bucket_behind_only_paints_transparent_pixels() {
        let mut d = Document::new(4, 4, 8).unwrap();
        d.bucket(1, Target::Pixels, 0, 0, [0, 255, 0, 255], PaintMode::Behind, 1.0, 0, false, false, false).unwrap();
        assert_eq!(at(&d, 0, 0), [0, 255, 0, 255]);
        d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Behind, 1.0, 255, false, false, false).unwrap();
        assert_eq!(at(&d, 0, 0), [0, 255, 0, 255], "opaque already, behind changes nothing");
    }

    #[test]
    fn bucket_clear_mode_erases_towards_transparent() {
        let mut d = doc_bg(10, 20, 30);
        d.bucket(1, Target::Pixels, 0, 0, [0, 0, 0, 0], PaintMode::Clear, 0.5, 0, false, true, false).unwrap();
        assert_eq!(at(&d, 0, 0)[3], 128, "50% opacity clear halves alpha");
    }

    #[test]
    fn bucket_respects_the_transparency_lock() {
        let mut d = doc_bg(10, 20, 30);
        set(&mut d, 1, r#"{"locks":{"transparency":true}}"#);
        d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Blend(Blend::Normal), 1.0, 32, false, true, false).unwrap();
        let px = at(&d, 0, 0);
        assert_eq!(px[3], 255, "alpha stays locked");
        assert_eq!(px[0], 255, "color still paints under the lock");
    }

    #[test]
    fn bucket_errors_when_pixels_are_locked() {
        let mut d = doc_bg(10, 20, 30);
        set(&mut d, 1, r#"{"locks":{"pixels":true}}"#);
        assert_eq!(
            d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Blend(Blend::Normal), 1.0, 32, false, true, false)
                .unwrap_err(),
            "layer pixels are locked"
        );
    }

    #[test]
    fn bucket_is_clipped_to_the_selection() {
        let mut d = doc_bg(10, 20, 30);
        d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
        d.bucket(1, Target::Pixels, 0, 0, [255, 0, 0, 255], PaintMode::Blend(Blend::Normal), 1.0, 32, false, true, false).unwrap();
        assert_eq!(at(&d, 0, 0)[0], 255, "painted inside the selection");
        assert_eq!(at(&d, 5, 0), [10, 20, 30, 255], "untouched outside the selection");
    }

    // ---------- B3 E2: Select > Modify ----------

    #[test]
    fn modify_selection_expand_contract_border_smooth() {
        let mut d = Document::new(256, 256, 8).unwrap();
        assert_eq!(d.modify_selection("expand", 2.0, true).unwrap_err(), "nothing is selected");

        d.select_rect(10.0, 10.0, 4.0, 4.0, Mode::New).unwrap();
        d.modify_selection("expand", 2.0, true).unwrap();
        assert_eq!(d.selection_bounds(), Some([8, 8, 8, 8]), "grew by 2px on every side");

        d.select_rect(10.0, 10.0, 4.0, 4.0, Mode::New).unwrap();
        d.modify_selection("contract", 1.0, true).unwrap();
        assert_eq!(d.selection_bounds(), Some([11, 11, 2, 2]), "shrank by 1px on every side");

        d.select_rect(10.0, 10.0, 20.0, 20.0, Mode::New).unwrap();
        d.modify_selection("border", 2.0, true).unwrap();
        assert_eq!(sel(&d, 19, 19), 0.0, "the far interior is untouched");
        assert!(sel(&d, 10, 19) > 0.0, "the band straddles the original edge");

        d.select_rect(10.0, 10.0, 4.0, 4.0, Mode::New).unwrap();
        d.modify_selection("smooth", 1.0, true).unwrap();
        assert_eq!(d.selection_bounds(), Some([10, 10, 4, 4]));

        assert_eq!(d.modify_selection("nonsense", 1.0, true).unwrap_err(), "unknown modify op nonsense");
    }

    // ---------- B3 E2: quick mask (Target::Selection) ----------

    #[test]
    fn quick_mask_fill_invert_clear_target_selection() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.fill(1, Target::Selection, 200, 0, 0, 0).unwrap();
        assert_eq!(sel(&d, 5, 5), 200.0 / 255.0);
        d.invert(1, Target::Selection).unwrap();
        assert!((sel(&d, 5, 5) - (1.0 - 200.0 / 255.0)).abs() < 1e-6);
        d.clear(1, Target::Selection).unwrap();
        assert_eq!(sel(&d, 5, 5), 0.0);
    }

    #[test]
    fn quick_mask_round_trips_through_paint_coverage() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.select_rect(0.0, 0.0, 10.0, 8.0, Mode::New).unwrap();
        let tile = d.selection_tile(0, 0, 0).unwrap().unwrap();
        let coverage: Vec<f32> = tile.iter().map(|&v| v as f32 / 255.0).collect();
        let mut d2 = Document::new(256, 256, 8).unwrap();
        d2.paint_coverage(
            1,
            Target::Selection,
            0,
            0,
            256,
            256,
            &coverage,
            [255, 255, 255, 255],
            PaintMode::Blend(Blend::Normal),
            1.0,
        )
        .unwrap();
        assert_eq!(d2.selection_tile(0, 0, 0).unwrap().unwrap(), tile, "quick mask round trip reproduces the same bytes");
    }

    #[test]
    fn quick_mask_bucket_paints_the_selection_channel() {
        let mut d = Document::new(4, 4, 8).unwrap();
        d.bucket(1, Target::Selection, 0, 0, [255, 255, 255, 255], PaintMode::Blend(Blend::Normal), 1.0, 0, false, true, false)
            .unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 4, 4]));
    }

    // ---------- B3 E2: color range ----------

    #[test]
    fn color_range_selects_the_sampled_region_and_preview_leaves_the_selection_alone() {
        let d = two_region_doc(); // left half red, right half blue
        assert_eq!(
            d.color_range_preview(0, false, 1, "bogus preset", &[], 0, 0, &[], false, false).unwrap_err(),
            "unknown color range preset bogus preset"
        );
        let preview = d.color_range_preview(0, false, 1, "sampled", &[[255, 0, 0]], 50, 0, &[], false, false).unwrap();
        assert!(!d.has_selection(), "the preview does not touch the selection");
        assert_eq!(preview[0], 255, "the red half previews fully covered");
        assert_eq!(preview[preview.len() - 1], 0, "the blue half previews uncovered");

        let mut d = d;
        d.color_range(false, 1, "sampled", &[[255, 0, 0]], 50, 0, &[], false, false, Mode::New).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]), "the sampled preset selects the red half");
    }

    // Left half red, right half blue.
    fn split_doc() -> Document {
        let mut d = Document::new(8, 8, 8).unwrap();
        d.select_rect(0.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 230, 60, 40, 255).unwrap();
        d.select_rect(4.0, 0.0, 4.0, 8.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 30, 40, 210, 255).unwrap();
        d.deselect().unwrap();
        d
    }

    #[test]
    fn quick_select_takes_the_stroked_side_and_subtract_gives_it_back() {
        let mut d = split_doc();
        d.quick_select(&[1.5, 2.5, 1.5, 5.5], 1.0, false, 1, Mode::New, false).unwrap();
        assert_eq!(d.selection_bounds(), Some([0, 0, 4, 8]), "the stroked side only");

        d.select_all().unwrap();
        d.quick_select(&[1.5, 2.5, 1.5, 5.5], 1.0, false, 1, Mode::Subtract, false).unwrap();
        assert_eq!(d.selection_bounds(), Some([4, 0, 4, 8]), "subtract leaves the other side");

        assert!(d.quick_select(&[1.0], 1.0, false, 1, Mode::New, false).is_err());
        assert!(d.quick_select(&[f64::NAN, 1.0], 1.0, false, 1, Mode::New, false).is_err());
        assert!(d.quick_select(&[], 1.0, false, 1, Mode::New, false).is_err());
    }

    #[test]
    fn quick_select_auto_enhance_feathers_the_border() {
        let mut d = split_doc();
        d.quick_select(&[1.5, 2.5, 1.5, 5.5], 1.0, false, 1, Mode::New, true).unwrap();
        let tile = d.selection_tile(0, 0, 0).unwrap().expect("a selection tile");
        assert!(tile[4 * 256 + 1] > 230, "the stroked side stays selected");
        let soft = (0..8).any(|x| { let v = tile[4 * 256 + x]; v > 0 && v < 255 });
        assert!(soft, "auto enhance leaves partial coverage at the border");
    }

    #[test]
    fn magnetic_handles_live_from_begin_to_end() {
        let mut d = Document::new(40, 40, 8).unwrap();
        d.fill(1, Target::Pixels, 20, 20, 20, 255).unwrap();
        d.select_rect(10.0, 10.0, 20.0, 20.0, Mode::New).unwrap();
        d.fill(1, Target::Pixels, 240, 240, 240, 255).unwrap();
        d.deselect().unwrap();
        let mut e = EngineCore::new(d);

        assert!(e.magnetic_path(0, 10, 25, 25, 10, 12, 0).is_err(), "no handle yet");
        let h = e.magnetic_begin(false, 1).unwrap();
        let path = e.magnetic_path(h, 10, 25, 25, 10, 12, 0).unwrap();
        assert_eq!(path.len() % 2, 0);
        assert_eq!(&path[..2], &[10, 25]);
        assert_eq!(&path[path.len() - 2..], &[25, 10]);
        // Every point sits on the bright square's boundary ring, within a pixel.
        for p in path.chunks_exact(2) {
            let (x, y) = (p[0], p[1]);
            let on_ring = (9..=30).contains(&x)
                && (9..=30).contains(&y)
                && (x <= 10 || x >= 29 || y <= 10 || y >= 29);
            assert!(on_ring, "({x}, {y}) left the edge");
        }
        assert_eq!(livewire::suggest_anchor(&[(0, 0), (10, 0), (20, 0)], 91), Some(1));

        e.magnetic_end(h).unwrap();
        assert!(e.magnetic_end(h).is_err(), "the handle is freed once");
        assert!(e.magnetic_path(h, 10, 25, 25, 10, 12, 0).is_err());
    }

    // ---------- B4 stroke engine (M2.md section 4) ----------

    // Full-coverage aliased brush params, so goldens read the exact paint value; `extra` is a
    // JSON fragment (`,"flow":0.5`) whose fields win over the defaults.
    fn hard(extra: &str) -> String {
        let mut base: Value =
            serde_json::from_str(r#"{"rgba":[0,0,0,255],"mode":"normal","size":10,"aliased":true}"#).unwrap();
        let over: Value = serde_json::from_str(&format!(r#"{{"_":0{extra}}}"#)).unwrap();
        for (k, v) in over.as_object().unwrap() {
            if k != "_" {
                base[k] = v.clone();
            }
        }
        base.to_string()
    }

    fn core_bg(r: u8, g: u8, b: u8) -> EngineCore {
        EngineCore::new(doc_bg(r, g, b))
    }

    fn stroke(e: &mut EngineCore, params: &str, samples: &[f64]) -> Vec<i32> {
        e.stroke_begin(1, "pixels", params).unwrap();
        let rect = e.stroke_to(samples).unwrap();
        e.stroke_end().unwrap();
        rect
    }

    #[test]
    fn stroke_paints_a_hard_dab() {
        let mut e = core_bg(255, 255, 255);
        stroke(&mut e, &hard(r#","size":5"#), &[10.5, 10.5, 1.0]);
        assert_eq!(at(&e.doc, 10, 10), [0, 0, 0, 255]);
        assert_eq!(at(&e.doc, 12, 10), [0, 0, 0, 255], "2 px out is inside a size 5 tip");
        assert_eq!(at(&e.doc, 13, 10), [255, 255, 255, 255], "3 px out is past the tip");
    }

    #[test]
    fn stroke_opacity_caps_however_often_it_overlaps() {
        let mut e = core_bg(255, 255, 255);
        let mut samples = Vec::new();
        for _ in 0..20 {
            samples.extend_from_slice(&[10.5, 10.5, 1.0]);
        }
        stroke(&mut e, &hard(r#","opacity":0.5,"airbrush":true"#), &samples);
        assert_eq!(at(&e.doc, 10, 10), [128, 128, 128, 255], "20 dabs stay at the 50 % opacity");
    }

    #[test]
    fn stroke_flow_builds_up_per_dab() {
        let mut e = core_bg(255, 255, 255);
        // Two dabs on the same spot at flow 50 %: 0.5 then 0.75 of the full opacity.
        stroke(&mut e, &hard(r#","flow":0.5,"airbrush":true"#), &[10.5, 10.5, 1.0, 10.5, 10.5, 1.0]);
        assert_eq!(at(&e.doc, 10, 10), [64, 64, 64, 255]);
    }

    #[test]
    fn stroke_multiply_sees_the_pre_stroke_backdrop() {
        let mut e = core_bg(128, 128, 128);
        stroke(&mut e, &hard(r#","rgba":[128,128,128,255],"mode":"multiply","airbrush":true"#), &[10.5, 10.5, 1.0, 10.5, 10.5, 1.0]);
        assert_eq!(at(&e.doc, 10, 10), [64, 64, 64, 255], "the second dab must not multiply twice");
    }

    #[test]
    fn stroke_is_clipped_by_the_selection() {
        let mut e = core_bg(255, 255, 255);
        e.doc.select_shape(&Rect::new(0.0, 0.0, 10.0, 10.0), Mode::New).unwrap();
        stroke(&mut e, &hard(""), &[5.5, 5.5, 1.0, 30.5, 5.5, 1.0]);
        assert_eq!(at(&e.doc, 5, 5), [0, 0, 0, 255]);
        assert_eq!(at(&e.doc, 20, 5), [255, 255, 255, 255], "outside the selection stays clean");
    }

    #[test]
    fn stroke_honors_the_transparency_lock() {
        let mut e = EngineCore::new(Document::new(256, 256, 8).unwrap());
        e.doc.fill(1, Target::Pixels, 255, 0, 0, 128).unwrap();
        set(&mut e.doc, 1, r#"{"locks":{"transparency":true}}"#);
        stroke(&mut e, &hard(""), &[10.5, 10.5, 1.0]);
        assert_eq!(at(&e.doc, 10, 10), [0, 0, 0, 128], "alpha is kept, color is painted");
    }

    #[test]
    fn stroke_begin_errors_on_the_pixel_lock() {
        let mut e = core_bg(255, 255, 255);
        set(&mut e.doc, 1, r#"{"locks":{"pixels":true}}"#);
        let err = e.stroke_begin(1, "pixels", &hard("")).unwrap_err();
        assert!(err.contains("locked"), "{err}");
        assert!(e.stroke_to(&[0.0, 0.0, 1.0]).is_err(), "no stroke was opened");
    }

    #[test]
    fn stroke_clear_erases() {
        let mut e = core_bg(255, 255, 255);
        stroke(&mut e, &hard(r#","mode":"clear""#), &[10.5, 10.5, 1.0]);
        assert_eq!(at(&e.doc, 10, 10), [0, 0, 0, 0]);
        assert_eq!(at(&e.doc, 30, 10), [255, 255, 255, 255]);
    }

    #[test]
    fn stroke_erase_to_history_restores_the_snapshot() {
        let mut e = core_bg(255, 255, 255);
        let snap = e.snapshot();
        e.doc.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        let p = hard(&format!(r#","eraseToHistory":{snap}"#));
        stroke(&mut e, &p, &[10.5, 10.5, 1.0]);
        assert_eq!(at(&e.doc, 10, 10), [255, 255, 255, 255], "full coverage restores exactly");
        assert_eq!(at(&e.doc, 30, 10), [255, 0, 0, 255]);
        let other = e.doc.add_layer("other", 1).unwrap();
        let err = e.stroke_begin(other, "pixels", &p).unwrap_err();
        assert!(err.contains("snapshot"), "{err}");
    }

    #[test]
    fn aliased_stroke_keeps_alpha_binary() {
        let mut e = EngineCore::new(Document::new(256, 256, 8).unwrap());
        stroke(&mut e, &hard(r#","size":9"#), &[20.5, 20.5, 1.0, 40.5, 30.5, 1.0]);
        let f = e.doc.flatten_tile_rgba8(0, 0).unwrap();
        assert!(f.chunks_exact(4).any(|p| p[3] == 255), "the pencil painted");
        assert!(f.chunks_exact(4).all(|p| p[3] == 0 || p[3] == 255), "no soft edge");
    }

    #[test]
    fn stroke_on_a_16_bit_document() {
        let mut e = EngineCore::new(Document::new(256, 256, 16).unwrap());
        e.doc.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
        stroke(&mut e, &hard(r#","opacity":0.5"#), &[10.5, 10.5, 1.0]);
        assert_eq!(at(&e.doc, 10, 10), [128, 128, 128, 255]);
    }

    #[test]
    fn stroke_only_rewrites_tiles_under_the_dabs() {
        let mut e = EngineCore::new(Document::new(512, 512, 8).unwrap());
        e.doc.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
        let ids = |e: &EngineCore| {
            let list = manifest_value(&e.doc)["layers"][0]["tiles"].clone();
            (tile_id(&list, 0, 0), tile_id(&list, 1, 1))
        };
        let (a0, b0) = ids(&e);
        stroke(&mut e, &hard(""), &[10.5, 10.5, 1.0]);
        let (a1, b1) = ids(&e);
        assert_ne!(a1, a0, "the painted tile is new");
        assert_eq!(b1, b0, "an untouched tile keeps its id");
    }

    #[test]
    fn stroke_cancel_restores_the_original_tiles() {
        let mut e = core_bg(255, 255, 255);
        let id0 = tile_id(&manifest_value(&e.doc)["layers"][0]["tiles"], 0, 0);
        e.stroke_begin(1, "pixels", &hard("")).unwrap();
        e.stroke_to(&[10.5, 10.5, 1.0, 60.5, 60.5, 1.0]).unwrap();
        assert_eq!(at(&e.doc, 10, 10), [0, 0, 0, 255]);
        e.stroke_cancel().unwrap();
        assert_eq!(at(&e.doc, 10, 10), [255, 255, 255, 255]);
        assert_eq!(tile_id(&manifest_value(&e.doc)["layers"][0]["tiles"], 0, 0), id0, "the same tile id is back");
        assert!(e.stroke_cancel().is_err(), "the stroke is closed");
    }

    #[test]
    fn stroke_into_the_quick_mask_target() {
        let mut e = core_bg(255, 255, 255);
        e.stroke_begin(1, "selection", &hard(r#","rgba":[255,255,255,255],"size":20"#)).unwrap();
        e.stroke_to(&[10.5, 10.5, 1.0]).unwrap();
        e.stroke_end().unwrap();
        let sel = e.doc.selection.as_ref().expect("the stroke created a selection");
        assert_eq!(e.doc.sel_at(sel, 10, 10), 1.0);
        assert_eq!(e.doc.sel_at(sel, 40, 10), 0.0);
        assert_eq!(at(&e.doc, 10, 10), [255, 255, 255, 255], "the layer is untouched");
    }

    #[test]
    fn stroke_cancel_drops_a_quick_mask_selection_it_created() {
        let mut e = core_bg(255, 255, 255);
        e.stroke_begin(1, "selection", &hard("")).unwrap();
        e.stroke_to(&[10.5, 10.5, 1.0]).unwrap();
        e.stroke_cancel().unwrap();
        assert!(!e.doc.has_selection(), "there was no selection before the stroke");
    }

    #[test]
    fn stroke_to_returns_the_dirty_rect_and_nothing_when_idle() {
        let mut e = core_bg(255, 255, 255);
        e.stroke_begin(1, "pixels", &hard(r#","size":10"#)).unwrap();
        let r = e.stroke_to(&[100.5, 100.5, 1.0]).unwrap();
        assert_eq!(r.len(), 4);
        assert!(r[0] <= 95 && r[1] <= 95 && r[0] + r[2] >= 106 && r[1] + r[3] >= 106, "{r:?}");
        assert!(e.stroke_to(&[100.5, 100.5, 1.0]).unwrap().is_empty(), "a still pointer paints nothing");
        assert!(e.stroke_begin(1, "pixels", &hard("")).is_err(), "only one stroke at a time");
        e.stroke_end().unwrap();
        assert!(e.stroke_end().is_err());
    }

    #[test]
    fn stroke_rejects_bad_params() {
        let mut e = core_bg(255, 255, 255);
        assert!(e.stroke_begin(1, "pixels", r#"{"rgba":[0,0,0,255],"mode":"normal","size":10,"wet":true}"#).is_err());
        assert!(e.stroke_begin(1, "pixels", r#"{"rgba":[0,0,0,255],"mode":"nope","size":10}"#).is_err());
        assert!(e.stroke_begin(1, "pixels", r#"{"rgba":[0,0,0,255],"mode":"normal","size":0}"#).is_err());
        assert!(e.stroke_begin(1, "mask", &hard("")).is_err());
        e.stroke_begin(1, "pixels", &hard("")).unwrap();
        assert!(e.stroke_to(&[1.0, 2.0]).is_err(), "samples are x, y, pressure triples");
        assert!(e.stroke_to(&[1.0, f64::NAN, 1.0]).is_err());
    }

    #[test]
    fn pressure_scales_size_and_opacity() {
        let mut e = core_bg(255, 255, 255);
        stroke(&mut e, &hard(r#","size":20,"pressureSize":true,"pressureOpacity":true"#), &[30.5, 30.5, 0.5]);
        assert_eq!(at(&e.doc, 30, 30), [128, 128, 128, 255], "half pressure, half opacity");
        assert_eq!(at(&e.doc, 34, 30), [128, 128, 128, 255], "radius 5 at half size");
        assert_eq!(at(&e.doc, 36, 30), [255, 255, 255, 255]);
    }

    #[test]
    #[ignore = "timing guide, not a gate"]
    fn stroke_latency_on_a_4k_canvas() {
        let mut e = EngineCore::new(Document::new(3840, 2160, 8).unwrap());
        e.doc.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
        e.stroke_begin(1, "pixels", r#"{"rgba":[0,0,0,255],"mode":"normal","size":30}"#).unwrap();
        let t0 = std::time::Instant::now();
        let segments = 60;
        for i in 0..segments {
            let x = 100.0 + (i * 20) as f64;
            e.stroke_to(&[x, 500.0, 1.0]).unwrap();
        }
        let ms = t0.elapsed().as_secs_f64() * 1000.0 / segments as f64;
        println!("stroke_to: {ms:.3} ms per 20 px segment");
        e.stroke_end().unwrap();
    }
}
