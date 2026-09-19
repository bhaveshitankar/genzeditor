// worker/test/retention.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { sweepExpired } from '../src/retention';
import { currentUsage } from '../src/quota';

describe('sweepExpired', () => {
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

  it('deletes expired shares, ledger rows, and objects; frees quota', async () => {
    const past = 1000;
    const future = 10_000_000_000_000;
    await env.DB.prepare(
      'INSERT INTO shares (id, token_hash, owner_ref, access, storage_kind, object_key, size_bytes, content_type, title, created_at, expires_at, revoked) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)',
    ).bind('sh1', 'h1', 'ownerR', 'ro', 'filebase', 'snapshots/ownerR/sh1', 500, 'image/png', 't', 0, past).run();
    await env.DB.prepare(
      'INSERT INTO shares (id, token_hash, owner_ref, access, storage_kind, object_key, size_bytes, content_type, title, created_at, expires_at, revoked) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)',
    ).bind('sh2', 'h2', 'ownerR', 'ro', 'filebase', 'snapshots/ownerR/sh2', 300, 'image/png', 't', 0, future).run();
    await env.DB.prepare(
      'INSERT INTO quota_ledger (id, owner_ref, object_key, size_bytes, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    ).bind('l1', 'ownerR', 'snapshots/ownerR/sh1', 500, 0, past).run();
    await env.DB.prepare(
      'INSERT INTO quota_ledger (id, owner_ref, object_key, size_bytes, created_at, expires_at) VALUES (?,?,?,?,?,?)',
    ).bind('l2', 'ownerR', 'snapshots/ownerR/sh2', 300, 0, future).run();

    const deleted: string[] = [];
    const res = await sweepExpired(env, async (k) => { deleted.push(k); }, 5000);

    expect(res.deletedShares).toBe(1);
    expect(res.deletedLedger).toBe(1);
    expect(res.deletedObjects).toBe(1);
    expect(deleted).toEqual(['snapshots/ownerR/sh1']);
    expect(await currentUsage(env.DB, 'ownerR')).toBe(300); // freed the expired 500
  });
});
