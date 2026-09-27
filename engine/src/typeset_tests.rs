use super::*;
use crate::path::{FillRule, PathOp, Subpath, VectorPath};
use crate::text::*;
use std::collections::BTreeMap;

fn reg() -> Registry {
    let mut r = Registry::default();
    for f in ["NotoSans-Regular.ttf", "NotoSerif-Regular.ttf"] {
        let path = format!("{}/../app/public/fonts/{f}", env!("CARGO_MANIFEST_DIR"));
        r.add(std::fs::read(path).unwrap(), "bundled").unwrap();
    }
    r
}

fn run(len: usize) -> Run {
    Run {
        length: len as u32,
        family: "Noto Sans".into(),
        style: "Regular".into(),
        postscript_name: String::new(),
        size: 12.0,
        tracking: 0.0,
        leading: None,
        color: [0, 0, 0],
        faux_bold: false,
        faux_italic: false,
        underline: false,
        strikethrough: false,
        caps: Caps::Normal,
        baseline: Baseline::Normal,
        baseline_shift: 0.0,
        horizontal_scale: 1.0,
        vertical_scale: 1.0,
        anti_alias: AntiAlias::Sharp,
        ligatures: true,
        discretionary_ligatures: false,
        kerning: Kerning::Metrics,
        language: String::new(),
        no_break: false,
        tsume: 0.0,
        features: BTreeMap::new(),
    }
}

fn para(len: usize, alignment: Alignment, composer: Composer) -> Paragraph {
    Paragraph {
        length: len as u32,
        alignment,
        indent_left: 0.0,
        indent_right: 0.0,
        indent_first: 0.0,
        space_before: 0.0,
        space_after: 0.0,
        hyphenate: false,
        rtl: false,
        composer,
        justification: Justification { word: [0.8, 1.0, 1.33], letter: [0.0; 3], glyph: [1.0; 3] },
        hyphenation: Hyphenation { min_word: 5, after_first: 2, before_last: 2, limit: 2, zone: 36.0, capitalized: true },
        hanging_punctuation: false,
    }
}

fn data(text: &str, shape: TextShape) -> TextData {
    let n = text.encode_utf16().count();
    TextData {
        text: text.into(),
        runs: vec![run(n)],
        paragraphs: vec![para(n, Alignment::Left, Composer::EveryLine)],
        shape,
        orientation: Orientation::Horizontal,
        transform: [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        warp: None,
        psd: None,
    }
}

fn boxed(text: &str, w: f64, h: f64) -> TextData {
    data(text, TextShape::Paragraph { rect: [0.0, 0.0, w, h] })
}

const PROSE: &str = "The quick brown fox jumps over the lazy dog while a small cat watches from the old stone wall near the river bank";

fn line_right(l: &Layout, i: usize) -> f64 {
    let g = &l.glyphs[l.lines[i].glyphs.clone()];
    g.iter().map(|g| g.x + g.advance).fold(f64::MIN, f64::max)
}

#[test]
fn auto_leading_scales_with_resolution() {
    let r = reg();
    let t = data("Ab\nCd", TextShape::Point);
    let l = layout(&t, &r, 72.0);
    assert_eq!(l.lines.len(), 2);
    assert!((l.lines[1].y - l.lines[0].y - 14.4).abs() < 1e-9);
    let l = layout(&t, &r, 300.0);
    assert!((l.lines[1].y - l.lines[0].y - 60.0).abs() < 1e-9);
}

#[test]
fn tracking_1000_adds_one_em() {
    let r = reg();
    let mut t = data("AV", TextShape::Point);
    let a = layout(&t, &r, 150.0);
    t.runs[0].tracking = 1000.0;
    let b = layout(&t, &r, 150.0);
    let em = 12.0 * 150.0 / 72.0;
    let gap = |l: &Layout| l.glyphs[1].x - l.glyphs[0].x;
    assert!((gap(&b) - gap(&a) - em).abs() < 1e-9);
}

#[test]
fn center_alignment_centers_line_in_box() {
    let r = reg();
    let mut t = boxed("Hello world", 300.0, 100.0);
    t.paragraphs[0].alignment = Alignment::Center;
    let l = layout(&t, &r, 72.0);
    let ln = &l.lines[0];
    assert!((ln.x + ln.width / 2.0 - 150.0).abs() < 0.01);
    let g = &l.glyphs[ln.glyphs.clone()];
    let (lo, hi) = (g[0].x, line_right(&l, 0));
    assert!(((lo + hi) / 2.0 - 150.0).abs() < 0.01);
}

#[test]
fn justify_all_ends_every_line_at_box_right() {
    let r = reg();
    let mut t = boxed(PROSE, 200.0, 1000.0);
    t.paragraphs[0].alignment = Alignment::JustifyAll;
    let l = layout(&t, &r, 72.0);
    assert!(l.lines.len() >= 3);
    for i in 0..l.lines.len() {
        assert!((line_right(&l, i) - 200.0).abs() < 0.01, "line {i} ends at {}", line_right(&l, i));
    }
    assert!((l.glyphs[0].x).abs() < 0.01);
}

#[test]
fn box_one_line_high_overflows() {
    let r = reg();
    let t = boxed("one\ntwo\nthree", 300.0, 14.4);
    let l = layout(&t, &r, 72.0);
    assert!(l.overflow);
    assert_eq!(l.lines.len(), 1);
    let t = boxed("one\ntwo\nthree", 300.0, 100.0);
    let l = layout(&t, &r, 72.0);
    assert!(!l.overflow);
    assert_eq!(l.lines.len(), 3);
}

#[test]
fn fi_ligature_follows_liga() {
    let r = reg();
    let mut t = data("fi", TextShape::Point);
    assert_eq!(layout(&t, &r, 72.0).glyphs.len(), 1);
    t.runs[0].ligatures = false;
    assert_eq!(layout(&t, &r, 72.0).glyphs.len(), 2);
}

#[test]
fn hebrew_in_ltr_paragraph_runs_right_to_left() {
    let r = reg();
    // alef bet gimel; the bundled faces lack Hebrew, so order is checked on logical clusters.
    let t = data("ab \u{05D0}\u{05D1}\u{05D2} cd", TextShape::Point);
    let l = layout(&t, &r, 72.0);
    let x = |c: u32| l.glyphs.iter().find(|g| g.cluster == c).unwrap().x;
    assert!(x(0) < x(1) && x(1) < x(6));
    assert!(x(3) > x(4) && x(4) > x(5));
    assert!(x(1) < x(5) && x(3) < x(7));
}

#[test]
fn vertical_upright_han_rotated_latin_and_columns() {
    let r = reg();
    let mut t = data("\u{6C34}A\n\u{6C34}A", TextShape::Point);
    t.orientation = Orientation::Vertical;
    let l = layout(&t, &r, 72.0);
    assert_eq!(l.lines.len(), 2);
    let han = l.glyphs.iter().find(|g| g.cluster == 0).unwrap();
    let a = l.glyphs.iter().find(|g| g.cluster == 1).unwrap();
    assert_eq!(han.rotation, 0.0);
    assert_eq!(a.rotation, 90.0);
    assert!((a.y - han.advance).abs() < 1e-9);
    assert!((l.lines[1].x - (l.lines[0].x - 14.4)).abs() < 1e-9);
}

#[test]
fn every_line_never_wider_than_greedy() {
    let r = reg();
    for w in [90.0, 120.0, 150.0, 200.0, 260.0] {
        let mut t = boxed(PROSE, w, 1000.0);
        let widest = |l: &Layout| l.lines.iter().map(|l| l.width).fold(0.0, f64::max);
        let every = widest(&layout(&t, &r, 72.0));
        t.paragraphs[0].composer = Composer::SingleLine;
        let greedy = layout(&t, &r, 72.0);
        assert!(every <= widest(&greedy) + 1e-9, "width {w}: {every} > {}", widest(&greedy));
        assert!(greedy.lines.iter().all(|l| l.width <= w + 1e-9));
    }
}

#[test]
fn greedy_breaks_at_spaces_within_measure() {
    let r = reg();
    let mut t = boxed(PROSE, 150.0, 1000.0);
    t.paragraphs[0].composer = Composer::SingleLine;
    let l = layout(&t, &r, 72.0);
    assert!(l.lines.len() > 2);
    let u: Vec<u16> = PROSE.encode_utf16().collect();
    for ln in &l.lines[..l.lines.len() - 1] {
        assert_eq!(u[ln.end as usize - 1], b' ' as u16);
    }
    assert_eq!(l.lines.last().unwrap().end as usize, u.len());
}

#[test]
fn super_sub_and_small_caps_sizes() {
    let r = reg();
    let mut t = data("Ab", TextShape::Point);
    t.runs[0].baseline = Baseline::Super;
    let l = layout(&t, &r, 72.0);
    assert!((l.glyphs[0].size - 12.0 * 0.583).abs() < 1e-9);
    assert!((l.glyphs[0].y + 12.0 * 0.333).abs() < 1e-9);
    t.runs[0].baseline = Baseline::Sub;
    assert!((layout(&t, &r, 72.0).glyphs[0].y - 12.0 * 0.333).abs() < 1e-9);
    t.runs[0].baseline = Baseline::Normal;
    t.runs[0].caps = Caps::Small;
    let l = layout(&t, &r, 72.0);
    assert!((l.glyphs[0].size - 12.0).abs() < 1e-9);
    assert!((l.glyphs[1].size - 12.0 * 0.7).abs() < 1e-9);
    t.runs[0].caps = Caps::All;
    let up = layout(&t, &r, 72.0);
    let plain = layout(&data("AB", TextShape::Point), &r, 72.0);
    assert_eq!(up.glyphs[1].glyph, plain.glyphs[1].glyph);
}

#[test]
fn horizontal_scale_scales_advances() {
    let r = reg();
    let mut t = data("AB", TextShape::Point);
    let a = layout(&t, &r, 72.0).glyphs[1].x;
    t.runs[0].horizontal_scale = 2.0;
    t.runs[0].vertical_scale = 0.5;
    let l = layout(&t, &r, 72.0);
    assert!((l.glyphs[1].x - 2.0 * a).abs() < 1e-9);
    assert_eq!(l.glyphs[0].scale, [2.0, 0.5]);
}

#[test]
fn space_after_and_indents() {
    let r = reg();
    let mut t = boxed("a\nb", 300.0, 500.0);
    t.paragraphs = vec![para(2, Alignment::Left, Composer::EveryLine), para(1, Alignment::Left, Composer::EveryLine)];
    t.paragraphs[0].space_after = 10.0;
    t.paragraphs[1].indent_left = 20.0;
    t.paragraphs[1].indent_first = 5.0;
    let l = layout(&t, &r, 144.0);
    assert!((l.lines[1].y - l.lines[0].y - 2.0 * (14.4 + 10.0)).abs() < 1e-9);
    assert!((l.lines[1].x - 2.0 * 25.0).abs() < 1e-9);
}

#[test]
fn point_right_alignment_ends_at_origin() {
    let r = reg();
    let mut t = data("Hello", TextShape::Point);
    t.paragraphs[0].alignment = Alignment::Right;
    let l = layout(&t, &r, 72.0);
    assert!(line_right(&l, 0).abs() < 1e-9);
}

#[test]
fn on_path_follows_tangent_and_drops_past_end() {
    let r = reg();
    let p = |x: f64, y: f64| [x, y, x, y, x, y];
    let path = VectorPath {
        fill_rule: FillRule::Nonzero,
        subpaths: vec![Subpath { closed: false, op: PathOp::Combine, points: vec![p(0.0, 0.0), p(0.0, 100.0)] }],
    };
    let t = data("HHHHHHHHHHHHHHHHHHHH", TextShape::OnPath { path: path.clone(), start: 10.0, end: 60.0, flip: false });
    let l = layout(&t, &r, 72.0);
    assert!(!l.glyphs.is_empty() && l.glyphs.len() < 20);
    assert!(l.glyphs.iter().all(|g| (g.rotation - 90.0).abs() < 1e-9 && g.x.abs() < 1e-9));
    assert!((l.glyphs[0].y - 10.0).abs() < 1e-9);
    assert!(l.glyphs.iter().all(|g| g.y + g.advance / 2.0 <= 60.0 + 1e-9));
    let t = data("HH", TextShape::OnPath { path, start: 0.0, end: 0.0, flip: true });
    let l = layout(&t, &r, 72.0);
    assert!((l.glyphs[0].y - 100.0).abs() < 1e-9 && (l.glyphs[0].rotation + 90.0).abs() < 1e-9);
}

#[test]
fn in_shape_fills_spans_top_down() {
    let r = reg();
    let p = |x: f64, y: f64| [x, y, x, y, x, y];
    // A triangle widening downward: lower lines get wider spans.
    let path = VectorPath {
        fill_rule: FillRule::Nonzero,
        subpaths: vec![Subpath { closed: true, op: PathOp::Combine, points: vec![p(100.0, 0.0), p(200.0, 200.0), p(0.0, 200.0)] }],
    };
    let l = layout(&data(&PROSE.repeat(3), TextShape::InShape { path }), &r, 72.0);
    assert!(l.overflow);
    assert!(l.lines.len() >= 3);
    for w in l.lines.windows(2) {
        assert!(w[1].y > w[0].y);
    }
    for ln in &l.lines {
        let half = ln.y / 2.0; // span half-width at the baseline
        assert!(ln.x >= 100.0 - half - 1e-9 && ln.x + ln.width <= 100.0 + half + 1e-9);
    }
}

#[test]
fn tsume_tightens_cjk_only() {
    let r = reg();
    let mut t = data("\u{6C34}\u{6C34}AA", TextShape::Point);
    let a = layout(&t, &r, 72.0);
    t.runs[0].tsume = 0.5;
    let b = layout(&t, &r, 72.0);
    assert!(b.glyphs[1].x <= a.glyphs[1].x);
    assert!((b.glyphs[3].x - b.glyphs[2].x - (a.glyphs[3].x - a.glyphs[2].x)).abs() < 1e-9);
}
