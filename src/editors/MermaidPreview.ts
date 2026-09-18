// src/editors/MermaidPreview.ts
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function buildMermaidFrame(source: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
</head><body><div class="mermaid">${escapeHtml(source)}</div>
<script>mermaid.initialize({startOnLoad:true});</script></body></html>`;
}
export class MermaidPreview {
  private frame: HTMLIFrameElement;
  constructor(host: HTMLElement) {
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.style.width = '100%'; this.frame.style.border = '0';
    host.appendChild(this.frame);
  }
  render(source: string) { this.frame.srcdoc = buildMermaidFrame(source); }
  destroy() { this.frame.remove(); }
}
