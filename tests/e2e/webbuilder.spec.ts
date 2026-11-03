import { test, expect } from '@playwright/test';

test('website builder: design, add block, drag, inspector, code sync', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?desktop=1');
  await page.waitForTimeout(1500);
  // create new web page via the New file modal
  await page.evaluate(() => (document.querySelector('[data-role="new-file"], .new-file-btn') as HTMLElement | null)?.click());
  const newBtn = page.getByRole('button', { name: /new/i }).first();
  await newBtn.click().catch(() => {});
  await page.getByRole('option', { name: /web page/i }).click();
  await page.locator('.btn-confirm').click();
  await page.waitForSelector('.wb-canvas', { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: '/tmp/wbtest/1-design.png' });

  const frame = page.frameLocator('.wb-canvas');
  await frame.locator('h1').first().click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/tmp/wbtest/2-selected.png' });
  // add a block via click
  await page.locator('.wb-block', { hasText: 'Footer' }).click();
  // drag Testimonial into the page
  const src = page.locator('.wb-block', { hasText: 'Testimonial' });
  const box = await frame.locator('.card').first().boundingBox();
  await src.dragTo(page.locator('.wb-canvas'), { targetPosition: { x: 300, y: 200 } });
  await page.waitForTimeout(300);
  const n = await frame.locator('section, footer').count();
  console.log('top-level blocks', n);
  // style via inspector
  await frame.locator('h1').first().click();
  await page.locator('.wb-field:has-text("Size") input').first().fill('64');
  await page.locator('.wb-field:has-text("Size") input').first().dispatchEvent('change');
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/wbtest/3-edited.png' });
  // code view reflects changes
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const code = await page.locator('.cm-content').innerText();
  expect(code).toContain('font-size: 64px');
  expect(code).toContain('Made with genzeditor.com');
  // preview runs
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: '/tmp/wbtest/4-preview.png' });
  console.log('errors', errors);
});
