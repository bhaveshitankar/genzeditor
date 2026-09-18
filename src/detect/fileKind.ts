import type { FileKind } from '../store/types';
const CODE = new Set(['ts','tsx','js','jsx','py','go','rs','java','c','cpp','h','css','html','yaml','yml','toml','sh','sql']);
export function detectKind(name: string, mime?: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
  if (ext === 'txt') return 'text';
  if (CODE.has(ext)) return 'code';
  if (['png','jpg','jpeg','gif','webp','bmp','svg'].includes(ext) || mime?.startsWith('image/')) return 'image';
  return 'binary';
}
