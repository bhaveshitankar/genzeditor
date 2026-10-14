// Build-time SEO: stamps dist/index.html into one static landing page per tool
// (dist/<slug>/index.html) with its own title/description/canonical/JSON-LD and
// crawlable content, rewrites the sitemap, and adds a tools hub at /tools/.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SITE = 'https://genzeditor.com';

// tpl = New-file template id opened on an empty workspace (see AppShell.NEW_FILE_TEMPLATES).
export const TOOLS = [
  { slug: 'pdf-editor', name: 'PDF Editor', tpl: '', title: 'Free Online PDF Editor — No Upload, No Signup',
    desc: 'Edit, annotate, merge and reorder PDF files online for free. Runs entirely in your browser — your PDF never leaves your device.',
    h1: 'Free Online PDF Editor', lead: 'Open a PDF and edit it right in your browser. Nothing is uploaded to a server, so confidential contracts, forms and reports stay on your device.',
    points: ['Add text, highlights and annotations', 'Reorder, rotate and delete pages', 'Scan paper documents to PDF with your camera', 'Works offline once loaded', 'No account, no watermark, no file-size paywall'],
    faqs: [['Is my PDF uploaded anywhere?', 'No. Editing happens locally in your browser using your device, so the file never leaves it.'], ['Is the PDF editor free?', 'Yes, it is free with no watermark and no sign-up.'], ['Does it work on mobile?', 'Yes. It runs in any modern mobile or desktop browser.']] },
  { slug: 'image-editor', name: 'Image Editor', tpl: 'image', title: 'Free Online Image Editor — Photo Editing in Your Browser',
    desc: 'Edit photos online for free: crop, resize, filters, text and drawing. Private photo editor that runs in your browser with no upload.',
    h1: 'Free Online Image Editor', lead: 'Crop, resize, retouch and add filters or text to your photos without installing anything. Your images are processed locally and never uploaded.',
    points: ['Crop, rotate, resize and flip', 'Filters, brightness, contrast and color adjustments', 'Add text and draw on images', 'Export as PNG, JPG or WebP', 'No account and no watermark'],
    faqs: [['Is this a free photo editor?', 'Yes, completely free with no watermark.'], ['Are my photos uploaded?', 'No. Edits run in your browser on your own device.'], ['Which formats are supported?', 'PNG, JPG, WebP, GIF, BMP and more.']] },
  { slug: 'background-remover', name: 'Background Remover', tpl: '', title: 'Free Background Remover — Remove Image Background Online',
    desc: 'Remove the background from any photo in one click, free and private. AI runs in your browser — no upload, no signup.',
    h1: 'Remove Image Background Online, Free', lead: 'Drop in a photo and get a clean transparent cut-out in seconds. The AI model runs in your browser, so your pictures stay private.',
    points: ['One-click AI background removal', 'Transparent PNG export', 'No upload — processed on your device', 'No sign-up, no watermark', 'Great for product photos, portraits and logos'],
    faqs: [['Is the background remover really free?', 'Yes, with no watermark and no daily limit.'], ['Do you upload my photo?', 'No. The model runs locally in your browser.'], ['What format is the result?', 'A transparent PNG you can download or keep editing.']] },
  { slug: 'video-editor', name: 'Video Editor', tpl: 'video', title: 'Free Online Video Editor — Trim, Cut & Export in Browser',
    desc: 'Trim, cut and export videos online for free. A private video editor that runs in your browser with no upload and no watermark.',
    h1: 'Free Online Video Editor', lead: 'Trim and cut clips, then export — all in your browser. Videos are processed on your device, never uploaded.',
    points: ['Trim and split clips', 'Export without watermark', 'Runs locally with WebAssembly', 'No sign-up required'],
    faqs: [['Is there a watermark?', 'No watermark on exports.'], ['Are my videos uploaded?', 'No, processing is local.'], ['Is it free?', 'Yes.']] },
  { slug: 'audio-editor', name: 'Audio Editor', tpl: 'audio', title: 'Free Online Audio Editor & MP3 Cutter — In Your Browser',
    desc: 'Record, trim and convert audio online for free. A private audio editor and MP3 cutter that runs in your browser.',
    h1: 'Free Online Audio Editor & MP3 Cutter', lead: 'Record from your microphone, trim tracks and export to WAV or MP3 without uploading anything.',
    points: ['Record audio from your mic', 'Trim and cut MP3 and WAV files', 'Export to MP3 or WAV', 'No upload, no sign-up'],
    faqs: [['Can I cut an MP3 online?', 'Yes — open the file, select the part you want and export.'], ['Is it private?', 'Yes, audio is processed in your browser.'], ['Is it free?', 'Yes.']] },
  { slug: 'markdown-editor', name: 'Markdown Editor', tpl: 'markdown', title: 'Free Online Markdown Editor with Live Preview',
    desc: 'Write Markdown online with live preview. Free, private Markdown editor that saves locally in your browser — no signup.',
    h1: 'Online Markdown Editor with Live Preview', lead: 'Write Markdown and see it rendered instantly. Files are stored locally in your browser and can be shared by link when you choose.',
    points: ['Live side-by-side preview', 'Syntax highlighting', 'Download as .md', 'Share via private link', 'Works offline'],
    faqs: [['Is my text saved?', 'Yes, locally in your browser storage.'], ['Can I export my notes?', 'Yes, download the .md file any time.'], ['Is it free?', 'Yes.']] },
  { slug: 'json-editor', name: 'JSON Editor & Formatter', tpl: 'json', title: 'Free Online JSON Editor, Formatter & Validator',
    desc: 'Format, validate, minify and edit JSON online for free. Private JSON editor that runs in your browser.',
    h1: 'Online JSON Editor, Formatter & Validator', lead: 'Paste JSON to pretty-print, validate and fix it. Your data never leaves your browser, so it is safe for API keys and customer payloads.',
    points: ['Pretty-print and minify', 'Validation with error locations', 'Syntax highlighting', 'No upload — fully local'],
    faqs: [['Is it safe for sensitive JSON?', 'Yes. Nothing is sent to a server.'], ['Can it validate JSON?', 'Yes, errors are shown with their position.'], ['Is it free?', 'Yes.']] },
  { slug: 'csv-editor', name: 'CSV & Spreadsheet Editor', tpl: 'csv', title: 'Free Online CSV Editor & Spreadsheet — Edit CSV, XLSX',
    desc: 'Open and edit CSV and spreadsheet files online for free. Private spreadsheet editor in your browser, no upload.',
    h1: 'Free Online CSV Editor & Spreadsheet', lead: 'Open CSV or Excel files, edit cells, sort and export — all locally in your browser.',
    points: ['Edit CSV and XLSX in a grid', 'Add and remove rows and columns', 'Export to CSV', 'No upload, no sign-up'],
    faqs: [['Can I open Excel files?', 'Yes, XLSX files open in the grid editor.'], ['Is my data private?', 'Yes, it stays in your browser.'], ['Is it free?', 'Yes.']] },
  { slug: 'word-document-editor', name: 'Word Document Editor', tpl: 'document', title: 'Free Online Word (DOCX) Editor — No Signup',
    desc: 'Create and edit Word DOCX documents online for free. Private document editor that works in your browser.',
    h1: 'Free Online Word Document Editor', lead: 'Write and edit .docx documents in your browser with no sign-up. Files stay on your device.',
    points: ['Open and edit DOCX files', 'Rich text formatting', 'Download as DOCX', 'Works offline'],
    faqs: [['Can I edit .docx files?', 'Yes, open them and download the edited copy.'], ['Do I need an account?', 'No.'], ['Is it free?', 'Yes.']] },
  { slug: 'presentation-maker', name: 'Presentation Maker', tpl: 'presentation', title: 'Free Online Presentation Maker — Create & Edit PPTX',
    desc: 'Create and edit slide presentations online for free. Private PowerPoint-style editor in your browser, no signup.',
    h1: 'Free Online Presentation Maker', lead: 'Build slide decks and edit .pptx files right in your browser — no account and no upload.',
    points: ['Create and edit PPTX slides', 'Text, shapes and images', 'Download as PPTX', 'No sign-up'],
    faqs: [['Can I open PowerPoint files?', 'Yes, PPTX files open in the editor.'], ['Is it free?', 'Yes.'], ['Is it private?', 'Yes, files are processed locally.']] },
  { slug: 'whiteboard', name: 'Online Whiteboard', tpl: 'sketch', title: 'Free Online Whiteboard & Sketch Tool — No Signup',
    desc: 'Draw diagrams and sketches on a free online whiteboard. Private, runs in your browser, no account needed.',
    h1: 'Free Online Whiteboard & Sketch Tool', lead: 'Sketch ideas, draw diagrams and brainstorm on an infinite canvas. Saves locally and can be shared by link.',
    points: ['Shapes, arrows, text and freehand drawing', 'Export to PNG and SVG', 'Share a private link', 'No sign-up'],
    faqs: [['Is the whiteboard free?', 'Yes.'], ['Can I export my drawing?', 'Yes, as PNG or SVG.'], ['Do I need an account?', 'No.']] },
  { slug: 'mermaid-diagram-editor', name: 'Mermaid Diagram Editor', tpl: 'mermaid', title: 'Free Online Mermaid Diagram Editor with Live Preview',
    desc: 'Write Mermaid code and preview flowcharts and sequence diagrams live. Free and private, runs in your browser.',
    h1: 'Online Mermaid Diagram Editor', lead: 'Type Mermaid syntax and see flowcharts, sequence and class diagrams render instantly.',
    points: ['Live diagram preview', 'Flowcharts, sequence, class and Gantt diagrams', 'Export as image', 'No upload'],
    faqs: [['What is Mermaid?', 'A text syntax for generating diagrams and charts.'], ['Is it free?', 'Yes.'], ['Is my diagram private?', 'Yes, it is rendered in your browser.']] },
  { slug: 'code-editor', name: 'Online Code Editor', tpl: 'code', title: 'Free Online Code Editor — Syntax Highlighting, No Signup',
    desc: 'Edit code online with syntax highlighting for many languages. Free, private code editor in your browser.',
    h1: 'Free Online Code Editor', lead: 'Open or paste code in JavaScript, Python, HTML, CSS and many more languages and edit with syntax highlighting.',
    points: ['Syntax highlighting for many languages', 'Open and download files', 'Share via link', 'No sign-up'],
    faqs: [['Which languages are supported?', 'Most popular languages including JS, TS, Python, HTML, CSS and more.'], ['Is it free?', 'Yes.'], ['Is my code private?', 'Yes, it stays in your browser.']] },
  { slug: 'text-editor', name: 'Online Text Editor', tpl: 'text', title: 'Free Online Text Editor — Notepad in Your Browser',
    desc: 'A free online notepad and text editor that saves locally in your browser. No signup, works offline.',
    h1: 'Free Online Text Editor & Notepad', lead: 'Write notes and edit plain-text files. Saved locally in your browser and available offline.',
    points: ['Plain text and notes', 'Auto-saved locally', 'Download as .txt', 'Works offline'],
    faqs: [['Are my notes saved?', 'Yes, in your browser storage.'], ['Is it free?', 'Yes.'], ['Do I need an account?', 'No.']] },
  { slug: 'document-scanner', name: 'Document Scanner', tpl: 'scan', title: 'Free Online Document Scanner — Scan to PDF with Your Camera',
    desc: 'Scan documents to PDF using your phone or webcam. Free, private, runs in your browser with no app install.',
    h1: 'Free Online Document Scanner', lead: 'Use your camera to scan paper documents and save them as a PDF. Processed locally, never uploaded.',
    points: ['Scan with phone or webcam', 'Auto-crop and enhance', 'Export multi-page PDF', 'No app install'],
    faqs: [['Do I need an app?', 'No, it works in your browser.'], ['Is it private?', 'Yes, scans stay on your device.'], ['Is it free?', 'Yes.']] },
];

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nav = () => `<nav aria-label="All tools"><h2>All GenZ Editor tools</h2><ul>${[...TOOLS.map((t) => `<li><a href="/${t.slug}/">${esc(t.name)}</a></li>`)].join('')}</ul></nav>`;
const STYLE = '<style>#seo{max-width:760px;margin:0 auto;padding:32px 20px 64px;font:16px/1.6 system-ui,sans-serif;color:var(--text,#222)}#seo a{color:var(--brand-600,#7c3aed)}#seo ul{padding-left:20px}#seo nav ul{columns:2;list-style:none;padding:0}</style>';

function body(t) {
  const faq = t.faqs.map(([q, a]) => `<h3>${esc(q)}</h3><p>${esc(a)}</p>`).join('');
  return `<main id="seo">${STYLE}<h1>${esc(t.h1)}</h1><p>${esc(t.lead)}</p>
<h2>What you can do</h2><ul>${t.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<h2>Private by design</h2><p>GenZ Editor runs entirely in your browser. Your files are processed on your own device and are never uploaded unless you choose to create a share link. No account, no watermark, no limits.</p>
<h2>Frequently asked questions</h2>${faq}${nav()}</main>`;
}

function ld(t, url) {
  return `<script type="application/ld+json">${JSON.stringify([
    { '@context': 'https://schema.org', '@type': 'WebApplication', name: `GenZ Editor — ${t.name}`, url, description: t.desc,
      applicationCategory: 'Productivity', operatingSystem: 'Any (web browser)', offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' } },
    { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: t.faqs.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'GenZ Editor', item: `${SITE}/` }, { '@type': 'ListItem', position: 2, name: t.name, item: url }] },
  ])}</script>`;
}

function stamp(html, t, url) {
  const title = `${t.title} | GenZ Editor`;
  let h = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, `$1${esc(t.desc)}"`)
    .replace(/(<link rel="canonical" href=")[^"]*"/, `$1${url}"`)
    .replace(/(<meta property="og:title" content=")[^"]*"/, `$1${esc(title)}"`)
    .replace(/(<meta property="og:description" content=")[^"]*"/, `$1${esc(t.desc)}"`)
    .replace(/(<meta property="og:url" content=")[^"]*"/, `$1${url}"`)
    .replace(/(<meta name="twitter:title" content=")[^"]*"/, `$1${esc(title)}"`)
    .replace(/(<meta name="twitter:description" content=")[^"]*"/, `$1${esc(t.desc)}"`)
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, ld(t, url))
    .replace('</head>', `<meta name="gz-tool" content="${t.tpl}">\n</head>`)
    .replace('<div id="app"></div>', `<div id="app"></div>\n${body(t)}`);
  return h;
}

export function seoPages() {
  let outDir = 'dist';
  return {
    name: 'genz-seo-pages',
    apply: 'build',
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      const home = readFileSync(resolve(outDir, 'index.html'), 'utf8');
      for (const t of TOOLS) {
        const dir = resolve(outDir, t.slug);
        mkdirSync(dir, { recursive: true });
        writeFileSync(resolve(dir, 'index.html'), stamp(home, t, `${SITE}/${t.slug}/`));
      }
      // Hub page listing every tool.
      const hub = { name: 'All Tools', tpl: '', title: 'Free Online Editors — PDF, Image, Video, Audio, Docs & More',
        desc: 'Every GenZ Editor tool: PDF, image, video, audio, Markdown, JSON, CSV, documents, slides and whiteboard. Free and private in your browser.',
        h1: 'Free Online Editing Tools', lead: 'Pick a tool below. Everything runs in your browser — private, free and no sign-up.',
        points: TOOLS.map((t) => t.name), faqs: [['Are these tools free?', 'Yes, all of them.'], ['Do you upload my files?', 'No, files are processed locally.']] };
      mkdirSync(resolve(outDir, 'tools'), { recursive: true });
      writeFileSync(resolve(outDir, 'tools/index.html'), stamp(home, hub, `${SITE}/tools/`));
      // Home page: add crawlable links to every tool.
      writeFileSync(resolve(outDir, 'index.html'),
        home.replace('<div id="app"></div>', `<div id="app"></div>\n<div id="seo">${STYLE}${nav()}</div>`));
      const today = new Date().toISOString().slice(0, 10);
      const urls = [['/', '1.0'], ['/tools/', '0.8'], ...TOOLS.map((t) => [`/${t.slug}/`, '0.9'])];
      writeFileSync(resolve(outDir, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
        urls.map(([p, pr]) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod><priority>${pr}</priority></url>`).join('\n')}\n</urlset>\n`);
    },
  };
}
