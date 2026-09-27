//! Type layout (docs/M4.md section 9): shaping (rustybuzz), bidi, UAX #14 breaking, composers and
//! placement. Output is in text-space px; glyph origins sit on the baseline, rotation is in degrees
//! clockwise (y down). Outlines and rendering live elsewhere (glyphs.rs).
// Library surface for glyph rendering and the type tools; not every item has a caller yet.
#![allow(dead_code)]

use std::collections::{BTreeMap, HashMap};
use std::ops::Range;

use rustybuzz::ttf_parser::{GlyphId, Tag};
use rustybuzz::{Direction, Feature, UnicodeBuffer};
use unicode_bidi::{Level, ParagraphBidiInfo};
use unicode_linebreak::{linebreaks, BreakOpportunity};

use crate::font::Registry;
use crate::geom::flatten;
use crate::path::{FillRule, VectorPath};
use crate::text::{Alignment, Baseline, Caps, Composer, Kerning, Orientation, Paragraph, Run, TextData, TextShape};

#[derive(Clone, Debug, PartialEq)]
pub struct Glyph {
    pub face: u32,
    pub glyph: u16,
    /// UTF-16 offset of the glyph's cluster in `text`.
    pub cluster: u32,
    pub run: u32,
    pub x: f64,
    pub y: f64,
    /// Pen advance along the line in px (tracking included, justification not).
    pub advance: f64,
    pub rotation: f64,
    /// Effective font size in px (super/sub and small caps applied).
    pub size: f64,
    /// Horizontal and vertical scale of the outline.
    pub scale: [f64; 2],
}

/// Horizontal: `x` = line start, `y` = baseline. Vertical: `x` = column center, `y` = column start.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub ascent: f64,
    pub descent: f64,
    pub leading: f64,
    /// UTF-16 span of `text` (trailing spaces included).
    pub start: u32,
    pub end: u32,
    pub glyphs: Range<usize>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Layout {
    pub glyphs: Vec<Glyph>,
    pub lines: Vec<Line>,
    pub overflow: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Script {
    Common,
    Latin,
    Greek,
    Cyrillic,
    Hebrew,
    Arabic,
    Devanagari,
    Thai,
    Hangul,
    Kana,
    Han,
}

pub fn script(c: char) -> Script {
    use Script::*;
    let u = c as u32;
    match u {
        0x0370..=0x03FF | 0x1F00..=0x1FFF => Greek,
        0x0400..=0x052F => Cyrillic,
        0x0590..=0x05FF | 0xFB1D..=0xFB4F => Hebrew,
        0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF => Arabic,
        0x0900..=0x097F => Devanagari,
        0x0E00..=0x0E7F => Thai,
        0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF => Hangul,
        0x3040..=0x30FF | 0x31F0..=0x31FF | 0xFF66..=0xFF9F => Kana,
        0x2E80..=0x2FDF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x3FFFF => Han,
        _ if c.is_alphabetic() && (u < 0x0250 || (0x1E00..=0x1EFF).contains(&u)) => Latin,
        _ => Common,
    }
}

/// Upright in vertical text and subject to tsume: han, kana, hangul, CJK punctuation, full width forms.
fn east_asian(c: char) -> bool {
    matches!(script(c), Script::Han | Script::Kana | Script::Hangul) || matches!(c as u32, 0x3000..=0x303F | 0xFF00..=0xFF65)
}

const SUPER_SIZE: f64 = 0.583;
const SUPER_SHIFT: f64 = 0.333;
const SMALL_CAPS: f64 = 0.7;
const AUTO_LEADING: f64 = 1.2;
const EPS: f64 = 1e-9;

/// One shaped glyph in logical order; lengths in px along the line direction.
struct Sg {
    face: u32,
    glyph: u16,
    /// Global char index of the cluster.
    ci: usize,
    run: usize,
    adv: f64,
    /// Horizontal advance (vertical text centres upright glyphs with it).
    w: f64,
    dx: f64,
    dy: f64,
    size: f64,
    scale: [f64; 2],
    upright: bool,
    space: bool,
    asc: f64,
    desc: f64,
    lead: f64,
}

struct Ctx<'a> {
    t: &'a TextData,
    faces: HashMap<u32, rustybuzz::Face<'a>>,
    chars: Vec<char>,
    u16: Vec<u32>,
    run_of: Vec<usize>,
    face_of: Vec<u32>,
    px: f64,
    vertical: bool,
}

/// A paragraph's shaped glyphs with break opportunities; `k` indices are local char indices.
struct Para {
    c0: usize,
    n: usize,
    glyphs: Vec<Sg>,
    pre: Vec<f64>,
    /// (char index after the break, mandatory); the last is (n, true).
    opps: Vec<(usize, bool)>,
    /// Byte offset of each local char in the paragraph string, plus the string length.
    bytes: Vec<usize>,
}

impl Para {
    fn gi(&self, k: usize) -> usize {
        self.glyphs.partition_point(|g| g.ci < self.c0 + k)
    }
    fn trim(&self, ctx: &Ctx, a: usize, mut b: usize) -> usize {
        while b > a && ctx.chars[self.c0 + b - 1].is_whitespace() {
            b -= 1;
        }
        b
    }
    /// Natural width of chars [a, b) without trailing whitespace.
    fn width(&self, ctx: &Ctx, a: usize, b: usize) -> f64 {
        let b = self.trim(ctx, a, b);
        self.pre[self.gi(b)] - self.pre[self.gi(a)]
    }
    /// Farthest break after `a` whose line fits `m`; stops at a mandatory break.
    fn fit(&self, ctx: &Ctx, a: usize, m: f64) -> Option<usize> {
        let mut best = None;
        for &(b, mand) in self.opps.iter().filter(|o| o.0 > a) {
            if self.width(ctx, a, b) > m + EPS {
                break;
            }
            best = Some(b);
            if mand {
                break;
            }
        }
        best
    }
    fn next_opp(&self, a: usize) -> usize {
        self.opps.iter().find(|o| o.0 > a).map_or(self.n, |o| o.0)
    }
    /// Single-line composer: first fit; a segment wider than the measure gets a line of its own.
    fn greedy(&self, ctx: &Ctx, m: impl Fn(bool) -> f64) -> Vec<(usize, usize)> {
        let mut out = Vec::new();
        let mut a = 0;
        while a < self.n {
            let b = self.fit(ctx, a, m(a == 0)).unwrap_or_else(|| self.next_opp(a));
            out.push((a, b));
            a = b;
        }
        if out.is_empty() {
            out.push((0, 0));
        }
        out
    }
    /// Every-line composer: minimum sum of squared slack (last line free). Lines stay within the
    /// greedy composer's widest line, so it never produces a wider one.
    fn every_line(&self, ctx: &Ctx, m: impl Fn(bool) -> f64) -> Vec<(usize, usize)> {
        let greedy = self.greedy(ctx, &m);
        let widest = greedy.iter().map(|&(a, b)| self.width(ctx, a, b)).fold(0.0, f64::max);
        let nodes: Vec<(usize, bool)> = std::iter::once((0, false)).chain(self.opps.iter().copied()).collect();
        if self.n == 0 || nodes.len() < 2 {
            return greedy;
        }
        let last = nodes.len() - 1;
        let mut cost = vec![f64::INFINITY; nodes.len()];
        let mut from = vec![0; nodes.len()];
        cost[0] = 0.0;
        for j in 1..nodes.len() {
            for i in (0..j).rev() {
                if i + 1 < j && nodes[i + 1].1 {
                    break;
                }
                let (a, b) = (nodes[i].0, nodes[j].0);
                let meas = m(a == 0);
                let w = self.width(ctx, a, b);
                if w > meas.min(widest) + EPS && i + 1 < j {
                    break;
                }
                let c = cost[i] + if j == last { 0.0 } else { (meas - w).powi(2) };
                if c < cost[j] {
                    cost[j] = c;
                    from[j] = i;
                }
            }
        }
        let mut out = Vec::new();
        let mut j = last;
        while j > 0 {
            out.push((nodes[from[j]].0, nodes[j].0));
            j = from[j];
        }
        out.reverse();
        out
    }
}

fn px_len(v: f64, ctx: &Ctx) -> f64 {
    v * ctx.px
}

fn tag(s: &str) -> Option<Tag> {
    let b: [u8; 4] = s.as_bytes().try_into().ok()?;
    Some(Tag::from_bytes(&b))
}

fn has_feature(face: &rustybuzz::Face, t: &str) -> bool {
    tag(t).is_some_and(|t| face.tables().gsub.is_some_and(|g| g.features.find(t).is_some()))
}

/// Run features: liga/clig/calt/kern defaults, dlig, vertical forms, then the run's `features` map.
fn features(r: &Run, upright: bool) -> Vec<Feature> {
    let mut m: BTreeMap<&str, bool> = BTreeMap::new();
    m.insert("liga", r.ligatures);
    m.insert("clig", r.ligatures);
    m.insert("calt", true);
    m.insert("dlig", r.discretionary_ligatures);
    m.insert("kern", r.kerning != Kerning::None);
    if upright {
        m.insert("vert", true);
        m.insert("vrt2", true);
    }
    for (k, v) in &r.features {
        m.insert(k, *v);
    }
    m.into_iter().filter_map(|(k, v)| Some(Feature::new(tag(k)?, v as u32, ..))).collect()
}

fn run_face(reg: &Registry, r: &Run) -> Option<u32> {
    let fam = if r.family.is_empty() { reg.default_family("")? } else { r.family.clone() };
    reg.resolve(&fam, &r.style)
        .or_else(|| reg.resolve(&r.postscript_name, &r.style))
        .or_else(|| reg.resolve(&reg.default_family("")?, &r.style))
}

impl<'a> Ctx<'a> {
    fn run(&self, ci: usize) -> &'a Run {
        &self.t.runs[self.run_of[ci]]
    }

    /// Shapes chars [c0, c1) (one paragraph) into logical-order glyphs.
    fn shape(&self, c0: usize, c1: usize, level: impl Fn(usize) -> Level) -> Vec<Sg> {
        // Common chars take the script of the previous (or, at the start, the next) strong char.
        let mut scripts: Vec<Script> = (c0..c1).map(|i| script(self.chars[i])).collect();
        let mut prev = scripts.iter().copied().find(|&s| s != Script::Common).unwrap_or(Script::Common);
        for s in scripts.iter_mut() {
            if *s == Script::Common {
                *s = prev;
            } else {
                prev = *s;
            }
        }
        let key = |i: usize| {
            let r = self.run(i);
            let face = &self.faces[&self.face_of[i]];
            let smcp = r.features.get("smcp") == Some(&true) && has_feature(face, "smcp");
            let small = r.caps == Caps::Small && !smcp && self.chars[i].is_lowercase();
            (self.run_of[i], self.face_of[i], scripts[i - c0], level(i).is_rtl(), small, self.vertical && east_asian(self.chars[i]))
        };
        let mut out = Vec::new();
        let mut i = c0;
        while i < c1 {
            let k = key(i);
            let mut j = i + 1;
            while j < c1 && key(j) == k {
                j += 1;
            }
            let (run_i, face_id, _, rtl, small, upright) = k;
            let r = &self.t.runs[run_i];
            let face = &self.faces[&face_id];
            let mut buf = UnicodeBuffer::new();
            for ci in i..j {
                let c = self.chars[ci];
                if r.caps == Caps::All || small {
                    c.to_uppercase().for_each(|u| buf.add(u, ci as u32));
                } else {
                    buf.add(c, ci as u32);
                }
            }
            buf.set_direction(if rtl { Direction::RightToLeft } else { Direction::LeftToRight });
            if let Ok(lang) = r.language.parse() {
                buf.set_language(lang);
            }
            buf.guess_segment_properties();
            let shaped = rustybuzz::shape(face, &features(r, upright), buf);
            let run_px = px_len(r.size, self);
            let mut size = run_px;
            let mut dy = -px_len(r.baseline_shift, self);
            match r.baseline {
                Baseline::Super => (size, dy) = (size * SUPER_SIZE, dy - SUPER_SHIFT * run_px),
                Baseline::Sub => (size, dy) = (size * SUPER_SIZE, dy + SUPER_SHIFT * run_px),
                Baseline::Normal => {}
            }
            if small {
                size *= SMALL_CAPS;
            }
            let (hs, vs) = (r.horizontal_scale, r.vertical_scale);
            let unit = size / face.units_per_em() as f64;
            let track = r.tracking / 1000.0 * run_px;
            let lead = px_len(r.leading.unwrap_or(AUTO_LEADING * r.size), self);
            let (asc, desc) = (face.ascender() as f64 * unit * vs, -face.descender() as f64 * unit * vs);
            let mut glyphs: Vec<Sg> = shaped
                .glyph_infos()
                .iter()
                .zip(shaped.glyph_positions())
                .map(|(gi, p)| {
                    let ci = gi.cluster as usize;
                    let id = GlyphId(gi.glyph_id as u16);
                    let mut w = p.x_advance as f64 * unit * hs;
                    let mut dx = p.x_offset as f64 * unit * hs;
                    if r.tsume > 0.0 && east_asian(self.chars[ci]) {
                        let ink = face.glyph_bounding_box(id).map_or(w, |b| b.width() as f64 * unit * hs);
                        let trim = r.tsume * (w - ink).max(0.0) / 2.0;
                        dx -= trim;
                        w -= 2.0 * trim;
                    }
                    let up = self.vertical && east_asian(self.chars[ci]);
                    let along = if up { face.glyph_ver_advance(id).map_or(size, |v| v as f64 * unit) * vs } else { w };
                    Sg {
                        face: face_id,
                        glyph: id.0,
                        ci,
                        run: run_i,
                        adv: along + track,
                        w,
                        dx,
                        dy: dy - p.y_offset as f64 * unit * vs,
                        size,
                        scale: [hs, vs],
                        upright: up,
                        space: self.chars[ci].is_whitespace(),
                        asc,
                        desc,
                        lead,
                    }
                })
                .collect();
            if rtl {
                glyphs.reverse();
            }
            out.extend(glyphs);
            i = j;
        }
        out
    }

    fn para(&self, c0: usize, c1: usize, s: &str, bidi: &ParagraphBidiInfo) -> Para {
        let bytes: Vec<usize> = s.char_indices().map(|(b, _)| b).chain(std::iter::once(s.len())).collect();
        let glyphs = self.shape(c0, c1, |ci| bidi.levels[bytes[ci - c0]]);
        let mut pre = vec![0.0];
        for g in &glyphs {
            pre.push(pre.last().unwrap() + g.adv);
        }
        let n = c1 - c0;
        let mut opps: Vec<(usize, bool)> = linebreaks(s)
            .map(|(b, o)| (bytes.partition_point(|&x| x < b), o == BreakOpportunity::Mandatory))
            .filter(|&(k, m)| k > 0 && (k >= n || m || !(self.run(c0 + k - 1).no_break && self.run(c0 + k).no_break)))
            .collect();
        if opps.last().is_none_or(|o| o.0 != n) {
            opps.push((n, true));
        }
        opps.last_mut().unwrap().1 = true;
        Para { c0, n, glyphs, pre, opps, bytes }
    }
}

/// Line placement result along the inline axis: glyph index (into `Para::glyphs`) and pen offset.
struct Arranged {
    order: Vec<(usize, f64)>,
    offset: f64,
    width: f64,
}

/// Visual order, alignment offset and justified pen positions for local chars [a, b).
fn arrange(ctx: &Ctx, p: &Para, bidi: Option<&ParagraphBidiInfo>, a: usize, b: usize, m: Option<f64>, ps: &Paragraph, last: bool) -> Arranged {
    let bt = p.trim(ctx, a, b);
    let mut order: Vec<usize> = Vec::new();
    match bidi {
        Some(bidi) if bt > a => {
            let (levels, runs) = bidi.visual_runs(p.bytes[a]..p.bytes[bt]);
            for r in runs {
                let ka = p.bytes.partition_point(|&x| x < r.start);
                let kb = p.bytes.partition_point(|&x| x < r.end);
                let range = p.gi(ka)..p.gi(kb);
                if levels[r.start].is_rtl() {
                    order.extend(range.rev());
                } else {
                    order.extend(range);
                }
            }
        }
        _ => order.extend(p.gi(a)..p.gi(bt)),
    }
    let natural: f64 = order.iter().map(|&g| p.glyphs[g].adv).sum();
    use Alignment::*;
    let justify = m.is_some() && matches!(ps.alignment, JustifyLeft | JustifyCenter | JustifyRight | JustifyAll) && (!last || ps.alignment == JustifyAll);
    let (mut per_space, mut per_gap) = (0.0, 0.0);
    let mut width = natural;
    if let (true, Some(m)) = (justify, m) {
        let extra = m - natural;
        let spaces: Vec<f64> = order.iter().map(|&g| &p.glyphs[g]).filter(|g| g.space).map(|g| g.adv).collect();
        let gaps = order.len().saturating_sub(1) as f64;
        if extra > 0.0 && gaps > 0.0 {
            let ns = spaces.len() as f64;
            let space_ref = if ns > 0.0 { spaces.iter().sum::<f64>() / ns } else { 0.25 * p.glyphs[order[0]].size };
            let j = &ps.justification;
            let word = extra.min(spaces.iter().sum::<f64>() * (j.word[2] - j.word[1]).max(0.0));
            let letter = (extra - word).min(gaps * space_ref * (j.letter[2] - j.letter[1]).max(0.0));
            let rest = extra - word - letter;
            // ponytail: glyph scaling range unused; past the word/letter maxima the rest goes to spaces (or letters).
            let (word, letter) = if ns > 0.0 { (word + rest, letter) } else { (word, letter + rest) };
            per_space = if ns > 0.0 { word / ns } else { 0.0 };
            per_gap = letter / gaps;
            width = m;
        }
    }
    let base = match (m, ps.alignment) {
        _ if justify => 0.0,
        (_, Left | JustifyLeft | JustifyAll) => 0.0,
        (Some(m), Center | JustifyCenter) => (m - width) / 2.0,
        (Some(m), Right | JustifyRight) => m - width,
        (None, Center | JustifyCenter) => -width / 2.0,
        (None, Right | JustifyRight) => -width,
    };
    let mut pen = 0.0;
    let count = order.len();
    let order = order
        .into_iter()
        .enumerate()
        .map(|(i, g)| {
            let at = pen;
            let sg = &p.glyphs[g];
            pen += sg.adv + if sg.space { per_space } else { 0.0 } + if i + 1 < count { per_gap } else { 0.0 };
            (g, at)
        })
        .collect();
    Arranged { order, offset: base, width }
}

/// Line metrics over local chars [a, b): ascent, descent, leading (the largest in the line).
fn metrics(ctx: &Ctx, p: &Para, a: usize, b: usize) -> (f64, f64, f64) {
    let gs = &p.glyphs[p.gi(a)..p.gi(b)];
    if gs.is_empty() {
        let r = ctx.run((p.c0 + a).min(ctx.chars.len().saturating_sub(1)));
        let size = px_len(r.size, ctx);
        return (size * 0.8, size * 0.2, px_len(r.leading.unwrap_or(AUTO_LEADING * r.size), ctx));
    }
    gs.iter().fold((0.0, 0.0, 0.0), |(a, d, l), g| (f64::max(a, g.asc), f64::max(d, g.desc), f64::max(l, g.lead)))
}

/// Emits one line; `origin` is (line start x, baseline y) horizontally or (column x, column start y) vertically.
fn emit(ctx: &Ctx, p: &Para, a: usize, b: usize, ar: &Arranged, origin: (f64, f64), met: (f64, f64, f64), out: &mut Layout) {
    let start = out.glyphs.len();
    for &(g, pen) in &ar.order {
        let s = &p.glyphs[g];
        let (x, y, rot) = if !ctx.vertical {
            (origin.0 + ar.offset + pen + s.dx, origin.1 + s.dy, 0.0)
        } else if s.upright {
            (origin.0 - s.w / 2.0 + s.dx, origin.1 + ar.offset + pen + s.asc + s.dy, 0.0)
        } else {
            (origin.0 - (s.asc - s.desc) / 2.0 - s.dy, origin.1 + ar.offset + pen + s.dx, 90.0)
        };
        out.glyphs.push(Glyph {
            face: s.face,
            glyph: s.glyph,
            cluster: ctx.u16[s.ci],
            run: s.run as u32,
            x,
            y,
            advance: s.adv,
            rotation: rot,
            size: s.size,
            scale: s.scale,
        });
    }
    let u = |k: usize| ctx.u16.get(p.c0 + k).copied().unwrap_or_else(|| ctx.t.text.encode_utf16().count() as u32);
    let (x, y) = if ctx.vertical { (origin.0, origin.1 + ar.offset) } else { (origin.0 + ar.offset, origin.1) };
    out.lines.push(Line {
        x,
        y,
        width: ar.width,
        ascent: met.0,
        descent: met.1,
        leading: met.2,
        start: u(a),
        end: u(b),
        glyphs: start..out.glyphs.len(),
    });
}

/// Horizontal spans of the closed subpaths at `y`, fill rule honoured.
fn spans(polys: &[Vec<[f64; 2]>], rule: FillRule, y: f64) -> Vec<(f64, f64)> {
    let mut xs: Vec<(f64, i32)> = Vec::new();
    for poly in polys {
        for i in 0..poly.len() {
            let (p, q) = (poly[i], poly[(i + 1) % poly.len()]);
            if (p[1] <= y) != (q[1] <= y) {
                let x = p[0] + (y - p[1]) / (q[1] - p[1]) * (q[0] - p[0]);
                xs.push((x, if q[1] > p[1] { 1 } else { -1 }));
            }
        }
    }
    xs.sort_by(|a, b| a.0.total_cmp(&b.0));
    let inside = |w: i32| if rule == FillRule::Evenodd { w % 2 != 0 } else { w != 0 };
    let mut out: Vec<(f64, f64)> = Vec::new();
    let mut w = 0;
    for pair in xs.windows(2) {
        w += pair[0].1;
        if inside(w) && pair[1].0 > pair[0].0 {
            match out.last_mut() {
                Some(last) if (last.1 - pair[0].0).abs() < EPS => last.1 = pair[1].0,
                _ => out.push((pair[0].0, pair[1].0)),
            }
        }
    }
    out
}

/// Lays out a type layer at `resolution` ppi. An empty registry yields an empty layout.
pub fn layout(t: &TextData, reg: &Registry, resolution: f64) -> Layout {
    let mut out = Layout::default();
    let (Some(first_run), Some(first_para)) = (t.runs.first(), t.paragraphs.first()) else { return out };
    let Some(fallback) = run_face(reg, first_run) else { return out };
    let on_path = matches!(t.shape, TextShape::OnPath { .. });
    let chars: Vec<char> = t.text.chars().map(|c| if on_path && c == '\n' { ' ' } else { c }).collect();
    let mut u16s = Vec::with_capacity(chars.len());
    let mut run_of = Vec::with_capacity(chars.len());
    let (mut acc, mut ri, mut run_end) = (0u32, 0usize, first_run.length);
    for c in &chars {
        while acc >= run_end && ri + 1 < t.runs.len() {
            ri += 1;
            run_end += t.runs[ri].length;
        }
        u16s.push(acc);
        run_of.push(ri);
        acc += c.len_utf16() as u32;
    }
    let mut face_of = vec![fallback; chars.len()];
    for (ri, r) in t.runs.iter().enumerate() {
        let idx: Vec<usize> = (0..chars.len()).filter(|&i| run_of[i] == ri).collect();
        let primary = run_face(reg, r).unwrap_or(fallback);
        let s: String = idx.iter().map(|&i| chars[i]).collect();
        for (&i, f) in idx.iter().zip(reg.fallback_faces(primary, &s)) {
            face_of[i] = f.unwrap_or(primary);
        }
    }
    let mut faces = HashMap::new();
    for &id in &face_of {
        if let std::collections::hash_map::Entry::Vacant(e) = faces.entry(id) {
            let Some(f) = reg.data(id).and_then(|(d, i)| rustybuzz::Face::from_slice(d, i)) else { return out };
            e.insert(f);
        }
    }
    if faces.is_empty() {
        let Some(f) = reg.data(fallback).and_then(|(d, i)| rustybuzz::Face::from_slice(d, i)) else { return out };
        faces.insert(fallback, f);
    }
    let ctx = Ctx {
        t,
        faces,
        chars,
        u16: u16s,
        run_of,
        face_of,
        px: resolution / 72.0,
        vertical: t.orientation == Orientation::Vertical && !on_path,
    };
    // Paragraph char ranges (split on '\n') with their paragraph style.
    let mut paras: Vec<(usize, usize, &Paragraph)> = Vec::new();
    let mut c0 = 0;
    for i in 0..=ctx.chars.len() {
        if i == ctx.chars.len() || ctx.chars[i] == '\n' {
            let u = ctx.u16.get(c0).copied().unwrap_or(acc);
            let (mut end, mut style) = (0u32, first_para);
            for p in &t.paragraphs {
                style = p;
                end += p.length;
                if u < end {
                    break;
                }
            }
            paras.push((c0, i, style));
            c0 = i + 1;
        }
    }

    match &t.shape {
        TextShape::Point | TextShape::Paragraph { .. } => flow(&ctx, &paras, &t.shape, &mut out),
        TextShape::OnPath { path, start, end, flip } => {
            flow(&ctx, &paras, &TextShape::Point, &mut out);
            on_path_place(path, *start, *end, *flip, &mut out);
        }
        TextShape::InShape { path } => in_shape(&ctx, &paras, path, &mut out),
    }
    out
}

/// Point and paragraph text, horizontal or vertical.
fn flow(ctx: &Ctx, paras: &[(usize, usize, &Paragraph)], shape: &TextShape, out: &mut Layout) {
    let rect = match shape {
        TextShape::Paragraph { rect } => Some(*rect),
        _ => None,
    };
    let v = ctx.vertical;
    let mut prev: Option<f64> = None; // previous baseline (horizontal) or column x (vertical)
    for (pi, &(c0, c1, ps)) in paras.iter().enumerate() {
        let s: String = ctx.chars[c0..c1].iter().collect();
        let bidi = ParagraphBidiInfo::new(&s, ps.rtl.then(Level::rtl));
        let p = ctx.para(c0, c1, &s, &bidi);
        let (il, ir, ifirst) = (px_len(ps.indent_left, ctx), px_len(ps.indent_right, ctx), px_len(ps.indent_first, ctx));
        let extent = rect.map(|r| if v { r[3] - r[1] } else { r[2] - r[0] });
        let meas = |first: bool| extent.map_or(f64::INFINITY, |e| e - il - ir - if first { ifirst } else { 0.0 });
        let lines = if ps.composer == Composer::EveryLine && rect.is_some() { p.every_line(ctx, meas) } else { p.greedy(ctx, meas) };
        let gap = if pi > 0 { px_len(paras[pi - 1].2.space_after + ps.space_before, ctx) } else { 0.0 };
        for (li, &(a, b)) in lines.iter().enumerate() {
            let met = metrics(ctx, &p, a, b);
            let pitch = met.2 + if li == 0 { gap } else { 0.0 };
            let inset = il + if a == 0 { ifirst } else { 0.0 };
            let last = li + 1 == lines.len();
            let ar = arrange(ctx, &p, (!v).then_some(&bidi), a, b, rect.map(|_| meas(a == 0)), ps, last);
            let origin = match (v, rect) {
                (false, None) => (inset, prev.map_or(0.0, |y| y + pitch)),
                (false, Some(r)) => {
                    let y = prev.map_or(r[1] + met.0, |y| y + pitch);
                    if y - met.0 + met.2 > r[3] + EPS {
                        out.overflow = true;
                        return;
                    }
                    (r[0] + inset, y)
                }
                (true, None) => (prev.map_or(0.0, |x| x - pitch), inset),
                (true, Some(r)) => {
                    let x = prev.map_or(r[2] - met.2 / 2.0, |x| x - pitch);
                    if x - met.2 / 2.0 < r[0] - EPS {
                        out.overflow = true;
                        return;
                    }
                    (x, r[1] + inset)
                }
            };
            prev = Some(if v { origin.0 } else { origin.1 });
            emit(ctx, &p, a, b, &ar, origin, met, out);
        }
    }
}

/// Text in shape: baselines step down by the first run's leading; each span at a baseline takes
/// one line (greedy); a span too narrow for the next word is skipped.
fn in_shape(ctx: &Ctx, paras: &[(usize, usize, &Paragraph)], path: &VectorPath, out: &mut Layout) {
    let polys: Vec<Vec<[f64; 2]>> = path.subpaths.iter().filter(|s| s.closed).map(flatten).filter(|p| p.len() > 2).collect();
    let ys = polys.iter().flatten().map(|p| p[1]);
    let (top, bottom) = ys.fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), y| (a.min(y), b.max(y)));
    if polys.is_empty() {
        out.overflow = !ctx.chars.is_empty();
        return;
    }
    // ponytail: one pitch for the whole shape (first run's leading); per-line leading if mixed sizes matter.
    let r0 = ctx.run(0);
    let pitch = px_len(r0.leading.unwrap_or(AUTO_LEADING * r0.size), ctx);
    let mut slots: Vec<(f64, f64, f64)> = Vec::new();
    let mut y = top + px_len(r0.size, ctx) * 0.8;
    while y <= bottom {
        slots.extend(spans(&polys, path.fill_rule, y).into_iter().map(|(a, b)| (a, b - a, y)));
        y += pitch;
    }
    let mut slot = 0;
    for &(c0, c1, ps) in paras {
        let s: String = ctx.chars[c0..c1].iter().collect();
        let bidi = ParagraphBidiInfo::new(&s, ps.rtl.then(Level::rtl));
        let p = ctx.para(c0, c1, &s, &bidi);
        let mut a = 0;
        loop {
            let Some(&(x, w, y)) = slots.get(slot) else {
                out.overflow = true;
                return;
            };
            slot += 1;
            let b = if p.n == 0 { 0 } else {
                match p.fit(ctx, a, w) {
                    Some(b) => b,
                    None => continue,
                }
            };
            let last = b >= p.n;
            let ar = arrange(ctx, &p, Some(&bidi), a, b, Some(w), ps, last);
            emit(ctx, &p, a, b, &ar, (x, y), metrics(ctx, &p, a, b), out);
            a = b;
            if last {
                break;
            }
        }
    }
}

/// Moves a laid-out single line onto the first subpath: arc length from `start`, rotated to the
/// tangent at the glyph centre; glyphs whose centre passes `end` (or the path end) are dropped.
fn on_path_place(path: &VectorPath, start: f64, end: f64, flip: bool, out: &mut Layout) {
    let Some(sp) = path.subpaths.first() else {
        out.glyphs.clear();
        out.lines.clear();
        return;
    };
    let mut pts = flatten(sp);
    if sp.closed && !pts.is_empty() {
        pts.push(pts[0]);
    }
    if flip {
        pts.reverse();
    }
    let mut cum = vec![0.0];
    for w in pts.windows(2) {
        cum.push(cum.last().unwrap() + (w[1][0] - w[0][0]).hypot(w[1][1] - w[0][1]));
    }
    let total = *cum.last().unwrap();
    if pts.len() < 2 || total <= 0.0 {
        out.glyphs.clear();
        out.lines.clear();
        return;
    }
    let stop = if end > start { end.min(total) } else { total };
    // Point and unit tangent at arc length s (the end segments extend past the path).
    let at = |s: f64| {
        let i = cum.partition_point(|&c| c <= s).clamp(1, pts.len() - 1);
        let (p, q) = (pts[i - 1], pts[i]);
        let len = cum[i] - cum[i - 1];
        let (tx, ty) = if len > 0.0 { ((q[0] - p[0]) / len, (q[1] - p[1]) / len) } else { (1.0, 0.0) };
        let d = s - cum[i - 1];
        ([p[0] + tx * d, p[1] + ty * d], [tx, ty])
    };
    let x0 = out.lines.first().map_or(0.0, |l| l.x);
    let glyphs = std::mem::take(&mut out.glyphs);
    let base = out.lines.first().map_or(0.0, |l| l.y);
    for mut g in glyphs {
        let s0 = start + g.x - x0;
        if s0 + g.advance / 2.0 > stop + EPS {
            continue;
        }
        let (_, t) = at(s0 + g.advance / 2.0);
        let (p, _) = at(s0);
        let off = g.y - base;
        g.x = p[0] - t[1] * off;
        g.y = p[1] + t[0] * off;
        g.rotation = t[1].atan2(t[0]).to_degrees();
        out.glyphs.push(g);
    }
    let (p, _) = at(start);
    out.lines.truncate(1);
    if let Some(l) = out.lines.first_mut() {
        l.x = p[0];
        l.y = p[1];
        l.glyphs = 0..out.glyphs.len();
    }
}

#[cfg(test)]
#[path = "typeset_tests.rs"]
mod tests;
