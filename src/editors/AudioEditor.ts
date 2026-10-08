import './styles/audio.css';
import type { DocEditor } from './registry';
import { type EditCommands, getAppClipboard, setAppClipboard } from './editCommands';

// Client-side, audiomass.co-inspired audio editor built on the Web Audio API —
// no heavy dependencies. It keeps one editable in-memory AudioBuffer that all
// edit ops / effects mutate, with an undo/redo history. Features: interactive
// waveform (drag-select, edge-drag, playhead, ruler, horizontal zoom), cut /
// copy / paste / delete / crop / silence / insert-silence / trim, effects
// (gain, normalize, fade, reverb, echo, speed, low/high-pass), loop playback,
// mic record (append/insert), and WAV export (+ optional lazy MP3 encoder).
// Exposed through DocEditor so the shell's Download / Share / Save paths work.

type ExportFmt = 'wav' | 'mp3';

// AI op shape emitted by the backend (see worker/src/ai.ts audio system prompt).
export type AiAudioOp =
  | { t: 'gain'; mult: number }
  | { t: 'normalize' }
  | { t: 'fade'; dir: 'in' | 'out' }
  | { t: 'reverse' }
  | { t: 'trim' }
  | { t: 'reverb'; secs: number }
  | { t: 'echo'; time: number }
  | { t: 'filter'; kind: 'lowpass' | 'highpass'; freq: number }
  | { t: 'speed'; rate: number };

// Multitrack model: tracks hold clips; a clip plays [offset, offset+dur) of its
// (immutable) buffer at timeline time `start`. Clips on one track play in
// sequence, tracks play in parallel and are mixed.
interface MClip {
  id: string;
  name: string;
  buffer: AudioBuffer;
  start: number;
  offset: number;
  dur: number;
  gain: number;
  fadeIn: number;
  fadeOut: number;
}
interface MTrack { id: string; name: string; clips: MClip[]; gain: number; mute: boolean; solo: boolean; }
interface Snapshot { tracks: MTrack[]; sel: string | null; }
type MtDrag =
  | { kind: 'seek' }
  | { kind: 'move'; id: string; x0: number; start0: number; hist: boolean }
  | { kind: 'trim'; id: string; side: 'l' | 'r'; x0: number; start0: number; offset0: number; dur0: number; hist: boolean };

let mtSeq = 0;
const mtId = (): string => `m${Date.now().toString(36)}${(++mtSeq).toString(36)}`;
const peakCache = new WeakMap<AudioBuffer, Float32Array>();
const PEAKS_PER_SEC = 200;

export class AudioEditor implements DocEditor {
  private host: HTMLElement;
  private ctx: AudioContext;
  private buffer: AudioBuffer | null = null;

  // Multitrack timeline state.
  private tracks: MTrack[] = [];
  private selId: string | null = null;
  private origBlob: Blob | null = null;
  private origBuffer: AudioBuffer | null = null;
  private fmtChosen = false;
  private mixT = 0;
  private mtZoom = 1;
  private snapOn = true;
  private mtPps = 50;
  private mtDrag: MtDrag | null = null;
  private mixSources: AudioBufferSourceNode[] = [];
  private mixPlaying = false;
  private mixCtxStart = 0;
  private mixFrom = 0;
  private mixRaf = 0;
  private sliderSession = false;
  private mtHeads!: HTMLElement;
  private mtScroll!: HTMLElement;
  private mtInner!: HTMLElement;
  private mtProps!: HTMLElement;
  private mtPlayhead: HTMLElement | null = null;
  // Copied audio lives in the shared app clipboard so it can be pasted into another audio file.
  private get clipboard(): AudioBuffer | null { return getAppClipboard<AudioBuffer>('audio-buffer'); }
  private onChange: () => void;

  // Selection + playhead in seconds. selStart === selEnd means "no region".
  private selStart = 0;
  private selEnd = 0;
  private playhead = 0;

  // View: horizontal zoom expressed as pixels-per-second.
  private basePps = 0;          // pps that fits the whole clip at zoom 1
  private zoom = 1;

  // History of buffer snapshots (working buffer copies).
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  // Playback / recording lifecycle.
  private source: AudioBufferSourceNode | null = null;
  private playCtxStart = 0;     // ctx.currentTime when playback began
  private playOffset = 0;       // buffer offset playback began at
  private looping = false;
  private raf = 0;
  private recorder: MediaRecorder | null = null;
  private recStream: MediaStream | null = null;
  private recInsert = true;     // insert at the cursor vs append at end
  private recPending = false;   // waiting on the mic permission prompt
  private recCancelled = false;

  private exportFmt: ExportFmt = 'wav';

  // DOM refs.
  private scrollEl!: HTMLElement;
  private trackEl!: HTMLElement;
  private ruler!: HTMLCanvasElement;
  private canvas!: HTMLCanvasElement;
  private statusEl!: HTMLElement;

  // Drag state.
  private drag: { mode: 'new' | 'start' | 'end' } | null = null;

  private constructor(host: HTMLElement, onChange: () => void) {
    this.host = host;
    this.onChange = onChange;
    this.ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }

  static async open(host: HTMLElement, blob: Blob, onChange: () => void): Promise<AudioEditor> {
    const ed = new AudioEditor(host, onChange);
    ed.renderShell();
    if (blob.size > 0) {
      try {
        const buf = await ed.ctx.decodeAudioData(await blob.arrayBuffer());
        ed.origBlob = blob;
        ed.origBuffer = buf;
        ed.setBuffer(buf, false);
      } catch {
        ed.setStatus('Could not decode this audio — try recording or uploading a WAV/MP3.');
      }
    } else {
      ed.setStatus('Empty clip — press ● Record to capture audio.');
    }
    window.addEventListener('resize', ed.onResize);
    document.addEventListener('keydown', ed.onKey);
    document.addEventListener('pointermove', ed.onMtMove);
    document.addEventListener('pointerup', ed.onMtUp);
    ed.renderTimeline();
    ed.renderProps();
    return ed;
  }

  destroy(): void {
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('keydown', this.onKey);
    document.removeEventListener('pointermove', this.onMtMove);
    document.removeEventListener('pointerup', this.onMtUp);
    this.stopMix();
    cancelAnimationFrame(this.raf);
    this.stopPlayback();
    this.stopRecording();
    void this.ctx.close().catch(() => {});
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    const clips = this.allClips();
    if (!clips.length) return null;
    if (this.isUntouched() && this.origBlob && !this.fmtChosen) {
      return { blob: this.origBlob, contentType: this.origBlob.type || 'audio/wav' };
    }
    const mixed = await this.renderMix();
    if (this.exportFmt === 'mp3') {
      const mp3 = await encodeMp3(mixed).catch(() => null);
      if (mp3) return { blob: mp3, contentType: 'audio/mpeg' };
      this.setStatus('MP3 encoder unavailable — exported WAV instead.');
    }
    return { blob: encodeWav(mixed), contentType: 'audio/wav' };
  }

  private isUntouched(): boolean {
    const t = this.tracks[0];
    const c = t?.clips[0];
    return this.tracks.length === 1 && !!t && t.clips.length === 1 && !!c && c.buffer === this.origBuffer &&
      c.start === 0 && c.offset === 0 && Math.abs(c.dur - c.buffer.duration) < 1e-6 && c.gain === 1 &&
      c.fadeIn === 0 && c.fadeOut === 0 && t.gain === 1 && !t.mute;
  }

  private async renderMix(): Promise<AudioBuffer> {
    const total = Math.max(0.05, this.mixTotal());
    const sr = this.allClips()[0]?.buffer.sampleRate || 44100;
    const oac = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
    this.scheduleMix(oac, oac.destination, 0, 0);
    return oac.startRendering();
  }

  // ---- buffer / view state -------------------------------------------------

  // Replace the selected clip's audio (all clip-editor ops funnel through here).
  private setBuffer(buf: AudioBuffer, pushHistory = true) {
    if (pushHistory) this.pushHistory();
    const c = this.selClip();
    this.stopMix();
    if (c) {
      // The clip editor works on the clip's visible window (see clipView), so the
      // edited buffer simply becomes the whole clip.
      c.buffer = buf;
      c.offset = 0;
      c.dur = buf.duration;
    } else {
      if (!this.tracks.length) this.tracks.push(this.newTrack());
      const nc = this.newClip(buf, 'Clip 1', 0);
      this.tracks[0]!.clips.push(nc);
      this.selId = nc.id;
    }
    this.buffer = buf;
    if (this.selEnd > buf.duration || this.selEnd === 0) { this.selStart = 0; this.selEnd = 0; }
    this.playhead = Math.min(this.playhead, buf.duration);
    this.fitZoom();
    this.redraw();
    this.updateButtons();
    this.setStatus(`${fmt(buf.duration)} · ${buf.numberOfChannels}ch · ${(buf.sampleRate / 1000).toFixed(1)}kHz`);
    this.mixT = Math.min(this.mixT, this.mixTotal());
    this.renderTimeline();
    this.renderProps();
    this.onChange();
  }

  // What the clip editor (lower waveform) shows for a clip: the part of its
  // buffer that is actually audible after splits/trims, not the raw source.
  private clipView(c: MClip | null): AudioBuffer | null {
    if (!c) return null;
    const whole = c.offset < 1e-6 && Math.abs(c.dur - c.buffer.duration) < 1e-3;
    return whole ? c.buffer : sliceBuffer(this.ctx, c.buffer, c.offset, c.offset + c.dur);
  }

  // Re-point the clip editor at the selected clip's current window and redraw.
  private syncView() {
    this.buffer = this.clipView(this.selClip());
    const d = this.buffer?.duration ?? 0;
    if (this.selEnd > d) { this.selStart = 0; this.selEnd = 0; }
    this.playhead = Math.min(this.playhead, d);
    this.fitZoom();
    this.redraw();
  }

  private fitZoom() {
    const w = this.scrollEl.clientWidth || 600;
    const d = this.buffer?.duration || 1;
    this.basePps = w / d;
  }

  private get pps() { return this.basePps * this.zoom; }

  private onResize = () => { if (!this.buffer) return; this.fitZoom(); this.redraw(); };

  // ---- shell ---------------------------------------------------------------

  private renderShell() {
    this.host.innerHTML = `
      <div class="aud-editor">
        <div class="amt">
          <div class="amt-bar">
            <button type="button" class="aud-btn aud-primary" data-mt="play" title="Play the whole mix (Space)">▶ Play mix</button>
            <button type="button" class="aud-btn" data-mt="stop">■</button>
            <span class="amt-time" data-role="mtTime">0:00.0</span>
            <button type="button" class="aud-btn" data-mt="append" title="Add audio after the last clip of the selected track (sequential merge)">+ Add audio (append)</button>
            <button type="button" class="aud-btn" data-mt="addtrack" title="Add audio on a new track at the playhead (parallel mix)">+ Add track (mix)</button>
            <button type="button" class="aud-btn" data-mt="split" title="Split clip at playhead (S)">✂ Split</button>
            <button type="button" class="aud-btn" data-mt="del" title="Delete selected clip (Del)">Delete clip</button>
            <button type="button" class="aud-btn" data-mt="undo" title="Undo (Ctrl/Cmd+Z)">↶</button>
            <button type="button" class="aud-btn" data-mt="redo" title="Redo">↷</button>
            <button type="button" class="aud-btn" data-mt="zout" title="Zoom out timeline">−</button>
            <button type="button" class="aud-btn" data-mt="zin" title="Zoom in timeline">+</button>
            <button type="button" class="aud-btn" data-mt="zfit">Fit</button>
            <button type="button" class="aud-btn active" data-mt="snap" title="Snap clips to the playhead and other clip edges">Snap</button>
            <input type="file" accept="audio/*,video/*" multiple data-role="mtAppend" hidden>
            <input type="file" accept="audio/*,video/*" multiple data-role="mtTrack" hidden>
          </div>
          <div class="amt-body">
            <div class="amt-heads" data-role="mtHeads"></div>
            <div class="amt-scroll" data-role="mtScroll"><div class="amt-inner" data-role="mtInner"></div></div>
          </div>
          <div class="amt-props" data-role="mtProps"></div>
        </div>
        <div class="aud-clip-title" data-role="clipTitle">Clip editor</div>
        <div class="aud-toolbar" data-role="toolbar">
          <div class="aud-group">
            <button type="button" class="aud-btn aud-primary" data-act="play">▶ Play clip</button>
            <button type="button" class="aud-btn" data-act="stop">■ Stop</button>
            <button type="button" class="aud-btn" data-act="loop" title="Loop selection">⟳ Loop</button>
          </div>
          <div class="aud-group">
            <span class="aud-group-label">Edit</span>
            <button type="button" class="aud-btn" data-act="undo" title="Undo">↶</button>
            <button type="button" class="aud-btn" data-act="redo" title="Redo">↷</button>
            <button type="button" class="aud-btn" data-act="cut">Cut</button>
            <button type="button" class="aud-btn" data-act="copy">Copy</button>
            <button type="button" class="aud-btn" data-act="paste">Paste</button>
            <button type="button" class="aud-btn" data-act="delete">Delete</button>
            <button type="button" class="aud-btn" data-act="crop">Crop</button>
            <button type="button" class="aud-btn" data-act="trim">Trim</button>
            <button type="button" class="aud-btn" data-act="silence">Silence</button>
            <button type="button" class="aud-btn" data-act="insil">Insert 1s</button>
          </div>
          <div class="aud-group">
            <span class="aud-group-label">Effects</span>
            <button type="button" class="aud-btn" data-act="gain">Gain</button>
            <button type="button" class="aud-btn" data-act="normalize">Normalize</button>
            <button type="button" class="aud-btn" data-act="fadein">Fade in</button>
            <button type="button" class="aud-btn" data-act="fadeout">Fade out</button>
            <button type="button" class="aud-btn" data-act="reverb">Reverb</button>
            <button type="button" class="aud-btn" data-act="echo">Echo</button>
            <button type="button" class="aud-btn" data-act="speed">Speed</button>
            <button type="button" class="aud-btn" data-act="lowpass">Low-pass</button>
            <button type="button" class="aud-btn" data-act="highpass">High-pass</button>
            <button type="button" class="aud-btn" data-act="reverse">Reverse</button>
          </div>
          <div class="aud-group">
            <span class="aud-group-label">Zoom</span>
            <button type="button" class="aud-btn" data-act="zoomout">−</button>
            <button type="button" class="aud-btn" data-act="zoomin">+</button>
            <button type="button" class="aud-btn" data-act="zoomfit">Fit</button>
            <button type="button" class="aud-btn" data-act="selall">Select all</button>
          </div>
          <div class="aud-group">
            <span class="aud-group-label">Record</span>
            <button type="button" class="aud-btn aud-rec" data-act="rec">● Record</button>
            <button type="button" class="aud-btn" data-act="recmode" title="Record at the cursor (Insert) or after the end (Append)">Insert</button>
          </div>
          <div class="aud-group">
            <span class="aud-group-label">Export</span>
            <button type="button" class="aud-btn active" data-act="fmtwav">WAV</button>
            <button type="button" class="aud-btn" data-act="fmtmp3">MP3</button>
          </div>
        </div>
        <div class="aud-scroll" data-role="scroll">
          <div class="aud-track" data-role="track">
            <canvas class="aud-ruler" data-role="ruler"></canvas>
            <canvas class="aud-wave" data-role="wave"></canvas>
          </div>
        </div>
        <div class="aud-status" data-role="status"></div>
      </div>`;

    this.scrollEl = this.q('scroll');
    this.trackEl = this.q('track');
    this.ruler = this.q('ruler') as HTMLCanvasElement;
    this.canvas = this.q('wave') as HTMLCanvasElement;
    this.statusEl = this.q('status');

    this.q('toolbar').addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest('[data-act]')?.getAttribute('data-act');
      if (act) void this.dispatch(act);
    });
    this.scrollEl.addEventListener('scroll', () => this.redraw());
    this.bindTimeline();
    this.attachPointer();
    this.fitZoom();
  }

  private q(role: string): HTMLElement { return this.host.querySelector(`[data-role="${role}"]`) as HTMLElement; }
  private setStatus(t: string) { if (this.statusEl) this.statusEl.textContent = t; }
  private btn(act: string): HTMLButtonElement | null { return this.host.querySelector(`[data-act="${act}"]`); }

  private updateButtons() {
    const set = (a: string, on: boolean) => { const b = this.btn(a); if (b) b.disabled = !on; };
    set('undo', this.undoStack.length > 0);
    set('redo', this.redoStack.length > 0);
    const mu = this.host.querySelector<HTMLButtonElement>('[data-mt="undo"]');
    const mr = this.host.querySelector<HTMLButtonElement>('[data-mt="redo"]');
    if (mu) mu.disabled = this.undoStack.length === 0;
    if (mr) mr.disabled = this.redoStack.length === 0;
    set('paste', !!this.clipboard);
    this.btn('loop')?.classList.toggle('active', this.looping);
  }

  // ---- command dispatch ----------------------------------------------------

  private async dispatch(act: string) {
    switch (act) {
      case 'play': this.togglePlay(); break;
      case 'stop': this.stopPlayback(); break;
      case 'loop': this.setLooping(!this.looping); break;
      case 'undo': this.undo(); break;
      case 'redo': this.redo(); break;
      case 'cut': this.cut(); break;
      case 'copy': this.copy(); break;
      case 'paste': this.paste(); break;
      case 'delete': this.deleteSel(); break;
      case 'crop': this.crop(); break;
      case 'trim': this.trim(); break;
      case 'silence': this.silence(); break;
      case 'insil': this.insertSilence(1); break;
      case 'gain': this.gain(); break;
      case 'normalize': this.normalize(); break;
      case 'fadein': this.fade(true); break;
      case 'fadeout': this.fade(false); break;
      case 'reverb': await this.reverb(); break;
      case 'echo': await this.echo(); break;
      case 'speed': await this.speed(); break;
      case 'lowpass': await this.filter('lowpass'); break;
      case 'highpass': await this.filter('highpass'); break;
      case 'reverse': this.reverse(); break;
      case 'zoomin': this.setZoom(this.zoom * 1.6); break;
      case 'zoomout': this.setZoom(this.zoom / 1.6); break;
      case 'zoomfit': this.setZoom(1); break;
      case 'selall': if (this.buffer) { this.selStart = 0; this.selEnd = this.buffer.duration; this.redraw(); } break;
      case 'rec': void this.toggleRecord(); break;
      case 'recmode': this.recInsert = !this.recInsert; { const b = this.btn('recmode'); if (b) b.textContent = this.recInsert ? 'Insert' : 'Append'; } break;
      case 'fmtwav': this.fmtChosen = true; this.exportFmt = 'wav'; this.btn('fmtwav')?.classList.add('active'); this.btn('fmtmp3')?.classList.remove('active'); break;
      case 'fmtmp3': this.fmtChosen = true; this.exportFmt = 'mp3'; this.btn('fmtmp3')?.classList.add('active'); this.btn('fmtwav')?.classList.remove('active'); break;
    }
  }

  // Region the ops act on: the selection, or the whole clip when none.
  private region(): { s: number; e: number; whole: boolean } {
    if (this.buffer && this.selEnd - this.selStart > 0.0001) return { s: this.selStart, e: this.selEnd, whole: false };
    return { s: 0, e: this.buffer?.duration || 0, whole: true };
  }

  // ---- edit operations -----------------------------------------------------

  private copy() {
    if (!this.buffer || this.selEnd - this.selStart <= 0) return;
    setAppClipboard('audio-buffer', sliceBuffer(this.ctx, this.buffer, this.selStart, this.selEnd));
    this.updateButtons();
    this.setStatus(`Copied ${fmt(this.selEnd - this.selStart)}`);
  }

  private cut() {
    if (!this.buffer || this.selEnd - this.selStart <= 0) return;
    this.copy();
    this.deleteSel();
  }

  private deleteSel() {
    if (!this.buffer || this.selEnd - this.selStart <= 0) return;
    const before = sliceBuffer(this.ctx, this.buffer, 0, this.selStart);
    const after = sliceBuffer(this.ctx, this.buffer, this.selEnd, this.buffer.duration);
    this.playhead = this.selStart;
    this.selEnd = this.selStart;
    this.setBuffer(concatBuffers(this.ctx, [before, after]));
    this.setStatus('Deleted selection');
  }

  private paste() {
    if (this.clipboard) void this.insertBuffer(this.clipboard);
  }

  // Insert audio at the cursor, replacing the selection if there is one.
  private async insertBuffer(src: AudioBuffer) {
    if (!this.buffer) { this.setBuffer(src); this.selStart = 0; this.selEnd = src.duration; this.redraw(); return; }
    const clip = src.sampleRate === this.buffer.sampleRate ? src : await resample(src, this.buffer.sampleRate);
    const at = this.selEnd - this.selStart > 0 ? this.selStart : this.playhead;
    const before = sliceBuffer(this.ctx, this.buffer, 0, at);
    const after = sliceBuffer(this.ctx, this.buffer, this.selEnd - this.selStart > 0 ? this.selEnd : at, this.buffer.duration);
    const out = concatBuffers(this.ctx, [before, clip, after]);
    this.selStart = at; this.selEnd = at + clip.duration;
    this.setBuffer(out);
    this.setStatus('Pasted');
  }

  // Duplicate the selected region right after itself.
  private duplicateSel() {
    if (!this.buffer || this.selEnd - this.selStart <= 0) return;
    const s = this.selStart, e = this.selEnd;
    const piece = sliceBuffer(this.ctx, this.buffer, s, e);
    const out = concatBuffers(this.ctx, [
      sliceBuffer(this.ctx, this.buffer, 0, e), piece, sliceBuffer(this.ctx, this.buffer, e, this.buffer.duration),
    ]);
    this.selStart = e; this.selEnd = e + (e - s);
    this.setBuffer(out);
    this.setStatus('Duplicated selection');
  }

  private selectAll() {
    if (!this.buffer) return;
    this.selStart = 0; this.selEnd = this.buffer.duration;
    this.redraw();
    this.redrawSelStatus();
  }

  private hasRegion(): boolean { return !!this.buffer && this.selEnd - this.selStart > 0.001; }

  // Shared edit commands; the shell owns the shortcuts and the long-press menu.
  commands(): EditCommands {
    return {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.undoStack.length > 0,
      canRedo: () => this.redoStack.length > 0,
      hasSelection: () => this.hasRegion() || !!this.selClip(),
      canPaste: () => true,
      copy: () => { if (this.hasRegion()) this.copy(); else this.copyClip(); },
      cut: () => {
        if (this.hasRegion()) this.cut();
        else if (this.selClip()) { this.copyClip(); this.deleteClip(); }
      },
      delete: () => { if (this.hasRegion()) this.deleteSel(); else this.deleteClip(); },
      duplicate: () => { if (this.hasRegion()) this.duplicateSel(); },
      selectAll: () => this.selectAll(),
      paste: async (data) => {
        const files = data ? Array.from(data.files).filter((f) => f.type.startsWith('audio/')) : [];
        if (files.length) {
          const decoded = await this.decodeFiles(files);
          for (const d of decoded) await this.insertBuffer(d.buf);
          return;
        }
        this.paste();
      },
    };
  }

  // No region: copy the whole selected clip (its visible part).
  private copyClip() {
    const c = this.selClip();
    if (!c) return;
    setAppClipboard('audio-buffer', sliceBuffer(this.ctx, c.buffer, c.offset, c.offset + c.dur));
    this.updateButtons();
    this.setStatus(`Copied clip (${fmt(c.dur)})`);
  }

  private crop() {
    if (!this.buffer || this.selEnd - this.selStart <= 0) return;
    const out = sliceBuffer(this.ctx, this.buffer, this.selStart, this.selEnd);
    this.selStart = 0; this.selEnd = out.duration; this.playhead = 0;
    this.setBuffer(out);
    this.setStatus('Cropped to selection');
  }

  // Trim: strip near-silence from both ends of the clip.
  private trim() {
    if (!this.buffer) return;
    const thresh = 0.005;
    const d = this.buffer.getChannelData(0);
    let s = 0, e = d.length - 1;
    while (s < e && Math.abs(d[s]!) < thresh) s++;
    while (e > s && Math.abs(d[e]!) < thresh) e--;
    const rate = this.buffer.sampleRate;
    const out = sliceBuffer(this.ctx, this.buffer, s / rate, e / rate);
    this.selStart = 0; this.selEnd = 0; this.playhead = 0;
    this.setBuffer(out);
    this.setStatus('Trimmed silence');
  }

  private silence() {
    if (!this.buffer) return;
    const { s, e } = this.region();
    const next = cloneBuffer(this.ctx, this.buffer);
    const rate = next.sampleRate;
    const a = Math.floor(s * rate), b = Math.floor(e * rate);
    for (let c = 0; c < next.numberOfChannels; c++) next.getChannelData(c).fill(0, a, b);
    this.setBuffer(next);
    this.setStatus('Silenced region');
  }

  private insertSilence(sec: number) {
    if (!this.buffer) return;
    const at = this.playhead;
    const before = sliceBuffer(this.ctx, this.buffer, 0, at);
    const gap = this.ctx.createBuffer(this.buffer.numberOfChannels, Math.floor(sec * this.buffer.sampleRate), this.buffer.sampleRate);
    const after = sliceBuffer(this.ctx, this.buffer, at, this.buffer.duration);
    this.setBuffer(concatBuffers(this.ctx, [before, gap, after]));
    this.setStatus(`Inserted ${sec}s silence`);
  }

  private snap(): Snapshot {
    return { tracks: this.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c })) })), sel: this.selId };
  }

  private pushHistory() {
    this.undoStack.push(this.snap());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.updateButtons();
  }

  private restore(s: Snapshot) {
    this.stopMix();
    this.stopPlayback();
    this.tracks = s.tracks;
    this.selId = s.sel && this.findClip(s.sel) ? s.sel : null;
    this.selStart = this.selEnd = 0;
    this.playhead = 0;
    this.syncView(); this.updateButtons();
    this.renderTimeline(); this.renderProps();
    this.onChange();
  }

  private undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(this.snap());
    this.restore(prev);
    this.setStatus('Undo');
  }

  private redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(this.snap());
    this.restore(next);
    this.setStatus('Redo');
  }

  // ---- sample-domain effects ----------------------------------------------

  private gain() {
    if (!this.buffer) return;
    const g = promptNum('Gain multiplier (e.g. 1.5, 0.5)', 1.5);
    if (g == null) return;
    this.mapRegion((v) => v * g);
    this.setStatus(`Applied gain ×${g}`);
  }

  private normalize() {
    if (!this.buffer) return;
    const { s, e } = this.region();
    const rate = this.buffer.sampleRate;
    const a = Math.floor(s * rate), b = Math.floor(e * rate);
    let peak = 0;
    for (let c = 0; c < this.buffer.numberOfChannels; c++) {
      const d = this.buffer.getChannelData(c);
      for (let i = a; i < b; i++) { const m = Math.abs(d[i]!); if (m > peak) peak = m; }
    }
    if (peak <= 0) return;
    const g = 0.99 / peak;
    this.mapRegion((v) => v * g);
    this.setStatus(`Normalized (×${g.toFixed(2)})`);
  }

  private fade(fadeIn: boolean) {
    if (!this.buffer) return;
    const { s, e } = this.region();
    const rate = this.buffer.sampleRate;
    const a = Math.floor(s * rate), b = Math.floor(e * rate);
    const len = Math.max(1, b - a);
    const next = cloneBuffer(this.ctx, this.buffer);
    for (let c = 0; c < next.numberOfChannels; c++) {
      const d = next.getChannelData(c);
      for (let i = a; i < b; i++) {
        const t = (i - a) / len;
        d[i]! *= fadeIn ? t : 1 - t;
      }
    }
    this.setBuffer(next);
    this.setStatus(fadeIn ? 'Faded in' : 'Faded out');
  }

  private reverse() {
    if (!this.buffer) return;
    const { s, e } = this.region();
    const rate = this.buffer.sampleRate;
    const a = Math.floor(s * rate), b = Math.floor(e * rate);
    const next = cloneBuffer(this.ctx, this.buffer);
    for (let c = 0; c < next.numberOfChannels; c++) {
      const d = next.getChannelData(c);
      for (let i = a, j = b - 1; i < j; i++, j--) { const t = d[i]!; d[i] = d[j]!; d[j] = t; }
    }
    this.setBuffer(next);
    this.setStatus('Reversed region');
  }

  /** Apply a batch of AI-generated audio ops (reuses the DSP helpers). */
  async applyAiOps(ops: AiAudioOp[]): Promise<string> {
    if (!this.buffer) return 'no audio';
    const done: string[] = [];
    for (const op of ops) {
      switch (op.t) {
        case 'gain': {
          const g = Number(op.mult);
          if (g > 0) { this.mapRegion((v) => v * g); done.push(`gain ×${g}`); }
          break;
        }
        case 'normalize': this.normalize(); done.push('normalized'); break;
        case 'fade': this.fade(op.dir === 'in'); done.push(`fade ${op.dir}`); break;
        case 'reverse': this.reverse(); done.push('reversed'); break;
        case 'trim': this.trim(); done.push('trimmed'); break;
        case 'reverb': {
          const secs = Number(op.secs) || 2;
          await this.processRegion((oac, src) => {
            const conv = oac.createConvolver();
            conv.buffer = impulseResponse(oac, secs, 2.5);
            const wet = oac.createGain(); wet.gain.value = 0.6;
            const dry = oac.createGain(); dry.gain.value = 0.7;
            src.connect(dry).connect(oac.destination);
            src.connect(conv).connect(wet).connect(oac.destination);
          });
          done.push('reverb');
          break;
        }
        case 'echo': {
          const time = Number(op.time) || 0.3;
          await this.processRegion((oac, src) => {
            const delay = oac.createDelay(5); delay.delayTime.value = time;
            const fb = oac.createGain(); fb.gain.value = 0.4;
            delay.connect(fb).connect(delay);
            src.connect(oac.destination);
            src.connect(delay).connect(oac.destination);
          }, time * 4);
          done.push('echo');
          break;
        }
        case 'filter': {
          const type = op.kind === 'highpass' ? 'highpass' : 'lowpass';
          const freq = Number(op.freq) || (type === 'lowpass' ? 3000 : 500);
          await this.processRegion((oac, src) => {
            const biq = oac.createBiquadFilter();
            biq.type = type; biq.frequency.value = freq;
            src.connect(biq).connect(oac.destination);
          });
          done.push(`${type} @ ${freq}Hz`);
          break;
        }
        case 'speed': {
          const rate = Number(op.rate);
          if (rate > 0) { await this.speedBy(rate); done.push(`speed ×${rate}`); }
          break;
        }
      }
    }
    return done.join(', ') || 'no changes';
  }

  // Parameterized speed change (shared by the toolbar speed() prompt and AI ops).
  private async speedBy(rate: number) {
    if (!this.buffer || rate <= 0) return;
    const { s, e, whole } = this.region();
    const region = sliceBuffer(this.ctx, this.buffer, s, e);
    const outLen = Math.max(1, Math.ceil(region.length / rate));
    const oac = new OfflineAudioContext(region.numberOfChannels, outLen, region.sampleRate);
    const src = oac.createBufferSource();
    src.buffer = region; src.playbackRate.value = rate;
    src.connect(oac.destination); src.start();
    const rendered = await oac.startRendering();
    if (whole) { this.selStart = this.selEnd = 0; this.setBuffer(rendered); }
    else {
      const before = sliceBuffer(this.ctx, this.buffer, 0, s);
      const after = sliceBuffer(this.ctx, this.buffer, e, this.buffer.duration);
      this.selEnd = this.selStart;
      this.setBuffer(concatBuffers(this.ctx, [before, rendered, after]));
    }
  }

  // Mutate every sample in the active region through fn.
  private mapRegion(fn: (v: number) => number) {
    if (!this.buffer) return;
    const { s, e } = this.region();
    const rate = this.buffer.sampleRate;
    const a = Math.floor(s * rate), b = Math.floor(e * rate);
    const next = cloneBuffer(this.ctx, this.buffer);
    for (let c = 0; c < next.numberOfChannels; c++) {
      const d = next.getChannelData(c);
      for (let i = a; i < b; i++) d[i] = fn(d[i]!);
    }
    this.setBuffer(next);
  }

  // ---- node-graph effects (rendered offline over the active region) --------

  private async reverb() {
    const secs = promptNum('Reverb decay seconds', 2);
    if (secs == null) return;
    await this.processRegion((oac, src) => {
      const conv = oac.createConvolver();
      conv.buffer = impulseResponse(oac, secs, 2.5);
      const wet = oac.createGain(); wet.gain.value = 0.6;
      const dry = oac.createGain(); dry.gain.value = 0.7;
      src.connect(dry).connect(oac.destination);
      src.connect(conv).connect(wet).connect(oac.destination);
    });
    this.setStatus('Reverb applied');
  }

  private async echo() {
    const time = promptNum('Echo delay seconds', 0.3);
    if (time == null) return;
    await this.processRegion((oac, src) => {
      const delay = oac.createDelay(5); delay.delayTime.value = time;
      const fb = oac.createGain(); fb.gain.value = 0.4;
      delay.connect(fb).connect(delay);
      src.connect(oac.destination);
      src.connect(delay).connect(oac.destination);
    }, time * 4);
    this.setStatus('Echo applied');
  }

  private async filter(type: 'lowpass' | 'highpass') {
    const freq = promptNum(`${type} cutoff Hz`, type === 'lowpass' ? 3000 : 500);
    if (freq == null) return;
    await this.processRegion((oac, src) => {
      const biq = oac.createBiquadFilter();
      biq.type = type; biq.frequency.value = freq;
      src.connect(biq).connect(oac.destination);
    });
    this.setStatus(`${type} @ ${freq}Hz`);
  }

  private async speed() {
    const rate = promptNum('Speed factor (2 = 2× faster)', 1.5);
    if (rate == null || rate <= 0) return;
    await this.speedBy(rate);
    this.setStatus(`Speed ×${rate}`);
  }

  // Render the active region through an offline node graph, then splice back.
  // `tail` extends the render length (seconds) so echo/reverb tails survive.
  private async processRegion(build: (oac: OfflineAudioContext, src: AudioBufferSourceNode) => void, tail = 0) {
    if (!this.buffer) return;
    const { s, e, whole } = this.region();
    const region = sliceBuffer(this.ctx, this.buffer, s, e);
    const extra = Math.floor(tail * region.sampleRate);
    const oac = new OfflineAudioContext(region.numberOfChannels, region.length + extra, region.sampleRate);
    const src = oac.createBufferSource();
    src.buffer = region;
    build(oac, src);
    src.start();
    const rendered = await oac.startRendering();
    if (whole) { this.setBuffer(rendered); return; }
    const before = sliceBuffer(this.ctx, this.buffer, 0, s);
    const after = sliceBuffer(this.ctx, this.buffer, e, this.buffer.duration);
    this.selEnd = this.selStart + rendered.duration;
    this.setBuffer(concatBuffers(this.ctx, [before, rendered, after]));
  }

  // ---- playback ------------------------------------------------------------

  private togglePlay() {
    if (this.source) { this.stopPlayback(); return; }
    if (!this.buffer) return;
    void this.ctx.resume();
    const region = this.selEnd - this.selStart > 0.01;
    const from = region ? this.selStart : (this.playhead >= this.buffer.duration - 0.02 ? 0 : this.playhead);
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.ctx.destination);
    src.onended = () => { if (this.source === src) this.stopPlayback(); };
    this.source = src;
    src.start(0, from);
    this.playCtxStart = this.ctx.currentTime;
    this.playOffset = from;
    this.applyLoop(src, from);
    this.setPlayLabel('❚❚ Pause');
    this.animate();
  }

  // Playback range: the selection if there is one, else the whole clip.
  private playRange(): { a: number; b: number } {
    const d = this.buffer?.duration ?? 0;
    return this.selEnd - this.selStart > 0.01 ? { a: this.selStart, b: Math.min(this.selEnd, d) } : { a: 0, b: d };
  }

  // Configure loop points on the running source (also used when toggling live).
  private applyLoop(src: AudioBufferSourceNode, pos: number) {
    const { a, b } = this.playRange();
    src.loop = this.looping;
    if (this.looping) { src.loopStart = a; src.loopEnd = b; }
    // Without looping, stop at the end of the range (re-calling stop() reschedules it).
    try { src.stop(this.ctx.currentTime + (this.looping ? 86400 : Math.max(0.01, b - pos))); } catch { /* not started */ }
  }

  private setLooping(on: boolean) {
    this.looping = on;
    this.updateButtons();
    if (this.source && this.buffer) {
      // Re-anchor the clock at the current position so the playhead stays right.
      this.playOffset = this.currentPlayPos();
      this.playCtxStart = this.ctx.currentTime;
      this.applyLoop(this.source, this.playOffset);
    }
    this.setStatus(on ? 'Loop on' : 'Loop off');
  }

  private currentPlayPos(): number {
    let t = this.playOffset + (this.ctx.currentTime - this.playCtxStart);
    const src = this.source;
    if (src?.loop && src.loopEnd > src.loopStart && t >= src.loopEnd) {
      t = src.loopStart + ((t - src.loopStart) % (src.loopEnd - src.loopStart));
    }
    return t;
  }

  private stopPlayback() {
    if (this.source) { try { this.source.stop(); } catch { /* already stopped */ } this.source.disconnect(); this.source = null; }
    cancelAnimationFrame(this.raf);
    this.setPlayLabel('▶ Play clip');
    this.redraw();
  }

  private animate = () => {
    if (!this.source || !this.buffer) return;
    const t = this.currentPlayPos();
    if (!this.source.loop) {
      const { b } = this.playRange();
      if (t >= b - 0.005) { this.playhead = b; this.stopPlayback(); return; }
    }
    this.playhead = Math.min(t, this.buffer.duration);
    this.redraw();
    this.raf = requestAnimationFrame(this.animate);
  };

  private setPlayLabel(t: string) { const b = this.btn('play'); if (b) b.textContent = t; }

  // ---- recording -----------------------------------------------------------

  private pickRecMime(): string {
    // Chrome/Firefox prefer webm/ogg; Safari only records audio/mp4.
    const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
    return cands.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) ?? '';
  }

  private setRecUi(on: boolean) {
    const b = this.btn('rec');
    if (b) { b.textContent = on ? '■ Stop' : '● Record'; b.classList.toggle('active', on); }
  }

  private async toggleRecord() {
    if (this.recorder) { this.stopRecording(); return; }
    if (this.recPending) { this.recCancelled = true; this.setRecUi(false); this.setStatus('Recording cancelled.'); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this.setStatus('Recording needs a microphone and a secure (https) page — not available here.');
      return;
    }
    if (typeof MediaRecorder === 'undefined') {
      this.setStatus('This browser does not support audio recording (MediaRecorder).');
      return;
    }
    this.recPending = true; this.recCancelled = false;
    this.setStatus('Requesting microphone… allow access in your browser prompt.');
    this.setRecUi(true);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.recPending = false;
      this.setRecUi(false);
      const name = (err as DOMException)?.name;
      this.setStatus(
        name === 'NotAllowedError' || name === 'SecurityError' ? 'Microphone access was blocked — allow it in the browser address bar / site settings, then try again.'
        : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'No microphone found. Connect one and try again.'
        : name === 'NotReadableError' ? 'The microphone is in use by another app or tab.'
        : `Could not start the microphone (${name || 'error'}).`);
      return;
    }
    this.recPending = false;
    if (this.recCancelled || !this.host.isConnected) { stream.getTracks().forEach((t) => t.stop()); this.setRecUi(false); return; }
    this.recStream = stream;

    // Cursor to record into: selection start, else the playhead (existing audio only).
    const cursor = this.buffer ? (this.selEnd - this.selStart > 0.001 ? this.selStart : this.playhead) : 0;
    const chunks: BlobPart[] = [];
    const mime = this.pickRecMime();
    let rec: MediaRecorder;
    try { rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
    catch { stream.getTracks().forEach((t) => t.stop()); this.recStream = null; this.setRecUi(false); this.setStatus('Could not start the recorder for this microphone.'); return; }
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onerror = () => { this.setStatus('Recording failed.'); this.stopRecording(); };
    rec.onstop = async () => {
      const type = rec.mimeType || mime || 'audio/webm';
      const blob = new Blob(chunks, { type });
      if (!blob.size) { this.setStatus('Nothing was recorded.'); return; }
      try {
        let buf = await this.ctx.decodeAudioData(await blob.arrayBuffer());
        if (!this.buffer) { this.setBuffer(buf); return; }
        if (buf.sampleRate !== this.buffer.sampleRate) buf = await resample(buf, this.buffer.sampleRate);
        const at = this.recInsert ? Math.min(cursor, this.buffer.duration) : this.buffer.duration;
        const before = sliceBuffer(this.ctx, this.buffer, 0, at);
        const after = sliceBuffer(this.ctx, this.buffer, at, this.buffer.duration);
        this.playhead = at;
        this.selStart = this.selEnd = 0;
        this.setBuffer(concatBuffers(this.ctx, [before, buf, after]));
        this.setStatus(`Recorded ${fmt(buf.duration)} at ${fmt(at)}.`);
      } catch { this.setStatus(`Recording (${type}) could not be decoded by this browser.`); }
    };
    rec.start(250);
    this.recorder = rec;
    this.setStatus('Recording… press Stop when done.');
  }

  private stopRecording() {
    const rec = this.recorder;
    this.recorder = null;
    if (rec && rec.state !== 'inactive') { try { rec.requestData(); } catch { /* ignore */ } rec.stop(); }
    this.recStream?.getTracks().forEach(t => t.stop());
    this.recStream = null;
    this.setRecUi(false);
  }

  // ---- zoom + pointer ------------------------------------------------------

  private setZoom(z: number) {
    this.zoom = Math.max(1, Math.min(400, z));
    this.redraw();
  }

  private xToTime(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.max(0, Math.min(this.buffer?.duration || 0, x / this.pps));
  }

  private attachPointer() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      if (!this.buffer) return;
      c.setPointerCapture(e.pointerId);
      const t = this.xToTime(e.clientX);
      const edge = 6 / this.pps;
      if (this.selEnd - this.selStart > 0 && Math.abs(t - this.selStart) < edge) this.drag = { mode: 'start' };
      else if (this.selEnd - this.selStart > 0 && Math.abs(t - this.selEnd) < edge) this.drag = { mode: 'end' };
      else { this.drag = { mode: 'new' }; this.selStart = t; this.selEnd = t; this.playhead = t; }
      this.redraw();
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.drag || !this.buffer) return;
      const t = this.xToTime(e.clientX);
      if (this.drag.mode === 'start') this.selStart = Math.min(t, this.selEnd);
      else if (this.drag.mode === 'end') this.selEnd = Math.max(t, this.selStart);
      else { if (t < this.selStart) { this.selEnd = this.selStart; this.selStart = t; } else this.selEnd = t; }
      this.redrawSelStatus();
    });
    const end = () => {
      if (!this.drag) return;
      if (this.drag.mode === 'new' && this.selEnd - this.selStart < 0.002) { this.selEnd = this.selStart; }
      this.drag = null;
      this.onChange();
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
  }

  private redrawSelStatus() {
    this.redraw();
    if (this.selEnd - this.selStart > 0)
      this.setStatus(`Selection: ${fmt(this.selStart)} – ${fmt(this.selEnd)} (${fmt(this.selEnd - this.selStart)})`);
    else this.setStatus(`Playhead: ${fmt(this.playhead)}`);
  }

  // ---- rendering -----------------------------------------------------------

  // ---- multitrack timeline --------------------------------------------------

  private newTrack(): MTrack {
    return { id: mtId(), name: `Track ${this.tracks.length + 1}`, clips: [], gain: 1, mute: false, solo: false };
  }

  private newClip(buffer: AudioBuffer, name: string, start: number): MClip {
    return { id: mtId(), name, buffer, start, offset: 0, dur: buffer.duration, gain: 1, fadeIn: 0, fadeOut: 0 };
  }

  private allClips(): MClip[] { return this.tracks.flatMap((t) => t.clips); }

  private findClip(id: string): { clip: MClip; track: MTrack } | null {
    for (const track of this.tracks) {
      const clip = track.clips.find((c) => c.id === id);
      if (clip) return { clip, track };
    }
    return null;
  }

  private selClip(): MClip | null { return this.selId ? this.findClip(this.selId)?.clip ?? null : null; }

  private mixTotal(): number {
    return this.allClips().reduce((m, c) => Math.max(m, c.start + c.dur), 0);
  }

  private trackEnd(t: MTrack): number { return t.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0); }

  private selectClip(id: string | null) {
    if (id === this.selId) return;
    this.stopPlayback();
    this.selId = id;
    const c = this.selClip();
    this.selStart = this.selEnd = 0;
    this.playhead = 0;
    this.syncView();
    this.renderProps();
    this.mtInner.querySelectorAll<HTMLElement>('.amt-clip').forEach((n) => n.classList.toggle('sel', n.dataset.id === id));
  }

  // Schedule every audible clip into an (Offline)AudioContext starting at timeline time `from`.
  private scheduleMix(ac: BaseAudioContext, dest: AudioNode, from: number, t0: number): AudioBufferSourceNode[] {
    const out: AudioBufferSourceNode[] = [];
    const solo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      if (t.mute || (solo && !t.solo)) continue;
      const tg = ac.createGain();
      tg.gain.value = t.gain;
      tg.connect(dest);
      for (const c of t.clips) {
        if (c.start + c.dur <= from) continue;
        const skip = Math.max(0, from - c.start);
        const when = t0 + Math.max(0, c.start - from);
        // Overlapping fades are clamped so in + out never exceed the clip length.
        const fi = Math.min(c.fadeIn, c.dur);
        const fOut = Math.min(c.fadeOut, c.dur - fi);
        const env = (u: number): number => c.gain * Math.max(0, Math.min(1,
          fi > 0 ? u / fi : 1, fOut > 0 ? (c.dur - u) / fOut : 1));
        const src = ac.createBufferSource();
        src.buffer = c.buffer;
        const g = ac.createGain();
        src.connect(g).connect(tg);
        g.gain.setValueAtTime(env(skip), when);
        if (fi > skip) g.gain.linearRampToValueAtTime(env(fi), when + (fi - skip));
        if (fOut > 0) {
          const fo = Math.max(skip, c.dur - fOut);
          g.gain.setValueAtTime(env(fo), when + (fo - skip));
          g.gain.linearRampToValueAtTime(0, when + (c.dur - skip));
        }
        src.start(when, c.offset + skip, Math.max(0.01, c.dur - skip));
        out.push(src);
      }
    }
    return out;
  }

  // Loop range for mix playback: the clip-editor selection (mapped onto the
  // timeline) if there is one, else the whole mix.
  private mixLoopRange(): { a: number; b: number; region: boolean } {
    const c = this.selClip();
    if (c && this.hasRegion()) return { a: c.start + this.selStart, b: c.start + Math.min(this.selEnd, c.dur), region: true };
    return { a: 0, b: this.mixTotal(), region: false };
  }

  private startMixSources(from: number) {
    for (const s of this.mixSources) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    const t0 = this.ctx.currentTime + 0.05;
    this.mixSources = this.scheduleMix(this.ctx, this.ctx.destination, from, t0);
    this.mixCtxStart = t0;
    this.mixFrom = from;
  }

  private playMix() {
    if (this.mixPlaying) { this.stopMix(); return; }
    this.stopPlayback();
    const total = this.mixTotal();
    if (!total) return;
    void this.ctx.resume();
    if (this.mixT >= total - 0.02) this.mixT = 0;
    if (this.looping) {
      const r = this.mixLoopRange();
      if (r.region && (this.mixT < r.a || this.mixT >= r.b)) this.mixT = r.a;
    }
    this.startMixSources(this.mixT);
    this.mixPlaying = true;
    const b = this.host.querySelector('[data-mt="play"]');
    if (b) b.textContent = '❚❚ Pause';
    const loop = () => {
      if (!this.mixPlaying) return;
      this.mixT = this.mixFrom + Math.max(0, this.ctx.currentTime - this.mixCtxStart);
      // Read the loop flag every frame so toggling it live takes effect.
      const r = this.mixLoopRange();
      if (this.looping && r.b - r.a > 0.05 && this.mixT >= r.b - 0.005) {
        this.mixT = r.a;
        this.startMixSources(r.a);
      } else if (this.mixT >= this.mixTotal()) { this.mixT = this.mixTotal(); this.stopMix(); }
      this.updateMixPlayhead(true);
      this.mixRaf = requestAnimationFrame(loop);
    };
    this.mixRaf = requestAnimationFrame(loop);
  }

  private stopMix() {
    for (const s of this.mixSources) { try { s.stop(); } catch { /* not started */ } s.disconnect(); }
    this.mixSources = [];
    this.mixPlaying = false;
    cancelAnimationFrame(this.mixRaf);
    const b = this.host.querySelector('[data-mt="play"]');
    if (b) b.textContent = '▶ Play mix';
    this.updateMixPlayhead(false);
  }

  private seekMix(t: number) {
    const was = this.mixPlaying;
    if (was) this.stopMix();
    this.mixT = Math.max(0, Math.min(t, this.mixTotal()));
    if (was) this.playMix();
    else this.updateMixPlayhead(false);
  }

  private updateMixPlayhead(follow: boolean) {
    if (this.mtPlayhead) {
      const x = this.mixT * this.mtPps;
      this.mtPlayhead.style.left = `${x}px`;
      const sc = this.mtScroll;
      if (follow && (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 20)) sc.scrollLeft = Math.max(0, x - 40);
    }
    const tl = this.host.querySelector('[data-role="mtTime"]');
    if (tl) tl.textContent = `${fmtT(this.mixT)} / ${fmtT(this.mixTotal())}`;
  }

  private async decodeFiles(files: File[]): Promise<{ buf: AudioBuffer; name: string }[]> {
    const out: { buf: AudioBuffer; name: string }[] = [];
    for (const f of files) {
      try { out.push({ buf: await this.ctx.decodeAudioData(await f.arrayBuffer()), name: f.name.replace(/\.[^.]+$/, '') }); }
      catch { this.setStatus(`Couldn't decode "${f.name}".`); }
    }
    return out;
  }

  // Sequential merge: add after the last clip of the selected (or first) track.
  private async appendFiles(files: File[]) {
    const decoded = await this.decodeFiles(files);
    if (!decoded.length) return;
    this.pushHistory();
    if (!this.tracks.length) this.tracks.push(this.newTrack());
    const track = (this.selId && this.findClip(this.selId)?.track) || this.tracks[0]!;
    let at = this.trackEnd(track);
    let last: MClip | null = null;
    for (const d of decoded) {
      last = this.newClip(d.buf, d.name, at);
      track.clips.push(last);
      at += last.dur;
    }
    this.afterStructure(last?.id ?? null);
    this.setStatus(`Appended ${decoded.length} clip${decoded.length > 1 ? 's' : ''} to ${track.name}.`);
  }

  // Parallel mix: each file goes on a new track starting at the playhead.
  private async addTrackFiles(files: File[]) {
    const decoded = await this.decodeFiles(files);
    if (!decoded.length) return;
    this.pushHistory();
    let last: MClip | null = null;
    for (const d of decoded) {
      const t = this.newTrack();
      last = this.newClip(d.buf, d.name, this.mixT);
      t.clips.push(last);
      this.tracks.push(t);
    }
    this.afterStructure(last?.id ?? null);
    this.setStatus(`Added ${decoded.length} track${decoded.length > 1 ? 's' : ''} — they play mixed together.`);
  }

  private splitMix() {
    let hit = this.selClip();
    const t = this.mixT;
    const inside = (c: MClip | null): boolean => !!c && t > c.start + 0.02 && t < c.start + c.dur - 0.02;
    if (!inside(hit)) hit = this.allClips().find((c) => inside(c)) ?? null;
    if (!hit) { this.setStatus('Move the playhead inside a clip to split it.'); return; }
    this.pushHistory();
    const f = this.findClip(hit.id)!;
    const cut = t - hit.start;
    const b: MClip = { ...hit, id: mtId(), start: t, offset: hit.offset + cut, dur: hit.dur - cut, fadeIn: 0 };
    hit.dur = cut;
    hit.fadeOut = 0;
    f.track.clips.splice(f.track.clips.indexOf(hit) + 1, 0, b);
    this.afterStructure(b.id);
    this.setStatus(`Split at ${fmtT(t)}`);
  }

  private deleteClip() {
    const f = this.selId ? this.findClip(this.selId) : null;
    if (!f) { this.setStatus('Select a clip first.'); return; }
    this.pushHistory();
    f.track.clips = f.track.clips.filter((c) => c !== f.clip);
    if (!f.track.clips.length && this.tracks.length > 1) this.tracks = this.tracks.filter((t) => t !== f.track);
    this.afterStructure(null);
  }

  private afterStructure(selectId: string | null | undefined) {
    this.stopMix();
    if (selectId !== undefined) {
      this.selId = null;
      this.selectClip(selectId);
    }
    this.mixT = Math.min(this.mixT, this.mixTotal());
    this.syncView();
    this.renderTimeline();
    this.renderProps();
    this.updateButtons();
    this.onChange();
  }

  private bindTimeline() {
    this.mtHeads = this.q('mtHeads');
    this.mtScroll = this.q('mtScroll');
    this.mtInner = this.q('mtInner');
    this.mtProps = this.q('mtProps');
    const appendIn = this.q('mtAppend') as HTMLInputElement;
    const trackIn = this.q('mtTrack') as HTMLInputElement;
    appendIn.addEventListener('change', () => { const f = Array.from(appendIn.files ?? []); appendIn.value = ''; if (f.length) void this.appendFiles(f); });
    trackIn.addEventListener('change', () => { const f = Array.from(trackIn.files ?? []); trackIn.value = ''; if (f.length) void this.addTrackFiles(f); });
    this.host.querySelector('.amt-bar')!.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-mt]')?.dataset.mt;
      switch (act) {
        case 'play': this.playMix(); break;
        case 'stop': this.stopMix(); this.seekMix(0); break;
        case 'append': appendIn.click(); break;
        case 'addtrack': trackIn.click(); break;
        case 'split': this.splitMix(); break;
        case 'del': this.deleteClip(); break;
        case 'undo': this.undo(); break;
        case 'redo': this.redo(); break;
        case 'zin': this.mtZoom = Math.min(40, this.mtZoom * 1.5); this.renderTimeline(); break;
        case 'zout': this.mtZoom = Math.max(1, this.mtZoom / 1.5); this.renderTimeline(); break;
        case 'zfit': this.mtZoom = 1; this.renderTimeline(); break;
        case 'snap': this.snapOn = !this.snapOn; this.host.querySelector('[data-mt="snap"]')?.classList.toggle('active', this.snapOn); break;
      }
    });
    this.mtInner.addEventListener('pointerdown', this.onMtDown);
    this.mtHeads.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-tact]');
      const t = this.tracks.find((x) => x.id === el?.closest<HTMLElement>('[data-track]')?.dataset.track);
      if (!el || !t) return;
      this.pushHistory();
      if (el.dataset.tact === 'mute') t.mute = !t.mute;
      else if (el.dataset.tact === 'solo') t.solo = !t.solo;
      else if (el.dataset.tact === 'del' && this.tracks.length > 1) this.tracks = this.tracks.filter((x) => x !== t);
      if (this.selId && !this.findClip(this.selId)) { this.selId = null; this.selectClip(this.allClips()[0]?.id ?? null); }
      this.afterStructure(undefined);
    });
    this.mtHeads.addEventListener('input', (e) => {
      const el = e.target as HTMLInputElement;
      const t = this.tracks.find((x) => x.id === el.closest<HTMLElement>('[data-track]')?.dataset.track);
      if (!t || el.dataset.tact !== 'vol') return;
      if (!this.sliderSession) { this.pushHistory(); this.sliderSession = true; }
      t.gain = Number(el.value);
    });
    this.mtHeads.addEventListener('change', () => { this.sliderSession = false; this.onChange(); });
    new ResizeObserver(() => { if (!this.mtDrag) this.renderTimeline(); }).observe(this.mtScroll);
  }

  private mtX(e: PointerEvent): number { return e.clientX - this.mtInner.getBoundingClientRect().left; }

  private onMtDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const node = target.closest<HTMLElement>('.amt-clip');
    const x = this.mtX(e);
    e.preventDefault();
    if (!node) { this.mtDrag = { kind: 'seek' }; this.seekMix(x / this.mtPps); return; }
    const f = this.findClip(node.dataset.id!);
    if (!f) return;
    this.selectClip(f.clip.id);
    const side = target.dataset.side as 'l' | 'r' | undefined;
    const c = f.clip;
    this.mtDrag = side
      ? { kind: 'trim', id: c.id, side, x0: x, start0: c.start, offset0: c.offset, dur0: c.dur, hist: false }
      : { kind: 'move', id: c.id, x0: x, start0: c.start, hist: false };
    if (!side) this.seekMix(x / this.mtPps);
  };

  private onMtMove = (e: PointerEvent) => {
    const d = this.mtDrag;
    if (!d) return;
    const x = this.mtX(e);
    if (d.kind === 'seek') { this.seekMix(x / this.mtPps); return; }
    const f = this.findClip(d.id);
    if (!f) return;
    if (!d.hist) { this.pushHistory(); d.hist = true; this.stopMix(); }
    const dt = (x - d.x0) / this.mtPps;
    const c = f.clip;
    if (d.kind === 'move') {
      const raw = Math.max(0, d.start0 + dt);
      const s1 = this.snapT(raw, c.id), e1 = this.snapT(raw + c.dur, c.id) - c.dur;
      c.start = Math.max(0, Math.abs(s1 - raw) <= Math.abs(e1 - raw) ? s1 : e1);
      // Drop onto another track lane under the pointer.
      const lane = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('.amt-lane');
      const to = this.tracks.find((t) => t.id === lane?.dataset.track);
      if (to && to !== f.track) {
        f.track.clips = f.track.clips.filter((k) => k !== c);
        to.clips.push(c);
      }
    } else if (d.side === 'l') {
      let k = Math.min(Math.max(dt, -d.offset0, -d.start0), d.dur0 - 0.05);
      k = Math.min(Math.max(this.snapT(d.start0 + k, c.id) - d.start0, -d.offset0, -d.start0), d.dur0 - 0.05);
      c.offset = d.offset0 + k; c.start = d.start0 + k; c.dur = d.dur0 - k;
    } else {
      const end = this.snapT(c.start + d.dur0 + dt, c.id);
      c.dur = Math.max(0.05, Math.min(end - c.start, c.buffer.duration - c.offset));
    }
    this.renderTimeline();
  };

  // Snap a timeline time to 0, the playhead, or another clip's edge within 8px.
  private snapT(t: number, exclude: string): number {
    if (!this.snapOn) return t;
    const tol = 8 / this.mtPps;
    let best = t, bestD = tol;
    const consider = (v: number): void => { const dd = Math.abs(v - t); if (dd < bestD) { bestD = dd; best = v; } };
    consider(0);
    consider(this.mixT);
    for (const k of this.allClips()) if (k.id !== exclude) { consider(k.start); consider(k.start + k.dur); }
    return best;
  }

  private isActive(): boolean { return this.host.isConnected && this.host.offsetParent !== null; }

  private onMtUp = () => {
    const d = this.mtDrag;
    if (!d) return;
    this.mtDrag = null;
    if (d.kind !== 'seek' && d.hist) {
      for (const t of this.tracks) t.clips.sort((a, b) => a.start - b.start);
      this.afterStructure(undefined);
    }
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.isActive() || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('input, textarea, select, button, [contenteditable]:not([contenteditable="false"])')) return;
    if (e.key === ' ') { e.preventDefault(); this.playMix(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); this.splitMix(); }
  };

  private renderTimeline() {
    if (!this.mtInner) return;
    const total = this.mixTotal();
    const span = Math.max(total, 5);
    if (!this.mtDrag) this.mtPps = ((Math.max(200, this.mtScroll.clientWidth) - 20) / span) * this.mtZoom;
    const pps = this.mtPps;
    const inner = this.mtInner;
    inner.innerHTML = '';
    inner.style.width = `${Math.ceil(span * pps) + 20}px`;

    const ruler = document.createElement('div');
    ruler.className = 'amt-ruler';
    const step = niceStep(80 / pps);
    for (let t = 0; t <= span + 1e-6; t += step) {
      const tk = document.createElement('div');
      tk.className = 'amt-tick';
      tk.style.left = `${t * pps}px`;
      tk.textContent = fmt(t);
      ruler.appendChild(tk);
    }
    inner.appendChild(ruler);

    this.mtHeads.innerHTML = '<div class="amt-head amt-head-ruler"></div>';
    const solo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      const head = document.createElement('div');
      head.className = 'amt-head' + (t.mute || (solo && !t.solo) ? ' off' : '');
      head.dataset.track = t.id;
      head.innerHTML = `
        <span class="amt-head-name"></span>
        <div class="amt-head-btns">
          <button type="button" class="amt-tbtn${t.mute ? ' on' : ''}" data-tact="mute" title="Mute">M</button>
          <button type="button" class="amt-tbtn${t.solo ? ' on' : ''}" data-tact="solo" title="Solo">S</button>
          ${this.tracks.length > 1 ? '<button type="button" class="amt-tbtn" data-tact="del" title="Remove track">×</button>' : ''}
        </div>
        <input type="range" min="0" max="2" step="0.05" data-tact="vol" title="Track volume">`;
      head.querySelector('.amt-head-name')!.textContent = t.name;
      (head.querySelector('[data-tact="vol"]') as HTMLInputElement).value = String(t.gain);
      this.mtHeads.appendChild(head);

      const lane = document.createElement('div');
      lane.className = 'amt-lane';
      lane.dataset.track = t.id;
      for (const c of t.clips) lane.appendChild(this.clipNode(c));
      inner.appendChild(lane);
    }

    this.mtPlayhead = document.createElement('div');
    this.mtPlayhead.className = 'amt-playhead';
    inner.appendChild(this.mtPlayhead);
    this.updateMixPlayhead(false);
  }

  private clipNode(c: MClip): HTMLElement {
    const pps = this.mtPps;
    const w = Math.max(6, c.dur * pps);
    const node = document.createElement('div');
    node.className = 'amt-clip' + (c.id === this.selId ? ' sel' : '');
    node.dataset.id = c.id;
    node.style.left = `${c.start * pps}px`;
    node.style.width = `${w}px`;
    const cv = document.createElement('canvas');
    const cw = Math.min(4000, Math.ceil(w)), ch = 46;
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d')!;
    const peaks = peaksOf(c.buffer);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    for (let x = 0; x < cw; x++) {
      const t0 = c.offset + (x / cw) * c.dur, t1 = c.offset + ((x + 1) / cw) * c.dur;
      let m = 0;
      for (let i = Math.floor(t0 * PEAKS_PER_SEC); i <= Math.floor(t1 * PEAKS_PER_SEC) && i < peaks.length; i++) m = Math.max(m, peaks[i]!);
      const env = c.gain * Math.min(1, c.fadeIn > 0 ? ((x / cw) * c.dur) / c.fadeIn : 1, c.fadeOut > 0 ? (c.dur - (x / cw) * c.dur) / c.fadeOut : 1);
      const hh = Math.max(1, Math.min(1, m * env) * ch);
      g.fillRect(x, (ch - hh) / 2, 1, hh);
    }
    const name = document.createElement('span');
    name.className = 'amt-clip-name';
    name.textContent = `${c.name} · ${fmtT(c.dur)}`;
    const l = document.createElement('div'); l.className = 'amt-handle l'; l.dataset.side = 'l'; l.title = 'Drag to trim start';
    const r = document.createElement('div'); r.className = 'amt-handle r'; r.dataset.side = 'r'; r.title = 'Drag to trim end';
    node.append(cv, name, l, r);
    return node;
  }

  private renderProps() {
    const host = this.mtProps;
    if (!host) return;
    host.innerHTML = '';
    const title = this.q('clipTitle');
    const c = this.selClip();
    if (title) title.textContent = c ? `Clip editor — ${c.name} (cut, effects and recording apply to this clip)` : 'Clip editor';
    if (!c) {
      host.innerHTML = '<span class="amt-hint">Select a clip to set its volume and fades. Drag clips to move them (even onto another track), drag edges to trim. Space = play mix, S = split.</span>';
      return;
    }
    const field = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, unit: string) => {
      const wrap = document.createElement('label');
      wrap.className = 'amt-field';
      const val = document.createElement('b');
      val.textContent = `${get().toFixed(step < 1 ? 2 : 0)}${unit}`;
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(get());
      inp.addEventListener('input', () => {
        if (!this.sliderSession) { this.pushHistory(); this.sliderSession = true; }
        set(Number(inp.value));
        val.textContent = `${get().toFixed(step < 1 ? 2 : 0)}${unit}`;
      });
      inp.addEventListener('change', () => { this.sliderSession = false; this.renderTimeline(); this.onChange(); });
      wrap.append(document.createTextNode(`${label} `), val, inp);
      host.appendChild(wrap);
    };
    const name = document.createElement('strong');
    name.textContent = c.name;
    host.appendChild(name);
    field('Volume', 0, 2, 0.05, () => c.gain, (v) => { c.gain = v; }, '×');
    field('Fade in', 0, Math.min(10, c.dur), 0.1, () => c.fadeIn, (v) => { c.fadeIn = Math.min(v, c.dur); }, 's');
    field('Fade out', 0, Math.min(10, c.dur), 0.1, () => c.fadeOut, (v) => { c.fadeOut = Math.min(v, c.dur); }, 's');
    field('Start', 0, Math.max(60, this.mixTotal() + 10), 0.1, () => c.start, (v) => { c.start = v; }, 's');
  }

  private redraw() {
    if (!this.canvas) return;
    const d = this.buffer?.duration || 1;
    const totalW = Math.max(this.scrollEl.clientWidth, Math.min(32000, Math.ceil(d * this.pps)));
    const h = 152, rh = 24;
    const dpr = window.devicePixelRatio || 1;
    this.trackEl.style.width = totalW + 'px';
    for (const [cv, ch] of [[this.canvas, h], [this.ruler, rh]] as [HTMLCanvasElement, number][]) {
      cv.style.width = totalW + 'px'; cv.style.height = ch + 'px';
      cv.width = Math.round(totalW * dpr); cv.height = Math.round(ch * dpr);
    }
    const style = getComputedStyle(document.documentElement);
    const brand = style.getPropertyValue('--brand-500').trim() || '#6366f1';
    const muted = style.getPropertyValue('--border-strong').trim() || '#8888aa';
    const textMuted = style.getPropertyValue('--text-muted').trim() || '#888';

    // Waveform.
    const g = this.canvas.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, totalW, h);
    g.fillStyle = muted; g.fillRect(0, h / 2, totalW, 1);
    if (this.buffer) {
      const data = this.buffer.getChannelData(0);
      const step = Math.max(1, Math.floor(data.length / totalW));
      g.fillStyle = muted;
      for (let x = 0; x < totalW; x++) {
        let min = 1, max = -1;
        const base = x * step;
        for (let i = 0; i < step; i++) { const v = data[base + i] ?? 0; if (v < min) min = v; if (v > max) max = v; }
        g.fillRect(x, (1 + min) * h / 2, 1, Math.max(1, (max - min) * h / 2));
      }
      // Selection overlay.
      if (this.selEnd - this.selStart > 0) {
        const sx = this.selStart * this.pps, ex = this.selEnd * this.pps;
        g.fillStyle = brand + '2a'; g.fillRect(sx, 0, ex - sx, h);
        g.fillStyle = brand; g.fillRect(sx, 0, 2, h); g.fillRect(ex - 2, 0, 2, h);
      }
      // Playhead.
      const px = this.playhead * this.pps;
      g.fillStyle = '#e5484d'; g.fillRect(px, 0, 1.5, h);
    }

    // Ruler.
    const r = this.ruler.getContext('2d')!;
    r.setTransform(dpr, 0, 0, dpr, 0, 0);
    r.clearRect(0, 0, totalW, rh);
    r.fillStyle = textMuted; r.font = '10px system-ui, sans-serif'; r.textBaseline = 'top';
    const targetPx = 80;
    const rawStep = targetPx / this.pps;
    const stepSec = niceStep(rawStep);
    for (let t = 0; t <= d; t += stepSec) {
      const x = t * this.pps;
      r.fillStyle = muted; r.fillRect(x, rh - 6, 1, 6);
      r.fillStyle = textMuted; r.fillText(fmt(t), x + 2, 4);
    }
  }
}

// ---- pure buffer helpers ---------------------------------------------------

function cloneBuffer(ctx: BaseAudioContext, buf: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).slice(), c);
  return out;
}

function sliceBuffer(ctx: BaseAudioContext, buf: AudioBuffer, start: number, end: number): AudioBuffer {
  const rate = buf.sampleRate;
  const a = Math.max(0, Math.floor(start * rate));
  const b = Math.min(buf.length, Math.floor(end * rate));
  const len = Math.max(0, b - a);
  const out = ctx.createBuffer(buf.numberOfChannels, Math.max(1, len), rate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    if (len > 0) out.copyToChannel(buf.getChannelData(c).subarray(a, b), c);
  }
  return out;
}

async function resample(buf: AudioBuffer, rate: number): Promise<AudioBuffer> {
  const oac = new OfflineAudioContext(buf.numberOfChannels, Math.max(1, Math.ceil(buf.duration * rate)), rate);
  const src = oac.createBufferSource();
  src.buffer = buf;
  src.connect(oac.destination);
  src.start();
  return oac.startRendering();
}

function concatBuffers(ctx: BaseAudioContext, parts: AudioBuffer[]): AudioBuffer {
  const list = parts.filter(p => p.length > 0);
  if (list.length === 0) return ctx.createBuffer(1, 1, ctx.sampleRate);
  const numCh = Math.max(...list.map(p => p.numberOfChannels));
  const rate = list[0]!.sampleRate;
  const total = list.reduce((n, p) => n + p.length, 0);
  const out = ctx.createBuffer(numCh, total, rate);
  for (let c = 0; c < numCh; c++) {
    const dst = out.getChannelData(c);
    let off = 0;
    for (const p of list) {
      const src = p.getChannelData(Math.min(c, p.numberOfChannels - 1));
      dst.set(src, off);
      off += p.length;
    }
  }
  return out;
}

// Synthetic exponentially-decaying noise impulse for the convolution reverb.
function impulseResponse(ctx: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const imp = ctx.createBuffer(2, len, rate);
  for (let c = 0; c < 2; c++) {
    const d = imp.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return imp;
}

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-6))));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return Math.max(0.01, m * pow);
}

function promptNum(label: string, def: number): number | null {
  const v = window.prompt(label, String(def));
  if (v == null) return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function fmt(sec: number): string {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  const ms = Math.floor((sec % 1) * 100);
  return sec < 60 ? `0:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
}

// Encode an AudioBuffer to a 16-bit PCM WAV blob.
function encodeWav(buf: AudioBuffer): Blob {
  const numCh = buf.numberOfChannels;
  const len = buf.length;
  const rate = buf.sampleRate;
  const blockAlign = numCh * 2;
  const dataSize = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const wr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  wr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); wr(8, 'WAVE');
  wr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numCh, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * blockAlign, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  wr(36, 'data'); view.setUint32(40, dataSize, true);
  let off = 44;
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const v = Math.max(-1, Math.min(1, chans[c]![i] ?? 0));
      view.setInt16(off, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

// Optional MP3 export via a lazily-imported encoder. Degrades gracefully.
async function encodeMp3(buf: AudioBuffer): Promise<Blob | null> {
  // CSP: needs connect-src/script-src for esm.sh (dynamic import of lamejs).
  // Non-literal URL keeps TS/Vite from trying to resolve the CDN module.
  const url = 'https://esm.sh/@breezystack/lamejs@1.2.7';
  const mod = await import(/* @vite-ignore */ url);
  const lame = (mod as { Mp3Encoder?: unknown; default?: { Mp3Encoder?: unknown } });
  const Mp3Encoder = (lame.Mp3Encoder || lame.default?.Mp3Encoder) as
    | (new (ch: number, rate: number, kbps: number) => { encodeBuffer(l: Int16Array, r?: Int16Array): Int8Array; flush(): Int8Array })
    | undefined;
  if (!Mp3Encoder) return null;
  const numCh = Math.min(2, buf.numberOfChannels);
  const enc = new Mp3Encoder(numCh, buf.sampleRate, 128);
  const to16 = (f: Float32Array) => {
    const o = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const v = Math.max(-1, Math.min(1, f[i]!)); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    return o;
  };
  const left = to16(buf.getChannelData(0));
  const right = numCh > 1 ? to16(buf.getChannelData(1)) : undefined;
  const chunks: Int8Array[] = [];
  const block = 1152;
  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block);
    const r = right ? right.subarray(i, i + block) : undefined;
    const enc16 = enc.encodeBuffer(l, r);
    if (enc16.length) chunks.push(enc16);
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(tail);
  return new Blob(chunks as unknown as BlobPart[], { type: 'audio/mpeg' });
}

// Max-abs peaks at PEAKS_PER_SEC resolution, cached per (immutable) buffer.
function peaksOf(buf: AudioBuffer): Float32Array {
  const hit = peakCache.get(buf);
  if (hit) return hit;
  const per = Math.max(1, Math.floor(buf.sampleRate / PEAKS_PER_SEC));
  const n = Math.ceil(buf.length / per);
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = out[i]!;
      const end = Math.min(d.length, (i + 1) * per);
      for (let j = i * per; j < end; j++) { const v = Math.abs(d[j]!); if (v > m) m = v; }
      out[i] = m;
    }
  }
  peakCache.set(buf, out);
  return out;
}

function fmtT(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60), d = Math.floor(sec * 10) % 10;
  return `${m}:${s.toString().padStart(2, '0')}.${d}`;
}
