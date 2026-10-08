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
import { CATALOG, CATALOG_CATEGORIES, catalogItem } from './floorplan/catalog';
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
    return ed;
  }

  async export(): Promise<{ blob: Blob; contentType: string } | null> {
    return {
      blob: new Blob([serializeFloorPlan(this.plan)], { type: 'application/json' }),
      contentType: 'application/json',
    };
  }

  destroy(): void {
    this.view3d?.dispose();
    this.view3d = null;
    this.container.replaceChildren();
  }

  // ---- Build the shell ----
  private build() {
    this.root = el('div', 'fp-editor');

    // Top bar.
    const bar = el('div', 'fp-topbar');
    const tools = el('div', 'fp-tools');
    tools.append(
      this.toolBtn('select', '🖱️ Select'),
      this.toolBtn('wall', '🧱 Wall'),
    );
    bar.append(tools);

    const hist = el('div', 'fp-hist');
    const undo = iconBtn('↶', 'Undo', () => this.undo());
    const redo = iconBtn('↷', 'Redo', () => this.redo());
    hist.append(undo, redo);
    bar.append(hist);

    const right = el('div', 'fp-topright');
    this.areaEl = el('span', 'fp-area', '');
    const btn3d = el('button', 'fp-btn fp-3d-btn', '🧊 3D view');
    btn3d.addEventListener('click', () => this.toggle3D());
    right.append(this.areaEl, btn3d);
    bar.append(right);

    this.root.append(bar);

    // Body: palette | canvas | inspector.
    const body = el('div', 'fp-body');
    body.append(this.buildPalette(), this.buildCanvas(), this.buildInspector());
    this.root.append(body);

    this.container.replaceChildren(this.root);
    this.redraw();

    // Keyboard: Esc finishes wall drawing. (Delete/copy/paste/undo are routed
    // by the shell through commands().)
    this.root.tabIndex = 0;
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.wallStart = null; this.redraw(); }
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

  private toolBtn(tool: Tool, label: string): HTMLButtonElement {
    const b = el('button', 'fp-tool', label);
    b.dataset.tool = tool;
    b.setAttribute('aria-pressed', String(this.tool === tool));
    b.addEventListener('click', () => {
      this.tool = tool;
      this.wallStart = null;
      this.selection = null;
      for (const t of this.root.querySelectorAll<HTMLElement>('.fp-tool')) {
        t.setAttribute('aria-pressed', String(t.dataset.tool === tool));
      }
      this.redraw();
    });
    return b;
  }

  // ---- Palette ----
  private buildPalette(): HTMLElement {
    const pal = el('div', 'fp-palette');
    pal.append(el('div', 'fp-palette-title', 'Furniture'));
    for (const cat of CATALOG_CATEGORIES) {
      pal.append(el('div', 'fp-cat', cat));
      const grid = el('div', 'fp-cat-grid');
      for (const item of CATALOG.filter((c) => c.category === cat)) {
        const b = el('button', 'fp-item');
        b.title = `${item.label} — ${item.w}×${item.d} m`;
        b.append(el('span', 'fp-item-icon', item.icon), el('span', 'fp-item-label', item.label));
        b.addEventListener('click', () => this.placeFurniture(item.id));
        grid.append(b);
      }
      pal.append(grid);
    }
    return pal;
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

    // Pointer handling on the SVG surface.
    svg.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    svg.addEventListener('pointermove', (e) => this.onPointerMove(e));
    svg.addEventListener('pointerup', (e) => this.onPointerUp(e));
    svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });

    // Zoom controls.
    const zoom = el('div', 'fp-zoom');
    zoom.append(
      iconBtn('＋', 'Zoom in', () => this.zoomBy(1.2)),
      iconBtn('－', 'Zoom out', () => this.zoomBy(1 / 1.2)),
      iconBtn('⤢', 'Fit', () => this.fit()),
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
    if (!sel) {
      box.append(el('div', 'fp-inspector-title', 'Properties'));
      box.append(el('p', 'fp-hint',
        this.tool === 'wall'
          ? 'Click to drop wall points. Esc or double-click to finish.'
          : 'Pick a tool, draw walls, then drag furniture from the left. Click an item to edit it.'));
      // Plan-wide defaults.
      box.append(el('div', 'fp-inspector-sub', 'Wall defaults'));
      box.append(this.numField('Height (m)', this.plan.settings.wallHeight, 1, 6, 0.1, (v) => { this.snapshot(); this.plan.settings.wallHeight = v; this.emitChange(); }));
      box.append(this.numField('Thickness (m)', this.plan.settings.wallThickness, 0.05, 0.5, 0.01, (v) => { this.snapshot(); this.plan.settings.wallThickness = v; this.emitChange(); }));
      box.append(this.numField('Grid (m)', this.plan.settings.gridSize, 0.1, 2, 0.1, (v) => { this.snapshot(); this.plan.settings.gridSize = v; this.emitChange(); this.redraw(); }));
      return;
    }
    if (sel.kind === 'furniture') {
      const f = this.plan.furniture.find((x) => x.id === sel.id);
      if (!f) return;
      const item = catalogItem(f.catalogId);
      box.append(el('div', 'fp-inspector-title', item?.label ?? 'Furniture'));
      box.append(this.numField('Width (m)', f.w, 0.1, 10, 0.05, (v) => { this.snapshot(); f.w = v; this.emitChange(); this.redraw(); }));
      box.append(this.numField('Depth (m)', f.d, 0.1, 10, 0.05, (v) => { this.snapshot(); f.d = v; this.emitChange(); this.redraw(); }));
      box.append(this.numField('Height (m)', f.h, 0.05, 4, 0.05, (v) => { this.snapshot(); f.h = v; this.emitChange(); }));
      box.append(this.numField('Rotation (°)', f.rotation, 0, 360, 15, (v) => { this.snapshot(); f.rotation = v % 360; this.emitChange(); this.redraw(); }));
      box.append(this.colorField('Colour', f.color, (v) => { this.snapshot(); f.color = v; this.emitChange(); this.redraw(); }));
      box.append(this.deleteBtn());
    } else {
      const w = this.plan.walls.find((x) => x.id === sel.id);
      if (!w) return;
      box.append(el('div', 'fp-inspector-title', 'Wall'));
      box.append(el('div', 'fp-readout', `Length: ${wallLength(w).toFixed(2)} m`));
      box.append(this.numField('Thickness (m)', w.thickness, 0.05, 0.5, 0.01, (v) => { this.snapshot(); w.thickness = v; this.emitChange(); this.redraw(); }));
      box.append(this.numField('Height (m)', w.height, 1, 6, 0.1, (v) => { this.snapshot(); w.height = v; this.emitChange(); }));
      box.append(this.deleteBtn());
    }
  }

  private deleteBtn(): HTMLElement {
    const b = el('button', 'fp-btn fp-delete', '🗑 Delete');
    b.addEventListener('click', () => this.deleteSelected());
    return b;
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

  // ---- Pointer interaction ----
  private dragging: { id: string; dx: number; dy: number } | null = null;
  private panning: { px: number; py: number; ox: number; oy: number } | null = null;

  private onPointerDown(e: PointerEvent) {
    this.root.focus();
    const target = e.target as Element;
    const id = target.getAttribute('data-fid');
    const wid = target.getAttribute('data-wid');
    const w = this.screenToWorld(e.offsetX, e.offsetY);

    if (this.tool === 'wall') {
      const p = { x: this.snap(w.x), y: this.snap(w.y) };
      if (!this.wallStart) {
        this.wallStart = p;
      } else {
        this.snapshot();
        this.plan.walls.push({
          id: newId('w'), x1: this.wallStart.x, y1: this.wallStart.y, x2: p.x, y2: p.y,
          thickness: this.plan.settings.wallThickness, height: this.plan.settings.wallHeight,
        });
        this.wallStart = p; // chain the next segment
        this.emitChange();
      }
      this.redraw();
      return;
    }

    // Select tool.
    if (id) {
      const f = this.plan.furniture.find((x) => x.id === id);
      if (f) {
        this.selection = { kind: 'furniture', id };
        this.dragging = { id, dx: w.x - f.x, dy: w.y - f.y };
        this.svg.setPointerCapture(e.pointerId);
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
    this.panning = { px: e.clientX, py: e.clientY, ox: this.ox, oy: this.oy };
    this.svg.setPointerCapture(e.pointerId);
    this.renderInspector();
    this.redraw();
  }

  private onPointerMove(e: PointerEvent) {
    if (this.dragging) {
      const f = this.plan.furniture.find((x) => x.id === this.dragging!.id);
      if (f) {
        const w = this.screenToWorld(e.offsetX, e.offsetY);
        f.x = this.snap(w.x - this.dragging.dx);
        f.y = this.snap(w.y - this.dragging.dy);
        this.redraw();
      }
      return;
    }
    if (this.panning) {
      this.ox = this.panning.ox + (e.clientX - this.panning.px);
      this.oy = this.panning.oy + (e.clientY - this.panning.py);
      this.applyTransform();
      return;
    }
    if (this.tool === 'wall' && this.wallStart) {
      this.redraw(); // live rubber-band uses the pointer position
      this.drawRubberBand(e.offsetX, e.offsetY);
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (this.dragging) { this.emitChange(); this.dragging = null; }
    if (this.panning) this.panning = null;
    try { this.svg.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.zoomAt(e.offsetX, e.offsetY, factor);
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
  private fit() {
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
  }

  private drawGrid() {
    const g = this.plan.settings.gridSize || 0.5;
    const b = this.screenToWorld(0, 0);
    const b2 = this.screenToWorld(this.svg.clientWidth || 800, this.svg.clientHeight || 600);
    const x0 = Math.floor(b.x / g) * g, x1 = Math.ceil(b2.x / g) * g;
    const y0 = Math.floor(b.y / g) * g, y1 = Math.ceil(b2.y / g) * g;
    const grid = document.createElementNS(SVGNS, 'g');
    grid.setAttribute('class', 'fp-grid');
    // Stroke widths are in metre space, so divide by pxPerM to keep ~1px lines.
    const sw = 1 / this.pxPerM;
    for (let x = x0; x <= x1; x += g) grid.append(line(x, y0, x, y1, sw, '#dce3ec'));
    for (let y = y0; y <= y1; y += g) grid.append(line(x0, y, x1, y, sw, '#dce3ec'));
    this.world.append(grid);
  }

  private drawWalls() {
    const sel = this.selection;
    for (const w of this.plan.walls) {
      const seg = line(w.x1, w.y1, w.x2, w.y2, w.thickness, '#374151');
      seg.setAttribute('data-wid', w.id);
      seg.setAttribute('stroke-linecap', 'round');
      seg.classList.add('fp-wall');
      if (sel?.kind === 'wall' && sel.id === w.id) seg.classList.add('fp-selected');
      this.world.append(seg);
      // Length label at the midpoint.
      const mx = (w.x1 + w.x2) / 2, my = (w.y1 + w.y2) / 2;
      this.world.append(text(mx, my - w.thickness, `${wallLength(w).toFixed(2)} m`, 11 / this.pxPerM));
    }
    if (this.wallStart) {
      this.world.append(dot(this.wallStart.x, this.wallStart.y, 4 / this.pxPerM, '#2563eb'));
    }
  }

  private rubberLine: SVGLineElement | null = null;
  private drawRubberBand(px: number, py: number) {
    if (!this.wallStart) return;
    const w = this.screenToWorld(px, py);
    const p = { x: this.snap(w.x), y: this.snap(w.y) };
    const ln = line(this.wallStart.x, this.wallStart.y, p.x, p.y, this.plan.settings.wallThickness, '#93c5fd');
    ln.setAttribute('stroke-linecap', 'round');
    ln.setAttribute('opacity', '0.7');
    this.world.append(ln);
  }

  private drawFurniture() {
    const sel = this.selection;
    for (const f of this.plan.furniture) {
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
      rect.setAttribute('stroke', sel?.kind === 'furniture' && sel.id === f.id ? '#2563eb' : '#334155');
      rect.setAttribute('stroke-width', String((sel?.kind === 'furniture' && sel.id === f.id ? 2.5 : 1) / this.pxPerM));
      rect.setAttribute('data-fid', f.id);
      rect.classList.add('fp-furniture');
      g.append(rect);
      // Icon in the centre (counter-rotated so it stays upright-ish).
      const item = catalogItem(f.catalogId);
      if (item) {
        const t = text(0, 0, item.icon, Math.min(f.w, f.d) * 0.6);
        t.setAttribute('text-anchor', 'middle');
        t.setAttribute('dominant-baseline', 'central');
        t.setAttribute('transform', `rotate(${-f.rotation})`);
        t.setAttribute('data-fid', f.id);
        g.append(t);
      }
      this.world.append(g);
    }
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
  private async toggle3D() {
    if (this.view3d) {
      this.view3d.dispose();
      this.view3d = null;
      this.threeHost?.remove();
      this.threeHost = null;
      const b = this.root.querySelector('.fp-3d-btn');
      if (b) b.textContent = '🧊 3D view';
      return;
    }
    const host = el('div', 'fp-3d-overlay');
    host.append(el('div', 'fp-3d-loading', 'Loading 3D…'));
    this.root.append(host);
    this.threeHost = host;
    const b = this.root.querySelector('.fp-3d-btn');
    if (b) b.textContent = '✕ Close 3D';
    try {
      // Give the overlay a layout pass so clientWidth/Height are non-zero.
      await new Promise((r) => requestAnimationFrame(r));
      host.replaceChildren();
      this.view3d = await mount3D(host, this.plan);
    } catch (err) {
      host.replaceChildren(el('div', 'fp-3d-loading', `3D failed to load: ${String(err)}`));
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
function iconBtn(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'fp-btn', label);
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
function line(x1: number, y1: number, x2: number, y2: number, sw: number, stroke: string): SVGLineElement {
  const l = document.createElementNS(SVGNS, 'line');
  l.setAttribute('x1', String(x1)); l.setAttribute('y1', String(y1));
  l.setAttribute('x2', String(x2)); l.setAttribute('y2', String(y2));
  l.setAttribute('stroke', stroke); l.setAttribute('stroke-width', String(sw));
  return l;
}
function text(x: number, y: number, s: string, size: number): SVGTextElement {
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', String(x)); t.setAttribute('y', String(y));
  t.setAttribute('font-size', String(size));
  t.setAttribute('fill', '#1f2937');
  t.textContent = s;
  return t;
}
function dot(x: number, y: number, r: number, fill: string): SVGCircleElement {
  const c = document.createElementNS(SVGNS, 'circle');
  c.setAttribute('cx', String(x)); c.setAttribute('cy', String(y));
  c.setAttribute('r', String(r)); c.setAttribute('fill', fill);
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
