//! View-only display options: View > Proof Setup, Proof Colors, Gamut Warning and 32-bit Preview
//! Options. They change display tiles only, never the document, its history or its file.

use super::*;
use crate::icc::{Curve, Intent, LAB, Lut, Profile, SRGB, Space, Transform};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// The simulated output of View > Proof Setup.
#[derive(Deserialize, Clone, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProofSetup {
    pub kind: ProofKind,
    /// The device profile (a built-in name); None with `preserve_numbers` is Monitor RGB.
    #[serde(default)]
    pub profile: Option<String>,
    /// The device profile's ICC file when it is not built in.
    #[serde(default)]
    pub icc: Option<Vec<u8>>,
    /// Working Cyan/Magenta/Yellow/Black/CMY Plate: which CMYK plates print.
    #[serde(default)]
    pub plates: Option<[bool; 4]>,
    #[serde(default)]
    pub intent: Intent,
    #[serde(default = "yes")]
    pub black_point_compensation: bool,
    /// The document numbers are sent to the device as they are.
    #[serde(default)]
    pub preserve_numbers: bool,
    #[serde(default)]
    pub simulate_paper: bool,
    #[serde(default)]
    pub simulate_black_ink: bool,
}

fn yes() -> bool {
    true
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum ProofKind {
    #[default]
    Device,
    Protanopia,
    Deuteranopia,
}

#[derive(Deserialize, Clone, Copy, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum HdrMethod {
    #[default]
    ExposureAndGamma,
    HighlightCompression,
}

/// View > 32-bit Preview Options.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hdr {
    #[serde(default)]
    pub method: HdrMethod,
    #[serde(default)]
    pub exposure: f32,
    #[serde(default = "one")]
    pub gamma: f32,
}

fn one() -> f32 {
    1.0
}

impl Default for Hdr {
    fn default() -> Hdr {
        Hdr { method: HdrMethod::ExposureAndGamma, exposure: 0.0, gamma: 1.0 }
    }
}

impl Hdr {
    fn neutral(&self) -> bool {
        self.method == HdrMethod::ExposureAndGamma && self.exposure == 0.0 && self.gamma == 1.0
    }

    // One 32-bit value to display range; `max` is the brightest value in the image.
    fn tone(&self, v: f32, max: f32) -> f32 {
        let v = v.max(0.0);
        match self.method {
            HdrMethod::HighlightCompression if max > 1.0 => (v * (1.0 + v / (max * max)) / (1.0 + v)).min(1.0),
            HdrMethod::HighlightCompression => v.min(1.0),
            HdrMethod::ExposureAndGamma => (v * self.exposure.exp2()).powf(1.0 / self.gamma).min(1.0),
        }
    }
}

/// The display options of one document view.
#[derive(Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct View {
    #[serde(default)]
    pub setup: ProofSetup,
    #[serde(default)]
    pub proof_colors: bool,
    #[serde(default)]
    pub gamut_warning: bool,
    #[serde(default)]
    pub hdr: Hdr,
    /// The brightest value of a 32-bit image, measured when the view is set.
    #[serde(skip)]
    pub hdr_max: f32,
}

// Gamut Warning paints colors that the proof device misses by more than this Delta E (CIE76).
const GAMUT_DE: f32 = 2.0;
const GAMUT_GRAY: f32 = 128.0 / 255.0;
const GRID: usize = 33;

struct Built {
    // Storage RGB -> display sRGB through the proof; None shows the numbers as they are.
    map: Option<Lut>,
    // Storage RGB -> Delta E between the color and its proof; None when nothing is out of gamut.
    gamut: Option<Lut>,
}

thread_local! {
    static BUILT: RefCell<HashMap<(Option<profile::DocProfile>, ProofSetup, bool), Rc<Built>>> = RefCell::new(HashMap::new());
}

// Viénot, Brettel and Mollon (1999): linear sRGB -> LMS, and the plane a dichromat sees.
const LMS: [[f64; 3]; 3] = [[17.8824, 43.5161, 4.11935], [3.45565, 27.1554, 3.86714], [0.0299566, 0.184309, 1.46709]];

fn dichromacy(kind: ProofKind, rgb: [f64; 3]) -> [f64; 3] {
    let lin = rgb.map(|v| Curve::Srgb.eval(v));
    let [mut l, mut m, s] = [0, 1, 2].map(|r| LMS[r][0] * lin[0] + LMS[r][1] * lin[1] + LMS[r][2] * lin[2]);
    match kind {
        ProofKind::Protanopia => l = 2.02344 * m - 2.52581 * s,
        _ => m = 0.494207 * l + 1.24827 * s,
    }
    let inv = crate::icc::invert3(&LMS).expect("LMS is invertible");
    [0, 1, 2].map(|r| Curve::Srgb.inverse((inv[r][0] * l + inv[r][1] * m + inv[r][2] * s).clamp(0.0, 1.0)))
}

fn lab_of(t: &Transform, i: &[f64]) -> [f64; 3] {
    let mut o = [0.0; 3];
    t.apply(i, &mut o);
    [o[0] * 100.0, o[1] * 255.0 - 128.0, o[2] * 255.0 - 128.0]
}

impl Document {
    // The profile the stored numbers display through: the document's own where it applies, else sRGB.
    fn shown_profile(&self) -> Profile {
        use super::color_mode::ColorMode as M;
        let own = matches!(self.vector.mode, None | Some(M::Indexed { .. })).then(|| self.vector.profile.as_ref()).flatten();
        own.and_then(|p| p.resolve().ok()).filter(|p| p.space == self.mode_space()).unwrap_or_else(|| Profile::builtin(SRGB).expect("built in"))
    }

    /// The device profile of a proof setup.
    pub fn proof_device(s: &ProofSetup) -> Result<Profile, String> {
        match (&s.icc, &s.profile) {
            (Some(b), _) => Profile::parse(b),
            (None, Some(n)) => Profile::builtin(n).ok_or_else(|| format!("unknown proof profile \"{n}\"")),
            (None, None) => Ok(Profile::builtin(SRGB).expect("built in")),
        }
    }

    fn build_proof(&self, s: &ProofSetup, gamut: bool) -> Result<Built, String> {
        let src = self.shown_profile();
        let srgb = Profile::builtin(SRGB).expect("built in");
        let input = |c: &[f64]| -> Vec<f64> { if src.space == Space::Gray { vec![c[0]] } else { c[..3].to_vec() } };
        if s.kind != ProofKind::Device {
            let t = Transform::new(&src, &srgb, Intent::Relative, true)?;
            let map = Lut::from_fn(3, 3, GRID, |c, o| {
                let mut d = [0.0; 3];
                t.apply(&input(c), &mut d);
                o.copy_from_slice(&dichromacy(s.kind, d));
            });
            return Ok(Built { map: Some(map), gamut: None });
        }
        let dev = Self::proof_device(s)?;
        let black_ink = s.simulate_black_ink || s.simulate_paper;
        let show = if s.simulate_paper { Transform::paper(&dev, &srgb)? } else { Transform::new(&dev, &srgb, Intent::Relative, !black_ink)? };
        // Monitor RGB, or numbers sent as they are to a device of the same kind.
        let numbers = s.preserve_numbers && s.plates.is_none() && dev.channels() == src.channels();
        let to_dev = Transform::new(&src, &dev, s.intent, s.black_point_compensation)?;
        let mask = s.plates.map(|p| p.map(|on| if on { 1.0 } else { 0.0 }));
        let map = if numbers && s.profile.is_none() && s.icc.is_none() {
            None
        } else {
            Some(Lut::from_fn(3, 3, GRID, |c, o| {
                let mut d = [0.0f64; 4];
                if numbers {
                    d[..src.channels()].copy_from_slice(&input(c));
                } else {
                    to_dev.apply(&input(c), &mut d);
                }
                if let Some(m) = mask {
                    (0..4).for_each(|i| d[i] *= m[i]);
                }
                let mut out = [0.0; 3];
                show.apply(&d[..dev.channels()], &mut out);
                o.copy_from_slice(&out);
            }))
        };
        let gamut = if gamut {
            let lab = Profile::builtin(LAB).expect("built in");
            let (src_lab, dev_lab) = (Transform::new(&src, &lab, Intent::Relative, false)?, Transform::new(&dev, &lab, Intent::Relative, false)?);
            let to_dev = Transform::new(&src, &dev, s.intent, false)?;
            Some(Lut::from_fn(3, 1, GRID, |c, o| {
                let i = input(c);
                let mut d = [0.0f64; 4];
                to_dev.apply(&i, &mut d);
                let (a, b) = (lab_of(&src_lab, &i), lab_of(&dev_lab, &d[..dev.channels()]));
                o[0] = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt();
            }))
        } else {
            None
        };
        Ok(Built { map, gamut })
    }

    fn proofing(&self, view: &View) -> Result<Option<Rc<Built>>, String> {
        let gamut = view.gamut_warning && view.setup.kind == ProofKind::Device;
        if !view.proof_colors && !gamut {
            return Ok(None);
        }
        let key = (self.vector.profile.clone(), view.setup.clone(), gamut);
        if let Some(b) = BUILT.with(|c| c.borrow().get(&key).cloned()) {
            return Ok(Some(b));
        }
        let b = Rc::new(self.build_proof(&view.setup, gamut)?);
        BUILT.with(|c| {
            let mut c = c.borrow_mut();
            if c.len() > 8 {
                c.clear();
            }
            c.insert(key, b.clone());
        });
        Ok(Some(b))
    }

    /// Whether `view` changes how tiles display, so they cannot take the GPU draw path.
    pub fn view_needs_cpu(&self, view: &View) -> bool {
        view.proof_colors || view.gamut_warning || (self.depth == 32 && !view.hdr.neutral())
    }

    /// The brightest color value over every own pixel layer, for Highlight Compression.
    pub fn brightest(&self) -> f32 {
        let mut max = 0.0f32;
        for id in self.own_pixel_layers() {
            let Ok(tiles) = self.node(id).and_then(|n| n.pixel_tiles()) else { continue };
            for (_, t) in tiles.iter() {
                if let Pixels::F32(v) = &*t.px {
                    for p in v.chunks_exact(4).filter(|p| p[3] > 0.0) {
                        max = max.max(p[0]).max(p[1]).max(p[2]);
                    }
                }
            }
        }
        max
    }

    /// The level-`level` display tile under `view` as premultiplied RGBA8, or None when it is fully
    /// transparent. Level 0 is exact; higher levels composite the layers' pyramid tiles. Then
    /// 32-bit tone, proof colors or the document profile, and the gamut warning.
    pub fn display_tile_view(&self, view: &View, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        let mut v = self.mode_map(level, Document::run_program(&self.program(level, tx, ty)?));
        if self.depth == 32 && !view.hdr.neutral() {
            for p in v.chunks_exact_mut(4) {
                let a = p[3];
                if a > 0.0 {
                    (0..3).for_each(|i| p[i] = view.hdr.tone(p[i] / a, view.hdr_max) * a);
                }
            }
        }
        let Some(b) = self.proofing(view)? else { return Ok(quantize_premul(&self.profile_map(v))) };
        let shown = if view.proof_colors { None } else { self.display_profile() };
        for p in v.chunks_exact_mut(4) {
            let a = p[3];
            if a <= 0.0 {
                continue;
            }
            let s = [0, 1, 2].map(|i| (p[i] / a).clamp(0.0, 1.0));
            let out = if view.proof_colors { b.map.as_ref().map_or(s, |m| m.apply(s)) } else { shown.as_ref().map_or(s, |m| m.apply(s)) };
            let out = match &b.gamut {
                Some(g) if g.apply(s)[0] > GAMUT_DE => [GAMUT_GRAY; 3],
                _ => out,
            };
            (0..3).for_each(|i| p[i] = out[i].clamp(0.0, 1.0) * a);
        }
        Ok(quantize_premul(&v))
    }
}

#[cfg(test)]
mod tests {
    use super::super::transform::tests::put_px;
    use super::*;

    fn doc_with(rgb: [u8; 3]) -> Document {
        let mut d = Document::new(4, 4, 8).unwrap();
        put_px(&mut d, 1, 0, 0, [rgb[0], rgb[1], rgb[2], 255]);
        d
    }

    fn shown(d: &Document, v: &View) -> [u8; 3] {
        let t = d.display_tile_view(v, 0, 0, 0).unwrap().unwrap();
        [t[0], t[1], t[2]]
    }

    fn cmyk(kind: ProofKind) -> ProofSetup {
        ProofSetup { kind, profile: Some(crate::icc::COATED_CMYK.into()), black_point_compensation: true, ..Default::default() }
    }

    #[test]
    fn proof_colors_show_the_press_and_off_shows_the_document() {
        let d = doc_with([0, 0, 255]);
        let off = View::default();
        assert_eq!(shown(&d, &off), [0, 0, 255]);
        let on = View { setup: cmyk(ProofKind::Device), proof_colors: true, ..Default::default() };
        let p = shown(&d, &on);
        assert!(p[2] < 230 && p[0] > 20, "pure blue prints duller and purpler: {p:?}");
        assert!(d.view_needs_cpu(&on) && !d.view_needs_cpu(&off));
    }

    #[test]
    fn plates_show_one_ink() {
        let d = doc_with([40, 120, 200]);
        let mut s = cmyk(ProofKind::Device);
        s.plates = Some([true, false, false, false]);
        let p = shown(&d, &View { setup: s, proof_colors: true, ..Default::default() });
        assert!(p[0] < p[1] && p[1] < p[2], "the cyan plate alone is cyan: {p:?}");
        s = cmyk(ProofKind::Device);
        s.plates = Some([false, false, false, true]);
        let k = shown(&doc_with([255, 255, 255]), &View { setup: s, proof_colors: true, ..Default::default() });
        assert!(k.iter().all(|&v| v > 250), "white has no black ink: {k:?}");
    }

    #[test]
    fn gamut_warning_marks_colors_the_press_cannot_print() {
        let v = View { setup: cmyk(ProofKind::Device), gamut_warning: true, ..Default::default() };
        assert_eq!(shown(&doc_with([0, 0, 255]), &v), [128; 3], "sRGB blue is out of gamut");
        assert_eq!(shown(&doc_with([150, 140, 130]), &v), [150, 140, 130], "a muted gray-brown prints");
    }

    #[test]
    fn monitor_rgb_shows_the_numbers_and_legacy_mac_is_lighter() {
        let mut d = doc_with([100, 100, 100]);
        d.assign_profile(Some(&Profile::builtin("Adobe RGB (1998)").unwrap())).unwrap();
        let monitor = ProofSetup { preserve_numbers: true, ..Default::default() };
        assert_eq!(shown(&d, &View { setup: monitor, proof_colors: true, ..Default::default() }), [100; 3]);
        let mac = ProofSetup { profile: Some(crate::icc::LEGACY_MAC.into()), preserve_numbers: true, ..Default::default() };
        let m = shown(&d, &View { setup: mac, proof_colors: true, ..Default::default() });
        assert!(m[0] > 110, "gamma 1.8 numbers show lighter on an sRGB display: {m:?}");
    }

    #[test]
    fn color_blindness_merges_red_and_green() {
        let v = |k| View { setup: ProofSetup { kind: k, ..Default::default() }, proof_colors: true, ..Default::default() };
        for k in [ProofKind::Protanopia, ProofKind::Deuteranopia] {
            let (r, g) = (shown(&doc_with([200, 40, 40]), &v(k)), shown(&doc_with([40, 160, 40]), &v(k)));
            assert!((r[0] as i32 - r[1] as i32).abs() < 40 && (g[0] as i32 - g[1] as i32).abs() < 40, "{k:?}: red {r:?} green {g:?}");
        }
    }

    #[test]
    fn simulate_paper_tints_white() {
        let d = doc_with([255, 255, 255]);
        let mut s = cmyk(ProofKind::Device);
        assert!(shown(&d, &View { setup: s.clone(), proof_colors: true, ..Default::default() }).iter().all(|&v| v >= 254));
        s.simulate_paper = true;
        let p = shown(&d, &View { setup: s, proof_colors: true, ..Default::default() });
        assert!(p[0] < 250 && p[2] > p[0], "coated paper is a little darker and bluish: {p:?}");
    }

    #[test]
    fn hdr_preview_tones_32_bit_values() {
        let h = Hdr { method: HdrMethod::ExposureAndGamma, exposure: -1.0, gamma: 1.0 };
        assert!((h.tone(1.6, 0.0) - 0.8).abs() < 1e-6);
        let c = Hdr { method: HdrMethod::HighlightCompression, ..Default::default() };
        assert!((c.tone(4.0, 4.0) - 1.0).abs() < 1e-6, "the brightest value maps to white");
        assert!(c.tone(0.5, 4.0) < 0.5 && c.tone(2.0, 4.0) < 1.0);
    }
}
