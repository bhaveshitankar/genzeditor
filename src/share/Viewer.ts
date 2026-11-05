import type { OpenedShare } from './openShared';
import { renderMarkdown } from '../editors/MarkdownPreview';
import { SiteFrame } from '../editors/siteFrame';
import DOMPurify from 'dompurify';
import { MermaidPreview } from '../editors/MermaidPreview';

// Kinds the clean viewer renders natively. Anything else (docx/pptx/xlsx/sketch/…)
// falls back to the full app in the caller.
const NATIVE = new Set(['text', 'code', 'json', 'markdown', 'mermaid', 'image', 'pdf', 'video', 'audio', 'spreadsheet', 'document', 'presentation']);

export function canViewNatively(s: OpenedShare): boolean {
  return NATIVE.has(s.kind);
}

const isBinarySheet = (s: OpenedShare) => /\.(xlsx|xls)$/i.test(s.title) || /spreadsheetml|ms-excel/.test(s.contentType);

function parseCsv(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// Full-screen, chrome-free, read-only page for a shared link. Nothing is imported
// into the viewer's local library unless they press "Make an editable copy".
export function showViewer(root: HTMLElement, s: OpenedShare, opts: { onEdit: () => void }): () => void {
  const wrap = document.createElement('div');
  wrap.className = 'viewer-page';
  wrap.innerHTML = `
    <main class="viewer-body"></main>
    <footer class="viewer-foot">
      <span class="viewer-credit">
        <span class="viewer-badge">View only</span>
        <span class="viewer-title"></span>
        <span class="viewer-by">· Created with <a href="https://genzeditor.com/" target="_blank" rel="noopener">genzeditor.com</a></span>
      </span>
      <span class="viewer-actions">
        <button type="button" class="viewer-copy">Make an editable copy</button>
        <a class="viewer-cta" href="https://genzeditor.com/" target="_blank" rel="noopener">Sign up free to explore more</a>
      </span>
    </footer>`;
  (wrap.querySelector('.viewer-title') as HTMLElement).textContent = s.title;
  wrap.querySelector('.viewer-copy')!.addEventListener('click', () => { cleanup(); opts.onEdit(); });
  const body = wrap.querySelector('.viewer-body') as HTMLElement;

  const blob = s.blob ?? new Blob([s.text ?? ''], { type: s.contentType });
  const urls: string[] = [];
  const url = () => { const u = URL.createObjectURL(blob); urls.push(u); return u; };
  let mermaid: MermaidPreview | undefined;
  let site: SiteFrame | undefined;
  const textOf = async () => s.text ?? await blob.text();
  const isHtml = /\.html?$/i.test(s.title) || s.contentType === 'text/html';
  // Frame-based views (pages, PDFs, diagrams) scroll inside their frame, so on phones the
  // footer floats over them (dismissible); everything else scrolls with the footer at the end.
  wrap.classList.add(isHtml || s.kind === 'pdf' || s.kind === 'mermaid' ? 'viewer-overlay' : 'viewer-flow');
  const x = document.createElement('button');
  x.type = 'button'; x.className = 'viewer-x'; x.setAttribute('aria-label', 'Hide'); x.textContent = '✕';
  x.addEventListener('click', () => wrap.querySelector('.viewer-foot')?.remove());
  wrap.querySelector('.viewer-foot')!.appendChild(x);

  void (async () => {
    try {
      if (isHtml) {
        // Runs in the isolated site frame (opaque origin; no access to the app).
        const sf = new SiteFrame(body, s.title);
        sf.el.className = 'viewer-frame';
        sf.show(await textOf());
        site = sf;
      } else if (s.kind === 'markdown') {
        const d = document.createElement('article');
        d.className = 'viewer-prose';
        d.innerHTML = renderMarkdown(await textOf());
        d.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
        body.appendChild(d);
      } else if (s.kind === 'mermaid') {
        const d = document.createElement('div');
        d.className = 'viewer-mermaid';
        body.appendChild(d);
        mermaid = new MermaidPreview(d);
        mermaid.render(await textOf());
      } else if (s.kind === 'image') {
        const i = document.createElement('img');
        i.className = 'viewer-media'; i.src = url(); i.alt = s.title;
        body.appendChild(i);
      } else if (s.kind === 'pdf') {
        const f = document.createElement('iframe');
        f.className = 'viewer-frame'; f.src = url(); f.title = s.title;
        body.appendChild(f);
      } else if (s.kind === 'video' || s.kind === 'audio') {
        const m = document.createElement(s.kind);
        m.className = 'viewer-media'; m.controls = true; m.src = url();
        body.appendChild(m);
      } else if (s.kind === 'document') {
        const mammoth = await import('mammoth/mammoth.browser.js');
        const conv = (mammoth.default ?? mammoth) as { convertToHtml: (i: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
        const d = document.createElement('article');
        d.className = 'viewer-prose viewer-doc';
        d.innerHTML = DOMPurify.sanitize((await conv.convertToHtml({ arrayBuffer: await blob.arrayBuffer() })).value);
        body.appendChild(d);
      } else if (s.kind === 'presentation') {
        const [{ readPptx }, { renderSlideCanvas }] = await Promise.all([
          import('../editors/presentation/pptxRead'), import('../editors/presentation/canvas'),
        ]);
        const deck = readPptx(new Uint8Array(await blob.arrayBuffer()));
        const col = document.createElement('div');
        col.className = 'viewer-slides';
        body.appendChild(col);
        const cache = new Map<string, ImageBitmap | null>();
        for (const slide of deck.slides) {
          const cv = await renderSlideCanvas(deck, slide, Math.min(2, 1400 / deck.w), cache);
          cv.className = 'viewer-slide';
          col.appendChild(cv);
        }
      } else if (s.kind === 'spreadsheet' && isBinarySheet(s)) {
        const XLSX = await import('xlsx');
        const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
        const wrapT = document.createElement('div');
        wrapT.className = 'viewer-table-wrap';
        for (const name of wb.SheetNames) {
          const h = document.createElement('h4'); h.textContent = name; h.className = 'viewer-sheet-name';
          const box = document.createElement('div');
          box.innerHTML = DOMPurify.sanitize(XLSX.utils.sheet_to_html(wb.Sheets[name]!, { header: '', footer: '' }));
          box.querySelector('table')?.classList.add('viewer-table');
          wrapT.append(h, box);
        }
        body.appendChild(wrapT);
      } else if (s.kind === 'spreadsheet') {
        const text = await textOf();
        const rows = parseCsv(text, /tsv/i.test(s.title) ? '\t' : ',');
        const wrapT = document.createElement('div');
        wrapT.className = 'viewer-table-wrap';
        const t = document.createElement('table');
        t.className = 'viewer-table';
        rows.slice(0, 5000).forEach((r, ri) => {
          const tr = document.createElement('tr');
          for (const c of r) { const td = document.createElement(ri === 0 ? 'th' : 'td'); td.textContent = c; tr.appendChild(td); }
          t.appendChild(tr);
        });
        wrapT.appendChild(t); body.appendChild(wrapT);
      } else {
        let txt = await textOf();
        if (s.kind === 'json') { try { txt = JSON.stringify(JSON.parse(txt), null, 2); } catch { /* show raw */ } }
        const pre = document.createElement('pre');
        pre.className = 'viewer-text';
        pre.textContent = txt;
        body.appendChild(pre);
      }
    } catch (err) {
      body.textContent = 'Could not display this file.';
      console.error(err);
    }
  })();

  function cleanup() {
    mermaid?.destroy();
    site?.destroy();
    urls.forEach((u) => URL.revokeObjectURL(u));
    wrap.remove();
  }
  document.title = `${s.title} — GenZ Editor`;
  root.appendChild(wrap);
  return cleanup;
}
