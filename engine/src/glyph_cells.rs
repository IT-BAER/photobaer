// Glyphs panel app-scope calls: rasterized glyph cells and GSUB alternates from the font registry.
// A sibling of `font` and `glyphs`, reusing their outline rasterizer instead of a second one.
use crate::font::Registry;
use crate::geom;
use crate::doc::glyphs::glyph_polys;
use crate::path::{FillRule, PathOp, Subpath, VectorPath};
use ttf_parser::{Face, GlyphId, Tag};

/// Cell side in px.
pub const CELL: usize = 30;
/// Cell glyph height as a fraction of the cell, and the baseline's fraction from the top.
const GLYPH_FRAC: f64 = 0.66;
const BASELINE_FRAC: f64 = 0.76;
const ALT_TAGS: [&[u8; 4]; 4] = [b"salt", b"swsh", b"titl", b"ornm"];

#[derive(serde::Deserialize)]
#[serde(untagged)]
pub enum Selection {
    Range { from: u32, to: u32 },
    Gids { gids: Vec<u16> },
}

#[derive(serde::Serialize)]
pub struct Cell {
    pub gid: u16,
    pub cp: Option<u32>,
    pub name: String,
}

pub struct Cells {
    pub missing: bool,
    pub cells: Vec<Cell>,
    pub alpha: Vec<u8>,
}

fn glyph_name(face: &Face, gid: GlyphId, cp: Option<u32>) -> String {
    face.glyph_name(gid).map(str::to_string).or_else(|| cp.map(|c| format!("uni{c:04X}"))).unwrap_or_else(|| format!("gid{}", gid.0))
}

/// The lowest code point a Unicode cmap subtable maps to `gid`, else None.
fn codepoint_of(face: &Face, gid: u16) -> Option<u32> {
    let cmap = face.tables().cmap?;
    let mut found: Option<u32> = None;
    for sub in cmap.subtables.into_iter().filter(ttf_parser::cmap::Subtable::is_unicode) {
        sub.codepoints(|cp| {
            if sub.glyph_index(cp) == Some(GlyphId(gid)) {
                found = Some(found.map_or(cp, |f| f.min(cp)));
            }
        });
    }
    found
}

/// A glyph's coverage in a `CELL x CELL` cell: centered advance width, baseline at BASELINE_FRAC.
fn rasterize(face: &Face, gid: u16) -> Vec<u8> {
    let upm = face.units_per_em() as f64;
    let scale = GLYPH_FRAC * CELL as f64 / upm;
    let advance = face.glyph_hor_advance(GlyphId(gid)).unwrap_or(0) as f64 * scale;
    let (ox, baseline) = ((CELL as f64 - advance) / 2.0, BASELINE_FRAC * CELL as f64);
    let polys = glyph_polys(face, GlyphId(gid), |p| [ox + p[0] * scale, baseline - p[1] * scale], 1.0);
    let subpaths =
        polys.into_iter().map(|p| Subpath { closed: true, op: PathOp::Combine, points: p.into_iter().map(|[x, y]| [x, y, x, y, x, y]).collect() }).collect();
    geom::fill_mask(&VectorPath { fill_rule: FillRule::Nonzero, subpaths }, 0, 0, CELL, CELL)
}

/// Glyph cells for a range of code points or a list of glyph ids; `missing` when `family` does not
/// resolve and a bundled fallback face is used instead.
pub fn glyph_cells(reg: &Registry, family: &str, style: &str, sel: Selection) -> Cells {
    let (id, missing) = match reg.resolve(family, style) {
        Some(id) => (id, false),
        None => match reg.fallback_face(style) {
            Some(id) => (id, true),
            None => return Cells { missing: true, cells: vec![], alpha: vec![] },
        },
    };
    let face = reg.data(id).and_then(|(d, i)| Face::parse(d, i).ok());
    let Some(face) = face else { return Cells { missing, cells: vec![], alpha: vec![] } };
    let pairs: Vec<(u16, Option<u32>)> = match sel {
        Selection::Range { from, to } => (from..=to)
            .filter_map(|cp| {
                let gid = face.glyph_index(char::from_u32(cp)?)?;
                (gid.0 != 0).then_some((gid.0, Some(cp)))
            })
            .collect(),
        Selection::Gids { gids } => gids.into_iter().map(|g| (g, codepoint_of(&face, g))).collect(),
    };
    let cells: Vec<Cell> = pairs.into_iter().map(|(gid, cp)| Cell { gid, cp, name: glyph_name(&face, GlyphId(gid), cp) }).collect();
    let alpha = cells.iter().flat_map(|c| rasterize(&face, c.gid)).collect();
    Cells { missing, cells, alpha }
}

/// Alternate glyph ids for `gid` from the salt, swsh, titl and ornm GSUB features, deduped and in
/// that feature order; [] when `family` does not resolve.
pub fn glyph_alternates(reg: &Registry, family: &str, style: &str, gid: u16) -> Vec<u16> {
    let Some(face) = reg.resolve(family, style).and_then(|id| reg.data(id)).and_then(|(d, i)| Face::parse(d, i).ok()) else { return vec![] };
    let Some(gsub) = face.tables().gsub else { return vec![] };
    let target = GlyphId(gid);
    let mut out = vec![];
    for tag in ALT_TAGS {
        let Some(feature) = gsub.features.find(Tag::from_bytes(tag)) else { continue };
        for li in feature.lookup_indices {
            let Some(lookup) = gsub.lookups.get(li) else { continue };
            for i in 0..lookup.subtables.len() {
                let Some(sub) = lookup.subtables.get::<ttf_parser::gsub::SubstitutionSubtable>(i) else { continue };
                let Some(idx) = sub.coverage().get(target) else { continue };
                let alts: Vec<u16> = match &sub {
                    ttf_parser::gsub::SubstitutionSubtable::Single(ttf_parser::gsub::SingleSubstitution::Format1 { delta, .. }) => {
                        vec![gid.wrapping_add(*delta as u16)]
                    }
                    ttf_parser::gsub::SubstitutionSubtable::Single(ttf_parser::gsub::SingleSubstitution::Format2 { substitutes, .. }) => {
                        substitutes.get(idx).map(|g| g.0).into_iter().collect()
                    }
                    ttf_parser::gsub::SubstitutionSubtable::Alternate(a) => {
                        a.alternate_sets.get(idx).map(|s| s.alternates.into_iter().map(|g| g.0).collect()).unwrap_or_default()
                    }
                    _ => vec![],
                };
                for a in alts {
                    if a != gid && !out.contains(&a) {
                        out.push(a);
                    }
                }
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "glyph_cells_tests.rs"]
mod tests;
