import { describe, it, expect, vi, afterEach } from 'vitest';
import { getMe, createShare, resolveShare, requestEmailOtp } from '../../src/api/client';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('api client', () => {
  it('getMe maps the Better Auth session to authenticated state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ user: { email: 'a@b.co' } }), { status: 200 })));
    expect(await getMe()).toEqual({ authenticated: true, email: 'a@b.co' });
  });

  it('getMe returns unauthenticated when no user', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })));
    expect(await getMe()).toEqual({ authenticated: false });
  });

  it('createShare posts with credentials and CSRF header', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ token: 't', shareId: 's' }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    const r = await createShare({ access: 'ro', storageKind: 'embedded', contentType: 'text/plain', title: 'x', sizeBytes: 0 }, 'csrf1');
    expect(r.token).toBe('t');
    expect(spy).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const init = (spy.mock.calls as any)[0][1] as RequestInit;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string,string>)['X-CSRF-Token']).toBe('csrf1');
  });

  it('resolveShare fetches by token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ access: 'ro', storageKind: 'filebase', contentType: 'image/png', title: 't', downloadUrl: 'https://x' }), { status: 200 })));
    const r = await resolveShare('tok');
    expect(r.downloadUrl).toBe('https://x');
  });

  it('requestEmailOtp posts email + turnstile token and throws OtpError on 429', async () => {
    const spy = vi.fn(async () => new Response(JSON.stringify({ error: 'rate_limited', retryAfter: 42 }), { status: 429 }));
    vi.stubGlobal('fetch', spy);
    await expect(requestEmailOtp('a@b.co', 'tok')).rejects.toMatchObject({ error: 'rate_limited', retryAfter: 42 });
    const init = (spy.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(init.body).toContain('a@b.co');
    expect(init.body).toContain('tok');
  });
});
