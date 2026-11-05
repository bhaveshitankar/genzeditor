// Ready-made CSS/JS behaviors that can be dropped into a page from the designer.
// Each adds a <style> and/or <script> block (and optionally an element) that stay
// fully editable afterwards in the "Code & behaviors" panel.
export interface Snippet { id: string; label: string; css?: string; js?: string; html?: string; tip: string }

export const SNIPPETS: Snippet[] = [
  { id: 'reveal', label: 'Scroll reveal', tip: 'Add the class "reveal" to any element to fade it in on scroll.',
    css: '.reveal{opacity:0;transform:translateY(24px);transition:opacity .7s,transform .7s}\n.reveal.in{opacity:1;transform:none}',
    js: "const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.15});\ndocument.querySelectorAll('.reveal').forEach(el=>io.observe(el));" },
  { id: 'smooth', label: 'Smooth scrolling', tip: 'Anchor links (#section) glide instead of jumping.', css: 'html{scroll-behavior:smooth}' },
  { id: 'dark', label: 'Dark-mode toggle', tip: 'Adds a floating button that flips the page between light and dark.',
    html: '<button id="gz-dark" type="button" aria-label="Toggle dark mode" style="position:fixed;right:16px;bottom:16px;width:44px;height:44px;border-radius:50%;border:0;cursor:pointer;font-size:20px;box-shadow:0 2px 10px rgba(0,0,0,.3)">🌓</button>',
    css: 'body.dark{background:#111!important;color:#eee!important}',
    js: "document.getElementById('gz-dark').addEventListener('click',()=>document.body.classList.toggle('dark'));" },
  { id: 'top', label: 'Back-to-top button', tip: 'A button that appears after scrolling and jumps to the top.',
    html: '<button id="gz-top" type="button" aria-label="Back to top" style="position:fixed;right:16px;bottom:16px;width:44px;height:44px;border-radius:50%;border:0;background:#8b5cf6;color:#fff;font-size:20px;cursor:pointer;display:none">↑</button>',
    js: "const b=document.getElementById('gz-top');addEventListener('scroll',()=>{b.style.display=scrollY>400?'block':'none'});b.addEventListener('click',()=>scrollTo({top:0,behavior:'smooth'}));" },
  { id: 'countdown', label: 'Countdown timer', tip: 'Edit the target date in the script (new Date("…")).',
    html: '<div id="gz-countdown" style="text-align:center;font-size:32px;font-weight:700;padding:24px"></div>',
    js: "const target=new Date('2026-12-31T00:00:00');\nconst el=document.getElementById('gz-countdown');\nfunction tick(){const s=Math.max(0,Math.floor((target-Date.now())/1000));el.textContent=Math.floor(s/86400)+'d '+Math.floor(s%86400/3600)+'h '+Math.floor(s%3600/60)+'m '+s%60+'s'}\ntick();setInterval(tick,1000);" },
  { id: 'stars', label: 'Twinkling stars', tip: 'Drifting dots behind your content.',
    css: '.gz-star{position:fixed;width:2px;height:2px;border-radius:50%;background:#fff;opacity:.6;pointer-events:none;animation:gz-tw 3s infinite alternate}\n@keyframes gz-tw{to{opacity:.1}}',
    js: "for(let i=0;i<80;i++){const s=document.createElement('i');s.className='gz-star';s.style.left=Math.random()*100+'%';s.style.top=Math.random()*100+'%';s.style.animationDelay=Math.random()*3+'s';document.body.appendChild(s)}" },
];
