import './styles/video.css';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { DocEditor } from './registry';
import { getFfmpeg } from './ffmpegLoader';
import { type EditCommands, getAppClipboard, setAppClipboard } from './editCommands';

// Multi-clip, client-side video editor.
//  - Main track: clips played back-to-back (add video/image, split, trim, reorder, delete).
//  - Overlay tracks: clips composited on top inside a box (picture-in-picture,
//    side-by-side, top/bottom), each with its own timing, crop and opacity.
// The preview canvas is composited from hidden <video>/<img> elements with the
// same crop + fit math the ffmpeg export uses, so the export matches the preview.

interface Rect { x: number; y: number; w: number; h: number; } // normalized 0..1

interface Clip {
  id: string;
  blob: Blob;
  name: string;
  kind: 'video' | 'image';
  srcDur: number;
  natW: number;
  natH: number;
  in: number;
  out: number;
  crop: Rect | null;
  speed: number;  // per-clip playback speed (main track only)
  volume: number; // 0..2
}

interface Overlay extends Clip {
  start: number;
  box: Rect;
  opacity: number;
  audio: boolean;
}

interface AudioClip {
  id: string;
  blob: Blob;
  name: string;
  srcDur: number;
  in: number;
  out: number;
  start: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
}

interface TextClip {
  id: string;
  text: string;
  srcDur: number;
  in: number;
  out: number;
  start: number;
  x: number;        // normalized centre of the text in the frame
  y: number;
  size: number;     // font size in output-frame pixels
  color: string;
  bold: boolean;
  bg: boolean;
  bgOpacity: number;
}

type Track = 'main' | 'ov' | 'au' | 'tx';
type Timed = Overlay | AudioClip | TextClip;
type Fit = 'contain' | 'cover';
type Look = 'none' | 'grayscale' | 'sepia';
type Fmt = 'mp4' | 'webm';
type ResPreset = 'original' | '1080p' | '720p' | '480p' | 'square' | 'vertical';
type Layout = 'full' | 'side' | 'stack' | 'pip';
type Sel = { track: Track; id: string } | null;
interface VideoClipboard { track: Track; item: Clip | Overlay | AudioClip | TextClip; }
interface Snapshot { main: Clip[]; overlays: Overlay[]; audios: AudioClip[]; texts: TextClip[]; mainBox: Rect; mainFit: Fit; }
type Drag =
  | { kind: 'scrub' }
  | { kind: 'trim'; id: string; side: 'l' | 'r'; x0: number; in0: number; out0: number; start0: number; hist: boolean }
  | { kind: 'moveOv'; id: string; x0: number; start0: number; hist: boolean }
  | { kind: 'reorder'; id: string; x0: number; el: HTMLElement; moved: boolean }
  | { kind: 'box'; id: string; mode: 'move' | 'resize'; px0: number; py0: number; box0: Rect; hist: boolean }
  | { kind: 'text'; id: string; px0: number; py0: number; x0: number; y0: number; hist: boolean };

// drawtext needs a real font file inside the ffmpeg FS; the wasm core ships none.
const FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';
const FONT_FILE = 'font.ttf';
const FONT_BOLD_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans-Bold.ttf';
const FONT_BOLD_FILE = 'font-bold.ttf';
const TEXT_DEFAULT_DUR = 3;
const TEXT_MAX_DUR = 3600;
const FPS = 30;

export interface VideoEditorOptions {
  // Saves an image (e.g. a thumbnail) into the file library.
  saveImage?: (blob: Blob, name: string) => Promise<void>;
  toast?: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}
const MIN_LEN = 0.1;
const IMAGE_DEFAULT_DUR = 3;
const IMAGE_MAX_DUR = 600;
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const AFMT = 'aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo';

let idSeq = 0;
const uid = (): string => `c${Date.now().toString(36)}${(++idSeq).toString(36)}`;
// Timeline length: source range divided by the clip's speed.
const len = (c: { in: number; out: number; speed?: number }): number => (c.out - c.in) / (c.speed ?? 1);

export class VideoEditor implements DocEditor {
  private host: HTMLElement;
  private blob: Blob;
  private name: string;
  private urls = new Map<Blob, string>();
  private media = new Map<string, HTMLVideoElement | HTMLImageElement>();
  private thumbs = new Map<string, string>();
  private thumbQueue: Clip[] = [];
  private thumbBusy = false;
  private thumbVid: HTMLVideoElement | null = null;

  // Timeline state
  private main: Clip[] = [];
  private overlays: Overlay[] = [];
  private mainBox: Rect = { ...FULL };
  private mainFit: Fit = 'contain';
  private sel: Sel = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private pendingLayout: Layout | null = null;
  private sliderSession = false;

  // Playback
  private t = 0;
  private playing = false;
  private lastTs = 0;
  private waitSince = 0;
  private raf = 0;
  private idleTimer = 0;
  private lastActivity = 0;
  private pps = 50;
  private zoom = 100;
  private tlDirty = true;
  private drag: Drag | null = null;

  // Global effects (applied to the whole composition on export)
  private rotate = 0;
  private flipH = false;
  private flipV = false;
  private speed = 1;
  private brightness = 0;
  private contrast = 1;
  private saturation = 1;
  private look: Look = 'none';
  private mute = false;
  private volume = 1;
  private muteOriginal = false;            // drop the video clips' own sound
  private audios: AudioClip[] = [];
  private texts: TextClip[] = [];
  private textBoxes = new Map<string, Rect>(); // last drawn text bounds (normalized), for hit-testing
  private audioEls = new Map<string, HTMLAudioElement>();
  private outFmt: Fmt = 'mp4';
  private resPreset: ResPreset = 'original';

  // DOM
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private pool!: HTMLElement;
  private statusEl!: HTMLElement;
  private barEl!: HTMLElement;
  private barFill!: HTMLElement;
  private timeEl!: HTMLElement;
  private tlLabels!: HTMLElement;
  private tlScroll!: HTMLElement;
  private tlInner!: HTMLElement;
  private playheadEl: HTMLElement | null = null;
  private propsEl!: HTMLElement;
  private clipFile!: HTMLInputElement;
  private ovFile!: HTMLInputElement;
  private auFile!: HTMLInputElement;
  private resizeObs: ResizeObserver | null = null;

  private constructor(host: HTMLElement, blob: Blob, name: string, private opts: VideoEditorOptions = {}) {
    this.host = host;
    this.blob = blob;
    this.name = name;
  }

  static async open(host: HTMLElement, blob: Blob, name: string, opts: VideoEditorOptions = {}): Promise<VideoEditor> {
    const ed = new VideoEditor(host, blob, name, opts);
    try {
      ed.main.push(await ed.makeClip(blob, name));
    } catch {
      ed.showUnplayableState();
      return ed;
    }
    ed.outFmt = ed.currentFmt();
    ed.render();
    return ed;
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.idleTimer);
    this.raf = 0;
    document.removeEventListener('pointermove', this.onDocMove);
    document.removeEventListener('pointerup', this.onDocUp);
    document.removeEventListener('keydown', this.onKey);
    this.resizeObs?.disconnect();
    for (const el of this.media.values()) {
      if (el instanceof HTMLVideoElement) { el.pause(); el.removeAttribute('src'); el.load(); }
    }
    this.media.clear();
    for (const a of this.audioEls.values()) { a.pause(); a.removeAttribute('src'); }
    this.audioEls.clear();
    if (this.thumbVid) this.thumbVid.removeAttribute('src');
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
  }

  // ---- Model helpers --------------------------------------------------------

  private urlFor(b: Blob): string {
    let u = this.urls.get(b);
    if (!u) { u = URL.createObjectURL(b); this.urls.set(b, u); }
    return u;
  }

  private async makeClip(blob: Blob, name: string): Promise<Clip> {
    const p = await probeMedia(blob, name, this.urlFor(blob));
    return {
      id: uid(), blob, name: name.replace(/\.[^.]+$/, '') || name, kind: p.kind,
      srcDur: p.dur, natW: p.w, natH: p.h, in: 0,
      out: p.kind === 'image' ? IMAGE_DEFAULT_DUR : p.dur, crop: null, speed: 1, volume: 1,
    };
  }

  private total(): number { return this.main.reduce((s, c) => s + len(c), 0); }

  private startOf(c: Clip): number {
    let s = 0;
    for (const m of this.main) { if (m === c) return s; s += len(m); }
    return 0;
  }

  // Main clip under time t. With clampEnd, t >= total resolves to the last clip.
  private mainAt(t: number, clampEnd = true): { clip: Clip; start: number; index: number } | null {
    let s = 0;
    for (let i = 0; i < this.main.length; i++) {
      const c = this.main[i]!;
      if (t >= s && t < s + len(c)) return { clip: c, start: s, index: i };
      s += len(c);
    }
    if (clampEnd && this.main.length) {
      const i = this.main.length - 1;
      const c = this.main[i]!;
      return { clip: c, start: s - len(c), index: i };
    }
    return null;
  }

  private find(id: string): { item: Clip; track: 'main' } | { item: Overlay; track: 'ov' } | { item: AudioClip; track: 'au' } | { item: TextClip; track: 'tx' } | null {
    const m = this.main.find((c) => c.id === id);
    if (m) return { item: m, track: 'main' };
    const o = this.overlays.find((c) => c.id === id);
    if (o) return { item: o, track: 'ov' };
    const a = this.audios.find((c) => c.id === id);
    if (a) return { item: a, track: 'au' };
    const x = this.texts.find((c) => c.id === id);
    return x ? { item: x, track: 'tx' } : null;
  }

  private listOf(track: 'ov' | 'au' | 'tx'): Timed[] {
    return track === 'ov' ? this.overlays : track === 'au' ? this.audios : this.texts;
  }

  private ovActive(o: Timed): boolean { return this.t >= o.start && this.t < o.start + len(o); }

  // Times (seconds) that dragged overlay/audio edges snap to.
  private snapTargets(exceptId: string): number[] {
    const pts = [0, this.t, this.total()];
    let s = 0;
    for (const c of this.main) { s += len(c); pts.push(s); }
    for (const o of [...this.overlays, ...this.audios, ...this.texts]) {
      if (o.id === exceptId) continue;
      pts.push(o.start, o.start + len(o));
    }
    return pts;
  }

  private snapTo(v: number, pts: number[]): number {
    const tol = 8 / this.pps;
    let best = v, bd = tol;
    for (const p of pts) { const d = Math.abs(p - v); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  private frameSize(): { W: number; H: number } {
    const b = this.main[0];
    const w0 = b?.natW || 1280, h0 = b?.natH || 720;
    switch (this.resPreset) {
      case 'square': return { W: 1080, H: 1080 };
      case 'vertical': return { W: 1080, H: 1920 };
      case '1080p': case '720p': case '480p': {
        const short = this.resPreset === '1080p' ? 1080 : this.resPreset === '720p' ? 720 : 480;
        return w0 >= h0 ? { W: even(w0 * short / h0), H: short } : { W: short, H: even(h0 * short / w0) };
      }
      default: return { W: even(w0), H: even(h0) };
    }
  }

  // ---- History --------------------------------------------------------------

  private snap(): Snapshot {
    return {
      main: this.main.map((c) => ({ ...c, crop: c.crop && { ...c.crop } })),
      overlays: this.overlays.map((o) => ({ ...o, crop: o.crop && { ...o.crop }, box: { ...o.box } })),
      audios: this.audios.map((a) => ({ ...a })),
      texts: this.texts.map((x) => ({ ...x })),
      mainBox: { ...this.mainBox },
      mainFit: this.mainFit,
    };
  }

  private pushHistory(): void {
    this.undoStack.push(this.snap());
    if (this.undoStack.length > 60) this.undoStack.shift();
    this.redoStack = [];
    this.syncUndoButtons();
  }

  private restore(s: Snapshot): void {
    this.main = s.main;
    this.overlays = s.overlays;
    this.audios = s.audios;
    this.texts = s.texts;
    this.mainBox = s.mainBox;
    this.mainFit = s.mainFit;
    this.structureChanged();
    this.syncLayoutControls();
  }

  private undo(): void {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(this.snap());
    this.restore(s);
  }

  private redo(): void {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(this.snap());
    this.restore(s);
  }

  private syncUndoButtons(): void {
    const u = this.host.querySelector<HTMLButtonElement>('[data-act="undo"]');
    const r = this.host.querySelector<HTMLButtonElement>('[data-act="redo"]');
    if (u) u.disabled = this.undoStack.length === 0;
    if (r) r.disabled = this.redoStack.length === 0;
  }

  // Call after any change to clips/overlays (not per-frame tweaks).
  private structureChanged(): void {
    this.lastActivity = performance.now();
    const T = this.total();
    if (this.t > T) this.t = T;
    if (this.sel && !this.find(this.sel.id)) this.sel = null;
    this.gcMedia();
    this.tlDirty = true;
    this.renderProps();
    this.syncUndoButtons();
  }

  // ---- Editing operations ---------------------------------------------------

  private split(): void {
    const tr = this.sel?.track;
    if (tr === 'ov' || tr === 'au' || tr === 'tx') {
      const list = this.listOf(tr);
      const idx = list.findIndex((o) => o.id === this.sel!.id);
      const o = list[idx];
      if (o && this.t > o.start + MIN_LEN && this.t < o.start + len(o) - MIN_LEN) {
        this.pushHistory();
        const cut = o.in + (this.t - o.start);
        const b = cloneTimed(o, uid());
        b.in = cut;
        b.start = this.t;
        o.out = cut;
        list.splice(idx + 1, 0, b);
        this.sel = { track: tr, id: b.id };
        this.setStatus(`Split at ${fmtT(this.t)}`);
        this.structureChanged();
        return;
      }
      if (tr !== 'ov') { this.setStatus('Move the playhead inside the selected clip to split it.'); return; }
    }
    const cur = this.mainAt(this.t, false);
    if (!cur) { this.setStatus('Move the playhead inside a clip to split it.'); return; }
    const local = cur.clip.in + (this.t - cur.start) * cur.clip.speed;
    if (local - cur.clip.in < MIN_LEN || cur.clip.out - local < MIN_LEN) {
      this.setStatus('Move the playhead inside a clip (not on its edge) to split it.');
      return;
    }
    this.pushHistory();
    const b: Clip = { ...cur.clip, id: uid(), in: local, crop: cur.clip.crop && { ...cur.clip.crop } };
    cur.clip.out = local;
    this.main.splice(cur.index + 1, 0, b);
    this.sel = { track: 'main', id: b.id };
    this.setStatus(`Split at ${fmtT(this.t)}`);
    this.structureChanged();
  }

  private duplicateSelected(): void {
    const f = this.sel ? this.find(this.sel.id) : null;
    if (!f) { this.setStatus('Select a clip to duplicate.'); return; }
    this.pushHistory();
    if (f.track === 'main') {
      const i = this.main.indexOf(f.item);
      const c: Clip = { ...f.item, id: uid(), crop: f.item.crop && { ...f.item.crop } };
      this.main.splice(i + 1, 0, c);
      this.sel = { track: 'main', id: c.id };
      this.t = this.startOf(c);
    } else {
      const list = this.listOf(f.track);
      const c = cloneTimed(f.item, uid());
      const T = this.total();
      const after = f.item.start + len(f.item);
      c.start = after + len(c) <= T ? after : f.item.start;
      list.splice(list.indexOf(f.item) + 1, 0, c);
      this.sel = { track: f.track, id: c.id };
      this.t = c.start;
    }
    this.setStatus('Duplicated.');
    this.structureChanged();
  }

  private deleteSelected(): void {
    if (!this.sel) { this.setStatus('Select a clip first.'); return; }
    const f = this.find(this.sel.id);
    if (!f) return;
    if (f.track === 'main' && this.main.length === 1) {
      this.setStatus("Can't delete the only clip on the main track.");
      return;
    }
    this.pushHistory();
    if (f.track === 'main') this.main = this.main.filter((c) => c.id !== f.item.id);
    else if (f.track === 'ov') this.overlays = this.overlays.filter((c) => c.id !== f.item.id);
    else if (f.track === 'au') this.audios = this.audios.filter((c) => c.id !== f.item.id);
    else this.texts = this.texts.filter((c) => c.id !== f.item.id);
    this.sel = null;
    this.structureChanged();
  }

  // ---- Shared edit commands (shell owns shortcuts + long-press menu) --------

  commands(): EditCommands {
    return {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.undoStack.length > 0,
      canRedo: () => this.redoStack.length > 0,
      hasSelection: () => !!this.sel && !!this.find(this.sel.id),
      canPaste: () => true,
      copy: () => { this.copySelected(); },
      cut: () => { if (this.copySelected()) this.deleteSelected(); },
      delete: () => this.deleteSelected(),
      duplicate: () => this.duplicateSelected(),
      paste: (data) => this.pasteFrom(data),
    };
  }

  private copySelected(): boolean {
    const f = this.sel ? this.find(this.sel.id) : null;
    if (!f) return false;
    const item = f.track === 'main' ? { ...f.item, crop: f.item.crop && { ...f.item.crop } } : cloneTimed(f.item as Timed, f.item.id);
    setAppClipboard('video-item', { track: f.track, item } satisfies VideoClipboard);
    if (f.track === 'tx') void navigator.clipboard?.writeText((f.item as TextClip).text).catch(() => {});
    this.setStatus('Copied.');
    return true;
  }

  private async pasteFrom(data?: DataTransfer | null): Promise<void> {
    const files = data ? Array.from(data.files) : [];
    const visual = files.filter((f) => f.type.startsWith('video/') || f.type.startsWith('image/'));
    const sound = files.filter((f) => f.type.startsWith('audio/'));
    if (visual.length || sound.length) {
      if (visual.length) await this.addMainClips(visual);
      if (sound.length) await this.addAudioClips(sound);
      return;
    }
    const clip = getAppClipboard<VideoClipboard>('video-item');
    let text = data ? data.getData('text/plain') : '';
    // A copied text clip also lands on the system clipboard; keep its styling.
    if (clip && (!text || (clip.track === 'tx' && (clip.item as TextClip).text === text))) { this.pasteItem(clip); return; }
    if (!data && !text) text = await navigator.clipboard?.readText().catch(() => '') ?? '';
    text = text.trim();
    if (text) { this.addText(text.slice(0, 500)); return; }
    this.setStatus('Nothing to paste — copy a clip first.');
  }

  private pasteItem(cb: VideoClipboard): void {
    this.pushHistory();
    const T = this.total();
    if (cb.track === 'main') {
      const src = cb.item as Clip;
      const c: Clip = { ...src, id: uid(), crop: src.crop && { ...src.crop } };
      const cur = this.mainAt(this.t);
      const at = cur ? cur.index + 1 : this.main.length;
      this.main.splice(at, 0, c);
      this.sel = { track: 'main', id: c.id };
      this.t = this.startOf(c);
    } else {
      const c = cloneTimed(cb.item as Timed, uid());
      c.start = this.t >= T - 0.05 ? 0 : this.t;
      (this.listOf(cb.track) as Timed[]).push(c);
      this.sel = { track: cb.track, id: c.id };
      this.t = Math.min(c.start + 0.01, T);
    }
    this.setStatus('Pasted.');
    this.structureChanged();
  }

  private async addAudioClips(files: File[]): Promise<void> {
    const added: AudioClip[] = [];
    const T = this.total();
    for (const f of files) {
      try {
        const dur = await probeAudioDuration(this.urlFor(f));
        const start = this.t >= T - 0.5 ? 0 : this.t;
        added.push({
          id: uid(), blob: f, name: f.name.replace(/\.[^.]+$/, '') || f.name, srcDur: dur,
          in: 0, out: Math.min(dur, Math.max(MIN_LEN, T - start)), start, volume: 1, fadeIn: 0, fadeOut: 0,
        });
      } catch {
        this.setStatus(`Couldn't open "${f.name}" — unsupported audio format.`);
      }
    }
    if (!added.length) return;
    this.pushHistory();
    this.audios.push(...added);
    this.sel = { track: 'au', id: added[added.length - 1]!.id };
    this.setStatus(`Added ${added.length} audio clip${added.length > 1 ? 's' : ''}. Drag to move, drag edges to trim; overlapping clips are mixed.`);
    this.structureChanged();
  }

  private addText(text = 'Your text', full = false): TextClip {
    const T = this.total();
    const start = full || this.t >= T - 0.5 ? 0 : this.t;
    const dur = full ? T : Math.min(TEXT_DEFAULT_DUR, Math.max(MIN_LEN, T - start));
    const { H } = this.frameSize();
    const x: TextClip = {
      id: uid(), text, srcDur: TEXT_MAX_DUR, in: 0, out: dur, start,
      x: 0.5, y: 0.85, size: Math.max(16, Math.round(H * 0.06)), color: '#ffffff',
      bold: true, bg: true, bgOpacity: 0.4,
    };
    this.pushHistory();
    this.texts.push(x);
    this.sel = { track: 'tx', id: x.id };
    this.t = Math.min(start + 0.01, T);
    this.showTab('clip');
    this.structureChanged();
    this.setStatus('Text added. Edit it in the Clip tab, drag it on the preview, drag its edges on the timeline to time it.');
    return x;
  }

  private moveMain(dir: -1 | 1): void {
    if (this.sel?.track !== 'main') { this.setStatus('Select a clip on the main track to move it.'); return; }
    const i = this.main.findIndex((c) => c.id === this.sel!.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.main.length) return;
    this.pushHistory();
    const [c] = this.main.splice(i, 1);
    this.main.splice(j, 0, c!);
    this.t = this.startOf(c!);
    this.structureChanged();
  }

  private async addMainClips(files: File[]): Promise<void> {
    const added: Clip[] = [];
    for (const f of files) {
      try { added.push(await this.makeClip(f, f.name)); }
      catch { this.setStatus(`Couldn't open "${f.name}" — unsupported format.`); }
    }
    if (!added.length) return;
    this.pushHistory();
    const selIdx = this.sel?.track === 'main' ? this.main.findIndex((c) => c.id === this.sel!.id) : -1;
    const at = selIdx >= 0 ? selIdx + 1 : this.main.length;
    this.main.splice(at, 0, ...added);
    const last = added[added.length - 1]!;
    this.sel = { track: 'main', id: last.id };
    this.t = this.startOf(added[0]!);
    this.setStatus(`Added ${added.length} clip${added.length > 1 ? 's' : ''} to the main track.`);
    this.structureChanged();
  }

  private async addOverlay(file: File): Promise<void> {
    let c: Clip;
    try { c = await this.makeClip(file, file.name); }
    catch { this.setStatus(`Couldn't open "${file.name}" — unsupported format.`); this.pendingLayout = null; return; }
    const T = this.total();
    let start = this.pendingLayout ? 0 : Math.min(this.t, T);
    if (T - start < 0.5) start = 0;
    const room = Math.max(MIN_LEN, T - start);
    const o: Overlay = {
      ...c, start,
      out: c.kind === 'image' ? room : Math.min(c.srcDur, room),
      box: { ...FULL }, opacity: 1, audio: false,
    };
    o.box = this.pipBox(o);
    this.pushHistory();
    this.overlays.push(o);
    this.sel = { track: 'ov', id: o.id };
    const layout = this.pendingLayout;
    this.pendingLayout = null;
    if (layout) this.applyLayout(layout, false);
    else this.setStatus('Overlay added. Drag it on the preview to move, drag its corner to resize.');
    this.structureChanged();
  }

  private pipBox(o: Clip): Rect {
    const { W, H } = this.frameSize();
    const cr = o.crop ?? FULL;
    const srcA = (o.natW * cr.w) / Math.max(1, o.natH * cr.h);
    let w = 0.32;
    let h = (w * W) / H / srcA;
    if (h > 0.45) { h = 0.45; w = (h * H * srcA) / W; }
    return { x: Math.max(0, 1 - w - 0.03), y: Math.max(0, 1 - h - 0.04), w, h };
  }

  private applyLayout(kind: Layout, record = true): void {
    const ov = (this.sel?.track === 'ov' ? this.overlays.find((o) => o.id === this.sel!.id) : undefined) ?? this.overlays[0];
    if (kind !== 'full' && !ov) {
      this.pendingLayout = kind;
      this.setStatus('Pick the second video/image to place on screen…');
      this.ovFile.click();
      return;
    }
    if (record) this.pushHistory();
    const T = this.total();
    const spanWhole = (o: Overlay): void => {
      o.start = 0;
      o.out = o.kind === 'image' ? o.in + T : Math.min(o.srcDur, o.in + T);
    };
    switch (kind) {
      case 'full':
        this.mainBox = { ...FULL };
        this.mainFit = 'contain';
        break;
      case 'side':
        this.mainBox = { x: 0, y: 0, w: 0.5, h: 1 };
        this.mainFit = 'cover';
        ov!.box = { x: 0.5, y: 0, w: 0.5, h: 1 };
        spanWhole(ov!);
        break;
      case 'stack':
        this.mainBox = { x: 0, y: 0, w: 1, h: 0.5 };
        this.mainFit = 'cover';
        ov!.box = { x: 0, y: 0.5, w: 1, h: 0.5 };
        spanWhole(ov!);
        break;
      case 'pip':
        this.mainBox = { ...FULL };
        this.mainFit = 'contain';
        ov!.box = this.pipBox(ov!);
        break;
    }
    const names: Record<Layout, string> = { full: 'Full frame', side: 'Side by side', stack: 'Top / bottom', pip: 'Picture-in-picture' };
    this.setStatus(`Layout: ${names[kind]}. Use crop in the Clip tab to choose which part of each video shows.`);
    this.syncLayoutControls();
    this.structureChanged();
  }

  // Keep only [a, b] of the timeline (used by AI trims).
  private trimTimeline(a: number, b: number): void {
    const T = this.total();
    a = clamp(a, 0, T);
    b = clamp(b, a + MIN_LEN, T);
    const out: Clip[] = [];
    let s = 0;
    for (const c of this.main) {
      const e = s + len(c);
      const lo = Math.max(a, s), hi = Math.min(b, e);
      if (hi - lo > 0.01) out.push({ ...c, id: uid(), in: c.in + (lo - s) * c.speed, out: c.in + (hi - s) * c.speed });
      s = e;
    }
    if (out.length) this.main = out;
    const cut = <X extends Timed>(o: X): X[] => {
      const os = o.start, oe = o.start + len(o);
      const lo = Math.max(a, os), hi = Math.min(b, oe);
      if (hi - lo <= 0.01) return [];
      return [{ ...o, in: o.in + (lo - os), out: o.in + (hi - os), start: lo - a }];
    };
    this.overlays = this.overlays.flatMap(cut);
    this.audios = this.audios.flatMap(cut);
    this.texts = this.texts.flatMap(cut);
  }

  /** Apply an AI-generated non-destructive patch. Returns a summary. */
  applyAiPatch(patch: Record<string, unknown>): string {
    const done: string[] = [];
    const num = (v: unknown): number | null => (typeof v === 'number' && isFinite(v) ? v : null);
    this.pushHistory();
    const ts = num(patch.trimStart), te = num(patch.trimEnd);
    if (ts != null || te != null) { this.trimTimeline(ts ?? 0, te ?? this.total()); done.push('trimmed'); }
    if (patch.mute === true) { this.mute = true; done.push('muted'); }
    const sp = num(patch.speed); if (sp != null && sp > 0) { this.speed = clamp(sp, 0.5, 2); done.push(`speed ${this.speed}x`); }
    if (patch.rotate === 90 || patch.rotate === 180 || patch.rotate === 270) { this.rotate = patch.rotate; done.push(`rotated ${patch.rotate}°`); }
    if (patch.flipH === true) { this.flipH = true; done.push('flipped H'); }
    if (patch.flipV === true) { this.flipV = true; done.push('flipped V'); }
    const br = num(patch.brightness); if (br != null) { this.brightness = clamp(br / 100, -1, 1); done.push('brightness'); }
    const ct = num(patch.contrast); if (ct != null) { this.contrast = clamp(1 + ct / 100, 0, 2); done.push('contrast'); }
    const sa = num(patch.saturation); if (sa != null) { this.saturation = clamp(1 + sa / 100, 0, 3); done.push('saturation'); }
    if (patch.outFmt === 'mp4' || patch.outFmt === 'webm') { this.outFmt = patch.outFmt; done.push(`format ${patch.outFmt}`); }
    if (typeof patch.text === 'string' && patch.text) {
      const x = this.addText(patch.text, true);
      this.undoStack.pop(); // addText pushed a second snapshot; keep one undo step for the whole patch
      x.y = 0.88;
      done.push('text overlay');
    }
    this.syncControls();
    this.applyPreviewCss();
    this.structureChanged();
    return done.join(', ') || 'no changes';
  }

  // ---- Export ---------------------------------------------------------------

  private currentFmt(): Fmt {
    return (this.blob.type || this.name).includes('webm') ? 'webm' : 'mp4';
  }

  private hasEdits(): boolean {
    const c = this.main[0];
    const untouched = this.main.length === 1 && !!c && c.kind === 'video' && c.blob === this.blob &&
      c.in < 0.01 && c.out > c.srcDur - 0.01 && !c.crop && c.speed === 1 && c.volume === 1 &&
      this.overlays.length === 0 && this.audios.length === 0 && this.texts.length === 0 && !this.muteOriginal &&
      isFull(this.mainBox) && this.mainFit === 'contain';
    return !untouched || this.rotate !== 0 || this.flipH || this.flipV || this.speed !== 1 ||
      this.brightness !== 0 || this.contrast !== 1 || this.saturation !== 1 || this.look !== 'none' ||
      this.mute || this.volume !== 1 ||
      this.resPreset !== 'original' || this.outFmt !== this.currentFmt();
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    if (!this.main.length || !this.hasEdits()) {
      return { blob: this.blob, contentType: this.blob.type || 'video/mp4' };
    }
    this.setPlaying(false);
    this.setStatus('Processing… (first run downloads the video engine)');
    this.showProgress(true);
    let ff: FFmpeg;
    try {
      ff = await getFfmpeg((r) => this.setProgress(r));
    } catch (err) {
      return this.fail('Could not load the video engine', err);
    }
    const written: string[] = [];
    const outName = 'out.' + this.outFmt;
    try {
      const { fetchFile } = await import('@ffmpeg/util');
      const fileOf = new Map<Blob, string>();
      const sources: Clip[] = [...this.main, ...this.overlays];
      for (const c of [...sources, ...(this.mute ? [] : this.audios)]) {
        if (fileOf.has(c.blob)) continue;
        const f = `src${fileOf.size}${'kind' in c ? extFor(c) : extOf(c.blob instanceof File ? c.blob.name : '', '.m4a')}`;
        await ff.writeFile(f, await fetchFile(c.blob));
        fileOf.set(c.blob, f);
        written.push(f);
      }

      const hasAudio = new Map<string, boolean>();
      if (!this.mute) {
        for (const c of sources) {
          const f = fileOf.get(c.blob)!;
          if (c.kind === 'video' && !hasAudio.has(f)) hasAudio.set(f, await probeAudio(ff, f));
        }
      }

      const fonts = { regular: false, bold: false };
      const loadFont = async (url: string, file: string): Promise<boolean> => {
        try {
          await ff.writeFile(file, await fetchFile(url));
          written.push(file);
          return true;
        } catch {
          return false;
        }
      };
      if (this.texts.some((x) => !x.bold)) fonts.regular = await loadFont(FONT_URL, FONT_FILE);
      if (this.texts.some((x) => x.bold)) fonts.bold = await loadFont(FONT_BOLD_URL, FONT_BOLD_FILE);
      if (this.texts.length && !fonts.regular && !fonts.bold) this.setStatus('Text skipped: font could not be loaded.');

      this.setStatus('Rendering…');
      const code = await ff.exec(this.buildArgs(fileOf, hasAudio, fonts, outName));
      written.push(outName);
      const data = await ff.readFile(outName).catch(() => null);
      if (!(data instanceof Uint8Array) || data.length === 0) {
        throw new Error(`ffmpeg produced no output (exit ${code})`);
      }
      const part = new Uint8Array(data.length);
      part.set(data); // detach from any SharedArrayBuffer backing
      await cleanupFs(ff, written);
      const contentType = this.outFmt === 'webm' ? 'video/webm' : 'video/mp4';
      this.setStatus('Done.');
      this.showProgress(false);
      return { blob: new Blob([part], { type: contentType }), contentType };
    } catch (err) {
      await cleanupFs(ff, written);
      return this.fail('Processing failed', err);
    }
  }

  private fail(msg: string, err: unknown): { blob: Blob; contentType: string } {
    this.showProgress(false);
    this.setStatus(`${msg}: ${err instanceof Error ? err.message : String(err)}`);
    return { blob: this.blob, contentType: this.blob.type || 'video/mp4' };
  }

  // One filter graph: every clip is its own input (-ss/-t seek, so nothing is
  // decoded twice), main clips are fitted into the main box and concatenated,
  // overlays are cropped/fitted into their boxes and laid on top at their start
  // times, text clips are drawn, then global effects (rotate, speed, colour) apply.
  private buildArgs(fileOf: Map<Blob, string>, hasAudio: Map<string, boolean>, fonts: { regular: boolean; bold: boolean }, outName: string): string[] {
    const { W, H } = this.frameSize();
    const T = this.total();
    const wantAudio = !this.mute;
    const inputs: string[] = [];
    const parts: string[] = [];
    let idx = 0;
    const addInput = (c: Clip): number => {
      const f = fileOf.get(c.blob)!;
      if (c.kind === 'image') inputs.push('-loop', '1', '-framerate', String(FPS), '-t', f3(len(c)), '-i', f);
      else inputs.push('-ss', f3(c.in), '-t', f3(c.out - c.in), '-i', f);
      return idx++;
    };
    const audioOf = (c: Clip): boolean => c.kind === 'video' && !!hasAudio.get(fileOf.get(c.blob)!);

    const mb = boxPx(this.mainBox, W, H);
    const segs: string[] = [];
    this.main.forEach((c, i) => {
      const k = addInput(c);
      const sp = c.kind === 'video' && c.speed !== 1 ? `,setpts=PTS/${f3(c.speed)}` : '';
      parts.push(`[${k}:v]setpts=PTS-STARTPTS${sp},${cropFilter(c)}${fitFilter(this.mainFit, mb.w, mb.h)},setsar=1,fps=${FPS},format=yuv420p[v${i}]`);
      segs.push(`[v${i}]`);
      if (wantAudio) {
        if (audioOf(c) && !this.muteOriginal) {
          const tempo = c.speed !== 1 ? `,${atempoChain(c.speed).join(',')}` : '';
          const vol = c.volume !== 1 ? `,volume=${f3(c.volume)}` : '';
          parts.push(`[${k}:a]asetpts=PTS-STARTPTS,${AFMT}${tempo}${vol},apad,atrim=duration=${f3(len(c))}[a${i}]`);
        }
        else parts.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${f3(len(c))}[a${i}]`);
        segs.push(`[a${i}]`);
      }
    });
    parts.push(`${segs.join('')}concat=n=${this.main.length}:v=1:a=${wantAudio ? 1 : 0}[vm]${wantAudio ? '[am]' : ''}`);

    let base = '[vm]';
    if (!isFull(this.mainBox)) {
      parts.push(`[vm]pad=${W}:${H}:${mb.x}:${mb.y}:black[vp]`);
      base = '[vp]';
    }

    const ovAudio: string[] = [];
    this.overlays.forEach((o, j) => {
      const k = addInput(o);
      const ob = boxPx(o.box, W, H);
      const alpha = o.opacity < 1 ? `,colorchannelmixer=aa=${f3(o.opacity)}` : '';
      parts.push(`[${k}:v]setpts=PTS-STARTPTS,${cropFilter(o)}${fitFilter('cover', ob.w, ob.h)},setsar=1,fps=${FPS},format=rgba${alpha},setpts=PTS+${f3(o.start)}/TB[o${j}]`);
      parts.push(`${base}[o${j}]overlay=x=${ob.x}:y=${ob.y}:eof_action=pass:enable='between(t,${f3(o.start)},${f3(o.start + len(o))})'[b${j}]`);
      base = `[b${j}]`;
      if (wantAudio && o.audio && audioOf(o)) {
        const ms = Math.round(o.start * 1000);
        parts.push(`[${k}:a]asetpts=PTS-STARTPTS,${AFMT},volume=${f3(o.volume)},adelay=${ms}|${ms},apad[oa${j}]`);
        ovAudio.push(`[oa${j}]`);
      }
    });

    if (wantAudio) {
      this.audios.forEach((a, j) => {
        const k = idx++;
        inputs.push('-ss', f3(a.in), '-t', f3(a.out - a.in), '-i', fileOf.get(a.blob)!);
        const d = len(a);
        const ms = Math.round(a.start * 1000);
        const fx = [`asetpts=PTS-STARTPTS`, AFMT, `volume=${f3(a.volume)}`];
        if (a.fadeIn > 0) fx.push(`afade=t=in:st=0:d=${f3(a.fadeIn)}`);
        if (a.fadeOut > 0) fx.push(`afade=t=out:st=${f3(Math.max(0, d - a.fadeOut))}:d=${f3(a.fadeOut)}`);
        fx.push(`adelay=${ms}|${ms}`, 'apad');
        parts.push(`[${k}:a]${fx.join(',')}[ac${j}]`);
        ovAudio.push(`[ac${j}]`);
      });
    }

    const vf: string[] = [`trim=duration=${f3(T)}`, 'setpts=PTS-STARTPTS'];
    // Text clips are drawn in timeline time on the unrotated frame (like the preview).
    for (const x of this.texts) {
      const file = x.bold ? (fonts.bold ? FONT_BOLD_FILE : fonts.regular ? FONT_FILE : '') : (fonts.regular ? FONT_FILE : fonts.bold ? FONT_BOLD_FILE : '');
      if (file && x.text.trim()) vf.push(drawTextFilter(x, file, W, H));
    }
    if (this.rotate === 90) vf.push('transpose=1');
    else if (this.rotate === 180) vf.push('transpose=1,transpose=1');
    else if (this.rotate === 270) vf.push('transpose=2');
    if (this.flipH) vf.push('hflip');
    if (this.flipV) vf.push('vflip');
    if (this.speed !== 1) vf.push(`setpts=${f3(1 / this.speed)}*PTS`);
    if (this.brightness !== 0 || this.contrast !== 1 || this.saturation !== 1) {
      vf.push(`eq=brightness=${f3(this.brightness)}:contrast=${f3(this.contrast)}:saturation=${f3(this.saturation)}`);
    }
    if (this.look === 'grayscale') vf.push('hue=s=0');
    else if (this.look === 'sepia') vf.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
    vf.push('format=yuv420p');
    parts.push(`${base}${vf.join(',')}[vout]`);

    const maps = ['-map', '[vout]'];
    if (wantAudio) {
      let a = '[am]';
      if (ovAudio.length) {
        // amix scales each input by 1/n; volume=n restores the original levels.
        const n = ovAudio.length + 1;
        parts.push(`[am]${ovAudio.join('')}amix=inputs=${n}:duration=first:dropout_transition=0,volume=${n}[amx]`);
        a = '[amx]';
      }
      const af = [`atrim=duration=${f3(T)}`, 'asetpts=PTS-STARTPTS'];
      if (this.speed !== 1) af.push(...atempoChain(this.speed));
      if (this.volume !== 1) af.push(`volume=${f3(this.volume)}`);
      af.push('aresample=async=1');
      parts.push(`${a}${af.join(',')}[amain]`);
      maps.push('-map', '[amain]');
    }

    return [...inputs, '-filter_complex', parts.join(';'), ...maps, ...this.codecArgs(), outName];
  }

  private codecArgs(): string[] {
    if (this.outFmt === 'webm') {
      return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-deadline', 'realtime',
        '-cpu-used', '5', '-c:a', 'libopus'];
    }
    return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'];
  }

  private async extractAudio(): Promise<void> {
    this.setStatus('Extracting audio…');
    this.showProgress(true);
    const inName = 'in' + extOf(this.name, '.mp4');
    try {
      const ff = await getFfmpeg((r) => this.setProgress(r));
      const { fetchFile } = await import('@ffmpeg/util');
      await ff.writeFile(inName, await fetchFile(this.blob));
      await ff.exec(['-i', inName, '-vn', '-c:a', 'aac', '-b:a', '192k', 'audio.m4a']);
      const data = await ff.readFile('audio.m4a');
      const bytes = data instanceof Uint8Array ? data : new Uint8Array();
      const part = new Uint8Array(bytes.length); part.set(bytes);
      await cleanupFs(ff, [inName, 'audio.m4a']);
      const blob = new Blob([part], { type: 'audio/mp4' });
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u; a.download = this.name.replace(/\.[^.]+$/, '') + '.m4a';
      a.click();
      setTimeout(() => URL.revokeObjectURL(u), 1000);
      this.showProgress(false);
      this.setStatus('Audio extracted.');
    } catch (err) {
      this.fail('Audio extraction failed', err);
    }
  }

  // ---- UI -------------------------------------------------------------------

  private render(): void {
    this.host.innerHTML = `
      <div class="vid-editor">
        <div class="vid-stage">
          <canvas class="vid-canvas" data-role="canvas"></canvas>
          <div class="vid-pool" data-role="pool" aria-hidden="true"></div>
        </div>

        <div class="vid-transport">
          <button type="button" class="vid-btn" data-act="play" title="Play / pause (Space)">▶ Play</button>
          <span class="vid-time" data-role="time">0:00.0 / 0:00.0</span>
          <span class="vid-sep"></span>
          <button type="button" class="vid-btn" data-act="split" title="Split at playhead (S)">✂ Split</button>
          <button type="button" class="vid-btn" data-act="duplicate" title="Duplicate selected clip (D)">Duplicate</button>
          <button type="button" class="vid-btn" data-act="delete" title="Delete selected clip (Del)">Delete</button>
          <button type="button" class="vid-btn" data-act="left" title="Move selected clip earlier">◀ Move</button>
          <button type="button" class="vid-btn" data-act="right" title="Move selected clip later">Move ▶</button>
          <span class="vid-sep"></span>
          <button type="button" class="vid-btn" data-act="addClip" title="Append videos or images to the main track">+ Add video/image</button>
          <button type="button" class="vid-btn" data-act="addOverlay" title="Place another video or image on top">+ Add overlay</button>
          <button type="button" class="vid-btn" data-act="addAudio" title="Add music / voice-over clips (overlapping clips are mixed)">+ Add audio</button>
          <button type="button" class="vid-btn" data-act="addText" title="Add a timed text / title at the playhead">+ Add text</button>
          <span class="vid-sep"></span>
          <button type="button" class="vid-btn" data-act="undo" title="Undo (Ctrl/Cmd+Z)" disabled>↶</button>
          <button type="button" class="vid-btn" data-act="redo" title="Redo (Ctrl/Cmd+Shift+Z)" disabled>↷</button>
          <input type="file" accept="video/*,image/*" multiple data-role="clipFile" hidden>
          <input type="file" accept="video/*,image/*" data-role="ovFile" hidden>
          <input type="file" accept="audio/*" multiple data-role="auFile" hidden>
        </div>

        <div class="vt">
          <div class="vt-labels" data-role="tlLabels"></div>
          <div class="vt-scroll" data-role="tlScroll"><div class="vt-inner" data-role="tlInner"></div></div>
        </div>

        <div class="vid-tabs">
          <button class="vid-tab active" data-tab="clip">Clip</button>
          <button class="vid-tab" data-tab="layout">Layout</button>
          <button class="vid-tab" data-tab="transform">Transform</button>
          <button class="vid-tab" data-tab="resize">Resize</button>
          <button class="vid-tab" data-tab="adjust">Adjust</button>
          <button class="vid-tab" data-tab="audio">Audio</button>
          <button class="vid-tab" data-tab="thumbnail">Thumbnail</button>
          <button class="vid-tab" data-tab="export">Export</button>
        </div>

        <div class="vid-panel active" data-panel="clip"><div class="vid-props" data-role="props"></div></div>

        <div class="vid-panel" data-panel="layout">
          <button type="button" class="vid-btn" data-layout="full">Full frame</button>
          <button type="button" class="vid-btn" data-layout="side">Side by side</button>
          <button type="button" class="vid-btn" data-layout="stack">Top / bottom</button>
          <button type="button" class="vid-btn" data-layout="pip">Picture-in-picture</button>
          <label class="vid-field">Main video
            <select data-role="mainFit">
              <option value="contain">Fit (show all, letterbox)</option>
              <option value="cover">Fill (crop to frame)</option>
            </select></label>
          <span class="vid-hint">Two videos on one screen: pick a layout, then fine-tune each clip's crop in the Clip tab. Tip: Resize → 9:16 works well with Top / bottom.</span>
        </div>

        <div class="vid-panel" data-panel="transform">
          <button type="button" class="vid-btn" data-role="rotL">Rotate ⟲</button>
          <button type="button" class="vid-btn" data-role="rotR">Rotate ⟳</button>
          <button type="button" class="vid-btn" data-role="flipH">Flip H</button>
          <button type="button" class="vid-btn" data-role="flipV">Flip V</button>
          <label class="vid-field">Speed <span data-role="speedVal">1.0x</span>
            <input type="range" data-role="speed" min="0.5" max="2" step="0.1" value="1"></label>
          <span class="vid-hint">Crop is per clip — select a clip and use the Clip tab.</span>
        </div>

        <div class="vid-panel" data-panel="resize">
          <label class="vid-field">Output frame
            <select data-role="res">
              <option value="original">Original (first clip)</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
              <option value="square">Square 1:1</option>
              <option value="vertical">Vertical 9:16</option>
            </select></label>
        </div>

        <div class="vid-panel" data-panel="adjust">
          <label class="vid-field">Brightness <span data-role="brVal">0</span>
            <input type="range" data-role="brightness" min="-1" max="1" step="0.05" value="0"></label>
          <label class="vid-field">Contrast <span data-role="ctVal">1.00</span>
            <input type="range" data-role="contrast" min="0" max="2" step="0.05" value="1"></label>
          <label class="vid-field">Saturation <span data-role="saVal">1.00</span>
            <input type="range" data-role="saturation" min="0" max="3" step="0.05" value="1"></label>
          <button type="button" class="vid-btn" data-role="lookNone">Normal</button>
          <button type="button" class="vid-btn" data-role="lookGray">Grayscale</button>
          <button type="button" class="vid-btn" data-role="lookSepia">Sepia</button>
        </div>

        <div class="vid-panel" data-panel="audio">
          <button type="button" class="vid-btn" data-role="mute">Mute all audio</button>
          <button type="button" class="vid-btn" data-role="muteOriginal">Mute original video sound</button>
          <label class="vid-field">Master volume <span data-role="volVal">100%</span>
            <input type="range" data-role="volume" min="0" max="2" step="0.05" value="1"></label>
          <button type="button" class="vid-btn" data-role="pickAudio">+ Add audio clip…</button>
          <button type="button" class="vid-btn" data-role="extractAudio">Extract audio (.m4a)</button>
          <span class="vid-hint">Audio clips live on their own rows; overlapping clips are mixed. Select one for volume and fades.</span>
        </div>

        <div class="vid-panel" data-panel="thumbnail">
          <button type="button" class="vid-btn" data-role="makeThumb">🖼 Make thumbnail from this frame</button>
          <button type="button" class="vid-btn" data-role="snapFrame">Save frame as image</button>
          <span class="vid-hint">Move the playhead to the best moment, then design a YouTube / Shorts thumbnail with bold text, emoji and your face cut-out.</span>
        </div>

        <div class="vid-panel" data-panel="export">
          <label class="vid-field">Format
            <select data-role="fmt">
              <option value="mp4">MP4 (H.264)</option>
              <option value="webm">WebM (VP9)</option>
            </select></label>
          <span class="vid-hint">Export runs on Download / Share / Save.</span>
        </div>

        <div class="vid-statusbar">
          <span class="vid-status" data-role="status"></span>
          <div class="vid-progress" data-role="progress"><span data-role="progressFill"></span></div>
        </div>

        <div class="vid-zoom" data-role="zoom">
          <span>Timeline</span>
          <button type="button" data-zoom="out" title="Zoom out timeline">−</button>
          <input type="range" data-role="zoom-slider" min="100" max="1000" value="100" step="25">
          <span data-role="zoom-value">100%</span>
          <button type="button" data-zoom="in" title="Zoom in timeline">+</button>
          <button type="button" data-zoom="reset" title="Fit timeline">Fit</button>
        </div>
      </div>`;

    this.bind();
    this.setCanvasSize();
    this.syncControls();
    this.syncLayoutControls();
    this.applyPreviewCss();
    this.structureChanged();
    this.setStatus(`${this.name} · ${fmtT(this.total())}`);
    this.raf = requestAnimationFrame(this.tick);
  }

  private q<T extends HTMLElement>(role: string): T { return this.host.querySelector(`[data-role="${role}"]`) as T; }

  private bind(): void {
    this.canvas = this.q('canvas');
    this.ctx = this.canvas.getContext('2d')!;
    this.pool = this.q('pool');
    this.statusEl = this.q('status');
    this.barEl = this.q('progress');
    this.barFill = this.q('progressFill');
    this.timeEl = this.q('time');
    this.tlLabels = this.q('tlLabels');
    this.tlScroll = this.q('tlScroll');
    this.tlInner = this.q('tlInner');
    this.propsEl = this.q('props');
    this.clipFile = this.q('clipFile');
    this.ovFile = this.q('ovFile');
    this.auFile = this.q('auFile');
    this.auFile.addEventListener('change', () => {
      const files = Array.from(this.auFile.files ?? []);
      this.auFile.value = '';
      if (files.length) void this.addAudioClips(files);
    });

    // Toolbar actions.
    this.host.querySelector('.vid-transport')!.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (act === 'play') this.setPlaying(!this.playing);
      else if (act === 'split') this.split();
      else if (act === 'delete') this.deleteSelected();
      else if (act === 'duplicate') this.duplicateSelected();
      else if (act === 'addAudio') this.auFile.click();
      else if (act === 'addText') this.addText();
      else if (act === 'left') this.moveMain(-1);
      else if (act === 'right') this.moveMain(1);
      else if (act === 'addClip') this.clipFile.click();
      else if (act === 'addOverlay') { this.pendingLayout = null; this.ovFile.click(); }
      else if (act === 'undo') this.undo();
      else if (act === 'redo') this.redo();
    });
    this.clipFile.addEventListener('change', () => {
      const files = Array.from(this.clipFile.files ?? []);
      this.clipFile.value = '';
      if (files.length) void this.addMainClips(files);
    });
    this.ovFile.addEventListener('change', () => {
      const f = this.ovFile.files?.[0];
      this.ovFile.value = '';
      if (f) void this.addOverlay(f);
      else this.pendingLayout = null;
    });

    // Timeline + canvas pointer interactions.
    const wake = (): void => { this.lastActivity = performance.now(); };
    for (const ev of ['pointerdown', 'pointermove', 'input', 'change', 'keydown', 'wheel']) {
      this.host.addEventListener(ev, wake, { passive: true });
    }
    this.tlInner.addEventListener('pointerdown', this.onTlDown);
    this.canvas.addEventListener('pointerdown', this.onCanvasDown);
    this.canvas.addEventListener('pointermove', this.onCanvasHover);
    document.addEventListener('pointermove', this.onDocMove);
    document.addEventListener('pointerup', this.onDocUp);
    document.addEventListener('keydown', this.onKey);
    this.resizeObs = new ResizeObserver(() => { this.tlDirty = true; });
    this.resizeObs.observe(this.tlScroll);

    // Tabs.
    this.host.querySelectorAll<HTMLElement>('.vid-tab').forEach((t) => {
      t.addEventListener('click', () => this.showTab(t.dataset.tab!));
    });

    // Layout.
    this.host.querySelectorAll<HTMLElement>('[data-layout]').forEach((b) => {
      b.addEventListener('click', () => this.applyLayout(b.dataset.layout as Layout));
    });
    const fitSel = this.q<HTMLSelectElement>('mainFit');
    fitSel.addEventListener('change', () => { this.pushHistory(); this.mainFit = fitSel.value as Fit; });

    // Transform.
    this.q('rotL').addEventListener('click', () => { this.rotate = (this.rotate + 270) % 360; this.applyPreviewCss(); });
    this.q('rotR').addEventListener('click', () => { this.rotate = (this.rotate + 90) % 360; this.applyPreviewCss(); });
    this.q('flipH').addEventListener('click', () => { this.flipH = !this.flipH; this.syncControls(); this.applyPreviewCss(); });
    this.q('flipV').addEventListener('click', () => { this.flipV = !this.flipV; this.syncControls(); this.applyPreviewCss(); });
    const spd = this.q<HTMLInputElement>('speed');
    spd.addEventListener('input', () => { this.speed = Number(spd.value); this.syncControls(); });

    // Resize.
    const res = this.q<HTMLSelectElement>('res');
    res.addEventListener('change', () => { this.resPreset = res.value as ResPreset; this.setCanvasSize(); });

    // Adjust.
    const br = this.q<HTMLInputElement>('brightness');
    const ct = this.q<HTMLInputElement>('contrast');
    const sa = this.q<HTMLInputElement>('saturation');
    br.addEventListener('input', () => { this.brightness = Number(br.value); this.syncControls(); this.applyPreviewCss(); });
    ct.addEventListener('input', () => { this.contrast = Number(ct.value); this.syncControls(); this.applyPreviewCss(); });
    sa.addEventListener('input', () => { this.saturation = Number(sa.value); this.syncControls(); this.applyPreviewCss(); });
    this.q('lookNone').addEventListener('click', () => { this.look = 'none'; this.syncControls(); this.applyPreviewCss(); });
    this.q('lookGray').addEventListener('click', () => { this.look = 'grayscale'; this.syncControls(); this.applyPreviewCss(); });
    this.q('lookSepia').addEventListener('click', () => { this.look = 'sepia'; this.syncControls(); this.applyPreviewCss(); });

    // Audio.
    this.q('mute').addEventListener('click', () => { this.mute = !this.mute; this.syncControls(); });
    const vol = this.q<HTMLInputElement>('volume');
    vol.addEventListener('input', () => { this.volume = Number(vol.value); this.syncControls(); });
    this.q('extractAudio').addEventListener('click', () => void this.extractAudio());
    this.q('pickAudio').addEventListener('click', () => this.auFile.click());
    this.q('muteOriginal').addEventListener('click', () => { this.muteOriginal = !this.muteOriginal; this.syncControls(); });

    // Thumbnail.
    this.q('makeThumb').addEventListener('click', () => void this.openThumbnail());
    this.q('snapFrame').addEventListener('click', () => void this.saveFrame());

    // Export format.
    const fs = this.q<HTMLSelectElement>('fmt');
    fs.addEventListener('change', () => { this.outFmt = fs.value as Fmt; });

    // Timeline zoom.
    const zs = this.q<HTMLInputElement>('zoom-slider');
    const setZoom = (v: number): void => {
      this.zoom = clamp(v, 100, 1000);
      zs.value = String(this.zoom);
      this.q('zoom-value').textContent = `${this.zoom}%`;
      this.tlDirty = true;
    };
    this.q('zoom').addEventListener('click', (e) => {
      const z = (e.target as HTMLElement).closest('button')?.dataset.zoom;
      if (z === 'in') setZoom(this.zoom + 50);
      else if (z === 'out') setZoom(this.zoom - 50);
      else if (z === 'reset') setZoom(100);
    });
    zs.addEventListener('input', () => setZoom(Number(zs.value)));
  }

  // Seek to t and wait until the preview canvas shows that frame, then copy it.
  private async grabFrame(t: number): Promise<HTMLCanvasElement> {
    if (this.playing) this.setPlaying(false);
    this.seek(t);
    const cur = this.mainAt(this.t);
    const m = cur ? this.mediaFor(cur.clip) : null;
    const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()));
    for (let i = 0; i < 90; i++) {
      await frame();
      if (!(m instanceof HTMLVideoElement) || (!m.seeking && m.readyState >= 2)) break;
    }
    await frame(); await frame();
    const out = document.createElement('canvas');
    out.width = this.canvas.width; out.height = this.canvas.height;
    out.getContext('2d')!.drawImage(this.canvas, 0, 0);
    return out;
  }

  private async openThumbnail(): Promise<void> {
    const { openThumbnailMaker } = await import('./ThumbnailMaker');
    const frame = await this.grabFrame(this.t);
    openThumbnailMaker({
      root: document.body,
      frame,
      duration: this.total(),
      time: this.t,
      grabFrame: (t) => this.grabFrame(t),
      baseName: this.name,
      onSave: this.opts.saveImage,
      toast: this.opts.toast,
    });
  }

  private async saveFrame(): Promise<void> {
    const frame = await this.grabFrame(this.t);
    const blob = await new Promise<Blob | null>((r) => frame.toBlob(r, 'image/png'));
    if (!blob) return;
    const name = `${this.name.replace(/\.[^.]+$/, '')} frame ${fmtT(this.t).replace(/[:.]/g, '-')}.png`;
    if (this.opts.saveImage) {
      await this.opts.saveImage(blob, name);
      this.opts.toast?.('Frame saved to your files', 'success');
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  }

  private showTab(tab: string): void {
    this.host.querySelectorAll<HTMLElement>('.vid-tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
    this.host.querySelectorAll<HTMLElement>('.vid-panel').forEach((x) => x.classList.toggle('active', x.dataset.panel === tab));
  }

  // Reflect global state into the panel controls.
  private syncControls(): void {
    const set = (role: string, v: string): void => { const el = this.q<HTMLInputElement>(role); if (el) el.value = v; };
    const txt = (role: string, v: string): void => { const el = this.q(role); if (el) el.textContent = v; };
    const on = (role: string, v: boolean): void => { this.q(role)?.classList.toggle('active', v); };
    set('speed', String(this.speed)); txt('speedVal', `${this.speed.toFixed(1)}x`);
    on('flipH', this.flipH); on('flipV', this.flipV);
    set('res', this.resPreset);
    set('brightness', String(this.brightness)); txt('brVal', this.brightness.toFixed(2));
    set('contrast', String(this.contrast)); txt('ctVal', this.contrast.toFixed(2));
    set('saturation', String(this.saturation)); txt('saVal', this.saturation.toFixed(2));
    on('lookNone', this.look === 'none'); on('lookGray', this.look === 'grayscale'); on('lookSepia', this.look === 'sepia');
    on('mute', this.mute); txt('mute', this.mute ? 'All audio muted ✓' : 'Mute all audio');
    on('muteOriginal', this.muteOriginal);
    txt('muteOriginal', this.muteOriginal ? 'Original sound muted ✓' : 'Mute original video sound');
    set('volume', String(this.volume)); txt('volVal', `${Math.round(this.volume * 100)}%`);
    set('fmt', this.outFmt);
  }

  private syncLayoutControls(): void {
    const fit = this.q<HTMLSelectElement>('mainFit');
    if (fit) fit.value = this.mainFit;
  }

  private applyPreviewCss(): void {
    const t: string[] = [];
    if (this.rotate) t.push(`rotate(${this.rotate}deg)`);
    if (this.flipH) t.push('scaleX(-1)');
    if (this.flipV) t.push('scaleY(-1)');
    this.canvas.style.transform = t.join(' ');
    const f: string[] = [];
    if (this.brightness !== 0) f.push(`brightness(${1 + this.brightness})`);
    if (this.contrast !== 1) f.push(`contrast(${this.contrast})`);
    if (this.saturation !== 1) f.push(`saturate(${this.saturation})`);
    if (this.look === 'grayscale') f.push('grayscale(1)');
    if (this.look === 'sepia') f.push('sepia(0.85)');
    this.canvas.style.filter = f.join(' ');
  }

  private setCanvasSize(): void {
    const { W, H } = this.frameSize();
    const s = Math.min(1, 960 / W, 640 / H);
    this.canvas.width = Math.round(W * s);
    this.canvas.height = Math.round(H * s);
  }

  private select(s: Sel, switchTab = true): void {
    const changed = s?.id !== this.sel?.id;
    this.sel = s;
    this.tlInner.querySelectorAll<HTMLElement>('.vt-clip').forEach((n) => n.classList.toggle('sel', n.dataset.id === s?.id));
    if (changed) this.renderProps();
    if (switchTab && s) this.showTab('clip');
  }

  // ---- Clip properties panel --------------------------------------------------

  private renderProps(): void {
    const host = this.propsEl;
    if (!host) return;
    host.innerHTML = '';
    const f = this.sel ? this.find(this.sel.id) : null;
    if (!f) {
      host.appendChild(hint('Click a clip on the timeline (or on the preview) to edit it. Space = play, S = split, D = duplicate, Del = delete.'));
      return;
    }
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const secs = (v: number): string => `${v.toFixed(1)}s`;
    const actions = el('div', 'vid-props-actions');
    actions.append(
      button('✂ Split at playhead', () => this.split()),
      button('Duplicate', () => this.duplicateSelected()),
      button('Delete clip', () => this.deleteSelected()),
    );
    if (f.track === 'tx') {
      this.renderTextProps(f.item, host, actions);
      return;
    }
    if (f.track === 'au') {
      const a = f.item;
      const head = el('div', 'vid-props-head');
      const title = el('strong');
      title.textContent = `♪ ${a.name}`;
      const meta = el('span', 'vid-hint');
      meta.textContent = `Audio · ${fmtT(a.start)} – ${fmtT(a.start + len(a))} · source ${fmtT(a.in)} – ${fmtT(a.out)}`;
      head.append(title, meta);
      const g = el('div', 'vid-props-group');
      const half = Math.max(0, len(a) / 2);
      g.append(
        this.slider('Volume', 0, 2, 0.05, a.volume, pct, (v) => { a.volume = v; }),
        this.slider('Fade in', 0, Math.min(10, half), 0.1, Math.min(a.fadeIn, half), secs, (v) => { a.fadeIn = v; }),
        this.slider('Fade out', 0, Math.min(10, half), 0.1, Math.min(a.fadeOut, half), secs, (v) => { a.fadeOut = v; }),
      );
      host.append(head, g, actions);
      return;
    }
    const c = f.item;
    const head = el('div', 'vid-props-head');
    const title = el('strong');
    title.textContent = c.name;
    const meta = el('span', 'vid-hint');
    const where = f.track === 'main'
      ? `Main track · clip ${this.main.indexOf(c) + 1} of ${this.main.length}`
      : `Overlay · ${fmtT(f.item.start)} – ${fmtT(f.item.start + len(c))}`;
    meta.textContent = `${where} · ${c.kind === 'image' ? 'image' : `source ${fmtT(c.in)} – ${fmtT(c.out)}`} · ${fmtT(len(c))}`;
    head.append(title, meta);
    host.appendChild(head);

    const row = el('div', 'vid-props-row');
    host.appendChild(row);

    if (c.kind === 'image') {
      const lab = el('label', 'vid-field');
      lab.textContent = 'Duration (s)';
      const inp = document.createElement('input');
      inp.type = 'number'; inp.min = '0.5'; inp.max = String(IMAGE_MAX_DUR); inp.step = '0.5';
      inp.value = len(c).toFixed(1);
      inp.addEventListener('change', () => {
        const v = clamp(Number(inp.value) || IMAGE_DEFAULT_DUR, 0.5, IMAGE_MAX_DUR);
        this.pushHistory();
        c.out = c.in + v * c.speed;
        this.structureChanged();
      });
      lab.appendChild(inp);
      row.appendChild(lab);
    }

    if (f.track === 'main') {
      const g = el('div', 'vid-props-group');
      const gt = el('span', 'vid-group-title');
      gt.textContent = 'Clip speed & sound';
      g.appendChild(gt);
      if (c.kind === 'video') {
        g.appendChild(this.slider('Speed', 0.25, 4, 0.05, c.speed, (v) => `${v.toFixed(2)}x`, (v) => { c.speed = v; this.tlDirty = true; }));
        g.appendChild(this.slider('Volume', 0, 2, 0.05, c.volume, pct, (v) => { c.volume = v; }));
      } else {
        g.appendChild(hint('Images are silent; set how long they show with Duration.'));
      }
      row.appendChild(g);
    }

    // Crop (per clip): edges in percent of the source frame.
    const cr = c.crop ?? FULL;
    const edges = { l: cr.x, r: 1 - cr.x - cr.w, t: cr.y, b: 1 - cr.y - cr.h };
    const setEdge = (k: keyof typeof edges, v: number): void => {
      const e = { ...edges, [k]: v };
      if (k === 'l') e.l = Math.min(e.l, 0.95 - e.r);
      if (k === 'r') e.r = Math.min(e.r, 0.95 - e.l);
      if (k === 't') e.t = Math.min(e.t, 0.95 - e.b);
      if (k === 'b') e.b = Math.min(e.b, 0.95 - e.t);
      Object.assign(edges, e);
      const next = { x: e.l, y: e.t, w: 1 - e.l - e.r, h: 1 - e.t - e.b };
      c.crop = isFull(next) ? null : next;
    };
    const cropBox = el('div', 'vid-props-group');
    const cropTitle = el('span', 'vid-group-title');
    cropTitle.textContent = 'Crop';
    cropBox.appendChild(cropTitle);
    cropBox.append(
      this.slider('Left', 0, 0.9, 0.01, edges.l, pct, (v) => setEdge('l', v)),
      this.slider('Right', 0, 0.9, 0.01, edges.r, pct, (v) => setEdge('r', v)),
      this.slider('Top', 0, 0.9, 0.01, edges.t, pct, (v) => setEdge('t', v)),
      this.slider('Bottom', 0, 0.9, 0.01, edges.b, pct, (v) => setEdge('b', v)),
    );
    const resetCrop = button('Reset crop', () => { this.pushHistory(); c.crop = null; this.renderProps(); });
    cropBox.appendChild(resetCrop);
    row.appendChild(cropBox);

    if (f.track === 'ov') {
      const o = f.item;
      const pos = el('div', 'vid-props-group');
      const posTitle = el('span', 'vid-group-title');
      posTitle.textContent = 'Position & size (or drag on preview)';
      pos.appendChild(posTitle);
      pos.append(
        this.slider('X', 0, 1, 0.01, o.box.x, pct, (v) => { o.box.x = Math.min(v, 1 - o.box.w); }),
        this.slider('Y', 0, 1, 0.01, o.box.y, pct, (v) => { o.box.y = Math.min(v, 1 - o.box.h); }),
        this.slider('Width', 0.05, 1, 0.01, o.box.w, pct, (v) => { o.box.w = Math.min(v, 1 - o.box.x); }),
        this.slider('Height', 0.05, 1, 0.01, o.box.h, pct, (v) => { o.box.h = Math.min(v, 1 - o.box.y); }),
        this.slider('Opacity', 0.05, 1, 0.05, o.opacity, pct, (v) => { o.opacity = v; }),
      );
      if (o.kind === 'video') {
        const lab = el('label', 'vid-check');
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.checked = o.audio;
        cb.addEventListener('change', () => { this.pushHistory(); o.audio = cb.checked; });
        lab.append(cb, document.createTextNode(' Include this overlay’s sound'));
        pos.appendChild(lab);
        pos.appendChild(this.slider('Sound volume', 0, 2, 0.05, o.volume, pct, (v) => { o.volume = v; }));
      }
      const idx = this.overlays.indexOf(o);
      pos.append(
        button('Bring forward', () => this.reorderOverlay(idx, 1)),
        button('Send backward', () => this.reorderOverlay(idx, -1)),
      );
      row.appendChild(pos);
      if (!this.ovActive(o)) host.appendChild(hint('Move the playhead inside this overlay’s time range to see it on the preview.'));
    }

    host.appendChild(actions);
  }

  private renderTextProps(x: TextClip, host: HTMLElement, actions: HTMLElement): void {
    const pct = (v: number): string => `${Math.round(v * 100)}%`;
    const head = el('div', 'vid-props-head');
    const title = el('strong');
    title.textContent = 'Text';
    const meta = el('span', 'vid-hint');
    meta.textContent = `${fmtT(x.start)} – ${fmtT(x.start + len(x))} · ${fmtT(len(x))}`;
    head.append(title, meta);

    const g = el('div', 'vid-props-group');
    const lab = el('label', 'vid-field vid-field-wide');
    lab.textContent = 'Text';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = x.text;
    let editing = false;
    inp.addEventListener('input', () => {
      if (!editing) { this.pushHistory(); editing = true; }
      x.text = inp.value.replace(/[\r\n]+/g, ' ');
      this.tlDirty = true;
    });
    inp.addEventListener('change', () => { editing = false; });
    lab.appendChild(inp);
    g.appendChild(lab);
    g.append(
      this.slider('Size', 12, 200, 1, x.size, (v) => `${Math.round(v)}px`, (v) => { x.size = v; }),
      this.slider('X', 0, 1, 0.01, x.x, pct, (v) => { x.x = v; }),
      this.slider('Y', 0, 1, 0.01, x.y, pct, (v) => { x.y = v; }),
    );
    const color = el('label', 'vid-field row');
    color.textContent = 'Color ';
    const ci = document.createElement('input');
    ci.type = 'color';
    ci.value = x.color;
    ci.addEventListener('focus', () => this.pushHistory(), { once: true });
    ci.addEventListener('input', () => { x.color = ci.value; });
    color.appendChild(ci);
    const check = (label: string, val: boolean, set: (v: boolean) => void): HTMLElement => {
      const l = el('label', 'vid-check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = val;
      cb.addEventListener('change', () => { this.pushHistory(); set(cb.checked); });
      l.append(cb, document.createTextNode(` ${label}`));
      return l;
    };
    g.append(
      color,
      check('Bold', x.bold, (v) => { x.bold = v; }),
      check('Background box', x.bg, (v) => { x.bg = v; }),
      this.slider('Box opacity', 0, 1, 0.05, x.bgOpacity, pct, (v) => { x.bgOpacity = v; }),
    );
    host.append(head, g);
    if (!this.ovActive(x)) host.appendChild(hint('Move the playhead inside this text’s time range to see it on the preview.'));
    host.appendChild(actions);
  }

  private reorderOverlay(i: number, dir: number): void {
    const j = i + dir;
    if (i < 0 || j < 0 || j >= this.overlays.length) return;
    this.pushHistory();
    const [o] = this.overlays.splice(i, 1);
    this.overlays.splice(j, 0, o!);
    this.structureChanged();
  }

  private slider(label: string, min: number, max: number, step: number, value: number,
    show: (v: number) => string, onInput: (v: number) => void): HTMLElement {
    const wrap = el('label', 'vid-field');
    const head = el('span');
    const val = el('b');
    val.textContent = show(value);
    head.append(document.createTextNode(`${label} `), val);
    const inp = document.createElement('input');
    inp.type = 'range';
    inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(value);
    inp.addEventListener('input', () => {
      if (!this.sliderSession) { this.pushHistory(); this.sliderSession = true; }
      const v = Number(inp.value);
      onInput(v);
      val.textContent = show(v);
    });
    inp.addEventListener('change', () => { this.sliderSession = false; });
    wrap.append(head, inp);
    return wrap;
  }

  // ---- Timeline -------------------------------------------------------------

  private renderTimeline(): void {
    this.tlDirty = false;
    const T = this.total();
    const span = Math.max(T, 1);
    // Keep the scale fixed mid-drag so trimming doesn't rescale under the cursor.
    if (!this.drag) {
      const viewW = Math.max(200, this.tlScroll.clientWidth - 16);
      this.pps = (viewW / span) * (this.zoom / 100);
    }
    const pps = this.pps;
    const inner = this.tlInner;
    inner.innerHTML = '';
    inner.style.width = `${Math.ceil(Math.max(span, T) * pps) + 16}px`;

    const labels: { cls: string; text: string }[] = [{ cls: 'ruler', text: '' }];
    const ruler = el('div', 'vt-ruler');
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * pps >= 64) ?? 600;
    for (let s = 0; s <= span + 1e-6; s += step) {
      const tk = el('div', 'vt-tick');
      tk.style.left = `${s * pps}px`;
      tk.textContent = fmt(s);
      ruler.appendChild(tk);
    }
    inner.appendChild(ruler);

    const mainRow = el('div', 'vt-row main');
    let s = 0;
    for (const c of this.main) { mainRow.appendChild(this.clipEl(c, s, 'main')); s += len(c); }
    inner.appendChild(mainRow);
    labels.push({ cls: 'main', text: 'Video' });

    this.overlays.forEach((o, i) => {
      const row = el('div', 'vt-row ov');
      row.appendChild(this.clipEl(o, o.start, 'ov'));
      inner.appendChild(row);
      labels.push({ cls: 'ov', text: `Overlay ${i + 1}` });
    });

    this.audios.forEach((a, i) => {
      const row = el('div', 'vt-row audio');
      row.appendChild(this.clipEl(a, a.start, 'au'));
      inner.appendChild(row);
      labels.push({ cls: 'audio', text: `Audio ${i + 1}` });
    });

    this.texts.forEach((x, i) => {
      const row = el('div', 'vt-row text');
      row.appendChild(this.clipEl(x, x.start, 'tx'));
      inner.appendChild(row);
      labels.push({ cls: 'text', text: `Text ${i + 1}` });
    });

    this.playheadEl = el('div', 'vt-playhead');
    inner.appendChild(this.playheadEl);

    this.tlLabels.innerHTML = '';
    for (const l of labels) {
      const d = el('div', `vt-label ${l.cls}`);
      d.textContent = l.text;
      this.tlLabels.appendChild(d);
    }
    this.updatePlayhead();
  }

  private clipEl(c: Clip | AudioClip | TextClip, start: number, track: Track): HTMLElement {
    const isImg = 'kind' in c && c.kind === 'image';
    const node = el('div', `vt-clip ${track}${isImg ? ' img' : ''}${this.sel?.id === c.id ? ' sel' : ''}`);
    node.dataset.id = c.id;
    node.style.left = `${start * this.pps}px`;
    node.style.width = `${Math.max(6, len(c) * this.pps)}px`;
    const th = 'kind' in c ? this.thumbFor(c) : null;
    if (th) node.style.backgroundImage = `url("${th}")`;
    const name = el('span', 'vt-clip-name');
    const sp = 'speed' in c && c.speed !== 1 ? ` · ${c.speed.toFixed(2)}x` : '';
    const label = 'text' in c ? `T ${c.text || '(empty)'}` : `${track === 'au' ? '♪ ' : ''}${c.name}`;
    name.textContent = `${label} · ${fmtT(len(c))}${sp}`;
    const l = el('div', 'vt-handle l'); l.dataset.side = 'l'; l.title = 'Drag to trim start';
    const r = el('div', 'vt-handle r'); r.dataset.side = 'r'; r.title = 'Drag to trim end';
    node.append(name, l, r);
    return node;
  }

  private updatePlayhead(): void {
    if (!this.playheadEl) return;
    const x = this.t * this.pps;
    this.playheadEl.style.left = `${x}px`;
    if (this.playing) {
      const sc = this.tlScroll;
      if (x < sc.scrollLeft || x > sc.scrollLeft + sc.clientWidth - 24) sc.scrollLeft = Math.max(0, x - 40);
    }
  }

  private tlX(e: PointerEvent): number {
    return e.clientX - this.tlInner.getBoundingClientRect().left;
  }

  private seek(t: number): void {
    this.t = clamp(t, 0, this.total());
  }

  private onTlDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    const x = this.tlX(e);
    const node = target.closest<HTMLElement>('.vt-clip');
    e.preventDefault();
    if (!node) {
      this.drag = { kind: 'scrub' };
      this.seek(x / this.pps);
      return;
    }
    const f = this.find(node.dataset.id!);
    if (!f) return;
    this.select({ track: f.track, id: f.item.id });
    const side = target.dataset.side as 'l' | 'r' | undefined;
    if (side) {
      this.drag = {
        kind: 'trim', id: f.item.id, side, x0: x, in0: f.item.in, out0: f.item.out,
        start0: f.track === 'main' ? 0 : f.item.start, hist: false,
      };
    } else if (f.track !== 'main') {
      this.drag = { kind: 'moveOv', id: f.item.id, x0: x, start0: f.item.start, hist: false };
      this.seek(x / this.pps);
    } else {
      this.drag = { kind: 'reorder', id: f.item.id, x0: x, el: node, moved: false };
      this.seek(x / this.pps);
    }
  };

  private onDocMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'box') { this.onBoxDrag(e, d); return; }
    if (d.kind === 'text') {
      const x = this.texts.find((t) => t.id === d.id);
      if (!x) return;
      if (!d.hist) { this.pushHistory(); d.hist = true; }
      const p = this.canvasPt(e);
      x.x = clamp(d.x0 + p.x - d.px0, 0, 1);
      x.y = clamp(d.y0 + p.y - d.py0, 0, 1);
      return;
    }
    const x = this.tlX(e);
    if (d.kind === 'scrub') { this.seek(x / this.pps); return; }
    const dt = (x - d.x0) / this.pps;
    if (d.kind === 'reorder') {
      if (Math.abs(x - d.x0) > 5) d.moved = true;
      if (d.moved) { d.el.style.transform = `translateX(${x - d.x0}px)`; d.el.classList.add('dragging'); }
      return;
    }
    const f = this.find(d.id);
    if (!f) return;
    if (!d.hist) { this.pushHistory(); d.hist = true; }
    if (d.kind === 'moveOv' && f.track !== 'main') {
      const o = f.item;
      const L = len(o);
      const pts = this.snapTargets(o.id);
      let st = d.start0 + dt;
      const sStart = this.snapTo(st, pts);
      st = sStart !== st ? sStart : this.snapTo(st + L, pts) - L;
      o.start = clamp(st, 0, Math.max(0, this.total() - L));
      this.seek(o.start);
    } else if (d.kind === 'trim') {
      if (f.track === 'main') {
        const c = f.item;
        const ds = dt * c.speed;
        if (d.side === 'l') { c.in = clamp(d.in0 + ds, 0, d.out0 - MIN_LEN); this.seek(this.startOf(c)); }
        else { c.out = clamp(d.out0 + ds, d.in0 + MIN_LEN, c.srcDur); this.seek(this.startOf(c) + len(c) - 0.001); }
      } else {
        const o = f.item;
        const pts = this.snapTargets(o.id);
        if (d.side === 'l') {
          const want = this.snapTo(d.start0 + dt, pts) - d.start0;
          let k = Math.max(want, -d.in0, -d.start0);
          k = Math.min(k, d.out0 - d.in0 - MIN_LEN);
          o.in = d.in0 + k;
          o.start = d.start0 + k;
          this.seek(o.start);
        } else {
          const maxOut = Math.max(d.in0 + MIN_LEN, Math.min(o.srcDur, d.in0 + this.total() - d.start0));
          const endT = this.snapTo(d.start0 + (d.out0 - d.in0) + dt, pts);
          o.out = clamp(d.in0 + (endT - d.start0), d.in0 + MIN_LEN, maxOut);
          this.seek(o.start + len(o) - 0.001);
        }
      }
    }
    this.tlDirty = true;
  };

  private onDocUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.kind === 'reorder' && d.moved) {
      const idx = this.main.findIndex((c) => c.id === d.id);
      const others = this.main.filter((c) => c.id !== d.id);
      const dropT = this.tlX(e) / this.pps;
      let target = 0, s = 0;
      for (const o of others) { if (s + len(o) / 2 < dropT) target++; s += len(o); }
      if (target !== idx && idx >= 0) {
        this.pushHistory();
        others.splice(target, 0, this.main[idx]!);
        this.main = others;
        this.t = this.startOf(this.main[target]!);
      }
      this.structureChanged();
    } else if (d.kind === 'trim' || d.kind === 'moveOv' || d.kind === 'box' || d.kind === 'text') {
      if (d.hist) this.structureChanged();
    }
    this.tlDirty = true;
  };

  // ---- Preview canvas interaction ---------------------------------------------

  private canvasPt(e: PointerEvent): { x: number; y: number; rw: number; rh: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, rw: r.width, rh: r.height };
  }

  private hitOverlay(p: { x: number; y: number; rw: number; rh: number }): { o: Overlay; mode: 'move' | 'resize' } | null {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const o = this.overlays[i]!;
      if (!this.ovActive(o)) continue;
      const b = o.box;
      const nearHandle = Math.abs(p.x - (b.x + b.w)) * p.rw < 14 && Math.abs(p.y - (b.y + b.h)) * p.rh < 14;
      if (nearHandle) return { o, mode: 'resize' };
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return { o, mode: 'move' };
    }
    return null;
  }

  private hitText(p: { x: number; y: number }): TextClip | null {
    for (let i = this.texts.length - 1; i >= 0; i--) {
      const x = this.texts[i]!;
      const b = this.textBoxes.get(x.id);
      if (!b || !this.ovActive(x)) continue;
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return x;
    }
    return null;
  }

  private onCanvasDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const p = this.canvasPt(e);
    const tx = this.hitText(p);
    if (tx) {
      e.preventDefault();
      this.select({ track: 'tx', id: tx.id });
      this.drag = { kind: 'text', id: tx.id, px0: p.x, py0: p.y, x0: tx.x, y0: tx.y, hist: false };
      return;
    }
    const hit = this.hitOverlay(p);
    if (hit) {
      e.preventDefault();
      this.select({ track: 'ov', id: hit.o.id });
      this.drag = { kind: 'box', id: hit.o.id, mode: hit.mode, px0: p.x, py0: p.y, box0: { ...hit.o.box }, hist: false };
      return;
    }
    const cur = this.mainAt(this.t);
    if (cur) this.select({ track: 'main', id: cur.clip.id });
  };

  private onCanvasHover = (e: PointerEvent): void => {
    if (this.drag) return;
    const p = this.canvasPt(e);
    const hit = this.hitOverlay(p);
    this.canvas.style.cursor = this.hitText(p) ? 'move' : hit ? (hit.mode === 'resize' ? 'nwse-resize' : 'move') : 'default';
  };

  private onBoxDrag(e: PointerEvent, d: Extract<Drag, { kind: 'box' }>): void {
    const o = this.overlays.find((x) => x.id === d.id);
    if (!o) return;
    if (!d.hist) { this.pushHistory(); d.hist = true; }
    const p = this.canvasPt(e);
    const dx = p.x - d.px0, dy = p.y - d.py0, b0 = d.box0;
    if (d.mode === 'move') {
      o.box = { ...b0, x: clamp(b0.x + dx, 0, 1 - b0.w), y: clamp(b0.y + dy, 0, 1 - b0.h) };
    } else {
      let w = clamp(b0.w + dx, 0.05, 1 - b0.x);
      let h = (w * b0.h) / b0.w;
      if (b0.y + h > 1) { h = 1 - b0.y; w = (h * b0.w) / b0.h; }
      o.box = { x: b0.x, y: b0.y, w, h };
    }
  }

  private onKey = (e: KeyboardEvent): void => {
    if (!this.host.isConnected || e.metaKey || e.ctrlKey || e.altKey) return;
    const tgt = e.target as HTMLElement;
    if (tgt.closest('input, textarea, select, button, [contenteditable="true"]')) return;
    if (e.key === ' ') { e.preventDefault(); this.setPlaying(!this.playing); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); this.split(); }
    else if (e.key === 'd' || e.key === 'D') { e.preventDefault(); this.duplicateSelected(); }
  };

  // ---- Playback engine ----------------------------------------------------------

  private setPlaying(p: boolean): void {
    this.lastActivity = performance.now();
    if (p && this.t >= this.total() - 0.05) this.t = 0;
    this.playing = p;
    this.waitSince = 0;
    const b = this.host.querySelector('[data-act="play"]');
    if (b) b.textContent = p ? '❚❚ Pause' : '▶ Play';
  }

  private mediaFor(c: Clip): HTMLVideoElement | HTMLImageElement {
    let m = this.media.get(c.id);
    if (!m) {
      if (c.kind === 'image') {
        const img = new Image();
        img.src = this.urlFor(c.blob);
        m = img;
      } else {
        const v = document.createElement('video');
        v.preload = 'auto';
        v.playsInline = true;
        v.muted = true;
        v.src = this.urlFor(c.blob);
        m = v;
      }
      this.pool.appendChild(m);
      this.media.set(c.id, m);
    }
    return m;
  }

  private gcMedia(): void {
    const live = new Set([...this.main, ...this.overlays].map((c) => c.id));
    for (const [id, m] of this.media) {
      if (live.has(id)) continue;
      if (m instanceof HTMLVideoElement) { m.pause(); m.removeAttribute('src'); m.load(); }
      m.remove();
      this.media.delete(id);
    }
    const liveAu = new Set(this.audios.map((a) => a.id));
    for (const [id, a] of this.audioEls) {
      if (liveAu.has(id)) continue;
      a.pause();
      a.removeAttribute('src');
      this.audioEls.delete(id);
    }
  }

  private audioFor(a: AudioClip): HTMLAudioElement {
    let m = this.audioEls.get(a.id);
    if (!m) {
      m = new Audio(this.urlFor(a.blob));
      m.preload = 'auto';
      this.audioEls.set(a.id, m);
    }
    return m;
  }

  private tick = (ts: number): void => {
    if (!this.host.isConnected) { this.raf = 0; return; }
    const dt = this.lastTs ? Math.min(0.1, (ts - this.lastTs) / 1000) : 0;
    this.lastTs = ts;
    const T = this.total();

    if (this.playing) {
      const cur = this.mainAt(this.t, false);
      if (cur && cur.clip.kind === 'video') {
        const v = this.mediaFor(cur.clip) as HTMLVideoElement;
        if (!v.paused && !v.seeking && v.readyState >= 2) {
          this.waitSince = 0;
          if (v.currentTime >= cur.clip.out - 0.03 || v.ended) {
            this.t = cur.start + len(cur.clip) + 1e-4;
          } else {
            const derived = cur.start + (v.currentTime - cur.clip.in) / cur.clip.speed;
            if (derived >= this.t - 0.3) this.t = Math.max(this.t, derived);
          }
        } else {
          // Wait for the clip to buffer; fall back to the wall clock if it never starts.
          if (!this.waitSince) this.waitSince = ts;
          if (ts - this.waitSince > 1000) this.t += dt * this.speed;
        }
      } else {
        this.t += dt * this.speed;
      }
      if (this.t >= T) { this.t = T; this.setPlaying(false); }
    }

    this.syncMedia();
    this.draw();
    if (this.tlDirty) this.renderTimeline();
    else this.updatePlayhead();
    const label = `${fmtT(this.t)} / ${fmtT(T)}`;
    if (this.timeEl.textContent !== label) this.timeEl.textContent = label;
    // Paused and untouched: redraw a few times a second instead of every frame
    // (keeps late-decoded frames/thumbnails appearing without burning CPU).
    const idle = !this.playing && !this.drag && performance.now() - this.lastActivity > 1500;
    if (idle) this.idleTimer = window.setTimeout(() => { this.raf = requestAnimationFrame(this.tick); }, 400);
    else this.raf = requestAnimationFrame(this.tick);
  };

  // Keep every hidden media element at the right time / play state for this.t.
  private syncMedia(): void {
    const cur = this.mainAt(this.t);
    const next = cur ? this.main[cur.index + 1] : undefined;
    const rate = this.speed;
    const mainMuted = this.mute || this.muteOriginal;
    let s = 0;
    for (const c of this.main) {
      const m = this.mediaFor(c);
      const start = s;
      s += len(c);
      if (!(m instanceof HTMLVideoElement)) continue;
      const r = clamp(rate * c.speed, 0.0625, 16);
      if (m.playbackRate !== r) m.playbackRate = r;
      m.muted = mainMuted;
      m.volume = Math.min(1, this.volume * c.volume);
      if (cur && c === cur.clip) {
        const local = Math.min(c.in + (this.t - start) * c.speed, c.out - 0.04);
        this.syncVideo(m, local, this.playing, false);
      } else {
        if (!m.paused) m.pause();
        if (c === next && m.readyState >= 1 && !m.seeking && Math.abs(m.currentTime - c.in) > 0.05) m.currentTime = c.in;
      }
    }
    for (const o of this.overlays) {
      const m = this.mediaFor(o);
      if (!(m instanceof HTMLVideoElement)) continue;
      if (m.playbackRate !== rate) m.playbackRate = rate;
      m.muted = this.mute || !o.audio;
      m.volume = Math.min(1, this.volume * o.volume);
      if (this.ovActive(o)) this.syncVideo(m, o.in + (this.t - o.start), this.playing, true);
      else if (!m.paused) m.pause();
    }
    for (const a of this.audios) {
      const m = this.audioFor(a);
      if (m.playbackRate !== rate) m.playbackRate = rate;
      m.muted = this.mute;
      const into = this.t - a.start;
      const d = len(a);
      let g = a.volume;
      if (a.fadeIn > 0 && into < a.fadeIn) g *= Math.max(0, into / a.fadeIn);
      if (a.fadeOut > 0 && d - into < a.fadeOut) g *= Math.max(0, (d - into) / a.fadeOut);
      m.volume = clamp(g * this.volume, 0, 1);
      if (this.ovActive(a)) {
        const local = a.in + into;
        if (m.readyState < 1) continue;
        if (this.playing) {
          if (m.paused) { m.currentTime = local; void m.play().catch(() => {}); }
          else if (Math.abs(m.currentTime - local) > 0.3) m.currentTime = local;
        } else if (!m.paused) m.pause();
      } else if (!m.paused) m.pause();
    }
  }

  private syncVideo(v: HTMLVideoElement, local: number, playing: boolean, driftFix: boolean): void {
    if (v.readyState < 1) return;
    if (playing) {
      if (v.paused) {
        if (Math.abs(v.currentTime - local) > 0.05) v.currentTime = local;
        void v.play().catch(() => {});
      } else if (driftFix && !v.seeking && Math.abs(v.currentTime - local) > 0.3) {
        v.currentTime = local;
      }
    } else {
      if (!v.paused) v.pause();
      if (!v.seeking && Math.abs(v.currentTime - local) > 0.04) v.currentTime = local;
    }
  }

  private draw(): void {
    const ctx = this.ctx;
    const cw = this.canvas.width, ch = this.canvas.height;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);
    const px = (r: Rect): Rect => ({ x: r.x * cw, y: r.y * ch, w: r.w * cw, h: r.h * ch });

    const cur = this.mainAt(this.t);
    if (cur) this.drawSource(this.mediaFor(cur.clip), cur.clip, px(this.mainBox), this.mainFit);

    for (const o of this.overlays) {
      if (!this.ovActive(o)) continue;
      ctx.globalAlpha = o.opacity;
      this.drawSource(this.mediaFor(o), o, px(o.box), 'cover');
      ctx.globalAlpha = 1;
    }

    this.textBoxes.clear();
    for (const x of this.texts) if (this.ovActive(x) && x.text.trim()) this.drawText(x, cw, ch);

    if (this.sel?.track === 'tx') {
      const b = this.textBoxes.get(this.sel.id);
      if (b) {
        ctx.save();
        ctx.strokeStyle = '#ff4d8d';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x * cw, b.y * ch, b.w * cw, b.h * ch);
        ctx.restore();
      }
    }

    if (this.sel?.track === 'ov') {
      const o = this.overlays.find((x) => x.id === this.sel!.id);
      if (o && this.ovActive(o)) {
        const b = px(o.box);
        ctx.save();
        ctx.strokeStyle = '#ff4d8d';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(b.x + 1, b.y + 1, b.w - 2, b.h - 2);
        ctx.setLineDash([]);
        ctx.fillStyle = '#ff4d8d';
        ctx.fillRect(b.x + b.w - 10, b.y + b.h - 10, 10, 10);
        ctx.restore();
      }
    }
  }

  // Same math as the export: crop in source pixels, then contain (letterbox)
  // or cover (centre-crop) into the destination box.
  private drawSource(m: HTMLVideoElement | HTMLImageElement, c: Clip, box: Rect, fit: Fit): void {
    const ready = m instanceof HTMLVideoElement ? m.readyState >= 2 : m.complete && m.naturalWidth > 0;
    if (!ready || box.w <= 0 || box.h <= 0) return;
    const cr = c.crop ?? FULL;
    let sx = cr.x * c.natW, sy = cr.y * c.natH, sw = cr.w * c.natW, sh = cr.h * c.natH;
    let dx = box.x, dy = box.y, dw = box.w, dh = box.h;
    if (fit === 'cover') {
      const ba = box.w / box.h;
      if (sw / sh > ba) { const n = sh * ba; sx += (sw - n) / 2; sw = n; }
      else { const n = sw / ba; sy += (sh - n) / 2; sh = n; }
    } else {
      const sa = sw / sh;
      dw = box.w; dh = dw / sa;
      if (dh > box.h) { dh = box.h; dw = dh * sa; }
      dx = box.x + (box.w - dw) / 2;
      dy = box.y + (box.h - dh) / 2;
    }
    try { this.ctx.drawImage(m, sx, sy, sw, sh, dx, dy, dw, dh); } catch { /* frame not decodable yet */ }
  }

  // Mirrors drawTextFilter(): centred on (x, y), box padding = 25% of the font size.
  private drawText(x: TextClip, cw: number, ch: number): void {
    const { W } = this.frameSize();
    const s = cw / W;
    const size = x.size * s;
    const pad = Math.round(x.size * 0.25) * s;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${x.bold ? 'bold ' : ''}${size}px "DejaVu Sans", system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(x.text).width;
    const left = x.x * cw - tw / 2;
    const top = x.y * ch - size / 2;
    if (x.bg) {
      ctx.fillStyle = `rgba(0,0,0,${x.bgOpacity})`;
      ctx.fillRect(left - pad, top - pad, tw + pad * 2, size + pad * 2);
    }
    ctx.fillStyle = x.color;
    ctx.fillText(x.text, left, top);
    ctx.restore();
    this.textBoxes.set(x.id, { x: (left - pad) / cw, y: (top - pad) / ch, w: (tw + pad * 2) / cw, h: (size + pad * 2) / ch });
  }

  // ---- Thumbnails -------------------------------------------------------------

  private thumbFor(c: Clip): string | null {
    if (c.kind === 'image') return this.urlFor(c.blob);
    const k = `${this.urlFor(c.blob)}|${c.in.toFixed(1)}`;
    const hit = this.thumbs.get(k);
    if (hit !== undefined) return hit || null;
    if (!this.thumbQueue.some((q) => q.blob === c.blob && q.in.toFixed(1) === c.in.toFixed(1))) {
      this.thumbQueue.push({ ...c });
      void this.pumpThumbs();
    }
    return null;
  }

  private async pumpThumbs(): Promise<void> {
    if (this.thumbBusy) return;
    this.thumbBusy = true;
    const canvas = document.createElement('canvas');
    canvas.width = 120; canvas.height = 68;
    const cx = canvas.getContext('2d')!;
    while (this.thumbQueue.length && this.host.isConnected) {
      const c = this.thumbQueue.shift()!;
      const url = this.urlFor(c.blob);
      const k = `${url}|${c.in.toFixed(1)}`;
      if (this.thumbs.has(k)) continue;
      try {
        const v = this.thumbVid ?? (this.thumbVid = document.createElement('video'));
        v.muted = true; v.preload = 'auto';
        if (v.src !== url) { v.src = url; await withTimeout(once(v, 'loadeddata'), 8000); }
        v.currentTime = Math.min(c.in + 0.05, Math.max(0, c.srcDur - 0.05));
        await withTimeout(once(v, 'seeked'), 8000);
        const a = canvas.width / canvas.height, sa = v.videoWidth / v.videoHeight;
        let sx = 0, sy = 0, sw = v.videoWidth, sh = v.videoHeight;
        if (sa > a) { sw = sh * a; sx = (v.videoWidth - sw) / 2; } else { sh = sw / a; sy = (v.videoHeight - sh) / 2; }
        cx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        this.thumbs.set(k, canvas.toDataURL('image/jpeg', 0.6));
      } catch {
        this.thumbs.set(k, '');
      }
      this.tlDirty = true;
    }
    this.thumbBusy = false;
  }

  // ---- Misc UI ----------------------------------------------------------------

  private showUnplayableState(): void {
    const ext = this.name.split('.').pop()?.toLowerCase() || 'video';
    this.host.innerHTML = `
      <div class="vid-editor">
        <div class="vid-unplayable">
          <div class="vid-unplayable-icon">🎬</div>
          <h3 class="vid-unplayable-title">Video format not supported</h3>
          <p class="vid-unplayable-message">
            This video format (.${esc(ext)}) can't be played in the browser.
            Download the file to view it in another app.
          </p>
          <div class="vid-unplayable-info">
            <strong>Supported formats:</strong> MP4, WebM, MOV (H.264), OGV, M4V
          </div>
        </div>
      </div>`;
  }

  private setStatus(t: string): void { if (this.statusEl) this.statusEl.textContent = t; }
  private showProgress(on: boolean): void { this.barEl?.classList.toggle('active', on); if (!on) this.setProgress(0); }
  private setProgress(r: number): void {
    const pct = Math.round(clamp(r, 0, 1) * 100);
    if (this.barFill) this.barFill.style.width = `${pct}%`;
    if (pct > 0) this.setStatus(`Processing… ${pct}%`);
  }
}

// ---- helpers ------------------------------------------------------------------

function isImageFile(blob: Blob, name: string): boolean {
  return blob.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(name);
}

async function probeMedia(blob: Blob, name: string, url: string): Promise<{ kind: 'video' | 'image'; dur: number; w: number; h: number }> {
  if (isImageFile(blob, name)) {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth) throw new Error('bad image');
    return { kind: 'image', dur: IMAGE_MAX_DUR, w: img.naturalWidth, h: img.naturalHeight };
  }
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.muted = true;
  v.src = url;
  try {
    await withTimeout(once(v, 'loadedmetadata'), 10000);
    if (!isFinite(v.duration) || v.duration <= 0 || !v.videoWidth) throw new Error('unplayable');
    return { kind: 'video', dur: v.duration, w: v.videoWidth, h: v.videoHeight };
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

// Whether a file in the ffmpeg FS has an audio stream (parsed from `-i` log output).
async function probeAudio(ff: FFmpeg, file: string): Promise<boolean> {
  let log = '';
  const onLog = ({ message }: { message: string }): void => { log += message + '\n'; };
  ff.on('log', onLog);
  try { await ff.exec(['-hide_banner', '-i', file]); } catch { /* no output file → non-zero exit */ }
  finally { ff.off('log', onLog); }
  return /Stream #\d+:\d+.*Audio:/.test(log);
}

async function cleanupFs(ff: FFmpeg, files: string[]): Promise<void> {
  for (const f of files) if (f) await ff.deleteFile(f).catch(() => {});
}

function cropFilter(c: Clip): string {
  if (!c.crop) return '';
  const cw = Math.min(c.natW, even(c.crop.w * c.natW));
  const ch = Math.min(c.natH, even(c.crop.h * c.natH));
  const cx = clamp(Math.round(c.crop.x * c.natW), 0, c.natW - cw);
  const cy = clamp(Math.round(c.crop.y * c.natH), 0, c.natH - ch);
  return `crop=${cw}:${ch}:${cx}:${cy},`;
}

function fitFilter(fit: Fit, w: number, h: number): string {
  return fit === 'cover'
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
}

function boxPx(r: Rect, W: number, H: number): { x: number; y: number; w: number; h: number } {
  const x = clamp(2 * Math.round((r.x * W) / 2), 0, W - 2);
  const y = clamp(2 * Math.round((r.y * H) / 2), 0, H - 2);
  const w = Math.min(even(r.w * W), W - x);
  const h = Math.min(even(r.h * H), H - y);
  return { x, y, w, h };
}

function extOf(n: string, fallback: string): string {
  const e = (n.split('.').pop() || '').toLowerCase();
  return n.includes('.') && e && e.length <= 5 ? '.' + e : fallback;
}

function extFor(c: Clip): string {
  const byType: Record<string, string> = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp',
    'video/webm': '.webm', 'video/quicktime': '.mov', 'video/ogg': '.ogv', 'video/mp4': '.mp4',
  };
  const fromName = c.blob instanceof File ? extOf(c.blob.name, '') : '';
  return fromName || byType[c.blob.type] || (c.kind === 'image' ? '.png' : '.mp4');
}

const even = (n: number): number => Math.max(2, 2 * Math.round(n / 2));
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const isFull = (r: Rect): boolean => r.x < 0.001 && r.y < 0.001 && r.w > 0.999 && r.h > 0.999;

function fmt(sec: number): string {
  if (!isFinite(sec)) return '0:00';
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtT(sec: number): string {
  if (!isFinite(sec)) return '0:00.0';
  const tenths = Math.floor(sec * 10) % 10;
  return `${fmt(sec)}.${tenths}`;
}

function f3(n: number): string { return (Math.round(n * 1000) / 1000).toString(); }

function el(tag: string, cls = ''): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'vid-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function hint(text: string): HTMLElement {
  const n = el('p', 'vid-hint');
  n.textContent = text;
  return n;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
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

function once(m: HTMLMediaElement, ev: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = (): void => { cleanup(); resolve(); };
    const err = (): void => { cleanup(); reject(new Error('media error')); };
    const cleanup = (): void => { m.removeEventListener(ev, ok); m.removeEventListener('error', err); };
    m.addEventListener(ev, ok, { once: true });
    m.addEventListener('error', err, { once: true });
  });
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
  });
}

function drawTextFilter(x: TextClip, fontFile: string, W: number, H: number): string {
  const txt = x.text
    .replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, '\u2019').replace(/%/g, '\\%');
  const col = x.color.replace('#', '0x');
  const cx = Math.round(x.x * W), cy = Math.round(x.y * H);
  const box = x.bg ? `:box=1:boxcolor=black@${f3(x.bgOpacity)}:boxborderw=${Math.round(x.size * 0.25)}` : '';
  const end = x.start + len(x);
  return `drawtext=fontfile=${fontFile}:text='${txt}':fontsize=${Math.round(x.size)}:fontcolor=${col}` +
    `:x=${cx}-text_w/2:y=${cy}-text_h/2${box}:enable='between(t,${f3(x.start)},${f3(end)})'`;
}

function cloneTimed<X extends Timed>(o: X, id: string): X {
  return 'box' in o
    ? { ...o, id, box: { ...o.box }, crop: o.crop && { ...o.crop } }
    : { ...o, id };
}

function probeAudioDuration(url: string): Promise<number> {
  const a = new Audio();
  a.preload = 'metadata';
  a.src = url;
  return withTimeout(once(a, 'loadedmetadata'), 10000).then(() => {
    if (!isFinite(a.duration) || a.duration <= 0) throw new Error('bad audio');
    return a.duration;
  });
}
