import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, '.openai/hosting.json'), 'utf8'));
if (!manifest.project_id || manifest.d1 !== 'DB') throw new Error('Missing Sites identity or D1 DB binding.');
const assets = {};
for (const [file, route, type] of [
  ['index.html', '/', 'text/html; charset=utf-8'],
  ['styles.css', '/styles.css', 'text/css; charset=utf-8'],
  ['space.css', '/space.css', 'text/css; charset=utf-8'],
  ['gallery.css', '/gallery.css', 'text/css; charset=utf-8'],
  ['guestbook.js', '/guestbook.js', 'text/javascript; charset=utf-8'],
  ['marquee.js', '/marquee.js', 'text/javascript; charset=utf-8'],
  ['constellation.js', '/constellation.js', 'text/javascript; charset=utf-8'],
  ['gallery.js', '/gallery.js', 'text/javascript; charset=utf-8'],
  ['photos.json', '/photos.json', 'application/json; charset=utf-8'],
  ['languages.json', '/languages.json', 'application/json; charset=utf-8'],
  ['favicon.svg', '/favicon.svg', 'image/svg+xml']
]) assets[route] = { body: await readFile(path.join(root, file), 'utf8'), type };
const photos = JSON.parse(assets['/photos.json'].body);
if (!Array.isArray(photos) || photos.length !== 6) throw new Error('Expected the six selected photos.');
for (const photo of photos) for (const route of [photo.src, photo.thumbnail]) {
  if (!/^\/photos\/(?:moment|thumb)-\d{2}-[a-f0-9]{10}\.webp$/.test(route)) throw new Error('Unexpected photo path.');
  const bytes = await readFile(path.join(root, route.slice(1)));
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 10);
  if (!route.endsWith(`-${hash}.webp`)) throw new Error('Photo hash no longer matches its filename.');
  assets[route] = { body: bytes.toString('base64'), encoding: 'base64', type: 'image/webp', cache: 'public, max-age=31536000, immutable' };
}
const api = await readFile(path.join(root, 'worker/guestbook.js'), 'utf8');
const source = (await readFile(path.join(root, 'worker/index.js'), 'utf8'))
  .replace("import { handleApi } from './guestbook.js';", api)
  .replace('/*__STATIC_ASSETS__*/ {}', JSON.stringify(assets));
await mkdir(path.join(root, 'dist/server'), { recursive: true });
await mkdir(path.join(root, 'dist/.openai'), { recursive: true });
await writeFile(path.join(root, 'dist/server/index.js'), source);
await copyFile(path.join(root, '.openai/hosting.json'), path.join(root, 'dist/.openai/hosting.json'));
console.log(`Built guestbook Worker with ${Object.keys(assets).length} embedded assets, including six optimized full-frame photos.`);
