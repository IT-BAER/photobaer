//! Layer style and blending options model (docs/M3.md section 5). Opacity, spread, choke, range,
//! jitter, noise, depth and scale are fractions (1 = 100 %), sizes and distances document px,
//! angles degrees. An effect renders only when both `present` and `enabled` are true.

use std::cell::OnceCell;
use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::adjust::Curve;
use crate::blend::{Blend, PaintMode, dissolve_hash, lum, paint_pixel_hdr};
use crate::content::{FillContent, GlobalLight, GradientDef, GradientFill, PatternEntry, PatternFill};
use crate::gradient;
use crate::selection::gaussian_kernel;

/// At most this many instances per multi-instance effect list.
pub const MAX_INSTANCES: usize = 10;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContourMode {
    Point,
    Pencil,
}

/// A contour curve: points (input, output) in 0..255, turned into a table by the curves spline.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contour {
    pub name: String,
    pub points: Vec<[f32; 2]>,
    pub mode: ContourMode,
    pub anti_alias: bool,
}

/// Drop and inner shadow; `knocks_out` (layer knocks out drop shadow) is read by drop shadows only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shadow {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub color: [u8; 3],
    pub use_global_light: bool,
    pub angle: f32,
    pub distance: f32,
    pub spread: f32,
    pub size: f32,
    pub contour: Contour,
    pub noise: f32,
    pub knocks_out: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum GlowFill {
    Color { color: [u8; 3] },
    Gradient { gradient: GradientDef },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlowTechnique {
    Softer,
    Precise,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GlowSource {
    Edge,
    Center,
}

/// Outer and inner glow; `source` is read by inner glows only.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Glow {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub fill: GlowFill,
    pub technique: GlowTechnique,
    pub spread: f32,
    pub size: f32,
    pub range: f32,
    pub jitter: f32,
    pub noise: f32,
    pub contour: Contour,
    pub source: GlowSource,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BevelStyle {
    Outer,
    Inner,
    Emboss,
    Pillow,
    StrokeEmboss,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BevelTechnique {
    Smooth,
    ChiselHard,
    ChiselSoft,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BevelDirection {
    Up,
    Down,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Bevel {
    pub present: bool,
    pub enabled: bool,
    pub style: BevelStyle,
    pub technique: BevelTechnique,
    pub depth: f32,
    pub direction: BevelDirection,
    pub size: f32,
    pub soften: f32,
    pub use_global_light: bool,
    pub angle: f32,
    pub altitude: f32,
    pub gloss_contour: Contour,
    pub highlight_blend: Blend,
    pub highlight_color: [u8; 3],
    pub highlight_opacity: f32,
    pub shadow_blend: Blend,
    pub shadow_color: [u8; 3],
    pub shadow_opacity: f32,
}

/// The bevel's Contour sub-effect.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BevelContour {
    pub present: bool,
    pub enabled: bool,
    pub contour: Contour,
    pub range: f32,
}

/// The bevel's Texture sub-effect; `depth` is -10..10 (-1000..1000 %).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BevelTexture {
    pub present: bool,
    pub enabled: bool,
    pub pattern_id: String,
    pub scale: f32,
    pub depth: f32,
    pub invert: bool,
    pub linked: bool,
    pub offset: [f32; 2],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Satin {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub color: [u8; 3],
    pub angle: f32,
    pub distance: f32,
    pub size: f32,
    pub contour: Contour,
    pub invert: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ColorOverlay {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub color: [u8; 3],
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GradientOverlay {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub gradient: GradientFill,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PatternOverlay {
    pub present: bool,
    pub enabled: bool,
    pub blend: Blend,
    pub opacity: f32,
    pub pattern: PatternFill,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StrokePosition {
    Outside,
    Inside,
    Center,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stroke {
    pub present: bool,
    pub enabled: bool,
    pub size: f32,
    pub position: StrokePosition,
    pub blend: Blend,
    pub opacity: f32,
    pub overprint: bool,
    pub fill: FillContent,
}

/// A layer style. Single effects are none when the layer never had them.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Style {
    pub enabled: bool,
    pub scale: f32,
    pub drop_shadows: Vec<Shadow>,
    pub inner_shadows: Vec<Shadow>,
    pub color_overlays: Vec<ColorOverlay>,
    pub gradient_overlays: Vec<GradientOverlay>,
    pub pattern_overlays: Vec<PatternOverlay>,
    pub strokes: Vec<Stroke>,
    pub outer_glow: Option<Glow>,
    pub inner_glow: Option<Glow>,
    pub bevel: Option<Bevel>,
    pub contour: Option<BevelContour>,
    pub texture: Option<BevelTexture>,
    pub satin: Option<Satin>,
}

impl Style {
    /// Every document pattern id the style reads.
    pub fn pattern_ids(&self) -> impl Iterator<Item = &str> {
        let overlays = self.pattern_overlays.iter().map(|p| p.pattern.pattern_id.as_str());
        let strokes = self.strokes.iter().filter_map(|s| s.fill.pattern_id());
        let texture = self.texture.iter().map(|t| t.pattern_id.as_str());
        overlays.chain(strokes).chain(texture)
    }

    /// The master switch is on and at least one effect is present and enabled (bevel contour and
    /// texture are parts of the bevel, not effects of their own).
    pub fn any_effect(&self) -> bool {
        let on = |present: bool, enabled: bool| present && enabled;
        self.enabled
            && (self.drop_shadows.iter().chain(&self.inner_shadows).any(|e| on(e.present, e.enabled))
                || self.color_overlays.iter().any(|e| on(e.present, e.enabled))
                || self.gradient_overlays.iter().any(|e| on(e.present, e.enabled))
                || self.pattern_overlays.iter().any(|e| on(e.present, e.enabled))
                || self.strokes.iter().any(|e| on(e.present, e.enabled))
                || self.outer_glow.iter().chain(&self.inner_glow).any(|e| on(e.present, e.enabled))
                || self.bevel.as_ref().is_some_and(|e| on(e.present, e.enabled))
                || self.satin.as_ref().is_some_and(|e| on(e.present, e.enabled)))
    }

    /// The list length limit of section 5.
    pub fn check(&self) -> Result<(), String> {
        let lens = [
            self.drop_shadows.len(),
            self.inner_shadows.len(),
            self.color_overlays.len(),
            self.gradient_overlays.len(),
            self.pattern_overlays.len(),
            self.strokes.len(),
        ];
        if lens.iter().any(|&n| n > MAX_INSTANCES) {
            return Err(format!("a layer style holds at most {MAX_INSTANCES} instances per effect"));
        }
        Ok(())
    }
}

/// Blend-if split ranges [black outer, black inner, white inner, white outer] in 0..255.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlendRange {
    pub source: [u8; 4],
    pub destination: [u8; 4],
}

impl Default for BlendRange {
    fn default() -> BlendRange {
        BlendRange { source: [0, 0, 255, 255], destination: [0, 0, 255, 255] }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlendIf {
    pub gray: BlendRange,
    pub red: BlendRange,
    pub green: BlendRange,
    pub blue: BlendRange,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Knockout {
    #[default]
    None,
    Shallow,
    Deep,
}

/// Advanced blending options of every node; fill opacity is `Node::fill`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Blending {
    pub blend_if: BlendIf,
    pub channels: [bool; 3],
    pub knockout: Knockout,
    pub blend_interior: bool,
    pub blend_clipped: bool,
    pub transparency_shapes: bool,
    pub layer_mask_hides_effects: bool,
    pub vector_mask_hides_effects: bool,
}

impl Default for Blending {
    fn default() -> Blending {
        Blending {
            blend_if: BlendIf::default(),
            channels: [true; 3],
            knockout: Knockout::None,
            blend_interior: false,
            blend_clipped: true,
            transparency_shapes: true,
            layer_mask_hides_effects: false,
            vector_mask_hides_effects: false,
        }
    }
}

// ---------- effect rendering (docs/M3.md section 5) ----------

/// A `w` x `h` row-major f32 plane.
#[derive(Clone, Debug, PartialEq)]
pub struct Plane {
    pub w: usize,
    pub h: usize,
    pub v: Vec<f32>,
}

impl Plane {
    pub fn new(w: usize, h: usize) -> Plane {
        Plane { w, h, v: vec![0.0; w * h] }
    }

    fn map(&self, f: impl Fn(usize, f32) -> f32) -> Plane {
        Plane { w: self.w, h: self.h, v: self.v.iter().enumerate().map(|(i, &v)| f(i, v)).collect() }
    }

    // Edges replicate.
    fn at(&self, x: isize, y: isize) -> f32 {
        let (x, y) = (x.clamp(0, self.w as isize - 1) as usize, y.clamp(0, self.h as isize - 1) as usize);
        self.v[y * self.w + x]
    }

    fn mul(&mut self, m: &Plane) {
        self.v.iter_mut().zip(&m.v).for_each(|(v, m)| *v *= m);
    }

    fn clamp01(&mut self) {
        self.v.iter_mut().for_each(|v| *v = v.clamp(0.0, 1.0));
    }
}

/// A shape plane (layer alpha after the masks, alpha >= 0.5 is inside) with its distance fields
/// computed on first use.
pub struct Shape {
    pub plane: Plane,
    inside: OnceCell<Plane>,
    outside: OnceCell<Plane>,
}

impl Shape {
    pub fn new(plane: Plane) -> Shape {
        Shape { plane, inside: OnceCell::new(), outside: OnceCell::new() }
    }

    /// Distance of inside pixels to the nearest outside pixel, minus 0.5, clamped >= 0.
    pub fn inside(&self) -> &Plane {
        self.inside.get_or_init(|| edt(&self.plane, |v| v < 0.5).map(|_, d| (d - 0.5).max(0.0)))
    }

    /// Distance of outside pixels to the shape, minus 0.5, clamped >= 0.
    pub fn outside(&self) -> &Plane {
        self.outside.get_or_init(|| edt(&self.plane, |v| v >= 0.5).map(|_, d| (d - 0.5).max(0.0)))
    }

    /// `-inside` inside, `+outside` outside.
    pub fn signed(&self) -> Plane {
        let (i, o) = (self.inside(), self.outside());
        self.plane.map(|k, a| if a >= 0.5 { -i.v[k] } else { o.v[k] })
    }

    // Per style: p = clamp(inside / s) inside, m = clamp(outside / s) outside.
    fn profile(&self, s: f32) -> Plane {
        let (i, o) = (self.inside(), self.outside());
        self.plane.map(|k, a| if a >= 0.5 { i.v[k] / s } else { o.v[k] / s }.clamp(0.0, 1.0))
    }
}

/// Exact Euclidean distance from each pixel center to the nearest `feature` pixel center (two 1-D
/// lower-envelope passes, columns then rows); about 1e10 when the plane has no feature.
fn edt(p: &Plane, feature: impl Fn(f32) -> bool) -> Plane {
    let (w, h) = (p.w, p.h);
    let mut g: Vec<f64> = p.v.iter().map(|&v| if feature(v) { 0.0 } else { 1e20 }).collect();
    let n = w.max(h);
    let (mut f, mut d, mut v, mut z) = (vec![0.0; n], vec![0.0; n], vec![0usize; n], vec![0.0; n + 1]);
    for x in 0..w {
        (0..h).for_each(|y| f[y] = g[y * w + x]);
        dt1(&f[..h], &mut d, &mut v, &mut z);
        (0..h).for_each(|y| g[y * w + x] = d[y]);
    }
    for y in 0..h {
        f[..w].copy_from_slice(&g[y * w..(y + 1) * w]);
        dt1(&f[..w], &mut d, &mut v, &mut z);
        g[y * w..(y + 1) * w].copy_from_slice(&d[..w]);
    }
    Plane { w, h, v: g.iter().map(|d| d.sqrt() as f32).collect() }
}

// Squared distance transform of one sampled function (Felzenszwalb and Huttenlocher).
fn dt1(f: &[f64], d: &mut [f64], v: &mut [usize], z: &mut [f64]) {
    let n = f.len();
    if n == 0 {
        return;
    }
    let mut k = 0;
    (v[0], z[0], z[1]) = (0, f64::NEG_INFINITY, f64::INFINITY);
    for q in 1..n {
        let qf = q as f64;
        let mut s;
        loop {
            let r = v[k] as f64;
            s = ((f[q] + qf * qf) - (f[v[k]] + r * r)) / (2.0 * qf - 2.0 * r);
            if s <= z[k] && k > 0 {
                k -= 1;
            } else {
                break;
            }
        }
        k += 1;
        (v[k], z[k], z[k + 1]) = (q, s, f64::INFINITY);
    }
    k = 0;
    for (q, dq) in d.iter_mut().enumerate().take(n) {
        while z[k + 1] < q as f64 {
            k += 1;
        }
        let r = q as f64 - v[k] as f64;
        *dq = r * r + f[v[k]];
    }
}

fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

pub(crate) fn convolve(p: &Plane, k: &[f32], horizontal: bool) -> Plane {
    let r = (k.len() / 2) as isize;
    let mut out = Plane::new(p.w, p.h);
    for y in 0..p.h as isize {
        for x in 0..p.w as isize {
            let tap = |o: isize| if horizontal { p.at(x + o, y) } else { p.at(x, y + o) };
            out.v[y as usize * p.w + x as usize] = k.iter().enumerate().map(|(i, w)| w * tap(i as isize - r)).sum();
        }
    }
    out
}

/// One horizontal and one vertical mean of window 2r + 1, r = round(radius), edges replicate.
pub fn box_blur(p: &Plane, radius: f32) -> Plane {
    let r = js_round(radius as f64);
    if r <= 0.0 {
        return p.clone();
    }
    let n = 2 * r as usize + 1;
    let k = vec![1.0 / n as f32; n];
    convolve(&convolve(p, &k, true), &k, false)
}

// Box radii of the three-pass Gaussian approximation for `sigma` ("boxes for Gauss", n = 3).
pub(crate) fn gauss_boxes(sigma: f64) -> [usize; 3] {
    let wi = (12.0 * sigma * sigma / 3.0 + 1.0).sqrt();
    let wl = wi.floor() as i64 - (wi.floor() as i64 + 1) % 2;
    let wf = wl as f64;
    let m = js_round((12.0 * sigma * sigma - 3.0 * wf * wf - 12.0 * wf - 9.0) / (-4.0 * wf - 4.0));
    std::array::from_fn(|i| ((if (i as f64) < m { wl } else { wl + 2 }).max(1) as usize - 1) / 2)
}

/// Gaussian of `size` px (sigma size/3): exact separable up to size 12, three box passes above;
/// edges replicate.
pub fn gaussian(p: &Plane, size: f32) -> Plane {
    if size <= 0.0 {
        return p.clone();
    }
    if size <= 12.0 {
        let k = gaussian_kernel(size as f64);
        return convolve(&convolve(p, &k, true), &k, false);
    }
    gauss_boxes(size as f64 / 3.0).iter().fold(p.clone(), |q, &r| box_blur(&q, r as f32))
}

/// Grows a plane by `r` px: `max(v, clamp(r + 1 - d))` on the raw outside distance d.
pub fn spread(p: &Plane, r: f32) -> Plane {
    if r <= 0.0 {
        return p.clone();
    }
    let d = edt(p, |v| v >= 0.5);
    p.map(|i, v| v.max((r + 1.0 - d.v[i]).clamp(0.0, 1.0)))
}

/// The offset for light angle `angle` degrees and distance `d`: `(-d cos A, d sin A)`.
pub fn offset(angle: f32, d: f32) -> (f64, f64) {
    let a = (angle as f64).to_radians();
    (-(d as f64) * a.cos(), d as f64 * a.sin())
}

/// The plane moved by (dx, dy) px, bilinear for fractions, edges replicate.
pub fn shift(p: &Plane, dx: f64, dy: f64) -> Plane {
    let snap = |v: f64| if (v - v.round()).abs() < 1e-6 { v.round() } else { v };
    let mut out = Plane::new(p.w, p.h);
    for y in 0..p.h {
        for x in 0..p.w {
            let (sx, sy) = (snap(x as f64 - dx), snap(y as f64 - dy));
            let (x0, y0) = (sx.floor(), sy.floor());
            let (fx, fy) = ((sx - x0) as f32, (sy - y0) as f32);
            let (x0, y0) = (x0 as isize, y0 as isize);
            let top = p.at(x0, y0) * (1.0 - fx) + p.at(x0 + 1, y0) * fx;
            let bottom = p.at(x0, y0 + 1) * (1.0 - fx) + p.at(x0 + 1, y0 + 1) * fx;
            out.v[y * p.w + x] = top * (1.0 - fy) + bottom * fy;
        }
    }
    out
}

pub const CONTOUR_N: usize = 1025;

/// The contour as a 1025-entry table through the curves spline (pencil: linear segments);
/// anti-alias off quantizes to 1/255. Points round to whole 0..255 levels.
pub fn contour_table(c: &Contour) -> Vec<f32> {
    let pts: Vec<[u8; 2]> = c.points.iter().map(|p| p.map(|v| v.round().clamp(0.0, 255.0) as u8)).collect();
    let curve = Curve::new(&pts, c.mode == ContourMode::Pencil);
    (0..CONTOUR_N)
        .map(|i| {
            let v = curve.at(i as f64 / (CONTOUR_N - 1) as f64) as f32;
            if c.anti_alias { v } else { (v * 255.0).round() / 255.0 }
        })
        .collect()
}

fn is_linear(c: &Contour) -> bool {
    let has = |x: f32| c.points.iter().any(|p| p[0] == x);
    c.points.iter().all(|p| p[0] == p[1]) && has(0.0) && has(255.0)
}

fn lookup(lut: &[f32], t: f32) -> f32 {
    let x = t.clamp(0.0, 1.0) * (lut.len() - 1) as f32;
    let i = (x.floor() as usize).min(lut.len() - 2);
    lut[i] + (lut[i + 1] - lut[i]) * (x - i as f32)
}

/// `v = LUT(clamp(v / max(0.01, range)))`; the linear contour at range >= 1 is skipped.
pub fn apply_contour(p: &mut Plane, c: &Contour, range: f32) {
    if is_linear(c) && range >= 1.0 {
        return;
    }
    let lut = contour_table(c);
    p.v.iter_mut().for_each(|v| *v = lookup(&lut, *v / range.max(0.01)));
}

// Fixed noise seeds per effect.
const SEED_DROP: u32 = 3;
const SEED_INNER_SHADOW: u32 = 17;
const SEED_OUTER_GLOW: u32 = 29;
const SEED_INNER_GLOW: u32 = 41;

// `origin` is in level px; the hash reads document px `(origin + x) << level`, as the compositor does.
fn hash_at(i: usize, w: usize, origin: [i32; 2], level: u32, seed: u32) -> f32 {
    let (x, y) = (origin[0] + (i % w) as i32, origin[1] + (i / w) as i32);
    dissolve_hash((x as u32) << level, (y as u32) << level, seed)
}

/// `v *= 1 - noise * hash(x, y, seed)` hashed on document px, so tiles and levels agree.
pub fn noise(p: &mut Plane, amount: f32, seed: u32, origin: [i32; 2], level: u32) {
    if amount <= 0.0 {
        return;
    }
    let w = p.w;
    p.v.iter_mut().enumerate().for_each(|(i, v)| *v *= 1.0 - amount * hash_at(i, w, origin, level, seed));
}

/// What effects read besides the shape: the plane origin in level px and its level, the style scale (times
/// every px parameter), global light, document patterns and blobs, the layer bounds box
/// [x, y, w, h] and the document size, in document px.
#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    pub origin: [i32; 2],
    pub level: u32,
    pub scale: f32,
    pub light: &'a GlobalLight,
    pub patterns: &'a [PatternEntry],
    pub blobs: &'a HashMap<u64, Arc<Vec<u8>>>,
    pub bounds: [f64; 4],
    pub doc: [f64; 2],
    /// A 32-bit document: effect blends in `hdr_mode` modes keep values above 1.
    pub hdr: bool,
}

fn on(present: bool, enabled: bool) -> bool {
    present && enabled
}

fn unit(c: [u8; 3]) -> [f32; 3] {
    c.map(|v| v as f32 / 255.0)
}

/// A coverage plane as straight RGBA in one color.
pub fn colorize(p: &Plane, color: [u8; 3]) -> Vec<[f32; 4]> {
    let [r, g, b] = unit(color);
    p.v.iter().map(|&a| [r, g, b, a]).collect()
}

/// Drop shadow (`inner` false) or inner shadow coverage.
// `p` with each pixel outside the canvas set to the nearest canvas pixel: Photoshop draws no inner
// shadow where a layer meets the canvas edge.
fn canvas_clamped(p: &Plane, cx: &Ctx) -> Plane {
    let [ox, oy] = cx.origin.map(|v| v as f64);
    let clamp = |i: usize, o: f64, doc: f64, n: usize| ((o + i as f64).clamp(0.0, (doc - 1.0).max(0.0)) - o).clamp(0.0, n as f64 - 1.0) as usize;
    let (w, h) = (p.w, p.h);
    p.map(|i, _| p.v[clamp(i / w, oy, cx.doc[1], h) * w + clamp(i % w, ox, cx.doc[0], w)])
}

pub fn shadow_coverage(s: &Shadow, inner: bool, shape: &Shape, cx: &Ctx) -> Plane {
    let angle = if s.use_global_light { cx.light.angle } else { s.angle };
    let size = s.size * cx.scale;
    let sp = size * s.spread;
    let src = if inner { canvas_clamped(&shape.plane, cx).map(|_, a| 1.0 - a) } else { shape.plane.clone() };
    let (dx, dy) = offset(angle, s.distance * cx.scale);
    let mut v = gaussian(&spread(&shift(&src, dx, dy), sp), size - sp);
    if inner {
        v.mul(&shape.plane);
    }
    apply_contour(&mut v, &s.contour, 1.0);
    noise(&mut v, s.noise, if inner { SEED_INNER_SHADOW } else { SEED_DROP }, cx.origin, cx.level);
    if !inner && s.knocks_out {
        v.mul(&shape.plane.map(|_, a| 1.0 - a));
    }
    v.clamp01();
    v
}

/// Outer (`inner` false) or inner glow coverage before coloring.
pub fn glow_coverage(g: &Glow, inner: bool, shape: &Shape, cx: &Ctx) -> Plane {
    let size = g.size * cx.scale;
    let sp = size * g.spread;
    let mut v = if inner && g.source == GlowSource::Center {
        let r = size * (1.0 - g.spread.min(0.99));
        let v = shape.inside().map(|_, d| (d / r.max(1e-6)).clamp(0.0, 1.0));
        if g.technique == GlowTechnique::Softer && r > 1.0 { gaussian(&v, r / 2.0) } else { v }
    } else if g.technique == GlowTechnique::Softer {
        let base = if inner { shape.plane.map(|_, a| 1.0 - a) } else { shape.plane.clone() };
        let r = (size - sp) / 2.0;
        box_blur(&box_blur(&spread(&base, sp), r), r)
    } else {
        let d = if inner { shape.inside() } else { shape.outside() };
        d.map(|_, d| ((size - d) / (size - sp).max(1e-6)).clamp(0.0, 1.0))
    };
    v.mul(&if inner { shape.plane.clone() } else { shape.plane.map(|_, a| 1.0 - a) });
    apply_contour(&mut v, &g.contour, g.range);
    noise(&mut v, g.noise, if inner { SEED_INNER_GLOW } else { SEED_OUTER_GLOW }, cx.origin, cx.level);
    v.clamp01();
    v
}

/// A glow as straight RGBA: its color at the coverage, or the gradient at the coverage (plus
/// `(hash - 0.5) * jitter`, the noise seed) with alpha = coverage * gradient alpha.
pub fn glow_rgba(g: &Glow, inner: bool, shape: &Shape, cx: &Ctx) -> Vec<[f32; 4]> {
    let v = glow_coverage(g, inner, shape, cx);
    match &g.fill {
        GlowFill::Color { color } => colorize(&v, *color),
        GlowFill::Gradient { gradient: def } => {
            let lut = def.lut(false);
            let seed = if inner { SEED_INNER_GLOW } else { SEED_OUTER_GLOW };
            let jit = |i: usize| if g.jitter > 0.0 { (hash_at(i, v.w, cx.origin, cx.level, seed) - 0.5) * g.jitter } else { 0.0 };
            v.v.iter()
                .enumerate()
                .map(|(i, &a)| {
                    let c = gradient::lut_lookup(&lut, a + jit(i));
                    [c[0], c[1], c[2], a * c[3]]
                })
                .collect()
        }
    }
}

/// Satin coverage: `|shift(G, +off) - shift(G, -off)|` of the Gaussian shape, contour, invert,
/// times the shape.
pub fn satin_coverage(s: &Satin, shape: &Shape, cx: &Ctx) -> Plane {
    let g = gaussian(&shape.plane, s.size * cx.scale);
    let (dx, dy) = offset(s.angle, s.distance * cx.scale);
    let b = shift(&g, -dx, -dy);
    let mut v = shift(&g, dx, dy).map(|i, a| (a - b.v[i]).abs());
    apply_contour(&mut v, &s.contour, 1.0);
    if s.invert {
        v = v.map(|_, a| 1.0 - a);
    }
    v.mul(&shape.plane);
    v.clamp01();
    v
}

// A pattern fill's sampler over document px, none when the pattern is missing.
fn pattern_sampler<'a>(p: &PatternFill, cx: &Ctx<'a>) -> Option<impl Fn(f64, f64) -> [f32; 4] + 'a> {
    let e = cx.patterns.iter().find(|e| e.id == p.pattern_id)?;
    let bytes = cx.blobs.get(&e.blob)?;
    let origin = if p.linked { [cx.bounds[0], cx.bounds[1]] } else { [0.0; 2] };
    Some(p.sampler(e.width, e.height, bytes, origin))
}

/// Straight RGBA of a solid, gradient or pattern fill sampled at pixel centers, alpha times
/// `cov`. Gradients lay out over the layer bounds when aligned, else the document.
pub fn fill_plane(fill: &FillContent, cov: &Plane, cx: &Ctx) -> Vec<[f32; 4]> {
    let sample: Box<dyn Fn(f64, f64) -> [f32; 4] + '_> = match fill {
        FillContent::Solid(s) => {
            let [r, g, b] = unit(s.color);
            Box::new(move |_, _| [r, g, b, 1.0])
        }
        FillContent::Gradient(g) => {
            Box::new(g.sampler(if g.align_with_layer { cx.bounds } else { [0.0, 0.0, cx.doc[0], cx.doc[1]] }))
        }
        FillContent::Pattern(p) => match pattern_sampler(p, cx) {
            Some(f) => Box::new(f),
            None => Box::new(|_, _| [0.0; 4]),
        },
    };
    let [ox, oy] = cx.origin.map(|v| v as f64 + 0.5);
    cov.v
        .iter()
        .enumerate()
        .map(|(i, &a)| {
            let mut c = sample(ox + (i % cov.w) as f64, oy + (i / cov.w) as f64);
            c[3] *= a;
            c
        })
        .collect()
}

/// Stroke band coverage `clamp(s - lo + 0.5) * clamp(hi - s + 0.5)` on the signed distance s.
pub fn stroke_coverage(s: &Stroke, shape: &Shape, cx: &Ctx) -> Plane {
    let size = s.size * cx.scale;
    let (lo, hi) = match s.position {
        StrokePosition::Outside => (0.0, size),
        StrokePosition::Inside => (-size, 0.0),
        StrokePosition::Center => (-size / 2.0, size / 2.0),
    };
    shape.signed().map(|_, d| (d - lo + 0.5).clamp(0.0, 1.0) * (hi - d + 0.5).clamp(0.0, 1.0))
}

/// Bevel and emboss (highlight, shadow) coverage. `band` is the stroke band shape that stroke
/// emboss bevels and restricts to (the layer shape when none).
pub fn bevel_coverage(
    b: &Bevel,
    contour: Option<&BevelContour>,
    texture: Option<&BevelTexture>,
    shape: &Shape,
    band: Option<&Shape>,
    cx: &Ctx,
) -> (Plane, Plane) {
    let s = (b.size * cx.scale).max(0.5);
    let src = if b.style == BevelStyle::StrokeEmboss { band.unwrap_or(shape) } else { shape };
    let mut h = if b.technique == BevelTechnique::Smooth && b.style != BevelStyle::Pillow {
        box_blur(&box_blur(&src.plane, s / 2.0), s / 2.0)
    } else {
        let (i, o) = (src.inside(), src.outside());
        let hp = src.plane.map(|k, a| {
            let (p, m) = ((i.v[k] / s).clamp(0.0, 1.0), (o.v[k] / s).clamp(0.0, 1.0));
            let y = a >= 0.5;
            match b.style {
                BevelStyle::Inner | BevelStyle::StrokeEmboss => if y { p } else { 0.0 },
                BevelStyle::Outer => if y { 1.0 } else { 1.0 - m },
                BevelStyle::Emboss => if y { 0.5 + 0.5 * p } else { 0.5 - 0.5 * m },
                BevelStyle::Pillow => if y { p - 1.0 } else { 1.0 - m },
            }
        });
        match b.technique {
            BevelTechnique::Smooth => gaussian(&hp, s / 2.0),
            BevelTechnique::ChiselSoft => gaussian(&hp, (s / 3.0).max(1.0)),
            BevelTechnique::ChiselHard => hp,
        }
    };
    if let Some(t) = texture.filter(|t| on(t.present, t.enabled)) {
        let pf = PatternFill { pattern_id: t.pattern_id.clone(), scale: t.scale, angle: 0.0, linked: t.linked, offset: t.offset };
        if let Some(sample) = pattern_sampler(&pf, cx) {
            let k = t.depth * if t.invert { -1.0 } else { 1.0 };
            let [ox, oy] = cx.origin.map(|v| v as f64 + 0.5);
            let w = h.w;
            h.v.iter_mut().enumerate().for_each(|(i, v)| {
                let c = sample(ox + (i % w) as f64, oy + (i / w) as f64);
                *v += (lum([c[0], c[1], c[2]]) - 0.5) * k;
            });
        }
    }
    h = gaussian(&h, b.soften * cx.scale);

    let (angle, altitude) = if b.use_global_light { (cx.light.angle, cx.light.altitude) } else { (b.angle, b.altitude) };
    let (a, alt) = (angle.to_radians(), altitude.clamp(-90.0, 90.0).to_radians());
    let l = [a.cos() * alt.cos(), -a.sin() * alt.cos(), alt.sin()];
    let c = s * b.depth;
    let dir = if b.direction == BevelDirection::Down { -1.0 } else { 1.0 };
    let gloss = (!is_linear(&b.gloss_contour)).then(|| contour_table(&b.gloss_contour));
    let (mut hl, mut sh) = (Plane::new(h.w, h.h), Plane::new(h.w, h.h));
    for y in 0..h.h as isize {
        for x in 0..h.w as isize {
            let i = y as usize * h.w + x as usize;
            let gx = (h.at(x + 1, y) - h.at(x - 1, y)) / 2.0 * c;
            let gy = (h.at(x, y + 1) - h.at(x, y - 1)) / 2.0 * c;
            if src.plane.v[i] == 0.0 && h.v[i].abs() < 1e-6 && gx.abs() < 1e-6 && gy.abs() < 1e-6 {
                continue;
            }
            let lit = (-(gx * l[0] + gy * l[1]) * dir + l[2]) / (1.0 + gx * gx + gy * gy).sqrt();
            let shade = if lit >= l[2] { (lit - l[2]) / (1.0 - l[2]).max(1e-6) } else { (lit - l[2]) / l[2].max(1e-6) };
            let o = gloss.as_ref().map_or(shade, |lut| 2.0 * lookup(lut, (shade + 1.0) / 2.0) - 1.0);
            if o > 0.0 {
                hl.v[i] = o.min(1.0);
            } else if o < 0.0 {
                sh.v[i] = (-o).min(1.0);
            }
        }
    }
    if let Some(cs) = contour.filter(|c| on(c.present, c.enabled)) {
        let mut m = src.profile(s).map(|_, p| 1.0 - p);
        apply_contour(&mut m, &cs.contour, cs.range);
        hl.mul(&m);
        sh.mul(&m);
    }
    let restrict = match b.style {
        BevelStyle::Inner => Some(shape.plane.clone()),
        BevelStyle::StrokeEmboss => Some(src.plane.clone()),
        BevelStyle::Outer => Some(shape.plane.map(|_, a| 1.0 - a)),
        BevelStyle::Emboss | BevelStyle::Pillow => None,
    };
    for p in [&mut hl, &mut sh] {
        if let Some(r) = &restrict {
            p.mul(r);
        }
        p.clamp01();
    }
    (hl, sh)
}

/// Padding in px the style's effects reach beyond the shape: shadows and satin distance + size,
/// glows and strokes size, bevel 1.5 size + soften; times scale, then ceil + 1. 0 without effects.
pub fn reach(style: &Style) -> u32 {
    if !style.any_effect() {
        return 0;
    }
    let shadows = style.drop_shadows.iter().chain(&style.inner_shadows).filter(|e| on(e.present, e.enabled));
    let glows = style.outer_glow.iter().chain(&style.inner_glow).filter(|e| on(e.present, e.enabled));
    let px = shadows
        .map(|e| e.distance + e.size)
        .chain(glows.map(|e| e.size))
        .chain(style.strokes.iter().filter(|e| on(e.present, e.enabled)).map(|e| e.size))
        .chain(style.satin.iter().filter(|e| on(e.present, e.enabled)).map(|e| e.distance + e.size))
        .chain(style.bevel.iter().filter(|e| on(e.present, e.enabled)).map(|e| 1.5 * e.size + e.soften))
        .fold(0.0f32, f32::max);
    (px * style.scale).max(0.0).ceil() as u32 + 1
}

/// One plane drawn under the content: straight RGBA in `blend` at `opacity` (the compositor
/// multiplies the layer opacity).
pub struct Behind {
    pub rgba: Vec<[f32; 4]>,
    pub blend: Blend,
    pub opacity: f32,
}

/// A styled layer: behind planes in draw order and the content with the interior effects,
/// both straight (unpremultiplied) RGBA on the padded plane.
pub struct Rendered {
    pub behind: Vec<Behind>,
    pub content: Vec<[f32; 4]>,
}

/// The layer side of `render_layer`: `w` x `h` straight RGBA content with the masks already
/// multiplied in, its blend mode, fill opacity, blending options and masks (1 = shown).
pub struct Layer<'a> {
    pub w: usize,
    pub h: usize,
    pub content: &'a [[f32; 4]],
    pub blend: Blend,
    pub fill: f32,
    pub blending: &'a Blending,
    pub layer_mask: Option<&'a Plane>,
    pub vector_mask: Option<&'a Plane>,
}

// Composites a straight effect plane onto the content with the union alpha rule.
fn paint(content: &mut [[f32; 4]], plane: &[[f32; 4]], blend: Blend, opacity: f32, hdr: bool) {
    for (d, s) in content.iter_mut().zip(plane) {
        *d = paint_pixel_hdr(PaintMode::Blend(blend), *d, [s[0], s[1], s[2]], s[3] * opacity, false, hdr);
    }
}

/// Renders a layer's style in the order of docs/M3.md section 5: behind planes (drop shadows in
/// list order, then outer glow), then onto the content pattern, gradient and color overlays, fill
/// opacity (color burn and linear burn pull color toward white, vivid light, linear light and hard
/// mix toward 0.5, other modes scale alpha), satin, inner glow, inner shadows, bevel shadow then
/// highlight, strokes; blend interior clamps content alpha to the unfilled alpha; masks whose
/// "hides effects" flag is set multiply the behind planes. A disabled style only applies fill.
pub fn render_layer(style: &Style, layer: &Layer, cx: &Ctx) -> Rendered {
    let cx = &Ctx { scale: style.scale, ..*cx };
    let (w, h) = (layer.w, layer.h);
    let alpha = Plane { w, h, v: layer.content.iter().map(|c| c[3]).collect() };
    let shape = Shape::new(if layer.blending.transparency_shapes {
        alpha.clone()
    } else {
        let [bx, by, bw, bh] = cx.bounds;
        let [ox, oy] = cx.origin.map(|v| v as f64 + 0.5);
        alpha.map(|i, _| {
            let (x, y) = (ox + (i % w) as f64, oy + (i / w) as f64);
            (x >= bx && x < bx + bw && y >= by && y < by + bh) as u8 as f32
        })
    });
    let mut content = layer.content.to_vec();
    let mut behind = Vec::new();
    let fx = style.enabled;
    let live = |present: bool, enabled: bool| fx && on(present, enabled);

    for s in style.drop_shadows.iter().filter(|e| live(e.present, e.enabled)) {
        let rgba = colorize(&shadow_coverage(s, false, &shape, cx), s.color);
        behind.push(Behind { rgba, blend: s.blend, opacity: s.opacity });
    }
    if let Some(g) = style.outer_glow.as_ref().filter(|e| live(e.present, e.enabled)) {
        behind.push(Behind { rgba: glow_rgba(g, false, &shape, cx), blend: g.blend, opacity: g.opacity });
    }

    for o in style.pattern_overlays.iter().filter(|e| live(e.present, e.enabled)) {
        let rgba = fill_plane(&FillContent::Pattern(o.pattern.clone()), &shape.plane, cx);
        paint(&mut content, &rgba, o.blend, o.opacity, cx.hdr);
    }
    for o in style.gradient_overlays.iter().filter(|e| live(e.present, e.enabled)) {
        let rgba = fill_plane(&FillContent::Gradient(o.gradient.clone()), &shape.plane, cx);
        paint(&mut content, &rgba, o.blend, o.opacity, cx.hdr);
    }
    for o in style.color_overlays.iter().filter(|e| live(e.present, e.enabled)) {
        paint(&mut content, &colorize(&shape.plane, o.color), o.blend, o.opacity, cx.hdr);
    }

    let toward = match layer.blend {
        Blend::ColorBurn | Blend::LinearBurn => Some(1.0),
        Blend::VividLight | Blend::LinearLight | Blend::HardMix => Some(0.5),
        _ => None,
    };
    for c in &mut content {
        match toward {
            Some(t) => c[..3].iter_mut().for_each(|v| *v = t + (*v - t) * layer.fill),
            None => c[3] *= layer.fill,
        }
    }

    if let Some(s) = style.satin.as_ref().filter(|e| live(e.present, e.enabled)) {
        paint(&mut content, &colorize(&satin_coverage(s, &shape, cx), s.color), s.blend, s.opacity, cx.hdr);
    }
    if let Some(g) = style.inner_glow.as_ref().filter(|e| live(e.present, e.enabled)) {
        paint(&mut content, &glow_rgba(g, true, &shape, cx), g.blend, g.opacity, cx.hdr);
    }
    for s in style.inner_shadows.iter().filter(|e| live(e.present, e.enabled)) {
        paint(&mut content, &colorize(&shadow_coverage(s, true, &shape, cx), s.color), s.blend, s.opacity, cx.hdr);
    }
    let strokes: Vec<(&Stroke, Plane)> = style
        .strokes
        .iter()
        .filter(|e| live(e.present, e.enabled))
        .map(|s| (s, stroke_coverage(s, &shape, cx)))
        .collect();
    if let Some(b) = style.bevel.as_ref().filter(|e| live(e.present, e.enabled)) {
        let emboss = b.style == BevelStyle::StrokeEmboss;
        let band = strokes.first().filter(|_| emboss).map(|(_, c)| Shape::new(c.clone()));
        let (hl, sh) = bevel_coverage(b, style.contour.as_ref(), style.texture.as_ref(), &shape, band.as_ref(), cx);
        paint(&mut content, &colorize(&sh, b.shadow_color), b.shadow_blend, b.shadow_opacity, cx.hdr);
        paint(&mut content, &colorize(&hl, b.highlight_color), b.highlight_blend, b.highlight_opacity, cx.hdr);
    }
    for (s, cov) in &strokes {
        if !s.overprint {
            content.iter_mut().zip(&cov.v).for_each(|(c, k)| c[3] *= 1.0 - k * s.opacity);
        }
        paint(&mut content, &fill_plane(&s.fill, cov, cx), s.blend, s.opacity, cx.hdr);
    }

    if layer.blending.blend_interior {
        content.iter_mut().zip(&alpha.v).for_each(|(c, &a)| c[3] = c[3].min(a));
    }
    let masks = [
        (layer.layer_mask, layer.blending.layer_mask_hides_effects),
        (layer.vector_mask, layer.blending.vector_mask_hides_effects),
    ];
    for m in masks.into_iter().filter_map(|(m, hide)| m.filter(|_| hide)) {
        for b in &mut behind {
            b.rgba.iter_mut().zip(&m.v).for_each(|(c, k)| c[3] *= k);
        }
    }
    Rendered { behind, content }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blend::{PaintMode, paint_pixel};
    use crate::content::{GlobalLight, SolidFill};

    const W: usize = 40;

    fn linear() -> Contour {
        Contour { name: "Linear".into(), points: vec![[0.0, 0.0], [255.0, 255.0]], mode: ContourMode::Point, anti_alias: true }
    }

    fn style() -> Style {
        Style {
            enabled: true,
            scale: 1.0,
            drop_shadows: vec![],
            inner_shadows: vec![],
            color_overlays: vec![],
            gradient_overlays: vec![],
            pattern_overlays: vec![],
            strokes: vec![],
            outer_glow: None,
            inner_glow: None,
            bevel: None,
            contour: None,
            texture: None,
            satin: None,
        }
    }

    fn shadow() -> Shadow {
        Shadow {
            present: true,
            enabled: true,
            blend: Blend::Multiply,
            opacity: 0.75,
            color: [0, 0, 0],
            use_global_light: true,
            angle: 120.0,
            distance: 5.0,
            spread: 0.0,
            size: 5.0,
            contour: linear(),
            noise: 0.0,
            knocks_out: true,
        }
    }

    fn glow(technique: GlowTechnique, source: GlowSource, size: f32, spread: f32, range: f32) -> Glow {
        Glow {
            present: true,
            enabled: true,
            blend: Blend::Screen,
            opacity: 0.75,
            fill: GlowFill::Color { color: [255, 255, 190] },
            technique,
            spread,
            size,
            range,
            jitter: 0.0,
            noise: 0.0,
            contour: linear(),
            source,
        }
    }

    fn bevel(technique: BevelTechnique) -> Bevel {
        Bevel {
            present: true,
            enabled: true,
            style: BevelStyle::Inner,
            technique,
            depth: 1.0,
            direction: BevelDirection::Up,
            size: 5.0,
            soften: 0.0,
            use_global_light: true,
            angle: 120.0,
            altitude: 30.0,
            gloss_contour: linear(),
            highlight_blend: Blend::Screen,
            highlight_color: [255; 3],
            highlight_opacity: 0.75,
            shadow_blend: Blend::Multiply,
            shadow_color: [0; 3],
            shadow_opacity: 0.75,
        }
    }

    fn with_cx<R>(origin: [i32; 2], f: impl FnOnce(&Ctx) -> R) -> R {
        let (light, blobs) = (GlobalLight::default(), HashMap::new());
        f(&Ctx { origin, level: 0, scale: 1.0, light: &light, patterns: &[], blobs: &blobs, bounds: [10.0, 10.0, 20.0, 20.0], doc: [40.0, 40.0], hdr: false })
    }

    // The 40x40 plane with an opaque square at x, y in 10..=29.
    fn square() -> Shape {
        let mut p = Plane::new(W, W);
        for y in 10..30 {
            p.v[y * W + 10..y * W + 30].fill(1.0);
        }
        Shape::new(p)
    }

    fn row(p: &Plane, y: usize) -> Vec<f32> {
        p.v[y * p.w..(y + 1) * p.w].to_vec()
    }

    fn col(p: &Plane, x: usize) -> Vec<f32> {
        (0..p.h).map(|y| p.v[y * p.w + x]).collect()
    }

    fn close(got: &[f32], want: &[f32], tol: f32) {
        assert_eq!(got.len(), want.len());
        for (i, (g, w)) in got.iter().zip(want).enumerate() {
            assert!((g - w).abs() <= tol, "index {i}: got {g}, want {w}\n got {got:?}");
        }
    }

    fn line(v: &[f32]) -> Plane {
        Plane { w: v.len(), h: 1, v: v.to_vec() }
    }

    #[test]
    fn distances_are_exact_euclidean_minus_half_a_pixel() {
        let p = line(&(0..16).map(|x| if x >= 10 { 1.0 } else { 0.0 }).collect::<Vec<_>>());
        let s = Shape::new(p);
        close(&s.outside().v[..11], &[9.5, 8.5, 7.5, 6.5, 5.5, 4.5, 3.5, 2.5, 1.5, 0.5, 0.0], 1e-6);
        close(&s.inside().v[8..], &[0.0, 0.0, 0.5, 1.5, 2.5, 3.5, 4.5, 5.5], 1e-6);
        close(&s.signed().v[8..12], &[1.5, 0.5, -0.5, -1.5], 1e-6);
        // Diagonals are Euclidean, and the plane border is not an edge.
        let mut d = Plane::new(5, 5);
        d.v[0] = 1.0;
        let raw = Shape::new(d).outside().v.clone();
        close(&[raw[6], raw[7], raw[12], raw[24]], &[0.9142, 1.7361, 2.3284, 5.1569], 1e-4);
        assert!(Shape::new(line(&[1.0; 3])).inside().v.iter().all(|&v| v > 1e9));
        // Partial alpha binarises at 0.5.
        close(&Shape::new(line(&[0.0, 0.49, 0.5])).outside().v, &[1.5, 0.5, 0.0], 1e-6);
    }

    #[test]
    fn box_blur_rounds_the_radius_and_replicates_edges() {
        let p = line(&[1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        close(&box_blur(&p, 2.0).v, &[1.0, 0.8, 0.6, 0.4, 0.2, 0.0, 0.0, 0.2, 0.4, 0.6], 1e-6);
        assert_eq!(box_blur(&p, 0.4), p);
        assert_eq!(box_blur(&p, 1.5), box_blur(&p, 2.0));
    }

    #[test]
    fn large_gaussians_use_boxes_for_gauss() {
        let cases = [(13.0, [4, 4, 4]), (15.0, [4, 4, 5]), (20.0, [6, 6, 7]), (30.0, [9, 9, 10]), (50.0, [16, 16, 17]), (250.0, [83, 83, 83])];
        for (size, radii) in cases {
            assert_eq!(gauss_boxes(size / 3.0), radii, "size {size}");
        }
        // Up to size 12 the exact kernel runs; the sum is preserved either way.
        let mut p = Plane::new(64, 1);
        p.v[32] = 1.0;
        close(&gaussian(&p, 5.0).v[27..33], &[0.0027, 0.0134, 0.0474, 0.1166, 0.2001, 0.2396], 1e-4);
        assert!((gaussian(&p, 20.0).v.iter().sum::<f32>() - 1.0).abs() < 1e-5);
    }

    #[test]
    fn spread_grows_by_the_raw_outside_distance() {
        let p = line(&(0..14).map(|x| if x >= 10 { 1.0 } else { 0.0 }).collect::<Vec<_>>());
        close(&spread(&p, 2.0).v[6..11], &[0.0, 0.0, 1.0, 1.0, 1.0], 1e-6);
        close(&spread(&p, 2.4).v[6..11], &[0.0, 0.4, 1.0, 1.0, 1.0], 1e-5);
    }

    #[test]
    fn shift_moves_away_from_the_light_with_bilinear_fractions() {
        let (dx, dy) = offset(180.0, 5.0);
        assert!((dx - 5.0).abs() < 1e-9 && dy.abs() < 1e-9);
        let (dx, dy) = offset(90.0, 2.0);
        assert!(dx.abs() < 1e-9 && (dy - 2.0).abs() < 1e-9);
        let p = line(&[0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);
        close(&shift(&p, 2.0, 0.0).v, &[0.0, 0.0, 0.0, 0.0, 1.0, 0.0], 1e-6);
        close(&shift(&p, 0.25, 0.0).v, &[0.0, 0.0, 0.75, 0.25, 0.0, 0.0], 1e-6);
    }

    #[test]
    fn contour_tables_follow_the_curves_spline() {
        let t = contour_table(&linear());
        assert_eq!(t.len(), 1025);
        assert!(t.iter().enumerate().all(|(i, &v)| (v - i as f32 / 1024.0).abs() < 1e-6));
        // Anti-alias off quantizes to 1/255.
        let q = contour_table(&Contour { anti_alias: false, ..linear() });
        assert!(q.iter().all(|&v| ((v * 255.0).round() - v * 255.0).abs() < 1e-4));
        assert!((q[3] - 1.0 / 255.0).abs() < 1e-6);
        // Pencil is linear between points; a range below 1 stretches the input.
        let tri = Contour { points: vec![[0.0, 0.0], [128.0, 255.0], [255.0, 0.0]], mode: ContourMode::Pencil, ..linear() };
        let mut p = line(&[0.25, 0.5, 1.0]);
        apply_contour(&mut p, &tri, 1.0);
        close(&p.v, &[0.5, 0.996, 0.0], 5e-3);
        let mut p = line(&[0.25]);
        apply_contour(&mut p, &linear(), 0.5);
        close(&p.v, &[0.5], 1e-6);
    }

    #[test]
    fn noise_hashes_document_pixels() {
        let (mut a, mut b) = (Plane::new(8, 8), Plane::new(8, 8));
        a.v.fill(1.0);
        b.v.fill(1.0);
        noise(&mut a, 0.5, 3, [0, 0], 0);
        noise(&mut b, 0.5, 3, [4, 4], 0);
        assert_eq!(row(&a, 5)[4..], row(&b, 1)[..4]);
        assert!(a.v.iter().all(|&v| (0.5..=1.0).contains(&v)) && a.v.iter().any(|&v| v < 0.9));
        // Level 1: level px (x, y) samples document px (2x, 2y).
        let mut c = Plane::new(3, 3);
        c.v.fill(1.0);
        noise(&mut c, 0.5, 3, [1, 1], 1);
        let doc: Vec<f32> = (0..3).map(|x| a.v[2 * 8 + 2 + 2 * x]).collect();
        assert_eq!(row(&c, 0), doc);
    }

    #[test]
    fn outside_stroke_three_covers_one_to_three_px() {
        let s = Stroke {
            present: true,
            enabled: true,
            size: 3.0,
            position: StrokePosition::Outside,
            blend: Blend::Normal,
            opacity: 1.0,
            overprint: false,
            fill: FillContent::Solid(SolidFill { color: [0, 0, 0] }),
        };
        let cov = with_cx([0, 0], |cx| stroke_coverage(&s, &square(), cx));
        // Row 20: the square's left edge is x = 10, its right edge x = 29.
        close(&row(&cov, 20)[5..11], &[0.0, 0.0, 1.0, 1.0, 1.0, 0.0], 0.0);
        close(&row(&cov, 20)[29..35], &[0.0, 1.0, 1.0, 1.0, 0.0, 0.0], 0.0);
        close(&col(&cov, 20)[5..10], &[0.0, 0.0, 1.0, 1.0, 1.0], 0.0);
    }

    #[test]
    fn drop_shadow_at_180_degrees_falls_five_px_right() {
        let mut p = Plane::new(W, 20);
        for y in 5..15 {
            p.v[y * W + 10..y * W + 20].fill(1.0);
        }
        let s = Shadow { use_global_light: false, angle: 180.0, size: 0.0, ..shadow() };
        let v = with_cx([0, 0], |cx| shadow_coverage(&s, false, &Shape::new(p), cx));
        let white = |a: f32| paint_pixel(PaintMode::Blend(Blend::Multiply), [1.0; 4], [0.0; 3], a * 0.75, false);
        let px = |x: usize| (white(v.v[10 * W + x])[0] * 255.0).round() as u8;
        assert_eq!((px(19), px(20), px(22), px(24), px(25)), (255, 64, 64, 64, 255));
    }

    // geodeck-graphs.psd: a layer that ends at the canvas edge gets no inner shadow along that edge.
    #[test]
    fn inner_shadow_skips_the_canvas_edge() {
        let mut p = Plane::new(50, 50);
        for y in 15..45 {
            p.v[y * 50 + 15..y * 50 + 35].fill(1.0);
        }
        let s = Shadow { distance: 0.0, spread: 1.0, size: 3.0, ..shadow() };
        let v = with_cx([-5, -5], |cx| shadow_coverage(&s, true, &Shape::new(p), cx));
        let at = |x: usize, y: usize| v.v[y * 50 + x];
        assert!(at(25, 15) > 0.99, "top edge inside the canvas: {}", at(25, 15));
        assert!(at(15, 30) > 0.99, "left edge inside the canvas: {}", at(15, 30));
        assert!(at(25, 44) < 0.01, "bottom edge on the canvas border: {}", at(25, 44));
    }

    #[test]
    fn color_overlay_quarter_red_over_blue() {
        let sq = square();
        let content: Vec<[f32; 4]> = sq.plane.v.iter().map(|&a| [0.0, 0.0, 1.0, a]).collect();
        let st = Style {
            color_overlays: vec![ColorOverlay { present: true, enabled: true, blend: Blend::Normal, opacity: 0.25, color: [255, 0, 0] }],
            ..style()
        };
        let blending = Blending::default();
        let out = with_cx([0, 0], |cx| render_layer(&st, &layer(&content, &blending), cx));
        let c = out.content[20 * W + 20].map(|v| (v * 255.0).round() as u8);
        assert_eq!(c, [64, 0, 191, 255]);
        assert!(out.behind.is_empty());
        assert_eq!(out.content[0], [0.0, 0.0, 1.0, 0.0]);
    }

    fn layer<'a>(content: &'a [[f32; 4]], blending: &'a Blending) -> Layer<'a> {
        Layer { w: W, h: W, content, blend: Blend::Normal, fill: 1.0, blending, layer_mask: None, vector_mask: None }
    }

    // Rows and columns of an independent Node script (see the B8a report) on the 40x40 square.
    #[rustfmt::skip]
    const OUTER_SOFTER: [f32; 40] = [0.,0.,0.,0.,0.0408,0.1224,0.2449,0.4082,0.6122,0.8571,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.8571,0.6122,0.4082,0.2449,0.1224,0.0408,0.,0.,0.,0.];
    #[rustfmt::skip]
    const OUTER_PRECISE: [f32; 40] = [0.,0.,0.,0.,0.,0.1667,0.5,0.8333,1.,1.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,1.,1.,0.8333,0.5,0.1667,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const INNER_SOFTER: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.965,0.77,0.525,0.32,0.165,0.06,0.005,0.,0.,0.,0.,0.,0.,0.005,0.06,0.165,0.32,0.525,0.77,0.965,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const INNER_CENTER: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.115,0.2412,0.3913,0.5467,0.7008,0.842,0.9435,0.9886,0.9988,0.9999,0.9999,0.9988,0.9886,0.9435,0.842,0.7008,0.5467,0.3913,0.2412,0.115,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const SATIN: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.136,0.1579,0.1986,0.2551,0.3284,0.4191,0.5259,0.6464,0.7771,0.9137,0.9477,0.8111,0.6806,0.5602,0.4537,0.3633,0.2902,0.234,0.1934,0.1717,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const SMOOTH_HL_COL: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.6625,0.6062,0.5347,0.4462,0.3397,0.2154,0.0751,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const SMOOTH_SH_ROW: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.0454,0.1425,0.2451,0.3495,0.4526,0.5518,0.6453,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const CHISEL_HL_COL: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.7,0.7678,0.7678,0.7678,0.7,0.3339,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const CHISEL_SH_ROW: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.2399,0.7196,0.9053,0.9053,0.9053,0.7196,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const SOFT_DOWN_HL_COL: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.083,0.3245,0.5389,0.4996,0.4139,0.3756,0.3758,0.4147,0.5026,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];
    #[rustfmt::skip]
    const SOFT_DOWN_SH_ROW: [f32; 40] = [0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.0001,0.0505,0.2511,0.6731,1.,1.,1.,1.,1.,1.,0.,0.,0.,0.,0.,0.,0.,0.,0.,0.];

    const TOL: f32 = 1.0 / 255.0;

    fn glow_alpha(g: &Glow, inner: bool) -> Plane {
        let sq = square();
        let rgba = with_cx([0, 0], |cx| glow_rgba(g, inner, &sq, cx));
        assert!(rgba.iter().all(|c| c[..3] == [1.0, 1.0, 190.0 / 255.0]));
        Plane { w: W, h: W, v: rgba.iter().map(|c| c[3]).collect() }
    }

    #[test]
    fn glows_match_the_node_arrays() {
        use {GlowSource::*, GlowTechnique::*};
        close(&row(&glow_alpha(&glow(Softer, Edge, 5.0, 0.0, 0.5), false), 20), &OUTER_SOFTER, TOL);
        close(&row(&glow_alpha(&glow(Precise, Edge, 5.0, 0.4, 1.0), false), 20), &OUTER_PRECISE, TOL);
        close(&row(&glow_alpha(&glow(Softer, Edge, 7.0, 0.3, 0.8), true), 20), &INNER_SOFTER, TOL);
        close(&row(&glow_alpha(&glow(Softer, Center, 8.0, 0.2, 1.0), true), 20), &INNER_CENTER, TOL);
    }

    #[test]
    fn satin_matches_the_node_array() {
        let s = Satin {
            present: true,
            enabled: true,
            blend: Blend::Multiply,
            opacity: 0.5,
            color: [0; 3],
            angle: 19.0,
            distance: 11.0,
            size: 14.0,
            contour: linear(),
            invert: true,
        };
        let v = with_cx([0, 0], |cx| satin_coverage(&s, &square(), cx));
        close(&row(&v, 20), &SATIN, TOL);
    }

    #[test]
    fn bevels_match_the_node_arrays() {
        let run = |b: &Bevel| with_cx([0, 0], |cx| bevel_coverage(b, None, None, &square(), None, cx));
        let (hl, sh) = run(&bevel(BevelTechnique::Smooth));
        close(&col(&hl, 20), &SMOOTH_HL_COL, TOL);
        close(&row(&sh, 20), &SMOOTH_SH_ROW, TOL);
        let (hl, sh) = run(&bevel(BevelTechnique::ChiselHard));
        close(&col(&hl, 20), &CHISEL_HL_COL, TOL);
        close(&row(&sh, 20), &CHISEL_SH_ROW, TOL);
        let soft = Bevel {
            size: 6.0,
            depth: 2.0,
            use_global_light: false,
            angle: 45.0,
            altitude: 40.0,
            direction: BevelDirection::Down,
            soften: 3.0,
            ..bevel(BevelTechnique::ChiselSoft)
        };
        let (hl, sh) = run(&soft);
        close(&col(&hl, 20), &SOFT_DOWN_HL_COL, TOL);
        close(&row(&sh, 20), &SOFT_DOWN_SH_ROW, TOL);
    }

    #[test]
    fn reach_pads_by_the_widest_effect() {
        assert_eq!(reach(&style()), 0);
        let st = Style { drop_shadows: vec![shadow()], ..style() };
        assert_eq!(reach(&st), 11);
        let st = Style { bevel: Some(Bevel { size: 10.0, soften: 2.0, ..bevel(BevelTechnique::Smooth) }), scale: 2.0, ..st };
        assert_eq!(reach(&st), 35);
        let off = Style { enabled: false, ..st };
        assert_eq!(reach(&off), 0);
    }

    #[test]
    fn render_order_fill_modes_interior_clamp_and_mask() {
        // Outer stroke and a drop shadow on a square with a partly transparent pixel inside.
        let sq = square();
        let mut content: Vec<[f32; 4]> = sq.plane.v.iter().map(|&a| [1.0, 0.0, 0.0, a]).collect();
        content[20 * W + 20][3] = 0.6;
        let st = Style {
            drop_shadows: vec![shadow()],
            strokes: vec![Stroke {
                present: true,
                enabled: true,
                size: 3.0,
                position: StrokePosition::Outside,
                blend: Blend::Normal,
                opacity: 0.75,
                overprint: false,
                fill: FillContent::Solid(SolidFill { color: [0, 255, 0] }),
            }],
            ..style()
        };
        let mut mask = Plane::new(W, W);
        mask.v[..W * 20].fill(1.0);
        let blending = Blending { blend_interior: true, layer_mask_hides_effects: true, ..Blending::default() };
        let l = Layer { fill: 0.2, layer_mask: Some(&mask), ..layer(&content, &blending) };
        let out = with_cx([0, 0], |cx| render_layer(&st, &l, cx));
        // Fill dims the content alpha; the interior clamp erases the outside stroke.
        assert!((out.content[15 * W + 15][3] - 0.2).abs() < 1e-6);
        assert!((out.content[20 * W + 20][3] - 0.12).abs() < 1e-6);
        assert_eq!(out.content[20 * W + 8][3], 0.0);
        // The shadow sits behind, in its mode and opacity, hidden where the mask is 0.
        let b = &out.behind[0];
        assert_eq!((b.blend, b.opacity), (Blend::Multiply, 0.75));
        assert!(b.rgba[18 * W + 31][3] > 0.3 && b.rgba[30 * W + 31][3] == 0.0);
        // Without the clamp the stroke stays; color burn pulls color toward white instead of alpha.
        let blending = Blending::default();
        let l = Layer { fill: 0.5, blend: Blend::ColorBurn, ..layer(&content, &blending) };
        let out = with_cx([0, 0], |cx| render_layer(&st, &l, cx));
        close(&out.content[15 * W + 15], &[1.0, 0.5, 0.5, 1.0], 1e-6);
        close(&out.content[20 * W + 8], &[0.0, 1.0, 0.0, 0.75], 1e-6);
    }
}
