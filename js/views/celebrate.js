/**
 * celebrate.js: a short celebration when you reach a milestone, such as a week of journaling, a
 * weekly goal or everything due being done. See milestones() in data/wins.js for the list.
 *
 * Each milestone is celebrated once on this device. The ones already reached when this first
 * runs, and the ones that arrive by sync from another device, are recorded without a fuss.
 * Confetti is left out when the device asks for reduced motion, and Settings can turn it all off.
 */
import { app } from '../context.js';
import { toDateStr } from '../data/dates.js';
import { milestones, weekStartFrom } from '../data/wins.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const SEEN_KEY = 'celebrated';
const KEEP = 400;
const WAIT_MS = 700;
const SHOW_MS = 7000;
const WATCHED = ['notes', 'habits', 'focus', 'collections'];
const EMOJI = {
  journal: '📓', habit: '🔥', tasks: '✅', goal: '🎯', sent: '📨', focus: '⏱️',
};
const CONFETTI = ['--accent', '--c-sage', '--c-amber', '--c-sky', '--c-rose', '--c-plum', '--c-peach'];

let region = null;

function ensureRegion() {
  if (!region) {
    region = h('div', { class: 'celebrations', role: 'status', 'aria-live': 'polite' });
    document.body.append(region);
  }
  return region;
}

function confetti() {
  const box = h('div', { class: 'confetti', 'aria-hidden': 'true' });
  for (let i = 0; i < 36; i += 1) {
    const angle = (Math.PI * (0.15 + 0.7 * Math.random()));
    const distance = 160 + Math.random() * 220;
    box.append(h('span', {
      class: 'confetti-bit',
      cssVars: {
        '--x': `${Math.round(Math.cos(angle) * distance * (Math.random() < 0.5 ? -1 : 1))}px`,
        '--y': `${Math.round(Math.sin(angle) * distance)}px`,
        '--r': `${Math.round(Math.random() * 720 - 360)}deg`,
        '--delay': `${Math.round(Math.random() * 120)}ms`,
        '--bit': `var(${CONFETTI[i % CONFETTI.length]})`,
      },
    }));
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 1800);
}

/** Shows one milestone. `more` counts others reached at the same moment. */
export function celebrate(milestone, more = 0) {
  const box = ensureRegion();
  box.replaceChildren();
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    card.remove();
  };
  const card = h('div', { class: 'celebration' },
    h('span', { class: 'celebration-emoji', 'aria-hidden': 'true' }, EMOJI[milestone.kind] ?? '🎉'),
    h('p', { class: 'celebration-text' },
      h('strong', null, milestone.title),
      h('span', null, more ? `${milestone.text} And ${more} more.` : milestone.text)),
    h('button', {
      class: 'icon-btn', type: 'button', 'aria-label': 'Close', onClick: close,
    }, icon('close', 16)));
  box.append(card);
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) confetti();
  timer = setTimeout(close, SHOW_MS);
  card.addEventListener('pointerenter', () => clearTimeout(timer));
  card.addEventListener('focusin', () => clearTimeout(timer));
}

/** Watches for milestones. Returns the function that stops watching. */
export function startCelebrations() {
  const { db } = app;
  let timer = null;
  let byYou = false;
  const reached = () => milestones(db, { today: toDateStr(), weekStart: weekStartFrom(db.getSettings().weekStart) });

  // Whatever was reached before this device knew about celebrations counts as celebrated.
  if (!Array.isArray(db.getMeta(SEEN_KEY))) db.setMeta(SEEN_KEY, reached().map((m) => m.key));

  const check = () => {
    timer = null;
    const yours = byYou;
    byYou = false;
    const all = reached();
    const seen = db.getMeta(SEEN_KEY, []);
    const known = new Set(seen);
    const fresh = all.filter((m) => !known.has(m.key));
    if (!fresh.length) return;
    // Oldest first; when the list is long, keys no longer reached go first.
    let next = [...seen, ...fresh.map((m) => m.key)];
    if (next.length > KEEP) {
      const now = new Set(all.map((m) => m.key));
      const extra = next.length - KEEP;
      let dropped = 0;
      next = next.filter((key) => (dropped < extra && !now.has(key) ? (dropped += 1, false) : true));
    }
    db.setMeta(SEEN_KEY, next);
    if (yours && db.getSettings().celebrations !== false) celebrate(fresh[0], fresh.length - 1);
  };

  return db.on((change) => {
    if (!WATCHED.some((store) => change.stores.has(store))) return;
    if (change.source === 'local' && !change.synced) byYou = true;
    clearTimeout(timer);
    timer = setTimeout(check, WAIT_MS);
  });
}
