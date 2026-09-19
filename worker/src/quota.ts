// worker/src/quota.ts
export const CAP_ANON = 500 * 1024 * 1024;
export const CAP_USER = 700 * 1024 * 1024;
export const MAX_FILE = 500 * 1024 * 1024;

export function capFor(isLoggedIn: boolean): number {
  return isLoggedIn ? CAP_USER : CAP_ANON;
}

export async function currentUsage(db: D1Database, ownerRef: string): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM quota_ledger WHERE owner_ref = ?')
    .bind(ownerRef)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

export async function checkQuota(
  db: D1Database,
  ownerRef: string,
  isLoggedIn: boolean,
  newSize: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!Number.isFinite(newSize) || newSize <= 0) return { ok: false, error: 'invalid_size' };
  if (newSize > MAX_FILE) return { ok: false, error: 'file_too_large' };
  const usage = await currentUsage(db, ownerRef);
  if (usage + newSize > capFor(isLoggedIn)) return { ok: false, error: 'quota_exceeded' };
  return { ok: true };
}

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
      'INSERT INTO quota_ledger (id, owner_ref, object_key, size_bytes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, ownerRef, objectKey, size, Date.now(), expiresAt)
    .run();
  return id;
}
