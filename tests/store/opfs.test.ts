import { describe, it, expect } from 'vitest';
import { FileStore } from '../../src/store/opfs';
import { MemoryAdapter } from '../../src/store/opfs';

describe('FileStore', () => {
  it('saves and lists a file', async () => {
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('note.txt', new Blob(['hi']), 'text');
    expect(rec.name).toBe('note.txt');
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect((await store.read(rec.id)).size).toBe(2);
  });

  it('renames and removes', async () => {
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('a.txt', new Blob(['x']), 'text');
    await store.rename(rec.id, 'b.txt');
    expect((await store.list())[0].name).toBe('b.txt');
    await store.remove(rec.id);
    expect(await store.list()).toHaveLength(0);
  });

  it('updates content in place', async () => {
    const store = new FileStore(new MemoryAdapter());
    const rec = await store.save('a.txt', new Blob(['x']), 'text');
    await store.update(rec.id, new Blob(['xyz']));
    expect((await store.read(rec.id)).size).toBe(3);
  });
});
