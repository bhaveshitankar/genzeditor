import { test, expect } from '@playwright/test';

// Proves C1: mermaid renders from a locally-bundled, same-origin sandboxed
// iframe (src=, not srcdoc) with no external/CDN request.
test('mermaid renders in a same-origin sandboxed frame, no CDN', async ({ page }) => {
  const external: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://localhost:4173') && !u.startsWith('data:')) external.push(u);
  });

  await page.goto('/');
  await page.setInputFiles('input[type=file]', {
    name: 'diagram.mmd', mimeType: 'text/plain', buffer: Buffer.from('graph TD; A-->B'),
  });
  await page.locator('[data-role="file-drawer"] button', { hasText: 'diagram.mmd' }).click();

  const frame = page.locator('[data-role="preview"] iframe');
  await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
  const src = await frame.getAttribute('src');
  expect(src).toBe('/mermaid-frame.html');

  // Mermaid produces an <svg> inside the frame.
  const svg = page.frameLocator('[data-role="preview"] iframe').locator('svg');
  await expect(svg).toBeVisible({ timeout: 15000 });

  expect(external, `unexpected external requests: ${external.join(', ')}`).toEqual([]);
});
