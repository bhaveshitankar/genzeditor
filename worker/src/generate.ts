// worker/src/generate.ts
// Free-tier-friendly generation: image, audio (TTS), image description,
// interior design from photos, and video storyboards. All run on Workers AI
// (free 10k neurons/day account-wide), metered per user in weighted "units".
import type { Env } from './env';
import { extractJson } from './ai';

export type GenKind = 'image' | 'audio' | 'describe' | 'interior' | 'storyboard';

// Weighted daily budget per user. Tuned so the account-wide 10k-neuron/day
// free allowance stretches across many users (1 unit ~ <= 25 neurons).
export const DAILY_UNITS = 60;
export const COST = { image: 4, audio: 2, describe: 3, interiorBase: 3, interiorVariant: 5, storyboard: 3, storyboardFrame: 4 };

export const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 1_500_000; // per data URL (~1.1 MB binary)
const MAX_TOTAL_CHARS = 4_500_000;

export const M_IMAGE = '@cf/black-forest-labs/flux-1-schnell';
export const M_IMG2IMG = '@cf/runwayml/stable-diffusion-v1-5-img2img';
export const M_TTS = '@cf/myshell-ai/melotts';
export const M_VISION = '@cf/meta/llama-3.2-11b-vision-instruct';
export const M_TEXT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export class GenError extends Error {
  constructor(public code: string, public status = 400) { super(code); }
}

// Weighted metering on the shared rate_limits table (count += cost).
export async function chargeUnits(
  db: D1Database, owner: string, cost: number, limit = DAILY_UNITS, now = Date.now(),
): Promise<{ ok: boolean; used: number; limit: number }> {
  const bucket = 'gen_units';
  const win = 86_400_000;
  const row = await db.prepare('SELECT window_start, count FROM rate_limits WHERE ip_hash = ? AND bucket = ?')
    .bind(owner, bucket).first<{ window_start: number; count: number }>();
  if (!row || now - row.window_start >= win) {
    if (cost > limit) return { ok: false, used: 0, limit };
    await db.prepare(
      'INSERT INTO rate_limits (ip_hash, bucket, window_start, count) VALUES (?,?,?,?) ' +
      'ON CONFLICT(ip_hash, bucket) DO UPDATE SET window_start = excluded.window_start, count = excluded.count',
    ).bind(owner, bucket, now, cost).run();
    return { ok: true, used: cost, limit };
  }
  if (row.count + cost > limit) return { ok: false, used: row.count, limit };
  await db.prepare('UPDATE rate_limits SET count = count + ? WHERE ip_hash = ? AND bucket = ?')
    .bind(cost, owner, bucket).run();
  return { ok: true, used: row.count + cost, limit };
}

export function costFor(kind: GenKind, p: GenParams): number {
  const n = clampInt(p.variants, 1, 3, 2);
  switch (kind) {
    case 'image': return COST.image;
    case 'audio': return COST.audio;
    case 'describe': return COST.describe;
    case 'interior': return COST.interiorBase + COST.interiorVariant * n;
    case 'storyboard': return COST.storyboard + (p.frames ? COST.storyboardFrame * clampInt(p.scenes, 1, 4, 3) : 0);
  }
}

export interface GenParams {
  prompt?: string;
  text?: string;       // audio
  lang?: string;       // audio
  images?: string[];   // data URLs (jpeg/png/webp)
  style?: string;      // interior
  roomType?: string;
  variants?: number;   // interior variants (1-3)
  scenes?: number;     // storyboard scenes
  frames?: boolean;    // storyboard: also render frames
  question?: string;   // describe
  width?: number; height?: number;
}

export interface GenResult {
  provider: 'workers-ai' | 'openai';
  [k: string]: unknown;
}

function clampInt(v: unknown, lo: number, hi: number, d: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

// ---- helpers -------------------------------------------------------------

export function validateImages(images: unknown, required: boolean): string[] {
  if (images == null && !required) return [];
  if (!Array.isArray(images) || (required && images.length === 0)) throw new GenError('images_required');
  if (images.length > MAX_IMAGES) throw new GenError('too_many_images');
  let total = 0;
  for (const im of images) {
    if (typeof im !== 'string' || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(im)) throw new GenError('bad_image');
    if (im.length > MAX_IMAGE_CHARS) throw new GenError('image_too_large', 413);
    total += im.length;
  }
  if (total > MAX_TOTAL_CHARS) throw new GenError('image_too_large', 413);
  return images as string[];
}

export function dataUrlBytes(url: string): Uint8Array {
  const b64 = url.slice(url.indexOf(',') + 1);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Workers AI image models return {image: base64} or a binary stream.
async function imageOut(r: unknown): Promise<string> {
  if (r && typeof r === 'object' && 'image' in r && typeof (r as { image: unknown }).image === 'string') {
    return `data:image/png;base64,${(r as { image: string }).image}`;
  }
  let buf: ArrayBuffer | null = null;
  if (r instanceof ReadableStream) buf = await new Response(r).arrayBuffer();
  else if (r instanceof ArrayBuffer) buf = r;
  else if (r instanceof Uint8Array) buf = r.slice().buffer as ArrayBuffer;
  if (!buf) throw new GenError('model_empty', 502);
  return `data:image/png;base64,${bytesToBase64(new Uint8Array(buf))}`;
}

function cleanPrompt(p: unknown, max = 1000): string {
  const s = String(p ?? '').trim();
  if (!s) throw new GenError('prompt_required');
  return s.slice(0, max);
}

// ---- primitives ----------------------------------------------------------

export async function genImage(env: Env, prompt: string, byokKey?: string | null): Promise<{ provider: GenResult['provider']; image: string }> {
  if (byokKey && !byokKey.startsWith('sk-ant-')) {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${byokKey}` },
      body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024', n: 1 }),
    });
    if (!res.ok) throw new GenError(`openai_${res.status}`, 502);
    const d = (await res.json()) as { data?: { b64_json?: string }[] };
    const b = d.data?.[0]?.b64_json;
    if (!b) throw new GenError('model_empty', 502);
    return { provider: 'openai', image: `data:image/png;base64,${b}` };
  }
  try {
    const r = await env.AI.run(M_IMAGE as never, { prompt, steps: 4 } as never);
    return { provider: 'workers-ai', image: await imageOut(r) };
  } catch (e) {
    if (e instanceof GenError) throw e;
    throw new GenError('image_failed', 502);
  }
}

export async function genAudio(env: Env, text: string, lang = 'en'): Promise<{ provider: 'workers-ai'; audio: string; mime: string }> {
  try {
    const r = (await env.AI.run(M_TTS as never, { prompt: text, lang } as never)) as { audio?: string } | string;
    const audio = typeof r === 'string' ? r : r?.audio;
    if (!audio) throw new GenError('model_empty', 502);
    return { provider: 'workers-ai', audio: `data:audio/mpeg;base64,${audio}`, mime: 'audio/mpeg' };
  } catch (e) {
    if (e instanceof GenError) throw e;
    throw new GenError('audio_failed', 502);
  }
}

export async function describeImages(env: Env, images: string[], question?: string): Promise<string> {
  const q = (question || 'Describe this room: type, approximate size, layout, furniture, colours, materials, lighting and style.').slice(0, 500);
  const parts: string[] = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const r = (await env.AI.run(M_VISION as never, {
        messages: [{ role: 'user', content: [{ type: 'text', text: q }, { type: 'image_url', image_url: { url: images[i] } }] }],
        max_tokens: 400,
      } as never)) as { response?: string };
      if (r?.response) parts.push(images.length > 1 ? `Image ${i + 1}: ${r.response}` : r.response);
    } catch { /* skip failed frame */ }
  }
  if (!parts.length) throw new GenError('vision_failed', 502);
  return parts.join('\n\n');
}

async function llmJson(env: Env, system: string, user: string): Promise<unknown> {
  try {
    const r = (await env.AI.run(M_TEXT as never, {
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      max_tokens: 1200,
    } as never)) as { response?: unknown };
    const raw = typeof r?.response === 'string' ? r.response : JSON.stringify(r?.response ?? '');
    return extractJson(raw);
  } catch {
    throw new GenError('llm_failed', 502);
  }
}

// ---- interior design -----------------------------------------------------

// Mirrors src/editors/floorplan/catalog.ts (id -> w,d,h,color).
const CATALOG: Record<string, [number, number, number, string]> = {
  sofa: [2.0, 0.9, 0.8, '#6b7fd7'], armchair: [0.9, 0.9, 0.8, '#7e8cd9'], 'coffee-table': [1.1, 0.6, 0.45, '#b08968'],
  'tv-unit': [1.8, 0.4, 0.5, '#4b5563'], rug: [2.4, 1.6, 0.02, '#c084fc'], plant: [0.5, 0.5, 1.2, '#4caf50'],
  'bed-double': [1.6, 2.0, 0.5, '#e6a4b4'], 'bed-single': [0.9, 2.0, 0.5, '#eab8c4'], wardrobe: [1.5, 0.6, 2.1, '#8d6e63'],
  nightstand: [0.45, 0.4, 0.5, '#a1887f'], dresser: [1.2, 0.5, 0.8, '#9c7a68'], counter: [2.0, 0.6, 0.9, '#cbd5e1'],
  fridge: [0.7, 0.7, 1.8, '#e2e8f0'], stove: [0.6, 0.6, 0.9, '#94a3b8'], sink: [0.8, 0.6, 0.9, '#b0bec5'],
  'dining-table': [1.6, 0.9, 0.75, '#b08968'], chair: [0.45, 0.45, 0.9, '#8d6e63'], toilet: [0.4, 0.7, 0.8, '#eceff1'],
  bathtub: [1.7, 0.75, 0.6, '#e0f2fe'], shower: [0.9, 0.9, 2.0, '#bae6fd'], basin: [0.6, 0.45, 0.85, '#eceff1'],
  desk: [1.4, 0.7, 0.75, '#a1887f'], 'office-chair': [0.6, 0.6, 1.1, '#4b5563'], bookshelf: [1.0, 0.35, 1.9, '#8d6e63'],
};

const STYLES = ['modern minimalist', 'scandinavian', 'industrial loft', 'bohemian', 'mid-century modern', 'japandi'];

export interface RoomLayout { widthM: number; depthM: number; furniture: { catalogId: string; x: number; y: number; rotation: number; color?: string }[] }

// Turn (possibly sloppy) LLM output into a safe FloorPlan document JSON.
export function buildFloorPlan(title: string, raw: unknown): { plan: Record<string, unknown>; layout: RoomLayout } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const widthM = Math.min(15, Math.max(2, Number(o.widthM) || 4));
  const depthM = Math.min(15, Math.max(2, Number(o.depthM) || 3.5));
  const items = Array.isArray(o.furniture) ? o.furniture.slice(0, 30) : [];
  const furniture: RoomLayout['furniture'] = [];
  const placements = items.flatMap((it, i) => {
    const f = it as Record<string, unknown>;
    const cat = CATALOG[String(f.catalogId)];
    if (!cat) return [];
    const rotation = [0, 90, 180, 270].includes(Number(f.rotation)) ? Number(f.rotation) : 0;
    const [w, d, h, defColor] = cat;
    const rotated = rotation === 90 || rotation === 270;
    const hw = (rotated ? d : w) / 2, hd = (rotated ? w : d) / 2;
    const x = Math.min(widthM - hw, Math.max(hw, Number(f.x) || widthM / 2));
    const y = Math.min(depthM - hd, Math.max(hd, Number(f.y) || depthM / 2));
    const color = typeof f.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(f.color) ? f.color : defColor;
    furniture.push({ catalogId: String(f.catalogId), x, y, rotation, color });
    return [{ id: `ai${i}`, catalogId: String(f.catalogId), x, y, rotation, w, d, h, color }];
  });
  const wall = (id: string, x1: number, y1: number, x2: number, y2: number) =>
    ({ id, x1, y1, x2, y2, thickness: 0.12, height: 2.7 });
  const plan = {
    type: 'genzeditor-floorplan', version: 1, meta: { title, unit: 'm' },
    settings: { wallHeight: 2.7, wallThickness: 0.12, gridSize: 0.5 },
    walls: [wall('w1', 0, 0, widthM, 0), wall('w2', widthM, 0, widthM, depthM), wall('w3', widthM, depthM, 0, depthM), wall('w4', 0, depthM, 0, 0)],
    furniture: placements,
  };
  return { plan, layout: { widthM, depthM, furniture } };
}

const LAYOUT_SYSTEM =
  'You are an interior designer. From the room description, estimate the room and propose a furniture layout. ' +
  'Reply with ONLY JSON: {"widthM":number,"depthM":number,"roomType":string,"furniture":[{"catalogId":string,"x":number,"y":number,"rotation":0|90|180|270}],"palette":[hex colours],"notes":string}. ' +
  'x,y are the item centre in metres from the top-left corner. Use only these catalogId values: ' + Object.keys(CATALOG).join(', ') + '.';

export async function designInterior(env: Env, p: GenParams): Promise<GenResult> {
  const images = validateImages(p.images, true);
  const style = String(p.style || STYLES[0]).slice(0, 80);
  const n = clampInt(p.variants, 1, 3, 2);
  const description = await describeImages(env, images);
  const layoutRaw = await llmJson(env, LAYOUT_SYSTEM,
    `Room description:\n${description}\n\nTarget style: ${style}. Room type hint: ${String(p.roomType || 'any').slice(0, 40)}.`);
  const { plan, layout } = buildFloorPlan(`${style} room`, layoutRaw);
  const palette = Array.isArray((layoutRaw as { palette?: unknown })?.palette) ? ((layoutRaw as { palette: unknown[] }).palette.filter((c) => typeof c === 'string').slice(0, 6)) : [];

  const styles = [style, ...STYLES.filter((s) => s !== style)].slice(0, n);
  const variants: { style: string; image: string | null; prompt: string; mode: 'img2img' | 'text2img' }[] = [];
  for (const s of styles) {
    const prompt = `Interior design photo of a ${p.roomType || 'room'}, ${s} style, ${description.slice(0, 350)}. Photorealistic, natural light, high detail.`;
    let image: string | null = null;
    let mode: 'img2img' | 'text2img' = 'img2img';
    try {
      const r = await env.AI.run(M_IMG2IMG as never, {
        prompt, image: [...dataUrlBytes(images[0]!)], strength: 0.7, num_steps: 20, guidance: 7.5,
      } as never);
      image = await imageOut(r);
    } catch {
      mode = 'text2img';
      try { image = (await genImage(env, prompt)).image; } catch { image = null; }
    }
    variants.push({ style: s, image, prompt, mode });
  }
  return { provider: 'workers-ai', description, style, palette, layout, floorplan: plan, floorplanText: JSON.stringify(plan), variants };
}

// ---- storyboard ----------------------------------------------------------

export async function storyboard(env: Env, p: GenParams): Promise<GenResult> {
  const idea = cleanPrompt(p.prompt);
  const n = clampInt(p.scenes, 1, 4, 3);
  const raw = (await llmJson(env,
    'You write short video storyboards. Reply with ONLY JSON: {"title":string,"scenes":[{"prompt":string,"narration":string,"durationSec":number,"motion":"zoom-in"|"zoom-out"|"pan-left"|"pan-right"}]}. ' +
    `Exactly ${n} scenes; each prompt is a vivid image-generation prompt; durationSec 2-6.`, idea)) as { title?: string; scenes?: Record<string, unknown>[] };
  const scenes = (Array.isArray(raw?.scenes) ? raw.scenes : []).slice(0, n).map((s) => ({
    prompt: String(s.prompt ?? '').slice(0, 600),
    narration: String(s.narration ?? '').slice(0, 400),
    durationSec: Math.min(6, Math.max(2, Number(s.durationSec) || 3)),
    motion: ['zoom-in', 'zoom-out', 'pan-left', 'pan-right'].includes(String(s.motion)) ? String(s.motion) : 'zoom-in',
    image: null as string | null,
  })).filter((s) => s.prompt);
  if (!scenes.length) throw new GenError('llm_failed', 502);
  if (p.frames) for (const s of scenes) { try { s.image = (await genImage(env, s.prompt)).image; } catch { /* leave null */ } }
  return {
    provider: 'workers-ai', title: String(raw?.title ?? 'Storyboard').slice(0, 100), scenes,
    note: 'Text-to-video has no free provider. Assemble frames client-side as a Ken-Burns slideshow (canvas/ffmpeg.wasm) with the narration TTS.',
  };
}

// ---- dispatcher ----------------------------------------------------------

export async function runGenerate(env: Env, kind: GenKind, p: GenParams, byokKey?: string | null): Promise<GenResult> {
  switch (kind) {
    case 'image': { const r = await genImage(env, cleanPrompt(p.prompt), byokKey); return { ...r }; }
    case 'audio': { return { ...(await genAudio(env, cleanPrompt(p.text ?? p.prompt, 1500), String(p.lang || 'en').slice(0, 5))) }; }
    case 'describe': { const imgs = validateImages(p.images, true); return { provider: 'workers-ai', description: await describeImages(env, imgs, p.question) }; }
    case 'interior': return designInterior(env, p);
    case 'storyboard': return storyboard(env, p);
    default: throw new GenError('bad_kind');
  }
}

export function isGenKind(k: unknown): k is GenKind {
  return k === 'image' || k === 'audio' || k === 'describe' || k === 'interior' || k === 'storyboard';
}
