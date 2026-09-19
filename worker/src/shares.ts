// worker/src/shares.ts
import type { Env } from './env';
import { generateToken, hashToken } from './tokens';
import { checkQuota, recordLedger } from './quota';
import { presignPut, presignGet } from './filebase';

const RETAIN_ANON_MS = 7 * 24 * 60 * 60 * 1000;
const RETAIN_USER_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreateShareInput {
  ownerRef: string;
  isLoggedIn: boolean;
  access: 'ro' | 'rw';
  storageKind: 'embedded' | 'filebase';
  contentType: string;
  title: string;
  sizeBytes: number;
}

export async function createShare(
  env: Env,
  input: CreateShareInput,
  now = new Date(),
): Promise<
  | { ok: true; token: string; shareId: string; uploadUrl?: string; objectKey?: string }
  | { ok: false; error: string }
> {
  if (input.access === 'rw' && !input.isLoggedIn) return { ok: false, error: 'rw_requires_login' };

  const nowMs = now.getTime();
  const expiresAt = nowMs + (input.isLoggedIn ? RETAIN_USER_MS : RETAIN_ANON_MS);
  const token = generateToken();
  const tokenHash = await hashToken(token);
  const shareId = crypto.randomUUID();

  if (input.storageKind === 'embedded') {
    await env.DB.prepare(
      'INSERT INTO shares (id, token_hash, owner_ref, access, storage_kind, object_key, size_bytes, content_type, title, created_at, expires_at, revoked) ' +
        "VALUES (?,?,?,?,?,NULL,0,?,?,?,?,0)",
    ).bind(shareId, tokenHash, input.ownerRef, 'ro', 'embedded', input.contentType, input.title, nowMs, expiresAt).run();
    return { ok: true, token, shareId };
  }

  const q = await checkQuota(env.DB, input.ownerRef, input.isLoggedIn, input.sizeBytes);
  if (!q.ok) return { ok: false, error: q.error };

  const objectKey = `snapshots/${input.ownerRef}/${shareId}`;
  const uploadUrl = await presignPut(env, objectKey, input.sizeBytes, now);

  await env.DB.prepare(
    'INSERT INTO shares (id, token_hash, owner_ref, access, storage_kind, object_key, size_bytes, content_type, title, created_at, expires_at, revoked) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,0)',
  ).bind(shareId, tokenHash, input.ownerRef, input.access, 'filebase', objectKey, input.sizeBytes, input.contentType, input.title, nowMs, expiresAt).run();

  return { ok: true, token, shareId, uploadUrl, objectKey };
}

export async function confirmShare(
  env: Env,
  shareId: string,
  ownerRef: string,
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await env.DB.prepare(
    'SELECT object_key, size_bytes, expires_at, storage_kind FROM shares WHERE id = ? AND owner_ref = ?',
  ).bind(shareId, ownerRef).first<{ object_key: string; size_bytes: number; expires_at: number; storage_kind: string }>();
  if (!row || row.storage_kind !== 'filebase' || !row.object_key) return { ok: false, error: 'not_found' };

  const existing = await env.DB.prepare(
    'SELECT id FROM quota_ledger WHERE object_key = ?',
  ).bind(row.object_key).first<{ id: string }>();
  if (existing) return { ok: true };

  await recordLedger(env.DB, ownerRef, row.object_key, row.size_bytes, row.expires_at);
  return { ok: true };
}

export async function resolveShare(
  env: Env,
  token: string,
  now = new Date(),
): Promise<
  | { ok: true; access: 'ro' | 'rw'; storageKind: 'embedded' | 'filebase'; contentType: string | null; title: string | null; downloadUrl?: string }
  | { ok: false; error: string }
> {
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    'SELECT access, storage_kind, object_key, content_type, title, expires_at, revoked FROM shares WHERE token_hash = ?',
  ).bind(tokenHash).first<{
    access: 'ro' | 'rw'; storage_kind: 'embedded' | 'filebase'; object_key: string | null;
    content_type: string | null; title: string | null; expires_at: number; revoked: number;
  }>();
  if (!row || row.revoked === 1 || row.expires_at < now.getTime()) return { ok: false, error: 'not_found' };

  if (row.storage_kind === 'embedded') {
    return { ok: true, access: row.access, storageKind: 'embedded', contentType: row.content_type, title: row.title };
  }
  const downloadUrl = await presignGet(env, row.object_key!, now);
  return { ok: true, access: row.access, storageKind: 'filebase', contentType: row.content_type, title: row.title, downloadUrl };
}
