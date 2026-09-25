use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::blend::{blend_rgb, dissolve_hash, Blend};

pub const TILE: usize = 256;
const TILE_PIXELS: usize = TILE * TILE;
const TILE_BYTES_U8: usize = TILE_PIXELS * 4;
const TILE_BYTES_U16: usize = TILE_PIXELS * 4 * 2;
const MASK_BYTES_U8: usize = TILE_PIXELS;
const MASK_BYTES_U16: usize = TILE_PIXELS * 2;
const MANIFEST_FORMAT: &str = "photobaer-manifest";
const MANIFEST_VERSION: u32 = 2;
// Ids travel as JS numbers; anything above 2^53 would lose precision or overflow next_id.
const MAX_ID: u64 = 1 << 53;

fn max_value(depth: u8) -> u32 {
    if depth == 8 {
        255
    } else {
        65535
    }
}

#[derive(Clone)]
pub enum Pixels {
    U8(Box<[u8]>),
    U16(Box<[u16]>),
    Mask8(Box<[u8]>),
    Mask16(Box<[u16]>),
}

impl Pixels {
    #[inline(always)]
    fn rgba_f32(&self, p: usize) -> [f32; 4] {
        let o = p * 4;
        match self {
            Pixels::U8(d) => [
                d[o] as f32 / 255.0,
                d[o + 1] as f32 / 255.0,
                d[o + 2] as f32 / 255.0,
                d[o + 3] as f32 / 255.0,
            ],
            Pixels::U16(d) => [
                d[o] as f32 / 65535.0,
                d[o + 1] as f32 / 65535.0,
                d[o + 2] as f32 / 65535.0,
                d[o + 3] as f32 / 65535.0,
            ],
            _ => [0.0; 4],
        }
    }

    fn mask_f32(&self, p: usize) -> f32 {
        match self {
            Pixels::Mask8(d) => d[p] as f32 / 255.0,
            Pixels::Mask16(d) => d[p] as f32 / 65535.0,
            _ => 1.0,
        }
    }

    fn to_bytes(&self) -> Vec<u8> {
        match self {
            Pixels::U8(d) | Pixels::Mask8(d) => d.to_vec(),
            Pixels::U16(d) | Pixels::Mask16(d) => {
                let mut out = Vec::with_capacity(d.len() * 2);
                for v in d.iter() {
                    out.extend_from_slice(&v.to_le_bytes());
                }
                out
            }
        }
    }

    fn from_bytes(depth: u8, mask: bool, bytes: &[u8]) -> Result<Pixels, String> {
        let want = match (depth, mask) {
            (8, false) => TILE_BYTES_U8,
            (8, true) => MASK_BYTES_U8,
            (_, false) => TILE_BYTES_U16,
            (_, true) => MASK_BYTES_U16,
        };
        if bytes.len() != want {
            return Err(format!("expected {want} bytes, got {}", bytes.len()));
        }
        Ok(match (depth, mask) {
            (8, false) => Pixels::U8(bytes.to_vec().into_boxed_slice()),
            (8, true) => Pixels::Mask8(bytes.to_vec().into_boxed_slice()),
            (_, m) => {
                let mut out = Vec::with_capacity(bytes.len() / 2);
                for chunk in bytes.chunks_exact(2) {
                    out.push(u16::from_le_bytes([chunk[0], chunk[1]]));
                }
                let b = out.into_boxed_slice();
                if m {
                    Pixels::Mask16(b)
                } else {
                    Pixels::U16(b)
                }
            }
        })
    }

    fn from_rgba8(depth: u8, rgba8: &[u8]) -> Pixels {
        if depth == 8 {
            Pixels::U8(rgba8.to_vec().into_boxed_slice())
        } else {
            Pixels::U16(rgba8.iter().map(|v| *v as u16 * 257).collect::<Vec<_>>().into_boxed_slice())
        }
    }

    fn from_mask8(depth: u8, data: &[u8]) -> Pixels {
        if depth == 8 {
            Pixels::Mask8(data.to_vec().into_boxed_slice())
        } else {
            Pixels::Mask16(data.iter().map(|v| *v as u16 * 257).collect::<Vec<_>>().into_boxed_slice())
        }
    }

    fn mask_const(depth: u8, value: u32) -> Pixels {
        if depth == 8 {
            Pixels::Mask8(vec![value as u8; TILE_PIXELS].into_boxed_slice())
        } else {
            Pixels::Mask16(vec![value as u16; TILE_PIXELS].into_boxed_slice())
        }
    }

    fn inverted(&self) -> Pixels {
        match self {
            Pixels::U8(d) => {
                let mut out = d.clone();
                for p in 0..TILE_PIXELS {
                    let o = p * 4;
                    out[o] = 255 - d[o];
                    out[o + 1] = 255 - d[o + 1];
                    out[o + 2] = 255 - d[o + 2];
                }
                Pixels::U8(out)
            }
            Pixels::U16(d) => {
                let mut out = d.clone();
                for p in 0..TILE_PIXELS {
                    let o = p * 4;
                    out[o] = 65535 - d[o];
                    out[o + 1] = 65535 - d[o + 1];
                    out[o + 2] = 65535 - d[o + 2];
                }
                Pixels::U16(out)
            }
            Pixels::Mask8(d) => Pixels::Mask8(d.iter().map(|v| 255 - v).collect::<Vec<_>>().into_boxed_slice()),
            Pixels::Mask16(d) => Pixels::Mask16(d.iter().map(|v| 65535 - v).collect::<Vec<_>>().into_boxed_slice()),
        }
    }

    // Replaces color but keeps every pixel's alpha (transparency lock).
    fn recolored(&self, r: u8, g: u8, b: u8) -> Pixels {
        match self {
            Pixels::U8(d) => {
                let mut out = d.clone();
                for p in 0..TILE_PIXELS {
                    let o = p * 4;
                    out[o] = r;
                    out[o + 1] = g;
                    out[o + 2] = b;
                }
                Pixels::U8(out)
            }
            Pixels::U16(d) => {
                let mut out = d.clone();
                for p in 0..TILE_PIXELS {
                    let o = p * 4;
                    out[o] = r as u16 * 257;
                    out[o + 1] = g as u16 * 257;
                    out[o + 2] = b as u16 * 257;
                }
                Pixels::U16(out)
            }
            other => other.clone(),
        }
    }
}

#[derive(Clone)]
pub struct Tile {
    pub id: u64,
    pub px: Arc<Pixels>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Locks {
    pub transparency: bool,
    pub pixels: bool,
    pub position: bool,
}

#[derive(Clone)]
pub struct Mask {
    pub enabled: bool,
    pub default: u32,
    pub tiles: Vec<Option<Tile>>,
}

#[derive(Clone)]
pub enum Kind {
    Pixel(Vec<Option<Tile>>),
    Group(Vec<Node>),
}

#[derive(Clone)]
pub struct Node {
    pub id: u32,
    pub name: String,
    pub visible: bool,
    pub opacity: f32,
    pub fill: f32,
    pub blend: Blend,
    pub clipping: bool,
    pub locks: Locks,
    pub mask: Option<Mask>,
    pub kind: Kind,
}

impl Node {
    fn new(id: u32, name: &str, kind: Kind) -> Node {
        Node {
            id,
            name: name.to_string(),
            visible: true,
            opacity: 1.0,
            fill: 1.0,
            blend: if matches!(kind, Kind::Group(_)) { Blend::PassThrough } else { Blend::Normal },
            clipping: false,
            locks: Locks::default(),
            mask: None,
            kind,
        }
    }

    fn is_group(&self) -> bool {
        matches!(self.kind, Kind::Group(_))
    }

    // Groups store fill 1 and ignore it (M1.md section 1).
    fn eff_fill(&self) -> f32 {
        if self.is_group() {
            1.0
        } else {
            self.fill
        }
    }

    fn pixel_tiles(&self) -> Result<&Vec<Option<Tile>>, String> {
        match &self.kind {
            Kind::Pixel(t) => Ok(t),
            Kind::Group(_) => Err(format!("node {} is a group and has no pixels", self.id)),
        }
    }

    fn pixel_tiles_mut(&mut self) -> Result<&mut Vec<Option<Tile>>, String> {
        let id = self.id;
        match &mut self.kind {
            Kind::Pixel(t) => Ok(t),
            Kind::Group(_) => Err(format!("node {id} is a group and has no pixels")),
        }
    }
}

fn find_path_in(nodes: &[Node], id: u32, cur: &mut Vec<usize>) -> bool {
    for (i, n) in nodes.iter().enumerate() {
        cur.push(i);
        if n.id == id {
            return true;
        }
        if let Kind::Group(ch) = &n.kind {
            if find_path_in(ch, id, cur) {
                return true;
            }
        }
        cur.pop();
    }
    false
}

fn list_mut<'a>(nodes: &'a mut Vec<Node>, path: &[usize]) -> &'a mut Vec<Node> {
    let mut cur = nodes;
    for &i in path {
        cur = match &mut cur[i].kind {
            Kind::Group(ch) => ch,
            Kind::Pixel(_) => unreachable!("a node path only walks through groups"),
        };
    }
    cur
}

fn node_at<'a>(nodes: &'a [Node], path: &[usize]) -> &'a Node {
    let (last, prefix) = path.split_last().expect("a node path is never empty");
    let mut cur = nodes;
    for &i in prefix {
        cur = match &cur[i].kind {
            Kind::Group(ch) => ch,
            Kind::Pixel(_) => unreachable!("a node path only walks through groups"),
        };
    }
    &cur[*last]
}

fn node_at_mut<'a>(nodes: &'a mut Vec<Node>, path: &[usize]) -> &'a mut Node {
    let (last, prefix) = path.split_last().expect("a node path is never empty");
    &mut list_mut(nodes, prefix)[*last]
}

#[derive(Clone)]
struct Loading {
    // tile id -> (is_mask, [(node path, slot)]) still waiting for pixel data.
    slots: HashMap<u64, (bool, Vec<(Vec<usize>, usize)>)>,
    pending_ids: HashSet<u64>,
    max_referenced_id: u64,
}

#[derive(Clone)]
pub struct Document {
    width: u32,
    height: u32,
    depth: u8,
    nodes: Vec<Node>,
    next_id: u64,
    next_node_id: u32,
    loading: Option<Loading>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Pixels,
    Mask,
}

impl Target {
    pub fn parse(s: &str) -> Result<Target, String> {
        match s {
            "pixels" => Ok(Target::Pixels),
            "mask" => Ok(Target::Mask),
            other => Err(format!("unknown target {other}")),
        }
    }
}

fn validate_dims(width: u32, height: u32, depth: u8) -> Result<(), String> {
    if !(1..=65536).contains(&width) || !(1..=65536).contains(&height) {
        return Err("width and height must be in 1..=65536".into());
    }
    if depth != 8 && depth != 16 {
        return Err("depth must be 8 or 16".into());
    }
    Ok(())
}

fn tiles_for(size: u32) -> u32 {
    (size as u64).div_ceil(TILE as u64) as u32
}

fn unit(v: f32, what: &str) -> Result<f32, String> {
    if v.is_nan() || !(0.0..=1.0).contains(&v) {
        return Err(format!("{what} must be in 0..=1"));
    }
    Ok(v)
}

// ---------- compositing ----------

struct TileCtx {
    slot: usize,
    ox: u32,
    oy: u32,
    vw: usize,
    vh: usize,
}

enum MaskSrc<'a> {
    Full,
    Const(f32),
    Tile(&'a Pixels),
}

impl MaskSrc<'_> {
    #[inline(always)]
    fn at(&self, p: usize) -> f32 {
        match self {
            MaskSrc::Full => 1.0,
            MaskSrc::Const(v) => *v,
            MaskSrc::Tile(px) => px.mask_f32(p),
        }
    }
}

fn mask_src<'a>(node: &'a Node, depth: u8, slot: usize) -> MaskSrc<'a> {
    match &node.mask {
        Some(m) if m.enabled => match &m.tiles[slot] {
            Some(t) => MaskSrc::Tile(&t.px),
            None => MaskSrc::Const(m.default as f32 / max_value(depth) as f32),
        },
        _ => MaskSrc::Full,
    }
}

#[derive(Clone, Copy)]
enum Src<'a> {
    Tile(&'a Pixels),
    Buf(&'a [f32]),
}

impl Src<'_> {
    // Straight (unpremultiplied) RGBA.
    #[inline(always)]
    fn at(&self, p: usize) -> [f32; 4] {
        match self {
            Src::Tile(px) => px.rgba_f32(p),
            Src::Buf(b) => {
                let o = p * 4;
                let a = b[o + 3];
                if a > 0.0 {
                    [b[o] / a, b[o + 1] / a, b[o + 2] / a, a]
                } else {
                    [0.0; 4]
                }
            }
        }
    }
}

enum SrcOwned<'a> {
    Tile(&'a Pixels),
    Buf(Vec<f32>),
    Empty,
}

impl SrcOwned<'_> {
    fn as_src(&self) -> Option<Src<'_>> {
        match self {
            SrcOwned::Tile(px) => Some(Src::Tile(px)),
            SrcOwned::Buf(b) => Some(Src::Buf(b)),
            SrcOwned::Empty => None,
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw(
    dst: &mut [f32],
    src: Src,
    mask: &MaskSrc,
    shape: Option<&[f32]>,
    scale: f32,
    mode: Blend,
    node_id: u32,
    c: &TileCtx,
) {
    if scale <= 0.0 {
        return;
    }
    let dissolve = mode == Blend::Dissolve;
    let plain = mode.is_passthrough_of_source();
    for y in 0..c.vh {
        for x in 0..c.vw {
            let p = y * TILE + x;
            let [r, g, b, a] = src.at(p);
            if a <= 0.0 {
                continue;
            }
            let mut cov = a * scale * mask.at(p);
            if let Some(s) = shape {
                cov *= s[p];
            }
            if cov <= 0.0 {
                continue;
            }
            if dissolve {
                if dissolve_hash(c.ox + x as u32, c.oy + y as u32, node_id) < cov {
                    cov = 1.0;
                } else {
                    continue;
                }
            }
            let o = p * 4;
            let ab = dst[o + 3];
            // W3C: Cm = (1 - ab) * Cs + ab * B(Cb, Cs); with ab = 0 that is Cs.
            let cm = if plain || ab <= 0.0 {
                [r, g, b]
            } else {
                let inv = 1.0 / ab;
                let cb = [
                    (dst[o] * inv).clamp(0.0, 1.0),
                    (dst[o + 1] * inv).clamp(0.0, 1.0),
                    (dst[o + 2] * inv).clamp(0.0, 1.0),
                ];
                let bl = blend_rgb(mode, cb, [r, g, b]);
                [
                    (1.0 - ab) * r + ab * bl[0],
                    (1.0 - ab) * g + ab * bl[1],
                    (1.0 - ab) * b + ab * bl[2],
                ]
            };
            let inv = 1.0 - cov;
            dst[o] = cov * cm[0] + inv * dst[o];
            dst[o + 1] = cov * cm[1] + inv * dst[o + 1];
            dst[o + 2] = cov * cm[2] + inv * dst[o + 2];
            dst[o + 3] = cov + inv * ab;
        }
    }
}

impl Document {
    pub fn new(width: u32, height: u32, depth: u8) -> Result<Document, String> {
        validate_dims(width, height, depth)?;
        let slots = (tiles_for(width) * tiles_for(height)) as usize;
        Ok(Document {
            width,
            height,
            depth,
            nodes: vec![Node::new(1, "Background", Kind::Pixel(vec![None; slots]))],
            next_id: 1,
            next_node_id: 2,
            loading: None,
        })
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn depth(&self) -> u8 {
        self.depth
    }
    pub fn tiles_x(&self) -> u32 {
        tiles_for(self.width)
    }
    pub fn tiles_y(&self) -> u32 {
        tiles_for(self.height)
    }
    fn slots(&self) -> usize {
        (self.tiles_x() * self.tiles_y()) as usize
    }

    pub fn max_level(&self) -> u32 {
        let m = self.width.max(self.height) as u64;
        for l in 0..=8u32 {
            let span = (TILE as u64) << l;
            if m.div_ceil(span) == 1 {
                return l;
            }
        }
        8
    }

    // ---------- tree access ----------

    fn find_path(&self, id: u32) -> Result<Vec<usize>, String> {
        let mut path = Vec::new();
        if id != 0 && find_path_in(&self.nodes, id, &mut path) {
            Ok(path)
        } else {
            Err(format!("unknown node {id}"))
        }
    }

    pub fn node(&self, id: u32) -> Result<&Node, String> {
        let path = self.find_path(id)?;
        Ok(node_at(&self.nodes, &path))
    }

    fn node_mut(&mut self, id: u32) -> Result<&mut Node, String> {
        let path = self.find_path(id)?;
        Ok(node_at_mut(&mut self.nodes, &path))
    }

    // While a manifest is loading the tree is a skeleton whose tile slots still expect
    // `put_tile`; only `put_tile` and `finish_load` may run.
    fn check_idle(&self) -> Result<(), String> {
        if self.loading.is_some() {
            return Err("document is still loading".into());
        }
        Ok(())
    }

    fn alloc_node_id(&mut self) -> u32 {
        let id = self.next_node_id;
        self.next_node_id += 1;
        id
    }

    fn alloc_tile_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    // ---------- commands (M1.md section 4) ----------

    fn add_node(&mut self, name: &str, above: u32, group: bool) -> Result<u32, String> {
        self.check_idle()?;
        let slots = self.slots();
        let at = if above == 0 {
            None
        } else {
            Some(self.find_path(above)?)
        };
        let id = self.alloc_node_id();
        let kind = if group { Kind::Group(Vec::new()) } else { Kind::Pixel(vec![None; slots]) };
        let node = Node::new(id, name, kind);
        match at {
            None => self.nodes.push(node),
            Some(path) => {
                let (last, prefix) = path.split_last().expect("path");
                let list = list_mut(&mut self.nodes, prefix);
                list.insert(last + 1, node);
            }
        }
        Ok(id)
    }

    pub fn add_layer(&mut self, name: &str, above: u32) -> Result<u32, String> {
        self.add_node(name, above, false)
    }

    pub fn add_group(&mut self, name: &str, above: u32) -> Result<u32, String> {
        self.add_node(name, above, true)
    }

    pub fn group_nodes(&mut self, ids: &[u32]) -> Result<u32, String> {
        self.check_idle()?;
        if ids.is_empty() {
            return Err("group_nodes needs at least one node".into());
        }
        let mut seen = HashSet::new();
        let mut paths = Vec::with_capacity(ids.len());
        for &id in ids {
            if !seen.insert(id) {
                return Err(format!("node {id} listed twice"));
            }
            paths.push(self.find_path(id)?);
        }
        let prefix = paths[0][..paths[0].len() - 1].to_vec();
        if paths.iter().any(|p| p[..p.len() - 1] != prefix[..]) {
            return Err("every node must have the same parent".into());
        }
        let mut idx: Vec<usize> = paths.iter().map(|p| *p.last().expect("path")).collect();
        idx.sort_unstable();
        let pos = idx[idx.len() - 1] + 1 - idx.len();
        let gid = self.alloc_node_id();
        let list = list_mut(&mut self.nodes, &prefix);
        let mut taken: Vec<Node> = idx.iter().rev().map(|&i| list.remove(i)).collect();
        taken.reverse();
        list.insert(pos, Node::new(gid, "Group", Kind::Group(taken)));
        Ok(gid)
    }

    pub fn ungroup(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let path = self.find_path(id)?;
        let node = node_at(&self.nodes, &path);
        if !node.is_group() {
            return Err(format!("node {id} is not a group"));
        }
        let empty = match &node.kind {
            Kind::Group(ch) => ch.is_empty(),
            _ => false,
        };
        if empty && path.len() == 1 && self.nodes.len() == 1 {
            return Err("the document must keep at least one root node".into());
        }
        let (last, prefix) = path.split_last().expect("path");
        let list = list_mut(&mut self.nodes, prefix);
        let node = list.remove(*last);
        let Kind::Group(children) = node.kind else { unreachable!("checked above") };
        for (k, c) in children.into_iter().enumerate() {
            list.insert(last + k, c);
        }
        Ok(())
    }

    pub fn delete_node(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let path = self.find_path(id)?;
        if path.len() == 1 && self.nodes.len() == 1 {
            return Err("the document must keep at least one root node".into());
        }
        let (last, prefix) = path.split_last().expect("path");
        list_mut(&mut self.nodes, prefix).remove(*last);
        Ok(())
    }

    fn renumber(&mut self, node: &mut Node) {
        node.id = self.alloc_node_id();
        if let Kind::Group(children) = &mut node.kind {
            for c in children.iter_mut() {
                self.renumber(c);
            }
        }
    }

    pub fn duplicate_node(&mut self, id: u32) -> Result<u32, String> {
        self.check_idle()?;
        let path = self.find_path(id)?;
        let mut copy = node_at(&self.nodes, &path).clone();
        copy.name = format!("{} copy", copy.name);
        self.renumber(&mut copy);
        let new_id = copy.id;
        let (last, prefix) = path.split_last().expect("path");
        list_mut(&mut self.nodes, prefix).insert(last + 1, copy);
        Ok(new_id)
    }

    pub fn move_node(&mut self, id: u32, parent: u32, index: u32) -> Result<(), String> {
        self.check_idle()?;
        let src = self.find_path(id)?;
        let mut dst: Vec<usize> = if parent == 0 {
            Vec::new()
        } else {
            let p = self.find_path(parent)?;
            if !node_at(&self.nodes, &p).is_group() {
                return Err(format!("node {parent} is not a group"));
            }
            if p.len() >= src.len() && p[..src.len()] == src[..] {
                return Err("cannot move a node into itself or its own descendant".into());
            }
            p
        };
        if src.len() == 1 && self.nodes.len() == 1 && !dst.is_empty() {
            return Err("the document must keep at least one root node".into());
        }
        let (last, prefix) = src.split_last().expect("path");
        let same_list = dst[..] == prefix[..];
        let room = list_mut(&mut self.nodes, &dst).len() - usize::from(same_list);
        let index = index as usize;
        if index > room {
            return Err(format!("index {index} is out of range 0..={room}"));
        }
        // Removing from the source list shifts a destination path that walks through it.
        if dst.len() > prefix.len() && dst[..prefix.len()] == prefix[..] && dst[prefix.len()] > *last {
            dst[prefix.len()] -= 1;
        }
        let node = list_mut(&mut self.nodes, prefix).remove(*last);
        list_mut(&mut self.nodes, &dst).insert(index, node);
        Ok(())
    }

    pub fn set_props(&mut self, id: u32, json: &str) -> Result<(), String> {
        self.check_idle()?;
        let p: PropsIn = serde_json::from_str(json).map_err(|e| format!("invalid props: {e}"))?;
        let blend = match &p.blend {
            Some(s) => Some(Blend::parse(s)?),
            None => None,
        };
        let opacity = match p.opacity {
            Some(v) => Some(unit(v, "opacity")?),
            None => None,
        };
        let fill = match p.fill {
            Some(v) => Some(unit(v, "fill")?),
            None => None,
        };
        let node = self.node_mut(id)?;
        let group = node.is_group();
        if blend == Some(Blend::PassThrough) && !group {
            return Err("pass through is only allowed on groups".into());
        }
        if let Some(f) = fill {
            if group && f != 1.0 {
                return Err("groups ignore fill and always store 1".into());
            }
            node.fill = f;
        }
        if let Some(n) = p.name {
            node.name = n;
        }
        if let Some(v) = p.visible {
            node.visible = v;
        }
        if let Some(v) = opacity {
            node.opacity = v;
        }
        if let Some(b) = blend {
            node.blend = b;
        }
        if let Some(c) = p.clipping {
            node.clipping = c;
        }
        if let Some(l) = p.locks {
            if let Some(v) = l.transparency {
                node.locks.transparency = v;
            }
            if let Some(v) = l.pixels {
                node.locks.pixels = v;
            }
            if let Some(v) = l.position {
                node.locks.position = v;
            }
        }
        if let Some(v) = p.mask_enabled {
            let m = node.mask.as_mut().ok_or_else(|| format!("node {id} has no mask"))?;
            m.enabled = v;
        }
        Ok(())
    }

    pub fn add_mask(&mut self, id: u32, reveal: bool) -> Result<(), String> {
        self.check_idle()?;
        let slots = self.slots();
        let max = max_value(self.depth);
        let node = self.node_mut(id)?;
        if node.mask.is_some() {
            return Err(format!("node {id} already has a mask"));
        }
        node.mask = Some(Mask {
            enabled: true,
            default: if reveal { max } else { 0 },
            tiles: vec![None; slots],
        });
        Ok(())
    }

    pub fn delete_mask(&mut self, id: u32) -> Result<(), String> {
        self.check_idle()?;
        let node = self.node_mut(id)?;
        if node.mask.take().is_none() {
            return Err(format!("node {id} has no mask"));
        }
        Ok(())
    }

    fn check_pixel_edit(&self, id: u32) -> Result<(), String> {
        let node = self.node(id)?;
        if node.is_group() {
            return Err(format!("node {id} is a group and has no pixels"));
        }
        if node.locks.pixels {
            return Err("layer pixels are locked".into());
        }
        Ok(())
    }

    pub fn fill(&mut self, id: u32, target: Target, r: u8, g: u8, b: u8, a: u8) -> Result<(), String> {
        self.check_idle()?;
        let depth = self.depth;
        if target == Target::Mask {
            let value = if depth == 8 { r as u32 } else { r as u32 * 257 };
            if self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?.default == value {
                let m = self.node_mut(id)?.mask.as_mut().expect("checked");
                for slot in m.tiles.iter_mut() {
                    *slot = None;
                }
                return Ok(());
            }
            let tile_id = self.alloc_tile_id();
            let m = self.node_mut(id)?.mask.as_mut().expect("checked");
            let px = Arc::new(Pixels::mask_const(depth, value));
            for slot in m.tiles.iter_mut() {
                *slot = Some(Tile { id: tile_id, px: px.clone() });
            }
            return Ok(());
        }
        self.check_pixel_edit(id)?;
        let keep_alpha = self.node(id)?.locks.transparency;
        if keep_alpha {
            let fresh = self.remap_tiles(id, Target::Pixels, |px| px.recolored(r, g, b))?;
            let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
            for (i, t) in fresh {
                tiles[i] = Some(t);
            }
            return Ok(());
        }
        let tile_id = self.alloc_tile_id();
        let node = self.node_mut(id)?;
        let tiles = node.pixel_tiles_mut()?;
        if a == 0 {
            for slot in tiles.iter_mut() {
                *slot = None;
            }
            return Ok(());
        }
        let mut rgba = vec![0u8; TILE_BYTES_U8];
        for px in rgba.chunks_exact_mut(4) {
            px.copy_from_slice(&[r, g, b, a]);
        }
        let px = Arc::new(Pixels::from_rgba8(depth, &rgba));
        for slot in tiles.iter_mut() {
            *slot = Some(Tile { id: tile_id, px: px.clone() });
        }
        Ok(())
    }

    // Copy on write: every source tile id maps to one new tile, so shared tiles stay shared.
    fn remap_tiles(
        &mut self,
        id: u32,
        target: Target,
        f: impl Fn(&Pixels) -> Pixels,
    ) -> Result<Vec<(usize, Tile)>, String> {
        let node = self.node(id)?;
        let src: Vec<(usize, u64, Arc<Pixels>)> = match target {
            Target::Pixels => node.pixel_tiles()?,
            Target::Mask => &node.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?.tiles,
        }
        .iter()
        .enumerate()
        .filter_map(|(i, t)| t.as_ref().map(|t| (i, t.id, t.px.clone())))
        .collect();
        let mut memo: HashMap<u64, Tile> = HashMap::new();
        let mut out = Vec::with_capacity(src.len());
        for (i, tid, px) in src {
            let tile = match memo.get(&tid) {
                Some(t) => t.clone(),
                None => {
                    let t = Tile { id: self.alloc_tile_id(), px: Arc::new(f(&px)) };
                    memo.insert(tid, t.clone());
                    t
                }
            };
            out.push((i, tile));
        }
        Ok(out)
    }

    pub fn invert(&mut self, id: u32, target: Target) -> Result<(), String> {
        self.check_idle()?;
        if target == Target::Pixels {
            self.check_pixel_edit(id)?;
        } else if self.node(id)?.mask.is_none() {
            return Err(format!("node {id} has no mask"));
        }
        let max = max_value(self.depth);
        let fresh = self.remap_tiles(id, target, |px| px.inverted())?;
        let node = self.node_mut(id)?;
        match target {
            Target::Pixels => {
                let tiles = node.pixel_tiles_mut()?;
                for (i, t) in fresh {
                    tiles[i] = Some(t);
                }
            }
            Target::Mask => {
                let m = node.mask.as_mut().expect("checked");
                m.default = max - m.default;
                for (i, t) in fresh {
                    m.tiles[i] = Some(t);
                }
            }
        }
        Ok(())
    }

    fn check_tile_coord(&self, tx: u32, ty: u32) -> Result<usize, String> {
        if tx >= self.tiles_x() || ty >= self.tiles_y() {
            return Err("tile coordinate out of range".into());
        }
        Ok((ty * self.tiles_x() + tx) as usize)
    }

    pub fn set_tile_rgba8(&mut self, id: u32, tx: u32, ty: u32, data: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        let slot = self.check_tile_coord(tx, ty)?;
        if data.len() != TILE_BYTES_U8 {
            return Err(format!("expected {TILE_BYTES_U8} bytes, got {}", data.len()));
        }
        self.node(id)?.pixel_tiles()?;
        let transparent = data.chunks_exact(4).all(|px| px[3] == 0);
        let tile_id = if transparent { 0 } else { self.alloc_tile_id() };
        let depth = self.depth;
        let tiles = self.node_mut(id)?.pixel_tiles_mut()?;
        tiles[slot] = if transparent {
            None
        } else {
            Some(Tile { id: tile_id, px: Arc::new(Pixels::from_rgba8(depth, data)) })
        };
        Ok(())
    }

    pub fn set_mask_tile8(&mut self, id: u32, tx: u32, ty: u32, data: &[u8]) -> Result<(), String> {
        self.check_idle()?;
        let slot = self.check_tile_coord(tx, ty)?;
        if data.len() != MASK_BYTES_U8 {
            return Err(format!("expected {MASK_BYTES_U8} bytes, got {}", data.len()));
        }
        let depth = self.depth;
        let default8 = {
            let m = self.node(id)?.mask.as_ref().ok_or_else(|| format!("node {id} has no mask"))?;
            if depth == 8 {
                m.default
            } else {
                m.default / 257
            }
        };
        let uniform = data.iter().all(|v| *v as u32 == default8);
        let tile_id = if uniform { 0 } else { self.alloc_tile_id() };
        let m = self.node_mut(id)?.mask.as_mut().expect("checked");
        m.tiles[slot] = if uniform {
            None
        } else {
            Some(Tile { id: tile_id, px: Arc::new(Pixels::from_mask8(depth, data)) })
        };
        Ok(())
    }

    // ---------- compositing ----------

    fn node_src<'a>(&'a self, node: &'a Node, c: &TileCtx) -> SrcOwned<'a> {
        match &node.kind {
            Kind::Pixel(tiles) => match &tiles[c.slot] {
                Some(t) => SrcOwned::Tile(&t.px),
                None => SrcOwned::Empty,
            },
            Kind::Group(children) => {
                let mut g = vec![0f32; TILE_PIXELS * 4];
                self.composite_list(children, &mut g, c);
                SrcOwned::Buf(g)
            }
        }
    }

    fn draw_node(&self, node: &Node, dst: &mut [f32], c: &TileCtx, scale: f32, mode: Blend, shape: Option<&[f32]>) {
        let m = mask_src(node, self.depth, c.slot);
        if mode == Blend::PassThrough && shape.is_none() {
            let Kind::Group(children) = &node.kind else { return };
            let mut r = dst.to_vec();
            self.composite_list(children, &mut r, c);
            for y in 0..c.vh {
                for x in 0..c.vw {
                    let p = y * TILE + x;
                    let k = scale * m.at(p);
                    if k <= 0.0 {
                        continue;
                    }
                    let o = p * 4;
                    for ch in 0..4 {
                        dst[o + ch] += (r[o + ch] - dst[o + ch]) * k;
                    }
                }
            }
            return;
        }
        let owned = self.node_src(node, c);
        let Some(src) = owned.as_src() else { return };
        let mode = if mode == Blend::PassThrough { Blend::Normal } else { mode };
        draw(dst, src, &m, shape, scale, mode, node.id, c);
    }

    // A clipping group: base B plus the consecutive clipped nodes above it (M1.md section 3).
    fn draw_clipping_group(&self, base: &Node, clipped: &[Node], dst: &mut [f32], c: &TileCtx) {
        let bmask = mask_src(base, self.depth, c.slot);
        let owned = self.node_src(base, c);
        let Some(bsrc) = owned.as_src() else { return };
        let mut shape = vec![0f32; TILE_PIXELS];
        for y in 0..c.vh {
            for x in 0..c.vw {
                let p = y * TILE + x;
                shape[p] = bsrc.at(p)[3] * bmask.at(p);
            }
        }
        let mut g = vec![0f32; TILE_PIXELS * 4];
        draw(&mut g, bsrc, &bmask, None, base.eff_fill(), Blend::Normal, base.id, c);
        for n in clipped {
            if n.visible && n.opacity > 0.0 {
                self.draw_node(n, &mut g, c, n.opacity * n.eff_fill(), n.blend, Some(&shape));
            }
        }
        // Pass through has no meaning for a clipping base: the group is already isolated here.
        let mode = if base.blend == Blend::PassThrough { Blend::Normal } else { base.blend };
        draw(dst, Src::Buf(&g), &MaskSrc::Full, None, base.opacity, mode, base.id, c);
    }

    fn composite_list(&self, nodes: &[Node], dst: &mut [f32], c: &TileCtx) {
        let mut i = 0;
        while i < nodes.len() {
            let mut j = i + 1;
            while j < nodes.len() && nodes[j].clipping {
                j += 1;
            }
            let base = &nodes[i];
            if j == i + 1 {
                if base.visible && base.opacity > 0.0 {
                    self.draw_node(base, dst, c, base.opacity * base.eff_fill(), base.blend, None);
                }
            } else if base.visible {
                self.draw_clipping_group(base, &nodes[i + 1..j], dst, c);
            }
            i = j;
        }
    }

    fn list_has_content(nodes: &[Node], slot: usize) -> bool {
        nodes.iter().any(|n| {
            n.visible
                && n.opacity > 0.0
                && match &n.kind {
                    Kind::Pixel(tiles) => tiles[slot].is_some(),
                    Kind::Group(ch) => Document::list_has_content(ch, slot),
                }
        })
    }

    fn slot_has_visible_tile(&self, tx: u32, ty: u32) -> bool {
        let slot = (ty * self.tiles_x() + tx) as usize;
        Document::list_has_content(&self.nodes, slot)
    }

    // Composites one level-0 tile bottom-to-top into a premultiplied f32 buffer.
    // Pixels outside the document rect (in an edge tile) are left as 0 (transparent).
    fn composite_tile_premul(&self, tx: u32, ty: u32) -> Vec<f32> {
        let mut out = vec![0f32; TILE_PIXELS * 4];
        let c = TileCtx {
            slot: (ty * self.tiles_x() + tx) as usize,
            ox: tx * TILE as u32,
            oy: ty * TILE as u32,
            vw: ((self.width - tx * TILE as u32).min(TILE as u32)) as usize,
            vh: ((self.height - ty * TILE as u32).min(TILE as u32)) as usize,
        };
        self.composite_list(&self.nodes, &mut out, &c);
        out
    }

    pub fn display_tile(&self, level: u32, tx: u32, ty: u32) -> Result<Option<Vec<u8>>, String> {
        if level > 8 {
            return Err("level must be <= 8".into());
        }
        let n = 1u32 << level;
        let sub = (TILE as u32) >> level;
        let tiles_x = self.tiles_x();
        let tiles_y = self.tiles_y();
        let mut out = vec![0f32; TILE_PIXELS * 4];
        for lj in 0..n {
            let sy = ty * n + lj;
            if sy >= tiles_y {
                continue;
            }
            for li in 0..n {
                let sx = tx * n + li;
                if sx >= tiles_x || !self.slot_has_visible_tile(sx, sy) {
                    continue;
                }
                let src = self.composite_tile_premul(sx, sy);
                let cnt = (n * n) as f32;
                for oy in 0..sub {
                    for ox in 0..sub {
                        let mut acc = [0f32; 4];
                        for dy in 0..n {
                            for dx in 0..n {
                                let spx = (oy * n + dy) as usize * TILE + (ox * n + dx) as usize;
                                let o = spx * 4;
                                acc[0] += src[o];
                                acc[1] += src[o + 1];
                                acc[2] += src[o + 2];
                                acc[3] += src[o + 3];
                            }
                        }
                        let ooy = (lj * sub + oy) as usize;
                        let oox = (li * sub + ox) as usize;
                        let oo = (ooy * TILE + oox) * 4;
                        out[oo] = acc[0] / cnt;
                        out[oo + 1] = acc[1] / cnt;
                        out[oo + 2] = acc[2] / cnt;
                        out[oo + 3] = acc[3] / cnt;
                    }
                }
            }
        }
        let mut bytes = vec![0u8; TILE_BYTES_U8];
        let mut any_alpha = false;
        for p in 0..TILE_PIXELS {
            let o = p * 4;
            for c in 0..4 {
                bytes[o + c] = (out[o + c] * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            if bytes[o + 3] != 0 {
                any_alpha = true;
            }
        }
        if !any_alpha {
            return Ok(None);
        }
        Ok(Some(bytes))
    }

    pub fn flatten_tile_rgba8(&self, tx: u32, ty: u32) -> Result<Vec<u8>, String> {
        self.check_tile_coord(tx, ty)?;
        let premul = self.composite_tile_premul(tx, ty);
        let mut bytes = vec![0u8; TILE_BYTES_U8];
        for p in 0..TILE_PIXELS {
            let o = p * 4;
            let a = premul[o + 3];
            let (r, g, b) = if a > 0.0 {
                (premul[o] / a, premul[o + 1] / a, premul[o + 2] / a)
            } else {
                (0.0, 0.0, 0.0)
            };
            bytes[o] = (r * 255.0).round().clamp(0.0, 255.0) as u8;
            bytes[o + 1] = (g * 255.0).round().clamp(0.0, 255.0) as u8;
            bytes[o + 2] = (b * 255.0).round().clamp(0.0, 255.0) as u8;
            bytes[o + 3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
        Ok(bytes)
    }

    // ---------- persistence ----------

    fn node_out<'a>(n: &'a Node, tiles_out: bool) -> NodeOut<'a> {
        NodeOut {
            id: n.id,
            name: &n.name,
            kind: if n.is_group() { "group" } else { "pixel" },
            visible: n.visible,
            opacity: n.opacity,
            fill: n.fill,
            blend: n.blend.name(),
            clipping: n.clipping,
            locks: n.locks,
            mask: n.mask.as_ref().map(|m| MaskOut {
                enabled: m.enabled,
                default: m.default,
                tiles: if tiles_out { Some(ids_of(&m.tiles)) } else { None },
            }),
            tiles: match (&n.kind, tiles_out) {
                (Kind::Pixel(t), true) => Some(ids_of(t)),
                _ => None,
            },
            children: match &n.kind {
                Kind::Group(ch) => Some(ch.iter().map(|c| Document::node_out(c, tiles_out)).collect()),
                Kind::Pixel(_) => None,
            },
        }
    }

    pub fn manifest(&self) -> String {
        let m = ManifestOut {
            format: MANIFEST_FORMAT,
            version: MANIFEST_VERSION,
            width: self.width,
            height: self.height,
            depth: self.depth,
            tiles_x: self.tiles_x(),
            tiles_y: self.tiles_y(),
            next_id: self.next_id,
            next_node_id: self.next_node_id,
            layers: self.nodes.iter().map(|n| Document::node_out(n, true)).collect(),
        };
        serde_json::to_string(&m).expect("manifest serialization cannot fail")
    }

    /// The layer tree for the UI: manifest fields without the tile arrays.
    pub fn layers_json(&self) -> String {
        let tree: Vec<NodeOut> = self.nodes.iter().map(|n| Document::node_out(n, false)).collect();
        serde_json::to_string(&tree).expect("layer tree serialization cannot fail")
    }

    fn tile_bytes_in(nodes: &[Node], id: u64) -> Option<Vec<u8>> {
        for n in nodes {
            if let Kind::Pixel(tiles) = &n.kind {
                if let Some(t) = tiles.iter().flatten().find(|t| t.id == id) {
                    return Some(t.px.to_bytes());
                }
            }
            if let Some(m) = &n.mask {
                if let Some(t) = m.tiles.iter().flatten().find(|t| t.id == id) {
                    return Some(t.px.to_bytes());
                }
            }
            if let Kind::Group(ch) = &n.kind {
                if let Some(b) = Document::tile_bytes_in(ch, id) {
                    return Some(b);
                }
            }
        }
        None
    }

    pub fn tile_bytes(&self, id: u64) -> Result<Vec<u8>, String> {
        Document::tile_bytes_in(&self.nodes, id).ok_or_else(|| format!("unknown tile id {id}"))
    }

    pub fn from_manifest(json: &str) -> Result<Document, String> {
        let probe: VersionProbe = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
        if probe.format != MANIFEST_FORMAT {
            return Err(format!("unexpected format {}", probe.format));
        }
        match probe.version {
            1 => {
                let m: ManifestV1In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                let nodes: Vec<NodeIn> = m
                    .layers
                    .iter()
                    .enumerate()
                    .map(|(i, l)| NodeIn {
                        id: i as u32 + 1,
                        name: l.name.clone(),
                        kind: "pixel".into(),
                        visible: l.visible,
                        opacity: l.opacity,
                        fill: 1.0,
                        blend: "normal".into(),
                        clipping: false,
                        locks: Locks::default(),
                        mask: None,
                        tiles: Some(l.tiles.clone()),
                        children: None,
                    })
                    .collect();
                Document::build(m.width, m.height, m.depth, m.tiles_x, m.tiles_y, m.next_id, nodes.len() as u32 + 1, nodes)
            }
            2 => {
                let m: ManifestV2In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                Document::build(m.width, m.height, m.depth, m.tiles_x, m.tiles_y, m.next_id, m.next_node_id, m.layers)
            }
            v => Err(format!("unsupported version {v}")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        width: u32,
        height: u32,
        depth: u8,
        tiles_x: u32,
        tiles_y: u32,
        next_id: u64,
        next_node_id: u32,
        layers: Vec<NodeIn>,
    ) -> Result<Document, String> {
        validate_dims(width, height, depth)?;
        if tiles_for(width) != tiles_x || tiles_for(height) != tiles_y {
            return Err("tiles_x/tiles_y do not match width/height".into());
        }
        if next_id > MAX_ID {
            return Err("next_id out of range".into());
        }
        if layers.is_empty() {
            return Err("the document must have at least one root node".into());
        }
        let mut ctx = LoadCtx {
            expected: (tiles_x * tiles_y) as usize,
            max_mask: max_value(depth),
            node_ids: HashSet::new(),
            max_node_id: 0,
            kinds: HashMap::new(),
            slots: HashMap::new(),
            max_referenced_id: 0,
        };
        let mut path = Vec::new();
        let nodes = build_nodes(&layers, &mut path, &mut ctx)?;
        if next_node_id <= ctx.max_node_id {
            return Err("next_node_id must be greater than every node id".into());
        }
        let pending_ids: HashSet<u64> = ctx.slots.keys().copied().collect();
        Ok(Document {
            width,
            height,
            depth,
            nodes,
            next_id,
            next_node_id,
            loading: Some(Loading {
                slots: ctx.slots,
                pending_ids,
                max_referenced_id: ctx.max_referenced_id,
            }),
        })
    }

    pub fn put_tile(&mut self, id: u64, bytes: &[u8]) -> Result<(), String> {
        let depth = self.depth;
        let loading = self.loading.as_ref().ok_or("document is not loading")?;
        let (is_mask, slots) = loading
            .slots
            .get(&id)
            .ok_or_else(|| format!("unknown tile id {id}"))?
            .clone();
        let px = Arc::new(Pixels::from_bytes(depth, is_mask, bytes)?);
        for (path, slot) in slots {
            let node = node_at_mut(&mut self.nodes, &path);
            if is_mask {
                node.mask.as_mut().expect("mask exists when a mask tile refers to it").tiles[slot] =
                    Some(Tile { id, px: px.clone() });
            } else {
                node.pixel_tiles_mut()?[slot] = Some(Tile { id, px: px.clone() });
            }
        }
        self.loading.as_mut().expect("still loading").pending_ids.remove(&id);
        Ok(())
    }

    pub fn finish_load(&mut self) -> Result<(), String> {
        let loading = self.loading.take().ok_or("document is not loading")?;
        if !loading.pending_ids.is_empty() {
            self.loading = Some(loading);
            return Err("not all referenced tiles were loaded".into());
        }
        self.next_id = self.next_id.max(loading.max_referenced_id + 1);
        Ok(())
    }
}

fn ids_of(tiles: &[Option<Tile>]) -> Vec<u64> {
    tiles.iter().map(|t| t.as_ref().map_or(0, |t| t.id)).collect()
}

struct LoadCtx {
    expected: usize,
    max_mask: u32,
    node_ids: HashSet<u32>,
    max_node_id: u32,
    // tile id -> is_mask, so no id is used as both RGBA and mask data.
    kinds: HashMap<u64, bool>,
    slots: HashMap<u64, (bool, Vec<(Vec<usize>, usize)>)>,
    max_referenced_id: u64,
}

fn take_tiles(ids: &[u64], is_mask: bool, path: &[usize], ctx: &mut LoadCtx) -> Result<Vec<Option<Tile>>, String> {
    if ids.len() != ctx.expected {
        return Err("tile array length does not match tiles_x*tiles_y".into());
    }
    for (slot, &id) in ids.iter().enumerate() {
        if id == 0 {
            continue;
        }
        if id > MAX_ID {
            return Err(format!("tile id {id} out of range"));
        }
        match ctx.kinds.insert(id, is_mask) {
            Some(prev) if prev != is_mask => {
                return Err(format!("tile id {id} is used as both pixel and mask data"))
            }
            _ => {}
        }
        let entry = ctx.slots.entry(id).or_insert_with(|| (is_mask, Vec::new()));
        entry.1.push((path.to_vec(), slot));
        ctx.max_referenced_id = ctx.max_referenced_id.max(id);
    }
    Ok(vec![None; ctx.expected])
}

fn build_nodes(in_nodes: &[NodeIn], path: &mut Vec<usize>, ctx: &mut LoadCtx) -> Result<Vec<Node>, String> {
    let mut out = Vec::with_capacity(in_nodes.len());
    for (i, n) in in_nodes.iter().enumerate() {
        if n.id == 0 {
            return Err("node id 0 is not allowed".into());
        }
        if !ctx.node_ids.insert(n.id) {
            return Err(format!("duplicate node id {}", n.id));
        }
        ctx.max_node_id = ctx.max_node_id.max(n.id);
        let blend = Blend::parse(&n.blend)?;
        unit(n.opacity, "opacity")?;
        unit(n.fill, "fill")?;
        path.push(i);
        let kind = match n.kind.as_str() {
            "pixel" => {
                if blend == Blend::PassThrough {
                    return Err("pass through is only allowed on groups".into());
                }
                if n.children.is_some() {
                    return Err("a pixel node cannot have children".into());
                }
                let ids = n.tiles.as_ref().ok_or("a pixel node needs a tiles array")?;
                Kind::Pixel(take_tiles(ids, false, path, ctx)?)
            }
            "group" => {
                if n.tiles.is_some() {
                    return Err("a group cannot have a tiles array".into());
                }
                let children = n.children.as_deref().ok_or("a group needs a children array")?;
                Kind::Group(build_nodes(children, path, ctx)?)
            }
            other => return Err(format!("unknown node kind {other}")),
        };
        let mask = match &n.mask {
            None => None,
            Some(m) => {
                if m.default > ctx.max_mask {
                    return Err("mask default out of range".into());
                }
                Some(Mask {
                    enabled: m.enabled,
                    default: m.default,
                    tiles: take_tiles(&m.tiles, true, path, ctx)?,
                })
            }
        };
        path.pop();
        out.push(Node {
            id: n.id,
            name: n.name.clone(),
            visible: n.visible,
            opacity: n.opacity,
            fill: n.fill,
            blend,
            clipping: n.clipping,
            locks: n.locks,
            mask,
            kind,
        });
    }
    Ok(out)
}

// ---------- serde types ----------

#[derive(Deserialize)]
struct VersionProbe {
    format: String,
    version: u32,
}

#[derive(Serialize)]
struct MaskOut {
    enabled: bool,
    default: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tiles: Option<Vec<u64>>,
}

#[derive(Serialize)]
struct NodeOut<'a> {
    id: u32,
    name: &'a str,
    kind: &'static str,
    visible: bool,
    opacity: f32,
    fill: f32,
    blend: &'static str,
    clipping: bool,
    locks: Locks,
    mask: Option<MaskOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tiles: Option<Vec<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<NodeOut<'a>>>,
}

#[derive(Serialize)]
struct ManifestOut<'a> {
    format: &'a str,
    version: u32,
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
    next_id: u64,
    next_node_id: u32,
    layers: Vec<NodeOut<'a>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MaskIn {
    enabled: bool,
    default: u32,
    tiles: Vec<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeIn {
    id: u32,
    name: String,
    kind: String,
    visible: bool,
    opacity: f32,
    fill: f32,
    blend: String,
    clipping: bool,
    locks: Locks,
    #[serde(default)]
    mask: Option<MaskIn>,
    #[serde(default)]
    tiles: Option<Vec<u64>>,
    #[serde(default)]
    children: Option<Vec<NodeIn>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestV2In {
    #[allow(dead_code)]
    format: String,
    #[allow(dead_code)]
    version: u32,
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
    next_id: u64,
    next_node_id: u32,
    layers: Vec<NodeIn>,
}

#[derive(Deserialize)]
struct ManifestV1LayerIn {
    name: String,
    visible: bool,
    opacity: f32,
    tiles: Vec<u64>,
}

#[derive(Deserialize)]
struct ManifestV1In {
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
    next_id: u64,
    layers: Vec<ManifestV1LayerIn>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LocksIn {
    #[serde(default)]
    transparency: Option<bool>,
    #[serde(default)]
    pixels: Option<bool>,
    #[serde(default)]
    position: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PropsIn {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    visible: Option<bool>,
    #[serde(default)]
    opacity: Option<f32>,
    #[serde(default)]
    fill: Option<f32>,
    #[serde(default)]
    blend: Option<String>,
    #[serde(default)]
    clipping: Option<bool>,
    #[serde(default)]
    locks: Option<LocksIn>,
    #[serde(default)]
    mask_enabled: Option<bool>,
}

/// Host-testable core behind the wasm `Engine`: current document plus live
/// snapshots. Kept here (not in lib.rs) so `cargo test` covers it directly.
pub struct EngineCore {
    pub doc: Document,
    snapshots: HashMap<u32, Document>,
    next_snapshot_id: u32,
}

impl EngineCore {
    pub fn new(doc: Document) -> EngineCore {
        EngineCore {
            doc,
            snapshots: HashMap::new(),
            next_snapshot_id: 0,
        }
    }

    pub fn snapshot(&mut self) -> u32 {
        let id = self.next_snapshot_id;
        self.next_snapshot_id += 1;
        self.snapshots.insert(id, self.doc.clone());
        id
    }

    pub fn restore(&mut self, id: u32) -> Result<(), String> {
        let snap = self.snapshots.get(&id).ok_or_else(|| format!("unknown snapshot {id}"))?;
        // Ids must never go backwards, so they stay unique across restores.
        let next_id = self.doc.next_id.max(snap.next_id);
        let next_node_id = self.doc.next_node_id.max(snap.next_node_id);
        let mut restored = snap.clone();
        restored.next_id = next_id;
        restored.next_node_id = next_node_id;
        self.doc = restored;
        Ok(())
    }

    pub fn drop_snapshot(&mut self, id: u32) {
        self.snapshots.remove(&id);
    }

    // Searches the current document first, then every live snapshot: an
    // autosave can hold a snapshot's tile ids after the live doc drops them.
    pub fn tile_bytes(&self, id: u64) -> Result<Vec<u8>, String> {
        if let Ok(bytes) = self.doc.tile_bytes(id) {
            return Ok(bytes);
        }
        for snap in self.snapshots.values() {
            if let Ok(bytes) = snap.tile_bytes(id) {
                return Ok(bytes);
            }
        }
        Err(format!("unknown tile id {id}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

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

    fn manifest_value(d: &Document) -> Value {
        serde_json::from_str(&d.manifest()).unwrap()
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
        let mut d = Document::new(300, 300, 8).unwrap();
        d.fill(1, Target::Pixels, 255, 0, 0, 255).unwrap();
        let px = d.display_tile(0, 0, 0).unwrap().unwrap();
        assert_eq!(&px[0..4], &[255, 0, 0, 255]);
        let ids: Vec<u64> = manifest_value(&d)["layers"][0]["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
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
        let new_id = manifest_value(&restored)["layers"][0]["tiles"][0].as_u64().unwrap();
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
        let id = manifest_value(&d)["layers"][0]["tiles"][0].as_u64().unwrap();
        assert_eq!(d.tile_bytes(id).unwrap().len(), TILE_BYTES_U16);
    }

    #[test]
    fn transparent_tile_write_clears_slot() {
        let mut d = Document::new(256, 256, 8).unwrap();
        d.set_tile_rgba8(1, 0, 0, &vec![0u8; TILE_BYTES_U8]).unwrap();
        assert_eq!(manifest_value(&d)["layers"][0]["tiles"][0].as_u64().unwrap(), 0);
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
        let old_id = manifest_value(&d)["layers"][0]["tiles"][0].as_u64().unwrap();
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
        let pix = m["layers"][1]["children"][0]["tiles"][0].as_u64().unwrap();
        let msk = m["layers"][1]["children"][0]["mask"]["tiles"][0].as_u64().unwrap();
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
        assert_eq!(ids[1].as_u64().unwrap(), 0, "the empty tile stays empty");
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
        let src = m["layers"][1]["children"][0]["tiles"][0].as_u64().unwrap();
        let dup = m["layers"][2]["children"][0]["tiles"][0].as_u64().unwrap();
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
        assert!(d.set_props(g, r#"{"fill":0.5}"#).is_err());
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
        if let Some(a) = v["tiles"].as_array() {
            ids.extend(a.iter().filter_map(|i| i.as_u64()).filter(|i| *i != 0));
        }
        if let Some(a) = v["mask"]["tiles"].as_array() {
            ids.extend(a.iter().filter_map(|i| i.as_u64()).filter(|i| *i != 0));
        }
        if let Some(ch) = v["children"].as_array() {
            for c in ch {
                collect_ids(c, ids);
            }
        }
    }

    fn loaded_copy(d: &Document) -> Document {
        let manifest = d.manifest();
        let mut l = Document::from_manifest(&manifest).unwrap();
        let m: Value = serde_json::from_str(&manifest).unwrap();
        let mut ids: HashSet<u64> = HashSet::new();
        for n in m["layers"].as_array().unwrap() {
            collect_ids(n, &mut ids);
        }
        assert!(l.finish_load().is_err(), "loading is not done before every tile arrived");
        for id in ids {
            l.put_tile(id, &d.tile_bytes(id).unwrap()).unwrap();
        }
        l.finish_load().unwrap();
        assert_eq!(l.manifest(), manifest, "a v2 manifest must round trip byte for byte");
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
        let tile_id = manifest_value(&old)["layers"][0]["tiles"][0].as_u64().unwrap();
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
        assert_eq!(m["version"].as_u64().unwrap(), 2);
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
        let json = d.manifest().replacen("\"tiles\":[0]", &format!("\"tiles\":[{big}]"), 1);
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
        assert!(!l.manifest().contains("\"tiles\":[0]"));
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
            ("wrong tile array length", broken(|v| v["layers"][0]["tiles"] = serde_json::json!([1, 2]))),
            ("group with tiles", broken(|v| v["layers"][1]["tiles"] = serde_json::json!([0, 0, 0, 0, 0, 0]))),
            ("pixel node with children", broken(|v| v["layers"][0]["children"] = serde_json::json!([]))),
            ("unknown kind", broken(|v| v["layers"][0]["kind"] = "text".into())),
            ("opacity out of range", broken(|v| v["layers"][0]["opacity"] = 2.into())),
            ("unknown field", broken(|v| v["layers"][0]["extra"] = 1.into())),
            ("unsupported version", broken(|v| v["version"] = 3.into())),
            ("tiles_x mismatch", broken(|v| v["tiles_x"] = 9.into())),
        ];
        for (what, json) in cases {
            assert!(Document::from_manifest(&json).is_err(), "{what} must be rejected");
        }
        let d = rich_doc();
        let m: Value = serde_json::from_str(&d.manifest()).unwrap();
        let pixel_id = m["layers"][1]["children"][0]["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|v| v.as_u64().filter(|i| *i != 0))
            .unwrap();
        let json = broken(|v| {
            let mask = v["layers"][1]["children"][0]["mask"]["tiles"].as_array_mut().unwrap();
            let slot = mask.iter().position(|i| i.as_u64() != Some(0)).unwrap();
            mask[slot] = pixel_id.into();
        });
        assert!(
            matches!(Document::from_manifest(&json), Err(e) if e.contains("both pixel and mask")),
            "a tile id must not be used as both pixel and mask data"
        );
        let mut l = Document::from_manifest(&d.manifest()).unwrap();
        assert!(l.put_tile(pixel_id, &vec![0u8; MASK_BYTES_U8]).is_err());
        let mask_id = m["layers"][1]["children"][0]["mask"]["tiles"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|v| v.as_u64().filter(|i| *i != 0))
            .unwrap();
        assert!(l.put_tile(mask_id, &vec![0u8; TILE_BYTES_U8]).is_err());
        l.put_tile(mask_id, &vec![7u8; MASK_BYTES_U8]).unwrap();
        assert!(l.put_tile(999_999, &vec![7u8; MASK_BYTES_U8]).is_err());
    }

    #[test]
    fn commands_are_refused_while_the_document_is_loading() {
        let d = rich_doc();
        let manifest = d.manifest();
        let mut ids: HashSet<u64> = HashSet::new();
        let m: Value = serde_json::from_str(&manifest).unwrap();
        for n in m["layers"].as_array().unwrap() {
            collect_ids(n, &mut ids);
        }
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
}
