//! Stroke geometry and accumulation (docs/M2.md section 4): tip rasterization, dab spacing along
//! the input path and the per-stroke coverage buffer. Pure math over flat buffers, no Document.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TipShape {
    Round,
    Square,
}

impl TipShape {
    pub fn parse(s: &str) -> Result<TipShape, String> {
        match s {
            "round" => Ok(TipShape::Round),
            "square" => Ok(TipShape::Square),
            other => Err(format!("unknown tip shape {other}")),
        }
    }
}

/// One dab's tip: `radius` in document pixels (half the diameter), `hardness`, `roundness` and
/// the wet-edge flag in 0..1, `angle_deg` rotating the ellipse counter-clockwise.
#[derive(Clone, Copy, Debug)]
pub struct Tip {
    radius: f32,
    hardness: f32,
    roundness: f32,
    aliased: bool,
    shape: TipShape,
    wet_edges: bool,
    // sin, cos of the tip angle, so `cov` has no trigonometry per pixel.
    rot: (f32, f32),
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl Tip {
    pub fn new(
        radius: f32,
        hardness: f32,
        angle_deg: f32,
        roundness: f32,
        aliased: bool,
        shape: TipShape,
        wet_edges: bool,
    ) -> Tip {
        let a = angle_deg.to_radians();
        Tip {
            radius,
            hardness: hardness.clamp(0.0, 1.0),
            roundness: roundness.clamp(0.01, 1.0),
            aliased,
            shape,
            wet_edges,
            rot: (a.sin(), a.cos()),
        }
    }

    /// Coverage in 0..1 of the pixel center at (dx, dy) relative to the dab center. `rn` is the
    /// distance normalized to the tip edge; the soft falloff is 1 up to `hardness` and then the
    /// cubic smoothstep `1 - t^2 (3 - 2t)` down to 0 at rn = 1, with the inner plateau kept one
    /// pixel inside the edge so hardness 100 % still has an anti-aliased rim.
    pub fn cov(&self, dx: f32, dy: f32) -> f32 {
        if self.radius <= 0.0 {
            return 0.0;
        }
        let (sa, ca) = self.rot;
        let x = dx * ca + dy * sa;
        let y = (-dx * sa + dy * ca) / self.roundness;
        let d = match self.shape {
            TipShape::Round => (x * x + y * y).sqrt(),
            TipShape::Square => x.abs().max(y.abs()),
        };
        let rn = d / self.radius;
        if rn > 1.0 {
            return 0.0;
        }
        let base = if self.aliased {
            1.0
        } else {
            let h = self.hardness.min((1.0 - 1.0 / self.radius).max(0.0));
            if rn <= h {
                1.0
            } else if rn >= 1.0 {
                0.0
            } else {
                let t = (rn - h) / (1.0 - h);
                1.0 - t * t * (3.0 - 2.0 * t)
            }
        };
        if self.wet_edges {
            // Rim full, center half: paint pools at the edge of a wet dab.
            base * (0.5 + 0.5 * smoothstep(0.5, 1.0, rn))
        } else {
            base
        }
    }
}

/// `Tip::cov` for a plain round tip, the form docs/M2.md section 4 describes.
#[allow(clippy::too_many_arguments, dead_code)]
pub fn dab_coverage(
    dx: f32,
    dy: f32,
    radius: f32,
    hardness: f32,
    angle_deg: f32,
    roundness: f32,
    aliased: bool,
) -> f32 {
    Tip::new(radius, hardness, angle_deg, roundness, aliased, TipShape::Round, false).cov(dx, dy)
}

/// One input sample or placed dab: document position plus pressure in 0..1.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Sample {
    pub x: f64,
    pub y: f64,
    pub p: f32,
}

/// Places dabs every `step` px along the polyline of samples, carrying the leftover distance
/// across calls. The first sample of a stroke always gets a dab.
#[derive(Default)]
pub struct Spacer {
    last: Option<Sample>,
    carry: f64,
}

impl Spacer {
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
                    out.push(*s);
                }
                self.last = Some(*s);
                continue;
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
                });
            }
            self.carry += len - trav;
            self.last = Some(*s);
        }
        out
    }
}

/// One dab's contribution to the stroke buffer: `cap` = opacity (times pressure when pressure
/// controls opacity), `flow` the per-dab paint, `cov` the tip coverage of this pixel. Without wet
/// edges the buffer approaches the cap but never exceeds it, so a stroke never darkens past its
/// opacity; with wet edges overlaps hold instead of building up.
#[inline(always)]
pub fn accumulate(s: f32, cap: f32, flow: f32, cov: f32, wet_edges: bool) -> f32 {
    let f = flow * cov;
    if wet_edges {
        s.max(cap * f)
    } else if s < cap {
        s + (cap - s) * f
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f32, b: f32) {
        assert!((a - b).abs() < 1e-5, "{a} != {b}");
    }

    #[test]
    fn hard_dab_coverage_grid() {
        // radius 2, hardness 100 %: the plateau ends at rn = 1 - 1/2 = 0.5, so the pixel one px
        // out is still full and the one at 1.5 px sits exactly in the middle of the falloff.
        let c = |dx: f32, dy: f32| dab_coverage(dx, dy, 2.0, 1.0, 0.0, 1.0, false);
        assert_eq!(c(0.0, 0.0), 1.0);
        assert_eq!(c(1.0, 0.0), 1.0);
        assert_eq!(c(0.0, -1.0), 1.0);
        assert_eq!(c(1.5, 0.0), 0.5);
        assert_eq!(c(2.0, 0.0), 0.0);
        assert_eq!(c(2.5, 0.0), 0.0);
        close(c(1.0, 1.0), 0.627_417);
    }

    #[test]
    fn soft_dab_falls_off_monotonically() {
        let c = |dx: f32| dab_coverage(dx, 0.0, 10.0, 0.0, 0.0, 1.0, false);
        assert_eq!(c(0.0), 1.0);
        assert_eq!(c(5.0), 0.5);
        assert_eq!(c(10.0), 0.0);
        assert_eq!(c(11.0), 0.0);
        let mut prev = 1.0;
        for i in 0..=100 {
            let v = c(i as f32 / 10.0);
            assert!(v <= prev, "coverage grew at {i}");
            prev = v;
        }
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
        let flat = Tip::new(4.0, 0.0, 0.0, 0.5, true, TipShape::Round, false);
        assert_eq!(flat.cov(4.0, 0.0), 1.0);
        assert_eq!(flat.cov(0.0, 2.0), 1.0);
        assert_eq!(flat.cov(0.0, 2.5), 0.0);
        let turned = Tip::new(4.0, 0.0, 90.0, 0.5, true, TipShape::Round, false);
        assert_eq!(turned.cov(0.0, 4.0), 1.0);
        assert_eq!(turned.cov(2.5, 0.0), 0.0);
    }

    #[test]
    fn square_tip_covers_the_corners() {
        let t = Tip::new(8.0, 0.0, 0.0, 1.0, true, TipShape::Square, false);
        assert_eq!(t.cov(8.0, 8.0), 1.0);
        assert_eq!(t.cov(8.1, 0.0), 0.0);
        assert_eq!(Tip::new(8.0, 0.0, 0.0, 1.0, true, TipShape::Round, false).cov(8.0, 8.0), 0.0);
    }

    #[test]
    fn wet_edges_halve_the_center_and_keep_the_rim() {
        let t = Tip::new(10.0, 1.0, 0.0, 1.0, true, TipShape::Round, true);
        close(t.cov(0.0, 0.0), 0.5);
        close(t.cov(5.0, 0.0), 0.5);
        close(t.cov(10.0, 0.0), 1.0);
        assert!(t.cov(8.0, 0.0) > t.cov(6.0, 0.0));
    }

    #[test]
    fn spacing_places_the_expected_dab_count() {
        // Diameter 10 at 25 % spacing is a dab every 2.5 px: one at the start plus 40 along a
        // 100 px line.
        let mut sp = Spacer::default();
        let dabs = sp.feed(&[Sample { x: 0.0, y: 0.0, p: 1.0 }, Sample { x: 100.0, y: 0.0, p: 1.0 }], 2.5, false);
        assert_eq!(dabs.len(), 41);
        assert_eq!(dabs[0].x, 0.0);
        assert_eq!(dabs[1].x, 2.5);
        assert_eq!(dabs[40].x, 100.0);
    }

    #[test]
    fn spacing_carries_the_remainder_across_calls() {
        let mut sp = Spacer::default();
        assert_eq!(sp.feed(&[Sample { x: 0.0, y: 0.0, p: 1.0 }], 4.0, false).len(), 1);
        // 3 px is short of the step, 3 more crosses it once.
        assert_eq!(sp.feed(&[Sample { x: 3.0, y: 0.0, p: 1.0 }], 4.0, false).len(), 0);
        let d = sp.feed(&[Sample { x: 6.0, y: 0.0, p: 1.0 }], 4.0, false);
        assert_eq!(d.len(), 1);
        assert_eq!(d[0].x, 4.0);
    }

    #[test]
    fn dab_pressure_is_interpolated_between_samples() {
        let mut sp = Spacer::default();
        let d = sp.feed(&[Sample { x: 0.0, y: 0.0, p: 0.0 }, Sample { x: 10.0, y: 0.0, p: 1.0 }], 5.0, false);
        assert_eq!(d.len(), 3);
        close(d[1].p, 0.5);
        close(d[2].p, 1.0);
    }

    #[test]
    fn zero_length_move_only_paints_with_airbrush() {
        let mut sp = Spacer::default();
        sp.feed(&[Sample { x: 5.0, y: 5.0, p: 1.0 }], 4.0, false);
        assert!(sp.feed(&[Sample { x: 5.0, y: 5.0, p: 1.0 }], 4.0, false).is_empty());
        assert_eq!(sp.feed(&[Sample { x: 5.0, y: 5.0, p: 1.0 }], 4.0, true).len(), 1);
    }

    #[test]
    fn flow_half_two_overlapping_dabs() {
        let s = accumulate(0.0, 1.0, 0.5, 1.0, false);
        assert_eq!(s, 0.5);
        assert_eq!(accumulate(s, 1.0, 0.5, 1.0, false), 0.75);
    }

    #[test]
    fn opacity_caps_the_stroke_after_many_dabs() {
        let mut s = 0.0;
        for _ in 0..20 {
            s = accumulate(s, 0.4, 1.0, 1.0, false);
        }
        assert_eq!(s, 0.4);
    }

    #[test]
    fn wet_edges_overlaps_do_not_darken() {
        let s = accumulate(0.0, 0.5, 1.0, 1.0, true);
        assert_eq!(s, 0.5);
        assert_eq!(accumulate(s, 0.5, 1.0, 1.0, true), 0.5);
    }
}
