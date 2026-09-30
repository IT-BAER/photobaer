//! Filter registry and stored filter instances (docs/M5.md section 1). One table drives
//! validation, the schema the app builds its menu and dialogs from, and execution.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::adjust::Adjustment;

mod blur;
mod noise;
mod registry;
mod sharpen;
mod stylize;

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
}

#[derive(Clone, Copy)]
pub enum Def {
    Num(f64),
    Str(&'static str),
    Bool(bool),
    Point(f64, f64),
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
    }
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
    }
}

/// Runs `f` over `plane` (straight RGBA); the plane is the output rect grown by the reach.
pub fn apply(f: &Filter, plane: &mut Plane, ctx: &Ctx) -> Result<(), String> {
    (f.spec()?.apply)(plane, f, ctx)
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
