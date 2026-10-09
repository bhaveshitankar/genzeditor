// worker/src/mcp.ts
// Minimal MCP server (Streamable HTTP, stateless JSON responses) at /mcp.
import type { Env } from './env';
import { chargeUnits, costFor, runGenerate, GenError, type GenKind, type GenParams } from './generate';

const PROTOCOL = '2025-03-26';

const imagesProp = { type: 'array', maxItems: 4, items: { type: 'string', description: 'data:image/(jpeg|png|webp);base64,... (<=1.1MB each; downscale to ~768px)' } };

export const TOOLS = [
  { name: 'generate_image', description: 'Generate an image from a text prompt (FLUX.1 schnell). Returns a PNG data URL.',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] } },
  { name: 'generate_audio', description: 'Text-to-speech (MeloTTS). Returns an MP3 data URL.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, lang: { type: 'string', default: 'en' } }, required: ['text'] } },
  { name: 'describe_images', description: 'Describe up to 4 images (e.g. room photos or video frames) with a vision model.',
    inputSchema: { type: 'object', properties: { images: imagesProp, question: { type: 'string' } }, required: ['images'] } },
  { name: 'design_interior', description: 'Interior design from room photos/video frames: description, restyled renders per style, and a .floorplan JSON the Interior Designer can import.',
    inputSchema: { type: 'object', properties: { images: imagesProp, style: { type: 'string' }, roomType: { type: 'string' }, variants: { type: 'integer', minimum: 1, maximum: 3 } }, required: ['images'] } },
  { name: 'storyboard_video', description: 'Plan a short video as scenes (prompt, narration, duration, motion); optionally render frames. Assemble as a slideshow client-side (no free text-to-video).',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' }, scenes: { type: 'integer', minimum: 1, maximum: 4 }, frames: { type: 'boolean' } }, required: ['prompt'] } },
] as const;

const TOOL_KIND: Record<string, GenKind> = {
  generate_image: 'image', generate_audio: 'audio', describe_images: 'describe',
  design_interior: 'interior', storyboard_video: 'storyboard',
};

export interface McpCaller { owner: string }

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

const ok = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const err = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

export async function mcpDispatch(env: Env, msg: Rpc, caller: McpCaller): Promise<unknown | null> {
  const { id, method } = msg;
  if (id === undefined) return null; // notification
  switch (method) {
    case 'initialize':
      return ok(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'genzeditor', version: '1.0.0' },
        instructions: 'Free-tier generation; each call consumes weighted daily units.' });
    case 'ping': return ok(id, {});
    case 'tools/list': return ok(id, { tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const kind = TOOL_KIND[name];
      if (!kind) return err(id, -32602, `Unknown tool: ${name}`);
      const args = (msg.params?.arguments ?? {}) as GenParams;
      const cost = costFor(kind, args);
      try {
        const q = await chargeUnits(env.DB, caller.owner, cost);
        if (!q.ok) return ok(id, { isError: true, content: [{ type: 'text', text: `daily_limit: ${q.used}/${q.limit} units used` }] });
        const result = await runGenerate(env, kind, args);
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result });
      } catch (e) {
        const code = e instanceof GenError ? e.code : 'generation_failed';
        return ok(id, { isError: true, content: [{ type: 'text', text: code }] });
      }
    }
    default: return err(id, -32601, `Method not found: ${method}`);
  }
}

export async function mcpHandle(body: unknown, env: Env, caller: McpCaller): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => mcpDispatch(env, m as Rpc, caller)))).filter((r) => r !== null);
    return out.length ? out : null;
  }
  if (!body || typeof body !== 'object') return err(null, -32600, 'Invalid Request');
  return mcpDispatch(env, body as Rpc, caller);
}

// API keys: env.MCP_API_KEYS = "name:secret,name2:secret2". Returns owner ref.
export function mcpKeyOwner(env: Env, authHeader: string | null): string | null {
  const m = authHeader?.match(/^Bearer\s+(.+)$/i);
  if (!m || !env.MCP_API_KEYS) return null;
  for (const entry of env.MCP_API_KEYS.split(',')) {
    const i = entry.indexOf(':');
    if (i > 0 && entry.slice(i + 1).trim() === m[1]!.trim()) return `mcp:${entry.slice(0, i).trim()}`;
  }
  return null;
}
