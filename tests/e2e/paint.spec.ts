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

async function screenPoint(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const [sx, sy] = await docToScreen(page, x, y);
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

async function paintBlackSquare(page: Page, from: [number, number], to: [number, number]) {
  await page.keyboard.press('m');
  await dragDoc(page, from, to);
  await page.keyboard.press('Alt+Backspace');
  await page.keyboard.press('Control+d');
}

test('brush drag paints black along the path, leaves the rest white, and is one undo step', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d'); // fg black, bg white
  await page.keyboard.press('b');
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-active-tool', 'brush');

  await dragDoc(page, [40, 100], [160, 100]);
  await expect(page.locator('.history-row').last()).toHaveText('Brush');
  await expect.poll(() => sample(page, 100, 100)).toEqual([0, 0, 0, 255]); // on the path: painted
  await expect.poll(() => sample(page, 100, 20)).toEqual([255, 255, 255, 255]); // off the path: untouched

  await page.keyboard.press('Control+z');
  await expect.poll(() => sample(page, 100, 100)).toEqual([255, 255, 255, 255]); // one undo restores the whole stroke
});

test('a single brush click paints one dab and closes the stroke', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await page.keyboard.press('b');
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-active-tool', 'brush');
  const [x, y] = await screenPoint(page, 100, 100);
  await page.mouse.click(x, y);
  await expect(page.locator('.history-row').last()).toHaveText('Brush');
  await expect.poll(() => sample(page, 100, 100)).toEqual([0, 0, 0, 255]);
});

test('pencil paints fully opaque aliased pixels', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await page.keyboard.press('b');
  await page.keyboard.press('Shift+B');
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-active-tool', 'pencil');

  await dragDoc(page, [40, 100], [160, 100]);
  await expect(page.locator('.history-row').last()).toHaveText('Pencil');
  const [, , , a] = await sample(page, 100, 100);
  expect(a).toBe(255); // pencil never leaves a partial-alpha edge under a fully covered dab
});

test('eraser clears a painted square', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await paintBlackSquare(page, [40, 40], [160, 160]);
  await expect.poll(() => sample(page, 100, 100)).toEqual([0, 0, 0, 255]);

  await page.keyboard.press('e');
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-active-tool', 'eraser');
  await dragDoc(page, [40, 100], [160, 100]);
  await expect(page.locator('.history-row').last()).toHaveText('Eraser');
  await expect.poll(() => sample(page, 100, 100)).toEqual([0, 0, 0, 0]); // erased: transparent
  await expect.poll(() => sample(page, 100, 50)).toEqual([0, 0, 0, 255]); // outside the erased row: still painted
});

test('the selection clips the brush stroke', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await page.keyboard.press('m');
  await dragDoc(page, [20, 80], [100, 120]); // selects only the left half of the row the stroke will follow
  await expect(page.locator('.history-row').last()).toHaveText('Rectangular Marquee');
  await page.keyboard.press('b');
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-active-tool', 'brush');

  await dragDoc(page, [40, 100], [160, 100]);
  await expect.poll(() => sample(page, 60, 100)).toEqual([0, 0, 0, 255]); // inside the selection: painted
  await expect.poll(() => sample(page, 140, 100)).toEqual([255, 255, 255, 255]); // outside the selection: untouched
});
