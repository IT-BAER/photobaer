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

async function selectRect(page: Page, from: [number, number], to: [number, number]) {
  await page.keyboard.press('m');
  await dragDoc(page, from, to);
}

const history = (page: Page) => page.locator('.history-row');

test('Alt+Backspace fills the selection with the foreground, Ctrl+Backspace with the background, undo restores', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await selectRect(page, [20, 20], [120, 120]);
  await page.keyboard.press('Alt+Backspace');
  await expect.poll(() => sample(page, 70, 70)).toEqual([0, 0, 0, 255]);
  await expect.poll(() => sample(page, 150, 150)).toEqual([255, 255, 255, 255]);
  await expect(history(page).last()).toHaveText('Fill with Foreground Color');
  await page.keyboard.press('Control+Backspace');
  await expect.poll(() => sample(page, 70, 70)).toEqual([255, 255, 255, 255]);
  await expect(history(page).last()).toHaveText('Fill with Background Color');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect.poll(() => sample(page, 70, 70)).toEqual([255, 255, 255, 255]);
  await expect(page.locator('.history-row.current')).toHaveText('Rectangular Marquee');
  expect(errors).toEqual([]);
});

test('Shift+F5 fills the selection with a pattern after a live preview', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await selectRect(page, [0, 0], [100, 100]);
  await page.keyboard.press('Shift+F5');
  const dlg = page.locator('dialog[open]');
  await expect(dlg.getByRole('heading', { name: 'Fill' })).toBeVisible();
  await dlg.getByLabel('Contents').selectOption('pattern');
  const values = async () => {
    const s = new Set<string>();
    for (let y = 2; y < 100; y += 7) for (let x = 2; x < 100; x += 7) s.add(String(await sample(page, x, y)));
    return s.size;
  };
  await expect.poll(values, { message: 'the preview shows the pattern' }).toBeGreaterThan(1);
  await dlg.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(history(page).last()).toHaveText('Fill');
  expect(await values()).toBeGreaterThan(1);
  expect(await sample(page, 150, 150)).toEqual([255, 255, 255, 255]);
});

test('Fill dialog Cancel restores the previewed pixels and records nothing', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 100, 100);
  await page.keyboard.press('Shift+F5');
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('Contents').selectOption('black');
  await expect.poll(() => sample(page, 50, 50)).toEqual([0, 0, 0, 255]);
  await dlg.getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => sample(page, 50, 50)).toEqual([255, 255, 255, 255]);
  await expect(history(page)).toHaveText(['Initial state']);
});

test('Edit > Stroke inside draws a 3 px ring inside a rectangle selection', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await selectRect(page, [50, 50], [150, 150]);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Stroke/ }).click();
  const dlg = page.locator('dialog[open]');
  await expect(dlg.getByRole('heading', { name: 'Stroke' })).toBeVisible();
  await expect(dlg.getByLabel('Inside')).toBeChecked();
  await dlg.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(history(page).last()).toHaveText('Stroke');
  expect(await sample(page, 51, 100)).toEqual([0, 0, 0, 255]);
  expect(await sample(page, 100, 148)).toEqual([0, 0, 0, 255]);
  expect(await sample(page, 56, 100)).toEqual([255, 255, 255, 255]);
  expect(await sample(page, 46, 100)).toEqual([255, 255, 255, 255]);
  expect(await sample(page, 100, 100)).toEqual([255, 255, 255, 255]);
});

test('gradient drag paints a monotonic black-to-white row; Shift snaps; a click without a drag does nothing', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 100);
  await page.keyboard.press('d');
  await page.keyboard.press('g');
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-active-tool', 'gradient');
  await expect(page.locator('.stage canvas').first()).toHaveCSS('cursor', 'crosshair');

  const [cx, cy] = await screenPoint(page, 100, 50);
  await page.mouse.click(cx, cy);
  await expect(history(page)).toHaveText(['Initial state']);

  await dragDoc(page, [10, 50], [190, 50]);
  await expect(history(page).last()).toHaveText('Gradient');
  const row: number[] = [];
  for (let x = 0; x < 200; x += 10) row.push((await sample(page, x, 50))[0]);
  expect(row[0]).toBe(0);
  expect(row.at(-1)).toBe(255);
  for (let i = 1; i < row.length; i++) expect(row[i]).toBeGreaterThanOrEqual(row[i - 1]);

  // Shift: an end 20 px below the start at 70 px across snaps to horizontal, so columns are uniform.
  await page.keyboard.down('Shift');
  await dragDoc(page, [60, 50], [130, 70]);
  await page.keyboard.up('Shift');
  await expect(history(page)).toHaveCount(3);
  for (const x of [80, 120, 150]) expect(Math.abs((await sample(page, x, 5))[0] - (await sample(page, x, 95))[0])).toBeLessThanOrEqual(1);
  expect((await sample(page, 150, 50))[0]).toBe(255);
});

test('gradient editor: adding and moving a stop changes the ramp and the tool gradient', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 100);
  await page.keyboard.press('g');
  const button = page.getByRole('button', { name: 'Edit gradient' });
  const before = await button.getAttribute('style');
  await button.click();
  const dlg = page.locator('dialog[open]');
  await expect(dlg.getByRole('heading', { name: 'Gradient Editor' })).toBeVisible();
  const ramp = dlg.getByTestId('gradient-ramp');
  const initial = await ramp.getAttribute('data-ramp');
  await dlg.getByRole('button', { name: 'Add color stop' }).click();
  await expect(dlg.locator('.color-rail .gradient-stop')).toHaveCount(3);
  await dlg.getByLabel('Location').fill('20');
  await expect.poll(() => ramp.getAttribute('data-ramp')).not.toBe(initial);
  await dlg.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('dialog.gradient-editor')).not.toHaveAttribute('open');
  await expect.poll(() => button.getAttribute('style')).not.toBe(before);
});

test('noise gradient: Randomize changes the ramp', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 100);
  await page.keyboard.press('g');
  await page.getByRole('button', { name: 'Edit gradient' }).click();
  const dlg = page.locator('dialog[open]');
  await dlg.getByLabel('Type').selectOption('noise');
  const ramp = dlg.getByTestId('gradient-ramp');
  const first = await ramp.getAttribute('data-ramp');
  await dlg.getByRole('button', { name: 'Randomize' }).click();
  await expect.poll(() => ramp.getAttribute('data-ramp')).not.toBe(first);
});
