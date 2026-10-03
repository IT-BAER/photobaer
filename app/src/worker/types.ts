import type { ActionStep } from '../actions.ts';
import type { ViewState } from '../app/proof.ts';
import type { Blending, LayerStyle } from '../layerStyle.ts';
import type { Live, ShapeStroke } from '../shell/shapetools.ts';
import type { TextJson } from '../psd/text.ts';
import type { ParamValue } from '../filters/lastFilter.ts';

export type AlignMode = `${'align' | 'distribute'}-${'top' | 'vcenter' | 'bottom' | 'left' | 'hcenter' | 'right'}`;

// A fill layer's content (docs/M3.md section 4); field names match the engine JSON verbatim.
export interface GradientDef {
  method: 'classic' | 'linear' | 'perceptual';
  color_stops: { position: number; color: [number, number, number]; midpoint: number }[];
  opacity_stops: { position: number; opacity: number; midpoint: number }[];
}
export type FillContent =
  | { type: 'solid'; color: [number, number, number] }
  | {
      type: 'gradient'; gradient: GradientDef; style: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
      angle: number; scale: number; reverse: boolean; dither: boolean; align_with_layer: boolean; offset: [number, number];
    }
  | { type: 'pattern'; pattern_id: string; scale: number; angle: number; linked: boolean; offset: [number, number] };

// The 16 adjustment layer kinds (docs/M3.md section 3); field names match the engine JSON verbatim.
export interface LevelsRecord { input_black: number; input_white: number; gamma: number; output_black: number; output_white: number }
export interface Hsl { hue: number; saturation: number; lightness: number }
export interface HueRange { bands: [number, number, number, number]; hue: number; saturation: number; lightness: number }
type Quad = [number, number, number, number];
export type Adjustment =
  | { kind: 'brightness_contrast'; params: { brightness: number; contrast: number; legacy: boolean } }
  | { kind: 'levels'; params: { composite: LevelsRecord; red?: LevelsRecord | null; green?: LevelsRecord | null; blue?: LevelsRecord | null } }
  | { kind: 'curves'; params: { mode: 'point' | 'pencil'; composite: [number, number][]; red?: [number, number][] | null; green?: [number, number][] | null; blue?: [number, number][] | null } }
  | { kind: 'exposure'; params: { exposure: number; offset: number; gamma: number } }
  | { kind: 'vibrance'; params: { vibrance: number; saturation: number } }
  | { kind: 'hue_saturation'; params: { master: Hsl; ranges: [HueRange, HueRange, HueRange, HueRange, HueRange, HueRange]; colorize: boolean; colorize_values: Hsl } }
  | { kind: 'color_balance'; params: { shadows: [number, number, number]; midtones: [number, number, number]; highlights: [number, number, number]; preserve_luminosity: boolean } }
  | { kind: 'black_white'; params: { reds: number; yellows: number; greens: number; cyans: number; blues: number; magentas: number; tint: boolean; tint_color: [number, number, number] } }
  | { kind: 'photo_filter'; params: { color: [number, number, number]; density: number; preserve_luminosity: boolean } }
  | { kind: 'channel_mixer'; params: { red: Quad; green: Quad; blue: Quad; gray: Quad; monochrome: boolean } }
  | { kind: 'color_lookup'; params: { name: string; format: 'cube' | '3dl'; table: number | null; interpolation: 'tetrahedral' | 'trilinear'; dither: boolean } }
  | { kind: 'invert'; params: Record<string, never> }
  | { kind: 'posterize'; params: { levels: number } }
  | { kind: 'threshold'; params: { level: number } }
  | { kind: 'gradient_map'; params: { gradient: GradientDef; reverse: boolean; dither: boolean } }
  | { kind: 'selective_color'; params: { mode: 'relative' | 'absolute'; reds: Quad; yellows: Quad; greens: Quad; cyans: Quad; blues: Quad; magentas: Quad; whites: Quad; neutrals: Quad; blacks: Quad } };

// The destructive-only kinds (docs/M3.md section 3, 17-25): Image menu commands, never layers.
type ToneRange = { amount: number; tone: number; radius: number };
export type DestructiveAdjustment =
  | { kind: 'shadows_highlights'; params: { shadows: ToneRange; highlights: ToneRange; color_correction: number; midtone_contrast: number; black_clip: number; white_clip: number } }
  | { kind: 'hdr_toning'; params: { method: 'local_adaptation' | 'exposure_gamma' | 'highlight_compression' | 'equalize_histogram'; radius: number; strength: number; detail: number; shadow: number; highlight: number; exposure: number; gamma: number; vibrance: number; saturation: number } }
  | { kind: 'desaturate'; params: Record<string, never> }
  | { kind: 'match_color'; params: { luminance: number; color_intensity: number; fade: number; neutralize: boolean } }
  | { kind: 'replace_color'; params: { target_color: [number, number, number]; fuzziness: number; range: number; localized: boolean; hue: number; saturation: number; lightness: number } }
  | { kind: 'equalize' | 'auto_tone' | 'auto_contrast' | 'auto_color'; params: Record<string, never> };

export type SmartLink = { type: 'embedded'; id: string } | { type: 'linked'; name: string; handle: string };
// Engine warp mesh JSON: document-px control points over the source rect.
export interface SmartWarp { cols: number; rows: number; points: [number, number][]; column_stops: number[]; row_stops: number[] }
// A registry filter (docs/M5.md section 1); the M3 adjustment kinds keep their typed params.
export interface RegistryFilter { kind: string; params: Record<string, ParamValue> }
export type SmartFilterKind = Adjustment | RegistryFilter;
// One Liquify dialog edit (docs/M5.md section 6); points and sizes in document px.
export interface LiquifyBrush { tool: string; size: number; density: number; pressure: number; rate: number; mode: string }
export type LiquifyOp =
  | { op: 'begin'; brush: LiquifyBrush; x: number; y: number } | { op: 'to'; x: number; y: number } | { op: 'hold' } | { op: 'end' }
  | { op: 'mask'; source: 'selection' | 'transparency' | null; mode: string } | { op: 'reconstruct'; amount: number } | { op: 'restore' }
  | { op: 'spacing'; spacing: number } | { op: 'pin'; on: boolean };
// Vanishing Point (docs/M5.md section 7): plane corners in document px, dabs in plane UV.
export interface VanishingPlane { id: string; corners: [number, number][]; parentId?: string; hingeEdge?: 'top' | 'right' | 'bottom' | 'left'; angleDegrees?: number }
export interface VanishingDab { planeId?: string; from: [number, number]; to: [number, number]; radius: number; opacity: number; hardness: number }
export interface VanishingState { planes: VanishingPlane[]; stamps: VanishingDab[]; gridSize: number; brushHardness: number; brushOpacity: number }
export interface SmartFilterInfo {
  id: number; filter: SmartFilterKind; enabled: boolean; opacity: number; blend: string; mask: { enabled: boolean; default: number } | null;
}
export interface SmartInfo {
  link: SmartLink; source: { blob: number | null }; source_size: [number, number]; transform: number[];
  warp: SmartWarp | null; filters: SmartFilterInfo[]; stack_mask: { enabled: boolean; default: number } | null; stack_mode: string | null;
}
// A shape/vector-mask anchor point `[x, y, inX, inY, outX, outY]` (engine/src/path.rs `Point`;
// docs/M4.md section 12: only the coordinates snapTargets needs, not the full path model).
export type PathAnchor = [number, number, number, number, number, number];
export interface VectorPath { fill_rule: 'nonzero' | 'evenodd'; subpaths: { closed: boolean; op: string; points: PathAnchor[] }[] }

export interface LayerNode {
  id: number; name: string; kind: 'pixel' | 'group' | 'adjustment' | 'fill' | 'smart' | 'shape' | 'text';
  visible: boolean; opacity: number; fill: number; blend: string; clipping: boolean;
  locks: { transparency: boolean; pixels: boolean; position: boolean };
  mask: { enabled: boolean; default: number } | null;
  content?: FillContent;
  adjustment?: Adjustment;
  smart?: SmartInfo;
  shape?: { path: VectorPath; live: Live | null; fill: FillContent | null; stroke: ShapeStroke | null };
  vector_mask?: VectorMaskInfo | null;
  // Type layer model (engine/src/text.rs TextData).
  text?: TextJson;
  // `rect` is `[left, top, right, bottom]` (engine/src/path.rs `Artboard`); present on a `group`
  // layer promoted to an artboard.
  artboard?: { rect: [number, number, number, number]; background: ArtboardBackground; preset_name: string; guide_ids: number[] } | null;
  style: LayerStyle | null;
  blending: Blending;
  children?: LayerNode[];
}
export interface VectorMaskInfo { path: VectorPath; enabled: boolean; linked: boolean; inverted: boolean; density: number; feather: number }
export type BoolOp = 'unite' | 'subtract' | 'intersect' | 'exclude';
// docs/M4.md section 12: a document-space vertical (x) or horizontal (y) guide.
export interface Guide { id: number; axis: 'x' | 'y'; pos: number }
export type ArtboardBackground = { type: 'none' | 'white' | 'black' | 'transparent' } | { type: 'color'; color: [number, number, number] };
export interface SavedPathInfo { id: number; name: string; work: boolean; path: VectorPath }
// A path-edit target: a shape layer's path, a layer's vector mask path, or a saved path.
export type PathRole = 'shape' | 'vectorMask' | 'document';
type Rgb3 = [number, number, number];
// Image > Mode beyond RGB and Grayscale (null): Bitmap and Duotone also keep `gray`.
export type ColorMode = { kind: 'bitmap' } | { kind: 'duotone'; inks: Rgb3[] } | { kind: 'indexed'; table: Rgb3[] } | { kind: 'cmyk' } | { kind: 'lab' } | { kind: 'multichannel' };
export type ModeSpec =
  | { mode: 'rgb' | 'gray' | 'cmyk' | 'lab' | 'multichannel' }
  | { mode: 'bitmap'; method: 'threshold' | 'pattern' | 'diffusion' }
  | { mode: 'duotone'; inks: Rgb3[] }
  | {
    mode: 'indexed'; palette: 'exact' | 'uniform' | 'web' | 'adaptive'; colors: number; forced: 'none' | 'black_white' | 'primaries' | 'web';
    transparency: boolean; dither: 'none' | 'diffusion' | 'pattern' | 'noise'; amount: number;
  };
// A spot channel's ink: display color and on-screen solidity 0..1.
export interface Spot { color: [number, number, number]; solidity: number }

export interface DocInfo {
  docId: number; version: number; name: string;
  width: number; height: number; depth: number; maxLevel: number; gray: boolean; mode: ColorMode | null;
  profile: { name: string; builtin: boolean } | null;
  // View > Proof Setup, Proof Colors, Gamut Warning, 32-bit Preview Options (display only).
  view: ViewState;
  undoLabel: string | null; redoLabel: string | null;
  layers: LayerNode[];
  history: { labels: string[]; current: number };
  selection: { bounds: [number, number, number, number] | null; default: number } | null;
  hasLastSelection: boolean;
  selGen: number;
  channels: { id: number; name: string; spot: Spot | null }[];
  patterns: { id: string; name: string }[];
  layerComps: { id: number; name: string; layerCount: number }[];
  globalLight: GlobalLight;
  // Edit Contents (D6): the names of the documents this one is nested in, outermost first.
  parents: string[];
  // Document tabs: the active document's stable key and every open document in tab order.
  key: string;
  // Unsaved changes since the last project or PSD save (also for undo past it); per tab in `docs`.
  dirty: boolean;
  docs: { key: string; name: string; active: boolean; dirty: boolean; mode: string; depth: number; width: number; height: number }[];
  // Pixels per inch (docs/M4.md D13, section 12).
  resolution: number;
  guides: Guide[];
  // Saved paths and the work path (docs/M4.md section 4), in document order.
  paths: SavedPathInfo[];
  grid: { spacing_x: number; spacing_y: number };
  guidesLocked: boolean;
  artboardsLocked: boolean;
}
export interface GlobalLight { angle: number; altitude: number }
export type SelectShape = { kind: 'rect' | 'ellipse' | 'polygon'; x?: number; y?: number; w?: number; h?: number; points?: number[] };
export type OpenResult = DocInfo & { warnings: string[] };
export type AutosaveState = 'off' | 'other-tab' | 'idle' | 'saving' | 'saved' | 'error';
export type WorkerEvent = { event: 'autosave'; state: AutosaveState; detail?: string } | { event: 'transformCancelled'; doc: DocInfo | null }
  | { event: 'typeCommitted'; doc: DocInfo } | { event: 'actionStep'; step: ActionStep };
export interface StrokeParams {
  rgba: [number, number, number, number]; mode: string; size: number;
  opacity?: number; flow?: number; hardness?: number; spacing?: number; angle?: number; roundness?: number;
  tip?: 'round' | 'square'; aliased?: boolean; wetEdges?: boolean; airbrush?: boolean;
  pressureSize?: boolean; pressureOpacity?: boolean;
  stride?: 3 | 6; seed?: number;
  // UI-level flag; strokeBegin resolves it to an actual snapshot id (or omits it) before it reaches the engine.
  eraseToHistory?: boolean;
  historySource?: boolean;
}

type Rgba = [number, number, number, number];
// Engine fill_ex / stroke_selection / gradient params (opacity 0..1); patternId is a worker asset id.
export interface FillParams {
  source: 'solid' | 'pattern' | 'history'; rgba?: Rgba; patternId?: number;
  mode: string; opacity: number; preserveTransparency: boolean;
}
export interface ContentAwareOpts { mode: string; opacity: number; preserveTransparency: boolean }
export interface StrokeSelectionParams {
  width: number; rgba: Rgba; location: 'inside' | 'center' | 'outside'; mode: string; opacity: number; preserveTransparency: boolean;
}
export interface GradientParams {
  stops: { position: number; rgb: [number, number, number]; midpoint: number }[];
  opacityStops: { position: number; opacity: number; midpoint: number }[];
  method: 'perceptual' | 'linear' | 'classic'; style: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
  start: { x: number; y: number }; end: { x: number; y: number };
  reverse: boolean; dither: boolean; transparency: boolean; opacity: number;
}
export type TransformKind = 'layer' | 'pixels' | 'selection';
export type TransformOp = number[] | string;
export type Box = [number, number, number, number];
// A registered font face (engine font registry); `source` says where its bytes came from.
export interface FaceInfo { id: number; family: string; style: string; weight: number; italic: boolean; postscript: string; source: 'bundled' | 'local' | 'upload'; color: boolean }

export interface IccProfile { name: string; space: 'rgb' | 'gray' | 'cmyk'; loaded?: boolean }
