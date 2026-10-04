import './styles/audio.css';
import type { DocEditor } from './registry';
import { bindUndoKeys } from './undoKeys';

// Client-side, audiomass.co-inspired audio editor built on the Web Audio API —
// no heavy dependencies. It keeps one editable in-memory AudioBuffer that all
// edit ops / effects mutate, with an undo/redo history. Features: interactive
// waveform (drag-select, edge-drag, playhead, ruler, horizontal zoom), cut /
// copy / paste / delete / crop / silence / insert-silence / trim, effects
// (gain, normalize, fade, reverb, echo, speed, low/high-pass), loop playback,
// mic record (append/insert), and WAV export (+ optional lazy MP3 encoder).
// Exposed through DocEditor so the shell's Download / Share / Save paths work.

type ExportFmt = 'wav' | 'mp3';

export class AudioEditor implements DocEditor {
  private host: HTMLElement;
  private ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private clipboard: AudioBuffer | null = null;
  private onChange: () => void;

  // Selection + playhead in seconds. selStart === selEnd means "no region".
  private selStart = 0;
  private selEnd = 0;
  private playhead = 0;

  // View: horizontal zoom expressed as pixels-per-second.
  private basePps = 0;          // pps that fits the whole clip at zoom 1
  private zoom = 1;

  // History of buffer snapshots (working buffer copies).
  private undoStack: AudioBuffer[] = [];
  private redoStack: AudioBuffer[] = [];

  // Playback / recording lifecycle.
  private source: AudioBufferSourceNode | null = null;
  private playCtxStart = 0;     // ctx.currentTime when playback began
  private playOffset = 0;       // buffer offset playback began at
  private looping = false;
  private raf = 0;
  private recorder: MediaRecorder | null = null;
  private recStream: MediaStream | null = null;
  private recInsert = false;    // insert at playhead vs append at end

  private exportFmt: ExportFmt = 'wav';

  // DOM refs.
  private scrollEl!: HTMLElement;
  private trackEl!: HTMLElement;
  private ruler!: HTMLCanvasElement;
  private canvas!: HTMLCanvasElement;
  private statusEl!: HTMLElement;

  // Drag state.
  private drag: { mode: 'new' | 'start' | 'end' } | null = null;

  // Keyboard undo/redo cleanup.
  private unbindKeys: (() => void) | null = null;

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
        ed.setBuffer(buf, false);
      } catch {
        ed.setStatus('Could not decode this audio — try recording or uploading a WAV/MP3.');
      }
    } else {
      ed.setStatus('Empty clip — press ● Record to capture audio.');
    }
    window.addEventListener('resize', ed.onResize);
    return ed;
  }

  destroy(): void {
    this.unbindKeys?.();
    this.unbindKeys = null;
    window.removeEventListener('resize', this.onResize);
    cancelAnimationFrame(this.raf);
    this.stopPlayback();
    this.stopRecording();
    void this.ctx.close().catch(() => {});
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    if (!this.buffer) return null;
    if (this.exportFmt === 'mp3') {
      const mp3 = await encodeMp3(this.buffer).catch(() => null);
      if (mp3) return { blob: mp3, contentType: 'audio/mpeg' };
      this.setStatus('MP3 encoder unavailable — exported WAV instead.');
    }
    return { blob: encodeWav(this.buffer), contentType: 'audio/wav' };
  }

  // ---- buffer / view state -------------------------------------------------

  private setBuffer(buf: AudioBuffer, pushHistory = true) {
    if (pushHistory && this.buffer) {
      this.undoStack.push(this.buffer);
      if (this.undoStack.length > 40) this.undoStack.shift();
      this.redoStack = [];
    }
    this.buffer = buf;
    if (this.selEnd > buf.duration || this.selEnd === 0) { this.selStart = 0; this.selEnd = 0; }
    this.playhead = Math.min(this.playhead, buf.duration);
    this.fitZoom();
    this.redraw();
    this.updateButtons();
    this.setStatus(`${fmt(buf.duration)} · ${buf.numberOfChannels}ch · ${(buf.sampleRate / 1000).toFixed(1)}kHz`);
    this.onChange();
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
        <div class="aud-toolbar" data-role="toolbar">
          <div class="aud-group">
            <button type="button" class="aud-btn aud-primary" data-act="play">▶ Play</button>
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
            <button type="button" class="aud-btn" data-act="recmode" title="Toggle append/insert">Append</button>
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
    this.attachPointer();
    this.fitZoom();

    // Bind keyboard undo/redo.
    this.unbindKeys = bindUndoKeys({
      undo: () => this.undo(),
      redo: () => this.redo(),
    });
  }

  private q(role: string): HTMLElement { return this.host.querySelector(`[data-role="${role}"]`) as HTMLElement; }
  private setStatus(t: string) { if (this.statusEl) this.statusEl.textContent = t; }
  private btn(act: string): HTMLButtonElement | null { return this.host.querySelector(`[data-act="${act}"]`); }

  private updateButtons() {
    const set = (a: string, on: boolean) => { const b = this.btn(a); if (b) b.disabled = !on; };
    set('undo', this.undoStack.length > 0);
    set('redo', this.redoStack.length > 0);
    set('paste', !!this.clipboard);
    this.btn('loop')?.classList.toggle('active', this.looping);
  }

  // ---- command dispatch ----------------------------------------------------

  private async dispatch(act: string) {
    switch (act) {
      case 'play': this.togglePlay(); break;
      case 'stop': this.stopPlayback(); break;
      case 'loop': this.looping = !this.looping; this.updateButtons(); break;
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
      case 'fmtwav': this.exportFmt = 'wav'; this.btn('fmtwav')?.classList.add('active'); this.btn('fmtmp3')?.classList.remove('active'); break;
      case 'fmtmp3': this.exportFmt = 'mp3'; this.btn('fmtmp3')?.classList.add('active'); this.btn('fmtwav')?.classList.remove('active'); break;
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
    this.clipboard = sliceBuffer(this.ctx, this.buffer, this.selStart, this.selEnd);
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
    if (!this.buffer || !this.clipboard) return;
    const at = this.selEnd - this.selStart > 0 ? this.selStart : this.playhead;
    const before = sliceBuffer(this.ctx, this.buffer, 0, at);
    const after = sliceBuffer(this.ctx, this.buffer, this.selEnd - this.selStart > 0 ? this.selEnd : at, this.buffer.duration);
    const out = concatBuffers(this.ctx, [before, this.clipboard, after]);
    this.selStart = at; this.selEnd = at + this.clipboard.duration;
    this.setBuffer(out);
    this.setStatus('Pasted');
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

  private undo() {
    const prev = this.undoStack.pop();
    if (!prev || !this.buffer) return;
    this.redoStack.push(this.buffer);
    this.buffer = prev;
    this.selStart = this.selEnd = 0;
    this.fitZoom(); this.redraw(); this.updateButtons(); this.onChange();
    this.setStatus('Undo');
  }

  private redo() {
    const next = this.redoStack.pop();
    if (!next || !this.buffer) return;
    this.undoStack.push(this.buffer);
    this.buffer = next;
    this.selStart = this.selEnd = 0;
    this.fitZoom(); this.redraw(); this.updateButtons(); this.onChange();
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
    if (!this.buffer) return;
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
    const from = region ? this.selStart : this.playhead;
    const to = region ? this.selEnd : this.buffer.duration;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = this.looping && region;
    if (src.loop) { src.loopStart = from; src.loopEnd = to; }
    src.connect(this.ctx.destination);
    src.onended = () => { if (this.source === src) this.stopPlayback(); };
    src.start(0, from, src.loop ? undefined : Math.max(0.02, to - from));
    this.source = src;
    this.playCtxStart = this.ctx.currentTime;
    this.playOffset = from;
    this.setPlayLabel('❚❚ Pause');
    this.animate();
  }

  private stopPlayback() {
    if (this.source) { try { this.source.stop(); } catch { /* already stopped */ } this.source.disconnect(); this.source = null; }
    cancelAnimationFrame(this.raf);
    this.setPlayLabel('▶ Play');
    this.redraw();
  }

  private animate = () => {
    if (!this.source || !this.buffer) return;
    let t = this.playOffset + (this.ctx.currentTime - this.playCtxStart);
    if (this.source.loop) {
      const span = this.source.loopEnd - this.source.loopStart;
      if (span > 0) t = this.source.loopStart + ((t - this.source.loopStart) % span);
    }
    this.playhead = Math.min(t, this.buffer.duration);
    this.redraw();
    this.raf = requestAnimationFrame(this.animate);
  };

  private setPlayLabel(t: string) { const b = this.btn('play'); if (b) b.textContent = t; }

  // ---- recording -----------------------------------------------------------

  private async toggleRecord() {
    if (this.recorder) { this.stopRecording(); return; }
    try {
      this.recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.setStatus('Microphone access denied.');
      return;
    }
    const chunks: BlobPart[] = [];
    const rec = new MediaRecorder(this.recStream);
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      try {
        const buf = await this.ctx.decodeAudioData(await blob.arrayBuffer());
        if (!this.buffer) { this.setBuffer(buf); return; }
        if (this.recInsert) {
          const at = this.playhead;
          const before = sliceBuffer(this.ctx, this.buffer, 0, at);
          const after = sliceBuffer(this.ctx, this.buffer, at, this.buffer.duration);
          this.setBuffer(concatBuffers(this.ctx, [before, buf, after]));
        } else {
          this.setBuffer(concatBuffers(this.ctx, [this.buffer, buf]));
        }
      } catch { this.setStatus('Recording could not be decoded.'); }
    };
    rec.start();
    this.recorder = rec;
    const b = this.btn('rec'); if (b) { b.textContent = '■ Stop'; b.classList.add('active'); }
    this.setStatus('Recording…');
  }

  private stopRecording() {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    this.recorder = null;
    this.recStream?.getTracks().forEach(t => t.stop());
    this.recStream = null;
    const b = this.btn('rec'); if (b) { b.textContent = '● Record'; b.classList.remove('active'); }
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
