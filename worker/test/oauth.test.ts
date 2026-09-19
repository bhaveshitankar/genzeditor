// worker/test/oauth.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { pkcePair, buildAuthUrl, exchangeCode, type Fetcher } from '../src/oauth';

describe('oauth', () => {
  it('produces a valid S256 PKCE pair', async () => {
    const { verifier, challenge } = await pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
  });

  it('builds a Google auth URL with PKCE + state', () => {
    const url = new URL(buildAuthUrl('google', env, 'st8', 'chal', 'https://cb'));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('gid');
    expect(url.searchParams.get('state')).toBe('st8');
    expect(url.searchParams.get('code_challenge')).toBe('chal');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cb');
  });

  it('exchanges a github code using a mocked fetcher', async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = async (input) => {
      const u = String(input);
      calls.push(u);
      if (u.includes('login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'AT' }), { headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('api.github.com/user')) {
        return new Response(JSON.stringify({ id: 42, email: 'gh@u.co' }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('nope', { status: 500 });
    };
    const r = await exchangeCode('github', env, 'code123', 'ver', 'https://cb', fetcher);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.subject).toBe('42'); expect(r.email).toBe('gh@u.co'); }
    expect(calls.some((c) => c.includes('access_token'))).toBe(true);
  });

  it('reports failure when token exchange errors', async () => {
    const fetcher: Fetcher = async () => new Response('bad', { status: 401 });
    const r = await exchangeCode('google', env, 'c', 'v', 'https://cb', fetcher);
    expect(r.ok).toBe(false);
  });
});
