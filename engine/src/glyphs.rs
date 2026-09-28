//! Type rendering (docs/M4.md section 9): glyph outlines as flattened polygons in document px
//! (faux bold and italic, underline and strikethrough, warp, transform), the layer's `cache`
//! tiles per anti-alias mode, and the outline ops (Create Work Path, Convert to Shape, hit test).
//! A child module of `doc`.

use super::*;
use crate::content::SolidFill;
use crate::font::Registry;
use crate::geom;
use crate::path::{FillRule, PathOp, Subpath, VectorPath};
use crate::text::{AntiAlias, Orientation, TextData, TextShape, TextWarp, WarpStyle};
use crate::typeset::{self, Layout};
use rustybuzz::ttf_parser::{GlyphId, OutlineBuilder};

const FAUX_ITALIC_DEG: f64 = 12.0;
/// Faux bold stroke in em; typeset widens the advance by the same amount.
pub(crate) const FAUX_BOLD: f64 = 0.024;
const WARP_STEP: f64 = 4.0;
const HIT_TOLERANCE: f64 = 2.0;
const LIMIT: &str = "The type layer exceeds the rendering limit.";
const MAX_AREA: f64 = 1e8;
/// Flattening refinement cap; bounds outline size under huge transform scales.
const MAX_DETAIL: f64 = 64.0;

pub(crate) type Poly = Vec<[f64; 2]>;

/// A type layer's outline: polygons grouped by color in first-appearance order.
pub struct Outline {
    pub groups: Vec<([u8; 3], VectorPath)>,
    pub aa: AntiAlias,
}

impl Outline {
    /// All groups as one path (Create Work Path, Convert to Shape, hit test).
    pub fn path(&self) -> VectorPath {
        VectorPath { fill_rule: FillRule::Nonzero, subpaths: self.groups.iter().flat_map(|g| g.1.subpaths.clone()).collect() }
    }
}

enum Cmd {
    Move([f64; 2]),
    Line([f64; 2]),
    Cubic([f64; 2], [f64; 2], [f64; 2]),
    Close,
}

#[derive(Default)]
struct Builder(Vec<Cmd>, [f64; 2]);

impl OutlineBuilder for Builder {
    fn move_to(&mut self, x: f32, y: f32) {
        self.1 = [x as f64, y as f64];
        self.0.push(Cmd::Move(self.1));
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.1 = [x as f64, y as f64];
        self.0.push(Cmd::Line(self.1));
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        let (p0, q, p) = (self.1, [x1 as f64, y1 as f64], [x as f64, y as f64]);
        let c = |a: [f64; 2]| [a[0] + (q[0] - a[0]) * 2.0 / 3.0, a[1] + (q[1] - a[1]) * 2.0 / 3.0];
        self.1 = p;
        self.0.push(Cmd::Cubic(c(p0), c(p), p));
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.1 = [x as f64, y as f64];
        self.0.push(Cmd::Cubic([x1 as f64, y1 as f64], [x2 as f64, y2 as f64], self.1));
    }
    fn close(&mut self) {
        self.0.push(Cmd::Close);
    }
}

fn end(c: &Cmd) -> [f64; 2] {
    match c {
        Cmd::Move(p) | Cmd::Line(p) | Cmd::Cubic(_, _, p) => *p,
        Cmd::Close => [0.0; 2],
    }
}

/// Moves each contour point by `e / 2` along the outward normal of the chord between its
/// neighbours; a curve's handles move with its end point.
fn embolden(cmds: &mut [Cmd], e: f64) {
    let mut contours: Vec<Vec<usize>> = vec![];
    for (i, c) in cmds.iter().enumerate() {
        match c {
            Cmd::Move(_) => contours.push(vec![i]),
            Cmd::Close => contours.push(vec![]),
            _ => match contours.last_mut() {
                Some(c) => c.push(i),
                None => contours.push(vec![i]),
            },
        }
    }
    let area = |pts: &[[f64; 2]]| -> f64 {
        let n = pts.len();
        (0..n).map(|i| pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]).sum()
    };
    let pts_of = |idx: &[usize], cmds: &[Cmd]| -> Vec<[f64; 2]> { idx.iter().map(|&i| end(&cmds[i])).collect() };
    // One orientation per glyph (outer contours dominate), so holes shrink while the outside grows.
    let total: f64 = contours.iter().map(|c| area(&pts_of(c, cmds))).sum();
    let s = if total >= 0.0 { 1.0 } else { -1.0 };
    for idx in contours.iter().filter(|c| c.len() >= 2) {
        let pts = pts_of(idx, cmds);
        let n = pts.len();
        for a in 0..n {
            let (p, q) = (pts[(a + n - 1) % n], pts[(a + 1) % n]);
            let (c, h) = (q[0] - p[0], q[1] - p[1]);
            let l = c.hypot(h);
            if l == 0.0 {
                continue;
            }
            let d = [h / l * s * e / 2.0, -c / l * s * e / 2.0];
            let mv = |p: &mut [f64; 2]| *p = [p[0] + d[0], p[1] + d[1]];
            match &mut cmds[idx[a]] {
                Cmd::Move(p) | Cmd::Line(p) => mv(p),
                Cmd::Cubic(c1, c2, p) => {
                    mv(c1);
                    mv(c2);
                    mv(p);
                }
                Cmd::Close => {}
            }
        }
    }
}

fn skew(cmds: &mut [Cmd]) {
    let t = FAUX_ITALIC_DEG.to_radians().tan();
    let sk = |p: &mut [f64; 2]| p[0] += p[1] * t;
    for c in cmds {
        match c {
            Cmd::Move(p) | Cmd::Line(p) => sk(p),
            Cmd::Cubic(c1, c2, p) => {
                sk(c1);
                sk(c2);
                sk(p);
            }
            Cmd::Close => {}
        }
    }
}

/// Flattens font-unit commands through `map` (font units to text px) at FLATNESS / `q`.
fn flatten_cmds(cmds: &[Cmd], map: impl Fn([f64; 2]) -> [f64; 2], q: f64, out: &mut Vec<Poly>) {
    let mut subs: Vec<Vec<crate::path::Point>> = vec![];
    for c in cmds {
        let m = |p: [f64; 2]| {
            let p = map(p);
            [p[0] * q, p[1] * q]
        };
        match c {
            Cmd::Move(p) => {
                let p = m(*p);
                subs.push(vec![[p[0], p[1], p[0], p[1], p[0], p[1]]]);
            }
            Cmd::Line(p) => {
                let p = m(*p);
                if let Some(s) = subs.last_mut() {
                    s.push([p[0], p[1], p[0], p[1], p[0], p[1]]);
                }
            }
            Cmd::Cubic(c1, c2, p) => {
                let (c1, c2, p) = (m(*c1), m(*c2), m(*p));
                if let Some(s) = subs.last_mut() {
                    let last = s.last_mut().expect("a subpath starts with its move");
                    (last[4], last[5]) = (c1[0], c1[1]);
                    s.push([p[0], p[1], c2[0], c2[1], p[0], p[1]]);
                }
            }
            Cmd::Close => {}
        }
    }
    for points in subs {
        let mut f = geom::flatten(&Subpath { closed: true, op: PathOp::Combine, points });
        f.dedup();
        if f.len() > 1 && f.first() == f.last() {
            f.pop();
        }
        if f.len() >= 2 {
            out.push(f.into_iter().map(|p| [p[0] / q, p[1] / q]).collect());
        }
    }
}

/// One glyph's flattened outline polygons in `map`'s output space (the Glyphs panel cells reuse
/// this instead of a layout run, so no `Registry` face cache or run color is involved).
pub(crate) fn glyph_polys(face: &ttf_parser::Face, gid: GlyphId, map: impl Fn([f64; 2]) -> [f64; 2], q: f64) -> Vec<Poly> {
    let mut b = Builder::default();
    if face.outline_glyph(gid, &mut b).is_none() {
        return vec![];
    }
    let mut polys = vec![];
    flatten_cmds(&b.0, map, q, &mut polys);
    polys
}

/// The power of two at or above the transform's largest scale (at least 1).
fn detail(m: &[f64; 6]) -> f64 {
    let [a, b, c, d, ..] = *m;
    let n = a * a + b * b + c * c + d * d;
    let s = ((n + (n * n - 4.0 * (a * d - b * c).powi(2)).max(0.0).sqrt()) / 2.0).sqrt().max(1.0);
    2f64.powf(s.log2().ceil())
}

/// Unwarped layout bounds `[x, y, w, h]`: line boxes, or glyph boxes for path text.
fn layout_bounds(l: &Layout, vertical: bool, on_path: bool) -> [f64; 4] {
    let (mut x0, mut y0, mut x1, mut y1) = (f64::INFINITY, f64::INFINITY, f64::NEG_INFINITY, f64::NEG_INFINITY);
    for ln in &l.lines {
        if on_path {
            for g in &l.glyphs[ln.glyphs.clone()] {
                (x0, x1) = (x0.min(g.x - ln.ascent), x1.max(g.x + g.advance + ln.ascent));
                (y0, y1) = (y0.min(g.y - ln.ascent), y1.max(g.y + ln.descent));
            }
        } else if vertical {
            (x0, x1) = (x0.min(ln.x - ln.ascent), x1.max(ln.x + ln.descent));
            (y0, y1) = (y0.min(ln.y), y1.max(ln.y + ln.width));
        } else {
            (x0, x1) = (x0.min(ln.x), x1.max(ln.x + ln.width));
            (y0, y1) = (y0.min(ln.y - ln.ascent), y1.max(ln.y + ln.descent));
        }
    }
    if x0 == f64::INFINITY {
        [0.0; 4]
    } else {
        [x0, y0, x1 - x0, y1 - y0]
    }
}

fn warp_active(w: &TextWarp) -> bool {
    w.bend != 0.0 || w.horizontal != 0.0 || w.vertical != 0.0
}

/// Maps a text-space point through the warp over bounds `b = [x, y, w, h]` (section 9 formulas).
pub(crate) fn warp_point(w: &TextWarp, b: [f64; 4], p: [f64; 2]) -> [f64; 2] {
    let [bx, by, bw, bh] = b;
    let (u, v) = ((p[0] - bx) / bw, (p[1] - by) / bh);
    let (mut x, mut y) = (u * 2.0 - 1.0, v * 2.0 - 1.0);
    if w.horizontal != 0.0 {
        y *= 1.0 + w.horizontal * x;
    }
    if w.vertical != 0.0 {
        x *= 1.0 + w.vertical * y;
    }
    let (r, hw, hh) = (w.bend, bw / 2.0, bh / 2.0);
    let arc = -r * hh * (1.0 - x * x);
    let wave = -r * hh * (u * std::f64::consts::TAU).sin();
    let (dx, dy) = match w.style {
        WarpStyle::Arc => (0.0, arc),
        WarpStyle::ArcLower => (0.0, arc * v),
        WarpStyle::ArcUpper => (0.0, arc * (1.0 - v)),
        WarpStyle::Arch => (0.0, arc * (0.5 + 0.5 * v)),
        WarpStyle::Bulge => (0.0, y * hh * r * (1.0 - x * x)),
        WarpStyle::ShellLower => (-r * x * hw * 0.3 * v, arc * v),
        WarpStyle::ShellUpper => (-r * x * hw * 0.3 * (1.0 - v), arc * (1.0 - v)),
        WarpStyle::Flag => (0.0, wave),
        WarpStyle::Wave => (0.0, wave * (1.0 - 2.0 * v)),
        WarpStyle::Fish => (0.0, -y * hh * r * x * x),
        WarpStyle::Rise => (0.0, -r * hh * x),
        WarpStyle::Fisheye => {
            let e = 1.0 + r * (1.0 - x.hypot(y).min(1.0).powi(2));
            (x * (e - 1.0) * hw, y * (e - 1.0) * hh)
        }
        WarpStyle::Inflate => (x * r * (1.0 - y * y) * hw, y * r * (1.0 - x * x) * hh),
        WarpStyle::Squeeze => (-x * r * (1.0 - y * y) * hw, -y * r * (1.0 - x * x) * hh),
        WarpStyle::Twist => {
            let (s, c) = (r * std::f64::consts::PI * x.hypot(y).min(1.0)).sin_cos();
            let (qx, qy) = (x * hw, y * hh);
            (qx * c - qy * s - qx, qx * s + qy * c - qy)
        }
    };
    [bx + (x + 1.0) * hw + dx, by + (y + 1.0) * hh + dy]
}

/// Splits every edge longer than WARP_STEP into equal pieces of at most that length.
fn subdivide(p: &Poly) -> Poly {
    let n = p.len();
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let (a, b) = (p[i], p[(i + 1) % n]);
        out.push(a);
        let k = ((b[0] - a[0]).hypot(b[1] - a[1]) / WARP_STEP).floor() as usize;
        for j in 1..k {
            let t = j as f64 / k as f64;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    out
}

/// Underline and strikethrough rectangles per run segment of each line, with their run colors.
fn decorations(t: &TextData, l: &Layout, faces: &mut FaceCache, vertical: bool) -> Vec<([u8; 3], Poly)> {
    let mut out = vec![];
    for ln in &l.lines {
        let gs = &l.glyphs[ln.glyphs.clone()];
        let mut i = 0;
        while i < gs.len() {
            let run = gs[i].run;
            let j = i + gs[i..].iter().take_while(|g| g.run == run).count();
            let r = &t.runs[run as usize];
            if r.underline || r.strikethrough {
                let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
                for g in &gs[i..j] {
                    let a = if vertical { g.y } else { g.x };
                    (lo, hi) = (lo.min(a), hi.max(a + g.advance));
                }
                let metrics = faces.get(gs[i].face).map(|f| {
                    let em = f.units_per_em() as f64;
                    let m = |lm: Option<rustybuzz::ttf_parser::LineMetrics>, d: (f64, f64)| {
                        lm.map_or(d, |m| (m.position as f64 / em, m.thickness as f64 / em))
                    };
                    (m(f.underline_metrics(), (-0.1, 0.05)), m(f.strikeout_metrics(), (0.25, 0.05)))
                });
                let ((up, ut), (sp, st)) = metrics.unwrap_or(((-0.1, 0.05), (0.25, 0.05)));
                let size = gs[i].size;
                let base = if vertical { ln.x } else { ln.y };
                let mut rect = |pos: f64, thick: f64| {
                    let (o, h) = (base - pos * size, (thick * size).max(1.0) / 2.0);
                    let poly = if vertical {
                        vec![[o - h, lo], [o + h, lo], [o + h, hi], [o - h, hi]]
                    } else {
                        vec![[lo, o - h], [hi, o - h], [hi, o + h], [lo, o + h]]
                    };
                    out.push((r.color, poly));
                };
                if hi > lo {
                    if r.underline {
                        rect(up, ut);
                    }
                    if r.strikethrough {
                        rect(sp, st);
                    }
                }
            }
            i = j;
        }
    }
    out
}

struct FaceCache<'a> {
    reg: &'a Registry,
    faces: HashMap<u32, Option<rustybuzz::Face<'a>>>,
}

impl<'a> FaceCache<'a> {
    fn get(&mut self, id: u32) -> Option<&rustybuzz::Face<'a>> {
        let reg = self.reg;
        self.faces.entry(id).or_insert_with(|| reg.data(id).and_then(|(d, i)| rustybuzz::Face::from_slice(d, i))).as_ref()
    }
}

/// Lays out and outlines a type layer at `resolution` ppi, in document px.
pub fn outline(t: &TextData, reg: &Registry, resolution: f64) -> Outline {
    let aa = t.runs.first().map_or(AntiAlias::Sharp, |r| r.anti_alias);
    let l = typeset::layout(t, reg, resolution);
    let vertical = t.orientation == Orientation::Vertical;
    let on_path = matches!(t.shape, TextShape::OnPath { .. });
    let q = detail(&t.transform).min(MAX_DETAIL);
    let mut faces = FaceCache { reg, faces: HashMap::new() };
    let mut groups: Vec<([u8; 3], Vec<Poly>)> = vec![];
    let mut add = |color: [u8; 3], polys: Vec<Poly>| match groups.iter_mut().find(|g| g.0 == color) {
        Some(g) => g.1.extend(polys),
        None => groups.push((color, polys)),
    };
    for g in &l.glyphs {
        let Some(face) = faces.get(g.face) else { continue };
        let mut b = Builder::default();
        if face.outline_glyph(GlyphId(g.glyph), &mut b).is_none() {
            continue;
        }
        let r = &t.runs[g.run as usize];
        let em = face.units_per_em() as f64;
        if r.faux_bold {
            embolden(&mut b.0, em * FAUX_BOLD);
        }
        if r.faux_italic {
            skew(&mut b.0);
        }
        let k = g.size / em;
        let (sx, sy) = (k * g.scale[0], k * g.scale[1]);
        let (s, c) = g.rotation.to_radians().sin_cos();
        let mut polys = vec![];
        flatten_cmds(
            &b.0,
            |p| {
                let (x, y) = (p[0] * sx, -p[1] * sy);
                [g.x + x * c - y * s, g.y + x * s + y * c]
            },
            q,
            &mut polys,
        );
        add(r.color, polys);
    }
    if !on_path {
        for (color, poly) in decorations(t, &l, &mut faces, vertical) {
            add(color, vec![poly]);
        }
    }
    let bounds = layout_bounds(&l, vertical, on_path);
    let warp = t.warp.as_ref().filter(|w| warp_active(w) && bounds[2] > 0.0 && bounds[3] > 0.0);
    let [a, b, c, d, e, f] = t.transform;
    let groups = groups
        .into_iter()
        .map(|(color, polys)| {
            let subpaths = polys
                .into_iter()
                .map(|p| {
                    let p = match warp {
                        Some(w) => subdivide(&p).into_iter().map(|p| warp_point(w, bounds, p)).collect(),
                        None => p,
                    };
                    let points = p
                        .into_iter()
                        .map(|[x, y]| {
                            let (x, y) = (a * x + c * y + e, b * x + d * y + f);
                            [x, y, x, y, x, y]
                        })
                        .collect();
                    Subpath { closed: true, op: PathOp::Combine, points }
                })
                .collect();
            (color, VectorPath { fill_rule: FillRule::Nonzero, subpaths })
        })
        .collect();
    Outline { groups, aa }
}

/// (gamma, contrast, stem darkening, blur sigma) per anti-alias mode; none is binary.
fn aa_params(aa: AntiAlias) -> (f32, f32, f32, f32) {
    match aa {
        AntiAlias::None => (1.0, 1.0, 0.0, 0.0),
        AntiAlias::Sharp => (0.85, 1.35, 0.0, 0.0),
        AntiAlias::Crisp => (0.7, 1.75, 0.05, 0.0),
        AntiAlias::Strong => (0.55, 1.15, 0.16, 0.0),
        AntiAlias::Smooth => (1.1, 1.0, 0.02, 0.35),
    }
}

/// The mode's coverage curve (after any blur): 0 stays 0, the rest is clamped to 0..1.
pub(crate) fn aa_curve(c: f32, aa: AntiAlias) -> f32 {
    let (gamma, contrast, stem, _) = aa_params(aa);
    if c <= 0.0 {
        return 0.0;
    }
    let c = c.min(1.0).powf(gamma);
    (((c - 0.5) * contrast + 0.5) * (1.0 + stem)).clamp(0.0, 1.0)
}

/// Normalized Gaussian of `sigma`, radius max(1, ceil(3 sigma)).
fn kernel(sigma: f32) -> Vec<f32> {
    let r = (sigma * 3.0).ceil().max(1.0) as i32;
    let k: Vec<f32> = (-r..=r).map(|i| (-((i * i) as f32) / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = k.iter().sum();
    k.into_iter().map(|v| v / sum).collect()
}

/// Separable blur of a w x h plane, edges clamped.
fn blur(v: &[f32], w: usize, h: usize, k: &[f32]) -> Vec<f32> {
    let r = (k.len() / 2) as i64;
    let pass = |src: &[f32], horiz: bool| {
        let mut out = vec![0f32; w * h];
        for y in 0..h {
            for x in 0..w {
                out[y * w + x] = k
                    .iter()
                    .enumerate()
                    .map(|(i, kv)| {
                        let o = i as i64 - r;
                        let (sx, sy) = if horiz {
                            ((x as i64 + o).clamp(0, w as i64 - 1) as usize, y)
                        } else {
                            (x, (y as i64 + o).clamp(0, h as i64 - 1) as usize)
                        };
                        kv * src[sy * w + sx]
                    })
                    .sum();
            }
        }
        out
    };
    pass(&pass(v, true), false)
}

impl Document {
    fn text_data(&self, id: u32) -> Result<&TextData, String> {
        let n = self.node(id)?;
        match &n.kind {
            Kind::Text(t) => Ok(&t.data),
            _ => Err(format!("node {id} is a {} layer, not a type layer", n.kind_name())),
        }
    }

    /// Replaces a type layer's model (TextData JSON); the cache is dropped until the next render.
    pub fn set_text(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let data: TextData = serde_json::from_str(json).map_err(|e| format!("invalid text: {e}"))?;
        data.validate()?;
        self.text_data(id)?;
        let Kind::Text(t) = &mut self.node_mut(id)?.kind else { unreachable!("checked above") };
        **t = Text { data, cache: None };
        Ok(())
    }

    /// Renders a type layer's `cache` at `resolution` ppi: each color group's coverage through the
    /// first run's anti-alias mode, composited over the previous groups, on the outline bounds + 1 px.
    pub fn render_text(&mut self, id: u32, reg: &Registry, resolution: f64) -> Result<(), String> {
        self.check_idle()?;
        let o = outline(self.text_data(id)?, reg, resolution);
        let tiles = self.text_tiles(&o)?;
        let Kind::Text(t) = &mut self.node_mut(id)?.kind else { unreachable!("checked by text_data") };
        t.cache = Some(tiles);
        Ok(())
    }

    fn text_tiles(&mut self, o: &Outline) -> Result<Tiles, String> {
        let mut tiles = Tiles::default();
        let Some([l, t, r, b]) = geom::bounds(&o.path()) else { return Ok(tiles) };
        let (x0, y0, x1, y1) = (l.floor() as i64 - 1, t.floor() as i64 - 1, r.ceil() as i64 + 1, b.ceil() as i64 + 1);
        if ((x1 - x0) as f64) * ((y1 - y0) as f64) > MAX_AREA {
            return Err(LIMIT.into());
        }
        let (gamma_etc, binary) = (aa_params(o.aa), o.aa == AntiAlias::None);
        let k = (gamma_etc.3 > 0.0).then(|| kernel(gamma_etc.3));
        let pad = k.as_ref().map_or(0, |k| k.len() / 2);
        let (tw, pw) = (TILE as i64, TILE + 2 * pad);
        let rgbs: Vec<[f32; 3]> = o.groups.iter().map(|g| g.0.map(|v| v as f32 / 255.0)).collect();
        for ty in y0.div_euclid(tw)..=(y1 - 1).div_euclid(tw) {
            for tx in x0.div_euclid(tw)..=(x1 - 1).div_euclid(tw) {
                let (ox, oy) = (tx * tw, ty * tw);
                let mut out = vec![0f32; TILE_PIXELS * 4];
                for ((_, path), rgb) in o.groups.iter().zip(&rgbs) {
                    let (wx, wy) = ((ox - pad as i64) as i32, (oy - pad as i64) as i32);
                    let m = if binary { geom::fill_mask_binary(path, wx, wy, pw, pw) } else { geom::fill_mask(path, wx, wy, pw, pw) };
                    if m.iter().all(|&v| v == 0) {
                        continue;
                    }
                    let mut cov: Vec<f32> = m.into_iter().map(|v| v as f32 / 255.0).collect();
                    if let Some(k) = &k {
                        cov = blur(&cov, pw, pw, k);
                    }
                    for y in 0..TILE {
                        let gy = oy + y as i64;
                        for x in 0..TILE {
                            let gx = ox + x as i64;
                            if gx < x0 || gx >= x1 || gy < y0 || gy >= y1 {
                                continue;
                            }
                            let c = cov[(y + pad) * pw + x + pad];
                            let m = if binary { c } else { aa_curve(c, o.aa) };
                            if m <= 0.0 {
                                continue;
                            }
                            let p = &mut out[(y * TILE + x) * 4..(y * TILE + x) * 4 + 4];
                            let k = p[3];
                            let a = m + k * (1.0 - m);
                            for ch in 0..3 {
                                p[ch] = (rgb[ch] * m + p[ch] * k * (1.0 - m)) / a;
                            }
                            p[3] = a;
                        }
                    }
                }
                let px = Pixels::from_straight(self.depth, &out);
                if px.any_alpha() {
                    let id = self.alloc_tile_id();
                    tiles.put(tx as i32, ty as i32, Some(Tile { id, px: Arc::new(px) }));
                }
            }
        }
        Ok(tiles)
    }

    fn text_outline_path(&self, id: u32, reg: &Registry, resolution: f64) -> Result<VectorPath, String> {
        let p = outline(self.text_data(id)?, reg, resolution).path();
        if p.subpaths.is_empty() {
            return Err("This type layer has no outline.".into());
        }
        Ok(p)
    }

    /// "Create Work Path" from a type layer: its outline replaces the work path. Returns its id.
    pub fn text_work_path(&mut self, id: u32, reg: &Registry, resolution: f64) -> Result<u32, String> {
        self.check_idle()?;
        let p = self.text_outline_path(id, reg, resolution)?;
        Ok(self.put_work_path(p))
    }

    /// "Convert to Shape": the type layer becomes a shape layer in place (same id, name and layer
    /// settings, locks cleared) filled with the first run's color.
    pub fn convert_text_to_shape(&mut self, id: u32, reg: &Registry, resolution: f64) -> Result<(), String> {
        self.check_idle()?;
        let path = self.text_outline_path(id, reg, resolution)?;
        let color = self.text_data(id)?.runs.first().map_or([0; 3], |r| r.color);
        let node = self.node_mut(id)?;
        node.kind = Kind::Shape(Box::new(ShapeData { path, live: None, fill: Some(FillContent::Solid(SolidFill { color })), stroke: None }));
        node.locks = Locks::default();
        Ok(())
    }

    /// The edit session's layout in text space (before `transform`): lines with their UTF-16 span
    /// and glyphs as [cluster, x, y, advance], for caret and selection math.
    pub fn text_layout(&self, id: u32, reg: &Registry, resolution: f64) -> Result<String, String> {
        let t = self.text_data(id)?;
        let l = typeset::layout(t, reg, resolution);
        let lines: Vec<_> = l
            .lines
            .iter()
            .map(|n| {
                let glyphs: Vec<_> = l.glyphs[n.glyphs.clone()].iter().map(|g| [g.cluster as f64, g.x, g.y, g.advance]).collect();
                serde_json::json!({ "x": n.x, "y": n.y, "width": n.width, "ascent": n.ascent, "descent": n.descent,
                    "start": n.start, "end": n.end, "glyphs": glyphs })
            })
            .collect();
        Ok(serde_json::json!({ "transform": t.transform, "overflow": l.overflow, "lines": lines }).to_string())
    }

    /// Type Mask commit: the outline's anti-aliased coverage becomes the selection per `mode`.
    pub fn select_text(&mut self, id: u32, reg: &Registry, resolution: f64, mode: Mode) -> Result<(), String> {
        self.check_idle()?;
        let p = self.text_outline_path(id, reg, resolution)?;
        let (w, h) = (self.width as usize, self.height as usize);
        let cov = geom::fill_mask(&p, 0, 0, w, h).into_iter().map(|v| v as f32 / 255.0).collect();
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), mode)
    }

    /// Whether document point (x, y) is within 2 px of the type layer's outline or inside it.
    pub fn text_hit(&self, id: u32, reg: &Registry, resolution: f64, x: f64, y: f64) -> Result<bool, String> {
        let p = outline(self.text_data(id)?, reg, resolution).path();
        Ok(geom::hit(&p, x, y, HIT_TOLERANCE))
    }
}

#[cfg(test)]
#[path = "glyphs_tests.rs"]
mod tests;
