// Shared (browser + Worker) request router model. Pure functions only — no DOM,
// no network — so the same code validates the model's routing decision on the
// server and builds the visible plan in the browser.
//
// Design: the LLM is only a *router*. It picks one intent and a few parameters
// (RoutedIntent). Everything else — which steps run, what they cost, what leaves
// the device — is built deterministically from that, from a closed set of step
// types. A prompt-injected file can therefore never add a step, call a URL or
// raise its own budget: sanitizeIntent() clamps every field.

export type Intent = 'edit' | 'song' | 'speech' | 'story_audio' | 'image' | 'video' | 'music_video' | 'text';
export type SongMode = 'lyrics' | 'lyrics_melody' | 'melody';
export type Length = 'short' | 'medium' | 'long';
export type Aspect = '9:16' | '1:1' | '16:9';
export type Mood = 'chill' | 'upbeat' | 'sad' | 'epic' | 'lofi';
export type AttachKind = 'image' | 'audio' | 'video' | 'text' | 'document' | 'other';
export type Pace = 'fast' | 'medium' | 'slow';
export type StepType = 'analyze' | 'describe' | 'script' | 'lyrics' | 'voice' | 'melody' | 'mix' | 'storyboard' | 'images' | 'video' | 'image' | 'edit';

export const INTENTS: Intent[] = ['edit', 'song', 'speech', 'story_audio', 'image', 'video', 'music_video', 'text'];
export const MOODS: Mood[] = ['chill', 'upbeat', 'sad', 'epic', 'lofi'];
export const KEYS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
// MeloTTS languages (Workers AI).
export const LANGS: Record<string, string> = { english: 'en', spanish: 'es', french: 'fr', chinese: 'zh', japanese: 'jp', korean: 'kr' };
export const LANG_CODES = Object.values(LANGS);

// Mirror of worker/src/generate.ts COST (weighted daily units) for UI estimates.
export const UNIT = { route: 1, image: 4, audio: 2, describe: 3, storyboard: 3, song: 3, script: 3 };

export interface AttachmentInfo {
  id: string;
  kind: AttachKind;
  name: string;
  summary?: string;       // local analysis: text excerpt, image description, "3:21 · ~92 BPM" …
  durationSec?: number;
  bpm?: number;
}

export interface RouteContext {
  attachments: AttachmentInfo[];
  editor?: { kind: string; label?: string } | null; // the file open in the editor
  previous?: string;                                // summary of earlier parts of this project
}

export interface RoutedIntent {
  intent: Intent;
  songMode: SongMode;
  theme: string;           // what it is about / the text to speak / the edit instruction
  title?: string;
  style?: string;
  mood?: Mood;
  tempo?: number;
  key?: string;
  minor?: boolean;
  language: string;        // ISO-ish code from LANG_CODES
  length: Length;
  scenes?: number;
  aspect?: Aspect;
  useAttachments: string[];
  continue: boolean;
  reason?: string;
}

export interface Prefs {
  output: 'auto' | 'lyrics' | 'song' | 'melody' | 'story' | 'speech' | 'image' | 'video' | 'music_video' | 'edit';
  length: 'auto' | Length;
  style: string;
  language: 'auto' | string;
  aspect: Aspect;
  voice: 'cloud' | 'local';
  pace: 'auto' | Pace;
  motion: 'calm' | 'lively';
  captions: boolean;
  music: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  output: 'auto', length: 'auto', style: '', language: 'auto', aspect: '9:16',
  voice: 'cloud', pace: 'auto', motion: 'lively', captions: true, music: true,
};

// ---- sanitising ---------------------------------------------------------

export function clip(v: unknown, n: number): string {
  // eslint-disable-next-line no-control-regex
  return String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ').trim().slice(0, n);
}
const clampN = (v: unknown, lo: number, hi: number, d: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export function sanitizeContext(raw: unknown): RouteContext {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const kinds: AttachKind[] = ['image', 'audio', 'video', 'text', 'document', 'other'];
  const atts = (Array.isArray(o.attachments) ? o.attachments : []).slice(0, 8).flatMap((a, i) => {
    const r = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const kind = kinds.includes(r.kind as AttachKind) ? (r.kind as AttachKind) : 'other';
    const out: AttachmentInfo = { id: clip(r.id, 24) || `a${i}`, kind, name: clip(r.name, 80) || 'file' };
    const summary = clip(r.summary, 700); if (summary) out.summary = summary;
    const d = Number(r.durationSec); if (Number.isFinite(d) && d >= 0 && d < 36000) out.durationSec = d;
    const b = Number(r.bpm); if (Number.isFinite(b) && b >= 30 && b <= 300) out.bpm = Math.round(b);
    return [out];
  });
  const ed = o.editor && typeof o.editor === 'object' ? (o.editor as Record<string, unknown>) : null;
  const ctx: RouteContext = { attachments: atts };
  if (ed && ed.kind) ctx.editor = { kind: clip(ed.kind, 24), label: clip(ed.label, 40) || undefined };
  const prev = clip(o.previous, 1500); if (prev) ctx.previous = prev;
  return ctx;
}

export function sanitizeIntent(raw: unknown, ctx: RouteContext, fallbackText = ''): RoutedIntent {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let intent = INTENTS.includes(o.intent as Intent) ? (o.intent as Intent) : 'text';
  if (intent === 'edit' && !ctx.editor) intent = 'text'; // nothing open to edit
  const length: Length = o.length === 'short' || o.length === 'long' ? o.length : 'medium';
  const songMode: SongMode = o.songMode === 'lyrics' || o.songMode === 'melody' ? o.songMode : 'lyrics_melody';
  const ids = new Set(ctx.attachments.map((a) => a.id));
  const use = (Array.isArray(o.useAttachments) ? o.useAttachments : []).map((x) => clip(x, 24)).filter((x) => ids.has(x));
  const out: RoutedIntent = {
    intent, songMode, theme: clip(o.theme, 700) || clip(fallbackText, 700),
    language: LANG_CODES.includes(String(o.language)) ? String(o.language) : 'en',
    length, useAttachments: [...new Set(use)].slice(0, 8), continue: o.continue === true,
  };
  const title = clip(o.title, 80); if (title) out.title = title;
  const style = clip(o.style, 120); if (style) out.style = style;
  if (MOODS.includes(o.mood as Mood)) out.mood = o.mood as Mood;
  if (o.tempo != null && Number.isFinite(Number(o.tempo))) out.tempo = clampN(o.tempo, 60, 160, 100);
  if (KEYS.includes(String(o.key))) out.key = String(o.key);
  if (typeof o.minor === 'boolean') out.minor = o.minor;
  if (o.scenes != null) out.scenes = clampN(o.scenes, 2, 12, 6);
  if (o.aspect === '9:16' || o.aspect === '1:1' || o.aspect === '16:9') out.aspect = o.aspect;
  const reason = clip(o.reason, 160); if (reason) out.reason = reason;
  return out;
}

// ---- offline heuristic router (used when signed out or the model is down) ----

const EDIT_VERBS = /\b(fix|edit|trim|crop|rotate|flip|brighten|darken|mute|normali[sz]e|fade|remove|replace|rename|translate|summari[sz]e|rewrite|shorten|format|sort|filter|convert|proofread|correct|resize|speed|reverb|echo|grayscale|black and white|change|make (it|this|the)|add (a |an |some )?(row|column|note|caption|title|footer|border|wall|enem)|increase|decrease|boost|clean)/;
const EXPLICIT_NEW = /\b(generate|create|compose|make me|write me|from scratch|brand new)\b/;

export function heuristicIntent(text: string, ctx: RouteContext): RoutedIntent {
  const t = text.toLowerCase();
  const hasSong = /\b(song|lyrics|melody|tune|jingle|rap|ballad|anthem|lullaby|instrumental|soundtrack|background music|beat)\b/.test(t);
  const wantsVideo = /\b(video|reel|shorts|clip|movie|film|animation|slideshow|trailer|teaser)\b/.test(t);
  const hasAudioAtt = ctx.attachments.some((a) => a.kind === 'audio');
  let gen: Intent | null = null;
  if (/music video|lyric video/.test(t) || (hasSong && wantsVideo) || (wantsVideo && hasAudioAtt && /\b(song|track|music|audio|beat)\b/.test(t))) gen = 'music_video';
  else if (wantsVideo) gen = 'video';
  else if (/story ?telling|bedtime story|audio ?book|narrat(e|ion) (a|the) story|podcast|tell me a story|read me a story|story (audio|mode)/.test(t)) gen = 'story_audio';
  else if (hasSong) gen = 'song';
  else if (/\b(read (this|it) (aloud|out)|text to speech|tts|voice ?over|say this|narrate this)\b/.test(t)) gen = 'speech';
  else if (/\b(image|picture|photo|illustration|logo|poster|wallpaper|portrait|artwork)\b/.test(t) && /\b(generate|create|make|draw|design|paint|render)\b/.test(t)) gen = 'image';
  else if (/\b(write|draft|compose)\b.*\b(email|letter|essay|story|script|poem|blog|article|post|caption|speech|outline)\b/.test(t)) gen = 'text';
  const edit = !!ctx.editor && EDIT_VERBS.test(t);
  let intent: Intent = gen ?? (ctx.editor ? 'edit' : 'text');
  if (gen && edit && !EXPLICIT_NEW.test(t)) intent = 'edit';

  let songMode: SongMode = 'lyrics_melody';
  if (/\b(lyrics|poem)\b.*\b(only|alone)\b|\b(only|just)\b.*\blyrics\b|\bwrite (me )?(some |the )?lyrics\b/.test(t) && !/\b(sing|vocal|melody|music|audio)\b/.test(t)) songMode = 'lyrics';
  else if (/\b(instrumental|melody only|only (a )?melody|background music|soundtrack|beat only|no (lyrics|vocals|singing))\b/.test(t)) songMode = 'melody';
  else if (/\b(melody|tune|beat)\b/.test(t) && !/\b(lyrics|sing|vocals?|words|song)\b/.test(t)) songMode = 'melody';

  const nums = /(\d{1,2})\s*(?:scenes?|shots?|slides?)/.exec(t);
  const mins = /(\d{1,2})\s*(?:min|minutes?)\b/.exec(t);
  const length: Length = (mins && Number(mins[1]) >= 2) || /\b(long|full|extended|epic|chapters?|series|episode|multi[- ]part)\b/.test(t) ? 'long'
    : /\b(short|quick|brief|tiny|few seconds|10 ?s|15 ?s|20 ?s|30 ?s)\b/.test(t) ? 'short' : 'medium';
  let language = 'en';
  for (const [name, code] of Object.entries(LANGS)) if (new RegExp(`\\b(in|into)\\s+${name}\\b`).test(t)) language = code;
  const out: RoutedIntent = {
    intent, songMode, theme: clip(text, 700), language, length,
    useAttachments: ctx.attachments.map((a) => a.id),
    continue: /\b(continue|next (part|chapter|episode)|part \d|sequel|keep going|carry on|what happens next)\b/.test(t) && !!ctx.previous,
    reason: 'offline routing',
  };
  if (nums) out.scenes = clampN(nums[1], 2, 12, 6);
  if (/\b(vertical|reel|tiktok|shorts)\b/.test(t)) out.aspect = '9:16';
  else if (/\b(wide|landscape|youtube|16:9)\b/.test(t)) out.aspect = '16:9';
  else if (/\b(square|instagram post|1:1)\b/.test(t)) out.aspect = '1:1';
  return out;
}

export function applyPrefs(i: RoutedIntent, p: Prefs): RoutedIntent {
  const o: RoutedIntent = { ...i };
  switch (p.output) {
    case 'lyrics': o.intent = 'song'; o.songMode = 'lyrics'; break;
    case 'song': o.intent = 'song'; o.songMode = 'lyrics_melody'; break;
    case 'melody': o.intent = 'song'; o.songMode = 'melody'; break;
    case 'story': o.intent = 'story_audio'; break;
    case 'speech': case 'image': case 'video': case 'music_video': o.intent = p.output; break;
    case 'edit': o.intent = 'edit'; break;
    default: break;
  }
  if (p.length !== 'auto') o.length = p.length;
  if (p.style.trim()) o.style = [o.style, p.style.trim()].filter(Boolean).join(', ').slice(0, 160);
  if (p.language !== 'auto' && LANG_CODES.includes(p.language)) o.language = p.language;
  o.aspect = o.aspect ?? p.aspect;
  return o;
}

// ---- shapes & plan -------------------------------------------------------

export interface Shape {
  uniqueSections: number;   // distinct lyric blocks to voice (chorus is reused)
  arrangement: number;      // sections in the final song
  bars: number;             // melody-only bars
  chapters: number; words: number;
  scenes: number;
}

export function shapeFor(i: RoutedIntent): Shape {
  const L = i.length;
  const pick = <T,>(s: T, m: T, l: T): T => (L === 'short' ? s : L === 'long' ? l : m);
  const scenes = i.scenes ?? pick(4, 6, 12);
  return {
    uniqueSections: pick(2, 3, 4), arrangement: pick(2, 4, 6), bars: pick(16, 32, 56),
    chapters: pick(1, 3, 8), words: pick(100, 70, 90), scenes,
  };
}

export interface PlanStep { id: string; type: StepType; label: string; cloud: boolean; units: number }
export interface Plan {
  intent: RoutedIntent;
  title: string;
  steps: PlanStep[];
  units: number;
  sendsOut: string[];     // human-readable list of what leaves the device
  needsAuth: boolean;
}

export interface PlanOpts { byok: boolean; localVoice: boolean; attachments: AttachmentInfo[] }

export function buildPlan(i: RoutedIntent, prefs: Prefs, o: PlanOpts): Plan {
  const sh = shapeFor(i);
  const used = o.attachments.filter((a) => i.useAttachments.includes(a.id));
  const imgs = used.filter((a) => a.kind === 'image').length;
  const vids = used.filter((a) => a.kind === 'video').length;
  const audio = used.find((a) => a.kind === 'audio');
  const steps: PlanStep[] = [];
  const sends: string[] = [];
  const add = (type: StepType, label: string, cloud: boolean, units = 0) => steps.push({ id: `${steps.length}:${type}`, type, label, cloud, units });
  const localTts = prefs.voice === 'local' && o.localVoice && i.language === 'en';
  const voiceStep = (label: string, calls: number) => add('voice', label + (localTts ? ' (on-device)' : ''), !localTts, localTts ? 0 : calls * UNIT.audio);
  const imageCount = (n: number) => {
    const have = imgs + vids * 3;
    const want = o.byok ? n : Math.min(n, 6);
    return Math.max(0, want - have);
  };
  const storyboard = (scenes: number) => {
    const calls = Math.max(1, Math.ceil(scenes / 6));
    add('storyboard', calls > 1 ? `Plan ${scenes} scenes in ${calls} passes` : `Plan ${scenes} scenes`, true, calls * UNIT.storyboard);
    sends.push('your idea (text)');
  };
  const visuals = (scenes: number) => {
    if (imgs + vids) { add('describe', 'Look at your photos', true, UNIT.describe); sends.push('downsized copies of your photos'); }
    storyboard(scenes);
    const gen = imageCount(scenes);
    if (gen) add('images', `Draw ${gen} image${gen > 1 ? 's' : ''}${scenes > gen ? ` (reused across ${scenes} scenes)` : ''}`, true, gen * (o.byok ? 0 : UNIT.image));
    else add('images', 'Use your pictures as scenes', false);
  };
  const songSteps = (mode: SongMode) => {
    if (mode !== 'melody') { add('lyrics', 'Write lyrics', true, UNIT.song); sends.push('your song idea (text)'); }
    if (mode === 'lyrics_melody') {
      voiceStep('Sing the lyrics', sh.uniqueSections);
      add('melody', 'Compose melody, chords & beat', false);
      add('mix', 'Sync lyrics to the beat and mix', false);
    } else if (mode === 'melody') add('melody', 'Compose melody, chords & beat', false);
  };

  let title = i.title || i.theme.slice(0, 40) || 'Untitled';
  switch (i.intent) {
    case 'edit': add('edit', 'Edit the open file', true, 0); sends.push('the open file’s content (text/metadata)'); break;
    case 'text': add('script', 'Write it', true, UNIT.script); sends.push('your request (text)'); break;
    case 'image': add('image', 'Generate the image', true, o.byok ? 0 : UNIT.image); sends.push('your description (text)'); break;
    case 'speech': voiceStep('Read it aloud', Math.max(1, Math.ceil(i.theme.length / 450))); break;
    case 'story_audio': {
      add('script', sh.chapters > 4 ? `Write the story (${sh.chapters} chapters)` : 'Write the story', true, Math.ceil(sh.chapters / 4) * UNIT.script);
      sends.push('your story idea (text)');
      voiceStep('Narrate it', sh.chapters + (sh.chapters > 1 ? 1 : 0));
      add('mix', prefs.music ? 'Mix with a soft music bed' : 'Assemble the narration', false);
      break;
    }
    case 'song': songSteps(i.songMode); break;
    case 'video': {
      visuals(sh.scenes);
      voiceStep('Record the voice-over', Math.ceil(sh.scenes / 3));
      if (prefs.music) add('melody', 'Compose background music', false);
      add('video', 'Animate and render the video', false);
      break;
    }
    case 'music_video': {
      if (audio) {
        add('analyze', `Find the beat in “${audio.name}”`, false);
      } else songSteps(i.songMode === 'melody' ? 'melody' : 'lyrics_melody');
      visuals(Math.min(sh.scenes, 12));
      add('video', 'Cut to the beat, animate and render', false);
      break;
    }
  }
  if (i.continue) title = `${title} (continued)`;
  const units = steps.reduce((a, s) => a + s.units, 0);
  return { intent: i, title, steps, units, sendsOut: [...new Set(sends)], needsAuth: steps.some((s) => s.cloud) };
}

// ---- lyrics helpers ------------------------------------------------------

export interface LyricSection { label: string; lines: string[]; chorus: boolean; bridge: boolean }

export function parseLyrics(text: string): LyricSection[] {
  const secs: LyricSection[] = [];
  const header = /^\s*[[(]\s*([^\]\n)]{1,40}?)\s*[\])]\s*:?\s*$|^\s*((?:pre-?)?(?:verse|chorus|bridge|intro|outro|hook|refrain)\b[^:\n]{0,20}):?\s*$/i;
  let cur: LyricSection | null = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = header.exec(raw);
    if (m) {
      const label = (m[1] || m[2] || 'Verse').trim();
      cur = { label, lines: [], chorus: /chorus|hook|refrain/i.test(label), bridge: /bridge/i.test(label) };
      secs.push(cur);
      continue;
    }
    const line = raw.replace(/^[\s"'“”*_-]+|[\s"'“”*_]+$/g, '').trim();
    if (!line) continue;
    if (!cur) { cur = { label: 'Verse 1', lines: [], chorus: false, bridge: false }; secs.push(cur); }
    cur.lines.push(line);
  }
  const keep = secs.filter((s) => s.lines.length && !/^(intro|outro)\b/i.test(s.label) || s.lines.length > 1);
  if (keep.length === 1 && keep[0]!.lines.length > 6) {
    // Unlabelled wall of text: split into 4-line blocks, odd blocks are the chorus.
    const all = keep[0]!.lines, out: LyricSection[] = [];
    for (let k = 0; k < all.length; k += 4) {
      const chorus = out.length % 2 === 1;
      out.push({ label: chorus ? 'Chorus' : `Verse ${Math.floor(out.length / 2) + 1}`, lines: all.slice(k, k + 4), chorus, bridge: false });
    }
    return out;
  }
  return keep;
}

export interface ArrangedSection extends LyricSection { src: number }

/** Order the written sections into a song structure; `src` indexes the distinct text so voices can be reused. */
export function arrangeSong(secs: LyricSection[], length: Length): ArrangedSection[] {
  const withSrc = secs.map((s, src) => ({ ...s, src }));
  const verses = withSrc.filter((s) => !s.chorus && !s.bridge);
  const chorus = withSrc.find((s) => s.chorus);
  const bridge = withSrc.find((s) => s.bridge);
  const order: (ArrangedSection | undefined)[] = length === 'short' ? [verses[0], chorus]
    : length === 'long' ? [verses[0], chorus, verses[1] ?? verses[0], chorus, bridge, chorus]
      : [verses[0], chorus, verses[1], chorus];
  const out = order.filter((s): s is ArrangedSection => !!s);
  if (out.length) return out;
  return withSrc.slice(0, length === 'short' ? 2 : length === 'long' ? 6 : 4);
}

/** Split text into chunks of ~max chars on sentence/line boundaries (for TTS calls). */
export function splitIntoChunks(text: string, max = 450): string[] {
  const parts = String(text || '').replace(/\r/g, '').split(/(?<=[.!?…])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const p of parts) {
    if (cur && (cur + ' ' + p).length > max) { out.push(cur); cur = p; } else cur = cur ? `${cur} ${p}` : p;
    while (cur.length > max * 1.6) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}
