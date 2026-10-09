//! Clone, pattern and healing tools: stroke color sources, heal on stroke end, red eye, patch,
//! content-aware move and the clone overlay sampler. A child module of `doc`.

use super::*;
use crate::filters::Plane;
use crate::heal::{self, HealKind, PoissonOpts};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum SampleIn {
    CurrentLayer,
    CurrentBelow,
    AllLayers,
}

/// A stroke's color source: a clone map or a tiled pattern.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum SourceIn {
    #[serde(rename_all = "camelCase")]
    Clone {
        anchor: [f64; 2],
        origin: [f64; 2],
        m: [f64; 4],
        sample: SampleIn,
        #[serde(default)]
        ignore_adjustments: bool,
        #[serde(default)]
        layer_id: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    Pattern {
        pattern_id: u32,
        origin: [f64; 2],
        #[serde(default)]
        impressionist: bool,
    },
    #[serde(rename_all = "camelCase")]
    History { snapshot_id: u32 },
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Heal {
    Healing,
    Proximity,
    Texture,
    ContentAware,
}

impl Heal {
    pub(super) fn parse(s: &str) -> Result<Heal, String> {
        Ok(match s {
            "healing" => Heal::Healing,
            "proximityMatch" => Heal::Proximity,
            "createTexture" => Heal::Texture,
            "contentAware" => Heal::ContentAware,
            other => return Err(format!("unknown heal kind {other}")),
        })
    }

    /// A spot heal paints nothing during the stroke.
    pub(super) fn is_spot(self) -> bool {
        self != Heal::Healing
    }
}

enum Frozen {
    Layer(Tiles),
    // The composite per 256 tile, flattened on first read.
    Comp(Box<Document>, RefCell<HashMap<(i32, i32), Vec<u8>>>),
}

pub(super) struct CloneSrc {
    anchor: [f64; 2],
    origin: [f64; 2],
    m: [f64; 4],
    exact: bool,
    frozen: Frozen,
    w: i32,
    h: i32,
}

pub(super) struct PatSrc {
    pat: Arc<Pattern>,
    origin: [i32; 2],
    blurred: Option<Vec<[f32; 4]>>,
}

pub(super) enum StrokeSource {
    Clone(CloneSrc),
    Pattern(PatSrc),
}

fn contains(n: &Node, id: u32) -> bool {
    n.id == id || matches!(&n.kind, Kind::Group(ch) if ch.iter().any(|c| contains(c, id)))
}

// Hides every node stacked above `id` that is not one of its ancestors.
fn hide_above(nodes: &mut [Node], id: u32) {
    let Some(i) = nodes.iter().position(|n| contains(n, id)) else { return };
    nodes[i + 1..].iter_mut().for_each(|n| n.visible = false);
    if let Kind::Group(ch) = &mut nodes[i].kind {
        hide_above(ch, id);
    }
}

fn hide_adjustments(nodes: &mut [Node]) {
    for n in nodes {
        match &mut n.kind {
            Kind::Adjustment(_) => n.visible = false,
            Kind::Group(ch) => hide_adjustments(ch),
            _ => {}
        }
    }
}

impl CloneSrc {
    fn new(doc: &Document, p: &SourceIn, stroke_layer: u32) -> Result<CloneSrc, String> {
        let SourceIn::Clone { anchor, origin, m, sample, ignore_adjustments, layer_id } = p else {
            return Err("a clone source is needed".into());
        };
        if ![anchor[0], anchor[1], origin[0], origin[1], m[0], m[1], m[2], m[3]].iter().all(|v| v.is_finite()) {
            return Err("clone source params must be finite".into());
        }
        let gone = || "The clone source layer is gone.".to_string();
        let layer = layer_id.unwrap_or(stroke_layer);
        let frozen = match sample {
            SampleIn::CurrentLayer => Frozen::Layer(doc.node(layer).ok().and_then(|n| n.pixel_tiles().ok()).ok_or_else(gone)?.clone()),
            _ => {
                let mut d = doc.clone();
                if matches!(sample, SampleIn::CurrentBelow) {
                    d.node(layer).map_err(|_| gone())?;
                    hide_above(&mut d.nodes, layer);
                }
                if *ignore_adjustments {
                    hide_adjustments(&mut d.nodes);
                }
                Frozen::Comp(Box::new(d), RefCell::default())
            }
        };
        let exact = *m == [1.0, 0.0, 0.0, 1.0] && (anchor[0] - origin[0]).fract() == 0.0 && (anchor[1] - origin[1]).fract() == 0.0;
        Ok(CloneSrc { anchor: *anchor, origin: *origin, m: *m, exact, frozen, w: doc.width as i32, h: doc.height as i32 })
    }

    // The straight source pixel at integer document coords; transparent outside the canvas.
    fn fetch(&self, x: i32, y: i32) -> [f32; 4] {
        if x < 0 || y < 0 || x >= self.w || y >= self.h {
            return [0.0; 4];
        }
        let (t, ti) = ((x.div_euclid(TILE as i32), y.div_euclid(TILE as i32)), TILE as i32);
        let p = (y.rem_euclid(ti) * ti + x.rem_euclid(ti)) as usize;
        match &self.frozen {
            Frozen::Layer(tiles) => tiles.get(t.0, t.1).map_or([0.0; 4], |t| t.px.rgba_f32(p)),
            Frozen::Comp(doc, cache) => {
                let mut c = cache.borrow_mut();
                let tile = c.entry(t).or_insert_with(|| doc.flatten_tile_rgba8(t.0 as u32, t.1 as u32).unwrap_or_else(|_| vec![0; TILE_BYTES_U8]));
                std::array::from_fn(|i| tile[p * 4 + i] as f32 / 255.0)
            }
        }
    }

    /// The straight RGBA the destination point `(px, py)` reads: `anchor + M (p - origin)`, an
    /// exact pixel copy for a pure integer shift, else bilinear with zero outside the canvas.
    pub(super) fn sample(&self, px: f64, py: f64) -> [f32; 4] {
        let (dx, dy) = (px - self.origin[0], py - self.origin[1]);
        let [a, b, c, d] = self.m;
        let (sx, sy) = (self.anchor[0] + a * dx + b * dy, self.anchor[1] + c * dx + d * dy);
        if self.exact {
            return self.fetch(sx.round() as i32, sy.round() as i32);
        }
        if sx < -0.5 || sy < -0.5 || sx > self.w as f64 - 0.5 || sy > self.h as f64 - 0.5 {
            return [0.0; 4];
        }
        let (x0, y0) = (sx.floor(), sy.floor());
        let (fx, fy) = ((sx - x0) as f32, (sy - y0) as f32);
        let (x0, y0) = (x0 as i32, y0 as i32);
        let (p00, p10, p01, p11) = (self.fetch(x0, y0), self.fetch(x0 + 1, y0), self.fetch(x0, y0 + 1), self.fetch(x0 + 1, y0 + 1));
        std::array::from_fn(|i| {
            let top = p00[i] + (p10[i] - p00[i]) * fx;
            let bot = p01[i] + (p11[i] - p01[i]) * fx;
            top + (bot - top) * fy
        })
    }
}

impl CloneSrc {
    /// The visible composite of `snap`, read 1:1 at document coordinates.
    fn history(snap: &Document) -> CloneSrc {
        let d = Box::new(snap.clone());
        CloneSrc { anchor: [0.0; 2], origin: [0.0; 2], m: [1.0, 0.0, 0.0, 1.0], exact: true, frozen: Frozen::Comp(d, RefCell::default()), w: snap.width as i32, h: snap.height as i32 }
    }
}

impl PatSrc {
    fn new(pat: Arc<Pattern>, origin: [f64; 2], impressionist: bool) -> Result<PatSrc, String> {
        if !origin.iter().all(|v| v.is_finite()) {
            return Err("pattern source params must be finite".into());
        }
        let (pw, ph) = pat.size();
        let blurred = impressionist.then(|| {
            // The pattern is padded by the radius with wrapped texels, so the blur wraps at its edges.
            let r = (pw / 8).max(2) as usize;
            let (w, h) = (pw as usize + 2 * r, ph as usize + 2 * r);
            let mut data = Vec::with_capacity(w * h * 4);
            for j in 0..h {
                for i in 0..w {
                    data.extend_from_slice(&pat.sample_rgba((i as i32 - r as i32).rem_euclid(pw as i32), (j as i32 - r as i32).rem_euclid(ph as i32), 1.0));
                }
            }
            let mut plane = Plane { x: 0, y: 0, w, h, data };
            filters::box_blur(&mut plane, r);
            (0..ph as usize)
                .flat_map(|y| (0..pw as usize).map(move |x| (x, y)))
                .map(|(x, y)| std::array::from_fn(|c| plane.data[((y + r) * w + x + r) * 4 + c]))
                .collect()
        });
        Ok(PatSrc { pat, origin: [origin[0].round() as i32, origin[1].round() as i32], blurred })
    }

    fn sample(&self, x: i32, y: i32) -> [f32; 4] {
        let (pw, ph) = self.pat.size();
        let (tx, ty) = ((x - self.origin[0]).rem_euclid(pw as i32), (y - self.origin[1]).rem_euclid(ph as i32));
        match &self.blurred {
            Some(b) => b[ty as usize * pw as usize + tx as usize],
            None => self.pat.sample_rgba(tx, ty, 1.0),
        }
    }
}

impl StrokeSource {
    /// `doc` is the document the stroke opens on; a clone source freezes it here.
    pub(super) fn build(
        p: &SourceIn,
        doc: Option<&Document>,
        layer: u32,
        patterns: &HashMap<u32, Arc<Pattern>>,
        snapshots: &HashMap<u32, Document>,
    ) -> Result<StrokeSource, String> {
        match p {
            SourceIn::History { snapshot_id } => {
                let snap = snapshots.get(snapshot_id).ok_or_else(|| format!("unknown snapshot {snapshot_id}"))?;
                Ok(StrokeSource::Clone(CloneSrc::history(snap)))
            }
            SourceIn::Clone { .. } => {
                let doc = doc.ok_or("a clone source needs an open document")?;
                Ok(StrokeSource::Clone(CloneSrc::new(doc, p, layer)?))
            }
            SourceIn::Pattern { pattern_id, origin, impressionist } => {
                let pat = patterns.get(pattern_id).ok_or_else(|| format!("unknown pattern {pattern_id}"))?.clone();
                Ok(StrokeSource::Pattern(PatSrc::new(pat, *origin, *impressionist)?))
            }
        }
    }

    pub(super) fn sample(&self, x: i32, y: i32) -> [f32; 4] {
        match self {
            StrokeSource::Clone(c) => c.sample(x as f64, y as f64),
            StrokeSource::Pattern(p) => p.sample(x, y),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PatchIn {
    mode: String,
    #[serde(default)]
    content_aware: bool,
    /// Normal mode: the patch takes the larger of the source and target gradients, so target detail shows.
    #[serde(default)]
    transparent: bool,
    #[serde(default = "four")]
    structure: f32,
    #[serde(default = "two")]
    color: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MoveIn {
    #[serde(default)]
    extend: bool,
    #[serde(default = "four")]
    structure: f32,
    #[serde(default = "two")]
    color: f32,
    /// Transform On Drop: the dropped selection scales by this about its center.
    #[serde(default = "unit")]
    scale: [f32; 2],
}

fn unit() -> [f32; 2] {
    [1.0, 1.0]
}

fn four() -> f32 {
    4.0
}

fn two() -> f32 {
    2.0
}

fn px(p: &Plane, i: usize) -> [f32; 4] {
    [p.data[i * 4], p.data[i * 4 + 1], p.data[i * 4 + 2], p.data[i * 4 + 3]]
}

// [x0, y0, x1, y1] grown by `pad` and clipped to the canvas; None when nothing is left.
fn grow(r: [i32; 4], pad: i32, w: i32, h: i32) -> Option<[i32; 4]> {
    let g = [(r[0] - pad).max(0), (r[1] - pad).max(0), (r[2] + pad).min(w), (r[3] + pad).min(h)];
    (g[2] > g[0] && g[3] > g[1]).then_some(g)
}

// `out[p] = plane[p + (dx, dy)]` where that is inside the plane, else `plane[p]`.
fn shift_plane(e: &Plane, dx: i32, dy: i32) -> Plane {
    let mut out = e.clone();
    let (w, h) = (e.w as i32, e.h as i32);
    for j in 0..h {
        for i in 0..w {
            let (qi, qj) = (i + dx, j + dy);
            if qi >= 0 && qj >= 0 && qi < w && qj < h {
                let (o, q) = ((j * w + i) as usize * 4, (qj * w + qi) as usize * 4);
                out.data[o..o + 4].copy_from_slice(&e.data[q..q + 4]);
            }
        }
    }
    out
}

// `out[p] = mask[p + (dx, dy)]`, 0 outside.
fn shift_mask(f: &[f32], w: i32, h: i32, dx: i32, dy: i32) -> Vec<f32> {
    let mut out = vec![0f32; f.len()];
    for j in 0..h {
        for i in 0..w {
            let (qi, qj) = (i + dx, j + dy);
            if qi >= 0 && qj >= 0 && qi < w && qj < h {
                out[(j * w + i) as usize] = f[(qj * w + qi) as usize];
            }
        }
    }
    out
}

// `e` and its mask `f` resampled so the content about plane point `c` scales by `k` and lands
// about `c + d`: pixels bilinear (edge-clamped), the mask the largest of the 4 taps, so the Poisson
// boundary samples only pixels free of the selection.
fn scale_drop(e: &Plane, f: &[f32], c: (f64, f64), (dx, dy): (i32, i32), k: [f32; 2]) -> (Plane, Vec<f32>) {
    let (w, h) = (e.w as i32, e.h as i32);
    let (mut s, mut m) = (e.clone(), vec![0f32; f.len()]);
    let px = |x: i32, y: i32| {
        let i = (y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) as usize * 4;
        [e.data[i], e.data[i + 1], e.data[i + 2], e.data[i + 3]]
    };
    let mk = |x: i32, y: i32| if x < 0 || y < 0 || x >= w || y >= h { 0.0 } else { f[(y * w + x) as usize] };
    for j in 0..h {
        for i in 0..w {
            let qx = c.0 + (i as f64 + 0.5 - c.0 - dx as f64) / k[0] as f64 - 0.5;
            let qy = c.1 + (j as f64 + 0.5 - c.1 - dy as f64) / k[1] as f64 - 0.5;
            let o = (j * w + i) as usize;
            s.data[o * 4..o * 4 + 4].copy_from_slice(&bilinear(px, qx, qy));
            let (x0, y0) = (qx.floor() as i32, qy.floor() as i32);
            m[o] = mk(x0, y0).max(mk(x0 + 1, y0)).max(mk(x0, y0 + 1)).max(mk(x0 + 1, y0 + 1));
        }
    }
    (s, m)
}

// The dragged selection `s` (its mask `c`) onto `e` (the selection mask `f`): its pixels blend in
// over the new place (`mixed`: the larger of both gradients); a move then fills the vacated part,
// an extend keeps it.
#[allow(clippy::too_many_arguments)]
fn move_blend(e: &Plane, f: &[f32], s: &Plane, c: &[f32], extend: bool, mixed: bool, structure: f32, color: f32, seed: u32) -> Plane {
    let mut g = e.clone();
    heal::poisson(&mut g, s, c, &PoissonOpts { mixed, ..PoissonOpts::default() });
    if extend {
        return g;
    }
    let hole: Vec<f32> = f.iter().zip(c).map(|(&f, &c)| if f > 0.5 && c <= 0.5 { 1.0 } else { 0.0 }).collect();
    heal::content_aware_fill(&g, &hole, structure, color, seed, None)
}

fn drag_seed(dx: i32, dy: i32) -> u32 {
    (dx as u32).wrapping_mul(2654435761) ^ (dy as u32).wrapping_mul(40503)
}

impl Document {
    // Straight RGBA of layer `id` over `r` ([x0, y0, x1, y1], inside the canvas).
    pub(super) fn layer_plane(&self, id: u32, r: [i32; 4]) -> Result<Plane, String> {
        let tiles = self.node(id)?.pixel_tiles()?;
        let (w, h, ti) = ((r[2] - r[0]) as usize, (r[3] - r[1]) as usize, TILE as i32);
        let mut data = Vec::with_capacity(w * h * 4);
        for y in r[1]..r[3] {
            for x in r[0]..r[2] {
                let p = (y.rem_euclid(ti) * ti + x.rem_euclid(ti)) as usize;
                data.extend_from_slice(&tiles.get(x.div_euclid(ti), y.div_euclid(ti)).map_or([0.0; 4], |t| t.px.rgba_f32(p)));
            }
        }
        Ok(Plane { x: r[0], y: r[1], w, h, data })
    }

    // `layer_plane` for the healing tools: alpha 0 pixels carry the RGB of their visible neighbours.
    fn heal_plane(&self, id: u32, r: [i32; 4]) -> Result<Plane, String> {
        let mut p = self.layer_plane(id, r)?;
        heal::bleed_rgb(&mut p);
        Ok(p)
    }

    // The selection coverage over `r`; all 1 without a selection.
    pub(super) fn selection_plane(&self, r: [i32; 4]) -> Vec<f32> {
        let mut out = Vec::with_capacity(((r[2] - r[0]) * (r[3] - r[1])) as usize);
        for y in r[1]..r[3] {
            for x in r[0]..r[2] {
                out.push(self.selection.as_ref().map_or(1.0, |s| self.sel_at(s, x, y)));
            }
        }
        out
    }

    // Rewrites the pixels of `r` ([x0, y0, x1, y1], inside the canvas) with `f(x, y, old)` where it
    // returns Some; true when a stored value changed.
    pub(super) fn edit_rect(&mut self, id: u32, r: [i32; 4], keep_alpha: bool, mut f: impl FnMut(i32, i32, [f32; 4]) -> Option<[f32; 4]>) -> Result<bool, String> {
        let (depth, ti) = (self.depth, TILE as i32);
        let mut changed = false;
        let mut out: Vec<((i32, i32), Option<Pixels>)> = Vec::new();
        for (tx, ty) in self.tiles_of_rect(r[0], r[1], r[2], r[3]) {
            let old = self.node(id)?.pixel_tiles()?.get(tx, ty).map(|t| t.px.clone());
            let mut data = old.as_deref().cloned().unwrap_or_else(|| Pixels::transparent(depth));
            let mut touched = false;
            for y in r[1].max(ty * ti)..r[3].min((ty + 1) * ti) {
                for x in r[0].max(tx * ti)..r[2].min((tx + 1) * ti) {
                    let p = (y.rem_euclid(ti) * ti + x.rem_euclid(ti)) as usize;
                    let before = data.rgba_f32(p);
                    let Some(mut new) = f(x, y, before) else { continue };
                    if keep_alpha {
                        new[3] = before[3];
                    }
                    data.set_rgba_f32(p, new);
                    touched |= data.rgba_f32(p) != before;
                }
            }
            if touched {
                changed = true;
                out.push(((tx, ty), data.any_alpha().then_some(data)));
            }
        }
        let mut tiles_out = Vec::with_capacity(out.len());
        for (at, px) in out {
            tiles_out.push((at, px.map(|px| Tile { id: self.alloc_tile_id(), px: Arc::new(px) })));
        }
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        for ((tx, ty), t) in tiles_out {
            tiles.put(tx, ty, t);
        }
        Ok(changed)
    }

    // Writes `out` over the pixels of its rect, where `only` (if any) is above 0.
    fn put_plane(&mut self, id: u32, out: &Plane, only: Option<&[f32]>) -> Result<bool, String> {
        let keep_alpha = self.node(id)?.locks.transparency;
        let r = [out.x, out.y, out.x + out.w as i32, out.y + out.h as i32];
        self.edit_rect(id, r, keep_alpha, |x, y, _| {
            let i = (y - out.y) as usize * out.w + (x - out.x) as usize;
            only.is_none_or(|k| k[i] > 0.0).then(|| px(out, i))
        })
    }

    /// Heals what the closed stroke covered (spot heal kinds and the Healing Brush); true when a
    /// pixel changed.
    pub(super) fn heal_stroke(&mut self, st: &Stroke) -> Result<bool, String> {
        let Some(heal) = st.heal else { return Ok(false) };
        let (w, h, ti) = (self.width as i32, self.height as i32, TILE as i32);
        let mut cells: Vec<(i32, i32, f32)> = Vec::new();
        for (&(tx, ty), t) in &st.tiles {
            let cov = if self.selection.is_some() { self.coverage(tx, ty) } else { Cov::Uniform(1.0) };
            for p in 0..TILE_PIXELS {
                let (x, y) = (tx * ti + (p % TILE) as i32, ty * ti + (p / TILE) as i32);
                let k = (t.s[p].clamp(0.0, 1.0) * cov.at(p)).clamp(0.0, 1.0);
                if k > 0.0 && x >= 0 && y >= 0 && x < w && y < h {
                    cells.push((x, y, k));
                }
            }
        }
        let Some(b) = cells.iter().fold(None, |b: Option<[i32; 4]>, &(x, y, _)| {
            Some(b.map_or([x, y, x + 1, y + 1], |b| [b[0].min(x), b[1].min(y), b[2].max(x + 1), b[3].max(y + 1)]))
        }) else {
            return Ok(false);
        };
        let pad = if heal == Heal::ContentAware { 24.max(((b[2] - b[0]).max(b[3] - b[1]) + 1) / 2) } else { 4 };
        let Some(r) = grow(b, pad, w, h) else { return Ok(false) };
        let mut k = vec![0f32; ((r[2] - r[0]) * (r[3] - r[1])) as usize];
        for &(x, y, v) in &cells {
            k[(y - r[1]) as usize * (r[2] - r[0]) as usize + (x - r[0]) as usize] = v;
        }
        let c = self.heal_plane(st.layer, r)?;
        let out = match heal {
            Heal::ContentAware => heal::content_aware_fill(&c, &k, 4.0, 10.0, st.seed, None),
            Heal::Proximity | Heal::Texture => {
                let kind = if heal == Heal::Proximity { HealKind::Proximity } else { HealKind::Texture };
                let a = heal::spot_heal(&c, &k, kind, st.seed);
                let mut out = c.clone();
                heal::poisson(&mut out, &a, &k, &PoissonOpts::default());
                out
            }
            Heal::Healing => {
                let Some(src) = &st.source else { return Err("the healing brush needs a clone source".into()) };
                let mut a = c.clone();
                for j in 0..a.h {
                    for i in 0..a.w {
                        let v = src.sample(r[0] + i as i32, r[1] + j as i32);
                        a.data[(j * a.w + i) * 4..][..4].copy_from_slice(&v);
                    }
                }
                let mut out = c.clone();
                let fade = (st.diffusion < 7.0).then(|| 2f32.powf(st.diffusion));
                heal::poisson(&mut out, &a, &k, &PoissonOpts { fade, ..PoissonOpts::default() });
                out
            }
        };
        self.put_plane(st.layer, &out, Some(&k))
    }

    /// Red Eye: inside the circle of the `w` x `h` box at (`x`, `y`) every reddish
    /// pixel takes its red from the lesser of green and blue and darkens by `darken`.
    pub fn red_eye(&mut self, id: u32, x: i32, y: i32, w: u32, h: u32, pupil: f32, darken: f32) -> Result<bool, String> {
        self.check_idle()?;
        self.check_pixel_paint(id)?;
        if !pupil.is_finite() || !darken.is_finite() {
            return Err("red eye params must be finite".into());
        }
        let (pupil, darken) = (pupil.clamp(0.0, 1.0), darken.clamp(0.0, 1.0));
        let r = w.min(h) as f32 / 2.0 * (0.4 + 0.6 * pupil);
        let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
        let rect = [x.max(0), y.max(0), x.saturating_add(w as i32).min(self.width as i32), y.saturating_add(h as i32).min(self.height as i32)];
        if rect[2] <= rect[0] || rect[3] <= rect[1] {
            return Ok(false);
        }
        self.edit_rect(id, rect, false, |gx, gy, [pr, pg, pb, a]| {
            let (di, dj) = ((gx - x) as f32 + 0.5 - cx, (gy - y) as f32 + 0.5 - cy);
            if di * di + dj * dj > r * r || pr - pg.max(pb) <= 0.08 {
                return None;
            }
            Some([pg.min(pb) * (1.0 - darken), pg * (1.0 - darken), pb * (1.0 - darken), a])
        })
    }

    // The region a patch or move works in: the selection bounds and their dragged copy, grown.
    fn drag_region(&self, hb: [i32; 4], (dx, dy): (i32, i32), pad: i32) -> Option<[i32; 4]> {
        let (x1, y1) = (hb[0] + hb[2], hb[1] + hb[3]);
        grow([hb[0].min(hb[0] + dx), hb[1].min(hb[1] + dy), x1.max(x1 + dx), y1.max(y1 + dy)], pad, self.width as i32, self.height as i32)
    }

    /// Patch: the selection is repaired from the area dragged to (`mode` "source") or carried
    /// there (`"destination"`); `params_json` is `{mode, contentAware, structure, color, transparent}`.
    pub fn patch(&mut self, id: u32, dx: i32, dy: i32, params_json: &str) -> Result<bool, String> {
        self.check_idle()?;
        self.check_pixel_paint(id)?;
        let p: PatchIn = serde_json::from_str(params_json).map_err(|e| format!("bad patch params: {e}"))?;
        let destination = match p.mode.as_str() {
            "source" => false,
            "destination" => true,
            other => return Err(format!("unknown patch mode {other}")),
        };
        let hb = self.selection_bounds().ok_or("Make a selection first.")?;
        if (dx, dy) == (0, 0) {
            return Ok(false);
        }
        let pad = if p.content_aware { 24.max((hb[2].max(hb[3]) + 1) / 2) } else { 8 };
        let Some(b) = self.drag_region(hb, (dx, dy), pad) else { return Ok(false) };
        let e = self.heal_plane(id, b)?;
        let f = self.selection_plane(b);
        let (w, h, seed) = (e.w as i32, e.h as i32, drag_seed(dx, dy));
        let out = match (destination, p.content_aware) {
            (true, ca) => {
                let (s, c) = (shift_plane(&e, -dx, -dy), shift_mask(&f, w, h, -dx, -dy));
                move_blend(&e, &f, &s, &c, !ca, ca || p.transparent, p.structure, p.color, seed)
            }
            (false, false) => {
                let mut out = e.clone();
                heal::poisson(&mut out, &shift_plane(&e, dx, dy), &f, &PoissonOpts { mixed: p.transparent, ..PoissonOpts::default() });
                out
            }
            (false, true) => {
                let mut q = vec![0f32; f.len()];
                for j in 0..h {
                    for i in 0..w {
                        let (qi, qj) = (i + dx, j + dy);
                        if f[(j * w + i) as usize] > 0.0 && qi >= 0 && qj >= 0 && qi < w && qj < h {
                            q[(qj * w + qi) as usize] = 1.0;
                        }
                    }
                }
                heal::content_aware_fill(&e, &f, p.structure, p.color, seed, Some(&q))
            }
        };
        self.put_plane(id, &out, None)
    }

    /// Content-Aware Move: the selection moves by the drag and the vacated part is filled, or
    /// (`extend`) stays; `params_json` is `{extend, structure, color}`.
    pub fn content_aware_move(&mut self, id: u32, dx: i32, dy: i32, params_json: &str) -> Result<bool, String> {
        self.check_idle()?;
        self.check_pixel_paint(id)?;
        let p: MoveIn = serde_json::from_str(params_json).map_err(|e| format!("bad content-aware move params: {e}"))?;
        if !p.scale.iter().all(|k| (0.05..=20.0).contains(k)) {
            return Err("scale must be 0.05 to 20".into());
        }
        let hb = self.selection_bounds().ok_or("Make a selection first.")?;
        let plain = p.scale == [1.0, 1.0];
        if (dx, dy) == (0, 0) && plain {
            return Ok(false);
        }
        // The dropped box: the selection bounds scaled about their center, moved by the drag.
        let (cx, cy) = (hb[0] as f64 + hb[2] as f64 / 2.0, hb[1] as f64 + hb[3] as f64 / 2.0);
        let (hw, hh) = (hb[2] as f64 * p.scale[0] as f64 / 2.0, hb[3] as f64 * p.scale[1] as f64 / 2.0);
        let (x0, y0) = ((cx - hw).floor() as i32 + dx, (cy - hh).floor() as i32 + dy);
        let (x1, y1) = ((cx + hw).ceil() as i32 + dx, (cy + hh).ceil() as i32 + dy);
        let u = [hb[0].min(x0), hb[1].min(y0), (hb[0] + hb[2]).max(x1), (hb[1] + hb[3]).max(y1)];
        let pad = 24.max(((x1 - x0).max(y1 - y0).max(hb[2]).max(hb[3]) + 1) / 2);
        let Some(b) = grow(u, pad, self.width as i32, self.height as i32) else { return Ok(false) };
        let e = self.heal_plane(id, b)?;
        let f = self.selection_plane(b);
        let (s, c) = if plain {
            (shift_plane(&e, -dx, -dy), shift_mask(&f, e.w as i32, e.h as i32, -dx, -dy))
        } else {
            scale_drop(&e, &f, (cx - b[0] as f64, cy - b[1] as f64), (dx, dy), p.scale)
        };
        let out = move_blend(&e, &f, &s, &c, p.extend, true, p.structure, p.color, drag_seed(dx, dy));
        self.put_plane(id, &out, None)
    }

    /// The clone overlay: straight RGBA8 `out_w` x `out_h` of the clone source as it reads at the
    /// document rect (`x`, `y`, `w`, `h`); `params_json` is a clone source, `layer_id` the
    /// destination layer.
    #[allow(clippy::too_many_arguments)]
    pub fn clone_sample(&self, layer_id: u32, params_json: &str, x: f64, y: f64, w: f64, h: f64, out_w: u32, out_h: u32) -> Result<Vec<u8>, String> {
        self.check_idle()?;
        if !(1..=512).contains(&out_w) || !(1..=512).contains(&out_h) {
            return Err("the overlay size must be 1..=512 px per side".into());
        }
        if ![x, y, w, h].iter().all(|v| v.is_finite()) {
            return Err("the overlay rect must be finite".into());
        }
        let p: SourceIn = serde_json::from_str(params_json).map_err(|e| format!("bad clone source: {e}"))?;
        let src = CloneSrc::new(self, &p, layer_id)?;
        let mut out = Vec::with_capacity((out_w * out_h * 4) as usize);
        for j in 0..out_h {
            for i in 0..out_w {
                let v = src.sample(x + (i as f64 + 0.5) * w / out_w as f64 - 0.5, y + (j as f64 + 0.5) * h / out_h as f64 - 0.5);
                out.extend(v.map(|c| (c * 255.0).round().clamp(0.0, 255.0) as u8));
            }
        }
        Ok(out)
    }
}
