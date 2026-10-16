import JSZip from 'jszip';
import * as XLSX from 'xlsx';

// Keeps the original .xlsx package so styles, merges, images and charts survive
// an edit: we render them in the grid and, on export, patch only the sheet cell
// data / merges back into the untouched original parts.

export type Rng = { r1: number; c1: number; r2: number; c2: number };
export interface CellOrig { raw: string; t: 'n' | 's' | 'b' | 'e'; f?: string }
export interface Pos { col: number; row: number; colOff: number; rowOff: number }
export interface ChartData {
  title: string;
  type: 'col' | 'bar' | 'line' | 'area' | 'pie' | 'scatter';
  cats: string[];
  series: { name: string; vals: number[] }[];
}
export interface SheetObject {
  kind: 'image' | 'chart';
  from: Pos;
  to?: Pos;
  ext?: { cx: number; cy: number };
  src?: string;
  chart?: ChartData;
  added?: AddedChart;
}
export interface AddedChart {
  id: string;
  type: ChartData['type'];
  title: string;
  range: Rng;
  headerRow: boolean; // first row holds series names
  catCol: boolean; // first column holds category labels
  from: Pos;
  w: number; // px
  h: number;
}
export interface AddedTable { name: string; range: Rng }
export interface Xf { css: string; fmt: number | string | 0 }

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU_PX = 9525;

export const key = (r: number, c: number) => r + ',' + c;

export class SheetMeta {
  part = '';
  styles = new Map<string, number>();
  merges: Rng[] = [];
  colW = new Map<number, number>();
  rowH = new Map<number, number>();
  rowAttrs = new Map<number, string>();
  orig = new Map<string, CellOrig>();
  objects: SheetObject[] = [];
  drawingPart = '';
  addedCharts: AddedChart[] = [];
  addedTables: AddedTable[] = [];
  centered = new Set<string>(); // view-only centering when there is no package to hold a style

  snapshot() {
    return { styles: [...this.styles], merges: this.merges.map((m) => ({ ...m })), rowH: [...this.rowH], rowAttrs: [...this.rowAttrs], charts: JSON.parse(JSON.stringify(this.addedCharts)) as AddedChart[], tables: JSON.parse(JSON.stringify(this.addedTables)) as AddedTable[] };
  }
  restore(s: ReturnType<SheetMeta['snapshot']>) {
    this.styles = new Map(s.styles);
    this.merges = s.merges.map((m) => ({ ...m }));
    this.rowH = new Map(s.rowH);
    this.rowAttrs = new Map(s.rowAttrs);
    this.addedCharts = s.charts ?? [];
    this.addedTables = s.tables ?? [];
  }

  mergeAt(r: number, c: number): Rng | undefined {
    return this.merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
  }

  /** Shift positional metadata after a row/column insert (delta 1) or delete (delta -1). */
  shift(axis: 'row' | 'col', at: number, delta: 1 | -1) {
    const mv = (n: number) => (n >= at ? n + delta : n);
    const rekey = <T>(m: Map<string, T>) => {
      const out = new Map<string, T>();
      for (const [k, v] of m) {
        const [r, c] = k.split(',').map(Number) as [number, number];
        if (delta === -1 && (axis === 'row' ? r : c) === at) continue;
        out.set(axis === 'row' ? key(mv(r), c) : key(r, mv(c)), v);
      }
      return out;
    };
    this.styles = rekey(this.styles);
    this.orig = rekey(this.orig);
    if (axis === 'row') {
      const rekeyN = <T>(m: Map<number, T>) => {
        const out = new Map<number, T>();
        for (const [r, v] of m) { if (delta === -1 && r === at) continue; out.set(mv(r), v); }
        return out;
      };
      this.rowH = rekeyN(this.rowH);
      this.rowAttrs = rekeyN(this.rowAttrs);
    }
    const lo = axis === 'row' ? 'r1' : 'c1', hi = axis === 'row' ? 'r2' : 'c2';
    this.merges = this.merges.flatMap((m) => {
      const n = { ...m };
      if (delta === 1) {
        if (n[lo] >= at) n[lo]++;
        if (n[hi] >= at) n[hi]++;
      } else {
        if (n[lo] > at) n[lo]--;
        if (n[hi] >= at) n[hi]--;
        if (n[hi] < n[lo]) return [];
      }
      return n.r1 === n.r2 && n.c1 === n.c2 ? [] : [n];
    });
  }

  /** Reorder rows: new row i takes old row idx[i]. */
  permuteRows(idx: number[]) {
    const inv = new Map<number, number>();
    idx.forEach((oldR, newR) => inv.set(oldR, newR));
    const rekey = <T>(m: Map<string, T>) => {
      const out = new Map<string, T>();
      for (const [k, v] of m) {
        const [r, c] = k.split(',').map(Number) as [number, number];
        out.set(key(inv.get(r) ?? r, c), v);
      }
      return out;
    };
    this.styles = rekey(this.styles);
    this.orig = rekey(this.orig);
  }
}

// ---- helpers --------------------------------------------------------------

const els = (p: ParentNode, local: string) => Array.from((p as Element).getElementsByTagNameNS('*', local));
const child = (p: Element | null | undefined, local: string) =>
  p ? Array.from(p.children).find((e) => e.localName === local) : undefined;
const kids = (p: Element | null | undefined, local: string) =>
  p ? Array.from(p.children).filter((e) => e.localName === local) : [];
const num = (v: string | null | undefined, d = 0) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : d; };
const parseXml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');

export function esc(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
function parseRef(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref);
  return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]!) } : null;
}

const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];

function tint(hex: string, t: number): string {
  const r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  let l = (max + min) / 2;
  const d = max - min;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = t < 0 ? l * (1 + t) : l * (1 - t) + t;
  const f = (p: number, q: number, x: number) => {
    if (x < 0) x += 1; if (x > 1) x -= 1;
    return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const out = s === 0 ? [l, l, l] : [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
  return out.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function luminance(hex: string): number {
  const v = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
}

// ---- package --------------------------------------------------------------

export class XlsxPackage {
  private constructor(private bytes: ArrayBuffer, private zip: JSZip) {}
  private xfs: Xf[] = [];
  private xfXml: string[] = [];
  private pendingXfs: string[] = [];
  private centerCache = new Map<number, number>();
  private theme: string[] = [];
  private sheetParts = new Map<string, { part: string; hidden: boolean }>();
  private urls: string[] = [];

  /** Returns null when the file isn't an OOXML workbook we can safely patch. */
  static async load(bytes: ArrayBuffer): Promise<XlsxPackage | null> {
    let zip: JSZip;
    try { zip = await JSZip.loadAsync(bytes); } catch { return null; }
    if (!zip.file('xl/workbook.xml')) return null;
    const pkg = new XlsxPackage(bytes, zip);
    try { await pkg.parseWorkbook(); await pkg.parseTheme(); await pkg.parseStyles(); } catch { return null; }
    return pkg;
  }

  /** Style index = `base` plus centered text (added to styles.xml on export). */
  deriveCenter(base: number): number {
    const hit = this.centerCache.get(base);
    if (hit !== undefined) return hit;
    let xml = this.xfXml[base] ?? '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
    xml = xml.replace(/<alignment\b[^>]*\/>|<alignment\b[\s\S]*?<\/alignment>/, '').replace(/\sapplyAlignment="[^"]*"/, '');
    xml = /\/>\s*$/.test(xml)
      ? xml.replace(/\s*\/>\s*$/, ' applyAlignment="1"><alignment horizontal="center"/></xf>')
      : xml.replace(/^(<xf\b[^>]*?)>/, '$1 applyAlignment="1"><alignment horizontal="center"/>');
    const idx = this.xfs.length;
    const baseXf = this.xfs[base];
    this.xfs.push({ css: `${baseXf?.css ?? ''};text-align:center`, fmt: baseXf?.fmt ?? 0 });
    this.xfXml.push(xml);
    this.pendingXfs.push(xml);
    this.centerCache.set(base, idx);
    return idx;
  }

  hasSheet(name: string) { return this.sheetParts.has(name); }
  isHidden(name: string) { return this.sheetParts.get(name)?.hidden ?? false; }
  xf(i: number | undefined): Xf | undefined { return i ? this.xfs[i] : undefined; }
  dispose() { for (const u of this.urls) URL.revokeObjectURL(u); this.urls = []; }

  private async text(path: string): Promise<string | null> {
    const f = this.zip.file(path);
    return f ? f.async('string') : null;
  }

  private async rels(owner: string): Promise<Map<string, string>> {
    const dir = owner.slice(0, owner.lastIndexOf('/'));
    const file = owner.slice(owner.lastIndexOf('/') + 1);
    const xml = await this.text(`${dir}/_rels/${file}.rels`);
    const out = new Map<string, string>();
    if (!xml) return out;
    for (const rel of els(parseXml(xml), 'Relationship')) {
      const id = rel.getAttribute('Id')!, target = rel.getAttribute('Target')!;
      out.set(id, resolvePath(dir, target));
    }
    return out;
  }

  private async parseWorkbook() {
    const wbXml = parseXml((await this.text('xl/workbook.xml'))!);
    const rels = await this.rels('xl/workbook.xml');
    for (const s of els(wbXml, 'sheet')) {
      const rid = s.getAttributeNS(REL_NS, 'id');
      const part = rid ? rels.get(rid) : undefined;
      if (!part) continue;
      this.sheetParts.set(s.getAttribute('name')!, { part, hidden: (s.getAttribute('state') ?? 'visible') !== 'visible' });
    }
  }

  private async parseTheme() {
    const xml = await this.text('xl/theme/theme1.xml');
    if (!xml) return;
    const scheme = els(parseXml(xml), 'clrScheme')[0];
    if (!scheme) return;
    const get = (n: string) => {
      const e = child(scheme, n);
      const c = e?.firstElementChild;
      return (c?.getAttribute('val') && c.localName === 'srgbClr' ? c.getAttribute('val') : c?.getAttribute('lastClr')) || '000000';
    };
    this.theme = [get('lt1'), get('dk1'), get('lt2'), get('dk2'), 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map((n, i) => (i < 4 ? n : get(n)));
  }

  private color(e: Element | null | undefined): string | null {
    if (!e) return null;
    let hex: string | null = null;
    const rgb = e.getAttribute('rgb');
    if (rgb) hex = rgb.slice(-6).toUpperCase();
    else if (e.hasAttribute('theme')) hex = this.theme[num(e.getAttribute('theme'))] ?? null;
    else if (e.hasAttribute('indexed')) hex = INDEXED[num(e.getAttribute('indexed'))] ?? null;
    if (!hex || !/^[0-9A-F]{6}$/.test(hex)) return null;
    const t = num(e.getAttribute('tint'));
    return t ? tint(hex, t) : hex;
  }

  private async parseStyles() {
    const xml = await this.text('xl/styles.xml');
    if (!xml) return;
    const doc = parseXml(xml);
    const custom = new Map<number, string>();
    for (const n of els(doc, 'numFmt')) custom.set(num(n.getAttribute('numFmtId')), n.getAttribute('formatCode') ?? '');
    const fonts = kids(els(doc, 'fonts')[0], 'font');
    const fills = kids(els(doc, 'fills')[0], 'fill');
    const borders = kids(els(doc, 'borders')[0], 'border');
    const BSTYLE: Record<string, string> = { thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', mediumDashed: '2px dashed', dotted: '1px dotted', double: '3px double' };
    for (const xf of kids(els(doc, 'cellXfs')[0], 'xf')) {
      const css: string[] = [];
      let hasFill = false, fillHex = '';
      const fill = fills[num(xf.getAttribute('fillId'))];
      const pf = child(fill, 'patternFill');
      if (pf && pf.getAttribute('patternType') === 'solid') {
        const c = this.color(child(pf, 'fgColor'));
        if (c) { css.push(`background-color:#${c}`); hasFill = true; fillHex = c; }
      }
      const font = fonts[num(xf.getAttribute('fontId'))];
      if (font) {
        if (child(font, 'b')) css.push('font-weight:700');
        if (child(font, 'i')) css.push('font-style:italic');
        const dec = [child(font, 'u') ? 'underline' : '', child(font, 'strike') ? 'line-through' : ''].filter(Boolean).join(' ');
        if (dec) css.push(`text-decoration:${dec}`);
        const sz = num(child(font, 'sz')?.getAttribute('val'));
        if (sz && Math.abs(sz - 11) > 0.5) css.push(`font-size:${(sz / 11).toFixed(2)}em`);
        const fc = this.color(child(font, 'color'));
        if (fc && (hasFill || (fc !== '000000' && fc !== 'FFFFFF'))) css.push(`color:#${fc}`);
        else if (hasFill) css.push(`color:${luminance(fillHex) > 0.55 ? '#111' : '#fff'}`);
      } else if (hasFill) css.push(`color:${luminance(fillHex) > 0.55 ? '#111' : '#fff'}`);
      const border = borders[num(xf.getAttribute('borderId'))];
      if (border) {
        for (const side of ['left', 'right', 'top', 'bottom']) {
          const b = child(border, side);
          const st = b?.getAttribute('style');
          if (b && st && BSTYLE[st]) css.push(`border-${side}:${BSTYLE[st]} #${this.color(child(b, 'color')) ?? '000000'}`);
        }
      }
      const al = child(xf, 'alignment');
      if (al) {
        const h = al.getAttribute('horizontal');
        if (h === 'left' || h === 'right' || h === 'center') css.push(`text-align:${h}`);
        else if (h === 'centerContinuous') css.push('text-align:center');
        const v = al.getAttribute('vertical');
        if (v === 'top' || v === 'bottom') css.push(`vertical-align:${v}`);
        else if (v === 'center') css.push('vertical-align:middle');
        if (al.getAttribute('wrapText') === '1' || al.getAttribute('wrapText') === 'true') css.push('white-space:normal;word-break:break-word');
      }
      const id = num(xf.getAttribute('numFmtId'));
      this.xfXml.push(new XMLSerializer().serializeToString(xf));
      this.xfs.push({ css: css.join(';'), fmt: id === 0 ? 0 : id >= 164 ? (custom.get(id) ?? 0) : id });
    }
  }

  /** Parse styles/merges/sizes/drawings for one sheet. */
  async loadSheet(name: string): Promise<SheetMeta> {
    const meta = new SheetMeta();
    const info = this.sheetParts.get(name);
    if (!info) return meta;
    meta.part = info.part;
    const xml = await this.text(info.part);
    if (!xml) return meta;
    const doc = parseXml(xml);
    for (const col of els(doc, 'col')) {
      const w = num(col.getAttribute('width'), 0);
      if (!w || col.getAttribute('hidden') === '1') continue;
      const px = Math.min(600, Math.round(w * 7 + 5));
      const min = num(col.getAttribute('min'), 1), max = Math.min(num(col.getAttribute('max'), min), 300);
      for (let c = min; c <= max; c++) meta.colW.set(c - 1, px);
    }
    for (const row of els(doc, 'row')) {
      const r = num(row.getAttribute('r'), 0) - 1;
      if (r < 0) continue;
      const attrs: string[] = [];
      for (const a of Array.from(row.attributes)) if (a.name !== 'r' && a.name !== 'spans') attrs.push(`${a.name}="${esc(a.value)}"`);
      if (attrs.length) meta.rowAttrs.set(r, attrs.join(' '));
      const ht = num(row.getAttribute('ht'));
      if (ht && row.getAttribute('customHeight') !== '0') meta.rowH.set(r, Math.round((ht * 4) / 3));
      for (const c of kids(row, 'c')) {
        const p = parseRef(c.getAttribute('r') ?? '');
        const s = num(c.getAttribute('s'));
        if (p && s) meta.styles.set(key(p.r, p.c), s);
      }
    }
    for (const m of els(doc, 'mergeCell')) {
      const [a, b] = (m.getAttribute('ref') ?? '').split(':');
      const p1 = parseRef(a ?? ''), p2 = parseRef(b ?? '');
      if (p1 && p2) meta.merges.push({ r1: Math.min(p1.r, p2.r), c1: Math.min(p1.c, p2.c), r2: Math.max(p1.r, p2.r), c2: Math.max(p1.c, p2.c) });
    }
    const drawing = els(doc, 'drawing')[0];
    const rid = drawing?.getAttributeNS(REL_NS, 'id');
    if (rid) {
      try {
        const rels = await this.rels(info.part);
        const dpath = rels.get(rid);
        if (dpath) { meta.drawingPart = dpath; meta.objects = await this.parseDrawing(dpath); }
      } catch { /* decorative only; the original drawing is preserved on save */ }
    }
    return meta;
  }

  private async parseDrawing(path: string): Promise<SheetObject[]> {
    const xml = await this.text(path);
    if (!xml) return [];
    const rels = await this.rels(path);
    const out: SheetObject[] = [];
    const pos = (e: Element | undefined): Pos | undefined => e && {
      col: num(child(e, 'col')?.textContent), row: num(child(e, 'row')?.textContent),
      colOff: num(child(e, 'colOff')?.textContent), rowOff: num(child(e, 'rowOff')?.textContent),
    };
    const doc = parseXml(xml);
    for (const a of Array.from(doc.documentElement.children)) {
      if (a.localName !== 'twoCellAnchor' && a.localName !== 'oneCellAnchor') continue;
      const from = pos(child(a, 'from'));
      if (!from) continue;
      const to = pos(child(a, 'to'));
      const extEl = child(a, 'ext');
      const ext = extEl ? { cx: num(extEl.getAttribute('cx')), cy: num(extEl.getAttribute('cy')) } : undefined;
      const pic = child(a, 'pic');
      if (pic) {
        const blip = els(pic, 'blip')[0];
        const target = blip && rels.get(blip.getAttributeNS(REL_NS, 'embed') ?? '');
        const f = target ? this.zip.file(target) : null;
        if (f) {
          const ext2 = target!.split('.').pop()!.toLowerCase();
          const mime = ext2 === 'jpg' || ext2 === 'jpeg' ? 'image/jpeg' : ext2 === 'svg' ? 'image/svg+xml' : ext2 === 'gif' ? 'image/gif' : 'image/png';
          if (ext2 === 'emf' || ext2 === 'wmf') continue;
          const url = URL.createObjectURL(new Blob([await f.async('uint8array') as BlobPart], { type: mime }));
          this.urls.push(url);
          out.push({ kind: 'image', from, to, ext, src: url });
        }
        continue;
      }
      const frame = child(a, 'graphicFrame');
      const chartRef = frame && els(frame, 'chart')[0];
      const cpath = chartRef && rels.get(chartRef.getAttributeNS(REL_NS, 'id') ?? '');
      if (cpath) {
        const cx = await this.text(cpath);
        const chart = cx ? parseChart(cx) : undefined;
        if (chart) out.push({ kind: 'chart', from, to, ext, chart });
      }
    }
    return out;
  }

  private async addDrawingsAndTables(zip: JSZip, sh: ExportSheet, part: string, xmlIn: string, state: { tableId: number; tableNames: Set<string>; drawingTag: number }): Promise<string> {
    let xml = xmlIn;
    const meta = sh.meta;
    if (!meta.addedCharts.length && !meta.addedTables.length) return xml;
    const ctAdds = (state as any).ctAdds as string[];
    const dir = part.slice(0, part.lastIndexOf('/'));
    const file = part.slice(part.lastIndexOf('/') + 1);
    const relsPath = `${dir}/_rels/${file}.rels`;
    const REL_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    let srels = (await zip.file(relsPath)?.async('string')) ?? `${REL_HEAD}</Relationships>`;
    const addRel = (rels: string, type: string, target: string): [string, string] => {
      const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
      const id = `rId${Math.max(0, ...ids) + 1}`;
      return [rels.replace('</Relationships>', `<Relationship Id="${id}" Type="${REL_NS}/${type}" Target="${target}"/></Relationships>`), id];
    };
    if (!/<worksheet\b[^>]*xmlns:r=/.test(xml)) xml = xml.replace('<worksheet', `<worksheet xmlns:r="${REL_NS}"`);
    const before = (tags: string) => new RegExp(`<(${tags})\\b`).exec(xml)?.index ?? xml.lastIndexOf('</worksheet>');
    const grid = sh.grid;
    const val = (r: number, c: number) => sh.computed(r, c) || (grid[r]?.[c] ?? '');

    if (meta.addedCharts.length) {
      let dpath = meta.drawingPart;
      let dxml: string, drels: string;
      if (dpath && zip.file(dpath)) {
        dxml = await zip.file(dpath)!.async('string');
        const dd = dpath.slice(0, dpath.lastIndexOf('/')), df = dpath.slice(dpath.lastIndexOf('/') + 1);
        drels = (await zip.file(`${dd}/_rels/${df}.rels`)?.async('string')) ?? `${REL_HEAD}</Relationships>`;
      } else {
        let n = 1;
        while (zip.file(`xl/drawings/drawing${n}.xml`)) n++;
        dpath = `xl/drawings/drawing${n}.xml`;
        dxml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"></xdr:wsDr>';
        drels = `${REL_HEAD}</Relationships>`;
        ctAdds.push(`<Override PartName="/${dpath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
        const [r2, rid] = addRel(srels, 'drawing', `../drawings/drawing${n}.xml`);
        srels = r2;
        const at = before('legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst');
        xml = xml.slice(0, at) + `<drawing r:id="${rid}"/>` + xml.slice(at);
      }
      const px = /<(\w+):wsDr\b/.exec(dxml)?.[1] ?? 'xdr';
      let anchors = '';
      for (const ac of meta.addedCharts) {
        let n = 1;
        while (zip.file(`xl/charts/chart${n}.xml`)) n++;
        const cpath = `xl/charts/chart${n}.xml`;
        zip.file(cpath, chartPartXml(ac, sh.name, val));
        ctAdds.push(`<Override PartName="/${cpath}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
        const dd = dpath.slice(0, dpath.lastIndexOf('/'));
        let rid: string;
        [drels, rid] = addRel(drels, 'chart', `${resolvePath(dd, '../charts').replace(/^xl\//, '../')}/chart${n}.xml`);
        const tag = ++state.drawingTag;
        anchors += `<${px}:oneCellAnchor><${px}:from><${px}:col>${ac.from.col}</${px}:col><${px}:colOff>${ac.from.colOff}</${px}:colOff><${px}:row>${ac.from.row}</${px}:row><${px}:rowOff>${ac.from.rowOff}</${px}:rowOff></${px}:from><${px}:ext cx="${Math.round(ac.w * EMU_PX)}" cy="${Math.round(ac.h * EMU_PX)}"/><${px}:graphicFrame macro=""><${px}:nvGraphicFramePr><${px}:cNvPr id="${tag}" name="Chart ${tag}"/><${px}:cNvGraphicFramePr/></${px}:nvGraphicFramePr><${px}:xfrm><a:off xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" x="0" y="0"/><a:ext xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" cx="0" cy="0"/></${px}:xfrm><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${REL_NS}" r:id="${rid}"/></a:graphicData></a:graphic></${px}:graphicFrame><${px}:clientData/></${px}:oneCellAnchor>`;
      }
      dxml = dxml.replace(new RegExp(`</${px}:wsDr>\\s*$`), anchors + `</${px}:wsDr>`);
      const dd = dpath.slice(0, dpath.lastIndexOf('/')), df = dpath.slice(dpath.lastIndexOf('/') + 1);
      zip.file(dpath, dxml);
      zip.file(`${dd}/_rels/${df}.rels`, drels);
    }

    if (meta.addedTables.length) {
      const parts: string[] = [];
      for (const t of meta.addedTables) {
        let n = 1;
        while (zip.file(`xl/tables/table${n}.xml`)) n++;
        let name = t.name.replace(/[^A-Za-z0-9_]/g, '_') || 'Table';
        while (state.tableNames.has(name.toLowerCase())) name += '_';
        state.tableNames.add(name.toLowerCase());
        const id = ++state.tableId;
        const ref = `${colName(t.range.c1)}${t.range.r1 + 1}:${colName(t.range.c2)}${t.range.r2 + 1}`;
        const cols = [];
        for (let c = t.range.c1; c <= t.range.c2; c++) cols.push(`<tableColumn id="${c - t.range.c1 + 1}" name="${esc(sh.hdr?.get(key(t.range.r1, c)) ?? `Column${c - t.range.c1 + 1}`)}"/>`);
        const tpath = `xl/tables/table${n}.xml`;
        zip.file(tpath, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${id}" name="${name}" displayName="${name}" ref="${ref}" totalsRowShown="0"><autoFilter ref="${ref}"/><tableColumns count="${cols.length}">${cols.join('')}</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`);
        ctAdds.push(`<Override PartName="/${tpath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>`);
        let rid: string;
        [srels, rid] = addRel(srels, 'table', `../tables/table${n}.xml`);
        parts.push(`<tablePart r:id="${rid}"/>`);
      }
      const existing = /<tableParts\b([^>]*?)count="(\d+)"([^>]*)>/.exec(xml);
      if (existing) {
        xml = xml.replace(existing[0], `<tableParts${existing[1]}count="${Number(existing[2]) + parts.length}"${existing[3]}>`).replace('</tableParts>', parts.join('') + '</tableParts>');
      } else {
        const at = before('extLst');
        xml = xml.slice(0, at) + `<tableParts count="${parts.length}">${parts.join('')}</tableParts>` + xml.slice(at);
      }
    }
    zip.file(relsPath, srels);
    return xml;
  }

  /** Build the exported workbook: original package + patched sheet data. */
  async build(sheets: ExportSheet[]): Promise<ArrayBuffer> {
    const zip = await JSZip.loadAsync(this.bytes);
    let anyFormula = false;
    const state = { ct: '', tableId: 0, tableNames: new Set<string>(), drawingTag: 3000 };
    let ctXml = (await zip.file('[Content_Types].xml')?.async('string')) ?? '';
    let wbXml = (await zip.file('xl/workbook.xml')!.async('string'));
    let relsXml = (await zip.file('xl/_rels/workbook.xml.rels')?.async('string')) ?? '';

    for (const f of Object.keys(zip.files)) {
      if (!/^xl\/tables\/[^/]+\.xml$/.test(f)) continue;
      const t = await zip.file(f)!.async('string');
      state.tableId = Math.max(state.tableId, Number(/\sid="(\d+)"/.exec(t)?.[1] ?? 0));
      const dn = /displayName="([^"]*)"/.exec(t)?.[1];
      if (dn) state.tableNames.add(dn.toLowerCase());
    }
    const ctAdds: string[] = [];
    (state as any).ctAdds = ctAdds;
    for (const sh of sheets) {
      let part = sh.meta.part;
      let xml: string;
      if (part && zip.file(part)) xml = await zip.file(part)!.async('string');
      else {
        let n = 1;
        while (zip.file(`xl/worksheets/sheet${n}.xml`)) n++;
        part = `xl/worksheets/sheet${n}.xml`;
        sh.meta.part = part;
        xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData/></worksheet>';
        ctXml = ctXml.replace('</Types>', `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`);
        const ids = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map((m) => Number(m[1]));
        const rid = `rId${Math.max(0, ...ids) + 1}`;
        relsXml = relsXml.replace('</Relationships>', `<Relationship Id="${rid}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${n}.xml"/></Relationships>`);
        const sids = [...wbXml.matchAll(/sheetId="(\d+)"/g)].map((m) => Number(m[1]));
        wbXml = wbXml.replace('</sheets>', `<sheet name="${esc(sh.name)}" sheetId="${Math.max(0, ...sids) + 1}" r:id="${rid}"/></sheets>`);
        if (!/xmlns:r=/.test(wbXml.slice(0, 600))) wbXml = wbXml.replace('<workbook ', `<workbook xmlns:r="${REL_NS}" `);
      }
      if (sh.meta.addedTables.length) {
        sh.hdr = new Map();
        for (const t of sh.meta.addedTables) {
          const seen = new Set<string>();
          for (let c = t.range.c1; c <= t.range.c2; c++) {
            let name = (sh.computed(t.range.r1, c) || `Column${c - t.range.c1 + 1}`).trim() || `Column${c - t.range.c1 + 1}`;
            while (seen.has(name.toLowerCase())) name += '_';
            seen.add(name.toLowerCase());
            sh.hdr.set(key(t.range.r1, c), name);
          }
        }
      }
      const res = buildSheetData(sh);
      anyFormula = anyFormula || res.formula;
      xml = xml.replace(/<sheetData\s*\/>|<sheetData[\s\S]*?<\/sheetData>/, res.xml);
      xml = xml.replace(/<dimension\b[^>]*\/>/, '');
      xml = xml.replace(/<mergeCells\b[\s\S]*?<\/mergeCells>|<mergeCells\b[^>]*\/>/, '');
      if (sh.meta.merges.length) {
        const mc = `<mergeCells count="${sh.meta.merges.length}">${sh.meta.merges.map((m) => `<mergeCell ref="${colName(m.c1)}${m.r1 + 1}:${colName(m.c2)}${m.r2 + 1}"/>`).join('')}</mergeCells>`;
        const after = /<(phoneticPr|conditionalFormatting|dataValidations|hyperlinks|printOptions|pageMargins|pageSetup|headerFooter|rowBreaks|colBreaks|customProperties|cellWatches|ignoredErrors|smartTags|drawing|legacyDrawing|legacyDrawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)\b/.exec(xml);
        xml = after ? xml.slice(0, after.index) + mc + xml.slice(after.index) : xml.replace('</worksheet>', mc + '</worksheet>');
      }
      xml = await this.addDrawingsAndTables(zip, sh, part, xml, state);
      zip.file(part, xml);
    }

    // The calc chain would reference cells whose formulas we may have changed.
    if (zip.file('xl/calcChain.xml')) {
      zip.remove('xl/calcChain.xml');
      ctXml = ctXml.replace(/<Override[^>]*calcChain[^>]*\/>/g, '');
      relsXml = relsXml.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, '');
    }
    if (anyFormula) {
      if (/<calcPr\b/.test(wbXml)) wbXml = wbXml.replace(/<calcPr\b([^>]*?)(\/?)>/, (_m, a: string, s: string) => `<calcPr${a.replace(/\sfullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"${s}>`);
      else wbXml = wbXml.replace(/(<extLst\b|<\/workbook>)/, '<calcPr fullCalcOnLoad="1"/>$1');
    }
    if (ctAdds.length) ctXml = ctXml.replace('</Types>', ctAdds.join('') + '</Types>');
    if (this.pendingXfs.length) {
      let st = (await zip.file('xl/styles.xml')?.async('string')) ?? '';
      st = st.replace(/<cellXfs\b([^>]*?)count="(\d+)"/, (_m, a: string, n: string) => `<cellXfs${a}count="${Number(n) + this.pendingXfs.length}"`)
        .replace('</cellXfs>', this.pendingXfs.join('') + '</cellXfs>');
      zip.file('xl/styles.xml', st);
    }
    zip.file('[Content_Types].xml', ctXml);
    zip.file('xl/workbook.xml', wbXml);
    zip.file('xl/_rels/workbook.xml.rels', relsXml);
    return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
  }
}

function resolvePath(dir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.' && seg) parts.push(seg);
  }
  return parts.join('/');
}

export interface ExportSheet {
  name: string;
  meta: SheetMeta;
  grid: string[][];
  computed: (r: number, c: number) => string;
  hdr?: Map<string, string>;
}

const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

function buildSheetData(sh: ExportSheet): { xml: string; formula: boolean } {
  const { meta, grid } = sh;
  const rows = new Map<number, Map<number, string>>();
  let formula = false;
  const put = (r: number, c: number, xml: string) => {
    let row = rows.get(r);
    if (!row) rows.set(r, (row = new Map()));
    row.set(c, xml);
  };
  const cell = (r: number, c: number): string => {
    const raw = grid[r]?.[c] ?? '';
    const s = meta.styles.get(key(r, c));
    const hn = sh.hdr?.get(key(r, c));
    if (hn !== undefined) return `<c r="${colName(c)}${r + 1}"${s ? ` s="${s}"` : ''} t="inlineStr"><is><t xml:space="preserve">${esc(hn)}</t></is></c>`;
    const ref = `${colName(c)}${r + 1}`;
    const sa = s ? ` s="${s}"` : '';
    if (raw === '') return `<c r="${ref}"${sa}/>`;
    const o = meta.orig.get(key(r, c));
    const same = !!o && o.raw === raw;
    let f: string | undefined;
    let t: 'n' | 's' | 'b' | 'e' = 's';
    if (raw[0] === '=' && !same) {
      f = raw.slice(1);
      const v = sh.computed(r, c);
      if (v === '' || v.startsWith('#')) { formula = true; return `<c r="${ref}"${sa}><f>${esc(f)}</f></c>`; }
      t = NUMERIC.test(v) ? 'n' : 's';
      formula = true;
      return t === 'n' ? `<c r="${ref}"${sa}><f>${esc(f)}</f><v>${v}</v></c>` : `<c r="${ref}"${sa} t="str"><f>${esc(f)}</f><v>${esc(v)}</v></c>`;
    }
    if (same) { t = o!.t; f = o!.f; } else t = NUMERIC.test(raw) ? 'n' : 's';
    if (f) formula = true;
    const fx = f ? `<f>${esc(f)}</f>` : '';
    if (t === 'n') return `<c r="${ref}"${sa}>${fx}<v>${raw}</v></c>`;
    if (t === 'b') return `<c r="${ref}"${sa} t="b">${fx}<v>${raw.toUpperCase() === 'TRUE' ? 1 : 0}</v></c>`;
    if (t === 'e') return `<c r="${ref}"${sa} t="e">${fx}<v>${esc(raw)}</v></c>`;
    if (f) return `<c r="${ref}"${sa} t="str">${fx}<v>${esc(raw)}</v></c>`;
    return `<c r="${ref}"${sa} t="inlineStr"><is><t xml:space="preserve">${esc(raw)}</t></is></c>`;
  };
  grid.forEach((row, r) => (row ?? []).forEach((v, c) => { if ((v ?? '') !== '') put(r, c, cell(r, c)); }));
  for (const k of sh.hdr?.keys() ?? []) { const [r, c] = k.split(',').map(Number) as [number, number]; if (!rows.get(r)?.has(c)) put(r, c, cell(r, c)); }
  for (const k of meta.styles.keys()) {
    const [r, c] = k.split(',').map(Number) as [number, number];
    if (!rows.get(r)?.has(c)) put(r, c, cell(r, c));
  }
  for (const r of meta.rowAttrs.keys()) if (!rows.has(r)) rows.set(r, new Map());
  const out: string[] = [];
  for (const r of [...rows.keys()].sort((a, b) => a - b)) {
    const attrs = meta.rowAttrs.get(r);
    const cells = rows.get(r)!;
    out.push(`<row r="${r + 1}"${attrs ? ' ' + attrs : ''}>${[...cells.keys()].sort((a, b) => a - b).map((c) => cells.get(c)).join('')}</row>`);
  }
  return { xml: `<sheetData>${out.join('')}</sheetData>`, formula };
}

/** Read a SheetJS worksheet into the editor's raw-text grid (anchored at A1). */
export function gridFromSheet(ws: XLSX.WorkSheet): { grid: string[][]; orig: Map<string, CellOrig> } {
  const grid: string[][] = [];
  const orig = new Map<string, CellOrig>();
  for (const addr of Object.keys(ws)) {
    if (addr[0] === '!') continue;
    const p = parseRef(addr);
    const cell = ws[addr] as XLSX.CellObject | undefined;
    if (!p || !cell) continue;
    if (p.r > 100000 || p.c > 16383) continue;
    let raw = '';
    let t: CellOrig['t'] = 's';
    if (cell.t === 'b') { raw = cell.v ? 'TRUE' : 'FALSE'; t = 'b'; }
    else if (cell.t === 'e') { raw = String(cell.w ?? '#ERR!'); t = 'e'; }
    else if (cell.t === 'n') { raw = cell.v == null ? '' : String(cell.v); t = 'n'; }
    else if (cell.v != null) raw = String(cell.v);
    if (raw === '' && !cell.f) continue;
    while (grid.length <= p.r) grid.push([]);
    const row = grid[p.r]!;
    while (row.length <= p.c) row.push('');
    row[p.c] = raw;
    orig.set(key(p.r, p.c), { raw, t, f: cell.f });
  }
  for (let i = 0; i < grid.length; i++) grid[i] = grid[i] ?? [];
  return { grid: grid.length ? grid : [['']], orig };
}

/** Apply a cell's number format to a numeric display value. */
export function applyFmt(xf: Xf | undefined, v: string): string {
  if (!xf || !xf.fmt || v === '' || !/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return v;
  try { return String((XLSX as any).SSF.format(xf.fmt, Number(v))); } catch { return v; }
}

// ---- charts ---------------------------------------------------------------

function parseChart(xml: string): ChartData | undefined {
  const doc = parseXml(xml);
  const plot = els(doc, 'plotArea')[0];
  if (!plot) return undefined;
  const TYPES: Record<string, ChartData['type']> = { barChart: 'col', bar3DChart: 'col', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area', pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'pie', ofPieChart: 'pie', scatterChart: 'scatter' };
  const group = Array.from(plot.children).find((e) => TYPES[e.localName]);
  if (!group) return undefined;
  let type = TYPES[group.localName]!;
  if (type === 'col' && child(group, 'barDir')?.getAttribute('val') === 'bar') type = 'bar';
  const pts = (cache: Element | undefined, numeric: boolean) => {
    const n = num(child(cache, 'ptCount')?.getAttribute('val'));
    const arr: (string | number)[] = Array(n).fill(numeric ? 0 : '');
    for (const pt of kids(cache, 'pt')) {
      const i = num(pt.getAttribute('idx'));
      const v = child(pt, 'v')?.textContent ?? '';
      if (i < arr.length) arr[i] = numeric ? num(v) : v;
    }
    return arr;
  };
  const cache = (e: Element | undefined) => (e ? els(e, 'numCache')[0] ?? els(e, 'strCache')[0] : undefined);
  const series: ChartData['series'] = [];
  let cats: string[] = [];
  for (const ser of kids(group, 'ser')) {
    const name = els(child(ser, 'tx') ?? ser, 'v')[0]?.textContent ?? `Series ${series.length + 1}`;
    const catEl = child(ser, 'cat') ?? child(ser, 'xVal');
    if (!cats.length && catEl) cats = pts(cache(catEl), false).map(String);
    const valEl = child(ser, 'val') ?? child(ser, 'yVal');
    series.push({ name, vals: pts(cache(valEl), true) as number[] });
  }
  const titleEl = els(doc, 'title')[0];
  const title = titleEl && child(doc.documentElement, 'chart')?.contains(titleEl) ? els(titleEl, 't').map((t) => t.textContent).join('') : '';
  return { title, type, cats, series };
}

const PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#9E480E', '#997300'];

/** Lightweight SVG preview of a chart from its cached values. */
export function chartSvg(ch: ChartData, w: number, h: number): string {
  const e = (s: string) => esc(s);
  const top = ch.title ? 26 : 10, bot = ch.series.length > 1 || ch.type === 'pie' ? 26 : 22, left = 38, right = 10;
  const pw = Math.max(20, w - left - right), ph = Math.max(20, h - top - bot);
  const out: string[] = [`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="system-ui,sans-serif" font-size="11"><rect width="${w}" height="${h}" fill="#fff" stroke="#d0d0d0"/>`];
  if (ch.title) out.push(`<text x="${w / 2}" y="17" text-anchor="middle" font-size="13" font-weight="600" fill="#333">${e(ch.title)}</text>`);
  const n = Math.max(ch.cats.length, ...ch.series.map((s) => s.vals.length), 1);
  if (ch.type === 'pie') {
    const vals = ch.series[0]?.vals ?? [];
    const total = vals.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const cx = w / 2, cy = top + ph / 2, R = Math.min(pw, ph) / 2 - 4;
    let a0 = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a1 = a0 + (Math.max(0, v) / total) * Math.PI * 2;
      const large = a1 - a0 > Math.PI ? 1 : 0;
      out.push(vals.length === 1
        ? `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${PALETTE[0]}"/>`
        : `<path d="M${cx},${cy} L${cx + R * Math.cos(a0)},${cy + R * Math.sin(a0)} A${R},${R} 0 ${large} 1 ${cx + R * Math.cos(a1)},${cy + R * Math.sin(a1)} Z" fill="${PALETTE[i % PALETTE.length]}" stroke="#fff"/>`);
      a0 = a1;
    });
  } else {
    const all = ch.series.flatMap((s) => s.vals);
    const max = Math.max(0, ...all), min = Math.min(0, ...all);
    const span = max - min || 1;
    const y = (v: number) => top + ph - ((v - min) / span) * ph;
    for (let i = 0; i <= 4; i++) {
      const v = min + (span * i) / 4, yy = y(v);
      out.push(`<line x1="${left}" x2="${left + pw}" y1="${yy}" y2="${yy}" stroke="#e5e5e5"/><text x="${left - 4}" y="${yy + 4}" text-anchor="end" fill="#666">${e(String(Math.round(v * 100) / 100))}</text>`);
    }
    const step = pw / n;
    const ns = ch.series.length || 1;
    if (ch.type === 'col' || ch.type === 'bar') {
      const bw = Math.max(2, (step * 0.8) / ns);
      ch.series.forEach((s, si) => s.vals.forEach((v, i) => {
        const x = left + i * step + step * 0.1 + si * bw, y0 = y(0), y1 = y(v);
        out.push(`<rect x="${x}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.abs(y0 - y1)}" fill="${PALETTE[si % PALETTE.length]}"/>`);
      }));
    } else {
      ch.series.forEach((s, si) => {
        const p = s.vals.map((v, i) => `${left + i * step + step / 2},${y(v)}`);
        if (ch.type === 'area') out.push(`<polygon points="${left + step / 2},${y(0)} ${p.join(' ')} ${left + (s.vals.length - 1) * step + step / 2},${y(0)}" fill="${PALETTE[si % PALETTE.length]}" fill-opacity=".45"/>`);
        out.push(`<polyline points="${p.join(' ')}" fill="none" stroke="${PALETTE[si % PALETTE.length]}" stroke-width="2"/>`);
      });
    }
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 50))));
    ch.cats.forEach((c, i) => { if (i % every === 0) out.push(`<text x="${left + i * step + step / 2}" y="${top + ph + 14}" text-anchor="middle" fill="#666">${e(c.slice(0, 10))}</text>`); });
  }
  const legend = ch.type === 'pie' ? ch.cats : ch.series.map((s) => s.name);
  if (legend.length > 1 || ch.type === 'pie') {
    let x = 10;
    legend.slice(0, 8).forEach((name, i) => {
      out.push(`<rect x="${x}" y="${h - 16}" width="9" height="9" fill="${PALETTE[i % PALETTE.length]}"/><text x="${x + 13}" y="${h - 8}" fill="#444">${e(name.slice(0, 12))}</text>`);
      x += 24 + Math.min(name.length, 12) * 6;
    });
  }
  out.push('</svg>');
  return out.join('');
}

export function emuToPx(n: number) { return n / EMU_PX; }


/** Series/categories for a user-inserted chart, read live from the grid. */
export function chartDataFor(ac: AddedChart, val: (r: number, c: number) => string): ChartData {
  const { r1, c1, r2, c2 } = ac.range;
  const d0 = r1 + (ac.headerRow ? 1 : 0), k0 = c1 + (ac.catCol ? 1 : 0);
  const cats: string[] = [];
  for (let r = d0; r <= r2; r++) cats.push(ac.catCol ? val(r, c1) : String(r - d0 + 1));
  const series: ChartData['series'] = [];
  for (let c = k0; c <= (ac.type === 'pie' ? k0 : c2); c++) {
    const vals: number[] = [];
    for (let r = d0; r <= r2; r++) { const n = Number(val(r, c)); vals.push(Number.isFinite(n) ? n : 0); }
    series.push({ name: ac.headerRow ? val(r1, c) || `Series ${series.length + 1}` : `Series ${series.length + 1}`, vals });
  }
  return { title: ac.title, type: ac.type, cats, series };
}

function chartPartXml(ac: AddedChart, sheet: string, val: (r: number, c: number) => string): string {
  const { r1, c1, r2, c2 } = ac.range;
  const d0 = r1 + (ac.headerRow ? 1 : 0), k0 = c1 + (ac.catCol ? 1 : 0);
  const sn = `'${sheet.replace(/'/g, "''")}'`;
  const rng = (c: number, a: number, b: number) => `${sn}!$${colName(c)}$${a + 1}:$${colName(c)}$${b + 1}`;
  const lastC = ac.type === 'pie' ? k0 : c2;
  const sers: string[] = [];
  for (let c = k0; c <= lastC; c++) {
    const i = c - k0;
    const nameXml = ac.headerRow
      ? `<c:tx><c:strRef><c:f>${esc(`${sn}!$${colName(c)}$${r1 + 1}`)}</c:f><c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${esc(val(r1, c))}</c:v></c:pt></c:strCache></c:strRef></c:tx>`
      : `<c:tx><c:v>Series ${i + 1}</c:v></c:tx>`;
    let cat = '';
    if (ac.catCol) {
      const pts = [];
      for (let r = d0; r <= r2; r++) pts.push(`<c:pt idx="${r - d0}"><c:v>${esc(val(r, c1))}</c:v></c:pt>`);
      cat = `<c:cat><c:strRef><c:f>${esc(rng(c1, d0, r2))}</c:f><c:strCache><c:ptCount val="${r2 - d0 + 1}"/>${pts.join('')}</c:strCache></c:strRef></c:cat>`;
    }
    const nums = [];
    for (let r = d0; r <= r2; r++) { const n = Number(val(r, c)); nums.push(`<c:pt idx="${r - d0}"><c:v>${Number.isFinite(n) ? n : 0}</c:v></c:pt>`); }
    const valXml = `<c:val><c:numRef><c:f>${esc(rng(c, d0, r2))}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${r2 - d0 + 1}"/>${nums.join('')}</c:numCache></c:numRef></c:val>`;
    sers.push(`<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${nameXml}${cat}${valXml}${ac.type === 'line' ? '<c:smooth val="0"/>' : ''}</c:ser>`);
  }
  const ax = '<c:axId val="111111"/><c:axId val="222222"/>';
  let plot: string;
  if (ac.type === 'pie') plot = `<c:pieChart><c:varyColors val="1"/>${sers.join('')}<c:firstSliceAng val="0"/></c:pieChart>`;
  else if (ac.type === 'line') plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers.join('')}<c:marker val="1"/>${ax}</c:lineChart>`;
  else if (ac.type === 'area') plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers.join('')}${ax}</c:areaChart>`;
  else plot = `<c:barChart><c:barDir val="${ac.type === 'bar' ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers.join('')}<c:gapWidth val="150"/>${ax}</c:barChart>`;
  const horiz = ac.type === 'bar';
  const axes = ac.type === 'pie' ? '' : `<c:catAx><c:axId val="111111"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horiz ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="222222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="222222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horiz ? 'b' : 'l'}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="111111"/><c:crosses val="autoZero"/></c:valAx>`;
  const title = ac.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:p><a:r><a:t>${esc(ac.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL_NS}"><c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea><c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}
