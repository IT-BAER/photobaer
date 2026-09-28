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

pub static ALL: &[Spec] = &[
    Spec { exec: Exec::Global, ..entry("blur.average", "Average", "blur", blur::average) },
    Spec { exec: Exec::Local, keep_alpha: false, reach: blur::blur_reach, ..entry("blur.blur", "Blur", "blur", blur::blur) },
    Spec { exec: Exec::Local, keep_alpha: false, reach: blur::blur_more_reach, ..entry("blur.blur_more", "Blur More", "blur", blur::blur_more) },
    Spec {
        params: &[RADIUS],
        exec: Exec::Local,
        keep_alpha: false,
        reach: blur::gaussian_reach,
        ..entry("gaussian_blur", "Gaussian Blur", "blur", blur::gaussian)
    },
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
