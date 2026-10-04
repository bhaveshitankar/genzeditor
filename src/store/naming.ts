// Naming helpers for imported/shared documents.
//
// Shared links carry generic titles ("Shared document"), so opening the same
// link repeatedly used to create indistinguishable duplicates. We derive a
// meaningful base name from the document's opening text when the title is
// generic, then disambiguate collisions with a version suffix " (vN)".

const GENERIC_TITLES = new Set([
  'shared', 'shared file', 'shared document', 'untitled', '',
]);

/** Derive a human name: prefer a meaningful title, else the first line of text. */
export function deriveBaseName(title: string | undefined, text?: string): string {
  const t = (title ?? '').trim();
  if (t && !GENERIC_TITLES.has(t.toLowerCase())) return t;

  if (text) {
    const firstLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstLine) {
      const cleaned = firstLine
        .replace(/^#+\s*/, '')          // markdown heading markers
        .replace(/[<>:"/\\|?*]+/g, ' ') // filesystem-unfriendly chars
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40)
        .trim();
      if (cleaned) return cleaned;
    }
  }
  return t || 'Untitled';
}

function splitExt(name: string): { stem: string; ext: string } {
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(name);
  if (m) return { stem: name.slice(0, m.index), ext: m[0] };
  return { stem: name, ext: '' };
}

/**
 * Return `base` if unused, otherwise the first free "stem (vN) ext" variant.
 * `existing` is the set of names already in the store.
 */
export function versionedName(base: string, existing: Iterable<string>): string {
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  const { stem, ext } = splitExt(base);
  for (let v = 2; ; v++) {
    const candidate = `${stem} (v${v})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}
