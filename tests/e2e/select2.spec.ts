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

async function clickDoc(page: Page, x: number, y: number, opts: { shift?: boolean; alt?: boolean } = {}) {
  const [px, py] = await screenPoint(page, x, y);
  if (opts.shift) await page.keyboard.down('Shift');
  if (opts.alt) await page.keyboard.down('Alt');
  await page.mouse.click(px, py);
  if (opts.alt) await page.keyboard.up('Alt');
  if (opts.shift) await page.keyboard.up('Shift');
}

async function dragDoc(page: Page, from: [number, number], to: [number, number]) {
  const [x0, y0] = await screenPoint(page, ...from);
  const [x1, y1] = await screenPoint(page, ...to);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 5 });
  await page.mouse.up();
}

async function sample(page: Page, x: number, y: number): Promise<[number, number, number, number]> {
  return page.evaluate(([x, y]) => (window as unknown as Photobaer).photobaer.client.call('sample', x, y, 1, null), [x, y]) as Promise<[number, number, number, number]>;
}

// selectionMask's coverage bytes as a plain array (structured-clone-safe), or null (no selection channel).
async function maskBytes(page: Page, level = 0): Promise<number[] | null> {
  return page.evaluate(async level => {
    const r = (await (window as unknown as Photobaer).photobaer.client.call('selectionMask', level)) as { data: ArrayBuffer | null };
    return r.data ? Array.from(new Uint8Array(r.data)) : null;
  }, level);
}

async function openMenuItem(page: Page, menu: string, label: string) {
  await page.getByRole('button', { name: menu, exact: true }).click();
  await page.getByRole('menuitem', { name: new RegExp(`^${label}`) }).click();
}

const dialog = (page: Page) => page.locator('dialog[open]');

// Selects a rectangle and fills it black, leaving the rest of the (white) canvas untouched: a
// simple two-color fixture built from already-covered primitives (marquee select + fill) rather
// than an OffscreenCanvas/PNG round trip, so wand and bucket exercise the same document state a
// real two-color image would produce.
async function paintBlackSquare(page: Page, from: [number, number], to: [number, number]) {
  await page.keyboard.press('m');
  await dragDoc(page, from, to);
  await page.keyboard.press('Alt+Backspace'); // fills the marquee with black (default foreground before any color change)
  await page.keyboard.press('Control+d');
}

test('magic wand: contiguous click selects one square, Shift+click adds the other, Delete clears both', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d'); // reset fg=black, bg=white
  await paintBlackSquare(page, [20, 20], [60, 60]);
  await paintBlackSquare(page, [120, 120], [160, 160]);

  await page.keyboard.press('w');
  const toolbar = page.getByRole('toolbar', { name: 'Tools' });
  await expect(toolbar).toHaveAttribute('data-active-tool', 'quickSelection');
  await page.keyboard.press('Shift+W');
  await expect(toolbar).toHaveAttribute('data-active-tool', 'magicWand');

  await clickDoc(page, 40, 40);
  await expect(page.locator('.history-row').last()).toHaveText('Magic Wand');
  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 40, 40)).toEqual([0, 0, 0, 0]);
  await expect.poll(() => sample(page, 140, 140)).toEqual([0, 0, 0, 255]); // untouched by the first (contiguous) wand click

  await clickDoc(page, 140, 140, { shift: true });
  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 140, 140)).toEqual([0, 0, 0, 0]);
  await expect.poll(() => sample(page, 100, 100)).toEqual([255, 255, 255, 255]); // background never touched
  expect(errors).toEqual([]);
});

test('paint bucket fills a uniform canvas with the foreground color', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 100, 100);
  await page.keyboard.press('d'); // fg black, bg white
  await page.keyboard.press('g');
  const toolbar = page.getByRole('toolbar', { name: 'Tools' });
  await expect(toolbar).toHaveAttribute('data-active-tool', 'gradient');
  await page.keyboard.press('Shift+G');
  await expect(toolbar).toHaveAttribute('data-active-tool', 'bucket');

  await clickDoc(page, 50, 50);
  await expect(page.locator('.history-row').last()).toHaveText('Paint Bucket');
  await expect.poll(() => sample(page, 5, 5)).toEqual([0, 0, 0, 255]);
  await expect.poll(() => sample(page, 90, 90)).toEqual([0, 0, 0, 255]);
});

test('quick selection stroke on one side of a hard split selects that side', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await paintBlackSquare(page, [0, 0], [100, 200]); // left half black, right half white

  await page.keyboard.press('w');
  await expect(page.getByRole('toolbar', { name: 'Tools' })).toHaveAttribute('data-active-tool', 'quickSelection');
  await dragDoc(page, [20, 50], [20, 150]); // stroke down the middle of the black half
  await expect(page.locator('.history-row').last()).toHaveText('Quick Selection');

  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 20, 100)).toEqual([0, 0, 0, 0]); // inside the stroked half: cleared
  await expect.poll(() => sample(page, 150, 100)).toEqual([255, 255, 255, 255]); // other half: untouched
});

test('magnetic lasso: anchors placed by click, Enter closes and produces a selection', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await page.keyboard.press('l');
  const toolbar = page.getByRole('toolbar', { name: 'Tools' });
  while ((await toolbar.getAttribute('data-active-tool')) !== 'magneticLasso') await page.keyboard.press('Shift+L');

  for (const [x, y] of [[50, 50], [150, 50], [150, 150], [50, 150]] as const) {
    await clickDoc(page, x, y);
    await page.waitForTimeout(75); // let the magnetic_begin/magnetic_path worker round trip settle
  }
  await page.keyboard.press('Enter');
  await expect(page.locator('.history-row').last()).toHaveText('Magnetic Lasso');

  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 100, 100)).toEqual([0, 0, 0, 0]); // inside the traced square: cleared
  await expect.poll(() => sample(page, 5, 5)).toEqual([255, 255, 255, 255]); // outside: untouched
});

test('color range dialog opens and OK selects the shadows on a two-color doc', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await paintBlackSquare(page, [50, 50], [150, 150]);

  await openMenuItem(page, 'Select', 'Color Range');
  await expect(dialog(page)).toBeVisible();
  await dialog(page).locator('select').first().selectOption('shadows');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.history-row').last()).toHaveText('Color Range');

  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 100, 100)).toEqual([0, 0, 0, 0]); // inside the black square: cleared
  await expect.poll(() => sample(page, 10, 10)).toEqual([255, 255, 255, 255]); // white background: untouched
});

test('color range sampled: clicking the preview takes a sample and OK selects that color', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await paintBlackSquare(page, [50, 50], [150, 150]);

  await openMenuItem(page, 'Select', 'Color Range');
  const ok = dialog(page).getByRole('button', { name: 'OK' });
  await expect(ok).toBeDisabled(); // nothing sampled yet
  await dialog(page).locator('canvas.color-range-preview').click(); // center: inside the black square
  await expect(ok).toBeEnabled();
  await ok.click();
  await expect(page.locator('.history-row').last()).toHaveText('Color Range');

  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 100, 100)).toEqual([0, 0, 0, 0]);
  await expect.poll(() => sample(page, 10, 10)).toEqual([255, 255, 255, 255]);
});

test('quick mask mode round trip (Q, Q) leaves the selection mask unchanged', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 100, 100);
  await page.keyboard.press('m');
  await dragDoc(page, [20, 20], [60, 60]);

  const before = await maskBytes(page);
  await page.keyboard.press('q');
  const toolbar = page.getByRole('button', { name: 'Toggle quick mask' });
  await expect(toolbar).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('q');
  await expect(toolbar).toHaveAttribute('aria-pressed', 'false');
  const after = await maskBytes(page);
  expect(after).toEqual(before);
});

test('save selection then load selection restores the same selected region', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 150, 150);
  await page.keyboard.press('d');
  await page.keyboard.press('m');
  await dragDoc(page, [30, 30], [80, 80]);

  await openMenuItem(page, 'Select', 'Save Selection');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.history-row').last()).toHaveText('Save Selection');

  await page.keyboard.press('Control+d');
  await openMenuItem(page, 'Select', 'Load Selection');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.history-row').last()).toHaveText('Load Selection');

  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 55, 55)).toEqual([0, 0, 0, 0]); // inside the restored selection: cleared
  await expect.poll(() => sample(page, 120, 120)).toEqual([255, 255, 255, 255]); // outside: untouched
});

test('Select > Modify > Expand grows the selection bounds', async ({ page }) => {
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.keyboard.press('d');
  await page.keyboard.press('m');
  await dragDoc(page, [50, 50], [100, 100]);

  await openMenuItem(page, 'Select', 'Expand');
  await dialog(page).getByRole('button', { name: 'OK' }).click();
  await expect(page.locator('.history-row').last()).toHaveText('Expand');

  await page.keyboard.press('Delete');
  await expect.poll(() => sample(page, 47, 75)).toEqual([0, 0, 0, 0]); // just outside the original bounds: expanded selection reaches it
  await expect.poll(() => sample(page, 20, 75)).toEqual([255, 255, 255, 255]); // far outside: untouched
});
