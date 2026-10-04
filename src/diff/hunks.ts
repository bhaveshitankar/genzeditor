// Groups a line diff into hunks with line ranges on each side, so the compare
// view can render per-hunk "move change" (◀ / ▶) buttons like a git merge tool.
// Built on top of lineDiff so the diff algorithm stays in one place.
import { lineDiff } from './lineDiff';

export interface Hunk {
  // Half-open line ranges [start, end) into the A / B line arrays.
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  aLines: string[];
  bLines: string[];
}

/** Compute change hunks between two texts. Equal runs are skipped. */
export function diffHunks(a: string, b: string): Hunk[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const ops = lineDiff(a, b);

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  let cur: Hunk | null = null;

  const flush = () => {
    if (cur) {
      cur.aLines = A.slice(cur.aStart, cur.aEnd);
      cur.bLines = B.slice(cur.bStart, cur.bEnd);
      hunks.push(cur);
      cur = null;
    }
  };

  for (const op of ops) {
    if (op.type === 'eq') {
      flush();
      ai++;
      bi++;
    } else {
      if (!cur) cur = { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi, aLines: [], bLines: [] };
      if (op.type === 'del') { cur.aEnd = ++ai; }
      else { cur.bEnd = ++bi; }
    }
  }
  flush();
  return hunks;
}

/** Replace A's hunk range with B's lines (accept the B side, "◀" into A). */
export function applyToA(a: string, h: Hunk): string {
  const A = a.split('\n');
  A.splice(h.aStart, h.aEnd - h.aStart, ...h.bLines);
  return A.join('\n');
}

/** Replace B's hunk range with A's lines (accept the A side, "▶" into B). */
export function applyToB(b: string, h: Hunk): string {
  const B = b.split('\n');
  B.splice(h.bStart, h.bEnd - h.bStart, ...h.aLines);
  return B.join('\n');
}
