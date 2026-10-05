#[path = "transform.rs"]
mod transform;
#[path = "warp.rs"]
mod warp;
#[path = "canvas.rs"]
mod canvas;
#[path = "smart.rs"]
mod smart;
#[path = "compositor.rs"]
mod compositor;
#[path = "vector.rs"]
mod vector;
#[path = "select.rs"]
mod select;
#[path = "manifest.rs"]
mod manifest;
#[path = "brush.rs"]
mod brush;
#[path = "retouch.rs"]
mod retouch;
#[path = "retouch_fx.rs"]
mod retouch_fx;
#[path = "guides.rs"]
mod guides;
#[path = "paths.rs"]
mod paths;
#[path = "glyphs.rs"]
pub mod glyphs;
#[path = "shapes.rs"]
pub(crate) mod shapes;
#[cfg(test)]
#[path = "doc_m3_tests.rs"]
mod m3_tests;
#[cfg(test)]
#[path = "doc_m4_tests.rs"]
mod m4_tests;
#[path = "filter_run.rs"]
mod filter_run;
#[path = "apply_image.rs"]
mod apply_image;
#[path = "align.rs"]
mod align;
pub use align::HdrAcc;
#[path = "color_mode.rs"]
pub mod color_mode;
#[path = "profile.rs"]
pub mod profile;
#[path = "proof.rs"]
pub mod proof;
pub use apply_image::{CalcOp, ImageSource, SourceTiles};
#[cfg(test)]
#[path = "doc_m5_tests.rs"]
mod m5_tests;
#[cfg(test)]
#[path = "retouch_tests.rs"]
mod retouch_tests;
pub use transform::{Lift, Remap};
pub use brush::EngineCore;
use brush::*;
use retouch::*;
use retouch_fx::*;
use compositor::*;
use manifest::*;

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::adjust::{self, Adjustment};
use crate::blend;
use crate::blend::{blend_channel, blend_hdr, blend_rgb, dissolve_hash, hdr_mode, paint_mask_value, paint_pixel, paint_pixel_hdr, Blend, PaintMode};
use crate::filters;
use crate::content::{check_psd, CompLayer, FillContent, Filter, GlobalLight, LayerComp, Link, PatternEntry, Smart, SmartFilter, StackMode, WarpMesh};
use crate::gradient;
use crate::livewire::{self, LiveWire};
use crate::path::{Artboard, DocVector, ShapeData, VectorMask};
use crate::pattern::Pattern;
use crate::region;
use crate::selection::{gaussian_kernel, Ellipse, MaskShape, Mode, Polygon, Rect, Shape};
use crate::styles::{self, BlendIf, Blending, Knockout, Style};
#[cfg(test)]
use crate::styles::BlendRange;
use crate::text::TextData;
use crate::stroke::{self, DualBrush, Dyn, PoseOverride, Sample, SampledTip, Source, Spacer, Tip, TipKind, TipShape};

pub const TILE: usize = 256;
const TILE_PIXELS: usize = TILE * TILE;
const TILE_BYTES_U8: usize = TILE_PIXELS * 4;
const TILE_BYTES_U16: usize = TILE_PIXELS * 4 * 2;
const MASK_BYTES_U8: usize = TILE_PIXELS;
const MASK_BYTES_U16: usize = TILE_PIXELS * 2;
const TILE_BYTES_F32: usize = TILE_PIXELS * 4 * 4;
const MANIFEST_FORMAT: &str = "photobaer-manifest";
const MANIFEST_VERSION: u32 = 8;
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

// A stored 32-bit value: finite and not negative; alpha also at most 1.
#[inline(always)]
fn float(v: f32, alpha: bool) -> f32 {
    let v = if v.is_finite() { v.max(0.0) } else if v > 0.0 { f32::MAX } else { 0.0 };
    if alpha {
        v.min(1.0)
    } else {
        v
    }
}

// round(x * max) clamped to 0..=max (halves away from zero, NaN -> 0). The f64 add is exact, so
// truncation equals f32::round without its library call.
#[inline(always)]
fn quantize(x: f32, max: f32) -> u32 {
    let y = x * max;
    if y > 0.0 {
        ((y as f64 + 0.5) as u32).min(max as u32)
    } else {
        0
    }
}

#[derive(Clone)]
pub enum Pixels {
    U8(Box<[u8]>),
    U16(Box<[u16]>),
    /// 32 bits per channel: straight RGBA floats, color above 1 kept.
    F32(Box<[f32]>),
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
            Pixels::F32(d) => [d[o], d[o + 1], d[o + 2], d[o + 3]],
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
            Pixels::F32(d) => {
                for i in 0..4 {
                    d[o + i] = float(v[i], i == 3);
                }
            }
            _ => {}
        }
    }

    fn transparent(depth: u8) -> Pixels {
        if depth == 8 {
            Pixels::U8(vec![0u8; TILE_PIXELS * 4].into_boxed_slice())
        } else if depth == 32 {
            Pixels::F32(vec![0f32; TILE_PIXELS * 4].into_boxed_slice())
        } else {
            Pixels::U16(vec![0u16; TILE_PIXELS * 4].into_boxed_slice())
        }
    }

    // Copies `n` pixels from `src` at `from` to `at`; both sides share the document depth.
    fn copy_run(&mut self, at: usize, src: &Pixels, from: usize, n: usize) {
        match (self, src) {
            (Pixels::U8(d), Pixels::U8(s)) => d[at * 4..(at + n) * 4].copy_from_slice(&s[from * 4..(from + n) * 4]),
            (Pixels::U16(d), Pixels::U16(s)) => d[at * 4..(at + n) * 4].copy_from_slice(&s[from * 4..(from + n) * 4]),
            (Pixels::F32(d), Pixels::F32(s)) => d[at * 4..(at + n) * 4].copy_from_slice(&s[from * 4..(from + n) * 4]),
            (Pixels::Mask8(d), Pixels::Mask8(s)) => d[at..at + n].copy_from_slice(&s[from..from + n]),
            (Pixels::Mask16(d), Pixels::Mask16(s)) => d[at..at + n].copy_from_slice(&s[from..from + n]),
            _ => unreachable!("tile depth differs from the document depth"),
        }
    }

    fn mask_filled(depth: u8, v: u32) -> Pixels {
        if depth == 8 {
            Pixels::Mask8(vec![v as u8; TILE_PIXELS].into_boxed_slice())
        } else {
            Pixels::Mask16(vec![v as u16; TILE_PIXELS].into_boxed_slice())
        }
    }

    fn any_alpha(&self) -> bool {
        match self {
            Pixels::U8(d) => d.chunks_exact(4).any(|p| p[3] > 0),
            Pixels::U16(d) => d.chunks_exact(4).any(|p| p[3] > 0),
            Pixels::F32(d) => d.chunks_exact(4).any(|p| p[3] > 0.0),
            _ => true,
        }
    }

    // Tile-local [x0, y0, x1) x [y0, y1) around the pixels with alpha > 0; None for masks.
    fn alpha_rect(&self) -> Option<(i32, i32, i32, i32)> {
        fn scan<T: Copy + Default + PartialEq>(d: &[T]) -> Option<(i32, i32, i32, i32)> {
            let mut r: Option<(i32, i32, i32, i32)> = None;
            for (y, row) in d.chunks_exact(TILE * 4).enumerate() {
                let Some(a) = row.chunks_exact(4).position(|p| p[3] != T::default()) else { continue };
                let b = row.chunks_exact(4).rposition(|p| p[3] != T::default()).expect("a was found");
                let (y, a, b) = (y as i32, a as i32, b as i32 + 1);
                r = Some(r.map_or((a, y, b, y + 1), |r| (r.0.min(a), r.1, r.2.max(b), y + 1)));
            }
            r
        }
        match self {
            Pixels::U8(d) => scan(d),
            Pixels::U16(d) => scan(d),
            Pixels::F32(d) => scan(d),
            _ => None,
        }
    }

    fn byte_len(&self) -> usize {
        match self {
            Pixels::U8(d) | Pixels::Mask8(d) => d.len(),
            Pixels::U16(d) => d.len() * 2,
            Pixels::Mask16(d) => d.len() * 2,
            Pixels::F32(d) => d.len() * 4,
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
            Pixels::F32(d) => d.iter().flat_map(|v| v.to_le_bytes()).collect(),
        }
    }

    fn from_bytes(depth: u8, mask: bool, bytes: &[u8]) -> Result<Pixels, String> {
        let want = match (depth, mask) {
            (8, false) => TILE_BYTES_U8,
            (8, true) => MASK_BYTES_U8,
            (32, false) => TILE_BYTES_F32,
            (_, false) => TILE_BYTES_U16,
            (_, true) => MASK_BYTES_U16,
        };
        if bytes.len() != want {
            return Err(format!("expected {want} bytes, got {}", bytes.len()));
        }
        Ok(match (depth, mask) {
            (8, false) => Pixels::U8(bytes.to_vec().into_boxed_slice()),
            (8, true) => Pixels::Mask8(bytes.to_vec().into_boxed_slice()),
            (32, false) => Pixels::F32(
                bytes.chunks_exact(4).enumerate().map(|(i, c)| float(f32::from_le_bytes([c[0], c[1], c[2], c[3]]), i % 4 == 3)).collect(),
            ),
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
        } else if depth == 32 {
            Pixels::F32(rgba8.iter().map(|v| *v as f32 / 255.0).collect())
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
        if depth == 8 {
            Pixels::U8(v.iter().map(|x| quantize(*x, max) as u8).collect::<Vec<_>>().into_boxed_slice())
        } else if depth == 32 {
            Pixels::F32(v.iter().enumerate().map(|(i, x)| float(*x, i % 4 == 3)).collect())
        } else {
            Pixels::U16(v.iter().map(|x| quantize(*x, max) as u16).collect::<Vec<_>>().into_boxed_slice())
        }
    }

    fn mask_from_norm(depth: u8, v: &[f32]) -> Pixels {
        let max = max_value(depth) as f32;
        if depth == 8 {
            Pixels::Mask8(v.iter().map(|x| quantize(*x, max) as u8).collect::<Vec<_>>().into_boxed_slice())
        } else {
            Pixels::Mask16(v.iter().map(|x| quantize(*x, max) as u16).collect::<Vec<_>>().into_boxed_slice())
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
            Pixels::F32(d) => {
                let mut out = d.clone();
                for (i, v) in out.iter_mut().enumerate() {
                    if i % 4 != 3 {
                        *v = (1.0 - *v).max(0.0);
                    }
                }
                Pixels::F32(out)
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
            Pixels::F32(d) => {
                let mut out = d.clone();
                for p in out.chunks_exact_mut(4) {
                    p[..3].copy_from_slice(&[r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0]);
                }
                Pixels::F32(out)
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

/// `fill_ex`'s color source (B6 spec v1 Part E1).
pub enum FillSource {
    Solid([u8; 4]),
    /// A 32-bit solid color (straight RGBA, color values may exceed 1).
    SolidHdr([f32; 4]),
    Pattern(Arc<Pattern>),
    /// The same layer id's pixel tiles in a history snapshot.
    History(Tiles),
    /// Straight RGBA in document coords; transparent outside the plane.
    Plane(filters::Plane),
}

/// Fill's per-pixel color and alpha at document coords `(gx, gy)` (B6 spec v1 Part E1): a solid
/// color, a tiled pattern (scale 1, angle 0, from the document origin, own RGBA), or a history
/// snapshot's straight rgba, `hist_tile`/`p` being that tile and pixel index when `src` is History.
fn fill_src_sample(src: &FillSource, hist_tile: Option<&Pixels>, p: usize, gx: i32, gy: i32) -> ([f32; 3], f32) {
    match src {
        FillSource::Solid([r, g, b, a]) => {
            ([*r as f32 / 255.0, *g as f32 / 255.0, *b as f32 / 255.0], *a as f32 / 255.0)
        }
        FillSource::SolidHdr([r, g, b, a]) => ([*r, *g, *b], *a),
        FillSource::Pattern(pat) => {
            let [r, g, b, a] = pat.sample_rgba(gx, gy, 1.0);
            ([r, g, b], a)
        }
        FillSource::History(_) => {
            let hp = hist_tile.map_or([0.0; 4], |px| px.rgba_f32(p));
            ([hp[0], hp[1], hp[2]], hp[3])
        }
        FillSource::Plane(pl) => {
            let (x, y) = (gx - pl.x, gy - pl.y);
            if x < 0 || y < 0 || x as usize >= pl.w || y as usize >= pl.h {
                return ([0.0; 3], 0.0);
            }
            let i = (y as usize * pl.w + x as usize) * 4;
            ([pl.data[i], pl.data[i + 1], pl.data[i + 2]], pl.data[i + 3])
        }
    }
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
    f: &impl Fn(usize, [f32; 4]) -> [f32; 4],
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
            let nw = f(p, ob);
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
    /// A spot channel's ink; its mask is ink coverage inverted (white: no ink). None for alpha.
    pub spot: Option<Spot>,
}

/// Spot channel ink: display color and on-screen solidity 0..1 (manifest v8).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spot {
    pub color: [u8; 3],
    pub solidity: f32,
}

impl Spot {
    pub fn check(&self) -> Result<(), String> {
        if (0.0..=1.0).contains(&self.solidity) { Ok(()) } else { Err("spot solidity must be within 0..1".into()) }
    }
}

#[derive(Clone)]
pub enum Kind {
    Pixel(Tiles),
    Group(Vec<Node>),
    /// No pixels; unbounded, its mask bounds it.
    Adjustment(Adjustment),
    /// No pixels; unbounded, its mask bounds it.
    Fill(FillContent),
    Smart(Box<Smart>),
    /// No stored pixels; drawn from its path.
    Shape(Box<ShapeData>),
    Text(Box<Text>),
}

/// A type layer: its model and the rendered or imported pixels (D5), none until rendered.
#[derive(Clone)]
pub struct Text {
    pub data: TextData,
    pub cache: Option<Tiles>,
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
    pub style: Option<Style>,
    pub blending: Blending,
    pub vector_mask: Option<VectorMask>,
    /// Only on a top-level group (D14).
    pub artboard: Option<Artboard>,
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
            style: None,
            blending: Blending::default(),
            vector_mask: None,
            artboard: None,
        }
    }

    fn is_group(&self) -> bool {
        matches!(self.kind, Kind::Group(_))
    }

    /// Whether this node or a descendant is an artboard.
    fn holds_artboard(&self) -> bool {
        self.artboard.is_some() || matches!(&self.kind, Kind::Group(ch) if ch.iter().any(Node::holds_artboard))
    }

    fn kind_name(&self) -> &'static str {
        match self.kind {
            Kind::Pixel(_) => "pixel",
            Kind::Group(_) => "group",
            Kind::Adjustment(_) => "adjustment",
            Kind::Fill(_) => "fill",
            Kind::Smart(_) => "smart",
            Kind::Shape(_) => "shape",
            Kind::Text(_) => "text",
        }
    }

    fn no_pixels(&self) -> String {
        if matches!(self.kind, Kind::Shape(_) | Kind::Text(_)) {
            return format!("This {} layer must be rasterized before its pixels can be edited.", self.kind_name());
        }
        let what = match self.kind {
            Kind::Adjustment(_) => "an adjustment layer",
            Kind::Fill(_) => "a fill layer",
            _ => "a group",
        };
        format!("node {} is {what} and has no pixels", self.id)
    }

    // A smart object's pixels are its cache.
    fn pixel_tiles(&self) -> Result<&Tiles, String> {
        match &self.kind {
            Kind::Pixel(t) => Ok(t),
            Kind::Smart(s) => Ok(&s.cache),
            _ => Err(self.no_pixels()),
        }
    }

    fn pixel_tiles_mut(&mut self) -> Result<&mut Tiles, String> {
        let msg = self.no_pixels();
        match &mut self.kind {
            Kind::Pixel(t) => Ok(t),
            Kind::Smart(s) => Ok(&mut s.cache),
            _ => Err(msg),
        }
    }

    fn smart_mut(&mut self) -> &mut Smart {
        match &mut self.kind {
            Kind::Smart(s) => s,
            _ => unreachable!("a smart slot points at a smart node"),
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
            _ => unreachable!("a node path only walks through groups"),
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
            _ => unreachable!("a node path only walks through groups"),
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
    Source(Vec<usize>),
    FilterMask(Vec<usize>, usize),
    StackMask(Vec<usize>),
    TextCache(Vec<usize>),
    Selection,
    LastSelection,
    Channel(usize),
}

#[derive(Clone)]
struct Loading {
    // tile id -> (is_mask, [(slot, tx, ty)]) still waiting for pixel data.
    slots: HashMap<u64, (bool, Vec<(Slot, i32, i32)>)>,
    // Blob ids still waiting for their bytes.
    blobs: HashSet<u64>,
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
    global_light: GlobalLight,
    patterns: Vec<PatternEntry>,
    layer_comps: Vec<LayerComp>,
    vector: DocVector,
    // Immutable bytes (smart sources, pattern pixels, lookup tables) with ids from `next_id`.
    blobs: HashMap<u64, Arc<Vec<u8>>>,
    next_id: u64,
    next_node_id: u32,
    loading: Option<Loading>,
    // Reduced tiles for display levels >= 1, keyed by content, shared by clones. Never persisted.
    tile_cache: Arc<RefCell<TileCache>>,
    // Compiled `Adjust` data by params key: (opcode, data key, data); none = neutral.
    adjust_cache: RefCell<HashMap<u64, Option<(u32, u64, Arc<Vec<f32>>)>>>,
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
    if depth != 8 && depth != 16 && depth != 32 {
        return Err("depth must be 8, 16 or 32".into());
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
            global_light: GlobalLight::default(),
            patterns: Vec::new(),
            layer_comps: Vec::new(),
            vector: DocVector::default(),
            blobs: HashMap::new(),
            next_id: 1,
            next_node_id: 2,
            loading: None,
            tile_cache: Arc::new(RefCell::new(TileCache::default())),
            adjust_cache: RefCell::default(),
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

    fn add_node(&mut self, name: &str, above: u32, kind: Kind) -> Result<u32, String> {
        self.check_idle()?;
        let at = if above == 0 {
            None
        } else {
            Some(self.find_path(above)?)
        };
        let id = self.alloc_node_id();
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
        self.add_node(name, above, Kind::Pixel(Tiles::default()))
    }

    pub fn add_group(&mut self, name: &str, above: u32) -> Result<u32, String> {
        self.add_node(name, above, Kind::Group(Vec::new()))
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
        if paths.iter().any(|p| node_at(&self.nodes, p).holds_artboard()) {
            return Err("Artboards cannot be nested.".into());
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
            if node_at(&self.nodes, &src).holds_artboard() {
                return Err("Artboards cannot be nested.".into());
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
        node.pixel_tiles()?;
        if node.locks.pixels {
            return Err("layer pixels are locked".into());
        }
        Ok(())
    }

    /// `check_pixel_edit`, and refuses a direct pixel write on a smart object's render cache
    /// (paint/fill/stroke/gradient/bucket): it is rebuilt on the next re-render and would lose it.
    fn check_pixel_paint(&self, id: u32) -> Result<(), String> {
        self.check_pixel_edit(id)?;
        if matches!(self.node(id)?.kind, Kind::Smart(_)) {
            return Err("This smart object must be rasterized before its pixels can be edited.".into());
        }
        Ok(())
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
        self.edit_pixel_tiles_at(id, area, keep_alpha, |_, _, c| f(c))
    }

    // `edit_pixel_tiles` with `f` also given the tile and the pixel index in it.
    fn edit_pixel_tiles_at(
        &mut self,
        id: u32,
        area: &[(i32, i32)],
        keep_alpha: bool,
        f: impl Fn((i32, i32), usize, [f32; 4]) -> [f32; 4],
    ) -> Result<(), String> {
        let depth = self.depth;
        let selected = self.selection.is_some();
        let mut fresh: Vec<((i32, i32), Option<Pixels>)> = Vec::with_capacity(area.len());
        for &(tx, ty) in area {
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let old = self.node(id)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
            let px = edit_rgba(depth, old.as_deref(), &cov, keep_alpha, &|p, c| f((tx, ty), p, c));
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

    /// Channels panel color target: tiles of layer `id` that changed since `before` take the
    /// color channels not in `keep` back from `before` (missing tiles read as 0); alpha stays new.
    pub fn keep_channels(&mut self, id: u32, before: &Tiles, keep: [bool; 3]) -> Result<(), String> {
        fn mix<T: Copy + Default>(new: &[T], old: Option<&[T]>, keep: [bool; 3]) -> Box<[T]> {
            let mut out = new.to_vec();
            for (i, v) in out.iter_mut().enumerate() {
                if i % 4 < 3 && !keep[i % 4] {
                    *v = old.map_or(T::default(), |o| o[i]);
                }
            }
            out.into_boxed_slice()
        }
        let changed: Vec<((i32, i32), Tile)> = self
            .node(id)?
            .pixel_tiles()?
            .iter()
            .filter(|(at, t)| before.id_at(at.0, at.1) != t.id)
            .map(|(&at, t)| (at, t.clone()))
            .collect();
        let mut out = Vec::with_capacity(changed.len());
        for ((tx, ty), t) in changed {
            let old = before.get(tx, ty).map(|o| o.px.clone());
            let px = match (&*t.px, old.as_deref()) {
                (Pixels::U8(n), o) => Pixels::U8(mix(n, o.and_then(|o| if let Pixels::U8(o) = o { Some(&o[..]) } else { None }), keep)),
                (Pixels::U16(n), o) => Pixels::U16(mix(n, o.and_then(|o| if let Pixels::U16(o) = o { Some(&o[..]) } else { None }), keep)),
                (Pixels::F32(n), o) => Pixels::F32(mix(n, o.and_then(|o| if let Pixels::F32(o) = o { Some(&o[..]) } else { None }), keep)),
                _ => continue,
            };
            out.push(((tx, ty), Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in out {
            tiles.put(tx, ty, Some(t));
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
        self.check_pixel_paint(id)?;
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
                // The region is the canvas: pixels outside it stay as they are.
                let (w, h, t) = (self.width as i32, self.height as i32, TILE as i32);
                let mut rgba = vec![0u8; TILE_BYTES_U8];
                for px in rgba.chunks_exact_mut(4) {
                    px.copy_from_slice(&[r, g, b, a]);
                }
                let full = Arc::new(Pixels::from_rgba8(depth, &rgba));
                let full_id = self.alloc_tile_id();
                let color = [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, a as f32 / 255.0];
                let old = self.node(id)?.pixel_tiles()?.clone();
                let mut fresh = Vec::new();
                let mut buf = vec![0f32; TILE_PIXELS * 4];
                for ty in 0..self.tiles_y() as i32 {
                    for tx in 0..self.tiles_x() as i32 {
                        let (ox, oy) = (tx * t, ty * t);
                        let prev = old.get(tx, ty);
                        let tile = if ox + t <= w && oy + t <= h {
                            (a > 0).then(|| Tile { id: full_id, px: full.clone() })
                        } else {
                            for p in 0..TILE_PIXELS {
                                let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                                let v = if x < w && y < h { color } else { prev.map_or([0.0; 4], |o| o.px.rgba_f32(p)) };
                                buf[p * 4..p * 4 + 4].copy_from_slice(&v);
                            }
                            let px = Pixels::from_straight(depth, &buf);
                            px.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })
                        };
                        fresh.push((tx, ty, tile));
                    }
                }
                let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
                for (tx, ty, tile) in fresh {
                    tiles.put(tx, ty, tile);
                }
                return Ok(());
            }
        };
        let new = [r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0, a as f32 / 255.0];
        self.edit_pixel_tiles(id, &area, keep_alpha, move |_| new)
    }

    /// Pixels become transparent, a mask becomes 0; the selection limits the effect.
    pub fn clear(&mut self, id: u32, target: Target) -> Result<(), String> {
        self.clear_inner(id, target, true)
    }

    /// `clear` that allows a smart object's cache: a whole-layer transform session hides the
    /// layer this way and always re-renders it from the source.
    pub fn clear_lifted(&mut self, id: u32, target: Target) -> Result<(), String> {
        self.clear_inner(id, target, false)
    }

    fn clear_inner(&mut self, id: u32, target: Target, paint: bool) -> Result<(), String> {
        self.check_idle()?;
        if target == Target::Mask || target == Target::Selection {
            return self.fill(id, target, 0, 0, 0, 0);
        }
        // A transform session lifts a whole shape: it draws nothing until the session ends.
        if let (false, Kind::Shape(s)) = (paint, &mut self.node_mut(id)?.kind) {
            s.path.subpaths.clear();
            return Ok(());
        }
        if paint { self.check_pixel_paint(id)? } else { self.check_pixel_edit(id)? }
        let area = match self.selected_tiles() {
            Some(a) => a,
            None => {
                self.node_mut(id)?.pixel_tiles_mut()?.clear();
                return Ok(());
            }
        };
        self.edit_pixel_tiles(id, &area, false, |_| [0.0; 4])
    }

    /// Fill (B6 spec v1 Part E1 / item 2b): `target` is pixels, the layer mask (painted with the
    /// source's luminance, through the same selection-gated weighting) or the selection/quick
    /// mask (no outer selection to clip it by, like `paint_coverage_selection`).
    pub fn fill_ex(
        &mut self,
        id: u32,
        target: Target,
        src: &FillSource,
        mode: PaintMode,
        opacity: f32,
        preserve_transparency: bool,
    ) -> Result<(), String> {
        self.check_idle()?;
        let opacity = opacity.clamp(0.0, 1.0);
        match target {
            Target::Pixels => self.fill_ex_pixels(id, src, mode, opacity, preserve_transparency).map(|_| ()),
            Target::Mask => self.fill_ex_mask(id, src, mode, opacity),
            Target::Selection => self.fill_ex_selection(src, mode, opacity),
        }
    }

    fn fill_ex_pixels(
        &mut self,
        id: u32,
        src: &FillSource,
        mode: PaintMode,
        opacity: f32,
        preserve_transparency: bool,
    ) -> Result<bool, String> {
        self.check_pixel_paint(id)?;
        let keep_alpha = preserve_transparency || self.node(id)?.locks.transparency;
        let (depth, hdr) = (self.depth, self.depth == 32);
        let (w, h) = (self.width as i32, self.height as i32);
        let [rx, ry, rw, rh] = self.selection_bounds().unwrap_or([0, 0, w, h]);
        if rw <= 0 || rh <= 0 {
            return Ok(false);
        }
        let mut changed = false;
        let selected = self.selection.is_some();
        let mut out: Vec<((i32, i32), Option<Pixels>)> = Vec::new();
        for (tx, ty) in self.tiles_of_rect(rx, ry, rx + rw, ry + rh) {
            let old_tile = self.node(id)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let hist_tile = match src {
                FillSource::History(tiles) => tiles.get(tx, ty).map(|t| t.px.clone()),
                _ => None,
            };
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let mut fresh = vec![0f32; TILE_PIXELS * 4];
            let (mut any, mut touched) = (false, false);
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let old = old_tile.as_deref().map_or([0.0; 4], |px| px.rgba_f32(p));
                    let (gx, gy) = (ox + px_, oy + py);
                    let new = if gx < rx || gx >= rx + rw || gy < ry || gy >= ry + rh {
                        old
                    } else {
                        let (src_rgb, src_a) = fill_src_sample(src, hist_tile.as_deref(), p, gx, gy);
                        let u = cov.at(p).clamp(0.0, 1.0);
                        let c = (src_a * u * opacity).clamp(0.0, 1.0);
                        paint_pixel_hdr(mode, old, src_rgb, c, keep_alpha, hdr)
                    };
                    any |= new[3] > 0.0;
                    touched |= new != old;
                    fresh[p * 4..p * 4 + 4].copy_from_slice(&new);
                }
            }
            let px = any.then(|| Pixels::from_straight(depth, &fresh));
            // A change counts once it survives the tile's quantization.
            changed |= touched
                && (0..TILE_PIXELS).any(|p| {
                    let stored = |t: Option<&Pixels>| t.map_or([0.0; 4], |t| t.rgba_f32(p));
                    stored(px.as_ref()) != stored(old_tile.as_deref())
                });
            out.push(((tx, ty), px));
        }
        let mut tiles_out = Vec::with_capacity(out.len());
        for (at, px) in out {
            tiles_out.push((at, px.map(|px| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in tiles_out {
            tiles.put(tx, ty, t);
        }
        Ok(changed)
    }

    /// Edit > Content-Aware Fill (docs/M5.md section 10): fills the selection (or the layer) from
    /// the layer pixels around it, applied like Fill; true when a pixel changed.
    pub fn content_aware_fill(
        &mut self,
        id: u32,
        structure: f32,
        color: f32,
        opts: Option<(PaintMode, f32, bool)>,
        deselect: bool,
    ) -> Result<bool, String> {
        self.check_idle()?;
        let node = self.node(id)?;
        if !matches!(node.kind, Kind::Pixel(_)) {
            return Err("Content-Aware Fill needs a pixel layer.".into());
        }
        if node.locks.pixels {
            return Err(format!("{} is locked.", node.name));
        }
        let doc = [0, 0, self.width as i32, self.height as i32];
        let Some(lb) = self.layer_bounds(id)? else { return Ok(false) };
        let e = transform::intersect(if self.selection.is_some() { self.selection_bounds().unwrap_or([0; 4]) } else { lb }, doc);
        if e[2] <= 0 || e[3] <= 0 {
            return Ok(false);
        }
        let m = 24.max((e[2].max(e[3]) + 1) / 2);
        let g = transform::intersect(transform::intersect([e[0] - m, e[1] - m, e[2] + 2 * m, e[3] + 2 * m], doc), lb);
        if g[2] <= 0 || g[3] <= 0 {
            return Ok(false);
        }
        let (w, h, ti) = (g[2] as usize, g[3] as usize, TILE as i32);
        let tiles = node.pixel_tiles()?;
        let (mut data, mut cov) = (vec![0f32; w * h * 4], vec![1f32; w * h]);
        for j in 0..h {
            for i in 0..w {
                let (x, y) = (g[0] + i as i32, g[1] + j as i32);
                let p = (y.rem_euclid(ti) * ti + x.rem_euclid(ti)) as usize;
                let v = tiles.get(x.div_euclid(ti), y.div_euclid(ti)).map_or([0.0; 4], |t| t.px.rgba_f32(p));
                data[(j * w + i) * 4..][..4].copy_from_slice(&v);
                // Hard hole: fill_ex_pixels applies the selection coverage once.
                if let Some(sel) = &self.selection {
                    cov[j * w + i] = if self.sel_at(sel, x, y) > 0.0 { 1.0 } else { 0.0 };
                }
            }
        }
        let img = filters::Plane { x: g[0], y: g[1], w, h, data };
        let fill = crate::heal::content_aware_fill(&img, &cov, structure, color, 1346916180, None);
        let (mode, opacity, preserve) = opts.unwrap_or((PaintMode::Blend(Blend::Normal), 1.0, false));
        let changed = self.fill_ex_pixels(id, &FillSource::Plane(fill), mode, opacity.clamp(0.0, 1.0), preserve)?;
        if changed && deselect {
            self.deselect()?;
        }
        Ok(changed)
    }

    /// Layer mask target (item 2b): same `p = srcA * u * opacity` weighting as the pixel fill, but
    /// the painted value is the source's luminance and there is no transparency to preserve.
    fn fill_ex_mask(&mut self, id: u32, src: &FillSource, mode: PaintMode, opacity: f32) -> Result<(), String> {
        let depth = self.depth;
        self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?;
        let (w, h) = (self.width as i32, self.height as i32);
        let [rx, ry, rw, rh] = self.selection_bounds().unwrap_or([0, 0, w, h]);
        if rw <= 0 || rh <= 0 {
            return Ok(());
        }
        let selected = self.selection.is_some();
        let mut out: Vec<((i32, i32), Option<Pixels>)> = Vec::new();
        for (tx, ty) in self.tiles_of_rect(rx, ry, rx + rw, ry + rh) {
            let old_tile = self.node(id)?.mask.as_ref().expect("checked").tiles.get(tx, ty).map(|t| t.px.clone());
            let default = self.node(id)?.mask.as_ref().expect("checked").default;
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let hist_tile = match src {
                FillSource::History(tiles) => tiles.get(tx, ty).map(|t| t.px.clone()),
                _ => None,
            };
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let def = default as f32 / max_value(depth) as f32;
            let mut fresh = vec![0f32; TILE_PIXELS];
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let old = old_tile.as_deref().map_or(def, |px| px.mask_f32(p));
                    let (gx, gy) = (ox + px_, oy + py);
                    fresh[p] = if gx < rx || gx >= rx + rw || gy < ry || gy >= ry + rh {
                        old
                    } else {
                        let (src_rgb, src_a) = fill_src_sample(src, hist_tile.as_deref(), p, gx, gy);
                        let u = cov.at(p).clamp(0.0, 1.0);
                        let c = (src_a * u * opacity).clamp(0.0, 1.0);
                        paint_mask_value(mode, old, blend::lum(src_rgb), c)
                    };
                }
            }
            let px = Pixels::mask_from_norm(depth, &fresh);
            let uniform = match &px {
                Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == default),
                Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == default),
                _ => false,
            };
            out.push(((tx, ty), (!uniform).then_some(px)));
        }
        let mut tiles_out = Vec::with_capacity(out.len());
        for (at, px) in out {
            tiles_out.push((at, px.map(|px| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let m = self.node_mut(id)?.mask.as_mut().expect("checked");
        for ((tx, ty), t) in tiles_out {
            m.tiles.put(tx, ty, t);
        }
        Ok(())
    }

    /// Selection / quick mask target (item 2b): paints into the selection itself, as if it were a
    /// layer mask (mirrors `paint_coverage_selection`); there is no outer selection to clip it by,
    /// so `u = 1` and the region is always the whole document.
    fn fill_ex_selection(&mut self, src: &FillSource, mode: PaintMode, opacity: f32) -> Result<(), String> {
        let (w, h) = (self.width as i32, self.height as i32);
        let mut sel = self.selection.take().unwrap_or_default();
        for (tx, ty) in self.tiles_of_rect(0, 0, w, h) {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let hist_tile = match src {
                FillSource::History(tiles) => tiles.get(tx, ty).map(|t| t.px.clone()),
                _ => None,
            };
            let mut values = vec![0f32; TILE_PIXELS];
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let (gx, gy) = (ox + px_, oy + py);
                    let old = self.sel_at(&sel, gx, gy);
                    if gx >= w || gy >= h {
                        values[p] = old;
                        continue;
                    }
                    let (src_rgb, src_a) = fill_src_sample(src, hist_tile.as_deref(), p, gx, gy);
                    let c = (src_a * opacity).clamp(0.0, 1.0);
                    values[p] = paint_mask_value(mode, old, blend::lum(src_rgb), c);
                }
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    /// Stroke ring (B6 spec v1 Part E2): `width` in document px (rounded, clamped 1..250),
    /// `location` inside/center/outside. Errors without a selection or on an empty ring; applies
    /// through `fill_ex` with the ring standing in for the selection, then restores it.
    pub fn stroke_selection(
        &mut self,
        id: u32,
        width: f32,
        rgba: [u8; 4],
        location: &str,
        mode: PaintMode,
        opacity: f32,
        preserve_transparency: bool,
    ) -> Result<(), String> {
        self.check_idle()?;
        if self.selection.is_none() {
            return Err("Make a selection to stroke.".into());
        }
        self.check_pixel_paint(id)?;
        let w_px = width.round().clamp(1.0, 250.0);
        let s = self.selection_values();
        let (w, h) = (self.width, self.height);
        let sub = |a: &[f32], b: &[f32]| -> Vec<f32> { a.iter().zip(b).map(|(&x, &y)| (x - y).max(0.0)).collect() };
        let ring = match location {
            "outside" => {
                let e = region::expand_soft(&s, w, h, w_px, false);
                sub(&e, &s)
            }
            "center" => {
                let e = region::expand_soft(&s, w, h, (w_px / 2.0).ceil(), false);
                let c = region::contract_soft(&s, w, h, (w_px / 2.0).floor(), false);
                sub(&e, &c)
            }
            "inside" => {
                let c = region::contract_soft(&s, w, h, w_px, false);
                sub(&s, &c)
            }
            other => return Err(format!("unknown stroke location {other}")),
        };
        if ring.iter().all(|&v| v <= 0.0) {
            return Err("Stroke produced no pixels.".into());
        }
        let saved = self.selection.take();
        self.select_shape(&MaskShape::new(w as i32, h as i32, ring), Mode::New)?;
        let result = self.fill_ex(id, Target::Pixels, &FillSource::Solid(rgba), mode, opacity, preserve_transparency);
        self.selection = saved;
        result
    }

    /// Gradient render (B6 spec v1 Part E3): normalizes the stops, reverses them if asked, builds
    /// a 1024-entry LUT, then paints per pixel at `t = style_t(pixel centre - start, end - start)`,
    /// dithering R/G/B (not alpha) and forcing alpha to 1 when `transparency` is off, through the
    /// same region/coverage/target dispatch as `fill_ex`.
    #[allow(clippy::too_many_arguments)]
    pub fn gradient(
        &mut self,
        id: u32,
        target: Target,
        color_stops: Vec<gradient::ColorStop>,
        opacity_stops: Vec<gradient::OpacityStop>,
        method: gradient::Method,
        style: gradient::Style,
        start: (f64, f64),
        end: (f64, f64),
        reverse: bool,
        dither: bool,
        transparency: bool,
        opacity: f32,
    ) -> Result<(), String> {
        self.check_idle()?;
        let mut color_stops = gradient::normalize_color_stops(color_stops);
        let mut opacity_stops = gradient::normalize_opacity_stops(opacity_stops);
        if reverse {
            color_stops = gradient::reverse_color_stops(&color_stops);
            opacity_stops = gradient::reverse_opacity_stops(&opacity_stops);
        }
        let lut = gradient::build_lut(&color_stops, &opacity_stops, method);
        let opacity = opacity.clamp(0.0, 1.0);
        let (dx, dy) = (end.0 - start.0, end.1 - start.1);
        let l2 = dx * dx + dy * dy;
        let sample = |gx: i32, gy: i32| -> [f32; 4] {
            let (px, py) = (gx as f64 + 0.5 - start.0, gy as f64 + 0.5 - start.1);
            let t = gradient::style_t(style, px, py, dx, dy, l2);
            let [mut r, mut g, mut b, mut a] = gradient::lut_lookup(&lut, t);
            if dither {
                let d = gradient::dither_delta(gx, gy);
                r = (r + d).clamp(0.0, 1.0);
                g = (g + d).clamp(0.0, 1.0);
                b = (b + d).clamp(0.0, 1.0);
            }
            if !transparency {
                a = 1.0;
            }
            [r, g, b, a]
        };
        match target {
            Target::Pixels => self.gradient_pixels(id, &sample, opacity),
            Target::Mask => self.gradient_mask(id, &sample, opacity),
            Target::Selection => self.gradient_selection(id, &sample, opacity),
        }
    }

    /// The raster-mode region (B6 spec v1 Part E3): selection bounds ∩ doc, else the layer's
    /// non-transparent tight bounds ∩ doc, else the doc.
    fn gradient_region(&self, id: u32) -> Result<[i32; 4], String> {
        let (w, h) = (self.width as i32, self.height as i32);
        let clip = |b: [i32; 4]| -> [i32; 4] {
            let (x0, y0) = (b[0].max(0), b[1].max(0));
            let (x1, y1) = ((b[0] + b[2]).min(w), (b[1] + b[3]).min(h));
            [x0, y0, (x1 - x0).max(0), (y1 - y0).max(0)]
        };
        if let Some(b) = self.selection_bounds() {
            return Ok(clip(b));
        }
        if let Some(b) = self.layer_bounds(id)? {
            return Ok(clip(b));
        }
        Ok([0, 0, w, h])
    }

    fn gradient_pixels(&mut self, id: u32, sample: &impl Fn(i32, i32) -> [f32; 4], opacity: f32) -> Result<(), String> {
        self.check_pixel_paint(id)?;
        let keep_alpha = self.node(id)?.locks.transparency;
        let depth = self.depth;
        let [rx, ry, rw, rh] = self.gradient_region(id)?;
        if rw <= 0 || rh <= 0 {
            return Ok(());
        }
        let selected = self.selection.is_some();
        let mut out: Vec<((i32, i32), Option<Pixels>)> = Vec::new();
        for (tx, ty) in self.tiles_of_rect(rx, ry, rx + rw, ry + rh) {
            let old_tile = self.node(id)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let mut fresh = vec![0f32; TILE_PIXELS * 4];
            let mut any = false;
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let old = old_tile.as_deref().map_or([0.0; 4], |px| px.rgba_f32(p));
                    let (gx, gy) = (ox + px_, oy + py);
                    let new = if gx < rx || gx >= rx + rw || gy < ry || gy >= ry + rh {
                        old
                    } else {
                        let [r, g, b, a] = sample(gx, gy);
                        let u = cov.at(p).clamp(0.0, 1.0);
                        let c = (a * u * opacity).clamp(0.0, 1.0);
                        paint_pixel(PaintMode::Blend(Blend::Normal), old, [r, g, b], c, keep_alpha)
                    };
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

    /// Layer mask target: same coverage weighting as the pixel path, painted as the sampled
    /// colour's luminance (mirrors `fill_ex_mask`).
    fn gradient_mask(&mut self, id: u32, sample: &impl Fn(i32, i32) -> [f32; 4], opacity: f32) -> Result<(), String> {
        let depth = self.depth;
        self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?;
        let [rx, ry, rw, rh] = self.gradient_region(id)?;
        if rw <= 0 || rh <= 0 {
            return Ok(());
        }
        let selected = self.selection.is_some();
        let mut out: Vec<((i32, i32), Option<Pixels>)> = Vec::new();
        for (tx, ty) in self.tiles_of_rect(rx, ry, rx + rw, ry + rh) {
            let old_tile = self.node(id)?.mask.as_ref().expect("checked").tiles.get(tx, ty).map(|t| t.px.clone());
            let default = self.node(id)?.mask.as_ref().expect("checked").default;
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let def = default as f32 / max_value(depth) as f32;
            let mut fresh = vec![0f32; TILE_PIXELS];
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let old = old_tile.as_deref().map_or(def, |px| px.mask_f32(p));
                    let (gx, gy) = (ox + px_, oy + py);
                    fresh[p] = if gx < rx || gx >= rx + rw || gy < ry || gy >= ry + rh {
                        old
                    } else {
                        let [r, g, b, a] = sample(gx, gy);
                        let u = cov.at(p).clamp(0.0, 1.0);
                        let c = (a * u * opacity).clamp(0.0, 1.0);
                        paint_mask_value(PaintMode::Blend(Blend::Normal), old, blend::lum([r, g, b]), c)
                    };
                }
            }
            let px = Pixels::mask_from_norm(depth, &fresh);
            let uniform = match &px {
                Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == default),
                Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == default),
                _ => false,
            };
            out.push(((tx, ty), (!uniform).then_some(px)));
        }
        let mut tiles_out = Vec::with_capacity(out.len());
        for (at, px) in out {
            tiles_out.push((at, px.map(|px| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let m = self.node_mut(id)?.mask.as_mut().expect("checked");
        for ((tx, ty), t) in tiles_out {
            m.tiles.put(tx, ty, t);
        }
        Ok(())
    }

    /// Selection / quick mask target: painted as the sampled colour's luminance, `u = 1` (mirrors
    /// `fill_ex_selection`), but still bounded by the same region as the other two targets.
    fn gradient_selection(&mut self, id: u32, sample: &impl Fn(i32, i32) -> [f32; 4], opacity: f32) -> Result<(), String> {
        let [rx, ry, rw, rh] = self.gradient_region(id)?;
        if rw <= 0 || rh <= 0 {
            return Ok(());
        }
        let mut sel = self.selection.take().unwrap_or_default();
        for (tx, ty) in self.tiles_of_rect(rx, ry, rx + rw, ry + rh) {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let mut values = vec![0f32; TILE_PIXELS];
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let (gx, gy) = (ox + px_, oy + py);
                    let old = self.sel_at(&sel, gx, gy);
                    values[p] = if gx < rx || gx >= rx + rw || gy < ry || gy >= ry + rh {
                        old
                    } else {
                        let [r, g, b, a] = sample(gx, gy);
                        let c = (a * opacity).clamp(0.0, 1.0);
                        paint_mask_value(PaintMode::Blend(Blend::Normal), old, blend::lum([r, g, b]), c)
                    };
                }
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
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
            if matches!(self.node(id)?.kind, Kind::Smart(_)) {
                return self.apply_as_filter(id, &Adjustment::Invert(adjust::Invert {}));
            }
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

    /// Destructive apply of one adjustment kind (docs/M3.md section 3) onto a pixel layer's
    /// color channels; alpha untouched. With a selection the result is mixed by coverage (D12),
    /// same as `fill_ex`. `target` must be `Pixels` (adjustments have no mask/selection form).
    /// On a smart object it appends a smart filter masked to the selection instead.
    pub fn apply_adjustment(&mut self, id: u32, target: Target, json: &str) -> Result<(), String> {
        self.check_idle()?;
        if target != Target::Pixels {
            return Err("an adjustment applies only to a layer's pixels".into());
        }
        self.check_pixel_edit(id)?;
        let a: Adjustment = serde_json::from_str(json).map_err(|e| format!("invalid adjustment: {e}"))?;
        a.validate()?;
        self.check_blob(a.blob())?;
        if matches!(self.node(id)?.kind, Kind::Smart(_)) {
            return self.apply_as_filter(id, &a);
        }
        let Some(compiled) = a.compile(&self.blobs, self.depth == 32)? else { return Ok(()) };
        let existing = self.node(id)?.pixel_tiles()?.coords();
        let area: Vec<(i32, i32)> = match self.selected_tiles() {
            Some(sel) => sel.into_iter().filter(|c| existing.contains(c)).collect(),
            None => existing,
        };
        let selected = self.selection.is_some();
        let depth = self.depth;
        let mut out: Vec<((i32, i32), Pixels)> = Vec::with_capacity(area.len());
        for (tx, ty) in area {
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let old = self.node(id)?.pixel_tiles()?.get(tx, ty).expect("a listed tile").px.clone();
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let mut fresh = vec![0f32; TILE_PIXELS * 4];
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let rgba = old.rgba_f32(p);
                    let c = cov.at(p).clamp(0.0, 1.0);
                    let rgb = [rgba[0], rgba[1], rgba[2]];
                    let out_rgb = if c <= 0.0 {
                        rgb
                    } else {
                        let nw = adjust::apply(compiled.opcode, &compiled.data, rgb, (ox + px_) as u32, (oy + py) as u32);
                        std::array::from_fn(|i| rgb[i] + (nw[i] - rgb[i]) * c)
                    };
                    fresh[p * 4..p * 4 + 4].copy_from_slice(&[out_rgb[0], out_rgb[1], out_rgb[2], rgba[3]]);
                }
            }
            out.push(((tx, ty), Pixels::from_straight(depth, &fresh)));
        }
        let mut tiles_out = Vec::with_capacity(out.len());
        for (at, px) in out {
            tiles_out.push((at, Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in tiles_out {
            tiles.put(tx, ty, Some(t));
        }
        Ok(())
    }

    /// `apply_destructive` on the whole layer, ignoring the selection and the pixel lock: HDR Toning
    /// when a 32-bit document converts to 16/8 bits.
    pub fn tone_layer(&mut self, id: u32, json: &str) -> Result<(), String> {
        let sel = self.selection.take();
        let locked = std::mem::take(&mut self.node_mut(id)?.locks.pixels);
        let r = self.apply_destructive(id, json);
        self.selection = sel;
        self.node_mut(id)?.locks.pixels = locked;
        r
    }

    /// Destructive apply of a destructive-only kind (docs/M3.md section 3, kinds 17-25). Statistics
    /// and blurs see the region = layer content bounds x selection bounds as one buffer; the result
    /// is quantized (full float in 32-bit), then mixed by selection coverage (D12) on the color channels; alpha untouched.
    pub fn apply_destructive(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_paint(id)?;
        let kind: adjust::Destructive = serde_json::from_str(json).map_err(|e| format!("invalid adjustment: {e}"))?;
        kind.validate()?;
        let Some([mut x0, mut y0, w, h]) = self.layer_bounds(id)? else { return Ok(()) };
        let (mut x1, mut y1) = (x0 + w, y0 + h);
        let selected = self.selection.is_some();
        if selected {
            let Some([sx, sy, sw, sh]) = self.selection_bounds() else { return Ok(()) };
            (x0, y0, x1, y1) = (x0.max(sx), y0.max(sy), x1.min(sx + sw), y1.min(sy + sh));
            if x1 <= x0 || y1 <= y0 {
                return Ok(());
            }
        }
        // ponytail: one f32 RGBA buffer for the region (32 B/px with the original, about 48 B/px for
        // shadows/highlights' blur planes, ~800 MB at 4096 x 4096); strip it if larger layers matter.
        let (w, h) = ((x1 - x0) as usize, (y1 - y0) as usize);
        let src = self.node(id)?.pixel_tiles()?;
        let touched: Vec<((i32, i32), Arc<Pixels>)> = src
            .iter()
            .filter(|((tx, ty), _)| {
                let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
                ox < x1 && oy < y1 && ox + TILE as i32 > x0 && oy + TILE as i32 > y0
            })
            .map(|(&at, t)| (at, t.px.clone()))
            .collect();
        // Region pixels of one tile as (tile index, buffer index).
        let spans = |tx: i32, ty: i32| {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            (y0.max(oy)..y1.min(oy + TILE as i32)).flat_map(move |y| {
                (x0.max(ox)..x1.min(ox + TILE as i32))
                    .map(move |x| (((y - oy) * TILE as i32 + x - ox) as usize, ((y - y0) as usize * w + (x - x0) as usize)))
            })
        };
        let mut buf = vec![0f32; w * h * 4];
        for ((tx, ty), px) in &touched {
            for (p, b) in spans(*tx, *ty) {
                buf[b * 4..b * 4 + 4].copy_from_slice(&px.rgba_f32(p));
            }
        }
        adjust::destructive(&kind, &mut buf, w, h);
        let (max, hdr) = (max_value(self.depth) as f32, self.depth == 32);
        // 32-bit documents store the float result unclamped; 8/16-bit round to the depth's steps.
        let store = |v: f32| if hdr { v } else { (v.clamp(0.0, 1.0) * max).round() / max };
        let mut out = Vec::with_capacity(touched.len());
        for ((tx, ty), old) in touched {
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let mut px = (*old).clone();
            for (p, b) in spans(tx, ty) {
                let o = old.rgba_f32(p);
                let c = cov.at(p).clamp(0.0, 1.0);
                let mix = |i: usize| o[i] + (store(buf[b * 4 + i]) - o[i]) * c;
                px.set_rgba_f32(p, [mix(0), mix(1), mix(2), o[3]]);
            }
            out.push(((tx, ty), Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in out {
            tiles.put(tx, ty, Some(t));
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
        let text = matches!(self.node(id)?.kind, Kind::Text(_));
        if !text {
            self.node(id)?.pixel_tiles()?;
        }
        let transparent = data.chunks_exact(4).all(|px| px[3] == 0);
        let tile_id = if transparent { 0 } else { self.alloc_tile_id() };
        let depth = self.depth;
        let node = self.node_mut(id)?;
        let tiles = match &mut node.kind {
            Kind::Text(t) => t.cache.get_or_insert_with(Tiles::default),
            _ => node.pixel_tiles_mut()?,
        };
        let tile = (!transparent).then(|| Tile { id: tile_id, px: Arc::new(Pixels::from_rgba8(depth, data)) });
        tiles.put(tx as i32, ty as i32, tile);
        Ok(())
    }

    /// Straight RGBA floats of one tile into a pixel layer of a 32-bit document.
    pub fn set_tile_f32(&mut self, id: u32, tx: u32, ty: u32, data: &[f32]) -> Result<(), String> {
        self.check_idle()?;
        self.check_tile_coord(tx, ty)?;
        if self.depth != 32 {
            return Err("float tiles need a 32-bit document".into());
        }
        if data.len() != TILE_PIXELS * 4 {
            return Err(format!("expected {} values, got {}", TILE_PIXELS * 4, data.len()));
        }
        let transparent = data.chunks_exact(4).all(|px| !(px[3] > 0.0));
        let tile_id = if transparent { 0 } else { self.alloc_tile_id() };
        let tile = (!transparent).then(|| Tile { id: tile_id, px: Arc::new(Pixels::from_straight(32, data)) });
        self.node_mut(id)?.pixel_tiles_mut()?.put(tx as i32, ty as i32, tile);
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

    /// One tile in the document's own format (`tile_bytes` layout): `target` 'pixels' (straight RGBA
    /// of pixel layer `id`), 'mask' (layer `id`'s mask) or 'channel' (saved channel `id`).
    pub fn set_tile_bytes(&mut self, target: &str, id: u32, tx: u32, ty: u32, bytes: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        self.check_tile_coord(tx, ty)?;
        let px = Pixels::from_bytes(self.depth, target != "pixels", bytes)?;
        let (tx, ty) = (tx as i32, ty as i32);
        if target == "pixels" {
            self.node(id)?.pixel_tiles()?;
            let tile = px.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
            self.node_mut(id)?.pixel_tiles_mut()?.put(tx, ty, tile);
            return Ok(());
        }
        let default = match target {
            "mask" => self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?.default,
            "channel" => self.channels.iter().find(|c| c.id == id).ok_or_else(|| format!("unknown channel {id}"))?.mask.default,
            _ => return Err(format!("unknown tile target {target}")),
        };
        let uniform = match &px {
            Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == default),
            Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == default),
            _ => unreachable!("from_bytes made a mask"),
        };
        let tile = (!uniform).then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
        let tiles = match target {
            "mask" => &mut self.node_mut(id)?.mask.as_mut().expect("checked").tiles,
            _ => &mut self.channels.iter_mut().find(|c| c.id == id).expect("checked").mask.tiles,
        };
        tiles.put(tx, ty, tile);
        Ok(())
    }

    /// Writes straight RGBA8 (w x h) into a pixel layer at (x, y), which may lie past the canvas;
    /// pixels outside the rect are kept.
    pub fn put_rgba8(&mut self, id: u32, x: i32, y: i32, w: u32, h: u32, data: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_edit(id)?;
        if data.len() as u64 != w as u64 * h as u64 * 4 {
            return Err(format!("expected {} bytes, got {}", w as u64 * h as u64 * 4, data.len()));
        }
        if w == 0 || h == 0 {
            return Ok(());
        }
        let ti = TILE as i64;
        let (x1, y1) = (x as i64 + w as i64, y as i64 + h as i64);
        let lim = MAX_TILE_COORD as i64;
        if (x as i64).div_euclid(ti) < -lim || (y as i64).div_euclid(ti) < -lim || (x1 - 1).div_euclid(ti) >= lim || (y1 - 1).div_euclid(ti) >= lim {
            return Err("pixels lie too far from the canvas".into());
        }
        let depth = self.depth;
        for ty in (y as i64).div_euclid(ti)..=(y1 - 1).div_euclid(ti) {
            for tx in (x as i64).div_euclid(ti)..=(x1 - 1).div_euclid(ti) {
                let (ox, oy) = (tx * ti, ty * ti);
                let (cx0, cx1) = ((x as i64).max(ox), x1.min(ox + ti));
                let (cy0, cy1) = ((y as i64).max(oy), y1.min(oy + ti));
                let mut buf = vec![0u8; TILE_BYTES_U8];
                for sy in cy0..cy1 {
                    let s = (((sy - y as i64) * w as i64 + (cx0 - x as i64)) * 4) as usize;
                    let d = (((sy - oy) * ti + (cx0 - ox)) * 4) as usize;
                    let n = ((cx1 - cx0) * 4) as usize;
                    buf[d..d + n].copy_from_slice(&data[s..s + n]);
                }
                let src = Pixels::from_rgba8(depth, &buf);
                let tiles = self.node(id)?.pixel_tiles()?;
                let mut px = tiles.get(tx as i32, ty as i32).map_or_else(|| Pixels::transparent(depth), |t| (*t.px).clone());
                for sy in cy0..cy1 {
                    let at = ((sy - oy) * ti + (cx0 - ox)) as usize;
                    px.copy_run(at, &src, at, (cx1 - cx0) as usize);
                }
                let tile = px.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
                self.node_mut(id)?.pixel_tiles_mut()?.put(tx as i32, ty as i32, tile);
            }
        }
        Ok(())
    }
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

    /// The flattened tile as straight linear Rec. 709 RGBA through the document's profile (the
    /// sRGB curve for a profile without one), values above 1 kept.
    pub fn flatten_tile_linear(&self, tx: u32, ty: u32) -> Result<Vec<f32>, String> {
        let mut px = self.flatten_tile_f32(tx, ty)?;
        let lin = self.source_profile_ref().ok().as_ref().and_then(crate::icc::to_linear_709);
        let srgb = crate::icc::Curve::Srgb;
        for p in px.chunks_exact_mut(4) {
            let c = [p[0] as f64, p[1] as f64, p[2] as f64];
            let o = match &lin {
                Some(f) => f(c),
                None => c.map(|v| srgb.eval(v)),
            };
            (0..3).for_each(|i| p[i] = o[i] as f32);
        }
        Ok(px)
    }

    /// The flattened tile as straight RGBA floats, values above 1 kept.
    pub fn flatten_tile_f32(&self, tx: u32, ty: u32) -> Result<Vec<f32>, String> {
        self.check_tile_coord(tx, ty)?;
        let mut px = self.composite_tile_premul(tx, ty);
        for p in px.chunks_exact_mut(4) {
            let a = p[3];
            for c in &mut p[..3] {
                *c = if a > 0.0 { *c / a } else { 0.0 };
            }
        }
        Ok(px)
    }

    /// 8-bit counts of luminosity (0.3r + 0.59g + 0.11b), R, G and B, 256 bins each, over the
    /// pixels with alpha inside the canvas: the composite for id 0, else that layer's own pixels.
    pub fn histogram(&self, id: u32) -> Result<Vec<u32>, String> {
        let mut h = vec![0u32; 4 * 256];
        let (w, ht) = (self.width() as i32, self.height() as i32);
        let mut count = |tx: i32, ty: i32, px: &[u8]| {
            for p in 0..TILE_PIXELS {
                let (x, y) = (tx * TILE as i32 + (p % TILE) as i32, ty * TILE as i32 + (p / TILE) as i32);
                let c = &px[p * 4..p * 4 + 4];
                if x < 0 || y < 0 || x >= w || y >= ht || c[3] == 0 {
                    continue;
                }
                let lum = (0.3 * c[0] as f64 + 0.59 * c[1] as f64 + 0.11 * c[2] as f64).round() as usize;
                h[lum.min(255)] += 1;
                for ch in 0..3 {
                    h[256 * (ch + 1) + c[ch] as usize] += 1;
                }
            }
        };
        if id == 0 {
            for ty in 0..self.tiles_y() {
                for tx in 0..self.tiles_x() {
                    count(tx as i32, ty as i32, &self.flatten_tile_rgba8(tx, ty)?);
                }
            }
            return Ok(h);
        }
        for (&(tx, ty), t) in self.node(id)?.pixel_tiles()?.iter() {
            let px: Vec<u8> = (0..TILE_PIXELS)
                .flat_map(|p| t.px.rgba_f32(p).map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8))
                .collect();
            count(tx, ty, &px);
        }
        Ok(h)
    }

    /// Inserts an adjustment, fill or smart node above `above` (0 = on top). `json` names the
    /// node and carries exactly one of `adjustment`, `content`, `smart`, `shape` or `text`; a smart
    /// or text cache starts empty (PSD import fills it through `set_tile_rgba8`, D5).
    pub fn add_special(&mut self, above: u32, json: &str) -> Result<u32, String> {
        let s: SpecialIn = serde_json::from_str(json).map_err(|e| format!("invalid node: {e}"))?;
        let kind = match (s.adjustment, s.content, s.smart, s.shape, s.text) {
            (None, None, None, None, Some(data)) => {
                data.validate()?;
                Kind::Text(Box::new(Text { data, cache: Some(Tiles::default()) }))
            }
            (None, None, None, Some(shape), None) => {
                shape.validate(|id| self.patterns.iter().any(|p| p.id == id))?;
                Kind::Shape(Box::new(shape))
            }
            // No range check here: PSD import also goes through `add_special` and must keep an
            // out-of-UI-range value byte-faithful (B2); only the UI-facing `set_adjustment` and
            // `apply_adjustment` enforce section 3's ranges (the trust boundary the dialogs cross).
            (Some(a), None, None, None, None) => {
                self.check_blob(a.blob())?;
                Kind::Adjustment(a)
            }
            (None, Some(c), None, None, None) => {
                if let Some(id) = c.pattern_id().filter(|id| !self.patterns.iter().any(|p| p.id == *id)) {
                    return Err(format!("unknown pattern {id}"));
                }
                Kind::Fill(c)
            }
            (None, None, Some(m), None, None) => {
                self.check_blob(m.source_blob)?;
                Kind::Smart(Box::new(Smart {
                    link: m.link,
                    source_blob: m.source_blob,
                    source_tiles: Tiles::default(),
                    source_size: m.source_size,
                    transform: m.transform,
                    warp: None,
                    filters: Vec::new(),
                    stack_mask: None,
                    stack_mode: None,
                    cache: Tiles::default(),
                    mask_key: 0,
                }))
            }
            _ => return Err("a node needs exactly one of adjustment, content, smart, shape and text".into()),
        };
        self.add_node(&s.name, above, kind)
    }

    /// Adds a fill layer via `add_special` (docs/M3.md section 4), then masks it to the current
    /// selection (reveal all when nothing is selected) and drops the selection, as one op.
    pub fn add_fill_layer(&mut self, above: u32, json: &str) -> Result<u32, String> {
        let id = self.add_special(above, json)?;
        let (default, tiles) = match &self.selection {
            Some(sel) => (sel.default, sel.tiles.clone()),
            None => (max_value(self.depth), Tiles::default()),
        };
        self.node_mut(id)?.mask = Some(Mask { enabled: true, default, tiles });
        if let Some(sel) = self.selection.take() {
            self.last_selection = Some(sel);
        }
        Ok(id)
    }

    /// Replaces an adjustment layer's params; refuses other kinds (naming the kind).
    pub fn set_adjustment(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let a: Adjustment = serde_json::from_str(json).map_err(|e| format!("invalid adjustment: {e}"))?;
        a.validate()?;
        self.check_blob(a.blob())?;
        let node = self.node_mut(id)?;
        let kind = node.kind_name();
        match &mut node.kind {
            Kind::Adjustment(existing) => {
                *existing = a;
                Ok(())
            }
            _ => Err(format!("node {id} is a {kind} layer, not an adjustment layer")),
        }
    }

    /// Replaces a fill layer's content; refuses other kinds (naming the kind) and unknown pattern ids.
    pub fn set_content(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let c: FillContent = serde_json::from_str(json).map_err(|e| format!("invalid content: {e}"))?;
        if let Some(pid) = c.pattern_id().filter(|p| !self.patterns.iter().any(|e| e.id == *p)) {
            return Err(format!("unknown pattern {pid}"));
        }
        let node = self.node_mut(id)?;
        let kind = node.kind_name();
        match &mut node.kind {
            Kind::Fill(existing) => {
                *existing = c;
                Ok(())
            }
            _ => Err(format!("node {id} is a {kind} layer, not a fill layer")),
        }
    }

    /// Renders a fill layer over the document bounds into pixel tiles and turns it into a pixel
    /// layer with the same id, mask, props, style and blending; fully transparent tiles stay absent.
    pub fn rasterize_fill(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let node = self.node(id)?;
        let kind = node.kind_name();
        let Kind::Fill(c) = &node.kind else {
            return Err(format!("node {id} is a {kind} layer, not a fill layer"));
        };
        let c = c.clone();
        let mut tiles = Tiles::default();
        for ty in 0..self.tiles_y() {
            for tx in 0..self.tiles_x() {
                let Some((_, px)) = self.fill_tile(&c, 0, tx, ty) else { continue };
                if px.any_alpha() {
                    let tid = self.alloc_tile_id();
                    tiles.put(tx as i32, ty as i32, Some(Tile { id: tid, px }));
                }
            }
        }
        self.node_mut(id)?.kind = Kind::Pixel(tiles);
        Ok(())
    }

    pub fn set_blending(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let b: Blending = serde_json::from_str(json).map_err(|e| format!("invalid blending options: {e}"))?;
        self.node_mut(id)?.blending = b;
        Ok(())
    }

    /// Replaces the document fields present in `json` (global light, patterns, layer comps).
    pub fn set_document_m3(&mut self, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let d: DocumentM3In = serde_json::from_str(json).map_err(|e| format!("invalid document fields: {e}"))?;
        if let Some(ps) = &d.patterns {
            let mut ids = HashSet::new();
            for p in ps {
                if !ids.insert(p.id.as_str()) {
                    return Err(format!("duplicate pattern id {}", p.id));
                }
                self.check_blob(Some(p.blob))?;
            }
        }
        if let Some(cs) = &d.layer_comps {
            let pats = d.patterns.as_ref().unwrap_or(&self.patterns);
            for l in cs.iter().flat_map(|c| &c.layers) {
                self.node(l.id)?;
                check_comp_layer(l, |id| pats.iter().any(|p| p.id == id))?;
            }
        }
        if let Some(g) = d.global_light {
            self.global_light = g;
        }
        if let Some(p) = d.patterns {
            self.patterns = p;
        }
        if let Some(c) = d.layer_comps {
            self.layer_comps = c;
        }
        Ok(())
    }

    /// Replaces a node's layer style; `null` removes it. Adjustment layers refuse a style.
    pub fn set_style(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let style: Option<Style> = serde_json::from_str(json).map_err(|e| format!("invalid style: {e}"))?;
        if let Some(st) = &style {
            if matches!(self.node(id)?.kind, Kind::Adjustment(_)) {
                return Err(format!("node {id} is an adjustment layer and cannot have a layer style"));
            }
            check_style(st, |p| self.patterns.iter().any(|e| e.id == p))?;
        }
        self.node_mut(id)?.style = style;
        Ok(())
    }

    // Layer Style commands refuse fully locked layers (the model has no background layer).
    fn style_target(&self, id: u32) -> Result<&Node, String> {
        let n = self.node(id)?;
        if n.locks.transparency && n.locks.pixels && n.locks.position {
            return Err(format!("layer \"{}\" is fully locked", n.name));
        }
        Ok(n)
    }

    fn style_mut(&mut self, id: u32) -> Result<&mut Style, String> {
        let name = self.style_target(id)?.name.clone();
        self.node_mut(id)?.style.as_mut().ok_or_else(|| format!("layer \"{name}\" has no layer style"))
    }

    /// Scale Effects: sets the style scale, 0.01..10 (1 % to 1000 %).
    pub fn scale_effects(&mut self, id: u32, factor: f32) -> Result<(), String> {
        self.check_idle()?;
        if !(0.01..=10.0).contains(&factor) {
            return Err("scale must be between 1 % and 1000 %".into());
        }
        self.style_mut(id)?.scale = factor;
        Ok(())
    }

    /// Hide All Effects: turns every style's master switch off, or on when all are already off;
    /// returns the new state.
    pub fn hide_all_effects(&mut self) -> Result<bool, String> {
        self.check_idle()?;
        fn walk<'a>(nodes: &'a mut [Node], out: &mut Vec<&'a mut Style>) {
            for n in nodes {
                if let Some(s) = n.style.as_mut() {
                    out.push(s);
                }
                if let Kind::Group(ch) = &mut n.kind {
                    walk(ch, out);
                }
            }
        }
        let mut styles = Vec::new();
        walk(&mut self.nodes, &mut styles);
        if styles.is_empty() {
            return Err("no layer has layer effects".into());
        }
        let on = !styles.iter().any(|s| s.enabled);
        styles.into_iter().for_each(|s| s.enabled = on);
        Ok(on)
    }

    /// Copy Layer Style: the style JSON only, never the blending options.
    pub fn copy_style(&self, id: u32) -> Result<String, String> {
        let n = self.node(id)?;
        let s = n.style.as_ref().ok_or_else(|| format!("layer \"{}\" has no layer style", n.name))?;
        Ok(serde_json::to_string(s).expect("style serializes"))
    }

    /// Paste Layer Style (and the Layer Style dialog): a deep copy of `json` on every id; all
    /// targets are checked before any changes.
    pub fn paste_style(&mut self, ids: &[u32], json: &str) -> Result<(), String> {
        self.check_idle()?;
        let style: Style = serde_json::from_str(json).map_err(|e| format!("invalid style: {e}"))?;
        check_style(&style, |p| self.patterns.iter().any(|e| e.id == p))?;
        for &id in ids {
            if matches!(self.style_target(id)?.kind, Kind::Adjustment(_)) {
                return Err(format!("node {id} is an adjustment layer and cannot have a layer style"));
            }
        }
        for &id in ids {
            self.node_mut(id)?.style = Some(style.clone());
        }
        Ok(())
    }

    /// Clear Layer Style: removes the style, blending options stay.
    pub fn clear_style(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        self.style_target(id)?;
        self.node_mut(id)?.style = None;
        Ok(())
    }

    /// Create Layers: each behind plane becomes a pixel layer directly below ("<layer>'s <effect>",
    /// the effect's mode, its opacity times the layer's); the content with the interior effects,
    /// fill and masks baked stays, and the style, fill (-> 1) and masks go. Pixel layers outside a
    /// clipping group only. Returns the new ids, bottom first.
    pub fn create_layers_from_style(&mut self, id: u32) -> Result<Vec<u32>, String> {
        self.check_idle()?;
        let node = self.style_target(id)?;
        let Kind::Pixel(tiles) = &node.kind else {
            return Err(format!("Create Layers needs a pixel layer; node {id} is a {} layer", node.kind_name()));
        };
        let style = node.style.clone().filter(|s| s.any_effect());
        let Some(style) = style else { return Err(format!("layer \"{}\" has no layer effects", node.name)) };
        let path = self.find_path(id)?;
        let (last, prefix) = path.split_last().expect("path");
        let siblings: &[Node] = match prefix.is_empty() {
            true => &self.nodes,
            false => match &node_at(&self.nodes, prefix).kind {
                Kind::Group(ch) => ch,
                _ => unreachable!("a node path only walks through groups"),
            },
        };
        let base = siblings.get(last + 1).is_some_and(|n| n.clipping);
        if node.clipping || base {
            return Err("Create Layers does not work inside a clipping group".into());
        }
        let live = |p: bool, e: bool| p && e;
        let mut names = Vec::new();
        let drops: Vec<_> = style.drop_shadows.iter().filter(|e| live(e.present, e.enabled)).collect();
        for (i, e) in drops.iter().enumerate() {
            let suffix = if drops.len() > 1 && i > 0 { format!(" {}", i + 1) } else { String::new() };
            names.push((format!("{}'s Drop Shadow{suffix}", node.name), e.blend, e.opacity));
        }
        if let Some(g) = style.outer_glow.as_ref().filter(|e| live(e.present, e.enabled)) {
            names.push((format!("{}'s Outer Glow", node.name), g.blend, g.opacity));
        }

        let pad = styles::reach(&style) as i64;
        let n = TILE + 2 * pad as usize;
        let (mut content, mut behind) = (Vec::new(), vec![Vec::new(); names.len()]);
        if let Some([bx, by, bw, bh]) = tiles_bounds(tiles) {
            let t = TILE as i64;
            let (bounds, _) = self.style_bounds(node, &style);
            let (tx0, tx1) = ((bx as i64 - pad).div_euclid(t), (bx as i64 + bw as i64 - 1 + pad).div_euclid(t));
            let (ty0, ty1) = ((by as i64 - pad).div_euclid(t), (by as i64 + bh as i64 - 1 + pad).div_euclid(t));
            for ty in ty0..=ty1 {
                for tx in tx0..=tx1 {
                    let (x0, y0) = (tx * t - pad, ty * t - pad);
                    let Some(region) = self.styled_region(node, 0, x0, y0, n) else { continue };
                    let (px, mask, vector) = Document::region_pixels(&region);
                    let cx = styles::Ctx {
                        origin: [x0 as i32, y0 as i32],
                        level: 0,
                        scale: 1.0,
                        light: &self.global_light,
                        patterns: &self.patterns,
                        blobs: &self.blobs,
                        bounds,
                        doc: [self.width as f64, self.height as f64],
                        hdr: self.depth == 32,
                    };
                    let layer = styles::Layer {
                        w: n,
                        h: n,
                        content: &px,
                        blend: node.blend,
                        fill: node.fill,
                        blending: &node.blending,
                        layer_mask: mask.as_ref(),
                        vector_mask: vector.as_ref(),
                    };
                    let r = styles::render_layer(&style, &layer, &cx);
                    let p = pad as usize;
                    let crop = |v: &[[f32; 4]]| {
                        let f: Vec<f32> = (0..TILE).flat_map(|y| v[(y + p) * n + p..(y + p) * n + p + TILE].iter().flatten().copied()).collect();
                        Arc::new(Pixels::from_straight(self.depth, &f))
                    };
                    content.push((tx as i32, ty as i32, crop(&r.content)));
                    for (out, b) in behind.iter_mut().zip(&r.behind) {
                        out.push((tx as i32, ty as i32, crop(&b.rgba)));
                    }
                }
            }
        }

        let opacity = node.opacity;
        let mut into_tiles = |planes: Vec<(i32, i32, Arc<Pixels>)>| {
            let mut t = Tiles::default();
            for (x, y, px) in planes.into_iter().filter(|p| p.2.any_alpha()) {
                t.put(x, y, Some(Tile { id: self.alloc_tile_id(), px }));
            }
            t
        };
        let content = into_tiles(content);
        let behind: Vec<Tiles> = behind.into_iter().map(&mut into_tiles).collect();
        let mut ids = Vec::new();
        for ((name, blend, op), tiles) in names.into_iter().zip(behind) {
            let nid = self.alloc_node_id();
            let mut l = Node::new(nid, &name, Kind::Pixel(tiles));
            (l.blend, l.opacity) = (blend, op * opacity);
            list_mut(&mut self.nodes, prefix).insert(last + ids.len(), l);
            ids.push(nid);
        }
        let node = self.node_mut(id)?;
        (node.kind, node.style, node.fill, node.mask) = (Kind::Pixel(content), None, 1.0, None);
        Ok(ids)
    }

    // ---------- layer comps (M3.md section 8) ----------

    // Every layer, recursive; a node with no pixels (group, adjustment, fill) has no position.
    fn collect_comp_layers(&self) -> Vec<CompLayer> {
        fn walk(nodes: &[Node], out: &mut Vec<CompLayer>) {
            for n in nodes {
                let position = n.pixel_tiles().ok().and_then(tiles_bounds).map(|b| [b[0], b[1]]);
                out.push(CompLayer {
                    id: n.id,
                    visible: n.visible,
                    position,
                    opacity: n.opacity,
                    fill: n.fill,
                    blend: n.blend,
                    style: n.style.clone(),
                });
                if let Kind::Group(ch) = &n.kind {
                    walk(ch, out);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.nodes, &mut out);
        out
    }

    fn layer_comp_mut(&mut self, id: u32) -> Result<&mut LayerComp, String> {
        self.layer_comps.iter_mut().find(|c| c.id == id).ok_or_else(|| format!("unknown layer comp {id}"))
    }

    /// Snapshots every layer's visibility, position, appearance and style; flags default on.
    pub fn capture_layer_comp(&mut self, name: &str) -> Result<u32, String> {
        self.check_idle()?;
        let id = self.layer_comps.iter().map(|c| c.id).max().map_or(1, |m| m + 1);
        self.layer_comps.push(LayerComp {
            id,
            name: name.to_string(),
            comment: String::new(),
            apply_visibility: true,
            apply_position: true,
            apply_appearance: true,
            layers: self.collect_comp_layers(),
        });
        Ok(id)
    }

    /// Restores a comp's flagged aspects on every layer it still finds; an unknown id errs.
    pub fn apply_layer_comp(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let comp = self.layer_comp_mut(id)?.clone();
        for l in &comp.layers {
            check_comp_layer(l, |id| self.patterns.iter().any(|p| p.id == id))?;
        }
        for cl in &comp.layers {
            let Ok(n) = self.node(cl.id) else {
                continue; // deleted since capture
            };
            // Locked and non-pixel layers keep their position; the rest of the comp still applies.
            if comp.apply_position && !n.locks.position && !n.locks.pixels {
                if let (Some([sx, sy]), Ok(Some([cx, cy, ..]))) = (cl.position, self.layer_bounds(cl.id)) {
                    self.offset_layer(cl.id, sx - cx, sy - cy)?;
                }
            }
            let node = self.node_mut(cl.id)?;
            if comp.apply_visibility {
                node.visible = cl.visible;
            }
            if comp.apply_appearance {
                node.opacity = cl.opacity;
                node.fill = cl.fill.clamp(0.0, 1.0);
                if cl.blend != Blend::PassThrough || node.is_group() {
                    node.blend = cl.blend;
                }
                node.style = cl.style.clone();
            }
        }
        Ok(())
    }

    pub fn delete_layer_comp(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let i = self.layer_comps.iter().position(|c| c.id == id).ok_or_else(|| format!("unknown layer comp {id}"))?;
        self.layer_comps.remove(i);
        Ok(())
    }

    /// Partial JSON: name, comment, apply_visibility, apply_position, apply_appearance.
    pub fn update_layer_comp(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let u: LayerCompUpdateIn = serde_json::from_str(json).map_err(|e| format!("invalid layer comp options: {e}"))?;
        let comp = self.layer_comp_mut(id)?;
        if let Some(n) = u.name {
            comp.name = n;
        }
        if let Some(c) = u.comment {
            comp.comment = c;
        }
        if let Some(v) = u.apply_visibility {
            comp.apply_visibility = v;
        }
        if let Some(v) = u.apply_position {
            comp.apply_position = v;
        }
        if let Some(v) = u.apply_appearance {
            comp.apply_appearance = v;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "doc_tests.rs"]
mod tests;
