// Spreadsheet compare (CSV / TSV / Excel): pick two files (or two sheets), see a
// single merged grid with changed cells showing old → new, added rows in green
// and removed rows in red. Rows align by content or by a key column; the diff
// report can be downloaded as CSV. Read-only — it never modifies either file.
import type { FileStore } from '../store/opfs';
import type { FileRecord } from '../store/types';
import { diffSheets, diffToCsv, colName, cellsDiffer, type Grid, type SheetDiff, type DiffRow } from './sheetDiff';

interface Side {
  fileId?: string;
  sheets: Map<string, Grid>;
  sheet?: string;
  fileSel: HTMLSelectElement;
  sheetSel: HTMLSelectElement;
}

const PAGE = 1500;

export class SheetCompare {
  private el: HTMLElement;
  private left: Side;
  private right: Side;
  private tableHost: HTMLElement;
  private summary: HTMLElement;
  private keySel: HTMLSelectElement;
  private looseCb: HTMLInputElement;
  private onlyCb: HTMLInputElement;
  private diff?: SheetDiff;
  private limit = PAGE;
  private diffEls: HTMLElement[] = [];
  private cur = -1;

  constructor(
    private parent: HTMLElement,
    private store: FileStore,
    private files: FileRecord[],
    private opts: { initialLeftId?: string; onClose: () => void; toast?: (m: string, k?: 'success' | 'error' | 'info') => void },
  ) {
    this.el = document.createElement('div');
    this.el.className = 'compare-split sheet-compare';
    this.el.innerHTML = `
      <div class="compare-split-head">
        <span class="compare-split-title">⇄ Compare spreadsheets</span>
        <span class="sc-summary" data-role="summary"></span>
        <span class="compare-nav">
          <button type="button" class="compare-nav-btn" data-act="prev" aria-label="Previous difference" title="Previous difference">▲</button>
          <button type="button" class="compare-nav-btn" data-act="next" aria-label="Next difference" title="Next difference">▼</button>
        </span>
        <button type="button" class="compare-split-close" data-act="export" title="Download the differences as a CSV report">⤓ Report</button>
        <button type="button" class="compare-split-close" data-act="close" aria-label="Close compare">✕ Close</button>
      </div>
      <div class="sc-controls">
        <div class="sc-side"><span class="sc-tag sc-tag-l">Left</span><select data-role="lf"></select><select data-role="ls" hidden></select></div>
        <div class="sc-side"><span class="sc-tag sc-tag-r">Right</span><select data-role="rf"></select><select data-role="rs" hidden></select></div>
        <label class="sc-opt">Match rows by
          <select data-role="key"><option value="">Content (smart)</option></select></label>
        <label class="sc-opt"><input type="checkbox" data-role="loose"> Ignore case &amp; spaces</label>
        <label class="sc-opt"><input type="checkbox" data-role="only"> Only differences</label>
      </div>
      <div class="sc-table-host" data-role="table"></div>`;
    const q = <T extends HTMLElement>(r: string): T => this.el.querySelector(`[data-role="${r}"]`) as T;
    this.left = { sheets: new Map(), fileSel: q('lf'), sheetSel: q('ls') };
    this.right = { sheets: new Map(), fileSel: q('rf'), sheetSel: q('rs') };
    this.tableHost = q('table');
    this.summary = q('summary');
    this.keySel = q('key');
    this.looseCb = q('loose');
    this.onlyCb = q('only');

    for (const side of [this.left, this.right]) {
      for (const f of this.files) side.fileSel.appendChild(new Option(f.name, f.id));
      side.fileSel.addEventListener('change', () => void this.load(side, side.fileSel.value));
      side.sheetSel.addEventListener('change', () => { side.sheet = side.sheetSel.value; this.afterSheetChange(); });
    }
    this.keySel.addEventListener('change', () => this.recompute());
    this.looseCb.addEventListener('change', () => this.recompute());
    this.onlyCb.addEventListener('change', () => { this.limit = PAGE; this.paint(); });
    this.el.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close') this.close();
      else if (act === 'prev') this.step(-1);
      else if (act === 'next') this.step(1);
      else if (act === 'export') this.exportReport();
    });
    this.parent.appendChild(this.el);

    const leftId = this.opts.initialLeftId && files.some((f) => f.id === this.opts.initialLeftId) ? this.opts.initialLeftId : files[0]?.id;
    const rightId = files.find((f) => f.id !== leftId)?.id ?? leftId;
    if (leftId) void this.load(this.left, leftId).then(() => (rightId ? this.load(this.right, rightId) : undefined));
  }

  private async load(side: Side, id: string): Promise<void> {
    side.fileId = id;
    side.fileSel.value = id;
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await (await this.store.read(id)).arrayBuffer(), { type: 'array' });
      side.sheets = new Map();
      for (const name of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name]!, { header: 1, blankrows: true, defval: '' });
        side.sheets.set(name, aoa.map((r) => (r ?? []).map((c) => (c == null ? '' : String(c)))));
      }
    } catch {
      side.sheets = new Map([['Sheet1', [[]]]]);
      this.opts.toast?.('Could not read that spreadsheet', 'error');
    }
    side.sheet = [...side.sheets.keys()][0];
    side.sheetSel.innerHTML = '';
    for (const n of side.sheets.keys()) side.sheetSel.appendChild(new Option(n, n));
    side.sheetSel.hidden = side.sheets.size < 2;
    this.afterSheetChange();
  }

  private afterSheetChange(): void {
    // Offer the left sheet's header cells as match keys.
    const g = this.grid(this.left);
    const prev = this.keySel.value;
    this.keySel.innerHTML = '<option value="">Content (smart)</option>';
    const cols = Math.max(0, ...g.map((r) => r.length));
    for (let c = 0; c < cols; c++) {
      const h = (g[0]?.[c] ?? '').trim();
      this.keySel.appendChild(new Option(`Column ${colName(c)}${h ? ` — ${h.slice(0, 24)}` : ''}`, String(c)));
    }
    if ([...this.keySel.options].some((o) => o.value === prev)) this.keySel.value = prev;
    this.recompute();
  }

  private grid(side: Side): Grid { return (side.sheet && side.sheets.get(side.sheet)) || []; }

  private recompute(): void {
    if (!this.left.fileId || !this.right.fileId) return;
    this.diff = diffSheets(this.grid(this.left), this.grid(this.right), {
      keyCol: this.keySel.value === '' ? null : Number(this.keySel.value),
      loose: this.looseCb.checked,
    });
    this.limit = PAGE;
    this.cur = -1;
    this.paint();
  }

  private paint(): void {
    const d = this.diff;
    this.tableHost.innerHTML = '';
    this.diffEls = [];
    if (!d) return;
    const c = d.counts;
    const total = c.changed + c.added + c.removed;
    const same = this.left.fileId === this.right.fileId && this.left.sheet === this.right.sheet;
    this.summary.textContent = total === 0
      ? (same ? 'Same sheet on both sides — pick a different file or sheet' : 'No differences ✓')
      : `${c.cells} changed cell${c.cells === 1 ? '' : 's'} · ${c.added} row${c.added === 1 ? '' : 's'} added · ${c.removed} removed`;
    const loose = this.looseCb.checked;
    const rows = this.onlyCb.checked ? d.rows.filter((r) => r.kind !== 'same') : d.rows;

    const table = document.createElement('table');
    table.className = 'sc-table';
    const thead = table.createTHead().insertRow();
    for (const t of ['L', 'R']) { const th = document.createElement('th'); th.className = 'sc-rn'; th.textContent = t; thead.appendChild(th); }
    for (let k = 0; k < d.cols; k++) { const th = document.createElement('th'); th.textContent = colName(k); thead.appendChild(th); }
    const body = table.createTBody();
    for (const r of rows.slice(0, this.limit)) body.appendChild(this.renderRow(r, d.cols, loose));
    this.tableHost.appendChild(table);
    if (rows.length > this.limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'compare-split-close sc-more';
      more.textContent = `Show ${Math.min(PAGE, rows.length - this.limit)} more rows (${rows.length - this.limit} hidden)`;
      more.addEventListener('click', () => { this.limit += PAGE; this.paint(); });
      this.tableHost.appendChild(more);
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'compare-identical';
      empty.textContent = 'Nothing to show';
      this.tableHost.appendChild(empty);
    }
  }

  private renderRow(r: DiffRow, cols: number, loose: boolean): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.className = `sc-row sc-${r.kind}`;
    const num = (n?: number) => { const td = document.createElement('td'); td.className = 'sc-rn'; td.textContent = n == null ? '' : String(n + 1); return td; };
    tr.append(num(r.aRow), num(r.bRow));
    let hasDiff = r.kind !== 'same';
    for (let c = 0; c < cols; c++) {
      const td = document.createElement('td');
      const x = r.a?.[c] ?? '', y = r.b?.[c] ?? '';
      if (r.kind === 'changed' && cellsDiffer(r.a!, r.b!, c, loose)) {
        td.className = 'sc-cell-chg';
        const del = document.createElement('del'); del.textContent = x;
        const ins = document.createElement('ins'); ins.textContent = y;
        td.append(...(x === '' ? [ins] : y === '' ? [del] : [del, ins]));
        td.title = `${x || '(empty)'} → ${y || '(empty)'}`;
      } else {
        td.textContent = r.kind === 'added' ? y : x;
      }
      tr.appendChild(td);
    }
    if (hasDiff) this.diffEls.push(tr);
    return tr;
  }

  private step(dir: number): void {
    if (!this.diffEls.length) return;
    this.diffEls[this.cur]?.classList.remove('sc-current');
    this.cur = (this.cur + dir + this.diffEls.length) % this.diffEls.length;
    const row = this.diffEls[this.cur]!;
    row.classList.add('sc-current');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  private exportReport(): void {
    if (!this.diff) return;
    const url = URL.createObjectURL(new Blob([diffToCsv(this.diff)], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'spreadsheet-diff.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  close(): void {
    this.el.remove();
    this.opts.onClose();
  }
}
