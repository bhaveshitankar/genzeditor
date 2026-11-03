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
