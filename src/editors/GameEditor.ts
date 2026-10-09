// GameEditor — a scene-based game builder (viewport + gizmos + layers +
// inspector + asset tray + play mode). Follows the app's DocEditor contract
// (open/export/destroy) and edits a .game document (JSON) autosaved to OPFS and
// optionally synced live through a GameRoom. Data contracts live in game/types.ts
// and game/protocol.ts; every edit is expressed as the existing GameOp set so
// the Durable Object stays protocol-compatible.
import './styles/game.css';
import {
  type GameDoc, type GameOp, type TileType, type Entity, type GameSettings,
  applyOp, createGameDoc, serializeGameDoc, parseGameDoc,
} from './game/types';
import type { RoomClient, RoomEvents, Presence, PlayerState } from '../game/protocol';
import { connectRoom } from '../game/roomClient';
import { API_BASE } from '../api/client';
import { runGame, type RunnerHandle, type GameStatus } from './game/engine';
import { TEMPLATES, STARTERS, PALETTE, SOUND_PRESETS } from './game/templates';
import { ARENAS } from './game/arenas';
import {
  SPRITES, BACKGROUNDS, BEHAVIORS, MOTIONS, PREFABS, normEntity, newEntity, sortedEntities, spriteSrc,
  drawBackground, drawSprite, tileKey, docThumbnail, type Behavior, type Motion,
} from './game/art';
import { createSfx } from './game/sfx';
import { icon } from '../ui/icons';
import type { EditCommands } from './editCommands';

type Tool = 'select' | 'paint' | 'erase' | 'hand';
type Brush = { k: 'tile'; tile: TileType } | { k: 'prefab'; id: string };
type SheetTab = 'inspect' | 'layers' | 'world' | 'share';
type Cat = 'tiles' | 'objects' | 'enemies' | 'items' | 'decor' | 'scenery' | 'car' | 'traffic';
type Drag =
  | { k: 'pan'; sx: number; sy: number; ox: number; oy: number }
  | { k: 'move'; orig: Entity; px: number; py: number; cur: Entity; moved: boolean }
  | { k: 'resize'; orig: Entity; corner: number; cur: Entity }
  | { k: 'rotate'; orig: Entity; cur: Entity }
  | { k: 'paint'; last: number; erase: boolean; started: boolean }
  | { k: 'pinch'; d: number; mx: number; my: number };

const GUEST_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6'];
const rand = (n: number) => Math.floor(Math.random() * n);
const CORNERS: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
const CAR_KEYS = ['car_pink', 'car_blue', 'car_gold', 'car_mint', 'car_taxi', 'car_truck', 'car_red', 'car_violet'];
const snap = (v: number, s: number) => Math.round(v / s) * s;
const r2 = (v: number) => Math.round(v * 1000) / 1000;

export class GameEditor {
  private container: HTMLElement;
  private onChange?: () => void;
  private doc!: GameDoc;

  private root!: HTMLElement;
  private stage!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private trayEl!: HTMLElement;
  private sheetEl!: HTMLElement;
  private selbar!: HTMLElement;
  private toolBtns = new Map<Tool, HTMLElement>();
  private ro: ResizeObserver | null = null;

  private tool: Tool = 'select';
  private brush: Brush = { k: 'tile', tile: 'ground' };
  private cat: Cat = 'tiles';
  private selId: string | null = null;
  private sheetTab: SheetTab = 'inspect';
  private view = { z: 1, ox: 0, oy: 0 };
  private viewTouched = false;
  private pointers = new Map<number, { x: number; y: number }>();
  private drag: Drag | null = null;
  private drawQueued = false;

  private undoStack: string[] = [];
  private redoStack: string[] = [];

  private room: RoomClient | null = null;
  private myId = '';
  private me = { name: `Guest ${rand(1000)}`, color: GUEST_COLORS[rand(GUEST_COLORS.length)]! };
  private peers: Presence[] = [];
  private peerCursors = new Map<string, { x: number; y: number }>();
  private peerPlayers = new Map<string, PlayerState>();
  private cursorSentAt = 0;

  private playEl: HTMLElement | null = null;
  private runner: RunnerHandle | null = null;
  private playerTimer: number | null = null;
  private onKey = (e: KeyboardEvent) => this.handleKey(e);

  private constructor(container: HTMLElement, name: string, onChange?: () => void) {
    this.container = container;
    this.onChange = onChange;
    void name;
  }

  static async open(container: HTMLElement, blob: Blob, name: string, onChange?: () => void): Promise<GameEditor> {
    const ed = new GameEditor(container, name, onChange);
    const text = (await blob.text()).trim();
    if (!text) ed.renderGallery(false);
    else { ed.doc = parseGameDoc(text); ed.buildUI(); }
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
    this.ro?.disconnect();
    window.removeEventListener('keydown', this.onKey);
    this.container.replaceChildren();
  }

  // ======================= Template gallery =======================
  private renderGallery(overlay: boolean) {
    const wrap = el('div', overlay ? 'ge-gallery ge-gallery-over' : 'ge-gallery');
    const head = el('div', 'ge-gallery-head');
    head.append(el('h2', 'ge-gallery-title', 'Start a game'));
    if (overlay) {
      const close = ibtn('x', 'Close');
      close.addEventListener('click', () => wrap.remove());
      head.append(close);
    }
    wrap.append(head);

    const section = (title: string, sub: string, cards: HTMLElement[]) => {
      wrap.append(el('h3', 'ge-gallery-sec', title), el('p', 'ge-gallery-sub', sub));
      const g = el('div', 'ge-gallery-grid');
      g.append(...cards);
      wrap.append(g);
    };
    const card = (name: string, tag: string, blurb: string, doc: () => GameDoc, play: boolean) => {
      const b = el('button', 'ge-card');
      const d = doc();
      const img = document.createElement('img');
      img.className = 'ge-card-thumb'; img.alt = ''; img.src = docThumbnail(d);
      const body = el('div', 'ge-card-body');
      body.append(el('div', 'ge-card-tag', tag), el('div', 'ge-card-name', name), el('div', 'ge-card-blurb', blurb));
      b.append(img, body);
      b.addEventListener('click', () => this.adoptDoc(doc(), play, overlay));
      return b;
    };
    section('Ready-made games', 'Fully built levels with objects and behaviors. Open one, then make it yours.',
      STARTERS.map((s) => card(s.name, s.tag, s.blurb, s.make, false)));
    section('Play instantly', 'Lane racers that open straight into Play.',
      ARENAS.map((a) => card(a.name, 'Racer', a.blurb, a.make, true)));
    section('Blank canvas', 'Start from an empty scene with sensible physics.',
      TEMPLATES.map((t) => card(t.name, 'Blank', t.blurb, () => createGameDoc(t.id, 'Untitled game'), false)));
    if (overlay) this.root.append(wrap); else this.container.replaceChildren(wrap);
  }

  private adoptDoc(doc: GameDoc, play: boolean, overlay: boolean) {
    if (overlay) {
      this.pushUndo();
      this.doc = doc; this.selId = null;
      this.room?.save(doc);
      this.root.querySelector('.ge-gallery')?.remove();
      this.viewTouched = false;
      this.emitChange(); this.refreshAll();
    } else {
      this.doc = doc;
      this.buildUI();
      this.emitChange();
    }
    if (play) this.startPlay();
  }

  // ======================= Shell =======================
  private buildUI() {
    this.root = el('div', 'game-editor');

    // ---- top bar ----
    const bar = el('div', 'ge-top');
    const title = document.createElement('input');
    title.className = 'ge-title'; title.value = this.doc.meta.title; title.setAttribute('aria-label', 'Game title');
    title.addEventListener('change', () => { this.batch([{ t: 'meta', title: title.value }]); });
    bar.append(title);
    const hist = el('div', 'ge-group');
    const undo = ibtn('undo', 'Undo'); undo.addEventListener('click', () => this.undo());
    const redo = ibtn('redo', 'Redo'); redo.addEventListener('click', () => this.redo());
    hist.append(undo, redo);
    bar.append(hist);
    bar.append(el('div', 'ge-spacer'));
    const avatars = el('div', 'ge-avatars'); bar.append(avatars);
    const tpl = ibtn('gridIcon', 'Templates'); tpl.addEventListener('click', () => { if (!this.root.querySelector('.ge-gallery')) this.renderGallery(true); });
    const panel = ibtn('sliders', 'Panels'); panel.classList.add('ge-panel-btn');
    panel.addEventListener('click', () => this.toggleSheet());
    const play = el('button', 'ge-play-btn');
    play.innerHTML = `${icon('play', 18)}<span>Play</span>`;
    play.addEventListener('click', () => this.startPlay());
    bar.append(tpl, panel, play);
    this.root.append(bar);

    // ---- main ----
    const main = el('div', 'ge-main');
    const left = el('div', 'ge-left');
    this.stage = el('div', 'ge-stage');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'ge-canvas';
    this.stage.append(this.canvas);

    const tools = el('div', 'ge-tools');
    const mkTool = (t: Tool, ic: string, label: string) => {
      const b = ibtn(ic, label);
      b.addEventListener('click', () => this.setTool(t));
      this.toolBtns.set(t, b); tools.append(b);
    };
    mkTool('select', 'mousePointer', 'Select and move');
    mkTool('paint', 'brush', 'Paint / place');
    mkTool('erase', 'eraser', 'Erase');
    mkTool('hand', 'hand', 'Pan');
    this.stage.append(tools);

    const zoom = el('div', 'ge-zoom');
    const zi = ibtn('plus', 'Zoom in'), zo = ibtn('minus', 'Zoom out'), zf = ibtn('maximize', 'Fit to screen');
    zi.addEventListener('click', () => this.zoomBy(1.25));
    zo.addEventListener('click', () => this.zoomBy(0.8));
    zf.addEventListener('click', () => { this.viewTouched = false; this.fit(); });
    zoom.append(zi, zo, zf);
    this.stage.append(zoom);

    this.selbar = el('div', 'ge-selbar');
    this.stage.append(this.selbar);
    left.append(this.stage);

    this.trayEl = el('div', 'ge-tray');
    left.append(this.trayEl);
    main.append(left);

    this.sheetEl = el('aside', 'ge-sheet');
    main.append(this.sheetEl);
    this.root.append(main);
    this.container.replaceChildren(this.root);

    this.bindStage();
    this.ro = new ResizeObserver(() => this.onResize());
    this.ro.observe(this.stage);
    window.addEventListener('keydown', this.onKey);

    const hashRoom = /#room=([\w-]+)/.exec(location.hash)?.[1];
    if (hashRoom) this.joinRoom(hashRoom);

    this.setTool(this.doc.template === 'racer' ? 'hand' : 'select');
    this.refreshAll();
  }

  private refreshAll() {
    this.renderTray(); this.renderSheet(); this.renderSelbar(); this.updateAvatars(); this.requestDraw();
  }

  private handleKey(e: KeyboardEvent) {
    if (this.playEl) { if (e.code === 'Escape') this.togglePause(); return; }
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (!this.root.isConnected) return;
    if (e.code === 'Escape') { this.select(null); }
    else if (this.selId && e.code.startsWith('Arrow')) {
      const en = this.sel(); if (!en) return;
      const d = e.shiftKey ? 1 : 0.5;
      const dx = e.code === 'ArrowLeft' ? -d : e.code === 'ArrowRight' ? d : 0;
      const dy = e.code === 'ArrowUp' ? -d : e.code === 'ArrowDown' ? d : 0;
      this.patchEntity(en.id, { x: en.x + dx, y: en.y + dy });
      e.preventDefault();
    }
  }

  // ======================= Edit plumbing =======================
  /** Current game document (for AI context). */
  aiDoc(): GameDoc { return this.doc; }

  /** Apply a batch of AI-generated game ops through the normal local path. */
  applyAiOps(ops: GameOp[]): string {
    let n = 0;
    this.pushUndo();
    for (const op of ops) { try { this.apply(op); n++; } catch { /* skip bad op */ } }
    if (this.root) this.refreshAll();
    return `applied ${n} change(s)`;
  }

  private pushUndo() {
    this.undoStack.push(serializeGameDoc(this.doc));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  private apply(op: GameOp) {
    applyOp(this.doc, op);
    this.room?.sendOp(op);
    this.emitChange();
  }
  /** One undo step for a group of ops. */
  private batch(ops: GameOp[]) {
    if (!ops.length) return;
    this.pushUndo();
    for (const op of ops) this.apply(op);
    this.requestDraw();
  }
  private emitChange() { this.onChange?.(); }

  commands(): EditCommands {
    if (!this.doc || !this.root || this.playEl) return {};
    return {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.undoStack.length > 0,
      canRedo: () => this.redoStack.length > 0,
      delete: () => this.deleteSel(),
      duplicate: () => this.duplicateSel(),
      hasSelection: () => !!this.sel(),
    };
  }

  private restore(json: string) {
    this.doc = parseGameDoc(json);
    if (this.selId && !this.sel()) this.selId = null;
    this.room?.save(this.doc);
    this.emitChange();
    this.refreshAll();
  }
  private undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(serializeGameDoc(this.doc));
    this.restore(prev);
  }
  private redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(serializeGameDoc(this.doc));
    this.restore(next);
  }

  // ---- entity helpers ----
  private sel(): Entity | null {
    return this.selId ? this.doc.level.entities.find((e) => e.id === this.selId) ?? null : null;
  }
  private clone(e: Entity): Entity { return { ...e, props: { ...(e.props ?? {}) } }; }

  /** Replace an entity with an edited copy as a single undoable step. */
  private commitEntity(orig: Entity, next: Entity, push = true) {
    const ops: GameOp[] = [];
    const sameProps = JSON.stringify(orig.props ?? {}) === JSON.stringify(next.props ?? {}) && orig.type === next.type;
    if (sameProps) {
      if (orig.x === next.x && orig.y === next.y) return;
      ops.push({ t: 'entity.move', id: orig.id, x: next.x, y: next.y });
    } else ops.push({ t: 'entity.del', id: orig.id }, { t: 'entity.add', e: next });
    if (push) this.batch(ops); else for (const op of ops) this.apply(op);
  }

  private patchEntity(id: string, patch: { x?: number; y?: number; props?: Record<string, number | string | boolean> }) {
    const orig = this.doc.level.entities.find((e) => e.id === id);
    if (!orig) return;
    const next = this.clone(orig);
    if (patch.x !== undefined) next.x = r2(patch.x);
    if (patch.y !== undefined) next.y = r2(patch.y);
    if (patch.props) next.props = { ...next.props, ...patch.props };
    this.commitEntity(orig, next);
    this.renderSelbar(); this.renderSheetSoft();
  }

  private deleteSel() {
    const e = this.sel(); if (!e) return;
    this.batch([{ t: 'entity.del', id: e.id }]);
    this.selId = null; this.refreshAll();
  }
  private duplicateSel() {
    const e = this.sel(); if (!e) return;
    const n = newEntity(e.type, e.x + 0.5, e.y + 0.5);
    n.props = { ...(e.props ?? {}), o: (n.props?.o as number) ?? 0 };
    this.batch([{ t: 'entity.add', e: n }]);
    this.selId = n.id; this.refreshAll();
  }
  private select(id: string | null) {
    this.selId = id; this.renderSelbar(); this.renderSheetSoft(); this.requestDraw();
  }

  // ======================= Tools / tray =======================
  private setTool(t: Tool) {
    this.tool = t;
    for (const [k, b] of this.toolBtns) b.setAttribute('aria-pressed', String(k === t));
    this.stage?.setAttribute('data-tool', t);
  }

  private catItems(cat: Cat): { id: string; label: string; src: string; on: () => void; active: boolean }[] {
    const d = this.doc;
    if (cat === 'tiles') {
      return PALETTE.map((p) => ({
        id: p.tile, label: p.label, src: spriteSrc(d, p.tile === 'ground' ? 'ground_top' : p.tile) || spriteSrc(d, p.tile),
        active: this.brush.k === 'tile' && this.brush.tile === p.tile && this.tool === 'paint',
        on: () => { this.brush = { k: 'tile', tile: p.tile }; this.setTool('paint'); this.renderTray(); },
      }));
    }
    if (cat === 'scenery') {
      return BACKGROUNDS.filter((b) => b.id !== 'road').map((b) => ({
        id: b.id, label: b.label, src: bgSwatch(b.top, b.bottom, b.far),
        active: (d.assets.sprites.bg ?? 'sky') === b.id,
        on: () => { this.batch([{ t: 'asset', k: 'bg', v: b.id }]); this.renderTray(); },
      }));
    }
    if (cat === 'car' || cat === 'traffic') {
      const key = cat === 'car' ? 'player' : 'enemy';
      return CAR_KEYS.map((k) => ({
        id: k, label: k.replace('car_', ''), src: SPRITES[k]!,
        active: d.assets.sprites[key] === SPRITES[k],
        on: () => { this.batch([{ t: 'asset', k: key, v: SPRITES[k]! }]); this.renderTray(); },
      }));
    }
    return PREFABS.filter((p) => p.cat === cat).map((p) => ({
      id: p.id, label: p.label, src: spriteSrc(d, p.id),
      active: this.brush.k === 'prefab' && this.brush.id === p.id && this.tool === 'paint',
      on: () => { this.brush = { k: 'prefab', id: p.id }; this.setTool('paint'); this.renderTray(); },
    }));
  }

  private renderTray() {
    const t = this.trayEl;
    t.replaceChildren();
    const racer = this.doc.template === 'racer';
    const cats: [Cat, string][] = racer
      ? [['car', 'Your car'], ['traffic', 'Traffic']]
      : [['tiles', 'Tiles'], ['objects', 'Objects'], ['enemies', 'Hazards'], ['items', 'Items'], ['decor', 'Decor'], ['scenery', 'Scenery']];
    if (!cats.some(([c]) => c === this.cat)) this.cat = cats[0]![0];
    const chips = el('div', 'ge-chips');
    for (const [c, label] of cats) {
      const b = el('button', 'ge-chip', label);
      b.setAttribute('aria-pressed', String(c === this.cat));
      b.addEventListener('click', () => { this.cat = c; this.renderTray(); });
      chips.append(b);
    }
    const row = el('div', 'ge-assets');
    for (const it of this.catItems(this.cat)) {
      const b = el('button', 'ge-asset');
      b.setAttribute('aria-pressed', String(it.active));
      const im = document.createElement('img'); im.src = it.src; im.alt = ''; im.draggable = false;
      b.append(im, el('span', 'ge-asset-label', it.label));
      b.addEventListener('click', it.on);
      row.append(b);
    }
    t.append(chips, row);
  }

  // ======================= Selection bar =======================
  private renderSelbar() {
    const b = this.selbar; b.replaceChildren();
    const e = this.sel();
    b.hidden = !e;
    if (!e) return;
    b.append(el('span', 'ge-selname', normEntity(e).name));
    const mk = (ic: string, label: string, fn: () => void) => { const x = ibtn(ic, label); x.addEventListener('click', fn); b.append(x); };
    mk('sliders', 'Properties', () => { this.sheetTab = 'inspect'; this.openSheet(true); });
    mk('copy', 'Duplicate', () => this.duplicateSel());
    mk('trash', 'Delete', () => this.deleteSel());
  }

  // ======================= Sheet (inspector / layers / world / share) =======================
  private sheetOpen = false;
  private toggleSheet() { this.openSheet(!this.sheetOpen); }
  private openSheet(open: boolean) {
    this.sheetOpen = open;
    this.root.classList.toggle('ge-sheet-open', open);
    if (open) this.renderSheet();
    setTimeout(() => this.onResize(), 260);
  }
  /** Re-render the sheet unless the user is typing in it. */
  private renderSheetSoft() {
    const a = document.activeElement;
    if (a && this.sheetEl?.contains(a) && (a as HTMLElement).tagName === 'INPUT' && (a as HTMLInputElement).type !== 'range') return;
    this.renderSheet();
  }

  private renderSheet() {
    const s = this.sheetEl; s.replaceChildren();
    const grab = el('button', 'ge-grab'); grab.setAttribute('aria-label', 'Close panel');
    grab.addEventListener('click', () => this.openSheet(false));
    s.append(grab);
    const tabs = el('div', 'ge-tabs');
    for (const [id, label] of [['inspect', 'Inspector'], ['layers', 'Layers'], ['world', 'World'], ['share', 'Share']] as [SheetTab, string][]) {
      const b = el('button', 'ge-tab', label);
      b.setAttribute('aria-selected', String(this.sheetTab === id));
      b.addEventListener('click', () => { this.sheetTab = id; this.renderSheet(); });
      tabs.append(b);
    }
    s.append(tabs);
    const body = el('div', 'ge-sheet-body');
    if (this.sheetTab === 'inspect') this.renderInspector(body);
    else if (this.sheetTab === 'layers') this.renderLayers(body);
    else if (this.sheetTab === 'world') this.renderWorld(body);
    else this.renderShare(body);
    s.append(body);
  }

  private field(label: string, value: number, step: number, on: (v: number) => void, min?: number, max?: number): HTMLElement {
    const f = el('label', 'ge-field');
    f.append(el('span', 'ge-field-l', label));
    const i = document.createElement('input');
    i.type = 'number'; i.className = 'ge-num'; i.step = String(step); i.value = String(r2(value));
    if (min !== undefined) i.min = String(min);
    if (max !== undefined) i.max = String(max);
    i.addEventListener('change', () => {
      let v = Number(i.value); if (!Number.isFinite(v)) v = value;
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      on(v);
    });
    f.append(i);
    return f;
  }

  private chipRow<T extends string>(items: { id: T; label: string }[], cur: T, on: (v: T) => void): HTMLElement {
    const r = el('div', 'ge-chips ge-chips-wrap');
    for (const it of items) {
      const b = el('button', 'ge-chip', it.label);
      b.setAttribute('aria-pressed', String(it.id === cur));
      b.addEventListener('click', () => on(it.id));
      r.append(b);
    }
    return r;
  }

  private renderInspector(body: HTMLElement) {
    const e = this.sel();
    if (!e) {
      body.append(el('p', 'ge-empty', this.doc.template === 'racer'
        ? 'Lane racers build their own track. Pick cars in the tray and tune speed in World.'
        : 'Nothing selected. Tap an object in the scene or in Layers to edit its transform, physics and behavior.'));
      return;
    }
    const n = normEntity(e);
    const head = el('div', 'ge-insp-head');
    const th = document.createElement('img'); th.className = 'ge-insp-thumb'; th.src = spriteSrc(this.doc, e.type); th.alt = '';
    const name = document.createElement('input'); name.className = 'ge-text'; name.value = n.name; name.setAttribute('aria-label', 'Name');
    name.addEventListener('change', () => this.patchEntity(e.id, { props: { name: name.value } }));
    head.append(th, name);
    body.append(head);

    body.append(el('div', 'ge-sec', 'Transform'));
    const g = el('div', 'ge-grid');
    g.append(
      this.field('X', e.x, 0.25, (v) => this.patchEntity(e.id, { x: v })),
      this.field('Y', e.y, 0.25, (v) => this.patchEntity(e.id, { y: v })),
      this.field('Width', n.w, 0.25, (v) => this.patchEntity(e.id, { props: { w: v } }), 0.25, 40),
      this.field('Height', n.h, 0.25, (v) => this.patchEntity(e.id, { props: { h: v } }), 0.25, 40),
      this.field('Rotation', n.rot, 15, (v) => this.patchEntity(e.id, { props: { rot: ((v % 360) + 360) % 360 } })),
      this.field('Layer', n.z, 1, (v) => this.patchEntity(e.id, { props: { z: Math.round(v) } }), -9, 9),
    );
    body.append(g);
    const acts = el('div', 'ge-row');
    const mk = (ic: string, label: string, fn: () => void) => {
      const b = el('button', 'ge-btn'); b.innerHTML = `${icon(ic, 16)}<span>${label}</span>`; b.addEventListener('click', fn); acts.append(b);
    };
    mk('flipH', 'Flip', () => this.patchEntity(e.id, { props: { flip: !n.flip } }));
    mk('rotateCw', 'Rotate 90', () => this.patchEntity(e.id, { props: { rot: (n.rot + 90) % 360 } }));
    mk('copy', 'Duplicate', () => this.duplicateSel());
    mk('trash', 'Delete', () => this.deleteSel());
    body.append(acts);

    body.append(el('div', 'ge-sec', 'Behavior'));
    body.append(this.chipRow(BEHAVIORS.map((b) => ({ id: b.id, label: b.label })), n.behavior,
      (v: Behavior) => this.patchEntity(e.id, { props: { behavior: v } })));
    body.append(el('p', 'ge-hint', BEHAVIORS.find((b) => b.id === n.behavior)?.hint ?? ''));
    if (n.behavior === 'collect') body.append(this.field('Score value', n.value, 1, (v) => this.patchEntity(e.id, { props: { value: Math.round(v) } }), 0, 99));

    body.append(el('div', 'ge-sec', 'Motion'));
    body.append(this.chipRow(MOTIONS, n.motion, (v: Motion) => this.patchEntity(e.id, { props: { motion: v } })));
    if (n.motion !== 'none') {
      const m = el('div', 'ge-grid');
      m.append(
        this.field('Range (tiles)', n.range, 0.5, (v) => this.patchEntity(e.id, { props: { range: v } }), 0, 40),
        this.field('Speed', n.speed, 0.1, (v) => this.patchEntity(e.id, { props: { speed: v } }), 0.1, 12),
      );
      body.append(m);
    }

    body.append(el('div', 'ge-sec', 'Art'));
    const art = el('div', 'ge-row');
    const up = el('label', 'ge-btn'); up.innerHTML = `${icon('upload', 16)}<span>Upload sprite</span>`;
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*'; inp.hidden = true;
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0]; if (!f) return;
      this.batch([{ t: 'asset', k: e.type, v: await fileToSmallDataUrl(f, 96) }]); inp.value = ''; this.refreshAll();
    });
    up.append(inp);
    const reset = el('button', 'ge-btn'); reset.innerHTML = `${icon('rotateCw', 16)}<span>Reset art</span>`;
    reset.addEventListener('click', () => { const v = SPRITES[e.type]; if (v) { this.batch([{ t: 'asset', k: e.type, v }]); this.refreshAll(); } });
    art.append(up, reset);
    body.append(art);
  }

  private renderLayers(body: HTMLElement) {
    const list = el('div', 'ge-layers');
    const ents = sortedEntities(this.doc).reverse();
    if (!ents.length) list.append(el('p', 'ge-empty', 'No objects yet. Pick one from the Objects tray and tap the scene.'));
    for (const e of ents) {
      const n = normEntity(e);
      const row = el('div', 'ge-layer');
      row.setAttribute('aria-selected', String(e.id === this.selId));
      const th = document.createElement('img'); th.src = spriteSrc(this.doc, e.type); th.alt = ''; th.className = 'ge-layer-thumb';
      const name = el('button', 'ge-layer-name', n.name);
      name.addEventListener('click', () => this.select(e.id));
      const eye = ibtn(n.hidden ? 'eyeOff' : 'eye', n.hidden ? 'Show' : 'Hide');
      eye.addEventListener('click', () => this.patchEntity(e.id, { props: { hidden: !n.hidden } }));
      const lock = ibtn(n.locked ? 'lock' : 'unlock', n.locked ? 'Unlock' : 'Lock');
      lock.addEventListener('click', () => this.patchEntity(e.id, { props: { locked: !n.locked } }));
      row.append(th, name, el('span', 'ge-layer-z', `z${n.z}`), eye, lock);
      list.append(row);
    }
    const tiles = el('div', 'ge-layer ge-layer-fixed');
    tiles.append(el('span', 'ge-layer-name', `Tiles (${this.doc.level.tiles.filter((t) => t !== 'empty').length})`));
    const bgr = el('div', 'ge-layer ge-layer-fixed');
    bgr.append(el('span', 'ge-layer-name', `Background: ${BACKGROUNDS.find((b) => b.id === this.doc.assets.sprites.bg)?.label ?? 'Daybreak'}`));
    list.append(tiles, bgr);
    body.append(list);
  }

  private renderWorld(body: HTMLElement) {
    const d = this.doc, s = d.settings, racer = d.template === 'racer';
    const slider = (k: keyof GameSettings, label: string, min: number, max: number, step: number, def?: number) => {
      const f = el('div', 'ge-slider');
      const cur = (s[k] as number | undefined) ?? def ?? min;
      const lab = el('label', 'ge-field-l', `${label}: ${cur}`);
      const r = document.createElement('input');
      r.type = 'range'; r.min = String(min); r.max = String(max); r.step = String(step); r.value = String(cur); r.className = 'ge-range';
      let pushed = false;
      r.addEventListener('input', () => {
        const v = Number(r.value); lab.textContent = `${label}: ${v}`;
        if (!pushed) { this.pushUndo(); pushed = true; }
        this.apply({ t: 'setting', k, v });
      });
      r.addEventListener('change', () => { pushed = false; this.requestDraw(); });
      f.append(lab, r); body.append(f);
    };
    body.append(el('div', 'ge-sec', 'Physics'));
    if (d.template === 'platformer') { slider('gravity', 'Gravity', 0, 4000, 50); slider('jump', 'Jump power', 100, 1200, 20); }
    if (racer) { slider('lanes', 'Lanes', 2, 6, 1); slider('obstacleRate', 'Traffic gap (s)', 0.5, 2, 0.1, 1.1); }
    slider('speed', racer ? 'Start speed' : 'Move speed', 40, 600, 10);
    slider('lives', 'Lives', 1, 9, 1);
    if (!racer) slider('tileSize', 'Tile size', 16, 64, 2);

    body.append(el('div', 'ge-sec', 'Game feel'));
    slider('shake', 'Screen shake', 0, 2, 0.25, 1);
    slider('particles', 'Particles', 0, 2, 0.25, 1);
    body.append(el('div', 'ge-sec', 'Sound'));
    const cur = d.assets.sprites.sfx ?? 'retro';
    body.append(this.chipRow(SOUND_PRESETS.map((p) => ({ id: p.id as string, label: p.label })), cur, (v) => {
      this.batch([{ t: 'asset', k: 'sfx', v }]);
      const sfx = createSfx(v); sfx.play('coin'); setTimeout(() => sfx.close(), 800);
      this.renderSheet();
    }));

    if (!racer) {
      body.append(el('div', 'ge-sec', 'Scene size'));
      const g = el('div', 'ge-grid');
      g.append(
        this.field('Columns', d.level.cols, 1, (v) => this.resizeLevel(Math.round(v), d.level.rows), 4, 120),
        this.field('Rows', d.level.rows, 1, (v) => this.resizeLevel(d.level.cols, Math.round(v)), 4, 80),
      );
      body.append(g);
      body.append(el('div', 'ge-sec', 'Background'));
      body.append(this.chipRow(BACKGROUNDS.filter((b) => b.id !== 'road').map((b) => ({ id: b.id, label: b.label })), d.assets.sprites.bg ?? 'sky',
        (v) => { this.batch([{ t: 'asset', k: 'bg', v }]); this.renderSheet(); this.renderTray(); }));
    }
  }

  private resizeLevel(cols: number, rows: number) {
    const old = this.doc.level;
    const tiles: TileType[] = new Array(cols * rows).fill('empty');
    for (let r = 0; r < Math.min(rows, old.rows); r++) for (let c = 0; c < Math.min(cols, old.cols); c++) tiles[r * cols + c] = old.tiles[r * old.cols + c]!;
    this.batch([{ t: 'resize', cols, rows, tiles }]);
    this.viewTouched = false; this.fit(); this.renderSheet();
  }

  private renderShare(body: HTMLElement) {
    body.append(el('div', 'ge-sec', 'Co-build and play live'));
    body.append(el('p', 'ge-hint', 'Go live to invite friends. Everyone edits the same scene in real time and can play together.'));
    const live = el('button', this.room ? 'ge-btn ge-btn-on' : 'ge-btn ge-btn-primary');
    live.innerHTML = `${icon('users', 16)}<span>${this.room ? 'Leave live session' : 'Go live'}</span>`;
    live.addEventListener('click', () => { this.toggleLive(); });
    body.append(live);
    const roomId = /#room=([\w-]+)/.exec(location.hash)?.[1];
    if (this.room && roomId) {
      const row = el('div', 'ge-row');
      const copy = el('button', 'ge-btn'); copy.innerHTML = `${icon('link', 16)}<span>Copy invite link</span>`;
      copy.addEventListener('click', () => {
        void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#room=${roomId}`);
        copy.querySelector('span')!.textContent = 'Copied';
        setTimeout(() => { const sp = copy.querySelector('span'); if (sp) sp.textContent = 'Copy invite link'; }, 1500);
      });
      const save = el('button', 'ge-btn'); save.innerHTML = `${icon('upload', 16)}<span>Push my scene to room</span>`;
      save.addEventListener('click', () => this.room?.save(this.doc));
      row.append(copy, save);
      body.append(row);
      const ppl = el('div', 'ge-peers');
      for (const p of this.peers) {
        const x = el('div', 'ge-peer');
        const dot = el('span', 'ge-dot'); dot.style.background = p.color;
        x.append(dot, el('span', '', `${p.name} (${p.mode})`));
        ppl.append(x);
      }
      body.append(ppl);
    }
    body.append(el('div', 'ge-sec', 'Export'));
    const dl = el('button', 'ge-btn'); dl.innerHTML = `${icon('download', 16)}<span>Download .game file</span>`;
    dl.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([serializeGameDoc(this.doc)], { type: 'application/json' }));
      a.download = `${(this.doc.meta.title || 'game').replace(/[^\w-]+/g, '-')}.game`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    body.append(dl);
  }

  // ======================= Viewport =======================
  private requestDraw() {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => { this.drawQueued = false; this.draw(); });
  }

  private onResize() {
    if (!this.stage?.isConnected) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.stage.clientWidth, h = this.stage.clientHeight;
    if (!w || !h) return;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    if (!this.viewTouched) this.fit(); else this.requestDraw();
  }

  private worldSize() {
    const ts = this.doc.settings.tileSize;
    return { w: this.doc.level.cols * ts, h: this.doc.level.rows * ts, ts };
  }
  private fit() {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    if (!W || !H) return;
    const { w, h } = this.worldSize();
    const padX = 24, padY = 24;
    const z = Math.max(0.1, Math.min(4, Math.min((W - padX * 2) / w, (H - padY * 2) / h)));
    this.view = { z, ox: (W - w * z) / 2, oy: (H - h * z) / 2 };
    this.requestDraw();
  }
  private zoomBy(f: number, cx?: number, cy?: number) {
    const W = this.stage.clientWidth, H = this.stage.clientHeight;
    const px = cx ?? W / 2, py = cy ?? H / 2;
    const nz = Math.max(0.1, Math.min(6, this.view.z * f));
    const k = nz / this.view.z;
    this.view = { z: nz, ox: px - (px - this.view.ox) * k, oy: py - (py - this.view.oy) * k };
    this.viewTouched = true; this.requestDraw();
  }

  // screen (stage-relative css px) <-> tile space
  private toTile(sx: number, sy: number) {
    const { ts } = this.worldSize();
    return { x: (sx - this.view.ox) / (this.view.z * ts), y: (sy - this.view.oy) / (this.view.z * ts) };
  }
  private toScreen(tx: number, ty: number) {
    const { ts } = this.worldSize();
    return { x: tx * ts * this.view.z + this.view.ox, y: ty * ts * this.view.z + this.view.oy };
  }
  private local(ev: PointerEvent | WheelEvent) {
    const r = this.stage.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  }

  private draw() {
    const cv = this.canvas;
    if (!cv?.isConnected || !cv.width) return;
    const ctx = cv.getContext('2d')!;
    const dpr = cv.width / (this.stage.clientWidth || cv.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const { z, ox, oy } = this.view;
    const { w, h, ts } = this.worldSize();
    const d = this.doc;
    const again = () => this.requestDraw();

    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * ox, dpr * oy);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = 24 / z; ctx.shadowOffsetY = 6 / z;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.restore();

    if (d.template === 'racer') { this.drawRacerPreview(ctx, w, h, ts); }
    else {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, h); ctx.clip();
      drawBackground(ctx, d.assets.sprites.bg, 0, 0, w, h);
      const ov = this.drag && 'cur' in this.drag ? this.drag.cur : null;
      const ents = sortedEntities(d).map((x) => (ov && x.id === ov.id ? ov : x));
      const drawEnt = (e: Entity) => {
        const n = normEntity(e);
        ctx.save();
        ctx.globalAlpha = n.hidden ? 0.28 : 1;
        ctx.translate((e.x + n.w / 2) * ts, (e.y + n.h / 2) * ts);
        ctx.rotate((n.rot * Math.PI) / 180);
        if (n.flip) ctx.scale(-1, 1);
        drawSprite(ctx, d, e.type, -n.w * ts / 2, -n.h * ts / 2, n.w * ts, n.h * ts, again);
        ctx.restore();
      };
      for (const e of ents) if (normEntity(e).z < 0) drawEnt(e);
      const { cols, tiles } = d.level;
      for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i]!;
        if (t === 'empty') continue;
        const c = i % cols, r = Math.floor(i / cols);
        drawSprite(ctx, d, tileKey(d, t, c, r), c * ts, r * ts, ts, ts, again);
      }
      for (const e of ents) if (normEntity(e).z >= 0) drawEnt(e);
      // Grid.
      const dark = ['night', 'cave'].includes(d.assets.sprites.bg ?? 'sky');
      ctx.lineWidth = 1 / z;
      ctx.strokeStyle = dark ? 'rgba(255,255,255,.12)' : 'rgba(22,18,31,.14)';
      ctx.beginPath();
      for (let c = 0; c <= d.level.cols; c++) { ctx.moveTo(c * ts, 0); ctx.lineTo(c * ts, h); }
      for (let r = 0; r <= d.level.rows; r++) { ctx.moveTo(0, r * ts); ctx.lineTo(w, r * ts); }
      ctx.stroke();
      ctx.restore();
      // Peer cursors.
      this.peerCursors.forEach((cur, id) => {
        const peer = this.peers.find((p) => p.id === id);
        ctx.fillStyle = peer?.color ?? '#fff';
        ctx.beginPath(); ctx.arc(cur.x * ts, cur.y * ts, 6 / z, 0, Math.PI * 2); ctx.fill();
        if (peer) { ctx.font = `${11 / z}px system-ui, sans-serif`; ctx.fillText(peer.name, cur.x * ts + 9 / z, cur.y * ts + 4 / z); }
      });
    }
    // Frame outline.
    ctx.strokeStyle = 'rgba(255,77,141,.9)'; ctx.lineWidth = 2 / z; ctx.strokeRect(0, 0, w, h);

    // Selection gizmo (screen space).
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const e = this.drag && 'cur' in this.drag ? this.drag.cur : this.sel();
    if (e && this.tool !== 'erase') this.drawGizmo(ctx, e);
  }

  private drawRacerPreview(ctx: CanvasRenderingContext2D, w: number, h: number, ts: number) {
    const d = this.doc, lanes = d.settings.lanes ?? 3, laneW = w / lanes;
    ctx.fillStyle = '#23262e'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = Math.max(2, laneW * 0.05); ctx.setLineDash([laneW * 0.4, laneW * 0.35]);
    for (let i = 1; i < lanes; i++) { ctx.beginPath(); ctx.moveTo(i * laneW, 0); ctx.lineTo(i * laneW, h); ctx.stroke(); }
    ctx.setLineDash([]);
    const cs = laneW * 0.95 * 1.1, again = () => this.requestDraw();
    drawSprite(ctx, d, 'enemy', laneW * 0.5 - cs / 2, h * 0.18, cs, cs, again);
    drawSprite(ctx, d, 'coin', laneW * (lanes - 0.5) - laneW * 0.31, h * 0.4, laneW * 0.62, laneW * 0.62, again);
    drawSprite(ctx, d, 'enemy', laneW * (lanes - 0.5) - cs / 2, h * 0.52, cs, cs, again);
    drawSprite(ctx, d, 'player', laneW * (Math.floor(lanes / 2) + 0.5) - cs / 2, h - cs - laneW * 0.3, cs, cs, again);
    void ts;
  }

  private handleR() { return window.matchMedia?.('(pointer: coarse)').matches ? 14 : 8; }

  private gizmo(e: Entity) {
    const n = normEntity(e), th = (n.rot * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
    const cx = e.x + n.w / 2, cy = e.y + n.h / 2;
    const loc = (lx: number, ly: number) => this.toScreen(cx + lx * cs - ly * sn, cy + lx * sn + ly * cs);
    const corners = CORNERS.map(([sx, sy]) => loc(sx * n.w / 2, sy * n.h / 2));
    const top = loc(0, -n.h / 2);
    const up = { x: sn, y: -cs }; // rotated "up" in screen space
    return { n, corners, top, rot: { x: top.x + up.x * 38, y: top.y + up.y * 38 }, center: this.toScreen(cx, cy) };
  }

  private drawGizmo(ctx: CanvasRenderingContext2D, e: Entity) {
    const g = this.gizmo(e), R = this.handleR();
    const css = getComputedStyle(this.root);
    const brand = css.getPropertyValue('--brand-500').trim() || '#ff4d8d';
    ctx.save();
    ctx.strokeStyle = brand; ctx.lineWidth = 2;
    ctx.beginPath();
    g.corners.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath(); ctx.stroke();
    if (!g.n.locked) {
      ctx.beginPath(); ctx.moveTo(g.top.x, g.top.y); ctx.lineTo(g.rot.x, g.rot.y); ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const p of g.corners) { ctx.beginPath(); ctx.rect(p.x - R, p.y - R, R * 2, R * 2); ctx.fill(); ctx.stroke(); }
      ctx.beginPath(); ctx.arc(g.rot.x, g.rot.y, R, 0, Math.PI * 2); ctx.fillStyle = brand; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
    }
    ctx.restore();
  }

  private hitEntity(tx: number, ty: number): Entity | null {
    const list = sortedEntities(this.doc);
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!, n = normEntity(e);
      if (n.hidden || n.locked) continue;
      const th = (-n.rot * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
      const dx = tx - (e.x + n.w / 2), dy = ty - (e.y + n.h / 2);
      const lx = dx * cs - dy * sn, ly = dx * sn + dy * cs;
      if (Math.abs(lx) <= Math.max(n.w, 0.6) / 2 && Math.abs(ly) <= Math.max(n.h, 0.6) / 2) return e;
    }
    return null;
  }

  // ---- pointer handling ----
  private bindStage() {
    const st = this.stage;
    st.addEventListener('pointerdown', (ev) => this.onDown(ev));
    st.addEventListener('pointermove', (ev) => this.onMove(ev));
    st.addEventListener('pointerup', (ev) => this.onUp(ev));
    st.addEventListener('pointercancel', (ev) => this.onUp(ev));
    st.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const p = this.local(ev);
      if (ev.ctrlKey || ev.metaKey || Math.abs(ev.deltaY) > Math.abs(ev.deltaX)) this.zoomBy(Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
      else { this.view.ox -= ev.deltaX; this.viewTouched = true; this.requestDraw(); }
    }, { passive: false });
  }

  private isUi(ev: PointerEvent) {
    const t = ev.target as HTMLElement;
    return !!t.closest('.ge-tools, .ge-zoom, .ge-selbar');
  }

  private onDown(ev: PointerEvent) {
    if (this.isUi(ev) || this.playEl) return;
    const p = this.local(ev);
    this.stage.setPointerCapture(ev.pointerId);
    this.pointers.set(ev.pointerId, p);
    if (this.pointers.size === 2) { this.startPinch(); return; }
    if (this.pointers.size > 2) return;
    const racer = this.doc.template === 'racer';
    if (this.tool === 'hand' || racer) { this.startPan(p); return; }

    const t = this.toTile(p.x, p.y);
    if (this.tool === 'select') {
      const s = this.sel();
      if (s && !normEntity(s).locked) {
        const g = this.gizmo(s), R = this.handleR() + 8;
        if (Math.hypot(p.x - g.rot.x, p.y - g.rot.y) <= R) { this.drag = { k: 'rotate', orig: this.clone(s), cur: this.clone(s) }; return; }
        for (let i = 0; i < 4; i++) {
          if (Math.hypot(p.x - g.corners[i]!.x, p.y - g.corners[i]!.y) <= R) { this.drag = { k: 'resize', orig: this.clone(s), corner: i, cur: this.clone(s) }; return; }
        }
      }
      const hit = this.hitEntity(t.x, t.y);
      if (hit) {
        this.select(hit.id);
        this.drag = { k: 'move', orig: this.clone(hit), cur: this.clone(hit), px: t.x, py: t.y, moved: false };
      } else { this.select(null); this.startPan(p); }
      return;
    }
    if (this.tool === 'erase') {
      const hit = this.hitEntity(t.x, t.y);
      if (hit) { this.batch([{ t: 'entity.del', id: hit.id }]); if (this.selId === hit.id) this.selId = null; this.refreshAll(); return; }
      this.drag = { k: 'paint', last: -1, erase: true, started: false };
      this.paintAt(t.x, t.y);
      return;
    }
    // paint tool
    if (this.brush.k === 'prefab') {
      const pf = PREFABS.find((x) => x.id === (this.brush as { id: string }).id);
      const e = newEntity(this.brush.id, snap(t.x - (pf?.w ?? 1) / 2, 0.5), snap(t.y - (pf?.h ?? 1) / 2, 0.5));
      this.batch([{ t: 'entity.add', e }]);
      this.selId = e.id; this.setTool('select'); this.refreshAll();
      return;
    }
    this.drag = { k: 'paint', last: -1, erase: false, started: false };
    this.paintAt(t.x, t.y);
  }

  private startPan(p: { x: number; y: number }) {
    this.drag = { k: 'pan', sx: p.x, sy: p.y, ox: this.view.ox, oy: this.view.oy };
  }
  private startPinch() {
    const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    this.drag = { k: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private onMove(ev: PointerEvent) {
    const p = this.local(ev);
    this.maybeSendCursor(p);
    if (!this.pointers.has(ev.pointerId)) return;
    this.pointers.set(ev.pointerId, p);
    const dr = this.drag;
    if (!dr) return;
    if (dr.k === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      this.view.ox += mx - dr.mx; this.view.oy += my - dr.my;
      this.zoomBy(dist / dr.d, mx, my);
      dr.d = dist; dr.mx = mx; dr.my = my;
      return;
    }
    if (this.pointers.size > 1) return;
    const t = this.toTile(p.x, p.y);
    if (dr.k === 'pan') {
      this.view.ox = dr.ox + (p.x - dr.sx); this.view.oy = dr.oy + (p.y - dr.sy);
      this.viewTouched = true; this.requestDraw();
    } else if (dr.k === 'move') {
      const nx = snap(dr.orig.x + (t.x - dr.px), 0.5), ny = snap(dr.orig.y + (t.y - dr.py), 0.5);
      if (nx !== dr.cur.x || ny !== dr.cur.y) { dr.cur.x = nx; dr.cur.y = ny; dr.moved = true; this.requestDraw(); }
    } else if (dr.k === 'rotate') {
      const n = normEntity(dr.orig), c = { x: dr.orig.x + n.w / 2, y: dr.orig.y + n.h / 2 };
      let a = (Math.atan2(t.y - c.y, t.x - c.x) * 180) / Math.PI + 90;
      a = ((a % 360) + 360) % 360;
      const m = Math.round(a / 15) * 15;
      if (Math.abs(m - a) < 5) a = m;
      dr.cur.props = { ...dr.cur.props, rot: Math.round(a) % 360 };
      this.requestDraw();
    } else if (dr.k === 'resize') {
      this.resizeDrag(dr, t);
    } else if (dr.k === 'paint') this.paintAt(t.x, t.y);
  }

  private resizeDrag(dr: Extract<Drag, { k: 'resize' }>, t: { x: number; y: number }) {
    const n = normEntity(dr.orig), th = (n.rot * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
    const cx = dr.orig.x + n.w / 2, cy = dr.orig.y + n.h / 2;
    const [sx, sy] = CORNERS[dr.corner]!;
    const dx = t.x - cx, dy = t.y - cy;
    const lx = dx * cs + dy * sn, ly = -dx * sn + dy * cs; // pointer in entity-local space
    const ox = -sx * n.w / 2, oy = -sy * n.h / 2;          // fixed (opposite) corner
    const nw = Math.max(0.25, snap(sx * (lx - ox), 0.25)), nh = Math.max(0.25, snap(sy * (ly - oy), 0.25));
    const mx = ox + sx * nw / 2, my = oy + sy * nh / 2;    // new centre, local
    const ncx = cx + mx * cs - my * sn, ncy = cy + mx * sn + my * cs;
    dr.cur.x = r2(ncx - nw / 2); dr.cur.y = r2(ncy - nh / 2);
    dr.cur.props = { ...dr.cur.props, w: nw, h: nh };
    this.requestDraw();
  }

  private onUp(ev: PointerEvent) {
    this.pointers.delete(ev.pointerId);
    const dr = this.drag;
    if (this.pointers.size === 1 && dr?.k === 'pinch') { const [p] = [...this.pointers.values()]; this.startPan(p!); return; }
    if (this.pointers.size > 0) return;
    this.drag = null;
    if (!dr) return;
    if (dr.k === 'move' && dr.moved) { this.commitEntity(dr.orig, dr.cur); this.renderSelbar(); this.renderSheetSoft(); }
    else if ((dr.k === 'rotate' || dr.k === 'resize')) { this.commitEntity(dr.orig, dr.cur); this.renderSheetSoft(); }
    else if (dr.k === 'paint' && dr.started) this.renderSheetSoft();
    this.requestDraw();
  }

  private paintAt(tx: number, ty: number) {
    const dr = this.drag;
    if (!dr || dr.k !== 'paint') return;
    const { cols, rows } = this.doc.level;
    const c = Math.floor(tx), r = Math.floor(ty);
    if (c < 0 || r < 0 || c >= cols || r >= rows) { dr.last = -1; return; }
    const cells: number[] = [];
    if (dr.last >= 0) {
      let x0 = dr.last % cols, y0 = Math.floor(dr.last / cols);
      const dx = Math.abs(c - x0), dy = -Math.abs(r - y0), sx = x0 < c ? 1 : -1, sy = y0 < r ? 1 : -1;
      let err = dx + dy;
      for (;;) {
        cells.push(y0 * cols + x0);
        if (x0 === c && y0 === r) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    } else cells.push(r * cols + c);
    dr.last = r * cols + c;
    const v: TileType = dr.erase ? 'empty' : this.brush.k === 'tile' ? this.brush.tile : 'empty';
    for (const i of cells) {
      if (this.doc.level.tiles[i] === v) continue;
      if (!dr.started) { this.pushUndo(); dr.started = true; }
      if ((v === 'start' || v === 'goal')) {
        const old = this.doc.level.tiles.indexOf(v);
        if (old >= 0 && old !== i) this.apply({ t: 'tile', i: old, v: 'empty' });
      }
      this.apply({ t: 'tile', i, v });
    }
    this.requestDraw();
  }

  private maybeSendCursor(p: { x: number; y: number }) {
    if (!this.room) return;
    const now = performance.now();
    if (now - this.cursorSentAt < 60) return;
    this.cursorSentAt = now;
    const t = this.toTile(p.x, p.y);
    this.room.sendCursor(t.x, t.y);
  }

  // ======================= Play mode =======================
  private startPlay() {
    if (this.playEl) return;
    this.select(null);
    const d = this.doc;
    const ov = el('div', 'ge-playview');
    this.playEl = ov;
    const cv = document.createElement('canvas');
    cv.className = 'ge-playcanvas';
    if (d.template === 'racer') cv.classList.add('ge-playcanvas-fit');
    ov.append(cv);

    // HUD.
    const hud = el('div', 'ge-hud');
    const hearts = el('div', 'ge-hud-pill ge-hud-lives');
    const scorePill = el('div', 'ge-hud-pill ge-hud-score');
    const coin = document.createElement('img'); coin.src = SPRITES.coin!; coin.alt = ''; coin.className = 'ge-hud-coin';
    const scoreN = el('span', 'ge-hud-num', '0');
    scorePill.append(coin, scoreN);
    const hudL = el('div', 'ge-hud-side'); hudL.append(hearts, scorePill);
    const hudR = el('div', 'ge-hud-side');
    const pause = ibtn('pause', 'Pause'); pause.classList.add('ge-hud-btn');
    pause.addEventListener('click', () => this.togglePause());
    const stop = ibtn('stop', 'Stop and return to editor'); stop.classList.add('ge-hud-btn');
    stop.addEventListener('click', () => this.stopPlay());
    hudR.append(pause, stop);
    hud.append(hudL, hudR);
    ov.append(hud);

    const setLives = (n: number) => {
      hearts.innerHTML = '';
      for (let i = 0; i < d.settings.lives; i++) {
        const h = el('span', i < n ? 'ge-heart' : 'ge-heart ge-heart-off');
        h.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z" fill="currentColor"/></svg>';
        hearts.append(h);
      }
    };
    setLives(d.settings.lives);

    // Result + pause overlays.
    const card = el('div', 'ge-result'); card.hidden = true;
    const showCard = (title: string, sub: string, actions: [string, () => void, boolean?][]) => {
      card.replaceChildren(el('div', 'ge-result-title', title), el('div', 'ge-result-sub', sub));
      const row = el('div', 'ge-row ge-row-center');
      for (const [label, fn, primary] of actions) {
        const b = el('button', primary ? 'ge-btn ge-btn-primary' : 'ge-btn', label);
        b.addEventListener('click', fn); row.append(b);
      }
      card.append(row); card.hidden = false;
    };
    ov.append(card);
    this.pauseCard = { show: showCard, hide: () => { card.hidden = true; }, pauseBtn: pause };

    let score = 0;
    const onStatus = (st: GameStatus) => {
      if (st === 'playing') { card.hidden = true; return; }
      const win = st === 'won';
      showCard(win ? 'You win' : 'Game over', `Score ${score}`, [
        ['Play again', () => { this.runner?.restart(); }, true],
        ['Back to editor', () => this.stopPlay()],
      ]);
    };
    this.pendingStatus = onStatus;

    // Touch controls.
    if (d.template === 'racer') ov.append(this.racerPad());
    else ov.append(this.stickPad(d.template === 'platformer'));

    this.root.append(ov);
    this.runner = runGame(cv, d, {
      onStatus, onLives: setLives,
      onScore: (v) => { score = v; scoreN.textContent = String(v); },
    });
    if (this.room) {
      this.room.sendMode('play');
      this.runner.setRemotePlayers(this.peerPlayers);
      this.playerTimer = window.setInterval(() => { if (this.runner && this.room) this.room.sendPlayer(this.runner.getPlayer()); }, 66);
    }
  }
  private pauseCard: { show: (t: string, s: string, a: [string, () => void, boolean?][]) => void; hide: () => void; pauseBtn: HTMLElement } | null = null;
  private pendingStatus: ((s: GameStatus) => void) | null = null;

  private togglePause() {
    const r = this.runner, pc = this.pauseCard;
    if (!r || !pc) return;
    if (r.isPaused()) { r.resume(); pc.hide(); pc.pauseBtn.innerHTML = icon('pause', 20); return; }
    r.pause();
    pc.pauseBtn.innerHTML = icon('play', 20);
    pc.show('Paused', this.doc.meta.title, [
      ['Resume', () => this.togglePause(), true],
      ['Restart', () => { this.togglePause(); this.runner?.restart(); }],
      ['Exit', () => this.stopPlay()],
    ]);
  }

  private stopPlay() {
    if (this.playerTimer !== null) { clearInterval(this.playerTimer); this.playerTimer = null; }
    this.runner?.stop(); this.runner = null;
    this.playEl?.remove(); this.playEl = null;
    this.pauseCard = null; this.pendingStatus = null;
    this.room?.sendMode('edit');
    if (this.root) this.requestDraw();
  }

  /** Virtual joystick + action button (touch-first; hidden for fine pointers on wide screens via CSS). */
  private stickPad(platformer: boolean): HTMLElement {
    const pad = el('div', 'ge-pad');
    const stick = el('div', 'ge-stick'); const knob = el('div', 'ge-knob'); stick.append(knob);
    const press = (k: string, on: boolean) => { if (on) this.runner?.press(k); else this.runner?.release(k); };
    const state: Record<string, boolean> = {};
    const set = (k: string, on: boolean) => { if (state[k] !== on) { state[k] = on; press(k, on); } };
    let pid = -1;
    const move = (ev: PointerEvent) => {
      const r = stick.getBoundingClientRect(), R = r.width / 2;
      let dx = ev.clientX - (r.left + R), dy = ev.clientY - (r.top + R);
      const m = Math.hypot(dx, dy), lim = R * 0.75;
      if (m > lim) { dx = (dx / m) * lim; dy = (dy / m) * lim; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      const th = R * 0.28;
      set('left', dx < -th); set('right', dx > th);
      if (platformer) set('up', dy < -R * 0.55); else { set('up', dy < -th); set('down', dy > th); }
    };
    const end = () => { pid = -1; knob.style.transform = ''; for (const k of Object.keys(state)) set(k, false); };
    stick.addEventListener('pointerdown', (ev) => { pid = ev.pointerId; stick.setPointerCapture(pid); move(ev); });
    stick.addEventListener('pointermove', (ev) => { if (ev.pointerId === pid) move(ev); });
    stick.addEventListener('pointerup', end); stick.addEventListener('pointercancel', end);
    pad.append(stick);
    if (platformer) {
      const a = el('button', 'ge-action'); a.innerHTML = `${icon('chevronUp', 30)}`; a.setAttribute('aria-label', 'Jump');
      a.addEventListener('pointerdown', (ev) => { ev.preventDefault(); a.setPointerCapture(ev.pointerId); this.runner?.press('jump'); a.classList.add('ge-on'); });
      const up = () => { this.runner?.release('jump'); a.classList.remove('ge-on'); };
      a.addEventListener('pointerup', up); a.addEventListener('pointercancel', up);
      pad.append(a);
    }
    return pad;
  }

  private racerPad(): HTMLElement {
    const pad = el('div', 'ge-pad ge-pad-racer');
    for (const [k, ic] of [['left', 'chevronUp'], ['right', 'chevronUp']] as const) {
      const b = el('button', `ge-lane ge-lane-${k}`); b.innerHTML = icon(ic, 34); b.setAttribute('aria-label', k);
      const down = (ev: Event) => { ev.preventDefault(); this.runner?.press(k); b.classList.add('ge-on'); };
      const up = () => { this.runner?.release(k); b.classList.remove('ge-on'); };
      b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
      pad.append(b);
    }
    return pad;
  }

  // ======================= LIVE / collab =======================
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
        if (doc) { this.doc = parseGameDoc(JSON.stringify(doc)); if (this.selId && !this.sel()) this.selId = null; this.refreshAll(); }
        else this.room?.save(this.doc);
      },
      onOp: (op, from) => {
        if (from === this.myId) return;
        applyOp(this.doc, op);
        this.emitChange();
        if (this.selId && !this.sel()) this.selId = null;
        this.requestDraw(); this.renderSelbar();
        if (this.sheetTab === 'layers' || this.sheetTab === 'inspect') this.renderSheetSoft();
      },
      onPresence: (peers) => { this.peers = peers; this.updateAvatars(); if (this.sheetTab === 'share') this.renderSheetSoft(); },
      onCursor: (from, x, y) => { this.peerCursors.set(from, { x, y }); this.requestDraw(); },
      onPlayer: (s) => { this.peerPlayers.set(s.id, s); this.runner?.setRemotePlayers(this.peerPlayers); },
      onLeft: (id) => {
        this.peerCursors.delete(id); this.peerPlayers.delete(id);
        this.peers = this.peers.filter((p) => p.id !== id);
        this.updateAvatars(); this.runner?.setRemotePlayers(this.peerPlayers); this.requestDraw();
      },
      onClose: () => { this.room = null; if (this.sheetTab === 'share') this.renderSheetSoft(); },
    };
    this.room = connectRoom(wsBase, roomId, this.me, events);
    if (this.sheetTab === 'share') this.renderSheet();
  }

  private leaveRoom() {
    this.room?.close(); this.room = null;
    this.peers = []; this.peerCursors.clear(); this.peerPlayers.clear();
    this.updateAvatars(); this.renderSheet(); this.requestDraw();
  }

  private updateAvatars() {
    const box = this.root?.querySelector<HTMLElement>('.ge-avatars');
    if (!box) return;
    box.replaceChildren();
    for (const p of this.peers) {
      const a = el('span', 'ge-avatar', p.name.slice(0, 2).toUpperCase());
      a.style.background = p.color; a.title = `${p.name} (${p.mode})`;
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
function ibtn(name: string, label: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'ge-ibtn'; b.type = 'button';
  b.innerHTML = icon(name, 20); b.title = label; b.setAttribute('aria-label', label);
  return b;
}
function bgSwatch(top: string, bottom: string, far: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs><rect width="64" height="64" rx="10" fill="url(#g)"/><path d="M0 50q16-18 32-4t32-8v26H0z" fill="${far}"/></svg>`)}`;
}

// Load an image file, downscale, and return a data: URL so it stays small enough
// to embed in the doc and sync in a room.
async function fileToSmallDataUrl(file: File, max: number): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej; im.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale)), h = Math.max(1, Math.round(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/png');
  } finally { URL.revokeObjectURL(url); }
}
