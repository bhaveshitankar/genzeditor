import { test, expect } from '@playwright/test';

test('debug: verify file upload and editor loading', async ({ page }) => {
  await page.goto('/');

  // Step 1: Upload markdown file
  console.log('Step 1: Uploading markdown file');
  await page.setInputFiles('input[type=file]', {
    name: 'test.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Test Heading\n\nSome content'),
  });

  await page.waitForTimeout(500);

  // Step 2: Check if file appears in drawer
  console.log('Step 2: Checking file drawer');
  const fileDrawer = page.locator('[data-role="file-drawer"]');
  await expect(fileDrawer).toBeVisible();

  const fileItem = page.locator('[data-role="file-drawer"]').locator('button', { hasText: 'test.md' });
  const fileVisible = await fileItem.isVisible().catch(() => false);
  console.log('File visible in drawer:', fileVisible);

  if (!fileVisible) {
    const drawerText = await fileDrawer.textContent();
    console.log('Drawer content:', drawerText);
  }

  // Step 3: Click file to open
  console.log('Step 3: Clicking file to open editor');
  if (fileVisible) {
    await fileItem.click();
    await page.waitForTimeout(2000); // Give editor time to load
  }

  // Step 4: Check editor host content
  console.log('Step 4: Checking editor host');
  const editorHost = page.locator('[data-role="editor-host"]');
  const html = await editorHost.innerHTML();
  console.log('Editor host HTML length:', html.length);
  console.log('Editor host HTML:', html.substring(0, 200));

  // Step 5: Check for specific editors
  console.log('Step 5: Looking for editor elements');
  const cmEditor = await page.locator('.cm-editor').isVisible().catch(() => false);
  const preview = await page.locator('[data-role="preview"]').isVisible().catch(() => false);
  const mdPreview = await page.locator('.preview-pane').isVisible().catch(() => false);

  console.log('CodeMirror visible:', cmEditor);
  console.log('Preview data-role visible:', preview);
  console.log('Preview pane visible:', mdPreview);

  // Step 6: Check for text editor specifically
  console.log('Step 6: Checking for TextEditor class');
  const hasEditorView = await editorHost.evaluate(el => {
    return {
      hasCodeMirror: !!el.querySelector('.cm-editor'),
      hasMdPreview: !!el.querySelector('[data-role="preview"]'),
      hasPreviewPane: !!el.querySelector('.preview-pane'),
      childCount: el.children.length,
      firstChild: el.children[0]?.className || 'none',
    };
  });

  console.log('Editor host structure:', hasEditorView);

  // At minimum, something should be in the editor host
  expect(hasEditorView.childCount > 0).toBe(true);
});
