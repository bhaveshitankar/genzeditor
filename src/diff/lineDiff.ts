// Minimal line-level diff via longest-common-subsequence backtracking.
// Pure and dependency-free so it can run entirely on the client and be tested
// in isolation.

export type DiffType = 'eq' | 'add' | 'del';
export interface DiffOp { type: DiffType; text: string }

export function lineDiff(a: string, b: string): DiffOp[] {
  const A = a.split('\n');
  const B = b.split('\n');
  const n = A.length;
  const m = B.length;

  // dp[i][j] = LCS length of A[i..] and B[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { out.push({ type: 'eq', text: A[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ type: 'del', text: A[i]! }); i++; }
    else { out.push({ type: 'add', text: B[j]! }); j++; }
  }
  while (i < n) { out.push({ type: 'del', text: A[i]! }); i++; }
  while (j < m) { out.push({ type: 'add', text: B[j]! }); j++; }
  return out;
}
