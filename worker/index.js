import { handleApi } from './guestbook.js';

export const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

// Replaced by the build script; there are no filesystem reads in production.
const ASSETS = /*__STATIC_ASSETS__*/ {};
const decodedAssets = new Map();
export async function withInitialMessages(request, env, html) {
  const marker = '<!--guestbook-bootstrap-->';
  if (!html.includes(marker) || !env.DB?.prepare) return html;
  // Read within this Worker: initial page display does not depend on a second
  // browser fetch, which some clients/intermediaries fail to deliver correctly.
  const result = await handleApi(new Request(new URL('/api/messages', request.url)), env);
  if (!result.ok) return html;
  const data = await result.json();
  const safe = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return html.replace(marker, () => `<script id="guestbook-bootstrap" type="application/json">${safe}</script>`);
}
function assetBody(path, asset) {
  if (asset.encoding !== 'base64') return asset.body;
  if (!decodedAssets.has(path)) {
    const binary = atob(asset.body), bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    decodedAssets.set(path, bytes);
  }
  return decodedAssets.get(path);
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const isApi = path.startsWith('/api/');
    if (isApi) {
      const result = await handleApi(request, env);
      const headers = new Headers(result.headers);
      for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
      return new Response(result.body, { status: result.status, headers });
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405, headers: { ...securityHeaders, Allow: 'GET, HEAD' } });
    const asset = ASSETS[path === '/index.html' ? '/' : path];
    if (!asset) return new Response('这一页还没有写下。', { status: 404, headers: { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' } });
    const body = request.method === 'HEAD' ? null : asset.type.startsWith('text/html') ? await withInitialMessages(request, env, asset.body) : assetBody(path, asset);
    return new Response(body, { headers: { ...securityHeaders, 'Content-Type': asset.type, 'Cache-Control': asset.cache || 'public, max-age=0, must-revalidate' } });
  }
};
