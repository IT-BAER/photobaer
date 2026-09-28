use super::*;
use crate::font::Registry;

fn bundled() -> Registry {
    let mut r = Registry::default();
    let path = format!("{}/../app/public/fonts/NotoSans-Regular.ttf", env!("CARGO_MANIFEST_DIR"));
    r.add(std::fs::read(path).unwrap(), "bundled").unwrap();
    r
}

fn gid_of(r: &Registry, ch: char) -> u16 {
    let id = r.resolve("Noto Sans", "Regular").unwrap();
    let (bytes, index) = r.data(id).unwrap();
    ttf_parser::Face::parse(bytes, index).unwrap().glyph_index(ch).unwrap().0
}

#[test]
fn range_selection_yields_named_ascii_cells_with_matching_coverage() {
    let r = bundled();
    let c = glyph_cells(&r, "Noto Sans", "Regular", Selection::Range { from: 32, to: 126 });
    assert!(!c.missing);
    assert_eq!(c.alpha.len(), c.cells.len() * CELL * CELL);
    let ai = c.cells.iter().position(|c| c.cp == Some(65)).expect("A is mapped");
    assert_eq!(c.cells[ai].name, "A");
    assert!(c.alpha[ai * CELL * CELL..(ai + 1) * CELL * CELL].iter().any(|&v| v != 0));
    if let Some(si) = c.cells.iter().position(|c| c.cp == Some(32)) {
        assert!(c.alpha[si * CELL * CELL..(si + 1) * CELL * CELL].iter().all(|&v| v == 0));
    }
}

#[test]
fn gids_selection_reports_the_codepoint_via_cmap() {
    let r = bundled();
    let gid = gid_of(&r, 'A');
    let c = glyph_cells(&r, "Noto Sans", "Regular", Selection::Gids { gids: vec![gid] });
    assert_eq!((c.cells[0].cp, c.cells[0].name.as_str()), (Some(65), "A"));
}

#[test]
fn an_unresolved_family_falls_back_to_the_first_bundled_face() {
    let r = bundled();
    let c = glyph_cells(&r, "Helvetica", "Regular", Selection::Range { from: 65, to: 65 });
    assert!(c.missing);
    assert_eq!(c.cells.len(), 1);
}

// Checked with fontTools: none of the 4 bundled fonts (Noto Sans, Noto Sans Bold, Noto Sans Mono,
// Noto Serif) carry a salt, swsh, titl or ornm GSUB feature, so this only exercises the empty path.
#[test]
fn alternates_are_empty_when_no_bundled_font_has_the_features() {
    let r = bundled();
    assert_eq!(glyph_alternates(&r, "Noto Sans", "Regular", gid_of(&r, 'A')), Vec::<u16>::new());
}
