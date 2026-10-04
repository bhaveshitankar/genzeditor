// Beginner-facing template catalog for the game builder. Each entry maps a
// TemplateId to a friendly label, blurb, and glyph shown in the picker. The
// actual starter docs are produced by createGameDoc() in types.ts — this file is
// purely presentation so the UI stays declarative.
import type { TemplateId } from './types';

export interface TemplateInfo {
  id: TemplateId;
  name: string;
  blurb: string;
  icon: string;
}

export const TEMPLATES: TemplateInfo[] = [
  {
    id: 'platformer',
    name: 'Platformer',
    blurb: 'Run and jump across platforms. Gravity, spikes, coins and a goal flag.',
    icon: '🏃',
  },
  {
    id: 'topdown',
    name: 'Top-down collector',
    blurb: 'Walk in four directions through a maze. Grab coins, dodge enemies, reach the goal.',
    icon: '🕹️',
  },
  {
    id: 'racer',
    name: 'Lane racer',
    blurb: 'The offline-dino energy, but make it cars. Auto-drive forward, swap lanes to dodge traffic, grab coins, survive as it speeds up.',
    icon: '🏎️',
  },
];

// The palette of paintable tiles, in toolbar order, with a friendly label. The
// glyph is resolved from the doc's assets.sprites at render time (falls back to
// these defaults if a sprite key is missing).
export interface PaletteEntry { tile: import('./types').TileType; label: string; fallback: string }

export const PALETTE: PaletteEntry[] = [
  { tile: 'empty', label: 'Eraser', fallback: '⬜' },
  { tile: 'ground', label: 'Ground', fallback: '🟫' },
  { tile: 'spike', label: 'Spike', fallback: '🔺' },
  { tile: 'coin', label: 'Coin', fallback: '🪙' },
  { tile: 'enemy', label: 'Enemy', fallback: '👾' },
  { tile: 'start', label: 'Start', fallback: '🏁' },
  { tile: 'goal', label: 'Goal', fallback: '🚩' },
];

// A small emoji set offered in the Sprites tab per key.
export const EMOJI_CHOICES = ['🟫', '🧱', '⬛', '🔺', '⚡', '🪙', '💎', '⭐', '👾', '👻', '🐛', '🏁', '🚩', '🎯', '🙂', '🦊', '🐱', '🤖'];

// Which sprite keys the user can customize (tiles + player).
export const SPRITE_KEYS = ['ground', 'spike', 'coin', 'enemy', 'start', 'goal', 'player'] as const;
