import type { Dispatch, FormEvent, RefObject, SetStateAction } from 'react';
import { client } from '../client.ts';
import type { Active } from '../LayersPanel.tsx';
import { BLEND_MODES } from '../layers.ts';
import { AdjustmentBody, filterLabel, type PickLookupFile } from '../PropertiesPanel.tsx';
import { PatternPicker } from '../PresetPanels.tsx';
import { COMMAND_LABEL } from '../adjustments.ts';
import type { BrushLibrary } from '../brushes/store.ts';
import type { EngineAssets } from '../brushes/engineAssets.ts';
import type { ColorPickerHandle } from '../shell/ColorPicker.tsx';
import type { GradientEditorHandle } from '../shell/GradientEditor.tsx';
import { rgbToHex } from '../shell/color.ts';
import { PAINT_MODES } from '../shell/tools.ts';
import { RULER_UNITS, unitToPx, type RulerUnit } from '../shell/units.ts';
import type { Adjustment, DestructiveAdjustment, DocInfo, LayerNode, SmartFilterInfo } from '../worker/types.ts';
import {
  COLOR_RANGE_PRESETS, FILL_CONTENTS, FILL_LAYERS, MODIFY_OPS,
  type FillContentForm, type FillContents, type FillForm, type Run, type Show, type StrokeForm, type TrimBase,
} from './helpers.ts';

type SetState<T> = Dispatch<SetStateAction<T>>;
type DialogRef = RefObject<HTMLDialogElement | null>;
type PreviewRef = RefObject<{ open: boolean; commit: boolean; pending: Promise<unknown> }>;
type BrushLibRef = RefObject<{ library: BrushLibrary; assets: EngineAssets } | null>;
type AdjustForm = Adjustment | DestructiveAdjustment | null;
type FilterBlend = { id: number; fid: number; blend: string; opacity: number };
type ColorRange = { preset: string; fuzziness: number; range: number; localized: boolean; invert: boolean };
type ColorRangeSample = { rgb: [number, number, number]; x: number; y: number };
type ColorRangePreview = { w: number; h: number; data: Uint8Array; level: number };

export function FillDialog({ fillDialog, endPreviewDialog, previewRef, fillForm, setFillForm, picker, brushLib }: {
  fillDialog: DialogRef; endPreviewDialog: () => void; previewRef: PreviewRef; fillForm: FillForm; setFillForm: SetState<FillForm>;
  picker: RefObject<ColorPickerHandle | null>; brushLib: BrushLibRef;
}) {
  return (
    <dialog ref={fillDialog} aria-label="Fill" onClose={endPreviewDialog}>
      <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; fillDialog.current?.close(); }}>
        <h2>Fill</h2>
        <label>Contents <select name="contents" value={fillForm.contents} onChange={e => setFillForm({ ...fillForm, contents: e.currentTarget.value as FillContents })}>
          {Object.entries(FILL_CONTENTS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select></label>
        <label>Custom color <button type="button" className="gradient-swatch" aria-label="Custom fill color" style={{ background: rgbToHex(fillForm.color) }}
          onClick={() => picker.current?.open(fillForm.color, 'Fill Color', c => setFillForm(f => ({ ...f, color: c, contents: 'color' })))} /></label>
        {fillForm.contents === 'pattern' && (
          <label>Pattern <select name="pattern" value={fillForm.pattern || brushLib.current?.library.patterns()[0]?.id} onChange={e => setFillForm({ ...fillForm, pattern: e.currentTarget.value })}>
            {brushLib.current?.library.patterns().map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select></label>
        )}
        <label>Mode <select name="mode" value={fillForm.mode} onChange={e => setFillForm({ ...fillForm, mode: e.currentTarget.value })}>
          {PAINT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select></label>
        <label>Opacity <input name="opacity" type="number" min={0} max={100} value={fillForm.opacity}
          onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillForm({ ...fillForm, opacity: Math.min(100, Math.max(0, v)) }); }} /> %</label>
        <label><input name="preserve" type="checkbox" checked={fillForm.preserve} onChange={e => setFillForm({ ...fillForm, preserve: e.currentTarget.checked })} /> Preserve Transparency</label>
        <div className="actions">
          <button type="button" onClick={() => fillDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function StrokeDialog({ strokeDialog, endPreviewDialog, previewRef, strokeForm, setStrokeForm, picker }: {
  strokeDialog: DialogRef; endPreviewDialog: () => void; previewRef: PreviewRef; strokeForm: StrokeForm; setStrokeForm: SetState<StrokeForm>;
  picker: RefObject<ColorPickerHandle | null>;
}) {
  return (
    <dialog ref={strokeDialog} aria-label="Stroke" onClose={endPreviewDialog}>
      <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; strokeDialog.current?.close(); }}>
        <h2>Stroke</h2>
        <label>Width <input name="width" type="number" min={1} max={250} value={strokeForm.width}
          onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setStrokeForm({ ...strokeForm, width: Math.min(250, Math.max(1, Math.round(v))) }); }} /> px</label>
        <label>Color <button type="button" className="gradient-swatch" aria-label="Stroke color" style={{ background: rgbToHex(strokeForm.color) }}
          onClick={() => picker.current?.open(strokeForm.color, 'Stroke Color', c => setStrokeForm(f => ({ ...f, color: c })))} /></label>
        <fieldset className="stroke-location">
          <legend>Location</legend>
          {(['inside', 'center', 'outside'] as const).map(l => (
            <label key={l}><input type="radio" name="location" value={l} checked={strokeForm.location === l} onChange={() => setStrokeForm({ ...strokeForm, location: l })} /> {l[0].toUpperCase() + l.slice(1)}</label>
          ))}
        </fieldset>
        <label>Mode <select name="mode" value={strokeForm.mode} onChange={e => setStrokeForm({ ...strokeForm, mode: e.currentTarget.value })}>
          {PAINT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
        </select></label>
        <label>Opacity <input name="opacity" type="number" min={0} max={100} value={strokeForm.opacity}
          onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setStrokeForm({ ...strokeForm, opacity: Math.min(100, Math.max(0, v)) }); }} /> %</label>
        <label><input name="preserve" type="checkbox" checked={strokeForm.preserve} onChange={e => setStrokeForm({ ...strokeForm, preserve: e.currentTarget.checked })} /> Preserve Transparency</label>
        <div className="actions">
          <button type="button" onClick={() => strokeDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function AdjustDialog({ adjustDialog, adjustForm, endPreviewDialog, previewRef, adjustSession, setAdjustForm, gradEditor, pickLookupFile, active }: {
  adjustDialog: DialogRef; adjustForm: AdjustForm; endPreviewDialog: () => void; previewRef: PreviewRef; adjustSession: number;
  setAdjustForm: SetState<AdjustForm>; gradEditor: RefObject<GradientEditorHandle | null>; pickLookupFile: PickLookupFile; active: Active | null;
}) {
  return (
    <dialog ref={adjustDialog} aria-label={adjustForm ? COMMAND_LABEL[adjustForm.kind] : 'Adjustment'} onClose={endPreviewDialog}>
      <form onSubmit={e => { e.preventDefault(); previewRef.current.commit = true; adjustDialog.current?.close(); }}>
        <h2>{adjustForm && COMMAND_LABEL[adjustForm.kind]}</h2>
        {adjustForm && (
          <AdjustmentBody key={adjustSession} adjustment={adjustForm} onChange={a => setAdjustForm(a)} openGradientEditor={(g, ok) => gradEditor.current?.open(g, ok)} pickLookupFile={pickLookupFile} histogramId={active?.id ?? 0} />
        )}
        <div className="actions">
          <button type="button" onClick={() => adjustDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function FillContentDialog({ fillContentDialog, submitFillContent, fillContentForm, setFillContentForm, picker, doc, brushLib, show, setError }: {
  fillContentDialog: DialogRef; submitFillContent: () => void; fillContentForm: FillContentForm; setFillContentForm: SetState<FillContentForm>;
  picker: RefObject<ColorPickerHandle | null>; doc: DocInfo | null; brushLib: BrushLibRef; show: Show; setError: SetState<string | null>;
}) {
  return (
    <dialog ref={fillContentDialog}>
      <form onSubmit={e => { e.preventDefault(); submitFillContent(); }}>
        <h2>{FILL_LAYERS[fillContentForm.type].title}</h2>
        {fillContentForm.type === 'solid' && (
          <label>Color <button type="button" className="gradient-swatch" aria-label="Fill color" style={{ background: rgbToHex(fillContentForm.color) }}
            onClick={() => picker.current?.open(fillContentForm.color, 'Fill Color', c => setFillContentForm(f => ({ ...f, color: c })))} /></label>
        )}
        {fillContentForm.type === 'gradient' && (
          <>
            <label>Style <select value={fillContentForm.style} onChange={e => setFillContentForm({ ...fillContentForm, style: e.currentTarget.value as FillContentForm['style'] })}>
              {(['linear', 'radial', 'angle', 'reflected', 'diamond'] as const).map(s => <option key={s} value={s}>{s}</option>)}
            </select></label>
            <label>Angle <input type="number" value={fillContentForm.angle} onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillContentForm({ ...fillContentForm, angle: v }); }} /> °</label>
            <label>Scale <input type="number" min={10} max={150} value={fillContentForm.scalePct} onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillContentForm({ ...fillContentForm, scalePct: Math.min(150, Math.max(10, v)) }); }} /> %</label>
            <label><input type="checkbox" checked={fillContentForm.reverse} onChange={e => setFillContentForm({ ...fillContentForm, reverse: e.currentTarget.checked })} /> Reverse</label>
            <label><input type="checkbox" checked={fillContentForm.dither} onChange={e => setFillContentForm({ ...fillContentForm, dither: e.currentTarget.checked })} /> Dither</label>
            <label><input type="checkbox" checked={fillContentForm.alignWithLayer} onChange={e => setFillContentForm({ ...fillContentForm, alignWithLayer: e.currentTarget.checked })} /> Align with layer</label>
          </>
        )}
        {fillContentForm.type === 'pattern' && (
          <>
            {doc && (
              <PatternPicker doc={doc} library={brushLib.current?.library ?? null} value={fillContentForm.patternId} onDoc={d => show(d)} onError={setError}
                set={id => setFillContentForm(f => ({ ...f, patternId: id }))} />
            )}
            <label>Scale <input type="number" min={1} max={1000} value={fillContentForm.scalePct} onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillContentForm({ ...fillContentForm, scalePct: Math.min(1000, Math.max(1, v)) }); }} /> %</label>
            <label>Angle <input type="number" value={fillContentForm.angle} onChange={e => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) setFillContentForm({ ...fillContentForm, angle: v }); }} /> °</label>
            <label><input type="checkbox" checked={fillContentForm.linked} onChange={e => setFillContentForm({ ...fillContentForm, linked: e.currentTarget.checked })} /> Link with layer</label>
          </>
        )}
        <div className="actions">
          <button type="button" onClick={() => fillContentDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary" disabled={fillContentForm.type === 'pattern' && !fillContentForm.patternId}>OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function NewImageDialog({ newDialog, createNew }: { newDialog: DialogRef; createNew: (e: FormEvent<HTMLFormElement>) => void }) {
  return (
    <dialog ref={newDialog}>
      <form onSubmit={createNew}>
        <h2>New image</h2>
        <label>Width <input name="w" type="number" min={1} max={65536} defaultValue={1920} required /> px</label>
        <label>Height <input name="h" type="number" min={1} max={65536} defaultValue={1080} required /> px</label>
        <label>Bit depth <select name="depth" defaultValue="8"><option value="8">8-bit</option><option value="16">16-bit</option></select></label>
        <label>Background <select name="bg" defaultValue="white"><option value="white">White</option><option value="black">Black</option><option value="transparent">Transparent</option></select></label>
        <div className="actions">
          <button type="button" onClick={() => newDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">Create</button>
        </div>
      </form>
    </dialog>
  );
}

export function FeatherDialog({ featherDialog, run }: { featherDialog: DialogRef; run: Run }) {
  return (
    <dialog ref={featherDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const r = Number(new FormData(e.currentTarget).get('radius'));
        featherDialog.current?.close();
        run(null, () => client.call('selectCommand', 'feather', r));
      }}>
        <h2>Feather Selection</h2>
        <label>Feather radius <input name="radius" type="number" min={0.1} max={1000} step={0.1} defaultValue={1} required /> px</label>
        <div className="actions">
          <button type="button" onClick={() => featherDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function ModifyDialog({ modifyDialog, run, modifyOp }: { modifyDialog: DialogRef; run: Run; modifyOp: keyof typeof MODIFY_OPS }) {
  return (
    <dialog ref={modifyDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        modifyDialog.current?.close();
        run(null, () => client.call('modifySelection', modifyOp, Number(f.get('radius')), f.get('canvasBounds') === 'on'));
      }}>
        <h2>{MODIFY_OPS[modifyOp].label} Selection</h2>
        <label>Radius <input name="radius" type="number" min={MODIFY_OPS[modifyOp].min} max={MODIFY_OPS[modifyOp].max} defaultValue={MODIFY_OPS[modifyOp].default} required /> px</label>
        <label><input name="canvasBounds" type="checkbox" /> Apply effect at canvas bounds</label>
        <div className="actions">
          <button type="button" onClick={() => modifyDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function SaveSelectionDialog({ saveSelDialog, run, doc }: { saveSelDialog: DialogRef; run: Run; doc: DocInfo | null }) {
  return (
    <dialog ref={saveSelDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const channel = f.get('channel');
        saveSelDialog.current?.close();
        run(null, () => client.call('saveSelection', channel ? null : String(f.get('name')), channel ? Number(channel) : null, String(f.get('mode'))));
      }}>
        <h2>Save Selection</h2>
        <label>Channel
          <select name="channel" defaultValue="">
            <option value="">New channel</option>
            {doc?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label>Name <input name="name" type="text" defaultValue={`Selection ${(doc?.channels.length ?? 0) + 1}`} /></label>
        <label>Operation <select name="mode" defaultValue="new">
          <option value="new">Replace</option><option value="add">Add to channel</option>
          <option value="subtract">Subtract from channel</option><option value="intersect">Intersect with channel</option>
        </select></label>
        <div className="actions">
          <button type="button" onClick={() => saveSelDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function LoadSelectionDialog({ loadSelDialog, run, doc }: { loadSelDialog: DialogRef; run: Run; doc: DocInfo | null }) {
  return (
    <dialog ref={loadSelDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        loadSelDialog.current?.close();
        run(null, () => client.call('loadSelection', Number(f.get('channel')), f.get('invert') === 'on', String(f.get('mode'))));
      }}>
        <h2>Load Selection</h2>
        <label>Channel <select name="channel" defaultValue={doc?.channels[0]?.id}>
          {doc?.channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label>
        <label><input name="invert" type="checkbox" /> Invert</label>
        <label>Operation <select name="mode" defaultValue="new">
          <option value="new">New Selection</option><option value="add">Add to Selection</option>
          <option value="subtract">Subtract from Selection</option><option value="intersect">Intersect with Selection</option>
        </select></label>
        <div className="actions">
          <button type="button" onClick={() => loadSelDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function TrimDialog({ trimDialog, run }: { trimDialog: DialogRef; run: Run }) {
  return (
    <dialog ref={trimDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const on = (k: string) => f.get(k) === 'on';
        trimDialog.current?.close();
        run('Trimming…', () => client.call('trim', String(f.get('basedOn')) as TrimBase, on('top'), on('bottom'), on('left'), on('right')));
      }}>
        <h2>Trim</h2>
        <fieldset className="stroke-location trim-group">
          <legend>Based On</legend>
          {([['transparent', 'Transparent Pixels'], ['topLeftPixel', 'Top Left Pixel Color'], ['bottomRightPixel', 'Bottom Right Pixel Color']] as [TrimBase, string][]).map(([v, l]) => (
            <label key={v}><input type="radio" name="basedOn" value={v} defaultChecked={v === 'transparent'} /> {l}</label>
          ))}
        </fieldset>
        <fieldset className="stroke-location">
          <legend>Trim Away</legend>
          {['Top', 'Bottom', 'Left', 'Right'].map(l => (
            <label key={l}><input type="checkbox" name={l.toLowerCase()} defaultChecked /> {l}</label>
          ))}
        </fieldset>
        <div className="actions">
          <button type="button" onClick={() => trimDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function GlobalLightDialog({ globalLightDialog, doc, run }: { globalLightDialog: DialogRef; doc: DocInfo | null; run: Run }) {
  return (
    <dialog ref={globalLightDialog}>
      <form key={doc ? `${doc.globalLight.angle}/${doc.globalLight.altitude}` : ''} onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        globalLightDialog.current?.close();
        run(null, () => client.call('setGlobalLight', { angle: Number(f.get('angle')), altitude: Number(f.get('altitude')) }));
      }}>
        <h2>Global Light</h2>
        <label>Angle <input name="angle" type="number" min={-360} max={360} step="any" defaultValue={doc?.globalLight.angle ?? 120} required /> °</label>
        <label>Altitude <input name="altitude" type="number" min={0} max={90} step="any" defaultValue={doc?.globalLight.altitude ?? 30} required /> °</label>
        <div className="actions">
          <button type="button" onClick={() => globalLightDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function BlurDialog({ blurDialog, node, run }: { blurDialog: DialogRef; node: LayerNode | undefined; run: Run }) {
  return (
    <dialog ref={blurDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const radius = Number(new FormData(e.currentTarget).get('radius'));
        blurDialog.current?.close();
        if (node) run(null, () => client.call('addSmartFilter', node.id, { kind: 'gaussian_blur', params: { radius } }, 'Gaussian Blur'));
      }}>
        <h2>Gaussian Blur</h2>
        <label>Radius <input name="radius" type="number" min={0.1} max={250} step={0.1} defaultValue={2} required /> px</label>
        <div className="actions">
          <button type="button" onClick={() => blurDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function FilterBlendDialog({ filterBlendDialog, setFilterBlend, filterBlend, run, filters }: {
  filterBlendDialog: DialogRef; setFilterBlend: SetState<FilterBlend | null>; filterBlend: FilterBlend | null; run: Run; filters: SmartFilterInfo[];
}) {
  return (
    <dialog ref={filterBlendDialog} onClose={() => setFilterBlend(null)}>
      {filterBlend && (
        <form onSubmit={e => {
          e.preventDefault();
          const f = filterBlend;
          filterBlendDialog.current?.close();
          run(null, () => client.call('setSmartFilter', f.id, f.fid, { blend: f.blend, opacity: f.opacity / 100 }, 'Blending Options'));
        }}>
          <h2>Blending Options</h2>
          <label>Filter <select value={filterBlend.fid} onChange={e => {
            const f = filters.find(x => x.id === Number(e.currentTarget.value));
            if (f) setFilterBlend({ ...filterBlend, fid: f.id, blend: f.blend, opacity: Math.round(f.opacity * 100) });
          }}>
            {[...filters].reverse().map(f => <option key={f.id} value={f.id}>{filterLabel(f.filter)}</option>)}
          </select></label>
          <label>Mode <select value={filterBlend.blend} onChange={e => setFilterBlend({ ...filterBlend, blend: e.currentTarget.value })}>
            {BLEND_MODES.map(m => <option key={m} value={m}>{m}</option>)}
          </select></label>
          <label>Opacity <input type="number" min={0} max={100} step={1} value={filterBlend.opacity}
            onChange={e => { const v = e.currentTarget.valueAsNumber; if (Number.isFinite(v)) setFilterBlend({ ...filterBlend, opacity: Math.min(100, Math.max(0, v)) }); }} /> %</label>
          <div className="actions">
            <button type="button" onClick={() => filterBlendDialog.current?.close()}>Cancel</button>
            <button type="submit" className="primary">OK</button>
          </div>
        </form>
      )}
    </dialog>
  );
}

export function ScaleEffectsDialog({ scaleEffectsDialog, node, run }: { scaleEffectsDialog: DialogRef; node: LayerNode | undefined; run: Run }) {
  return (
    <dialog ref={scaleEffectsDialog}>
      <form key={node?.style ? `${node.id}/${node.style.scale}` : ''} onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        scaleEffectsDialog.current?.close();
        if (node) run(null, () => client.call('scaleEffects', node.id, Number(f.get('scale'))));
      }}>
        <h2>Scale Layer Effects</h2>
        <label>Scale <input name="scale" type="number" min={1} max={1000} step={1} defaultValue={Math.round((node?.style?.scale ?? 1) * 100)} required /> %</label>
        <div className="actions">
          <button type="button" onClick={() => scaleEffectsDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function RotateDialog({ rotateDialog, run }: { rotateDialog: DialogRef; run: Run }) {
  return (
    <dialog ref={rotateDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        rotateDialog.current?.close();
        run('Rotating…', () => client.call('rotateCanvasArbitrary', Number(f.get('angle')), String(f.get('interp')) as 'nearest' | 'bilinear' | 'bicubic'));
      }}>
        <h2>Rotate Canvas</h2>
        <label>Angle <input name="angle" type="number" min={-360} max={360} step="any" defaultValue={0} required /> ° clockwise</label>
        <label>Interpolation <select name="interp" defaultValue="bicubic">
          <option value="nearest">Nearest Neighbor</option><option value="bilinear">Bilinear</option><option value="bicubic">Bicubic</option>
        </select></label>
        <div className="actions">
          <button type="button" onClick={() => rotateDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function ColorRangeDialog({ colorRangeDialog, setColorRangeOpen, active, colorRangeSamples, closeColorRange, run, colorRange, setColorRange, colorRangeCanvas, colorRangePreview, setColorRangeSamples }: {
  colorRangeDialog: DialogRef; setColorRangeOpen: SetState<boolean>; active: Active | null; colorRangeSamples: ColorRangeSample[];
  closeColorRange: () => void; run: Run; colorRange: ColorRange; setColorRange: SetState<ColorRange>; colorRangeCanvas: RefObject<HTMLCanvasElement | null>;
  colorRangePreview: ColorRangePreview | null; setColorRangeSamples: SetState<ColorRangeSample[]>;
}) {
  return (
    <dialog ref={colorRangeDialog} onClose={() => setColorRangeOpen(false)}>
      <form onSubmit={e => {
        e.preventDefault();
        if (!active) return;
        const samplesFlat = colorRangeSamples.flatMap(s => s.rgb);
        const centerFlat = colorRangeSamples.flatMap(s => [s.x, s.y]);
        closeColorRange();
        run(null, () => client.call('colorRange', active.id, false, colorRange.preset, samplesFlat, colorRange.fuzziness, colorRange.range, centerFlat, colorRange.localized, colorRange.invert));
      }}>
        <h2>Color Range</h2>
        <label>Select <select value={colorRange.preset} onChange={e => setColorRange({ ...colorRange, preset: e.target.value })}>
          {COLOR_RANGE_PRESETS.map(p => <option key={p} value={p}>{p}</option>)}
        </select></label>
        <canvas
          ref={colorRangeCanvas} className="color-range-preview"
          onClick={e => {
            if (!colorRangePreview) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const cx = Math.round((e.clientX - rect.left) * (colorRangePreview.w / rect.width));
            const cy = Math.round((e.clientY - rect.top) * (colorRangePreview.h / rect.height));
            const x = cx * (1 << colorRangePreview.level), y = cy * (1 << colorRangePreview.level);
            if (e.altKey) {
              setColorRangeSamples(s => {
                if (!s.length) return s;
                let best = 0, bestD = Infinity;
                s.forEach((p, i) => { const d = Math.hypot(p.x - x, p.y - y); if (d < bestD) { bestD = d; best = i; } });
                return s.filter((_, i) => i !== best);
              });
              return;
            }
            client.call('sample', x, y, 1, null).then(([r, g, b]) => {
              setColorRangeSamples(s => (e.shiftKey ? [...s, { rgb: [r, g, b], x, y }] : [{ rgb: [r, g, b], x, y }]));
            });
          }}
        />
        <label>Fuzziness <input type="range" min={0} max={200} value={colorRange.fuzziness} onChange={e => setColorRange({ ...colorRange, fuzziness: Number(e.target.value) })} /> {colorRange.fuzziness}</label>
        <label>Range <input type="range" min={0} max={100} value={colorRange.range} onChange={e => setColorRange({ ...colorRange, range: Number(e.target.value) })} /> {colorRange.range}%</label>
        <label><input type="checkbox" checked={colorRange.localized} onChange={e => setColorRange({ ...colorRange, localized: e.target.checked })} /> Localized color clusters</label>
        <label><input type="checkbox" checked={colorRange.invert} onChange={e => setColorRange({ ...colorRange, invert: e.target.checked })} /> Invert</label>
        <div className="actions">
          <button type="button" onClick={closeColorRange}>Cancel</button>
          <button type="submit" className="primary" disabled={colorRange.preset === 'sampled' && !colorRangeSamples.length}>OK</button>
        </div>
      </form>
    </dialog>
  );
}

// docs/M4.md section 12: position is relative to the canvas (artboard targeting is B18, not landed yet).
export function NewGuideDialog({ newGuideDialog, run, doc, rulerUnit }: { newGuideDialog: DialogRef; run: Run; doc: DocInfo | null; rulerUnit: RulerUnit }) {
  return (
    <dialog ref={newGuideDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        if (!doc) return;
        const f = new FormData(e.currentTarget);
        const orientation = String(f.get('orientation'));
        const unit = String(f.get('unit')) as RulerUnit;
        const value = Number(f.get('position'));
        const docSize = orientation === 'horizontal' ? doc.height : doc.width;
        newGuideDialog.current?.close();
        run(null, () => client.call('addGuide', orientation === 'horizontal' ? 'y' : 'x', unitToPx(value, unit, doc.resolution, docSize), 0));
      }}>
        <h2>New Guide</h2>
        <fieldset className="stroke-location">
          <legend>Orientation</legend>
          <label><input type="radio" name="orientation" value="horizontal" defaultChecked /> Horizontal</label>
          <label><input type="radio" name="orientation" value="vertical" /> Vertical</label>
        </fieldset>
        <label>Position <input name="position" type="number" step="any" defaultValue={0} required />
          <select name="unit" defaultValue={rulerUnit}>{RULER_UNITS.map(u => <option key={u} value={u}>{u}</option>)}</select>
        </label>
        <div className="actions">
          <button type="button" onClick={() => newGuideDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}

export function NewGuideLayoutDialog({ newGuideLayoutDialog, run, doc }: { newGuideLayoutDialog: DialogRef; run: Run; doc: DocInfo | null }) {
  return (
    <dialog ref={newGuideLayoutDialog}>
      <form onSubmit={e => {
        e.preventDefault();
        if (!doc) return;
        const f = new FormData(e.currentTarget);
        const on = (k: string) => f.get(k) === 'on';
        const num = (k: string) => Number(f.get(k));
        const margins = on('margins') ? [num('top'), num('left'), num('bottom'), num('right')] as [number, number, number, number] : null;
        newGuideLayoutDialog.current?.close();
        run(null, () => client.call('newGuideLayout', {
          rect: [0, 0, doc.width, doc.height], columns: num('columns'), columnGutter: num('columnGutter'),
          rows: num('rows'), rowGutter: num('rowGutter'), margins, clearExisting: on('clearExisting'), artboard: 0,
        }));
      }}>
        <h2>New Guide Layout</h2>
        <label>Columns <input name="columns" type="number" min={0} max={100} defaultValue={3} required /></label>
        <label>Column Gutter <input name="columnGutter" type="number" min={0} max={500} defaultValue={20} required /> px</label>
        <label>Rows <input name="rows" type="number" min={0} max={100} defaultValue={0} required /></label>
        <label>Row Gutter <input name="rowGutter" type="number" min={0} max={500} defaultValue={20} required /> px</label>
        <fieldset className="stroke-location trim-group">
          <legend>Margins</legend>
          <label><input name="margins" type="checkbox" /> Use margins</label>
          <label>Top <input name="top" type="number" min={0} max={2000} defaultValue={0} /></label>
          <label>Left <input name="left" type="number" min={0} max={2000} defaultValue={0} /></label>
          <label>Bottom <input name="bottom" type="number" min={0} max={2000} defaultValue={0} /></label>
          <label>Right <input name="right" type="number" min={0} max={2000} defaultValue={0} /></label>
        </fieldset>
        <label><input name="clearExisting" type="checkbox" defaultChecked /> Clear existing guides</label>
        <div className="actions">
          <button type="button" onClick={() => newGuideLayoutDialog.current?.close()}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </dialog>
  );
}
