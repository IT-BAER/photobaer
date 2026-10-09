//! Layer > Matting: Defringe, Remove Black Matte, Remove White Matte and Color Decontaminate.
//! Pure functions over a straight RGBA region, then the document wrappers. A child module of `doc`.

use super::*;
use crate::region::edt2;

// About 40 bytes per pixel of float planes; more would exhaust the 4 GB wasm heap.
const MATTING_MAX_PIXELS: usize = 50_000_000;

/// Recovers the color of semi-transparent pixels composited over black (`white` false) or white:
/// c / a or (c - (1 - a)) / a, clamped to 0..1. Alpha unchanged.
pub(super) fn remove_matte(px: &mut [[f32; 4]], white: bool) {
    for p in px.iter_mut().filter(|p| p[3] > 0.0 && p[3] < 1.0) {
        let a = p[3];
        for c in &mut p[..3] {
            *c = (if white { (*c - (1.0 - a)) / a } else { *c / a }).clamp(0.0, 1.0);
        }
    }
}

fn neighbours(i: usize, w: usize, h: usize) -> impl Iterator<Item = usize> {
    let (x, y) = ((i % w) as i64, (i / w) as i64);
    let (w, h) = (w as i64, h as i64);
    (-1i64..=1)
        .flat_map(move |dy| (-1i64..=1).map(move |dx| (x + dx, y + dy, dx | dy)))
        .filter(move |&(nx, ny, d)| d != 0 && nx >= 0 && ny >= 0 && nx < w && ny < h)
        .map(move |(nx, ny, _)| (ny * w + nx) as usize)
}

// Grows color from the `known` pixels into the `todo` ones, one 8-connected ring at a time: each
// ring pixel takes the mean color of its neighbors known before that ring. Marks reached pixels known.
fn grow(px: &[[f32; 4]], w: usize, h: usize, known: &mut [bool], todo: &[bool]) -> Vec<[f32; 3]> {
    let mut col: Vec<[f32; 3]> = px.iter().map(|p| [p[0], p[1], p[2]]).collect();
    let mut queued = vec![false; px.len()];
    let mut front: Vec<usize> = (0..px.len()).filter(|&i| known[i]).collect();
    loop {
        let mut ring = Vec::new();
        for &i in &front {
            for j in neighbours(i, w, h) {
                if todo[j] && !known[j] && !queued[j] {
                    queued[j] = true;
                    ring.push(j);
                }
            }
        }
        if ring.is_empty() {
            return col;
        }
        let means: Vec<[f32; 3]> = ring
            .iter()
            .map(|&j| {
                let (mut sum, mut n) = ([0f32; 3], 0f32);
                for k in neighbours(j, w, h).filter(|&k| known[k]) {
                    (0..3).for_each(|c| sum[c] += col[k][c]);
                    n += 1.0;
                }
                sum.map(|s| s / n)
            })
            .collect();
        for (&j, m) in ring.iter().zip(means) {
            col[j] = m;
            known[j] = true;
        }
        front = ring;
    }
}

/// Pixels with alpha > 0 within `width` px of a fully transparent pixel take the color grown
/// outward from the pixels deeper inside. Alpha unchanged.
pub(super) fn defringe(px: &mut [[f32; 4]], w: usize, h: usize, width: u32) {
    let clear: Vec<bool> = px.iter().map(|p| p[3] <= 0.0).collect();
    let d2 = edt2(&clear, w, h);
    let lim = (width as f64) * (width as f64);
    let todo: Vec<bool> = (0..px.len()).map(|i| !clear[i] && d2[i] <= lim).collect();
    let mut known: Vec<bool> = (0..px.len()).map(|i| !clear[i] && d2[i] > lim).collect();
    let col = grow(px, w, h, &mut known, &todo);
    for i in (0..px.len()).filter(|&i| todo[i] && known[i]) {
        px[i][..3].copy_from_slice(&col[i]);
    }
}

/// Pixels where `mask` is partial move their color by `amount` (0..1) toward the color grown from
/// the visible pixels where the mask is fully revealed. Alpha unchanged.
pub(super) fn decontaminate(px: &mut [[f32; 4]], mask: &[f32], w: usize, h: usize, amount: f32) {
    if amount <= 0.0 {
        return;
    }
    let todo: Vec<bool> = mask.iter().map(|&m| m > 0.0 && m < 1.0).collect();
    let mut known: Vec<bool> = (0..px.len()).map(|i| mask[i] >= 1.0 && px[i][3] > 0.0).collect();
    let col = grow(px, w, h, &mut known, &todo);
    for i in (0..px.len()).filter(|&i| todo[i] && known[i]) {
        (0..3).for_each(|c| px[i][c] += (col[i][c] - px[i][c]) * amount);
    }
}

impl Document {
    pub fn defringe(&mut self, id: u32, width: u32) -> Result<(), String> {
        if !(1..=200).contains(&width) {
            return Err("Width must be between 1 and 200 pixels.".into());
        }
        self.matting(id, |px, _, w, h| defringe(px, w, h, width))
    }

    pub fn remove_matte(&mut self, id: u32, white: bool) -> Result<(), String> {
        self.matting(id, |px, _, _, _| remove_matte(px, white))
    }

    /// `amount` 0..1; the layer needs a layer mask.
    pub fn color_decontaminate(&mut self, id: u32, amount: f32) -> Result<(), String> {
        if !(0.0..=1.0).contains(&amount) {
            return Err("Amount must be between 0 and 100%.".into());
        }
        self.check_mask_pixel_layer(id)?;
        if self.node(id)?.mask.is_none() {
            return Err(format!("node {id} has no mask"));
        }
        self.matting(id, |px, mask, w, h| decontaminate(px, mask, w, h, amount))
    }

    // Runs `f` over the pixel layer's on-canvas content rect (plus a 1 px border reading as clear)
    // with the layer mask plane, then writes the color back to the selected tiles; alpha is kept.
    fn matting(&mut self, id: u32, f: impl FnOnce(&mut [[f32; 4]], &[f32], usize, usize)) -> Result<(), String> {
        self.check_idle()?;
        let node = self.check_mask_pixel_layer(id)?;
        let tiles: Vec<(i32, i32)> =
            node.pixel_tiles()?.coords().into_iter().filter(|(tx, ty)| self.on_canvas(*tx, *ty)).collect();
        let area: Vec<(i32, i32)> = match self.selected_tiles() {
            Some(sel) => {
                let on: HashSet<(i32, i32)> = tiles.iter().copied().collect();
                sel.into_iter().filter(|c| on.contains(c)).collect()
            }
            None => tiles.clone(),
        };
        if area.is_empty() {
            return Ok(());
        }
        let ti = TILE as i32;
        let r = [
            (tiles.iter().map(|c| c.0).min().expect("non-empty") * ti - 1).max(0),
            (tiles.iter().map(|c| c.1).min().expect("non-empty") * ti - 1).max(0),
            ((tiles.iter().map(|c| c.0).max().expect("non-empty") + 1) * ti + 1).min(self.width as i32),
            ((tiles.iter().map(|c| c.1).max().expect("non-empty") + 1) * ti + 1).min(self.height as i32),
        ];
        let (w, h) = ((r[2] - r[0]) as usize, (r[3] - r[1]) as usize);
        if w * h > MATTING_MAX_PIXELS {
            return Err("the layer is too large for Matting".into());
        }
        let mut plane = self.read_region(id, false, r)?;
        let max = max_value(self.depth) as f32;
        let mask: Vec<f32> = match &self.node(id)?.mask {
            Some(m) => (0..w * h)
                .map(|i| {
                    let (x, y) = (r[0] + (i % w) as i32, r[1] + (i / w) as i32);
                    let p = (y.rem_euclid(ti) * ti + x.rem_euclid(ti)) as usize;
                    m.tiles.get(x.div_euclid(ti), y.div_euclid(ti)).map_or(m.default as f32 / max, |t| t.px.mask_f32(p))
                })
                .collect(),
            None => vec![1.0; w * h],
        };
        f(&mut plane, &mask, w, h);
        self.edit_pixel_tiles_at(id, &area, true, |(tx, ty), p, c| {
            let (x, y) = (tx * ti + (p % TILE) as i32, ty * ti + (p / TILE) as i32);
            if x < r[0] || y < r[1] || x >= r[2] || y >= r[3] {
                return c;
            }
            let n = plane[(y - r[1]) as usize * w + (x - r[0]) as usize];
            [n[0], n[1], n[2], c[3]]
        })
    }
}
