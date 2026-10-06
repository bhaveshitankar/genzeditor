// Client-side bridge to the sandboxed bg-removal iframe. Lazily creates a single
// hidden frame, then routes removeBackground jobs over postMessage keyed by id.

const FRAME_URL = '/bg-removal-frame.html';

let framePromise: Promise<HTMLIFrameElement> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>();

function ensureFrame(): Promise<HTMLIFrameElement> {
  if (framePromise) return framePromise;
  framePromise = new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    // Same-origin src (NOT srcdoc), sandboxed to allow-scripts only.
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.position = 'absolute';
    frame.style.width = '0';
    frame.style.height = '0';
    frame.style.border = '0';
    frame.style.visibility = 'hidden';

    window.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { type?: string; id?: number; blob?: Blob; message?: string } | null;
      if (!d) return;
      if (d.type === 'bgr-ready') { resolve(frame); return; }
      if (d.type === 'bgr-result' && typeof d.id === 'number') {
        const p = pending.get(d.id);
        if (p && d.blob instanceof Blob) { p.resolve(d.blob); pending.delete(d.id); }
      } else if (d.type === 'bgr-error' && typeof d.id === 'number') {
        const p = pending.get(d.id);
        if (p) { p.reject(new Error(d.message || 'bg_removal_failed')); pending.delete(d.id); }
      }
    });

    frame.addEventListener('error', () => reject(new Error('frame_load_failed')));
    frame.src = FRAME_URL;
    document.body.appendChild(frame);
  });
  return framePromise;
}

export async function removeBackgroundViaFrame(blob: Blob): Promise<Blob> {
  const frame = await ensureFrame();
  const id = ++seq;
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    frame.contentWindow?.postMessage({ type: 'bgr-remove', id, blob }, '*');
    // Guard against a frame that never answers (model download stalls, etc.).
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('bg_removal_timeout')); }
    }, 120_000);
  });
}
