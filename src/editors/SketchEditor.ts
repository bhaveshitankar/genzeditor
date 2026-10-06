import type { DocEditor } from './registry';

// Self-host Excalidraw's static assets (fonts, locales, vendor chunk) so we
// never reach out to the default unpkg CDN — the app runs under a strict CSP.
// Assets live in public/excalidraw-assets/. Set before the dynamic import below.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/';

type Lib = typeof import('@excalidraw/excalidraw');
type Elements = readonly { isDeleted?: boolean }[];
interface Api {
  getSceneElements(): Elements;
  getAppState(): Record<string, unknown>;
  getFiles(): Record<string, unknown>;
  updateScene(scene: { elements?: readonly unknown[] }): void;
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

    const h = React.createElement;
    // Own menu + welcome screen: the defaults link out to excalidraw.com,
    // Excalidraw+, Discord, GitHub and X.
    const menu = h(MainMenu, null,
      h(MainMenu.DefaultItems.LoadScene),
      h(MainMenu.DefaultItems.SaveToActiveFile),
      h(MainMenu.DefaultItems.Export),
      h(MainMenu.DefaultItems.SaveAsImage),
      h(MainMenu.DefaultItems.ClearCanvas),
      h(MainMenu.Separator),
      h(MainMenu.DefaultItems.ToggleTheme),
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
    ed.root.render(
      h(Excalidraw as unknown as React.FunctionComponent<Record<string, unknown>>, {
        initialData,
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
    return ed;
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
    this.root?.unmount();
    this.root = null;
    this.api = null;
    this.host.innerHTML = '';
  }
}
