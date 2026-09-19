import { describe, it, expect, vi } from 'vitest';
import { openFromHash } from '../../src/share/openShared';
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
});
