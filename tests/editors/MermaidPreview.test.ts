// tests/editors/MermaidPreview.test.ts
import { describe, it, expect } from 'vitest';
import { buildMermaidFrame, MermaidPreview } from '../../src/editors/MermaidPreview';

describe('MermaidPreview', () => {
  it('embeds the source in the frame document', () => {
    const html = buildMermaidFrame('graph TD; A-->B');
    expect(html).toContain('graph TD; A--&gt;B'); // html-escaped into the container
    expect(html).toContain('mermaid');
  });
  it('creates a sandboxed iframe without same-origin', () => {
    const host = document.createElement('div');
    const p = new MermaidPreview(host);
    p.render('graph TD; A-->B');
    const frame = host.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('sandbox') || '').not.toContain('allow-same-origin');
    p.destroy();
  });
});
