import './styles/presentation.css';
import type { DocEditor } from './registry';
import { getAppClipboard, setAppClipboard, type EditCommands } from './editCommands';
import { isZip, readPptx } from './presentation/pptxRead';
import { writePptx } from './presentation/pptxWrite';
import { deckToPdf } from './presentation/canvas';
import {
  PT_PX, geomPath, isLine, newEl, para, style, uid,
  elText, type Align, type Deck, type El, type Media, type Para, type Slide, type Style,
} from './presentation/model';

/** App-clipboard payloads; media travels with them so images paste into other decks too. */
interface ElClip { el: El; media: Record<string, Media>; }
interface SlideClip { slide: Slide; media: Record<string, Media>; }

// Visual .pptx editor: thumbnail strip, scaled slide canvas with absolutely
// positioned elements (select / drag / resize / inline text editing), a
// formatting toolbar, speaker notes and a fullscreen slideshow. Reads and
// writes OOXML itself (see ./presentation/*), and renders PDFs via canvas.

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const SVG_NS = 'http://www.w3.org/2000/svg';
type Layout = 'title' | 'content' | 'blank';
type DragMode = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

// Normalize any CSS color ('rgb(..)', names, #abc) to 'RRGGBB'.
const colorCtx = document.createElement('canvas').getContext('2d');
function cssHex(c: string): string {
  if (!colorCtx) return '000000';
  colorCtx.fillStyle = '#000000';
  colorCtx.fillStyle = c;
  const v = String(colorCtx.fillStyle);
  if (v.startsWith('#')) return v.slice(1).toUpperCase();
  const m = v.match(/\d+/g) ?? ['0', '0', '0'];
  return m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function applyStyle(node: HTMLElement, s: Style): void {
  node.style.fontSize = `${s.sz * PT_PX}px`;
  node.style.color = `#${s.color}`;
  node.style.fontFamily = `"${s.font}", Arial, sans-serif`;
  node.style.fontWeight = s.b ? '700' : '400';
  node.style.fontStyle = s.i ? 'italic' : 'normal';
  node.style.textDecoration = s.u ? 'underline' : 'none';
}

/** Effective run style of a node inside a contentEditable text box (innermost wins). */
function styleOfNode(start: HTMLElement, root: HTMLElement, fallback: Style): Style {
  const s: Partial<Style> = {};
  for (let n: HTMLElement | null = start; n; n = n.parentElement) {
    const st = n.style, tag = n.tagName;
    if (s.b === undefined) {
      if (tag === 'B' || tag === 'STRONG') s.b = true;
      else if (st.fontWeight) s.b = st.fontWeight === 'bold' || Number(st.fontWeight) >= 600;
    }
    if (s.i === undefined) {
      if (tag === 'I' || tag === 'EM') s.i = true;
      else if (st.fontStyle) s.i = st.fontStyle === 'italic';
    }
    const deco = st.textDecorationLine || st.textDecoration;
    if (s.u === undefined) {
      if (tag === 'U') s.u = true;
      else if (deco) s.u = deco.includes('underline');
    }
    const col = tag === 'FONT' ? n.getAttribute('color') : st.color;
    if (s.color === undefined && col) s.color = cssHex(col);
    if (s.sz === undefined && st.fontSize.endsWith('px')) s.sz = Math.round((parseFloat(st.fontSize) / PT_PX) * 10) / 10;
    if (s.font === undefined && st.fontFamily) s.font = st.fontFamily.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
    if (n === root) break;
  }
  return { ...fallback, ...s };
}

const sameStyle = (a: Style, b: Style): boolean =>
  a.sz === b.sz && a.color === b.color && a.font === b.font && a.b === b.b && a.i === b.i && a.u === b.u;

/** contentEditable DOM → paragraphs (handles div/p blocks, <br>, b/i/u/font tags and inline styles). */
function readParas(root: HTMLElement, fallback: Style): Para[] {
  const paras: Para[] = [];
  let cur: Para | null = null;
  const start = (block: HTMLElement | null): Para => {
    const ref = block ?? root;
    cur = {
      runs: [], algn: (ref.dataset.algn as Align) || 'l', bu: ref.dataset.bu ?? '',
      lvl: Number(ref.dataset.lvl ?? 0) || 0, def: styleOfNode(ref, root, fallback),
    };
    paras.push(cur);
    return cur;
  };
  const walk = (node: Node, block: HTMLElement | null): void => {
    for (const ch of Array.from(node.childNodes)) {
      if (ch.nodeType === Node.TEXT_NODE) {
        const text = (ch.textContent ?? '').replace(/\u200b/g, '');
        if (!text) continue;
        const p: Para = cur ?? start(block);
        const s = styleOfNode(ch.parentElement ?? root, root, fallback);
        const last = p.runs[p.runs.length - 1];
        if (last && sameStyle(last, s)) last.text += text;
        else p.runs.push({ ...s, text });
      } else if (ch instanceof HTMLElement) {
        if (ch.tagName === 'BR') {
          if (!cur) start(block);
          if (ch !== ch.parentNode?.lastChild) cur = null;
        } else if (ch.tagName === 'DIV' || ch.tagName === 'P') {
          cur = null;
          const before = paras.length;
          walk(ch, ch);
          if (paras.length === before) start(ch);
          cur = null;
        } else walk(ch, block);
      }
    }
  };
  walk(root, null);
  if (!paras.length) paras.push(para('', fallback));
  return paras;
}

export class PresentationEditor implements DocEditor {
  private deck: Deck | null = null;
  private cur = 0;
  private selId: string | null = null;
  private editing: { el: El; box: HTMLElement; text: HTMLElement; before: string } | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private lastPush = { key: '', t: 0 };
  private urls = new Map<string, string>();
  private scale = 1;
  private cleanups: (() => void)[] = [];
  private drag: {
    mode: DragMode; el: El; sx: number; sy: number; o: { x: number; y: number; w: number; h: number };
    moved: boolean; before: string; wasSelected: boolean; shift: boolean;
  } | null = null;
  private savedRange: Range | null = null;
  private notesBefore = '';
  private dragSlide = -1;
  private presenting = false;
  private dead = false;
  // True when the thumbnail strip was the last thing interacted with (slide-level commands).
  private stripActive = false;
  private lastClipText = '';
  private downAt = 0;

  private root!: HTMLElement;
  private strip!: HTMLElement;
  private stage!: HTMLElement;
  private viewport!: HTMLElement;
  private slideEl!: HTMLElement;
  private notes!: HTMLTextAreaElement;
  private fileInput!: HTMLInputElement;
  private fmtButtons: HTMLElement[] = [];
  private bgInput!: HTMLInputElement;
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private delSlideBtn!: HTMLButtonElement;

  private constructor(private host: HTMLElement, private name: string, private onChange?: () => void) {}

  static async open(host: HTMLElement, blob: Blob, name: string, onChange?: () => void): Promise<PresentationEditor> {
    const ed = new PresentationEditor(host, name, onChange);
    await ed.load(blob);
    return ed;
  }

  destroy(): void {
    this.dead = true;
    this.cleanups.forEach((f) => f());
    this.cleanups = [];
    this.urls.forEach((u) => URL.revokeObjectURL(u));
    this.urls.clear();
    this.host.innerHTML = '';
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    if (!this.deck) return null;
    this.syncEdit();
    const bytes = writePptx(this.deck, this.name.replace(/\.[^.]+$/, ''));
    return { blob: new Blob([bytes as BlobPart], { type: PPTX_MIME }), contentType: PPTX_MIME };
  }

  async pdfBlob(): Promise<Blob | null> {
    if (!this.deck) return null;
    this.syncEdit();
    return deckToPdf(this.deck);
  }

  // ---- loading ------------------------------------------------------------

  private async load(blob: Blob): Promise<void> {
    this.host.innerHTML = '';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length === 0) {
      this.deck = { w: 1280, h: 720, slides: [], media: {}, font: 'Calibri', titleFont: 'Calibri Light' };
      this.deck.slides.push(this.makeSlide('title'));
    } else if (!isZip(bytes)) {
      this.message('This looks like a legacy binary PowerPoint file (.ppt), which can\'t be opened in the browser. '
        + 'Open it in PowerPoint, Keynote or Google Slides and save it as .pptx, then upload that copy to edit it here.');
      return;
    } else {
      try {
        this.deck = readPptx(bytes);
        if (!this.deck.slides.length) this.deck.slides.push(this.makeSlide('title'));
      } catch (err) {
        console.error('Failed to parse presentation:', err);
        this.message('Sorry, this presentation could not be read. It may be damaged or not a PowerPoint (.pptx) file.');
        return;
      }
    }
    this.build();
  }

  private message(text: string): void {
    const box = h('div', 'pres-message');
    box.append(h('strong', '', 'Can\'t open this presentation'), h('p', '', text));
    this.host.appendChild(box);
  }

  private makeSlide(kind: Layout): Slide {
    const { w: W, h: H, font, titleFont } = this.deck!;
    const els: El[] = [];
    const ts = style({ sz: kind === 'title' ? 44 : 40, font: titleFont });
    const bs = style({ sz: kind === 'title' ? 24 : 28, font, color: kind === 'title' ? '595959' : '000000' });
    if (kind === 'title') {
      els.push(newEl({ x: W * 0.125, y: H * 0.22, w: W * 0.75, h: H * 0.32, ph: 'ctrTitle', anchor: 'b', paras: [para('', ts, { algn: 'ctr' })] }));
      els.push(newEl({ x: W * 0.125, y: H * 0.57, w: W * 0.75, h: H * 0.2, ph: 'subTitle', paras: [para('', bs, { algn: 'ctr' })] }));
    } else if (kind === 'content') {
      els.push(newEl({ x: W * 0.07, y: H * 0.05, w: W * 0.86, h: H * 0.18, ph: 'title', anchor: 'ctr', paras: [para('', ts)] }));
      els.push(newEl({ x: W * 0.07, y: H * 0.26, w: W * 0.86, h: H * 0.64, ph: 'body', paras: [para('', bs, { bu: '•' })] }));
    }
    return { id: uid(), els, bg: 'FFFFFF', bgMedia: '', notes: '' };
  }

  // ---- shell --------------------------------------------------------------

  private build(): void {
    this.root = h('div', 'pres-editor');
    const toolbar = this.buildToolbar();
    const body = h('div', 'pres-body');
    this.strip = h('div', 'pres-strip');
    const main = h('div', 'pres-main');
    this.stage = h('div', 'pres-stage');
    this.viewport = h('div', 'pres-viewport');
    this.slideEl = h('div', 'pres-slide pres-slide-edit');
    this.viewport.appendChild(this.slideEl);
    this.stage.appendChild(this.viewport);
    this.notes = h('textarea', 'pres-notes');
    this.notes.placeholder = 'Speaker notes…';
    this.notes.rows = 3;
    main.append(this.stage, this.notes);
    body.append(this.strip, main);
    this.fileInput = h('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'image/*';
    this.fileInput.hidden = true;
    this.root.append(toolbar, body, this.fileInput);
    this.host.appendChild(this.root);

    // Stage interactions
    this.slideEl.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    this.slideEl.addEventListener('pointermove', (e) => this.onPointerMove(e));
    this.slideEl.addEventListener('pointerup', (e) => this.onPointerUp(e));
    this.slideEl.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    this.strip.addEventListener('pointerdown', () => { this.stripActive = true; });
    this.stage.addEventListener('pointerdown', (e) => {
      this.stripActive = false;
      if (e.target === this.stage || e.target === this.viewport) { this.commitEdit(); this.select(null); }
    });
    this.notes.addEventListener('focus', () => { this.notesBefore = this.snap(); });
    this.notes.addEventListener('input', () => { this.slide().notes = this.notes.value; this.changed(); });
    this.notes.addEventListener('blur', () => {
      if (this.notesBefore && this.notesBefore !== this.snap()) this.pushUndo(this.notesBefore);
      this.notesBefore = '';
    });
    this.fileInput.addEventListener('change', () => {
      const f = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (f) void this.addImage(f);
    });

    const ro = new ResizeObserver(() => this.fit());
    ro.observe(this.stage);
    this.cleanups.push(() => ro.disconnect());
    const onKey = (e: KeyboardEvent): void => this.onKey(e);
    window.addEventListener('keydown', onKey);
    this.cleanups.push(() => window.removeEventListener('keydown', onKey));
    const onSel = (): void => {
      const sel = document.getSelection();
      if (this.editing && sel?.rangeCount && this.editing.text.contains(sel.anchorNode)) this.savedRange = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', onSel);
    this.cleanups.push(() => document.removeEventListener('selectionchange', onSel));
    this.renderAll();
  }

  private buildToolbar(): HTMLElement {
    const bar = h('div', 'pres-toolbar');
    const group = (): HTMLElement => { const g = h('div', 'pres-group'); bar.appendChild(g); return g; };
    const btn = (g: HTMLElement, label: string, title: string, fn: () => void, fmt = false): HTMLButtonElement => {
      const b = h('button', 'pres-btn', label);
      b.type = 'button';
      b.title = title;
      // Keep focus/selection inside an inline text edit while clicking toolbar buttons.
      b.addEventListener('pointerdown', (e) => e.preventDefault());
      b.addEventListener('click', fn);
      if (fmt) this.fmtButtons.push(b);
      g.appendChild(b);
      return b;
    };
    const color = (g: HTMLElement, label: string, title: string, fn: (hex: string) => void, fmt = true): HTMLInputElement => {
      const l = h('label', 'pres-color', label);
      l.title = title;
      const inp = h('input');
      inp.type = 'color';
      inp.addEventListener('input', () => fn(inp.value.slice(1).toUpperCase()));
      l.appendChild(inp);
      if (fmt) this.fmtButtons.push(l);
      g.appendChild(l);
      return inp;
    };

    let g = group();
    this.undoBtn = btn(g, '↶', 'Undo (Ctrl+Z)', () => this.undo());
    this.redoBtn = btn(g, '↷', 'Redo (Ctrl+Shift+Z)', () => this.redo());

    g = group();
    const layout = h('select', 'pres-select');
    layout.title = 'Layout for new slides';
    for (const [v, t] of [['content', 'Title + Content'], ['title', 'Title slide'], ['blank', 'Blank']]) {
      const o = h('option', '', t);
      o.value = v!;
      layout.appendChild(o);
    }
    g.appendChild(layout);
    btn(g, '+ Slide', 'New slide', () => this.addSlide(layout.value as Layout));
    btn(g, 'Duplicate', 'Duplicate slide', () => this.dupSlide());
    this.delSlideBtn = btn(g, 'Delete slide', 'Delete slide', () => this.delSlide());
    btn(g, '↑', 'Move slide up', () => this.moveSlide(this.cur, this.cur - 1));
    btn(g, '↓', 'Move slide down', () => this.moveSlide(this.cur, this.cur + 1));

    g = group();
    btn(g, 'Text', 'Add text box', () => this.addText(false));
    btn(g, 'Title', 'Add title', () => this.addText(true));
    btn(g, 'Image', 'Add image', () => this.fileInput.click());
    btn(g, '▭', 'Add rectangle', () => this.addShape('rect'));
    btn(g, '◯', 'Add ellipse', () => this.addShape('ellipse'));

    g = group();
    btn(g, 'B', 'Bold', () => this.toggleStyle('b', 'bold'), true).classList.add('pres-b');
    btn(g, 'I', 'Italic', () => this.toggleStyle('i', 'italic'), true).classList.add('pres-i');
    btn(g, 'U', 'Underline', () => this.toggleStyle('u', 'underline'), true).classList.add('pres-u');
    btn(g, 'A−', 'Smaller text', () => this.fontSize(-1), true);
    btn(g, 'A+', 'Larger text', () => this.fontSize(1), true);
    color(g, 'A', 'Text color', (c) => this.textColor(c));
    btn(g, '⇤', 'Align left', () => this.align('l'), true);
    btn(g, '↔', 'Align center', () => this.align('ctr'), true);
    btn(g, '⇥', 'Align right', () => this.align('r'), true);
    btn(g, '•', 'Bullets', () => this.bullets(), true);

    g = group();
    color(g, 'Fill', 'Shape fill', (c) => this.mutateSel((el) => { el.fill = c; }, 'fill'));
    btn(g, 'No fill', 'Remove fill', () => this.mutateSel((el) => { el.fill = ''; }), true);
    color(g, 'Line', 'Outline color', (c) => this.mutateSel((el) => { el.line = c; }, 'line'));
    btn(g, 'Front', 'Bring to front', () => this.zorder(1), true);
    btn(g, 'Back', 'Send to back', () => this.zorder(-1), true);
    btn(g, 'Edit', 'Edit text', () => { const el = this.selected(); if (el) this.startEdit(el); }, true);
    btn(g, 'Delete', 'Delete element', () => this.deleteSel(), true);

    g = group();
    this.bgInput = color(g, 'Background', 'Slide background color', (c) => this.mutate(() => {
      this.slide().bg = c;
      this.slide().bgMedia = '';
    }, 'bg'), false);
    btn(g, '▶ Present', 'Start slideshow', () => this.present(this.cur)).classList.add('pres-primary');
    return bar;
  }

  // ---- model helpers ------------------------------------------------------

  private slide(): Slide { return this.deck!.slides[this.cur]!; }
  private selected(): El | null { return this.slide().els.find((e) => e.id === this.selId) ?? null; }
  private snap(): string { return JSON.stringify(this.deck!.slides); }

  private pushUndo(before: string, key = ''): void {
    const now = Date.now();
    // Coalesce rapid edits from the same control (e.g. dragging a color picker).
    if (key && key === this.lastPush.key && now - this.lastPush.t < 1500) { this.lastPush.t = now; return; }
    this.lastPush = { key, t: now };
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }

  private mutate(fn: () => void, key = ''): void {
    this.commitEdit();
    const before = this.snap();
    fn();
    if (this.snap() === before) return;
    this.pushUndo(before, key);
    this.renderAll();
    this.changed();
  }

  private mutateSel(fn: (el: El) => void, key = ''): void {
    const el = this.selected();
    if (el) this.mutate(() => fn(el), key ? `${key}:${el.id}` : '');
  }

  private changed(): void {
    this.onChange?.();
  }

  private restore(s: string): void {
    this.editing = null;
    this.deck!.slides = JSON.parse(s) as Slide[];
    this.cur = Math.min(this.cur, this.deck!.slides.length - 1);
    if (!this.selected()) this.selId = null;
    this.renderAll();
    this.changed();
  }
  private undo(): void {
    this.commitEdit();
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snap());
    this.lastPush = { key: '', t: 0 };
    this.restore(s);
  }
  private redo(): void {
    this.commitEdit();
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snap());
    this.restore(s);
  }

  private url(key: string): string {
    let u = this.urls.get(key);
    const m = this.deck!.media[key];
    if (!u && m) {
      u = URL.createObjectURL(new Blob([m.data as BlobPart], { type: m.mime }));
      this.urls.set(key, u);
    }
    return u ?? '';
  }

  // ---- rendering ----------------------------------------------------------

  private renderAll(): void {
    this.renderStrip();
    this.renderStage();
    if (document.activeElement !== this.notes) this.notes.value = this.slide().notes;
    this.bgInput.value = `#${this.slide().bg || 'FFFFFF'}`;
    this.updateToolbar();
  }

  private updateToolbar(): void {
    const el = this.selected();
    for (const b of this.fmtButtons) {
      b.classList.toggle('is-disabled', !el);
      if (b instanceof HTMLButtonElement) b.disabled = !el;
    }
    this.undoBtn.disabled = !this.undoStack.length;
    this.redoBtn.disabled = !this.redoStack.length;
    this.delSlideBtn.disabled = this.deck!.slides.length <= 1;
  }

  private paintSlide(box: HTMLElement, s: Slide, mode: 'edit' | 'thumb' | 'show'): void {
    const d = this.deck!;
    box.innerHTML = '';
    box.style.width = `${d.w}px`;
    box.style.height = `${d.h}px`;
    box.style.backgroundColor = `#${s.bg || 'FFFFFF'}`;
    box.style.backgroundImage = s.bgMedia ? `url("${this.url(s.bgMedia)}")` : '';
    for (const el of s.els) box.appendChild(this.elNode(el, mode));
  }

  private place(node: HTMLElement, el: El): void {
    node.style.left = `${el.x}px`;
    node.style.top = `${el.y}px`;
    node.style.width = `${el.w}px`;
    node.style.height = `${el.h}px`;
    node.style.transform = el.rot ? `rotate(${el.rot}deg)` : '';
  }

  private elNode(el: El, mode: 'edit' | 'thumb' | 'show'): HTMLElement {
    const d = h('div', `pres-el pres-${el.type}${el.locked ? ' is-locked' : ''}`);
    d.dataset.id = el.id;
    this.place(d, el);
    const flip = el.flipH || el.flipV ? `scale(${el.flipH ? -1 : 1},${el.flipV ? -1 : 1})` : '';
    if (el.type === 'pic') {
      const img = h('img');
      img.src = this.url(el.media);
      img.alt = '';
      img.draggable = false;
      img.style.transform = flip;
      d.appendChild(img);
    } else if (el.type === 'tbl') {
      const t = h('table', 'pres-table');
      const nCols = Math.max(1, ...el.rows.map((r) => r.length));
      const sum = el.cols.reduce((a, b) => a + b, 0);
      const cg = h('colgroup');
      for (let i = 0; i < nCols; i++) {
        const c = h('col');
        c.style.width = sum ? `${((el.cols[i] ?? 0) / sum) * 100}%` : `${100 / nCols}%`;
        cg.appendChild(c);
      }
      t.appendChild(cg);
      applyStyle(t, el.cell);
      for (const row of el.rows) {
        const tr = h('tr');
        for (let i = 0; i < nCols; i++) tr.appendChild(h('td', '', row[i] ?? ''));
        t.appendChild(tr);
      }
      d.appendChild(t);
    } else {
      if (isLine(el.geom)) d.classList.add('is-line');
      if (el.fill || el.line) {
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'pres-geom');
        svg.setAttribute('width', String(Math.max(1, el.w)));
        svg.setAttribute('height', String(Math.max(1, el.h)));
        if (flip) svg.style.transform = flip;
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', geomPath(el.geom, el.w, el.h));
        path.setAttribute('fill', el.fill && !isLine(el.geom) ? `#${el.fill}` : 'none');
        if (el.line) {
          path.setAttribute('stroke', `#${el.line}`);
          path.setAttribute('stroke-width', String(el.lineW));
        }
        svg.appendChild(path);
        d.appendChild(svg);
      }
      if (!isLine(el.geom)) {
        const text = h('div', `pres-text pres-anchor-${el.anchor}`);
        this.fillParas(text, el.paras);
        const empty = !el.paras.some((p) => p.runs.some((r) => r.text.trim()));
        if (mode === 'edit' && el.ph && empty) {
          text.innerHTML = '';
          const hint = h('div', 'pres-hint', /title/i.test(el.ph) ? 'Click to add title' : el.ph === 'subTitle' ? 'Click to add subtitle' : 'Click to add text');
          if (el.paras[0]) {
            applyStyle(hint, el.paras[0].def);
            hint.style.textAlign = this.cssAlign(el.paras[0].algn);
          }
          text.appendChild(hint);
        }
        d.appendChild(text);
      }
    }
    return d;
  }

  private cssAlign(a: Align): string {
    return a === 'ctr' ? 'center' : a === 'r' ? 'right' : a === 'just' ? 'justify' : 'left';
  }

  private fillParas(text: HTMLElement, paras: Para[]): void {
    text.innerHTML = '';
    for (const p of paras) {
      const pd = h('div', 'pres-p');
      pd.dataset.algn = p.algn;
      if (p.bu) pd.dataset.bu = p.bu;
      if (p.lvl) pd.dataset.lvl = String(p.lvl);
      applyStyle(pd, p.def);
      pd.style.textAlign = this.cssAlign(p.algn);
      pd.style.paddingLeft = `calc(${p.lvl * 48}px + ${p.bu ? 1.1 : 0}em)`;
      for (const r of p.runs) {
        if (!r.text) continue;
        const sp = h('span', '', r.text);
        applyStyle(sp, r);
        pd.appendChild(sp);
      }
      if (!pd.childNodes.length) pd.appendChild(h('br'));
      text.appendChild(pd);
    }
  }

  private renderStrip(): void {
    const d = this.deck!;
    const tw = window.innerWidth < 700 ? 110 : 150;
    this.strip.innerHTML = '';
    d.slides.forEach((s, i) => {
      const t = h('div', `pres-thumb${i === this.cur ? ' is-active' : ''}`);
      t.draggable = true;
      const frame = h('div', 'pres-thumb-frame');
      frame.style.width = `${tw}px`;
      frame.style.height = `${(tw * d.h) / d.w}px`;
      const inner = h('div', 'pres-slide');
      this.paintSlide(inner, s, 'thumb');
      inner.style.transform = `scale(${tw / d.w})`;
      frame.appendChild(inner);
      t.append(h('span', 'pres-thumb-num', String(i + 1)), frame);
      t.addEventListener('click', () => { if (i !== this.cur) this.selectSlide(i); });
      // Select on press (without rebuilding the strip, so drag still works) — a
      // long-press then targets this slide.
      t.addEventListener('pointerdown', () => { if (i !== this.cur) this.setCur(i); });
      t.addEventListener('dragstart', (e) => { this.dragSlide = i; e.dataTransfer?.setData('text/plain', String(i)); });
      t.addEventListener('dragover', (e) => { e.preventDefault(); t.classList.add('is-drop'); });
      t.addEventListener('dragleave', () => t.classList.remove('is-drop'));
      t.addEventListener('drop', (e) => {
        e.preventDefault();
        if (this.dragSlide >= 0) this.moveSlide(this.dragSlide, i);
        this.dragSlide = -1;
      });
      this.strip.appendChild(t);
    });
    this.strip.querySelector('.is-active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private renderStage(): void {
    this.paintSlide(this.slideEl, this.slide(), 'edit');
    this.renderSelection();
    this.fit();
  }

  private fit(): void {
    if (!this.deck) return;
    const { w, h: H } = this.deck;
    const aw = Math.max(100, this.stage.clientWidth - 16);
    const ah = Math.max(200, window.innerHeight * 0.66);
    this.scale = Math.min(aw / w, ah / H);
    this.viewport.style.width = `${w * this.scale}px`;
    this.viewport.style.height = `${H * this.scale}px`;
    this.slideEl.style.transform = `scale(${this.scale})`;
    this.slideEl.style.setProperty('--pres-inv', String(1 / this.scale));
  }

  private renderSelection(): void {
    this.slideEl.querySelector('.pres-sel')?.remove();
    this.slideEl.querySelectorAll('.is-selected').forEach((n) => n.classList.remove('is-selected'));
    const el = this.selected();
    if (!el) return;
    this.slideEl.querySelector(`[data-id="${el.id}"]`)?.classList.add('is-selected');
    const sel = h('div', 'pres-sel');
    this.place(sel, el);
    if (!this.editing) {
      for (const dir of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const hd = h('div', `pres-handle pres-h-${dir}`);
        hd.dataset.dir = dir;
        sel.appendChild(hd);
      }
    }
    this.slideEl.appendChild(sel);
  }

  private select(id: string | null): void {
    this.selId = id;
    this.renderSelection();
    this.updateToolbar();
  }

  private setCur(i: number): void {
    this.commitEdit();
    this.cur = Math.max(0, Math.min(i, this.deck!.slides.length - 1));
    this.selId = null;
    this.strip.querySelectorAll('.pres-thumb').forEach((n, k) => n.classList.toggle('is-active', k === this.cur));
    this.renderStage();
    if (document.activeElement !== this.notes) this.notes.value = this.slide().notes;
    this.bgInput.value = `#${this.slide().bg || 'FFFFFF'}`;
    this.updateToolbar();
  }

  private selectSlide(i: number): void {
    this.commitEdit();
    this.cur = Math.max(0, Math.min(i, this.deck!.slides.length - 1));
    this.selId = null;
    this.renderAll();
  }

  // ---- pointer + keyboard -------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    const target = e.target as HTMLElement;
    this.stripActive = false;
    this.downAt = e.timeStamp;
    if (this.editing && this.editing.box.contains(target)) return; // caret placement inside the edit
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) document.activeElement.blur();
    const handle = target.closest<HTMLElement>('.pres-handle');
    const node = target.closest<HTMLElement>('.pres-el');
    let el = handle ? this.selected() : node ? this.slide().els.find((x) => x.id === node.dataset.id) ?? null : null;
    if (!el) { this.commitEdit(); this.select(null); return; }
    const wasSelected = this.selId === el.id;
    if (this.editing) {
      this.commitEdit();
      el = this.slide().els.find((x) => x.id === el!.id) ?? null;
      if (!el) return;
    }
    if (!wasSelected) this.select(el.id);
    e.preventDefault();
    this.slideEl.setPointerCapture(e.pointerId);
    this.drag = {
      mode: (handle?.dataset.dir as DragMode) ?? 'move', el, sx: e.clientX, sy: e.clientY,
      o: { x: el.x, y: el.y, w: el.w, h: el.h }, moved: false, before: this.snap(), wasSelected, shift: e.shiftKey,
    };
  }

  private onPointerMove(e: PointerEvent): void {
    const dr = this.drag;
    if (!dr) return;
    const dx = (e.clientX - dr.sx) / this.scale, dy = (e.clientY - dr.sy) / this.scale;
    if (!dr.moved && Math.hypot(dx * this.scale, dy * this.scale) < 4) return;
    dr.moved = true;
    const el = dr.el, o = dr.o;
    if (dr.mode === 'move') {
      el.x = Math.round(o.x + dx);
      el.y = Math.round(o.y + dy);
    } else {
      let { x, y, w, h: hh } = o;
      const m = dr.mode;
      if (m.includes('e')) w = o.w + dx;
      if (m.includes('w')) { w = o.w - dx; x = o.x + dx; }
      if (m.includes('s')) hh = o.h + dy;
      if (m.includes('n')) { hh = o.h - dy; y = o.y + dy; }
      const corner = m.length === 2;
      const keep = corner && (el.type === 'pic' ? !e.shiftKey : e.shiftKey) && o.h > 0;
      if (keep) {
        hh = w / (o.w / o.h);
        if (m.includes('n')) y = o.y + o.h - hh;
      }
      const min = isLine(el.geom) ? 0 : 8;
      el.x = Math.round(w < min ? x - (min - w) * (m.includes('w') ? 1 : 0) : x);
      el.y = Math.round(hh < min ? y - (min - hh) * (m.includes('n') ? 1 : 0) : y);
      el.w = Math.round(Math.max(min, w));
      el.h = Math.round(Math.max(min, hh));
    }
    // Live update: swap the element node and selection box.
    const old = this.slideEl.querySelector(`[data-id="${el.id}"]`);
    if (dr.mode === 'move' && old instanceof HTMLElement) this.place(old, el);
    else old?.replaceWith(this.elNode(el, 'edit'));
    this.renderSelection();
  }

  private onPointerUp(e: PointerEvent): void {
    const dr = this.drag;
    if (!dr) return;
    this.drag = null;
    if (this.slideEl.hasPointerCapture(e.pointerId)) this.slideEl.releasePointerCapture(e.pointerId);
    if (dr.moved) {
      this.pushUndo(dr.before);
      this.renderStrip();
      this.updateToolbar();
      this.changed();
    } else if (dr.wasSelected && dr.mode === 'move' && e.type === 'pointerup' && e.timeStamp - this.downAt < 450) {
      // (a long-press is for the edit menu, not text editing)
      this.startEdit(dr.el); // tap a selected element again → edit its text
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.host.isConnected || this.presenting) return;
    const t = e.target as HTMLElement;
    const typing = t.matches?.('input, textarea, select') || t.isContentEditable;
    if (e.key === 'Escape' && this.editing) { this.commitEdit(); return; }
    if (typing) return;
    const el = this.selected();
    if (!el) return;
    if (e.key === 'Escape') this.select(null);
    else if (e.key === 'Enter') { e.preventDefault(); this.startEdit(el); }
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      const s = e.shiftKey ? 10 : 1;
      const [dx, dy] = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, -s], ArrowDown: [0, s] }[e.key] ?? [0, 0];
      this.mutate(() => { el.x += dx!; el.y += dy!; }, `nudge:${el.id}`);
    }
  }

  // ---- inline text editing ------------------------------------------------

  private startEdit(el: El, selectAll = false): void {
    if (el.type === 'pic' || isLine(el.geom)) return;
    if (this.editing?.el === el) return;
    this.commitEdit();
    const before = this.snap();
    this.selId = el.id;
    if (el.type === 'sp' && !el.paras.length) {
      el.paras = [para('', style({ font: this.deck!.font, color: el.fill ? 'FFFFFF' : '000000' }), { algn: el.fill ? 'ctr' : 'l' })];
    }
    this.renderStage();
    const box = this.slideEl.querySelector<HTMLElement>(`[data-id="${el.id}"]`);
    const text = box?.querySelector<HTMLElement>(el.type === 'tbl' ? 'table' : '.pres-text');
    if (!box || !text) return;
    if (el.type === 'sp') this.fillParas(text, el.paras); // drop the placeholder hint
    box.classList.add('is-editing');
    text.contentEditable = 'true';
    text.spellcheck = true;
    text.addEventListener('input', () => this.changed());
    this.editing = { el, box, text, before };
    this.renderSelection();
    text.focus();
    const sel = document.getSelection();
    if (sel) {
      const r = document.createRange();
      r.selectNodeContents(el.type === 'tbl' ? text.querySelector('td') ?? text : text);
      if (!selectAll && el.type !== 'tbl') r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }

  /** Copy the in-progress inline edit back into the model (no re-render). */
  private syncEdit(): void {
    const ed = this.editing;
    if (!ed) return;
    if (ed.el.type === 'tbl') {
      ed.el.rows = Array.from(ed.text.querySelectorAll('tr')).map((tr) =>
        Array.from(tr.querySelectorAll('td')).map((td) => td.innerText.replace(/\n$/, '')));
    } else {
      ed.el.paras = readParas(ed.text, ed.el.paras[0]?.def ?? style({ font: this.deck!.font }));
    }
  }

  private commitEdit(): void {
    const ed = this.editing;
    if (!ed) return;
    this.syncEdit();
    this.editing = null;
    this.savedRange = null;
    if (this.snap() !== ed.before) {
      this.pushUndo(ed.before);
      this.changed();
    }
    this.renderStage();
    this.renderStrip();
    this.updateToolbar();
  }

  // ---- formatting ---------------------------------------------------------

  private runsOf(el: El): Style[] {
    if (el.type === 'tbl') return [el.cell];
    return el.paras.flatMap((p) => [p.def, ...p.runs]);
  }

  private exec(cmd: string, value?: string): boolean {
    if (!this.editing) return false;
    this.editing.text.focus();
    if (this.savedRange) {
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(this.savedRange);
    }
    document.execCommand('styleWithCSS', false, 'true');
    document.execCommand(cmd, false, value);
    this.changed();
    return true;
  }

  private toggleStyle(k: 'b' | 'i' | 'u', cmd: string): void {
    // While typing with a text selection, format just the selection; otherwise the whole element.
    if (this.editing?.el.type === 'sp' && this.savedRange && !this.savedRange.collapsed && this.exec(cmd)) return;
    this.mutateSel((el) => {
      const runs = el.type === 'tbl' ? [el.cell] : el.paras.flatMap((p) => p.runs as Style[]);
      const on = !(runs.length ? runs : this.runsOf(el)).every((r) => r[k]);
      this.runsOf(el).forEach((r) => { r[k] = on; });
    });
  }

  private fontSize(dir: number): void {
    this.mutateSel((el) => {
      for (const r of this.runsOf(el)) {
        const step = r.sz < 12 ? 1 : r.sz < 28 ? 2 : 4;
        r.sz = Math.max(6, Math.min(200, r.sz + dir * step));
      }
    });
  }

  private textColor(c: string): void {
    if (this.editing && this.editing.el.type === 'sp' && this.savedRange && !this.savedRange.collapsed) {
      this.exec('foreColor', `#${c}`);
      return;
    }
    this.mutateSel((el) => this.runsOf(el).forEach((r) => { r.color = c; }), 'color');
  }

  private align(a: Align): void {
    this.mutateSel((el) => el.paras.forEach((p) => { p.algn = a; }));
  }

  private bullets(): void {
    this.mutateSel((el) => {
      const on = !el.paras.every((p) => p.bu);
      el.paras.forEach((p) => { p.bu = on ? '•' : ''; });
    });
  }

  private zorder(dir: number): void {
    this.mutateSel((el) => {
      const els = this.slide().els;
      els.splice(els.indexOf(el), 1);
      if (dir > 0) els.push(el); else els.unshift(el);
    });
  }

  private deleteSel(): void {
    const el = this.selected();
    if (!el) return;
    this.mutate(() => {
      const els = this.slide().els;
      els.splice(els.indexOf(el), 1);
      this.selId = null;
    });
  }

  // ---- inserting ----------------------------------------------------------

  private addEl(el: El, edit = false): void {
    this.mutate(() => {
      this.slide().els.push(el);
      this.selId = el.id;
    });
    if (edit) this.startEdit(el, true);
  }

  private addText(title: boolean): void {
    const { w: W, h: H, font, titleFont } = this.deck!;
    const s = style(title ? { sz: 40, font: titleFont, b: true } : { sz: 24, font });
    this.addEl(newEl({
      x: W * 0.15, y: title ? H * 0.1 : H * 0.4, w: W * 0.7, h: title ? H * 0.16 : H * 0.12,
      anchor: title ? 'ctr' : 't', ph: title ? 'title' : '',
      paras: [para(title ? 'Title' : 'Text', s, { algn: title ? 'ctr' : 'l' })],
    }), true);
  }

  private addShape(geom: string): void {
    const { w: W, h: H, font } = this.deck!;
    const sz = Math.min(W, H) * 0.3;
    this.addEl(newEl({
      x: (W - sz) / 2, y: (H - sz) / 2, w: sz, h: sz, geom, fill: '4472C4', line: '2F528F', lineW: 1.5, anchor: 'ctr',
      paras: [para('', style({ font, color: 'FFFFFF' }), { algn: 'ctr' })],
    }));
  }

  private async addImage(file: File): Promise<void> {
    let blob: Blob = file;
    let type = file.type;
    let bmp: ImageBitmap;
    try { bmp = await createImageBitmap(file); } catch { return; }
    // PowerPoint-safe formats only; convert anything else (webp, avif, …) to PNG.
    if (!['image/png', 'image/jpeg', 'image/gif'].includes(type)) {
      const cv = document.createElement('canvas');
      cv.width = bmp.width;
      cv.height = bmp.height;
      cv.getContext('2d')!.drawImage(bmp, 0, 0);
      blob = await new Promise<Blob>((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/png'));
      type = 'image/png';
    }
    const key = uid();
    const ext = type === 'image/jpeg' ? 'jpeg' : type === 'image/gif' ? 'gif' : 'png';
    this.deck!.media[key] = { data: new Uint8Array(await blob.arrayBuffer()), ext, mime: type };
    const { w: W, h: H } = this.deck!;
    const k = Math.min(1, (W * 0.6) / bmp.width, (H * 0.6) / bmp.height);
    const w = bmp.width * k, hh = bmp.height * k;
    bmp.close();
    this.addEl(newEl({ type: 'pic', media: key, x: Math.round((W - w) / 2), y: Math.round((H - hh) / 2), w: Math.round(w), h: Math.round(hh) }));
  }

  // ---- slides -------------------------------------------------------------

  private addSlide(kind: Layout): void {
    this.mutate(() => {
      this.deck!.slides.splice(this.cur + 1, 0, this.makeSlide(kind));
      this.cur++;
      this.selId = null;
    });
  }

  private dupSlide(): void {
    this.mutate(() => {
      const copy = JSON.parse(JSON.stringify(this.slide())) as Slide;
      copy.id = uid();
      copy.els.forEach((e) => { e.id = uid(); });
      this.deck!.slides.splice(this.cur + 1, 0, copy);
      this.cur++;
      this.selId = null;
    });
  }

  private delSlide(): void {
    if (this.deck!.slides.length <= 1) return;
    this.mutate(() => {
      this.deck!.slides.splice(this.cur, 1);
      this.cur = Math.min(this.cur, this.deck!.slides.length - 1);
      this.selId = null;
    });
  }

  private moveSlide(from: number, to: number): void {
    const n = this.deck!.slides.length;
    if (to < 0 || to >= n || from === to) return;
    this.mutate(() => {
      const [s] = this.deck!.slides.splice(from, 1);
      this.deck!.slides.splice(to, 0, s!);
      this.cur = to;
    });
  }

  // ---- slideshow ----------------------------------------------------------

  private present(start: number): void {
    this.commitEdit();
    const d = this.deck!;
    this.presenting = true;
    const ov = h('div', 'pres-show');
    const holder = h('div', 'pres-show-frame');
    const slide = h('div', 'pres-slide');
    holder.appendChild(slide);
    const count = h('div', 'pres-show-count');
    const exit = h('button', 'pres-show-exit', '✕');
    exit.type = 'button';
    exit.title = 'Exit slideshow (Esc)';
    ov.append(holder, count, exit);
    document.body.appendChild(ov);
    let i = start;
    const show = (): void => {
      this.paintSlide(slide, d.slides[i]!, 'show');
      const k = Math.min(window.innerWidth / d.w, window.innerHeight / d.h);
      holder.style.width = `${d.w * k}px`;
      holder.style.height = `${d.h * k}px`;
      slide.style.transform = `scale(${k})`;
      count.textContent = `${i + 1} / ${d.slides.length}`;
    };
    const go = (n: number): void => {
      if (n >= d.slides.length) { close(); return; }
      i = Math.max(0, n);
      show();
    };
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key;
      if (k === 'Escape') close();
      else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(k)) go(i + 1);
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) go(i - 1);
      else if (k === 'Home') go(0);
      else if (k === 'End') go(d.slides.length - 1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    let downX = 0;
    ov.addEventListener('pointerdown', (e) => { downX = e.clientX; });
    ov.addEventListener('pointerup', (e) => {
      if (e.target === exit) return;
      const dx = e.clientX - downX;
      if (Math.abs(dx) > 40) go(dx < 0 ? i + 1 : i - 1); // swipe
      else go(e.clientX < window.innerWidth * 0.3 ? i - 1 : i + 1);
    });
    let wasFull = false;
    const onFs = (): void => {
      if (document.fullscreenElement) wasFull = true;
      else if (wasFull) close();
    };
    const close = (): void => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', show);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      ov.remove();
      this.presenting = false;
      this.cleanups = this.cleanups.filter((f) => f !== close);
      if (!this.dead) this.selectSlide(i);
    };
    exit.addEventListener('click', close);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', show);
    document.addEventListener('fullscreenchange', onFs);
    this.cleanups.push(close);
    show();
    ov.requestFullscreen?.().catch(() => undefined);
  }

  // ---- edit commands (shell owns the shortcuts + long-press menu) ----------

  commands(): EditCommands {
    if (!this.deck || this.presenting || !this.root) return {};
    return {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.undoStack.length > 0,
      canRedo: () => this.redoStack.length > 0,
      hasSelection: () => !!this.selected() || this.stripActive,
      canPaste: () => true,
      delete: () => {
        if (this.selected()) this.deleteSel();
        else if (this.stripActive) this.delSlide();
      },
      copy: () => this.copySel(),
      cut: () => {
        if (this.selected()) { this.copySel(); this.deleteSel(); }
        else if (this.stripActive) { this.copySel(); this.delSlide(); }
      },
      paste: (data) => this.pasteData(data),
      duplicate: () => {
        const el = this.selected();
        if (el) this.insertEl(this.elClip(el), 20);
        else if (this.stripActive) this.dupSlide();
      },
    };
  }

  private mediaFor(keys: string[]): Record<string, Media> {
    const out: Record<string, Media> = {};
    for (const k of keys) { const m = this.deck!.media[k]; if (k && m) out[k] = m; }
    return out;
  }

  private elClip(el: El): ElClip {
    this.syncEdit();
    return { el: JSON.parse(JSON.stringify(el)) as El, media: this.mediaFor([el.media]) };
  }

  private copySel(): void {
    const el = this.selected();
    let text = '';
    if (el) {
      const clip = this.elClip(el);
      setAppClipboard('pres-el', clip);
      if (el.type === 'pic') {
        const m = clip.media[el.media];
        if (m?.mime === 'image/png' && typeof ClipboardItem !== 'undefined') {
          const blob = new Blob([m.data as BlobPart], { type: 'image/png' });
          void navigator.clipboard?.write?.([new ClipboardItem({ 'image/png': blob })]).catch(() => undefined);
        }
        this.lastClipText = '';
        return;
      }
      text = el.type === 'tbl' ? el.rows.map((r) => r.join('\t')).join('\n') : elText(el);
    } else if (this.stripActive) {
      this.syncEdit();
      const s = this.slide();
      setAppClipboard('pres-slide', {
        slide: JSON.parse(JSON.stringify(s)) as Slide,
        media: this.mediaFor([s.bgMedia, ...s.els.map((e) => e.media)]),
      } satisfies SlideClip);
      text = s.els.filter((e) => e.type === 'sp').map(elText).filter((t) => t.trim()).join('\n');
    } else return;
    this.lastClipText = text;
    if (text) void navigator.clipboard?.writeText?.(text).catch(() => undefined);
  }

  private adoptMedia(media: Record<string, Media>): void {
    for (const [k, m] of Object.entries(media)) if (!this.deck!.media[k]) this.deck!.media[k] = m;
  }

  private insertEl(clip: ElClip, offset: number): void {
    this.adoptMedia(clip.media);
    const el = JSON.parse(JSON.stringify(clip.el)) as El;
    el.id = uid();
    el.locked = false;
    el.x += offset;
    el.y += offset;
    this.addEl(el);
    this.stripActive = false;
  }

  private insertSlide(clip: SlideClip): void {
    this.adoptMedia(clip.media);
    this.mutate(() => {
      const copy = JSON.parse(JSON.stringify(clip.slide)) as Slide;
      copy.id = uid();
      copy.els.forEach((e) => { e.id = uid(); });
      this.deck!.slides.splice(this.cur + 1, 0, copy);
      this.cur++;
      this.selId = null;
    });
    this.stripActive = true;
  }

  private pasteText(text: string): void {
    const { w: W, h: H, font } = this.deck!;
    const s = style({ sz: 24, font });
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    this.addEl(newEl({
      x: W * 0.15, y: H * 0.35, w: W * 0.7, h: Math.min(H * 0.6, Math.max(H * 0.12, lines.length * 24 * PT_PX * 1.3)),
      paras: lines.map((l) => para(l, s)),
    }));
    this.stripActive = false;
  }

  /** Paste from the app clipboard (slide or element); returns false when it has neither. */
  private pasteApp(): boolean {
    const slide = getAppClipboard<SlideClip>('pres-slide');
    if (slide) { this.insertSlide(slide); return true; }
    const el = getAppClipboard<ElClip>('pres-el');
    if (el) {
      this.insertEl(el, 20);
      // Repeated pastes cascade instead of stacking exactly.
      setAppClipboard('pres-el', { ...el, el: { ...el.el, x: el.el.x + 20, y: el.el.y + 20 } });
      return true;
    }
    return false;
  }

  private async pasteData(data?: DataTransfer | null): Promise<void> {
    if (data) {
      const file = Array.from(data.files ?? []).find((f) => f.type.startsWith('image/'))
        ?? Array.from(data.items ?? []).find((it) => it.kind === 'file' && it.type.startsWith('image/'))?.getAsFile();
      if (file) { await this.addImage(file); this.stripActive = false; return; }
      const text = data.getData('text/plain');
      if (text && text !== this.lastClipText) { this.pasteText(text); return; }
      if (this.pasteApp()) return;
      if (text) this.pasteText(text);
      return;
    }
    if (this.pasteApp()) return;
    try {
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const type = it.types.find((t) => t.startsWith('image/'));
        if (type) {
          const blob = await it.getType(type);
          await this.addImage(new File([blob], 'pasted', { type }));
          return;
        }
      }
    } catch { /* fall through to text */ }
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.pasteText(text);
    } catch { /* clipboard unavailable */ }
  }
}
