import * as XLSX from 'xlsx';
import './styles/spreadsheet.css';
import type { DocEditor } from './registry';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Grid = string[][];

// CSV helpers for AI import/export of the active sheet.
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
function parseCsv(text: string): Grid {
  const rows: Grid = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const t = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (quoted) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
type Scalar = number | string;
type Val = Scalar | Scalar[];

function colLabel(n: number): string {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// "AB" -> zero-based column index.
function colIndex(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// "B3" -> { r: 2, c: 1 } (zero-based). Throws on malformed refs.
function refToRC(ref: string): { r: number; c: number } {
  const m = /^([A-Za-z]+)(\d+)$/.exec(ref);
  if (!m) throw { code: 'ERR' };
  return { c: colIndex(m[1]!), r: Number(m[2]) - 1 };
}

// Tokenizer for the formula mini-language. Recognises A1 refs, function
// names, numbers and the single-char operators / punctuation.
function tokenize(expr: string): string[] {
  const re = /\s*([A-Za-z]+\d+|[A-Za-z]+|\d+\.?\d*|\.\d+|[-+*/(),:])/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(expr))) {
    if (m.index !== last) throw { code: 'ERR' }; // unexpected char
    out.push(m[1]!);
    last = re.lastIndex;
  }
  if (last !== expr.length) throw { code: 'ERR' };
  return out;
}

function isRef(t: string | undefined): boolean { return !!t && /^[A-Za-z]+\d+$/.test(t); }
function isName(t: string | undefined): boolean { return !!t && /^[A-Za-z]+$/.test(t); }
function isNumTok(t: string | undefined): boolean { return !!t && /^(\d+\.?\d*|\.\d+)$/.test(t); }

function toScalar(v: Val): Scalar { if (Array.isArray(v)) throw { code: 'ERR' }; return v; }

// Coerce a scalar to a number for arithmetic. Empty -> 0; non-numeric text -> error.
function toNum(v: Val): number {
  if (Array.isArray(v)) throw { code: 'ERR' };
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) throw { code: 'ERR' };
  return n;
}

// Collect the numeric values from function args (scalars or ranges),
// silently skipping empty/text cells — matching Excel's SUM/AVERAGE/etc.
function numericArgs(args: Val[]): number[] {
  const out: number[] = [];
  const push = (x: Scalar) => {
    if (typeof x === 'number') { out.push(x); return; }
    const s = String(x).trim();
    if (s === '') return;
    const n = Number(s);
    if (Number.isFinite(n)) out.push(n);
  };
  for (const a of args) { if (Array.isArray(a)) a.forEach(push); else push(a); }
  return out;
}

function formatVal(v: Scalar): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw { code: 'ERR' };
    return String(Math.round(v * 1e10) / 1e10);
  }
  return String(v);
}

/**
 * Editable spreadsheet grid backed by SheetJS, with a self-contained formula
 * engine, range selection, clipboard, undo/redo and basic formatting.
 *
 * MODEL: `sheets` stores the *raw* cell text (e.g. "=SUM(A1:A3)"). Display
 * values are computed on the fly by evaluating formulas against the grid. The
 * formula bar always shows the raw text for the selected cell so editing
 * round-trips within the session.
 *
 * CSV / EXPORT DECISION: exports write *computed* values, not raw formulas, so
 * the output is portable (any consumer sees numbers, not "=A1+B2"). Raw
 * formulas are kept only in the in-memory model for the active session.
 */
export class SpreadsheetEditor implements DocEditor {
  private sheets = new Map<string, Grid>();
  private bold = new Map<string, Set<string>>(); // sheet -> set of "r,c"
  private order: string[] = [];
  private active = '';
  private isCsv: boolean;
  private onChange?: () => void;

  private root!: HTMLElement;
  private grid!: HTMLElement;
  private tabsEl?: HTMLElement;
  private refEl!: HTMLElement;
  private cellInput!: HTMLInputElement;

  private sel = { r: 0, c: 0 };
  private selAnchor = { r: 0, c: 0 };
  private selFocus = { r: 0, c: 0 };
  private rows = 0;
  private cols = 0;

  // True while a cell / the formula bar is being actively edited. Used to let
  // native text editing (caret, select-text, char delete) win over grid-level
  // shortcuts.
  private editing = false;
  // True only once the user has actually started TYPING into a cell / the
  // formula bar (not merely focused it). Grid-level shortcuts (Ctrl+A/C/V,
  // Delete) are gated on this so a user who just clicks a cell can still
  // Select-All etc., while mid-edit text operations stay native.
  private activelyTyping = false;
  private editSnapshot: string | null = null;

  // Undo / redo history of serialized workbook snapshots.
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  // Drag state: range selection and Excel-style fill.
  private range: { r1: number; c1: number; r2: number; c2: number } | null = null;
  private dragMode: 'select' | 'fill' | null = null;
  private dragAnchor = { r: 0, c: 0 };
  private fillHandle!: HTMLDivElement;
  private onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private onPointerUp = () => this.handlePointerUp();
  private onKey = (e: KeyboardEvent) => this.handleWindowKey(e);

  private constructor(private host: HTMLElement, isCsv: boolean) { this.isCsv = isCsv; }

  static async open(host: HTMLElement, blob: Blob, name: string, onChange?: () => void): Promise<SpreadsheetEditor> {
    const isCsv = /\.(csv|tsv)$/i.test(name);
    const ed = new SpreadsheetEditor(host, isCsv);
    ed.onChange = onChange;
    const buf = await blob.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName]!;
      const aoa = XLSX.utils.sheet_to_json<string[]>(ws, { header: 1, blankrows: true, defval: '' });
      ed.order.push(sheetName);
      ed.sheets.set(sheetName, aoa.map((row) => (row ?? []).map((c) => (c == null ? '' : String(c)))));
      ed.bold.set(sheetName, new Set());
    }
    if (ed.order.length === 0) { ed.order.push('Sheet1'); ed.sheets.set('Sheet1', [['']]); ed.bold.set('Sheet1', new Set()); }
    ed.active = ed.order[0]!;
    ed.render();
    window.addEventListener('keydown', ed.onKey);
    return ed;
  }

  private aoa(): Grid { return this.sheets.get(this.active)!; }

  // ---- AI editing: read/write the active sheet as CSV ----

  /** Active sheet as CSV text (for AI editing). */
  getCsv(): string {
    return this.aoa().map((row) => row.map(csvCell).join(',')).join('\n');
  }

  /** Replace the active sheet from CSV text; keeps undo history. */
  setCsv(text: string): string {
    const rows = parseCsv(text);
    if (!rows.length) return 'no changes';
    this.undoStack.push(this.serialize());
    this.redoStack = [];
    this.sheets.set(this.active, rows);
    this.sel = { r: 0, c: 0 };
    this.renderGrid();
    this.onChange?.();
    return `updated ${rows.length} row(s)`;
  }
  private boldSet(): Set<string> { return this.bold.get(this.active)!; }

  private cellValue(r: number, c: number): string { return this.aoa()[r]?.[c] ?? ''; }

  private setCellValue(r: number, c: number, v: string) {
    const a = this.aoa();
    while (a.length <= r) a.push([]);
    const row = a[r]!;
    while (row.length <= c) row.push('');
    row[c] = v;
    this.onChange?.();
  }

  // ---- Formula engine ------------------------------------------------------

  private getRaw(grid: Grid, r: number, c: number): string { return grid[r]?.[c] ?? ''; }

  // Evaluate the cell at (r,c) against `grid`, returning a scalar. `visited`
  // tracks the active dependency chain to catch circular references.
  private evalRef(grid: Grid, r: number, c: number, visited: Set<string>): Scalar {
    const k = r + ',' + c;
    if (visited.has(k)) throw { code: 'CIRC' };
    const raw = this.getRaw(grid, r, c);
    if (raw === '' || raw[0] !== '=') return raw;
    visited.add(k);
    try { return toScalar(this.evalExpr(grid, raw.slice(1), visited)); }
    finally { visited.delete(k); }
  }

  private evalRange(grid: Grid, start: string, end: string, visited: Set<string>): Scalar[] {
    const a = refToRC(start), b = refToRC(end);
    const r1 = Math.min(a.r, b.r), r2 = Math.max(a.r, b.r);
    const c1 = Math.min(a.c, b.c), c2 = Math.max(a.c, b.c);
    const out: Scalar[] = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) out.push(this.evalRef(grid, r, c, visited));
    return out;
  }

  private callFunc(name: string, args: Val[]): Scalar {
    const nums = numericArgs(args);
    switch (name.toUpperCase()) {
      case 'SUM': return nums.reduce((a, b) => a + b, 0);
      case 'AVERAGE': return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
      case 'COUNT': return nums.length;
      case 'MIN': return nums.length ? Math.min(...nums) : 0;
      case 'MAX': return nums.length ? Math.max(...nums) : 0;
      default: throw { code: 'ERR' };
    }
  }

  // Recursive-descent evaluator (no eval()). Returns a scalar or, for a bare
  // range, an array of scalars (only meaningful as a function argument).
  private evalExpr(grid: Grid, expr: string, visited: Set<string>): Val {
    const tokens = tokenize(expr);
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const expect = (t: string) => { if (tokens[pos] !== t) throw { code: 'ERR' }; pos++; };

    const parseFactor = (): Val => {
      const t = peek();
      if (t === undefined) throw { code: 'ERR' };
      if (t === '-') { next(); return -toNum(parseFactor()); }
      if (t === '+') { next(); return toNum(parseFactor()); }
      if (t === '(') { next(); const v = parseExpr(); expect(')'); return v; }
      if (isNumTok(t)) { next(); return Number(t); }
      if (isName(t) && tokens[pos + 1] === '(') {
        const fn = next(); next(); // consume name and '('
        const args: Val[] = [];
        if (peek() !== ')') { args.push(parseExpr()); while (peek() === ',') { next(); args.push(parseExpr()); } }
        expect(')');
        return this.callFunc(fn, args);
      }
      if (isRef(t)) {
        const start = next()!;
        if (peek() === ':') { next(); const end = next(); if (!isRef(end)) throw { code: 'ERR' }; return this.evalRange(grid, start, end!, visited); }
        const { r, c } = refToRC(start);
        return this.evalRef(grid, r, c, visited);
      }
      throw { code: 'ERR' };
    };
    const parseTerm = (): Val => {
      let v: Val = parseFactor();
      while (peek() === '*' || peek() === '/') {
        const op = next(); const r = toNum(parseFactor());
        v = op === '*' ? toNum(v) * r : toNum(v) / r;
      }
      return v;
    };
    const parseExpr = (): Val => {
      let v: Val = parseTerm();
      while (peek() === '+' || peek() === '-') {
        const op = next(); const r = toNum(parseTerm());
        v = op === '+' ? toNum(v) + r : toNum(v) - r;
      }
      return v;
    };

    const result = parseExpr();
    if (pos !== tokens.length) throw { code: 'ERR' };
    return result;
  }

  // Computed display string for a cell: raw text unless it's a formula.
  private displayValue(grid: Grid, r: number, c: number): string {
    const raw = this.getRaw(grid, r, c);
    if (raw === '' || raw[0] !== '=') return raw;
    try { return formatVal(toScalar(this.evalExpr(grid, raw.slice(1), new Set([r + ',' + c])))); }
    catch (e: any) { return e && e.code === 'CIRC' ? '#CIRC' : '#ERR!'; }
  }

  private isFormulaError(v: string): boolean { return v === '#ERR!' || v === '#CIRC'; }

  // Repaint every non-editing cell with its computed value (cheap recalc).
  private refreshDisplays() {
    const grid = this.aoa();
    const active = document.activeElement;
    for (const td of Array.from(this.grid.querySelectorAll<HTMLElement>('td[data-r]'))) {
      const r = Number(td.dataset.r), c = Number(td.dataset.c);
      // Only the cell literally being edited keeps its raw text; every other
      // cell (including freshly-committed ones) always shows its computed value.
      if (td === active) continue;
      const v = this.displayValue(grid, r, c);
      td.textContent = v;
      if (this.isFormulaError(v)) td.dataset.err = '1'; else delete td.dataset.err;
    }
  }

  // ---- History -------------------------------------------------------------

  private serialize(): string {
    return JSON.stringify({
      order: this.order,
      active: this.active,
      sheets: this.order.map((n) => this.sheets.get(n)),
      bold: this.order.map((n) => Array.from(this.bold.get(n) ?? [])),
    });
  }

  private deserialize(s: string) {
    const d = JSON.parse(s);
    this.order = d.order;
    this.active = d.active;
    this.sheets = new Map();
    this.bold = new Map();
    d.order.forEach((n: string, i: number) => {
      this.sheets.set(n, d.sheets[i]);
      this.bold.set(n, new Set(d.bold[i]));
    });
  }

  // Snapshot current state, run a mutating action, mark it dirty.
  private withHistory(fn: () => void) {
    const snap = this.serialize();
    fn();
    if (this.serialize() !== snap) { this.undoStack.push(snap); this.redoStack = []; this.onChange?.(); }
  }

  private beginEdit() { if (this.editSnapshot === null) this.editSnapshot = this.serialize(); }
  private endEdit() {
    if (this.editSnapshot === null) return;
    const now = this.serialize();
    if (now !== this.editSnapshot) { this.undoStack.push(this.editSnapshot); this.redoStack = []; }
    this.editSnapshot = null;
  }

  private undo() {
    this.endEdit();
    if (!this.undoStack.length) return;
    this.redoStack.push(this.serialize());
    this.deserialize(this.undoStack.pop()!);
    this.afterHistoryRestore();
  }
  private redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.serialize());
    this.deserialize(this.redoStack.pop()!);
    this.afterHistoryRestore();
  }
  private afterHistoryRestore() {
    if (!this.order.includes(this.active)) this.active = this.order[0]!;
    this.sel = { r: 0, c: 0 };
    this.range = { r1: 0, c1: 0, r2: 0, c2: 0 };
    this.selAnchor = { r: 0, c: 0 };
    this.selFocus = { r: 0, c: 0 };
    this.renderGrid();
    this.syncTabs();
    this.syncBar();
    this.onChange?.();
  }

  private render() {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-wrap';
    this.root = wrap;

    // --- Cell / formula bar (full width; primary editing surface on mobile) ---
    const bar = document.createElement('div');
    bar.className = 'sheet-cellbar';
    const ref = document.createElement('span');
    ref.className = 'sheet-ref';
    this.refEl = ref;
    const input = document.createElement('input');
    input.className = 'sheet-cell-input';
    input.type = 'text';
    input.setAttribute('aria-label', 'Edit selected cell');
    input.placeholder = 'Select a cell to edit';
    this.cellInput = input;
    input.addEventListener('focus', () => { this.editing = true; this.activelyTyping = false; this.beginEdit(); });
    input.addEventListener('blur', () => { this.editing = false; this.activelyTyping = false; this.endEdit(); this.refreshDisplays(); });
    input.addEventListener('input', () => {
      this.activelyTyping = true;
      this.setCellValue(this.sel.r, this.sel.c, input.value);
      const td = this.tdAt(this.sel.r, this.sel.c);
      if (td) td.textContent = input.value; // show raw while editing via the bar
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.endEdit(); this.refreshDisplays(); this.moveTo(this.sel.r + 1, this.sel.c, true); }
    });
    bar.append(ref, input);
    wrap.appendChild(bar);

    // --- Operations toolbar (wraps on small screens) ---
    const ops = document.createElement('div');
    ops.className = 'sheet-ops';
    const opBtn = (label: string, title: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.addEventListener('click', () => fn());
      ops.appendChild(b);
    };
    opBtn('+ Row', 'Insert row below', () => this.withHistory(() => this.insertRow()));
    opBtn('+ Col', 'Insert column to the right', () => this.withHistory(() => this.insertCol()));
    opBtn('✕ Row', 'Delete current row', () => this.withHistory(() => this.deleteRow()));
    opBtn('✕ Col', 'Delete current column', () => this.withHistory(() => this.deleteCol()));
    opBtn('B', 'Bold (Cmd/Ctrl+B)', () => this.toggleBold());
    opBtn('A→Z', 'Sort rows by selected column, ascending', () => this.sortByColumn(true));
    opBtn('Z→A', 'Sort rows by selected column, descending', () => this.sortByColumn(false));
    opBtn('↶', 'Undo (Cmd/Ctrl+Z)', () => this.undo());
    opBtn('↷', 'Redo (Cmd/Ctrl+Shift+Z)', () => this.redo());
    wrap.appendChild(ops);

    // --- Sheet tabs ---
    if (this.order.length > 1) {
      const tabs = document.createElement('div');
      tabs.className = 'sheet-tabs';
      this.tabsEl = tabs;
      for (const name of this.order) {
        const b = document.createElement('button');
        b.className = 'sheet-tab' + (name === this.active ? ' active' : '');
        b.textContent = name;
        b.addEventListener('click', () => { this.active = name; this.sel = { r: 0, c: 0 }; this.renderGrid(); this.syncTabs(); this.syncBar(); });
        tabs.appendChild(b);
      }
      wrap.appendChild(tabs);
    }

    const grid = document.createElement('div');
    grid.className = 'sheet-grid';
    this.grid = grid;

    const fh = document.createElement('div');
    fh.className = 'sheet-fill-handle';
    fh.title = 'Drag to fill';
    fh.addEventListener('pointerdown', (e) => this.startFillDrag(e));
    this.fillHandle = fh;
    grid.appendChild(fh);

    grid.addEventListener('scroll', () => this.positionFillHandle());
    wrap.appendChild(grid);

    this.host.appendChild(wrap);
    this.renderGrid();
    this.syncBar();
  }

  private syncTabs() {
    if (!this.tabsEl) return;
    for (const b of Array.from(this.tabsEl.children)) {
      b.classList.toggle('active', b.textContent === this.active);
    }
  }

  private syncBar() {
    this.refEl.textContent = `${colLabel(this.sel.c)}${this.sel.r + 1}`;
    this.cellInput.value = this.cellValue(this.sel.r, this.sel.c);
  }

  private tdAt(r: number, c: number): HTMLElement | null {
    return this.grid.querySelector<HTMLElement>(`td[data-r="${r}"][data-c="${c}"]`);
  }

  private select(r: number, c: number) {
    const prev = this.tdAt(this.sel.r, this.sel.c);
    if (prev) prev.classList.remove('sel');
    this.sel = { r, c };
    this.selAnchor = { r, c };
    this.selFocus = { r, c };
    const td = this.tdAt(r, c);
    if (td) td.classList.add('sel');
    this.range = { r1: r, c1: c, r2: r, c2: c };
    this.paintRange();
    this.positionFillHandle();
    this.syncBar();
  }

  private norm(a: { r: number; c: number }, b: { r: number; c: number }) {
    return { r1: Math.min(a.r, b.r), c1: Math.min(a.c, b.c), r2: Math.max(a.r, b.r), c2: Math.max(a.c, b.c) };
  }

  // Highlight every cell inside the current range (the anchor keeps `.sel`)
  // plus the column/row headers that span it.
  private paintRange() {
    for (const el of Array.from(this.grid.querySelectorAll('td.in-range'))) el.classList.remove('in-range');
    this.paintHeaders();
    const rg = this.range;
    if (!rg) return;
    if (rg.r1 === rg.r2 && rg.c1 === rg.c2) return;
    for (let r = rg.r1; r <= rg.r2; r++) {
      for (let c = rg.c1; c <= rg.c2; c++) {
        this.tdAt(r, c)?.classList.add('in-range');
      }
    }
  }

  private paintHeaders() {
    for (const el of Array.from(this.grid.querySelectorAll('th.hsel'))) el.classList.remove('hsel');
    const rg = this.range;
    if (!rg) return;
    const colHeads = this.grid.querySelectorAll<HTMLElement>('thead th');
    for (let c = rg.c1; c <= rg.c2; c++) colHeads[c + 1]?.classList.add('hsel'); // +1: corner
    const rowHeads = this.grid.querySelectorAll<HTMLElement>('th.sheet-rownum');
    for (let r = rg.r1; r <= rg.r2; r++) rowHeads[r]?.classList.add('hsel');
  }

  // Park the fill handle at the bottom-right corner of the selection.
  private positionFillHandle() {
    const rg = this.range;
    if (!rg || !this.fillHandle) { if (this.fillHandle) this.fillHandle.style.display = 'none'; return; }
    const td = this.tdAt(rg.r2, rg.c2);
    if (!td) { this.fillHandle.style.display = 'none'; return; }
    const g = this.grid.getBoundingClientRect();
    const t = td.getBoundingClientRect();
    const left = t.right - g.left + this.grid.scrollLeft;
    const top = t.bottom - g.top + this.grid.scrollTop;
    this.fillHandle.style.display = 'block';
    this.fillHandle.style.left = `${left}px`;
    this.fillHandle.style.top = `${top}px`;
  }

  private tdFromPoint(x: number, y: number): { r: number; c: number } | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const td = el?.closest('td') as HTMLElement | null;
    if (!td || td.dataset.r === undefined || !this.grid.contains(td)) return null;
    return { r: Number(td.dataset.r), c: Number(td.dataset.c) };
  }

  private startSelectDrag(_e: PointerEvent, r: number, c: number) {
    // Don't preventDefault: a plain click must still place the caret / focus the
    // cell for inline editing. We only treat it as a range drag once the pointer
    // moves into a different cell (handled in handlePointerMove).
    this.dragMode = 'select';
    this.dragAnchor = { r, c };
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp, { once: true });
  }

  private startFillDrag(e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    this.dragMode = 'fill';
    // Fill source is the current range; anchor at its top-left.
    const rg = this.range ?? { r1: this.sel.r, c1: this.sel.c, r2: this.sel.r, c2: this.sel.c };
    this.range = { ...rg };
    this.dragAnchor = { r: rg.r1, c: rg.c1 };
    document.addEventListener('pointermove', this.onPointerMove);
    document.addEventListener('pointerup', this.onPointerUp, { once: true });
  }

  private handlePointerMove(e: PointerEvent) {
    const hit = this.tdFromPoint(e.clientX, e.clientY);
    if (!hit) return;
    if (this.dragMode === 'select') {
      if (hit.r === this.dragAnchor.r && hit.c === this.dragAnchor.c && !this.range) return;
      e.preventDefault();
      window.getSelection()?.removeAllRanges();
      this.range = this.norm(this.dragAnchor, hit);
      this.sel = { ...this.dragAnchor };
      this.selAnchor = { ...this.dragAnchor };
      this.selFocus = { ...hit };
      this.paintRange();
      this.positionFillHandle();
      this.syncBar();
    } else if (this.dragMode === 'fill') {
      e.preventDefault();
      // Extend the source range in the dominant drag direction only.
      const src = this.range!;
      const downDelta = hit.r - src.r2;
      const rightDelta = hit.c - src.c2;
      let preview = { ...src };
      if (Math.abs(downDelta) >= Math.abs(rightDelta) && downDelta > 0) preview.r2 = hit.r;
      else if (rightDelta > 0) preview.c2 = hit.c;
      this.fillPreview = preview;
      this.paintFillPreview();
    }
  }

  private fillPreview: { r1: number; c1: number; r2: number; c2: number } | null = null;

  private paintFillPreview() {
    for (const el of Array.from(this.grid.querySelectorAll('td.fill-target'))) el.classList.remove('fill-target');
    const p = this.fillPreview;
    if (!p) return;
    for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) this.tdAt(r, c)?.classList.add('fill-target');
  }

  private handlePointerUp() {
    document.removeEventListener('pointermove', this.onPointerMove);
    if (this.dragMode === 'fill' && this.fillPreview) this.withHistory(() => this.applyFill());
    for (const el of Array.from(this.grid.querySelectorAll('td.fill-target'))) el.classList.remove('fill-target');
    this.fillPreview = null;
    this.dragMode = null;
  }

  // Tile the source block's values across the extended fill area.
  private applyFill() {
    const src = this.range!;
    const dst = this.fillPreview!;
    const srcRows = src.r2 - src.r1 + 1;
    const srcCols = src.c2 - src.c1 + 1;
    for (let r = dst.r1; r <= dst.r2; r++) {
      for (let c = dst.c1; c <= dst.c2; c++) {
        if (r <= src.r2 && c <= src.c2) continue; // leave the source untouched
        const sr = src.r1 + ((r - src.r1) % srcRows);
        const sc = src.c1 + ((c - src.c1) % srcCols);
        this.setCellValue(r, c, this.cellValue(sr, sc));
      }
    }
    this.range = { ...dst };
    this.paintRange();
    this.positionFillHandle();
    this.refreshDisplays();
    this.onChange?.();
  }

  private moveTo(r: number, c: number, focusCell: boolean) {
    r = Math.max(0, Math.min(r, this.rows - 1));
    c = Math.max(0, Math.min(c, this.cols - 1));
    this.select(r, c);
    const td = this.tdAt(r, c);
    if (td) {
      td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (focusCell) this.placeCaret(td);
    }
  }

  private placeCaret(td: HTMLElement) {
    td.focus();
    const range = document.createRange();
    range.selectNodeContents(td);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  private insertRow() { this.aoa().splice(this.sel.r + 1, 0, []); this.renderGrid(); this.moveTo(this.sel.r + 1, this.sel.c, false); }
  private insertCol() {
    for (const row of this.aoa()) row.splice(this.sel.c + 1, 0, '');
    this.renderGrid();
    this.moveTo(this.sel.r, this.sel.c + 1, false);
  }
  private deleteRow() {
    const a = this.aoa();
    if (a.length <= 1) { a[0] = []; } else { a.splice(this.sel.r, 1); }
    this.renderGrid();
    this.moveTo(Math.min(this.sel.r, this.rows - 1), this.sel.c, false);
  }
  private deleteCol() {
    for (const row of this.aoa()) if (row.length > this.sel.c) row.splice(this.sel.c, 1);
    this.renderGrid();
    this.moveTo(this.sel.r, Math.min(this.sel.c, this.cols - 1), false);
  }

  // ---- Selection / clipboard / formatting shortcuts ------------------------

  private selectAll() {
    this.range = { r1: 0, c1: 0, r2: this.rows - 1, c2: this.cols - 1 };
    this.selAnchor = { r: 0, c: 0 };
    this.selFocus = { r: this.rows - 1, c: this.cols - 1 };
    this.paintRange();
    this.positionFillHandle();
  }

  private selectColumn(c: number) {
    this.sel = { r: 0, c };
    this.selAnchor = { r: 0, c };
    this.selFocus = { r: this.rows - 1, c };
    this.range = { r1: 0, c1: c, r2: this.rows - 1, c2: c };
    this.paintRange();
    this.positionFillHandle();
    this.syncBar();
  }
  private selectRow(r: number) {
    this.sel = { r, c: 0 };
    this.selAnchor = { r, c: 0 };
    this.selFocus = { r, c: this.cols - 1 };
    this.range = { r1: r, c1: 0, r2: r, c2: this.cols - 1 };
    this.paintRange();
    this.positionFillHandle();
    this.syncBar();
  }

  private curRange() { return this.range ?? { r1: this.sel.r, c1: this.sel.c, r2: this.sel.r, c2: this.sel.c }; }

  // Copy the selection as Excel-compatible TSV of *computed* values.
  private copy() {
    const rg = this.curRange();
    const grid = this.aoa();
    const rows: string[] = [];
    for (let r = rg.r1; r <= rg.r2; r++) {
      const cells: string[] = [];
      for (let c = rg.c1; c <= rg.c2; c++) cells.push(this.displayValue(grid, r, c));
      rows.push(cells.join('\t'));
    }
    const text = rows.join('\n');
    navigator.clipboard?.writeText(text).catch(() => {});
  }

  private async paste() {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { return; }
    if (text === '') return;
    const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (rows.length && rows[rows.length - 1] === '') rows.pop();
    const rg = this.curRange();
    this.withHistory(() => {
      rows.forEach((line, dr) => {
        line.split('\t').forEach((val, dc) => {
          this.setCellValue(rg.r1 + dr, rg.c1 + dc, val);
        });
      });
      this.renderGrid();
    });
  }

  private clearRange() {
    const rg = this.curRange();
    this.withHistory(() => {
      for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
        if ((this.aoa()[r]?.[c] ?? '') !== '') this.setCellValue(r, c, '');
      }
      this.refreshDisplays();
    });
  }

  private toggleBold() {
    const rg = this.curRange();
    const set = this.boldSet();
    // If any cell in range is not bold, make all bold; else unbold all.
    let anyPlain = false;
    for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) if (!set.has(r + ',' + c)) anyPlain = true;
    this.withHistory(() => {
      for (let r = rg.r1; r <= rg.r2; r++) for (let c = rg.c1; c <= rg.c2; c++) {
        const k = r + ',' + c;
        if (anyPlain) set.add(k); else set.delete(k);
      }
      this.applyBoldClasses();
    });
  }

  private applyBoldClasses() {
    const set = this.boldSet();
    for (const td of Array.from(this.grid.querySelectorAll<HTMLElement>('td[data-r]'))) {
      td.classList.toggle('bold', set.has(td.dataset.r + ',' + td.dataset.c));
    }
  }

  // Sort the whole grid's rows by the selected column. Numeric-aware; blanks
  // sort last. Operates on raw cell text (formulas move with their row).
  private sortByColumn(asc: boolean) {
    const c = this.sel.c;
    this.withHistory(() => {
      const a = this.aoa();
      const cmp = (x: string[], y: string[]) => {
        const xv = x[c] ?? '', yv = y[c] ?? '';
        if (xv === '' && yv === '') return 0;
        if (xv === '') return 1; // blanks last
        if (yv === '') return -1;
        const nx = Number(xv), ny = Number(yv);
        let r: number;
        if (Number.isFinite(nx) && Number.isFinite(ny)) r = nx - ny;
        else r = xv.localeCompare(yv);
        return asc ? r : -r;
      };
      // Only sort the populated rows; preserve trailing padding implicitly.
      a.sort(cmp);
      this.renderGrid();
    });
  }

  private renderGrid() {
    const aoa = this.aoa();
    const grid = aoa;
    this.rows = Math.max(aoa.length + 6, 24);
    this.cols = Math.max(aoa.reduce((m, r) => Math.max(m, r.length), 0) + 3, 10);

    const table = document.createElement('table');
    table.className = 'sheet-table';

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'sheet-corner';
    hr.appendChild(corner);
    for (let c = 0; c < this.cols; c++) {
      const th = document.createElement('th');
      th.textContent = colLabel(c);
      th.addEventListener('click', () => this.selectColumn(c));
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    table.appendChild(thead);

    const boldSet = this.boldSet();
    const tbody = document.createElement('tbody');
    for (let r = 0; r < this.rows; r++) {
      const tr = document.createElement('tr');
      const rh = document.createElement('th');
      rh.className = 'sheet-rownum';
      rh.textContent = String(r + 1);
      rh.addEventListener('click', () => this.selectRow(r));
      tr.appendChild(rh);
      for (let c = 0; c < this.cols; c++) {
        const td = document.createElement('td');
        td.contentEditable = 'true';
        td.spellcheck = false;
        td.dataset.r = String(r);
        td.dataset.c = String(c);
        const disp = this.displayValue(grid, r, c);
        td.textContent = disp;
        if (this.isFormulaError(disp)) td.dataset.err = '1';
        if (boldSet.has(r + ',' + c)) td.classList.add('bold');
        td.addEventListener('focus', () => {
          this.editing = true;
          this.activelyTyping = false;
          this.beginEdit();
          this.select(r, c);
          // Reveal the raw formula/text for editing.
          td.textContent = this.getRaw(this.aoa(), r, c);
          delete td.dataset.err;
        });
        td.addEventListener('blur', () => {
          this.editing = false;
          this.activelyTyping = false;
          this.endEdit();
          this.refreshDisplays();
        });
        td.addEventListener('input', () => {
          this.activelyTyping = true;
          this.setCellValue(r, c, td.textContent ?? '');
          if (this.sel.r === r && this.sel.c === c) this.cellInput.value = td.textContent ?? '';
        });
        td.addEventListener('keydown', (e) => this.onCellKey(e, r, c));
        td.addEventListener('pointerdown', (e) => this.startSelectDrag(e, r, c));
        if (r === this.sel.r && c === this.sel.c) td.classList.add('sel');
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    // Preserve the fill handle (a grid child) across re-renders.
    this.grid.querySelector('.sheet-table')?.remove();
    this.grid.insertBefore(table, this.fillHandle);
    this.paintRange();
    this.positionFillHandle();
  }

  private onCellKey(e: KeyboardEvent, r: number, c: number) {
    // Shift+Arrow extends the selection range from the anchor.
    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      let { r: fr, c: fc } = this.selFocus;
      if (e.key === 'ArrowUp') fr--; else if (e.key === 'ArrowDown') fr++;
      else if (e.key === 'ArrowLeft') fc--; else fc++;
      fr = Math.max(0, Math.min(fr, this.rows - 1));
      fc = Math.max(0, Math.min(fc, this.cols - 1));
      this.selFocus = { r: fr, c: fc };
      this.range = this.norm(this.selAnchor, this.selFocus);
      this.paintRange();
      this.positionFillHandle();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.endEdit(); this.refreshDisplays(); this.moveTo(r + 1, c, true); }
    else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); this.endEdit(); this.refreshDisplays(); this.moveTo(r - 1, c, true); }
    else if (e.key === 'Tab') { e.preventDefault(); this.endEdit(); this.refreshDisplays(); this.moveTo(r, e.shiftKey ? c - 1 : c + 1, true); }
  }

  private isEditorFocused(): boolean {
    const a = document.activeElement;
    return !a || a === document.body || (!!this.root && this.root.contains(a));
  }

  private handleWindowKey(e: KeyboardEvent) {
    if (!this.isEditorFocused()) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    // The formula-bar input is a real <input>; never hijack its native editing.
    const inBar = document.activeElement === this.cellInput;
    if (mod && key === 'a') {
      if (this.activelyTyping || inBar) return; // let native select-text win mid-edit
      e.preventDefault();
      this.selectAll();
    } else if (mod && key === 'z' && !e.shiftKey) {
      e.preventDefault(); this.undo();
    } else if ((mod && key === 'z' && e.shiftKey) || (e.ctrlKey && key === 'y')) {
      e.preventDefault(); this.redo();
    } else if (mod && key === 'c') {
      if (this.activelyTyping || inBar) return;
      e.preventDefault(); this.copy();
    } else if (mod && key === 'v') {
      if (this.activelyTyping || inBar) return;
      e.preventDefault(); void this.paste();
    } else if (mod && key === 'b') {
      if (inBar) return;
      e.preventDefault(); this.toggleBold();
    } else if (key === 'delete' || key === 'backspace') {
      if (this.activelyTyping || inBar) return; // let native char-delete win mid-edit
      const rg = this.curRange();
      const multi = rg.r1 !== rg.r2 || rg.c1 !== rg.c2;
      // A single focused cell with no multi-selection: leave native editing
      // alone so Backspace edits that cell normally.
      if (!multi && this.editing) return;
      e.preventDefault(); this.clearRange();
    }
  }

  async export(): Promise<{ blob: Blob; contentType: string }> {
    // Export COMPUTED values (not raw formulas) for portability — see class doc.
    if (this.isCsv) {
      const ws = XLSX.utils.aoa_to_sheet(this.trimmed(this.computed(this.aoa())));
      const csv = XLSX.utils.sheet_to_csv(ws);
      return { blob: new Blob([csv], { type: 'text/csv' }), contentType: 'text/csv' };
    }
    const wb = XLSX.utils.book_new();
    for (const name of this.order) {
      const ws = XLSX.utils.aoa_to_sheet(this.trimmed(this.computed(this.sheets.get(name)!)));
      XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
    }
    const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
    return { blob: new Blob([out], { type: XLSX_MIME }), contentType: XLSX_MIME };
  }

  // Produce a grid of computed display values (formulas resolved).
  private computed(grid: Grid): Grid {
    return grid.map((row, r) => row.map((_cell, c) => this.displayValue(grid, r, c)));
  }

  // Drop trailing all-empty rows so padding cells don't bloat the export.
  private trimmed(aoa: Grid): Grid {
    let last = aoa.length;
    while (last > 0 && (aoa[last - 1] ?? []).every((c) => (c ?? '') === '')) last--;
    return aoa.slice(0, last).map((r) => [...r]);
  }

  destroy() {
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointermove', this.onPointerMove);
    document.removeEventListener('pointerup', this.onPointerUp);
    /* remaining DOM is cleared by the host on teardown */
  }
}
