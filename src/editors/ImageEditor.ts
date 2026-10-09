import './styles/image.css';
import { setAppClipboard, getAppClipboard, type EditCommands } from './editCommands';
import { applyTone, needsTonePass, computeHistogram, exportSize, formatBytes, type ExportOptions } from './image/pixels';
import { copyBlob, pasteBlob, showClipboardFeedback } from '../utils/clipboard';

// Picsart-inspired, fully client-side image editor (vanilla TS, no framework).
// open() builds the entire UI inside a container; export() flattens all layers
// to a Blob. Pure geometry helpers stay exported for the existing unit tests.

export function computeResize(w: number, h: number, maxDim: number): { w: number; h: number } {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

// Largest rect of the given aspect (w/h) centered inside a w×h image.
export function fitAspect(w: number, h: number, aspect: number): { x: number; y: number; w: number; h: number } {
  const cw = Math.min(w, h * aspect), ch = cw / aspect;
  return { x: (w - cw) / 2, y: (h - ch) / 2, w: cw, h: ch };
}

// Output pixel size for a reshape: `size` is the long side (0 = keep source scale).
export function reshapeSize(srcW: number, srcH: number, aspect: number, size: number): { w: number; h: number } {
  if (size <= 0) return { w: Math.max(1, Math.round(srcW)), h: Math.max(1, Math.round(srcH)) };
  return aspect >= 1
    ? { w: size, h: Math.max(1, Math.round(size / aspect)) }
    : { w: Math.max(1, Math.round(size * aspect)), h: size };
}

type ReshapeShape = 'circle' | 'rounded' | 'square';

// Profile-picture / social presets for the Reshape panel.
const RESHAPE_PRESETS: { label: string; shape: ReshapeShape; aspect: number; size: number }[] = [
  { label: 'Instagram DP', shape: 'circle', aspect: 1, size: 1080 },
  { label: 'WhatsApp DP', shape: 'circle', aspect: 1, size: 640 },
  { label: 'LinkedIn / X', shape: 'circle', aspect: 1, size: 400 },
  { label: 'Insta post 4:5', shape: 'square', aspect: 4 / 5, size: 1350 },
  { label: 'Story 9:16', shape: 'square', aspect: 9 / 16, size: 1920 },
  { label: 'YouTube 16:9', shape: 'square', aspect: 16 / 9, size: 1280 },
  { label: 'Passport 35×45', shape: 'square', aspect: 35 / 45, size: 600 },
];

const RESHAPE_RATIOS: { label: string; v: number }[] = [
  { label: '1:1', v: 1 }, { label: '4:5', v: 4 / 5 }, { label: '3:4', v: 3 / 4 }, { label: '2:3', v: 2 / 3 },
  { label: '9:16', v: 9 / 16 }, { label: '16:9', v: 16 / 9 }, { label: '4:3', v: 4 / 3 }, { label: '3:2', v: 3 / 2 },
  { label: '1.91:1', v: 1.91 },
];

export function computeRotatedSize(w: number, h: number, deg: 90 | 180 | 270): { w: number; h: number } {
  return deg === 180 ? { w, h } : { w: h, h: w };
}

// AI op shape emitted by the backend (see worker/src/ai.ts image system prompt).
export interface AiImageOp { op: string; args?: Record<string, unknown> }

// ---- Model ----------------------------------------------------------------

// Live, non-destructive adjustments. Most map to CSS canvas filters; a few
// (exposure/temperature/tint/sharpness/vignette) are applied by hand.
interface Adjustments {
  brightness: number; // %  (100 = neutral)
  contrast: number;   // %
  saturation: number; // %
  exposure: number;   // -100..100
  temperature: number;// -100..100 (warm/cool)
  tint: number;       // -100..100 (green/magenta)
  hue: number;        // -180..180 deg
  sharpness: number;  // 0..100
  blur: number;       // 0..20 px
  vignette: number;   // 0..100
  highlights: number; // -100..100
  shadows: number;    // -100..100
  vibrance: number;   // -100..100
  grain: number;      // 0..100
  fade: number;       // 0..100
  blackPoint: number; // 0..100 (levels)
  whitePoint: number; // 0..100 (levels)
  grayscale: number;  // 0..1
  sepia: number;      // 0..1
  invert: number;     // 0..1
}

function neutralAdjustments(): Adjustments {
  return {
    brightness: 100, contrast: 100, saturation: 100, exposure: 0,
    temperature: 0, tint: 0, hue: 0, sharpness: 0, blur: 0, vignette: 0,
    highlights: 0, shadows: 0, vibrance: 0, grain: 0, fade: 0, blackPoint: 0, whitePoint: 0,
    grayscale: 0, sepia: 0, invert: 0,
  };
}

type Point = { x: number; y: number };
type Tool = 'select' | 'crop' | 'brush' | 'eraser' | 'text' | 'rect' | 'ellipse' | 'arrow' | 'wand' | 'lasso';

interface StrokeLayer { id: string; kind: 'brush' | 'eraser'; points: Point[]; color: string; size: number; opacity?: number; }
interface TextLayer { id: string; kind: 'text'; x: number; y: number; text: string; size: number; color: string; bold: boolean; opacity?: number; }
interface ShapeLayer { id: string; kind: 'rect' | 'ellipse' | 'arrow'; x: number; y: number; w: number; h: number; color: string; strokeWidth: number; fill: boolean; opacity?: number; }
interface StickerLayer { id: string; kind: 'sticker'; x: number; y: number; size: number; emoji: string; opacity?: number; }
interface ImageLayer { id: string; kind: 'image'; canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number; opacity?: number; }
type Layer = StrokeLayer | TextLayer | ShapeLayer | StickerLayer | ImageLayer;

interface EditorState {
  base: HTMLCanvasElement; // current base pixels (post crop/rotate/resize/flip)
  adjustments: Adjustments;
  layers: Layer[];
}

// Filter presets: partial adjustment overrides applied on top of neutral.
const PRESETS: { name: string; adj: Partial<Adjustments> }[] = [
  { name: 'Original', adj: {} },
  { name: 'Grayscale', adj: { grayscale: 1 } },
  { name: 'Sepia', adj: { sepia: 1 } },
  { name: 'Vintage', adj: { sepia: 0.4, contrast: 90, saturation: 85, temperature: 25, vignette: 40 } },
  { name: 'Cool', adj: { temperature: -45, saturation: 110 } },
  { name: 'Warm', adj: { temperature: 45, saturation: 112 } },
  { name: 'Dramatic', adj: { contrast: 140, saturation: 120, brightness: 95, vignette: 30 } },
  { name: 'Fade', adj: { contrast: 88, saturation: 80, brightness: 108 } },
  { name: 'Invert', adj: { invert: 1 } },
  // LUT-style looks built from the tone stack.
  { name: 'Film', adj: { contrast: 108, saturation: 92, fade: 22, grain: 28, temperature: 12, vignette: 25 } },
  { name: 'Teal-Orange', adj: { contrast: 112, saturation: 118, temperature: 18, tint: -10, shadows: 18, highlights: -12 } },
  { name: 'Matte', adj: { fade: 45, contrast: 94, saturation: 88, shadows: 15 } },
  { name: 'Punch', adj: { contrast: 118, vibrance: 55, highlights: -20, shadows: 25, blackPoint: 6 } },
  { name: 'Moody', adj: { brightness: 92, contrast: 120, saturation: 82, temperature: -15, vignette: 45, shadows: -10 } },
  { name: 'B&W Film', adj: { grayscale: 1, contrast: 120, grain: 40, fade: 12, vignette: 30 } },
  { name: 'Golden Hour', adj: { temperature: 55, tint: 8, saturation: 115, highlights: -15, vibrance: 30 } },
];

const STICKERS = ['😀', '😎', '❤️', '⭐', '🔥', '🎉', '👍', '💯', '✅'];

let idSeq = 0;
const uid = (): string => `l${++idSeq}`;

// structuredClone can't copy canvases; image layers share their pixel canvas.
function cloneLayer<T extends Layer>(l: T): T {
  if (l.kind === 'image') return { ...l } as T;
  return structuredClone(l);
}

// ---- Editor ---------------------------------------------------------------

export class ImageEditor {
  private container: HTMLElement;
  private onChange?: () => void;
  private contentType: string;
  private zoom = 100;
  private comparing = false; // hold-to-compare: show the unadjusted original
  private labels: string[] = []; // history labels, parallel to undoStack
  private redoLabels: string[] = [];
  private exportOpts: ExportOptions = { format: 'image/png', quality: 0.92, maxDim: 0 };
  private histCanvas: HTMLCanvasElement | null = null;
  private renderRaf = 0;
  private pinching = false;
  private setZoom: (v: number) => void = () => undefined;

  private state: EditorState;
  private undoStack: EditorState[] = [];
  private redoStack: EditorState[] = [];

  private tool: Tool = 'select';
  private selectedId: string | null = null;
  // Multi-selection (marquee / shift-click). Active only while it contains selectedId.
  private multi = new Set<string>();
  private groupOrig: Map<string, Layer> | null = null;
  private marqueeEl: HTMLElement | null = null;

  // Brush/shape settings
  private color = '#ff3b6b';
  private brushSize = 12;
  private textSize = 48;
  private fontBold = true;

  // DOM refs
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private wrap!: HTMLElement;
  private cropBox: HTMLElement | null = null;
  private selBox: HTMLElement | null = null;
  private panelHost!: HTMLElement;
  private toolbar!: HTMLElement;

  // Crop rectangle in image coordinates (or null when not cropping).
  private crop: { x: number; y: number; w: number; h: number } | null = null;
  private cropAspect: number | null = null; // null = free

  // Reshape (profile pic) settings: shape mask, aspect, output long side (0 = keep),
  // fill = crop to the box, fit = letterbox the whole image onto a background.
  private reshape = { shape: 'circle' as ReshapeShape, aspect: 1, size: 0, mode: 'fill' as 'fill' | 'fit',
    bg: 'transparent' as 'transparent' | 'color' | 'blur', bgColor: '#ffffff' };

  // Active pointer gesture bookkeeping.
  // Pixel selection (wand / lasso): alpha mask the size of the base image.
  private selMask: HTMLCanvasElement | null = null;
  private selTint: HTMLCanvasElement | null = null;
  private selBounds: { x: number; y: number; w: number; h: number } | null = null;
  private selTarget: string | null = null; // image layer id the selection applies to; null = whole composite
  private lassoPts: Point[] = [];
  private wandTol = 32;
  private wandMode: 'color' | 'edge' = 'color';
  private edgeSens = 60;
  private feather = 0;
  private antsEl: HTMLCanvasElement | null = null;
  private antsFrames: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
  private antsPhase = 0;
  private antsTimer = 0;

  private drag: { mode: 'draw' | 'move' | 'resize' | 'shape' | 'crop-move' | 'crop-resize' | 'lasso' | 'marquee' | 'move-group';
    corner?: string; start: Point; orig?: Layer; origCrop?: { x: number; y: number; w: number; h: number } } | null = null;

  private constructor(container: HTMLElement, base: HTMLCanvasElement, contentType: string, onChange?: () => void) {
    this.container = container;
    this.onChange = onChange;
    this.contentType = contentType;
    this.state = { base, adjustments: neutralAdjustments(), layers: [] };
  }

  static async open(container: HTMLElement, blob: Blob, name: string, onChange?: () => void): Promise<ImageEditor> {
    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (err) {
      // Image decode failed (e.g. TIFF, corrupted, unsupported format).
      const ext = /\.(\w+)$/i.exec(name)?.[1]?.toUpperCase() || 'this format';
      container.innerHTML = `
        <div class="img-editor">
          <div class="img-decode-error">
            <div class="img-decode-icon">🖼️</div>
            <div class="img-decode-title">Image format not supported</div>
            <div class="img-decode-msg">
              This image format (.${ext.toLowerCase()}) can't be previewed or edited in the browser.
              Download it to open in another app.
            </div>
          </div>
        </div>`;
      // Return a stub editor that does nothing but can be destroyed cleanly.
      return new ImageEditor(container, document.createElement('canvas'), 'image/png', onChange);
    }

    const base = document.createElement('canvas');
    base.width = bitmap.width;
    base.height = bitmap.height;
    base.getContext('2d')!.drawImage(bitmap, 0, 0);
    bitmap.close();

    const isJpeg = /jpe?g/i.test(blob.type) || /\.jpe?g$/i.test(name);
    const ed = new ImageEditor(container, base, isJpeg ? 'image/jpeg' : 'image/png', onChange);
    ed.buildUi();
    ed.render();
    return ed;
  }

  // ---- History ----

  private cloneState(): EditorState {
    const base = document.createElement('canvas');
    base.width = this.state.base.width;
    base.height = this.state.base.height;
    base.getContext('2d')!.drawImage(this.state.base, 0, 0);
    return {
      base,
      adjustments: { ...this.state.adjustments },
      layers: this.state.layers.map((l) => {
        if (l.kind === 'image') {
          const canvas = document.createElement('canvas');
          canvas.width = l.canvas.width;
          canvas.height = l.canvas.height;
          canvas.getContext('2d')!.drawImage(l.canvas, 0, 0);
          return { ...l, canvas };
        }
        return cloneLayer(l);
      }),
    };
  }

  // Snapshot BEFORE a mutation so undo restores the prior state.
  private commit(label = 'Edit'): void {
    this.undoStack.push(this.cloneState());
    this.labels.push(label);
    if (this.undoStack.length > 40) { this.undoStack.shift(); this.labels.shift(); }
    this.redoStack = [];
    this.redoLabels = [];
    if (this.activePanel === 'history') this.rebuildPanel();
    this.onChange?.();
    this.syncToolbar();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoLabels.push(this.labels.pop() ?? 'Edit');
    this.redoStack.push(this.cloneState());
    this.state = prev;
    this.selectedId = null;
    this.render();
    this.rebuildPanel();
    this.onChange?.();
    this.syncToolbar();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.labels.push(this.redoLabels.pop() ?? 'Edit');
    this.undoStack.push(this.cloneState());
    this.state = next;
    this.selectedId = null;
    this.render();
    this.rebuildPanel();
    this.onChange?.();
    this.syncToolbar();
  }

  // ---- Rendering ----

  // Compose base (with adjustments) + overlays into a target canvas.
  private composite(target: HTMLCanvasElement): void {
    const { base, adjustments: a, layers } = this.state;
    target.width = base.width;
    target.height = base.height;
    const ctx = target.getContext('2d')!;
    this.paintBase(ctx, base, this.comparing ? neutralAdjustments() : a);
    // Overlay layers, in stacking order.
    for (const l of layers) this.drawLayer(ctx, l);
  }

  // Base pixels + the whole non-destructive adjustment stack (also used for thumbnails).
  private paintBase(ctx: CanvasRenderingContext2D, base: HTMLCanvasElement, a: Adjustments): void {
    const w = base.width, h = base.height;
    // Base image with CSS filters (exposure folded into brightness).
    const brightness = Math.max(0, a.brightness * (1 + a.exposure / 100));
    ctx.filter = [
      `brightness(${brightness}%)`,
      `contrast(${a.contrast}%)`,
      `saturate(${a.saturation}%)`,
      `hue-rotate(${a.hue}deg)`,
      a.blur > 0 ? `blur(${a.blur}px)` : '',
      a.grayscale ? `grayscale(${a.grayscale})` : '',
      a.sepia ? `sepia(${a.sepia})` : '',
      a.invert ? `invert(${a.invert})` : '',
    ].filter(Boolean).join(' ');
    ctx.drawImage(base, 0, 0);
    ctx.filter = 'none';

    // Temperature / tint color grade.
    this.applyColorGrade(ctx, w, h, a);
    // Tone stack: levels, fade, shadows/highlights, vibrance, grain.
    if (needsTonePass(a)) {
      const img = ctx.getImageData(0, 0, w, h);
      applyTone(img.data, a);
      ctx.putImageData(img, 0, 0);
    }
    // Sharpen (per-pixel convolution) then vignette.
    if (a.sharpness > 0) this.applySharpen(ctx, w, h, a.sharpness / 100);
    if (a.vignette > 0) this.applyVignette(ctx, w, h, a.vignette / 100);
  }

  private applyColorGrade(ctx: CanvasRenderingContext2D, w: number, h: number, a: Adjustments): void {
    const draw = (r: number, g: number, b: number, strength: number): void => {
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(0.5, strength)})`;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    };
    if (a.temperature !== 0) {
      const s = Math.abs(a.temperature) / 100 * 0.5;
      if (a.temperature > 0) draw(255, 150, 40, s); else draw(40, 130, 255, s);
    }
    if (a.tint !== 0) {
      const s = Math.abs(a.tint) / 100 * 0.5;
      if (a.tint > 0) draw(255, 0, 255, s); else draw(0, 255, 0, s);
    }
  }

  private applyVignette(ctx: CanvasRenderingContext2D, w: number, h: number, strength: number): void {
    const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.save();
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  // Simple 3x3 unsharp-ish convolution, blended by `amount`.
  private applySharpen(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number): void {
    const src = ctx.getImageData(0, 0, w, h);
    const out = ctx.createImageData(w, h);
    const s = src.data, d = out.data;
    const k = amount; // center weight boost
    const kernel = [0, -k, 0, -k, 1 + 4 * k, -k, 0, -k, 0];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let sum = 0, ki = 0;
          for (let ky = -1; ky <= 1; ky++) {
            for (let kx = -1; kx <= 1; kx++) {
              const px = Math.min(w - 1, Math.max(0, x + kx));
              const py = Math.min(h - 1, Math.max(0, y + ky));
              sum += s[(py * w + px) * 4 + c] * kernel[ki++];
            }
          }
          d[(y * w + x) * 4 + c] = Math.min(255, Math.max(0, sum));
        }
        d[(y * w + x) * 4 + 3] = s[(y * w + x) * 4 + 3];
      }
    }
    ctx.putImageData(out, 0, 0);
  }

  private drawLayer(ctx: CanvasRenderingContext2D, l: Layer): void {
    ctx.save();
    // Apply opacity if set
    if (l.opacity !== undefined) {
      ctx.globalAlpha = Math.max(0, Math.min(1, l.opacity));
    }
    if (l.kind === 'brush' || l.kind === 'eraser') {
      ctx.globalCompositeOperation = l.kind === 'eraser' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = l.color;
      ctx.lineWidth = l.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      l.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      if (l.points.length === 1) { ctx.lineTo(l.points[0].x + 0.01, l.points[0].y); }
      ctx.stroke();
    } else if (l.kind === 'text') {
      ctx.fillStyle = l.color;
      ctx.textBaseline = 'top';
      ctx.font = `${l.bold ? 'bold ' : ''}${l.size}px system-ui, sans-serif`;
      ctx.fillText(l.text, l.x, l.y);
    } else if (l.kind === 'sticker') {
      ctx.textBaseline = 'top';
      ctx.font = `${l.size}px system-ui, sans-serif`;
      ctx.fillText(l.emoji, l.x, l.y);
    } else if (l.kind === 'image') {
      ctx.drawImage(l.canvas, l.x, l.y, l.w, l.h);
    } else if (l.kind === 'rect' || l.kind === 'ellipse' || l.kind === 'arrow') {
      ctx.strokeStyle = l.color;
      ctx.fillStyle = l.color;
      ctx.lineWidth = l.strokeWidth;
      if (l.kind === 'rect') {
        if (l.fill) ctx.fillRect(l.x, l.y, l.w, l.h);
        else ctx.strokeRect(l.x, l.y, l.w, l.h);
      } else if (l.kind === 'ellipse') {
        ctx.beginPath();
        ctx.ellipse(l.x + l.w / 2, l.y + l.h / 2, Math.abs(l.w / 2), Math.abs(l.h / 2), 0, 0, Math.PI * 2);
        if (l.fill) ctx.fill(); else ctx.stroke();
      } else {
        // arrow from (x,y) to (x+w,y+h)
        const x2 = l.x + l.w, y2 = l.y + l.h;
        const ang = Math.atan2(l.h, l.w);
        const head = Math.max(12, l.strokeWidth * 4);
        ctx.beginPath();
        ctx.moveTo(l.x, l.y); ctx.lineTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - Math.PI / 6), y2 - head * Math.sin(ang - Math.PI / 6));
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang + Math.PI / 6), y2 - head * Math.sin(ang + Math.PI / 6));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private render(): void {
    this.composite(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.drawSelectionOverlay();
    this.drawGroupOutlines();
    this.positionCropBox();
    this.positionSelBox();
    if (this.activePanel === 'adjust' && !this.comparing) this.drawHistogram();
  }

  // Dashed outline around each layer of a multi-selection (display canvas only).
  private drawGroupOutlines(): void {
    if (this.tool !== 'select' || !this.isGroup()) return;
    const c = this.ctx;
    const lw = Math.max(1.5, this.canvas.width / 600);
    c.save();
    c.lineWidth = lw;
    c.setLineDash([lw * 4, lw * 3]);
    for (const l of this.selectedLayers()) {
      const b = this.bbox(l);
      c.strokeStyle = '#ffffff'; c.lineDashOffset = 0; c.strokeRect(b.x, b.y, b.w, b.h);
      c.strokeStyle = '#ff3b9a'; c.lineDashOffset = lw * 3.5; c.strokeRect(b.x, b.y, b.w, b.h);
    }
    c.restore();
  }

  // ---- Geometry helpers ----

  private measure(ctx: CanvasRenderingContext2D, l: TextLayer): { w: number; h: number } {
    ctx.font = `${l.bold ? 'bold ' : ''}${l.size}px system-ui, sans-serif`;
    return { w: ctx.measureText(l.text).width, h: l.size * 1.2 };
  }

  // Axis-aligned bounding box in image coords.
  private bbox(l: Layer): { x: number; y: number; w: number; h: number } {
    if (l.kind === 'brush' || l.kind === 'eraser') {
      const xs = l.points.map((p) => p.x), ys = l.points.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x: x - l.size, y: y - l.size, w: Math.max(...xs) - x + l.size * 2, h: Math.max(...ys) - y + l.size * 2 };
    }
    if (l.kind === 'text') { const m = this.measure(this.canvas.getContext('2d')!, l); return { x: l.x, y: l.y, w: m.w, h: m.h }; }
    if (l.kind === 'sticker') return { x: l.x, y: l.y, w: l.size, h: l.size };
    if (l.kind === 'image') return { x: l.x, y: l.y, w: l.w, h: l.h };
    if (l.kind === 'rect' || l.kind === 'ellipse' || l.kind === 'arrow') {
      const x = Math.min(l.x, l.x + l.w), y = Math.min(l.y, l.y + l.h);
      return { x, y, w: Math.abs(l.w), h: Math.abs(l.h) };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  private toImage(e: PointerEvent): Point {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (this.canvas.width / r.width),
      y: (e.clientY - r.top) * (this.canvas.height / r.height),
    };
  }

  private hitTest(p: Point): Layer | null {
    for (let i = this.state.layers.length - 1; i >= 0; i--) {
      const b = this.bbox(this.state.layers[i]);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return this.state.layers[i];
    }
    return null;
  }

  private selected(): Layer | null {
    return this.state.layers.find((l) => l.id === this.selectedId) ?? null;
  }

  // All selected layers: the multi-selection when active, else the single one.
  private selectedLayers(): Layer[] {
    if (this.selectedId && this.multi.size > 1 && this.multi.has(this.selectedId)) {
      return this.state.layers.filter((l) => this.multi.has(l.id));
    }
    const s = this.selected();
    return s ? [s] : [];
  }
  private isGroup(): boolean { return this.selectedLayers().length > 1; }

  // ---- Pointer handling ----

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.pinching) return;
    const p = this.toImage(e);
    this.canvas.setPointerCapture(e.pointerId);

    if (this.tool === 'crop') return; // crop uses its own overlay handles

    if (this.tool === 'wand') {
      this.magicWand(p, e.shiftKey);
      return;
    }
    if (this.tool === 'lasso') {
      this.lassoPts = [p];
      this.drag = { mode: 'lasso', start: p };
      return;
    }

    if (this.tool === 'brush' || this.tool === 'eraser') {
      this.commit(this.tool === 'eraser' ? 'Eraser' : 'Brush');
      const l: StrokeLayer = { id: uid(), kind: this.tool, points: [p], color: this.color, size: this.brushSize };
      this.state.layers.push(l);
      this.selectedId = l.id;
      this.drag = { mode: 'draw', start: p, orig: l };
      this.render();
      return;
    }

    if (this.tool === 'rect' || this.tool === 'ellipse' || this.tool === 'arrow') {
      this.commit('Shape');
      const l: ShapeLayer = { id: uid(), kind: this.tool, x: p.x, y: p.y, w: 0, h: 0, color: this.color, strokeWidth: this.brushSize, fill: false };
      this.state.layers.push(l);
      this.selectedId = l.id;
      this.drag = { mode: 'shape', start: p, orig: l };
      this.rebuildPanel();
      return;
    }

    if (this.tool === 'text') {
      const text = prompt('Text:', 'Double-click to edit');
      if (text) {
        this.commit('Text');
        const l: TextLayer = { id: uid(), kind: 'text', x: p.x, y: p.y, text, size: this.textSize, color: this.color, bold: this.fontBold };
        this.state.layers.push(l);
        this.selectedId = l.id;
        this.render();
        this.rebuildPanel();
      }
      return;
    }

    // select tool: shift-click toggles, a hit inside a group moves the group,
    // a plain hit selects one layer, empty space starts a marquee.
    const hit = this.hitTest(p);
    if (hit && e.shiftKey) {
      if (!this.isGroup()) { this.multi.clear(); if (this.selectedId) this.multi.add(this.selectedId); }
      if (this.multi.has(hit.id)) this.multi.delete(hit.id); else this.multi.add(hit.id);
      this.selectedId = this.multi.has(hit.id) ? hit.id : [...this.multi].pop() ?? null;
      this.drag = null;
    } else if (hit && this.isGroup() && this.multi.has(hit.id)) {
      this.commit('Move');
      this.selectedId = hit.id;
      this.groupOrig = new Map(this.selectedLayers().map((l) => [l.id, cloneLayer(l)]));
      this.drag = { mode: 'move-group', start: p };
    } else if (hit) {
      this.multi.clear();
      this.selectedId = hit.id;
      this.commit('Move');
      this.drag = { mode: 'move', start: p, orig: cloneLayer(hit) };
    } else {
      if (!e.shiftKey) { this.multi.clear(); this.selectedId = null; }
      this.drag = { mode: 'marquee', start: p };
    }
    this.render();
    this.rebuildPanel();
  };

  private drawMarquee(a: Point, b: Point): void {
    if (!this.marqueeEl) { this.marqueeEl = el('div', 'img-marquee'); this.wrap.appendChild(this.marqueeEl); }
    const r = this.canvas.getBoundingClientRect();
    const wr = this.wrap.getBoundingClientRect();
    const sx = r.width / this.canvas.width, sy = r.height / this.canvas.height;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    Object.assign(this.marqueeEl.style, {
      display: 'block',
      left: `${(r.left - wr.left) + x * sx}px`, top: `${(r.top - wr.top) + y * sy}px`,
      width: `${Math.abs(b.x - a.x) * sx}px`, height: `${Math.abs(b.y - a.y) * sy}px`,
    });
  }

  // Select every layer whose box intersects the marquee (adds to it with shift).
  private finishMarquee(a: Point, b: Point, add: boolean): void {
    if (this.marqueeEl) this.marqueeEl.style.display = 'none';
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y);
    if (x1 - x0 < 3 && y1 - y0 < 3) return; // a click, not a drag
    const hits = this.state.layers.filter((l) => {
      const bb = this.bbox(l);
      return bb.x < x1 && bb.x + bb.w > x0 && bb.y < y1 && bb.y + bb.h > y0;
    });
    if (!add) this.multi.clear();
    for (const l of hits) this.multi.add(l.id);
    this.selectedId = hits.length ? hits[hits.length - 1]!.id : (add ? this.selectedId : null);
    if (this.selectedId) this.multi.add(this.selectedId);
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const p = this.toImage(e);
    if (this.drag.mode === 'lasso') { this.lassoPts.push(p); this.render(); return; }
    if (this.drag.mode === 'marquee') { this.drawMarquee(this.drag.start, p); return; }
    const dx = p.x - this.drag.start.x, dy = p.y - this.drag.start.y;
    if (this.drag.mode === 'move-group' && this.groupOrig) {
      for (const l of this.selectedLayers()) {
        const o = this.groupOrig.get(l.id);
        if (o) this.moveLayer(l, o, dx, dy);
      }
      this.render();
      return;
    }
    const cur = this.selected();
    if (!cur) return;

    if (this.drag.mode === 'draw' && (cur.kind === 'brush' || cur.kind === 'eraser')) {
      cur.points.push(p);
    } else if (this.drag.mode === 'shape' && (cur.kind === 'rect' || cur.kind === 'ellipse' || cur.kind === 'arrow')) {
      cur.w = dx; cur.h = dy;
    } else if (this.drag.mode === 'move' && this.drag.orig) {
      this.moveLayer(cur, this.drag.orig, dx, dy);
    } else if (this.drag.mode === 'resize' && this.drag.orig) {
      this.resizeLayer(cur, this.drag.orig, dx, dy);
    }
    this.render();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.drag?.mode === 'lasso') {
      this.drag = null;
      this.finishLasso(e.shiftKey);
      return;
    }
    if (this.drag?.mode === 'marquee') {
      this.finishMarquee(this.drag.start, this.toImage(e), e.shiftKey);
      this.drag = null;
      this.render();
      this.rebuildPanel();
      return;
    }
    this.groupOrig = null;
    if (this.drag && (this.drag.mode === 'move' || this.drag.mode === 'move-group' || this.drag.mode === 'resize' || this.drag.mode === 'shape' || this.drag.mode === 'draw')) {
      this.onChange?.();
    }
    this.drag = null;
    this.rebuildPanel();
  };

  private moveLayer(cur: Layer, orig: Layer, dx: number, dy: number): void {
    if ((cur.kind === 'brush' || cur.kind === 'eraser') && (orig.kind === 'brush' || orig.kind === 'eraser')) {
      cur.points = orig.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
    } else if ('x' in cur && 'x' in orig) {
      cur.x = orig.x + dx; cur.y = orig.y + dy;
    }
  }

  private resizeLayer(cur: Layer, orig: Layer, dx: number, dy: number): void {
    if (cur.kind === 'text' && orig.kind === 'text') {
      cur.size = Math.max(8, orig.size + dy);
    } else if (cur.kind === 'sticker' && orig.kind === 'sticker') {
      cur.size = Math.max(12, orig.size + dy);
    } else if ((cur.kind === 'rect' || cur.kind === 'ellipse' || cur.kind === 'arrow') && 'w' in orig) {
      cur.w = orig.w + dx; cur.h = orig.h + dy;
    } else if (cur.kind === 'image' && orig.kind === 'image') {
      // Keep aspect ratio; drive by the larger drag component.
      const ratio = orig.h / orig.w;
      const w = Math.max(10, Math.abs(dx) >= Math.abs(dy) ? orig.w + dx : orig.w + dy / ratio);
      cur.w = w; cur.h = w * ratio;
    }
  }

  // ---- Base-pixel operations (destructive; snapshot first) ----

  private replaceBase(newBase: HTMLCanvasElement): void {
    this.state.base = newBase;
    this.render();
  }

  private flip(axis: 'h' | 'v'): void {
    this.commit('Flip');
    const b = this.flatten();
    const out = document.createElement('canvas');
    out.width = b.width; out.height = b.height;
    const c = out.getContext('2d')!;
    c.translate(axis === 'h' ? b.width : 0, axis === 'v' ? b.height : 0);
    c.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
    c.drawImage(b, 0, 0);
    this.replaceBase(out);
  }

  private rotate90(deg: 90 | 180 | 270): void {
    this.commit('Rotate');
    const b = this.flatten();
    const size = computeRotatedSize(b.width, b.height, deg);
    const out = document.createElement('canvas');
    out.width = size.w; out.height = size.h;
    const c = out.getContext('2d')!;
    c.translate(size.w / 2, size.h / 2);
    c.rotate((deg * Math.PI) / 180);
    c.drawImage(b, -b.width / 2, -b.height / 2);
    this.replaceBase(out);
  }

  // Bake adjustments + overlay layers into a single canvas and reset them, so
  // geometric ops (flip/rotate) carry layers along instead of dropping them.
  private flatten(): HTMLCanvasElement {
    const flat = document.createElement('canvas');
    this.composite(flat);
    this.state.adjustments = neutralAdjustments();
    this.state.layers = [];
    this.selectedId = null;
    this.clearSelectionState();
    return flat;
  }

  private rotateFree(angleDeg: number): void {
    // Rotate the *composited* image so overlays come along, then reset overlays.
    this.commit('Straighten');
    const flat = document.createElement('canvas');
    this.composite(flat);
    const rad = (angleDeg * Math.PI) / 180;
    const w = flat.width, h = flat.height;
    const nw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
    const nh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
    const out = document.createElement('canvas');
    out.width = Math.round(nw); out.height = Math.round(nh);
    const c = out.getContext('2d')!;
    c.translate(nw / 2, nh / 2);
    c.rotate(rad);
    c.drawImage(flat, -w / 2, -h / 2);
    this.state.adjustments = neutralAdjustments();
    this.state.layers = [];
    this.replaceBase(out);
  }

  private resizeBase(maxDim: number): void {
    this.commit('Resize');
    const flat = document.createElement('canvas');
    this.composite(flat);
    const s = computeResize(flat.width, flat.height, maxDim);
    const out = document.createElement('canvas');
    out.width = s.w; out.height = s.h;
    out.getContext('2d')!.drawImage(flat, 0, 0, s.w, s.h);
    this.state.adjustments = neutralAdjustments();
    this.state.layers = [];
    this.replaceBase(out);
  }

  private applyCrop(): void {
    if (!this.crop) return;
    this.commit('Crop');
    const flat = document.createElement('canvas');
    this.composite(flat);
    const cr = this.crop;
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(cr.w));
    out.height = Math.max(1, Math.round(cr.h));
    out.getContext('2d')!.drawImage(flat, cr.x, cr.y, cr.w, cr.h, 0, 0, out.width, out.height);
    this.state.adjustments = neutralAdjustments();
    this.state.layers = [];
    this.crop = null;
    this.setTool('select');
    this.replaceBase(out);
  }

  private resetAll(): void {
    this.commit('Reset');
    this.state.adjustments = neutralAdjustments();
    this.state.layers = [];
    this.render();
    this.rebuildPanel();
  }

  // ---- AI-driven ops (public command API) ----

  private applyPresetByName(name: string): void {
    const p = PRESETS.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!p) return;
    this.commit('Preset');
    this.state.adjustments = { ...neutralAdjustments(), ...p.adj };
  }

  private applyAdjust(a: Record<string, number>): void {
    this.commit('Adjust');
    const adj = this.state.adjustments;
    if (a.brightness != null) adj.brightness = 100 + a.brightness;
    if (a.contrast != null) adj.contrast = 100 + a.contrast;
    if (a.saturation != null) adj.saturation = 100 + a.saturation;
    if (a.exposure != null) adj.exposure = a.exposure;
    if (a.hue != null) adj.hue = a.hue;
    if (a.temperature != null) adj.temperature = a.temperature;
    if (a.vignette != null) adj.vignette = a.vignette;
    if (a.sharpen != null) adj.sharpness = a.sharpen;
    if (a.grayscale != null) adj.grayscale = a.grayscale;
    if (a.sepia != null) adj.sepia = a.sepia;
    if (a.invert != null) adj.invert = a.invert;
    for (const k of ['highlights', 'shadows', 'vibrance', 'grain', 'tint', 'fade'] as const) {
      if (a[k] != null) adj[k] = a[k]!;
    }
  }

  /** Apply a batch of AI-generated image ops. Returns a human summary. */
  async applyAiOps(ops: AiImageOp[]): Promise<string> {
    const done: string[] = [];
    for (const op of ops) {
      const args = (op.args ?? {}) as Record<string, number & string>;
      switch (op.op) {
        case 'removeBackground':
          await this.removeBackground(document.createElement('div'));
          done.push('removed background');
          break;
        case 'rotate':
          if (args.deg === 90 || args.deg === 180 || args.deg === 270) {
            this.rotate90(args.deg); done.push(`rotated ${args.deg}°`);
          }
          break;
        case 'flip':
          if (args.axis === 'h' || args.axis === 'v') { this.flip(args.axis); done.push(`flipped ${args.axis}`); }
          break;
        case 'resize':
          if (typeof args.maxDim === 'number') { this.resizeBase(args.maxDim); done.push(`resized to ${args.maxDim}px`); }
          break;
        case 'crop': {
          const b = this.state.base;
          this.crop = { x: args.x * b.width, y: args.y * b.height, w: args.w * b.width, h: args.h * b.height };
          this.applyCrop(); done.push('cropped');
          break;
        }
        case 'filter':
          if (args.name) { this.applyPresetByName(args.name); done.push(`filter: ${args.name}`); }
          break;
        case 'adjust':
          this.applyAdjust(args); done.push('adjusted');
          break;
      }
    }
    this.render();
    this.rebuildPanel();
    return done.join(', ') || 'no changes';
  }

  // ---- Background removal (lazy, on demand) ----

  private async removeBackground(noteEl: HTMLElement): Promise<void> {
    noteEl.textContent = 'Removing background… (downloading model)';
    noteEl.className = 'img-note';
    try {
      // Run the model inside a sandboxed iframe (see bgRemovalClient): it needs
      // onnxruntime's 'unsafe-eval', which we keep OFF the main document by
      // confining it to the frame's own CSP. The library is a vendored dep
      // (bundled into the frame) pinned to 1.4.5 (newest with published data);
      // the heavy model/wasm assets load at runtime from staticimgly.
      const { removeBackgroundViaFrame } = await import('./bgRemovalClient');
      const flat = document.createElement('canvas');
      this.composite(flat);
      const srcBlob: Blob = await new Promise((res, rej) =>
        flat.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      const result = await removeBackgroundViaFrame(srcBlob);
      const bmp = await createImageBitmap(result);
      const out = document.createElement('canvas');
      out.width = bmp.width; out.height = bmp.height;
      out.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      this.commit();
      this.state.adjustments = neutralAdjustments();
      this.state.layers = [];
      this.replaceBase(out);
      this.contentType = 'image/png'; // transparency requires PNG
      noteEl.textContent = 'Background removed.';
    } catch (err) {
      noteEl.className = 'img-note error';
      noteEl.textContent = 'Background removal unavailable (failed to load model). ' + (err instanceof Error ? err.message : '');
    }
  }

  // ---- UI construction ----

  private buildUi(): void {
    this.container.innerHTML = '';
    const root = el('div', 'img-editor');

    this.toolbar = el('div', 'img-toolbar');
    root.appendChild(this.toolbar);

    const body = el('div', 'img-body');
    const stage = el('div', 'img-stage');
    this.wrap = el('div', 'img-canvas-wrap');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'img-canvas';
    this.wrap.appendChild(this.canvas);
    this.antsEl = document.createElement('canvas');
    this.antsEl.className = 'img-ants';
    this.wrap.appendChild(this.antsEl);
    stage.appendChild(this.wrap);
    body.appendChild(stage);

    this.panelHost = el('div', 'img-panel');
    body.appendChild(this.panelHost);
    root.appendChild(body);

    // Zoom controls
    const zoomBar = el('div', 'img-zoom');
    const zoomOut = button('−', 'img-zoom-btn'); zoomOut.title = 'Zoom out'; zoomOut.dataset.zoom = 'out';
    const zoomSlider = document.createElement('input'); zoomSlider.type = 'range'; zoomSlider.min = '25'; zoomSlider.max = '400'; zoomSlider.value = '100'; zoomSlider.step = '10'; zoomSlider.className = 'img-zoom-slider';
    const zoomValue = document.createElement('span'); zoomValue.className = 'img-zoom-value'; zoomValue.textContent = '100%';
    const zoomIn = button('+', 'img-zoom-btn'); zoomIn.title = 'Zoom in'; zoomIn.dataset.zoom = 'in';
    const zoomReset = button('Reset', 'img-zoom-btn'); zoomReset.title = 'Reset zoom'; zoomReset.dataset.zoom = 'reset';
    zoomBar.append(zoomOut, zoomSlider, zoomValue, zoomIn, zoomReset);
    root.appendChild(zoomBar);

    this.container.appendChild(root);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);

    // Zoom controls
    const updateZoom = (val: number) => {
      this.zoom = Math.max(25, Math.min(400, Math.round(val)));
      zoomSlider.value = String(this.zoom);
      zoomValue.textContent = `${this.zoom}%`;
      this.wrap.style.transform = `scale(${this.zoom / 100})`;
      this.wrap.style.transformOrigin = 'top left';
    };
    zoomBar.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest('button');
      if (!btn) return;
      const action = btn.dataset.zoom;
      if (action === 'in') updateZoom(this.zoom + 10);
      else if (action === 'out') updateZoom(this.zoom - 10);
      else if (action === 'reset') updateZoom(100);
    });
    zoomSlider.addEventListener('input', () => updateZoom(Number(zoomSlider.value)));
    this.setZoom = updateZoom;

    // Pinch-zoom + two-finger pan (touch), Ctrl/Cmd+wheel zoom (desktop).
    const touches = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; zoom: number; mx: number; my: number } | null = null;
    const pinchState = (): { dist: number; mx: number; my: number } => {
      const [a, b] = [...touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
      return { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };
    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        // Abort any one-finger stroke/shape/move that the first finger started.
        if (this.drag && (this.drag.mode === 'draw' || this.drag.mode === 'shape')) this.undo();
        this.drag = null;
        this.pinching = true;
        pinch = { ...pinchState(), zoom: this.zoom };
        e.stopPropagation();
      } else if (touches.size > 2) e.stopPropagation();
    }, true);
    stage.addEventListener('pointermove', (e) => {
      if (!touches.has(e.pointerId)) return;
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!this.pinching || !pinch || touches.size < 2) return;
      e.stopPropagation();
      const now = pinchState();
      updateZoom(pinch.zoom * (now.dist / pinch.dist));
      stage.scrollLeft -= now.mx - pinch.mx;
      stage.scrollTop -= now.my - pinch.my;
      pinch.mx = now.mx; pinch.my = now.my;
      this.positionCropBox(); this.positionSelBox();
    }, true);
    const endTouch = (e: PointerEvent): void => {
      if (!touches.delete(e.pointerId)) return;
      if (touches.size < 2) { pinch = null; if (this.pinching) { e.stopPropagation(); setTimeout(() => { this.pinching = false; }, 60); } }
    };
    stage.addEventListener('pointerup', endTouch, true);
    stage.addEventListener('pointercancel', endTouch, true);
    stage.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      updateZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    this.buildToolbar();
    this.rebuildPanel();
    document.addEventListener('keydown', this.onCropKey);
    document.addEventListener('keydown', this.onShortcut);
    document.addEventListener('keyup', this.onShortcutUp);
  }

  /** The tool strip, so the host can mount it in its own header bar. */
  toolbarElement(): HTMLElement { return this.toolbar; }

  // null = side panel hidden (click the active tab again to collapse it).
  private activePanel: 'adjust' | 'filters' | 'transform' | 'reshape' | 'draw' | 'text' | 'shapes' | 'layers' | 'bg' | 'select' | 'history' | 'export' | null = 'adjust';

  private buildToolbar(): void {
    this.toolbar.innerHTML = '';
    const tool = (label: string, name: Tool): void => {
      const b = button(label, 'img-tool');
      b.dataset.tool = name;
      b.onclick = (): void => {
        // Clicking the active tool again drops back to Select and hides its panel.
        if (this.tool === name && name !== 'select') { this.activePanel = null; this.setTool('select'); return; }
        this.setTool(name);
      };
      this.toolbar.appendChild(b);
    };
    tool('Select', 'select');
    tool('Crop', 'crop');
    tool('Brush', 'brush');
    tool('Eraser', 'eraser');
    tool('Text', 'text');
    tool('Rect', 'rect');
    tool('Ellipse', 'ellipse');
    tool('Arrow', 'arrow');
    tool('Wand', 'wand');
    tool('Lasso', 'lasso');

    this.toolbar.appendChild(el('div', 'img-sep'));

    const panelBtn = (label: string, panel: NonNullable<typeof this.activePanel>): void => {
      const b = button(label, 'img-tool');
      b.dataset.panel = panel;
      b.onclick = (): void => {
        if (this.activePanel === panel) {
          // Toggle off: collapse the side panel for a bigger canvas.
          if (panel === 'reshape') { this.crop = null; this.cropAspect = null; this.tool = 'select'; this.endCrop(); }
          this.activePanel = null;
          this.rebuildPanel(); this.syncToolbar();
          return;
        }
        this.activePanel = panel;
        if (panel === 'reshape') this.startReshape();
        this.rebuildPanel(); this.syncToolbar();
      };
      this.toolbar.appendChild(b);
    };
    panelBtn('Adjust', 'adjust');
    panelBtn('Filters', 'filters');
    panelBtn('Transform', 'transform');
    panelBtn('Reshape', 'reshape');
    panelBtn('Layers', 'layers');
    panelBtn('History', 'history');
    panelBtn('Remove BG', 'bg');

    this.toolbar.appendChild(el('div', 'img-spacer'));

    const cmp = button('Hold: Before', 'img-tool');
    cmp.title = 'Hold to compare with the original (shortcut: \\)';
    cmp.dataset.act = 'compare';
    const setCmp = (on: boolean): void => this.setComparing(on);
    cmp.addEventListener('pointerdown', (e) => { e.preventDefault(); setCmp(true); });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) cmp.addEventListener(ev, () => setCmp(false));
    const exportBtn = button('Export', 'img-tool');
    exportBtn.dataset.panel = 'export';
    exportBtn.onclick = (): void => { this.activePanel = this.activePanel === 'export' ? null : 'export'; this.rebuildPanel(); this.syncToolbar(); };
    const undoBtn = button('↶ Undo', 'img-tool');
    undoBtn.dataset.act = 'undo';
    undoBtn.onclick = (): void => this.undo();
    const redoBtn = button('↷ Redo', 'img-tool');
    redoBtn.dataset.act = 'redo';
    redoBtn.onclick = (): void => this.redo();
    const resetBtn = button('Reset', 'img-tool');
    resetBtn.onclick = (): void => this.resetAll();
    this.toolbar.append(cmp, undoBtn, redoBtn, resetBtn, exportBtn);

    this.syncToolbar();
  }

  private syncToolbar(): void {
    this.toolbar.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool));
    });
    this.toolbar.querySelectorAll<HTMLButtonElement>('[data-panel]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.panel === this.activePanel));
    });
    const undoBtn = this.toolbar.querySelector<HTMLButtonElement>('[data-act="undo"]');
    const redoBtn = this.toolbar.querySelector<HTMLButtonElement>('[data-act="redo"]');
    if (undoBtn) undoBtn.disabled = this.undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = this.redoStack.length === 0;
  }

  private setTool(t: Tool): void {
    this.tool = t;
    if (t === 'crop') this.startCrop();
    else this.endCrop();
    if (t === 'brush' || t === 'eraser') this.activePanel = 'draw';
    else if (t === 'text') this.activePanel = 'text';
    else if (t === 'rect' || t === 'ellipse' || t === 'arrow') this.activePanel = 'shapes';
    else if (t === 'wand' || t === 'lasso') this.activePanel = 'select';
    this.rebuildPanel();
    this.syncToolbar();
  }

  // ---- Crop overlay ----

  private startCrop(): void {
    const b = this.state.base;
    const m = Math.min(b.width, b.height) * 0.15;
    this.crop = { x: m, y: m, w: b.width - m * 2, h: b.height - m * 2 };
    if (!this.cropBox) {
      this.cropBox = el('div', 'img-crop');
      (['nw', 'ne', 'sw', 'se'] as const).forEach((corner) => {
        const hnd = el('div', `img-crop-handle ${corner}`);
        hnd.addEventListener('pointerdown', (e) => this.cropHandleDown(e, corner));
        this.cropBox!.appendChild(hnd);
      });
      this.cropBox.addEventListener('pointerdown', (e) => this.cropBodyDown(e));
      this.cropBox.addEventListener('dblclick', () => this.confirmCrop());
      // Apply / Cancel right under the box (Enter / Esc also work).
      const bar = el('div', 'img-crop-actions');
      const cancel = button('✕ Cancel', 'img-btn');
      cancel.onclick = (): void => this.cancelCrop();
      const ok = button('✓ Apply', 'img-btn primary');
      ok.onclick = (): void => this.confirmCrop();
      bar.append(cancel, ok);
      bar.addEventListener('pointerdown', (e) => e.stopPropagation());
      this.cropBox.appendChild(bar);
      this.wrap.appendChild(this.cropBox);
    }
    this.cropBox.style.display = 'block';
    this.positionCropBox();
  }

  // Reshape reuses the crop box, so "apply" means applying the reshape there.
  private confirmCrop(): void {
    if (this.activePanel === 'reshape') this.applyReshape();
    else this.applyCrop();
  }

  private cancelCrop(): void {
    this.crop = null;
    this.cropAspect = null;
    if (this.activePanel === 'reshape') this.activePanel = null;
    this.setTool('select');
  }

  private onCropKey = (e: KeyboardEvent): void => {
    if (this.tool !== 'crop' || !this.crop || !this.cropBox || this.cropBox.style.display === 'none') return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (e.key === 'Enter') { e.preventDefault(); this.confirmCrop(); }
    else if (e.key === 'Escape') { e.preventDefault(); this.cancelCrop(); }
  };

  // Web shortcuts (undo/redo/copy/paste are handled app-wide via commands()).
  private onShortcut = (e: KeyboardEvent): void => {
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (!this.container.isConnected || e.repeat && e.key !== '[' && e.key !== ']') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); this.activePanel = 'export'; this.rebuildPanel(); this.syncToolbar(); return; }
    if (mod && e.key === '0') { e.preventDefault(); this.setZoom(100); return; }
    if (mod || e.altKey) return;
    const tools: Record<string, Tool> = { v: 'select', c: 'crop', b: 'brush', e: 'eraser', t: 'text', r: 'rect', o: 'ellipse', a: 'arrow', w: 'wand', l: 'lasso' };
    const k = e.key.toLowerCase();
    if (k === '\\') { e.preventDefault(); this.setComparing(true); }
    else if (tools[k] && this.tool !== 'crop') { e.preventDefault(); this.setTool(tools[k]!); }
    else if (k === '[' || k === ']') { this.brushSize = Math.max(1, Math.min(200, this.brushSize + (k === ']' ? 2 : -2) * Math.max(1, Math.round(this.brushSize / 12)))); if (this.activePanel === 'draw' || this.activePanel === 'shapes') this.rebuildPanel(); }
    else if (k === '+' || k === '=') this.setZoom(this.zoom + 10);
    else if (k === '-') this.setZoom(this.zoom - 10);
    else if (k === 'h') { this.activePanel = this.activePanel === 'history' ? null : 'history'; this.rebuildPanel(); this.syncToolbar(); }
  };
  private onShortcutUp = (e: KeyboardEvent): void => { if (e.key === '\\') this.setComparing(false); };

  private endCrop(): void {
    if (this.cropBox) this.cropBox.style.display = 'none';
  }

  private positionCropBox(): void {
    if (!this.cropBox || !this.crop || this.cropBox.style.display === 'none') return;
    const r = this.canvas.getBoundingClientRect();
    const wr = this.wrap.getBoundingClientRect();
    const sx = r.width / this.canvas.width, sy = r.height / this.canvas.height;
    this.cropBox.style.left = `${(r.left - wr.left) + this.crop.x * sx}px`;
    this.cropBox.style.top = `${(r.top - wr.top) + this.crop.y * sy}px`;
    this.cropBox.style.width = `${this.crop.w * sx}px`;
    this.cropBox.style.height = `${this.crop.h * sy}px`;
  }

  private cropBodyDown(e: PointerEvent): void {
    if (e.target !== this.cropBox || !this.crop) return;
    e.stopPropagation();
    const start = this.toImage(e);
    const orig = { ...this.crop };
    const move = (ev: PointerEvent): void => {
      const p = this.toImage(ev);
      this.crop = { ...orig, x: orig.x + (p.x - start.x), y: orig.y + (p.y - start.y) };
      this.clampCrop();
      this.positionCropBox();
    };
    const up = (): void => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  private cropHandleDown(e: PointerEvent, corner: 'nw' | 'ne' | 'sw' | 'se'): void {
    e.stopPropagation();
    if (!this.crop) return;
    const start = this.toImage(e);
    const orig = { ...this.crop };
    const move = (ev: PointerEvent): void => {
      const p = this.toImage(ev);
      let { x, y, w, h } = orig;
      const dx = p.x - start.x, dy = p.y - start.y;
      if (corner.includes('w')) { x = orig.x + dx; w = orig.w - dx; }
      if (corner.includes('e')) { w = orig.w + dx; }
      if (corner.includes('n')) { y = orig.y + dy; h = orig.h - dy; }
      if (corner.includes('s')) { h = orig.h + dy; }
      if (this.cropAspect) h = w / this.cropAspect;
      this.crop = { x, y, w: Math.max(16, w), h: Math.max(16, h) };
      this.clampCrop();
      this.positionCropBox();
    };
    const up = (): void => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  private clampCrop(): void {
    if (!this.crop) return;
    const b = this.state.base;
    if (this.cropAspect) {
      // Shrink uniformly so a locked aspect survives clamping.
      const k = Math.min(1, b.width / this.crop.w, b.height / this.crop.h);
      this.crop.w *= k; this.crop.h *= k;
    }
    this.crop.w = Math.min(this.crop.w, b.width);
    this.crop.h = Math.min(this.crop.h, b.height);
    this.crop.x = Math.max(0, Math.min(this.crop.x, b.width - this.crop.w));
    this.crop.y = Math.max(0, Math.min(this.crop.y, b.height - this.crop.h));
  }

  // ---- Selection box for overlays ----

  private positionSelBox(): void {
    const sel = this.selected();
    if (!sel || this.tool !== 'select' || this.isGroup()) { if (this.selBox) this.selBox.style.display = 'none'; return; }
    if (!this.selBox) {
      this.selBox = el('div', 'img-sel');
      const hnd = el('div', 'img-sel-handle');
      hnd.addEventListener('pointerdown', (e) => this.selHandleDown(e));
      this.selBox.appendChild(hnd);
      this.wrap.appendChild(this.selBox);
    }
    const b = this.bbox(sel);
    const r = this.canvas.getBoundingClientRect();
    const wr = this.wrap.getBoundingClientRect();
    const sx = r.width / this.canvas.width, sy = r.height / this.canvas.height;
    this.selBox.style.display = 'block';
    this.selBox.style.left = `${(r.left - wr.left) + b.x * sx}px`;
    this.selBox.style.top = `${(r.top - wr.top) + b.y * sy}px`;
    this.selBox.style.width = `${b.w * sx}px`;
    this.selBox.style.height = `${b.h * sy}px`;
  }

  private selHandleDown(e: PointerEvent): void {
    e.stopPropagation();
    const cur = this.selected();
    if (!cur) return;
    this.commit();
    const start = this.toImage(e);
    const orig = cloneLayer(cur);
    const move = (ev: PointerEvent): void => {
      const p = this.toImage(ev);
      this.resizeLayer(cur, orig, p.x - start.x, p.y - start.y);
      this.render();
    };
    const up = (): void => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); this.onChange?.(); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  // ---- Side panels ----

  private rebuildPanel(): void {
    const host = this.panelHost;
    host.innerHTML = '';
    host.hidden = this.activePanel === null;
    switch (this.activePanel) {
      case 'adjust': this.buildAdjustPanel(host); break;
      case 'filters': this.buildFiltersPanel(host); break;
      case 'transform': this.buildTransformPanel(host); break;
      case 'reshape': this.buildReshapePanel(host); break;
      case 'draw': this.buildDrawPanel(host); break;
      case 'text': this.buildTextPanel(host); break;
      case 'shapes': this.buildShapesPanel(host); break;
      case 'layers': this.buildLayersPanel(host); break;
      case 'bg': this.buildBgPanel(host); break;
      case 'select': this.buildSelectPanel(host); break;
      case 'history': this.buildHistoryPanel(host); break;
      case 'export': this.buildExportPanel(host); break;
    }
    this.positionSelBox();
    this.syncCropShape();
  }

  // Circle/rounded preview on the crop box while the Reshape panel is open.
  private syncCropShape(): void {
    if (!this.cropBox) return;
    const on = this.activePanel === 'reshape' && this.reshape.mode === 'fill';
    this.cropBox.classList.toggle('round', on && this.reshape.shape === 'circle');
    this.cropBox.classList.toggle('rounded', on && this.reshape.shape === 'rounded');
  }

  private slider(host: HTMLElement, label: string, key: keyof Adjustments, min: number, max: number, step = 1): void {
    const neutral = neutralAdjustments()[key];
    const field = el('div', 'img-field');
    const lab = document.createElement('label');
    const val = document.createElement('span');
    const showVal = (v: number): void => { val.textContent = String(v); val.classList.toggle('changed', v !== neutral); };
    showVal(this.state.adjustments[key]);
    lab.append(document.createTextNode(label), val);
    lab.title = 'Double-click to reset';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(this.state.adjustments[key]);
    let armed = true; // snapshot once per drag, BEFORE the first change, so undo works
    const set = (v: number): void => {
      if (armed) { this.commit(label); armed = false; }
      this.state.adjustments[key] = v;
      input.value = String(v);
      showVal(v);
      this.renderSoon();
    };
    input.oninput = (): void => set(Number(input.value));
    input.onchange = (): void => { armed = true; };
    lab.ondblclick = (): void => { if (this.state.adjustments[key] !== neutral) { armed = true; set(neutral); armed = true; } };
    field.append(lab, input);
    host.appendChild(field);
  }

  // Coalesce slider-driven renders to one per frame (full-res composites are heavy).
  private renderSoon(): void {
    if (this.renderRaf) return;
    this.renderRaf = requestAnimationFrame(() => { this.renderRaf = 0; this.render(); });
  }

  private setComparing(on: boolean): void {
    if (this.comparing === on || !this.canvas) return;
    this.comparing = on;
    this.render();
    this.canvas.classList.toggle('img-comparing', on);
  }

  private group(host: HTMLElement, name: string): void {
    const g = el('div', 'img-group');
    g.textContent = name;
    host.appendChild(g);
  }

  private buildAdjustPanel(host: HTMLElement): void {
    host.appendChild(title('Adjustments'));
    this.histCanvas = document.createElement('canvas');
    this.histCanvas.className = 'img-hist';
    this.histCanvas.width = 256; this.histCanvas.height = 64;
    host.appendChild(this.histCanvas);
    this.group(host, 'Light');
    this.slider(host, 'Exposure', 'exposure', -100, 100);
    this.slider(host, 'Brightness', 'brightness', 0, 200);
    this.slider(host, 'Contrast', 'contrast', 0, 200);
    this.slider(host, 'Highlights', 'highlights', -100, 100);
    this.slider(host, 'Shadows', 'shadows', -100, 100);
    this.slider(host, 'Black point', 'blackPoint', 0, 100);
    this.slider(host, 'White point', 'whitePoint', 0, 100);
    this.group(host, 'Color');
    this.slider(host, 'Temperature', 'temperature', -100, 100);
    this.slider(host, 'Tint', 'tint', -100, 100);
    this.slider(host, 'Vibrance', 'vibrance', -100, 100);
    this.slider(host, 'Saturation', 'saturation', 0, 200);
    this.slider(host, 'Hue', 'hue', -180, 180);
    this.group(host, 'Detail & effects');
    this.slider(host, 'Sharpness', 'sharpness', 0, 100);
    this.slider(host, 'Blur', 'blur', 0, 20);
    this.slider(host, 'Vignette', 'vignette', 0, 100);
    this.slider(host, 'Grain', 'grain', 0, 100);
    this.slider(host, 'Fade', 'fade', 0, 100);
    const row = el('div', 'img-row');
    const reset = button('Reset adjustments', 'img-btn');
    reset.onclick = (): void => { this.commit('Reset adjustments'); this.state.adjustments = neutralAdjustments(); this.render(); this.rebuildPanel(); };
    row.appendChild(reset);
    host.appendChild(row);
    host.appendChild(note('Hold "Hold: Before" (or the \\ key) to compare with the original.'));
    // Panel is attached by rebuildPanel's caller; draw once it is in the DOM.
    queueMicrotask(() => this.drawHistogram());
  }

  // Luma + RGB histogram of the current result, from a small downsample.
  private drawHistogram(): void {
    const hc = this.histCanvas;
    if (!hc || !hc.isConnected || !this.canvas) return;
    const s = computeResize(this.canvas.width, this.canvas.height, 200);
    const t = document.createElement('canvas');
    t.width = s.w; t.height = s.h;
    const tc = t.getContext('2d')!;
    tc.drawImage(this.canvas, 0, 0, s.w, s.h);
    const h = computeHistogram(tc.getImageData(0, 0, s.w, s.h).data);
    const c = hc.getContext('2d')!;
    c.clearRect(0, 0, 256, 64);
    const plot = (bins: number[], color: string): void => {
      c.fillStyle = color;
      for (let i = 0; i < 256; i++) c.fillRect(i, 64 - Math.min(1, bins[i]! / h.max) * 62, 1, 64);
    };
    c.globalCompositeOperation = 'lighter';
    plot(h.r, 'rgba(255,60,60,0.55)'); plot(h.g, 'rgba(60,220,60,0.55)'); plot(h.b, 'rgba(70,110,255,0.55)');
    c.globalCompositeOperation = 'source-over';
    plot(h.luma, 'rgba(200,200,200,0.35)');
  }

  private buildHistoryPanel(host: HTMLElement): void {
    host.appendChild(title('History'));
    const list = el('ol', 'img-history');
    const mk = (text: string, cls: string, jump: () => void): void => {
      const li = el('li', `img-hist-item ${cls}`);
      li.textContent = text; li.tabIndex = 0;
      li.onclick = jump;
      li.onkeydown = (e): void => { if (e.key === 'Enter') jump(); };
      list.appendChild(li);
    };
    const n = this.labels.length;
    this.labels.forEach((lab, i) => mk(`${i + 1}. ${lab}`, 'past', () => { for (let k = n - i; k > 0; k--) this.undo(); }));
    mk('Current', 'current', () => undefined);
    for (let i = this.redoLabels.length - 1, step = 1; i >= 0; i--, step++) {
      const steps = step;
      mk(`${n + step + 1}. ${this.redoLabels[i]}`, 'future', () => { for (let k = 0; k < steps; k++) this.redo(); });
    }
    host.appendChild(list);
    host.appendChild(note('Click a step to jump back or forward. Up to 40 steps are kept.'));
  }

  private estimateTimer = 0;
  private buildExportPanel(host: HTMLElement): void {
    host.appendChild(title('Export'));
    const o = this.exportOpts;
    const row = (label: string, child: HTMLElement): void => {
      const f = el('div', 'img-field'); const l = document.createElement('label'); l.textContent = label;
      f.append(l, child); host.appendChild(f);
    };
    const fmt = document.createElement('select'); fmt.className = 'img-input wide';
    for (const [v, n] of [['image/png', 'PNG (lossless)'], ['image/jpeg', 'JPEG'], ['image/webp', 'WebP']] as const) {
      const op = document.createElement('option'); op.value = v; op.textContent = n; if (o.format === v) op.selected = true; fmt.appendChild(op);
    }
    row('Format', fmt);
    const q = document.createElement('input'); q.type = 'range'; q.min = '40'; q.max = '100'; q.value = String(Math.round(o.quality * 100));
    const qv = el('div', 'img-note');
    row('Quality', q); host.appendChild(qv);
    const sz = document.createElement('select'); sz.className = 'img-input wide';
    for (const [v, n] of [[0, 'Original size'], [3840, '3840 px (4K)'], [2048, '2048 px'], [1280, '1280 px'], [1080, '1080 px'], [640, '640 px']] as const) {
      const op = document.createElement('option'); op.value = String(v); op.textContent = n; if (o.maxDim === v) op.selected = true; sz.appendChild(op);
    }
    row('Longest side', sz);
    const info = el('div', 'img-note');
    host.appendChild(info);
    const refresh = (): void => {
      o.format = fmt.value as ExportOptions['format'];
      o.quality = Number(q.value) / 100;
      o.maxDim = Number(sz.value);
      qv.textContent = o.format === 'image/png' ? 'Quality: lossless' : `Quality ${q.value}%`;
      q.disabled = o.format === 'image/png';
      const d = exportSize(this.state.base.width, this.state.base.height, o.maxDim);
      info.textContent = `${d.w} × ${d.h} px · estimating size…`;
      clearTimeout(this.estimateTimer);
      this.estimateTimer = window.setTimeout(async () => {
        const r = await this.renderExport(o);
        if (info.isConnected) info.textContent = r ? `${d.w} × ${d.h} px · about ${formatBytes(r.size)}` : `${d.w} × ${d.h} px`;
      }, 250);
    };
    fmt.onchange = refresh; q.oninput = refresh; sz.onchange = refresh;
    refresh();
    const dl = button('Download copy', 'img-btn primary');
    dl.onclick = async (): Promise<void> => {
      const r = await this.renderExport(o);
      if (!r) return;
      const ext = o.format === 'image/jpeg' ? 'jpg' : o.format === 'image/webp' ? 'webp' : 'png';
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r); a.download = `image.${ext}`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    };
    const r2 = el('div', 'img-row'); r2.appendChild(dl);
    host.appendChild(r2);
    host.appendChild(note('Your document auto-saves in its original format; this makes a separate copy.'));
  }

  // Flatten + resize + encode with explicit options.
  private async renderExport(o: ExportOptions): Promise<Blob | null> {
    const flat = document.createElement('canvas');
    const was = this.comparing; this.comparing = false;
    this.composite(flat);
    this.comparing = was;
    const d = exportSize(flat.width, flat.height, o.maxDim);
    const out = document.createElement('canvas');
    out.width = d.w; out.height = d.h;
    const c = out.getContext('2d')!;
    c.imageSmoothingQuality = 'high';
    if (o.format === 'image/jpeg') { c.fillStyle = '#fff'; c.fillRect(0, 0, d.w, d.h); }
    c.drawImage(flat, 0, 0, d.w, d.h);
    return new Promise<Blob | null>((res) => out.toBlob(res, o.format, o.format === 'image/png' ? undefined : o.quality));
  }

  private buildFiltersPanel(host: HTMLElement): void {
    host.appendChild(title('Filter presets'));
    const grid = el('div', 'img-presets');
    // Downscaled thumbnail source of the current base.
    const thumbSrc = document.createElement('canvas');
    const ts = computeResize(this.state.base.width, this.state.base.height, 120);
    thumbSrc.width = ts.w; thumbSrc.height = ts.h;
    thumbSrc.getContext('2d')!.drawImage(this.state.base, 0, 0, ts.w, ts.h);

    for (const preset of PRESETS) {
      const cell = el('button', 'img-preset') as HTMLButtonElement;
      const c = document.createElement('canvas');
      c.width = ts.w; c.height = ts.h;
      const cx = c.getContext('2d')!;
      const a = { ...neutralAdjustments(), ...preset.adj };
      this.paintBase(cx, thumbSrc, a);
      const cap = document.createElement('span');
      cap.textContent = preset.name;
      cell.append(c, cap);
      cell.onclick = (): void => {
        this.commit(`Filter: ${preset.name}`);
        this.state.adjustments = { ...neutralAdjustments(), ...preset.adj };
        this.render();
        this.rebuildPanel();
      };
      grid.appendChild(cell);
    }
    host.appendChild(grid);
  }

  private buildTransformPanel(host: HTMLElement): void {
    host.appendChild(title('Transform'));
    const rot = el('div', 'img-row');
    const mk = (l: string, fn: () => void): HTMLButtonElement => { const b = button(l, 'img-btn'); b.onclick = fn; return b; };
    rot.append(
      mk('Rotate 90°', () => this.rotate90(90)),
      mk('Rotate 180°', () => this.rotate90(180)),
      mk('Rotate 270°', () => this.rotate90(270)),
    );
    host.appendChild(rot);

    const flipRow = el('div', 'img-row');
    flipRow.append(mk('Flip H', () => this.flip('h')), mk('Flip V', () => this.flip('v')));
    host.appendChild(flipRow);

    // Free-angle rotation (applied on release).
    const field = el('div', 'img-field');
    const lab = document.createElement('label');
    const val = document.createElement('span');
    val.textContent = '0°';
    lab.append(document.createTextNode('Free angle'), val);
    const range = document.createElement('input');
    range.type = 'range'; range.min = '-45'; range.max = '45'; range.value = '0';
    range.oninput = (): void => { val.textContent = `${range.value}°`; };
    range.onchange = (): void => { const a = Number(range.value); if (a !== 0) { this.rotateFree(a); range.value = '0'; val.textContent = '0°'; } };
    field.append(lab, range);
    host.appendChild(field);

    // Crop aspect presets.
    host.appendChild(title('Crop aspect'));
    const chips = el('div', 'img-chips');
    const aspects: { label: string; v: number | null }[] = [
      { label: 'Free', v: null }, { label: '1:1', v: 1 }, { label: '4:3', v: 4 / 3 }, { label: '16:9', v: 16 / 9 },
    ];
    for (const asp of aspects) {
      const chip = button(asp.label, 'img-chip');
      chip.setAttribute('aria-pressed', String(this.cropAspect === asp.v));
      chip.onclick = (): void => {
        this.cropAspect = asp.v;
        this.setTool('crop');
        if (this.crop && asp.v) { this.crop.h = this.crop.w / asp.v; this.clampCrop(); this.positionCropBox(); }
        this.rebuildPanel();
      };
      chips.appendChild(chip);
    }
    host.appendChild(chips);
    const applyRow = el('div', 'img-row');
    const apply = button('Apply crop', 'img-btn primary');
    apply.onclick = (): void => this.applyCrop();
    applyRow.appendChild(apply);
    host.appendChild(applyRow);

    // Resize.
    host.appendChild(title('Resize'));
    const rr = el('div', 'img-row');
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'img-input wide';
    input.value = String(Math.max(this.state.base.width, this.state.base.height));
    input.placeholder = 'Max dimension';
    const go = button('Resize', 'img-btn');
    go.onclick = (): void => { const v = Number(input.value); if (v > 0) this.resizeBase(v); };
    rr.append(input, go);
    host.appendChild(rr);
    host.appendChild(note(`Current: ${this.state.base.width} × ${this.state.base.height}px`));
  }

  // ---- Reshape (profile pic / ratio) ----

  // Lock the crop box to the reshape aspect and auto-center the largest fit.
  private startReshape(): void {
    const r = this.reshape;
    if (r.mode === 'fit') { this.tool = 'select'; this.endCrop(); this.crop = null; return; }
    this.cropAspect = r.aspect;
    this.tool = 'crop';
    this.startCrop();
    const b = this.state.base;
    this.crop = fitAspect(b.width, b.height, r.aspect);
    this.positionCropBox();
  }

  private applyReshape(): void {
    const r = this.reshape;
    const flat = document.createElement('canvas');
    this.composite(flat);
    const src = r.mode === 'fill'
      ? (this.crop ?? fitAspect(flat.width, flat.height, r.aspect))
      : null;
    // Natural size: the crop itself (fill) or the image padded out to the aspect (fit).
    const natural = src ?? (flat.width / flat.height > r.aspect
      ? { w: flat.width, h: flat.width / r.aspect }
      : { w: flat.height * r.aspect, h: flat.height });
    const { w, h } = reshapeSize(natural.w, natural.h, r.aspect, r.size);
    const out = document.createElement('canvas');
    out.width = w; out.height = h;
    const c = out.getContext('2d')!;
    c.imageSmoothingQuality = 'high';
    if (src) {
      c.drawImage(flat, src.x, src.y, src.w, src.h, 0, 0, w, h);
    } else {
      if (r.bg === 'color') { c.fillStyle = r.bgColor; c.fillRect(0, 0, w, h); }
      else if (r.bg === 'blur') {
        const cover = Math.max(w / flat.width, h / flat.height);
        c.filter = `blur(${Math.round(Math.max(w, h) / 40)}px) brightness(85%)`;
        c.drawImage(flat, (w - flat.width * cover) / 2, (h - flat.height * cover) / 2, flat.width * cover, flat.height * cover);
        c.filter = 'none';
      }
      const contain = Math.min(w / flat.width, h / flat.height);
      const dw = flat.width * contain, dh = flat.height * contain;
      c.drawImage(flat, (w - dw) / 2, (h - dh) / 2, dw, dh);
    }
    if (r.shape !== 'square') {
      // Mask to the shape; outside pixels become transparent.
      c.globalCompositeOperation = 'destination-in';
      c.beginPath();
      if (r.shape === 'circle') c.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      else c.roundRect(0, 0, w, h, Math.min(w, h) * 0.18);
      c.fill();
      c.globalCompositeOperation = 'source-over';
    }
    const transparent = r.shape !== 'square' || (!src && r.bg === 'transparent');
    this.commit();
    if (transparent) this.contentType = 'image/png';
    this.state.adjustments = neutralAdjustments();
    this.state.layers = [];
    this.crop = null;
    this.endCrop();
    this.tool = 'select';
    this.activePanel = 'transform';
    this.replaceBase(out);
    this.rebuildPanel();
    this.syncToolbar();
    this.onChange?.();
  }

  private buildReshapePanel(host: HTMLElement): void {
    const r = this.reshape;
    const refresh = (): void => { this.startReshape(); this.rebuildPanel(); this.syncToolbar(); };
    const chipRow = <T,>(items: { label: string; v: T }[], cur: T, set: (v: T) => void): HTMLElement => {
      const chips = el('div', 'img-chips');
      for (const it of items) {
        const chip = button(it.label, 'img-chip');
        chip.setAttribute('aria-pressed', String(cur === it.v));
        chip.onclick = (): void => { set(it.v); refresh(); };
        chips.appendChild(chip);
      }
      return chips;
    };

    host.appendChild(title('Quick presets'));
    const presets = el('div', 'img-chips');
    for (const p of RESHAPE_PRESETS) {
      const chip = button(p.label, 'img-chip');
      chip.onclick = (): void => { Object.assign(r, { shape: p.shape, aspect: p.aspect, size: p.size, mode: 'fill' }); refresh(); };
      presets.appendChild(chip);
    }
    host.appendChild(presets);

    host.appendChild(title('Shape'));
    host.appendChild(chipRow<ReshapeShape>(
      [{ label: '● Circle', v: 'circle' }, { label: '▢ Rounded', v: 'rounded' }, { label: '■ Square / rect', v: 'square' }],
      r.shape, (v) => { r.shape = v; if (v === 'circle') r.aspect = 1; }));

    host.appendChild(title('Ratio'));
    host.appendChild(chipRow(RESHAPE_RATIOS, r.aspect, (v) => {
      r.aspect = v;
      if (r.shape === 'circle' && v !== 1) r.shape = 'square';
    }));

    host.appendChild(title('Output size (long side)'));
    const sizes = chipRow([{ label: 'Keep', v: 0 }, { label: '256', v: 256 }, { label: '400', v: 400 },
      { label: '640', v: 640 }, { label: '1080', v: 1080 }, { label: '2048', v: 2048 }], r.size, (v) => { r.size = v; });
    host.appendChild(sizes);
    const custom = el('div', 'img-row');
    const input = document.createElement('input');
    input.type = 'number'; input.min = '16'; input.max = '8192';
    input.className = 'img-input wide'; input.placeholder = 'Custom px';
    if (r.size) input.value = String(r.size);
    input.onchange = (): void => { const v = Math.round(Number(input.value)); if (v >= 16) { r.size = Math.min(v, 8192); refresh(); } };
    custom.appendChild(input);
    host.appendChild(custom);

    host.appendChild(title('Fit'));
    host.appendChild(chipRow<'fill' | 'fit'>([{ label: 'Crop to fill', v: 'fill' }, { label: 'Fit whole image', v: 'fit' }],
      r.mode, (v) => { r.mode = v; }));
    if (r.mode === 'fit') {
      host.appendChild(chipRow<'transparent' | 'color' | 'blur'>(
        [{ label: 'Transparent', v: 'transparent' }, { label: 'Blur', v: 'blur' }, { label: 'Color', v: 'color' }],
        r.bg, (v) => { r.bg = v; }));
      if (r.bg === 'color') {
        const row = el('div', 'img-row');
        const sw = document.createElement('input');
        sw.type = 'color'; sw.value = r.bgColor;
        sw.oninput = (): void => { r.bgColor = sw.value; };
        row.append(document.createTextNode('Background '), sw);
        host.appendChild(row);
      }
    }

    const out = (() => {
      const b = this.state.base;
      const nat = r.mode === 'fill' && this.crop ? this.crop : fitAspect(b.width, b.height, r.aspect);
      return reshapeSize(nat.w, nat.h, r.aspect, r.size);
    })();
    host.appendChild(note(r.mode === 'fill'
      ? `Drag the box to choose what stays. Output: ${out.w} × ${out.h}px${r.shape !== 'square' ? ' (transparent PNG)' : ''}`
      : `Whole image fitted into ${out.w} × ${out.h}px`));
    const row = el('div', 'img-row');
    const auto = button('Auto center', 'img-btn');
    auto.onclick = refresh;
    const apply = button('Apply', 'img-btn primary');
    apply.onclick = (): void => this.applyReshape();
    row.append(auto, apply);
    host.appendChild(row);
  }

  private colorRow(host: HTMLElement): void {
    const row = el('div', 'img-row');
    const swatch = document.createElement('input');
    swatch.type = 'color'; swatch.value = this.color;
    swatch.oninput = (): void => { this.color = swatch.value; const s = this.selected(); if (s && 'color' in s) { s.color = swatch.value; this.render(); this.onChange?.(); } };
    const lbl = document.createElement('span'); lbl.textContent = 'Color'; lbl.style.fontSize = '13px';
    row.append(lbl, swatch);
    host.appendChild(row);
  }

  private buildDrawPanel(host: HTMLElement): void {
    host.appendChild(title(this.tool === 'eraser' ? 'Eraser' : 'Brush'));
    if (this.tool !== 'eraser') this.colorRow(host);
    const field = el('div', 'img-field');
    const lab = document.createElement('label');
    const val = document.createElement('span'); val.textContent = String(this.brushSize);
    lab.append(document.createTextNode('Size'), val);
    const range = document.createElement('input');
    range.type = 'range'; range.min = '1'; range.max = '120'; range.value = String(this.brushSize);
    range.oninput = (): void => { this.brushSize = Number(range.value); val.textContent = range.value; };
    field.append(lab, range);
    host.appendChild(field);
    host.appendChild(note('Drag on the image to paint. Switch to Select to move strokes.'));
  }

  private buildTextPanel(host: HTMLElement): void {
    host.appendChild(title('Text'));
    this.colorRow(host);
    const sel = this.selected();
    const active = sel && sel.kind === 'text' ? sel : null;

    const field = el('div', 'img-field');
    const lab = document.createElement('label');
    const val = document.createElement('span'); val.textContent = String(active ? active.size : this.textSize);
    lab.append(document.createTextNode('Font size'), val);
    const range = document.createElement('input');
    range.type = 'range'; range.min = '8'; range.max = '240'; range.value = String(active ? active.size : this.textSize);
    range.oninput = (): void => {
      const v = Number(range.value); val.textContent = range.value;
      if (active) { active.size = v; this.render(); } else this.textSize = v;
    };
    range.onchange = (): void => { if (active) { this.onChange?.(); } };
    field.append(lab, range);
    host.appendChild(field);

    const row = el('div', 'img-row');
    const boldLbl = document.createElement('label'); boldLbl.className = 'img-check';
    const bold = document.createElement('input'); bold.type = 'checkbox'; bold.checked = active ? active.bold : this.fontBold;
    bold.onchange = (): void => { if (active) { active.bold = bold.checked; this.render(); this.onChange?.(); } else this.fontBold = bold.checked; };
    boldLbl.append(bold, document.createTextNode('Bold'));
    row.appendChild(boldLbl);
    host.appendChild(row);
    host.appendChild(note('Pick the Text tool and click the canvas to add text.'));
  }

  private buildShapesPanel(host: HTMLElement): void {
    host.appendChild(title('Shapes & stickers'));
    this.colorRow(host);
    const field = el('div', 'img-field');
    const lab = document.createElement('label');
    const val = document.createElement('span'); val.textContent = String(this.brushSize);
    lab.append(document.createTextNode('Stroke width'), val);
    const range = document.createElement('input');
    range.type = 'range'; range.min = '1'; range.max = '40'; range.value = String(this.brushSize);
    range.oninput = (): void => { this.brushSize = Number(range.value); val.textContent = range.value; };
    field.append(lab, range);
    host.appendChild(field);

    const sel = this.selected();
    if (sel && (sel.kind === 'rect' || sel.kind === 'ellipse')) {
      const row = el('div', 'img-row');
      const fillLbl = document.createElement('label'); fillLbl.className = 'img-check';
      const fill = document.createElement('input'); fill.type = 'checkbox'; fill.checked = sel.fill;
      fill.onchange = (): void => { sel.fill = fill.checked; this.render(); this.onChange?.(); };
      fillLbl.append(fill, document.createTextNode('Fill shape'));
      row.appendChild(fillLbl);
      host.appendChild(row);
    }

    host.appendChild(title('Stickers'));
    const strip = el('div', 'img-stickers');
    for (const emoji of STICKERS) {
      const b = button(emoji, 'img-sticker');
      b.onclick = (): void => {
        this.commit();
        const l: StickerLayer = { id: uid(), kind: 'sticker', x: this.state.base.width / 2 - 40, y: this.state.base.height / 2 - 40, size: 80, emoji };
        this.state.layers.push(l);
        this.selectedId = l.id;
        this.setTool('select');
        this.render();
      };
      strip.appendChild(b);
    }
    host.appendChild(strip);
    host.appendChild(note('Pick a shape tool and drag on the image.'));
  }

  private buildLayersPanel(host: HTMLElement): void {
    host.appendChild(title('Layers'));
    const row = el('div', 'img-row');
    const addImgBtn = button('Add image', 'img-btn');
    addImgBtn.onclick = (): void => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.onchange = async (): Promise<void> => {
        const f = input.files?.[0];
        if (f) await this.addImageLayer(f);
      };
      input.click();
    };
    row.appendChild(addImgBtn);
    host.appendChild(row);

    const list = el('ul', 'img-layers');
    // Top-most first for a natural stacking view.
    [...this.state.layers].reverse().forEach((l) => {
      const idx = this.state.layers.indexOf(l);
      const li = el('li', 'img-layer' + (l.id === this.selectedId ? ' sel' : ''));
      const name = el('span', 'name');
      name.textContent = this.layerName(l);
      name.onclick = (): void => { this.selectedId = l.id; this.setTool('select'); this.render(); this.rebuildPanel(); };
      const up = button('▲', ''); up.title = 'Bring forward';
      up.onclick = (): void => this.reorder(idx, +1);
      const down = button('▼', ''); down.title = 'Send backward';
      down.onclick = (): void => this.reorder(idx, -1);
      const del = button('✕', ''); del.title = 'Delete';
      del.onclick = (): void => { this.commit(); this.state.layers.splice(idx, 1); if (this.selectedId === l.id) this.selectedId = null; this.render(); this.rebuildPanel(); };
      li.append(name, up, down, del);
      list.appendChild(li);
    });
    host.appendChild(list);

    // Opacity control for selected layer
    const selected = this.selected();
    if (selected) {
      host.appendChild(title('Layer settings'));
      const field = el('div', 'img-field');
      const lab = document.createElement('label');
      const val = document.createElement('span');
      const opacity = selected.opacity ?? 1;
      val.textContent = String(Math.round(opacity * 100));
      lab.append(document.createTextNode('Opacity'), val);
      const input = document.createElement('input');
      input.type = 'range';
      input.min = '0'; input.max = '100'; input.step = '1';
      input.value = String(Math.round(opacity * 100));
      input.oninput = (): void => {
        selected.opacity = Number(input.value) / 100;
        val.textContent = input.value;
        this.render();
      };
      input.onchange = (): void => { this.commit(); };
      field.append(lab, input);
      host.appendChild(field);
    }

    if (this.state.layers.length === 0) host.appendChild(note('No overlay layers yet. Add text, shapes, brush strokes, stickers or images.'));
  }

  private layerName(l: Layer): string {
    if (l.kind === 'text') return `Text: ${l.text.slice(0, 18)}`;
    if (l.kind === 'sticker') return `Sticker ${l.emoji}`;
    if (l.kind === 'brush') return 'Brush stroke';
    if (l.kind === 'eraser') return 'Eraser stroke';
    if (l.kind === 'image') return 'Image layer';
    return l.kind[0].toUpperCase() + l.kind.slice(1);
  }

  private reorder(idx: number, dir: number): void {
    const j = idx + dir;
    if (j < 0 || j >= this.state.layers.length) return;
    this.commit();
    const [item] = this.state.layers.splice(idx, 1);
    this.state.layers.splice(j, 0, item);
    this.render();
    this.rebuildPanel();
  }

  private async addImageLayer(file: Blob): Promise<void> {
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      bitmap.close();

      this.commit();
      const bw = this.state.base.width, bh = this.state.base.height;
      const scale = Math.min(1, (bw * 0.6) / canvas.width, (bh * 0.6) / canvas.height);
      const w = canvas.width * scale, h = canvas.height * scale;
      const layer: ImageLayer = { id: uid(), kind: 'image', canvas, x: (bw - w) / 2, y: (bh - h) / 2, w, h };
      this.state.layers.push(layer);
      this.selectedId = layer.id;
      this.setTool('select');
      this.render();
      this.rebuildPanel();
    } catch (err) {
      console.error('Failed to add image layer:', err);
    }
  }

  // ---- Pixel selection (magic wand / edge-aware / lasso) ----
  // The mask lives in base-image coordinates. When an image layer is selected,
  // the selection samples and edits that layer instead of the whole composite.

  private newMask(): HTMLCanvasElement {
    const m = document.createElement('canvas');
    m.width = this.state.base.width;
    m.height = this.state.base.height;
    return m;
  }

  private targetLayer(): ImageLayer | null {
    const id = this.selTarget;
    const l = id ? this.state.layers.find((x) => x.id === id) : null;
    return l && l.kind === 'image' ? l : null;
  }

  private pickTarget(add: boolean): void {
    if (add && this.selMask) return; // keep the target of the selection being extended
    const s = this.selected();
    this.selTarget = s && s.kind === 'image' ? s.id : null;
  }

  // Pixels the selection reads from: the target layer alone, or the full composite.
  private selectionSource(): HTMLCanvasElement {
    const out = document.createElement('canvas');
    const l = this.targetLayer();
    if (!l) { this.composite(out); return out; }
    out.width = this.state.base.width;
    out.height = this.state.base.height;
    out.getContext('2d')!.drawImage(l.canvas, l.x, l.y, l.w, l.h);
    return out;
  }

  private clearSelectionState(): void {
    this.selMask = null;
    this.selTint = null;
    this.selBounds = null;
    this.antsFrames = null;
    clearInterval(this.antsTimer);
    this.antsTimer = 0;
    this.drawAnts();
  }

  private setMask(mask: HTMLCanvasElement | null): void {
    clearInterval(this.antsTimer);
    this.antsTimer = 0;
    this.selMask = mask;
    this.selTint = null;
    this.selBounds = null;
    this.antsFrames = null;
    if (mask) {
      this.buildAnts(mask);
      if (!this.selBounds) {
        this.selMask = null; // empty selection
      } else {
        const t = document.createElement('canvas');
        t.width = mask.width; t.height = mask.height;
        const c = t.getContext('2d')!;
        c.fillStyle = 'rgba(255, 59, 107, 0.35)';
        c.fillRect(0, 0, t.width, t.height);
        c.globalCompositeOperation = 'destination-in';
        c.drawImage(mask, 0, 0);
        this.selTint = t;
        this.antsTimer = window.setInterval(() => { this.antsPhase ^= 1; this.drawAnts(); }, 280);
      }
    }
    this.render();
    if (this.activePanel === 'select') this.rebuildPanel();
  }

  // Precompute two marching-ants frames (alternating black/white dashes) along
  // the mask's edge pixels; a timer flips between them on an overlay canvas.
  private buildAnts(mask: HTMLCanvasElement): void {
    const w = mask.width, h = mask.height;
    const a = mask.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
    const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && a[(y * w + x) * 4 + 3]! > 127;
    const edges: number[] = [];
    let x1 = w, y1 = h, x2 = -1, y2 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!inside(x, y)) continue;
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
        if (!inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1)) edges.push(y * w + x);
      }
    }
    if (x2 < 0) return;
    this.selBounds = { x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1 };
    const shown = this.canvas.clientWidth || w;
    const lw = Math.max(1, Math.round(w / shown));
    const dash = 4 * lw;
    const pad = lw;
    const step = Math.max(1, Math.floor(edges.length / 300000));
    const mk = (phase: number): HTMLCanvasElement => {
      const f = document.createElement('canvas');
      f.width = this.selBounds!.w + pad * 2;
      f.height = this.selBounds!.h + pad * 2;
      const c = f.getContext('2d')!;
      for (const color of [0, 1]) {
        c.fillStyle = color ? '#fff' : '#000';
        c.beginPath();
        for (let i = 0; i < edges.length; i += step) {
          const k = edges[i]!;
          const x = k % w, y = (k - x) / w;
          if (((Math.floor((x + y) / dash) & 1) ^ phase) !== color) continue;
          c.rect(x - x1 + pad - (lw >> 1), y - y1 + pad - (lw >> 1), lw, lw);
        }
        c.fill();
      }
      return f;
    };
    this.antsFrames = [mk(0), mk(1)];
  }

  private drawAnts(): void {
    const el = this.antsEl;
    if (!el) return;
    const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(cw * dpr)), H = Math.max(1, Math.round(ch * dpr));
    if (el.width !== W || el.height !== H) { el.width = W; el.height = H; }
    const c = el.getContext('2d')!;
    c.clearRect(0, 0, W, H);
    const b = this.selBounds, f = this.antsFrames?.[this.antsPhase];
    if (!b || !f) return;
    const sx = W / this.canvas.width, sy = H / this.canvas.height;
    const pad = (f.width - b.w) / 2;
    c.imageSmoothingEnabled = false;
    c.drawImage(f, (b.x - pad) * sx, (b.y - pad) * sy, f.width * sx, f.height * sy);
  }

  private mergeMask(next: HTMLCanvasElement, add: boolean): HTMLCanvasElement {
    const cur = this.selMask;
    if (!add || !cur || cur.width !== next.width || cur.height !== next.height) return next;
    next.getContext('2d')!.drawImage(cur, 0, 0);
    return next;
  }

  private maskFromBits(bits: Uint8Array, w: number, h: number): HTMLCanvasElement {
    const mask = this.newMask();
    const mctx = mask.getContext('2d')!;
    const out = mctx.createImageData(w, h);
    for (let k = 0; k < bits.length; k++) if (bits[k]) out.data[k * 4 + 3] = 255;
    mctx.putImageData(out, 0, 0);
    return mask;
  }

  // Flood fill from p. Colour mode: similar colours within tolerance. Edge mode
  // ("select subject"): Sobel edge map, flood stops at strong edges, then the
  // region is grown 1px so the boundary pixels are included.
  private magicWand(p: Point, add: boolean): void {
    this.pickTarget(add);
    const flat = this.selectionSource();
    const w = flat.width, h = flat.height;
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) return;
    const src = flat.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
    const seed = y0 * w + x0;
    const a0 = src[seed * 4 + 3]!;
    let pass: (k: number) => boolean;
    if (this.wandMode === 'edge') {
      const gray = new Float32Array(w * h);
      for (let k = 0; k < w * h; k++) {
        const j = k * 4;
        gray[k] = (src[j]! * 0.299 + src[j + 1]! * 0.587 + src[j + 2]! * 0.114) * (src[j + 3]! / 255);
      }
      const mag = new Float32Array(w * h);
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const k = y * w + x;
          const tl = gray[k - w - 1]!, t = gray[k - w]!, tr = gray[k - w + 1]!;
          const l = gray[k - 1]!, r = gray[k + 1]!;
          const bl = gray[k + w - 1]!, b = gray[k + w]!, br = gray[k + w + 1]!;
          const gx = tr + 2 * r + br - tl - 2 * l - bl;
          const gy = bl + 2 * b + br - tl - 2 * t - tr;
          mag[k] = Math.hypot(gx, gy);
        }
      }
      const thr = (101 - this.edgeSens) * 6;
      pass = (k) => mag[k]! < thr && Math.abs(src[k * 4 + 3]! - a0) < 128;
    } else {
      const r0 = src[seed * 4]!, g0 = src[seed * 4 + 1]!, b0 = src[seed * 4 + 2]!;
      const tol = this.wandTol * 2.55;
      pass = (k) => {
        const j = k * 4;
        return Math.max(Math.abs(src[j]! - r0), Math.abs(src[j + 1]! - g0), Math.abs(src[j + 2]! - b0), Math.abs(src[j + 3]! - a0)) <= tol;
      };
    }
    const bits = new Uint8Array(w * h);
    const seen = new Uint8Array(w * h);
    const stack = [seed];
    seen[seed] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      if (k !== seed && !pass(k)) continue;
      bits[k] = 1;
      const x = k % w;
      const push = (n: number): void => { if (!seen[n]) { seen[n] = 1; stack.push(n); } };
      if (x > 0) push(k - 1);
      if (x < w - 1) push(k + 1);
      if (k >= w) push(k - w);
      if (k < w * (h - 1)) push(k + w);
    }
    if (this.wandMode === 'edge') {
      const grown = bits.slice();
      for (let k = 0; k < w * h; k++) {
        if (bits[k]) continue;
        const x = k % w;
        if ((x > 0 && bits[k - 1]) || (x < w - 1 && bits[k + 1]) || (k >= w && bits[k - w]) || (k < w * (h - 1) && bits[k + w])) grown[k] = 1;
      }
      this.setMask(this.mergeMask(this.maskFromBits(grown, w, h), add));
      return;
    }
    this.setMask(this.mergeMask(this.maskFromBits(bits, w, h), add));
  }

  private finishLasso(add: boolean): void {
    const pts = this.lassoPts;
    this.lassoPts = [];
    if (pts.length < 3) { this.render(); return; }
    this.pickTarget(add);
    const mask = this.newMask();
    const c = mask.getContext('2d')!;
    c.fillStyle = '#fff';
    c.beginPath();
    pts.forEach((pt, i) => (i ? c.lineTo(pt.x, pt.y) : c.moveTo(pt.x, pt.y)));
    c.closePath();
    c.fill();
    this.setMask(this.mergeMask(mask, add));
  }

  private drawSelectionOverlay(): void {
    if (this.selMask && (this.selMask.width !== this.canvas.width || this.selMask.height !== this.canvas.height)) {
      this.clearSelectionState(); // base size changed (crop/rotate/resize/undo)
    }
    const ctx = this.ctx;
    if (this.selTint) ctx.drawImage(this.selTint, 0, 0);
    this.drawAnts();
    if (this.lassoPts.length > 1) {
      const lw = Math.max(1, this.canvas.width / 600);
      ctx.save();
      ctx.lineWidth = lw * 1.5;
      ctx.strokeStyle = '#ff3b6b';
      ctx.setLineDash([lw * 4, lw * 3]);
      ctx.beginPath();
      this.lassoPts.forEach((pt, i) => (i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y)));
      ctx.stroke();
      ctx.restore();
    }
  }

  // Selection mask with optional feathered edge.
  private effectiveMask(): HTMLCanvasElement | null {
    const m = this.selMask;
    if (!m || this.feather <= 0) return m;
    const f = this.newMask();
    const c = f.getContext('2d')!;
    c.filter = `blur(${this.feather}px)`;
    c.drawImage(m, 0, 0);
    return f;
  }

  private extractSelection(cut: boolean): void {
    const mask = this.effectiveMask();
    const layer = mask && this.selectionPiece();
    if (!mask || !layer) return;
    this.commit();
    if (cut) this.clearPixels(mask);
    const target = this.targetLayer();
    const at = target ? this.state.layers.indexOf(target) + 1 : this.state.layers.length;
    this.state.layers.splice(at, 0, layer);
    this.selectedId = layer.id;
    this.clearSelectionState();
    this.setTool('select');
    this.activePanel = 'layers';
    this.render();
    this.rebuildPanel();
    this.syncToolbar();
  }

  // Erase masked pixels from the selection target (an image layer or the base).
  private clearPixels(mask: HTMLCanvasElement): void {
    const l = this.targetLayer();
    if (l) {
      const out = document.createElement('canvas');
      out.width = l.canvas.width; out.height = l.canvas.height;
      const c = out.getContext('2d')!;
      c.drawImage(l.canvas, 0, 0);
      c.globalCompositeOperation = 'destination-out';
      // Map the layer's on-image rectangle of the mask onto the layer's own pixels.
      c.drawImage(mask, l.x, l.y, l.w, l.h, 0, 0, out.width, out.height);
      const i = this.state.layers.indexOf(l);
      this.state.layers[i] = { ...l, canvas: out }; // new object: undo snapshots keep the old canvas
      return;
    }
    const b = this.state.base;
    const out = document.createElement('canvas');
    out.width = b.width; out.height = b.height;
    const c = out.getContext('2d')!;
    c.drawImage(b, 0, 0);
    c.globalCompositeOperation = 'destination-out';
    c.drawImage(mask, 0, 0);
    this.state.base = out;
    this.contentType = 'image/png'; // transparency requires PNG
  }

  private deleteSelectionPixels(): void {
    const mask = this.effectiveMask();
    if (!mask) return;
    this.commit();
    this.clearPixels(mask);
    this.render();
    this.onChange?.();
  }

  private invertSelection(): void {
    if (!this.selMask) this.pickTarget(false);
    const inv = this.newMask();
    const c = inv.getContext('2d')!;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, inv.width, inv.height);
    if (this.selMask) {
      c.globalCompositeOperation = 'destination-out';
      c.drawImage(this.selMask, 0, 0);
    }
    this.setMask(inv);
  }

  private buildSelectPanel(host: HTMLElement): void {
    host.appendChild(title('Smart selection'));
    host.appendChild(note('Wand: click a region. Lasso: drag around an area. Shift adds to the selection. With an image layer selected, the selection works on that layer.'));
    const modeRow = el('div', 'img-chips');
    const modes: { label: string; v: 'color' | 'edge' }[] = [
      { label: 'Similar colour', v: 'color' },
      { label: 'Select subject (edge detect)', v: 'edge' },
    ];
    for (const m of modes) {
      const chip = button(m.label, 'img-chip');
      chip.setAttribute('aria-pressed', String(this.wandMode === m.v));
      chip.onclick = (): void => { this.wandMode = m.v; if (this.tool !== 'wand') this.setTool('wand'); else this.rebuildPanel(); };
      modeRow.appendChild(chip);
    }
    host.appendChild(modeRow);
    const mk = (label: string, min: number, max: number, val: number, set: (v: number) => void): void => {
      const field = el('div', 'img-field');
      const lab = document.createElement('label');
      const v = document.createElement('span'); v.textContent = String(val);
      lab.append(document.createTextNode(label), v);
      const input = document.createElement('input');
      input.type = 'range'; input.min = String(min); input.max = String(max); input.value = String(val);
      input.oninput = (): void => { set(Number(input.value)); v.textContent = input.value; };
      field.append(lab, input);
      host.appendChild(field);
    };
    if (this.wandMode === 'edge') mk('Edge sensitivity', 1, 100, this.edgeSens, (v) => { this.edgeSens = v; });
    else mk('Wand tolerance', 0, 100, this.wandTol, (v) => { this.wandTol = v; });
    mk('Feather (px)', 0, 10, this.feather, (v) => { this.feather = v; });
    const has = !!this.selMask;
    const tgt = has ? this.targetLayer() : (() => { const s = this.selected(); return s && s.kind === 'image' ? s : null; })();
    host.appendChild(note(`Working on: ${tgt ? 'selected image layer' : 'whole image'}`));
    const row1 = el('div', 'img-row');
    const ext = button('Extract to layer', 'img-btn primary'); ext.disabled = !has; ext.onclick = (): void => this.extractSelection(false);
    const cut = button('Cut to layer', 'img-btn'); cut.disabled = !has; cut.onclick = (): void => this.extractSelection(true);
    row1.append(ext, cut);
    const row2 = el('div', 'img-row');
    const del = button('Delete pixels', 'img-btn'); del.disabled = !has; del.onclick = (): void => this.deleteSelectionPixels();
    const inv = button('Invert', 'img-btn'); inv.onclick = (): void => this.invertSelection();
    const clr = button('Clear', 'img-btn'); clr.disabled = !has; clr.onclick = (): void => this.setMask(null);
    row2.append(del, inv, clr);
    host.append(row1, row2);
    if (!has) host.appendChild(note('No selection yet.'));
  }

  private buildBgPanel(host: HTMLElement): void {
    host.appendChild(title('Background removal'));
    host.appendChild(note('Removes the background client-side. The AI model (~few MB) is downloaded on first use.'));
    const row = el('div', 'img-row');
    const b = button('Remove background', 'img-btn primary');
    const noteEl = note('');
    b.onclick = (): void => { void this.removeBackground(noteEl); };
    row.appendChild(b);
    host.append(row, noteEl);
  }

  // ---- Public API ----

  // ---- Edit commands (the shell owns shortcuts + the long-press menu) ----
  // Priority: pixel selection (wand/lasso) > selected layer > whole image.

  commands(): EditCommands {
    return {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.undoStack.length > 0,
      canRedo: () => this.redoStack.length > 0,
      hasSelection: () => !!this.selMask || !!this.selected(),
      canPaste: () => true,
      delete: () => this.cmdDelete(),
      copy: () => this.cmdCopy(),
      cut: () => this.cmdCut(),
      paste: (data) => this.cmdPaste(data),
      duplicate: () => this.cmdDuplicate(),
      selectAll: () => this.cmdSelectAll(),
    };
  }

  // Deep copy with its own pixel canvas (image layers otherwise share one).
  private detachLayer<T extends Layer>(l: T): T {
    if (l.kind !== 'image') return cloneLayer(l);
    const canvas = document.createElement('canvas');
    canvas.width = l.canvas.width; canvas.height = l.canvas.height;
    canvas.getContext('2d')!.drawImage(l.canvas, 0, 0);
    return { ...l, canvas } as T;
  }

  private writePngToSystem(src: HTMLCanvasElement): void {
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
      // A promised blob keeps the write inside the user gesture (Safari).
      const blob = new Promise<Blob>((res, rej) => src.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
      void navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]).catch(() => {});
    } catch { /* best effort */ }
  }

  // The selected pixels as a new (detached) image layer, without touching state.
  private selectionPiece(): ImageLayer | null {
    const mask = this.effectiveMask();
    const sb = this.selBounds;
    if (!mask || !sb) return null;
    const pad = Math.ceil(this.feather * 2);
    const W = this.state.base.width, H = this.state.base.height;
    const x = Math.max(0, sb.x - pad), y = Math.max(0, sb.y - pad);
    const b = { x, y, w: Math.min(W, sb.x + sb.w + pad) - x, h: Math.min(H, sb.y + sb.h + pad) - y };
    const piece = document.createElement('canvas');
    piece.width = b.w; piece.height = b.h;
    const pc = piece.getContext('2d')!;
    pc.drawImage(this.selectionSource(), b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    pc.globalCompositeOperation = 'destination-in';
    pc.drawImage(mask, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
    return { id: uid(), kind: 'image', canvas: piece, x: b.x, y: b.y, w: b.w, h: b.h };
  }

  private cmdCopy(): void {
    if (this.selMask) {
      const piece = this.selectionPiece();
      if (!piece) return;
      setAppClipboard('image-layer', piece);
      this.writePngToSystem(piece.canvas);
      showClipboardFeedback('Selection copied');
      return;
    }
    if (this.isGroup()) {
      setAppClipboard('image-layer', this.selectedLayers().map((x) => this.detachLayer(x)));
      showClipboardFeedback(`${this.selectedLayers().length} layers copied`);
      return;
    }
    const l = this.selected();
    if (l) {
      setAppClipboard('image-layer', this.detachLayer(l));
      if (l.kind === 'image') this.writePngToSystem(l.canvas);
      else if (l.kind === 'text') void navigator.clipboard?.writeText(l.text).catch(() => {});
      showClipboardFeedback('Layer copied');
      return;
    }
    const flat = document.createElement('canvas');
    this.composite(flat);
    this.writePngToSystem(flat);
    showClipboardFeedback('Image copied');
  }

  private cmdDelete(): void {
    if (this.selMask) { this.deleteSelectionPixels(); return; }
    const ls = this.selectedLayers();
    if (!ls.length) return;
    this.commit();
    this.state.layers = this.state.layers.filter((l) => !ls.includes(l));
    this.selectedId = null;
    this.multi.clear();
    this.render();
    this.rebuildPanel();
  }

  private cmdCut(): void {
    if (this.selMask) {
      const piece = this.selectionPiece();
      if (!piece) return;
      setAppClipboard('image-layer', piece);
      this.writePngToSystem(piece.canvas);
      this.deleteSelectionPixels();
      this.clearSelectionState();
      this.render();
      this.rebuildPanel();
      return;
    }
    if (!this.selected()) return;
    this.cmdCopy();
    this.cmdDelete();
  }

  private insertLayerCopy(src: Layer | Layer[], offset: number): void {
    const srcs = Array.isArray(src) ? src : [src];
    if (!srcs.length) return;
    this.commit();
    this.multi.clear();
    for (const one of srcs) {
      const l = this.detachLayer(one);
      l.id = uid();
      this.moveLayer(l, one, offset, offset);
      this.state.layers.push(l);
      this.multi.add(l.id);
      this.selectedId = l.id;
    }
    if (this.multi.size < 2) this.multi.clear();
    this.clearSelectionState();
    this.setTool('select');
    this.render();
    this.rebuildPanel();
  }

  private cmdDuplicate(): void {
    if (this.selMask) { this.extractSelection(false); return; }
    const ls = this.selectedLayers();
    if (ls.length) this.insertLayerCopy(ls, Math.max(10, Math.round(this.state.base.width * 0.02)));
  }

  private async cmdPaste(data?: DataTransfer | null): Promise<void> {
    if (data) {
      const file = [...data.files].find((f) => f.type.startsWith('image/'))
        ?? [...data.items].find((it) => it.kind === 'file' && it.type.startsWith('image/'))?.getAsFile();
      if (file) { await this.addImageLayer(file); return; }
    }
    const clip = getAppClipboard<Layer | Layer[]>('image-layer');
    if (clip) { this.insertLayerCopy(clip, Math.max(10, Math.round(this.state.base.width * 0.02))); return; }
    if (data) return; // a real paste event without an image: nothing to do
    await this.pasteImage();
  }

  private cmdSelectAll(): void {
    this.pickTarget(false);
    const m = this.newMask();
    const c = m.getContext('2d')!;
    c.fillStyle = '#fff';
    c.fillRect(0, 0, m.width, m.height);
    this.setMask(m);
    this.activePanel = 'select';
    this.rebuildPanel();
    this.syncToolbar();
  }

  async copyImage(): Promise<void> {
    try {
      const blob = await this.export();
      if (!blob) {
        showClipboardFeedback('Export failed');
        return;
      }
      await copyBlob(blob.blob);
      showClipboardFeedback('Image copied');
    } catch (err) {
      showClipboardFeedback('Copy failed');
    }
  }

  async pasteImage(): Promise<void> {
    try {
      const blob = await pasteBlob();
      if (!blob) {
        showClipboardFeedback('No image in clipboard');
        return;
      }
      await this.addImageLayer(blob);
      showClipboardFeedback('Image pasted as layer');
    } catch (err) {
      showClipboardFeedback('Paste failed');
    }
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    const flat = document.createElement('canvas');
    this.composite(flat);
    const type = this.contentType;
    const quality = type === 'image/jpeg' ? 0.92 : undefined;
    const blob = await new Promise<Blob | null>((res) => flat.toBlob(res, type, quality));
    return blob ? { blob, contentType: type } : null;
  }

  destroy(): void {
    clearInterval(this.antsTimer);
    this.antsTimer = 0;
    // `this.canvas` is only created in buildUi(); the decode-failure stub skips it.
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas?.removeEventListener('pointermove', this.onPointerMove);
    this.canvas?.removeEventListener('pointerup', this.onPointerUp);
    this.canvas?.removeEventListener('pointercancel', this.onPointerUp);
    document.removeEventListener('keydown', this.onCropKey);
    document.removeEventListener('keydown', this.onShortcut);
    document.removeEventListener('keyup', this.onShortcutUp);
    cancelAnimationFrame(this.renderRaf);
    clearTimeout(this.estimateTimer);
    this.toolbar?.remove(); // may live in the host's header
    this.container.innerHTML = '';
  }
}

// ---- Tiny DOM helpers -----------------------------------------------------

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}
function button(label: string, className: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  return b;
}
function title(text: string): HTMLElement {
  const t = el('div', 'img-panel-title');
  t.textContent = text;
  return t;
}
function note(text: string): HTMLElement {
  const n = el('div', 'img-note');
  n.textContent = text;
  return n;
}
