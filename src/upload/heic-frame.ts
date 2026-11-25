// Runs inside the sandboxed heic iframe: HEIC/HEIF Blob in, JPEG Blob out.
import heic2any from 'heic2any';

window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { type?: string; id?: number; blob?: Blob } | null;
  if (!d || d.type !== 'heic-convert' || !(d.blob instanceof Blob)) return;
  const { id } = d;
  void (async () => {
    try {
      const out = await heic2any({ blob: d.blob!, toType: 'image/jpeg', quality: 0.92 });
      window.parent.postMessage({ type: 'heic-result', id, blob: Array.isArray(out) ? out[0] : out }, '*');
    } catch (err) {
      window.parent.postMessage({ type: 'heic-error', id, message: String((err as any)?.message ?? err) }, '*');
    }
  })();
});
window.parent.postMessage({ type: 'heic-ready' }, '*');
