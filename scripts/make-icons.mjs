#!/usr/bin/env node
// Renders app/icons/icon.svg into the PNG icons used by the manifest and iOS.
// Uses the Playwright + Chromium available on the machine (not a project dependency).
//
//   node scripts/make-icons.mjs
//
// icon.svg must contain a background element with id="bg" and the artwork in a group with
// id="mark", centred on the middle of a 512x512 viewBox. For the full-bleed variants the
// background is stretched to the whole square and the mark is scaled around the centre.

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICONS_DIR = join(ROOT, 'app', 'icons');
const SOURCE = join(ICONS_DIR, 'icon.svg');

/**
 * Output variants.
 * - fullBleed: square background without rounded corners (the OS applies its own mask).
 * - scale: size of the mark relative to the source artwork.
 * - opaque: paint the page with the background colour so no pixel is transparent.
 */
const VARIANTS = [
  { file: 'icon-192.png', size: 192, fullBleed: false, scale: 1, opaque: false },
  { file: 'icon-512.png', size: 512, fullBleed: false, scale: 1, opaque: false },
  // Maskable: the mark must stay inside the central safe circle (radius 40% of the size).
  { file: 'icon-maskable-512.png', size: 512, fullBleed: true, scale: 0.8, opaque: true },
  // iOS rounds the corners itself and shows transparency as black: keep it opaque.
  { file: 'apple-touch-icon.png', size: 180, fullBleed: true, scale: 1, opaque: true },
];

function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    console.error('Playwright est introuvable : ce script a besoin de « playwright » (avec Chromium) installé sur la machine.');
    process.exit(1);
  }
}

/** Page HTML holding the SVG inline, sized to `size` CSS pixels. */
function pageHtml(svg, size) {
  return `<!doctype html><html><head><style>
    html, body { margin: 0; padding: 0; background: transparent; }
    svg { display: block; width: ${size}px; height: ${size}px; }
  </style></head><body>${svg}</body></html>`;
}

async function render(page, svg, variant) {
  const { size, fullBleed, scale, opaque } = variant;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(pageHtml(svg, size));

  // Adjust the inline SVG for this variant; returns an error message if the source is malformed.
  const problem = await page.evaluate(({ fullBleed, scale, opaque }) => {
    const svgEl = document.querySelector('svg');
    const bg = svgEl && svgEl.querySelector('#bg');
    const mark = svgEl && svgEl.querySelector('#mark');
    if (!svgEl || !bg || !mark) return 'icon.svg doit contenir un élément #bg et un groupe #mark.';
    svgEl.setAttribute('width', '100%');
    svgEl.setAttribute('height', '100%');
    const [, , w, h] = (svgEl.getAttribute('viewBox') || '0 0 512 512').split(/[\s,]+/).map(Number);
    if (fullBleed) {
      bg.setAttribute('x', '0');
      bg.setAttribute('y', '0');
      bg.setAttribute('width', String(w));
      bg.setAttribute('height', String(h));
      bg.setAttribute('rx', '0');
      bg.setAttribute('ry', '0');
    }
    if (scale !== 1) {
      const cx = w / 2;
      const cy = h / 2;
      const existing = mark.getAttribute('transform') || '';
      mark.setAttribute('transform', `translate(${cx} ${cy}) scale(${scale}) translate(${-cx} ${-cy}) ${existing}`.trim());
    }
    if (opaque) {
      const fill = bg.getAttribute('fill') || '#000';
      document.documentElement.style.background = fill;
      document.body.style.background = fill;
    }
    return null;
  }, { fullBleed, scale, opaque });
  if (problem) throw new Error(problem);

  return page.screenshot({
    type: 'png',
    omitBackground: !opaque,
    clip: { x: 0, y: 0, width: size, height: size },
  });
}

async function main() {
  const { chromium } = loadPlaywright();
  const svg = (await readFile(SOURCE, 'utf8')).replace(/<\?xml[^>]*>\s*/, '');

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const variant of VARIANTS) {
      const png = await render(page, svg, variant);
      await writeFile(join(ICONS_DIR, variant.file), png);
      console.log(`✓ app/icons/${variant.file} (${variant.size}×${variant.size})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
