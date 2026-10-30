import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['styles.css', 'space.css', 'gallery.css', 'typography.css', 'guestbook.js', 'marquee.js', 'constellation.js', 'gallery.js'];
const normalize = text => text.replace(/\r\n/g, '\n');
const fingerprint = text => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Prepare real, content-addressed files for hosts that serve this repository directly. */
export async function prepareStaticSite(root = repoRoot) {
  root = path.resolve(root);
  const [originalHtml, ...contents] = await Promise.all([
    readFile(path.join(root, 'index.html'), 'utf8'),
    ...sources.map(source => readFile(path.join(root, source), 'utf8')),
  ]);
  let html = normalize(originalHtml);
  if (!/<\/head\s*>/i.test(html)) throw new Error('Static index.html needs a closing head tag.');
  const assets = sources.map((source, index) => {
    const hash = fingerprint(normalize(contents[index]));
    const extension = path.extname(source);
    const stem = path.basename(source, extension);
    return { source, url: `/assets/${stem}.${hash}${extension}`, hash };
  });

  for (const asset of assets) {
    const extension = path.extname(asset.source);
    const stem = path.basename(asset.source, extension);
    const url = `(?:/${escapePattern(asset.source)}|/assets/${escapePattern(stem)}\\.[a-f0-9]{12}${escapePattern(extension)})`;
    const reference = new RegExp(`(\\b(?:src|href)\\s*=\\s*)(["'])${url}\\2`, 'gi');
    html = html.replace(reference, (_, attribute, quote) => `${attribute}${quote}${asset.url}${quote}`);
  }

  // Only this generator's hexadecimal app-build tags are removed. Other meta
  // tags, including non-generated app-build values, remain part of the page.
  html = html.replace(/(?:^[\t ]*)?<meta\s+name\s*=\s*(["'])app-build\1\s+content\s*=\s*(["'])[a-f0-9]+\2\s*\/?>[\t ]*(?:\n)?/gim, '');
  // Canonical head spacing makes insertion stable even for a one-line document.
  html = html.replace(/\s*<\/head\s*>/i, '\n</head>');
  const build = fingerprint(JSON.stringify({ assets, html }));
  html = html.replace('\n</head>', `\n  <meta name="app-build" content="${build}">\n</head>`);

  await mkdir(path.join(root, 'assets'), { recursive: true });
  await Promise.all(assets.map((asset, index) => writeFile(path.join(root, asset.url.slice(1)), normalize(contents[index]), 'utf8')));
  const release = { build, assets };
  // Keep earlier fingerprints: a page that is already open may still request one.
  await Promise.all([
    writeFile(path.join(root, 'index.html'), html, 'utf8'),
    writeFile(path.join(root, 'latest.html'), html, 'utf8'),
    writeFile(path.join(root, 'site-release.json'), JSON.stringify(release, null, 2) + '\n', 'utf8'),
  ]);
  return release;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/prepare-static.mjs [site-directory]');
  const release = await prepareStaticSite(process.argv[2] || repoRoot);
  process.stdout.write(JSON.stringify(release) + '\n');
}
