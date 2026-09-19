import { SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';

describe('worker smoke', () => {
  it('responds to GET /api/health', async () => {
    const res = await SELF.fetch('https://anyedits-aay.pages.dev/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
