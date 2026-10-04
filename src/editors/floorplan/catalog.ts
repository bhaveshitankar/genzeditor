// Furniture & fixture catalog for the interior-design editor.
//
// Each item has real-world default dimensions in metres (width × depth ×
// height) plus a colour used for both the 2D footprint and the 3D block, and
// an emoji icon for the palette. Placing an item copies these defaults into a
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
  { id: 'sofa', label: 'Sofa', icon: '🛋️', category: 'Living', w: 2.0, d: 0.9, h: 0.8, color: '#6b7fd7' },
  { id: 'armchair', label: 'Armchair', icon: '💺', category: 'Living', w: 0.9, d: 0.9, h: 0.8, color: '#7e8cd9' },
  { id: 'coffee-table', label: 'Coffee table', icon: '🟫', category: 'Living', w: 1.1, d: 0.6, h: 0.45, color: '#b08968' },
  { id: 'tv-unit', label: 'TV unit', icon: '📺', category: 'Living', w: 1.8, d: 0.4, h: 0.5, color: '#4b5563' },
  { id: 'rug', label: 'Rug', icon: '🟪', category: 'Living', w: 2.4, d: 1.6, h: 0.02, color: '#c084fc' },
  { id: 'plant', label: 'Plant', icon: '🪴', category: 'Living', w: 0.5, d: 0.5, h: 1.2, color: '#4caf50' },
  // Bedroom
  { id: 'bed-double', label: 'Double bed', icon: '🛏️', category: 'Bedroom', w: 1.6, d: 2.0, h: 0.5, color: '#e6a4b4' },
  { id: 'bed-single', label: 'Single bed', icon: '🛏️', category: 'Bedroom', w: 0.9, d: 2.0, h: 0.5, color: '#eab8c4' },
  { id: 'wardrobe', label: 'Wardrobe', icon: '🚪', category: 'Bedroom', w: 1.5, d: 0.6, h: 2.1, color: '#8d6e63' },
  { id: 'nightstand', label: 'Nightstand', icon: '🗄️', category: 'Bedroom', w: 0.45, d: 0.4, h: 0.5, color: '#a1887f' },
  { id: 'dresser', label: 'Dresser', icon: '🗄️', category: 'Bedroom', w: 1.2, d: 0.5, h: 0.8, color: '#9c7a68' },
  // Kitchen
  { id: 'counter', label: 'Counter', icon: '🍽️', category: 'Kitchen', w: 2.0, d: 0.6, h: 0.9, color: '#cbd5e1' },
  { id: 'fridge', label: 'Fridge', icon: '🧊', category: 'Kitchen', w: 0.7, d: 0.7, h: 1.8, color: '#e2e8f0' },
  { id: 'stove', label: 'Stove', icon: '🔥', category: 'Kitchen', w: 0.6, d: 0.6, h: 0.9, color: '#94a3b8' },
  { id: 'sink', label: 'Sink', icon: '🚰', category: 'Kitchen', w: 0.8, d: 0.6, h: 0.9, color: '#b0bec5' },
  { id: 'dining-table', label: 'Dining table', icon: '🍴', category: 'Kitchen', w: 1.6, d: 0.9, h: 0.75, color: '#b08968' },
  { id: 'chair', label: 'Chair', icon: '🪑', category: 'Kitchen', w: 0.45, d: 0.45, h: 0.9, color: '#8d6e63' },
  // Bath
  { id: 'toilet', label: 'Toilet', icon: '🚽', category: 'Bath', w: 0.4, d: 0.7, h: 0.8, color: '#eceff1' },
  { id: 'bathtub', label: 'Bathtub', icon: '🛁', category: 'Bath', w: 1.7, d: 0.75, h: 0.6, color: '#e0f2fe' },
  { id: 'shower', label: 'Shower', icon: '🚿', category: 'Bath', w: 0.9, d: 0.9, h: 2.0, color: '#bae6fd' },
  { id: 'basin', label: 'Basin', icon: '🧼', category: 'Bath', w: 0.6, d: 0.45, h: 0.85, color: '#eceff1' },
  // Office
  { id: 'desk', label: 'Desk', icon: '🖥️', category: 'Office', w: 1.4, d: 0.7, h: 0.75, color: '#a1887f' },
  { id: 'office-chair', label: 'Office chair', icon: '🪑', category: 'Office', w: 0.6, d: 0.6, h: 1.1, color: '#4b5563' },
  { id: 'bookshelf', label: 'Bookshelf', icon: '📚', category: 'Office', w: 1.0, d: 0.35, h: 1.9, color: '#8d6e63' },
  // Doors & Windows (thin markers placed along walls)
  { id: 'door', label: 'Door', icon: '🚪', category: 'Doors & Windows', w: 0.9, d: 0.12, h: 2.1, color: '#d4a373' },
  { id: 'window', label: 'Window', icon: '🪟', category: 'Doors & Windows', w: 1.2, d: 0.12, h: 1.2, color: '#90caf9' },
];

export function catalogItem(id: string): CatalogItem | undefined {
  return CATALOG.find((c) => c.id === id);
}
