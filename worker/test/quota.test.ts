// worker/test/quota.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { capFor, currentUsage, checkQuota, recordLedger, CAP_ANON, MAX_FILE } from '../src/quota';

describe('quota', () => {
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

  it('picks caps by login state', () => {
    expect(capFor(false)).toBe(CAP_ANON);
    expect(capFor(true)).toBe(700 * 1024 * 1024);
  });

  it('sums usage per owner', async () => {
    await recordLedger(env.DB, 'owner-a', 'k1', 100, Date.now() + 1000);
    await recordLedger(env.DB, 'owner-a', 'k2', 50, Date.now() + 1000);
    await recordLedger(env.DB, 'owner-b', 'k3', 999, Date.now() + 1000);
    expect(await currentUsage(env.DB, 'owner-a')).toBe(150);
  });

  it('rejects single files over the hard cap', async () => {
    const r = await checkQuota(env.DB, 'owner-c', false, MAX_FILE + 1);
    expect(r.ok).toBe(false);
  });

  it('rejects when usage + new exceeds cap', async () => {
    await recordLedger(env.DB, 'owner-d', 'k', CAP_ANON - 10, Date.now() + 1000);
    expect((await checkQuota(env.DB, 'owner-d', false, 20)).ok).toBe(false);
    expect((await checkQuota(env.DB, 'owner-d', false, 5)).ok).toBe(true);
  });
});
