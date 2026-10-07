// worker/src/feedback.ts
// Client failure telemetry and user feedback. Telemetry stores no IP or user
// identifiers; messages are scrubbed of emails and URL query strings.
import type { Env } from './env';

const TYPES = new Set(['error', 'fail']);
const APPS = new Set(['web', 'mobile']);
const CATEGORIES = new Set(['bug', 'idea', 'question', 'other']);

const cut = (v: unknown, n: number): string | null =>
  typeof v === 'string' && v.length ? v.slice(0, n) : null;

export function scrub(msg: string): string {
  return msg
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/(https?:\/\/[^\s?#]*)\?[^\s#]*/g, '$1?[query]')
    .replace(/#t=[A-Za-z0-9_-]+/g, '#t=[token]');
}

function platformOf(req: Request): string | null {
  const ch = req.headers.get('Sec-CH-UA-Platform');
  if (ch) return ch.replace(/"/g, '').slice(0, 40);
  const ua = req.headers.get('User-Agent') ?? '';
  const m = /(iPhone|iPad|Android|Windows|Macintosh|Linux|CrOS)/.exec(ua);
  return m ? m[1]! : null;
}

export async function recordTelemetry(env: Env, req: Request, body: unknown): Promise<boolean> {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length === 0) return false;
  const now = Date.now();
  const platform = platformOf(req);
  const stmts: D1PreparedStatement[] = [];
  for (const raw of events.slice(0, 20)) {
    const e = raw as Record<string, unknown>;
    if (!TYPES.has(e.type as string) || !APPS.has(e.app as string)) continue;
    const message = cut(e.message, 500);
    stmts.push(env.DB.prepare(
      'INSERT INTO client_events (id, ts, app, version, type, where_, message, kind, platform) VALUES (?,?,?,?,?,?,?,?,?)',
    ).bind(crypto.randomUUID(), now, e.app, cut(e.version, 40), e.type, cut(e.where, 120),
      message ? scrub(message) : null, cut(e.kind, 40), platform));
  }
  if (!stmts.length) return false;
  await env.DB.batch(stmts);
  return true;
}

export async function recordFeedback(env: Env, req: Request, body: unknown, userId: string | null): Promise<string | null> {
  const b = body as Record<string, unknown>;
  const category = String(b?.category ?? '');
  const message = typeof b?.message === 'string' ? b.message.trim() : '';
  if (!CATEGORIES.has(category)) return 'bad_category';
  if (message.length < 1 || message.length > 4000) return 'bad_message';
  let email: string | null = null;
  if (b.email != null && b.email !== '') {
    if (typeof b.email !== 'string' || b.email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) return 'bad_email';
    email = b.email.trim().toLowerCase();
  }
  const ctx = (b.context ?? {}) as Record<string, unknown>;
  const path = cut(ctx.path, 200);
  await env.DB.prepare(
    'INSERT INTO feedback (id, ts, category, message, email, user_id, app, version, file_kind, platform, path) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
  ).bind(crypto.randomUUID(), Date.now(), category, message, email, userId, cut(ctx.app, 20), cut(ctx.version, 40),
    cut(ctx.fileKind, 40), cut(ctx.platform, 40) ?? platformOf(req), path ? scrub(path) : null).run();
  return null;
}
