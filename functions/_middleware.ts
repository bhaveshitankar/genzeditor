// Host routing for the HTML entry (_routes.json limits this to "/" and
// "/index.html", so static assets never invoke a Function):
//  - mobile.* hosts serve the mobile app (mobile.html) from the same project.
//  - Phones hitting the main site are redirected to mobile.genzeditor.com,
//    unless they chose the desktop site (?desktop=1 → remembered in a cookie)
//    or already use the desktop site on this phone (gz-seen cookie, set by the
//    app when local files exist — files are stored per origin).
interface Ctx {
  request: Request;
  env: { ASSETS: { fetch(req: Request): Promise<Response> } };
  next(): Promise<Response>;
}

const MOBILE_ORIGIN = 'https://mobile.genzeditor.com';
const PHONE_UA = /iPhone|iPod|Android.+Mobile|Windows Phone|BlackBerry|Opera Mini|IEMobile|Mobile Safari/i;
const YEAR = 60 * 60 * 24 * 365;

function noCache(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'no-cache');
  out.headers.set('Vary', 'User-Agent, Cookie');
  for (const [k, v] of Object.entries(extra)) out.headers.append(k, v);
  return out;
}

export const onRequest = async (ctx: Ctx): Promise<Response> => {
  const url = new URL(ctx.request.url);
  const isEntry = url.pathname === '/' || url.pathname === '/index.html';
  if (!isEntry) return ctx.next();

  if (url.hostname.startsWith('mobile.')) {
    url.pathname = '/mobile'; // Pages serves mobile.html at its pretty URL
    return noCache(await ctx.env.ASSETS.fetch(new Request(url.toString(), ctx.request)));
  }

  if (url.hostname !== 'genzeditor.com' && url.hostname !== 'www.genzeditor.com') return ctx.next();

  const cookies = ctx.request.headers.get('Cookie') ?? '';
  const q = url.searchParams;
  if (q.has('desktop')) {
    return noCache(await ctx.next(), { 'Set-Cookie': `gz-view=desktop; Max-Age=${YEAR}; Path=/; Secure; SameSite=Lax` });
  }
  const goMobile = (): Response => {
    q.delete('mobile');
    const qs = q.toString();
    // The #fragment (share links) is carried over by the browser on redirect.
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${MOBILE_ORIGIN}/${qs ? `?${qs}` : ''}`,
        'Cache-Control': 'no-store',
        Vary: 'User-Agent, Cookie',
        'Set-Cookie': 'gz-view=; Max-Age=0; Path=/; Secure; SameSite=Lax',
      },
    });
  };
  if (q.has('mobile')) return goMobile();

  const chosenDesktop = /(?:^|;\s*)gz-view=desktop/.test(cookies);
  const usesDesktopHere = /(?:^|;\s*)gz-seen=1/.test(cookies);
  const ua = ctx.request.headers.get('User-Agent') ?? '';
  const phone = ctx.request.headers.get('Sec-CH-UA-Mobile') === '?1' || PHONE_UA.test(ua);
  if (phone && !chosenDesktop && !usesDesktopHere) return goMobile();
  return noCache(await ctx.next());
};
