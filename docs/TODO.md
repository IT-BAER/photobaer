# TODO

Missing features, grouped by when they fit. Milestones refer to `docs/PLAN.md` section 4; M5 batches refer
to `docs/M5.md` section 15.

## Quick wins (next)

### Q1 Small UI and layer commands
- Document tabs show color mode and depth next to the name (for example `RGB/8`).
- Dialogs with a live preview (adjustments, Levels, Curves, Layer Style) do not dim the canvas.
- Layers panel: filter row by kind (pixel, adjustment, type, shape, smart object) with an on/off switch.
- Layer > Rename Layer.
- Layer > Delete > Hidden Layers (one undo step).
- Layer > New > Layer via Cut (Shift+Ctrl+J).
- File > Close All and Close Others (each unsaved tab asks; Cancel stops the rest).

### Q2 File workflow
- Open through the file picker so the file handle is kept per document (input fallback where the API is missing).
- Save (Ctrl+S) writes back to the opened `.pbaer` or `.psd` file; a PSD that opened with warnings goes to
  Save As instead, so content that cannot be written back is never overwritten.
- File > Save As (Shift+Ctrl+S) and Save a Copy.
- File > Revert (F12), one undoable history step.
- File > Open Recent (last 10 files, permission asked on click) and Clear Recent Files List.

### Q3 Command search
- Edit > Search (Ctrl+F): search every menu command by name, show its menu path and shortcut, run with Enter.

### Q4 Navigator panel
- Window > Navigator: document thumbnail with the view rectangle, drag to pan, click to center, zoom slider.

## M5 Filters and retouch (remaining batches)
- B5 Pixelate (Color Halftone, Crystallize, Facet, Fragment, Mezzotint, Mosaic, Pointillize) and the rest of
  Stylize (Diffuse, Emboss, Extrude, Find Edges, Oil Paint, Tiles, Trace Contour, Wind).
- B6 Render: Clouds, Difference Clouds, Fibers, Lens Flare, Lighting Effects, Flame, Picture Frame, Tree.
- B7 Blur Gallery: Field, Iris, Tilt-Shift, Path, Spin.
- B8 Filter Gallery with its effect stack (Artistic, Brush Strokes, Distort, Sketch, Stylize, Texture).
- B12 Liquify (Face-Aware part in M7).
- B13 Puppet Warp and Perspective Warp.
- B14 Content-Aware Scale.
- B15 Vanishing Point.
- B16 PSD smart filter mapping.
- Tools to place in a milestone: Mixer Brush, Color Replacement, Background Eraser, Magic Eraser.

## M6 Color and photo
- Image > Mode: Grayscale, Bitmap, Duotone, Indexed Color (with Color Table), RGB, CMYK, Lab, Multichannel;
  8/16/32 bits per channel.
- Color Settings, Assign Profile, Convert to Profile, ICC/ICM profiles.
- View > Proof Setup, Proof Colors, Gamut Warning; 32-bit Preview Options.
- Camera RAW and DNG open with a develop workspace; Camera Raw Filter.
- Lens Correction, Adaptive Wide Angle.
- Merge to HDR Pro, Photomerge, Auto-Align Layers, Auto-Blend Layers.
- Image > Apply Image and Calculations.
- Channels panel.
- Formats: PSB, EXR, HDR, PDF import, SVG import, ICO.

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
- Edit: Keyboard Shortcuts editor, Menus and Toolbar customization, Preferences pages.
- Image: Duplicate, Trap.
- Layer: Layer from Background, Group from Layers, Frame from Layers, Hide Layers, Lock Layers,
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
- Help: Keyboard Shortcuts reference, System Info.
- Video layers and timeline last; drop if nobody needs them.
