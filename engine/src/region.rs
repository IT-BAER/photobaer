//! Flood fill for the magic wand and paint bucket (docs/M2.md section 3 "Magic wand" and
//! section 4 "Paint bucket"): both share the same color-distance test and flood.

fn px_at(src: &[u8], p: usize) -> [u8; 4] {
    let o = p * 4;
    [src[o], src[o + 1], src[o + 2], src[o + 3]]
}

// Max channel difference over R,G,B,A, in 8-bit units: the magic wand / paint bucket color test.
fn dist(a: [u8; 4], b: [u8; 4]) -> u8 {
    (0..4).map(|i| a[i].abs_diff(b[i])).max().expect("4 channels")
}

fn hard_mask(src: &[u8], w: i32, h: i32, color: [u8; 4], tol: u8, contiguous: bool, seed: (i32, i32)) -> Vec<u8> {
    let within = |p: usize| dist(px_at(src, p), color) <= tol;
    let mut out = vec![0u8; (w * h) as usize];
    if !contiguous {
        for (p, v) in out.iter_mut().enumerate() {
            *v = within(p) as u8;
        }
        return out;
    }
    // 4-connected fill from the seed pixel (equivalent result to a scanline fill).
    let mut stack = vec![seed];
    out[(seed.1 * w + seed.0) as usize] = 1;
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let idx = (ny * w + nx) as usize;
            if out[idx] == 0 && within(idx) {
                out[idx] = 1;
                stack.push((nx, ny));
            }
        }
    }
    out
}

// 3x3 box average of the hard mask, restricted to border pixels (a hard pixel with a
// differently-valued 4-neighbour); interior pixels keep their hard 0/1 value.
fn soften_border(hard: &[u8], w: i32, h: i32) -> Vec<f32> {
    let at = |x: i32, y: i32| -> u8 {
        if x < 0 || y < 0 || x >= w || y >= h {
            0
        } else {
            hard[(y * w + x) as usize]
        }
    };
    let mut out = vec![0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let v = at(x, y);
            let border = [(1, 0), (-1, 0), (0, 1), (0, -1)].iter().any(|&(dx, dy)| at(x + dx, y + dy) != v);
            out[(y * w + x) as usize] = if border {
                let mut sum = 0u32;
                for dy in -1..=1 {
                    for dx in -1..=1 {
                        sum += at(x + dx, y + dy) as u32;
                    }
                }
                sum as f32 / 9.0
            } else {
                v as f32
            };
        }
    }
    out
}

/// Coverage (0..1) of a flood fill from `seed` over an RGBA8 buffer (16-bit sources are
/// normalized down to 8-bit units by the caller, so tolerance stays in one scale). Contiguous is
/// a 4-connected fill from the seed pixel; non-contiguous takes every pixel within tolerance.
/// Antialias gives the hard mask's border pixels (see `soften_border`) a soft 1-pixel edge.
pub fn flood(src: &[u8], w: u32, h: u32, seed: (u32, u32), tolerance: u8, contiguous: bool, antialias: bool) -> Vec<f32> {
    let (w, h) = (w as i32, h as i32);
    let color = px_at(src, (seed.1 as i32 * w + seed.0 as i32) as usize);
    let hard = hard_mask(src, w, h, color, tolerance, contiguous, (seed.0 as i32, seed.1 as i32));
    if antialias {
        soften_border(&hard, w, h)
    } else {
        hard.iter().map(|&v| v as f32).collect()
    }
}

// Per-channel min/max of the pixels `seeds` marks, used by grow/similar as a single widened
// tolerance band instead of testing every seed color individually (too slow per docs/M2.md).
fn seed_range(src: &[u8], seeds: &[bool]) -> ([u8; 4], [u8; 4]) {
    let mut lo = [255u8; 4];
    let mut hi = [0u8; 4];
    for (p, &is_seed) in seeds.iter().enumerate() {
        if !is_seed {
            continue;
        }
        let c = px_at(src, p);
        for i in 0..4 {
            lo[i] = lo[i].min(c[i]);
            hi[i] = hi[i].max(c[i]);
        }
    }
    (lo, hi)
}

fn in_range(c: [u8; 4], lo: [u8; 4], hi: [u8; 4], tol: u8) -> bool {
    (0..4).all(|i| c[i].saturating_add(tol) >= lo[i] && c[i] <= hi[i].saturating_add(tol))
}

/// Grow (contiguous) / similar (non-contiguous): pixels within `tolerance` of the seed colors'
/// per-channel range join the result, docs/M2.md magic wand family. `seeds` are the pixels
/// already selected (>= 0.5 coverage); the result is meant to be added to the selection.
pub fn grow_similar(src: &[u8], w: u32, h: u32, seeds: &[bool], tolerance: u8, contiguous: bool) -> Vec<f32> {
    let (w, h) = (w as i32, h as i32);
    let (lo, hi) = seed_range(src, seeds);
    let within = |p: usize| in_range(px_at(src, p), lo, hi, tolerance);
    if !contiguous {
        return (0..seeds.len()).map(|p| within(p) as u8 as f32).collect();
    }
    let mut out = vec![0u8; seeds.len()];
    let mut stack = Vec::new();
    for (p, &s) in seeds.iter().enumerate() {
        if s {
            out[p] = 1;
            stack.push((p as i32 % w, p as i32 / w));
        }
    }
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
            let (nx, ny) = (x + dx, y + dy);
            if nx < 0 || ny < 0 || nx >= w || ny >= h {
                continue;
            }
            let idx = (ny * w + nx) as usize;
            if out[idx] == 0 && within(idx) {
                out[idx] = 1;
                stack.push((nx, ny));
            }
        }
    }
    out.iter().map(|&v| v as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    // 8x8 fixture: left half red (255,0,0,255), right half blue (0,0,255,255).
    fn two_regions() -> Vec<u8> {
        let mut buf = vec![0u8; 8 * 8 * 4];
        for y in 0..8 {
            for x in 0..8 {
                let o = (y * 8 + x) * 4;
                let c: [u8; 4] = if x < 4 { [255, 0, 0, 255] } else { [0, 0, 255, 255] };
                buf[o..o + 4].copy_from_slice(&c);
            }
        }
        buf
    }

    #[test]
    fn contiguous_flood_selects_only_the_seed_region() {
        let buf = two_regions();
        let cov = flood(&buf, 8, 8, (0, 0), 32, true, false);
        for y in 0..8 {
            for x in 0..8 {
                assert_eq!(cov[y * 8 + x], if x < 4 { 1.0 } else { 0.0 }, "x={x} y={y}");
            }
        }
    }

    #[test]
    fn non_contiguous_flood_needs_no_shared_border() {
        // A red pixel disconnected from the seed region still joins when non-contiguous.
        let mut buf = two_regions();
        let o = (0 * 8 + 7) * 4;
        buf[o..o + 4].copy_from_slice(&[255, 0, 0, 255]);
        let contiguous = flood(&buf, 8, 8, (0, 0), 32, true, false);
        assert_eq!(contiguous[7], 0.0, "the stray red pixel is not 4-connected to the seed");
        let non_contiguous = flood(&buf, 8, 8, (0, 0), 32, false, false);
        assert_eq!(non_contiguous[7], 1.0, "non-contiguous ignores connectivity");
    }

    #[test]
    fn tolerance_edge_cases_0_and_255() {
        let buf = two_regions();
        // Tolerance 0: only exact matches to the seed color.
        let cov0 = flood(&buf, 8, 8, (0, 0), 0, false, false);
        assert_eq!(cov0.iter().filter(|&&v| v > 0.0).count(), 32, "exactly the red half");
        // Tolerance 255: everything within reach, i.e. the whole image.
        let cov255 = flood(&buf, 8, 8, (0, 0), 255, false, false);
        assert!(cov255.iter().all(|&v| v == 1.0));
    }

    #[test]
    fn antialias_softens_only_the_border() {
        let buf = two_regions();
        let cov = flood(&buf, 8, 8, (0, 0), 32, true, true);
        // Interior of the red region stays hard 1.
        assert_eq!(cov[1 * 8 + 1], 1.0);
        // The border column (x=3, next to the blue region) gets partial coverage: a 3x3 box of
        // an 8-wide hard edge at x=3/4 has 6 of 9 cells inside (excluding the top/bottom rows'
        // out-of-canvas neighbours only at y=0/7).
        assert!(cov[3 * 8 + 3] > 0.0 && cov[3 * 8 + 3] < 1.0, "{}", cov[3 * 8 + 3]);
        assert_eq!(cov[3 * 8 + 7], 0.0, "far side of the blue region stays hard 0");
    }

    #[test]
    fn grow_widens_by_the_seed_colors_range_contiguous() {
        // Three vertical stripes: 0, 40, 200 (channel R only, G=B=A fixed).
        let w = 6u32;
        let mut buf = vec![0u8; (w * 1 * 4) as usize];
        let vals = [0u8, 0, 40, 40, 200, 200];
        for (x, v) in vals.iter().enumerate() {
            let o = x * 4;
            buf[o..o + 4].copy_from_slice(&[*v, 0, 0, 255]);
        }
        let mut seeds = vec![false; 6];
        seeds[0] = true; // seed color 0
        let cov = grow_similar(&buf, w, 1, &seeds, 40, true);
        // Range is [0,0] widened by 40 -> [0,40], reaching x=2,3 (value 40) but not x=4,5 (200).
        assert_eq!(cov, vec![1.0, 1.0, 1.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn similar_ignores_connectivity() {
        let w = 4u32;
        let buf: Vec<u8> = [0u8, 0, 0, 255, 200, 0, 0, 255, 0, 0, 0, 255, 200, 0, 0, 255].to_vec();
        let seeds = vec![true, false, false, false];
        let cov = grow_similar(&buf, w, 1, &seeds, 0, false);
        assert_eq!(cov, vec![1.0, 0.0, 1.0, 0.0], "the disconnected matching pixel still joins");
    }
}
