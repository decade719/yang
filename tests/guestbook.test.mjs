import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleApi, validateMessage } from '../worker/guestbook.js';

const ORIGIN = 'https://guestbook.example';
const SECRET = 'test-secret-not-for-production-0123456789-abcdef';
const migration = readFileSync(new URL('../migrations/0001_guestbook.sql', import.meta.url), 'utf8');

// D1's prepared-statement API backed by real SQLite, so the schema, parameter
// binding, pagination ordering and atomic INSERT guards are exercised together.
function database(t) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(migration);
  t.after(() => sqlite.close());
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let parameters = [];
      return {
        bind(...values) { parameters = values; return this; },
        async all() { return { results: statement.all(...parameters) }; },
        async first() { return statement.get(...parameters) ?? null; },
      };
    },
  };
}

function environment(t) {
  let now = 1_793_232_000_000;
  t.mock.method(Date, 'now', () => now);
  return {
    env: { DB: database(t), SIGNING_SECRET: SECRET },
    advance(milliseconds) { now += milliseconds; },
  };
}

function req(path, method = 'GET', body, headers = {}) {
  return new Request(ORIGIN + path, {
    method,
    headers: {
      ...(method === 'POST' ? { Origin: ORIGIN, 'Content-Type': 'application/json' } : {}),
      'CF-Connecting-IP': '192.0.2.1',
      ...headers,
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
}

async function session(env, headers = {}) {
  const response = await handleApi(req('/api/session', 'GET', undefined, headers), env);
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

async function post(env, token, content = '今天也是值得记录的一天。', extras = {}, headers = {}) {
  return handleApi(req('/api/messages', 'POST', { nickname: '来访者', content, website: '', token, ...extras }, headers), env);
}

test('missing database or signing secret never reports a successful write', async t => {
  assert.equal((await handleApi(req('/api/messages'), {})).status, 503);
  assert.equal((await handleApi(req('/api/session'), {})).status, 503);
  const env = { DB: database(t) };
  assert.equal((await handleApi(req('/api/session'), env)).status, 503);
  const response = await post(env, 'missing');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '留言服务还未准备好，请稍后再来。', code: 'SERVICE_UNAVAILABLE' });
});

test('empty shared database returns a genuine empty state', async t => {
  const { env } = environment(t);
  const response = await handleApi(req('/api/messages'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.deepEqual(await response.json(), { messages: [], nextCursor: null, total: 0 });
});

test('message persists in SQLite and is readable by a different visitor; HTML remains plain text', async t => {
  const { env, advance } = environment(t);
  const token = await session(env);
  advance(2100);
  const content = '<script>alert("hello")</script> 一切顺利';
  const response = await post(env, token, content, { nickname: '  小杨  ' });
  assert.equal(response.status, 201);
  const saved = (await response.json()).message;
  assert.equal(saved.nickname, '小杨');
  assert.equal(saved.content, content);
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(new Date(saved.createdAt).getTime(), Date.now());
  const visitorTwo = await handleApi(req('/api/messages', 'GET', undefined, { 'CF-Connecting-IP': '192.0.2.2' }), env);
  const list = await visitorTwo.json();
  assert.equal(list.total, 1);
  assert.deepEqual(list.messages, [saved]);
  const internal = env.DB.sqlite.prepare('SELECT * FROM messages').get();
  assert.notEqual(internal.client_hash, '192.0.2.1');
  assert.equal(JSON.stringify(internal).includes('192.0.2.1'), false);
});

test('validates Unicode length, whitespace, links, control characters and honeypot', async t => {
  const { env, advance } = environment(t);
  const token = await session(env);
  advance(2100);
  assert.equal(validateMessage({ nickname: '🙂'.repeat(24), content: '你好' }).nickname.length, 48);
  const cases = [
    { nickname: '' }, { nickname: 'x'.repeat(25) }, { nickname: '换\n行' },
    { nickname: '🙂'.repeat(25) }, { content: ' ' }, { content: 'a' },
    { content: '文'.repeat(501) }, { content: 'https://example.com' },
    { content: '访问 www.example.cn' }, { content: 'foo.xyz 你好' },
    { content: '正常\u0000字符' }, { content: '正常\u202e字符' },
    { website: 'robot' }, { content: null }, { nickname: 123 },
  ];
  for (const extra of cases) {
    const response = await post(env, token, '你好呀', extra);
    assert.ok([400, 422].includes(response.status), JSON.stringify(extra));
  }
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 0);
});

test('only same-origin JSON submissions are accepted', async t => {
  const { env, advance } = environment(t);
  const token = await session(env);
  advance(2100);
  assert.equal((await post(env, token, '你好呀', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(env, token, '你好呀', {}, { Origin: 'null' })).status, 403);
  assert.equal((await post(env, token, '你好呀', {}, { Origin: '' })).status, 403);
  assert.equal((await post(env, token, '你好呀', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post(env, token, '你好呀', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await handleApi(req('/api/session', 'GET', undefined, { Origin: 'https://evil.example' }), env)).status, 403);
});

test('minimum dwell time, expiry, signature and IP binding are enforced', async t => {
  const { env, advance } = environment(t);
  const token = await session(env);
  const tooFast = await post(env, token);
  assert.equal(tooFast.status, 429);
  assert.equal(tooFast.headers.get('Retry-After'), '2');
  advance(2100);
  assert.equal((await post(env, token.slice(0, -4) + 'xxxx')).status, 403);
  assert.equal((await post(env, token, undefined, {}, { 'CF-Connecting-IP': '192.0.2.2' })).status, 403);
  advance(15 * 60 * 1000);
  assert.equal((await post(env, token)).status, 403);
});

test('atomic SQLite guards prevent parallel spam, duplicates and token replay', async t => {
  const { env, advance } = environment(t);
  const tokenOne = await session(env);
  const tokenTwo = await session(env);
  advance(2100);
  const concurrent = await Promise.all([post(env, tokenOne, '第一句留言'), post(env, tokenTwo, '第二句留言')]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 429]);
  advance(46_000);
  assert.equal((await post(env, tokenOne, '复用相同表单令牌')).status, 429);
  const next = await session(env);
  advance(2100);
  assert.equal((await post(env, next, '第一句留言')).status, 409);
  assert.equal((await post(env, next, '不一样的下一句话')).status, 201);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

test('hourly limit is enforced independently of the short cooldown', async t => {
  const { env, advance } = environment(t);
  for (let i = 0; i < 10; i++) {
    const token = await session(env);
    advance(46_000);
    assert.equal((await post(env, token, `这是第 ${i} 条不同的留言。`)).status, 201);
  }
  const eleventh = await session(env);
  advance(46_000);
  assert.equal((await post(env, eleventh, '这是第十一条留言。')).status, 429);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 10);
});

test('cursor pagination is stable for identical timestamps and rejects malformed cursors', async t => {
  const { env } = environment(t);
  const insert = env.DB.sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 27; i++) {
    insert.run(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, '来访者', `留言 ${i}`, Date.now(), 'hash', `content-${i}`, `nonce-${i}`);
  }
  const one = await (await handleApi(req('/api/messages'), env)).json();
  assert.equal(one.messages.length, 12);
  assert.equal(one.total, 27);
  assert.ok(one.nextCursor);
  const two = await (await handleApi(req('/api/messages?cursor=' + one.nextCursor), env)).json();
  const three = await (await handleApi(req('/api/messages?cursor=' + two.nextCursor), env)).json();
  assert.equal(three.messages.length, 3);
  assert.equal(three.nextCursor, null);
  assert.equal(new Set([...one.messages, ...two.messages, ...three.messages].map(message => message.id)).size, 27);
  for (const cursor of ['not-json', '!', 'a'.repeat(201), btoa(JSON.stringify([-1, 'invalid']))]) {
    assert.equal((await handleApi(req('/api/messages?cursor=' + encodeURIComponent(cursor)), env)).status, 400);
  }
});

test('oversized or malformed bodies, unknown paths and unsupported methods return clear errors', async t => {
  const { env } = environment(t);
  assert.equal((await handleApi(req('/api/messages', 'POST', '{bad'), env)).status, 400);
  assert.equal((await handleApi(req('/api/messages', 'POST', 'x'.repeat(8193)), env)).status, 413);
  assert.equal((await handleApi(req('/api/messages', 'POST', '{}', { 'Content-Length': '9000' }), env)).status, 413);
  assert.equal((await handleApi(req('/api/messages', 'DELETE'), env)).status, 405);
  assert.equal((await handleApi(req('/api/unknown'), env)).status, 404);
  const badDb = { ...env, DB: { prepare() { throw new Error('private database detail'); } } };
  t.mock.method(console, 'error', () => {});
  const failed = await handleApi(req('/api/messages'), badDb);
  assert.equal(failed.status, 503);
  assert.equal((await failed.text()).includes('private database detail'), false);
});
