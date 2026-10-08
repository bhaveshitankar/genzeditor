// Spreadsheet compare + merge (CSV / TSV / Excel).
//
// Built around how people actually review sheet changes:
//  - WATCH COLUMNS: a chip per column with its change count (heat-shaded). Turn
//    columns on/off, or "Changed only". Unwatched columns vanish, and rows that
//    only changed there drop out of the diff and out of bulk merge actions.
//  - TWO VIEWS: a merged Grid (old → new in the cell) and a Review feed that lists
//    each change as a card — grouped by column or by row — with the numeric delta.
//  - MERGE: nothing changes until you accept it. Accept a cell, a row, a whole
//    column or everything, then save the result as a new file or over the left one.
import type { FileStore } from '../store/opfs';
import type { FileRecord } from '../store/types';
import { diffSheets, diffToCsv, colName, cellsDiffer, type Grid, type SheetDiff, type DiffRow } from './sheetDiff';

interface Side {
  fileId?: string;
  sheets: Map<string, Grid>;
  order: string[];
  sheet?: string;
  fileSel: HTMLSelectElement;
  sheetSel: HTMLSelectElement;
}

const PAGE = 1200;
const NUM = /^[\s$€£₹]*-?[\d,]*\.?\d+(e[+-]?\d+)?\s*%?\s*$/i;
const num = (s: string): number | null => (NUM.test(s) ? Number(s.replace(/[^\d.eE+-]/g, '')) : null);

/** "+0.15 (+18.8%)" for two numeric strings, else ''. */
export function deltaText(x: string, y: string): string {
  const a = num(x), b = num(y);
  if (a == null || b == null || a === b) return '';
  const d = b - a;
  const f = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toString() : String(Math.round(n * 1000) / 1000));
  const pct = a !== 0 ? ` (${d > 0 ? '+' : ''}${Math.round((d / Math.abs(a)) * 1000) / 10}%)` : '';
  return `${d > 0 ? '+' : ''}${f(d)}${pct}`;
}

export class SheetCompare {
  private el: HTMLElement;
  private left: Side;
  private right: Side;
  private body: HTMLElement;
  private summary: HTMLElement;
  private chipsEl: HTMLElement;
  private mergeEl: HTMLElement;
  private keySel: HTMLSelectElement;
  private looseCb: HTMLInputElement;
  private onlyCb: HTMLInputElement;
  private diff?: SheetDiff;
  private watched = new Set<number>();
  private accepted = new Set<string>();       // `${row}:${col}` cells, `r${row}` for added/removed rows
  private view: 'grid' | 'review' = 'grid';
  private group: 'column' | 'row' = 'column';
  private limit = PAGE;
  private diffEls: HTMLElement[] = [];
  private cur = -1;

  constructor(
    private parent: HTMLElement,
    private store: FileStore,
    private files: FileRecord[],
    private opts: {
      initialLeftId?: string;
      onClose: () => void;
      onMerged?: (id: string) => void;
      toast?: (m: string, k?: 'success' | 'error' | 'info') => void;
    },
  ) {
    this.el = document.createElement('div');
    this.el.className = 'compare-split sheet-compare';
    this.el.innerHTML = `
      <div class="compare-split-head">
        <span class="compare-split-title">⇄ Compare sheets</span>
        <span class="sc-summary" data-role="summary"></span>
        <span class="sc-seg" role="group" aria-label="View">
          <button type="button" data-view="grid" aria-pressed="true">Grid</button>
          <button type="button" data-view="review" aria-pressed="false">Review</button>
        </span>
        <span class="compare-nav">
          <button type="button" class="compare-nav-btn" data-act="prev" aria-label="Previous change" title="Previous change">▲</button>
          <button type="button" class="compare-nav-btn" data-act="next" aria-label="Next change" title="Next change">▼</button>
        </span>
        <button type="button" class="compare-split-close" data-act="export" title="Download the differences as a CSV report">⤓ Report</button>
        <button type="button" class="compare-split-close" data-act="close" aria-label="Close compare">✕ Close</button>
      </div>
      <div class="sc-controls">
        <div class="sc-side"><span class="sc-tag sc-tag-l">Left</span><select data-role="lf"></select><select data-role="ls" hidden></select></div>
        <div class="sc-side"><span class="sc-tag sc-tag-r">Right</span><select data-role="rf"></select><select data-role="rs" hidden></select></div>
        <label class="sc-opt">Match rows by <select data-role="key"><option value="">Content (smart)</option></select></label>
        <label class="sc-opt"><input type="checkbox" data-role="loose"> Ignore case &amp; spaces</label>
        <label class="sc-opt"><input type="checkbox" data-role="only" checked> Only changed rows</label>
      </div>
      <div class="sc-cols">
        <span class="sc-cols-label">Watch columns</span>
        <span class="sc-chips" data-role="chips"></span>
        <span class="sc-cols-actions">
          <button type="button" data-act="cols-changed">Changed only</button>
          <button type="button" data-act="cols-all">All</button>
        </span>
      </div>
      <div class="sc-merge" data-role="merge"></div>
      <div class="sc-table-host" data-role="body"></div>`;
    const q = <T extends HTMLElement>(r: string): T => this.el.querySelector(`[data-role="${r}"]`) as T;
    this.left = { sheets: new Map(), order: [], fileSel: q('lf'), sheetSel: q('ls') };
    this.right = { sheets: new Map(), order: [], fileSel: q('rf'), sheetSel: q('rs') };
    this.body = q('body');
    this.summary = q('summary');
    this.chipsEl = q('chips');
    this.mergeEl = q('merge');
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
      const t = e.target as HTMLElement;
      const view = t.closest<HTMLElement>('[data-view]')?.dataset.view as 'grid' | 'review' | undefined;
      if (view) { this.setView(view); return; }
      const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'close') this.close();
      else if (act === 'prev') this.step(-1);
      else if (act === 'next') this.step(1);
      else if (act === 'export') this.exportReport();
      else if (act === 'cols-all') { this.setWatched(null); }
      else if (act === 'cols-changed') { this.setWatched('changed'); }
    });
    this.parent.appendChild(this.el);

    const leftId = this.opts.initialLeftId && files.some((f) => f.id === this.opts.initialLeftId) ? this.opts.initialLeftId : files[0]?.id;
    const rightId = files.find((f) => f.id !== leftId)?.id ?? leftId;
    if (leftId) void this.load(this.left, leftId).then(() => (rightId ? this.load(this.right, rightId) : undefined));
  }

  // ---- Loading ----------------------------------------------------------------

  private async load(side: Side, id: string): Promise<void> {
    side.fileId = id;
    side.fileSel.value = id;
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(await (await this.store.read(id)).arrayBuffer(), { type: 'array' });
      side.sheets = new Map();
      side.order = wb.SheetNames.slice();
      for (const name of wb.SheetNames) {
        const aoa = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[name]!, { header: 1, blankrows: true, defval: '' });
        side.sheets.set(name, aoa.map((r) => (r ?? []).map((c) => (c == null ? '' : String(c)))));
      }
    } catch {
      side.sheets = new Map([['Sheet1', [[]]]]);
      side.order = ['Sheet1'];
      this.opts.toast?.('Could not read that spreadsheet', 'error');
    }
    side.sheet = side.order[0];
    side.sheetSel.innerHTML = '';
    for (const n of side.order) side.sheetSel.appendChild(new Option(n, n));
    side.sheetSel.hidden = side.order.length < 2;
    this.afterSheetChange();
  }

  private afterSheetChange(): void {
    const g = this.grid(this.left);
    const prev = this.keySel.value;
    this.keySel.innerHTML = '<option value="">Content (smart)</option>';
    const cols = Math.max(0, ...g.map((r) => r.length));
    for (let c = 0; c < cols; c++) {
      const h = (g[0]?.[c] ?? '').trim();
      this.keySel.appendChild(new Option(`Column ${colName(c)}${h ? ` — ${h.slice(0, 24)}` : ''}`, String(c)));
    }
    if ([...this.keySel.options].some((o) => o.value === prev)) this.keySel.value = prev;
    this.watched = new Set(); // reset to "all" for the new data
    this.recompute(true);
  }

  private grid(side: Side): Grid { return (side.sheet && side.sheets.get(side.sheet)) || []; }

  private recompute(resetWatch = false): void {
    if (!this.left.fileId || !this.right.fileId) return;
    this.diff = diffSheets(this.grid(this.left), this.grid(this.right), {
      keyCol: this.keySel.value === '' ? null : Number(this.keySel.value),
      loose: this.looseCb.checked,
    });
    if (resetWatch || this.watched.size === 0) this.watched = new Set(Array.from({ length: this.diff.cols }, (_, c) => c));
    this.accepted.clear();
    this.limit = PAGE;
    this.cur = -1;
    this.paint();
  }

  // ---- Model helpers ----------------------------------------------------------

  private loose(): boolean { return this.looseCb.checked; }
  private cellKey(ri: number, c: number): string { return `${ri}:${c}`; }

  /** Watched columns that actually differ in a changed row. */
  private changedCols(r: DiffRow): number[] {
    if (r.kind !== 'changed' || !this.diff) return [];
    const out: number[] = [];
    for (let c = 0; c < this.diff.cols; c++) if (this.watched.has(c) && cellsDiffer(r.a!, r.b!, c, this.loose())) out.push(c);
    return out;
  }

  /** A row is relevant if it was added/removed, or changed in a watched column. */
  private relevant(r: DiffRow): boolean {
    return r.kind === 'added' || r.kind === 'removed' || (r.kind === 'changed' && this.changedCols(r).length > 0);
  }

  private colChangeCounts(): number[] {
    const counts = new Array<number>(this.diff?.cols ?? 0).fill(0);
    for (const r of this.diff?.rows ?? []) {
      if (r.kind !== 'changed') continue;
      for (let c = 0; c < counts.length; c++) if (cellsDiffer(r.a!, r.b!, c, this.loose())) counts[c]!++;
    }
    return counts;
  }

  private rowLabel(r: DiffRow): string {
    const key = this.keySel.value !== '' ? Number(this.keySel.value) : 0;
    const v = (r.b?.[key] ?? r.a?.[key] ?? '').trim();
    const n = (r.bRow ?? r.aRow ?? 0) + 1;
    return v ? `${v.slice(0, 28)} · row ${n}` : `row ${n}`;
  }

  private header(c: number): string {
    const h = (this.grid(this.left)[0]?.[c] ?? this.grid(this.right)[0]?.[c] ?? '').trim();
    return h ? `${h.slice(0, 22)} (${colName(c)})` : colName(c);
  }

  // ---- Watch columns ------------------------------------------------------------

  private setWatched(mode: 'changed' | null): void {
    if (!this.diff) return;
    const counts = this.colChangeCounts();
    const key = this.keySel.value !== '' ? Number(this.keySel.value) : -1;
    this.watched = new Set(Array.from({ length: this.diff.cols }, (_, c) => c).filter((c) => mode === null || counts[c]! > 0 || c === key));
    this.limit = PAGE;
    this.paint();
  }

  private paintChips(): void {
    this.chipsEl.innerHTML = '';
    const d = this.diff;
    if (!d) return;
    const counts = this.colChangeCounts();
    const max = Math.max(1, ...counts);
    for (let c = 0; c < d.cols; c++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sc-chip' + (this.watched.has(c) ? ' on' : '');
      b.setAttribute('aria-pressed', String(this.watched.has(c)));
      b.title = `${this.header(c)} — ${counts[c]} changed cell${counts[c] === 1 ? '' : 's'}. Click to ${this.watched.has(c) ? 'ignore' : 'watch'} this column.`;
      b.style.setProperty('--heat', String(counts[c]! / max));
      const name = document.createElement('span');
      name.textContent = this.header(c);
      b.appendChild(name);
      if (counts[c]) { const n = document.createElement('b'); n.textContent = String(counts[c]); b.appendChild(n); }
      b.addEventListener('click', () => {
        if (this.watched.has(c)) this.watched.delete(c); else this.watched.add(c);
        this.limit = PAGE;
        this.paint();
      });
      this.chipsEl.appendChild(b);
    }
  }

  // ---- Merge ----------------------------------------------------------------------

  /** Every decision the user can make right now (watched cells + row add/remove). */
  private allChanges(): string[] {
    const keys: string[] = [];
    this.diff?.rows.forEach((r, ri) => {
      if (r.kind === 'added' || r.kind === 'removed') keys.push(`r${ri}`);
      else for (const c of this.changedCols(r)) keys.push(this.cellKey(ri, c));
    });
    return keys;
  }

  private acceptKeys(keys: string[], on: boolean): void {
    for (const k of keys) { if (on) this.accepted.add(k); else this.accepted.delete(k); }
    this.paint();
  }

  private rowKeys(ri: number, r: DiffRow): string[] {
    return r.kind === 'changed' ? this.changedCols(r).map((c) => this.cellKey(ri, c)) : [`r${ri}`];
  }

  private paintMerge(): void {
    const all = this.allChanges();
    const done = all.filter((k) => this.accepted.has(k)).length;
    this.mergeEl.innerHTML = '';
    const mk = (label: string, act: () => void, cls = '', title = ''): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = label; b.className = cls; if (title) b.title = title;
      b.addEventListener('click', act);
      return b;
    };
    const status = document.createElement('span');
    status.className = 'sc-merge-status';
    status.textContent = all.length === 0 ? 'Nothing to merge' : `Merge: ${done} of ${all.length} change${all.length === 1 ? '' : 's'} accepted from the right`;
    const bar = document.createElement('span');
    bar.className = 'sc-merge-bar';
    const fill = document.createElement('i');
    fill.style.width = all.length ? `${(done / all.length) * 100}%` : '0%';
    bar.appendChild(fill);
    this.mergeEl.append(
      status, bar,
      mk('Accept all', () => this.acceptKeys(all, true), '', 'Take the right-hand value for every watched change'),
      mk('Reject all', () => this.acceptKeys(all, false), '', 'Keep the left-hand value everywhere'),
      mk('Save as new file', () => void this.saveMerged(false), 'primary', 'Left + accepted changes → a new file'),
      mk('Overwrite left', () => void this.saveMerged(true), 'danger', 'Apply accepted changes to the left file'),
    );
  }

  private buildMerged(): Grid {
    const out: Grid = [];
    this.diff?.rows.forEach((r, ri) => {
      if (r.kind === 'same') out.push([...r.a!]);
      else if (r.kind === 'changed') {
        const row: string[] = [];
        const w = Math.max(r.a!.length, r.b!.length);
        for (let c = 0; c < w; c++) row.push(this.accepted.has(this.cellKey(ri, c)) ? (r.b![c] ?? '') : (r.a![c] ?? ''));
        out.push(row);
      } else if (r.kind === 'removed') { if (!this.accepted.has(`r${ri}`)) out.push([...r.a!]); }
      else if (this.accepted.has(`r${ri}`)) out.push([...r.b!]);
    });
    return out;
  }

  private async saveMerged(overwrite: boolean): Promise<void> {
    const leftId = this.left.fileId;
    const rec = this.files.find((f) => f.id === leftId);
    if (!leftId || !rec || !this.diff) return;
    const merged = this.buildMerged();
    const isCsv = /\.(csv|tsv)$/i.test(rec.name);
    const XLSX = await import('xlsx');
    let blob: Blob;
    if (isCsv) {
      const ws = XLSX.utils.aoa_to_sheet(merged);
      blob = new Blob([XLSX.utils.sheet_to_csv(ws, { FS: /\.tsv$/i.test(rec.name) ? '\t' : ',' })], { type: 'text/csv' });
    } else {
      const wb = XLSX.utils.book_new();
      for (const n of this.left.order) {
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(n === this.left.sheet ? merged : this.left.sheets.get(n) ?? []), n.slice(0, 31));
      }
      blob = new Blob([XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer],
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }
    if (overwrite) {
      if (!window.confirm(`Overwrite “${rec.name}” with the merged result? This can’t be undone.`)) return;
      await this.store.update(leftId, blob);
      this.opts.toast?.(`Updated “${rec.name}”`, 'success');
      this.close();
      this.opts.onMerged?.(leftId);
      return;
    }
    const names = new Set((await this.store.list()).map((f) => f.name));
    const m = /^(.*?)(\.[^.]+)?$/.exec(rec.name)!;
    let name = `${m[1]} (merged)${m[2] ?? ''}`;
    for (let i = 2; names.has(name); i++) name = `${m[1]} (merged ${i})${m[2] ?? ''}`;
    const saved = await this.store.save(name, blob, 'spreadsheet');
    this.opts.toast?.(`Saved “${name}”`, 'success');
    this.close();
    this.opts.onMerged?.(saved.id);
  }

  // ---- Rendering ------------------------------------------------------------------

  private setView(v: 'grid' | 'review'): void {
    this.view = v;
    this.el.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
    this.paint();
  }

  private paint(): void {
    const d = this.diff;
    this.diffEls = [];
    this.cur = -1;
    if (!d) return;
    this.paintChips();
    this.paintMerge();
    const rel = d.rows.filter((r) => this.relevant(r));
    const cells = d.rows.reduce((n, r) => n + this.changedCols(r).length, 0);
    const added = rel.filter((r) => r.kind === 'added').length;
    const removed = rel.filter((r) => r.kind === 'removed').length;
    const same = this.left.fileId === this.right.fileId && this.left.sheet === this.right.sheet;
    this.summary.textContent = rel.length === 0
      ? (same ? 'Same sheet on both sides — pick a different file or sheet' : (this.watched.size < d.cols ? 'No differences in the watched columns' : 'No differences ✓'))
      : `${cells} cell${cells === 1 ? '' : 's'} changed · ${added} row${added === 1 ? '' : 's'} added · ${removed} removed`;
    this.body.innerHTML = '';
    if (this.view === 'grid') this.paintGrid(d); else this.paintReview(d);
  }

  private empty(text: string): void {
    const e = document.createElement('div');
    e.className = 'compare-identical';
    e.textContent = text;
    this.body.appendChild(e);
  }

  private paintGrid(d: SheetDiff): void {
    const cols = Array.from({ length: d.cols }, (_, c) => c).filter((c) => this.watched.has(c));
    const rows = d.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => (this.onlyCb.checked ? this.relevant(r) : true));
    if (rows.length === 0 || cols.length === 0) { this.empty(cols.length === 0 ? 'No columns watched' : 'Nothing to show'); return; }
    const table = document.createElement('table');
    table.className = 'sc-table';
    const hr = table.createTHead().insertRow();
    for (const t of ['✓', 'L', 'R']) { const th = document.createElement('th'); th.className = 'sc-rn'; th.textContent = t; hr.appendChild(th); }
    for (const c of cols) { const th = document.createElement('th'); th.textContent = this.header(c); hr.appendChild(th); }
    const tb = table.createTBody();
    for (const { r, ri } of rows.slice(0, this.limit)) tb.appendChild(this.gridRow(r, ri, cols));
    this.body.appendChild(table);
    if (rows.length > this.limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'compare-split-close sc-more';
      more.textContent = `Show ${Math.min(PAGE, rows.length - this.limit)} more rows (${rows.length - this.limit} hidden)`;
      more.addEventListener('click', () => { this.limit += PAGE; this.paint(); });
      this.body.appendChild(more);
    }
  }

  private gridRow(r: DiffRow, ri: number, cols: number[]): HTMLTableRowElement {
    const tr = document.createElement('tr');
    tr.className = `sc-row sc-${r.kind}`;
    const keys = this.rowKeys(ri, r);
    const rowAccepted = keys.length > 0 && keys.every((k) => this.accepted.has(k));
    if (r.kind !== 'same' && keys.length) {
      if (rowAccepted) tr.classList.add('sc-acc-row');
      this.diffEls.push(tr);
    }
    const tick = document.createElement('td');
    tick.className = 'sc-rn sc-tick';
    if (r.kind !== 'same' && keys.length) {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = rowAccepted;
      cb.title = r.kind === 'added' ? 'Include this new row' : r.kind === 'removed' ? 'Remove this row' : 'Accept every change in this row';
      cb.addEventListener('change', () => this.acceptKeys(keys, cb.checked));
      tick.appendChild(cb);
    }
    const n = (v?: number) => { const td = document.createElement('td'); td.className = 'sc-rn'; td.textContent = v == null ? '' : String(v + 1); return td; };
    tr.append(tick, n(r.aRow), n(r.bRow));
    for (const c of cols) {
      const td = document.createElement('td');
      const x = r.a?.[c] ?? '', y = r.b?.[c] ?? '';
      if (r.kind === 'changed' && cellsDiffer(r.a!, r.b!, c, this.loose())) {
        const k = this.cellKey(ri, c);
        const acc = this.accepted.has(k);
        td.className = 'sc-cell-chg' + (acc ? ' sc-accepted' : '');
        const del = document.createElement('del'); del.textContent = x || '∅';
        const ins = document.createElement('ins'); ins.textContent = y || '∅';
        td.append(del, ins);
        const dl = deltaText(x, y);
        if (dl) { const s = document.createElement('small'); s.textContent = dl; td.appendChild(s); }
        td.title = acc ? 'Accepted — click to keep the left value' : 'Click to accept the right-hand value';
        td.addEventListener('click', () => this.acceptKeys([k], !acc));
      } else {
        td.textContent = r.kind === 'added' ? y : x;
      }
      tr.appendChild(td);
    }
    return tr;
  }

  private paintReview(d: SheetDiff): void {
    const seg = document.createElement('div');
    seg.className = 'sc-review-bar';
    for (const g of ['column', 'row'] as const) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = g === 'column' ? 'Group by column' : 'Group by row';
      b.setAttribute('aria-pressed', String(this.group === g));
      b.addEventListener('click', () => { this.group = g; this.paint(); });
      seg.appendChild(b);
    }
    const feed = document.createElement('div');
    feed.className = 'sc-feed';
    this.body.append(seg, feed);

    const card = (title: string, sub: string, keys: string[], bodyEl: HTMLElement, cls = ''): HTMLElement => {
      const c = document.createElement('section');
      c.className = `sc-card ${cls}`;
      const h = document.createElement('header');
      const t = document.createElement('strong'); t.textContent = title;
      const s = document.createElement('span'); s.textContent = sub;
      const all = keys.every((k) => this.accepted.has(k));
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = all ? '↺ Undo all' : '✓ Accept all';
      b.addEventListener('click', () => this.acceptKeys(keys, !all));
      h.append(t, s, b);
      c.append(h, bodyEl);
      this.diffEls.push(c);
      feed.appendChild(c);
      return c;
    };
    const item = (label: string, x: string, y: string, key: string): HTMLElement => {
      const acc = this.accepted.has(key);
      const li = document.createElement('label');
      li.className = 'sc-item' + (acc ? ' sc-accepted' : '');
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.checked = acc;
      cb.addEventListener('change', () => this.acceptKeys([key], cb.checked));
      const lab = document.createElement('span'); lab.className = 'sc-item-label'; lab.textContent = label;
      const del = document.createElement('del'); del.textContent = x || '∅';
      const arrow = document.createElement('span'); arrow.textContent = '→'; arrow.className = 'sc-arrow';
      const ins = document.createElement('ins'); ins.textContent = y || '∅';
      li.append(cb, lab, del, arrow, ins);
      const dl = deltaText(x, y);
      if (dl) { const s = document.createElement('small'); s.textContent = dl; li.appendChild(s); }
      return li;
    };

    let any = false;
    const lastBlock = (r: DiffRow) => (r.kind === 'removed' ? r.a! : r.b!).filter((v) => v !== '').slice(0, 6).join(' · ');
    // Added / removed rows first.
    for (const kind of ['added', 'removed'] as const) {
      const list = d.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => r.kind === kind);
      if (!list.length) continue;
      any = true;
      const bodyEl = document.createElement('div');
      for (const { r, ri } of list.slice(0, 400)) {
        const acc = this.accepted.has(`r${ri}`);
        const li = document.createElement('label');
        li.className = `sc-item sc-row-${kind}` + (acc ? ' sc-accepted' : '');
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = acc;
        cb.addEventListener('change', () => this.acceptKeys([`r${ri}`], cb.checked));
        const lab = document.createElement('span'); lab.className = 'sc-item-label'; lab.textContent = this.rowLabel(r);
        const txt = document.createElement('span'); txt.className = 'sc-item-text'; txt.textContent = lastBlock(r);
        li.append(cb, lab, txt);
        bodyEl.appendChild(li);
      }
      card(kind === 'added' ? `New rows (${list.length})` : `Rows only on the left (${list.length})`,
        kind === 'added' ? 'tick to add them to the result' : 'tick to remove them from the result',
        list.map(({ ri }) => `r${ri}`), bodyEl, `sc-card-${kind}`);
    }
    // Cell changes.
    if (this.group === 'column') {
      for (const c of Array.from({ length: d.cols }, (_, i) => i).filter((i) => this.watched.has(i))) {
        const hits = d.rows.map((r, ri) => ({ r, ri })).filter(({ r }) => r.kind === 'changed' && cellsDiffer(r.a!, r.b!, c, this.loose()));
        if (!hits.length) continue;
        any = true;
        const bodyEl = document.createElement('div');
        for (const { r, ri } of hits.slice(0, 400)) bodyEl.appendChild(item(this.rowLabel(r), r.a![c] ?? '', r.b![c] ?? '', this.cellKey(ri, c)));
        card(this.header(c), `${hits.length} change${hits.length === 1 ? '' : 's'}`, hits.map(({ ri }) => this.cellKey(ri, c)), bodyEl);
      }
    } else {
      d.rows.forEach((r, ri) => {
        const cs = this.changedCols(r);
        if (!cs.length) return;
        any = true;
        const bodyEl = document.createElement('div');
        for (const c of cs) bodyEl.appendChild(item(this.header(c), r.a![c] ?? '', r.b![c] ?? '', this.cellKey(ri, c)));
        card(this.rowLabel(r), `${cs.length} cell${cs.length === 1 ? '' : 's'}`, cs.map((c) => this.cellKey(ri, c)), bodyEl);
      });
    }
    if (!any) this.empty(this.watched.size < d.cols ? 'No differences in the watched columns' : 'No differences ✓');
  }

  // ---- Navigation / export ------------------------------------------------------------

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
