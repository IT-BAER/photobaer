// The draw program of docs/M1.md section 3 (version 2: docs/M3.md section 2), one compute
// dispatch per step over 256x256 tiles.
// Buffers are premultiplied f32 RGBA (shapes keep their value in .r); this mirrors the CPU
// reference in engine/src/doc.rs and engine/src/blend.rs channel for channel.
import { ADJUST, OP } from './program.ts';

/// The per-step uniform, one 32-bit word per field in this order; composite.ts writes it by name.
export const UNIFORM_FIELDS = [
  ['op', 'u32'], ['mask_kind', 'u32'], ['mode', 'u32'], ['src_is_tile', 'u32'],
  ['node', 'u32'], ['level', 'u32'], ['ox', 'u32'], ['oy', 'u32'],
  ['vw', 'u32'], ['vh', 'u32'], ['opcode', 'u32'], ['flags', 'u32'],
  ['scale', 'f32'], ['mask_const', 'f32'], ['pad2', 'f32'], ['pad3', 'f32'],
  // Blend If ranges, 4 bytes each: gray, red, green, blue, each source then destination.
  ['bi0', 'u32'], ['bi1', 'u32'], ['bi2', 'u32'], ['bi3', 'u32'],
  ['bi4', 'u32'], ['bi5', 'u32'], ['bi6', 'u32'], ['bi7', 'u32'],
] as const;
export type UniformField = (typeof UNIFORM_FIELDS)[number][0];
export const UNIFORM_AT = Object.fromEntries(UNIFORM_FIELDS.map(([n], i) => [n, i])) as Record<UniformField, number>;

export const COMPOSITE_WGSL = /* wgsl */ `
struct P { ${UNIFORM_FIELDS.map(([n, t]) => `${n}: ${t}`).join(', ')} };
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var dst_t: texture_2d<f32>;
@group(0) @binding(2) var aux_t: texture_2d<f32>;
@group(0) @binding(3) var shape_t: texture_2d<f32>;
@group(0) @binding(4) var src_t: texture_2d<f32>;
@group(0) @binding(5) var mask_t: texture_2d<f32>;
@group(0) @binding(6) var out_t: texture_storage_2d<rgba32float, write>;

const EPS = 1e-5;

fn multiply_c(cb: f32, cs: f32) -> f32 { return cb * cs; }
fn screen_c(cb: f32, cs: f32) -> f32 { return cb + cs - cb * cs; }

fn color_dodge(cb: f32, cs: f32) -> f32 {
  if (cb <= EPS) { return 0.0; }
  if (cs >= 1.0 - EPS) { return 1.0; }
  return min(cb / (1.0 - cs), 1.0);
}

fn color_burn(cb: f32, cs: f32) -> f32 {
  if (cb >= 1.0 - EPS) { return 1.0; }
  if (cs <= EPS) { return 0.0; }
  return 1.0 - min((1.0 - cb) / cs, 1.0);
}

fn hard_light(cb: f32, cs: f32) -> f32 {
  if (cs <= 0.5) { return multiply_c(cb, 2.0 * cs); }
  return screen_c(cb, 2.0 * cs - 1.0);
}

fn soft_light(cb: f32, cs: f32) -> f32 {
  if (cs <= 0.5) { return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb); }
  var d = sqrt(cb);
  if (cb <= 0.25) { d = ((16.0 * cb - 12.0) * cb + 4.0) * cb; }
  return cb + (2.0 * cs - 1.0) * (d - cb);
}

fn vivid_light(cb: f32, cs: f32) -> f32 {
  if (cs <= EPS) { return 0.0; }
  if (cs <= 0.5) { return 1.0 - min((1.0 - cb) / (2.0 * cs), 1.0); }
  if (cs >= 1.0 - EPS) { return 1.0; }
  return min(cb / (2.0 * (1.0 - cs)), 1.0);
}

fn hard_mix(cb: f32, cs: f32) -> f32 {
  if ((cs <= 0.5 && cb + cs >= 1.0 - EPS) || cb + cs > 1.0 + EPS) { return 1.0; }
  return 0.0;
}

fn divide_c(cb: f32, cs: f32) -> f32 {
  if (cs <= 0.0) { return select(1.0, 0.0, cb <= 0.0); }
  return min(cb / cs, 1.0);
}

fn lum(c: vec3f) -> f32 { return 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; }

fn clip_color(c0: vec3f) -> vec3f {
  var c = c0;
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  if (n < 0.0) { c = vec3f(l) + (c - vec3f(l)) * l / (l - n); }
  if (x > 1.0) { c = vec3f(l) + (c - vec3f(l)) * (1.0 - l) / (x - l); }
  return c;
}

fn set_lum(c: vec3f, l: f32) -> vec3f { return clip_color(c + vec3f(l - lum(c))); }

fn sat(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }

// The CPU sorts the channels and rescales the middle one; ties fall out the same way here.
fn set_sat(c: vec3f, s: f32) -> vec3f {
  let mn = min(c.r, min(c.g, c.b));
  let mx = max(c.r, max(c.g, c.b));
  if (mx <= mn) { return vec3f(0.0); }
  let mid = c.r + c.g + c.b - mn - mx;
  let m = (mid - mn) * s / (mx - mn);
  var o = vec3f(m);
  o = select(o, vec3f(s), c == vec3f(mx));
  o = select(o, vec3f(0.0), c == vec3f(mn));
  return o;
}

fn blend_rgb(mode: u32, cb: vec3f, cs: vec3f) -> vec3f {
  var o = cs;
  switch mode {
    case 3u: { o = cb * cs; }                                                   // multiply
    case 8u: { o = vec3f(screen_c(cb.r, cs.r), screen_c(cb.g, cs.g), screen_c(cb.b, cs.b)); }
    case 12u: { o = vec3f(hard_light(cs.r, cb.r), hard_light(cs.g, cb.g), hard_light(cs.b, cb.b)); } // overlay
    case 2u: { o = min(cb, cs); }                                               // darken
    case 7u: { o = max(cb, cs); }                                               // lighten
    case 9u: { o = vec3f(color_dodge(cb.r, cs.r), color_dodge(cb.g, cs.g), color_dodge(cb.b, cs.b)); }
    case 4u: { o = vec3f(color_burn(cb.r, cs.r), color_burn(cb.g, cs.g), color_burn(cb.b, cs.b)); }
    case 14u: { o = vec3f(hard_light(cb.r, cs.r), hard_light(cb.g, cs.g), hard_light(cb.b, cs.b)); }
    case 13u: { o = vec3f(soft_light(cb.r, cs.r), soft_light(cb.g, cs.g), soft_light(cb.b, cs.b)); }
    case 19u: { o = abs(cb - cs); }                                             // difference
    case 20u: { o = cb + cs - 2.0 * cb * cs; }                                  // exclusion
    case 5u: { o = cb + cs - vec3f(1.0); }                                      // linear burn
    case 10u: { o = cb + cs; }                                                  // linear dodge
    case 15u: { o = vec3f(vivid_light(cb.r, cs.r), vivid_light(cb.g, cs.g), vivid_light(cb.b, cs.b)); }
    case 16u: { o = cb + 2.0 * cs - vec3f(1.0); }                               // linear light
    case 17u: { o = select(max(cb, 2.0 * cs - vec3f(1.0)), min(cb, 2.0 * cs), cs <= vec3f(0.5)); }
    case 18u: { o = vec3f(hard_mix(cb.r, cs.r), hard_mix(cb.g, cs.g), hard_mix(cb.b, cs.b)); }
    case 21u: { o = cb - cs; }                                                  // subtract
    case 22u: { o = vec3f(divide_c(cb.r, cs.r), divide_c(cb.g, cs.g), divide_c(cb.b, cs.b)); }
    case 6u: { o = select(cb, cs, lum(cs) < lum(cb)); }                         // darker color
    case 11u: { o = select(cb, cs, lum(cs) > lum(cb)); }                        // lighter color
    case 23u: { o = set_lum(set_sat(cs, sat(cb)), lum(cb)); }                   // hue
    case 24u: { o = set_lum(set_sat(cb, sat(cs)), lum(cb)); }                   // saturation
    case 25u: { o = set_lum(cs, lum(cb)); }                                     // color
    case 26u: { o = set_lum(cb, lum(cs)); }                                     // luminosity
    default: { o = cs; }                                                        // normal, dissolve
  }
  return clamp(o, vec3f(0.0), vec3f(1.0));
}

fn dissolve_hash(x: u32, y: u32, node: u32) -> f32 {
  var h = (x * 0x9E3779B1u) ^ (y * 0x85EBCA77u) ^ (node * 0xC2B2AE3Du);
  h ^= h >> 15u;
  h *= 0x2545F491u;
  h ^= h >> 13u;
  h *= 0x27220A95u;
  h ^= h >> 16u;
  return f32(h >> 8u) / 16777216.0;
}

// Blend If (docs/M3.md section 5): 0 below black outer, ramp to black inner, 1, ramp down from
// white inner to white outer, 0 above; values in 0..255.
fn ramp(v0: f32, w: u32) -> f32 {
  let r = round(unpack4x8unorm(w) * 255.0);
  let v = clamp(v0, 0.0, 255.0);
  if (v < r.x || v > r.w) { return 0.0; }
  if (v < r.y) { return (v - r.x) / (r.y - r.x); }
  if (v <= r.z) { return 1.0; }
  return (r.w - v) / (r.w - r.z);
}

fn blend_if(s: vec3f, d: vec3f) -> f32 {
  let s8 = s * 255.0;
  let d8 = d * 255.0;
  return ramp(lum(s) * 255.0, p.bi0) * ramp(lum(d) * 255.0, p.bi1)
    * ramp(s8.r, p.bi2) * ramp(d8.r, p.bi3) * ramp(s8.g, p.bi4) * ramp(d8.g, p.bi5)
    * ramp(s8.b, p.bi6) * ramp(d8.b, p.bi7);
}

fn straight(v: vec4f) -> vec3f {
  if (v.a <= 0.0) { return vec3f(0.0); }
  return clamp(v.rgb / v.a, vec3f(0.0), vec3f(1.0));
}

// The Adjust opcodes of engine/src/adjust.rs.
fn adjust_rgb(c: vec3f) -> vec3f {
  switch p.opcode {
    case ${ADJUST.invert}u: { return vec3f(1.0) - c; }
    default: { return c; }
  }
}

fn dissolve_hit(xy: vec2i, k: f32) -> bool {
  let dx = (p.ox + u32(xy.x)) << p.level;
  let dy = (p.oy + u32(xy.y)) << p.level;
  return dissolve_hash(dx, dy, p.node) < k;
}

// Adjust on the top buffer in place; alpha is never changed.
fn adjust_px(xy: vec2i, dst: vec4f) -> vec4f {
  if (dst.a <= 0.0) { return dst; }
  var k = p.scale * mask_at(xy);
  if ((p.flags & 1u) != 0u) { k *= textureLoad(shape_t, xy, 0).r; }
  if (k <= 0.0) { return dst; }
  if (p.mode == 1u) {
    if (!dissolve_hit(xy, k)) { return dst; }
    k = 1.0;
  }
  let o = straight(dst);
  let r = blend_rgb(p.mode, o, adjust_rgb(o));
  let l = o + (r - o) * k;
  return vec4f((o + (l - o) * blend_if(l, o)) * dst.a, dst.a);
}

fn mask_at(xy: vec2i) -> f32 {
  switch p.mask_kind {
    case 1u: { return p.mask_const; }
    case 2u: { return textureLoad(mask_t, xy, 0).r; }
    default: { return 1.0; }
  }
}

// Straight (unpremultiplied) source RGBA, like the CPU \`Src::at\`.
fn src_at(xy: vec2i) -> vec4f {
  if (p.src_is_tile == 1u) { return textureLoad(src_t, xy, 0); }
  let v = textureLoad(aux_t, xy, 0);
  if (v.a > 0.0) { return vec4f(v.rgb / v.a, v.a); }
  return vec4f(0.0);
}

fn draw_px(xy: vec2i, dst: vec4f) -> vec4f {
  let s = src_at(xy);
  if (s.a <= 0.0) { return dst; }
  var cov = s.a * p.scale * mask_at(xy) * blend_if(s.rgb, straight(dst));
  if (cov <= 0.0) { return dst; }
  if (p.mode == 1u) { // dissolve: document coordinates of the sample's top-left source pixel
    if (!dissolve_hit(xy, cov)) { return dst; }
    cov = 1.0;
  }
  let ab = dst.a;
  // W3C: Cm = (1 - ab) * Cs + ab * B(Cb, Cs); with ab = 0 that is Cs.
  var cm = s.rgb;
  let plain = p.mode == 0u || p.mode == 1u || p.mode == 27u;
  if (!plain && ab > 0.0) {
    let cb = clamp(dst.rgb / ab, vec3f(0.0), vec3f(1.0));
    cm = (1.0 - ab) * s.rgb + ab * blend_rgb(p.mode, cb, s.rgb);
  }
  let inv = 1.0 - cov;
  return vec4f(cov * cm + inv * dst.rgb, cov + inv * ab);
}

fn step_value(xy: vec2i) -> vec4f {
  let dst = textureLoad(dst_t, xy, 0);
  let inside = u32(xy.x) < p.vw && u32(xy.y) < p.vh;
  switch p.op {
    case ${OP.draw}u: {
      if (!inside) { return dst; }
      return draw_px(xy, dst);
    }
    case ${OP.pushTransparent}u: { return vec4f(0.0); }
    case ${OP.pushCopy}u: { return dst; }
    case ${OP.popLerp}u: {
      let k = p.scale * mask_at(xy);
      if (!inside || k <= 0.0) { return dst; }
      return dst + (textureLoad(aux_t, xy, 0) - dst) * k;
    }
    case ${OP.pushShape}u: {
      if (!inside) { return vec4f(0.0); }
      return vec4f(src_at(xy).a * mask_at(xy) * p.scale, 0.0, 0.0, 0.0);
    }
    case ${OP.divShape}u: {
      let s = textureLoad(shape_t, xy, 0).r;
      return select(vec4f(0.0), dst / s, s > 0.0);
    }
    case ${OP.mulShape}u: { return dst * textureLoad(shape_t, xy, 0).r; }
    case ${OP.subBackdrop}u: { return dst - (1.0 - textureLoad(shape_t, xy, 0).r) * textureLoad(aux_t, xy, 0); }
    case ${OP.popAddBackdrop}u: { return (1.0 - textureLoad(shape_t, xy, 0).r) * dst + textureLoad(aux_t, xy, 0); }
    case ${OP.adjust}u: {
      if (!inside) { return dst; }
      return adjust_px(xy, dst);
    }
    case ${OP.knockout}u: {
      if (!inside) { return dst; }
      return dst * (1.0 - src_at(xy).a * mask_at(xy) * p.scale);
    }
    default: { return dst; }
  }
}

@compute @workgroup_size(8, 8)
fn step_main(@builtin(global_invocation_id) gid: vec3u) {
  let xy = vec2i(gid.xy);
  textureStore(out_t, xy, step_value(xy));
}
`;

// Final quantization: round(v * 255) clamped, like the CPU display tile.
export const QUANTIZE_WGSL = /* wgsl */ `
@group(0) @binding(0) var src_t: texture_2d<f32>;
@group(0) @binding(1) var out_t: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn quantize(@builtin(global_invocation_id) gid: vec3u) {
  let xy = vec2i(gid.xy);
  let v = clamp(textureLoad(src_t, xy, 0), vec4f(0.0), vec4f(1.0));
  textureStore(out_t, xy, floor(v * 255.0 + 0.5) / 255.0);
}
`;
