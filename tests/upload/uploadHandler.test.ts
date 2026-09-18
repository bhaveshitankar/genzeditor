import { describe, it, expect } from 'vitest';
import { handleUpload } from '../../src/upload/uploadHandler';
import { FileStore, MemoryAdapter } from '../../src/store/opfs';

const mkFile = (name: string, size: number) => {
  const f = new File([new Uint8Array(1)], name);
  Object.defineProperty(f, 'size', { value: size });
  return f;
};

describe('handleUpload', () => {
  it('rejects files over 500MB', async () => {
    const store = new FileStore(new MemoryAdapter());
    const res = await handleUpload(mkFile('big.txt', 500 * 1024 * 1024 + 1), store);
    expect(res.ok).toBe(false);
  });
  it('stores a valid file with detected kind', async () => {
    const store = new FileStore(new MemoryAdapter());
    const res = await handleUpload(new File(['{}'], 'a.json'), store);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.kind).toBe('json');
  });
});
