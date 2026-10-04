// Semantic data model for the interior-design / floor-plan editor.
//
// Unlike the Sketch editor (Excalidraw, whose elements are "dumb" lines and
// images), every entity here carries real-world meaning and metric dimensions.
// That is what lets us render the SAME document as a scaled 2D plan AND as an
// extruded 3D scene (see view3d.ts). All coordinates/lengths are in METERS.

export interface Wall {
  id: string;
  x1: number; y1: number; // start point (metres)
  x2: number; y2: number; // end point (metres)
  thickness: number;      // metres
  height: number;         // metres
}

export interface FurniturePlacement {
  id: string;
  catalogId: string;      // key into the furniture catalog
  x: number; y: number;   // centre position (metres)
  rotation: number;       // degrees, clockwise
  w: number; d: number;   // footprint width (x) and depth (y), metres
  h: number;              // height, metres
  color: string;          // hex, drives both 2D fill and 3D material
}

export interface FloorPlan {
  version: 1;
  meta: { title: string; unit: 'm' };
  settings: {
    wallHeight: number;    // default new-wall height (m)
    wallThickness: number; // default new-wall thickness (m)
    gridSize: number;      // grid spacing (m) used for snapping + rendering
  };
  walls: Wall[];
  furniture: FurniturePlacement[];
}

export function createFloorPlan(title = 'Untitled plan'): FloorPlan {
  return {
    version: 1,
    meta: { title, unit: 'm' },
    settings: { wallHeight: 2.7, wallThickness: 0.12, gridSize: 0.5 },
    walls: [],
    furniture: [],
  };
}

export function serializeFloorPlan(plan: FloorPlan): string {
  return JSON.stringify({ type: 'genzeditor-floorplan', ...plan });
}

export function parseFloorPlan(text: string): FloorPlan {
  const raw = JSON.parse(text) as Partial<FloorPlan>;
  const base = createFloorPlan(raw.meta?.title ?? 'Untitled plan');
  return {
    ...base,
    ...raw,
    version: 1,
    meta: { title: raw.meta?.title ?? base.meta.title, unit: 'm' },
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    walls: Array.isArray(raw.walls) ? (raw.walls as Wall[]) : [],
    furniture: Array.isArray(raw.furniture) ? (raw.furniture as FurniturePlacement[]) : [],
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Length of a wall segment in metres. */
export function wallLength(w: Wall): number {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}

/**
 * Enclosed floor area (m²) estimated by the shoelace formula over the ordered
 * wall endpoints. Accurate when the walls were drawn as a single closed loop;
 * returns 0 when there are fewer than 3 walls.
 */
export function enclosedArea(walls: Wall[]): number {
  if (walls.length < 3) return 0;
  const pts = walls.map((w) => ({ x: w.x1, y: w.y1 }));
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** Bounding box over all geometry, in metres, with a margin. */
export function planBounds(plan: FloorPlan): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const extend = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const w of plan.walls) { extend(w.x1, w.y1); extend(w.x2, w.y2); }
  for (const f of plan.furniture) {
    const r = Math.max(f.w, f.d) / 2;
    extend(f.x - r, f.y - r); extend(f.x + r, f.y + r);
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 8; maxY = 6; }
  return { minX: minX - 1, minY: minY - 1, maxX: maxX + 1, maxY: maxY + 1 };
}
