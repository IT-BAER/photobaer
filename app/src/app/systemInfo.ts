import { t } from '@lingui/core/macro';
import { i18n } from '../i18n/index.ts';
import { formatNumber } from '../i18n/numbers.ts';

declare const __APP_VERSION__: string;

type Gpu = { requestAdapter(): Promise<{ info?: Record<string, string>; limits: Record<string, number> } | null> };
type Env = {
  navigator: Navigator & { gpu?: Gpu; deviceMemory?: number; userAgentData?: { brands: { brand: string; version: string }[]; platform: string } };
  performance?: { memory?: { jsHeapSizeLimit: number } };
  screen?: { width: number; height: number };
  devicePixelRatio?: number; crossOriginIsolated?: boolean;
  OffscreenCanvas?: new (w: number, h: number) => { getContext(kind: 'webgl2'): WebGL2RenderingContext | null };
} & Record<string, unknown>;

const yesNo = (v: boolean) => (v ? t`yes` : t`no`);
const bytes = (n: number) => new Intl.NumberFormat(i18n.locale, { style: 'unit', unit: n >= 2 ** 30 ? 'gigabyte' : 'megabyte', maximumFractionDigits: 1 })
  .format(n >= 2 ** 30 ? n / 2 ** 30 : n / 2 ** 20);

async function gpuLines(env: Env): Promise<string[]> {
  const adapter = await env.navigator.gpu?.requestAdapter().catch(() => null);
  if (!adapter) return [t`WebGPU adapter: not available`];
  const info = adapter.info ?? {};
  const name = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ') || '?';
  const l = adapter.limits;
  return [t`WebGPU adapter: ${name}`, t`WebGPU max texture size: ${l.maxTextureDimension2D} px`, t`WebGPU max buffer size: ${bytes(l.maxBufferSize)}`];
}

function webglLine(env: Env): string {
  try {
    const gl = env.OffscreenCanvas ? new env.OffscreenCanvas(1, 1).getContext('webgl2') : null;
    if (!gl) return t`WebGL2: not available`;
    // The unmasked name where the browser allows it; RENDERER alone is often just "WebKit WebGL".
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return t`WebGL2 renderer: ${renderer}`;
  } catch {
    return t`WebGL2: not available`;
  }
}

// Help > System Info: what photobaer runs on, one fact per line.
export async function systemInfo(renderer: string, env: Env = globalThis as unknown as Env): Promise<string[]> {
  const nav = env.navigator;
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  const browser = nav.userAgentData?.brands.filter(b => !/not.a.brand/i.test(b.brand)).map(b => `${b.brand} ${b.version}`).join(', ') || nav.userAgent;
  const platform = nav.userAgentData?.platform || nav.platform || '?';
  const storage = await nav.storage?.estimate?.().catch(() => null);
  const persisted = await nav.storage?.persisted?.().catch(() => false);
  const lines = [
    `photobaer ${version}`,
    t`Browser: ${browser}`,
    t`Platform: ${platform}`,
    t`User agent: ${nav.userAgent}`,
    t`Language: ${nav.language}; interface: ${i18n.locale}`,
    t`Logical processors: ${nav.hardwareConcurrency ?? '?'}`,
    ...(nav.deviceMemory ? [t`Device memory: at least ${bytes(nav.deviceMemory * 2 ** 30)}`] : []),
    ...(env.performance?.memory ? [t`JavaScript heap limit: ${bytes(env.performance.memory.jsHeapSizeLimit)}`] : []),
    ...(env.screen ? [t`Screen: ${env.screen.width} × ${env.screen.height} px, pixel ratio ${formatNumber(env.devicePixelRatio ?? 1)}`] : []),
    t`Canvas renderer: ${renderer || '?'}`,
    ...await gpuLines(env),
    webglLine(env),
    t`Cross-origin isolated: ${yesNo(!!env.crossOriginIsolated)}`,
    t`SharedArrayBuffer: ${yesNo(typeof env.SharedArrayBuffer === 'function')}`,
    ...(storage ? [t`Storage used: ${bytes(storage.usage ?? 0)} of ${bytes(storage.quota ?? 0)}; persistent: ${yesNo(!!persisted)}`] : []),
    t`Origin private file system: ${yesNo(typeof nav.storage?.getDirectory === 'function')}`,
    t`File System Access: ${yesNo(typeof env.showOpenFilePicker === 'function')}`,
    t`Local Font Access: ${yesNo(typeof env.queryLocalFonts === 'function')}`,
  ];
  return lines;
}
