// A small dependency-free game runtime that plays a GameDoc on a <canvas>.
// Platformer + top-down share one tile/entity engine (camera, coyote jump,
// moving platforms, stomp, particles, screen shake, synth sfx); the lane racer
// is a separate procedural runtime. Physics is driven by doc.settings.
import type { GameDoc, TileType } from './types';
import type { PlayerState } from '../../game/protocol';
import { drawBackground, drawSprite, normEntity, sortedEntities, tileKey, type EntN } from './art';
import { createSfx, type Sfx } from './sfx';

export type GameStatus = 'playing' | 'won' | 'lost';

export interface RunnerHandle {
  stop(): void;
  restart(): void;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  // Latest local avatar position in tile-space (for co-op broadcast).
  getPlayer(): Omit<PlayerState, 'id'>;
  setRemotePlayers(players: Map<string, PlayerState>): void;
  // Inject/release a logical key (for on-screen joystick/buttons).
  press(key: string): void;
  release(key: string): void;
}

export interface RunnerCallbacks {
  onStatus?(status: GameStatus): void;
  onScore?(score: number): void;
  onLives?(lives: number): void;
}

interface Rect { x: number; y: number; w: number; h: number }
interface Body { x: number; y: number; vx: number; vy: number; w: number; h: number; onGround: boolean }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number }

const KEY_MAP: Record<string, string> = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', Space: 'jump',
};
export const DPAD_KEYS = ['left', 'right', 'up', 'down', 'jump'] as const;

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

export function runGame(canvas: HTMLCanvasElement, doc: GameDoc, cb: RunnerCallbacks = {}): RunnerHandle {
  if (doc.template === 'racer') return runRacer(canvas, doc, cb);

  const ctx = canvas.getContext('2d')!;
  const ts = doc.settings.tileSize;
  const { cols, rows } = doc.level;
  const tiles = doc.level.tiles;
  const isPlatformer = doc.template === 'platformer';
  const sfx: Sfx = createSfx(doc.assets.sprites.sfx ?? 'retro');
  const shakeAmt = doc.settings.shake ?? 1;
  const partAmt = doc.settings.particles ?? 1;

  const keys = new Set<string>();
  let status: GameStatus = 'playing';
  let score = 0, lives = doc.settings.lives;
  let raf = 0, last = 0, paused = false;
  const collected = new Set<number>();
  const remote = new Map<string, PlayerState>();
  const body: Body = { x: 0, y: 0, vx: 0, vy: 0, w: ts * 0.7, h: ts * 0.86, onGround: false };

  // Juice state.
  let shakeT = 0, shakeMag = 0, inv = 0, coyote = 0, jumpBuf = 0, wasJump = false, wasGround = false;
  let sqx = 1, sqy = 1, facing = 1, clock = 0, camX = 0, camY = 0, camInit = false;
  let particles: Particle[] = [];

  interface Walker { x: number; y: number; vx: number; w: number; h: number; alive: boolean }
  let walkers: Walker[] = [];
  interface RE { e: ReturnType<typeof sortedEntities>[number]; n: EntN; bx: number; by: number; x: number; y: number; w: number; h: number; dx: number; dy: number; dir: number; t: number; alive: boolean }
  const ents: RE[] = sortedEntities(doc).map((e) => {
    const n = normEntity(e);
    const swap = Math.round(n.rot / 90) % 2 !== 0;
    const w = (swap ? n.h : n.w) * ts, h = (swap ? n.w : n.h) * ts;
    // Rotated entities keep their visual centre: hitbox is the swapped AABB about the centre.
    const cx = (e.x + n.w / 2) * ts, cy = (e.y + n.h / 2) * ts;
    return { e, n, bx: cx - w / 2, by: cy - h / 2, x: cx - w / 2, y: cy - h / 2, w, h, dx: 0, dy: 0, dir: 1, t: 0, alive: true };
  });

  const tileAt = (c: number, r: number): TileType => (c < 0 || r < 0 || c >= cols || r >= rows ? 'empty' : tiles[r * cols + c]!);
  const solidTile = (c: number, r: number) => tileAt(c, r) === 'ground';

  function startPx() {
    const i = tiles.indexOf('start');
    const idx = i >= 0 ? i : 0;
    const c = idx % cols, r = Math.floor(idx / cols);
    return { x: c * ts + (ts - body.w) / 2, y: r * ts + (ts - body.h) };
  }

  function burst(x: number, y: number, color: string, n: number, speed = 160) {
    const count = Math.round(n * partAmt);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, v = speed * (0.35 + Math.random() * 0.65);
      const life = 0.35 + Math.random() * 0.4;
      particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - speed * 0.3, life, max: life, color, size: 2 + Math.random() * 3 });
    }
  }
  function shake(mag: number) { if (shakeAmt <= 0) return; shakeMag = Math.max(shakeMag, mag * shakeAmt); shakeT = 0.28; }

  function reset() {
    const p = startPx();
    body.x = p.x; body.y = p.y; body.vx = 0; body.vy = 0; body.onGround = false;
    walkers = [];
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i] === 'enemy') {
        const c = i % cols, r = Math.floor(i / cols);
        walkers.push({ x: c * ts + ts * 0.15, y: r * ts + ts * 0.15, vx: doc.settings.speed * 0.4, w: ts * 0.7, h: ts * 0.7, alive: true });
      }
    }
    camInit = false;
  }
  function restart() {
    status = 'playing'; score = 0; lives = doc.settings.lives; collected.clear();
    for (const r of ents) { r.alive = true; r.t = 0; r.x = r.bx; r.y = r.by; }
    particles = []; inv = 0; coyote = 0; jumpBuf = 0; paused = false;
    reset();
    cb.onScore?.(score); cb.onLives?.(lives); cb.onStatus?.(status);
  }

  function hurt() {
    if (inv > 0 || status !== 'playing') return;
    lives -= 1; cb.onLives?.(lives);
    burst(body.x + body.w / 2, body.y + body.h / 2, '#ff4d8d', 18, 220);
    shake(9); sfx.play('hurt');
    if (lives <= 0) { status = 'lost'; sfx.play('lose'); cb.onStatus?.(status); }
    else { reset(); inv = 1.3; }
  }
  function win() {
    if (status !== 'playing') return;
    status = 'won'; sfx.play('win');
    for (const c of ['#ffc53d', '#ff4d8d', '#4d6bff', '#3ddcc0']) burst(body.x + body.w / 2, body.y, c, 14, 260);
    cb.onStatus?.(status);
  }

  const solidRects = (): Rect[] => ents.filter((r) => r.alive && r.n.behavior === 'solid' && !r.n.hidden);

  function moveAxis(dx: number, dy: number) {
    body.x += dx; body.y += dy;
    const c0 = Math.floor(body.x / ts), c1 = Math.floor((body.x + body.w) / ts);
    const r0 = Math.floor(body.y / ts), r1 = Math.floor((body.y + body.h) / ts);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!solidTile(c, r)) continue;
        const tx = c * ts, ty = r * ts;
        if (dx > 0) { body.x = tx - body.w; body.vx = 0; }
        else if (dx < 0) { body.x = tx + ts; body.vx = 0; }
        if (dy > 0) { body.y = ty - body.h; body.vy = 0; body.onGround = true; }
        else if (dy < 0) { body.y = ty + ts; body.vy = 0; }
      }
    }
    for (const s of solidRects()) {
      if (!overlaps(body, s)) continue;
      if (dx > 0) { body.x = s.x - body.w; body.vx = 0; }
      else if (dx < 0) { body.x = s.x + s.w; body.vx = 0; }
      if (dy > 0) { body.y = s.y - body.h; body.vy = 0; body.onGround = true; }
      else if (dy < 0) { body.y = s.y + s.h; body.vy = 0; }
    }
  }

  function updateEntities(dt: number) {
    for (const r of ents) {
      if (!r.alive) continue;
      const px = r.x, py = r.y;
      if (r.n.motion !== 'none' && r.n.range > 0) {
        r.t += dt * r.n.speed;
        const m = r.t % (2 * r.n.range);
        const p = m < r.n.range ? m : 2 * r.n.range - m;
        r.dir = m < r.n.range ? 1 : -1;
        if (r.n.motion === 'h') r.x = r.bx + p * ts; else r.y = r.by + p * ts;
      }
      r.dx = r.x - px; r.dy = r.y - py;
    }
  }

  function step(dt: number) {
    if (status !== 'playing') return;
    const s = doc.settings;
    clock += dt;
    inv = Math.max(0, inv - dt);
    updateEntities(dt);

    // Ride moving solids the player is standing on.
    if (body.onGround) {
      for (const r of solidRects() as unknown as RE[]) {
        if ((r.dx || r.dy) && Math.abs(body.y + body.h - (r.y - r.dy)) < 5 && body.x + body.w > r.x - r.dx && body.x < r.x - r.dx + r.w) {
          body.x += r.dx; body.y += r.dy; break;
        }
      }
    }
    // Pushed by a platform sweeping into the player.
    for (const r of solidRects() as unknown as RE[]) {
      if (!(r.dx || r.dy) || !overlaps(body, r)) continue;
      const ox = Math.min(body.x + body.w - r.x, r.x + r.w - body.x), oy = Math.min(body.y + body.h - r.y, r.y + r.h - body.y);
      if (ox < oy) body.x += body.x + body.w / 2 < r.x + r.w / 2 ? -ox : ox; else body.y += body.y + body.h / 2 < r.y + r.h / 2 ? -oy : oy;
    }

    const left = keys.has('left'), right = keys.has('right');
    const jumpKey = keys.has('jump') || keys.has('up');
    if (right) facing = 1; else if (left) facing = -1;

    if (isPlatformer) {
      body.vx = (right ? s.speed : 0) - (left ? s.speed : 0);
      coyote = wasGround ? 0.1 : Math.max(0, coyote - dt);
      if (jumpKey && !wasJump) jumpBuf = 0.12; else jumpBuf = Math.max(0, jumpBuf - dt);
      if (jumpBuf > 0 && (body.onGround || coyote > 0)) {
        body.vy = -s.jump; body.onGround = false; coyote = 0; jumpBuf = 0;
        sqx = 0.78; sqy = 1.28; sfx.play('jump');
        burst(body.x + body.w / 2, body.y + body.h, '#ffffff', 5, 90);
      }
      if (!jumpKey && body.vy < -s.jump * 0.45) body.vy *= 0.55; // variable jump height
      wasJump = jumpKey;
      body.vy += s.gravity * dt;
      const wasG = body.onGround;
      body.onGround = false;
      moveAxis(body.vx * dt, 0);
      moveAxis(0, body.vy * dt);
      if (body.onGround && !wasG && body.vy === 0) { sqx = 1.25; sqy = 0.78; }
      wasGround = body.onGround;
    } else {
      const up = keys.has('up'), down = keys.has('down');
      body.vx = (right ? s.speed : 0) - (left ? s.speed : 0);
      body.vy = (down ? s.speed : 0) - (up ? s.speed : 0);
      moveAxis(body.vx * dt, 0);
      moveAxis(0, body.vy * dt);
    }
    sqx += (1 - sqx) * Math.min(1, dt * 14); sqy += (1 - sqy) * Math.min(1, dt * 14);

    if (body.y > rows * ts + ts * 2) { hurt(); return; }

    // Tile-grid enemies: patrol (platformer) or chase (top-down).
    for (const e of walkers) {
      if (!e.alive) continue;
      if (isPlatformer) {
        e.x += e.vx * dt;
        const c = Math.floor((e.vx > 0 ? e.x + e.w : e.x) / ts);
        const rBelow = Math.floor((e.y + e.h + 1) / ts), rMid = Math.floor((e.y + e.h / 2) / ts);
        if (solidTile(c, rMid) || !solidTile(c, rBelow)) e.vx = -e.vx;
      } else {
        const dxp = body.x - e.x, dyp = body.y - e.y, d = Math.hypot(dxp, dyp) || 1, sp = s.speed * 0.5;
        e.x += (dxp / d) * sp * dt; e.y += (dyp / d) * sp * dt;
      }
      if (overlaps(body, e)) {
        if (isPlatformer && body.vy > 0 && body.y + body.h - e.y < e.h * 0.65) stomp(e.x + e.w / 2, e.y, () => { e.alive = false; });
        else { hurt(); if (status !== 'playing') return; }
      }
    }

    // Entities by behavior.
    const hit = { x: body.x, y: body.y, w: body.w, h: body.h };
    for (const r of ents) {
      if (!r.alive || r.n.hidden) continue;
      const k = r.n.behavior;
      if (k === 'none' || k === 'solid') continue;
      const shrink = k === 'enemy' || k === 'hazard' ? 0.14 : 0;
      const box = { x: r.x + r.w * shrink, y: r.y + r.h * shrink, w: r.w * (1 - 2 * shrink), h: r.h * (1 - 2 * shrink) };
      if (!overlaps(hit, box)) continue;
      if (k === 'collect') {
        r.alive = false; score += Math.round(r.n.value); cb.onScore?.(score); sfx.play('coin');
        burst(r.x + r.w / 2, r.y + r.h / 2, '#ffc53d', 8, 120);
      } else if (k === 'goal') { win(); }
      else if (k === 'hazard') { hurt(); if (status !== 'playing') return; }
      else if (k === 'enemy') {
        if (isPlatformer && body.vy > 0 && body.y + body.h - r.y < r.h * 0.65) stomp(r.x + r.w / 2, r.y, () => { r.alive = false; });
        else { hurt(); if (status !== 'playing') return; }
      } else if (k === 'bounce' && isPlatformer && body.vy >= 0 && body.y + body.h - r.y < r.h * 0.9) {
        body.vy = -s.jump * 1.45; body.onGround = false; sqx = 0.7; sqy = 1.35; sfx.play('spring');
        burst(r.x + r.w / 2, r.y, '#ff4d8d', 6, 120);
      }
    }
    handleTiles();
    if (status === 'playing') { cb.onScore?.(score); }
  }

  function stomp(x: number, y: number, kill: () => void) {
    kill(); body.vy = -doc.settings.jump * 0.6; score += 2;
    burst(x, y, '#9b5cff', 10, 160); shake(4); sfx.play('stomp');
  }

  function handleTiles() {
    const c0 = Math.floor(body.x / ts), c1 = Math.floor((body.x + body.w) / ts);
    const r0 = Math.floor(body.y / ts), r1 = Math.floor((body.y + body.h) / ts);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c, t = tileAt(c, r);
        if (t === 'coin' && !collected.has(i)) {
          collected.add(i); score += 1; sfx.play('coin'); burst(c * ts + ts / 2, r * ts + ts / 2, '#ffc53d', 8, 120);
        } else if (t === 'spike') { hurt(); return; }
        else if (t === 'goal') win();
      }
    }
  }

  // ---- Rendering ----
  function draw(dt: number) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (cw > 0 && ch > 0) {
      const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
      if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    } else if (canvas.width !== cols * ts || canvas.height !== rows * ts) { canvas.width = cols * ts; canvas.height = rows * ts; }
    const vw = canvas.width, vh = canvas.height;
    const visRows = Math.min(rows, vh > vw ? 10 : 14);
    const zoom = vh / (visRows * ts);
    const visW = vw / zoom, visH = vh / zoom;
    const clampCam = (v: number, worldLen: number, vis: number) => (worldLen <= vis ? -(vis - worldLen) / 2 : Math.max(0, Math.min(worldLen - vis, v)));
    const tx = clampCam(body.x + body.w / 2 - visW / 2 + facing * ts * 1.2, cols * ts, visW);
    const ty = clampCam(body.y + body.h / 2 - visH / 2, rows * ts, visH);
    if (!camInit) { camX = tx; camY = ty; camInit = true; }
    else { const k = 1 - Math.exp(-dt * 7); camX += (tx - camX) * k; camY += (ty - camY) * k; }

    let sx = 0, sy = 0;
    if (shakeT > 0) {
      shakeT = Math.max(0, shakeT - dt);
      const m = shakeMag * easeOut(shakeT / 0.28) * zoom;
      sx = (Math.random() - 0.5) * 2 * m; sy = (Math.random() - 0.5) * 2 * m;
      if (shakeT === 0) shakeMag = 0;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, vw, vh);
    ctx.setTransform(zoom, 0, 0, zoom, -camX * zoom + sx, -camY * zoom + sy);
    drawBackground(ctx, doc.assets.sprites.bg, camX - 4, camY - 4, visW + 8, visH + 8, camX);

    const c0 = Math.max(0, Math.floor(camX / ts)), c1 = Math.min(cols - 1, Math.ceil((camX + visW) / ts));
    const r0 = Math.max(0, Math.floor(camY / ts)), r1 = Math.min(rows - 1, Math.ceil((camY + visH) / ts));
    const drawEnt = (r: RE) => {
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      ctx.save(); ctx.translate(cx, cy);
      ctx.rotate((r.n.rot * Math.PI) / 180);
      const flip = r.n.flip !== (r.dir < 0 && r.n.motion === 'h' && r.n.behavior === 'enemy');
      if (flip) ctx.scale(-1, 1);
      const swap = Math.round(r.n.rot / 90) % 2 !== 0;
      const dw = (swap ? r.h : r.w), dh = (swap ? r.w : r.h);
      let bob = 0; if (r.n.behavior === 'collect') bob = Math.sin(clock * 4 + r.bx * 0.05) * ts * 0.06;
      drawSprite(ctx, doc, r.e.type, -dw / 2, -dh / 2 + bob, dw, dh);
      ctx.restore();
    };
    for (const r of ents) if (r.alive && !r.n.hidden && r.n.z < 0) drawEnt(r);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const i = r * cols + c, t = tiles[i]!;
        if (t === 'empty' || t === 'start') continue;
        if (t === 'coin' && collected.has(i)) continue;
        if (t === 'coin') drawSprite(ctx, doc, 'coin', c * ts, r * ts + Math.sin(clock * 4 + c) * ts * 0.05, ts, ts);
        else drawSprite(ctx, doc, tileKey(doc, t, c, r), c * ts, r * ts, ts, ts);
      }
    }
    for (const r of ents) if (r.alive && !r.n.hidden && r.n.z >= 0) drawEnt(r);
    for (const e of walkers) if (e.alive) drawSprite(ctx, doc, 'enemy', e.x - ts * 0.05, e.y - ts * 0.05, e.w * 1.1, e.h * 1.1);
    remote.forEach((p) => {
      ctx.globalAlpha = 0.6; drawSprite(ctx, doc, 'player', p.x * ts, p.y * ts, ts * 0.7, ts * 0.86); ctx.globalAlpha = 1;
    });
    // Player with squash & stretch, blinking while invulnerable.
    if (inv <= 0 || Math.floor(clock * 14) % 2 === 0) {
      ctx.save();
      ctx.translate(body.x + body.w / 2, body.y + body.h);
      ctx.scale(sqx * facing, sqy);
      drawSprite(ctx, doc, 'player', -body.w / 2 - ts * 0.05, -body.h - ts * 0.04, body.w + ts * 0.1, body.h + ts * 0.08);
      ctx.restore();
    }
    // Particles.
    for (const p of particles) {
      p.life -= dt; p.vy += 600 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
      ctx.globalAlpha = Math.max(0, p.life / p.max); ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    particles = particles.filter((p) => p.life > 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  function frame(now: number) {
    const dt = Math.min(0.033, (now - last) / 1000 || 0);
    last = now;
    if (!paused) step(dt);
    draw(paused ? 0 : dt);
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
      sfx.close();
    },
    restart,
    pause() { paused = true; keys.clear(); },
    resume() { paused = false; },
    isPaused: () => paused,
    getPlayer() { return { x: body.x / ts, y: body.y / ts, vx: body.vx / ts, vy: body.vy / ts, anim: status }; },
    setRemotePlayers(players) { remote.clear(); players.forEach((p, id) => remote.set(id, p)); },
    press(key) { keys.add(key); },
    release(key) { keys.delete(key); },
  };
}

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
  const sfx = createSfx(doc.assets.sprites.sfx ?? 'retro');
  let shakeT = 0, paused = false;

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
    shakeT = 0.3; sfx.play(lives <= 0 ? 'lose' : 'hurt');
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
    shakeT = Math.max(0, shakeT - dt);
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
      if (m.kind === 'coin') { score += 5; distance += 5; cb.onScore?.(score); m.y = canvas.height + 999; sfx.play('coin'); }
      else { loseLife(); if (status !== 'playing') return; }
    }
    movers = movers.filter((m) => m.y < canvas.height + carH);
  }

  // ---- Rendering ----
  function glyph(key: string, cx: number, cy: number, size: number) {
    drawSprite(ctx, doc, key, cx - size / 2, cy - size / 2, size, size);
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (shakeT > 0) ctx.translate((Math.random() - 0.5) * 12 * (shakeT / 0.3), (Math.random() - 0.5) * 12 * (shakeT / 0.3));
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

    for (const m of movers) glyph(m.kind === 'coin' ? 'coin' : 'enemy', laneCenter(m.lane), m.y + carH / 2, m.kind === 'coin' ? carW : carH * 1.1);
    remote.forEach((p) => { ctx.globalAlpha = 0.6; glyph('player', p.x * ts, p.y * ts, carH * 1.1); ctx.globalAlpha = 1; });
    glyph('player', playerX, playerY + carH / 2, carH * 1.1);

    if (status !== 'playing') {
      ctx.fillStyle = 'rgba(0,0,0,0.58)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.floor(laneW * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('Crashed', canvas.width / 2, canvas.height / 2 - laneW * 0.3);
      ctx.font = `${Math.floor(laneW * 0.3)}px system-ui, sans-serif`;
      ctx.fillText(`Score ${score}`, canvas.width / 2, canvas.height / 2 + laneW * 0.3);
    }
  }

  function frame(now: number) {
    const dt = Math.min(0.033, (now - last) / 1000 || 0);
    last = now;
    if (!paused) step(dt);
    draw();
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
      sfx.close();
    },
    restart,
    pause() { paused = true; keys.clear(); },
    resume() { paused = false; },
    isPaused: () => paused,
    getPlayer() { return { x: playerX / ts, y: playerY / ts, vx: 0, vy: 0, anim: status }; },
    setRemotePlayers(players) { remote.clear(); players.forEach((p, id) => remote.set(id, p)); },
    press(key) { keys.add(key); },
    release(key) { keys.delete(key); },
  };
}
