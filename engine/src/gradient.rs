//! Gradient render op (B6 spec v1 Part E3): stop/opacity-stop normalization, the midpoint remap,
//! three colour interpolation methods (classic/linear sRGB, perceptual OKLab), a 1024-entry LUT,
//! five style `t` formulas sampled at pixel centres, reverse, and an 8x8 Bayer dither on RGB.

pub const LUT_SIZE: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ColorStop {
    pub position: f32,
    pub rgb: [f32; 3],
    pub midpoint: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OpacityStop {
    pub position: f32,
    pub opacity: f32,
    pub midpoint: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    Classic,
    Linear,
    Perceptual,
}

impl Method {
    pub fn parse(s: &str) -> Result<Method, String> {
        match s {
            "classic" => Ok(Method::Classic),
            "linear" => Ok(Method::Linear),
            "perceptual" => Ok(Method::Perceptual),
            other => Err(format!("unknown gradient method {other}")),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Style {
    Linear,
    Radial,
    Angle,
    Reflected,
    Diamond,
}

impl Style {
    pub fn parse(s: &str) -> Result<Style, String> {
        match s {
            "linear" => Ok(Style::Linear),
            "radial" => Ok(Style::Radial),
            "angle" => Ok(Style::Angle),
            "reflected" => Ok(Style::Reflected),
            "diamond" => Ok(Style::Diamond),
            other => Err(format!("unknown gradient style {other}")),
        }
    }
}

/// Clamps positions/midpoints, sorts by position, and applies the 0/1-stop defaults (B6 spec v1
/// Part E3). `to_default` builds the fallback color/opacity at 0 and 1 when there are no stops.
fn normalize<T: Copy>(
    mut stops: Vec<T>,
    pos: impl Fn(&T) -> f32,
    set_pos: impl Fn(&mut T, f32),
    set_mid: impl Fn(&mut T, f32),
    mid: impl Fn(&T) -> f32,
    make: impl Fn(f32) -> T,
) -> Vec<T> {
    for s in stops.iter_mut() {
        set_pos(s, pos(s).clamp(0.0, 1.0));
        set_mid(s, mid(s).clamp(0.001, 0.999));
    }
    stops.sort_by(|a, b| pos(a).partial_cmp(&pos(b)).unwrap());
    match stops.len() {
        0 => vec![make(0.0), make(1.0)],
        1 => {
            let mut dup = stops[0];
            set_pos(&mut dup, 1.0);
            vec![stops[0], dup]
        }
        _ => stops,
    }
}

pub fn normalize_color_stops(stops: Vec<ColorStop>) -> Vec<ColorStop> {
    normalize(
        stops,
        |s| s.position,
        |s, v| s.position = v,
        |s, v| s.midpoint = v,
        |s| s.midpoint,
        |p| ColorStop { position: p, rgb: [0.0; 3], midpoint: 0.5 },
    )
}

pub fn normalize_opacity_stops(stops: Vec<OpacityStop>) -> Vec<OpacityStop> {
    normalize(
        stops,
        |s| s.position,
        |s, v| s.position = v,
        |s, v| s.midpoint = v,
        |s| s.midpoint,
        |p| OpacityStop { position: p, opacity: 1.0, midpoint: 0.5 },
    )
}

/// `p -> 1 - p`, stop order reversed; segment `j`'s midpoint (the one that governs the interval
/// between the new stops `j` and `j+1`) takes over the old segment feeding it in reverse, so it is
/// `1 - ` the old midpoint two stops further along (B6 spec v1 Part E3 "Reverse").
fn reverse_positions_and_midpoints<T: Copy>(
    stops: &[T],
    pos: impl Fn(&T) -> f32,
    mid: impl Fn(&T) -> f32,
) -> (Vec<f32>, Vec<f32>) {
    let n = stops.len();
    let new_pos: Vec<f32> = (0..n).map(|j| 1.0 - pos(&stops[n - 1 - j])).collect();
    let new_mid: Vec<f32> =
        (0..n).map(|j| if j + 2 <= n { 1.0 - mid(&stops[n - 2 - j]) } else { 0.5 }).collect();
    (new_pos, new_mid)
}

pub fn reverse_color_stops(stops: &[ColorStop]) -> Vec<ColorStop> {
    let n = stops.len();
    let (pos, mid) = reverse_positions_and_midpoints(stops, |s| s.position, |s| s.midpoint);
    (0..n).map(|j| ColorStop { position: pos[j], rgb: stops[n - 1 - j].rgb, midpoint: mid[j] }).collect()
}

pub fn reverse_opacity_stops(stops: &[OpacityStop]) -> Vec<OpacityStop> {
    let n = stops.len();
    let (pos, mid) = reverse_positions_and_midpoints(stops, |s| s.position, |s| s.midpoint);
    (0..n).map(|j| OpacityStop { position: pos[j], opacity: stops[n - 1 - j].opacity, midpoint: mid[j] }).collect()
}

/// Local segment parameter remapped by the left stop's midpoint (B6 spec v1 Part E3): `u' = u^k`,
/// `k = ln 0.5 / ln m` (`m = 0.5` is the identity).
fn midpoint_remap(u: f32, m: f32) -> f32 {
    if (m - 0.5).abs() < 1e-9 {
        return u;
    }
    let k = 0.5f32.ln() / m.ln();
    u.clamp(0.0, 1.0).powf(k)
}

pub(crate) fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

pub(crate) fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.0031308 {
        12.92 * c
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

/// An encoded value scaled by `gain` in linear light (32-bit Intensity, as exposure stops).
pub(crate) fn exposed(c: f32, gain: f32) -> f32 {
    linear_to_srgb(srgb_to_linear(c) * gain)
}

/// Extended Reinhard in linear light with white = `max` (both encoded): `max` maps to 1
/// (32-bit Highlight Compression).
pub(crate) fn compress_highlight(v: f32, max: f32) -> f32 {
    let (l, w) = (srgb_to_linear(v.max(0.0)), srgb_to_linear(max));
    linear_to_srgb(l * (1.0 + l / (w * w)) / (1.0 + l)).min(1.0)
}

fn oklab_from_linear(rgb: [f32; 3]) -> [f32; 3] {
    let [r, g, b] = rgb;
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    let (l, m, s) = (l.cbrt(), m.cbrt(), s.cbrt());
    [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ]
}

fn linear_from_oklab(lab: [f32; 3]) -> [f32; 3] {
    let [l, a, b] = lab;
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    let (l3, m3, s3) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
    [
        4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
        -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
        -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
    ]
}

/// Interpolates between two encoded-sRGB colours at local `u` (already midpoint-remapped), per
/// method (B6 spec v1 Part E3).
fn mix_colors(a: [f32; 3], b: [f32; 3], u: f32, method: Method) -> [f32; 3] {
    match method {
        Method::Classic => std::array::from_fn(|i| a[i] + (b[i] - a[i]) * u),
        Method::Linear => {
            let (la, lb) = (a.map(srgb_to_linear), b.map(srgb_to_linear));
            let mixed: [f32; 3] = std::array::from_fn(|i| la[i] + (lb[i] - la[i]) * u);
            mixed.map(linear_to_srgb)
        }
        Method::Perceptual => {
            let (oa, ob) = (oklab_from_linear(a.map(srgb_to_linear)), oklab_from_linear(b.map(srgb_to_linear)));
            let mixed: [f32; 3] = std::array::from_fn(|i| oa[i] + (ob[i] - oa[i]) * u);
            linear_from_oklab(mixed).map(|c| linear_to_srgb(c.clamp(0.0, 1.0)))
        }
    }
}

/// The gradient's colour at `t` (0..1), held constant before the first and after the last stop.
fn color_at(stops: &[ColorStop], t: f32, method: Method) -> [f32; 3] {
    if t <= stops[0].position {
        return stops[0].rgb;
    }
    let last = stops.len() - 1;
    if t >= stops[last].position {
        return stops[last].rgb;
    }
    for i in 0..last {
        let (p0, p1) = (stops[i].position, stops[i + 1].position);
        if t >= p0 && t <= p1 {
            let u = if p1 > p0 { (t - p0) / (p1 - p0) } else { 0.0 };
            return mix_colors(stops[i].rgb, stops[i + 1].rgb, midpoint_remap(u, stops[i].midpoint), method);
        }
    }
    stops[last].rgb
}

/// Opacity always interpolates linearly, with the same midpoint remap.
fn opacity_at(stops: &[OpacityStop], t: f32) -> f32 {
    if t <= stops[0].position {
        return stops[0].opacity;
    }
    let last = stops.len() - 1;
    if t >= stops[last].position {
        return stops[last].opacity;
    }
    for i in 0..last {
        let (p0, p1) = (stops[i].position, stops[i + 1].position);
        if t >= p0 && t <= p1 {
            let u = if p1 > p0 { (t - p0) / (p1 - p0) } else { 0.0 };
            let u = midpoint_remap(u, stops[i].midpoint);
            return stops[i].opacity + (stops[i + 1].opacity - stops[i].opacity) * u;
        }
    }
    stops[last].opacity
}

/// A 1024-entry LUT (`t_i = i/1023`), rgb + alpha (B6 spec v1 Part E3).
pub fn build_lut(color_stops: &[ColorStop], opacity_stops: &[OpacityStop], method: Method) -> Vec<[f32; 4]> {
    (0..LUT_SIZE)
        .map(|i| {
            let t = i as f32 / (LUT_SIZE - 1) as f32;
            let [r, g, b] = color_at(color_stops, t, method);
            [r, g, b, opacity_at(opacity_stops, t)]
        })
        .collect()
}

/// `n` colours sampled at `t_i = i/(n-1)`, without opacity.
pub fn color_table(color_stops: &[ColorStop], method: Method, n: usize) -> Vec<[f32; 3]> {
    (0..n).map(|i| color_at(color_stops, i as f32 / (n - 1) as f32, method)).collect()
}

/// Linear interpolation between the LUT's neighbouring entries at `t` (0..1).
pub fn lut_lookup(lut: &[[f32; 4]], t: f32) -> [f32; 4] {
    let t = t.clamp(0.0, 1.0) * (LUT_SIZE - 1) as f32;
    let i0 = t.floor() as usize;
    let i1 = (i0 + 1).min(LUT_SIZE - 1);
    let frac = t - i0 as f32;
    std::array::from_fn(|c| lut[i0][c] + (lut[i1][c] - lut[i0][c]) * frac)
}

/// The style `t` formula sampled at a pixel centre (B6 spec v1 Part E3): `(px, py)` is the pixel
/// centre minus `start`, `(dx, dy) = end - start`, `l2 = dx*dx + dy*dy`.
pub fn style_t(style: Style, px: f64, py: f64, dx: f64, dy: f64, l2: f64) -> f32 {
    let raw = match style {
        Style::Angle => {
            let a = (-py).atan2(px) - (-dy).atan2(dx);
            let two_pi = std::f64::consts::TAU;
            (a.rem_euclid(two_pi)) / two_pi
        }
        _ if l2 <= 0.0 => 0.0,
        Style::Linear => (px * dx + py * dy) / l2,
        Style::Reflected => ((px * dx + py * dy) / l2).abs(),
        Style::Radial => (px * px + py * py).sqrt() / l2.sqrt(),
        Style::Diamond => ((px * dx + py * dy) / l2).abs() + ((-px * dy + py * dx) / l2).abs(),
    };
    raw.clamp(0.0, 1.0) as f32
}

/// Standard 8x8 ordered (Bayer) dither matrix, values 0..63.
const BAYER8: [[u8; 8]; 8] = [
    [0, 32, 8, 40, 2, 34, 10, 42],
    [48, 16, 56, 24, 50, 18, 58, 26],
    [12, 44, 4, 36, 14, 46, 6, 38],
    [60, 28, 52, 20, 62, 30, 54, 22],
    [3, 35, 11, 43, 1, 33, 9, 41],
    [51, 19, 59, 27, 49, 17, 57, 25],
    [15, 47, 7, 39, 13, 45, 5, 37],
    [63, 31, 55, 23, 61, 29, 53, 21],
];

/// `B(x, y)` in 8-bit units (B6 spec v1 Part E3), range roughly [-0.492, 0.492].
pub fn bayer(x: i32, y: i32) -> f32 {
    let m = BAYER8[(y.rem_euclid(8)) as usize][(x.rem_euclid(8)) as usize] as f32;
    m / 64.0 - 0.5 + 1.0 / 128.0
}

/// The dither delta in 0..1 colour units (levels = 255), added to R, G, B only.
pub fn dither_delta(x: i32, y: i32) -> f32 {
    bayer(x, y) / 255.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cs(position: f32, rgb: [f32; 3]) -> ColorStop {
        ColorStop { position, rgb, midpoint: 0.5 }
    }

    #[test]
    fn normalize_defaults_0_and_1_stops() {
        let none = normalize_color_stops(vec![]);
        assert_eq!(none, vec![cs(0.0, [0.0; 3]), cs(1.0, [0.0; 3])]);
        let one = normalize_color_stops(vec![cs(0.3, [1.0, 0.0, 0.0])]);
        assert_eq!(one, vec![cs(0.3, [1.0, 0.0, 0.0]), cs(1.0, [1.0, 0.0, 0.0])]);
    }

    #[test]
    fn normalize_clamps_and_sorts() {
        let got = normalize_color_stops(vec![cs(1.5, [1.0; 3]), cs(-0.2, [0.0; 3])]);
        assert_eq!(got[0].position, 0.0);
        assert_eq!(got[1].position, 1.0);
    }

    #[test]
    fn classic_interpolation_is_a_straight_lerp() {
        let stops = vec![cs(0.0, [0.0, 0.0, 0.0]), cs(1.0, [1.0, 1.0, 1.0])];
        let c = color_at(&stops, 0.25, Method::Classic);
        assert!((c[0] - 0.25).abs() < 1e-6);
    }

    #[test]
    fn linear_method_brightens_the_midpoint_relative_to_classic() {
        let stops = vec![cs(0.0, [0.0; 3]), cs(1.0, [1.0; 3])];
        let classic = color_at(&stops, 0.5, Method::Classic)[0];
        let linear = color_at(&stops, 0.5, Method::Linear)[0];
        assert!((classic - 0.5).abs() < 1e-6);
        assert!(linear > classic, "linear-light mixing of black/white is brighter at the midpoint");
    }

    #[test]
    fn midpoint_0_25_moves_the_50pct_point() {
        let mut stops = vec![cs(0.0, [0.0; 3]), cs(1.0, [1.0; 3])];
        stops[0].midpoint = 0.25;
        let c = color_at(&stops, 0.25, Method::Classic);
        assert!((c[0] - 0.5).abs() < 1e-5, "t=0.25 is now the 50% point: {c:?}");
    }

    #[test]
    fn reverse_flips_positions_and_the_two_stop_midpoint() {
        let mut stops = vec![cs(0.0, [1.0, 0.0, 0.0]), cs(1.0, [0.0, 0.0, 1.0])];
        stops[0].midpoint = 0.25;
        let rev = reverse_color_stops(&stops);
        assert_eq!(rev[0].position, 0.0);
        assert_eq!(rev[0].rgb, [0.0, 0.0, 1.0]);
        assert_eq!(rev[1].rgb, [1.0, 0.0, 0.0]);
        assert!((rev[0].midpoint - 0.75).abs() < 1e-6, "1 - 0.25");
    }

    #[test]
    fn reverse_uses_the_spec_rule_for_three_stops() {
        // "p -> 1 - p, stop order reversed, new midpoint of stop i = 1 - old midpoint of
        // stop i-1 (default .5)" (B6 spec v1 Part E3 "Reverse").
        let mut stops = vec![cs(0.0, [1.0, 0.0, 0.0]), cs(0.5, [0.0, 1.0, 0.0]), cs(1.0, [0.0, 0.0, 1.0])];
        stops[0].midpoint = 0.3;
        stops[1].midpoint = 0.8;
        let rev = reverse_color_stops(&stops);
        assert_eq!(rev.iter().map(|s| s.position).collect::<Vec<_>>(), vec![0.0, 0.5, 1.0]);
        assert_eq!(rev[0].rgb, [0.0, 0.0, 1.0]);
        assert_eq!(rev[1].rgb, [0.0, 1.0, 0.0]);
        assert_eq!(rev[2].rgb, [1.0, 0.0, 0.0]);
        assert!((rev[0].midpoint - 0.2).abs() < 1e-6, "1 - the old stop 1 midpoint (0.8)");
        assert!((rev[1].midpoint - 0.7).abs() < 1e-6, "1 - the old stop 0 midpoint (0.3)");
        assert!((rev[2].midpoint - 0.5).abs() < 1e-6, "the last stop's midpoint is unused, default .5");
    }

    #[test]
    fn lut_round_trips_the_stop_colours_at_their_positions() {
        let stops = normalize_color_stops(vec![cs(0.0, [0.0; 3]), cs(1.0, [1.0, 1.0, 1.0])]);
        let ops = normalize_opacity_stops(vec![]);
        let lut = build_lut(&stops, &ops, Method::Classic);
        assert_eq!(lut[0], [0.0, 0.0, 0.0, 1.0]);
        assert_eq!(lut[LUT_SIZE - 1], [1.0, 1.0, 1.0, 1.0]);
        let mid = lut_lookup(&lut, 0.5);
        assert!((mid[0] - 0.5).abs() < 0.01);
    }

    #[test]
    fn style_t_matches_the_five_formulas() {
        // start=(0,0), end=(10,0): dx=10, dy=0, l2=100.
        assert!((style_t(Style::Linear, 5.0, 0.0, 10.0, 0.0, 100.0) - 0.5).abs() < 1e-6);
        assert!((style_t(Style::Reflected, -5.0, 0.0, 10.0, 0.0, 100.0) - 0.5).abs() < 1e-6);
        assert!((style_t(Style::Radial, 6.0, 8.0, 10.0, 0.0, 100.0) - 1.0).abs() < 1e-6, "|p|=10, L=10");
        assert!((style_t(Style::Diamond, 5.0, 5.0, 10.0, 0.0, 100.0) - 1.0).abs() < 1e-6, "0.5 + 0.5");
        assert_eq!(style_t(Style::Linear, 0.0, 0.0, 0.0, 0.0, 0.0), 0.0, "degenerate L is t=0 except angle");
        assert_eq!(style_t(Style::Angle, 5.0, 0.0, 10.0, 0.0, 100.0), 0.0, "along the axis");
        assert!((style_t(Style::Angle, 0.0, -5.0, 10.0, 0.0, 100.0) - 0.25).abs() < 1e-6, "90 degrees ccw on screen");
    }

    #[test]
    fn bayer_matches_the_first_row_and_stays_in_range() {
        assert_eq!(BAYER8[0][..4], [0, 32, 8, 40]);
        for y in 0..8 {
            for x in 0..8 {
                let b = bayer(x, y);
                assert!((-0.5..=0.5).contains(&b), "{b}");
            }
        }
        assert!((bayer(0, 0) - (0.0 / 64.0 - 0.5 + 1.0 / 128.0)).abs() < 1e-6);
    }
}
