# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Tool drags scroll the view while the pointer is outside it (faster farther out), up to the document edge,
  so a marquee or lasso can reach past the visible part of a zoomed-in document.
- Dock panels and toolbar tools can be reordered: drag a panel header or a tool button to a new place, or
  press Alt+Up/Down on it. The order is kept in the browser; a locked workspace keeps the panel order.
- photobaer-mcp: --help (-h) prints the options and exits.
- Duotone PSD files: Duotone documents save in Photoshop's Duotone mode (one gray channel with the inks,
  curves and overprint colors) and Duotone PSD files open as Duotone. Color book inks such as PANTONE show
  through the Lab colors Photoshop stores with them.

### Changed

- The Duotone curve buttons draw the ink curve as the image shows it, not straight lines between the points.
- In a Grayscale document, Assign or Convert to Profile reconverts the foreground and background colors so
  they keep their look under the new Gray profile.

## [0.3.5] - 2026-10-05

### Changed

- Image > Mode > CMYK Color separates through the working CMYK profile from Color Settings (one undo step),
  and RGB Color from CMYK converts to the working RGB profile.
- The Cyan, Magenta, Yellow and Black channel views and thumbnails show the ink amounts of the document's
  CMYK profile.
- 32-bit documents: Exposure (adjustment layer and Image > Adjustments) reads and writes values above 1,
  and Normal-mode adjustment layers keep them for the next layer and for EXR/HDR export.
- HDR Toning on 32-bit data reads values above 1: Highlight Compression maps the brightest value to white,
  Equalize Histogram and Local Adaptation no longer flatten everything above 1.
- Image > Mode > 16 or 8 Bits/Channel on a 32-bit document opens HDR Toning (live preview, one undo step).
  With several layers it asks first: Merge flattens and tones, Don't Merge converts and clips at 1.
- 32-bit documents: layers and adjustment layers in Darken, Multiply, Lighten, Linear Dodge, Difference, Hue,
  Saturation, Color and Luminosity keep values above 1. The Layers panel lists only the blend modes Photoshop
  offers for 32-bit images.
- 32-bit documents: the filters Photoshop offers for 32-bit images keep values above 1, as filters and as smart
  filters; the other filters are disabled. Destructive adjustments store full float values (no 16-bit steps).
- 32-bit documents: layer effects keep values above 1, and the Layer Style blend lists show only the 32-bit modes.
- Image > Mode > Grayscale converts through the working Gray profile and RGB Color from Grayscale to the working
  RGB profile. Grayscale PSD, PNG and JPEG files open as Grayscale documents, and their embedded Gray profiles
  follow the Gray policy in Color Settings (keep, convert, discard or ask).
- Image > Mode > Bitmap: Output resolution (resamples first), Halftone Screen (frequency, angle, six dot shapes)
  and Custom Pattern.
- Image > Mode > Duotone: ink curves (Duotone Curve, 13 points) and Overprint Colors.
- Image > Mode > Indexed Color: Custom and Previous palettes, and Matte for transparent and edge pixels.
- Lab documents: the Lightness, a and b channel views and thumbnails show ICC Lab (D50) values. With color
  management on, Image > Mode > Lab Color converts from the document's profile, and RGB Color from Lab converts
  to the working RGB profile.
- Bitmap, Duotone and Multichannel documents carry no color profile, as in Photoshop; Grayscale from them
  takes the working Gray profile.
- Image > Mode > Grayscale from Lab converts through the working Gray profile; Lab documents carry no RGB tag.
- Without color settings, Image > Mode > CMYK Color still separates through the default CMYK profile and the
  document stays untagged; untagged CMYK documents show ink channels through that profile.
- A proofed document's tab names the proof, e.g. (RGB/8/CMYK).
- Duotone ink curves are smooth (monotone cubic) between the set points.
- Indexed Color > Custom opens the Color Table with the table the selected palette makes now.
- The Color Table can load .act and .aco files and save .act files.
- Save As ICO writes the standard icon sizes up to the image size (at most 256 px) instead of one image.
- Channels panel: Shift+click targets several color channels or several saved channels; edits and strokes
  change every targeted saved channel.
- Painting, Edit > Fill and the quick fills use the paint color's gray while one color channel is targeted.
- Spot channels preview as printed ink: multiplied over the image, covering it by the ink's solidity.
- Saved channel thumbnails, the channel overlay and the quick mask follow a stroke while it paints.
- Painting or filling a saved channel stays inside the active selection.
- WebP exports embed the document's color profile.
- Paste converts pixels copied from a document with another profile (with color management on).
- Loaded ICC profiles are kept per browser and can be RGB, CMYK or Gray working spaces.
- Edit > Assign Profile previews the chosen profile live (Preview, on by default).
- Color Settings > Advanced Controls: Desaturate Monitor Colors By (display only).
- Gamut Warning uses the proof profile's own gamut tag when it has one.
- EXR and HDR export linearize through the document's profile (curve and primaries) into linear Rec. 709.
- OpenEXR files with PXR24, B44 and B44A compression, tiled files (the full-resolution level of one-level and
  mipmap files) and multi-part files (the first part) open.
- Opening an SVG asks for its width, height and resolution (Rasterize SVG Format) and renders the drawing at that size.
- Import PDF: Crop To (Crop Box or Media Box), linked width, height and resolution fields, Mode and Bit Depth for
  the opened documents, and Images to open the images in the file at their own pixel size.
- PSD and PSB files save and open 16 and 32 bits per channel with their layers; 32-bit data is stored linear
  under the linear version of the document's profile.
- Grayscale documents save as Grayscale PSD, and Grayscale PNG exports embed the Gray profile.
- Alpha and spot channels are saved to and read from PSD files. PSD export keeps at most Photoshop's 56
  channels: alpha and spot channels beyond that are left out with a warning.
- PSD files with more than 16 channels open.
- The Color Picker has CMYK fields, the Color panel has Gray, RGB, CMYK and Lab sliders, and Grayscale
  documents use gray paint colors.
- The canvas cursor shows the selected tool's icon (lasso, wand, eyedropper, bucket, crop, slice, pen and path
  selection): a black symbol with a white outline under a small arrow whose tip is the hot spot, sharp on
  scaled displays.

### Fixed

- Turning Proof Colors or 32-bit preview off brings back GPU display tiles without reopening the document.
- Highlight Compression preview measures the brightest value again after each edit.
- With Quick Mask on, painting goes into the quick mask even when a saved channel is selected.
- Move tool: a drag on the top layer is no longer lost when layer thumbnails, the Navigator or the Histogram
  refresh during the move.
- 16 and 32-bit PSD files keep their transparency when it rounds to opaque at 8 bits.
- A PSD file with a cut-off composite image opens its layers with a warning, or fails with a clear message when
  it has no layers. A header bit depth that does not match the composite data is rejected.
- Flat PSD files open the channels after the color channels as alpha channels, not as transparency.
- PSD files with an empty layer section open as documents without layers.
- Saved document data that does not fit the bit depth (Bitmap or Indexed at 16 bits, a color mode change on
  a 32-bit document) is refused instead of loaded.
- The plain text feature page no longer flashes on a white page while the app loads.
- PSD layer styles are no longer dropped when an unused effect names a pattern the file does not embed; an
  enabled pattern effect without its pattern is dropped alone.

## [0.3.4] - 2026-10-04

### Added

- Side dock panels can be collapsed (click the header) and resized (drag the splitter, arrow keys on a
  focused splitter, double-click to reset). Layers fills the remaining height. Sizes and collapsed state
  are saved per workspace; a locked workspace keeps them fixed.

### Fixed

- A Properties slider drag that paused for a moment before release lost its edit: the Layers thumbnail
  refresh cancelled the live preview. Panel reads (thumbnails, Navigator, histograms, samples, channel
  masks) no longer end a preview session.
- Properties no longer shrinks to a few pixels when other dock panels are open, and the panels below
  it no longer move when the selected layer changes.
- Measurement Log CSV export: text cells starting with =, +, -, @, tab or CR are prefixed with ' so
  spreadsheets do not run them as formulas.

## [0.3.3] - 2026-10-04

### Added

- Layer > Quick Export (Shift+Ctrl+') and Export As (Alt+Shift+Ctrl+') for the active or selected layers.
- Window > Workspace: preset workspaces, New Workspace, Delete Workspace, Reset and Lock Workspace.
- Window > Arrange: Consolidate All to Tabs, Tile All Vertically or Horizontally, 2-up to 6-up, Float All in
  Windows, Match Zoom, Match Location and Match All.
- Histogram, Info and Tool Presets panels.
- Ruler (with Straighten Layer), Count, Color Sampler, Note, Slice and Slice Select, Artboard and Frame tools.
- Notes and Measurement Log panels; the log exports CSV.
- Image > Analysis: Set Measurement Scale, Select Data Points, Record Measurements (Shift+Ctrl+M), Ruler Tool,
  Count Tool and Place Scale Marker.

### Changed

- Documents with notes, slices, count marks, color samplers or a measurement scale cannot be opened by 0.3.2
  or older.

### Fixed

- A stale error toast no longer appears after closing or switching documents.

## [0.3.2] - 2026-10-03

### Added

- Auto-Align, Auto-Blend, Photomerge and Merge to HDR Pro.
- File > Automate > Batch: opened or picked files, saved to a folder or downloads as PSD, PNG or JPEG.
- Actions panel (Alt+F9): record, play, sets, save and load as .json, and button mode.
- File > Scripts: Image Processor, Delete All Empty Layers, Flatten All Layer Effects, Flatten All Masks,
  Load Files into Stack, and Browse to run your own script (see docs/scripting.md).
- File > Export: Quick Export, Export As (Alt+Shift+Ctrl+W), Export Preferences, Save for Web
  (Alt+Shift+Ctrl+S), Layers to Files, Artboards to Files, Artboards to PDF and Paths to SVG.
- File > Generate > Image Assets, File > Package, File Info (Alt+Shift+Ctrl+I) with XMP in PSD, PNG and JPEG,
  Print (Ctrl+P) and Print One Copy (Alt+Shift+Ctrl+P).
- Image > Variables and Data Sets: text and visibility variables, CSV/TSV import, Apply Data Set, and
  Export > Data Sets as Files.
- Import PDF with page thumbnails, resolution and password unlock.
- Open PSB, OpenEXR, Radiance HDR, SVG and ICO; Save As PSB and flattened EXR, HDR and ICO copies.
- Channels panel: target color channels and alpha channels, layer mask row, and spot channels.
- Apply Image and Calculations: masks, Add/Subtract scale and offset, other documents as source, and
  Calculations to a new document.

### Changed

- Documents saved by this version (spot channels, File Info, variables) cannot be opened by 0.3.1 or older.

## [0.3.1] - 2026-10-02

### Added

- Document tabs: open several images at once, drag tabs to reorder, unsaved marks per tab, Close All and
  Close Others, Next/Previous Document (Ctrl+Tab), and autosave that restores every open tab.
- File workflow in Chromium browsers: Ctrl+S writes back to an opened PSD, Save As, Save a Copy, Revert (F12)
  and Open Recent.
- Image Size, Canvas Size, Cut/Copy/Paste through the system clipboard, Paste in Place and Paste Into.
- Layer menu: Arrange, Merge Down/Layers/Visible, Stamp Visible, Flatten, Align and Distribute, Layer via Copy
  (Ctrl+J) and Layer via Cut, and right-click menus on layers and on the canvas.
- Edit > Search (Ctrl+F) over every menu command, and Window > Navigator.
- Filters: Pixelate, Stylize and Render groups, Blur Gallery (Field, Iris, Tilt-Shift, Path, Spin),
  Filter Gallery with 47 effects, Liquify, Vanishing Point, Camera Raw Filter (Shift+Ctrl+A),
  Lens Correction (Shift+Ctrl+R) and Adaptive Wide Angle (Alt+Shift+Ctrl+A).
- Puppet Warp, Perspective Warp and Content-Aware Scale, also as smart filters.
- PSD smart filters keep their settings both ways; filters photobaer cannot run stay in the file unchanged.
- Tools: Mixer Brush, Color Replacement, Background Eraser and Magic Eraser.
- Image > Mode: Bitmap, Grayscale, Duotone, Indexed Color with Color Table, RGB, CMYK, Lab, Multichannel,
  and 8, 16 and 32 bits per channel.
- Color management: Color Settings (Shift+Ctrl+K), Assign Profile, Convert to Profile, embedded ICC profiles
  in PNG, JPEG and PSD, and a question when an opened file has a different or no profile.
- Proof Setup, Proof Colors (Ctrl+Y), Gamut Warning (Shift+Ctrl+Y) and 32-bit Preview Options.
- Image > Apply Image and Calculations, and the Channels panel.

### Changed

- Tabs show the color mode and bit depth. Adjustment, Fill, Stroke and Layer Style dialogs no longer dim the
  canvas.

### Removed

- The .pbaer project file. Open and save handle PSD and image files; autosave still keeps your work.

### Fixed

- Inner shadow at the canvas edge, Patch with Transparent, Healing Brush Diffusion, error messages that stayed
  after a tab switch, and the Filter Gallery list in the Properties panel.

## [0.3.0] - 2026-10-01

### Added

- photobaer-mcp, an MCP server on npm: Claude Code, Codex and other agents open images from disk,
  run filters and menu commands, look at a preview and save the result in a photobaer tab.
  Setup in Help > Use with AI Agents. The editing stays in the browser tab.
- WebMCP tools for in-browser agents: document info, menu commands, filters with parameters, preview.
- App-styled tooltips replace the browser's title tooltips.

### Fixed

- The tool flyout highlights the hovered tool and closes when a menu bar menu opens.

## [0.2.2] - 2026-10-01

### Added

- Donate dialog with PayPal and Buy Me a Coffee.
- security.txt with a security contact.

### Changed

- AI training crawlers (GPTBot, ClaudeBot, Google-Extended) are no longer allowed in robots.txt.
  Search and answer crawlers stay allowed. robots.txt also states this as a Content-Signal.

## [0.2.1] - 2026-10-01

### Added

- Impressum, privacy policy and terms of use (German and English), and a license page with the
  source code link and the notices of all bundled third-party libraries and fonts.
- Links to these pages on the start screen, in Help > About and on every website page.

## [0.2.0] - 2026-10-01

### Added

- Retouching tools: Spot Healing Brush, Healing Brush, Patch, Content-Aware Move, Red Eye, Clone
  Stamp and Pattern Stamp, with a Clone Source panel (five sources, offset, scale, rotation, overlay).
- Dodge, Burn, Sponge, Blur, Sharpen, Smudge, History Brush and Art History Brush.
- Website pages for search engines and AI assistants: /photoshop-alternative/, /psd-editor-online/
  and /features/, with a page description, preview image and structured data on every page.
- robots.txt, sitemap.xml and llms.txt.

### Changed

- The options bar fits in one row: brush size and hardness in a popover, compact number fields
  that change by dragging their label, icon toggles for airbrush, pressure and similar options.
- Paint tools show the brush outline or crosshair instead of the system pointer over the canvas.
- Small windows: the tool list, menus, panels and status bar stay inside the window; under 640 px
  the panels move below the canvas.

### Fixed

- The browser tab shows the full page title while no image is open.
- Opening a website page no longer replaces the app that the browser keeps for offline use.
- Layer Style dialog: no horizontal scrollbar (the contour presets fit), effect names with action
  buttons stay on one line, and the list and settings keep a right margin.
- Scrollbars are thin and without arrow buttons.
- A submenu that would run past the bottom of the window opens higher, so all its items are visible.

## [0.1.3] - 2026-10-01

### Fixed

- Escape cancels a Move drag and puts the layer or selected pixels back.
- A Move drag shows the parts of a layer that lie outside the canvas while they are dragged back in.
- Releasing a Move on a very large layer no longer takes seconds and no longer gets slower with
  each move: the engine reserves memory in large steps instead of growing it per image tile.
- Right-clicking a tool slot while another tool flyout is open opens that slot's flyout instead of
  the browser menu.

## [0.1.2] - 2026-10-01

### Fixed

- Installed apps now pick up new releases completely: each build installs a fresh service worker
  and cache, so the manifest, icons and fonts no longer stay at the version first installed.
- Installed apps on desktop Chrome get the new app icon (icon files have new names).

## [0.1.1] - 2026-10-01

### Added

- Start screen footer with a What's new link, the app version and a GitHub link.

### Changed

- Move tool follows the pointer live and starts without a delay on large layers.
- Whole-pixel moves and layer bounds are much faster in the engine.
- Marching ants move 1 px every 80 ms for a smoother animation.
- The viewer shows a new image only when every visible tile has it, so no partial frames.
- App icons: light logo on a transparent background; the maskable icon uses the dark app background.

## [0.1.0] - 2026-10-01

First public release.

### Added

- Tiled Rust/WebAssembly engine in a web worker, WebGPU viewer with WebGL2 fallback, PWA that
  works offline with autosave.
- Layers: groups, masks, clipping, all blend modes, layer comps, Layers and History panels.
- PSD open and save with groups, adjustment and fill layers, layer styles, blending options,
  smart objects, shapes, vector masks, text layers, guides and artboards.
- Selection: marquees, lasso, polygonal and magnetic lasso, magic wand, quick selection, color
  range, modify, quick mask, save and load selection.
- Painting: brush, pencil and eraser with dynamics, texture, dual brush, ABR import, Brush
  Settings and Brushes panels; fill, stroke, gradient and paint bucket.
- Transform: move tool, Free Transform with numeric input, warp, crop and perspective crop,
  canvas and image rotation commands.
- Non-destructive editing: 16 adjustment layer kinds, fill layers, layer styles (shadows, glows,
  satin, overlays, stroke, bevel), smart objects and smart filters.
- Vector and type: shape tools, pen tools, Paths panel, boolean shape operations, point,
  paragraph and on-path text with OpenType features, character and paragraph styles, Glyphs
  panel, font upload and local fonts on Chromium.
- Layout: rulers, guides, grid, snapping and smart guides.
- Filters: filter registry with live preview, Last Filter and Fade; blur, sharpen and distort
  groups.
- Retouching: healing core and Content-Aware Fill.
- Welcome screen and Help > About dialog.

[unreleased]: https://github.com/IT-BAER/photobaer/compare/v0.3.5...HEAD
[0.3.5]: https://github.com/IT-BAER/photobaer/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/IT-BAER/photobaer/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/IT-BAER/photobaer/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/IT-BAER/photobaer/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/IT-BAER/photobaer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/IT-BAER/photobaer/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/IT-BAER/photobaer/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/IT-BAER/photobaer/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/IT-BAER/photobaer/compare/v0.1.3...v0.2.0
[0.1.3]: https://github.com/IT-BAER/photobaer/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/IT-BAER/photobaer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/IT-BAER/photobaer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/IT-BAER/photobaer/releases/tag/v0.1.0
