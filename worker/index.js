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
    return new Response(request.method === 'HEAD' ? null : assetBody(path, asset), { headers: { ...securityHeaders, 'Content-Type': asset.type, 'Cache-Control': asset.cache || 'public, max-age=0, must-revalidate' } });
  }
};
