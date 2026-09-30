//! The registry table in reference menu order within each group (docs/M5.md section 14).

use super::{blur, stylize, Ctx, Def, Exec, Filter, PKind, Param, Plane, Spec};
use crate::adjust;

const fn none(_: &Filter) -> i32 {
    0
}

const fn entry(id: &'static str, label: &'static str, group: &'static str, apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>) -> Spec {
    Spec { id, label, group, params: &[], exec: Exec::Point, keep_alpha: true, preview: true, rgb_only: false, adjustment: false, reach: none, apply }
}

const fn adjustment(id: &'static str, label: &'static str) -> Spec {
    Spec { adjustment: true, ..entry(id, label, "adjust", apply_adjustment) }
}

// The M3 adjustment kinds run per pixel through their compiled opcode, alpha kept.
fn apply_adjustment(p: &mut Plane, f: &Filter, ctx: &Ctx) -> Result<(), String> {
    let a = f.adjustment().ok_or_else(|| format!("{} has invalid params", f.kind))?;
    let Some(k) = a.compile(ctx.blobs)? else { return Ok(()) };
    for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
        let (x, y) = (p.x + (i % p.w) as i32, p.y + (i / p.w) as i32);
        let c = adjust::apply(k.opcode, &k.data, [px[0], px[1], px[2]], x as u32, y as u32);
        px[..3].copy_from_slice(&c);
    }
    Ok(())
}

const RADIUS: Param = Param { key: "radius", label: "Radius", kind: PKind::Number, min: 0.1, max: 250.0, step: 0.1, unit: "px", default: Def::Num(1.0) };

const fn num(key: &'static str, label: &'static str, min: f64, max: f64, step: f64, unit: &'static str, default: f64) -> Param {
    Param { key, label, kind: PKind::Number, min, max, step, unit, default: Def::Num(default) }
}

const fn px(key: &'static str, label: &'static str, min: f64, max: f64, step: f64, default: f64) -> Param {
    num(key, label, min, max, step, "px", default)
}

const fn int(key: &'static str, label: &'static str, min: f64, max: f64, default: f64) -> Param {
    Param { kind: PKind::Int, ..num(key, label, min, max, 1.0, "", default) }
}

const fn pct(key: &'static str, label: &'static str, default: f64) -> Param {
    Param { kind: PKind::Percent, ..num(key, label, 0.0, 100.0, 1.0, "%", default) }
}

const fn angle(key: &'static str, label: &'static str, default: f64) -> Param {
    Param { kind: PKind::Angle, ..num(key, label, -360.0, 360.0, 1.0, "°", default) }
}

const fn select(key: &'static str, label: &'static str, choices: &'static [&'static str], default: &'static str) -> Param {
    Param { kind: PKind::Select(choices), default: Def::Str(default), ..num(key, label, 0.0, 0.0, 0.0, "", 0.0) }
}

const fn flag(key: &'static str, label: &'static str) -> Param {
    Param { kind: PKind::Bool, default: Def::Bool(false), ..num(key, label, 0.0, 0.0, 0.0, "", 0.0) }
}

const fn point(key: &'static str, label: &'static str) -> Param {
    Param { kind: PKind::Point, default: Def::Point(0.5, 0.5), ..num(key, label, 0.0, 1.0, 0.01, "", 0.0) }
}

const SEED: Param = Param { kind: PKind::Seed, ..num("seed", "Seed", 0.0, u32::MAX as f64, 1.0, "", 0.0) };

const fn local(id: &'static str, label: &'static str, params: &'static [Param], reach: fn(&Filter) -> i32, apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>) -> Spec {
    Spec { params, exec: Exec::Local, keep_alpha: false, reach, ..entry(id, label, "blur", apply) }
}

pub static ALL: &[Spec] = &[
    Spec { exec: Exec::Global, ..entry("blur.average", "Average", "blur", blur::average) },
    Spec { exec: Exec::Local, keep_alpha: false, reach: blur::blur_reach, ..entry("blur.blur", "Blur", "blur", blur::blur) },
    Spec { exec: Exec::Local, keep_alpha: false, reach: blur::blur_more_reach, ..entry("blur.blur_more", "Blur More", "blur", blur::blur_more) },
    local("blur.box_blur", "Box Blur", &[px("radius", "Radius", 1.0, 999.0, 1.0, 4.0)], blur::box_reach, blur::boxed),
    local("gaussian_blur", "Gaussian Blur", &[RADIUS], blur::gaussian_reach, blur::gaussian),
    local(
        "blur.lens_blur",
        "Lens Blur",
        &[
            select("depthMapSource", "Source", &["none", "transparency", "layerMask"], "none"),
            int("blurFocalDistance", "Blur Focal Distance", 0.0, 255.0, 0.0),
            flag("invertDepthMap", "Invert"),
            select("irisShape", "Shape", &["triangle", "square", "pentagon", "hexagon", "heptagon", "octagon"], "hexagon"),
            px("radius", "Radius", 0.0, 100.0, 1.0, 15.0),
            pct("bladeCurvature", "Blade Curvature", 0.0),
            angle("rotation", "Rotation", 0.0),
            pct("specularBrightness", "Brightness", 0.0),
            int("specularThreshold", "Threshold", 0.0, 255.0, 255.0),
            pct("noiseAmount", "Amount", 0.0),
            select("noiseDistribution", "Distribution", &["uniform", "gaussian"], "uniform"),
            flag("monochromaticNoise", "Monochromatic"),
            SEED,
        ],
        blur::lens_reach,
        blur::lens,
    ),
    local("blur.motion_blur", "Motion Blur", &[angle("angle", "Angle", 0.0), px("distance", "Distance", 1.0, 2000.0, 1.0, 10.0)], blur::motion_reach, blur::motion),
    Spec {
        exec: Exec::Global,
        ..local(
            "blur.radial_blur",
            "Radial Blur",
            &[
                int("amount", "Amount", 1.0, 100.0, 10.0),
                select("method", "Blur Method", &["spin", "zoom"], "spin"),
                select("quality", "Quality", &["draft", "good", "best"], "good"),
                point("center", "Blur Center"),
            ],
            none,
            blur::radial,
        )
    },
    local(
        "blur.shape_blur",
        "Shape Blur",
        &[
            px("radius", "Radius", 1.0, 1000.0, 1.0, 5.0),
            select("shape", "Shape", &["circle", "square", "diamond", "triangle", "hexagon", "cross", "star", "ring"], "circle"),
        ],
        blur::shape_reach,
        blur::shape,
    ),
    local(
        "blur.smart_blur",
        "Smart Blur",
        &[
            px("radius", "Radius", 0.1, 100.0, 0.1, 3.0),
            num("threshold", "Threshold", 0.1, 100.0, 0.1, "", 25.0),
            select("quality", "Quality", &["low", "medium", "high"], "high"),
            select("mode", "Mode", &["normal", "edgeOnly", "overlayEdge"], "normal"),
        ],
        blur::smart_reach,
        blur::smart,
    ),
    local(
        "blur.surface_blur",
        "Surface Blur",
        &[px("radius", "Radius", 1.0, 100.0, 1.0, 5.0), int("threshold", "Threshold", 2.0, 255.0, 15.0)],
        blur::surface_reach,
        blur::surface_blur,
    ),
    entry("stylize.solarize", "Solarize", "stylize", stylize::solarize),
    adjustment("brightness_contrast", "Brightness/Contrast"),
    adjustment("levels", "Levels"),
    adjustment("curves", "Curves"),
    adjustment("exposure", "Exposure"),
    adjustment("vibrance", "Vibrance"),
    adjustment("hue_saturation", "Hue/Saturation"),
    adjustment("color_balance", "Color Balance"),
    adjustment("black_white", "Black & White"),
    adjustment("photo_filter", "Photo Filter"),
    adjustment("channel_mixer", "Channel Mixer"),
    adjustment("color_lookup", "Color Lookup"),
    adjustment("invert", "Invert"),
    adjustment("posterize", "Posterize"),
    adjustment("threshold", "Threshold"),
    adjustment("gradient_map", "Gradient Map"),
    adjustment("selective_color", "Selective Color"),
];

pub fn lookup(id: &str) -> Option<&'static Spec> {
    ALL.iter().find(|s| s.id == id)
}
