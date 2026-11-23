// Checks that the service worker precache list (app/sw.js ASSETS) matches the files of app/,
// and that the PWA plumbing (manifest, index.html, module imports) only references precached files.
// A missing entry breaks offline use; an entry that does not exist breaks the SW install.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app');
const SW_FILE = join(APP_DIR, 'sw.js');

/** Every deployable file of app/ as './relative/path', skipping sw.js, dotfiles and '__*' dev harness dirs. */
function listAppFiles(dir = APP_DIR) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .DS_Store & co.
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('__')) continue; // temporary dev harnesses
      out.push(...listAppFiles(full));
    } else if (entry.isFile()) {
      const rel = relative(APP_DIR, full).split(sep).join('/');
      if (rel !== 'sw.js') out.push(`./${rel}`);
    }
  }
  return out.sort();
}

/** Evaluates sw.js in a sandbox (also proves it parses) and returns its VERSION and ASSETS. */
function loadServiceWorker() {
  const source = readFileSync(SW_FILE, 'utf8');
  const listeners = {};
  const sandbox = {
    URL,
    Request: class {},
    Response: class {},
    setTimeout,
    clearTimeout,
    self: {
      location: { href: 'https://example.test/app/sw.js', origin: 'https://example.test' },
      registration: { scope: 'https://example.test/app/' },
      addEventListener(type, fn) {
        listeners[type] = fn;
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}\n;globalThis.__sw = { VERSION, ASSETS };`, sandbox, { filename: 'sw.js' });
  return { ...sandbox.__sw, listeners };
}

/** Resolves a './x' or '../x' reference made from `fromAsset` (an './…' asset path) to an './…' asset path. */
function resolveRef(fromAsset, ref) {
  const clean = ref.split(/[?#]/)[0];
  const joined = posix.normalize(posix.join(posix.dirname(fromAsset.slice(2)), clean));
  return joined === '.' || joined === './' ? './' : `./${joined}`;
}

const sw = loadServiceWorker();
const assets = Array.from(sw.ASSETS);
const assetSet = new Set(assets);

test('sw.js declares VERSION and the lifecycle listeners', () => {
  assert.equal(typeof sw.VERSION, 'string');
  assert.match(sw.VERSION, /^recto-/);
  for (const type of ['install', 'activate', 'fetch']) {
    assert.equal(typeof sw.listeners[type], 'function', `missing "${type}" listener`);
  }
});

test('ASSETS entries are relative, unique and include the app shell', () => {
  assert.ok(Array.isArray(sw.ASSETS) && assets.length > 0, 'ASSETS must be a non-empty array');
  for (const entry of assets) {
    assert.equal(typeof entry, 'string');
    assert.ok(entry.startsWith('./'), `ASSETS entry must start with "./": ${entry}`);
    assert.ok(!entry.includes('//', 1) && !entry.includes('/../'), `ASSETS entry must be normalised: ${entry}`);
  }
  const duplicates = assets.filter((entry, i) => assets.indexOf(entry) !== i);
  assert.deepEqual(duplicates, [], 'ASSETS contains duplicates');
  assert.ok(assetSet.has('./'), 'ASSETS must include "./"');
  assert.ok(assetSet.has('./index.html'), 'ASSETS must include "./index.html"');
  assert.ok(!assetSet.has('./sw.js'), 'ASSETS must not include "./sw.js"');
});

test('every file of app/ (except sw.js) is precached', () => {
  const missing = listAppFiles().filter((file) => !assetSet.has(file));
  assert.deepEqual(missing, [], `add these files to ASSETS in app/sw.js:\n  ${missing.join('\n  ')}`);
});

test('every ASSETS entry exists in app/ (with the exact case)', () => {
  const files = new Set(listAppFiles());
  const absent = assets.filter((entry) => entry !== './' && !files.has(entry));
  assert.deepEqual(absent, [], `these ASSETS entries do not exist in app/:\n  ${absent.join('\n  ')}`);
  assert.ok(existsSync(join(APP_DIR, 'index.html')), 'app/index.html is required for "./"');
});

test('manifest.webmanifest is valid and its icons are precached', () => {
  const manifest = JSON.parse(readFileSync(join(APP_DIR, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.lang, 'fr');
  assert.ok(manifest.name && manifest.short_name, 'name and short_name are required');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'icons are required');
  for (const size of ['192x192', '512x512']) {
    assert.ok(manifest.icons.some((i) => i.sizes === size && i.type === 'image/png'), `missing ${size} PNG icon`);
  }
  assert.ok(manifest.icons.some((i) => /\bmaskable\b/.test(i.purpose || '')), 'missing maskable icon');
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), `icon URL must be relative: ${icon.src}`);
    const asset = resolveRef('./manifest.webmanifest', icon.src);
    assert.ok(assetSet.has(asset), `manifest icon not precached: ${icon.src}`);
  }
});

test('index.html only references relative, precached files', () => {
  const html = readFileSync(join(APP_DIR, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1]);
  assert.ok(refs.length > 0);
  for (const ref of refs) {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(ref)) continue; // absolute URLs, data:, anchors
    assert.ok(!ref.startsWith('/'), `index.html must use relative URLs (GitHub Pages sub-path): ${ref}`);
    assert.ok(assetSet.has(resolveRef('./index.html', ref)), `index.html references a file not in ASSETS: ${ref}`);
  }
});

test('JS modules only import precached files', () => {
  const problems = [];
  for (const asset of assets.filter((a) => a.endsWith('.js'))) {
    const file = join(APP_DIR, asset.slice(2));
    if (!existsSync(file) || !statSync(file).isFile()) continue; // reported by the existence test
    const code = readFileSync(file, 'utf8');
    const patterns = [
      /\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g, // import … from './x.js' / export … from './x.js'
      /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g, // import './x.js'
      /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g, // import('./x.js')
      /new\s+URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url\s*\)/g, // new URL('../x.css', import.meta.url)
    ];
    for (const pattern of patterns) {
      for (const [, ref] of code.matchAll(pattern)) {
        const target = resolveRef(asset, ref);
        if (!assetSet.has(target)) problems.push(`${asset} → ${ref}`);
      }
    }
  }
  assert.deepEqual(problems, [], `modules reference files that are not in ASSETS:\n  ${problems.join('\n  ')}`);
});
