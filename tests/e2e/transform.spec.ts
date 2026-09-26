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

async function screenPoint(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const [sx, sy] = await page.evaluate(([x, y]) => (window as unknown as Photobaer).photobaer.viewer.docToScreen(x, y), [x, y]);
  return [box.x + sx, box.y + sy];
}

async function dragDoc(page: Page, from: [number, number], to: [number, number]) {
  const [x0, y0] = await screenPoint(page, ...from);
  const [x1, y1] = await screenPoint(page, ...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 10 });
  await page.mouse.up();
}

async function sample(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  return page.evaluate(([x, y]) => (window as unknown as Photobaer).photobaer.client.call('sample', x, y, 1, null), [x, y]) as Promise<[number, number, number, number]>;
}

const history = (page: Page) => page.locator('.history-row');
const bar = (page: Page) => page.getByRole('toolbar', { name: 'Transform options' });
const poll = { timeout: 15000 };
const BLACK = [0, 0, 0, 255], WHITE = [255, 255, 255, 255];

// A black 40 x 40 square at (20, 20) on a new layer above the white one, no selection left.
async function blackSquare(page: Page) {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.getByRole('button', { name: 'New layer' }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await page.keyboard.press('d');
  await page.evaluate(() => (window as unknown as Photobaer).photobaer.client.call('select', { kind: 'rect', x: 20, y: 20, w: 40, h: 40 }, 'new', false, 0, 'Rectangular Marquee'));
  await page.keyboard.press('Alt+Backspace');
  await expect(history(page).last()).toHaveText('Fill with Foreground Color');
  await page.keyboard.press('Control+d');
  await expect(history(page).last()).toHaveText('Deselect');
  return history(page).count();
}

test('Ctrl+T, a corner drag and Enter commit one Free Transform step that changes the pixels', async ({ page }) => {
  const steps = await blackSquare(page);
  await page.keyboard.press('Control+t');
  await expect(bar(page)).toBeVisible();
  // Proportional by default: the bottom-right corner to (40, 40) halves the square about its top-left.
  await dragDoc(page, [60, 60], [40, 40]);
  // Pointer positions round to device px, so the scale lands near, not exactly on, 50 %.
  await expect.poll(async () => Math.abs(Number(await bar(page).getByLabel('W', { exact: true }).inputValue()) - 50), poll).toBeLessThan(1);
  await page.keyboard.press('Enter');
  await expect(bar(page)).toBeHidden();
  await expect(history(page)).toHaveCount(steps + 1);
  await expect(history(page).last()).toHaveText('Free Transform');
  await expect.poll(() => sample(page, 25, 25), poll).toEqual(BLACK);
  expect(await sample(page, 50, 50)).toEqual(WHITE);
});

test('Esc cancels the session and restores identical pixels; an unmodified session commits nothing', async ({ page }) => {
  const steps = await blackSquare(page);
  const points: [number, number][] = [];
  for (let y = 5; y < 200; y += 15) for (let x = 5; x < 200; x += 15) points.push([x, y]);
  const before = await Promise.all(points.map(p => sample(page, ...p)));

  await page.keyboard.press('Control+t');
  await dragDoc(page, [60, 60], [40, 40]);
  // The session lifts the square out of the document; the refine pass about 500 ms after the drag
  // renders it back, scaled.
  await expect.poll(() => sample(page, 25, 25), poll).toEqual(BLACK);
  expect(await sample(page, 50, 50)).toEqual(WHITE);
  // Arrows move the reference point; Ctrl+Z steps back through the session's own states only.
  const x = bar(page).getByLabel('X', { exact: true }), w = bar(page).getByLabel('W', { exact: true });
  const x0 = Number(await x.inputValue());
  await page.keyboard.press('ArrowRight');
  await expect(x).toHaveValue((x0 + 1).toFixed(2));
  await page.keyboard.press('Control+z');
  await expect(x).toHaveValue(x0.toFixed(2));
  await page.keyboard.press('Control+z');
  await expect(w).toHaveValue('100.00');
  await expect(history(page)).toHaveCount(steps);
  await page.keyboard.press('Escape');
  await expect(bar(page)).toBeHidden();
  await expect.poll(() => Promise.all(points.map(p => sample(page, ...p))), poll).toEqual(before);
  await expect(history(page)).toHaveCount(steps);

  await page.keyboard.press('Control+t');
  await expect(bar(page)).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(bar(page)).toBeHidden();
  await expect(history(page)).toHaveCount(steps);
  await expect.poll(() => Promise.all(points.map(p => sample(page, ...p))), poll).toEqual(before);
});

async function transformItem(page: Page, item: string) {
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Transform\s*›/ }).hover();
  await page.getByRole('menu', { name: 'Transform' }).getByRole('menuitem', { name: new RegExp(`^${item}`) }).click();
}

test('Edit > Transform rotates 90 degrees clockwise and back exactly; warp entries are disabled', async ({ page }) => {
  await blackSquare(page);
  // A white stripe down the left of the square makes it asymmetric.
  await page.evaluate(() => (window as unknown as Photobaer).photobaer.client.call('select', { kind: 'rect', x: 20, y: 20, w: 10, h: 40 }, 'new', false, 0, 'Rectangular Marquee'));
  await page.keyboard.press('Control+Backspace');
  await expect(history(page).last()).toHaveText('Fill with Background Color');
  await page.keyboard.press('Control+d');
  const steps = await history(page).count();
  const points: [number, number][] = [];
  for (let y = 12; y < 70; y += 5) for (let x = 12; x < 70; x += 5) points.push([x, y]);
  const before = await Promise.all(points.map(p => sample(page, ...p)));
  expect(await sample(page, 25, 40)).toEqual(WHITE);

  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Transform\s*›/ }).hover();
  const sub = page.getByRole('menu', { name: 'Transform' });
  for (const l of ['Warp', 'Split Warp Horizontally', 'Split Warp Vertically', 'Split Warp Crosswise', 'Remove Warp Split']) {
    await expect(sub.getByRole('menuitem', { name: l, exact: true })).toBeDisabled();
  }
  await sub.getByRole('menuitem', { name: /^Rotate 90° Clockwise/ }).click();
  await expect(history(page).last()).toHaveText('Rotate 90° Clockwise');
  await expect.poll(() => sample(page, 25, 40), poll).toEqual(BLACK);
  await transformItem(page, 'Rotate 90° Counter Clockwise');
  await expect(history(page).last()).toHaveText('Rotate 90° Counter Clockwise');
  await expect(history(page)).toHaveCount(steps + 2);
  await expect.poll(() => Promise.all(points.map(p => sample(page, ...p))), poll).toEqual(before);
});

test('Ctrl+Shift+T repeats a scale on the layer bounds as Transform Again', async ({ page }) => {
  const steps = await blackSquare(page);
  await page.keyboard.press('Control+Shift+t');
  await expect(page.getByText('There is no transform to repeat.')).toBeVisible();
  await transformItem(page, 'Scale');
  await expect(bar(page).getByLabel('Transform mode')).toHaveValue('scale');
  // Linked W and H: 50 % about the centre (40, 40); Enter in a field applies.
  await bar(page).getByLabel('W', { exact: true }).fill('50');
  await bar(page).getByLabel('W', { exact: true }).press('Enter');
  await expect(bar(page)).toBeHidden();
  await expect(history(page).last()).toHaveText('Free Transform');
  await expect.poll(() => sample(page, 32, 32), poll).toEqual(BLACK);
  expect(await sample(page, 25, 25)).toEqual(WHITE);
  await page.keyboard.press('Control+Shift+t');
  await expect(history(page).last()).toHaveText('Transform Again');
  await expect(history(page)).toHaveCount(steps + 2);
  await expect.poll(() => sample(page, 32, 32), poll).toEqual(WHITE);
  expect(await sample(page, 40, 40)).toEqual(BLACK);
});

test('Select > Transform Selection scales the outline only; a call past the UI closes the session', async ({ page }) => {
  const steps = await blackSquare(page);
  const call = (op: string, ...a: unknown[]) => page.evaluate(([op, a]) => (window as unknown as Photobaer).photobaer.client.call(op as string, ...(a as unknown[])), [op, a] as const);
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Transform Selection/ }).click();
  await expect(page.getByText('Make a selection first.')).toBeVisible();
  await call('select', { kind: 'rect', x: 20, y: 20, w: 40, h: 40 }, 'new', false, 0, 'Rectangular Marquee');
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Transform Selection/ }).click();
  await bar(page).getByLabel('W', { exact: true }).fill('50');
  await bar(page).getByLabel('W', { exact: true }).press('Enter');
  await expect(bar(page)).toBeHidden();
  await expect(history(page).last()).toHaveText('Transform Selection');
  await expect(history(page)).toHaveCount(steps + 2);
  expect([await call('selectionAt', 25, 25), await call('selectionAt', 40, 40)]).toEqual([0, 255]);
  expect(await sample(page, 25, 25)).toEqual(BLACK);

  await page.keyboard.press('Control+t');
  await expect(bar(page)).toBeVisible();
  await call('addLayer', 0);
  await expect(bar(page)).toBeHidden();
  await expect.poll(() => sample(page, 40, 40), poll).toEqual(BLACK);
});
