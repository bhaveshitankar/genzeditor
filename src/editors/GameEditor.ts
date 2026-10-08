// GameEditor — a beginner-friendly, template-based game builder. Follows the
// app's DocEditor contract (open/export/destroy) and edits a .game document
// (JSON) that is autosaved to OPFS and optionally synced live to a room.
//
// Everything data-shaped lives in the fixed contracts (game/types.ts,
// game/protocol.ts, game/roomClient.ts, api/client.ts) — this file only imports
// from them and never redefines those types.
import './styles/game.css';
import {
  type GameDoc, type GameOp, type TileType,
  applyOp, createGameDoc, serializeGameDoc, parseGameDoc,
} from './game/types';
import type { RoomClient, RoomEvents, Presence, PlayerState } from '../game/protocol';
import { connectRoom } from '../game/roomClient';
import { API_BASE } from '../api/client';
import { runGame, type RunnerHandle, type GameStatus } from './game/engine';
import { TEMPLATES, PALETTE, EMOJI_CHOICES, SPRITE_KEYS } from './game/templates';
import { ARENAS } from './game/arenas';
import type { EditCommands } from './editCommands';

type Tab = 'level' | 'sprites' | 'rules' | 'play';

const GUEST_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];
const rand = (n: number) => Math.floor(Math.random() * n);

export class GameEditor {
  private container: HTMLElement;
  private onChange?: () => void;
  private doc!: GameDoc;

  private root!: HTMLElement;
  private bodyEl!: HTMLElement;
  private tab: Tab = 'level';
  private activeTile: TileType = 'ground';

  // Undo/redo via full-doc snapshots taken before each local edit.
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  // Live-room state.
  private room: RoomClient | null = null;
  private myId = '';
  private me = { name: `Guest ${rand(1000)}`, color: GUEST_COLORS[rand(GUEST_COLORS.length)] };
  private peers: Presence[] = [];
  private peerCursors = new Map<string, { x: number; y: number }>();
  private peerPlayers = new Map<string, PlayerState>();

  // Play-mode runtime.
  private runner: RunnerHandle | null = null;
  private playerTimer: number | null = null;
  private cursorSentAt = 0;

  private constructor(container: HTMLElement, name: string, onChange?: () => void) {
    this.container = container;
    this.onChange = onChange;
    void name;
  }

  static async open(container: HTMLElement, blob: Blob, name: string, onChange?: () => void): Promise<GameEditor> {
    const ed = new GameEditor(container, name, onChange);
    const text = (await blob.text()).trim();
    if (!text) {
      ed.renderTemplatePicker();
    } else {
      ed.doc = parseGameDoc(text);
      ed.buildUI();
    }
    return ed;
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    if (!this.doc) return null;
    return { blob: new Blob([serializeGameDoc(this.doc)], { type: 'application/json' }), contentType: 'application/json' };
  }

  destroy(): void {
    this.stopPlay();
    this.room?.close();
    this.room = null;
    this.container.replaceChildren();
  }

  // ---- Template picker (shown for a brand-new empty .game file) ----
  private renderTemplatePicker() {
    this.container.replaceChildren();
    const wrap = el('div', 'game-picker');

    // Ready-to-play arenas: open straight into Play mode, zero building.
    wrap.append(el('h2', 'game-picker-title', 'Ready to play'));
    wrap.append(el('p', 'game-picker-sub', 'Jump straight in — these open in Play mode. Edit your copy anytime.'));
    const arenaGrid = el('div', 'game-picker-grid');
    for (const a of ARENAS) {
      const card = el('button', 'game-picker-card game-picker-arena');
      card.append(
        el('div', 'game-picker-icon', a.icon),
        el('div', 'game-picker-name', a.name),
        el('div', 'game-picker-blurb', a.blurb),
        el('div', 'game-picker-play', '▶ Play now'),
      );
      card.addEventListener('click', () => {
        this.doc = a.make();
        this.buildUI();
        this.emitChange();
        this.switchTab('play'); // instant play
      });
      arenaGrid.append(card);
    }
    wrap.append(arenaGrid);

    // Build-from-scratch templates.
    wrap.append(el('h2', 'game-picker-title', 'Build your own'));
    const grid = el('div', 'game-picker-grid');
    for (const t of TEMPLATES) {
      const card = el('button', 'game-picker-card');
      card.append(
        el('div', 'game-picker-icon', t.icon),
        el('div', 'game-picker-name', t.name),
        el('div', 'game-picker-blurb', t.blurb),
      );
      card.addEventListener('click', () => {
        this.doc = createGameDoc(t.id, 'Untitled game');
        this.buildUI();
        this.emitChange(); // persist the fresh doc immediately
      });
      grid.append(card);
    }
    wrap.append(grid);
    this.container.replaceChildren(wrap);
  }

  // ---- Shell / tabs ----
  private buildUI() {
    this.root = el('div', 'game-editor');

    const bar = el('div', 'game-topbar');
    const tabs = el('div', 'game-tabs');
    const mk = (id: Tab, label: string) => {
      const b = el('button', 'game-tab', label);
      b.dataset.tab = id;
      b.addEventListener('click', () => this.switchTab(id));
      tabs.append(b);
      return b;
    };
    mk('level', 'Level');
    mk('sprites', 'Sprites');
    mk('rules', 'Rules');
    mk('play', '▶ Play');
    bar.append(tabs);

    // Undo / redo.
    const hist = el('div', 'game-hist');
    const undo = el('button', 'game-btn', '↶');
    undo.title = 'Undo';
    undo.addEventListener('click', () => this.undo());
    const redo = el('button', 'game-btn', '↷');
    redo.title = 'Redo';
    redo.addEventListener('click', () => this.redo());
    hist.append(undo, redo);
    bar.append(hist);

    // Live control + online avatars.
    const live = el('div', 'game-live');
    const liveBtn = el('button', 'game-btn game-live-btn', '● Go live');
    liveBtn.addEventListener('click', () => this.toggleLive());
    live.append(liveBtn);
    const avatars = el('div', 'game-avatars');
    live.append(avatars);
    bar.append(live);

    this.root.append(bar);
    this.bodyEl = el('div', 'game-body');
    this.root.append(this.bodyEl);
    this.container.replaceChildren(this.root);

    // Auto-join a room from a shared link (#room=...).
    const hashRoom = /#room=([\w-]+)/.exec(location.hash)?.[1];
    if (hashRoom) this.joinRoom(hashRoom);

    this.switchTab('level');
  }

  private switchTab(tab: Tab) {
    if (this.tab === 'play' && tab !== 'play') this.stopPlay();
    this.tab = tab;
    for (const b of this.root.querySelectorAll<HTMLElement>('.game-tab')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    }
    this.renderBody();
  }

  private renderBody() {
    this.bodyEl.replaceChildren();
    if (this.tab === 'level') this.renderLevelTab();
    else if (this.tab === 'sprites') this.renderSpritesTab();
    else if (this.tab === 'rules') this.renderRulesTab();
    else this.renderPlayTab();
    this.updateAvatars();
  }

  // ---- Edit plumbing ----
  /** Current game document (for AI context). */
  aiDoc(): GameDoc { return this.doc; }

  /** Apply a batch of AI-generated game ops through the normal local path. */
  applyAiOps(ops: GameOp[]): string {
    let n = 0;
    for (const op of ops) { try { this.applyLocal(op); n++; } catch { /* skip bad op */ } }
    return `applied ${n} change(s)`;
  }

  private applyLocal(op: GameOp) {
    this.undoStack.push(serializeGameDoc(this.doc));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    applyOp(this.doc, op);
    this.room?.sendOp(op);
    this.emitChange();
  }

  private emitChange() { this.onChange?.(); }

  /** Undo/redo only: the level is a tile painter with no object selection. Nothing in Play mode. */
  commands(): EditCommands {
    if (!this.doc || !this.root || this.tab === 'play') return {};
    return {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.undoStack.length > 0,
      canRedo: () => this.redoStack.length > 0,
    };
  }

  private undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(serializeGameDoc(this.doc));
    this.doc = parseGameDoc(prev);
    this.emitChange();
    this.renderBody();
  }
  private redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(serializeGameDoc(this.doc));
    this.doc = parseGameDoc(next);
    this.emitChange();
    this.renderBody();
  }

  // ---- LEVEL tab ----
  private levelCanvas: HTMLCanvasElement | null = null;

  private renderLevelTab() {
    if (this.doc.template === 'racer') {
      const note = el('div', 'game-racer-note');
      note.append(
        el('div', 'game-picker-icon', '🏎️'),
        el('h3', 'game-picker-name', 'This track builds itself'),
        el('p', 'game-hint', 'Lane racers spawn traffic and coins automatically. Tune lanes, speed and traffic gap in the Rules tab, set your car and obstacle in Sprites, then hit ▶ Play.'),
      );
      this.bodyEl.append(note);
      return;
    }
    const wrap = el('div', 'game-level');

    // Palette.
    const pal = el('div', 'game-palette');
    for (const p of PALETTE) {
      const b = el('button', 'game-swatch', `${this.glyph(p.tile, p.fallback)} ${p.label}`);
      b.setAttribute('aria-pressed', String(this.activeTile === p.tile));
      b.addEventListener('click', () => {
        this.activeTile = p.tile;
        for (const s of pal.querySelectorAll('.game-swatch')) s.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
      });
      pal.append(b);
    }
    wrap.append(pal);

    // Resize controls.
    const resize = el('div', 'game-resize');
    resize.append(el('span', 'game-label', 'Grid'));
    const cols = numInput(this.doc.level.cols, 4, 80, (v) => this.resizeLevel(v, this.doc.level.rows));
    const rows = numInput(this.doc.level.rows, 4, 60, (v) => this.resizeLevel(this.doc.level.cols, v));
    resize.append(cols, el('span', 'game-x', '×'), rows);
    wrap.append(resize);

    // Canvas painter.
    const scroller = el('div', 'game-canvas-wrap');
    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    this.levelCanvas = canvas;
    scroller.append(canvas);
    wrap.append(scroller);
    this.drawLevel();

    let painting = false;
    const paintAt = (ev: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const c = Math.floor(((ev.clientX - r.left) / r.width) * this.doc.level.cols);
      const row = Math.floor(((ev.clientY - r.top) / r.height) * this.doc.level.rows);
      if (c < 0 || row < 0 || c >= this.doc.level.cols || row >= this.doc.level.rows) return;
      const i = row * this.doc.level.cols + c;
      // 'start'/'goal' are unique: clear any existing one first.
      if ((this.activeTile === 'start' || this.activeTile === 'goal')) {
        const old = this.doc.level.tiles.indexOf(this.activeTile);
        if (old >= 0 && old !== i) this.applyLocal({ t: 'tile', i: old, v: 'empty' });
      }
      if (this.doc.level.tiles[i] !== this.activeTile) this.applyLocal({ t: 'tile', i, v: this.activeTile });
      this.drawLevel();
    };
    canvas.addEventListener('pointerdown', (e) => { painting = true; canvas.setPointerCapture(e.pointerId); paintAt(e); });
    canvas.addEventListener('pointermove', (e) => {
      if (painting) paintAt(e);
      this.maybeSendCursor(e, canvas);
    });
    canvas.addEventListener('pointerup', () => { painting = false; });
    canvas.addEventListener('pointerleave', () => { painting = false; });

    this.bodyEl.append(wrap);
  }

  private resizeLevel(cols: number, rows: number) {
    const old = this.doc.level;
    const tiles: TileType[] = new Array(cols * rows).fill('empty');
    for (let r = 0; r < Math.min(rows, old.rows); r++) {
      for (let c = 0; c < Math.min(cols, old.cols); c++) {
        tiles[r * cols + c] = old.tiles[r * old.cols + c];
      }
    }
    this.applyLocal({ t: 'resize', cols, rows, tiles });
    this.renderBody();
  }

  private drawLevel() {
    const canvas = this.levelCanvas;
    if (!canvas) return;
    const ts = this.doc.settings.tileSize;
    const { cols, rows, tiles } = this.doc.level;
    canvas.width = cols * ts;
    canvas.height = rows * ts;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#11151c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Grid lines.
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= cols; c++) { ctx.beginPath(); ctx.moveTo(c * ts, 0); ctx.lineTo(c * ts, canvas.height); ctx.stroke(); }
    for (let r = 0; r <= rows; r++) { ctx.beginPath(); ctx.moveTo(0, r * ts); ctx.lineTo(canvas.width, r * ts); ctx.stroke(); }
    // Tiles.
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t === 'empty') continue;
      const c = i % cols, r = Math.floor(i / cols);
      this.drawGlyphOn(ctx, t, c * ts, r * ts, ts);
    }
    // Peer cursors.
    this.peerCursors.forEach((cur, id) => {
      const peer = this.peers.find((p) => p.id === id);
      const color = peer?.color ?? '#fff';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cur.x * ts, cur.y * ts, 6, 0, Math.PI * 2);
      ctx.fill();
      if (peer) {
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillText(peer.name, cur.x * ts + 9, cur.y * ts + 4);
      }
    });
  }

  private imgCache = new Map<string, HTMLImageElement>();
  private drawGlyphOn(ctx: CanvasRenderingContext2D, key: string, px: number, py: number, size: number) {
    const v = this.doc.assets.sprites[key];
    if (!v) return;
    if (v.startsWith('data:')) {
      let img = this.imgCache.get(v);
      if (!img) { img = new Image(); img.src = v; this.imgCache.set(v, img); img.onload = () => this.drawLevel(); }
      if (img.complete && img.naturalWidth) ctx.drawImage(img, px, py, size, size);
    } else {
      ctx.font = `${Math.floor(size * 0.85)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(v, px + size / 2, py + size / 2);
    }
  }

  private glyph(key: string, fallback: string): string {
    const v = this.doc.assets.sprites[key];
    return v && !v.startsWith('data:') ? v : fallback;
  }

  private maybeSendCursor(ev: PointerEvent, canvas: HTMLCanvasElement) {
    if (!this.room) return;
    const now = performance.now();
    if (now - this.cursorSentAt < 60) return;
    this.cursorSentAt = now;
    const r = canvas.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * this.doc.level.cols;
    const y = ((ev.clientY - r.top) / r.height) * this.doc.level.rows;
    this.room.sendCursor(x, y);
  }

  // ---- SPRITES tab ----
  private renderSpritesTab() {
    const wrap = el('div', 'game-sprites');
    wrap.append(el('p', 'game-hint', 'Pick an emoji or upload a tiny image for each thing in your game.'));
    for (const key of SPRITE_KEYS) {
      const row = el('div', 'game-sprite-row');
      const preview = el('div', 'game-sprite-preview');
      const renderPreview = () => {
        const v = this.doc.assets.sprites[key] ?? '';
        preview.replaceChildren();
        if (v.startsWith('data:')) {
          const img = document.createElement('img');
          img.src = v; img.className = 'game-sprite-img';
          preview.append(img);
        } else preview.textContent = v || '❓';
      };
      renderPreview();
      row.append(preview, el('div', 'game-sprite-key', key));

      const choices = el('div', 'game-emoji-choices');
      for (const e of EMOJI_CHOICES) {
        const b = el('button', 'game-emoji', e);
        b.addEventListener('click', () => { this.applyLocal({ t: 'asset', k: key, v: e }); renderPreview(); this.drawLevel(); });
        choices.append(b);
      }
      row.append(choices);

      const upload = document.createElement('input');
      upload.type = 'file'; upload.accept = 'image/*'; upload.className = 'game-upload';
      upload.addEventListener('change', async () => {
        const f = upload.files?.[0];
        if (!f) return;
        const dataUrl = await fileToSmallDataUrl(f, 48);
        this.applyLocal({ t: 'asset', k: key, v: dataUrl });
        renderPreview();
        upload.value = '';
      });
      row.append(upload);
      wrap.append(row);
    }
    this.bodyEl.append(wrap);
  }

  // ---- RULES tab ----
  private renderRulesTab() {
    const wrap = el('div', 'game-rules');

    const title = el('div', 'game-field');
    title.append(el('label', 'game-label', 'Title'));
    const t = document.createElement('input');
    t.type = 'text'; t.value = this.doc.meta.title; t.className = 'game-text';
    t.addEventListener('input', () => this.applyLocal({ t: 'meta', title: t.value }));
    title.append(t);
    wrap.append(title);

    const isP = this.doc.template === 'platformer';
    const s = this.doc.settings;
    const slider = (k: keyof typeof s, label: string, min: number, max: number, step: number) => {
      const f = el('div', 'game-field');
      const lab = el('label', 'game-label', `${label}: ${s[k]}`);
      const r = document.createElement('input');
      r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step);
      r.value = String(s[k]); r.className = 'game-range';
      r.addEventListener('input', () => {
        const v = Number(r.value);
        lab.textContent = `${label}: ${v}`;
        this.applyLocal({ t: 'setting', k, v });
      });
      f.append(lab, r);
      wrap.append(f);
    };
    const isRacer = this.doc.template === 'racer';
    if (isP) {
      slider('gravity', 'Gravity', 0, 4000, 50);
      slider('jump', 'Jump power', 100, 1200, 20);
    }
    if (isRacer) {
      slider('lanes', 'Lanes', 2, 6, 1);
      slider('obstacleRate', 'Traffic gap (s)', 0.5, 2, 0.1);
    }
    slider('speed', isRacer ? 'Start speed' : 'Move speed', 40, 600, 10);
    slider('lives', 'Lives', 1, 9, 1);
    if (!isRacer) slider('tileSize', 'Tile size', 16, 64, 2);

    this.bodyEl.append(wrap);
  }

  // ---- PLAY tab ----
  private renderPlayTab() {
    const wrap = el('div', 'game-play');
    const hud = el('div', 'game-hud');
    const lives = el('span', 'game-hud-item', `❤️ ${this.doc.settings.lives}`);
    const score = el('span', 'game-hud-item', '🪙 0');
    const statusEl = el('span', 'game-hud-status', 'Playing');
    const restart = el('button', 'game-btn', 'Restart');
    hud.append(lives, score, statusEl, restart);
    wrap.append(hud);

    const scroller = el('div', 'game-canvas-wrap');
    const canvas = document.createElement('canvas');
    canvas.className = 'game-canvas';
    canvas.tabIndex = 0;
    scroller.append(canvas);
    wrap.append(scroller);

    // On-screen dpad (handy on touch).
    const dpad = el('div', 'game-dpad');
    const dbtn = (label: string, key: string) => {
      const b = el('button', 'game-dbtn', label);
      const down = (e: Event) => { e.preventDefault(); this.runner?.press(key); };
      const up = (e: Event) => { e.preventDefault(); this.runner?.release(key); };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointerleave', up);
      return b;
    };
    dpad.append(dbtn('◀', 'left'));
    if (this.doc.template === 'platformer') { dpad.append(dbtn('⤒', 'jump')); }
    else if (this.doc.template === 'topdown') { dpad.append(dbtn('▲', 'up'), dbtn('▼', 'down')); }
    // racer: left/right only (lane hops).
    dpad.append(dbtn('▶', 'right'));
    wrap.append(dpad);

    this.bodyEl.append(wrap);

    const onStatus = (st: GameStatus) => { statusEl.textContent = st === 'won' ? 'You win! 🎉' : st === 'lost' ? 'Game over 💀' : 'Playing'; };
    this.runner = runGame(canvas, this.doc, {
      onStatus,
      onScore: (v) => { score.textContent = `🪙 ${v}`; },
      onLives: (v) => { lives.textContent = `❤️ ${v}`; },
    });
    restart.addEventListener('click', () => this.runner?.restart());
    canvas.focus();

    // Co-op: announce play mode + stream avatar ~15Hz; draw peers.
    if (this.room) {
      this.room.sendMode('play');
      this.runner.setRemotePlayers(this.peerPlayers);
      this.playerTimer = window.setInterval(() => {
        if (this.runner && this.room) this.room.sendPlayer(this.runner.getPlayer());
      }, 66);
    }
  }

  private stopPlay() {
    if (this.playerTimer !== null) { clearInterval(this.playerTimer); this.playerTimer = null; }
    this.runner?.stop();
    this.runner = null;
    this.room?.sendMode('edit');
  }

  // ---- LIVE / collab ----
  private toggleLive() {
    if (this.room) { this.leaveRoom(); return; }
    const id = /#room=([\w-]+)/.exec(location.hash)?.[1] ?? Math.random().toString(36).slice(2, 8);
    this.joinRoom(id);
  }

  private joinRoom(roomId: string) {
    if (this.room) return;
    location.hash = `room=${roomId}`;
    const wsBase = API_BASE.replace(/^http/, 'ws');
    const events: RoomEvents = {
      onSnapshot: (doc, youId) => {
        this.myId = youId;
        if (doc) {
          // Adopt the room's authoritative document.
          this.doc = doc;
          this.renderBody();
        } else {
          // Empty room — publish our local doc as the starting point.
          this.room?.save(this.doc);
        }
      },
      onOp: (op, from) => {
        if (from === this.myId) return; // ignore our own echo
        applyOp(this.doc, op);
        this.emitChange();
        if (this.tab === 'level') this.drawLevel();
        else if (this.tab !== 'play') this.renderBody();
      },
      onPresence: (peers) => { this.peers = peers; this.updateAvatars(); },
      onCursor: (from, x, y) => { this.peerCursors.set(from, { x, y }); if (this.tab === 'level') this.drawLevel(); },
      onPlayer: (s) => { this.peerPlayers.set(s.id, s); this.runner?.setRemotePlayers(this.peerPlayers); },
      onLeft: (id) => {
        this.peerCursors.delete(id); this.peerPlayers.delete(id);
        this.peers = this.peers.filter((p) => p.id !== id);
        this.updateAvatars();
        this.runner?.setRemotePlayers(this.peerPlayers);
        if (this.tab === 'level') this.drawLevel();
      },
      onClose: () => { this.room = null; this.updateLiveBtn(); },
    };
    this.room = connectRoom(wsBase, roomId, this.me, events);
    this.updateLiveBtn();
    this.showRoomLink(roomId);
  }

  private leaveRoom() {
    this.room?.close();
    this.room = null;
    this.peers = []; this.peerCursors.clear(); this.peerPlayers.clear();
    this.updateLiveBtn();
    this.updateAvatars();
    const link = this.root.querySelector('.game-roomlink');
    link?.remove();
  }

  private updateLiveBtn() {
    const b = this.root.querySelector<HTMLElement>('.game-live-btn');
    if (!b) return;
    b.textContent = this.room ? '● Live' : '● Go live';
    b.classList.toggle('game-live-on', !!this.room);
  }

  private showRoomLink(roomId: string) {
    let link = this.root.querySelector<HTMLElement>('.game-roomlink');
    if (!link) {
      link = el('div', 'game-roomlink');
      this.root.querySelector('.game-live')!.append(link);
    }
    link.replaceChildren();
    const copy = el('button', 'game-btn', '🔗 Copy link');
    copy.addEventListener('click', () => {
      const url = `${location.origin}${location.pathname}#room=${roomId}`;
      void navigator.clipboard?.writeText(url);
      copy.textContent = '✓ Copied';
      setTimeout(() => { copy.textContent = '🔗 Copy link'; }, 1500);
    });
    const save = el('button', 'game-btn', '💾 Save to room');
    save.addEventListener('click', () => this.room?.save(this.doc));
    link.append(copy, save);
  }

  private updateAvatars() {
    const box = this.root?.querySelector<HTMLElement>('.game-avatars');
    if (!box) return;
    box.replaceChildren();
    for (const p of this.peers) {
      const a = el('span', 'game-avatar', p.name.slice(0, 2).toUpperCase());
      a.style.background = p.color;
      a.title = `${p.name} (${p.mode})`;
      box.append(a);
    }
  }
}

// ---- Tiny DOM + image helpers ----
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function numInput(value: number, min: number, max: number, onChange: (v: number) => void): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number'; i.className = 'game-num';
  i.min = String(min); i.max = String(max); i.value = String(value);
  i.addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, Math.round(Number(i.value) || min)));
    i.value = String(v);
    onChange(v);
  });
  return i;
}

// Load an image file, downscale to a tiny square, and return a data: URL so it
// stays small enough to embed in the doc and sync in a room.
async function fileToSmallDataUrl(file: File, max: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}
