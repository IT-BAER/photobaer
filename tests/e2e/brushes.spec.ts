import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { descriptor, sampSection, writeAbrV6, type DV } from '../../app/src/brushes/abrWriter.testutil.ts';

type Photobaer = { photobaer: { viewer: { docToScreen(x: number, y: number): [number, number] }; client: { call: (op: string, ...a: unknown[]) => Promise<unknown> } } };

const pct = (v: number): DV => ['UntF', '#Prc', v];
const obj = (cls: string, items: [string, DV][]): DV => ['Objc', cls, items];
const TIP_ID = 'aaaaaaaa-bbbb-cccc-dddd-000000000042';

// A v6 ABR with one sampled tip (a solid 16 x 16 square) and one preset using it.
function abrFile(): string {
  const bytes = writeAbrV6([
    ['samp', sampSection([{ id: TIP_ID, bitmap: { w: 16, h: 16, depth: 8, compression: 0, samples: Array(256).fill(255) } }])],
    ['desc', descriptor('null', [['Brsh', ['VlLs', [obj('brushPreset', [
      ['Nm  ', ['TEXT', 'E2E Charcoal']],
      ['Brsh', obj('sampledBrush', [['Dmtr', ['UntF', '#Pxl', 24]], ['Spcn', pct(10)], ['sampledData', ['TEXT', TIP_ID]]])],
    ])]]]])],
  ]);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/e2e-brushes.abr', bytes);
  writeFileSync('test-results/e2e-corrupt.abr', bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  return 'test-results/e2e-brushes.abr';
}

async function newDoc(page: Page, w: number, h: number) {
  await page.getByRole('button', { name: 'New image' }).click();
  await page.locator('input[name=w]').fill(String(w));
  await page.locator('input[name=h]').fill(String(h));
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText(`${w} × ${h} px, 8-bit`)).toBeVisible();
  await page.locator('.status').click();
}

async function screenPoint(page: Page, x: number, y: number): Promise<[number, number]> {
  const box = (await page.locator('canvas').first().boundingBox())!;
  const [sx, sy] = await page.evaluate(([x, y]) => (window as unknown as Photobaer).photobaer.viewer.docToScreen(x, y), [x, y]);
  return [box.x + sx, box.y + sy];
}

async function paintLine(page: Page, y: number) {
  const [x0, y0] = await screenPoint(page, 30, y);
  const [x1, y1] = await screenPoint(page, 170, y);
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 12 });
  await page.mouse.up();
}

async function sample(page: Page, x: number, y: number) {
  return page.evaluate(([x, y]) => (window as unknown as Photobaer).photobaer.client.call('sample', x, y, 1, null), [x, y]) as Promise<number[]>;
}

const previewData = (page: Page, id: string) =>
  page.evaluate(i => (document.querySelector(`canvas[data-preview="${i}"]`) as HTMLCanvasElement | null)?.toDataURL() ?? '', id);

test('F5 toggles Brush Settings; enabling size jitter changes the live preview', async ({ page }) => {
  await page.goto('/');
  await page.locator('.status').click();
  await page.keyboard.press('F5');
  const settings = page.locator('.brush-settings');
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Hard Round', exact: true }).click();
  await expect(settings.getByLabel('Enable Shape Dynamics')).toBeEnabled();
  await expect.poll(() => previewData(page, 'settings')).not.toBe('');
  await page.waitForTimeout(300);
  const before = await previewData(page, 'settings');
  await settings.getByLabel('Enable Shape Dynamics').check();
  await settings.getByRole('tab', { name: 'Shape Dynamics' }).click();
  await settings.getByLabel('Size Jitter value').fill('100');
  // Under a loaded two-browser run one Firefox evaluate round trip can take about 2 s; the preview itself lands in ms.
  await expect.poll(() => previewData(page, 'settings'), { timeout: 15_000 }).not.toBe(before);
  await page.locator('.status').click();
  await page.keyboard.press('F5');
  await expect(settings).toHaveCount(0);
});

test('an imported v6 ABR lands in its group and paints; a corrupt one warns and painting still works', async ({ page }) => {
  const file = abrFile();
  await page.goto('/');
  await newDoc(page, 200, 200);
  await page.getByRole('button', { name: 'Brushes', exact: true }).click();
  const panel = page.locator('.brushes-panel');
  await panel.locator('input[type=file]').setInputFiles(file);
  await expect(panel.locator('.brush-banner')).toContainText('Loaded 1 brush');
  const row = panel.locator('.brush-group[data-group="Dry Media"]').getByRole('button', { name: 'E2E Charcoal' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.status').click();
  await page.keyboard.press('b');
  await paintLine(page, 60);
  await expect.poll(() => sample(page, 100, 60)).not.toEqual([255, 255, 255, 255]);

  await panel.locator('input[type=file]').setInputFiles('test-results/e2e-corrupt.abr');
  await expect(panel.locator('.brush-banner')).toBeVisible();
  await expect(panel.locator('.brush-banner summary')).toContainText('Import warnings');
  await page.locator('.status').click();
  await paintLine(page, 140);
  await expect.poll(() => sample(page, 100, 140)).not.toEqual([255, 255, 255, 255]);
});

test('Delete Brush from the context menu removes a preset and it stays deleted after reload', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Brushes', exact: true }).click();
  const list = page.locator('.brush-list');
  await expect(list.getByRole('button', { name: 'Stipple' })).toBeVisible();
  await list.getByRole('button', { name: 'Stipple' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Delete Brush' }).click();
  await expect(list.getByRole('button', { name: 'Stipple' })).toHaveCount(0);
  await page.waitForTimeout(600); // the library writes 250 ms after the last change
  await page.reload();
  await page.getByRole('button', { name: 'Brushes', exact: true }).click();
  await expect(list.getByRole('button', { name: 'Hard Round', exact: true })).toBeVisible();
  await expect(list.getByRole('button', { name: 'Stipple' })).toHaveCount(0);
});
