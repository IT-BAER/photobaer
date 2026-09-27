//! Shape content, vector mask and artboard clip planes for the compositor (docs/M4.md section 3).
//! Level L renders the geometry scaled by 2^-L; every tile is cached like an M3 fill tile.

use super::compositor::{mix, mix_bytes};
use super::*;
use crate::content::SolidFill;
use crate::geom;
use crate::path::{ArtboardBackground, Bounds, VectorPath};

/// `p` with every coordinate times `k`.
fn scaled(p: &VectorPath, k: f64) -> VectorPath {
    let mut p = p.clone();
    p.subpaths.iter_mut().flat_map(|s| s.points.iter_mut()).flatten().for_each(|v| *v *= k);
    p
}

fn norm(c: Vec<u8>) -> Vec<f32> {
    c.into_iter().map(|v| v as f32 / 255.0).collect()
}

/// Largest feather (level px) blurred directly; a larger one is blurred at the coarsest pyramid
/// level that brings it under this and upsampled bilinearly (within 2/255 of the exact Gaussian,
/// see the tests), so a tile costs at most a ~320 px window and 65 taps per pass.
pub(super) const FEATHER_MAX: f64 = 32.0;

/// `Document::vector_plane` for a document of `doc` px, blurring feathers above `cap` coarser.
#[allow(clippy::too_many_arguments)]
pub(super) fn feather_plane(m: &VectorMask, doc: (u32, u32), level: u32, x0: i64, y0: i64, w: usize, h: usize, cap: f64) -> Vec<f32> {
    let k = 0.5f64.powi(level as i32);
    let feather = m.feather * k;
    if feather > cap {
        let e = (feather / cap).log2().ceil().max(1.0) as u32;
        let f = (1u64 << e) as f64;
        // Coarse sample u of output pixel x: its centre in coarse px, minus the coarse half pixel.
        let u = |x: i64| (x as f64 + 0.5) / f - 0.5;
        let (cx, cy) = (u(x0).floor() as i64, u(y0).floor() as i64);
        let cw = (u(x0 + w as i64 - 1).floor() as i64 + 2 - cx) as usize;
        let ch = (u(y0 + h as i64 - 1).floor() as i64 + 2 - cy) as usize;
        let c = feather_plane(m, doc, level + e, cx, cy, cw, ch, cap);
        let tap = |ix: i64, iy: i64| c[(iy - cy).clamp(0, ch as i64 - 1) as usize * cw + (ix - cx).clamp(0, cw as i64 - 1) as usize];
        let mut out = Vec::with_capacity(w * h);
        for y in y0..y0 + h as i64 {
            let (vy, iy) = (u(y), u(y).floor() as i64);
            let fy = (vy - iy as f64) as f32;
            for x in x0..x0 + w as i64 {
                let (vx, ix) = (u(x), u(x).floor() as i64);
                let fx = (vx - ix as f64) as f32;
                let top = tap(ix, iy) * (1.0 - fx) + tap(ix + 1, iy) * fx;
                let bottom = tap(ix, iy + 1) * (1.0 - fx) + tap(ix + 1, iy + 1) * fx;
                out.push(top * (1.0 - fy) + bottom * fy);
            }
        }
        return out;
    }
    let path = scaled(&m.path, k);
    let kernel = (feather > 0.0).then(|| gaussian_kernel(feather));
    let r = kernel.as_ref().map_or(0, |k| (k.len() / 2) as i64);
    let size = |s: u32| (s as u64).div_ceil(1u64 << level.min(63)).max(1) as i64;
    // The source window: the output grown by the kernel reach, inside the document.
    let span = |o: i64, n: usize, size: i64| {
        if r == 0 {
            return (o, n);
        }
        let a = (o - r).clamp(0, size - 1);
        (a, ((o + n as i64 + r).clamp(a + 1, size) - a) as usize)
    };
    let ((sx, sw), (sy, sh)) = (span(x0, w, size(doc.0)), span(y0, h, size(doc.1)));
    let mut cov = norm(geom::fill_mask(&path, sx as i32, sy as i32, sw, sh));
    if m.inverted {
        cov.iter_mut().for_each(|v| *v = 1.0 - *v);
    }
    if let Some(kn) = &kernel {
        let p = styles::Plane { w: sw, h: sh, v: cov };
        cov = styles::convolve(&styles::convolve(&p, kn, true), kn, false).v;
    }
    let d = m.density as f32;
    let mut out = Vec::with_capacity(w * h);
    for y in 0..h as i64 {
        let row = (y0 + y - sy).clamp(0, sh as i64 - 1) as usize * sw;
        for x in 0..w as i64 {
            let v = cov[row + (x0 + x - sx).clamp(0, sw as i64 - 1) as usize];
            out.push(1.0 - d * (1.0 - v));
        }
    }
    out
}

impl Document {
    fn cached(&self, key: u64, level: u32, render: impl FnOnce() -> Pixels) -> Arc<Pixels> {
        if let Some(px) = self.tile_cache.borrow_mut().get(key) {
            return px;
        }
        let px = Arc::new(render());
        self.tile_cache.borrow_mut().insert(key, px.clone(), level);
        px
    }

    /// A shape layer's straight RGBA for one level tile: fill content times the fill coverage,
    /// then the stroke content times the stroke coverage and opacity, blended over it. Gradients
    /// span the path bounds. None outside the document or when the tile is empty.
    pub(super) fn shape_tile(&self, s: &ShapeData, level: u32, tx: u32, ty: u32) -> Option<(u64, Arc<Pixels>)> {
        let (ntx, nty) = self.level_tiles(level);
        if tx >= ntx || ty >= nty {
            return None;
        }
        let stroke = s.stroke.as_ref().filter(|st| st.enabled && st.width > 0.0 && st.opacity > 0.0);
        if s.fill.is_none() && stroke.is_none() {
            return None;
        }
        let mut key = mix_bytes(0x5A4E_0000_0000_0001, serde_json::to_string(s).expect("shape serializes").as_bytes());
        let contents = s.fill.iter().chain(s.stroke.as_ref().map(|st| &st.content));
        for p in contents.filter_map(|c| c.pattern_id()).filter_map(|id| self.patterns.iter().find(|p| p.id == id)) {
            key = mix(mix(mix(key, p.blob), p.width as u64), p.height as u64);
        }
        for v in [self.width, self.height, self.depth as u32, level, tx, ty] {
            key = mix(key, v as u64);
        }
        let key = key | (1 << 63);
        let px = self.cached(key, level, || {
            let k = 0.5f64.powi(level as i32);
            let path = scaled(&s.path, k);
            let bx = geom::bounds(&s.path).map_or([0.0; 4], |[l, t, r, b]| [l, t, r - l, b - t]);
            let (x0, y0) = ((tx as usize * TILE) as i32, (ty as usize * TILE) as i32);
            let fill = s.fill.as_ref().map(|c| (self.sampler(c, bx), geom::fill_mask(&path, x0, y0, TILE, TILE)));
            let stroke = stroke.map(|st| {
                let dash: Vec<f64> = st.dash.iter().map(|d| d * k).collect();
                let cov = geom::stroke_mask(
                    &path, st.width * k, st.align, st.cap, st.join, st.miter_limit, &dash, st.dash_offset * k, x0, y0, TILE, TILE,
                );
                (self.sampler(&st.content, bx), cov, st)
            });
            let (vw, vh) = self.level_valid(level, tx, ty);
            let step = (1u32 << level) as f64;
            let mut out = vec![0f32; TILE_PIXELS * 4];
            for y in 0..vh {
                let dy = ((ty as usize * TILE + y) as f64 + 0.5) * step;
                for x in 0..vw {
                    let dx = ((tx as usize * TILE + x) as f64 + 0.5) * step;
                    let p = y * TILE + x;
                    let mut px = [0f32; 4];
                    if let Some((sample, cov)) = &fill {
                        if cov[p] > 0 {
                            let c = sample(dx, dy);
                            px = [c[0], c[1], c[2], c[3] * cov[p] as f32 / 255.0];
                        }
                    }
                    if let Some((sample, cov, st)) = &stroke {
                        if cov[p] > 0 {
                            let c = sample(dx, dy);
                            let a = c[3] * cov[p] as f32 / 255.0 * st.opacity;
                            px = paint_pixel(PaintMode::Blend(st.blend), px, [c[0], c[1], c[2]], a, false);
                        }
                    }
                    out[p * 4..p * 4 + 4].copy_from_slice(&px);
                }
            }
            Pixels::from_straight(self.depth, &out)
        });
        px.any_alpha().then_some((key, px))
    }

    /// A shape layer's level 0 render as tiles (the transform session preview source).
    pub(super) fn shape_tiles(&self, s: &ShapeData) -> Tiles {
        let mut tiles = Tiles::default();
        let Some([l, t, r, b]) = geom::bounds(&s.path) else { return tiles };
        // The stroke reaches at most width x miter limit / 2 past the path (miter limit >= 1 assumed).
        let pad = s.stroke.as_ref().map_or(1.0, |st| st.width * st.miter_limit.max(1.0) / 2.0 + 1.0);
        let (ntx, nty) = self.level_tiles(0);
        let tile = |v: f64, n: u32| ((v / TILE as f64).floor().max(0.0) as u32).min(n);
        for ty in tile(t - pad, nty)..tile(b + pad, nty - 1) + 1 {
            for tx in tile(l - pad, ntx)..tile(r + pad, ntx - 1) + 1 {
                if let Some((id, px)) = self.shape_tile(s, 0, tx, ty) {
                    tiles.put(tx as i32, ty as i32, Some(Tile { id, px }));
                }
            }
        }
        tiles
    }

    /// An enabled vector mask over the w x h window at level px (x0, y0): path coverage (inverted
    /// when `inverted`), feathered by a Gaussian of sigma feather / 3 (half-width ceil(3 sigma),
    /// clamped at the document edge), then density: `1 - density (1 - m)`.
    pub(super) fn vector_plane(&self, m: &VectorMask, level: u32, x0: i64, y0: i64, w: usize, h: usize) -> Vec<f32> {
        feather_plane(m, (self.width, self.height), level, x0, y0, w, h, FEATHER_MAX)
    }

    /// The node's mask for one level tile when an enabled vector mask or an artboard rect applies:
    /// raster (tile, constant or none) x vector x artboard rect coverage, as one mask tile.
    pub(super) fn clip_mask(
        &self,
        node: &Node,
        raster: Option<&Result<(u64, Arc<Pixels>), f32>>,
        level: u32,
        tx: u32,
        ty: u32,
    ) -> Option<(u64, Arc<Pixels>)> {
        let vm = node.vector_mask.as_ref().filter(|m| m.enabled);
        let board: Option<Bounds> = node.artboard.as_ref().map(|a| a.rect);
        if vm.is_none() && board.is_none() {
            return None;
        }
        let mut key = mix_bytes(0xC11B_0000_0000_0001, serde_json::to_string(&(vm, board)).expect("mask serializes").as_bytes());
        let base = match raster {
            None => u64::MAX,
            Some(Ok((k, _))) => *k,
            Some(Err(c)) => c.to_bits() as u64,
        };
        for v in [base, self.width as u64, self.height as u64, self.depth as u64, level as u64, tx as u64, ty as u64] {
            key = mix(key, v);
        }
        let key = key | (1 << 63);
        let px = self.cached(key, level, || {
            let mut v: Vec<f32> = match raster {
                None => vec![1.0; TILE_PIXELS],
                Some(Err(c)) => vec![*c; TILE_PIXELS],
                Some(Ok((_, px))) => (0..TILE_PIXELS).map(|p| px.mask_f32(p)).collect(),
            };
            let (x0, y0) = (tx as i64 * TILE as i64, ty as i64 * TILE as i64);
            if let Some(m) = vm {
                v.iter_mut().zip(self.vector_plane(m, level, x0, y0, TILE, TILE)).for_each(|(a, b)| *a *= b);
            }
            if let Some(b) = board {
                let rect = scaled(&geom::rect(b, [0.0; 4]), 0.5f64.powi(level as i32));
                let cov = norm(geom::fill_mask(&rect, x0 as i32, y0 as i32, TILE, TILE));
                v.iter_mut().zip(cov).for_each(|(a, b)| *a *= b);
            }
            Pixels::mask_from_norm(self.depth, &v)
        });
        Some((key, px))
    }

    /// An artboard's background as a solid tile (clipped to the rect by its mask); none for
    /// `none` and `transparent`.
    pub(super) fn artboard_tile(&self, a: &Artboard, level: u32, tx: u32, ty: u32) -> Option<(u64, Arc<Pixels>)> {
        let color = match a.background {
            ArtboardBackground::White => [255; 3],
            ArtboardBackground::Black => [0; 3],
            ArtboardBackground::Color { color } => color,
            ArtboardBackground::None | ArtboardBackground::Transparent => return None,
        };
        self.fill_tile(&FillContent::Solid(SolidFill { color }), level, tx, ty)
    }
}

#[cfg(test)]
#[path = "vector_tests.rs"]
mod tests;
