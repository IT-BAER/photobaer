//! The 47 Filter Gallery effects (docs/M5.md section 14), painterly approximations (D7) on
//! premultiplied color. Kinds are `gallery.<group>.<name>`.

use super::*;

pub(super) fn run(p: &mut Plane, f: &Filter, fx: &Fx) -> Result<(), String> {
    let n = |k: &str| f.num(k);
    let name = f.kind.rsplit('.').next().unwrap_or("");
    match name {
        // Artistic
        "colored_pencil" => {
            let edge = high_pass(&luma(p), 0.0, n("pencilWidth") as f32);
            let t = strokes(p.w, p.h, 45.0, n("pencilWidth") * 3.0, n("pencilWidth"), fx.seed, fx);
            let (paper, pressure) = (0.65 + n("paperBrightness") as f32 / 50.0 * 0.35, n("strokePressure") as f32 / 15.0);
            let m = Map { w: p.w, h: p.h, v: edge.v.iter().zip(&t.v).map(|(e, t)| clamp01(clamp01(-e * 8.0) * t * pressure * 2.0)).collect() };
            each(p, &m, |c, k| paper + (c - paper) * k);
        }
        "cutout" => {
            let g = n("edgeSimplicity").round().max(1.0);
            simplify(p, g);
            if n("edgeFidelity") < 3.0 {
                blur(p, (4.0 - n("edgeFidelity")) as f32);
            }
            posterize(p, n("levels"));
        }
        "dry_brush" => {
            kuwahara(p, (1.0 + n("brushSize")).round().max(1.0), 8.0);
            posterize(p, 4.0 + n("brushDetail") * 2.0);
            if n("texture") > 1.0 {
                darken(p, &grain_map(p.w, p.h, n("texture") * 1.5, fx), (n("texture") as f32 - 1.0) * 0.12);
            }
        }
        "film_grain" => {
            let (amt, hi, k) = (n("grain") as f32 / 20.0 * 0.35, n("highlightArea") as f32 / 20.0, n("intensity") as f32 / 10.0);
            let s = (11.0 - n("grain") / 2.0).round().max(1.0) as i32;
            for (i, c) in p.data.chunks_exact_mut(4).enumerate() {
                let (x, y) = (fx.ox + (i % p.w) as i32, fx.oy + (i / p.w) as i32);
                let g = hash(fx.seed, x.div_euclid(s), y.div_euclid(s), 17) - 0.5;
                for v in &mut c[..3] {
                    let fade = 1.0 - hi * clamp01((*v - (1.0 - hi)) / hi.max(0.01));
                    *v = clamp01(*v * (1.0 - hi * 0.3) + hi * 0.3 + g * amt * k * fade);
                }
            }
        }
        "fresco" => {
            kuwahara(p, (1.0 + n("brushSize") * 0.8).round().max(1.0), 6.0);
            let e = 1.1 + n("brushDetail") as f32 / 10.0;
            colors(p, |v| clamp01(v.max(0.0).powf(e) * 1.05));
            darken(p, &grain_map(p.w, p.h, n("texture") * 2.0, fx), 0.18 * n("texture") as f32);
        }
        "neon_glow" => {
            let l = luma(p);
            let b = blurred(&l, n("glowSize").abs().max(1.0) as f32);
            let (k, inv) = (n("glowBrightness") as f32 / 50.0, n("glowSize") < 0.0);
            let col = match f.text("glowColor") {
                "magenta" => [1.0, 0.267, 0.533],
                "green" => [0.267, 1.0, 0.533],
                "amber" => [1.0, 0.8, 0.267],
                _ => [0.267, 0.533, 1.0],
            };
            for (i, c) in p.data.chunks_exact_mut(4).enumerate() {
                let a = clamp01((l.v[i] - b.v[i]).abs() * 6.0);
                let base = if inv { 1.0 - l.v[i] } else { l.v[i] };
                (0..3).for_each(|j| c[j] = clamp01(base * 0.25 + a * k * col[j] * 3.0));
            }
        }
        "paint_daubs" => {
            let size = n("brushSize");
            let kind = f.text("brushType");
            let dirs = orientation(&luma(p), (size / 4.0).max(1.0) as f32);
            streak(p, &dirs, (size / if kind.starts_with("wide") { 3.0 } else { 6.0 }).max(1.0));
            if kind == "wideBlurry" {
                blur(p, 2.0);
            }
            if n("sharpness") > 0.0 {
                sharpen(p, n("sharpness") as f32 / 20.0);
            }
            match kind {
                "lightRough" => saturate(p, 1.2),
                "darkRough" => saturate(p, 0.8),
                "sparkle" => {
                    let l = luma(p);
                    screen(p, &l, 0.25);
                }
                _ => {}
            }
        }
        "palette_knife" => {
            kuwahara(p, (n("strokeSize") / 5.0).round().max(2.0), 4.0 + n("strokeDetail") * 2.0);
            if n("softness") > 0.0 {
                blur(p, n("softness") as f32 / 2.0);
            }
        }
        "plastic_wrap" => {
            let r = relief(&soft_luma(p, n("smoothness") as f32 / 2.0), 135.0, n("detail") as f32 * 3.0);
            let k = n("highlightStrength") as f32 / 20.0;
            let m = Map { w: p.w, h: p.h, v: r.v.iter().map(|v| clamp01(*v) * k).collect() };
            screen(p, &m, 1.0);
        }
        "poster_edges" => {
            posterize(p, 2.0 + n("posterization") * 2.0);
            if n("edgeIntensity") > 0.0 {
                let t = n("edgeThickness") as f32;
                let e = edges(p, (t - 1.0).max(0.0));
                let k = n("edgeIntensity") as f32 / 10.0;
                each(p, &e, |c, v| c * (1.0 - clamp01(v * (1.0 + t)) * k));
            }
        }
        "rough_pastels" => {
            let dirs = orientation(&luma(p), 3.0);
            streak(p, &dirs, (n("strokeLength") / 4.0).max(1.0));
            posterize(p, 4.0 + n("strokeDetail"));
            textured(p, f, 1.0, fx);
        }
        "smudge_stick" => {
            let dirs = orientation(&luma(p), 2.0);
            streak(p, &dirs, (n("strokeLength") * 2.0).max(1.0));
            let (hi, e) = (n("highlightArea") as f32 / 20.0, 1.0 + n("intensity") as f32 / 20.0);
            colors(p, |v| clamp01(v.max(0.0).powf(e) * (1.0 - hi) + v * hi * 1.35));
        }
        "sponge" => {
            let c = cells(p, (3.0 + n("brushSize") * 2.0).max(2.0), fx.seed, 1.0);
            let mut avg = p.clone();
            cell_mean(&mut avg, &c);
            let d = n("definition") as f32 / 25.0;
            for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
                let (cx, cy) = c.keys[c.owner[i]];
                let t = hash(fx.seed, cx, cy, 23);
                let k = clamp01(0.35 + d * (t - 0.35) * 2.0);
                (0..3).for_each(|j| px[j] += (avg.data[i * 4 + j] * (0.7 + t * 0.5) - px[j]) * k);
            }
            if n("smoothness") > 1.0 {
                blur(p, n("smoothness") as f32 / 6.0);
            }
        }
        "underpainting" => {
            kuwahara(p, (1.0 + n("brushSize") / 5.0).round().max(1.0), 6.0);
            blur(p, 1.0 + n("brushSize") as f32 / 12.0);
            textured(p, f, 0.4 + n("textureCoverage") / 40.0, fx);
        }
        "watercolor" => {
            simplify(p, ((16.0 - n("brushDetail")).round() / 2.0).max(1.0));
            saturate(p, 1.25);
            let e = edges(p, 1.0);
            let k = n("shadowIntensity") as f32 / 10.0;
            each(p, &e, |c, v| c * (1.0 - clamp01(v * 3.0) * k * 0.6));
            if n("texture") > 1.0 {
                darken(p, &grain_map(p.w, p.h, n("texture") * 2.0, fx), (n("texture") as f32 - 1.0) * 0.1);
            }
        }
        // Brush Strokes
        "accented_edges" => {
            let mut e = edges(p, n("smoothness") as f32 / 3.0);
            let w = n("edgeWidth").clamp(1.0, 14.0) as f32;
            e.v.iter_mut().for_each(|v| *v = clamp01(*v * w * 0.5));
            let b = (n("edgeBrightness") as f32 - 25.0) / 25.0;
            if b >= 0.0 {
                screen(p, &e, b);
            } else {
                e.v.iter_mut().for_each(|v| *v = 1.0 - *v);
                darken(p, &e, -b);
            }
        }
        "angled_strokes" => {
            let l = luma(p);
            let len = (n("strokeLength") / 3.0).max(1.0);
            let (mut a, mut b) = (p.clone(), p.clone());
            streak(&mut a, &along(p, 45.0), len);
            streak(&mut b, &along(p, 135.0), len);
            let bal = n("directionBalance") as f32 / 100.0;
            for (i, c) in p.data.chunks_exact_mut(4).enumerate() {
                let s = if l.v[i] >= bal { &a } else { &b };
                c[..3].copy_from_slice(&s.data[i * 4..i * 4 + 3]);
            }
            if n("sharpness") > 0.0 {
                sharpen(p, n("sharpness") as f32 / 5.0);
            }
        }
        "crosshatch" => {
            let l = luma(p);
            let t = n("strength").round().max(1.0) as usize;
            let mut m = Map { w: p.w, h: p.h, v: vec![1.0; p.w * p.h] };
            for i in 0..t * 2 {
                let s = strokes(p.w, p.h, 45.0 + i as f64 * 45.0, n("strokeLength"), (10.0 - n("sharpness") / 3.0).max(2.0), fx.seed.wrapping_add(i as u32 * 313), fx);
                let e = (i + 1) as f32 / (t * 2 + 1) as f32;
                for (j, v) in m.v.iter_mut().enumerate() {
                    if l.v[j] < 1.0 - e && s.v[j] > 0.55 {
                        *v *= 0.7;
                    }
                }
            }
            darken(p, &m, 1.0);
        }
        "dark_strokes" => {
            let l = luma(p);
            streak(p, &orientation(&l, 3.0), 4.0);
            let (bal, black, white) = (n("balance") as f32 / 10.0, n("blackIntensity") as f32 / 10.0, n("whiteIntensity") as f32 / 10.0);
            each(p, &l, |c, g| clamp01(if g < bal { c * (1.0 - black) } else { c + (1.0 - c) * white * ((g - bal) / (1.0 - bal).max(0.01)) }));
        }
        "ink_outlines" => {
            let l = luma(p);
            let hp = high_pass(&l, 0.0, (n("strokeLength") / 4.0).max(1.0) as f32);
            let ink = Map { w: p.w, h: p.h, v: hp.v.iter().map(|v| clamp01(-v * 10.0)).collect() };
            let ink = streak_map(&ink, &orientation(&l, 2.0), (n("strokeLength") / 6.0).max(1.0));
            let (dark, light) = (n("darkIntensity") as f32 / 50.0, n("lightIntensity") as f32 / 50.0);
            each(p, &ink, |c, h| clamp01((c + (1.0 - c) * light) * (1.0 - clamp01(h) * dark * 2.0)));
        }
        "spatter" => {
            let (r, s) = (n("sprayRadius") / 2.0, (n("smoothness") / 2.0).round().max(1.0) as i32);
            let (ox, oy, seed) = (fx.ox, fx.oy, fx.seed);
            displace(p, |x, y| {
                let (bx, by) = ((ox + x as i32).div_euclid(s), (oy + y as i32).div_euclid(s));
                (x + (f64::from(hash(seed, bx, by, 81)) - 0.5) * r * 2.0, y + (f64::from(hash(seed, bx, by, 82)) - 0.5) * r * 2.0)
            });
        }
        "sprayed_strokes" => {
            let deg = stroke_angle(f.text("strokeDirection"));
            let (s, c) = deg.to_radians().sin_cos();
            let (o, ox, oy, seed) = (n("sprayRadius") / 2.0, fx.ox, fx.oy, fx.seed);
            displace(p, |x, y| {
                let (dx, dy) = (ox + x as i32, oy + y as i32);
                let a = (f64::from(hash(seed, dx, dy, 91)) - 0.5) * o * 3.0;
                let b = (f64::from(hash(seed, dx, dy, 92)) - 0.5) * o * 0.6;
                (x + c * a - s * b, y + s * a + c * b)
            });
            if n("strokeLength") > 0.0 {
                streak(p, &along(p, deg), (n("strokeLength") / 3.0).max(1.0));
            }
        }
        "sumi_e" => {
            let dirs = orientation(&luma(p), (n("stroke") / 3.0).max(1.0) as f32);
            streak(p, &dirs, (n("stroke") / 2.0).max(1.0));
            let (k, pr) = (1.0 + n("contrast") as f32 / 10.0, n("strokePressure") as f32 / 15.0);
            colors(p, |v| clamp01(clamp01((v - 0.5) * k + 0.5) * (1.0 - pr * 0.5)));
        }
        // Distort
        "diffuse_glow" => {
            let b = blurred(&luma(p), 4.0);
            let (glow, clear, gr) = (n("glowAmount") as f32 / 20.0, n("clearAmount") as f32 / 20.0 * 0.75, n("graininess") as f32 / 10.0);
            for (i, c) in p.data.chunks_exact_mut(4).enumerate() {
                let g = hash(fx.seed, fx.ox + (i % p.w) as i32, fx.oy + (i / p.w) as i32, 101) - 0.5;
                let w = clamp01((b.v[i] - clear) / (1.0 - clear).max(0.01));
                let k = clamp01(w * glow * 2.0 + g * gr * w);
                (0..3).for_each(|j| c[j] += (fx.bg[j] - c[j]) * k);
            }
        }
        "glass" => {
            let mut t = texture(f.text("texture"), p.w, p.h, n("scaling"), fx);
            if f.flag("invertTexture") {
                t.v.iter_mut().for_each(|v| *v = 1.0 - *v);
            }
            bump(p, &blurred(&t, n("smoothness") as f32 / 2.0), n("distortion") * 4.0);
        }
        "ocean_ripple" => {
            let k = 1.0 / (n("rippleSize") * 1.5).max(1.0);
            let s = fx.seed;
            let m = from_fn(p.w, p.h, |x, y| {
                let (u, v) = ((f64::from(fx.ox) + x as f64) * k, (f64::from(fx.oy) + y as f64) * k);
                noise(s, u, v) * 0.65 + noise(s.wrapping_add(401), u * 2.7, v * 2.7) * 0.35
            });
            bump(p, &m, n("rippleMagnitude") * 6.0);
        }
        // Sketch
        "bas_relief" => {
            let r = relief(&soft_luma(p, n("smoothness") as f32 / 2.0), light_angle(f.text("lightDirection")), n("detail") as f32 * 2.0);
            duotone(p, &Map { w: p.w, h: p.h, v: r.v.iter().map(|v| clamp01(0.5 + v)).collect() }, fx);
        }
        "chalk_and_charcoal" => {
            let l = luma(p);
            let a = strokes(p.w, p.h, 45.0, 12.0, 4.0, fx.seed, fx);
            let b = strokes(p.w, p.h, 135.0, 12.0, 4.0, fx.seed.wrapping_add(17), fx);
            let (dark, light, pr) = (0.25 + n("charcoalArea") as f32 / 20.0 * 0.5, 0.25 + n("chalkArea") as f32 / 20.0 * 0.5, 0.5 + n("strokePressure") as f32 / 5.0);
            let m = from_fn(p.w, p.h, |x, y| {
                let (i, s) = (y * p.w + x, l.v[y * p.w + x]);
                let c = clamp01((dark - s) / dark.max(0.01)).sqrt() * pr * (0.35 + a.v[i] * 1.3);
                let k = clamp01((s - (1.0 - light)) / light.max(0.01)).sqrt() * pr * (0.35 + b.v[i] * 1.3);
                clamp01(0.5 - c * 0.5 + k * 0.5)
            });
            duotone(p, &m, fx);
        }
        "charcoal" => {
            let l = luma(p);
            let mut g = gradient(&l);
            if n("charcoalThickness") > 1.0 {
                g = blurred(&g, n("charcoalThickness") as f32);
            }
            let (bal, d) = (n("lightDark") as f32 / 100.0, 1.0 + n("detail") as f32);
            let m = Map { w: p.w, h: p.h, v: g.v.iter().zip(&l.v).map(|(e, s)| clamp01(1.0 - clamp01(e * d * 3.0) - (1.0 - s) * bal * 0.6)).collect() };
            duotone(p, &m, fx);
        }
        "chrome" => {
            let g = soft_luma(p, n("smoothness") as f32);
            let r = relief(&g, 120.0, 6.0 + n("detail") as f32 * 4.0);
            let k = std::f32::consts::PI * (1.0 + n("detail") as f32 / 4.0);
            let m = Map { w: p.w, h: p.h, v: g.v.iter().zip(&r.v).map(|(a, b)| clamp01(((a + b * 2.0) * k).sin().abs() * 0.75 + 0.15)).collect() };
            gray(p, &blurred(&m, n("smoothness") as f32 / 4.0));
        }
        "conte_crayon" => {
            let (fg, bg) = (n("foregroundLevel") as f32 / 8.0, n("backgroundLevel") as f32 / 8.0);
            let l = luma(p);
            duotone(p, &Map { w: p.w, h: p.h, v: l.v.iter().map(|&b| clamp01(if b < 0.5 { (b * 2.0).powf(fg) * 0.5 } else { 1.0 - ((1.0 - b) * 2.0).powf(bg) * 0.5 })).collect() }, fx);
            textured(p, f, 1.0, fx);
        }
        "graphic_pen" => {
            let l = luma(p);
            let len = n("strokeLength");
            let s = strokes(p.w, p.h, stroke_angle(f.text("strokeDirection")), len * 2.0, (16.0 - len).max(2.0), fx.seed, fx);
            let bal = n("lightDarkBalance") as f32 / 100.0;
            duotone(p, &Map { w: p.w, h: p.h, v: l.v.iter().zip(&s.v).map(|(v, t)| f32::from(u8::from(*v > bal * (0.4 + t * 1.2)))).collect() }, fx);
        }
        "halftone_pattern" => {
            let k = 1.0 + n("contrast") as f32 / 12.0;
            let l = luma(p);
            let t = (n("size") * 3.0).max(2.0);
            let kind = f.text("patternType");
            let (cx, cy) = (p.w as f64 / 2.0, p.h as f64 / 2.0);
            let m = from_fn(p.w, p.h, |x, y| {
                let tone = clamp01((l.v[y * p.w + x] - 0.5) * k + 0.5);
                let (dx, dy) = (f64::from(fx.ox) + x as f64, f64::from(fx.oy) + y as f64);
                let saw = |d: f64| (d.rem_euclid(t) / t - 0.5).abs() * 2.0;
                let a = match kind {
                    "line" => saw(dy),
                    "dot" => ((dx.rem_euclid(t) - t / 2.0).hypot(dy.rem_euclid(t) - t / 2.0) / (t / 2.0)).clamp(0.0, 1.0),
                    _ => saw((x as f64 - cx).hypot(y as f64 - cy)),
                };
                f32::from(u8::from(f64::from(tone) > a))
            });
            duotone(p, &m, fx);
        }
        "note_paper" => {
            let l = luma(p);
            let bal = n("imageBalance") as f32 / 50.0;
            let q = blurred(&Map { w: p.w, h: p.h, v: l.v.iter().map(|v| f32::from(u8::from(*v > bal))).collect() }, 1.5);
            let r = relief(&q, 135.0, n("relief") as f32);
            let g = grain_map(p.w, p.h, 2.0, fx);
            let k = n("graininess") as f32 / 20.0;
            duotone(p, &Map { w: p.w, h: p.h, v: (0..q.v.len()).map(|i| clamp01(q.v[i] + r.v[i] - (1.0 - g.v[i]) * k * 0.5)).collect() }, fx);
        }
        "photocopy" => {
            let l = luma(p);
            let b = blurred(&l, n("detail").max(1.0) as f32);
            let k = n("darkness") as f32 / 10.0;
            duotone(p, &Map { w: p.w, h: p.h, v: b.v.iter().zip(&l.v).map(|(b, l)| clamp01(1.0 - (b - l) * k * 4.0)).collect() }, fx);
        }
        "plaster" => {
            let g = soft_luma(p, n("smoothness") as f32 / 2.0);
            let bal = n("imageBalance") as f32 / 50.0;
            let q = blurred(&Map { w: p.w, h: p.h, v: g.v.iter().map(|v| smoothstep(bal - 0.08, bal + 0.08, *v)).collect() }, n("smoothness").max(1.0) as f32);
            let r = relief(&q, light_angle(f.text("lightPosition")), 40.0);
            duotone(p, &Map { w: p.w, h: p.h, v: r.v.iter().map(|v| clamp01(0.55 + v)).collect() }, fx);
        }
        "reticulation" => {
            let l = luma(p);
            let t = 40.0 / (26.0 - n("density") / 2.0).max(1.0);
            let (fl, bl) = (n("foregroundLevel") as f32 / 50.0, n("backgroundLevel") as f32 / 50.0);
            let s = fx.seed;
            let m = from_fn(p.w, p.h, |x, y| {
                let (dx, dy) = (fx.ox + x as i32, fx.oy + y as i32);
                let (u, v) = (f64::from(dx) * t, f64::from(dy) * t);
                let th = noise(s, u, v) * 0.6 + noise(s.wrapping_add(77), u * 2.3, v * 2.3) * 0.25 + hash(s, dx, dy, 111) * 0.15;
                f32::from(u8::from(clamp01(l.v[y * p.w + x] * (1.0 + bl) - fl * 0.5) > th))
            });
            duotone(p, &m, fx);
        }
        "stamp" => {
            let g = soft_luma(p, n("smoothness") as f32 / 2.0);
            let bal = n("lightDarkBalance") as f32 / 50.0;
            duotone(p, &Map { w: p.w, h: p.h, v: g.v.iter().map(|v| f32::from(u8::from(*v > bal))).collect() }, fx);
        }
        "torn_edges" => {
            let g = soft_luma(p, n("smoothness") as f32 / 3.0);
            let (bal, k) = (n("imageBalance") as f32 / 50.0, 1.0 / n("contrast").max(1.0) as f32);
            let m = from_fn(p.w, p.h, |x, y| {
                let e = (noise(fx.seed, (f64::from(fx.ox) + x as f64) * 0.6, (f64::from(fx.oy) + y as f64) * 0.6) - 0.5) * k * 2.0;
                f32::from(u8::from(g.v[y * p.w + x] + e > bal))
            });
            duotone(p, &m, fx);
        }
        "water_paper" => {
            let len = n("fiberLength");
            p.data = median(p, (len / 12.0).round().max(1.0) as usize);
            let q = 1.0 / len.max(1.0);
            let fib = from_fn(p.w, p.h, |x, y| noise(fx.seed, (f64::from(fx.ox) + x as f64) * 0.9, (f64::from(fx.oy) + y as f64) * q));
            let (br, ct) = ((n("brightness") as f32 - 50.0) / 50.0, 1.0 + (n("contrast") as f32 - 50.0) / 50.0);
            each(p, &fib, |c, t| clamp01((c + (t - 0.5) * 0.25 - 0.5) * ct + 0.5 + br * 0.25));
        }
        // Stylize
        "glowing_edges" => {
            let (w, h) = (p.w as isize, p.h as isize);
            let src = p.data.clone();
            let k = 1.0 + n("edgeBrightness") as f32;
            let v = |x: isize, y: isize, c: usize| src[((y.clamp(0, h - 1) * w + x.clamp(0, w - 1)) * 4) as usize + c];
            for y in 0..h {
                for x in 0..w {
                    for c in 0..3 {
                        let gx = v(x + 1, y - 1, c) + 2.0 * v(x + 1, y, c) + v(x + 1, y + 1, c) - (v(x - 1, y - 1, c) + 2.0 * v(x - 1, y, c) + v(x - 1, y + 1, c));
                        let gy = v(x - 1, y + 1, c) + 2.0 * v(x, y + 1, c) + v(x + 1, y + 1, c) - (v(x - 1, y - 1, c) + 2.0 * v(x, y - 1, c) + v(x + 1, y - 1, c));
                        p.data[((y * w + x) * 4) as usize + c] = clamp01(gx.hypot(gy) * k * 0.25);
                    }
                }
            }
            let ew = n("edgeWidth").clamp(1.0, 14.0) as f32;
            if ew > 1.0 {
                let mut g = p.clone();
                blur(&mut g, ew);
                for (c, b) in p.data.chunks_exact_mut(4).zip(g.data.chunks_exact(4)) {
                    (0..3).for_each(|j| c[j] = 1.0 - (1.0 - c[j]) * (1.0 - clamp01(b[j])));
                }
            }
            if n("smoothness") > 1.0 {
                blur(p, n("smoothness") as f32 / 6.0);
            }
        }
        // Texture
        "craquelure" => {
            let c = cells(p, n("crackSpacing"), fx.seed, 1.0);
            let cr = normalized(blurred(&borders(&c, p.w, p.h), 1.4));
            let r = relief(&Map { w: p.w, h: p.h, v: cr.v.iter().map(|v| 1.0 - v).collect() }, 135.0, n("crackDepth") as f32 * 8.0);
            let b = n("crackBrightness") as f32 / 10.0;
            for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
                let a = cr.v[i];
                px[..3].iter_mut().for_each(|v| *v = clamp01(*v * (1.0 - a * (1.0 - b)) + r.v[i] + a * b * 0.4));
            }
        }
        "grain" => {
            let (k, ct) = (n("intensity") as f32 / 100.0, 1.0 + (n("contrast") as f32 - 50.0) / 50.0);
            let kind = f.text("grainType");
            let s = fx.seed;
            for (i, c) in p.data.chunks_exact_mut(4).enumerate() {
                let (x, y) = (fx.ox + (i % p.w) as i32, fx.oy + (i / p.w) as i32);
                let a = grain_value(kind, x, y, s);
                c[..3].iter_mut().for_each(|v| *v = clamp01((*v - 0.5) * ct + 0.5 + a * k));
            }
        }
        "mosaic_tiles" => {
            let c = cells(p, n("tileSize"), fx.seed, 0.9);
            let g = normalized(blurred(&borders(&c, p.w, p.h), (n("groutWidth") / 2.0).max(1.0) as f32));
            let light = n("lightenGrout") as f32 / 10.0;
            each(p, &g, |c, v| c + (light - c) * clamp01(v * 1.6));
        }
        "patchwork" => {
            let g = (2.0 + n("squareSize") * 2.0).round().max(2.0) as usize;
            let l = luma(p);
            let mut height = Map { w: p.w, h: p.h, v: vec![0.0; p.w * p.h] };
            for by in (0..p.h).step_by(g) {
                for bx in (0..p.w).step_by(g) {
                    let (ys, xs) = (by..(by + g).min(p.h), bx..(bx + g).min(p.w));
                    let (mut sum, mut tone, mut cnt) = ([0f64; 3], 0f64, 0f64);
                    for y in ys.clone() {
                        for x in xs.clone() {
                            (0..3).for_each(|c| sum[c] += f64::from(p.data[(y * p.w + x) * 4 + c]));
                            tone += f64::from(l.v[y * p.w + x]);
                            cnt += 1.0;
                        }
                    }
                    for y in ys.clone() {
                        for x in xs.clone() {
                            (0..3).for_each(|c| p.data[(y * p.w + x) * 4 + c] = (sum[c] / cnt) as f32);
                            let (u, v) = ((x - bx) as f64 / g as f64 - 0.5, (y - by) as f64 / g as f64 - 0.5);
                            height.v[y * p.w + x] = ((1.0 - u.hypot(v) * 2.0).max(0.0) * tone / cnt) as f32;
                        }
                    }
                }
            }
            if n("relief") > 0.0 {
                let r = relief(&height, 135.0, n("relief") as f32 * 4.0);
                each(p, &r, |c, v| clamp01(c + v));
            }
        }
        "stained_glass" => {
            let c = cells(p, n("cellSize"), fx.seed, 1.0);
            cell_mean(p, &c);
            let b = normalized(blurred(&borders(&c, p.w, p.h), (n("borderThickness") / 2.0).max(1.0) as f32));
            let (cx, cy) = (p.w as f32 / 2.0, p.h as f32 / 2.0);
            let (far, k) = (cx.hypot(cy), n("lightIntensity") as f32 / 10.0);
            for (i, px) in p.data.chunks_exact_mut(4).enumerate() {
                let lead = clamp01(b.v[i] * 2.0);
                let glow = k * (1.0 - smoothstep(0.0, far, ((i % p.w) as f32 - cx).hypot((i / p.w) as f32 - cy)));
                px[..3].iter_mut().for_each(|v| *v = (1.0 - (1.0 - *v) * (1.0 - glow)) * (1.0 - lead));
            }
        }
        "texturizer" => texturize(p, f.text("texture"), n("scaling"), n("relief"), f.text("lightDirection"), f.flag("invertTexture"), fx),
        _ => return Err(format!("unknown Filter Gallery effect \"{}\"", f.kind)),
    }
    Ok(())
}

// The shared texture params (Rough Pastels, Underpainting, Conté Crayon), relief times `k`.
fn textured(p: &mut Plane, f: &Filter, k: f64, fx: &Fx) {
    texturize(p, f.text("texture"), f.num("scaling"), f.num("relief") * k, f.text("lightDirection"), f.num("invertTexture") >= 0.5, fx);
}

// A median (small layers) or a surface blur (large ones) of `r` px.
fn simplify(p: &mut Plane, r: f64) {
    if p.w * p.h >= 262_144 {
        surface(p, r, 0.2, (p.w * p.h) as f64);
    } else {
        p.data = median(p, r.round().max(1.0) as usize);
    }
}

// Unsharp mask against a 2 px blur at strength `k`.
fn sharpen(p: &mut Plane, k: f32) {
    let mut b = p.clone();
    blur(&mut b, 2.0);
    for (c, s) in p.data.chunks_exact_mut(4).zip(b.data.chunks_exact(4)) {
        (0..3).for_each(|j| c[j] += (c[j] - s[j]) * k);
    }
}

fn stroke_angle(dir: &str) -> f64 {
    match dir {
        "horizontal" => 0.0,
        "vertical" => 90.0,
        "leftDiagonal" => 135.0,
        _ => 45.0,
    }
}

// The Grain filter's per-type offset (-0.5..0.5) at a document position.
fn grain_value(kind: &str, x: i32, y: i32, s: u32) -> f32 {
    let n = |kx: f64, ky: f64| noise(s, f64::from(x) * kx, f64::from(y) * ky) - 0.5;
    let h = |c| hash(s, x, y, c);
    match kind {
        "soft" => n(0.5, 0.5),
        "sprinkles" => {
            let t = h(5);
            if t > 0.94 { 0.5 } else if t < 0.06 { -0.5 } else { 0.0 }
        }
        "clumped" => n(0.18, 0.18),
        "contrasty" => if h(7) > 0.5 { 0.5 } else { -0.5 },
        "enlarged" => n(0.28, 0.28),
        "stippled" => if h(9) > 0.82 { 0.5 } else { 0.0 },
        "horizontal" => n(0.12, 1.6),
        "vertical" => n(1.6, 0.12),
        "speckle" => if h(11) > 0.9 { -0.5 } else { 0.0 },
        _ => super::super::gauss(s, x, y, 3) * 0.3,
    }
}
