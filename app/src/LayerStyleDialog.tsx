// Layer > Layer Style dialog (docs/M3.md section 5 "UI"): effect list on the left, the selected page in the
// middle, OK / Cancel / Preview and a sample swatch on the right. Edits preview on the canvas through the
// worker's preview session (debounced 70 ms); OK commits one "Layer Style" step, Cancel restores.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { client } from './client.ts';
import type { DocInfo, FillContent, GlobalLight, LayerNode } from './engine.worker.ts';
import type { BrushLibrary } from './brushes/store.ts';
import { PatternPicker, adoptPatterns } from './PresetPanels.tsx';
import { Field, type OpenGradientEditor } from './PropertiesPanel.tsx';
import { getPath, gradientDefToUi, uiToGradientDef, type FieldSpec } from './adjustments.ts';
import { blendModesFor } from './layers.ts';
import { i18n } from './i18n/index.ts';
import { choiceLabel } from './i18n/choices.ts';
import { rampCss } from './gradients/gradient.ts';
import { rgbToHex, type Rgb } from './shell/color.ts';
import {
  CONTOUR_PRESETS, EFFECT_KINDS, EFFECT_LABEL, MAX_INSTANCES, MULTI, defaultGradientParams, effectDefault, emptyStyle, instances,
  saveEffectDefault, setIn, withInstances, type BlendRange, type Blending, type Contour, type EffectKind, type LayerStyle, type Quad, type StyleLibrary,
} from './layerStyle.ts';

export type StylePage = 'styles' | 'blending' | { kind: EffectKind; index: number };
type Spec =
  | FieldSpec
  | { type: 'blend' | 'color' | 'contour' | 'pattern' | 'gradient' | 'angle'; label: string; path: string }
  | { type: 'fill' }
  | { type: 'glowFill' };

const num = (label: string, path: string, min: number, max: number, scale?: number): FieldSpec => ({ type: 'number', label, path, min, max, step: 1, scale });
const pct = (label: string, path: string, min = 0, max = 100) => num(`${label} (%)`, path, min, max, 100);
const check = (label: string, path: string): FieldSpec => ({ type: 'checkbox', label, path });
const select = (label: string, path: string, options: [string, string][]): FieldSpec => ({ type: 'select', label, path, options });
const f = <T extends Spec['type']>(type: T, label: string, path: string) => ({ type, label, path }) as Spec;

const shadow = (inner: boolean): Spec[] => [
  f('blend', t`Blend Mode`, 'blend'), f('color', t`Color`, 'color'), pct(t`Opacity`, 'opacity'),
  f('angle', t`Angle`, 'angle'), check(t`Use Global Light`, 'use_global_light'),
  num(t`Distance (px)`, 'distance', 0, 250), pct(inner ? t`Choke` : t`Spread`, 'spread'), num(t`Size (px)`, 'size', 0, 250),
  f('contour', t`Contour`, 'contour'), check(t`Anti-aliased`, 'contour.anti_alias'), pct(t`Noise`, 'noise'),
  ...(inner ? [] : [check(t`Layer Knocks Out Drop Shadow`, 'knocks_out')]),
];
const glow = (inner: boolean): Spec[] => [
  f('blend', t`Blend Mode`, 'blend'), pct(t`Opacity`, 'opacity'), pct(t`Noise`, 'noise'), { type: 'glowFill' },
  select(t`Technique`, 'technique', [['softer', t`Softer`], ['precise', t`Precise`]]),
  ...(inner ? [select(t`Source`, 'source', [['center', t`Center`], ['edge', t`Edge`]])] : []),
  pct(inner ? t`Choke` : t`Spread`, 'spread'), num(t`Size (px)`, 'size', 0, 250),
  f('contour', t`Contour`, 'contour'), check(t`Anti-aliased`, 'contour.anti_alias'), pct(t`Range`, 'range', 1, 100), pct(t`Jitter`, 'jitter'),
];
const gradientFields = (p: string): Spec[] => [
  f('gradient', t`Gradient`, `${p}gradient`),
  select(t`Method`, `${p}gradient.method`, [['perceptual', t`Perceptual`], ['linear', t`Linear`], ['classic', t`Classic`]]),
  select(t`Style`, `${p}style`, [['linear', t`Linear`], ['radial', t`Radial`], ['angle', t`Angle`], ['reflected', t`Reflected`], ['diamond', t`Diamond`]]),
  num(t`Angle (°)`, `${p}angle`, -180, 180), pct(t`Scale`, `${p}scale`, 10, 150),
  check(t`Reverse`, `${p}reverse`), check(t`Dither`, `${p}dither`), check(t`Align with Layer`, `${p}align_with_layer`),
];
const patternFields = (p: string): Spec[] => [
  f('pattern', t`Pattern`, `${p}pattern_id`), pct(t`Scale`, `${p}scale`, 1, 1000), num(t`Angle (°)`, `${p}angle`, -180, 180),
  check(t`Link with Layer`, `${p}linked`),
];

const pages = (): Record<EffectKind, Spec[]> => ({
  drop_shadows: shadow(false),
  inner_shadows: shadow(true),
  outer_glow: glow(false),
  inner_glow: glow(true),
  bevel: [
    select(t`Style`, 'style', [['outer', t`Outer Bevel`], ['inner', t`Inner Bevel`], ['emboss', t`Emboss`], ['pillow', t`Pillow Emboss`], ['stroke_emboss', t`Stroke Emboss`]]),
    select(t`Technique`, 'technique', [['smooth', t`Smooth`], ['chisel_hard', t`Chisel Hard`], ['chisel_soft', t`Chisel Soft`]]),
    pct(t`Depth`, 'depth', 1, 1000), select(t`Direction`, 'direction', [['up', t`Up`], ['down', t`Down`]]),
    num(t`Size (px)`, 'size', 0, 250), num(t`Soften (px)`, 'soften', 0, 16),
    f('angle', t`Angle`, 'angle'), f('angle', t`Altitude`, 'altitude'), check(t`Use Global Light`, 'use_global_light'),
    f('contour', t`Gloss Contour`, 'gloss_contour'), check(t`Anti-aliased`, 'gloss_contour.anti_alias'),
    f('blend', t`Highlight Mode`, 'highlight_blend'), f('color', t`Highlight Color`, 'highlight_color'), pct(t`Highlight Opacity`, 'highlight_opacity'),
    f('blend', t`Shadow Mode`, 'shadow_blend'), f('color', t`Shadow Color`, 'shadow_color'), pct(t`Shadow Opacity`, 'shadow_opacity'),
  ],
  contour: [f('contour', t`Contour`, 'contour'), check(t`Anti-aliased`, 'contour.anti_alias'), pct(t`Range`, 'range', 1, 100)],
  texture: [
    f('pattern', t`Pattern`, 'pattern_id'), pct(t`Scale`, 'scale', 1, 1000), pct(t`Depth`, 'depth', -1000, 1000),
    check(t`Invert`, 'invert'), check(t`Link with Layer`, 'linked'),
  ],
  satin: [
    f('blend', t`Blend Mode`, 'blend'), f('color', t`Color`, 'color'), pct(t`Opacity`, 'opacity'), num(t`Angle (°)`, 'angle', -180, 180),
    num(t`Distance (px)`, 'distance', 0, 250), num(t`Size (px)`, 'size', 0, 250), f('contour', t`Contour`, 'contour'),
    check(t`Anti-aliased`, 'contour.anti_alias'), check(t`Invert`, 'invert'),
  ],
  color_overlays: [f('blend', t`Blend Mode`, 'blend'), f('color', t`Color`, 'color'), pct(t`Opacity`, 'opacity')],
  gradient_overlays: [f('blend', t`Blend Mode`, 'blend'), pct(t`Opacity`, 'opacity'), ...gradientFields('gradient.')],
  pattern_overlays: [f('blend', t`Blend Mode`, 'blend'), pct(t`Opacity`, 'opacity'), ...patternFields('pattern.')],
  strokes: [
    num(t`Size (px)`, 'size', 1, 250), select(t`Position`, 'position', [['outside', t`Outside`], ['inside', t`Inside`], ['center', t`Center`]]),
    f('blend', t`Blend Mode`, 'blend'), pct(t`Opacity`, 'opacity'), check(t`Overprint`, 'overprint'), { type: 'fill' },
  ],
});

// Light-bound fields: an angle or altitude with "use global light" edits the document light.
const LIGHT_BOUND: Partial<Record<EffectKind, true>> = { drop_shadows: true, inner_shadows: true, bevel: true };

// The contour's curve as an SVG path in a 32 x 24 box.
const contourPath = (c: Contour) => c.points.map(([x, y], i) => `${i ? 'L' : 'M'}${1 + (x / 255) * 30} ${23 - (y / 255) * 22}`).join(' ');

function ContourGrid({ value, set }: { value: Contour; set: (c: Contour) => void }) {
  return (
    <div className="contour-grid" role="group" aria-label={t`Contour`}>
      {CONTOUR_PRESETS.map(c => (
        <button key={c.name} type="button" title={c.name} aria-label={c.name} aria-pressed={c.name === value.name}
          className={c.name === value.name ? 'active' : ''} onClick={() => set({ ...structuredClone(c), anti_alias: value.anti_alias })}>
          <svg viewBox="0 0 32 24" width={32} height={24}><path d={contourPath(c)} fill="none" stroke="currentColor" strokeWidth={1.5} /></svg>
        </button>
      ))}
    </div>
  );
}

// One blend-if bar: [black outer, black inner, white inner, white outer]; Alt-drag splits a handle.
const handleName = (cls: string, outer: boolean) => (cls === 'black' ? (outer ? t`black outer` : t`black inner`) : outer ? t`white outer` : t`white inner`);
function BlendIfBar({ label, value, set }: { label: string; value: Quad; set: (q: Quad) => void }) {
  const bar = useRef<HTMLDivElement>(null);
  const drag = (e: ReactPointerEvent, which: number[]) => {
    e.preventDefault();
    const start = [...value] as Quad;
    const r = bar.current!.getBoundingClientRect();
    const x0 = e.clientX;
    const move = (ev: PointerEvent) => {
      const d = Math.round(((ev.clientX - x0) / r.width) * 255);
      const q = [...start] as Quad;
      for (const i of which) q[i] = Math.min(255, Math.max(0, start[i] + d));
      // Keep black outer <= black inner <= white inner <= white outer.
      const lo = which.includes(0) || which.includes(1);
      if (lo) { q[1] = Math.min(q[1], q[2]); q[0] = Math.min(q[0], q[1]); } else { q[2] = Math.max(q[2], q[1]); q[3] = Math.max(q[3], q[2]); }
      set(q);
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };
  // An unsplit pair drags together; Alt drags the inner half alone, a split half drags alone.
  const handle = (outer: number, inner: number, cls: string) => {
    const split = value[outer] !== value[inner];
    const one = (i: number) => (
      <span key={i} className={`blend-if-handle ${cls}${split ? ' split' : ''}`} style={{ left: `${(value[i] / 255) * 100}%` }}
        role="slider" aria-label={t`${label} ${handleName(cls, i === outer)}`} aria-valuenow={value[i]} aria-valuemin={0} aria-valuemax={255}
        onPointerDown={e => drag(e, split ? [i] : e.altKey ? [inner] : [outer, inner])} />
    );
    return split ? [one(outer), one(inner)] : [one(inner)];
  };
  return (
    <div className="blend-if-row">
      <span>{label}: {value[0] === value[1] ? value[0] : `${value[0]}/${value[1]}`} {value[2] === value[3] ? value[3] : `${value[2]}/${value[3]}`}</span>
      <div ref={bar} className="blend-if-bar">{handle(0, 1, 'black')}{handle(3, 2, 'white')}</div>
    </div>
  );
}

// The sample swatch approximates the style with CSS (shadow, glow, overlay, stroke); the canvas shows the real render.
function Swatch({ style }: { style: LayerStyle }) {
  const on = <T extends { present: boolean; enabled: boolean }>(e: T | null | undefined) => style.enabled && e?.present && e.enabled ? e : null;
  const hex = (c: Rgb, a: number) => `${rgbToHex(c)}${Math.round(a * 255).toString(16).padStart(2, '0')}`;
  const shadows: string[] = [];
  for (const s of style.drop_shadows.filter(on)) {
    const a = (s.angle * Math.PI) / 180;
    shadows.push(`${Math.round(-Math.cos(a) * s.distance)}px ${Math.round(Math.sin(a) * s.distance)}px ${s.size}px ${hex(s.color, s.opacity)}`);
  }
  const og = on(style.outer_glow);
  if (og && og.fill.type === 'color') shadows.push(`0 0 ${og.size}px ${hex(og.fill.color, og.opacity)}`);
  const stroke = on(style.strokes[0]);
  const overlay = on(style.color_overlays[0]);
  return (
    <div className="layer-style-swatch" aria-label={t`Sample`}>
      <div style={{
        background: overlay ? rgbToHex(overlay.color) : '#ffffff',
        boxShadow: shadows.join(', ') || undefined,
        outline: stroke && stroke.fill.type === 'solid' ? `${Math.min(8, stroke.size)}px solid ${rgbToHex(stroke.fill.color)}` : undefined,
      }} />
    </div>
  );
}

export function LayerStyleDialog({ doc, node, page: initialPage, library, styles, onDoc, onError, onClose, openGradientEditor, pickColor }: {
  doc: DocInfo; node: LayerNode; page: StylePage; library: BrushLibrary | null; styles: StyleLibrary;
  onDoc: (d: DocInfo) => void; onError: (m: string) => void; onClose: () => void;
  openGradientEditor: OpenGradientEditor; pickColor: (rgb: Rgb, title: string, commit: (rgb: Rgb) => void) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const firstPattern = doc.patterns[0]?.id ?? library?.patterns()[0]?.id ?? '';
  const [style, setStyle] = useState<LayerStyle>(() => {
    const s = structuredClone(node.style) ?? emptyStyle();
    if (typeof initialPage === 'object' && !instances(s, initialPage.kind).length) {
      return withInstances(s, initialPage.kind, [effectDefault(initialPage.kind, firstPattern)]);
    }
    return s;
  });
  const [blending, setBlending] = useState<Blending>(() => structuredClone(node.blending));
  const [fill, setFill] = useState(node.fill);
  const [light, setLight] = useState<GlobalLight>(doc.globalLight);
  const [lightChanged, setLightChanged] = useState(false);
  const [page, setPage] = useState<StylePage>(initialPage);
  const [preview, setPreview] = useState(true);
  const [blendIfChannel, setBlendIfChannel] = useState<keyof Blending['blend_if']>('gray');
  const [styleName, setStyleName] = useState<string | null>(null);
  const session = useRef({ open: false, timer: undefined as ReturnType<typeof setTimeout> | undefined, pending: Promise.resolve() as Promise<unknown>, closed: false });

  useEffect(() => { dialog.current?.showModal(); }, []);

  const send = () => {
    const s = session.current;
    s.open = true;
    const args = [node.id, style, blending, fill, lightChanged ? light : null, true] as const;
    s.pending = s.pending.then(() => adoptPatterns(doc, library, style)).then(() => client.call('setLayerStyle', ...args)).then(onDoc, e => onError((e as Error).message));
  };
  // Every edit reruns the preview 70 ms after the last change.
  useEffect(() => {
    const s = session.current;
    if (s.closed) return;
    clearTimeout(s.timer);
    if (!preview) {
      if (s.open) { s.open = false; s.pending = s.pending.then(() => client.call('previewEnd', false)).then(onDoc, () => {}); }
      return;
    }
    s.timer = setTimeout(send, 70);
    return () => clearTimeout(s.timer);
  }, [style, blending, fill, light, preview]);

  function finish(commit: boolean) {
    const s = session.current;
    if (s.closed) return;
    s.closed = true;
    clearTimeout(s.timer);
    if (commit) {
      const args = [node.id, style, blending, fill, lightChanged ? light : null, true] as const;
      s.pending = s.pending.catch(() => {}).then(() => adoptPatterns(doc, library, style)).then(() => client.call('setLayerStyle', ...args)).then(() => client.call('previewEnd', true));
    } else if (s.open) {
      s.pending = s.pending.catch(() => {}).then(() => client.call('previewEnd', false));
    }
    s.pending.then(d => d && onDoc(d as DocInfo), e => onError((e as Error).message)).finally(onClose);
    dialog.current?.close();
  }

  const editEffect = (kind: EffectKind, index: number, next: Record<string, unknown>) => {
    const list = instances(style, kind).map((e, i) => (i === index ? { ...e, ...next } : e));
    setStyle(withInstances(style, kind, list));
  };
  const ensure = (kind: EffectKind, index: number) => {
    const list = instances(style, kind);
    if (list[index]) return list;
    return [...list, effectDefault(kind, firstPattern)];
  };
  const choose = (kind: EffectKind, index: number) => {
    const list = ensure(kind, index);
    const e = list[index];
    if (!e.present) list[index] = { ...e, present: true, enabled: true };
    setStyle(withInstances(style, kind, [...list]));
    setPage({ kind, index });
  };
  const toggle = (kind: EffectKind, index: number, on: boolean) => {
    const list = ensure(kind, index).map((e, i) => (i === index ? { ...e, present: true, enabled: on } : e));
    setStyle(withInstances(style, kind, list));
  };
  const add = (kind: EffectKind, index: number) => {
    const list = [...instances(style, kind)];
    if (list.length >= MAX_INSTANCES) return;
    list.splice(index + 1, 0, effectDefault(kind, firstPattern));
    setStyle(withInstances(style, kind, list));
    setPage({ kind, index: index + 1 });
  };
  const moveInstance = (kind: EffectKind, index: number, to: number) => {
    const list = [...instances(style, kind)];
    if (to < 0 || to >= list.length) return;
    [list[index], list[to]] = [list[to], list[index]];
    setStyle(withInstances(style, kind, list));
    setPage({ kind, index: to });
  };
  const remove = (kind: EffectKind, index: number) => {
    const list = instances(style, kind).filter((_, i) => i !== index);
    setStyle(withInstances(style, kind, list));
    setPage(list.length ? { kind, index: Math.max(0, index - 1) } : 'blending');
  };

  function renderSpec(spec: Spec, kind: EffectKind, index: number, e: Record<string, unknown>) {
    const set = (path: string, v: unknown) => editEffect(kind, index, setIn(e, path, v));
    if (spec.type === 'number' || spec.type === 'checkbox' || spec.type === 'select') {
      return <Field key={spec.path} spec={spec} params={e} onChange={(p, v) => set(p, v)} />;
    }
    if (spec.type === 'fill') {
      const fc = e.fill as FillContent;
      const change = (type: FillContent['type']) => set('fill', type === 'solid' ? { type, color: [0, 0, 0] }
        : type === 'gradient' ? { type, ...defaultGradientParams() }
        : { type, pattern_id: firstPattern, scale: 1, angle: 0, linked: true, offset: [0, 0] });
      return (
        <div key="fill" className="layer-style-fill">
          <label className="adjustment-field"><span><Trans>Fill Type</Trans></span>
            <select value={fc.type} onChange={ev => change(ev.currentTarget.value as FillContent['type'])}>
              <option value="solid">{t`Color`}</option><option value="gradient">{t`Gradient`}</option>
              <option value="pattern" disabled={!firstPattern}>{t`Pattern`}</option>
            </select>
          </label>
          {(fc.type === 'solid' ? [f('color', t`Color`, 'fill.color')] : fc.type === 'gradient' ? gradientFields('fill.') : patternFields('fill.'))
            .map(s => renderSpec(s, kind, index, e))}
        </div>
      );
    }
    if (spec.type === 'glowFill') {
      const gf = e.fill as { type: 'color' | 'gradient' };
      return (
        <div key="glowFill">
          <label className="adjustment-field"><span>{t({ message: 'Fill', context: 'layer style fill type' })}</span>
            <select value={gf.type} onChange={ev => set('fill', ev.currentTarget.value === 'color'
              ? { type: 'color', color: [255, 255, 190] } : { type: 'gradient', gradient: defaultGradientParams().gradient })}>
              <option value="color">{t`Color`}</option><option value="gradient">{t`Gradient`}</option>
            </select>
          </label>
          {renderSpec(gf.type === 'color' ? f('color', t`Color`, 'fill.color') : f('gradient', t`Gradient`, 'fill.gradient'), kind, index, e)}
        </div>
      );
    }
    const value = getPath(e, spec.path);
    switch (spec.type) {
      case 'blend':
        return (
          <label key={spec.path} className="adjustment-field"><span>{spec.label}</span>
            <select value={String(value)} onChange={ev => set(spec.path, ev.currentTarget.value)}>
              {blendModesFor(doc.depth, String(value)).map(m => <option key={m} value={m}>{choiceLabel(m)}</option>)}
            </select>
          </label>
        );
      case 'color':
        return (
          <label key={spec.path} className="adjustment-field"><span>{spec.label}</span>
            <button type="button" className="gradient-swatch" aria-label={spec.label} style={{ background: rgbToHex(value as Rgb) }}
              onClick={() => pickColor(value as Rgb, spec.label, c => set(spec.path, c))} />
          </label>
        );
      case 'contour':
        return (
          <div key={spec.path} className="adjustment-field"><span>{spec.label}</span>
            <ContourGrid value={value as Contour} set={c => set(spec.path, c)} />
          </div>
        );
      case 'pattern':
        return (
          <div key={spec.path} className="adjustment-field"><span>{spec.label}</span>
            <PatternPicker doc={doc} library={library} value={String(value)} set={id => set(spec.path, id)} onDoc={onDoc} onError={onError} />
          </div>
        );
      case 'gradient': {
        const g = gradientDefToUi(value as Parameters<typeof gradientDefToUi>[0]);
        const lowerLabel = spec.label.toLowerCase();
        return (
          <label key={spec.path} className="adjustment-field"><span>{spec.label}</span>
            <button type="button" className="gradient-ramp-button" aria-label={t`Edit ${lowerLabel}`} title={t`Click to edit the gradient`}
              style={{ backgroundImage: `${rampCss(g, g.interpolation)}, var(--checker)` }}
              onClick={() => openGradientEditor(g, next => set(spec.path, uiToGradientDef(next)))} />
          </label>
        );
      }
      case 'angle': {
        const global = LIGHT_BOUND[kind] && !!e.use_global_light;
        const altitude = spec.path === 'altitude';
        const key = altitude ? 'altitude' : 'angle';
        const shown = global ? light[key] : Number(value);
        const [min, max] = altitude ? [0, 90] : [-180, 180];
        const spec2 = num(`${spec.label} (°)`, spec.path, min, max);
        return (
          <Field key={spec.path} spec={spec2} params={{ [spec.path]: shown }} onChange={(_, v) => {
            if (global) { setLight(l => ({ ...l, [key]: Number(v) })); setLightChanged(true); } else set(spec.path, v);
          }} />
        );
      }
    }
  }

  function renderPage() {
    if (page === 'styles') {
      const saved = styles.list();
      if (!saved.length) return <p className="adjustment-note"><Trans>No saved styles yet.</Trans></p>;
      const use = (id: string) => { const a = styles.apply(id); if (a) { setStyle(a.style); setBlending(a.blending); } };
      return (
        <ul className="style-library-list" aria-label={t`Saved styles`}>
          {saved.map(x => <li key={x.id}><button type="button" className="style-library-name" onClick={() => use(x.id)}>{x.name}</button></li>)}
        </ul>
      );
    }
    if (page === 'blending') {
      const range = blending.blend_if[blendIfChannel];
      const setRange = (k: keyof BlendRange, q: Quad) => setBlending(setIn(blending, `blend_if.${blendIfChannel}.${k}`, q));
      const flag = (label: string, key: keyof Blending) => (
        <label key={key} className="adjustment-check"><input type="checkbox" checked={blending[key] as boolean}
          onChange={ev => setBlending({ ...blending, [key]: ev.currentTarget.checked })} /> {label}</label>
      );
      return (
        <div className="adjustment-body">
          <Field spec={pct(t`Fill Opacity`, 'fill')} params={{ fill }} onChange={(_, v) => setFill(Number(v))} />
          <div className="adjustment-field"><span><Trans>Channels</Trans></span>
            {(['R', 'G', 'B'] as const).map((c, i) => (
              <label key={c} className="adjustment-check"><input type="checkbox" checked={blending.channels[i]}
                onChange={ev => setBlending(setIn(blending, `channels.${i}`, ev.currentTarget.checked))} /> {c}</label>
            ))}
          </div>
          <label className="adjustment-field"><span><Trans>Knockout</Trans></span>
            <select value={blending.knockout} onChange={ev => setBlending({ ...blending, knockout: ev.currentTarget.value as Blending['knockout'] })}>
              <option value="none">{t`None`}</option><option value="shallow">{t`Shallow`}</option><option value="deep">{t`Deep`}</option>
            </select>
          </label>
          {flag(t`Blend Interior Effects as Group`, 'blend_interior')}
          {flag(t`Blend Clipped Layers as Group`, 'blend_clipped')}
          {flag(t`Transparency Shapes Layer`, 'transparency_shapes')}
          {flag(t`Layer Mask Hides Effects`, 'layer_mask_hides_effects')}
          {flag(t`Vector Mask Hides Effects`, 'vector_mask_hides_effects')}
          <label className="adjustment-field"><span><Trans>Blend If</Trans></span>
            <select value={blendIfChannel} onChange={ev => setBlendIfChannel(ev.currentTarget.value as keyof Blending['blend_if'])}>
              <option value="gray">{t`Gray`}</option><option value="red">{t`Red`}</option><option value="green">{t`Green`}</option><option value="blue">{t`Blue`}</option>
            </select>
          </label>
          <BlendIfBar label={t`This Layer`} value={range.source} set={q => setRange('source', q)} />
          <BlendIfBar label={t`Underlying Layer`} value={range.destination} set={q => setRange('destination', q)} />
          <p className="adjustment-note"><Trans>Alt-drag a handle to split it.</Trans></p>
        </div>
      );
    }
    const { kind, index } = page;
    const e = instances(style, kind)[index];
    if (!e) return null;
    return (
      <div className="adjustment-body">
        {pages()[kind].map(s => renderSpec(s, kind, index, e))}
        <div className="layer-style-defaults">
          <button type="button" onClick={() => saveEffectDefault(kind, e)}><Trans>Make Default</Trans></button>
          <button type="button" onClick={() => editEffect(kind, index, { ...effectDefault(kind, firstPattern), present: e.present, enabled: e.enabled })}><Trans>Reset to Default</Trans></button>
        </div>
      </div>
    );
  }

  const isPage = (k: EffectKind, i: number) => typeof page === 'object' && page.kind === k && page.index === i;
  function listRow(kind: EffectKind, index: number, count: number) {
    const e = instances(style, kind)[index];
    const effectName = i18n._(EFFECT_LABEL[kind]);
    const n = index + 1;
    const label = count > 1 ? `${effectName} ${n}` : effectName;
    const sub = kind === 'contour' || kind === 'texture';
    const multi = MULTI.includes(kind);
    return (
      <li key={`${kind}.${index}`} className={`layer-style-row${sub ? ' sub' : ''}${isPage(kind, index) ? ' active' : ''}`}>
        <input type="checkbox" aria-label={t`Enable ${label}`} checked={!!e && e.present && e.enabled} onChange={ev => toggle(kind, index, ev.currentTarget.checked)} />
        <button type="button" className="layer-style-name" onClick={() => choose(kind, index)}>{label}</button>
        {multi && <button type="button" aria-label={t`Add ${effectName}`} title={t`Add ${effectName}`} disabled={count >= MAX_INSTANCES} onClick={() => add(kind, count ? index : -1)}><Plus size={12} /></button>}
        {multi && count > 0 && isPage(kind, index) && (
          <>
            <button type="button" aria-label={t`Move ${label} up`} disabled={index === 0} onClick={() => moveInstance(kind, index, index - 1)}><ArrowUp size={12} /></button>
            <button type="button" aria-label={t`Move ${label} down`} disabled={index === count - 1} onClick={() => moveInstance(kind, index, index + 1)}><ArrowDown size={12} /></button>
            <button type="button" aria-label={t`Delete ${label}`} onClick={() => remove(kind, index)}><Trash2 size={12} /></button>
          </>
        )}
      </li>
    );
  }

  return (
    <dialog ref={dialog} className="layer-style-dialog" aria-label={t`Layer Style`} onCancel={ev => { ev.preventDefault(); finish(false); }}>
      <h2><Trans>Layer Style</Trans></h2>
      <div className="layer-style-grid">
        <ul className="layer-style-list" aria-label={t`Effects`}>
          <li className={`layer-style-row${page === 'styles' ? ' active' : ''}`}><button type="button" className="layer-style-name" onClick={() => setPage('styles')}><Trans>Styles</Trans></button></li>
          <li className={`layer-style-row${page === 'blending' ? ' active' : ''}`}><button type="button" className="layer-style-name" onClick={() => setPage('blending')}><Trans>Blending Options</Trans></button></li>
          {EFFECT_KINDS.flatMap(kind => {
            const count = instances(style, kind).length;
            return MULTI.includes(kind) && count > 0 ? Array.from({ length: count }, (_, i) => listRow(kind, i, count)) : [listRow(kind, 0, count)];
          })}
        </ul>
        <div className="layer-style-page">
          <h3>{page === 'styles' ? t`Styles` : page === 'blending' ? t`Blending Options` : i18n._(EFFECT_LABEL[page.kind])}</h3>
          {renderPage()}
        </div>
        <div className="layer-style-side">
          <button type="button" className="primary" onClick={() => finish(true)}><Trans>OK</Trans></button>
          <button type="button" onClick={() => finish(false)}><Trans>Cancel</Trans></button>
          <label className="adjustment-check"><input type="checkbox" checked={preview} onChange={ev => setPreview(ev.currentTarget.checked)} /> <Trans>Preview</Trans></label>
          <label className="adjustment-check"><input type="checkbox" checked={style.enabled} onChange={ev => setStyle({ ...style, enabled: ev.currentTarget.checked })} /> <Trans>Effects On</Trans></label>
          <button type="button" onClick={() => setStyleName('')}><Trans>New Style…</Trans></button>
          {styleName !== null && (
            <form className="layer-style-new" onSubmit={ev => { ev.preventDefault(); styles.save(styleName, style, blending); setStyleName(null); }}>
              <input autoFocus aria-label={t`Style name`} placeholder={t`Style name`} value={styleName} onChange={ev => setStyleName(ev.currentTarget.value)} />
              <button type="submit"><Trans>Save</Trans></button>
            </form>
          )}
          <Swatch style={style} />
        </div>
      </div>
    </dialog>
  );
}
