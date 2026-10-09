// Furniture & fixture catalog for the interior-design editor.
//
// Each item has real-world default dimensions in metres (width × depth ×
// height) plus a colour used for both the 2D footprint and the 3D block, and
// a glyph key (see GLYPHS) for the palette and 2D plan. Placing an item copies these defaults into a
// FurniturePlacement, after which the user can move / rotate / resize it.

export interface CatalogItem {
  id: string;
  label: string;
  icon: string;
  category: string;
  w: number; d: number; h: number; // metres
  color: string;
}

export const CATALOG_CATEGORIES = [
  'Living', 'Bedroom', 'Kitchen', 'Bath', 'Office', 'Doors & Windows',
] as const;

export const CATALOG: CatalogItem[] = [
  // Living
  { id: 'sofa', label: 'Sofa', icon: 'sofa', category: 'Living', w: 2.0, d: 0.9, h: 0.8, color: '#6b7fd7' },
  { id: 'armchair', label: 'Armchair', icon: 'armchair', category: 'Living', w: 0.9, d: 0.9, h: 0.8, color: '#7e8cd9' },
  { id: 'coffee-table', label: 'Coffee table', icon: 'coffeeTable', category: 'Living', w: 1.1, d: 0.6, h: 0.45, color: '#b08968' },
  { id: 'tv-unit', label: 'TV unit', icon: 'tv', category: 'Living', w: 1.8, d: 0.4, h: 0.5, color: '#4b5563' },
  { id: 'rug', label: 'Rug', icon: 'rug', category: 'Living', w: 2.4, d: 1.6, h: 0.02, color: '#c084fc' },
  { id: 'plant', label: 'Plant', icon: 'plant', category: 'Living', w: 0.5, d: 0.5, h: 1.2, color: '#4caf50' },
  // Bedroom
  { id: 'bed-double', label: 'Double bed', icon: 'bed', category: 'Bedroom', w: 1.6, d: 2.0, h: 0.5, color: '#e6a4b4' },
  { id: 'bed-single', label: 'Single bed', icon: 'bed', category: 'Bedroom', w: 0.9, d: 2.0, h: 0.5, color: '#eab8c4' },
  { id: 'wardrobe', label: 'Wardrobe', icon: 'wardrobe', category: 'Bedroom', w: 1.5, d: 0.6, h: 2.1, color: '#8d6e63' },
  { id: 'nightstand', label: 'Nightstand', icon: 'drawers', category: 'Bedroom', w: 0.45, d: 0.4, h: 0.5, color: '#a1887f' },
  { id: 'dresser', label: 'Dresser', icon: 'drawers', category: 'Bedroom', w: 1.2, d: 0.5, h: 0.8, color: '#9c7a68' },
  // Kitchen
  { id: 'counter', label: 'Counter', icon: 'counter', category: 'Kitchen', w: 2.0, d: 0.6, h: 0.9, color: '#cbd5e1' },
  { id: 'fridge', label: 'Fridge', icon: 'fridge', category: 'Kitchen', w: 0.7, d: 0.7, h: 1.8, color: '#e2e8f0' },
  { id: 'stove', label: 'Stove', icon: 'stove', category: 'Kitchen', w: 0.6, d: 0.6, h: 0.9, color: '#94a3b8' },
  { id: 'sink', label: 'Sink', icon: 'sink', category: 'Kitchen', w: 0.8, d: 0.6, h: 0.9, color: '#b0bec5' },
  { id: 'dining-table', label: 'Dining table', icon: 'diningTable', category: 'Kitchen', w: 1.6, d: 0.9, h: 0.75, color: '#b08968' },
  { id: 'chair', label: 'Chair', icon: 'chair', category: 'Kitchen', w: 0.45, d: 0.45, h: 0.9, color: '#8d6e63' },
  // Bath
  { id: 'toilet', label: 'Toilet', icon: 'toilet', category: 'Bath', w: 0.4, d: 0.7, h: 0.8, color: '#eceff1' },
  { id: 'bathtub', label: 'Bathtub', icon: 'bath', category: 'Bath', w: 1.7, d: 0.75, h: 0.6, color: '#e0f2fe' },
  { id: 'shower', label: 'Shower', icon: 'shower', category: 'Bath', w: 0.9, d: 0.9, h: 2.0, color: '#bae6fd' },
  { id: 'basin', label: 'Basin', icon: 'basin', category: 'Bath', w: 0.6, d: 0.45, h: 0.85, color: '#eceff1' },
  // Office
  { id: 'desk', label: 'Desk', icon: 'desk', category: 'Office', w: 1.4, d: 0.7, h: 0.75, color: '#a1887f' },
  { id: 'office-chair', label: 'Office chair', icon: 'officeChair', category: 'Office', w: 0.6, d: 0.6, h: 1.1, color: '#4b5563' },
  { id: 'bookshelf', label: 'Bookshelf', icon: 'bookshelf', category: 'Office', w: 1.0, d: 0.35, h: 1.9, color: '#8d6e63' },
  // Doors & Windows (thin markers placed along walls)
  { id: 'door', label: 'Door', icon: 'door', category: 'Doors & Windows', w: 0.9, d: 0.12, h: 2.1, color: '#d4a373' },
  { id: 'window', label: 'Window', icon: 'window', category: 'Doors & Windows', w: 1.2, d: 0.12, h: 1.2, color: '#90caf9' },
];

export function catalogItem(id: string): CatalogItem | undefined {
  return CATALOG.find((c) => c.id === id);
}

// Line glyphs on a 24px grid (Lucide-style, currentColor stroke).
const GLYPHS: Record<string, string> = {
  sofa: '<path d="M4 11V8a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v3"/><path d="M2 13a2 2 0 0 1 4 0v1h12v-1a2 2 0 0 1 4 0v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M5 18v2"/><path d="M19 18v2"/>',
  armchair: '<path d="M5 11V8a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3"/><path d="M3 13a2 2 0 0 1 4 0v1h10v-1a2 2 0 0 1 4 0v4H3z"/><path d="M6 17v3"/><path d="M18 17v3"/>',
  coffeeTable: '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M6 12v6"/><path d="M18 12v6"/>',
  tv: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/>',
  rug: '<rect x="3" y="6" width="18" height="12" rx="1"/><rect x="6" y="9" width="12" height="6" rx="1"/>',
  plant: '<path d="M12 21v-9"/><path d="M12 12c0-4 3-7 7-7 0 4-3 7-7 7z"/><path d="M12 15c0-3-2-5-6-5 0 3 2 5 6 5z"/><path d="M8 21h8"/>',
  bed: '<path d="M3 19V6"/><path d="M3 15h18v4"/><path d="M21 15v-2a3 3 0 0 0-3-3h-7v5"/><circle cx="7" cy="12" r="1.8"/>',
  wardrobe: '<rect x="4" y="3" width="16" height="18" rx="1.5"/><path d="M12 3v18"/><path d="M9.5 12v2"/><path d="M14.5 12v2"/>',
  drawers: '<rect x="4" y="4" width="16" height="16" rx="1.5"/><path d="M4 12h16"/><path d="M11 8h2"/><path d="M11 16h2"/>',
  counter: '<rect x="2" y="9" width="20" height="10" rx="1"/><path d="M2 13h20"/><path d="M6 6h6"/>',
  fridge: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M6 10h12"/><path d="M9 6v1"/><path d="M9 13v3"/>',
  stove: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="9" cy="8" r="1.8"/><circle cx="15" cy="8" r="1.8"/><rect x="7" y="13" width="10" height="5" rx="1"/>',
  sink: '<path d="M3 11h18v2a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5z"/><path d="M12 11V5a2 2 0 0 1 4 0"/>',
  diningTable: '<rect x="3" y="9" width="18" height="3" rx="1"/><path d="M6 12v7"/><path d="M18 12v7"/><path d="M8 5h8"/>',
  chair: '<path d="M7 3v9"/><path d="M7 12h10v9"/><path d="M7 12v9"/><path d="M7 7h8"/>',
  officeChair: '<path d="M8 3h8v7H8z"/><path d="M6 14h12"/><path d="M12 14v4"/><path d="M7 21l5-3 5 3"/>',
  toilet: '<path d="M7 3h10v6H7z"/><path d="M5 9h14a0 0 0 0 1 0 0 7 6 0 0 1-7 6 7 6 0 0 1-7-6z"/><path d="M10 15l-1 6h6l-1-6"/>',
  bath: '<path d="M3 12h18v3a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 12V6a2 2 0 0 1 4 0"/><path d="M6 19l-1 2"/><path d="M18 19l1 2"/>',
  shower: '<path d="M5 21V9a5 5 0 0 1 10 0"/><path d="M13 9h6"/><path d="M15 13v1"/><path d="M18 13v1"/><path d="M16.5 17v1"/>',
  basin: '<path d="M4 11h16a0 0 0 0 1 0 0 8 6 0 0 1-8 6 8 6 0 0 1-8-6z"/><path d="M12 11V6a2 2 0 0 1 3-1.7"/><path d="M12 17v4"/>',
  desk: '<rect x="2" y="7" width="20" height="3" rx="1"/><path d="M4 10v9"/><path d="M20 10v9"/><rect x="12" y="10" width="6" height="5" rx="1"/>',
  bookshelf: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M4 9h16"/><path d="M4 15h16"/><path d="M8 5v2"/><path d="M11 5v2"/><path d="M14 11v2"/><path d="M8 17v2"/>',
  door: '<rect x="6" y="2" width="12" height="20" rx="1"/><circle cx="15" cy="12" r="1"/>',
  window: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v18"/><path d="M4 12h16"/>',
};

/** Inline-SVG markup for a catalog glyph. */
export function glyphSvg(key: string, size = 24): string {
  const p = GLYPHS[key] ?? GLYPHS.chair!;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
}

/** Raw inner paths (for embedding in the plan SVG). */
export function glyphPaths(key: string): string { return GLYPHS[key] ?? GLYPHS.chair!; }
