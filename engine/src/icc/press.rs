//! Built-in CMYK profiles from a model of offset printing: four process inks on paper, with the
//! Yule-Nielsen modified Neugebauer equations in linear Rec. 2020 reflectance. B2A tables invert the
//! model per Lab grid node by Newton iteration with gray component replacement.

use super::*;
use std::cell::RefCell;
use std::collections::HashMap;

pub const COATED: &str = "Coated Offset CMYK (analytic)";
pub const UNCOATED: &str = "Uncoated Offset CMYK (analytic)";

struct Press {
    /// Solid ink reflectance (cyan, magenta, yellow, black) in linear Rec. 2020, which holds the
    /// cyan and yellow that sRGB cannot.
    inks: [[f64; 3]; 4],
    paper: [f64; 3],
    /// Dot gain at a 50% tint.
    gain: f64,
    /// Yule-Nielsen factor.
    n: f64,
    /// Total ink limit, 4.0 = 400%.
    tac: f64,
    k_max: f64,
}

const COATED_PRESS: Press = Press {
    inks: [[0.033, 0.282, 0.653], [0.443, 0.053, 0.188], [0.831, 0.751, 0.062], [0.021, 0.021, 0.021]],
    paper: [95.0, 0.0, -2.0],
    gain: 0.15,
    n: 1.6,
    tac: 3.0,
    k_max: 1.0,
};

const UNCOATED_PRESS: Press = Press {
    inks: [[0.107, 0.326, 0.682], [0.508, 0.127, 0.256], [0.828, 0.748, 0.115], [0.069, 0.066, 0.064]],
    paper: [93.0, 0.0, 1.0],
    gain: 0.22,
    n: 1.8,
    tac: 2.6,
    k_max: 0.95,
};

// Lab grid of the B2A tables; 128/255 (a = b = 0) is moved onto the middle node by the input curves.
const B2A_GRID: usize = 17;
const A2B_GRID: usize = 9;
// Inverse solutions within this Delta E are in gamut.
const IN_GAMUT: f64 = 0.5;

struct Model {
    // Neugebauer primaries (16 ink overlaps) raised to 1/n.
    prim: [[f64; 3]; 16],
    n: f64,
    gain: f64,
    m: M3,
    tac: f64,
    k_max: f64,
}

impl Model {
    fn new(p: &Press) -> Model {
        let mut prim = [[1.0; 3]; 16];
        for (corner, q) in prim.iter_mut().enumerate() {
            for (i, ink) in p.inks.iter().enumerate() {
                if corner >> i & 1 == 1 {
                    (0..3).for_each(|c| q[c] *= ink[c]);
                }
            }
            q.iter_mut().for_each(|v| *v = v.powf(1.0 / p.n));
        }
        let wide = Profile::builtin("Rec. 2020").expect("built in");
        Model { prim, n: p.n, gain: p.gain, m: wide.colorants.expect("matrix profile"), tac: p.tac, k_max: p.k_max }
    }

    // Printed ink areas -> relative D50 XYZ (bare paper is D50).
    fn xyz(&self, a: [f64; 4]) -> [f64; 3] {
        let mut r = [0.0; 3];
        for (corner, q) in self.prim.iter().enumerate() {
            let w: f64 = (0..4).map(|i| if corner >> i & 1 == 1 { a[i] } else { 1.0 - a[i] }).product();
            if w > 0.0 {
                (0..3).for_each(|c| r[c] += w * q[c]);
            }
        }
        mv(&self.m, r.map(|v| v.max(0.0).powf(self.n)))
    }

    // Device CMYK -> relative Lab.
    fn lab(&self, d: [f64; 4]) -> [f64; 3] {
        xyz_to_lab(self.xyz(d.map(|v| dot_gain(v, self.gain))))
    }

    // Newton iteration on CMY at fixed K towards `target`, from `cmy`; returns the Delta E left.
    fn solve(&self, target: [f64; 3], k: f64, cmy: &mut [f64; 3]) -> f64 {
        let de = |l: [f64; 3]| ((target[0] - l[0]).powi(2) + (target[1] - l[1]).powi(2) + (target[2] - l[2]).powi(2)).sqrt();
        let at = |c: &[f64; 3]| self.lab([c[0], c[1], c[2], k]);
        let mut cur = at(cmy);
        for _ in 0..24 {
            if de(cur) < 0.02 {
                break;
            }
            let mut j = [[0.0; 3]; 3];
            for i in 0..3 {
                let h = if cmy[i] > 0.99 { -1e-3 } else { 1e-3 };
                let mut c = *cmy;
                c[i] += h;
                let l = at(&c);
                (0..3).for_each(|r| j[r][i] = (l[r] - cur[r]) / h);
            }
            let Some(ji) = inv(&j) else { break };
            let step = mv(&ji, [0, 1, 2].map(|r| target[r] - cur[r]));
            let next = [0, 1, 2].map(|i| clamp01(cmy[i] + step[i].clamp(-0.3, 0.3)));
            let l = at(&next);
            if de(l) >= de(cur) - 1e-6 {
                break;
            }
            (*cmy, cur) = (next, l);
        }
        de(cur)
    }

    // Lab -> CMYK: CMY first, then black from the gray component where it keeps the color.
    fn separate(&self, target: [f64; 3], cmy: &mut [f64; 3]) -> ([f64; 4], f64) {
        let mut c0 = *cmy;
        let e0 = self.solve(target, 0.0, &mut c0);
        let mut best = ([c0[0], c0[1], c0[2], 0.0], e0);
        let g = c0[0].min(c0[1]).min(c0[2]);
        let mut k = if g <= 0.3 { 0.0 } else { ((g - 0.3) / 0.7).powf(1.2).min(self.k_max) };
        for _ in 0..3 {
            if k < 0.002 {
                break;
            }
            let mut c = c0.map(|v| clamp01(v - k * 0.8));
            let e = self.solve(target, k, &mut c);
            if e <= e0.max(IN_GAMUT) + 0.05 {
                best = ([c[0], c[1], c[2], k], e);
                break;
            }
            k /= 2.0;
        }
        *cmy = c0;
        let (mut d, e) = best;
        let sum = d[0] + d[1] + d[2];
        if sum + d[3] > self.tac && sum > 0.0 {
            let s = ((self.tac - d[3]).max(0.0) / sum).min(1.0);
            (0..3).for_each(|i| d[i] *= s);
        }
        (d, e)
    }

    // The darkest printable color: the ink limit spread over CMY with full black.
    fn black(&self) -> [f64; 4] {
        let t = ((self.tac - self.k_max) / 3.0).clamp(0.0, 1.0);
        [t, t, t, self.k_max]
    }
}

// Encoded Lab a/b (0..1) <-> B2A grid axis, with 128/255 on the middle node.
const MID: f64 = 128.0 / 255.0;

fn axis_in(e: f64) -> f64 {
    if e < MID { e / MID * 0.5 } else { 0.5 + (e - MID) / (1.0 - MID) * 0.5 }
}

fn axis_out(u: f64) -> f64 {
    if u < 0.5 { u * 2.0 * MID } else { MID + (u - 0.5) * 2.0 * (1.0 - MID) }
}

fn b2a(model: &Model, perceptual: bool) -> Pipe {
    let black_l = model.lab(model.black())[0];
    let mut cmy = [0.5; 3];
    let clut = Clut::from_fn(3, 4, B2A_GRID, |i, o| {
        let lab = [i[0] * 100.0, axis_out(i[1]) * 255.0 - 128.0, axis_out(i[2]) * 255.0 - 128.0];
        let (l, chroma) = if perceptual { (black_l + lab[0] * (100.0 - black_l) / 100.0, 0.85) } else { (lab[0], 1.0) };
        let at = |s: f64| [l, lab[1] * chroma * s, lab[2] * chroma * s];
        // Out of gamut, the separation is the nearest printable color (least Delta E).
        let (d, _) = model.separate(at(1.0), &mut cmy);
        o.copy_from_slice(&d);
    });
    let axis = Curve::Table((0..256).map(|k| axis_in(k as f64 / 255.0)).collect());
    Pipe { outputs: 4, elems: vec![Elem::Curves(vec![Curve::Identity, axis.clone(), axis]), Elem::Clut(Arc::new(clut))], legacy_lab: false }
}

fn build(name: &str, press: &Press) -> Profile {
    let model = Model::new(press);
    let gain = Curve::Table((0..256).map(|k| dot_gain(k as f64 / 255.0, press.gain)).collect());
    let clut = Clut::from_fn(4, 3, A2B_GRID, |i, o| {
        let lab = xyz_to_lab(model.xyz([i[0], i[1], i[2], i[3]]));
        o.copy_from_slice(&[lab[0] / 100.0, (lab[1] + 128.0) / 255.0, (lab[2] + 128.0) / 255.0]);
    });
    let a2b = Pipe { outputs: 3, elems: vec![Elem::Curves(vec![gain; 4]), Elem::Clut(Arc::new(clut))], legacy_lab: false };
    let black = model.xyz(model.black().map(|v| dot_gain(v, press.gain)));
    Profile {
        class: *b"prtr",
        pcs_lab: true,
        white: Some(lab_to_xyz(press.paper)),
        black: Some(black),
        a2b: [Some(a2b.clone()), Some(a2b.clone()), Some(a2b)],
        b2a: [Some(b2a(&model, true)), Some(b2a(&model, false)), None],
        ..Profile::empty(name, Space::Cmyk)
    }
}

thread_local! {
    static BUILT: RefCell<HashMap<&'static str, Profile>> = RefCell::new(HashMap::new());
}

/// The built-in CMYK profile `name`, built once per thread.
pub fn profile(name: &str) -> Option<Profile> {
    let (key, press) = match name {
        COATED => (COATED, &COATED_PRESS),
        UNCOATED => (UNCOATED, &UNCOATED_PRESS),
        _ => return None,
    };
    if let Some(p) = BUILT.with(|b| b.borrow().get(key).cloned()) {
        return Some(p);
    }
    let p = build(key, press);
    BUILT.with(|b| b.borrow_mut().insert(key, p.clone()));
    Some(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn de(a: [f64; 3], b: [f64; 3]) -> f64 {
        ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
    }

    fn lab_of(p: &Profile, d: &[f64]) -> [f64; 3] {
        let t = Transform::new(p, &Profile::builtin(LAB).unwrap(), Intent::Relative, false).unwrap();
        let mut o = [0.0; 3];
        t.apply(d, &mut o);
        [o[0] * 100.0, o[1] * 255.0 - 128.0, o[2] * 255.0 - 128.0]
    }

    #[test]
    fn cmyk_profiles_print_like_offset_inks() {
        for name in [COATED, UNCOATED] {
            let p = Profile::builtin(name).unwrap();
            assert_eq!((p.space, p.channels()), (Space::Cmyk, 4));
            let paper = lab_of(&p, &[0.0; 4]);
            assert!(de(paper, [100.0, 0.0, 0.0]) < 0.5, "{name} paper is the relative white: {paper:?}");
            let cyan = lab_of(&p, &[1.0, 0.0, 0.0, 0.0]);
            assert!(cyan[1] < -20.0 && cyan[2] < -30.0, "{name} cyan: {cyan:?}");
            let magenta = lab_of(&p, &[0.0, 1.0, 0.0, 0.0]);
            assert!(magenta[1] > 50.0, "{name} magenta: {magenta:?}");
            let yellow = lab_of(&p, &[0.0, 0.0, 1.0, 0.0]);
            assert!(yellow[2] > 70.0 && yellow[0] > 80.0, "{name} yellow: {yellow:?}");
            let black = lab_of(&p, &[0.0, 0.0, 0.0, 1.0]);
            assert!(black[0] < 35.0, "{name} black: {black:?}");
        }
    }

    #[test]
    fn cmyk_round_trip_keeps_in_gamut_colors_and_uses_black() {
        let p = Profile::builtin(COATED).unwrap();
        let lab = Profile::builtin(LAB).unwrap();
        let to = Transform::new(&lab, &p, Intent::Relative, false).unwrap();
        for target in [[50.0, 0.0, 0.0], [70.0, 20.0, 30.0], [40.0, -20.0, -30.0], [85.0, -5.0, 60.0], [25.0, 0.0, 0.0]] {
            let mut d = [0.0; 4];
            to.apply(&[target[0] / 100.0, (target[1] + 128.0) / 255.0, (target[2] + 128.0) / 255.0], &mut d);
            assert!(d.iter().sum::<f64>() <= 3.0 + 1e-6, "{target:?}: ink limit {d:?}");
            let back = lab_of(&p, &d);
            assert!(de(back, target) < 2.0, "{target:?} -> {d:?} -> {back:?}");
        }
        let mut gray = [0.0; 4];
        to.apply(&[0.3, MID, MID], &mut gray);
        assert!(gray[3] > 0.2, "dark neutrals use black ink: {gray:?}");
    }

    #[test]
    fn out_of_gamut_colors_keep_their_hue() {
        // sRGB pure blue is far outside offset print: the separation keeps it blue, not cyan or purple.
        let s = Profile::builtin(SRGB).unwrap();
        let p = Profile::builtin(COATED).unwrap();
        let mut d = [0.0; 4];
        Transform::new(&s, &p, Intent::Relative, true).unwrap().apply(&[0.0, 0.0, 1.0], &mut d);
        assert!(d[0] > 0.6 && d[1] > 0.6 && d[2] < 0.15, "blue separates as cyan + magenta: {d:?}");
    }
}
