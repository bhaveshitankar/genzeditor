// Turn a user-added file into something the studio can reason about and use —
// entirely on-device. What the *router* sees is only a short summary (name, kind,
// duration/BPM, a text excerpt); photo pixels leave the device only if the plan
// shows a "look at your photos" step, and raw audio/video never do.
import type { AttachKind, AttachmentInfo } from './agentPlan';
import { detectBeats } from '../editors/video/beatSync';

export interface LoadedAttachment {
  info: AttachmentInfo;
  blob: Blob;
  dataUrl?: string;     // image (downsized jpeg)
  frames?: string[];    // video stills (downsized jpeg)
  text?: string;        // text-like documents (truncated)
  audio?: AudioBuffer;  // decoded audio
  width?: number; height?: number;
}

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log|srt|vtt|js|ts|tsx|jsx|py|java|c|cpp|go|rs|rb|php|css|sql|sh)$/i;
export const MAX_ATTACHMENTS = 6;

export function kindOfFile(name: string, mime: string): AttachKind {
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name)) return 'image';
  if (mime.startsWith('audio/') || /\.(mp3|wav|m4a|ogg|oga|flac|aac|opus)$/i.test(name)) return 'audio';
  if (mime.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v)$/i.test(name)) return 'video';
  if (mime.startsWith('text/') || TEXT_EXT.test(name)) return 'text';
  if (/\.(docx|xlsx|xls|pdf|pptx)$/i.test(name)) return 'document';
  return 'other';
}

export async function toDataUrl(src: Blob, max = 768): Promise<{ url: string; w: number; h: number }> {
  const bmp = await createImageBitmap(src);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  const out = { url: c.toDataURL('image/jpeg', 0.82), w: bmp.width, h: bmp.height };
  bmp.close?.();
  return out;
}

async function videoStills(file: Blob, n: number): Promise<{ frames: string[]; duration: number }> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    await new Promise<void>((ok, bad) => { v.onloadedmetadata = () => ok(); v.onerror = () => bad(new Error('video')); });
    // MediaRecorder WebM reports Infinity until the browser is made to compute it.
    if (v.duration === Infinity) {
      v.currentTime = 1e101;
      await new Promise<void>((ok) => { v.ontimeupdate = () => { v.ontimeupdate = null; ok(); }; });
      v.currentTime = 0;
    }
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    const k = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
    const frames: string[] = [];
    for (let i = 0; i < n; i++) {
      v.currentTime = (dur || 1) * ((i + 0.5) / n);
      await new Promise<void>((ok) => { v.onseeked = () => ok(); });
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      frames.push(c.toDataURL('image/jpeg', 0.82));
    }
    return { frames, duration: dur };
  } finally { URL.revokeObjectURL(url); }
}

export async function decodeBlobAudio(blob: Blob): Promise<AudioBuffer> {
  const AC: typeof AudioContext = (window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
    || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AC();
  try {
    const buf = await blob.arrayBuffer();
    return await new Promise<AudioBuffer>((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej) as Promise<AudioBuffer> | undefined;
      if (p && typeof p.then === 'function') p.then(res, rej);
    });
  } finally { try { void ctx.close(); } catch { /* ignore */ } }
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function readText(blob: Blob, name: string): Promise<string> {
  if (/\.docx$/i.test(name)) {
    const mammoth = await import('mammoth');
    return (await mammoth.extractRawText({ arrayBuffer: await blob.arrayBuffer() })).value;
  }
  if (/\.(xlsx|xls)$/i.test(name)) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]!];
    return sheet ? XLSX.utils.sheet_to_csv(sheet) : '';
  }
  return await blob.slice(0, 200_000).text();
}

export async function loadAttachment(blob: Blob, name: string, id: string): Promise<LoadedAttachment> {
  let kind = kindOfFile(name, blob.type);
  const info: AttachmentInfo = { id, kind, name: name.slice(0, 80) };
  const out: LoadedAttachment = { info, blob };
  if (kind === 'image') {
    const d = await toDataUrl(blob);
    out.dataUrl = d.url; out.width = d.w; out.height = d.h;
    info.summary = `${d.w}×${d.h} picture`;
  } else if (kind === 'video') {
    const v = await videoStills(blob, 3);
    out.frames = v.frames; info.durationSec = v.duration;
    info.summary = `${v.duration ? mmss(v.duration) : '?'} video clip`;
  } else if (kind === 'audio') {
    const a = await decodeBlobAudio(blob);
    out.audio = a; info.durationSec = a.duration;
    // Tempo from the first minute is plenty and keeps the analysis fast.
    try {
      const head = a.duration > 60 ? { numberOfChannels: a.numberOfChannels, length: Math.floor(60 * a.sampleRate), sampleRate: a.sampleRate, duration: 60, getChannelData: (c: number) => a.getChannelData(c).subarray(0, Math.floor(60 * a.sampleRate)) } : a;
      info.bpm = detectBeats(head).bpm;
    } catch { /* tempo is optional */ }
    info.summary = `${mmss(a.duration)} audio${info.bpm ? ` · ~${info.bpm} BPM` : ''}`;
  } else if (kind === 'text' || kind === 'document') {
    try {
      out.text = (await readText(blob, name)).replace(/\r/g, '').slice(0, 6000);
      kind = 'text'; info.kind = 'text';
      info.summary = out.text.replace(/\s+/g, ' ').slice(0, 300);
    } catch { info.summary = 'document (could not read text)'; }
  } else info.summary = `${Math.round(blob.size / 1024)} KB file`;
  return out;
}
