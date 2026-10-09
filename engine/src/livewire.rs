//! Magnetic lasso (live wire) and quick selection (docs/M2.md section 3). Both snap to image
//! edges, so they share one gradient field over the sampled RGBA8 image.

use std::collections::BinaryHeap;

/// Sobel gradient of the strongest premultiplied channel (R, G, B or alpha) per pixel: `mag`
/// normalized to 0..1 over the whole image, `gx`/`gy` raw so the live wire can use the direction.
pub struct LiveWire {
    w: i32,
    h: i32,
    mag: Vec<f32>,
    gx: Vec<f32>,
    gy: Vec<f32>,
}

// Premultiplied, so a shape on transparency has an edge and transparent pixels of different
// colours (straight RGBA keeps the old RGB under alpha 0) do not.
fn premultiplied(src: &[u8]) -> Vec<[f32; 4]> {
    src.chunks_exact(4)
        .map(|p| {
            let a = p[3] as f32 / 255.0;
            [p[0] as f32 * a, p[1] as f32 * a, p[2] as f32 * a, p[3] as f32]
        })
        .collect()
}

fn sobel(src: &[u8], w: i32, h: i32) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
    let ch = premultiplied(src);
    let at = |x: i32, y: i32| ch[(y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) as usize];
    let n = (w * h) as usize;
    let (mut gx, mut gy, mut mag) = (vec![0f32; n], vec![0f32; n], vec![0f32; n]);
    let mut top = 1e-6f32;
    for y in 0..h {
        for x in 0..w {
            let (nw, nn, ne) = (at(x - 1, y - 1), at(x, y - 1), at(x + 1, y - 1));
            let (ww, ee) = (at(x - 1, y), at(x + 1, y));
            let (sw, ss, se) = (at(x - 1, y + 1), at(x, y + 1), at(x + 1, y + 1));
            let p = (y * w + x) as usize;
            for c in 0..4 {
                let dx = ne[c] + 2.0 * ee[c] + se[c] - nw[c] - 2.0 * ww[c] - sw[c];
                let dy = sw[c] + 2.0 * ss[c] + se[c] - nw[c] - 2.0 * nn[c] - ne[c];
                let m = (dx * dx + dy * dy).sqrt();
                if m > mag[p] {
                    (gx[p], gy[p], mag[p]) = (dx, dy, m);
                }
            }
            top = top.max(mag[p]);
        }
    }
    for m in mag.iter_mut() {
        *m /= top;
    }
    (gx, gy, mag)
}

// Dijkstra queue entry; f32 costs are compared through their bits, which order like the floats
// for the non-negative costs used here.
#[derive(PartialEq, Eq)]
struct Node(u32, u32);

impl Ord for Node {
    fn cmp(&self, other: &Node) -> std::cmp::Ordering {
        other.0.cmp(&self.0)
    }
}

impl PartialOrd for Node {
    fn partial_cmp(&self, other: &Node) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn seg_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let (vx, vy) = (bx - ax, by - ay);
    let len2 = vx * vx + vy * vy;
    let t = if len2 <= 0.0 { 0.0 } else { (((px - ax) * vx + (py - ay) * vy) / len2).clamp(0.0, 1.0) };
    let (dx, dy) = (px - ax - t * vx, py - ay - t * vy);
    (dx * dx + dy * dy).sqrt()
}

impl LiveWire {
    pub fn new(src: &[u8], w: u32, h: u32) -> LiveWire {
        let (w, h) = (w as i32, h as i32);
        let (gx, gy, mag) = sobel(src, w, h);
        LiveWire { w, h, mag, gx, gy }
    }

    // Unit vector along the edge (perpendicular to the gradient), or None where there is no edge.
    fn edge_dir(&self, p: usize) -> Option<(f32, f32)> {
        let (gx, gy) = (self.gx[p], self.gy[p]);
        let len = (gx * gx + gy * gy).sqrt();
        if len <= 1e-6 {
            None
        } else {
            Some((gy / len, -gx / len))
        }
    }

    /// Cheapest 8-connected path from `from` to `to` inside a corridor of `band_width` pixels
    /// around their straight segment. Cost per step = 0.7 * (1 - gradient) + 0.2 * direction
    /// mismatch + 0.1, times the step length. `contrast` (0..100 %) zeroes weaker gradients.
    pub fn path(&self, from: (i32, i32), to: (i32, i32), band_width: u32, contrast: u8) -> Vec<(i32, i32)> {
        let clamp = |(x, y): (i32, i32)| (x.clamp(0, self.w - 1), y.clamp(0, self.h - 1));
        let (from, to) = (clamp(from), clamp(to));
        let band = band_width.max(1) as i32;
        let (bx0, by0) = ((from.0.min(to.0) - band).max(0), (from.1.min(to.1) - band).max(0));
        let (bx1, by1) = ((from.0.max(to.0) + band).min(self.w - 1), (from.1.max(to.1) + band).min(self.h - 1));
        let (bw, bh) = ((bx1 - bx0 + 1) as usize, (by1 - by0 + 1) as usize);
        let floor = contrast.min(100) as f32 / 100.0;
        let inside = |x: i32, y: i32| {
            seg_dist(x as f64, y as f64, from.0 as f64, from.1 as f64, to.0 as f64, to.1 as f64) <= band as f64 + 0.5
        };
        let idx = |x: i32, y: i32| ((y - by0) as usize) * bw + (x - bx0) as usize;

        let mut dist = vec![f32::INFINITY; bw * bh];
        let mut prev = vec![u32::MAX; bw * bh];
        let mut done = vec![false; bw * bh];
        let mut heap = BinaryHeap::new();
        dist[idx(from.0, from.1)] = 0.0;
        heap.push(Node(0, idx(from.0, from.1) as u32));
        let goal = idx(to.0, to.1);
        while let Some(Node(_, at)) = heap.pop() {
            let at = at as usize;
            if done[at] {
                continue;
            }
            done[at] = true;
            if at == goal {
                break;
            }
            let (px, py) = ((at % bw) as i32 + bx0, (at / bw) as i32 + by0);
            let pdir = self.edge_dir((py * self.w + px) as usize);
            for dy in -1..=1i32 {
                for dx in -1..=1i32 {
                    if dx == 0 && dy == 0 {
                        continue;
                    }
                    let (qx, qy) = (px + dx, py + dy);
                    if qx < bx0 || qx > bx1 || qy < by0 || qy > by1 || !inside(qx, qy) {
                        continue;
                    }
                    let q = (qy * self.w + qx) as usize;
                    let step = ((dx * dx + dy * dy) as f32).sqrt();
                    let (lx, ly) = (dx as f32 / step, dy as f32 / step);
                    let m = if self.mag[q] < floor { 0.0 } else { self.mag[q] };
                    // Direction term: how far the link runs across the edge rather than along it;
                    // 0.5 where there is no gradient to follow.
                    let along = |d: Option<(f32, f32)>| match d {
                        Some((ex, ey)) => (ex * lx + ey * ly).abs().clamp(0.0, 1.0).acos() * 2.0 / std::f32::consts::PI,
                        None => 0.5,
                    };
                    let fd = 0.5 * (along(pdir) + along(self.edge_dir(q)));
                    let cost = dist[at] + (0.7 * (1.0 - m) + 0.2 * fd + 0.1) * step;
                    let qi = idx(qx, qy);
                    if cost < dist[qi] {
                        dist[qi] = cost;
                        prev[qi] = at as u32;
                        heap.push(Node(cost.to_bits(), qi as u32));
                    }
                }
            }
        }
        if !done[goal] {
            return vec![from, to];
        }
        let mut out = Vec::new();
        let mut at = goal;
        loop {
            out.push(((at % bw) as i32 + bx0, (at / bw) as i32 + by0));
            if at == idx(from.0, from.1) {
                break;
            }
            at = prev[at] as usize;
        }
        out.reverse();
        out
    }
}

/// Index in `path` where the next automatic anchor belongs: anchors land about every
/// `101 - frequency` pixels of path length. `None` while the path is still shorter than that.
pub fn suggest_anchor(path: &[(i32, i32)], frequency: u8) -> Option<usize> {
    let spacing = (101 - frequency.min(100) as i32) as f64;
    let mut run = 0.0;
    for i in 1..path.len() {
        let (dx, dy) = ((path[i].0 - path[i - 1].0) as f64, (path[i].1 - path[i - 1].1) as f64);
        run += (dx * dx + dy * dy).sqrt();
        if run >= spacing {
            return Some(i);
        }
    }
    None
}

/// Quick selection (docs/M2.md section 3): the pixels under the stroke give a per-channel mean
/// and stddev, then a contiguous grow accepts neighbours within 2.5 stddevs that are not sitting
/// on a strong edge. `auto_enhance` rounds the result off (smooth 2) and feathers it by 1 px.
pub fn quick_select(
    src: &[u8],
    w: u32,
    h: u32,
    stroke: &[(f64, f64)],
    radius: f64,
    auto_enhance: bool,
) -> Result<Vec<f32>, String> {
    if stroke.is_empty() {
        return Err("quick selection needs at least one stroke point".into());
    }
    // Transparency is composited over mid gray, so it is a colour of its own and the RGB left
    // under alpha 0 never matches.
    let src: &[u8] = &src
        .chunks_exact(4)
        .flat_map(|p| {
            let a = p[3] as u32;
            let c = |v: u8| ((v as u32 * a + 128 * (255 - a) + 127) / 255) as u8;
            [c(p[0]), c(p[1]), c(p[2]), 255]
        })
        .collect::<Vec<u8>>();
    let (wi, hi) = (w as i32, h as i32);
    let n = (wi * hi) as usize;
    let r = radius.max(0.5);
    let mut seed = vec![false; n];
    // Each segment (or the lone point) marks the pixel centers within `r`, over its own bounds only.
    let segs: Vec<((f64, f64), (f64, f64))> = if stroke.len() == 1 {
        vec![(stroke[0], stroke[0])]
    } else {
        stroke.windows(2).map(|s| (s[0], s[1])).collect()
    };
    for (a, b) in segs {
        let bx0 = ((a.0.min(b.0) - r).floor() as i32).max(0);
        let by0 = ((a.1.min(b.1) - r).floor() as i32).max(0);
        let bx1 = ((a.0.max(b.0) + r).ceil() as i32).min(wi - 1);
        let by1 = ((a.1.max(b.1) + r).ceil() as i32).min(hi - 1);
        for y in by0..=by1 {
            for x in bx0..=bx1 {
                if seg_dist(x as f64 + 0.5, y as f64 + 0.5, a.0, a.1, b.0, b.1) <= r {
                    seed[(y * wi + x) as usize] = true;
                }
            }
        }
    }
    if !seed.iter().any(|&s| s) {
        return Err("the quick selection stroke is outside the canvas".into());
    }

    let mut sum = [0f64; 3];
    let mut sq = [0f64; 3];
    let mut count = 0f64;
    for (p, _) in seed.iter().enumerate().filter(|&(_, &s)| s) {
        for c in 0..3 {
            let v = src[p * 4 + c] as f64;
            sum[c] += v;
            sq[c] += v * v;
        }
        count += 1.0;
    }
    let mut mean = [0f32; 3];
    let mut sd = [0f32; 3];
    for c in 0..3 {
        let m = sum[c] / count;
        mean[c] = m as f32;
        // Floor the spread so a perfectly uniform stroke does not reject every neighbour.
        sd[c] = ((sq[c] / count - m * m).max(0.0).sqrt() as f32).max(8.0);
    }
    let color_dist = |p: usize| {
        (0..3)
            .map(|c| (src[p * 4 + c] as f32 - mean[c]).abs() / sd[c])
            .fold(0f32, f32::max)
    };

    let (_, _, mag) = sobel(src, wi, hi);
    let mut out = vec![0f32; n];
    let mut stack: Vec<usize> = Vec::new();
    for (p, _) in seed.iter().enumerate().filter(|&(_, &s)| s) {
        out[p] = 1.0;
        stack.push(p);
    }
    while let Some(p) = stack.pop() {
        let (x, y) = ((p % wi as usize) as i32, (p / wi as usize) as i32);
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (qx, qy) = (x + dx, y + dy);
            if qx < 0 || qy < 0 || qx >= wi || qy >= hi {
                continue;
            }
            let q = (qy * wi + qx) as usize;
            if out[q] > 0.0 {
                continue;
            }
            let d = color_dist(q);
            // A strong edge only stops pixels whose color is already a stretch, so a clean
            // two-color border still selects its own side completely.
            if d >= 2.5 || (mag[q] > 0.5 && d > 1.25) {
                continue;
            }
            out[q] = 1.0;
            stack.push(q);
        }
    }
    if auto_enhance {
        out = crate::region::feather1(&crate::region::smooth(&out, w, h, 2, false), w as usize, h as usize);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Dark background with a bright square at [x0, x1) x [y0, y1).
    fn square(w: i32, h: i32, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8> {
        let mut src = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let p = ((y * w + x) * 4) as usize;
                let v = if x >= x0 && x < x1 && y >= y0 && y < y1 { 240 } else { 20 };
                src[p..p + 3].copy_from_slice(&[v, v, v]);
                src[p + 3] = 255;
            }
        }
        src
    }

    // Chebyshev distance to the nearest pixel of the square's boundary ring.
    fn dist_to_edge(x: i32, y: i32, x0: i32, y0: i32, x1: i32, y1: i32) -> i32 {
        let mut best = i32::MAX;
        for ey in y0..y1 {
            for ex in x0..x1 {
                if ex == x0 || ex == x1 - 1 || ey == y0 || ey == y1 - 1 {
                    best = best.min((ex - x).abs().max((ey - y).abs()));
                }
            }
        }
        best
    }

    #[test]
    fn path_hugs_the_edge_of_a_bright_square() {
        let src = square(40, 40, 10, 10, 30, 30);
        let lw = LiveWire::new(&src, 40, 40);
        // Two points on neighbouring edges: the straight segment cuts the corner off, an
        // edge-following path must go around it.
        let path = lw.path((10, 25), (25, 10), 12, 0);
        assert!(path.len() > 20, "path too short: {}", path.len());
        assert_eq!(path.first(), Some(&(10, 25)));
        assert_eq!(path.last(), Some(&(25, 10)));
        for &(x, y) in &path {
            let d = dist_to_edge(x, y, 10, 10, 30, 30);
            assert!(d <= 1, "path pixel ({x}, {y}) is {d} px off the edge");
        }
    }

    #[test]
    fn path_follows_the_visible_edge_not_the_color_left_under_transparency() {
        // Opaque orange square [10, 30) on a transparent layer; the transparent pixels at x in
        // [30, 36) still hold the orange (the square was moved), the rest hold black.
        let (w, h) = (48, 40);
        let mut src = vec![0u8; (w * h * 4) as usize];
        for y in 10..30 {
            for x in 10..36 {
                let p = ((y * w + x) * 4) as usize;
                src[p..p + 3].copy_from_slice(&[230, 160, 60]);
                src[p + 3] = if x < 30 { 255 } else { 0 };
            }
        }
        let lw = LiveWire::new(&src, w as u32, h as u32);
        let path = lw.path((25, 10), (25, 29), 12, 0);
        for &(x, y) in &path {
            let d = dist_to_edge(x, y, 10, 10, 30, 30);
            assert!(d <= 1, "path pixel ({x}, {y}) is {d} px off the visible edge");
        }
    }

    #[test]
    fn path_falls_back_to_the_straight_segment_when_the_corridor_is_blocked() {
        let src = square(8, 8, 2, 2, 6, 6);
        let lw = LiveWire::new(&src, 8, 8);
        // Clamped into the canvas; a zero-width band still yields a usable path.
        let p = lw.path((-5, 3), (100, 3), 1, 0);
        assert_eq!(p.first(), Some(&(0, 3)));
        assert_eq!(p.last(), Some(&(7, 3)));
    }

    #[test]
    fn suggest_anchor_spaces_anchors_by_frequency() {
        let path: Vec<(i32, i32)> = (0..50).map(|i| (i, 0)).collect();
        assert_eq!(suggest_anchor(&path, 81), Some(20));
        assert_eq!(suggest_anchor(&path, 1), None, "100 px spacing does not fit in a 49 px path");
        assert_eq!(suggest_anchor(&path, 100), Some(1));
    }

    // Left half color A, right half color B.
    fn split(w: i32, h: i32, mid: i32) -> Vec<u8> {
        let mut src = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let p = ((y * w + x) * 4) as usize;
                let c: [u8; 3] = if x < mid { [230, 60, 40] } else { [30, 40, 210] };
                src[p..p + 3].copy_from_slice(&c);
                src[p + 3] = 255;
            }
        }
        src
    }

    #[test]
    fn quick_select_on_transparency_takes_only_the_visible_shape() {
        // Opaque orange [0, 10) x [0, 10); every transparent pixel still holds the same orange.
        let (w, h) = (20, 10);
        let mut src = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let p = ((y * w + x) * 4) as usize;
                src[p..p + 4].copy_from_slice(&[230, 160, 60, if x < 10 { 255 } else { 0 }]);
            }
        }
        let cov = quick_select(&src, w as u32, h as u32, &[(3.5, 2.5), (3.5, 7.5)], 2.0, false).unwrap();
        for y in 0..h {
            for x in 0..w {
                let want = if x < 10 { 1.0 } else { 0.0 };
                assert_eq!(cov[(y * w + x) as usize], want, "pixel ({x}, {y})");
            }
        }
    }

    #[test]
    fn quick_select_takes_exactly_one_side_of_a_split() {
        let (w, h, mid) = (20, 10, 10);
        let src = split(w, h, mid);
        let cov = quick_select(&src, w as u32, h as u32, &[(3.5, 2.5), (3.5, 7.5)], 2.0, false).unwrap();
        for y in 0..h {
            for x in 0..w {
                let want = if x < mid { 1.0 } else { 0.0 };
                assert_eq!(cov[(y * w + x) as usize], want, "pixel ({x}, {y})");
            }
        }
        assert!(quick_select(&src, w as u32, h as u32, &[], 2.0, false).is_err());
        assert!(quick_select(&src, w as u32, h as u32, &[(-50.0, -50.0)], 2.0, false).is_err());
    }

    #[test]
    fn quick_select_auto_enhance_softens_the_edge() {
        let (w, h, mid) = (20, 10, 10);
        let src = split(w, h, mid);
        let cov = quick_select(&src, w as u32, h as u32, &[(3.5, 2.5), (3.5, 7.5)], 2.0, true).unwrap();
        let soft = cov.iter().filter(|v| **v > 0.0 && **v < 1.0).count();
        assert!(soft > 0, "auto enhance should feather the border");
        assert!(cov[5 * w as usize + 2] > 0.9, "the stroke's own side stays selected");
        assert!(cov[5 * w as usize + 17] < 0.05, "the other side stays out");
    }

    #[test]
    fn quick_select_auto_enhance_keeps_the_canvas_edge_selected() {
        let src = split(12, 12, 12);
        let cov = quick_select(&src, 12, 12, &[(5.5, 5.5)], 2.0, true).unwrap();
        assert!(cov.iter().all(|&v| v == 1.0), "a uniform image selects fully, edges included");
    }

    #[test]
    fn quick_select_long_stroke_on_a_big_canvas() {
        let (w, h) = (2000, 2000);
        let src = split(w, h, 1000);
        let stroke: Vec<(f64, f64)> = (0..200).map(|i| (10.0 + i as f64 * 4.0, 10.0 + i as f64 * 9.0)).collect();
        let cov = quick_select(&src, w as u32, h as u32, &stroke, 5.0, false).unwrap();
        assert_eq!(cov[1999 * w as usize], 1.0);
        assert_eq!(cov[1000], 0.0);
    }

    #[test]
    #[ignore = "timing check, run with --ignored in release"]
    fn magnetic_path_is_fast_on_a_big_document() {
        let (w, h) = (4000u32, 3000u32);
        let src = square(w as i32, h as i32, 1000, 1000, 3000, 2000);
        let lw = LiveWire::new(&src, w, h);
        let t = std::time::Instant::now();
        let p = lw.path((1000, 1100), (1000, 1200), 10, 0);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        assert!(p.len() > 50);
        // Measured 0.377 ms in release on a 4000x3000 doc; the corridor bounds the search.
        assert!(ms < 16.0, "magnetic_path took {ms} ms");
    }
}
