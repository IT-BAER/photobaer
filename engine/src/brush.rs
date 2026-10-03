//! Brush and paint command parameters, stroke parsing, the live `Stroke` and `EngineCore`.
//! A child module of `doc`.

use super::*;

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct DynIn {
    control: Option<String>,
    fade_steps: Option<u32>,
    jitter: f32,
    minimum: f32,
}

impl DynIn {
    fn finite(&self) -> bool {
        self.jitter.is_finite() && self.minimum.is_finite()
    }

    fn parse(&self) -> Result<Dyn, String> {
        Ok(Dyn {
            control: match &self.control {
                Some(s) => Source::parse(s)?,
                None => Source::Off,
            },
            fade_steps: self.fade_steps.unwrap_or(1),
            jitter: self.jitter.clamp(0.0, 1.0),
            minimum: self.minimum.clamp(0.0, 1.0),
        })
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct ShapeDynIn {
    enabled: bool,
    size: DynIn,
    roundness: DynIn,
    flip_x_jitter: bool,
    flip_y_jitter: bool,
    brush_projection: bool,
    angle_follows_path: bool,
    angle_control: Option<String>,
    angle_fade_steps: Option<u32>,
    angle_jitter: f32,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct ScatterIn {
    enabled: bool,
    count: Option<u32>,
    count_dyn: DynIn,
    amount: f32,
    scatter_dyn: DynIn,
    both_axes: bool,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct TransferIn {
    enabled: bool,
    opacity_dyn: DynIn,
    flow_dyn: DynIn,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct ColorDynIn {
    enabled: bool,
    bg: Option<[u8; 4]>,
    fg_bg: f32,
    hue_jitter: f32,
    sat_jitter: f32,
    bri_jitter: f32,
    purity: f32,
    per_tip: Option<bool>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct PoseIn {
    enabled: bool,
    tilt_x: Option<f32>,
    tilt_y: Option<f32>,
    rotation: Option<f32>,
    pressure: Option<f32>,
}

fn multiply_mode() -> String {
    "multiply".into()
}

// `#[serde(default)]` on the outer `StrokeIn` field falls back to `Default::default()` when the
// whole object is absent, so these need a hand-written `Default` matching the per-field
// `#[serde(default = "...")]` values below (a derived `Default` would give `mode: String::new()`).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct TextureIn {
    enabled: bool,
    pattern_id: Option<u32>,
    invert: bool,
    #[serde(default = "one")]
    scale: f32,
    brightness: f32,
    contrast: f32,
    each_tip: bool,
    #[serde(default = "multiply_mode")]
    mode: String,
    #[serde(default = "one")]
    depth: f32,
    minimum_depth: f32,
    depth_jitter: DynIn,
}

impl Default for TextureIn {
    fn default() -> TextureIn {
        TextureIn {
            enabled: false,
            pattern_id: None,
            invert: false,
            scale: one(),
            brightness: 0.0,
            contrast: 0.0,
            each_tip: false,
            mode: multiply_mode(),
            depth: one(),
            minimum_depth: 0.0,
            depth_jitter: DynIn::default(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
struct DualBrushIn {
    enabled: bool,
    #[serde(default = "round_tip")]
    tip: String,
    tip_id: Option<u32>,
    #[serde(default = "one")]
    hardness: f32,
    #[serde(default = "one")]
    roundness: f32,
    angle: f32,
    flip_x: bool,
    flip_y: bool,
    #[serde(default = "multiply_mode")]
    mode: String,
    #[serde(default = "one")]
    size: f32,
    #[serde(default = "quarter")]
    spacing: f32,
    scatter: f32,
    both_axes: bool,
    #[serde(default = "one_u32")]
    count: u32,
}

fn one_u32() -> u32 {
    1
}

impl Default for DualBrushIn {
    fn default() -> DualBrushIn {
        DualBrushIn {
            enabled: false,
            tip: round_tip(),
            tip_id: None,
            hardness: one(),
            roundness: one(),
            angle: 0.0,
            flip_x: false,
            flip_y: false,
            mode: multiply_mode(),
            size: one(),
            spacing: quarter(),
            scatter: 0.0,
            both_axes: false,
            count: one_u32(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrokeIn {
    rgba: [u8; 4],
    mode: String,
    size: f32,
    #[serde(default = "one")]
    opacity: f32,
    #[serde(default = "one")]
    flow: f32,
    #[serde(default = "one")]
    hardness: f32,
    #[serde(default = "quarter")]
    spacing: f32,
    #[serde(default)]
    angle: f32,
    #[serde(default = "one")]
    roundness: f32,
    #[serde(default = "round_tip")]
    tip: String,
    #[serde(default)]
    tip_id: Option<u32>,
    #[serde(default)]
    flip_x: bool,
    #[serde(default)]
    flip_y: bool,
    #[serde(default)]
    aliased: bool,
    #[serde(default)]
    wet_edges: bool,
    #[serde(default)]
    airbrush: bool,
    #[serde(default)]
    pressure_size: bool,
    #[serde(default)]
    pressure_opacity: bool,
    #[serde(default)]
    erase_to_history: Option<u32>,
    #[serde(default = "three")]
    stride: u8,
    #[serde(default)]
    seed: u32,
    #[serde(default)]
    shape_dyn: ShapeDynIn,
    #[serde(default)]
    scatter: ScatterIn,
    #[serde(default)]
    transfer: TransferIn,
    #[serde(default)]
    color: ColorDynIn,
    #[serde(default)]
    noise: f32,
    #[serde(default)]
    pose: PoseIn,
    #[serde(default)]
    texture: TextureIn,
    #[serde(default)]
    dual_brush: DualBrushIn,
    #[serde(default)]
    source: Option<SourceIn>,
    #[serde(default)]
    heal: Option<String>,
    /// Healing Brush Diffusion 1..=7 (7 = the full Poisson correction).
    #[serde(default)]
    diffusion: Option<f32>,
    #[serde(default)]
    effect: Option<EffectIn>,
    #[serde(default)]
    art: Option<ArtIn>,
}

/// `content_aware_fill` JSON params; `mode` absent = Normal at full opacity.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ContentAwareIn {
    structure: f32,
    color: f32,
    #[serde(default)]
    mode: Option<String>,
    #[serde(default = "one")]
    opacity: f32,
    #[serde(default)]
    preserve_transparency: bool,
    #[serde(default)]
    deselect: bool,
}

/// `fill_ex` JSON params (B6 spec v1 Part E1): `source` is "solid", "pattern" or "history".
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FillExIn {
    source: String,
    #[serde(default)]
    rgba: Option<[u8; 4]>,
    #[serde(default)]
    pattern_id: Option<u32>,
    #[serde(default)]
    snapshot_id: Option<u32>,
    mode: String,
    #[serde(default = "one")]
    opacity: f32,
    #[serde(default)]
    preserve_transparency: bool,
}

/// `stroke_selection` JSON params (B6 spec v1 Part E2): `location` is "inside", "center" or
/// "outside".
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StrokeSelIn {
    width: f32,
    rgba: [u8; 4],
    location: String,
    mode: String,
    #[serde(default = "one")]
    opacity: f32,
    #[serde(default)]
    preserve_transparency: bool,
}

/// `gradient` JSON params (B6 spec v1 Part E3): `stops`/`opacityStops` are normalized inside
/// `Document::gradient`; `start`/`end` are document pixel coordinates.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GradientIn {
    #[serde(default)]
    stops: Vec<ColorStopIn>,
    #[serde(default)]
    opacity_stops: Vec<OpacityStopIn>,
    #[serde(default = "perceptual_method")]
    method: String,
    #[serde(default = "linear_style")]
    style: String,
    start: PointIn,
    end: PointIn,
    #[serde(default)]
    reverse: bool,
    #[serde(default = "yes")]
    dither: bool,
    #[serde(default = "yes")]
    transparency: bool,
    #[serde(default = "one")]
    opacity: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ColorStopIn {
    position: f32,
    rgb: [u8; 3],
    #[serde(default = "half")]
    midpoint: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpacityStopIn {
    position: f32,
    #[serde(default = "one")]
    opacity: f32,
    #[serde(default = "half")]
    midpoint: f32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PointIn {
    x: f64,
    y: f64,
}

fn half() -> f32 {
    0.5
}

fn yes() -> bool {
    true
}

fn perceptual_method() -> String {
    "perceptual".into()
}

fn linear_style() -> String {
    "linear".into()
}

fn one() -> f32 {
    1.0
}

fn quarter() -> f32 {
    0.25
}

fn round_tip() -> String {
    "round".into()
}

fn three() -> u8 {
    3
}

/// Parses and validates `params_json` into a ready `Stroke`, apart from the doc-specific guard
/// checks (locks, snapshot lookup, selection init) that only `stroke_begin` and `brush_preview`
/// can do themselves; `resolve_hist` resolves an `eraseToHistory` snapshot id when present.
fn parse_stroke(
    layer_id: u32,
    target: Target,
    params_json: &str,
    tips: &HashMap<u32, Arc<SampledTip>>,
    patterns: &HashMap<u32, Arc<Pattern>>,
    snapshots: &HashMap<u32, Document>,
    keep_alpha: bool,
    sel_was_none: bool,
    doc: Option<&Document>,
    resolve_hist: impl FnOnce(u32) -> Result<Tiles, String>,
) -> Result<Stroke, String> {
    let p: StrokeIn = serde_json::from_str(params_json).map_err(|e| format!("bad stroke params: {e}"))?;
    if ![p.size, p.opacity, p.flow, p.hardness, p.spacing, p.angle, p.roundness, p.noise].iter().all(|v| v.is_finite()) {
        return Err("stroke params must be finite".into());
    }
    if p.size <= 0.0 {
        return Err("stroke size must be positive".into());
    }
    if p.stride != 3 && p.stride != 6 {
        return Err("stride must be 3 or 6".into());
    }
    let mode = PaintMode::parse(&p.mode)?;
    let kind = TipKind::parse(&p.tip)?;
    let shape = match kind {
        TipKind::Round => TipShape::Round,
        TipKind::Square => TipShape::Square,
        TipKind::Sampled => {
            let id = p.tip_id.ok_or_else(|| "a sampled tip needs tipId".to_string())?;
            let tip = tips.get(&id).ok_or_else(|| format!("unknown tip {id}"))?;
            TipShape::Sampled(tip.clone())
        }
    };

    if !p.shape_dyn.size.finite() || !p.shape_dyn.roundness.finite() || !p.shape_dyn.angle_jitter.is_finite() {
        return Err("shape dynamics params must be finite".into());
    }
    let shape_dyn = stroke::ShapeDynamics {
        enabled: p.shape_dyn.enabled,
        size: p.shape_dyn.size.parse()?,
        roundness: p.shape_dyn.roundness.parse()?,
        flip_x_jitter: p.shape_dyn.flip_x_jitter,
        flip_y_jitter: p.shape_dyn.flip_y_jitter,
        brush_projection: p.shape_dyn.brush_projection,
        angle_follows_path: p.shape_dyn.angle_follows_path,
        angle_control: match &p.shape_dyn.angle_control {
            Some(s) => Source::parse(s)?,
            None => Source::Off,
        },
        angle_fade_steps: p.shape_dyn.angle_fade_steps.unwrap_or(1),
        angle_jitter: p.shape_dyn.angle_jitter.clamp(0.0, 1.0),
    };

    if !p.scatter.amount.is_finite() || !p.scatter.count_dyn.finite() || !p.scatter.scatter_dyn.finite() {
        return Err("scatter params must be finite".into());
    }
    let scatter = stroke::ScatterDynamics {
        enabled: p.scatter.enabled,
        count: p.scatter.count.unwrap_or(1).clamp(1, 16),
        count_dyn: p.scatter.count_dyn.parse()?,
        amount: p.scatter.amount.clamp(0.0, 10.0),
        scatter_dyn: p.scatter.scatter_dyn.parse()?,
        both_axes: p.scatter.both_axes,
    };

    if !p.transfer.opacity_dyn.finite() || !p.transfer.flow_dyn.finite() {
        return Err("transfer params must be finite".into());
    }
    let transfer =
        stroke::TransferDynamics { enabled: p.transfer.enabled, opacity_dyn: p.transfer.opacity_dyn.parse()?, flow_dyn: p.transfer.flow_dyn.parse()? };

    if ![p.color.fg_bg, p.color.hue_jitter, p.color.sat_jitter, p.color.bri_jitter, p.color.purity].iter().all(|v| v.is_finite()) {
        return Err("color dynamics params must be finite".into());
    }
    let bg = p.color.bg.unwrap_or([0, 0, 0, 255]);
    let color = stroke::ColorDynamics {
        enabled: p.color.enabled,
        bg: [bg[0] as f32 / 255.0, bg[1] as f32 / 255.0, bg[2] as f32 / 255.0],
        fg_bg: p.color.fg_bg.clamp(0.0, 1.0),
        hue_jitter: p.color.hue_jitter.clamp(0.0, 1.0),
        sat_jitter: p.color.sat_jitter.clamp(0.0, 1.0),
        bri_jitter: p.color.bri_jitter.clamp(0.0, 1.0),
        purity: p.color.purity.clamp(-1.0, 1.0),
        per_tip: p.color.per_tip.unwrap_or(true),
    };

    if ![p.texture.scale, p.texture.brightness, p.texture.contrast, p.texture.depth, p.texture.minimum_depth]
        .iter()
        .all(|v| v.is_finite())
        || !p.texture.depth_jitter.finite()
    {
        return Err("texture params must be finite".into());
    }
    let texture_mode = Blend::parse(&p.texture.mode)?;
    let texture_pattern = match p.texture.pattern_id {
        Some(id) => Some(patterns.get(&id).ok_or_else(|| format!("unknown pattern {id}"))?.clone()),
        None => None,
    };
    if p.texture.enabled && texture_pattern.is_none() {
        return Err("texture needs a patternId".into());
    }
    let texture = TextureCfg {
        enabled: p.texture.enabled,
        pattern: texture_pattern,
        invert: p.texture.invert,
        scale: if p.texture.scale <= 0.0 { 1.0 } else { p.texture.scale.clamp(0.01, 10.0) },
        brightness: p.texture.brightness.clamp(-1.0, 1.0),
        contrast: p.texture.contrast.clamp(-1.0, 1.0),
        each_tip: p.texture.each_tip,
        mode: texture_mode,
    };
    let texture_dyn = stroke::TextureDynamics {
        enabled: p.texture.enabled,
        depth: p.texture.depth.clamp(0.0, 1.0),
        minimum_depth: p.texture.minimum_depth.clamp(0.0, 1.0),
        depth_jitter: p.texture.depth_jitter.parse()?,
    };

    if !p.dual_brush.size.is_finite()
        || !p.dual_brush.spacing.is_finite()
        || !p.dual_brush.scatter.is_finite()
        || !p.dual_brush.angle.is_finite()
        || !p.dual_brush.hardness.is_finite()
        || !p.dual_brush.roundness.is_finite()
    {
        return Err("dual brush params must be finite".into());
    }
    let dual_mode = Blend::parse(&p.dual_brush.mode)?;
    let dual_shape = match TipKind::parse(&p.dual_brush.tip)? {
        TipKind::Round => TipShape::Round,
        TipKind::Sampled => {
            let id = p.dual_brush.tip_id.ok_or_else(|| "a sampled dual brush tip needs tipId".to_string())?;
            let tip = tips.get(&id).ok_or_else(|| format!("unknown tip {id}"))?;
            TipShape::Sampled(tip.clone())
        }
        TipKind::Square => return Err("dual brush only supports round or sampled tips".into()),
    };
    let dual_brush = DualBrush {
        enabled: p.dual_brush.enabled,
        shape: dual_shape,
        hardness: p.dual_brush.hardness.clamp(0.0, 1.0),
        roundness: p.dual_brush.roundness.clamp(0.01, 1.0),
        angle: p.dual_brush.angle,
        flip_x: p.dual_brush.flip_x,
        flip_y: p.dual_brush.flip_y,
        mode: dual_mode,
        size: p.dual_brush.size.clamp(1.0, 1000.0),
        spacing: p.dual_brush.spacing.clamp(0.01, 10.0),
        scatter: p.dual_brush.scatter.clamp(0.0, 10.0),
        both_axes: p.dual_brush.both_axes,
        count: p.dual_brush.count.clamp(1, 16),
    };

    let pose = if p.pose.enabled {
        for v in [p.pose.tilt_x, p.pose.tilt_y, p.pose.rotation, p.pose.pressure].into_iter().flatten() {
            if !v.is_finite() {
                return Err("brush pose overrides must be finite".into());
            }
        }
        PoseOverride {
            tilt_x: p.pose.tilt_x.map(|v| v.clamp(-90.0, 90.0)),
            tilt_y: p.pose.tilt_y.map(|v| v.clamp(-90.0, 90.0)),
            rotation: p.pose.rotation,
            pressure: p.pose.pressure.map(|v| v.clamp(0.0, 1.0)),
        }
    } else {
        PoseOverride::default()
    };

    let heal = p.heal.as_deref().map(Heal::parse).transpose()?;
    let diffusion = p.diffusion.unwrap_or(7.0);
    if !(1.0..=7.0).contains(&diffusion) {
        return Err("diffusion must be 1 to 7".into());
    }
    if (p.source.is_some() || heal.is_some()) && target != Target::Pixels {
        return Err("a clone, pattern or heal stroke needs the pixels target".into());
    }
    if p.source.is_some() && p.erase_to_history.is_some() {
        return Err("erase to history can't use a source".into());
    }
    match (heal, &p.source) {
        (Some(Heal::Healing), Some(SourceIn::Clone { .. } | SourceIn::Pattern { .. })) => {}
        (Some(Heal::Healing), _) => return Err("the healing brush needs a clone source".into()),
        (Some(_), Some(_)) => return Err("a spot heal takes no source".into()),
        _ => {}
    }
    let effect = p.effect.map(EffectIn::build).transpose()?;
    if effect.is_some() && (target != Target::Pixels || p.source.is_some() || heal.is_some() || p.erase_to_history.is_some()) {
        return Err("an effect stroke needs the pixels target and takes no source, heal or erase to history".into());
    }
    let art = p.art.map(Art::build).transpose()?;
    if art.is_some() && !matches!(p.source, Some(SourceIn::History { .. })) {
        return Err("the art history brush needs a history source".into());
    }
    let source = p.source.as_ref().map(|s| StrokeSource::build(s, doc, layer_id, patterns, snapshots)).transpose()?;

    let hist = match p.erase_to_history {
        None => None,
        Some(id) => {
            if target != Target::Pixels {
                return Err("erase to history needs the pixels target".into());
            }
            Some(resolve_hist(id)?)
        }
    };

    Ok(Stroke {
        layer: layer_id,
        target,
        mode,
        rgb: [p.rgba[0] as f32 / 255.0, p.rgba[1] as f32 / 255.0, p.rgba[2] as f32 / 255.0],
        value: p.rgba[0] as f32 / 255.0,
        keep_alpha,
        opacity: p.opacity.clamp(0.0, 1.0),
        flow: p.flow.clamp(0.0, 1.0),
        size: p.size,
        hardness: p.hardness,
        angle: p.angle,
        roundness: p.roundness,
        flip_x: p.flip_x,
        flip_y: p.flip_y,
        shape,
        aliased: p.aliased,
        wet_edges: p.wet_edges,
        airbrush: p.airbrush,
        pressure_size: p.pressure_size,
        pressure_opacity: p.pressure_opacity,
        step: (p.spacing as f64 * p.size as f64).max(1.0),
        stride: p.stride,
        spacer: Spacer::default(),
        prng: stroke::Prng::new(p.seed),
        dab_index: 0,
        pose,
        dynamics: stroke::Dynamics { shape: shape_dyn, scatter, transfer, color, texture: texture_dyn },
        noise: p.noise.clamp(0.0, 1.0),
        seed: p.seed,
        hist,
        sel_was_none,
        tiles: HashMap::new(),
        texture,
        dual_brush,
        source,
        heal,
        diffusion,
        effect,
        art,
        smudge_prev: None,
        fx_sample: None,
        reservoir: None,
    })
}

// One tile a stroke has touched: the accumulated stroke coverage and the tile as it was at
// stroke start, which every frame recomputes from (so the opacity caps the whole stroke). `rgb`
// is only present when color dynamics are active (E1.7); otherwise the stroke's flat `rgb` is
// used for every pixel and no extra buffer is allocated (the B4 fast path).
pub(super) struct StrokeTile {
    pub(super) s: Vec<f32>,
    pub(super) rgb: Option<Vec<[f32; 3]>>,
    pub(super) orig: Option<Tile>,
}

/// E2.3 texture sampling config; the per-dab depth roll lives in `stroke::TextureDynamics`
/// instead, since only that needs the stroke PRNG.
pub(super) struct TextureCfg {
    pub(super) enabled: bool,
    pub(super) pattern: Option<Arc<Pattern>>,
    pub(super) invert: bool,
    pub(super) scale: f32,
    pub(super) brightness: f32,
    pub(super) contrast: f32,
    pub(super) each_tip: bool,
    pub(super) mode: Blend,
}

/// An open stroke (B5 spec v2 Part E1). Lives in `EngineCore`, outside the document, so
/// snapshots and autosaves never see a half stroke.
pub struct Stroke {
    pub(super) layer: u32,
    pub(super) target: Target,
    pub(super) mode: PaintMode,
    pub(super) rgb: [f32; 3],
    pub(super) value: f32,
    pub(super) keep_alpha: bool,
    pub(super) opacity: f32,
    pub(super) flow: f32,
    pub(super) size: f32,
    pub(super) hardness: f32,
    pub(super) angle: f32,
    pub(super) roundness: f32,
    pub(super) flip_x: bool,
    pub(super) flip_y: bool,
    pub(super) shape: TipShape,
    pub(super) aliased: bool,
    pub(super) wet_edges: bool,
    pub(super) airbrush: bool,
    pub(super) pressure_size: bool,
    pub(super) pressure_opacity: bool,
    pub(super) step: f64,
    pub(super) stride: u8,
    pub(super) spacer: Spacer,
    pub(super) prng: stroke::Prng,
    pub(super) dab_index: u32,
    pub(super) pose: PoseOverride,
    pub(super) dynamics: stroke::Dynamics,
    pub(super) noise: f32,
    pub(super) seed: u32,
    pub(super) texture: TextureCfg,
    pub(super) dual_brush: DualBrush,
    pub(super) source: Option<StrokeSource>,
    pub(super) heal: Option<Heal>,
    pub(super) diffusion: f32,
    pub(super) effect: Option<Effect>,
    pub(super) art: Option<Art>,
    // The previous smudge dab center.
    pub(super) smudge_prev: Option<(f64, f64)>,
    // The color the matching effects compare against (Sampling: Once keeps the first).
    pub(super) fx_sample: Option<[f32; 3]>,
    pub(super) reservoir: Option<Reservoir>,
    // Erase to history: the same layer's tiles in the chosen snapshot.
    pub(super) hist: Option<Tiles>,
    // A quick-mask stroke that created the selection removes it again on cancel.
    sel_was_none: bool,
    pub(super) tiles: HashMap<(i32, i32), StrokeTile>,
}

/// Host-testable core behind the wasm `Engine`: current document plus live
/// snapshots. Kept here (not in lib.rs) so `cargo test` covers it directly.
pub struct EngineCore {
    pub doc: Document,
    pub(super) snapshots: HashMap<u32, Document>,
    next_snapshot_id: u32,
    // The open stroke, outside the document for the same reason as the live wires.
    stroke: Option<Stroke>,
    // Magnetic lasso gradient fields, one per open lasso; they are derived from the image, so
    // they live outside the document and never travel into a snapshot.
    livewires: HashMap<u32, LiveWire>,
    next_livewire_id: u32,
    // Sampled brush tips (E1.11), outside the document/snapshots: they are host-side resources
    // referenced by id from stroke params, not part of the document's persisted state.
    tips: HashMap<u32, Arc<SampledTip>>,
    next_tip_id: u32,
    // Fill/texture patterns (E2.1), outside the document/snapshots for the same reason as tips.
    patterns: HashMap<u32, Arc<Pattern>>,
    next_pattern_id: u32,
    // The last selected-pixels lift and its key: a move drag restores one base per step and
    // lifts it once. ponytail: one entry; it holds the lifted tiles until the next lift.
    lift: Option<(Vec<u64>, Arc<Lift>)>,
    // The mixer brush well after the last stroke, for a stroke that does not reload.
    mixer_well: Option<Reservoir>,
    // View > Proof Setup, Proof Colors, Gamut Warning, 32-bit Preview Options: display only, so
    // outside the document and its snapshots.
    pub view: crate::doc::proof::View,
    // Channels panel target, UI state outside the document like `view`: pixel edits keep the
    // color channels not in `color_target`; selection-target edits paint saved channel `alpha_target`.
    pub color_target: [bool; 3],
    pub alpha_target: Option<u32>,
    // What the open stroke holds for its target until it ends.
    stroke_hold: Option<Hold>,
}

/// A pixel edit's state for `EngineCore::release`: the layer tiles before it, or the selection
/// set aside while a saved channel stands in for it.
enum Hold {
    Color(u32, Tiles),
    Alpha(u32, Option<SelMask>),
}

impl EngineCore {
    pub fn new(doc: Document) -> EngineCore {
        EngineCore {
            doc,
            snapshots: HashMap::new(),
            next_snapshot_id: 0,
            stroke: None,
            livewires: HashMap::new(),
            next_livewire_id: 0,
            tips: HashMap::new(),
            next_tip_id: 0,
            patterns: HashMap::new(),
            next_pattern_id: 0,
            lift: None,
            mixer_well: None,
            view: Default::default(),
            color_target: [true; 3],
            alpha_target: None,
            stroke_hold: None,
        }
    }

    fn hold(&mut self, id: u32, target: Target) -> Result<Option<Hold>, String> {
        let c = self.color_target;
        Ok(match (target, self.alpha_target) {
            (Target::Selection, Some(ch)) => Some(Hold::Alpha(ch, self.doc.channel_in(ch)?)),
            (Target::Pixels, _) if c.contains(&true) && c.contains(&false) => {
                self.doc.node(id).ok().and_then(|n| n.pixel_tiles().ok()).map(|t| Hold::Color(id, t.clone()))
            }
            _ => None,
        })
    }

    fn release(&mut self, h: Option<Hold>) -> Result<(), String> {
        match h {
            Some(Hold::Color(id, before)) => self.doc.keep_channels(id, &before, self.color_target),
            Some(Hold::Alpha(ch, sel)) => {
                self.doc.channel_out(ch, sel);
                Ok(())
            }
            None => Ok(()),
        }
    }

    /// Runs one edit of `target` on layer `id` through the Channels panel target.
    pub fn targeted<T>(&mut self, id: u32, target: Target, f: impl FnOnce(&mut Document) -> Result<T, String>) -> Result<T, String> {
        let h = self.hold(id, target)?;
        let r = f(&mut self.doc);
        self.release(h)?;
        r
    }

    /// `transform_selected_pixels` by whole pixels, reusing the cached lift for the same content.
    pub fn move_selected_pixels(&mut self, id: u32, dx: i32, dy: i32, copy: bool) -> Result<(), String> {
        self.doc.check_idle()?;
        self.doc.check_pixel_paint(id)?;
        let key = self.doc.lift_key(id, None, copy)?;
        let lift = match &self.lift {
            Some((k, l)) if *k == key => l.clone(),
            _ => {
                let Some(l) = self.doc.lift(id, None, copy)? else { return Ok(()) };
                let l = Arc::new(l);
                self.lift = Some((key, l.clone()));
                l
            }
        };
        let m = [1.0, 0.0, dx as f64, 0.0, 1.0, dy as f64, 0.0, 0.0, 1.0];
        self.doc.place_lift(id, &lift, &m, crate::resample::Interp::Nearest)
    }

    /// Registers a sampled brush tip (E1.11): 8-bit coverage, row-major, `1..=2500` per side.
    pub fn tip_add(&mut self, w: u32, h: u32, alpha: Vec<u8>) -> Result<u32, String> {
        if !(1..=2500).contains(&w) || !(1..=2500).contains(&h) {
            return Err("a sampled tip must be 1..=2500 px per side".into());
        }
        if alpha.len() != (w * h) as usize {
            return Err("a sampled tip's bytes must be w * h long".into());
        }
        let id = self.next_tip_id;
        self.next_tip_id += 1;
        self.tips.insert(id, Arc::new(SampledTip { w, h, alpha }));
        Ok(id)
    }

    pub fn tip_remove(&mut self, id: u32) {
        self.tips.remove(&id);
    }

    /// Registers a fill/texture pattern (E2.1): `1..=4096` px per side, `channels` 1 (gray) or 4
    /// (RGBA, alpha ignored).
    pub fn pattern_add(&mut self, w: u32, h: u32, data: &[u8], channels: u8) -> Result<u32, String> {
        let pattern = Pattern::new(w, h, data, channels)?;
        let id = self.next_pattern_id;
        self.next_pattern_id += 1;
        self.patterns.insert(id, Arc::new(pattern));
        Ok(id)
    }

    pub fn pattern_remove(&mut self, id: u32) {
        self.patterns.remove(&id);
    }

    /// Fill (B6 spec v1 Part E1 / item 2b): `target` is "pixels", "mask" or "selection".
    /// `params_json` is `{source, rgba?, patternId?, snapshotId?, mode, opacity,
    /// preserveTransparency}`.
    pub fn fill_ex(&mut self, id: u32, target: &str, params_json: &str) -> Result<(), String> {
        let target = Target::parse(target)?;
        let p: FillExIn = serde_json::from_str(params_json).map_err(|e| format!("bad fill params: {e}"))?;
        let mode = PaintMode::parse(&p.mode)?;
        let src = match p.source.as_str() {
            "solid" => FillSource::Solid(p.rgba.ok_or("solid fill needs rgba")?),
            "pattern" => {
                let pid = p.pattern_id.ok_or("pattern fill needs patternId")?;
                FillSource::Pattern(self.patterns.get(&pid).ok_or_else(|| format!("unknown pattern {pid}"))?.clone())
            }
            "history" => {
                let tiles = p
                    .snapshot_id
                    .and_then(|id| self.snapshots.get(&id))
                    .and_then(|snap| snap.node(id).ok())
                    .and_then(|n| n.pixel_tiles().ok())
                    .ok_or("Fill needs a pixel layer.")?;
                FillSource::History(tiles.clone())
            }
            other => return Err(format!("unknown fill source {other}")),
        };
        self.targeted(id, target, |d| d.fill_ex(id, target, &src, mode, p.opacity, p.preserve_transparency))
    }

    /// Edit > Content-Aware Fill: `params_json` is `{structure, color, mode?, opacity?,
    /// preserveTransparency?, deselect?}`; true when a pixel changed.
    pub fn content_aware_fill(&mut self, id: u32, params_json: &str) -> Result<bool, String> {
        let p: ContentAwareIn = serde_json::from_str(params_json).map_err(|e| format!("bad content-aware fill params: {e}"))?;
        let opts = match p.mode {
            Some(m) => Some((PaintMode::parse(&m)?, p.opacity, p.preserve_transparency)),
            None => None,
        };
        self.targeted(id, Target::Pixels, |d| d.content_aware_fill(id, p.structure, p.color, opts, p.deselect))
    }

    /// Stroke ring (B6 spec v1 Part E2): `params_json` is `{width, rgba, location, mode, opacity,
    /// preserveTransparency}`.
    pub fn stroke_selection(&mut self, id: u32, params_json: &str) -> Result<(), String> {
        let p: StrokeSelIn = serde_json::from_str(params_json).map_err(|e| format!("bad stroke params: {e}"))?;
        let mode = PaintMode::parse(&p.mode)?;
        self.targeted(id, Target::Pixels, |d| d.stroke_selection(id, p.width, p.rgba, &p.location, mode, p.opacity, p.preserve_transparency))
    }

    /// Gradient render (B6 spec v1 Part E3): `target` is "pixels", "mask" or "selection".
    /// `params_json` is `{stops[{position, rgb, midpoint}], opacityStops[{position, opacity,
    /// midpoint}], method, style, start: {x, y}, end: {x, y}, reverse, dither, transparency,
    /// opacity}`.
    pub fn gradient(&mut self, id: u32, target: &str, params_json: &str) -> Result<(), String> {
        let target = Target::parse(target)?;
        let p: GradientIn = serde_json::from_str(params_json).map_err(|e| format!("bad gradient params: {e}"))?;
        let method = gradient::Method::parse(&p.method)?;
        let style = gradient::Style::parse(&p.style)?;
        let color_stops = p
            .stops
            .into_iter()
            .map(|s| gradient::ColorStop {
                position: s.position,
                rgb: [s.rgb[0] as f32 / 255.0, s.rgb[1] as f32 / 255.0, s.rgb[2] as f32 / 255.0],
                midpoint: s.midpoint,
            })
            .collect();
        let opacity_stops = p
            .opacity_stops
            .into_iter()
            .map(|s| gradient::OpacityStop { position: s.position, opacity: s.opacity, midpoint: s.midpoint })
            .collect();
        self.targeted(id, target, |d| {
            d.gradient(
                id,
                target,
                color_stops,
                opacity_stops,
                method,
                style,
                (p.start.x, p.start.y),
                (p.end.x, p.end.y),
                p.reverse,
                p.dither,
                p.transparency,
                p.opacity,
            )
        })
    }

    /// Magnetic lasso (docs/M2.md section 3): computes the gradient field of the sampled image
    /// once and returns the handle the following `magnetic_path` calls use.
    pub fn magnetic_begin(&mut self, sample_all: bool, layer_id: u32) -> Result<u32, String> {
        self.doc.check_idle()?;
        let src = self.doc.sample_rgba8(sample_all, layer_id)?;
        let lw = LiveWire::new(&src, self.doc.width, self.doc.height);
        let id = self.next_livewire_id;
        self.next_livewire_id += 1;
        self.livewires.insert(id, lw);
        Ok(id)
    }

    /// The live wire from the last anchor to the pointer as flat x, y document pixels.
    #[allow(clippy::too_many_arguments)]
    pub fn magnetic_path(
        &self,
        handle: u32,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
        width: u32,
        contrast: u8,
    ) -> Result<Vec<i32>, String> {
        self.doc.check_idle()?;
        let lw = self.livewires.get(&handle).ok_or_else(|| format!("unknown magnetic lasso {handle}"))?;
        Ok(lw.path((x0, y0), (x1, y1), width, contrast).into_iter().flat_map(|(x, y)| [x, y]).collect())
    }

    pub fn magnetic_end(&mut self, handle: u32) -> Result<(), String> {
        self.livewires.remove(&handle).map(|_| ()).ok_or_else(|| format!("unknown magnetic lasso {handle}"))
    }

    /// Opens a stroke (B5 spec v2 Part E1) on `layer_id`; `target` is "pixels" or "selection"
    /// (quick mask). `params_json` is the brush: sizes in document pixels, angle in degrees,
    /// every other amount a 0..1 fraction, dynamics as `{control, fadeSteps, jitter, minimum}`.
    pub fn stroke_begin(&mut self, layer_id: u32, target: &str, params_json: &str) -> Result<(), String> {
        self.doc.check_idle()?;
        if self.stroke.is_some() {
            return Err("a stroke is already open".into());
        }
        let target = Target::parse(target)?;
        if target == Target::Mask {
            return Err("a stroke only supports the pixels or selection target".into());
        }
        let keep_alpha = if target == Target::Pixels {
            self.doc.check_pixel_paint(layer_id)?;
            self.doc.node(layer_id)?.locks.transparency
        } else {
            false
        };
        let hold = self.hold(layer_id, target)?;
        let sel_was_none = self.doc.selection.is_none();
        let snapshots = &self.snapshots;
        let stroke = parse_stroke(layer_id, target, params_json, &self.tips, &self.patterns, &self.snapshots, keep_alpha, sel_was_none, Some(&self.doc), |id| {
            let snap = snapshots.get(&id).ok_or_else(|| format!("unknown snapshot {id}"))?;
            let tiles = snap
                .node(layer_id)
                .and_then(|n| n.pixel_tiles())
                .map_err(|_| format!("layer {layer_id} has no pixels in snapshot {id}"))?;
            Ok(tiles.clone())
        });
        let stroke = match stroke {
            Ok(s) => s,
            Err(e) => {
                self.release(hold)?;
                return Err(e);
            }
        };
        self.stroke_hold = hold;
        if target == Target::Selection && sel_was_none {
            self.doc.selection = Some(SelMask::default());
        }
        let mut stroke = stroke;
        if matches!(stroke.effect, Some(Effect::Mixer { color: None, .. })) {
            stroke.reservoir = self.mixer_well.clone();
        }
        self.stroke = Some(stroke);
        Ok(())
    }

    /// Brush preview (E1.12): renders a fixed S-curve stroke with a pressure ramp of 0 -> 1 along
    /// its length (both curves are ours, not the reference app's) through the same stroke code
    /// path, on a temporary one-layer document capped at 1024 x 256. Always uses seed 0 so the
    /// same brush always previews the same, regardless of its own `seed`.
    pub fn brush_preview(&self, params_json: &str, w: u32, h: u32) -> Result<Vec<u8>, String> {
        if w == 0 || h == 0 || w > 1024 || h > 256 {
            return Err("brush preview size must be 1..=1024 x 1..=256".into());
        }
        let mut doc = Document::new(w, h, 8)?;
        let layer = 1; // Document::new's Background layer.
        let mut st = parse_stroke(layer, Target::Pixels, params_json, &self.tips, &self.patterns, &HashMap::new(), false, true, None, |id| {
            Err(format!("brush preview has no snapshot {id}"))
        })?;
        st.prng = stroke::Prng::new(0);
        st.seed = 0;
        let n: usize = 64;
        let mut samples = Vec::with_capacity(n * st.stride as usize);
        for i in 0..n {
            let t = i as f64 / (n - 1) as f64;
            samples.push(w as f64 * (0.1 + 0.8 * t));
            samples.push(h as f64 * 0.5 + h as f64 * 0.35 * (t * std::f64::consts::PI * 2.0).sin());
            samples.push(t);
            if st.stride == 6 {
                samples.push(0.0);
                samples.push(0.0);
                samples.push(0.0);
            }
        }
        doc.stroke_apply(&mut st, &samples)?;
        doc.sample_rgba8(true, layer)
    }

    /// Adds `samples` (flat x, y, pressure triples) to the open stroke and returns the changed
    /// document rect as [x, y, w, h], empty when nothing moved.
    pub fn stroke_to(&mut self, samples: &[f64]) -> Result<Vec<i32>, String> {
        let st = self.stroke.as_mut().ok_or_else(|| "no stroke is open".to_string())?;
        self.doc.stroke_apply(st, samples)
    }

    /// Closes the stroke; a heal stroke repairs what it covered first.
    pub fn stroke_end(&mut self) -> Result<(), String> {
        let st = self.stroke.take().ok_or_else(|| "no stroke is open".to_string())?;
        if let Some(Effect::Mixer { clean, .. }) = st.effect {
            self.mixer_well = if clean { None } else { st.reservoir.clone() };
        }
        let r = self.doc.heal_stroke(&st).map(|_| ());
        let h = self.stroke_hold.take();
        self.release(h)?;
        r
    }

    /// Drops the stroke and puts the stroke-start tiles back, ids included.
    pub fn stroke_cancel(&mut self) -> Result<(), String> {
        let st = self.stroke.take().ok_or_else(|| "no stroke is open".to_string())?;
        if st.target == Target::Pixels {
            let tiles = self.doc.node_mut(st.layer)?.pixel_tiles_mut()?;
            for ((tx, ty), t) in st.tiles {
                tiles.put(tx, ty, t.orig);
            }
        } else if st.sel_was_none {
            self.doc.selection = None;
        } else if let Some(sel) = self.doc.selection.as_mut() {
            for ((tx, ty), t) in st.tiles {
                sel.tiles.put(tx, ty, t.orig);
            }
        }
        // The tiles are back, so a color hold has nothing left to keep.
        match self.stroke_hold.take() {
            Some(Hold::Color(..)) | None => Ok(()),
            h => self.release(h),
        }
    }

    pub fn snapshot(&mut self) -> u32 {
        let id = self.next_snapshot_id;
        self.next_snapshot_id += 1;
        self.snapshots.insert(id, self.doc.clone());
        id
    }

    pub fn restore(&mut self, id: u32) -> Result<(), String> {
        let snap = self.snapshots.get(&id).ok_or_else(|| format!("unknown snapshot {id}"))?;
        // Ids must never go backwards, so they stay unique across restores.
        let next_id = self.doc.next_id.max(snap.next_id);
        let next_node_id = self.doc.next_node_id.max(snap.next_node_id);
        let mut restored = snap.clone();
        restored.next_id = next_id;
        restored.next_node_id = next_node_id;
        self.doc = restored;
        Ok(())
    }

    pub fn drop_snapshot(&mut self, id: u32) {
        self.snapshots.remove(&id);
    }

    /// Edit > Fade toward layer `id` in snapshot `snap` (the state before the last step).
    pub fn fade(&mut self, id: u32, snap: u32, json: &str) -> Result<(), String> {
        let prev = self.snapshots.get(&snap).ok_or("There is nothing to fade.")?;
        self.doc.fade(id, prev, json)
    }

    // Searches the current document first, then every live snapshot: an
    // autosave can hold a snapshot's tile ids after the live doc drops them.
    pub fn tile_bytes(&self, id: u64) -> Result<Vec<u8>, String> {
        if let Ok(bytes) = self.doc.tile_bytes(id) {
            return Ok(bytes);
        }
        for snap in self.snapshots.values() {
            if let Ok(bytes) = snap.tile_bytes(id) {
                return Ok(bytes);
            }
        }
        Err(format!("unknown tile id {id}"))
    }
}
