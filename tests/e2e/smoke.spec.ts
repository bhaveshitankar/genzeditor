import { test, expect } from '@playwright/test';

test('upload a markdown file and see preview', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header')).toContainText('AnyEdits');
  await page.setInputFiles('input[type=file]', {
    name: 'hello.md', mimeType: 'text/markdown', buffer: Buffer.from('# Hello'),
  });
  await expect(page.locator('[data-role="file-drawer"]')).toContainText('hello.md');
  await page.locator('[data-role="file-drawer"] button', { hasText: 'hello.md' }).click();
  await expect(page.locator('[data-role="preview"]')).toContainText('Hello');
});
