// Runs a built web page (with its own CSS + JS) in the isolated /site-frame.html
// document. sandbox="allow-scripts" without allow-same-origin => opaque origin.
export class SiteFrame {
  readonly el: HTMLIFrameElement;
  private pending = '';
  private onMsg = (e: MessageEvent) => {
    if (e.source !== this.el.contentWindow || e.data?.type !== 'gz-site-ready') return;
    this.el.contentWindow?.postMessage({ type: 'gz-site', html: this.pending }, '*');
  };
  constructor(host: HTMLElement, title = 'Page preview') {
    this.el = document.createElement('iframe');
    this.el.setAttribute('sandbox', 'allow-scripts allow-popups');
    this.el.title = title;
    this.el.style.background = '#fff';
    host.appendChild(this.el);
    window.addEventListener('message', this.onMsg);
  }
  show(html: string): void {
    this.pending = html;
    this.el.src = `/site-frame.html?t=${Date.now()}`;
  }
  destroy(): void { window.removeEventListener('message', this.onMsg); this.el.remove(); }
}
