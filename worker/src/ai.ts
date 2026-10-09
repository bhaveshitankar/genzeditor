// worker/src/ai.ts
// AI edit backend. Tiered provider routing:
//   1. BYOK  — caller supplies their own provider key (X-AI-Key). Unlimited,
//      bypasses the daily quota, called directly.
//   2. Workers AI — the free logged-in tier (quota-capped upstream of here).
//   3. Direct provider — server-side OpenAI/Anthropic fallback used only when
//      Workers AI errors/overloads, so the free tier stays resilient.
import type { Env } from './env';

export type AiKind =
  | 'text' | 'image' | 'video' | 'form'
  | 'docx' | 'spreadsheet' | 'pdf' | 'game' | 'floorplan' | 'sketch' | 'audio';

// Kinds whose model output is a JSON op list applied by the editor.
const OPS_KINDS = new Set<AiKind>(['image', 'video', 'pdf', 'game', 'sketch', 'audio']);
// Kinds that need valid JSON back but are applied as a document (returned as text).
const JSON_DOC_KINDS = new Set<AiKind>(['form', 'floorplan']);

export interface AiEditRequest {
  kind: AiKind;
  instruction: string;
  content?: string; // current document text (text/form kinds)
  meta?: Record<string, unknown>; // filename, language, dims, duration, etc.
}

export interface AiEditResult {
  provider: 'workers-ai' | 'openai' | 'anthropic';
  // text/form kinds return `text` (full replacement). image/video return `ops`.
  text?: string;
  ops?: unknown;
}

const CF_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const MAX_TOKENS = 2048;

// ---- Prompt construction -------------------------------------------------

// Whether the model must emit JSON (ops kinds + JSON-document kinds).
function wantsJson(kind: AiKind): boolean {
  return OPS_KINDS.has(kind) || JSON_DOC_KINDS.has(kind);
}

function systemPrompt(kind: AiKind, meta: Record<string, unknown> = {}): string {
  switch (kind) {
    case 'text':
      return [
        'You are an inline document editor inside a browser-based file editor.',
        `The document language/kind is: ${String(meta.language ?? 'plain text')}.`,
        'Apply the user\'s instruction to the CURRENT DOCUMENT and return ONLY the full',
        'updated document text. No markdown fences, no commentary, no explanation.',
        'Preserve the original formatting/indentation style where not told to change it.',
      ].join('\n');
    case 'form':
      return [
        'You fill structured data. Return ONLY a JSON object that is the complete',
        'updated document. Do not wrap it in prose or code fences.',
        'If the current content is JSON, keep the same schema and only change values',
        'the user asked for. Output must be valid JSON.',
      ].join('\n');
    case 'image':
      return [
        'You translate a natural-language image-editing request into a JSON op list',
        'for a canvas image editor. Return ONLY JSON of the form:',
        '{"ops":[{"op":"...","args":{...}}]}',
        'Allowed ops: "removeBackground" (no args), "crop" {x,y,w,h} (fractions 0..1),',
        '"rotate" {deg: 90|180|270}, "flip" {axis:"h"|"v"}, "resize" {maxDim:number},',
        '"adjust" {brightness?,contrast?,saturation?,exposure?,hue?,temperature?,',
        'grayscale?,sepia?,invert?,vignette?,sharpen?} (numbers, 0 = no change),',
        '"filter" {name:"Grayscale"|"Vintage"|"Dramatic"|"Fade"}.',
        `Image is ${String(meta.width ?? '?')}x${String(meta.height ?? '?')}px.`,
        'Only include ops the user actually requested. No commentary.',
      ].join('\n');
    case 'video':
      return [
        'You translate a natural-language video-editing request into a JSON patch',
        'for a non-destructive video editor. Return ONLY JSON of the form:',
        '{"patch":{...}} using only these keys: trimStart (sec), trimEnd (sec),',
        'mute (bool), speed (number), rotate (0|90|180|270), flipH (bool), flipV (bool),',
        'brightness, contrast, saturation (numbers, 0 = no change),',
        'outFmt ("mp4"|"webm"), text (string overlay).',
        `Video duration is ${String(meta.duration ?? '?')} seconds.`,
        'Only include keys the user actually requested. No commentary.',
      ].join('\n');
    case 'docx':
      return [
        'You edit a word-processing document represented as HTML.',
        'Apply the user\'s instruction to the CURRENT DOCUMENT (HTML) and return ONLY',
        'the full updated HTML body. Use simple tags only: <p>, <h1>-<h3>, <strong>,',
        '<em>, <u>, <ul>/<ol>/<li>, <br>. No <html>/<head>/<body> wrapper, no CSS,',
        'no code fences, no commentary.',
      ].join('\n');
    case 'spreadsheet':
      return [
        'You edit a spreadsheet. The CURRENT DOCUMENT is CSV (the active sheet).',
        'Apply the user\'s instruction and return ONLY the full updated sheet as CSV.',
        'Keep a header row if one is present. A cell beginning with "=" is a formula —',
        'preserve/produce formulas where appropriate. No code fences, no commentary.',
      ].join('\n');
    case 'pdf':
      return [
        'You add text annotations to a PDF (you cannot edit the original page text).',
        'Return ONLY JSON: {"annotations":[{"text":string,"page":number(1-based,optional),',
        '"x":0..1,"y":0..1,"size":number(optional)}]}. x/y are fractions of page',
        'width/height for the top-left of the text box. Only add what the user asked for.',
      ].join('\n');
    case 'game':
      return [
        'You edit a tile/entity game document via a JSON op list. Return ONLY JSON:',
        '{"ops":[...]} where each op is one of:',
        '{"t":"tile","i":number,"v":TileType} | {"t":"resize","cols":n,"rows":n,"tiles":[...]} |',
        '{"t":"entity.add","e":Entity} | {"t":"entity.move","id":string,"x":n,"y":n} |',
        '{"t":"entity.del","id":string} | {"t":"setting","k":string,"v":number} |',
        '{"t":"meta","title":string}.',
        `Current document: ${JSON.stringify(meta.doc ?? {}).slice(0, 1500)}.`,
        'Only include ops the user asked for. No commentary.',
      ].join('\n');
    case 'floorplan':
      return [
        'You edit a floor-plan JSON document. Return ONLY the complete updated JSON',
        'object, same schema as the CURRENT DOCUMENT (keys: settings{wallHeight,',
        'wallThickness,gridSize}, walls[], furniture[]). Keep existing ids stable.',
        'No code fences, no commentary.',
      ].join('\n');
    case 'sketch':
      return [
        'You edit an Excalidraw scene. Return ONLY JSON {"elements":[...]} — a complete',
        'Excalidraw elements array. Each element needs at least type, x, y, width, height,',
        'and a unique id. Preserve existing elements unless the user asks to change them.',
        'No commentary.',
      ].join('\n');
    case 'audio':
      return [
        'You translate a natural-language audio-editing request into a JSON op list.',
        'Return ONLY JSON {"ops":[...]} where each op is one of:',
        '{"t":"gain","mult":number} | {"t":"normalize"} | {"t":"fade","dir":"in"|"out"} |',
        '{"t":"reverse"} | {"t":"trim"} | {"t":"reverb","secs":number} |',
        '{"t":"echo","time":number} | {"t":"filter","kind":"lowpass"|"highpass","freq":number} |',
        '{"t":"speed","rate":number}. Only include ops the user asked for. No commentary.',
      ].join('\n');
  }
}

// ---- Provider calls ------------------------------------------------------

function stripFences(s: string): string {
  return String(s).trim().replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/,'').trim();
}

// Robustly pull a JSON value out of a model response that may wrap it in prose
// or code fences (Workers AI / Llama rarely returns bare JSON). Scans for the
// first balanced {...} or [...] block, respecting strings and escapes.
export function extractJson(raw: string): unknown {
  const s = stripFences(raw);
  try { return JSON.parse(s); } catch { /* fall through to scan */ }
  const start = s.search(/[[{]/);
  if (start === -1) throw new Error('ai_bad_json');
  const open = s[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { throw new Error('ai_bad_json'); }
      }
    }
  }
  throw new Error('ai_bad_json');
}

// ---- Tool (function-calling) definitions --------------------------------
// Each editable kind exposes ONE tool whose JSON-schema parameters match the
// exact op shape the client applies. Forcing the model to call this tool makes
// the provider validate the argument structure, so we get well-formed ops
// instead of hand-parsed freeform JSON (which Llama frequently mangled).

interface Tool { name: string; description: string; parameters: Record<string, unknown>; }

const anyArray = { type: 'array', items: { type: 'object' } };
function toolFor(kind: AiKind): Tool | null {
  switch (kind) {
    case 'image':
      return { name: 'edit_image', description: 'Apply image edits.', parameters: { type: 'object', properties: { ops: anyArray }, required: ['ops'] } };
    case 'video':
      return { name: 'edit_video', description: 'Apply a non-destructive video patch.', parameters: { type: 'object', properties: { patch: { type: 'object' } }, required: ['patch'] } };
    case 'audio':
      return { name: 'edit_audio', description: 'Apply audio ops.', parameters: { type: 'object', properties: { ops: anyArray }, required: ['ops'] } };
    case 'pdf':
      return { name: 'annotate_pdf', description: 'Add text annotations to a PDF.', parameters: { type: 'object', properties: { annotations: anyArray }, required: ['annotations'] } };
    case 'game':
      return { name: 'edit_game', description: 'Apply game ops.', parameters: { type: 'object', properties: { ops: anyArray }, required: ['ops'] } };
    case 'sketch':
      return { name: 'edit_sketch', description: 'Set the Excalidraw scene elements.', parameters: { type: 'object', properties: { elements: anyArray }, required: ['elements'] } };
    case 'form':
      return { name: 'set_document', description: 'Return the complete updated JSON document.', parameters: { type: 'object', additionalProperties: true } };
    case 'floorplan':
      return { name: 'set_floorplan', description: 'Return the complete updated floor plan.', parameters: { type: 'object', properties: { settings: { type: 'object' }, walls: anyArray, furniture: anyArray }, additionalProperties: true } };
    default:
      return null; // text/docx/spreadsheet return plain text, no tool
  }
}

async function callWorkersAI(env: Env, system: string, prompt: string, tool: Tool | null): Promise<string> {
  const opts: Record<string, unknown> = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
    max_tokens: MAX_TOKENS,
  };
  if (tool) opts.tools = [{ name: tool.name, description: tool.description, parameters: tool.parameters }];
  const r = (await env.AI.run(CF_MODEL, opts as never)) as {
    response?: unknown;
    tool_calls?: { name?: string; arguments?: unknown }[];
  };
  const call = r?.tool_calls?.[0];
  if (tool && call?.arguments != null) {
    return typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments);
  }
  if (r?.response == null) throw new Error('workers_ai_empty');
  return typeof r.response === 'string' ? r.response : JSON.stringify(r.response);
}

async function callOpenAI(key: string, system: string, prompt: string, tool: Tool | null): Promise<string> {
  const body: Record<string, unknown> = {
    model: 'gpt-4o-mini',
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };
  if (tool) {
    body.tools = [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }];
    body.tool_choice = { type: 'function', function: { name: tool.name } };
  }
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`openai_${res.status}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string; tool_calls?: { function?: { arguments?: string } }[] } }[];
  };
  const msg = data.choices?.[0]?.message;
  const args = msg?.tool_calls?.[0]?.function?.arguments;
  if (tool && args) return args;
  if (!msg?.content) throw new Error('openai_empty');
  return msg.content;
}

async function callAnthropic(key: string, system: string, prompt: string, tool: Tool | null): Promise<string> {
  const body: Record<string, unknown> = {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (tool) {
    body.tools = [{ name: tool.name, description: tool.description, input_schema: tool.parameters }];
    body.tool_choice = { type: 'tool', name: tool.name };
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`anthropic_${res.status}`);
  const data = (await res.json()) as { content?: { type?: string; text?: string; input?: unknown }[] };
  const blocks = data.content ?? [];
  if (tool) {
    const use = blocks.find((b) => b.type === 'tool_use');
    if (use?.input != null) return JSON.stringify(use.input);
  }
  const text = blocks.find((b) => b.type === 'text')?.text ?? blocks[0]?.text;
  if (!text) throw new Error('anthropic_empty');
  return text;
}

// Detect provider from a BYOK key shape.
function providerForKey(key: string, hint?: string | null): 'openai' | 'anthropic' {
  if (hint === 'openai' || hint === 'anthropic') return hint;
  return key.startsWith('sk-ant-') ? 'anthropic' : 'openai';
}

// Server-side fallback provider (whichever secret is configured).
function serverProvider(env: Env): { provider: 'openai' | 'anthropic'; key: string } | null {
  if (env.ANTHROPIC_API_KEY) return { provider: 'anthropic', key: env.ANTHROPIC_API_KEY };
  if (env.OPENAI_API_KEY) return { provider: 'openai', key: env.OPENAI_API_KEY };
  return null;
}

// ---- Orchestration -------------------------------------------------------

export interface RunOptions {
  byokKey?: string | null;
  byokProvider?: string | null; // 'openai' | 'anthropic' hint
}

export async function runAiEdit(env: Env, req: AiEditRequest, opts: RunOptions): Promise<AiEditResult> {
  const json = wantsJson(req.kind);
  const system = systemPrompt(req.kind, req.meta ?? {});
  const userMsg = [
    `INSTRUCTION:\n${req.instruction}`,
    req.content != null ? `\n\nCURRENT DOCUMENT:\n${req.content}` : '',
  ].join('');

  // Tool-calling (MCP-style): for structured kinds the model invokes a typed
  // tool whose args the provider validates, instead of emitting freeform JSON.
  const tool = json ? toolFor(req.kind) : null;

  let raw: string;
  let provider: AiEditResult['provider'];

  if (opts.byokKey) {
    // Tier 1: bring-your-own-key, direct.
    const p = providerForKey(opts.byokKey, opts.byokProvider);
    raw = p === 'anthropic'
      ? await callAnthropic(opts.byokKey, system, userMsg, tool)
      : await callOpenAI(opts.byokKey, system, userMsg, tool);
    provider = p;
  } else {
    // Tier 2: Workers AI, with Tier 3 server-provider fallback on error.
    try {
      raw = await callWorkersAI(env, system, userMsg, tool);
      provider = 'workers-ai';
    } catch {
      const fb = serverProvider(env);
      if (!fb) throw new Error('ai_unavailable');
      raw = fb.provider === 'anthropic'
        ? await callAnthropic(fb.key, system, userMsg, tool)
        : await callOpenAI(fb.key, system, userMsg, tool);
      provider = fb.provider;
    }
  }

  if (!json) return { provider, text: stripFences(raw) };

  const parsed = extractJson(raw);
  // JSON-document kinds are applied as a document; return the pretty JSON text.
  if (JSON_DOC_KINDS.has(req.kind)) {
    return { provider, text: JSON.stringify(parsed, null, 2) };
  }
  return { provider, ops: parsed };
}
