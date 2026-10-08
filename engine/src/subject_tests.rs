use super::maxflow::Graph;
use super::select_subject;

// Deterministic noise in -amp..=amp per channel.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self, amp: i32) -> i32 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((self.0 >> 33) % (2 * amp as u64 + 1)) as i32 - amp
    }
}

// A plain noisy background with a disc of another colour; returns the image and the disc mask.
fn disc_image(w: u32, h: u32, cx: f32, cy: f32, r: f32, bg: [u8; 3], fg: [u8; 3], amp: i32) -> (Vec<u8>, Vec<bool>) {
    let mut rng = Lcg(7);
    let (mut px, mut inside) = (Vec::with_capacity((w * h * 4) as usize), Vec::with_capacity((w * h) as usize));
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            let i = dx * dx + dy * dy <= r * r;
            let c = if i { fg } else { bg };
            for v in c {
                px.push((v as i32 + rng.next(amp)).clamp(0, 255) as u8);
            }
            px.push(255);
            inside.push(i);
        }
    }
    (px, inside)
}

fn iou(mask: &[f32], truth: &[bool]) -> f64 {
    let (mut and, mut or) = (0usize, 0usize);
    for (m, &t) in mask.iter().zip(truth) {
        let s = *m >= 0.5;
        and += (s && t) as usize;
        or += (s || t) as usize;
    }
    and as f64 / or.max(1) as f64
}

#[test]
fn off_centre_disc_on_a_noisy_background_is_selected() {
    let (w, h) = (400, 300);
    let (px, truth) = disc_image(w, h, 270.0, 120.0, 60.0, [120, 140, 110], [200, 60, 50], 8);
    let mask = select_subject(&px, w, h).expect("a subject");
    assert_eq!(mask.len(), (w * h) as usize);
    let v = iou(&mask, &truth);
    println!("IoU {v:.4}");
    assert!(v >= 0.9, "IoU {v}");
}

#[test]
fn a_disc_of_similar_luma_is_still_selected() {
    let (w, h) = (320, 240);
    let (px, truth) = disc_image(w, h, 110.0, 140.0, 45.0, [90, 130, 160], [160, 120, 80], 6);
    let v = iou(&select_subject(&px, w, h).expect("a subject"), &truth);
    println!("IoU {v:.4}");
    assert!(v >= 0.9, "IoU {v}");
}

#[test]
fn a_subject_touching_one_border_is_still_selected() {
    let (w, h) = (400, 300);
    let (px, truth) = disc_image(w, h, 380.0, 150.0, 75.0, [200, 200, 190], [40, 70, 150], 8);
    let mask = select_subject(&px, w, h).expect("a subject");
    let v = iou(&mask, &truth);
    println!("IoU {v:.4}");
    assert!(v >= 0.9, "IoU {v}");
    // The disc's pixels on the right edge stay selected.
    assert!(mask[(150 * w + w - 1) as usize] >= 0.5);
}

#[test]
fn a_flat_image_has_no_subject() {
    let (px, _) = disc_image(300, 200, 0.0, 0.0, 0.0, [128, 128, 128], [0, 0, 0], 3);
    assert!(select_subject(&px, 300, 200).is_none());
    assert!(select_subject(&vec![0u8; 300 * 200 * 4], 300, 200).is_none(), "an empty layer");
    assert!(select_subject(&[], 0, 0).is_none());
}

#[test]
fn a_tiny_image_does_not_panic() {
    let (px, _) = disc_image(3, 2, 1.0, 1.0, 1.0, [10, 10, 10], [250, 250, 250], 0);
    let _ = select_subject(&px, 3, 2);
    let (px, _) = disc_image(1, 1, 0.0, 0.0, 0.0, [10, 10, 10], [250, 250, 250], 0);
    assert!(select_subject(&px, 1, 1).is_none());
}

#[test]
fn max_flow_of_a_small_graph() {
    // a: source 4, sink 1; b: source 1, sink 5; a -> b 2. Max flow 1 + 1 + 2 = 4, cut {a} | {b}.
    let mut g = Graph::with_edges(2, 0);
    g.add_tweights(0, 4.0, 1.0);
    g.add_tweights(1, 1.0, 5.0);
    g.add_edge(0, 1, 2.0, 0.0);
    assert!((g.maxflow() - 4.0).abs() < 1e-6);
    assert!(g.in_source(0));
    assert!(!g.in_source(1));
}

#[test]
fn max_flow_through_a_chain_and_a_bypass() {
    // s -> 0 (5), 0 -> 1 (3), 1 -> 2 (1), 0 -> 2 (2), 2 -> t (4), 1 -> t (1).
    // Min cut: {0 -> 1 is not saturated}: s side {0, 1}, cut 1->2 (1) + 0->2 (2) + 1->t (1) = 4.
    let mut g = Graph::with_edges(3, 0);
    g.add_tweights(0, 5.0, 0.0);
    g.add_tweights(2, 0.0, 4.0);
    g.add_tweights(1, 0.0, 1.0);
    g.add_edge(0, 1, 3.0, 0.0);
    g.add_edge(1, 2, 1.0, 0.0);
    g.add_edge(0, 2, 2.0, 0.0);
    assert!((g.maxflow() - 4.0).abs() < 1e-6);
    assert!(g.in_source(0) && g.in_source(1) && !g.in_source(2));
}

#[test]
fn max_flow_on_a_grid_matches_the_cut() {
    // 4x4 grid, left column tied to the source, right column to the sink, unit n-links both ways:
    // every row carries 1, so the flow is 4.
    let mut g = Graph::with_edges(16, 0);
    for y in 0..4 {
        g.add_tweights(y * 4, 100.0, 0.0);
        g.add_tweights(y * 4 + 3, 0.0, 100.0);
        for x in 0..4 {
            let i = y * 4 + x;
            if x < 3 {
                g.add_edge(i, i + 1, 1.0, 1.0);
            }
            if y < 3 {
                g.add_edge(i, i + 4, 5.0, 5.0);
            }
        }
    }
    assert!((g.maxflow() - 4.0).abs() < 1e-5);
}

// Release-mode timing on a 4000x3000 photo-sized image: `cargo test --release -- --ignored subject_timing --nocapture`.
#[test]
#[ignore]
fn subject_timing() {
    let (w, h) = (4000, 3000);
    let (px, truth) = disc_image(w, h, 2600.0, 1300.0, 700.0, [120, 140, 110], [200, 60, 50], 8);
    let t = std::time::Instant::now();
    let mask = select_subject(&px, w, h).expect("a subject");
    let ms = t.elapsed().as_millis();
    println!("select_subject 4000x3000: {ms} ms, IoU {:.4}", iou(&mask, &truth));
}

// Edmonds-Karp on a dense matrix with node 0 = source, 1 = sink.
fn reference_flow(mut c: Vec<Vec<f64>>) -> f64 {
    let n = c.len();
    let mut flow = 0.0;
    loop {
        let mut prev = vec![usize::MAX; n];
        prev[0] = 0;
        let mut queue = std::collections::VecDeque::from([0usize]);
        while let Some(u) = queue.pop_front() {
            for v in 0..n {
                if prev[v] == usize::MAX && c[u][v] > 1e-9 {
                    prev[v] = u;
                    queue.push_back(v);
                }
            }
        }
        if prev[1] == usize::MAX {
            return flow;
        }
        let (mut d, mut v) = (f64::INFINITY, 1);
        while v != 0 {
            d = d.min(c[prev[v]][v]);
            v = prev[v];
        }
        v = 1;
        while v != 0 {
            c[prev[v]][v] -= d;
            c[v][prev[v]] += d;
            v = prev[v];
        }
        flow += d;
    }
}

#[test]
fn max_flow_matches_a_reference_on_random_graphs() {
    let mut rng = Lcg(42);
    for round in 0..200 {
        let n = 2 + (rng.next(10) + 10) as usize;
        let mut g = Graph::with_edges(n, 0);
        let mut c = vec![vec![0f64; n + 2]; n + 2];
        for i in 0..n {
            let (s, t) = ((rng.next(5) + 5) as f32, (rng.next(5) + 5) as f32);
            g.add_tweights(i, s, t);
            c[0][i + 2] += s as f64;
            c[i + 2][1] += t as f64;
        }
        for _ in 0..n * 3 {
            let (i, j) = ((rng.next(50) + 50) as usize % n, (rng.next(50) + 50) as usize % n);
            if i == j {
                continue;
            }
            let (a, b) = ((rng.next(4) + 4) as f32, (rng.next(4) + 4) as f32);
            g.add_edge(i, j, a, b);
            c[i + 2][j + 2] += a as f64;
            c[j + 2][i + 2] += b as f64;
        }
        let got = g.maxflow();
        let want = reference_flow(c.clone());
        assert!((got - want).abs() < 1e-3, "round {round}: {got} vs {want}");
        // The source side is a cut of the same value.
        let side: Vec<bool> = (0..n + 2).map(|v| v == 0 || (v >= 2 && g.in_source(v - 2))).collect();
        let cut: f64 = (0..n + 2).flat_map(|u| (0..n + 2).map(move |v| (u, v))).filter(|&(u, v)| side[u] && !side[v]).map(|(u, v)| c[u][v]).sum();
        assert!((cut - want).abs() < 1e-3, "round {round}: cut {cut} vs {want}");
    }
}

#[test]
fn a_dark_shape_on_a_transparent_layer_is_selected() {
    let (w, h) = (400, 300);
    let (mut px, truth) = disc_image(w, h, 200.0, 150.0, 90.0, [0, 0, 0], [40, 80, 130], 6);
    for (p, &t) in truth.iter().enumerate() {
        if !t {
            px[p * 4..p * 4 + 4].copy_from_slice(&[0, 0, 0, 0]);
        }
    }
    let v = iou(&select_subject(&px, w, h).expect("a subject"), &truth);
    println!("IoU {v:.4}");
    assert!(v >= 0.9, "IoU {v}");
}

#[test]
fn a_black_shape_on_a_transparent_layer_is_selected() {
    let (w, h) = (400, 300);
    let (mut px, truth) = disc_image(w, h, 230.0, 140.0, 80.0, [0, 0, 0], [12, 12, 12], 4);
    for (p, &t) in truth.iter().enumerate() {
        if !t {
            px[p * 4..p * 4 + 4].copy_from_slice(&[0, 0, 0, 0]);
        }
    }
    let v = iou(&select_subject(&px, w, h).expect("a subject"), &truth);
    println!("IoU {v:.4}");
    assert!(v >= 0.9, "IoU {v}");
}
