// Browser WebSocket client for live game rooms. Speaks the wire protocol in
// protocol.ts against the Worker Durable Object. Fire-and-forget: sends no-op
// when the socket isn't OPEN; never throws out of a socket handler.
import type {
  ClientMsg,
  ServerMsg,
  RoomEvents,
  RoomClient,
  PlayerState,
} from './protocol';
import type { GameDoc, GameOp } from '../editors/game/types';

const CURSOR_MS = 50; // ~20/sec
const PLAYER_MS = 67; // ~15/sec
const MAX_RETRIES = 5;
const BASE_BACKOFF = 500; // ms, doubled per attempt (capped)

export function connectRoom(
  baseWsUrl: string,
  roomId: string,
  me: { name: string; color: string },
  events: RoomEvents,
): RoomClient {
  const url = `${baseWsUrl}/rooms/${encodeURIComponent(roomId)}/ws`;
  let ws: WebSocket | null = null;
  let closed = false;      // close() called — stop everything, silence events
  let closedFired = false; // onClose fired for the current life
  let retries = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Trailing-throttle state for cursor/player (keep latest, flush on timer).
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  let cursorAt = 0;
  let cursorPending: { x: number; y: number } | null = null;
  let playerTimer: ReturnType<typeof setTimeout> | null = null;
  let playerAt = 0;
  let playerPending: Omit<PlayerState, 'id'> | null = null;

  const send = (msg: ClientMsg): void => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  };

  const onMessage = (ev: MessageEvent): void => {
    if (closed) return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ServerMsg;
    } catch { return; }
    try {
      switch (msg.t) {
        case 'snapshot': events.onSnapshot(msg.doc, msg.you, msg.peers); break;
        case 'op': events.onOp(msg.op, msg.from); break;
        case 'presence': events.onPresence(msg.peers); break;
        case 'cursor': events.onCursor(msg.from, msg.x, msg.y); break;
        case 'player': events.onPlayer(msg.s); break;
        case 'left': events.onLeft(msg.id); break;
      }
    } catch { /* never let an event callback break the socket */ }
  };

  const handleGone = (): void => {
    if (closed) return; // user-initiated close(): stay silent

    // Bounded auto-reconnect with backoff; onClose() only when we give up.
    if (retries < MAX_RETRIES) {
      const delay = Math.min(BASE_BACKOFF * 2 ** retries, 8000);
      retries++;
      reconnectTimer = setTimeout(open, delay);
    } else if (!closedFired) {
      closedFired = true;
      events.onClose();
    }
  };

  function open(): void {
    if (closed) return;
    try {
      ws = new WebSocket(url);
    } catch {
      handleGone();
      return;
    }
    ws.addEventListener('open', () => {
      retries = 0; // fresh connection; re-join and rely on server snapshot
      send({ t: 'join', name: me.name, color: me.color });
    });
    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', handleGone);
    ws.addEventListener('error', () => {
      try { ws?.close(); } catch { /* ignore */ } // 'close' drives reconnect
    });
  }

  const flushCursor = (): void => {
    cursorTimer = null;
    if (!cursorPending) return;
    cursorAt = Date.now();
    const { x, y } = cursorPending;
    cursorPending = null;
    send({ t: 'cursor', x, y });
  };

  const flushPlayer = (): void => {
    playerTimer = null;
    if (!playerPending) return;
    playerAt = Date.now();
    const s = playerPending;
    playerPending = null;
    send({ t: 'player', s });
  };

  open();

  return {
    sendOp(op: GameOp): void {
      if (closed) return;
      send({ t: 'op', op });
    },
    sendCursor(x: number, y: number): void {
      if (closed) return;
      cursorPending = { x, y };
      const since = Date.now() - cursorAt;
      if (since >= CURSOR_MS) { flushCursor(); }
      else if (!cursorTimer) { cursorTimer = setTimeout(flushCursor, CURSOR_MS - since); }
    },
    sendMode(mode: 'edit' | 'play'): void {
      if (closed) return;
      send({ t: 'mode', mode });
    },
    sendPlayer(s: Omit<PlayerState, 'id'>): void {
      if (closed) return;
      playerPending = s;
      const since = Date.now() - playerAt;
      if (since >= PLAYER_MS) { flushPlayer(); }
      else if (!playerTimer) { playerTimer = setTimeout(flushPlayer, PLAYER_MS - since); }
    },
    save(doc: GameDoc): void {
      if (closed) return;
      send({ t: 'save', doc });
    },
    close(): void {
      closed = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      if (cursorTimer) { clearTimeout(cursorTimer); cursorTimer = null; }
      if (playerTimer) { clearTimeout(playerTimer); playerTimer = null; }
      cursorPending = null;
      playerPending = null;
      try { ws?.close(); } catch { /* ignore */ }
      ws = null;
    },
  };
}
