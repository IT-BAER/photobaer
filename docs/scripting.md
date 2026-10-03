# Scripting

File > Scripts > Browse… runs a JavaScript file (`.js`) on the open documents. While a script runs, the
same menu item reads Stop Script and ends it.

The script runs in its own Web Worker: it has no access to the page, the DOM or the editor's memory. It
edits documents only through the global `app` object. It is not a sandbox: like any script of this site it can
use the network and the site's browser storage, so run only scripts you trust. The file is the body of an `async` function, so
`await` works at the top level. An uncaught error ends the script and its message appears as an error toast.

## `app`

| Call | Result |
|------|--------|
| `await app.document()` | The active document (`DocInfo` in `app/src/worker/types.ts`), or `null`: `name`, `width`, `height`, `depth`, `layers` (tree of `LayerNode`: `id`, `name`, `kind`, `visible`, `opacity`, `blend`, `children`, ...), `selection`, `docs` (open tabs). |
| `await app.call(op, ...args)` | Runs one editor command on the active document and returns its result (usually the new `DocInfo`). |
| `await app.alert(message)` | Shows a message box and waits until it is closed. |
| `await app.download(name, type?, quality?)` | Downloads the flattened active document. `type`: `image/png` (default), `image/jpeg` or `image/webp`; `quality` 0..1 for JPEG and WebP (default 0.92). |

## Commands

`app.call` accepts the commands an action can record: the editor's worker API functions in
`app/src/engine.worker.ts`, except the ones listed in `NO_RECORD` in `app/src/actions.ts` (opening,
saving, closing, switching documents, undo and redo, settings and fonts). Arguments are the same as in the
worker; layer ids come from `app.document()`. Each command is one history step, so Edit > Undo reverts a
script step by step.

Common commands:

| Command | Arguments |
|---------|-----------|
| `addLayer` | `above` (layer id), `name?` |
| `deleteNode` | `id` |
| `setProps` | `id`, `{ name?, visible?, opacity? (0..1), blend?, fill? }` |
| `command` | `'fill'` or `'invert'`, `id`, `'pixels'`, `rgba?` (`[r, g, b, a]`, 0..255) |
| `select` | `{ kind: 'rect', x, y, w, h }`, `'new'`, `false`, `0`, `'Rectangular Marquee'` |
| `selectCommand` | `'all'`, `'deselect'` or `'inverse'` |
| `mergeNodes` | `ids`, `'down' \| 'layers' \| 'visible' \| 'stamp' \| 'flatten'` |
| `imageSize` | `width`, `height`, `'bicubic'`, `scaleStyles`, `resolution \| null` |
| `deleteEmptyLayers`, `flattenAllLayerEffects`, `flattenAllMasks` | none |

## Example

```js
// Adds a half-transparent red layer above the top layer and downloads the result.
const doc = await app.document();
if (!doc) throw new Error('Open a document first.');
let d = await app.call('addLayer', doc.layers.at(-1).id, 'Tint');
const tint = d.layers.at(-1).id;
await app.call('command', 'fill', tint, 'pixels', [255, 0, 0, 255]);
await app.call('setProps', tint, { opacity: 0.5, blend: 'multiply' });
await app.download(`${doc.name}-tinted.png`);
```
