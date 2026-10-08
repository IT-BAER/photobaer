//! Layer > Matting: the pure region functions and the document wrappers.

use super::matting::*;
use super::*;

const RED: [f32; 4] = [1.0, 0.0, 0.0, 1.0];
const BLUE: [f32; 4] = [0.0, 0.0, 1.0, 1.0];

fn near(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-5)
}

#[test]
fn remove_black_matte_divides_by_alpha() {
    let mut px = vec![[0.25, 0.5, 0.1, 0.5], [0.3, 0.0, 0.0, 1.0], [0.3, 0.2, 0.1, 0.0], [0.4, 0.1, 0.05, 0.25]];
    remove_matte(&mut px, false);
    assert!(near(px[0], [0.5, 1.0, 0.2, 0.5]));
    assert!(near(px[1], [0.3, 0.0, 0.0, 1.0]), "opaque pixels stay");
    assert!(near(px[2], [0.3, 0.2, 0.1, 0.0]), "clear pixels stay");
    assert!(near(px[3], [1.0, 0.4, 0.2, 0.25]), "clamped to 1");
}

#[test]
fn remove_white_matte_subtracts_the_white_share() {
    let mut px = vec![[0.75, 0.5, 0.6, 0.5], [0.9, 0.8, 0.76, 0.2]];
    remove_matte(&mut px, true);
    assert!(near(px[0], [0.5, 0.0, 0.2, 0.5]));
    assert!(near(px[1], [0.5, 0.0, 0.0, 0.2]), "(0.76 - 0.8) / 0.2 clamps to 0");
}

// One row: x 0 clear, x 1 green at half alpha, x 2 red, x 3 white, x 4.. blue.
fn row() -> Vec<[f32; 4]> {
    let mut px = vec![BLUE; 9];
    px[0] = [0.0; 4];
    px[1] = [0.0, 1.0, 0.0, 0.5];
    px[2] = RED;
    px[3] = [1.0; 4];
    px
}

#[test]
fn defringe_width_1_recolors_only_the_edge_pixel() {
    let mut px = row();
    defringe(&mut px, 9, 1, 1);
    assert!(near(px[1], [1.0, 0.0, 0.0, 0.5]), "takes red from inside, keeps alpha: {:?}", px[1]);
    assert!(near(px[2], RED));
    assert!(near(px[3], [1.0; 4]));
    assert_eq!(px[0], [0.0; 4]);
}

#[test]
fn defringe_width_3_grows_the_core_color_outward() {
    let mut px = row();
    defringe(&mut px, 9, 1, 3);
    assert!(near(px[1], [0.0, 0.0, 1.0, 0.5]));
    assert!(near(px[2], BLUE));
    assert!(near(px[3], BLUE));
    assert_eq!(px[0], [0.0; 4]);
}

#[test]
fn defringe_without_clear_pixels_changes_nothing() {
    let mut px = row();
    px[0] = RED;
    let before = px.clone();
    defringe(&mut px, 9, 1, 3);
    assert_eq!(px, before);
}

// One row: mask 1 at x 0..2 (red), partial at x 2..5 (green), 0 at x 5.
fn masked_row() -> (Vec<[f32; 4]>, Vec<f32>) {
    let mut px = vec![RED; 6];
    (2..6).for_each(|x| px[x] = [0.0, 1.0, 0.0, 1.0]);
    (px, vec![1.0, 1.0, 0.5, 0.25, 0.1, 0.0])
}

#[test]
fn decontaminate_amount_0_changes_nothing_and_100_takes_the_core_color() {
    let (mut px, mask) = masked_row();
    let before = px.clone();
    decontaminate(&mut px, &mask, 6, 1, 0.0);
    assert_eq!(px, before);
    decontaminate(&mut px, &mask, 6, 1, 1.0);
    for x in 2..5 {
        assert!(near(px[x], RED), "x {x}: {:?}", px[x]);
    }
    assert!(near(px[5], before[5]), "a hidden pixel stays");
}

#[test]
fn decontaminate_half_amount_mixes() {
    let (mut px, mask) = masked_row();
    decontaminate(&mut px, &mask, 6, 1, 0.5);
    assert!(near(px[3], [0.5, 0.5, 0.0, 1.0]));
}

// Layer 1 of a 20x10 doc: x 0 clear, x 1 green at alpha 128/255, x 2..20 red.
fn doc(depth: u8) -> Document {
    let mut d = Document::new(20, 10, depth).unwrap();
    let mut buf = vec![0u8; TILE_BYTES_U8];
    for p in 0..TILE_PIXELS {
        let (x, y) = (p % TILE, p / TILE);
        if y < 10 && (1..20).contains(&x) {
            buf[p * 4..p * 4 + 4].copy_from_slice(&if x == 1 { [0, 255, 0, 128] } else { [255, 0, 0, 255] });
        }
    }
    d.set_tile_rgba8(1, 0, 0, &buf).unwrap();
    d
}

fn px_at(d: &Document, x: usize, y: usize) -> [f32; 4] {
    d.node(1).unwrap().pixel_tiles().unwrap().get(0, 0).map_or([0.0; 4], |t| t.px.rgba_f32(y * TILE + x))
}

fn close(a: [f32; 4], b: [f32; 4]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1.0 / 250.0)
}

#[test]
fn doc_defringe_and_remove_matte_at_8_and_16_bit() {
    let half = 128.0 / 255.0;
    for depth in [8, 16] {
        let mut d = doc(depth);
        d.defringe(1, 1).unwrap();
        assert!(close(px_at(&d, 1, 5), [1.0, 0.0, 0.0, half]), "depth {depth}: {:?}", px_at(&d, 1, 5));
        assert!(close(px_at(&d, 5, 5), RED));

        let mut d = doc(depth);
        d.remove_matte(1, true).unwrap();
        assert!(close(px_at(&d, 1, 5), [0.0, 1.0, 0.0, half]), "white matte keeps a saturated green");
        let mut d = doc(depth);
        d.remove_matte(1, false).unwrap();
        assert!(close(px_at(&d, 1, 5), [0.0, 1.0, 0.0, half]));
    }
}

#[test]
fn doc_matting_respects_the_selection() {
    let mut d = doc(8);
    d.select_rect(0.0, 0.0, 20.0, 5.0, Mode::New).unwrap();
    d.defringe(1, 1).unwrap();
    assert!(close(px_at(&d, 1, 2), [1.0, 0.0, 0.0, 128.0 / 255.0]));
    assert!(close(px_at(&d, 1, 7), [0.0, 1.0, 0.0, 128.0 / 255.0]), "outside the selection stays");
}

#[test]
fn doc_decontaminate_needs_a_mask_and_moves_partial_pixels() {
    for depth in [8, 16] {
        let mut d = doc(depth);
        assert!(d.color_decontaminate(1, 1.0).unwrap_err().contains("mask"));
        d.add_mask(1, true).unwrap();
        let mut m = vec![255u8; TILE_PIXELS];
        (0..TILE).for_each(|y| m[y * TILE + 10] = 128);
        d.set_mask_tile8(1, 0, 0, &m).unwrap();
        // Column 10 partial: make it green so the change is visible.
        let mut buf = vec![0u8; TILE_BYTES_U8];
        for p in 0..TILE_PIXELS {
            let (x, y) = (p % TILE, p / TILE);
            if y < 10 && (1..20).contains(&x) {
                buf[p * 4..p * 4 + 4].copy_from_slice(&if x == 10 { [0, 255, 0, 255] } else { [255, 0, 0, 255] });
            }
        }
        d.set_tile_rgba8(1, 0, 0, &buf).unwrap();
        d.color_decontaminate(1, 0.0).unwrap();
        assert!(close(px_at(&d, 10, 5), [0.0, 1.0, 0.0, 1.0]), "amount 0");
        d.color_decontaminate(1, 1.0).unwrap();
        assert!(close(px_at(&d, 10, 5), RED), "depth {depth}: {:?}", px_at(&d, 10, 5));
        assert!(close(px_at(&d, 12, 5), RED));
    }
}

#[test]
fn doc_matting_refuses_locked_pixels_bad_values_and_non_pixel_layers() {
    let mut d = doc(8);
    d.set_props(1, r#"{"locks":{"transparency":false,"pixels":true,"position":false}}"#).unwrap();
    assert!(d.defringe(1, 1).unwrap_err().contains("locked"));
    assert!(d.remove_matte(1, false).unwrap_err().contains("locked"));
    d.add_mask(1, true).unwrap();
    assert!(d.color_decontaminate(1, 1.0).unwrap_err().contains("locked"));
    let mut d = doc(8);
    assert!(d.defringe(1, 0).is_err());
    assert!(d.defringe(1, 201).is_err());
    d.add_mask(1, true).unwrap();
    assert!(d.color_decontaminate(1, 1.5).is_err());
    let g = d.add_group("G", 1).unwrap();
    assert!(d.remove_matte(g, true).unwrap_err().contains("pixel layer"));
}
