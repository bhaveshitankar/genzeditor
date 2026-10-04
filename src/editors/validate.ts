// Lightweight, dependency-free content validators. Each returns a friendly
// result the shell surfaces as a toast / inline status. Validation is chosen by
// filename extension (HTML/XML/SVG all arrive as the `code` kind), so callers
// use `validatorFor` to decide whether to show the Validate button at all.

export interface ValidationResult {
  ok: boolean;
  message: string;
}

type Validator = (text: string) => ValidationResult;

function extOf(filename: string): string {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

/** Returns a validator for this filename, or null when nothing meaningful can be checked. */
export function validatorFor(filename: string): Validator | null {
  const ext = extOf(filename);
  if (ext === 'json') return validateJson;
  if (ext === 'html' || ext === 'htm') return (t) => validateMarkup(t, 'html');
  if (ext === 'xml' || ext === 'svg') return (t) => validateMarkup(t, 'xml');
  return null;
}

export function validateJson(text: string): ValidationResult {
  if (text.trim() === '') return { ok: false, message: 'JSON is empty.' };
  try {
    JSON.parse(text);
    return { ok: true, message: 'Valid JSON ✓' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `Invalid JSON: ${msg}` };
  }
}

export function validateMarkup(text: string, kind: 'html' | 'xml'): ValidationResult {
  if (typeof DOMParser === 'undefined') return { ok: true, message: 'Validation unavailable here.' };
  if (kind === 'html') {
    // text/html parsing is lenient and never reports errors, so probe
    // well-formedness through XHTML parsing to give useful structural feedback.
    const xdoc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    const xerr = xdoc.querySelector('parsererror');
    if (xerr) return { ok: true, message: 'HTML parsed (not strictly XHTML well-formed).' };
    return { ok: true, message: 'HTML looks well-formed ✓' };
  }
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) {
    const first = err.textContent?.split('\n').find((l) => l.trim()) ?? 'parse error';
    return { ok: false, message: `Invalid XML: ${first.trim()}` };
  }
  return { ok: true, message: 'Valid XML ✓' };
}
