//! Manifest persistence (node output, blob references, save and load) and the serde types.
//! A child module of `doc`.

use super::*;
use crate::path::{Grid, Guide, SavedPath};

impl Document {
    // ---------- persistence ----------

    fn node_out<'a>(n: &'a Node, tiles_out: bool) -> NodeOut<'a> {
        let mask_out = move |m: &Mask| MaskOut {
            enabled: m.enabled,
            default: m.default,
            tiles: if tiles_out { Some(m.tiles.out()) } else { None },
        };
        NodeOut {
            id: n.id,
            name: &n.name,
            kind: n.kind_name(),
            visible: n.visible,
            opacity: n.opacity,
            fill: n.fill,
            blend: n.blend.name(),
            clipping: n.clipping,
            locks: n.locks,
            mask: n.mask.as_ref().map(mask_out),
            style: &n.style,
            blending: &n.blending,
            tiles: match (&n.kind, n.pixel_tiles(), tiles_out) {
                (Kind::Text(t), _, true) => t.cache.as_ref().map(|c| c.out()),
                (_, Ok(t), true) => Some(t.out()),
                _ => None,
            },
            vector_mask: &n.vector_mask,
            artboard: n.artboard.as_ref(),
            shape: match &n.kind {
                Kind::Shape(s) => Some(s),
                _ => None,
            },
            text: match &n.kind {
                Kind::Text(t) => Some(&t.data),
                _ => None,
            },
            children: match &n.kind {
                Kind::Group(ch) => Some(ch.iter().map(|c| Document::node_out(c, tiles_out)).collect()),
                _ => None,
            },
            adjustment: match &n.kind {
                Kind::Adjustment(a) => Some(a),
                _ => None,
            },
            content: match &n.kind {
                Kind::Fill(c) => Some(c),
                _ => None,
            },
            smart: match &n.kind {
                Kind::Smart(s) => Some(SmartOut {
                    link: &s.link,
                    source: SourceOut { blob: s.source_blob, tiles: tiles_out.then(|| s.source_tiles.out()) },
                    source_size: s.source_size,
                    transform: s.transform,
                    warp: &s.warp,
                    filters: s
                        .filters
                        .iter()
                        .map(|f| FilterOut {
                            id: f.id,
                            filter: &f.filter,
                            enabled: f.enabled,
                            opacity: f.opacity,
                            blend: f.blend,
                            mask: f.mask.as_ref().map(mask_out),
                            psd: &f.psd,
                        })
                        .collect(),
                    stack_mask: s.stack_mask.as_ref().map(mask_out),
                    stack_mode: s.stack_mode,
                }),
                _ => None,
            },
        }
    }

    // Every blob id the document references, ascending.
    fn blob_refs(&self) -> Vec<u64> {
        fn walk(nodes: &[Node], out: &mut Vec<u64>) {
            for n in nodes {
                match &n.kind {
                    Kind::Group(ch) => walk(ch, out),
                    Kind::Adjustment(a) => out.extend(a.blob()),
                    Kind::Smart(s) => {
                        out.extend(s.source_blob);
                        for f in &s.filters {
                            out.extend(f.filter.blob());
                            out.extend(f.psd.as_ref().and_then(|v| check_psd(v).ok()).unwrap_or_default());
                        }
                    }
                    Kind::Pixel(_) | Kind::Fill(_) | Kind::Shape(_) | Kind::Text(_) => {}
                }
            }
        }
        let mut out: Vec<u64> = self.patterns.iter().map(|p| p.blob).collect();
        walk(&self.nodes, &mut out);
        out.sort_unstable();
        out.dedup();
        out
    }

    /// Stores immutable bytes (a smart source, pattern pixels, a lookup table) under a new id
    /// from the tile counter; manifests list it once a node, pattern or filter references it.
    pub fn blob_add(&mut self, bytes: &[u8]) -> Result<u64, String> {
        self.check_idle()?;
        if bytes.is_empty() {
            return Err("a blob needs at least one byte".into());
        }
        let id = self.alloc_tile_id();
        self.blobs.insert(id, Arc::new(bytes.to_vec()));
        Ok(id)
    }

    pub(super) fn check_blob(&self, id: Option<u64>) -> Result<(), String> {
        match id {
            Some(id) if !self.blobs.contains_key(&id) => Err(format!("unknown blob {id}")),
            _ => Ok(()),
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
            selection: self.selection.as_ref().map(sel_out),
            last_selection: self.last_selection.as_ref().map(sel_out),
            channels: self
                .channels
                .iter()
                .map(|c| ChannelOut { id: c.id, name: &c.name, default: c.mask.default, tiles: c.mask.tiles.out(), spot: c.spot })
                .collect(),
            global_light: &self.global_light,
            patterns: &self.patterns,
            layer_comps: &self.layer_comps,
            blobs: self.blob_refs(),
            vector: &self.vector,
        };
        serde_json::to_string(&m).expect("manifest serialization cannot fail")
    }

    /// The selection state and the saved channels for the UI.
    pub fn channels_json(&self) -> String {
        let v = serde_json::json!({
            "selection": self.selection.as_ref().map(|s| serde_json::json!({
                "default": s.default,
                "bounds": self.selection_bounds(),
            })),
            "has_last_selection": self.last_selection.is_some(),
            "global_light": self.global_light,
            "channels": self.channels.iter().map(|c| serde_json::json!({ "id": c.id, "name": c.name, "default": c.mask.default, "spot": c.spot })).collect::<Vec<_>>(),
            "patterns": self.patterns.iter().map(|p| serde_json::json!({ "id": p.id, "name": p.name })).collect::<Vec<_>>(),
            "layer_comps": self.layer_comps.iter().map(|c| serde_json::json!({
                "id": c.id, "name": c.name, "layer_count": c.layers.len(),
            })).collect::<Vec<_>>(),
        });
        v.to_string()
    }

    /// The layer tree for the UI: manifest fields without the tile arrays.
    pub fn layers_json(&self) -> String {
        let tree: Vec<NodeOut> = self.nodes.iter().map(|n| Document::node_out(n, false)).collect();
        serde_json::to_string(&tree).expect("layer tree serialization cannot fail")
    }

    fn tile_bytes_in(nodes: &[Node], id: u64) -> Option<Vec<u8>> {
        for n in nodes {
            let mut planes: Vec<&Tiles> = n.pixel_tiles().into_iter().chain(n.mask.as_ref().map(|m| &m.tiles)).collect();
            if let Kind::Text(t) = &n.kind {
                planes.extend(t.cache.as_ref());
            }
            if let Kind::Smart(s) = &n.kind {
                planes.push(&s.source_tiles);
                let masks = s.filters.iter().filter_map(|f| f.mask.as_ref()).chain(s.stack_mask.as_ref());
                planes.extend(masks.map(|m| &m.tiles));
            }
            if let Some(b) = planes.into_iter().find_map(|t| find_tile(t, id)) {
                return Some(b);
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
        if let Some(b) = self.blobs.get(&id) {
            return Ok(b.to_vec());
        }
        Document::tile_bytes_in(&self.nodes, id)
            .or_else(|| {
                self.selection
                    .iter()
                    .chain(self.last_selection.iter())
                    .chain(self.channels.iter().map(|c| &c.mask))
                    .find_map(|s| find_tile(&s.tiles, id))
            })
            .ok_or_else(|| format!("unknown tile id {id}"))
    }

    pub fn from_manifest(json: &str) -> Result<Document, String> {
        let probe: VersionProbe = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
        if probe.format != MANIFEST_FORMAT {
            return Err(format!("unexpected format {}", probe.format));
        }
        match probe.version {
            1 => {
                let m: ManifestV1In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                let nodes: Vec<NodeIn<u64>> = m
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
                        style: None,
                        blending: None,
                        adjustment: None,
                        content: None,
                        smart: None,
                        vector_mask: None,
                        artboard: None,
                        shape: None,
                        text: None,
                    })
                    .collect();
                let layers = spread_nodes(nodes, m.tiles_x, m.tiles_y)?;
                Document::build(
                    Head { width: m.width, height: m.height, depth: m.depth, tiles_x: m.tiles_x, tiles_y: m.tiles_y },
                    m.next_id,
                    layers.len() as u32 + 1,
                    layers,
                    None,
                    None,
                    Vec::new(),
                    None,
                    None,
                    false,
                )
            }
            2 => {
                let m: ManifestV2In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                let layers = spread_nodes(m.layers, m.tiles_x, m.tiles_y)?;
                Document::build(
                    Head { width: m.width, height: m.height, depth: m.depth, tiles_x: m.tiles_x, tiles_y: m.tiles_y },
                    m.next_id,
                    m.next_node_id,
                    layers,
                    None,
                    None,
                    Vec::new(),
                    None,
                    None,
                    false,
                )
            }
            3 => {
                let m: ManifestV3In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                spot_needs_v8(3, &m.channels)?;
                Document::build(
                    Head { width: m.width, height: m.height, depth: m.depth, tiles_x: m.tiles_x, tiles_y: m.tiles_y },
                    m.next_id,
                    m.next_node_id,
                    m.layers,
                    m.selection,
                    m.last_selection,
                    m.channels,
                    None,
                    None,
                    false,
                )
            }
            4 => {
                let m: ManifestV4In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                spot_needs_v8(4, &m.channels)?;
                let extras = V4Extras {
                    global_light: m.global_light,
                    patterns: m.patterns,
                    layer_comps: m.layer_comps,
                    blobs: m.blobs,
                };
                Document::build(
                    Head { width: m.width, height: m.height, depth: m.depth, tiles_x: m.tiles_x, tiles_y: m.tiles_y },
                    m.next_id,
                    m.next_node_id,
                    m.layers,
                    m.selection,
                    m.last_selection,
                    m.channels,
                    Some(extras),
                    None,
                    false,
                )
            }
            5..=8 => {
                let m: ManifestV5In = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
                spot_needs_v8(probe.version, &m.channels)?;
                let extras = V4Extras {
                    global_light: m.global_light,
                    patterns: m.patterns,
                    layer_comps: m.layer_comps,
                    blobs: m.blobs,
                };
                let vector = DocVector {
                    resolution: m.resolution,
                    paths: m.paths,
                    guides: m.guides,
                    grid: m.grid,
                    guides_locked: m.guides_locked,
                    artboards_locked: m.artboards_locked,
                    vanishing_planes: m.vanishing_planes,
                    gray: m.gray,
                    mode: m.mode,
                    profile: m.profile,
                };
                if probe.version < 7 && !vector.vanishing_planes.is_empty() {
                    return Err("vanishing_planes need manifest v7".into());
                }
                if let Some(mode) = &vector.mode {
                    mode.check()?;
                    if m.depth == 32 {
                        return Err("a 32-bit document is RGB or Grayscale".into());
                    }
                }
                Document::build(
                    Head { width: m.width, height: m.height, depth: m.depth, tiles_x: m.tiles_x, tiles_y: m.tiles_y },
                    m.next_id,
                    m.next_node_id,
                    m.layers,
                    m.selection,
                    m.last_selection,
                    m.channels,
                    Some(extras),
                    Some(vector),
                    probe.version >= 6,
                )
            }
            v => Err(format!("unsupported version {v}")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        head: Head,
        next_id: u64,
        next_node_id: u32,
        layers: Vec<NodeIn<Coord>>,
        selection: Option<SelIn>,
        last_selection: Option<SelIn>,
        channels: Vec<ChannelIn>,
        extras: Option<V4Extras>,
        vector: Option<DocVector>,
        v6: bool,
    ) -> Result<Document, String> {
        let Head { width, height, depth, tiles_x, tiles_y } = head;
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
        let v5 = vector.is_some();
        let vector = vector.unwrap_or_default();
        vector.validate()?;
        let mut ctx = LoadCtx {
            max_mask: max_value(depth),
            canvas: (tiles_x, tiles_y),
            node_ids: HashSet::new(),
            max_node_id: 0,
            kinds: HashMap::new(),
            slots: HashMap::new(),
            max_referenced_id: 0,
            v4: extras.is_some(),
            v5,
            v6,
            vector,
            patterns: HashSet::new(),
            blob_refs: Vec::new(),
        };
        let V4Extras { global_light, patterns, layer_comps, blobs } = extras.unwrap_or_default();
        for p in &patterns {
            if !ctx.patterns.insert(p.id.clone()) {
                return Err(format!("duplicate pattern id {}", p.id));
            }
            ctx.blob_refs.push(p.blob);
        }
        let mut path = Vec::new();
        let nodes = build_nodes(&layers, &mut path, &mut ctx)?;
        if next_node_id <= ctx.max_node_id {
            return Err("next_node_id must be greater than every node id".into());
        }
        let take_sel = |s: &SelIn, slot: Slot, ctx: &mut LoadCtx| -> Result<SelMask, String> {
            if s.default > max_value(depth) {
                return Err("mask default out of range".into());
            }
            Ok(SelMask { default: s.default, tiles: take_tiles(&s.tiles, true, slot, true, ctx)? })
        };
        let selection = selection.as_ref().map(|s| take_sel(s, Slot::Selection, &mut ctx)).transpose()?;
        let last_selection =
            last_selection.as_ref().map(|s| take_sel(s, Slot::LastSelection, &mut ctx)).transpose()?;
        let mut chans = Vec::with_capacity(channels.len());
        let mut chan_ids = HashSet::new();
        for (i, c) in channels.iter().enumerate() {
            if c.id == 0 {
                return Err("channel id 0 is not allowed".into());
            }
            if !chan_ids.insert(c.id) {
                return Err(format!("duplicate channel id {}", c.id));
            }
            let mask = take_sel(&SelIn { default: c.default, tiles: c.tiles.clone() }, Slot::Channel(i), &mut ctx)?;
            if let Some(s) = &c.spot {
                s.check()?;
            }
            chans.push(Channel { id: c.id, name: c.name.clone(), mask, spot: c.spot });
        }
        for l in layer_comps.iter().flat_map(|c| &c.layers) {
            check_comp_layer(l, |id| ctx.patterns.contains(id))?;
        }
        let mut listed = HashSet::new();
        for &id in &blobs {
            if id == 0 || id > MAX_ID {
                return Err(format!("blob id {id} out of range"));
            }
            if !listed.insert(id) {
                return Err(format!("duplicate blob id {id}"));
            }
            if ctx.kinds.contains_key(&id) {
                return Err(format!("id {id} is used as both a tile and a blob"));
            }
            ctx.max_referenced_id = ctx.max_referenced_id.max(id);
        }
        if let Some(id) = ctx.blob_refs.iter().find(|id| !listed.contains(id)) {
            return Err(format!("blob {id} is referenced but not listed"));
        }
        let pending_ids: HashSet<u64> = ctx.slots.keys().copied().chain(listed.iter().copied()).collect();
        Ok(Document {
            width,
            height,
            depth,
            nodes,
            selection,
            last_selection,
            channels: chans,
            global_light,
            patterns,
            layer_comps,
            vector: ctx.vector,
            blobs: HashMap::new(),
            next_id,
            next_node_id,
            loading: Some(Loading {
                slots: ctx.slots,
                blobs: listed,
                pending_ids,
                max_referenced_id: ctx.max_referenced_id,
            }),
            tile_cache: Arc::new(RefCell::new(TileCache::default())),
            adjust_cache: RefCell::default(),
        })
    }

    pub fn put_tile(&mut self, id: u64, bytes: &[u8]) -> Result<(), String> {
        let depth = self.depth;
        let loading = self.loading.as_ref().ok_or("document is not loading")?;
        if loading.blobs.contains(&id) {
            self.blobs.insert(id, Arc::new(bytes.to_vec()));
            self.loading.as_mut().expect("still loading").pending_ids.remove(&id);
            return Ok(());
        }
        let (is_mask, slots) = loading
            .slots
            .get(&id)
            .ok_or_else(|| format!("unknown tile id {id}"))?
            .clone();
        let px = Arc::new(Pixels::from_bytes(depth, is_mask, bytes)?);
        for (slot, tx, ty) in slots {
            let tile = Some(Tile { id, px: px.clone() });
            match slot {
                Slot::Pixels(path) => node_at_mut(&mut self.nodes, &path).pixel_tiles_mut()?.put(tx, ty, tile),
                Slot::Mask(path) => node_at_mut(&mut self.nodes, &path)
                    .mask
                    .as_mut()
                    .expect("mask exists when a mask tile refers to it")
                    .tiles
                    .put(tx, ty, tile),
                Slot::Source(path) => node_at_mut(&mut self.nodes, &path).smart_mut().source_tiles.put(tx, ty, tile),
                Slot::FilterMask(path, i) => node_at_mut(&mut self.nodes, &path).smart_mut().filters[i]
                    .mask
                    .as_mut()
                    .expect("a filter mask exists when a mask tile refers to it")
                    .tiles
                    .put(tx, ty, tile),
                Slot::StackMask(path) => node_at_mut(&mut self.nodes, &path)
                    .smart_mut()
                    .stack_mask
                    .as_mut()
                    .expect("a stack mask exists when a mask tile refers to it")
                    .tiles
                    .put(tx, ty, tile),
                Slot::TextCache(path) => match &mut node_at_mut(&mut self.nodes, &path).kind {
                    Kind::Text(t) => t.cache.as_mut().expect("a text cache exists when a cache tile refers to it").put(tx, ty, tile),
                    _ => unreachable!("a text cache slot points at a text node"),
                },
                Slot::Selection => self.selection.as_mut().expect("a selection exists").tiles.put(tx, ty, tile),
                Slot::LastSelection => {
                    self.last_selection.as_mut().expect("a last selection exists").tiles.put(tx, ty, tile)
                }
                Slot::Channel(i) => self.channels[i].mask.tiles.put(tx, ty, tile),
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

fn find_tile(tiles: &Tiles, id: u64) -> Option<Vec<u8>> {
    tiles.iter().find(|(_, t)| t.id == id).map(|(_, t)| t.px.to_bytes())
}

struct LoadCtx {
    max_mask: u32,
    canvas: (u32, u32),
    node_ids: HashSet<u32>,
    max_node_id: u32,
    // tile id -> is_mask, so no id is used as both RGBA and mask data.
    kinds: HashMap<u64, bool>,
    slots: HashMap<u64, (bool, Vec<(Slot, i32, i32)>)>,
    max_referenced_id: u64,
    v4: bool,
    v5: bool,
    v6: bool,
    vector: DocVector,
    patterns: HashSet<String>,
    blob_refs: Vec<u64>,
}

// A style may only name document patterns and holds at most 10 instances per list.
pub(super) fn check_comp_layer(l: &CompLayer, has_pattern: impl Fn(&str) -> bool) -> Result<(), String> {
    unit(l.opacity, "comp layer opacity")?;
    unit(l.fill, "comp layer fill")?;
    l.style.as_ref().map_or(Ok(()), |st| check_style(st, has_pattern))
}

pub(super) fn check_style(style: &Style, has_pattern: impl Fn(&str) -> bool) -> Result<(), String> {
    style.check()?;
    match style.pattern_ids().find(|id| !has_pattern(id)) {
        Some(id) => Err(format!("unknown pattern {id}")),
        None => Ok(()),
    }
}

// A tile grid of a v1/v2 manifest, dense and canvas sized, as sparse entries.
fn spread(ids: &[u64], tiles_x: u32, tiles_y: u32) -> Result<Vec<Coord>, String> {
    if ids.len() != (tiles_x as usize) * (tiles_y as usize) {
        return Err("tile array length does not match tiles_x*tiles_y".into());
    }
    Ok(ids
        .iter()
        .enumerate()
        .filter(|(_, id)| **id != 0)
        .map(|(i, id)| ((i as u32 % tiles_x) as i32, (i as u32 / tiles_x) as i32, *id))
        .collect())
}

fn spread_nodes(nodes: Vec<NodeIn<u64>>, tiles_x: u32, tiles_y: u32) -> Result<Vec<NodeIn<Coord>>, String> {
    nodes
        .into_iter()
        .map(|n| {
            Ok(NodeIn {
                id: n.id,
                name: n.name,
                kind: n.kind,
                visible: n.visible,
                opacity: n.opacity,
                fill: n.fill,
                blend: n.blend,
                clipping: n.clipping,
                locks: n.locks,
                mask: match n.mask {
                    None => None,
                    Some(m) => Some(MaskIn {
                        enabled: m.enabled,
                        default: m.default,
                        tiles: spread(&m.tiles, tiles_x, tiles_y)?,
                    }),
                },
                tiles: n.tiles.as_deref().map(|t| spread(t, tiles_x, tiles_y)).transpose()?,
                children: n.children.map(|c| spread_nodes(c, tiles_x, tiles_y)).transpose()?,
                style: n.style,
                blending: n.blending,
                adjustment: n.adjustment,
                content: n.content,
                smart: n.smart,
                vector_mask: n.vector_mask,
                artboard: n.artboard,
                shape: n.shape,
                text: n.text,
            })
        })
        .collect()
}

fn take_tiles(list: &[Coord], is_mask: bool, slot: Slot, on_canvas: bool, ctx: &mut LoadCtx) -> Result<Tiles, String> {
    let mut seen = HashSet::new();
    for &(tx, ty, id) in list {
        if !seen.insert((tx, ty)) {
            return Err(format!("duplicate tile coordinate ({tx}, {ty})"));
        }
        if tx.unsigned_abs() > MAX_TILE_COORD || ty.unsigned_abs() > MAX_TILE_COORD {
            return Err(format!("tile coordinate ({tx}, {ty}) out of range"));
        }
        if on_canvas && (tx < 0 || ty < 0 || tx as u32 >= ctx.canvas.0 || ty as u32 >= ctx.canvas.1) {
            return Err(format!("tile coordinate ({tx}, {ty}) is outside the canvas"));
        }
        if id == 0 {
            return Err("tile id 0 is not allowed".into());
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
        entry.1.push((slot.clone(), tx, ty));
        ctx.max_referenced_id = ctx.max_referenced_id.max(id);
    }
    Ok(Tiles::default())
}

fn build_nodes(in_nodes: &[NodeIn<Coord>], path: &mut Vec<usize>, ctx: &mut LoadCtx) -> Result<Vec<Node>, String> {
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
        let m3 = [n.style.is_some(), n.blending.is_some(), n.adjustment.is_some(), n.content.is_some(), n.smart.is_some()];
        if !ctx.v4 && m3.contains(&true) {
            return Err("styles, blending options and adjustment, fill and smart nodes need manifest v4".into());
        }
        let blending = match &n.blending {
            Some(b) => b.clone(),
            None if ctx.v4 => return Err(format!("node {} needs blending options", n.id)),
            None => Blending::default(),
        };
        let m4 = [n.vector_mask.is_some(), n.artboard.is_some(), n.shape.is_some(), n.text.is_some()];
        if !ctx.v5 && m4.contains(&true) {
            return Err("vector masks, artboards and shape and text nodes need manifest v5".into());
        }
        // Which of tiles, children, adjustment, content, smart, shape and text each kind carries.
        let want = match n.kind.as_str() {
            "pixel" => [true, false, false, false, false, false, false],
            "group" => [false, true, false, false, false, false, false],
            "adjustment" => [false, false, true, false, false, false, false],
            "fill" => [false, false, false, true, false, false, false],
            "smart" => [true, false, false, false, true, false, false],
            "shape" => [false, false, false, false, false, true, false],
            // A text node's tiles (its cache) are optional.
            "text" => [n.tiles.is_some(), false, false, false, false, false, true],
            other => return Err(format!("unknown node kind {other}")),
        };
        let has = [n.tiles.is_some(), n.children.is_some(), m3[2], m3[3], m3[4], m4[2], m4[3]];
        for (k, field) in ["tiles", "children", "adjustment", "content", "smart", "shape", "text"].iter().enumerate() {
            if has[k] != want[k] {
                let verb = if want[k] { "needs" } else { "cannot have" };
                return Err(format!("a {} node {verb} a {field} field", n.kind));
            }
        }
        if blend == Blend::PassThrough && n.kind != "group" {
            return Err("pass through is only allowed on groups".into());
        }
        if let Some(st) = &n.style {
            if n.kind == "adjustment" {
                return Err(format!("node {} is an adjustment layer and cannot have a layer style", n.id));
            }
            check_style(st, |id| ctx.patterns.contains(id))?;
        }
        if let Some(a) = &n.artboard {
            if n.kind != "group" || !path.is_empty() {
                return Err(format!("node {}: an artboard is only allowed on a top-level group", n.id));
            }
            ctx.vector.check_artboard(a)?;
        }
        if let Some(vm) = &n.vector_mask {
            vm.validate()?;
        }
        path.push(i);
        let kind = match (n.kind.as_str(), &n.tiles, &n.children, &n.adjustment, &n.content, &n.smart) {
            ("shape", ..) => {
                let s = n.shape.as_ref().expect("checked against the kind");
                s.validate(|id| ctx.patterns.contains(id))?;
                Kind::Shape(Box::new(s.clone()))
            }
            ("text", tiles, ..) => {
                let data = n.text.as_ref().expect("checked against the kind");
                data.validate()?;
                let cache = tiles.as_ref().map(|ids| take_tiles(ids, false, Slot::TextCache(path.clone()), false, ctx)).transpose()?;
                Kind::Text(Box::new(Text { data: data.clone(), cache }))
            }
            ("pixel", Some(ids), ..) => Kind::Pixel(take_tiles(ids, false, Slot::Pixels(path.clone()), false, ctx)?),
            ("group", _, Some(children), ..) => Kind::Group(build_nodes(children, path, ctx)?),
            ("adjustment", _, _, Some(a), ..) => {
                a.validate()?;
                ctx.blob_refs.extend(a.blob());
                Kind::Adjustment(a.clone())
            }
            ("fill", _, _, _, Some(c), _) => {
                if let Some(id) = c.pattern_id().filter(|id| !ctx.patterns.contains(*id)) {
                    return Err(format!("unknown pattern {id}"));
                }
                Kind::Fill(c.clone())
            }
            ("smart", Some(ids), _, _, _, Some(s)) => Kind::Smart(Box::new(take_smart(s, ids, path, ctx)?)),
            _ => unreachable!("the fields were checked against the kind"),
        };
        let mask = n.mask.as_ref().map(|m| take_mask(m, Slot::Mask(path.clone()), ctx)).transpose()?;
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
            style: n.style.clone(),
            blending,
            vector_mask: n.vector_mask.clone(),
            artboard: n.artboard.clone(),
        });
    }
    Ok(out)
}

fn take_mask(m: &MaskIn<Coord>, slot: Slot, ctx: &mut LoadCtx) -> Result<Mask, String> {
    if m.default > ctx.max_mask {
        return Err("mask default out of range".into());
    }
    Ok(Mask { enabled: m.enabled, default: m.default, tiles: take_tiles(&m.tiles, true, slot, false, ctx)? })
}

fn take_smart(s: &SmartIn, cache: &[Coord], path: &[usize], ctx: &mut LoadCtx) -> Result<Smart, String> {
    let cache = take_tiles(cache, false, Slot::Pixels(path.to_vec()), false, ctx)?;
    let source_tiles = take_tiles(&s.source.tiles, false, Slot::Source(path.to_vec()), false, ctx)?;
    ctx.blob_refs.extend(s.source.blob);
    let mut ids = HashSet::new();
    let mut filters = Vec::with_capacity(s.filters.len());
    for (i, f) in s.filters.iter().enumerate() {
        if !ids.insert(f.id) {
            return Err(format!("duplicate smart filter id {}", f.id));
        }
        unit(f.opacity, "filter opacity")?;
        let filter = f.filter.clone().normalized()?;
        if !ctx.v6 && filter.spec()?.group != "adjust" && filter.kind != "gaussian_blur" {
            return Err(format!("smart filter kind \"{}\" needs a v6 manifest", filter.kind));
        }
        if f.blend == Blend::PassThrough {
            return Err("pass through is only allowed on groups".into());
        }
        ctx.blob_refs.extend(filter.blob());
        if let Some(v) = &f.psd {
            ctx.blob_refs.extend(check_psd(v)?);
        }
        let mask = f.mask.as_ref().map(|m| take_mask(m, Slot::FilterMask(path.to_vec(), i), ctx)).transpose()?;
        filters.push(SmartFilter {
            id: f.id,
            filter,
            enabled: f.enabled,
            opacity: f.opacity,
            blend: f.blend,
            mask,
            psd: f.psd.clone(),
        });
    }
    let stack_mask = s.stack_mask.as_ref().map(|m| take_mask(m, Slot::StackMask(path.to_vec()), ctx)).transpose()?;
    Ok(Smart {
        link: s.link.clone(),
        source_blob: s.source.blob,
        source_tiles,
        source_size: s.source_size,
        transform: s.transform,
        warp: s.warp.clone(),
        filters,
        stack_mask,
        stack_mode: s.stack_mode,
        cache,
        mask_key: 0,
    })
}

// ---------- serde types ----------

#[derive(Deserialize)]
struct VersionProbe {
    format: String,
    version: u32,
}

/// One stored tile in a manifest: signed tile coordinates and the tile id.
type Coord = (i32, i32, u64);

#[derive(Serialize)]
struct MaskOut {
    enabled: bool,
    default: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    tiles: Option<Vec<Coord>>,
}

#[derive(Serialize)]
struct SelOut {
    default: u32,
    tiles: Vec<Coord>,
}

#[derive(Serialize)]
struct ChannelOut<'a> {
    id: u32,
    name: &'a str,
    default: u32,
    tiles: Vec<Coord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    spot: Option<Spot>,
}

fn sel_out(s: &SelMask) -> SelOut {
    SelOut { default: s.default, tiles: s.tiles.out() }
}

struct Head {
    width: u32,
    height: u32,
    depth: u8,
    tiles_x: u32,
    tiles_y: u32,
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
    style: &'a Option<Style>,
    blending: &'a Blending,
    #[serde(skip_serializing_if = "Option::is_none")]
    tiles: Option<Vec<Coord>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<NodeOut<'a>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    adjustment: Option<&'a Adjustment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<&'a FillContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    smart: Option<SmartOut<'a>>,
    vector_mask: &'a Option<VectorMask>,
    #[serde(skip_serializing_if = "Option::is_none")]
    artboard: Option<&'a Artboard>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shape: Option<&'a ShapeData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a TextData>,
}

#[derive(Serialize)]
struct SourceOut {
    blob: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tiles: Option<Vec<Coord>>,
}

#[derive(Serialize)]
struct FilterOut<'a> {
    id: u32,
    filter: &'a Filter,
    enabled: bool,
    opacity: f32,
    blend: Blend,
    mask: Option<MaskOut>,
    #[serde(skip_serializing_if = "Option::is_none")]
    psd: &'a Option<serde_json::Value>,
}

#[derive(Serialize)]
struct SmartOut<'a> {
    link: &'a Link,
    source: SourceOut,
    source_size: [u32; 2],
    transform: [f64; 9],
    warp: &'a Option<WarpMesh>,
    filters: Vec<FilterOut<'a>>,
    stack_mask: Option<MaskOut>,
    stack_mode: Option<StackMode>,
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
    selection: Option<SelOut>,
    last_selection: Option<SelOut>,
    channels: Vec<ChannelOut<'a>>,
    global_light: &'a GlobalLight,
    patterns: &'a [PatternEntry],
    layer_comps: &'a [LayerComp],
    blobs: Vec<u64>,
    #[serde(flatten)]
    vector: &'a DocVector,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MaskIn<T> {
    enabled: bool,
    default: u32,
    tiles: Vec<T>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NodeIn<T> {
    id: u32,
    name: String,
    kind: String,
    visible: bool,
    opacity: f32,
    fill: f32,
    blend: String,
    clipping: bool,
    locks: Locks,
    #[serde(default = "no_mask")]
    mask: Option<MaskIn<T>>,
    #[serde(default)]
    tiles: Option<Vec<T>>,
    #[serde(default = "no_children")]
    children: Option<Vec<NodeIn<T>>>,
    #[serde(default)]
    style: Option<Style>,
    #[serde(default)]
    blending: Option<Blending>,
    #[serde(default)]
    adjustment: Option<Adjustment>,
    #[serde(default)]
    content: Option<FillContent>,
    #[serde(default)]
    smart: Option<SmartIn>,
    #[serde(default)]
    vector_mask: Option<VectorMask>,
    #[serde(default)]
    artboard: Option<Artboard>,
    #[serde(default)]
    shape: Option<ShapeData>,
    #[serde(default)]
    text: Option<TextData>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SourceIn {
    blob: Option<u64>,
    tiles: Vec<Coord>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FilterIn {
    id: u32,
    filter: Filter,
    enabled: bool,
    opacity: f32,
    blend: Blend,
    mask: Option<MaskIn<Coord>>,
    #[serde(default)]
    psd: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SpecialIn {
    pub(super) name: String,
    #[serde(default)]
    pub(super) adjustment: Option<Adjustment>,
    #[serde(default)]
    pub(super) content: Option<FillContent>,
    #[serde(default)]
    pub(super) smart: Option<SmartNewIn>,
    #[serde(default)]
    pub(super) shape: Option<ShapeData>,
    #[serde(default)]
    pub(super) text: Option<TextData>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SmartNewIn {
    pub(super) link: Link,
    pub(super) source_blob: Option<u64>,
    pub(super) source_size: [u32; 2],
    pub(super) transform: [f64; 9],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DocumentM3In {
    #[serde(default)]
    pub(super) global_light: Option<GlobalLight>,
    #[serde(default)]
    pub(super) patterns: Option<Vec<PatternEntry>>,
    #[serde(default)]
    pub(super) layer_comps: Option<Vec<LayerComp>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct LayerCompUpdateIn {
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) comment: Option<String>,
    #[serde(default)]
    pub(super) apply_visibility: Option<bool>,
    #[serde(default)]
    pub(super) apply_position: Option<bool>,
    #[serde(default)]
    pub(super) apply_appearance: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SmartIn {
    link: Link,
    source: SourceIn,
    source_size: [u32; 2],
    transform: [f64; 9],
    warp: Option<WarpMesh>,
    filters: Vec<FilterIn>,
    stack_mask: Option<MaskIn<Coord>>,
    stack_mode: Option<StackMode>,
}

fn no_mask<T>() -> Option<MaskIn<T>> {
    None
}

fn no_children<T>() -> Option<Vec<NodeIn<T>>> {
    None
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SelIn {
    default: u32,
    tiles: Vec<Coord>,
}

fn spot_needs_v8(version: u32, channels: &[ChannelIn]) -> Result<(), String> {
    if version < 8 && channels.iter().any(|c| c.spot.is_some()) {
        return Err("spot channels need manifest v8".into());
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelIn {
    id: u32,
    name: String,
    default: u32,
    tiles: Vec<Coord>,
    #[serde(default)]
    spot: Option<Spot>,
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
    layers: Vec<NodeIn<u64>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestV3In {
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
    layers: Vec<NodeIn<Coord>>,
    #[serde(default)]
    selection: Option<SelIn>,
    #[serde(default)]
    last_selection: Option<SelIn>,
    #[serde(default)]
    channels: Vec<ChannelIn>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestV4In {
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
    layers: Vec<NodeIn<Coord>>,
    selection: Option<SelIn>,
    last_selection: Option<SelIn>,
    channels: Vec<ChannelIn>,
    global_light: GlobalLight,
    patterns: Vec<PatternEntry>,
    layer_comps: Vec<LayerComp>,
    blobs: Vec<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestV5In {
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
    layers: Vec<NodeIn<Coord>>,
    selection: Option<SelIn>,
    last_selection: Option<SelIn>,
    channels: Vec<ChannelIn>,
    global_light: GlobalLight,
    patterns: Vec<PatternEntry>,
    layer_comps: Vec<LayerComp>,
    blobs: Vec<u64>,
    resolution: f64,
    paths: Vec<SavedPath>,
    guides: Vec<Guide>,
    grid: Grid,
    guides_locked: bool,
    artboards_locked: bool,
    #[serde(default)]
    vanishing_planes: Vec<crate::vanishing::VPlane>,
    #[serde(default)]
    gray: bool,
    #[serde(default)]
    mode: Option<super::color_mode::ColorMode>,
    #[serde(default)]
    profile: Option<super::profile::DocProfile>,
}

// The document-level fields v4 adds; v1 to v3 load with the defaults.
#[derive(Default)]
struct V4Extras {
    global_light: GlobalLight,
    patterns: Vec<PatternEntry>,
    layer_comps: Vec<LayerComp>,
    blobs: Vec<u64>,
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
pub(super) struct LocksIn {
    #[serde(default)]
    pub(super) transparency: Option<bool>,
    #[serde(default)]
    pub(super) pixels: Option<bool>,
    #[serde(default)]
    pub(super) position: Option<bool>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PropsIn {
    #[serde(default)]
    pub(super) name: Option<String>,
    #[serde(default)]
    pub(super) visible: Option<bool>,
    #[serde(default)]
    pub(super) opacity: Option<f32>,
    #[serde(default)]
    pub(super) fill: Option<f32>,
    #[serde(default)]
    pub(super) blend: Option<String>,
    #[serde(default)]
    pub(super) clipping: Option<bool>,
    #[serde(default)]
    pub(super) locks: Option<LocksIn>,
    #[serde(default)]
    pub(super) mask_enabled: Option<bool>,
}
