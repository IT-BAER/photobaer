// Display text for history step labels. Labels stay English in the worker: they are stored in the history,
// recorded into Actions and sent back; only the History panel, Edit > Undo/Redo and the Actions panel translate.
// history.test.ts scans the worker and its app callers so every literal label has an entry here.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { ENGINE_LABELS, engineLabel } from '../filters/labels.ts';
import { i18n } from './index.ts';

export const HISTORY_LABELS: Record<string, MessageDescriptor> = {
  // Worker steps (engine.worker.ts)
  Fill: msg({ message: 'Fill', context: 'history step' }), 'Red Eye Correction': msg`Red Eye Correction`,
  Patch: msg({ message: 'Patch', context: 'history step' }), 'Content-Aware Move': msg`Content-Aware Move`,
  Stroke: msg({ message: 'Stroke', context: 'history step' }),
  Gradient: msg({ message: 'Gradient', context: 'history step' }), Deselect: msg`Deselect`,
  Clear: msg({ message: 'Clear', context: 'history step' }),
  Cut: msg({ message: 'Cut', context: 'history step' }), 'Layer via Copy': msg`Layer via Copy`,
  'Layer via Cut': msg`Layer via Cut`, 'Paste Into': msg`Paste Into`, 'Paste Outside': msg`Paste Outside`,
  Paste: msg({ message: 'Paste', context: 'history step' }), 'Magic Wand': msg`Magic Wand`,
  'Quick Selection': msg`Quick Selection`, Grow: msg({ message: 'Grow', context: 'history step' }),
  Similar: msg({ message: 'Similar', context: 'history step' }), 'Color Range': msg`Color Range`,
  'Select Subject': msg`Select Subject`,
  'Save Selection': msg`Save Selection`, 'Load Selection': msg`Load Selection`, 'Apply Image': msg`Apply Image`,
  Calculations: msg`Calculations`, 'Color Table': msg`Color Table`, 'Assign Profile': msg`Assign Profile`,
  'Convert to Profile': msg`Convert to Profile`, 'New Channel': msg`New Channel`,
  'New Spot Channel': msg`New Spot Channel`, 'Channel Options': msg`Channel Options`,
  'Rename Channel': msg`Rename Channel`, 'Duplicate Channel': msg`Duplicate Channel`,
  'Delete Channel': msg`Delete Channel`, 'New Layer': msg`New Layer`, 'New Group': msg`New Group`,
  'Group Layers': msg`Group Layers`, 'Ungroup Layers': msg`Ungroup Layers`, 'Delete Layer': msg`Delete Layer`,
  'Delete Hidden Layers': msg`Delete Hidden Layers`, 'Delete All Empty Layers': msg`Delete All Empty Layers`,
  'Flatten All Layer Effects': msg`Flatten All Layer Effects`, 'Flatten All Masks': msg`Flatten All Masks`,
  'Duplicate Layer': msg`Duplicate Layer`, 'Layer Order': msg`Layer Order`,
  'Lock All Layers in Group': msg`Lock All Layers in Group`, 'Lock Layers': msg`Lock Layers`,
  'Hide Layers': msg`Hide Layers`, 'Show Layers': msg`Show Layers`, Reverse: msg`Reverse`,
  'From Transparency': msg`From Transparency`, 'Apply Layer Mask': msg`Apply Layer Mask`, Defringe: msg`Defringe`,
  'Remove Black Matte': msg`Remove Black Matte`, 'Remove White Matte': msg`Remove White Matte`,
  'Color Decontaminate': msg`Color Decontaminate`, 'New Guide': msg`New Guide`,
  'Move Guide': msg`Move Guide`, 'Delete Guide': msg`Delete Guide`, 'Clear Guides': msg`Clear Guides`,
  'New Guide Layout': msg`New Guide Layout`, 'Grid Spacing': msg`Grid Spacing`, 'Lock Guides': msg`Lock Guides`,
  'Unlock Guides': msg`Unlock Guides`, 'New Artboard': msg`New Artboard`,
  'Artboard from Group': msg`Artboard from Group`, 'Artboard from Layers': msg`Artboard from Layers`,
  'Vector Mask': msg`Vector Mask`, 'New Path': msg`New Path`, 'Save Path': msg`Save Path`,
  'Rename Path': msg`Rename Path`, 'Delete Path': msg`Delete Path`, 'Fill Path': msg`Fill Path`,
  'Stroke Path': msg`Stroke Path`, 'Make Work Path from Selection': msg`Make Work Path from Selection`,
  'Convert Path to Shape': msg`Convert Path to Shape`, 'Shape Path': msg`Shape Path`, 'Fill Shape': msg`Fill Shape`,
  'Merge Shape Components': msg`Merge Shape Components`, 'Edit Type Layer': msg`Edit Type Layer`,
  'New Type Layer': msg`New Type Layer`, 'Type Mask': msg`Type Mask`, 'Create Work Path': msg`Create Work Path`,
  'Convert to Shape': msg`Convert to Shape`, 'Update All Text Layers': msg`Update All Text Layers`,
  'Cancel Type Edit': msg`Cancel Type Edit`, 'Transform Again': msg`Transform Again`,
  Crop: msg({ message: 'Crop', context: 'history step' }), 'Perspective Crop': msg`Perspective Crop`,
  'Auto-Align Layers': msg`Auto-Align Layers`, 'Auto-Blend Layers': msg`Auto-Blend Layers`,
  Photomerge: msg`Photomerge`, Trim: msg({ message: 'Trim', context: 'history step' }),
  'Reveal All': msg`Reveal All`, 'Canvas Size': msg`Canvas Size`, 'Image Size': msg`Image Size`,
  'Rotate Canvas': msg`Rotate Canvas`, 'Add Layer Mask': msg`Add Layer Mask`,
  'Delete Layer Mask': msg`Delete Layer Mask`, 'Layer Content Options': msg`Layer Content Options`,
  'Rasterize Fill Content': msg`Rasterize Fill Content`, 'Layer Style': msg`Layer Style`,
  'Paste Layer Style': msg`Paste Layer Style`, 'Clear Layer Style': msg`Clear Layer Style`,
  'Copy Layer Style': msg`Copy Layer Style`, 'Move Layer Style': msg`Move Layer Style`,
  'Global Light': msg`Global Light`, 'Create Layers': msg`Create Layers`, 'Hide All Effects': msg`Hide All Effects`,
  'Scale Effects': msg`Scale Effects`, 'New Layer Comp': msg`New Layer Comp`,
  'Apply Layer Comp': msg`Apply Layer Comp`, 'Delete Layer Comp': msg`Delete Layer Comp`,
  'Layer Comp Options': msg`Layer Comp Options`, 'Place Linked': msg`Place Linked`,
  'Place Embedded': msg`Place Embedded`, 'Convert to Smart Object': msg`Convert to Smart Object`,
  'Convert for Smart Filters': msg`Convert for Smart Filters`, 'Vanishing Point Planes': msg`Vanishing Point Planes`,
  Fade: msg({ message: 'Fade', context: 'history step' }),
  'New Smart Object via Copy': msg`New Smart Object via Copy`, 'Replace Contents': msg`Replace Contents`,
  'Convert to Linked': msg`Convert to Linked`, 'Convert to Embedded': msg`Convert to Embedded`,
  'Relink Smart Object': msg`Relink Smart Object`, 'Update Smart Object Contents': msg`Update Smart Object Contents`,
  'Stack Mode': msg`Stack Mode`, 'File Info': msg`File Info`, 'Place Scale Marker': msg`Place Scale Marker`,
  'Straighten Layer': msg`Straighten Layer`, 'New Frame': msg`New Frame`, 'Apply Data Set': msg`Apply Data Set`,
  '90° Clockwise': msg`90° Clockwise`, '90° Counter Clockwise': msg`90° Counter Clockwise`,
  'Flip Canvas Horizontal': msg`Flip Canvas Horizontal`, 'Flip Canvas Vertical': msg`Flip Canvas Vertical`,
  'Select All': msg`Select All`, Reselect: msg`Reselect`, 'Select Inverse': msg`Select Inverse`,
  Border: msg({ message: 'Border', context: 'history step' }),
  Smooth: msg({ message: 'Smooth', context: 'history step' }),
  Expand: msg({ message: 'Expand', context: 'history step' }),
  Contract: msg({ message: 'Contract', context: 'history step' }), 'RGB Color': msg`RGB Color`,
  Grayscale: msg`Grayscale`, Bitmap: msg`Bitmap`, Duotone: msg`Duotone`, 'Indexed Color': msg`Indexed Color`,
  'CMYK Color': msg`CMYK Color`, 'Lab Color': msg`Lab Color`, Multichannel: msg`Multichannel`,
  'Bring to Front': msg`Bring to Front`, 'Bring Forward': msg`Bring Forward`, 'Send Backward': msg`Send Backward`,
  'Send to Back': msg`Send to Back`, 'Merge Down': msg`Merge Down`, 'Merge Layers': msg`Merge Layers`,
  'Merge Visible': msg`Merge Visible`, 'Stamp Visible': msg`Stamp Visible`, 'Flatten Image': msg`Flatten Image`,
  'Top Edges': msg`Top Edges`, 'Vertical Centers': msg`Vertical Centers`, 'Bottom Edges': msg`Bottom Edges`,
  'Left Edges': msg`Left Edges`, 'Horizontal Centers': msg`Horizontal Centers`, 'Right Edges': msg`Right Edges`,
  'Paint Bucket': msg`Paint Bucket`, 'Make Selection from Path': msg`Make Selection from Path`,
  'Shape Layer': msg`Shape Layer`, 'Free Transform and Warp': msg`Free Transform and Warp`,
  Warp: msg({ message: 'Warp', context: 'history step' }),
  // Layer properties (worker/helpers.ts), paint tools and fill layers (app/helpers.ts)
  'Layer Properties': msg`Layer Properties`, 'Rename Layer': msg`Rename Layer`, 'Show Layer': msg`Show Layer`,
  'Hide Layer': msg`Hide Layer`, 'Fill Opacity': msg`Fill Opacity`, 'Blend Mode': msg`Blend Mode`,
  'Create Clipping Mask': msg`Create Clipping Mask`, 'Release Clipping Mask': msg`Release Clipping Mask`,
  'Lock Layer': msg`Lock Layer`, 'Enable Layer Mask': msg`Enable Layer Mask`,
  'Disable Layer Mask': msg`Disable Layer Mask`, Brush: msg({ message: 'Brush', context: 'history step' }),
  Pencil: msg({ message: 'Pencil', context: 'history step' }),
  Eraser: msg({ message: 'Eraser', context: 'history step' }), 'Clone Stamp': msg`Clone Stamp`,
  'Pattern Stamp': msg`Pattern Stamp`, 'Spot Healing Brush': msg`Spot Healing Brush`,
  'Healing Brush': msg`Healing Brush`, 'History Brush': msg`History Brush`,
  'Art History Brush': msg`Art History Brush`, Smudge: msg`Smudge`, Dodge: msg`Dodge`, Burn: msg`Burn`,
  'Color Replacement': msg`Color Replacement`, 'Mixer Brush': msg`Mixer Brush`,
  'Background Eraser': msg`Background Eraser`, 'Solid Color': msg`Solid Color`,
  Pattern: msg({ message: 'Pattern', context: 'history step' }),
  // AnalysisDialogs
  'Set Measurement Scale': msg`Set Measurement Scale`,
  // measureTools
  'Move Artboard': msg`Move Artboard`, Count: msg({ message: 'Count', context: 'history step' }),
  'Delete Color Sampler': msg`Delete Color Sampler`, 'Color Sampler': msg`Color Sampler`, 'New Note': msg`New Note`,
  'New Slice': msg`New Slice`, 'Count Group Visibility': msg`Count Group Visibility`,
  'Clear Count': msg`Clear Count`, 'Clear Color Samplers': msg`Clear Color Samplers`,
  'Delete All Notes': msg`Delete All Notes`, 'Slices From Guides': msg`Slices From Guides`,
  'Slice Options': msg`Slice Options`, 'Delete Slice': msg`Delete Slice`,
  // menus
  Rasterize: msg({ message: 'Rasterize', context: 'history step' }),
  'Smart Object': msg({ message: 'Smart Object', context: 'history step' }),
  'Fill with Foreground Color': msg`Fill with Foreground Color`,
  'Fill with Background Color': msg`Fill with Background Color`, 'Delete Filter Mask': msg`Delete Filter Mask`,
  'Clear Smart Filters': msg`Clear Smart Filters`,
  // penTools
  'Add Path Component': msg`Add Path Component`, 'Edit Path': msg`Edit Path`,
  'Duplicate Path Component': msg`Duplicate Path Component`, 'Move Path': msg`Move Path`,
  'Move Anchor': msg`Move Anchor`, 'Delete Anchor Point': msg`Delete Anchor Point`,
  'Delete Path Component': msg`Delete Path Component`, 'Convert Point': msg`Convert Point`,
  'Pen Shape': msg`Pen Shape`, 'Freeform Shape': msg`Freeform Shape`, 'Curvature Shape': msg`Curvature Shape`,
  'Pen Path': msg`Pen Path`, 'Freeform Path': msg`Freeform Path`, 'Curvature Path': msg`Curvature Path`,
  // toolEffects
  'Polygonal Lasso': msg`Polygonal Lasso`, Lasso: msg`Lasso`, 'Magnetic Lasso': msg`Magnetic Lasso`,
  'Move Selection Copy': msg`Move Selection Copy`, 'Move Selection': msg`Move Selection`,
  'Move Copy': msg`Move Copy`, Move: msg({ message: 'Move', context: 'history step' }),
  'Magic Eraser': msg`Magic Eraser`,
  // transform
  'Transform Selection': msg`Transform Selection`, 'Free Transform': msg`Free Transform`,
  // typeMenu
  'Rasterize Type Layer': msg`Rasterize Type Layer`, 'Paste Lorem Ipsum': msg`Paste Lorem Ipsum`,
  'Load Default Type Styles': msg`Load Default Type Styles`,
  // typeTools
  'Character Formatting': msg`Character Formatting`, 'Paragraph Formatting': msg`Paragraph Formatting`,
  // vectorCommands
  'Paste Shape Attributes': msg`Paste Shape Attributes`,
  // App
  'Import Data Sets': msg`Import Data Sets`, Variables: msg({ message: 'Variables', context: 'history step' }),
  'Delete and Fill Selection': msg`Delete and Fill Selection`, 'Content-Aware Fill': msg`Content-Aware Fill`,
  // GlyphsPanel
  'Insert Glyph': msg`Insert Glyph`,
  // LayersPanel
  'Hide Layer Effects': msg`Hide Layer Effects`, 'Show Layer Effects': msg`Show Layer Effects`,
  'Make Selection from Vector Mask': msg`Make Selection from Vector Mask`,
  // MissingFonts
  'Replace Missing Fonts': msg`Replace Missing Fonts`, 'Resolve Missing Fonts': msg`Resolve Missing Fonts`,
  'Replace All Missing Fonts': msg`Replace All Missing Fonts`,
  // NotesPanels
  'Edit Note': msg`Edit Note`, 'Delete Note': msg`Delete Note`,
  // PropertiesPanel
  'Artboard Background': msg`Artboard Background`, 'Shape Stroke': msg`Shape Stroke`, 'Shape Fill': msg`Shape Fill`,
  'Corner Radius': msg`Corner Radius`, 'Polygon Sides': msg`Polygon Sides`,
  'Polygon Star Ratio': msg`Polygon Star Ratio`, 'Reset Vector Mask Properties': msg`Reset Vector Mask Properties`,
  'Vector Mask Density': msg`Vector Mask Density`, 'Vector Mask Feather': msg`Vector Mask Feather`,
  'Delete Vector Mask': msg`Delete Vector Mask`, 'Stroke Style': msg`Stroke Style`,
  'Stroke Placement': msg`Stroke Placement`, 'Stroke Cap': msg`Stroke Cap`, 'Stroke Join': msg`Stroke Join`,
  'Enable Vector Mask': msg`Enable Vector Mask`, 'Link Vector Mask': msg`Link Vector Mask`,
  'Invert Vector Mask': msg`Invert Vector Mask`, 'Adjustment Visibility': msg`Adjustment Visibility`,
  'Adjustment Clipping': msg`Adjustment Clipping`, 'Artboard X': msg`Artboard X`, 'Artboard Y': msg`Artboard Y`,
  'Artboard W': msg`Artboard W`, 'Artboard H': msg`Artboard H`,
  // TypePanels
  'Font Size': msg`Font Size`, Leading: msg`Leading`, Tracking: msg`Tracking`, 'Text Color': msg`Text Color`,
  'Faux Bold': msg`Faux Bold`, 'Faux Italic': msg`Faux Italic`, Underline: msg`Underline`,
  Strikethrough: msg`Strikethrough`, 'Baseline Shift': msg`Baseline Shift`, Uppercase: msg`Uppercase`,
  'Small Caps': msg`Small Caps`, Superscript: msg`Superscript`, Subscript: msg`Subscript`,
  Alignment: msg`Alignment`,
  // Shape operations, layer effects, adjustments and marquee tools (descriptor tables)
  'Unite Shapes': msg`Unite Shapes`, 'Subtract Front Shape': msg`Subtract Front Shape`,
  'Intersect Shape Areas': msg`Intersect Shape Areas`, 'Exclude Overlapping Shapes': msg`Exclude Overlapping Shapes`,
  'Bevel & Emboss': msg`Bevel & Emboss`, Contour: msg`Contour`, 'Inner Shadow': msg`Inner Shadow`,
  'Inner Glow': msg`Inner Glow`, Satin: msg`Satin`, 'Color Overlay': msg`Color Overlay`,
  'Gradient Overlay': msg`Gradient Overlay`, 'Pattern Overlay': msg`Pattern Overlay`, 'Outer Glow': msg`Outer Glow`,
  'Drop Shadow': msg`Drop Shadow`, 'Shadows/Highlights': msg`Shadows/Highlights`, 'HDR Toning': msg`HDR Toning`,
  Desaturate: msg`Desaturate`, 'Match Color': msg`Match Color`, 'Replace Color': msg`Replace Color`,
  Equalize: msg`Equalize`, 'Auto Tone': msg`Auto Tone`, 'Auto Contrast': msg`Auto Contrast`,
  'Auto Color': msg`Auto Color`, 'Brightness / Contrast': msg`Brightness / Contrast`,
  'Hue / Saturation': msg`Hue / Saturation`, 'Rectangular Marquee': msg`Rectangular Marquee`,
  'Elliptical Marquee': msg`Elliptical Marquee`, 'Single Row Marquee': msg`Single Row Marquee`,
  'Single Column Marquee': msg`Single Column Marquee`,
  // Actions panel stop step
  Stop: msg({ message: 'Stop', context: 'history step' }),
};

// Interpolated labels: the English pattern, its message and the placeholder values (inner step names translated).
export const HISTORY_PATTERNS: { re: RegExp; d: MessageDescriptor; values: (m: RegExpExecArray) => Record<string, string> }[] = [
  // Worker Actions recorder: a step that reads a file is listed but not recorded.
  { re: /^(.+) \(uses a file, not recorded\)$/, d: msg({ message: '{step} (uses a file, not recorded)' }), values: m => ({ step: historyLabel(m[1]) }) },
  // Image > Mode > 8/16/32 Bits/Channel.
  { re: /^(\d+) Bits\/Channel$/, d: msg({ message: '{depth} Bits/Channel' }), values: m => ({ depth: m[1] }) },
  // Layer > Align / Distribute: the edge names have their own entries.
  { re: /^Align (.+)$/, d: msg({ message: 'Align {edges}' }), values: m => ({ edges: historyLabel(m[1]) }) },
  { re: /^Distribute (.+)$/, d: msg({ message: 'Distribute {edges}' }), values: m => ({ edges: historyLabel(m[1]) }) },
  // Layers panel effect eye: one effect by name.
  { re: /^Hide (.+)$/, d: msg({ message: 'Hide {effect}' }), values: m => ({ effect: historyLabel(m[1]) }) },
  { re: /^Show (.+)$/, d: msg({ message: 'Show {effect}' }), values: m => ({ effect: historyLabel(m[1]) }) },
  // Character Styles panel: the style name is user data.
  { re: /^Apply (.+)$/, d: msg({ message: 'Apply {style}' }), values: m => ({ style: m[1] }) },
];

/** Shown text for an English history label in the UI language; unknown labels fall back to engineLabel (filters). */
export function historyLabel(english: string): string {
  if (Object.hasOwn(HISTORY_LABELS, english)) return i18n._(HISTORY_LABELS[english]);
  for (const p of HISTORY_PATTERNS) {
    const m = p.re.exec(english);
    if (m) return i18n._({ ...p.d, values: p.values(m) });
  }
  return Object.hasOwn(ENGINE_LABELS, english) ? engineLabel(english) : english;
}
