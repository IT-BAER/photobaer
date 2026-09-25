import { test, expect, type Page } from '@playwright/test';
import { writePsdUint8Array } from 'ag-psd';
import { TOOLS, SLOTS } from '../../app/src/shell/tools.ts';
import { defaultSwatches } from '../../app/src/shell/swatches.ts';

const toolbar = (page: Page) => page.getByRole('toolbar', { name: 'Tools' });

test('every M2 tool is reachable by its key and via the flyout', async ({ page }) => {
  await page.goto('/');
  const bar = toolbar(page);
  await expect(bar).toBeVisible();

  for (const tool of Object.values(TOOLS)) {
    const slot = SLOTS.find(s => s.id === tool.slot)!;
    await page.keyboard.press(slot.key);
    for (let i = 0; i < slot.tools.length; i++) {
      if ((await bar.getAttribute('data-active-tool')) === tool.id) break;
      await page.keyboard.press(`Shift+${slot.key.toUpperCase()}`);
    }
    await expect(bar).toHaveAttribute('data-active-tool', tool.id);
  }

  for (const [i, slot] of SLOTS.entries()) {
    const slotButton = bar.locator('.tool-slot').nth(i).locator('button.slot');
    for (const toolId of slot.tools) {
      await slotButton.click({ button: 'right' });
      await page.getByRole('menuitem', { name: TOOLS[toolId].label, exact: true }).click();
      await expect(bar).toHaveAttribute('data-active-tool', toolId);
    }
  }
});

test('D resets to black/white and X swaps the foreground and background chips', async ({ page }) => {
  await page.goto('/');
  await expect(toolbar(page)).toBeVisible();
  const fgChip = page.locator('.toolbar .chip.fg');
  const bgChip = page.locator('.toolbar .chip.bg');
  await page.keyboard.press('d');
  await expect(fgChip).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(bgChip).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await page.keyboard.press('x');
  await expect(fgChip).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(bgChip).toHaveCSS('background-color', 'rgb(0, 0, 0)');
});

test('the color picker sets the foreground from a typed hex value', async ({ page }) => {
  await page.goto('/');
  await page.locator('.toolbar .chip.fg').click();
  const dialog = page.locator('dialog.color-picker');
  await expect(dialog).toBeVisible();
  const hexInput = dialog.locator('.color-field.hex input');
  await hexInput.fill('336699');
  await hexInput.press('Enter');
  await dialog.getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.toolbar .chip.fg')).toHaveCSS('background-color', 'rgb(51, 102, 153)');
});

test('Alt+click on a swatch sets the background color', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Swatches' }).click();
  const black = defaultSwatches()[0]; // grey ramp starts at 0%
  const firstSwatch = page.locator('.swatch-cell:not(.add)').first();
  await expect(firstSwatch).toBeVisible();
  await firstSwatch.click({ modifiers: ['Alt'] });
  const [r, g, b] = black.rgb;
  await expect(page.locator('.toolbar .chip.bg')).toHaveCSS('background-color', `rgb(${r}, ${g}, ${b})`);
});

// A 21x21 opaque image: black everywhere except a 5x5 patch centered on the canvas with known,
// non-uniform RGB values, so a 5x5 eyedropper sample at the exact center has a known mean.
function patchPixel(x: number, y: number): [number, number, number, number] {
  if (x < 8 || x > 12 || y < 8 || y > 12) return [0, 0, 0, 255];
  return [(x - 8) * 50, (y - 8) * 50, 100, 255];
}
function testImage() {
  const w = 21, h = 21;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = patchPixel(x, y);
      const o = (y * w + x) * 4;
      data.set([r, g, b, a], o);
    }
  }
  return { width: w, height: h, data };
}
function expectedMean(): [number, number, number, number] {
  let r = 0, g = 0, b = 0, a = 0, n = 0;
  for (let y = 8; y <= 12; y++) for (let x = 8; x <= 12; x++) { const p = patchPixel(x, y); r += p[0]; g += p[1]; b += p[2]; a += p[3]; n++; }
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
}

test('eyedropper 5x5 returns the known mean of a test image', async ({ page }) => {
  await page.goto('/');
  const psd = writePsdUint8Array({ width: 21, height: 21, imageData: testImage() });
  await page.locator('input[type=file]').setInputFiles({ name: 'patch.psd', mimeType: 'image/vnd.adobe.photoshop', buffer: Buffer.from(psd) });
  await expect(page.getByText('21 × 21 px, 8-bit')).toBeVisible();
  await page.locator('.status').click(); // move focus off the file input so letter shortcuts fire

  // Direct check of the sample() math against the known mean of the patch.
  const sampled = await page.evaluate(() => (window as unknown as { photobaer: { client: { call: (op: string, ...a: unknown[]) => Promise<unknown> } } }).photobaer.client.call('sample', 10, 10, 5, null));
  expect(sampled).toEqual(expectedMean());

  // Interactive check: select the eyedropper, set a 5x5 sample, and click the canvas center
  // (= document center for a fitted, unrotated view).
  await page.keyboard.press('i');
  await page.getByRole('combobox', { name: 'Sample size' }).selectOption('5x5');
  const box = (await page.locator('canvas').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const [r, g, b] = expectedMean();
  await expect(page.locator('.toolbar .chip.fg')).toHaveCSS('background-color', `rgb(${r}, ${g}, ${b})`);

  // Alt+click sets the background instead.
  await page.keyboard.down('Alt');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.up('Alt');
  await expect(page.locator('.toolbar .chip.bg')).toHaveCSS('background-color', `rgb(${r}, ${g}, ${b})`);
});
