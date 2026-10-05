# TODO

Missing features, grouped by when they fit. Milestones refer to `docs/PLAN.md` section 4.

## M6 Color and photo
- 32 bits per channel: the paint color is 8-bit (no HDR color picker) and non-Normal paint modes clip at 1.0;
  layers kept in blend modes outside Photoshop's 32-bit list clip; Blur Gallery is disabled in 32-bit
  (Photoshop support unverified); 32 -> 16/8 Bits/Channel with Don't Merge clips (Photoshop reportedly applies
  Local Adaptation per layer, unverified).
- Color management rest: Color Settings "Blend RGB colors using gamma"; ColorSync and older-version presets
  (they need Apple RGB, SWOP and similar built-in profiles); the system clipboard and layer drags carry no
  profile; JPEG and WebP exports of Grayscale documents are RGB without the Gray profile; open-time conversion converts pixel layers only (text,
  shape and adjustment layers keep their numbers).
- Camera RAW and DNG open with a develop workspace (Camera Raw Filter is done: Basic sliders and vignette).
- Lens Correction automatic lens profiles and the grid/straighten tools; Adaptive Wide Angle constraint lines.
- Auto-Align Layers: Cylindrical, Spherical and Collage projections; Photomerge Vignette Removal and Geometric Distortion Correction; Merge to HDR Pro tone-mapping options and picking files instead of open documents.
- Channels panel rest: spot and alpha channel colors from color books open as black; color and saved channels cannot be
  targeted together; the color swatches stay in color while one channel is targeted (painting uses the gray);
  further targeted saved channels take a stroke when it ends, not live.
- Formats rest: Import PDF has no Bleed, Trim, Art or Bounding Box crop and applies mode and bit depth as undo
  steps after opening; Enter in a size field of the Import PDF and Rasterize SVG dialogs commits the field but does
  not press OK; Revert of an SVG renders at its own size; EXR deep files, PIZ and DWA compression, B44 channels
  with pLinear, and parts after the first; 16/32-bit PSD layer and composite data is written uncompressed;
  smart filter masks of 16/32-bit documents are not stored in PSD (saving warns).

## M7 AI (local, in the browser)
- Select > Subject, Object Selection tool, Select > Focus Area.
- Remove Background and Separate Background.
- Select and Mask workspace (refine edge brush, view modes, edge settings).
- Face-Aware Liquify.

## M8 Automation and export
- Actions rest: droplets; Insert Menu Item and conditional steps; dialog (modal) toggles per step; F-key shortcuts;
  .atn import; recording tool-only state (colors, tool options); undo while recording keeps the recorded step;
  smart filter, path, channel and guide ids are not remapped on playback; strokes with sampled tips need the tip
  in the session. Batch rest: Save and Close, file naming options, Override Action "Open"/"Save As"; same-named outputs overwrite;
  a Files batch that closes the last document leaves a stale "document changed" toast; Batch does not refuse to
  start while recording.
- Scripts rest: Image Processor TIFF output (no browser encoder), Copyright Info and Include ICC Profile
  options, Save in Same Location; Flatten All Masks only on pixel layers (type, shape and smart object masks
  stay); Flatten All Layer Effects also applies the layer mask and drops a disabled vector mask; Statistics;
  Load Files into Stack places each file at the top left and has no Add Open Files; scripts cannot open,
  save or close documents and have no ExtendScript/UXP compatibility; Image Processor undo leaves its
  Image Size/Convert to Profile steps as redo entries on open documents.
  Delete All Empty Layers also deletes locked layers and empty clipping bases, and may leave a document
  with no layer; baked layers lose color label and link group.
- Export rest: no TIFF, BMP or TGA output (no browser encoder); exported PNG/JPEG carry File Info only as XMP (no EXIF, no WebP); Export As has no canvas size, resample or preview pane; Save for Web has no 2-up/4-up previews, matte,
  lossy GIF, interlace or web-snap; GIF and PNG-8 have binary transparency (alpha below 50% is clear) and a
  median-cut palette without the Perceptual/Selective choices; Layers to Files has no file name prefix or
  per-layer-comp option and names collide only inside one run; Artboards to PDF writes JPEG pages without
  a color profile and no Layer Comps; Paths to SVG writes all saved paths with no path choice; Layer Comps to
  Files keeps its three PNG/JPEG/WebP menu items.
- R19 rest: File Info has no Camera Data (EXIF) tab, no IPTC Core/Origin panels or templates, and the Raw XMP
  tab is read-only; XMP properties other than the six fields are dropped on open; compressed PNG iTXt XMP is
  not read. Image Assets has no size (WxH) or subfolder syntax, no default/config layer and asks for a folder
  per document (downloads without folder access). Package embeds linked files into one PSD instead of copying
  them to a Links folder. Print has no color management (profile, rendering intent), no printer choice beyond
  the browser dialog, no multiple-artboard pages.
- R20 rest: Variables bind only visibility and type text (no pixel replacement); variables and data sets live in
  the document manifest and autosave but not in PSD (saving warns); Import Data Sets reads UTF-8 only; Data Sets
  as Files names files <document>_<data set> with no naming options; applying text keeps the first run and
  paragraph style only, and the type layer keeps its name.

## M9 Remaining
- Edit: Toggle Last State (Ctrl+Alt+Z), Paste Outside, Check Spelling, Find and Replace Text, Purge.
- Edit: Define Brush Preset, Define Pattern, Define Custom Shape; Preset Manager.
- Edit: Keyboard Shortcuts editor, Menus and Toolbar customization, Preferences pages beyond Units & Rulers and Guides, Grid & Slices.
- Image: Duplicate, Trap.
- Layer: Layer from Background, Frame from Layers, Hide Layers, Lock Layers,
  Link Layers and Select Linked Layers, Arrange > Reverse, layer colors.
- Layer > Layer Mask: Reveal/Hide Selection, From Transparency, Apply, Link.
- Layer > Matting: Color Decontaminate, Defringe, Remove Black Matte, Remove White Matte.
- Select: All Layers, Deselect Layers, Find Layers, Isolate Layers.
- View: Fit Layer(s) on Screen, 200%, Print Size, Flip Horizontal, Screen Modes, Pixel Aspect Ratio,
  Show submenu (Layer Edges, Target Path, Notes, Brush Preview, Mesh), Pattern Preview.
- New Document dialog: presets by category (Photo, Print, Art and Illustration, Web, Mobile, Film and Video,
  Social), preset search, Clipboard preset, name, units, resolution, orientation, color mode, size estimate.
- Start screen with New, Open and recent files with thumbnails.
- Status bar: document size (flattened / with layers), units selector.
- Localization: UI, menus and dialogs in the languages most Adobe users work in (for example German, French,
  Spanish, Portuguese (BR), Italian, Japanese, Chinese, Korean), with a language picker; menu labels match
  each language's Photoshop terms so users find commands by the names they know.
- Help: Keyboard Shortcuts reference, System Info.
- Video layers and the Timeline panel last; drop if nobody needs them.
