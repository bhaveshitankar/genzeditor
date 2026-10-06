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
    container.style.backgroundColor = 'transparent';
  } catch (err) {
    const msg = String(err);
    container.innerHTML = `<div style="padding: 16px; background: #fee; border: 1px solid #fcc; border-radius: 4px; color: #c00; font-family: monospace; font-size: 12px; white-space: pre-wrap; word-break: break-word;"><strong>Error:</strong> ${escapeHtml(msg)}</div>`;
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
