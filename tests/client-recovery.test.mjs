import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../guestbook.js', import.meta.url), 'utf8');
const message = {
  id: '00000000-0000-4000-8000-000000000001',
  nickname: '来访者', content: '留下一句话。', createdAt: '2026-10-29T12:00:00.000Z',
};
const page = { messages: [message], total: 1, nextCursor: null };
const session = { token: 'signed-form-token', expiresAt: '2026-10-29T12:15:00.000Z', minimumWaitMs: 2000 };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', ...headers },
});

function client(fetcher, options = {}) {
  const context = vm.createContext({
    document: { querySelector: () => null }, URL, Headers, AbortController,
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'guestbook.js' });
  const waits = [];
  const api = context.createGuestbookApi({
    fetcher, wait: async milliseconds => { waits.push(milliseconds); }, ...options,
  });
  return { api, waits };
}

test('static custom-domain frontend uses the shared backend URL without sending cookies', async () => {
  const requests = [];
  const baseURL = 'https://yang-ruoxuan-guestbook.spiffy-berry-3280.chatgpt.site';
  const { api } = client(async (path, options) => {
    requests.push({ path, options });
    return options.method === 'POST' ? json({ message, cooldownSeconds: 45 }, 201) : json(page);
  }, { baseURL });
  assert.deepEqual(await api('/api/messages?cursor=next'), page);
  const body = JSON.stringify({ nickname: '来访者', content: '同一个留言簿', token: 'signed-token' });
  await api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(requests[0].path, baseURL + '/api/messages?cursor=next');
  assert.equal(requests[1].path, baseURL + '/api/messages');
  assert.equal(requests[1].options.body, body);
  assert.equal(requests[1].options.headers.get('Content-Type'), 'application/json');
  assert.ok(requests.every(request => request.options.credentials === 'omit'));
});

test('GET recovers from an HTML gateway error and explicitly requests JSON', async () => {
  const requests = [];
  const { api, waits } = client(async (path, options) => {
    requests.push({ path, options });
    return requests.length === 1
      ? new Response('<html>Temporarily unavailable</html>', { status: 503, headers: { 'Content-Type': 'text/html' } })
      : json(page);
  });
  assert.deepEqual(await api('/api/messages'), page);
  assert.equal(requests.length, 2);
  assert.equal(waits.length, 1);
  for (const { path, options } of requests) {
    assert.equal(path, '/api/messages');
    assert.equal(options.headers.get('Accept'), 'application/json');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
  }
  assert.notEqual(requests[0].options.signal, requests[1].options.signal);
});

test('GET recovers a form session after a network disconnect', async () => {
  let calls = 0;
  const { api } = client(async () => {
    if (++calls === 1) throw new TypeError('Failed to fetch');
    return json(session);
  });
  assert.deepEqual(await api('/api/session'), session);
  assert.equal(calls, 2);
});

test('persistent gateway failures stop after three GET attempts', async () => {
  let calls = 0;
  const { api, waits } = client(async () => {
    calls++;
    return new Response('Gateway unavailable', { status: 502 });
  });
  await assert.rejects(api('/api/messages'), error => error.code === 'UNEXPECTED_RESPONSE' && error.status === 502);
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
});

test('an explicit application validation error is preserved and never retried', async () => {
  let calls = 0;
  const { api, waits } = client(async () => {
    calls++;
    return json({ error: '页码已失效。', code: 'INVALID_CURSOR' }, 400);
  });
  await assert.rejects(api('/api/messages?cursor=invalid'), error => error.code === 'INVALID_CURSOR' && error.status === 400 && error.message === '页码已失效。');
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('POST with a lost response is not automatically repeated', async () => {
  let calls = 0;
  const body = JSON.stringify({ nickname: message.nickname, content: message.content, token: 'signed-form-token', website: '' });
  const { api, waits } = client(async (path, options) => {
    calls++;
    assert.equal(path, '/api/messages');
    assert.equal(options.method, 'POST');
    assert.equal(options.body, body);
    assert.equal(options.headers.get('Content-Type'), 'application/json');
    assert.equal(options.headers.get('Accept'), 'application/json');
    throw new TypeError('Connection lost after the write');
  });
  await assert.rejects(api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }), error => error.code === 'NETWORK_ERROR');
  assert.equal(calls, 1);
  assert.deepEqual(waits, []);
});

test('a 200 response with the wrong payload cannot become an empty or successful list', async () => {
  let calls = 0;
  const { api } = client(async () => { calls++; return json({ ok: true }); });
  await assert.rejects(api('/api/messages'), error => error.code === 'UNEXPECTED_RESPONSE' && error.status === 200);
  assert.equal(calls, 3);
});

test('invalid form sessions are rejected before they can be used for a submission', async t => {
  for (const [label, data] of [
    ['empty token', { ...session, token: '' }],
    ['invalid expiry', { ...session, expiresAt: 'invalid' }],
    ['negative wait', { ...session, minimumWaitMs: -1 }],
    ['excessive wait', { ...session, minimumWaitMs: 10001 }],
  ]) {
    await t.test(label, async () => {
      const { api } = client(async () => json(data));
      await assert.rejects(api('/api/session'), error => error.code === 'UNEXPECTED_RESPONSE');
    });
  }
});

test('a server-confirmed manual retry accepts the original message and zero remaining cooldown', async () => {
  let calls = 0;
  const restored = { message, cooldownSeconds: 0, replayed: true };
  const { api } = client(async () => { calls++; return json(restored); });
  assert.deepEqual(await api('/api/messages', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }), restored);
  assert.equal(calls, 1);
});

test('a non-JSON access denial exposes a useful status instead of masquerading as a database failure', async () => {
  const { api } = client(async () => new Response('error code: 1010', { status: 403, headers: { 'Content-Type': 'text/plain' } }));
  await assert.rejects(api('/api/messages'), error => error.code === 'ACCESS_BLOCKED' && error.status === 403);
});

test('timed-out GET requests abort and stop at the retry limit', async () => {
  let calls = 0;
  const { api } = client(async (_path, options) => {
    calls++;
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('Aborted'); error.name = 'AbortError'; reject(error);
      }, { once: true });
    });
  }, { timeoutMs: 2 });
  await assert.rejects(api('/api/messages'), error => error.code === 'TIMEOUT');
  assert.equal(calls, 3);
});
