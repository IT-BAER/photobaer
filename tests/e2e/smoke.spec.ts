import { test, expect, type Page } from '@playwright/test';
import { inflateSync } from 'node:zlib';

// Screenshot of the canvas centre pixel as [r, g, b]. In a 1x1 PNG every row filter leaves the only
// pixel unchanged, so the inflated bytes are the filter byte followed by the raw pixel.
async function centerPixel(page: Page) {
  const b = (await page.locator('canvas').boundingBox())!;
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
