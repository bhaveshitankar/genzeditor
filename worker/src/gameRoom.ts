// worker/src/gameRoom.ts
// Real-time multiplayer game room backed by a Durable Object using the
// WebSocket Hibernation API. Wire protocol MUST stay in lockstep with the
// frontend source of truth: src/game/protocol.ts (messages) and
// src/editors/game/types.ts (GameDoc/GameOp/applyOp). The Worker can't import
// from src/, so the matching shapes are redeclared here.
import type { Env } from './env';

// ---- redeclared game doc model (mirror of src/editors/game/types.ts) --------
type TemplateId = 'platformer' | 'topdown';
type TileType = 'empty' | 'ground' | 'spike' | 'coin' | 'start' | 'goal' | 'enemy';

interface GameSettings {
  gravity: number;
  jump: number;
  speed: number;
  lives: number;
  tileSize: number;
}

interface Entity {
  id: string;
  type: string;
  x: number;
  y: number;
  props?: Record<string, number | string | boolean>;
}

interface GameLevel {
  cols: number;
  rows: number;
  tiles: TileType[];
  entities: Entity[];
}

interface GameAssets {
  sprites: Record<string, string>;
}

interface GameDoc {
  version: 1;
  template: TemplateId;
  meta: { title: string };
  settings: GameSettings;
  level: GameLevel;
  assets: GameAssets;
}

type GameOp =
  | { t: 'tile'; i: number; v: TileType }
  | { t: 'resize'; cols: number; rows: number; tiles: TileType[] }
  | { t: 'entity.add'; e: Entity }
  | { t: 'entity.move'; id: string; x: number; y: number }
  | { t: 'entity.del'; id: string }
  | { t: 'setting'; k: keyof GameSettings; v: number }
  | { t: 'asset'; k: string; v: string }
  | { t: 'meta'; title: string };

// Pure in-place mutation — identical to the frontend applyOp so every peer and
// the authoritative snapshot converge.
function applyOp(doc: GameDoc, op: GameOp): void {
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

// ---- redeclared wire protocol (mirror of src/game/protocol.ts) --------------
interface Presence {
  id: string;
  name: string;
  color: string;
  mode: 'edit' | 'play';
  cursor?: { x: number; y: number };
}

interface PlayerState {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  anim?: string;
}

type ClientMsg =
  | { t: 'join'; name: string; color: string }
  | { t: 'op'; op: GameOp }
  | { t: 'cursor'; x: number; y: number }
  | { t: 'mode'; mode: 'edit' | 'play' }
  | { t: 'player'; s: Omit<PlayerState, 'id'> }
  | { t: 'save'; doc: GameDoc };

type ServerMsg =
  | { t: 'snapshot'; doc: GameDoc | null; you: string; peers: Presence[] }
  | { t: 'op'; from: string; op: GameOp }
  | { t: 'presence'; peers: Presence[] }
  | { t: 'cursor'; from: string; x: number; y: number }
  | { t: 'player'; s: PlayerState }
  | { t: 'left'; id: string };

const DOC_KEY = 'doc';

// Short, URL-safe unique id for a connection.
function shortId(): string {
  return crypto.randomUUID().slice(0, 8);
}

export class GameRoom {
  private state: DurableObjectState;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation-aware accept: the runtime may evict us and later redeliver
    // events; per-connection state lives in the socket attachment.
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Presence is stored on the socket via serializeAttachment so it survives
  // hibernation; null attachment means "connected but not yet joined".
  private getPresence(ws: WebSocket): Presence | null {
    return (ws.deserializeAttachment() as Presence | null) ?? null;
  }

  private setPresence(ws: WebSocket, p: Presence): void {
    ws.serializeAttachment(p);
  }

  private peers(except?: WebSocket): Presence[] {
    const out: Presence[] = [];
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      const p = this.getPresence(ws);
      if (p) out.push(p);
    }
    return out;
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      if (ws.readyState === WebSocket.READY_STATE_OPEN) ws.send(JSON.stringify(msg));
    } catch {
      // ignore — a peer going away must never break the room.
    }
  }

  // Broadcast to every socket, optionally excluding one. Skips closed sockets
  // and never throws.
  private broadcast(msg: ServerMsg, except?: WebSocket): void {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      if (ws === except) continue;
      try {
        if (ws.readyState === WebSocket.READY_STATE_OPEN) ws.send(data);
      } catch {
        // ignore
      }
    }
  }

  private async getDoc(): Promise<GameDoc | null> {
    return (await this.state.storage.get<GameDoc>(DOC_KEY)) ?? null;
  }

  private async putDoc(doc: GameDoc): Promise<void> {
    await this.state.storage.put(DOC_KEY, doc);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as ClientMsg;
    } catch {
      return; // ignore malformed frames
    }

    switch (msg.t) {
      case 'join': {
        const me: Presence = {
          id: shortId(),
          name: msg.name,
          color: msg.color,
          mode: 'edit',
        };
        this.setPresence(ws, me);
        const doc = await this.getDoc();
        // Reply with current snapshot (doc may be null until someone saves).
        this.send(ws, { t: 'snapshot', doc, you: me.id, peers: this.peers() });
        // Tell everyone (including us) the new roster.
        this.broadcast({ t: 'presence', peers: this.peers() });
        break;
      }
      case 'op': {
        const me = this.getPresence(ws);
        if (!me) return;
        const doc = await this.getDoc();
        if (doc) {
          applyOp(doc, msg.op);
          await this.putDoc(doc);
        }
        this.broadcast({ t: 'op', from: me.id, op: msg.op }, ws);
        break;
      }
      case 'save': {
        const me = this.getPresence(ws);
        if (!me) return;
        await this.putDoc(msg.doc);
        // Push the fresh authoritative snapshot to the other peers.
        this.broadcast({ t: 'snapshot', doc: msg.doc, you: me.id, peers: this.peers() }, ws);
        break;
      }
      case 'cursor': {
        const me = this.getPresence(ws);
        if (!me) return;
        me.cursor = { x: msg.x, y: msg.y };
        this.setPresence(ws, me);
        this.broadcast({ t: 'cursor', from: me.id, x: msg.x, y: msg.y }, ws);
        break;
      }
      case 'mode': {
        const me = this.getPresence(ws);
        if (!me) return;
        me.mode = msg.mode;
        this.setPresence(ws, me);
        this.broadcast({ t: 'presence', peers: this.peers() });
        break;
      }
      case 'player': {
        const me = this.getPresence(ws);
        if (!me) return;
        // Ephemeral — not persisted; stamp with the sender id.
        this.broadcast({ t: 'player', s: { ...msg.s, id: me.id } }, ws);
        break;
      }
    }
  }

  webSocketClose(ws: WebSocket): void {
    this.dropPeer(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.dropPeer(ws);
  }

  private dropPeer(ws: WebSocket): void {
    const me = this.getPresence(ws);
    try {
      ws.close();
    } catch {
      // already closed
    }
    if (me) {
      this.broadcast({ t: 'left', id: me.id }, ws);
      this.broadcast({ t: 'presence', peers: this.peers(ws) }, ws);
    }
  }
}
