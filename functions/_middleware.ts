// Serve the mobile app on mobile.* hosts from the same Pages project/assets.
// _routes.json limits this to HTML entry requests, so static assets never
// invoke a Function (no extra request cost).
interface Ctx {
  request: Request;
  env: { ASSETS: { fetch(req: Request): Promise<Response> } };
  next(): Promise<Response>;
}

export const onRequest = async (ctx: Ctx): Promise<Response> => {
  const url = new URL(ctx.request.url);
  if (url.hostname.startsWith('mobile.') && (url.pathname === '/' || url.pathname === '/index.html')) {
    url.pathname = '/mobile'; // Pages serves mobile.html at its pretty URL
    const res = await ctx.env.ASSETS.fetch(new Request(url.toString(), ctx.request));
    const out = new Response(res.body, res);
    out.headers.set('Cache-Control', 'no-cache');
    return out;
  }
  return ctx.next();
};
