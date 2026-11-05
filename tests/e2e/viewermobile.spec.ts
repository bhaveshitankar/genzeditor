import { test } from '@playwright/test';
test.use({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
test('viewer mobile footer', async ({ page }) => {
  await page.goto('/#s=7cYhDQAgEABAT4rf8OTAk-EdDIMgPgQ5dzV6zrlLGXtlnLynBSIiIiIiIiIifj4&ct=text%2Fmarkdown');
  await page.waitForSelector('.viewer-prose'); await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/wbtest/v1.png' });
  await page.goto('about:blank');
  await page.goto('/#s=s1F08XcOiQxwVcgoyc2xs4GQSfkplQrFJZU5qbZKuYlF6Zl5VgbWSYnJ2elF-aV5KVbKhkbG1sn5OflFVsppaWlKQH2GMPUFiSkpmXnpViYGBRVKdgGJ6ak2-hmGdjYpmWUwJRmpmekZJVZGBgZgNTb6QDkgCbIVSIGdAAA&ct=text%2Fhtml');
  await page.reload(); await page.waitForSelector('.viewer-overlay'); await page.waitForTimeout(1500);
  await page.screenshot({ path: '/tmp/wbtest/v2.png' });
});
