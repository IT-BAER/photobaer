// Filter Gallery effect layers (docs/M5.md section 4): the effects by group, the selected layer's params,
// and the stack top first with an enable checkbox per layer. Layer 0 applies first.
import { useState } from 'react';
import type { MessageDescriptor } from '@lingui/core';
import { msg, t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { FieldSpec } from '../adjustments.ts';
import { i18n } from '../i18n/index.ts';
import { setIn } from '../layerStyle.ts';
import { Field } from '../PropertiesPanel.tsx';
import type { GalleryLayer, ParamValue } from './lastFilter.ts';
import { engineLabel } from './labels.ts';
import { defaults, fieldSpecs, schema, specOf, visibleParams, type FilterSpec } from './schema.ts';

const GROUPS: [string, MessageDescriptor][] = [
  ['gallery.artistic', msg`Artistic`], ['gallery.brushStrokes', msg`Brush Strokes`], ['gallery.distort', msg`Distort`],
  ['gallery.sketch', msg`Sketch`], ['gallery.stylize', msg`Stylize`], ['gallery.texture', msg`Texture`],
];

// Display text of the engine's select choice ids (the id is the stored value; unknown ids fall back to the id's words).
const CHOICES: Record<string, MessageDescriptor> = {
  none: msg`None`, transparency: msg`Transparency`, layerMask: msg`Layer Mask`, triangle: msg`Triangle`,
  square: msg`Square`, pentagon: msg`Pentagon`, hexagon: msg`Hexagon`, heptagon: msg`Heptagon`,
  octagon: msg`Octagon`, uniform: msg`Uniform`, gaussian: msg`Gaussian`, spin: msg`Spin`,
  zoom: msg`Zoom`, draft: msg`Draft`, good: msg`Good`, best: msg`Best`,
  circle: msg`Circle`, diamond: msg`Diamond`, cross: msg`Cross`, star: msg`Star`,
  ring: msg`Ring`, low: msg`Low`, medium: msg`Medium`, high: msg`High`,
  normal: msg`Normal`, edgeOnly: msg`Edge Only`, overlayEdge: msg`Overlay Edge`, basic: msg`Basic`,
  rearSync: msg`Rear Sync`, stretchToFit: msg`Stretch To Fit`, tile: msg`Tile`, wrapAround: msg`Wrap Around`,
  repeatEdgePixels: msg`Repeat Edge Pixels`, rectToPolar: msg`Rect To Polar`, polarToRect: msg`Polar To Rect`, small: msg`Small`,
  large: msg`Large`, horizontalOnly: msg`Horizontal Only`, verticalOnly: msg`Vertical Only`, sine: msg`Sine`,
  pondRipples: msg`Pond Ripples`, outFromCenter: msg`Out From Center`, aroundCenter: msg`Around Center`, fineDots: msg`Fine Dots`,
  mediumDots: msg`Medium Dots`, grainyDots: msg`Grainy Dots`, coarseDots: msg`Coarse Dots`, shortLines: msg`Short Lines`,
  mediumLines: msg`Medium Lines`, longLines: msg`Long Lines`, shortStrokes: msg`Short Strokes`, mediumStrokes: msg`Medium Strokes`,
  longStrokes: msg`Long Strokes`, zoom50to300: msg`Zoom50to300`, prime35: msg`Prime35`, prime105: msg`Prime105`,
  moviePrime: msg`Movie Prime`, red: msg`Red`, green: msg`Green`, blue: msg`Blue`,
  luminance: msg`Luminance`, oneFlameAlongPath: msg`One Flame Along Path`, multipleFlamesOnePath: msg`Multiple Flames One Path`, multipleFlamesPathDirection: msg`Multiple Flames Path Direction`,
  multipleFlamesVarious: msg`Multiple Flames Various`, candle: msg`Candle`, arc: msg`Arc`, simple: msg`Simple`,
  doubleLine: msg`Double Line`, beads: msg`Beads`, ivy: msg`Ivy`, ribbon: msg`Ribbon`,
  scallop: msg`Scallop`, walnut: msg`Walnut`, gilt: msg`Gilt`, black: msg`Black`,
  white: msg`White`, cream: msg`Cream`, charcoal: msg`Charcoal`, all: msg`All`,
  horizontal: msg`Horizontal`, vertical: msg`Vertical`, maple: msg`Maple`, birch: msg`Birch`,
  poplar: msg`Poplar`, oak: msg`Oak`, willow: msg`Willow`, pine: msg`Pine`,
  gaussianBlur: msg`Gaussian Blur`, lensBlur: msg`Lens Blur`, motionBlur: msg`Motion Blur`, darkenOnly: msg`Darken Only`,
  lightenOnly: msg`Lighten Only`, anisotropic: msg`Anisotropic`, blocks: msg`Blocks`, pyramids: msg`Pyramids`,
  random: msg`Random`, level: msg`Level`, background: msg`Background`, foreground: msg`Foreground`,
  inverseImage: msg`Inverse Image`, unalteredImage: msg`Unaltered Image`, lower: msg`Lower`, upper: msg`Upper`,
  wind: msg`Wind`, blast: msg`Blast`, stagger: msg`Stagger`, fromTheLeft: msg`From The Left`,
  fromTheRight: msg`From The Right`, oddFields: msg`Odd Fields`, evenFields: msg`Even Fields`, duplication: msg`Duplication`,
  interpolation: msg`Interpolation`, auto: msg`Auto`, fisheye: msg`Fisheye`, perspective: msg`Perspective`,
  fullSpherical: msg`Full Spherical`, edgeExtension: msg`Edge Extension`, rgb: msg`Rgb`, hsb: msg`Hsb`,
  hsl: msg`Hsl`, squareness: msg`Squareness`, roundness: msg`Roundness`, setToBackground: msg`Set To Background`,
  magenta: msg`Magenta`, amber: msg`Amber`, lightRough: msg`Light Rough`, darkRough: msg`Dark Rough`,
  wideSharp: msg`Wide Sharp`, wideBlurry: msg`Wide Blurry`, sparkle: msg`Sparkle`, brick: msg`Brick`,
  burlap: msg`Burlap`, canvas: msg`Canvas`, sandstone: msg`Sandstone`, top: msg`Top`,
  topLeft: msg`Top Left`, left: msg`Left`, bottomLeft: msg`Bottom Left`, bottom: msg`Bottom`,
  bottomRight: msg`Bottom Right`, right: msg`Right`, topRight: msg`Top Right`, rightDiagonal: msg`Right Diagonal`,
  leftDiagonal: msg`Left Diagonal`, frosted: msg`Frosted`, tinyLens: msg`Tiny Lens`, dot: msg`Dot`,
  line: msg`Line`, regular: msg`Regular`, soft: msg`Soft`, sprinkles: msg`Sprinkles`,
  clumped: msg`Clumped`, contrasty: msg`Contrasty`, enlarged: msg`Enlarged`, stippled: msg`Stippled`,
  speckle: msg`Speckle`,
};

// A filter's dialog fields with engine labels and select choices shown in the UI language.
export function localFields(spec: FilterSpec): FieldSpec[] {
  return fieldSpecs(spec).map((f): FieldSpec => {
    const p = spec.params.find(q => q.key === f.path.split('.')[0]);
    const label = p && f.label.startsWith(p.label) ? engineLabel(p.label) + f.label.slice(p.label.length) : f.label;
    if (f.type !== 'select') return { ...f, label };
    return { ...f, label, options: f.options.map(([v, text]) => [v, Object.hasOwn(CHOICES, v) ? i18n._(CHOICES[v]) : text]) };
  });
}

// An effect's visible params at their defaults; the gallery filter supplies its seed and colors.
function fresh(kind: string): GalleryLayer {
  const s = specOf(kind)!, d = defaults(s);
  return { kind, enabled: true, params: Object.fromEntries(visibleParams(s).map(p => [p.key, d[p.key]])) };
}

const label = (kind: string) => engineLabel(specOf(kind)?.label ?? kind);

export function GalleryStack({ value, onChange }: { value: GalleryLayer[]; onChange: (v: GalleryLayer[]) => void }) {
  const [sel, setSel] = useState(value.length - 1);
  const cur = value[sel] as GalleryLayer | undefined;
  const spec = cur && specOf(cur.kind);
  const put = (v: GalleryLayer[], i: number) => { onChange(v); setSel(i); };
  const pick = (kind: string) => (cur
    ? put(value.map((l, i) => (i === sel ? { ...fresh(kind), enabled: l.enabled } : l)), sel)
    : put([...value, fresh(kind)], value.length));
  const move = (d: number) => {
    const v = [...value];
    [v[sel], v[sel + d]] = [v[sel + d], v[sel]];
    put(v, sel + d);
  };
  return (
    <div className="gallery-stack">
      <div className="gallery-effects">
        {GROUPS.map(([g, name], i) => (
          <details key={g} open={i === 0}>
            <summary>{i18n._(name)}</summary>
            {schema().filter(s => s.group === g).map(s => (
              <button key={s.id} type="button" aria-pressed={cur?.kind === s.id} onClick={() => pick(s.id)}>{engineLabel(s.label)}</button>
            ))}
          </details>
        ))}
      </div>
      <div className="gallery-params">
        <h3>{cur ? label(cur.kind) : t`No effect selected`}</h3>
        {!cur || !spec ? <p className="adjustment-note"><Trans>Pick a filter to start a stack.</Trans></p>
          : localFields(spec).length === 0 ? <p className="adjustment-note"><Trans>This filter has no options.</Trans></p>
            : localFields(spec).map(f => <Field key={f.path} spec={f} params={cur.params}
                onChange={(path, v) => onChange(value.map((l, i) => (i === sel ? { ...l, params: setIn(l.params, path, v as ParamValue) } : l)))} />)}
      </div>
      <div className="gallery-layers">
        <ol aria-label={t`Effect layers`}>
          {value.map((l, i) => ({ l, i })).reverse().map(({ l, i }) => {
            const name = label(l.kind);
            return (
              <li key={i}>
              <input type="checkbox" aria-label={t`${name} enabled`} checked={l.enabled}
                onChange={() => onChange(value.map((q, k) => (k === i ? { ...q, enabled: !q.enabled } : q)))} />
              <button type="button" aria-pressed={i === sel} onClick={() => setSel(i)}>{`${i + 1}. ${name}`}</button>
            </li>
            );
          })}
        </ol>
        <div className="gallery-buttons">
          <button type="button" onClick={() => put([...value, cur ? { ...cur, params: { ...cur.params } } : fresh(schema().find(s => s.group === GROUPS[0][0])!.id)], value.length)}><Trans>New Effect Layer</Trans></button>
          <button type="button" disabled={!cur} onClick={() => put(value.filter((_, i) => i !== sel), value.length - 2)}><Trans>Delete</Trans></button>
          <button type="button" disabled={!cur || sel <= 0} onClick={() => move(-1)}><Trans>Move Down</Trans></button>
          <button type="button" disabled={!cur || sel >= value.length - 1} onClick={() => move(1)}><Trans>Move Up</Trans></button>
        </div>
      </div>
    </div>
  );
}
