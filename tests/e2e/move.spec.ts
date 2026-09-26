import { test, expect, type Page } from '@playwright/test';

type Photobaer = { photobaer: { viewer: { view: { zoom: number }; docToScreen(x: number, y: number): [number, number] }; client: { call: (op: string, ...a: unknown[]) => Promise<unknown> } } };

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
const poll = { timeout: 15000 };
const BLACK = [0, 0, 0, 255], WHITE = [255, 255, 255, 255];

// A black 40 x 40 square at (20, 20) on the active layer, no selection left, Move tool active.
async function blackSquare(page: Page) {
  await page.keyboard.press('d');
  // Selected through the worker: a marquee drag can land on fractional px and soften the edges.
  await page.evaluate(() => (window as unknown as Photobaer).photobaer.client.call('select', { kind: 'rect', x: 20, y: 20, w: 40, h: 40 }, 'new', false, 0, 'Rectangular Marquee'));
  await page.keyboard.press('Alt+Backspace');
  await expect(history(page).last()).toHaveText('Fill with Foreground Color');
  await page.keyboard.press('Control+d');
  await expect(history(page).last()).toHaveText('Deselect');
  await page.keyboard.press('v');
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-active-tool', 'move');
}

test('dragging moves the layer pixels as one Move step; undo restores identical pixels', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await blackSquare(page);
  const points: [number, number][] = [];
  for (let y = 5; y < 200; y += 15) for (let x = 5; x < 200; x += 15) points.push([x, y]);
  const before = await Promise.all(points.map(p => sample(page, ...p)));

  await dragDoc(page, [40, 40], [110, 90]);
  await expect(history(page).last()).toHaveText('Move');
  await expect(history(page)).toHaveCount(5);
  await expect.poll(() => sample(page, 110, 90), poll).toEqual(BLACK);
  expect(await sample(page, 40, 40)).not.toEqual(BLACK);

  await page.keyboard.press('Control+z');
  await expect(page.locator('.history-row.current')).toHaveText('Deselect');
  await expect.poll(() => Promise.all(points.map(p => sample(page, ...p))), poll).toEqual(before);
});

test('Alt-drag duplicates the layer first and records Move Copy', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await blackSquare(page);
  await expect(page.locator('.layer-row')).toHaveCount(1);
  await page.keyboard.down('Alt');
  await dragDoc(page, [40, 40], [140, 140]);
  await page.keyboard.up('Alt');
  await expect(history(page).last()).toHaveText('Move Copy');
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await expect.poll(() => sample(page, 40, 40), poll).toEqual(BLACK);
  await expect.poll(() => sample(page, 140, 140), poll).toEqual(BLACK);
});

test('arrow keys nudge the layer 1 px, Shift 10 px, one Move step per press', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await blackSquare(page);
  await page.keyboard.press('ArrowRight');
  await expect(history(page)).toHaveCount(5);
  await expect(history(page).last()).toHaveText('Move');
  await expect.poll(() => sample(page, 60, 30), poll).toEqual(BLACK);
  expect(await sample(page, 61, 30)).not.toEqual(BLACK);
  expect(await sample(page, 20, 30)).not.toEqual(BLACK);
  await page.keyboard.press('Shift+ArrowDown');
  await expect(history(page)).toHaveCount(6);
  await expect.poll(() => sample(page, 30, 69), poll).toEqual(BLACK);
  expect(await sample(page, 30, 70)).not.toEqual(BLACK);
  expect(await sample(page, 30, 29)).not.toEqual(BLACK);
});

test('a drag that ends within 6 screen px of the canvas edge snaps to it', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 400, 400);
  await page.getByRole('button', { name: 'New layer' }).click();
  await expect(page.locator('.layer-row')).toHaveCount(2);
  await blackSquare(page);
  const zoom = await page.evaluate(() => (window as unknown as Photobaer).photobaer.viewer.view.zoom);
  // The square's left edge lands `gap` doc px (at most 4 screen px, pointer rounding included
  // at most 6) right of the canvas edge.
  const gap = Math.max(1, Math.floor(4 / zoom));
  expect(gap * zoom).toBeLessThanOrEqual(4);
  await dragDoc(page, [40, 40], [40 - 20 + gap, 47]);
  await expect(history(page).last()).toHaveText('Move');
  await expect.poll(() => sample(page, 0, 40), poll).toEqual(BLACK);
  expect(await sample(page, 39, 40)).toEqual(BLACK);
  expect(await sample(page, 40, 40)).toEqual(WHITE);
});

