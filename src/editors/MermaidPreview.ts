// src/editors/MermaidPreview.ts
//
// Mermaid renders inside a sandboxed, SAME-ORIGIN iframe loaded via `src=`
// (never `srcdoc`). A srcdoc frame inherits the embedder's CSP, so the deployed
// `script-src 'self'` would block any script. A real same-origin iframe URL is
// governed by its own CSP from public/_headers where `script-src 'self'` +
// `frame-src 'self'` permit the locally-bundled mermaid — no CDN, fully offline.
//
// Isolation is preserved: sandbox="allow-scripts" WITHOUT allow-same-origin, so
// the framed mermaid runs in an opaque origin with no access to app storage/DOM.
// The user's source is delivered by postMessage and rendered with mermaid's
// securityLevel 'strict' (HTML-escaped/sanitized) inside the frame.

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Same-origin URL of the standalone frame document (built by Vite as a second
// HTML entry). Absolute path so it resolves regardless of the current route.
export const MERMAID_FRAME_URL = '/mermaid-frame.html';

export class MermaidPreview {
  private frame: HTMLIFrameElement;
  private ready = false;
  private pending?: string;

  constructor(host: HTMLElement) {
    this.frame = document.createElement('iframe');
    // NO allow-same-origin: keep the frame in an opaque origin.
    this.frame.setAttribute('sandbox', 'allow-scripts');
    this.frame.style.width = '100%';
    this.frame.style.border = '0';
    this.frame.src = MERMAID_FRAME_URL;
    window.addEventListener('message', this.onMessage);
    host.appendChild(this.frame);
  }

  private onMessage = (e: MessageEvent) => {
    if (e.source !== this.frame.contentWindow) return;
    const data = e.data as { type?: string } | null;
    if (data && data.type === 'mermaid-ready') {
      this.ready = true;
      if (this.pending !== undefined) this.post(this.pending);
    }
  };

  private post(source: string) {
    this.frame.contentWindow?.postMessage({ type: 'render', source }, '*');
  }

  render(source: string) {
    this.pending = source;
    if (this.ready) this.post(source);
  }

  destroy() {
    window.removeEventListener('message', this.onMessage);
    this.frame.remove();
  }
}
