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

test('the exact custom domains can preflight, read and publish to the shared backend', async t => {
  const { env, advance } = environment(t);
  for (const origin of ['https://yangruoxuan.ltd', 'https://www.yangruoxuan.ltd']) {
    const cors = { Origin: origin, 'Sec-Fetch-Site': 'cross-site' };
    const preflight = await handleApi(req('/api/messages', 'OPTIONS', undefined, { ...cors, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }), env);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Content-Type');
    assert.equal(preflight.headers.get('Access-Control-Allow-Credentials'), null);
    const sessionResponse = await handleApi(req('/api/session', 'GET', undefined, cors), env);
    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionResponse.headers.get('Access-Control-Allow-Origin'), origin);
    const token = (await sessionResponse.json()).token;
    advance(46000);
    const response = await post(env, token, '来自自定义域名 ' + origin, {}, cors);
    // URL validation deliberately excludes links from messages.
    assert.equal(response.status, 422);
    const published = await post(env, token, origin.includes('www.') ? '从另一个入口留下。' : '从自定义域名留下。', {}, cors);
    assert.equal(published.status, 201);
    assert.equal(published.headers.get('Access-Control-Allow-Origin'), origin);
    const list = await handleApi(req('/api/messages', 'GET', undefined, cors), env);
    assert.equal(list.status, 200);
    assert.equal(list.headers.get('Access-Control-Allow-Origin'), origin);
    assert.ok((await list.json()).messages.length > 0);
  }
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 2);
});

test('custom domain access rejects lookalike origins and extra preflight permissions', async t => {
  const { env } = environment(t);
  for (const origin of ['https://yangruoxuan.ltd.evil.test', 'http://yangruoxuan.ltd', 'https://yangruoxuan.ltd:8443', 'null']) {
    const response = await handleApi(req('/api/messages', 'OPTIONS', undefined, { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    const token = await handleApi(req('/api/session', 'GET', undefined, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' }), env);
    assert.equal(token.status, 403);
  }
  for (const [method, header] of [['DELETE', 'content-type'], ['POST', 'authorization']]) {
    const response = await handleApi(req('/api/messages', 'OPTIONS', undefined, { Origin: 'https://yangruoxuan.ltd', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': header }), env);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('Access-Control-Allow-Headers'), null);
  }
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

test('atomic SQLite guards prevent parallel spam, new-token duplicates and edited token replay', async t => {
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

test('an identical valid-token retry recovers the original write with the remaining cooldown', async t => {
  const { env, advance } = environment(t);
  const token = await session(env);
  advance(2100);
  const original = await post(env, token, '原来的留言。', { nickname: '小杨' });
  assert.equal(original.status, 201);
  const first = await original.json();
  assert.equal(first.replayed, undefined);
  assert.equal(first.cooldownSeconds, 45);
  advance(12_300);
  const recovered = await post(env, token, '  原来的留言。  ', { nickname: ' 小杨 ' });
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { message: first.message, cooldownSeconds: 33, replayed: true });
  advance(33_000);
  const afterCooldown = await post(env, token, '原来的留言。', { nickname: '小杨' });
  assert.equal(afterCooldown.status, 200);
  assert.deepEqual(await afterCooldown.json(), { message: first.message, cooldownSeconds: 0, replayed: true });
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
  advance(15 * 60 * 1000);
  const expired = await post(env, token, '原来的留言。', { nickname: '小杨' });
  assert.equal(expired.status, 403);
  assert.deepEqual(await expired.json(), { error: '表单已过期，请刷新后重试。', code: 'INVALID_SESSION' });
});

test('parallel identical requests return the same stored message and insert only once', async t => {
  const { env, advance } = environment(t);
  const token = await session(env);
  advance(2100);
  const responses = await Promise.all([post(env, token, '同一条留言。'), post(env, token, '同一条留言。')]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 201]);
  const results = await Promise.all(responses.map(response => response.json()));
  assert.deepEqual(results[0].message, results[1].message);
  assert.equal(results.filter(result => result.replayed === true).length, 1);
  assert.ok(results.every(result => result.cooldownSeconds === 45));
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('retry recovery rejects changed bodies, changed authors and a different client', async t => {
  const { env, advance } = environment(t);
  const token = await session(env);
  advance(2100);
  assert.equal((await post(env, token, '已经留下的内容。')).status, 201);
  const changedContent = await post(env, token, '另一个内容。');
  assert.equal(changedContent.status, 429);
  assert.equal((await changedContent.json()).message, undefined);
  const changedNickname = await post(env, token, '已经留下的内容。', { nickname: '另一位作者' });
  assert.equal(changedNickname.status, 409);
  assert.equal((await changedNickname.json()).message, undefined);
  const otherClient = await post(env, token, '已经留下的内容。', {}, { 'CF-Connecting-IP': '192.0.2.2' });
  assert.equal(otherClient.status, 403);
  assert.deepEqual(await otherClient.json(), { error: '表单已过期，请刷新后重试。', code: 'INVALID_SESSION' });
  advance(46_000);
  assert.equal((await post(env, token, '过了冷却也不能修改旧请求。')).status, 429);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
});

test('a valid token cannot recover a nonce row owned by another client', async t => {
  const { env, advance } = environment(t);
  const token = await session(env);
  const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));
  const foreignId = '00000000-0000-4000-8000-000000000001';
  env.DB.sqlite.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    foreignId, '来访者', '相同文字。', Date.now(), 'another-client-hash', 'another-content-hash', payload.nonce,
  );
  advance(2100);
  const response = await post(env, token, '相同文字。');
  assert.equal(response.status, 429);
  const body = await response.text();
  assert.equal(body.includes(foreignId), false);
  assert.equal(JSON.parse(body).message, undefined);
  assert.equal(env.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 1);
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
