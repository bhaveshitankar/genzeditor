import type { Env } from './env';
import { handle } from './router';
import { isAllowedOrigin } from './http';
import { sweepExpired } from './retention';
import { presignS3 } from './sigv4';

// Durable Object class must be exported from the Worker entry so the runtime
// can instantiate it for the GAME_ROOM binding.
export { GameRoom } from './gameRoom';

// Returns true only when the object is confirmed gone (2xx, or 404 = already
// absent). Any network error or non-success status returns false so retention
// leaves the row for the next run instead of orphaning the object.
async function deleteObject(env: Env, key: string): Promise<boolean> {
  const url = await presignS3({
    method: 'DELETE',
    endpoint: env.FILEBASE_ENDPOINT,
    region: env.FILEBASE_REGION,
    bucket: env.FILEBASE_BUCKET,
    key,
    accessKey: env.FILEBASE_KEY,
    secretKey: env.FILEBASE_SECRET,
    expiresSeconds: 60,
    now: new Date(),
  });
  try {
    const res = await fetch(url, { method: 'DELETE' });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const res = await handle(req, env);
    // Echo the caller's Origin on the response when it's in the allowlist.
    // Credentialed CORS can't use "*", and the helpers default to the first
    // configured origin, so rewrite here to support multiple allowed origins.
    const origin = req.headers.get('Origin');
    if (isAllowedOrigin(origin, env) && res.headers.has('Access-Control-Allow-Origin')) {
      const headers = new Headers(res.headers);
      headers.set('Access-Control-Allow-Origin', origin!);
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepExpired(env, (key) => deleteObject(env, key)));
  },
} satisfies ExportedHandler<Env>;
