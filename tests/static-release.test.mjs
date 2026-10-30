import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareStaticSite } from '../scripts/prepare-static.mjs';

const files = ['styles.css', 'space.css', 'gallery.css', 'typography.css', 'guestbook.js', 'marquee.js', 'constellation.js', 'gallery.js'];
const helper = fileURLToPath(new URL('../scripts/prepare-static.mjs', import.meta.url));
const text = file => file.endsWith('.css') ? `/* ${file} */\r\nbody { color: #fff; }\r\n` : `// ${file}\r\nconsole.log('fixture');\r\n`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

async function fixture(t, html) {
  const tempParent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(tempParent, 'yang-static-release-'));
  t.after(async () => {
    assert.equal(path.dirname(root), tempParent);
    assert.ok(path.basename(root).startsWith('yang-static-release-'));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(files.map(file => writeFile(path.join(root, file), text(file), 'utf8')));
  const references = files.map(file => file.endsWith('.css') ? `<link rel="stylesheet" href="/${file}">` : `<script src="/${file}" defer></script>`).join('\r\n');
  await writeFile(path.join(root, 'index.html'), html ?? `<!doctype html>\r\n<head>\r\n${references}\r\n</head>\r\n<body>杨若璇</body>\r\n`, 'utf8');
  return root;
}

test('static release writes actual normalized fingerprint files and matching page/manifest', async t => {
  const root = await fixture(t);
  const release = await prepareStaticSite(root);
  assert.match(release.build, /^[a-f0-9]{12}$/);
  assert.deepEqual(release.assets.map(asset => asset.source), files);
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  for (const asset of release.assets) {
    const bytes = await readFile(path.join(root, asset.url.slice(1)));
    assert.equal(bytes.toString('utf8'), text(asset.source).replace(/\r\n/g, '\n'));
    assert.equal(asset.hash, digest(bytes));
    assert.ok(asset.url.includes(`.${asset.hash}.`));
    assert.ok(html.includes(`="${asset.url}"`));
    assert.equal(html.includes(`="/${asset.source}"`), false);
    assert.equal(await readFile(path.join(root, asset.source), 'utf8'), text(asset.source), 'canonical source is untouched');
  }
  assert.equal(html.includes('\r'), false);
  assert.equal((html.match(/name="app-build"/g) || []).length, 1);
  assert.ok(html.includes(`<meta name="app-build" content="${release.build}">`));
  assert.equal(await readFile(path.join(root, 'latest.html'), 'utf8'), html);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'site-release.json'), 'utf8')), release);
});

test('unchanged generation is idempotent even for a compact document and old build metadata', async t => {
  const root = await fixture(t, '<head><meta name="description" content="keep"><meta name="app-build" content="deadbeef"><script src="/guestbook.js"></script></head><body>same</body>');
  const first = await prepareStaticSite(root);
  const before = await readFile(path.join(root, 'index.html'), 'utf8');
  const second = await prepareStaticSite(root);
  assert.deepEqual(second, first);
  assert.equal(await readFile(path.join(root, 'index.html'), 'utf8'), before);
  assert.equal(await readFile(path.join(root, 'latest.html'), 'utf8'), before);
  assert.ok(before.includes('<meta name="description" content="keep">'));
  assert.equal(before.includes('content="deadbeef"'), false);
});

test('rewrites previous fingerprints and legacy references while preserving unrelated assets/meta', async t => {
  const root = await fixture(t, `<head>\n<meta name="app-build" content="manual-label">\n<link href='/assets/typography.012345abcdef.css' rel='stylesheet'>\n<script src = '/assets/guestbook.abcdef012345.js'></script>\n<script src="/marquee.js"></script>\n<script src="https://example.invalid/guestbook.js"></script>\n<script src="/other.js"></script>\n</head>`);
  await mkdir(path.join(root, 'assets'));
  await writeFile(path.join(root, 'assets/unrelated.txt'), 'keep unrelated');
  await writeFile(path.join(root, 'assets/guestbook.abcdef012345.js'), 'keep earlier fingerprint');
  const release = await prepareStaticSite(root);
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes(`href='${release.assets.find(asset => asset.source === 'typography.css').url}'`));
  assert.ok(html.includes(`src = '${release.assets.find(asset => asset.source === 'guestbook.js').url}'`));
  assert.ok(html.includes(`src="${release.assets.find(asset => asset.source === 'marquee.js').url}"`));
  assert.ok(html.includes('content="manual-label"'));
  assert.ok(html.includes('src="https://example.invalid/guestbook.js"'));
  assert.ok(html.includes('src="/other.js"'));
  assert.equal(await readFile(path.join(root, 'assets/unrelated.txt'), 'utf8'), 'keep unrelated');
  assert.equal(await readFile(path.join(root, 'assets/guestbook.abcdef012345.js'), 'utf8'), 'keep earlier fingerprint');
});

test('a source edit changes its URL and release while retaining previous files', async t => {
  const root = await fixture(t);
  const first = await prepareStaticSite(root);
  const oldGuestbook = first.assets.find(asset => asset.source === 'guestbook.js');
  await writeFile(path.join(root, 'guestbook.js'), '// updated cross-domain client\r\n', 'utf8');
  const second = await prepareStaticSite(root);
  const newGuestbook = second.assets.find(asset => asset.source === 'guestbook.js');
  assert.notEqual(second.build, first.build);
  assert.notEqual(newGuestbook.url, oldGuestbook.url);
  assert.equal(await readFile(path.join(root, oldGuestbook.url.slice(1)), 'utf8'), text('guestbook.js').replace(/\r\n/g, '\n'));
  assert.equal(await readFile(path.join(root, newGuestbook.url.slice(1)), 'utf8'), '// updated cross-domain client\n');
  for (const asset of first.assets.filter(asset => asset.source !== 'guestbook.js')) assert.deepEqual(second.assets.find(item => item.source === asset.source), asset);
  assert.equal((await readdir(path.join(root, 'assets'))).length, files.length + 1);
  assert.deepEqual(await prepareStaticSite(root), second);
});

test('HTML changes alter the build and the CLI prepares only its requested directory', async t => {
  const root = await fixture(t);
  const first = await prepareStaticSite(root);
  const html = await readFile(path.join(root, 'index.html'), 'utf8');
  await writeFile(path.join(root, 'index.html'), html.replace('杨若璇', '杨若璇的新照片'), 'utf8');
  const output = execFileSync(process.execPath, [helper, root], { encoding: 'utf8' });
  const second = JSON.parse(output);
  assert.notEqual(second.build, first.build);
  assert.deepEqual(second.assets, first.assets);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, 'site-release.json'), 'utf8')), second);
  assert.deepEqual(await prepareStaticSite(root), second);
});
