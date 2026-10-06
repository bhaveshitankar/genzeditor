import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';

const D = '/tmp/vidtest';
test.skip(!require('node:fs').existsSync(`${D}/music.m4a`), 'local ffmpeg fixtures in /tmp/vidtest required');
test('video export: split + image + side-by-side + audio clip + text', async ({ page }) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.locator('input[type=file]').first().setInputFiles(`${D}/a.mp4`);
  await page.locator('[data-role="file-drawer"] button', { hasText: 'a.mp4' }).first().click();
  await expect(page.locator('.vt-row.main .vt-clip')).toHaveCount(1, { timeout: 15000 });
  // seek to middle via ruler
  await page.evaluate(() => {
    const r = document.querySelector('.vt-ruler')!.getBoundingClientRect();
    document.querySelector('.vt-ruler')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: r.left + (r.width - 16) / 2, clientY: r.top + 5 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await page.locator('[data-act="split"]').click();
  await expect(page.locator('.vt-row.main .vt-clip')).toHaveCount(2);
  await page.locator('[data-role="clipFile"]').setInputFiles(`${D}/logo.png`);
  await expect(page.locator('.vt-row.main .vt-clip')).toHaveCount(3);
  await page.locator('.vid-tab[data-tab="layout"]').click();
  const ch = page.waitForEvent('filechooser');
  await page.locator('[data-layout="side"]').click();
  await (await ch).setFiles(`${D}/b_noaudio.mp4`);
  await page.locator('[data-role="auFile"]').setInputFiles(`${D}/music.m4a`);
  await page.locator('[data-act="addText"]').click();
  await page.waitForTimeout(500);
  const dl = page.waitForEvent('download', { timeout: 280_000 });
  await page.locator('[data-role="download-btn"]').click();
  const d = await dl; const file = '/tmp/vidtest/out.mp4'; await d.saveAs(file);
  const status = await page.locator('[data-role="status"]').textContent();
  console.log('STATUS:', status, 'ERRORS:', errors);
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file]).toString();
  console.log(out);
  const p = JSON.parse(out);
  expect(p.streams.some((s: any) => s.codec_type === 'audio')).toBe(true);
  expect(Number(p.format.duration)).toBeGreaterThan(8.5);
});
