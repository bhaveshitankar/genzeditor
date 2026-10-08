/// <reference types="vite/client" />
import './styles/pdf.css';
import * as pdfjsLib from 'pdfjs-dist';
import PdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PDFImage } from 'pdf-lib';
import type { DocEditor } from './registry';
import { getAppClipboard, setAppClipboard, type EditCommands } from './editCommands';

pdfjsLib.GlobalWorkerOptions.workerSrc = PdfWorkerUrl;

type Rotation = 0 | 90 | 180 | 270;
// Persistent pointer modes (signature / image / merge are one-shot buttons).
type Mode = 'select' | 'text' | 'box' | 'highlight' | 'ink' | 'line' | 'rect' | 'circle';
type AnnotType = 'text' | 'box' | 'highlight' | 'signature' | 'image' | 'ink' | 'line' | 'rect' | 'circle';

interface Pt { x: number; y: number }               // relative to page (0..1)

interface PageModel {
  id: string;
  srcIndex: number;         // index into `sources`; -1 for a synthetic image page
  origIndex: number;        // 0-based page index within its source; -1 for image page
  rotation: Rotation;
  imageDataUrl?: string;    // image-only pages
  imageW?: number; imageH?: number;
}

interface Annotation {
  id: string;
  pageId: string;                  // owning PageModel.id (survives reorder/duplicate/merge)
  type: AnnotType;
  xR: number; yR: number;          // top-left, relative to page (0..1)
  wR: number; hR: number;          // size, relative to page (0..1)
  text?: string;                   // text / box
  fontSize?: number;               // PDF points
  dataUrl?: string;                // signature / image PNG or JPG
  ocr?: boolean;                   // created by OCR
  color?: string;                  // hex, for ink / shapes
  strokeWidth?: number;            // stroke thickness in points, for ink / shapes
  points?: Pt[];                   // relative points, for ink (many) / line (two)
}

interface Snapshot { pages: PageModel[]; annotations: Annotation[] }

const uid = () => Math.random().toString(36).slice(2, 10);
const SVGNS = 'http://www.w3.org/2000/svg';

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export class PdfEditor implements DocEditor {
  private host: HTMLElement;
  private sources: Uint8Array[] = [];                         // 0 = original; more via merge
  private pdfDocs = new Map<number, pdfjsLib.PDFDocumentProxy>();
  private loadingTasks: pdfjsLib.PDFDocumentLoadingTask[] = [];
  private pages: PageModel[] = [];
  private annotations: Annotation[] = [];
  private mode: Mode = 'select';
  private onChange?: () => void;
  private selectedId: string | null = null;
  private activePageId: string | null = null;                // target for signature / image insert
  private selectedPages = new Set<string>();                 // for extract / split
  private ocrInProgress = new Map<string, boolean>();        // per-page OCR guard
  private thumbCache = new Map<string, string>();            // `${pageId}:${rotation}` -> dataURL

  private drawColor = '#ef4444';
  private drawWidth = 3;
  private zoom = 1;                                           // 1 = fit-to-width baseline

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  private name: string;

  private constructor(host: HTMLElement, original: Uint8Array, onChange?: () => void, name = 'document.pdf') {
    this.host = host;
    this.sources = [original];
    this.onChange = onChange;
    this.name = name;
  }

  static async open(host: HTMLElement, blob: Blob, onChange?: () => void, name = 'document.pdf'): Promise<PdfEditor> {
    const buf = await blob.arrayBuffer();
    const original = new Uint8Array(buf.slice(0));
    const editor = new PdfEditor(host, original, onChange, name);
    const doc = await editor.loadSource(0);
    for (let i = 0; i < doc.numPages; i++) {
      editor.pages.push({ id: uid(), srcIndex: 0, origIndex: i, rotation: 0 });
    }
    editor.activePageId = editor.pages[0]?.id ?? null;
    await editor.render();
    return editor;
  }

  destroy(): void {
    for (const t of this.loadingTasks) { try { t.destroy(); } catch { /* ignore */ } }
    this.loadingTasks = [];
    this.pdfDocs.clear();
  }

  // ---- Shared edit commands (shell owns shortcuts + long-press menu) -------
  // Objects are annotations. Pages are not deleted from here (no confirmation);
  // use the page controls for that.

  commands(): EditCommands {
    return {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.undoStack.length > 0,
      canRedo: () => this.redoStack.length > 0,
      hasSelection: () => !!this.selectedAnnot(),
      canPaste: () => true,
      delete: () => {
        const a = this.selectedAnnot();
        if (!a) return;
        this.pushHistory();
        this.deleteAnnotation(a.id);
      },
      copy: () => this.copyAnnot(),
      cut: () => {
        const a = this.selectedAnnot();
        if (!a) return;
        this.copyAnnot();
        this.pushHistory();
        this.deleteAnnotation(a.id);
      },
      paste: (data) => this.pasteInto(data),
      duplicate: () => {
        const a = this.selectedAnnot();
        if (a) this.insertAnnotCopy(a);
      },
    };
  }

  private selectedAnnot(): Annotation | null {
    return (this.selectedId && this.annotations.find((a) => a.id === this.selectedId)) || null;
  }

  private copyAnnot(): void {
    const a = this.selectedAnnot();
    if (!a) return;
    const text = (a.type === 'text' || a.type === 'box') ? (a.text ?? '') : '';
    setAppClipboard('pdf-annot', { annot: structuredClone(a), text });
    if (text) navigator.clipboard?.writeText(text).catch(() => {});
  }

  // Insert a copy of `src` on the active page (offset when it's the same page),
  // with history, and select it.
  private insertAnnotCopy(src: Annotation): void {
    const pm = this.pages.find((p) => p.id === this.activePageId) ?? this.pages.find((p) => p.id === src.pageId) ?? this.pages[0];
    if (!pm) return;
    const off = pm.id === src.pageId ? 0.02 : 0;
    const a: Annotation = structuredClone(src);
    a.id = uid();
    a.pageId = pm.id;
    a.ocr = undefined;
    const dx = Math.min(off, Math.max(0, 0.999 - a.xR)), dy = Math.min(off, Math.max(0, 0.999 - a.yR));
    a.xR += dx; a.yR += dy;
    if (a.points) a.points = a.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
    this.pushHistory();
    this.annotations.push(a);
    this.selectedId = a.id; this.activePageId = pm.id; this.mode = 'select';
    this.changed(); void this.render();
  }

  private addAnnotOnActivePage(partial: Omit<Annotation, 'id' | 'pageId'>): void {
    const pm = this.pages.find((p) => p.id === this.activePageId) ?? this.pages[0];
    if (!pm) return;
    this.pushHistory();
    const a: Annotation = { ...partial, id: uid(), pageId: pm.id };
    this.annotations.push(a);
    this.selectedId = a.id; this.activePageId = pm.id; this.mode = 'select';
    this.changed(); void this.render();
  }

  private async addImageAnnot(blob: Blob): Promise<void> {
    let dataUrl = await this.fileToDataUrl(blob as File);
    const img = await this.loadImage(dataUrl);
    // Export only embeds PNG/JPG; convert anything else to PNG.
    if (!/^image\/(png|jpe?g)$/.test(blob.type)) {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
      c.getContext('2d')?.drawImage(img, 0, 0);
      dataUrl = c.toDataURL('image/png');
    }
    const wR = 0.4, hR = wR * (img.height / img.width) * 0.75; // same rough aspect as Insert image
    this.addAnnotOnActivePage({ type: 'image', xR: 0.3, yR: 0.3, wR, hR, dataUrl });
  }

  private addTextAnnot(text: string): void {
    this.addAnnotOnActivePage({ type: 'text', xR: 0.1, yR: 0.1, wR: 0.5, hR: 0.05, text, fontSize: 14 });
  }

  // Paste: image from the paste event → image annotation; else the copied
  // annotation; else plain text → text annotation; with no event data, try
  // the system clipboard.
  private async pasteInto(data?: DataTransfer | null): Promise<void> {
    const clip = getAppClipboard<{ annot: Annotation; text: string }>('pdf-annot');
    if (data) {
      const file = Array.from(data.files ?? []).find((f) => f.type.startsWith('image/'));
      if (file) return this.addImageAnnot(file);
      const text = data.getData('text/plain');
      if (clip && (!text || text === clip.text)) return this.insertAnnotCopy(clip.annot);
      if (text.trim()) return this.addTextAnnot(text);
      return;
    }
    if (clip) return this.insertAnnotCopy(clip.annot);
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) return this.addImageAnnot(await it.getType(type));
      }
    } catch { /* not supported / denied */ }
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) this.addTextAnnot(text);
    } catch { /* denied */ }
  }

  private changed() { this.onChange?.(); }

  /** Add AI-generated text notes as annotations. Cannot edit original page text. */
  applyAiAnnotations(
    anns: { text: string; page?: number; x?: number; y?: number; size?: number }[],
  ): string {
    this.pushHistory();
    let n = 0;
    for (const a of anns) {
      if (!a.text) continue;
      const pageId = (a.page && this.pages[a.page - 1]?.id) || this.activePageId || this.pages[0]?.id;
      if (!pageId) continue;
      this.annotations.push({
        id: uid(), pageId, type: 'text',
        xR: Math.min(0.95, Math.max(0, a.x ?? 0.1)),
        yR: Math.min(0.95, Math.max(0, a.y ?? 0.1)),
        wR: 0.8, hR: 0.08, text: a.text, fontSize: a.size ?? 14,
      });
      n++;
    }
    this.changed();
    void this.render();
    return `added ${n} note(s)`;
  }

  private async loadSource(idx: number): Promise<pdfjsLib.PDFDocumentProxy> {
    const existing = this.pdfDocs.get(idx);
    if (existing) return existing;
    const bytes = this.sources[idx];
    if (!bytes) throw new Error(`Missing source ${idx}`);
    // Copy the buffer: pdf.js transfers/detaches the array it is given.
    const task = pdfjsLib.getDocument({ data: bytes.slice(0) });
    this.loadingTasks.push(task);
    const doc = await task.promise;
    this.pdfDocs.set(idx, doc);
    return doc;
  }

  // ---- Undo / redo --------------------------------------------------------

  private snapshot(): Snapshot {
    return { pages: structuredClone(this.pages), annotations: structuredClone(this.annotations) };
  }

  private pushHistory(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snapshot());
    this.pages = prev.pages; this.annotations = prev.annotations;
    this.selectedId = null;
    this.changed(); void this.render();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snapshot());
    this.pages = next.pages; this.annotations = next.annotations;
    this.selectedId = null;
    this.changed(); void this.render();
  }

  // ---- Rendering ----------------------------------------------------------

  private targetWidth(): number {
    const avail = (this.host.clientWidth || 900) - 240; // leave room for sidebar
    return Math.max(320, Math.min(avail || 800, 1200)) * this.zoom;
  }

  private async render(): Promise<void> {
    const scrollTop = this.host.querySelector('.pdf-main')?.scrollTop ?? 0;
    this.host.innerHTML = '';
    this.host.appendChild(this.buildToolbar());

    const layout = document.createElement('div');
    layout.className = 'pdf-layout';
    const sidebar = document.createElement('div');
    sidebar.className = 'pdf-sidebar';
    const main = document.createElement('div');
    main.className = 'pdf-main';
    layout.append(sidebar, main);
    this.host.appendChild(layout);

    for (let i = 0; i < this.pages.length; i++) {
      const pm = this.pages[i];
      if (pm) await this.renderPage(main, i, pm);
    }
    // Thumbnails after pages so page canvases exist for reuse if needed.
    for (let i = 0; i < this.pages.length; i++) {
      const pm = this.pages[i];
      if (pm) await this.renderThumb(sidebar, i, pm);
    }
    main.scrollTop = scrollTop;

    // Focusable so the shell's shortcuts (undo/redo/delete/copy/paste) apply here.
    this.host.tabIndex = 0;
  }

  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'pdf-toolbar';

    const group = (cls = '') => {
      const g = document.createElement('div');
      g.className = `pdf-tool-group ${cls}`.trim();
      bar.appendChild(g);
      return g;
    };
    const btn = (parent: HTMLElement, label: string, fn: () => void, active = false, title = '') => {
      const b = document.createElement('button');
      b.textContent = label;
      if (active) b.className = 'active';
      if (title) b.title = title;
      b.addEventListener('click', fn);
      parent.appendChild(b);
      return b;
    };

    // Modes.
    const modes: Array<{ m: Mode; label: string }> = [
      { m: 'select', label: '➤ Select' },
      { m: 'text', label: '＋ Text' },
      { m: 'box', label: '▭ Edit box' },
      { m: 'highlight', label: '🖍 Highlight' },
      { m: 'ink', label: '✎ Draw' },
      { m: 'line', label: '╱ Line' },
      { m: 'rect', label: '▢ Rect' },
      { m: 'circle', label: '◯ Circle' },
    ];
    const g1 = group();
    for (const t of modes) {
      btn(g1, t.label, () => { this.mode = t.m; this.selectedId = null; void this.render(); }, t.m === this.mode);
    }

    // Draw style (color + width) for ink / shapes.
    const g2 = group('pdf-style-group');
    const color = document.createElement('input');
    color.type = 'color'; color.value = this.drawColor; color.className = 'pdf-color'; color.title = 'Stroke colour';
    color.addEventListener('input', () => { this.drawColor = color.value; });
    const width = document.createElement('select');
    width.className = 'pdf-width'; width.title = 'Stroke width';
    for (const w of [1, 2, 3, 5, 8]) {
      const o = document.createElement('option'); o.value = String(w); o.textContent = `${w}px`;
      if (w === this.drawWidth) o.selected = true; width.appendChild(o);
    }
    width.addEventListener('change', () => { this.drawWidth = Number(width.value); });
    g2.append(color, width);

    // One-shot content actions.
    const g3 = group();
    btn(g3, '✍ Signature', () => { void this.beginSignature(); });
    btn(g3, '🖼 Image', () => { void this.insertImage(false); }, false, 'Add image onto the active page');
    btn(g3, '🖼 Img page', () => { void this.insertImage(true); }, false, 'Add image as a new page');
    btn(g3, '⧉ Merge PDF', () => { void this.mergePdf(); }, false, 'Append another PDF');
    const extract = btn(g3, '⤓ Extract', () => { void this.extractSelected(); }, false, 'Download selected pages as a new PDF');
    extract.disabled = this.selectedPages.size === 0;
    btn(g3, '⤓ DOCX', () => { void this.exportDocx(); }, false, 'Save a copy as an editable Word document');

    // History + zoom.
    const g4 = group();
    const u = btn(g4, '↶ Undo', () => this.undo()); u.disabled = this.undoStack.length === 0;
    const r = btn(g4, '↷ Redo', () => this.redo()); r.disabled = this.redoStack.length === 0;
    btn(g4, '−', () => { this.zoom = Math.max(0.4, this.zoom - 0.2); this.thumbCache.clear(); void this.render(); }, false, 'Zoom out');
    btn(g4, `${Math.round(this.zoom * 100)}%`, () => { this.zoom = 1; this.thumbCache.clear(); void this.render(); }, false, 'Fit width');
    btn(g4, '＋', () => { this.zoom = Math.min(3, this.zoom + 0.2); this.thumbCache.clear(); void this.render(); }, false, 'Zoom in');
    btn(g4, '⤢ Fit', () => { this.zoom = 1; this.thumbCache.clear(); void this.render(); });

    const hint = document.createElement('span');
    hint.className = 'pdf-hint';
    hint.textContent = this.hintFor();
    bar.appendChild(hint);
    return bar;
  }

  private hintFor(): string {
    switch (this.mode) {
      case 'select': return 'Drag items to move · click a box to type · select text to copy';
      case 'text': return 'Click where you want to add text';
      case 'box': return 'Click to drop a white edit box, then type over content';
      case 'highlight': return 'Drag across the page to highlight';
      case 'ink': return 'Draw freehand with the pointer';
      case 'line': return 'Drag to draw a straight line';
      case 'rect': return 'Drag to draw a rectangle outline';
      case 'circle': return 'Drag to draw an ellipse';
      default: return '';
    }
  }

  // ---- Page canvas --------------------------------------------------------

  /** Render a page (PDF or image) onto a canvas sized to `targetWidth * zoom`. */
  private async paintPage(pm: PageModel, canvas: HTMLCanvasElement, targetWidth: number): Promise<{ w: number; h: number; scale: number }> {
    // Hi-DPI support: cap at 2 to bound memory while still getting crisp text on Retina.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (pm.srcIndex === -1 && pm.imageDataUrl) {
      const img = await this.loadImage(pm.imageDataUrl);
      const natW = pm.imageW ?? img.width, natH = pm.imageH ?? img.height;
      const scale = targetWidth / natW;
      const logicalW = Math.round(natW * scale), logicalH = Math.round(natH * scale);
      // Backing store at dpr for sharpness, CSS at logical size.
      canvas.width = logicalW * dpr; canvas.height = logicalH * dpr;
      canvas.style.width = `${logicalW}px`; canvas.style.height = `${logicalH}px`;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(dpr, dpr);
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, logicalW, logicalH);
        ctx.drawImage(img, 0, 0, logicalW, logicalH);
      }
      return { w: logicalW, h: logicalH, scale };
    }

    const doc = await this.loadSource(pm.srcIndex);
    const page = await doc.getPage(pm.origIndex + 1);
    const base = page.getViewport({ scale: 1, rotation: pm.rotation });
    const scale = targetWidth / base.width;
    // Render at scale * dpr for backing store, but keep logical scale for layout/text layer.
    const vp = page.getViewport({ scale: scale * dpr, rotation: pm.rotation });
    canvas.width = vp.width; canvas.height = vp.height;
    const logicalW = Math.round(vp.width / dpr), logicalH = Math.round(vp.height / dpr);
    canvas.style.width = `${logicalW}px`; canvas.style.height = `${logicalH}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas context not available');
    // Paint white behind every page so dark text never blends into a dark theme.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas, background: 'rgb(255,255,255)' }).promise;
    // Return logical dimensions and scale (CSS px) for text layer / annotations alignment.
    return { w: logicalW, h: logicalH, scale };
  }

  private async renderPage(main: HTMLElement, index: number, pm: PageModel): Promise<void> {
    const pageContainer = document.createElement('div');
    pageContainer.className = 'pdf-page';
    pageContainer.dataset.pageId = pm.id;

    try {
      const canvas = document.createElement('canvas');
      const { w, h, scale } = await this.paintPage(pm, canvas, this.targetWidth());

      const wrapper = document.createElement('div');
      wrapper.className = 'pdf-page-wrap';
      wrapper.style.position = 'relative';
      wrapper.style.width = `${w}px`;
      wrapper.style.height = `${h}px`;
      wrapper.appendChild(canvas);

      // Selectable text layer (real PDF pages only).
      if (pm.srcIndex !== -1) {
        const textLayer = document.createElement('div');
        textLayer.className = 'pdf-text-layer';
        textLayer.style.setProperty('--scale-factor', String(scale));
        textLayer.style.pointerEvents = this.mode === 'select' ? 'auto' : 'none';
        wrapper.appendChild(textLayer);
        try {
          const doc = await this.loadSource(pm.srcIndex);
          const page = await doc.getPage(pm.origIndex + 1);
          const vp = page.getViewport({ scale, rotation: pm.rotation });
          const textContent = await page.getTextContent();
          const TL = (pdfjsLib as unknown as { TextLayer?: new (o: unknown) => { render: () => Promise<void> } }).TextLayer;
          if (TL) { await new TL({ textContentSource: textContent, container: textLayer, viewport: vp }).render(); }
        } catch { /* text layer is an enhancement */ }
      }

      // Annotation layer.
      const annotLayer = document.createElement('div');
      annotLayer.className = 'pdf-annot-layer';
      annotLayer.style.pointerEvents = this.mode === 'select' ? 'none' : 'auto';
      wrapper.appendChild(annotLayer);

      for (const a of this.annotations.filter((a) => a.pageId === pm.id)) {
        if (a.type === 'ink' || a.type === 'line') continue; // vectors handled below
        annotLayer.appendChild(this.makeAnnotEl(a, w, h, scale));
      }
      // Vector (ink/line) layer sits above so its shapes stay clickable in any mode.
      wrapper.appendChild(this.makeVectorLayer(pm, w, h));

      this.wirePlacement(annotLayer, pm, w, h);

      pageContainer.appendChild(wrapper);
      pageContainer.appendChild(this.makePageControls(index, pm));
    } catch (err) {
      console.error(`Failed to render page ${index}:`, err);
      const errMsg = document.createElement('div');
      errMsg.textContent = `Error rendering page ${index + 1}`;
      errMsg.style.cssText = 'padding:20px;color:red';
      pageContainer.appendChild(errMsg);
    }
    main.appendChild(pageContainer);
  }

  private async renderThumb(sidebar: HTMLElement, index: number, pm: PageModel): Promise<void> {
    const thumb = document.createElement('div');
    thumb.className = 'pdf-thumb' + (pm.id === this.activePageId ? ' active' : '');
    thumb.draggable = true;
    thumb.dataset.index = String(index);

    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'pdf-thumb-check';
    check.checked = this.selectedPages.has(pm.id);
    check.title = 'Select for extract';
    check.addEventListener('click', (e) => e.stopPropagation());
    check.addEventListener('change', () => {
      if (check.checked) this.selectedPages.add(pm.id); else this.selectedPages.delete(pm.id);
      // Refresh only the Extract button state.
      const ex = this.host.querySelector('.pdf-tool-group button[title^="Download selected"]') as HTMLButtonElement | null;
      if (ex) ex.disabled = this.selectedPages.size === 0;
    });

    const img = document.createElement('img');
    const key = `${pm.id}:${pm.rotation}`;
    let url = this.thumbCache.get(key);
    if (!url) {
      const c = document.createElement('canvas');
      try { await this.paintPage(pm, c, 180); url = c.toDataURL('image/png'); this.thumbCache.set(key, url); }
      catch { url = ''; }
    }
    if (url) img.src = url;

    const num = document.createElement('span');
    num.className = 'pdf-thumb-num';
    num.textContent = String(index + 1);

    thumb.append(check, img, num);
    thumb.addEventListener('click', () => {
      this.activePageId = pm.id;
      this.host.querySelector(`.pdf-main .pdf-page[data-page-id="${pm.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      this.host.querySelectorAll('.pdf-thumb').forEach((t) => t.classList.remove('active'));
      thumb.classList.add('active');
    });

    // Drag-to-reorder.
    thumb.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/plain', String(index)); thumb.classList.add('dragging'); });
    thumb.addEventListener('dragend', () => thumb.classList.remove('dragging'));
    thumb.addEventListener('dragover', (e) => { e.preventDefault(); thumb.classList.add('drop-target'); });
    thumb.addEventListener('dragleave', () => thumb.classList.remove('drop-target'));
    thumb.addEventListener('drop', (e) => {
      e.preventDefault();
      thumb.classList.remove('drop-target');
      const from = Number(e.dataTransfer?.getData('text/plain'));
      if (Number.isNaN(from) || from === index) return;
      this.reorderPage(from, index);
    });

    sidebar.appendChild(thumb);
  }

  private makePageControls(index: number, pm: PageModel): HTMLElement {
    const ctrls = document.createElement('div');
    ctrls.className = 'pdf-page-ctrls';
    const add = (label: string, fn: () => void, disabled = false, className = '') => {
      const b = document.createElement('button');
      b.textContent = label; b.disabled = disabled;
      if (className) b.className = className;
      b.addEventListener('click', fn);
      ctrls.appendChild(b);
      return b;
    };
    add('↑', () => this.movePage(index, -1), index === 0);
    add('↓', () => this.movePage(index, 1), index === this.pages.length - 1);
    add('Rotate', () => this.rotatePage(index));
    add('Duplicate', () => this.duplicatePage(index));
    add('Delete page', () => this.deletePage(index));
    if (pm.srcIndex !== -1) {
      const ocrBtn = add('OCR text', () => { void this.ocrPage(index, ocrBtn); }, false, 'pdf-ocr-btn');
    }
    const label = document.createElement('span');
    label.textContent = ` Page ${index + 1} of ${this.pages.length}`;
    ctrls.appendChild(label);
    return ctrls;
  }

  // ---- Annotation elements (draggable / editable / resizable) -------------

  private makeAnnotEl(a: Annotation, W: number, H: number, scale: number): HTMLElement {
    const el = document.createElement('div');
    el.className = `pdf-annot pdf-annot-${a.type}` + (a.id === this.selectedId ? ' selected' : '');
    el.style.left = `${a.xR * W}px`;
    el.style.top = `${a.yR * H}px`;
    el.style.width = `${a.wR * W}px`;
    // Text boxes auto-grow with their content, so the resized height is applied
    // as a min-height (box still expands if you type more); other annotations
    // get a fixed height.
    if (a.type === 'text') el.style.minHeight = `${a.hR * H}px`;
    else el.style.height = `${a.hR * H}px`;
    el.style.pointerEvents = 'auto';

    if (a.type === 'text' || a.type === 'box') {
      el.style.fontSize = `${(a.fontSize ?? 14) * scale}px`;
      const body = document.createElement('div');
      body.className = 'pdf-annot-body';
      body.contentEditable = 'true';
      body.textContent = a.text ?? '';
      body.addEventListener('input', () => { a.text = body.textContent ?? ''; this.changed(); });
      body.addEventListener('focus', () => this.selectAnnot(a.id));
      body.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.appendChild(body);
    } else if ((a.type === 'signature' || a.type === 'image') && a.dataUrl) {
      const img = document.createElement('img');
      img.src = a.dataUrl; img.draggable = false;
      el.appendChild(img);
    } else if (a.type === 'rect' || a.type === 'circle') {
      el.style.border = `${(a.strokeWidth ?? 2) * scale}px solid ${a.color ?? '#ef4444'}`;
      el.style.background = 'transparent';
      if (a.type === 'circle') el.style.borderRadius = '50%';
    }

    const dragHandle = (a.type === 'text' || a.type === 'box') ? this.addGrip(el) : el;
    this.enableDrag(dragHandle, a, W, H, el);

    if ((a.type === 'text' || a.type === 'box') && a.id === this.selectedId) el.appendChild(this.addFontControls(a));
    this.addResize(el, a, W, H);

    if (a.id === this.selectedId) {
      const del = document.createElement('button');
      del.className = 'pdf-annot-del'; del.textContent = '✕'; del.title = 'Delete';
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      del.addEventListener('click', (e) => { e.stopPropagation(); this.pushHistory(); this.deleteAnnotation(a.id); });
      el.appendChild(del);
    }

    el.addEventListener('click', (e) => { e.stopPropagation(); this.selectAnnot(a.id); });
    return el;
  }

  /** SVG overlay carrying every ink / line annotation on a page. */
  private makeVectorLayer(pm: PageModel, W: number, H: number): SVGSVGElement {
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'pdf-vector-layer');
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.style.position = 'absolute';
    svg.style.left = '0'; svg.style.top = '0';
    svg.style.pointerEvents = 'none';

    for (const a of this.annotations.filter((x) => x.pageId === pm.id && (x.type === 'ink' || x.type === 'line'))) {
      const pts = a.points ?? [];
      const shape = document.createElementNS(SVGNS, a.type === 'line' ? 'line' : 'path');
      shape.setAttribute('stroke', a.color ?? '#ef4444');
      shape.setAttribute('stroke-width', String(a.strokeWidth ?? 3));
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke-linecap', 'round');
      shape.setAttribute('stroke-linejoin', 'round');
      shape.style.pointerEvents = 'stroke';
      shape.style.cursor = 'move';
      if (a.id === this.selectedId) shape.setAttribute('class', 'selected');
      if (a.type === 'line' && pts[0] && pts[1]) {
        shape.setAttribute('x1', String(pts[0].x * W)); shape.setAttribute('y1', String(pts[0].y * H));
        shape.setAttribute('x2', String(pts[1].x * W)); shape.setAttribute('y2', String(pts[1].y * H));
      } else if (pts.length) {
        shape.setAttribute('d', pts.map((p, i) => `${i ? 'L' : 'M'}${p.x * W} ${p.y * H}`).join(' '));
      }
      this.enableVectorDrag(shape, a, W, H);
      svg.appendChild(shape);
    }
    return svg;
  }

  private enableVectorDrag(shape: SVGElement, a: Annotation, W: number, H: number) {
    shape.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.selectAnnot(a.id, false);
      this.host.focus({ preventScroll: true });
      this.pushHistory();
      const startX = e.clientX, startY = e.clientY;
      const orig = (a.points ?? []).map((p) => ({ ...p }));
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - startX) / W, dy = (ev.clientY - startY) / H;
        a.points = orig.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        // Live update of geometry.
        if (a.type === 'line' && a.points[0] && a.points[1]) {
          shape.setAttribute('x1', String(a.points[0].x * W)); shape.setAttribute('y1', String(a.points[0].y * H));
          shape.setAttribute('x2', String(a.points[1].x * W)); shape.setAttribute('y2', String(a.points[1].y * H));
        } else {
          shape.setAttribute('d', a.points.map((p, i) => `${i ? 'L' : 'M'}${p.x * W} ${p.y * H}`).join(' '));
        }
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        this.changed(); void this.render();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }

  private addGrip(el: HTMLElement): HTMLElement {
    const grip = document.createElement('div');
    grip.className = 'pdf-annot-grip'; grip.textContent = '⠿'; grip.title = 'Drag to move';
    el.appendChild(grip);
    return grip;
  }

  private addFontControls(a: Annotation): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'pdf-annot-font';
    const mk = (label: string, delta: number) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        a.fontSize = Math.max(6, Math.min(72, (a.fontSize ?? 14) + delta));
        this.changed(); void this.render();
      });
      return b;
    };
    bar.append(mk('A−', -2), mk('A+', 2));
    return bar;
  }

  private enableDrag(handle: HTMLElement, a: Annotation, W: number, H: number, el: HTMLElement) {
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      // Select on press (long-press menu / shortcuts act on it) and keep
      // keyboard focus in the editor so the shell's shortcuts apply.
      const wasSelected = this.selectedId === a.id;
      this.selectAnnot(a.id, false);
      this.host.focus({ preventScroll: true });
      this.pushHistory();
      const startX = e.clientX, startY = e.clientY;
      const ox = a.xR, oy = a.yR;
      const move = (ev: PointerEvent) => {
        a.xR = Math.max(0, Math.min(0.999, ox + (ev.clientX - startX) / W));
        a.yR = Math.max(0, Math.min(0.999, oy + (ev.clientY - startY) / H));
        el.style.left = `${a.xR * W}px`;
        el.style.top = `${a.yR * H}px`;
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        this.changed();
        if (!wasSelected) void this.render(); // show selection chrome
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }

  private addResize(el: HTMLElement, a: Annotation, W: number, H: number) {
    const h = document.createElement('div');
    h.className = 'pdf-annot-resize';
    h.style.touchAction = 'none';
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.pushHistory();
      const startX = e.clientX, startY = e.clientY;
      const ow = a.wR, oh = a.hR;
      const move = (ev: PointerEvent) => {
        a.wR = Math.max(0.02, ow + (ev.clientX - startX) / W);
        a.hR = Math.max(0.02, oh + (ev.clientY - startY) / H);
        el.style.width = `${a.wR * W}px`;
        // Text grows with content, so drive its min-height; others get a fixed height.
        if (a.type === 'text') el.style.minHeight = `${a.hR * H}px`;
        else el.style.height = `${a.hR * H}px`;
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        this.changed();
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
    el.appendChild(h);
  }

  private selectAnnot(id: string, rerender = true) {
    if (this.selectedId === id) return;
    this.selectedId = id;
    const a = this.annotations.find((x) => x.id === id);
    if (a) this.activePageId = a.pageId;
    if (rerender) void this.render();
  }

  // ---- Placement (adding new annotations) ---------------------------------

  private wirePlacement(layer: HTMLElement, pm: PageModel, W: number, H: number) {
    const rel = (e: PointerEvent) => {
      const rect = layer.getBoundingClientRect();
      return { x: (e.clientX - rect.left) / W, y: (e.clientY - rect.top) / H };
    };

    if (this.mode === 'text' || this.mode === 'box') {
      layer.addEventListener('pointerdown', (e) => {
        if (e.target !== layer) return;
        const p = rel(e);
        this.pushHistory();
        const a: Annotation = {
          id: uid(), pageId: pm.id, type: this.mode as 'text' | 'box',
          xR: p.x, yR: p.y, wR: 0.28, hR: 0.05, text: '', fontSize: 14,
        };
        this.annotations.push(a);
        this.selectedId = a.id; this.activePageId = pm.id; this.mode = 'select';
        this.changed();
        void this.render().then(() => {
          (this.host.querySelector('.pdf-annot.selected .pdf-annot-body') as HTMLElement | null)?.focus();
        });
      });
    } else if (this.mode === 'highlight' || this.mode === 'rect' || this.mode === 'circle') {
      let sx = 0, sy = 0, drawing = false, temp: HTMLDivElement | null = null;
      const kind = this.mode;
      layer.addEventListener('pointerdown', (e) => {
        if (e.target !== layer) return;
        const rect = layer.getBoundingClientRect();
        sx = e.clientX - rect.left; sy = e.clientY - rect.top; drawing = true;
        temp = document.createElement('div');
        temp.className = `pdf-annot pdf-annot-${kind}`;
        if (kind === 'rect' || kind === 'circle') {
          temp.style.border = `${this.drawWidth}px solid ${this.drawColor}`;
          temp.style.background = 'transparent';
          if (kind === 'circle') temp.style.borderRadius = '50%';
        }
        temp.style.left = `${sx}px`; temp.style.top = `${sy}px`;
        layer.appendChild(temp);
      });
      layer.addEventListener('pointermove', (e) => {
        if (!drawing || !temp) return;
        const rect = layer.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        temp.style.left = `${Math.min(sx, cx)}px`; temp.style.top = `${Math.min(sy, cy)}px`;
        temp.style.width = `${Math.abs(cx - sx)}px`; temp.style.height = `${Math.abs(cy - sy)}px`;
      });
      layer.addEventListener('pointerup', (e) => {
        if (!drawing) return;
        drawing = false;
        const rect = layer.getBoundingClientRect();
        const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
        const left = Math.min(sx, cx), top = Math.min(sy, cy);
        const w = Math.abs(cx - sx), h = Math.abs(cy - sy);
        temp?.remove();
        if (w > 5 && h > 5) {
          this.pushHistory();
          this.annotations.push({
            id: uid(), pageId: pm.id, type: kind,
            xR: left / W, yR: top / H, wR: w / W, hR: h / H,
            color: kind === 'highlight' ? undefined : this.drawColor,
            strokeWidth: kind === 'highlight' ? undefined : this.drawWidth,
          });
          this.activePageId = pm.id;
          this.changed(); void this.render();
        }
      });
    } else if (this.mode === 'line') {
      let start: Pt | null = null, temp: SVGLineElement | null = null, svg: SVGSVGElement | null = null;
      layer.addEventListener('pointerdown', (e) => {
        if (e.target !== layer) return;
        start = rel(e);
        svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('class', 'pdf-vector-layer');
        svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
        svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H));
        temp = document.createElementNS(SVGNS, 'line');
        temp.setAttribute('stroke', this.drawColor); temp.setAttribute('stroke-width', String(this.drawWidth));
        temp.setAttribute('stroke-linecap', 'round');
        temp.setAttribute('x1', String(start.x * W)); temp.setAttribute('y1', String(start.y * H));
        temp.setAttribute('x2', String(start.x * W)); temp.setAttribute('y2', String(start.y * H));
        svg.appendChild(temp); layer.appendChild(svg);
      });
      layer.addEventListener('pointermove', (e) => {
        if (!start || !temp) return;
        const p = rel(e);
        temp.setAttribute('x2', String(p.x * W)); temp.setAttribute('y2', String(p.y * H));
      });
      layer.addEventListener('pointerup', (e) => {
        if (!start) return;
        const p = rel(e); svg?.remove();
        if (Math.hypot((p.x - start.x) * W, (p.y - start.y) * H) > 4) {
          this.pushHistory();
          this.annotations.push({
            id: uid(), pageId: pm.id, type: 'line',
            xR: 0, yR: 0, wR: 0, hR: 0, points: [start, p],
            color: this.drawColor, strokeWidth: this.drawWidth,
          });
          this.activePageId = pm.id; this.changed(); void this.render();
        }
        start = null; temp = null; svg = null;
      });
    } else if (this.mode === 'ink') {
      let pts: Pt[] = [], drawing = false, temp: SVGPathElement | null = null, svg: SVGSVGElement | null = null;
      const draw = () => temp?.setAttribute('d', pts.map((p, i) => `${i ? 'L' : 'M'}${p.x * W} ${p.y * H}`).join(' '));
      layer.addEventListener('pointerdown', (e) => {
        if (e.target !== layer) return;
        drawing = true; pts = [rel(e)];
        svg = document.createElementNS(SVGNS, 'svg');
        svg.setAttribute('class', 'pdf-vector-layer');
        svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
        svg.setAttribute('width', String(W)); svg.setAttribute('height', String(H));
        temp = document.createElementNS(SVGNS, 'path');
        temp.setAttribute('stroke', this.drawColor); temp.setAttribute('stroke-width', String(this.drawWidth));
        temp.setAttribute('fill', 'none'); temp.setAttribute('stroke-linecap', 'round'); temp.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(temp); layer.appendChild(svg); draw();
      });
      layer.addEventListener('pointermove', (e) => { if (!drawing) return; pts.push(rel(e)); draw(); });
      layer.addEventListener('pointerup', () => {
        if (!drawing) return;
        drawing = false; svg?.remove();
        if (pts.length > 1) {
          this.pushHistory();
          this.annotations.push({
            id: uid(), pageId: pm.id, type: 'ink',
            xR: 0, yR: 0, wR: 0, hR: 0, points: pts,
            color: this.drawColor, strokeWidth: this.drawWidth,
          });
          this.activePageId = pm.id; this.changed(); void this.render();
        }
        pts = []; temp = null; svg = null;
      });
    }
  }

  // ---- Content actions: signature / image / merge / extract ---------------

  private async beginSignature(): Promise<void> {
    const dataUrl = await this.signatureModal();
    if (!dataUrl) return;
    const pm = this.pages.find((p) => p.id === this.activePageId) ?? this.pages[0];
    if (!pm) return;
    this.pushHistory();
    this.annotations.push({ id: uid(), pageId: pm.id, type: 'signature', xR: 0.35, yR: 0.8, wR: 0.3, hR: 0.1, dataUrl });
    this.mode = 'select'; this.changed(); await this.render();
  }

  private async insertImage(asPage: boolean): Promise<void> {
    const file = await this.pickFile('image/png,image/jpeg');
    if (!file) return;
    const dataUrl = await this.fileToDataUrl(file);
    const img = await this.loadImage(dataUrl);
    this.pushHistory();
    if (asPage) {
      const pm: PageModel = { id: uid(), srcIndex: -1, origIndex: -1, rotation: 0, imageDataUrl: dataUrl, imageW: img.width, imageH: img.height };
      const at = this.pages.findIndex((p) => p.id === this.activePageId);
      this.pages.splice(at < 0 ? this.pages.length : at + 1, 0, pm);
      this.activePageId = pm.id;
    } else {
      const pm = this.pages.find((p) => p.id === this.activePageId) ?? this.pages[0];
      if (!pm) return;
      // Fit width to ~40% of the page, preserving aspect.
      const wR = 0.4, hR = wR * (img.height / img.width) * 0.75; // rough visual aspect
      this.annotations.push({ id: uid(), pageId: pm.id, type: 'image', xR: 0.3, yR: 0.3, wR, hR, dataUrl });
    }
    this.mode = 'select'; this.changed(); await this.render();
  }

  private async mergePdf(): Promise<void> {
    const file = await this.pickFile('application/pdf');
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const idx = this.sources.length;
    this.sources.push(bytes);
    const doc = await this.loadSource(idx);
    this.pushHistory();
    for (let i = 0; i < doc.numPages; i++) this.pages.push({ id: uid(), srcIndex: idx, origIndex: i, rotation: 0 });
    this.changed(); await this.render();
  }

  // Extract the text of every page and save it as an editable .docx. Text is
  // grouped into lines by vertical position; pages are separated by page breaks.
  private async exportDocx(): Promise<void> {
    const { Document, Packer, Paragraph, TextRun } = await import('docx');
    const paras: InstanceType<typeof Paragraph>[] = [];

    for (let pi = 0; pi < this.pages.length; pi++) {
      const pm = this.pages[pi]!;
      if (pm.srcIndex === -1) continue; // image-only page: no extractable text
      const doc = await this.loadSource(pm.srcIndex);
      const page = await doc.getPage(pm.origIndex + 1);
      const tc = await page.getTextContent();

      // Group text items into lines by their y coordinate (transform[5]).
      const lines = new Map<number, { x: number; s: string }[]>();
      for (const item of tc.items as Array<{ str: string; transform: number[] }>) {
        if (!item.str) continue;
        const y = Math.round(item.transform[5]!);
        const x = item.transform[4]!;
        (lines.get(y) ?? lines.set(y, []).get(y)!).push({ x, s: item.str });
      }
      const ys = [...lines.keys()].sort((a, b) => b - a); // top → bottom (PDF y grows upward)
      if (ys.length === 0) {
        paras.push(new Paragraph({ children: [new TextRun('')] }));
      } else {
        for (const y of ys) {
          const text = lines.get(y)!.sort((a, b) => a.x - b.x).map((p) => p.s).join('').replace(/\s+/g, ' ').trim();
          paras.push(new Paragraph({ children: [new TextRun(text)] }));
        }
      }
      // Page break between pages (not after the last).
      if (pi < this.pages.length - 1) paras.push(new Paragraph({ children: [new TextRun({ text: '', break: 0 })], pageBreakBefore: true }));
    }
    if (paras.length === 0) paras.push(new Paragraph({ children: [new TextRun('')] }));

    const out = new Document({ sections: [{ children: paras }] });
    const blob = await Packer.toBlob(out);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = this.name.replace(/\.[^.]+$/, '') + '.docx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private async extractSelected(): Promise<void> {
    const selected = this.pages.filter((p) => this.selectedPages.has(p.id));
    if (!selected.length) return;
    const bytes = await this.buildPdf(selected);
    if (!bytes) return;
    const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'extract.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private pickFile(accept: string): Promise<File | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file'; input.accept = accept; input.style.display = 'none';
      input.addEventListener('change', () => { resolve(input.files?.[0] ?? null); input.remove(); });
      document.body.appendChild(input); input.click();
    });
  }

  private fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  private loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  private signatureModal(): Promise<string | null> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal sig-modal" role="dialog" aria-modal="true">
          <h3>Add your signature</h3>
          <div class="sig-tabs">
            <button type="button" class="sig-tab active" data-tab="draw">Draw</button>
            <button type="button" class="sig-tab" data-tab="type">Type</button>
          </div>
          <div class="sig-pane" data-pane="draw">
            <canvas class="sig-canvas" width="500" height="180"></canvas>
            <button type="button" class="sig-clear">Clear</button>
          </div>
          <div class="sig-pane" data-pane="type" style="display:none">
            <input type="text" class="sig-type-input" placeholder="Type your name">
            <div class="sig-type-preview">Signature</div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn-cancel">Cancel</button>
            <button type="button" class="btn-confirm">Add signature</button>
          </div>
        </div>`;

      const canvas = overlay.querySelector('.sig-canvas') as HTMLCanvasElement;
      const cctx = canvas.getContext('2d')!;
      cctx.lineWidth = 2.5; cctx.lineCap = 'round'; cctx.strokeStyle = '#111';
      let drawing = false, dirty = false;
      const pos = (e: PointerEvent) => {
        const r = canvas.getBoundingClientRect();
        return { x: (e.clientX - r.left) * (canvas.width / r.width), y: (e.clientY - r.top) * (canvas.height / r.height) };
      };
      canvas.addEventListener('pointerdown', (e) => { drawing = true; dirty = true; const p = pos(e); cctx.beginPath(); cctx.moveTo(p.x, p.y); });
      canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); cctx.lineTo(p.x, p.y); cctx.stroke(); });
      const stop = () => { drawing = false; };
      canvas.addEventListener('pointerup', stop);
      canvas.addEventListener('pointerleave', stop);
      overlay.querySelector('.sig-clear')?.addEventListener('click', () => { cctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; });

      let activeTab: 'draw' | 'type' = 'draw';
      const typeInput = overlay.querySelector('.sig-type-input') as HTMLInputElement;
      const typePreview = overlay.querySelector('.sig-type-preview') as HTMLElement;
      typeInput.addEventListener('input', () => { typePreview.textContent = typeInput.value || 'Signature'; });
      overlay.querySelectorAll('.sig-tab').forEach((t) => t.addEventListener('click', () => {
        overlay.querySelectorAll('.sig-tab').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        activeTab = (t as HTMLElement).dataset.tab as 'draw' | 'type';
        (overlay.querySelector('[data-pane="draw"]') as HTMLElement).style.display = activeTab === 'draw' ? '' : 'none';
        (overlay.querySelector('[data-pane="type"]') as HTMLElement).style.display = activeTab === 'type' ? '' : 'none';
      }));

      const close = (v: string | null) => { overlay.remove(); resolve(v); };
      overlay.querySelector('.btn-cancel')?.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      overlay.querySelector('.btn-confirm')?.addEventListener('click', () => {
        if (activeTab === 'draw') {
          if (!dirty) { close(null); return; }
          close(canvas.toDataURL('image/png'));
        } else {
          const name = typeInput.value.trim();
          if (!name) { close(null); return; }
          const c = document.createElement('canvas');
          c.width = 500; c.height = 160;
          const g = c.getContext('2d')!;
          g.fillStyle = '#111';
          g.font = 'italic 64px "Segoe Script", "Brush Script MT", cursive';
          g.textBaseline = 'middle';
          g.fillText(name, 20, 90);
          close(c.toDataURL('image/png'));
        }
      });
      document.body.appendChild(overlay);
    });
  }

  // ---- Page operations ----------------------------------------------------

  private movePage(index: number, delta: number): void {
    const j = index + delta;
    if (j < 0 || j >= this.pages.length) return;
    this.pushHistory();
    const a = this.pages[index], b = this.pages[j];
    if (!a || !b) return;
    this.pages[index] = b; this.pages[j] = a;
    this.changed(); void this.render();
  }

  private reorderPage(from: number, to: number): void {
    if (from === to) return;
    this.pushHistory();
    const [moved] = this.pages.splice(from, 1);
    if (moved) this.pages.splice(to, 0, moved);
    this.changed(); void this.render();
  }

  private rotatePage(index: number): void {
    const p = this.pages[index];
    if (!p) return;
    this.pushHistory();
    p.rotation = ((p.rotation + 90) % 360) as Rotation;
    this.changed(); void this.render();
  }

  private duplicatePage(index: number): void {
    const p = this.pages[index];
    if (!p) return;
    this.pushHistory();
    const copy: PageModel = { ...p, id: uid() };
    this.pages.splice(index + 1, 0, copy);
    // Clone this page's annotations onto the new page.
    for (const a of this.annotations.filter((a) => a.pageId === p.id)) {
      this.annotations.push({ ...structuredClone(a), id: uid(), pageId: copy.id });
    }
    this.changed(); void this.render();
  }

  private deletePage(index: number): void {
    if (this.pages.length === 1) return;
    const p = this.pages[index];
    if (!p) return;
    this.pushHistory();
    this.pages.splice(index, 1);
    this.annotations = this.annotations.filter((a) => a.pageId !== p.id);
    this.selectedPages.delete(p.id);
    this.changed(); void this.render();
  }

  private deleteAnnotation(id: string): void {
    const i = this.annotations.findIndex((a) => a.id === id);
    if (i >= 0) {
      this.annotations.splice(i, 1);
      if (this.selectedId === id) this.selectedId = null;
      this.changed(); void this.render();
    }
  }

  // ---- OCR ----------------------------------------------------------------

  private async ocrPage(index: number, btn: HTMLButtonElement): Promise<void> {
    const pm = this.pages[index];
    if (!pm || pm.srcIndex === -1) return;
    if (this.ocrInProgress.get(pm.id)) return;
    this.ocrInProgress.set(pm.id, true);

    const origLabel = btn.textContent ?? 'OCR text';
    btn.disabled = true; btn.textContent = 'Checking…';

    try {
      const doc = await this.loadSource(pm.srcIndex);
      const page = await doc.getPage(pm.origIndex + 1);

      // B12: Guard against OCR-ing pages that already have real text.
      const textContent = await page.getTextContent();
      const existingText = textContent.items.map((item: unknown) => (item as { str?: string }).str ?? '').join('');
      if (existingText.trim().length > 20) {
        // Page already has meaningful text — skip OCR.
        btn.textContent = 'Already has text';
        setTimeout(() => { btn.textContent = origLabel; btn.disabled = false; this.ocrInProgress.delete(pm.id); }, 2000);
        return;
      }

      btn.textContent = 'OCR… 0%';
      const base = page.getViewport({ scale: 1, rotation: pm.rotation });
      // B13: Raise OCR render resolution for better accuracy.
      const targetScale = Math.min(3.0, 3000 / base.width);
      const vp = page.getViewport({ scale: targetScale, rotation: pm.rotation });

      const off = document.createElement('canvas');
      off.width = vp.width; off.height = vp.height;
      const ctx = off.getContext('2d');
      if (!ctx) throw new Error('Canvas context not available');
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, off.width, off.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas: off, background: 'rgb(255,255,255)' }).promise;

      // CSP: tesseract.js worker/core/lang served from cdn.jsdelivr.net (allowed in _headers).
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng', 1, {
        workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/worker.min.js',
        corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1',
        langPath: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int',
        logger: (m) => {
          if (m.status === 'recognizing text' && typeof m.progress === 'number') btn.textContent = `OCR… ${Math.round(m.progress * 100)}%`;
        },
      });
      const { data } = await worker.recognize(off);
      await worker.terminate();

      this.pushHistory();
      this.annotations = this.annotations.filter((a) => !(a.pageId === pm.id && a.ocr));
      for (const line of data.lines) {
        const txt = line.text.trim();
        if (!txt) continue;
        const bbox = line.bbox;
        const lineHeight = bbox.y1 - bbox.y0;
        this.annotations.push({
          id: uid(), pageId: pm.id, type: 'text',
          xR: bbox.x0 / off.width, yR: bbox.y0 / off.height,
          wR: (bbox.x1 - bbox.x0) / off.width, hR: lineHeight / off.height,
          text: txt, fontSize: Math.max(6, Math.min(72, Math.round(lineHeight / targetScale))), ocr: true,
        });
      }
      btn.textContent = 'OCR ✓';
      this.changed(); await this.render();
    } catch (err) {
      console.error('OCR failed:', err);
      btn.textContent = 'OCR failed';
      setTimeout(() => { btn.textContent = origLabel; btn.disabled = false; this.ocrInProgress.delete(pm.id); }, 2000);
      return;
    }
    setTimeout(() => { btn.textContent = origLabel; btn.disabled = false; this.ocrInProgress.delete(pm.id); }, 2000);
  }

  // ---- Export -------------------------------------------------------------

  /** Build a PDF from the given page models (all pages, or a subset for extract). */
  private async buildPdf(pageModels: PageModel[]): Promise<Uint8Array | null> {
    try {
      const newDoc = await PDFDocument.create();
      const font = await newDoc.embedFont(StandardFonts.Helvetica);
      const srcCache = new Map<number, PDFDocument>();
      const loadSrc = async (i: number) => {
        const hit = srcCache.get(i);
        if (hit) return hit;
        const bytes = this.sources[i];
        if (!bytes) throw new Error(`Missing source ${i}`);
        const d = await PDFDocument.load(bytes);
        srcCache.set(i, d);
        return d;
      };

      for (const pm of pageModels) {
        let page;
        if (pm.srcIndex === -1 && pm.imageDataUrl) {
          const img = await this.embedImage(newDoc, pm.imageDataUrl);
          const w = pm.imageW ?? img.width, h = pm.imageH ?? img.height;
          page = newDoc.addPage([w, h]);
          page.drawImage(img, { x: 0, y: 0, width: w, height: h });
        } else {
          const srcDoc = await loadSrc(pm.srcIndex);
          const [copied] = await newDoc.copyPages(srcDoc, [pm.origIndex]);
          if (!copied) continue;
          if (pm.rotation !== 0) copied.setRotation(degrees(pm.rotation));
          newDoc.addPage(copied);
          page = copied;
        }

        const { width, height } = page.getSize();
        for (const a of this.annotations.filter((a) => a.pageId === pm.id)) {
          const col = a.color ? hexToRgb(a.color) : null;
          if (a.type === 'box') {
            page.drawRectangle({ x: a.xR * width, y: (1 - (a.yR + a.hR)) * height, width: a.wR * width, height: a.hR * height, color: rgb(1, 1, 1) });
          }
          if ((a.type === 'text' || a.type === 'box') && a.text) {
            const size = a.fontSize ?? 14;
            let y = (1 - a.yR) * height - size;
            for (const line of a.text.split('\n')) {
              page.drawText(line, { x: a.xR * width + 2, y, size, font, color: rgb(0, 0, 0) });
              y -= size * 1.2;
            }
          } else if (a.type === 'highlight') {
            page.drawRectangle({ x: a.xR * width, y: (1 - (a.yR + a.hR)) * height, width: a.wR * width, height: a.hR * height, color: rgb(1, 0.9, 0.2), opacity: 0.35 });
          } else if (a.type === 'rect' && col) {
            page.drawRectangle({ x: a.xR * width, y: (1 - (a.yR + a.hR)) * height, width: a.wR * width, height: a.hR * height, borderColor: rgb(col.r, col.g, col.b), borderWidth: a.strokeWidth ?? 2 });
          } else if (a.type === 'circle' && col) {
            page.drawEllipse({ x: (a.xR + a.wR / 2) * width, y: (1 - (a.yR + a.hR / 2)) * height, xScale: (a.wR * width) / 2, yScale: (a.hR * height) / 2, borderColor: rgb(col.r, col.g, col.b), borderWidth: a.strokeWidth ?? 2 });
          } else if (a.type === 'line' && col && a.points && a.points[0] && a.points[1]) {
            const [p0, p1] = a.points;
            page.drawLine({ start: { x: p0.x * width, y: (1 - p0.y) * height }, end: { x: p1.x * width, y: (1 - p1.y) * height }, thickness: a.strokeWidth ?? 3, color: rgb(col.r, col.g, col.b) });
          } else if (a.type === 'ink' && col && a.points && a.points.length > 1) {
            for (let i = 1; i < a.points.length; i++) {
              const p = a.points[i - 1]!, q = a.points[i]!;
              page.drawLine({ start: { x: p.x * width, y: (1 - p.y) * height }, end: { x: q.x * width, y: (1 - q.y) * height }, thickness: a.strokeWidth ?? 3, color: rgb(col.r, col.g, col.b) });
            }
          } else if ((a.type === 'signature' || a.type === 'image') && a.dataUrl) {
            const img = await this.embedImage(newDoc, a.dataUrl);
            page.drawImage(img, { x: a.xR * width, y: (1 - (a.yR + a.hR)) * height, width: a.wR * width, height: a.hR * height });
          }
        }
      }
      return await newDoc.save();
    } catch (err) {
      console.error('PDF build failed:', err);
      return null;
    }
  }

  private async embedImage(doc: PDFDocument, dataUrl: string): Promise<PDFImage> {
    const bytes = await (await fetch(dataUrl)).arrayBuffer();
    return dataUrl.startsWith('data:image/jpeg') || dataUrl.startsWith('data:image/jpg')
      ? doc.embedJpg(bytes)
      : doc.embedPng(bytes);
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    const bytes = await this.buildPdf(this.pages);
    if (!bytes) return null;
    return { blob: new Blob([bytes as BlobPart], { type: 'application/pdf' }), contentType: 'application/pdf' };
  }
}
