// tests/editors/MermaidPreview.test.ts
import { describe, it, expect } from 'vitest';
import { escapeHtml, MermaidPreview, MERMAID_FRAME_URL } from '../../src/editors/MermaidPreview';

describe('MermaidPreview', () => {
  it('escapes HTML in diagram source', () => {
    expect(escapeHtml('graph TD; A-->B')).toBe('graph TD; A--&gt;B');
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('loads mermaid from a same-origin src= frame, never a CDN or srcdoc', () => {
    const host = document.createElement('div');
    const p = new MermaidPreview(host);
    const frame = host.querySelector('iframe')!;
    // Real same-origin src, not srcdoc (srcdoc inherits embedder CSP -> blocked).
    expect(frame.getAttribute('srcdoc')).toBeNull();
    expect(frame.getAttribute('src')).toBe(MERMAID_FRAME_URL);
    // No external hosts referenced anywhere: works under `script-src 'self'`.
    expect(MERMAID_FRAME_URL).not.toMatch(/https?:\/\//);
    expect(MERMAID_FRAME_URL).not.toContain('cdn');
    p.destroy();
  });

  it('creates a sandboxed iframe with allow-scripts but NOT allow-same-origin', () => {
    const host = document.createElement('div');
    const p = new MermaidPreview(host);
    const frame = host.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox') || '').not.toContain('allow-same-origin');
    p.destroy();
  });
});
