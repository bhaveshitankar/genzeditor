import type { FileKind } from '../store/types';
// Binary files are preview-only: they must never be decoded as text and
// rewritten (a lossy round-trip would corrupt the original bytes).
export function editorKindFor(kind: FileKind): 'text' | 'image' | 'binary' {
  if (kind === 'image') return 'image';
  if (kind === 'binary') return 'binary';
  return 'text';
}
