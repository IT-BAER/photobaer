//! Stylize group (docs/M5.md section 3).

use super::{Ctx, Filter, Plane};

/// `v < 0.5 ? 2v : 2(1 - v)` per color channel.
pub fn solarize(p: &mut Plane, _: &Filter, _: &Ctx) -> Result<(), String> {
    for px in p.data.chunks_exact_mut(4) {
        for v in &mut px[..3] {
            *v = if *v < 0.5 { 2.0 * *v } else { 2.0 * (1.0 - *v) };
        }
    }
    Ok(())
}
