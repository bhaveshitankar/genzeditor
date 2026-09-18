export interface TreeNode { key: string; type: string; children?: TreeNode[]; value?: string }

export function formatJson(src: string): { ok: true; text: string } | { ok: false; error: string } {
  try { return { ok: true, text: JSON.stringify(JSON.parse(src), null, 2) }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

function build(key: string, val: unknown): TreeNode {
  if (val !== null && typeof val === 'object') {
    const entries = Array.isArray(val) ? val.map((v, i) => [String(i), v] as const) : Object.entries(val);
    return { key, type: Array.isArray(val) ? 'array' : 'object', children: entries.map(([k, v]) => build(k, v)) };
  }
  return { key, type: typeof val, value: String(val) };
}
export function toTree(src: string): TreeNode { return build('$', JSON.parse(src)); }
