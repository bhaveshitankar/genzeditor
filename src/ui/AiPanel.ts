import './styles/ai.css';
import { aiEdit, AiError, type AiEditResult, type AiKind, type ByoKey } from '../api/client';
import { icon } from './icons';
import { reportFailure } from '../telemetry';

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
