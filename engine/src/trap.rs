//! Image > Trap: in a CMYK document, lighter inks spread under darker neighbouring colors, so a
//! misregistered press leaves no paper gap at a color edge. Pixels are stored as sRGB; the trap runs
//! on their separation through the document's CMYK profile, and only trapped pixels change.

use super::color_mode::ColorMode;
use super::*;
use crate::icc::{Intent, Profile, SRGB, Space, Transform};
use std::collections::HashMap;

/// Neutral densities of solid cyan, magenta, yellow and black: which of two ink mixes is darker.
const DENSITY: [f32; 4] = [0.61, 0.76, 0.16, 1.70];
/// A neighbour at most this much denser still spreads (pure cyan and magenta trap both ways).
const SIMILAR: f32 = 1.3;
/// Trap Width limit in pixels; the work grows with its square.
pub const MAX_TRAP: u32 = 10;
const GRID: usize = 33;

fn inked(c: &[f32]) -> bool {
    c.iter().any(|&v| v > 1e-3)
}

fn density(c: &[f32]) -> f32 {
    (0..4).map(|i| c[i] * DENSITY[i]).sum()
}

/// Traps interleaved inks (`w` x `h`, C M Y K per pixel in 0..1) by `r` px: an inked pixel takes, per
/// ink, the most of every inked neighbour within `r` that is lighter or about as dark. Paper (no
/// ink) stays paper and black (K at least 95 %) does not spread.
pub(crate) fn trap_inks(inks: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut out = inks.to_vec();
    if r == 0 || w == 0 || h == 0 {
        return out;
    }
    let px = |i: usize| &inks[i * 4..i * 4 + 4];
    let ink: Vec<bool> = (0..w * h).map(|i| inked(px(i))).collect();
    let dens: Vec<f32> = (0..w * h).map(|i| density(px(i))).collect();
    // Pixels within `r` of a color edge; the rest have nothing to take.
    let edge: Vec<bool> = (0..w * h)
        .map(|i| {
            let (x, y) = (i % w, i / w);
            (x + 1 < w && px(i) != px(i + 1)) || (y + 1 < h && px(i) != px(i + w))
        })
        .collect();
    let mut near = vec![false; w * h];
    for y in 0..h {
        for x in 0..w {
            if !edge[y * w + x] {
                continue;
            }
            for yy in y.saturating_sub(r)..=(y + r + 1).min(h - 1) {
                near[yy * w + x.saturating_sub(r)..=yy * w + (x + r + 1).min(w - 1)].fill(true);
            }
        }
    }
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if !ink[i] || !near[i] {
                continue;
            }
            let limit = dens[i] * SIMILAR;
            for yy in y.saturating_sub(r)..=(y + r).min(h - 1) {
                for xx in x.saturating_sub(r)..=(x + r).min(w - 1) {
                    let j = yy * w + xx;
                    let q = px(j);
                    if j == i || !ink[j] || q[3] >= 0.95 || dens[j] > limit {
                        continue;
                    }
                    for c in 0..4 {
                        out[i * 4 + c] = out[i * 4 + c].max(q[c]);
                    }
                }
            }
        }
    }
    out
}

// Trilinear lookup of sRGB `c` in a GRID^3 separation table (red slowest), 4 inks out.
fn lookup(t: &[f32], c: [f32; 3]) -> [f32; 4] {
    let g = GRID - 1;
    let f = c.map(|v| v.clamp(0.0, 1.0) * g as f32);
    let i0 = f.map(|v| (v as usize).min(g - 1));
    let d = [f[0] - i0[0] as f32, f[1] - i0[1] as f32, f[2] - i0[2] as f32];
    let mut o = [0.0f32; 4];
    for corner in 0..8 {
        let (dr, dg, db) = (corner >> 2 & 1, corner >> 1 & 1, corner & 1);
        let wgt = [dr, dg, db].iter().enumerate().map(|(k, &s)| if s == 1 { d[k] } else { 1.0 - d[k] }).product::<f32>();
        let at = (((i0[0] + dr) * GRID + i0[1] + dg) * GRID + i0[2] + db) * 4;
        for (k, v) in o.iter_mut().enumerate() {
            *v += t[at + k] * wgt;
        }
    }
    o
}

impl Document {
    /// Image > Trap on pixel layer `id` with a trap of `width` px (1..=MAX_TRAP); false when nothing
    /// changed. Needs a CMYK document. With a selection only the selected pixels change.
    pub fn trap(&mut self, id: u32, width: u32) -> Result<bool, String> {
        self.check_idle()?;
        if self.vector.mode != Some(ColorMode::Cmyk) {
            return Err("Trap needs a CMYK document (Image > Mode > CMYK Color).".into());
        }
        if !(1..=MAX_TRAP).contains(&width) {
            return Err(format!("The trap width must be 1 to {MAX_TRAP} pixels."));
        }
        self.check_pixel_paint(id)?;
        let Some([x0, y0, w, h]) = self.layer_bounds(id)? else { return Ok(false) };
        let cmyk = self.vector.profile.as_ref().and_then(|p| p.resolve().ok()).filter(|p| p.space == Space::Cmyk);
        let cmyk = cmyk.unwrap_or_else(|| Profile::builtin(crate::icc::COATED_CMYK).expect("built in"));
        let srgb = Profile::builtin(SRGB).expect("built in");
        let to_ink = Transform::new(&srgb, &cmyk, Intent::Relative, true)?;
        let back = Transform::new(&cmyk, &srgb, Intent::Relative, true)?;
        let step = 1.0 / (GRID - 1) as f64;
        let mut table = Vec::with_capacity(GRID * GRID * GRID * 4);
        let mut o = [0.0f64; 4];
        for r in 0..GRID {
            for g in 0..GRID {
                for b in 0..GRID {
                    to_ink.apply(&[r as f64 * step, g as f64 * step, b as f64 * step], &mut o);
                    table.extend(o.map(|v| v.clamp(0.0, 1.0) as f32));
                }
            }
        }
        let r = width as i32;
        let tiles = self.node(id)?.pixel_tiles()?;
        let rgba = |x: i32, y: i32| -> [f32; 4] {
            let (tx, ty) = (x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
            let p = (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize;
            tiles.get(tx, ty).map_or([0.0; 4], |t| t.px.rgba_f32(p))
        };
        // Per tile: its pixels and an apron of `r` (inside the layer bounds) as inks, trapped; the
        // tile's changed pixels go back as sRGB.
        let mut changed: HashMap<(i32, i32), HashMap<usize, [f32; 3]>> = HashMap::new();
        for (tx, ty) in tiles.coords() {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let (ax, ay) = ((ox - r).max(x0), (oy - r).max(y0));
            let (bx, by) = ((ox + TILE as i32 + r).min(x0 + w), (oy + TILE as i32 + r).min(y0 + h));
            if bx <= ax || by <= ay {
                continue;
            }
            let (rw, rh) = ((bx - ax) as usize, (by - ay) as usize);
            let mut inks = vec![0f32; rw * rh * 4];
            for y in 0..rh {
                for x in 0..rw {
                    let c = rgba(ax + x as i32, ay + y as i32);
                    if c[3] > 0.0 {
                        inks[(y * rw + x) * 4..][..4].copy_from_slice(&lookup(&table, [c[0], c[1], c[2]]));
                    }
                }
            }
            let out = trap_inks(&inks, rw, rh, width as usize);
            let mut tile = HashMap::new();
            for y in oy.max(ay)..(oy + TILE as i32).min(by) {
                for x in ox.max(ax)..(ox + TILE as i32).min(bx) {
                    let i = ((y - ay) as usize * rw + (x - ax) as usize) * 4;
                    if out[i..i + 4].iter().zip(&inks[i..i + 4]).all(|(a, b)| (a - b).abs() < 1e-4) {
                        continue;
                    }
                    let mut c = [0.0f64; 3];
                    back.apply(&out[i..i + 4].iter().map(|&v| v as f64).collect::<Vec<_>>(), &mut c);
                    tile.insert(((y - oy) * TILE as i32 + x - ox) as usize, c.map(|v| v.clamp(0.0, 1.0) as f32));
                }
            }
            if !tile.is_empty() {
                changed.insert((tx, ty), tile);
            }
        }
        if changed.is_empty() {
            return Ok(false);
        }
        let area: Vec<(i32, i32)> = changed.keys().copied().collect();
        self.edit_pixel_tiles_at(id, &area, true, |at, p, c| match changed.get(&at).and_then(|t| t.get(&p)) {
            Some(n) => [n[0], n[1], n[2], c[3]],
            None => c,
        })?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cyan | magenta halves, 8 x 2.
    fn halves() -> Vec<f32> {
        (0..16).flat_map(|i| if i % 8 < 4 { [1.0, 0.0, 0.0, 0.0] } else { [0.0, 1.0, 0.0, 0.0] }).collect()
    }

    #[test]
    fn cyan_and_magenta_spread_under_each_other() {
        let out = trap_inks(&halves(), 8, 2, 1);
        let at = |x: usize, c: usize| out[x * 4 + c];
        assert_eq!((at(3, 0), at(3, 1)), (1.0, 1.0), "magenta under the cyan edge");
        assert_eq!((at(4, 0), at(4, 1)), (1.0, 1.0), "cyan under the magenta edge");
        assert_eq!(at(2, 1), 0.0, "only one pixel wide");
        assert_eq!(at(5, 0), 0.0);
    }

    #[test]
    fn yellow_spreads_under_cyan_but_not_back() {
        let px: Vec<f32> = (0..8).flat_map(|x| if x < 4 { [0.0, 0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0, 0.0] }).collect();
        let out = trap_inks(&px, 8, 1, 2);
        assert_eq!(&out[16..20], &[1.0, 0.0, 1.0, 0.0], "yellow under the cyan edge");
        assert_eq!(&out[20..24], &[1.0, 0.0, 1.0, 0.0], "two pixels wide");
        assert_eq!(&out[24..28], &[1.0, 0.0, 0.0, 0.0]);
        assert_eq!(&out[12..16], &[0.0, 0.0, 1.0, 0.0], "cyan does not spread under yellow");
    }

    #[test]
    fn black_takes_colors_and_paper_stays() {
        // paper | cyan | black
        let px: Vec<f32> = (0..6).flat_map(|x| match x / 2 { 0 => [0.0; 4], 1 => [1.0, 0.0, 0.0, 0.0], _ => [0.0, 0.0, 0.0, 1.0] }).collect();
        let out = trap_inks(&px, 6, 1, 1);
        assert_eq!(&out[4..8], &[0.0; 4], "paper gains no ink");
        assert_eq!(&out[12..16], &[1.0, 0.0, 0.0, 0.0], "black does not spread under cyan");
        assert_eq!(&out[16..20], &[1.0, 0.0, 0.0, 1.0], "cyan spreads under black");
    }

    #[test]
    fn trap_needs_cmyk_and_changes_only_the_edge() {
        let mut d = Document::new(16, 4, 8).unwrap();
        assert!(d.trap(1, 1).unwrap_err().contains("CMYK"));
        d.set_color_mode(&super::color_mode::ModeSpec::Cmyk).unwrap();
        for x in 0..16 {
            for y in 0..4 {
                let c: [u8; 4] = if x < 8 { [255, 242, 0, 255] } else { [0, 174, 239, 255] };
                d.put_rgba8(1, x, y, 1, 1, &c).unwrap();
            }
        }
        let before = d.flatten_tile_rgba8(0, 0).unwrap();
        assert!(d.trap(1, 1).unwrap());
        let after = d.flatten_tile_rgba8(0, 0).unwrap();
        let px = |b: &[u8], x: usize| b[x * 4..x * 4 + 4].to_vec();
        assert_eq!(px(&after, 2), px(&before, 2), "away from the edge nothing changes");
        assert_eq!(px(&after, 13), px(&before, 13));
        assert_eq!(px(&after, 7), px(&before, 7), "yellow is lighter: it takes no cyan");
        assert_ne!(px(&after, 8), px(&before, 8), "the cyan edge takes the yellow ink");
        assert_eq!(px(&after, 9), px(&before, 9), "one pixel wide");
        assert!(d.trap(1, 0).is_err() && d.trap(1, MAX_TRAP + 1).is_err());
    }
}
