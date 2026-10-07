// worker/src/quota.ts
export const CAP_ANON = 500 * 1024 * 1024;
export const CAP_USER = 700 * 1024 * 1024;
export const MAX_FILE = 20 * 1024 * 1024;

export function capFor(isLoggedIn: boolean): number {
  return isLoggedIn ? CAP_USER : CAP_ANON;
}

// A ledger row counts toward usage when it is confirmed (pending_expires_at IS
// NULL) OR it is still a live reservation (pending_expires_at > now). This makes
// a create-time reservation consume quota immediately so the cap cannot be
// bypassed by never confirming, while abandoned reservations stop counting once
// their pending window lapses (and are then reclaimed by retention).
export async function currentUsage(
  db: D1Database,
  ownerRef: string,
  now = Date.now(),
): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM quota_ledger WHERE owner_ref = ? ' +
        'AND (pending_expires_at IS NULL OR pending_expires_at > ?)',
    )
    .bind(ownerRef, now)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function checkQuota(
  db: D1Database,
  ownerRef: string,
  isLoggedIn: boolean,
  newSize: number,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(newSize) || newSize <= 0) return { ok: false, error: 'invalid_size' };
  if (newSize > MAX_FILE) return { ok: false, error: 'file_too_large' };
  const usage = await currentUsage(db, ownerRef, now);
  if (usage + newSize > capFor(isLoggedIn)) return { ok: false, error: 'quota_exceeded' };
  return { ok: true };
}

// Confirmed ledger row (pending_expires_at NULL). Used by confirm/backfill paths.
export async function recordLedger(
  db: D1Database,
  ownerRef: string,
  objectKey: string,
  size: number,
  expiresAt: number,
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO quota_ledger (id, owner_ref, object_key, size_bytes, created_at, expires_at, pending_expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
    )
    .bind(id, ownerRef, objectKey, size, Date.now(), expiresAt)
    .run();
  return id;
}

// Reserve quota at create time. The row counts immediately but is marked pending
// with a short expiry; confirmShare clears the pending flag, retention reclaims
// it if never confirmed.
export async function reserveLedger(
  db: D1Database,
  ownerRef: string,
  objectKey: string,
  size: number,
  expiresAt: number,
  pendingExpiresAt: number,
  createdAt = Date.now(),
): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO quota_ledger (id, owner_ref, object_key, size_bytes, created_at, expires_at, pending_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(id, ownerRef, objectKey, size, createdAt, expiresAt, pendingExpiresAt)
    .run();
  return id;
}
