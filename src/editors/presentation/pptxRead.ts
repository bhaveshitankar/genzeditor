import { unzipSync, strFromU8 } from 'fflate';
import { EMU, MIME_BY_EXT, elText, newEl, style, uid, type Align, type Deck, type El, type Para, type Slide, type Style } from './model';

// .pptx → Deck. Resolves placeholder geometry/text styles through
// slide → layout → master, theme colors (with lumMod/lumOff/tint/shade) and
// fonts, flattens groups, and copies decorative layout/master shapes onto each
// slide so the exported deck looks the same without the original masters.

export const LOCK = 'genz:master';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const kids = (e: Element | null | undefined, n: string): Element[] =>
  e ? Array.from(e.children).filter((c) => c.localName === n) : [];
const kid = (e: Element | null | undefined, n: string): Element | null =>
  e ? Array.from(e.children).find((c) => c.localName === n) ?? null : null;
const at = (e: Element | null | undefined, n: string): string | null => e?.getAttribute(n) ?? null;
const num = (e: Element | null | undefined, n: string): number | null => {
  const v = at(e, n);
  return v == null || v === '' ? null : Number(v);
};
const rid = (e: Element | null | undefined, n: string): string =>
  e?.getAttributeNS(R_NS, n) || e?.getAttribute(`r:${n}`) || '';
const bool = (v: string | null): boolean | undefined => (v == null ? undefined : v === '1' || v === 'true');

function resolvePath(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

interface Rel { target: string; type: string; }

class Pkg {
  private xmlCache = new Map<string, Element | null>();
  constructor(public files: Record<string, Uint8Array>) {}
  xml(p: string): Element | null {
    if (!this.xmlCache.has(p)) {
      const f = this.files[p];
      this.xmlCache.set(p, f ? new DOMParser().parseFromString(strFromU8(f), 'application/xml').documentElement : null);
    }
    return this.xmlCache.get(p) ?? null;
  }
  rels(part: string): Map<string, Rel> {
    const i = part.lastIndexOf('/');
    const relsPath = `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
    const out = new Map<string, Rel>();
    for (const r of kids(this.xml(relsPath), 'Relationship')) {
      if (at(r, 'TargetMode') === 'External') continue;
      out.set(at(r, 'Id') ?? '', { target: resolvePath(part, at(r, 'Target') ?? ''), type: at(r, 'Type') ?? '' });
    }
    return out;
  }
  relOfType(part: string, suffix: string): string | null {
    for (const r of this.rels(part).values()) if (r.type.endsWith(`/${suffix}`)) return r.target;
    return null;
  }
}

// ---- colors ---------------------------------------------------------------

const PRST: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF',
  yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500',
};

function rgbToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex, 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToHex(h: number, s: number, l: number): string {
  const f = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r = l, g = l, b = l;
  if (s) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    r = f(p, q, h + 1 / 3); g = f(p, q, h); b = f(p, q, h - 1 / 3);
  }
  return [r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}
function mapRgb(hex: string, fn: (c: number) => number): string {
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c) => Math.round(Math.min(255, Math.max(0, fn(c)))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

interface Theme { colors: Record<string, string>; major: string; minor: string; }
interface Ctx {
  pkg: Pkg; theme: Theme; clrMap: Record<string, string>;
  part: string;                 // part whose rels resolve r:embed
  layoutPh: Element[]; masterPh: Element[];
  masterTx: { title: Element | null; body: Element | null; other: Element | null };
  media: Deck['media']; mediaKeys: Map<string, string>;
}

/** Resolve the color child of a fill/color container (solidFill, fgClr, ...). */
function colorOf(container: Element | null, ctx: Ctx, phClr = ''): string | null {
  const c = container?.children[0];
  if (!c) return null;
  let hex: string | null = null;
  switch (c.localName) {
    case 'srgbClr': hex = at(c, 'val'); break;
    case 'sysClr': hex = at(c, 'lastClr') ?? (at(c, 'val') === 'window' ? 'FFFFFF' : '000000'); break;
    case 'prstClr': hex = PRST[at(c, 'val') ?? ''] ?? '000000'; break;
    case 'scrgbClr': hex = ['r', 'g', 'b'].map((k) => Math.round(((num(c, k) ?? 0) / 100000) * 255).toString(16).padStart(2, '0')).join(''); break;
    case 'schemeClr': {
      const v = at(c, 'val') ?? '';
      if (v === 'phClr') hex = phClr || null;
      else hex = ctx.theme.colors[ctx.clrMap[v] ?? v] ?? null;
      break;
    }
  }
  if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return null;
  hex = hex.toUpperCase();
  // Apply color transforms (the common ones used by theme-based decks).
  for (const m of Array.from(c.children)) {
    const v = (num(m, 'val') ?? 100000) / 100000;
    if (m.localName === 'lumMod' || m.localName === 'lumOff') {
      const [h, s, l] = rgbToHsl(hex);
      hex = hslToHex(h, s, m.localName === 'lumMod' ? l * v : l + v);
    } else if (m.localName === 'tint') hex = mapRgb(hex, (x) => x * v + 255 * (1 - v));
    else if (m.localName === 'shade') hex = mapRgb(hex, (x) => x * v);
  }
  return hex;
}

/** Fill of an spPr / bgPr: undefined = unspecified, '' = none. */
function fillOf(pr: Element | null, ctx: Ctx): string | undefined {
  if (!pr) return undefined;
  if (kid(pr, 'noFill')) return '';
  const solid = kid(pr, 'solidFill');
  if (solid) return colorOf(solid, ctx) ?? '';
  const grad = kid(pr, 'gradFill');
  if (grad) return colorOf(kid(kid(grad, 'gsLst'), 'gs'), ctx) ?? '';
  const patt = kid(pr, 'pattFill');
  if (patt) return colorOf(kid(patt, 'fgClr'), ctx) ?? '';
  return undefined;
}

// ---- text styles ----------------------------------------------------------

type PStyle = Partial<Style> & { algn?: Align; bu?: string };

function rPrStyle(rPr: Element | null, ctx: Ctx): PStyle {
  if (!rPr) return {};
  const o: PStyle = {};
  const sz = num(rPr, 'sz');
  if (sz) o.sz = sz / 100;
  const b = bool(at(rPr, 'b')); if (b !== undefined) o.b = b;
  const i = bool(at(rPr, 'i')); if (i !== undefined) o.i = i;
  const u = at(rPr, 'u'); if (u) o.u = u !== 'none';
  const fill = kid(rPr, 'solidFill') ?? kid(kid(rPr, 'gradFill'), 'gsLst')?.children[0] ?? null;
  const col = colorOf(fill, ctx); if (col) o.color = col;
  const tf = at(kid(rPr, 'latin'), 'typeface');
  if (tf) o.font = tf.startsWith('+mj') ? ctx.theme.major : tf.startsWith('+mn') ? ctx.theme.minor : tf;
  return o;
}
function pPrStyle(pPr: Element | null, ctx: Ctx): PStyle {
  if (!pPr) return {};
  const o: PStyle = rPrStyle(kid(pPr, 'defRPr'), ctx);
  const algn = at(pPr, 'algn');
  if (algn) o.algn = (['l', 'ctr', 'r', 'just'].includes(algn) ? algn : 'l') as Align;
  if (kid(pPr, 'buNone')) o.bu = '';
  else if (kid(pPr, 'buAutoNum')) o.bu = 'num';
  else if (kid(pPr, 'buChar')) o.bu = at(kid(pPr, 'buChar'), 'char') || '•';
  return o;
}
const lvlStyle = (lst: Element | null, lvl: number, ctx: Ctx): PStyle => pPrStyle(kid(lst, `lvl${lvl + 1}pPr`), ctx);

// ---- placeholders ---------------------------------------------------------

const phOf = (sp: Element): Element | null => kid(kid(kid(sp, 'nvSpPr') ?? kid(sp, 'nvPicPr') ?? kid(sp, 'nvGraphicFramePr'), 'nvPr'), 'ph');
const phType = (ph: Element): string => at(ph, 'type') ?? 'body';
const phFamily = (t: string): string => (t === 'title' || t === 'ctrTitle' ? 'title' : ['dt', 'ftr', 'sldNum', 'hdr'].includes(t) ? t : 'body');
const phShapes = (tree: Element | null): Element[] => (tree ? Array.from(tree.children).filter((c) => phOf(c)) : []);

function findPh(list: Element[], ph: Element, byIdx: boolean): Element | null {
  const type = phType(ph), idx = at(ph, 'idx');
  if (byIdx && idx) {
    const m = list.find((s) => at(phOf(s), 'idx') === idx);
    if (m) return m;
  }
  return list.find((s) => phType(phOf(s)!) === type)
    ?? list.find((s) => phFamily(phType(phOf(s)!)) === phFamily(type)) ?? null;
}

// ---- shapes ---------------------------------------------------------------

type Xf = (x: number, y: number, w: number, h: number) => [number, number, number, number];
const identity: Xf = (x, y, w, h) => [x, y, w, h];

interface Box { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean; }
function xfrmBox(xfrm: Element | null): Box | null {
  const off = kid(xfrm, 'off'), ext = kid(xfrm, 'ext');
  if (!off || !ext) return null;
  return {
    x: (num(off, 'x') ?? 0) / EMU, y: (num(off, 'y') ?? 0) / EMU,
    w: (num(ext, 'cx') ?? 0) / EMU, h: (num(ext, 'cy') ?? 0) / EMU,
    rot: (num(xfrm, 'rot') ?? 0) / 60000,
    flipH: at(xfrm, 'flipH') === '1', flipV: at(xfrm, 'flipV') === '1',
  };
}

function mediaKey(ctx: Ctx, rId: string): string {
  const rel = ctx.pkg.rels(ctx.part).get(rId);
  if (!rel) return '';
  const data = ctx.pkg.files[rel.target];
  if (!data) return '';
  let key = ctx.mediaKeys.get(rel.target);
  if (!key) {
    key = uid();
    const ext = (rel.target.split('.').pop() ?? 'png').toLowerCase();
    ctx.media[key] = { data, ext, mime: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
    ctx.mediaKeys.set(rel.target, key);
  }
  return key;
}

function parseTxBody(tx: Element | null, chain: (Element | null)[], base: Style, ctx: Ctx, scale: number): Para[] {
  const out: Para[] = [];
  const lst = kid(tx, 'lstStyle');
  for (const p of kids(tx, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = num(pPr, 'lvl') ?? 0;
    let s: PStyle = { ...base, algn: 'l', bu: '' };
    for (const src of [...chain, lst]) s = { ...s, ...lvlStyle(src, lvl, ctx) };
    s = { ...s, ...pPrStyle(pPr, ctx) };
    const def: Style = { sz: s.sz!, color: s.color!, font: s.font!, b: !!s.b, i: !!s.i, u: !!s.u };
    const para: Para = { runs: [], algn: s.algn ?? 'l', bu: s.bu ?? '', lvl, def };
    for (const r of Array.from(p.children)) {
      if (r.localName === 'r' || r.localName === 'fld' || r.localName === 'br') {
        const rs = { ...def, ...rPrStyle(kid(r, 'rPr'), ctx) };
        rs.sz = Math.round(rs.sz * scale * 10) / 10;
        const text = r.localName === 'br' ? '\n' : kid(r, 't')?.textContent ?? '';
        para.runs.push({ ...rs, text } as Style & { text: string });
      }
    }
    const end = rPrStyle(kid(p, 'endParaRPr'), ctx);
    para.def = { ...def, ...end };
    para.def.sz = Math.round(para.def.sz * scale * 10) / 10;
    out.push(para);
  }
  return out;
}

function parseSp(sp: Element, ctx: Ctx, xf: Xf, isConnector: boolean): El | null {
  const ph = phOf(sp);
  const spPr = kid(sp, 'spPr');
  const lph = ph ? findPh(ctx.layoutPh, ph, true) : null;
  const mph = ph ? findPh(ctx.masterPh, lph ? phOf(lph)! : ph, false) : null;
  const box = xfrmBox(kid(spPr, 'xfrm')) ?? xfrmBox(kid(kid(lph, 'spPr'), 'xfrm')) ?? xfrmBox(kid(kid(mph, 'spPr'), 'xfrm'));
  if (!box) return null;
  const [x, y, w, h] = xf(box.x, box.y, box.w, box.h);
  const st = kid(sp, 'style');
  const geom = isConnector ? 'line' : at(kid(spPr, 'prstGeom'), 'prst') ?? 'rect';
  const refColor = (n: string): string => (num(kid(st, n), 'idx') ? colorOf(kid(st, n), ctx) ?? '' : '');
  const fill = fillOf(spPr, ctx) ?? fillOf(kid(lph, 'spPr'), ctx) ?? fillOf(kid(mph, 'spPr'), ctx) ?? (isConnector ? '' : refColor('fillRef'));
  const ln = kid(spPr, 'ln');
  const line = ln ? fillOf(ln, ctx) ?? refColor('lnRef') : refColor('lnRef');
  const lineW = Math.max(0.75, (num(ln, 'w') ?? 12700) / EMU);

  // Text style chain: master txStyles → master ph → layout ph → (shape lstStyle).
  const type = ph ? phType(ph) : '';
  const fam = ph ? phFamily(type) : '';
  const masterStyle = fam === 'title' ? ctx.masterTx.title : fam === 'body' ? ctx.masterTx.body : ctx.masterTx.other;
  const chain = [masterStyle, kid(kid(mph, 'txBody'), 'lstStyle'), kid(kid(lph, 'txBody'), 'lstStyle')];
  const fontRefColor = colorOf(kid(st, 'fontRef'), ctx);
  const base = style({
    sz: 18, color: fontRefColor ?? ctx.theme.colors[ctx.clrMap.tx1 ?? 'dk1'] ?? '000000',
    font: fam === 'title' ? ctx.theme.major : ctx.theme.minor,
  });
  const tx = kid(sp, 'txBody');
  const bodyPr = kid(tx, 'bodyPr');
  const anchor = (at(bodyPr, 'anchor') ?? at(kid(kid(lph, 'txBody'), 'bodyPr'), 'anchor')
    ?? at(kid(kid(mph, 'txBody'), 'bodyPr'), 'anchor') ?? 't') as El['anchor'];
  const scale = (num(kid(bodyPr, 'normAutofit'), 'fontScale') ?? 100000) / 100000;
  const paras = tx ? parseTxBody(tx, chain, base, ctx, scale) : [];
  return newEl({
    type: 'sp', x, y, w, h, rot: box.rot, flipH: box.flipH, flipV: box.flipV, geom, fill, line, lineW, paras,
    anchor: anchor === 'ctr' || anchor === 'b' ? anchor : 't', ph: ph ? type : '',
  });
}

function parsePic(pic: Element, ctx: Ctx, xf: Xf): El | null {
  const ph = phOf(pic);
  const lph = ph ? findPh(ctx.layoutPh, ph, true) : null;
  const box = xfrmBox(kid(kid(pic, 'spPr'), 'xfrm')) ?? xfrmBox(kid(kid(lph, 'spPr'), 'xfrm'));
  const media = mediaKey(ctx, rid(kid(kid(pic, 'blipFill'), 'blip'), 'embed'));
  if (!box || !media) return null;
  const [x, y, w, h] = xf(box.x, box.y, box.w, box.h);
  return newEl({ type: 'pic', x, y, w, h, rot: box.rot, flipH: box.flipH, flipV: box.flipV, media });
}

function parseTable(gf: Element, ctx: Ctx, xf: Xf): El | null {
  const tbl = kid(kid(kid(gf, 'graphic'), 'graphicData'), 'tbl');
  const box = xfrmBox(kid(gf, 'xfrm'));
  if (!tbl || !box) return null;
  const [x, y, w, h] = xf(box.x, box.y, box.w, box.h);
  const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => (num(g, 'w') ?? 0) / EMU * (box.w ? w / box.w : 1));
  let cell: Style | null = null;
  const rows = kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => {
    const ps = kids(kid(tc, 'txBody'), 'p');
    if (!cell) {
      const r = ps.flatMap((p) => kids(p, 'r'))[0];
      if (r) cell = { ...style({ font: ctx.theme.minor, color: ctx.theme.colors.dk1 ?? '000000' }), ...rPrStyle(kid(r, 'rPr'), ctx) };
    }
    return ps.map((p) => kids(p, 'r').map((r) => kid(r, 't')?.textContent ?? '').join('')).join('\n');
  }));
  return newEl({ type: 'tbl', x, y, w, h, rows, cols, cell: cell ?? style({ font: ctx.theme.minor }) });
}

/** Walk an spTree (or group) collecting elements; `skipPh` drops placeholders (layout/master). */
function walkTree(tree: Element, ctx: Ctx, xf: Xf, skipPh: boolean, out: El[]): void {
  for (const node of Array.from(tree.children)) {
    if (node.localName === 'AlternateContent') {
      const alt = kid(node, 'Fallback') ?? kid(node, 'Choice');
      if (!alt) continue;
      walkTree(alt, ctx, xf, skipPh, out);
      continue;
    }
    if (skipPh && phOf(node)) continue;
    let el: El | null = null;
    switch (node.localName) {
      case 'sp': el = parseSp(node, ctx, xf, false); break;
      case 'cxnSp': el = parseSp(node, ctx, xf, true); break;
      case 'pic': el = parsePic(node, ctx, xf); break;
      case 'graphicFrame': el = parseTable(node, ctx, xf); break;
      case 'grpSp': {
        const gx = kid(kid(node, 'grpSpPr'), 'xfrm');
        const off = kid(gx, 'off'), ext = kid(gx, 'ext'), chOff = kid(gx, 'chOff'), chExt = kid(gx, 'chExt');
        let inner = xf;
        if (off && ext && chOff && chExt) {
          const sx = (num(ext, 'cx') ?? 0) / ((num(chExt, 'cx') ?? 0) || 1);
          const sy = (num(ext, 'cy') ?? 0) / ((num(chExt, 'cy') ?? 0) || 1);
          const ox = (num(off, 'x') ?? 0) / EMU, oy = (num(off, 'y') ?? 0) / EMU;
          const cx = (num(chOff, 'x') ?? 0) / EMU, cy = (num(chOff, 'y') ?? 0) / EMU;
          inner = (x, y, w, h) => xf(ox + (x - cx) * sx, oy + (y - cy) * sy, w * sx, h * sy);
        }
        walkTree(node, ctx, inner, skipPh, out);
        break;
      }
    }
    if (el) {
      const nv = node.firstElementChild;
      if (skipPh || at(kid(nv, 'cNvPr'), 'descr') === LOCK) el.locked = true;
      out.push(el);
    }
  }
}

/** Background of a cSld: solid color and/or image. */
function bgOf(cSld: Element | null, ctx: Ctx): { bg: string; bgMedia: string } | null {
  const bg = kid(cSld, 'bg');
  if (!bg) return null;
  const pr = kid(bg, 'bgPr');
  if (pr) {
    const blip = kid(kid(pr, 'blipFill'), 'blip');
    if (blip) return { bg: '', bgMedia: mediaKey(ctx, rid(blip, 'embed')) };
    const f = fillOf(pr, ctx);
    return f !== undefined ? { bg: f, bgMedia: '' } : null;
  }
  const ref = kid(bg, 'bgRef');
  return ref ? { bg: colorOf(ref, ctx) ?? '', bgMedia: '' } : null;
}

function parseTheme(el: Element | null): Theme {
  const theme: Theme = { colors: {}, major: 'Calibri Light', minor: 'Calibri' };
  const elems = kid(el, 'themeElements');
  for (const c of Array.from(kid(elems, 'clrScheme')?.children ?? [])) {
    const v = c.children[0];
    const hex = v?.localName === 'sysClr' ? at(v, 'lastClr') : at(v, 'val');
    if (hex) theme.colors[c.localName] = hex.toUpperCase();
  }
  const fonts = kid(elems, 'fontScheme');
  theme.major = at(kid(kid(fonts, 'majorFont'), 'latin'), 'typeface') || theme.major;
  theme.minor = at(kid(kid(fonts, 'minorFont'), 'latin'), 'typeface') || theme.minor;
  return theme;
}

export function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export function readPptx(bytes: Uint8Array): Deck {
  const pkg = new Pkg(unzipSync(bytes));
  const rootRel = kids(pkg.xml('_rels/.rels'), 'Relationship').find((r) => (at(r, 'Type') ?? '').endsWith('/officeDocument'));
  const presPath = (at(rootRel, 'Target') ?? 'ppt/presentation.xml').replace(/^\//, '');
  const pres = pkg.xml(presPath);
  if (!pres) throw new Error('Not a PowerPoint presentation (ppt/presentation.xml missing)');
  const sz = kid(pres, 'sldSz');
  const deck: Deck = {
    w: (num(sz, 'cx') ?? 12192000) / EMU, h: (num(sz, 'cy') ?? 6858000) / EMU,
    slides: [], media: {}, font: 'Calibri', titleFont: 'Calibri Light',
  };
  const presRels = pkg.rels(presPath);
  const mediaKeys = new Map<string, string>();
  for (const sldId of kids(kid(pres, 'sldIdLst'), 'sldId')) {
    const slidePath = presRels.get(rid(sldId, 'id'))?.target;
    const sld = slidePath ? pkg.xml(slidePath) : null;
    if (!slidePath || !sld) continue;
    const layoutPath = pkg.relOfType(slidePath, 'slideLayout');
    const layout = layoutPath ? pkg.xml(layoutPath) : null;
    const masterPath = layoutPath ? pkg.relOfType(layoutPath, 'slideMaster') : null;
    const master = masterPath ? pkg.xml(masterPath) : null;
    const themePath = masterPath ? pkg.relOfType(masterPath, 'theme') : null;
    const theme = parseTheme(themePath ? pkg.xml(themePath) : null);
    deck.font = theme.minor; deck.titleFont = theme.major;
    const clrMap: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };
    for (const a of Array.from(kid(master, 'clrMap')?.attributes ?? [])) clrMap[a.name] = a.value;
    const tree = (e: Element | null): Element | null => kid(kid(e, 'cSld'), 'spTree');
    const txStyles = kid(master, 'txStyles');
    const ctx: Ctx = {
      pkg, theme, clrMap, part: slidePath, media: deck.media, mediaKeys,
      layoutPh: phShapes(tree(layout)), masterPh: phShapes(tree(master)),
      masterTx: { title: kid(txStyles, 'titleStyle'), body: kid(txStyles, 'bodyStyle'), other: kid(txStyles, 'otherStyle') },
    };
    const els: El[] = [];
    // Decorative (non-placeholder) master + layout shapes sit underneath slide content.
    const showMaster = (e: Element | null): boolean => at(e, 'showMasterSp') !== '0';
    if (master && masterPath && showMaster(sld) && showMaster(layout)) {
      walkTree(tree(master)!, { ...ctx, part: masterPath }, identity, true, els);
    }
    if (layout && layoutPath && showMaster(sld)) walkTree(tree(layout)!, { ...ctx, part: layoutPath }, identity, true, els);
    walkTree(tree(sld)!, ctx, identity, false, els);
    // Drop slide-number and empty footer/date placeholders (they rely on master fields).
    const kept = els.filter((e) => !(e.ph === 'sldNum' || (['dt', 'ftr', 'hdr'].includes(e.ph) && !elText(e).trim())));

    const bg = bgOf(kid(sld, 'cSld'), ctx)
      ?? (layoutPath ? bgOf(kid(layout, 'cSld'), { ...ctx, part: layoutPath }) : null)
      ?? (masterPath ? bgOf(kid(master, 'cSld'), { ...ctx, part: masterPath }) : null)
      ?? { bg: 'FFFFFF', bgMedia: '' };

    // Speaker notes: body placeholder of the notes slide.
    let notes = '';
    const notesPath = pkg.relOfType(slidePath, 'notesSlide');
    const notesTree = notesPath ? tree(pkg.xml(notesPath)) : null;
    const body = notesTree ? Array.from(notesTree.children).find((s) => { const p = phOf(s); return p && phType(p) === 'body'; }) : null;
    if (body) notes = kids(kid(body, 'txBody'), 'p').map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('')).join('\n');

    deck.slides.push({ id: uid(), els: kept, bg: bg.bg || (bg.bgMedia ? '' : 'FFFFFF'), bgMedia: bg.bgMedia, notes: notes.trim() ? notes : '' });
  }
  return deck;
}
