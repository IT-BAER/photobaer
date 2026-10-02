//! Liquify (docs/M5.md section 6): a displacement mesh plus a frozen mask, edited by brush
//! strokes. Output pixel (x, y) samples the source at (x, y) + the mesh offset there.

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::filters::{Ctx, Filter, Plane};

const MAGIC: &[u8; 4] = b"PBLQ";
const VERSION: u32 = 1;
const HEADER: usize = 28;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Tool {
    ForwardWarp,
    Reconstruct,
    Smooth,
    TwirlClockwise,
    TwirlCounterClockwise,
    Pucker,
    Bloat,
    PushLeft,
    Freeze,
    Thaw,
}

impl Tool {
    // Tools whose strength is pressure x rate and that act while the brush holds still.
    fn rated(self) -> bool {
        matches!(self, Tool::Reconstruct | Tool::Smooth | Tool::TwirlClockwise | Tool::TwirlCounterClockwise | Tool::Pucker | Tool::Bloat)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Revert,
    Rigid,
    Stiff,
    Smooth,
    Loose,
}

impl Mode {
    // The share of the offset a full-strength Reconstruct dab keeps.
    fn keep(self) -> f32 {
        match self {
            Mode::Revert => 0.0,
            Mode::Rigid => 0.25,
            Mode::Stiff => 0.5,
            Mode::Smooth => 0.7,
            Mode::Loose => 0.85,
        }
    }
}

/// Brush Tool Options: size in document px, the rest 0..100.
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Brush {
    pub tool: Tool,
    pub size: f32,
    pub density: f32,
    pub pressure: f32,
    pub rate: f32,
    pub mode: Mode,
}

impl Brush {
    fn amount(&self) -> f32 {
        let p = self.pressure.clamp(0.0, 100.0) / 100.0;
        if self.tool.rated() { p * self.rate.clamp(0.0, 100.0) / 100.0 } else { p }
    }

    fn radius(&self) -> f32 {
        (self.size / 2.0).max(1.0)
    }
}

// (1 - d/r)^(2 - density x 1.75): density 0 is a soft quadratic edge, 100 nearly flat.
fn falloff(d: f32, r: f32, density: f32) -> f32 {
    if r <= 0.0 || d >= r {
        return 0.0;
    }
    (1.0 - d / r).powf(2.0 - density.clamp(0.0, 100.0) / 100.0 * 1.75)
}

fn dims(width: u32, height: u32, spacing: u32) -> (usize, usize) {
    let n = |v: u32| ((v as f64 / spacing as f64).ceil() as usize + 1).max(2);
    (n(width), n(height))
}

/// Nodes every `spacing` document px from (0, 0); `disp` holds (dx, dy) per node, `frozen` 0..1.
#[derive(Clone, Debug, PartialEq)]
pub struct Mesh {
    pub width: u32,
    pub height: u32,
    pub spacing: u32,
    pub cols: usize,
    pub rows: usize,
    pub disp: Vec<f32>,
    pub frozen: Vec<f32>,
}

impl Mesh {
    pub fn new(width: u32, height: u32, spacing: u32) -> Mesh {
        let spacing = spacing.max(1);
        let (cols, rows) = dims(width, height, spacing);
        Mesh { width, height, spacing, cols, rows, disp: vec![0.0; cols * rows * 2], frozen: vec![0.0; cols * rows] }
    }

    /// `PBLQ`, then u32 LE version, width, height, spacing, cols, rows, then f32 LE (dx, dy) per
    /// node and frozen per node, row by row.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(HEADER + (self.disp.len() + self.frozen.len()) * 4);
        out.extend_from_slice(MAGIC);
        for v in [VERSION, self.width, self.height, self.spacing, self.cols as u32, self.rows as u32] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        for v in self.disp.iter().chain(&self.frozen) {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }

    pub fn from_bytes(b: &[u8]) -> Result<Mesh, String> {
        const BAD: &str = "the Liquify mesh is damaged";
        if b.len() < HEADER || &b[..4] != MAGIC {
            return Err(BAD.into());
        }
        let u = |i: usize| u32::from_le_bytes(b[4 + i * 4..8 + i * 4].try_into().expect("4 bytes"));
        if u(0) != VERSION {
            return Err(format!("the Liquify mesh has unknown version {}", u(0)));
        }
        let (width, height, spacing) = (u(1), u(2), u(3));
        if spacing == 0 || dims(width, height, spacing) != (u(4) as usize, u(5) as usize) {
            return Err(BAD.into());
        }
        // Checked: on wasm32 a crafted header could wrap the node count to a small length.
        let n = (u(4) as usize).checked_mul(u(5) as usize).ok_or(BAD)?;
        if n.checked_mul(12).and_then(|m| m.checked_add(HEADER)) != Some(b.len()) {
            return Err(BAD.into());
        }
        let vals: Vec<f32> = b[HEADER..].chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().expect("4 bytes"))).collect();
        if vals.iter().any(|v| !v.is_finite()) {
            return Err(BAD.into());
        }
        let (disp, frozen) = vals.split_at(n * 2);
        Ok(Mesh { width, height, spacing, cols: u(4) as usize, rows: u(5) as usize, disp: disp.to_vec(), frozen: frozen.to_vec() })
    }

    pub fn identity(&self) -> bool {
        self.disp.iter().all(|&v| v == 0.0)
    }

    /// The longest node offset in document px.
    pub fn max_shift(&self) -> f32 {
        self.disp.chunks_exact(2).map(|d| d[0].hypot(d[1])).fold(0.0, f32::max)
    }

    // Bilinear over node values `v` (stride `n`, channel `c`) at document (x, y), clamped to the grid.
    fn lerp(&self, v: &[f32], n: usize, c: usize, x: f32, y: f32) -> f32 {
        let s = self.spacing as f32;
        let (gx, gy) = (x / s, y / s);
        let c0 = (gx.floor().max(0.0) as usize).min(self.cols - 1);
        let r0 = (gy.floor().max(0.0) as usize).min(self.rows - 1);
        let (c1, r1) = ((c0 + 1).min(self.cols - 1), (r0 + 1).min(self.rows - 1));
        let (fx, fy) = ((gx - c0 as f32).clamp(0.0, 1.0), (gy - r0 as f32).clamp(0.0, 1.0));
        let at = |cc: usize, rr: usize| v[(rr * self.cols + cc) * n + c];
        let top = at(c0, r0) + (at(c1, r0) - at(c0, r0)) * fx;
        let bot = at(c0, r1) + (at(c1, r1) - at(c0, r1)) * fx;
        top + (bot - top) * fy
    }

    pub fn offset(&self, x: f32, y: f32) -> [f32; 2] {
        [self.lerp(&self.disp, 2, 0, x, y), self.lerp(&self.disp, 2, 1, x, y)]
    }

    pub fn frozen_at(&self, x: f32, y: f32) -> f32 {
        self.lerp(&self.frozen, 1, 0, x, y)
    }

    /// One brush dab at (cx, cy) moving by (mx, my) since the previous dab.
    pub fn dab(&mut self, b: &Brush, cx: f32, cy: f32, mx: f32, my: f32) {
        let (r, s, amount, keep) = (b.radius(), self.spacing as f32, b.amount(), b.mode.keep());
        let span = |lo: f32, hi: f32, n: usize| ((lo / s).floor().max(0.0) as usize, ((hi / s).ceil().max(0.0) as usize).min(n - 1));
        let (u0, u1) = span(cx - r, cx + r, self.cols);
        let (v0, v1) = span(cy - r, cy + r, self.rows);
        for v in v0..=v1 {
            for u in u0..=u1 {
                let k = v * self.cols + u;
                let (ox, oy) = (u as f32 * s - cx, v as f32 * s - cy);
                let d = ox.hypot(oy);
                let mut w = (falloff(d, r, b.density) * amount).min(1.0);
                match b.tool {
                    Tool::Freeze => {
                        self.frozen[k] = (self.frozen[k] + w).clamp(0.0, 1.0);
                        continue;
                    }
                    Tool::Thaw => {
                        self.frozen[k] = (self.frozen[k] - w).clamp(0.0, 1.0);
                        continue;
                    }
                    _ => {}
                }
                w *= 1.0 - self.frozen[k];
                if w <= 0.0 {
                    continue;
                }
                let m = k * 2;
                match b.tool {
                    Tool::ForwardWarp => {
                        self.disp[m] -= mx * w;
                        self.disp[m + 1] -= my * w;
                    }
                    Tool::Reconstruct => {
                        let f = 1.0 - w * (1.0 - keep);
                        self.disp[m] *= f;
                        self.disp[m + 1] *= f;
                    }
                    Tool::Smooth => {
                        let (mut sx, mut sy, mut n) = (0.0, 0.0, 0.0);
                        for (du, dv) in [(-1i64, 0i64), (1, 0), (0, -1), (0, 1)] {
                            let (nu, nv) = (u as i64 + du, v as i64 + dv);
                            if nu < 0 || nv < 0 || nu >= self.cols as i64 || nv >= self.rows as i64 {
                                continue;
                            }
                            let q = (nv as usize * self.cols + nu as usize) * 2;
                            sx += self.disp[q];
                            sy += self.disp[q + 1];
                            n += 1.0;
                        }
                        self.disp[m] += (sx / n - self.disp[m]) * w;
                        self.disp[m + 1] += (sy / n - self.disp[m + 1]) * w;
                    }
                    Tool::TwirlClockwise | Tool::TwirlCounterClockwise if d > 0.0 => {
                        let a = if b.tool == Tool::TwirlClockwise { w * 0.6 } else { -w * 0.6 };
                        let (sin, cos) = a.sin_cos();
                        self.disp[m] += ox * cos - oy * sin - ox;
                        self.disp[m + 1] += ox * sin + oy * cos - oy;
                    }
                    Tool::Pucker if d > 0.0 => {
                        self.disp[m] += ox * w * 0.5;
                        self.disp[m + 1] += oy * w * 0.5;
                    }
                    Tool::Bloat if d > 0.0 => {
                        self.disp[m] -= ox * w * 0.5;
                        self.disp[m + 1] -= oy * w * 0.5;
                    }
                    Tool::PushLeft => {
                        // The perpendicular to the left of the motion, as long as the motion.
                        self.disp[m] -= -my * w;
                        self.disp[m + 1] -= mx * w;
                    }
                    _ => {}
                }
            }
        }
    }

    /// Pin Edges: border nodes keep no offset.
    pub fn pin_edges(&mut self) {
        let (c, r) = (self.cols, self.rows);
        for k in (0..c).chain((r - 1) * c..r * c).chain((0..r).flat_map(|v| [v * c, v * c + c - 1])) {
            self.disp[k * 2] = 0.0;
            self.disp[k * 2 + 1] = 0.0;
        }
    }

    /// The same field on a grid of `spacing` px.
    pub fn resampled(&self, spacing: u32) -> Mesh {
        let mut m = Mesh::new(self.width, self.height, spacing);
        for v in 0..m.rows {
            for u in 0..m.cols {
                let (x, y) = ((u as u32 * m.spacing) as f32, (v as u32 * m.spacing) as f32);
                let k = v * m.cols + u;
                m.disp[k * 2..k * 2 + 2].copy_from_slice(&self.offset(x, y));
                m.frozen[k] = self.frozen_at(x, y);
            }
        }
        m
    }

    /// The same warp in a new document frame of `width` x `height`: `back` maps a new document
    /// point to the old one, `fwd` an old point to the new one. Nodes off the old mesh keep no offset.
    pub fn remapped(&self, width: u32, height: u32, back: impl Fn(f32, f32) -> (f32, f32), fwd: impl Fn(f32, f32) -> (f32, f32)) -> Mesh {
        let mut m = Mesh::new(width, height, self.spacing);
        let (w0, h0) = (self.width as f32, self.height as f32);
        for v in 0..m.rows {
            for u in 0..m.cols {
                let (x, y) = ((u as u32 * m.spacing) as f32, (v as u32 * m.spacing) as f32);
                let (qx, qy) = back(x, y);
                if !((0.0..=w0).contains(&qx) && (0.0..=h0).contains(&qy)) {
                    continue;
                }
                let k = v * m.cols + u;
                m.frozen[k] = self.frozen_at(qx, qy);
                let d = self.offset(qx, qy);
                if d != [0.0, 0.0] {
                    let (tx, ty) = fwd(qx + d[0], qy + d[1]);
                    (m.disp[k * 2], m.disp[k * 2 + 1]) = (tx - x, ty - y);
                }
            }
        }
        m
    }

    /// Mask Options with `b` (selection or transparency, 0..1 per node): replace, add, subtract,
    /// intersect, invertSelection; or the presets none, all, invert.
    pub fn mask(&mut self, op: &str, b: &[f32]) -> Result<(), String> {
        let f = &mut self.frozen;
        match op {
            "none" => f.fill(0.0),
            "all" => f.fill(1.0),
            "invert" => f.iter_mut().for_each(|v| *v = 1.0 - *v),
            _ => {
                if b.len() != f.len() {
                    return Err("the mask source does not match the mesh".into());
                }
                let g: fn(f32, f32) -> f32 = match op {
                    "replace" => |_, b| b,
                    "add" => f32::max,
                    "subtract" => |f, b| f * (1.0 - b),
                    "intersect" => |f, b| f * b,
                    "invertSelection" => |f, b| f * (1.0 - b) + (1.0 - f) * b,
                    _ => return Err(format!("unknown mask operation \"{op}\"")),
                };
                f.iter_mut().zip(b).for_each(|(f, &b)| *f = g(*f, b.clamp(0.0, 1.0)));
            }
        }
        Ok(())
    }

    /// The Reconstruct button: every unfrozen offset shrinks by `amount` (0..100).
    pub fn reconstruct(&mut self, amount: f32) {
        let a = amount.clamp(0.0, 100.0) / 100.0;
        for (d, f) in self.disp.chunks_exact_mut(2).zip(&self.frozen) {
            let k = 1.0 - a * (1.0 - f);
            d[0] *= k;
            d[1] *= k;
        }
    }
}

// Bilinear premultiplied RGBA of a `w` x `h` buffer at (u, v), coordinates clamped to it.
fn sample(data: &[f32], w: usize, h: usize, u: f32, v: f32) -> [f32; 4] {
    let (u, v) = (u.clamp(0.0, (w - 1) as f32), v.clamp(0.0, (h - 1) as f32));
    let (x0, y0) = (u as usize, v as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = (u - x0 as f32, v - y0 as f32);
    let px = |x: usize, y: usize| &data[(y * w + x) * 4..][..4];
    std::array::from_fn(|c| {
        let top = px(x0, y0)[c] + (px(x1, y0)[c] - px(x0, y0)[c]) * fx;
        let bot = px(x0, y1)[c] + (px(x1, y1)[c] - px(x0, y1)[c]) * fx;
        top + (bot - top) * fy
    })
}

// `out` (straight RGBA over `w` x `h` px at plane origin `o`, `s` px per document px) from the
// premultiplied `src` of the same rect through `mesh`.
fn warp(mesh: &Mesh, src: &[f32], w: usize, h: usize, o: (i32, i32), s: f32, out: &mut [f32]) {
    for j in 0..h {
        for i in 0..w {
            let k = (j * w + i) * 4;
            let (x, y) = (((o.0 + i as i32) as f32 + 0.5) / s - 0.5, ((o.1 + j as i32) as f32 + 0.5) / s - 0.5);
            let d = mesh.offset(x, y);
            let c = if d == [0.0, 0.0] {
                src[k..k + 4].try_into().expect("4 channels")
            } else {
                sample(src, w, h, (x + d[0] + 0.5) * s - 0.5 - o.0 as f32, (y + d[1] + 0.5) * s - 0.5 - o.1 as f32)
            };
            let a = c[3].clamp(0.0, 1.0);
            for ch in 0..3 {
                out[k + ch] = if a > 0.0 { c[ch] / a } else { 0.0 };
            }
            out[k + 3] = a;
        }
    }
}

/// The registry entry `liquify`: params `mesh` (blob id) and `reach` (the longest offset).
pub fn apply(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let id = f.blob().ok_or("Liquify needs a mesh")?;
    let mesh = Mesh::from_bytes(ctx.blobs.get(&id).ok_or_else(|| format!("unknown blob {id}"))?)?;
    if mesh.identity() || p.w == 0 || p.h == 0 {
        return Ok(());
    }
    let mut src = p.clone();
    src.premultiply();
    warp(&mesh, &src.data, p.w, p.h, (p.x, p.y), ctx.scale as f32, &mut p.data);
    Ok(())
}

/// A Liquify dialog session: the mesh being edited and a premultiplied proxy of the layer over
/// the document rect at `scale`.
#[wasm_bindgen]
pub struct Liquify {
    mesh: Mesh,
    src: Vec<f32>,
    pw: usize,
    ph: usize,
    scale: f32,
    pin: bool,
    brush: Option<Brush>,
    last: (f32, f32),
}

impl Liquify {
    pub(crate) fn new(mesh: Mesh, src: Vec<f32>, pw: usize, ph: usize, scale: f32) -> Liquify {
        Liquify { mesh, src, pw, ph, scale, pin: false, brush: None, last: (0.0, 0.0) }
    }

    pub(crate) fn mesh(&self) -> &Mesh {
        &self.mesh
    }

    pub(crate) fn mesh_mut(&mut self) -> &mut Mesh {
        &mut self.mesh
    }

    fn pinned(&mut self) {
        if self.pin {
            self.mesh.pin_edges();
        }
    }
}

#[wasm_bindgen]
impl Liquify {
    pub fn proxy_width(&self) -> u32 {
        self.pw as u32
    }
    pub fn proxy_height(&self) -> u32 {
        self.ph as u32
    }
    /// Proxy px per document px.
    pub fn scale(&self) -> f32 {
        self.scale
    }
    pub fn cols(&self) -> u32 {
        self.mesh.cols as u32
    }
    pub fn rows(&self) -> u32 {
        self.mesh.rows as u32
    }
    pub fn spacing(&self) -> u32 {
        self.mesh.spacing
    }

    pub fn set_pin_edges(&mut self, on: bool) {
        self.pin = on;
        self.pinned();
    }

    /// Mesh Size: resamples the field onto a grid of `spacing` px (4, 8 or 16).
    pub fn set_spacing(&mut self, spacing: u32) {
        if spacing != self.mesh.spacing {
            self.mesh = self.mesh.resampled(spacing);
        }
    }

    /// Starts a stroke with brush JSON `{ tool, size, density, pressure, rate, mode }` at document
    /// (x, y): one dab without motion.
    pub fn stroke_begin(&mut self, brush: &str, x: f32, y: f32) -> Result<(), JsError> {
        let b: Brush = serde_json::from_str(brush).map_err(|e| JsError::new(&format!("invalid brush: {e}")))?;
        if !(1.0..=15000.0).contains(&b.size) {
            return Err(JsError::new("the brush size must be in 1..=15000"));
        }
        self.brush = Some(b);
        self.last = (x, y);
        self.mesh.dab(&b, x, y, 0.0, 0.0);
        self.pinned();
        Ok(())
    }

    /// Continues the stroke to (x, y) in dabs every quarter radius, each moving by its step.
    pub fn stroke_to(&mut self, x: f32, y: f32) {
        let Some(b) = self.brush else { return };
        let (lx, ly) = self.last;
        let n = ((x - lx).hypot(y - ly) / (b.radius() / 4.0).max(0.5)).ceil().max(1.0) as usize;
        let (sx, sy) = ((x - lx) / n as f32, (y - ly) / n as f32);
        for k in 1..=n {
            self.mesh.dab(&b, lx + sx * k as f32, ly + sy * k as f32, sx, sy);
        }
        self.last = (x, y);
        self.pinned();
    }

    /// The brush held still: one more dab for the rated tools (twirl, pucker, bloat, ...).
    pub fn stroke_hold(&mut self) {
        if let Some(b) = self.brush.filter(|b| b.tool.rated()) {
            self.mesh.dab(&b, self.last.0, self.last.1, 0.0, 0.0);
            self.pinned();
        }
    }

    pub fn stroke_end(&mut self) {
        self.brush = None;
    }

    /// The mask presets: "none", "all", "invert".
    pub fn mask_preset(&mut self, op: &str) -> Result<(), JsError> {
        self.mesh.mask(op, &[]).map_err(|e| JsError::new(&e))
    }

    pub fn reconstruct(&mut self, amount: f32) {
        self.mesh.reconstruct(amount);
    }

    /// Restore All: no offsets and no frozen area.
    pub fn restore_all(&mut self) {
        self.mesh = Mesh::new(self.mesh.width, self.mesh.height, self.mesh.spacing);
    }

    pub fn identity(&self) -> bool {
        self.mesh.identity()
    }

    pub fn max_shift(&self) -> f32 {
        self.mesh.max_shift()
    }

    /// The warped proxy as straight RGBA8.
    pub fn render(&self) -> Vec<u8> {
        let mut out = vec![0f32; self.pw * self.ph * 4];
        warp(&self.mesh, &self.src, self.pw, self.ph, (0, 0), self.scale, &mut out);
        out.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8).collect()
    }

    /// (dx, dy) per node, row by row, in document px.
    pub fn displacement(&self) -> Vec<f32> {
        self.mesh.disp.clone()
    }

    pub fn frozen(&self) -> Vec<f32> {
        self.mesh.frozen.clone()
    }

    /// The mesh blob bytes (`Mesh::to_bytes`).
    pub fn bytes(&self) -> Vec<u8> {
        self.mesh.to_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    fn brush(tool: Tool) -> Brush {
        Brush { tool, size: 40.0, density: 50.0, pressure: 100.0, rate: 80.0, mode: Mode::Revert }
    }

    // A 64 x 64 plane of distinct opaque colors.
    fn plane() -> Plane {
        let data = (0..64 * 64).flat_map(|i| [(i % 64) as f32 / 63.0, (i / 64) as f32 / 63.0, 0.5, 1.0]).collect();
        Plane { x: 0, y: 0, w: 64, h: 64, data }
    }

    fn render(m: &Mesh) -> Plane {
        let mut blobs = HashMap::new();
        blobs.insert(7u64, Arc::new(m.to_bytes()));
        let f = Filter::parse(r#"{"kind":"liquify","params":{"mesh":7}}"#).unwrap();
        let mut p = plane();
        apply(&mut p, &f, &Ctx { blobs: &blobs, cov: None, bounds: [0, 0, 64, 64], scale: 1.0, mask: None }).unwrap();
        p
    }

    fn warped(m: &mut Mesh) {
        let b = brush(Tool::ForwardWarp);
        for k in 0..10 {
            m.dab(&b, 20.0 + k as f32 * 2.0, 32.0, 2.0, 0.0);
        }
    }

    #[test]
    fn no_strokes_render_the_identity() {
        assert_eq!(render(&Mesh::new(64, 64, 8)), plane());
    }

    #[test]
    fn forward_warp_moves_pixels_and_restore_all_returns_the_identity() {
        let mut m = Mesh::new(64, 64, 8);
        warped(&mut m);
        assert!(m.max_shift() > 1.0);
        assert_ne!(render(&m), plane());
        // Content moves with the stroke: the output right of the start shows pixels from its left.
        assert!(render(&m).data[(32 * 64 + 32) * 4] < plane().data[(32 * 64 + 32) * 4]);
        let mut s = Liquify::new(m, vec![], 0, 0, 1.0);
        s.restore_all();
        assert_eq!(render(s.mesh()), plane());
    }

    #[test]
    fn a_frozen_area_is_unchanged_by_a_warp_over_it() {
        let mut m = Mesh::new(64, 64, 8);
        let mut b = brush(Tool::Freeze);
        b.size = 60.0;
        for _ in 0..8 {
            m.dab(&b, 32.0, 32.0, 0.0, 0.0);
        }
        assert_eq!(m.frozen_at(32.0, 32.0), 1.0);
        let mut w = brush(Tool::ForwardWarp);
        w.size = 120.0;
        for k in 0..20 {
            m.dab(&w, 12.0 + k as f32 * 2.0, 32.0, 2.0, 0.0);
        }
        assert!(m.max_shift() > 1.0, "the warp acts outside the frozen area");
        let (out, src) = (render(&m), plane());
        for y in 24..=40 {
            for x in 24..=40 {
                let k = (y * 64 + x) * 4;
                assert_eq!(out.data[k..k + 4], src.data[k..k + 4], "{x},{y}");
            }
        }
    }

    #[test]
    fn reconstruct_revert_100_after_strokes_returns_the_identity() {
        let mut m = Mesh::new(64, 64, 8);
        warped(&mut m);
        for t in [Tool::TwirlClockwise, Tool::Pucker, Tool::Bloat, Tool::PushLeft, Tool::Smooth] {
            m.dab(&brush(t), 30.0, 30.0, 1.0, 1.0);
        }
        m.reconstruct(100.0);
        assert_eq!(render(&m), plane());
        let mut m2 = Mesh::new(64, 64, 8);
        warped(&mut m2);
        let mut r = brush(Tool::Reconstruct);
        (r.size, r.pressure, r.rate) = (400.0, 100.0, 100.0);
        r.density = 100.0;
        let before = m2.max_shift();
        m2.dab(&r, 32.0, 32.0, 0.0, 0.0);
        assert!(m2.max_shift() < before, "the brush reconstructs toward the original");
    }

    #[test]
    fn mesh_bytes_round_trip_exactly_and_damage_is_refused() {
        let mut m = Mesh::new(50, 30, 4);
        warped(&mut m);
        m.mask("all", &[]).unwrap();
        m.frozen[3] = 0.25;
        let b = m.to_bytes();
        assert_eq!(Mesh::from_bytes(&b).unwrap(), m);
        assert_eq!(Mesh::from_bytes(&b).unwrap().to_bytes(), b);
        assert!(Mesh::from_bytes(&b[..b.len() - 1]).is_err());
        let mut bad = b.clone();
        bad[0] = b'X';
        assert!(Mesh::from_bytes(&bad).is_err());
    }

    #[test]
    fn size_and_pressure_scale_the_effect() {
        let shift = |size: f32, pressure: f32| {
            let mut m = Mesh::new(64, 64, 4);
            m.dab(&Brush { size, pressure, ..brush(Tool::ForwardWarp) }, 32.0, 32.0, 4.0, 0.0);
            (m.max_shift(), m.disp.iter().filter(|&&v| v != 0.0).count())
        };
        assert!(shift(40.0, 50.0).0 < shift(40.0, 100.0).0, "pressure");
        assert!(shift(20.0, 100.0).1 < shift(40.0, 100.0).1, "size");
    }

    #[test]
    fn twirl_pucker_and_bloat_follow_the_reference_formulas() {
        let mut m = Mesh::new(64, 64, 8);
        let b = Brush { density: 100.0, rate: 100.0, ..brush(Tool::Pucker) };
        m.dab(&b, 32.0, 32.0, 0.0, 0.0);
        // Node (40, 32): offset (8, 0), weight (1 - 8/20)^0.25.
        let w = (1.0f32 - 8.0 / 20.0).powf(0.25);
        let k = (4 * m.cols + 5) * 2;
        assert!((m.disp[k] - 8.0 * w * 0.5).abs() < 1e-5 && m.disp[k + 1] == 0.0);
        let mut m = Mesh::new(64, 64, 8);
        m.dab(&Brush { tool: Tool::Bloat, ..b }, 32.0, 32.0, 0.0, 0.0);
        assert!((m.disp[k] + 8.0 * w * 0.5).abs() < 1e-5);
        let mut m = Mesh::new(64, 64, 8);
        m.dab(&Brush { tool: Tool::TwirlClockwise, ..b }, 32.0, 32.0, 0.0, 0.0);
        let a = w * 0.6;
        assert!((m.disp[k] - (8.0 * a.cos() - 8.0)).abs() < 1e-5 && (m.disp[k + 1] - 8.0 * a.sin()).abs() < 1e-5);
    }

    #[test]
    fn pin_edges_and_mask_ops() {
        let mut m = Mesh::new(64, 64, 8);
        let mut b = brush(Tool::ForwardWarp);
        b.size = 400.0;
        m.dab(&b, 32.0, 32.0, 3.0, 0.0);
        m.pin_edges();
        assert_eq!(&m.disp[..m.cols * 2], vec![0.0; m.cols * 2].as_slice());
        assert!(m.max_shift() > 0.0);
        let n = m.frozen.len();
        let half: Vec<f32> = (0..n).map(|i| if i % 2 == 0 { 1.0 } else { 0.0 }).collect();
        m.mask("replace", &half).unwrap();
        assert_eq!(m.frozen, half);
        m.mask("invertSelection", &vec![1.0; n]).unwrap();
        assert_eq!(m.frozen[0], 0.0);
        assert_eq!(m.frozen[1], 1.0);
        m.mask("subtract", &vec![1.0; n]).unwrap();
        assert!(m.frozen.iter().all(|&f| f == 0.0));
        assert!(m.mask("bogus", &vec![0.0; n]).is_err());
    }

    #[test]
    fn a_resampled_mesh_keeps_the_field() {
        let mut m = Mesh::new(64, 64, 4);
        warped(&mut m);
        let r = m.resampled(8);
        assert_eq!(r.cols, 9);
        assert_eq!(r.offset(32.0, 32.0), m.offset(32.0, 32.0));
    }
}
