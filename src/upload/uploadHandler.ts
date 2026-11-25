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
    catch { return { ok: false, error: 'Could not convert this HEIC image. Try exporting it as JPG.' }; }
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
  // CSP: esm.sh is already allowlisted for lazy editor deps.
  // @ts-ignore remote module
  const mod: any = await import(/* @vite-ignore */ 'https://esm.sh/heic2any@0.0.4');
  const heic2any = mod.default ?? mod;
  const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const blob = Array.isArray(out) ? out[0] : out;
  return new File([blob], name, { type: 'image/jpeg' });
}
