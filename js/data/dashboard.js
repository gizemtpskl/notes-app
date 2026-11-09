/**
 * dashboard.js: which widgets the dashboard shows, in what order and size, with their options.
 * No user interface. Stored in settings as homeBlocks: [{ id, on, size, options }].
 *   size     'normal' takes one column, 'wide' both, on a screen wide enough for two
 *   options  per widget, such as which list feeds it. See WIDGETS.
 */

export const WIDGETS = Object.freeze([
  { id: 'day', label: 'Your day' },
  { id: 'week', label: 'Your week', size: 'wide' },
  { id: 'journal', label: 'Journal check-in' },
  { id: 'inbox', label: 'Inbox' },
  { id: 'today', label: 'Today’s tasks', options: ['collection'], off: true },
  { id: 'schedule', label: 'Today’s schedule', off: true },
  { id: 'next7', label: 'Next 7 days', off: true },
  { id: 'course', label: 'Course review', options: ['collection'] },
  { id: 'habits', label: 'Habits', options: ['habits'] },
  { id: 'recent', label: 'Continue' },
  { id: 'pinned', label: 'Pinned notes' },
  { id: 'bored', label: 'Bored? Try this', options: ['collection'] },
  { id: 'watch', label: 'Tonight’s watch', options: ['collection'] },
  { id: 'onThisDay', label: 'On this day', options: ['includeJournal'] },
  { id: 'progress', label: 'Weekly progress', off: true },
  { id: 'nudge', label: 'Tidy-up and backup reminders', size: 'wide' },
  { id: 'favorites', label: 'Favorites', off: true },
  { id: 'views', label: 'Saved views', off: true },
]);

/** Your day and Your week cover these, so they start switched off. */
const COVERED = ['today', 'schedule', 'next7', 'progress'];

/** Which note type feeds a widget's "which list" option. */
export const WIDGET_TYPES = Object.freeze({
  today: 'checklist', course: 'course', bored: 'idea', watch: 'watchlist',
});

const SIZES = ['normal', 'wide'];

function clean(entry) {
  const known = WIDGETS.find((w) => w.id === entry?.id);
  if (!known) return null;
  const options = entry.options && typeof entry.options === 'object' && !Array.isArray(entry.options) ? { ...entry.options } : {};
  return {
    id: known.id,
    on: entry.on !== false,
    size: SIZES.includes(entry.size) ? entry.size : known.size ?? 'normal',
    options,
  };
}

/**
 * The layout in its chosen order. Widgets added by later versions appear after the widget they
 * follow in the default order, switched on unless they're extras.
 */
export function dashboardLayout(settings) {
  const saved = Array.isArray(settings?.homeBlocks) ? settings.homeBlocks.map(clean).filter(Boolean) : [];
  const layout = saved.filter((entry, i) => saved.findIndex((e) => e.id === entry.id) === i);
  // A layout saved before Your day and Your week existed: those two take over from the widgets
  // they cover, once. They're still there to switch back on.
  if (layout.length && !layout.some((w) => w.id === 'day')) {
    for (const widget of layout) if (COVERED.includes(widget.id)) widget.on = false;
  }
  WIDGETS.forEach((known, index) => {
    if (layout.some((b) => b.id === known.id)) return;
    const before = WIDGETS.slice(0, index).map((w) => w.id);
    let at = 0;
    layout.forEach((b, i) => {
      if (before.includes(b.id)) at = i + 1;
    });
    layout.splice(at, 0, {
      id: known.id, on: !known.off, size: known.size ?? 'normal', options: {},
    });
  });
  return layout;
}

export const defaultLayout = () => dashboardLayout({});

/** Moves a widget to a new position in the layout. Returns a new layout. */
export function moveWidget(layout, id, index) {
  const from = layout.findIndex((w) => w.id === id);
  if (from === -1) return layout;
  const next = [...layout];
  const [widget] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(index, next.length)), 0, widget);
  return next;
}

export function updateWidget(layout, id, patch) {
  return layout.map((w) => (w.id === id ? { ...w, ...patch, options: { ...w.options, ...patch.options } } : w));
}

/** "Good morning" and the rest, by the hour. */
export function greeting(hour) {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  if (hour >= 18 && hour < 23) return 'Good evening';
  return 'Hello, night owl';
}
