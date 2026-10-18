// Optional on-device text-to-speech (Kokoro-82M, ONNX, quantised ≈ 90 MB).
// Nothing is bundled: the user opts in, the model downloads once from Hugging Face
// and is kept by the browser cache, after which voice (and so a whole song or story)
// can be produced offline with zero quota. English only. Any failure just falls back
// to the cloud voice — callers must treat this as best-effort.
//
// CSP: script-src/connect-src need esm.sh (library), jsdelivr (onnxruntime wasm) and
// huggingface.co / *.hf.co (weights). See index.html / mobile.html / vite.config.ts.

const LIB = 'https://esm.sh/kokoro-js@1.2.1';
const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const FLAG = 'anyedits:localVoice';

interface Kokoro { generate(text: string, o: { voice: string; speed?: number }): Promise<{ audio: Float32Array; sampling_rate: number }> }
let tts: Kokoro | null = null;
let loading: Promise<Kokoro> | null = null;

export function localVoiceSupported(): boolean {
  return typeof WebAssembly === 'object' && typeof OfflineAudioContext !== 'undefined';
}
/** The user has downloaded the model on this device before (it loads fast from cache). */
export function localVoiceInstalled(): boolean {
  try { return localStorage.getItem(FLAG) === '1'; } catch { return false; }
}
export function localVoiceLoaded(): boolean { return tts !== null; }

export async function loadLocalVoice(onProgress?: (fraction: number, label: string) => void): Promise<void> {
  if (tts) return;
  loading ??= (async () => {
    onProgress?.(0, 'Loading voice engine…');
    const mod = (await import(/* @vite-ignore */ LIB)) as { KokoroTTS: { from_pretrained(id: string, o: Record<string, unknown>): Promise<Kokoro> } };
    const files = new Map<string, { loaded: number; total: number }>();
    const model = await mod.KokoroTTS.from_pretrained(MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p: { status?: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file && p.total) {
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
          let l = 0, t = 0; for (const f of files.values()) { l += f.loaded; t += f.total; }
          onProgress?.(t ? l / t : 0, `Downloading voice… ${Math.round(l / 1e6)} / ${Math.round(t / 1e6)} MB`);
        }
      },
    });
    tts = model;
    try { localStorage.setItem(FLAG, '1'); } catch { /* ignore */ }
    return model;
  })();
  try { await loading; } catch (e) { loading = null; throw e; }
}

export async function localSpeak(text: string, voice = 'af_heart', speed = 1): Promise<AudioBuffer> {
  if (!tts) await loadLocalVoice();
  const out = await tts!.generate(text, { voice, speed });
  const buf = new OfflineAudioContext(1, Math.max(1, out.audio.length), out.sampling_rate).createBuffer(1, Math.max(1, out.audio.length), out.sampling_rate);
  buf.copyToChannel(new Float32Array(out.audio), 0);
  return buf;
}

/** Forget the "installed" flag (the browser cache itself is managed by the browser). */
export function forgetLocalVoice(): void {
  tts = null; loading = null;
  try { localStorage.removeItem(FLAG); } catch { /* ignore */ }
}
