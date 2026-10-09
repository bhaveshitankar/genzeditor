import type { DocEditor } from './registry';
import './styles/sketch.css';

// Self-host Excalidraw's static assets (fonts, locales, vendor chunk) so we
// never reach out to the default unpkg CDN — the app runs under a strict CSP.
// Assets live in public/excalidraw-assets/. Set before the dynamic import below.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/';

// Excalidraw embeds fonts into exported SVGs by fetching `${EXCALIDRAW_ASSET_PATH}Virgil.woff2`
// (i.e. /Virgil.woff2), while its chunk/css loader uses `/excalidraw-assets/…`. Our assets only
// live under /excalidraw-assets/, so the SPA fallback would serve HTML for the root font URLs
// and SVG export would break. Redirect those few requests.
const FONT_RE = /^\/(Virgil|Cascadia|Assistant-(?:Regular|Medium|SemiBold|Bold))\.woff2$/;
if (!(window as unknown as { __skFontShim?: boolean }).__skFontShim) {
  (window as unknown as { __skFontShim?: boolean }).__skFontShim = true;
  const orig = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(raw, location.href);
      if (u.origin === location.origin && FONT_RE.test(u.pathname)) {
        return orig('/excalidraw-assets' + u.pathname, init);
      }
    } catch { /* fall through */ }
    return orig(input, init);
  }) as typeof window.fetch;
}

type Lib = typeof import('@excalidraw/excalidraw');
type Elements = readonly { isDeleted?: boolean }[];
interface Api {
  getSceneElements(): Elements;
  getAppState(): Record<string, unknown>;
  getFiles(): Record<string, unknown>;
  updateScene(scene: { elements?: readonly unknown[] }): void;
}

function isDarkUi(): boolean {
  const cs = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  const m = /^#([0-9a-f]{6})$/i.exec(cs);
  if (m) {
    const n = parseInt(m[1]!, 16);
    const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum < 0.5;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

const isCoarse = () => window.matchMedia('(pointer: coarse)').matches;

// Reliable save: Web Share (files) on touch devices where supported, else <a download>.
async function saveBlob(blob: Blob, name: string, preferShare = isCoarse()): Promise<void> {
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (preferShare && nav.share && nav.canShare) {
    const file = new File([blob], name, { type: blob.type });
    if (nav.canShare({ files: [file] })) {
      try { await nav.share({ files: [file], title: name }); return; }
      catch (e) { if ((e as Error).name === 'AbortError') return; }
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}

// Rich "Sketch" editor: Excalidraw mounted as a lazy-loaded React island.
// Files round-trip as Excalidraw scene JSON (.excalidraw).
export class SketchEditor implements DocEditor {
  private host: HTMLElement;
  private root: { render(node: unknown): void; unmount(): void } | null = null;
  private lib: Lib | null = null;
  private api: Api | null = null;
  // Last scene seen in onChange; export source if the API isn't ready yet.
  private elements: Elements = [];
  private appState: Record<string, unknown> = {};
  private files: Record<string, unknown> = {};
  private sceneVersion = -1;
  private fileCount = 0;
  private dark = false;
  private rerender: (() => void) | null = null;
  private themeObs: MutationObserver | null = null;
  private mq: MediaQueryList | null = null;
  private fab: HTMLElement | null = null;
  private toastEl: HTMLElement | null = null;
  private toastTimer = 0;

  private constructor(host: HTMLElement) {
    this.host = host;
  }

  /** Current scene elements as JSON (for AI context). */
  getSceneJson(): string {
    return JSON.stringify({ elements: this.api?.getSceneElements() ?? this.elements });
  }

  /** Replace the scene from AI-generated JSON (elements array or {elements}). */
  applyAiScene(json: string): string {
    const data = JSON.parse(json) as { elements?: unknown[] } | unknown[];
    const raw = Array.isArray(data) ? data : (data.elements ?? []);
    const elements = this.lib ? this.lib.restoreElements(raw as never, null) : raw;
    this.api?.updateScene({ elements });
    this.elements = elements as Elements;
    return `set ${elements.length} element(s)`;
  }

  static async open(host: HTMLElement, blob: Blob, onChange?: () => void): Promise<SketchEditor> {
    const ed = new SketchEditor(host);
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const lib = await import('@excalidraw/excalidraw');
    ed.lib = lib;
    const { Excalidraw, MainMenu, WelcomeScreen, restore, getSceneVersion } = lib;

    // restore() normalizes elements and rebuilds appState from defaults, dropping
    // runtime-only fields (e.g. collaborators Map) that break a raw JSON reload.
    let initialData: ReturnType<typeof restore> | undefined;
    if (blob.size > 0) {
      try {
        const parsed = JSON.parse(await blob.text()) as { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
        const appState = { ...(parsed.appState ?? {}) };
        delete appState.collaborators;
        initialData = restore({ elements: parsed.elements ?? [], appState, files: parsed.files ?? {} } as never, null, null);
        ed.elements = initialData.elements as Elements;
        ed.appState = initialData.appState as Record<string, unknown>;
        ed.files = (initialData.files ?? {}) as Record<string, unknown>;
        ed.sceneVersion = getSceneVersion(initialData.elements);
        ed.fileCount = Object.keys(ed.files).length;
      } catch {
        initialData = undefined;
      }
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'sketch-host';
    wrapper.style.height = '100%';
    wrapper.style.width = '100%';
    host.appendChild(wrapper);

    ed.dark = isDarkUi();
    const h = React.createElement;
    const item = (label: string, fn: () => void) =>
      h(MainMenu.Item as unknown as React.FunctionComponent<Record<string, unknown>>, { onSelect: fn }, label);
    // Own menu + welcome screen: the defaults link out to excalidraw.com,
    // Excalidraw+, Discord, GitHub and X.
    const menu = h(MainMenu, null,
      h(MainMenu.DefaultItems.LoadScene),
      item('Save as .excalidraw', () => void ed.saveScene()),
      item('Export PNG', () => void ed.exportImage('png')),
      item('Export SVG', () => void ed.exportImage('svg')),
      item('Copy as PNG', () => void ed.copyPng()),
      item('Share…', () => void ed.share()),
      h(MainMenu.DefaultItems.ClearCanvas),
      h(MainMenu.Separator),
      h(MainMenu.DefaultItems.ChangeCanvasBackground),
    );
    const welcome = h(WelcomeScreen, null,
      h(WelcomeScreen.Hints.MenuHint),
      h(WelcomeScreen.Hints.ToolbarHint),
      h(WelcomeScreen.Center, null,
        h(WelcomeScreen.Center.Heading, null, 'Start drawing — your sketch saves automatically.'),
        h(WelcomeScreen.Center.Menu, null, h(WelcomeScreen.Center.MenuItemLoadScene)),
      ),
    );

    ed.root = createRoot(wrapper);
    const draw = () => ed.root?.render(
      h(Excalidraw as unknown as React.FunctionComponent<Record<string, unknown>>, {
        initialData: initialData ?? { appState: { currentItemStrokeColor: '#f02b73', currentItemBackgroundColor: 'transparent' } },
        theme: ed.dark ? 'dark' : 'light',
        langCode: 'en',
        UIOptions: { canvasActions: { toggleTheme: false, export: false, saveAsImage: false, saveToActiveFile: false, loadScene: true } },
        excalidrawAPI: (api: unknown) => { ed.api = api as Api; },
        // onChange fires on every pointer move, scroll and selection change. Only
        // cache + autosave when the drawing itself (elements/images) changed.
        onChange: (elements: Elements, appState: Record<string, unknown>, files: Record<string, unknown>) => {
          ed.appState = appState;
          const v = getSceneVersion(elements as never);
          const fc = Object.keys(files).length;
          if (v === ed.sceneVersion && fc === ed.fileCount) return;
          ed.sceneVersion = v;
          ed.fileCount = fc;
          ed.elements = elements;
          ed.files = files;
          onChange?.();
        },
      }, menu, welcome),
    );
    draw();
    ed.rerender = draw;

    // Keep Excalidraw's theme in step with the app theme (data-theme / OS scheme).
    const sync = () => {
      const d = isDarkUi();
      if (d !== ed.dark) { ed.dark = d; draw(); }
    };
    ed.themeObs = new MutationObserver(sync);
    ed.themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    ed.mq = window.matchMedia('(prefers-color-scheme: dark)');
    ed.mq.addEventListener('change', sync);
    ed.buildFab(wrapper);
    return ed;
  }

  // ---- Reliable export helpers (don't depend on Excalidraw's built-in dialog) ----
  private scene() {
    const elements = (this.api?.getSceneElements() ?? this.elements).filter((e) => !e.isDeleted);
    const appState = { ...(this.api?.getAppState() ?? this.appState) } as Record<string, unknown>;
    const files = (this.api?.getFiles() ?? this.files) as Record<string, unknown>;
    return { elements, appState, files };
  }

  private toast(msg: string): void {
    if (!this.toastEl) return;
    this.toastEl.textContent = msg;
    this.toastEl.style.display = 'block';
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { if (this.toastEl) this.toastEl.style.display = 'none'; }, 2500);
  }

  private async render(kind: 'png' | 'svg'): Promise<Blob> {
    if (!this.lib) throw new Error('not ready');
    const { elements, appState, files } = this.scene();
    if (elements.length === 0) throw new Error('Nothing to export yet');
    const opts = {
      elements: elements as never,
      appState: { ...appState, exportBackground: true, exportWithDarkMode: false, exportEmbedScene: kind === 'png' } as never,
      files: files as never,
      exportPadding: 24,
    };
    if (kind === 'png') return this.lib.exportToBlob({ ...opts, mimeType: 'image/png', getDimensions: (w, h) => ({ width: w * 2, height: h * 2, scale: 2 }) });
    const svg = await this.lib.exportToSvg(opts);
    return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
  }

  /** Rendered image of the sketch (PNG or SVG) — usable by the app's Download action. */
  async exportImageBlob(kind: 'png' | 'svg' = 'png'): Promise<{ blob: Blob; contentType: string }> {
    const blob = await this.render(kind);
    return { blob, contentType: blob.type };
  }

  async exportImage(kind: 'png' | 'svg'): Promise<void> {
    try {
      await saveBlob(await this.render(kind), `sketch.${kind}`);
      this.toast(`Exported ${kind.toUpperCase()}`);
    } catch (e) { this.toast((e as Error).message || 'Export failed'); }
  }

  async copyPng(): Promise<void> {
    try {
      const p = this.render('png');
      const CI = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
      if (!CI || !navigator.clipboard?.write) throw new Error('unsupported');
      await navigator.clipboard.write([new CI({ 'image/png': p })]); // promise form keeps Safari's user gesture
      this.toast('Copied to clipboard');
    } catch (e) {
      if ((e as Error).message === 'Nothing to export yet') { this.toast('Nothing to copy yet'); return; }
      this.toast('Copy not supported here — downloading PNG');
      void this.exportImage('png');
    }
  }

  async saveScene(): Promise<void> {
    try {
      const out = await this.export();
      if (out) { await saveBlob(out.blob, 'sketch.excalidraw', false); this.toast('Saved sketch.excalidraw'); }
    } catch { this.toast('Save failed'); }
  }

  async share(): Promise<void> {
    try {
      await saveBlob(await this.render('png'), 'sketch.png', true);
    } catch (e) { this.toast((e as Error).message || 'Share failed'); }
  }

  private buildFab(wrapper: HTMLElement): void {
    const fab = document.createElement('div');
    fab.className = 'sk-fab';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sk-btn';
    btn.textContent = 'Export';
    btn.setAttribute('aria-label', 'Export sketch');
    const menu = document.createElement('div');
    menu.className = 'sk-menu';
    const add = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sk-item';
      b.textContent = label;
      b.addEventListener('click', () => { fab.classList.remove('open'); fn(); });
      menu.appendChild(b);
    };
    add('Download PNG', () => void this.exportImage('png'));
    add('Download SVG', () => void this.exportImage('svg'));
    add('Copy as PNG', () => void this.copyPng());
    add('Share image…', () => void this.share());
    add('Save .excalidraw', () => void this.saveScene());
    btn.addEventListener('click', () => fab.classList.toggle('open'));
    fab.append(btn, menu);
    // Stop pointer events reaching the canvas underneath.
    for (const ev of ['pointerdown', 'wheel']) fab.addEventListener(ev, (e) => e.stopPropagation());
    const toast = document.createElement('div');
    toast.className = 'sk-toast';
    toast.style.display = 'none';
    wrapper.append(fab, toast);
    this.fab = fab;
    this.toastEl = toast;
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    const elements = this.api?.getSceneElements() ?? this.elements;
    const appState = this.api?.getAppState() ?? this.appState;
    const files = this.api?.getFiles() ?? this.files;
    // serializeAsJSON writes only persistable appState and drops deleted elements.
    const json = this.lib
      ? this.lib.serializeAsJSON(elements as never, appState as never, files as never, 'local')
      : JSON.stringify({ type: 'excalidraw', version: 2, source: 'anyedits', elements, appState: {}, files });
    return { blob: new Blob([json], { type: 'application/json' }), contentType: 'application/json' };
  }

  destroy(): void {
    this.themeObs?.disconnect();
    this.mq = null;
    clearTimeout(this.toastTimer);
    this.root?.unmount();
    this.root = null;
    this.api = null;
    this.host.innerHTML = '';
  }
}
