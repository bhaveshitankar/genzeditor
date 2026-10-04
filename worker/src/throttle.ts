// worker/src/throttle.ts
// Exponential-backoff lockout over the auth_throttle table. Keys are isolated
// per IP and per email so one abused email can't permanently lock an IP.
const BASE_MS = 30_000; // first cooldown
const CAP_MS = 60 * 60_000; // 1h cap
const QUIET_RESET_MS = 60 * 60_000; // reset strikes after 1h quiet
const FREE_STRIKES = 1; // first strike already incurs BASE cooldown

export async function checkThrottle(
  db: D1Database,
  key: string,
  now = Date.now(),
): Promise<{ allowed: boolean; retryAfter: number }> {
  const row = await db
    .prepare('SELECT strikes, blocked_until, updated_at FROM auth_throttle WHERE key = ?')
    .bind(key)
    .first<{ strikes: number; blocked_until: number; updated_at: number }>();
  if (!row) return { allowed: true, retryAfter: 0 };
  if (now - row.updated_at >= QUIET_RESET_MS) return { allowed: true, retryAfter: 0 };
  if (row.blocked_until > now) {
    return { allowed: false, retryAfter: Math.ceil((row.blocked_until - now) / 1000) };
  }
  return { allowed: true, retryAfter: 0 };
}

function cooldownFor(strikes: number): number {
  if (strikes <= FREE_STRIKES) return BASE_MS;
  return Math.min(BASE_MS * 2 ** (strikes - FREE_STRIKES), CAP_MS);
}

export async function recordStrike(db: D1Database, key: string, now = Date.now()): Promise<void> {
  const row = await db
    .prepare('SELECT strikes, updated_at FROM auth_throttle WHERE key = ?')
    .bind(key)
    .first<{ strikes: number; updated_at: number }>();
  const prior = !row || now - row.updated_at >= QUIET_RESET_MS ? 0 : row.strikes;
  const strikes = prior + 1;
  const blockedUntil = now + cooldownFor(strikes);
  await db
    .prepare(
      'INSERT INTO auth_throttle (key, strikes, blocked_until, updated_at) VALUES (?,?,?,?) ' +
        'ON CONFLICT(key) DO UPDATE SET strikes=excluded.strikes, blocked_until=excluded.blocked_until, updated_at=excluded.updated_at',
    )
    .bind(key, strikes, blockedUntil, now)
    .run();
}

export async function clearThrottle(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM auth_throttle WHERE key = ?').bind(key).run();
}
