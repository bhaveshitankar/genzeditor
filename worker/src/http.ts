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

export function requireCsrf(req: Request, sessionCsrf: string): boolean {
  return req.headers.get('X-CSRF-Token') === sessionCsrf && sessionCsrf.length > 0;
}
