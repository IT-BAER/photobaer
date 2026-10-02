//! The registry table in reference menu order within each group (docs/M5.md section 14).

use super::{blur, blur_gallery, distort, gallery, noise, other, pixelate, render, sharpen, stylize, Ctx, Def, Exec, Filter, PKind, Param, Plane, Spec};
use crate::adjust;

const fn none(_: &Filter) -> i32 {
    0
}

const fn entry(id: &'static str, label: &'static str, group: &'static str, apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>) -> Spec {
    Spec { id, label, group, params: &[], exec: Exec::Point, keep_alpha: true, preview: true, rgb_only: false, adjustment: false, reach: none, extent: None, apply }
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

// A neighborhood filter that changes color only.
const fn kept(id: &'static str, label: &'static str, group: &'static str, params: &'static [Param], reach: fn(&Filter) -> i32, apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>) -> Spec {
    Spec { params, exec: Exec::Local, reach, ..entry(id, label, group, apply) }
}

const fn amount(key: &'static str, label: &'static str, min: f64, max: f64, step: f64, default: f64) -> Param {
    Param { kind: PKind::Percent, ..num(key, label, min, max, step, "%", default) }
}

const fn global(id: &'static str, label: &'static str, group: &'static str, params: &'static [Param], apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>) -> Spec {
    Spec { params, exec: Exec::Global, keep_alpha: false, ..entry(id, label, group, apply) }
}

const fn kernel(key: &'static str, label: &'static str) -> Param {
    Param { kind: PKind::Kernel, default: Def::Kernel, ..num(key, label, -999.0, 999.0, 1.0, "", 0.0) }
}

const fn curve(key: &'static str, label: &'static str) -> Param {
    Param { kind: PKind::Curve, default: Def::Curve, ..num(key, label, -1.0, 1.0, 0.01, "", 0.0) }
}

const fn color(key: &'static str, label: &'static str, default: &'static str) -> Param {
    Param { kind: PKind::Color, default: Def::Color(default), ..num(key, label, 0.0, 0.0, 0.0, "", 0.0) }
}

const FG: Param = color("foreground", "Foreground", "#000000");
const BG: Param = color("background", "Background", "#ffffff");

// Draws over the document rect (filter_run), so it also works on an empty layer.
const fn render(id: &'static str, label: &'static str, params: &'static [Param], apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>) -> Spec {
    Spec { rgb_only: true, ..global(id, label, "render", params, apply) }
}

const fn noise_render(id: &'static str, label: &'static str, params: &'static [Param], apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>) -> Spec {
    Spec { preview: false, rgb_only: false, ..render(id, label, params, apply) }
}

const fn ranged(key: &'static str, label: &'static str, min: f64, max: f64, default: f64) -> Param {
    Param { kind: PKind::Int, ..num(key, label, min, max, 1.0, "", default) }
}

const UNDEFINED: Param = select("undefinedAreas", "Undefined Areas", &["wrapAround", "repeatEdgePixels"], "repeatEdgePixels");
const PRESERVE: Param = select("preserve", "Preserve", &["squareness", "roundness"], "squareness");

// A blur gallery filter's own params, then the shared bokeh, grain and strobe settings and the seed.
macro_rules! gallery_params {
    ($($p:expr),* $(,)?) => {
        &[
            $($p,)*
            pct("lightBokeh", "Light Bokeh", 0.0),
            pct("bokehColor", "Bokeh Color", 0.0),
            int("lightRangeMin", "Light Range Min", 0.0, 255.0, 0.0),
            int("lightRangeMax", "Light Range Max", 0.0, 255.0, 255.0),
            pct("noiseAmount", "Noise Amount", 0.0),
            select("noiseDistribution", "Distribution", &["uniform", "gaussian"], "gaussian"),
            pct("noiseSize", "Grain Size", 50.0),
            pct("noiseColor", "Grain Color", 0.0),
            pct("noiseHighlights", "Grain Highlights", 100.0),
            pct("strobeStrength", "Strobe Strength", 50.0),
            int("strobeFlashes", "Strobe Flashes", 1.0, 100.0, 1.0),
            SEED,
        ]
    };
}

const fn gallery(id: &'static str, label: &'static str, params: &'static [Param], reach: fn(&Filter) -> i32, apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>) -> Spec {
    Spec { group: "blurGallery", ..local(id, label, params, reach, apply) }
}

const fn frac(key: &'static str, label: &'static str, min: f64, max: f64, default: f64) -> Param {
    num(key, label, min, max, 0.01, "", default)
}

const GALLERY_BLUR: Param = px("blur", "Blur", 0.0, 500.0, 1.0, 15.0);
const SIZE: Param = frac("radius", "Size", 0.01, 2.0, 0.4);
const ASPECT: Param = frac("aspect", "Aspect", 0.1, 10.0, 1.0);

// A Filter Gallery effect: its params, then the seed and colors the gallery filter passes in.
macro_rules! fx {
    ($id:literal, $label:literal, $group:literal, [$($p:expr),* $(,)?]) => {
        global(concat!("gallery.", $group, ".", $id), $label, concat!("gallery.", $group), &[$($p,)* SEED, FG, BG], gallery::effect)
    };
}

const fn r(key: &'static str, label: &'static str, min: f64, max: f64, default: f64) -> Param {
    ranged(key, label, min, max, default)
}

const LIGHTS: &[&str] = &["top", "topLeft", "left", "bottomLeft", "bottom", "bottomRight", "right", "topRight"];
const STROKE_DIRS: &[&str] = &["rightDiagonal", "horizontal", "leftDiagonal", "vertical"];
const TEX: Param = select("texture", "Texture", &["brick", "burlap", "canvas", "sandstone"], "canvas");
const SCALING: Param = Param { unit: "%", ..ranged("scaling", "Scaling", 50.0, 200.0, 100.0) };
const LIGHT: Param = select("lightDirection", "Light", LIGHTS, "top");
const INVERT: Param = ranged("invertTexture", "Invert", 0.0, 1.0, 0.0);
const RELIEF: Param = ranged("relief", "Relief", 0.0, 50.0, 4.0);

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
    gallery(
        "blur_gallery.field_blur",
        "Field Blur",
        gallery_params![Param { kind: PKind::Pins, default: Def::Pins(&[(0.5, 0.5, 15.0)]), ..num("pins", "Pins", 0.0, 1000.0, 1.0, "px", 0.0) }],
        blur_gallery::field_reach,
        blur_gallery::field,
    ),
    gallery(
        "blur_gallery.iris_blur",
        "Iris Blur",
        gallery_params![
            point("center", "Center"),
            GALLERY_BLUR,
            frac("feather", "Feather", 0.0, 1.0, 0.5),
            frac("roundness", "Roundness", 0.0, 1.0, 0.0),
            ASPECT,
            angle("rotation", "Rotation", 0.0),
            SIZE,
        ],
        blur_gallery::blur_reach,
        blur_gallery::iris_blur,
    ),
    gallery(
        "blur_gallery.tilt_shift",
        "Tilt-Shift",
        gallery_params![
            point("center", "Center"),
            GALLERY_BLUR,
            angle("rotation", "Rotation", 0.0),
            frac("focusWidth", "Focus", 0.0, 1.0, 0.15),
            frac("featherWidth", "Feather", 0.0, 2.0, 0.25),
            frac("distortion", "Distortion", -1.0, 1.0, 0.0),
            flag("symmetricDistortion", "Symmetric Distortion"),
        ],
        blur_gallery::tilt_reach,
        blur_gallery::tilt_shift,
    ),
    Spec {
        exec: Exec::Global,
        ..gallery(
            "blur_gallery.path_blur",
            "Path Blur",
            gallery_params![
                Param { kind: PKind::Paths, default: Def::Paths(&[&[(0.2, 0.5), (0.8, 0.5)]]), ..num("paths", "Paths", 0.0, 1.0, 0.01, "", 0.0) },
                amount("speed", "Speed", 0.0, 500.0, 1.0, 50.0),
                pct("taper", "Taper", 0.0),
                amount("endPointSpeedStart", "End Point Speed (start)", 0.0, 500.0, 1.0, 100.0),
                amount("endPointSpeedEnd", "End Point Speed (end)", 0.0, 500.0, 1.0, 100.0),
                Param { default: Def::Bool(true), ..flag("centeredBlur", "Centered Blur") },
                select("blurShape", "Blur Shape", &["basic", "rearSync"], "basic"),
            ],
            none,
            blur_gallery::path_blur,
        )
    },
    Spec {
        exec: Exec::Global,
        ..gallery(
            "blur_gallery.spin_blur",
            "Spin Blur",
            gallery_params![point("center", "Center"), angle("blurAngle", "Blur Angle", 15.0), SIZE, ASPECT, frac("feather", "Feather", 0.0, 1.0, 0.4)],
            none,
            blur_gallery::spin_blur,
        )
    },
    global(
        "distort.displace",
        "Displace",
        "distort",
        &[
            amount("horizontalScale", "Horizontal Scale", -999.0, 999.0, 1.0, 10.0),
            amount("verticalScale", "Vertical Scale", -999.0, 999.0, 1.0, 10.0),
            select("displacementMap", "Displacement Map", &["stretchToFit", "tile"], "stretchToFit"),
            UNDEFINED,
        ],
        distort::displace,
    ),
    global("distort.pinch", "Pinch", "distort", &[amount("amount", "Amount", -100.0, 100.0, 1.0, 50.0)], distort::pinch),
    global("distort.polar_coordinates", "Polar Coordinates", "distort", &[select("conversion", "Conversion", &["rectToPolar", "polarToRect"], "rectToPolar")], distort::polar),
    global(
        "distort.ripple",
        "Ripple",
        "distort",
        &[amount("amount", "Amount", -999.0, 999.0, 1.0, 100.0), select("size", "Size", &["small", "medium", "large"], "medium")],
        distort::ripple,
    ),
    global("distort.shear", "Shear", "distort", &[curve("shearCurve", "Shear Curve"), UNDEFINED], distort::shear),
    global(
        "distort.spherize",
        "Spherize",
        "distort",
        &[amount("amount", "Amount", -100.0, 100.0, 1.0, 100.0), select("mode", "Mode", &["normal", "horizontalOnly", "verticalOnly"], "normal")],
        distort::spherize,
    ),
    global("distort.twirl", "Twirl", "distort", &[Param { min: -999.0, max: 999.0, ..angle("angle", "Angle", 50.0) }], distort::twirl),
    global(
        "distort.wave",
        "Wave",
        "distort",
        &[
            int("generators", "Number of Generators", 1.0, 999.0, 5.0),
            int("wavelengthMin", "Wavelength Min", 1.0, 9999.0, 10.0),
            int("wavelengthMax", "Wavelength Max", 1.0, 9999.0, 120.0),
            int("amplitudeMin", "Amplitude Min", 1.0, 9999.0, 5.0),
            int("amplitudeMax", "Amplitude Max", 1.0, 9999.0, 35.0),
            amount("horizontalScale", "Horizontal Scale", 1.0, 100.0, 1.0, 100.0),
            amount("verticalScale", "Vertical Scale", 1.0, 100.0, 1.0, 100.0),
            select("type", "Type", &["sine", "triangle", "square"], "sine"),
            int("randomize", "Randomize", 0.0, 999999.0, 0.0),
            UNDEFINED,
        ],
        distort::wave,
    ),
    global(
        "distort.zigzag",
        "ZigZag",
        "distort",
        &[num("amount", "Amount", -100.0, 100.0, 1.0, "", 10.0), int("ridges", "Ridges", 0.0, 20.0, 5.0), select("style", "Style", &["pondRipples", "outFromCenter", "aroundCenter"], "pondRipples")],
        distort::zigzag,
    ),
    Spec {
        params: &[
            amount("amount", "Amount", 0.1, 400.0, 0.1, 12.5),
            select("distribution", "Distribution", &["uniform", "gaussian"], "uniform"),
            flag("monochromatic", "Monochromatic"),
            SEED,
        ],
        ..entry("noise.add_noise", "Add Noise", "noise", noise::add_noise)
    },
    kept("noise.despeckle", "Despeckle", "noise", &[], sharpen::one, noise::despeckle),
    kept(
        "noise.dust_and_scratches",
        "Dust & Scratches",
        "noise",
        &[px("radius", "Radius", 1.0, 100.0, 1.0, 1.0), int("threshold", "Threshold", 0.0, 255.0, 0.0)],
        noise::radius_reach,
        noise::dust_and_scratches,
    ),
    Spec { group: "noise", ..local("noise.median", "Median", &[px("radius", "Radius", 1.0, 500.0, 1.0, 1.0)], noise::radius_reach, noise::median_filter) },
    kept(
        "noise.reduce_noise",
        "Reduce Noise",
        "noise",
        &[
            num("strength", "Strength", 0.0, 10.0, 1.0, "", 5.0),
            pct("preserveDetails", "Preserve Details", 60.0),
            pct("reduceColorNoise", "Reduce Color Noise", 45.0),
            pct("sharpenDetails", "Sharpen Details", 25.0),
            flag("removeJpegArtifact", "Remove JPEG Artifact"),
            num("redStrength", "Red Strength", 0.0, 10.0, 1.0, "", 0.0),
            num("greenStrength", "Green Strength", 0.0, 10.0, 1.0, "", 0.0),
            num("blueStrength", "Blue Strength", 0.0, 10.0, 1.0, "", 0.0),
        ],
        noise::reduce_reach,
        noise::reduce_noise,
    ),
    kept(
        "pixelate.color_halftone",
        "Color Halftone",
        "pixelate",
        &[
            px("maxRadius", "Max Radius", 4.0, 127.0, 1.0, 8.0),
            Param { min: 0.0, ..angle("channel1", "Channel 1", 108.0) },
            Param { min: 0.0, ..angle("channel2", "Channel 2", 162.0) },
            Param { min: 0.0, ..angle("channel3", "Channel 3", 90.0) },
            Param { min: 0.0, ..angle("channel4", "Channel 4", 45.0) },
        ],
        pixelate::halftone_reach,
        pixelate::color_halftone,
    ),
    kept("pixelate.crystallize", "Crystallize", "pixelate", &[px("cellSize", "Cell Size", 3.0, 300.0, 1.0, 10.0), SEED], pixelate::voronoi_reach, pixelate::crystallize),
    kept("pixelate.facet", "Facet", "pixelate", &[], pixelate::one, pixelate::facet),
    kept("pixelate.fragment", "Fragment", "pixelate", &[], pixelate::four, pixelate::fragment),
    Spec {
        params: &[
            select(
                "type",
                "Type",
                &["fineDots", "mediumDots", "grainyDots", "coarseDots", "shortLines", "mediumLines", "longLines", "shortStrokes", "mediumStrokes", "longStrokes"],
                "mediumDots",
            ),
            SEED,
        ],
        ..entry("pixelate.mezzotint", "Mezzotint", "pixelate", pixelate::mezzotint)
    },
    kept("pixelate.mosaic", "Mosaic", "pixelate", &[px("cellSize", "Cell Size", 1.0, 200.0, 1.0, 10.0)], pixelate::mosaic_reach, pixelate::mosaic),
    kept("pixelate.pointillize", "Pointillize", "pixelate", &[px("cellSize", "Cell Size", 3.0, 300.0, 1.0, 5.0), SEED], pixelate::voronoi_reach, pixelate::pointillize),
    noise_render("render.clouds", "Clouds", &[FG, BG, SEED], render::clouds),
    noise_render("render.difference_clouds", "Difference Clouds", &[FG, BG, SEED], render::difference_clouds),
    noise_render("render.fibers", "Fibers", &[FG, BG, int("variance", "Variance", 1.0, 64.0, 16.0), int("strength", "Strength", 1.0, 64.0, 4.0), SEED], render::fibers),
    render(
        "render.lens_flare",
        "Lens Flare",
        &[amount("brightness", "Brightness", 10.0, 300.0, 1.0, 100.0), select("lensType", "Lens Type", &["zoom50to300", "prime35", "prime105", "moviePrime"], "zoom50to300"), point("center", "Flare Center")],
        render::lens_flare,
    ),
    Spec {
        keep_alpha: true,
        ..render(
            "render.lighting_effects",
            "Lighting Effects",
            &[
                Param { kind: PKind::Lights, default: Def::Lights, ..num("lights", "Lights", 0.0, 0.0, 0.0, "", 0.0) },
                select("textureChannel", "Texture", &["none", "red", "green", "blue", "luminance"], "none"),
                ranged("textureHeight", "Height", 1.0, 100.0, 50.0),
                flag("invertTexture", "Invert Texture"),
                ranged("gloss", "Gloss", -100.0, 100.0, 0.0),
                ranged("material", "Material", -100.0, 100.0, 0.0),
                ranged("exposure", "Exposure", -100.0, 100.0, 0.0),
                ranged("ambience", "Ambience", -100.0, 100.0, 20.0),
            ],
            render::lighting_effects,
        )
    },
    render(
        "render.flame",
        "Flame",
        &[
            select("flameType", "Flame Type", &["oneFlameAlongPath", "multipleFlamesOnePath", "multipleFlamesPathDirection", "multipleFlamesVarious", "candle", "arc"], "multipleFlamesOnePath"),
            Param { kind: PKind::Path, default: Def::Path(&[(0.15, 0.8), (0.85, 0.8)]), ..num("path", "Path", 0.0, 1.0, 0.01, "", 0.0) },
            ranged("length", "Length", 1.0, 1000.0, 100.0),
            ranged("width", "Width", 1.0, 1000.0, 100.0),
            angle("angle", "Angle", 0.0),
            ranged("interval", "Interval", 1.0, 100.0, 30.0),
            amount("opacity", "Opacity", 1.0, 100.0, 1.0, 100.0),
            ranged("flameLines", "Flame Lines (Complexity)", 1.0, 100.0, 20.0),
            ranged("turbulentAmount", "Turbulent", 1.0, 10.0, 5.0),
            ranged("jagAmount", "Jag", 1.0, 10.0, 3.0),
            flag("useCustomColor", "Use Custom Color For Flames"),
            FG,
            SEED,
        ],
        render::flame,
    ),
    render(
        "render.picture_frame",
        "Picture Frame",
        &[
            select("frameType", "Frame", &["simple", "doubleLine", "beads", "ivy", "ribbon", "scallop"], "simple"),
            amount("margin", "Margin", 0.0, 40.0, 1.0, 8.0),
            amount("frameWidth", "Frame Width", 1.0, 40.0, 1.0, 6.0),
            select("frameColor", "Frame Color", &["walnut", "gilt", "black", "white"], "walnut"),
            select("matteColor", "Matte Color", &["cream", "white", "charcoal"], "cream"),
            pct("ornamentDensity", "Ornament Density", 40.0),
            select("arrangement", "Arrangement", &["all", "horizontal", "vertical"], "all"),
        ],
        render::picture_frame,
    ),
    render(
        "render.tree",
        "Tree",
        &[
            select("treeType", "Base Tree Type", &["maple", "birch", "poplar", "oak", "willow", "pine"], "maple"),
            Param { min: 0.0, ..angle("lightDirection", "Light Direction", 135.0) },
            pct("leavesAmount", "Leaves Amount", 60.0),
            pct("leavesSize", "Leaves Size", 50.0),
            pct("branchesHeight", "Branches Height", 60.0),
            pct("branchesThickness", "Branches Thickness", 40.0),
            flag("defoliate", "Defoliate"),
            flag("randomizeShapes", "Randomize Shapes"),
            int("arrangement", "Arrangement", 0.0, 999.0, 0.0),
        ],
        render::tree,
    ),
    kept("sharpen.sharpen", "Sharpen", "sharpen", &[], sharpen::one, sharpen::sharpen),
    kept("sharpen.sharpen_edges", "Sharpen Edges", "sharpen", &[], sharpen::one, sharpen::sharpen_edges),
    kept("sharpen.sharpen_more", "Sharpen More", "sharpen", &[], sharpen::one, sharpen::sharpen_more),
    kept(
        "sharpen.smart_sharpen",
        "Smart Sharpen",
        "sharpen",
        &[
            amount("amount", "Amount", 1.0, 500.0, 1.0, 150.0),
            px("radius", "Radius", 0.1, 64.0, 0.1, 1.0),
            pct("reduceNoise", "Reduce Noise", 20.0),
            select("remove", "Remove", &["gaussianBlur", "lensBlur", "motionBlur"], "lensBlur"),
            angle("angle", "Angle", 0.0),
            pct("fadeAmountShadow", "Shadow Fade Amount", 0.0),
            pct("tonalWidthShadow", "Shadow Tonal Width", 50.0),
            px("radiusShadow", "Shadow Radius", 1.0, 100.0, 1.0, 1.0),
            pct("fadeAmountHighlight", "Highlight Fade Amount", 0.0),
            pct("tonalWidthHighlight", "Highlight Tonal Width", 50.0),
            px("radiusHighlight", "Highlight Radius", 1.0, 100.0, 1.0, 1.0),
        ],
        sharpen::smart_reach,
        sharpen::smart_sharpen,
    ),
    kept(
        "sharpen.unsharp_mask",
        "Unsharp Mask",
        "sharpen",
        &[amount("amount", "Amount", 1.0, 500.0, 1.0, 50.0), px("radius", "Radius", 0.1, 1000.0, 0.1, 1.0), int("threshold", "Threshold", 0.0, 255.0, 0.0)],
        sharpen::unsharp_reach,
        sharpen::unsharp,
    ),
    kept(
        "stylize.diffuse",
        "Diffuse",
        "stylize",
        &[select("mode", "Mode", &["normal", "darkenOnly", "lightenOnly", "anisotropic"], "normal"), SEED],
        pixelate::one,
        stylize::diffuse,
    ),
    kept("stylize.emboss", "Emboss", "stylize", &[angle("angle", "Angle", 135.0), px("height", "Height", 1.0, 100.0, 1.0, 3.0), amount("amount", "Amount", 1.0, 500.0, 1.0, 100.0)], stylize::emboss_reach, stylize::emboss),
    Spec {
        keep_alpha: true,
        ..global(
            "stylize.extrude",
            "Extrude",
            "stylize",
            &[
                select("type", "Type", &["blocks", "pyramids"], "blocks"),
                px("size", "Size", 2.0, 255.0, 1.0, 30.0),
                int("depth", "Depth", 1.0, 255.0, 30.0),
                select("depthMode", "Depth", &["random", "level"], "random"),
                flag("solidFrontFaces", "Solid Front Faces"),
                flag("maskIncompleteBlocks", "Mask Incomplete Blocks"),
                SEED,
            ],
            stylize::extrude,
        )
    },
    kept("stylize.find_edges", "Find Edges", "stylize", &[], pixelate::one, stylize::find_edges),
    kept(
        "stylize.oil_paint",
        "Oil Paint",
        "stylize",
        &[
            num("stylization", "Stylization", 0.1, 10.0, 0.1, "", 5.0),
            num("cleanliness", "Cleanliness", 0.0, 10.0, 0.1, "", 5.0),
            num("scale", "Scale", 0.1, 10.0, 0.1, "", 1.0),
            num("bristleDetail", "Bristle Detail", 0.0, 10.0, 0.1, "", 5.0),
            angle("angularDirection", "Angular Direction", 0.0),
            num("shine", "Shine", 0.0, 10.0, 0.1, "", 1.0),
        ],
        stylize::oil_reach,
        stylize::oil_paint,
    ),
    entry("stylize.solarize", "Solarize", "stylize", stylize::solarize),
    Spec {
        keep_alpha: true,
        ..global(
            "stylize.tiles",
            "Tiles",
            "stylize",
            &[
                int("numberOfTiles", "Number of Tiles", 1.0, 99.0, 10.0),
                amount("maxOffset", "Maximum Offset", 1.0, 99.0, 1.0, 10.0),
                select("fillEmptyAreaWith", "Fill Empty Area With", &["background", "foreground", "inverseImage", "unalteredImage"], "background"),
                SEED,
            ],
            stylize::tiles,
        )
    },
    kept(
        "stylize.trace_contour",
        "Trace Contour",
        "stylize",
        &[int("level", "Level", 0.0, 255.0, 128.0), select("edge", "Edge", &["lower", "upper"], "lower")],
        pixelate::one,
        stylize::trace_contour,
    ),
    kept(
        "stylize.wind",
        "Wind",
        "stylize",
        &[select("method", "Method", &["wind", "blast", "stagger"], "wind"), select("direction", "Direction", &["fromTheLeft", "fromTheRight"], "fromTheRight"), SEED],
        stylize::wind_reach,
        stylize::wind,
    ),
    global(
        "video.de_interlace",
        "De-Interlace",
        "video",
        &[select("eliminate", "Eliminate", &["oddFields", "evenFields"], "oddFields"), select("createNewFields", "Create New Fields by", &["duplication", "interpolation"], "interpolation")],
        other::de_interlace,
    ),
    entry("video.ntsc_colors", "NTSC Colors", "video", other::ntsc_colors),
    kept("other.custom", "Custom", "other", &[kernel("kernel", "Kernel"), int("scale", "Scale", -9999.0, 9999.0, 1.0), int("offset", "Offset", -9999.0, 9999.0, 0.0)], other::two, other::custom),
    Spec {
        params: &[select("input", "Input", &["rgb", "hsb", "hsl"], "rgb"), select("output", "Output", &["rgb", "hsb", "hsl"], "hsb")],
        ..entry("other.hsb_hsl", "HSB/HSL", "other", other::hsb_hsl)
    },
    kept("other.high_pass", "High Pass", "other", &[px("radius", "Radius", 0.1, 1000.0, 0.1, 10.0)], blur::gaussian_reach, other::high_pass),
    Spec { keep_alpha: false, ..kept("other.maximum", "Maximum", "other", &[px("radius", "Radius", 1.0, 500.0, 1.0, 1.0), PRESERVE], noise::radius_reach, other::maximum) },
    Spec { keep_alpha: false, ..kept("other.minimum", "Minimum", "other", &[px("radius", "Radius", 1.0, 500.0, 1.0, 1.0), PRESERVE], noise::radius_reach, other::minimum) },
    global(
        "other.offset",
        "Offset",
        "other",
        &[
            Param { unit: "px", ..int("horizontal", "Horizontal", -30000.0, 30000.0, 0.0) },
            Param { unit: "px", ..int("vertical", "Vertical", -30000.0, 30000.0, 0.0) },
            select("undefinedAreas", "Undefined Areas", &["setToBackground", "repeatEdgePixels", "wrapAround"], "wrapAround"),
        ],
        other::offset,
    ),
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
    Spec {
        params: &[Param { kind: PKind::Stack, default: Def::Stack, ..num("stack", "Effect Layers", 0.0, 64.0, 1.0, "", 0.0) }, SEED, FG, BG],
        ..global("gallery.filter_gallery", "Filter Gallery", "gallery", &[], gallery::filter_gallery)
    },
    fx!("colored_pencil", "Colored Pencil", "artistic", [r("pencilWidth", "Pencil Width", 1.0, 24.0, 4.0), r("strokePressure", "Stroke Pressure", 0.0, 15.0, 8.0), r("paperBrightness", "Paper Brightness", 0.0, 50.0, 25.0)]),
    fx!("cutout", "Cutout", "artistic", [r("levels", "No. of Levels", 2.0, 8.0, 4.0), r("edgeSimplicity", "Edge Simplicity", 0.0, 10.0, 4.0), r("edgeFidelity", "Edge Fidelity", 1.0, 3.0, 2.0)]),
    fx!("dry_brush", "Dry Brush", "artistic", [r("brushSize", "Brush Size", 0.0, 10.0, 2.0), r("brushDetail", "Brush Detail", 0.0, 10.0, 8.0), r("texture", "Texture", 1.0, 3.0, 1.0)]),
    fx!("film_grain", "Film Grain", "artistic", [r("grain", "Grain", 0.0, 20.0, 4.0), r("highlightArea", "Highlight Area", 0.0, 20.0, 0.0), r("intensity", "Intensity", 0.0, 10.0, 10.0)]),
    fx!("fresco", "Fresco", "artistic", [r("brushSize", "Brush Size", 0.0, 10.0, 2.0), r("brushDetail", "Brush Detail", 0.0, 10.0, 8.0), r("texture", "Texture", 1.0, 3.0, 1.0)]),
    fx!("neon_glow", "Neon Glow", "artistic", [r("glowSize", "Size", -24.0, 24.0, 5.0), r("glowBrightness", "Brightness", 0.0, 50.0, 15.0), select("glowColor", "Glow Color", &["blue", "magenta", "green", "amber"], "blue")]),
    fx!("paint_daubs", "Paint Daubs", "artistic", [r("brushSize", "Brush Size", 1.0, 50.0, 8.0), r("sharpness", "Sharpness", 0.0, 40.0, 7.0), select("brushType", "Brush Type", &["simple", "lightRough", "darkRough", "wideSharp", "wideBlurry", "sparkle"], "simple")]),
    fx!("palette_knife", "Palette Knife", "artistic", [r("strokeSize", "Stroke Size", 1.0, 50.0, 25.0), r("strokeDetail", "Stroke Detail", 1.0, 3.0, 3.0), r("softness", "Softness", 0.0, 10.0, 0.0)]),
    fx!("plastic_wrap", "Plastic Wrap", "artistic", [r("highlightStrength", "Highlight Strength", 0.0, 20.0, 15.0), r("detail", "Detail", 1.0, 15.0, 9.0), r("smoothness", "Smoothness", 1.0, 15.0, 7.0)]),
    fx!("poster_edges", "Poster Edges", "artistic", [r("edgeThickness", "Edge Thickness", 0.0, 10.0, 2.0), r("edgeIntensity", "Edge Intensity", 0.0, 10.0, 1.0), r("posterization", "Posterization", 0.0, 6.0, 2.0)]),
    fx!("rough_pastels", "Rough Pastels", "artistic", [r("strokeLength", "Stroke Length", 0.0, 40.0, 6.0), r("strokeDetail", "Stroke Detail", 1.0, 20.0, 4.0), TEX, SCALING, RELIEF, LIGHT, INVERT]),
    fx!("smudge_stick", "Smudge Stick", "artistic", [r("strokeLength", "Stroke Length", 0.0, 10.0, 2.0), r("highlightArea", "Highlight Area", 0.0, 20.0, 0.0), r("intensity", "Intensity", 0.0, 10.0, 10.0)]),
    fx!("sponge", "Sponge", "artistic", [r("brushSize", "Brush Size", 0.0, 10.0, 0.0), r("definition", "Definition", 0.0, 25.0, 12.0), r("smoothness", "Smoothness", 1.0, 15.0, 5.0)]),
    fx!("underpainting", "Underpainting", "artistic", [r("brushSize", "Brush Size", 0.0, 40.0, 6.0), r("textureCoverage", "Texture Coverage", 0.0, 40.0, 16.0), TEX, SCALING, RELIEF, LIGHT, INVERT]),
    fx!("watercolor", "Watercolor", "artistic", [r("brushDetail", "Brush Detail", 1.0, 14.0, 9.0), r("shadowIntensity", "Shadow Intensity", 1.0, 10.0, 1.0), r("texture", "Texture", 1.0, 3.0, 1.0)]),
    fx!("accented_edges", "Accented Edges", "brushStrokes", [r("edgeWidth", "Edge Width", 1.0, 14.0, 2.0), r("edgeBrightness", "Edge Brightness", 0.0, 50.0, 38.0), r("smoothness", "Smoothness", 1.0, 15.0, 5.0)]),
    fx!("angled_strokes", "Angled Strokes", "brushStrokes", [r("directionBalance", "Direction Balance", 0.0, 100.0, 50.0), r("strokeLength", "Stroke Length", 3.0, 50.0, 15.0), r("sharpness", "Sharpness", 0.0, 10.0, 3.0)]),
    fx!("crosshatch", "Crosshatch", "brushStrokes", [r("strokeLength", "Stroke Length", 3.0, 50.0, 9.0), r("sharpness", "Sharpness", 0.0, 20.0, 6.0), r("strength", "Strength", 1.0, 3.0, 1.0)]),
    fx!("dark_strokes", "Dark Strokes", "brushStrokes", [r("balance", "Balance", 0.0, 10.0, 5.0), r("blackIntensity", "Black Intensity", 0.0, 10.0, 6.0), r("whiteIntensity", "White Intensity", 0.0, 10.0, 2.0)]),
    fx!("ink_outlines", "Ink Outlines", "brushStrokes", [r("strokeLength", "Stroke Length", 1.0, 50.0, 4.0), r("darkIntensity", "Dark Intensity", 0.0, 50.0, 20.0), r("lightIntensity", "Light Intensity", 0.0, 50.0, 10.0)]),
    fx!("spatter", "Spatter", "brushStrokes", [r("sprayRadius", "Spray Radius", 0.0, 25.0, 10.0), r("smoothness", "Smoothness", 1.0, 15.0, 5.0)]),
    fx!("sprayed_strokes", "Sprayed Strokes", "brushStrokes", [r("strokeLength", "Stroke Length", 0.0, 20.0, 12.0), r("sprayRadius", "Spray Radius", 0.0, 25.0, 7.0), select("strokeDirection", "Stroke Direction", STROKE_DIRS, "rightDiagonal")]),
    fx!("sumi_e", "Sumi-e", "brushStrokes", [r("stroke", "Stroke Width", 2.0, 15.0, 10.0), r("strokePressure", "Stroke Pressure", 0.0, 15.0, 2.0), r("contrast", "Contrast", 0.0, 40.0, 16.0)]),
    fx!("diffuse_glow", "Diffuse Glow", "distort", [r("graininess", "Graininess", 0.0, 10.0, 6.0), r("glowAmount", "Glow Amount", 0.0, 20.0, 10.0), r("clearAmount", "Clear Amount", 0.0, 20.0, 15.0)]),
    fx!("glass", "Glass", "distort", [r("distortion", "Distortion", 0.0, 20.0, 5.0), r("smoothness", "Smoothness", 1.0, 15.0, 3.0), select("texture", "Texture", &["brick", "burlap", "canvas", "sandstone", "frosted", "tinyLens"], "canvas"), SCALING, flag("invertTexture", "Invert")]),
    fx!("ocean_ripple", "Ocean Ripple", "distort", [r("rippleSize", "Ripple Size", 1.0, 15.0, 9.0), r("rippleMagnitude", "Ripple Magnitude", 0.0, 20.0, 9.0)]),
    fx!("bas_relief", "Bas Relief", "sketch", [r("detail", "Detail", 1.0, 15.0, 13.0), r("smoothness", "Smoothness", 1.0, 15.0, 3.0), select("lightDirection", "Light", LIGHTS, "bottom")]),
    fx!("chalk_and_charcoal", "Chalk & Charcoal", "sketch", [r("charcoalArea", "Charcoal Area", 0.0, 20.0, 6.0), r("chalkArea", "Chalk Area", 0.0, 20.0, 6.0), r("strokePressure", "Stroke Pressure", 0.0, 5.0, 1.0)]),
    fx!("charcoal", "Charcoal", "sketch", [r("charcoalThickness", "Charcoal Thickness", 1.0, 7.0, 1.0), r("detail", "Detail", 0.0, 5.0, 5.0), r("lightDark", "Light/Dark Balance", 0.0, 100.0, 50.0)]),
    fx!("chrome", "Chrome", "sketch", [r("detail", "Detail", 0.0, 10.0, 4.0), r("smoothness", "Smoothness", 0.0, 10.0, 7.0)]),
    fx!("conte_crayon", "Conté Crayon", "sketch", [r("foregroundLevel", "Foreground Level", 1.0, 15.0, 11.0), r("backgroundLevel", "Background Level", 1.0, 15.0, 7.0), TEX, SCALING, RELIEF, LIGHT, INVERT]),
    fx!("graphic_pen", "Graphic Pen", "sketch", [r("strokeLength", "Stroke Length", 1.0, 15.0, 15.0), r("lightDarkBalance", "Light/Dark Balance", 0.0, 100.0, 50.0), select("strokeDirection", "Stroke Direction", STROKE_DIRS, "rightDiagonal")]),
    fx!("halftone_pattern", "Halftone Pattern", "sketch", [r("size", "Size", 1.0, 12.0, 1.0), r("contrast", "Contrast", 0.0, 50.0, 5.0), select("patternType", "Pattern Type", &["circle", "dot", "line"], "circle")]),
    fx!("note_paper", "Note Paper", "sketch", [r("imageBalance", "Image Balance", 0.0, 50.0, 25.0), r("graininess", "Graininess", 0.0, 20.0, 10.0), r("relief", "Relief", 0.0, 25.0, 11.0)]),
    fx!("photocopy", "Photocopy", "sketch", [r("detail", "Detail", 1.0, 24.0, 7.0), r("darkness", "Darkness", 1.0, 50.0, 8.0)]),
    fx!("plaster", "Plaster", "sketch", [r("imageBalance", "Image Balance", 0.0, 50.0, 20.0), r("smoothness", "Smoothness", 1.0, 15.0, 2.0), select("lightPosition", "Light Position", LIGHTS, "bottom")]),
    fx!("reticulation", "Reticulation", "sketch", [r("density", "Density", 0.0, 50.0, 12.0), r("foregroundLevel", "Foreground Level", 0.0, 50.0, 40.0), r("backgroundLevel", "Background Level", 0.0, 50.0, 5.0)]),
    fx!("stamp", "Stamp", "sketch", [r("lightDarkBalance", "Light/Dark Balance", 0.0, 50.0, 25.0), r("smoothness", "Smoothness", 1.0, 50.0, 5.0)]),
    fx!("torn_edges", "Torn Edges", "sketch", [r("imageBalance", "Image Balance", 0.0, 50.0, 25.0), r("smoothness", "Smoothness", 1.0, 15.0, 11.0), r("contrast", "Contrast", 1.0, 25.0, 17.0)]),
    fx!("water_paper", "Water Paper", "sketch", [r("fiberLength", "Fiber Length", 3.0, 50.0, 15.0), r("brightness", "Brightness", 0.0, 100.0, 60.0), r("contrast", "Contrast", 0.0, 100.0, 80.0)]),
    fx!("glowing_edges", "Glowing Edges", "stylize", [r("edgeWidth", "Edge Width", 1.0, 14.0, 2.0), r("edgeBrightness", "Edge Brightness", 0.0, 20.0, 6.0), r("smoothness", "Smoothness", 1.0, 15.0, 5.0)]),
    fx!("craquelure", "Craquelure", "texture", [r("crackSpacing", "Crack Spacing", 2.0, 100.0, 15.0), r("crackDepth", "Crack Depth", 0.0, 10.0, 6.0), r("crackBrightness", "Crack Brightness", 0.0, 10.0, 9.0)]),
    fx!("grain", "Grain", "texture", [r("intensity", "Intensity", 0.0, 100.0, 40.0), r("contrast", "Contrast", 0.0, 100.0, 50.0), select("grainType", "Grain Type", &["regular", "soft", "sprinkles", "clumped", "contrasty", "enlarged", "stippled", "horizontal", "vertical", "speckle"], "regular")]),
    fx!("mosaic_tiles", "Mosaic Tiles", "texture", [r("tileSize", "Tile Size", 2.0, 100.0, 24.0), r("groutWidth", "Grout Width", 1.0, 15.0, 3.0), r("lightenGrout", "Lighten Grout", 0.0, 10.0, 9.0)]),
    fx!("patchwork", "Patchwork", "texture", [r("squareSize", "Square Size", 0.0, 10.0, 4.0), r("relief", "Relief", 0.0, 25.0, 8.0)]),
    fx!("stained_glass", "Stained Glass", "texture", [r("cellSize", "Cell Size", 2.0, 50.0, 8.0), r("borderThickness", "Border Thickness", 1.0, 20.0, 4.0), r("lightIntensity", "Light Intensity", 0.0, 10.0, 3.0)]),
    fx!("texturizer", "Texturizer", "texture", [TEX, SCALING, RELIEF, LIGHT, flag("invertTexture", "Invert")]),
    // Its own dialog (Filter > Liquify...); `reach` is the longest mesh offset, so a smart filter reads far enough.
    Spec {
        reach: liquify_reach,
        preview: false,
        ..global(
        "liquify",
        "Liquify",
        "liquify",
        &[
            Param { kind: PKind::Blob, ..num("mesh", "Mesh", 0.0, 0.0, 0.0, "", 0.0) },
            int("reach", "Reach", 0.0, 65535.0, 0.0),
        ],
        crate::liquify::apply,
    )
    },

    // Edit > Puppet Warp and Perspective Warp sessions; smart filters on smart objects.
    Spec {
        extent: Some(crate::puppet::extent),
        preview: false,
        ..global("puppet_warp", "Puppet Warp", "warp", &[Param { kind: PKind::Rig, default: Def::Required, ..num("rig", "Rig", 0.0, 0.0, 0.0, "", 0.0) }], crate::puppet::apply)
    },
    Spec {
        extent: Some(crate::pwarp::extent),
        preview: false,
        ..global("perspective_warp", "Perspective Warp", "warp", &[Param { kind: PKind::Quads, default: Def::Required, ..num("state", "State", 0.0, 0.0, 0.0, "", 0.0) }], crate::pwarp::apply)
    },
    // Filter > Vanishing Point: its own dialog; a smart filter on smart objects.
    Spec {
        extent: Some(crate::vanishing::extent),
        preview: false,
        ..global("vanishing_point", "Vanishing Point", "vanishing", &[Param { kind: PKind::Stamps, default: Def::Required, ..num("state", "State", 0.0, 0.0, 0.0, "", 0.0) }], crate::vanishing::apply)
    },

    // Edit > Content-Aware Scale: its own dialog, not in the Filter menu.
    Spec {
        extent: Some(crate::seam::extent),
        ..global(
            "content_aware_scale",
            "Content-Aware Scale",
            "scale",
            &[amount("width", "Width", 10.0, 300.0, 1.0, 100.0), amount("height", "Height", 10.0, 300.0, 1.0, 100.0), amount("amount", "Amount", 0.0, 100.0, 1.0, 100.0), flag("protectSkinTones", "Protect Skin Tones")],
            crate::seam::apply,
        )
    },
];

fn liquify_reach(f: &Filter) -> i32 {
    f.num("reach").ceil() as i32
}

pub fn lookup(id: &str) -> Option<&'static Spec> {
    ALL.iter().find(|s| s.id == id)
}
