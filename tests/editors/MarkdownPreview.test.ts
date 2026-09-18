// tests/editors/MarkdownPreview.test.ts
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/editors/MarkdownPreview';

describe('renderMarkdown', () => {
  it('renders headings', () => {
    expect(renderMarkdown('# Hi')).toContain('<h1>Hi</h1>');
  });
  it('strips script tags (XSS)', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
  });
});
