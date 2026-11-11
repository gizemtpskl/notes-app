/**
 * icons.js: one consistent inline SVG icon set. 24 x 24 grid, 1.75 stroke, no network requests.
 */
const PATHS = {
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
  inbox: '<path d="M4 13l2.5-8h11L20 13"/><path d="M4 13v6h16v-6h-5l-1.5 2.5h-3L9 13z"/>',
  star: '<path d="M12 4l2.4 5 5.6.8-4 3.9.9 5.5-4.9-2.6-4.9 2.6.9-5.5-4-3.9 5.6-.8z"/>',
  archive: '<rect x="3.5" y="5" width="17" height="4" rx="1"/><path d="M5.5 9v10h13V9"/><path d="M10 13h4"/>',
  trash: '<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5.5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="18.5" cy="12" r="1.2" fill="currentColor"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  pin: '<path d="M9 4h6l-1 6 3.5 4h-11L10 10z"/><path d="M12 14v6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  pause: '<path d="M8.5 5.5v13M15.5 5.5v13"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  target: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="0.8"/>',
  move: '<path d="M4 7h6l2 2h8v9.5H4z"/><path d="M10 14h5M13 11.5l2.5 2.5-2.5 2.5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5"/><path d="M5 20h14"/>',
  upload: '<path d="M12 16V5M7 9l5-5 5 5"/><path d="M5 20h14"/>',
  restore: '<path d="M4 12a8 8 0 1 0 2.5-5.8L4 8.5"/><path d="M4 4v4.5h4.5"/>',
  focus: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  sparkle: '<path d="M12 4l1.8 5.2L19 11l-5.2 1.8L12 18l-1.8-5.2L5 11l5.2-1.8z"/>',
  skip: '<path d="M5 6l8 6-8 6z"/><path d="M18 6v12"/>',
  folder: '<path d="M4 6.5h6l2 2h8V19H4z"/>',
  note: '<path d="M6 3.5h8l4 4V20.5H6z"/><path d="M14 3.5V8h4"/><path d="M9 13h6M9 16.5h6"/>',
  bold: '<path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M10 5h7M7 19h7M14 5l-4 14"/>',
  strike: '<path d="M4 12h16"/><path d="M16.5 7.5C16 6 14.3 5 12 5 9.5 5 7.5 6.2 7.5 8.3c0 1.5 1 2.6 3 3.2M8 16.5C8.5 18 10 19 12.2 19c2.6 0 4.3-1.3 4.3-3.3 0-.8-.2-1.4-.6-1.9"/>',
  code: '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  codeBlock: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M10 9.5L7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  listBullet: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><circle cx="4.75" cy="6.5" r="1" fill="currentColor"/><circle cx="4.75" cy="12" r="1" fill="currentColor"/><circle cx="4.75" cy="17.5" r="1" fill="currentColor"/>',
  listNumber: '<path d="M10 6.5h10M10 12h10M10 17.5h10"/><path d="M4 5l1.5-.8V9M3.8 14.3c.3-.8 2.2-.9 2.2.4 0 1-2.2 1.800-2.200 3.300H6.200"/>',
  listCheck: '<rect x="3.5" y="5" width="5.500" height="5.500" rx="1"/><path d="M4.800 16.500l1.300 1.300 2.400-2.800"/><path d="M12 7.750h8.500M12 16.500h8.500"/>',
  quote: '<path d="M10 7H5.500v5.500H9c0 2-1 3.200-3 4M19 7h-4.500v5.500H18c0 2-1 3.200-3 4"/>',
  table: '<rect x="3.500" y="5" width="17" height="14" rx="1.500"/><path d="M3.500 10h17M3.500 14.500h17M9.500 5v14M15 5v14"/>',
  image: '<rect x="3.500" y="5" width="17" height="14" rx="1.500"/><circle cx="8.500" cy="10" r="1.500"/><path d="M4 17l5-4.500 3.500 3 3-2.500 4.500 4"/>',
  divider: '<path d="M4 12h16"/><path d="M8 6.500h8M8 17.500h8" opacity=".35"/>',
  paragraph: '<path d="M18 5v14M14 5v14M18 5h-7.500a4.500 4.500 0 0 0 0 9H14"/>',
  addRow: '<rect x="3.500" y="4.500" width="17" height="9" rx="1.500"/><path d="M3.500 9h17M12 4.500v9M12 16.500v4.500M9.750 18.750h4.500"/>',
  addColumn: '<rect x="4.500" y="3.500" width="9" height="17" rx="1.500"/><path d="M9 3.500v17M4.500 12h9M16.500 12H21M18.750 9.750v4.500"/>',
  removeRow: '<rect x="3.500" y="4.500" width="17" height="9" rx="1.500"/><path d="M3.500 9h17M12 4.500v9M9.500 18.750h5"/>',
  removeColumn: '<rect x="4.500" y="3.500" width="9" height="17" rx="1.500"/><path d="M9 3.500v17M4.500 12h9M16.500 12H21"/>',
  external: '<path d="M14 5h5v5M19 5l-8 8"/><path d="M11 6H5v13h13v-6"/>',
  chevronLeft: '<path d="M14.500 6l-6 6 6 6"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1.500"/><rect x="13" y="4" width="7" height="7" rx="1.500"/><rect x="4" y="13" width="7" height="7" rx="1.500"/><rect x="13" y="13" width="7" height="7" rx="1.500"/>',
  columns: '<rect x="3.500" y="4" width="5" height="16" rx="1.500"/><rect x="10.500" y="4" width="5" height="10" rx="1.500"/><rect x="17.500" y="4" width="3" height="13" rx="1.200"/>',
  calendar: '<rect x="4" y="5.500" width="16" height="14.500" rx="2"/><path d="M4 10h16M8.500 3.500V7M15.500 3.500V7"/>',
  flag: '<path d="M6 21V4M6 4.500h11l-2.500 4 2.500 4H6"/>',
  repeat: '<path d="M17 3.500l3 3-3 3"/><path d="M4 11.500v-1a4 4 0 0 1 4-4h12"/><path d="M7 20.500l-3-3 3-3"/><path d="M20 12.500v1a4 4 0 0 1-4 4H4"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6.500" r="1.500"/><circle cx="15" cy="6.500" r="1.500"/><circle cx="9" cy="12" r="1.500"/><circle cx="15" cy="12" r="1.500"/><circle cx="9" cy="17.500" r="1.500"/><circle cx="15" cy="17.500" r="1.500"/></g>',
  bolt: '<path d="M13 3L5.500 13.500H12L11 21l7.500-10.500H12z"/>',
  lock: '<rect x="5.500" y="10.500" width="13" height="10" rx="2"/><path d="M8.500 10.500V7.500a3.500 3.500 0 0 1 7 0v3"/>',
  shuffle: '<path d="M3.500 7h3.500c5 0 5 10 10 10h3.500"/><path d="M3.500 17h3.500c1.700 0 2.900-1.200 3.900-2.700M13 9.600C14 8.200 15.300 7 17 7h3.500"/><path d="M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  tag: '<path d="M4 4h7.500l8.500 8.500-7.500 7.500L4 11.500z"/><circle cx="8.500" cy="8.500" r="1.200" fill="currentColor"/>',
  filter: '<path d="M4 6h16M7.500 12h9M10.500 18h3"/>',
  bookmark: '<path d="M7 4h10v16.500l-5-3.500-5 3.500z"/>',
  timeline: '<path d="M7 4v16"/><circle cx="7" cy="8" r="2"/><circle cx="7" cy="16" r="2"/><path d="M12 8h8M12 16h8"/>',
  book: '<path d="M5 5.500A2.500 2.500 0 0 1 7.500 3H19v15H7.500A2.500 2.500 0 0 0 5 20.500z"/><path d="M5 20.500A2.500 2.500 0 0 0 7.500 21H19v-3"/>',
  search: '<circle cx="11" cy="11" r="6.500"/><path d="M20 20l-4.500-4.500"/>',
  sigma: '<path d="M18 5H7l6 7-6 7h11"/>',
  history: '<path d="M4 12a8 8 0 1 0 2.500-5.800L4 8.500"/><path d="M4 4v4.500h4.500"/><path d="M12 8v4.500l3 1.500"/>',
  template: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.500h16M10 9.500V20"/>',
  broom: '<path d="M19 4l-7.500 7.500"/><path d="M11.500 11.500l3 3c-1 3-3.500 5.500-7 5.500-1 0-2.500-.5-3.500-1.500 2 0 3-1 3.500-2.500l-2-1c1.500-3 3.500-4 6-3.500z"/>',
  chart: '<path d="M4 20V4M4 20h16"/><path d="M9 16v-5M14 16V8M19 16v-3"/>',
  copy: '<rect x="8.500" y="8.500" width="11.500" height="11.500" rx="2"/><path d="M15.500 8.500V5.500a1.500 1.500 0 0 0-1.500-1.500H5.500A1.500 1.500 0 0 0 4 5.500V14a1.500 1.500 0 0 0 1.500 1.500h3"/>',
};

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name, size = 18) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML = PATHS[name] ?? '';
  return svg;
}
