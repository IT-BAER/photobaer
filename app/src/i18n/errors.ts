// Engine (Rust) and worker error text by its English wording (docs/I18N.md): the engine stays English, the
// app shows the message in the UI language. Text not listed (internal ids, parse details) passes through.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from './index.ts';

export const ERROR_LABELS: Record<string, MessageDescriptor> = {
  // Worker
  'Could not copy: the layer is not a pixel layer.': msg`Could not copy: the layer is not a pixel layer.`,
  'Could not copy: the selected area is empty.': msg`Could not copy: the selected area is empty.`,
  'The source document is no longer open.': msg`The source document is no longer open.`,
  'The document to revert is no longer active.': msg`The document to revert is no longer active.`,
  'Close Edit Contents before reverting.': msg`Close Edit Contents before reverting.`,
  'Fill needs a pixel layer.': msg`Fill needs a pixel layer.`,
  'Content-Aware Fill produced no pixels.': msg`Content-Aware Fill produced no pixels.`,
  'Paste Into needs a selection.': msg`Paste Into needs a selection.`,
  'Paste Outside needs a selection.': msg`Paste Outside needs a selection.`,
  'Finish the current edit before purging the history.': msg`Finish the current edit before purging the history.`,
  'Define Pattern needs a rectangular selection without feathering.': msg`Define Pattern needs a rectangular selection without feathering.`,
  'The selected area is empty.': msg`The selected area is empty.`,
  'The brush is larger than 5000 x 5000 pixels.': msg`The brush is larger than 5000 x 5000 pixels.`,
  'The pattern is larger than 4000 x 4000 pixels.': msg`The pattern is larger than 4000 x 4000 pixels.`,
  'There is no previous Indexed Color palette.': msg`There is no previous Indexed Color palette.`,
  'There were no empty layers.': msg`There were no empty layers.`,
  'No layer has an effect to flatten.': msg`No layer has an effect to flatten.`,
  'No layer has a mask to apply.': msg`No layer has a mask to apply.`,
  'Could not merge down: there is no layer below in the same group.': msg`Could not merge down: there is no layer below in the same group.`,
  'Could not merge layers: select at least two layers.': msg`Could not merge layers: select at least two layers.`,
  'Could not merge layers: the layers must be in the same group.': msg`Could not merge layers: the layers must be in the same group.`,
  'Layer has no exportable pixels.': msg`Layer has no exportable pixels.`,
  'No type edit is open.': msg`No type edit is open.`,
  'The type layer has no text.': msg`The type layer has no text.`,
  'Make a selection first.': msg`Make a selection first.`,
  'There are no pixels to transform.': msg`There are no pixels to transform.`,
  'The transform was cancelled.': msg`The transform was cancelled.`,
  'Warp bends layer pixels, not the selection outline.': msg`Warp bends layer pixels, not the selection outline.`,
  'Warp bends a whole layer; deselect to warp it.': msg`Warp bends a whole layer; deselect to warp it.`,
  'Only pixel layers and smart objects can be warped.': msg`Only pixel layers and smart objects can be warped.`,
  'There are no pixels to warp.': msg`There are no pixels to warp.`,
  'Transform Again changed nothing.': msg`Transform Again changed nothing.`,
  'Make a selection to crop to.': msg`Make a selection to crop to.`,
  'Merge to HDR Pro needs at least two open documents, one per exposure.': msg`Merge to HDR Pro needs at least two open documents, one per exposure.`,
  'Copy a layer style first.': msg`Copy a layer style first.`,
  'The histogram source must be a pixel layer.': msg`The histogram source must be a pixel layer.`,
  'The sample coordinate is outside the document.': msg`The sample coordinate is outside the document.`,
  'The sample size must be 1, 3, or 5.': msg`The sample size must be 1, 3, or 5.`,
  'The sample source must be a pixel layer.': msg`The sample source must be a pixel layer.`,
  'Set a history state as the source in the History panel.': msg`Set a history state as the source in the History panel.`,
  'Place Linked needs a file from the file picker.': msg`Place Linked needs a file from the file picker.`,
  'Select a layer to convert.': msg`Select a layer to convert.`,
  'Choose at least one file.': msg`Choose at least one file.`,
  'No Liquify session is open.': msg`No Liquify session is open.`,
  'No Vanishing Point session is open.': msg`No Vanishing Point session is open.`,
  'There is nothing to fade.': msg`There is nothing to fade.`,
  'This Smart Object has no source file to export. Reopen the original PSD or use Replace Contents.': msg`This Smart Object has no source file to export. Reopen the original PSD or use Replace Contents.`,
  'This Smart Object is already linked.': msg`This Smart Object is already linked.`,
  'This Smart Object has no source file to link.': msg`This Smart Object has no source file to link.`,
  'This Smart Object is already embedded.': msg`This Smart Object is already embedded.`,
  'There are no linked smart objects.': msg`There are no linked smart objects.`,
  'Update Modified Content works on linked smart objects.': msg`Update Modified Content works on linked smart objects.`,
  'This Smart Object has no embedded source file. Use Replace Contents or reopen the original PSD.': msg`This Smart Object has no embedded source file. Use Replace Contents or reopen the original PSD.`,
  'No smart object contents are open.': msg`No smart object contents are open.`,
  'The original Smart Object was removed or replaced. Use Save As to keep these contents.': msg`The original Smart Object was removed or replaced. Use Save As to keep these contents.`,
  'Could not save the linked source file.': msg`Could not save the linked source file.`,
  'No artboard lies on the canvas.': msg`No artboard lies on the canvas.`,
  'The straighten angle must be a number.': msg`The straighten angle must be a number.`,
  'The document has no data sets.': msg`The document has no data sets.`,
  'Open a document to record an action.': msg`Open a document to record an action.`,
  'That document is not open.': msg`That document is not open.`,
  'Font files over 64 MB are not supported.': msg`Font files over 64 MB are not supported.`,
  'The artboard is outside the canvas.': msg`The artboard is outside the canvas.`,
  'The layer has no pixels.': msg`The layer has no pixels.`,
  'Select a smart object first.': msg`Select a smart object first.`,
  'That file has no pixels to place.': msg`That file has no pixels to place.`,
  // Engine
  'Artboards cannot be nested.': msg`Artboards cannot be nested.`,
  'Artboards cannot contain other artboards.': msg`Artboards cannot contain other artboards.`,
  'Bitmap and Indexed Color documents are 8-bit': msg`Bitmap and Indexed Color documents are 8-bit`,
  'Bitmap, Duotone and Indexed Color display as CPU tiles': msg`Bitmap, Duotone and Indexed Color display as CPU tiles`,
  'Bitmap, Duotone and Multichannel documents have no profile': msg`Bitmap, Duotone and Multichannel documents have no profile`,
  'Calculations needs a single channel, not RGB': msg`Calculations needs a single channel, not RGB`,
  'Color Table needs an Indexed Color document': msg`Color Table needs an Indexed Color document`,
  'Content-Aware Fill needs a pixel layer.': msg`Content-Aware Fill needs a pixel layer.`,
  'Convert to Profile needs an RGB, CMYK or Grayscale document': msg`Convert to Profile needs an RGB, CMYK or Grayscale document`,
  'Create Layers does not work inside a clipping group': msg`Create Layers does not work inside a clipping group`,
  'Fade needs a pixel layer.': msg`Fade needs a pixel layer.`,
  'Fade opacity must be in 0..=100': msg`Fade opacity must be in 0..=100`,
  'File Info fields are limited to 64 KiB, keywords to 1000 of 1 KiB': msg`File Info fields are limited to 64 KiB, keywords to 1000 of 1 KiB`,
  'Indexed Color needs an 8-bit RGB or Grayscale document': msg`Indexed Color needs an 8-bit RGB or Grayscale document`,
  'Make a selection to stroke.': msg`Make a selection to stroke.`,
  'Merge to HDR Pro needs every exposure at the same pixel size.': msg`Merge to HDR Pro needs every exposure at the same pixel size.`,
  'No layer could be aligned.': msg`No layer could be aligned.`,
  'Photomerge needs at least two pixel layers.': msg`Photomerge needs at least two pixel layers.`,
  'Select a group to convert to an artboard.': msg`Select a group to convert to an artboard.`,
  'Select a shape layer first.': msg`Select a shape layer first.`,
  'Select at least two pixel layers to align.': msg`Select at least two pixel layers to align.`,
  'Select layers at the same level to convert them.': msg`Select layers at the same level to convert them.`,
  'Select two or more shape layers to combine them.': msg`Select two or more shape layers to combine them.`,
  'Stroke produced no pixels.': msg`Stroke produced no pixels.`,
  'That smart filter already has a mask.': msg`That smart filter already has a mask.`,
  'That smart filter is not Liquify.': msg`That smart filter is not Liquify.`,
  'The source document must have the same pixel size.': msg`The source document must have the same pixel size.`,
  'The warped image exceeds the rendering limit.': msg`The warped image exceeds the rendering limit.`,
  'There is no path to convert.': msg`There is no path to convert.`,
  'There is no work path to save.': msg`There is no work path to save.`,
  'This smart object has no smart filters.': msg`This smart object has no smart filters.`,
  'This smart object must be rasterized before its pixels can be edited.': msg`This smart object must be rasterized before its pixels can be edited.`,
  'This type layer has no outline.': msg`This type layer has no outline.`,
  'Unlock the group before converting it to an artboard.': msg`Unlock the group before converting it to an artboard.`,
  'Variables are limited to 1000 bindings and 10000 data sets': msg`Variables are limited to 1000 bindings and 10000 data sets`,
};

// Messages with a variable part: the pattern captures it, the message takes it by name.
const PATTERNS: [RegExp, (m: string[]) => string][] = [
  [/^Layer not found: (.+)$/, ([id]) => i18n._(msg`Layer not found: ${id}`)],
  [/^"(.+)" cannot run in an action\.$/, ([op]) => i18n._(msg`"${op}" cannot run in an action.`)],
  [/^Cannot save linked \.(.+) contents\. Use Save As to keep your edits\.$/, ([ext]) => i18n._(msg`Cannot save linked .${ext} contents. Use Save As to keep your edits.`)],
  [/^The linked source is unavailable: (.+)\. Relink the Smart Object to an existing file\.$/, ([name]) => i18n._(msg`The linked source is unavailable: ${name}. Relink the Smart Object to an existing file.`)],
  [/^(.+) export is not supported by this browser$/, ([type]) => i18n._(msg`${type} export is not supported by this browser`)],
  [/^"(.+)" is already a smart object\.$/, ([name]) => i18n._(msg`"${name}" is already a smart object.`)],
  [/^(.+) is not a shape layer\.$/, ([name]) => i18n._(msg`${name} is not a shape layer.`)],
  [/^(.+) is not a type layer\.$/, ([name]) => i18n._(msg`${name} is not a type layer.`)],
];

/** Text of an engine or worker error in the UI language; unknown text is returned as it is. */
export function errorLabel(text: string): string {
  const plain = text.replace(/^Error: /, '');
  if (Object.hasOwn(ERROR_LABELS, plain)) return i18n._(ERROR_LABELS[plain]!);
  for (const [re, fmt] of PATTERNS) { const m = re.exec(plain); if (m) return fmt(m.slice(1)); }
  return text;
}

/** The message of a caught error in the UI language. */
export const errorText = (e: unknown) => errorLabel((e as Error).message);

/** Engine warnings as one line. */
export const warningList = (warnings: string[]) => warnings.map(errorLabel).join('; ');
