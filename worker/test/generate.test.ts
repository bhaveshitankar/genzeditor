// worker/test/generate.test.ts
import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll } from 'vitest';
import { chargeUnits, costFor, buildFloorPlan, validateImages, runGenerate, GenError } from '../src/generate';
import { mcpHandle, mcpKeyOwner, TOOLS } from '../src/mcp';
import type { Env } from '../src/env';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function fakeEnv(): Env {
  const ai = {
    run: async (model: string, input: Record<string, unknown>) => {
      if (model.includes('flux')) return { image: 'AAAA' };
      if (model.includes('melotts')) return { audio: 'BBBB' };
      if (model.includes('vision')) return { response: 'A small living room with a grey sofa.' };
      if (model.includes('img2img')) return new Response(new Uint8Array([1, 2, 3])).body;
      if (model.includes('llama-3.3')) {
        const sys = JSON.stringify(input);
        if (sys.includes('storyboards')) return { response: '{"title":"T","scenes":[{"prompt":"a","narration":"n","durationSec":3,"motion":"zoom-in"}]}' };
        return { response: '```json\n{"widthM":5,"depthM":4,"furniture":[{"catalogId":"sofa","x":99,"y":1,"rotation":90},{"catalogId":"bogus","x":1,"y":1}]}\n```' };
      }
      throw new Error('unexpected ' + model);
    },
  };
  return { ...env, AI: ai } as unknown as Env;
}

describe('generate', () => {
  beforeAll(async () => {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS rate_limits (ip_hash TEXT NOT NULL, bucket TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (ip_hash, bucket))').run();
  });

  it('meters weighted units and blocks past the daily cap', async () => {
    expect((await chargeUnits(env.DB, 'u1', 30, 60)).ok).toBe(true);
    expect((await chargeUnits(env.DB, 'u1', 30, 60)).ok).toBe(true);
    const r = await chargeUnits(env.DB, 'u1', 1, 60);
    expect(r.ok).toBe(false);
    expect(r.used).toBe(60);
    // window rollover resets
    expect((await chargeUnits(env.DB, 'u1', 5, 60, Date.now() + 86_400_001)).ok).toBe(true);
  });

  it('prices interior by variant count', () => {
    expect(costFor('interior', { variants: 1 })).toBeLessThan(costFor('interior', { variants: 3 }));
    expect(costFor('audio', {})).toBeLessThan(costFor('image', {}));
  });

  it('validates image inputs', () => {
    expect(validateImages([PNG], true)).toHaveLength(1);
    expect(() => validateImages([], true)).toThrow(GenError);
    expect(() => validateImages([PNG, PNG, PNG, PNG, PNG], true)).toThrow('too_many_images');
    expect(() => validateImages(['http://x/y.png'], true)).toThrow('bad_image');
  });

  it('builds a safe floorplan: drops unknown items, clamps inside walls', () => {
    const { plan } = buildFloorPlan('t', { widthM: 5, depthM: 4, furniture: [{ catalogId: 'sofa', x: 99, y: 1, rotation: 90 }, { catalogId: 'bogus' }] });
    const f = plan.furniture as { x: number; y: number }[];
    expect(f).toHaveLength(1);
    expect(f[0]!.x).toBeLessThanOrEqual(5);
    expect(f[0]!.y).toBeGreaterThanOrEqual(1);
    expect(plan.walls as unknown[]).toHaveLength(4);
  });

  it('designs an interior from photos', async () => {
    const r = await runGenerate(fakeEnv(), 'interior', { images: [PNG], variants: 2 });
    expect((r.variants as unknown[]).length).toBe(2);
    expect((r.variants as { image: string }[])[0]!.image).toMatch(/^data:image\/png/);
    expect(JSON.parse(r.floorplanText as string).type).toBe('genzeditor-floorplan');
  });

  it('generates image, audio and storyboard', async () => {
    const e = fakeEnv();
    expect((await runGenerate(e, 'image', { prompt: 'cat' })).image).toBe('data:image/png;base64,AAAA');
    expect((await runGenerate(e, 'audio', { text: 'hi' })).audio).toContain('BBBB');
    expect(((await runGenerate(e, 'storyboard', { prompt: 'ad' })).scenes as unknown[]).length).toBe(1);
    await expect(runGenerate(e, 'image', {})).rejects.toThrow('prompt_required');
  });
});

describe('mcp', () => {
  const caller = { owner: 'mcp-test' };
  it('lists the five tools', async () => {
    const r = (await mcpHandle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, fakeEnv(), caller)) as { result: { tools: unknown[] } };
    expect(r.result.tools).toHaveLength(TOOLS.length);
  });
  it('initializes and ignores notifications', async () => {
    const e = fakeEnv();
    const r = (await mcpHandle({ jsonrpc: '2.0', id: 1, method: 'initialize' }, e, caller)) as { result: { serverInfo: { name: string } } };
    expect(r.result.serverInfo.name).toBe('genzeditor');
    expect(await mcpHandle({ jsonrpc: '2.0', method: 'notifications/initialized' }, e, caller)).toBeNull();
  });
  it('calls a tool and reports errors as isError', async () => {
    const e = fakeEnv();
    const ok = (await mcpHandle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_image', arguments: { prompt: 'x' } } }, e, { owner: 'mcp-a' })) as { result: { isError?: boolean; structuredContent: { image: string } } };
    expect(JSON.stringify(ok.result)).toContain('AAAA'); expect(ok.result.structuredContent.image).toContain('AAAA');
    const bad = (await mcpHandle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_image', arguments: {} } }, e, { owner: 'mcp-a' })) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
  });
  it('matches bearer API keys', () => {
    const e = { MCP_API_KEYS: 'bot:s3cret,x:other' } as Env;
    expect(mcpKeyOwner(e, 'Bearer s3cret')).toBe('mcp:bot');
    expect(mcpKeyOwner(e, 'Bearer nope')).toBeNull();
    expect(mcpKeyOwner({} as Env, 'Bearer s3cret')).toBeNull();
  });
});
