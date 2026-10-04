// Wire protocol for live game rooms. BOTH the browser room client (src/game/
// roomClient.ts) and the Worker Durable Object (worker/src/gameRoom.ts) must
// speak exactly these messages. The Worker redeclares matching shapes (it can't
// import from src/), so treat this file as the single source of truth and keep
// the two in lockstep.
import type { GameDoc, GameOp } from '../editors/game/types';

// A connected participant. `color` is a hex string for their cursor/avatar.
export interface Presence {
  id: string;
  name: string;
  color: string;
  mode: 'edit' | 'play';
  cursor?: { x: number; y: number };
}

// Live position of a player's avatar during co-op play (tile-space coords).
export interface PlayerState {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  anim?: string;
}

// Browser → server.
export type ClientMsg =
  | { t: 'join'; name: string; color: string }
  | { t: 'op'; op: GameOp }
  | { t: 'cursor'; x: number; y: number }
  | { t: 'mode'; mode: 'edit' | 'play' }
  | { t: 'player'; s: Omit<PlayerState, 'id'> }
  | { t: 'save'; doc: GameDoc };

// Server → browser.
export type ServerMsg =
  // doc is null until the first client `save`s its local doc into the room.
  | { t: 'snapshot'; doc: GameDoc | null; you: string; peers: Presence[] }
  | { t: 'op'; from: string; op: GameOp }
  | { t: 'presence'; peers: Presence[] }
  | { t: 'cursor'; from: string; x: number; y: number }
  | { t: 'player'; s: PlayerState }
  | { t: 'left'; id: string };

// Callbacks the editor supplies so it can react to remote activity.
export interface RoomEvents {
  onSnapshot(doc: GameDoc | null, youId: string, peers: Presence[]): void;
  onOp(op: GameOp, from: string): void;
  onPresence(peers: Presence[]): void;
  onCursor(from: string, x: number, y: number): void;
  onPlayer(s: PlayerState): void;
  onLeft(id: string): void;
  onClose(): void;
}

// Transport handle returned by connectRoom(). Methods are fire-and-forget; they
// no-op silently once the socket has closed.
export interface RoomClient {
  sendOp(op: GameOp): void;
  sendCursor(x: number, y: number): void;
  sendMode(mode: 'edit' | 'play'): void;
  sendPlayer(s: Omit<PlayerState, 'id'>): void;
  save(doc: GameDoc): void;
  close(): void;
}
