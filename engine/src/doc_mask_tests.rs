//! Layer > Layer Mask: from selection, from transparency, apply.

use super::*;

// Layer 1 of a 20x10 doc at `depth`: x < 10 opaque red, x >= 10 red at half alpha (128/255).
fn doc(depth: u8) -> Document {
    let mut d = Document::new(20, 10, depth).unwrap();
    let mut buf = vec![0u8; TILE_BYTES_U8];
    for p in 0..TILE_PIXELS {
        let (x, y) = (p % TILE, p / TILE);
        if y < 10 && x < 20 {
            buf[p * 4..p * 4 + 4].copy_from_slice(&[255, 0, 0, if x < 10 { 255 } else { 128 }]);
        }
    }
    d.set_tile_rgba8(1, 0, 0, &buf).unwrap();
    d
}

fn idx(x: i32, y: i32) -> usize {
    (y * TILE as i32 + x) as usize
}

fn mask_at(d: &Document, id: u32, x: i32, y: i32) -> f32 {
    let m = d.node(id).unwrap().mask.as_ref().expect("a mask");
    m.tiles.get(0, 0).map_or(m.default as f32 / max_value(d.depth) as f32, |t| t.px.mask_f32(idx(x, y)))
}

fn px_at(d: &Document, id: u32, x: i32, y: i32) -> [f32; 4] {
    d.node(id).unwrap().pixel_tiles().unwrap().get(0, 0).map_or([0.0; 4], |t| t.px.rgba_f32(idx(x, y)))
}

fn close(a: f32, b: f32) -> bool {
    (a - b).abs() < 1.0 / 250.0
}

#[test]
fn mask_from_selection_reveals_or_hides_it_and_deselects() {
    for depth in [8, 16] {
        for hide in [false, true] {
            let mut d = doc(depth);
            d.select_rect(0.0, 0.0, 5.0, 10.0, Mode::New).unwrap();
            d.add_mask_from_selection(1, hide).unwrap();
            let (inside, outside) = if hide { (0.0, 1.0) } else { (1.0, 0.0) };
            assert_eq!((mask_at(&d, 1, 2, 2), mask_at(&d, 1, 7, 2)), (inside, outside), "depth {depth} hide {hide}");
            let m = d.node(1).unwrap().mask.as_ref().unwrap();
            assert_eq!(m.default, if hide { max_value(depth) } else { 0 });
            assert!(m.enabled);
            assert!(!d.has_selection(), "the selection is dropped");
            d.reselect().unwrap();
            assert!(d.has_selection(), "and kept for Reselect");
        }
    }
}

#[test]
fn mask_from_selection_refuses_no_selection_an_existing_mask_and_loading() {
    let mut d = doc(8);
    assert!(d.add_mask_from_selection(1, false).unwrap_err().contains("selection"));
    d.select_rect(0.0, 0.0, 5.0, 10.0, Mode::New).unwrap();
    d.add_mask(1, true).unwrap();
    assert!(d.add_mask_from_selection(1, false).unwrap_err().contains("already has a mask"));
    assert!(d.has_selection(), "a refused command keeps the selection");
    assert!(d.add_mask_from_selection(99, false).is_err());
    d.loading = Some(Loading { slots: HashMap::new(), blobs: HashSet::new(), pending_ids: HashSet::new(), max_referenced_id: 0 });
    assert!(d.add_mask_from_selection(1, false).unwrap_err().contains("loading"));
}

#[test]
fn mask_from_transparency_moves_alpha_into_the_mask() {
    for depth in [8, 16, 32] {
        let mut d = doc(depth);
        d.mask_from_transparency(1).unwrap();
        let m = d.node(1).unwrap().mask.as_ref().unwrap();
        assert_eq!(m.default, 0, "hidden outside the alpha");
        assert_eq!(mask_at(&d, 1, 2, 2), 1.0, "depth {depth}");
        assert!(close(mask_at(&d, 1, 15, 2), 128.0 / 255.0), "depth {depth}: {}", mask_at(&d, 1, 15, 2));
        assert_eq!(mask_at(&d, 1, 2, 12), 0.0, "transparent pixels: mask 0");
        assert_eq!(px_at(&d, 1, 15, 2), [1.0, 0.0, 0.0, 1.0], "depth {depth}: opaque, color kept");
        assert_eq!(px_at(&d, 1, 2, 12)[3], 1.0, "a transparent pixel turns opaque");
    }
}

#[test]
fn mask_from_transparency_refuses_non_pixel_layers_masks_and_locks() {
    let mut d = doc(8);
    let g = d.add_group("G", 1).unwrap();
    assert!(d.mask_from_transparency(g).is_err());
    d.node_mut(1).unwrap().locks.transparency = true;
    assert!(d.mask_from_transparency(1).unwrap_err().contains("locked"));
    d.node_mut(1).unwrap().locks = Locks { pixels: true, ..Locks::default() };
    assert!(d.mask_from_transparency(1).unwrap_err().contains("locked"));
    d.node_mut(1).unwrap().locks = Locks::default();
    d.add_mask(1, true).unwrap();
    assert!(d.mask_from_transparency(1).unwrap_err().contains("already has a mask"));
}

#[test]
fn apply_mask_multiplies_alpha_and_drops_the_mask() {
    for depth in [8, 16, 32] {
        let mut d = doc(depth);
        d.select_rect(0.0, 0.0, 5.0, 10.0, Mode::New).unwrap();
        d.add_mask_from_selection(1, false).unwrap();
        d.node_mut(1).unwrap().mask.as_mut().unwrap().enabled = false;
        d.apply_mask(1).unwrap();
        assert!(d.node(1).unwrap().mask.is_none(), "depth {depth}");
        assert_eq!(px_at(&d, 1, 2, 2), [1.0, 0.0, 0.0, 1.0], "revealed: kept");
        assert_eq!(px_at(&d, 1, 7, 2)[3], 0.0, "hidden: transparent, even with the mask disabled");
    }
}

#[test]
fn apply_mask_scales_partial_alpha_and_uses_the_default_without_tiles() {
    for depth in [8, 16] {
        let mut d = doc(depth);
        d.mask_from_transparency(1).unwrap();
        d.apply_mask(1).unwrap();
        assert!(close(px_at(&d, 1, 15, 2)[3], 128.0 / 255.0), "depth {depth}: round trip");
        let mut d = doc(depth);
        d.add_mask(1, false).unwrap();
        d.apply_mask(1).unwrap();
        assert!(d.node(1).unwrap().pixel_tiles().unwrap().get(0, 0).is_none(), "hide all empties the layer");
    }
}

#[test]
fn apply_mask_refuses_no_mask_non_pixel_layers_and_a_pixel_lock() {
    let mut d = doc(8);
    assert!(d.apply_mask(1).unwrap_err().contains("no mask"));
    let g = d.add_group("G", 1).unwrap();
    d.add_mask(g, true).unwrap();
    assert!(d.apply_mask(g).is_err());
    d.add_mask(1, true).unwrap();
    d.node_mut(1).unwrap().locks.pixels = true;
    assert!(d.apply_mask(1).unwrap_err().contains("locked"));
    assert!(d.node(1).unwrap().mask.is_some());
}
