import type { FileKind, FileRecord, StorageAdapter } from './types';
export type { FileKind, FileRecord } from './types';

export class MemoryAdapter implements StorageAdapter {
  private blobs = new Map<string, Blob>();
  private metas = new Map<string, FileRecord>();
  async put(id: string, blob: Blob, meta: FileRecord) { this.blobs.set(id, blob); this.metas.set(id, meta); }
  async get(id: string) { const b = this.blobs.get(id); if (!b) throw new Error('not found'); return b; }
  async del(id: string) { this.blobs.delete(id); this.metas.delete(id); }
  async entries() { return [...this.metas.entries()]; }
}

export class FileStore {
  constructor(private adapter: StorageAdapter) {}
  async list(): Promise<FileRecord[]> {
    return (await this.adapter.entries()).map(([, m]) => m).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async save(name: string, data: Blob, kind: FileKind): Promise<FileRecord> {
    const id = crypto.randomUUID();
    const rec: FileRecord = { id, name, kind, size: data.size, updatedAt: Date.now() };
    await this.adapter.put(id, data, rec);
    return rec;
  }
  async read(id: string): Promise<Blob> { return this.adapter.get(id); }
  async rename(id: string, name: string): Promise<void> {
    const entries = await this.adapter.entries();
    const found = entries.find(([k]) => k === id);
    if (!found) throw new Error('not found');
    const meta = { ...found[1], name, updatedAt: Date.now() };
    await this.adapter.put(id, await this.adapter.get(id), meta);
  }
  async remove(id: string): Promise<void> { await this.adapter.del(id); }
  async update(id: string, data: Blob): Promise<void> {
    const found = (await this.adapter.entries()).find(([k]) => k === id);
    if (!found) throw new Error('not found');
    await this.adapter.put(id, data, { ...found[1], size: data.size, updatedAt: Date.now() });
  }
}

// OpfsAdapter used in production (not exercised in jsdom tests).
export class OpfsAdapter implements StorageAdapter {
  private async dir() { return (await navigator.storage.getDirectory()); }
  private metaName(id: string) { return `${id}.meta.json`; }
  async put(id: string, blob: Blob, meta: FileRecord) {
    const dir = await this.dir();
    const fh = await dir.getFileHandle(id, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
    const mh = await dir.getFileHandle(this.metaName(id), { create: true });
    const mw = await mh.createWritable(); await mw.write(JSON.stringify(meta)); await mw.close();
  }
  async get(id: string) { const dir = await this.dir(); return (await (await dir.getFileHandle(id)).getFile()); }
  async del(id: string) {
    const dir = await this.dir();
    await dir.removeEntry(id).catch(() => {});
    await dir.removeEntry(this.metaName(id)).catch(() => {});
  }
  async entries(): Promise<Array<[string, FileRecord]>> {
    const dir = await this.dir(); const out: Array<[string, FileRecord]> = [];
    // @ts-expect-error values() is available on FileSystemDirectoryHandle at runtime
    for await (const [name, handle] of dir.entries()) {
      if (name.endsWith('.meta.json')) {
        const f = await (handle as FileSystemFileHandle).getFile();
        const meta = JSON.parse(await f.text()) as FileRecord; out.push([meta.id, meta]);
      }
    }
    return out;
  }
}
