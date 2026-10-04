// Ready-to-play arenas: fully-built racer GameDocs that open straight into Play
// mode so anyone can start instantly, no building required. Each is just a tuned
// GameDoc (reuses createGameDoc, then overrides theme + difficulty), so players
// can still edit their copy afterwards.
import { type GameDoc, createGameDoc } from './types';

export interface ArenaInfo {
  id: string;
  name: string;
  blurb: string;
  icon: string;
  make(): GameDoc;
}

// Build a racer doc, then apply a theme (sprite glyphs) + difficulty overrides.
function racer(
  title: string,
  opts: {
    lanes: number; speed: number; obstacleRate: number; lives: number;
    car: string; traffic: string; coin: string;
  },
): GameDoc {
  const doc = createGameDoc('racer', title);
  const lanes = opts.lanes;
  doc.level = { cols: lanes, rows: 9, tiles: new Array(lanes * 9).fill('empty'), entities: [] };
  doc.settings = {
    ...doc.settings,
    lanes, speed: opts.speed, obstacleRate: opts.obstacleRate, lives: opts.lives,
  };
  doc.assets.sprites = {
    ...doc.assets.sprites,
    player: opts.car, enemy: opts.traffic, coin: opts.coin,
  };
  return doc;
}

export const ARENAS: ArenaInfo[] = [
  {
    id: 'city-dash',
    name: 'City Dash',
    blurb: '3 lanes, chill start. The friendly on-ramp.',
    icon: '🚕',
    make: () => racer('City Dash', { lanes: 3, speed: 240, obstacleRate: 1.2, lives: 3, car: '🏎️', traffic: '🚕', coin: '🪙' }),
  },
  {
    id: 'highway-night',
    name: 'Highway Night',
    blurb: '4 lanes, fast traffic, headlights only. Sweaty.',
    icon: '🌃',
    make: () => racer('Highway Night', { lanes: 4, speed: 320, obstacleRate: 0.85, lives: 3, car: '🏎️', traffic: '🚙', coin: '💎' }),
  },
  {
    id: 'desert-rally',
    name: 'Desert Rally',
    blurb: '3 lanes, wide and bumpy, speed ramps hard.',
    icon: '🏜️',
    make: () => racer('Desert Rally', { lanes: 3, speed: 300, obstacleRate: 1.0, lives: 2, car: '🚙', traffic: '🚜', coin: '🪙' }),
  },
  {
    id: 'coin-rush',
    name: 'Coin Rush',
    blurb: '5 lanes stuffed with coins. Go get the bag.',
    icon: '🪙',
    make: () => racer('Coin Rush', { lanes: 5, speed: 280, obstacleRate: 1.4, lives: 5, car: '🏎️', traffic: '🚗', coin: '🪙' }),
  },
];
