// Template gallery catalog for the game builder. Blank templates come from
// createGameDoc() in types.ts; STARTERS are fully-built levels (with objects,
// behaviors and a background) so the gallery can show real thumbnails and every
// card opens into something playable.
import { type GameDoc, type TemplateId, type TileType, createGameDoc } from './types';
import { newEntity } from './art';

export interface TemplateInfo { id: TemplateId; name: string; blurb: string; icon: string }

export const TEMPLATES: TemplateInfo[] = [
  { id: 'platformer', name: 'Platformer', blurb: 'Run and jump. Gravity, spikes, coins and a goal flag.', icon: 'gamepad' },
  { id: 'topdown', name: 'Top-down', blurb: 'Four-direction movement. Grab coins, dodge chasers.', icon: 'mousePointer' },
  { id: 'racer', name: 'Lane racer', blurb: 'Endless lane-dodge driving that speeds up.', icon: 'flag' },
];

export interface StarterInfo { id: string; name: string; blurb: string; tag: string; make(): GameDoc }

type Put = (c: number, r: number, t: TileType) => void;
function level(template: 'platformer' | 'topdown', title: string, cols: number, rows: number, bg: string, build: (put: Put, add: (type: string, x: number, y: number, props?: Record<string, number | string | boolean>) => void, doc: GameDoc) => void): GameDoc {
  const doc = createGameDoc(template, title);
  doc.level = { cols, rows, tiles: new Array(cols * rows).fill('empty'), entities: [] };
  doc.assets.sprites.bg = bg;
  const put: Put = (c, r, t) => { if (c >= 0 && r >= 0 && c < cols && r < rows) doc.level.tiles[r * cols + c] = t; };
  const add = (type: string, x: number, y: number, props: Record<string, number | string | boolean> = {}) => {
    const e = newEntity(type, x, y);
    e.props = { ...e.props, ...props };
    doc.level.entities.push(e);
  };
  build(put, add, doc);
  return doc;
}

export const STARTERS: StarterInfo[] = [
  {
    id: 'grass-hop', name: 'Grass Hop', tag: 'Platformer', blurb: 'Hop over gaps, ride a moving platform, stomp a slime.',
    make: () => level('platformer', 'Grass Hop', 36, 14, 'sky', (put, add) => {
      for (let c = 0; c < 36; c++) if (c < 10 || (c > 13 && c < 24) || c > 27) put(c, 13, 'ground');
      for (let c = 0; c < 36; c++) if (c < 10 || (c > 13 && c < 24) || c > 27) put(c, 12, 'ground');
      put(1, 11, 'start'); put(34, 11, 'goal');
      for (const c of [6, 7, 8]) put(c, 9, 'coin');
      put(19, 11, 'spike'); put(20, 11, 'spike');
      add('platform', 11, 10, { w: 2 }); add('mover', 24, 9, { range: 3 });
      add('spring', 15, 11.2); add('enemy', 29, 11, { range: 4 });
      add('coin', 12, 8.5); add('coin', 13, 8.5); add('gem', 26.5, 6);
      add('cloud', 4, 2); add('cloud', 18, 1.5); add('cloud', 30, 3); add('tree', 3, 9.6); add('bush', 22, 11);
    }),
  },
  {
    id: 'saw-run', name: 'Saw Run', tag: 'Runner', blurb: 'A long sunset sprint past spikes, saws and flyers.',
    make: () => level('platformer', 'Saw Run', 48, 12, 'dusk', (put, add, doc) => {
      doc.settings.speed = 260;
      for (let c = 0; c < 48; c++) { put(c, 11, 'ground'); put(c, 10, 'ground'); }
      put(1, 9, 'start'); put(46, 9, 'goal');
      for (const c of [10, 11, 22, 23, 24, 36]) put(c, 9, 'spike');
      for (const c of [14, 15, 16, 17]) put(c, 6, 'coin');
      add('saw', 18, 9, { range: 4 }); add('saw', 30, 9, { range: 3 });
      add('flyer', 26, 5, { range: 3 }); add('flyer', 40, 4, { range: 3 });
      add('platform', 20, 7, { w: 4 }); add('spring', 33, 9.2); add('gem', 34, 3);
      add('enemy', 42, 9, { range: 2 });
    }),
  },
  {
    id: 'coin-maze', name: 'Coin Maze', tag: 'Top-down', blurb: 'Collect every coin in the maze, avoid the chaser.',
    make: () => level('topdown', 'Coin Maze', 20, 14, 'mint', (put) => {
      for (let c = 0; c < 20; c++) { put(c, 0, 'ground'); put(c, 13, 'ground'); }
      for (let r = 0; r < 14; r++) { put(0, r, 'ground'); put(19, r, 'ground'); }
      for (let r = 2; r < 9; r++) put(5, r, 'ground');
      for (let c = 5; c < 13; c++) put(c, 9, 'ground');
      for (let r = 3; r < 12; r++) put(13, r, 'ground');
      for (let c = 14; c < 18; c++) put(c, 5, 'ground');
      put(2, 2, 'start'); put(17, 11, 'goal'); put(9, 4, 'enemy'); put(16, 8, 'enemy');
      for (const [c, r] of [[3, 7], [8, 2], [10, 6], [9, 11], [15, 3], [16, 11], [2, 11], [11, 11]] as const) put(c, r, 'coin');
      put(7, 6, 'spike'); put(15, 7, 'spike');
    }),
  },
  {
    id: 'night-climb', name: 'Night Climb', tag: 'Platformer', blurb: 'Vertical hops on floating stones under the stars.',
    make: () => level('platformer', 'Night Climb', 18, 20, 'night', (put, add) => {
      for (let c = 0; c < 18; c++) put(c, 19, 'ground');
      put(2, 18, 'start'); put(14, 1, 'goal');
      add('platform', 5, 16, { w: 3 }); add('platform', 10, 13, { w: 3 }); add('mover', 2, 10, { range: 6, w: 3 });
      add('platform', 11, 6, { w: 3 }); add('platform', 13, 2.5, { w: 4 }); add('spring', 8, 18.2);
      add('coin', 6, 14.8); add('coin', 11, 11.8); add('gem', 12, 4.6); add('flyer', 6, 8, { range: 3 });
      add('enemy', 12, 12.2, { range: 1.5, w: 0.9, h: 0.9 });
    }),
  },
];

// The paintable tile palette (tile art comes from the doc's sprite map).
export interface PaletteEntry { tile: TileType; label: string }
export const PALETTE: PaletteEntry[] = [
  { tile: 'ground', label: 'Ground' },
  { tile: 'spike', label: 'Spikes' },
  { tile: 'coin', label: 'Coin' },
  { tile: 'enemy', label: 'Slime' },
  { tile: 'start', label: 'Spawn' },
  { tile: 'goal', label: 'Goal' },
];

export const SOUND_PRESETS = [
  { id: 'retro', label: 'Retro' }, { id: 'soft', label: 'Soft' }, { id: 'arcade', label: 'Arcade' }, { id: 'off', label: 'Off' },
] as const;
