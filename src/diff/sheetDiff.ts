// Cell-level diff of two spreadsheet grids. Rows are aligned either by a key
// column (e.g. an ID) or by content (LCS, so inserting a row doesn't mark every
// row below it as changed). Matched rows are then compared cell by cell.
// Pure and dependency-free so it can be unit-tested.

export type Grid = string[][];
export type RowKind = 'same' | 'changed' | 'added' | 'removed';

export interface DiffRow {
  kind: RowKind;
  a?: string[];      // row on the left (absent for added rows)
  b?: string[];      // row on the right (absent for removed rows)
  aRow?: number;     // 0-based source row numbers
  bRow?: number;
}

export interface SheetDiff {
  rows: DiffRow[];
  cols: number;                       // columns to display (max of both sides)
  counts: { same: number; changed: number; added: number; removed: number; cells: number };
}

export interface DiffOptions {
  /** Align rows by the value in this 0-based column instead of by content. */
  keyCol?: number | null;
  /** Treat "1" and "1.0", surrounding whitespace and case as equal. */
  loose?: boolean;
}

const norm = (v: string | undefined, loose: boolean): string => {
  const s = (v ?? '').toString();
  if (!loose) return s;
  const t = s.trim().toLowerCase();
  if (t !== '' && !isNaN(Number(t))) return String(Number(t));
  return t;
};

const rowSig = (r: string[], loose: boolean): string => {
  // Ignore trailing empty cells so ragged rows compare equal.
  let end = r.length;
  while (end > 0 && norm(r[end - 1], loose) === '') end--;
  return r.slice(0, end).map((c) => norm(c, loose).replace(/\n/g, '\u0002')).join('\u0001');
};

export function cellsDiffer(a: string[], b: string[], c: number, loose = false): boolean {
  return norm(a[c], loose) !== norm(b[c], loose);
}

function countCells(a: string[], b: string[], cols: number, loose: boolean): number {
  let n = 0;
  for (let c = 0; c < cols; c++) if (cellsDiffer(a, b, c, loose)) n++;
  return n;
}

// Row-level alignment by content. Returns ops over indexes into A and B.
type Op = { t: 'eq' | 'del' | 'add'; i?: number; j?: number };
function alignByContent(A: string[], B: string[]): Op[] {
  const ops: Op[] = [];
  let lo = 0;
  while (lo < A.length && lo < B.length && A[lo] === B[lo]) { ops.push({ t: 'eq', i: lo, j: lo }); lo++; }
  let ea = A.length, eb = B.length;
  const tail: Op[] = [];
  while (ea > lo && eb > lo && A[ea - 1] === B[eb - 1]) { ea--; eb--; tail.push({ t: 'eq', i: ea, j: eb }); }
  const n = ea - lo, m = eb - lo;
  if (n * m > 6_000_000) {
    // Too big for LCS: fall back to positional pairing of the middle.
    for (let k = 0; k < Math.max(n, m); k++) {
      if (k < n && k < m) { ops.push({ t: 'del', i: lo + k }); ops.push({ t: 'add', j: lo + k }); }
      else if (k < n) ops.push({ t: 'del', i: lo + k });
      else ops.push({ t: 'add', j: lo + k });
    }
  } else {
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = A[lo + i] === B[lo + j] ? dp[(i + 1) * w + j + 1]! + 1 : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[lo + i] === B[lo + j]) { ops.push({ t: 'eq', i: lo + i, j: lo + j }); i++; j++; }
      else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) { ops.push({ t: 'del', i: lo + i }); i++; }
      else { ops.push({ t: 'add', j: lo + j }); j++; }
    }
    while (i < n) { ops.push({ t: 'del', i: lo + i }); i++; }
    while (j < m) { ops.push({ t: 'add', j: lo + j }); j++; }
  }
  return ops.concat(tail.reverse());
}

export function diffSheets(a: Grid, b: Grid, opts: DiffOptions = {}): SheetDiff {
  const loose = !!opts.loose;
  const cols = Math.max(0, ...a.map((r) => r.length), ...b.map((r) => r.length));
  const rows: DiffRow[] = [];
  const counts = { same: 0, changed: 0, added: 0, removed: 0, cells: 0 };

  const pair = (i: number, j: number) => {
    const n = countCells(a[i]!, b[j]!, cols, loose);
    if (n === 0) { rows.push({ kind: 'same', a: a[i], b: b[j], aRow: i, bRow: j }); counts.same++; }
    else { rows.push({ kind: 'changed', a: a[i], b: b[j], aRow: i, bRow: j }); counts.changed++; counts.cells += n; }
  };
  const removed = (i: number) => { rows.push({ kind: 'removed', a: a[i], aRow: i }); counts.removed++; };
  const added = (j: number) => { rows.push({ kind: 'added', b: b[j], bRow: j }); counts.added++; };

  const kc = opts.keyCol;
  if (kc != null && kc >= 0) {
    const pending = new Map<string, number[]>();
    b.forEach((r, j) => {
      const k = norm(r[kc], loose);
      const q = pending.get(k); if (q) q.push(j); else pending.set(k, [j]);
    });
    const used = new Set<number>();
    a.forEach((r, i) => {
      const j = pending.get(norm(r[kc], loose))?.shift();
      if (j === undefined) removed(i); else { used.add(j); pair(i, j); }
    });
    b.forEach((_, j) => { if (!used.has(j)) added(j); });
  } else {
    const ops = alignByContent(a.map((r) => rowSig(r, loose)), b.map((r) => rowSig(r, loose)));
    // A run of deletions followed by additions is a set of edited rows: pair them up.
    let k = 0;
    while (k < ops.length) {
      const op = ops[k]!;
      if (op.t === 'eq') { pair(op.i!, op.j!); k++; continue; }
      const dels: number[] = [], adds: number[] = [];
      while (k < ops.length && ops[k]!.t !== 'eq') { const o = ops[k]!; if (o.t === 'del') dels.push(o.i!); else adds.push(o.j!); k++; }
      const common = Math.min(dels.length, adds.length);
      for (let x = 0; x < common; x++) pair(dels[x]!, adds[x]!);
      for (let x = common; x < dels.length; x++) removed(dels[x]!);
      for (let x = common; x < adds.length; x++) added(adds[x]!);
    }
  }
  return { rows, cols, counts };
}

/** Diff report as CSV: status, left row, right row, then both sides' cells. */
export function diffToCsv(d: SheetDiff): string {
  const esc = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const out: string[] = [];
  for (const r of d.rows) {
    if (r.kind === 'same') continue;
    const cells: string[] = [];
    for (let c = 0; c < d.cols; c++) {
      const x = r.a?.[c] ?? '', y = r.b?.[c] ?? '';
      cells.push(r.kind === 'changed' && x !== y ? `${x} → ${y}` : (r.kind === 'removed' ? x : (r.kind === 'added' ? y : x)));
    }
    out.push([r.kind, r.aRow != null ? String(r.aRow + 1) : '', r.bRow != null ? String(r.bRow + 1) : '', ...cells].map(esc).join(','));
  }
  return ['status,left row,right row,' + Array.from({ length: d.cols }, (_, c) => colName(c)).join(','), ...out].join('\n');
}

export function colName(n: number): string {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
