//! Fill/texture pattern registry (B5 spec v2 Part E2): a luminance grid sampled by texture and
//! dual-brush blending. Lives outside the document/snapshots, like sampled brush tips (E1.11).

/// A registered pattern: `w * h` texels, row-major, stored both as luminance (0..1, for texture
/// and dual-brush sampling) and as RGBA (0..1 per channel, for Fill's colour source).
pub struct Pattern {
    w: u32,
    h: u32,
    lum: Vec<f32>,
    rgba: Vec<[f32; 4]>,
}

impl Pattern {
    /// `data` is `w * h` gray bytes (`channels == 1`) or `w * h * 4` RGBA bytes (`channels == 4`,
    /// alpha ignored, stored as 1.0); luminance uses the same 0.3/0.59/0.11 weights as `blend::lum`.
    pub fn new(w: u32, h: u32, data: &[u8], channels: u8) -> Result<Pattern, String> {
        if !(1..=4096).contains(&w) || !(1..=4096).contains(&h) {
            return Err("a pattern must be 1..=4096 px per side".into());
        }
        let n = (w * h) as usize;
        let (lum, rgba): (Vec<f32>, Vec<[f32; 4]>) = match channels {
            1 => {
                if data.len() != n {
                    return Err("a gray pattern's bytes must be w * h long".into());
                }
                let lum: Vec<f32> = data.iter().map(|&v| v as f32 / 255.0).collect();
                let rgba = lum.iter().map(|&v| [v, v, v, 1.0]).collect();
                (lum, rgba)
            }
            4 => {
                if data.len() != n * 4 {
                    return Err("an rgba pattern's bytes must be w * h * 4 long".into());
                }
                let lum = data
                    .chunks_exact(4)
                    .map(|c| (0.3 * c[0] as f32 + 0.59 * c[1] as f32 + 0.11 * c[2] as f32) / 255.0)
                    .collect();
                let rgba = data
                    .chunks_exact(4)
                    .map(|c| [c[0] as f32 / 255.0, c[1] as f32 / 255.0, c[2] as f32 / 255.0, 1.0])
                    .collect();
                (lum, rgba)
            }
            other => return Err(format!("unsupported pattern channel count {other}")),
        };
        Ok(Pattern { w, h, lum, rgba })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.w, self.h)
    }

    fn texel(&self, x: i32, y: i32) -> f32 {
        let tx = x.rem_euclid(self.w as i32) as usize;
        let ty = y.rem_euclid(self.h as i32) as usize;
        self.lum[ty * self.w as usize + tx]
    }

    /// The tiled colour at pixel `(x, y)` for Fill's pattern source (B6 spec v1 Part E1): the
    /// pattern's own RGBA, alpha always 1.
    pub fn sample_rgba(&self, x: i32, y: i32, scale: f32) -> [f32; 4] {
        let scale = if scale <= 0.0 { 1.0 } else { scale };
        let tx = (x as f32 / scale).floor() as i32;
        let ty = (y as f32 / scale).floor() as i32;
        let tx = tx.rem_euclid(self.w as i32) as usize;
        let ty = ty.rem_euclid(self.h as i32) as usize;
        self.rgba[ty * self.w as usize + tx]
    }

    /// The raw 0..1 luminance at pixel `(x, y)`, tiled at `scale` document pixels per texel
    /// (E2.1); `scale <= 0` behaves like `1`.
    pub fn sample_raw(&self, x: i32, y: i32, scale: f32) -> f32 {
        let scale = if scale <= 0.0 { 1.0 } else { scale };
        let tx = (x as f32 / scale).floor() as i32;
        let ty = (y as f32 / scale).floor() as i32;
        self.texel(tx, ty)
    }

    /// `sample_raw` remapped by invert/contrast/brightness (E2.1).
    pub fn sample(&self, x: i32, y: i32, scale: f32, invert: bool, brightness: f32, contrast: f32) -> f32 {
        let mut u = self.sample_raw(x, y, scale);
        if invert {
            u = 1.0 - u;
        }
        ((u - 0.5) * (1.0 + contrast) + 0.5 + brightness).clamp(0.0, 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_sizes_and_lengths() {
        assert!(Pattern::new(0, 2, &[0, 0], 1).is_err());
        assert!(Pattern::new(4097, 2, &[0; 8194], 1).is_err());
        assert!(Pattern::new(2, 2, &[0; 3], 1).is_err());
        assert!(Pattern::new(2, 2, &[0; 15], 4).is_err());
        assert!(Pattern::new(2, 2, &[0; 16], 4).is_ok());
        assert!(Pattern::new(1, 1, &[7], 0).is_err(), "unsupported channel count");
    }

    #[test]
    fn gray_luminance_is_the_byte_over_255() {
        let p = Pattern::new(2, 1, &[0, 255], 1).unwrap();
        assert_eq!(p.sample_raw(0, 0, 1.0), 0.0);
        assert_eq!(p.sample_raw(1, 0, 1.0), 1.0);
    }

    #[test]
    fn rgba_luminance_uses_the_blend_weights() {
        let p = Pattern::new(1, 1, &[255, 0, 0, 255], 4).unwrap();
        assert!((p.sample_raw(0, 0, 1.0) - 0.3).abs() < 1e-6);
    }

    #[test]
    fn sample_rgba_keeps_the_pattern_colour_alpha_one() {
        // A 2x2 checker: red/green over blue/yellow, alpha ignored on input.
        let data = [255, 0, 0, 10, 0, 255, 0, 20, 0, 0, 255, 30, 255, 255, 0, 40];
        let p = Pattern::new(2, 2, &data, 4).unwrap();
        assert_eq!(p.sample_rgba(0, 0, 1.0), [1.0, 0.0, 0.0, 1.0]);
        assert_eq!(p.sample_rgba(1, 0, 1.0), [0.0, 1.0, 0.0, 1.0]);
        assert_eq!(p.sample_rgba(0, 1, 1.0), [0.0, 0.0, 1.0, 1.0]);
        assert_eq!(p.sample_rgba(1, 1, 1.0), [1.0, 1.0, 0.0, 1.0]);
        assert_eq!(p.sample_rgba(2, 0, 1.0), [1.0, 0.0, 0.0, 1.0], "wraps positive");
        let gray = Pattern::new(1, 1, &[64], 1).unwrap();
        let v = 64.0 / 255.0;
        assert_eq!(gray.sample_rgba(0, 0, 1.0), [v, v, v, 1.0]);
    }

    #[test]
    fn sampling_wraps_and_scales() {
        // A 2x1 checker: scale 1 alternates every pixel, scale 2 doubles the period.
        let p = Pattern::new(2, 1, &[0, 255], 1).unwrap();
        assert_eq!(p.sample_raw(0, 0, 1.0), 0.0);
        assert_eq!(p.sample_raw(1, 0, 1.0), 1.0);
        assert_eq!(p.sample_raw(2, 0, 1.0), 0.0, "wraps positive");
        assert_eq!(p.sample_raw(-1, 0, 1.0), 1.0, "negative x wraps positive");
        assert_eq!(p.sample_raw(0, 0, 2.0), 0.0);
        assert_eq!(p.sample_raw(1, 0, 2.0), 0.0, "still texel 0 at scale 2");
        assert_eq!(p.sample_raw(2, 0, 2.0), 1.0, "the period doubled");
        assert_eq!(p.sample_raw(3, 0, 2.0), 1.0);
    }

    #[test]
    fn invert_flips_the_sample() {
        let p = Pattern::new(1, 1, &[64], 1).unwrap();
        let u = p.sample_raw(0, 0, 1.0);
        assert_eq!(p.sample(0, 0, 1.0, false, 0.0, 0.0), u);
        assert!((p.sample(0, 0, 1.0, true, 0.0, 0.0) - (1.0 - u)).abs() < 1e-6);
    }

    #[test]
    fn contrast_and_brightness_remap_around_the_midpoint() {
        let p = Pattern::new(1, 1, &[128], 1).unwrap();
        // u ~ 0.5: contrast is a no-op at the midpoint, brightness still shifts it.
        assert!((p.sample(0, 0, 1.0, false, 0.0, 1.0) - p.sample_raw(0, 0, 1.0)).abs() < 0.01);
        assert!((p.sample(0, 0, 1.0, false, 0.2, 0.0) - (p.sample_raw(0, 0, 1.0) + 0.2)).abs() < 1e-4);
    }
}
