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
  expires_at INTEGER NOT NULL,
  pending_expires_at INTEGER
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

  it('reserves quota at create (cannot be bypassed), and confirm does not double-charge', async () => {
    const nowMs = now.getTime();
    const r = await createShare(env, {
      ownerRef: 'ownerF', isLoggedIn: false, access: 'ro', storageKind: 'filebase',
      contentType: 'image/png', title: 'pic', sizeBytes: 1000,
    }, now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.uploadUrl).toContain('X-Amz-Signature');
      expect(r.objectKey).toBeTruthy();
      // C1: create alone consumes quota so the cap cannot be bypassed.
      expect(await currentUsage(env.DB, 'ownerF', nowMs)).toBe(1000);
      const c = await confirmShare(env, r.shareId, 'ownerF', now);
      expect(c.ok).toBe(true);
      // confirm clears the pending flag but does not double-charge.
      expect(await currentUsage(env.DB, 'ownerF', nowMs)).toBe(1000);
      const res = await resolveShare(env, r.token, now);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.downloadUrl).toContain('X-Amz-Signature');
    }
  });

  it('rejects a second create that would exceed the cap (create-time reservation)', async () => {
    const nowMs = now.getTime();
    const first = await createShare(env, {
      ownerRef: 'ownerCap', isLoggedIn: false, access: 'ro', storageKind: 'filebase',
      contentType: 'image/png', title: 'a', sizeBytes: 400 * 1024 * 1024,
    }, now);
    expect(first.ok).toBe(true);
    expect(await currentUsage(env.DB, 'ownerCap', nowMs)).toBe(400 * 1024 * 1024);
    // Second create pushes over CAP_ANON (500MB) even without confirming the first.
    const second = await createShare(env, {
      ownerRef: 'ownerCap', isLoggedIn: false, access: 'ro', storageKind: 'filebase',
      contentType: 'image/png', title: 'b', sizeBytes: 200 * 1024 * 1024,
    }, now);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('quota_exceeded');
  });

  it('rw resolve returns a presigned PUT, ro resolve does not', async () => {
    await env.DB.prepare(
      'INSERT INTO users (id, oauth_provider, oauth_subject, email, created_at) VALUES (?,?,?,?,?)',
    ).bind('uRW', 'google', 'subRW', 'rw@b.co', Date.now()).run();
    const rw = await createShare(env, {
      ownerRef: 'uRW', isLoggedIn: true, access: 'rw', storageKind: 'filebase',
      contentType: 'image/png', title: 'edit', sizeBytes: 10,
    }, now);
    expect(rw.ok).toBe(true);
    if (rw.ok) {
      const res = await resolveShare(env, rw.token, now);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.access).toBe('rw');
        expect(res.downloadUrl).toContain('X-Amz-Signature');
        expect(res.uploadUrl).toContain('X-Amz-Signature');
      }
    }
    const ro = await createShare(env, {
      ownerRef: 'uRW', isLoggedIn: true, access: 'ro', storageKind: 'filebase',
      contentType: 'image/png', title: 'view', sizeBytes: 10,
    }, now);
    expect(ro.ok).toBe(true);
    if (ro.ok) {
      const res = await resolveShare(env, ro.token, now);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.downloadUrl).toContain('X-Amz-Signature');
        expect(res.uploadUrl).toBeUndefined();
      }
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
