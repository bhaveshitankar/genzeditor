import type { FileKind } from '../store/types';
const CODE = new Set(['ts','tsx','js','jsx','py','go','rs','java','c','cpp','h','css','html','yaml','yml','toml','sh','sql']);
export function detectKind(name: string, mime?: string): FileKind {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
  if (ext === 'txt') return 'text';
  if (CODE.has(ext)) return 'code';
  // XML-family text formats (editable markup)
  if (['xml','xsd','svg','rss','atom','plist','xhtml','wsdl'].includes(ext)) return 'code';
  if (['png','jpg','jpeg','gif','webp','bmp'].includes(ext) || mime?.startsWith('image/')) return 'image';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  if (['csv','tsv','xlsx','xls'].includes(ext)
      || mime === 'text/csv'
      || mime?.includes('spreadsheetml')
      || mime === 'application/vnd.ms-excel') return 'spreadsheet';
  if (['pptx','ppt','pptm','ppsx','pps','potx'].includes(ext)
      || mime?.includes('presentationml')
      || mime === 'application/vnd.ms-powerpoint') return 'presentation';
  if (['docx','docm'].includes(ext)
      || mime?.includes('wordprocessingml')) return 'document';
  if (['mp4','webm','ogv','mov','m4v','mkv','avi'].includes(ext) || mime?.startsWith('video/')) return 'video';
  if (['mp3','wav','ogg','oga','m4a','flac','aac'].includes(ext) || mime?.startsWith('audio/')) return 'audio';
  if (ext === 'excalidraw') return 'sketch';
  if (ext === 'floorplan') return 'floorplan';
  if (ext === 'game') return 'game';
  return 'binary';
}
