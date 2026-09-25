import { test, expect } from '@playwright/test';

test('layers and history panels: create, edit, reorder and time travel', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('/');

  await page.getByRole('button', { name: 'New image' }).click();
  await page.getByRole('button', { name: 'Create' }).click();

  await page.getByRole('button', { name: 'New layer' }).click();
  await expect(page.locator('.layers-tree .name')).toHaveText(['Layer 1', 'Background']);
  await expect(page.getByRole('treeitem', { name: 'Layer 1' })).toHaveAttribute('aria-selected', 'true');

  await page.getByRole('combobox', { name: 'Blend mode' }).selectOption('multiply');
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.getByText('Undo Blend Mode')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Hide Layer 1' }).click();
  await expect(page.getByRole('button', { name: 'Show Layer 1' })).toBeVisible();

  const layer1Row = page.getByRole('treeitem', { name: 'Layer 1' });
  await layer1Row.locator('.name').dblclick();
  await page.locator('.rename').fill('Top');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('treeitem', { name: 'Top' })).toBeVisible();

  const bgRow = page.getByRole('treeitem', { name: 'Background' });
  const topRow = page.getByRole('treeitem', { name: 'Top' });
  await bgRow.dragTo(topRow, { targetPosition: { x: 10, y: 2 } });
  await expect(page.locator('.layers-tree .name')).toHaveText(['Background', 'Top']);

  await page.getByRole('option', { name: 'Initial state' }).click();
  await expect(page.locator('.layers-tree .name')).toHaveText(['Background']);
  await expect(page.locator('.history-row.dimmed')).toHaveCount(await page.locator('.history-row').count() - 1);

  await page.getByRole('option').last().click();
  await expect(page.locator('.layers-tree .name')).toHaveText(['Background', 'Top']);

  await page.getByRole('button', { name: 'Add layer mask' }).click();
  await expect(page.locator('.mask-chip')).toBeVisible();
  await page.locator('.mask-chip').click();

  await page.getByRole('button', { name: 'Image' }).click();
  await page.getByText('Invert').click();
  await expect(page.getByRole('option', { name: 'Invert' })).toBeVisible();

  expect(errors).toEqual([]);
});
