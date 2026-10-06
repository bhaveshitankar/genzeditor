import type { DocEditor } from './registry';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Normalise a CSS colour (rgb(), #rgb, #rrggbb) to a 6-digit hex without '#',
// as the docx library expects. Returns undefined for anything unrecognised.
function toHex(c: string): string | undefined {
  if (!c) return undefined;
  const s = c.trim();
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (rgb) {
    const parts = rgb[1]!.split(',').map((p) => parseFloat(p));
    if (parts.length >= 3) return parts.slice(0, 3).map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
  }
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = h.split('').map((x) => x + x).join('');
    return h.toLowerCase();
  }
  return undefined;
}

// DOCX rich-text editor. Imports .docx via mammoth (→ HTML), edits in a
// contenteditable surface with a formatting toolbar, and exports back to .docx
// via the `docx` library. Common formatting (headings, bold/italic/underline,
// lists) survives the round-trip; complex layouts are simplified.
export class DocxEditor implements DocEditor {
  private host: HTMLElement;
  private onChange: () => void;
  private editable!: HTMLElement;
  private zoom = 100;
  private name: string;

  private constructor(host: HTMLElement, onChange: () => void, name: string) {
    this.host = host;
    this.onChange = onChange;
    this.name = name;
  }

  static async open(host: HTMLElement, blob: Blob, onChange: () => void, name = 'document.docx'): Promise<DocxEditor> {
    const ed = new DocxEditor(host, onChange, name);
    ed.renderShell();
    if (blob.size > 0) {
      try {
        const mammoth = await import('mammoth/mammoth.browser.js');
        const conv = (mammoth.default ?? mammoth) as { convertToHtml: (i: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
        const result = await conv.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
        ed.editable.innerHTML = result.value || '<p><br></p>';
      } catch (err) {
        ed.editable.innerHTML = `<p>Could not import this document: ${err instanceof Error ? err.message : String(err)}</p>`;
      }
    } else {
      ed.editable.innerHTML = '<p><br></p>';
    }
    return ed;
  }

  destroy(): void { /* host clears its own DOM */ }

  // Build a docx ImageRun from an inline data-URL <img>. Returns null for
  // external images (the docx lib can't fetch them here). `ImageRun` is passed
  // in to avoid importing docx at module scope.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private imageRun(img: HTMLImageElement, ImageRun: any): any {
    const src = img.getAttribute('src') || '';
    const m = /^data:image\/(png|jpe?g|gif|bmp);base64,(.+)$/i.exec(src);
    if (!m) return null;
    const type = m[1]!.toLowerCase() === 'jpeg' ? 'jpg' : m[1]!.toLowerCase();
    const bin = atob(m[2]!);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let w = img.naturalWidth || img.width || 240;
    let h = img.naturalHeight || img.height || 120;
    const maxW = 450;
    if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
    return new ImageRun({ type, data: bytes, transformation: { width: w, height: h } });
  }

  /** Current document body as HTML (for AI editing). */
  getHtml(): string { return this.editable.innerHTML; }

  /** Replace the document body with new HTML and trigger autosave. */
  setHtml(html: string): string {
    this.editable.innerHTML = html;
    this.onChange();
    return 'document updated';
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    const docx = await import('docx');
    const { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType, ExternalHyperlink, ShadingType } = docx;
    type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
    const blocks: Block[] = [];

    interface Fmt { bold?: boolean; italics?: boolean; underline?: boolean; strike?: boolean; color?: string; highlight?: string; size?: number; link?: string }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Run = any;

    const sizeFromFontTag = (v: string | null): number | undefined => {
      const map: Record<string, number> = { '1': 8, '2': 10, '3': 12, '4': 14, '5': 18, '6': 24, '7': 36 };
      return v && map[v] ? map[v] * 2 : undefined; // docx size is half-points
    };

    const runsFrom = (node: Node): Run[] => {
      const runs: Run[] = [];
      const walk = (n: Node, fmt: Fmt) => {
        if (n.nodeType === Node.TEXT_NODE) {
          const text = n.textContent ?? '';
          if (text) {
            const run = new TextRun({
              text, bold: fmt.bold, italics: fmt.italics,
              underline: fmt.underline ? {} : undefined, strike: fmt.strike,
              color: fmt.color, size: fmt.size,
              shading: fmt.highlight ? { type: ShadingType.CLEAR, color: 'auto', fill: fmt.highlight } : undefined,
            });
            runs.push(fmt.link ? new ExternalHyperlink({ children: [run], link: fmt.link }) : run);
          }
          return;
        }
        if (n.nodeType !== Node.ELEMENT_NODE) return;
        const el = n as HTMLElement;
        const tag = el.tagName.toLowerCase();
        if (tag === 'br') { runs.push(new TextRun({ text: '', break: 1 })); return; }
        if (tag === 'img') {
          const img = this.imageRun(el as HTMLImageElement, ImageRun);
          if (img) runs.push(img);
          return;
        }
        const next: Fmt = { ...fmt };
        const style = el.style;
        if (tag === 'b' || tag === 'strong') next.bold = true;
        if (tag === 'i' || tag === 'em') next.italics = true;
        if (tag === 'u') next.underline = true;
        if (tag === 's' || tag === 'strike' || tag === 'del') next.strike = true;
        if (style.fontWeight === 'bold' || Number(style.fontWeight) >= 600) next.bold = true;
        if (style.fontStyle === 'italic') next.italics = true;
        if ((style.textDecorationLine || style.textDecoration).includes('line-through')) next.strike = true;
        if ((style.textDecorationLine || style.textDecoration).includes('underline')) next.underline = true;
        const color = el.getAttribute('color') || style.color;
        if (color) next.color = toHex(color);
        if (style.backgroundColor) next.highlight = toHex(style.backgroundColor);
        const sz = sizeFromFontTag(el.getAttribute('size'));
        if (sz) next.size = sz;
        if (tag === 'a') next.link = (el as HTMLAnchorElement).getAttribute('href') || next.link;
        el.childNodes.forEach((c) => walk(c, next));
      };
      walk(node, {});
      return runs.length ? runs : [new TextRun('')];
    };

    const alignOf = (el: HTMLElement) => {
      const a = el.style.textAlign;
      return a === 'center' ? AlignmentType.CENTER : a === 'right' ? AlignmentType.RIGHT
        : a === 'justify' ? AlignmentType.JUSTIFIED : undefined;
    };

    const tableFrom = (el: HTMLTableElement): InstanceType<typeof Table> => {
      const rows: InstanceType<typeof TableRow>[] = [];
      el.querySelectorAll('tr').forEach((tr) => {
        const cells: InstanceType<typeof TableCell>[] = [];
        tr.querySelectorAll('td,th').forEach((td) => {
          cells.push(new TableCell({ children: [new Paragraph({ children: runsFrom(td) })] }));
        });
        if (cells.length) rows.push(new TableRow({ children: cells }));
      });
      return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
    };

    const pushBlock = (el: HTMLElement) => {
      const tag = el.tagName.toLowerCase();
      const headingMap: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
        h1: HeadingLevel.HEADING_1, h2: HeadingLevel.HEADING_2, h3: HeadingLevel.HEADING_3,
        h4: HeadingLevel.HEADING_4, h5: HeadingLevel.HEADING_5, h6: HeadingLevel.HEADING_6,
      };
      if (tag === 'table') { blocks.push(tableFrom(el as HTMLTableElement)); return; }
      if (tag === 'hr') { blocks.push(new Paragraph({ thematicBreak: true })); return; }
      if (tag === 'img') { const r = this.imageRun(el as HTMLImageElement, ImageRun); blocks.push(new Paragraph({ children: r ? [r] : [new TextRun('')] })); return; }
      if (tag in headingMap) {
        blocks.push(new Paragraph({ heading: headingMap[tag], alignment: alignOf(el), children: runsFrom(el) }));
      } else if (tag === 'ul' || tag === 'ol') {
        const walkList = (listEl: Element, level: number) => {
          listEl.querySelectorAll(':scope > li').forEach((li) => {
            const level0 = level === 0;
            const children = runsFrom(li);
            blocks.push(new Paragraph({
              children, alignment: alignOf(li as HTMLElement),
              ...(tag === 'ul' ? { bullet: { level } } : { numbering: { reference: 'num', level } }),
            }));
            // Handle nested lists
            li.querySelectorAll(':scope > ul, :scope > ol').forEach((sublist) => {
              walkList(sublist as Element, level + 1);
            });
          });
        };
        walkList(el, 0);
      } else {
        blocks.push(new Paragraph({ alignment: alignOf(el), children: runsFrom(el) }));
      }
    };

    const children = Array.from(this.editable.childNodes);
    if (children.length === 0) blocks.push(new Paragraph({ children: [new TextRun('')] }));
    for (const node of children) {
      if (node.nodeType === Node.ELEMENT_NODE) pushBlock(node as HTMLElement);
      else if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) {
        blocks.push(new Paragraph({ children: [new TextRun(node.textContent ?? '')] }));
      }
    }

    const doc = new Document({
      numbering: { config: [{ reference: 'num', levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: 'left' }] }] },
      sections: [{ children: blocks }],
    });
    const blob = await Packer.toBlob(doc);
    return { blob, contentType: DOCX_MIME };
  }

  // Convert the current document to a PDF (laid out with pdf-lib) and download it.
  // Headings get larger/bold type; inline bold/italic is preserved by swapping
  // between the four Helvetica variants during word-wrapping.
  private async exportPdf(btn?: HTMLButtonElement): Promise<void> {
    const label = btn?.textContent ?? '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
      const pdf = await PDFDocument.create();
      const F = {
        normal: await pdf.embedFont(StandardFonts.Helvetica),
        bold: await pdf.embedFont(StandardFonts.HelveticaBold),
        italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
        boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
      };
      const fontFor = (b: boolean, i: boolean) => b && i ? F.boldItalic : b ? F.bold : i ? F.italic : F.normal;

      const PAGE_W = 612, PAGE_H = 792, MARGIN = 56;
      let page = pdf.addPage([PAGE_W, PAGE_H]);
      let y = PAGE_H - MARGIN;

      interface Word { t: string; b: boolean; i: boolean }
      // Flatten a block element into whitespace-split styled words.
      const wordsOf = (el: HTMLElement, forceBold: boolean): Word[] => {
        const out: Word[] = [];
        const walk = (n: Node, b: boolean, i: boolean) => {
          if (n.nodeType === Node.TEXT_NODE) {
            for (const part of (n.textContent ?? '').split(/(\s+)/)) {
              if (part === '') continue;
              out.push({ t: part.replace(/\s+/g, ' '), b, i });
            }
            return;
          }
          if (n.nodeType !== Node.ELEMENT_NODE) return;
          const tag = (n as HTMLElement).tagName.toLowerCase();
          const nb = b || tag === 'b' || tag === 'strong';
          const ni = i || tag === 'i' || tag === 'em';
          n.childNodes.forEach((c) => walk(c, nb, ni));
        };
        walk(el, forceBold, false);
        return out;
      };

      // Lay a run of words out with wrapping + pagination at the given size/indent.
      const drawWords = (words: Word[], size: number, indent: number) => {
        const lineH = size * 1.35;
        const maxX = PAGE_W - MARGIN;
        let x = MARGIN + indent;
        const newline = () => {
          y -= lineH;
          if (y < MARGIN) { page = pdf.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }
          x = MARGIN + indent;
        };
        if (words.length === 0) { newline(); return; }
        for (const w of words) {
          const f = fontFor(w.b, w.i);
          const ww = f.widthOfTextAtSize(w.t, size);
          if (x + ww > maxX && x > MARGIN + indent) newline();
          // A leading space at the start of a line is dropped.
          if (!(w.t === ' ' && x === MARGIN + indent)) {
            page.drawText(w.t, { x, y: y - size, size, font: f, color: rgb(0, 0, 0) });
            x += ww;
          }
        }
        newline();
      };

      const SIZES: Record<string, number> = { h1: 22, h2: 18, h3: 15, h4: 13, h5: 12, h6: 11 };
      let listIndex = 0;
      for (const node of Array.from(this.editable.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = (node.textContent ?? '').trim();
          if (t) drawWords([{ t, b: false, i: false }], 11, 0);
          continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as HTMLElement;
        const tag = el.tagName.toLowerCase();
        if (tag in SIZES) {
          y -= 6; // a little space above headings
          drawWords(wordsOf(el, true), SIZES[tag]!, 0);
        } else if (tag === 'ul' || tag === 'ol') {
          listIndex = 0;
          el.querySelectorAll(':scope > li').forEach((li) => {
            listIndex += 1;
            const marker: Word = { t: tag === 'ul' ? '•' : `${listIndex}.`, b: false, i: false };
            drawWords([marker, { t: ' ', b: false, i: false }, ...wordsOf(li as HTMLElement, false)], 11, 18);
          });
        } else {
          drawWords(wordsOf(el, false), 11, 0);
        }
      }

      const bytes = await pdf.save();
      const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const outName = this.name.replace(/\.[^.]+$/, '') + '.pdf';
      this.download(new Blob([ab], { type: 'application/pdf' }), outName);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  private download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private renderShell() {
    this.host.innerHTML = `
      <div class="docx-editor">
        <div class="docx-toolbar" data-role="fmt">
          <button type="button" data-cmd="undo" title="Undo (Ctrl+Z)">↶</button>
          <button type="button" data-cmd="redo" title="Redo (Ctrl+Y)">↷</button>
          <span class="docx-sep"></span>
          <button type="button" data-cmd="bold" title="Bold"><b>B</b></button>
          <button type="button" data-cmd="italic" title="Italic"><i>I</i></button>
          <button type="button" data-cmd="underline" title="Underline"><u>U</u></button>
          <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
          <label class="docx-color" title="Text color">A<input type="color" data-color="foreColor" value="#111111"></label>
          <label class="docx-color docx-hilite" title="Highlight color"><span class="docx-hilite-icon">▌</span><input type="color" data-color="hiliteColor" value="#ffe600"></label>
          <select data-role="fontsize" title="Font size">
            <option value="">Size</option>
            <option value="1">8pt</option>
            <option value="2">9pt</option>
            <option value="3" selected>12pt</option>
            <option value="4">14pt</option>
            <option value="5">18pt</option>
            <option value="6">24pt</option>
            <option value="7">36pt</option>
          </select>
          <span class="docx-sep"></span>
          <div class="docx-dropdown" data-role="format-menu">
            <button type="button" class="docx-menu-btn" title="Format">⚡ Format ▼</button>
            <div class="docx-menu" data-menu="format">
              <button type="button" data-block="h1">Heading 1</button>
              <button type="button" data-block="h2">Heading 2</button>
              <button type="button" data-block="h3">Heading 3</button>
              <button type="button" data-block="p">Paragraph</button>
            </div>
          </div>
          <div class="docx-dropdown" data-role="align-menu">
            <button type="button" class="docx-menu-btn" title="Alignment">≡ Align ▼</button>
            <div class="docx-menu" data-menu="align">
              <button type="button" data-cmd="justifyLeft" title="Align left">⯇ Left</button>
              <button type="button" data-cmd="justifyCenter" title="Align center">≡ Center</button>
              <button type="button" data-cmd="justifyRight" title="Align right">⯈ Right</button>
            </div>
          </div>
          <div class="docx-dropdown" data-role="list-menu">
            <button type="button" class="docx-menu-btn" title="Lists">≣ List ▼</button>
            <div class="docx-menu" data-menu="list">
              <button type="button" data-cmd="insertUnorderedList">• Bullet list</button>
              <button type="button" data-cmd="insertOrderedList">1. Numbered list</button>
            </div>
          </div>
          <span class="docx-sep"></span>
          <div class="docx-dropdown" data-role="insert-menu">
            <button type="button" class="docx-menu-btn" title="Insert">+ Insert ▼</button>
            <div class="docx-menu" data-menu="insert">
              <button type="button" data-ins="link">🔗 Link</button>
              <button type="button" data-ins="image">🖼 Image</button>
              <button type="button" data-ins="table">▦ Table</button>
              <button type="button" data-ins="hr">— Divider</button>
              <button type="button" data-ins="pagesetup">⚙ Page setup</button>
              <button type="button" data-ins="sign">✍ Signature</button>
            </div>
          </div>
          <button type="button" data-cmd="unlink" title="Remove link">🔗‌ Unlink</button>
          <button type="button" data-cmd="removeFormat" title="Clear formatting">⌫ Clear</button>
          <button type="button" data-ins="find" title="Find & Replace">🔍 Find</button>
          <span class="docx-sep"></span>
          <button type="button" data-role="save-pdf" title="Save as PDF">⤓ PDF</button>
        </div>
        <div class="docx-page" contenteditable="true" data-role="editable" spellcheck="true"></div>
        <div class="docx-zoom" data-role="zoom">
          <button type="button" data-zoom="out" title="Zoom out">−</button>
          <input type="range" data-role="zoom-slider" min="50" max="200" value="100" step="10">
          <span data-role="zoom-value">100%</span>
          <button type="button" data-zoom="in" title="Zoom in">+</button>
          <button type="button" data-zoom="reset" title="Reset zoom">Reset</button>
        </div>
        <input type="file" accept="image/*" data-role="img-input" hidden>
      </div>`;
    this.editable = this.host.querySelector('[data-role="editable"]') as HTMLElement;
    const bar = this.host.querySelector('[data-role="fmt"]') as HTMLElement;
    const hiliteIcon = bar.querySelector('.docx-hilite-icon') as HTMLElement;
    bar.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
    bar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      const menuBtn = btn.closest('.docx-dropdown')?.querySelector('.docx-menu-btn');
      if (menuBtn && btn === menuBtn) {
        const menu = btn.parentElement?.querySelector('.docx-menu') as HTMLElement;
        if (menu) {
          const isOpen = menu.style.display === 'block';
          bar.querySelectorAll('.docx-menu').forEach(m => (m as HTMLElement).style.display = 'none');
          menu.style.display = isOpen ? 'none' : 'block';
        }
        return;
      }
      // Close menus when clicking menu items
      bar.querySelectorAll('.docx-menu').forEach(m => (m as HTMLElement).style.display = 'none');

      if (btn.getAttribute('data-role') === 'save-pdf') { void this.exportPdf(btn as HTMLButtonElement); return; }
      const ins = btn.getAttribute('data-ins');
      if (ins) { void this.insertAction(ins); return; }
      const cmd = btn.getAttribute('data-cmd');
      const block = btn.getAttribute('data-block');
      this.editable.focus();
      if (cmd === 'undo') { document.execCommand('undo', false); this.onChange(); }
      else if (cmd === 'redo') { document.execCommand('redo', false); this.onChange(); }
      else if (cmd) { document.execCommand(cmd, false); this.onChange(); }
      else if (block) { document.execCommand('formatBlock', false, block === 'p' ? 'p' : block); this.onChange(); }
    });

    document.addEventListener('keydown', (e) => {
      if (!this.editable.contains(document.activeElement)) return;
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) { e.preventDefault(); document.execCommand('undo', false); this.onChange(); }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); document.execCommand('redo', false); this.onChange(); }
    });

    // Color pickers (text + highlight): apply on input, keep selection.
    bar.querySelectorAll<HTMLInputElement>('input[data-color]').forEach((inp) => {
      inp.addEventListener('mousedown', () => this.saveSelection());
      inp.addEventListener('input', () => {
        const cmd = inp.getAttribute('data-color')!;
        if (cmd === 'hiliteColor' && hiliteIcon) {
          hiliteIcon.style.color = inp.value;
        }
        this.restoreSelection();
        this.editable.focus();
        this.restoreSelection();
        document.execCommand(cmd, false, inp.value);
        this.onChange();
      });
      if (inp.getAttribute('data-color') === 'hiliteColor') {
        hiliteIcon.style.color = inp.value;
      }
    });

    // Font size select.
    const sizeSel = bar.querySelector('[data-role="fontsize"]') as HTMLSelectElement;
    sizeSel.addEventListener('mousedown', () => this.saveSelection());
    sizeSel.addEventListener('change', () => {
      if (!sizeSel.value) return;
      this.editable.focus();
      this.restoreSelection();
      document.execCommand('fontSize', false, sizeSel.value);
      this.onChange();
    });

    // Zoom controls
    const zoomSlider = this.host.querySelector('[data-role="zoom-slider"]') as HTMLInputElement;
    const zoomValue = this.host.querySelector('[data-role="zoom-value"]') as HTMLElement;
    const zoomContainer = this.host.querySelector('[data-role="zoom"]') as HTMLElement;
    const updateZoom = (val: number) => {
      this.zoom = Math.max(50, Math.min(200, val));
      zoomSlider.value = String(this.zoom);
      zoomValue.textContent = `${this.zoom}%`;
      this.editable.style.transform = `scale(${this.zoom / 100})`;
      this.editable.style.transformOrigin = 'top left';
      this.editable.style.width = `${100 * 100 / this.zoom}%`;
    };
    if (zoomContainer) {
      zoomContainer.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (!btn) return;
        const zoomAction = btn.getAttribute('data-zoom');
        if (zoomAction === 'in') updateZoom(this.zoom + 10);
        else if (zoomAction === 'out') updateZoom(this.zoom - 10);
        else if (zoomAction === 'reset') updateZoom(100);
      });
    }
    if (zoomSlider) {
      zoomSlider.addEventListener('input', () => updateZoom(Number(zoomSlider.value)));
    }

    this.editable.addEventListener('input', () => this.onChange());
    // Track the last selection so toolbar controls that steal focus can restore it.
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (sel && sel.rangeCount && this.editable.contains(sel.anchorNode)) {
        this.savedRange = sel.getRangeAt(0).cloneRange();
      }
    });
  }

  private savedRange: Range | null = null;
  private saveSelection(): void {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && this.editable.contains(sel.anchorNode)) {
      this.savedRange = sel.getRangeAt(0).cloneRange();
    }
  }
  private restoreSelection(): void {
    if (!this.savedRange) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(this.savedRange);
  }

  // Insert actions: link, image, table, horizontal rule, signature, find/replace.
  private async insertAction(kind: string): Promise<void> {
    this.editable.focus();
    this.restoreSelection();
    if (kind === 'hr') {
      document.execCommand('insertHorizontalRule', false);
    } else if (kind === 'find') {
      this.openFindReplace();
      return;
    } else if (kind === 'link') {
      const url = prompt('Link URL (https://…)');
      if (url) document.execCommand('createLink', false, url);
    } else if (kind === 'image') {
      this.pickImage();
      return; // onChange fires after the file loads
    } else if (kind === 'table') {
      const spec = prompt('Table size as rows x columns (e.g. 3x3)', '3x3');
      if (!spec) return;
      const m = /(\d+)\s*[x×]\s*(\d+)/i.exec(spec);
      const rows = Math.min(50, Math.max(1, Number(m?.[1]) || 2));
      const cols = Math.min(20, Math.max(1, Number(m?.[2]) || 2));
      let html = '<table class="docx-table"><tbody>';
      for (let r = 0; r < rows; r++) {
        html += '<tr>';
        for (let c = 0; c < cols; c++) html += '<td><br></td>';
        html += '</tr>';
      }
      html += '</tbody></table><p><br></p>';
      document.execCommand('insertHTML', false, html);
    } else if (kind === 'sign') {
      await this.openSignaturePad();
      return;
    } else if (kind === 'pagesetup') {
      this.openPageSetup();
      return;
    }
    this.onChange();
  }

  private pickImage(): void {
    const input = this.host.querySelector('[data-role="img-input"]') as HTMLInputElement;
    input.value = '';
    const onPick = () => {
      const file = input.files?.[0];
      input.removeEventListener('change', onPick);
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        this.editable.focus();
        this.restoreSelection();
        document.execCommand('insertHTML', false, `<img src="${reader.result as string}" style="max-width:100%">`);
        this.onChange();
      };
      reader.readAsDataURL(file);
    };
    input.addEventListener('change', onPick);
    input.click();
  }

  // Page setup dialog.
  private openPageSetup(): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>Page Setup</h3>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div>
            <label>Paper Size:</label>
            <select class="ps-size" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 100%;">
              <option value="letter">Letter (8.5" × 11")</option>
              <option value="a4" selected>A4 (210 × 297mm)</option>
              <option value="legal">Legal (8.5" × 14")</option>
              <option value="tabloid">Tabloid (11" × 17")</option>
            </select>
          </div>
          <div>
            <label>Orientation:</label>
            <select class="ps-orient" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 100%;">
              <option value="portrait" selected>Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            <div>
              <label>Top Margin (in):</label>
              <input type="number" class="ps-mt" value="1" min="0" max="3" step="0.1" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 100%;">
            </div>
            <div>
              <label>Bottom Margin (in):</label>
              <input type="number" class="ps-mb" value="1" min="0" max="3" step="0.1" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 100%;">
            </div>
            <div>
              <label>Left Margin (in):</label>
              <input type="number" class="ps-ml" value="1" min="0" max="3" step="0.1" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 100%;">
            </div>
            <div>
              <label>Right Margin (in):</label>
              <input type="number" class="ps-mr" value="1" min="0" max="3" step="0.1" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px; width: 100%;">
            </div>
          </div>
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn-confirm" data-act="apply">Apply</button>
            <button type="button" class="btn-cancel" data-act="cancel">Close</button>
          </div>
        </div>
      </div>`;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.getAttribute('data-act');
      if (e.target === overlay || act === 'cancel') return close();
      if (act === 'apply') {
        const page = overlay.querySelector('.docx-page') as HTMLElement;
        const mt = parseFloat((overlay.querySelector('.ps-mt') as HTMLInputElement).value) * 96;
        const mb = parseFloat((overlay.querySelector('.ps-mb') as HTMLInputElement).value) * 96;
        const ml = parseFloat((overlay.querySelector('.ps-ml') as HTMLInputElement).value) * 96;
        const mr = parseFloat((overlay.querySelector('.ps-mr') as HTMLInputElement).value) * 96;
        const orient = (overlay.querySelector('.ps-orient') as HTMLSelectElement).value;
        const pageStyle = `padding: ${mt}px ${mr}px ${mb}px ${ml}px; ${orient === 'landscape' ? 'max-width: 11in; height: 8.5in;' : 'max-width: 8.5in; min-height: 11in;'}`;
        this.editable.setAttribute('style', pageStyle);
        close();
      }
    });
    this.host.ownerDocument.body.appendChild(overlay);
  }

  // Find and replace dialog.
  private openFindReplace(): void {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>Find and Replace</h3>
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <input type="text" placeholder="Find text" class="fr-find" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px;">
          <input type="text" placeholder="Replace with" class="fr-replace" style="padding: 6px; border: 1px solid #ccc; border-radius: 4px;">
          <div style="display: flex; gap: 8px;">
            <button type="button" class="btn-confirm" data-act="replace">Replace</button>
            <button type="button" class="btn-confirm" data-act="replace-all">Replace All</button>
            <button type="button" class="btn-cancel" data-act="cancel">Close</button>
          </div>
        </div>
      </div>`;
    const findInput = overlay.querySelector('.fr-find') as HTMLInputElement;
    const replaceInput = overlay.querySelector('.fr-replace') as HTMLInputElement;
    const close = () => { overlay.remove(); this.editable.focus(); };
    const doReplace = (replaceAll: boolean) => {
      const findText = findInput.value;
      if (!findText) return;
      const replaceText = replaceInput.value;
      let count = 0;
      const regex = new RegExp(findText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const html = this.editable.innerHTML.replace(regex, () => { count++; return replaceText; });
      if (count > 0) {
        this.editable.innerHTML = html;
        this.onChange();
      }
      if (replaceAll) close();
      else findInput.focus();
    };
    overlay.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('button')?.getAttribute('data-act');
      if (e.target === overlay || act === 'cancel') return close();
      if (act === 'replace') doReplace(false);
      if (act === 'replace-all') doReplace(true);
    });
    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doReplace(e.shiftKey);
    });
    this.host.ownerDocument.body.appendChild(overlay);
    findInput.focus();
  }

  // A small canvas signature pad in a modal; inserts the drawing as an inline image.
  private openSignaturePad(): Promise<void> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML = `
        <div class="modal docx-sign-modal" role="dialog" aria-modal="true">
          <h3>Draw your signature</h3>
          <canvas class="docx-sign-canvas" width="440" height="180"></canvas>
          <div class="modal-actions">
            <button type="button" class="btn-cancel" data-act="cancel">Cancel</button>
            <button type="button" class="btn-cancel" data-act="clear">Clear</button>
            <button type="button" class="btn-confirm" data-act="insert">Insert</button>
          </div>
        </div>`;
      const canvas = overlay.querySelector('canvas') as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
      let drawing = false, dirty = false;
      const pos = (e: PointerEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
      canvas.addEventListener('pointerdown', (e) => { drawing = true; dirty = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); canvas.setPointerCapture(e.pointerId); });
      canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); });
      canvas.addEventListener('pointerup', () => { drawing = false; });
      const close = () => { overlay.remove(); resolve(); };
      overlay.addEventListener('click', (e) => {
        const act = (e.target as HTMLElement).closest('button')?.getAttribute('data-act');
        if (e.target === overlay || act === 'cancel') return close();
        if (act === 'clear') { ctx.clearRect(0, 0, canvas.width, canvas.height); dirty = false; return; }
        if (act === 'insert') {
          if (dirty) {
            const dataUrl = canvas.toDataURL('image/png');
            this.editable.focus();
            this.restoreSelection();
            document.execCommand('insertHTML', false, `<img src="${dataUrl}" alt="signature" style="max-width:260px">`);
            this.onChange();
          }
          close();
        }
      });
      this.host.ownerDocument.body.appendChild(overlay);
    });
  }
}
