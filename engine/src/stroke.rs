//! Stroke geometry and accumulation (B5 spec v2 Part E1): tip rasterization, dab spacing along
//! the input path, dynamics/scattering/color math and the per-stroke coverage buffer. Pure math
//! over flat buffers, no Document.

use std::sync::Arc;

use crate::blend::Blend;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TipKind {
    Round,
    Square,
    Sampled,
}

impl TipKind {
    pub fn parse(s: &str) -> Result<TipKind, String> {
        match s {
            "round" => Ok(TipKind::Round),
            "square" => Ok(TipKind::Square),
            "sampled" => Ok(TipKind::Sampled),
            other => Err(format!("unknown tip shape {other}")),
        }
    }
}

/// A registered sampled tip (E1.11): 8-bit coverage, row-major, `alpha.len() == w * h`.
pub struct SampledTip {
    pub w: u32,
    pub h: u32,
    pub alpha: Vec<u8>,
}

impl std::fmt::Debug for SampledTip {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SampledTip {{ w: {}, h: {} }}", self.w, self.h)
    }
}

impl SampledTip {
    fn texel(&self, x: i32, y: i32) -> f32 {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            0.0
        } else {
            self.alpha[(y as u32 * self.w + x as u32) as usize] as f32 / 255.0
        }
    }

    /// Bilinear sample at tip-pixel coordinates; outside the tip is 0 (E1.11).
    fn sample(&self, x: f32, y: f32) -> f32 {
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let (x0, y0) = (x0 as i32, y0 as i32);
        let top = self.texel(x0, y0) + (self.texel(x0 + 1, y0) - self.texel(x0, y0)) * fx;
        let bot = self.texel(x0, y0 + 1) + (self.texel(x0 + 1, y0 + 1) - self.texel(x0, y0 + 1)) * fx;
        top + (bot - top) * fy
    }
}

#[derive(Clone)]
pub enum TipShape {
    Round,
    Square,
    Sampled(Arc<SampledTip>),
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// One dab's tip: `radius` in document pixels (half the diameter), `hardness`, `roundness`,
/// static `flip_x`/`flip_y` and `angle_deg` rotating the tip counter-clockwise.
#[derive(Clone)]
pub struct Tip {
    radius: f32,
    hardness: f32,
    roundness: f32,
    aliased: bool,
    shape: TipShape,
    flip_x: bool,
    flip_y: bool,
    // sin, cos of the tip angle, so `cov` has no trigonometry per pixel.
    rot: (f32, f32),
}

impl Tip {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        radius: f32,
        hardness: f32,
        angle_deg: f32,
        roundness: f32,
        aliased: bool,
        shape: TipShape,
        flip_x: bool,
        flip_y: bool,
    ) -> Tip {
        let a = angle_deg.to_radians();
        Tip {
            radius,
            hardness: hardness.clamp(0.0, 1.0),
            roundness: roundness.clamp(0.01, 1.0),
            aliased,
            shape,
            flip_x,
            flip_y,
            rot: (a.sin(), a.cos()),
        }
    }

    /// Coverage in 0..1 of the pixel center at (dx, dy) relative to the dab center.
    pub fn cov(&self, dx: f32, dy: f32) -> f32 {
        if self.radius <= 0.0 {
            return 0.0;
        }
        let (sa, ca) = self.rot;
        let mut x = dx * ca + dy * sa;
        let mut y = -dx * sa + dy * ca;
        if self.flip_x {
            x = -x;
        }
        if self.flip_y {
            y = -y;
        }
        if let TipShape::Sampled(tip) = &self.shape {
            // The larger tip side maps to the diameter; roundness scales the height (E1.11).
            let scale = (2.0 * self.radius / tip.w.max(tip.h).max(1) as f32).max(1e-6);
            let sx = x / scale + (tip.w as f32 - 1.0) / 2.0;
            let sy = y / (scale * self.roundness) + (tip.h as f32 - 1.0) / 2.0;
            return tip.sample(sx, sy);
        }
        let y = y / self.roundness;
        let d = match self.shape {
            TipShape::Round => (x * x + y * y).sqrt(),
            TipShape::Square => x.abs().max(y.abs()),
            TipShape::Sampled(_) => unreachable!("handled above"),
        };
        let r = d / self.radius;
        if self.aliased {
            return if r <= 1.0 { 1.0 } else { 0.0 };
        }
        // Soft round/square falloff (E1.1): `core`/`spread` shape a Gaussian-like skirt from the
        // reference app's real brush look; `h == 1` is instead a plain anti-aliased hard step.
        let h = self.hardness;
        let aa = 1.0 / self.radius;
        if h < 1.0 {
            let core = h * (1.64 - 0.66 * h);
            let spread = ((1.0 - h) / (1.52 * (1.0 + 0.42 * h))).max(aa / 3.5);
            let c = (r - core).max(0.0) / spread;
            if c >= 3.5 {
                0.0
            } else {
                (-c * c).exp()
            }
        } else {
            1.0 - smoothstep(1.0 - 0.5 * aa, 1.0 + 0.5 * aa, r)
        }
    }
}

/// `Tip::cov` for a plain round tip, the form used by most tests.
#[allow(clippy::too_many_arguments, dead_code)]
pub fn dab_coverage(dx: f32, dy: f32, radius: f32, hardness: f32, angle_deg: f32, roundness: f32, aliased: bool) -> f32 {
    Tip::new(radius, hardness, angle_deg, roundness, aliased, TipShape::Round, false, false).cov(dx, dy)
}

/// Deterministic per-stroke PRNG (xorshift32), seeded from the stroke's `seed` param. Never seeded
/// from time or an address; the same seed always yields the same draw sequence.
pub struct Prng(u32);

impl Prng {
    pub fn new(seed: u32) -> Prng {
        // xorshift32 has a fixed point at 0: mix the seed so `seed == 0` still cycles.
        Prng((seed ^ 0x9E37_79B9) | 1)
    }

    /// Next draw in 0..1.
    pub fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f64 / u32::MAX as f64) as f32
    }
}

/// Integer spatial hash of a document pixel and the stroke seed, in 0..1 (E1.9, E2 scatter). Same
/// inputs always give the same output; no PRNG state involved.
pub fn hash01(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x27d4_eb2f) ^ (y as u32).wrapping_mul(0x1656_67b1) ^ seed.wrapping_mul(0x9e37_79b9);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297a_2d39);
    h ^= h >> 15;
    (h as f64 / u32::MAX as f64) as f32
}

/// A dynamics control source (E1.3): the 0..1 "control value" driving a `Dyn` parameter or an
/// angle dynamic.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Source {
    #[default]
    Off,
    Fade,
    PenPressure,
    PenTilt,
    StylusWheel,
    Rotation,
    InitialDirection,
    Direction,
}

impl Source {
    pub fn parse(s: &str) -> Result<Source, String> {
        match s {
            "off" => Ok(Source::Off),
            "fade" => Ok(Source::Fade),
            "penPressure" => Ok(Source::PenPressure),
            "penTilt" => Ok(Source::PenTilt),
            "stylusWheel" => Ok(Source::StylusWheel),
            "rotation" => Ok(Source::Rotation),
            "initialDirection" => Ok(Source::InitialDirection),
            "direction" => Ok(Source::Direction),
            other => Err(format!("unknown control source {other}")),
        }
    }
}

/// Per-dab context every control source and angle dynamic reads from (E1.3, E1.4).
#[derive(Clone, Copy, Default)]
pub struct DabCtx {
    pub pressure: f32,
    pub tilt_x: f32,
    pub tilt_y: f32,
    pub twist: f32,
    pub dab_index: u32,
    pub initial_dir: f32,
    pub dir: f32,
}

fn wrap360(a: f32) -> f32 {
    a.rem_euclid(360.0)
}

/// The 0..1 control value for `src` (E1.3).
pub fn control_value(src: Source, ctx: &DabCtx, fade_steps: u32) -> f32 {
    match src {
        Source::Off => 1.0,
        Source::Fade => (1.0 - ctx.dab_index as f32 / fade_steps.max(1) as f32).clamp(0.0, 1.0),
        Source::PenPressure => ctx.pressure,
        Source::PenTilt => (ctx.tilt_x.hypot(ctx.tilt_y).min(90.0) / 90.0).clamp(0.0, 1.0),
        Source::StylusWheel | Source::Rotation => wrap360(ctx.twist) / 360.0,
        Source::InitialDirection => wrap360(ctx.initial_dir) / 360.0,
        Source::Direction => wrap360(ctx.dir) / 360.0,
    }
}

/// A dynamic parameter `{control, fadeSteps, jitter, minimum}` (E1.3). With the default (`Off`,
/// jitter 0) `eval` always returns exactly 1.0, so multiplying a base value by it is a B4 no-op.
#[derive(Clone, Copy, Debug, Default)]
pub struct Dyn {
    pub control: Source,
    pub fade_steps: u32,
    pub jitter: f32,
    pub minimum: f32,
}

impl Dyn {
    /// `s = control value, *= 1 - jitter * u when jitter > 0` (u the next PRNG draw, only drawn
    /// when needed so the draw order never depends on unused params); `value = minimum + (1 -
    /// minimum) * clamp01(s)`.
    pub fn eval(&self, ctx: &DabCtx, prng: &mut Prng) -> f32 {
        let mut s = control_value(self.control, ctx, self.fade_steps);
        if self.jitter > 0.0 {
            s *= 1.0 - self.jitter * prng.next();
        }
        self.minimum + (1.0 - self.minimum) * s.clamp(0.0, 1.0)
    }
}

/// The angle dynamic's control add, in degrees (E1.4): direction-family sources add a raw angle
/// instead of the generic 0..1 factor; other sources (off, pressure, tilt-magnitude, wheel) do not
/// drive the angle and add 0.
pub fn angle_control_add(src: Source, follows_path: bool, ctx: &DabCtx, fade_steps: u32) -> f32 {
    if follows_path || src == Source::Direction {
        return ctx.dir;
    }
    match src {
        Source::InitialDirection => ctx.initial_dir,
        Source::Rotation => ctx.twist,
        Source::PenTilt => ctx.tilt_y.atan2(ctx.tilt_x).to_degrees(),
        Source::Fade => 360.0 * (ctx.dab_index as f32 / fade_steps.max(1) as f32).clamp(0.0, 1.0),
        _ => 0.0,
    }
}

/// The brush-projection multiplier (E1.4): a tilted pen flattens the roundness.
pub fn brush_projection(ctx: &DabCtx) -> f32 {
    let tilt_magnitude = (ctx.tilt_x.hypot(ctx.tilt_y).min(90.0) / 90.0).clamp(0.0, 1.0);
    (tilt_magnitude * 90f32.to_radians()).cos().max(0.01)
}

/// One input sample or placed dab: document position, pressure and tilt/twist in 0..1-normalized
/// units (pressure) or degrees (tilt, twist); `dir` is the current segment's angle in degrees,
/// computed by `Spacer`, not supplied by the caller.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub p: f32,
    pub tilt_x: f32,
    pub tilt_y: f32,
    pub twist: f32,
    pub dir: f32,
}

#[cfg(test)]
impl Sample {
    pub fn new(x: f64, y: f64, p: f32) -> Sample {
        Sample { x, y, p, tilt_x: 0.0, tilt_y: 0.0, twist: 0.0, dir: 0.0 }
    }
}

/// Places dabs every `step` px along the polyline of samples, carrying the leftover distance
/// across calls. The first sample of a stroke always gets a dab. Tracks the first non-zero
/// segment's direction for the `initialDirection` control source.
#[derive(Default)]
pub struct Spacer {
    last: Option<Sample>,
    carry: f64,
    last_dir: f32,
    first_dir: Option<f32>,
}

impl Spacer {
    pub fn initial_dir(&self) -> f32 {
        self.first_dir.unwrap_or(0.0)
    }

    /// The dabs for one batch of samples. A zero-length move places a dab only with `airbrush`
    /// on (the UI repeats it on a timer while the pointer stands still).
    pub fn feed(&mut self, samples: &[Sample], step: f64, airbrush: bool) -> Vec<Sample> {
        let step = step.max(1.0);
        let mut out = Vec::new();
        for s in samples {
            let Some(last) = self.last else {
                self.last = Some(*s);
                self.carry = 0.0;
                out.push(*s);
                continue;
            };
            let (dx, dy) = (s.x - last.x, s.y - last.y);
            let len = (dx * dx + dy * dy).sqrt();
            if len <= 0.0 {
                if airbrush {
                    out.push(Sample { dir: self.last_dir, ..*s });
                }
                self.last = Some(*s);
                continue;
            }
            self.last_dir = (dy.atan2(dx) as f32).to_degrees();
            if self.first_dir.is_none() {
                self.first_dir = Some(self.last_dir);
            }
            let mut trav = 0.0f64;
            while trav + (step - self.carry) <= len {
                trav += step - self.carry;
                self.carry = 0.0;
                let t = trav / len;
                out.push(Sample {
                    x: last.x + dx * t,
                    y: last.y + dy * t,
                    p: last.p + (s.p - last.p) * t as f32,
                    tilt_x: last.tilt_x + (s.tilt_x - last.tilt_x) * t as f32,
                    tilt_y: last.tilt_y + (s.tilt_y - last.tilt_y) * t as f32,
                    twist: last.twist + (s.twist - last.twist) * t as f32,
                    dir: self.last_dir,
                });
            }
            self.carry += len - trav;
            self.last = Some(*s);
        }
        out
    }
}

/// E1.10 brush pose: overrides replace the sample's pressure/tilt/twist before any dynamics read
/// them (this must run before `place_dabs`, not inside it, so the legacy pressure-size/opacity
/// toggles see the overridden pressure too).
#[derive(Clone, Copy, Default)]
pub struct PoseOverride {
    pub tilt_x: Option<f32>,
    pub tilt_y: Option<f32>,
    pub rotation: Option<f32>,
    pub pressure: Option<f32>,
}

pub fn apply_pose(s: &Sample, pose: &PoseOverride) -> Sample {
    Sample {
        p: pose.pressure.unwrap_or(s.p),
        tilt_x: pose.tilt_x.unwrap_or(s.tilt_x),
        tilt_y: pose.tilt_y.unwrap_or(s.tilt_y),
        twist: pose.rotation.unwrap_or(s.twist),
        ..*s
    }
}

/// E1.4 shape dynamics.
#[derive(Clone, Default)]
pub struct ShapeDynamics {
    pub enabled: bool,
    pub size: Dyn,
    pub roundness: Dyn,
    pub flip_x_jitter: bool,
    pub flip_y_jitter: bool,
    pub brush_projection: bool,
    pub angle_follows_path: bool,
    pub angle_control: Source,
    pub angle_fade_steps: u32,
    pub angle_jitter: f32,
}

/// E1.5 scattering.
#[derive(Clone, Default)]
pub struct ScatterDynamics {
    pub enabled: bool,
    pub count: u32,
    pub count_dyn: Dyn,
    pub amount: f32,
    pub scatter_dyn: Dyn,
    pub both_axes: bool,
}

/// E1.6 transfer.
#[derive(Clone, Default)]
pub struct TransferDynamics {
    pub enabled: bool,
    pub opacity_dyn: Dyn,
    pub flow_dyn: Dyn,
}

/// E1.7 color dynamics.
#[derive(Clone, Default)]
pub struct ColorDynamics {
    pub enabled: bool,
    pub bg: [f32; 3],
    pub fg_bg: f32,
    pub hue_jitter: f32,
    pub sat_jitter: f32,
    pub bri_jitter: f32,
    pub purity: f32,
    pub per_tip: bool,
}

/// E2.3 texture depth jitter: the sampling-side params (pattern, invert, scale, mode, ...) live in
/// `doc::Stroke`, which alone knows about the pattern registry; only the per-dab depth roll needs
/// the stroke PRNG, so only that lives here.
#[derive(Clone, Default)]
pub struct TextureDynamics {
    pub enabled: bool,
    pub depth: f32,
    pub minimum_depth: f32,
    pub depth_jitter: Dyn,
}

/// E2.4 dual brush: a secondary tip stamped in a grid over the primary dab and blended in.
#[derive(Clone)]
pub struct DualBrush {
    pub enabled: bool,
    pub shape: TipShape,
    pub hardness: f32,
    pub roundness: f32,
    pub angle: f32,
    pub flip_x: bool,
    pub flip_y: bool,
    pub mode: Blend,
    pub size: f32,
    pub spacing: f32,
    pub scatter: f32,
    pub both_axes: bool,
    pub count: u32,
}

impl Default for DualBrush {
    fn default() -> DualBrush {
        DualBrush {
            enabled: false,
            shape: TipShape::Round,
            hardness: 1.0,
            roundness: 1.0,
            angle: 0.0,
            flip_x: false,
            flip_y: false,
            mode: Blend::Multiply,
            size: 1.0,
            spacing: 0.25,
            scatter: 0.0,
            both_axes: false,
            count: 1,
        }
    }
}

/// The two constants xoring the stroke seed for the dual brush's grid-point jitter hash (E2.4):
/// distinct odd constants so a grid point's x and y offsets never share a draw with each other or
/// with the per-pixel noise hash (`hash01` unmixed).
const DUAL_SEED_X: u32 = 0xD1B5_4A35;
const DUAL_SEED_Y: u32 = 0xA24B_AED4;

/// Stamps the dual brush's secondary tip in a grid over `rect` (a primary dab's pixel box, in
/// document coordinates) and returns its `(x1 - x0) * (y1 - y0)` coverage buffer, row-major,
/// combined with max compositing (E2.4). Grid points a spacing step outside `rect` still
/// contribute, so a tip stamp centered just off the edge can cover pixels inside it.
pub fn dual_brush_mask(dual: &DualBrush, rect: (i32, i32, i32, i32), dab_index: u32, seed: u32) -> Vec<f32> {
    let (x0, y0, x1, y1) = rect;
    let (w, h) = ((x1 - x0).max(0) as usize, (y1 - y0).max(0) as usize);
    let mut buf = vec![0f32; w * h];
    if w == 0 || h == 0 {
        return buf;
    }
    let step = (dual.size * dual.spacing).max(1.0);
    let scatter_px = dual.scatter * dual.size.max(1.0);
    let tip = Tip::new(dual.size / 2.0, dual.hardness, dual.angle, dual.roundness, false, dual.shape.clone(), dual.flip_x, dual.flip_y);
    let rf = dual.size / 2.0 + 1.0;
    let gx0 = ((x0 as f32 - step) / step).floor() as i32;
    let gx1 = ((x1 as f32 + step) / step).ceil() as i32;
    let gy0 = ((y0 as f32 - step) / step).floor() as i32;
    let gy1 = ((y1 as f32 + step) / step).ceil() as i32;
    for gy in gy0..=gy1 {
        for gx in gx0..=gx1 {
            let (cx, cy) = (gx as f32 * step, gy as f32 * step);
            for i in 0..dual.count {
                let dx = (2.0 * hash01(i as i32, dab_index as i32, seed ^ DUAL_SEED_X) - 1.0) * scatter_px;
                let dy = if dual.both_axes { (2.0 * hash01(dab_index as i32, i as i32, seed ^ DUAL_SEED_Y) - 1.0) * scatter_px } else { 0.0 };
                let (px, py) = (cx + dx, cy + dy);
                let lx0 = ((px - rf).floor() as i32).max(x0);
                let ly0 = ((py - rf).floor() as i32).max(y0);
                let lx1 = ((px + rf).ceil() as i32 + 1).min(x1);
                let ly1 = ((py + rf).ceil() as i32 + 1).min(y1);
                for iy in ly0..ly1 {
                    let ddy = iy as f32 + 0.5 - py;
                    for ix in lx0..lx1 {
                        let ddx = ix as f32 + 0.5 - px;
                        let c = tip.cov(ddx, ddy);
                        if c <= 0.0 {
                            continue;
                        }
                        let idx = ((iy - y0) as usize) * w + (ix - x0) as usize;
                        if c > buf[idx] {
                            buf[idx] = c;
                        }
                    }
                }
            }
        }
    }
    buf
}

#[derive(Clone, Default)]
pub struct Dynamics {
    pub shape: ShapeDynamics,
    pub scatter: ScatterDynamics,
    pub transfer: TransferDynamics,
    pub color: ColorDynamics,
    pub texture: TextureDynamics,
}

/// One placed dab, after dynamics and scattering (a stroke_apply "anchor" placed by `Spacer`
/// expands into one or more of these via `place_dabs`).
#[derive(Clone)]
pub struct PlacedDab {
    pub x: f64,
    pub y: f64,
    pub radius: f32,
    pub angle: f32,
    pub roundness: f32,
    pub flip_x: bool,
    pub flip_y: bool,
    pub pressure: f32,
    pub cap_mul: f32,
    pub flow_mul: f32,
    pub rgb: Option<[f32; 3]>,
    pub tex_depth: f32,
    pub dab_index: u32,
    /// Segment direction in degrees at the anchor this dab came from.
    pub dir: f32,
}

fn rgb_to_hsb(rgb: [f32; 3]) -> (f32, f32, f32) {
    let (r, g, b) = (rgb[0], rgb[1], rgb[2]);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let bri = max;
    let sat = if max <= 0.0 { 0.0 } else { delta / max };
    let hue = if delta <= 0.0 {
        0.0
    } else if max == r {
        ((g - b) / delta) / 6.0
    } else if max == g {
        ((b - r) / delta + 2.0) / 6.0
    } else {
        ((r - g) / delta + 4.0) / 6.0
    };
    (hue.rem_euclid(1.0), sat.clamp(0.0, 1.0), bri.clamp(0.0, 1.0))
}

fn hsb_to_rgb(h: f32, s: f32, v: f32) -> [f32; 3] {
    let h = h.rem_euclid(1.0) * 6.0;
    let i = h.floor();
    let f = h - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    match i as i32 % 6 {
        0 => [v, t, p],
        1 => [q, v, p],
        2 => [p, v, t],
        3 => [p, q, v],
        4 => [t, p, v],
        _ => [v, p, q],
    }
}

/// E1.7: four PRNG draws (r, s, i, a) resolve one dab color, always drawn (unconditional on the
/// jitter amounts, per the "four draws" wording) so the sequence never depends on which jitters
/// are nonzero.
fn roll_color(c: &ColorDynamics, fg: [f32; 3], prng: &mut Prng) -> [f32; 3] {
    let (r, s, i, a) = (prng.next(), prng.next(), prng.next(), prng.next());
    let base = [
        fg[0] + (c.bg[0] - fg[0]) * r * c.fg_bg,
        fg[1] + (c.bg[1] - fg[1]) * r * c.fg_bg,
        fg[2] + (c.bg[2] - fg[2]) * r * c.fg_bg,
    ];
    let (mut h, mut sat, mut bri) = rgb_to_hsb(base);
    h = (h + (2.0 * s - 1.0) * c.hue_jitter).rem_euclid(1.0);
    sat = (sat * (1.0 - c.sat_jitter * i)).clamp(0.0, 1.0);
    bri = (bri * (1.0 - c.bri_jitter * a)).clamp(0.0, 1.0);
    if c.purity > 0.0 {
        sat = (sat + (1.0 - sat) * c.purity).clamp(0.0, 1.0);
    } else if c.purity < 0.0 {
        sat = (sat * (1.0 + c.purity)).clamp(0.0, 1.0);
    }
    let rgb = hsb_to_rgb(h, sat, bri);
    [rgb[0].clamp(0.0, 1.0), rgb[1].clamp(0.0, 1.0), rgb[2].clamp(0.0, 1.0)]
}

/// Expands one spaced anchor into its placed dabs (E1.4-E1.7, E2.3): scattering's `count`/magnitude
/// are rolled once per anchor, then every sub-dab (in order) rolls scatter offset, shape (size,
/// roundness, flips, angle), transfer (opacity, flow), color and finally the E2.3 texture depth
/// jitter (appended after the E1 draws, so all-texture-off strokes keep the E1 draw order exactly)
/// -- this order, applied to every sub-dab of every anchor in path order, is the one fixed PRNG
/// draw order for the whole stroke. `anchor` must already have pose overrides applied
/// (`apply_pose`) and `base_diameter` must already include the legacy pressure-size toggle;
/// `dab_index` and `prng` carry state across anchors for the whole stroke.
#[allow(clippy::too_many_arguments)]
pub fn place_dabs(
    anchor: &Sample,
    initial_dir: f32,
    base_diameter: f32,
    base_angle: f32,
    base_roundness: f32,
    base_flip_x: bool,
    base_flip_y: bool,
    dyn_: &Dynamics,
    fg: [f32; 3],
    prng: &mut Prng,
    dab_index: &mut u32,
) -> Vec<PlacedDab> {
    let ctx0 = DabCtx {
        pressure: anchor.p,
        tilt_x: anchor.tilt_x,
        tilt_y: anchor.tilt_y,
        twist: anchor.twist,
        dab_index: *dab_index,
        initial_dir,
        dir: anchor.dir,
    };
    let count = if dyn_.scatter.enabled {
        let f = dyn_.scatter.count_dyn.eval(&ctx0, prng);
        (dyn_.scatter.count as f32 * f).round().max(1.0) as u32
    } else {
        1
    };
    let g = if dyn_.scatter.enabled {
        base_diameter * dyn_.scatter.amount * dyn_.scatter.scatter_dyn.eval(&ctx0, prng)
    } else {
        0.0
    };
    let dir_rad = anchor.dir.to_radians();
    let (perp_x, perp_y) = (-dir_rad.sin(), dir_rad.cos());
    let (along_x, along_y) = (dir_rad.cos(), dir_rad.sin());
    let color_once =
        if dyn_.color.enabled && !dyn_.color.per_tip { Some(roll_color(&dyn_.color, fg, prng)) } else { None };

    let mut out = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let ctx =
            DabCtx { dab_index: *dab_index, ..ctx0 };
        let (ox, oy) = if dyn_.scatter.enabled {
            let u = 2.0 * prng.next() - 1.0;
            let v = if dyn_.scatter.both_axes { 2.0 * prng.next() - 1.0 } else { 0.0 };
            (perp_x * u * g + along_x * v * g, perp_y * u * g + along_y * v * g)
        } else {
            (0.0, 0.0)
        };

        let (radius, roundness, flip_x, flip_y, angle) = if dyn_.shape.enabled {
            let diameter = (base_diameter * dyn_.shape.size.eval(&ctx, prng)).max(1.0);
            let mut roundness = base_roundness;
            if dyn_.shape.roundness.control != Source::Off || dyn_.shape.roundness.jitter > 0.0 {
                roundness *= dyn_.shape.roundness.eval(&ctx, prng);
            }
            if dyn_.shape.brush_projection {
                roundness *= brush_projection(&ctx);
            }
            roundness = roundness.clamp(0.01, 1.0);
            let flip_x = base_flip_x ^ (dyn_.shape.flip_x_jitter && prng.next() < 0.5);
            let flip_y = base_flip_y ^ (dyn_.shape.flip_y_jitter && prng.next() < 0.5);
            let mut angle = base_angle
                + angle_control_add(dyn_.shape.angle_control, dyn_.shape.angle_follows_path, &ctx, dyn_.shape.angle_fade_steps);
            if dyn_.shape.angle_jitter > 0.0 {
                angle += dyn_.shape.angle_jitter * 360.0 * (prng.next() - 0.5);
            }
            (diameter / 2.0, roundness, flip_x, flip_y, angle)
        } else {
            (base_diameter / 2.0, base_roundness, base_flip_x, base_flip_y, base_angle)
        };

        let (cap_mul, flow_mul) = if dyn_.transfer.enabled {
            (dyn_.transfer.opacity_dyn.eval(&ctx, prng), dyn_.transfer.flow_dyn.eval(&ctx, prng))
        } else {
            (1.0, 1.0)
        };

        let rgb = if dyn_.color.enabled { Some(color_once.unwrap_or_else(|| roll_color(&dyn_.color, fg, prng))) } else { None };

        // E2.3, drawn last so an all-off stroke's PRNG sequence is exactly the E1 one.
        let tex_depth = if dyn_.texture.enabled {
            (dyn_.texture.depth * dyn_.texture.depth_jitter.eval(&ctx, prng)).max(dyn_.texture.minimum_depth)
        } else {
            1.0
        };

        out.push(PlacedDab {
            x: anchor.x + ox as f64,
            y: anchor.y + oy as f64,
            radius,
            angle,
            roundness,
            flip_x,
            flip_y,
            pressure: anchor.p,
            cap_mul,
            flow_mul,
            rgb,
            tex_depth,
            dab_index: ctx.dab_index,
            dir: anchor.dir,
        });
        *dab_index += 1;
    }
    out
}

/// One dab's contribution to the stroke buffer: `cap` = opacity (times pressure/dynamics), `flow`
/// the per-dab paint, `cov` the tip coverage of this pixel. The buffer approaches `cap` but never
/// exceeds it, so a stroke never darkens past its opacity. Wet edges are a look remapped at flush
/// (E1.8), not a different accumulation rule.
#[inline(always)]
pub fn accumulate(s: f32, cap: f32, flow: f32, cov: f32) -> f32 {
    let f = flow * cov;
    if s < cap {
        s + (cap - s) * f
    } else {
        s
    }
}

/// The E1.8 wet-edge look remap, applied once at flush: `m = s / cap` (coverage as a fraction of
/// the stroke's cap), `m' = clamp01(0.45 m + 2.2 m (1 - m))`, result `m' * cap`.
pub fn wet_edge_remap(s: f32, cap: f32) -> f32 {
    if cap <= 0.0 {
        return s;
    }
    let m = (s / cap).clamp(0.0, 1.0);
    let m2 = (0.45 * m + 2.2 * m * (1.0 - m)).clamp(0.0, 1.0);
    m2 * cap
}

/// The E1.9 per-pixel noise remap: only pulls coverage strictly between 0 and 1 towards the hash.
pub fn noise_remap(u: f32, amount: f32, x: i32, y: i32, seed: u32) -> f32 {
    if u <= 0.0 || u >= 1.0 || amount <= 0.0 {
        return u;
    }
    (u + amount * (2.0 * hash01(x, y, seed) - 1.0) * 4.0 * u * (1.0 - u)).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-4, "{a} != {b}");
    }

    fn close_msg(a: f32, b: f32, msg: &str) {
        assert!((a - b).abs() < 1e-4, "{a} != {b}: {msg}");
    }

    fn s(x: f64, y: f64, p: f32) -> Sample {
        Sample::new(x, y, p)
    }

    #[test]
    fn soft_dab_core_and_spread_shape_the_skirt() {
        // hardness 0: core = 0, spread = 1/1.52; coverage is a pure Gaussian skirt of r.
        let c = |dx: f32| dab_coverage(dx, 0.0, 10.0, 0.0, 0.0, 1.0, false);
        assert_eq!(c(0.0), 1.0);
        let spread = 1.0f32 / 1.52;
        close(c(spread * 10.0), (-1.0f32).exp());
        let mut prev = 1.0;
        for i in 0..=200 {
            let v = c(i as f32 / 10.0);
            assert!(v <= prev, "coverage grew at {i}");
            prev = v;
        }
        assert_eq!(c(1000.0), 0.0, "far beyond the cutoff c >= 3.5");
    }

    #[test]
    fn hard_dab_has_an_antialiased_band_around_the_edge() {
        // hardness 100 %, radius 2: aa = 0.5, so the AA band is [0.75, 1.25] of the radius.
        let c = |dx: f32, dy: f32| dab_coverage(dx, dy, 2.0, 1.0, 0.0, 1.0, false);
        assert_eq!(c(0.0, 0.0), 1.0);
        assert_eq!(c(1.0, 0.0), 1.0, "r = 0.5, inside the band's lower edge");
        assert_eq!(c(1.5, 0.0), 1.0, "r = 0.75, exactly the band's lower edge");
        close_msg(c(2.0, 0.0), 0.5, "r = 1.0, the band's midpoint");
        assert_eq!(c(2.5, 0.0), 0.0, "r = 1.25, exactly the band's upper edge");
        assert_eq!(c(3.0, 0.0), 0.0);
    }

    #[test]
    fn aliased_dab_is_binary_and_round() {
        let c = |dx: f32, dy: f32| dab_coverage(dx, dy, 3.0, 0.0, 0.0, 1.0, true);
        assert_eq!(c(0.0, 0.0), 1.0);
        assert_eq!(c(3.0, 0.0), 1.0);
        assert_eq!(c(0.0, 3.0), 1.0);
        assert_eq!(c(2.2, 2.2), 0.0);
        assert_eq!(c(3.1, 0.0), 0.0);
    }

    #[test]
    fn roundness_and_angle_shape_the_ellipse() {
        // roundness 50 % halves the minor (y) axis; the 90 degree angle swaps the two axes.
        let flat = Tip::new(4.0, 0.0, 0.0, 0.5, true, TipShape::Round, false, false);
        assert_eq!(flat.cov(4.0, 0.0), 1.0);
        assert_eq!(flat.cov(0.0, 2.0), 1.0);
        assert_eq!(flat.cov(0.0, 2.5), 0.0);
        let turned = Tip::new(4.0, 0.0, 90.0, 0.5, true, TipShape::Round, false, false);
        assert_eq!(turned.cov(0.0, 4.0), 1.0);
        assert_eq!(turned.cov(2.5, 0.0), 0.0);
    }

    #[test]
    fn square_tip_covers_the_corners() {
        let t = Tip::new(8.0, 0.0, 0.0, 1.0, true, TipShape::Square, false, false);
        assert_eq!(t.cov(8.0, 8.0), 1.0);
        assert_eq!(t.cov(8.1, 0.0), 0.0);
        assert_eq!(Tip::new(8.0, 0.0, 0.0, 1.0, true, TipShape::Round, false, false).cov(8.0, 8.0), 0.0);
    }

    #[test]
    fn sampled_tip_reproduces_its_bytes_at_exact_pixels() {
        // A 3x3 tip at diameter 3 (radius 1.5): scale = 3/3 = 1, so document offsets -1, 0, 1
        // land exactly on the tip's pixel grid.
        let tip = Arc::new(SampledTip { w: 3, h: 3, alpha: vec![0, 64, 0, 128, 255, 128, 0, 64, 0] });
        let t = Tip::new(1.5, 1.0, 0.0, 1.0, false, TipShape::Sampled(tip.clone()), false, false);
        close(t.cov(0.0, -1.0), 64.0 / 255.0);
        close(t.cov(0.0, 0.0), 255.0 / 255.0);
        close(t.cov(-1.0, 0.0), 128.0 / 255.0);
        close(t.cov(1.0, 0.0), 128.0 / 255.0);
        close(t.cov(0.0, 1.0), 64.0 / 255.0);
        close_msg(t.cov(5.0, 5.0), 0.0, "outside the tip is 0");
    }

    #[test]
    fn flips_mirror_an_asymmetric_sampled_tip() {
        let tip = Arc::new(SampledTip { w: 3, h: 1, alpha: vec![0, 128, 255] });
        let plain = Tip::new(1.5, 1.0, 0.0, 1.0, false, TipShape::Sampled(tip.clone()), false, false);
        let flipped = Tip::new(1.5, 1.0, 0.0, 1.0, false, TipShape::Sampled(tip), true, false);
        close(plain.cov(-1.0, 0.0), 0.0);
        close(plain.cov(1.0, 0.0), 1.0);
        close(flipped.cov(-1.0, 0.0), 1.0);
        close(flipped.cov(1.0, 0.0), 0.0);
    }

    #[test]
    fn spacing_places_the_expected_dab_count() {
        // Diameter 10 at 25 % spacing is a dab every 2.5 px: one at the start plus 40 along a
        // 100 px line.
        let mut sp = Spacer::default();
        let dabs = sp.feed(&[s(0.0, 0.0, 1.0), s(100.0, 0.0, 1.0)], 2.5, false);
        assert_eq!(dabs.len(), 41);
        assert_eq!(dabs[0].x, 0.0);
        assert_eq!(dabs[1].x, 2.5);
        assert_eq!(dabs[40].x, 100.0);
    }

    #[test]
    fn spacing_carries_the_remainder_across_calls() {
        let mut sp = Spacer::default();
        assert_eq!(sp.feed(&[s(0.0, 0.0, 1.0)], 4.0, false).len(), 1);
        // 3 px is short of the step, 3 more crosses it once.
        assert_eq!(sp.feed(&[s(3.0, 0.0, 1.0)], 4.0, false).len(), 0);
        let d = sp.feed(&[s(6.0, 0.0, 1.0)], 4.0, false);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].x, 4.0);
    }

    #[test]
    fn dab_pressure_is_interpolated_between_samples() {
        let mut sp = Spacer::default();
        let d = sp.feed(&[s(0.0, 0.0, 0.0), s(10.0, 0.0, 1.0)], 5.0, false);
        assert_eq!(d.len(), 3);
        close(d[1].p, 0.5);
        close(d[2].p, 1.0);
    }

    #[test]
    fn zero_length_move_only_paints_with_airbrush() {
        let mut sp = Spacer::default();
        sp.feed(&[s(5.0, 5.0, 1.0)], 4.0, false);
        assert!(sp.feed(&[s(5.0, 5.0, 1.0)], 4.0, false).is_empty());
        assert_eq!(sp.feed(&[s(5.0, 5.0, 1.0)], 4.0, true).len(), 1);
    }

    #[test]
    fn direction_and_initial_direction_come_from_the_segments() {
        let mut sp = Spacer::default();
        let d = sp.feed(&[s(0.0, 0.0, 1.0), s(10.0, 0.0, 1.0), s(10.0, 10.0, 1.0)], 5.0, false);
        assert_eq!(sp.initial_dir(), 0.0, "the first segment moves along +x");
        assert_eq!(d.len(), 5, "0, 5, 10 along the first segment then 5, 10 along the second");
        assert_eq!(d[0].dir, 0.0);
        assert_eq!(d[2].dir, 0.0, "still the first segment's dab, at its endpoint");
        close_msg(d[4].dir, 90.0, "the second segment moves along +y");
    }

    #[test]
    fn flow_half_two_overlapping_dabs() {
        let s = accumulate(0.0, 1.0, 0.5, 1.0);
        assert_eq!(s, 0.5);
        assert_eq!(accumulate(s, 1.0, 0.5, 1.0), 0.75);
    }

    #[test]
    fn opacity_caps_the_stroke_after_many_dabs() {
        let mut s = 0.0;
        for _ in 0..20 {
            s = accumulate(s, 0.4, 1.0, 1.0);
        }
        assert_eq!(s, 0.4);
    }

    #[test]
    fn wet_edge_remap_darkens_the_rim_and_thins_the_center() {
        close(wet_edge_remap(0.0, 1.0), 0.0);
        // Full coverage keeps only 45 %: the center of a wet stroke is thin, the rim pools.
        close(wet_edge_remap(1.0, 1.0), 0.45);
        // m = 0.5: 0.45*0.5 + 2.2*0.5*0.5 = 0.225 + 0.55 = 0.775.
        close(wet_edge_remap(0.5, 1.0), 0.775);
        close(wet_edge_remap(0.25, 0.5), 0.5 * (0.45 * 0.5 + 2.2 * 0.5 * 0.5));
    }

    #[test]
    fn prng_is_deterministic_and_seed_dependent() {
        let mut a = Prng::new(7);
        let mut b = Prng::new(7);
        let mut c = Prng::new(8);
        let seq_a: Vec<f32> = (0..5).map(|_| a.next()).collect();
        let seq_b: Vec<f32> = (0..5).map(|_| b.next()).collect();
        let seq_c: Vec<f32> = (0..5).map(|_| c.next()).collect();
        assert_eq!(seq_a, seq_b);
        assert_ne!(seq_a, seq_c);
        for v in seq_a {
            assert!((0.0..=1.0).contains(&v));
        }
    }

    #[test]
    fn dyn_default_is_a_neutral_multiplier() {
        let d = Dyn::default();
        let mut prng = Prng::new(1);
        assert_eq!(d.eval(&DabCtx::default(), &mut prng), 1.0);
    }

    #[test]
    fn dyn_fade_over_4_steps_gives_exact_sizes() {
        let d = Dyn { control: Source::Fade, fade_steps: 4, jitter: 0.0, minimum: 0.0 };
        let mut prng = Prng::new(0);
        let vals: Vec<f32> = (0..5)
            .map(|i| d.eval(&DabCtx { dab_index: i, ..Default::default() }, &mut prng))
            .collect();
        assert_eq!(vals, [1.0, 0.75, 0.5, 0.25, 0.0]);
    }

    #[test]
    fn control_value_table() {
        let ctx = DabCtx { pressure: 0.3, tilt_x: 45.0, tilt_y: 0.0, twist: 90.0, dab_index: 2, initial_dir: 30.0, dir: 60.0 };
        assert_eq!(control_value(Source::Off, &ctx, 4), 1.0);
        close(control_value(Source::Fade, &ctx, 4), 0.5);
        assert_eq!(control_value(Source::PenPressure, &ctx, 4), 0.3);
        close(control_value(Source::PenTilt, &ctx, 4), 0.5);
        close(control_value(Source::Rotation, &ctx, 4), 0.25);
        close(control_value(Source::StylusWheel, &ctx, 4), 0.25);
        close(control_value(Source::InitialDirection, &ctx, 4), 30.0 / 360.0);
        close(control_value(Source::Direction, &ctx, 4), 60.0 / 360.0);
    }

    #[test]
    fn brush_projection_flattens_with_tilt() {
        assert_eq!(brush_projection(&DabCtx::default()), 1.0, "no tilt: no-op");
        let tilted = DabCtx { tilt_x: 90.0, tilt_y: 0.0, ..Default::default() };
        close_msg(brush_projection(&tilted), 0.01, "full tilt clamps to the floor");
    }

    #[test]
    fn brush_projection_only_applies_when_enabled() {
        let tilted = Sample { tilt_x: 90.0, ..Sample::new(0.0, 0.0, 1.0) };
        let roundness = |projection: bool| {
            let d = Dynamics {
                shape: ShapeDynamics { enabled: true, brush_projection: projection, ..Default::default() },
                ..Default::default()
            };
            place_dabs(&tilted, 0.0, 10.0, 0.0, 0.8, false, false, &d, [0.0; 3], &mut Prng::new(1), &mut 0)[0].roundness
        };
        close(roundness(false), 0.8);
        close(roundness(true), 0.01);
    }

    #[test]
    fn noise_leaves_0_and_1_coverage_untouched() {
        assert_eq!(noise_remap(0.0, 1.0, 3, 4, 9), 0.0);
        assert_eq!(noise_remap(1.0, 1.0, 3, 4, 9), 1.0);
        assert_ne!(noise_remap(0.5, 1.0, 3, 4, 9), 0.5);
    }

    #[test]
    fn hash01_is_seed_and_position_dependent() {
        assert_ne!(hash01(1, 2, 9), hash01(1, 2, 10));
        assert_ne!(hash01(1, 2, 9), hash01(2, 1, 9));
        assert_eq!(hash01(1, 2, 9), hash01(1, 2, 9));
    }
}
