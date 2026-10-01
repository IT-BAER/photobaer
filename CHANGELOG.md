# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[unreleased]: https://github.com/IT-BAER/photobaer/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/IT-BAER/photobaer/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/IT-BAER/photobaer/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/IT-BAER/photobaer/releases/tag/v0.1.0
