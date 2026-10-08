import './styles/thumbnail.css';

// YouTube-style thumbnail maker. Opens as a full-screen overlay over the video
// editor: pick a frame (or upload a background), add bold text / emoji / image
// layers, grade + darken the background, then download or save as an image file.
// Everything renders to one canvas at the output size; the preview is that canvas
// scaled down with CSS, so what you see is exactly what gets exported.

export interface ThumbnailOptions {
  root: HTMLElement;
  frame: HTMLCanvasElement;          // initial background (current preview frame)
  duration: number;                  // timeline length, for the frame scrubber
  time: number;                      // current playhead
  grabFrame: (t: number) => Promise<HTMLCanvasElement>;
  baseName: string;
  onSave?: (blob: Blob, name: string) => Promise<void>;
  toast?: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

interface TextLayer {
  kind: 'text'; id: number; x: number; y: number; rot: number;
  text: string; font: string; size: number; color: string; stroke: string; strokeW: number;
  shadow: boolean; pill: boolean; pillColor: string; upper: boolean;
}
interface ImageLayer { kind: 'image'; id: number; x: number; y: number; rot: number; img: CanvasImageSource; w: number; h: number; scale: number }
type Layer = TextLayer | ImageLayer;

const SIZES = [
  { label: 'YouTube 16:9', w: 1280, h: 720 },
  { label: 'Shorts / Reels 9:16', w: 1080, h: 1920 },
  { label: 'Square 1:1', w: 1080, h: 1080 },
  { label: 'Instagram 4:5', w: 1080, h: 1350 },
];
const FONTS = ['Impact', 'Arial Black', 'Helvetica Neue', 'Georgia', 'Trebuchet MS', 'Comic Sans MS', 'Courier New'];
const EMOJI = ['🔥', '😱', '🤯', '💯', '👉', '❗', '⭐', '✅', '❌', '💰', '😂', '🚀'];
const STYLES: { label: string; s: Partial<TextLayer> }[] = [
  { label: 'Bold yellow', s: { font: 'Impact', color: '#ffe500', stroke: '#000000', strokeW: 10, shadow: true, pill: false, upper: true } },
  { label: 'Red box', s: { font: 'Arial Black', color: '#ffffff', stroke: '#000000', strokeW: 0, shadow: false, pill: true, pillColor: '#e11d2e', upper: true } },
  { label: 'Clean white', s: { font: 'Helvetica Neue', color: '#ffffff', stroke: '#000000', strokeW: 0, shadow: true, pill: false, upper: false } },
  { label: 'Neon', s: { font: 'Arial Black', color: '#39ff14', stroke: '#0a0a0a', strokeW: 6, shadow: true, pill: false, upper: true } },
  { label: 'Black on white', s: { font: 'Arial Black', color: '#111111', stroke: '#000000', strokeW: 0, shadow: false, pill: true, pillColor: '#ffffff', upper: true } },
];

let seq = 0;

export function openThumbnailMaker(o: ThumbnailOptions): { close(): void } {
  let W = 1280, H = 720;
  let bg: CanvasImageSource & { width: number; height: number } = o.frame;
  const look = { zoom: 1, panX: 0, panY: 0, bright: 105, contrast: 115, sat: 125, overlay: 'gradient' as 'none' | 'gradient' | 'vignette' | 'tint', tint: '#000000', tintA: 35, border: 0, borderColor: '#ffffff' };
  const layers: Layer[] = [newText('YOUR TITLE HERE')];
  let sel: Layer | null = layers[0]!;
  let frameT = o.time;

  function newText(text: string): TextLayer {
    return { kind: 'text', id: ++seq, x: 0.5, y: 0.78, rot: 0, text, font: 'Impact', size: 0.13, color: '#ffe500',
      stroke: '#000000', strokeW: 10, shadow: true, pill: false, pillColor: '#e11d2e', upper: true };
  }

  const overlay = document.createElement('div');
  overlay.className = 'thumb-overlay';
  overlay.innerHTML = `
    <div class="thumb-head">
      <strong>Thumbnail maker</strong>
      <span class="thumb-spacer"></span>
      <button type="button" class="thumb-btn" data-act="download">Download</button>
      ${o.onSave ? '<button type="button" class="thumb-btn primary" data-act="save">Save to files</button>' : ''}
      <button type="button" class="thumb-btn" data-act="close" aria-label="Close">✕</button>
    </div>
    <div class="thumb-body">
      <div class="thumb-stage"><canvas class="thumb-canvas"></canvas></div>
      <div class="thumb-panel"></div>
    </div>
    <input type="file" accept="image/*" data-role="bgFile" hidden>
    <input type="file" accept="image/*" data-role="imgFile" hidden>`;
  o.root.appendChild(overlay);
  const canvas = overlay.querySelector('canvas')!;
  const ctx = canvas.getContext('2d')!;
  const panel = overlay.querySelector('.thumb-panel') as HTMLElement;
  const bgFile = overlay.querySelector('[data-role="bgFile"]') as HTMLInputElement;
  const imgFile = overlay.querySelector('[data-role="imgFile"]') as HTMLInputElement;

  // ---- Rendering -------------------------------------------------------------

  // Per-layer bounding boxes from the last render, used for hit testing.
  const boxes = new Map<number, { x: number; y: number; w: number; h: number }>();

  function render(c = ctx, showSel = true): void {
    canvas.width = W; canvas.height = H;
    c.save();
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    // Background: cover-fit, then zoom/pan.
    const s = Math.max(W / bg.width, H / bg.height) * look.zoom;
    const dw = bg.width * s, dh = bg.height * s;
    c.filter = `brightness(${look.bright}%) contrast(${look.contrast}%) saturate(${look.sat}%)`;
    c.drawImage(bg, (W - dw) / 2 + look.panX * W, (H - dh) / 2 + look.panY * H, dw, dh);
    c.filter = 'none';
    if (look.overlay === 'gradient') {
      const g = c.createLinearGradient(0, H * 0.35, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${look.tintA / 50})`);
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    } else if (look.overlay === 'vignette') {
      const g = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${look.tintA / 40})`);
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    } else if (look.overlay === 'tint') {
      c.globalAlpha = look.tintA / 100; c.fillStyle = look.tint; c.fillRect(0, 0, W, H); c.globalAlpha = 1;
    }
    for (const l of layers) drawLayer(c, l);
    if (look.border > 0) {
      c.lineWidth = look.border; c.strokeStyle = look.borderColor;
      c.strokeRect(look.border / 2, look.border / 2, W - look.border, H - look.border);
    }
    c.restore();
    if (showSel && sel) {
      const b = boxes.get(sel.id);
      if (b) {
        c.save(); c.setLineDash([12, 8]); c.lineWidth = 3; c.strokeStyle = '#ff3b9a';
        c.strokeRect(b.x, b.y, b.w, b.h); c.restore();
      }
    }
  }

  function drawLayer(c: CanvasRenderingContext2D, l: Layer): void {
    const cx = l.x * W, cy = l.y * H;
    c.save();
    c.translate(cx, cy);
    c.rotate((l.rot * Math.PI) / 180);
    if (l.kind === 'image') {
      const w = l.w * l.scale * W, h = l.h * l.scale * W;
      c.drawImage(l.img, -w / 2, -h / 2, w, h);
      boxes.set(l.id, { x: cx - w / 2, y: cy - h / 2, w, h });
      c.restore();
      return;
    }
    const px = Math.round(l.size * H);
    c.font = `900 ${px}px "${l.font}", Impact, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineJoin = 'round';
    const lines = (l.upper ? l.text.toUpperCase() : l.text).split('\n');
    const lh = px * 1.08;
    const widths = lines.map((t) => c.measureText(t).width);
    const bw = Math.max(1, ...widths), bh = lh * lines.length;
    const pad = px * 0.22;
    if (l.pill) {
      c.fillStyle = l.pillColor;
      c.beginPath(); c.roundRect(-bw / 2 - pad, -bh / 2 - pad * 0.6, bw + pad * 2, bh + pad * 1.2, px * 0.18); c.fill();
    }
    lines.forEach((t, i) => {
      const y = -bh / 2 + lh * (i + 0.5);
      if (l.shadow) { c.shadowColor = 'rgba(0,0,0,0.7)'; c.shadowBlur = px * 0.25; c.shadowOffsetY = px * 0.06; }
      if (l.strokeW > 0) { c.lineWidth = l.strokeW * (px / 90); c.strokeStyle = l.stroke; c.strokeText(t, 0, y); }
      c.shadowColor = 'transparent';
      c.fillStyle = l.color; c.fillText(t, 0, y);
    });
    // Axis-aligned box (ignores rotation; good enough for hit-testing).
    boxes.set(l.id, { x: cx - bw / 2 - pad, y: cy - bh / 2 - pad, w: bw + pad * 2, h: bh + pad * 2 });
    c.restore();
  }

  // ---- Pointer: drag layers, or pan the background when nothing is hit --------

  const toCanvas = (e: PointerEvent): { x: number; y: number } => {
    const r = canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  canvas.addEventListener('pointerdown', (e) => {
    const p = toCanvas(e);
    const hit = [...layers].reverse().find((l) => {
      const b = boxes.get(l.id);
      return b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
    }) ?? null;
    if (hit !== sel) { sel = hit; buildPanel(); }
    canvas.setPointerCapture(e.pointerId);
    const start = p;
    const orig = hit ? { x: hit.x, y: hit.y } : { x: look.panX, y: look.panY };
    const move = (ev: PointerEvent): void => {
      const q = toCanvas(ev);
      const dx = (q.x - start.x) / W, dy = (q.y - start.y) / H;
      if (hit) { hit.x = orig.x + dx; hit.y = orig.y + dy; } else { look.panX = orig.x + dx; look.panY = orig.y + dy; }
      render();
    };
    const up = (): void => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    render();
  });

  // ---- Panel -----------------------------------------------------------------

  function section(title: string): HTMLElement {
    const s = document.createElement('section');
    s.className = 'thumb-sec';
    const h = document.createElement('h4'); h.textContent = title;
    s.appendChild(h);
    panel.appendChild(s);
    return s;
  }
  function btn(host: HTMLElement, label: string, fn: () => void, pressed?: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb-chip'; b.textContent = label;
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    b.addEventListener('click', fn);
    host.appendChild(b);
    return b;
  }
  function range(host: HTMLElement, label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void): void {
    const lab = document.createElement('label'); lab.className = 'thumb-field';
    const val = document.createElement('span'); val.textContent = String(get());
    const inp = document.createElement('input');
    inp.type = 'range'; inp.min = String(min); inp.max = String(max); inp.step = String(step); inp.value = String(get());
    inp.addEventListener('input', () => { set(Number(inp.value)); val.textContent = inp.value; render(); });
    lab.append(document.createTextNode(label + ' '), val, inp);
    host.appendChild(lab);
  }
  function color(host: HTMLElement, label: string, get: () => string, set: (v: string) => void): void {
    const lab = document.createElement('label'); lab.className = 'thumb-color';
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = get();
    inp.addEventListener('input', () => { set(inp.value); render(); });
    lab.append(inp, document.createTextNode(' ' + label));
    host.appendChild(lab);
  }
  function row(host: HTMLElement): HTMLElement {
    const r = document.createElement('div'); r.className = 'thumb-row'; host.appendChild(r); return r;
  }

  function buildPanel(): void {
    panel.innerHTML = '';

    const fr = section('Frame');
    if (o.duration > 0) {
      const lab = document.createElement('label'); lab.className = 'thumb-field';
      const val = document.createElement('span'); val.textContent = fmt(frameT);
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = '0'; inp.max = String(o.duration); inp.step = '0.04'; inp.value = String(frameT);
      inp.addEventListener('input', () => { val.textContent = fmt(Number(inp.value)); });
      inp.addEventListener('change', () => {
        frameT = Number(inp.value);
        void o.grabFrame(frameT).then((f) => { bg = f; render(); });
      });
      lab.append(document.createTextNode('Pick frame '), val, inp);
      fr.appendChild(lab);
    }
    const fb = row(fr);
    btn(fb, 'Upload background…', () => bgFile.click());
    btn(fb, 'Reset zoom/pan', () => { look.zoom = 1; look.panX = 0; look.panY = 0; buildPanel(); render(); });
    range(fr, 'Zoom', 1, 3, 0.05, () => look.zoom, (v) => { look.zoom = v; });

    const sz = row(section('Size'));
    for (const s of SIZES) btn(sz, s.label, () => { W = s.w; H = s.h; buildPanel(); render(); }, W === s.w && H === s.h);

    const lk = section('Background look');
    range(lk, 'Brightness', 50, 160, 1, () => look.bright, (v) => { look.bright = v; });
    range(lk, 'Contrast', 50, 180, 1, () => look.contrast, (v) => { look.contrast = v; });
    range(lk, 'Saturation', 0, 250, 1, () => look.sat, (v) => { look.sat = v; });
    const ov = row(lk);
    for (const k of ['none', 'gradient', 'vignette', 'tint'] as const) {
      btn(ov, k[0]!.toUpperCase() + k.slice(1), () => { look.overlay = k; buildPanel(); render(); }, look.overlay === k);
    }
    if (look.overlay !== 'none') range(lk, 'Overlay strength', 0, 100, 1, () => look.tintA, (v) => { look.tintA = v; });
    if (look.overlay === 'tint') color(lk, 'Tint color', () => look.tint, (v) => { look.tint = v; });
    range(lk, 'Border', 0, 40, 1, () => look.border, (v) => { look.border = v; });
    if (look.border > 0) color(lk, 'Border color', () => look.borderColor, (v) => { look.borderColor = v; });

    const ad = section('Add');
    const ar = row(ad);
    btn(ar, '+ Text', () => { const t = newText('NEW TEXT'); t.y = 0.25; t.size = 0.09; layers.push(t); sel = t; buildPanel(); render(); });
    btn(ar, '+ Image / face…', () => imgFile.click());
    const er = row(ad);
    for (const e of EMOJI) {
      btn(er, e, () => {
        const t = newText(e); Object.assign(t, { x: 0.85, y: 0.25, size: 0.2, strokeW: 0, shadow: true, upper: false });
        layers.push(t); sel = t; buildPanel(); render();
      });
    }

    if (sel) {
      const l = sel;
      const ls = section(l.kind === 'text' ? 'Selected text' : 'Selected image');
      if (l.kind === 'text') {
        const ta = document.createElement('textarea');
        ta.className = 'thumb-text'; ta.rows = 2; ta.value = l.text;
        ta.addEventListener('input', () => { l.text = ta.value; render(); });
        ls.appendChild(ta);
        const st = row(ls);
        for (const p of STYLES) btn(st, p.label, () => { Object.assign(l, p.s); buildPanel(); render(); });
        const fsel = document.createElement('select');
        fsel.className = 'thumb-select';
        for (const f of FONTS) { const op = document.createElement('option'); op.value = f; op.textContent = f; op.selected = f === l.font; fsel.appendChild(op); }
        fsel.addEventListener('change', () => { l.font = fsel.value; render(); });
        ls.appendChild(fsel);
        range(ls, 'Size', 0.03, 0.35, 0.005, () => l.size, (v) => { l.size = v; });
        range(ls, 'Outline', 0, 24, 1, () => l.strokeW, (v) => { l.strokeW = v; });
        const cr = row(ls);
        color(cr, 'Text', () => l.color, (v) => { l.color = v; });
        color(cr, 'Outline', () => l.stroke, (v) => { l.stroke = v; });
        if (l.pill) color(cr, 'Box', () => l.pillColor, (v) => { l.pillColor = v; });
        const tg = row(ls);
        btn(tg, 'Shadow', () => { l.shadow = !l.shadow; buildPanel(); render(); }, l.shadow);
        btn(tg, 'Box', () => { l.pill = !l.pill; buildPanel(); render(); }, l.pill);
        btn(tg, 'ALL CAPS', () => { l.upper = !l.upper; buildPanel(); render(); }, l.upper);
      } else {
        range(ls, 'Scale', 0.05, 1.5, 0.01, () => l.scale, (v) => { l.scale = v; });
      }
      range(ls, 'Rotate', -30, 30, 1, () => l.rot, (v) => { l.rot = v; });
      const ac = row(ls);
      btn(ac, 'Bring to front', () => { layers.splice(layers.indexOf(l), 1); layers.push(l); render(); });
      btn(ac, 'Duplicate', () => { const d = { ...l, id: ++seq, x: l.x + 0.03, y: l.y + 0.03 }; layers.push(d); sel = d; buildPanel(); render(); });
      btn(ac, 'Delete', () => { layers.splice(layers.indexOf(l), 1); sel = null; buildPanel(); render(); });
    } else {
      const hint = document.createElement('p'); hint.className = 'thumb-hint';
      hint.textContent = 'Tap a text or image on the thumbnail to edit it. Drag empty space to pan the background.';
      panel.appendChild(hint);
    }
  }

  // ---- File inputs / export ---------------------------------------------------

  async function loadImage(file: File): Promise<ImageBitmap | null> {
    try { return await createImageBitmap(file); } catch { o.toast?.('Could not read that image', 'error'); return null; }
  }
  bgFile.addEventListener('change', async () => {
    const f = bgFile.files?.[0]; bgFile.value = '';
    const img = f && await loadImage(f);
    if (img) { bg = img; look.zoom = 1; look.panX = 0; look.panY = 0; render(); }
  });
  imgFile.addEventListener('change', async () => {
    const f = imgFile.files?.[0]; imgFile.value = '';
    const img = f && await loadImage(f);
    if (!img) return;
    const l: ImageLayer = { kind: 'image', id: ++seq, x: 0.75, y: 0.55, rot: 0, img, w: 1, h: img.height / img.width, scale: 0.4 };
    layers.push(l); sel = l; buildPanel(); render();
  });

  async function exportBlob(type: string): Promise<Blob | null> {
    const out = document.createElement('canvas');
    const c = out.getContext('2d')!;
    // Render without the selection outline, then copy the pixels.
    render(ctx, false);
    out.width = W; out.height = H;
    c.drawImage(canvas, 0, 0);
    render();
    return new Promise((res) => out.toBlob(res, type, 0.92));
  }

  const name = (ext: string): string => `${o.baseName.replace(/\.[^.]+$/, '')} thumbnail.${ext}`;
  overlay.querySelector('.thumb-head')!.addEventListener('click', async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'close') close();
    else if (act === 'download') {
      const blob = await exportBlob('image/jpeg');
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = name('jpg'); a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } else if (act === 'save' && o.onSave) {
      const blob = await exportBlob('image/png');
      if (!blob) return;
      try { await o.onSave(blob, name('png')); o.toast?.('Thumbnail saved to your files', 'success'); }
      catch (err) { o.toast?.(`Save failed: ${err instanceof Error ? err.message : String(err)}`, 'error'); }
    }
  });

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) {
      layers.splice(layers.indexOf(sel), 1); sel = null; buildPanel(); render();
    }
  };
  document.addEventListener('keydown', onKey);
  function close(): void {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }

  buildPanel();
  render();
  return { close };
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
