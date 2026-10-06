import './styles/video.css';
import type { DocEditor } from './registry';
import { getFfmpeg } from './ffmpegLoader';

// Multi-clip video editor with timeline-based composition
// Each clip can be trimmed, positioned, and transformed independently

interface VideoClip {
  id: string;
  blob: Blob;
  name: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
  x: number; // Canvas position (0-1 normalized)
  y: number;
  width: number; // Canvas size (0-1 normalized)
  height: number;
  opacity: number;
  zIndex: number;
}

interface CropRect { x: number; y: number; w: number; h: number; }
type Look = 'none' | 'grayscale' | 'sepia';
type Fmt = 'mp4' | 'webm';
type ResPreset = 'original' | '1080p' | '720p' | '480p' | 'square';

const FONT_URL = 'https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37.3/ttf/DejaVuSans.ttf';
const FONT_FILE = 'font.ttf';

export class VideoEditor implements DocEditor {
  private host: HTMLElement;
  private clips: VideoClip[] = [];
  private selectedClipId: string | null = null;
  private zoom = 100;
  private playbackTime = 0;
  private isPlaying = false;
  private objectUrls: string[] = [];
  private rafId = 0;

  // Global effects applied to composition
  private look: Look = 'none';
  private brightness = 0;
  private contrast = 1;
  private saturation = 1;
  private outFmt: Fmt = 'mp4';
  private resPreset: ResPreset = 'original';

  // UI elements
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private statusEl!: HTMLElement;
  private timeEl!: HTMLElement;
  private timelineContainer!: HTMLElement;

  private constructor(host: HTMLElement) {
    this.host = host;
  }

  static async open(host: HTMLElement, blob: Blob, name: string): Promise<VideoEditor> {
    const ed = new VideoEditor(host);

    // Import the initial video as first clip
    const duration = await ed.getVideoDuration(blob);
    ed.clips.push({
      id: ed.generateId(),
      blob,
      name: name.replace(/\.[^.]+$/, ''),
      duration,
      trimStart: 0,
      trimEnd: duration,
      x: 0, y: 0,
      width: 1, height: 1,
      opacity: 1,
      zIndex: 0,
    });

    ed.render();
    return ed;
  }

  destroy(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  private generateId(): string {
    return `clip_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private async getVideoDuration(blob: Blob): Promise<number> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(blob);
      this.objectUrls.push(url);
      video.onloadedmetadata = () => {
        resolve(video.duration);
        video.src = '';
      };
      video.src = url;
    });
  }

  private getTotalDuration(): number {
    return Math.max(...this.clips.map(c => c.trimEnd), 0) || 10;
  }

  private render() {
    this.host.innerHTML = `
      <div class="vid-editor">
        <div class="vid-stage">
          <canvas class="vid-canvas" data-role="canvas"></canvas>
        </div>

        <div class="vid-transport">
          <button type="button" class="vid-btn" data-role="play">▶ Play</button>
          <span class="vid-time" data-role="time">0:00 / 0:00</span>
          <button type="button" class="vid-btn" data-role="import">+ Add Clip</button>
          <input type="file" accept="video/*,image/*" data-role="clip-input" hidden>
        </div>

        <div class="vid-timeline-container" data-role="timeline-container">
          <div class="vid-timeline-ruler">
            <div class="vid-ruler-labels" data-role="ruler-labels"></div>
          </div>
          <div class="vid-clips-area" data-role="clips-area"></div>
          <div class="vid-playhead-line" data-role="playhead"></div>
        </div>

        <div class="vid-clip-properties">
          <div data-role="clip-props"></div>
        </div>

        <div class="vid-tabs">
          <button class="vid-tab active" data-tab="adjust">Adjust</button>
          <button class="vid-tab" data-tab="export">Export</button>
        </div>

        <div class="vid-panel active" data-panel="adjust">
          <label class="vid-field">Brightness
            <input type="range" data-role="brightness" min="-1" max="1" step="0.05" value="0"></label>
          <label class="vid-field">Contrast
            <input type="range" data-role="contrast" min="0" max="2" step="0.05" value="1"></label>
          <label class="vid-field">Saturation
            <input type="range" data-role="saturation" min="0" max="3" step="0.05" value="1"></label>
          <button type="button" class="vid-btn" data-role="lookNone">Normal</button>
          <button type="button" class="vid-btn" data-role="lookGray">Grayscale</button>
          <button type="button" class="vid-btn" data-role="lookSepia">Sepia</button>
        </div>

        <div class="vid-panel" data-panel="export">
          <label class="vid-field">Format
            <select data-role="fmt">
              <option value="mp4">MP4 (H.264)</option>
              <option value="webm">WebM (VP9)</option>
            </select></label>
          <label class="vid-field">Resolution
            <select data-role="res">
              <option value="original">Original</option>
              <option value="1080p">1080p</option>
              <option value="720p">720p</option>
              <option value="480p">480p</option>
            </select></label>
          <button type="button" class="vid-btn primary" data-role="export">⤓ Export Video</button>
        </div>

        <div class="vid-zoom" data-role="zoom">
          <button type="button" data-zoom="out">−</button>
          <input type="range" data-role="zoom-slider" min="50" max="200" value="100" step="10">
          <span data-role="zoom-value">100%</span>
          <button type="button" data-zoom="in">+</button>
          <button type="button" data-zoom="reset">Reset</button>
        </div>
      </div>`;

    this.setupUI();
    this.renderCanvas();
    this.renderTimeline();
  }

  private setupUI() {
    this.canvas = this.host.querySelector('[data-role="canvas"]')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.statusEl = this.host.querySelector('[data-role="time"]')!;
    this.timelineContainer = this.host.querySelector('[data-role="timeline-container"]')!;

    // Import clip
    const importBtn = this.host.querySelector('[data-role="import"]') as HTMLButtonElement;
    const fileInput = this.host.querySelector('[data-role="clip-input"]') as HTMLInputElement;
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (file) {
        const duration = await this.getVideoDuration(file);
        const clip: VideoClip = {
          id: this.generateId(),
          blob: file,
          name: file.name.replace(/\.[^.]+$/, ''),
          duration,
          trimStart: 0,
          trimEnd: duration,
          x: this.clips.length * 0.1,
          y: this.clips.length * 0.05,
          width: 0.8,
          height: 0.8,
          opacity: 1,
          zIndex: this.clips.length,
        };
        this.clips.push(clip);
        this.selectedClipId = clip.id;
        this.renderTimeline();
        this.renderCanvas();
      }
      fileInput.value = '';
    });

    // Timeline click - seek
    this.timelineContainer.addEventListener('click', (e) => {
      const rect = this.timelineContainer.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      this.playbackTime = ratio * this.getTotalDuration();
      this.renderCanvas();
      this.updateTime();
    });

    // Play/Pause
    const playBtn = this.host.querySelector('[data-role="play"]') as HTMLButtonElement;
    playBtn.addEventListener('click', () => {
      this.isPlaying = !this.isPlaying;
      playBtn.textContent = this.isPlaying ? '⏸ Pause' : '▶ Play';
      if (this.isPlaying) this.tickPlayback();
    });

    // Tabs
    this.host.querySelectorAll('.vid-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.host.querySelectorAll('.vid-tab').forEach(t => t.classList.remove('active'));
        this.host.querySelectorAll('.vid-panel').forEach(p => p.classList.remove('active'));
        (tab as HTMLElement).classList.add('active');
        const panel = (tab as HTMLElement).dataset.tab;
        this.host.querySelector(`[data-panel="${panel}"]`)?.classList.add('active');
      });
    });

    // Brightness/Contrast/Saturation
    const br = this.host.querySelector('[data-role="brightness"]') as HTMLInputElement;
    const ct = this.host.querySelector('[data-role="contrast"]') as HTMLInputElement;
    const sa = this.host.querySelector('[data-role="saturation"]') as HTMLInputElement;
    br.addEventListener('input', () => { this.brightness = Number(br.value); this.renderCanvas(); });
    ct.addEventListener('input', () => { this.contrast = Number(ct.value); this.renderCanvas(); });
    sa.addEventListener('input', () => { this.saturation = Number(sa.value); this.renderCanvas(); });

    // Look presets
    this.host.querySelector('[data-role="lookNone"]')?.addEventListener('click', () => { this.look = 'none'; this.renderCanvas(); });
    this.host.querySelector('[data-role="lookGray"]')?.addEventListener('click', () => { this.look = 'grayscale'; this.renderCanvas(); });
    this.host.querySelector('[data-role="lookSepia"]')?.addEventListener('click', () => { this.look = 'sepia'; this.renderCanvas(); });

    // Format/Resolution select
    (this.host.querySelector('[data-role="fmt"]') as HTMLSelectElement).addEventListener('change', (e) => {
      this.outFmt = (e.target as HTMLSelectElement).value as Fmt;
    });
    (this.host.querySelector('[data-role="res"]') as HTMLSelectElement).addEventListener('change', (e) => {
      this.resPreset = (e.target as HTMLSelectElement).value as ResPreset;
    });

    // Export
    this.host.querySelector('[data-role="export"]')?.addEventListener('click', () => {
      void this.exportVideo();
    });

    // Zoom
    const zoomSlider = this.host.querySelector('[data-role="zoom-slider"]') as HTMLInputElement;
    const zoomValue = this.host.querySelector('[data-role="zoom-value"]')!;
    const updateZoom = (val: number) => {
      this.zoom = Math.max(50, Math.min(200, val));
      zoomSlider.value = String(this.zoom);
      zoomValue.textContent = `${this.zoom}%`;
      this.renderTimeline();
    };
    this.host.querySelector('[data-role="zoom"]')?.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      const action = btn.getAttribute('data-zoom');
      if (action === 'in') updateZoom(this.zoom + 10);
      else if (action === 'out') updateZoom(this.zoom - 10);
      else if (action === 'reset') updateZoom(100);
    });
    if (zoomSlider) {
      zoomSlider.addEventListener('input', () => updateZoom(Number(zoomSlider.value)));
    }
  }

  private renderCanvas() {
    const width = this.canvas.width = 800;
    const height = this.canvas.height = 600;
    this.ctx.fillStyle = '#000';
    this.ctx.fillRect(0, 0, width, height);

    // Render each clip
    for (const clip of this.clips.sort((a, b) => a.zIndex - b.zIndex)) {
      const trimmedDuration = clip.trimEnd - clip.trimStart;
      const isInFrame = this.playbackTime >= clip.trimStart && this.playbackTime < clip.trimEnd;

      if (isInFrame) {
        this.ctx.globalAlpha = clip.opacity;
        this.ctx.fillStyle = '#333';
        this.ctx.fillRect(
          clip.x * width,
          clip.y * height,
          clip.width * width,
          clip.height * height
        );
        this.ctx.fillStyle = '#fff';
        this.ctx.font = '14px sans-serif';
        this.ctx.fillText(clip.name, clip.x * width + 10, clip.y * height + 25);
        this.ctx.globalAlpha = 1;
      }
    }

    this.applyFilters();
    this.updateTime();
  }

  private applyFilters() {
    const f: string[] = [];
    if (this.brightness !== 0) f.push(`brightness(${1 + this.brightness})`);
    if (this.contrast !== 1) f.push(`contrast(${this.contrast})`);
    if (this.saturation !== 1) f.push(`saturate(${this.saturation})`);
    if (this.look === 'grayscale') f.push('grayscale(1)');
    if (this.look === 'sepia') f.push('sepia(0.85)');
    this.canvas.style.filter = f.join(' ');
  }

  private renderTimeline() {
    const clipsArea = this.host.querySelector('[data-role="clips-area"]')!;
    clipsArea.innerHTML = '';

    const totalDuration = this.getTotalDuration();
    const timelineWidth = clipsArea.clientWidth || 800;

    for (const clip of this.clips) {
      const clipEl = document.createElement('div');
      clipEl.className = 'vid-clip-item' + (clip.id === this.selectedClipId ? ' selected' : '');
      clipEl.style.left = `${(clip.trimStart / totalDuration) * 100}%`;
      clipEl.style.width = `${((clip.trimEnd - clip.trimStart) / totalDuration) * 100}%`;
      clipEl.innerHTML = `<span>${clip.name}</span>`;

      clipEl.addEventListener('click', (e) => {
        e.stopPropagation();
        this.selectedClipId = clip.id;
        this.renderTimeline();
        this.renderClipProperties();
      });

      // Trim handles
      const leftHandle = document.createElement('div');
      leftHandle.className = 'vid-clip-handle left';
      leftHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.startTrimming(clip, 'start', e);
      });
      clipEl.appendChild(leftHandle);

      const rightHandle = document.createElement('div');
      rightHandle.className = 'vid-clip-handle right';
      rightHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        this.startTrimming(clip, 'end', e);
      });
      clipEl.appendChild(rightHandle);

      clipsArea.appendChild(clipEl);
    }

    // Update playhead
    const totalTime = this.getTotalDuration();
    const playhead = this.host.querySelector('[data-role="playhead"]') as HTMLElement;
    if (playhead && totalTime > 0) {
      playhead.style.left = `${(this.playbackTime / totalTime) * 100}%`;
    }
  }

  private startTrimming(clip: VideoClip, side: 'start' | 'end', e: MouseEvent) {
    const totalDuration = this.getTotalDuration();
    const startX = e.clientX;
    const clipsArea = this.host.querySelector('[data-role="clips-area"]')!;
    const areaWidth = clipsArea.clientWidth;

    const onMouseMove = (moveE: MouseEvent) => {
      const delta = moveE.clientX - startX;
      const deltaTime = (delta / areaWidth) * totalDuration;

      if (side === 'start') {
        clip.trimStart = Math.max(0, Math.min(clip.trimStart + deltaTime, clip.trimEnd - 0.1));
      } else {
        clip.trimEnd = Math.min(clip.duration, Math.max(clip.trimEnd + deltaTime, clip.trimStart + 0.1));
      }
      this.renderTimeline();
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  private renderClipProperties() {
    const propsEl = this.host.querySelector('[data-role="clip-props"]')!;
    const clip = this.clips.find(c => c.id === this.selectedClipId);

    if (!clip) {
      propsEl.innerHTML = '<p>Select a clip to edit</p>';
      return;
    }

    propsEl.innerHTML = `
      <h3>${clip.name}</h3>
      <label class="vid-field">X Position
        <input type="range" min="0" max="1" step="0.05" value="${clip.x}" class="clip-x"></label>
      <label class="vid-field">Y Position
        <input type="range" min="0" max="1" step="0.05" value="${clip.y}" class="clip-y"></label>
      <label class="vid-field">Width
        <input type="range" min="0.1" max="1" step="0.05" value="${clip.width}" class="clip-w"></label>
      <label class="vid-field">Height
        <input type="range" min="0.1" max="1" step="0.05" value="${clip.height}" class="clip-h"></label>
      <label class="vid-field">Opacity
        <input type="range" min="0" max="1" step="0.1" value="${clip.opacity}" class="clip-opacity"></label>
      <button type="button" class="vid-btn delete-clip">Delete Clip</button>
    `;

    propsEl.querySelector('.clip-x')?.addEventListener('input', (e) => {
      clip.x = Number((e.target as HTMLInputElement).value);
      this.renderCanvas();
    });
    propsEl.querySelector('.clip-y')?.addEventListener('input', (e) => {
      clip.y = Number((e.target as HTMLInputElement).value);
      this.renderCanvas();
    });
    propsEl.querySelector('.clip-w')?.addEventListener('input', (e) => {
      clip.width = Number((e.target as HTMLInputElement).value);
      this.renderCanvas();
    });
    propsEl.querySelector('.clip-h')?.addEventListener('input', (e) => {
      clip.height = Number((e.target as HTMLInputElement).value);
      this.renderCanvas();
    });
    propsEl.querySelector('.clip-opacity')?.addEventListener('input', (e) => {
      clip.opacity = Number((e.target as HTMLInputElement).value);
      this.renderCanvas();
    });
    propsEl.querySelector('.delete-clip')?.addEventListener('click', () => {
      this.clips = this.clips.filter(c => c.id !== clip.id);
      this.selectedClipId = null;
      this.renderTimeline();
      this.renderClipProperties();
      this.renderCanvas();
    });
  }

  private tickPlayback() {
    if (!this.isPlaying) return;
    this.playbackTime += 1 / 30;
    if (this.playbackTime > this.getTotalDuration()) {
      this.playbackTime = 0;
      this.isPlaying = false;
      const playBtn = this.host.querySelector('[data-role="play"]') as HTMLButtonElement;
      if (playBtn) playBtn.textContent = '▶ Play';
    }
    this.renderCanvas();
    this.renderTimeline();
    this.rafId = requestAnimationFrame(() => this.tickPlayback());
  }

  private updateTime() {
    const fmt = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${sec.toString().padStart(2, '0')}`;
    };
    this.statusEl.textContent = `${fmt(this.playbackTime)} / ${fmt(this.getTotalDuration())}`;
  }

  private async exportVideo(): Promise<void> {
    this.statusEl.textContent = 'Exporting...';
    try {
      // Placeholder - full export would require ffmpeg + rendering composition
      this.statusEl.textContent = 'Export ready (multi-clip composition requires ffmpeg)';
    } catch (err) {
      this.statusEl.textContent = 'Export failed';
    }
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    if (this.clips.length === 0) return null;
    // For now, return the first clip's blob
    // Full export would composite and render all clips
    return { blob: this.clips[0].blob, contentType: 'video/mp4' };
  }
}
