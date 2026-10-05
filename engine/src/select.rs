//! Selection, flood fill, brush stroke application, saved channels and layer bounds.
//! A child module of `doc`, so it reaches the document's private tile storage.

use super::*;

impl Document {
    // ---------- selection (M2.md section 3) ----------

    pub(super) fn max(&self) -> f32 {
        max_value(self.depth) as f32
    }

    // The selection value in 0..1 at a document pixel; outside the canvas it is 0.
    pub(super) fn sel_at(&self, sel: &SelMask, x: i32, y: i32) -> f32 {
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return 0.0;
        }
        let (tx, ty) = (x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
        let p = (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize;
        match sel.tiles.get(tx, ty) {
            Some(t) => t.px.mask_f32(p),
            None => sel.default as f32 / self.max(),
        }
    }

    // Canvas tiles overlapping a document pixel rect (upper bounds exclusive).
    pub(super) fn tiles_of_rect(&self, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<(i32, i32)> {
        if x1 <= x0 || y1 <= y0 {
            return Vec::new();
        }
        let t = |v: i32| v.div_euclid(TILE as i32);
        let (tx0, ty0) = (t(x0).max(0), t(y0).max(0));
        let (tx1, ty1) = (t(x1 - 1).min(self.tiles_x() as i32 - 1), t(y1 - 1).min(self.tiles_y() as i32 - 1));
        let mut out = Vec::new();
        for ty in ty0..=ty1 {
            for tx in tx0..=tx1 {
                out.push((tx, ty));
            }
        }
        out
    }

    pub(super) fn set_sel_tile(&mut self, sel: &mut SelMask, tx: i32, ty: i32, values: &[f32]) {
        let px = Pixels::mask_from_norm(self.depth, values);
        let uniform = match &px {
            Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == sel.default),
            Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == sel.default),
            _ => false,
        };
        let tile = (!uniform).then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
        sel.tiles.put(tx, ty, tile);
    }

    /// Rasterizes a shape into the selection with one of the four boolean modes. The shape is
    /// clipped to the canvas; an empty result stays an (empty) selection, not "no selection".
    pub fn select_shape(&mut self, shape: &dyn Shape, mode: Mode) -> Result<(), String> {
        self.check_idle()?;
        let (bx0, by0, bx1, by1) = shape.bounds();
        if ![bx0, by0, bx1, by1].iter().all(|v| v.is_finite()) {
            return Err("shape bounds must be finite".into());
        }
        let clamp = |v: f64, hi: u32| v.clamp(0.0, hi as f64) as i32;
        let (x0, y0) = (clamp(bx0.floor(), self.width), clamp(by0.floor(), self.height));
        let (x1, y1) = (clamp(bx1.ceil(), self.width), clamp(by1.ceil(), self.height));
        let old = self.selection.take().unwrap_or_default();
        let mut sel = if mode.keeps_untouched() {
            old.clone()
        } else {
            SelMask { default: 0, tiles: Tiles::default() }
        };
        let mut row = vec![0f32; TILE];
        let mut values = vec![0f32; TILE_PIXELS];
        for (tx, ty) in self.tiles_of_rect(x0, y0, x1, y1) {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for y in 0..TILE as i32 {
                let inside = oy + y >= y0 && oy + y < y1;
                if inside {
                    shape.row(oy + y, ox, &mut row);
                } else {
                    row.fill(0.0);
                }
                for x in 0..TILE as i32 {
                    let c = if inside && ox + x >= x0 && ox + x < x1 { row[x as usize] } else { 0.0 };
                    values[(y * TILE as i32 + x) as usize] =
                        mode.combine(self.sel_at(&old, ox + x, oy + y), c.clamp(0.0, 1.0)).clamp(0.0, 1.0);
                }
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    pub fn select_rect(&mut self, x: f64, y: f64, w: f64, h: f64, mode: Mode) -> Result<(), String> {
        self.select_shape(&Rect::new(x, y, w, h), mode)
    }

    pub fn select_ellipse(&mut self, x: f64, y: f64, w: f64, h: f64, aa: bool, mode: Mode) -> Result<(), String> {
        self.select_shape(&Ellipse::new(x, y, w, h, aa), mode)
    }

    pub fn select_polygon(&mut self, points: &[f64], aa: bool, mode: Mode) -> Result<(), String> {
        self.select_shape(&Polygon::new(points, aa)?, mode)
    }

    pub fn select_all(&mut self) -> Result<(), String> {
        self.check_idle()?;
        self.selection = Some(SelMask { default: max_value(self.depth), tiles: Tiles::default() });
        Ok(())
    }

    /// Drops the selection and keeps it for `reselect`.
    pub fn deselect(&mut self) -> Result<(), String> {
        self.check_idle()?;
        if let Some(sel) = self.selection.take() {
            self.last_selection = Some(sel);
        }
        Ok(())
    }

    pub fn reselect(&mut self) -> Result<(), String> {
        self.check_idle()?;
        let last = self.last_selection.clone().ok_or("there is no selection to restore")?;
        self.selection = Some(last);
        Ok(())
    }

    /// Inverts the selection; nothing selected inverts to everything.
    pub fn invert_selection(&mut self) -> Result<(), String> {
        self.check_idle()?;
        let old = self.selection.take().unwrap_or_default();
        let mut sel = SelMask { default: max_value(self.depth) - old.default, tiles: Tiles::default() };
        for (tx, ty) in old.tiles.coords() {
            let px = old.tiles.get(tx, ty).expect("a listed tile").px.inverted();
            let uniform = match &px {
                Pixels::Mask8(d) => d.iter().all(|v| *v as u32 == sel.default),
                Pixels::Mask16(d) => d.iter().all(|v| *v as u32 == sel.default),
                _ => false,
            };
            let tile = (!uniform).then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(px) });
            sel.tiles.put(tx, ty, tile);
        }
        self.selection = Some(sel);
        Ok(())
    }

    /// Gaussian blur of the selection mask (`selection::gaussian_kernel`); outside the canvas
    /// counts as 0, so an edge of the canvas fades like any other edge.
    pub fn feather_selection(&mut self, radius: f64) -> Result<(), String> {
        self.check_idle()?;
        if !radius.is_finite() || radius <= 0.0 {
            return Err("feather radius must be greater than 0".into());
        }
        let old = self.selection.clone().ok_or("nothing is selected")?;
        let kernel = gaussian_kernel(radius);
        let k = (kernel.len() / 2) as i32;
        let (w, h) = (self.width as i32, self.height as i32);
        // Only tiles within the blur reach of a stored tile change, unless the default is not 0,
        // which the canvas edge then fades.
        let mut area = Vec::new();
        if old.default > 0 {
            area = self.tiles_of_rect(0, 0, w, h);
        } else {
            let mut bb: Option<(i32, i32, i32, i32)> = None;
            for (tx, ty) in old.tiles.coords() {
                let (x0, y0) = (tx * TILE as i32, ty * TILE as i32);
                let b = bb.unwrap_or((x0, y0, x0 + TILE as i32, y0 + TILE as i32));
                bb = Some((b.0.min(x0), b.1.min(y0), b.2.max(x0 + TILE as i32), b.3.max(y0 + TILE as i32)));
            }
            if let Some((x0, y0, x1, y1)) = bb {
                area = self.tiles_of_rect(x0 - k, y0 - k, x1 + k, y1 + k);
            }
        }
        let mut sel = old.clone();
        let mut values = vec![0f32; TILE_PIXELS];
        // ponytail: one horizontal pass per output tile; a shared per-tile-row band would cut the
        // repeated work if a large radius ever shows up in a profile.
        let mut band = vec![0f32; (TILE + 2 * k as usize) * TILE];
        for (tx, ty) in area {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let bw = TILE;
            for (i, row) in band.chunks_exact_mut(bw).enumerate() {
                let y = oy - k + i as i32;
                for (j, v) in row.iter_mut().enumerate() {
                    let x = ox + j as i32;
                    *v = (-k..=k).map(|d| self.sel_at(&old, x + d, y) * kernel[(d + k) as usize]).sum();
                }
            }
            for y in 0..TILE as i32 {
                for x in 0..TILE as i32 {
                    let v: f32 = (-k..=k)
                        .map(|d| {
                            let sy = oy + y + d;
                            if sy < 0 || sy >= h || ox + x >= w {
                                0.0
                            } else {
                                band[((y + d + k) as usize) * bw + x as usize] * kernel[(d + k) as usize]
                            }
                        })
                        .sum();
                    values[(y * TILE as i32 + x) as usize] = v.clamp(0.0, 1.0);
                }
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    // ---------- flood fill family (docs/M2.md section 3 magic wand, section 4 paint bucket) ----------

    // The document's RGBA8 buffer for flood fill / paint bucket sampling: the flattened
    // composite when `sample_all`, or one layer's straight pixels (offset aware; outside its
    // tiles is transparent) otherwise. Depths above 8 bit are normalized down to 8-bit units so
    // the flood fill's tolerance stays in one scale.
    pub(super) fn sample_rgba8(&self, sample_all: bool, layer_id: u32) -> Result<Vec<u8>, String> {
        let (w, h) = (self.width as i32, self.height as i32);
        let mut out = vec![0u8; (self.width * self.height * 4) as usize];
        if sample_all {
            for ty in 0..self.tiles_y() {
                for tx in 0..self.tiles_x() {
                    let tile = self.flatten_tile_rgba8(tx, ty)?;
                    let (ox, oy) = (tx as i32 * TILE as i32, ty as i32 * TILE as i32);
                    for y in 0..TILE as i32 {
                        if oy + y >= h {
                            break;
                        }
                        for x in 0..TILE as i32 {
                            if ox + x >= w {
                                break;
                            }
                            let so = ((y * TILE as i32 + x) * 4) as usize;
                            let dst = (((oy + y) * w + ox + x) * 4) as usize;
                            out[dst..dst + 4].copy_from_slice(&tile[so..so + 4]);
                        }
                    }
                }
            }
            return Ok(out);
        }
        let node = self.node(layer_id)?;
        if node.is_group() {
            return Err(format!("node {layer_id} is a group and has no pixels"));
        }
        let tiles = node.pixel_tiles()?;
        for y in 0..h {
            for x in 0..w {
                let (tx, ty) = (x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
                let p = (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize;
                let rgba = tiles.get(tx, ty).map_or([0.0; 4], |t| t.px.rgba_f32(p));
                let o = ((y * w + x) * 4) as usize;
                for c in 0..4 {
                    out[o + c] = (rgba[c] * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
        }
        Ok(out)
    }

    /// Magic wand (docs/M2.md section 3): flood fill from (x, y) plugged into the shared
    /// selection combine path.
    #[allow(clippy::too_many_arguments)]
    pub fn magic_wand(
        &mut self,
        x: i32,
        y: i32,
        tolerance: u8,
        antialias: bool,
        contiguous: bool,
        sample_all: bool,
        layer_id: u32,
        mode: Mode,
    ) -> Result<(), String> {
        self.check_idle()?;
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return Err("magic wand seed must be inside the canvas".into());
        }
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = region::flood(&src, self.width, self.height, (x as u32, y as u32), tolerance, contiguous, antialias);
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), mode)
    }

    /// Color Range (docs/M2.md section 3), plugged into the shared selection combine path.
    #[allow(clippy::too_many_arguments)]
    pub fn color_range(
        &mut self,
        sample_all: bool,
        layer_id: u32,
        preset: &str,
        samples: &[[u8; 3]],
        fuzziness: u8,
        range: u8,
        center: &[(f64, f64)],
        localized: bool,
        invert: bool,
        mode: Mode,
    ) -> Result<(), String> {
        self.check_idle()?;
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = region::color_range(&src, self.width, self.height, preset, samples, fuzziness, range, center, localized, invert)?;
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), mode)
    }

    /// Grayscale preview of `color_range`'s coverage for the dialog, without touching the
    /// selection; `level` downsamples by `2^level` (nearest-neighbour) so a big canvas stays
    /// cheap to redraw live.
    #[allow(clippy::too_many_arguments)]
    pub fn color_range_preview(
        &self,
        level: u32,
        sample_all: bool,
        layer_id: u32,
        preset: &str,
        samples: &[[u8; 3]],
        fuzziness: u8,
        range: u8,
        center: &[(f64, f64)],
        localized: bool,
        invert: bool,
    ) -> Result<Vec<u8>, String> {
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = region::color_range(&src, self.width, self.height, preset, samples, fuzziness, range, center, localized, invert)?;
        let step = 1usize << level.min(8);
        let (w, h) = (self.width as usize, self.height as usize);
        let (pw, ph) = (w.div_ceil(step), h.div_ceil(step));
        let mut out = vec![0u8; pw * ph];
        for py in 0..ph {
            for px in 0..pw {
                let (x, y) = ((px * step).min(w - 1), (py * step).min(h - 1));
                out[py * pw + px] = (cov[y * w + x] * 255.0).round().clamp(0.0, 255.0) as u8;
            }
        }
        Ok(out)
    }

    // Whether each canvas pixel is >= 0.5 selected, doc-sized; used as the seed set of grow/similar.
    fn selection_seed_mask(&self) -> Result<Vec<bool>, String> {
        let sel = self.selection.as_ref().ok_or("nothing is selected")?;
        let (w, h) = (self.width as i32, self.height as i32);
        let mut out = vec![false; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                out[(y * w + x) as usize] = self.sel_at(sel, x, y) >= 0.5;
            }
        }
        Ok(out)
    }

    fn grow_or_similar(&mut self, tolerance: u8, sample_all: bool, layer_id: u32, contiguous: bool) -> Result<(), String> {
        self.check_idle()?;
        let seeds = self.selection_seed_mask()?;
        if !seeds.iter().any(|&s| s) {
            return Err("nothing is selected".into());
        }
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = region::grow_similar(&src, self.width, self.height, &seeds, tolerance, contiguous);
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), Mode::Add)
    }

    /// Grows the selection with a contiguous flood from the seed colors' per-channel range.
    pub fn grow(&mut self, tolerance: u8, sample_all: bool, layer_id: u32) -> Result<(), String> {
        self.grow_or_similar(tolerance, sample_all, layer_id, true)
    }

    /// Adds every pixel within the seed colors' per-channel range, regardless of connectivity.
    pub fn similar(&mut self, tolerance: u8, sample_all: bool, layer_id: u32) -> Result<(), String> {
        self.grow_or_similar(tolerance, sample_all, layer_id, false)
    }

    /// Quick selection (docs/M2.md section 3): `points` are the stroke's flat document x, y
    /// samples, `radius` the brush radius in document pixels.
    #[allow(clippy::too_many_arguments)]
    pub fn quick_select(
        &mut self,
        points: &[f64],
        radius: f64,
        sample_all: bool,
        layer_id: u32,
        mode: Mode,
        auto_enhance: bool,
    ) -> Result<(), String> {
        self.check_idle()?;
        if points.len() % 2 != 0 {
            return Err("quick selection points need an x and a y each".into());
        }
        if points.iter().any(|v| !v.is_finite()) {
            return Err("quick selection points must be finite".into());
        }
        let stroke: Vec<(f64, f64)> = points.chunks_exact(2).map(|p| (p[0], p[1])).collect();
        let src = self.sample_rgba8(sample_all, layer_id)?;
        let cov = livewire::quick_select(&src, self.width, self.height, &stroke, radius, auto_enhance)?;
        self.select_shape(&MaskShape::new(self.width as i32, self.height as i32, cov), mode)
    }

    /// Quick mask (docs/M2.md section 3): paints into the selection itself, as if it were a
    /// layer mask, through `blend::paint_mask_value`; `value` (the fill color's red channel) is
    /// the painted mask value. There is no outer selection to clip this by.
    fn paint_coverage_selection(
        &mut self,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        coverage: &[f32],
        value: u8,
        mode: PaintMode,
        opacity: f32,
    ) -> Result<(), String> {
        let opacity = opacity.clamp(0.0, 1.0);
        let target = value as f32 / 255.0;
        let mut sel = self.selection.take().unwrap_or_default();
        for (tx, ty) in self.tiles_of_rect(x, y, x + w as i32, y + h as i32) {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let cell = |px_: i32, py: i32| -> f32 {
                let (dx, dy) = (ox + px_ - x, oy + py - y);
                if dx < 0 || dx >= w as i32 || dy < 0 || dy >= h as i32 {
                    0.0
                } else {
                    coverage[(dy * w as i32 + dx) as usize]
                }
            };
            let touches = (0..TILE as i32).any(|py| (0..TILE as i32).any(|px_| cell(px_, py) > 0.0));
            if !touches {
                continue;
            }
            let mut values = vec![0f32; TILE_PIXELS];
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let old = self.sel_at(&sel, ox + px_, oy + py);
                    let c = (cell(px_, py) * opacity).clamp(0.0, 1.0);
                    values[p] = paint_mask_value(mode, old, target, c);
                }
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    /// One frame of an open stroke: places the dabs of `samples` (flat x, y, pressure triples)
    /// into the stroke's coverage buffer, then recomputes every tile under those dabs from the
    /// tile as it was at stroke start. Returns the changed document rect as [x, y, w, h].
    pub(super) fn stroke_apply(&mut self, st: &mut Stroke, samples: &[f64]) -> Result<Vec<i32>, String> {
        self.check_idle()?;
        let stride = st.stride as usize;
        if samples.len() % stride != 0 {
            return Err(format!("stroke samples need groups of {stride} (the stride set at stroke_begin)"));
        }
        if samples.iter().any(|v| !v.is_finite()) {
            return Err("stroke samples must be finite".into());
        }
        let pts: Vec<Sample> = samples
            .chunks_exact(stride)
            .map(|c| Sample {
                x: c[0],
                y: c[1],
                p: (c[2] as f32).clamp(0.0, 1.0),
                tilt_x: if stride == 6 { (c[3] as f32).clamp(-90.0, 90.0) } else { 0.0 },
                tilt_y: if stride == 6 { (c[4] as f32).clamp(-90.0, 90.0) } else { 0.0 },
                twist: if stride == 6 { c[5] as f32 } else { 0.0 },
                dir: 0.0,
            })
            .collect();
        let anchors = st.spacer.feed(&pts, st.step, st.airbrush);
        if anchors.is_empty() {
            return Ok(Vec::new());
        }
        // Dynamics (E1.4-E1.7): each anchor placed by the spacer expands into one or more placed
        // dabs (scattering); brush pose overrides the anchor's pressure/tilt/twist before any of
        // that, including the legacy pressure-size toggle below.
        let color_active = st.dynamics.color.enabled;
        let fg = st.rgb;
        let initial_dir = st.spacer.initial_dir();
        let mut placed_dabs = Vec::new();
        for a in &anchors {
            let resolved = stroke::apply_pose(a, &st.pose);
            let base_diameter = if st.pressure_size { (st.size * resolved.p).max(1.0) } else { st.size };
            placed_dabs.extend(stroke::place_dabs(
                &resolved,
                initial_dir,
                base_diameter,
                st.angle,
                st.roundness,
                st.flip_x,
                st.flip_y,
                &st.dynamics,
                fg,
                &mut st.prng,
                &mut st.dab_index,
            ));
        }
        if placed_dabs.is_empty() {
            return Ok(Vec::new());
        }
        placed_dabs = self.art_expand(st, placed_dabs);
        // Per touched tile the local pixel box the new dabs cover; only those pixels are repainted.
        let mut dirty: Vec<((i32, i32), [i32; 4])> = Vec::new();
        let mut rect: Option<[i32; 4]> = None;
        for d in &placed_dabs {
            let tip = Tip::new(d.radius, st.hardness, d.angle, d.roundness, st.aliased, st.shape.clone(), d.flip_x, d.flip_y);
            let cap = (st.opacity * if st.pressure_opacity { d.pressure } else { 1.0 } * d.cap_mul).clamp(0.0, 1.0);
            let flow = (st.flow * d.flow_mul).clamp(0.0, 1.0);
            let (rf, w, h) = (d.radius as f64 + 1.0, self.width as i32, self.height as i32);
            let x0 = ((d.x - rf).floor() as i32).clamp(0, w);
            let y0 = ((d.y - rf).floor() as i32).clamp(0, h);
            let x1 = ((d.x + rf).ceil() as i32 + 1).clamp(0, w);
            let y1 = ((d.y + rf).ceil() as i32 + 1).clamp(0, h);
            if x1 <= x0 || y1 <= y0 {
                continue;
            }
            rect = Some(match rect {
                None => [x0, y0, x1, y1],
                Some(b) => [b[0].min(x0), b[1].min(y0), b[2].max(x1), b[3].max(y1)],
            });
            // Dual brush (E2.4): one secondary-tip stamp mask per placed dab, over the same pixel
            // box as the primary tip, computed once and indexed per pixel below.
            let dual_mask = st
                .dual_brush
                .enabled
                .then(|| stroke::dual_brush_mask(&st.dual_brush, (x0, y0, x1, y1), d.dab_index, st.seed));
            let dual_w = (x1 - x0) as usize;
            let mut fx_cov = st.effect.is_some().then(|| vec![0f32; dual_w * (y1 - y0) as usize]);
            for (tx, ty) in self.tiles_of_rect(x0, y0, x1, y1) {
                let key = (tx, ty);
                if !st.tiles.contains_key(&key) {
                    let orig = match st.target {
                        Target::Pixels => self.node(st.layer)?.pixel_tiles()?.get(tx, ty).cloned(),
                        _ => self.selection.as_ref().and_then(|s| s.tiles.get(tx, ty)).cloned(),
                    };
                    let rgb = color_active.then(|| vec![[0f32; 3]; TILE_PIXELS]);
                    st.tiles.insert(key, StrokeTile { s: vec![0f32; TILE_PIXELS], rgb, orig });
                }
                let t = st.tiles.get_mut(&key).expect("the tile is present");
                let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
                let (lx0, ly0) = ((x0 - ox).max(0), (y0 - oy).max(0));
                let (lx1, ly1) = ((x1 - ox).min(TILE as i32), (y1 - oy).min(TILE as i32));
                for py in ly0..ly1 {
                    let dy = ((oy + py) as f64 + 0.5 - d.y) as f32;
                    for px in lx0..lx1 {
                        let dx = ((ox + px) as f64 + 0.5 - d.x) as f32;
                        let mut cov = tip.cov(dx, dy);
                        if cov <= 0.0 {
                            continue;
                        }
                        if st.noise > 0.0 {
                            cov = stroke::noise_remap(cov, st.noise, ox + px, oy + py, st.seed);
                            if cov <= 0.0 {
                                continue;
                            }
                        }
                        // Texture (E2.3): per pixel with coverage > 0, sampled at the document
                        // pixel or (when eachTip) at the dab-local offset from this dab's rect.
                        if st.texture.enabled {
                            if let Some(pat) = &st.texture.pattern {
                                let (sx, sy) =
                                    if st.texture.each_tip { (ox + px - x0, oy + py - y0) } else { (ox + px, oy + py) };
                                let v = pat.sample(sx, sy, st.texture.scale, st.texture.invert, st.texture.brightness, st.texture.contrast);
                                let blended = blend_channel(st.texture.mode, cov, v);
                                cov = (cov + (blended - cov) * d.tex_depth).clamp(0.0, 1.0);
                            }
                        }
                        // Dual brush (E2.4): blend in the secondary stamp mask at this pixel.
                        if let Some(mask) = &dual_mask {
                            let v = mask[(oy + py - y0) as usize * dual_w + (ox + px - x0) as usize];
                            cov = blend_channel(st.dual_brush.mode, cov, v).clamp(0.0, 1.0);
                        }
                        if cov <= 0.0 {
                            continue;
                        }
                        if let Some(fc) = fx_cov.as_mut() {
                            fc[(oy + py - y0) as usize * dual_w + (ox + px - x0) as usize] = cov;
                            continue;
                        }
                        let p = (py * TILE as i32 + px) as usize;
                        let prev = t.s[p];
                        let new = stroke::accumulate(prev, cap, flow, cov);
                        if let Some(rgb_buf) = t.rgb.as_mut() {
                            let delta = (new - prev).max(0.0);
                            if delta > 0.0 && new > 0.0 {
                                let wgt = delta / new;
                                let c = rgb_buf[p];
                                let dc = d.rgb.unwrap_or(fg);
                                rgb_buf[p] = [c[0] + (dc[0] - c[0]) * wgt, c[1] + (dc[1] - c[1]) * wgt, c[2] + (dc[2] - c[2]) * wgt];
                            }
                        }
                        t.s[p] = new;
                    }
                }
                match dirty.iter_mut().find(|(k, _)| *k == key) {
                    Some((_, b)) => {
                        *b = [b[0].min(lx0), b[1].min(ly0), b[2].max(lx1), b[3].max(ly1)];
                    }
                    None => dirty.push((key, [lx0, ly0, lx1, ly1])),
                }
            }
            if let Some(fc) = fx_cov {
                self.effect_dab(st, d, [x0, y0, x1, y1], &fc)?;
            }
        }
        let Some(rect) = rect else {
            return Ok(Vec::new());
        };
        if st.effect.is_none() && !st.heal.is_some_and(Heal::is_spot) {
            for (key, b) in &dirty {
                self.stroke_flush_tile(st, *key, *b)?;
            }
        }
        Ok(vec![rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]])
    }

    // Recomputes the box `b` of one tile from the stroke-start tile plus the stroke coverage.
    // A finished selection-target stroke applied to saved channel `id` as well, through `sel`.
    pub(super) fn stroke_into_channel(&mut self, st: &Stroke, id: u32, sel: Option<&SelMask>) {
        let Some(before) = self.channels.iter().find(|c| c.id == id).map(|c| c.mask.clone()) else { return };
        let mut after = before.clone();
        let def = before.default as f32 / self.max();
        let mut values = vec![0f32; TILE_PIXELS];
        for (&(tx, ty), t) in &st.tiles {
            let old = before.tiles.get(tx, ty).map(|o| o.px.clone());
            for (p, v) in values.iter_mut().enumerate() {
                let o = old.as_ref().map_or(def, |o| o.mask_f32(p));
                *v = paint_mask_value(st.mode, o, st.value, t.s[p].clamp(0.0, 1.0));
            }
            self.set_sel_tile(&mut after, tx, ty, &values);
        }
        let mask = match sel {
            Some(s) => self.blend_masks(&before, &after, s),
            None => after,
        };
        self.channels.iter_mut().find(|c| c.id == id).expect("found above").mask = mask;
    }

    fn stroke_flush_tile(&mut self, st: &Stroke, (tx, ty): (i32, i32), b: [i32; 4]) -> Result<(), String> {
        let t = st.tiles.get(&(tx, ty)).expect("the tile was accumulated");
        if st.target == Target::Selection {
            let mut sel = self.selection.take().unwrap_or_default();
            let def = sel.default as f32 / self.max();
            let mut values = vec![0f32; TILE_PIXELS];
            for (p, v) in values.iter_mut().enumerate() {
                let old = t.orig.as_ref().map_or(def, |o| o.px.mask_f32(p));
                *v = paint_mask_value(st.mode, old, st.value, t.s[p].clamp(0.0, 1.0));
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
            self.selection = Some(sel);
            return Ok(());
        }
        let cov = if self.selection.is_some() { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
        let cur = self.node(st.layer)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
        let hist = st.hist.as_ref().map(|h| h.get(tx, ty).map(|t| t.px.clone()));
        let mut data = cur.as_deref().cloned().unwrap_or_else(|| Pixels::transparent(self.depth));
        for py in b[1]..b[3] {
            for px in b[0]..b[2] {
                let p = (py * TILE as i32 + px) as usize;
                // Wet edges (E1.8) are a look remap of the accumulated coverage at flush, not a
                // different accumulation rule; `st.opacity` is the stroke-wide cap the remap reads.
                let s_val = if st.wet_edges { stroke::wet_edge_remap(t.s[p], st.opacity) } else { t.s[p] };
                let mut c = (s_val * cov.at(p)).clamp(0.0, 1.0);
                let old = t.orig.as_ref().map_or([0.0; 4], |o| o.px.rgba_f32(p));
                let mut rgb = t.rgb.as_ref().map_or(st.rgb, |buf| buf[p]);
                if let (Some(src), true) = (&st.source, c > 0.0) {
                    let v = src.sample(tx * TILE as i32 + px, ty * TILE as i32 + py);
                    rgb = [v[0], v[1], v[2]];
                    c *= v[3];
                }
                let new = match &hist {
                    // Erase to history: move towards the snapshot's pixel in straight RGBA.
                    Some(h) => {
                        let dst = h.as_deref().map_or([0.0; 4], |px| px.rgba_f32(p));
                        let mut out = [0f32; 4];
                        for i in 0..4 {
                            out[i] = old[i] + (dst[i] - old[i]) * c;
                        }
                        if st.keep_alpha {
                            out[3] = old[3];
                        }
                        out
                    }
                    None => paint_pixel(st.mode, old, rgb, c, st.keep_alpha),
                };
                data.set_rgba_f32(p, new);
            }
        }
        let tile = data.any_alpha().then(|| Tile { id: self.alloc_tile_id(), px: Arc::new(data) });
        self.node_mut(st.layer)?.pixel_tiles_mut()?.put(tx, ty, tile);
        Ok(())
    }

    /// Paints a solid color into the layer at document rect (x, y, w, h) through `coverage`
    /// (0..1, `coverage.len() == w * h`) times `opacity` times the selection, using the blend
    /// math in `blend::paint_pixel`. Honors the transparency lock and errors on the pixel lock;
    /// only tiles the rect and a nonzero coverage cell overlap are rewritten.
    #[allow(clippy::too_many_arguments)]
    pub fn paint_coverage(
        &mut self,
        id: u32,
        target: Target,
        x: i32,
        y: i32,
        w: u32,
        h: u32,
        coverage: &[f32],
        rgba: [u8; 4],
        mode: PaintMode,
        opacity: f32,
    ) -> Result<(), String> {
        self.check_idle()?;
        if coverage.len() != (w * h) as usize {
            return Err("paint coverage buffer must match w*h".into());
        }
        if target == Target::Selection {
            return self.paint_coverage_selection(x, y, w, h, coverage, rgba[0], mode, opacity);
        }
        if target != Target::Pixels {
            return Err("paint_coverage only supports the pixels or selection target".into());
        }
        self.check_pixel_paint(id)?;
        let keep_alpha = self.node(id)?.locks.transparency;
        let depth = self.depth;
        let rgb = [rgba[0] as f32 / 255.0, rgba[1] as f32 / 255.0, rgba[2] as f32 / 255.0];
        let opacity = opacity.clamp(0.0, 1.0);
        let selected = self.selection.is_some();
        let mut out: Vec<((i32, i32), Option<Pixels>)> = Vec::new();
        for (tx, ty) in self.tiles_of_rect(x, y, x + w as i32, y + h as i32) {
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            let cell = |px_: i32, py: i32| -> f32 {
                let (dx, dy) = (ox + px_ - x, oy + py - y);
                if dx < 0 || dx >= w as i32 || dy < 0 || dy >= h as i32 {
                    0.0
                } else {
                    coverage[(dy * w as i32 + dx) as usize]
                }
            };
            let touches = (0..TILE as i32).any(|py| (0..TILE as i32).any(|px_| cell(px_, py) > 0.0));
            if !touches {
                continue;
            }
            let old_tile = self.node(id)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
            let cov = if selected { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            let mut fresh = vec![0f32; TILE_PIXELS * 4];
            let mut any = false;
            for py in 0..TILE as i32 {
                for px_ in 0..TILE as i32 {
                    let p = (py * TILE as i32 + px_) as usize;
                    let old = old_tile.as_deref().map_or([0.0; 4], |px| px.rgba_f32(p));
                    let c = (cell(px_, py) * opacity * cov.at(p)).clamp(0.0, 1.0);
                    let new = paint_pixel(mode, old, rgb, c, keep_alpha);
                    any |= new[3] > 0.0;
                    fresh[p * 4..p * 4 + 4].copy_from_slice(&new);
                }
            }
            out.push(((tx, ty), any.then(|| Pixels::from_straight(depth, &fresh))));
        }
        let mut tiles_out = Vec::with_capacity(out.len());
        for (at, px) in out {
            tiles_out.push((at, px.map(|px| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in tiles_out {
            tiles.put(tx, ty, t);
        }
        Ok(())
    }

    /// Paint bucket (docs/M2.md section 4): flood fill from (x, y) on the chosen source, then
    /// `paint_coverage` over the whole canvas.
    #[allow(clippy::too_many_arguments)]
    pub fn bucket(
        &mut self,
        id: u32,
        target: Target,
        x: i32,
        y: i32,
        rgba: [u8; 4],
        mode: PaintMode,
        opacity: f32,
        tolerance: u8,
        antialias: bool,
        contiguous: bool,
        all_layers: bool,
    ) -> Result<(), String> {
        self.check_idle()?;
        if target == Target::Pixels {
            self.check_pixel_paint(id)?;
        }
        if x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return Err("bucket seed must be inside the canvas".into());
        }
        let src = self.sample_rgba8(all_layers, id)?;
        let cov = region::flood(&src, self.width, self.height, (x as u32, y as u32), tolerance, contiguous, antialias);
        self.paint_coverage(id, target, 0, 0, self.width, self.height, &cov, rgba, mode, opacity)
    }

    pub fn has_selection(&self) -> bool {
        self.selection.is_some()
    }

    /// Tight bounds of the selected (non-zero) pixels as [x, y, w, h], or None.
    pub fn selection_bounds(&self) -> Option<[i32; 4]> {
        let sel = self.selection.as_ref()?;
        let mut bb: Option<(i32, i32, i32, i32)> = None;
        let grow = |bb: &mut Option<(i32, i32, i32, i32)>, x0: i32, y0: i32, x1: i32, y1: i32| {
            *bb = Some(match *bb {
                None => (x0, y0, x1, y1),
                Some(b) => (b.0.min(x0), b.1.min(y0), b.2.max(x1), b.3.max(y1)),
            });
        };
        for (tx, ty) in self.tiles_of_rect(0, 0, self.width as i32, self.height as i32) {
            let Some(t) = sel.tiles.get(tx, ty) else {
                // A missing tile is the default, which covers the whole tile when it is not 0.
                if sel.default > 0 {
                    let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
                    grow(
                        &mut bb,
                        ox,
                        oy,
                        (ox + TILE as i32).min(self.width as i32),
                        (oy + TILE as i32).min(self.height as i32),
                    );
                }
                continue;
            };
            let px = &t.px;
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for y in 0..TILE as i32 {
                for x in 0..TILE as i32 {
                    if ox + x >= self.width as i32 || oy + y >= self.height as i32 {
                        continue;
                    }
                    if px.mask_f32((y * TILE as i32 + x) as usize) <= 0.0 {
                        continue;
                    }
                    let (gx, gy) = (ox + x, oy + y);
                    bb = Some(match bb {
                        None => (gx, gy, gx + 1, gy + 1),
                        Some(b) => (b.0.min(gx), b.1.min(gy), b.2.max(gx + 1), b.3.max(gy + 1)),
                    });
                }
            }
        }
        bb.map(|(x0, y0, x1, y1)| [x0, y0, x1 - x0, y1 - y0])
    }

    /// The selection mask of one display tile as 8-bit coverage, or None when the whole tile is
    /// the mask default. Level 0 is exact, higher levels are box reduced like layer masks.
    pub fn selection_tile(&self, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        if level > 8 {
            return Err("level must be <= 8".into());
        }
        let Some(sel) = &self.selection else { return Ok(None) };
        let Some((_, px)) = self.level_tile(&sel.tiles, Some(sel.default), level, tx, ty) else {
            return Ok(None);
        };
        Ok(Some(mask_bytes8(&px)?))
    }

    /// A saved channel's mask of one display tile as 8-bit values, like `selection_tile`.
    pub fn channel_tile(&self, id: u32, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        if level > 8 {
            return Err("level must be <= 8".into());
        }
        let ch = self.channels.iter().find(|c| c.id == id).ok_or_else(|| format!("unknown channel {id}"))?;
        match self.level_tile(&ch.mask.tiles, Some(ch.mask.default), level, tx, ty) {
            Some((_, px)) => Ok(Some(mask_bytes8(&px)?)),
            None => Ok(None),
        }
    }

    /// Layer `id`'s mask of one display tile as 8-bit values, like `channel_tile`.
    pub fn layer_mask_tile(&self, id: u32, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        if level > 8 {
            return Err("level must be <= 8".into());
        }
        let m = self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?;
        match self.level_tile(&m.tiles, Some(m.default), level, tx, ty) {
            Some((_, px)) => Ok(Some(mask_bytes8(&px)?)),
            None => Ok(None),
        }
    }

    /// Puts saved channel `id` in the selection's place, so selection-target edits paint it;
    /// returns the selection for `channel_out`.
    pub fn channel_in(&mut self, id: u32) -> Result<Option<SelMask>, String> {
        let mask = self.channels.iter().find(|c| c.id == id).ok_or_else(|| format!("unknown channel {id}"))?.mask.clone();
        Ok(std::mem::replace(&mut self.selection, Some(mask)))
    }

    /// Moves the edited mask back into channel `id` and restores `sel` as the selection; with a
    /// selection the edit reaches the channel only as far as it is selected.
    pub fn channel_out(&mut self, id: u32, sel: Option<SelMask>) {
        let after = std::mem::replace(&mut self.selection, sel.clone()).unwrap_or_default();
        let Some(before) = self.channels.iter().find(|c| c.id == id).map(|c| c.mask.clone()) else { return };
        let mask = match &sel {
            Some(s) => self.blend_masks(&before, &after, s),
            None => after,
        };
        self.channels.iter_mut().find(|c| c.id == id).expect("found above").mask = mask;
    }

    // `before` moved toward `after` by the coverage of `by`.
    fn blend_masks(&mut self, before: &SelMask, after: &SelMask, by: &SelMask) -> SelMask {
        let max = self.max();
        let mix = |b: f32, a: f32, k: f32| (b + (a - b) * k).clamp(0.0, 1.0);
        let d = |m: &SelMask| m.default as f32 / max;
        let mut out = SelMask { default: (mix(d(before), d(after), d(by)) * max).round() as u32, tiles: Tiles::default() };
        let mut area = before.tiles.coords();
        for at in after.tiles.coords().into_iter().chain(by.tiles.coords()) {
            if !area.contains(&at) {
                area.push(at);
            }
        }
        let mut values = vec![0f32; TILE_PIXELS];
        for (tx, ty) in area {
            if !self.on_canvas(tx, ty) {
                continue;
            }
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                values[p] = mix(self.sel_at(before, x, y), self.sel_at(after, x, y), self.sel_at(by, x, y));
            }
            self.set_sel_tile(&mut out, tx, ty, &values);
        }
        out
    }

    pub(super) fn next_channel_id(&self) -> u32 {
        self.channels.iter().map(|c| c.id).max().unwrap_or(0) + 1
    }

    /// Adds an empty (all unselected) channel and returns its id.
    pub fn new_channel(&mut self, name: &str) -> Result<u32, String> {
        self.check_idle()?;
        let id = self.next_channel_id();
        self.channels.push(Channel { id, name: name.to_string(), mask: SelMask::default(), spot: None });
        Ok(id)
    }

    /// Adds a spot channel with no ink (white) and returns its id.
    pub fn new_spot_channel(&mut self, name: &str, spot: Spot) -> Result<u32, String> {
        self.check_idle()?;
        spot.check()?;
        let id = self.next_channel_id();
        let mask = SelMask { default: self.max() as u32, tiles: Tiles::default() };
        self.channels.push(Channel { id, name: name.to_string(), mask, spot: Some(spot) });
        Ok(id)
    }

    /// Spot Channel Options: name, ink color and solidity of spot channel `id`.
    pub fn set_spot(&mut self, id: u32, name: &str, spot: Spot) -> Result<(), String> {
        self.check_idle()?;
        spot.check()?;
        let ch = self.channels.iter_mut().find(|c| c.id == id).ok_or_else(|| format!("unknown channel {id}"))?;
        if ch.spot.is_none() {
            return Err(format!("channel {id} is not a spot channel"));
        }
        ch.name = name.to_string();
        ch.spot = Some(spot);
        Ok(())
    }

    pub fn rename_channel(&mut self, id: u32, name: &str) -> Result<(), String> {
        self.check_idle()?;
        let ch = self.channels.iter_mut().find(|c| c.id == id).ok_or_else(|| format!("unknown channel {id}"))?;
        ch.name = name.to_string();
        Ok(())
    }

    /// Copies a channel to the end of the list and returns the copy's id.
    pub fn duplicate_channel(&mut self, id: u32, name: &str) -> Result<u32, String> {
        self.check_idle()?;
        let src = self.channels.iter().find(|c| c.id == id).ok_or_else(|| format!("unknown channel {id}"))?;
        let (mask, spot) = (src.mask.clone(), src.spot);
        let new = self.next_channel_id();
        self.channels.push(Channel { id: new, name: name.to_string(), mask, spot });
        Ok(new)
    }

    /// Saves the selection as a named channel and returns its id.
    pub fn save_selection(&mut self, name: &str) -> Result<u32, String> {
        self.check_idle()?;
        let mask = self.selection.clone().ok_or("nothing is selected")?;
        let id = self.next_channel_id();
        self.channels.push(Channel { id, name: name.to_string(), mask, spot: None });
        Ok(id)
    }

    /// Combines a saved channel into the selection.
    pub fn load_selection(&mut self, channel: u32, invert: bool, mode: Mode) -> Result<(), String> {
        self.check_idle()?;
        let src = self
            .channels
            .iter()
            .find(|c| c.id == channel)
            .ok_or_else(|| format!("unknown channel {channel}"))?
            .mask
            .clone();
        let old = self.selection.take().unwrap_or_default();
        let max = self.max();
        let src_def = src.default as f32 / max;
        let old_def = old.default as f32 / max;
        let src_def = if invert { 1.0 - src_def } else { src_def };
        let mut sel = SelMask {
            default: (mode.combine(old_def, src_def).clamp(0.0, 1.0) * max).round() as u32,
            tiles: Tiles::default(),
        };
        let mut area: Vec<(i32, i32)> = src.tiles.coords();
        for at in old.tiles.coords() {
            if !area.contains(&at) {
                area.push(at);
            }
        }
        let mut values = vec![0f32; TILE_PIXELS];
        for (tx, ty) in area {
            if !self.on_canvas(tx, ty) {
                continue;
            }
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                let mut c = self.sel_at(&src, x, y);
                if invert {
                    c = 1.0 - c;
                }
                values[p] = mode.combine(self.sel_at(&old, x, y), c).clamp(0.0, 1.0);
            }
            self.set_sel_tile(&mut sel, tx, ty, &values);
        }
        self.selection = Some(sel);
        Ok(())
    }

    /// Full doc-sized selection coverage, 0..1, defaulting to unselected when nothing is selected.
    pub(super) fn selection_values(&self) -> Vec<f32> {
        let sel = self.selection.clone().unwrap_or_default();
        let (w, h) = (self.width as i32, self.height as i32);
        let mut out = vec![0f32; (w * h) as usize];
        for y in 0..h {
            for x in 0..w {
                out[(y * w + x) as usize] = self.sel_at(&sel, x, y);
            }
        }
        out
    }

    /// Select > Modify (docs/M2.md section 3): `op` is "border", "smooth", "expand" or "contract".
    pub fn modify_selection(&mut self, op: &str, r: f64, canvas_bounds: bool) -> Result<(), String> {
        self.check_idle()?;
        self.selection.as_ref().ok_or("nothing is selected")?;
        let vals = self.selection_values();
        let (w, h) = (self.width, self.height);
        let out = match op {
            "expand" => region::expand(&vals, w, h, r as f32, canvas_bounds),
            "contract" => region::contract(&vals, w, h, r as f32, canvas_bounds),
            "border" => region::border(&vals, w, h, r as f32, canvas_bounds),
            "smooth" => region::smooth(&vals, w, h, r as u32, canvas_bounds),
            other => return Err(format!("unknown modify op {other}")),
        };
        self.select_shape(&MaskShape::new(w as i32, h as i32, out), Mode::New)
    }

    pub fn delete_channel(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let at = self
            .channels
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| format!("unknown channel {id}"))?;
        self.channels.remove(at);
        Ok(())
    }

    /// Combines the current selection into an existing saved channel (M2.md "combine into an
    /// existing channel").
    pub fn combine_into_channel(&mut self, channel: u32, mode: Mode) -> Result<(), String> {
        self.check_idle()?;
        let sel = self.selection.clone().unwrap_or_default();
        let old = self
            .channels
            .iter()
            .find(|c| c.id == channel)
            .ok_or_else(|| format!("unknown channel {channel}"))?
            .mask
            .clone();
        let max = self.max();
        let mut merged = SelMask {
            default: (mode.combine(old.default as f32 / max, sel.default as f32 / max).clamp(0.0, 1.0) * max).round() as u32,
            tiles: Tiles::default(),
        };
        let mut area: Vec<(i32, i32)> = sel.tiles.coords();
        for at in old.tiles.coords() {
            if !area.contains(&at) {
                area.push(at);
            }
        }
        let mut values = vec![0f32; TILE_PIXELS];
        for (tx, ty) in area {
            if !self.on_canvas(tx, ty) {
                continue;
            }
            let (ox, oy) = (tx * TILE as i32, ty * TILE as i32);
            for p in 0..TILE_PIXELS {
                let (x, y) = (ox + (p % TILE) as i32, oy + (p / TILE) as i32);
                values[p] = mode.combine(self.sel_at(&old, x, y), self.sel_at(&sel, x, y)).clamp(0.0, 1.0);
            }
            self.set_sel_tile(&mut merged, tx, ty, &values);
        }
        self.channels.iter_mut().find(|c| c.id == channel).expect("checked above").mask = merged;
        Ok(())
    }

    // ---------- layer bounds (M2.md section 5) ----------

    /// Tight bounds of the layer's non-transparent pixels as [x, y, w, h], canvas coordinates
    /// that may be negative or reach past the canvas.
    pub fn layer_bounds(&self, id: u32) -> Result<Option<[i32; 4]>, String> {
        match &self.node(id)?.kind {
            Kind::Text(t) => Ok(t.cache.as_ref().and_then(tiles_bounds)),
            // Path bounds, stroke width not included.
            Kind::Shape(sh) => Ok(crate::geom::bounds(&sh.path).map(|[l, t, r, b]| {
                let (x, y) = (l.floor() as i32, t.floor() as i32);
                [x, y, r.ceil() as i32 - x, b.ceil() as i32 - y]
            })),
            _ => Ok(tiles_bounds(self.node(id)?.pixel_tiles()?)),
        }
    }

    // Every tile of `src` moved by (dx, dy); a missing source tile reads as empty or as the
    // mask default, so an empty area stays empty.
    pub(super) fn shift_tiles(&mut self, src: &Tiles, dx: i32, dy: i32, mask_default: Option<u32>) -> Tiles {
        let t = |v: i32| v.div_euclid(TILE as i32);
        let mut dest: Vec<(i32, i32)> = Vec::new();
        for (tx, ty) in src.coords() {
            let (x0, y0) = (tx * TILE as i32 + dx, ty * TILE as i32 + dy);
            for at in [
                (t(x0), t(y0)),
                (t(x0 + TILE as i32 - 1), t(y0)),
                (t(x0), t(y0 + TILE as i32 - 1)),
                (t(x0 + TILE as i32 - 1), t(y0 + TILE as i32 - 1)),
            ] {
                if !dest.contains(&at) {
                    dest.push(at);
                }
            }
        }
        let blank = match mask_default {
            Some(v) => Pixels::mask_filled(self.depth, v),
            None => Pixels::transparent(self.depth),
        };
        let mut out = Tiles::default();
        let ti = TILE as i32;
        for (dtx, dty) in dest {
            // Each destination row reads from at most two source tiles; values copy in native form.
            let mut px = blank.clone();
            let sx0 = dtx * ti - dx;
            let split = (ti - sx0.rem_euclid(ti)) as usize;
            for y in 0..TILE {
                let sy = dty * ti + y as i32 - dy;
                let row = sy.rem_euclid(ti) as usize * TILE;
                for (at, sx, n) in [(0, sx0, split), (split, sx0 + split as i32, TILE - split)] {
                    if let (true, Some(tile)) = (n > 0, src.get(t(sx), t(sy))) {
                        px.copy_run(y * TILE + at, &tile.px, row + sx.rem_euclid(ti) as usize, n);
                    }
                }
            }
            let any = match (&px, &blank) {
                (Pixels::Mask8(a), Pixels::Mask8(b)) => a != b,
                (Pixels::Mask16(a), Pixels::Mask16(b)) => a != b,
                _ => px.any_alpha(),
            };
            if any {
                out.put(dtx, dty, Some(Tile { id: self.alloc_tile_id(), px: Arc::new(px) }));
            }
        }
        out
    }

    /// Moves a pixel layer and its mask by whole pixels. Pixels outside the canvas are kept.
    pub fn offset_layer(&mut self, id: u32, dx: i32, dy: i32) -> Result<(), String> {
        self.check_idle()?;
        let vector = matches!(self.node(id)?.kind, Kind::Shape(_) | Kind::Text(_));
        if !vector {
            self.check_pixel_edit(id)?;
        }
        if self.node(id)?.locks.position {
            return Err("layer position is locked".into());
        }
        if dx == 0 && dy == 0 {
            return Ok(());
        }
        if vector {
            return self.offset_vector_layer(id, dx, dy);
        }
        // The shifted tiles must stay within the coordinates a manifest may store.
        let node = self.node(id)?;
        let mask_coords = node.mask.as_ref().map_or(Vec::new(), |m| m.tiles.coords());
        let lim = MAX_TILE_COORD as i64;
        let fits = |t: i32, d: i32| {
            let lo = (t as i64 * TILE as i64 + d as i64).div_euclid(TILE as i64);
            lo >= -lim && lo + 1 <= lim
        };
        if !node.pixel_tiles()?.coords().into_iter().chain(mask_coords).all(|(tx, ty)| fits(tx, dx) && fits(ty, dy)) {
            return Err("offset moves the layer too far".into());
        }
        let src = self.node(id)?.pixel_tiles()?.clone();
        let moved = self.shift_tiles(&src, dx, dy, None);
        *self.node_mut(id)?.pixel_tiles_mut()? = moved;
        if let Some((t, warp)) = self.smart_moved(id, &[1.0, 0.0, dx as f64, 0.0, 1.0, dy as f64, 0.0, 0.0, 1.0])? {
            let s = self.node_mut(id)?.smart_mut();
            (s.transform, s.warp) = (t, warp);
            self.map_filter_masks(id, |d, m| d.shift_tiles(&m.tiles, dx, dy, Some(m.default)))?;
        }
        let mask = self.node(id)?.mask.as_ref().map(|m| (m.default, m.tiles.clone()));
        if let Some((default, tiles)) = mask {
            let moved = self.shift_tiles(&tiles, dx, dy, Some(default));
            self.node_mut(id)?.mask.as_mut().expect("checked").tiles = moved;
        }
        self.offset_linked_vector_mask(id, dx, dy)
    }

    fn offset_linked_vector_mask(&mut self, id: u32, dx: i32, dy: i32) -> Result<(), String> {
        if let Some(vm) = self.node_mut(id)?.vector_mask.as_mut().filter(|m| m.linked) {
            vm.path.translate(dx as f64, dy as f64);
        }
        Ok(())
    }

    // A shape moves its path, a text layer its transform (its box and paths are in text space)
    // and its cache; the raster mask moves as on a pixel layer.
    fn offset_vector_layer(&mut self, id: u32, dx: i32, dy: i32) -> Result<(), String> {
        let lim = MAX_TILE_COORD as i64;
        let fits = |t: i32, d: i32| {
            let lo = (t as i64 * TILE as i64 + d as i64).div_euclid(TILE as i64);
            lo >= -lim && lo < lim
        };
        let node = self.node(id)?;
        let cache = match &node.kind {
            Kind::Text(t) => t.cache.clone(),
            _ => None,
        };
        let mask = node.mask.as_ref().map(|m| (m.default, m.tiles.clone()));
        let coords = cache.iter().chain(mask.as_ref().map(|m| &m.1)).flat_map(|t| t.coords());
        if !coords.into_iter().all(|(tx, ty)| fits(tx, dx) && fits(ty, dy)) {
            return Err("offset moves the layer too far".into());
        }
        let cache = cache.map(|c| self.shift_tiles(&c, dx, dy, None));
        let mask = mask.map(|(default, tiles)| self.shift_tiles(&tiles, dx, dy, Some(default)));
        self.offset_linked_vector_mask(id, dx, dy)?;
        let node = self.node_mut(id)?;
        match &mut node.kind {
            Kind::Shape(s) => s.translate(dx as f64, dy as f64),
            Kind::Text(t) => {
                t.data.transform[4] += dx as f64;
                t.data.transform[5] += dy as f64;
                t.cache = cache;
            }
            _ => unreachable!("only shape and text layers move as vectors"),
        }
        if let (Some(m), Some(tiles)) = (node.mask.as_mut(), mask) {
            m.tiles = tiles;
        }
        Ok(())
    }
}

fn mask_bytes8(px: &Pixels) -> Result<Vec<u8>, String> {
    Ok(match px {
        Pixels::Mask8(d) => d.to_vec(),
        Pixels::Mask16(d) => d.iter().map(|v| (v >> 8) as u8).collect(),
        _ => return Err("a selection tile is always a mask".into()),
    })
}
