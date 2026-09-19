// worker/src/retention.ts
import type { Env } from './env';

export async function sweepExpired(
  env: Env,
  deleteObject: (key: string) => Promise<void>,
  now = Date.now(),
): Promise<{ deletedShares: number; deletedLedger: number; deletedObjects: number }> {
  const ledgerRows = await env.DB.prepare(
    'SELECT object_key FROM quota_ledger WHERE expires_at < ?',
  ).bind(now).all<{ object_key: string }>();
  const keys = (ledgerRows.results ?? []).map((r) => r.object_key);

  let deletedObjects = 0;
  for (const key of keys) {
    await deleteObject(key);
    deletedObjects++;
  }

  const ledgerDel = await env.DB.prepare('DELETE FROM quota_ledger WHERE expires_at < ?').bind(now).run();
  const sharesDel = await env.DB.prepare('DELETE FROM shares WHERE expires_at < ?').bind(now).run();

  return {
    deletedShares: sharesDel.meta.changes ?? 0,
    deletedLedger: ledgerDel.meta.changes ?? 0,
    deletedObjects,
  };
}
