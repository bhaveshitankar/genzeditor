import { describe, it, expect, vi } from 'vitest';
import { shareFile } from '../../src/share/shareFlow';

describe('shareFile', () => {
  it('creates an updatable filebase link (never embedded) for a small text doc', async () => {
    const uploadPut = vi.fn(async () => {});
    const api = {
      createShare: vi.fn(async () => ({ token: 'tok', shareId: 's', uploadUrl: 'https://put', objectKey: 'k' })),
      confirmShare: vi.fn(async () => {}),
    } as unknown as typeof import('../../src/api/client');
    const r = await shareFile(
      { kind: 'markdown', text: '# hi', contentType: 'text/markdown', title: 'n', isLoggedIn: false, wantRw: false },
      { api, uploadPut },
    );
    expect('url' in r).toBe(true);
    if ('url' in r) {
      expect(r.url).toContain('#t=tok');
      expect(r.token).toBe('tok');
      expect(r.shareId).toBe('s');
      expect(r.access).toBe('ro');
    }
    expect(api.createShare).toHaveBeenCalledWith(
      expect.objectContaining({ storageKind: 'filebase', access: 'ro' }), undefined);
    expect(uploadPut).toHaveBeenCalled();
  });

  it('uploads to Filebase for an image and returns a token link', async () => {
    const uploadPut = vi.fn(async () => {});
    const api = {
      createShare: vi.fn(async () => ({ token: 'imgtok', shareId: 's2', uploadUrl: 'https://put', objectKey: 'k' })),
      confirmShare: vi.fn(async () => {}),
    } as unknown as typeof import('../../src/api/client');
    const r = await shareFile(
      { kind: 'image', blob: new Blob([new Uint8Array(10)]), contentType: 'image/png', title: 'p', isLoggedIn: false, wantRw: false },
      { api, uploadPut },
    );
    expect(uploadPut).toHaveBeenCalledWith('https://put', expect.any(Blob));
    expect(api.confirmShare).toHaveBeenCalledWith('s2', undefined);
    if ('url' in r) expect(r.url).toContain('#t=imgtok');
  });

  it('blocks rw without login', async () => {
    const r = await shareFile(
      { kind: 'markdown', text: 'x', contentType: 'text/markdown', title: 'n', isLoggedIn: false, wantRw: true },
      {},
    );
    expect('needLogin' in r).toBe(true);
  });
});
