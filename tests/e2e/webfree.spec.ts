import { test, expect } from '@playwright/test';
test('free resize/move, z-order, opacity, embed delete', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?desktop=1'); await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /new/i }).first().click().catch(() => {});
  await page.getByRole('option', { name: /web page/i }).click();
  await page.locator('.btn-confirm').click();
  await page.waitForSelector('.wb-canvas');
  const f = page.frameLocator('.wb-canvas');
  // 3. embed block can be selected and deleted
  await page.locator('.wb-block', { hasText: 'YouTube' }).click();
  await expect(f.locator('iframe')).toHaveCount(1);
  await page.locator('.wb-float button[title="Delete"]').click();
  await expect(f.locator('iframe')).toHaveCount(0);
  // embed selectable by clicking it
  await page.locator('.wb-block', { hasText: 'YouTube' }).click();
  await page.locator('.wb-block', { hasText: 'Paragraph' }).click(); // moves selection
  const box = await f.locator('iframe').boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.locator('.wb-ins-head', { hasText: 'iframe' })).toBeVisible();
  await page.keyboard.press('Delete');
  await expect(f.locator('iframe')).toHaveCount(0);
  // 1. free resize with handle
  await f.locator('h1').first().click();
  const before = await f.locator('h1').first().boundingBox();
  const h = await page.locator('.wb-selbox i[data-h="e"]').boundingBox();
  await page.mouse.move(h!.x + 5, h!.y + 5); await page.mouse.down(); await page.mouse.move(h!.x - 95, h!.y + 5, { steps: 5 }); await page.mouse.up();
  const after = await f.locator('h1').first().boundingBox();
  expect(after!.width).toBeLessThan(before!.width - 50);
  // free move
  const mv = await page.locator('.wb-float button[title^="Drag to place"]').boundingBox();
  const b0 = await f.locator('h1').first().boundingBox();
  await page.mouse.move(mv!.x + 5, mv!.y + 5); await page.mouse.down(); await page.mouse.move(mv!.x + 45, mv!.y + 35, { steps: 5 }); await page.mouse.up();
  const b1 = await f.locator('h1').first().boundingBox();
  expect(b1!.x - b0!.x).toBeGreaterThan(30);
  // 2. z-index + opacity
  await page.locator('.wb-float button[title="Bring to front"]').click();
  const op = page.locator('.wb-field:has-text("Opacity") input[type="number"]');
  await op.fill('40'); await op.dispatchEvent('change');
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const code = await page.locator('.cm-content').innerText();
  expect(code).toMatch(/z-index: \d+/);
  expect(code).toContain('opacity: 0.4');
  expect(code).toContain('left:');
  expect(code).not.toContain('data-gz');
});
