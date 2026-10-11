import './styles/ai.css';
import { aiEdit, aiGenerate, genCost, GEN_DAILY_UNITS, AiError, type AiEditResult, type AiKind, type ByoKey, type GenInput, type GenResult } from '../api/client';
import { icon } from './icons';
import { reportFailure } from '../telemetry';
import { renderSong, audioBufferToWav, planFromText, type SongPlan } from '../ai/songSynth';

const BYOK_STORE = 'anyedits:aiKey';

// What the shell resolves for the currently-open editor. `apply` knows how to
// apply the model's result to that specific editor and returns a short summary.
export interface AiTarget {
  kind: AiKind;
  label?: string;
  meta?: Record<string, unknown>;
  getText?: () => string;
  apply: (result: AiEditResult) => Promise<string> | string;
  onChanged?: () => void;
}

export interface AiPanelOptions {
  isAuthed: () => boolean;
  onSignIn: () => void;
  // Returns the AI target for whatever editor is open, or null if unsupported.
  resolve: () => AiTarget | null;
  // Optional: save a generated asset (image/audio/.floorplan) as a new file in the app.
  // When absent, the Generate tab offers a plain download instead.
  saveGenerated?: (name: string, mime: string, blob: Blob) => Promise<void> | void;
}

type GenMode = 'image' | 'audio' | 'song' | 'interior' | 'storyboard';
const MAX_PHOTOS = 4;

async function fileToDataUrl(file: File, max = 768): Promise<string> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.8);
}

// Pull up to `n` evenly spaced frames from a video file.
async function videoFrames(file: File, n: number): Promise<string[]> {
  const url = URL.createObjectURL(file);
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.src = url;
    await new Promise<void>((ok, bad) => { v.onloadedmetadata = () => ok(); v.onerror = () => bad(new Error('video')); });
    const out: string[] = [];
    const k = Math.min(1, 768 / Math.max(v.videoWidth, v.videoHeight, 1));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    for (let i = 0; i < n; i++) {
      v.currentTime = (v.duration || 1) * ((i + 0.5) / n);
      await new Promise<void>((ok) => { v.onseeked = () => ok(); });
      c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
      out.push(c.toDataURL('image/jpeg', 0.8));
    }
    return out;
  } finally { URL.revokeObjectURL(url); }
}

function dataUrlToBlob(u: string): Blob {
  const mime = u.slice(5, u.indexOf(';'));
  const bin = atob(u.slice(u.indexOf(',') + 1));
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: mime });
}

const SUGGESTIONS: Record<AiKind, string[]> = {
  text: ['Fix grammar and spelling', 'Make it more concise', 'Summarize in 3 bullets', 'Explain this code'],
  form: ['Fill with realistic sample data', 'Complete the missing fields', 'Validate and correct values'],
  image: ['Remove the background', 'Make it black and white', 'Brighten and increase contrast', 'Crop to a square'],
  video: ['Mute the audio', 'Trim the first 5 seconds', 'Convert to webm', 'Add a caption at the bottom'],
  docx: ['Fix grammar and tone', 'Make it more formal', 'Add a short intro paragraph', 'Turn this into bullet points'],
  spreadsheet: ['Add a totals row', 'Fill missing values', 'Sort by the first column', 'Add realistic sample rows'],
  pdf: ['Add a "DRAFT" note top-left', 'Add a title at the top', 'Add a footer note', 'Add a review comment'],
  game: ['Add some enemies', 'Make a border wall', 'Add a player spawn point', 'Increase the difficulty'],
  floorplan: ['Add a sofa and a table', 'Add an interior wall', 'Furnish as a bedroom', 'Add a kitchen counter'],
  sketch: ['Add a labelled box', 'Draw a simple flowchart', 'Add a title text', 'Add three connected nodes'],
  audio: ['Normalize the volume', 'Fade in and out', 'Boost volume 20%', 'Add a little reverb'],
};

function loadByok(): ByoKey | null {
  try {
    const raw = localStorage.getItem(BYOK_STORE);
    return raw ? (JSON.parse(raw) as ByoKey) : null;
  } catch { return null; }
}
function saveByok(v: ByoKey | null): void {
  try { v?.key ? localStorage.setItem(BYOK_STORE, JSON.stringify(v)) : localStorage.removeItem(BYOK_STORE); } catch { /* ignore */ }
}

// A right-docked, toggleable chat assistant. The document stays visible beside it.
export class AiPanel {
  private el: HTMLElement;
  private log!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private hintEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private busy = false;

  constructor(private opts: AiPanelOptions) {
    this.el = document.createElement('aside');
    this.el.className = 'ai-drawer';
    this.el.setAttribute('aria-label', 'AI assistant');
    this.el.innerHTML = `
      <div class="ai-drawer-head">
        <span class="ai-drawer-title">${icon('sparkles', 18)}<span>AI assistant</span></span>
        <button type="button" class="ai-drawer-close" data-role="ai-close" aria-label="Close AI assistant" title="Close">${icon('x', 16)}</button>
      </div>
      <div class="ai-tabs" role="tablist">
        <button type="button" class="ai-tab active" role="tab" data-role="tab-edit">Edit</button>
        <button type="button" class="ai-tab" role="tab" data-role="tab-gen">Generate</button>
      </div>
      <div class="ai-gen" data-role="ai-gen" hidden>
        <select class="ai-gen-mode" data-role="gen-mode" aria-label="What to generate">
          <option value="image">Image from text</option>
          <option value="audio">Speech (text to audio)</option>
          <option value="song">Song (lyrics + music)</option>
          <option value="interior">Interior design from photos</option>
          <option value="storyboard">Video (text → storyboard)</option>
        </select>
        <textarea class="ai-input" data-role="gen-prompt" rows="3" placeholder="Describe it…"></textarea>
        <div class="ai-gen-photos" data-role="gen-photos" hidden>
          <label class="ai-ghost ai-file">Photos / video<input type="file" accept="image/*,video/*" multiple hidden data-role="gen-files" /></label>
          <label class="ai-ghost ai-file">Take photo<input type="file" accept="image/*" capture="environment" hidden data-role="gen-cam" /></label>
          <select data-role="gen-style" aria-label="Style">
            <option>modern minimalist</option><option>scandinavian</option><option>industrial loft</option>
            <option>bohemian</option><option>mid-century modern</option><option>japandi</option>
          </select>
          <div class="ai-thumbs" data-role="gen-thumbs"></div>
        </div>
        <div class="ai-gen-song" data-role="gen-song" hidden>
          <label class="ai-check"><input type="checkbox" data-role="gen-instr" /> Instrumental only — free, no sign-in, works offline</label>
          <label class="ai-gen-scenes">Length
            <select data-role="gen-bars"><option value="8">~20 s</option><option value="16" selected>~40 s</option><option value="32">~80 s</option></select>
          </label>
        </div>
        <div class="ai-gen-video" data-role="gen-video" hidden>
          <input type="text" class="ai-input" data-role="gen-vstyle" placeholder="Style, e.g. cinematic, cozy, retro" maxlength="120" />
          <textarea class="ai-input" data-role="gen-vscript" rows="3" placeholder="Your own narration or script — free text (optional). Leave empty to let AI write it." maxlength="500"></textarea>
          <label class="ai-gen-scenes">Scenes
            <select data-role="gen-vscenes"><option>2</option><option selected>3</option><option>4</option></select>
          </label>
        </div>
        <label class="ai-check" data-role="gen-frames-wrap" hidden><input type="checkbox" data-role="gen-frames" /> Render frames (uses more quota)</label>
        <button type="button" class="ai-go" data-role="gen-go">Generate</button>
        <div class="ai-gen-cost" data-role="gen-cost"></div>
        <div class="ai-gen-out" data-role="gen-out"></div>
      </div>
      <div class="ai-hint" data-role="ai-hint"></div>
      <div class="ai-log" data-role="ai-log"></div>
      <div class="ai-suggestions" data-role="ai-chips"></div>
      <div class="ai-composer">
        <textarea class="ai-input" data-role="ai-instruction" rows="2" placeholder="Describe the change…"></textarea>
        <button type="button" class="ai-primary" data-role="ai-send" aria-label="Send">${icon('send', 18)}</button>
      </div>
      <details class="ai-byok">
        <summary>Use your own API key (unlimited)</summary>
        <div class="ai-byok-body">
          <select data-role="ai-provider">
            <option value="">Auto-detect provider</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
          <input type="password" data-role="ai-key" placeholder="sk-..." autocomplete="off" />
          <div class="ai-row">
            <button type="button" class="ai-ghost" data-role="ai-key-save">Save key</button>
            <button type="button" class="ai-ghost" data-role="ai-key-clear">Clear</button>
          </div>
          <p class="ai-quota">Stored only in this browser, sent directly with your request. Never saved on our servers.</p>
        </div>
      </details>`;
    document.body.appendChild(this.el);

    this.log = this.q('[data-role="ai-log"]');
    this.input = this.q('[data-role="ai-instruction"]');
    this.sendBtn = this.q('[data-role="ai-send"]');
    this.hintEl = this.q('[data-role="ai-hint"]');
    this.chipsEl = this.q('[data-role="ai-chips"]');

    this.q('[data-role="ai-close"]').addEventListener('click', () => this.close());
    this.wireGenerate();
    this.sendBtn.addEventListener('click', () => void this.run());
    this.input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void this.run(); }
    });

    const byok = loadByok();
    if (byok) {
      this.q<HTMLInputElement>('[data-role="ai-key"]').value = byok.key;
      if (byok.provider) this.q<HTMLSelectElement>('[data-role="ai-provider"]').value = byok.provider;
    }
    this.q('[data-role="ai-key-save"]').addEventListener('click', () => {
      const key = this.q<HTMLInputElement>('[data-role="ai-key"]').value.trim();
      const provider = (this.q<HTMLSelectElement>('[data-role="ai-provider"]').value || undefined) as ByoKey['provider'];
      saveByok(key ? { key, provider } : null);
      this.addMsg('system', key ? 'Key saved — unlimited mode on.' : 'Key cleared.');
      this.refreshHint();
    });
    this.q('[data-role="ai-key-clear"]').addEventListener('click', () => {
      saveByok(null);
      this.q<HTMLInputElement>('[data-role="ai-key"]').value = '';
      this.addMsg('system', 'Key cleared.');
      this.refreshHint();
    });
  }

  // ---- Generate tab ----
  private photos: string[] = [];
  private genBusy = false;

  private wireGenerate(): void {
    const edit = this.q('[data-role="tab-edit"]'), gen = this.q('[data-role="tab-gen"]');
    const setTab = (g: boolean) => {
      edit.classList.toggle('active', !g); gen.classList.toggle('active', g);
      this.q('[data-role="ai-gen"]').toggleAttribute('hidden', !g);
      for (const r of ['ai-log', 'ai-chips', 'ai-hint']) this.q(`[data-role="${r}"]`).toggleAttribute('hidden', g);
      this.el.querySelector('.ai-composer')?.toggleAttribute('hidden', g);
      if (g) this.updateGenUi();
    };
    edit.addEventListener('click', () => setTab(false));
    gen.addEventListener('click', () => setTab(true));
    this.q('[data-role="gen-mode"]').addEventListener('change', () => this.updateGenUi());
    this.q('[data-role="gen-frames"]').addEventListener('change', () => this.updateGenUi());
    this.q('[data-role="gen-instr"]').addEventListener('change', () => this.updateGenUi());
    const add = async (input: HTMLInputElement) => {
      const files = [...(input.files ?? [])]; input.value = '';
      try {
        for (const f of files) {
          if (this.photos.length >= MAX_PHOTOS) break;
          if (f.type.startsWith('video/')) this.photos.push(...(await videoFrames(f, Math.min(3, MAX_PHOTOS - this.photos.length))));
          else this.photos.push(await fileToDataUrl(f));
        }
      } catch (e) { reportFailure('ai-gen-photo', e, 'interior'); this.genMsg('Could not read that file.', true); }
      this.renderThumbs();
    };
    this.q<HTMLInputElement>('[data-role="gen-files"]').addEventListener('change', (e) => void add(e.target as HTMLInputElement));
    this.q<HTMLInputElement>('[data-role="gen-cam"]').addEventListener('change', (e) => void add(e.target as HTMLInputElement));
    this.q('[data-role="gen-go"]').addEventListener('click', () => void this.runGenerate());
  }

  private genMode(): GenMode { return this.q<HTMLSelectElement>('[data-role="gen-mode"]').value as GenMode; }

  private genInput(): GenInput {
    const mode = this.genMode();
    const prompt = this.q<HTMLTextAreaElement>('[data-role="gen-prompt"]').value.trim();
    switch (mode) {
      case 'image': return { kind: 'image', prompt };
      case 'audio': return { kind: 'audio', text: prompt };
      case 'interior': return { kind: 'interior', images: this.photos, style: this.q<HTMLSelectElement>('[data-role="gen-style"]').value, roomType: prompt || undefined, variants: 2 };
      case 'song': return { kind: 'song', prompt };
      case 'storyboard': {
        const style = this.q<HTMLInputElement>('[data-role="gen-vstyle"]').value.trim();
        const script = this.q<HTMLTextAreaElement>('[data-role="gen-vscript"]').value.trim();
        const full = [prompt, style && `Style: ${style}.`, script && `Use this narration/script as the basis for the scenes: ${script}`].filter(Boolean).join('\n').slice(0, 1000);
        return { kind: 'storyboard', prompt: prompt ? full : '', scenes: Number(this.q<HTMLSelectElement>('[data-role="gen-vscenes"]').value) || 3, frames: this.q<HTMLInputElement>('[data-role="gen-frames"]').checked };
      }
    }
  }

  private updateGenUi(): void {
    const mode = this.genMode();
    this.q('[data-role="gen-photos"]').toggleAttribute('hidden', mode !== 'interior');
    this.q('[data-role="gen-frames-wrap"]').toggleAttribute('hidden', mode !== 'storyboard');
    this.q('[data-role="gen-video"]').toggleAttribute('hidden', mode !== 'storyboard');
    this.q('[data-role="gen-song"]').toggleAttribute('hidden', mode !== 'song');
    this.q<HTMLTextAreaElement>('[data-role="gen-prompt"]').placeholder =
      mode === 'audio' ? 'Text to speak…' : mode === 'song' ? 'What is the song about? e.g. a cozy rainy-day lofi tune about coffee' : mode === 'interior' ? 'Room type, e.g. living room (optional)' : mode === 'storyboard' ? 'What is the video about? e.g. a 15-second teaser for my coffee shop' : 'Describe the image…';
    const byok = loadByok();
    const instr = mode === 'song' && this.q<HTMLInputElement>('[data-role="gen-instr"]').checked;
    this.q('[data-role="gen-cost"]').textContent = instr ? 'Free — no units used.' : byok?.key && mode === 'image'
      ? 'Unlimited with your OpenAI key.'
      : `Uses ~${genCost(this.genInput())} of ${GEN_DAILY_UNITS} free daily units.`;
  }

  private renderThumbs(): void {
    const box = this.q('[data-role="gen-thumbs"]'); box.innerHTML = '';
    this.photos.forEach((src, i) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'ai-thumb'; b.title = 'Remove';
      const im = document.createElement('img'); im.src = src; im.alt = `Photo ${i + 1}`; b.appendChild(im);
      b.addEventListener('click', () => { this.photos.splice(i, 1); this.renderThumbs(); });
      box.appendChild(b);
    });
    this.updateGenUi();
  }

  private genMsg(text: string, isErr = false): void {
    const out = this.q('[data-role="gen-out"]'); out.innerHTML = '';
    const d = document.createElement('div'); d.className = isErr ? 'ai-msg ai-msg-error' : 'ai-msg ai-msg-assistant'; d.textContent = text; out.appendChild(d);
  }

  private async saveAsset(name: string, blob: Blob, btn: HTMLButtonElement): Promise<void> {
    if (this.opts.saveGenerated) { await this.opts.saveGenerated(name, blob.type, blob); btn.textContent = 'Added ✓'; return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  private assetButton(label: string, name: string, blob: () => Blob): HTMLButtonElement {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ai-ghost';
    b.textContent = this.opts.saveGenerated ? label : 'Download';
    b.addEventListener('click', () => void this.saveAsset(name, blob(), b));
    return b;
  }

  private renderGenResult(r: GenResult): void {
    const out = this.q('[data-role="gen-out"]'); out.innerHTML = '';
    const imgCard = (src: string, caption: string, name: string) => {
      const f = document.createElement('figure'); f.className = 'ai-card';
      const im = document.createElement('img'); im.src = src; im.alt = caption; f.appendChild(im);
      const c = document.createElement('figcaption'); c.textContent = caption; f.appendChild(c);
      f.appendChild(this.assetButton('Add as file', name, () => dataUrlToBlob(src)));
      out.appendChild(f);
    };
    if (r.image) imgCard(r.image, 'Generated image', 'generated.png');
    if (r.audio) {
      const au = document.createElement('audio'); au.controls = true; au.src = r.audio; out.appendChild(au);
      out.appendChild(this.assetButton('Add as file', 'speech.mp3', () => dataUrlToBlob(r.audio!)));
    }
    if (r.description) { const p = document.createElement('p'); p.className = 'ai-quota'; p.textContent = r.description; out.appendChild(p); }
    r.variants?.forEach((v, i) => v.image && imgCard(v.image, `${v.style}${v.mode === 'img2img' ? '' : ' (from description)'}`, `interior-${i + 1}.png`));
    if (r.floorplanText) {
      out.appendChild(this.assetButton('Add layout as Floor plan', 'ai-room.floorplan', () => new Blob([r.floorplanText!], { type: 'application/json' })));
    }
    r.scenes?.forEach((s, i) => {
      if (s.image) imgCard(s.image, `Scene ${i + 1} · ${s.durationSec}s · ${s.motion}: ${s.narration}`, `scene-${i + 1}.png`);
      else { const p = document.createElement('p'); p.className = 'ai-quota'; p.textContent = `Scene ${i + 1} (${s.durationSec}s, ${s.motion}): ${s.prompt}`; out.appendChild(p); }
    });
    if (r.scenes?.length) {
      // Editable script the user can tweak and copy (e.g. into a voiceover tool or the video editor's text).
      const wrap = document.createElement('div'); wrap.className = 'ai-script';
      const ta = document.createElement('textarea'); ta.className = 'ai-input'; ta.rows = 5;
      ta.value = (r.title ? `${r.title}\n\n` : '') + r.scenes.map((s, i) => `Scene ${i + 1} (${s.durationSec}s): ${s.narration || s.prompt}`).join('\n');
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'ai-ghost'; copy.textContent = 'Copy script';
      copy.addEventListener('click', () => { void navigator.clipboard?.writeText(ta.value).then(() => { copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy script'; }, 1500); }).catch(() => { ta.select(); }); });
      wrap.append(ta, copy); out.appendChild(wrap);
    }
    if (r.note) { const p = document.createElement('p'); p.className = 'ai-quota'; p.textContent = r.note; out.appendChild(p); }
  }

  // Songs: the model writes lyrics + a musical plan (3 units), then the browser
  // performs the backing track with WebAudio (free). "Instrumental only" skips
  // the model entirely, so it needs no sign-in and uses no quota.
  private async runSong(plan?: SongPlan, lyrics?: string, title?: string): Promise<void> {
    if (this.genBusy) return;
    const prompt = this.q<HTMLTextAreaElement>('[data-role="gen-prompt"]').value.trim();
    const instr = this.q<HTMLInputElement>('[data-role="gen-instr"]').checked;
    const bars = Number(this.q<HTMLSelectElement>('[data-role="gen-bars"]').value) || 16;
    if (!plan && !prompt) { this.genMsg('Describe the song first — mood, topic, style.', true); return; }
    if (!plan && !instr && !this.opts.isAuthed()) { this.genMsg('Sign in for AI lyrics — or tick “Instrumental only” to compose for free.', true); return; }
    this.genBusy = true;
    const go = this.q<HTMLButtonElement>('[data-role="gen-go"]'); go.disabled = true;
    try {
      if (!plan) {
        if (instr) { plan = { ...planFromText(prompt), bars }; title = prompt.slice(0, 40) || 'Instrumental'; }
        else {
          this.genMsg('Writing lyrics and a musical plan…');
          const r = await aiGenerate({ kind: 'song', prompt }, loadByok());
          plan = { mood: (r.mood as SongPlan['mood']) ?? 'chill', tempo: r.tempo ?? 100, key: r.key ?? 'C', minor: !!r.minor, bars, seed: Date.now() % 100000 };
          lyrics = r.lyrics; title = r.title;
        }
      }
      this.genMsg('Composing the music…');
      const { buffer } = await renderSong(plan);
      const blob = audioBufferToWav(buffer);
      this.renderSongResult(plan, blob, lyrics, title, bars);
    } catch (e) {
      if (e instanceof AiError) this.genMsg(e.code === 'daily_limit' ? 'Daily free units used up — tick “Instrumental only” to keep composing for free.' : `Song failed: ${e.code}`, true);
      else { reportFailure('ai-song', e, 'audio'); this.genMsg('Could not compose that song in this browser.', true); }
    } finally { this.genBusy = false; go.disabled = false; }
  }

  private renderSongResult(plan: SongPlan, wav: Blob, lyrics: string | undefined, title: string | undefined, bars: number): void {
    const out = this.q('[data-role="gen-out"]'); out.innerHTML = '';
    const head = document.createElement('p'); head.className = 'ai-quota';
    head.textContent = `${title || 'Song'} · ${plan.mood}, ${plan.tempo} BPM, ${plan.key} ${plan.minor ? 'minor' : 'major'}`;
    const audio = document.createElement('audio'); audio.controls = true; audio.src = URL.createObjectURL(wav);
    out.append(head, audio);
    if (lyrics) {
      const ta = document.createElement('textarea'); ta.className = 'ai-input ai-lyrics'; ta.rows = 8; ta.value = lyrics;
      out.appendChild(ta);
    }
    const safe = (title || 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'song';
    out.appendChild(this.assetButton('Add song as file', `${safe}.wav`, () => wav));
    if (lyrics) out.appendChild(this.assetButton('Add lyrics as note', `${safe}-lyrics.txt`, () => new Blob([lyrics], { type: 'text/plain' })));
    const remix = document.createElement('button'); remix.type = 'button'; remix.className = 'ai-ghost'; remix.textContent = 'Remix (new arrangement)';
    remix.addEventListener('click', () => void this.runSong({ ...plan, seed: (plan.seed ?? 1) + 7919, bars }, lyrics, title));
    out.appendChild(remix);
  }

  private async runGenerate(): Promise<void> {
    if (this.genBusy) return;
    if (this.genMode() === 'song') { await this.runSong(); return; }
    if (!this.opts.isAuthed()) { this.genMsg('Sign in to generate — free daily units, or add your own key.', true); return; }
    const input = this.genInput();
    if (input.kind === 'interior' ? !input.images?.length : !(input.prompt || input.text)) {
      this.genMsg(input.kind === 'interior' ? 'Add 1–4 photos (or a video) of the room.' : 'Enter a description first.', true); return;
    }
    this.genBusy = true;
    const go = this.q<HTMLButtonElement>('[data-role="gen-go"]'); go.disabled = true;
    this.genMsg('Generating… this can take up to a minute.');
    try {
      this.renderGenResult(await aiGenerate(input, loadByok()));
    } catch (e) {
      if (e instanceof AiError) {
        const m: Record<string, string> = {
          daily_limit: 'Daily free units used up. Try again tomorrow, or add your own key.',
          unauthorized: 'Please sign in again.', rate_limited: 'Slow down a moment and retry.',
          too_many_images: `Max ${MAX_PHOTOS} photos.`, image_too_large: 'Photo too large.',
        };
        this.genMsg(m[e.code] ?? `Generation failed: ${e.code}`, true);
        if (!['daily_limit', 'unauthorized', 'rate_limited'].includes(e.code)) reportFailure('ai-generate', e, input.kind);
      } else { this.genMsg('Request failed. Check your connection and try again.', true); }
    } finally { this.genBusy = false; go.disabled = false; }
  }

  private q<T extends HTMLElement>(sel: string): T { return this.el.querySelector(sel) as T; }

  get isOpen(): boolean { return this.el.classList.contains('open'); }

  toggle(): void { this.isOpen ? this.close() : this.open(); }

  open(): void {
    this.el.classList.add('open');
    document.body.classList.add('ai-open');
    this.refresh();
    this.input.focus();
  }

  close(): void {
    this.el.classList.remove('open');
    document.body.classList.remove('ai-open');
  }

  /** Re-read the current editor target and update suggestions/hint. */
  refresh(): void { this.refreshHint(); }

  private refreshHint(): void {
    const target = this.opts.resolve();
    if (!this.opts.isAuthed()) {
      this.hintEl.innerHTML = 'Sign in to use AI — 10 free edits/day or add your own key. <button class="ai-link" data-role="ai-signin">Sign in</button>';
      this.q('[data-role="ai-signin"]')?.addEventListener('click', () => this.opts.onSignIn());
      this.chipsEl.innerHTML = '';
      return;
    }
    if (!target) {
      this.hintEl.textContent = 'Open a text, image, video, audio, document, spreadsheet, PDF, sketch, floor-plan or game file to edit with AI.';
      this.chipsEl.innerHTML = '';
      return;
    }
    const byok = loadByok();
    this.hintEl.textContent = `Editing ${target.label ?? target.kind} — ${byok?.key ? 'unlimited (your key).' : '10 free edits/day.'}`;
    this.chipsEl.innerHTML = '';
    for (const s of SUGGESTIONS[target.kind]) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'ai-chip'; b.textContent = s;
      b.addEventListener('click', () => { this.input.value = s; this.input.focus(); });
      this.chipsEl.appendChild(b);
    }
  }

  private addMsg(role: 'user' | 'assistant' | 'system' | 'error', text: string): HTMLElement {
    const m = document.createElement('div');
    m.className = `ai-msg ai-msg-${role}`;
    m.textContent = text;
    this.log.appendChild(m);
    this.log.scrollTop = this.log.scrollHeight;
    return m;
  }

  private async run(): Promise<void> {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text) { this.input.focus(); return; }
    if (!this.opts.isAuthed()) { this.refreshHint(); return; }
    const target = this.opts.resolve();
    if (!target) { this.refreshHint(); return; }

    this.busy = true;
    this.sendBtn.disabled = true;
    this.addMsg('user', text);
    this.input.value = '';
    const thinking = this.addMsg('assistant', 'Thinking…');
    try {
      const result = await aiEdit(
        { kind: target.kind, instruction: text, content: target.getText?.(), meta: target.meta },
        loadByok(),
      );
      const summary = (await target.apply(result)) || 'Applied.';
      target.onChanged?.();
      thinking.textContent = `✓ ${summary} · ${result.provider}`;
      thinking.className = 'ai-msg ai-msg-assistant ok';
    } catch (e) {
      thinking.className = 'ai-msg ai-msg-error';
      if (!(e instanceof AiError && (e.code === 'daily_limit' || e.code === 'unauthorized'))) reportFailure('ai-edit', e, target.kind);
      if (e instanceof AiError) {
        if (e.code === 'daily_limit') thinking.textContent = `Daily free limit reached (${e.limit ?? 10}/day). Add your own API key below for unlimited use.`;
        else if (e.code === 'unauthorized') thinking.textContent = 'Please sign in again.';
        else if (e.code === 'ai_bad_json') thinking.textContent = 'The AI returned an unexpected result — try rephrasing.';
        else thinking.textContent = `AI error: ${e.code}`;
      } else {
        thinking.textContent = 'Request failed. Check your connection and try again.';
      }
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
      this.input.focus();
    }
  }
}
