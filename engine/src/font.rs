// Font registry: faces from bundled, uploaded and local font files, parsed with ttf-parser.
// App scope: shared by every document; documents store family, style and PostScript name only.
use std::collections::HashMap;
use std::rc::Rc;
use ttf_parser::name_id;

#[derive(Clone, Debug, serde::Serialize)]
pub struct FaceInfo {
    pub id: u32,
    pub family: String,
    pub style: String,
    pub weight: u16,
    pub italic: bool,
    pub postscript: String,
    pub source: String,
    pub color: bool,
}

pub struct Face {
    pub info: FaceInfo,
    data: Rc<[u8]>,
    index: u32,
}

#[derive(Default)]
pub struct Registry {
    faces: Vec<Face>,
    next: u32,
}

// Tool default and per-character fallback: the bundled sans first, then common system families.
const GENERAL: &[&str] = &["Noto Sans", "Arial", "Helvetica Neue", "Segoe UI", "Liberation Sans", "DejaVu Sans"];
const KOREAN: &[&str] = &["Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans CJK KR", "Noto Sans KR"];
const CJK: &[&str] = &["Noto Sans CJK SC", "Noto Sans CJK JP", "Microsoft YaHei", "PingFang SC", "Hiragino Sans", "Yu Gothic", "MS Gothic", "SimSun"];
const ARABIC: &[&str] = &["Tahoma", "Geeza Pro", "Noto Naskh Arabic", "Noto Sans Arabic", "Arial", "DejaVu Sans"];
// An Arabic fallback face must also draw Persian peh, so Persian text never mixes faces.
const PEH: char = '\u{067E}';

fn is_arabic(c: char) -> bool {
    matches!(c as u32, 0x0600..=0x06FF | 0x0750..=0x077F | 0x08A0..=0x08FF | 0xFB50..=0xFDFF | 0xFE70..=0xFEFF)
}
fn is_korean(c: char) -> bool {
    matches!(c as u32, 0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF)
}
fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x2E80..=0x9FFF | 0xF900..=0xFAFF | 0xFF00..=0xFFEF | 0x20000..=0x3FFFF)
}

/// Families probed for a character the run font lacks: the script's probe list, then the general list.
pub fn fallback_chain(ch: char) -> Vec<&'static str> {
    let script: &[&str] = if is_korean(ch) {
        KOREAN
    } else if is_cjk(ch) {
        CJK
    } else if is_arabic(ch) {
        ARABIC
    } else {
        &[]
    };
    let mut v = script.to_vec();
    v.extend(GENERAL.iter().filter(|f| !script.contains(f)));
    v
}

fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

/// Weight named by a style's words (thin 100 .. black 900); 400 when no weight word is present.
pub fn style_weight(style: &str) -> u16 {
    let s = squash(style);
    let words: [(&[&str], u16); 9] = [
        (&["extralight", "ultralight"], 200),
        (&["extrabold", "ultrabold"], 800),
        (&["semibold", "demibold", "demi"], 600),
        (&["thin", "hairline"], 100),
        (&["light"], 300),
        (&["medium"], 500),
        (&["bold"], 700),
        (&["black", "heavy"], 900),
        (&["regular"], 400),
    ];
    words.iter().find(|(w, _)| w.iter().any(|w| s.contains(w))).map_or(400, |&(_, n)| n)
}

pub fn style_italic(style: &str) -> bool {
    let s = squash(style);
    s.contains("italic") || s.contains("oblique")
}

/// Face for a style: the exact style name, else the nearest weight; an italic mismatch costs more
/// than any weight gap and "Regular" wins ties.
pub fn pick_style(faces: &[&FaceInfo], style: &str) -> Option<usize> {
    let want = squash(style);
    if let Some(i) = faces.iter().position(|f| squash(&f.style) == want) {
        return Some(i);
    }
    let (w, it) = (style_weight(style) as i32, style_italic(style));
    let cost = |f: &FaceInfo| ((f.weight as i32 - w).abs() + if f.italic != it { 1000 } else { 0 }, squash(&f.style) != "regular");
    (0..faces.len()).min_by_key(|&i| cost(faces[i]))
}

fn name(face: &ttf_parser::Face, ids: &[u16]) -> Option<String> {
    ids.iter().find_map(|&id| {
        let named = || face.names().into_iter().filter(move |n| n.name_id == id);
        named().filter(|n| n.language_id == 0x0409).find_map(|n| n.to_string()).or_else(|| named().find_map(|n| n.to_string()))
    })
}

/// Largest accepted font file; the bytes are copied into the wasm heap.
pub const MAX_FONT_BYTES: usize = 64 << 20;

impl Registry {
    /// Registers every face of a font file (collections included). Identical bytes register once.
    pub fn add(&mut self, bytes: Vec<u8>, source: &str) -> Result<Vec<FaceInfo>, String> {
        if bytes.len() > MAX_FONT_BYTES {
            return Err(format!("Font files over {} MB are not supported.", MAX_FONT_BYTES >> 20));
        }
        let known: Vec<FaceInfo> = self.faces.iter().filter(|f| *f.data == bytes[..]).map(|f| f.info.clone()).collect();
        if !known.is_empty() {
            return Ok(known);
        }
        let data: Rc<[u8]> = Rc::from(bytes);
        let mut added = Vec::new();
        // A collection header's face count is untrusted: each face needs a 4-byte offset after the 12-byte header.
        let offsets = (data.len().saturating_sub(12) / 4) as u32;
        for index in 0..ttf_parser::fonts_in_collection(&data).map_or(1, |n| n.min(offsets).min(256)) {
            let Ok(face) = ttf_parser::Face::parse(&data, index) else { continue };
            let Some(family) = name(&face, &[name_id::TYPOGRAPHIC_FAMILY, name_id::FAMILY]) else { continue };
            let style = name(&face, &[name_id::TYPOGRAPHIC_SUBFAMILY, name_id::SUBFAMILY]).unwrap_or_else(|| "Regular".into());
            let t = face.tables();
            let info = FaceInfo {
                id: self.next,
                postscript: name(&face, &[name_id::POST_SCRIPT_NAME]).unwrap_or_else(|| format!("{family}-{style}").replace(' ', "")),
                family,
                style,
                weight: face.weight().to_number(),
                italic: face.is_italic() || face.is_oblique(),
                source: source.into(),
                color: t.colr.is_some() || t.cbdt.is_some() || t.sbix.is_some() || t.svg.is_some(),
            };
            self.next += 1;
            added.push(info.clone());
            self.faces.push(Face { info, data: data.clone(), index });
        }
        if added.is_empty() {
            return Err("not a supported font file (TrueType, OpenType or a collection of them)".into());
        }
        Ok(added)
    }

    pub fn faces(&self) -> Vec<FaceInfo> {
        self.faces.iter().map(|f| f.info.clone()).collect()
    }

    /// Unique family names for pickers, sorted case-insensitively; hides names starting with "." or "@"
    /// (system and vertical aliases) and color emoji families.
    pub fn families(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .faces
            .iter()
            .map(|f| &f.info)
            .filter(|i| !i.family.starts_with(['.', '@']) && !(i.color && i.family.to_lowercase().contains("emoji")))
            .map(|i| i.family.clone())
            .collect();
        v.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b)));
        v.dedup();
        v
    }

    /// Face for a family (or PostScript name) and style; None when neither names a registered face.
    pub fn resolve(&self, family: &str, style: &str) -> Option<u32> {
        let key = family.to_lowercase();
        let faces: Vec<&FaceInfo> = self.faces.iter().map(|f| &f.info).filter(|i| i.family.to_lowercase() == key).collect();
        if faces.is_empty() {
            return self.faces.iter().find(|f| f.info.postscript.to_lowercase() == key).map(|f| f.info.id);
        }
        pick_style(&faces, style).map(|i| faces[i].id)
    }

    /// Font file bytes and collection index of a face.
    #[allow(dead_code)]
    pub fn data(&self, id: u32) -> Option<(&[u8], u32)> {
        self.faces.iter().find(|f| f.info.id == id).map(|f| (&f.data[..], f.index))
    }

    fn parsed(&self, id: u32) -> Option<ttf_parser::Face<'_>> {
        let f = self.faces.iter().find(|f| f.info.id == id)?;
        ttf_parser::Face::parse(&f.data, f.index).ok()
    }

    #[cfg(test)]
    pub fn has_char(&self, id: u32, ch: char) -> bool {
        self.parsed(id).is_some_and(|f| f.glyph_index(ch).is_some())
    }

    fn draws_ascii(&self, id: u32) -> bool {
        self.parsed(id).is_some_and(|f| ('A'..='Z').chain('a'..='z').chain('0'..='9').all(|c| f.glyph_index(c).is_some()))
    }

    /// Face per character of `text`: the primary face when it has the character, else the first
    /// family of `chain` (in the primary's style) that has it; None when no face draws it.
    #[cfg(test)]
    pub fn char_faces(&self, primary: u32, text: &str, chain: &[&str]) -> Vec<Option<u32>> {
        self.char_faces_by(primary, text, |_| chain.iter().map(|s| s.to_string()).collect())
    }

    /// char_faces with the default chain: the character's script probes, the general list, then every family.
    pub fn fallback_faces(&self, primary: u32, text: &str) -> Vec<Option<u32>> {
        let all = self.families();
        self.char_faces_by(primary, text, |c| {
            let mut v: Vec<String> = fallback_chain(c).iter().map(|s| s.to_string()).collect();
            v.extend(all.iter().cloned());
            v
        })
    }

    fn char_faces_by(&self, primary: u32, text: &str, chain: impl Fn(char) -> Vec<String>) -> Vec<Option<u32>> {
        let style = self.faces.iter().find(|f| f.info.id == primary).map_or(String::new(), |f| f.info.style.clone());
        let mut parsed: HashMap<u32, Option<ttf_parser::Face>> = HashMap::new();
        let mut has = |id: u32, c: char| parsed.entry(id).or_insert_with(|| self.parsed(id)).as_ref().is_some_and(|f| f.glyph_index(c).is_some());
        let mut resolved: HashMap<String, Option<u32>> = HashMap::new();
        text.chars()
            .map(|c| {
                if has(primary, c) {
                    return Some(primary);
                }
                chain(c).into_iter().find_map(|fam| {
                    let id = (*resolved.entry(fam).or_insert_with_key(|k| self.resolve(k, &style)))?;
                    (has(id, c) && (!is_arabic(c) || has(id, PEH))).then_some(id)
                })
            })
            .collect()
    }

    /// (family, style) pairs whose family resolves to no face, in first-seen order, once each.
    pub fn missing(&self, pairs: &[(String, String)]) -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = Vec::new();
        for p in pairs {
            if self.resolve(&p.0, &p.1).is_none() && !out.contains(p) {
                out.push(p.clone());
            }
        }
        out
    }

    /// Tool default family: `family` if it draws A-Z, a-z and 0-9, else the first general fallback
    /// family that does, else any family that does.
    pub fn default_family(&self, family: &str) -> Option<String> {
        let all = self.families();
        std::iter::once(family.to_string())
            .chain(GENERAL.iter().map(|s| s.to_string()))
            .chain(all)
            .find_map(|fam| {
                let id = self.resolve(&fam, "Regular")?;
                self.draws_ascii(id).then(|| self.faces.iter().find(|f| f.info.id == id).unwrap().info.family.clone())
            })
    }
}

#[cfg(test)]
#[path = "font_tests.rs"]
mod tests;
