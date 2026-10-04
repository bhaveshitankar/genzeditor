// A tiny, dependency-free game runtime that plays a GameDoc on a <canvas> via a
// rAF loop. It supports both templates (platformer with gravity + jumping, and
// top-down 4-direction movement). Physics is deliberately readable and driven
// entirely by doc.settings so the Rules tab can tune it live.
import type { GameDoc, TileType } from './types';
import type { PlayerState } from '../../game/protocol';

export type GameStatus = 'playing' | 'won' | 'lost';

export interface RunnerHandle {
  stop(): void;
  restart(): void;
  // Latest local avatar position in tile-space (for co-op broadcast).
  getPlayer(): Omit<PlayerState, 'id'>;
  // Replace the set of remote players to draw (keyed by peer id).
  setRemotePlayers(players: Map<string, PlayerState>): void;
  // Inject/release a logical key (for on-screen dpad buttons).
  press(key: string): void;
  release(key: string): void;
}

export interface RunnerCallbacks {
  onStatus?(status: GameStatus): void;
  onScore?(score: number): void;
  onLives?(lives: number): void;
}

interface Rect { x: number; y: number; w: number; h: number }

// A live player body in pixel-space.
interface Body {
  x: number; y: number;   // top-left px
  vx: number; vy: number; // px/s
  w: number; h: number;
  onGround: boolean;
}

const KEY_MAP: Record<string, string> = {
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  Space: 'jump',
};

export function runGame(
  canvas: HTMLCanvasElement,
  doc: GameDoc,
  cb: RunnerCallbacks = {},
): RunnerHandle {
  // The racer is an endless lane-dodge runner with its own procedural runtime,
  // so it branches out before the tile-based platformer/top-down engine.
  if (doc.template === 'racer') return runRacer(canvas, doc, cb);

  const ctx = canvas.getContext('2d')!;
  const ts = doc.settings.tileSize;
  const { cols, rows } = doc.level;
  const tiles = doc.level.tiles;
  const isPlatformer = doc.template === 'platformer';

  canvas.width = cols * ts;
  canvas.height = rows * ts;

  const keys = new Set<string>();
  let status: GameStatus = 'playing';
  let score = 0;
  let lives = doc.settings.lives;
  let raf = 0;
  let last = 0;
  const collected = new Set<number>(); // coin tile indices already taken

  const remote = new Map<string, PlayerState>();
  const body: Body = { x: 0, y: 0, vx: 0, vy: 0, w: ts * 0.7, h: ts * 0.86, onGround: false };

  // Simple enemy bodies derived from 'enemy' tiles (patrol horizontally / chase).
  interface Enemy { x: number; y: number; vx: number; w: number; h: number }
  let enemies: Enemy[] = [];

  const tileAt = (c: number, r: number): TileType => {
    if (c < 0 || r < 0 || c >= cols || r >= rows) return 'empty';
    return tiles[r * cols + c];
  };
  const startPx = (): { x: number; y: number } => {
    const i = tiles.indexOf('start');
    const idx = i >= 0 ? i : 0;
    const c = idx % cols, r = Math.floor(idx / cols);
    return { x: c * ts + (ts - body.w) / 2, y: r * ts + (ts - body.h) };
  };

  function reset() {
    const p = startPx();
    body.x = p.x; body.y = p.y; body.vx = 0; body.vy = 0; body.onGround = false;
    enemies = [];
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === 'enemy') {
        const c = i % cols, r = Math.floor(i / cols);
        enemies.push({ x: c * ts + ts * 0.15, y: r * ts + ts * 0.15, vx: doc.settings.speed * 0.4, w: ts * 0.7, h: ts * 0.7 });
      }
    }
  }
  function restart() {
    status = 'playing'; score = 0; lives = doc.settings.lives; collected.clear();
    reset();
    cb.onScore?.(score); cb.onLives?.(lives); cb.onStatus?.(status);
  }

  function loseLife() {
    lives -= 1; cb.onLives?.(lives);
    if (lives <= 0) { status = 'lost'; cb.onStatus?.(status); }
    else { reset(); }
  }

  // Solid = 'ground'. Returns true if the given tile column/row blocks movement.
  const solid = (c: number, r: number) => tileAt(c, r) === 'ground';

  // Sweep the body along one axis and resolve against solid tiles.
  function moveAxis(dx: number, dy: number) {
    body.x += dx; body.y += dy;
    const rect: Rect = { x: body.x, y: body.y, w: body.w, h: body.h };
    const c0 = Math.floor(rect.x / ts), c1 = Math.floor((rect.x + rect.w) / ts);
    const r0 = Math.floor(rect.y / ts), r1 = Math.floor((rect.y + rect.h) / ts);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!solid(c, r)) continue;
        const tx = c * ts, ty = r * ts;
        if (dx > 0) { body.x = tx - body.w; body.vx = 0; }
        else if (dx < 0) { body.x = tx + ts; body.vx = 0; }
        if (dy > 0) { body.y = ty - body.h; body.vy = 0; body.onGround = true; }
        else if (dy < 0) { body.y = ty + ts; body.vy = 0; }
        rect.x = body.x; rect.y = body.y;
      }
    }
  }

  function overlaps(a: Rect, b: Rect) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  // Check hazard/coin/goal tiles under the player's footprint.
  function handleTiles() {
    const c0 = Math.floor(body.x / ts), c1 = Math.floor((body.x + body.w) / ts);
    const r0 = Math.floor(body.y / ts), r1 = Math.floor((body.y + body.h) / ts);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c;
        const t = tileAt(c, r);
        if (t === 'coin' && !collected.has(i)) { collected.add(i); score += 1; cb.onScore?.(score); }
        else if (t === 'spike') { loseLife(); return; }
        else if (t === 'goal') { status = 'won'; cb.onStatus?.(status); }
      }
    }
  }

  function step(dt: number) {
    if (status !== 'playing') return;
    const s = doc.settings;
    const left = keys.has('left'), right = keys.has('right');

    if (isPlatformer) {
      body.vx = (right ? s.speed : 0) - (left ? s.speed : 0);
      if ((keys.has('jump') || keys.has('up')) && body.onGround) { body.vy = -s.jump; body.onGround = false; }
      body.vy += s.gravity * dt;
      body.onGround = false;
      moveAxis(body.vx * dt, 0);
      moveAxis(0, body.vy * dt);
    } else {
      const up = keys.has('up'), down = keys.has('down');
      body.vx = (right ? s.speed : 0) - (left ? s.speed : 0);
      body.vy = (down ? s.speed : 0) - (up ? s.speed : 0);
      moveAxis(body.vx * dt, 0);
      moveAxis(0, body.vy * dt);
    }

    // Fell out of the world.
    if (body.y > canvas.height + ts * 2) { loseLife(); return; }

    // Enemies: platformer patrols on ground; top-down chases the player slowly.
    for (const e of enemies) {
      if (isPlatformer) {
        e.x += e.vx * dt;
        const c = Math.floor((e.vx > 0 ? e.x + e.w : e.x) / ts);
        const rBelow = Math.floor((e.y + e.h + 1) / ts);
        const rMid = Math.floor((e.y + e.h / 2) / ts);
        if (solid(c, rMid) || !solid(c, rBelow)) e.vx = -e.vx;
      } else {
        const dxp = body.x - e.x, dyp = body.y - e.y;
        const d = Math.hypot(dxp, dyp) || 1;
        const sp = s.speed * 0.5;
        e.x += (dxp / d) * sp * dt; e.y += (dyp / d) * sp * dt;
      }
      const er: Rect = { x: e.x, y: e.y, w: e.w, h: e.h };
      if (overlaps({ x: body.x, y: body.y, w: body.w, h: body.h }, er)) { loseLife(); return; }
    }

    handleTiles();
  }

  // ---- Rendering ----
  const spriteImgs = new Map<string, HTMLImageElement>();
  function spriteFor(key: string): string { return doc.assets.sprites[key] ?? ''; }
  function drawGlyph(key: string, px: number, py: number, size: number) {
    const v = spriteFor(key);
    if (!v) return;
    if (v.startsWith('data:')) {
      let img = spriteImgs.get(key);
      if (!img) { img = new Image(); img.src = v; spriteImgs.set(key, img); }
      if (img.complete) ctx.drawImage(img, px, py, size, size);
    } else {
      ctx.font = `${Math.floor(size * 0.9)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(v, px + size / 2, py + size / 2);
    }
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Subtle grid background.
    ctx.fillStyle = '#0e1116';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const t = tiles[i];
        if (t === 'empty' || t === 'start') continue;
        if (t === 'coin' && collected.has(i)) continue;
        drawGlyph(t, c * ts, r * ts, ts);
      }
    }
    // Enemies (live bodies).
    for (const e of enemies) drawGlyph('enemy', e.x, e.y, e.w);
    // Remote co-op players.
    remote.forEach((p) => {
      ctx.font = `${Math.floor(ts * 0.8)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(spriteFor('player') || '🙂', p.x * ts + ts / 2, p.y * ts + ts / 2);
    });
    // Local player.
    drawGlyph('player', body.x, body.y, body.w);

    if (status !== 'playing') {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${ts}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(status === 'won' ? 'You win! 🎉' : 'Game over 💀', canvas.width / 2, canvas.height / 2);
    }
  }

  function frame(now: number) {
    const dt = Math.min(0.033, (now - last) / 1000 || 0);
    last = now;
    step(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const k = KEY_MAP[e.code];
    if (k) { keys.add(k); e.preventDefault(); }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    const k = KEY_MAP[e.code];
    if (k) keys.delete(k);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  restart();
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
    restart,
    getPlayer() {
      return { x: body.x / ts, y: body.y / ts, vx: body.vx / ts, vy: body.vy / ts, anim: status };
    },
    setRemotePlayers(players) {
      remote.clear();
      players.forEach((p, id) => remote.set(id, p));
    },
    press(key) { keys.add(key); },
    release(key) { keys.delete(key); },
  };
}

// Expose on-screen dpad keys so a touch UI can drive the same input set.
export const DPAD_KEYS = ['left', 'right', 'up', 'down', 'jump'] as const;

// ============================================================
// Racer runtime — endless lane-dodge runner (Chrome-dino energy, cars edition).
// The car auto-drives forward (the road scrolls down); Left/Right hop one lane
// at a time to dodge oncoming traffic and scoop coins. Speed ramps with distance;
// a crash costs a life; 0 lives ends the run. Gameplay is procedural, so it
// ignores the tile grid and is driven entirely by doc.settings.
// ============================================================
function runRacer(canvas: HTMLCanvasElement, doc: GameDoc, cb: RunnerCallbacks): RunnerHandle {
  const ctx = canvas.getContext('2d')!;
  const s = doc.settings;
  const lanes = Math.max(2, Math.min(6, s.lanes ?? 3));
  const ts = s.tileSize;
  canvas.width = lanes * ts;
  canvas.height = Math.round(ts * 9);

  const laneW = canvas.width / lanes;
  const carW = laneW * 0.62;
  const carH = laneW * 0.95;
  const playerY = canvas.height - carH - laneW * 0.4;
  const laneCenter = (i: number) => i * laneW + laneW / 2;

  interface Mover { lane: number; y: number; kind: 'car' | 'coin' }
  const keys = new Set<string>();
  let prevLeft = false, prevRight = false;

  let status: GameStatus = 'playing';
  let score = 0;
  let lives = s.lives;
  let laneIdx = Math.floor(lanes / 2);
  let playerX = laneCenter(laneIdx);
  let movers: Mover[] = [];
  let spawnTimer = 0;
  let distance = 0;     // metres-ish, drives score + difficulty
  let roadScroll = 0;   // lane-divider animation offset
  let raf = 0, last = 0;

  const remote = new Map<string, PlayerState>();

  // Current forward speed grows with distance; spawn interval tightens.
  const speedNow = () => s.speed * (1 + distance / 2200);
  const spawnInterval = () => Math.max(0.45, (s.obstacleRate ?? 1.1) - distance / 6000);

  function restart() {
    status = 'playing'; score = 0; lives = s.lives;
    laneIdx = Math.floor(lanes / 2); playerX = laneCenter(laneIdx);
    movers = []; spawnTimer = 0; distance = 0;
    cb.onScore?.(0); cb.onLives?.(lives); cb.onStatus?.(status);
  }

  function loseLife() {
    lives -= 1; cb.onLives?.(lives);
    // Clear nearby traffic so the respawn isn't an instant re-crash.
    movers = movers.filter((m) => m.kind === 'coin' || m.y < playerY - carH * 2.5);
    if (lives <= 0) { status = 'lost'; cb.onStatus?.(status); }
  }

  function spawnRow() {
    // One obstacle lane guaranteed; sometimes a coin in a different lane.
    const obLane = Math.floor(Math.random() * lanes);
    movers.push({ lane: obLane, y: -carH, kind: 'car' });
    if (Math.random() < 0.6) {
      let coinLane = Math.floor(Math.random() * lanes);
      if (coinLane === obLane) coinLane = (coinLane + 1) % lanes;
      movers.push({ lane: coinLane, y: -carH - laneW * (0.8 + Math.random()), kind: 'coin' });
    }
  }

  function step(dt: number) {
    if (status !== 'playing') return;
    // Edge-triggered lane hops (held keys move only once per press).
    const left = keys.has('left'), right = keys.has('right');
    if (left && !prevLeft) laneIdx = Math.max(0, laneIdx - 1);
    if (right && !prevRight) laneIdx = Math.min(lanes - 1, laneIdx + 1);
    prevLeft = left; prevRight = right;

    // Smoothly glide to the target lane centre.
    const targetX = laneCenter(laneIdx);
    playerX += (targetX - playerX) * Math.min(1, dt * 14);

    const v = speedNow();
    distance += v * dt * 0.05;
    score = Math.floor(distance);
    cb.onScore?.(score);

    roadScroll = (roadScroll + v * dt) % (laneW);

    spawnTimer -= dt;
    if (spawnTimer <= 0) { spawnRow(); spawnTimer = spawnInterval(); }

    const px = playerX - carW / 2;
    for (const m of movers) {
      m.y += v * dt;
      const mx = laneCenter(m.lane) - carW / 2;
      const hit = m.y + carH > playerY && m.y < playerY + carH
        && mx + carW > px && mx < px + carW;
      if (!hit) continue;
      if (m.kind === 'coin') { score += 5; distance += 5; cb.onScore?.(score); m.y = canvas.height + 999; }
      else { loseLife(); if (status !== 'playing') return; }
    }
    movers = movers.filter((m) => m.y < canvas.height + carH);
  }

  // ---- Rendering ----
  const imgs = new Map<string, HTMLImageElement>();
  function glyph(key: string, cx: number, cy: number, size: number) {
    const v = doc.assets.sprites[key] ?? '';
    if (!v) return;
    if (v.startsWith('data:')) {
      let img = imgs.get(key);
      if (!img) { img = new Image(); img.src = v; imgs.set(key, img); }
      if (img.complete) ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    } else {
      ctx.font = `${Math.floor(size)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(v, cx, cy);
    }
  }

  function draw() {
    // Asphalt.
    ctx.fillStyle = '#23262e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Soft road shoulders.
    ctx.fillStyle = '#1b1e25';
    ctx.fillRect(0, 0, laneW * 0.08, canvas.height);
    ctx.fillRect(canvas.width - laneW * 0.08, 0, laneW * 0.08, canvas.height);
    // Scrolling dashed lane dividers.
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = Math.max(2, laneW * 0.05);
    ctx.setLineDash([laneW * 0.4, laneW * 0.35]);
    ctx.lineDashOffset = -roadScroll;
    for (let i = 1; i < lanes; i++) {
      ctx.beginPath(); ctx.moveTo(i * laneW, 0); ctx.lineTo(i * laneW, canvas.height); ctx.stroke();
    }
    ctx.setLineDash([]);

    for (const m of movers) glyph(m.kind === 'coin' ? 'coin' : 'enemy', laneCenter(m.lane), m.y + carH / 2, carW);
    remote.forEach((p) => glyph('player', p.x * ts, p.y * ts, carW * 0.9));
    glyph('player', playerX, playerY + carH / 2, carW);

    if (status !== 'playing') {
      ctx.fillStyle = 'rgba(0,0,0,0.58)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.floor(laneW * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('💥 Crashed', canvas.width / 2, canvas.height / 2 - laneW * 0.3);
      ctx.font = `${Math.floor(laneW * 0.3)}px system-ui, sans-serif`;
      ctx.fillText(`Score ${score}`, canvas.width / 2, canvas.height / 2 + laneW * 0.3);
    }
  }

  function frame(now: number) {
    const dt = Math.min(0.033, (now - last) / 1000 || 0);
    last = now;
    step(dt); draw();
    raf = requestAnimationFrame(frame);
  }

  const onKeyDown = (e: KeyboardEvent) => { const k = KEY_MAP[e.code]; if (k) { keys.add(k); e.preventDefault(); } };
  const onKeyUp = (e: KeyboardEvent) => { const k = KEY_MAP[e.code]; if (k) keys.delete(k); };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  restart();
  raf = requestAnimationFrame(frame);

  return {
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    },
    restart,
    getPlayer() { return { x: playerX / ts, y: playerY / ts, vx: 0, vy: 0, anim: status }; },
    setRemotePlayers(players) { remote.clear(); players.forEach((p, id) => remote.set(id, p)); },
    press(key) { keys.add(key); },
    release(key) { keys.delete(key); },
  };
}
