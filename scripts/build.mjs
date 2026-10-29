import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, '.openai/hosting.json'), 'utf8'));
if (!manifest.project_id || manifest.d1 !== 'DB') throw new Error('Missing Sites identity or D1 DB binding.');
const assets = {};
for (const [file, route, type] of [
  ['index.html', '/', 'text/html; charset=utf-8'],
  ['styles.css', '/styles.css', 'text/css; charset=utf-8'],
  ['guestbook.js', '/guestbook.js', 'text/javascript; charset=utf-8'],
  ['marquee.js', '/marquee.js', 'text/javascript; charset=utf-8'],
  ['languages.json', '/languages.json', 'application/json; charset=utf-8'],
  ['favicon.svg', '/favicon.svg', 'image/svg+xml']
]) assets[route] = { body: await readFile(path.join(root, file), 'utf8'), type };
const api = await readFile(path.join(root, 'worker/guestbook.js'), 'utf8');
const source = (await readFile(path.join(root, 'worker/index.js'), 'utf8'))
  .replace("import { handleApi } from './guestbook.js';", api)
  .replace('/*__STATIC_ASSETS__*/ {}', JSON.stringify(assets));
await mkdir(path.join(root, 'dist/server'), { recursive: true });
await mkdir(path.join(root, 'dist/.openai'), { recursive: true });
await writeFile(path.join(root, 'dist/server/index.js'), source);
await copyFile(path.join(root, '.openai/hosting.json'), path.join(root, 'dist/.openai/hosting.json'));
console.log('Built guestbook Worker with 6 embedded assets; legacy games and media preserved in source.');
