import './styles/ai.css';
import { aiEdit, aiRoute, AiError, GEN_DAILY_UNITS, type AiEditResult, type AiKind, type ByoKey } from '../api/client';
import { icon } from './icons';
import { reportFailure } from '../telemetry';
import {
  applyPrefs, buildPlan, DEFAULT_PREFS, heuristicIntent, LANGS,
  type AttachmentInfo, type Plan, type PlanStep, type Prefs, type RouteContext, type RoutedIntent, type StepType,
} from '../ai/agentPlan';
import { loadAttachment, kindOfFile, MAX_ATTACHMENTS, type LoadedAttachment } from '../ai/attachments';
import { addPart, contextFor, loadProject, saveProject, type Project } from '../ai/projects';
import { localVoiceInstalled, localVoiceSupported, loadLocalVoice, localVoiceLoaded } from '../ai/localVoice';
import type { Artifact, RunResult } from '../ai/agentRun';
import type { ReelAspect } from '../ai/reel';

const BYOK_STORE = 'anyedits:aiKey';
const PREFS_STORE = 'anyedits:aiPrefs';
const AUTO_RUN_UNITS = 12;       // plans costing more than this wait for an explicit "Start"

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

export interface LibraryItem { id: string; name: string; kind: string; size: number }

export interface AiPanelOptions {
  isAuthed: () => boolean;
  onSignIn: () => void;
  // Returns the AI target for whatever editor is open, or null if unsupported.
  resolve: () => AiTarget | null;
  // Save a generated asset (audio/video/image/text) as a new file in the app. When absent, a plain download is offered.
  saveGenerated?: (name: string, mime: string, blob: Blob) => Promise<void> | void;
  // Files already in the app, so they can be attached to a request.
  listLibrary?: () => Promise<LibraryItem[]>;
  readLibrary?: (id: string) => Promise<Blob>;
  // The file currently open in the editor (any kind), as an attachment candidate.
  openFile?: () => Promise<{ name: string; blob: Blob } | null>;
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
const CREATE_IDEAS = [
  'Write a lofi song about rainy mornings',
  'Lyrics only: a funny birthday rap for my friend',
  'Tell a calm bedtime story about a brave little fox',
  'Make a music video for an upbeat summer road-trip song',
  'Just a chill melody for studying, no vocals',
  'A short vertical video about my coffee shop opening',
];

function loadByok(): ByoKey | null {
  try { const raw = localStorage.getItem(BYOK_STORE); return raw ? (JSON.parse(raw) as ByoKey) : null; } catch { return null; }
}
function saveByok(v: ByoKey | null): void {
  try { v?.key ? localStorage.setItem(BYOK_STORE, JSON.stringify(v)) : localStorage.removeItem(BYOK_STORE); } catch { /* ignore */ }
}
function loadPrefs(): Prefs {
  try { return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem(PREFS_STORE) || '{}') as Partial<Prefs>) }; } catch { return { ...DEFAULT_PREFS }; }
}
function savePrefs(p: Prefs): void { try { localStorage.setItem(PREFS_STORE, JSON.stringify(p)); } catch { /* ignore */ } }

const INTENT_LABEL: Record<string, string> = {
  edit: 'Edit the open file', song: 'Song', speech: 'Read aloud', story_audio: 'Audio story', image: 'Image', video: 'Video', music_video: 'Music video', text: 'Writing',
};
const SONG_LABEL: Record<string, string> = { lyrics: 'Lyrics only', lyrics_melody: 'Lyrics + melody', melody: 'Melody only' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function button(label: string, cls = 'ai-ghost', onClick?: () => void): HTMLButtonElement {
  const b = el('button', cls, label); b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

interface PlanCard {
  root: HTMLElement;
  step(type: StepType, state: 'run' | 'done' | 'error'): void;
  progress(f: number, label: string): void;
  setActions(...b: HTMLElement[]): void;
  note(text: string): void;
}

// One docked assistant for everything: editing the open file, and creating songs,
// stories, voice, images and videos. A cheap router call decides what the user
// wants; the plan it produces is shown, then run step by step.
export class AiPanel {
  private el: HTMLElement;
  private log!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private hintEl!: HTMLElement;
  private chipsEl!: HTMLElement;
  private trayEl!: HTMLElement;
  private projEl!: HTMLElement;

  private busy = false;
  private abort: AbortController | null = null;
  private prefs: Prefs = loadPrefs();
  private attachments: LoadedAttachment[] = [];
  private project: Project | null = loadProject();
  private continueNext = false;
  private lastIntent: RoutedIntent | null = null;
  private lastPrompt = '';
  private urls: string[] = [];
  // In-session media of earlier parts, so "Continue" can join them into one file.
  private session: { audio: AudioBuffer | null; videos: { blob: Blob; aspect?: ReelAspect }[] } = { audio: null, videos: [] };
  private nextId = 1;

  constructor(private opts: AiPanelOptions) {
    this.el = document.createElement('aside');
    this.el.className = 'ai-drawer';
    this.el.setAttribute('aria-label', 'AI studio');
    this.el.innerHTML = `
      <div class="ai-drawer-head">
        <span class="ai-drawer-title">${icon('sparkles', 18)}<span>AI studio</span></span>
        <span class="ai-head-actions">
          <button type="button" class="ai-ghost" data-role="ai-new" title="Start a fresh project (forgets earlier parts)">New</button>
          <button type="button" class="ai-drawer-close" data-role="ai-close" aria-label="Close AI studio" title="Close">${icon('x', 16)}</button>
        </span>
      </div>
      <div class="ai-hint" data-role="ai-hint"></div>
      <div class="ai-project" data-role="ai-project" hidden></div>
      <div class="ai-log" data-role="ai-log"></div>
      <div class="ai-suggestions" data-role="ai-chips"></div>
      <div class="ai-tray" data-role="ai-tray"></div>
      <div class="ai-addrow">
        <label class="ai-ghost ai-file" title="Add photos, audio, video or documents">${icon('plus', 14)} Add files<input type="file" multiple hidden data-role="ai-files" accept="image/*,audio/*,video/*,.txt,.md,.csv,.json,.docx,.xlsx,text/*" /></label>
        <button type="button" class="ai-ghost" data-role="ai-lib">From library</button>
        <button type="button" class="ai-ghost" data-role="ai-openfile">Use open file</button>
      </div>
      <div class="ai-lib" data-role="ai-liblist" hidden></div>
      <div class="ai-composer">
        <textarea class="ai-input" data-role="ai-instruction" rows="2" placeholder="Ask for anything — edit this file, write a song, tell a story, make a video…"></textarea>
        <button type="button" class="ai-primary" data-role="ai-send" aria-label="Send">${icon('send', 18)}</button>
      </div>
      <details class="ai-tune">
        <summary>Tune the result <span class="ai-quota">(optional — Auto decides)</span></summary>
        <div class="ai-tune-grid">
          <label>Make<select data-role="p-output">
            <option value="auto">Auto</option><option value="song">Song (lyrics + singing)</option><option value="lyrics">Lyrics only</option>
            <option value="melody">Melody only</option><option value="story">Audio story</option><option value="speech">Read text aloud</option>
            <option value="image">Image</option><option value="video">Video</option><option value="music_video">Music video</option><option value="edit">Edit open file</option>
          </select></label>
          <label>Length<select data-role="p-length"><option value="auto">Auto</option><option value="short">Short</option><option value="medium">Medium</option><option value="long">Long (multi-part)</option></select></label>
          <label>Language<select data-role="p-language"><option value="auto">Auto</option>${Object.entries(LANGS).map(([n, c]) => `<option value="${c}">${n[0]!.toUpperCase()}${n.slice(1)}</option>`).join('')}</select></label>
          <label>Format<select data-role="p-aspect"><option value="9:16">9:16 Reel</option><option value="1:1">1:1 Square</option><option value="16:9">16:9 Wide</option></select></label>
          <label>Cut speed<select data-role="p-pace"><option value="auto">Auto (by tempo)</option><option value="fast">Fast</option><option value="medium">Medium</option><option value="slow">Slow</option></select></label>
          <label>Camera<select data-role="p-motion"><option value="lively">Lively</option><option value="calm">Calm</option></select></label>
          <label class="ai-wide">Style / mood<input type="text" data-role="p-style" maxlength="120" placeholder="e.g. warm acoustic, cinematic, anime, retro" /></label>
          <label class="ai-wide">Voice<select data-role="p-voice"><option value="cloud">Cloud voice (uses free units)</option><option value="local">On-device voice (offline, free)</option></select></label>
          <div class="ai-wide ai-localvoice" data-role="p-localvoice"></div>
          <label class="ai-check"><input type="checkbox" data-role="p-captions" /> Captions / lyrics on video</label>
          <label class="ai-check"><input type="checkbox" data-role="p-music" /> Background music</label>
        </div>
      </details>
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
    this.trayEl = this.q('[data-role="ai-tray"]');
    this.projEl = this.q('[data-role="ai-project"]');

    this.q('[data-role="ai-close"]').addEventListener('click', () => this.close());
    this.q('[data-role="ai-new"]').addEventListener('click', () => this.newProject());
    this.sendBtn.addEventListener('click', () => { if (this.busy) this.abort?.abort(); else void this.submit(); });
    this.input.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void this.submit(); }
    });
    this.wireAttachments();
    this.wireTune();
    this.wireByok();
    this.renderTray();
    this.renderProject();
  }

  // ---- shell hooks ---------------------------------------------------------
  private q<T extends HTMLElement>(sel: string): T { return this.el.querySelector(sel) as T; }
  get isOpen(): boolean { return this.el.classList.contains('open'); }
  toggle(): void { this.isOpen ? this.close() : this.open(); }
  open(): void { this.el.classList.add('open'); document.body.classList.add('ai-open'); this.refresh(); this.input.focus(); }
  close(): void { this.el.classList.remove('open'); document.body.classList.remove('ai-open'); }
  /** Re-read the current editor target and update suggestions/hint. */
  refresh(): void { this.refreshHint(); }

  private refreshHint(): void {
    const target = this.opts.resolve();
    const byok = loadByok();
    if (!this.opts.isAuthed()) {
      this.hintEl.innerHTML = 'Melody-only music works free, offline, no sign-in. Everything else needs an account — <button class="ai-link" data-role="ai-signin">sign in</button> for free daily credits.';
      this.q('[data-role="ai-signin"]')?.addEventListener('click', () => this.opts.onSignIn());
    } else {
      this.hintEl.textContent = (target ? `Open: ${target.label ?? target.kind} — I can edit it or create something new. ` : 'Describe what you want; add files if it should use them. ')
        + (byok?.key ? 'Unlimited (your key).' : `Free: ${GEN_DAILY_UNITS} creation credits + 10 edits per day.`);
    }
    this.chipsEl.innerHTML = '';
    const chips = [...(target ? SUGGESTIONS[target.kind].slice(0, 3) : []), ...CREATE_IDEAS.slice(0, target ? 3 : 5)];
    for (const s of chips) {
      const b = button(s, 'ai-chip', () => { this.input.value = s; this.input.focus(); });
      this.chipsEl.appendChild(b);
    }
  }

  // ---- attachments -----------------------------------------------------------
  private wireAttachments(): void {
    this.q<HTMLInputElement>('[data-role="ai-files"]').addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      const files = [...(input.files ?? [])]; input.value = '';
      void this.addFiles(files.map((f) => ({ blob: f as Blob, name: f.name })));
    });
    const list = this.q('[data-role="ai-liblist"]');
    this.q('[data-role="ai-lib"]').addEventListener('click', async () => {
      if (!list.hidden) { list.hidden = true; return; }
      list.innerHTML = '<p class="ai-quota">Loading…</p>'; list.hidden = false;
      const items = ((await this.opts.listLibrary?.()) ?? []).filter((f) => ['image', 'audio', 'video', 'text', 'code', 'json', 'markdown', 'document', 'spreadsheet'].includes(f.kind)).slice(0, 60);
      list.innerHTML = '';
      if (!items.length) { list.innerHTML = '<p class="ai-quota">No usable files in your library yet.</p>'; return; }
      for (const f of items) {
        list.appendChild(button(`${f.name} · ${f.kind}`, 'ai-libitem', () => {
          list.hidden = true;
          void (async () => { try { await this.addFiles([{ blob: await this.opts.readLibrary!(f.id), name: f.name }]); } catch { this.addMsg('error', 'Could not read that file.'); } })();
        }));
      }
    });
    this.q('[data-role="ai-openfile"]').addEventListener('click', async () => {
      const f = await this.opts.openFile?.();
      if (!f) { this.addMsg('system', 'No file is open.'); return; }
      await this.addFiles([f]);
    });
  }

  private async addFiles(files: { blob: Blob; name: string }[]): Promise<void> {
    for (const f of files) {
      if (this.attachments.length >= MAX_ATTACHMENTS) { this.addMsg('system', `Up to ${MAX_ATTACHMENTS} files at a time.`); break; }
      if (f.blob.size > 60_000_000) { this.addMsg('error', `“${f.name}” is too large (60 MB max).`); continue; }
      if (kindOfFile(f.name, f.blob.type) === 'other') { this.addMsg('system', `“${f.name}” isn’t a type I can use (photos, audio, video, text, docs).`); continue; }
      const note = this.addMsg('system', `Reading “${f.name}” on your device…`);
      try { this.attachments.push(await loadAttachment(f.blob, f.name, `a${this.nextId++}`)); note.remove(); }
      catch (e) { reportFailure('ai-attach', e, kindOfFile(f.name, f.blob.type)); note.textContent = `Couldn’t read “${f.name}”.`; note.className = 'ai-msg ai-msg-error'; }
      this.renderTray();
    }
  }

  private renderTray(): void {
    this.trayEl.innerHTML = '';
    this.trayEl.hidden = !this.attachments.length;
    for (const a of this.attachments) {
      const chip = el('span', 'ai-att');
      if (a.dataUrl || a.frames?.[0]) { const im = el('img'); im.src = a.dataUrl ?? a.frames![0]!; im.alt = ''; chip.appendChild(im); }
      else chip.appendChild(el('span', 'ai-att-kind', a.info.kind));
      const t = el('span', 'ai-att-name', a.info.name); t.title = a.info.summary ?? a.info.name; chip.appendChild(t);
      const x = button('×', 'ai-att-x', () => { this.attachments = this.attachments.filter((z) => z !== a); this.renderTray(); });
      x.setAttribute('aria-label', `Remove ${a.info.name}`); chip.appendChild(x);
      this.trayEl.appendChild(chip);
    }
  }

  // ---- tune ----------------------------------------------------------------
  private wireTune(): void {
    const set = (role: string, v: string | boolean) => {
      const n = this.q<HTMLInputElement | HTMLSelectElement>(`[data-role="${role}"]`);
      if (typeof v === 'boolean') (n as HTMLInputElement).checked = v; else n.value = v;
    };
    const p = this.prefs;
    set('p-output', p.output); set('p-length', p.length); set('p-language', p.language); set('p-aspect', p.aspect);
    set('p-pace', p.pace); set('p-motion', p.motion); set('p-style', p.style); set('p-voice', p.voice);
    set('p-captions', p.captions); set('p-music', p.music);
    const read = () => {
      const g = (r: string) => this.q<HTMLInputElement | HTMLSelectElement>(`[data-role="${r}"]`);
      this.prefs = {
        output: g('p-output').value as Prefs['output'], length: g('p-length').value as Prefs['length'], language: g('p-language').value,
        aspect: g('p-aspect').value as Prefs['aspect'], pace: g('p-pace').value as Prefs['pace'], motion: g('p-motion').value as Prefs['motion'],
        style: g('p-style').value, voice: g('p-voice').value as Prefs['voice'],
        captions: (g('p-captions') as HTMLInputElement).checked, music: (g('p-music') as HTMLInputElement).checked,
      };
      savePrefs(this.prefs);
    };
    for (const r of ['p-output', 'p-length', 'p-language', 'p-aspect', 'p-pace', 'p-motion', 'p-style', 'p-voice', 'p-captions', 'p-music']) {
      this.q(`[data-role="${r}"]`).addEventListener('change', () => { read(); if (r === 'p-voice') void this.onVoiceChoice(); });
    }
    this.renderLocalVoice();
  }

  private renderLocalVoice(busy?: string): void {
    const box = this.q('[data-role="p-localvoice"]'); box.innerHTML = '';
    if (!localVoiceSupported()) { box.appendChild(el('p', 'ai-quota', 'On-device voice needs a browser with WebAssembly.')); return; }
    const status = el('span', 'ai-quota', busy ?? (localVoiceLoaded() || localVoiceInstalled() ? 'On-device voice downloaded — works offline (English).' : 'Optional: download a small speech model (~90 MB, English) once to sing/narrate offline with no credits. Experimental.'));
    box.appendChild(status);
    if (!busy && !localVoiceLoaded() && !localVoiceInstalled()) box.appendChild(button('Download voice', 'ai-ghost', () => void this.downloadVoice()));
  }

  private async downloadVoice(): Promise<void> {
    try {
      await loadLocalVoice((f, l) => this.renderLocalVoice(`${l} ${Math.round(f * 100)}%`));
      this.renderLocalVoice();
    } catch (e) {
      reportFailure('ai-local-voice', e, 'audio');
      this.renderLocalVoice('Couldn’t load the on-device voice here — the cloud voice will be used.');
    }
  }
  private async onVoiceChoice(): Promise<void> {
    if (this.prefs.voice === 'local' && !localVoiceLoaded() && !localVoiceInstalled()) await this.downloadVoice();
  }

  // ---- byok ----------------------------------------------------------------
  private wireByok(): void {
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

  // ---- project memory --------------------------------------------------------
  private renderProject(): void {
    const p = this.project;
    this.projEl.hidden = !p?.parts.length;
    if (!p?.parts.length) return;
    this.projEl.innerHTML = '';
    this.projEl.append(el('span', '', `Project “${p.title}” · ${p.parts.length} part${p.parts.length > 1 ? 's' : ''} remembered`));
    this.projEl.append(button(this.continueNext ? 'Continuing ✓' : 'Continue it', 'ai-link', () => this.startContinue()));
  }
  private startContinue(): void {
    if (!this.project?.parts.length) return;
    this.continueNext = true;
    this.input.placeholder = 'What happens next? (leave empty to just continue)';
    this.renderProject(); this.input.focus();
  }
  private newProject(): void {
    this.project = null; saveProject(null); this.continueNext = false; this.lastIntent = null;
    this.session = { audio: null, videos: [] };
    this.urls.forEach((u) => URL.revokeObjectURL(u)); this.urls = []; this.log.innerHTML = '';
    this.input.placeholder = 'Ask for anything — edit this file, write a song, tell a story, make a video…';
    this.renderProject();
    this.addMsg('system', 'Fresh start — earlier parts forgotten.');
  }

  // ---- log helpers -------------------------------------------------------------
  private addMsg(role: 'user' | 'assistant' | 'system' | 'error', text: string): HTMLElement {
    const m = el('div', `ai-msg ai-msg-${role}`, text);
    this.log.appendChild(m);
    this.log.scrollTop = this.log.scrollHeight;
    return m;
  }
  private addCard(c: HTMLElement): void { this.log.appendChild(c); this.log.scrollTop = this.log.scrollHeight; }

  private planCard(plan: Plan): PlanCard {
    const root = el('div', 'ai-card-plan');
    const i = plan.intent;
    const what = i.intent === 'song' ? `${INTENT_LABEL.song} — ${SONG_LABEL[i.songMode]}` : INTENT_LABEL[i.intent] ?? i.intent;
    root.appendChild(el('div', 'ai-plan-head', `${what}${i.continue ? ' · continuing' : ''}${plan.units ? ` · ~${plan.units} credits` : ' · free'}`));
    if (i.reason) root.appendChild(el('div', 'ai-quota', i.reason));
    const ol = el('ol', 'ai-plan-steps');
    const rows = new Map<StepType, HTMLElement>();
    for (const s of plan.steps as PlanStep[]) {
      const li = el('li', 'pending'); li.append(el('span', 'dot'), el('span', '', s.label));
      if (s.cloud) li.appendChild(el('em', '', s.units ? `${s.units}c` : 'cloud'));
      ol.appendChild(li); rows.set(s.type, li);
    }
    root.appendChild(ol);
    if (plan.sendsOut.length) root.appendChild(el('div', 'ai-quota', `Leaves your device: ${plan.sendsOut.join(', ')}. Audio, video and your files stay here.`));
    const bar = el('progress', 'ai-progress'); bar.max = 1; bar.value = 0; bar.hidden = true;
    const label = el('div', 'ai-quota ai-progress-label'); label.setAttribute('aria-live', 'polite');
    const actions = el('div', 'ai-plan-actions'); const noteEl = el('div', 'ai-quota');
    root.append(bar, label, noteEl, actions);
    this.addCard(root);
    return {
      root,
      step: (type, state) => { const r = rows.get(type); if (r) r.className = state === 'run' ? 'running' : state; },
      progress: (f, l) => { bar.hidden = false; bar.value = Math.max(0, Math.min(1, f)); label.textContent = l; },
      setActions: (...b) => { actions.replaceChildren(...b); },
      note: (t) => { noteEl.textContent = t; },
    };
  }

  // ---- the main flow --------------------------------------------------------------
  private routeContext(target: AiTarget | null): RouteContext {
    return {
      attachments: this.attachments.map((a) => a.info),
      editor: target ? { kind: target.kind, label: target.label } : null,
      previous: contextFor(this.project) || undefined,
    };
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    let text = this.input.value.trim();
    const continuing = this.continueNext && !!this.project?.parts.length;
    if (!text && continuing) text = 'Continue with the next part.';
    if (!text) { this.input.focus(); return; }
    this.lastPrompt = text;
    this.addMsg('user', text + (this.attachments.length ? `\n📎 ${this.attachments.map((a) => a.info.name).join(', ')}` : ''));
    this.input.value = '';
    this.busy = true; this.setSendState(true);
    try {
      const target = this.opts.resolve();
      const ctx = this.routeContext(target);
      let intent: RoutedIntent;
      if (continuing && text === 'Continue with the next part.' && this.lastIntent) {
        intent = { ...this.lastIntent, continue: true, theme: `${this.lastIntent.theme} — next part` };
      } else {
        let routed: RoutedIntent | null = null;
        if (this.opts.isAuthed()) {
          const thinking = this.addMsg('assistant', 'Understanding your request…');
          try { routed = (await aiRoute(text, ctx, loadByok())).intent; } catch (e) { if (!(e instanceof AiError && e.code === 'unauthorized')) reportFailure('ai-route', e, 'route'); }
          thinking.remove();
        }
        intent = routed ?? heuristicIntent(text, ctx);
      }
      intent = applyPrefs(intent, this.prefs);
      if (intent.intent === 'edit' && !target) intent = { ...intent, intent: 'text' };
      if (!intent.useAttachments.length) intent.useAttachments = this.attachments.map((a) => a.info.id);
      intent.continue = (intent.continue || continuing) && !!this.project?.parts.length;
      this.lastIntent = intent;

      const byok = loadByok();
      const plan = buildPlan(intent, this.prefs, {
        byok: !!byok?.key && !byok.key.startsWith('sk-ant-'),
        localVoice: localVoiceInstalled() || localVoiceLoaded(),
        attachments: this.attachments.map((a) => a.info) as AttachmentInfo[],
      });
      await this.confirmAndRun(plan, target);
    } catch (e) {
      this.addMsg('error', this.describeError(e));
      reportFailure('ai-studio', e, this.lastIntent?.intent ?? 'unknown');
    } finally {
      this.busy = false; this.setSendState(false); this.continueNext = false; this.renderProject();
      this.input.placeholder = 'Ask for anything — edit this file, write a song, tell a story, make a video…';
    }
  }

  private setSendState(running: boolean): void {
    this.sendBtn.innerHTML = running ? icon('stop', 18) : icon('send', 18);
    this.sendBtn.setAttribute('aria-label', running ? 'Stop' : 'Send');
    this.sendBtn.title = running ? 'Stop' : 'Send';
  }

  private describeError(e: unknown): string {
    if ((e as { name?: string })?.name === 'AbortError') return 'Stopped.';
    if (e instanceof AiError) {
      const m: Record<string, string> = {
        daily_limit: `Today’s free credits are used up. Melody-only music and on-device voice still work free — or add your own key below for unlimited use.`,
        unauthorized: 'Please sign in again.', rate_limited: 'Slow down a moment and retry.', ai_bad_json: 'The AI returned an unexpected result — try rephrasing.',
        too_many_images: 'Too many photos (4 max for analysis).', image_too_large: 'A photo is too large.', llm_failed: 'The writing model didn’t answer — try again.',
      };
      return m[e.code] ?? `AI error: ${e.code}`;
    }
    const msg = (e as Error)?.message ?? '';
    if (/recording_unsupported/.test(msg)) return 'This browser can’t record video — try Chrome, Edge or Safari 16+.';
    if (/song_too_long/.test(msg)) return 'That song came out too long — try “short” or “medium”.';
    if (/voice_failed|no_lyrics|empty_storyboard|image_failed/.test(msg)) return `Something in the pipeline came back empty (${msg}). Try again or tweak the request.`;
    return `Couldn’t finish (${msg || 'error'}). Check your connection and try again.`;
  }

  private async confirmAndRun(plan: Plan, target: AiTarget | null): Promise<void> {
    const card = this.planCard(plan);
    const authed = this.opts.isAuthed();
    if (plan.needsAuth && !authed) {
      card.note('This needs a free account.');
      card.setActions(button('Sign in', 'ai-go', () => this.opts.onSignIn()));
      return;
    }
    const auto = plan.units <= AUTO_RUN_UNITS || !!loadByok()?.key;
    if (!auto) {
      await new Promise<void>((resolve, reject) => {
        card.note(`This will use about ${plan.units} of your ${GEN_DAILY_UNITS} daily credits.`);
        card.setActions(
          button('Start', 'ai-go', () => { card.setActions(); resolve(); }),
          button('Cancel', 'ai-ghost', () => { card.setActions(); card.note('Cancelled.'); reject(new DOMException('cancelled', 'AbortError')); }),
        );
      });
    }
    await this.execute(plan, card, target);
  }

  private async execute(plan: Plan, card: PlanCard, target: AiTarget | null): Promise<void> {
    const ac = new AbortController(); this.abort = ac;
    card.setActions(button('Stop', 'ai-ghost', () => ac.abort()));
    const i = plan.intent;
    try {
      const { runPlan } = await import('../ai/agentRun');
      const res = await runPlan({
        plan, prefs: this.prefs, byok: loadByok(), signal: ac.signal, attachments: this.attachments,
        project: this.project, context: i.continue ? contextFor(this.project) : '',
        previousAudio: i.continue ? this.session.audio : null,
        step: (t, s) => card.step(t, s), progress: (f, l) => card.progress(f, l),
        edit: target ? async (instruction) => {
          const result = await aiEdit({ kind: target.kind, instruction, content: target.getText?.(), meta: target.meta }, loadByok());
          const summary = (await target.apply(result)) || 'Applied.';
          target.onChanged?.();
          return `${summary} · ${result.provider}`;
        } : undefined,
      });
      card.progress(1, 'Done'); card.setActions();
      if (res.notes.length) card.note(res.notes.join(' '));
      this.afterRun(res, plan);
    } catch (e) {
      card.setActions();
      card.note(this.describeError(e));
      if (!(e instanceof AiError) && (e as { name?: string })?.name !== 'AbortError') reportFailure('ai-run', e, i.intent);
      else if (e instanceof AiError && !['daily_limit', 'unauthorized', 'rate_limited'].includes(e.code)) reportFailure('ai-run', e, i.intent);
      card.setActions(button('Try again', 'ai-ghost', () => { this.input.value = this.lastPrompt; void this.submit(); }));
    } finally { this.abort = null; }
  }

  // ---- results ---------------------------------------------------------------------
  private afterRun(res: RunResult, plan: Plan): void {
    const i = plan.intent;
    if (res.memory) {
      this.project = addPart(this.project, res.memory.part, { style: res.memory.style, characters: res.memory.characters });
      this.renderProject();
    }
    const audio = res.artifacts.find((a) => a.buffer && a.label !== 'Full version (all parts)') ?? res.artifacts.find((a) => a.buffer);
    const full = res.artifacts.find((a) => a.label.startsWith('Full version'));
    if (audio?.buffer) this.session.audio = full?.buffer ?? audio.buffer;
    const vid = res.artifacts.find((a) => a.kind === 'video' && a.blob);
    if (vid?.blob) this.session.videos = i.continue ? [...this.session.videos, { blob: vid.blob, aspect: vid.aspect }] : [{ blob: vid.blob, aspect: vid.aspect }];

    const wrap = el('div', 'ai-card-result');
    wrap.appendChild(el('div', 'ai-msg ai-msg-assistant ok', `✓ ${res.summary}`));
    for (const a of res.artifacts) wrap.appendChild(this.artifactView(a));

    const row = el('div', 'ai-reel-actions');
    if (res.memory) row.appendChild(button('Continue →', 'ai-ghost', () => this.startContinue()));
    if (audio && (i.intent === 'song' || i.intent === 'story_audio')) {
      row.appendChild(button('Make a video for this', 'ai-ghost', () => void this.attachArtifactAndPrompt(audio, i.intent === 'song' ? 'Make a music video for this song' : 'Make a video for this story')));
    }
    const txt = res.artifacts.find((a) => a.kind === 'text' && a.label === 'Text');
    if (txt) row.appendChild(button('Read it aloud', 'ai-ghost', () => void this.attachArtifactAndPrompt(txt, 'Read this aloud')));
    if (i.intent !== 'edit') row.appendChild(button('Redo', 'ai-ghost', () => { this.input.value = this.lastPrompt; void this.submit(); }));
    if (vid && this.session.videos.length > 1) {
      const join = button(`Join all ${this.session.videos.length} parts into one video`, 'ai-ghost');
      join.addEventListener('click', () => void this.joinParts(join, wrap));
      row.appendChild(join);
    }
    if (row.childElementCount) wrap.appendChild(row);
    this.addCard(wrap);
  }

  private async joinParts(btn: HTMLButtonElement, wrap: HTMLElement): Promise<void> {
    btn.disabled = true; btn.textContent = 'Joining… (this runs on your device and can take a minute)';
    try {
      const { joinVideos } = await import('../ai/agentRun');
      const blob = await joinVideos(this.session.videos, (f) => { btn.textContent = `Joining… ${Math.round(f * 100)}%`; });
      btn.remove();
      wrap.appendChild(this.artifactView({ kind: 'video', name: 'joined-video.mp4', label: 'Joined video', blob }));
    } catch (e) {
      reportFailure('ai-join', e, 'video');
      btn.disabled = false; btn.textContent = 'Join failed — keep the parts separate (try again)';
    }
  }

  private async attachArtifactAndPrompt(a: Artifact, prompt: string): Promise<void> {
    const blob = a.blob ?? new Blob([a.text ?? ''], { type: 'text/plain' });
    await this.addFiles([{ blob, name: a.name }]);
    this.input.value = prompt; this.input.focus();
  }

  private artifactView(a: Artifact): HTMLElement {
    const box = el('div', 'ai-artifact');
    box.appendChild(el('div', 'ai-reel-label', a.label));
    let url = '';
    if (a.blob) { url = URL.createObjectURL(a.blob); this.urls.push(url); }
    if (a.kind === 'audio') { const au = el('audio'); au.controls = true; au.src = url; box.appendChild(au); }
    else if (a.kind === 'video') { const v = el('video', 'ai-reel-video'); v.controls = true; v.playsInline = true; v.src = url; box.appendChild(v); }
    else if (a.kind === 'image') { const im = el('img', 'ai-result-img'); im.src = url; im.alt = a.label; box.appendChild(im); }
    else if (a.kind === 'text') { const ta = el('textarea', 'ai-input ai-lyrics'); ta.rows = Math.min(12, Math.max(4, (a.text ?? '').split('\n').length + 1)); ta.value = a.text ?? ''; ta.readOnly = true; box.appendChild(ta); }
    const row = el('div', 'ai-reel-actions');
    const blob = (): Blob => a.blob ?? new Blob([a.text ?? ''], { type: 'text/plain' });
    if (this.opts.saveGenerated) {
      const add = button('Add to library', 'ai-ghost');
      add.addEventListener('click', () => { void (async () => { try { await this.opts.saveGenerated!(a.name, blob().type, blob()); add.textContent = 'Added ✓'; add.disabled = true; } catch { add.textContent = 'Couldn’t add'; } })(); });
      row.appendChild(add);
    }
    row.appendChild(button('Download', 'ai-ghost', () => {
      const link = document.createElement('a'); const u = URL.createObjectURL(blob()); link.href = u; link.download = a.name; link.click();
      setTimeout(() => URL.revokeObjectURL(u), 5000);
    }));
    if (a.kind === 'text') {
      const copy = button('Copy', 'ai-ghost');
      copy.addEventListener('click', () => { void navigator.clipboard?.writeText(a.text ?? '').then(() => { copy.textContent = 'Copied ✓'; setTimeout(() => { copy.textContent = 'Copy'; }, 1500); }); });
      row.appendChild(copy);
    }
    box.appendChild(row);
    return box;
  }
}
