// worker/src/http.ts
import type { Env } from './env';

export function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-CSRF-Token',
    'Vary': 'Origin',
  };
}

export function securityHeaders(): Record<string, string> {
  return {
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
  };
}

export function json(
  body: unknown,
  env: Env,
  init?: { status?: number; headers?: Record<string, string> },
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      'content-type': 'application/json',
      ...corsHeaders(env),
      ...securityHeaders(),
      ...(init?.headers ?? {}),
    },
  });
}

export function error(code: string, env: Env, status: number): Response {
  return json({ error: code }, env, { status });
}

export function preflight(env: Env): Response {
  return new Response(null, { status: 204, headers: { ...corsHeaders(env), ...securityHeaders() } });
}

// Constant-time string comparison using WebCrypto HMAC. Both inputs are HMAC'd
// with an ephemeral random key producing fixed-length (32-byte) digests, so the
// final byte-wise compare runs in time independent of the inputs — closing the
// timing side channel a naive `===` on the raw tokens would open.
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const da = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(a)));
  const db = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(b)));
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

// Reject cross-site browser-driven mutations: if the request carries an Origin
// (always sent by browsers on cross-origin POST) or Referer, it must match
// ALLOWED_ORIGIN. Absent both (non-browser / same-origin clients), allow — this
// is the anon counterpart to CSRF double-submit for logged-in users.
export function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get('Origin');
  if (origin) return origin === env.ALLOWED_ORIGIN;
  const referer = req.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin === env.ALLOWED_ORIGIN;
    } catch {
      return false;
    }
  }
  return true;
}

export async function requireCsrf(req: Request, sessionCsrf: string): Promise<boolean> {
  const token = req.headers.get('X-CSRF-Token');
  if (!token || sessionCsrf.length === 0) return false;
  return timingSafeEqual(token, sessionCsrf);
}
