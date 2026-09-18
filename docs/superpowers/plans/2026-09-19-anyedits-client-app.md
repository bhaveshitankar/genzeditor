# AnyEdits Client App Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a mobile-first, client-only web app that lets a user upload and edit text/code/JSON/Markdown/Mermaid/image files locally (OPFS), deployable to Cloudflare Pages with zero backend.

**Architecture:** A Vite + TypeScript single-page app. Files are held in the browser's Origin Private File System (OPFS) as the working copy. A router picks an editor component by detected file type. All editing (CodeMirror for text-family, Canvas for images, Mermaid/Markdown preview) runs client-side. No network calls in this plan.

**Tech Stack:** Vite, TypeScript, CodeMirror 6, `mermaid`, `marked` + `dompurify`, vanilla DOM components (no heavy framework), Vitest + jsdom for tests, Playwright for one smoke e2e, `wrangler pages` for deploy.

**Spec:** `docs/superpowers/specs/2026-09-19-anyedits-first-slice-design.md`

## Global Constraints

- Mobile-first: all UI must be usable at 360px width; touch targets ≥ 44px.
- Accessibility: every interactive element has an accessible name; keyboard-navigable; ARIA roles on custom widgets.
- No backend calls in this plan — the app must work fully offline.
- Client-side only: never render uploaded HTML/SVG inline in the app origin; Markdown output sanitized with DOMPurify; Mermaid rendered inside a sandboxed `<iframe sandbox>`.
- Single-file soft cap for local editing: 500MB (reject larger with a clear message).
- TypeScript strict mode on. TDD: test before implementation. Commit after each task.

---

## File Structure

- `index.html` — app entry, mounts `#app`.
- `src/main.ts` — bootstrap: init OPFS store, mount shell, wire router.
- `src/shell/AppShell.ts` — layout: header, file drawer, editor host, command palette mount.
- `src/store/opfs.ts` — OPFS/IndexedDB file library: list/read/write/delete/rename.
- `src/store/types.ts` — `FileRecord`, `FileKind` types shared across modules.
- `src/detect/fileKind.ts` — map filename/mime/content → `FileKind`.
- `src/upload/uploadHandler.ts` — file picker + drag/drop → store, with size cap.
- `src/editors/registry.ts` — map `FileKind` → editor factory.
- `src/editors/TextEditor.ts` — CodeMirror wrapper (text/code/JSON/markdown source).
- `src/editors/JsonTools.ts` — format/validate/tree helpers for JSON.
- `src/editors/MarkdownPreview.ts` — sanitized live preview pane.
- `src/editors/MermaidPreview.ts` — sandboxed iframe diagram render + export.
- `src/editors/ImageEditor.ts` — Canvas crop/rotate/resize/filter/convert.
- `src/ui/CommandPalette.ts` — global command + find launcher.
- `src/styles/app.css` — mobile-first responsive styles.
- `wrangler.toml` — Pages config.
- Tests mirror under `tests/`.

---

## Task 1: Project scaffold + CI-able test harness

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `index.html`, `src/main.ts`, `.gitignore` (already exists — extend)
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Produces: a `mount(root: HTMLElement): void` export from `src/main.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/smoke.test.ts
import { describe, it, expect } from 'vitest';
import { mount } from '../src/main';

describe('app bootstrap', () => {
  it('mounts a header with the app name', () => {
    const root = document.createElement('div');
    mount(root);
    expect(root.querySelector('header')?.textContent).toContain('AnyEdits');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/smoke.test.ts`
Expected: FAIL — cannot resolve `../src/main`.

- [ ] **Step 3: Scaffold project**

Create `package.json` with scripts: `dev` (`vite`), `build` (`vite build`), `test` (`vitest run`), `e2e` (`playwright test`). Dev deps: `vite`, `typescript`, `vitest`, `jsdom`, `@types/node`. Set `vitest.config.ts` to `environment: 'jsdom'`. `tsconfig.json` with `"strict": true`, `"moduleResolution": "bundler"`. `index.html` with `<div id="app"></div>` and `<script type="module" src="/src/main.ts">`.

```ts
// src/main.ts
export function mount(root: HTMLElement): void {
  const header = document.createElement('header');
  header.textContent = 'AnyEdits';
  root.appendChild(header);
}
const el = typeof document !== 'undefined' && document.getElementById('app');
if (el) mount(el);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/smoke.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: scaffold Vite+TS app with vitest"
```

---

## Task 2: OPFS file store

**Files:**
- Create: `src/store/types.ts`, `src/store/opfs.ts`
- Test: `tests/store/opfs.test.ts`

**Interfaces:**
- Produces:
  - `type FileKind = 'text'|'code'|'json'|'markdown'|'mermaid'|'image'|'binary'`
  - `interface FileRecord { id: string; name: string; kind: FileKind; size: number; updatedAt: number }`
  - `class FileStore { list(): Promise<FileRecord[]>; save(name: string, data: Blob, kind: FileKind): Promise<FileRecord>; read(id: string): Promise<Blob>; rename(id: string, name: string): Promise<void>; remove(id: string): Promise<void> }`
- Consumes: nothing.

> Note: OPFS is unavailable in jsdom. Tests use an in-memory backend injected via constructor `new FileStore(adapter)`, where `adapter` implements a small `StorageAdapter` interface; production uses an OPFS adapter. Define `interface StorageAdapter { put(id,blob,meta): Promise<void>; get(id): Promise<Blob>; del(id): Promise<void>; entries(): Promise<Array<[string, FileRecord]>> }`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/opfs.test.ts
import { describe, it, expect } from 'vitest';
import { FileStore } from '../../src/store/opfs';
import { MemoryAdapter } from '../../src/store/opfs';

describe('FileStore', () => {
  it('saves and lists a file', async () => {
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('note.txt', new Blob(['hi']), 'text');
    expect(rec.name).toBe('note.txt');
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect((await store.read(rec.id)).size).toBe(2);
  });

  it('renames and removes', async () => {
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('a.txt', new Blob(['x']), 'text');
    await store.rename(rec.id, 'b.txt');
    expect((await store.list())[0].name).toBe('b.txt');
    await store.remove(rec.id);
    expect(await store.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/opfs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement store + MemoryAdapter + OpfsAdapter**

```ts
// src/store/types.ts
export type FileKind = 'text'|'code'|'json'|'markdown'|'mermaid'|'image'|'binary';
export interface FileRecord { id: string; name: string; kind: FileKind; size: number; updatedAt: number }
export interface StorageAdapter {
  put(id: string, blob: Blob, meta: FileRecord): Promise<void>;
  get(id: string): Promise<Blob>;
  del(id: string): Promise<void>;
  entries(): Promise<Array<[string, FileRecord]>>;
}
```

```ts
// src/store/opfs.ts
import type { FileKind, FileRecord, StorageAdapter } from './types';
export type { FileKind, FileRecord } from './types';

export class MemoryAdapter implements StorageAdapter {
  private blobs = new Map<string, Blob>();
  private metas = new Map<string, FileRecord>();
  async put(id: string, blob: Blob, meta: FileRecord) { this.blobs.set(id, blob); this.metas.set(id, meta); }
  async get(id: string) { const b = this.blobs.get(id); if (!b) throw new Error('not found'); return b; }
  async del(id: string) { this.blobs.delete(id); this.metas.delete(id); }
  async entries() { return [...this.metas.entries()]; }
}

export class FileStore {
  constructor(private adapter: StorageAdapter) {}
  async list(): Promise<FileRecord[]> {
    return (await this.adapter.entries()).map(([, m]) => m).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async save(name: string, data: Blob, kind: FileKind): Promise<FileRecord> {
    const id = crypto.randomUUID();
    const rec: FileRecord = { id, name, kind, size: data.size, updatedAt: Date.now() };
    await this.adapter.put(id, data, rec);
    return rec;
  }
  async read(id: string): Promise<Blob> { return this.adapter.get(id); }
  async rename(id: string, name: string): Promise<void> {
    const entries = await this.adapter.entries();
    const found = entries.find(([k]) => k === id);
    if (!found) throw new Error('not found');
    const meta = { ...found[1], name, updatedAt: Date.now() };
    await this.adapter.put(id, await this.adapter.get(id), meta);
  }
  async remove(id: string): Promise<void> { await this.adapter.del(id); }
}

// OpfsAdapter used in production (not exercised in jsdom tests).
export class OpfsAdapter implements StorageAdapter {
  private async dir() { return (await navigator.storage.getDirectory()); }
  private metaName(id: string) { return `${id}.meta.json`; }
  async put(id: string, blob: Blob, meta: FileRecord) {
    const dir = await this.dir();
    const fh = await dir.getFileHandle(id, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
    const mh = await dir.getFileHandle(this.metaName(id), { create: true });
    const mw = await mh.createWritable(); await mw.write(JSON.stringify(meta)); await mw.close();
  }
  async get(id: string) { const dir = await this.dir(); return (await (await dir.getFileHandle(id)).getFile()); }
  async del(id: string) {
    const dir = await this.dir();
    await dir.removeEntry(id).catch(() => {});
    await dir.removeEntry(this.metaName(id)).catch(() => {});
  }
  async entries(): Promise<Array<[string, FileRecord]>> {
    const dir = await this.dir(); const out: Array<[string, FileRecord]> = [];
    // @ts-expect-error values() is available on FileSystemDirectoryHandle at runtime
    for await (const [name, handle] of dir.entries()) {
      if (name.endsWith('.meta.json')) {
        const f = await (handle as FileSystemFileHandle).getFile();
        const meta = JSON.parse(await f.text()) as FileRecord; out.push([meta.id, meta]);
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/opfs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: OPFS-backed file store with in-memory test adapter"
```

---

## Task 3: File-kind detection

**Files:**
- Create: `src/detect/fileKind.ts`
- Test: `tests/detect/fileKind.test.ts`

**Interfaces:**
- Produces: `function detectKind(name: string, mime?: string): FileKind`
- Consumes: `FileKind` from `src/store/types.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/detect/fileKind.test.ts
import { describe, it, expect } from 'vitest';
import { detectKind } from '../../src/detect/fileKind';

describe('detectKind', () => {
  it('detects by extension', () => {
    expect(detectKind('a.json')).toBe('json');
    expect(detectKind('a.md')).toBe('markdown');
    expect(detectKind('a.mmd')).toBe('mermaid');
    expect(detectKind('a.ts')).toBe('code');
    expect(detectKind('a.txt')).toBe('text');
    expect(detectKind('a.png')).toBe('image');
    expect(detectKind('a.bin')).toBe('binary');
  });
  it('falls back to mime for images', () => {
    expect(detectKind('unknown', 'image/jpeg')).toBe('image');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/detect/fileKind.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/detect/fileKind.ts
import type { FileKind } from '../store/types';
const CODE = new Set(['ts','tsx','js','jsx','py','go','rs','java','c','cpp','h','css','html','yaml','yml','toml','sh','sql']);
export function detectKind(name: string, mime?: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
  if (ext === 'txt') return 'text';
  if (CODE.has(ext)) return 'code';
  if (['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext) || mime?.startsWith('image/')) return 'image';
  return 'binary';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/detect/fileKind.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: file-kind detection by extension and mime"
```

---

## Task 4: Upload handler (size cap + store integration)

**Files:**
- Create: `src/upload/uploadHandler.ts`
- Test: `tests/upload/uploadHandler.test.ts`

**Interfaces:**
- Produces: `async function handleUpload(file: File, store: FileStore): Promise<{ ok: true; record: FileRecord } | { ok: false; error: string }>`
- Consumes: `FileStore` (Task 2), `detectKind` (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
// tests/upload/uploadHandler.test.ts
import { describe, it, expect } from 'vitest';
import { handleUpload } from '../../src/upload/uploadHandler';
import { FileStore, MemoryAdapter } from '../../src/store/opfs';

const mkFile = (name: string, size: number) => {
  const f = new File([new Uint8Array(1)], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('handleUpload', () => {
  it('rejects files over 500MB', async () => {
    const store = new FileStore(new MemoryAdapter());
    const res = await handleUpload(mkFile('big.txt', 500 * 1024 * 1024 + 1), store);
    expect(res.ok).toBe(false);
  });
  it('stores a valid file with detected kind', async () => {
    const store = new FileStore(new MemoryAdapter());
    const res = await handleUpload(new File(['{}'], 'a.json'), store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.kind).toBe('json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/upload/uploadHandler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/upload/uploadHandler.ts
import type { FileRecord } from '../store/types';
import { FileStore } from '../store/opfs';
import { detectKind } from '../detect/fileKind';
const MAX = 500 * 1024 * 1024;
export async function handleUpload(
  file: File, store: FileStore
): Promise<{ ok: true; record: FileRecord } | { ok: false; error: string }> {
  if (file.size > MAX) return { ok: false, error: 'File exceeds 500MB limit.' };
  const kind = detectKind(file.name, file.type);
  const record = await store.save(file.name, file, kind);
  return { ok: true, record };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/upload/uploadHandler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: upload handler with 500MB cap"
```

---

## Task 5: Text/code editor (CodeMirror wrapper)

**Files:**
- Create: `src/editors/TextEditor.ts`
- Test: `tests/editors/TextEditor.test.ts`

**Interfaces:**
- Produces: `class TextEditor { constructor(host: HTMLElement, opts: { doc: string; language: FileKind }); getValue(): string; setValue(v: string): void; destroy(): void }`
- Consumes: CodeMirror 6 packages (`codemirror`, `@codemirror/lang-*`, `@codemirror/search`, `@codemirror/language`).

> Note: CodeMirror mounts a real DOM; jsdom supports enough for construction. Keep assertions to value round-trip and presence of `.cm-editor` node.

- [ ] **Step 1: Write the failing test**

```ts
// tests/editors/TextEditor.test.ts
import { describe, it, expect } from 'vitest';
import { TextEditor } from '../../src/editors/TextEditor';

describe('TextEditor', () => {
  it('round-trips document text', () => {
    const host = document.createElement('div');
    const ed = new TextEditor(host, { doc: 'hello', language: 'text' });
    expect(host.querySelector('.cm-editor')).toBeTruthy();
    expect(ed.getValue()).toBe('hello');
    ed.setValue('world');
    expect(ed.getValue()).toBe('world');
    ed.destroy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editors/TextEditor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Install: `npm i codemirror @codemirror/state @codemirror/view @codemirror/commands @codemirror/search @codemirror/language @codemirror/lang-json @codemirror/lang-javascript @codemirror/lang-markdown`.

```ts
// src/editors/TextEditor.ts
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, type Extension } from '@codemirror/state';
import { search, searchKeymap } from '@codemirror/search';
import { keymap } from '@codemirror/view';
import { foldGutter, foldKeymap } from '@codemirror/language';
import { json } from '@codemirror/lang-json';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import type { FileKind } from '../store/types';

function langFor(kind: FileKind): Extension[] {
  if (kind === 'json') return [json()];
  if (kind === 'code') return [javascript()];
  if (kind === 'markdown') return [markdown()];
  return [];
}

export class TextEditor {
  private view: EditorView;
  constructor(host: HTMLElement, opts: { doc: string; language: FileKind }) {
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: opts.doc,
        extensions: [basicSetup, foldGutter(), search(), keymap.of([...searchKeymap, ...foldKeymap]), ...langFor(opts.language)],
      }),
    });
  }
  getValue() { return this.view.state.doc.toString(); }
  setValue(v: string) { this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: v } }); }
  destroy() { this.view.destroy(); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editors/TextEditor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: CodeMirror text/code editor with search and folding"
```

---

## Task 6: JSON tools (format/validate/tree)

**Files:**
- Create: `src/editors/JsonTools.ts`
- Test: `tests/editors/JsonTools.test.ts`

**Interfaces:**
- Produces:
  - `function formatJson(src: string): { ok: true; text: string } | { ok: false; error: string }`
  - `function toTree(src: string): TreeNode` where `interface TreeNode { key: string; type: string; children?: TreeNode[]; value?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/editors/JsonTools.test.ts
import { describe, it, expect } from 'vitest';
import { formatJson, toTree } from '../../src/editors/JsonTools';

describe('JsonTools', () => {
  it('formats valid json', () => {
    const r = formatJson('{"a":1}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toBe('{\n  "a": 1\n}');
  });
  it('reports invalid json', () => {
    expect(formatJson('{oops').ok).toBe(false);
  });
  it('builds a tree', () => {
    const t = toTree('{"a":{"b":2}}');
    expect(t.children?.[0].key).toBe('a');
    expect(t.children?.[0].children?.[0].value).toBe('2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editors/JsonTools.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/editors/JsonTools.ts
export interface TreeNode { key: string; type: string; children?: TreeNode[]; value?: string }

export function formatJson(src: string): { ok: true; text: string } | { ok: false; error: string } {
  try { return { ok: true, text: JSON.stringify(JSON.parse(src), null, 2) }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

function build(key: string, val: unknown): TreeNode {
  if (val !== null && typeof val === 'object') {
    const entries = Array.isArray(val) ? val.map((v, i) => [String(i), v] as const) : Object.entries(val);
    return { key, type: Array.isArray(val) ? 'array' : 'object', children: entries.map(([k, v]) => build(k, v)) };
  }
  return { key, type: typeof val, value: String(val) };
}
export function toTree(src: string): TreeNode { return build('$', JSON.parse(src)); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editors/JsonTools.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: JSON format/validate/tree tools"
```

---

## Task 7: Markdown sanitized preview

**Files:**
- Create: `src/editors/MarkdownPreview.ts`
- Test: `tests/editors/MarkdownPreview.test.ts`

**Interfaces:**
- Produces: `function renderMarkdown(src: string): string` (returns sanitized HTML string).

- [ ] **Step 1: Write the failing test**

```ts
// tests/editors/MarkdownPreview.test.ts
import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../../src/editors/MarkdownPreview';

describe('renderMarkdown', () => {
  it('renders headings', () => {
    expect(renderMarkdown('# Hi')).toContain('<h1>Hi</h1>');
  });
  it('strips script tags (XSS)', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editors/MarkdownPreview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Install: `npm i marked dompurify`.

```ts
// src/editors/MarkdownPreview.ts
import { marked } from 'marked';
import DOMPurify from 'dompurify';
export function renderMarkdown(src: string): string {
  const raw = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(raw);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editors/MarkdownPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: sanitized markdown preview"
```

---

## Task 8: Mermaid sandboxed preview

**Files:**
- Create: `src/editors/MermaidPreview.ts`
- Test: `tests/editors/MermaidPreview.test.ts`

**Interfaces:**
- Produces:
  - `function buildMermaidFrame(source: string): string` — returns the full HTML document string loaded into a `sandbox`ed iframe (renders Mermaid, no `allow-same-origin`).
  - `class MermaidPreview { constructor(host: HTMLElement); render(source: string): void; destroy(): void }` — creates the iframe with `sandbox="allow-scripts"` and sets `srcdoc`.

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editors/MermaidPreview.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Install: `npm i mermaid`. The iframe loads mermaid from a bundled asset URL at runtime; for the frame doc we escape the source and place it in a `.mermaid` container.

```ts
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
```

> Note: The CDN `<script>` inside a `sandbox="allow-scripts"` (no same-origin) frame runs in an opaque origin, isolated from the app. If offline support for Mermaid is required, replace the CDN URL with a bundled asset served from the app origin in a later refinement; functional behavior is unchanged for the test.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editors/MermaidPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: sandboxed mermaid preview"
```

---

## Task 9: Image editor (Canvas ops)

**Files:**
- Create: `src/editors/ImageEditor.ts`
- Test: `tests/editors/ImageEditor.test.ts`

**Interfaces:**
- Produces: pure transform helpers testable without a real canvas:
  - `function computeResize(w: number, h: number, maxDim: number): { w: number; h: number }`
  - `function computeRotatedSize(w: number, h: number, deg: 90|180|270): { w: number; h: number }`
  - `class ImageEditor { constructor(canvas: HTMLCanvasElement); load(bitmap: ImageBitmap): void; rotate(deg: 90|180|270): void; resize(maxDim: number): void; applyFilter(css: string): void; toBlob(type: string, quality?: number): Promise<Blob> }`

> Note: test only the pure helpers (jsdom has no real 2D canvas). The class wires helpers to canvas ops; covered by the e2e smoke in Task 12.

- [ ] **Step 1: Write the failing test**

```ts
// tests/editors/ImageEditor.test.ts
import { describe, it, expect } from 'vitest';
import { computeResize, computeRotatedSize } from '../../src/editors/ImageEditor';

describe('image math', () => {
  it('scales down preserving aspect ratio', () => {
    expect(computeResize(2000, 1000, 1000)).toEqual({ w: 1000, h: 500 });
  });
  it('does not upscale', () => {
    expect(computeResize(500, 500, 1000)).toEqual({ w: 500, h: 500 });
  });
  it('swaps dimensions on 90/270', () => {
    expect(computeRotatedSize(200, 100, 90)).toEqual({ w: 100, h: 200 });
    expect(computeRotatedSize(200, 100, 180)).toEqual({ w: 200, h: 100 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editors/ImageEditor.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/editors/ImageEditor.ts
export function computeResize(w: number, h: number, maxDim: number): { w: number; h: number } {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}
export function computeRotatedSize(w: number, h: number, deg: 90|180|270): { w: number; h: number } {
  return deg === 180 ? { w, h } : { w: h, h: w };
}
export class ImageEditor {
  private ctx: CanvasRenderingContext2D;
  private filter = 'none';
  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }
  load(bitmap: ImageBitmap) {
    this.canvas.width = bitmap.width; this.canvas.height = bitmap.height;
    this.ctx.drawImage(bitmap, 0, 0);
  }
  rotate(deg: 90|180|270) {
    const { width: w, height: h } = this.canvas;
    const size = computeRotatedSize(w, h, deg);
    const tmp = document.createElement('canvas'); tmp.width = size.w; tmp.height = size.h;
    const tctx = tmp.getContext('2d')!;
    tctx.translate(size.w / 2, size.h / 2); tctx.rotate((deg * Math.PI) / 180);
    tctx.drawImage(this.canvas, -w / 2, -h / 2);
    this.canvas.width = size.w; this.canvas.height = size.h; this.ctx.drawImage(tmp, 0, 0);
  }
  resize(maxDim: number) {
    const { width: w, height: h } = this.canvas;
    const s = computeResize(w, h, maxDim);
    const tmp = document.createElement('canvas'); tmp.width = s.w; tmp.height = s.h;
    tmp.getContext('2d')!.drawImage(this.canvas, 0, 0, s.w, s.h);
    this.canvas.width = s.w; this.canvas.height = s.h; this.ctx.drawImage(tmp, 0, 0);
  }
  applyFilter(css: string) { this.filter = css; this.ctx.filter = css; }
  toBlob(type: string, quality?: number): Promise<Blob> {
    return new Promise((res, rej) => this.canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), type, quality));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editors/ImageEditor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: canvas image editor with pure transform helpers"
```

---

## Task 10: Editor registry

**Files:**
- Create: `src/editors/registry.ts`
- Test: `tests/editors/registry.test.ts`

**Interfaces:**
- Produces: `function editorKindFor(kind: FileKind): 'text'|'image'` — routes JSON/markdown/mermaid/code/text to the text editor family and images to the image editor. (Preview panes are attached by the shell based on the original `FileKind`.)
- Consumes: `FileKind`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/editors/registry.test.ts
import { describe, it, expect } from 'vitest';
import { editorKindFor } from '../../src/editors/registry';

describe('editorKindFor', () => {
  it('routes text-family to text', () => {
    for (const k of ['text','code','json','markdown','mermaid'] as const)
      expect(editorKindFor(k)).toBe('text');
  });
  it('routes images to image', () => {
    expect(editorKindFor('image')).toBe('image');
  });
  it('routes binary to text (read-only hex/plain fallback)', () => {
    expect(editorKindFor('binary')).toBe('text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/editors/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/editors/registry.ts
import type { FileKind } from '../store/types';
export function editorKindFor(kind: FileKind): 'text'|'image' {
  return kind === 'image' ? 'image' : 'text';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/editors/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: editor registry routing"
```

---

## Task 11: App shell + command palette (wire everything)

**Files:**
- Create: `src/shell/AppShell.ts`, `src/ui/CommandPalette.ts`, `src/styles/app.css`
- Modify: `src/main.ts`
- Test: `tests/shell/AppShell.test.ts`

**Interfaces:**
- Produces:
  - `class AppShell { constructor(root: HTMLElement, store: FileStore); refreshLibrary(): Promise<void>; openFile(id: string): Promise<void> }`
  - `class CommandPalette { constructor(root: HTMLElement, commands: Array<{ id: string; label: string; run: () => void }>); open(): void; close(): void }`
- Consumes: `FileStore`, `handleUpload`, `TextEditor`, `ImageEditor`, `renderMarkdown`, `MermaidPreview`, `editorKindFor`, `detectKind`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/shell/AppShell.test.ts
import { describe, it, expect } from 'vitest';
import { AppShell } from '../../src/shell/AppShell';
import { FileStore, MemoryAdapter } from '../../src/store/opfs';

describe('AppShell', () => {
  it('lists stored files in the drawer', async () => {
    const store = new FileStore(new MemoryAdapter());
    await store.save('note.md', new Blob(['# hi']), 'markdown');
    const root = document.createElement('div');
    const shell = new AppShell(root, store);
    await shell.refreshLibrary();
    expect(root.querySelector('[data-role="file-drawer"]')?.textContent).toContain('note.md');
  });

  it('opens a markdown file into an editor host', async () => {
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('note.md', new Blob(['# hi']), 'markdown');
    const root = document.createElement('div');
    const shell = new AppShell(root, store);
    await shell.openFile(rec.id);
    expect(root.querySelector('[data-role="editor-host"] .cm-editor')).toBeTruthy();
    expect(root.querySelector('[data-role="preview"]')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shell/AppShell.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement shell + palette + styles + main wiring**

Build `AppShell` with header (contains "AnyEdits"), a `[data-role="file-drawer"]` list (each item a button with the file name + delete/rename controls, 44px min touch target), an upload input wired to `handleUpload` then `refreshLibrary`, and a `[data-role="editor-host"]`. `openFile(id)`: read blob + record, `editorKindFor(record.kind)` → build `TextEditor` (decoding blob text) or `ImageEditor`; for `markdown` also mount a `[data-role="preview"]` pane rendering `renderMarkdown` on input; for `mermaid` mount `MermaidPreview`; for `json` add a format button calling `formatJson`. Debounce editor→store autosave (250ms) via `store.save` replacing content (use `remove`+`save` or extend store with `update`; if needed add `FileStore.update(id, data): Promise<void>` — define it and a test in Task 2's file if you extend). `CommandPalette`: overlay with a text input filtering commands; Enter runs the selected command; commands include "Upload", "Find" (focuses editor search), "Format JSON", "Toggle preview". `app.css`: mobile-first, drawer collapses under a hamburger below 720px, ≥44px targets, high-contrast focus rings. Update `src/main.ts` to instantiate `FileStore(new OpfsAdapter())` and `new AppShell(el, store)` then `refreshLibrary()`.

> If you extend `FileStore` with `update(id, data)`, add this test to `tests/store/opfs.test.ts`:
> ```ts
> it('updates content in place', async () => {
>   const store = new FileStore(new MemoryAdapter());
>   const rec = await store.save('a.txt', new Blob(['x']), 'text');
>   await store.update(rec.id, new Blob(['xyz']));
>   expect((await store.read(rec.id)).size).toBe(3);
> });
> ```
> and implement:
> ```ts
> async update(id: string, data: Blob): Promise<void> {
>   const found = (await this.adapter.entries()).find(([k]) => k === id);
>   if (!found) throw new Error('not found');
>   await this.adapter.put(id, data, { ...found[1], size: data.size, updatedAt: Date.now() });
> }
> ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: app shell, file drawer, command palette, autosave wiring"
```

---

## Task 12: E2E smoke + Pages deploy config

**Files:**
- Create: `tests/e2e/smoke.spec.ts`, `playwright.config.ts`, `wrangler.toml`, `public/_headers`
- Modify: `package.json` (add `deploy` script)

**Interfaces:**
- Consumes: the built app served by `vite preview`.

- [ ] **Step 1: Write the failing e2e test**

```ts
// tests/e2e/smoke.spec.ts
import { test, expect } from '@playwright/test';

test('upload a markdown file and see preview', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('header')).toContainText('AnyEdits');
  await page.setInputFiles('input[type=file]', {
    name: 'hello.md', mimeType: 'text/markdown', buffer: Buffer.from('# Hello'),
  });
  await expect(page.locator('[data-role="file-drawer"]')).toContainText('hello.md');
  await page.locator('[data-role="file-drawer"] button', { hasText: 'hello.md' }).click();
  await expect(page.locator('[data-role="preview"]')).toContainText('Hello');
});
```

- [ ] **Step 2: Run e2e to verify it fails (or drives implementation gaps)**

Install: `npm i -D @playwright/test && npx playwright install chromium`.
Create `playwright.config.ts` with `webServer: { command: 'npm run build && npx vite preview --port 4173', url: 'http://localhost:4173' }`, `use: { baseURL: 'http://localhost:4173' }`.
Run: `npx playwright test`
Expected: FAIL if any wiring gap remains; fix in `AppShell` until green.

- [ ] **Step 3: Add deploy config**

```toml
# wrangler.toml
name = "anyedits"
compatibility_date = "2026-09-19"
pages_build_output_dir = "dist"
```

```
# public/_headers
/*
  Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-src 'self'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

Add to `package.json` scripts: `"deploy": "vite build && npx wrangler pages deploy dist --project-name anyedits"`.

> Note: The Mermaid CDN in Task 8 runs inside a sandboxed opaque-origin iframe (its own `srcdoc` document), so the app-origin CSP `script-src 'self'` does not block it. If you later bundle Mermaid locally, no CSP change is needed.

- [ ] **Step 4: Run e2e to verify it passes**

Run: `npx playwright test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "test: e2e smoke; chore: Cloudflare Pages deploy config"
```

---

## Deployment (after all tasks green)

Run `npm run deploy` (authenticates via `wrangler login` first time). Confirm the live URL loads, upload works, and editing/preview functions on a phone-width viewport. No secrets are needed for this plan (no backend).

---

## Self-Review

**Spec coverage:** Editors text/code/JSON/markdown/mermaid/image (Tasks 5–10); previews (7,8) + expand/collapse folding (5) + find/search (5) + clipboard (CodeMirror `basicSetup`, 5); local-first OPFS (2); upload-and-start + 500MB cap (4); mobile-first + a11y (11, Global Constraints); XSS sanitize + sandboxed mermaid + CSP (7,8,12); Pages deploy (12). Deferred to Plan 2 (correctly out of scope here): OAuth, share links, quota ledger, Filebase snapshots, retention cron, login incentives.

**Placeholder scan:** No TBD/TODO; all code steps contain runnable code; the optional `FileStore.update` extension includes both its test and implementation.

**Type consistency:** `FileKind`/`FileRecord`/`StorageAdapter` defined in Task 2 and reused verbatim in Tasks 3,4,5,10,11; `handleUpload` return shape consumed in Task 11; `editorKindFor` signature matches Task 10 test and Task 11 usage.
