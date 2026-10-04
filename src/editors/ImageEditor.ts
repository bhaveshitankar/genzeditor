import './styles/image.css';
import { bindUndoKeys } from './undoKeys';

// Picsart-inspired, fully client-side image editor (vanilla TS, no framework).
// open() builds the entire UI inside a container; export() flattens all layers
// to a Blob. Pure geometry helpers stay exported for the existing unit tests.

export function computeResize(w: number, h: number, maxDim: number): { w: number; h: number } {
  const scale = Math.min(1, maxDim / Math.max(w, h));
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

export function computeRotatedSize(w: number, h: number, deg: 90 | 180 | 270): { w: number; h: number } {
  return deg === 180 ? { w, h } : { w: h, h: w };
}

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
  grayscale: number;  // 0..1
  sepia: number;      // 0..1
  invert: number;     // 0..1
}

function neutralAdjustments(): Adjustments {
  return {
    brightness: 100, contrast: 100, saturation: 100, exposure: 0,
    temperature: 0, tint: 0, hue: 0, sharpness: 0, blur: 0, vignette: 0,
    grayscale: 0, sepia: 0, invert: 0,
  };
}

type Point = { x: number; y: number };
type Tool = 'select' | 'crop' | 'brush' | 'eraser' | 'text' | 'rect' | 'ellipse' | 'arrow';

interface StrokeLayer { id: string; kind: 'brush' | 'eraser'; points: Point[]; color: string; size: number; }
interface TextLayer { id: string; kind: 'text'; x: number; y: number; text: string; size: number; color: string; bold: boolean; }
interface ShapeLayer { id: string; kind: 'rect' | 'ellipse' | 'arrow'; x: number; y: number; w: number; h: number; color: string; strokeWidth: number; fill: boolean; }
interface StickerLayer { id: string; kind: 'sticker'; x: number; y: number; size: number; emoji: string; }
type Layer = StrokeLayer | TextLayer | ShapeLayer | StickerLayer;

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
];

const STICKERS = ['😀', '😎', '❤️', '⭐', '🔥', '🎉', '👍', '💯', '✅'];

let idSeq = 0;
const uid = (): string => `l${++idSeq}`;

// ---- Editor ---------------------------------------------------------------

export class ImageEditor {
  private container: HTMLElement;
  private onChange?: () => void;
  private contentType: string;

  private state: EditorState;
  private undoStack: EditorState[] = [];
  private redoStack: EditorState[] = [];

  private tool: Tool = 'select';
  private selectedId: string | null = null;

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

  // Keyboard undo/redo cleanup.
  private unbindKeys: (() => void) | null = null;

  // Crop rectangle in image coordinates (or null when not cropping).
  private crop: { x: number; y: number; w: number; h: number } | null = null;
  private cropAspect: number | null = null; // null = free

  // Active pointer gesture bookkeeping.
  private drag: { mode: 'draw' | 'move' | 'resize' | 'shape' | 'crop-move' | 'crop-resize';
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
      layers: this.state.layers.map((l) => structuredClone(l)),
    };
  }

  // Snapshot BEFORE a mutation so undo restores the prior state.
  private commit(): void {
    this.undoStack.push(this.cloneState());
    if (this.undoStack.length > 40) this.undoStack.shift();
    this.redoStack = [];
    this.onChange?.();
    this.syncToolbar();
  }

  private undo(): void {
    const prev = this.undoStack.pop();
    if (!prev) return;
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
    this.applyColorGrade(ctx, target.width, target.height, a);
    // Sharpen (per-pixel convolution) then vignette.
    if (a.sharpness > 0) this.applySharpen(ctx, target.width, target.height, a.sharpness / 100);
    if (a.vignette > 0) this.applyVignette(ctx, target.width, target.height, a.vignette / 100);

    // Overlay layers, in stacking order.
    for (const l of layers) this.drawLayer(ctx, l);
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
    this.positionCropBox();
    this.positionSelBox();
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

  // ---- Pointer handling ----

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const p = this.toImage(e);
    this.canvas.setPointerCapture(e.pointerId);

    if (this.tool === 'crop') return; // crop uses its own overlay handles

    if (this.tool === 'brush' || this.tool === 'eraser') {
      this.commit();
      const l: StrokeLayer = { id: uid(), kind: this.tool, points: [p], color: this.color, size: this.brushSize };
      this.state.layers.push(l);
      this.selectedId = l.id;
      this.drag = { mode: 'draw', start: p, orig: l };
      this.render();
      return;
    }

    if (this.tool === 'rect' || this.tool === 'ellipse' || this.tool === 'arrow') {
      this.commit();
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
        this.commit();
        const l: TextLayer = { id: uid(), kind: 'text', x: p.x, y: p.y, text, size: this.textSize, color: this.color, bold: this.fontBold };
        this.state.layers.push(l);
        this.selectedId = l.id;
        this.render();
        this.rebuildPanel();
      }
      return;
    }

    // select tool: pick topmost hit and start moving
    const hit = this.hitTest(p);
    this.selectedId = hit?.id ?? null;
    if (hit) this.drag = { mode: 'move', start: p, orig: structuredClone(hit) };
    else this.drag = null;
    this.render();
    this.rebuildPanel();
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drag) return;
    const p = this.toImage(e);
    const dx = p.x - this.drag.start.x, dy = p.y - this.drag.start.y;
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

  private onPointerUp = (): void => {
    if (this.drag && (this.drag.mode === 'move' || this.drag.mode === 'resize' || this.drag.mode === 'shape' || this.drag.mode === 'draw')) {
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
    }
  }

  // ---- Base-pixel operations (destructive; snapshot first) ----

  private replaceBase(newBase: HTMLCanvasElement): void {
    this.state.base = newBase;
    this.render();
  }

  private flip(axis: 'h' | 'v'): void {
    this.commit();
    const b = this.state.base;
    const out = document.createElement('canvas');
    out.width = b.width; out.height = b.height;
    const c = out.getContext('2d')!;
    c.translate(axis === 'h' ? b.width : 0, axis === 'v' ? b.height : 0);
    c.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
    c.drawImage(b, 0, 0);
    this.replaceBase(out);
  }

  private rotate90(deg: 90 | 180 | 270): void {
    this.commit();
    const b = this.state.base;
    const size = computeRotatedSize(b.width, b.height, deg);
    const out = document.createElement('canvas');
    out.width = size.w; out.height = size.h;
    const c = out.getContext('2d')!;
    c.translate(size.w / 2, size.h / 2);
    c.rotate((deg * Math.PI) / 180);
    c.drawImage(b, -b.width / 2, -b.height / 2);
    this.replaceBase(out);
    this.state.layers = []; // overlay coords no longer valid after rotate
  }

  private rotateFree(angleDeg: number): void {
    // Rotate the *composited* image so overlays come along, then reset overlays.
    this.commit();
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
    this.commit();
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
    this.commit();
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
    this.commit();
    this.state.adjustments = neutralAdjustments();
    this.state.layers = [];
    this.render();
    this.rebuildPanel();
  }

  // ---- Background removal (lazy, on demand) ----

  private async removeBackground(noteEl: HTMLElement): Promise<void> {
    noteEl.textContent = 'Removing background… (downloading model)';
    noteEl.className = 'img-note';
    try {
      // CSP: needs esm.sh + its wasm/model hosts in connect-src/script-src
      // URL held in a variable so TS/Vite don't try to statically resolve it.
      const cdn = 'https://esm.sh/@imgly/background-removal';
      const mod = await import(/* @vite-ignore */ cdn);
      const removeBackground = (mod as { removeBackground: (src: Blob) => Promise<Blob> }).removeBackground;
      const flat = document.createElement('canvas');
      this.composite(flat);
      const srcBlob: Blob = await new Promise((res, rej) =>
        flat.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/png'));
      const result = await removeBackground(srcBlob);
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
    stage.appendChild(this.wrap);
    body.appendChild(stage);

    this.panelHost = el('div', 'img-panel');
    body.appendChild(this.panelHost);
    root.appendChild(body);
    this.container.appendChild(root);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);

    this.buildToolbar();
    this.rebuildPanel();

    // Bind keyboard undo/redo.
    this.unbindKeys = bindUndoKeys({
      undo: () => this.undo(),
      redo: () => this.redo(),
    });
  }

  private activePanel: 'adjust' | 'filters' | 'transform' | 'draw' | 'text' | 'shapes' | 'layers' | 'bg' = 'adjust';

  private buildToolbar(): void {
    this.toolbar.innerHTML = '';
    const tool = (label: string, name: Tool): void => {
      const b = button(label, 'img-tool');
      b.dataset.tool = name;
      b.onclick = (): void => this.setTool(name);
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

    this.toolbar.appendChild(el('div', 'img-sep'));

    const panelBtn = (label: string, panel: typeof this.activePanel): void => {
      const b = button(label, 'img-tool');
      b.dataset.panel = panel;
      b.onclick = (): void => { this.activePanel = panel; this.rebuildPanel(); this.syncToolbar(); };
      this.toolbar.appendChild(b);
    };
    panelBtn('Adjust', 'adjust');
    panelBtn('Filters', 'filters');
    panelBtn('Transform', 'transform');
    panelBtn('Layers', 'layers');
    panelBtn('Remove BG', 'bg');

    this.toolbar.appendChild(el('div', 'img-spacer'));

    const undoBtn = button('↶ Undo', 'img-tool');
    undoBtn.dataset.act = 'undo';
    undoBtn.onclick = (): void => this.undo();
    const redoBtn = button('↷ Redo', 'img-tool');
    redoBtn.dataset.act = 'redo';
    redoBtn.onclick = (): void => this.redo();
    const resetBtn = button('Reset', 'img-tool');
    resetBtn.onclick = (): void => this.resetAll();
    this.toolbar.append(undoBtn, redoBtn, resetBtn);

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
      this.wrap.appendChild(this.cropBox);
    }
    this.cropBox.style.display = 'block';
    this.positionCropBox();
  }

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
    this.crop.w = Math.min(this.crop.w, b.width);
    this.crop.h = Math.min(this.crop.h, b.height);
    this.crop.x = Math.max(0, Math.min(this.crop.x, b.width - this.crop.w));
    this.crop.y = Math.max(0, Math.min(this.crop.y, b.height - this.crop.h));
  }

  // ---- Selection box for overlays ----

  private positionSelBox(): void {
    const sel = this.selected();
    if (!sel || this.tool !== 'select') { if (this.selBox) this.selBox.style.display = 'none'; return; }
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
    const orig = structuredClone(cur);
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
    switch (this.activePanel) {
      case 'adjust': this.buildAdjustPanel(host); break;
      case 'filters': this.buildFiltersPanel(host); break;
      case 'transform': this.buildTransformPanel(host); break;
      case 'draw': this.buildDrawPanel(host); break;
      case 'text': this.buildTextPanel(host); break;
      case 'shapes': this.buildShapesPanel(host); break;
      case 'layers': this.buildLayersPanel(host); break;
      case 'bg': this.buildBgPanel(host); break;
    }
    this.positionSelBox();
  }

  private slider(host: HTMLElement, label: string, key: keyof Adjustments, min: number, max: number, step = 1): void {
    const field = el('div', 'img-field');
    const lab = document.createElement('label');
    const val = document.createElement('span');
    val.textContent = String(this.state.adjustments[key]);
    lab.append(document.createTextNode(label), val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min); input.max = String(max); input.step = String(step);
    input.value = String(this.state.adjustments[key]);
    input.oninput = (): void => {
      this.state.adjustments[key] = Number(input.value);
      val.textContent = input.value;
      this.render();
    };
    input.onchange = (): void => { this.commit(); };
    field.append(lab, input);
    host.appendChild(field);
  }

  private buildAdjustPanel(host: HTMLElement): void {
    host.appendChild(title('Adjustments'));
    this.slider(host, 'Brightness', 'brightness', 0, 200);
    this.slider(host, 'Contrast', 'contrast', 0, 200);
    this.slider(host, 'Saturation', 'saturation', 0, 200);
    this.slider(host, 'Exposure', 'exposure', -100, 100);
    this.slider(host, 'Temperature', 'temperature', -100, 100);
    this.slider(host, 'Tint', 'tint', -100, 100);
    this.slider(host, 'Hue', 'hue', -180, 180);
    this.slider(host, 'Sharpness', 'sharpness', 0, 100);
    this.slider(host, 'Blur', 'blur', 0, 20);
    this.slider(host, 'Vignette', 'vignette', 0, 100);
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
      cx.filter = `brightness(${a.brightness}%) contrast(${a.contrast}%) saturate(${a.saturation}%) hue-rotate(${a.hue}deg) grayscale(${a.grayscale}) sepia(${a.sepia}) invert(${a.invert})`;
      cx.drawImage(thumbSrc, 0, 0);
      const cap = document.createElement('span');
      cap.textContent = preset.name;
      cell.append(c, cap);
      cell.onclick = (): void => {
        this.commit();
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
    if (this.state.layers.length === 0) host.appendChild(note('No overlay layers yet. Add text, shapes, brush strokes or stickers.'));
  }

  private layerName(l: Layer): string {
    if (l.kind === 'text') return `Text: ${l.text.slice(0, 18)}`;
    if (l.kind === 'sticker') return `Sticker ${l.emoji}`;
    if (l.kind === 'brush') return 'Brush stroke';
    if (l.kind === 'eraser') return 'Eraser stroke';
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

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    const flat = document.createElement('canvas');
    this.composite(flat);
    const type = this.contentType;
    const quality = type === 'image/jpeg' ? 0.92 : undefined;
    const blob = await new Promise<Blob | null>((res) => flat.toBlob(res, type, quality));
    return blob ? { blob, contentType: type } : null;
  }

  destroy(): void {
    this.unbindKeys?.();
    this.unbindKeys = null;
    // `this.canvas` is only created in buildUi(); the decode-failure stub skips it.
    this.canvas?.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas?.removeEventListener('pointermove', this.onPointerMove);
    this.canvas?.removeEventListener('pointerup', this.onPointerUp);
    this.canvas?.removeEventListener('pointercancel', this.onPointerUp);
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
