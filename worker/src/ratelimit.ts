// worker/src/ratelimit.ts
export async function rateLimit(
  db: D1Database,
  ipHash: string,
  bucket: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<{ ok: boolean }> {
  const row = await db
    .prepare('SELECT window_start, count FROM rate_limits WHERE ip_hash = ? AND bucket = ?')
    .bind(ipHash, bucket)
    .first<{ window_start: number; count: number }>();

  if (!row || now - row.window_start >= windowMs) {
    await db
      .prepare(
        'INSERT INTO rate_limits (ip_hash, bucket, window_start, count) VALUES (?,?,?,1) ' +
          'ON CONFLICT(ip_hash, bucket) DO UPDATE SET window_start = excluded.window_start, count = 1',
      )
      .bind(ipHash, bucket, now)
      .run();
    return { ok: true };
  }

  if (row.count >= limit) return { ok: false };

  await db
    .prepare('UPDATE rate_limits SET count = count + 1 WHERE ip_hash = ? AND bucket = ?')
    .bind(ipHash, bucket)
    .run();
  return { ok: true };
}
