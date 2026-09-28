use super::*;
use crate::text::*;
use std::collections::BTreeMap;

fn reg() -> Registry {
    let mut r = Registry::default();
    let path = format!("{}/../app/public/fonts/NotoSans-Regular.ttf", env!("CARGO_MANIFEST_DIR"));
    r.add(std::fs::read(path).unwrap(), "bundled").unwrap();
    r
}

fn run(len: usize, aa: AntiAlias) -> Run {
    Run {
        length: len as u32,
        family: "Noto Sans".into(),
        style: "Regular".into(),
        postscript_name: String::new(),
        size: 40.0,
        tracking: 0.0,
        leading: None,
        color: [200, 30, 10],
        faux_bold: false,
        faux_italic: false,
        underline: false,
        strikethrough: false,
        caps: Caps::Normal,
        baseline: Baseline::Normal,
        baseline_shift: 0.0,
        horizontal_scale: 1.0,
        vertical_scale: 1.0,
        anti_alias: aa,
        ligatures: true,
        discretionary_ligatures: false,
        kerning: Kerning::Metrics,
        language: String::new(),
        no_break: false,
        tsume: 0.0,
        features: BTreeMap::new(),
    }
}

fn data(text: &str, aa: AntiAlias) -> TextData {
    let n = text.encode_utf16().count();
    TextData {
        text: text.into(),
        runs: vec![run(n, aa)],
        paragraphs: vec![Paragraph {
            length: n as u32,
            alignment: Alignment::Left,
            indent_left: 0.0,
            indent_right: 0.0,
            indent_first: 0.0,
            space_before: 0.0,
            space_after: 0.0,
            hyphenate: false,
            rtl: false,
            composer: Composer::SingleLine,
            justification: Justification { word: [0.8, 1.0, 1.33], letter: [0.0; 3], glyph: [1.0; 3] },
            hyphenation: Hyphenation { min_word: 5, after_first: 2, before_last: 2, limit: 2, zone: 36.0, capitalized: true },
            hanging_punctuation: false,
        }],
        shape: TextShape::Point,
        orientation: Orientation::Horizontal,
        transform: [1.0, 0.0, 0.0, 1.0, 20.0, 60.0],
        warp: None,
        psd: None,
    }
}

fn text_doc(t: &TextData) -> (Document, u32) {
    let mut d = Document::new(300, 120, 8).unwrap();
    let id = d.add_node("Hello", 0, Kind::Text(Box::new(Text { data: t.clone(), cache: None }))).unwrap();
    (d, id)
}

fn alphas(d: &Document, id: u32) -> Vec<(i32, i32, f32)> {
    let Kind::Text(t) = &d.node(id).unwrap().kind else { panic!("text node") };
    let tiles = t.cache.as_ref().expect("rendered");
    let mut out = vec![];
    for (tx, ty) in tiles.coords() {
        let px = &tiles.get(tx, ty).unwrap().px;
        for p in 0..TILE_PIXELS {
            out.push((tx * TILE as i32 + (p % TILE) as i32, ty * TILE as i32 + (p / TILE) as i32, px.rgba_f32(p)[3]));
        }
    }
    out
}

fn all_points(p: &VectorPath) -> Vec<[f64; 2]> {
    p.subpaths.iter().flat_map(|s| s.points.iter().map(|q| [q[0], q[1]])).collect()
}

#[test]
fn outline_is_closed_corner_polygons_in_document_px() {
    let o = outline(&data("Hi", AntiAlias::Sharp), &reg(), 72.0);
    assert_eq!(o.groups.len(), 1);
    assert_eq!(o.groups[0].0, [200, 30, 10]);
    let p = o.path();
    assert_eq!(p.fill_rule, FillRule::Nonzero);
    assert!(p.subpaths.len() >= 3, "H and i (two contours)");
    for s in &p.subpaths {
        assert!(s.closed && s.op == PathOp::Combine);
        assert!(s.points.iter().all(|q| q[0] == q[2] && q[1] == q[3] && q[0] == q[4] && q[1] == q[5]));
    }
    let [l, t, r, b] = geom::bounds(&p).unwrap();
    // 40 px Noto Sans at origin (20, 60): cap height about 0.714 em above the baseline.
    assert!(l > 20.0 && l < 30.0 && r < 90.0, "{l} {r}");
    assert!((b - 60.0).abs() < 0.5 && (60.0 - t - 0.714 * 40.0).abs() < 2.0, "{t} {b}");
}

#[test]
fn empty_registry_gives_no_outline() {
    assert!(outline(&data("Hi", AntiAlias::Sharp), &Registry::default(), 72.0).groups.is_empty());
}

#[test]
fn warp_with_zero_amounts_is_identity_for_every_style() {
    let base = outline(&data("Warp", AntiAlias::Sharp), &reg(), 72.0).path();
    for style in [
        WarpStyle::Arc, WarpStyle::ArcLower, WarpStyle::ArcUpper, WarpStyle::Arch, WarpStyle::Bulge, WarpStyle::ShellLower,
        WarpStyle::ShellUpper, WarpStyle::Flag, WarpStyle::Wave, WarpStyle::Fish, WarpStyle::Rise, WarpStyle::Fisheye,
        WarpStyle::Inflate, WarpStyle::Squeeze, WarpStyle::Twist,
    ] {
        let mut t = data("Warp", AntiAlias::Sharp);
        t.warp = Some(TextWarp { style, bend: 0.0, horizontal: 0.0, vertical: 0.0, axis: Orientation::Horizontal });
        assert_eq!(outline(&t, &reg(), 72.0).path(), base, "{style:?}");
    }
}

#[test]
fn warp_points_match_the_independent_node_goldens() {
    let g: serde_json::Value = serde_json::from_str(include_str!("testdata/warp_golden.json")).unwrap();
    let b: [f64; 4] = serde_json::from_value(g["bounds"].clone()).unwrap();
    let cases = g["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 270);
    for c in cases {
        let w = TextWarp {
            style: serde_json::from_value(c["style"].clone()).unwrap(),
            bend: c["bend"].as_f64().unwrap(),
            horizontal: c["horizontal"].as_f64().unwrap(),
            vertical: c["vertical"].as_f64().unwrap(),
            axis: Orientation::Horizontal,
        };
        let p: [f64; 2] = serde_json::from_value(c["p"].clone()).unwrap();
        let q: [f64; 2] = serde_json::from_value(c["q"].clone()).unwrap();
        let got = warp_point(&w, b, p);
        assert!((got[0] - q[0]).abs() < 1e-9 && (got[1] - q[1]).abs() < 1e-9, "{c} -> {got:?}");
    }
}

#[test]
fn warp_bends_the_outline_and_subdivides_long_edges() {
    let mut t = data("II", AntiAlias::Sharp);
    let flat = outline(&t, &reg(), 72.0).path();
    t.warp = Some(TextWarp { style: WarpStyle::Arc, bend: 0.5, horizontal: 0.0, vertical: 0.0, axis: Orientation::Horizontal });
    let warped = outline(&t, &reg(), 72.0).path();
    assert!(all_points(&warped).len() > all_points(&flat).len());
    // Arc lifts the middle of the layer: the warped top is higher than the flat top.
    assert!(geom::bounds(&warped).unwrap()[1] < geom::bounds(&flat).unwrap()[1] - 1.0);
    for s in &warped.subpaths {
        let n = s.points.len();
        for i in 0..n {
            let (a, b) = (s.points[i], s.points[(i + 1) % n]);
            assert!((a[0] - b[0]).hypot(a[1] - b[1]) < 4.0 * 2.5, "edges subdivided before the warp");
        }
    }
}

#[test]
fn anti_alias_none_renders_only_0_and_255() {
    let (mut d, id) = text_doc(&data("Ag", AntiAlias::None));
    d.render_text(id, &reg(), 72.0).unwrap();
    let a = alphas(&d, id);
    assert!(a.iter().any(|p| p.2 == 1.0));
    assert!(a.iter().all(|p| p.2 == 0.0 || p.2 == 1.0));
}

#[test]
fn cache_equals_the_mode_curve_over_the_converted_shape_coverage() {
    for aa in [AntiAlias::Sharp, AntiAlias::Crisp, AntiAlias::Strong] {
        let t = data("Sa", aa);
        let (mut d, id) = text_doc(&t);
        d.render_text(id, &reg(), 72.0).unwrap();
        let got = alphas(&d, id);
        let (mut s, sid) = text_doc(&t);
        s.convert_text_to_shape(sid, &reg(), 72.0).unwrap();
        let Kind::Shape(sh) = &s.node(sid).unwrap().kind else { panic!("shape") };
        assert_eq!(sh.path, outline(&t, &reg(), 72.0).path());
        let cov = geom::fill_mask(&sh.path, 0, 0, 512, 512);
        let mut lit = 0;
        for (x, y, a) in got {
            let c = if (0..512).contains(&x) && (0..512).contains(&y) { cov[y as usize * 512 + x as usize] } else { 0 };
            let want = aa_curve(c as f32 / 255.0, aa);
            assert!((a - want).abs() <= 1.0 / 255.0 + 1e-6, "{aa:?} ({x},{y}) {a} vs {want}");
            lit += (a > 0.0) as u32;
        }
        assert!(lit > 50);
    }
}

#[test]
fn modes_differ_and_smooth_blurs() {
    let lit = |aa| {
        let (mut d, id) = text_doc(&data("o", aa));
        d.render_text(id, &reg(), 72.0).unwrap();
        alphas(&d, id).iter().filter(|p| p.2 > 0.0).count()
    };
    assert!(lit(AntiAlias::Smooth) > lit(AntiAlias::Sharp), "the blur spreads coverage");
    assert_eq!(aa_curve(0.0, AntiAlias::Crisp), 0.0);
    assert_eq!(aa_curve(1.0, AntiAlias::Sharp), 1.0);
    assert!(aa_curve(0.5, AntiAlias::Strong) > aa_curve(0.5, AntiAlias::Sharp));
}

#[test]
fn cache_color_is_the_run_color_and_layer_composites() {
    let (mut d, id) = text_doc(&data("I", AntiAlias::None));
    d.render_text(id, &reg(), 72.0).unwrap();
    let Kind::Text(t) = &d.node(id).unwrap().kind else { panic!() };
    let tiles = t.cache.as_ref().unwrap();
    let (tx, ty) = tiles.coords()[0];
    let px = &tiles.get(tx, ty).unwrap().px;
    let p = (0..TILE_PIXELS).find(|&p| px.rgba_f32(p)[3] == 1.0).unwrap();
    let c = px.rgba_f32(p);
    assert!((c[0] - 200.0 / 255.0).abs() < 1e-3 && (c[1] - 30.0 / 255.0).abs() < 1e-3);
}

#[test]
fn set_text_drops_the_cache() {
    let t = data("Hi", AntiAlias::Sharp);
    let (mut d, id) = text_doc(&t);
    d.render_text(id, &reg(), 72.0).unwrap();
    let mut t2 = t.clone();
    t2.runs[0].color = [0, 0, 255];
    d.set_text(id, &serde_json::to_string(&t2).unwrap()).unwrap();
    let Kind::Text(n) = &d.node(id).unwrap().kind else { panic!() };
    assert!(n.cache.is_none());
    assert_eq!(n.data, t2);
    t2.runs[0].length = 99;
    assert!(d.set_text(id, &serde_json::to_string(&t2).unwrap()).is_err());
}

#[test]
fn faux_bold_widens_advance_and_ink_faux_italic_slants() {
    let base = data("ll", AntiAlias::Sharp);
    let lay = |t: &TextData| crate::typeset::layout(t, &reg(), 72.0);
    let mut bold = base.clone();
    bold.runs[0].faux_bold = true;
    let (g0, g1) = (lay(&base).glyphs, lay(&bold).glyphs);
    assert!(((g1[1].x - g1[0].x) - (g0[1].x - g0[0].x) - 0.024 * 40.0).abs() < 1e-9);
    let area = |t: &TextData| geom::fill_mask(&outline(t, &reg(), 72.0).path(), 0, 0, 300, 120).iter().map(|&v| v as u32).sum::<u32>();
    assert!(area(&bold) > area(&base));
    let mut it = base.clone();
    it.runs[0].faux_italic = true;
    let (b0, b1) = (geom::bounds(&outline(&base, &reg(), 72.0).path()).unwrap(), geom::bounds(&outline(&it, &reg(), 72.0).path()).unwrap());
    // The top of an "l" moves right by its height x tan 12 degrees; the baseline stays.
    let lift = 60.0 - b0[1];
    assert!((b1[2] - b0[2] - lift * 12f64.to_radians().tan()).abs() < 0.5, "{b0:?} {b1:?}");
}

#[test]
fn underline_and_strikethrough_add_a_rectangle_each() {
    let mut t = data("ab", AntiAlias::Sharp);
    let n = outline(&t, &reg(), 72.0).path().subpaths.len();
    t.runs[0].underline = true;
    let u = outline(&t, &reg(), 72.0).path();
    assert_eq!(u.subpaths.len(), n + 1);
    let r = u.subpaths.last().unwrap();
    assert_eq!(r.points.len(), 4);
    let ys: Vec<f64> = r.points.iter().map(|p| p[1]).collect();
    assert!(ys.iter().all(|&y| y > 60.0 && y < 60.0 + 0.2 * 40.0), "{ys:?} below the baseline");
    t.runs[0].strikethrough = true;
    let s = outline(&t, &reg(), 72.0).path();
    assert_eq!(s.subpaths.len(), n + 2);
    assert!(s.subpaths.last().unwrap().points.iter().all(|p| p[1] < 60.0), "strike above the baseline");
}

#[test]
fn work_path_convert_and_hit_test() {
    let t = data("Hi", AntiAlias::Sharp);
    let (mut d, id) = text_doc(&t);
    let pid = d.text_work_path(id, &reg(), 72.0).unwrap();
    let w = d.vector.paths.iter().find(|p| p.id == pid).unwrap();
    assert!(w.work && w.name == "Work Path");
    assert_eq!(w.path, outline(&t, &reg(), 72.0).path());
    let o = outline(&t, &reg(), 72.0).path();
    let [l, top, _, b] = geom::bounds(&o).unwrap();
    // The H stem is at the left edge of the ink.
    assert!(d.text_hit(id, &reg(), 72.0, l + 1.0, (top + b) / 2.0).unwrap());
    assert!(d.text_hit(id, &reg(), 72.0, l - 1.5, (top + b) / 2.0).unwrap(), "2 px tolerance");
    assert!(!d.text_hit(id, &reg(), 72.0, 290.0, 5.0).unwrap());
    d.node_mut(id).unwrap().locks.position = true;
    d.node_mut(id).unwrap().opacity = 0.5;
    let style = r#"{"enabled":true,"scale":0.5,"drop_shadows":[],"inner_shadows":[],"color_overlays":[],"gradient_overlays":[],
        "pattern_overlays":[],"strokes":[],"outer_glow":null,"inner_glow":null,"bevel":null,"contour":null,"texture":null,"satin":null}"#;
    d.set_style(id, style).unwrap();
    let before = d.node(id).unwrap().style.clone();
    d.convert_text_to_shape(id, &reg(), 72.0).unwrap();
    let n = d.node(id).unwrap();
    assert!(before.is_some() && n.style == before, "the layer style survives");
    assert!(matches!(&n.kind, Kind::Shape(s) if matches!(&s.fill, Some(FillContent::Solid(f)) if f.color == [200, 30, 10])));
    assert_eq!((n.name.as_str(), n.opacity, n.locks), ("Hello", 0.5, Locks::default()));
    assert!(d.convert_text_to_shape(id, &reg(), 72.0).is_err());
}

#[test]
fn faux_bold_shrinks_counters() {
    let mut t = data("o", AntiAlias::Sharp);
    let areas = |t: &TextData| -> Vec<f64> {
        outline(t, &reg(), 72.0).path().subpaths.iter().map(|s| {
            let p = &s.points;
            (0..p.len()).map(|i| p[i][0] * p[(i + 1) % p.len()][1] - p[(i + 1) % p.len()][0] * p[i][1]).sum::<f64>().abs() / 2.0
        }).collect()
    };
    let a = areas(&t);
    t.runs[0].faux_bold = true;
    let b = areas(&t);
    let (outer, inner) = if a[0] > a[1] { (0, 1) } else { (1, 0) };
    assert!(b[outer] > a[outer] && b[inner] < a[inner], "{a:?} -> {b:?}");
}

#[test]
fn outline_cost_is_bounded_under_huge_scale() {
    let mut t = data("o", AntiAlias::Sharp);
    t.transform = [64.0, 0.0, 0.0, 64.0, 0.0, 0.0];
    let n64: usize = outline(&t, &reg(), 72.0).path().subpaths.iter().map(|s| s.points.len()).sum();
    t.transform = [1e7, 0.0, 0.0, 1e7, 0.0, 0.0];
    let big: usize = outline(&t, &reg(), 72.0).path().subpaths.iter().map(|s| s.points.len()).sum();
    assert!(big <= n64 * 2, "{n64} vs {big}");
    let (mut d, id) = text_doc(&t);
    assert!(d.render_text(id, &reg(), 72.0).is_err());
}

#[test]
fn in_shape_text_with_zero_leading_terminates() {
    let mut t = data("some text in a shape", AntiAlias::Sharp);
    let sq = |x: f64, y: f64| [x, y, x, y, x, y];
    t.shape = TextShape::InShape {
        path: VectorPath { fill_rule: FillRule::Nonzero, subpaths: vec![Subpath { closed: true, op: PathOp::Combine, points: vec![sq(0.0, 0.0), sq(200.0, 0.0), sq(200.0, 200.0), sq(0.0, 200.0)] }] },
    };
    t.runs[0].leading = Some(0.0);
    assert!(!outline(&t, &reg(), 72.0).groups.is_empty());
}

#[test]
fn in_shape_text_flows_across_a_large_gap() {
    let n = |gap: f64| {
        let mut t = data("ab cd ef gh ij kl mn op", AntiAlias::Sharp);
        let sq = |x: f64, y: f64| [x, y, x, y, x, y];
        let rect = |y0: f64, y1: f64| Subpath { closed: true, op: PathOp::Combine, points: vec![sq(0.0, y0), sq(70.0, y0), sq(70.0, y1), sq(0.0, y1)] };
        t.shape = TextShape::InShape { path: VectorPath { fill_rule: FillRule::Nonzero, subpaths: vec![rect(0.0, 300.0), rect(300.0 + gap, 600.0 + gap)] } };
        outline(&t, &reg(), 72.0).path().subpaths.len()
    };
    assert_eq!(n(3000.0), n(400.0));
}

#[test]
fn text_layout_lists_lines_with_glyph_clusters_in_text_space() {
    let (d, id) = text_doc(&data("Hi\nyo", AntiAlias::Sharp));
    let v: serde_json::Value = serde_json::from_str(&d.text_layout(id, &reg(), 72.0).unwrap()).unwrap();
    assert_eq!(v["transform"], serde_json::json!([1.0, 0.0, 0.0, 1.0, 20.0, 60.0]));
    let lines = v["lines"].as_array().unwrap();
    assert_eq!(lines.len(), 2);
    assert_eq!((lines[0]["start"].as_u64(), lines[1]["start"].as_u64(), lines[1]["end"].as_u64()), (Some(0), Some(3), Some(5)));
    let g0 = lines[0]["glyphs"].as_array().unwrap();
    assert_eq!(g0.iter().map(|g| g[0].as_f64().unwrap()).collect::<Vec<_>>()[..2], [0.0, 1.0], "clusters H, i");
    assert!(g0[1][1].as_f64().unwrap() > g0[0][1].as_f64().unwrap() && g0[0][3].as_f64().unwrap() > 0.0, "x grows, advance > 0");
    assert!(lines[1]["y"].as_f64().unwrap() > lines[0]["y"].as_f64().unwrap() && lines[0]["ascent"].as_f64().unwrap() > 0.0);
    let (e, eid) = text_doc(&data("", AntiAlias::Sharp));
    let v: serde_json::Value = serde_json::from_str(&e.text_layout(eid, &reg(), 72.0).unwrap()).unwrap();
    let l = &v["lines"][0];
    assert!(v["lines"].as_array().unwrap().len() == 1 && l["ascent"].as_f64().unwrap() > 0.0, "empty text: one caret line");
}

#[test]
fn select_text_makes_the_outline_coverage_the_selection() {
    let t = data("Hi", AntiAlias::Sharp);
    let (mut d, id) = text_doc(&t);
    d.select_text(id, &reg(), 72.0, Mode::New).unwrap();
    let want = geom::fill_mask(&outline(&t, &reg(), 72.0).path(), 0, 0, 300, 120);
    let got: Vec<u8> = d.selection_values().into_iter().map(|v| (v * 255.0).round() as u8).collect();
    assert_eq!(got, want);
    let empty = data("", AntiAlias::Sharp);
    let (mut e, eid) = text_doc(&TextData { runs: vec![run(0, AntiAlias::Sharp)], ..empty });
    assert!(e.select_text(eid, &reg(), 72.0, Mode::New).is_err(), "no outline, no selection");
}
