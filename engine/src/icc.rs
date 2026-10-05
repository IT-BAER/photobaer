//! ICC color management: profile parsing and writing, built-in working spaces, and transforms
//! through the D50 XYZ connection space with the four rendering intents and black point compensation.

use serde::{Deserialize, Serialize};
use std::sync::Arc;

mod press;
pub use press::{COATED as COATED_CMYK, UNCOATED as UNCOATED_CMYK};

pub const SRGB: &str = "sRGB IEC61966-2.1";
pub const LAB: &str = "Lab D50";
/// Gamma 1.8 RGB for View > Proof Setup > Legacy Macintosh RGB; not offered as a working space.
pub const LEGACY_MAC: &str = "Legacy Macintosh RGB (Gamma 1.8)";
/// The connection-space white (D50) as XYZ.
pub const D50: [f64; 3] = [0.9642, 1.0, 0.8249];
/// The D65 white as XYZ.
pub const D65: [f64; 3] = [0.95047, 1.0, 1.08883];
// XYZ in an ICC LUT: 1.0 stands for 65535 / 32768.
const XYZ_ENC: f64 = 65535.0 / 32768.0;
const LO: f64 = 1.09929682680944;
const AC: f64 = 0.018053968510807;

type M3 = [[f64; 3]; 3];
const IDENTITY: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn mul(a: &M3, b: &M3) -> M3 {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    o
}

fn mv(a: &M3, v: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|i| a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2])
}

fn inv(m: &M3) -> Option<M3> {
    let c = |r: usize, k: usize| m[(r + 1) % 3][(k + 1) % 3] * m[(r + 2) % 3][(k + 2) % 3] - m[(r + 1) % 3][(k + 2) % 3] * m[(r + 2) % 3][(k + 1) % 3];
    let det = m[0][0] * c(0, 0) + m[0][1] * c(0, 1) + m[0][2] * c(0, 2);
    if det.abs() < 1e-12 || !det.is_finite() {
        return None;
    }
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = c(j, i) / det;
        }
    }
    Some(o)
}

/// The inverse of a 3x3 row-major matrix, None when it is singular.
pub fn invert3(m: &M3) -> Option<M3> {
    inv(m)
}

fn diag(v: [f64; 3]) -> M3 {
    [[v[0], 0.0, 0.0], [0.0, v[1], 0.0], [0.0, 0.0, v[2]]]
}

const BRADFORD: M3 = [[0.8951, 0.2664, -0.1614], [-0.7502, 1.7135, 0.0367], [0.0389, -0.0685, 1.0296]];

/// Bradford chromatic adaptation from white `from` to white `to`.
fn adapt(from: [f64; 3], to: [f64; 3]) -> M3 {
    if (0..3).all(|i| (from[i] - to[i]).abs() < 1e-9) {
        return IDENTITY;
    }
    let (s, d) = (mv(&BRADFORD, from), mv(&BRADFORD, to));
    let g = diag([d[0] / s[0], d[1] / s[1], d[2] / s[2]]);
    mul(&inv(&BRADFORD).expect("Bradford is invertible"), &mul(&g, &BRADFORD))
}

fn xy_to_xyz([x, y]: [f64; 2]) -> [f64; 3] {
    [x / y, 1.0, (1.0 - x - y) / y]
}

// RGB -> XYZ (relative to `white`) of primaries given as xy.
fn primaries_matrix(p: [[f64; 2]; 3], white: [f64; 3]) -> M3 {
    let c = p.map(xy_to_xyz);
    let m = [[c[0][0], c[1][0], c[2][0]], [c[0][1], c[1][1], c[2][1]], [c[0][2], c[1][2], c[2][2]]];
    let s = mv(&inv(&m).expect("primaries span a triangle"), white);
    mul(&m, &diag(s))
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

fn mirror(t: f64, f: impl Fn(f64) -> f64) -> f64 {
    if t < 0.0 { -f(-t) } else { f(t) }
}

// Dot gain of a tint `x` in 0..1: the printed area grows by up to `g` at 50%.
fn dot_gain(x: f64, g: f64) -> f64 {
    clamp01(clamp01(x) + g * (std::f64::consts::PI * clamp01(x)).sin())
}

fn lab_f(t: f64) -> f64 {
    if t > 216.0 / 24389.0 { t.cbrt() } else { (24389.0 / 27.0 * t + 16.0) / 116.0 }
}

fn lab_f_inv(t: f64) -> f64 {
    if t > 6.0 / 29.0 { t * t * t } else { (116.0 * t - 16.0) / (24389.0 / 27.0) }
}

/// D50 XYZ -> CIE Lab.
pub fn xyz_to_lab(x: [f64; 3]) -> [f64; 3] {
    let f = [0, 1, 2].map(|i| lab_f(x[i] / D50[i]));
    [116.0 * f[1] - 16.0, 500.0 * (f[0] - f[1]), 200.0 * (f[1] - f[2])]
}

/// CIE Lab -> D50 XYZ.
pub fn lab_to_xyz([l, a, b]: [f64; 3]) -> [f64; 3] {
    let fy = (l + 16.0) / 116.0;
    [lab_f_inv(fy + a / 500.0) * D50[0], lab_f_inv(fy) * D50[1], lab_f_inv(fy - b / 200.0) * D50[2]]
}

/// A tone curve: device value -> linear value.
#[derive(Clone, Debug, PartialEq)]
pub enum Curve {
    Identity,
    Gamma(f64),
    /// Evenly spaced samples over 0..1.
    Table(Vec<f64>),
    /// ICC parametric curve type 0..4 with its parameters (unused ones 0).
    Param(u16, [f64; 7]),
    Srgb,
    /// ProPhoto (ROMM) gamma 1.8 with a linear toe.
    Romm,
    Rec2020,
    /// Gray ink with this much dot gain at 50%.
    DotGain(f64),
}

fn interp(v: &[f64], t: f64) -> f64 {
    match v.len() {
        0 => t,
        1 => v[0],
        n => {
            let x = clamp01(t) * (n - 1) as f64;
            let i = (x.floor() as usize).min(n - 2);
            v[i] + (v[i + 1] - v[i]) * (x - i as f64)
        }
    }
}

fn param(f: u16, p: &[f64; 7], x: f64) -> f64 {
    let (g, a, b, c, d, e, ff) = (p[0], p[1], p[2], p[3], p[4], p[5], p[6]);
    let pw = |v: f64| if v <= 0.0 { 0.0 } else { v.powf(g) };
    match f {
        0 => pw(x),
        1 => {
            if a != 0.0 && x >= -b / a { pw(a * x + b) } else { 0.0 }
        }
        2 => {
            if a != 0.0 && x >= -b / a { pw(a * x + b) + c } else { c }
        }
        3 => {
            if x >= d { pw(a * x + b) } else { c * x }
        }
        _ => {
            if x >= d { pw(a * x + b) + e } else { c * x + ff }
        }
    }
}

impl Curve {
    pub fn eval(&self, t: f64) -> f64 {
        match self {
            Curve::Identity => t,
            Curve::Gamma(g) => {
                if t <= 0.0 { 0.0 } else { t.powf(*g) }
            }
            Curve::Table(v) => interp(v, t),
            Curve::Param(f, p) => param(*f, p, t),
            Curve::Srgb => mirror(t, |a| if a <= 0.04045 { a / 12.92 } else { ((a + 0.055) / 1.055).powf(2.4) }),
            Curve::Romm => mirror(t, |a| if a < 16.0 / 512.0 { a / 16.0 } else { a.powf(1.8) }),
            Curve::Rec2020 => mirror(t, |a| if a < 4.5 * AC { a / 4.5 } else { ((a + (LO - 1.0)) / LO).powf(1.0 / 0.45) }),
            Curve::DotGain(g) => 1.0 - dot_gain(1.0 - clamp01(t), *g),
        }
    }

    /// Linear value -> device value, for curves with a closed-form inverse (else unchanged).
    pub fn inverse(&self, y: f64) -> f64 {
        self.inverse_exact(y).unwrap_or(y)
    }

    // The inverse in closed form, where there is one.
    fn inverse_exact(&self, y: f64) -> Option<f64> {
        Some(match self {
            Curve::Identity => y,
            Curve::Gamma(g) => {
                if y <= 0.0 { 0.0 } else { y.powf(1.0 / g) }
            }
            Curve::Srgb => mirror(y, |a| if a <= 0.0031308 { 12.92 * a } else { 1.055 * a.powf(1.0 / 2.4) - 0.055 }),
            Curve::Romm => mirror(y, |a| if a < 1.0 / 512.0 { a * 16.0 } else { a.powf(1.0 / 1.8) }),
            Curve::Rec2020 => mirror(y, |a| if a < AC { 4.5 * a } else { LO * a.powf(0.45) - (LO - 1.0) }),
            _ => return None,
        })
    }

    // `n` samples of the inverse over 0..1, by bisection (the curve is monotonic).
    fn sample_inverse(&self, n: usize) -> Vec<f64> {
        let (f0, f1) = (self.eval(0.0), self.eval(1.0));
        (0..n)
            .map(|k| {
                let y = k as f64 / (n - 1) as f64;
                let (mut lo, mut hi) = (0.0f64, 1.0f64);
                if f0 == f1 {
                    return lo;
                }
                for _ in 0..40 {
                    let m = (lo + hi) / 2.0;
                    if (self.eval(m) < y) == (f1 > f0) {
                        lo = m
                    } else {
                        hi = m
                    }
                }
                (lo + hi) / 2.0
            })
            .collect()
    }
}

/// A multidimensional lookup table; inputs and outputs are 0..1.
#[derive(Debug, PartialEq)]
pub struct Clut {
    inputs: usize,
    outputs: usize,
    grid: Vec<usize>,
    data: Vec<f64>,
}

impl Clut {
    fn from_fn(inputs: usize, outputs: usize, grid: usize, mut f: impl FnMut(&[f64], &mut [f64])) -> Clut {
        let total = grid.pow(inputs as u32);
        let mut data = vec![0.0; total * outputs];
        let (mut i, mut o) = (vec![0.0; inputs], vec![0.0; outputs]);
        for r in 0..total {
            let mut c = r;
            for k in (0..inputs).rev() {
                i[k] = (c % grid) as f64 / (grid - 1) as f64;
                c /= grid;
            }
            f(&i, &mut o);
            data[r * outputs..(r + 1) * outputs].copy_from_slice(&o);
        }
        Clut { inputs, outputs, grid: vec![grid; inputs], data }
    }

    fn eval(&self, x: &[f64], out: &mut [f64]) {
        if self.inputs == 3 { self.tetrahedral(x, out) } else { self.multilinear(x, out) }
    }

    fn multilinear(&self, x: &[f64], out: &mut [f64]) {
        let (n, m) = (self.inputs, self.outputs);
        let mut base = [0usize; 16];
        let mut frac = [0.0f64; 16];
        for a in 0..n {
            let r = self.grid[a] - 1;
            let c = clamp01(x[a]) * r as f64;
            let i = (c.floor() as usize).min(r.saturating_sub(1));
            base[a] = i;
            frac[a] = if r > 0 { c - i as f64 } else { 0.0 };
        }
        out[..m].iter_mut().for_each(|v| *v = 0.0);
        for corner in 0..1usize << n {
            let mut w = 1.0;
            let mut idx = 0;
            for a in 0..n {
                let h = (corner >> (n - 1 - a)) & 1;
                w *= if h == 1 { frac[a] } else { 1.0 - frac[a] };
                idx = idx * self.grid[a] + (base[a] + h).min(self.grid[a] - 1);
            }
            if w == 0.0 {
                continue;
            }
            for c in 0..m {
                out[c] += self.data[idx * m + c] * w;
            }
        }
    }

    fn tetrahedral(&self, x: &[f64], out: &mut [f64]) {
        let m = self.outputs;
        let g = &self.grid;
        let mut b = [0usize; 3];
        let mut f = [0.0f64; 3];
        let mut b1 = [0usize; 3];
        for a in 0..3 {
            let r = g[a] - 1;
            let c = clamp01(x[a]) * r as f64;
            let i = (c.floor() as usize).min(r.saturating_sub(1));
            b[a] = i;
            f[a] = if r > 0 { c - i as f64 } else { 0.0 };
            b1[a] = (i + 1).min(r);
        }
        let at = |i: usize, j: usize, k: usize| ((i * g[1] + j) * g[2] + k) * m;
        let (rx, ry, rz) = (f[0], f[1], f[2]);
        let c0 = at(b[0], b[1], b[2]);
        // The tetrahedron holding (rx, ry, rz): its corners in the order its edges walk.
        let (p1, p2, p3, w1, w2, w3) = if rx >= ry && ry >= rz {
            (at(b1[0], b[1], b[2]), at(b1[0], b1[1], b[2]), at(b1[0], b1[1], b1[2]), rx, ry, rz)
        } else if rx >= rz && rz >= ry {
            (at(b1[0], b[1], b[2]), at(b1[0], b[1], b1[2]), at(b1[0], b1[1], b1[2]), rx, rz, ry)
        } else if rz >= rx && rx >= ry {
            (at(b[0], b[1], b1[2]), at(b1[0], b[1], b1[2]), at(b1[0], b1[1], b1[2]), rz, rx, ry)
        } else if ry >= rx && rx >= rz {
            (at(b[0], b1[1], b[2]), at(b1[0], b1[1], b[2]), at(b1[0], b1[1], b1[2]), ry, rx, rz)
        } else if ry >= rz && rz >= rx {
            (at(b[0], b1[1], b[2]), at(b[0], b1[1], b1[2]), at(b1[0], b1[1], b1[2]), ry, rz, rx)
        } else {
            (at(b[0], b[1], b1[2]), at(b[0], b1[1], b1[2]), at(b1[0], b1[1], b1[2]), rz, ry, rx)
        };
        let d = &self.data;
        for c in 0..m {
            out[c] = d[c0 + c] + (d[p1 + c] - d[c0 + c]) * w1 + (d[p2 + c] - d[p1 + c]) * w2 + (d[p3 + c] - d[p2 + c]) * w3;
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
enum Elem {
    Curves(Vec<Curve>),
    /// 3x3 row-major, then an offset.
    Matrix([f64; 12]),
    Clut(Arc<Clut>),
}

/// A parsed A2Bx / B2Ax tag.
#[derive(Clone, Debug, PartialEq)]
pub struct Pipe {
    outputs: usize,
    elems: Vec<Elem>,
    // Version 2 16-bit Lab, where 0xff00 is the top of the range.
    legacy_lab: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Space {
    Rgb,
    Gray,
    Lab,
    Cmyk,
    /// Any other color space, by channel count.
    Other(u8),
}

impl Space {
    fn from_sig(s: &[u8; 4]) -> Result<Space, String> {
        Ok(match s {
            b"RGB " => Space::Rgb,
            b"GRAY" => Space::Gray,
            b"Lab " => Space::Lab,
            b"CMYK" => Space::Cmyk,
            b"XYZ " | b"Luv " | b"YCbr" | b"Yxy " | b"HSV " | b"HLS " | b"CMY " => Space::Other(3),
            [c, b'C', b'L', b'R'] if c.is_ascii_hexdigit() && *c != b'0' => Space::Other((*c as char).to_digit(16).unwrap_or(1) as u8),
            _ => return Err(format!("ICC profile: unsupported color space \"{}\"", String::from_utf8_lossy(s))),
        })
    }

    pub fn channels(self) -> usize {
        match self {
            Space::Gray => 1,
            Space::Rgb | Space::Lab => 3,
            Space::Cmyk => 4,
            Space::Other(n) => n as usize,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Space::Rgb => "rgb",
            Space::Gray => "gray",
            Space::Lab => "lab",
            Space::Cmyk => "cmyk",
            Space::Other(_) => "other",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
pub enum Intent {
    #[serde(rename = "perceptual")]
    Perceptual,
    #[default]
    #[serde(rename = "relativeColorimetric")]
    Relative,
    #[serde(rename = "saturation")]
    Saturation,
    #[serde(rename = "absoluteColorimetric")]
    Absolute,
}

/// An ICC profile, parsed from bytes or built in.
#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pub name: String,
    pub space: Space,
    pub class: [u8; 4],
    pub pcs_lab: bool,
    /// The media white as the tag stores it (v4 profiles store D50 plus `chad`).
    pub white: Option<[f64; 3]>,
    pub black: Option<[f64; 3]>,
    pub chad: Option<M3>,
    /// RGB -> D50 XYZ, row-major (its columns are the colorant tags).
    pub colorants: Option<M3>,
    pub trc: Option<[Curve; 3]>,
    pub gray_trc: Option<Curve>,
    a2b: [Option<Pipe>; 3],
    b2a: [Option<Pipe>; 3],
    // The 'gamt' tag: PCS -> 0 in gamut, above 0 out of gamut.
    gamut: Option<Pipe>,
    /// The file this profile came from; built-in profiles have none.
    pub icc_bytes: Option<Vec<u8>>,
}

const BUILTIN: [&str; 14] = [
    SRGB,
    "Adobe RGB (1998)",
    "Display P3",
    "ProPhoto RGB",
    "Rec. 2020",
    "Gray Gamma 2.2",
    "Gray Gamma 1.8",
    "Dot Gain 15%",
    "Dot Gain 20%",
    "Dot Gain 25%",
    "Dot Gain 30%",
    COATED_CMYK,
    UNCOATED_CMYK,
    LAB,
];

/// Names of the built-in profiles.
pub fn builtin_names() -> &'static [&'static str] {
    &BUILTIN
}

impl Profile {
    fn empty(name: &str, space: Space) -> Profile {
        Profile {
            name: name.into(),
            space,
            class: *b"mntr",
            pcs_lab: false,
            white: Some(D50),
            black: None,
            chad: None,
            colorants: None,
            trc: None,
            gray_trc: None,
            a2b: [None, None, None],
            b2a: [None, None, None],
            gamut: None,
            icc_bytes: None,
        }
    }

    /// A matrix/TRC RGB profile from xy primaries, a white (XYZ) and one curve for all channels.
    pub fn rgb(name: &str, primaries: [[f64; 2]; 3], white: [f64; 3], trc: Curve) -> Profile {
        let chad = adapt(white, D50);
        Profile {
            white: Some(white),
            chad: Some(chad),
            colorants: Some(mul(&chad, &primaries_matrix(primaries, white))),
            trc: Some([trc.clone(), trc.clone(), trc]),
            ..Profile::empty(name, Space::Rgb)
        }
    }

    pub fn gray(name: &str, trc: Curve) -> Profile {
        Profile { gray_trc: Some(trc), ..Profile::empty(name, Space::Gray) }
    }

    pub fn builtin(name: &str) -> Option<Profile> {
        const SRGB_P: [[f64; 2]; 3] = [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]];
        Some(match name {
            SRGB => Profile::rgb(SRGB, SRGB_P, D65, Curve::Srgb),
            "Adobe RGB (1998)" => Profile::rgb(name, [[0.64, 0.33], [0.21, 0.71], [0.15, 0.06]], D65, Curve::Gamma(563.0 / 256.0)),
            "Display P3" => Profile::rgb(name, [[0.68, 0.32], [0.265, 0.69], [0.15, 0.06]], D65, Curve::Srgb),
            "ProPhoto RGB" => Profile::rgb(name, [[0.734699, 0.265301], [0.159597, 0.840403], [0.036598, 0.000105]], D50, Curve::Romm),
            "Rec. 2020" => Profile::rgb(name, [[0.708, 0.292], [0.17, 0.797], [0.131, 0.046]], D65, Curve::Rec2020),
            "Gray Gamma 2.2" => Profile::gray(name, Curve::Gamma(2.2)),
            "Gray Gamma 1.8" => Profile::gray(name, Curve::Gamma(1.8)),
            "Dot Gain 15%" => Profile::gray(name, Curve::DotGain(0.15)),
            "Dot Gain 20%" => Profile::gray(name, Curve::DotGain(0.2)),
            "Dot Gain 25%" => Profile::gray(name, Curve::DotGain(0.25)),
            "Dot Gain 30%" => Profile::gray(name, Curve::DotGain(0.3)),
            LAB => Profile { class: *b"spac", pcs_lab: true, ..Profile::empty(LAB, Space::Lab) },
            LEGACY_MAC => Profile::rgb(name, SRGB_P, D65, Curve::Gamma(1.8)),
            _ => return press::profile(name),
        })
    }

    pub fn channels(&self) -> usize {
        self.space.channels()
    }

    /// The profile as ICC bytes: the original file, or a written v4 profile for built-in RGB and Gray.
    pub fn icc(&self) -> Option<Vec<u8>> {
        if let Some(b) = &self.icc_bytes {
            return Some(b.clone());
        }
        let wtpt = (*b"wtpt", xyz_tag(D50));
        match (self.space, &self.colorants, &self.trc, &self.gray_trc) {
            (Space::Rgb, Some(m), Some(trc), _) => {
                let col = |c: usize| xyz_tag([m[0][c], m[1][c], m[2][c]]);
                let mut tags = vec![wtpt, (*b"chad", sf32(&self.chad.unwrap_or(IDENTITY))), (*b"rXYZ", col(0)), (*b"gXYZ", col(1)), (*b"bXYZ", col(2))];
                for (sig, c) in [b"rTRC", b"gTRC", b"bTRC"].into_iter().zip(trc) {
                    tags.push((*sig, curve_tag(c)));
                }
                Some(write_profile(b"mntr", b"RGB ", &self.name, &tags))
            }
            (Space::Gray, _, _, Some(c)) => Some(write_profile(b"mntr", b"GRAY", &self.name, &[wtpt, (*b"kTRC", curve_tag(c))])),
            _ => None,
        }
    }

    // The white the absolute intent keeps: v4 profiles store D50 and the adaptation that led there.
    fn media_white(&self) -> [f64; 3] {
        let w = self.white.unwrap_or(D50);
        match self.chad.as_ref().and_then(inv) {
            Some(ci) if (w[0] - D50[0]).abs() < 0.02 && (w[2] - D50[2]).abs() < 0.02 => mv(&ci, w),
            _ => w,
        }
    }

    // The darkest color the profile reaches, in D50 XYZ.
    fn black_point(&self) -> Result<[f64; 3], String> {
        if let Some(b) = self.black {
            return Ok(b.map(|v| v.max(0.0)));
        }
        let to = Transform { inputs: self.channels(), outputs: 3, stages: self.to_pcs(Intent::Relative)? };
        let mut xyz = [0.0; 3];
        if pick(&self.b2a, Intent::Relative).is_some() {
            let from = Transform { inputs: 3, outputs: self.channels(), stages: self.from_pcs(Intent::Relative)? };
            let mut dev = vec![0.0; self.channels()];
            from.apply(&[0.0; 3], &mut dev);
            to.apply(&dev, &mut xyz);
        } else {
            let mut black = vec![0.0; self.channels()];
            match self.space {
                Space::Cmyk => black[3] = 1.0,
                Space::Lab => (black[1], black[2]) = (128.0 / 255.0, 128.0 / 255.0),
                _ => {}
            }
            to.apply(&black, &mut xyz);
        }
        Ok(xyz.map(|v| v.max(0.0)))
    }

    // Device -> D50 XYZ.
    fn to_pcs(&self, intent: Intent) -> Result<Vec<Stage>, String> {
        if let Some(lut) = pick(&self.a2b, intent) {
            let mut st = lut_stages(lut);
            if self.pcs_lab {
                st.push(Stage::Matrix(lab_decode(lut.legacy_lab)));
                st.push(Stage::LabToXyz);
            } else {
                st.push(Stage::Matrix(scale([XYZ_ENC; 3])));
            }
            return Ok(st);
        }
        match (self.space, &self.colorants, &self.trc, &self.gray_trc) {
            (Space::Rgb, Some(m), Some(trc), _) => Ok(vec![Stage::Tones(trc.iter().map(|c| Tone::Fwd(c.clone())).collect()), Stage::Matrix(mat(m))]),
            (Space::Gray, _, _, Some(c)) => {
                Ok(vec![Stage::Tones(vec![Tone::Fwd(c.clone())]), Stage::Matrix(mat(&[[D50[0], 0.0, 0.0], [D50[1], 0.0, 0.0], [D50[2], 0.0, 0.0]]))])
            }
            (Space::Lab, ..) => Ok(vec![Stage::Matrix(lab_decode(false)), Stage::LabToXyz]),
            _ => Err(format!("profile \"{}\" has no usable device-to-PCS transform", self.name)),
        }
    }

    // D50 XYZ -> device, clipped to 0..1.
    fn from_pcs(&self, intent: Intent) -> Result<Vec<Stage>, String> {
        if let Some(lut) = pick(&self.b2a, intent) {
            let mut st = if self.pcs_lab {
                vec![Stage::XyzToLab, Stage::Matrix(lab_encode(lut.legacy_lab))]
            } else {
                vec![Stage::Matrix(scale([1.0 / XYZ_ENC; 3]))]
            };
            st.push(Stage::Clamp(3));
            st.extend(lut_stages(lut));
            st.push(Stage::Clamp(lut.outputs));
            return Ok(st);
        }
        match (self.space, &self.colorants, &self.trc, &self.gray_trc) {
            (Space::Rgb, Some(m), Some(trc), _) => {
                let mi = inv(m).ok_or_else(|| format!("profile \"{}\" has singular colorants", self.name))?;
                Ok(vec![Stage::Matrix(mat(&mi)), Stage::Tones(trc.iter().map(inverse_tone).collect()), Stage::Clamp(3)])
            }
            (Space::Gray, _, _, Some(c)) => Ok(vec![Stage::Matrix(mat(&[[0.0, 1.0 / D50[1], 0.0], [0.0; 3], [0.0; 3]])), Stage::Tones(vec![inverse_tone(c)]), Stage::Clamp(1)]),
            (Space::Lab, ..) => Ok(vec![Stage::XyzToLab, Stage::Matrix(lab_encode(false)), Stage::Clamp(3)]),
            _ => Err(format!("profile \"{}\" has no usable PCS-to-device transform", self.name)),
        }
    }
}

fn pick(t: &[Option<Pipe>; 3], intent: Intent) -> Option<&Pipe> {
    let order: &[usize] = match intent {
        Intent::Perceptual => &[0, 1, 2],
        Intent::Relative | Intent::Absolute => &[1, 0, 2],
        Intent::Saturation => &[2, 1, 0],
    };
    order.iter().find_map(|&i| t[i].as_ref())
}

fn mat(m: &M3) -> [f64; 12] {
    [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2], 0.0, 0.0, 0.0]
}

fn scale(s: [f64; 3]) -> [f64; 12] {
    mat(&diag(s))
}

// Encoded Lab (0..1 per channel) <-> L 0..100 and a, b -128..127.
fn lab_decode(legacy: bool) -> [f64; 12] {
    let t = if legacy { 256.0 / 255.0 } else { 1.0 };
    [t * 100.0, 0.0, 0.0, 0.0, t * 255.0, 0.0, 0.0, 0.0, t * 255.0, 0.0, -128.0, -128.0]
}

fn lab_encode(legacy: bool) -> [f64; 12] {
    let t = if legacy { 255.0 / 256.0 } else { 1.0 };
    [t / 100.0, 0.0, 0.0, 0.0, t / 255.0, 0.0, 0.0, 0.0, t / 255.0, 0.0, 128.0 / 255.0 * t, 128.0 / 255.0 * t]
}

fn inverse_tone(c: &Curve) -> Tone {
    match c.inverse_exact(0.5) {
        Some(_) => Tone::Inv(c.clone()),
        None => Tone::Table(Arc::new(c.sample_inverse(4096))),
    }
}

fn lut_stages(l: &Pipe) -> Vec<Stage> {
    l.elems
        .iter()
        .map(|e| match e {
            Elem::Curves(c) => Stage::Tones(c.iter().map(|c| Tone::Fwd(c.clone())).collect()),
            Elem::Matrix(m) => Stage::Matrix(*m),
            Elem::Clut(c) => Stage::Clut(c.clone()),
        })
        .collect()
}

#[derive(Clone, Debug)]
enum Tone {
    Fwd(Curve),
    Inv(Curve),
    Table(Arc<Vec<f64>>),
}

#[derive(Clone, Debug)]
enum Stage {
    Tones(Vec<Tone>),
    Matrix([f64; 12]),
    Clut(Arc<Clut>),
    Clamp(usize),
    LabToXyz,
    XyzToLab,
}

impl Stage {
    fn run(&self, a: &[f64; 16], b: &mut [f64; 16]) {
        match self {
            Stage::Tones(t) => {
                for (i, t) in t.iter().enumerate() {
                    b[i] = match t {
                        Tone::Fwd(c) => c.eval(a[i]),
                        Tone::Inv(c) => c.inverse_exact(a[i]).unwrap_or(a[i]),
                        Tone::Table(v) => interp(v, a[i]),
                    };
                }
            }
            Stage::Matrix(m) => {
                let (x, y, z) = (a[0], a[1], a[2]);
                for r in 0..3 {
                    b[r] = m[r * 3] * x + m[r * 3 + 1] * y + m[r * 3 + 2] * z + m[9 + r];
                }
            }
            Stage::Clut(c) => c.eval(&a[..c.inputs], &mut b[..c.outputs]),
            Stage::Clamp(n) => {
                for i in 0..*n {
                    b[i] = clamp01(a[i]);
                }
            }
            Stage::LabToXyz => b[..3].copy_from_slice(&lab_to_xyz([a[0], a[1], a[2]])),
            Stage::XyzToLab => b[..3].copy_from_slice(&xyz_to_lab([a[0], a[1], a[2]])),
        }
    }
}

/// A device-to-device color transform.
#[derive(Clone, Debug)]
pub struct Transform {
    pub inputs: usize,
    pub outputs: usize,
    stages: Vec<Stage>,
}

impl Transform {
    pub fn new(src: &Profile, dst: &Profile, intent: Intent, bpc: bool) -> Result<Transform, String> {
        let mut stages = src.to_pcs(intent)?;
        if intent == Intent::Absolute {
            let (s, d) = (src.media_white(), dst.media_white());
            let k = [s[0] / d[0], s[1] / d[1], s[2] / d[2]];
            if k.iter().any(|v| (v - 1.0).abs() > 1e-9) {
                stages.push(Stage::Matrix(scale(k)));
            }
        } else if bpc {
            let (s, d) = (src.black_point()?, dst.black_point()?);
            let n = [0, 1, 2].map(|i| s[i] - D50[i]);
            if n.iter().all(|v| v.abs() >= 1e-9) {
                let k = [0, 1, 2].map(|i| (d[i] - D50[i]) / n[i]);
                let o = [0, 1, 2].map(|i| -D50[i] * (d[i] - s[i]) / n[i]);
                if k.iter().any(|v| (v - 1.0).abs() > 1e-9) || o.iter().any(|v| v.abs() > 1e-9) {
                    let mut m = scale(k);
                    m[9..].copy_from_slice(&o);
                    stages.push(Stage::Matrix(m));
                }
            }
        }
        stages.extend(dst.from_pcs(intent)?);
        Ok(Transform { inputs: src.channels(), outputs: dst.channels(), stages })
    }

    /// Device values of `src` -> the gamut tag of `dev` (0: in gamut); None without the tag.
    pub fn gamut_check(src: &Profile, dev: &Profile) -> Result<Option<Transform>, String> {
        let Some(g) = &dev.gamut else { return Ok(None) };
        let mut stages = src.to_pcs(Intent::Relative)?;
        if dev.pcs_lab {
            stages.extend([Stage::XyzToLab, Stage::Matrix(lab_encode(g.legacy_lab))]);
        } else {
            stages.push(Stage::Matrix(scale([1.0 / XYZ_ENC; 3])));
        }
        stages.push(Stage::Clamp(3));
        stages.extend(lut_stages(g));
        stages.push(Stage::Clamp(1));
        Ok(Some(Transform { inputs: src.channels(), outputs: 1, stages }))
    }

    /// The transform without its final clip to 0..1, for sampling into a table that clips later.
    pub fn unclipped(mut self) -> Transform {
        if matches!(self.stages.last(), Some(Stage::Clamp(_))) {
            self.stages.pop();
        }
        self
    }

    /// Relative colorimetric, then the source paper (its media white) shown against the destination
    /// white instead of mapped onto it: View > Proof Setup > Simulate Paper Color.
    pub fn paper(src: &Profile, dst: &Profile) -> Result<Transform, String> {
        let mut stages = src.to_pcs(Intent::Relative)?;
        let w = src.media_white();
        stages.push(Stage::Matrix(scale([0, 1, 2].map(|i| w[i] / D50[i]))));
        stages.extend(dst.from_pcs(Intent::Relative)?);
        Ok(Transform { inputs: src.channels(), outputs: dst.channels(), stages })
    }

    /// Device values in 0..1 -> device values in 0..1.
    pub fn apply(&self, input: &[f64], out: &mut [f64]) {
        let (mut a, mut b) = ([0.0f64; 16], [0.0f64; 16]);
        a[..self.inputs].copy_from_slice(&input[..self.inputs]);
        for s in &self.stages {
            s.run(&a, &mut b);
            std::mem::swap(&mut a, &mut b);
        }
        out[..self.outputs].copy_from_slice(&a[..self.outputs]);
    }
}

/// A transform sampled on a grid (`grid` points per input), for applying to many pixels.
#[derive(Debug, PartialEq)]
pub struct Lut {
    clut: Clut,
}

impl Lut {
    pub fn new(t: &Transform, grid: usize) -> Lut {
        Lut { clut: Clut::from_fn(t.inputs, t.outputs, grid, |i, o| t.apply(i, o)) }
    }

    /// A table of any function of `inputs` values in 0..1 to up to three outputs.
    pub fn from_fn(inputs: usize, outputs: usize, grid: usize, f: impl FnMut(&[f64], &mut [f64])) -> Lut {
        Lut { clut: Clut::from_fn(inputs, outputs, grid, f) }
    }

    /// The first `inputs` channels of `c` through the table (up to three outputs).
    pub fn apply(&self, c: [f32; 3]) -> [f32; 3] {
        let (mut i, mut o) = ([0.0f64; 3], [0.0f64; 16]);
        for k in 0..self.clut.inputs.min(3) {
            i[k] = c[k] as f64;
        }
        self.clut.eval(&i[..self.clut.inputs.min(3)], &mut o[..self.clut.outputs]);
        [o[0] as f32, o[1] as f32, o[2] as f32]
    }
}

// ---------- reading ----------

struct Rd<'a> {
    b: &'a [u8],
    o: usize,
}

fn perr(m: impl std::fmt::Display) -> String {
    format!("ICC profile: {m}")
}

impl<'a> Rd<'a> {
    fn at(b: &'a [u8], o: usize) -> Rd<'a> {
        Rd { b, o }
    }
    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.o.checked_add(n).filter(|&e| e <= self.b.len()).ok_or_else(|| perr(format!("truncated: needed {n} bytes at {}", self.o)))?;
        let s = &self.b[self.o..end];
        self.o = end;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }
    fn u16(&mut self) -> Result<u16, String> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()))
    }
    fn u32(&mut self) -> Result<u32, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn s15(&mut self) -> Result<f64, String> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into().unwrap()) as f64 / 65536.0)
    }
    fn sig(&mut self) -> Result<[u8; 4], String> {
        Ok(self.take(4)?.try_into().unwrap())
    }
    fn skip(&mut self, n: usize) -> Result<(), String> {
        self.take(n).map(|_| ())
    }
    fn left(&self) -> usize {
        self.b.len().saturating_sub(self.o)
    }
}

fn read_xyz(r: &mut Rd) -> Result<[f64; 3], String> {
    let t = r.sig()?;
    if &t != b"XYZ " {
        return Err(perr(format!("expected XYZType, got \"{}\"", String::from_utf8_lossy(&t))));
    }
    r.skip(4)?;
    Ok([r.s15()?, r.s15()?, r.s15()?])
}

fn read_curve(r: &mut Rd) -> Result<Curve, String> {
    let t = r.sig()?;
    r.skip(4)?;
    match &t {
        b"curv" => {
            let n = r.u32()? as usize;
            match n {
                0 => Ok(Curve::Identity),
                1 => Ok(Curve::Gamma(r.u16()? as f64 / 256.0)),
                _ => {
                    if n * 2 > r.left() {
                        return Err(perr("curve table past the end"));
                    }
                    (0..n).map(|_| Ok(r.u16()? as f64 / 65535.0)).collect::<Result<_, String>>().map(Curve::Table)
                }
            }
        }
        b"para" => {
            let f = r.u16()?;
            r.skip(2)?;
            let n = [1, 3, 4, 5, 7].get(f as usize).ok_or_else(|| perr(format!("unsupported parametric curve type {f}")))?;
            let mut p = [0.0; 7];
            for v in p.iter_mut().take(*n) {
                *v = r.s15()?;
            }
            Ok(Curve::Param(f, p))
        }
        _ => Err(perr(format!("expected a curve type, got \"{}\"", String::from_utf8_lossy(&t)))),
    }
}

fn read_text(b: &[u8], off: usize) -> Result<String, String> {
    let mut r = Rd::at(b, off);
    let t = r.sig()?;
    r.skip(4)?;
    let ascii = |s: &[u8]| s.iter().take_while(|&&c| c != 0).map(|&c| c as char).collect::<String>();
    match &t {
        b"desc" => {
            let n = r.u32()? as usize;
            Ok(ascii(r.take(n.min(r.left()))?))
        }
        b"text" => Ok(ascii(r.take(r.left().min(256))?)),
        b"mluc" => {
            let n = r.u32()?;
            r.skip(4)?;
            let mut best = None;
            for _ in 0..n.min(256) {
                let lang = r.take(2)?.to_vec();
                let country = r.take(2)?.to_vec();
                let (len, o) = (r.u32()? as usize, r.u32()? as usize);
                if best.is_none() || (lang == b"en" && country == b"US") {
                    best = Some((o, len));
                }
            }
            let Some((o, len)) = best else { return Ok(String::new()) };
            let s = Rd::at(b, off.saturating_add(o)).take(len)?;
            let units: Vec<u16> = s.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).take_while(|&u| u != 0).collect();
            Ok(String::from_utf16_lossy(&units))
        }
        _ => Ok(String::new()),
    }
}

// Curves stored back to back from `off`, each padded to 4 bytes.
fn read_curves(b: &[u8], mut off: usize, n: usize) -> Result<Vec<Curve>, String> {
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let mut r = Rd::at(b, off);
        out.push(read_curve(&mut r)?);
        let used = r.o - off;
        off = r.o + (4 - used % 4) % 4;
    }
    Ok(out)
}

const MAX_CLUT: usize = 1 << 24;

fn clut_len(grid: &[usize], outputs: usize) -> Result<usize, String> {
    grid.iter().try_fold(outputs, |a, &g| a.checked_mul(g)).filter(|&n| n <= MAX_CLUT).ok_or_else(|| perr("CLUT too large"))
}

fn channel_count(n: u8) -> Result<usize, String> {
    if (1..=15).contains(&n) { Ok(n as usize) } else { Err(perr(format!("{n} LUT channels"))) }
}

// lut8Type / lut16Type.
fn read_mft(r: &mut Rd, t: &[u8; 4], lab: bool, a2b: bool) -> Result<Pipe, String> {
    r.skip(4)?;
    let (i, o, g) = (channel_count(r.u8()?)?, channel_count(r.u8()?)?, r.u8()? as usize);
    r.skip(1)?;
    if g < 2 {
        return Err(perr("CLUT axis with fewer than 2 grid points"));
    }
    let mut m = [0.0; 12];
    for v in m.iter_mut().take(9) {
        *v = r.s15()?;
    }
    let wide = t == b"mft2";
    let (ni, no) = if wide { (r.u16()? as usize, r.u16()? as usize) } else { (256, 256) };
    if ni < 2 || no < 2 {
        return Err(perr("LUT tables need at least 2 entries"));
    }
    let len = clut_len(&vec![g; i], o)?;
    if (ni * i + len + no * o) * if wide { 2 } else { 1 } > r.left() {
        return Err(perr("LUT past the end"));
    }
    let mut val = || -> Result<f64, String> { if wide { Ok(r.u16()? as f64 / 65535.0) } else { Ok(r.u8()? as f64 / 255.0) } };
    let mut table = |n: usize| -> Result<Curve, String> { (0..n).map(|_| val()).collect::<Result<_, String>>().map(Curve::Table) };
    let ins = (0..i).map(|_| table(ni)).collect::<Result<Vec<_>, _>>()?;
    let mut val = || -> Result<f64, String> { if wide { Ok(r.u16()? as f64 / 65535.0) } else { Ok(r.u8()? as f64 / 255.0) } };
    let data = (0..len).map(|_| val()).collect::<Result<Vec<_>, _>>()?;
    let outs = (0..o)
        .map(|_| (0..no).map(|_| val()).collect::<Result<Vec<_>, String>>().map(Curve::Table))
        .collect::<Result<Vec<_>, _>>()?;
    let identity = m[0] == 1.0 && m[4] == 1.0 && m[8] == 1.0 && m[1] == 0.0 && m[2] == 0.0 && m[3] == 0.0 && m[5] == 0.0 && m[6] == 0.0 && m[7] == 0.0;
    let mut elems = vec![];
    if !a2b && i == 3 && !identity {
        elems.push(Elem::Matrix(m));
    }
    elems.push(Elem::Curves(ins));
    elems.push(Elem::Clut(Arc::new(Clut { inputs: i, outputs: o, grid: vec![g; i], data })));
    elems.push(Elem::Curves(outs));
    Ok(Pipe { outputs: o, elems, legacy_lab: lab && wide })
}

// lutAtoBType / lutBtoAType.
fn read_mab(b: &[u8], start: usize, t: &[u8; 4]) -> Result<Pipe, String> {
    let mut r = Rd::at(b, start + 8);
    let (i, o) = (channel_count(r.u8()?)?, channel_count(r.u8()?)?);
    r.skip(2)?;
    let (ob, om, omc, oc, oa) = (r.u32()? as usize, r.u32()? as usize, r.u32()? as usize, r.u32()? as usize, r.u32()? as usize);
    let ab = t == b"mAB ";
    let at = |o: usize| start.checked_add(o).ok_or_else(|| perr("offset overflow"));
    let a = if oa > 0 { Some(read_curves(b, at(oa)?, if ab { i } else { o })?) } else { None };
    let bc = if ob > 0 { Some(read_curves(b, at(ob)?, if ab { o } else { i })?) } else { None };
    let mc = if omc > 0 { Some(read_curves(b, at(omc)?, if ab { o } else { i })?) } else { None };
    let m = if om > 0 {
        let mut r = Rd::at(b, at(om)?);
        let mut m = [0.0; 12];
        for v in m.iter_mut() {
            *v = r.s15()?;
        }
        Some(m)
    } else {
        None
    };
    let clut = if oc > 0 {
        let mut r = Rd::at(b, at(oc)?);
        let gp = r.take(16)?;
        let grid: Vec<usize> = gp[..i].iter().map(|&g| g as usize).collect();
        if grid.iter().any(|&g| g < 2) {
            return Err(perr("CLUT axis with fewer than 2 grid points"));
        }
        let prec = r.u8()?;
        r.skip(3)?;
        let len = clut_len(&grid, o)?;
        let data = match prec {
            1 if len <= r.left() => (0..len).map(|_| Ok(r.u8()? as f64 / 255.0)).collect::<Result<Vec<_>, String>>()?,
            2 if len * 2 <= r.left() => (0..len).map(|_| Ok(r.u16()? as f64 / 65535.0)).collect::<Result<Vec<_>, String>>()?,
            1 | 2 => return Err(perr("CLUT past the end")),
            p => return Err(perr(format!("unsupported CLUT precision {p}"))),
        };
        Some(Arc::new(Clut { inputs: i, outputs: o, grid, data }))
    } else {
        None
    };
    if (m.is_some() || mc.is_some()) && (if ab { o } else { i }) != 3 {
        return Err(perr("a LUT matrix needs three channels"));
    }
    if clut.is_none() && i != o {
        return Err(perr("a LUT without CLUT changes the channel count"));
    }
    let mut elems = vec![];
    let mut push = |e: Option<Elem>| elems.extend(e);
    if ab {
        push(a.map(Elem::Curves));
        push(clut.map(Elem::Clut));
        push(mc.map(Elem::Curves));
        push(m.map(Elem::Matrix));
        push(bc.map(Elem::Curves));
    } else {
        push(bc.map(Elem::Curves));
        push(m.map(Elem::Matrix));
        push(mc.map(Elem::Curves));
        push(clut.map(Elem::Clut));
        push(a.map(Elem::Curves));
    }
    Ok(Pipe { outputs: o, elems, legacy_lab: false })
}

fn read_pipe(b: &[u8], off: usize, lab: bool, a2b: bool) -> Result<Pipe, String> {
    let mut r = Rd::at(b, off);
    let t = r.sig()?;
    match &t {
        b"mft1" | b"mft2" => read_mft(&mut r, &t, lab, a2b),
        b"mAB " | b"mBA " => read_mab(b, off, &t),
        _ => Err(perr(format!("unsupported LUT tag type \"{}\"", String::from_utf8_lossy(&t)))),
    }
}

impl Profile {
    /// Parses ICC bytes (any version); every offset and size is checked against the data.
    pub fn parse(b: &[u8]) -> Result<Profile, String> {
        if b.len() < 132 {
            return Err(perr(format!("too small ({} bytes)", b.len())));
        }
        let mut r = Rd::at(b, 0);
        let size = r.u32()? as usize;
        if size > b.len() {
            return Err(perr(format!("header declares {size} bytes but only {} are present", b.len())));
        }
        let at = |o: usize| Rd::at(b, o);
        let class = at(12).sig()?;
        let space = Space::from_sig(&at(16).sig()?)?;
        let pcs = at(20).sig()?;
        if &at(36).sig()? != b"acsp" {
            return Err(perr("bad signature (expected \"acsp\")"));
        }
        let pcs_lab = match &pcs {
            b"XYZ " => false,
            b"Lab " => true,
            _ => return Err(perr(format!("unsupported PCS \"{}\"", String::from_utf8_lossy(&pcs)))),
        };
        let mut t = at(128);
        let n = t.u32()?;
        if n > 1024 {
            return Err(perr(format!("implausible tag count {n}")));
        }
        let mut tags = std::collections::HashMap::new();
        for _ in 0..n {
            let (sig, off, _len) = (t.sig()?, t.u32()? as usize, t.u32()?);
            if off.checked_add(8).is_none_or(|e| e > b.len()) {
                return Err(perr(format!("tag \"{}\" points past the end of the profile", String::from_utf8_lossy(&sig))));
            }
            tags.insert(sig, off);
        }
        let tag = |s: &[u8; 4]| tags.get(s).copied();
        let xyz = |s: &[u8; 4]| tag(s).map(|o| read_xyz(&mut at(o))).transpose();
        let mut p = Profile { class, pcs_lab, white: None, ..Profile::empty("", space) };
        if let Some(o) = tag(b"desc") {
            p.name = read_text(b, o)?.trim().to_string();
        }
        if p.name.is_empty() {
            p.name = format!("Embedded profile ({})", String::from_utf8_lossy(&at(16).sig()?).trim());
        }
        p.white = xyz(b"wtpt")?;
        p.black = xyz(b"bkpt")?;
        if let Some(o) = tag(b"chad") {
            let mut r = at(o);
            if &r.sig()? != b"sf32" {
                return Err(perr("expected s15Fixed16ArrayType for chad"));
            }
            r.skip(4)?;
            let mut m = [[0.0; 3]; 3];
            for row in m.iter_mut() {
                for v in row.iter_mut() {
                    *v = r.s15()?;
                }
            }
            p.chad = Some(m);
        }
        if let (Some(rx), Some(gx), Some(bx)) = (xyz(b"rXYZ")?, xyz(b"gXYZ")?, xyz(b"bXYZ")?) {
            p.colorants = Some([[rx[0], gx[0], bx[0]], [rx[1], gx[1], bx[1]], [rx[2], gx[2], bx[2]]]);
        }
        if let (Some(rt), Some(gt), Some(bt)) = (tag(b"rTRC"), tag(b"gTRC"), tag(b"bTRC")) {
            p.trc = Some([read_curve(&mut at(rt))?, read_curve(&mut at(gt))?, read_curve(&mut at(bt))?]);
        }
        if let Some(o) = tag(b"kTRC") {
            p.gray_trc = Some(read_curve(&mut at(o))?);
        }
        for i in 0..3 {
            if let Some(o) = tag(&[b'A', b'2', b'B', b'0' + i as u8]) {
                p.a2b[i] = Some(read_pipe(b, o, pcs_lab, true)?);
            }
            if let Some(o) = tag(&[b'B', b'2', b'A', b'0' + i as u8]) {
                p.b2a[i] = Some(read_pipe(b, o, pcs_lab, false)?);
            }
        }
        if let Some(o) = tag(b"gamt") {
            let g = read_pipe(b, o, pcs_lab, false)?;
            if g.outputs != 1 {
                return Err(perr("the gamut tag needs one output"));
            }
            p.gamut = Some(g);
        }
        for (pipes, ins, outs) in [(&p.a2b, space.channels(), 3), (&p.b2a, 3, space.channels())] {
            for pipe in pipes.iter().flatten() {
                let first = pipe.elems.iter().find_map(|e| match e {
                    Elem::Curves(c) => Some(c.len()),
                    Elem::Clut(c) => Some(c.inputs),
                    Elem::Matrix(_) => Some(3),
                });
                if first.is_some_and(|n| n != ins) || pipe.outputs != outs {
                    return Err(perr("a LUT does not match the profile's channels"));
                }
            }
        }
        p.icc_bytes = Some(b.to_vec());
        Ok(p)
    }
}

// ---------- writing ----------

#[cfg(test)]
fn put_sig(v: &mut Vec<u8>, s: &[u8; 4]) {
    v.extend_from_slice(s);
}

/// Test only: sRGB as a printer profile whose 'gamt' tag marks every color darker than white out
/// of gamut (an mft2 grid of 2 giving 1 - encoded Y), so only the tag can flag anything.
#[cfg(test)]
pub(crate) fn gamut_tag_test_profile() -> Vec<u8> {
    let src = Profile::builtin(SRGB).expect("built in").icc().expect("written");
    let n = u32::from_be_bytes(src[128..132].try_into().unwrap()) as usize;
    let mut tags: Vec<([u8; 4], Vec<u8>)> = (0..n)
        .map(|i| {
            let e = &src[132 + 12 * i..144 + 12 * i];
            let (o, l) = (u32::from_be_bytes(e[4..8].try_into().unwrap()) as usize, u32::from_be_bytes(e[8..12].try_into().unwrap()) as usize);
            (e[..4].try_into().unwrap(), src[o..o + l].to_vec())
        })
        .filter(|(s, _)| s != b"desc" && s != b"cprt")
        .collect();
    let mut mft = vec![];
    put_sig(&mut mft, b"mft2");
    mft.extend([0, 0, 0, 0, 3, 1, 2, 0]);
    for v in [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] {
        put_s15(&mut mft, v);
    }
    mft.extend(2u16.to_be_bytes());
    mft.extend(2u16.to_be_bytes());
    for _ in 0..3 {
        mft.extend([0, 0, 0xff, 0xff]);
    }
    for i in 0..8 {
        mft.extend(if (i >> 1) & 1 == 0 { [0xff, 0xff] } else { [0, 0] });
    }
    mft.extend([0, 0, 0xff, 0xff]);
    tags.push((*b"gamt", mft));
    write_profile(b"prtr", b"RGB ", "Gamut tag test", &tags)
}

fn put_s15(v: &mut Vec<u8>, x: f64) {
    v.extend(((x * 65536.0).round() as i32).to_be_bytes());
}

fn xyz_tag(x: [f64; 3]) -> Vec<u8> {
    let mut v = b"XYZ \0\0\0\0".to_vec();
    for c in x {
        put_s15(&mut v, c);
    }
    v
}

fn sf32(m: &M3) -> Vec<u8> {
    let mut v = b"sf32\0\0\0\0".to_vec();
    for c in m.iter().flatten() {
        put_s15(&mut v, *c);
    }
    v
}

fn mluc(text: &str) -> Vec<u8> {
    let s: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_be_bytes()).collect();
    let mut v = b"mluc\0\0\0\0".to_vec();
    for n in [1u32, 12] {
        v.extend(n.to_be_bytes());
    }
    v.extend(b"enUS");
    v.extend((s.len() as u32).to_be_bytes());
    v.extend(28u32.to_be_bytes());
    v.extend(s);
    v
}

fn para(f: u16, p: &[f64]) -> Vec<u8> {
    let mut v = b"para\0\0\0\0".to_vec();
    v.extend(f.to_be_bytes());
    v.extend([0, 0]);
    for &x in p {
        put_s15(&mut v, x);
    }
    v
}

fn curve_tag(c: &Curve) -> Vec<u8> {
    let table = |s: Vec<f64>| {
        let mut v = b"curv\0\0\0\0".to_vec();
        v.extend((s.len() as u32).to_be_bytes());
        for x in s {
            v.extend(((clamp01(x) * 65535.0).round() as u16).to_be_bytes());
        }
        v
    };
    match c {
        Curve::Identity => b"curv\0\0\0\0\0\0\0\0".to_vec(),
        Curve::Gamma(g) => para(0, &[*g]),
        Curve::Srgb => para(3, &[2.4, 1.0 / 1.055, 0.055 / 1.055, 1.0 / 12.92, 0.04045]),
        Curve::Romm => para(3, &[1.8, 1.0, 0.0, 1.0 / 16.0, 16.0 / 512.0]),
        Curve::Rec2020 => para(3, &[1.0 / 0.45, 1.0 / LO, (LO - 1.0) / LO, 1.0 / 4.5, 4.5 * AC]),
        Curve::Param(f, p) => para(*f, &p[..[1, 3, 4, 5, 7][(*f as usize).min(4)]]),
        Curve::Table(s) => table(s.clone()),
        Curve::DotGain(_) => table((0..1024).map(|k| c.eval(k as f64 / 1023.0)).collect()),
    }
}

/// A v4.3 display profile with a `desc` and `cprt` from `name` and the given tags; equal tag
/// data is stored once.
fn write_profile(class: &[u8; 4], space: &[u8; 4], name: &str, tags: &[([u8; 4], Vec<u8>)]) -> Vec<u8> {
    let mut all = vec![(*b"desc", mluc(name)), (*b"cprt", mluc("No copyright, use freely"))];
    all.extend(tags.iter().cloned());
    let mut table = vec![];
    let mut data: Vec<u8> = vec![];
    let base = 128 + 4 + 12 * all.len();
    let mut seen: Vec<(usize, usize)> = vec![];
    for (sig, d) in &all {
        let off = match seen.iter().find(|&&(o, l)| &data[o..o + l] == d.as_slice()) {
            Some(&(o, _)) => o,
            None => {
                let o = data.len();
                data.extend(d);
                data.resize(data.len().div_ceil(4) * 4, 0);
                seen.push((o, d.len()));
                o
            }
        };
        table.push((*sig, (base + off) as u32, d.len() as u32));
    }
    let total = base + data.len();
    let mut v = Vec::with_capacity(total);
    v.extend((total as u32).to_be_bytes());
    v.extend([0; 4]);
    v.extend(0x0430_0000u32.to_be_bytes());
    v.extend(class);
    v.extend(space);
    v.extend(b"XYZ ");
    for n in [2026u16, 1, 1, 0, 0, 0] {
        v.extend(n.to_be_bytes());
    }
    v.extend(b"acsp");
    v.extend([0; 24]);
    v.extend(0u32.to_be_bytes());
    for c in D50 {
        put_s15(&mut v, c);
    }
    v.resize(128, 0);
    v.extend((all.len() as u32).to_be_bytes());
    for (s, o, l) in table {
        v.extend(s);
        v.extend(o.to_be_bytes());
        v.extend(l.to_be_bytes());
    }
    v.extend(data);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(t: &Transform, i: &[f64]) -> Vec<f64> {
        let mut o = vec![0.0; t.outputs];
        t.apply(i, &mut o);
        o
    }

    fn close(a: &[f64], b: &[f64], tol: f64) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() <= tol)
    }

    fn rel(src: &Profile, dst: &Profile) -> Transform {
        Transform::new(src, dst, Intent::Relative, false).unwrap()
    }

    #[test]
    fn srgb_red_in_adobe_rgb_and_identity() {
        let s = Profile::builtin(SRGB).unwrap();
        let a = Profile::builtin("Adobe RGB (1998)").unwrap();
        let red = run(&rel(&s, &a), &[1.0, 0.0, 0.0]);
        assert!(close(&red, &[219.0 / 255.0, 0.0, 0.0], 1.0 / 255.0), "{red:?}");
        let id = rel(&s, &s);
        for c in [[0.1, 0.5, 0.9], [0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.73, 0.2, 0.04]] {
            assert!(close(&run(&id, &c), &c, 1e-6));
        }
        let back = run(&rel(&a, &s), &run(&rel(&s, &a), &[0.3, 0.6, 0.2]));
        assert!(close(&back, &[0.3, 0.6, 0.2], 1e-6), "{back:?}");
    }

    #[test]
    fn gray_dot_gain_and_lab() {
        let dg = Profile::builtin("Dot Gain 20%").unwrap();
        let g22 = Profile::builtin("Gray Gamma 2.2").unwrap();
        let v = run(&rel(&dg, &g22), &[0.5]);
        assert!(close(&v, &[0.3f64.powf(1.0 / 2.2)], 1e-4), "{v:?}");
        let back = run(&rel(&g22, &dg), &v);
        assert!(close(&back, &[0.5], 1e-3), "{back:?}");
        let lab = Profile::builtin(LAB).unwrap();
        let s = Profile::builtin(SRGB).unwrap();
        assert!(close(&run(&rel(&s, &lab), &[1.0, 1.0, 1.0]), &[1.0, 128.0 / 255.0, 128.0 / 255.0], 1e-4));
        let gray_white = run(&rel(&s, &g22), &[1.0, 1.0, 1.0]);
        assert!(close(&gray_white, &[1.0], 1e-6));
    }

    #[test]
    fn written_profiles_parse_back_to_the_same_transform() {
        let s = Profile::builtin(SRGB).unwrap();
        for name in builtin_names() {
            let b = Profile::builtin(name).unwrap();
            let Some(bytes) = b.icc() else {
                assert!(matches!(b.space, Space::Lab | Space::Cmyk), "{name} has no ICC form");
                continue;
            };
            let p = Profile::parse(&bytes).unwrap();
            assert_eq!(p.name, *name);
            assert_eq!(p.space, b.space);
            let dst = if b.space == Space::Gray { Profile::builtin("Gray Gamma 2.2").unwrap() } else { s.clone() };
            let (t1, t2) = (rel(&b, &dst), rel(&p, &dst));
            for c in [0.0, 0.02, 0.2, 0.5, 0.81, 1.0] {
                let i = vec![c, 1.0 - c, c * 0.5][..b.channels()].to_vec();
                // 16.16 fixed-point colorants shift the steep dark toe by a few 1e-4.
                assert!(close(&run(&t1, &i), &run(&t2, &i), 1e-3), "{name} {c}: {:?} vs {:?}", run(&t1, &i), run(&t2, &i));
            }
            let abs = |p: &Profile| run(&Transform::new(p, &dst, Intent::Absolute, false).unwrap(), &vec![1.0; p.channels()]);
            assert!(close(&abs(&b), &abs(&p), 1e-3), "{name} media white");
        }
    }

    #[test]
    fn absolute_intent_keeps_the_media_white() {
        let s = Profile::builtin(SRGB).unwrap();
        let pp = Profile::builtin("ProPhoto RGB").unwrap();
        assert!(close(&run(&rel(&s, &pp), &[1.0; 3]), &[1.0; 3], 1e-6));
        let w = run(&Transform::new(&s, &pp, Intent::Absolute, false).unwrap(), &[0.5; 3]);
        assert!(w[2] > w[0] + 0.02, "D65 white is bluer than D50 white: {w:?}");
    }

    // A v4 RGB profile whose A2B0 is an mAB (identity curves, the matrix, B curves) and one whose
    // A2B0 is an mft2 CLUT sampling the same linear device: both match the matrix/TRC transform.
    #[test]
    fn lut_profiles_match_the_matrix_profile() {
        let lin = Profile::rgb("Linear sRGB", [[0.64, 0.33], [0.3, 0.6], [0.15, 0.06]], D65, Curve::Gamma(1.0));
        let m = lin.colorants.unwrap();
        let s = Profile::builtin(SRGB).unwrap();
        let reference = rel(&lin, &s);

        let mut mab = vec![];
        put_sig(&mut mab, b"mAB ");
        mab.extend([0, 0, 0, 0, 3, 3, 0, 0]);
        let at = mab.len();
        mab.extend([0u8; 20]);
        let b_off = mab.len() as u32;
        for _ in 0..3 {
            put_sig(&mut mab, b"curv");
            mab.extend([0u8; 8]);
        }
        let mat_off = mab.len() as u32;
        for v in [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2], 0.0, 0.0, 0.0] {
            put_s15(&mut mab, v / XYZ_ENC);
        }
        let m_off = mab.len() as u32;
        for _ in 0..3 {
            put_sig(&mut mab, b"curv");
            mab.extend([0u8; 8]);
        }
        for (i, o) in [b_off, mat_off, m_off, 0, 0].iter().enumerate() {
            mab[at + i * 4..at + i * 4 + 4].copy_from_slice(&o.to_be_bytes());
        }

        let mut mft = vec![];
        put_sig(&mut mft, b"mft2");
        mft.extend([0, 0, 0, 0, 3, 3, 2, 0]);
        for v in [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0] {
            put_s15(&mut mft, v);
        }
        mft.extend(2u16.to_be_bytes());
        mft.extend(2u16.to_be_bytes());
        for _ in 0..3 {
            mft.extend([0, 0, 0xff, 0xff]);
        }
        for i in 0..8 {
            let rgb = [(i >> 2) & 1, (i >> 1) & 1, i & 1].map(|v| v as f64);
            for row in m {
                let xyz = row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2];
                mft.extend(((xyz / XYZ_ENC * 65535.0).round() as u16).to_be_bytes());
            }
        }
        for _ in 0..3 {
            mft.extend([0, 0, 0xff, 0xff]);
        }

        for (tag, what) in [(mab, "mAB"), (mft, "mft2")] {
            let bytes = write_profile(b"mntr", b"RGB ", "LUT", &[(*b"wtpt", xyz_tag(D50)), (*b"A2B0", tag)]);
            let p = Profile::parse(&bytes).unwrap();
            let t = rel(&p, &s);
            for c in [[0.2, 0.4, 0.6], [1.0, 1.0, 1.0], [0.9, 0.1, 0.0], [0.0, 0.0, 0.0]] {
                assert!(close(&run(&t, &c), &run(&reference, &c), 2e-4), "{what} {c:?}: {:?} vs {:?}", run(&t, &c), run(&reference, &c));
            }
        }
    }

    #[test]
    fn broken_profiles_are_errors_not_panics() {
        assert!(Profile::parse(&[]).is_err());
        assert!(Profile::parse(&[0; 200]).is_err(), "no acsp signature");
        let good = Profile::builtin("Adobe RGB (1998)").unwrap().icc().unwrap();
        for n in 0..good.len() {
            let _ = Profile::parse(&good[..n]);
        }
        let mut bad = good.clone();
        bad[136..140].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(Profile::parse(&bad).is_err(), "tag past the end");
        let mut huge = good.clone();
        huge[128..132].copy_from_slice(&5000u32.to_be_bytes());
        assert!(Profile::parse(&huge).is_err(), "implausible tag count");
    }

    #[test]
    fn black_point_compensation_maps_black_to_black() {
        // A gray profile whose black is 20% gray: with BPC its black lands on the destination's black.
        let mut lifted = Profile::builtin("Gray Gamma 2.2").unwrap();
        lifted.gray_trc = Some(Curve::Param(1, [1.0, 0.8, 0.2, 0.0, 0.0, 0.0, 0.0]));
        lifted.icc_bytes = None;
        let g = Profile::builtin("Gray Gamma 2.2").unwrap();
        let without = run(&rel(&lifted, &g), &[0.0]);
        let with = run(&Transform::new(&lifted, &g, Intent::Relative, true).unwrap(), &[0.0]);
        assert!(without[0] > 0.3, "{without:?}");
        assert!(with[0].abs() < 1e-3, "{with:?}");
    }

    #[test]
    fn display_lut_matches_the_exact_transform() {
        let a = Profile::builtin("Adobe RGB (1998)").unwrap();
        let s = Profile::builtin(SRGB).unwrap();
        let t = rel(&a, &s);
        let lut = Lut::new(&t, 33);
        for c in [[0.2f32, 0.4, 0.6], [1.0, 0.0, 0.0], [0.05, 0.95, 0.5]] {
            let exact = run(&t, &c.map(|v| v as f64));
            let got = lut.apply(c);
            assert!(close(&got.map(|v| v as f64), &exact, 2.0 / 255.0), "{c:?}: {got:?} vs {exact:?}");
        }
    }
}

