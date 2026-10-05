//! The compositor: tile contexts, the draw program and its tile cache, the level pyramid,
//! and program emission and execution. A child module of `doc`.

use super::*;
use crate::geom;

// ---------- compositing ----------

struct TileCtx {
    level: u32,
    // Top-left of the tile in level-`level` pixels.
    ox: u32,
    oy: u32,
    vw: usize,
    vh: usize,
    // A 32-bit document: Normal adjustments keep straight color above 1.
    hdr: bool,
}

enum MaskSrc<'a> {
    Full,
    Const(f32),
    Tile(&'a Pixels),
}

impl MaskSrc<'_> {
    #[inline(always)]
    fn at(&self, p: usize) -> f32 {
        match self {
            MaskSrc::Full => 1.0,
            MaskSrc::Const(v) => *v,
            MaskSrc::Tile(px) => px.mask_f32(p),
        }
    }
}

#[derive(Clone, Copy)]
enum Src<'a> {
    Tile(&'a Pixels),
    Buf(&'a [f32]),
}

impl Src<'_> {
    // Straight (unpremultiplied) RGBA.
    #[inline(always)]
    fn at(&self, p: usize) -> [f32; 4] {
        match self {
            Src::Tile(px) => px.rgba_f32(p),
            Src::Buf(b) => {
                let o = p * 4;
                let a = b[o + 3];
                if a > 0.0 {
                    [b[o] / a, b[o + 1] / a, b[o + 2] / a, a]
                } else {
                    [0.0; 4]
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw(
    dst: &mut [f32],
    src: Src,
    mask: &MaskSrc,
    scale: f32,
    mode: Blend,
    node_id: u32,
    blend_if: Option<&BlendIf>,
    c: &TileCtx,
) {
    if scale <= 0.0 {
        return;
    }
    let dissolve = mode == Blend::Dissolve;
    let plain = mode.is_passthrough_of_source();
    let hdr = c.hdr && hdr_mode(mode);
    for y in 0..c.vh {
        for x in 0..c.vw {
            let p = y * TILE + x;
            let [r, g, b, a] = src.at(p);
            if a <= 0.0 {
                continue;
            }
            let mut cov = a * scale * mask.at(p);
            if let Some(bi) = blend_if {
                cov *= blend_if_weight(bi, [r, g, b], straight(dst, p));
            }
            if cov <= 0.0 {
                continue;
            }
            if dissolve {
                // Document coordinates of the sample's top-left source pixel.
                let (dx, dy) = ((c.ox + x as u32) << c.level, (c.oy + y as u32) << c.level);
                if dissolve_hash(dx, dy, node_id) < cov {
                    cov = 1.0;
                } else {
                    continue;
                }
            }
            let o = p * 4;
            let ab = dst[o + 3];
            // W3C: Cm = (1 - ab) * Cs + ab * B(Cb, Cs); with ab = 0 that is Cs.
            let cm = if plain || ab <= 0.0 {
                [r, g, b]
            } else {
                let inv = 1.0 / ab;
                let bl = if hdr {
                    blend_hdr(mode, std::array::from_fn(|i| (dst[o + i] * inv).max(0.0)), [r, g, b])
                } else {
                    blend_rgb(mode, std::array::from_fn(|i| (dst[o + i] * inv).clamp(0.0, 1.0)), [r, g, b])
                };
                [
                    (1.0 - ab) * r + ab * bl[0],
                    (1.0 - ab) * g + ab * bl[1],
                    (1.0 - ab) * b + ab * bl[2],
                ]
            };
            let inv = 1.0 - cov;
            dst[o] = cov * cm[0] + inv * dst[o];
            dst[o + 1] = cov * cm[1] + inv * dst[o + 1];
            dst[o + 2] = cov * cm[2] + inv * dst[o + 2];
            dst[o + 3] = cov + inv * ab;
        }
    }
}

// Straight color of a premultiplied buffer pixel, clamped; black where transparent.
fn straight(buf: &[f32], p: usize) -> [f32; 3] {
    let o = p * 4;
    let a = buf[o + 3];
    if a <= 0.0 {
        return [0.0; 3];
    }
    std::array::from_fn(|i| (buf[o + i] / a).clamp(0.0, 1.0))
}

// `straight` without the upper clamp, for 32-bit documents.
fn straight_hdr(buf: &[f32], p: usize) -> [f32; 3] {
    let o = p * 4;
    let a = buf[o + 3];
    std::array::from_fn(|i| if a > 0.0 { (buf[o + i] / a).max(0.0) } else { 0.0 })
}

/// `Adjust` (docs/M3.md section 2) on the premultiplied `dst` in place: on straight color `o`,
/// `L = o + (blend(mode, o, adjust(o)) - o) * k` with `k = scale * mask * clip`, then blend-if
/// with "This Layer" = `L` and "Underlying Layer" = `o`. Alpha is never changed.
fn adjust_step(dst: &mut [f32], s: &Step, data: &[f32], mask: &MaskSrc, clip: Option<&[f32]>, c: &TileCtx) {
    let blend_if = (s.blend_if != BlendIf::default()).then_some(&s.blend_if);
    for y in 0..c.vh {
        for x in 0..c.vw {
            let p = y * TILE + x;
            let o = p * 4;
            let a = dst[o + 3];
            if a <= 0.0 {
                continue;
            }
            let mut k = s.scale * mask.at(p) * clip.map_or(1.0, |sh| sh[p]);
            if k <= 0.0 {
                continue;
            }
            let (dx, dy) = ((c.ox + x as u32) << c.level, (c.oy + y as u32) << c.level);
            if s.mode == Blend::Dissolve {
                if dissolve_hash(dx, dy, s.node) >= k {
                    continue;
                }
                k = 1.0;
            }
            let (orig, r) = if c.hdr && hdr_mode(s.mode) {
                let o = straight_hdr(dst, p);
                (o, blend_hdr(s.mode, o, adjust::apply(s.opcode, data, o, dx, dy)))
            } else {
                let o = straight(dst, p);
                (o, blend_rgb(s.mode, o, adjust::apply(s.opcode, data, o, dx, dy)))
            };
            let l: [f32; 3] = std::array::from_fn(|i| orig[i] + (r[i] - orig[i]) * k);
            let w = blend_if.map_or(1.0, |b| blend_if_weight(b, l, orig));
            for i in 0..3 {
                dst[o + i] = (orig[i] + (l[i] - orig[i]) * w) * a;
            }
        }
    }
}

// ---------- pyramid reduction ----------

// One level-up tile from the four quadrant tiles below it: each output pixel is the
// alpha-weighted mean colour and the mean alpha of the valid source pixels in its 2x2 block,
// rounded half up; a block with no alpha stays transparent. Integer maths throughout.
fn reduce_rgba<T: Copy + Default + Into<u64>>(
    kids: [Option<&[T]>; 4],
    valid: &[(usize, usize); 4],
    cast: fn(u64) -> T,
) -> Box<[T]> {
    let half = TILE / 2;
    // 8-bit sums fit in 32 bits, and a 32-bit division is much cheaper than a 64-bit one.
    let div = |n: u64, d: u64| if size_of::<T>() == 1 { ((n as u32) / (d as u32)) as u64 } else { n / d };
    let mut out = vec![T::default(); TILE_PIXELS * 4];
    for (q, px) in kids.into_iter().enumerate() {
        let Some(px) = px else { continue };
        let (qx, qy) = (q & 1, q >> 1);
        let (vw, vh) = valid[q];
        for oy in 0..half.min(vh.div_ceil(2)) {
            for ox in 0..half.min(vw.div_ceil(2)) {
                let o = ((qy * half + oy) * TILE + qx * half + ox) * 4;
                let at = |sx: usize, sy: usize| (sy * TILE + sx) * 4;
                let (x, y) = (ox * 2, oy * 2);
                if x + 1 < vw && y + 1 < vh {
                    let i = [at(x, y), at(x + 1, y), at(x, y + 1), at(x + 1, y + 1)];
                    let a0: u64 = px[i[0] + 3].into();
                    if i[1..].iter().all(|&j| px[j + 3].into() == a0) {
                        // Equal weights: the weighted mean is the plain mean.
                        if a0 > 0 {
                            for k in 0..3 {
                                let sum: u64 = i.iter().map(|&j| px[j + k].into()).sum();
                                out[o + k] = cast((sum + 2) / 4);
                            }
                            out[o + 3] = px[i[0] + 3];
                        }
                        continue;
                    }
                }
                let (mut c, mut a) = ([0u64; 3], 0u64);
                for (sx, sy) in [(x, y), (x + 1, y), (x, y + 1), (x + 1, y + 1)] {
                    if sx >= vw || sy >= vh {
                        continue;
                    }
                    let i = at(sx, sy);
                    let pa: u64 = px[i + 3].into();
                    for k in 0..3 {
                        c[k] += px[i + k].into() * pa;
                    }
                    a += pa;
                }
                if a == 0 {
                    continue;
                }
                for k in 0..3 {
                    out[o + k] = cast(div(2 * c[k] + a, 2 * a));
                }
                out[o + 3] = cast((a + 2) / 4);
            }
        }
    }
    out.into_boxed_slice()
}

// The mask counterpart: the mean of the 2x2 block, where pixels outside the document or under a
// missing tile count as the mask default.
fn reduce_mask<T: Copy + Into<u64>>(
    kids: [Option<&[T]>; 4],
    valid: &[(usize, usize); 4],
    default: T,
    cast: fn(u64) -> T,
) -> Box<[T]> {
    let half = TILE / 2;
    let mut out = vec![default; TILE_PIXELS];
    for (q, px) in kids.into_iter().enumerate() {
        let Some(px) = px else { continue };
        let (qx, qy) = (q & 1, q >> 1);
        let (vw, vh) = valid[q];
        for oy in 0..half {
            for ox in 0..half {
                let mut sum = 0u64;
                for (sx, sy) in [(ox * 2, oy * 2), (ox * 2 + 1, oy * 2), (ox * 2, oy * 2 + 1), (ox * 2 + 1, oy * 2 + 1)] {
                    sum += if sx < vw && sy < vh { px[sy * TILE + sx] } else { default }.into();
                }
                out[(qy * half + oy) * TILE + qx * half + ox] = cast((sum + 2) / 4);
            }
        }
    }
    out.into_boxed_slice()
}

// ---------- draw program ----------

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Op {
    Draw = 0,
    PushTransparent = 1,
    PushCopy = 2,
    Pop = 3,
    PopLerp = 4,
    PushShape = 5,
    DivShape = 6,
    MulShape = 7,
    SubBackdrop = 8,
    PopAddBackdrop = 9,
    PopShape = 10,
    Adjust = 11,
    Knockout = 12,
}

#[cfg(test)]
const OPS: [Op; 13] = [
    Op::Draw,
    Op::PushTransparent,
    Op::PushCopy,
    Op::Pop,
    Op::PopLerp,
    Op::PushShape,
    Op::DivShape,
    Op::MulShape,
    Op::SubBackdrop,
    Op::PopAddBackdrop,
    Op::PopShape,
    Op::Adjust,
    Op::Knockout,
];

const PROGRAM_VERSION: u32 = 2;
pub(super) const STEP_BYTES: usize = 72;
/// `Adjust` weights by the top shape (the clip base's coverage).
pub(super) const FLAG_CLIP: u8 = 1;

/// One step; `src` 0 means the top of the stack (`Draw` pops it, `PushShape` reads it,
/// `Knockout` reads it and punches the buffer below), `mask_kind` is 0 full, 1 `mask_const`,
/// 2 the tile `mask`. `opcode` is the `Adjust` kind, `blend_if` weights `Draw` and `Adjust`.
pub(super) struct Step {
    pub(super) op: Op,
    pub(super) src: u64,
    pub(super) mask: u64,
    pub(super) mask_kind: u8,
    mask_const: f32,
    scale: f32,
    mode: Blend,
    pub(super) node: u32,
    pub(super) flags: u8,
    pub(super) opcode: u32,
    pub(super) blend_if: BlendIf,
}

impl Step {
    fn new(op: Op) -> Step {
        Step {
            op,
            src: 0,
            mask: 0,
            mask_kind: 0,
            mask_const: 0.0,
            scale: 1.0,
            mode: Blend::Normal,
            node: 0,
            flags: 0,
            opcode: 0,
            blend_if: BlendIf::default(),
        }
    }
}

fn blend_if_bytes(b: &BlendIf) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, r) in [&b.gray, &b.red, &b.green, &b.blue].into_iter().enumerate() {
        out[i * 8..i * 8 + 4].copy_from_slice(&r.source);
        out[i * 8 + 4..i * 8 + 8].copy_from_slice(&r.destination);
    }
    out
}

/// The Blend If weight (docs/M3.md section 5): the product over gray (Lum), R, G and B of the
/// source ("This Layer") and destination ("Underlying Layer") ramps, in 0..255 units.
pub(super) fn blend_if_weight(b: &BlendIf, src: [f32; 3], dst: [f32; 3]) -> f32 {
    fn ramp(v: f32, [bo, bi, wi, wo]: [u8; 4]) -> f32 {
        let v = v.clamp(0.0, 255.0);
        let (bo, bi, wi, wo) = (bo as f32, bi as f32, wi as f32, wo as f32);
        if v < bo || v > wo {
            0.0
        } else if v < bi {
            (v - bo) / (bi - bo)
        } else if v <= wi {
            1.0
        } else {
            (wo - v) / (wo - wi)
        }
    }
    let key = |c: [f32; 3], ch: usize| 255.0 * if ch == 0 { blend::lum(c) } else { c[ch - 1] };
    [&b.gray, &b.red, &b.green, &b.blue]
        .into_iter()
        .enumerate()
        .map(|(ch, r)| ramp(key(src, ch), r.source) * ramp(key(dst, ch), r.destination))
        .product()
}

/// The ordered stack-machine ops for one display tile plus the level tiles they reference.
/// Binary layout (docs/M1.md section 3, version 2 in docs/M3.md section 2): 32-byte header,
/// `steps` 72-byte records, then for each payload a u64 key, u32 kind (0 RGBA8, 1 mask8, 2 `Adjust`
/// data as f32 LE), u32 byte length and that many bytes. Tiles come first, then data.
pub(super) struct Program {
    level: u32,
    tx: u32,
    ty: u32,
    ox: u32,
    oy: u32,
    vw: usize,
    vh: usize,
    hdr: bool,
    pub(super) steps: Vec<Step>,
    pub(super) payloads: Vec<(u64, Arc<Pixels>)>,
    // `Adjust` data blocks, referenced by the step's `src`.
    pub(super) data: Vec<(u64, Arc<Vec<f32>>)>,
}

/// One grid tile under a styled node's padded region: a stored or pyramid tile, or the
/// sub-program compositing a group or clipping group there.
enum Part {
    Px(Arc<Pixels>),
    Prog(Program),
}

/// A styled node's padded n x n region at (x0, y0) in level px: its parts, its mask tiles
/// (`mask_default` is set when a mask applies) and a key over every tile read.
pub(super) struct Region {
    x0: i64,
    y0: i64,
    n: usize,
    parts: Vec<(i64, i64, Part)>,
    masks: Vec<(i64, i64, Arc<Pixels>)>,
    mask_default: Option<f32>,
    // An enabled vector mask, its level and the document size; rendered on a style cache miss only.
    vector: Option<(VectorMask, u32, (u32, u32))>,
    key: u64,
}

fn put32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

fn put64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

impl Program {
    fn encode(&self, known: &[u64]) -> Vec<u8> {
        let send: Vec<&(u64, Arc<Pixels>)> = self.payloads.iter().filter(|(k, _)| !known.contains(k)).collect();
        let data: Vec<&(u64, Arc<Vec<f32>>)> = self.data.iter().filter(|(k, _)| !known.contains(k)).collect();
        let mut out = Vec::with_capacity(32 + self.steps.len() * STEP_BYTES + send.len() * TILE_BYTES_U8);
        let n = (send.len() + data.len()) as u32;
        let header = [self.level, self.ox, self.oy, self.vw as u32, self.vh as u32, self.steps.len() as u32, n];
        put32(&mut out, PROGRAM_VERSION);
        for v in header {
            put32(&mut out, v);
        }
        for s in &self.steps {
            out.extend_from_slice(&[s.op as u8, s.mask_kind, s.mode.index(), s.flags]);
            put32(&mut out, s.node);
            out.extend_from_slice(&s.scale.to_le_bytes());
            out.extend_from_slice(&s.mask_const.to_le_bytes());
            put64(&mut out, s.src);
            put64(&mut out, s.mask);
            put32(&mut out, s.opcode);
            put32(&mut out, 0);
            out.extend_from_slice(&blend_if_bytes(&s.blend_if));
        }
        for (key, px) in send {
            let bytes = px.to_bytes();
            put64(&mut out, *key);
            put32(&mut out, u32::from(matches!(px.as_ref(), Pixels::Mask8(_) | Pixels::Mask16(_))));
            put32(&mut out, bytes.len() as u32);
            out.extend_from_slice(&bytes);
        }
        for (key, d) in data {
            put64(&mut out, *key);
            put32(&mut out, 2);
            put32(&mut out, (d.len() * 4) as u32);
            d.iter().for_each(|v| out.extend_from_slice(&v.to_le_bytes()));
        }
        out
    }

    #[cfg(test)]
    pub(super) fn decode(b: &[u8]) -> Program {
        let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        let u64at = |o: usize| u64::from_le_bytes(b[o..o + 8].try_into().unwrap());
        let f32at = |o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
        assert_eq!(u32at(0), PROGRAM_VERSION, "program version");
        let (n_steps, n_payloads) = (u32at(24) as usize, u32at(28) as usize);
        let steps = (0..n_steps)
            .map(|i| {
                let o = 32 + i * STEP_BYTES;
                let range = |at: usize| -> [u8; 4] { b[at..at + 4].try_into().unwrap() };
                let pair = |at: usize| BlendRange { source: range(at), destination: range(at + 4) };
                Step {
                    op: OPS[b[o] as usize],
                    mask_kind: b[o + 1],
                    mode: Blend::from_index(b[o + 2]).expect("a known blend mode"),
                    flags: b[o + 3],
                    node: u32at(o + 4),
                    scale: f32at(o + 8),
                    mask_const: f32at(o + 12),
                    src: u64at(o + 16),
                    mask: u64at(o + 24),
                    opcode: u32at(o + 32),
                    blend_if: BlendIf { gray: pair(o + 40), red: pair(o + 48), green: pair(o + 56), blue: pair(o + 64) },
                }
            })
            .collect();
        let mut o = 32 + n_steps * STEP_BYTES;
        let (mut payloads, mut data) = (Vec::new(), Vec::new());
        for _ in 0..n_payloads {
            let (key, kind, len) = (u64at(o), u32at(o + 8), u32at(o + 12) as usize);
            let bytes = &b[o + 16..o + 16 + len];
            if kind == 2 {
                let floats = bytes.chunks_exact(4).map(|c| f32::from_le_bytes(c.try_into().unwrap())).collect();
                data.push((key, Arc::new(floats)));
            } else {
                payloads.push((key, Arc::new(Pixels::from_bytes(8, kind == 1, bytes).expect("payload bytes"))));
            }
            o += 16 + len;
        }
        Program {
            level: u32at(4),
            tx: 0,
            ty: 0,
            ox: u32at(8),
            oy: u32at(12),
            vw: u32at(16) as usize,
            vh: u32at(20) as usize,
            // Encoded programs exist only for 8-bit documents.
            hdr: false,
            steps,
            payloads,
            data,
        }
    }
}

/// Reduced display tiles, bounded by bytes. Eviction takes the lowest level first (rebuilding a
/// level-1 tile costs one reduction, a level-5 tile its whole subtree), then the least recently used.
#[derive(Default)]
pub(super) struct TileCache {
    map: HashMap<u64, (Arc<Pixels>, u32, u64)>,
    bytes: usize,
    clock: u64,
}

const CACHE_BYTES: usize = 256 << 20;

impl TileCache {
    pub(super) fn get(&mut self, key: u64) -> Option<Arc<Pixels>> {
        self.clock += 1;
        let clock = self.clock;
        let e = self.map.get_mut(&key)?;
        e.2 = clock;
        Some(e.0.clone())
    }

    pub(super) fn insert(&mut self, key: u64, px: Arc<Pixels>, level: u32) {
        self.clock += 1;
        self.bytes += px.byte_len();
        if let Some(old) = self.map.insert(key, (px, level, self.clock)) {
            self.bytes -= old.0.byte_len();
        }
        if self.bytes <= CACHE_BYTES {
            return;
        }
        let mut order: Vec<(u32, u64, u64)> = self.map.iter().map(|(k, (_, l, u))| (*l, *u, *k)).collect();
        order.sort_unstable();
        for (_, _, k) in order {
            if self.bytes * 4 <= CACHE_BYTES * 3 {
                break;
            }
            if let Some(old) = self.map.remove(&k) {
                self.bytes -= old.0.byte_len();
            }
        }
    }
}

// A 64-bit mixer for content keys (splitmix64 finalizer).
pub(super) fn mix(h: u64, v: u64) -> u64 {
    let mut z = h ^ v.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Document {
    // ---------- level pyramid ----------

    /// Document size in level-`level` pixels.
    pub(super) fn level_size(&self, level: u32) -> (u32, u32) {
        (self.width.div_ceil(1 << level), self.height.div_ceil(1 << level))
    }

    pub(super) fn level_tiles(&self, level: u32) -> (u32, u32) {
        let (w, h) = self.level_size(level);
        (tiles_for(w), tiles_for(h))
    }

    /// Valid (inside the document rect) level-`level` pixels of tile (tx, ty).
    pub(super) fn level_valid(&self, level: u32, tx: u32, ty: u32) -> (usize, usize) {
        let (w, h) = self.level_size(level);
        let v = |size: u32, t: u32| size.saturating_sub(t * TILE as u32).min(TILE as u32) as usize;
        (v(w, tx), v(h, ty))
    }

    // A node's tile at `level`: level 0 is the stored tile, every higher level a lazily built
    // 2x2 box average of the level below (premultiplied for pixels, plain for masks). The key is
    // derived from the child keys, so an edit (which allocates new tile ids) yields a new key and
    // the cache never serves stale content. Outside the document rect: transparent / mask default.
    pub(super) fn level_tile(
        &self,
        tiles: &Tiles,
        mask_default: Option<u32>,
        level: u32,
        tx: u32,
        ty: u32,
    ) -> Option<(u64, Arc<Pixels>)> {
        let (ntx, nty) = self.level_tiles(level);
        if tx >= ntx || ty >= nty {
            return None;
        }
        if level == 0 {
            let t = tiles.get(tx as i32, ty as i32)?;
            return Some((t.id, t.px.clone()));
        }
        let (key, empty) = self.footprint_key(tiles, mask_default, level, tx, ty);
        if empty {
            return None;
        }
        let hit = self.tile_cache.borrow_mut().get(key);
        if let Some(px) = hit {
            return Some((key, px));
        }
        let kids: [Option<(u64, Arc<Pixels>)>; 4] = std::array::from_fn(|q| {
            self.level_tile(tiles, mask_default, level - 1, tx * 2 + (q as u32 & 1), ty * 2 + (q as u32 >> 1))
        });
        let valid: [(usize, usize); 4] = std::array::from_fn(|q| {
            self.level_valid(level - 1, tx * 2 + (q as u32 & 1), ty * 2 + (q as u32 >> 1))
        });
        let px = Arc::new(self.reduce(&kids, &valid, mask_default));
        self.tile_cache.borrow_mut().insert(key, px.clone(), level);
        Some((key, px))
    }

    // The key mixes the level-0 tile ids under the tile, so a cache hit costs no rebuild of the
    // subtree, and an edit (which always allocates a new tile id) misses. `empty` means no stored
    // tile at all, which is a `None` tile at every level above it.
    fn footprint_key(
        &self,
        tiles: &Tiles,
        mask_default: Option<u32>,
        level: u32,
        tx: u32,
        ty: u32,
    ) -> (u64, bool) {
        let (n0x, n0y) = self.level_tiles(0);
        let n = 1u32 << level;
        let mut key = mix(0x9E37_79B9_7F4A_7C15, level as u64);
        key = mix(key, mask_default.map_or(u64::MAX, |d| d as u64));
        let mut empty = true;
        for j in 0..n {
            for i in 0..n {
                let (sx, sy) = (tx * n + i, ty * n + j);
                let id = if sx < n0x && sy < n0y { tiles.id_at(sx as i32, sy as i32) } else { 0 };
                empty &= id == 0;
                key = mix(key, id);
            }
        }
        (key | (1 << 63), empty)
    }

    pub(super) fn reduce(
        &self,
        kids: &[Option<(u64, Arc<Pixels>)>; 4],
        valid: &[(usize, usize); 4],
        mask_default: Option<u32>,
    ) -> Pixels {
        fn u8s(p: &Pixels) -> &[u8] {
            match p {
                Pixels::U8(d) | Pixels::Mask8(d) => d,
                _ => unreachable!("tile depth differs from the document depth"),
            }
        }
        fn u16s(p: &Pixels) -> &[u16] {
            match p {
                Pixels::U16(d) | Pixels::Mask16(d) => d,
                _ => unreachable!("tile depth differs from the document depth"),
            }
        }
        if self.depth == 32 {
            return self.reduce_f32(kids, valid, mask_default);
        }
        let k8 = || kids.each_ref().map(|k| k.as_ref().map(|(_, p)| u8s(p)));
        let k16 = || kids.each_ref().map(|k| k.as_ref().map(|(_, p)| u16s(p)));
        match (self.depth, mask_default) {
            (8, None) => Pixels::U8(reduce_rgba(k8(), valid, |v| v as u8)),
            (_, None) => Pixels::U16(reduce_rgba(k16(), valid, |v| v as u16)),
            (8, Some(d)) => Pixels::Mask8(reduce_mask(k8(), valid, d as u8, |v| v as u8)),
            (_, Some(d)) => Pixels::Mask16(reduce_mask(k16(), valid, d as u16, |v| v as u16)),
        }
    }

    // The float reduction: 32-bit documents, and the oracle for the integer one's test.
    pub(super) fn reduce_f32(
        &self,
        kids: &[Option<(u64, Arc<Pixels>)>; 4],
        valid: &[(usize, usize); 4],
        mask_default: Option<u32>,
    ) -> Pixels {
        let max = max_value(self.depth);
        let half = TILE / 2;
        if let Some(def) = mask_default {
            let def = def as f32 / max as f32;
            let mut out = vec![def; TILE_PIXELS];
            for q in 0..4 {
                let (qx, qy) = (q & 1, q >> 1);
                let (vw, vh) = valid[q];
                let px = kids[q].as_ref().map(|(_, p)| p.clone());
                for oy in 0..half {
                    for ox in 0..half {
                        let mut acc = 0.0;
                        for dy in 0..2 {
                            for dx in 0..2 {
                                let (sx, sy) = (ox * 2 + dx, oy * 2 + dy);
                                acc += match &px {
                                    Some(p) if sx < vw && sy < vh => p.mask_f32(sy * TILE + sx),
                                    _ => def,
                                };
                            }
                        }
                        out[(qy * half + oy) * TILE + qx * half + ox] = acc / 4.0;
                    }
                }
            }
            return Pixels::mask_from_norm(self.depth, &out);
        }
        let mut out = vec![0f32; TILE_PIXELS * 4];
        for q in 0..4 {
            let Some((_, px)) = &kids[q] else { continue };
            let (qx, qy) = (q & 1, q >> 1);
            let (vw, vh) = valid[q];
            for oy in 0..half {
                for ox in 0..half {
                    let mut acc = [0f32; 4];
                    for dy in 0..2 {
                        for dx in 0..2 {
                            let (sx, sy) = (ox * 2 + dx, oy * 2 + dy);
                            if sx >= vw || sy >= vh {
                                continue;
                            }
                            let [r, g, b, a] = px.rgba_f32(sy * TILE + sx);
                            acc[0] += r * a;
                            acc[1] += g * a;
                            acc[2] += b * a;
                            acc[3] += a;
                        }
                    }
                    if acc[3] <= 0.0 {
                        continue;
                    }
                    let inv = 1.0 / acc[3];
                    let o = ((qy * half + oy) * TILE + qx * half + ox) * 4;
                    out[o] = acc[0] * inv;
                    out[o + 1] = acc[1] * inv;
                    out[o + 2] = acc[2] * inv;
                    out[o + 3] = acc[3] / 4.0;
                }
            }
        }
        Pixels::from_straight(self.depth, &out)
    }

    // ---------- draw program (M1.md section 3) ----------

    fn payload(&self, prog: &mut Program, t: (u64, Arc<Pixels>)) -> u64 {
        if !prog.payloads.iter().any(|(k, _)| *k == t.0) {
            prog.payloads.push(t.clone());
        }
        t.0
    }

    fn node_tile(&self, node: &Node, prog: &mut Program) -> Option<u64> {
        let t = self.level_tile(content_tiles(node)?, None, prog.level, prog.tx, prog.ty)?;
        Some(self.payload(prog, t))
    }

    // (kind, tile key, const value) matching `MaskSrc`. An enabled vector mask or an artboard
    // rect multiplies into the raster mask as one mask8 payload (docs/M4.md D16).
    fn node_mask(&self, node: &Node, prog: &mut Program) -> (u8, u64, f32) {
        let raster = node.mask.as_ref().filter(|m| m.enabled).map(|m| {
            self.level_tile(&m.tiles, Some(m.default), prog.level, prog.tx, prog.ty)
                .ok_or(m.default as f32 / max_value(self.depth) as f32)
        });
        if let Some(t) = self.clip_mask(node, raster.as_ref(), prog.level, prog.tx, prog.ty) {
            return (2, self.payload(prog, t), 0.0);
        }
        match raster {
            Some(Ok(t)) => (2, self.payload(prog, t), 0.0),
            Some(Err(c)) => (1, 0, c),
            None => (0, 0, 0.0),
        }
    }

    // The payload key of a node's content tile; none when it is empty.
    fn node_src(&self, node: &Node, prog: &mut Program) -> Option<u64> {
        let t = match &node.kind {
            Kind::Fill(c) => self.fill_tile(c, prog.level, prog.tx, prog.ty)?,
            Kind::Shape(s) => self.shape_tile(s, prog.level, prog.tx, prog.ty)?,
            _ => return self.node_tile(node, prog),
        };
        Some(self.payload(prog, t))
    }

    // A fill layer's content rendered for one level tile (docs/M3.md section 2), cached under a
    // key mixed from the content JSON, the pattern it reads, the document size and the tile.
    pub(super) fn fill_tile(&self, c: &FillContent, level: u32, tx: u32, ty: u32) -> Option<(u64, Arc<Pixels>)> {
        let (ntx, nty) = self.level_tiles(level);
        if tx >= ntx || ty >= nty {
            return None;
        }
        let pattern = c.pattern_id().and_then(|id| self.patterns.iter().find(|p| p.id == id));
        let json = serde_json::to_string(c).expect("fill content serializes");
        let mut key = mix(0xF111_C047_E475_0001, json.len() as u64);
        for chunk in json.as_bytes().chunks(8) {
            let mut w = [0u8; 8];
            w[..chunk.len()].copy_from_slice(chunk);
            key = mix(key, u64::from_le_bytes(w));
        }
        let pat = pattern.map_or([0; 3], |p| [p.blob, p.width as u64, p.height as u64]);
        for v in pat.into_iter().chain([self.width as u64, self.height as u64, self.depth as u64]) {
            key = mix(key, v);
        }
        for v in [level, tx, ty] {
            key = mix(key, v as u64);
        }
        let key = key | (1 << 63);
        if let Some(px) = self.tile_cache.borrow_mut().get(key) {
            return Some((key, px));
        }
        let sample = self.sampler(c, [0.0, 0.0, self.width as f64, self.height as f64]);
        // Level pixels sample at their centre in document px.
        let (vw, vh) = self.level_valid(level, tx, ty);
        let step = (1u32 << level) as f64;
        let mut out = vec![0f32; TILE_PIXELS * 4];
        for y in 0..vh {
            let dy = ((ty as usize * TILE + y) as f64 + 0.5) * step;
            for x in 0..vw {
                let dx = ((tx as usize * TILE + x) as f64 + 0.5) * step;
                let o = (y * TILE + x) * 4;
                out[o..o + 4].copy_from_slice(&sample(dx, dy));
            }
        }
        let px = Arc::new(Pixels::from_straight(self.depth, &out));
        self.tile_cache.borrow_mut().insert(key, px.clone(), level);
        Some((key, px))
    }

    /// Straight RGBA of fill content at a document point; gradients lay out over `bx` [x, y, w, h].
    pub(super) fn sampler<'a>(&'a self, c: &'a FillContent, bx: [f64; 4]) -> Box<dyn Fn(f64, f64) -> [f32; 4] + 'a> {
        match c {
            FillContent::Solid(s) => {
                let rgba = [s.color[0], s.color[1], s.color[2], 255].map(|v| v as f32 / 255.0);
                Box::new(move |_, _| rgba)
            }
            FillContent::Gradient(g) => Box::new(g.sampler(bx)),
            FillContent::Pattern(p) => match c.pattern_id().and_then(|id| self.patterns.iter().find(|e| e.id == id)) {
                Some(e) => {
                    let bytes = self.blobs.get(&e.blob).map_or(&[][..], |b| &b[..]);
                    Box::new(p.sampler(e.width, e.height, bytes, [0.0, 0.0]))
                }
                None => Box::new(|_, _| [0.0; 4]),
            },
        }
    }

    // An adjustment's opcode, data key and data, cached by its params (which name its blob; blobs
    // never change). None when neutral or when its table does not parse (no step either way).
    fn compiled(&self, a: &Adjustment) -> Option<(u32, u64, Arc<Vec<f32>>)> {
        let json = serde_json::to_string(a).expect("adjustment serializes");
        let hdr = self.depth == 32;
        let mut key = mix(0x0AD7_0000_0000_0001 ^ hdr as u64, json.len() as u64);
        for chunk in json.as_bytes().chunks(8) {
            let mut w = [0u8; 8];
            w[..chunk.len()].copy_from_slice(chunk);
            key = mix(key, u64::from_le_bytes(w));
        }
        if let Some(hit) = self.adjust_cache.borrow().get(&key) {
            return hit.clone();
        }
        // Errors (a missing or bad table) are not cached: a loading blob may still arrive.
        let compiled = a.compile(&self.blobs, hdr).ok()?.map(|c| {
            let mut dk = mix(0xDA7A_0000_0000_0002, c.opcode as u64);
            for pair in c.data.chunks(2) {
                dk = mix(dk, pair[0].to_bits() as u64 | (pair.get(1).map_or(0, |v| v.to_bits() as u64) << 32));
            }
            dk = mix(dk, c.data.len() as u64);
            (c.opcode, dk | (1 << 63), Arc::new(c.data))
        });
        let mut cache = self.adjust_cache.borrow_mut();
        // ponytail: dropped wholesale past 64 param sets; an LRU if live edits thrash it.
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, compiled.clone());
        compiled
    }

    // `Knockout` runs only on a layer with an enabled effect (docs/M3.md section 2).
    fn knocks_out(node: &Node) -> bool {
        node.blending.knockout != Knockout::None && node.style.as_ref().is_some_and(|s| s.any_effect())
    }

    fn emit_node(&self, node: &Node, scale: f32, mode: Blend, clipped: bool, prog: &mut Program) {
        if let Some(style) = node.style.as_ref().filter(|s| s.any_effect()) {
            if !matches!(node.kind, Kind::Adjustment(_)) {
                return self.emit_styled(node, style, mode, prog);
            }
        }
        // An artboard is isolated.
        let mode = if node.artboard.is_some() && mode == Blend::PassThrough { Blend::Normal } else { mode };
        let (mk, mkey, mc) = self.node_mask(node, prog);
        if mode == Blend::PassThrough {
            let Kind::Group(children) = &node.kind else { return };
            prog.steps.push(Step::new(Op::PushCopy));
            self.emit_list(children, prog);
            let mut s = Step::new(Op::PopLerp);
            (s.mask_kind, s.mask, s.mask_const, s.scale) = (mk, mkey, mc, scale);
            prog.steps.push(s);
            return;
        }
        let src = match &node.kind {
            Kind::Pixel(_) | Kind::Smart(_) | Kind::Fill(_) | Kind::Shape(_) | Kind::Text(_) => {
                match self.node_src(node, prog) {
                    Some(k) => k,
                    None => return,
                }
            }
            Kind::Group(children) => {
                prog.steps.push(Step::new(Op::PushTransparent));
                if let Some(t) = node.artboard.as_ref().and_then(|a| self.artboard_tile(a, prog.level, prog.tx, prog.ty)) {
                    let mut s = Step::new(Op::Draw);
                    (s.src, s.node) = (self.payload(prog, t), node.id);
                    prog.steps.push(s);
                }
                self.emit_list(children, prog);
                0
            }
            Kind::Adjustment(a) => {
                let Some((opcode, key, data)) = self.compiled(a) else { return };
                if !data.is_empty() && !prog.data.iter().any(|(k, _)| *k == key) {
                    prog.data.push((key, data.clone()));
                }
                let mut s = Step::new(Op::Adjust);
                (s.mask_kind, s.mask, s.mask_const, s.scale, s.mode, s.node, s.opcode) =
                    (mk, mkey, mc, scale, mode, node.id, opcode);
                s.src = if data.is_empty() { 0 } else { key };
                s.flags = if clipped { FLAG_CLIP } else { 0 };
                s.blend_if = node.blending.blend_if.clone();
                prog.steps.push(s);
                return;
            }
        };
        let mut s = Step::new(Op::Draw);
        (s.src, s.mask_kind, s.mask, s.mask_const, s.scale, s.mode, s.node) =
            (src, mk, mkey, mc, scale, mode, node.id);
        s.blend_if = node.blending.blend_if.clone();
        prog.steps.push(s);
    }

    // A clipping group: base B plus the consecutive clipped nodes above it (M1.md section 3).
    // S is B's coverage. B's share of each pixel is divided by S, the clipped nodes draw onto it
    // normally, and the result is multiplied by S again (source-atop at full fill).
    // A styled base draws alone; the clipped nodes then draw onto that result through its raw
    // shape S (content alpha x mask x opacity), so effects past the shape stay uncovered.
    fn emit_clipping(&self, base: &Node, clipped: &[Node], prog: &mut Program) {
        let styled = base.style.as_ref().filter(|s| s.any_effect() && !matches!(base.kind, Kind::Adjustment(_)));
        let Some(style) = styled else {
            return self.clip_steps(base, clipped, base.fill, base.opacity, base.blend, prog);
        };
        self.emit_styled(base, style, base.blend, prog);
        let (mk, mkey, mc) = self.node_mask(base, prog);
        let mut shape = Step::new(Op::PushShape);
        (shape.mask_kind, shape.mask, shape.mask_const, shape.scale) = (mk, mkey, mc, base.opacity);
        if let Kind::Group(children) = &base.kind {
            prog.steps.push(Step::new(Op::PushTransparent));
            self.emit_list(children, prog);
            prog.steps.push(shape);
            prog.steps.push(Step::new(Op::Pop));
        } else {
            let Some(src) = self.node_src(base, prog) else { return };
            shape.src = src;
            prog.steps.push(shape);
        }
        // out = (1 - S) dst + S (dst with the clipped nodes drawn); adjustments carry no
        // FLAG_CLIP here, the lerp applies S once.
        prog.steps.push(Step::new(Op::PushCopy));
        for n in clipped {
            if n.visible && n.opacity > 0.0 {
                self.emit_node(n, n.opacity * n.fill, n.blend, false, prog);
            }
        }
        prog.steps.push(Step::new(Op::MulShape));
        prog.steps.push(Step::new(Op::PopAddBackdrop));
        prog.steps.push(Step::new(Op::PopShape));
    }

    // `emit_clipping` with the base drawn at `fill`, then composited at `opacity` in `blend`.
    fn clip_steps(&self, base: &Node, clipped: &[Node], fill: f32, opacity: f32, blend: Blend, prog: &mut Program) {
        let (mk, mkey, mc) = self.node_mask(base, prog);
        let pass = blend == Blend::PassThrough;
        // A pass-through base stays in place, so its opacity and fill are part of its share.
        let k = if pass { opacity * fill } else { 1.0 };
        let mut shape = Step::new(Op::PushShape);
        (shape.mask_kind, shape.mask, shape.mask_const, shape.scale) = (mk, mkey, mc, k);
        match &base.kind {
            Kind::Adjustment(_) => return,
            Kind::Pixel(_) | Kind::Smart(_) | Kind::Fill(_) | Kind::Shape(_) | Kind::Text(_) => {
                let Some(src) = self.node_src(base, prog) else { return };
                shape.src = src;
                prog.steps.push(shape);
                prog.steps.push(Step::new(Op::PushTransparent));
                let mut s = Step::new(Op::Draw);
                (s.src, s.mask_kind, s.mask, s.mask_const, s.scale, s.node) =
                    (src, mk, mkey, mc, fill, base.id);
                prog.steps.push(s);
            }
            Kind::Group(children) if !pass => {
                prog.steps.push(Step::new(Op::PushTransparent)); // the group's share
                prog.steps.push(Step::new(Op::PushTransparent)); // the base composited alone
                self.emit_list(children, prog);
                prog.steps.push(shape);
                let mut s = Step::new(Op::Draw);
                (s.mask_kind, s.mask, s.mask_const, s.scale, s.node) = (mk, mkey, mc, fill, base.id);
                prog.steps.push(s);
            }
            Kind::Group(children) => {
                prog.steps.push(Step::new(Op::PushTransparent));
                self.emit_list(children, prog);
                prog.steps.push(shape);
                prog.steps.push(Step::new(Op::Pop));
                prog.steps.push(Step::new(Op::PushCopy)); // the in-place result
                prog.steps.push(Step::new(Op::PushCopy));
                self.emit_list(children, prog);
                let mut s = Step::new(Op::PopLerp);
                (s.mask_kind, s.mask, s.mask_const, s.scale) = (mk, mkey, mc, k);
                prog.steps.push(s);
                prog.steps.push(Step::new(Op::SubBackdrop));
            }
        }
        prog.steps.push(Step::new(Op::DivShape));
        for n in clipped {
            if n.visible && n.opacity > 0.0 {
                self.emit_node(n, n.opacity * n.fill, n.blend, true, prog);
            }
        }
        prog.steps.push(Step::new(Op::MulShape));
        if pass {
            prog.steps.push(Step::new(Op::PopAddBackdrop));
        } else {
            let mut s = Step::new(Op::Draw);
            (s.scale, s.mode, s.node) = (opacity, blend, base.id);
            prog.steps.push(s);
        }
        prog.steps.push(Step::new(Op::PopShape));
    }

    // A stored tile at level 0 (anywhere on the grid), else a pyramid tile inside the document.
    fn region_tile(&self, tiles: &Tiles, mask_default: Option<u32>, level: u32, i: i64, j: i64) -> Option<(u64, Arc<Pixels>)> {
        if level == 0 {
            return tiles.get(i as i32, j as i32).map(|t| (t.id, t.px.clone()));
        }
        if i < 0 || j < 0 {
            return None;
        }
        self.level_tile(tiles, mask_default, level, i as u32, j as u32)
    }

    // The tiles under a styled node's padded region; none when the node has no content there.
    pub(super) fn styled_region(&self, node: &Node, level: u32, x0: i64, y0: i64, n: usize) -> Option<Region> {
        let t = TILE as i64;
        let (ntx, nty) = self.level_tiles(level);
        let in_doc = |i: i64, j: i64| i >= 0 && j >= 0 && i < ntx as i64 && j < nty as i64;
        let mask = node.mask.as_ref().filter(|m| m.enabled);
        let mut key = mix(0x57E1_ED00_0000_0001, n as u64);
        let (mut parts, mut masks) = (Vec::new(), Vec::new());
        for j in y0.div_euclid(t)..=(y0 + n as i64 - 1).div_euclid(t) {
            for i in x0.div_euclid(t)..=(x0 + n as i64 - 1).div_euclid(t) {
                let sub = |f: &dyn Fn(&mut Program)| {
                    let mut p = self.blank_program(level, i as u32, j as u32);
                    f(&mut p);
                    let known: Vec<u64> = p.payloads.iter().map(|x| x.0).chain(p.data.iter().map(|x| x.0)).collect();
                    (mix_bytes(0x5B, &p.encode(&known)), Part::Prog(p))
                };
                let part = match &node.kind {
                    Kind::Group(children) if in_doc(i, j) => Some(sub(&|p| self.emit_list(children, p))),
                    Kind::Fill(c) if in_doc(i, j) => {
                        self.fill_tile(c, level, i as u32, j as u32).map(|(k, px)| (k, Part::Px(px)))
                    }
                    Kind::Shape(s) if in_doc(i, j) => {
                        self.shape_tile(s, level, i as u32, j as u32).map(|(k, px)| (k, Part::Px(px)))
                    }
                    Kind::Pixel(_) | Kind::Smart(_) | Kind::Text(_) => {
                        self.region_tile(content_tiles(node)?, None, level, i, j).map(|(k, px)| (k, Part::Px(px)))
                    }
                    _ => None,
                };
                key = mix(key, part.as_ref().map_or(0, |p| p.0));
                parts.extend(part.map(|(_, p)| (i, j, p)));
                if let Some(m) = mask {
                    let mt = self.region_tile(&m.tiles, Some(m.default), level, i, j);
                    key = mix(key, mt.as_ref().map_or(0, |t| t.0));
                    masks.extend(mt.map(|(_, px)| (i, j, px)));
                }
            }
        }
        if parts.is_empty() {
            return None;
        }
        let mask_default = mask.map(|m| m.default as f32 / max_value(self.depth) as f32);
        key = mix(key, mask_default.map_or(u64::MAX, |d| d.to_bits() as u64));
        let vm = node.vector_mask.as_ref().filter(|m| m.enabled);
        key = mix_bytes(key, serde_json::to_string(&vm).expect("vector mask serializes").as_bytes());
        let vector = vm.map(|m| (m.clone(), level, (self.width, self.height)));
        Some(Region { x0, y0, n, parts, masks, mask_default, vector, key })
    }

    // Straight RGBA of a region with alpha times the masks, the raster and the vector mask plane.
    pub(super) fn region_pixels(r: &Region) -> (Vec<[f32; 4]>, Option<styles::Plane>, Option<styles::Plane>) {
        let n = r.n;
        let mut content = vec![[0f32; 4]; n * n];
        for (i, j, part) in &r.parts {
            let run;
            let src = match part {
                Part::Px(px) => Src::Tile(px),
                Part::Prog(p) => {
                    run = Document::run_program(p);
                    Src::Buf(&run)
                }
            };
            overlap(r.x0, r.y0, n, *i, *j).for_each(|(d, s)| content[d] = src.at(s));
        }
        let mask = r.mask_default.map(|def| {
            let mut m = styles::Plane { w: n, h: n, v: vec![def; n * n] };
            for (i, j, px) in &r.masks {
                overlap(r.x0, r.y0, n, *i, *j).for_each(|(d, s)| m.v[d] = px.mask_f32(s));
            }
            content.iter_mut().zip(&m.v).for_each(|(c, k)| c[3] *= k);
            m
        });
        let vector = r.vector.as_ref().map(|(m, level, doc)| {
            let v = super::vector::feather_plane(m, *doc, *level, r.x0, r.y0, n, n, super::vector::FEATHER_MAX);
            content.iter_mut().zip(&v).for_each(|(c, k)| c[3] *= k);
            styles::Plane { w: n, h: n, v }
        });
        (content, mask, vector)
    }

    // The layer bounds box effects read (document px) and a key for it: tight pixel bounds for
    // pixel and smart layers, the document for fills and groups. Only computed when read.
    pub(super) fn style_bounds(&self, node: &Node, style: &Style) -> ([f64; 4], u64) {
        let reads = !node.blending.transparency_shapes
            || !style.gradient_overlays.is_empty()
            || !style.pattern_overlays.is_empty()
            || style.texture.is_some()
            || style.strokes.iter().any(|s| !matches!(s.fill, FillContent::Solid(_)));
        if !reads {
            return ([0.0; 4], 0);
        }
        if let Kind::Shape(s) = &node.kind {
            let b = geom::bounds(&s.path).map_or([0.0; 4], |[l, t, r, b]| [l, t, r - l, b - t]);
            return (b, mix_bytes(3, serde_json::to_string(&s.path).expect("path serializes").as_bytes()));
        }
        match content_tiles(node) {
            // ponytail: scans every tile per rendered display tile; cache by key if it shows up in profiles.
            Some(tiles) => {
                let key = tiles.iter().fold(1, |k, ((x, y), t)| k ^ mix(mix(t.id, *x as u64), *y as u64));
                (tiles_bounds(tiles).map_or([0.0; 4], |b| b.map(|v| v as f64)), key)
            }
            None => ([0.0, 0.0, self.width as f64, self.height as f64], 2),
        }
    }

    /// A styled node (docs/M3.md section 5) on the program's tile: its padded region (the tile
    /// grown by the style's reach) goes through `render_layer`; the centre crops of the behind
    /// planes and the styled content become payload tiles drawn by `Draw` after the `Knockout`.
    /// Level L scales every px parameter by 2^-L.
    fn emit_styled(&self, node: &Node, style: &Style, mode: Blend, prog: &mut Program) {
        let (level, tx, ty) = (prog.level, prog.tx, prog.ty);
        let k = 0.5f32.powi(level as i32);
        let style = Style { scale: style.scale * k, ..style.clone() };
        let pad = styles::reach(&style) as usize;
        let n = TILE + 2 * pad;
        let (x0, y0) = (tx as i64 * TILE as i64 - pad as i64, ty as i64 * TILE as i64 - pad as i64);
        let mode = if mode == Blend::PassThrough { Blend::Normal } else { mode };
        let fill = node.fill;
        let group_knock = matches!(node.kind, Kind::Group(_)) && Document::knocks_out(node);
        let Some(region) = self.styled_region(node, level, x0, y0, n) else { return };
        let (bounds, bounds_key) = self.style_bounds(node, &style);

        let mut key = mix_bytes(0x57E1_ED00_0000_0002, serde_json::to_string(&style).expect("style serializes").as_bytes());
        key = mix_bytes(key, serde_json::to_string(&node.blending).expect("blending serializes").as_bytes());
        let light = [self.global_light.angle.to_bits(), self.global_light.altitude.to_bits()];
        for v in [fill.to_bits(), mode.index() as u32, light[0], light[1], self.width, self.height, self.depth as u32] {
            key = mix(key, v as u64);
        }
        for p in &self.patterns {
            key = mix(mix(mix(mix_bytes(key, p.id.as_bytes()), p.blob), p.width as u64), p.height as u64);
        }
        for v in [region.key, bounds_key, level as u64, tx as u64, ty as u64, group_knock as u64] {
            key = mix(key, v);
        }
        let live = |present: bool, enabled: bool| style.enabled && present && enabled;
        let behind: Vec<(Blend, f32)> = style
            .drop_shadows
            .iter()
            .filter(|e| live(e.present, e.enabled))
            .map(|e| (e.blend, e.opacity))
            .chain(style.outer_glow.iter().filter(|e| live(e.present, e.enabled)).map(|e| (e.blend, e.opacity)))
            .collect();
        let keys: Vec<u64> =
            (0..behind.len() + 1 + group_knock as usize).map(|i| mix(key, i as u64) | (1 << 63)).collect();
        let random = style.drop_shadows.iter().chain(&style.inner_shadows).any(|e| e.noise > 0.0)
            || style.outer_glow.iter().chain(&style.inner_glow).any(|e| e.noise > 0.0 || e.jitter > 0.0);
        let hits: Option<Vec<Arc<Pixels>>> =
            if random { None } else { keys.iter().map(|k| self.tile_cache.borrow_mut().get(*k)).collect() };
        let planes = hits.unwrap_or_else(|| {
            let (content, mask, vector) = Document::region_pixels(&region);
            let cx = styles::Ctx {
                origin: [x0 as i32, y0 as i32],
                level,
                scale: 1.0,
                light: &self.global_light,
                patterns: &self.patterns,
                blobs: &self.blobs,
                bounds: bounds.map(|v| v * k as f64),
                doc: [self.width as f64 * k as f64, self.height as f64 * k as f64],
            };
            let layer = styles::Layer {
                w: n,
                h: n,
                content: &content,
                blend: mode,
                fill,
                blending: &node.blending,
                layer_mask: mask.as_ref(),
                vector_mask: vector.as_ref(),
            };
            let r = styles::render_layer(&style, &layer, &cx);
            debug_assert!(r.behind.iter().map(|b| (b.blend, b.opacity)).eq(behind.iter().copied()));
            let crop = |p: &[[f32; 4]]| {
                let v: Vec<f32> = (0..TILE).flat_map(|y| p[(y + pad) * n + pad..(y + pad) * n + pad + TILE].iter().flatten().copied()).collect();
                Arc::new(Pixels::from_straight(self.depth, &v))
            };
            let mut planes: Vec<Arc<Pixels>> = r.behind.iter().map(|b| crop(&b.rgba)).chain([crop(&r.content)]).collect();
            if group_knock {
                planes.push(crop(&content));
            }
            if !random {
                let mut cache = self.tile_cache.borrow_mut();
                keys.iter().zip(&planes).for_each(|(k, p)| cache.insert(*k, p.clone(), level));
            }
            planes
        });

        if Document::knocks_out(node) {
            // Layers knock out by their content tile and mask, groups by their composite.
            let (src, (mk, mkey, mc)) = if group_knock {
                (Some(self.payload(prog, (keys[behind.len() + 1], planes[behind.len() + 1].clone()))), (0, 0, 0.0))
            } else {
                (self.node_src(node, prog), self.node_mask(node, prog))
            };
            if let Some(src) = src {
                let mut s = Step::new(Op::Knockout);
                (s.src, s.mask_kind, s.mask, s.mask_const, s.scale) = (src, mk, mkey, mc, node.opacity);
                prog.steps.push(s);
            }
        }
        let draws = behind.iter().copied().chain([(mode, 1.0)]).enumerate();
        for (i, (blend, opacity)) in draws {
            if !planes[i].any_alpha() {
                continue;
            }
            let mut s = Step::new(Op::Draw);
            (s.src, s.scale, s.mode, s.node) = (self.payload(prog, (keys[i], planes[i].clone())), opacity * node.opacity, blend, node.id);
            if i == behind.len() {
                s.blend_if = node.blending.blend_if.clone();
            }
            prog.steps.push(s);
        }
    }

    fn emit_list(&self, nodes: &[Node], prog: &mut Program) {
        let mut i = 0;
        while i < nodes.len() {
            let mut j = i + 1;
            while j < nodes.len() && nodes[j].clipping {
                j += 1;
            }
            let base = &nodes[i];
            if j == i + 1 {
                if base.visible && base.opacity > 0.0 {
                    self.emit_node(base, base.opacity * base.fill, base.blend, false, prog);
                }
            } else if base.visible {
                self.emit_clipping(base, &nodes[i + 1..j], prog);
            }
            i = j;
        }
    }

    /// The ordered draw program for one display tile, with the level tiles it references.
    pub(super) fn program(&self, level: u32, tx: u32, ty: u32) -> Result<Program, String> {
        if level > 8 {
            return Err("level must be <= 8".into());
        }
        let mut prog = self.blank_program(level, tx, ty);
        self.emit_list(&self.nodes, &mut prog);
        Ok(prog)
    }

    fn blank_program(&self, level: u32, tx: u32, ty: u32) -> Program {
        let (vw, vh) = self.level_valid(level, tx, ty);
        Program {
            level,
            tx,
            ty,
            ox: tx * TILE as u32,
            oy: ty * TILE as u32,
            vw,
            vh,
            hdr: self.depth == 32,
            steps: Vec::new(),
            payloads: Vec::new(),
            data: Vec::new(),
        }
    }

    /// One display tile as premultiplied f32 RGBA, by running its draw program.
    pub(super) fn run_program(prog: &Program) -> Vec<f32> {
        let tiles: HashMap<u64, &Pixels> = prog.payloads.iter().map(|(k, p)| (*k, p.as_ref())).collect();
        let data: HashMap<u64, &[f32]> = prog.data.iter().map(|(k, d)| (*k, d.as_slice())).collect();
        let c = TileCtx { level: prog.level, ox: prog.ox, oy: prog.oy, vw: prog.vw, vh: prog.vh, hdr: prog.hdr };
        let mut stack: Vec<Vec<f32>> = vec![vec![0f32; TILE_PIXELS * 4]];
        let mut shapes: Vec<Vec<f32>> = Vec::new();
        for s in &prog.steps {
            let mask = match s.mask_kind {
                1 => MaskSrc::Const(s.mask_const),
                2 => MaskSrc::Tile(tiles[&s.mask]),
                _ => MaskSrc::Full,
            };
            match s.op {
                Op::PushTransparent => stack.push(vec![0f32; TILE_PIXELS * 4]),
                Op::PushCopy => {
                    let top = stack.last().expect("stack is never empty").clone();
                    stack.push(top);
                }
                Op::Pop => {
                    stack.pop();
                }
                Op::Draw => {
                    let bi = (s.blend_if != BlendIf::default()).then_some(&s.blend_if);
                    if s.src != 0 {
                        let src = Src::Tile(tiles[&s.src]);
                        draw(stack.last_mut().expect("stack"), src, &mask, s.scale, s.mode, s.node, bi, &c);
                    } else {
                        let g = stack.pop().expect("stack");
                        let dst = stack.last_mut().expect("stack");
                        draw(dst, Src::Buf(&g), &mask, s.scale, s.mode, s.node, bi, &c);
                    }
                }
                Op::Adjust => {
                    let clip = (s.flags & FLAG_CLIP != 0).then(|| shapes.last().expect("shape stack").as_slice());
                    let d = if s.src != 0 { data[&s.src] } else { &[] };
                    adjust_step(stack.last_mut().expect("stack"), s, d, &mask, clip, &c);
                }
                Op::Knockout => {
                    // `destAlpha *= 1 - shape * opacity`; premultiplied, so every channel scales.
                    let (top, rest) = stack.split_last_mut().expect("stack");
                    let (dst, src) = if s.src != 0 {
                        (top, Src::Tile(tiles[&s.src]))
                    } else {
                        (rest.last_mut().expect("a buffer below the top"), Src::Buf(top.as_slice()))
                    };
                    for y in 0..c.vh {
                        for x in 0..c.vw {
                            let p = y * TILE + x;
                            let f = 1.0 - src.at(p)[3] * mask.at(p) * s.scale;
                            dst[p * 4..p * 4 + 4].iter_mut().for_each(|v| *v *= f);
                        }
                    }
                }
                Op::PopLerp => {
                    let r = stack.pop().expect("stack");
                    let dst = stack.last_mut().expect("stack");
                    for y in 0..c.vh {
                        for x in 0..c.vw {
                            let p = y * TILE + x;
                            let k = s.scale * mask.at(p);
                            if k <= 0.0 {
                                continue;
                            }
                            let o = p * 4;
                            for ch in 0..4 {
                                dst[o + ch] += (r[o + ch] - dst[o + ch]) * k;
                            }
                        }
                    }
                }
                Op::PushShape => {
                    let src = if s.src != 0 {
                        Src::Tile(tiles[&s.src])
                    } else {
                        Src::Buf(stack.last().expect("stack"))
                    };
                    let mut shape = vec![0f32; TILE_PIXELS];
                    for y in 0..c.vh {
                        for x in 0..c.vw {
                            let p = y * TILE + x;
                            shape[p] = src.at(p)[3] * mask.at(p) * s.scale;
                        }
                    }
                    shapes.push(shape);
                }
                Op::DivShape | Op::MulShape => {
                    let shape = shapes.last().expect("shape stack");
                    let dst = stack.last_mut().expect("stack");
                    for p in 0..TILE_PIXELS {
                        let f = match s.op {
                            Op::MulShape => shape[p],
                            _ if shape[p] > 0.0 => 1.0 / shape[p],
                            _ => 0.0,
                        };
                        dst[p * 4..p * 4 + 4].iter_mut().for_each(|v| *v *= f);
                    }
                }
                Op::SubBackdrop => {
                    let shape = shapes.last().expect("shape stack");
                    let (dst, rest) = stack.split_last_mut().expect("stack");
                    let back = rest.last().expect("a backdrop below the top");
                    for p in 0..TILE_PIXELS {
                        for ch in 0..4 {
                            let o = p * 4 + ch;
                            dst[o] -= (1.0 - shape[p]) * back[o];
                        }
                    }
                }
                Op::PopAddBackdrop => {
                    let shape = shapes.last().expect("shape stack");
                    let g = stack.pop().expect("stack");
                    let dst = stack.last_mut().expect("stack");
                    for p in 0..TILE_PIXELS {
                        for ch in 0..4 {
                            let o = p * 4 + ch;
                            dst[o] = (1.0 - shape[p]) * dst[o] + g[o];
                        }
                    }
                }
                Op::PopShape => {
                    shapes.pop();
                }
            }
        }
        stack.pop().expect("the program leaves exactly the destination")
    }

    // ---------- compositing ----------

    // Composites one level-0 tile bottom-to-top into a premultiplied f32 buffer.
    // Pixels outside the document rect (in an edge tile) are left as 0 (transparent).
    pub(super) fn composite_tile_premul(&self, tx: u32, ty: u32) -> Vec<f32> {
        self.mode_map(0, Document::run_program(&self.program(0, tx, ty).expect("level 0 is valid")))
    }

    /// The level-`level` display tile as premultiplied RGBA8 under the default view (see
    /// `display_tile_view`), or None when it is fully transparent.
    #[cfg(test)]
    pub fn display_tile(&self, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        self.display_tile_view(&Default::default(), level, tx, ty)
    }

    /// The encoded draw program for one display tile (8-bit documents only). `known` lists
    /// payload keys the caller already has; their bytes are left out. See `Program` for the layout.
    pub fn display_program(&self, level: u32, tx: u32, ty: u32, known: &[u64]) -> Result<Vec<u8>, String> {
        if self.depth != 8 {
            return Err("draw programs need an 8-bit document".into());
        }
        use super::color_mode::ColorMode as M;
        if matches!(self.vector.mode, Some(M::Bitmap | M::Duotone { .. } | M::Indexed { .. })) {
            return Err("Bitmap, Duotone and Indexed Color display as CPU tiles".into());
        }
        if self.display_profile().is_some() {
            return Err("documents with a non-sRGB profile display as CPU tiles".into());
        }
        Ok(self.program(level, tx, ty)?.encode(known))
    }

    #[cfg(test)]
    pub(super) fn level_tile_bytes(&self, id: u32, mask: bool, level: u32, tx: u32, ty: u32) -> Option<Vec<u8>> {
        let node = self.node(id).unwrap();
        let t = if mask {
            let m = node.mask.as_ref().unwrap();
            self.level_tile(&m.tiles, Some(m.default), level, tx, ty)?
        } else {
            self.level_tile(node.pixel_tiles().unwrap(), None, level, tx, ty)?
        };
        Some(t.1.to_bytes())
    }
}

/// The stored tiles a node draws: pixels, a smart object's cache, or a text layer's cache (none
/// under a singular transform).
fn content_tiles(node: &Node) -> Option<&Tiles> {
    match &node.kind {
        Kind::Pixel(t) => Some(t),
        Kind::Smart(s) => Some(&s.cache),
        Kind::Text(t) => {
            let [a, b, c, d, ..] = t.data.transform;
            let det = a * d - b * c;
            (det != 0.0 && det.is_finite()).then_some(t.cache.as_ref()).flatten()
        }
        _ => None,
    }
}

/// Tight bounds [x, y, w, h] of the non-transparent pixels of `tiles`. The outer ring of tiles
/// goes first, so inner tiles that cannot widen the bounds are skipped without a scan.
pub(super) fn tiles_bounds(tiles: &Tiles) -> Option<[i32; 4]> {
    let coords = tiles.coords();
    let (tx0, tx1) = coords.iter().fold((i32::MAX, i32::MIN), |(a, b), c| (a.min(c.0), b.max(c.0)));
    let (ty0, ty1) = coords.iter().fold((i32::MAX, i32::MIN), |(a, b), c| (a.min(c.1), b.max(c.1)));
    let ring = |&(tx, ty): &(i32, i32)| tx == tx0 || tx == tx1 || ty == ty0 || ty == ty1;
    let t = TILE as i32;
    let mut bb: Option<(i32, i32, i32, i32)> = None;
    for &(tx, ty) in coords.iter().filter(|c| ring(c)).chain(coords.iter().filter(|c| !ring(c))) {
        let (ox, oy) = (tx * t, ty * t);
        if bb.is_some_and(|b| b.0 <= ox && b.1 <= oy && ox + t <= b.2 && oy + t <= b.3) {
            continue;
        }
        let Some((x0, y0, x1, y1)) = tiles.get(tx, ty).expect("a listed tile").px.alpha_rect() else { continue };
        let r = (ox + x0, oy + y0, ox + x1, oy + y1);
        bb = Some(bb.map_or(r, |b| (b.0.min(r.0), b.1.min(r.1), b.2.max(r.2), b.3.max(r.3))));
    }
    bb.map(|(x0, y0, x1, y1)| [x0, y0, x1 - x0, y1 - y0])
}

// Region index and tile index of every pixel tile (i, j) shares with the n x n square at (x0, y0).
fn overlap(x0: i64, y0: i64, n: usize, i: i64, j: i64) -> impl Iterator<Item = (usize, usize)> {
    let t = TILE as i64;
    let (xa, xb) = ((i * t).max(x0), ((i + 1) * t).min(x0 + n as i64));
    let (ya, yb) = ((j * t).max(y0), ((j + 1) * t).min(y0 + n as i64));
    (ya..yb).flat_map(move |gy| {
        (xa..xb).map(move |gx| (((gy - y0) * n as i64 + gx - x0) as usize, ((gy - j * t) * t + gx - i * t) as usize))
    })
}

pub(super) fn mix_bytes(key: u64, bytes: &[u8]) -> u64 {
    bytes.chunks(8).fold(mix(key, bytes.len() as u64), |k, c| {
        let mut w = [0u8; 8];
        w[..c.len()].copy_from_slice(c);
        mix(k, u64::from_le_bytes(w))
    })
}

pub(super) fn quantize_premul(out: &[f32]) -> Option<Vec<u8>> {
    let mut bytes = vec![0u8; TILE_BYTES_U8];
    let mut any_alpha = false;
    for p in 0..TILE_PIXELS {
        let o = p * 4;
        for c in 0..4 {
            bytes[o + c] = (out[o + c] * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        if bytes[o + 3] != 0 {
            any_alpha = true;
        }
    }
    if !any_alpha {
        return None;
    }
    Some(bytes)
}
