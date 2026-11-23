// Small inline stroke icons (24×24 grid, drawn with currentColor).

const SVG_NS = 'http://www.w3.org/2000/svg';

const PATHS = {
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  more:
    '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/>' +
    '<circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>' +
    '<circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M6 12h12"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.83 2.83 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  // Two stacked cards — « Réviser » tab.
  review:
    '<rect x="3" y="7" width="13" height="14" rx="2"/><path d="M7 3.5h11a2 2 0 0 1 2 2V17"/>',
  folder:
    '<path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7l-2-3H5a2 2 0 0 0-2 2Z"/>',
  folderMove:
    '<path d="M3 7.5V18a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-7l-2-3H5a2 2 0 0 0-2 2Z"/><path d="M10 14h5m-2-2 2 2-2 2"/>',
  database:
    '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  camera:
    '<path d="M14.5 4.5h-5L7.5 7H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2.5l-2-2.5Z"/><circle cx="12" cy="13" r="3.5"/>',
  image:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.5-3.5a2 2 0 0 0-2.8 0L6 21"/>',
  mic: '<rect x="9" y="2.5" width="6" height="12" rx="3"/><path d="M19 10.5a7 7 0 0 1-14 0"/><path d="M12 17.5V21"/>',
  volume:
    '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
  trash:
    '<path d="M4 7h16"/><path d="M18 7v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  upload:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
  share:
    '<path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5"/>',
  paste:
    '<rect x="8" y="2.5" width="8" height="4" rx="1"/><path d="M16 4.5h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2"/>',
  file: '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8Z"/><path d="M14 2.5V8h5.5"/>',
  sparkle:
    '<path d="M12 3.5 13.8 9a1.5 1.5 0 0 0 1 1l5.2 1.8-5.2 1.8a1.5 1.5 0 0 0-1 1L12 20l-1.8-5.4a1.5 1.5 0 0 0-1-1L4 11.8 9.2 10a1.5 1.5 0 0 0 1-1Z"/>',
  shuffle:
    '<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>',
  list: '<path d="M10 6h10M10 12h10M10 18h10"/><path d="m3.5 6 1.2 1.2L7 5M3.5 12l1.2 1.2L7 11M3.5 18l1.2 1.2L7 17"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  shield: '<path d="M12 21.5s8-3.6 8-9.5V5.5l-8-3-8 3V12c0 5.9 8 9.5 8 9.5Z"/>',
  alert: '<circle cx="12" cy="12" r="9.5"/><path d="M12 7.5v5M12 16.2v.3"/>',
  info: '<circle cx="12" cy="12" r="9.5"/><path d="M12 11v5.5M12 7.8v.3"/>',
  checkCircle: '<circle cx="12" cy="12" r="9.5"/><path d="m8 12.5 2.8 2.8L16.5 9.5"/>',
  play: '<path d="M7 4.5v15l12.5-7.5Z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
  calendar:
    '<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
};

/** Build an inline SVG icon element. */
export function icon(name, { size = 22, className = '', strokeWidth = 1.8 } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon${className ? ` ${className}` : ''}`);
  svg.innerHTML = PATHS[name] || '';
  return svg;
}
