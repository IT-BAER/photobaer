//! Vanishing Point (docs/M5.md section 7): perspective planes and clone dabs in plane UV; the
//! registry entry `vanishing_point` (param `state`) and the document's `vanishing_planes`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filters::{Ctx, Filter, Plane};
use crate::pwarp::{convex, homography, invert, map};

const MAX_PLANES: usize = 64;
const MAX_DABS: usize = 50_000;
const UNIT: [[f64; 2]; 4] = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Top,
    Right,
    Bottom,
    Left,
}

/// A plane: 4 corners in document px, UV (0,0) (1,0) (1,1) (0,1) in that order.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VPlane {
    pub id: String,
    pub corners: [[f64; 2]; 4],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hinge_edge: Option<Edge>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angle_degrees: Option<f64>,
}

/// One clone dab, all in plane UV: paints a disc of `radius` around `to` from `from + (uv - to)`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Dab {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plane_id: Option<String>,
    pub from: [f64; 2],
    pub to: [f64; 2],
    pub radius: f64,
    pub opacity: f64,
    pub hardness: f64,
}

/// The `state` param; `brushHardness` and `brushOpacity` are the dialog's 0..100 settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct State {
    pub planes: Vec<VPlane>,
    pub stamps: Vec<Dab>,
    pub grid_size: u32,
    pub brush_hardness: f64,
    pub brush_opacity: f64,
}

/// At most 64 planes with unique ids of 1..=32 chars, finite convex corners and angles in -180..180.
pub fn check_planes(planes: &[VPlane]) -> Result<(), String> {
    let bad = |what: String| Err(format!("Vanishing Point: {what}"));
    if planes.len() > MAX_PLANES {
        return bad(format!("at most {MAX_PLANES} planes"));
    }
    let mut ids = std::collections::HashSet::new();
    for p in planes {
        let id_ok = |s: &str| !s.is_empty() && s.chars().count() <= 32;
        if !id_ok(&p.id) || p.parent_id.as_deref().is_some_and(|s| !id_ok(s)) {
            return bad("plane ids must be 1 to 32 characters".into());
        }
        if !ids.insert(p.id.as_str()) {
            return bad(format!("duplicate plane id {}", p.id));
        }
        if !convex(p.corners) {
            return bad(format!("plane {} must be convex with finite corners", p.id));
        }
        if p.angle_degrees.is_some_and(|a| !(-180.0..=180.0).contains(&a)) {
            return bad("angles must be in -180..=180".into());
        }
    }
    Ok(())
}

impl State {
    pub fn parse(v: &Value) -> Result<State, String> {
        let s: State = serde_json::from_value(v.clone()).map_err(|e| format!("Vanishing Point: invalid state: {e}"))?;
        check_planes(&s.planes)?;
        let bad = |what: &str| Err(format!("Vanishing Point: {what}"));
        if s.stamps.len() > MAX_DABS {
            return bad("at most 50000 dabs");
        }
        if !(2..=40).contains(&s.grid_size) || !(0.0..=100.0).contains(&s.brush_hardness) || !(1.0..=100.0).contains(&s.brush_opacity) {
            return bad("grid size 2..=40, brush hardness 0..=100 and opacity 1..=100");
        }
        for d in &s.stamps {
            if !d.from.iter().chain(&d.to).all(|v| v.is_finite()) || !(d.radius.is_finite() && d.radius > 0.0) {
                return bad("dabs need finite points and a positive radius");
            }
            if !(0.0..=1.0).contains(&d.opacity) || !(0.0..=1.0).contains(&d.hardness) {
                return bad("dab opacity and hardness must be in 0..=1");
            }
            if d.plane_id.as_ref().is_some_and(|id| !s.planes.iter().any(|p| &p.id == id)) {
                return bad("a dab names an unknown plane");
            }
        }
        Ok(s)
    }
}

/// The schema check of a `state` param: parsed and written back in canonical form.
pub fn check(v: &Value) -> Result<Value, String> {
    serde_json::to_value(State::parse(v)?).map_err(|e| e.to_string())
}

/// Plane corners after the affine document map `m` (row-major 3x3). A plane a downscale would
/// make non-convex keeps its corners, so the saved state still loads.
pub fn remap_planes(planes: &mut [VPlane], m: &[f64; 9]) {
    for p in planes {
        let c = p.corners.map(|c| [m[0] * c[0] + m[1] * c[1] + m[2], m[3] * c[0] + m[4] * c[1] + m[5]]);
        if crate::pwarp::convex(c) {
            p.corners = c;
        }
    }
}

/// A `state` param after the affine document map `m`; dabs stay in UV.
pub fn remapped(v: &Value, m: &[f64; 9]) -> Result<Value, String> {
    let mut s = State::parse(v)?;
    remap_planes(&mut s.planes, m);
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// A plane hinged on `edge` of `parent`, folded by `angle` degrees: offset = (away.x len cos,
/// away.y len cos - len sin) with len a quarter of the parent's smaller bounding side.
pub fn connected(parent: &VPlane, edge: Edge, angle: f64, id: String) -> VPlane {
    let c = parent.corners;
    let (k, o) = match edge {
        Edge::Top => (0, 2),
        Edge::Right => (1, 3),
        Edge::Bottom => (2, 0),
        Edge::Left => (3, 1),
    };
    let (a, b, oa, ob) = (c[k], c[(k + 1) % 4], c[o], c[(o + 1) % 4]);
    let (dx, dy) = ((a[0] + b[0] - oa[0] - ob[0]) / 2.0, (a[1] + b[1] - oa[1] - ob[1]) / 2.0);
    let n = dx.hypot(dy).max(1e-12);
    let (xs, ys) = (c.map(|p| p[0]), c.map(|p| p[1]));
    let span = |v: [f64; 4]| v.iter().cloned().fold(f64::NEG_INFINITY, f64::max) - v.iter().cloned().fold(f64::INFINITY, f64::min);
    let len = span(xs).min(span(ys)) / 4.0;
    let (sin, cos) = angle.to_radians().sin_cos();
    let off = [dx / n * len * cos, dy / n * len * cos - len * sin];
    let add = |p: [f64; 2]| [p[0] + off[0], p[1] + off[1]];
    VPlane { id, corners: [a, b, add(b), add(a)], parent_id: Some(parent.id.clone()), hinge_edge: Some(edge), angle_degrees: Some(angle) }
}

// Plane px per document px `s`: each plane's UV -> plane px homography and its inverse.
fn maps(planes: &[VPlane], s: f64) -> Vec<Option<([f64; 9], [f64; 9])>> {
    planes
        .iter()
        .map(|p| {
            let h = homography(UNIT, p.corners.map(|c| [c[0] * s, c[1] * s]))?;
            Some((h, invert(&h)?))
        })
        .collect()
}

// Bilinear premultiplied RGBA of `src` (w x h) at array coords (x, y), clamped to the edge.
fn bilinear(src: &[f32], w: usize, h: usize, x: f64, y: f64) -> [f32; 4] {
    let (x, y) = (x.clamp(0.0, (w - 1) as f64), y.clamp(0.0, (h - 1) as f64));
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
    let at = |i: usize, j: usize, c: usize| src[(j * w + i) * 4 + c];
    std::array::from_fn(|c| {
        let top = at(x0, y0, c) + (at(x1, y0, c) - at(x0, y0, c)) * fx;
        let bot = at(x0, y1, c) + (at(x1, y1, c) - at(x0, y1, c)) * fx;
        top + (bot - top) * fy
    })
}

/// Paints every dab onto `p` (straight RGBA, `s` plane px per document px), each sampling the
/// plane as it was before any dab.
pub fn render(st: &State, p: &mut Plane, s: f64) {
    if st.stamps.is_empty() || p.w == 0 || p.h == 0 {
        return;
    }
    let maps = maps(&st.planes, s);
    p.premultiply();
    let src = p.data.clone();
    let (w, h) = (p.w, p.h);
    for d in &st.stamps {
        let Some((fwd, inv)) = plane_of(st, d).and_then(|k| maps[k]) else { continue };
        let (u0, v0, u1, v1) = ((d.to[0] - d.radius).max(0.0), (d.to[1] - d.radius).max(0.0), (d.to[0] + d.radius).min(1.0), (d.to[1] + d.radius).min(1.0));
        if u0 > u1 || v0 > v1 {
            continue;
        }
        let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
        for (u, v) in [(u0, v0), (u1, v0), (u1, v1), (u0, v1)] {
            let (x, y) = map(&fwd, u, v);
            bb = [bb[0].min(x), bb[1].min(y), bb[2].max(x), bb[3].max(y)];
        }
        if !bb.iter().all(|v| v.is_finite()) {
            continue;
        }
        let span = |lo: f64, hi: f64, o: i32, n: usize| ((lo - o as f64).floor().clamp(0.0, n as f64) as usize, (hi - o as f64).ceil().clamp(0.0, n as f64) as usize);
        let ((i0, i1), (j0, j1)) = (span(bb[0], bb[2], p.x, w), span(bb[1], bb[3], p.y, h));
        let soft = (1.0 - d.hardness).max(0.001);
        for j in j0..j1 {
            for i in i0..i1 {
                let (x, y) = (p.x as f64 + i as f64 + 0.5, p.y as f64 + j as f64 + 0.5);
                let (u, v) = map(&inv, x, y);
                if !((0.0..=1.0).contains(&u) && (0.0..=1.0).contains(&v)) {
                    continue;
                }
                let r = (u - d.to[0]).hypot(v - d.to[1]);
                if r > d.radius {
                    continue;
                }
                let a = if d.hardness >= 1.0 { 1.0 } else { ((1.0 - r / d.radius) / soft).clamp(0.0, 1.0) } * d.opacity;
                let (sx, sy) = map(&fwd, u + d.from[0] - d.to[0], v + d.from[1] - d.to[1]);
                if a <= 0.0 || !sx.is_finite() || !sy.is_finite() {
                    continue;
                }
                let c = bilinear(&src, w, h, sx - p.x as f64 - 0.5, sy - p.y as f64 - 0.5).map(|c| c * a as f32);
                let o = (j * w + i) * 4;
                for n in 0..4 {
                    p.data[o + n] = c[n] + p.data[o + n] * (1.0 - c[3]);
                }
            }
        }
    }
    p.unpremultiply();
}

/// The registry entry `vanishing_point`; neutral without dabs.
pub fn apply(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    render(&State::parse(f.params.get("state").unwrap_or(&Value::Null))?, p, ctx.scale);
    Ok(())
}

// The plane a dab paints in: its own, else the first (every plane holds UV in 0..1).
fn plane_of(st: &State, d: &Dab) -> Option<usize> {
    match &d.plane_id {
        Some(id) => st.planes.iter().position(|q| &q.id == id),
        None => (d.to.iter().all(|v| (0.0..=1.0).contains(v)) && !st.planes.is_empty()).then_some(0),
    }
}

/// Dabs paint only inside planes: `r` grown by every plane's bounding box, kept inside i32. Each
/// dab's source box also counts, clamped into `r` grown by 1 px: outside `r` the content is empty, so
/// an edge-clamped read there must land on that empty border.
pub fn extent(f: &Filter, r: [i32; 4]) -> Result<[i32; 4], String> {
    let s = State::parse(f.params.get("state").unwrap_or(&Value::Null))?;
    let lim = (1i64 << 29) as f64;
    let (mut x0, mut y0, mut x1, mut y1) = (r[0], r[1], r[0] + r[2], r[1] + r[3]);
    for c in s.planes.iter().filter(|_| !s.stamps.is_empty()).flat_map(|p| p.corners) {
        let (x, y) = (c[0].clamp(-lim, lim), c[1].clamp(-lim, lim));
        (x0, y0, x1, y1) = (x0.min(x.floor() as i32), y0.min(y.floor() as i32), x1.max(x.ceil() as i32), y1.max(y.ceil() as i32));
    }
    let maps = maps(&s.planes, 1.0);
    let border = [r[0] as f64 - 1.0, r[1] as f64 - 1.0, (r[0] + r[2]) as f64 + 1.0, (r[1] + r[3]) as f64 + 1.0];
    for d in &s.stamps {
        let Some((fwd, _)) = plane_of(&s, d).and_then(|k| maps[k]) else { continue };
        let (u, v, q) = (d.from[0], d.from[1], d.radius);
        let pts = [(u - q, v - q), (u + q, v - q), (u + q, v + q), (u - q, v + q)].map(|(a, b)| map(&fwd, a, b));
        if !pts.iter().all(|(x, y)| x.is_finite() && y.is_finite()) {
            continue;
        }
        let fold = |f: fn(f64, f64) -> f64, k: usize| pts.iter().map(|p| if k == 0 { p.0 } else { p.1 }).reduce(f).expect("4 points");
        let (cx, cy) = (|v: f64| v.clamp(border[0], border[2]), |v: f64| v.clamp(border[1], border[3]));
        let b = [cx(fold(f64::min, 0)), cy(fold(f64::min, 1)), cx(fold(f64::max, 0)), cy(fold(f64::max, 1))];
        (x0, y0, x1, y1) = (x0.min(b[0].floor() as i32), y0.min(b[1].floor() as i32), x1.max(b[2].ceil() as i32), y1.max(b[3].ceil() as i32));
    }
    Ok([x0, y0, x1 - x0, y1 - y0])
}
