import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../guestbook.js', import.meta.url), 'utf8');

test('initial page data renders messages even when a separate messages fetch cannot be delivered', async () => {
  class Node {
    constructor(tag = '') { this.tag = tag; this.value = ''; this.textContent = ''; this.children = []; this.dataset = {}; this.attrs = {}; this.events = {}; this.hidden = true; this.classList = { toggle() {} }; }
    setAttribute(name, value) { this.attrs[name] = value; }
    hasAttribute(name) { return name in this.attrs; }
    addEventListener(name, handler) { this.events[name] = handler; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = [...nodes]; }
  }
  const message = { id: '00000000-0000-4000-8000-000000000001', nickname: '来访者', content: '<img src=x onerror=alert(1)>', createdAt: '2026-10-29T14:46:32.619Z' };
  const nodes = new Map();
  const find = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Node());
    return nodes.get(selector);
  };
  find('#guestbook-bootstrap').textContent = JSON.stringify({ messages: [message], total: 1, nextCursor: null });
  const paths = [];
  const context = vm.createContext({
    document: { querySelector: find, createElement: tag => new Node(tag), documentElement: new Node(), addEventListener() {}, hidden: false },
    window: { addEventListener() {} }, navigator: { onLine: true },
    localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} },
    fetch: async path => {
      paths.push(path);
      if (path !== '/api/session') throw new TypeError('Messages transport unavailable');
      return new Response(JSON.stringify({ token: 'signed-test-token', expiresAt: new Date(Date.now() + 600000).toISOString(), minimumWaitMs: 2000 }), { headers: { 'Content-Type': 'application/json' } });
    },
    Response, Headers, URL, AbortController, Intl, setTimeout, clearTimeout, setInterval, clearInterval, console,
  });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  const list = find('#message-list');
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].tag, 'article');
  assert.equal(list.children[0].children.find(node => node.tag === 'p').textContent, message.content);
  assert.equal(find('.message-count').textContent, '1');
  assert.equal(find('#list-notice').hidden, true);
  assert.equal(list.attrs['aria-busy'], 'false');
  assert.equal(paths.includes('/api/messages'), false);
});
