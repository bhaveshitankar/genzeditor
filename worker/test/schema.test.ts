// worker/test/schema.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';

describe('D1 schema', () => {
  beforeAll(async () => {
    const migration = `
CREATE TABLE user (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL DEFAULT 0, image TEXT,
  createdAt DATE NOT NULL, updatedAt DATE NOT NULL
);

CREATE TABLE auth_throttle (
  key TEXT PRIMARY KEY, strikes INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
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

  it('has all tables with expected columns', async () => {
    const cols = async (t: string) => {
      const r = await env.DB.prepare(`PRAGMA table_info(${t})`).all();
      return (r.results as Array<{ name: string }>).map((c) => c.name).sort();
    };
    expect(await cols('user')).toEqual(
      ['createdAt', 'email', 'emailVerified', 'id', 'image', 'name', 'updatedAt'].sort(),
    );
    expect(await cols('auth_throttle')).toEqual(
      ['blocked_until', 'key', 'strikes', 'updated_at'].sort(),
    );
    expect(await cols('shares')).toEqual(
      ['access', 'content_type', 'created_at', 'expires_at', 'id', 'object_key',
       'owner_ref', 'revoked', 'size_bytes', 'storage_kind', 'title', 'token_hash'].sort(),
    );
    expect(await cols('quota_ledger')).toEqual(
      ['created_at', 'expires_at', 'id', 'object_key', 'owner_ref', 'pending_expires_at', 'size_bytes'].sort(),
    );
    expect(await cols('rate_limits')).toEqual(
      ['bucket', 'count', 'ip_hash', 'window_start'].sort(),
    );
  });
});
