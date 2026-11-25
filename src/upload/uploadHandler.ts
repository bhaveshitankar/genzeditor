import type { FileRecord } from '../store/types';
import { FileStore } from '../store/opfs';
import { detectKind } from '../detect/fileKind';

const MAX = 500 * 1024 * 1024;

export async function handleUpload(
  file: File,
  store: FileStore
): Promise<{ ok: true; record: FileRecord } | { ok: false; error: string }> {
  if (file.size > MAX) return { ok: false, error: 'File exceeds 500MB limit.' };
  if (isHeic(file)) {
    try { file = await heicToJpeg(file); }
    catch (e) { console.error('HEIC convert failed', e); return { ok: false, error: 'Could not convert this HEIC image. Try exporting it as JPG.' }; }
  }
  const kind = detectKind(file.name, file.type);
  const record = await store.save(file.name, file, kind);
  return { ok: true, record };
}

function isHeic(f: File): boolean {
  return /\.(heic|heif)$/i.test(f.name) || /image\/hei[cf]/i.test(f.type);
}

// Browsers other than Safari can't decode HEIC, so convert to JPEG on import.
async function heicToJpeg(file: File): Promise<File> {
  const name = file.name.replace(/\.[^.]+$/, '') + '.jpg';
  try { // Safari decodes natively
    const bmp = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.92));
    if (b) return new File([b], name, { type: 'image/jpeg' });
  } catch { /* fall through to wasm decoder */ }
  return new File([await convertInFrame(file)], name, { type: 'image/jpeg' });
}

// heic2any needs 'unsafe-eval', so it runs in an isolated frame (see public/_headers).
let framePromise: Promise<HTMLIFrameElement> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();

function ensureFrame(): Promise<HTMLIFrameElement> {
  if (framePromise) return framePromise;
  framePromise = new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden';
    window.addEventListener('message', (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const d = e.data as { type?: string; id?: number; blob?: Blob; message?: string } | null;
      if (!d) return;
      if (d.type === 'heic-ready') { resolve(frame); return; }
      const p = typeof d.id === 'number' ? pending.get(d.id) : undefined;
      if (!p) return;
      pending.delete(d.id!);
      if (d.type === 'heic-result' && d.blob instanceof Blob) p.resolve(d.blob);
      else p.reject(new Error(d.message || 'heic_failed'));
    });
    frame.addEventListener('error', () => { framePromise = null; reject(new Error('frame_load_failed')); });
    frame.src = '/heic-frame.html';
    document.body.appendChild(frame);
    setTimeout(() => reject(new Error('frame_timeout')), 20_000);
  });
  framePromise.catch(() => { framePromise = null; });
  return framePromise;
}

async function convertInFrame(file: Blob): Promise<Blob> {
  const frame = await ensureFrame();
  const id = ++seq;
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    frame.contentWindow?.postMessage({ type: 'heic-convert', id, blob: file }, '*');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('heic_timeout')); } }, 60_000);
  });
}
