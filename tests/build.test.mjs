import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('../', import.meta.url));
const origin = 'https://guestbook.example';
let worker;
let html;
let css;
let client;

before(async () => {
  // Exercise the actual build from the current source, never a stale dist copy.
  execFileSync(process.execPath, ['scripts/build.mjs'], { cwd: root, stdio: 'pipe' });
  const source = await readFile(new URL('../dist/server/index.js', import.meta.url), 'utf8');
  worker = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
  assert.equal(typeof worker?.fetch, 'function');
  html = await (await worker.fetch(new Request(origin + '/'), {})).text();
  css = await (await worker.fetch(new Request(origin + '/styles.css'), {})).text();
  client = await (await worker.fetch(new Request(origin + '/guestbook.js'), {})).text();
});

test('built Worker serves its actual HTML, CSS, JavaScript and icon', async () => {
  for (const [route, type] of [['/', 'text/html'], ['/index.html', 'text/html'], ['/styles.css', 'text/css'], ['/guestbook.js', 'text/javascript'], ['/favicon.svg', 'image/svg+xml']]) {
    const response = await worker.fetch(new Request(origin + route), {});
    assert.equal(response.status, 200, route);
    assert.equal(response.headers.get('Content-Type').split(';')[0], type);
    assert.ok((await response.text()).length > 0, route);
  }
  assert.match(html, /给杨若璇的留言簿/);
  assert.match(html, /留下一些想说的话。/);
  assert.equal(await (await worker.fetch(new Request(origin + '/index.html'), {})).text(), html);
});

test('static resources reject writes and HEAD returns metadata without body', async () => {
  for (const route of ['/', '/styles.css', '/guestbook.js']) {
    const denied = await worker.fetch(new Request(origin + route, { method: 'POST', body: 'unexpected write' }), {});
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get('Allow'), 'GET, HEAD');
    const head = await worker.fetch(new Request(origin + route, { method: 'HEAD' }), {});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.ok(head.headers.get('Content-Type'));
  }
});

test('production response has a restrictive CSP and browser security headers', async () => {
  const response = await worker.fetch(new Request(origin + '/'), {});
  const csp = response.headers.get('Content-Security-Policy');
  for (const directive of ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"]) assert.ok(csp.includes(directive), directive);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Permissions-Policy'), /camera=\(\)/);
  assert.match(response.headers.get('Permissions-Policy'), /microphone=\(\)/);
});

test('unpublished legacy games, media and unknown routes give a genuine 404', async () => {
  for (const route of ['/missing', '/app.html', '/audio/click.mp3', '/.env', '/.data/messages.sqlite', '/api/unknown']) {
    const response = await worker.fetch(new Request(origin + route), {});
    assert.equal(response.status, 404, route);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  }
});

test('built API never reports success when production storage is unavailable', async () => {
  const cases = [
    new Request(origin + '/api/messages'),
    new Request(origin + '/api/session'),
    new Request(origin + '/api/messages', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: '访客', content: '测试留言', website: '', token: 'invalid' }) }),
  ];
  for (const request of cases) {
    const response = await worker.fetch(request, {});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    const body = await response.json();
    assert.equal(body.code, 'SERVICE_UNAVAILABLE');
    assert.equal(typeof body.error, 'string');
    assert.equal(body.message, undefined);
  }
});

test('generated production migrations execute in SQLite and match local schema constraints', async () => {
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  assert.ok(journal.entries.length > 0, 'deployment must include an applied schema migration');
  const productionSql = (await Promise.all(journal.entries.map(entry => readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8')))).join('\n');
  const localSql = await readFile(new URL('../migrations/0001_guestbook.sql', import.meta.url), 'utf8');
  const schemas = [];
  for (const [name, sql] of [['production', productionSql], ['local', localSql]]) {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec(sql);
      schemas.push(sqlite.prepare('PRAGMA table_info(messages)').all().map(column => [column.name, column.type.toUpperCase(), column.notnull, column.pk]));
      const insert = sqlite.prepare('INSERT INTO messages (id,nickname,content,created_at,client_hash,content_hash,session_nonce) VALUES (?,?,?,?,?,?,?)');
      insert.run('first', '🌿'.repeat(24), '可保存的留言', 1793232000000, 'client', 'content', 'unique-session');
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM messages').get().total, 1, name);
      assert.throws(() => insert.run('duplicate', '访客', '相同的令牌', 1793232000001, 'client', 'other', 'unique-session'), /UNIQUE constraint failed/, name);
      assert.throws(() => insert.run('bad-nick', '', '合法内容', 1793232000001, 'client', 'other', 'new-session'), /CHECK constraint failed/, name);
      assert.throws(() => insert.run('long-nick', '杨'.repeat(25), '合法内容', 1793232000001, 'client', 'other', 'new-session'), /CHECK constraint failed/, name);
      assert.throws(() => insert.run('short-content', '访客', '一', 1793232000001, 'client', 'other', 'new-session'), /CHECK constraint failed/, name);
      assert.throws(() => insert.run('long-content', '访客', '字'.repeat(501), 1793232000001, 'client', 'other', 'new-session'), /CHECK constraint failed/, name);
      assert.throws(() => insert.run('null-content', '访客', null, 1793232000001, 'client', 'other', 'new-session'), /NOT NULL constraint failed/, name);
      assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM messages').get().total, 1, name);
    } finally { sqlite.close(); }
  }
  assert.deepEqual(schemas[0], schemas[1], 'production and local columns must remain compatible');
});

test('form controls have unique IDs, labels, validation feedback and live status', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate HTML IDs');
  for (const id of ['message-form', 'nickname', 'message', 'website', 'nickname-error', 'message-error', 'character-count', 'form-status', 'message-list', 'list-notice']) assert.ok(ids.includes(id), id);
  for (const id of ['nickname', 'message', 'website']) assert.match(html, new RegExp(`<label[^>]*for="${id}"`));
  assert.match(html, /<input[^>]*id="nickname"[^>]*autocomplete="nickname"/);
  assert.match(html, /<textarea[^>]*id="message"[^>]*aria-describedby="message-error character-count"/);
  assert.match(html, /id="form-status"[^>]*role="status"/);
  assert.match(html, /id="message-list"[^>]*aria-live="polite"/);
  assert.match(html, /无需注册/);
});

test('untrusted messages are rendered as text with no HTML execution sinks', () => {
  assert.doesNotMatch(client, /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|document\.write\s*\(|\beval\s*\(|new\s+Function\s*\(/);
  assert.match(client, /\.textContent\s*=\s*message\.content/);
  assert.match(client, /\.textContent\s*=\s*message\.nickname/);
  assert.doesNotMatch(html, /\bon(?:click|load|error|submit|input)\s*=|javascript:/i);
  assert.doesNotMatch(html, /<audio\b|\bautoplay\b/i);
});

test('responsive CSS declares desktop, tablet and 320px coverage plus reduced motion', () => {
  // Structural checks only: these cannot prove rendered dimensions or visual quality.
  const breakpoints = [...css.matchAll(/@media\s*\(\s*max-width\s*:\s*(\d+)px\s*\)/g)].map(match => Number(match[1]));
  assert.ok(breakpoints.includes(1000), 'tablet/compact desktop rules');
  assert.ok(breakpoints.includes(760), 'single-column phone rules');
  assert.ok(breakpoints.some(width => width >= 320 && width <= 360), 'rules cover a 320px phone');
  assert.match(css, /@media\(max-width:760px\)[\s\S]*?\.guestbook-grid\{[^}]*flex-direction:column/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*?input,textarea\{[^}]*font-size:16px/);
  assert.match(css, /prefers-reduced-motion\s*:\s*reduce/);
  assert.match(css, /animation:none!important/);
  assert.match(html, /name="viewport"[^>]*width=device-width/);
  assert.doesNotMatch(html, /user-scalable=no|maximum-scale=1/);
});
