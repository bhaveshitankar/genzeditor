import type { OpenedShare } from './openShared';
import { renderMarkdown } from '../editors/MarkdownPreview';
import { MermaidPreview } from '../editors/MermaidPreview';

// Kinds the clean viewer renders natively. Anything else (docx/pptx/xlsx/sketch/…)
// falls back to the full app in the caller.
const NATIVE = new Set(['text', 'code', 'json', 'markdown', 'mermaid', 'image', 'pdf', 'video', 'audio']);

export function canViewNatively(s: OpenedShare): boolean {
  if (NATIVE.has(s.kind)) return true;
  return s.kind === 'spreadsheet' && /csv|tsv/.test(s.contentType + s.title) && !/spreadsheetml|excel/.test(s.contentType);
}

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
    <header class="viewer-bar">
      <a class="viewer-brand" href="https://genzeditor.com/" target="_blank" rel="noopener">GenZ Editor</a>
      <span class="viewer-title"></span>
      <span class="viewer-badge">View only</span>
      <button type="button" class="viewer-copy">Make an editable copy</button>
    </header>
    <main class="viewer-body"></main>
    <footer class="viewer-foot">
      <span>Created with <a href="https://genzeditor.com/" target="_blank" rel="noopener">genzeditor.com</a> — free editors for docs, sheets, slides, video, web pages &amp; more.</span>
      <a class="viewer-cta" href="https://genzeditor.com/" target="_blank" rel="noopener">Sign up free to explore more</a>
    </footer>`;
  (wrap.querySelector('.viewer-title') as HTMLElement).textContent = s.title;
  wrap.querySelector('.viewer-copy')!.addEventListener('click', () => { cleanup(); opts.onEdit(); });
  const body = wrap.querySelector('.viewer-body') as HTMLElement;

  const blob = s.blob ?? new Blob([s.text ?? ''], { type: s.contentType });
  const urls: string[] = [];
  const url = () => { const u = URL.createObjectURL(blob); urls.push(u); return u; };
  let mermaid: MermaidPreview | undefined;
  const textOf = async () => s.text ?? await blob.text();
  const isHtml = /\.html?$/i.test(s.title) || s.contentType === 'text/html';

  void (async () => {
    try {
      if (isHtml) {
        // Scripts never run: sandbox has no allow-scripts and the page CSP blocks them anyway.
        const f = document.createElement('iframe');
        f.className = 'viewer-frame';
        f.setAttribute('sandbox', '');
        f.srcdoc = await textOf();
        body.appendChild(f);
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
    urls.forEach((u) => URL.revokeObjectURL(u));
    wrap.remove();
  }
  document.title = `${s.title} — GenZ Editor`;
  root.appendChild(wrap);
  return cleanup;
}
