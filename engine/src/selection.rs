//! Shape coverage for the selection mask (docs/M2.md section 3) and the feather kernel.
//! Coverage is 0..1 per document pixel; a pixel is the unit square [x, x+1) x [y, y+1).

// Sub-samples per pixel along the axis an analytic shape cannot integrate exactly.
const SUB: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    New,
    Add,
    Subtract,
    Intersect,
}

impl Mode {
    pub fn parse(s: &str) -> Result<Mode, String> {
        match s {
            "new" => Ok(Mode::New),
            "add" => Ok(Mode::Add),
            "subtract" => Ok(Mode::Subtract),
            "intersect" => Ok(Mode::Intersect),
            other => Err(format!("unknown selection mode {other}")),
        }
    }

    /// Fuzzy-set combination of the old coverage with the new shape's coverage.
    pub fn combine(self, old: f32, c: f32) -> f32 {
        match self {
            Mode::New => c,
            Mode::Add => old.max(c),
            Mode::Subtract => old.min(1.0 - c),
            Mode::Intersect => old.min(c),
        }
    }

    /// Whether coverage 0 leaves the old value alone (add, subtract) or clears it (new, intersect).
    pub fn keeps_untouched(self) -> bool {
        matches!(self, Mode::Add | Mode::Subtract)
    }
}

pub trait Shape {
    /// Document pixel rect that can have coverage > 0, as x0, y0, x1, y1 (upper bounds exclusive).
    fn bounds(&self) -> (f64, f64, f64, f64);
    /// Coverage of the pixels x0 .. x0 + out.len() of row y, written into `out`.
    fn row(&self, y: i32, x0: i32, out: &mut [f32]);
}

/// Axis-aligned rectangle of float document pixels; coverage is the exact overlap area, so
/// integer edges give hard 0/1 pixels.
pub struct Rect {
    pub x0: f64,
    pub y0: f64,
    pub x1: f64,
    pub y1: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x0: x.min(x + w), y0: y.min(y + h), x1: x.max(x + w), y1: y.max(y + h) }
    }
}

fn overlap(a0: f64, a1: f64, b0: f64, b1: f64) -> f64 {
    (a1.min(b1) - a0.max(b0)).clamp(0.0, 1.0)
}

impl Shape for Rect {
    fn bounds(&self) -> (f64, f64, f64, f64) {
        (self.x0, self.y0, self.x1, self.y1)
    }

    fn row(&self, y: i32, x0: i32, out: &mut [f32]) {
        let cy = overlap(self.y0, self.y1, y as f64, y as f64 + 1.0);
        for (i, v) in out.iter_mut().enumerate() {
            let x = (x0 + i as i32) as f64;
            *v = (overlap(self.x0, self.x1, x, x + 1.0) * cy) as f32;
        }
    }
}

/// Ellipse inscribed in the rect. Anti-aliased coverage integrates the exact vertical extent over
/// `SUB` sub-columns per pixel; without anti-aliasing the pixel centre decides.
pub struct Ellipse {
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    aa: bool,
}

impl Ellipse {
    pub fn new(x: f64, y: f64, w: f64, h: f64, aa: bool) -> Ellipse {
        Ellipse { cx: x + w / 2.0, cy: y + h / 2.0, rx: (w / 2.0).abs(), ry: (h / 2.0).abs(), aa }
    }
}

impl Shape for Ellipse {
    fn bounds(&self) -> (f64, f64, f64, f64) {
        (self.cx - self.rx, self.cy - self.ry, self.cx + self.rx, self.cy + self.ry)
    }

    fn row(&self, y: i32, x0: i32, out: &mut [f32]) {
        if self.rx <= 0.0 || self.ry <= 0.0 {
            out.fill(0.0);
            return;
        }
        let (ylo, yhi) = (y as f64, y as f64 + 1.0);
        for (i, v) in out.iter_mut().enumerate() {
            let x = (x0 + i as i32) as f64;
            if !self.aa {
                let (dx, dy) = ((x + 0.5 - self.cx) / self.rx, (ylo + 0.5 - self.cy) / self.ry);
                *v = if dx * dx + dy * dy <= 1.0 { 1.0 } else { 0.0 };
                continue;
            }
            let mut acc = 0.0;
            for k in 0..SUB {
                let sx = (x + (k as f64 + 0.5) / SUB as f64 - self.cx) / self.rx;
                if sx * sx >= 1.0 {
                    continue;
                }
                let half = self.ry * (1.0 - sx * sx).sqrt();
                acc += ((self.cy + half).min(yhi) - (self.cy - half).max(ylo)).max(0.0);
            }
            *v = (acc / SUB as f64).min(1.0) as f32;
        }
    }
}

/// Closed polygon, even-odd fill. Anti-aliased coverage is exact horizontally and sampled over
/// `SUB` sub-scanlines per pixel row; without anti-aliasing the pixel centre decides.
pub struct Polygon {
    pts: Vec<(f64, f64)>,
    aa: bool,
}

impl Polygon {
    pub fn new(flat: &[f64], aa: bool) -> Result<Polygon, String> {
        if flat.len() % 2 != 0 {
            return Err("polygon points need an x and a y each".into());
        }
        if flat.len() < 6 {
            return Err("a polygon needs at least three points".into());
        }
        if flat.iter().any(|v| !v.is_finite()) {
            return Err("polygon points must be finite".into());
        }
        Ok(Polygon { pts: flat.chunks_exact(2).map(|p| (p[0], p[1])).collect(), aa })
    }

    // The x coordinates where the polygon crosses the horizontal line `yy`, sorted.
    fn crossings(&self, yy: f64, out: &mut Vec<f64>) {
        out.clear();
        for i in 0..self.pts.len() {
            let (ax, ay) = self.pts[i];
            let (bx, by) = self.pts[(i + 1) % self.pts.len()];
            if (ay <= yy) == (by <= yy) {
                continue;
            }
            out.push(ax + (yy - ay) / (by - ay) * (bx - ax));
        }
        out.sort_by(|a, b| a.partial_cmp(b).expect("finite crossings"));
    }
}

impl Shape for Polygon {
    fn bounds(&self) -> (f64, f64, f64, f64) {
        let mut b = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for &(x, y) in &self.pts {
            b = (b.0.min(x), b.1.min(y), b.2.max(x), b.3.max(y));
        }
        b
    }

    fn row(&self, y: i32, x0: i32, out: &mut [f32]) {
        out.fill(0.0);
        let subs = if self.aa { SUB } else { 1 };
        let weight = 1.0 / subs as f64;
        let mut xs = Vec::new();
        for k in 0..subs {
            let yy = y as f64 + (k as f64 + 0.5) / subs as f64;
            self.crossings(yy, &mut xs);
            for span in xs.chunks_exact(2) {
                let (mut a, b) = (span[0], span[1]);
                a = a.max(x0 as f64);
                let b = b.min((x0 + out.len() as i32) as f64);
                if !(a < b) {
                    continue;
                }
                let (first, last) = (a.floor() as i32, (b - 1e-12).floor() as i32);
                for px in first..=last {
                    let i = (px - x0) as usize;
                    if i >= out.len() {
                        break;
                    }
                    if self.aa {
                        let cover = b.min(px as f64 + 1.0) - a.max(px as f64);
                        out[i] += (cover.max(0.0) * weight) as f32;
                    } else if (px as f64 + 0.5) >= a && (px as f64 + 0.5) < b {
                        out[i] = 1.0;
                    }
                }
            }
        }
        for v in out.iter_mut() {
            *v = v.min(1.0);
        }
    }
}

/// Coverage from an arbitrary precomputed buffer (flood fill, grow/similar, color range...),
/// full document size, origin (0, 0); pixels outside `w`x`h` are 0.
pub struct MaskShape {
    w: i32,
    h: i32,
    data: Vec<f32>,
}

impl MaskShape {
    pub fn new(w: i32, h: i32, data: Vec<f32>) -> MaskShape {
        assert_eq!(data.len(), (w * h) as usize, "mask buffer size must match w*h");
        MaskShape { w, h, data }
    }
}

impl Shape for MaskShape {
    fn bounds(&self) -> (f64, f64, f64, f64) {
        (0.0, 0.0, self.w as f64, self.h as f64)
    }

    fn row(&self, y: i32, x0: i32, out: &mut [f32]) {
        if y < 0 || y >= self.h {
            out.fill(0.0);
            return;
        }
        for (i, v) in out.iter_mut().enumerate() {
            let x = x0 + i as i32;
            *v = if x < 0 || x >= self.w { 0.0 } else { self.data[(y * self.w + x) as usize] };
        }
    }
}

/// Normalized 1D Gaussian with sigma = radius / 3, truncated at 3 sigma, so the visible falloff
/// ends at `radius` pixels. Always an odd length.
pub fn gaussian_kernel(radius: f64) -> Vec<f32> {
    let sigma = (radius / 3.0).max(1e-3);
    let k = radius.ceil().max(1.0) as usize;
    let mut w: Vec<f32> = (0..=2 * k)
        .map(|i| {
            let d = i as f64 - k as f64;
            (-(d * d) / (2.0 * sigma * sigma)).exp() as f32
        })
        .collect();
    let sum: f32 = w.iter().sum();
    w.iter_mut().for_each(|v| *v /= sum);
    w
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cover(s: &dyn Shape, w: i32, h: i32) -> Vec<f32> {
        let mut out = vec![0f32; (w * h) as usize];
        for y in 0..h {
            s.row(y, 0, &mut out[(y * w) as usize..((y + 1) * w) as usize]);
        }
        out
    }

    #[test]
    fn rect_coverage_is_the_exact_overlap_area() {
        let c = cover(&Rect::new(0.5, 0.25, 2.0, 1.0), 4, 3);
        assert!((c[0] - 0.5 * 0.75).abs() < 1e-6, "{}", c[0]);
        assert!((c[1] - 0.75).abs() < 1e-6);
        assert!((c[4] - 0.5 * 0.25).abs() < 1e-6);
        assert!((c[3]).abs() < 1e-6);
        let hard = cover(&Rect::new(1.0, 0.0, 2.0, 2.0), 4, 2);
        assert_eq!(hard, vec![0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0]);
    }

    #[test]
    fn ellipse_coverage_sums_to_its_area() {
        let (a, b) = (30.5, 18.25);
        let c = cover(&Ellipse::new(4.0, 6.0, 2.0 * a, 2.0 * b, true), 80, 60);
        let sum: f64 = c.iter().map(|v| *v as f64).sum();
        let area = std::f64::consts::PI * a * b;
        assert!((sum - area).abs() < area * 2e-3, "sum {sum}, area {area}");
    }

    #[test]
    fn polygon_triangle_coverage_sums_to_its_area() {
        let tri = Polygon::new(&[2.0, 1.0, 22.0, 5.0, 6.0, 17.0], true).unwrap();
        let c = cover(&tri, 30, 20);
        let sum: f64 = c.iter().map(|v| *v as f64).sum();
        // Shoelace area of the triangle.
        let area = 0.5f64 * ((22.0f64 - 2.0) * (17.0 - 1.0) - (6.0 - 2.0) * (5.0 - 1.0)).abs();
        assert!((sum - area).abs() < area * 5e-3, "sum {sum}, area {area}");
    }

    #[test]
    fn polygon_even_odd_leaves_a_hole() {
        // A square with a smaller square wound the same way: even-odd cuts the inner one out.
        let p = Polygon::new(&[0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0], false).unwrap();
        let c = cover(&p, 12, 12);
        assert_eq!(c[5 * 12 + 5], 1.0);
        let ring = Polygon::new(
            &[0.0, 0.0, 10.0, 0.0, 10.0, 10.0, 0.0, 10.0, 0.0, 0.0, 3.0, 3.0, 7.0, 3.0, 7.0, 7.0, 3.0, 7.0],
            false,
        )
        .unwrap();
        let c = cover(&ring, 12, 12);
        assert_eq!(c[5 * 12 + 5], 0.0, "the inner square is a hole");
        assert_eq!(c[1 * 12 + 1], 1.0);
    }

    #[test]
    fn mask_shape_reads_the_buffer_and_clips_outside_bounds() {
        let s = MaskShape::new(2, 2, vec![0.25, 0.5, 0.75, 1.0]);
        assert_eq!(s.bounds(), (0.0, 0.0, 2.0, 2.0));
        let c = cover(&s, 2, 2);
        assert_eq!(c, vec![0.25, 0.5, 0.75, 1.0]);
        let mut out = vec![9.0; 4];
        s.row(-1, 0, &mut out);
        assert_eq!(out, vec![0.0; 4]);
    }

    #[test]
    fn modes_combine_as_fuzzy_sets() {
        assert_eq!(Mode::parse("intersect").unwrap(), Mode::Intersect);
        assert!(Mode::parse("nope").is_err());
        assert_eq!(Mode::Add.combine(0.25, 0.5), 0.5);
        assert_eq!(Mode::Subtract.combine(1.0, 0.25), 0.75);
        assert_eq!(Mode::Intersect.combine(0.25, 0.5), 0.25);
        assert_eq!(Mode::New.combine(1.0, 0.5), 0.5);
    }

    #[test]
    fn gaussian_kernel_is_normalized_and_symmetric() {
        let k = gaussian_kernel(6.0);
        assert_eq!(k.len(), 13);
        assert!((k.iter().sum::<f32>() - 1.0).abs() < 1e-6);
        for i in 0..k.len() {
            assert!((k[i] - k[k.len() - 1 - i]).abs() < 1e-7);
        }
        assert!(k[6] > k[5] && k[5] > k[0]);
    }
}
