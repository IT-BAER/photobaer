// Blend modes per docs/M1.md section 3 (W3C Compositing and Blending Level 1 for the
// non-separable helpers). Colors are straight (unpremultiplied) in 0..1.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Blend {
    Normal,
    Dissolve,
    Darken,
    Multiply,
    ColorBurn,
    LinearBurn,
    DarkerColor,
    Lighten,
    Screen,
    ColorDodge,
    LinearDodge,
    LighterColor,
    Overlay,
    SoftLight,
    HardLight,
    VividLight,
    LinearLight,
    PinLight,
    HardMix,
    Difference,
    Exclusion,
    Subtract,
    Divide,
    Hue,
    Saturation,
    Color,
    Luminosity,
    PassThrough,
}

/// The ag-psd blend mode strings, in spec order. `pass through` is groups only.
pub const BLEND_NAMES: [(Blend, &str); 28] = [
    (Blend::Normal, "normal"),
    (Blend::Dissolve, "dissolve"),
    (Blend::Darken, "darken"),
    (Blend::Multiply, "multiply"),
    (Blend::ColorBurn, "color burn"),
    (Blend::LinearBurn, "linear burn"),
    (Blend::DarkerColor, "darker color"),
    (Blend::Lighten, "lighten"),
    (Blend::Screen, "screen"),
    (Blend::ColorDodge, "color dodge"),
    (Blend::LinearDodge, "linear dodge"),
    (Blend::LighterColor, "lighter color"),
    (Blend::Overlay, "overlay"),
    (Blend::SoftLight, "soft light"),
    (Blend::HardLight, "hard light"),
    (Blend::VividLight, "vivid light"),
    (Blend::LinearLight, "linear light"),
    (Blend::PinLight, "pin light"),
    (Blend::HardMix, "hard mix"),
    (Blend::Difference, "difference"),
    (Blend::Exclusion, "exclusion"),
    (Blend::Subtract, "subtract"),
    (Blend::Divide, "divide"),
    (Blend::Hue, "hue"),
    (Blend::Saturation, "saturation"),
    (Blend::Color, "color"),
    (Blend::Luminosity, "luminosity"),
    (Blend::PassThrough, "pass through"),
];

impl Blend {
    pub fn parse(s: &str) -> Result<Blend, String> {
        BLEND_NAMES
            .iter()
            .find(|(_, n)| *n == s)
            .map(|(b, _)| *b)
            .ok_or_else(|| format!("unknown blend mode {s}"))
    }

    pub fn name(self) -> &'static str {
        BLEND_NAMES.iter().find(|(b, _)| *b == self).expect("every mode has a name").1
    }

    /// True when the result is `Cs` and the backdrop can be ignored.
    pub fn is_passthrough_of_source(self) -> bool {
        matches!(self, Blend::Normal | Blend::Dissolve | Blend::PassThrough)
    }
}

fn multiply(cb: f32, cs: f32) -> f32 {
    cb * cs
}

fn screen(cb: f32, cs: f32) -> f32 {
    cb + cs - cb * cs
}

const EPS: f32 = 1e-5;

fn color_dodge(cb: f32, cs: f32) -> f32 {
    if cb <= EPS {
        0.0
    } else if cs >= 1.0 - EPS {
        1.0
    } else {
        (cb / (1.0 - cs)).min(1.0)
    }
}

fn color_burn(cb: f32, cs: f32) -> f32 {
    if cb >= 1.0 - EPS {
        1.0
    } else if cs <= EPS {
        0.0
    } else {
        1.0 - ((1.0 - cb) / cs).min(1.0)
    }
}

fn hard_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        multiply(cb, 2.0 * cs)
    } else {
        screen(cb, 2.0 * cs - 1.0)
    }
}

fn soft_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
    } else {
        let d = if cb <= 0.25 { ((16.0 * cb - 12.0) * cb + 4.0) * cb } else { cb.sqrt() };
        cb + (2.0 * cs - 1.0) * (d - cb)
    }
}

fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn clip_color(mut c: [f32; 3]) -> [f32; 3] {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    if n < 0.0 {
        for v in c.iter_mut() {
            *v = l + (*v - l) * l / (l - n);
        }
    }
    if x > 1.0 {
        for v in c.iter_mut() {
            *v = l + (*v - l) * (1.0 - l) / (x - l);
        }
    }
    c
}

fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color([c[0] + d, c[1] + d, c[2] + d])
}

fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

fn set_sat(mut c: [f32; 3], s: f32) -> [f32; 3] {
    // Indices of the smallest, middle and largest channel.
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|&a, &b| c[a].partial_cmp(&c[b]).unwrap_or(std::cmp::Ordering::Equal));
    let (lo, mid, hi) = (idx[0], idx[1], idx[2]);
    if c[hi] > c[lo] {
        c[mid] = (c[mid] - c[lo]) * s / (c[hi] - c[lo]);
        c[hi] = s;
    } else {
        c[mid] = 0.0;
        c[hi] = 0.0;
    }
    c[lo] = 0.0;
    c
}

/// `B(Cb, Cs)` for one pixel, clamped to 0..1.
pub fn blend_rgb(mode: Blend, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    let per = |f: fn(f32, f32) -> f32| [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])];
    let out = match mode {
        Blend::Normal | Blend::Dissolve | Blend::PassThrough => cs,
        Blend::Multiply => per(multiply),
        Blend::Screen => per(screen),
        Blend::Overlay => per(|cb, cs| hard_light(cs, cb)),
        Blend::Darken => per(|cb, cs| cb.min(cs)),
        Blend::Lighten => per(|cb, cs| cb.max(cs)),
        Blend::ColorDodge => per(color_dodge),
        Blend::ColorBurn => per(color_burn),
        Blend::HardLight => per(hard_light),
        Blend::SoftLight => per(soft_light),
        Blend::Difference => per(|cb, cs| (cb - cs).abs()),
        Blend::Exclusion => per(|cb, cs| cb + cs - 2.0 * cb * cs),
        Blend::LinearBurn => per(|cb, cs| cb + cs - 1.0),
        Blend::LinearDodge => per(|cb, cs| cb + cs),
        Blend::VividLight => per(|cb, cs| {
            if cs <= EPS {
                0.0
            } else if cs <= 0.5 {
                1.0 - ((1.0 - cb) / (2.0 * cs)).min(1.0)
            } else if cs >= 1.0 - EPS {
                1.0
            } else {
                (cb / (2.0 * (1.0 - cs))).min(1.0)
            }
        }),
        Blend::LinearLight => per(|cb, cs| cb + 2.0 * cs - 1.0),
        Blend::PinLight => per(|cb, cs| if cs <= 0.5 { cb.min(2.0 * cs) } else { cb.max(2.0 * cs - 1.0) }),
        Blend::HardMix => per(|cb, cs| if (cs <= 0.5 && cb + cs >= 1.0 - EPS) || cb + cs > 1.0 + EPS { 1.0 } else { 0.0 }),
        Blend::Subtract => per(|cb, cs| cb - cs),
        Blend::Divide => per(|cb, cs| if cs <= 0.0 { if cb <= 0.0 { 0.0 } else { 1.0 } } else { (cb / cs).min(1.0) }),
        Blend::DarkerColor => {
            if lum(cs) < lum(cb) {
                cs
            } else {
                cb
            }
        }
        Blend::LighterColor => {
            if lum(cs) > lum(cb) {
                cs
            } else {
                cb
            }
        }
        Blend::Hue => set_lum(set_sat(cs, sat(cb)), lum(cb)),
        Blend::Saturation => set_lum(set_sat(cb, sat(cs)), lum(cb)),
        Blend::Color => set_lum(cs, lum(cb)),
        Blend::Luminosity => set_lum(cb, lum(cs)),
    };
    [out[0].clamp(0.0, 1.0), out[1].clamp(0.0, 1.0), out[2].clamp(0.0, 1.0)]
}

/// Deterministic per document pixel and node, in 0..1. Used by `dissolve`.
pub fn dissolve_hash(x: u32, y: u32, node_id: u32) -> f32 {
    let mut h = x
        .wrapping_mul(0x9E37_79B1)
        ^ y.wrapping_mul(0x85EB_CA77)
        ^ node_id.wrapping_mul(0xC2B2_AE3D);
    h ^= h >> 15;
    h = h.wrapping_mul(0x2545_F491);
    h ^= h >> 13;
    h = h.wrapping_mul(0x2722_0A95);
    h ^= h >> 16;
    (h >> 8) as f32 / (1u32 << 24) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    const CB: [f32; 3] = [0.6, 0.4, 0.2];
    const CS: [f32; 3] = [0.2, 0.8, 0.5];

    fn close(got: [f32; 3], want: [f32; 3], what: &str) {
        for i in 0..3 {
            assert!(
                (got[i] - want[i]).abs() < 1e-6,
                "{what} channel {i}: got {}, want {}",
                got[i],
                want[i]
            );
        }
    }

    // Every value is computed by hand from the table in docs/M1.md for
    // Cb = [0.6, 0.4, 0.2] and Cs = [0.2, 0.8, 0.5].
    #[test]
    fn all_27_modes_at_one_hand_computed_pixel() {
        let cases: [(&str, [f32; 3]); 27] = [
            ("normal", [0.2, 0.8, 0.5]),
            ("dissolve", [0.2, 0.8, 0.5]),
            ("darken", [0.2, 0.4, 0.2]),
            ("multiply", [0.12, 0.32, 0.10]),
            ("color burn", [0.0, 0.25, 0.0]),
            ("linear burn", [0.0, 0.2, 0.0]),
            ("darker color", [0.6, 0.4, 0.2]),
            ("lighten", [0.6, 0.8, 0.5]),
            ("screen", [0.68, 0.88, 0.60]),
            ("color dodge", [0.75, 1.0, 0.4]),
            ("linear dodge", [0.8, 1.0, 0.7]),
            ("lighter color", [0.2, 0.8, 0.5]),
            ("overlay", [0.36, 0.64, 0.20]),
            ("soft light", [0.456, 0.5394733, 0.2]),
            ("hard light", [0.24, 0.76, 0.2]),
            ("vivid light", [0.0, 1.0, 0.2]),
            ("linear light", [0.0, 1.0, 0.2]),
            ("pin light", [0.4, 0.6, 0.2]),
            ("hard mix", [0.0, 1.0, 0.0]),
            ("difference", [0.4, 0.4, 0.3]),
            ("exclusion", [0.56, 0.56, 0.5]),
            ("subtract", [0.4, 0.0, 0.0]),
            ("divide", [1.0, 0.5, 0.4]),
            ("hue", [0.18, 0.58, 0.38]),
            ("saturation", [0.681, 0.381, 0.081]),
            ("color", [0.051, 0.651, 0.351]),
            ("luminosity", [0.749, 0.549, 0.349]),
        ];
        assert_eq!(cases.len(), BLEND_NAMES.len() - 1);
        for (name, want) in cases {
            let mode = Blend::parse(name).unwrap();
            close(blend_rgb(mode, CB, CS), want, name);
        }
    }

    // Corpus-verified Photoshop rules (docs/M1.md section 3). 0.99999994 is what f32 unpremultiply gives for 255.
    #[test]
    fn burn_and_dodge_endpoints_survive_f32_rounding() {
        close(blend_rgb(Blend::ColorBurn, [0.99999994; 3], [0.0; 3]), [1.0; 3], "burn cb=1 cs=0");
        close(blend_rgb(Blend::ColorDodge, [6e-8; 3], [1.0; 3]), [0.0; 3], "dodge cb=0 cs=1");
    }

    #[test]
    fn vivid_light_endpoints_follow_the_source() {
        close(blend_rgb(Blend::VividLight, [1.0; 3], [0.0; 3]), [0.0; 3], "cs=0");
        close(blend_rgb(Blend::VividLight, [0.0; 3], [1.0; 3]), [1.0; 3], "cs=1");
    }

    #[test]
    fn hard_mix_at_sum_one_depends_on_the_source_half() {
        close(blend_rgb(Blend::HardMix, [0.6; 3], [0.4; 3]), [1.0; 3], "cs<=0.5");
        close(blend_rgb(Blend::HardMix, [0.4; 3], [0.6; 3]), [0.0; 3], "cs>0.5");
    }

    #[test]
    fn darker_and_lighter_color_compare_luminosity_and_ties_keep_backdrop() {
        // Channel sum says cs is darker; Lum (0.15 vs 0.11) says cb is darker.
        let (cb, cs) = ([0.0, 0.0, 1.0], [0.5, 0.0, 0.0]);
        close(blend_rgb(Blend::DarkerColor, cb, cs), cb, "darker");
        close(blend_rgb(Blend::LighterColor, cb, cs), cs, "lighter");
        let tie = [0.11 / 0.3, 0.0, 0.0];
        close(blend_rgb(Blend::DarkerColor, [0.0, 0.0, 1.0], tie), [0.0, 0.0, 1.0], "darker tie");
        close(blend_rgb(Blend::LighterColor, [0.0, 0.0, 1.0], tie), [0.0, 0.0, 1.0], "lighter tie");
    }

    #[test]
    fn clip_color_pulls_an_out_of_range_luminosity_back() {
        // Luminosity with Lum(Cs) = 0.95: d = 0.512, max channel 1.112 > 1 gets clipped.
        let cs = [0.95, 0.95, 0.95];
        close(
            blend_rgb(Blend::Luminosity, CB, cs),
            [1.0, 0.938271605, 0.876543210],
            "luminosity clip",
        );
    }

    #[test]
    fn names_round_trip_and_unknown_is_rejected() {
        for (mode, name) in BLEND_NAMES {
            assert_eq!(Blend::parse(name).unwrap(), mode);
            assert_eq!(mode.name(), name);
        }
        assert!(Blend::parse("Normal").is_err());
        assert!(Blend::parse("passthrough").is_err());
    }

    #[test]
    fn dissolve_hash_is_deterministic_and_in_range() {
        let mut sum = 0.0;
        for y in 0..64 {
            for x in 0..64 {
                let v = dissolve_hash(x, y, 7);
                assert!((0.0..1.0).contains(&v));
                assert_eq!(v, dissolve_hash(x, y, 7));
                sum += v;
            }
        }
        let mean = sum / 4096.0;
        assert!((mean - 0.5).abs() < 0.03, "mean {mean}");
        assert_ne!(dissolve_hash(3, 4, 7), dissolve_hash(3, 4, 8));
    }
}
