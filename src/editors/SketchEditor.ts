import type { DocEditor } from './registry';

// Self-host Excalidraw's static assets (fonts, locales, vendor chunk) so we
// never reach out to the default unpkg CDN — the app runs under a strict CSP
// that forbids external script/font origins. Assets live in
// public/excalidraw-assets/, and Excalidraw resolves them from
// `${EXCALIDRAW_ASSET_PATH}excalidraw-assets/…`, so the base path is '/'.
// Set at module load, before the library is dynamically imported below.
(window as unknown as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/';

// Minimal shape of an Excalidraw scene file (.excalidraw). We keep it loose on
// purpose: the elements/appState/files payloads are large, evolving structs we
// only ever round-trip verbatim.
interface ExcalidrawScene {
  elements?: readonly unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
}

// Rich "Sketch" editor: the real Excalidraw canvas mounted as a lazy-loaded
// React island inside a plain DOM host. React + Excalidraw are imported inside
// open() so they land in a code-split chunk and never bloat the main bundle.
// Files round-trip as Excalidraw scene JSON (.excalidraw).
export class SketchEditor implements DocEditor {
  private host: HTMLElement;
  // react-dom Root; typed loosely since react-dom/client is imported dynamically.
  private root: { render(node: unknown): void; unmount(): void } | null = null;
  // Latest scene captured from Excalidraw's onChange, used as the export source.
  private elements: readonly unknown[] = [];
  private appState: Record<string, unknown> = {};
  private files: Record<string, unknown> = {};
  // Excalidraw imperative API (getSceneElements/getAppState/getFiles), if ready.
  private api: {
    getSceneElements?: () => readonly unknown[];
    getAppState?: () => Record<string, unknown>;
    getFiles?: () => Record<string, unknown>;
  } | null = null;

  private constructor(host: HTMLElement) {
    this.host = host;
  }

  static async open(host: HTMLElement, blob: Blob, onChange?: () => void): Promise<SketchEditor> {
    const ed = new SketchEditor(host);

    // Lazy-load the heavy deps so they only enter a separate chunk.
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    // v0.17 injects its own stylesheet at runtime (no separate CSS entrypoint),
    // so importing the module is enough to style the UI. The inline <style> it
    // adds is permitted by our style-src 'unsafe-inline' CSP directive.
    const { Excalidraw } = await import('@excalidraw/excalidraw');

    // Parse the incoming scene. Empty/zero-byte or malformed blobs start blank.
    let initialData: ExcalidrawScene | undefined;
    if (blob.size > 0) {
      try {
        const parsed = JSON.parse(await blob.text()) as ExcalidrawScene;
        initialData = {
          elements: parsed.elements ?? [],
          appState: parsed.appState ?? {},
          files: parsed.files ?? {},
        };
        ed.elements = initialData.elements ?? [];
        ed.appState = initialData.appState ?? {};
        ed.files = initialData.files ?? {};
      } catch {
        initialData = undefined;
      }
    }

    // Excalidraw needs a sized parent; the host (.doc-body) flexes, so a wrapper
    // that fills it guarantees the canvas gets a resolved height on all screens.
    const wrapper = document.createElement('div');
    wrapper.className = 'sketch-host';
    wrapper.style.height = '100%';
    wrapper.style.width = '100%';
    host.appendChild(wrapper);

    ed.root = createRoot(wrapper);
    ed.root.render(
      React.createElement(Excalidraw as unknown as React.FunctionComponent<Record<string, unknown>>, {
        initialData,
        // Capture the imperative API so export() can read the live scene even if
        // onChange hasn't fired since the last mutation.
        excalidrawAPI: (api: unknown) => {
          ed.api = api as typeof ed.api;
        },
        // Fires on every scene mutation: cache the latest scene, then hand off to
        // the app's autosave (already debounced by the shell).
        onChange: (
          elements: readonly unknown[],
          appState: Record<string, unknown>,
          files: Record<string, unknown>,
        ) => {
          ed.elements = elements;
          ed.appState = appState;
          ed.files = files;
          onChange?.();
        },
      }),
    );

    return ed;
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    // Prefer the live imperative API; fall back to the last onChange snapshot.
    const elements = this.api?.getSceneElements?.() ?? this.elements;
    const appState = this.api?.getAppState?.() ?? this.appState;
    const files = this.api?.getFiles?.() ?? this.files;
    const scene = {
      type: 'excalidraw',
      version: 2,
      source: 'anyedits',
      elements,
      appState,
      files,
    };
    return {
      blob: new Blob([JSON.stringify(scene)], { type: 'application/json' }),
      contentType: 'application/json',
    };
  }

  destroy(): void {
    this.root?.unmount();
    this.root = null;
    this.api = null;
    this.host.innerHTML = '';
  }
}
