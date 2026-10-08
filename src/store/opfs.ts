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
    // Stable oldest-first order (upload/creation order) so the file list never
    // reshuffles when a file is edited. Legacy records without createdAt fall
    // back to updatedAt.
    return (await this.adapter.entries())
      .map(([, m]) => m)
      .sort((a, b) => (a.createdAt ?? a.updatedAt) - (b.createdAt ?? b.updatedAt));
  }
  async save(name: string, data: Blob, kind: FileKind): Promise<FileRecord> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const rec: FileRecord = { id, name, kind, size: data.size, updatedAt: now, createdAt: now };
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
  // Update metadata (e.g. tracked share links) without touching the stored blob.
  async updateMeta(id: string, patch: Partial<FileRecord>): Promise<FileRecord> {
    const found = (await this.adapter.entries()).find(([k]) => k === id);
    if (!found) throw new Error('not found');
    const meta = { ...found[1], ...patch };
    await this.adapter.put(id, await this.adapter.get(id), meta);
    return meta;
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
    const rm = (name: string) => dir.removeEntry(name).catch((e: unknown) => {
      if ((e as DOMException)?.name !== 'NotFoundError') throw e; // already gone is fine
    });
    await rm(id);
    await rm(this.metaName(id));
  }

  // Remove storage that no listed file owns: data without metadata (a save
  // interrupted between the two writes), metadata without data, and Chrome's
  // temporary *.crswap files left by interrupted writes. Returns bytes freed.
  async cleanupOrphans(): Promise<number> {
    const dir = await this.dir();
    const names = new Map<string, FileSystemFileHandle>();
    // @ts-expect-error entries() is available on FileSystemDirectoryHandle at runtime
    for await (const [name, handle] of dir.entries()) {
      if ((handle as FileSystemHandle).kind === 'file') names.set(name, handle as FileSystemFileHandle);
    }
    let freed = 0;
    for (const [name, handle] of names) {
      const isMeta = name.endsWith('.meta.json');
      const orphan = name.endsWith('.crswap')
        || (isMeta && !names.has(name.slice(0, -'.meta.json'.length)))
        || (!isMeta && !names.has(this.metaName(name)));
      if (!orphan) continue;
      // Skip anything touched in the last hour: another tab may be mid-save.
      let file: File;
      try { file = await handle.getFile(); } catch { continue; }
      if (Date.now() - file.lastModified < 60 * 60 * 1000) continue;
      await dir.removeEntry(name).then(() => { freed += file.size; }).catch(() => {});
    }
    return freed;
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
