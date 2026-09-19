// worker/src/sessions.ts
import { generateToken } from './tokens';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionUser { userId: string; email: string | null }

export async function createSession(
  db: D1Database,
  userId: string,
): Promise<{ id: string; csrfToken: string; expiresAt: number }> {
  const id = crypto.randomUUID();
  const csrfToken = generateToken();
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await db
    .prepare('INSERT INTO sessions (id, user_id, csrf_token, expires_at) VALUES (?,?,?,?)')
    .bind(id, userId, csrfToken, expiresAt)
    .run();
  return { id, csrfToken, expiresAt };
}

export async function getSession(
  db: D1Database,
  sid: string | null,
): Promise<{ userId: string; csrfToken: string } | null> {
  if (!sid) return null;
  const row = await db
    .prepare('SELECT user_id, csrf_token, expires_at FROM sessions WHERE id = ?')
    .bind(sid)
    .first<{ user_id: string; csrf_token: string; expires_at: number }>();
  if (!row || row.expires_at < Date.now()) return null;
  return { userId: row.user_id, csrfToken: row.csrf_token };
}

export async function deleteSession(db: D1Database, sid: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
}

export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function sessionCookie(sid: string, maxAgeSeconds: number): string {
  return `sid=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
export function csrfCookie(token: string, maxAgeSeconds: number): string {
  return `csrf=${token}; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}
export function clearCookie(name: string): string {
  return `${name}=; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}
