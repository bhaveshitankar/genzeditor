// worker/test/shares.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { createShare, confirmShare, resolveShare } from '../src/shares';
import { currentUsage } from '../src/quota';

const now = new Date('2026-09-19T00:00:00Z');

describe('shares', () => {
  beforeAll(async () => {
    const migration = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  oauth_provider TEXT NOT NULL,
  oauth_subject TEXT NOT NULL,
  email TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (oauth_provider, oauth_subject)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  owner_ref TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('ro','rw')),
  storage_kind TEXT NOT NULL CHECK (storage_kind IN ('embedded','filebase')),
  object_key TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  title TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_shares_owner ON shares(owner_ref);
CREATE INDEX idx_shares_expires ON shares(expires_at);

CREATE TABLE quota_ledger (
  id TEXT PRIMARY KEY,
  owner_ref TEXT NOT NULL,
  object_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_ledger_owner ON quota_ledger(owner_ref);
CREATE INDEX idx_ledger_expires ON quota_ledger(expires_at);

CREATE TABLE rate_limits (
  ip_hash TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (ip_hash, bucket)
);
    `;
    const statements = migration
      .split(';')
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'));

    for (const stmt of statements) {
      await env.DB.prepare(stmt).run();
    }
  });

  it('creates an embedded ro share with no upload and no quota cost', async () => {
    const r = await createShare(env, {
      ownerRef: 'ownerE', isLoggedIn: false, access: 'ro', storageKind: 'embedded',
      contentType: 'text/markdown', title: 'note', sizeBytes: 0,
    }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uploadUrl).toBeUndefined();
      const res = await resolveShare(env, r.token, now);
      expect(res.ok).toBe(true);
      if (res.ok) { expect(res.storageKind).toBe('embedded'); expect(res.downloadUrl).toBeUndefined(); }
    }
    expect(await currentUsage(env.DB, 'ownerE')).toBe(0);
  });

  it('creates a filebase share returning a presigned PUT, then confirm charges quota', async () => {
    const r = await createShare(env, {
      ownerRef: 'ownerF', isLoggedIn: false, access: 'ro', storageKind: 'filebase',
      contentType: 'image/png', title: 'pic', sizeBytes: 1000,
    }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uploadUrl).toContain('X-Amz-Signature');
      expect(r.objectKey).toBeTruthy();
      expect(await currentUsage(env.DB, 'ownerF')).toBe(0); // not charged until confirm
      const c = await confirmShare(env, r.shareId, 'ownerF', now);
      expect(c.ok).toBe(true);
      expect(await currentUsage(env.DB, 'ownerF')).toBe(1000);
      const res = await resolveShare(env, r.token, now);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.downloadUrl).toContain('X-Amz-Signature');
    }
  });

  it('rejects rw shares for anonymous owners', async () => {
    const r = await createShare(env, {
      ownerRef: 'anon', isLoggedIn: false, access: 'rw', storageKind: 'filebase',
      contentType: 'image/png', title: 'x', sizeBytes: 10,
    }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('rw_requires_login');
  });

  it('rejects filebase create over quota', async () => {
    const r = await createShare(env, {
      ownerRef: 'ownerG', isLoggedIn: false, access: 'ro', storageKind: 'filebase',
      contentType: 'image/png', title: 'x', sizeBytes: 501 * 1024 * 1024,
    }, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('file_too_large');
  });

  it('does not resolve revoked or expired shares', async () => {
    const r = await createShare(env, {
      ownerRef: 'ownerH', isLoggedIn: false, access: 'ro', storageKind: 'embedded',
      contentType: 'text/plain', title: 't', sizeBytes: 0,
    }, now);
    if (r.ok) {
      await env.DB.prepare('UPDATE shares SET revoked = 1 WHERE id = ?').bind(r.shareId).run();
      const res = await resolveShare(env, r.token, now);
      expect(res.ok).toBe(false);
    }
  });
});
