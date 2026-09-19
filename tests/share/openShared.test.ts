import { describe, it, expect, vi } from 'vitest';
import { openFromHash, saveBackShared } from '../../src/share/openShared';
import { encodeEmbedded } from '../../src/share/embedded';

describe('openFromHash', () => {
  it('returns null when no share is present', async () => {
    expect(await openFromHash('#foo=bar')).toBeNull();
  });

  it('decodes an embedded share', async () => {
    const frag = encodeEmbedded('# Hello');
    const r = await openFromHash(`#s=${frag}&ct=${encodeURIComponent('text/markdown')}`);
    expect(r?.text).toBe('# Hello');
    expect(r?.kind).toBe('markdown');
    expect(r?.access).toBe('ro');
  });

  it('resolves a filebase token and fetches the blob', async () => {
    const api = {
      resolveShare: vi.fn(async () => ({ access: 'ro' as const, storageKind: 'filebase' as const, contentType: 'image/png', title: 'p.png', downloadUrl: 'https://get' })),
    } as unknown as typeof import('../../src/api/client');
    const fetchBlob = vi.fn(async () => new Blob([new Uint8Array(3)], { type: 'image/png' }));
    const r = await openFromHash('#t=imgtok', { api, fetchBlob });
    expect(fetchBlob).toHaveBeenCalledWith('https://get');
    expect(r?.kind).toBe('image');
    expect(r?.blob?.size).toBe(3);
  });

  it('surfaces the token for rw shares and saves back via initSaveBack then PUT', async () => {
    const api = {
      resolveShare: vi.fn(async () => ({ access: 'rw' as const, storageKind: 'filebase' as const, contentType: 'text/plain', title: 'doc.txt', downloadUrl: 'https://get' })),
    } as unknown as typeof import('../../src/api/client');
    const fetchBlob = vi.fn(async () => new Blob(['hi'], { type: 'text/plain' }));
    const r = await openFromHash('#t=rwtok', { api, fetchBlob });
    expect(r?.access).toBe('rw');
    expect(r?.token).toBe('rwtok');

    const initSaveBack = vi.fn(async () => ({ uploadUrl: 'https://put' }));
    const uploadPut = vi.fn(async () => {});
    const edited = new Blob(['edited-longer'], { type: 'text/plain' });
    await saveBackShared(r!.token!, edited, { api: { initSaveBack }, uploadPut, csrfToken: 'csrf1' });
    // Save-init is called with the ACTUAL edited size (not the stale share size).
    expect(initSaveBack).toHaveBeenCalledWith('rwtok', edited.size, 'csrf1');
    expect(uploadPut).toHaveBeenCalledWith('https://put', edited, 'text/plain');
  });

  it('propagates the server error code from save-init (e.g. quota_exceeded)', async () => {
    const initSaveBack = vi.fn(async () => { throw new Error('quota_exceeded'); });
    const uploadPut = vi.fn(async () => {});
    await expect(
      saveBackShared('rwtok', new Blob(['x']), { api: { initSaveBack }, uploadPut }),
    ).rejects.toThrow('quota_exceeded');
    expect(uploadPut).not.toHaveBeenCalled();
  });

  it('does not surface a token for ro shares', async () => {
    const api = {
      resolveShare: vi.fn(async () => ({ access: 'ro' as const, storageKind: 'filebase' as const, contentType: 'text/plain', title: 'doc.txt', downloadUrl: 'https://get' })),
    } as unknown as typeof import('../../src/api/client');
    const fetchBlob = vi.fn(async () => new Blob(['hi'], { type: 'text/plain' }));
    const r = await openFromHash('#t=rotok', { api, fetchBlob });
    expect(r?.access).toBe('ro');
    expect(r?.token).toBeUndefined();
  });
});
