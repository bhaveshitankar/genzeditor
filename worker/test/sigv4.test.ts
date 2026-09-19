// worker/test/sigv4.test.ts
import { describe, it, expect } from 'vitest';
import { presignS3 } from '../src/sigv4';

const base = {
  endpoint: 'https://s3.filebase.io',
  region: 'us-east-1',
  bucket: 'anyedits-test',
  key: 'snapshots/abc.png',
  accessKey: 'AKIATEST',
  secretKey: 'testsecret',
  expiresSeconds: 60,
  now: new Date('2026-09-19T00:00:00Z'),
} as const;

describe('presignS3', () => {
  it('produces a deterministic, well-formed presigned PUT URL', async () => {
    const url = await presignS3({ method: 'PUT', contentLength: 1234, ...base });
    const u = new URL(url);
    expect(u.origin).toBe('https://s3.filebase.io');
    expect(u.pathname).toBe('/anyedits-test/snapshots/abc.png');
    expect(u.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(u.searchParams.get('X-Amz-Expires')).toBe('60');
    expect(u.searchParams.get('X-Amz-Date')).toBe('20260919T000000Z');
    expect(u.searchParams.get('X-Amz-Credential')).toContain('20260919/us-east-1/s3/aws4_request');
    // content-length is a signed header for PUT
    expect(u.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
    expect(u.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is reproducible for identical inputs', async () => {
    const a = await presignS3({ method: 'GET', ...base });
    const b = await presignS3({ method: 'GET', ...base });
    expect(a).toBe(b);
  });

  it('GET does not sign content-length', async () => {
    const url = await presignS3({ method: 'GET', ...base });
    expect(new URL(url).searchParams.get('X-Amz-SignedHeaders')).toBe('host');
  });
});
