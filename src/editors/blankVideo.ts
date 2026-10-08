// A short, real, playable title-card video used as the starting clip for
// "New file → Video". Drawn on a canvas and recorded with MediaRecorder, so it
// needs no codecs or downloads. The user adds clips and can delete this one.

export function blankVideoType(ext: string): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const wantMp4 = /^(mp4|m4v|mov)$/.test(ext);
  const candidates = wantMp4
    ? ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
  const mime = candidates.find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) return null;
  return { mime, ext: mime.startsWith('video/mp4') ? 'mp4' : 'webm' };
}

export async function createBlankVideo(mime: string, seconds = 2, w = 1280, h = 720): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const draw = (): void => {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#1b1530'); g.addColorStop(1, '#0e0b14');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = '700 72px system-ui, sans-serif';
    ctx.fillText('New video', w / 2, h / 2 - 30);
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '400 34px system-ui, sans-serif';
    ctx.fillText('Use + Add video/image, then delete this card', w / 2, h / 2 + 40);
  };
  draw();
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 1_500_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<void>((res) => { rec.onstop = () => res(); });
  rec.start(250);
  // Keep producing frames for the whole duration (a static canvas emits none).
  const t = window.setInterval(draw, 100);
  await new Promise((r) => setTimeout(r, seconds * 1000));
  clearInterval(t);
  rec.stop();
  await done;
  stream.getTracks().forEach((tr) => tr.stop());
  return new Blob(chunks, { type: mime.split(';')[0] });
}
