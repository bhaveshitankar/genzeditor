import { test, expect } from '@playwright/test';

test('debug: CodeMirror find functionality', async ({ page }) => {
  await page.goto('/');

  // Upload and open code file
  await page.setInputFiles('input[type=file]', {
    name: 'test.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from('function hello() {\n  console.log("Hello World");\n}'),
  });

  await page.waitForTimeout(500);

  const fileItem = page.locator('[data-role="file-drawer"]').locator('button', { hasText: 'test.js' });
  const fileVisible = await fileItem.isVisible();
  console.log('File visible:', fileVisible);

  if (fileVisible) {
    await fileItem.click();
    await page.waitForTimeout(2000);

    // Check if editor loaded
    const editor = page.locator('.cm-editor');
    const editorVisible = await editor.isVisible();
    console.log('Editor visible:', editorVisible);

    if (editorVisible) {
      // Click in editor to focus
      await editor.click();
      await page.waitForTimeout(300);

      // Try to open find with Ctrl+F
      console.log('Pressing Ctrl+F to open find');
      await page.keyboard.press('Control+F');
      await page.waitForTimeout(500);

      // Look for search panel
      const searchPanel = page.locator('.cm-search');
      const searchInput = page.locator('.cm-searchfield');
      const findInput = page.locator('input[placeholder*="find"], input[placeholder*="Find"]');

      const hasSearch = await searchPanel.isVisible().catch(() => false);
      const hasInput = await searchInput.isVisible().catch(() => false);
      const hasFindInput = await findInput.isVisible().catch(() => false);

      console.log('Search panel visible:', hasSearch);
      console.log('Search input visible:', hasInput);
      console.log('Find input visible:', hasFindInput);

      // Count all inputs to see what's there
      const allInputs = await page.locator('input').count();
      console.log('Total inputs on page:', allInputs);

      // Check editor parent for any new elements
      const editorParent = page.locator('[data-role="editor-host"]');
      const parentHtml = await editorParent.innerHTML();
      const hasFindUI = parentHtml.includes('cm-search') || parentHtml.includes('find');
      console.log('Find UI in editor host HTML:', hasFindUI);
    }
  }
});
