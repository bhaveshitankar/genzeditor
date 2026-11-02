// Starter pages for the web page builder. Self-contained HTML + inline CSS — no
// scripts or remote assets, so they preview anywhere and share as a clean page.
const head = (title: string, css: string) => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1a1a2e;line-height:1.6}
a{color:inherit}${css}
</style>
</head>
<body>
`;

export const WEB_TEMPLATES: Array<{ id: string; label: string; html: string }> = [
  {
    id: 'landing', label: 'Landing page',
    html: head('My Product', `
.hero{padding:96px 24px;text-align:center;background:linear-gradient(135deg,#ec4899,#8b5cf6);color:#fff}
.hero h1{font-size:clamp(32px,6vw,56px);margin:0 0 12px}.hero p{max-width:560px;margin:0 auto 28px;font-size:18px;opacity:.95}
.btn{display:inline-block;padding:14px 28px;border-radius:99px;background:#fff;color:#8b5cf6;font-weight:700;text-decoration:none}
.features{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:20px;max-width:960px;margin:0 auto;padding:56px 24px}
.card{padding:24px;border-radius:16px;background:#faf5ff}.card h3{margin-top:0}
footer{text-align:center;padding:32px;color:#777;font-size:14px}`) + `<section class="hero">
  <h1>Build something people love</h1>
  <p>A short, punchy line about what you make and who it's for.</p>
  <a class="btn" href="#">Get started</a>
</section>
<section class="features">
  <div class="card"><h3>Fast</h3><p>Explain your first big benefit here.</p></div>
  <div class="card"><h3>Simple</h3><p>Explain your second big benefit here.</p></div>
  <div class="card"><h3>Yours</h3><p>Explain your third big benefit here.</p></div>
</section>
<footer>© 2026 My Product</footer>
</body>
</html>
`,
  },
  {
    id: 'portfolio', label: 'Portfolio',
    html: head('Your Name — Portfolio', `
body{background:#0f0f1a;color:#eee}.wrap{max-width:860px;margin:0 auto;padding:64px 24px}
h1{font-size:44px;margin:0}.tag{color:#ec4899;font-weight:600}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:32px}
.work{aspect-ratio:4/3;border-radius:14px;background:linear-gradient(135deg,#8b5cf6,#ec4899);display:flex;align-items:flex-end;padding:16px;font-weight:700}`) + `<div class="wrap">
  <p class="tag">Designer · Developer · Creator</p>
  <h1>Hi, I'm Your Name.</h1>
  <p>I make things for the web. Write two sentences about yourself here.</p>
  <div class="grid">
    <div class="work">Project one</div><div class="work">Project two</div><div class="work">Project three</div>
  </div>
  <p style="margin-top:40px">Say hi: <a href="mailto:you@example.com">you@example.com</a></p>
</div>
</body>
</html>
`,
  },
  {
    id: 'links', label: 'Link in bio',
    html: head('My Links', `
body{min-height:100vh;display:flex;justify-content:center;background:linear-gradient(160deg,#fdf2f8,#ede9fe)}
.col{width:100%;max-width:420px;padding:48px 20px;text-align:center}
.av{width:96px;height:96px;border-radius:50%;margin:0 auto 12px;background:linear-gradient(135deg,#ec4899,#8b5cf6)}
.l{display:block;margin:12px 0;padding:16px;border-radius:14px;background:#fff;text-decoration:none;font-weight:600;box-shadow:0 2px 10px rgba(139,92,246,.15)}`) + `<div class="col">
  <div class="av"></div>
  <h2 style="margin:0">@yourname</h2>
  <p>One line about you.</p>
  <a class="l" href="#">My website</a>
  <a class="l" href="#">Latest video</a>
  <a class="l" href="#">Contact me</a>
</div>
</body>
</html>
`,
  },
  {
    id: 'invite', label: 'Event invite',
    html: head('You are invited', `
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#111;color:#fff;text-align:center;padding:24px}
.box{max-width:480px;padding:40px;border:2px solid #ec4899;border-radius:24px}
h1{font-size:40px;margin:8px 0}.when{font-size:20px;color:#f9a8d4}`) + `<div class="box">
  <p>You're invited to</p>
  <h1>Alex's Birthday Bash</h1>
  <p class="when">Saturday, 12 December · 7 PM</p>
  <p>Rooftop Lounge, 12 Sunset Street</p>
  <p><a href="#">RSVP</a></p>
</div>
</body>
</html>
`,
  },
];
