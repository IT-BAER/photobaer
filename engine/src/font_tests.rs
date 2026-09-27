use super::*;

fn bundled() -> Registry {
    let mut r = Registry::default();
    for f in ["NotoSansMono-Regular.ttf", "NotoSerif-Regular.ttf", "NotoSans-Regular.ttf", "NotoSans-Bold.ttf"] {
        let path = format!("{}/../app/public/fonts/{f}", env!("CARGO_MANIFEST_DIR"));
        r.add(std::fs::read(path).unwrap(), "bundled").unwrap();
    }
    r
}

fn info(family: &str, style: &str, weight: u16, italic: bool) -> FaceInfo {
    FaceInfo {
        id: 0,
        family: family.into(),
        style: style.into(),
        weight,
        italic,
        postscript: String::new(),
        source: "test".into(),
        color: false,
    }
}

fn id_of(r: &Registry, postscript: &str) -> u32 {
    r.faces.iter().find(|f| f.info.postscript == postscript).unwrap().info.id
}

#[test]
fn semibold_italic_picks_bold_italic_over_nearer_upright() {
    let faces = [info("F", "Regular", 400, false), info("F", "Bold", 700, false), info("F", "Bold Italic", 700, true)];
    assert_eq!(pick_style(&faces.iter().collect::<Vec<_>>(), "Semibold Italic"), Some(2));
}

#[test]
fn regular_wins_a_weight_tie_and_exact_style_names_win() {
    let faces = [info("F", "Book", 400, false), info("F", "Regular", 400, false)];
    let refs = faces.iter().collect::<Vec<_>>();
    assert_eq!(pick_style(&refs, "Medium"), Some(1));
    assert_eq!(pick_style(&refs, "book"), Some(0));
}

#[test]
fn italic_mismatch_costs_more_than_any_weight_gap() {
    let faces = [info("F", "Black", 900, false), info("F", "Thin Italic", 100, true)];
    assert_eq!(pick_style(&faces.iter().collect::<Vec<_>>(), "Black Italic"), Some(1));
}

#[test]
fn style_words_map_to_weights() {
    for (s, w) in [("Thin", 100), ("ExtraLight", 200), ("Extra Light", 200), ("Light", 300), ("Regular", 400), ("Medium", 500),
        ("SemiBold", 600), ("Demi", 600), ("Bold", 700), ("ExtraBold", 800), ("Ultra Bold", 800), ("Black", 900), ("Heavy", 900)] {
        assert_eq!(style_weight(s), w, "{s}");
    }
    assert!(style_italic("Bold Oblique") && style_italic("Italic") && !style_italic("Regular"));
}

#[test]
fn family_list_hides_dot_at_and_color_emoji_names_and_sorts() {
    let mut r = Registry::default();
    let mut emoji = info("Noto Color Emoji", "Regular", 400, false);
    emoji.color = true;
    for i in [info("Zeta", "Regular", 400, false), info(".SF NS", "Regular", 400, false), info("@MS Gothic", "Regular", 400, false),
        info("alpha", "Regular", 400, false), info("alpha", "Bold", 700, false), emoji] {
        r.faces.push(Face { info: i, data: Rc::from(Vec::new()), index: 0 });
    }
    assert_eq!(r.families(), ["alpha", "Zeta"]);
}

#[test]
fn bundled_faces_parse_family_style_weight_and_postscript() {
    let r = bundled();
    assert_eq!(r.families(), ["Noto Sans", "Noto Sans Mono", "Noto Serif"]);
    let bold = r.faces.iter().find(|f| f.info.postscript == "NotoSans-Bold").unwrap();
    assert_eq!((bold.info.family.as_str(), bold.info.style.as_str(), bold.info.weight, bold.info.italic), ("Noto Sans", "Bold", 700, false));
    assert_eq!(bold.info.source, "bundled");
}

#[test]
fn resolve_by_family_and_style_or_postscript_name() {
    let r = bundled();
    let bold = id_of(&r, "NotoSans-Bold");
    assert_eq!(r.resolve("Noto Sans", "Bold"), Some(bold));
    assert_eq!(r.resolve("noto sans", "Semibold"), Some(bold));
    assert_eq!(r.resolve("NotoSans-Bold", ""), Some(bold));
    assert_eq!(r.resolve("Noto Sans", "Light"), Some(id_of(&r, "NotoSans-Regular")));
    assert_eq!(r.resolve("Helvetica", "Regular"), None);
}

#[test]
fn adding_the_same_bytes_twice_registers_them_once() {
    let mut r = bundled();
    let n = r.faces.len();
    let again = r.add(std::fs::read(format!("{}/../app/public/fonts/NotoSans-Bold.ttf", env!("CARGO_MANIFEST_DIR"))).unwrap(), "bundled").unwrap();
    assert_eq!(r.faces.len(), n);
    assert_eq!(again.iter().map(|f| f.id).collect::<Vec<_>>(), [id_of(&r, "NotoSans-Bold")]);
    assert!(r.add(vec![1, 2, 3], "upload").is_err());
}

#[test]
fn per_character_fallback_takes_the_first_face_that_has_the_character() {
    let r = bundled();
    let (mono, sans) = (id_of(&r, "NotoSansMono-Regular"), id_of(&r, "NotoSans-Regular"));
    // Devanagari letter a is in the bundled Noto Sans and absent from Noto Serif and Noto Sans Mono.
    let ch = '\u{0905}';
    assert!(!r.has_char(mono, ch) && !r.has_char(id_of(&r, "NotoSerif-Regular"), ch) && r.has_char(sans, ch));
    let chain = ["Noto Serif", "Noto Sans"];
    assert_eq!(r.char_faces(mono, &format!("A{ch}"), &chain), [Some(mono), Some(sans)]);
    assert_eq!(r.char_faces(mono, "\u{E000}", &chain), [None]);
    assert_eq!(r.fallback_faces(mono, &format!("{ch}")), [Some(sans)]);
}

#[test]
fn arabic_fallback_faces_must_also_draw_peh() {
    assert!(fallback_chain('\u{0628}').iter().any(|f| *f == "Noto Naskh Arabic"));
    assert!(fallback_chain('\u{AC00}').iter().position(|f| *f == "Malgun Gothic") < fallback_chain('\u{AC00}').iter().position(|f| *f == "Noto Sans"));
    assert_eq!(fallback_chain('A')[0], "Noto Sans");
}

#[test]
fn missing_lists_pairs_whose_family_does_not_resolve() {
    let r = bundled();
    let pairs = [("Noto Sans".to_string(), "Black".to_string()), ("Helvetica".into(), "Regular".into()), ("NotoSerif-Regular".into(), String::new())];
    assert_eq!(r.missing(&pairs), [("Helvetica".to_string(), "Regular".to_string())]);
}

#[test]
fn tool_default_family_falls_back_to_a_family_that_draws_ascii() {
    let r = bundled();
    assert_eq!(r.default_family("Noto Serif").as_deref(), Some("Noto Serif"));
    assert_eq!(r.default_family("Helvetica").as_deref(), Some("Noto Sans"));
    assert_eq!(Registry::default().default_family("Noto Sans"), None);
}

#[test]
fn a_forged_collection_count_is_rejected_without_scanning_billions_of_faces() {
    let mut r = Registry::default();
    let start = std::time::Instant::now();
    let forged = [b"ttcf".as_slice(), &[0, 1, 0, 0], &[0xFF, 0xFF, 0xFF, 0xFF]].concat();
    assert!(r.add(forged, "upload").is_err());
    assert!(start.elapsed().as_millis() < 100, "took {:?}", start.elapsed());
}

#[test]
fn a_font_file_over_the_size_cap_is_rejected() {
    let e = Registry::default().add(vec![0; MAX_FONT_BYTES + 1], "upload").unwrap_err();
    assert!(e.contains("MB"), "{e}");
}
