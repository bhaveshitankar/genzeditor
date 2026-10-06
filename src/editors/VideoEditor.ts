import './styles/video.css';
import type { DocEditor } from './registry';
import { getFfmpeg } from './ffmpegLoader';

// Picsart-inspired client-side video editor. Native <video> for preview + a
// thumbnail timeline for lightweight scrubbing/segment editing. All heavy work
// (trim/concat, crop, scale, rotate, speed, filters, overlays, audio, format)
// is deferred to export(), which builds a single ffmpeg filter graph and
// re-encodes. Nothing touches ffmpeg on slider tweaks. Contract unchanged:
// static open(host, blob, name) -> { export(), destroy() }.

interface Segment { start: number; end: number; }
interface CropRect { x: number; y: number; w: number; h: number; } // normalized 0..1

type Look = 'none' | 'grayscale' | 'sepia';
type Fmt = 'mp4' | 'webm';
type ResPreset = 'original' | '1080p' | '720p' | '480p' | 'square';
type TextPos = 'top' | 'center' | 'bottom';

// drawtext needs a real font file inside the ffmpeg FS. The core wasm ships no
// fonts, so we lazily fetch DejaVuSans from jsdelivr and write it in. If the
// fetch is blocked (CSP/offline), text overlay degrades gracefully with a
// friendly message and export continues without it. NOTE: for guaranteed text
// support, ship a font asset locally and write it instead of fetching.
const FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';
const FONT_FILE = 'font.ttf';

export class VideoEditor implements DocEditor {
  private host: HTMLElement;
  private blob: Blob;
  private name: string;
  private url: string;
  private zoom = 100;
  private video!: HTMLVideoElement;
  private statusEl!: HTMLElement;
  private barEl!: HTMLElement;
  private barFill!: HTMLElement;
  private playheadEl!: HTMLElement;
  private trackEl!: HTMLElement;
  private timeEl!: HTMLElement;
  private cropLayer!: HTMLElement;
  private cropBoxEl!: HTMLElement;
  private objectUrls: string[] = [];
  private rafId = 0;

  // Edit state
  private segments: Segment[] = [];       // keep-segments (in order); empty = whole
  private crop: CropRect | null = null;
  private rotate = 0;                       // 0/90/180/270 (clockwise)
  private flipH = false;
  private flipV = false;
  private speed = 1;
  private brightness = 0;                   // -1..1 (eq brightness)
  private contrast = 1;                     // 0..2 (eq contrast)
  private saturation = 1;                   // 0..3 (eq saturation)
  private look: Look = 'none';
  private text = '';
  private textPos: TextPos = 'bottom';
  private textColor = '#ffffff';
  private textSize = 36;
  private mute = false;
  private volume = 1;                       // 0..2
  private extraAudio: Blob | null = null;   // background/replacement audio
  private extraAudioName = '';
  private replaceAudio = false;             // true: replace; false: mix under
  private outFmt: Fmt = 'mp4';
  private resPreset: ResPreset = 'original';

  // Timeline/layer operations
  private currentTime = 0;
  private selectedSegmentIndex = -1;

  private cropDrag: { x: number; y: number } | null = null;

  private constructor(host: HTMLElement, blob: Blob, name: string) {
    this.host = host;
    this.blob = blob;
    this.name = name;
    this.url = URL.createObjectURL(blob);
    this.objectUrls.push(this.url);
  }

  static async open(host: HTMLElement, blob: Blob, name: string): Promise<VideoEditor> {
    const ed = new VideoEditor(host, blob, name);
    ed.render();
    return ed;
  }

  destroy(): void {
    try { this.video?.pause(); } catch { /* ignore */ }
    if (this.rafId) cancelAnimationFrame(this.rafId);
    for (const u of this.objectUrls) URL.revokeObjectURL(u);
    this.objectUrls = [];
    if (this.video) this.video.src = '';
  }

  private duration(): number { return isFinite(this.video?.duration) ? this.video.duration : 0; }

  /** Split video at current time (F.1) */
  splitAtTime(timeSeconds: number): string {
    if (timeSeconds <= 0 || timeSeconds >= this.duration()) return 'Invalid split time';
    this.segments.push({ start: timeSeconds, end: this.duration() });
    this.segments.sort((a, b) => a.start - b.start);
    this.render();
    return `Split at ${timeSeconds.toFixed(2)}s`;
  }

  /** Create segment/layer (F.2) */
  addSegment(startTime: number, endTime: number): string {
    if (startTime < 0 || endTime > this.duration() || startTime >= endTime) return 'Invalid segment';
    this.segments.push({ start: startTime, end: endTime });
    this.segments.sort((a, b) => a.start - b.start);
    this.render();
    return `Added segment ${startTime.toFixed(2)}s-${endTime.toFixed(2)}s`;
  }

  /** Add audio track (F.3) */
  addAudioTrack(audioBlob: Blob, replace = false): string {
    this.extraAudio = audioBlob;
    this.replaceAudio = replace;
    this.render();
    return `${replace ? 'Replaced' : 'Mixed'} audio track`;
  }

  /** Apply an AI-generated non-destructive patch, then re-render. Returns a summary. */
  applyAiPatch(patch: Record<string, unknown>): string {
    const done: string[] = [];
    const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
    const ts = num(patch.trimStart), te = num(patch.trimEnd);
    if (ts != null || te != null) {
      this.segments = [{ start: ts ?? 0, end: te ?? (this.duration() || (ts ?? 0)) }];
      done.push('trimmed');
    }
    if (patch.mute === true) { this.mute = true; done.push('muted'); }
    const sp = num(patch.speed); if (sp != null && sp > 0) { this.speed = sp; done.push(`speed ${sp}x`); }
    if (patch.rotate === 90 || patch.rotate === 180 || patch.rotate === 270) { this.rotate = patch.rotate; done.push(`rotated ${patch.rotate}°`); }
    if (patch.flipH === true) { this.flipH = true; done.push('flipped H'); }
    if (patch.flipV === true) { this.flipV = true; done.push('flipped V'); }
    const br = num(patch.brightness); if (br != null) { this.brightness = Math.max(-1, Math.min(1, br / 100)); done.push('brightness'); }
    const ct = num(patch.contrast); if (ct != null) { this.contrast = Math.max(0, Math.min(2, 1 + ct / 100)); done.push('contrast'); }
    const sa = num(patch.saturation); if (sa != null) { this.saturation = Math.max(0, Math.min(3, 1 + sa / 100)); done.push('saturation'); }
    if (patch.outFmt === 'mp4' || patch.outFmt === 'webm') { this.outFmt = patch.outFmt; done.push(`format ${patch.outFmt}`); }
    if (typeof patch.text === 'string' && patch.text) { this.text = patch.text; done.push('text overlay'); }
    this.render();
    return done.join(', ') || 'no changes';
  }

  // ---- Export -----------------------------------------------------------

  private hasEdits(): boolean {
    return this.segments.length > 0 || !!this.crop || this.rotate !== 0 || this.flipH ||
      this.flipV || this.speed !== 1 || this.brightness !== 0 || this.contrast !== 1 ||
      this.saturation !== 1 || this.look !== 'none' || !!this.text || this.mute ||
      this.volume !== 1 || !!this.extraAudio || this.resPreset !== 'original' ||
      this.outFmt !== this.currentFmt();
  }

  private currentFmt(): Fmt {
    return (this.blob.type || this.name).includes('webm') ? 'webm' : 'mp4';
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    if (!this.hasEdits()) {
      return { blob: this.blob, contentType: this.blob.type || 'video/mp4' };
    }
    this.setStatus('Processing… (first run downloads the video engine)');
    this.showProgress(true);
    const inName = 'in' + this.extOf(this.name);
    const outName = 'out.' + this.outFmt;
    const audName = this.extraAudio ? 'bg' + this.extOf(this.extraAudioName) : '';
    let ff: Awaited<ReturnType<typeof getFfmpeg>>;
    try {
      ff = await getFfmpeg((r) => this.setProgress(r));
    } catch (err) {
      return this.fail('Could not load the video engine', err);
    }
    try {
      const { fetchFile } = await import('@ffmpeg/util');
      await ff.writeFile(inName, await fetchFile(this.blob));
      if (this.extraAudio && audName) await ff.writeFile(audName, await fetchFile(this.extraAudio));

      // Text overlay needs a font in the FS — best effort.
      let fontReady = false;
      if (this.text) {
        try {
          await ff.writeFile(FONT_FILE, await fetchFile(FONT_URL));
          fontReady = true;
        } catch {
          this.setStatus('Text overlay skipped: font could not be loaded.');
        }
      }

      const { filter, maps } = this.buildGraph(fontReady, !!(this.extraAudio && audName));
      const args: string[] = ['-i', inName];
      if (this.extraAudio && audName) args.push('-i', audName);
      if (filter) args.push('-filter_complex', filter);
      args.push(...maps);
      args.push(...this.codecArgs());
      args.push(outName);

      await ff.exec(args);
      const data = await ff.readFile(outName);
      if (!data || (data instanceof Uint8Array && data.length === 0)) {
        throw new Error('ffmpeg produced no output');
      }
      const bytes = data instanceof Uint8Array ? data : new TextEncoder().encode(String(data));
      if (bytes.length === 0) throw new Error('ffmpeg output is empty');
      const part = new Uint8Array(bytes.length);
      part.set(bytes); // detach from any SharedArrayBuffer backing
      await this.cleanupFs(ff, [inName, outName, audName, this.text ? FONT_FILE : '']);

      const contentType = this.outFmt === 'webm' ? 'video/webm' : 'video/mp4';
      this.setStatus('Done.');
      this.showProgress(false);
      return { blob: new Blob([part], { type: contentType }), contentType };
    } catch (err) {
      return this.fail('Processing failed', err);
    }
  }

  private fail(msg: string, err: unknown): { blob: Blob; contentType: string } {
    this.showProgress(false);
    this.setStatus(`${msg}: ${err instanceof Error ? err.message : String(err)}`);
    return { blob: this.blob, contentType: this.blob.type || 'video/mp4' };
  }

  private async cleanupFs(ff: Awaited<ReturnType<typeof getFfmpeg>>, files: string[]) {
    for (const f of files) if (f) await ff.deleteFile(f).catch(() => {});
  }

  // Build a single filter_complex plus -map flags. Video path:
  //   [per-segment trim]->concat -> crop -> transpose/flip -> scale
  //   -> speed(setpts) -> eq -> look -> drawtext -> [vout]
  // Audio path mirrors trims + concat, then atempo/volume, optional bg mix.
  private buildGraph(fontReady: boolean, hasBg: boolean): { filter: string; maps: string[] } {
    const parts: string[] = [];
    const wantAudio = !this.mute; // when muted we drop audio entirely
    const segs = this.segments.length ? this.segments : null;

    // 1) Segments -> concat (or straight pass-through when whole clip).
    let vlabel = '[0:v]';
    let alabel = '[0:a]';
    if (segs) {
      const vlabels: string[] = [];
      const alabels: string[] = [];
      segs.forEach((s, i) => {
        parts.push(`[0:v]trim=start=${f3(s.start)}:end=${f3(s.end)},setpts=PTS-STARTPTS[sv${i}]`);
        vlabels.push(`[sv${i}]`);
        if (wantAudio) {
          parts.push(`[0:a]atrim=start=${f3(s.start)}:end=${f3(s.end)},asetpts=PTS-STARTPTS[sa${i}]`);
          alabels.push(`[sa${i}]`);
        }
      });
      if (segs.length > 1) {
        parts.push(`${vlabels.join('')}concat=n=${segs.length}:v=1:a=0[vc]`);
        vlabel = '[vc]';
        if (wantAudio) { parts.push(`${alabels.join('')}concat=n=${segs.length}:v=0:a=1[ac]`); alabel = '[ac]'; }
      } else {
        // Rename single-segment labels for the shared chain below.
        parts.push(`${vlabels[0]}null[vc]`); vlabel = '[vc]';
        if (wantAudio) { parts.push(`${alabels[0]}anull[ac]`); alabel = '[ac]'; }
      }
    }

    // 2) Video filter chain.
    const vf: string[] = [];
    if (this.crop) {
      const c = this.crop;
      vf.push(`crop=iw*${f3(c.w)}:ih*${f3(c.h)}:iw*${f3(c.x)}:ih*${f3(c.y)}`);
    }
    // Rotation via transpose (each = 90° CW). 180 = two transposes.
    if (this.rotate === 90) vf.push('transpose=1');
    else if (this.rotate === 180) vf.push('transpose=1,transpose=1');
    else if (this.rotate === 270) vf.push('transpose=2');
    if (this.flipH) vf.push('hflip');
    if (this.flipV) vf.push('vflip');
    const scale = this.scaleFilter();
    if (scale) vf.push(scale);
    if (this.speed !== 1) vf.push(`setpts=${f3(1 / this.speed)}*PTS`);
    if (this.brightness !== 0 || this.contrast !== 1 || this.saturation !== 1) {
      vf.push(`eq=brightness=${f3(this.brightness)}:contrast=${f3(this.contrast)}:saturation=${f3(this.saturation)}`);
    }
    if (this.look === 'grayscale') vf.push('hue=s=0');
    else if (this.look === 'sepia') {
      vf.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
    }
    if (this.text && fontReady) vf.push(this.drawTextFilter());
    vf.push('format=yuv420p'); // wide player compatibility

    parts.push(`${vlabel}${vf.join(',')}[vout]`);

    // 3) Audio filter chain.
    const maps: string[] = ['-map', '[vout]'];
    if (wantAudio) {
      const af: string[] = [];
      if (this.speed !== 1) af.push(...atempoChain(this.speed));
      if (this.volume !== 1) af.push(`volume=${f3(this.volume)}`);
      af.push('aresample=async=1');
      parts.push(`${alabel}${af.join(',')}[amain]`);

      if (hasBg) {
        if (this.replaceAudio) {
          // Replace: use bg audio only, drop original.
          parts.push('[1:a]aresample=async=1[abg]');
          maps.push('-map', '[abg]');
        } else {
          // Mix bg under original.
          parts.push('[1:a]volume=0.5,aresample=async=1[abg]');
          parts.push('[amain][abg]amix=inputs=2:duration=first:dropout_transition=0[aout]');
          maps.push('-map', '[aout]');
        }
      } else {
        maps.push('-map', '[amain]');
      }
    }

    return { filter: parts.join(';'), maps };
  }

  private scaleFilter(): string {
    switch (this.resPreset) {
      case '1080p': return "scale='min(1920,iw)':-2";
      case '720p': return 'scale=-2:720';
      case '480p': return 'scale=-2:480';
      case 'square': return "crop='min(iw,ih)':'min(iw,ih)',scale=1080:1080";
      default: return '';
    }
  }

  private drawTextFilter(): string {
    // Escape for ffmpeg filter syntax (colons, quotes, backslashes, percent).
    const txt = this.text
      .replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019").replace(/%/g, '\\%');
    const y = this.textPos === 'top' ? 'h*0.06'
      : this.textPos === 'center' ? '(h-text_h)/2'
      : 'h-text_h-h*0.06';
    const col = this.textColor.replace('#', '0x');
    return `drawtext=fontfile=${FONT_FILE}:text='${txt}':x=(w-text_w)/2:y=${y}` +
      `:fontsize=${this.textSize}:fontcolor=${col}:box=1:boxcolor=black@0.4:boxborderw=8`;
  }

  private codecArgs(): string[] {
    if (this.outFmt === 'webm') {
      // VP9 + Opus. -deadline realtime keeps wasm encode tractable.
      return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'realtime',
        '-cpu-used', '5', '-c:a', 'libopus'];
    }
    // H.264 + AAC. ultrafast for wasm speed.
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
  }

  private extOf(n: string): string {
    const e = (n.split('.').pop() || '').toLowerCase();
    return e && e.length <= 5 ? '.' + e : '.mp4';
  }

  // ---- UI ---------------------------------------------------------------

  private render() {
    this.host.innerHTML = `
      <div class="vid-editor">
        <div class="vid-stage">
          <video class="vid-video" data-role="video" src="${this.url}" playsinline></video>
          <div class="vid-crop-layer" data-role="croplayer"><div class="vid-crop-box" data-role="cropbox"></div></div>
        </div>

        <div class="vid-transport">
          <button type="button" class="vid-btn" data-role="play">Play</button>
          <span class="vid-time" data-role="time">0:00 / 0:00</span>
          <button type="button" class="vid-btn" data-role="setin">Set in ⟦</button>
          <button type="button" class="vid-btn" data-role="setout">Set out ⟧</button>
          <button type="button" class="vid-btn" data-role="addseg">Add keep segment</button>
          <button type="button" class="vid-btn" data-role="clearseg">Clear segments</button>
        </div>

        <div class="vid-timeline">
          <div class="vid-timeline-header">
            <div class="vid-timeline-labels">
              <div class="vid-track-label">Video</div>
              <div class="vid-track-label">Audio</div>
            </div>
            <div class="vid-timeline-tracks">
              <div class="vid-track-group">
                <div class="vid-thumbs" data-role="thumbs"></div>
                <div class="vid-track vid-video-track" data-role="track"><div class="vid-playhead" data-role="playhead"></div></div>
              </div>
              <div class="vid-audio-track-container" data-role="audioTracks"></div>
            </div>
          </div>
          <div class="vid-scrub" data-role="scrub"></div>
        </div>
        <div class="vid-seglist-label">Keep segments</div>
        <div class="vid-seglist" data-role="seglist"></div>

        <div class="vid-tabs" data-role="tabs">
          <button class="vid-tab active" data-tab="transform">Transform</button>
          <button class="vid-tab" data-tab="resize">Resize</button>
          <button class="vid-tab" data-tab="adjust">Adjust</button>
          <button class="vid-tab" data-tab="text">Text</button>
          <button class="vid-tab" data-tab="audio">Audio</button>
          <button class="vid-tab" data-tab="export">Export</button>
        </div>

        <div class="vid-panel active" data-panel="transform">
          <button type="button" class="vid-btn" data-role="rotL">Rotate ⟲</button>
          <button type="button" class="vid-btn" data-role="rotR">Rotate ⟳</button>
          <button type="button" class="vid-btn" data-role="flipH">Flip H</button>
          <button type="button" class="vid-btn" data-role="flipV">Flip V</button>
          <button type="button" class="vid-btn" data-role="cropToggle">Crop</button>
          <button type="button" class="vid-btn" data-role="cropReset">Reset crop</button>
          <label class="vid-field">Speed <span data-role="speedVal">1.0x</span>
            <input type="range" data-role="speed" min="0.5" max="2" step="0.1" value="1"></label>
        </div>

        <div class="vid-panel" data-panel="resize">
          <label class="vid-field">Output resolution
            <select data-role="res">
              <option value="original">Original</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
              <option value="square">Square 1:1 (social)</option>
            </select></label>
        </div>

        <div class="vid-panel" data-panel="adjust">
          <label class="vid-field">Brightness <span data-role="brVal">0</span>
            <input type="range" data-role="brightness" min="-1" max="1" step="0.05" value="0"></label>
          <label class="vid-field">Contrast <span data-role="ctVal">1.0</span>
            <input type="range" data-role="contrast" min="0" max="2" step="0.05" value="1"></label>
          <label class="vid-field">Saturation <span data-role="saVal">1.0</span>
            <input type="range" data-role="saturation" min="0" max="3" step="0.05" value="1"></label>
          <button type="button" class="vid-btn" data-role="lookNone">Normal</button>
          <button type="button" class="vid-btn" data-role="lookGray">Grayscale</button>
          <button type="button" class="vid-btn" data-role="lookSepia">Sepia</button>
        </div>

        <div class="vid-panel" data-panel="text">
          <label class="vid-field">Caption
            <input type="text" data-role="text" placeholder="Add a title…"></label>
          <label class="vid-field">Position
            <select data-role="textPos">
              <option value="bottom">Bottom</option>
              <option value="center">Center</option>
              <option value="top">Top</option>
            </select></label>
          <label class="vid-field row">Color <input type="color" data-role="textColor" value="#ffffff"></label>
          <label class="vid-field">Size <span data-role="tsVal">36</span>
            <input type="range" data-role="textSize" min="16" max="96" step="2" value="36"></label>
        </div>

        <div class="vid-panel" data-panel="audio">
          <button type="button" class="vid-btn" data-role="mute">Mute audio</button>
          <label class="vid-field">Volume <span data-role="volVal">100%</span>
            <input type="range" data-role="volume" min="0" max="2" step="0.05" value="1"></label>
          <button type="button" class="vid-btn" data-role="extractAudio">Extract audio (.m4a)</button>
          <button type="button" class="vid-btn" data-role="pickAudio">Add background audio…</button>
          <button type="button" class="vid-btn" data-role="replaceMode">Mix under</button>
          <span class="vid-time" data-role="audioName"></span>
          <input type="file" accept="audio/*" data-role="audioFile" hidden>
        </div>

        <div class="vid-panel" data-panel="export">
          <label class="vid-field">Format
            <select data-role="fmt">
              <option value="mp4">MP4 (H.264)</option>
              <option value="webm">WebM (VP9)</option>
            </select></label>
          <span class="vid-time">Export runs on Download / Share / Save.</span>
        </div>

        <div class="vid-statusbar">
          <span class="vid-status" data-role="status"></span>
          <div class="vid-progress" data-role="progress"><span data-role="progressFill"></span></div>
        </div>

        <div class="vid-zoom" data-role="zoom">
          <button type="button" data-zoom="out" title="Zoom out">−</button>
          <input type="range" data-role="zoom-slider" min="50" max="200" value="100" step="10">
          <span data-role="zoom-value">100%</span>
          <button type="button" data-zoom="in" title="Zoom in">+</button>
          <button type="button" data-zoom="reset" title="Reset zoom">Reset</button>
        </div>
      </div>`;

    this.bind();
  }

  private q<T extends HTMLElement>(role: string): T { return this.host.querySelector(`[data-role="${role}"]`) as T; }

  private bind() {
    this.video = this.q('video');
    this.statusEl = this.q('status');
    this.barEl = this.q('progress');
    this.barFill = this.q('progressFill');
    this.playheadEl = this.q('playhead');
    this.trackEl = this.q('track');
    this.timeEl = this.q('time');
    this.cropLayer = this.q('croplayer');
    this.cropBoxEl = this.q('cropbox');
    this.outFmt = this.currentFmt();
    (this.q<HTMLSelectElement>('fmt')).value = this.outFmt;

    this.video.addEventListener('loadedmetadata', () => {
      this.checkPlayability();
    });
    this.video.addEventListener('error', () => {
      this.showUnplayableState();
    });
    this.video.addEventListener('timeupdate', () => this.updateTime());
    this.tickPlayhead();

    // Tabs.
    this.host.querySelectorAll<HTMLElement>('.vid-tab').forEach((t) => {
      t.addEventListener('click', () => {
        this.host.querySelectorAll('.vid-tab').forEach((x) => x.classList.remove('active'));
        this.host.querySelectorAll('.vid-panel').forEach((x) => x.classList.remove('active'));
        t.classList.add('active');
        (this.host.querySelector(`[data-panel="${t.dataset.tab}"]`) as HTMLElement)?.classList.add('active');
      });
    });

    // Transport.
    this.q('play').addEventListener('click', () => {
      if (this.video.paused) { void this.video.play(); this.q('play').textContent = 'Pause'; }
      else { this.video.pause(); this.q('play').textContent = 'Play'; }
    });
    this.q('scrub').addEventListener('click', (e) => this.scrubTo(e as MouseEvent));

    // Segment building: set-in/out mark a pending range; add commits it.
    let pIn = 0, pOut = 0;
    this.q('setin').addEventListener('click', () => { pIn = this.video.currentTime; this.setStatus(`In: ${fmt(pIn)}`); });
    this.q('setout').addEventListener('click', () => { pOut = this.video.currentTime; this.setStatus(`Out: ${fmt(pOut)}`); });
    this.q('addseg').addEventListener('click', () => {
      const s = Math.min(pIn, pOut || this.duration()), e = Math.max(pIn, pOut || this.duration());
      if (e - s < 0.1) { this.setStatus('Set in/out first (segment too short).'); return; }
      this.segments.push({ start: s, end: e });
      this.segments.sort((a, b) => a.start - b.start);
      this.renderSegments();
    });
    this.q('clearseg').addEventListener('click', () => { this.segments = []; this.renderSegments(); });

    // Transform.
    this.q('rotL').addEventListener('click', () => { this.rotate = (this.rotate + 270) % 360; this.applyPreview(); });
    this.q('rotR').addEventListener('click', () => { this.rotate = (this.rotate + 90) % 360; this.applyPreview(); });
    this.q('flipH').addEventListener('click', (e) => { this.flipH = !this.flipH; toggle(e, this.flipH); this.applyPreview(); });
    this.q('flipV').addEventListener('click', (e) => { this.flipV = !this.flipV; toggle(e, this.flipV); this.applyPreview(); });
    this.q('cropToggle').addEventListener('click', (e) => {
      const on = !this.cropLayer.classList.contains('active');
      this.cropLayer.classList.toggle('active', on); toggle(e, on);
      this.setStatus(on ? 'Drag on the video to draw a crop box.' : '');
    });
    this.q('cropReset').addEventListener('click', () => { this.crop = null; this.cropBoxEl.style.width = '0'; });
    this.bindCrop();
    const spd = this.q<HTMLInputElement>('speed');
    spd.addEventListener('input', () => {
      this.speed = Number(spd.value); this.q('speedVal').textContent = `${this.speed.toFixed(1)}x`;
      this.video.playbackRate = Math.max(0.5, Math.min(2, this.speed));
    });

    // Resize.
    const res = this.q<HTMLSelectElement>('res');
    res.addEventListener('change', () => { this.resPreset = res.value as ResPreset; });

    // Adjust.
    const br = this.q<HTMLInputElement>('brightness');
    const ct = this.q<HTMLInputElement>('contrast');
    const sa = this.q<HTMLInputElement>('saturation');
    br.addEventListener('input', () => { this.brightness = Number(br.value); this.q('brVal').textContent = this.brightness.toFixed(2); this.applyPreview(); });
    ct.addEventListener('input', () => { this.contrast = Number(ct.value); this.q('ctVal').textContent = this.contrast.toFixed(2); this.applyPreview(); });
    sa.addEventListener('input', () => { this.saturation = Number(sa.value); this.q('saVal').textContent = this.saturation.toFixed(2); this.applyPreview(); });
    this.q('lookNone').addEventListener('click', () => this.setLook('none'));
    this.q('lookGray').addEventListener('click', () => this.setLook('grayscale'));
    this.q('lookSepia').addEventListener('click', () => this.setLook('sepia'));

    // Text.
    const tx = this.q<HTMLInputElement>('text');
    tx.addEventListener('input', () => { this.text = tx.value; });
    const tp = this.q<HTMLSelectElement>('textPos');
    tp.addEventListener('change', () => { this.textPos = tp.value as TextPos; });
    const tc = this.q<HTMLInputElement>('textColor');
    tc.addEventListener('input', () => { this.textColor = tc.value; });
    const ts = this.q<HTMLInputElement>('textSize');
    ts.addEventListener('input', () => { this.textSize = Number(ts.value); this.q('tsVal').textContent = ts.value; });

    // Audio.
    this.q('mute').addEventListener('click', (e) => {
      this.mute = !this.mute; toggle(e, this.mute); this.video.muted = this.mute;
      (e.currentTarget as HTMLElement).textContent = this.mute ? 'Muted ✓' : 'Mute audio';
    });
    const vol = this.q<HTMLInputElement>('volume');
    vol.addEventListener('input', () => {
      this.volume = Number(vol.value); this.q('volVal').textContent = `${Math.round(this.volume * 100)}%`;
      this.video.volume = Math.min(1, this.volume);
    });
    this.q('extractAudio').addEventListener('click', () => void this.extractAudio());
    const audFile = this.q<HTMLInputElement>('audioFile');
    this.q('pickAudio').addEventListener('click', () => audFile.click());
    audFile.addEventListener('change', () => {
      const f = audFile.files?.[0]; if (!f) return;
      this.extraAudio = f; this.extraAudioName = f.name;
      this.q('audioName').textContent = f.name;
    });
    this.q('replaceMode').addEventListener('click', (e) => {
      this.replaceAudio = !this.replaceAudio; toggle(e, this.replaceAudio);
      (e.currentTarget as HTMLElement).textContent = this.replaceAudio ? 'Replace' : 'Mix under';
    });

    // Export format.
    const fs = this.q<HTMLSelectElement>('fmt');
    fs.addEventListener('change', () => { this.outFmt = fs.value as Fmt; });

    // Zoom controls
    const zoomSlider = this.q<HTMLInputElement>('zoom-slider');
    const zoomValue = this.q('zoom-value');
    const zoomContainer = this.q('zoom');
    const updateZoom = (val: number) => {
      this.zoom = Math.max(50, Math.min(200, val));
      zoomSlider.value = String(this.zoom);
      zoomValue.textContent = `${this.zoom}%`;
      this.video.style.transform = `scale(${this.zoom / 100})`;
      this.video.style.transformOrigin = 'top left';
    };
    if (zoomContainer) {
      zoomContainer.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest('button');
        if (!btn) return;
        const zoomAction = btn.getAttribute('data-zoom');
        if (zoomAction === 'in') updateZoom(this.zoom + 10);
        else if (zoomAction === 'out') updateZoom(this.zoom - 10);
        else if (zoomAction === 'reset') updateZoom(100);
      });
    }
    if (zoomSlider) {
      zoomSlider.addEventListener('input', () => updateZoom(Number(zoomSlider.value)));
    }
  }

  private setLook(l: Look) {
    this.look = l;
    for (const [role, val] of [['lookNone', 'none'], ['lookGray', 'grayscale'], ['lookSepia', 'sepia']] as const) {
      this.q(role).classList.toggle('active', this.look === val);
    }
    this.applyPreview();
  }

  // Best-effort CSS preview of colour/transform edits on the <video>. Crop,
  // scale, speed-baking, text and concat are only reflected in the export.
  private applyPreview() {
    const t: string[] = [];
    if (this.rotate) t.push(`rotate(${this.rotate}deg)`);
    if (this.flipH) t.push('scaleX(-1)');
    if (this.flipV) t.push('scaleY(-1)');
    this.video.style.transform = t.join(' ');
    const f: string[] = [];
    if (this.brightness !== 0) f.push(`brightness(${1 + this.brightness})`);
    if (this.contrast !== 1) f.push(`contrast(${this.contrast})`);
    if (this.saturation !== 1) f.push(`saturate(${this.saturation})`);
    if (this.look === 'grayscale') f.push('grayscale(1)');
    if (this.look === 'sepia') f.push('sepia(0.85)');
    this.video.style.filter = f.join(' ');
  }

  private async extractAudio() {
    this.setStatus('Extracting audio…');
    this.showProgress(true);
    const inName = 'in' + this.extOf(this.name);
    try {
      const ff = await getFfmpeg((r) => this.setProgress(r));
      const { fetchFile } = await import('@ffmpeg/util');
      await ff.writeFile(inName, await fetchFile(this.blob));
      await ff.exec(['-i', inName, '-vn', '-c:a', 'aac', '-b:a', '192k', 'audio.m4a']);
      const data = await ff.readFile('audio.m4a');
      const bytes = data instanceof Uint8Array ? data : new Uint8Array();
      const part = new Uint8Array(bytes.length); part.set(bytes);
      await this.cleanupFs(ff, [inName, 'audio.m4a']);
      const blob = new Blob([part], { type: 'audio/mp4' });
      const u = URL.createObjectURL(blob); this.objectUrls.push(u);
      const a = document.createElement('a');
      a.href = u; a.download = this.name.replace(/\.[^.]+$/, '') + '.m4a';
      a.click();
      this.showProgress(false);
      this.setStatus('Audio extracted.');
    } catch (err) {
      this.fail('Audio extraction failed', err);
    }
  }

  // ---- Timeline ---------------------------------------------------------

  private renderSegments() {
    const list = this.q('seglist');
    list.innerHTML = '';
    this.segments.forEach((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'vid-chip';
      chip.innerHTML = `<span>${fmt(s.start)}–${fmt(s.end)}</span>`;
      const rm = document.createElement('button');
      rm.type = 'button'; rm.textContent = '×'; rm.title = 'Remove';
      rm.addEventListener('click', () => { this.segments.splice(i, 1); this.renderSegments(); });
      chip.appendChild(rm);
      list.appendChild(chip);
    });
    // Shade kept regions on the track.
    this.trackEl.querySelectorAll('.vid-seg').forEach((n) => n.remove());
    const d = this.duration(); if (!d) return;
    for (const s of this.segments) {
      const el = document.createElement('div');
      el.className = 'vid-seg';
      el.style.left = `${(s.start / d) * 100}%`;
      el.style.width = `${((s.end - s.start) / d) * 100}%`;
      this.trackEl.insertBefore(el, this.playheadEl);
    }
    this.renderAudioTracks();
  }

  private renderAudioTracks() {
    const container = this.q('audioTracks') as HTMLElement;
    container.innerHTML = '';
    if (this.extraAudio) {
      const track = document.createElement('div');
      track.className = 'vid-audio-track';
      const mode = this.replaceAudio ? 'Replace' : 'Mix under';
      track.textContent = `🔊 ${mode}: ${this.extraAudioName || 'audio.m4a'}`;
      container.appendChild(track);
    } else {
      const empty = document.createElement('div');
      empty.style.padding = '8px';
      empty.style.fontSize = '12px';
      empty.style.color = 'var(--text-muted)';
      empty.textContent = 'No audio track';
      container.appendChild(empty);
    }
  }

  private scrubTo(e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const d = this.duration(); if (d) this.video.currentTime = ratio * d;
  }

  private tickPlayhead() {
    const loop = () => {
      const d = this.duration();
      if (d) this.playheadEl.style.left = `${(this.video.currentTime / d) * 100}%`;
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  private updateTime() {
    this.timeEl.textContent = `${fmt(this.video.currentTime)} / ${fmt(this.duration())}`;
  }

  // Check if video can actually be played in the browser
  private checkPlayability() {
    const dur = this.duration();
    // Video is unplayable if duration is 0, NaN, or Infinity after metadata loaded
    if (!dur || !isFinite(dur) || this.video.readyState === 0) {
      this.showUnplayableState();
    } else {
      // Video is playable
      this.setStatus(`${this.name} · ${fmt(dur)}`);
      this.updateTime();
      void this.buildThumbnails();
    }
  }

  // Replace the editor UI with a clear "unplayable format" message
  private showUnplayableState() {
    const ext = this.name.split('.').pop()?.toUpperCase() || 'video';
    this.host.innerHTML = `
      <div class="vid-editor">
        <div class="vid-unplayable">
          <div class="vid-unplayable-icon">🎬</div>
          <h3 class="vid-unplayable-title">Video format not supported</h3>
          <p class="vid-unplayable-message">
            This video format (.${ext.toLowerCase()}) can't be played in the browser.
            Download the file to view it in another app.
          </p>
          <div class="vid-unplayable-info">
            <strong>Supported formats:</strong> MP4, WebM, MOV (H.264), OGV, M4V
          </div>
        </div>
      </div>`;
  }

  // Extract ~12 preview frames by seeking the <video> and drawing to a canvas.
  // Pure client-side, no ffmpeg — keeps the timeline responsive.
  private async buildThumbnails() {
    const thumbs = this.q('thumbs');
    thumbs.innerHTML = '';
    const d = this.duration();
    if (!d) return;
    const count = 12;
    const cw = 96, ch = 54;
    const src = document.createElement('video');
    src.src = this.url; src.muted = true; src.preload = 'auto';
    try { await once(src, 'loadeddata'); } catch { return; }
    const canvasBase = document.createElement('canvas');
    canvasBase.width = cw; canvasBase.height = ch;
    const ctx = canvasBase.getContext('2d');
    if (!ctx) return;
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) * (d / count);
      try {
        src.currentTime = Math.min(t, d - 0.05);
        await once(src, 'seeked');
        ctx.drawImage(src, 0, 0, cw, ch);
        const img = document.createElement('img');
        img.src = canvasBase.toDataURL('image/jpeg', 0.6);
        thumbs.appendChild(img);
      } catch { /* skip frame */ }
    }
    src.src = '';
  }

  // ---- Crop drag --------------------------------------------------------

  private bindCrop() {
    const layer = this.cropLayer;
    const toNorm = (e: MouseEvent) => {
      const r = layer.getBoundingClientRect();
      return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r };
    };
    layer.addEventListener('mousedown', (e) => {
      const p = toNorm(e as MouseEvent);
      this.cropDrag = { x: p.x, y: p.y };
    });
    layer.addEventListener('mousemove', (e) => {
      if (!this.cropDrag) return;
      const p = toNorm(e as MouseEvent);
      const x = Math.min(this.cropDrag.x, p.x), y = Math.min(this.cropDrag.y, p.y);
      const w = Math.abs(p.x - this.cropDrag.x), h = Math.abs(p.y - this.cropDrag.y);
      this.paintCropBox(x, y, w, h);
      this.crop = clamp01(x, y, w, h);
    });
    const end = () => { this.cropDrag = null; };
    layer.addEventListener('mouseup', end);
    layer.addEventListener('mouseleave', end);
  }

  private paintCropBox(x: number, y: number, w: number, h: number) {
    this.cropBoxEl.style.left = `${x * 100}%`;
    this.cropBoxEl.style.top = `${y * 100}%`;
    this.cropBoxEl.style.width = `${w * 100}%`;
    this.cropBoxEl.style.height = `${h * 100}%`;
  }

  // ---- Status -----------------------------------------------------------

  private setStatus(t: string) { if (this.statusEl) this.statusEl.textContent = t; }
  private showProgress(on: boolean) { this.barEl?.classList.toggle('active', on); if (!on) this.setProgress(0); }
  private setProgress(r: number) {
    const pct = Math.round(Math.max(0, Math.min(1, r)) * 100);
    if (this.barFill) this.barFill.style.width = `${pct}%`;
    if (pct > 0) this.setStatus(`Processing… ${pct}%`);
  }
}

// ---- helpers ------------------------------------------------------------

function fmt(sec: number): string {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function f3(n: number): string { return (Math.round(n * 1000) / 1000).toString(); }

function toggle(e: Event, force?: boolean) {
  const el = e.currentTarget as HTMLElement;
  el.classList.toggle('active', force);
}

function clamp01(x: number, y: number, w: number, h: number): CropRect {
  x = Math.max(0, Math.min(1, x)); y = Math.max(0, Math.min(1, y));
  w = Math.max(0.01, Math.min(1 - x, w)); h = Math.max(0.01, Math.min(1 - y, h));
  return { x, y, w, h };
}

// atempo only accepts 0.5..2.0 per stage; chain stages for wider factors.
function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2.0'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  out.push(`atempo=${f3(s)}`);
  return out;
}

function once(el: HTMLMediaElement, ev: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const err = () => { cleanup(); reject(new Error('media error')); };
    const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', err); };
    el.addEventListener(ev, ok, { once: true });
    el.addEventListener('error', err, { once: true });
  });
}
