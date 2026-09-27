//! Vector geometry (docs/M4.md section 2): flatten, fill coverage, stroke outline, dashes, bounds,
//! hit test, boolean ops, live shape generators and mask tracing. Pure functions, f64 document px.
// Library surface for the compositor and the shape/path tools; not every item has a caller yet.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::ops::{Add, Mul, Neg, Sub};

pub use crate::path::{Bounds, Cap, FillRule, Join, Live, PathOp, Point, StrokeAlign, Subpath, VectorPath};

// ---- 2D vector ----

#[derive(Clone, Copy, Debug, PartialEq)]
struct V {
    x: f64,
    y: f64,
}

const fn v(x: f64, y: f64) -> V {
    V { x, y }
}

impl Add for V {
    type Output = V;
    fn add(self, o: V) -> V {
        v(self.x + o.x, self.y + o.y)
    }
}
impl Sub for V {
    type Output = V;
    fn sub(self, o: V) -> V {
        v(self.x - o.x, self.y - o.y)
    }
}
impl Mul<f64> for V {
    type Output = V;
    fn mul(self, k: f64) -> V {
        v(self.x * k, self.y * k)
    }
}
impl Neg for V {
    type Output = V;
    fn neg(self) -> V {
        v(-self.x, -self.y)
    }
}
impl V {
    fn dot(self, o: V) -> f64 {
        self.x * o.x + self.y * o.y
    }
    fn cross(self, o: V) -> f64 {
        self.x * o.y - self.y * o.x
    }
    fn len(self) -> f64 {
        self.x.hypot(self.y)
    }
    /// Unit vector; the zero vector stays zero.
    fn norm(self) -> V {
        let l = self.len();
        if l > 0.0 { self * (1.0 / l) } else { self }
    }
    fn perp(self) -> V {
        v(-self.y, self.x)
    }
}

fn seg_dist(p: V, a: V, b: V) -> f64 {
    let d = b - a;
    let l2 = d.dot(d);
    let t = if l2 > 0.0 { ((p - a).dot(d) / l2).clamp(0.0, 1.0) } else { 0.0 };
    (p - (a + d * t)).len()
}

fn signed_area(p: &[V]) -> f64 {
    (0..p.len()).map(|i| p[i].cross(p[(i + 1) % p.len()])).sum::<f64>() / 2.0
}

fn corner(p: V) -> Point {
    [p.x, p.y, p.x, p.y, p.x, p.y]
}

// ---- flatten ----

/// Max distance of the flattened polyline from the curve, px.
pub const FLATNESS: f64 = 0.05;

fn segs(s: &Subpath) -> Vec<[V; 4]> {
    let n = s.points.len();
    let m = if s.closed && n > 1 { n } else { n.saturating_sub(1) };
    (0..m)
        .map(|i| {
            let (a, b) = (&s.points[i], &s.points[(i + 1) % n]);
            [v(a[0], a[1]), v(a[4], a[5]), v(b[2], b[3]), v(b[0], b[1])]
        })
        .collect()
}

fn split_cubic(c: [V; 4], t: f64) -> ([V; 4], [V; 4]) {
    let l = |a: V, b: V| a + (b - a) * t;
    let (ab, bc, cd) = (l(c[0], c[1]), l(c[1], c[2]), l(c[2], c[3]));
    let (abc, bcd) = (l(ab, bc), l(bc, cd));
    let m = l(abc, bcd);
    ([c[0], ab, abc, m], [m, bcd, cd, c[3]])
}

/// Pushes the flattened cubic without its start point. The control polygon bounds the curve,
/// so control points within FLATNESS of the chord keep the curve within it too.
fn flatten_cubic(c: [V; 4], out: &mut Vec<V>, depth: u32) {
    if depth >= 16 || seg_dist(c[1], c[0], c[3]).max(seg_dist(c[2], c[0], c[3])) <= FLATNESS {
        out.push(c[3]);
        return;
    }
    let (a, b) = split_cubic(c, 0.5);
    flatten_cubic(a, out, depth + 1);
    flatten_cubic(b, out, depth + 1);
}

/// Polyline of a subpath; a closed subpath does not repeat its first point.
fn flat(s: &Subpath) -> Vec<V> {
    let Some(f) = s.points.first() else { return vec![] };
    let mut out = vec![v(f[0], f[1])];
    for c in segs(s) {
        if c[1] == c[0] && c[2] == c[3] {
            out.push(c[3]);
        } else {
            flatten_cubic(c, &mut out, 0);
        }
    }
    if s.closed && out.len() > 1 && out.last() == out.first() {
        out.pop();
    }
    out
}

pub fn flatten(s: &Subpath) -> Vec<[f64; 2]> {
    flat(s).into_iter().map(|p| [p.x, p.y]).collect()
}

// ---- fill coverage ----

/// Accumulates the exact signed area of edge a->b into rows of stride w + 2 (x clamped to 0..=w).
fn edge(acc: &mut [f64], w: usize, h: usize, a: V, b: V) {
    let wf = w as f64;
    let mut ts = vec![0.0, 1.0];
    for xb in [0.0, wf] {
        if (a.x - xb) * (b.x - xb) < 0.0 {
            ts.push((xb - a.x) / (b.x - a.x));
        }
    }
    ts.sort_by(f64::total_cmp);
    let at = |t: f64| {
        let p = a + (b - a) * t;
        v(p.x.clamp(0.0, wf), p.y)
    };
    for k in 1..ts.len() {
        edge_clamped(acc, w, h, at(ts[k - 1]), at(ts[k]));
    }
}

fn edge_clamped(a: &mut [f64], w: usize, h: usize, p0: V, p1: V) {
    if p0.y == p1.y {
        return;
    }
    let (dir, p0, p1) = if p0.y < p1.y { (1.0, p0, p1) } else { (-1.0, p1, p0) };
    let dxdy = (p1.x - p0.x) / (p1.y - p0.y);
    let mut x = p0.x;
    if p0.y < 0.0 {
        x -= p0.y * dxdy;
    }
    let stride = w + 2;
    let (ys, ye) = (p0.y.max(0.0) as usize, p1.y.ceil().clamp(0.0, h as f64) as usize);
    for y in ys..ye {
        let ls = y * stride;
        let dy = ((y + 1) as f64).min(p1.y) - (y as f64).max(p0.y);
        let xnext = (x + dxdy * dy).clamp(0.0, w as f64);
        let d = dy * dir;
        let (x0, x1) = if x < xnext { (x, xnext) } else { (xnext, x) };
        let x0f = x0.floor();
        let x0i = x0f as usize;
        let x1c = x1.ceil();
        let x1i = x1c as usize;
        if x1i <= x0i + 1 {
            let xmf = 0.5 * (x + xnext) - x0f;
            a[ls + x0i] += d - d * xmf;
            a[ls + x0i + 1] += d * xmf;
        } else {
            let s = 1.0 / (x1 - x0);
            let x0r = x0 - x0f;
            let a0 = 0.5 * s * (1.0 - x0r) * (1.0 - x0r);
            let x1r = x1 - x1c + 1.0;
            let am = 0.5 * s * x1r * x1r;
            a[ls + x0i] += d * a0;
            if x1i == x0i + 2 {
                a[ls + x0i + 1] += d * (1.0 - a0 - am);
            } else {
                let a1 = s * (1.5 - x0r);
                a[ls + x0i + 1] += d * (a1 - a0);
                for xi in x0i + 2..x1i - 1 {
                    a[ls + xi] += d * s;
                }
                let a2 = a1 + (x1i - x0i - 3) as f64 * s;
                a[ls + x1i - 1] += d * (1.0 - a2 - am);
            }
            a[ls + x1i] += d * am;
        }
        x = xnext;
    }
}

/// Per pixel integral of the winding number over the pixel area (closed polygons).
fn winding_area(polys: &[Vec<V>], o: V, w: usize, h: usize) -> Vec<f64> {
    let stride = w + 2;
    let mut a = vec![0.0; stride * h];
    for p in polys {
        for i in 0..p.len() {
            edge(&mut a, w, h, p[i] - o, p[(i + 1) % p.len()] - o);
        }
    }
    let mut out = vec![0.0; w * h];
    for y in 0..h {
        let mut acc = 0.0;
        for x in 0..w {
            acc += a[y * stride + x];
            out[y * w + x] = acc;
        }
    }
    out
}

fn rule_cov(acc: f64, rule: FillRule) -> f64 {
    match rule {
        FillRule::Nonzero => acc.abs().min(1.0),
        FillRule::Evenodd => {
            let t = acc.abs() % 2.0;
            if t > 1.0 { 2.0 - t } else { t }
        }
    }
}

fn fold(op: PathOp, a: f64, b: f64) -> f64 {
    match op {
        PathOp::Combine => a + b - a * b,
        PathOp::Subtract => a * (1.0 - b),
        PathOp::Intersect => a * b,
        PathOp::Exclude => a + b - 2.0 * a * b,
    }
}

fn fold_b(op: PathOp, a: bool, b: bool) -> bool {
    match op {
        PathOp::Combine => a || b,
        PathOp::Subtract => a && !b,
        PathOp::Intersect => a && b,
        PathOp::Exclude => a != b,
    }
}

/// Consecutive combine subpaths fill together under the fill rule; any other op starts a group
/// of its own that folds onto the result in list order. The first subpath always combines.
fn groups(p: &VectorPath) -> Vec<(PathOp, Vec<Vec<V>>)> {
    let mut g: Vec<(PathOp, Vec<Vec<V>>)> = vec![];
    for (i, s) in p.subpaths.iter().enumerate() {
        let op = if i == 0 { PathOp::Combine } else { s.op };
        let f = flat(s);
        match g.last_mut() {
            Some(last) if op == PathOp::Combine && last.0 == PathOp::Combine => last.1.push(f),
            _ => g.push((op, vec![f])),
        }
    }
    g
}

fn coverage(p: &VectorPath, o: V, w: usize, h: usize) -> Vec<f64> {
    let mut out = vec![0.0; w * h];
    for (op, polys) in groups(p) {
        let c = winding_area(&polys, o, w, h);
        for (r, c) in out.iter_mut().zip(c) {
            *r = fold(op, *r, rule_cov(c, p.fill_rule));
        }
    }
    out
}

fn to8(c: &[f64]) -> Vec<u8> {
    c.iter().map(|&c| (c.clamp(0.0, 1.0) * 255.0).round() as u8).collect()
}

/// Fill coverage of the w x h pixel window at document (x0, y0), row-major, `round(c * 255)`.
pub fn fill_mask(p: &VectorPath, x0: i32, y0: i32, w: usize, h: usize) -> Vec<u8> {
    to8(&coverage(p, v(x0 as f64, y0 as f64), w, h))
}

// ---- stroke ----

fn circle(c: V, r: f64) -> Vec<V> {
    let n = if r > FLATNESS { (std::f64::consts::PI / (1.0 - FLATNESS / r).acos()).ceil().max(8.0) as usize } else { 8 };
    (0..n)
        .map(|i| {
            let a = i as f64 * std::f64::consts::TAU / n as f64;
            c + v(a.cos(), a.sin()) * r
        })
        .collect()
}

/// Square cap: the stroke extended by hw past `p` in direction `d` (unit, outward).
fn square_cap(p: V, d: V, hw: f64) -> Vec<V> {
    let n = d.perp() * hw;
    let e = p + d * hw;
    vec![p + n, e + n, e - n, p - n]
}

fn join_at(p: V, d0: V, d1: V, hw: f64, join: Join, miter: f64, out: &mut Vec<Vec<V>>) {
    let (cross, dot) = (d0.cross(d1), d0.dot(d1));
    if cross.abs() < 1e-12 {
        if dot < 0.0 && join == Join::Round {
            out.push(circle(p, hw));
        }
        return;
    }
    let s = if cross > 0.0 { -1.0 } else { 1.0 };
    let (n0, n1) = (d0.perp() * s, d1.perp() * s);
    let (a, b) = (p + n0 * hw, p + n1 * hw);
    // Joins between flattened curve pieces turn a few degrees: a miter is exact there.
    let join = if dot > 10f64.to_radians().cos() { Join::Miter } else { join };
    match join {
        Join::Round => out.push(circle(p, hw)),
        Join::Bevel => out.push(vec![p, a, b]),
        Join::Miter => {
            let m = (n0 + n1).norm();
            let cos_half = m.dot(n0);
            if cos_half > 0.0 && 1.0 / cos_half <= miter {
                out.push(vec![p, a, p + m * (hw / cos_half), b]);
            } else {
                out.push(vec![p, a, b]);
            }
        }
    }
}

/// Stroke outline pieces (segment quads, joins, caps); their nonzero union is the stroke.
fn outline(lines: &[(Vec<V>, bool)], hw: f64, cap: Cap, join: Join, miter: f64) -> Vec<Vec<V>> {
    let mut out = vec![];
    for (pts, closed) in lines {
        let mut p: Vec<V> = vec![];
        for &q in pts {
            if p.last().is_none_or(|&l| (q - l).len() > 1e-9) {
                p.push(q);
            }
        }
        if *closed && p.len() > 1 && (p[0] - p[p.len() - 1]).len() <= 1e-9 {
            p.pop();
        }
        let n = p.len();
        if n == 1 {
            match cap {
                Cap::Round => out.push(circle(p[0], hw)),
                Cap::Square => out.push([v(-hw, -hw), v(hw, -hw), v(hw, hw), v(-hw, hw)].map(|d| p[0] + d).to_vec()),
                Cap::Butt => {}
            }
            continue;
        }
        if n == 0 {
            continue;
        }
        let m = if *closed { n } else { n - 1 };
        let dir = |i: usize| (p[(i + 1) % n] - p[i]).norm();
        for i in 0..m {
            let (a, b, nn) = (p[i], p[(i + 1) % n], dir(i).perp() * hw);
            out.push(vec![a + nn, b + nn, b - nn, a - nn]);
        }
        let joints = if *closed { 0..n } else { 1..n - 1 };
        for i in joints {
            let prev = if *closed { (i + n - 1) % n } else { i - 1 };
            join_at(p[i], dir(prev), dir(i), hw, join, miter, &mut out);
        }
        if !*closed {
            for (q, d) in [(p[0], -dir(0)), (p[n - 1], dir(n - 2))] {
                match cap {
                    Cap::Round => out.push(circle(q, hw)),
                    Cap::Square => out.push(square_cap(q, d, hw)),
                    Cap::Butt => {}
                }
            }
        }
    }
    for q in &mut out {
        if signed_area(q) < 0.0 {
            q.reverse();
        }
    }
    out
}

/// Splits a polyline into dashes (open polylines) along its arc length; the pattern repeats
/// from `offset`. An odd-length pattern is used twice; an unusable pattern leaves it whole.
fn dashes(pts: &[V], closed: bool, dash: &[f64], offset: f64) -> Vec<(Vec<V>, bool)> {
    let total: f64 = dash.iter().sum();
    if pts.len() < 2 || dash.iter().any(|d| !(*d >= 0.0)) || !(total > 0.0) || !total.is_finite() {
        return vec![(pts.to_vec(), closed)];
    }
    let pat: Vec<f64> = if dash.len() % 2 == 1 { dash.iter().chain(dash).copied().collect() } else { dash.to_vec() };
    let total = total * (pat.len() / dash.len()) as f64;
    let mut phase = offset.rem_euclid(total);
    let mut i = 0;
    while phase >= pat[i] && phase > 0.0 {
        phase -= pat[i];
        i = (i + 1) % pat.len();
    }
    let mut rem = pat[i] - phase;
    let starts_on = i % 2 == 0;
    let (mut out, mut cur): (Vec<Vec<V>>, Vec<V>) = (vec![], vec![]);
    if starts_on {
        cur.push(pts[0]);
    }
    let n = pts.len();
    let m = if closed { n } else { n - 1 };
    for k in 0..m {
        let (a, b) = (pts[k], pts[(k + 1) % n]);
        let len = (b - a).len();
        let mut t = 0.0;
        while len - t > rem {
            t += rem;
            let q = a + (b - a) * (t / len);
            if i % 2 == 0 {
                cur.push(q);
                out.push(std::mem::take(&mut cur));
            } else {
                cur = vec![q];
            }
            i = (i + 1) % pat.len();
            rem = pat[i];
        }
        rem -= len - t;
        if i % 2 == 0 {
            cur.push(b);
        }
    }
    if i % 2 == 0 && cur.len() > 1 {
        if closed && starts_on && !out.is_empty() {
            let first = out.remove(0);
            cur.extend(first.into_iter().skip(1));
        }
        out.push(cur);
    }
    out.into_iter().map(|d| (d, false)).collect()
}

/// Stroke coverage of the w x h window at (x0, y0). Center strokes straddle the path; inside
/// and outside strokes of closed subpaths are the 2w stroke masked by (1 minus) the fill.
#[allow(clippy::too_many_arguments)]
pub fn stroke_mask(
    p: &VectorPath,
    width: f64,
    align: StrokeAlign,
    cap: Cap,
    join: Join,
    miter_limit: f64,
    dash: &[f64],
    dash_offset: f64,
    x0: i32,
    y0: i32,
    w: usize,
    h: usize,
) -> Vec<u8> {
    let o = v(x0 as f64, y0 as f64);
    if !(width > 0.0) || !width.is_finite() {
        return vec![0; w * h];
    }
    let aligned = align != StrokeAlign::Center;
    let (mut center, mut doubled) = (vec![], vec![]);
    for s in &p.subpaths {
        let target = if aligned && s.closed { &mut doubled } else { &mut center };
        target.extend(dashes(&flat(s), s.closed, dash, dash_offset));
    }
    let nonzero = |lines: &[(Vec<V>, bool)], hw: f64| -> Vec<f64> {
        winding_area(&outline(lines, hw, cap, join, miter_limit), o, w, h).into_iter().map(|a| a.abs().min(1.0)).collect()
    };
    let mut c = nonzero(&center, width / 2.0);
    if !doubled.is_empty() {
        let s2 = nonzero(&doubled, width);
        let fill = coverage(p, o, w, h);
        for ((c, s), f) in c.iter_mut().zip(s2).zip(fill) {
            let s = if align == StrokeAlign::Inside { s * f } else { s * (1.0 - f) };
            *c = fold(PathOp::Combine, *c, s);
        }
    }
    to8(&c)
}

// ---- bounds and hit test ----

/// Parameters in (0, 1) where one coordinate of the cubic has a zero derivative.
fn extrema(p0: f64, p1: f64, p2: f64, p3: f64) -> Vec<f64> {
    let (a, b, c) = (-p0 + 3.0 * p1 - 3.0 * p2 + p3, 2.0 * (p0 - 2.0 * p1 + p2), p1 - p0);
    let roots = if a.abs() < 1e-12 {
        if b.abs() < 1e-12 { vec![] } else { vec![-c / b] }
    } else {
        let disc = b * b - 4.0 * a * c;
        if disc < 0.0 { vec![] } else { vec![(-b + disc.sqrt()) / (2.0 * a), (-b - disc.sqrt()) / (2.0 * a)] }
    };
    roots.into_iter().filter(|t| *t > 0.0 && *t < 1.0).collect()
}

fn bez_at(c: [V; 4], t: f64) -> V {
    let u = 1.0 - t;
    c[0] * (u * u * u) + c[1] * (3.0 * u * u * t) + c[2] * (3.0 * u * t * t) + c[3] * (t * t * t)
}

/// Exact bounds `[left, top, right, bottom]` of the curves (extrema included); None when empty.
pub fn bounds(p: &VectorPath) -> Option<Bounds> {
    let mut pts: Vec<V> = vec![];
    for s in &p.subpaths {
        pts.extend(s.points.iter().map(|q| v(q[0], q[1])));
        for c in segs(s) {
            for t in extrema(c[0].x, c[1].x, c[2].x, c[3].x).into_iter().chain(extrema(c[0].y, c[1].y, c[2].y, c[3].y)) {
                pts.push(bez_at(c, t));
            }
        }
    }
    let f = pts.first()?;
    Some(pts.iter().fold([f.x, f.y, f.x, f.y], |b, q| [b[0].min(q.x), b[1].min(q.y), b[2].max(q.x), b[3].max(q.y)]))
}

/// Signed crossing of edge a->b with the ray from q towards +x (half-open in y).
fn crossing(a: V, b: V, q: V) -> i32 {
    let c = (b - a).cross(q - a);
    if a.y <= q.y && b.y > q.y && c > 0.0 {
        1
    } else if b.y <= q.y && a.y > q.y && c < 0.0 {
        -1
    } else {
        0
    }
}

fn winding(poly: &[V], q: V) -> i32 {
    (0..poly.len()).map(|i| crossing(poly[i], poly[(i + 1) % poly.len()], q)).sum()
}

fn filled(n: i32, rule: FillRule) -> bool {
    match rule {
        FillRule::Nonzero => n != 0,
        FillRule::Evenodd => n % 2 != 0,
    }
}

fn group_inside(ops: &[PathOp], rule: FillRule, w: &[i32]) -> bool {
    ops.iter().zip(w).fold(false, |acc, (op, &n)| fold_b(*op, acc, filled(n, rule)))
}

/// True when (x, y) is inside the fill or within `tol` px of the outline.
pub fn hit(p: &VectorPath, x: f64, y: f64, tol: f64) -> bool {
    let q = v(x, y);
    for s in &p.subpaths {
        let f = flat(s);
        let m = if s.closed { f.len() } else { f.len().saturating_sub(1) };
        if f.len() == 1 && (f[0] - q).len() <= tol || (0..m).any(|i| seg_dist(q, f[i], f[(i + 1) % f.len()]) <= tol) {
            return true;
        }
    }
    let g = groups(p);
    let ops: Vec<PathOp> = g.iter().map(|g| g.0).collect();
    let w: Vec<i32> = g.iter().map(|(_, polys)| polys.iter().map(|poly| winding(poly, q)).sum()).collect();
    group_inside(&ops, p.fill_rule, &w)
}

// ---- boolean ops (own clipper on integer-scaled flattened polygons) ----

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum BoolOp {
    Unite,
    SubtractFront,
    Intersect,
    Exclude,
}

const SCALE: f64 = 1024.0;
type I = (i64, i64);

fn orient(a: I, b: I, c: I) -> i128 {
    (b.0 - a.0) as i128 * (c.1 - a.1) as i128 - (b.1 - a.1) as i128 * (c.0 - a.0) as i128
}

fn on_interior(a: I, b: I, p: I) -> bool {
    p != a && p != b && orient(a, b, p) == 0 && (a.0.min(b.0)..=a.0.max(b.0)).contains(&p.0) && (a.1.min(b.1)..=a.1.max(b.1)).contains(&p.1)
}

/// Region `inside(windings per group)` as corner-anchor loops, interior on one consistent side,
/// fill rule nonzero. Edges are split at every crossing and overlap, coincident pieces merged,
/// and a piece is kept when `inside` differs on its two sides.
// ponytail: O(n^2) pair splitting and ray casts; a sweep line when paths reach ~10k segments.
fn clip(groups: &[Vec<Vec<V>>], inside: impl Fn(&[i32]) -> bool) -> VectorPath {
    let ng = groups.len();
    let snap = |p: V| ((p.x * SCALE).round() as i64, (p.y * SCALE).round() as i64);
    let mut edges: Vec<(I, I, usize)> = vec![];
    for (g, polys) in groups.iter().enumerate() {
        for poly in polys {
            let q: Vec<I> = poly.iter().map(|&p| snap(p)).collect();
            for i in 0..q.len() {
                let (a, b) = (q[i], q[(i + 1) % q.len()]);
                if a != b {
                    edges.push((a, b, g));
                }
            }
        }
    }
    let mut cuts: Vec<Vec<I>> = edges.iter().map(|e| vec![e.0, e.1]).collect();
    for i in 0..edges.len() {
        for j in i + 1..edges.len() {
            let ((a, b, _), (c, d, _)) = (edges[i], edges[j]);
            if a.0.max(b.0) < c.0.min(d.0) || c.0.max(d.0) < a.0.min(b.0) || a.1.max(b.1) < c.1.min(d.1) || c.1.max(d.1) < a.1.min(b.1) {
                continue;
            }
            for p in [c, d] {
                if on_interior(a, b, p) {
                    cuts[i].push(p);
                }
            }
            for p in [a, b] {
                if on_interior(c, d, p) {
                    cuts[j].push(p);
                }
            }
            let (d1, d2, d3, d4) = (orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b));
            if d1.signum() * d2.signum() < 0 && d3.signum() * d4.signum() < 0 {
                let t = d3 as f64 / (d3 - d4) as f64;
                let p = ((a.0 as f64 + (b.0 - a.0) as f64 * t).round() as i64, (a.1 as f64 + (b.1 - a.1) as f64 * t).round() as i64);
                if p != a && p != b {
                    cuts[i].push(p);
                }
                if p != c && p != d {
                    cuts[j].push(p);
                }
            }
        }
    }
    let mut uniq: BTreeMap<(I, I), Vec<i32>> = BTreeMap::new();
    for ((a, b, g), cut) in edges.iter().zip(&mut cuts) {
        let dir = (b.0 - a.0, b.1 - a.1);
        cut.sort_by_key(|p| (p.0 - a.0) as i128 * dir.0 as i128 + (p.1 - a.1) as i128 * dir.1 as i128);
        cut.dedup();
        for w in cut.windows(2) {
            let (k, s) = if w[0] < w[1] { ((w[0], w[1]), 1) } else { ((w[1], w[0]), -1) };
            uniq.entry(k).or_insert_with(|| vec![0; ng])[*g] += s;
        }
    }
    uniq.retain(|_, d| d.iter().any(|&x| x != 0));
    let list: Vec<((I, I), Vec<i32>)> = uniq.into_iter().collect();
    let f = |p: I| v(p.0 as f64, p.1 as f64);
    let wind = |q: V| {
        let mut w = vec![0; ng];
        for ((a, b), d) in &list {
            let s = crossing(f(*a), f(*b), q);
            if s != 0 {
                w.iter_mut().zip(d).for_each(|(w, d)| *w += s * d);
            }
        }
        w
    };
    let mut kept: Vec<(I, I)> = vec![];
    for ((a, b), _) in &list {
        let (pa, pb) = (f(*a), f(*b));
        let mid = (pa + pb) * 0.5;
        let n = (pb - pa).norm().perp() * 1e-3;
        let (il, ir) = (inside(&wind(mid + n)), inside(&wind(mid - n)));
        if il != ir {
            kept.push(if il { (*a, *b) } else { (*b, *a) });
        }
    }
    let mut from: BTreeMap<I, Vec<usize>> = BTreeMap::new();
    for (i, e) in kept.iter().enumerate() {
        from.entry(e.0).or_default().push(i);
    }
    let mut used = vec![false; kept.len()];
    let mut subpaths = vec![];
    for s in 0..kept.len() {
        if used[s] {
            continue;
        }
        let (mut pts, mut cur) = (vec![], s);
        loop {
            used[cur] = true;
            pts.push(kept[cur].0);
            let end = kept[cur].1;
            if end == kept[s].0 {
                break;
            }
            match from.get(&end).and_then(|o| o.iter().copied().find(|&k| !used[k])) {
                Some(k) => cur = k,
                None => break,
            }
        }
        loop {
            let n = pts.len();
            let keep: Vec<I> = (0..n).filter(|&i| orient(pts[(i + n - 1) % n], pts[i], pts[(i + 1) % n]) != 0).map(|i| pts[i]).collect();
            let done = keep.len() == n || keep.len() < 3;
            pts = keep;
            if done {
                break;
            }
        }
        if pts.len() >= 3 {
            let points = pts.iter().map(|p| corner(f(*p) * (1.0 / SCALE))).collect();
            subpaths.push(Subpath { closed: true, op: PathOp::Combine, points });
        }
    }
    VectorPath { fill_rule: FillRule::Nonzero, subpaths }
}

fn parts(p: &VectorPath) -> (Vec<PathOp>, Vec<Vec<Vec<V>>>) {
    groups(p).into_iter().unzip()
}

/// `a` is the back shape, `b` the front one; result is corner anchors, fill rule nonzero.
pub fn boolean(a: &VectorPath, b: &VectorPath, op: BoolOp) -> VectorPath {
    let ((oa, mut ga), (ob, gb)) = (parts(a), parts(b));
    let na = ga.len();
    ga.extend(gb);
    clip(&ga, |w| {
        let (ia, ib) = (group_inside(&oa, a.fill_rule, &w[..na]), group_inside(&ob, b.fill_rule, &w[na..]));
        match op {
            BoolOp::Unite => ia || ib,
            BoolOp::SubtractFront => ia && !ib,
            BoolOp::Intersect => ia && ib,
            BoolOp::Exclude => ia != ib,
        }
    })
}

/// The region the path fills (subpath ops and fill rule applied) as plain combine loops.
pub fn merge_components(p: &VectorPath) -> VectorPath {
    let (ops, g) = parts(p);
    clip(&g, |w| group_inside(&ops, p.fill_rule, w))
}

// ---- live shapes ----

const KAPPA: f64 = 0.5522847498;

/// Closed subpath through `c` (clockwise on screen) with each corner rounded by its radius; the
/// tangent length is clamped to half the shorter adjacent edge.
fn rounded(c: &[V], radii: &[f64]) -> VectorPath {
    let n = c.len();
    let mut points = vec![];
    for i in 0..n {
        let (prev, p, next) = (c[(i + n - 1) % n], c[i], c[(i + 1) % n]);
        let (u0, u1) = ((prev - p).norm(), (next - p).norm());
        let phi = u0.dot(u1).clamp(-1.0, 1.0).acos();
        let r = radii[i];
        if !(r > 0.0) || phi < 1e-9 || phi > std::f64::consts::PI - 1e-9 {
            points.push(corner(p));
            continue;
        }
        let d = (r / (phi / 2.0).tan()).min((prev - p).len().min((next - p).len()) / 2.0);
        let r = d * (phi / 2.0).tan();
        let hl = 4.0 / 3.0 * ((std::f64::consts::PI - phi) / 4.0).tan() * r;
        let (a, b) = (p + u0 * d, p + u1 * d);
        let (ao, bi) = (a - u0 * hl, b - u1 * hl);
        points.push([a.x, a.y, a.x, a.y, ao.x, ao.y]);
        points.push([b.x, b.y, bi.x, bi.y, b.x, b.y]);
    }
    VectorPath { fill_rule: FillRule::Nonzero, subpaths: vec![Subpath { closed: true, op: PathOp::Combine, points }] }
}

/// Rectangle with corner radii TL, TR, BL, BR, each clamped to half the shorter side.
pub fn rect(b: Bounds, radii: [f64; 4]) -> VectorPath {
    let c = [v(b[0], b[1]), v(b[2], b[1]), v(b[2], b[3]), v(b[0], b[3])];
    rounded(&c, &[radii[0], radii[1], radii[3], radii[2]])
}

/// Four cubics from the top point, clockwise.
pub fn ellipse(b: Bounds) -> VectorPath {
    let (cx, cy, rx, ry) = ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0, (b[2] - b[0]) / 2.0 * KAPPA, (b[3] - b[1]) / 2.0 * KAPPA);
    let points = vec![
        [cx, b[1], cx - rx, b[1], cx + rx, b[1]],
        [b[2], cy, b[2], cy - ry, b[2], cy + ry],
        [cx, b[3], cx + rx, b[3], cx - rx, b[3]],
        [b[0], cy, b[0], cy + ry, b[0], cy - ry],
    ];
    VectorPath { fill_rule: FillRule::Nonzero, subpaths: vec![Subpath { closed: true, op: PathOp::Combine, points }] }
}

/// Apex at the top center, then bottom right and bottom left.
pub fn triangle(b: Bounds, radius: f64) -> VectorPath {
    rounded(&[v((b[0] + b[2]) / 2.0, b[1]), v(b[2], b[3]), v(b[0], b[3])], &[radius; 3])
}

/// Regular polygon (or star with `star_inset` > 0) on the bounds ellipse, first vertex at the top.
pub fn polygon(b: Bounds, sides: u32, star_inset: f64, radius: f64) -> VectorPath {
    let (cx, cy, rx, ry) = ((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0, (b[2] - b[0]) / 2.0, (b[3] - b[1]) / 2.0);
    let star = star_inset > 0.0;
    let m = sides.max(3) as usize * if star { 2 } else { 1 };
    let c: Vec<V> = (0..m)
        .map(|i| {
            let a = -std::f64::consts::FRAC_PI_2 + i as f64 * std::f64::consts::TAU / m as f64;
            let k = if star && i % 2 == 1 { 1.0 - star_inset } else { 1.0 };
            v(cx + rx * k * a.cos(), cy + ry * k * a.sin())
        })
        .collect();
    rounded(&c, &vec![radius; m])
}

/// Closed rectangle of `weight` along the segment.
pub fn line(x0: f64, y0: f64, x1: f64, y1: f64, weight: f64) -> VectorPath {
    let (a, b) = (v(x0, y0), v(x1, y1));
    let n = (b - a).norm().perp() * (weight / 2.0);
    rounded(&[a - n, b - n, b + n, a + n], &[0.0; 4])
}

/// Geometry of a live shape; None for kinds that carry no generator input (line, custom).
pub fn live(l: &Live) -> Option<VectorPath> {
    match *l {
        Live::Rectangle { bounds, radii } | Live::RoundedRectangle { bounds, radii } => Some(rect(bounds, radii)),
        Live::Ellipse { bounds } => Some(ellipse(bounds)),
        Live::Triangle { bounds, radius } => Some(triangle(bounds, radius)),
        Live::Polygon { bounds, sides, star_inset, radius } => Some(polygon(bounds, sides, star_inset, radius)),
        Live::Line { .. } | Live::Custom { .. } => None,
    }
}

// ---- trace (Make Work Path) ----

type Key = (u8, i64, i64);

/// Contour loops at 0.5 of a mask8 (marching squares, samples at pixel centers, zero outside).
fn march(mask: &[u8], w: usize, h: usize) -> Vec<Vec<V>> {
    let s = |x: i64, y: i64| if x >= 0 && y >= 0 && (x as usize) < w && (y as usize) < h { mask[y as usize * w + x as usize] as f64 } else { 0.0 };
    let ends = |k: Key| if k.0 == 0 { (s(k.1, k.2), s(k.1 + 1, k.2)) } else { (s(k.1, k.2), s(k.1, k.2 + 1)) };
    let point = |k: Key| {
        let (a, b) = ends(k);
        let t = (127.5 - a) / (b - a);
        if k.0 == 0 { v(k.1 as f64 + 0.5 + t, k.2 as f64 + 0.5) } else { v(k.1 as f64 + 0.5, k.2 as f64 + 0.5 + t) }
    };
    let inside = |x: f64| x > 127.5;
    let mut adj: BTreeMap<Key, Vec<Key>> = BTreeMap::new();
    let mut link = |a: Key, b: Key| {
        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    };
    for cy in -1..h as i64 {
        for cx in -1..w as i64 {
            let (top, right, bottom, left) = ((0, cx, cy), (1, cx + 1, cy), (0, cx, cy + 1), (1, cx, cy));
            let crossed: Vec<Key> = [top, right, bottom, left].into_iter().filter(|&k| {
                let (a, b) = ends(k);
                inside(a) != inside(b)
            }).collect();
            match crossed.len() {
                2 => link(crossed[0], crossed[1]),
                4 => {
                    let tl = s(cx, cy);
                    let center = (tl + s(cx + 1, cy) + s(cx, cy + 1) + s(cx + 1, cy + 1)) / 4.0;
                    if inside(center) == inside(tl) {
                        link(top, right);
                        link(bottom, left);
                    } else {
                        link(left, top);
                        link(right, bottom);
                    }
                }
                _ => {}
            }
        }
    }
    let mut seen: BTreeMap<Key, bool> = adj.keys().map(|&k| (k, false)).collect();
    let mut loops = vec![];
    for &start in adj.keys() {
        if seen[&start] {
            continue;
        }
        let (mut pts, mut prev, mut cur) = (vec![], start, start);
        loop {
            seen.insert(cur, true);
            pts.push(point(cur));
            let nb = &adj[&cur];
            let next = if nb[0] != prev { nb[0] } else { nb[1] };
            prev = cur;
            cur = next;
            if cur == start {
                break;
            }
        }
        loops.push(pts);
    }
    loops
}

/// Vertices where the direction over +-k px of arc turns more than 60 degrees (one per cluster).
fn corners(p: &[V], k: f64) -> Vec<usize> {
    let n = p.len();
    let mut cum = vec![0.0];
    for i in 0..n {
        cum.push(cum[i] + (p[(i + 1) % n] - p[i]).len());
    }
    let total = cum[n];
    if total < 4.0 * k {
        return vec![];
    }
    let at = |s: f64| {
        let s = s.rem_euclid(total);
        let i = (cum.partition_point(|&c| c <= s) - 1).min(n - 1);
        let seg = cum[i + 1] - cum[i];
        let t = if seg > 0.0 { (s - cum[i]) / seg } else { 0.0 };
        p[i] + (p[(i + 1) % n] - p[i]) * t
    };
    let turn: Vec<f64> = (0..n)
        .map(|i| {
            let (a, b) = ((p[i] - at(cum[i] - k)).norm(), (at(cum[i] + k) - p[i]).norm());
            a.dot(b).clamp(-1.0, 1.0).acos()
        })
        .collect();
    let cand = |i: usize| turn[i] > 60f64.to_radians();
    let Some(start) = (0..n).find(|&i| !cand(i)) else { return (0..n).collect() };
    let mut out = vec![];
    let mut best: Option<usize> = None;
    for j in 1..=n {
        let i = (start + j) % n;
        if cand(i) {
            best = Some(best.map_or(i, |b| if turn[i] > turn[b] { i } else { b }));
        } else if let Some(b) = best.take() {
            out.push(b);
        }
    }
    out.sort_unstable();
    out
}

fn fit_gen(p: &[V], u: &[f64], t1: V, t2: V) -> [V; 4] {
    let (p0, p3) = (p[0], p[p.len() - 1]);
    let (mut c00, mut c01, mut c11, mut x0, mut x1) = (0.0, 0.0, 0.0, 0.0, 0.0);
    for (q, &t) in p.iter().zip(u) {
        let s = 1.0 - t;
        let (b0, b1, b2, b3) = (s * s * s, 3.0 * s * s * t, 3.0 * s * t * t, t * t * t);
        let (a0, a1) = (t1 * b1, t2 * b2);
        c00 += a0.dot(a0);
        c01 += a0.dot(a1);
        c11 += a1.dot(a1);
        let tmp = *q - (p0 * (b0 + b1) + p3 * (b2 + b3));
        x0 += a0.dot(tmp);
        x1 += a1.dot(tmp);
    }
    let det = c00 * c11 - c01 * c01;
    let seg = (p3 - p0).len();
    let (mut al, mut ar) = if det.abs() > 1e-12 { ((x0 * c11 - x1 * c01) / det, (c00 * x1 - c01 * x0) / det) } else { (0.0, 0.0) };
    if al < 1e-6 * seg || ar < 1e-6 * seg {
        (al, ar) = (seg / 3.0, seg / 3.0);
    }
    [p0, p0 + t1 * al, p3 + t2 * ar, p3]
}

fn fit_err(p: &[V], b: [V; 4], u: &[f64]) -> (f64, usize) {
    (1..p.len() - 1).map(|i| ((bez_at(b, u[i]) - p[i]).dot(bez_at(b, u[i]) - p[i]), i)).fold((0.0, p.len() / 2), |m, e| if e.0 > m.0 { e } else { m })
}

fn reparam(p: &[V], u: &[f64], b: [V; 4]) -> Vec<f64> {
    let d1 = [(b[1] - b[0]) * 3.0, (b[2] - b[1]) * 3.0, (b[3] - b[2]) * 3.0];
    let d2 = [(d1[1] - d1[0]) * 2.0, (d1[2] - d1[1]) * 2.0];
    p.iter()
        .zip(u)
        .map(|(q, &t)| {
            let s = 1.0 - t;
            let q1 = d1[0] * (s * s) + d1[1] * (2.0 * s * t) + d1[2] * (t * t);
            let q2 = d2[0] * s + d2[1] * t;
            let diff = bez_at(b, t) - *q;
            let den = q1.dot(q1) + diff.dot(q2);
            if den.abs() > 1e-12 { (t - diff.dot(q1) / den).clamp(0.0, 1.0) } else { t }
        })
        .collect()
}

/// Least-squares cubic fit within `tol` px, splitting at the worst point (Schneider).
fn fit_run(p: &[V], t1: V, t2: V, tol: f64, out: &mut Vec<[V; 4]>) {
    let n = p.len();
    if n == 2 {
        let d = (p[1] - p[0]).len() / 3.0;
        out.push([p[0], p[0] + t1 * d, p[1] + t2 * d, p[1]]);
        return;
    }
    let mut cum = vec![0.0];
    for i in 1..n {
        cum.push(cum[i - 1] + (p[i] - p[i - 1]).len());
    }
    let mut u: Vec<f64> = cum.iter().map(|c| if cum[n - 1] > 0.0 { c / cum[n - 1] } else { 0.0 }).collect();
    let mut b = fit_gen(p, &u, t1, t2);
    let (mut err, mut split) = fit_err(p, b, &u);
    let tol2 = tol * tol;
    if err >= tol2 && err < 4.0 * tol2 {
        for _ in 0..4 {
            u = reparam(p, &u, b);
            b = fit_gen(p, &u, t1, t2);
            (err, split) = fit_err(p, b, &u);
            if err < tol2 {
                break;
            }
        }
    }
    if err < tol2 {
        out.push(b);
        return;
    }
    let tc = (p[split - 1] - p[split + 1]).norm();
    fit_run(&p[..=split], t1, tc, tol, out);
    fit_run(&p[split..], -tc, t2, tol, out);
}

/// Closed loop to anchors: straight runs between corners become corner segments, the rest cubics.
fn fit(p: &[V], tol: f64) -> Subpath {
    let n = p.len();
    let mut bz: Vec<[V; 4]> = vec![];
    let cs = if n < 4 { (0..n).collect() } else { corners(p, (2.0 * tol).max(2.0)) };
    if cs.is_empty() {
        let run: Vec<V> = p.iter().chain(std::iter::once(&p[0])).copied().collect();
        let t = (p[1] - p[n - 1]).norm();
        fit_run(&run, t, -t, tol, &mut bz);
    } else {
        for (j, &c) in cs.iter().enumerate() {
            let e = cs[(j + 1) % cs.len()];
            let len = if e > c { e - c } else { e + n - c };
            let run: Vec<V> = (0..=len).map(|k| p[(c + k) % n]).collect();
            let (a, b) = (run[0], run[len]);
            if run.iter().all(|&q| seg_dist(q, a, b) <= tol) {
                bz.push([a, a, b, b]);
            } else {
                fit_run(&run, (run[1] - a).norm(), (run[len - 1] - b).norm(), tol, &mut bz);
            }
        }
    }
    let m = bz.len();
    let points = (0..m)
        .map(|i| {
            let (a, o, h) = (bz[i][0], bz[i][1], bz[(i + m - 1) % m][2]);
            [a.x, a.y, h.x, h.y, o.x, o.y]
        })
        .collect();
    Subpath { closed: true, op: PathOp::Combine, points }
}

/// Work path from a mask8 selection of size w x h at document (x0, y0), fit within `tol` px.
pub fn trace(mask: &[u8], w: usize, h: usize, x0: i32, y0: i32, tol: f64) -> VectorPath {
    let o = [x0 as f64, y0 as f64];
    let subpaths = march(mask, w, h)
        .iter()
        .map(|l| {
            let mut s = fit(l, tol.max(0.01));
            for p in &mut s.points {
                for (i, c) in p.iter_mut().enumerate() {
                    *c += o[i % 2];
                }
            }
            s
        })
        .collect();
    VectorPath { fill_rule: FillRule::Evenodd, subpaths }
}

#[cfg(test)]
#[path = "geom_tests.rs"]
mod tests;
