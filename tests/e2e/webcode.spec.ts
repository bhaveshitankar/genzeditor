import { test, expect } from '@playwright/test';
test('design: CSS/JS blocks, behaviors, live toggle', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto('/?desktop=1'); await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /new/i }).first().click().catch(() => {});
  await page.getByRole('option', { name: /web page/i }).click();
  await page.locator('.btn-confirm').click();
  await page.waitForSelector('.wb-canvas');
  await page.locator('.wb-snippets').selectOption('reveal');
  await expect(page.locator('.wb-codechip')).toHaveCount(3); // template css + reveal css + reveal js
  await page.locator('.wb-codechip', { hasText: 'JS' }).click();
  const ta = page.locator('.wb-inspector textarea.wb-code');
  await ta.fill('console.log("hi");'); await ta.dispatchEvent('change');
  await page.locator('.wb-block', { hasText: '+ CSS' }).click();
  await expect(page.locator('.wb-codechip')).toHaveCount(4);
  await page.locator('[data-act="live"]').click();
  await expect(page.locator('.wb-livepage')).toHaveCount(1);
  await page.locator('[data-act="live"]').click();
  await expect(page.locator('.wb-livepage')).toHaveCount(0);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const code = await page.locator('.cm-content').innerText();
  expect(code).toContain('console.log("hi");');
  expect(code).not.toContain('data-gz');
});
