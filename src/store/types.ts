export type FileKind = 'text'|'code'|'json'|'markdown'|'mermaid'|'image'|'binary';
export interface FileRecord { id: string; name: string; kind: FileKind; size: number; updatedAt: number }
export interface StorageAdapter {
  put(id: string, blob: Blob, meta: FileRecord): Promise<void>;
  get(id: string): Promise<Blob>;
  del(id: string): Promise<void>;
  entries(): Promise<Array<[string, FileRecord]>>;
}
