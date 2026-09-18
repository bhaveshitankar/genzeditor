// src/editors/mermaid-frame.ts
// Standalone document loaded into a sandboxed, same-origin iframe (src=, NOT srcdoc).
// Because it is served from the Pages origin, the deployed CSP (`script-src 'self'`)
// permits this bundled, locally-imported mermaid — no CDN, fully offline.
import mermaid from 'mermaid';
import { escapeHtml } from './MermaidPreview';

// securityLevel 'strict' makes mermaid HTML-escape/sanitize the diagram source.
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });

let counter = 0;

async function render(source: string): Promise<void> {
  const container = document.getElementById('container');
  if (!container) return;
  try {
    const { svg } = await mermaid.render(`d${counter++}`, source);
    container.innerHTML = svg;
  } catch (err) {
    // Fall back to escaped plain-text so a bad diagram never injects markup.
    container.innerHTML = `<pre>${escapeHtml(String(err))}</pre>`;
  }
}

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as { type?: string; source?: string } | null;
  if (data && data.type === 'render' && typeof data.source === 'string') {
    void render(data.source);
  }
});

// Announce readiness so the embedder can (re)send the latest source.
window.parent.postMessage({ type: 'mermaid-ready' }, '*');
