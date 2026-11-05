/** Downscale + inline an image file as a data URI (≤1600px; keeps SVG/GIF as-is). */
export async function embedImage(file: File): Promise<string> {
  const read = () => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
  if (/svg|gif/.test(file.type)) return read();
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d')!.drawImage(bmp, 0, 0, cv.width, cv.height);
  return cv.toDataURL(file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.85);
}

export const MAX_EMBED_MEDIA = 10 * 1024 * 1024;
/** Inline an audio/video file as a data URI so the page stays one portable file (≤10 MB). */
export function embedMedia(file: File): Promise<string> {
  if (file.size > MAX_EMBED_MEDIA) return Promise.reject(new Error('too_large'));
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file); });
}
