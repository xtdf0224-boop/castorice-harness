/* The page's Content-Security-Policy (B5, X04) and the Vite plugin that stamps it on every html page of the build.
   Lives here (not inline in vite.config.ts) so scripts/check-security.ts can run the real injection code.

   The packaged app loads from file:// with a desktop bridge in the page: lock what the page may load.
   Model calls never go out from the page (the desktop process makes them), so connect-src stays 'self'.
   Images may only come from the bundle, data: and blob: URLs — never from the network — so a model-written
   ![](https://attacker/?q=…) cannot leak anything by being rendered (出站渲染泄漏, DESIGN §7.4).
   Do not loosen img-src / connect-src here; scripts/check-build.mjs fails the build if they change, and does so for every
   html page in dist/. A custom media protocol (R40, V0.5) may add ONE source to img-src/media-src after a security review;
   connect-src still stays 'self'. */
import type { Plugin } from 'vite';

export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' blob:", "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;

/** Put the policy behind <meta charset> (which must stay in the first 1024 bytes) or, without one, right after <head>,
 *  and drop any policy the page already carries (one policy for the whole app). A page without a <head> would silently
 *  ship unprotected, so fail instead. */
export function injectCsp(html: string, filename = 'html page'): string {
  const stripped = html.replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>\s*/gi, '');
  if (!/<head[^>]*>/i.test(stripped)) throw new Error(`alight-csp: ${filename} has no <head>, cannot add the Content-Security-Policy`);
  const charset = /<meta\b[^>]*\bcharset\b[^>]*>/i;
  return charset.test(stripped)
    ? stripped.replace(charset, (m) => `${m}\n    ${CSP_META}`)
    : stripped.replace(/<head[^>]*>/i, (m) => `${m}\n    ${CSP_META}`);
}

/** Build only — the dev server needs its own client script and HMR socket. */
export function cspPlugin(): Plugin {
  return {
    name: 'alight-csp',
    apply: 'build',
    transformIndexHtml: { order: 'post', handler: (html, ctx) => injectCsp(html, ctx.filename) },
  };
}
