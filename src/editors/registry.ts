import type { FileKind } from '../store/types';
export function editorKindFor(kind: FileKind): 'text'|'image' {
  return kind === 'image' ? 'image' : 'text';
}
