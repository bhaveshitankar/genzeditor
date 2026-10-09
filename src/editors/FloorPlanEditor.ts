// FloorPlanEditor — a Planner5D-style interior-design tool. Follows the app's
// DocEditor contract (open/export/destroy) and edits a .floorplan document
// (JSON, see floorplan/model.ts) autosaved to OPFS.
//
// The 2D plan is drawn as a scaled SVG (metre coordinates, zoom/pan). Walls are
// drawn segment-by-segment with live length readout; furniture is dragged in
// from a catalog palette and tuned in an inspector. A "3D" toggle extrudes the
// very same model via a lazily-loaded Three.js scene (floorplan/view3d.ts).
import './styles/floorplan.css';
import {
  type FloorPlan, type Wall, type FurniturePlacement,
  createFloorPlan, serializeFloorPlan, parseFloorPlan, newId,
  wallLength, enclosedArea, planBounds,
} from './floorplan/model';
import { CATALOG, CATALOG_CATEGORIES, catalogItem, glyphSvg, glyphPaths } from './floorplan/catalog';
import { icon } from '../ui/icons';
import { mount3D, type View3D } from './floorplan/view3d';
import { getAppClipboard, setAppClipboard, type EditCommands } from './editCommands';

const SVGNS = 'http://www.w3.org/2000/svg';
type Tool = 'select' | 'wall';
type Selection = { kind: 'wall' | 'furniture'; id: string } | null;
type FpClip = { kind: 'wall'; item: Wall } | { kind: 'furniture'; item: FurniturePlacement };

export class FloorPlanEditor {
  private container: HTMLElement;
  private onChange?: () => void;
  private plan: FloorPlan;

  private root!: HTMLElement;
  private svg!: SVGSVGElement;
  private world!: SVGGElement;    // metre-space group (translate + scale applied)
  private areaEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private paletteEl!: HTMLElement;
  private doneBtn!: HTMLButtonElement;
  private activeCat: string = CATALOG_CATEGORIES[0];
  private ro: ResizeObserver | null = null;
  private mq = window.matchMedia('(max-width: 820px)');

  private tool: Tool = 'select';
  private selection: Selection = null;

  // Viewport: pixels-per-metre and pan offset (pixels).
  private pxPerM = 48;
  private ox = 40;
  private oy = 40;

  // In-progress wall drawing (metre coords of the last committed vertex).
  private wallStart: { x: number; y: number } | null = null;

  private undoStack: string[] = [];
  private redoStack: string[] = [];

  // 3D overlay state.
  private view3d: View3D | null = null;
  private threeHost: HTMLElement | null = null;

  private constructor(container: HTMLElement, plan: FloorPlan, onChange?: () => void) {
    this.container = container;
    this.plan = plan;
    this.onChange = onChange;
  }

  static async open(container: HTMLElement, blob: Blob, _name: string, onChange?: () => void): Promise<FloorPlanEditor> {
    const text = (await blob.text()).trim();
    const plan = text ? safeParse(text) : createFloorPlan();
    const ed = new FloorPlanEditor(container, plan, onChange);
    ed.build();
    if (!text) ed.emitChange(); // persist a fresh blank plan immediately
    else if (plan.walls.length || plan.furniture.length) requestAnimationFrame(() => ed.fit());
    return ed;
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    return {
      blob: new Blob([serializeFloorPlan(this.plan)], { type: 'application/json' }),
      contentType: 'application/json',
    };
  }

  destroy(): void {
    this.ro?.disconnect();
    this.view3d?.dispose();
    this.view3d = null;
    this.container.replaceChildren();
  }

  // ---- Build the shell ----
  private build() {
    this.root = el('div', 'fp-editor');

    // Toolbar: top bar on desktop, thumb-reachable bottom bar on mobile.
    const bar = el('div', 'fp-topbar');
    const tools = el('div', 'fp-tools');
    tools.append(
      this.toolBtn('select', 'mousePointer', 'Select'),
      this.toolBtn('wall', 'wall', 'Wall'),
    );
    bar.append(tools);

    const hist = el('div', 'fp-hist');
    hist.append(
      iconBtn('undo', 'Undo', () => this.undo(), 'fp-undo', 'Undo'),
      iconBtn('redo', 'Redo', () => this.redo(), 'fp-redo', 'Redo'),
    );
    bar.append(hist);

    const right = el('div', 'fp-topright');
    right.append(
      iconBtn('maximize', 'Fit to screen', () => this.fit(), 'fp-only-m', 'Fit'),
      iconBtn('box3d', '3D view', () => this.toggle3D(), 'fp-3d-btn', '3D'),
    );
    bar.append(right);

    // Body: palette | canvas | inspector (sheets on mobile).
    const body = el('div', 'fp-body');
    const scrim = el('div', 'fp-scrim');
    scrim.addEventListener('click', () => this.setPaletteOpen(false));
    const fab = iconBtn('plus', 'Add furniture', () => this.setPaletteOpen(true), 'fp-fab', 'Add');
    body.append(this.buildPalette(), this.buildCanvas(), this.buildInspector(), scrim, fab);
    this.root.append(body, bar);

    this.container.replaceChildren(this.root);
    this.redraw();

    // Keep the grid / viewport correct when the container resizes (rotation, sheets).
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.redraw());
      this.ro.observe(this.svg);
    }

    // Keyboard: Esc finishes wall drawing. (Delete/copy/paste/undo are routed
    // by the shell through commands().)
    this.root.tabIndex = 0;
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.wallStart = null; this.setPaletteOpen(false); this.redraw(); }
    });
  }

  // ---- Edit commands (shell owns shortcuts + long-press menu) ----
  commands(): EditCommands {
    return {
      undo: () => this.undo(),
      redo: () => this.redo(),
      canUndo: () => this.undoStack.length > 0,
      canRedo: () => this.redoStack.length > 0,
      hasSelection: () => !!this.selectedClip(),
      canPaste: () => !!getAppClipboard<FpClip>('floorplan'),
      delete: () => this.deleteSelected(),
      copy: () => { this.copySelected(); },
      cut: () => { if (this.copySelected()) this.deleteSelected(); },
      paste: () => {
        const clip = getAppClipboard<FpClip>('floorplan');
        if (!clip) return;
        const placed = this.insertClip(clip);
        setAppClipboard('floorplan', placed); // repeated pastes cascade
      },
      duplicate: () => { const c = this.selectedClip(); if (c) this.insertClip(c); },
    };
  }

  private selectedClip(): FpClip | null {
    const sel = this.selection;
    if (!sel) return null;
    if (sel.kind === 'furniture') {
      const f = this.plan.furniture.find((x) => x.id === sel.id);
      return f ? { kind: 'furniture', item: { ...f } } : null;
    }
    const w = this.plan.walls.find((x) => x.id === sel.id);
    return w ? { kind: 'wall', item: { ...w } } : null;
  }

  private copySelected(): boolean {
    const c = this.selectedClip();
    if (c) setAppClipboard('floorplan', c);
    return !!c;
  }

  /** Insert a copy offset by one grid step; selects it and returns the inserted clip. */
  private insertClip(clip: FpClip): FpClip {
    const off = this.plan.settings.gridSize || 0.5;
    this.snapshot();
    let placed: FpClip;
    if (clip.kind === 'furniture') {
      const f = { ...clip.item, id: newId('f'), x: clip.item.x + off, y: clip.item.y + off };
      this.plan.furniture.push(f);
      this.selection = { kind: 'furniture', id: f.id };
      placed = { kind: 'furniture', item: { ...f } };
    } else {
      const w = { ...clip.item, id: newId('w'), x1: clip.item.x1 + off, y1: clip.item.y1 + off, x2: clip.item.x2 + off, y2: clip.item.y2 + off };
      this.plan.walls.push(w);
      this.selection = { kind: 'wall', id: w.id };
      placed = { kind: 'wall', item: { ...w } };
    }
    this.tool = 'select';
    this.wallStart = null;
    this.syncToolButtons();
    this.emitChange();
    this.redraw();
    return placed;
  }

  private toolBtn(tool: Tool, ic: string, label: string): HTMLButtonElement {
    const b = iconBtn(ic, label, () => {
      this.tool = tool;
      this.wallStart = null;
      this.selection = null;
      this.syncToolButtons();
      this.redraw();
    }, 'fp-tool', label);
    b.dataset.tool = tool;
    b.setAttribute('aria-pressed', String(this.tool === tool));
    return b;
  }

  // ---- Palette ----
  private buildPalette(): HTMLElement {
    const pal = el('div', 'fp-palette');
    this.paletteEl = pal;
    const head = el('div', 'fp-sheet-head');
    head.append(el('div', 'fp-palette-title', 'Furniture'));
    const close = iconBtn('x', 'Close', () => this.setPaletteOpen(false), 'fp-sheet-close');
    head.append(close);
    pal.append(el('div', 'fp-grab'), head);

    const chips = el('div', 'fp-chips');
    for (const cat of CATALOG_CATEGORIES) {
      const c = el('button', 'fp-chip', cat);
      c.dataset.cat = cat;
      c.addEventListener('click', () => { this.activeCat = cat; this.syncChips(); });
      chips.append(c);
    }
    pal.append(chips);

    const scroll = el('div', 'fp-pal-scroll');
    for (const cat of CATALOG_CATEGORIES) {
      const sec = el('div', 'fp-cat-sec');
      sec.dataset.cat = cat;
      sec.append(el('div', 'fp-cat', cat));
      const grid = el('div', 'fp-cat-grid');
      for (const item of CATALOG.filter((c) => c.category === cat)) {
        const b = el('button', 'fp-item');
        b.title = `${item.label} — ${item.w}×${item.d} m`;
        const ic = el('span', 'fp-item-icon');
        ic.innerHTML = glyphSvg(item.icon, 26);
        b.append(ic, el('span', 'fp-item-label', item.label));
        b.addEventListener('click', () => { this.placeFurniture(item.id); this.setPaletteOpen(false); });
        grid.append(b);
      }
      sec.append(grid);
      scroll.append(sec);
    }
    pal.append(scroll);
    this.syncChips();
    return pal;
  }

  private syncChips() {
    for (const c of this.paletteEl.querySelectorAll<HTMLElement>('.fp-chip')) {
      c.setAttribute('aria-pressed', String(c.dataset.cat === this.activeCat));
    }
    for (const s of this.paletteEl.querySelectorAll<HTMLElement>('.fp-cat-sec')) {
      s.classList.toggle('fp-off', s.dataset.cat !== this.activeCat);
    }
  }

  private setPaletteOpen(open: boolean) {
    this.root.classList.toggle('fp-pal-open', open);
    if (open && this.mq.matches) { this.selection = null; this.redraw(); this.renderInspector(); }
  }

  // ---- Canvas ----
  private buildCanvas(): HTMLElement {
    const wrap = el('div', 'fp-canvas-wrap');
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'fp-svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    this.svg = svg;

    this.world = document.createElementNS(SVGNS, 'g') as SVGGElement;
    svg.append(this.world);
    wrap.append(svg);

    // Pointer handling on the SVG surface (mouse, touch, pen; multi-touch aware).
    svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this.onPointerUp(e, false));
    svg.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Status pills.
    const pills = el('div', 'fp-pills');
    this.areaEl = el('span', 'fp-pill fp-area', '');
    this.hintEl = el('span', 'fp-pill fp-hintpill', '');
    pills.append(this.areaEl, this.hintEl);
    wrap.append(pills);

    this.doneBtn = iconBtn('check', 'Finish wall', () => { this.wallStart = null; this.redraw(); }, 'fp-done', 'Finish wall');
    wrap.append(this.doneBtn);

    // Zoom controls (desktop; touch uses pinch).
    const zoom = el('div', 'fp-zoom');
    zoom.append(
      iconBtn('plus', 'Zoom in', () => this.zoomBy(1.2)),
      iconBtn('minus', 'Zoom out', () => this.zoomBy(1 / 1.2)),
      iconBtn('maximize', 'Fit', () => this.fit()),
    );
    wrap.append(zoom);
    return wrap;
  }

  // ---- Inspector ----
  private inspectorEl!: HTMLElement;
  private buildInspector(): HTMLElement {
    this.inspectorEl = el('div', 'fp-inspector');
    this.renderInspector();
    return this.inspectorEl;
  }

  private renderInspector() {
    const box = this.inspectorEl;
    box.replaceChildren();
    const sel = this.selection;
    box.classList.toggle('fp-open', !!sel);
    const head = (title: string) => {
      const h = el('div', 'fp-sheet-head');
      h.append(el('div', 'fp-inspector-title', title));
      const c = iconBtn('x', 'Close', () => { this.selection = null; this.redraw(); this.renderInspector(); }, 'fp-sheet-close');
      h.append(c);
      box.append(el('div', 'fp-grab'), h);
    };
    const fields = el('div', 'fp-fields');
    if (!sel) {
      box.append(el('div', 'fp-inspector-title', 'Properties'));
      box.append(el('p', 'fp-hint',
        this.tool === 'wall'
          ? 'Click to drop wall points. Esc or Finish to stop.'
          : 'Pick a tool, draw walls, then add furniture. Click an item to edit it.'));
      box.append(el('div', 'fp-inspector-sub', 'Wall defaults'));
      fields.append(
        this.numField('Height (m)', this.plan.settings.wallHeight, 1, 6, 0.1, (v) => { this.snapshot(); this.plan.settings.wallHeight = v; this.emitChange(); }),
        this.numField('Thickness (m)', this.plan.settings.wallThickness, 0.05, 0.5, 0.01, (v) => { this.snapshot(); this.plan.settings.wallThickness = v; this.emitChange(); }),
        this.numField('Grid (m)', this.plan.settings.gridSize, 0.1, 2, 0.1, (v) => { this.snapshot(); this.plan.settings.gridSize = v; this.emitChange(); this.redraw(); }),
      );
      box.append(fields);
      return;
    }
    if (sel.kind === 'furniture') {
      const f = this.plan.furniture.find((x) => x.id === sel.id);
      if (!f) { box.classList.remove('fp-open'); return; }
      const item = catalogItem(f.catalogId);
      head(item?.label ?? 'Furniture');
      fields.append(
        this.numField('Width (m)', f.w, 0.1, 10, 0.05, (v) => { this.snapshot(); f.w = v; this.emitChange(); this.redraw(); }),
        this.numField('Depth (m)', f.d, 0.1, 10, 0.05, (v) => { this.snapshot(); f.d = v; this.emitChange(); this.redraw(); }),
        this.numField('Height (m)', f.h, 0.05, 4, 0.05, (v) => { this.snapshot(); f.h = v; this.emitChange(); }),
        this.numField('Rotation (°)', f.rotation, 0, 360, 15, (v) => { this.snapshot(); f.rotation = v % 360; this.emitChange(); this.redraw(); }),
        this.colorField('Colour', f.color, (v) => { this.snapshot(); f.color = v; this.emitChange(); this.redraw(); }),
      );
      box.append(fields, this.actionRow(true));
    } else {
      const w = this.plan.walls.find((x) => x.id === sel.id);
      if (!w) { box.classList.remove('fp-open'); return; }
      head('Wall');
      box.append(el('div', 'fp-readout', `Length: ${wallLength(w).toFixed(2)} m`));
      fields.append(
        this.numField('Thickness (m)', w.thickness, 0.05, 0.5, 0.01, (v) => { this.snapshot(); w.thickness = v; this.emitChange(); this.redraw(); }),
        this.numField('Height (m)', w.height, 1, 6, 0.1, (v) => { this.snapshot(); w.height = v; this.emitChange(); }),
      );
      box.append(fields, this.actionRow(false));
    }
  }

  private actionRow(canRotate: boolean): HTMLElement {
    const row = el('div', 'fp-actions');
    if (canRotate) {
      row.append(iconBtn('rotateCw', 'Rotate 90°', () => {
        const f = this.selection && this.plan.furniture.find((x) => x.id === this.selection!.id);
        if (!f) return;
        this.snapshot(); f.rotation = (f.rotation + 90) % 360; this.emitChange(); this.redraw();
      }, '', 'Rotate'));
    }
    row.append(iconBtn('copy', 'Duplicate', () => { const c = this.selectedClip(); if (c) this.insertClip(c); }, '', 'Duplicate'));
    row.append(iconBtn('trash', 'Delete', () => this.deleteSelected(), 'fp-delete', 'Delete'));
    return row;
  }

  // ---- Placement / editing ----
  private placeFurniture(catalogId: string) {
    const item = catalogItem(catalogId);
    if (!item) return;
    // Drop at the current viewport centre, snapped to the grid.
    const c = this.screenToWorld(this.svg.clientWidth / 2, this.svg.clientHeight / 2);
    const f: FurniturePlacement = {
      id: newId('f'), catalogId, x: this.snap(c.x), y: this.snap(c.y),
      rotation: 0, w: item.w, d: item.d, h: item.h, color: item.color,
    };
    this.snapshot();
    this.plan.furniture.push(f);
    this.tool = 'select';
    this.selection = { kind: 'furniture', id: f.id };
    this.emitChange();
    this.syncToolButtons();
    this.redraw();
  }

  private deleteSelected() {
    const sel = this.selection;
    if (!sel) return;
    this.snapshot();
    if (sel.kind === 'furniture') this.plan.furniture = this.plan.furniture.filter((f) => f.id !== sel.id);
    else this.plan.walls = this.plan.walls.filter((w) => w.id !== sel.id);
    this.selection = null;
    this.emitChange();
    this.redraw();
  }

  // ---- Pointer interaction (mouse + touch + pen) ----
  private ptrs = new Map<number, { x: number; y: number }>();
  private dragging: { id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null = null;
  private panning: { px: number; py: number; ox: number; oy: number; moved: boolean } | null = null;
  private pinch: { d: number; scale: number; wx: number; wy: number } | null = null;
  private tapWall: { x: number; y: number } | null = null; // world point to drop on tap-up
  private pinched = false;

  private local(e: { clientX: number; clientY: number }) {
    const r = this.svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private pinchGeom() {
    const [a, b] = [...this.ptrs.values()];
    return { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, mx: (a!.x + b!.x) / 2, my: (a!.y + b!.y) / 2 };
  }

  private onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.root.focus({ preventScroll: true });
    const p = this.local(e);
    this.ptrs.set(e.pointerId, p);
    try { this.svg.setPointerCapture(e.pointerId); } catch { /* ignore */ }

    if (this.ptrs.size === 2) {
      // Two fingers: pinch-zoom + two-finger pan; abort any single-finger gesture.
      if (this.dragging?.moved) this.emitChange();
      this.dragging = null; this.panning = null; this.tapWall = null;
      this.pinched = true;
      const g = this.pinchGeom();
      const w = this.screenToWorld(g.mx, g.my);
      this.pinch = { d: g.d, scale: this.pxPerM, wx: w.x, wy: w.y };
      return;
    }
    if (this.ptrs.size > 2) return;
    this.pinched = false;

    const target = e.target as Element;
    const id = target.getAttribute('data-fid');
    const wid = target.getAttribute('data-wid');
    const w = this.screenToWorld(p.x, p.y);

    if (this.tool === 'wall') {
      // Tap drops a point; dragging pans the view.
      this.tapWall = { x: this.snap(w.x), y: this.snap(w.y) };
      this.panning = { px: e.clientX, py: e.clientY, ox: this.ox, oy: this.oy, moved: false };
      return;
    }

    if (id) {
      const f = this.plan.furniture.find((x) => x.id === id);
      if (f) {
        this.selection = { kind: 'furniture', id };
        this.dragging = { id, dx: w.x - f.x, dy: w.y - f.y, sx: e.clientX, sy: e.clientY, moved: false };
        this.renderInspector();
        this.redraw();
        return;
      }
    }
    if (wid) {
      this.selection = { kind: 'wall', id: wid };
      this.renderInspector();
      this.redraw();
      return;
    }
    // Empty space: deselect + start panning.
    this.selection = null;
    this.panning = { px: e.clientX, py: e.clientY, ox: this.ox, oy: this.oy, moved: false };
    this.renderInspector();
    this.redraw();
  }

  private onPointerMove(e: PointerEvent) {
    const p = this.local(e);
    if (this.ptrs.has(e.pointerId)) this.ptrs.set(e.pointerId, p);
    else {
      // Hover (mouse): live rubber-band while drawing walls.
      if (this.tool === 'wall' && this.wallStart && e.pointerType === 'mouse') { this.redraw(); this.drawRubberBand(p.x, p.y); }
      return;
    }

    if (this.pinch && this.ptrs.size >= 2) {
      const g = this.pinchGeom();
      this.pxPerM = Math.max(8, Math.min(300, this.pinch.scale * (g.d / this.pinch.d)));
      this.ox = g.mx - this.pinch.wx * this.pxPerM;
      this.oy = g.my - this.pinch.wy * this.pxPerM;
      this.redraw();
      return;
    }
    if (this.dragging) {
      const d = this.dragging;
      if (!d.moved) {
        if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return; // touch slop
        d.moved = true;
        this.snapshot();
      }
      const f = this.plan.furniture.find((x) => x.id === d.id);
      if (f) {
        const w = this.screenToWorld(p.x, p.y);
        f.x = this.snap(w.x - d.dx);
        f.y = this.snap(w.y - d.dy);
        this.redraw();
      }
      return;
    }
    if (this.panning) {
      const dx = e.clientX - this.panning.px, dy = e.clientY - this.panning.py;
      if (!this.panning.moved && Math.hypot(dx, dy) < 6) return;
      this.panning.moved = true;
      this.tapWall = null;
      this.ox = this.panning.ox + dx;
      this.oy = this.panning.oy + dy;
      this.applyTransform();
      this.drawGridOnly();
    }
  }

  private onPointerUp(e: PointerEvent, cancelled: boolean) {
    if (!this.ptrs.delete(e.pointerId)) return;
    try { this.svg.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (this.pinch && this.ptrs.size < 2) {
      this.pinch = null;
      this.dragging = null; this.panning = null; this.tapWall = null;
    }
    if (this.ptrs.size > 0) return;
    if (this.dragging) {
      if (this.dragging.moved) this.emitChange();
      this.dragging = null;
    }
    if (this.tool === 'wall' && this.tapWall && !cancelled && !this.pinched) {
      const pt = this.tapWall;
      if (!this.wallStart) this.wallStart = pt;
      else if (pt.x !== this.wallStart.x || pt.y !== this.wallStart.y) {
        this.snapshot();
        this.plan.walls.push({
          id: newId('w'), x1: this.wallStart.x, y1: this.wallStart.y, x2: pt.x, y2: pt.y,
          thickness: this.plan.settings.wallThickness, height: this.plan.settings.wallHeight,
        });
        this.wallStart = pt; // chain the next segment
        this.emitChange();
      }
      this.redraw();
    }
    this.tapWall = null;
    this.panning = null;
    this.pinched = false;
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.zoomAt(p.x, p.y, factor);
  }

  // ---- Viewport helpers ----
  private screenToWorld(px: number, py: number): { x: number; y: number } {
    return { x: (px - this.ox) / this.pxPerM, y: (py - this.oy) / this.pxPerM };
  }
  private snap(v: number): number {
    const g = this.plan.settings.gridSize || 0.5;
    return Math.round(v / g) * g;
  }
  private zoomBy(f: number) { this.zoomAt(this.svg.clientWidth / 2, this.svg.clientHeight / 2, f); }
  private zoomAt(px: number, py: number, f: number) {
    const before = this.screenToWorld(px, py);
    this.pxPerM = Math.max(8, Math.min(300, this.pxPerM * f));
    this.ox = px - before.x * this.pxPerM;
    this.oy = py - before.y * this.pxPerM;
    this.redraw();
  }
  fit() {
    const b = planBounds(this.plan);
    const w = this.svg.clientWidth || 800, h = this.svg.clientHeight || 600;
    const sx = w / (b.maxX - b.minX), sy = h / (b.maxY - b.minY);
    this.pxPerM = Math.max(8, Math.min(300, Math.min(sx, sy) * 0.9));
    this.ox = (w - (b.minX + b.maxX) * this.pxPerM) / 2;
    this.oy = (h - (b.minY + b.maxY) * this.pxPerM) / 2;
    this.redraw();
  }
  private applyTransform() {
    this.world.setAttribute('transform', `translate(${this.ox} ${this.oy}) scale(${this.pxPerM})`);
  }

  // ---- Rendering ----
  /** Current plan as JSON (for AI context). */
  getPlanJson(): string { return serializeFloorPlan(this.plan); }

  /** Replace the whole plan from AI-generated JSON; keeps undo + redraws. */
  applyAiPlan(json: string): string {
    const next = parseFloorPlan(json);
    this.snapshot();
    this.plan = next;
    this.emitChange();
    this.redraw();
    return `plan updated (${next.walls.length} walls, ${next.furniture.length} items)`;
  }

  private redraw() {
    this.applyTransform();
    this.world.replaceChildren();
    this.drawGrid();
    this.drawWalls();
    this.drawFurniture();
    this.updateArea();
    this.updateChrome();
  }

  /** Grid is viewport-sized; refresh just it while panning (cheap). */
  private gridG: SVGGElement | null = null;
  private drawGridOnly() {
    this.gridG?.remove();
    this.drawGrid();
    if (this.gridG) this.world.prepend(this.gridG);
  }

  private drawGrid() {
    const g = this.plan.settings.gridSize || 0.5;
    const b = this.screenToWorld(0, 0);
    const b2 = this.screenToWorld(this.svg.clientWidth || 800, this.svg.clientHeight || 600);
    const x0 = Math.floor(b.x / g) * g, x1 = Math.ceil(b2.x / g) * g;
    const y0 = Math.floor(b.y / g) * g, y1 = Math.ceil(b2.y / g) * g;
    const grid = document.createElementNS(SVGNS, 'g') as SVGGElement;
    grid.setAttribute('class', 'fp-grid');
    // Skip drawing when lines would be denser than ~6px (zoomed far out).
    const step = g * this.pxPerM >= 6 ? g : g * Math.ceil(6 / (g * this.pxPerM));
    const sw = 1 / this.pxPerM;
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) grid.append(line(x, y0, x, y1, sw));
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) grid.append(line(x0, y, x1, y, sw));
    this.gridG = grid;
    this.world.append(grid);
  }

  private drawWalls() {
    const sel = this.selection;
    for (const w of this.plan.walls) {
      const seg = line(w.x1, w.y1, w.x2, w.y2, w.thickness);
      seg.setAttribute('stroke-linecap', 'round');
      seg.classList.add('fp-wall');
      if (sel?.kind === 'wall' && sel.id === w.id) seg.classList.add('fp-selected');
      this.world.append(seg);
      // Wider invisible hit target so thin walls are tappable by finger.
      const hit = line(w.x1, w.y1, w.x2, w.y2, Math.max(w.thickness, 20 / this.pxPerM));
      hit.setAttribute('stroke-linecap', 'round');
      hit.setAttribute('data-wid', w.id);
      hit.classList.add('fp-hit');
      this.world.append(hit);
      // Length label at the midpoint.
      const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
      this.world.append(text(mx, my - w.thickness, `${wallLength(w).toFixed(2)} m`, 11 / this.pxPerM));
    }
    if (this.wallStart) {
      this.world.append(dot(this.wallStart.x, this.wallStart.y, 6 / this.pxPerM));
    }
  }

  private drawRubberBand(px: number, py: number) {
    if (!this.wallStart) return;
    const w = this.screenToWorld(px, py);
    const p = { x: this.snap(w.x), y: this.snap(w.y) };
    const ln = line(this.wallStart.x, this.wallStart.y, p.x, p.y, this.plan.settings.wallThickness);
    ln.setAttribute('stroke-linecap', 'round');
    ln.classList.add('fp-rubber');
    this.world.append(ln);
  }

  private drawFurniture() {
    const sel = this.selection;
    for (const f of this.plan.furniture) {
      const isSel = sel?.kind === 'furniture' && sel.id === f.id;
      const g = document.createElementNS(SVGNS, 'g');
      g.setAttribute('transform', `translate(${f.x} ${f.y}) rotate(${f.rotation})`);
      const rect = document.createElementNS(SVGNS, 'rect');
      rect.setAttribute('x', String(-f.w / 2));
      rect.setAttribute('y', String(-f.d / 2));
      rect.setAttribute('width', String(f.w));
      rect.setAttribute('height', String(f.d));
      rect.setAttribute('rx', String(0.04));
      rect.setAttribute('fill', f.color);
      rect.setAttribute('fill-opacity', '0.85');
      rect.setAttribute('stroke-width', String((isSel ? 3 : 1.2) / this.pxPerM));
      rect.setAttribute('data-fid', f.id);
      rect.classList.add('fp-furniture');
      if (isSel) rect.classList.add('fp-selected');
      g.append(rect);
      // Glyph in the centre (counter-rotated to stay upright).
      const item = catalogItem(f.catalogId);
      const size = Math.min(Math.min(f.w, f.d) * 0.7, Math.max(f.w, f.d) * 0.6);
      if (item && size * this.pxPerM >= 12) {
        const gl = document.createElementNS(SVGNS, 'g');
        gl.setAttribute('class', 'fp-glyph');
        gl.setAttribute('transform', `rotate(${-f.rotation}) scale(${size / 24}) translate(-12 -12)`);
        gl.setAttribute('stroke-width', String(1.7));
        gl.innerHTML = glyphPaths(item.icon);
        g.append(gl);
      }
      this.world.append(g);
    }
  }

  /** Enable/disable history buttons, finish-wall chip, hint pill. */
  private updateChrome() {
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.fp-undo')) b.disabled = this.undoStack.length === 0;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.fp-redo')) b.disabled = this.redoStack.length === 0;
    this.doneBtn.hidden = !(this.tool === 'wall' && this.wallStart);
    this.hintEl.textContent = this.tool === 'wall'
      ? (this.wallStart ? 'Tap next corner, then Finish' : 'Tap to place the first corner')
      : '';
    this.hintEl.hidden = !this.hintEl.textContent;
  }

  private updateArea() {
    const area = enclosedArea(this.plan.walls);
    this.areaEl.textContent = area > 0
      ? `Area ≈ ${area.toFixed(1)} m²  ·  ${this.plan.walls.length} walls`
      : `${this.plan.walls.length} walls · ${this.plan.furniture.length} items`;
  }

  private syncToolButtons() {
    for (const t of this.root.querySelectorAll<HTMLElement>('.fp-tool')) {
      t.setAttribute('aria-pressed', String(t.dataset.tool === this.tool));
    }
    this.renderInspector();
  }

  // ---- 3D ----
  private set3DButtons(on: boolean) {
    for (const b of this.root.querySelectorAll<HTMLElement>('.fp-3d-btn')) {
      b.setAttribute('aria-pressed', String(on));
      b.title = on ? 'Back to 2D' : '3D view';
    }
  }

  private async toggle3D() {
    if (this.view3d || this.threeHost) {
      this.view3d?.dispose();
      this.view3d = null;
      this.threeHost?.remove();
      this.threeHost = null;
      this.set3DButtons(false);
      return;
    }
    const host = el('div', 'fp-3d-overlay');
    const stage = el('div', 'fp-3d-stage');
    stage.append(el('div', 'fp-3d-loading', 'Loading 3D…'));
    const close = iconBtn('x', 'Back to 2D', () => this.toggle3D(), 'fp-3d-close', 'Back to 2D');
    host.append(stage, close, el('div', 'fp-3d-tip', 'Drag to orbit · pinch to zoom · two fingers to pan'));
    this.root.append(host);
    this.threeHost = host;
    this.set3DButtons(true);
    try {
      // Give the overlay a layout pass so clientWidth/Height are non-zero.
      await new Promise((r) => requestAnimationFrame(r));
      if (this.threeHost !== host) return; // closed while loading
      stage.replaceChildren();
      const v = await mount3D(stage, this.plan);
      if (this.threeHost !== host) { v.dispose(); return; }
      this.view3d = v;
    } catch (err) {
      stage.replaceChildren(el('div', 'fp-3d-loading', `3D failed to load: ${String(err)}`));
    }
  }

  // ---- History / change ----
  private snapshot() {
    this.undoStack.push(serializeFloorPlan(this.plan));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  private undo() {
    const prev = this.undoStack.pop();
    if (!prev) return;
    this.redoStack.push(serializeFloorPlan(this.plan));
    this.plan = safeParse(prev);
    this.selection = null;
    this.emitChange();
    this.renderInspector();
    this.redraw();
  }
  private redo() {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(serializeFloorPlan(this.plan));
    this.plan = safeParse(next);
    this.selection = null;
    this.emitChange();
    this.renderInspector();
    this.redraw();
  }
  private emitChange() { this.renderInspector(); this.onChange?.(); }
}

function safeParse(text: string): FloorPlan {
  try { return parseFloorPlan(text); } catch { return createFloorPlan(); }
}

// ---- Tiny DOM/SVG helpers ----
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, txt?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  n.className = cls;
  if (txt !== undefined) n.textContent = txt;
  return n;
}
function iconBtn(ic: string, title: string, onClick: () => void, cls = '', label?: string): HTMLButtonElement {
  const b = el('button', ('fp-btn ' + cls).trim());
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = icon(ic, 20) + (label ? `<span class="fp-btn-label">${label}</span>` : '');
  b.addEventListener('click', onClick);
  return b;
}
function line(x1: number, y1: number, x2: number, y2: number, sw: number): SVGLineElement {
  const l = document.createElementNS(SVGNS, 'line');
  l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
  l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
  l.setAttribute('stroke-width', String(sw));
  return l;
}
function text(x: number, y: number, s: string, size: number): SVGTextElement {
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', String(x)); t.setAttribute('y', String(y));
  t.setAttribute('font-size', String(size));
  t.setAttribute('class', 'fp-label');
  t.textContent = s;
  return t;
}
function dot(x: number, y: number, r: number): SVGCircleElement {
  const c = document.createElementNS(SVGNS, 'circle');
  c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y));
  c.setAttribute('r', String(r)); c.setAttribute('class', 'fp-dot');
  return c;
}

// Augment the class with the number/color field builders (kept here to keep the
// class body focused on behaviour).
export interface FloorPlanEditor {
  numField(label: string, value: number, min: number, max: number, step: number, onChange: (v: number) => void): HTMLElement;
  colorField(label: string, value: string, onChange: (v: string) => void): HTMLElement;
}
FloorPlanEditor.prototype.numField = function (label, value, min, max, step, onChange) {
  const f = el('label', 'fp-field');
  f.append(el('span', 'fp-field-label', label));
  const i = document.createElement('input');
  i.type = 'number'; i.className = 'fp-num';
  i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(value);
  i.addEventListener('change', () => {
    const v = Math.max(min, Math.min(max, Number(i.value) || min));
    i.value = String(v);
    onChange(v);
  });
  f.append(i);
  return f;
};
FloorPlanEditor.prototype.colorField = function (label, value, onChange) {
  const f = el('label', 'fp-field');
  f.append(el('span', 'fp-field-label', label));
  const i = document.createElement('input');
  i.type = 'color'; i.className = 'fp-color'; i.value = value;
  i.addEventListener('input', () => onChange(i.value));
  f.append(i);
  return f;
};
