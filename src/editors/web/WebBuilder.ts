import './webbuilder.css';
import { BLOCKS, type Block } from './blocks';
import { SNIPPETS } from './snippets';
import { SiteFrame } from '../siteFrame';
import { embedImage, embedMedia, MAX_EMBED_MEDIA } from '../../utils/embedImage';

// Visual (Wix-style) designer for a single-file web page. The canvas is a
// same-origin, script-less iframe: we edit its DOM directly (select, inline text
// edit, drag/drop, style inspector) and serialise back to HTML on every change.
// The page's own <style> and <script> are preserved and editable, so HTML, CSS
// and JS all stay first-class. JS only runs in Preview (isolated site frame).

const EDITOR_CSS = `[data-gz-hover]{outline:1px dashed #ff4d8d!important;outline-offset:-1px}
[data-gz-sel]{outline:2px solid #ff4d8d!important;outline-offset:-2px}
[contenteditable="true"]{outline:2px solid #4d6bff!important;cursor:text}
html,body{height:auto}
*,*::before,*::after{animation:none!important;transition:none!important}
iframe,video,audio,embed,object{pointer-events:none!important}
[data-gz-reveal]{opacity:1!important;transform:none!important;filter:none!important;visibility:visible!important}`;
const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'BASE']);
const INLINE = new Set(['SPAN', 'A', 'STRONG', 'EM', 'B', 'I', 'U', 'SMALL', 'LABEL', 'CODE', 'BR', 'SUB', 'SUP']);
const NO_TEXT = new Set(['IMG', 'IFRAME', 'HR', 'INPUT', 'VIDEO', 'AUDIO', 'TEXTAREA', 'SELECT', 'BODY']);
const WIDTHS = { desktop: '100%', tablet: '768px', mobile: '390px' } as const;

type Drag = { block?: Block; el?: HTMLElement };
type Drop = { ref: HTMLElement; where: 'before' | 'after' | 'inside' };

export interface WebBuilderOpts {
  getHtml(): string;
  /** Called with the serialised page after each edit (push to code editor + autosave). */
  setHtml(html: string): void;
}

function toHex(c: string): string {
  const m = /rgba?\(([^)]+)\)/.exec(c);
  if (!m) return '';
  const p = m[1]!.split(',').map((x) => parseFloat(x));
  if (p.length === 4 && p[3] === 0) return '';
  return '#' + p.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, '0')).join('');
}

export class WebBuilder {
  readonly root: HTMLElement;
  private frame!: HTMLIFrameElement;
  private stage!: HTMLElement;
  private device!: HTMLElement;
  private float!: HTMLElement;
  private selBox!: HTMLElement;
  private dropLine!: HTMLElement;
  private inspector!: HTMLElement;
  private doc!: Document;
  private sel: HTMLElement | null = null;
  private hover: HTMLElement | null = null;
  private editing: HTMLElement | null = null;
  private drag: Drag | null = null;
  private drop: Drop | null = null;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private current = '';
  private ac = new AbortController();
  private ro?: ResizeObserver;
  private live = false;
  private liveFrame?: SiteFrame;
  private codeList!: HTMLElement;

  constructor(host: HTMLElement, private opts: WebBuilderOpts) {
    this.root = document.createElement('div');
    this.root.className = 'wb';
    this.root.innerHTML = `
      <div class="wb-top">
        <span class="wb-seg" role="group" aria-label="Preview width">
          <button type="button" data-w="desktop" aria-pressed="true" title="Desktop">🖥</button>
          <button type="button" data-w="tablet" aria-pressed="false" title="Tablet">▭</button>
          <button type="button" data-w="mobile" aria-pressed="false" title="Mobile">📱</button>
        </span>
        <button type="button" data-act="undo" title="Undo (Ctrl+Z)">↶</button>
        <button type="button" data-act="redo" title="Redo (Ctrl+Shift+Z)">↷</button>
        <button type="button" data-act="page" title="Page settings">⚙ Page</button>
        <button type="button" data-act="live" aria-pressed="false" title="Run the page with its JavaScript (view only)">▶ Live</button>
        <span class="wb-hint">Click to select · double-click text to edit · drag blocks in</span>
      </div>
      <div class="wb-main">
        <aside class="wb-palette" aria-label="Blocks"></aside>
        <div class="wb-stage"><div class="wb-device"><iframe class="wb-canvas" title="Page designer" sandbox="allow-same-origin"></iframe><div class="wb-selbox" hidden><span class="wb-dims"></span>${['nw','n','ne','e','se','s','sw','w'].map((h) => `<i data-h="${h}"></i>`).join('')}</div><div class="wb-float" hidden></div><div class="wb-dropline" hidden></div></div></div>
        <aside class="wb-inspector" aria-label="Properties"></aside>
      </div>`;
    host.appendChild(this.root);
    const q = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T;
    this.frame = q('.wb-canvas'); this.stage = q('.wb-stage'); this.device = q('.wb-device');
    this.float = q('.wb-float'); this.selBox = q('.wb-selbox'); this.dropLine = q('.wb-dropline'); this.inspector = q('.wb-inspector');
    this.buildPalette(q('.wb-palette'));
    this.buildCodePanel(q('.wb-palette'));
    const sig = { signal: this.ac.signal };

    this.root.querySelectorAll<HTMLButtonElement>('.wb-seg button').forEach((b) => b.addEventListener('click', () => {
      this.device.style.width = WIDTHS[b.dataset.w as keyof typeof WIDTHS];
      this.root.querySelectorAll('.wb-seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      requestAnimationFrame(() => { this.fit(); this.placeFloat(); });
    }, sig));
    q('[data-act="undo"]').addEventListener('click', () => this.undo(), sig);
    q('[data-act="redo"]').addEventListener('click', () => this.redo(), sig);
    q('[data-act="page"]').addEventListener('click', () => { this.setLive(false); this.select(this.doc.body); }, sig);
    q('[data-act="live"]').addEventListener('click', () => this.setLive(!this.live), sig);
    this.root.addEventListener('keydown', (e) => this.onKey(e), sig);
    this.stage.addEventListener('scroll', () => this.placeFloat(), sig);
    this.frame.addEventListener('load', () => this.onLoad(), sig);
    this.ro = new ResizeObserver(() => { this.fit(); this.placeFloat(); });
    this.ro.observe(this.stage);
    this.buildFloat();
    this.selBox.querySelectorAll<HTMLElement>('i').forEach((h) => h.addEventListener('pointerdown', (e) => this.startResize(h.dataset.h!, e), sig));
  }

  destroy(): void { this.ac.abort(); this.ro?.disconnect(); this.liveFrame?.destroy(); this.root.remove(); }

  /** (Re)load the designer from the page HTML (called on switch-to-Design and after AI/code edits). */
  load(html: string = this.opts.getHtml()): void {
    if (html === this.current && this.doc) return;
    this.current = html;
    this.sel = null; this.hover = null; this.editing = null;
    this.frame.srcdoc = html.trim() ? html : '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>';
  }

  // ---------- document wiring ----------
  private onLoad(): void {
    const d = this.frame.contentDocument; if (!d) return;
    this.doc = d;
    const st = d.createElement('style'); st.setAttribute('data-gz-editor', ''); st.textContent = EDITOR_CSS;
    d.head.appendChild(st);
    // Pages often start sections hidden (opacity:0) and reveal them with JS/scroll
    // animations. Scripts don't run in the designer, so reveal them for editing.
    const win = d.defaultView!;
    d.body.querySelectorAll<HTMLElement>('*').forEach((el) => {
      if (SKIP.has(el.tagName)) return;
      const cs = win.getComputedStyle(el);
      if (cs.display !== 'none' && (cs.opacity === '0' || cs.visibility === 'hidden')) el.setAttribute('data-gz-reveal', '');
    });
    const on = <K extends keyof DocumentEventMap>(t: K, f: (e: DocumentEventMap[K]) => void, cap = false) =>
      d.addEventListener(t, f as EventListener, { capture: cap, signal: this.ac.signal });
    on('mouseover', (e) => this.setHover(this.pick(e.target, e.clientX, e.clientY)));
    on('mousemove', (e) => { const sp = this.special(e.clientX, e.clientY); if (sp) this.setHover(sp); });
    on('mouseleave', () => this.setHover(null));
    on('click', (e) => {
      if (this.editing && this.editing.contains(e.target as Node)) return;
      e.preventDefault(); this.stopEdit();
      this.select(this.pick(e.target, e.clientX, e.clientY));
    }, true);
    on('dblclick', (e) => { const el = this.pick(e.target, e.clientX, e.clientY); if (el) this.startEdit(el); });
    on('keydown', (e) => this.onKey(e as KeyboardEvent));
    on('input', () => { if (this.editing) this.commitSoon(); });
    on('paste', (e) => {
      if (!this.editing) return;
      e.preventDefault();
      d.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    });
    on('dragover', (e) => this.onDragOver(e));
    on('drop', (e) => this.onDrop(e));
    d.defaultView?.addEventListener('scroll', () => this.placeFloat(), { signal: this.ac.signal });
    this.fit();
    this.renderCodeList();
    this.renderInspector();
    if (this.live) this.liveFrame?.show(this.serialize());
    if (!this.undoStack.length) this.undoStack.push(this.serialize());
  }

  /** Embeds/media swallow clicks, so they're click-through in the designer and hit-tested by rect. */
  private special(x?: number, y?: number): HTMLElement | null {
    if (x == null || y == null) return null;
    const hits = [...this.doc.querySelectorAll<HTMLElement>('iframe,video,audio,embed,object')].filter((e) => {
      const r = e.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && r.width > 0;
    });
    return hits.length ? hits[hits.length - 1]! : null;
  }
  private pick(t: EventTarget | null, x?: number, y?: number): HTMLElement | null {
    const sp = this.special(x, y); if (sp) return sp;
    let el = t as HTMLElement | null;
    if (!el || el.nodeType !== 1) el = (t as Node | null)?.parentElement ?? null;
    if (!el || el === this.doc.documentElement || SKIP.has(el.tagName)) return this.doc.body;
    return el;
  }

  private serialize(): string {
    const root = this.doc.documentElement.cloneNode(true) as HTMLElement;
    root.querySelectorAll('[data-gz-editor]').forEach((n) => n.remove());
    for (const a of ['data-gz-sel', 'data-gz-hover', 'data-gz-edit', 'data-gz-reveal']) root.querySelectorAll(`[${a}]`).forEach((n) => n.removeAttribute(a));
    root.querySelectorAll('[data-gz-ce]').forEach((n) => { n.removeAttribute('contenteditable'); n.removeAttribute('data-gz-ce'); });
    return '<!DOCTYPE html>\n' + root.outerHTML + '\n';
  }

  private commitTimer?: number;
  private commitSoon(): void { clearTimeout(this.commitTimer); this.commitTimer = window.setTimeout(() => this.commit(), 300); }
  /** Serialise → history → push to the code editor. */
  private commit(): void {
    clearTimeout(this.commitTimer);
    const html = this.serialize();
    if (html === this.current) return;
    this.current = html;
    this.undoStack.push(html); if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.opts.setHtml(html);
    this.fit(); this.placeFloat(); this.renderCodeList();
    if (this.live) this.liveFrame?.show(html);
  }
  private restore(html: string): void {
    this.current = ''; this.load(html); this.opts.setHtml(html);
  }
  undo(): void { if (this.undoStack.length < 2) return; this.redoStack.push(this.undoStack.pop()!); this.restore(this.undoStack[this.undoStack.length - 1]!); }
  redo(): void { const h = this.redoStack.pop(); if (!h) return; this.undoStack.push(h); this.restore(h); }

  private onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    const inField = (e.target as HTMLElement)?.closest?.('input,textarea,select');
    if (mod && e.key.toLowerCase() === 'z' && !this.editing && !inField) { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (this.editing) { if (e.key === 'Escape') this.stopEdit(); return; }
    if (inField) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel && this.sel !== this.doc.body) { e.preventDefault(); this.remove(); }
    else if (e.key === 'Enter' && this.sel) { e.preventDefault(); this.startEdit(this.sel); }
    else if (e.key === 'Escape') this.select(null);
  }

  /** The canvas is a real viewport (fixed height, scrolls inside) so vh units and
   *  100vh sections lay out exactly like they do in Live / the published page. */
  private fit(): void {
    this.device.style.height = Math.max(320, this.stage.clientHeight - 28) + 'px';
  }

  // ---------- selection / hover / text edit ----------
  private setHover(el: HTMLElement | null): void {
    this.hover?.removeAttribute('data-gz-hover');
    this.hover = el && el !== this.sel ? el : null;
    this.hover?.setAttribute('data-gz-hover', '');
  }
  select(el: HTMLElement | null): void {
    this.sel?.removeAttribute('data-gz-sel');
    this.sel = el;
    this.hover?.removeAttribute('data-gz-hover');
    if (el && el !== this.doc.body) el.setAttribute('data-gz-sel', '');
    this.renderInspector(); this.placeFloat();
  }
  private startEdit(el: HTMLElement): void {
    if (NO_TEXT.has(el.tagName)) return;
    this.stopEdit();
    this.editing = el; this.select(el);
    if (el.getAttribute('contenteditable') !== 'true') el.setAttribute('data-gz-ce', '');
    el.setAttribute('contenteditable', 'true');
    el.focus();
    el.addEventListener('blur', () => this.stopEdit(), { once: true });
  }
  private stopEdit(): void {
    const el = this.editing; if (!el) return;
    this.editing = null;
    if (el.hasAttribute('data-gz-ce')) { el.removeAttribute('contenteditable'); el.removeAttribute('data-gz-ce'); }
    this.commit();
  }

  // ---------- floating toolbar ----------
  private buildFloat(): void {
    const mk = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.title = title;
      b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b;
    };
    const handle = mk('⠿', 'Drag to move', () => {}); handle.draggable = true; handle.classList.add('wb-handle');
    handle.addEventListener('dragstart', (e) => {
      if (!this.sel || this.sel === this.doc.body) { e.preventDefault(); return; }
      this.drag = { el: this.sel }; e.dataTransfer?.setData('text/plain', 'move');
    });
    handle.addEventListener('dragend', () => this.endDrag());
    this.float.append(
      handle,
      mk('↑', 'Move up', () => this.nudge(-1)), mk('↓', 'Move down', () => this.nudge(1)),
      mk('⬆', 'Select parent', () => { const p = this.sel?.parentElement; if (p) this.select(p); }),
      mk('⧉', 'Duplicate', () => this.duplicate()), mk('🗑', 'Delete', () => this.remove()),
      mk('⤒', 'Bring to front', () => this.arrange('front')), mk('⤓', 'Send to back', () => this.arrange('back')),
    );
    const mv = document.createElement('button'); mv.type = 'button'; mv.textContent = '✥'; mv.title = 'Drag to place anywhere (free move)'; mv.classList.add('wb-handle');
    mv.addEventListener('pointerdown', (e) => this.startMove(e));
    this.float.insertBefore(mv, this.float.children[1] ?? null);
  }
  private placeFloat(): void {
    const el = this.sel;
    if (!el || el === this.doc?.body || !el.isConnected || SKIP.has(el.tagName)) { this.float.hidden = true; this.selBox.hidden = true; return; }
    const r = el.getBoundingClientRect();
    const top = r.top - 30 < 0 ? r.top + 4 : r.top - 30;
    this.float.style.top = `${top}px`;
    this.float.style.left = `${Math.max(4, Math.min(r.left, this.device.clientWidth - 290))}px`;
    this.float.hidden = false;
    const sb = this.selBox.style;
    sb.left = `${r.left}px`; sb.top = `${r.top}px`; sb.width = `${r.width}px`; sb.height = `${r.height}px`;
    this.selBox.hidden = false;
    (this.selBox.firstElementChild as HTMLElement).textContent = `${Math.round(r.width)} × ${Math.round(r.height)}`;
  }

  // ---------- free resize / free move / stacking ----------
  private drag2(e: PointerEvent, onMove: (dx: number, dy: number, ev: PointerEvent) => void): void {
    e.preventDefault(); e.stopPropagation();
    const t = e.currentTarget as HTMLElement, x0 = e.clientX, y0 = e.clientY;
    t.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => { onMove(ev.clientX - x0, ev.clientY - y0, ev); this.placeFloat(); };
    const up = () => { t.removeEventListener('pointermove', mv); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up); this.commit(); this.renderInspector(); this.placeFloat(); };
    t.addEventListener('pointermove', mv); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
  }
  private ensureOffsetable(el: HTMLElement): void {
    if (this.css(el, 'position') === 'static') el.style.position = 'relative';
  }
  private startResize(h: string, e: PointerEvent): void {
    const el = this.sel; if (!el || el === this.doc.body) return;
    this.ensureOffsetable(el);
    const cs = this.doc.defaultView!.getComputedStyle(el);
    const r0 = el.getBoundingClientRect(), l0 = parseFloat(cs.left) || 0, t0 = parseFloat(cs.top) || 0;
    const ratio = r0.width / (r0.height || 1);
    const media = el.tagName === 'IMG' || el.tagName === 'VIDEO';
    el.style.boxSizing = 'border-box';
    this.drag2(e, (dx, dy, ev) => {
      let w = r0.width, hh = r0.height;
      if (h.includes('e')) w = r0.width + dx;
      if (h.includes('w')) w = r0.width - dx;
      if (h.includes('s')) hh = r0.height + dy;
      if (h.includes('n')) hh = r0.height - dy;
      w = Math.max(8, w); hh = Math.max(8, hh);
      if ((media || ev.shiftKey) && h.length === 2) hh = w / ratio;
      else if (media || ev.shiftKey) { if (h === 'n' || h === 's') w = hh * ratio; else hh = w / ratio; }
      if (h.includes('e') || h.includes('w')) el.style.width = `${Math.round(w)}px`;
      if (h.includes('s') || h.includes('n') || ((media || ev.shiftKey) && h.length === 2)) el.style.height = `${Math.round(hh)}px`;
      if (media && (h === 'e' || h === 'w')) el.style.height = `${Math.round(hh)}px`;
      if (h.includes('w')) el.style.left = `${Math.round(l0 + (r0.width - w))}px`;
      if (h.includes('n')) el.style.top = `${Math.round(t0 + (r0.height - hh))}px`;
    });
  }
  private startMove(e: PointerEvent): void {
    const el = this.sel; if (!el || el === this.doc.body) return;
    this.ensureOffsetable(el);
    const cs = this.doc.defaultView!.getComputedStyle(el);
    const l0 = parseFloat(cs.left) || 0, t0 = parseFloat(cs.top) || 0;
    this.drag2(e, (dx, dy) => { el.style.left = `${Math.round(l0 + dx)}px`; el.style.top = `${Math.round(t0 + dy)}px`; });
  }
  private zValues(): number[] {
    const w = this.doc.defaultView!;
    return [...this.doc.body.querySelectorAll<HTMLElement>('*')].map((e) => parseInt(w.getComputedStyle(e).zIndex, 10)).filter((n) => Number.isFinite(n));
  }
  private setZ(el: HTMLElement, z: number): void {
    const par = el.parentElement ? this.css(el.parentElement, 'display') : '';
    if (this.css(el, 'position') === 'static' && !/flex|grid/.test(par)) el.style.position = 'relative';
    el.style.zIndex = String(z);
    this.commit(); this.placeFloat();
  }
  private arrange(how: 'front' | 'back' | 'up' | 'down'): void {
    const el = this.sel; if (!el || el === this.doc.body) return;
    const cur = parseInt(this.css(el, 'z-index'), 10) || 0, all = this.zValues();
    const z = how === 'front' ? Math.max(0, ...all) + 1 : how === 'back' ? Math.max(0, Math.min(0, ...all) - 1) : how === 'up' ? cur + 1 : cur - 1;
    this.setZ(el, z);
    this.renderInspector();
  }

  private nudge(dir: -1 | 1): void {
    const el = this.sel; if (!el || el === this.doc.body) return;
    const sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    if (!sib || SKIP.has(sib.tagName) || sib.hasAttribute('data-gz-editor')) return;
    dir < 0 ? el.parentElement!.insertBefore(el, sib) : el.parentElement!.insertBefore(sib, el);
    this.commit(); this.placeFloat();
  }
  private duplicate(): void {
    const el = this.sel; if (!el || el === this.doc.body) return;
    const c = el.cloneNode(true) as HTMLElement; c.removeAttribute('data-gz-sel');
    el.after(c); this.select(c); this.commit();
  }
  private remove(): void {
    const el = this.sel; if (!el || el === this.doc.body) return;
    this.select(null); el.remove(); this.commit();
  }

  // ---------- palette + drag/drop ----------
  private buildPalette(host: HTMLElement): void {
    for (const group of [...new Set(BLOCKS.map((b) => b.group))]) {
      const h = document.createElement('h4'); h.textContent = group; host.appendChild(h);
      const grid = document.createElement('div'); grid.className = 'wb-blocks'; host.appendChild(grid);
      for (const b of BLOCKS.filter((x) => x.group === group)) {
        const btn = document.createElement('button');
        btn.type = 'button'; btn.className = 'wb-block'; btn.draggable = true; btn.title = `Add ${b.label} (click or drag)`;
        btn.innerHTML = `<span class="wb-block-ico"></span><span class="wb-block-lbl"></span>`;
        (btn.firstChild as HTMLElement).textContent = b.icon;
        (btn.lastChild as HTMLElement).textContent = b.label;
        btn.addEventListener('dragstart', (e) => { this.drag = { block: b }; e.dataTransfer?.setData('text/plain', b.id); });
        btn.addEventListener('dragend', () => this.endDrag());
        btn.addEventListener('click', () => this.addBlock(b));
        grid.appendChild(btn);
      }
    }
  }
  private create(b: Block): HTMLElement {
    const t = document.createElement('template'); t.innerHTML = b.html.trim();
    return this.doc.importNode(t.content.firstElementChild!, true) as HTMLElement;
  }
  /** Click-to-add (touch friendly): after the selection, or at the end of the page. */
  private addBlock(b: Block): void {
    if (!this.doc) return;
    this.setLive(false);
    const el = this.create(b);
    let ref = this.sel && this.sel !== this.doc.body ? this.sel : null;
    if (ref && b.section) while (ref.parentElement && ref.parentElement !== this.doc.body) ref = ref.parentElement;
    if (ref) ref.after(el); else this.doc.body.appendChild(el);
    this.select(el); this.commit();
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  private endDrag(): void { this.drag = null; this.drop = null; this.dropLine.hidden = true; }

  private bodyKids(): HTMLElement[] {
    return [...this.doc.body.children].filter((c) => !SKIP.has(c.tagName) && c !== this.drag?.el) as HTMLElement[];
  }
  private target(x: number, y: number): Drop | null {
    const d = this.doc, body = d.body, moving = this.drag?.el;
    const section = this.drag?.block ? this.drag.block.section : moving?.parentElement === body;
    let el = d.elementFromPoint(x, y) as HTMLElement | null;
    if (!el || el === d.documentElement) el = body;
    if (moving && (moving === el || moving.contains(el))) return null;
    if (el === body) {
      const kids = this.bodyKids();
      if (!kids.length) return { ref: body, where: 'inside' };
      for (const k of kids) { const r = k.getBoundingClientRect(); if (y < r.top + r.height / 2) return { ref: k, where: 'before' }; }
      return { ref: kids[kids.length - 1]!, where: 'after' };
    }
    if (section) while (el.parentElement && el.parentElement !== body) el = el.parentElement;
    else while (INLINE.has(el.tagName) && el.parentElement && el.parentElement !== body) el = el.parentElement;
    if (!el.children.length && !el.textContent?.trim() && !NO_TEXT.has(el.tagName)) return { ref: el, where: 'inside' };
    const r = el.getBoundingClientRect();
    const ps = el.parentElement ? this.doc.defaultView!.getComputedStyle(el.parentElement) : null;
    const row = !!ps && ps.display.includes('flex') && ps.flexDirection.startsWith('row');
    const before = row ? x < r.left + r.width / 2 : y < r.top + r.height / 2;
    return { ref: el, where: before ? 'before' : 'after' };
  }
  private onDragOver(e: DragEvent): void {
    if (!this.drag) return;
    e.preventDefault();
    const t = this.target(e.clientX, e.clientY);
    this.drop = t;
    if (!t) { this.dropLine.hidden = true; return; }
    const r = t.ref.getBoundingClientRect();
    const s = this.dropLine.style;
    this.dropLine.hidden = false;
    if (t.where === 'inside') { s.left = `${r.left}px`; s.top = `${r.top}px`; s.width = `${r.width}px`; s.height = `${Math.max(r.height, 8)}px`; this.dropLine.dataset.k = 'box'; return; }
    this.dropLine.dataset.k = 'line';
    s.left = `${r.left}px`; s.width = `${r.width}px`; s.height = '4px';
    s.top = `${(t.where === 'before' ? r.top : r.bottom) - 2}px`;
  }
  private onDrop(e: DragEvent): void {
    if (!this.drag) return;
    e.preventDefault();
    const t = this.drop ?? this.target(e.clientX, e.clientY), drag = this.drag;
    this.endDrag();
    if (!t) return;
    const el = drag.block ? this.create(drag.block) : drag.el!;
    if (t.where === 'inside') t.ref.appendChild(el);
    else if (t.where === 'before') t.ref.parentElement!.insertBefore(el, t.ref);
    else t.ref.after(el);
    this.select(el); this.commit();
  }

  // ---------- inspector ----------
  private css(el: HTMLElement, prop: string): string { return this.doc.defaultView!.getComputedStyle(el).getPropertyValue(prop); }
  private setStyle(el: HTMLElement, prop: string, v: string): void {
    if (v === '') el.style.removeProperty(prop); else el.style.setProperty(prop, v);
    this.commit(); this.placeFloat();
  }
  private row(label: string, input: HTMLElement): HTMLElement {
    const l = document.createElement('label'); l.className = 'wb-field';
    const s = document.createElement('span'); s.textContent = label; l.append(s, input); return l;
  }
  private inp(value: string, onChange: (v: string) => void, type = 'text', ph = ''): HTMLInputElement {
    const i = document.createElement('input'); i.type = type; i.value = value; i.placeholder = ph;
    i.addEventListener('change', () => onChange(i.value)); return i;
  }
  private px(el: HTMLElement, prop: string, label: string): HTMLElement {
    const cur = el.style.getPropertyValue(prop) || '';
    return this.row(label, this.inp(cur, (v) => this.setStyle(el, prop, /^\d+(\.\d+)?$/.test(v.trim()) ? `${v.trim()}px` : v.trim()), 'text', this.css(el, prop)));
  }
  private opacityRow(el: HTMLElement): HTMLElement {
    const wrap = document.createElement('span'); wrap.className = 'wb-color';
    const cur = Math.round((parseFloat(this.css(el, 'opacity')) || 0) * 100);
    const r = document.createElement('input'); r.type = 'range'; r.min = '0'; r.max = '100'; r.value = String(isNaN(cur) ? 100 : cur);
    const n = document.createElement('input'); n.type = 'number'; n.min = '0'; n.max = '100'; n.value = r.value; n.style.width = '52px';
    const live = (v: string) => { el.style.opacity = String(+v / 100); n.value = v; r.value = v; };
    r.addEventListener('input', () => live(r.value)); r.addEventListener('change', () => this.setStyle(el, 'opacity', String(+r.value / 100)));
    n.addEventListener('change', () => { live(String(Math.max(0, Math.min(100, +n.value || 0)))); this.setStyle(el, 'opacity', String(+n.value / 100)); });
    wrap.append(r, n); return this.row('Opacity %', wrap);
  }
  private color(el: HTMLElement, prop: string, label: string): HTMLElement {
    const wrap = document.createElement('span'); wrap.className = 'wb-color';
    const c = document.createElement('input'); c.type = 'color'; c.value = toHex(this.css(el, prop)) || '#ffffff';
    c.addEventListener('input', () => el.style.setProperty(prop, c.value));
    c.addEventListener('change', () => this.setStyle(el, prop, c.value));
    const x = document.createElement('button'); x.type = 'button'; x.textContent = '✕'; x.title = 'Clear';
    x.addEventListener('click', () => { this.setStyle(el, prop, ''); this.renderInspector(); });
    wrap.append(c, x); return this.row(label, wrap);
  }
  private select$(el: HTMLElement, prop: string, label: string, opts: string[]): HTMLElement {
    const s = document.createElement('select');
    s.innerHTML = '<option value="">(auto)</option>' + opts.map((o) => `<option>${o}</option>`).join('');
    s.value = el.style.getPropertyValue(prop);
    s.addEventListener('change', () => { this.setStyle(el, prop, s.value); this.renderInspector(); });
    return this.row(label, s);
  }
  private group(title: string, ...rows: HTMLElement[]): HTMLElement {
    const g = document.createElement('details'); g.open = true; g.className = 'wb-group';
    const s = document.createElement('summary'); s.textContent = title; g.append(s, ...rows); return g;
  }
  private area(label: string, value: string, onChange: (v: string) => void, rows = 5): HTMLElement {
    const t = document.createElement('textarea'); t.rows = rows; t.value = value; t.spellcheck = false; t.className = 'wb-code';
    t.addEventListener('change', () => onChange(t.value)); return this.row(label, t);
  }

  private renderInspector(): void {
    const ins = this.inspector; ins.innerHTML = '';
    const el = this.sel;
    if (!this.doc) return;
    if (!el || el === this.doc.body) { this.renderPage(); return; }
    if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT') { this.renderCodeInspector(el); return; }
    const head = document.createElement('div'); head.className = 'wb-ins-head';
    head.textContent = `<${el.tagName.toLowerCase()}>` + (el.id ? `#${el.id}` : '');
    ins.appendChild(head);

    if (el.tagName === 'A') {
      ins.appendChild(this.group('Link',
        this.row('URL', this.inp(el.getAttribute('href') ?? '', (v) => { el.setAttribute('href', v); this.commit(); }, 'text', 'https://…')),
        this.row('New tab', (() => { const c = document.createElement('input'); c.type = 'checkbox'; const an = el as HTMLAnchorElement; c.checked = an.target === '_blank'; c.addEventListener('change', () => { c.checked ? (an.target = '_blank', an.rel = 'noopener') : (el.removeAttribute('target'), el.removeAttribute('rel')); this.commit(); }); return c; })())));
    }
    if (el.tagName === 'IMG' || el.tagName === 'IFRAME') {
      const isImg = el.tagName === 'IMG';
      const file = document.createElement('input'); file.type = 'file'; file.accept = 'image/*'; file.hidden = true;
      const up = document.createElement('button'); up.type = 'button'; up.textContent = '⬆ Upload image'; up.className = 'wb-btn';
      up.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files?.[0]; if (!f) return;
        try { el.setAttribute('src', await embedImage(f)); this.commit(); this.renderInspector(); } catch { /* ignore */ }
      });
      ins.appendChild(this.group(isImg ? 'Image' : 'Embed',
        this.row('Source', this.inp(el.getAttribute('src') ?? '', (v) => { el.setAttribute('src', v); this.commit(); }, 'text', 'https://…')),
        ...(isImg ? [this.row('Alt text', this.inp(el.getAttribute('alt') ?? '', (v) => { el.setAttribute('alt', v); this.commit(); })), up, file] : [])));
    }
    if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
      const isVideo = el.tagName === 'VIDEO';
      const file = document.createElement('input'); file.type = 'file'; file.accept = isVideo ? 'video/*' : 'audio/*'; file.hidden = true;
      const up = document.createElement('button'); up.type = 'button'; up.className = 'wb-btn';
      up.textContent = `⬆ Upload ${isVideo ? 'video' : 'audio'} (max ${MAX_EMBED_MEDIA / 1048576} MB)`;
      const note = document.createElement('p'); note.className = 'wb-tip';
      up.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        const f = file.files?.[0]; if (!f) return;
        note.textContent = 'Embedding…';
        try { el.setAttribute('src', await embedMedia(f)); this.commit(); this.renderInspector(); }
        catch (err) { note.textContent = err instanceof Error && err.message === 'too_large' ? `That file is over ${MAX_EMBED_MEDIA / 1048576} MB — host it somewhere and paste the link instead.` : 'Could not read that file.'; }
      });
      const flag = (attr: string, label: string) => {
        const c = document.createElement('input'); c.type = 'checkbox'; c.checked = el.hasAttribute(attr);
        c.addEventListener('change', () => {
          if (c.checked) el.setAttribute(attr, ''); else el.removeAttribute(attr);
          if (attr === 'autoplay' && c.checked) el.setAttribute('muted', '');
          this.commit();
        });
        return this.row(label, c);
      };
      const src = el.getAttribute('src') ?? '';
      ins.appendChild(this.group(isVideo ? 'Video' : 'Audio',
        this.row('Link', this.inp(src.startsWith('data:') ? '(embedded file)' : src, (v) => { if (v && !v.startsWith('(')) { el.setAttribute('src', v); this.commit(); } }, 'text', 'https://…/file.' + (isVideo ? 'mp4' : 'mp3'))),
        up, file, note,
        ...(isVideo ? [this.row('Poster', this.inp(el.getAttribute('poster') ?? '', (v) => { v ? el.setAttribute('poster', v) : el.removeAttribute('poster'); this.commit(); }, 'text', 'https://…/cover.jpg'))] : []),
        flag('controls', 'Controls'), flag('loop', 'Loop'), flag('muted', 'Muted'), flag('autoplay', 'Autoplay')));
    }
    ins.appendChild(this.group('Text',
      this.px(el, 'font-size', 'Size'),
      this.select$(el, 'font-weight', 'Weight', ['400', '500', '600', '700', '800']),
      this.select$(el, 'text-align', 'Align', ['left', 'center', 'right', 'justify']),
      this.color(el, 'color', 'Color')));
    ins.appendChild(this.group('Box',
      this.color(el, 'background-color', 'Background'),
      this.row('Gradient', this.inp(el.style.getPropertyValue('background-image'), (v) => this.setStyle(el, 'background-image', v), 'text', 'linear-gradient(…)')),
      this.px(el, 'padding', 'Padding'), this.px(el, 'margin', 'Margin'),
      this.px(el, 'border-radius', 'Radius'), this.px(el, 'width', 'Width'), this.px(el, 'max-width', 'Max width'),
      this.row('Shadow', this.inp(el.style.getPropertyValue('box-shadow'), (v) => this.setStyle(el, 'box-shadow', v), 'text', '0 4px 20px rgba(0,0,0,.15)')),
      this.opacityRow(el),
      this.select$(el, 'mix-blend-mode', 'Blend', ['multiply', 'screen', 'overlay', 'soft-light', 'hard-light', 'color-dodge', 'difference', 'luminosity'])));
    ins.appendChild(this.group('Arrange & position',
      this.select$(el, 'position', 'Position', ['static', 'relative', 'absolute', 'fixed', 'sticky']),
      this.px(el, 'left', 'Left'), this.px(el, 'top', 'Top'), this.px(el, 'right', 'Right'), this.px(el, 'bottom', 'Bottom'),
      this.row('Layer (z)', this.inp(el.style.zIndex, (v) => { if (v.trim() === '') { this.setStyle(el, 'z-index', ''); } else if (!isNaN(+v)) this.setZ(el, Math.round(+v)); }, 'text', this.css(el, 'z-index'))),
      (() => { const bar = document.createElement('div'); bar.className = 'wb-codebar wb-arrange';
        for (const [l, f] of [['⤒ Front', 'front'], ['↑ Forward', 'up'], ['↓ Back', 'down'], ['⤓ Bottom', 'back']] as const) {
          const b = document.createElement('button'); b.type = 'button'; b.className = 'wb-btn'; b.textContent = l; b.addEventListener('click', () => this.arrange(f)); bar.appendChild(b);
        } return bar; })(),
      this.px(el, 'height', 'Height'), this.px(el, 'min-height', 'Min height')));
    ins.appendChild(this.group('Layout',
      this.select$(el, 'display', 'Display', ['block', 'flex', 'grid', 'inline-block', 'none']),
      this.select$(el, 'flex-direction', 'Direction', ['row', 'column']),
      this.select$(el, 'justify-content', 'Justify', ['flex-start', 'center', 'flex-end', 'space-between', 'space-around']),
      this.select$(el, 'align-items', 'Align items', ['flex-start', 'center', 'flex-end', 'stretch']),
      this.px(el, 'gap', 'Gap')));
    ins.appendChild(this.group('Advanced',
      this.row('ID', this.inp(el.id, (v) => { v ? el.id = v : el.removeAttribute('id'); this.commit(); })),
      this.row('Class', this.inp(el.getAttribute('class') ?? '', (v) => { v ? el.setAttribute('class', v) : el.removeAttribute('class'); this.commit(); })),
      this.area('Style (CSS)', el.getAttribute('style') ?? '', (v) => { v.trim() ? el.setAttribute('style', v) : el.removeAttribute('style'); this.commit(); this.renderInspector(); }, 4),
      this.area('HTML', el.outerHTML.replace(/ data-gz-sel=""/, ''), (v) => this.replaceHtml(el, v), 6)));
  }

  // ---------- CSS / JS blocks ----------
  private codeEls(): HTMLElement[] {
    return [...this.doc.querySelectorAll<HTMLElement>('style,script')].filter((e) => !e.hasAttribute('data-gz-editor') && !(e as HTMLScriptElement).src);
  }
  private buildCodePanel(host: HTMLElement): void {
    const h = document.createElement('h4'); h.textContent = 'Code & behaviors'; host.appendChild(h);
    this.codeList = document.createElement('div'); this.codeList.className = 'wb-codelist'; host.appendChild(this.codeList);
    const add = document.createElement('div'); add.className = 'wb-blocks';
    const mk = (label: string, fn: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'wb-block'; b.textContent = label; b.addEventListener('click', fn); return b; };
    add.append(mk('+ CSS', () => this.addCode('style')), mk('+ JS', () => this.addCode('script')));
    host.appendChild(add);
    const sel = document.createElement('select'); sel.className = 'wb-snippets'; sel.setAttribute('aria-label', 'Add a behavior');
    sel.innerHTML = '<option value="">Add behavior…</option>' + SNIPPETS.map((x) => `<option value="${x.id}">${x.label}</option>`).join('');
    sel.addEventListener('change', () => { const sn = SNIPPETS.find((x) => x.id === sel.value); sel.value = ''; if (sn) this.addSnippet(sn.id); });
    host.appendChild(sel);
  }
  private addCode(kind: 'style' | 'script', text = ''): HTMLElement {
    const el = this.doc.createElement(kind);
    el.textContent = text || (kind === 'style' ? '/* your CSS */\n' : '// your JavaScript (runs in Live / Preview)\n');
    (kind === 'style' ? this.doc.head : this.doc.body).appendChild(el);
    this.select(el); this.commit();
    return el;
  }
  private addSnippet(id: string): void {
    if (!this.doc) return;
    const sn = SNIPPETS.find((x) => x.id === id)!;
    if (sn.html) { const t = document.createElement('template'); t.innerHTML = sn.html; this.doc.body.appendChild(this.doc.importNode(t.content.firstElementChild!, true)); }
    if (sn.css) { const st = this.doc.createElement('style'); st.textContent = sn.css; this.doc.head.appendChild(st); }
    let last: HTMLElement | null = null;
    if (sn.js) { const sc = this.doc.createElement('script'); sc.textContent = sn.js; this.doc.body.appendChild(sc); last = sc; }
    this.commit(); if (last) this.select(last);
    this.codeTip = sn.tip; this.renderInspector();
  }
  private codeTip = '';
  private renderCodeList(): void {
    if (!this.codeList || !this.doc) return;
    this.codeList.innerHTML = '';
    let c = 0, j = 0;
    for (const el of this.codeEls()) {
      const isCss = el.tagName === 'STYLE';
      const n = isCss ? ++c : ++j;
      const b = document.createElement('button'); b.type = 'button'; b.className = 'wb-codechip';
      const off = el.hasAttribute('data-gz-off');
      b.textContent = `${isCss ? '🎨 CSS' : '⚡ JS'} ${n} · ${(el.textContent ?? '').split('\n').length} lines${off ? ' · off' : ''}`;
      b.setAttribute('aria-pressed', String(el === this.sel));
      b.addEventListener('click', () => { this.setLive(false); this.select(el); });
      this.codeList.appendChild(b);
    }
    if (!this.codeList.children.length) { const p = document.createElement('p'); p.className = 'wb-tip'; p.textContent = 'No custom CSS or JS yet.'; this.codeList.appendChild(p); }
  }
  private renderCodeInspector(el: HTMLElement): void {
    const ins = this.inspector, isCss = el.tagName === 'STYLE';
    const head = document.createElement('div'); head.className = 'wb-ins-head'; head.textContent = isCss ? 'CSS block' : 'JavaScript block'; ins.appendChild(head);
    const on = document.createElement('input'); on.type = 'checkbox'; on.checked = !el.hasAttribute('data-gz-off');
    on.addEventListener('change', () => {
      if (on.checked) { el.removeAttribute('data-gz-off'); isCss ? el.removeAttribute('media') : el.setAttribute('type', el.getAttribute('data-gz-type') || ''); if (!isCss && !el.getAttribute('type')) el.removeAttribute('type'); el.removeAttribute('data-gz-type'); }
      else { el.setAttribute('data-gz-off', ''); if (isCss) el.setAttribute('media', 'not all'); else { el.setAttribute('data-gz-type', el.getAttribute('type') ?? ''); el.setAttribute('type', 'text/plain'); } }
      this.commit(); this.renderCodeList();
    });
    const ta = document.createElement('textarea'); ta.className = 'wb-code'; ta.spellcheck = false; ta.rows = 18; ta.value = el.textContent ?? '';
    ta.addEventListener('change', () => { el.textContent = ta.value; this.commit(); this.renderCodeList(); });
    const mv = (dir: -1 | 1) => { const sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling; if (!sib) return; dir < 0 ? el.parentElement!.insertBefore(el, sib) : el.parentElement!.insertBefore(sib, el); this.commit(); this.renderCodeList(); };
    const bar = document.createElement('div'); bar.className = 'wb-codebar';
    for (const [l, f] of [['↑ Earlier', () => mv(-1)], ['↓ Later', () => mv(1)], ['🗑 Delete', () => { el.remove(); this.select(null); this.commit(); this.renderCodeList(); }]] as Array<[string, () => void]>) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'wb-btn'; b.textContent = l; b.addEventListener('click', f); bar.appendChild(b);
    }
    ins.append(this.group('Settings', this.row('Enabled', on)), this.group('Code', ta), bar);
    const tip = document.createElement('p'); tip.className = 'wb-tip';
    tip.textContent = (this.codeTip ? this.codeTip + ' ' : '') + (isCss ? 'CSS applies right here in Design.' : 'JavaScript runs in ▶ Live and Preview, not in the editing canvas.');
    this.codeTip = ''; ins.appendChild(tip);
    this.renderCodeList();
  }

  /** ▶ Live: run the page with its JS in the isolated frame (view only). */
  private setLive(on: boolean): void {
    if (on === this.live || !this.doc) return;
    this.live = on;
    this.root.querySelector('[data-act="live"]')?.setAttribute('aria-pressed', String(on));
    this.root.classList.toggle('wb-live', on);
    if (on) {
      this.stopEdit(); this.select(null);
      this.liveFrame = new SiteFrame(this.device, 'Live page');
      this.liveFrame.el.className = 'wb-livepage';
      this.liveFrame.show(this.serialize());
    } else { this.liveFrame?.destroy(); this.liveFrame = undefined; }
  }

  private replaceHtml(el: HTMLElement, html: string): void {
    const t = document.createElement('template'); t.innerHTML = html.trim();
    const n = t.content.firstElementChild; if (!n) return;
    const imp = this.doc.importNode(n, true) as HTMLElement;
    el.replaceWith(imp); this.select(imp); this.commit();
  }

  private renderPage(): void {
    const d = this.doc, ins = this.inspector;
    const head = document.createElement('div'); head.className = 'wb-ins-head'; head.textContent = 'Page'; ins.appendChild(head);
    const style = () => [...d.querySelectorAll('style')].find((s) => !s.hasAttribute('data-gz-editor'));
    const script = () => [...d.querySelectorAll('script:not([src])')].pop();
    ins.appendChild(this.group('Page',
      this.row('Title', this.inp(d.title, (v) => { d.title = v; if (!d.querySelector('title')) { const t = d.createElement('title'); t.textContent = v; d.head.appendChild(t); } this.commit(); })),
      this.color(d.body, 'background-color', 'Background'),
      this.color(d.body, 'color', 'Text color'),
      this.select$(d.body, 'font-family', 'Font', ['system-ui, sans-serif', 'Georgia, serif', '"Courier New", monospace', '"Trebuchet MS", sans-serif', 'Impact, sans-serif', 'Palatino, serif'])));
    ins.appendChild(this.group('Page CSS',
      this.area('Stylesheet', style()?.textContent ?? '', (v) => {
        let s = style();
        if (!s) { s = d.createElement('style'); d.head.appendChild(s); }
        s.textContent = v; this.commit();
      }, 9)));
    ins.appendChild(this.group('Page JavaScript',
      this.area('Runs in Preview', script()?.textContent ?? '', (v) => {
        let s = script();
        if (!v.trim()) { s?.remove(); this.commit(); return; }
        if (!s) { s = d.createElement('script'); d.body.appendChild(s); }
        s.textContent = v; this.commit();
      }, 9)));
    const tip = document.createElement('p'); tip.className = 'wb-tip';
    tip.textContent = 'Click anything on the page to style it. Use the Code tab for full HTML, CSS and JS.';
    ins.appendChild(tip);
  }
}
