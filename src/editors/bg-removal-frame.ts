// Runs inside the sandboxed same-origin bg-removal iframe. Receives an image
// Blob by postMessage, runs the @imgly model (bundled), and returns the result
// Blob. Isolated here so onnxruntime's 'unsafe-eval' requirement stays confined
// to this frame's CSP and off the main application document.
import { removeBackground } from '@imgly/background-removal';

const PUBLIC_PATH = 'https://staticimgly.com/@imgly/background-removal-data/1.4.5/dist/';

interface RemoveMsg { type: 'bgr-remove'; id: number; blob: Blob }

window.addEventListener('message', (e: MessageEvent) => {
  const data = e.data as RemoveMsg | null;
  if (!data || data.type !== 'bgr-remove' || !(data.blob instanceof Blob)) return;
  const { id, blob } = data;
  void (async () => {
    try {
      const out = await removeBackground(blob, { publicPath: PUBLIC_PATH });
      window.parent.postMessage({ type: 'bgr-result', id, blob: out }, '*');
    } catch (err) {
      window.parent.postMessage({ type: 'bgr-error', id, message: String(err) }, '*');
    }
  })();
});

// Tell the embedder the model host is ready to accept jobs.
window.parent.postMessage({ type: 'bgr-ready' }, '*');
