// Anonymous guestbook API. No credentials or raw IP addresses are stored here.
const PAGE_SIZE = 12;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MINIMUM_WAIT_MS = 2000;
const COOLDOWN_MS = 45 * 1000;
const MAX_BODY_BYTES = 8192;
const encoder = new TextEncoder();
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const URL_PATTERN = /(?:https?:\/\/|www\.|\b[a-z0-9][a-z0-9.-]*\.(?:com|net|org|cn|io|xyz|top|vip|shop|cc|me|link)(?:\b|\/))/iu;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

class ApiError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    Object.assign(this, { status, code, retryAfter });
  }
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

function fail(status, code, message, retryAfter) {
  throw new ApiError(status, code, message, retryAfter);
}

function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}

function decodeBase64Url(text) {
  if (!/^[A-Za-z0-9_-]+$/u.test(text) || text.length > 2048) throw new Error('Invalid base64url');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
}

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(text)));
}

function secretFor(env) {
  if (typeof env.SIGNING_SECRET !== 'string' || env.SIGNING_SECRET.length < 32) {
    fail(503, 'SERVICE_UNAVAILABLE', '留言服务还未准备好，请稍后再来。');
  }
  return env.SIGNING_SECRET;
}

function requireDatabase(env) {
  if (!env.DB?.prepare) fail(503, 'SERVICE_UNAVAILABLE', '留言服务还未准备好，请稍后再来。');
}

function requireSameOrigin(request, mandatory = false) {
  const origin = request.headers.get('Origin');
  if ((mandatory && !origin) || (origin && origin !== new URL(request.url).origin)) {
    fail(403, 'ORIGIN_NOT_ALLOWED', '请在本站打开留言簿后再发布。');
  }
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    fail(403, 'ORIGIN_NOT_ALLOWED', '请在本站打开留言簿后再发布。');
  }
}

async function clientHash(request, secret) {
  // CF-Connecting-IP is supplied by Cloudflare in production. Never trust an
  // arbitrary X-Forwarded-For header; local development shares one rate bucket.
  const ip = request.headers.get('CF-Connecting-IP') || 'local-development';
  return encodeBase64Url(await hmac(secret, 'guestbook-client:' + ip));
}

async function createSession(request, env) {
  requireSameOrigin(request);
  requireDatabase(env);
  const secret = secretFor(env);
  const now = Date.now();
  const payload = {
    v: 1,
    nonce: crypto.randomUUID(),
    iat: now,
    exp: now + TOKEN_TTL_MS,
    client: await clientHash(request, secret),
  };
  const encoded = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = encodeBase64Url(await hmac(secret, encoded));
  return json({ token: `${encoded}.${signature}`, expiresAt: new Date(payload.exp).toISOString(), minimumWaitMs: MINIMUM_WAIT_MS });
}

async function verifySession(token, request, secret, now) {
  if (typeof token !== 'string' || token.length > 1800) fail(403, 'INVALID_SESSION', '表单已过期，请刷新后重试。');
  try {
    const parts = token.split('.');
    if (parts.length !== 2) throw new Error('Invalid token');
    const [encoded, signature] = parts;
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('HMAC', key, decodeBase64Url(signature), encoder.encode(encoded));
    if (!valid) throw new Error('Invalid signature');
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
    if (payload.v !== 1 || !/^[0-9a-f-]{36}$/u.test(payload.nonce) || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp - payload.iat !== TOKEN_TTL_MS || payload.iat > now || payload.exp <= now || payload.client !== await clientHash(request, secret)) {
      throw new Error('Invalid claims');
    }
    if (now - payload.iat < MINIMUM_WAIT_MS) fail(429, 'TOO_FAST', '稍等两秒，再把这句话留下来。', 2);
    return payload;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    fail(403, 'INVALID_SESSION', '表单已过期，请刷新后重试。');
  }
}

async function readBoundedJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    fail(415, 'JSON_REQUIRED', '请使用本站的留言表单。');
  }
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) {
    fail(413, 'BODY_TOO_LARGE', '留言太长了，请精简后再发布。');
  }
  if (!request.body) fail(400, 'INVALID_BODY', '请填写昵称和留言。');
  const reader = request.body.getReader();
  let total = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      fail(413, 'BODY_TOO_LARGE', '留言太长了，请精简后再发布。');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Not an object');
    return body;
  } catch {
    fail(400, 'INVALID_JSON', '留言格式不正确，请刷新后再试。');
  }
}

export function validateMessage(body) {
  if (body.website !== undefined && (typeof body.website !== 'string' || body.website !== '')) {
    fail(400, 'INVALID_MESSAGE', '暂时无法发布这条留言。');
  }
  if (typeof body.nickname !== 'string' || typeof body.content !== 'string') {
    fail(422, 'INVALID_MESSAGE', '请填写昵称和留言。');
  }
  const nickname = body.nickname.normalize('NFC').trim();
  const content = body.content.normalize('NFC').replace(/\r\n?/g, '\n').trim();
  if (Array.from(nickname).length < 1 || Array.from(nickname).length > 24 || /[\n\r\t]/u.test(nickname)) {
    fail(422, 'INVALID_NICKNAME', '昵称请填写 1～24 个字，不要换行。');
  }
  if (Array.from(content).length < 2 || Array.from(content).length > 500) {
    fail(422, 'INVALID_CONTENT', '留言请填写 2～500 个字。');
  }
  if (CONTROL_CHARACTERS.test(nickname + content)) fail(422, 'INVALID_CHARACTERS', '请去掉留言中的异常字符后重试。');
  if (URL_PATTERN.test(nickname + '\n' + content)) fail(422, 'LINKS_NOT_ALLOWED', '这里暂不接受网址，请留下文字就好。');
  // HTML is intentionally plain text. The client renders it with textContent.
  return { nickname, content };
}

function present(row) {
  return { id: row.id, nickname: row.nickname, content: row.content, createdAt: new Date(row.created_at).toISOString() };
}

function encodeCursor(row) {
  return encodeBase64Url(encoder.encode(JSON.stringify([row.created_at, row.id])));
}

function parseCursor(raw) {
  if (!raw) return null;
  try {
    if (raw.length > 200) throw new Error('Too large');
    const cursor = JSON.parse(new TextDecoder().decode(decodeBase64Url(raw)));
    if (!Array.isArray(cursor) || cursor.length !== 2 || !Number.isSafeInteger(cursor[0]) || cursor[0] < 0 || typeof cursor[1] !== 'string' || !/^[0-9a-f-]{36}$/u.test(cursor[1])) throw new Error('Invalid cursor');
    return cursor;
  } catch {
    fail(400, 'INVALID_CURSOR', '页码已失效，请刷新留言列表。');
  }
}

async function listMessages(request, env) {
  requireDatabase(env);
  const cursor = parseCursor(new URL(request.url).searchParams.get('cursor'));
  const query = cursor
    ? env.DB.prepare('SELECT id, nickname, content, created_at FROM messages WHERE created_at < ? OR (created_at = ? AND id < ?) ORDER BY created_at DESC, id DESC LIMIT ?').bind(cursor[0], cursor[0], cursor[1], PAGE_SIZE + 1)
    : env.DB.prepare('SELECT id, nickname, content, created_at FROM messages ORDER BY created_at DESC, id DESC LIMIT ?').bind(PAGE_SIZE + 1);
  const [data, count] = await Promise.all([query.all(), env.DB.prepare('SELECT COUNT(*) AS total FROM messages').first()]);
  const rows = data.results || [];
  const page = rows.slice(0, PAGE_SIZE);
  return json({ messages: page.map(present), nextCursor: rows.length > PAGE_SIZE ? encodeCursor(page[page.length - 1]) : null, total: Number(count?.total || 0) });
}

async function postMessage(request, env) {
  requireSameOrigin(request, true);
  requireDatabase(env);
  const secret = secretFor(env);
  const body = await readBoundedJson(request);
  const { nickname, content } = validateMessage(body);
  const now = Date.now();
  const session = await verifySession(body.token, request, secret, now);
  const contentHash = encodeBase64Url(await hmac(secret, 'guestbook-content:' + content));
  const id = crypto.randomUUID();
  // All limit checks and the insert are one SQLite write statement, so two
  // parallel submissions cannot both pass an earlier read-then-write check.
  const row = await env.DB.prepare(`INSERT INTO messages (id, nickname, content, created_at, client_hash, content_hash, session_nonce)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (SELECT 1 FROM messages WHERE client_hash = ? AND created_at > ?)
      AND (SELECT COUNT(*) FROM messages WHERE client_hash = ? AND created_at > ?) < 10
      AND NOT EXISTS (SELECT 1 FROM messages WHERE client_hash = ? AND content_hash = ? AND created_at > ?)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE session_nonce = ?)
    RETURNING id, nickname, content, created_at`)
    .bind(id, nickname, content, now, session.client, contentHash, session.nonce,
      session.client, now - COOLDOWN_MS, session.client, now - 60 * 60 * 1000,
      session.client, contentHash, now - 24 * 60 * 60 * 1000, session.nonce)
    .first();
  if (!row) {
    // The first write may have succeeded while its response was lost. A still-
    // valid token can recover only that exact request, including after a race
    // with another submission of the same token. Never expose another client's
    // row or treat an edited nickname/message as a successful retry.
    const saved = await env.DB.prepare('SELECT id, nickname, content, created_at FROM messages WHERE session_nonce = ? AND client_hash = ? AND nickname = ? AND content = ? LIMIT 1')
      .bind(session.nonce, session.client, nickname, content).first();
    if (saved) return json({
      message: present(saved),
      cooldownSeconds: Math.max(0, Math.ceil((Number(saved.created_at) + COOLDOWN_MS - now) / 1000)),
      replayed: true,
    });
    const duplicate = await env.DB.prepare('SELECT id FROM messages WHERE client_hash = ? AND content_hash = ? AND created_at > ? LIMIT 1')
      .bind(session.client, contentHash, now - 24 * 60 * 60 * 1000).first();
    if (duplicate) fail(409, 'DUPLICATE_MESSAGE', '这句话已经留下过了，换一句再来吧。');
    fail(429, 'RATE_LIMITED', '发布得有些频繁，请稍后刷新表单再试。', 45);
  }
  return json({ message: present(row), cooldownSeconds: 45 }, 201);
}

export async function handleApi(request, env) {
  try {
    const path = new URL(request.url).pathname;
    if (path === '/api/session' && request.method === 'GET') return await createSession(request, env);
    if (path === '/api/messages' && request.method === 'GET') return await listMessages(request, env);
    if (path === '/api/messages' && request.method === 'POST') return await postMessage(request, env);
    if (path === '/api/messages' || path === '/api/session') {
      return json({ error: '暂不支持这种操作。', code: 'METHOD_NOT_ALLOWED' }, 405, { Allow: path === '/api/session' ? 'GET' : 'GET, POST' });
    }
    return json({ error: '没有找到这个地址。', code: 'NOT_FOUND' }, 404);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message, code: error.code }, error.status, error.retryAfter ? { 'Retry-After': String(error.retryAfter) } : {});
    }
    console.error('Guestbook request failed:', error instanceof Error ? error.message : 'unknown');
    return json({ error: '留言暂时没有送达，请稍后重试。', code: 'SERVICE_UNAVAILABLE' }, 503);
  }
}
