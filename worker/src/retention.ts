// worker/src/retention.ts
import type { Env } from './env';

// Sweep expired shares/ledger rows AND abandoned (never-confirmed) reservations.
// The object store is the source of truth for what must be deleted: we collect
// every object key that belongs to an expired confirmed row OR a lapsed pending
// reservation OR an expired share, and only delete the D1 rows AFTER a confirmed
// successful object delete. If deleteObject reports failure we leave the rows so
// the next run retries, and we do not count it or free its quota.
export async function sweepExpired(
  env: Env,
  deleteObject: (key: string) => Promise<boolean>,
  now = Date.now(),
): Promise<{ deletedShares: number; deletedLedger: number; deletedObjects: number }> {
  // Expired confirmed rows + lapsed pending reservations.
  const ledgerRows = await env.DB.prepare(
    'SELECT object_key FROM quota_ledger WHERE (pending_expires_at IS NULL AND expires_at < ?) ' +
      'OR (pending_expires_at IS NOT NULL AND pending_expires_at < ?)',
  ).bind(now, now).all<{ object_key: string }>();

  // Expired shares that have an uploaded object (covers reclaimed pending shares).
  const shareRows = await env.DB.prepare(
    'SELECT object_key FROM shares WHERE expires_at < ? AND object_key IS NOT NULL',
  ).bind(now).all<{ object_key: string }>();

  const keys = new Set<string>();
  for (const r of ledgerRows.results ?? []) if (r.object_key) keys.add(r.object_key);
  for (const r of shareRows.results ?? []) if (r.object_key) keys.add(r.object_key);

  let deletedObjects = 0;
  let deletedLedger = 0;
  let deletedShares = 0;

  for (const key of keys) {
    const ok = await deleteObject(key);
    if (!ok) continue; // leave rows for the next run; do not free quota
    deletedObjects++;
    const ld = await env.DB.prepare('DELETE FROM quota_ledger WHERE object_key = ?').bind(key).run();
    deletedLedger += ld.meta.changes ?? 0;
    const sd = await env.DB.prepare('DELETE FROM shares WHERE object_key = ?').bind(key).run();
    deletedShares += sd.meta.changes ?? 0;
  }

  // Expired shares with no object (embedded) can be removed unconditionally.
  const emb = await env.DB.prepare(
    'DELETE FROM shares WHERE expires_at < ? AND object_key IS NULL',
  ).bind(now).run();
  deletedShares += emb.meta.changes ?? 0;

  // Data minimization: rate-limit counters (hashed IP/device) only need to live
  // for their window; drop anything older than 2 days.
  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 2 * 86_400_000).run();

  // Telemetry kept 30 days, feedback 1 year.
  await env.DB.prepare('DELETE FROM client_events WHERE ts < ?').bind(now - 30 * 86_400_000).run();
  await env.DB.prepare('DELETE FROM feedback WHERE ts < ?').bind(now - 365 * 86_400_000).run();

  return { deletedShares, deletedLedger, deletedObjects };
}
