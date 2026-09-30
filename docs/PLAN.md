# photobaer plan: image editor with feature parity to the reference app (web PWA + desktop)

Working name: photobaer. It never names the reference app or its vendor, and never ships their
icons, strings, CSS or layout assets.

## 0. Ground rules

- **Own implementation.** Build the same features, not a copy of the code. Features and file
  formats are not protected; the reference app's code, CSS, icons, UI strings and branding are
  (it has no license). Sources: the reference app (its build may be read to learn how a feature
  behaves and looks), the public Adobe Photoshop user guide and the public PSD file format
  specification. Code, CSS and icons are always written here, never copied; icons come from
  lucide (ISC).
- The reference app is never named in code, comments, docs or commit messages. The command-ID
  list below is a feature checklist only (it mirrors the public Photoshop menu structure).
- Own license chosen before the first public commit (decision D6).

## 1. Scope source (measured 2026-09-25, reference app 0.1.21)

855 command IDs registered in the renderer bundles. Registered is not the same as implemented;
each item is confirmed by black-box use before it enters a milestone.

| Area | IDs | Main content |
|---|---|---|
| layer | 218 | layers, groups, masks, vector masks, clipping, layer styles (10 effects), adjustment and fill layers, smart objects and smart filters, artboards, frames, align/distribute, shape boolean ops, video layers, copy CSS/SVG |
| tool | 107 (about 70 unique) | marquee, lasso (poly, magnetic), magic wand, quick/object selection, crop, perspective crop, slice, eyedropper, color sampler, ruler, count, note, healing (spot, brush, patch, content-aware move, red eye), brush, pencil, color replacement, mixer brush, clone and pattern stamp, history and art history brush, eraser (background, magic), gradient, paint bucket, blur/sharpen/smudge, dodge/burn/sponge, pen (freeform, curvature, anchor edit), type (horizontal, vertical, masks), path and direct selection, shapes, hand, rotate view, zoom |
| filter | 86 | blur (incl. lens, surface, blur gallery), distort, noise, pixelate, render (clouds, flame, tree, lighting, lens flare), sharpen (smart, unsharp), stylize (oil paint, wind, extrude), other (high pass, offset, custom), liquify, vanishing point, adaptive wide angle, lens correction, camera raw, filter gallery |
| view | 83 | zoom modes, rulers, guides, grid, pixel grid, smart guides, snapping, slices, screen modes, proof setup (CMYK plates, color blindness), gamut warning, pixel aspect ratio |
| edit | 80 | undo/redo/history, clipboard incl. paste in place/into/outside, fill, stroke, content-aware fill and scale, free transform, warp (split), puppet warp, perspective warp, auto-align/auto-blend, define brush/pattern/shape, color settings, assign/convert profile, preferences (19 pages), preset manager, spell check, find and replace text |
| file | 65 | new/open/save/save as/copy, place embedded/linked, export as, quick export PNG, layers to files, artboards to files/PDF, generate image assets, save for web, automate (batch, droplet, photomerge, merge to HDR, contact sheet, crop and straighten, image processor, load files into stack), scripts, file info, print, package |
| image | 63 | 22 adjustments, auto tone/contrast/color, image and canvas size, rotation, crop, trim, reveal all, apply image, calculations, modes (bitmap, grayscale, duotone, indexed, RGB, CMYK, Lab, multichannel; 8/16/32 bit), variables/data sets, analysis/measurement |
| window | 63 | 30 panels, document arrangement (tile, n-up, float), workspaces (essentials, photography, painting, motion, graphic and web) |
| select | 30 | all/deselect/inverse, color range, focus area, subject, select and mask, modify (border, smooth, expand, contract, feather), grow/similar, save/load selection, quick mask, layer selection |
| type | 51 | point/paragraph text, character and paragraph panels and styles, OpenType features, anti-alias modes, vertical text, warp text, convert to shape/work path, missing fonts, East Asian and Middle Eastern composers |
| help | 9 | about, shortcuts reference, legal notices |

Other measured reference app parts: AI background removal and select subject (withoutBG ONNX model, 140 MB,
Apache-2.0 but it contains DINOv3 material under the Meta DINOv3 License), RAW via LibRaw
(LGPL-2.1 or CDDL) plus lensfun data, PDF import (pdf.js), JS scripting via QuickJS, a CLI and a
local agent/MCP API, autosave recovery, i18n.

## 2. Architecture

Web-first. One code base; the PWA is the product, a desktop shell wraps the same build.

```
UI (TypeScript, React)  ── commands ──►  Engine worker: undo history (TS, engine snapshots)
        │                                              │
        ▼                                              ▼
Canvas view (WebGPU, WebGL2 fallback)  ◄── tiles ──  Engine (Rust → WASM, SIMD + threads)
                                                       │  document model (layer tree), tile store,
                                                       │  compositor CPU path,
                                                       │  filters CPU path, codecs
Workers: engine threads, AI (onnxruntime-web, WebGPU EP), RAW (LibRaw WASM, separate module)
Storage: OPFS (tiles, autosave, scratch disk), IndexedDB (presets, settings, recent files)
Shell: PWA (service worker, File Handling API, File System Access API) | Tauri 2 (desktop, later)
```

Key points:
- **Tiled document.** 256x256 tiles, copy-on-write, mip pyramid for zoomed-out views, paging to
  OPFS for documents larger than RAM (the reference app pages tiles the same way).
- **GPU compositor.** All blend modes, masks, layer styles and adjustment layers as WGSL shaders;
  a bit-exact CPU path in Rust for export and tests. Photopea stores layer pixels in GPU memory
  and blends there (Photopea docs: 850 ms CPU vs 55 ms WebGL for a 10-layer 2048x1152 redraw).
- **Precision.** Internal 16-bit or float per channel from day 1, so 16/32-bit modes are not a rewrite.
- **History.** Command pattern plus tile snapshots; history panel and history brush read the same store.
- **Cross-origin isolation** (COOP/COEP headers) is required for SharedArrayBuffer and WASM threads.
  All hosting and CDN choices must support these headers.
- **Desktop.** Tauri 2 (WebView2 on Windows, WKWebView on macOS). It adds local font enumeration,
  native file associations and larger memory; no separate code path.

## 3. Libraries (license checked or to check before use)

| Need | Library | License | Note |
|---|---|---|---|
| PSD/PSB read/write | ag-psd (v31.x) | MIT | Does not re-render text or effects; own renderer needed. Own Rust codec later for PSB and speed |
| ICC, CMYK, soft proof | Little CMS 2 → WASM | MIT | |
| Text shaping | HarfBuzz (harfbuzzjs) | MIT | plus own line breaking and paragraph composer |
| Spell check | nspell / Hunspell WASM | MIT / MPL-LGPL | dictionary licenses vary per language |
| RAW | LibRaw → WASM | LGPL-2.1 or CDDL | ship as separate module, publish its source |
| Lens profiles | lensfun database | CC-BY-SA 3.0 (data) | attribution file |
| AI runtime | onnxruntime-web | MIT | WebGPU execution provider |
| AI models | withoutBG open model, SAM-family, LaMa inpainting | to check per model | DINOv3 terms apply to withoutBG; each model gets a license check before it ships |
| PDF import | pdf.js | Apache-2.0 | |
| Scripting | QuickJS (quickjs-emscripten) | MIT | sandboxed, own DOM-like API |
| Image codecs | own Rust (png, jpeg-decoder, image-webp, ...) + browser codecs | MIT/Apache | AVIF/HEIC/JXL per license |

## 4. Milestones

Each milestone ends with a public build and passes the gates in section 5.

**M0 Foundation**
Repo, CI, PWA shell with offline service worker, COOP/COEP hosting, document model, tile store,
WebGPU view with pan/zoom/rotate, CPU reference compositor, undo/redo, open/save PNG, JPEG, WebP,
native project format, OPFS autosave and crash recovery.
Done when: a 8000x8000 document pans at display refresh rate, and reload after a killed tab restores it.

**M1 Layers and PSD**
Layers, groups, opacity/fill, all Photoshop blend modes, layer masks, clipping masks, locks,
PSD/PSB open and save (pixel layers, groups, masks), layers panel, history panel.
Done when: PSD corpus composites match the embedded PSD composite within the threshold (section 5).

**M2 Selection, transform, paint**
Marquee/lasso/magic wand/quick selection, select menu (modify, color range, save/load), quick mask,
free transform and warp, crop and perspective crop, brush engine (dynamics, pressure via Pointer
Events, ABR import), eraser, pencil, fill, stroke, gradient tool and editor, paint bucket,
eyedropper, swatches, color panel.

**M3 Non-destructive**
Adjustment layers (all 16 layer types, 22 image adjustments), fill layers, layer styles (all 10 effects
plus blending options, global light, copy/paste style), smart objects (embedded, linked, edit contents),
smart filters with masks, layer comps.

**M4 Type and vector**
Point and paragraph text, character/paragraph panels and styles, OpenType features, vertical text,
warp text, missing-font handling, pen tools and paths panel, shape tools, boolean shape ops, vector
masks, SVG/CSS copy, artboards, guides/grid/smart guides/snapping, rulers and units.

**M5 Filters and retouch**
All 86 filter commands in priority order (blur, sharpen, noise, distort first), filter gallery,
healing tools (PatchMatch-based), clone/pattern stamp with clone source panel, content-aware
fill/move/scale, liquify, puppet warp, perspective warp, vanishing point, dodge/burn/sponge/smudge,
history and art history brush.

**M6 Color and photo**
Color settings, assign/convert profile, modes (CMYK, Lab, grayscale, duotone, indexed, bitmap,
multichannel), 16/32-bit, proof colors and gamut warning, RAW develop workspace (LibRaw, lensfun),
merge to HDR, photomerge, auto-align/auto-blend, lens correction, adaptive wide angle.

**M7 AI**
Select subject, remove/separate background, object selection, focus area, select and mask refine,
all local in the browser (no server). Model download on first use with size shown to the user.

**M8 Automation and export**
Actions panel (record/play), batch, droplet equivalent, image processor, JS scripting with a
documented API, export as, quick export, layers/artboards to files, generate image assets, save
for web, print, file info, variables/data sets.

**M9 Remaining**
Workspaces and panel docking parity, preferences pages, preset manager, analysis/measurement,
notes, count tool, slices, i18n. Video layers and timeline last; exclude if nobody needs them.

**Optional later:** desktop build (Tauri 2), CLI, local agent/MCP API.

## 5. Quality gates

- **PSD oracle.** Every saved PSD contains a merged composite image. The test suite renders the
  layers and compares with that composite. Threshold: mean ΔE2000 < 1 and max < 5 per file
  (targets, to be tuned on the first corpus). Corpus: own PSD files plus public sample files with
  clear licenses; never check in files you have no rights to.
- **Round-trip.** open → save → open keeps layer tree, names, masks, styles and text as editable data.
- **Golden images** for every filter and adjustment (CPU path bit-exact, GPU path within tolerance).
- **Performance budgets** (targets): brush latency under 16 ms at 4K, filter preview under 200 ms
  on the viewport, open of a 500 MB PSD without tab crash on a 16 GB machine.
- **Offline.** Airplane-mode test on every release: install PWA, go offline, open, edit, save.
- **Browsers.** Chrome/Edge (full), Firefox and Safari (WebGPU since 2025, WebGL2 fallback path
  tested), Android/Linux WebGPU gaps covered by the fallback.

## 6. Risks

- **Scope.** Photopea has been built by one developer since 2012. Full parity with 855 commands is
  a multi-year effort; M0 to M3 is the realistic first product. (Estimate, inferred, not measured.)
- **Legal.** The rules of section 0. No reference app assets, strings or look-alike branding.
  Photoshop is an Adobe trademark: do not use it in the product name.
- **Model licenses.** DINOv3 terms (inside withoutBG) and each other model need review before shipping.
- **LGPL in WASM.** LibRaw as separate replaceable module with source offer, or use the CDDL option.
- **Browser limits.** WASM 32-bit memory (4 GB) per module: large docs rely on tiling and OPFS
  paging. Memory64 support differs per browser; check before relying on it.
- **Fonts.** Local Font Access API is Chromium-only; Firefox/Safari need uploaded or bundled fonts.
- **PSD text fidelity.** Photoshop text engine data is complex; exact line breaks will differ at first.

## 7. First concrete steps (M0)

1. Choose name, license and hosting with COOP/COEP (D1, D6).
2. Create repo: `app/` (TS UI), `engine/` (Rust crate, wasm-pack), `shaders/` (WGSL), `tests/`
   (corpus runner, golden images).
3. Tile store + CPU compositor in Rust with tests, then the WebGPU viewer.
4. PWA manifest, service worker, File Handling registration, OPFS autosave.
5. First PSD corpus of 20 own files and the composite-oracle test runner.
