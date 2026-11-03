// Drag-and-drop block library for the website builder. Every block is plain,
// self-contained HTML with inline styles so it looks right on any page and stays
// fully editable as code. `section` blocks snap to the top level of the page.
export interface Block { id: string; label: string; icon: string; group: string; section: boolean; html: string }

const IMG = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='800' height='500'%3E%3Crect width='100%25' height='100%25' fill='%23e9e6f8'/%3E%3Ctext x='50%25' y='50%25' fill='%239a93ad' font-family='sans-serif' font-size='30' text-anchor='middle' dy='.35em'%3EYour image%3C/text%3E%3C/svg%3E";
const F = "font-family:inherit";
const card = (t: string, p: string) => `<div style="flex:1 1 220px;padding:24px;border-radius:16px;background:#faf5ff;color:#1a1a2e"><h3 style="margin:0 0 8px">${t}</h3><p style="margin:0">${p}</p></div>`;

export const BLOCKS: Block[] = [
  { id: 'navbar', label: 'Navbar', icon: '☰', group: 'Sections', section: true, html:
`<nav style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 32px;background:#fff;color:#1a1a2e;border-bottom:1px solid #eee"><strong style="font-size:20px">Brand</strong><div style="display:flex;gap:20px"><a href="#" style="text-decoration:none;color:inherit">Home</a><a href="#" style="text-decoration:none;color:inherit">About</a><a href="#" style="text-decoration:none;color:inherit">Contact</a></div></nav>` },
  { id: 'hero', label: 'Hero', icon: '🌅', group: 'Sections', section: true, html:
`<section style="padding:96px 24px;text-align:center;background:linear-gradient(135deg,#ec4899,#8b5cf6);color:#fff"><h1 style="font-size:48px;margin:0 0 12px">Your big headline</h1><p style="max-width:560px;margin:0 auto 28px;font-size:18px">A short, punchy line about what you do and who it is for.</p><a href="#" style="display:inline-block;padding:14px 28px;border-radius:99px;background:#fff;color:#8b5cf6;font-weight:700;text-decoration:none">Get started</a></section>` },
  { id: 'features', label: 'Features', icon: '✨', group: 'Sections', section: true, html:
`<section style="display:flex;flex-wrap:wrap;gap:20px;max-width:960px;margin:0 auto;padding:56px 24px;color:#1a1a2e">${card('Fast', 'Describe your first benefit.')}${card('Simple', 'Describe your second benefit.')}${card('Yours', 'Describe your third benefit.')}</section>` },
  { id: 'gallery', label: 'Gallery', icon: '🖼', group: 'Sections', section: true, html:
`<section style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;max-width:960px;margin:0 auto;padding:32px 24px"><img src="${IMG}" alt="" style="width:100%;border-radius:12px"><img src="${IMG}" alt="" style="width:100%;border-radius:12px"><img src="${IMG}" alt="" style="width:100%;border-radius:12px"></section>` },
  { id: 'testimonial', label: 'Testimonial', icon: '💬', group: 'Sections', section: true, html:
`<section style="padding:64px 24px;text-align:center;background:#faf5ff;color:#1a1a2e"><p style="max-width:640px;margin:0 auto 12px;font-size:22px;font-style:italic">“This changed how we work. Absolutely love it.”</p><strong>Happy Customer</strong></section>` },
  { id: 'pricing', label: 'Pricing', icon: '💳', group: 'Sections', section: true, html:
`<section style="display:flex;flex-wrap:wrap;gap:20px;max-width:800px;margin:0 auto;padding:56px 24px;color:#1a1a2e"><div style="flex:1 1 240px;padding:28px;border:1px solid #ddd;border-radius:16px;text-align:center"><h3>Free</h3><p style="font-size:36px;margin:8px 0"><b>$0</b></p><p>Everything to get started</p><a href="#" style="display:inline-block;padding:10px 22px;border-radius:99px;border:2px solid #8b5cf6;color:#8b5cf6;text-decoration:none">Choose</a></div><div style="flex:1 1 240px;padding:28px;border:2px solid #8b5cf6;border-radius:16px;text-align:center"><h3>Pro</h3><p style="font-size:36px;margin:8px 0"><b>$9</b></p><p>For serious projects</p><a href="#" style="display:inline-block;padding:10px 22px;border-radius:99px;background:#8b5cf6;color:#fff;text-decoration:none">Choose</a></div></section>` },
  { id: 'cta', label: 'Call to action', icon: '📣', group: 'Sections', section: true, html:
`<section style="padding:64px 24px;text-align:center;background:#1a1a2e;color:#fff"><h2 style="margin:0 0 16px">Ready to start?</h2><a href="#" style="display:inline-block;padding:14px 28px;border-radius:99px;background:#ec4899;color:#fff;font-weight:700;text-decoration:none">Join now</a></section>` },
  { id: 'contact', label: 'Contact form', icon: '✉️', group: 'Sections', section: true, html:
`<section style="max-width:520px;margin:0 auto;padding:48px 24px;color:#1a1a2e"><h2 style="margin-top:0">Contact us</h2><form action="mailto:you@example.com" method="post" enctype="text/plain" style="display:grid;gap:12px"><input name="name" placeholder="Your name" style="padding:12px;border:1px solid #ccc;border-radius:8px;${F}"><input name="email" type="email" placeholder="Email" style="padding:12px;border:1px solid #ccc;border-radius:8px;${F}"><textarea name="message" rows="4" placeholder="Message" style="padding:12px;border:1px solid #ccc;border-radius:8px;${F}"></textarea><button type="submit" style="padding:12px;border:0;border-radius:99px;background:#8b5cf6;color:#fff;font-weight:700;cursor:pointer">Send</button></form></section>` },
  { id: 'footer', label: 'Footer', icon: '⬇️', group: 'Sections', section: true, html:
`<footer style="padding:32px;text-align:center;color:#777;font-size:14px;background:#f7f7fb">© 2026 Your Brand · Made with genzeditor.com</footer>` },
  { id: 'heading', label: 'Heading', icon: 'H', group: 'Basics', section: false, html: `<h2 style="margin:16px 0">Section heading</h2>` },
  { id: 'text', label: 'Paragraph', icon: '¶', group: 'Basics', section: false, html: `<p style="margin:12px 0;line-height:1.6">Double-click to edit this text. Say something worth reading.</p>` },
  { id: 'button', label: 'Button', icon: '🔘', group: 'Basics', section: false, html: `<a href="#" style="display:inline-block;padding:12px 26px;border-radius:99px;background:#8b5cf6;color:#fff;font-weight:700;text-decoration:none">Click me</a>` },
  { id: 'list', label: 'List', icon: '•', group: 'Basics', section: false, html: `<ul style="line-height:1.8"><li>First point</li><li>Second point</li><li>Third point</li></ul>` },
  { id: 'divider', label: 'Divider', icon: '—', group: 'Basics', section: false, html: `<hr style="border:0;border-top:1px solid #ddd;margin:24px 0">` },
  { id: 'spacer', label: 'Spacer', icon: '↕', group: 'Basics', section: false, html: `<div style="height:48px"></div>` },
  { id: 'image', label: 'Image', icon: '🏞', group: 'Media', section: false, html: `<img src="${IMG}" alt="Image" style="max-width:100%;border-radius:12px">` },
  { id: 'video', label: 'Video embed', icon: '▶️', group: 'Media', section: false, html: `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="Video" allowfullscreen style="width:100%;aspect-ratio:16/9;border:0;border-radius:12px"></iframe>` },
  { id: 'cols2', label: '2 columns', icon: '◧', group: 'Layout', section: false, html:
`<div style="display:flex;flex-wrap:wrap;gap:24px;padding:16px 0"><div style="flex:1 1 280px"><h3>Left</h3><p>Content goes here.</p></div><div style="flex:1 1 280px"><h3>Right</h3><p>Content goes here.</p></div></div>` },
  { id: 'cols3', label: '3 columns', icon: '▥', group: 'Layout', section: false, html:
`<div style="display:flex;flex-wrap:wrap;gap:20px;padding:16px 0"><div style="flex:1 1 200px"><h3>One</h3><p>Text.</p></div><div style="flex:1 1 200px"><h3>Two</h3><p>Text.</p></div><div style="flex:1 1 200px"><h3>Three</h3><p>Text.</p></div></div>` },
  { id: 'card', label: 'Card', icon: '🃏', group: 'Layout', section: false, html:
`<div style="padding:24px;border-radius:16px;background:#fff;box-shadow:0 4px 20px rgba(0,0,0,.1);color:#1a1a2e"><h3 style="margin-top:0">Card title</h3><p>Card text goes here.</p></div>` },
];
