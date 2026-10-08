import { PT_PX, geomPath, isLine, type Deck, type El, type Para, type Slide, type Style } from './model';

// Canvas renderer for PDF export: backgrounds, preset shapes, images, tables and
// word-wrapped text. Approximates the DOM view (same insets, 1.2 line height).

const INS_X = 9.6, INS_Y = 4.8, LH = 1.2;
const fontOf = (s: Style, scale = 1): string =>
  `${s.i ? 'italic ' : ''}${s.b ? 'bold ' : ''}${s.sz * PT_PX * scale}px "${s.font}", Arial, sans-serif`;

async function loadImg(deck: Deck, key: string, cache: Map<string, ImageBitmap | null>): Promise<ImageBitmap | null> {
  if (cache.has(key)) return cache.get(key)!;
  const m = deck.media[key];
  let bmp: ImageBitmap | null = null;
  if (m) {
    try {
      const blob = new Blob([m.data as BlobPart], { type: m.mime });
      if (m.mime === 'image/svg+xml') {
        const img = new Image();
        img.src = URL.createObjectURL(blob);
        await img.decode();
        bmp = await createImageBitmap(img);
        URL.revokeObjectURL(img.src);
      } else bmp = await createImageBitmap(blob);
    } catch { bmp = null; } // EMF/WMF etc. can't be decoded by browsers
  }
  cache.set(key, bmp);
  return bmp;
}

interface Piece { text: string; s: Style; w: number; }
interface Line { pieces: Piece[]; w: number; h: number; indent: number; bullet: string; para: Para; }

/** Greedy word-wrap of paragraphs into lines. */
function layout(ctx: CanvasRenderingContext2D, paras: Para[], width: number): Line[] {
  const lines: Line[] = [];
  let n = 0;
  for (const p of paras) {
    n = p.bu === 'num' ? n + 1 : 0;
    const indent = p.lvl * 48 + (p.bu ? p.def.sz * PT_PX * 1.1 : 0);
    const bullet = p.bu === 'num' ? `${n}.` : p.bu;
    const newLine = (first: boolean): Line => ({ pieces: [], w: 0, h: p.def.sz * PT_PX * LH, indent, bullet: first ? bullet : '', para: p });
    let line = newLine(true);
    const max = width - indent;
    const pushTok = (text: string, s: Style): void => {
      ctx.font = fontOf(s);
      const w = ctx.measureText(text).width;
      if (line.w + w > max && line.pieces.length && text.trim()) { lines.push(line); line = newLine(false); }
      if (!line.pieces.length && !text.trim()) return; // drop leading spaces after wrap
      line.pieces.push({ text, s, w });
      line.w += w;
      line.h = Math.max(line.h, s.sz * PT_PX * LH);
    };
    for (const r of p.runs) {
      r.text.split('\n').forEach((seg, i) => {
        if (i > 0) { lines.push(line); line = newLine(false); }
        for (const tok of seg.split(/(\s+)/)) if (tok) pushTok(tok, r);
      });
    }
    lines.push(line);
  }
  return lines;
}

function drawText(ctx: CanvasRenderingContext2D, el: El): void {
  if (!el.paras.length) return;
  const width = el.w - INS_X * 2;
  const lines = layout(ctx, el.paras, width);
  const total = lines.reduce((a, l) => a + l.h, 0);
  const inner = el.h - INS_Y * 2;
  let y = INS_Y + (el.anchor === 'ctr' ? (inner - total) / 2 : el.anchor === 'b' ? inner - total : 0);
  ctx.textBaseline = 'alphabetic';
  for (const l of lines) {
    const avail = width - l.indent;
    const a = l.para.algn;
    let x = INS_X + l.indent + (a === 'ctr' ? (avail - l.w) / 2 : a === 'r' ? avail - l.w : 0);
    const base = y + l.h * 0.8;
    if (l.bullet && l.para.runs.some((r) => r.text.trim())) {
      ctx.font = fontOf(l.para.def);
      ctx.fillStyle = `#${l.para.def.color}`;
      ctx.fillText(l.bullet, x - l.para.def.sz * PT_PX * 1.1, base);
    }
    for (const pc of l.pieces) {
      ctx.font = fontOf(pc.s);
      ctx.fillStyle = `#${pc.s.color}`;
      ctx.fillText(pc.text, x, base);
      if (pc.s.u) ctx.fillRect(x, base + 2, pc.w, Math.max(1, pc.s.sz / 18));
      x += pc.w;
    }
    y += l.h;
  }
}

function drawTable(ctx: CanvasRenderingContext2D, el: El): void {
  const nCols = Math.max(1, ...el.rows.map((r) => r.length));
  const cols = Array.from({ length: nCols }, (_, i) => el.cols[i] ?? el.w / nCols);
  const sum = cols.reduce((a, b) => a + b, 0) || 1;
  const rh = el.h / Math.max(1, el.rows.length);
  ctx.strokeStyle = '#8C8C8C';
  ctx.lineWidth = 1;
  el.rows.forEach((row, ri) => {
    let x = 0;
    cols.forEach((cw, ci) => {
      const w = (cw / sum) * el.w;
      ctx.strokeRect(x, ri * rh, w, rh);
      ctx.save();
      ctx.beginPath(); ctx.rect(x, ri * rh, w, rh); ctx.clip();
      ctx.font = fontOf(el.cell);
      ctx.fillStyle = `#${el.cell.color}`;
      (row[ci] ?? '').split('\n').forEach((t, li) => ctx.fillText(t, x + 6, ri * rh + 6 + (li + 0.85) * el.cell.sz * PT_PX * LH));
      ctx.restore();
      x += w;
    });
  });
}

export async function renderSlideCanvas(deck: Deck, slide: Slide, scale: number, cache = new Map<string, ImageBitmap | null>()): Promise<HTMLCanvasElement> {
  const cv = document.createElement('canvas');
  cv.width = Math.round(deck.w * scale);
  cv.height = Math.round(deck.h * scale);
  const ctx = cv.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.fillStyle = `#${slide.bg || 'FFFFFF'}`;
  ctx.fillRect(0, 0, deck.w, deck.h);
  if (slide.bgMedia) {
    const bmp = await loadImg(deck, slide.bgMedia, cache);
    if (bmp) ctx.drawImage(bmp, 0, 0, deck.w, deck.h);
  }
  for (const el of slide.els) {
    ctx.save();
    ctx.translate(el.x + el.w / 2, el.y + el.h / 2);
    if (el.rot) ctx.rotate((el.rot * Math.PI) / 180);
    ctx.translate(-el.w / 2, -el.h / 2);
    if (el.type === 'pic') {
      const bmp = await loadImg(deck, el.media, cache);
      if (bmp) {
        ctx.save();
        ctx.translate(el.flipH ? el.w : 0, el.flipV ? el.h : 0);
        ctx.scale(el.flipH ? -1 : 1, el.flipV ? -1 : 1);
        ctx.drawImage(bmp, 0, 0, el.w, el.h);
        ctx.restore();
      }
    } else if (el.type === 'tbl') {
      drawTable(ctx, el);
    } else {
      ctx.save();
      ctx.translate(el.flipH ? el.w : 0, el.flipV ? el.h : 0);
      ctx.scale(el.flipH ? -1 : 1, el.flipV ? -1 : 1);
      const path = new Path2D(geomPath(el.geom, el.w, el.h));
      if (el.fill && !isLine(el.geom)) { ctx.fillStyle = `#${el.fill}`; ctx.fill(path); }
      if (el.line) { ctx.strokeStyle = `#${el.line}`; ctx.lineWidth = el.lineW; ctx.stroke(path); }
      ctx.restore();
      drawText(ctx, el);
    }
    ctx.restore();
  }
  return cv;
}

export async function deckToPdf(deck: Deck): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const cache = new Map<string, ImageBitmap | null>();
  const scale = Math.min(2, 2400 / deck.w);
  for (const s of deck.slides) {
    const cv = await renderSlideCanvas(deck, s, scale, cache);
    const blob = await new Promise<Blob | null>((res) => cv.toBlob(res, 'image/jpeg', 0.92));
    if (!blob) continue;
    const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
    const page = doc.addPage([deck.w * 0.75, deck.h * 0.75]);
    page.drawImage(img, { x: 0, y: 0, width: deck.w * 0.75, height: deck.h * 0.75 });
  }
  const bytes = await doc.save();
  return new Blob([bytes as BlobPart], { type: 'application/pdf' });
}
