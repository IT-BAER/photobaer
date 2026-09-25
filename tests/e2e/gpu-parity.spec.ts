import { test, expect } from '@playwright/test';
import { writePsdUint8Array, type Layer } from 'ag-psd';

// A 600x300 scene: level 0 is 3x2 tiles (the right and bottom ones are edge tiles) and level 2 is
// a single 150x75 tile. It covers every blend mode, dissolve, tile and constant masks, nested
// groups, a pass-through group with fill < 1 and a mask, and clipping groups with a pixel, group,
// pass-through and hidden base.
const W = 600, H = 300;

const MODES = [
  'normal', 'dissolve', 'darken', 'multiply', 'color burn', 'linear burn', 'darker color',
  'lighten', 'screen', 'color dodge', 'linear dodge', 'lighter color', 'overlay', 'soft light',
  'hard light', 'vivid light', 'linear light', 'pin light', 'hard mix', 'difference', 'exclusion',
  'subtract', 'divide', 'hue', 'saturation', 'color', 'luminosity',
] as const;

function image(w: number, h: number, f: (x: number, y: number) => number[]) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  }
  return { width: w, height: h, data };
}

const ALPHAS = [0, 60, 120, 180, 240];
const pattern = (seed: number) => image(W, H, (x, y) => [
  (x * 3 + seed * 17) & 255,
  (y * 5 + seed * 29) & 255,
  (x ^ y ^ seed) & 255,
  ALPHAS[((x / 7 | 0) + (y / 5 | 0) + seed) % 5],
]);

// A mask over the left half only, so the tiles it does not cover use the constant default.
const maskOf = (seed: number): Layer['mask'] => ({
  top: 0, left: 0, right: W / 2, bottom: H / 2, defaultColor: 255,
  imageData: image(W / 2, H / 2, (x, y) => {
    const v = (x * 2 + y * 3 + seed * 11) & 255;
    return [v, v, v, 255];
  }),
});

const px = (name: string, seed: number, extra: Partial<Layer> = {}): Layer =>
  ({ name, imageData: pattern(seed), ...extra });

function sceneBytes() {
  const children: Layer[] = [px('bg', 1)];
  MODES.forEach((blendMode, i) => children.push(px(blendMode, i + 2, { blendMode, opacity: 0.7, fillOpacity: 0.9 })));
  children.push({
    name: 'isolated group', blendMode: 'multiply', opacity: 0.8, fillOpacity: 0.6, mask: maskOf(7),
    children: [px('ga', 40), px('gb', 41, { blendMode: 'screen' })],
  });
  children.push({
    name: 'pass group', blendMode: 'pass through', opacity: 0.8, fillOpacity: 0.5, mask: maskOf(8),
    children: [px('n1', 42), { name: 'inner', blendMode: 'normal', opacity: 0.9, children: [px('n2', 43)] }],
  });
  children.push(px('pixel base', 50, { blendMode: 'overlay', opacity: 0.9, fillOpacity: 0.8, mask: maskOf(9) }));
  children.push(px('clip1', 51, { clipping: true, blendMode: 'multiply', opacity: 0.8, fillOpacity: 0.7 }));
  children.push(px('clip2', 52, { clipping: true, mask: maskOf(10) }));
  children.push({
    name: 'group base', blendMode: 'hard light', opacity: 0.9, fillOpacity: 0.7, mask: maskOf(11),
    children: [px('gb1', 53), px('gb2', 54)],
  });
  children.push(px('group clip', 55, { clipping: true, blendMode: 'color dodge' }));
  children.push({
    name: 'pass base', blendMode: 'pass through', opacity: 0.8, fillOpacity: 0.6, mask: maskOf(12),
    children: [px('pt1', 56)],
  });
  children.push(px('pass clip', 57, { clipping: true, blendMode: 'difference', opacity: 0.9 }));
  children.push(px('hidden base', 58, { hidden: true }));
  children.push(px('hidden clip', 59, { clipping: true }));
  return Buffer.from(writePsdUint8Array({ width: W, height: H, children }));
}

interface Parity { renderer: string; gpu: string | null; cpu: string | null }

test('WebGPU display tiles match the CPU compositor at levels 0 and 2', async ({ page, browserName }, info) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto('/?gputest=1');
  await expect(page.getByText('Autosave on')).toBeVisible();
  const used = (await page.getByText(/^(WebGPU|WebGL2)$/).textContent())!;
  info.annotations.push({ type: 'renderer', description: `${browserName}: ${used}` });
  const headed = info.project.use.headless === false;
  if (used !== 'WebGPU') {
    const why = `${browserName} reports no WebGPU adapter (renderer is ${used})`;
    if (headed) throw new Error(`${why} even headed: the GPU compositor cannot be verified here`);
    test.skip(true, `${why}; rerun with --headed`);
  }

  await page.locator('input[type=file]').setInputFiles({
    name: 'parity.psd', mimeType: 'image/vnd.adobe.photoshop', buffer: sceneBytes(),
  });
  await expect(page.getByText(`${W} × ${H} px, 8-bit`)).toBeVisible({ timeout: 60_000 });

  for (const [level, ntx, nty] of [[0, 3, 2], [2, 1, 1]]) {
    let worst = 0;
    for (let ty = 0; ty < nty; ty++) {
      for (let tx = 0; tx < ntx; tx++) {
        const r = await page.evaluate(
          ([l, x, y]) => (window as unknown as { photobaer: { gpuParity(l: number, x: number, y: number): Promise<Parity> } })
            .photobaer.gpuParity(l, x, y),
          [level, tx, ty],
        ) as Parity;
        const where = `${browserName} level ${level} tile (${tx}, ${ty})`;
        expect(r.gpu, `${where}: no GPU tile`).not.toBeNull();
        expect(r.cpu, `${where}: no CPU tile`).not.toBeNull();
        const gpu = Buffer.from(r.gpu!, 'base64');
        const cpu = Buffer.from(r.cpu!, 'base64');
        expect(gpu.length, where).toBe(cpu.length);
        let max = 0, at = -1;
        for (let i = 0; i < cpu.length; i++) {
          const d = Math.abs(gpu[i] - cpu[i]);
          if (d > max) { max = d; at = i; }
        }
        worst = Math.max(worst, max);
        const pixel = at < 0 ? '' : ` first worst at pixel (${(at >> 2) % 256}, ${(at >> 2) / 256 | 0}) channel ${at & 3}:` +
          ` gpu ${gpu[at]} cpu ${cpu[at]}`;
        expect(max, `${where}: max channel difference${pixel}`).toBeLessThanOrEqual(1);
      }
    }
    info.annotations.push({ type: 'max channel difference', description: `${browserName} level ${level}: ${worst}` });
  }
  expect(errors).toEqual([]);
});
