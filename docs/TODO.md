# TODO

Missing features, grouped by when they fit. Milestones refer to `docs/PLAN.md` section 4.

## Not yet placed in a milestone
- PSD Puppet Warp import: check the vertex space against a Photoshop file (deferred, no sample file).

## M6 Color and photo
- Image > Mode rest: Bitmap Halftone Screen, Custom Pattern and output resolution; Duotone ink curves and
  overprint colors; Indexed Custom/Previous palette and Matte. Modes are flags over RGB storage: CMYK and Lab
  use no profile until Color Settings; color pickers still offer RGB; PSD export stays RGB.
- 32 bits per channel: edits and filters clip at 1.0; HDR-aware adjustments (Exposure, HDR Toning) still clip.
- Color management rest: Image > Mode > CMYK Color ignores the working CMYK and the CMYK channel views use a
  plain formula, not the profile; WebP export embeds no profile;
  Color Settings Advanced (desaturate monitor colors, blend RGB with gamma) and ColorSync/older-version presets;
  paste and drag between documents with different profiles; Gray working space for Image > Mode > Grayscale and
  embedded Gray profiles on open; loaded profiles as working spaces; Assign Profile live preview; open-time
  conversion converts pixel layers only (text, shape and adjustment layers keep their numbers).
- Proofing rest: a document that was proofed stays on CPU display tiles until reopened; profile gamut tags are
  ignored (Delta E test only); the proof is not named in the tab; Highlight Compression measures the brightest
  value when the option is set, not after later edits.
- Camera RAW and DNG open with a develop workspace (Camera Raw Filter is done: Basic sliders and vignette).
- Lens Correction automatic lens profiles and the grid/straighten tools; Adaptive Wide Angle constraint lines.
- Auto-Align Layers: Cylindrical, Spherical and Collage projections; Photomerge Vignette Removal and Geometric Distortion Correction; Merge to HDR Pro tone-mapping options and picking files instead of open documents.
- Channels panel rest: a targeted color channel takes the paint color's own channel value, not its gray; painting a
  saved channel ignores the active selection; spot ink previews as an overlay, not multiplied; PSD export and import
  carry no alpha or spot channels; Shift+click to target several channels; with Quick Mask on and a saved
  channel picked, painting goes into the channel; the panel shows a saved channel's old values during a stroke.
- Formats rest: PDF import (needs pdf.js, a new dependency); EXR tiled, multi-part, deep and PIZ/PXR24/B44/DWA
  compression; EXR/HDR assume sRGB-encoded 32-bit documents (a non-sRGB profile is not linearized by its own
  curve); SVG opens at its own size without a rasterize dialog; ICO writes one PNG entry up to 256 px; 16/32-bit
  PSD/PSB export.

## M7 AI (local, in the browser)
- Select > Subject, Object Selection tool, Select > Focus Area.
- Remove Background and Separate Background.
- Select and Mask workspace (refine edge brush, view modes, edge settings).
- Face-Aware Liquify.

## M8 Automation and export
- Actions panel (record and play), File > Automate > Batch, droplet equivalent.
- Scripts: Image Processor, Delete All Empty Layers, Flatten All Layer Effects, Flatten All Masks,
  Load Files into Stack; JS scripting with a documented API.
- File > Export: Quick Export as PNG, Export As (format, size, quality per file), Export Preferences,
  Save for Web, Layers to Files, Artboards to Files, Artboards to PDF, Paths to SVG.
- Generate Image Assets, Package (linked files), File Info, Print.
- Variables and Data Sets (define, import CSV/TSV, export as files).
- Layer > Quick Export / Export As for selected layers.

## M9 Remaining
- Workspaces: presets, save, delete, lock; Window > Arrange (tile, 2/3/4/6-up, float, match zoom and location).
- Panels: Histogram, Info, Tool Presets, Actions (M8), Notes, Measurement Log, Timeline (last).
- Tools: Ruler, Count, Color Sampler, Note, Slice and Slice Select, Artboard tool, Frame tool.
- Image > Analysis: measurement scale, record measurements, scale marker.
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
- Video layers and timeline last; drop if nobody needs them.
