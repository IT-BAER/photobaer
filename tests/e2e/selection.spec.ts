import { test, expect, type Page } from '@playwright/test';

type Photobaer = { photobaer: { viewer: { docToScreen(x: number, y: number): [number, number] }; client: { call: (op: string, ...a: unknown[]) => Promise<unknown> } } };

async function newDoc(page: Page, w: number, h: number) {
  await page.getByRole('button', { name: 'New image' }).click();
  await page.locator('input[name=w]').fill(String(w));
  await page.locator('input[name=h]').fill(String(h));
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText(`${w} × ${h} px, 8-bit`)).toBeVisible();
  await page.locator('.status').click(); // move focus off the size inputs so letter shortcuts fire
}

async function docToScreen(page: Page, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(([x, y]) => (window as unknown as Photobaer).photobaer.viewer.docToScreen(x, y), [x, y]);
}

async function dragMarquee(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const [x0, y0] = await docToScreen(page, ...from);
  const [x1, y1] = await docToScreen(page, ...to);
  await page.mouse.move(box.x + x0, box.y + y0);
  await page.mouse.down();
  await page.mouse.move(box.x + x1, box.y + y1, { steps: 5 });
  await page.mouse.up();
}

async function sample(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  return page.evaluate(([x, y]) => (window as unknown as Photobaer).photobaer.client.call('sample', x, y, 1, null), [x, y]) as Promise<[number, number, number, number]>;
}

// Opens the Select menu, asserts (with Playwright's built-in retry) whether Deselect is enabled,
// then closes the menu again.
async function expectDeselectEnabled(page: Page, enabled: boolean) {
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  const item = page.getByRole('menuitem', { name: 'Deselect' });
  if (enabled) await expect(item).toBeEnabled(); else await expect(item).toBeDisabled();
  await page.keyboard.press('Escape');
}

async function overlayHasPixels(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const c = document.querySelector('canvas.overlay') as HTMLCanvasElement;
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return true;
    return false;
  });
}

test('rectangular marquee constrains a fill to the selection', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await page.keyboard.press('m');
  await dragMarquee(page, [20, 20], [120, 120]);
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(() => sample(page, 70, 70)).toEqual([0, 0, 0, 255]);
  await expect.poll(() => sample(page, 150, 150)).toEqual([255, 255, 255, 255]);
  await expect(page.locator('.history-row')).toHaveText(['Initial state', 'Rectangular Marquee', 'Fill with Foreground Color']);
  expect(errors).toEqual([]);
});

test('overlay draws marching ants for a selection and clears them on deselect', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('m');
  await dragMarquee(page, [20, 20], [120, 120]);
  await expect.poll(() => overlayHasPixels(page)).toBe(true);
  const frame = () => page.evaluate(() => (document.querySelector('canvas.overlay') as HTMLCanvasElement).toDataURL());
  const first = await frame();
  await expect.poll(frame, { message: 'the ants march without a view change' }).not.toBe(first);
  await page.keyboard.press('Control+d');
  await expect.poll(() => overlayHasPixels(page)).toBe(false);
});

test('polygonal lasso selects a triangle, inverse and clear leave only its inside', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('l');
  const toolbar = page.getByRole('toolbar', { name: 'Tools' });
  while ((await toolbar.getAttribute('data-active-tool')) !== 'polygonalLasso') await page.keyboard.press('Shift+L');

  for (const [x, y] of [[50, 50], [150, 50], [100, 150]] as const) {
    const [sx, sy] = await docToScreen(page, x, y);
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.click(box.x + sx, box.y + sy);
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('.history-row').last()).toHaveText('Polygonal Lasso');
  await page.keyboard.press('Shift+Control+i');
  await expect(page.locator('.history-row').last()).toHaveText('Select Inverse');
  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 100, 70)).toEqual([255, 255, 255, 255]);
  await expect.poll(() => sample(page, 5, 5)).toEqual([0, 0, 0, 0]);
});

test('select all/deselect/reselect restores, and undo after a marquee clears the selection', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);

  await page.keyboard.press('Control+a');
  await expectDeselectEnabled(page, true);

  await page.keyboard.press('Control+d');
  await expectDeselectEnabled(page, false);

  await page.keyboard.press('Shift+Control+d');
  await expectDeselectEnabled(page, true);

  await page.keyboard.press('Control+d');
  await expectDeselectEnabled(page, false);

  await page.keyboard.press('m');
  await dragMarquee(page, [20, 20], [120, 120]);
  await expectDeselectEnabled(page, true);

  await page.keyboard.press('Control+z');
  await expectDeselectEnabled(page, false);
});
