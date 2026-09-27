//! Mesh warp render: bicubic Bezier patches, tessellated into triangles and inverse-mapped.
//! A child module of `doc`, so it reaches the document's private tile storage.

use super::transform::{check_area, tile_rect};
use super::*;
use crate::resample::{Interp, Plane, Resampler};

const LIMIT: &str = "The warped image exceeds the rendering limit.";
const MAX_DEST_AREA: f64 = 1e8;

/// A cols x rows grid of bicubic Bezier patches: `points` holds (3 cols + 1) x (3 rows + 1)
/// control points in document px, row-major; the stops are the patch boundaries in [0, 1].
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Mesh {
    cols: usize,
    rows: usize,
    points: Vec<[f64; 2]>,
    column_stops: Vec<f64>,
    row_stops: Vec<f64>,
}

fn bernstein(t: f64) -> [f64; 4] {
    let s = 1.0 - t;
    [s * s * s, 3.0 * t * s * s, 3.0 * t * t * s, t * t * t]
}

// The patch index holding parameter `s` and the local parameter within it.
fn locate(stops: &[f64], s: f64) -> (usize, f64) {
    let i = stops[1..stops.len() - 1].iter().take_while(|v| **v <= s).count();
    (i, (s - stops[i]) / (stops[i + 1] - stops[i]))
}

impl Mesh {
    fn parse(json: &str) -> Result<Mesh, String> {
        let m: Mesh = serde_json::from_str(json).map_err(|e| format!("invalid warp mesh: {e}"))?;
        m.check()
    }

    fn check(self) -> Result<Mesh, String> {
        let m = self;
        let stops_ok = |st: &[f64], n: usize| {
            st.len() == n + 1 && st[0] == 0.0 && st[n] == 1.0 && st.windows(2).all(|w| w[0] < w[1])
        };
        if !(1..=64).contains(&m.cols) || !(1..=64).contains(&m.rows) {
            return Err("invalid warp mesh: cols and rows must be 1 to 64".into());
        }
        if m.points.len() != (3 * m.cols + 1) * (3 * m.rows + 1) || !m.points.iter().flatten().all(|v| v.is_finite()) {
            return Err("invalid warp mesh: expected (3 cols + 1) x (3 rows + 1) finite points".into());
        }
        if !stops_ok(&m.column_stops, m.cols) || !stops_ok(&m.row_stops, m.rows) {
            return Err("invalid warp mesh: stops must rise from 0 to 1, one per patch boundary".into());
        }
        Ok(m)
    }

    fn from_warp(w: &WarpMesh) -> Result<Mesh, String> {
        let (cols, rows) = (w.cols as usize, w.rows as usize);
        Mesh { cols, rows, points: w.points.clone(), column_stops: w.column_stops.clone(), row_stops: w.row_stops.clone() }.check()
    }

    fn to_warp(&self) -> WarpMesh {
        WarpMesh {
            cols: self.cols as u32,
            rows: self.rows as u32,
            points: self.points.clone(),
            column_stops: self.column_stops.clone(),
            row_stops: self.row_stops.clone(),
        }
    }

    // The mesh point at global parameters (s, t): Bernstein cubic in u on the patch's 4 rows,
    // then in v on the result.
    fn eval(&self, s: f64, t: f64) -> (f64, f64) {
        let ((i, u), (j, v)) = (locate(&self.column_stops, s), locate(&self.row_stops, t));
        let (bu, bv) = (bernstein(u), bernstein(v));
        let stride = 3 * self.cols + 1;
        let (mut x, mut y) = (0.0, 0.0);
        for (r, wv) in bv.iter().enumerate() {
            let (mut rx, mut ry) = (0.0, 0.0);
            for (k, wu) in bu.iter().enumerate() {
                let p = self.points[(3 * j + r) * stride + 3 * i + k];
                rx += wu * p[0];
                ry += wu * p[1];
            }
            x += wv * rx;
            y += wv * ry;
        }
        (x, y)
    }
}

/// A warp mesh from `warp_layer` JSON (camelCase keys), validated.
pub(super) fn parse_warp(json: &str) -> Result<WarpMesh, String> {
    Mesh::parse(json).map(|m| m.to_warp())
}

fn cross(o: (f64, f64), p: (f64, f64), q: (f64, f64)) -> f64 {
    (p.0 - o.0) * (q.1 - o.1) - (p.1 - o.1) * (q.0 - o.0)
}

// A dest triangle with the affine inverse to its source triangle.
struct Tri {
    d: [(f64, f64); 3],
    // source = (a0 + a1 dx + a2 dy, a3 + a4 dx + a5 dy) with (dx, dy) = p - d[0].
    a: [f64; 6],
    sign: f64,
    eps: f64,
    // Source px per dest px: sqrt |det| of the inverse.
    scale: f64,
    // Dest pixel bounds [x0, y0, x1, y1).
    bb: [i32; 4],
}

impl Tri {
    fn new(d: [(f64, f64); 3], s: [(f64, f64); 3]) -> Option<Tri> {
        let area = cross(d[0], d[1], d[2]);
        if area == 0.0 || !area.is_finite() {
            return None;
        }
        let (e1, e2) = ((d[1].0 - d[0].0, d[1].1 - d[0].1), (d[2].0 - d[0].0, d[2].1 - d[0].1));
        let (f1, f2) = ((s[1].0 - s[0].0, s[1].1 - s[0].1), (s[2].0 - s[0].0, s[2].1 - s[0].1));
        // A = S D^-1, with the edge vectors of dest (D) and source (S) as columns.
        let (i00, i01, i10, i11) = (e2.1 / area, -e2.0 / area, -e1.1 / area, e1.0 / area);
        let a = [
            s[0].0,
            f1.0 * i00 + f2.0 * i10,
            f1.0 * i01 + f2.0 * i11,
            s[0].1,
            f1.1 * i00 + f2.1 * i10,
            f1.1 * i01 + f2.1 * i11,
        ];
        let lo = |v: [f64; 3]| v.iter().fold(f64::INFINITY, |m, x| m.min(*x)).floor() as i32;
        let hi = |v: [f64; 3]| v.iter().fold(f64::NEG_INFINITY, |m, x| m.max(*x)).ceil() as i32;
        let (xs, ys) = (d.map(|p| p.0), d.map(|p| p.1));
        Some(Tri {
            d,
            a,
            sign: area.signum(),
            eps: area.abs() * 1e-6 + 1e-9,
            scale: (a[1] * a[5] - a[2] * a[4]).abs().sqrt(),
            bb: [lo(xs), lo(ys), hi(xs), hi(ys)],
        })
    }

    fn source(&self, p: (f64, f64)) -> Option<(f64, f64)> {
        let [a, b, c] = self.d;
        let inside = [cross(a, b, p), cross(b, c, p), cross(c, a, p)].iter().all(|e| e * self.sign >= -self.eps);
        let (dx, dy) = (p.0 - a.0, p.1 - a.1);
        inside.then(|| (self.a[0] + self.a[1] * dx + self.a[2] * dy, self.a[3] + self.a[4] * dx + self.a[5] * dy))
    }
}

// Per pixel of the tile at (ox, oy): source point and scale of the last triangle covering it.
fn cover(tris: &[Tri], bin: &[u32], ox: i32, oy: i32) -> Vec<Option<(f64, f64, f64)>> {
    let mut map = vec![None; TILE_PIXELS];
    for t in bin.iter().map(|i| &tris[*i as usize]) {
        let (x0, y0) = (t.bb[0].max(ox), t.bb[1].max(oy));
        let (x1, y1) = (t.bb[2].min(ox + TILE as i32), t.bb[3].min(oy + TILE as i32));
        for y in y0..y1 {
            for x in x0..x1 {
                if let Some((sx, sy)) = t.source((x as f64 + 0.5, y as f64 + 0.5)) {
                    map[(y - oy) as usize * TILE + (x - ox) as usize] = Some((sx, sy, t.scale));
                }
            }
        }
    }
    map
}

// A mesh tessellated into dest triangles, binned by the dest tiles their bounds touch.
struct Tess {
    rect: [i32; 4],
    tris: Vec<Tri>,
    // The largest source px per dest px of any triangle.
    most: f64,
    bins: Vec<Vec<u32>>,
    t0: (i32, i32),
    tw: usize,
}

impl Tess {
    // Mesh parameter (s, t) reads source point (b.x + s b.w, b.y + t b.h) and lands at mesh(s, t).
    fn new(mesh: &Mesh, b: [f64; 4]) -> Result<Tess, String> {
        let (mut lo, mut hi) = ((f64::INFINITY, f64::INFINITY), (f64::NEG_INFINITY, f64::NEG_INFINITY));
        for p in &mesh.points {
            lo = (lo.0.min(p[0]), lo.1.min(p[1]));
            hi = (hi.0.max(p[0]), hi.1.max(p[1]));
        }
        let (x0, y0, x1, y1) = (lo.0.floor(), lo.1.floor(), hi.0.ceil(), hi.1.ceil());
        if (x1 - x0) * (y1 - y0) > MAX_DEST_AREA {
            return Err(LIMIT.into());
        }
        if [x0, y0, x1, y1].iter().any(|v| v.abs() >= (1u64 << 29) as f64) {
            return Err("transform moves the layer too far".into());
        }
        let rect = [x0 as i32, y0 as i32, (x1 - x0) as i32, (y1 - y0) as i32];

        // Tessellate a uniform grid of patch evaluations, 2 triangles per cell, in order.
        let n = |len: i32| (len as f64 / 4.0).ceil().clamp(4.0, 512.0) as usize;
        let (nu, nv) = (n(rect[2]), n(rect[3]));
        let mut vert = Vec::with_capacity((nu + 1) * (nv + 1));
        for j in 0..=nv {
            for i in 0..=nu {
                let (s, t) = (i as f64 / nu as f64, j as f64 / nv as f64);
                vert.push((mesh.eval(s, t), (b[0] + s * b[2], b[1] + t * b[3])));
            }
        }
        let mut tris = Vec::with_capacity(nu * nv * 2);
        for j in 0..nv {
            for i in 0..nu {
                let k = j * (nu + 1) + i;
                for [p, q, r] in [[k, k + 1, k + nu + 2], [k, k + nu + 2, k + nu + 1]] {
                    tris.extend(Tri::new([vert[p].0, vert[q].0, vert[r].0], [vert[p].1, vert[q].1, vert[r].1]));
                }
            }
        }
        let most = tris.iter().map(|t| t.scale).filter(|v| v.is_finite()).fold(0.0, f64::max);

        // Bin triangles, in order, into the dest tiles their bounding boxes touch.
        let t = |v: i32| v.div_euclid(TILE as i32);
        let (tx0, ty0) = (t(rect[0]), t(rect[1]));
        let tw = (t(rect[0] + rect[2].max(1) - 1) - tx0 + 1) as usize;
        let th = (t(rect[1] + rect[3].max(1) - 1) - ty0 + 1) as usize;
        let mut bins = vec![Vec::new(); tw * th];
        for (i, tri) in tris.iter().enumerate() {
            let [bx0, by0, bx1, by1] = tri.bb;
            let (cx0, cx1) = ((t(bx0) - tx0).max(0), (t(bx1 - 1) - tx0).min(tw as i32 - 1));
            let (cy0, cy1) = ((t(by0) - ty0).max(0), (t(by1 - 1) - ty0).min(th as i32 - 1));
            for ty in cy0..=cy1 {
                for tx in cx0..=cx1 {
                    bins[ty as usize * tw + tx as usize].push(i as u32);
                }
            }
        }
        Ok(Tess { rect, tris, most, bins, t0: (tx0, ty0), tw })
    }

    fn bin(&self, ox: i32, oy: i32) -> &[u32] {
        let t = |v: i32| v.div_euclid(TILE as i32);
        &self.bins[(t(oy) - self.t0.1) as usize * self.tw + (t(ox) - self.t0.0) as usize]
    }
}

impl Document {
    // Dest tiles of `tess` sampled from `rs`; pixels no triangle covers get the edge value.
    fn render_tess(&mut self, tess: &Tess, rs: &Resampler, mask_default: Option<u32>) -> Result<Tiles, String> {
        let edge = mask_default.map_or(0.0, |d| d as f32 / self.max());
        let ch = if mask_default.is_some() { 1 } else { 4 };
        self.render_tiles_with(tess.rect, mask_default, false, |ox, oy, buf| {
            buf.fill(edge);
            let mut hit = false;
            for (p, at) in cover(&tess.tris, tess.bin(ox, oy), ox, oy).into_iter().enumerate() {
                if let Some((sx, sy, m)) = at {
                    hit |= rs.sample_point(sx, sy, m, &mut buf[p * ch..p * ch + ch]);
                }
            }
            hit
        })
    }

    /// Renders premultiplied `plane` through `w`, whose parameter square spans the plane rect `b`.
    pub(super) fn mesh_render(&mut self, w: &WarpMesh, plane: Plane, b: [f64; 4], interp: Interp) -> Result<Tiles, String> {
        let tess = Tess::new(&Mesh::from_warp(w)?, b)?;
        let rs = Resampler::pyramid(plane, interp, 0.0, tess.most);
        self.render_tess(&tess, &rs, None)
    }

    /// Warps a layer's pixels and mask by a mesh (JSON of `Mesh`) over the layer's tight bounds.
    /// Dest pixels no triangle covers become transparent (the mask default for the mask). A smart
    /// object stores the mesh (its parameter square spans the source) and renders from its source.
    pub fn warp_layer(&mut self, id: u32, mesh_json: &str, interp: Interp) -> Result<(), String> {
        self.check_idle()?;
        self.check_pixel_edit(id)?;
        if self.node(id)?.locks.position {
            return Err("layer position is locked".into());
        }
        let mesh = Mesh::parse(mesh_json)?;
        if let Kind::Smart(s) = &self.node(id)?.kind {
            let t = s.transform;
            return self.set_smart_placement(id, &t, Some(mesh.to_warp()));
        }
        let Some(b) = self.layer_bounds(id)? else { return Ok(()) };
        check_area(b)?;
        let tess = Tess::new(&mesh, b.map(|v| v as f64))?;
        let plane = self.rgba_plane(self.node(id)?.pixel_tiles()?, b, None);
        let rs = Resampler::pyramid(plane, interp, 0.0, tess.most);
        let pixels = self.render_tess(&tess, &rs, None)?;
        drop(rs);
        let mask = self.node(id)?.mask.as_ref().map(|mk| (mk.default, mk.tiles.clone()));
        let mask = match mask.and_then(|(def, tiles)| tile_rect(&tiles).map(|r| (def, tiles, r))) {
            Some((def, tiles, r)) => {
                let edge = def as f32 / self.max();
                let rs = Resampler::pyramid(self.mask_plane(&tiles, def, r), interp, edge, tess.most);
                Some(self.render_tess(&tess, &rs, Some(def))?)
            }
            None => None,
        };
        *self.node_mut(id)?.pixel_tiles_mut()? = pixels;
        if let Some(t) = mask {
            self.node_mut(id)?.mask.as_mut().expect("checked").tiles = t;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::super::transform::tests::{get_mask, get_px, put_mask, put_px};
    use super::*;

    // Control points of a cols x rows mesh whose points sit where `f` maps the uniform source
    // grid over `b`, so the warp is `f` itself when `f` is affine.
    fn mesh(b: [f64; 4], cols: usize, rows: usize, cs: &[f64], rs: &[f64], f: impl Fn(f64, f64) -> (f64, f64)) -> String {
        let param = |k: usize, n: usize, stops: &[f64]| {
            let i = (k / 3).min(n - 1);
            stops[i] + (k - 3 * i) as f64 / 3.0 * (stops[i + 1] - stops[i])
        };
        let mut pts = Vec::new();
        for r in 0..=3 * rows {
            for c in 0..=3 * cols {
                let (s, t) = (param(c, cols, cs), param(r, rows, rs));
                let (x, y) = f(b[0] + s * b[2], b[1] + t * b[3]);
                pts.push(serde_json::json!([x, y]));
            }
        }
        serde_json::json!({ "cols": cols, "rows": rows, "points": pts, "columnStops": cs, "rowStops": rs }).to_string()
    }

    // A w x h block of deterministic colour at (x0, y0); alpha 255 or varied.
    fn block(d: &mut Document, x0: i32, y0: i32, w: i32, h: i32, varied: bool) {
        let mut seed = 7u32;
        for y in y0..y0 + h {
            for x in x0..x0 + w {
                let mut v = [0u8; 4];
                for c in v.iter_mut() {
                    seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                    *c = (seed >> 24) as u8;
                }
                v[3] = if varied { v[3].max(1) } else { 255 };
                put_px(d, 1, x, y, v);
            }
        }
    }

    fn grid(d: &Document, r: [i32; 4]) -> Vec<[u8; 4]> {
        (r[1]..r[1] + r[3]).flat_map(|y| (r[0]..r[0] + r[2]).map(move |x| (x, y))).map(|(x, y)| get_px(d, 1, x, y)).collect()
    }

    #[test]
    fn identity_mesh_is_a_byte_exact_copy_inside() {
        let mut d = Document::new(64, 64, 8).unwrap();
        block(&mut d, 20, 20, 12, 9, true);
        let before = grid(&d, [0, 0, 64, 64]);
        let id = mesh([20.0, 20.0, 12.0, 9.0], 2, 1, &[0.0, 0.3, 1.0], &[0.0, 1.0], |x, y| (x, y));
        d.warp_layer(1, &id, Interp::Bicubic).unwrap();
        assert_eq!(grid(&d, [22, 22, 8, 5]), grid_of(&before, 64, [22, 22, 8, 5]));
        assert_eq!(d.layer_bounds(1).unwrap(), Some([20, 20, 12, 9]));
    }

    fn grid_of(all: &[[u8; 4]], w: i32, r: [i32; 4]) -> Vec<[u8; 4]> {
        (r[1]..r[1] + r[3]).flat_map(|y| (r[0]..r[0] + r[2]).map(move |x| all[(y * w + x) as usize])).collect()
    }

    #[test]
    fn integer_translate_mesh_moves_pixels_and_mask_and_the_old_mask_area_keeps_the_default() {
        let mut d = Document::new(64, 64, 8).unwrap();
        block(&mut d, 20, 20, 12, 9, false);
        d.add_mask(1, true).unwrap();
        put_mask(&mut d, 1, 24, 24, 0);
        let before = grid(&d, [20, 20, 12, 9]);
        let m = mesh([20.0, 20.0, 12.0, 9.0], 1, 1, &[0.0, 1.0], &[0.0, 1.0], |x, y| (x + 5.0, y + 3.0));
        d.warp_layer(1, &m, Interp::Bicubic).unwrap();
        assert_eq!(grid(&d, [27, 25, 8, 5]), grid_of(&before, 12, [2, 2, 8, 5]));
        assert_eq!(get_mask(&d, 1, 29, 27), 0);
        assert_eq!(get_mask(&d, 1, 24, 24), 255);
    }

    #[test]
    fn an_affine_mesh_matches_transform_layer_within_one_level() {
        let m = [1.1, 0.2, -10.0, -0.15, 1.05, 12.0, 0.0, 0.0, 1.0];
        let mut a = Document::new(128, 128, 8).unwrap();
        block(&mut a, 30, 30, 40, 30, false);
        let mut b = a.clone();
        b.transform_layer(1, &m, Interp::Bicubic).unwrap();
        let f = |x: f64, y: f64| (m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
        a.warp_layer(1, &mesh([30.0, 30.0, 40.0, 30.0], 3, 2, &[0.0, 0.2, 0.7, 1.0], &[0.0, 0.5, 1.0], f), Interp::Bicubic)
            .unwrap();
        let det = m[0] * m[4] - m[1] * m[3];
        let mut checked = 0;
        for y in 0..128 {
            for x in 0..128 {
                let (cx, cy) = (x as f64 + 0.5 - m[2], y as f64 + 0.5 - m[5]);
                let (sx, sy) = ((m[4] * cx - m[1] * cy) / det, (m[0] * cy - m[3] * cx) / det);
                if sx < 33.0 || sy < 33.0 || sx > 67.0 || sy > 57.0 {
                    continue;
                }
                let (p, q) = (get_px(&a, 1, x, y), get_px(&b, 1, x, y));
                assert!(p.iter().zip(q).all(|(u, v)| u.abs_diff(v) <= 1), "{x},{y}: {p:?} vs {q:?}");
                checked += 1;
            }
        }
        assert!(checked > 800, "{checked}");
    }

    #[test]
    fn on_fold_over_the_later_triangles_win() {
        let mut d = Document::new(64, 64, 8).unwrap();
        for y in 0..10 {
            for x in 0..20 {
                put_px(&mut d, 1, x, y, if x < 10 { [255, 0, 0, 255] } else { [0, 0, 255, 255] });
            }
        }
        // Patch 0 maps the left half onto x 0..10; patch 1 folds the right half back over it.
        let xs = [0.0, 10.0 / 3.0, 20.0 / 3.0, 10.0, 20.0 / 3.0, 10.0 / 3.0, 0.0];
        let mut pts = Vec::new();
        for r in 0..4 {
            for x in xs {
                pts.push(serde_json::json!([x, r as f64 * 10.0 / 3.0]));
            }
        }
        let m = serde_json::json!({ "cols": 2, "rows": 1, "points": pts, "columnStops": [0.0, 0.5, 1.0], "rowStops": [0.0, 1.0] });
        d.warp_layer(1, &m.to_string(), Interp::Nearest).unwrap();
        assert!(grid(&d, [0, 0, 10, 10]).iter().all(|p| *p == [0, 0, 255, 255]), "{:?}", grid(&d, [0, 0, 10, 10]));
        assert_eq!(get_px(&d, 1, 15, 5), [0; 4]);
    }

    #[test]
    fn a_warp_over_the_rendering_limit_is_refused_and_changes_nothing() {
        let mut d = Document::new(64, 64, 8).unwrap();
        block(&mut d, 0, 0, 20, 10, false);
        let before = grid(&d, [0, 0, 20, 10]);
        let m = mesh([0.0, 0.0, 20.0, 10.0], 1, 1, &[0.0, 1.0], &[0.0, 1.0], |x, y| (x * 1000.0, y * 1000.0));
        assert_eq!(d.warp_layer(1, &m, Interp::Bicubic).unwrap_err(), "The warped image exceeds the rendering limit.");
        assert_eq!(grid(&d, [0, 0, 20, 10]), before);
    }

    #[test]
    fn bad_meshes_are_refused_and_a_warp_is_one_snapshot_step() {
        let mut d = Document::new(64, 64, 8).unwrap();
        block(&mut d, 4, 4, 8, 8, false);
        for bad in [
            "{}",
            r#"{"cols":1,"rows":1,"points":[[0,0]],"columnStops":[0,1],"rowStops":[0,1]}"#,
            &mesh([4.0, 4.0, 8.0, 8.0], 1, 1, &[0.0, 1.0], &[0.0, 1.0], |x, y| (x, y)).replace("\"rowStops\":[0.0,1.0]", "\"rowStops\":[0.0,0.0]"),
        ] {
            assert!(d.warp_layer(1, bad, Interp::Bicubic).unwrap_err().starts_with("invalid warp mesh"), "{bad}");
        }
        let state = |d: &Document| {
            let mut v: serde_json::Value = serde_json::from_str(&d.manifest()).unwrap();
            v.as_object_mut().unwrap().remove("next_id");
            v
        };
        let mut core = EngineCore::new(d);
        let before = state(&core.doc);
        let snap = core.snapshot();
        let m = mesh([4.0, 4.0, 8.0, 8.0], 1, 1, &[0.0, 1.0], &[0.0, 1.0], |x, y| (x + 1.5 * y / 8.0, y));
        core.doc.warp_layer(1, &m, Interp::Bicubic).unwrap();
        assert_ne!(state(&core.doc), before);
        core.restore(snap).unwrap();
        assert_eq!(state(&core.doc), before);
    }
}
