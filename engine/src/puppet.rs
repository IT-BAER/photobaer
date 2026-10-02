//! Puppet Warp (docs/M5.md section 10): a triangle mesh over the opaque pixels, its pins solved
//! as-rigid-as-possible, rendered by the registry entry `puppet_warp` (param `rig`).

use std::cell::RefCell;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filters::{Ctx, Filter, Plane};
use crate::resample::{Interp, Plane as RPlane, Resampler};

pub const EMPTY: &str = "Puppet Warp needs an unlocked pixel layer with content.";
const MAX_CELLS: u64 = 1 << 20;
const MAX_PINS: usize = 1000;

/// The mesh: grid cells over (x, y) .. (x + w, y + h) at `step` document px, `cells` the run
/// lengths of empty and occupied cells (row-major, starting with empty), placed by `transform`.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grid {
    pub x: f64,
    pub y: f64,
    pub step: f64,
    pub w: f64,
    pub h: f64,
    pub cols: u64,
    pub rows: u64,
    pub cells: Vec<u64>,
    #[serde(default = "identity")]
    pub transform: [f64; 6],
}

fn identity() -> [f64; 6] {
    [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pin {
    pub x: f64,
    pub y: f64,
    pub tx: f64,
    pub ty: f64,
    pub rotation: f64,
    pub fixed: bool,
    pub depth: i32,
}

/// The `rig` param: mesh, pins (document px) and the session options.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rig {
    pub mesh: Grid,
    pub pins: Vec<Pin>,
    pub mode: String,
    pub density: String,
    pub expansion: f64,
}

const MODES: [&str; 3] = ["rigid", "normal", "distort"];
const DENSITIES: [&str; 3] = ["fewerPoints", "normal", "morePoints"];

fn finite(v: &[f64]) -> bool {
    v.iter().all(|n| n.is_finite())
}

impl Rig {
    pub fn parse(v: &Value) -> Result<Rig, String> {
        let r: Rig = serde_json::from_value(v.clone()).map_err(|e| format!("Puppet Warp: invalid rig: {e}"))?;
        let m = &r.mesh;
        let bad = |what: &str| Err(format!("Puppet Warp: {what}"));
        if !finite(&[m.x, m.y, m.step, m.w, m.h, r.expansion]) || !finite(&m.transform) || m.step <= 0.0 || m.w < 0.0 || m.h < 0.0 {
            return bad("the mesh needs finite bounds and a positive step");
        }
        let cells = m.cols.checked_mul(m.rows).filter(|c| (1..=MAX_CELLS).contains(c));
        if cells.is_none() || m.cells.iter().try_fold(0u64, |a, n| a.checked_add(*n)) != cells {
            return bad("the mesh cell runs must cover its cols x rows cells");
        }
        if r.pins.len() > MAX_PINS || !r.pins.iter().all(|p| finite(&[p.x, p.y, p.tx, p.ty, p.rotation])) {
            return bad("at most 1000 pins with finite positions");
        }
        if !MODES.contains(&r.mode.as_str()) || !DENSITIES.contains(&r.density.as_str()) || !(-50.0..=50.0).contains(&r.expansion) {
            return bad("mode, density or expansion out of range");
        }
        Ok(r)
    }

    fn exponent(&self) -> f64 {
        match self.mode.as_str() {
            "rigid" => 2.0,
            "distort" => 0.5,
            _ => 1.0,
        }
    }

    /// Nothing moved and nothing rotated: the warp is the identity.
    pub fn identity(&self) -> bool {
        self.pins.iter().all(|p| p.tx == p.x && p.ty == p.y && p.rotation == 0.0)
    }
}

/// The schema check of a `rig` param: parsed and written back in canonical form.
pub fn check(v: &Value) -> Result<Value, String> {
    serde_json::to_value(Rig::parse(v)?).map_err(|e| e.to_string())
}

/// A rig after the affine document map `m` (row-major 3x3): the mesh placement composes with it,
/// pins move with it, and a mirroring map turns pin rotations the other way.
pub fn remapped(v: &Value, m: &[f64; 9]) -> Result<Value, String> {
    let mut r = Rig::parse(v)?;
    let t = r.mesh.transform;
    r.mesh.transform = [
        m[0] * t[0] + m[1] * t[3],
        m[0] * t[1] + m[1] * t[4],
        m[0] * t[2] + m[1] * t[5] + m[2],
        m[3] * t[0] + m[4] * t[3],
        m[3] * t[1] + m[4] * t[4],
        m[3] * t[2] + m[4] * t[5] + m[5],
    ];
    let at = |x: f64, y: f64| (m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]);
    let flip = m[0] * m[4] - m[1] * m[3] < 0.0;
    for p in &mut r.pins {
        ((p.x, p.y), (p.tx, p.ty)) = (at(p.x, p.y), at(p.tx, p.ty));
        if flip {
            p.rotation = -p.rotation;
        }
    }
    serde_json::to_value(r).map_err(|e| e.to_string())
}

/// Rest vertices, triangles (vertices in first-use order) and spacing of a grid.
pub struct Mesh {
    pub verts: Vec<[f64; 2]>,
    pub tris: Vec<[usize; 3]>,
    pub spacing: f64,
}

impl Mesh {
    pub fn of(g: &Grid) -> Mesh {
        let (cols, rows) = (g.cols as usize, g.rows as usize);
        let mut occupied = Vec::with_capacity(cols * rows);
        for (k, n) in g.cells.iter().enumerate() {
            occupied.extend(std::iter::repeat_n(k % 2 == 1, *n as usize));
        }
        let t = g.transform;
        let mut index = vec![usize::MAX; (cols + 1) * (rows + 1)];
        let mut verts = Vec::new();
        let mut node = |u: usize, v: usize| {
            let k = v * (cols + 1) + u;
            if index[k] == usize::MAX {
                let (x, y) = (g.x + (u as f64 * g.step).min(g.w), g.y + (v as f64 * g.step).min(g.h));
                index[k] = verts.len();
                verts.push([t[0] * x + t[1] * y + t[2], t[3] * x + t[4] * y + t[5]]);
            }
            index[k]
        };
        let mut tris = Vec::new();
        for v in 0..rows {
            for u in 0..cols {
                if !occupied[v * cols + u] {
                    continue;
                }
                let (a, b, c, d) = (node(u, v), node(u + 1, v), node(u + 1, v + 1), node(u, v + 1));
                tris.push([a, b, c]);
                tris.push([a, c, d]);
            }
        }
        let spacing = g.step * (t[0] * t[4] - t[1] * t[3]).abs().sqrt();
        Mesh { verts, tris, spacing }
    }
}

/// A mesh over the alpha of a `w` x `h` proxy at `s` proxy px per document px whose pixel (0, 0)
/// sits at document `origin`; None when no pixel is opaque.
pub fn build(alpha: &[f32], w: usize, h: usize, origin: (f64, f64), s: f64, density: &str, expansion: f64) -> Option<Grid> {
    let (base, div) = match density {
        "fewerPoints" => (32.0, 40.0),
        "morePoints" => (8.0, 96.0),
        _ => (16.0, 64.0),
    };
    let r = (base * s).max(w.max(h) as f64 / div).max(2.0);
    let mut a: Vec<bool> = alpha.iter().map(|v| *v > 0.0).collect();
    let q = (expansion * s).round() as i64;
    let (mut aw, mut ah, mut o) = (w, h, origin);
    if q > 0 {
        let q = q as usize;
        (a, aw, ah) = (morph(&a, w, h, q, true), w + 2 * q, h + 2 * q);
        o = (o.0 - q as f64 / s, o.1 - q as f64 / s);
    } else if q < 0 {
        a = morph(&a, w, h, (-q) as usize, false);
    }
    let (cols, rows) = (((aw as f64 / r).ceil() as usize).max(1), ((ah as f64 / r).ceil() as usize).max(1));
    let mut runs = vec![0u64];
    let mut any = false;
    for v in 0..rows {
        for u in 0..cols {
            let (x0, y0) = ((u as f64 * r).floor() as usize, (v as f64 * r).floor() as usize);
            let (x1, y1) = (((u as f64 * r + r).ceil() as usize).min(aw), ((v as f64 * r + r).ceil() as usize).min(ah));
            let hit = (y0..y1).any(|y| (x0..x1).any(|x| a[y * aw + x]));
            any |= hit;
            if hit == (runs.len() % 2 == 0) {
                *runs.last_mut().expect("one run") += 1;
            } else {
                runs.push(1);
            }
        }
    }
    any.then(|| Grid { x: o.0, y: o.1, step: r / s, w: aw as f64 / s, h: ah as f64 / s, cols: cols as u64, rows: rows as u64, cells: runs, transform: identity() })
}

// A binary `w` x `h` image dilated (grown by `q` on every side, so (w + 2q) x (h + 2q)) or eroded
// (same size) by a disc of radius `q`.
fn morph(a: &[bool], w: usize, h: usize, q: usize, grow: bool) -> Vec<bool> {
    let qi = q as i64;
    let disc: Vec<(i64, i64)> = (-qi..=qi).flat_map(|dy| (-qi..=qi).map(move |dx| (dx, dy))).filter(|(dx, dy)| dx * dx + dy * dy <= qi * qi).collect();
    let at = |x: i64, y: i64| x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h && a[y as usize * w + x as usize];
    if grow {
        let (ow, oh) = (w + 2 * q, h + 2 * q);
        (0..ow * oh).map(|k| { let (x, y) = ((k % ow) as i64 - qi, (k / ow) as i64 - qi); disc.iter().any(|(dx, dy)| at(x + dx, y + dy)) }).collect()
    } else {
        (0..w * h).map(|k| { let (x, y) = ((k % w) as i64, (k / w) as i64); disc.iter().all(|(dx, dy)| at(x + dx, y + dy)) }).collect()
    }
}

// Inverse-distance weight 1 / d^(2e) of squared distance `d2`.
fn weight(d2: f64, e: f64) -> f64 {
    1.0 / d2.powf(e)
}

// The rotation pre-pass: rotating pins turn nearby points around them.
fn rotated(pins: &[Pin], x: f64, y: f64, e: f64) -> (f64, f64) {
    let (mut s, mut ox, mut oy) = (0.0, 0.0, 0.0);
    for c in pins.iter().filter(|c| c.rotation != 0.0) {
        let (dx, dy) = (x - c.x, y - c.y);
        let d2 = dx * dx + dy * dy;
        let u = if d2 == 0.0 { 1e12 } else { weight(d2, e) };
        let (cs, sn) = (c.rotation.cos(), c.rotation.sin());
        ox += u * (dx * cs - dy * sn - dx);
        oy += u * (dx * sn + dy * cs - dy);
        s += u;
    }
    if s == 0.0 {
        return (x, y);
    }
    for c in pins.iter().filter(|c| c.rotation == 0.0) {
        let (dx, dy) = (x - c.x, y - c.y);
        let d2 = dx * dx + dy * dy;
        s += if d2 == 0.0 { 1e12 } else { weight(d2, e) };
    }
    (x + ox / s, y + oy / s)
}

// Moving least squares similarity deformation of point (x, y) by the pins.
fn similarity(pins: &[Pin], x: f64, y: f64, e: f64) -> (f64, f64) {
    let (mut s, mut px, mut py, mut qx, mut qy) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for c in pins {
        let (dx, dy) = (x - c.x, y - c.y);
        let d2 = dx * dx + dy * dy;
        if d2 < 1e-12 {
            return (c.tx, c.ty);
        }
        let w = weight(d2, e);
        s += w;
        px += w * c.x;
        py += w * c.y;
        qx += w * c.tx;
        qy += w * c.ty;
    }
    if s == 0.0 {
        return (x, y);
    }
    (px, py, qx, qy) = (px / s, py / s, qx / s, qy / s);
    let (vx, vy) = (x - px, y - py);
    let (mut fx, mut fy) = (0.0, 0.0);
    for c in pins {
        let (dx, dy) = (x - c.x, y - c.y);
        let w = weight(dx * dx + dy * dy, e);
        let (hx, hy, rx, ry) = (c.x - px, c.y - py, c.tx - qx, c.ty - qy);
        let (i, j, z, k) = (w * (hx * vx + hy * vy), w * (hx * vy - hy * vx), w * (hy * vx - hx * vy), w * (hy * vy + hx * vx));
        fx += rx * i + ry * z;
        fy += rx * j + ry * k;
    }
    let n = fx.hypot(fy);
    if n == 0.0 {
        return (qx, qy);
    }
    let l = vx.hypot(vy);
    (qx + fx / n * l, qy + fy / n * l)
}

struct Edge {
    a: usize,
    b: usize,
    w: f64,
    x: f64,
    y: f64,
}

// Cotangent edge weights (positive only) and their per-vertex sums.
fn laplacian(m: &Mesh) -> (Vec<Edge>, Vec<f64>) {
    let mut at = std::collections::HashMap::new();
    let mut edges: Vec<Edge> = Vec::new();
    for t in &m.tris {
        for c in 0..3 {
            let (a, b, o) = (t[c], t[(c + 1) % 3], m.verts[t[(c + 2) % 3]]);
            let (u, v) = (m.verts[a], m.verts[b]);
            let (ox, oy, px, py) = (u[0] - o[0], u[1] - o[1], v[0] - o[0], v[1] - o[1]);
            let k = (ox * py - oy * px).abs();
            if k < 1e-12 {
                continue;
            }
            let key = (a.min(b), a.max(b));
            let i = *at.entry(key).or_insert_with(|| {
                edges.push(Edge { a, b, w: 0.0, x: 0.0, y: 0.0 });
                edges.len() - 1
            });
            edges[i].w += (ox * px + oy * py) / (2.0 * k);
        }
    }
    let mut diag = vec![0.0; m.verts.len()];
    edges.retain_mut(|e| {
        e.w = e.w.max(0.0);
        if e.w == 0.0 {
            return false;
        }
        (e.x, e.y) = (m.verts[e.a][0] - m.verts[e.b][0], m.verts[e.a][1] - m.verts[e.b][1]);
        diag[e.a] += e.w;
        diag[e.b] += e.w;
        true
    });
    (edges, diag)
}

// A soft constraint: barycentric weights of a rest point and its target.
struct Bind {
    idx: Vec<usize>,
    w: Vec<f64>,
    x: f64,
    y: f64,
}

fn bind(m: &Mesh, x: f64, y: f64, tx: f64, ty: f64) -> Bind {
    for t in &m.tris {
        let [v, p, u] = t.map(|i| m.verts[i]);
        let s = (p[1] - u[1]) * (v[0] - u[0]) + (u[0] - p[0]) * (v[1] - u[1]);
        if s.abs() < 1e-12 {
            continue;
        }
        let o = ((p[1] - u[1]) * (x - u[0]) + (u[0] - p[0]) * (y - u[1])) / s;
        let q = ((u[1] - v[1]) * (x - u[0]) + (v[0] - u[0]) * (y - u[1])) / s;
        let r = 1.0 - o - q;
        if o.min(q).min(r) >= -1e-8 {
            return Bind { idx: t.to_vec(), w: vec![o, q, r], x: tx, y: ty };
        }
    }
    let (mut best, mut bd) = (0, f64::INFINITY);
    for (i, v) in m.verts.iter().enumerate() {
        let d = (v[0] - x).powi(2) + (v[1] - y).powi(2);
        if d < bd {
            (best, bd) = (i, d);
        }
    }
    let c = m.verts[best];
    Bind { idx: vec![best], w: vec![1.0], x: tx + c[0] - x, y: ty + c[1] - y }
}

// As-rigid-as-possible refinement of the initial positions `init`: local rotations, then a
// Jacobi-preconditioned CG global step per axis, at most 24 rounds.
fn arap(m: &Mesh, pins: &[Pin], init: &[[f64; 2]], rigid: bool) -> Vec<[f64; 2]> {
    let n = m.verts.len();
    if n == 0 || pins.len() < 2 {
        return init.to_vec();
    }
    let (edges, lap) = laplacian(m);
    let mut binds: Vec<Bind> = pins.iter().map(|p| bind(m, p.x, p.y, p.tx, p.ty)).collect();
    for p in pins.iter().filter(|p| p.rotation != 0.0 || p.fixed) {
        let l = (m.spacing / 4.0).max(0.25);
        let (cs, sn) = (p.rotation.cos(), p.rotation.sin());
        for (a, b) in [(l, 0.0), (0.0, l)] {
            binds.push(bind(m, p.x + a, p.y + b, p.tx + cs * a - sn * b, p.ty + sn * a + cs * b));
        }
    }
    const C: f64 = 1e5;
    const EPS: f64 = 1e-9;
    let mut diag: Vec<f64> = lap.iter().map(|v| v + EPS).collect();
    for b in &binds {
        for (i, w) in b.idx.iter().zip(&b.w) {
            diag[*i] += C * w * w;
        }
    }
    let apply = |x: &[f64], out: &mut [f64]| {
        for i in 0..n {
            out[i] = EPS * x[i];
        }
        for e in &edges {
            let v = e.w * (x[e.a] - x[e.b]);
            out[e.a] += v;
            out[e.b] -= v;
        }
        for b in &binds {
            let v: f64 = b.idx.iter().zip(&b.w).map(|(i, w)| w * x[*i]).sum();
            for (i, w) in b.idx.iter().zip(&b.w) {
                out[*i] += C * w * v;
            }
        }
    };
    let (mut r, mut z, mut d, mut q) = (vec![0.0; n], vec![0.0; n], vec![0.0; n], vec![0.0; n]);
    let mut solve = |x: &mut [f64], rhs: &[f64]| {
        apply(x, &mut q);
        let (mut rz, mut rr) = (0.0, 0.0);
        for i in 0..n {
            r[i] = rhs[i] - q[i];
            z[i] = r[i] / diag[i];
            d[i] = z[i];
            rz += r[i] * z[i];
            rr += r[i] * r[i];
        }
        let tol = (rr * 1e-16).max(1e-16);
        let mut it = 0;
        while it < 500.min(2 * n) && rr > tol {
            apply(&d, &mut q);
            let dq: f64 = d.iter().zip(&q).map(|(a, b)| a * b).sum();
            if dq <= 1e-30 {
                break;
            }
            let alpha = rz / dq;
            let mut nz = 0.0;
            rr = 0.0;
            for i in 0..n {
                x[i] += alpha * d[i];
                r[i] -= alpha * q[i];
                z[i] = r[i] / diag[i];
                nz += r[i] * z[i];
                rr += r[i] * r[i];
            }
            let beta = nz / rz;
            for i in 0..n {
                d[i] = z[i] + beta * d[i];
            }
            rz = nz;
            it += 1;
        }
    };
    let (mut px, mut py): (Vec<f64>, Vec<f64>) = (init.iter().map(|p| p[0]).collect(), init.iter().map(|p| p[1]).collect());
    let (mut cs, mut sn) = (vec![1.0; n], vec![0.0; n]);
    let (mut bx, mut by) = (vec![0.0; n], vec![0.0; n]);
    for _ in 0..24 {
        bx.fill(0.0);
        by.fill(0.0);
        for e in &edges {
            let (dx, dy) = (px[e.a] - px[e.b], py[e.a] - py[e.b]);
            let (c, s) = (e.w * (e.x * dx + e.y * dy), e.w * (e.x * dy - e.y * dx));
            bx[e.a] += c;
            bx[e.b] += c;
            by[e.a] += s;
            by[e.b] += s;
        }
        for i in 0..n {
            let l = bx[i].hypot(by[i]);
            (cs[i], sn[i]) = if l > 1e-15 { (bx[i] / l, by[i] / l) } else { (1.0, 0.0) };
        }
        if rigid {
            bx.copy_from_slice(&cs);
            by.copy_from_slice(&sn);
            for e in &edges {
                bx[e.a] += cs[e.b] * e.w;
                bx[e.b] += cs[e.a] * e.w;
                by[e.a] += sn[e.b] * e.w;
                by[e.b] += sn[e.a] * e.w;
            }
            for i in 0..n {
                let l = bx[i].hypot(by[i]);
                if l > 1e-15 {
                    (cs[i], sn[i]) = (bx[i] / l, by[i] / l);
                }
            }
        }
        for i in 0..n {
            (bx[i], by[i]) = (EPS * init[i][0], EPS * init[i][1]);
        }
        for e in &edges {
            let (c, s) = ((cs[e.a] + cs[e.b]) / 2.0, (sn[e.a] + sn[e.b]) / 2.0);
            let (u, v) = (e.w * (c * e.x - s * e.y), e.w * (s * e.x + c * e.y));
            bx[e.a] += u;
            bx[e.b] -= u;
            by[e.a] += v;
            by[e.b] -= v;
        }
        for b in &binds {
            for (i, w) in b.idx.iter().zip(&b.w) {
                bx[*i] += C * w * b.x;
                by[*i] += C * w * b.y;
            }
        }
        let (ox, oy) = (px.clone(), py.clone());
        solve(&mut px, &bx);
        solve(&mut py, &by);
        let moved = (0..n).map(|i| (px[i] - ox[i]).hypot(py[i] - oy[i])).fold(0.0, f64::max);
        if moved < 1e-5 {
            break;
        }
    }
    let mut out: Vec<[f64; 2]> = (0..n).map(|i| [px[i], py[i]]).collect();
    for p in pins {
        for (j, v) in m.verts.iter().enumerate() {
            if (v[0] - p.x).abs() < 1e-10 && (v[1] - p.y).abs() < 1e-10 {
                out[j] = [p.tx, p.ty];
            }
        }
    }
    out
}

/// The deformed vertices of `m` under the rig's pins and mode.
pub fn deform(m: &Mesh, rig: &Rig) -> Vec<[f64; 2]> {
    let pins = &rig.pins;
    if pins.is_empty() || rig.identity() {
        return m.verts.clone();
    }
    let e = rig.exponent();
    if pins.len() == 1 {
        let c = &pins[0];
        let (cs, sn) = (c.rotation.cos(), c.rotation.sin());
        return m.verts.iter().map(|v| { let (dx, dy) = (v[0] - c.x, v[1] - c.y); [c.tx + dx * cs - dy * sn, c.ty + dx * sn + dy * cs] }).collect();
    }
    let turn = pins.iter().any(|p| p.rotation != 0.0);
    let init: Vec<[f64; 2]> = m
        .verts
        .iter()
        .map(|v| {
            let (x, y) = if turn { rotated(pins, v[0], v[1], e) } else { (v[0], v[1]) };
            let (x, y) = similarity(pins, x, y, e);
            [x, y]
        })
        .collect();
    if rig.mode == "distort" { init } else { arap(m, pins, &init, rig.mode == "rigid") }
}

thread_local! {
    // The last solve, keyed by the rig JSON: a render and its stack extent share one solve.
    static LAST: RefCell<Option<(String, Arc<(Mesh, Vec<[f64; 2]>)>)>> = const { RefCell::new(None) };
}

fn solved(v: &Value) -> Result<(Rig, Arc<(Mesh, Vec<[f64; 2]>)>), String> {
    let rig = Rig::parse(v)?;
    let key = v.to_string();
    if let Some(hit) = LAST.with(|l| l.borrow().as_ref().filter(|(k, _)| *k == key).map(|(_, s)| s.clone())) {
        return Ok((rig, hit));
    }
    let mesh = Mesh::of(&rig.mesh);
    let def = deform(&mesh, &rig);
    let s = Arc::new((mesh, def));
    LAST.with(|l| *l.borrow_mut() = Some((key, s.clone())));
    Ok((rig, s))
}

/// `{ rest, deformed, triangles }` (flat arrays) of a rig JSON, for the session overlay.
pub fn geometry(json: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("Puppet Warp: invalid rig: {e}"))?;
    let (_, s) = solved(&v)?;
    let flat = |p: &[[f64; 2]]| p.iter().flatten().copied().collect::<Vec<f64>>();
    let tris: Vec<usize> = s.0.tris.iter().flatten().copied().collect();
    Ok(serde_json::json!({ "rest": flat(&s.0.verts), "deformed": flat(&s.1), "triangles": tris }).to_string())
}

/// The document rect the warp of a source within `r` can cover: `r` and the deformed mesh.
pub fn extent(f: &Filter, r: [i32; 4]) -> Result<[i32; 4], String> {
    let (rig, s) = solved(f.params.get("rig").unwrap_or(&Value::Null))?;
    if rig.identity() || s.1.is_empty() {
        return Ok(r);
    }
    let (mut x0, mut y0, mut x1, mut y1) = (r[0] as f64, r[1] as f64, (r[0] + r[2]) as f64, (r[1] + r[3]) as f64);
    for p in &s.1 {
        (x0, y0, x1, y1) = (x0.min(p[0]), y0.min(p[1]), x1.max(p[0]), y1.max(p[1]));
    }
    let lim = (1u64 << 29) as f64;
    if ![x0, y0, x1, y1].iter().all(|v| v.abs() < lim) {
        return Err("The warped image exceeds the rendering limit.".into());
    }
    let (x0, y0) = (x0.floor(), y0.floor());
    Ok([x0 as i32, y0 as i32, (x1.ceil() - x0) as i32, (y1.ceil() - y0) as i32])
}

// A dest triangle (plane px) with its affine inverse to the source triangle.
struct Tri {
    d: [(f64, f64); 3],
    a: [f64; 6],
    sign: f64,
    eps: f64,
    scale: f64,
    y0: i64,
    y1: i64,
    x0: i64,
    x1: i64,
}

fn cross(o: (f64, f64), p: (f64, f64), q: (f64, f64)) -> f64 {
    (p.0 - o.0) * (q.1 - o.1) - (p.1 - o.1) * (q.0 - o.0)
}

impl Tri {
    fn new(d: [(f64, f64); 3], s: [(f64, f64); 3]) -> Option<Tri> {
        let area = cross(d[0], d[1], d[2]);
        if area == 0.0 || !area.is_finite() {
            return None;
        }
        let (e1, e2) = ((d[1].0 - d[0].0, d[1].1 - d[0].1), (d[2].0 - d[0].0, d[2].1 - d[0].1));
        let (f1, f2) = ((s[1].0 - s[0].0, s[1].1 - s[0].1), (s[2].0 - s[0].0, s[2].1 - s[0].1));
        let (i00, i01, i10, i11) = (e2.1 / area, -e2.0 / area, -e1.1 / area, e1.0 / area);
        let a = [s[0].0, f1.0 * i00 + f2.0 * i10, f1.0 * i01 + f2.0 * i11, s[0].1, f1.1 * i00 + f2.1 * i10, f1.1 * i01 + f2.1 * i11];
        let lo = |v: [f64; 3]| v.iter().fold(f64::INFINITY, |m, x| m.min(*x)).floor() as i64;
        let hi = |v: [f64; 3]| v.iter().fold(f64::NEG_INFINITY, |m, x| m.max(*x)).ceil() as i64;
        let (xs, ys) = (d.map(|p| p.0), d.map(|p| p.1));
        Some(Tri { d, a, sign: area.signum(), eps: area.abs() * 1e-6 + 1e-9, scale: (a[1] * a[5] - a[2] * a[4]).abs().sqrt(), x0: lo(xs), y0: lo(ys), x1: hi(xs), y1: hi(ys) })
    }

    fn source(&self, p: (f64, f64)) -> Option<(f64, f64)> {
        let [a, b, c] = self.d;
        let inside = [cross(a, b, p), cross(b, c, p), cross(c, a, p)].iter().all(|e| e * self.sign >= -self.eps);
        let (dx, dy) = (p.0 - a.0, p.1 - a.1);
        inside.then(|| (self.a[0] + self.a[1] * dx + self.a[2] * dy, self.a[3] + self.a[4] * dx + self.a[5] * dy))
    }
}

// Draws `tris` (later wins on overlap) from a copy of `p`; pixels no triangle covers become transparent.
fn raster(p: &mut Plane, tris: &[Tri]) {
    let most = tris.iter().map(|t| t.scale).filter(|v| v.is_finite()).fold(0.0, f64::max);
    let mut src = Plane { data: p.data.clone(), ..*p };
    src.premultiply();
    let rs = Resampler::pyramid(RPlane { x: p.x, y: p.y, w: p.w, h: p.h, ch: 4, sx: 1.0, sy: 1.0, data: src.data }, Interp::Bicubic, 0.0, most);
    p.data.fill(0.0);
    const BAND: usize = 64;
    let mut map: Vec<Option<(f64, f64, f64)>> = vec![None; p.w * BAND];
    for b0 in (0..p.h).step_by(BAND) {
        let b1 = (b0 + BAND).min(p.h);
        map.fill(None);
        let (py0, py1) = (p.y as i64 + b0 as i64, p.y as i64 + b1 as i64);
        for t in tris.iter().filter(|t| t.y1 > py0 && t.y0 < py1) {
            let (x0, x1) = (t.x0.max(p.x as i64), t.x1.min(p.x as i64 + p.w as i64));
            for y in t.y0.max(py0)..t.y1.min(py1) {
                for x in x0..x1 {
                    if let Some((sx, sy)) = t.source((x as f64 + 0.5, y as f64 + 0.5)) {
                        map[(y - py0) as usize * p.w + (x - p.x as i64) as usize] = Some((sx, sy, t.scale));
                    }
                }
            }
        }
        for (k, at) in map[..(b1 - b0) * p.w].iter().enumerate() {
            if let Some((sx, sy, m)) = at {
                let o = ((b0 * p.w) + k) * 4;
                rs.sample_point(*sx, *sy, *m, &mut p.data[o..o + 4]);
            }
        }
    }
}

/// The registry entry `puppet_warp`: the plane (straight RGBA, `ctx.scale` px per document px)
/// through the deformed mesh; pixels no triangle covers become transparent. On overlap the
/// triangle nearest the deeper pin wins.
pub fn apply(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let (rig, solve) = solved(f.params.get("rig").unwrap_or(&Value::Null))?;
    if rig.identity() || p.w == 0 || p.h == 0 {
        return Ok(());
    }
    let (mesh, def) = (&solve.0, &solve.1);
    let (s, e) = (ctx.scale, rig.exponent());
    // Triangle depth: that of the pin weighing most at its rest centroid; stable sort, later wins.
    let depth = |t: &[usize; 3]| {
        let (cx, cy) = (t.iter().map(|i| mesh.verts[*i][0]).sum::<f64>() / 3.0, t.iter().map(|i| mesh.verts[*i][1]).sum::<f64>() / 3.0);
        let (mut d, mut best) = (0, f64::NEG_INFINITY);
        for pin in &rig.pins {
            let d2 = (cx - pin.x).powi(2) + (cy - pin.y).powi(2);
            let w = if d2 < 1e-12 { f64::INFINITY } else { weight(d2, e) };
            if w > best {
                (best, d) = (w, pin.depth);
            }
        }
        d
    };
    let mut order: Vec<(i32, &[usize; 3])> = mesh.tris.iter().map(|t| (depth(t), t)).collect();
    order.sort_by_key(|(d, _)| *d);
    let at = |v: [f64; 2]| (v[0] * s, v[1] * s);
    let tris: Vec<Tri> = order.iter().filter_map(|(_, t)| Tri::new(t.map(|i| at(def[i])), t.map(|i| at(mesh.verts[i])))).collect();
    raster(p, &tris);
    Ok(())
}

/// A PSD puppet as triangles: `PSPW`, then u32 LE version, vertex count, triangle count, the source
/// then the target vertices as f64 LE (x, y), the triangle indices as u32 LE and per-triangle depth as i32 LE.
const PSD_MAGIC: &[u8; 4] = b"PSPW";
const PSD_HEADER: usize = 16;
const PSD_MAX_VERTS: usize = 1 << 20;
const PSD_MAX_TRIS: usize = 1 << 21;

pub struct PsdPuppet {
    pub source: Vec<[f64; 2]>,
    pub target: Vec<[f64; 2]>,
    pub tris: Vec<([usize; 3], i32)>,
}

impl PsdPuppet {
    pub fn from_bytes(b: &[u8]) -> Result<PsdPuppet, String> {
        const BAD: &str = "the Photoshop puppet mesh is damaged";
        if b.len() < PSD_HEADER || &b[..4] != PSD_MAGIC {
            return Err(BAD.into());
        }
        let u = |at: usize| u32::from_le_bytes(b[at..at + 4].try_into().expect("4 bytes"));
        let (nv, nt) = (u(8) as usize, u(12) as usize);
        if u(4) != 1 || nv > PSD_MAX_VERTS || nt > PSD_MAX_TRIS || b.len() != PSD_HEADER + nv * 32 + nt * 16 {
            return Err(BAD.into());
        }
        let f = |at: usize| f64::from_le_bytes(b[at..at + 8].try_into().expect("8 bytes"));
        let pts = |at: usize| (0..nv).map(|i| [f(at + i * 16), f(at + i * 16 + 8)]).collect::<Vec<_>>();
        let (source, target) = (pts(PSD_HEADER), pts(PSD_HEADER + nv * 16));
        if !source.iter().chain(&target).flatten().all(|v| v.is_finite()) {
            return Err(BAD.into());
        }
        let at = PSD_HEADER + nv * 32;
        let tris: Vec<([usize; 3], i32)> = (0..nt).map(|t| ([0, 1, 2].map(|k| u(at + t * 12 + k * 4) as usize), u(at + nt * 12 + t * 4) as i32)).collect();
        if tris.iter().any(|(t, _)| t.iter().any(|&i| i >= nv)) {
            return Err(BAD.into());
        }
        Ok(PsdPuppet { source, target, tris })
    }

    fn identity(&self) -> bool {
        self.source == self.target
    }
}

/// The registry entry `psd_filter`: its `puppet` blob (if any) through the deformed PSD triangles,
/// drawn in order of depth; without one the plane is untouched.
pub fn apply_psd(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let Some(id) = f.blob() else { return Ok(()) };
    let rig = PsdPuppet::from_bytes(ctx.blobs.get(&id).ok_or_else(|| format!("unknown blob {id}"))?)?;
    if rig.identity() || p.w == 0 || p.h == 0 {
        return Ok(());
    }
    let mut order: Vec<&([usize; 3], i32)> = rig.tris.iter().collect();
    order.sort_by_key(|(_, d)| *d);
    let at = |v: [f64; 2]| (v[0] * ctx.scale, v[1] * ctx.scale);
    let tris: Vec<Tri> = order.iter().filter_map(|(t, _)| Tri::new(t.map(|i| at(rig.target[i])), t.map(|i| at(rig.source[i])))).collect();
    raster(p, &tris);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(x: f64, y: f64, tx: f64, ty: f64) -> Pin {
        Pin { x, y, tx, ty, rotation: 0.0, fixed: false, depth: 0 }
    }

    fn grid(cols: u64, rows: u64) -> Grid {
        Grid { x: 0.0, y: 0.0, step: 10.0, w: cols as f64 * 10.0, h: rows as f64 * 10.0, cols, rows, cells: vec![0, cols * rows], transform: identity() }
    }

    fn rig(pins: Vec<Pin>, mode: &str) -> Rig {
        Rig { mesh: grid(6, 2), pins, mode: mode.into(), density: "normal".into(), expansion: 2.0 }
    }

    #[test]
    fn a_full_grid_has_shared_vertices_and_two_triangles_per_cell() {
        let m = Mesh::of(&grid(3, 2));
        assert_eq!((m.verts.len(), m.tris.len(), m.spacing), (12, 12, 10.0));
        assert_eq!(m.tris[0], [0, 1, 2]);
    }

    #[test]
    fn moving_every_pin_by_the_same_offset_translates_every_vertex() {
        let r = rig(vec![pin(0.0, 0.0, 10.0, 0.0), pin(60.0, 0.0, 70.0, 0.0), pin(30.0, 20.0, 40.0, 20.0)], "rigid");
        let m = Mesh::of(&r.mesh);
        for (v, d) in m.verts.iter().zip(deform(&m, &r)) {
            assert!((d[0] - v[0] - 10.0).abs() < 1e-6 && (d[1] - v[1]).abs() < 1e-6, "{v:?} -> {d:?}");
        }
    }

    #[test]
    fn the_solve_is_deterministic_and_pins_land_on_their_targets() {
        let r = rig(vec![pin(0.0, 10.0, 0.0, 10.0), pin(30.0, 10.0, 30.0, 10.0), pin(60.0, 10.0, 60.0, 30.0)], "normal");
        let m = Mesh::of(&r.mesh);
        let (a, b) = (deform(&m, &r), deform(&m, &r));
        assert_eq!(a, b);
        let j = m.verts.iter().position(|v| *v == [60.0, 10.0]).unwrap();
        assert_eq!(a[j], [60.0, 30.0]);
    }

    #[test]
    fn a_single_pin_rotates_the_mesh_rigidly() {
        let mut p = pin(30.0, 10.0, 30.0, 10.0);
        p.rotation = std::f64::consts::FRAC_PI_2;
        let r = rig(vec![p], "normal");
        let m = Mesh::of(&r.mesh);
        let d = deform(&m, &r);
        let j = m.verts.iter().position(|v| *v == [40.0, 10.0]).unwrap();
        assert!((d[j][0] - 30.0).abs() < 1e-9 && (d[j][1] - 20.0).abs() < 1e-9, "{:?}", d[j]);
    }

    #[test]
    fn meshes_skip_empty_cells_and_grow_by_the_expansion() {
        // 4 x 2 alpha with only the right column opaque; spacing 2 at Fewer Points on a tiny proxy.
        let a = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
        let g = build(&a, 4, 2, (10.0, 20.0), 1.0, "normal", 0.0).unwrap();
        assert_eq!((g.cols, g.rows, g.step, g.cells.clone()), (1, 1, 16.0, vec![0, 1]));
        let g = build(&a, 4, 2, (10.0, 20.0), 1.0, "normal", 3.0).unwrap();
        assert_eq!((g.x, g.y, g.w, g.h), (7.0, 17.0, 10.0, 8.0));
        assert!(build(&[0.0; 8], 4, 2, (0.0, 0.0), 1.0, "normal", 2.0).is_none());
    }

    #[test]
    fn rigs_out_of_range_are_refused() {
        let ok = serde_json::to_value(rig(vec![pin(0.0, 0.0, 1.0, 1.0)], "rigid")).unwrap();
        assert!(check(&ok).is_ok());
        for (k, v) in [("mode", serde_json::json!("soft")), ("expansion", serde_json::json!(60.0)), ("extra", serde_json::json!(1))] {
            let mut bad = ok.clone();
            bad[k] = v;
            assert!(check(&bad).unwrap_err().starts_with("Puppet Warp"), "{k}");
        }
        let mut bad = ok.clone();
        bad["mesh"]["cells"] = serde_json::json!([0, 3]);
        assert!(check(&bad).is_err());
        bad["mesh"]["cells"] = serde_json::json!([u64::MAX, 2]);
        assert!(check(&bad).is_err(), "cell runs that wrap the sum");
        (bad["mesh"]["cols"], bad["mesh"]["rows"], bad["mesh"]["cells"]) = (serde_json::json!(1u64 << 32), serde_json::json!(1u64 << 32), serde_json::json!([]));
        assert!(check(&bad).is_err(), "cols x rows that wraps");
    }
}

#[cfg(test)]
mod psd_tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    fn bytes(source: &[[f64; 2]], target: &[[f64; 2]], tris: &[([u32; 3], i32)]) -> Vec<u8> {
        let mut b = PSD_MAGIC.to_vec();
        for v in [1u32, source.len() as u32, tris.len() as u32] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        for p in source.iter().chain(target).flatten() {
            b.extend_from_slice(&p.to_le_bytes());
        }
        for (t, _) in tris {
            t.iter().for_each(|i| b.extend_from_slice(&i.to_le_bytes()));
        }
        for (_, d) in tris {
            b.extend_from_slice(&d.to_le_bytes());
        }
        b
    }

    const SQUARE: [[f64; 2]; 4] = [[0.0, 0.0], [8.0, 0.0], [8.0, 8.0], [0.0, 8.0]];
    const TRIS: [([u32; 3], i32); 2] = [([0, 1, 2], 0), ([0, 2, 3], 0)];

    fn plane() -> Plane {
        let data = (0..8 * 8).flat_map(|i| [i as f32 / 64.0, 0.5, 0.25, 1.0]).collect();
        Plane { x: 0, y: 0, w: 8, h: 8, data }
    }

    fn run(blob: Vec<u8>) -> Plane {
        let blobs = HashMap::from([(5u64, Arc::new(blob))]);
        let mut p = plane();
        let f = Filter { kind: "psd_filter".into(), params: json!({ "name": "", "puppet": 5, "reach": 0 }).as_object().unwrap().clone() };
        let ctx = Ctx { blobs: &blobs, cov: None, bounds: [0, 0, 8, 8], scale: 1.0, mask: None };
        apply_psd(&mut p, &f, &ctx).unwrap();
        p
    }

    #[test]
    fn undeformed_triangles_leave_the_plane_untouched() {
        assert_eq!(run(bytes(&SQUARE, &SQUARE, &TRIS)).data, plane().data);
    }

    #[test]
    fn deformed_triangles_move_the_pixels_and_leave_the_rest_transparent() {
        let moved: Vec<[f64; 2]> = SQUARE.iter().map(|p| [p[0] + 2.0, p[1]]).collect();
        let p = run(bytes(&SQUARE, &moved, &TRIS));
        let src = plane();
        let at = |p: &Plane, x: usize, y: usize| p.data[(y * 8 + x) * 4..][..4].to_vec();
        assert_eq!(at(&p, 0, 3)[3], 0.0, "uncovered");
        for x in 2..7 {
            let (a, b) = (at(&p, x, 4), at(&src, x - 2, 4));
            assert!(a.iter().zip(&b).all(|(u, v)| (u - v).abs() < 0.02), "x={x} {a:?} {b:?}");
        }
    }

    #[test]
    fn damaged_or_oversized_meshes_are_refused() {
        let ok = bytes(&SQUARE, &SQUARE, &TRIS);
        assert!(PsdPuppet::from_bytes(&ok).is_ok());
        assert!(PsdPuppet::from_bytes(&ok[..ok.len() - 1]).is_err(), "truncated");
        assert!(PsdPuppet::from_bytes(&bytes(&SQUARE, &SQUARE, &[([0, 1, 4], 0)])).is_err(), "index out of range");
        let mut nan = ok.clone();
        nan[PSD_HEADER..PSD_HEADER + 8].copy_from_slice(&f64::NAN.to_le_bytes());
        assert!(PsdPuppet::from_bytes(&nan).is_err(), "non-finite");
        let mut big = ok.clone();
        big[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(PsdPuppet::from_bytes(&big).is_err(), "vertex count");
        assert!(PsdPuppet::from_bytes(b"PSPW").is_err());
    }
}
