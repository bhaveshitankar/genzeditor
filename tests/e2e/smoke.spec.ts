import { test, expect } from '@playwright/test';

test('upload a markdown file and see preview', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header')).toContainText('GenZ Editor');
  await page.setInputFiles('input[type=file]', {
    name: 'hello.md', mimeType: 'text/markdown', buffer: Buffer.from('# Hello'),
  });
  await expect(page.locator('[data-role="file-drawer"]')).toContainText('hello.md', { timeout: 10000 });
  await page.locator('[data-role="file-drawer"] button', { hasText: 'hello.md' }).click();
  await expect(page.locator('[data-role="preview"], .cm-editor')).toBeVisible({ timeout: 10000 });
});
