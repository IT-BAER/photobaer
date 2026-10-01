use super::*;
use serde_json::Value;
use crate::blend::BLEND_NAMES;

fn rgba(r: u8, g: u8, b: u8, a: u8) -> Vec<u8> {
    let mut v = vec![0u8; TILE_BYTES_U8];
    for px in v.chunks_exact_mut(4) {
        px.copy_from_slice(&[r, g, b, a]);
    }
    v
}

fn opaque(r: u8, g: u8, b: u8) -> Vec<u8> {
    rgba(r, g, b, 255)
}

fn set(d: &mut Document, id: u32, json: &str) {
    d.set_props(id, json).unwrap();
}

// Straight (unpremultiplied) pixel from the composited tile (0, 0).
fn at(d: &Document, x: usize, y: usize) -> [u8; 4] {
    let f = d.flatten_tile_rgba8(0, 0).unwrap();
    let o = (y * TILE + x) * 4;
    [f[o], f[o + 1], f[o + 2], f[o + 3]]
}

fn near(got: [u8; 4], want: [u8; 4]) {
    for i in 0..4 {
        assert!(
            (got[i] as i32 - want[i] as i32).abs() <= 1,
            "channel {i}: got {got:?}, want {want:?}"
        );
    }
}

// 256x256 document with an opaque Background (id 1) of the given color.
fn doc_bg(r: u8, g: u8, b: u8) -> Document {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.fill(1, Target::Pixels, r, g, b, 255).unwrap();
    d
}

#[test]
fn fill_without_a_selection_covers_the_canvas_and_keeps_off_canvas_pixels() {
    let mut d = Document::new(200, 100, 8).unwrap();
    d.fill(1, Target::Pixels, 9, 9, 9, 255).unwrap();
    assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 200, 100]));
    d.offset_layer(1, -10, 0).unwrap();
    d.fill(1, Target::Pixels, 9, 9, 9, 255).unwrap();
    assert_eq!(d.layer_bounds(1).unwrap(), Some([-10, 0, 210, 100]));
    d.fill(1, Target::Pixels, 0, 0, 0, 0).unwrap();
    assert_eq!(d.layer_bounds(1).unwrap(), Some([-10, 0, 10, 100]));
}

// A layer mask's byte value at a document pixel; the default when the tile is absent.
fn mask_at(d: &Document, id: u32, x: usize, y: usize) -> u8 {
    let (tx, ty) = ((x / TILE) as i32, (y / TILE) as i32);
    let (px, py) = (x % TILE, y % TILE);
    let m = d.node(id).unwrap().mask.as_ref().unwrap();
    let v = match m.tiles.get(tx, ty) {
        Some(t) => t.px.mask_f32(py * TILE + px),
        None => m.default as f32 / 255.0,
    };
    (v * 255.0).round() as u8
}

fn manifest_value(d: &Document) -> Value {
    serde_json::from_str(&d.manifest()).unwrap()
}

// The tile id at (tx, ty) of a v3 sparse tile list, or 0 when the tile is absent.
fn tile_id(list: &Value, tx: i64, ty: i64) -> u64 {
    list.as_array()
        .expect("a sparse tile list")
        .iter()
        .find(|e| e[0].as_i64() == Some(tx) && e[1].as_i64() == Some(ty))
        .map_or(0, |e| e[2].as_u64().expect("a tile id"))
}

// ---------- M0 behaviour ----------

#[test]
fn new_doc_tile_grid_and_max_level() {
    let d = Document::new(600, 300, 8).unwrap();
    assert_eq!(d.tiles_x(), 3);
    assert_eq!(d.tiles_y(), 2);
    assert_eq!(d.max_level(), 2);
    assert_eq!(d.display_tile(0, 0, 0).unwrap(), None);
    assert_eq!(d.node(1).unwrap().name, "Background");
}

#[test]
fn invalid_dims_rejected() {
    assert!(Document::new(0, 10, 8).is_err());
    assert!(Document::new(10, 65537, 8).is_err());
    assert!(Document::new(10, 10, 12).is_err());
}

#[test]
fn unknown_node_errors() {
    let mut d = Document::new(10, 10, 8).unwrap();
    assert!(d.fill(9, Target::Pixels, 0, 0, 0, 255).is_err());
    assert!(d.invert(0, Target::Pixels).is_err());
    assert!(d.set_props(9, "{}").is_err());
    assert!(d.delete_node(9).is_err());
}

#[test]
fn fill_and_manifest_share_id() {
    let mut d = Document::new(512, 512, 8).unwrap();
    d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
    let px = d.display_tile(0, 0, 0).unwrap().unwrap();
    assert_eq!(&px[0..4], &[255, 0, 0, 255]);
    let list = manifest_value(&d)["layers"][0]["tiles"].clone();
    let ids: Vec<u64> = list.as_array().unwrap().iter().map(|v| v[2].as_u64().unwrap()).collect();
    assert_eq!(ids.len(), 4, "a 512x512 canvas has 2x2 tiles");
    assert!(ids.iter().all(|&id| id == ids[0] && id != 0));
}

#[test]
fn snapshot_isolation_and_id_growth() {
    let mut d = doc_bg(255, 0, 0);
    let snap = d.clone();
    d.invert(1, Target::Pixels).unwrap();
    assert_eq!(at(&d, 0, 0), [0, 255, 255, 255]);
    let mut restored = snap.clone();
    assert_eq!(at(&restored, 0, 0), [255, 0, 0, 255]);
    let ids_before = restored.next_id;
    restored.invert(1, Target::Pixels).unwrap();
    let new_id = tile_id(&manifest_value(&restored)["layers"][0]["tiles"], 0, 0);
    assert!(new_id >= ids_before, "new id {new_id} must be >= every earlier id {ids_before}");
}

#[test]
fn engine_core_restore_keeps_node_ids_growing() {
    let mut e = EngineCore::new(Document::new(256, 256, 8).unwrap());
    let snap = e.snapshot();
    let a = e.doc.add_layer("a", 0).unwrap();
    e.restore(snap).unwrap();
    let b = e.doc.add_layer("b", 0).unwrap();
    assert!(b > a, "node ids must never go backwards ({b} after {a})");
}

#[test]
fn blend_two_layers() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 128).unwrap();
    set(&mut d, top, r#"{"opacity":0.5}"#);
    let px = d.display_tile(0, 0, 0).unwrap().unwrap();
    assert_eq!(&px[0..4], &[255, 191, 191, 255]);
}

#[test]
fn hidden_layer_ignored() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 128).unwrap();
    set(&mut d, top, r#"{"visible":false}"#);
    assert_eq!(at(&d, 0, 0), [255, 255, 255, 255]);
}

#[test]
fn box_filter_checkerboard() {
    let mut d = Document::new(512, 512, 8).unwrap();
    d.set_tile_rgba8(1, 0, 0, &opaque(0, 0, 0)).unwrap();
    d.set_tile_rgba8(1, 1, 1, &opaque(0, 0, 0)).unwrap();
    d.set_tile_rgba8(1, 1, 0, &opaque(255, 255, 255)).unwrap();
    d.set_tile_rgba8(1, 0, 1, &opaque(255, 255, 255)).unwrap();
    let out = d.display_tile(1, 0, 0).unwrap().unwrap();
    let px = |x: usize, y: usize| -> [u8; 4] {
        let o = (y * TILE + x) * 4;
        [out[o], out[o + 1], out[o + 2], out[o + 3]]
    };
    assert_eq!(px(0, 0), [0, 0, 0, 255]);
    assert_eq!(px(200, 0), [255, 255, 255, 255]);
}

#[test]
fn box_filter_edge_of_document() {
    let mut d = Document::new(300, 300, 8).unwrap();
    d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    let out = d.display_tile(1, 0, 0).unwrap().unwrap();
    let px = |x: usize, y: usize| -> [u8; 4] {
        let o = (y * TILE + x) * 4;
        [out[o], out[o + 1], out[o + 2], out[o + 3]]
    };
    assert_eq!(px(0, 0), [255, 255, 255, 255]);
    assert_eq!(px(149, 0), [255, 255, 255, 255]);
    assert_eq!(px(150, 0), [0, 0, 0, 0]);
}

#[test]
fn depth16_invert() {
    let mut d = Document::new(256, 256, 16).unwrap();
    d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    d.invert(1, Target::Pixels).unwrap();
    assert_eq!(at(&d, 0, 0), [0, 0, 0, 255]);
    let id = tile_id(&manifest_value(&d)["layers"][0]["tiles"], 0, 0);
    assert_eq!(d.tile_bytes(id).unwrap().len(), TILE_BYTES_U16);
}

#[test]
fn transparent_tile_write_clears_slot() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.set_tile_rgba8(1, 0, 0, &vec![0u8; TILE_BYTES_U8]).unwrap();
    assert!(manifest_value(&d)["layers"][0]["tiles"].as_array().unwrap().is_empty());
}

#[test]
fn flatten_round_trips_straight_alpha() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let mut data = vec![0u8; TILE_BYTES_U8];
    data[0..4].copy_from_slice(&[200, 100, 50, 128]);
    d.set_tile_rgba8(1, 0, 0, &data).unwrap();
    near(at(&d, 0, 0), [200, 100, 50, 128]);
}

#[test]
fn tile_bytes_falls_back_to_live_snapshot() {
    let d = doc_bg(255, 0, 0);
    let old_id = tile_id(&manifest_value(&d)["layers"][0]["tiles"], 0, 0);
    let mut engine = EngineCore::new(d);
    let snap = engine.snapshot();
    engine.doc.invert(1, Target::Pixels).unwrap();
    assert!(engine.doc.tile_bytes(old_id).is_err());
    assert!(engine.tile_bytes(old_id).is_ok());
    engine.drop_snapshot(snap);
    assert!(engine.tile_bytes(old_id).is_err());
}

#[test]
fn tile_bytes_finds_mask_and_nested_tiles() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let g = d.add_group("g", 0).unwrap();
    let child = d.add_layer("child", 0).unwrap();
    d.move_node(child, g, 0).unwrap();
    d.set_tile_rgba8(child, 0, 0, &opaque(1, 2, 3)).unwrap();
    d.add_mask(child, false).unwrap();
    d.set_mask_tile8(child, 0, 0, &vec![200u8; MASK_BYTES_U8]).unwrap();
    let m = manifest_value(&d);
    let pix = tile_id(&m["layers"][1]["children"][0]["tiles"], 0, 0);
    let msk = tile_id(&m["layers"][1]["children"][0]["mask"]["tiles"], 0, 0);
    assert_ne!(pix, 0);
    assert_ne!(msk, 0);
    assert_eq!(d.tile_bytes(pix).unwrap().len(), TILE_BYTES_U8);
    assert_eq!(d.tile_bytes(msk).unwrap().len(), MASK_BYTES_U8);
}

// ---------- compositor ----------

#[test]
fn compositor_applies_a_blend_mode() {
    // Cb = (0.6, 0.4, 0.2), Cs = (0.2, 0.8, 0.2), multiply -> (0.12, 0.32, 0.04).
    let mut d = doc_bg(153, 102, 51);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 51, 204, 51, 255).unwrap();
    set(&mut d, top, r#"{"blend":"multiply"}"#);
    near(at(&d, 0, 0), [31, 82, 10, 255]);
}

#[test]
fn blend_against_a_transparent_backdrop_is_the_source() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.fill(1, Target::Pixels, 51, 204, 51, 255).unwrap();
    set(&mut d, 1, r#"{"blend":"multiply"}"#);
    near(at(&d, 0, 0), [51, 204, 51, 255]);
}

#[test]
fn pass_through_group_differs_from_an_isolated_group() {
    let mut d = doc_bg(0, 255, 0);
    let g = d.add_group("g", 1).unwrap();
    let c = d.add_layer("c", 0).unwrap();
    d.move_node(c, g, 0).unwrap();
    d.fill(c, Target::Pixels, 255, 0, 0, 255).unwrap();
    set(&mut d, c, r#"{"blend":"multiply"}"#);
    // pass through (the group default): the child multiplies with the green backdrop.
    near(at(&d, 0, 0), [0, 0, 0, 255]);
    set(&mut d, g, r#"{"blend":"normal"}"#);
    // isolated: the child multiplies with transparency, the group lands normally.
    near(at(&d, 0, 0), [255, 0, 0, 255]);
}

#[test]
fn group_opacity_applies_to_both_group_modes() {
    let mut d = doc_bg(255, 255, 255);
    let g = d.add_group("g", 1).unwrap();
    let c = d.add_layer("c", 0).unwrap();
    d.move_node(c, g, 0).unwrap();
    d.fill(c, Target::Pixels, 255, 0, 0, 255).unwrap();
    set(&mut d, g, r#"{"opacity":0.5}"#);
    near(at(&d, 0, 0), [255, 128, 128, 255]);
    set(&mut d, g, r#"{"blend":"normal"}"#);
    near(at(&d, 0, 0), [255, 128, 128, 255]);
}

#[test]
fn layer_mask_hides_pixels_and_can_be_disabled() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.add_mask(top, false).unwrap();
    let mut m = vec![0u8; MASK_BYTES_U8];
    for y in 0..TILE {
        for x in 0..128 {
            m[y * TILE + x] = 255;
        }
    }
    d.set_mask_tile8(top, 0, 0, &m).unwrap();
    near(at(&d, 0, 0), [255, 0, 0, 255]);
    near(at(&d, 200, 0), [255, 255, 255, 255]);
    set(&mut d, top, r#"{"mask_enabled":false}"#);
    near(at(&d, 200, 0), [255, 0, 0, 255]);
}

#[test]
fn mask_default_covers_missing_tiles() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.add_mask(top, false).unwrap();
    near(at(&d, 10, 10), [255, 255, 255, 255]);
    d.delete_mask(top).unwrap();
    d.add_mask(top, true).unwrap();
    near(at(&d, 10, 10), [255, 0, 0, 255]);
}

#[test]
fn mask_invert_flips_default_and_tiles() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.add_mask(top, false).unwrap();
    d.invert(top, Target::Mask).unwrap();
    assert_eq!(d.node(top).unwrap().mask.as_ref().unwrap().default, 255);
    near(at(&d, 10, 10), [255, 0, 0, 255]);
}

#[test]
fn mask_fill_uses_the_red_channel() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.add_mask(top, true).unwrap();
    d.fill(top, Target::Mask, 128, 9, 9, 9).unwrap();
    near(at(&d, 10, 10), [255, 127, 127, 255]);
}

// ---------- clipping groups ----------

fn clip_doc() -> (Document, u32, u32) {
    let mut d = doc_bg(255, 255, 255);
    let base = d.add_layer("base", 1).unwrap();
    let mut half = vec![0u8; TILE_BYTES_U8];
    for y in 0..TILE {
        for x in 0..128 {
            let o = (y * TILE + x) * 4;
            half[o..o + 4].copy_from_slice(&[255, 0, 0, 255]);
        }
    }
    d.set_tile_rgba8(base, 0, 0, &half).unwrap();
    let clip = d.add_layer("clip", base).unwrap();
    d.fill(clip, Target::Pixels, 0, 0, 255, 255).unwrap();
    set(&mut d, clip, r#"{"clipping":true}"#);
    (d, base, clip)
}

#[test]
fn clipped_layer_is_limited_by_the_base_alpha() {
    let (d, _, _) = clip_doc();
    near(at(&d, 10, 10), [0, 0, 255, 255]);
    near(at(&d, 200, 10), [255, 255, 255, 255]);
}

#[test]
fn base_opacity_applies_to_the_whole_clipping_group() {
    let (mut d, base, _) = clip_doc();
    set(&mut d, base, r#"{"opacity":0.5}"#);
    near(at(&d, 10, 10), [128, 128, 255, 255]);
    near(at(&d, 200, 10), [255, 255, 255, 255]);
}

#[test]
fn a_hidden_base_hides_its_clipped_layers() {
    let (mut d, base, _) = clip_doc();
    set(&mut d, base, r#"{"visible":false}"#);
    near(at(&d, 10, 10), [255, 255, 255, 255]);
}

#[test]
fn clipping_on_the_lowest_node_is_ignored() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
    set(&mut d, 1, r#"{"clipping":true}"#);
    near(at(&d, 10, 10), [255, 0, 0, 255]);
}

#[test]
fn base_fill_applies_inside_the_group() {
    // Base fill fades the base inside G; a half transparent clipped layer lets it show.
    let (mut d, base, clip) = clip_doc();
    set(&mut d, clip, r#"{"clipping":true,"opacity":0.5}"#);
    near(at(&d, 10, 10), [128, 0, 128, 255]);
    set(&mut d, base, r#"{"fill":0.5}"#);
    near(at(&d, 10, 10), [128, 64, 191, 255]);
}

// Clipped layers paint source-atop: full color over a soft base edge, base alpha kept (corpus clipping-mask.psd).
#[test]
fn clipped_layer_paints_atop_a_soft_base_edge() {
    let (mut d, base, _) = clip_doc();
    d.fill(base, Target::Pixels, 255, 0, 0, 128).unwrap();
    near(at(&d, 10, 10), [127, 127, 255, 255]);
}

// Background, a pass-through group holding one filled layer, and an empty clipped layer above the group.
fn pass_base(bg: [u8; 3], child: [u8; 4], blend: &str) -> (Document, u32, u32) {
    let mut d = doc_bg(bg[0], bg[1], bg[2]);
    let g = d.add_group("g", 1).unwrap();
    let c = d.add_layer("c", 0).unwrap();
    d.move_node(c, g, 0).unwrap();
    d.fill(c, Target::Pixels, child[0], child[1], child[2], child[3]).unwrap();
    set(&mut d, c, &format!(r#"{{"blend":"{blend}"}}"#));
    let clip = d.add_layer("clip", g).unwrap();
    set(&mut d, clip, r#"{"clipping":true}"#);
    (d, g, clip)
}

// A pass-through base stays non-isolated: its children still blend with the backdrop.
#[test]
fn pass_through_clipping_base_stays_in_place() {
    let (d, _, _) = pass_base([125, 125, 125], [255, 0, 0, 255], "linear dodge");
    near(at(&d, 10, 10), [255, 125, 125, 255]);
}

// The clipped layer replaces only the base's share of the pixel; the backdrop share stays.
#[test]
fn clipped_layer_over_pass_through_base_recolors_only_the_base_share() {
    let (mut d, _, clip) = pass_base([255, 255, 255], [255, 0, 0, 128], "normal");
    d.fill(clip, Target::Pixels, 0, 255, 0, 255).unwrap();
    near(at(&d, 10, 10), [127, 255, 127, 255]);
}

// The clipped layer blends with the in-place result (cyan from exclusion), not with the isolated base (red).
#[test]
fn clipped_layer_over_pass_through_base_blends_with_the_in_place_color() {
    let (mut d, _, clip) = pass_base([255, 255, 255], [255, 0, 0, 255], "exclusion");
    d.fill(clip, Target::Pixels, 0, 255, 0, 255).unwrap();
    set(&mut d, clip, r#"{"blend":"lighter color"}"#);
    near(at(&d, 10, 10), [0, 255, 255, 255]);
}

// Group fill fades the group like opacity (corpus passthrough_fill_blendmode.psd).
#[test]
fn group_fill_fades_like_opacity() {
    for mode in ["pass through", "normal"] {
        let (mut d, g, clip) = pass_base([255, 255, 255], [255, 0, 0, 255], "normal");
        d.delete_node(clip).unwrap();
        set(&mut d, g, &format!(r#"{{"blend":"{mode}","fill":0.5}}"#));
        near(at(&d, 10, 10), [255, 127, 127, 255]);
    }
}

// ---------- dissolve, fill, depth ----------

#[test]
fn dissolve_is_deterministic_and_binary() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
    set(&mut d, top, r#"{"blend":"dissolve","opacity":0.5}"#);
    let a = d.flatten_tile_rgba8(0, 0).unwrap();
    let b = d.flatten_tile_rgba8(0, 0).unwrap();
    assert_eq!(a, b, "dissolve must be stable across renders");
    let mut red = 0;
    for p in 0..TILE_PIXELS {
        let px = [a[p * 4], a[p * 4 + 1], a[p * 4 + 2]];
        assert!(px == [255, 0, 0] || px == [255, 255, 255], "pixel {p} is {px:?}");
        if px == [255, 0, 0] {
            red += 1;
        }
    }
    let share = red as f32 / TILE_PIXELS as f32;
    assert!((share - 0.5).abs() < 0.05, "share {share}");
}

#[test]
fn fill_and_opacity_both_multiply_coverage() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
    set(&mut d, top, r#"{"opacity":0.5,"fill":0.5}"#);
    let both = at(&d, 0, 0);
    set(&mut d, top, r#"{"opacity":0.25,"fill":1.0}"#);
    near(both, at(&d, 0, 0));
    near(both, [255, 191, 191, 255]);
}

#[test]
fn depth16_blend_matches_the_8_bit_result() {
    let mut d = Document::new(256, 256, 16).unwrap();
    d.fill(1, Target::Pixels, 153, 102, 51, 255).unwrap();
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 51, 204, 51, 255).unwrap();
    set(&mut d, top, r#"{"blend":"multiply"}"#);
    near(at(&d, 0, 0), [31, 82, 10, 255]);
}

// ---------- locks ----------

#[test]
fn pixel_lock_blocks_fill_and_invert() {
    let mut d = doc_bg(255, 0, 0);
    set(&mut d, 1, r#"{"locks":{"pixels":true}}"#);
    assert_eq!(
        d.fill(1, Target::Pixels, 0, 0, 0, 255).unwrap_err(),
        "layer pixels are locked"
    );
    assert_eq!(d.invert(1, Target::Pixels).unwrap_err(), "layer pixels are locked");
}

#[test]
fn transparency_lock_keeps_alpha_and_empty_tiles() {
    let mut d = Document::new(512, 256, 8).unwrap();
    let mut data = vec![0u8; TILE_BYTES_U8];
    data[0..8].copy_from_slice(&[10, 20, 30, 128, 0, 0, 0, 0]);
    d.set_tile_rgba8(1, 0, 0, &data).unwrap();
    set(&mut d, 1, r#"{"locks":{"transparency":true}}"#);
    d.fill(1, Target::Pixels, 0, 255, 0, 255).unwrap();
    near(at(&d, 0, 0), [0, 255, 0, 128]);
    assert_eq!(at(&d, 1, 0)[3], 0, "an empty pixel stays empty");
    let ids = manifest_value(&d)["layers"][0]["tiles"].clone();
    assert_eq!(tile_id(&ids, 1, 0), 0, "the empty tile stays empty");
}

// ---------- commands ----------

#[test]
fn add_layer_inserts_above_a_node_or_on_top() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let a = d.add_layer("a", 0).unwrap();
    let b = d.add_layer("b", 1).unwrap();
    let order: Vec<u32> = d.nodes.iter().map(|n| n.id).collect();
    assert_eq!(order, vec![1, b, a]);
    assert!(d.add_layer("x", 999).is_err());
    assert!(d.add_group("g", 999).is_err());
}

#[test]
fn group_nodes_and_ungroup_keep_order() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let a = d.add_layer("a", 0).unwrap();
    let b = d.add_layer("b", 0).unwrap();
    let g = d.group_nodes(&[1, b]).unwrap();
    assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![a, g]);
    let children = match &d.node(g).unwrap().kind {
        Kind::Group(ch) => ch.iter().map(|n| n.id).collect::<Vec<_>>(),
        _ => panic!("group"),
    };
    assert_eq!(children, vec![1, b]);
    d.ungroup(g).unwrap();
    assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![a, 1, b]);
    assert!(d.ungroup(1).is_err(), "a pixel layer cannot be ungrouped");
}

#[test]
fn group_nodes_needs_one_parent() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let g = d.add_group("g", 0).unwrap();
    let c = d.add_layer("c", 0).unwrap();
    d.move_node(c, g, 0).unwrap();
    assert!(d.group_nodes(&[1, c]).is_err());
    assert!(d.group_nodes(&[]).is_err());
    assert!(d.group_nodes(&[1, 1]).is_err());
}

#[test]
fn delete_node_keeps_one_root_node() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let a = d.add_layer("a", 0).unwrap();
    d.delete_node(a).unwrap();
    assert_eq!(d.delete_node(1).unwrap_err(), "the document must keep at least one root node");
}

#[test]
fn duplicate_node_copies_the_subtree_and_shares_tiles() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let g = d.add_group("g", 0).unwrap();
    let c = d.add_layer("c", 0).unwrap();
    d.move_node(c, g, 0).unwrap();
    d.set_tile_rgba8(c, 0, 0, &opaque(1, 2, 3)).unwrap();
    let copy = d.duplicate_node(g).unwrap();
    assert_ne!(copy, g);
    assert_eq!(d.node(copy).unwrap().name, "g copy");
    let m = manifest_value(&d);
    let src = tile_id(&m["layers"][1]["children"][0]["tiles"], 0, 0);
    let dup = tile_id(&m["layers"][2]["children"][0]["tiles"], 0, 0);
    assert_eq!(src, dup, "duplicated layers share their tiles");
    let dup_id = m["layers"][2]["children"][0]["id"].as_u64().unwrap() as u32;
    assert_ne!(dup_id, c, "every copied node gets a new id");
}

#[test]
fn move_node_rejects_itself_its_descendants_and_bad_targets() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let g = d.add_group("g", 0).unwrap();
    let inner = d.add_group("inner", 0).unwrap();
    d.move_node(inner, g, 0).unwrap();
    assert!(d.move_node(g, g, 0).is_err());
    assert!(d.move_node(g, inner, 0).is_err(), "cannot move into a descendant");
    assert!(d.move_node(g, 1, 0).is_err(), "a pixel layer is not a group");
    assert!(d.move_node(g, 0, 9).is_err(), "index out of range");
    d.move_node(g, 0, 0).unwrap();
    assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![g, 1]);
}

#[test]
fn move_node_keeps_at_least_one_root_node() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let g = d.add_group("g", 0).unwrap();
    d.move_node(1, g, 0).unwrap();
    assert_eq!(d.nodes.len(), 1);
    let inner = d.node(g).unwrap();
    assert!(matches!(&inner.kind, Kind::Group(ch) if ch.len() == 1));
    assert!(d.move_node(g, 0, 0).is_ok());
    let mut d2 = Document::new(256, 256, 8).unwrap();
    let g2 = d2.add_group("g", 0).unwrap();
    d2.delete_node(g2).unwrap();
    let g3 = d2.add_group("g", 0).unwrap();
    d2.move_node(1, g3, 0).unwrap();
    assert!(d2.move_node(g3, g3, 0).is_err());
}

#[test]
fn set_props_validates_its_input() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let g = d.add_group("g", 0).unwrap();
    assert!(d.set_props(1, r#"{"blend":"pass through"}"#).is_err());
    d.set_props(g, r#"{"blend":"pass through"}"#).unwrap();
    assert!(d.set_props(1, r#"{"opacity":1.5}"#).is_err());
    assert!(d.set_props(1, r#"{"fill":-0.1}"#).is_err());
    assert!(d.set_props(1, r#"{"blend":"glow"}"#).is_err());
    assert!(d.set_props(1, r#"{"nope":1}"#).is_err());
    assert!(d.set_props(1, r#"{"mask_enabled":true}"#).is_err());
    assert!(d.set_props(g, r#"{"fill":1.5}"#).is_err());
    d.set_props(1, r#"{"name":"bg","visible":false,"locks":{"position":true}}"#).unwrap();
    let n = d.node(1).unwrap();
    assert_eq!(n.name, "bg");
    assert!(!n.visible);
    assert!(n.locks.position && !n.locks.pixels);
}

#[test]
fn mask_commands_report_conflicts() {
    let mut d = Document::new(256, 256, 8).unwrap();
    assert!(d.delete_mask(1).is_err());
    assert!(d.invert(1, Target::Mask).is_err());
    assert!(d.fill(1, Target::Mask, 1, 1, 1, 1).is_err());
    assert!(d.set_mask_tile8(1, 0, 0, &vec![0u8; MASK_BYTES_U8]).is_err());
    d.add_mask(1, true).unwrap();
    assert!(d.add_mask(1, true).is_err());
    d.delete_mask(1).unwrap();
}

#[test]
fn pixel_commands_reject_groups_and_bad_targets() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let g = d.add_group("g", 0).unwrap();
    assert!(d.fill(g, Target::Pixels, 0, 0, 0, 255).is_err());
    assert!(d.invert(g, Target::Pixels).is_err());
    assert!(d.set_tile_rgba8(g, 0, 0, &opaque(1, 1, 1)).is_err());
    assert!(d.set_tile_rgba8(1, 5, 0, &opaque(1, 1, 1)).is_err());
    assert!(d.set_tile_rgba8(1, 0, 0, &[0u8; 8]).is_err());
    assert!(Target::parse("pixels").is_ok());
    assert!(Target::parse("mask").is_ok());
    assert!(Target::parse("alpha").is_err());
}

#[test]
fn layers_json_is_the_tree_without_tiles() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let g = d.add_group("g", 0).unwrap();
    let c = d.add_layer("c", 0).unwrap();
    d.move_node(c, g, 0).unwrap();
    d.add_mask(c, true).unwrap();
    let v: Value = serde_json::from_str(&d.layers_json()).unwrap();
    assert_eq!(v[0]["id"].as_u64().unwrap(), 1);
    assert_eq!(v[0]["kind"], "pixel");
    assert!(v[0]["tiles"].is_null(), "the UI tree carries no tile ids");
    assert_eq!(v[1]["kind"], "group");
    assert_eq!(v[1]["blend"], "pass through");
    let child = &v[1]["children"][0];
    assert_eq!(child["id"].as_u64().unwrap() as u32, c);
    assert_eq!(child["mask"]["enabled"], true);
    assert_eq!(child["mask"]["default"].as_u64().unwrap(), 255);
    assert!(child["mask"]["tiles"].is_null());
}

// ---------- persistence ----------

fn collect_ids(v: &Value, ids: &mut HashSet<u64>) {
    for list in [&v["tiles"], &v["mask"]["tiles"]] {
        if let Some(a) = list.as_array() {
            ids.extend(a.iter().filter_map(|e| e[2].as_u64()));
        }
    }
    if let Some(ch) = v["children"].as_array() {
        for c in ch {
            collect_ids(c, ids);
        }
    }
}

// Every tile id a v3 manifest references: layers, masks, both selections and the channels.
fn all_ids(m: &Value) -> HashSet<u64> {
    let mut ids: HashSet<u64> = HashSet::new();
    for n in m["layers"].as_array().expect("layers") {
        collect_ids(n, &mut ids);
    }
    let mut sel = |v: &Value| {
        if let Some(a) = v["tiles"].as_array() {
            ids.extend(a.iter().filter_map(|e| e[2].as_u64()));
        }
    };
    sel(&m["selection"]);
    sel(&m["last_selection"]);
    for c in m["channels"].as_array().expect("channels") {
        sel(c);
    }
    ids
}

fn loaded_copy(d: &Document) -> Document {
    let manifest = d.manifest();
    let mut l = Document::from_manifest(&manifest).unwrap();
    let m: Value = serde_json::from_str(&manifest).unwrap();
    let ids = all_ids(&m);
    assert!(l.finish_load().is_err(), "loading is not done before every tile arrived");
    for id in ids {
        l.put_tile(id, &d.tile_bytes(id).unwrap()).unwrap();
    }
    l.finish_load().unwrap();
    assert_eq!(l.manifest(), manifest, "a v3 manifest must round trip byte for byte");
    l
}

fn rich_doc() -> Document {
    let mut d = Document::new(600, 300, 8).unwrap();
    d.fill(1, Target::Pixels, 10, 20, 30, 255).unwrap();
    let g = d.add_group("g", 1).unwrap();
    let c = d.add_layer("c", 0).unwrap();
    d.move_node(c, g, 0).unwrap();
    d.set_tile_rgba8(c, 1, 1, &opaque(9, 9, 9)).unwrap();
    d.invert(c, Target::Pixels).unwrap();
    d.add_mask(c, false).unwrap();
    d.set_mask_tile8(c, 1, 1, &vec![180u8; MASK_BYTES_U8]).unwrap();
    set(&mut d, c, r#"{"blend":"soft light","opacity":0.75,"fill":0.5,"locks":{"position":true}}"#);
    set(&mut d, g, r#"{"opacity":0.9}"#);
    d
}

#[test]
fn round_trip_manifest_and_tiles() {
    let d = rich_doc();
    let l = loaded_copy(&d);
    for ty in 0..d.tiles_y() {
        for tx in 0..d.tiles_x() {
            assert_eq!(l.display_tile(0, tx, ty).unwrap(), d.display_tile(0, tx, ty).unwrap());
        }
    }
}

#[test]
fn v1_manifest_loads_as_pixel_nodes() {
    let mut old = Document::new(256, 256, 8).unwrap();
    old.fill(1, Target::Pixels, 7, 8, 9, 255).unwrap();
    let tile_id = tile_id(&manifest_value(&old)["layers"][0]["tiles"], 0, 0);
    let v1 = format!(
        r#"{{"format":"photobaer-manifest","version":1,"width":256,"height":256,"depth":8,"tiles_x":1,"tiles_y":1,"next_id":{},"layers":[{{"name":"bg","visible":true,"opacity":1.0,"tiles":[{tile_id}]}},{{"name":"top","visible":false,"opacity":0.5,"tiles":[0]}}]}}"#,
        tile_id + 1
    );
    let mut d = Document::from_manifest(&v1).unwrap();
    d.put_tile(tile_id, &old.tile_bytes(tile_id).unwrap()).unwrap();
    d.finish_load().unwrap();
    assert_eq!(d.nodes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![1, 2]);
    let n = d.node(2).unwrap();
    assert_eq!(n.name, "top");
    assert!(!n.visible);
    assert_eq!(n.blend, Blend::Normal);
    assert_eq!(n.fill, 1.0);
    assert!(n.mask.is_none());
    assert_eq!(n.locks, Locks::default());
    assert_eq!(at(&d, 0, 0), [7, 8, 9, 255]);
    let m = manifest_value(&d);
    assert_eq!(m["version"].as_u64().unwrap(), 6);
    assert_eq!(m["next_node_id"].as_u64().unwrap(), 3);
}

#[test]
fn v1_rejections_still_apply() {
    let bad = r#"{"format":"photobaer-manifest","version":1,"width":256,"height":256,"depth":8,"tiles_x":1,"tiles_y":1,"next_id":2,"layers":[{"name":"bg","visible":true,"opacity":1.0,"tiles":[1,2]}]}"#;
    assert!(Document::from_manifest(bad).is_err());
    let empty = r#"{"format":"photobaer-manifest","version":1,"width":256,"height":256,"depth":8,"tiles_x":1,"tiles_y":1,"next_id":1,"layers":[]}"#;
    assert!(Document::from_manifest(empty).is_err());
    let wrong = r#"{"format":"other","version":1,"width":256,"height":256,"depth":8,"tiles_x":1,"tiles_y":1,"next_id":1,"layers":[]}"#;
    assert!(Document::from_manifest(wrong).is_err());
}

#[test]
fn manifest_ids_beyond_js_safe_integers_are_rejected() {
    let d = Document::new(256, 256, 8).unwrap();
    let big = format!("{}", 1u64 << 60);
    let json = d.manifest().replacen(&format!("\"next_id\":{}", d.next_id), &format!("\"next_id\":{big}"), 1);
    assert!(json.contains(&big));
    assert!(Document::from_manifest(&json).is_err());
    let json = d.manifest().replacen("\"tiles\":[]", &format!("\"tiles\":[[0,0,{big}]]"), 1);
    assert!(json.contains(&big));
    assert!(Document::from_manifest(&json).is_err());
}

#[test]
fn loaded_empty_manifest_with_next_id_zero_still_allocates_nonzero_ids() {
    let d = Document::new(256, 256, 8).unwrap();
    let json = d.manifest().replacen(&format!("\"next_id\":{}", d.next_id), "\"next_id\":0", 1);
    let mut l = Document::from_manifest(&json).unwrap();
    l.finish_load().unwrap();
    l.fill(1, Target::Pixels, 1, 2, 3, 255).unwrap();
    assert_ne!(tile_id(&manifest_value(&l)["layers"][0]["tiles"], 0, 0), 0);
}

fn broken(f: impl Fn(&mut Value)) -> String {
    let d = rich_doc();
    let mut v: Value = serde_json::from_str(&d.manifest()).unwrap();
    f(&mut v);
    v.to_string()
}

#[test]
fn manifest_rejections() {
    let cases: Vec<(&str, String)> = vec![
        ("duplicate node id", broken(|v| v["layers"][1]["id"] = 1.into())),
        ("node id 0", broken(|v| v["layers"][0]["id"] = 0.into())),
        ("next_node_id too small", broken(|v| v["next_node_id"] = 1.into())),
        ("unknown blend", broken(|v| v["layers"][0]["blend"] = "glow".into())),
        ("pass through on a pixel node", broken(|v| v["layers"][0]["blend"] = "pass through".into())),
        ("tile id 0", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([[0, 0, 0]]))),
        ("duplicate tile coordinate", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([[1, 1, 5], [1, 1, 6]]))),
        ("tile coordinate out of range", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([[1 << 21, 0, 5]]))),
        ("malformed tile entry", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([[1, 2]]))),
        ("group with tiles", broken(|v| v["layers"][1]["tiles"] = serde_json::json!([[0, 0, 7]]))),
        ("pixel node with children", broken(|v| v["layers"][0]["children"] = serde_json::json!([]))),
        ("unknown kind", broken(|v| v["layers"][0]["kind"] = "text".into())),
        ("opacity out of range", broken(|v| v["layers"][0]["opacity"] = 2.into())),
        ("unknown field", broken(|v| v["layers"][0]["extra"] = 1.into())),
        ("unsupported version", broken(|v| v["version"] = 7.into())),
        ("tiles_x mismatch", broken(|v| v["tiles_x"] = 9.into())),
    ];
    for (what, json) in cases {
        assert!(Document::from_manifest(&json).is_err(), "{what} must be rejected");
    }
    let d = rich_doc();
    let m: Value = serde_json::from_str(&d.manifest()).unwrap();
    let pixel_id = tile_id(&m["layers"][1]["children"][0]["tiles"], 1, 1);
    let json = broken(|v| {
        let mask = v["layers"][1]["children"][0]["mask"]["tiles"].as_array_mut().unwrap();
        mask[0][2] = pixel_id.into();
    });
    assert!(
        matches!(Document::from_manifest(&json), Err(e) if e.contains("both pixel and mask")),
        "a tile id must not be used as both pixel and mask data"
    );
    let mut l = Document::from_manifest(&d.manifest()).unwrap();
    assert!(l.put_tile(pixel_id, &vec![0u8; MASK_BYTES_U8]).is_err());
    let mask_id = tile_id(&m["layers"][1]["children"][0]["mask"]["tiles"], 1, 1);
    assert!(l.put_tile(mask_id, &vec![0u8; TILE_BYTES_U8]).is_err());
    l.put_tile(mask_id, &vec![7u8; MASK_BYTES_U8]).unwrap();
    assert!(l.put_tile(999_999, &vec![7u8; MASK_BYTES_U8]).is_err());
}

#[test]
fn commands_are_refused_while_the_document_is_loading() {
    let d = rich_doc();
    let manifest = d.manifest();
    let m: Value = serde_json::from_str(&manifest).unwrap();
    let ids = all_ids(&m);
    let mut l = Document::from_manifest(&manifest).unwrap();
    let group = l.nodes[1].id;
    let child = match &l.nodes[1].kind {
        Kind::Group(ch) => ch[0].id,
        _ => panic!("group"),
    };
    for (what, r) in [
        ("add_layer", l.add_layer("x", 0).map(|_| ())),
        ("add_group", l.add_group("x", 0).map(|_| ())),
        ("group_nodes", l.group_nodes(&[1]).map(|_| ())),
        ("ungroup", l.ungroup(group)),
        ("delete_node", l.delete_node(1)),
        ("duplicate_node", l.duplicate_node(1).map(|_| ())),
        ("move_node", l.move_node(1, group, 0)),
        ("set_props", l.set_props(1, r#"{"visible":false}"#)),
        ("add_mask", l.add_mask(1, true)),
        ("delete_mask", l.delete_mask(child)),
        ("fill pixels", l.fill(1, Target::Pixels, 1, 2, 3, 255)),
        ("fill mask", l.fill(child, Target::Mask, 1, 2, 3, 255)),
        ("invert pixels", l.invert(1, Target::Pixels)),
        ("invert mask", l.invert(child, Target::Mask)),
        ("set_tile_rgba8", l.set_tile_rgba8(1, 0, 0, &opaque(1, 2, 3))),
        ("set_mask_tile8", l.set_mask_tile8(child, 0, 0, &vec![1u8; MASK_BYTES_U8])),
    ] {
        assert_eq!(r.unwrap_err(), "document is still loading", "{what} must be refused");
    }
    for id in ids {
        l.put_tile(id, &d.tile_bytes(id).unwrap()).unwrap();
    }
    l.finish_load().unwrap();
    assert_eq!(l.manifest(), manifest, "the tree survives a refused command");
    l.set_props(1, r#"{"visible":false}"#).unwrap();
}

// ---------- pyramid, display levels and draw program ----------

fn pattern(seed: u32, tx: u32, ty: u32) -> Vec<u8> {
    let mut v = vec![0u8; TILE_BYTES_U8];
    let s = seed as usize;
    for y in 0..TILE {
        for x in 0..TILE {
            let gx = tx as usize * TILE + x;
            let gy = ty as usize * TILE + y;
            let o = (y * TILE + x) * 4;
            v[o] = (gx * 3 + s * 17) as u8;
            v[o + 1] = (gy * 5 + s * 29) as u8;
            v[o + 2] = ((gx ^ gy) as u8) ^ (s as u8);
            v[o + 3] = (((gx / 7 + gy / 5 + s) % 5) * 60) as u8;
        }
    }
    v
}

fn mask_pattern(seed: u32, tx: u32, ty: u32) -> Vec<u8> {
    let mut v = vec![0u8; MASK_BYTES_U8];
    let s = seed as usize;
    for y in 0..TILE {
        for x in 0..TILE {
            let gx = tx as usize * TILE + x;
            let gy = ty as usize * TILE + y;
            v[y * TILE + x] = (gx * 2 + gy * 3 + s * 11) as u8;
        }
    }
    v
}

fn paint(d: &mut Document, id: u32, seed: u32) {
    for ty in 0..d.tiles_y() {
        for tx in 0..d.tiles_x() {
            d.set_tile_rgba8(id, tx, ty, &pattern(seed, tx, ty)).unwrap();
        }
    }
}

// A mask with a painted first tile and the reveal default everywhere else.
fn paint_mask(d: &mut Document, id: u32, seed: u32) {
    d.add_mask(id, true).unwrap();
    d.set_mask_tile8(id, 0, 0, &mask_pattern(seed, 0, 0)).unwrap();
    let (tx, ty) = (d.tiles_x() - 1, d.tiles_y() - 1);
    d.set_mask_tile8(id, tx, ty, &mask_pattern(seed, tx, ty)).unwrap();
}

fn add_painted(d: &mut Document, above: &mut u32, name: &str, seed: u32) -> u32 {
    let id = d.add_layer(name, *above).unwrap();
    paint(d, id, seed);
    *above = id;
    id
}

// Every blend mode, dissolve, masks, nested groups, a pass-through group with
// fill < 1, and clipping groups with a pixel, group, pass-through and hidden base.
fn program_doc() -> Document {
    let mut d = Document::new(600, 300, 8).unwrap();
    paint(&mut d, 1, 1);
    // clipping on the lowest node is ignored
    set(&mut d, 1, r#"{"clipping":true}"#);
    let mut above = 1;
    for (i, (_, name)) in BLEND_NAMES.iter().enumerate() {
        if *name == "pass through" {
            continue;
        }
        let id = add_painted(&mut d, &mut above, name, i as u32 + 2);
        set(&mut d, id, &format!(r#"{{"blend":"{name}","opacity":0.7,"fill":0.9}}"#));
    }

    let a = add_painted(&mut d, &mut above, "ga", 40);
    let b = add_painted(&mut d, &mut above, "gb", 41);
    set(&mut d, b, r#"{"blend":"screen"}"#);
    let g = d.group_nodes(&[a, b]).unwrap();
    set(&mut d, g, r#"{"blend":"multiply","opacity":0.8,"fill":0.6}"#);
    paint_mask(&mut d, g, 7);
    above = g;

    let n1 = add_painted(&mut d, &mut above, "n1", 42);
    let n2 = add_painted(&mut d, &mut above, "n2", 43);
    let inner = d.group_nodes(&[n2]).unwrap();
    set(&mut d, inner, r#"{"blend":"normal","opacity":0.9}"#);
    let outer = d.group_nodes(&[n1, inner]).unwrap();
    set(&mut d, outer, r#"{"blend":"pass through","opacity":0.8,"fill":0.5}"#);
    paint_mask(&mut d, outer, 8);
    above = outer;

    let pb = add_painted(&mut d, &mut above, "pixbase", 50);
    set(&mut d, pb, r#"{"blend":"overlay","opacity":0.9,"fill":0.8}"#);
    paint_mask(&mut d, pb, 9);
    let pc1 = add_painted(&mut d, &mut above, "clip1", 51);
    set(&mut d, pc1, r#"{"clipping":true,"blend":"multiply","opacity":0.8,"fill":0.7}"#);
    let pc2 = add_painted(&mut d, &mut above, "clip2", 52);
    set(&mut d, pc2, r#"{"clipping":true}"#);
    paint_mask(&mut d, pc2, 10);

    let gb1 = add_painted(&mut d, &mut above, "gb1", 53);
    let gb2 = add_painted(&mut d, &mut above, "gb2", 54);
    let gbase = d.group_nodes(&[gb1, gb2]).unwrap();
    set(&mut d, gbase, r#"{"blend":"hard light","opacity":0.9,"fill":0.7}"#);
    paint_mask(&mut d, gbase, 11);
    above = gbase;
    let gc = add_painted(&mut d, &mut above, "gclip", 55);
    set(&mut d, gc, r#"{"clipping":true,"blend":"color dodge"}"#);

    let pt1 = add_painted(&mut d, &mut above, "pt1", 56);
    let ptbase = d.group_nodes(&[pt1]).unwrap();
    set(&mut d, ptbase, r#"{"blend":"pass through","opacity":0.8,"fill":0.6}"#);
    paint_mask(&mut d, ptbase, 12);
    above = ptbase;
    let ptc = add_painted(&mut d, &mut above, "ptclip", 57);
    set(&mut d, ptc, r#"{"clipping":true,"blend":"difference","opacity":0.9}"#);

    let hb = add_painted(&mut d, &mut above, "hidden", 58);
    set(&mut d, hb, r#"{"visible":false}"#);
    let hc = add_painted(&mut d, &mut above, "hidclip", 59);
    set(&mut d, hc, r#"{"clipping":true}"#);
    d
}

fn fnv(bytes: &[u8], mut h: u64) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    h
}

fn scene_checksum(d: &Document) -> u64 {
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    for ty in 0..d.tiles_y() {
        for tx in 0..d.tiles_x() {
            h = fnv(&d.flatten_tile_rgba8(tx, ty).unwrap(), h);
            h = match d.display_tile(0, tx, ty).unwrap() {
                Some(b) => fnv(&b, h),
                None => fnv(&[0], h),
            };
        }
    }
    h
}

// Four source pixels at the top-left corner; the rest of the tile stays transparent.
fn corner_doc() -> Document {
    let mut d = Document::new(1024, 1024, 8).unwrap();
    let mut t = vec![0u8; TILE_BYTES_U8];
    t[4..8].copy_from_slice(&[200, 100, 50, 255]);
    let row = TILE * 4;
    t[row..row + 4].copy_from_slice(&[100, 255, 0, 128]);
    t[row + 4..row + 8].copy_from_slice(&[40, 60, 80, 64]);
    d.set_tile_rgba8(1, 0, 0, &t).unwrap();
    d
}

#[test]
fn pyramid_box_averages_premultiplied() {
    let d = corner_doc();
    // (0,0,0,0), (200,100,50,255), (100,255,0,128), (40,60,80,64):
    // premultiplied sums 66360 / 61980 / 17870 over alpha sum 447, alpha 447/4.
    let l1 = d.level_tile_bytes(1, false, 1, 0, 0).unwrap();
    assert_eq!(&l1[0..4], &[148, 139, 40, 112]);
    assert_eq!(&l1[4..8], &[0, 0, 0, 0], "the neighbouring 2x2 block is empty");
    // Level 2 averages one opaque-ish sample with three empty ones: color kept, alpha / 4.
    let l2 = d.level_tile_bytes(1, false, 2, 0, 0).unwrap();
    assert_eq!(&l2[0..4], &[148, 139, 40, 28]);
    assert!(d.level_tile_bytes(1, false, 1, 1, 0).is_none(), "an all-empty 2x2 stays None");
}

#[test]
fn pyramid_masks_average_and_keep_the_default() {
    let mut d = corner_doc();
    d.add_mask(1, true).unwrap();
    let mut m = vec![0u8; MASK_BYTES_U8];
    m[1] = 100;
    m[TILE] = 200;
    m[TILE + 1] = 255;
    d.set_mask_tile8(1, 0, 0, &m).unwrap();
    let l1 = d.level_tile_bytes(1, true, 1, 0, 0).unwrap();
    assert_eq!(l1[0], 139, "(0 + 100 + 200 + 255) / 4");
    assert_eq!(l1[1], 0);
    assert!(d.level_tile_bytes(1, true, 1, 1, 0).is_none(), "a missing mask tile stays the default");
}

#[test]
fn pyramid_follows_edits_and_snapshot_restore() {
    let mut d = Document::new(512, 512, 8).unwrap();
    d.fill(1, Target::Pixels, 255, 255, 255, 255).unwrap();
    let white = d.display_tile(1, 0, 0).unwrap().unwrap();
    assert_eq!(&white[0..4], &[255, 255, 255, 255]);
    let mut e = EngineCore::new(d);
    let snap = e.snapshot();
    e.doc.fill(1, Target::Pixels, 0, 0, 0, 255).unwrap();
    let black = e.doc.display_tile(1, 0, 0).unwrap().unwrap();
    assert_eq!(&black[0..4], &[0, 0, 0, 255], "an edit shows at level 1");
    e.restore(snap).unwrap();
    assert_eq!(e.doc.display_tile(1, 0, 0).unwrap().unwrap(), white, "restore shows at level 1");
}

fn payload_keys(b: &[u8]) -> Vec<u64> {
    let u32at = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let mut o = 32 + u32at(24) as usize * STEP_BYTES;
    let mut keys = Vec::new();
    for _ in 0..u32at(28) {
        keys.push(u64::from_le_bytes(b[o..o + 8].try_into().unwrap()));
        o += 16 + u32at(o + 12) as usize;
    }
    keys
}

#[test]
fn display_program_matches_the_display_tile() {
    let d = program_doc();
    for level in [0, 2] {
        let (ntx, nty) = d.level_tiles(level);
        for ty in 0..nty {
            for tx in 0..ntx {
                let bytes = d.display_program(level, tx, ty, &[]).unwrap();
                let run = Document::run_program(&Program::decode(&bytes));
                assert_eq!(
                    quantize_premul(&run),
                    d.display_tile(level, tx, ty).unwrap(),
                    "level {level} tile ({tx}, {ty})"
                );
                let known = payload_keys(&bytes);
                assert!(!known.is_empty());
                let again = d.display_program(level, tx, ty, &known).unwrap();
                assert!(payload_keys(&again).is_empty(), "known payloads are not resent");
                assert!(again.len() < bytes.len());
            }
        }
    }
}

#[test]
fn depth16_documents_display_but_have_no_draw_program() {
    let mut d = Document::new(512, 512, 16).unwrap();
    d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
    assert_eq!(&d.display_tile(1, 0, 0).unwrap().unwrap()[0..4], &[255, 0, 0, 255]);
    assert_eq!(
        d.display_program(0, 0, 0, &[]).unwrap_err(),
        "draw programs need an 8-bit document"
    );
}

#[test]
fn display_tile_level0_is_unchanged() {
    // Frozen before the pyramid rewrite: level 0 must stay bit-identical.
    assert_eq!(scene_checksum(&program_doc()), 9894974724174265876);
}

// cargo test --release bench_pan_zoom -- --ignored --nocapture
#[test]
#[ignore]
fn bench_pan_zoom() {
    use std::time::Instant;
    let mut d = Document::new(8000, 8000, 8).unwrap();
    // Distinct content per tile, so every tile has its own id and its own pyramid entries.
    let paint_all = |d: &mut Document, id: u32, seed: u32| {
        for ty in 0..d.tiles_y() {
            for tx in 0..d.tiles_x() {
                let c = [(tx * 7 + seed) as u8, (ty * 5 + seed) as u8, (tx + ty) as u8, 220];
                let mut px = vec![0u8; TILE_BYTES_U8];
                for p in px.chunks_exact_mut(4) {
                    p.copy_from_slice(&c);
                }
                d.set_tile_rgba8(id, tx, ty, &px).unwrap();
            }
        }
    };
    paint_all(&mut d, 1, 1);
    for i in 0..9u32 {
        let id = d.add_layer(&format!("L{i}"), 0).unwrap();
        paint_all(&mut d, id, i * 13 + 2);
    }
    let sweep = |level: u32, n: u32| {
        let start = Instant::now();
        for ty in 0..n {
            for tx in 0..n {
                d.display_tile(level, tx, ty).unwrap();
            }
        }
        start.elapsed().as_secs_f64() * 1000.0 / (n * n) as f64
    };
    println!("bench_pan_zoom: level 0 {:.2} ms/tile", sweep(0, 4));
    println!("bench_pan_zoom: level 3 cold {:.2} ms/tile", sweep(3, 4));
    println!("bench_pan_zoom: level 3 warm {:.2} ms/tile", sweep(3, 4));
    println!("bench_pan_zoom: level 5 cold {:.2} ms/tile", sweep(5, 1));
    println!("bench_pan_zoom: level 5 warm {:.2} ms/tile", sweep(5, 1));
    println!("bench_pan_zoom: level 3 after zoom out {:.2} ms/tile", sweep(3, 4));
}

#[test]
#[ignore]
fn bench_display_tile() {
    use std::time::Instant;
    let mut d = Document::new(8000, 8000, 8).unwrap();
    d.fill(1, Target::Pixels, 128, 64, 32, 200).unwrap();

    let start = Instant::now();
    for i in 0..16 {
        let tx = i % 4;
        let ty = i / 4;
        d.display_tile(0, tx, ty).unwrap();
    }
    let level0_ms = start.elapsed().as_secs_f64() * 1000.0;

    let start = Instant::now();
    d.display_tile(3, 0, 0).unwrap();
    let level3_ms = start.elapsed().as_secs_f64() * 1000.0;

    println!("bench_display_tile: 16x level0 = {level0_ms:.3}ms, level3(0,0) = {level3_ms:.3}ms");
}

#[test]
fn integer_reduce_matches_the_float_reduction() {
    let mut seed = 0x2545_F491_4F6C_DD1Du64;
    let mut rnd = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    for depth in [8u8, 16] {
        let d = Document::new(300, 300, depth).unwrap();
        let max = max_value(depth) as u64;
        for mask in [None, Some(max as u32 / 3)] {
            let len = if mask.is_some() { TILE_PIXELS } else { TILE_PIXELS * 4 };
            // Few distinct values, so equal-weight blocks and rounding ties are common.
            // `opaque` sets every alpha to the maximum, the equal-weight path of the pixel reduction.
            let mut tile = |opaque: bool| {
                let mut v: Vec<u16> = (0..len).map(|_| [0, 1, 2, max / 2, max - 1, max][(rnd() % 6) as usize] as u16).collect();
                if opaque && mask.is_none() {
                    v.iter_mut().skip(3).step_by(4).for_each(|a| *a = max as u16);
                }
                Arc::new(match (depth, mask.is_some()) {
                    (8, false) => Pixels::U8(v.iter().map(|x| *x as u8).collect()),
                    (8, true) => Pixels::Mask8(v.iter().map(|x| *x as u8).collect()),
                    (_, false) => Pixels::U16(v.into_boxed_slice()),
                    (_, true) => Pixels::Mask16(v.into_boxed_slice()),
                })
            };
            let kids = [Some((1, tile(false))), None, Some((3, tile(true))), Some((4, tile(false)))];
            let valid = [(TILE, TILE), (TILE, TILE), (TILE, 77), (133, 1)];
            let (a, b) = (d.reduce(&kids, &valid, mask).to_bytes(), d.reduce_f32(&kids, &valid, mask).to_bytes());
            let step = if depth == 8 { 1 } else { 2 };
            let (mut worst, mut differ) = (0i64, 0usize);
            for i in (0..a.len()).step_by(step) {
                let v = |x: &[u8]| if depth == 8 { x[i] as i64 } else { u16::from_le_bytes([x[i], x[i + 1]]) as i64 };
                let diff = (v(&a) - v(&b)).abs();
                worst = worst.max(diff);
                differ += (diff > 0) as usize;
            }
            assert!(worst <= 1, "depth {depth} mask {mask:?}: max difference {worst}");
            assert!(differ * 100 < a.len() / step, "depth {depth} mask {mask:?}: {differ} values differ");
        }
    }
}

// ---------- selection (M2.md section 3) ----------

fn sel(d: &Document, x: i32, y: i32) -> f32 {
    d.sel_at(d.selection.as_ref().expect("a selection"), x, y)
}

fn sel_mass(d: &Document) -> f64 {
    let mut m = 0.0;
    for y in 0..d.height as i32 {
        for x in 0..d.width as i32 {
            m += sel(d, x, y) as f64;
        }
    }
    m
}

#[test]
fn select_rect_is_hard_edged_and_exact_at_a_fractional_edge() {
    let mut d = Document::new(256, 256, 8).unwrap();
    assert!(!d.has_selection());
    d.select_rect(10.0, 20.0, 30.0, 40.0, Mode::New).unwrap();
    assert!(d.has_selection());
    assert_eq!(d.selection_bounds(), Some([10, 20, 30, 40]));
    assert_eq!(sel(&d, 10, 20), 1.0);
    assert_eq!(sel(&d, 9, 20), 0.0);
    assert_eq!(sel(&d, 39, 59), 1.0);
    assert_eq!(sel(&d, 40, 59), 0.0);
    d.select_rect(0.0, 0.0, 10.5, 4.0, Mode::New).unwrap();
    assert!((sel(&d, 10, 0) - 0.5).abs() <= 1.0 / 255.0);
    assert!((sel_mass(&d) - 42.0).abs() < 0.05, "10.5 x 4 pixels: {}", sel_mass(&d));
}

#[test]
fn boolean_modes_combine_two_rects() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let cases = [
        (Mode::Add, [0, 0, 150, 100], 15000.0),
        (Mode::Intersect, [50, 0, 50, 100], 5000.0),
        (Mode::Subtract, [0, 0, 50, 100], 5000.0),
        (Mode::New, [50, 0, 100, 100], 10000.0),
    ];
    for (mode, bounds, mass) in cases {
        d.select_rect(0.0, 0.0, 100.0, 100.0, Mode::New).unwrap();
        d.select_rect(50.0, 0.0, 100.0, 100.0, mode).unwrap();
        assert_eq!(d.selection_bounds(), Some(bounds), "{mode:?}");
        assert!((sel_mass(&d) - mass).abs() < 0.5, "{mode:?}: {}", sel_mass(&d));
    }
}

#[test]
fn ellipse_selection_covers_its_area_and_intersects() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.select_ellipse(28.0, 40.0, 200.0, 120.0, true, Mode::New).unwrap();
    let area = std::f64::consts::PI * 100.0 * 60.0;
    assert!((sel_mass(&d) - area).abs() < area * 5e-3, "{} vs {area}", sel_mass(&d));
    assert_eq!(d.selection_bounds(), Some([28, 40, 200, 120]));
    // The centre is at x = 128, so half the canvas cuts the ellipse in half.
    d.select_rect(0.0, 0.0, 128.0, 256.0, Mode::Intersect).unwrap();
    assert!((sel_mass(&d) - area / 2.0).abs() < area * 5e-3, "{}", sel_mass(&d));
    d.select_ellipse(28.0, 40.0, 200.0, 120.0, false, Mode::New).unwrap();
    for v in [sel(&d, 128, 100), sel(&d, 28, 40)] {
        assert!(v == 0.0 || v == 1.0, "centre sampling is binary: {v}");
    }
}

#[test]
fn polygon_selection_fills_even_odd_and_clips_to_the_canvas() {
    let mut d = Document::new(64, 64, 8).unwrap();
    d.select_polygon(&[-20.0, -20.0, 84.0, -20.0, 32.0, 40.0], true, Mode::New).unwrap();
    let b = d.selection_bounds().unwrap();
    assert!(b[0] >= 0 && b[1] >= 0 && b[0] + b[2] <= 64 && b[1] + b[3] <= 64, "{b:?}");
    assert_eq!(sel(&d, 32, 0), 1.0);
    assert_eq!(sel(&d, 32, 45), 0.0);
    assert!(d.select_polygon(&[0.0, 0.0, 1.0, 1.0], true, Mode::New).is_err());
    assert!(d.select_polygon(&[0.0, 0.0, 1.0], true, Mode::New).is_err());
}

#[test]
fn feather_keeps_the_mass_and_stays_symmetric() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.select_rect(64.0, 64.0, 128.0, 128.0, Mode::New).unwrap();
    let before = sel_mass(&d);
    assert!(d.feather_selection(0.0).is_err());
    d.feather_selection(12.0).unwrap();
    let after = sel_mass(&d);
    assert!((after - before).abs() < before * 5e-3, "{before} -> {after}");
    for k in 0..24 {
        let (l, r) = (sel(&d, 52 + k, 128), sel(&d, 203 - k, 128));
        assert!((l - r).abs() <= 1.0 / 255.0, "k {k}: {l} vs {r}");
    }
    assert!((sel(&d, 63, 128) + sel(&d, 64, 128) - 1.0).abs() < 0.02, "the edge fades through 0.5");
    assert!(sel(&d, 128, 128) > 0.99);
    assert_eq!(sel(&d, 40, 128), 0.0, "beyond the radius nothing changes");
    // The edge spreads by about the radius; the outermost ring quantizes to 0.
    let b = d.selection_bounds().unwrap();
    assert!((52..=54).contains(&b[0]) && (52..=54).contains(&b[1]), "{b:?}");
    assert_eq!([b[0] + b[2], b[1] + b[3]], [256 - b[0], 256 - b[1]], "symmetric growth: {b:?}");
}

#[test]
fn select_all_invert_deselect_and_reselect() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.select_all().unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 256, 256]));
    d.select_rect(0.0, 0.0, 100.0, 256.0, Mode::New).unwrap();
    d.invert_selection().unwrap();
    assert_eq!(d.selection_bounds(), Some([100, 0, 156, 256]));
    assert_eq!(sel(&d, 0, 0), 0.0);
    assert_eq!(sel(&d, 100, 0), 1.0);
    d.deselect().unwrap();
    assert!(!d.has_selection());
    assert_eq!(d.selection_bounds(), None);
    d.reselect().unwrap();
    assert_eq!(d.selection_bounds(), Some([100, 0, 156, 256]));
    let mut e = Document::new(64, 64, 8).unwrap();
    assert!(e.reselect().is_err());
    e.invert_selection().unwrap();
    assert_eq!(e.selection_bounds(), Some([0, 0, 64, 64]), "nothing selected inverts to everything");
}

#[test]
fn fill_and_clear_honour_a_partial_selection() {
    let mut d = doc_bg(255, 255, 255);
    d.select_rect(0.0, 0.0, 10.5, 256.0, Mode::New).unwrap();
    d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
    near(at(&d, 0, 0), [255, 0, 0, 255]);
    near(at(&d, 10, 0), [255, 128, 128, 255]);
    near(at(&d, 11, 0), [255, 255, 255, 255]);
    d.clear(1, Target::Pixels).unwrap();
    assert_eq!(at(&d, 0, 0)[3], 0);
    let half = at(&d, 10, 0);
    assert!((half[3] as i32 - 127).abs() <= 1, "half coverage keeps half the alpha: {half:?}");
    near(at(&d, 11, 0), [255, 255, 255, 255]);
}

#[test]
fn invert_pixels_only_inside_the_selection() {
    let mut d = doc_bg(255, 0, 0);
    d.select_rect(0.0, 0.0, 128.0, 256.0, Mode::New).unwrap();
    d.invert(1, Target::Pixels).unwrap();
    near(at(&d, 10, 10), [0, 255, 255, 255]);
    near(at(&d, 200, 10), [255, 0, 0, 255]);
}

#[test]
fn mask_edits_inside_a_selection_keep_the_default() {
    let mut d = doc_bg(255, 255, 255);
    let top = d.add_layer("top", 1).unwrap();
    d.fill(top, Target::Pixels, 255, 0, 0, 255).unwrap();
    d.add_mask(top, true).unwrap();
    d.select_rect(0.0, 0.0, 128.0, 256.0, Mode::New).unwrap();
    d.clear(top, Target::Mask).unwrap();
    assert_eq!(d.node(top).unwrap().mask.as_ref().unwrap().default, 255);
    near(at(&d, 10, 10), [255, 255, 255, 255]);
    near(at(&d, 200, 10), [255, 0, 0, 255]);
    d.invert(top, Target::Mask).unwrap();
    assert_eq!(d.node(top).unwrap().mask.as_ref().unwrap().default, 255, "only the selection flips");
    near(at(&d, 10, 10), [255, 0, 0, 255]);
}

#[test]
fn an_empty_selection_stops_every_edit() {
    let mut d = doc_bg(255, 255, 255);
    d.select_rect(0.0, 0.0, 10.0, 10.0, Mode::New).unwrap();
    d.select_rect(100.0, 100.0, 10.0, 10.0, Mode::Intersect).unwrap();
    assert!(d.has_selection());
    assert_eq!(d.selection_bounds(), None);
    d.fill(1, Target::Pixels, 0, 0, 0, 255).unwrap();
    d.clear(1, Target::Pixels).unwrap();
    near(at(&d, 0, 0), [255, 255, 255, 255]);
}

#[test]
fn snapshot_restores_the_selection() {
    let mut e = EngineCore::new(Document::new(256, 256, 8).unwrap());
    e.doc.select_rect(10.0, 10.0, 50.0, 50.0, Mode::New).unwrap();
    let snap = e.snapshot();
    e.doc.deselect().unwrap();
    assert!(!e.doc.has_selection());
    e.restore(snap).unwrap();
    assert_eq!(e.doc.selection_bounds(), Some([10, 10, 50, 50]));
}

#[test]
fn selection_tile_reports_coverage_per_level() {
    let mut d = Document::new(512, 512, 8).unwrap();
    assert_eq!(d.selection_tile(0, 0, 0).unwrap(), None, "no selection, no overlay");
    d.select_rect(0.0, 0.0, 256.0, 256.0, Mode::New).unwrap();
    let t = d.selection_tile(0, 0, 0).unwrap().unwrap();
    assert_eq!(t.len(), MASK_BYTES_U8);
    assert!(t.iter().all(|v| *v == 255));
    assert_eq!(d.selection_tile(0, 1, 0).unwrap(), None, "an unselected tile is the default");
    let l1 = d.selection_tile(1, 0, 0).unwrap().unwrap();
    assert_eq!(l1[0], 255);
    assert_eq!(l1[200], 0);
    d.select_all().unwrap();
    assert_eq!(d.selection_tile(0, 0, 0).unwrap(), None, "select all needs no tile");
    assert!(d.selection_tile(9, 0, 0).is_err());
}

#[test]
fn channels_save_load_and_delete() {
    let mut d = Document::new(256, 256, 8).unwrap();
    assert!(d.save_selection("none").is_err());
    d.select_rect(0.0, 0.0, 100.0, 100.0, Mode::New).unwrap();
    let ch = d.save_selection("left").unwrap();
    d.select_rect(50.0, 50.0, 100.0, 100.0, Mode::New).unwrap();
    d.load_selection(ch, false, Mode::Intersect).unwrap();
    assert_eq!(d.selection_bounds(), Some([50, 50, 50, 50]));
    d.load_selection(ch, true, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 256, 256]));
    assert_eq!(sel(&d, 10, 10), 0.0);
    assert_eq!(sel(&d, 200, 200), 1.0);
    let v: Value = serde_json::from_str(&d.channels_json()).unwrap();
    assert_eq!(v["channels"][0]["name"], "left");
    assert_eq!(v["channels"][0]["id"].as_u64().unwrap() as u32, ch);
    assert_eq!(v["selection"]["default"].as_u64().unwrap(), 255);
    d.delete_channel(ch).unwrap();
    assert!(d.delete_channel(ch).is_err());
    assert!(d.load_selection(ch, false, Mode::New).is_err());
}

#[test]
fn combine_into_channel_unions_the_selection_into_a_saved_channel() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.select_rect(0.0, 0.0, 50.0, 50.0, Mode::New).unwrap();
    let ch = d.save_selection("a").unwrap();
    d.select_rect(100.0, 100.0, 50.0, 50.0, Mode::New).unwrap();
    d.combine_into_channel(ch, Mode::Add).unwrap();
    d.select_rect(0.0, 0.0, 1.0, 1.0, Mode::New).unwrap();
    d.load_selection(ch, false, Mode::New).unwrap();
    assert_eq!(d.selection_bounds(), Some([0, 0, 150, 150]), "both rects joined into the channel");
    assert!(d.combine_into_channel(999, Mode::Add).is_err());
}

// ---------- layer bounds (M2.md section 5) ----------

#[test]
fn offset_layer_keeps_pixels_outside_the_canvas() {
    let mut d = Document::new(256, 256, 8).unwrap();
    let mut data = vec![0u8; TILE_BYTES_U8];
    for y in 0..TILE {
        for x in 0..TILE {
            let o = (y * TILE + x) * 4;
            data[o..o + 4].copy_from_slice(&[(x % 251) as u8, (y % 253) as u8, 7, 255]);
        }
    }
    d.set_tile_rgba8(1, 0, 0, &data).unwrap();
    d.add_mask(1, false).unwrap();
    d.set_mask_tile8(1, 0, 0, &mask_pattern(3, 0, 0)).unwrap();
    let before = d.flatten_tile_rgba8(0, 0).unwrap();
    let mask_before = d.node(1).unwrap().mask.as_ref().unwrap().tiles.get(0, 0).unwrap().px.to_bytes();
    assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 256, 256]));
    d.offset_layer(1, 300, 20).unwrap();
    assert_eq!(d.display_tile(0, 0, 0).unwrap(), None, "the pixels moved off the canvas");
    assert_eq!(d.layer_bounds(1).unwrap(), Some([300, 20, 256, 256]));
    d.offset_layer(1, -300, -20).unwrap();
    assert_eq!(d.flatten_tile_rgba8(0, 0).unwrap(), before, "moving back restores the pixels");
    assert_eq!(d.layer_bounds(1).unwrap(), Some([0, 0, 256, 256]));
    let mask_after = d.node(1).unwrap().mask.as_ref().unwrap().tiles.get(0, 0).unwrap().px.to_bytes();
    assert_eq!(mask_after, mask_before, "the mask travels with the pixels");
    d.offset_layer(1, 0, 0).unwrap();
    set(&mut d, 1, r#"{"locks":{"position":true}}"#);
    assert_eq!(d.offset_layer(1, 1, 0).unwrap_err(), "layer position is locked");
}

#[test]
fn a_filled_mask_keeps_its_value_where_offset_layer_shifts_in_new_area() {
    let mut d = Document::new(512, 256, 8).unwrap();
    d.add_mask(1, true).unwrap();
    d.fill(1, Target::Mask, 0, 0, 0, 255).unwrap();
    d.offset_layer(1, 100, 0).unwrap();
    let m = d.node(1).unwrap().mask.as_ref().unwrap();
    let at = |tx, ty| m.tiles.get(tx, ty).map_or(vec![m.default as u8; MASK_BYTES_U8], |t| t.px.to_bytes());
    assert!(at(0, 0).iter().all(|&v| v == 0), "the shifted-in column stays hidden");
}

#[test]
fn offset_layer_moves_every_pixel_and_mask_value_unchanged() {
    // Raw stored values per pixel; a missing tile reads as transparent or the mask default.
    fn read(t: &Tiles, cache: &mut std::collections::HashMap<(i32, i32), Vec<u8>>, empty: &[u8], x: i32, y: i32) -> Vec<u8> {
        let k = (x.div_euclid(TILE as i32), y.div_euclid(TILE as i32));
        let b = cache.entry(k).or_insert_with(|| t.get(k.0, k.1).map_or(Vec::new(), |t| t.px.to_bytes()));
        if b.is_empty() {
            return empty.to_vec();
        }
        let (n, p) = (empty.len(), (y.rem_euclid(TILE as i32) * TILE as i32 + x.rem_euclid(TILE as i32)) as usize);
        b[p * n..(p + 1) * n].to_vec()
    }
    for depth in [8u8, 16] {
        for (dx, dy) in [(37, -91), (-300, 5), (256, 0), (1, 255)] {
            let mut d = Document::new(512, 512, depth).unwrap();
            for (tx, ty) in [(0u32, 0u32), (1, 0), (1, 1)] {
                let mut data = vec![0u8; TILE_BYTES_U8];
                for p in 0..TILE_PIXELS {
                    let (x, y) = (tx as usize * TILE + p % TILE, ty as usize * TILE + p / TILE);
                    data[p * 4..p * 4 + 4].copy_from_slice(&[(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8, ((x * 7 + y) % 256) as u8]);
                }
                d.set_tile_rgba8(1, tx, ty, &data).unwrap();
            }
            d.add_mask(1, true).unwrap();
            d.set_mask_tile8(1, 1, 0, &mask_pattern(5, 1, 0)).unwrap();
            let n = d.node(1).unwrap();
            let (src, msrc, mdef) = (n.pixel_tiles().unwrap().clone(), n.mask.as_ref().unwrap().tiles.clone(), n.mask.as_ref().unwrap().default);
            d.offset_layer(1, dx, dy).unwrap();
            let n = d.node(1).unwrap();
            let (dst, mdst) = (n.pixel_tiles().unwrap(), &n.mask.as_ref().unwrap().tiles);
            let w = if depth == 8 { 1 } else { 2 };
            let (rgba0, m0) = (vec![0u8; 4 * w], if depth == 8 { vec![mdef as u8] } else { (mdef as u16).to_le_bytes().to_vec() });
            let (mut c, mut mc, mut dc, mut mdc) = Default::default();
            for y in -300..900 {
                for x in -300..900 {
                    assert_eq!(read(dst, &mut dc, &rgba0, x, y), read(&src, &mut c, &rgba0, x - dx, y - dy), "pixel {x},{y} depth {depth} offset {dx},{dy}");
                    assert_eq!(read(mdst, &mut mdc, &m0, x, y), read(&msrc, &mut mc, &m0, x - dx, y - dy), "mask {x},{y} depth {depth} offset {dx},{dy}");
                }
            }
        }
    }
}

#[test]
fn offset_layer_refuses_offsets_the_manifest_cannot_store() {
    let mut d = Document::new(256, 256, 8).unwrap();
    d.set_tile_rgba8(1, 0, 0, &vec![255u8; TILE_BYTES_U8]).unwrap();
    assert!(d.offset_layer(1, i32::MAX, 0).is_err());
    assert!(d.offset_layer(1, 0, -((MAX_TILE_COORD as i32 + 1) * TILE as i32)).is_err());
    d.offset_layer(1, (MAX_TILE_COORD as i32 - 1) * TILE as i32, 0).unwrap();
    assert!(Document::from_manifest(&d.manifest()).is_ok(), "a stored offset reopens");
}

#[test]
fn layer_bounds_are_tight_and_empty_layers_have_none() {
    let mut d = Document::new(512, 512, 8).unwrap();
    assert_eq!(d.layer_bounds(1).unwrap(), None);
    let mut data = vec![0u8; TILE_BYTES_U8];
    let o = (5 * TILE + 7) * 4;
    data[o..o + 4].copy_from_slice(&[1, 2, 3, 255]);
    d.set_tile_rgba8(1, 1, 1, &data).unwrap();
    assert_eq!(d.layer_bounds(1).unwrap(), Some([256 + 7, 256 + 5, 1, 1]));
    let g = d.add_group("g", 0).unwrap();
    assert!(d.layer_bounds(g).is_err());
}

#[test]
fn layer_bounds_match_a_full_scan_for_random_tile_layouts() {
    let mut s = 12345u32;
    let mut r = |n: u32| {
        s = s.wrapping_mul(1103515245).wrapping_add(12345);
        (s >> 8) % n
    };
    for trial in 0..60 {
        let depth = if trial % 2 == 0 { 8 } else { 16 };
        let mut d = Document::new(1280, 1024, depth).unwrap();
        let mut bb: Option<(i32, i32, i32, i32)> = None;
        for ty in 0..4 {
            for tx in 0..5 {
                let kind = r(4);
                if kind == 0 {
                    continue;
                }
                let mut data = vec![0u8; TILE_BYTES_U8];
                let mut set = |p: usize| {
                    data[p * 4..p * 4 + 4].copy_from_slice(&[9, 9, 9, 1 + (p % 255) as u8]);
                    let (x, y) = ((tx * TILE + p % TILE) as i32, (ty * TILE + p / TILE) as i32);
                    bb = Some(bb.map_or((x, y, x + 1, y + 1), |b| (b.0.min(x), b.1.min(y), b.2.max(x + 1), b.3.max(y + 1))));
                };
                match kind {
                    1 => (0..TILE_PIXELS).for_each(&mut set),
                    2 => (0..1 + r(4)).for_each(|_| set(r(TILE_PIXELS as u32) as usize)),
                    _ => {} // a stored tile with no visible pixel
                }
                d.set_tile_rgba8(1, tx as u32, ty as u32, &data).unwrap();
            }
        }
        let (dx, dy) = (r(700) as i32 - 350, r(700) as i32 - 350);
        d.offset_layer(1, dx, dy).unwrap();
        let want = bb.map(|b| [b.0 + dx, b.1 + dy, b.2 - b.0, b.3 - b.1]);
        assert_eq!(d.layer_bounds(1).unwrap(), want, "trial {trial}");
    }
}

// ---------- manifest v3 ----------

#[test]
fn v3_round_trip_keeps_selection_channels_and_offset_tiles() {
    let mut d = rich_doc();
    d.select_rect(20.0, 30.0, 100.0, 40.0, Mode::New).unwrap();
    let ch = d.save_selection("saved").unwrap();
    d.deselect().unwrap();
    d.select_ellipse(0.0, 0.0, 200.0, 100.0, true, Mode::New).unwrap();
    d.offset_layer(1, -300, -40).unwrap();
    let m = manifest_value(&d);
    assert_eq!(m["version"].as_u64().unwrap(), 6);
    assert!(
        m["layers"][0]["tiles"].as_array().unwrap().iter().any(|e| e[0].as_i64().unwrap() < 0),
        "a tile outside the canvas is stored"
    );
    assert_eq!(m["channels"][0]["name"], "saved");
    assert_eq!(m["channels"][0]["id"].as_u64().unwrap() as u32, ch);
    assert!(!m["last_selection"].is_null());
    let l = loaded_copy(&d);
    assert_eq!(l.selection_bounds(), d.selection_bounds());
    assert_eq!(l.channels.len(), 1);
    assert!(l.last_selection.is_some());
    assert_eq!(l.layer_bounds(1).unwrap(), d.layer_bounds(1).unwrap());
    for ty in 0..d.tiles_y() {
        for tx in 0..d.tiles_x() {
            assert_eq!(l.display_tile(0, tx, ty).unwrap(), d.display_tile(0, tx, ty).unwrap());
        }
    }
    for (x, y) in [(10, 10), (100, 60), (250, 200)] {
        assert_eq!(sel(&l, x, y), sel(&d, x, y), "selection at ({x}, {y})");
    }
}

#[test]
fn v2_manifest_still_loads() {
    let mut old = Document::new(512, 256, 8).unwrap();
    old.fill(1, Target::Pixels, 7, 8, 9, 255).unwrap();
    let id = tile_id(&manifest_value(&old)["layers"][0]["tiles"], 1, 0);
    let v2 = format!(
        r#"{{"format":"photobaer-manifest","version":2,"width":512,"height":256,"depth":8,"tiles_x":2,"tiles_y":1,"next_id":{},"next_node_id":2,"layers":[{{"id":1,"name":"bg","kind":"pixel","visible":true,"opacity":1.0,"fill":1.0,"blend":"normal","clipping":false,"locks":{{"transparency":false,"pixels":false,"position":false}},"mask":{{"enabled":true,"default":255,"tiles":[0,0]}},"tiles":[0,{id}]}}]}}"#,
        id + 1
    );
    let mut d = Document::from_manifest(&v2).unwrap();
    d.put_tile(id, &old.tile_bytes(id).unwrap()).unwrap();
    d.finish_load().unwrap();
    assert_eq!(at(&d, 0, 0)[3], 0, "the empty dense slot stays empty");
    assert_eq!(d.flatten_tile_rgba8(1, 0).unwrap()[0..4], [7, 8, 9, 255]);
    let m = manifest_value(&d);
    assert_eq!(m["version"].as_u64().unwrap(), 6);
    assert_eq!(tile_id(&m["layers"][0]["tiles"], 1, 0), id, "dense slot 1 became tile (1, 0)");
    assert!(m["selection"].is_null());
    assert!(m["last_selection"].is_null());
    assert!(m["channels"].as_array().unwrap().is_empty());
    assert!(d.node(1).unwrap().mask.is_some());
}

#[test]
fn v3_selection_and_channel_rejections() {
    let base = || {
        let mut d = Document::new(300, 300, 8).unwrap();
        d.fill(1, Target::Pixels, 1, 2, 3, 255).unwrap();
        d.select_rect(0.0, 0.0, 50.0, 50.0, Mode::New).unwrap();
        d.save_selection("c").unwrap();
        d
    };
    assert!(Document::from_manifest(&base().manifest()).is_ok());
    let broken3 = |f: &dyn Fn(&mut Value)| {
        let mut v = manifest_value(&base());
        f(&mut v);
        v.to_string()
    };
    let cases: Vec<(&str, String)> = vec![
        ("selection tile outside the canvas", broken3(&|v| v["selection"]["tiles"] = serde_json::json!([[9, 0, 5]]))),
        ("negative selection tile", broken3(&|v| v["selection"]["tiles"] = serde_json::json!([[-1, 0, 5]]))),
        ("selection tile id 0", broken3(&|v| v["selection"]["tiles"] = serde_json::json!([[0, 0, 0]]))),
        ("duplicate selection coordinate", broken3(&|v| v["selection"]["tiles"] = serde_json::json!([[0, 0, 5], [0, 0, 6]]))),
        ("selection default out of range", broken3(&|v| v["selection"]["default"] = 300.into())),
        ("unknown field in the selection", broken3(&|v| v["selection"]["extra"] = 1.into())),
        ("channel id 0", broken3(&|v| v["channels"][0]["id"] = 0.into())),
        ("duplicate channel id", broken3(&|v| {
            let c = v["channels"][0].clone();
            v["channels"].as_array_mut().unwrap().push(c);
        })),
        ("channel tile outside the canvas", broken3(&|v| v["channels"][0]["tiles"] = serde_json::json!([[0, 7, 5]]))),
    ];
    for (what, json) in cases {
        assert!(Document::from_manifest(&json).is_err(), "{what} must be rejected");
    }
}

#[path = "doc_tests_more.rs"]
mod more;

fn tiles_bytes(t: &Tiles) -> Vec<((i32, i32), Vec<u8>)> {
    t.coords().into_iter().map(|(x, y)| ((x, y), t.get(x, y).unwrap().px.to_bytes())).collect()
}

fn soft_selection_doc(depth: u8) -> Document {
    let mut d = Document::new(512, 512, depth).unwrap();
    for (tx, ty) in [(0u32, 0u32), (1, 0), (0, 1), (1, 1)] {
        let mut data = vec![0u8; TILE_BYTES_U8];
        for p in 0..TILE_PIXELS {
            let (x, y) = (tx as usize * TILE + p % TILE, ty as usize * TILE + p / TILE);
            data[p * 4..p * 4 + 4].copy_from_slice(&[(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8, ((x * 3 + y * 5) % 256) as u8]);
        }
        d.set_tile_rgba8(1, tx, ty, &data).unwrap();
    }
    d.select_ellipse(130.5, 90.25, 300.0, 210.0, true, Mode::New).unwrap();
    d
}

#[test]
fn a_whole_pixel_selected_move_matches_the_resampled_move() {
    let nearest = crate::resample::Interp::Nearest;
    for depth in [8u8, 16] {
        for (dx, dy, copy) in [(37.0, -91.0, false), (-300.0, 5.0, true), (256.0, 0.0, false), (1.0, 330.0, false)] {
            let (mut a, mut b) = (soft_selection_doc(depth), soft_selection_doc(depth));
            a.transform_selected_pixels(1, &[1.0, 0.0, dx, 0.0, 1.0, dy, 0.0, 0.0, 1.0], nearest, None, copy).unwrap();
            // A fraction of a pixel takes the resampling path but samples the same source pixels.
            b.transform_selected_pixels(1, &[1.0, 0.0, dx + 1e-9, 0.0, 1.0, dy, 0.0, 0.0, 1.0], nearest, None, copy).unwrap();
            let at = format!("depth {depth} offset {dx},{dy} copy {copy}");
            assert_eq!(tiles_bytes(a.node(1).unwrap().pixel_tiles().unwrap()), tiles_bytes(b.node(1).unwrap().pixel_tiles().unwrap()), "pixels, {at}");
            assert_eq!(tiles_bytes(&a.selection.as_ref().unwrap().tiles), tiles_bytes(&b.selection.as_ref().unwrap().tiles), "selection, {at}");
        }
    }
}

#[test]
fn move_selected_pixels_reuses_its_lift_only_for_the_same_content() {
    let expect = |f: &dyn Fn(&mut Document), dx: f64, dy: f64| {
        let mut d = soft_selection_doc(8);
        f(&mut d);
        d.transform_selected_pixels(1, &[1.0, 0.0, dx, 0.0, 1.0, dy, 0.0, 0.0, 1.0], crate::resample::Interp::Nearest, None, false).unwrap();
        (tiles_bytes(d.node(1).unwrap().pixel_tiles().unwrap()), tiles_bytes(&d.selection.as_ref().unwrap().tiles))
    };
    let got = |e: &EngineCore| (tiles_bytes(e.doc.node(1).unwrap().pixel_tiles().unwrap()), tiles_bytes(&e.doc.selection.as_ref().unwrap().tiles));
    let mut e = EngineCore::new(soft_selection_doc(8));
    let base = e.snapshot();
    e.move_selected_pixels(1, 5, 3, false).unwrap();
    e.restore(base).unwrap();
    e.move_selected_pixels(1, 40, 7, false).unwrap();
    assert!(got(&e) == expect(&|_| {}, 40.0, 7.0), "a second step from the same base");
    e.restore(base).unwrap();
    e.doc.fill(1, Target::Pixels, 10, 20, 30, 255).unwrap();
    e.move_selected_pixels(1, 40, 7, false).unwrap();
    assert!(got(&e) == expect(&|d| d.fill(1, Target::Pixels, 10, 20, 30, 255).unwrap(), 40.0, 7.0), "changed pixels lift again");
}
