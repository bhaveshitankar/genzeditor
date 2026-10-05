export type FileKind = 'text'|'code'|'json'|'markdown'|'mermaid'|'image'|'pdf'|'spreadsheet'|'presentation'|'video'|'audio'|'document'|'sketch'|'floorplan'|'game'|'binary';
// A share link created for a file, tracked so repeat "Share" clicks reuse the
// existing link and "Save" can push the current content to every live link.
// Only filebase-backed shares (which have a token + shareId) can be updated in
// place; embedded ro links are point-in-time snapshots and are never tracked.
export interface ShareLink { access: 'ro' | 'rw'; token: string; shareId: string; url: string }
export interface FileRecord { id: string; name: string; kind: FileKind; size: number; updatedAt: number; createdAt?: number; shares?: ShareLink[]; sourceShareToken?: string }
export interface StorageAdapter {
  put(id: string, blob: Blob, meta: FileRecord): Promise<void>;
  get(id: string): Promise<Blob>;
  del(id: string): Promise<void>;
  entries(): Promise<Array<[string, FileRecord]>>;
}
