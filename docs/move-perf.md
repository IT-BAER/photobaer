# Move tool latency on styled layers

Status: open (option 3). Measured 7 October 2026 on `baer4.psd` (4000 x 4000, 8-bit RGB). The one visible layer is
3273 x 2992 px with Drop Shadow (size 133 px, normal), Gradient Overlay (linear dodge) and Stroke (1 px, outside).
Browser: Chrome, WebGPU, devicePixelRatio 1.25, view zoom 100 %.

## Done

`shiftedRegion` (app/src/worker/helpers.ts) rendered the off-canvas part of the effect reach by offsetting the
layer by a canvas cell and back. The 4000 px offset is not a multiple of the 256 px tile, so the layer came back
on new tile ids, every styled-tile cache key changed and the sharp view image re-rendered all effects
(1.5 s of moveFloat). It now restores a snapshot. Regression test in app/src/worker/helpers.test.ts.

| moveFloat, zoom 1 | before | after |
|---|---|---|
| Node harness (worker + WASM, real PSD) | 1.9 - 2.0 s | 0.5 - 0.6 s |
| Browser, settled view | 2.7 - 3.2 s (may include queue wait) | 0.75 s |

Plan option 1, 8 October 2026: when the whole-layer image would be coarser than the view, `moveSplit` returns
only the sharp view images (`pending: true`) and the UI asks `moveFloatPatch(null, null, true)` for the coarse
whole-layer images next, before any sharp patch. Until they arrive, parts outside the view may be missing.
Tests in app/src/engine.worker.test.ts and app/src/shell/SelectionOverlay.test.ts (`withCoarse`).

| Node harness, zoom 1, 1920 x 1000 view, warm view tiles | before | after |
|---|---|---|
| moveLayerBegin to moveFloat reply (drag moves) | 335 - 355 ms | 82 - 122 ms |
| moveLayerBegin to coarse whole-layer image | 335 - 355 ms | 351 - 402 ms |

Plan option 2, 8 October 2026 (`cbe47a2`): effects that read only the layer's pixels and bounds render on a
layer-space grid (`fx_composed` / `fx_window` in engine/src/compositor.rs), so a moved layer keeps its planes.
Chrome check on a generated stand-in for `baer4.psd` (4000 x 4000, one 3273 x 2992 layer with Drop Shadow 133 px,
Gradient Overlay in Linear Dodge and a 1 px outside Stroke), view 100.2 % on the shadow edge, three drags:

| Chrome, WebGPU, devicePixelRatio 1.25 | measured |
|---|---|
| moveLayerBegin to moveFloat reply (drag moves) | 171 - 264 ms |
| last step to moveLayerCommit | 127 - 267 ms |
| moveLayerCommit to the last view tile | 122 - 159 ms |

No console errors. Three drags left three "Move" entries in History.

## Remaining

Options 2 and 3 below. Browser breakdown before option 1, one drag at 100 %:

- Drag start, 0.75 s: coarse full-layer image at level 2 (`displayTiers` base, 2 MP cap) 524 ms, rendered
  cold on every drag because the layer sits at a new offset after each drop; sharp view image (`over`) 215 ms.
- Release, about 1 s until the moved layer is drawn and `moveLayerCommit` is sent; background tiles render
  until about 2.4 s after the drop. Every visible level-0 tile re-renders the drop shadow at the new offset,
  each over a (256 + 2 * pad)^2 region (about 556^2 here). The next drag queues behind those renders.

## Plan (pick before starting)

1. Drag start: return only the sharp view image from moveFloat (about 0.2 s) and deliver the coarse
   full-layer image afterwards through the patch path (`moveFloatPatch` / `refine` in
   app/src/app/toolEffects.ts). Worker and move UI only. Recommended.
2. Release: render a layer's effect planes once in layer space and cache them by layer content, not by
   document tile, so a pure move shifts cached pixels instead of re-blurring every tile. Engine change in
   `emit_styled` (engine/src/compositor.rs) and its cache keys; needs care for effects tied to document
   space (pattern overlay not linked to layer, global light is fine, gradient aligned to layer moves with it).
   Recommended as the real fix; needs independent review (cache keys, determinism).
3. Release, cheap: prioritise move ops over queued display tiles so a new drag does not wait. Hides delay
   only.

## How to measure

A throwaway Node harness drove the worker exactly like `toolEffects.ts` (openFile, moveLayerBegin,
snapTargets, movingBounds, moveFloat(zoom, view), moveLayerStep, displayProgram for the view tiles,
moveLayerCommit), set up like the top of app/src/engine.worker.test.ts, run with
`node --import ./scripts/lingui-node.mjs <harness>.ts <psd> <zoom>`. Rebuild the engine first
(`pnpm build:engine`); app/src/engine-pkg is not in git.

In the browser: patch `Worker.prototype.postMessage` from the page to timestamp ops by message id and add a
`message` listener on the worker to log reply latency. The upload tool caps files at 10 MB, so serve the PSD
from an ignored folder through Vite `/@fs/` and drop it on `window` as a `DragEvent` with a `DataTransfer`.

## Open question

Two drags plus View > 100 % left six "Move" entries in History during the browser test. Does not reproduce in
the Node harness (three drags, three "Move" entries). View > 100 % (`viewer.actualPixels`) sends nothing to the
worker, and the only "Move" step comes from `moveLayerBegin` plus a commit with a non-zero offset, so six entries
mean six drags or nudges reached the worker; likely the synthetic input of that browser test. Not confirmed in
the browser.
