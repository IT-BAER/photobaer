//! Filter registry and stored filter instances (docs/M5.md section 1). One table drives
//! validation, the schema the app builds its menu and dialogs from, and execution.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::adjust::Adjustment;

mod blur;
mod blur_gallery;
mod distort;
mod gallery;
mod noise;
mod other;
mod pixelate;
mod registry;
mod render;
mod sharpen;
mod stylize;

pub(crate) use blur::box_blur;
pub use registry::lookup;

/// How much of the layer one output pixel reads: itself, a `reach` neighborhood, or everything.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Exec {
    Point,
    Local,
    Global,
}

#[derive(Clone, Copy)]
pub enum PKind {
    Number,
    Int,
    Percent,
    Angle,
    Select(&'static [&'static str]),
    Bool,
    /// A document blob id.
    Blob,
    /// The per-instance random seed (u32, D4).
    Seed,
    /// `{ x, y }` as fractions of the layer bounds.
    Point,
    /// Exactly 25 numbers, a 5x5 convolution kernel row by row.
    Kernel,
    /// 2..16 `{ y, offset }` points, y in 0..1 and offset in -1..1, sorted by y.
    Curve,
    /// `#rrggbb`; the app fills `foreground` and `background` from the current colors.
    Color,
    /// 0..16 Lighting Effects lights (`render::LIGHT_KEYS`).
    Lights,
    /// 2..256 `{ x, y }` points as fractions of the layer bounds.
    Path,
    /// 1..1000 Field Blur pins `{ x, y, blur }`: x, y fractions of the layer bounds, blur 0..1000 px.
    Pins,
    /// 1..1000 paths of 2..256 `{ x, y }` points as fractions of the layer bounds.
    Paths,
    /// 0..64 Filter Gallery effect layers `{ kind, enabled, params }`, applied bottom (first) to top.
    Stack,
    /// A Puppet Warp rig (`puppet::Rig`).
    Rig,
    /// Perspective Warp quads (`pwarp::State`).
    Quads,
    /// Vanishing Point planes and dabs (`vanishing::State`).
    Stamps,
}

#[derive(Clone, Copy)]
pub enum Def {
    Num(f64),
    Str(&'static str),
    Bool(bool),
    Point(f64, f64),
    /// The identity kernel.
    Kernel,
    /// The flat curve.
    Curve,
    Color(&'static str),
    /// One default spot light.
    Lights,
    Path(&'static [(f64, f64)]),
    Pins(&'static [(f64, f64, f64)]),
    Paths(&'static [&'static [(f64, f64)]]),
    /// The empty stack.
    Stack,
    /// No default: the param must be given.
    Required,
}

pub struct Param {
    pub key: &'static str,
    pub label: &'static str,
    pub kind: PKind,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub unit: &'static str,
    pub default: Def,
}

pub type Params = Map<String, Value>;

pub struct Spec {
    pub id: &'static str,
    pub label: &'static str,
    /// Menu group (`blur`, `stylize`, ...); `adjust` entries live in Image > Adjustments.
    pub group: &'static str,
    pub params: &'static [Param],
    pub exec: Exec,
    pub keep_alpha: bool,
    pub preview: bool,
    pub rgb_only: bool,
    /// The params are a typed M3 adjustment edited by its own dialog.
    pub adjustment: bool,
    pub reach: fn(&Filter) -> i32,
    /// The document rect the output of a source within a rect can cover, when it is not the rect
    /// grown by `reach` (the warps move pixels any distance).
    pub extent: Option<fn(&Filter, [i32; 4]) -> Result<[i32; 4], String>>,
    pub apply: fn(&mut Plane, &Filter, &Ctx) -> Result<(), String>,
}

/// Straight RGBA (0..1) over document rect (x, y, w, h).
#[derive(Clone, Debug, PartialEq)]
pub struct Plane {
    pub x: i32,
    pub y: i32,
    pub w: usize,
    pub h: usize,
    pub data: Vec<f32>,
}

impl Plane {
    pub fn premultiply(&mut self) {
        for p in self.data.chunks_exact_mut(4) {
            for c in 0..3 {
                p[c] *= p[3];
            }
        }
    }

    pub fn unpremultiply(&mut self) {
        for p in self.data.chunks_exact_mut(4) {
            let a = p[3];
            for c in 0..3 {
                p[c] = if a > 0.0 { p[c] / a } else { 0.0 };
            }
        }
    }
}

#[derive(Clone, Copy)]
pub struct Ctx<'a> {
    pub blobs: &'a HashMap<u64, Arc<Vec<u8>>>,
    /// Selection coverage per plane pixel, for global filters that read only the selected area.
    pub cov: Option<&'a [f32]>,
    /// The layer bounds in document px: the rect point params are fractions of.
    pub bounds: [i32; 4],
    /// Plane px per document px (below 1 in a preview proxy).
    pub scale: f64,
    /// The target layer's mask (0..1) at a document px, when it has one.
    pub mask: Option<&'a dyn Fn(i32, i32) -> f32>,
}

/// A stored filter: `{ kind, params }` with params normalized against the registry schema.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Filter {
    pub kind: String,
    pub params: Params,
}

impl Filter {
    pub fn parse(json: &str) -> Result<Filter, String> {
        let f: Filter = serde_json::from_str(json).map_err(|e| format!("invalid filter: {e}"))?;
        f.normalized()
    }

    pub fn spec(&self) -> Result<&'static Spec, String> {
        lookup(&self.kind).ok_or_else(|| format!("unknown filter kind \"{}\"", self.kind))
    }

    /// Validates against the schema: unknown key, wrong type or a value outside min..max errs
    /// naming the filter and key; missing keys take their default.
    pub fn normalized(self) -> Result<Filter, String> {
        let spec = self.spec()?;
        if spec.adjustment {
            let a: Adjustment = serde_json::from_value(json!({ "kind": self.kind, "params": self.params }))
                .map_err(|e| format!("{}: invalid params: {e}", spec.label))?;
            a.validate()?;
            return Ok(Filter::from_adjustment(&a));
        }
        if let Some(k) = self.params.keys().find(|k| !spec.params.iter().any(|p| p.key == k.as_str())) {
            return Err(format!("{}: unknown parameter \"{k}\"", spec.label));
        }
        let mut out = Params::new();
        for p in spec.params {
            let v = match self.params.get(p.key) {
                None if matches!(p.default, Def::Required) => return Err(format!("{}: {} is required", spec.label, p.key)),
                None => default_value(p),
                Some(v) => check(spec, p, v)?,
            };
            out.insert(p.key.into(), v);
        }
        Ok(Filter { kind: self.kind, params: out })
    }

    pub fn adjustment(&self) -> Option<Adjustment> {
        serde_json::from_value(json!({ "kind": self.kind, "params": self.params })).ok()
    }

    pub fn from_adjustment(a: &Adjustment) -> Filter {
        // Through a string: to_value widens f32 fields (0.1 -> 0.10000000149011612) and would change saved bytes.
        serde_json::from_str(&serde_json::to_string(a).expect("an adjustment serializes")).expect("an adjustment is a filter")
    }

    /// The blob this filter references (a lookup table, a map), if any.
    pub fn blob(&self) -> Option<u64> {
        let spec = self.spec().ok()?;
        if spec.adjustment {
            return self.adjustment()?.blob();
        }
        spec.params.iter().find(|p| matches!(p.kind, PKind::Blob)).and_then(|p| self.params.get(p.key)?.as_u64())
    }

    pub fn reach(&self) -> i32 {
        self.spec().map_or(0, |s| (s.reach)(self))
    }

    /// The document rect the output of a source within `r` can cover.
    pub fn extent(&self, r: [i32; 4]) -> Result<[i32; 4], String> {
        match self.spec()?.extent {
            Some(e) => e(self, r),
            None => {
                let n = self.reach();
                Ok([r[0] - n, r[1] - n, r[2] + 2 * n, r[3] + 2 * n])
            }
        }
    }

    pub fn num(&self, key: &str) -> f64 {
        self.params.get(key).and_then(Value::as_f64).unwrap_or(0.0)
    }

    pub fn text(&self, key: &str) -> &str {
        self.params.get(key).and_then(Value::as_str).unwrap_or("")
    }

    pub fn flag(&self, key: &str) -> bool {
        self.params.get(key).and_then(Value::as_bool).unwrap_or(false)
    }

    pub fn point(&self, key: &str) -> (f64, f64) {
        let c = |k: &str| self.params.get(key).and_then(|p| p.get(k)).and_then(Value::as_f64).unwrap_or(0.5);
        (c("x"), c("y"))
    }

    /// The 25 kernel numbers of a `Kernel` param.
    pub fn kernel(&self, key: &str) -> Vec<f32> {
        self.params.get(key).and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().filter_map(Value::as_f64).map(|n| n as f32).collect())
    }

    /// The `(y, offset)` points of a `Curve` param, sorted by y.
    pub fn curve(&self, key: &str) -> Vec<(f64, f64)> {
        let at = |o: &Value, k: &str| o.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        self.params.get(key).and_then(Value::as_array).map_or_else(Vec::new, |a| a.iter().map(|o| (at(o, "y"), at(o, "offset"))).collect())
    }

    /// The `{ x, y }` points of a `Path` param, or of one path of a `Paths` param.
    pub fn points(v: &Value) -> Vec<(f64, f64)> {
        let c = |q: &Value, k: &str| q.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        v.as_array().map_or_else(Vec::new, |a| a.iter().map(|q| (c(q, "x"), c(q, "y"))).collect())
    }

    /// A `Color` param as 0..1 RGB.
    pub fn color(&self, key: &str) -> [f32; 3] {
        parse_hex(self.text(key)).unwrap_or([0.0; 3])
    }

    /// Reads the target layer's mask (`Ctx::mask`), so a smart cache depends on it.
    pub fn reads_mask(&self) -> bool {
        self.kind == "blur.lens_blur" && self.text("depthMapSource") == "layerMask"
    }

    /// The same filter with its px params times `s` (a preview proxy), kept inside their range.
    pub fn scaled(&self, s: f64) -> Filter {
        let mut f = self.clone();
        if let Ok(spec) = self.spec() {
            for p in spec.params.iter().filter(|p| p.unit == "px") {
                if let Some(v) = f.params.get(p.key).and_then(Value::as_f64) {
                    f.params.insert(p.key.into(), json!((v * s).clamp(p.min, p.max)));
                }
            }
        }
        f
    }
}

fn default_value(p: &Param) -> Value {
    match p.default {
        Def::Num(n) if matches!(p.kind, PKind::Int | PKind::Seed | PKind::Blob) => json!(n as i64),
        Def::Num(n) => json!(n),
        Def::Str(s) => json!(s),
        Def::Bool(b) => json!(b),
        Def::Point(x, y) => json!({ "x": x, "y": y }),
        Def::Kernel => json!((0..25).map(|i| f64::from(i == 12)).collect::<Vec<_>>()),
        Def::Curve => json!([{ "y": 0.0, "offset": 0.0 }, { "y": 1.0, "offset": 0.0 }]),
        Def::Color(c) => json!(c),
        Def::Lights => json!([render::default_light()]),
        Def::Path(pts) => points_json(pts),
        Def::Pins(pins) => Value::Array(pins.iter().map(|&(x, y, blur)| json!({ "x": x, "y": y, "blur": blur })).collect()),
        Def::Paths(paths) => Value::Array(paths.iter().map(|pts| points_json(pts)).collect()),
        Def::Stack => json!([]),
        Def::Required => Value::Null,
    }
}

fn points_json(pts: &[(f64, f64)]) -> Value {
    Value::Array(pts.iter().map(|&(x, y)| json!({ "x": x, "y": y })).collect())
}

// `{ x, y }` with both in 0..=1 and no other key.
fn unit_point(o: &Value) -> Option<Value> {
    let c = |k: &str| o.get(k)?.as_f64().filter(|n| (0.0..=1.0).contains(n));
    Some(json!({ "x": c("x")?, "y": c("y")? })).filter(|_| o.as_object().is_some_and(|o| o.len() == 2))
}

fn path_points(v: &Value) -> Option<Value> {
    v.as_array().filter(|a| (2..=256).contains(&a.len()))?.iter().map(unit_point).collect::<Option<Vec<_>>>().map(Value::Array)
}

fn check(spec: &Spec, p: &Param, v: &Value) -> Result<Value, String> {
    let bad = |what: &str| format!("{}: {} must be {what}", spec.label, p.key);
    let range = || format!("in {}..={}", p.min, p.max);
    match p.kind {
        PKind::Number | PKind::Percent | PKind::Angle => {
            let n = v.as_f64().filter(|n| n.is_finite()).ok_or_else(|| bad("a number"))?;
            if !(p.min..=p.max).contains(&n) {
                return Err(bad(&range()));
            }
            Ok(json!(n))
        }
        PKind::Int => {
            let n = v.as_f64().filter(|n| n.fract() == 0.0).ok_or_else(|| bad("an integer"))?;
            if !(p.min..=p.max).contains(&n) {
                return Err(bad(&range()));
            }
            Ok(json!(n as i64))
        }
        PKind::Select(choices) => match v.as_str() {
            Some(s) if choices.contains(&s) => Ok(json!(s)),
            _ => Err(bad(&format!("one of {}", choices.join(", ")))),
        },
        PKind::Bool => v.as_bool().map(Value::Bool).ok_or_else(|| bad("true or false")),
        PKind::Blob => v.as_u64().map(|n| json!(n)).ok_or_else(|| bad("a blob id")),
        PKind::Seed => v.as_u64().filter(|n| *n <= u32::MAX as u64).map(|n| json!(n)).ok_or_else(|| bad("a 32-bit seed")),
        PKind::Point => {
            let o = v.as_object().filter(|o| o.len() == 2).ok_or_else(|| bad("a point { x, y }"))?;
            let c = |k: &str| o.get(k).and_then(Value::as_f64).filter(|n| (p.min..=p.max).contains(n));
            match (c("x"), c("y")) {
                (Some(x), Some(y)) => Ok(json!({ "x": x, "y": y })),
                _ => Err(bad(&format!("a point {{ x, y }} with both {}", range()))),
            }
        }
        PKind::Kernel => {
            let k: Option<Vec<f64>> = v.as_array().filter(|a| a.len() == 25).and_then(|a| a.iter().map(|n| n.as_f64().filter(|n| (p.min..=p.max).contains(n))).collect());
            k.map(|k| json!(k)).ok_or_else(|| bad(&format!("an array of 25 numbers {}", range())))
        }
        PKind::Curve => {
            let pt = |o: &Value| Some((o.get("y")?.as_f64().filter(|n| n.is_finite())?, o.get("offset")?.as_f64().filter(|n| n.is_finite())?));
            let pts: Option<Vec<(f64, f64)>> = v.as_array().filter(|a| (2..=16).contains(&a.len())).and_then(|a| a.iter().map(pt).collect());
            let mut pts = pts.ok_or_else(|| bad("2 to 16 points { y, offset }"))?;
            pts.iter_mut().for_each(|p| *p = (p.0.clamp(0.0, 1.0), p.1.clamp(-1.0, 1.0)));
            pts.sort_by(|a, b| a.0.total_cmp(&b.0));
            Ok(Value::Array(pts.into_iter().map(|(y, offset)| json!({ "y": y, "offset": offset })).collect()))
        }
        PKind::Color => v.as_str().filter(|s| parse_hex(s).is_some()).map(|s| json!(s.to_ascii_lowercase())).ok_or_else(|| bad("a color #rrggbb")),
        PKind::Lights => {
            let a = v.as_array().filter(|a| a.len() <= 16).ok_or_else(|| bad("an array of at most 16 lights"))?;
            let each = a.iter().enumerate().map(|(i, l)| render::check_light(l).map_err(|e| format!("{}: {} entry {} {e}", spec.label, p.key, i + 1)));
            Ok(Value::Array(each.collect::<Result<_, _>>()?))
        }
        PKind::Path => path_points(v).ok_or_else(|| bad("2 to 256 points { x, y } in 0..=1")),
        PKind::Pins => {
            let pin = |o: &Value| {
                let c = |k: &str, max: f64| o.get(k)?.as_f64().filter(|n| (0.0..=max).contains(n));
                Some(json!({ "x": c("x", 1.0)?, "y": c("y", 1.0)?, "blur": c("blur", 1000.0)? })).filter(|_| o.as_object().is_some_and(|o| o.len() == 3))
            };
            let pins: Option<Vec<Value>> = v.as_array().filter(|a| (1..=1000).contains(&a.len())).and_then(|a| a.iter().map(pin).collect());
            pins.map(Value::Array).ok_or_else(|| bad("1 to 1000 pins { x, y, blur } with x, y in 0..=1 and blur in 0..=1000"))
        }
        PKind::Paths => {
            let paths: Option<Vec<Value>> = v.as_array().filter(|a| (1..=1000).contains(&a.len())).and_then(|a| a.iter().map(path_points).collect());
            paths.map(Value::Array).ok_or_else(|| bad("1 to 1000 paths of 2 to 256 points { x, y } in 0..=1"))
        }
        PKind::Stack => {
            let a = v.as_array().filter(|a| a.len() <= 64).ok_or_else(|| bad("an array of at most 64 effect layers"))?;
            let each = a.iter().enumerate().map(|(i, e)| gallery::check_layer(e).map_err(|m| format!("{}: {} entry {} {m}", spec.label, p.key, i + 1)));
            Ok(Value::Array(each.collect::<Result<_, _>>()?))
        }
        PKind::Rig => crate::puppet::check(v),
        PKind::Quads => crate::pwarp::check(v),
        PKind::Stamps => crate::vanishing::check(v),
    }
}

/// `#rrggbb` as 0..1 RGB.
pub(crate) fn parse_hex(s: &str) -> Option<[f32; 3]> {
    let h = s.strip_prefix('#').filter(|h| h.len() == 6 && h.bytes().all(|b| b.is_ascii_hexdigit()))?;
    Some(std::array::from_fn(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).map_or(0.0, |v| f32::from(v) / 255.0)))
}

/// Runs `f` over `plane` (straight RGBA); the plane is the output rect grown by the reach.
pub fn apply(f: &Filter, plane: &mut Plane, ctx: &Ctx) -> Result<(), String> {
    (f.spec()?.apply)(plane, f, ctx)
}

/// 32-bit seeded generator (Wave patterns, patch search): a seed hash, then a counter-based mixer.
pub(crate) struct Rng(u32);

impl Rng {
    pub(crate) fn new(seed: u32) -> Rng {
        Rng((seed ^ 0x9E37_79B9).wrapping_mul(0x85EB_CA6B) ^ (seed >> 13))
    }

    pub(crate) fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6D2B_79F5);
        let mut o = self.0;
        o = (o ^ (o >> 15)).wrapping_mul(o | 1);
        o ^= o.wrapping_add((o ^ (o >> 7)).wrapping_mul(o | 61));
        (o ^ (o >> 14)) as f64 / 4_294_967_296.0
    }

    pub(crate) fn range(&mut self, a: f64, b: f64) -> f64 {
        a + self.next() * (b - a)
    }
}

/// A value in 0..1 from the seed and a document position and channel (D4): a tile rendered alone
/// equals the same tile of the whole-layer render.
pub fn hash(seed: u32, x: i32, y: i32, c: u32) -> f32 {
    let mut h = seed ^ 0x9e37_79b9;
    for v in [x as u32, y as u32, c] {
        h = (h ^ v).wrapping_mul(0x85eb_ca6b);
        h ^= h >> 13;
        h = h.wrapping_mul(0xc2b2_ae35);
        h ^= h >> 16;
    }
    (h >> 8) as f32 / (1u32 << 24) as f32
}

/// A standard normal value from two `hash` draws (Box-Muller), same positional rule.
pub fn gauss(seed: u32, x: i32, y: i32, c: u32) -> f32 {
    (-2.0 * hash(seed, x, y, c).max(1e-7).ln()).sqrt() * (2.0 * std::f32::consts::PI * hash(seed ^ 0x5bf0_3635, x, y, c)).cos()
}

/// The registry as JSON for the app (D3).
pub fn schema_json() -> String {
    let entries: Vec<Value> = registry::ALL
        .iter()
        .map(|s| {
            let params: Vec<Value> = s
                .params
                .iter()
                .map(|p| {
                    let (kind, choices) = match p.kind {
                        PKind::Number => ("number", None),
                        PKind::Int => ("int", None),
                        PKind::Percent => ("percent", None),
                        PKind::Angle => ("angle", None),
                        PKind::Select(c) => ("select", Some(c)),
                        PKind::Bool => ("bool", None),
                        PKind::Blob => ("blob", None),
                        PKind::Seed => ("seed", None),
                        PKind::Point => ("point", None),
                        PKind::Kernel => ("kernel", None),
                        PKind::Curve => ("curve", None),
                        PKind::Color => ("color", None),
                        PKind::Lights => ("lights", None),
                        PKind::Path => ("path", None),
                        PKind::Pins => ("pins", None),
                        PKind::Paths => ("paths", None),
                        PKind::Stack => ("stack", None),
                        PKind::Rig => ("rig", None),
                        PKind::Quads => ("quads", None),
                        PKind::Stamps => ("stamps", None),
                    };
                    let mut o = json!({ "key": p.key, "label": p.label, "kind": kind, "min": p.min, "max": p.max, "step": p.step,
                        "unit": p.unit, "default": default_value(p) });
                    if let Some(c) = choices {
                        o["choices"] = json!(c);
                    }
                    o
                })
                .collect();
            let mut o = json!({
                "id": s.id, "label": s.label, "group": s.group, "params": params,
                "exec": match s.exec { Exec::Point => "point", Exec::Local => "local", Exec::Global => "global" },
                "alpha": if s.keep_alpha { "kept" } else { "processed" }, "preview": s.preview, "rgb_only": s.rgb_only,
            });
            if s.adjustment {
                o["editor"] = "adjustment".into();
            }
            if s.extent.is_some() {
                o["whole"] = true.into();
            }
            o
        })
        .collect();
    Value::Array(entries).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic_and_spread() {
        assert_eq!(hash(7, 10, -3, 1), hash(7, 10, -3, 1));
        assert_ne!(hash(7, 10, -3, 1), hash(8, 10, -3, 1));
        let mean: f32 = (0..10_000).map(|i| hash(1, i % 100, i / 100, 0)).sum::<f32>() / 10_000.0;
        assert!((mean - 0.5).abs() < 0.02, "{mean}");
    }

    #[test]
    fn scaled_halves_px_params_within_range() {
        let f = Filter::parse(r#"{"kind":"gaussian_blur","params":{"radius":4}}"#).unwrap();
        assert_eq!(f.scaled(0.5).num("radius"), 2.0);
        assert_eq!(f.scaled(0.001).num("radius"), 0.1);
    }

    #[test]
    fn missing_keys_take_defaults_and_m3_kinds_keep_their_json() {
        let f = Filter::parse(r#"{"kind":"gaussian_blur","params":{}}"#).unwrap();
        assert_eq!(f.num("radius"), 1.0);
        let inv = Filter::parse(r#"{"kind":"invert","params":{}}"#).unwrap();
        assert_eq!(serde_json::to_string(&inv).unwrap(), r#"{"kind":"invert","params":{}}"#);
    }
}
