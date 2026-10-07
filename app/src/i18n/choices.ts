// Display text for option choice ids (tool options bar, blend and paint modes). Ids stay the stored and
// compared values; only the shown text is translated. choices.test.ts keeps every id covered.
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { i18n } from './index.ts';

export const CHOICE_LABELS: Record<string, MessageDescriptor> = {
  // Blend and paint modes
  normal: msg`Normal`, dissolve: msg`Dissolve`, behind: msg`Behind`, clear: msg`Clear`,
  darken: msg`Darken`, multiply: msg`Multiply`, 'color burn': msg`Color Burn`, 'linear burn': msg`Linear Burn`, 'darker color': msg`Darker Color`,
  lighten: msg`Lighten`, screen: msg`Screen`, 'color dodge': msg`Color Dodge`, 'linear dodge': msg`Linear Dodge (Add)`, 'lighter color': msg`Lighter Color`,
  overlay: msg`Overlay`, 'soft light': msg`Soft Light`, 'hard light': msg`Hard Light`, 'vivid light': msg`Vivid Light`,
  'linear light': msg`Linear Light`, 'pin light': msg`Pin Light`, 'hard mix': msg`Hard Mix`,
  difference: msg`Difference`, exclusion: msg`Exclusion`, subtract: msg`Subtract`, divide: msg`Divide`,
  hue: msg`Hue`, saturation: msg`Saturation`, color: msg`Color`, luminosity: msg`Luminosity`,
  // Selection and path operations
  new: msg`New`, add: msg`Add`, intersect: msg`Intersect`, exclude: msg`Exclude`,
  // Sampling and limits
  continuous: msg`Continuous`, once: msg`Once`, backgroundSwatch: msg`Background Swatch`,
  discontiguous: msg`Discontiguous`, contiguous: msg`Contiguous`, findEdges: msg`Find Edges`,
  point: msg`Point Sample`, '3x3': msg`3 by 3 Average`, '5x5': msg`5 by 5 Average`, '11x11': msg`11 by 11 Average`,
  '31x31': msg`31 by 31 Average`, '51x51': msg`51 by 51 Average`, '101x101': msg`101 by 101 Average`,
  'current layer': msg`Current Layer`, 'all layers': msg`All Layers`,
  currentLayer: msg`Current Layer`, currentBelow: msg`Current & Below`, allLayers: msg`All Layers`,
  // Toning, sponge, eraser
  shadows: msg`Shadows`, midtones: msg`Midtones`, highlights: msg`Highlights`,
  desaturate: msg`Desaturate`, saturate: msg`Saturate`, brush: msg`Brush`, pencil: msg`Pencil`, block: msg`Block`,
  // Shapes, pens, type
  shape: msg`Shape`, path: msg`Path`, pixels: msg`Pixels`,
  fill: msg({ message: 'Fill', context: 'shape appearance' }), outline: msg`Outline`, both: msg`Both`, none: msg`None`,
  left: msg`Left`, center: msg`Center`, right: msg`Right`, free: msg`Free`, axis: msg`Axis`,
  // Move, marquee, crop, slice
  layer: msg`Layer`, group: msg`Group`, 'fixed ratio': msg`Fixed Ratio`, 'fixed size': msg`Fixed Size`,
  original: msg`Original Ratio`, '1:1': msg`1:1`, '4:5': msg`4:5`, '5:7': msg`5:7`, '2:3': msg`2:3`, '16:9': msg`16:9`,
  thirds: msg`Rule of Thirds`, grid: msg`Grid`, diagonal: msg`Diagonal`, triangle: msg`Triangle`,
  'golden ratio': msg`Golden Ratio`, 'golden spiral': msg`Golden Spiral`,
  // Healing, patch, content-aware move
  proximityMatch: msg`Proximity Match`, createTexture: msg`Create Texture`, contentAware: msg`Content-Aware`,
  sampled: msg`Sampled`, pattern: msg`Pattern`, source: msg`Source`, destination: msg`Destination`, move: msg`Move`, extend: msg`Extend`,
  // Art History Brush styles
  tightShort: msg`Tight Short`, tightMedium: msg`Tight Medium`, tightLong: msg`Tight Long`, looseMedium: msg`Loose Medium`,
  looseLong: msg`Loose Long`, dab: msg`Dab`, tightCurl: msg`Tight Curl`, tightCurlLong: msg`Tight Curl Long`,
  looseCurl: msg`Loose Curl`, looseCurlLong: msg`Loose Curl Long`,
  // Gradient
  linear: msg`Linear`, radial: msg`Radial`, angle: msg`Angle`, reflected: msg`Reflected`, diamond: msg`Diamond`,
  perceptual: msg`Perceptual`, classic: msg`Classic`,
  // Fill sources, artboard background, frame shape
  foreground: msg`Foreground`, background: msg`Background`, white: msg`White`, black: msg`Black`, transparent: msg`Transparent`,
  rectangle: msg`Rectangle`, ellipse: msg`Ellipse`,
};

/** Shown text for a choice id in the UI language; an unknown id is shown as is. */
export function choiceLabel(id: string): string {
  const d = Object.hasOwn(CHOICE_LABELS, id) ? CHOICE_LABELS[id] : undefined;
  return d ? i18n._(d) : id;
}
