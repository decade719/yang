import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { handleApi } from '../worker/guestbook.js';
import { securityHeaders } from '../worker/index.js';
const root = path.resolve(import.meta.dirname, '..');
await mkdir(path.join(root, '.data'), { recursive: true });
const sqlite = new DatabaseSync(path.join(root, '.data/messages.sqlite'));
sqlite.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'").get()) {
  sqlite.exec(await readFile(path.join(root, 'migrations/0001_guestbook.sql'), 'utf8'));
}
const db = { prepare(sql) { return { bind(...values) { const stmt = sqlite.prepare(sql); return { first: async () => stmt.get(...values) || null, all: async () => ({ results: stmt.all(...values) }), run: async () => stmt.run(...values) }; }, first: async () => sqlite.prepare(sql).get() || null, all: async () => ({ results: sqlite.prepare(sql).all() }) }; } };
const env = { DB: db, SIGNING_SECRET: process.env.SIGNING_SECRET || randomBytes(32).toString('hex') };
const files = { '/': ['index.html','text/html'], '/index.html': ['index.html','text/html'], '/styles.css': ['styles.css','text/css'], '/space.css': ['space.css','text/css'], '/guestbook.js': ['guestbook.js','text/javascript'], '/marquee.js': ['marquee.js','text/javascript'], '/constellation.js': ['constellation.js','text/javascript'], '/languages.json': ['languages.json','application/json'], '/favicon.svg': ['favicon.svg','image/svg+xml'] };
Object.assign(files, { '/gallery.css': ['gallery.css','text/css'], '/gallery.js': ['gallery.js','text/javascript'], '/photos.json': ['photos.json','application/json'] });
const photos = JSON.parse(await readFile(path.join(root, 'photos.json'), 'utf8'));
for (const photo of photos) for (const route of [photo.src, photo.thumbnail]) {
  if (!/^\/photos\/(?:moment|thumb)-\d{2}-[a-f0-9]{10}\.webp$/.test(route)) throw new Error('Unexpected photo path.');
  files[route] = [route.slice(1), 'image/webp'];
}
const port = Number(process.env.PORT) || 4173;
const server = http.createServer(async (req, res) => {
  try {
    const host = req.headers.host;
    if (!host || !new RegExp(`^(localhost|127\\.0\\.0\\.1):${port}$`).test(host)) { res.writeHead(403); res.end('Forbidden host'); return; }
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname.startsWith('/api/')) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      headers.delete('cf-connecting-ip');
      const request = new Request(url, { method: req.method, headers, ...(!['GET','HEAD'].includes(req.method) ? { body: req, duplex: 'half' } : {}) });
      const response = await handleApi(request, env);
      res.writeHead(response.status, { ...securityHeaders, ...Object.fromEntries(response.headers) }); res.end(Buffer.from(await response.arrayBuffer())); return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    const file = files[url.pathname];
    if (!file) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { ...securityHeaders, 'Content-Type': file[1] + (file[1].startsWith('image/') ? '' : '; charset=utf-8'), 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(path.join(root, file[0])));
  } catch (error) { console.error(error.message); res.writeHead(500); res.end('Temporary error'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Guestbook ready: http://127.0.0.1:${port} (persistent SQLite in .data/)`));
