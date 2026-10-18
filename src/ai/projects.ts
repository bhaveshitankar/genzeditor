// Project memory: what earlier parts of a longer work were about, so "continue"
// (next chapter, second verse set, part 2 of the video) keeps characters, style,
// key and tempo. Stored on this device only; the summary — never the media — is
// what gets sent along as context.
export interface PartMemory {
  n: number; kind: string; title: string; summary: string; at: number;
  plan?: { mood?: string; tempo?: number; key?: string; minor?: boolean };
}
export interface Project { id: string; title: string; style?: string; characters?: string; parts: PartMemory[]; updatedAt: number }

const KEY = 'anyedits:aiProject';
const MAX_PARTS = 12;

export function loadProject(): Project | null {
  try { const raw = localStorage.getItem(KEY); return raw ? (JSON.parse(raw) as Project) : null; } catch { return null; }
}
export function saveProject(p: Project | null): void {
  try { p ? localStorage.setItem(KEY, JSON.stringify(p)) : localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function addPart(prev: Project | null, part: Omit<PartMemory, 'n' | 'at'>, meta: { style?: string; characters?: string } = {}): Project {
  const p: Project = prev ?? { id: Math.random().toString(36).slice(2, 10), title: part.title, parts: [], updatedAt: 0 };
  p.parts = [...p.parts, { ...part, n: (p.parts[p.parts.length - 1]?.n ?? 0) + 1, at: Date.now() }].slice(-MAX_PARTS);
  if (meta.style) p.style = meta.style.slice(0, 120);
  if (meta.characters) p.characters = meta.characters.slice(0, 300);
  p.updatedAt = Date.now();
  saveProject(p);
  return p;
}

/** Compact continuity text for the model: style/characters + the last few part summaries. */
export function contextFor(p: Project | null): string {
  if (!p || !p.parts.length) return '';
  const bits: string[] = [`Project: ${p.title}.`];
  if (p.style) bits.push(`Style: ${p.style}.`);
  if (p.characters) bits.push(`Characters: ${p.characters}.`);
  for (const part of p.parts.slice(-3)) bits.push(`Part ${part.n} (${part.kind}) “${part.title}”: ${part.summary}`);
  return bits.join(' ').slice(0, 1400);
}

export function lastPlan(p: Project | null): PartMemory['plan'] | undefined {
  for (let i = (p?.parts.length ?? 0) - 1; i >= 0; i--) if (p!.parts[i]!.plan) return p!.parts[i]!.plan;
  return undefined;
}
