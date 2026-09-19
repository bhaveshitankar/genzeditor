import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMe, createShare, resolveShare, loginUrl } from '../../src/api/client';

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('getMe parses authenticated state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ authenticated: true, email: 'a@b.co', csrfToken: 'c' }), { status: 200 })));
    expect(await getMe()).toEqual({ authenticated: true, email: 'a@b.co', csrfToken: 'c' });
  });

  it('createShare posts with credentials and CSRF header', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ token: 't', shareId: 's' }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const r = await createShare({ access: 'ro', storageKind: 'embedded', contentType: 'text/plain', title: 'x', sizeBytes: 0 }, 'csrf1');
    expect(r.token).toBe('t');
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string,string>)['X-CSRF-Token']).toBe('csrf1');
  });

  it('resolveShare fetches by token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ access: 'ro', storageKind: 'filebase', contentType: 'image/png', title: 't', downloadUrl: 'https://x' }), { status: 200 })));
    const r = await resolveShare('tok');
    expect(r.downloadUrl).toBe('https://x');
  });

  it('loginUrl points at the provider start endpoint', () => {
    expect(loginUrl('github')).toContain('/api/auth/github/start');
  });
});
