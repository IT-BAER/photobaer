//! Perspective Warp (docs/M5.md section 10): quads drawn in Layout mode map to their Warp mode
//! corners by one homography each; the registry entry `perspective_warp` (param `state`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::filters::{Ctx, Filter, Plane};
use crate::resample::{Interp, Plane as RPlane, Resampler};

const HORIZON: &str = "The perspective crosses the image horizon. Move the corners closer to the original plane.";
const INFINITE: &str = "The perspective extends beyond a finite image. Move the corners closer to the original plane.";
const MAX_QUADS: usize = 64;

/// Vertices in document px (shared by the quads that list them) and quads as 4 vertex indices.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct State {
    pub layout: Vec<[f64; 2]>,
    pub current: Vec<[f64; 2]>,
    pub quads: Vec<[usize; 4]>,
}

/// The quad's 4 corners turn the same way and no 3 are collinear.
pub fn convex(q: [[f64; 2]; 4]) -> bool {
    let mut sign = 0.0;
    for e in 0..4 {
        let (n, i, o) = (q[e], q[(e + 1) % 4], q[(e + 2) % 4]);
        let s = (i[0] - n[0]) * (o[1] - i[1]) - (i[1] - n[1]) * (o[0] - i[0]);
        // Degenerate by angle (relative to the edge lengths), so a uniform scale keeps the verdict.
        let len = (i[0] - n[0]).hypot(i[1] - n[1]) * (o[0] - i[0]).hypot(o[1] - i[1]);
        if !s.is_finite() || s.abs() <= 1e-9 * len || (sign != 0.0 && s.signum() != sign) {
            return false;
        }
        sign = s.signum();
    }
    true
}

impl State {
    pub fn parse(v: &Value) -> Result<State, String> {
        let s: State = serde_json::from_value(v.clone()).map_err(|e| format!("Perspective Warp: invalid state: {e}"))?;
        let n = s.layout.len();
        let bad = |what: &str| Err(format!("Perspective Warp: {what}"));
        if s.quads.is_empty() || s.quads.len() > MAX_QUADS || s.current.len() != n {
            return bad("1 to 64 quads and as many current as layout vertices");
        }
        if !s.layout.iter().chain(&s.current).flatten().all(|v| v.is_finite()) {
            return bad("vertices must be finite");
        }
        for q in &s.quads {
            if q.iter().any(|i| *i >= n) || (0..4).any(|a| (a + 1..4).any(|b| q[a] == q[b])) {
                return bad("a quad needs 4 distinct vertex indices");
            }
            if !convex(q.map(|i| s.layout[i])) || !convex(q.map(|i| s.current[i])) {
                return bad("every quad must stay convex");
            }
        }
        Ok(s)
    }

    pub fn identity(&self) -> bool {
        self.layout == self.current
    }

    fn corners(v: &[[f64; 2]], q: &[usize; 4]) -> [[f64; 2]; 4] {
        q.map(|i| v[i])
    }
}

/// The schema check of a `state` param: parsed and written back in canonical form.
pub fn check(v: &Value) -> Result<Value, String> {
    serde_json::to_value(State::parse(v)?).map_err(|e| e.to_string())
}

/// A state after the affine document map `m` (row-major 3x3).
pub fn remapped(v: &Value, m: &[f64; 9]) -> Result<Value, String> {
    let mut s = State::parse(v)?;
    for p in s.layout.iter_mut().chain(s.current.iter_mut()) {
        *p = [m[0] * p[0] + m[1] * p[1] + m[2], m[3] * p[0] + m[4] * p[1] + m[5]];
    }
    serde_json::to_value(s).map_err(|e| e.to_string())
}

/// The homography (row-major 3x3, h22 = 1) mapping `src` corners onto `dst` corners.
pub fn homography(src: [[f64; 2]; 4], dst: [[f64; 2]; 4]) -> Option<[f64; 9]> {
    let mut a = [[0.0f64; 9]; 8];
    for k in 0..4 {
        let ([x, y], [u, v]) = (src[k], dst[k]);
        a[2 * k] = [x, y, 1.0, 0.0, 0.0, 0.0, -x * u, -y * u, u];
        a[2 * k + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -x * v, -y * v, v];
    }
    // Gaussian elimination with partial pivoting.
    for c in 0..8 {
        let p = (c..8).fold(c, |m, r| if a[r][c].abs() > a[m][c].abs() { r } else { m });
        if a[p][c].abs() < 1e-14 {
            return None;
        }
        a.swap(c, p);
        for r in c + 1..8 {
            let f = a[r][c] / a[c][c];
            if f != 0.0 {
                for k in c..9 {
                    a[r][k] -= f * a[c][k];
                }
            }
        }
    }
    let mut h = [0.0; 9];
    for r in (0..8).rev() {
        let mut s = a[r][8];
        for k in r + 1..8 {
            s -= a[r][k] * h[k];
        }
        h[r] = s / a[r][r];
    }
    h[8] = 1.0;
    Some(h)
}

pub(crate) fn invert(m: &[f64; 9]) -> Option<[f64; 9]> {
    let [a, b, c, d, e, f, g, h, i] = *m;
    let (r, s, t) = (e * i - f * h, f * g - d * i, d * h - e * g);
    let det = a * r + b * s + c * t;
    if det == 0.0 || !det.is_finite() {
        return None;
    }
    let q = 1.0 / det;
    Some([r * q, (c * h - b * i) * q, (b * f - c * e) * q, s * q, (a * i - c * g) * q, (c * d - a * f) * q, t * q, (b * g - a * h) * q, (a * e - b * d) * q])
}

pub fn map(h: &[f64; 9], x: f64, y: f64) -> (f64, f64) {
    let w = h[6] * x + h[7] * y + h[8];
    if w == 0.0 { (f64::INFINITY, f64::INFINITY) } else { ((h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w) }
}

// sqrt |det J| of `h` at (x, y): source px per dest px of an inverse map.
fn minification(h: &[f64; 9], x: f64, y: f64) -> f64 {
    let n = h[6] * x + h[7] * y + h[8];
    if n == 0.0 {
        return 1.0;
    }
    let (i, o, s) = (h[0] * x + h[1] * y + h[2], h[3] * x + h[4] * y + h[5], 1.0 / n);
    let r = s * s;
    let j = [h[0] * s - i * h[6] * r, h[3] * s - o * h[6] * r, h[1] * s - i * h[7] * r, h[4] * s - o * h[7] * r];
    (j[0] * j[3] - j[1] * j[2]).abs().sqrt()
}

// One quad: its warped corners and the inverse homography back to the layout.
struct Quad {
    corners: [[f64; 2]; 4],
    inverse: [f64; 9],
}

fn in_triangle(t: [[f64; 2]; 3], x: f64, y: f64) -> bool {
    let c = |a: [f64; 2], b: [f64; 2]| (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    let (d0, d1, d2) = (c(t[0], t[1]), c(t[1], t[2]), c(t[2], t[0]));
    (d0 >= 0.0 && d1 >= 0.0 && d2 >= 0.0) || (d0 <= 0.0 && d1 <= 0.0 && d2 <= 0.0)
}

// 0 inside the quad, else the squared distance to its nearest edge.
fn distance(q: &[[f64; 2]; 4], x: f64, y: f64) -> f64 {
    if in_triangle([q[0], q[1], q[2]], x, y) || in_triangle([q[0], q[2], q[3]], x, y) {
        return 0.0;
    }
    let mut best = f64::INFINITY;
    for i in 0..4 {
        let (o, s) = (q[i], q[(i + 1) % 4]);
        let (r, t) = (s[0] - o[0], s[1] - o[1]);
        let c = (((x - o[0]) * r + (y - o[1]) * t) / (r * r + t * t)).clamp(0.0, 1.0);
        best = best.min((x - o[0] - c * r).powi(2) + (y - o[1] - c * t).powi(2));
    }
    best
}

// The forward homography of every quad, layout -> current.
fn forwards(s: &State) -> Result<Vec<[f64; 9]>, String> {
    s.quads.iter().map(|q| homography(State::corners(&s.layout, q), State::corners(&s.current, q)).ok_or_else(|| INFINITE.to_string())).collect()
}

// The rect every quad's homography takes source rect `r` to, refused across the horizon or past 1e8 px.
fn reach(s: &State, r: [i32; 4]) -> Result<[i32; 4], String> {
    let (x0, y0, x1, y1) = (r[0] as f64, r[1] as f64, (r[0] + r[2]) as f64, (r[1] + r[3]) as f64);
    let mut bb = [f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY];
    for h in forwards(s)? {
        let corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)];
        let w: Vec<f64> = corners.iter().map(|(x, y)| h[6] * x + h[7] * y + h[8]).collect();
        if w.iter().any(|v| v.abs() < 1e-8 || v.signum() != w[0].signum()) {
            return Err(HORIZON.into());
        }
        for (x, y) in corners {
            let (u, v) = map(&h, x, y);
            bb = [bb[0].min(u), bb[1].min(v), bb[2].max(u), bb[3].max(v)];
        }
    }
    let (w, h) = (bb[2] - bb[0], bb[3] - bb[1]);
    // Coordinates stay well inside i32 so the rect arithmetic downstream cannot overflow.
    if !bb.iter().all(|v| v.abs() < (1u64 << 29) as f64) || w * h > 1e8 {
        return Err(INFINITE.into());
    }
    let (fx, fy) = (bb[0].floor(), bb[1].floor());
    Ok([fx as i32, fy as i32, (bb[2].ceil() - fx) as i32, (bb[3].ceil() - fy) as i32])
}

/// The document rect a source within `r` can cover after the warp: `r` and its warped rect.
pub fn extent(f: &Filter, r: [i32; 4]) -> Result<[i32; 4], String> {
    let s = State::parse(f.params.get("state").unwrap_or(&Value::Null))?;
    if s.identity() {
        return Ok(r);
    }
    let o = reach(&s, r)?;
    let (x0, y0) = (r[0].min(o[0]), r[1].min(o[1]));
    Ok([x0, y0, (r[0] + r[2]).max(o[0] + o[2]) - x0, (r[1] + r[3]).max(o[1] + o[3]) - y0])
}

/// The registry entry `perspective_warp`: every plane pixel reads the source through the inverse
/// homography of the quad holding it (or the nearest quad). Source rect: `ctx.bounds`.
pub fn apply(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let st = State::parse(f.params.get("state").unwrap_or(&Value::Null))?;
    if st.identity() || p.w == 0 || p.h == 0 {
        return Ok(());
    }
    reach(&st, ctx.bounds)?;
    let quads: Vec<Quad> = st
        .quads
        .iter()
        .zip(forwards(&st)?)
        .map(|(q, h)| invert(&h).map(|inverse| Quad { corners: State::corners(&st.current, q), inverse }).ok_or_else(|| INFINITE.to_string()))
        .collect::<Result<_, _>>()?;
    let s = ctx.scale;
    let mut most: f64 = 0.0;
    for q in &quads {
        for c in q.corners {
            most = most.max(minification(&q.inverse, c[0], c[1]));
        }
    }
    let mut src = Plane { data: p.data.clone(), ..*p };
    src.premultiply();
    let rs = Resampler::pyramid(RPlane { x: p.x, y: p.y, w: p.w, h: p.h, ch: 4, sx: 1.0, sy: 1.0, data: src.data }, Interp::Bicubic, 0.0, most);
    p.data.fill(0.0);
    for j in 0..p.h {
        for i in 0..p.w {
            // Document point of the plane pixel centre.
            let (x, y) = ((p.x as f64 + i as f64 + 0.5) / s, (p.y as f64 + j as f64 + 0.5) / s);
            let (mut q, mut best) = (&quads[0], f64::INFINITY);
            for c in &quads {
                let d = distance(&c.corners, x, y);
                if d < best {
                    (q, best) = (c, d);
                }
                if d == 0.0 {
                    break;
                }
            }
            let (u, v) = map(&q.inverse, x, y);
            if u.is_finite() && v.is_finite() {
                let o = (j * p.w + i) * 4;
                rs.sample_point(u * s, v * s, minification(&q.inverse, x, y), &mut p.data[o..o + 4]);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_homography_maps_each_corner_onto_its_target() {
        let src = [[16.0, 12.0], [48.0, 12.0], [48.0, 36.0], [16.0, 36.0]];
        let dst = [[16.0, 12.0], [48.0, 12.0], [56.0, 44.0], [16.0, 36.0]];
        let h = homography(src, dst).unwrap();
        for (a, b) in src.iter().zip(dst) {
            let (u, v) = map(&h, a[0], a[1]);
            assert!((u - b[0]).abs() < 1e-9 && (v - b[1]).abs() < 1e-9, "{a:?} -> {u},{v}");
        }
        let i = invert(&h).unwrap();
        let (x, y) = map(&i, 56.0, 44.0);
        assert!((x - 48.0).abs() < 1e-9 && (y - 36.0).abs() < 1e-9);
    }

    #[test]
    fn convexity_rejects_bow_ties_and_dents() {
        assert!(convex([[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]]));
        assert!(!convex([[0.0, 0.0], [10.0, 10.0], [10.0, 0.0], [0.0, 10.0]]));
        assert!(!convex([[0.0, 0.0], [10.0, 0.0], [2.0, 2.0], [0.0, 10.0]]));
        assert!(!convex([[0.0, 0.0], [5.0, 0.0], [10.0, 0.0], [0.0, 10.0]]), "3 collinear corners");
    }

    #[test]
    fn a_strong_downscale_still_maps_the_quads() {
        let q = [[0.0, 0.0], [5.0, 0.0], [5.0, 5.0], [0.0, 5.0]];
        let v = serde_json::json!({ "layout": q, "current": q, "quads": [[0, 1, 2, 3]] });
        let out = remapped(&v, &[1e-4, 0.0, 0.0, 0.0, 1e-4, 0.0, 0.0, 0.0, 1.0]).unwrap();
        assert_eq!(out["layout"][2], serde_json::json!([5e-4, 5e-4]));
        assert!(State::parse(&out).is_ok(), "the mapped state renders");
        let mut planes = vec![crate::vanishing::VPlane { id: "p".into(), corners: q, parent_id: None, hinge_edge: None, angle_degrees: None }];
        crate::vanishing::remap_planes(&mut planes, &[1e-4, 0.0, 0.0, 0.0, 1e-4, 0.0, 0.0, 0.0, 1.0]);
        assert_eq!(planes[0].corners[2], [5e-4, 5e-4], "vanishing planes follow too");
    }

    #[test]
    fn points_outside_every_quad_use_the_nearest() {
        let q = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        assert_eq!(distance(&q, 5.0, 5.0), 0.0);
        assert_eq!(distance(&q, 13.0, 5.0), 9.0);
    }
}
