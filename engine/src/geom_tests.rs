use super::*;

fn corner(x: f64, y: f64) -> Point {
    [x, y, x, y, x, y]
}

fn poly(pts: &[(f64, f64)], closed: bool, op: PathOp) -> Subpath {
    Subpath { closed, op, points: pts.iter().map(|&(x, y)| corner(x, y)).collect() }
}

fn path(fill_rule: FillRule, subpaths: Vec<Subpath>) -> VectorPath {
    VectorPath { fill_rule, subpaths }
}

fn square(l: f64, t: f64, r: f64, b: f64, op: PathOp) -> Subpath {
    poly(&[(l, t), (r, t), (r, b), (l, b)], true, op)
}

fn px(m: &[u8], w: usize, x: usize, y: usize) -> u8 {
    m[y * w + x]
}

/// Shoelace area of the anchor polygons (boolean results are corner anchors), nonzero sum.
fn area(p: &VectorPath) -> f64 {
    p.subpaths
        .iter()
        .map(|s| {
            let n = s.points.len();
            (0..n).map(|i| {
                let (a, b) = (s.points[i], s.points[(i + 1) % n]);
                a[0] * b[1] - b[0] * a[1]
            }).sum::<f64>() / 2.0
        })
        .sum::<f64>()
        .abs()
}

fn line_path(x0: f64, y0: f64, x1: f64, y1: f64) -> VectorPath {
    path(FillRule::Nonzero, vec![poly(&[(x0, y0), (x1, y1)], false, PathOp::Combine)])
}

fn stroke(p: &VectorPath, width: f64, align: StrokeAlign, cap: Cap, dash: &[f64], w: usize, h: usize) -> Vec<u8> {
    stroke_mask(p, width, align, cap, Join::Miter, 4.0, dash, 0.0, 0, 0, w, h)
}

#[test]
fn geom_rect_edge_coverage() {
    let p = path(FillRule::Nonzero, vec![square(2.5, 2.0, 12.5, 12.0, PathOp::Combine)]);
    let m = fill_mask(&p, 0, 0, 20, 20);
    assert_eq!([px(&m, 20, 2, 5), px(&m, 20, 5, 5), px(&m, 20, 12, 5), px(&m, 20, 13, 5)], [128, 255, 128, 0]);
    assert_eq!(px(&m, 20, 5, 1), 0);
    assert_eq!(px(&m, 20, 5, 11), 255);
}

#[test]
fn geom_mask_origin_offset() {
    let p = path(FillRule::Nonzero, vec![square(102.5, 52.0, 112.5, 62.0, PathOp::Combine)]);
    let m = fill_mask(&p, 100, 50, 20, 20);
    assert_eq!([px(&m, 20, 2, 5), px(&m, 20, 5, 5), px(&m, 20, 12, 5), px(&m, 20, 13, 5)], [128, 255, 128, 0]);
}

#[test]
fn geom_circle_area() {
    let m = fill_mask(&ellipse([10.0, 10.0, 110.0, 110.0]), 0, 0, 120, 120);
    let sum: f64 = m.iter().map(|&v| v as f64).sum::<f64>() / 255.0;
    assert!((sum / 7853.98 - 1.0).abs() < 0.002, "{sum}");
}

#[test]
fn geom_nested_squares_fill_rule() {
    let subs = vec![square(10.0, 10.0, 50.0, 50.0, PathOp::Combine), square(20.0, 20.0, 40.0, 40.0, PathOp::Combine)];
    let eo = fill_mask(&path(FillRule::Evenodd, subs.clone()), 0, 0, 60, 60);
    let nz = fill_mask(&path(FillRule::Nonzero, subs), 0, 0, 60, 60);
    assert_eq!((px(&eo, 60, 30, 30), px(&eo, 60, 15, 30)), (0, 255));
    assert_eq!((px(&nz, 60, 30, 30), px(&nz, 60, 15, 30)), (255, 255));
}

#[test]
fn geom_subpath_ops_on_coverage() {
    let a = square(0.0, 0.0, 10.0, 10.0, PathOp::Combine);
    let b = |op| square(5.0, 0.0, 15.0, 10.0, op);
    let sum = |op| fill_mask(&path(FillRule::Nonzero, vec![a.clone(), b(op)]), 0, 0, 20, 12).iter().map(|&v| v as u32).sum::<u32>() / 255;
    assert_eq!([sum(PathOp::Combine), sum(PathOp::Subtract), sum(PathOp::Intersect), sum(PathOp::Exclude)], [150, 50, 50, 100]);
}

#[test]
fn geom_boolean_areas() {
    let a = path(FillRule::Nonzero, vec![square(0.0, 0.0, 10.0, 10.0, PathOp::Combine)]);
    let b = path(FillRule::Nonzero, vec![square(5.0, 0.0, 15.0, 10.0, PathOp::Combine)]);
    for (op, want) in [(BoolOp::Unite, 150.0), (BoolOp::Intersect, 50.0), (BoolOp::SubtractFront, 50.0), (BoolOp::Exclude, 100.0)] {
        let r = boolean(&a, &b, op);
        assert!((area(&r) - want).abs() <= 0.5, "{op:?}: {}", area(&r));
        assert_eq!(r.fill_rule, FillRule::Nonzero);
        assert!(r.subpaths.iter().all(|s| s.closed && s.points.iter().all(|p| p[0] == p[2] && p[1] == p[3] && p[0] == p[4])));
        // The polygon result renders the same area as its coverage.
        let cov = fill_mask(&r, 0, 0, 20, 12).iter().map(|&v| v as f64).sum::<f64>() / 255.0;
        assert!((cov - want).abs() <= 0.5, "{op:?} coverage {cov}");
    }
    assert_eq!(boolean(&a, &b, BoolOp::Unite).subpaths[0].points.len(), 4);
}

#[test]
fn geom_boolean_hole_and_merge() {
    let outer = path(FillRule::Nonzero, vec![square(0.0, 0.0, 30.0, 30.0, PathOp::Combine)]);
    let inner = path(FillRule::Nonzero, vec![square(10.0, 10.0, 20.0, 20.0, PathOp::Combine)]);
    let r = boolean(&outer, &inner, BoolOp::SubtractFront);
    assert!((area_nonzero(&r) - 800.0).abs() <= 0.5);
    let m = fill_mask(&r, 0, 0, 30, 30);
    assert_eq!((px(&m, 30, 15, 15), px(&m, 30, 5, 15)), (0, 255));
    let nested = path(FillRule::Evenodd, vec![square(0.0, 0.0, 30.0, 30.0, PathOp::Combine), square(10.0, 10.0, 20.0, 20.0, PathOp::Combine)]);
    let merged = merge_components(&nested);
    let m = fill_mask(&merged, 0, 0, 30, 30);
    assert_eq!((px(&m, 30, 15, 15), px(&m, 30, 5, 15), merged.fill_rule), (0, 255, FillRule::Nonzero));
}

fn area_nonzero(p: &VectorPath) -> f64 {
    fill_mask(p, 0, 0, 40, 40).iter().map(|&v| v as f64).sum::<f64>() / 255.0
}

#[test]
fn geom_line_stroke_caps() {
    let p = line_path(10.0, 20.0, 90.0, 20.0);
    let butt = stroke(&p, 4.0, StrokeAlign::Center, Cap::Butt, &[], 100, 40);
    for y in 18..=21 {
        assert!((10..=89).all(|x| px(&butt, 100, x, y) == 255), "row {y}");
        assert_eq!((px(&butt, 100, 9, y), px(&butt, 100, 90, y)), (0, 0));
    }
    assert_eq!((px(&butt, 100, 50, 17), px(&butt, 100, 50, 22)), (0, 0));
    let sq = stroke(&p, 4.0, StrokeAlign::Center, Cap::Square, &[], 100, 40);
    for y in 18..=21 {
        assert!((8..=91).all(|x| px(&sq, 100, x, y) == 255), "row {y}");
        assert_eq!((px(&sq, 100, 7, y), px(&sq, 100, 92, y)), (0, 0));
    }
    let round = stroke(&p, 4.0, StrokeAlign::Center, Cap::Round, &[], 100, 40);
    assert_eq!((px(&round, 100, 9, 19), px(&round, 100, 7, 17)), (255, 0));
    assert!((1..255).contains(&px(&round, 100, 8, 19)));
}

#[test]
fn geom_rect_stroke_alignment() {
    let p = path(FillRule::Nonzero, vec![square(10.0, 10.0, 20.0, 20.0, PathOp::Combine)]);
    let inside = stroke(&p, 2.0, StrokeAlign::Inside, Cap::Butt, &[], 30, 30);
    assert_eq!((px(&inside, 30, 10, 15), px(&inside, 30, 11, 15), px(&inside, 30, 12, 15), px(&inside, 30, 9, 15)), (255, 255, 0, 0));
    let outside = stroke(&p, 2.0, StrokeAlign::Outside, Cap::Butt, &[], 30, 30);
    assert_eq!((px(&outside, 30, 8, 15), px(&outside, 30, 9, 15), px(&outside, 30, 10, 15), px(&outside, 30, 7, 15)), (255, 255, 0, 0));
    // Miter join fills the outer corner square.
    assert_eq!(px(&outside, 30, 8, 8), 255);
    let center = stroke(&p, 2.0, StrokeAlign::Center, Cap::Butt, &[], 30, 30);
    assert_eq!((px(&center, 30, 9, 15), px(&center, 30, 10, 15), px(&center, 30, 11, 15), px(&center, 30, 9, 9)), (255, 255, 0, 255));
    let bevel = stroke_mask(&p, 2.0, StrokeAlign::Center, Cap::Butt, Join::Bevel, 4.0, &[], 0.0, 0, 0, 30, 30);
    assert_eq!(px(&bevel, 30, 9, 9), 128);
}

#[test]
fn geom_dash() {
    let p = line_path(10.0, 20.0, 70.0, 20.0);
    let m = stroke(&p, 2.0, StrokeAlign::Center, Cap::Butt, &[8.0, 4.0], 80, 30);
    assert_eq!((px(&m, 80, 14, 20), px(&m, 80, 20, 20), px(&m, 80, 58, 20)), (255, 0, 255));
    assert_eq!((px(&m, 80, 17, 20), px(&m, 80, 18, 20), px(&m, 80, 22, 20)), (255, 0, 255));
    let shifted = stroke_mask(&p, 2.0, StrokeAlign::Center, Cap::Butt, Join::Miter, 4.0, &[8.0, 4.0], 2.0, 0, 0, 80, 30);
    assert_eq!((px(&shifted, 80, 15, 20), px(&shifted, 80, 16, 20)), (255, 0));
}

#[test]
fn geom_rounded_rect_clamps() {
    let p = rect([0.0, 0.0, 100.0, 60.0], [50.0; 4]);
    let pts = &p.subpaths[0].points;
    assert_eq!(pts.len(), 8);
    assert_eq!((pts[0][0], pts[0][1]), (0.0, 30.0));
    assert_eq!((pts[1][0], pts[1][1]), (30.0, 0.0));
    assert_eq!(bounds(&p), Some([0.0, 0.0, 100.0, 60.0]));
    let sharp = rect([0.0, 0.0, 100.0, 60.0], [0.0; 4]);
    assert_eq!(sharp.subpaths[0].points, vec![corner(0.0, 0.0), corner(100.0, 0.0), corner(100.0, 60.0), corner(0.0, 60.0)]);
}

#[test]
fn geom_generators() {
    let tri = triangle([0.0, 0.0, 40.0, 30.0], 0.0);
    assert_eq!(tri.subpaths[0].points, vec![corner(20.0, 0.0), corner(40.0, 30.0), corner(0.0, 30.0)]);
    let hex = polygon([0.0, 0.0, 100.0, 100.0], 6, 0.0, 0.0);
    assert_eq!(hex.subpaths[0].points.len(), 6);
    assert!((hex.subpaths[0].points[0][0] - 50.0).abs() < 1e-9 && hex.subpaths[0].points[0][1].abs() < 1e-9);
    // Clockwise in screen space: the second vertex is right of the first.
    assert!(hex.subpaths[0].points[1][0] > 50.0);
    let star = polygon([0.0, 0.0, 100.0, 100.0], 5, 0.5, 0.0);
    assert_eq!(star.subpaths[0].points.len(), 10);
    let inner = star.subpaths[0].points[1];
    assert!(((inner[0] - 50.0).hypot(inner[1] - 50.0) - 25.0).abs() < 1e-9);
    let l = line(10.0, 20.0, 90.0, 20.0, 4.0);
    let m = fill_mask(&l, 0, 0, 100, 40);
    assert_eq!((px(&m, 100, 10, 18), px(&m, 100, 89, 21), px(&m, 100, 90, 20), px(&m, 100, 50, 22)), (255, 255, 0, 0));
    assert_eq!(bounds(&l), Some([10.0, 18.0, 90.0, 22.0]));
    let e = ellipse([10.0, 20.0, 50.0, 40.0]);
    assert_eq!(e.subpaths[0].points.len(), 4);
    assert_eq!(bounds(&e), Some([10.0, 20.0, 50.0, 40.0]));
    assert!(live(&Live::Custom { bounds: [0.0; 4] }).is_none());
    assert_eq!(live(&Live::Ellipse { bounds: [10.0, 20.0, 50.0, 40.0] }), Some(e));
}

#[test]
fn geom_bounds_curve_extrema() {
    // One cubic from (0,0) to (10,0) with both handles at y 10 peaks at y 7.5.
    let p = path(FillRule::Nonzero, vec![Subpath { closed: false, op: PathOp::Combine, points: vec![[0.0, 0.0, 0.0, 0.0, 0.0, 10.0], [10.0, 0.0, 10.0, 10.0, 10.0, 0.0]] }]);
    let b = bounds(&p).unwrap();
    assert!((b[3] - 7.5).abs() < 1e-9 && b[1] == 0.0 && b[0] == 0.0 && b[2] == 10.0, "{b:?}");
    assert_eq!(bounds(&path(FillRule::Nonzero, vec![])), None);
}

#[test]
fn geom_hit_test() {
    let p = path(FillRule::Evenodd, vec![square(10.0, 10.0, 50.0, 50.0, PathOp::Combine), square(20.0, 20.0, 40.0, 40.0, PathOp::Combine)]);
    assert!(hit(&p, 15.0, 15.0, 0.0));
    assert!(!hit(&p, 30.0, 30.0, 0.0));
    assert!(!hit(&p, 55.0, 30.0, 2.0));
    assert!(hit(&p, 51.5, 30.0, 2.0));
    assert!(hit(&p, 30.0, 21.0, 2.0));
    let l = line_path(0.0, 0.0, 10.0, 0.0);
    assert!(hit(&l, 5.0, 1.0, 1.5) && !hit(&l, 5.0, 2.0, 1.5));
}

#[test]
fn geom_flatten_tolerance() {
    let e = ellipse([0.0, 0.0, 100.0, 100.0]);
    let f = flatten(&e.subpaths[0]);
    assert!(f.len() > 16);
    for i in 0..f.len() {
        let (a, b) = (f[i], f[(i + 1) % f.len()]);
        let mid = ((a[0] + b[0]) / 2.0 - 50.0).hypot((a[1] + b[1]) / 2.0 - 50.0);
        assert!(50.0 - mid < FLATNESS + 0.02, "chord {i} sags {}", 50.0 - mid);
    }
}

#[test]
fn geom_trace_square() {
    let (w, h) = (30usize, 30usize);
    let mut m = vec![0u8; w * h];
    for y in 5..25 {
        for x in 5..25 {
            m[y * w + x] = 255;
        }
    }
    let p = trace(&m, w, h, 0, 0, 2.0);
    assert_eq!(p.subpaths.len(), 1);
    let pts = &p.subpaths[0].points;
    assert_eq!(pts.len(), 4, "{pts:?}");
    for c in [(5.0, 5.0), (25.0, 5.0), (25.0, 25.0), (5.0, 25.0)] {
        assert!(pts.iter().any(|p| (p[0] - c.0).hypot(p[1] - c.1) <= 1e-9), "no anchor at {c:?}: {pts:?}");
    }
    assert!(pts.iter().all(|p| p[0] == p[2] && p[1] == p[3] && p[0] == p[4] && p[1] == p[5]));
}

#[test]
fn geom_trace_disc_is_smooth() {
    let (w, h) = (60usize, 60usize);
    let m: Vec<u8> = (0..w * h).map(|i| if ((i % w) as f64 + 0.5 - 30.0).hypot((i / w) as f64 + 0.5 - 30.0) < 20.0 { 255 } else { 0 }).collect();
    let p = trace(&m, w, h, 10, 10, 1.0);
    let pts = &p.subpaths[0].points;
    assert!(pts.len() <= 12, "{}", pts.len());
    let b = bounds(&p).unwrap();
    assert!((b[0] - 20.0).abs() < 1.0 && (b[2] - 60.0).abs() < 1.0, "{b:?}");
}

#[test]
fn geom_boolean_circles_cross() {
    let a = ellipse([10.0, 10.0, 30.0, 30.0]);
    let b = ellipse([20.0, 10.0, 40.0, 30.0]);
    let lens = 200.0 * 0.5f64.acos() - 5.0 * 300f64.sqrt();
    let full = std::f64::consts::PI * 100.0;
    for (op, want) in [(BoolOp::Unite, 2.0 * full - lens), (BoolOp::Intersect, lens), (BoolOp::SubtractFront, full - lens), (BoolOp::Exclude, 2.0 * full - 2.0 * lens)] {
        let r = boolean(&a, &b, op);
        assert!((area_nonzero(&r) - want).abs() < 1.0, "{op:?}: {} vs {want}", area_nonzero(&r));
        assert_eq!(r, boolean(&a, &b, op));
    }
}

fn max_diff(a: &[u8], b: &[u8]) -> (u8, usize) {
    a.iter().zip(b).enumerate().map(|(i, (x, y))| (x.abs_diff(*y), i)).max().unwrap()
}

#[test]
fn a_center_stroke_on_a_circle_is_the_exact_annulus() {
    let circle = |r: f64| ellipse([100.0 - r, 100.0 - r, 100.0 + r, 100.0 + r]).subpaths.remove(0);
    let ring = path(FillRule::Evenodd, vec![circle(70.0), circle(50.0)]);
    let c = path(FillRule::Nonzero, vec![circle(60.0)]);
    let s = stroke_mask(&c, 20.0, StrokeAlign::Center, Cap::Butt, Join::Miter, 4.0, &[], 0.0, 0, 0, 200, 200);
    let (d, at) = max_diff(&s, &fill_mask(&ring, 0, 0, 200, 200));
    assert!(d <= 2, "max diff {d} at ({}, {})", at % 200, at / 200);
}

#[test]
fn a_round_cap_line_is_the_exact_stadium() {
    let p = line_path(50.3, 100.4, 150.3, 100.4);
    let s = stroke_mask(&p, 20.0, StrokeAlign::Center, Cap::Round, Join::Miter, 4.0, &[], 0.0, 0, 0, 200, 200);
    let body = path(FillRule::Nonzero, vec![square(50.3, 90.4, 150.3, 110.4, PathOp::Combine)]);
    let ends = boolean(&ellipse([40.3, 90.4, 60.3, 110.4]), &ellipse([140.3, 90.4, 160.3, 110.4]), BoolOp::Unite);
    let stadium = boolean(&body, &ends, BoolOp::Unite);
    let (d, at) = max_diff(&s, &fill_mask(&stadium, 0, 0, 200, 200));
    assert!(d <= 2, "max diff {d} at ({}, {})", at % 200, at / 200);
}

#[test]
fn a_long_round_cap_dashed_stroke_renders_one_tile_quickly() {
    let p = line_path(0.0, 128.0, 4000.0, 128.0);
    let t = std::time::Instant::now();
    let m = stroke_mask(&p, 10.0, StrokeAlign::Center, Cap::Round, Join::Miter, 4.0, &[2.0, 2.0], 0.0, 1792, 0, 256, 256);
    let s = t.elapsed().as_secs_f64();
    assert!(px(&m, 256, 0, 128) > 0 || px(&m, 256, 20, 128) > 0, "the band is covered");
    let limit = if cfg!(debug_assertions) { 5.0 } else { 0.5 };
    assert!(s < limit, "{s} s");
}

#[test]
fn geom_fit_points_keeps_an_open_corner_and_straight_runs() {
    let mut pts: Vec<[f64; 2]> = (0..=50).map(|i| [i as f64, 0.0]).collect();
    pts.extend((1..=50).map(|i| [50.0, i as f64]));
    let s = fit_points(&pts, 2.0, false);
    assert!(!s.closed);
    assert_eq!(s.points, vec![[0.0, 0.0, 0.0, 0.0, 0.0, 0.0], [50.0, 0.0, 50.0, 0.0, 50.0, 0.0], [50.0, 50.0, 50.0, 50.0, 50.0, 50.0]]);
}

#[test]
fn geom_fit_points_fits_a_curve_within_tolerance() {
    let arc: Vec<[f64; 2]> = (0..=90).map(|d| { let a = (d as f64).to_radians(); [50.0 * a.cos(), 50.0 * a.sin()] }).collect();
    let s = fit_points(&arc, 1.0, false);
    assert!(s.points.len() <= 4, "{:?}", s.points);
    assert_eq!((s.points[0][0], s.points[0][1]), (50.0, 0.0), "ends stay put");
    let flat = flatten(&s);
    for q in &arc {
        let d = flat.windows(2).map(|w| seg_dist(v(q[0], q[1]), v(w[0][0], w[0][1]), v(w[1][0], w[1][1]))).fold(f64::MAX, f64::min);
        assert!(d <= 1.5, "{q:?} is {d} px off");
    }
    let circle: Vec<[f64; 2]> = (0..360).map(|d| { let a = (d as f64).to_radians(); [50.0 + 40.0 * a.cos(), 50.0 + 40.0 * a.sin()] }).collect();
    let c = fit_points(&circle, 2.0, true);
    assert!(c.closed && c.points.len() >= 2 && c.points.len() <= 8, "{:?}", c.points);
    let b = bounds(&VectorPath { fill_rule: FillRule::Nonzero, subpaths: vec![c] }).unwrap();
    assert!((b[0] - 10.0).abs() < 2.5 && (b[2] - 90.0).abs() < 2.5, "{b:?}");
    assert!(fit_points(&[[1.0, 1.0], [1.0, 1.0]], 2.0, false).points.is_empty(), "one distinct point draws nothing");
}
