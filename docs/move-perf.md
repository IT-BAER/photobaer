# Move tool latency on styled layers

Status: open. Measured 7 October 2026 on `baer4.psd` (4000 x 4000, 8-bit RGB). The one visible layer is
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

## Remaining

Browser breakdown after the fix, one drag at 100 %:

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

Two drags plus View > 100 % left six "Move" entries in History during the browser test. Not investigated.
