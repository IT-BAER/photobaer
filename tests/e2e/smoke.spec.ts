import { test, expect, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { readPsd, writePsdUint8Array } from 'ag-psd';

// Screenshot of the canvas centre pixel as [r, g, b]. In a 1x1 PNG every row filter leaves the only
// pixel unchanged, so the inflated bytes are the filter byte followed by the raw pixel.
async function centerPixel(page: Page) {
  const b = (await page.locator('canvas').first().boundingBox())!;
  const png = await page.screenshot({ clip: { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2), width: 1, height: 1 } });
  const idat: Buffer[] = [];
  for (let o = 8; o < png.length; o += 12 + png.readUInt32BE(o)) {
    if (png.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + png.readUInt32BE(o)));
  }
  return [...inflateSync(Buffer.concat(idat)).subarray(1, 4)];
}

for (const renderer of ['default', 'webgl2']) {
  test(`new, invert, autosave and reload restore (${renderer} renderer)`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(renderer === 'webgl2' ? '/?renderer=webgl2' : '/');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);

    await page.getByRole('button', { name: 'New image' }).click();
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByText('All changes saved locally')).toBeVisible();
    const used = await page.getByText(/^(WebGPU|WebGL2)$/).textContent();
    test.info().annotations.push({ type: 'renderer', description: used! });
    if (renderer === 'webgl2') expect(used).toBe('WebGL2');
    await expect.poll(() => centerPixel(page)).toEqual([255, 255, 255]);

    await page.keyboard.press('Control+I');
    await expect.poll(() => centerPixel(page)).toEqual([0, 0, 0]);
    // ponytail: waits out the 1 s autosave debounce instead of observing the save cycle.
    await page.waitForTimeout(1500);
    await expect(page.getByText('All changes saved locally')).toBeVisible();

    await page.reload();
    await expect(page.getByText('1920 × 1080 px, 8-bit')).toBeVisible();
    await expect.poll(() => centerPixel(page)).toEqual([0, 0, 0]);
    expect(errors).toEqual([]);
  });
}

test('open a layered PSD and save it back as PSD', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  // The download fallback instead of the native save dialog, which Playwright cannot drive.
  await page.addInitScript(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  const px = (w: number, h: number, c: number[]) => ({ width: w, height: h, data: new Uint8ClampedArray(Array.from({ length: w * h }, () => c).flat()) });
  const psd = writePsdUint8Array({
    width: 300, height: 200, imageData: px(300, 200, [255, 0, 0, 255]),
    children: [
      { name: 'bg', imageData: px(300, 200, [255, 255, 255, 255]) },
      { name: 'grp', children: [{ name: 'red', imageData: px(300, 200, [255, 0, 0, 255]), blendMode: 'multiply' }] },
    ],
  });
  await page.goto('/');
  await page.locator('input[type=file]').setInputFiles({ name: 'layers.psd', mimeType: 'image/vnd.adobe.photoshop', buffer: Buffer.from(psd) });
  await expect(page.getByText('300 × 200 px, 8-bit')).toBeVisible();
  await expect.poll(() => centerPixel(page)).toEqual([255, 0, 0]);

  await page.getByRole('button', { name: 'File' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByText('Save as PSD…').click()]);
  expect(download.suggestedFilename()).toBe('layers.psd');
  const saved = readPsd(readFileSync(await download.path()), { skipLayerImageData: true, skipCompositeImageData: true });
  expect(saved.children?.map(l => l.name)).toEqual(['bg', 'grp']);
  expect(saved.children?.[1].children?.[0]).toMatchObject({ name: 'red', blendMode: 'multiply' });
  expect(errors).toEqual([]);
});

test('a file opened while the engine boots opens once the engine is ready', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  // Hold the worker's init call back, so the file arrives before the engine has booted.
  await page.addInitScript(() => {
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, m: { op?: string }, ...rest: never[]) {
      if (m?.op === 'init') setTimeout(() => post.call(this, m, ...rest), 1500);
      else post.call(this, m, ...rest);
    } as typeof post;
  });
  await page.goto('/');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await expect(page.getByText('1 × 1 px, 8-bit')).toBeVisible();
  await page.waitForTimeout(2000);
  await expect(page.getByText('1 × 1 px, 8-bit')).toBeVisible();
  expect(errors).toEqual([]);
});
