// Built-in vector art for the game builder: SVG sprites (no emoji), parallax
// backgrounds, the prefab catalog and entity helpers. Sprites are tiny inline
// SVG data: URLs so they embed in a .game doc and sync through a room unchanged.
import type { Entity, GameDoc } from './types';

const uri = (inner: string, par = 'xMidYMid meet') =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" preserveAspectRatio="${par}">${inner}</svg>`,
  )}`;

const eyes = (y = 26) =>
  `<circle cx="24" cy="${y}" r="6" fill="#fff"/><circle cx="40" cy="${y}" r="6" fill="#fff"/>` +
  `<circle cx="26" cy="${y + 1}" r="3" fill="#16121f"/><circle cx="42" cy="${y + 1}" r="3" fill="#16121f"/>`;

function car(body: string, dark: string, roof = '#cfe9ff'): string {
  return uri(
    `<rect x="14" y="3" width="36" height="58" rx="13" fill="${body}"/>` +
    `<rect x="14" y="3" width="36" height="58" rx="13" fill="none" stroke="${dark}" stroke-width="3"/>` +
    `<rect x="19" y="16" width="26" height="14" rx="5" fill="${roof}"/>` +
    `<rect x="19" y="38" width="26" height="12" rx="4" fill="${dark}" opacity=".35"/>` +
    `<rect x="17" y="6" width="8" height="5" rx="2" fill="#fff6b0"/><rect x="39" y="6" width="8" height="5" rx="2" fill="#fff6b0"/>` +
    `<rect x="10" y="12" width="5" height="12" rx="2" fill="#222"/><rect x="49" y="12" width="5" height="12" rx="2" fill="#222"/>` +
    `<rect x="10" y="42" width="5" height="12" rx="2" fill="#222"/><rect x="49" y="42" width="5" height="12" rx="2" fill="#222"/>`,
  );
}

export const SPRITES: Record<string, string> = {
  ground: uri(
    '<rect width="64" height="64" fill="#8a5a3b"/><rect y="0" width="64" height="64" fill="#a06a45" opacity=".35"/>' +
    '<circle cx="14" cy="18" r="4" fill="#6f452b"/><circle cx="44" cy="30" r="5" fill="#6f452b"/><circle cx="26" cy="48" r="4" fill="#6f452b"/>' +
    '<circle cx="54" cy="56" r="3" fill="#6f452b"/><rect width="64" height="64" fill="none" stroke="#5e3a24" stroke-width="2"/>',
  ),
  ground_top: uri(
    '<rect width="64" height="64" fill="#8a5a3b"/><circle cx="14" cy="38" r="4" fill="#6f452b"/><circle cx="46" cy="50" r="5" fill="#6f452b"/>' +
    '<circle cx="30" cy="30" r="3" fill="#6f452b"/><rect width="64" height="18" fill="#58c864"/><rect width="64" height="6" fill="#7be07f"/>' +
    '<path d="M0 18q8 10 16 0t16 0 16 0 16 0v-2H0z" fill="#58c864"/><rect width="64" height="64" fill="none" stroke="#5e3a24" stroke-width="2"/>',
  ),
  spike: uri(
    '<path d="M4 60 20 16 32 60zM28 60 44 10 60 60z" fill="#c9cfe0" stroke="#5d6482" stroke-width="3" stroke-linejoin="round"/>' +
    '<path d="M20 16 14 60M44 10 38 60" stroke="#fff" stroke-width="3" opacity=".6"/><rect x="2" y="58" width="60" height="6" rx="2" fill="#5d6482"/>',
  ),
  coin: uri(
    '<circle cx="32" cy="32" r="22" fill="#ffc53d" stroke="#c98a00" stroke-width="4"/><circle cx="32" cy="32" r="14" fill="none" stroke="#ffe27a" stroke-width="4"/>' +
    '<path d="M32 22v20M27 27h8a3 3 0 0 1 0 6h-6a3 3 0 0 0 0 6h8" stroke="#c98a00" stroke-width="3" fill="none" stroke-linecap="round"/>',
  ),
  start: uri(
    '<rect x="8" y="46" width="48" height="12" rx="6" fill="#4d6bff"/><rect x="8" y="46" width="48" height="5" rx="3" fill="#8ea2ff"/>' +
    '<path d="M32 10 46 32H38V42H26V32H18z" fill="#ff4d8d" stroke="#16121f" stroke-width="3" stroke-linejoin="round"/>',
  ),
  goal: uri(
    '<rect x="14" y="6" width="6" height="54" rx="3" fill="#e8e4f5" stroke="#16121f" stroke-width="2"/>' +
    '<path d="M20 8h30l-8 11 8 11H20z" fill="#ff4d8d" stroke="#16121f" stroke-width="3" stroke-linejoin="round"/><circle cx="17" cy="6" r="5" fill="#ffc53d" stroke="#16121f" stroke-width="2"/>',
  ),
  enemy: uri(
    '<path d="M8 56c0-26 10-44 24-44s24 18 24 44z" fill="#9b5cff" stroke="#16121f" stroke-width="3" stroke-linejoin="round"/>' +
    eyes(34) + '<path d="M22 48q10 6 20 0" stroke="#16121f" stroke-width="3" fill="none" stroke-linecap="round"/>',
  ),
  player: uri(
    '<rect x="14" y="8" width="36" height="46" rx="16" fill="#ff4d8d" stroke="#16121f" stroke-width="3"/>' +
    '<rect x="18" y="12" width="14" height="8" rx="4" fill="#ff8fb7"/>' + eyes(26) +
    '<rect x="16" y="54" width="14" height="8" rx="4" fill="#16121f"/><rect x="34" y="54" width="14" height="8" rx="4" fill="#16121f"/>',
  ),
  // ---- prefabs (objects) ----
  platform: uri(
    '<rect x="1" y="14" width="62" height="36" rx="8" fill="#7d86a8" stroke="#3d4466" stroke-width="3"/><rect x="1" y="14" width="62" height="12" rx="8" fill="#a9b2d4"/>' +
    '<rect x="8" y="36" width="12" height="4" rx="2" fill="#5d6482"/><rect x="40" y="38" width="14" height="4" rx="2" fill="#5d6482"/>', 'none',
  ),
  mover: uri(
    '<rect x="1" y="14" width="62" height="36" rx="8" fill="#4d6bff" stroke="#16121f" stroke-width="3"/><rect x="1" y="14" width="62" height="12" rx="8" fill="#8ea2ff"/>' +
    '<path d="M14 38h36M20 32l-7 6 7 6M44 32l7 6-7 6" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>', 'none',
  ),
  crate: uri(
    '<rect x="4" y="4" width="56" height="56" rx="6" fill="#d99a4e" stroke="#7a4b1a" stroke-width="4"/>' +
    '<path d="M8 8 56 56M56 8 8 56" stroke="#7a4b1a" stroke-width="4"/><rect x="4" y="4" width="56" height="10" rx="5" fill="#f0b86b" opacity=".6"/>',
  ),
  spring: uri(
    '<rect x="8" y="52" width="48" height="8" rx="3" fill="#16121f"/><path d="M14 52 50 44 14 36 50 28 14 20" stroke="#8a93b8" stroke-width="5" fill="none" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<rect x="8" y="10" width="48" height="10" rx="4" fill="#ff4d8d" stroke="#16121f" stroke-width="3"/>',
  ),
  gem: uri(
    '<path d="M32 6 54 24 32 58 10 24z" fill="#3ddcc0" stroke="#0b7a68" stroke-width="3" stroke-linejoin="round"/><path d="M10 24h44M22 24 32 6l10 18-10 34z" stroke="#0b7a68" stroke-width="2" fill="#7ff0dc" opacity=".75"/>',
  ),
  saw: uri(
    '<circle cx="32" cy="32" r="26" fill="#c9cfe0" stroke="#16121f" stroke-width="3"/>' +
    Array.from({ length: 8 }, (_, i) => `<path d="M32 2 38 14H26z" fill="#c9cfe0" stroke="#16121f" stroke-width="3" stroke-linejoin="round" transform="rotate(${i * 45} 32 32)"/>`).join('') +
    '<circle cx="32" cy="32" r="9" fill="#e11d63" stroke="#16121f" stroke-width="3"/>',
  ),
  flyer: uri(
    '<path d="M32 22 6 10q4 22 26 26zM32 22 58 10q-4 22-26 26z" fill="#2c2440" stroke="#16121f" stroke-width="3" stroke-linejoin="round"/>' +
    '<ellipse cx="32" cy="34" rx="14" ry="16" fill="#ff7a3d" stroke="#16121f" stroke-width="3"/>' + eyes(30).replace(/r="6"/g, 'r="5"'),
  ),
  cloud: uri(
    '<path d="M14 46a12 12 0 0 1 2-23 16 16 0 0 1 30-4 13 13 0 0 1 4 27z" fill="#fff" opacity=".95"/>', 'xMidYMid meet',
  ),
  tree: uri(
    '<rect x="28" y="38" width="9" height="24" rx="3" fill="#7a4b2a"/><circle cx="32" cy="24" r="20" fill="#3fb36b"/><circle cx="22" cy="30" r="12" fill="#58c864"/><circle cx="42" cy="18" r="10" fill="#2f9a58"/>',
  ),
  bush: uri(
    '<path d="M4 58a14 14 0 0 1 8-26 16 16 0 0 1 28-6 14 14 0 0 1 20 32z" fill="#3fb36b"/><path d="M14 58a10 10 0 0 1 8-16 12 12 0 0 1 20 4 10 10 0 0 1 8 12z" fill="#58c864"/>',
  ),
  // ---- cars (racer) ----
  car_pink: car('#ff4d8d', '#8f1243'),
  car_blue: car('#4d6bff', '#1c2a8a'),
  car_gold: car('#ffc53d', '#8a5c00'),
  car_mint: car('#3ddcc0', '#0b6b5a'),
  car_taxi: car('#ffd23d', '#7a5d00', '#fff'),
  car_truck: car('#8a93b8', '#3d4466'),
  car_red: car('#e11d3f', '#6b0a1d'),
  car_violet: car('#9b5cff', '#41208a'),
};

// Old emoji defaults → the SVG key that replaces them (used to migrate docs).
const EMOJI_MIGRATE: Record<string, Record<string, string>> = {
  ground: { '🟫': 'ground' }, spike: { '🔺': 'spike' }, coin: { '🪙': 'coin', '💎': 'gem' },
  start: { '🏁': 'start' }, goal: { '🚩': 'goal' }, enemy: { '👾': 'enemy', '🚗': 'car_blue', '🚕': 'car_taxi', '🚙': 'car_mint', '🚜': 'car_truck' },
  player: { '🙂': 'player', '🏎️': 'car_pink', '🚙': 'car_mint' },
};

/** Replace stock emoji sprite values with the built-in SVG art; keep custom values. */
export function migrateSprites(sprites: Record<string, string>, racer: boolean): Record<string, string> {
  const out: Record<string, string> = { ...sprites };
  for (const k of Object.keys(EMOJI_MIGRATE)) {
    const v = out[k];
    const to = v !== undefined ? EMOJI_MIGRATE[k]![v] : undefined;
    if (to) out[k] = SPRITES[to]!;
  }
  if (racer && out.player === SPRITES.player) out.player = SPRITES.car_pink!;
  if (racer && out.enemy === SPRITES.enemy) out.enemy = SPRITES.car_blue!;
  return out;
}

export function defaultSprites(racer = false): Record<string, string> {
  const base: Record<string, string> = {
    ground: SPRITES.ground!, spike: SPRITES.spike!, coin: SPRITES.coin!, start: SPRITES.start!,
    goal: SPRITES.goal!, enemy: SPRITES.enemy!, player: SPRITES.player!, bg: 'sky', sfx: 'retro',
  };
  if (racer) { base.player = SPRITES.car_pink!; base.enemy = SPRITES.car_blue!; base.bg = 'road'; }
  return base;
}

// ---- Image cache --------------------------------------------------------
const imgs = new Map<string, HTMLImageElement>();
export function imgFor(src: string, onLoad?: () => void): HTMLImageElement | null {
  if (typeof Image === 'undefined') return null;
  let im = imgs.get(src);
  if (!im) {
    im = new Image();
    if (onLoad) im.onload = onLoad;
    im.src = src;
    imgs.set(src, im);
  } else if (onLoad && !im.complete) {
    const prev = im.onload;
    im.onload = (e) => { (prev as ((e: Event) => void) | null)?.(e); onLoad(); };
  }
  return im.complete && im.naturalWidth ? im : null;
}

/** Resolve the drawable source for a sprite key (doc override first, then built-in). */
export function spriteSrc(doc: GameDoc, key: string): string {
  return doc.assets.sprites[key] ?? SPRITES[key] ?? '';
}

/** Draw a sprite key (data URL, built-in key, or leftover emoji text) into a box. */
export function drawSprite(
  ctx: CanvasRenderingContext2D, doc: GameDoc, key: string,
  x: number, y: number, w: number, h: number, onLoad?: () => void,
): void {
  const v = spriteSrc(doc, key);
  if (!v) return;
  if (v.startsWith('data:')) {
    const im = imgFor(v, onLoad);
    if (im) ctx.drawImage(im, x, y, w, h);
  } else {
    ctx.font = `${Math.floor(Math.min(w, h) * 0.85)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(v, x + w / 2, y + h / 2);
  }
}

/** Ground tiles get a grass cap when nothing solid sits above (stock art only). */
export function tileKey(doc: GameDoc, key: string, c: number, r: number): string {
  if (key !== 'ground' || doc.assets.sprites.ground !== SPRITES.ground) return key;
  const { cols, tiles } = doc.level;
  return r > 0 && tiles[(r - 1) * cols + c] === 'ground' ? 'ground' : 'ground_top';
}

// ---- Backgrounds ----------------------------------------------------------
export interface BgTheme { id: string; label: string; top: string; bottom: string; far: string; near: string; stars?: boolean }
export const BACKGROUNDS: BgTheme[] = [
  { id: 'sky', label: 'Daybreak', top: '#7fd3ff', bottom: '#e6f7ff', far: '#9fdcb4', near: '#6cc48a' },
  { id: 'dusk', label: 'Sunset', top: '#ff7a8a', bottom: '#ffd7a0', far: '#b05a8c', near: '#7c3d78' },
  { id: 'night', label: 'Midnight', top: '#0f0c29', bottom: '#2b2d6e', far: '#2f3a7a', near: '#1f2656', stars: true },
  { id: 'cave', label: 'Cavern', top: '#1a1423', bottom: '#33283f', far: '#3d3050', near: '#2a2038' },
  { id: 'mint', label: 'Mint', top: '#c8fff0', bottom: '#f4fffb', far: '#8fe3c8', near: '#5fcfa9' },
  { id: 'road', label: 'Asphalt', top: '#23262e', bottom: '#23262e', far: '#23262e', near: '#23262e' },
];
export const bgTheme = (id: string | undefined): BgTheme => BACKGROUNDS.find((b) => b.id === id) ?? BACKGROUNDS[0]!;

/** Paint a themed backdrop over the rect (x,y,w,h); `scroll` drives parallax. */
export function drawBackground(ctx: CanvasRenderingContext2D, id: string | undefined, x: number, y: number, w: number, h: number, scroll = 0): void {
  const t = bgTheme(id);
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, t.top); g.addColorStop(1, t.bottom);
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  if (t.id === 'road') return;
  if (t.stars) {
    ctx.fillStyle = 'rgba(255,255,255,.8)';
    for (let i = 0; i < 40; i++) {
      const sx = x + ((i * 97) % 100) / 100 * w, sy = y + ((i * 53) % 70) / 100 * h;
      ctx.fillRect(sx, sy, i % 3 === 0 ? 2.5 : 1.5, i % 3 === 0 ? 2.5 : 1.5);
    }
  }
  const hills = (col: string, base: number, amp: number, freq: number, par: number) => {
    ctx.fillStyle = col; ctx.beginPath(); ctx.moveTo(x, y + h);
    for (let i = 0; i <= 40; i++) {
      const px = x + (i / 40) * w;
      ctx.lineTo(px, y + h * base - Math.sin((px - scroll * par) * freq) * amp * h - Math.sin((px - scroll * par) * freq * 2.3) * amp * h * 0.4);
    }
    ctx.lineTo(x + w, y + h); ctx.closePath(); ctx.fill();
  };
  hills(t.far, 0.78, 0.07, 0.006, 0.2);
  hills(t.near, 0.9, 0.05, 0.01, 0.45);
}

// ---- Prefab catalog -------------------------------------------------------
export type Behavior = 'none' | 'solid' | 'enemy' | 'collect' | 'hazard' | 'bounce' | 'goal';
export type Motion = 'none' | 'h' | 'v';
export const BEHAVIORS: { id: Behavior; label: string; hint: string }[] = [
  { id: 'none', label: 'Decor', hint: 'Visual only' },
  { id: 'solid', label: 'Solid', hint: 'Player can stand on it' },
  { id: 'enemy', label: 'Enemy', hint: 'Hurts; stomp it in a platformer' },
  { id: 'collect', label: 'Collect', hint: 'Pickup adds score' },
  { id: 'hazard', label: 'Hazard', hint: 'Costs a life on touch' },
  { id: 'bounce', label: 'Bounce', hint: 'Launches the player' },
  { id: 'goal', label: 'Goal', hint: 'Touch to win' },
];
export const MOTIONS: { id: Motion; label: string }[] = [
  { id: 'none', label: 'Still' }, { id: 'h', label: 'Patrol H' }, { id: 'v', label: 'Patrol V' },
];

export interface Prefab {
  id: string; label: string; cat: 'objects' | 'enemies' | 'items' | 'decor';
  w: number; h: number; behavior: Behavior; motion?: Motion; range?: number; speed?: number; z?: number; value?: number;
}
export const PREFABS: Prefab[] = [
  { id: 'platform', label: 'Platform', cat: 'objects', w: 3, h: 0.7, behavior: 'solid' },
  { id: 'mover', label: 'Mover', cat: 'objects', w: 3, h: 0.7, behavior: 'solid', motion: 'h', range: 4, speed: 1.6 },
  { id: 'crate', label: 'Crate', cat: 'objects', w: 1, h: 1, behavior: 'solid' },
  { id: 'spring', label: 'Spring', cat: 'objects', w: 1, h: 0.8, behavior: 'bounce' },
  { id: 'saw', label: 'Saw', cat: 'enemies', w: 1, h: 1, behavior: 'hazard', motion: 'h', range: 3, speed: 2 },
  { id: 'enemy', label: 'Slime', cat: 'enemies', w: 1, h: 1, behavior: 'enemy', motion: 'h', range: 3, speed: 1.2 },
  { id: 'flyer', label: 'Flyer', cat: 'enemies', w: 1, h: 1, behavior: 'enemy', motion: 'v', range: 2, speed: 1.4 },
  { id: 'coin', label: 'Coin', cat: 'items', w: 0.8, h: 0.8, behavior: 'collect', value: 1 },
  { id: 'gem', label: 'Gem', cat: 'items', w: 0.9, h: 0.9, behavior: 'collect', value: 5 },
  { id: 'cloud', label: 'Cloud', cat: 'decor', w: 3, h: 2, behavior: 'none', z: -2 },
  { id: 'tree', label: 'Tree', cat: 'decor', w: 2, h: 2.4, behavior: 'none', z: -1 },
  { id: 'bush', label: 'Bush', cat: 'decor', w: 2, h: 1, behavior: 'none', z: -1 },
];
export const prefabOf = (id: string) => PREFABS.find((p) => p.id === id);

export interface EntN {
  w: number; h: number; rot: number; z: number; o: number; name: string;
  behavior: Behavior; motion: Motion; range: number; speed: number; value: number;
  hidden: boolean; locked: boolean; flip: boolean;
}
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** Normalized view of an entity's props with prefab defaults filled in. */
export function normEntity(e: Entity): EntN {
  const p = e.props ?? {};
  const pf = prefabOf(e.type);
  const b = String(p.behavior ?? pf?.behavior ?? (e.type === 'enemy' ? 'enemy' : 'none')) as Behavior;
  const m = String(p.motion ?? pf?.motion ?? 'none') as Motion;
  return {
    w: Math.max(0.2, num(p.w, pf?.w ?? 1)), h: Math.max(0.2, num(p.h, pf?.h ?? 1)),
    rot: num(p.rot, 0), z: num(p.z, pf?.z ?? 0), o: num(p.o, 0),
    name: typeof p.name === 'string' && p.name ? p.name : (pf?.label ?? e.type),
    behavior: BEHAVIORS.some((x) => x.id === b) ? b : 'none',
    motion: m === 'h' || m === 'v' ? m : 'none',
    range: Math.max(0, num(p.range, pf?.range ?? 3)), speed: Math.max(0.1, num(p.speed, pf?.speed ?? 1.5)),
    value: num(p.value, pf?.value ?? 1), hidden: p.hidden === true, locked: p.locked === true, flip: p.flip === true,
  };
}

let seq = 0;
export function newEntity(type: string, x: number, y: number): Entity {
  const pf = prefabOf(type);
  seq++;
  return {
    id: `e${Date.now().toString(36)}${seq.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    type, x, y,
    props: {
      w: pf?.w ?? 1, h: pf?.h ?? 1, behavior: pf?.behavior ?? 'none', motion: pf?.motion ?? 'none',
      range: pf?.range ?? 3, speed: pf?.speed ?? 1.5, z: pf?.z ?? 0, value: pf?.value ?? 1, o: Date.now() % 1e9 + seq,
    },
  };
}

/** Entities in paint order (back to front). */
export function sortedEntities(doc: GameDoc): Entity[] {
  return [...doc.level.entities].sort((a, b) => {
    const na = normEntity(a), nb = normEntity(b);
    return na.z - nb.z || na.o - nb.o;
  });
}

// Thumbnail for the template gallery: a tiny SVG rendering of a doc's level.
export function docThumbnail(doc: GameDoc): string {
  const { cols, rows, tiles } = doc.level;
  const t = bgTheme(doc.assets.sprites.bg);
  const W = 160, H = 100;
  const sx = W / cols, sy = H / rows;
  let s = `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.top}"/><stop offset="1" stop-color="${t.bottom}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/>`;
  if (doc.template === 'racer') {
    const lanes = doc.settings.lanes ?? 3;
    for (let i = 1; i < lanes; i++) s += `<line x1="${(W / lanes) * i}" y1="0" x2="${(W / lanes) * i}" y2="${H}" stroke="#fff" stroke-opacity=".5" stroke-dasharray="8 8" stroke-width="2"/>`;
    const cw = W / lanes;
    s += `<rect x="${cw * 0.2}" y="12" width="${cw * 0.6}" height="22" rx="6" fill="#4d6bff"/>`;
    s += `<rect x="${cw * (lanes - 0.8)}" y="48" width="${cw * 0.6}" height="22" rx="6" fill="#ffc53d"/>`;
    s += `<rect x="${cw * (Math.floor(lanes / 2) + 0.2)}" y="72" width="${cw * 0.6}" height="22" rx="6" fill="#ff4d8d"/>`;
  } else {
    const col: Record<string, string> = { ground: '#8a5a3b', spike: '#c9cfe0', coin: '#ffc53d', start: '#4d6bff', goal: '#ff4d8d', enemy: '#9b5cff' };
    for (let i = 0; i < tiles.length; i++) {
      const c = col[tiles[i]!];
      if (!c) continue;
      const x = (i % cols) * sx, y = Math.floor(i / cols) * sy;
      s += tiles[i] === 'ground' ? `<rect x="${x}" y="${y}" width="${sx + 0.4}" height="${sy + 0.4}" fill="${c}"/>`
        : `<circle cx="${x + sx / 2}" cy="${y + sy / 2}" r="${Math.min(sx, sy) * 0.4}" fill="${c}"/>`;
    }
    const ecol: Record<string, string> = { platform: '#7d86a8', mover: '#4d6bff', crate: '#d99a4e', enemy: '#9b5cff', flyer: '#ff7a3d', saw: '#c9cfe0', coin: '#ffc53d', gem: '#3ddcc0', spring: '#ff4d8d', cloud: '#fff', tree: '#3fb36b', bush: '#3fb36b' };
    for (const e of sortedEntities(doc)) {
      const n = normEntity(e);
      s += `<rect x="${e.x * sx}" y="${e.y * sy}" width="${n.w * sx}" height="${n.h * sy}" rx="2" fill="${ecol[e.type] ?? '#888'}" opacity="${n.behavior === 'none' ? 0.7 : 1}"/>`;
    }
  }
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">${s}</svg>`)}`;
}
