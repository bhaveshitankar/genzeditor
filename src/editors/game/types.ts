// Canonical .game document model + edit operations. This is the unit stored in
// OPFS (as JSON) AND the unit synced in a live room, so both the GameEditor and
// the room sync layer depend on it. Keep it small, serializable, and stable.

export type TemplateId = 'platformer' | 'topdown' | 'racer';

// Tiles paintable on the level grid. 'start' marks the player spawn; 'goal' the
// win tile. 'coin' is collectible; 'spike'/'enemy' are hazards.
export type TileType = 'empty' | 'ground' | 'spike' | 'coin' | 'start' | 'goal' | 'enemy';

export interface GameSettings {
  gravity: number;   // px/s^2 (platformer); 0 for topdown/racer
  jump: number;      // initial jump velocity (platformer)
  speed: number;     // player move speed px/s (racer: initial scroll speed)
  lives: number;     // starting lives
  tileSize: number;  // px per tile in the render/engine
  lanes?: number;    // racer: number of road lanes (defaults to 3)
  obstacleRate?: number; // racer: seconds between obstacle spawns (defaults to 1.1)
}

// Free-floating, non-grid objects (moving platforms, decorations, extra spawns).
export interface Entity {
  id: string;
  type: string;      // e.g. 'enemy', 'platform', 'decor'
  x: number;         // tile-space coords (can be fractional)
  y: number;
  props?: Record<string, number | string | boolean>;
}

export interface GameLevel {
  cols: number;
  rows: number;
  tiles: TileType[]; // length === cols*rows, row-major (index = r*cols + c)
  entities: Entity[];
}

// Visual mapping for tiles/entity types → an emoji glyph or a data: URL sprite.
export interface GameAssets {
  sprites: Record<string, string>;
}

export interface GameDoc {
  version: 1;
  template: TemplateId;
  meta: { title: string };
  settings: GameSettings;
  level: GameLevel;
  assets: GameAssets;
}

// Edit operations — the atomic, replayable changes broadcast in a room and used
// for local undo. applyOp() MUST be a pure in-place mutation with no I/O so it
// can be applied identically on every peer.
export type GameOp =
  | { t: 'tile'; i: number; v: TileType }
  | { t: 'resize'; cols: number; rows: number; tiles: TileType[] }
  | { t: 'entity.add'; e: Entity }
  | { t: 'entity.move'; id: string; x: number; y: number }
  | { t: 'entity.del'; id: string }
  | { t: 'setting'; k: keyof GameSettings; v: number }
  | { t: 'asset'; k: string; v: string }
  | { t: 'meta'; title: string };

export function applyOp(doc: GameDoc, op: GameOp): void {
  switch (op.t) {
    case 'tile':
      if (op.i >= 0 && op.i < doc.level.tiles.length) doc.level.tiles[op.i] = op.v;
      break;
    case 'resize':
      doc.level.cols = op.cols;
      doc.level.rows = op.rows;
      doc.level.tiles = op.tiles;
      break;
    case 'entity.add':
      doc.level.entities.push(op.e);
      break;
    case 'entity.move': {
      const e = doc.level.entities.find((x) => x.id === op.id);
      if (e) { e.x = op.x; e.y = op.y; }
      break;
    }
    case 'entity.del':
      doc.level.entities = doc.level.entities.filter((x) => x.id !== op.id);
      break;
    case 'setting':
      doc.settings[op.k] = op.v;
      break;
    case 'asset':
      doc.assets.sprites[op.k] = op.v;
      break;
    case 'meta':
      doc.meta.title = op.title;
      break;
  }
}

const DEFAULT_SETTINGS: Record<TemplateId, GameSettings> = {
  platformer: { gravity: 1800, jump: 620, speed: 220, lives: 3, tileSize: 32 },
  topdown: { gravity: 0, jump: 0, speed: 200, lives: 3, tileSize: 32 },
  racer: { gravity: 0, jump: 0, speed: 260, lives: 3, tileSize: 96, lanes: 3, obstacleRate: 1.1 },
};

const DEFAULT_SPRITES: Record<string, string> = {
  ground: '🟫', spike: '🔺', coin: '🪙', start: '🏁', goal: '🚩',
  enemy: '👾', player: '🙂',
};

// Racer reuses the sprite map but with driving-themed glyphs: 'player' is the
// car, 'enemy' the oncoming obstacle, 'coin' the pickup.
const RACER_SPRITES: Record<string, string> = {
  ...DEFAULT_SPRITES, player: '🏎️', enemy: '🚗', coin: '🪙',
};

export function createGameDoc(template: TemplateId, title: string): GameDoc {
  if (template === 'racer') {
    // Racer gameplay is procedural (lanes + spawns), so the tile grid is just a
    // nominal road; the engine ignores it. Keep it narrow and tall.
    const lanes = DEFAULT_SETTINGS.racer.lanes ?? 3;
    const cols = lanes, rows = 9;
    return {
      version: 1,
      template,
      meta: { title },
      settings: { ...DEFAULT_SETTINGS.racer },
      level: { cols, rows, tiles: new Array(cols * rows).fill('empty'), entities: [] },
      assets: { sprites: { ...RACER_SPRITES } },
    };
  }
  const cols = 24, rows = 14;
  const tiles: TileType[] = new Array(cols * rows).fill('empty');
  // A tiny starter level: floor row, a start on the left, a goal on the right.
  for (let c = 0; c < cols; c++) tiles[(rows - 1) * cols + c] = 'ground';
  tiles[(rows - 2) * cols + 1] = 'start';
  tiles[(rows - 2) * cols + (cols - 2)] = 'goal';
  return {
    version: 1,
    template,
    meta: { title },
    settings: { ...DEFAULT_SETTINGS[template] },
    level: { cols, rows, tiles, entities: [] },
    assets: { sprites: { ...DEFAULT_SPRITES } },
  };
}

export function serializeGameDoc(doc: GameDoc): string {
  return JSON.stringify(doc);
}

// Parse + tolerate older/partial docs by filling defaults. Throws on non-JSON.
export function parseGameDoc(text: string): GameDoc {
  const raw = JSON.parse(text) as Partial<GameDoc>;
  const template: TemplateId = raw.template === 'topdown' ? 'topdown'
    : raw.template === 'racer' ? 'racer'
    : 'platformer';
  const base = createGameDoc(template, raw.meta?.title ?? 'Untitled game');
  return {
    version: 1,
    template,
    meta: { title: raw.meta?.title ?? base.meta.title },
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    level: raw.level && Array.isArray(raw.level.tiles)
      ? { cols: raw.level.cols, rows: raw.level.rows, tiles: raw.level.tiles, entities: raw.level.entities ?? [] }
      : base.level,
    assets: { sprites: { ...base.assets.sprites, ...(raw.assets?.sprites ?? {}) } },
  };
}
