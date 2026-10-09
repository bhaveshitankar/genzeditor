import './scanner.css';
import { askConfirm } from '../ui/dialog';
import {
  applyFilter, detectQuad, fullQuad, isValidQuad, rotateQuadCW, scaleQuad, warpPerspective,
  type Img, type Pt, type Quad, type ScanFilter,
} from './scanCore';

export interface ScannerOptions {
  root: HTMLElement;                 // append the full-screen overlay here
  onSave: (pdf: Blob, name: string) => Promise<void>; // host saves to library & opens it
  onSaveImages?: (images: Blob[], baseName: string) => Promise<void>; // optional: save pages as JPG/PNG files
  toast?: (msg: string, kind?: 'success' | 'error' | 'info') => void;
}

interface Page {
  id: number;
  blob: Blob; w: number; h: number;   // source photo (JPEG, EXIF-normalized, capped)
  quad: Quad;                          // crop corners in source pixels
  filter: ScanFilter;
  out?: Blob; outKey?: string; outW?: number; outH?: number; thumb?: string;
}

const MAX_SRC = 3200;       // cap source long side (memory on phones)
const MAX_OUT = 2480;       // cap output long side (~300dpi A4)
const DETECT_SIZE = 480;    // detection working resolution
const FILTERS: [ScanFilter, string][] = [
  ['original', 'Original'], ['magic', 'Magic'], ['gray', 'Grayscale'], ['bw', 'B&W'], ['lighten', 'Lighten'],
];
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], fit: null } as const;
type PageSize = keyof typeof PAGE_SIZES;

// ------------------------------------------------------------ DOM helpers

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function btn(label: string, cls: string, onClick: () => void, title = label): HTMLButtonElement {
  const b = h('button', `scan-btn ${cls}`, label);
  b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}
const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------------------------------------------------------- image helpers

function canvas(w: number, hh: number): HTMLCanvasElement {
  const c = h('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(hh)); return c;
}
const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!;

/** Draw any image source into a canvas scaled so its long side ≤ max. */
function drawScaled(src: CanvasImageSource, sw: number, sh: number, max: number): HTMLCanvasElement {
  const s = Math.min(1, max / Math.max(sw, sh));
  const c = canvas(sw * s, sh * s);
  const g = ctx2d(c); g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
const canvasToImg = (c: HTMLCanvasElement): Img => ctx2d(c).getImageData(0, 0, c.width, c.height);
function imgToCanvas(img: Img): HTMLCanvasElement {
  const c = canvas(img.width, img.height);
  ctx2d(c).putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  return c;
}
const toBlob = (c: HTMLCanvasElement, type: string, q?: number) =>
  new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), type, q));

async function decode(blob: Blob): Promise<HTMLCanvasElement> {
  try {
    const bmp = await createImageBitmap(blob);
    const c = canvas(bmp.width, bmp.height); ctx2d(c).drawImage(bmp, 0, 0); bmp.close();
    return c;
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const im = new Image(); im.src = url; await im.decode();
      const c = canvas(im.naturalWidth, im.naturalHeight); ctx2d(c).drawImage(im, 0, 0);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }
}

/** Auto-detect the document quad on a full-size canvas. */
function detectOn(c: HTMLCanvasElement): Quad {
  const small = drawScaled(c, c.width, c.height, DETECT_SIZE);
  const { quad } = detectQuad(canvasToImg(small));
  return scaleQuad(quad, c.width / small.width, c.height / small.height);
}

function rotateCW(c: HTMLCanvasElement): HTMLCanvasElement {
  const r = canvas(c.height, c.width), g = ctx2d(r);
  g.translate(r.width, 0); g.rotate(Math.PI / 2); g.drawImage(c, 0, 0);
  return r;
}

function defaultName(): string {
  const d = new Date(), p = (n: number) => String(n).padStart(2, '0');
  return `Scan ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}`;
}

// ================================================================ scanner

export function openDocScanner(opts: ScannerOptions): { close(): void } {
  const root = h('div', 'scan-root');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Scan document');
  opts.root.append(root);

  let pages: Page[] = [];
  let nextId = 1;
  let batch = false;
  let cleanup: (() => void) | null = null;   // per-screen teardown (camera, observers)
  let sheet: HTMLElement | null = null;      // modal sheet (export)
  let closed = false;
  let cropCache: { id: number; key: string; img: Img } | null = null;

  const toast = (msg: string, kind: 'success' | 'error' | 'info' = 'info') => {
    if (opts.toast) return opts.toast(msg, kind);
    const t = h('div', `scan-toast scan-toast-${kind}`, msg);
    root.append(t); setTimeout(() => t.remove(), 2600);
  };
  const busy = (msg: string) => {
    const b = h('div', 'scan-busy'); b.append(h('div', 'scan-spinner'), h('div', '', msg));
    root.append(b);
    return () => b.remove();
  };

  /** Swap the visible screen; returns [top bar, main stage, bottom bar]. */
  function screen(title: string, onBack: (() => void) | null): [HTMLElement, HTMLElement, HTMLElement] {
    cleanup?.(); cleanup = null;
    sheet?.remove(); sheet = null;
    root.replaceChildren();
    const top = h('div', 'scan-top'), main = h('div', 'scan-main'), bottom = h('div', 'scan-bottom');
    top.append(onBack ? btn('‹', 'scan-icon', onBack, 'Back') : btn('✕', 'scan-icon', requestClose, 'Close'), h('div', 'scan-title', title));
    const right = h('div', 'scan-top-right');
    if (onBack) right.append(btn('✕', 'scan-icon', requestClose, 'Close'));
    top.append(right);
    root.append(top, main, bottom);
    return [top, main, bottom];
  }

  // ------------------------------------------------------------ ingest

  async function addFromCanvas(c: HTMLCanvasElement): Promise<Page> {
    const src = Math.max(c.width, c.height) > MAX_SRC ? drawScaled(c, c.width, c.height, MAX_SRC) : c;
    const p: Page = {
      id: nextId++, blob: await toBlob(src, 'image/jpeg', 0.92), w: src.width, h: src.height,
      quad: detectOn(src), filter: pages.find((x) => x.filter !== 'original')?.filter ?? 'magic',
    };
    pages.push(p);
    return p;
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/') || !f.type);
    if (!list.length) return;
    const done = busy(`Detecting edges… (0/${list.length})`);
    const ids: number[] = [];
    try {
      for (let i = 0; i < list.length; i++) {
        root.querySelector('.scan-busy div:last-child')!.textContent = `Detecting edges… (${i + 1}/${list.length})`;
        await nextFrame();
        try { ids.push((await addFromCanvas(await decode(list[i]))).id); }
        catch { toast(`Couldn't read ${list[i].name}`, 'error'); }
      }
    } finally { done(); }
    if (ids.length) cropScreen(ids, 0);
  }

  function pickFiles(capture: boolean) {
    const input = h('input');
    input.type = 'file'; input.accept = 'image/*';
    if (capture) input.setAttribute('capture', 'environment'); else input.multiple = true;
    input.addEventListener('change', () => { if (input.files?.length) void addFiles(input.files); });
    input.click();
  }

  // ------------------------------------------------------------ start

  function startScreen() {
    const [, main] = screen('Scan document', null);
    main.classList.add('scan-start');
    const hero = h('div', 'scan-hero');
    hero.append(h('div', 'scan-hero-icon', '📄'), h('h2', '', 'Scan a document'),
      h('p', '', 'Take photos or upload images. Edges are detected automatically and pages are flattened into a clean PDF.'));
    const actions = h('div', 'scan-start-actions');
    actions.append(
      btn('📷  Take photo', 'scan-big scan-primary', openCamera),
      btn('🖼  Upload images', 'scan-big', () => pickFiles(false)),
    );
    main.append(hero, actions);
  }

  // ------------------------------------------------------------ camera

  function openCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { pickFiles(true); return; }
    const captured: number[] = [];
    const finish = () => (captured.length ? cropScreen(captured, 0) : pages.length ? reviewScreen() : startScreen());
    const [, main, bottom] = screen('Camera', finish);
    main.classList.add('scan-cam');
    const video = h('video', 'scan-video');
    video.muted = true; video.playsInline = true; video.autoplay = true;
    video.setAttribute('playsinline', '');
    const overlay = h('canvas', 'scan-cam-overlay');
    const flash = h('div', 'scan-flash');
    const msg = h('div', 'scan-cam-msg', 'Starting camera…');
    main.append(video, overlay, flash, msg);

    const thumb = h('button', 'scan-cam-thumb'); thumb.type = 'button'; thumb.title = 'Done';
    const badge = h('span', 'scan-badge');
    thumb.append(badge); thumb.addEventListener('click', finish);
    const shutter = btn('', 'scan-shutter', () => void shoot(), 'Capture');
    const batchBtn = btn(batch ? 'Batch ✓' : 'Single', 'scan-chip', () => {
      batch = !batch; batchBtn.textContent = batch ? 'Batch ✓' : 'Single'; batchBtn.classList.toggle('scan-on', batch);
    }, 'Toggle batch mode (capture several pages in a row)');
    batchBtn.classList.toggle('scan-on', batch);
    const left = h('div', 'scan-cam-side'), right = h('div', 'scan-cam-side');
    left.append(thumb, btn('Upload', 'scan-chip', () => pickFiles(false), 'Upload images'));
    right.append(batchBtn);
    bottom.classList.add('scan-cam-bar');
    bottom.append(left, shutter, right);
    const updateThumb = () => {
      const last = pages.find((p) => p.id === captured[captured.length - 1]);
      thumb.style.backgroundImage = last?.thumb ? `url("${last.thumb}")` : '';
      thumb.classList.toggle('scan-has', !!captured.length);
      badge.textContent = captured.length ? String(captured.length) : '';
    };
    updateThumb();

    let stream: MediaStream | null = null;
    let timer = 0, stopped = false, live: Quad | null = null;
    const stop = () => {
      stopped = true; clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop()); stream = null;
      video.srcObject = null;
    };
    cleanup = stop;

    // Map video pixels → overlay pixels (video uses object-fit: contain).
    const fit = () => {
      const r = main.getBoundingClientRect(), vw = video.videoWidth, vh = video.videoHeight;
      const s = Math.min(r.width / vw, r.height / vh);
      return { s, ox: (r.width - vw * s) / 2, oy: (r.height - vh * s) / 2, r };
    };
    const drawOverlay = () => {
      const dpr = window.devicePixelRatio || 1, { s, ox, oy, r } = fit();
      overlay.width = r.width * dpr; overlay.height = r.height * dpr;
      const g = overlay.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
      if (!live) return;
      g.beginPath();
      live.forEach((p, i) => (i ? g.lineTo : g.moveTo).call(g, ox + p.x * s, oy + p.y * s));
      g.closePath();
      g.fillStyle = 'rgba(255, 77, 141, 0.18)'; g.fill();
      g.lineWidth = 3; g.strokeStyle = '#ff4d8d'; g.lineJoin = 'round'; g.stroke();
    };
    const tick = () => {
      if (stopped || video.readyState < 2 || !video.videoWidth) return;
      const small = drawScaled(video, video.videoWidth, video.videoHeight, 360);
      const r = detectQuad(canvasToImg(small));
      live = r.found ? scaleQuad(r.quad, video.videoWidth / small.width, video.videoHeight / small.height) : null;
      drawOverlay();
    };

    async function shoot() {
      if (!stream || !video.videoWidth) return;
      const c = canvas(video.videoWidth, video.videoHeight);
      ctx2d(c).drawImage(video, 0, 0);
      flash.classList.remove('scan-flashing'); void flash.offsetWidth; flash.classList.add('scan-flashing');
      const p = await addFromCanvas(c);
      p.thumb = drawScaled(c, c.width, c.height, 160).toDataURL('image/jpeg', 0.7);
      captured.push(p.id);
      if (batch) updateThumb(); else cropScreen(captured, 0);
    }

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 } }, audio: false })
      .then(async (s) => {
        if (stopped || closed) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s; video.srcObject = s;
        await video.play().catch(() => {});
        msg.remove();
        timer = window.setInterval(tick, 200);
      })
      .catch(() => {
        msg.replaceChildren(h('div', '', 'Camera unavailable or permission denied.'),
          btn('Use device camera', 'scan-primary', () => pickFiles(true)),
          btn('Upload images', '', () => pickFiles(false)));
        shutter.disabled = true;
      });
  }

  // ------------------------------------------------------------ crop

  function cropScreen(session: number[], index: number) {
    const page = pages.find((p) => p.id === session[index]);
    if (!page) { session.length ? cropScreen(session.filter((id) => pages.some((p) => p.id === id)), 0) : (pages.length ? reviewScreen() : startScreen()); return; }
    const [, main, bottom] = screen(`Adjust corners${session.length > 1 ? ` · ${index + 1}/${session.length}` : ''}`,
      () => (index > 0 ? cropScreen(session, index - 1) : pages.length ? reviewScreen() : startScreen()));
    main.classList.add('scan-stage');
    let preview: HTMLCanvasElement | null = null;
    let full: HTMLCanvasElement | null = null;
    const view = h('canvas', 'scan-crop-img');
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg'); svg.classList.add('scan-crop-svg');
    const shade = document.createElementNS(svgNS, 'path'); shade.classList.add('scan-shade'); shade.setAttribute('fill-rule', 'evenodd');
    const poly = document.createElementNS(svgNS, 'polygon'); poly.classList.add('scan-poly');
    svg.append(shade, poly);
    const loupe = h('canvas', 'scan-loupe'); loupe.width = loupe.height = 240;
    const handles = [0, 1, 2, 3].map(() => h('div', 'scan-handle'));
    const mids = [0, 1, 2, 3].map(() => h('div', 'scan-handle scan-mid'));
    main.append(view, svg, ...mids, ...handles, loupe);

    let q: Quad = page.quad.map((p) => ({ ...p })) as Quad;
    let L = { s: 1, ox: 0, oy: 0 };  // full-res px → stage px
    const toS = (p: Pt) => ({ x: L.ox + p.x * L.s, y: L.oy + p.y * L.s });

    const layout = () => {
      const r = main.getBoundingClientRect(), pad = 28;
      L.s = Math.min((r.width - pad * 2) / page.w, (r.height - pad * 2) / page.h);
      L.ox = (r.width - page.w * L.s) / 2; L.oy = (r.height - page.h * L.s) / 2;
      Object.assign(view.style, { left: `${L.ox}px`, top: `${L.oy}px`, width: `${page.w * L.s}px`, height: `${page.h * L.s}px` });
      svg.setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
      draw();
    };
    const draw = () => {
      const r = main.getBoundingClientRect(), s = q.map(toS);
      const pts = s.map((p) => `${p.x},${p.y}`).join(' ');
      poly.setAttribute('points', pts);
      shade.setAttribute('d', `M0 0H${r.width}V${r.height}H0Z M${s.map((p) => `${p.x} ${p.y}`).join(' L')} Z`);
      const ok = isValidQuad(q, page.w, page.h, 0.01);
      poly.classList.toggle('scan-bad', !ok);
      s.forEach((p, i) => { handles[i].style.transform = `translate(${p.x}px, ${p.y}px)`; });
      s.forEach((p, i) => {
        const n = s[(i + 1) % 4];
        mids[i].style.transform = `translate(${(p.x + n.x) / 2}px, ${(p.y + n.y) / 2}px)`;
      });
    };
    const showLoupe = (p: Pt | null) => {
      if (!p || !preview) { loupe.style.display = 'none'; return; }
      const sp = toS(p), k = preview.width / page.w, g = loupe.getContext('2d')!;
      const zoomSrc = (30 * k) / L.s; // half-width (preview px) of a 2× zoom over a 120px loupe
      g.fillStyle = '#000'; g.fillRect(0, 0, 240, 240);
      g.drawImage(preview, p.x * k - zoomSrc, p.y * k - zoomSrc, zoomSrc * 2, zoomSrc * 2, 0, 0, 240, 240);
      g.strokeStyle = '#ff4d8d'; g.lineWidth = 3;
      g.beginPath(); g.moveTo(120, 96); g.lineTo(120, 144); g.moveTo(96, 120); g.lineTo(144, 120); g.stroke();
      loupe.style.display = 'block';
      const above = sp.y > 150;
      loupe.style.transform = `translate(${Math.max(0, sp.x - 60)}px, ${above ? sp.y - 150 : sp.y + 30}px)`;
    };
    const clampPt = (p: Pt) => ({ x: Math.min(page.w, Math.max(0, p.x)), y: Math.min(page.h, Math.max(0, p.y)) });
    const drag = (el: HTMLElement, idx: number[], loupeIdx: number) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('scan-active');
        const sx = e.clientX, sy = e.clientY, start = idx.map((i) => ({ ...q[i] }));
        const move = (ev: PointerEvent) => {
          const dx = (ev.clientX - sx) / L.s, dy = (ev.clientY - sy) / L.s;
          idx.forEach((i, j) => { q[i] = clampPt({ x: start[j].x + dx, y: start[j].y + dy }); });
          draw(); showLoupe(loupeIdx >= 0 ? q[loupeIdx] : null);
        };
        const up = () => {
          el.classList.remove('scan-active'); showLoupe(null);
          el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
          page.quad = q.map((p) => ({ ...p })) as Quad;
        };
        el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
        showLoupe(loupeIdx >= 0 ? q[loupeIdx] : null);
      });
    };
    handles.forEach((el, i) => drag(el, [i], i));
    mids.forEach((el, i) => drag(el, [i, (i + 1) % 4], -1));
    const setQuad = (nq: Quad) => { q = nq.map((p) => ({ ...p })) as Quad; page.quad = nq; draw(); };

    const ro = new ResizeObserver(layout); ro.observe(main);
    cleanup = () => ro.disconnect();

    const load = async () => {
      full = await decode(page.blob);
      preview = drawScaled(full, full.width, full.height, 1600);
      view.width = preview.width; view.height = preview.height;
      ctx2d(view).drawImage(preview, 0, 0);
      layout();
    };
    void load();

    const remove = () => {
      pages = pages.filter((p) => p.id !== page.id);
      const rest = session.filter((id) => id !== page.id);
      session.splice(0, session.length, ...rest);
      if (rest.length) cropScreen(rest, Math.min(index, rest.length - 1));
      else pages.length ? reviewScreen() : startScreen();
    };
    const rotate = async () => {
      if (!full) return;
      const done = busy('Rotating…'); await nextFrame();
      try {
        const r = rotateCW(full);
        page.quad = rotateQuadCW(q, page.w, page.h);
        page.blob = await toBlob(r, 'image/jpeg', 0.92); page.w = r.width; page.h = r.height;
      } finally { done(); }
      cropScreen(session, index);
    };
    const next = () => {
      if (!isValidQuad(q, page.w, page.h, 0.01)) { toast('Corners must form a convex shape', 'error'); return; }
      page.quad = q;
      if (index < session.length - 1) cropScreen(session, index + 1); else void filterScreen(session, 0);
    };
    const tools = h('div', 'scan-tools');
    tools.append(
      btn('🗑 Delete', 'scan-tool', remove, 'Delete / retake'),
      btn('⟳ Rotate', 'scan-tool', () => void rotate(), 'Rotate 90°'),
      btn('✦ Auto', 'scan-tool', () => { if (full) { setQuad(detectOn(full)); } }, 'Auto detect edges'),
      btn('⛶ Full', 'scan-tool', () => setQuad(fullQuad(page.w, page.h)), 'Full page (no crop)'),
    );
    bottom.append(tools, btn('Next ›', 'scan-primary scan-next', next));
  }

  // --------------------------------------------------------- rendering

  const cropKey = (p: Page) => `${p.w}x${p.h}:${p.quad.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(';')}`;

  async function cropped(p: Page): Promise<Img> {
    const key = cropKey(p);
    if (cropCache?.id === p.id && cropCache.key === key) return cropCache.img;
    const src = canvasToImg(await decode(p.blob));
    const img = await warpPerspective(src, p.quad, MAX_OUT, nextFrame);
    cropCache = { id: p.id, key, img };
    return img;
  }

  /** Warp + filter + encode a page (cached by crop & filter). */
  async function render(p: Page): Promise<void> {
    const key = `${cropKey(p)}|${p.filter}`;
    if (p.outKey === key && p.out) return;
    const img = applyFilter(await cropped(p), p.filter);
    await nextFrame();
    const c = imgToCanvas(img);
    let out = await toBlob(c, 'image/jpeg', 0.85);
    if (p.filter === 'bw') { const png = await toBlob(c, 'image/png'); if (png.size < out.size) out = png; }
    Object.assign(p, { out, outKey: key, outW: c.width, outH: c.height, thumb: drawScaled(c, c.width, c.height, 360).toDataURL('image/jpeg', 0.75) });
  }

  // ------------------------------------------------------------ filters

  async function filterScreen(session: number[], index: number) {
    const found = pages.find((p) => p.id === session[index]);
    if (!found) { reviewScreen(); return; }
    const page: Page = found;
    const [, main, bottom] = screen(`Enhance${session.length > 1 ? ` · ${index + 1}/${session.length}` : ''}`,
      () => cropScreen(session, index));
    main.classList.add('scan-stage', 'scan-filter-stage');
    const img = h('img', 'scan-filter-img'); img.alt = 'Page preview';
    main.append(img);
    const showOut = () => { if (page.thumb) img.src = page.thumb; };
    if (session.length > 1) {
      main.append(
        btn('‹', 'scan-nav scan-nav-l', () => void filterScreen(session, (index - 1 + session.length) % session.length), 'Previous page'),
        btn('›', 'scan-nav scan-nav-r', () => void filterScreen(session, (index + 1) % session.length), 'Next page'));
    }

    const strip = h('div', 'scan-filters');
    const chips = new Map<ScanFilter, HTMLButtonElement>();
    for (const [f, label] of FILTERS) {
      const b = h('button', 'scan-filter'); b.type = 'button';
      const th = h('div', 'scan-filter-th');
      b.append(th, h('span', '', label));
      b.addEventListener('click', () => void pick(f));
      chips.set(f, b); strip.append(b);
    }
    const mark = () => chips.forEach((b, f) => b.classList.toggle('scan-on', f === page.filter));
    const allBtn = btn('Apply to all', 'scan-chip', () => void applyAll(), 'Apply this filter to all pages');
    const row = h('div', 'scan-row');
    row.append(allBtn, btn('Done ✓', 'scan-primary scan-next', () => void finish()));
    bottom.append(strip, row);
    mark();

    let seq = 0;
    async function pick(f: ScanFilter) {
      page.filter = f; mark();
      const my = ++seq, done = busy('Enhancing…');
      try { await nextFrame(); await render(page); if (my === seq) showOut(); }
      catch { toast('Processing failed', 'error'); }
      finally { done(); }
    }
    async function applyAll() {
      const done = busy('Applying to all pages…');
      try {
        for (const p of pages) { p.filter = page.filter; }
        toast(`Applied “${FILTERS.find(([f]) => f === page.filter)![1]}” to ${pages.length} page${pages.length > 1 ? 's' : ''}`, 'success');
      } finally { done(); }
    }
    async function finish() {
      const done = busy('Processing pages…');
      try { for (const id of session) { const p = pages.find((x) => x.id === id); if (p) { await render(p); await nextFrame(); } } }
      catch { toast('Processing failed', 'error'); }
      finally { done(); }
      reviewScreen();
    }

    // Initial render + filter thumbnails from a small crop.
    const done = busy('Flattening page…');
    try {
      await nextFrame();
      await render(page); showOut();
      const base = canvasToImg(smallOf(await cropped(page)));
      for (const [f] of FILTERS) {
        const th = chips.get(f)!.querySelector('.scan-filter-th') as HTMLElement;
        th.style.backgroundImage = `url("${imgToCanvas(applyFilter(base, f)).toDataURL('image/jpeg', 0.7)}")`;
      }
    } catch { toast('Processing failed', 'error'); }
    finally { done(); }
  }

  const smallOf = (img: Img): HTMLCanvasElement => drawScaled(imgToCanvas(img), img.width, img.height, 120);

  // ------------------------------------------------------------ review

  function reviewScreen() {
    if (!pages.length) { startScreen(); return; }
    const [, main, bottom] = screen(`${pages.length} page${pages.length > 1 ? 's' : ''}`, null);
    main.classList.add('scan-review');
    const grid = h('div', 'scan-grid');
    pages.forEach((p, i) => {
      const card = h('div', 'scan-card');
      const im = h('img'); im.alt = `Page ${i + 1}`; if (p.thumb) im.src = p.thumb;
      im.addEventListener('click', () => cropScreen([p.id], 0));
      const bar = h('div', 'scan-card-bar');
      const move = (d: number) => {
        const j = i + d; if (j < 0 || j >= pages.length) return;
        [pages[i], pages[j]] = [pages[j], pages[i]]; reviewScreen();
      };
      const l = btn('←', 'scan-mini', () => move(-1), 'Move left'); l.disabled = i === 0;
      const r = btn('→', 'scan-mini', () => move(1), 'Move right'); r.disabled = i === pages.length - 1;
      bar.append(l, h('span', 'scan-card-n', String(i + 1)), r,
        btn('✕', 'scan-mini scan-danger', () => { pages.splice(i, 1); reviewScreen(); }, 'Delete page'));
      card.append(im, bar);
      grid.append(card);
    });
    const add = h('div', 'scan-card scan-add');
    add.append(btn('📷 Camera', 'scan-chip', openCamera, 'Add page from camera'), btn('🖼 Upload', 'scan-chip', () => pickFiles(false), 'Add page from images'));
    grid.append(add);
    main.append(grid);
    bottom.append(btn('Export PDF', 'scan-primary scan-next scan-wide', exportSheet));
    // Pages may be missing a render (e.g. filter changed via "apply to all").
    void (async () => {
      const stale = pages.filter((p) => !p.out || p.outKey !== `${cropKey(p)}|${p.filter}`);
      if (!stale.length) return;
      const done = busy('Processing pages…');
      try { for (const p of stale) { await render(p); await nextFrame(); } }
      catch { toast('Processing failed', 'error'); }
      finally { done(); }
      if (!closed && root.querySelector('.scan-review')) reviewScreen();
    })();
  }

  // ------------------------------------------------------------ export

  function exportSheet() {
    sheet?.remove();
    const back = h('div', 'scan-sheet-back');
    const s = h('div', 'scan-sheet');
    back.append(s); sheet = back;
    back.addEventListener('click', (e) => { if (e.target === back) { back.remove(); sheet = null; } });
    s.append(h('h3', '', 'Export'));
    const nameL = h('label', 'scan-field'); nameL.append(h('span', '', 'Name'));
    const name = h('input'); name.value = defaultName(); name.maxLength = 120;
    nameL.append(name);
    let size: PageSize = 'a4';
    const seg = h('div', 'scan-seg');
    const sizes: [PageSize, string][] = [['a4', 'A4'], ['letter', 'Letter'], ['fit', 'Fit to image']];
    for (const [k, label] of sizes) {
      const b = btn(label, k === size ? 'scan-on' : '', () => { size = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('scan-on', x === b)); });
      seg.append(b);
    }
    const sizeL = h('div', 'scan-field'); sizeL.append(h('span', '', 'Page size'), seg);
    const actions = h('div', 'scan-row');
    actions.append(btn('Save PDF', 'scan-primary scan-next', () => void savePdf(name.value.trim() || defaultName(), size)));
    if (opts.onSaveImages) actions.append(btn('Save as images', 'scan-chip', () => void saveImages(name.value.trim() || defaultName())));
    s.append(nameL, sizeL, actions);
    root.append(back);
    name.focus(); name.select();
  }

  async function renderAll() {
    for (const p of pages) { await render(p); await nextFrame(); }
  }

  async function savePdf(name: string, size: PageSize) {
    const done = busy('Building PDF…');
    try {
      await renderAll();
      const { PDFDocument } = await import('pdf-lib');
      const doc = await PDFDocument.create();
      doc.setTitle(name); doc.setCreator('GenZ Editor Scanner');
      for (const p of pages) {
        const bytes = new Uint8Array(await p.out!.arrayBuffer());
        const im = p.out!.type === 'image/png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        const iw = p.outW!, ih = p.outH!;
        const base = PAGE_SIZES[size];
        let pw: number, ph: number;
        if (base) { [pw, ph] = iw > ih ? [base[1], base[0]] : [base[0], base[1]]; }
        else { pw = iw * 0.24; ph = ih * 0.24; } // ~300 dpi
        const sc = Math.min(pw / iw, ph / ih), dw = iw * sc, dh = ih * sc;
        doc.addPage([pw, ph]).drawImage(im, { x: (pw - dw) / 2, y: (ph - dh) / 2, width: dw, height: dh });
      }
      const pdf = new Blob([await doc.save() as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
      await opts.onSave(pdf, `${name}.pdf`);
      done();
      toast(`Saved ${name}.pdf`, 'success');
      close();
    } catch (e) {
      done();
      toast(`Couldn't save PDF${e instanceof Error ? `: ${e.message}` : ''}`, 'error');
    }
  }

  async function saveImages(name: string) {
    const done = busy('Saving images…');
    try {
      await renderAll();
      await opts.onSaveImages!(pages.map((p) => p.out!), name);
      done();
      toast(`Saved ${pages.length} image${pages.length > 1 ? 's' : ''}`, 'success');
      close();
    } catch (e) {
      done();
      toast(`Couldn't save images${e instanceof Error ? `: ${e.message}` : ''}`, 'error');
    }
  }

  // ------------------------------------------------------- close / nav

  let confirming = false;
  async function confirmDiscard(): Promise<boolean> {
    if (!pages.length) return true;
    if (confirming) return false;
    confirming = true;
    const ok = await askConfirm({ title: 'Discard scanned pages?', message: 'Your scanned pages haven’t been saved.', confirmLabel: 'Discard', danger: true });
    confirming = false;
    return ok;
  }
  async function requestClose() {
    if (await confirmDiscard()) close();
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    if (confirming) return;
    if (sheet) { sheet.remove(); sheet = null; } else void requestClose();
  };
  // Back button closes the scanner (with a confirm if there's unsaved work).
  const onPop = () => {
    if (!pages.length) { window.removeEventListener('popstate', onPop); close(); return; }
    history.pushState({ docScanner: true }, ''); // stay put while we ask
    void confirmDiscard().then((ok) => { if (ok) { window.removeEventListener('popstate', onPop); close(); } });
  };
  window.addEventListener('keydown', onKey, true);
  history.pushState({ docScanner: true }, '');
  window.addEventListener('popstate', onPop);

  function close() {
    if (closed) return;
    closed = true;
    cleanup?.(); cleanup = null;
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('popstate', onPop);
    if ((history.state as { docScanner?: boolean } | null)?.docScanner) history.back();
    root.remove();
    pages = []; cropCache = null;
  }

  startScreen();
  return { close };
}
