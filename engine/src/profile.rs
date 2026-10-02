//! The document's color profile: Edit > Assign Profile and Convert to Profile, and the transform
//! from the document's profile to the display (sRGB).

use super::*;
use crate::icc::{Intent, Lut, Profile, SRGB, Space, Transform};
use serde::{Deserialize, Serialize};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

/// The profile a document is tagged with: a built-in profile by name, or a profile file.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocProfile {
    pub name: String,
    /// The ICC file as base64; none for built-in profiles.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icc: Option<String>,
}

impl DocProfile {
    pub fn of(p: &Profile) -> DocProfile {
        DocProfile { name: p.name.clone(), icc: p.icc_bytes.as_deref().map(b64_encode) }
    }

    pub fn resolve(&self) -> Result<Profile, String> {
        match &self.icc {
            Some(b) => Profile::parse(&b64_decode(b)?),
            None => Profile::builtin(&self.name).ok_or_else(|| format!("unknown built-in profile \"{}\"", self.name)),
        }
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            s.push(if i <= c.len() { B64[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' });
        }
    }
    s
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let s = s.trim_end_matches('=').as_bytes();
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for &c in s {
        let v = B64.iter().position(|&b| b == c).ok_or("invalid base64 in the document profile")? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

// Display tables by (profile, gray document); None where the display needs no change.
thread_local! {
    static DISPLAY: RefCell<HashMap<(DocProfile, bool), Option<Rc<Lut>>>> = RefCell::new(HashMap::new());
}

fn display_lut(p: &DocProfile, gray: bool) -> Option<Rc<Lut>> {
    if p.name == SRGB && p.icc.is_none() {
        return None;
    }
    let key = (p.clone(), gray);
    if let Some(l) = DISPLAY.with(|c| c.borrow().get(&key).cloned()) {
        return l;
    }
    let lut = (|| {
        let src = p.resolve().ok()?;
        // Sampled before the gamut clip, so cells at the gamut edge interpolate a smooth function.
        let t = Transform::new(&src, &Profile::builtin(SRGB)?, Intent::Relative, true).ok()?.unclipped();
        let lut = Lut::new(&t, if gray { 1024 } else { 33 });
        // A profile that displays like sRGB keeps the GPU draw path.
        let same = (0..27).all(|k| {
            let c = [k / 9, k / 3 % 3, k % 3].map(|v| v as f32 / 2.0);
            let o = lut.apply(c);
            (0..3).all(|i| (o[i].clamp(0.0, 1.0) - if gray { c[0] } else { c[i] }).abs() < 0.5 / 255.0)
        });
        (!same).then(|| Rc::new(lut))
    })();
    DISPLAY.with(|c| {
        let mut c = c.borrow_mut();
        if c.len() > 16 {
            c.clear();
        }
        c.insert(key, lut.clone());
    });
    lut
}

/// Options of Edit > Convert to Profile.
#[derive(Deserialize, Clone, Copy, Debug, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConvertOpts {
    #[serde(default)]
    pub intent: Intent,
    #[serde(default)]
    pub black_point_compensation: bool,
    #[serde(default)]
    pub dither: bool,
}

impl Document {
    pub fn profile(&self) -> Option<&DocProfile> {
        self.vector.profile.as_ref()
    }

    // The profile space that matches the document's mode.
    pub(super) fn mode_space(&self) -> Space {
        use super::color_mode::ColorMode as M;
        match &self.vector.mode {
            Some(M::Cmyk) => Space::Cmyk,
            Some(M::Lab) => Space::Lab,
            Some(M::Bitmap | M::Duotone { .. } | M::Multichannel) => Space::Gray,
            Some(M::Indexed { .. }) => Space::Rgb,
            None if self.vector.gray => Space::Gray,
            None => Space::Rgb,
        }
    }

    // The profile of the stored numbers: the tag where it matches them, else what an untagged
    // document displays as (sRGB, or gray gamma 2.2). CMYK documents store their sRGB rendering.
    fn source_profile(&self) -> Result<Profile, String> {
        use super::color_mode::ColorMode as M;
        let fallback = || Profile::builtin(if self.vector.gray { "Gray Gamma 2.2" } else { SRGB }).expect("built in");
        match &self.vector.profile {
            Some(_) if self.vector.mode == Some(M::Cmyk) => Ok(fallback()),
            Some(p) => p.resolve().map(|p| if p.space == self.mode_space() { p } else { fallback() }),
            None => Ok(fallback()),
        }
    }

    /// Edit > Assign Profile: tags the document (None = untagged) without changing pixels.
    pub fn assign_profile(&mut self, p: Option<&Profile>) -> Result<bool, String> {
        self.check_idle()?;
        if let Some(p) = p {
            if p.space != self.mode_space() {
                return Err(format!("\"{}\" is not a {} profile", p.name, self.mode_space().label()));
            }
        }
        let tag = p.map(DocProfile::of);
        if tag == self.vector.profile {
            return Ok(false);
        }
        self.vector.profile = tag;
        Ok(true)
    }

    /// Edit > Convert to Profile: converts every pixel layer from the document's profile to `dst`
    /// and tags the document with it. A Gray destination makes the document Grayscale; a CMYK one
    /// makes it CMYK and stores the separation as it displays (sRGB numbers).
    pub fn convert_to_profile(&mut self, dst: &Profile, opts: ConvertOpts) -> Result<bool, String> {
        use super::color_mode::ColorMode as M;
        self.check_idle()?;
        let cmyk_doc = self.vector.mode == Some(M::Cmyk);
        let from = if cmyk_doc { Space::Rgb } else { self.mode_space() };
        if !(self.vector.mode.is_none() || cmyk_doc) || !matches!(from, Space::Rgb | Space::Gray) {
            return Err("Convert to Profile needs an RGB, CMYK or Grayscale document".into());
        }
        if !matches!(dst.space, Space::Rgb | Space::Gray | Space::Cmyk) {
            return Err(format!("\"{}\" is a {} profile; Convert to Profile converts to RGB, CMYK or Gray", dst.name, dst.space.label()));
        }
        let tag = DocProfile::of(dst);
        if self.vector.profile.as_ref() == Some(&tag) {
            return Ok(false);
        }
        let to_dev = Transform::new(&self.source_profile()?, dst, opts.intent, opts.black_point_compensation)?;
        let back = if dst.space == Space::Cmyk { Some(Transform::new(dst, &Profile::builtin(SRGB).expect("built in"), Intent::Relative, true)?) } else { None };
        let t = |i: &[f64], o: &mut [f64; 3]| match &back {
            Some(b) => {
                let mut d = [0.0; 4];
                to_dev.apply(i, &mut d);
                b.apply(&d, o);
            }
            None => to_dev.apply(i, o),
        };
        let to_gray = dst.space == Space::Gray;
        // Dither adds up to half a step of noise before the layer is stored at its depth.
        let step = if opts.dither && self.depth != 32 { 1.0 / max_value(self.depth) as f64 } else { 0.0 };
        let n = Cell::new(0u64);
        let noise = || {
            // splitmix64: every output bit depends on every bit of the pixel counter.
            let mut h = n.get().wrapping_add(1).wrapping_mul(0x9e37_79b9_7f4a_7c15);
            n.set(n.get() + 1);
            h = (h ^ (h >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            h = (h ^ (h >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            h ^= h >> 31;
            (h >> 54) as f64 / 1024.0 - 0.5
        };
        let mut d = self.clone();
        d.map_layers(|c| {
            let mut o = [0.0f64; 3];
            if from == Space::Gray {
                t(&[c[0] as f64], &mut o);
            } else {
                t(&[c[0] as f64, c[1] as f64, c[2] as f64], &mut o);
            }
            if to_gray {
                o = [o[0]; 3];
            }
            let v = o.map(|v| (v + noise() * step) as f32);
            [v[0], v[1], v[2], c[3]]
        })?;
        d.vector.gray = to_gray;
        d.vector.mode = (dst.space == Space::Cmyk).then_some(M::Cmyk);
        d.vector.profile = Some(tag);
        *self = d;
        Ok(true)
    }

    /// The document profile as ICC bytes for embedding in an export; empty when there is none to
    /// embed (untagged, Lab, or a Gray profile, as exports are RGB).
    pub fn profile_icc(&self) -> Vec<u8> {
        let Some(p) = self.vector.profile.as_ref().and_then(|p| p.resolve().ok()) else { return vec![] };
        if p.space != Space::Rgb || self.mode_space() != Space::Rgb {
            return vec![];
        }
        p.icc().unwrap_or_default()
    }

    /// The display table for this document, when its profile displays differently from sRGB.
    pub(super) fn display_profile(&self) -> Option<Rc<Lut>> {
        use super::color_mode::ColorMode as M;
        let p = self.vector.profile.as_ref()?;
        if !matches!(self.vector.mode, None | Some(M::Indexed { .. })) || self.mode_space() != p.resolve().ok()?.space {
            return None;
        }
        display_lut(p, self.vector.gray)
    }

    // Premultiplied display tile `v` through the document's profile.
    pub(super) fn profile_map(&self, mut v: Vec<f32>) -> Vec<f32> {
        let Some(lut) = self.display_profile() else { return v };
        for p in v.chunks_exact_mut(4) {
            let a = p[3];
            if a <= 0.0 {
                continue;
            }
            let o = lut.apply([0, 1, 2].map(|i| (p[i] / a).clamp(0.0, 1.0)));
            for i in 0..3 {
                p[i] = o[i].clamp(0.0, 1.0) * a;
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::super::transform::tests::{get_px, put_px};
    use super::*;

    fn reload(d: &Document) -> Document {
        let mut e = Document::from_manifest(&d.manifest()).unwrap();
        let ids: Vec<u64> = e.loading.as_ref().unwrap().pending_ids.iter().copied().collect();
        for id in ids {
            e.put_tile(id, &d.tile_bytes(id).unwrap()).unwrap();
        }
        e.finish_load().unwrap();
        e
    }

    fn shown(d: &Document, x: usize) -> [u8; 4] {
        let t = d.display_tile(0, 0, 0).unwrap().unwrap();
        t[x * 4..x * 4 + 4].try_into().unwrap()
    }

    #[test]
    fn assign_tags_without_touching_pixels_and_changes_the_display() {
        let mut d = Document::new(64, 64, 8).unwrap();
        put_px(&mut d, 1, 0, 0, [200, 50, 10, 255]);
        let adobe = Profile::builtin("Adobe RGB (1998)").unwrap();
        assert!(d.assign_profile(Some(&adobe)).unwrap());
        assert!(!d.assign_profile(Some(&adobe)).unwrap(), "same tag is no change");
        assert_eq!(get_px(&d, 1, 0, 0), [200, 50, 10, 255]);
        assert_eq!(&d.flatten_tile_rgba8(0, 0).unwrap()[..4], &[200, 50, 10, 255], "exports keep the numbers");
        let s = shown(&d, 0);
        // littleCMS: Adobe RGB (200, 50, 10) is sRGB (232, 46, 0).
        assert!(s[0].abs_diff(232) <= 1 && s[1].abs_diff(46) <= 1 && s[2] <= 1, "{s:?}");
        assert!(d.display_program(0, 0, 0, &[]).is_err(), "a converted display draws CPU tiles");
        assert_eq!(reload(&d).profile(), d.profile());
        assert!(d.assign_profile(Some(&Profile::builtin("Dot Gain 20%").unwrap())).is_err(), "Gray profile on RGB");
        assert!(d.assign_profile(None).unwrap());
        assert_eq!(shown(&d, 0), [200, 50, 10, 255]);
        assert!(d.display_program(0, 0, 0, &[]).is_ok());
    }

    #[test]
    fn convert_to_cmyk_separates_and_shows_the_print() {
        use super::super::color_mode::ColorMode;
        let mut d = Document::new(64, 64, 8).unwrap();
        put_px(&mut d, 1, 0, 0, [0, 0, 255, 255]);
        put_px(&mut d, 1, 1, 0, [150, 140, 130, 255]);
        let cmyk = Profile::builtin(crate::icc::COATED_CMYK).unwrap();
        assert!(d.convert_to_profile(&cmyk, ConvertOpts::default()).unwrap());
        assert_eq!(d.vector.mode, Some(ColorMode::Cmyk));
        assert_eq!(d.profile().unwrap().name, crate::icc::COATED_CMYK);
        let blue = get_px(&d, 1, 0, 0);
        assert!(blue[2] < 230 && blue[0] > 20, "out-of-gamut blue is clipped to what prints: {blue:?}");
        let muted = get_px(&d, 1, 1, 0);
        assert!(muted.iter().zip([150, 140, 130]).all(|(a, b)| a.abs_diff(b) <= 3), "in-gamut colors keep their look: {muted:?}");
        assert_eq!(shown(&d, 0)[..3], blue[..3], "a CMYK document shows its stored separation");
        assert!(!d.convert_to_profile(&cmyk, ConvertOpts::default()).unwrap());
        let srgb = Profile::builtin(SRGB).unwrap();
        assert!(d.convert_to_profile(&srgb, ConvertOpts::default()).unwrap());
        assert_eq!(d.vector.mode, None);
        assert_eq!(get_px(&d, 1, 0, 0)[..3], blue[..3], "back to RGB keeps the printed look");
    }

    #[test]
    fn convert_changes_numbers_and_keeps_the_look() {
        let mut d = Document::new(64, 64, 8).unwrap();
        put_px(&mut d, 1, 0, 0, [255, 0, 0, 255]);
        put_px(&mut d, 1, 1, 0, [30, 140, 220, 128]);
        let before = shown(&d, 1);
        let adobe = Profile::builtin("Adobe RGB (1998)").unwrap();
        assert!(d.convert_to_profile(&adobe, ConvertOpts::default()).unwrap());
        assert_eq!(get_px(&d, 1, 0, 0), [219, 0, 0, 255]);
        assert_eq!(get_px(&d, 1, 1, 0)[3], 128, "alpha stays");
        assert_eq!(d.profile().unwrap().name, "Adobe RGB (1998)");
        assert!(shown(&d, 0)[0] >= 254, "{:?}", shown(&d, 0));
        assert!(shown(&d, 1).iter().zip(before).all(|(a, b)| a.abs_diff(b) <= 2), "{:?} vs {before:?}", shown(&d, 1));
        assert!(!d.convert_to_profile(&adobe, ConvertOpts::default()).unwrap());

        let g = Profile::builtin("Gray Gamma 2.2").unwrap();
        assert!(d.convert_to_profile(&g, ConvertOpts::default()).unwrap());
        let p = get_px(&d, 1, 0, 0);
        assert!(d.vector.gray && p[0] == p[1] && p[1] == p[2], "{p:?}");
        assert!(d.convert_to_profile(&Profile::builtin(crate::icc::LAB).unwrap(), ConvertOpts::default()).is_err());
    }

    #[test]
    fn profile_files_are_stored_in_the_manifest() {
        let mut d = Document::new(8, 8, 8).unwrap();
        let bytes = Profile::builtin("Display P3").unwrap().icc().unwrap();
        let p = Profile::parse(&bytes).unwrap();
        d.assign_profile(Some(&p)).unwrap();
        let e = reload(&d);
        assert_eq!(e.profile().unwrap().icc.as_deref().map(b64_decode).unwrap().unwrap(), bytes);
        assert_eq!(e.profile_icc(), bytes);
        assert_eq!(b64_decode(&b64_encode(&[1, 2, 3, 4, 5])).unwrap(), [1, 2, 3, 4, 5]);
        let mut bad = d.manifest();
        bad = bad.replace(&*d.profile().unwrap().icc.clone().unwrap(), "QUJD");
        assert!(Document::from_manifest(&bad).is_err(), "a broken profile file is refused");
    }

    #[test]
    fn dither_noise_has_no_column_pattern() {
        let mut d = Document::new(64, 64, 8).unwrap();
        d.fill(1, Target::Pixels, 200, 50, 10, 255).unwrap();
        d.assign_profile(Some(&Profile::builtin("Adobe RGB (1998)").unwrap())).unwrap();
        let o = ConvertOpts { dither: true, ..ConvertOpts::default() };
        d.convert_to_profile(&Profile::builtin(crate::icc::SRGB).unwrap(), o).unwrap();
        let (mut vert, mut horiz) = (0, 0);
        for y in 0..63 {
            for x in 0..63 {
                let p = get_px(&d, 1, x, y)[0];
                vert += (p != get_px(&d, 1, x, y + 1)[0]) as u32;
                horiz += (p != get_px(&d, 1, x + 1, y)[0]) as u32;
            }
        }
        assert!(vert > 0 && horiz > 0 && vert.abs_diff(horiz) * 4 < vert.max(horiz), "vertical {vert} vs horizontal {horiz} changes");
    }
}
