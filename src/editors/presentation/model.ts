// Presentation document model shared by the pptx reader/writer, the DOM editor
// and the canvas (PDF) renderer. All geometry is in CSS px at 96 dpi
// (1 px = 9525 EMU); font sizes are in points. Colors are 'RRGGBB' ('' = none).

export const EMU = 9525;
export const PT_PX = 96 / 72;

export interface Style {
  sz: number; color: string; font: string;
  b: boolean; i: boolean; u: boolean;
}
export interface Run extends Style { text: string; }
export type Align = 'l' | 'ctr' | 'r' | 'just';
export interface Para {
  runs: Run[];
  algn: Align;
  bu: string;   // '' = no bullet, 'num' = numbered, otherwise the bullet char
  lvl: number;  // 0..8 indent level
  def: Style;   // style for empty paragraphs / newly typed text
}

export interface El {
  id: string;
  type: 'sp' | 'pic' | 'tbl';
  x: number; y: number; w: number; h: number;
  rot: number; flipH: boolean; flipV: boolean;
  geom: string;        // prstGeom name (rect, roundRect, ellipse, line, ...)
  fill: string;        // '' = no fill
  line: string;        // '' = no outline
  lineW: number;       // px
  paras: Para[];
  anchor: 't' | 'ctr' | 'b';
  ph: string;          // placeholder role ('title', 'body', ...) or ''
  media: string;       // pic: media key
  rows: string[][];    // tbl: cell text
  cols: number[];      // tbl: column widths (px)
  cell: Style;         // tbl: cell text style
  locked?: boolean;    // inherited master/layout artwork: rendered + exported, not clickable
}

export interface Slide { id: string; els: El[]; bg: string; bgMedia: string; notes: string; }
export interface Media { data: Uint8Array; ext: string; mime: string; }
export interface Deck {
  w: number; h: number;
  slides: Slide[];
  media: Record<string, Media>;
  font: string;       // body font (theme minor)
  titleFont: string;  // heading font (theme major)
}

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
  svg: 'image/svg+xml', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff',
  emf: 'image/x-emf', wmf: 'image/x-wmf',
};

export function style(over: Partial<Style> = {}): Style {
  return { sz: 18, color: '000000', font: 'Calibri', b: false, i: false, u: false, ...over };
}

export function para(text: string, s: Style, over: Partial<Para> = {}): Para {
  return { runs: text ? [{ ...s, text }] : [], algn: 'l', bu: '', lvl: 0, def: { ...s }, ...over };
}

export function newEl(over: Partial<El>): El {
  return {
    id: uid(), type: 'sp', x: 0, y: 0, w: 100, h: 100, rot: 0, flipH: false, flipV: false,
    geom: 'rect', fill: '', line: '', lineW: 1, paras: [], anchor: 't', ph: '', media: '',
    rows: [], cols: [], cell: style(), ...over,
  };
}

export const elText = (el: El): string => el.paras.map((p) => p.runs.map((r) => r.text).join('')).join('\n');

/** SVG path for a preset geometry in a w×h box (used by both SVG and canvas Path2D). */
export function geomPath(geom: string, w: number, h: number): string {
  const r = Math.min(w, h);
  switch (geom) {
    case 'ellipse':
      return `M0,${h / 2} A${w / 2},${h / 2} 0 1,0 ${w},${h / 2} A${w / 2},${h / 2} 0 1,0 0,${h / 2} Z`;
    case 'roundRect': {
      const k = r * 0.1667;
      return `M${k},0 H${w - k} Q${w},0 ${w},${k} V${h - k} Q${w},${h} ${w - k},${h} H${k} Q0,${h} 0,${h - k} V${k} Q0,0 ${k},0 Z`;
    }
    case 'triangle': return `M${w / 2},0 L${w},${h} L0,${h} Z`;
    case 'rtTriangle': return `M0,0 L${w},${h} L0,${h} Z`;
    case 'diamond': return `M${w / 2},0 L${w},${h / 2} L${w / 2},${h} L0,${h / 2} Z`;
    case 'parallelogram': { const k = r * 0.25; return `M${k},0 H${w} L${w - k},${h} H0 Z`; }
    case 'hexagon': { const k = r * 0.25; return `M${k},0 H${w - k} L${w},${h / 2} L${w - k},${h} H${k} L0,${h / 2} Z`; }
    case 'rightArrow': return `M0,${h * 0.25} H${w - h / 2} V0 L${w},${h / 2} L${w - h / 2},${h} V${h * 0.75} H0 Z`;
    case 'line': case 'straightConnector1': return `M0,0 L${w},${h}`;
    default: return `M0,0 H${w} V${h} H0 Z`;
  }
}

export const isLine = (geom: string): boolean => geom === 'line' || geom === 'straightConnector1';
