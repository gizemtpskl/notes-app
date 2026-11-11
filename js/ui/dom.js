/**
 * dom.js: small helpers for building the interface without a framework.
 * Strings passed as children always become text nodes, so note titles can't inject markup.
 */

const PROPERTIES = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'readOnly', 'open', 'htmlFor', 'draggable']);

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props instanceof Node || typeof props === 'string' || typeof props === 'number' || Array.isArray(props)) {
    children.unshift(props);
  } else if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) {
        if (key === 'hidden' || key === 'disabled' || key === 'checked' || key === 'draggable') el[key] = false;
      } else if (key === 'class') {
        el.className = value;
      } else if (key === 'dataset') {
        // Missing values are left out instead of becoming the text "undefined".
        for (const [name, item] of Object.entries(value)) if (item != null) el.dataset[name] = item;
      } else if (key === 'cssVars') {
        for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value);
      } else if (PROPERTIES.has(key)) {
        el[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child);
  }
}

/**
 * Replaces an element's content. Use this instead of native replaceChildren, which would
 * print the word "false" for conditional children such as `isEmpty && element`.
 */
export function fill(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: filename, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** True when the keyboard is busy with text entry, so single-key shortcuts must stay quiet. */
export function isTyping(target = document.activeElement) {
  if (!target || target === document.body) return false;
  if (target.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
}

export function modKey(event) {
  return event.metaKey || event.ctrlKey;
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform ?? '');
export const modName = isMac ? '⌘' : 'Ctrl';
export const altName = isMac ? '⌥' : 'Alt';

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const longFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const fullFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' });

/** Compact date for lists: a time today, then a day, then a date with the year. */
export function shortDate(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  if (date.toDateString() === now.toDateString()) return timeFormat.format(date);
  return (date.getFullYear() === now.getFullYear() ? dayFormat : yearFormat).format(date);
}

export const longDate = (timestamp) => longFormat.format(new Date(timestamp));
export const fullDate = (timestamp) => fullFormat.format(new Date(timestamp));

export function plural(count, one, many = `${one}s`) {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Runs fn at most once per animation frame. */
export function frameThrottle(fn) {
  let scheduled = false;
  return (...args) => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...args);
    });
  };
}
