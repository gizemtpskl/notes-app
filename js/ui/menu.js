/**
 * menu.js: dropdown menu with full keyboard support (arrows, Home, End, Esc, type-ahead by first letter).
 *
 * items: [{ label, icon, onSelect, danger, disabled, checked }, 'separator', ...]
 */
import { h } from './dom.js';
import { icon } from './icons.js';

let closeCurrent = null;

export function openMenu(anchor, items, { label = 'Actions' } = {}) {
  closeCurrent?.();
  const previousFocus = document.activeElement;
  const buttons = [];

  const menu = h('div', { class: 'menu', role: 'menu', 'aria-label': label, tabindex: '-1' },
    items.filter(Boolean).map((item) => {
      if (item === 'separator') return h('div', { class: 'menu-sep', role: 'separator' });
      const button = h('button', {
        class: `menu-item${item.danger ? ' menu-item-danger' : ''}`,
        type: 'button',
        role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
        'aria-checked': item.checked === undefined ? null : String(item.checked),
        disabled: item.disabled,
        tabindex: '-1',
        onClick: () => {
          close();
          item.onSelect?.();
        },
      }, item.icon && icon(item.icon, 16), h('span', null, item.label));
      if (!item.disabled) buttons.push(button);
      return button;
    }));

  const focusAt = (index) => buttons[(index + buttons.length) % buttons.length]?.focus();

  function onKey(event) {
    const current = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown') focusAt(current + 1);
    else if (event.key === 'ArrowUp') focusAt(current - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(buttons.length - 1);
    else if (event.key === 'Escape') {
      close();
      previousFocus?.focus?.();
    } else if (event.key === 'Tab') {
      close();
      return;
    } else if (event.key.length === 1) {
      const letter = event.key.toLowerCase();
      const match = buttons.find((b) => b.textContent.trim().toLowerCase().startsWith(letter));
      match?.focus();
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function onOutside(event) {
    if (!menu.contains(event.target)) close();
  }

  function close() {
    menu.remove();
    document.removeEventListener('pointerdown', onOutside, true);
    window.removeEventListener('resize', close);
    closeCurrent = null;
  }

  menu.addEventListener('keydown', onKey);
  // Stays inside the opener's landmark, so assistive technology finds it in the right place.
  (anchor.closest('dialog, main, aside') ?? document.body).append(menu);

  const box = anchor.getBoundingClientRect();
  const { width, height } = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(box.left, innerWidth - width - 8))}px`;
  menu.style.top = `${box.bottom + 4 + height > innerHeight - 8 ? Math.max(8, box.top - height - 4) : box.bottom + 4}px`;

  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', close);
  closeCurrent = close;
  focusAt(0);
  return close;
}
