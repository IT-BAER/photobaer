// Window > Adjustments (docs/M3.md section 3): one button per adjustment kind in rows of 5, 6 and 5
// (catalogue order), then a fill layer row.
import {
  Aperture, Blend, Blinds, Camera, ChartColumn, ChartSpline, Contrast, Grid3x3, Layers2, PaintBucket, Palette, Rainbow, Scale,
  SlidersHorizontal, Sparkles, SquareSplitHorizontal, SunMedium, Table2, Target, type LucideIcon,
} from 'lucide-react';
import { ADJUSTMENT_KINDS, MENU_LABEL, type Kind } from './adjustments.ts';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { i18n } from './i18n/index.ts';

const ICONS: Record<Kind, LucideIcon> = {
  brightness_contrast: SunMedium, levels: ChartColumn, curves: ChartSpline, exposure: Aperture, vibrance: Sparkles,
  hue_saturation: Palette, color_balance: Scale, black_white: Contrast, photo_filter: Camera, channel_mixer: SlidersHorizontal,
  color_lookup: Table2, invert: SquareSplitHorizontal, posterize: Layers2, threshold: Blinds, gradient_map: Rainbow, selective_color: Target,
};
const ROWS = [ADJUSTMENT_KINDS.slice(0, 5), ADJUSTMENT_KINDS.slice(5, 11), ADJUSTMENT_KINDS.slice(11)];
const ICON = { size: 16, strokeWidth: 1.75 };

export function AdjustmentsPanel({ create, fill, patternOff }: {
  create: (kind: Kind) => void; fill: (type: 'solid' | 'gradient' | 'pattern') => void; patternOff: boolean;
}) {
  return (
    <div className="adjustments-panel">
      <div className="panel-tabs"><span className="panel-tab"><Trans>Adjustments</Trans></span></div>
      {ROWS.map((row, i) => (
        <div key={i} className="adjustments-row">
          {row.map(kind => {
            const Icon = ICONS[kind];
            return <button key={kind} type="button" aria-label={i18n._(MENU_LABEL[kind])} title={i18n._(MENU_LABEL[kind])} onClick={() => create(kind)}><Icon {...ICON} /></button>;
          })}
        </div>
      ))}
      <div className="adjustments-row">
        <button type="button" aria-label={t`Solid Color`} title={t`Solid Color`} onClick={() => fill('solid')}><PaintBucket {...ICON} /></button>
        <button type="button" aria-label={t`Gradient`} title={t`Gradient`} onClick={() => fill('gradient')}><Blend {...ICON} /></button>
        <button type="button" aria-label={t`Pattern`} title={t`Pattern`} disabled={patternOff} onClick={() => fill('pattern')}><Grid3x3 {...ICON} /></button>
      </div>
    </div>
  );
}
