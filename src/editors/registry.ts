import type { FileKind } from '../store/types';
import type { EditCommands } from './editCommands';

// Common shape for the rich document editors (spreadsheet/pdf/presentation).
// `export()` serializes current state for download / save-back, or returns null
// when the document is view-only.
export interface DocEditor {
  destroy(): void;
  export(): Promise<{ blob: Blob; contentType: string } | null>;
  // Undo/redo/cut/copy/paste/delete… — the shell binds keys + mobile long-press.
  commands?(): EditCommands;
}
// Binary files are preview-only: they must never be decoded as text and
// rewritten (a lossy round-trip would corrupt the original bytes).
export type EditorKind = 'text' | 'image' | 'pdf' | 'spreadsheet' | 'presentation'
  | 'video' | 'audio' | 'document' | 'sketch' | 'floorplan' | 'game' | 'binary';

export function editorKindFor(kind: FileKind): EditorKind {
  if (kind === 'image') return 'image';
  if (kind === 'pdf') return 'pdf';
  if (kind === 'spreadsheet') return 'spreadsheet';
  if (kind === 'presentation') return 'presentation';
  if (kind === 'video') return 'video';
  if (kind === 'audio') return 'audio';
  if (kind === 'document') return 'document';
  if (kind === 'sketch') return 'sketch';
  if (kind === 'floorplan') return 'floorplan';
  if (kind === 'game') return 'game';
  if (kind === 'binary') return 'binary';
  return 'text';
}
