// worker/test/http.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { json, error, corsHeaders, securityHeaders, preflight, requireCsrf } from '../src/http';

describe('http helpers', () => {
  it('locks CORS to the Pages origin with credentials', () => {
    const h = corsHeaders(env);
    expect(h['Access-Control-Allow-Origin']).toBe('https://anyedits-aay.pages.dev');
    expect(h['Access-Control-Allow-Credentials']).toBe('true');
  });

  it('json responses carry security + cors headers', async () => {
    const res = json({ a: 1 }, env, { status: 201 });
    expect(res.status).toBe(201);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('error responses use the code', async () => {
    const res = error('nope', env, 400);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'nope' });
  });

  it('preflight returns 204', () => {
    expect(preflight(env).status).toBe(204);
  });

  it('requireCsrf compares header to session token (constant-time)', async () => {
    const req = new Request('https://x/', { headers: { 'X-CSRF-Token': 'tok' } });
    expect(await requireCsrf(req, 'tok')).toBe(true);
    expect(await requireCsrf(req, 'other')).toBe(false);
    // empty session token is always rejected (M1)
    expect(await requireCsrf(req, '')).toBe(false);
    // missing header is rejected
    const noHeader = new Request('https://x/');
    expect(await requireCsrf(noHeader, 'tok')).toBe(false);
  });
});
