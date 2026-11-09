/**
 * journal.js: the journal page: streaks, on this day, mood trend, calendar and timeline.
 *
 * The mood chart follows the app's chart rules: one 2px line in a validated color, solid
 * hairline grid, gaps on days with no mood rather than an invented line across them, crosshair
 * and tooltip on hover and keyboard, and a table with the same values for anyone not using the chart.
 */
import { app } from '../context.js';
import { firstDayOfWeek, formatDay, monthGrid, parseDate, relativeDay, toDateStr } from '../data/dates.js';
import { MOODS } from '../data/fieldKinds.js';
import { averageMood, entryDate, entryMood, moodSeries, onThisDay, streaks, totalWords } from '../data/journal.js';
import { noteWords } from '../data/types.js';
import { snippet } from '../data/text.js';
import { fill, h, plural } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { newNote } from './actions.js';
import { emptyState } from './noteList.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const TIMELINE_PAGE = 60;

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  el.append(...children);
  return el;
}

const moodFor = (value) => MOODS[Math.round(value) - 1];

// -- Mood chart ---------------------------------------------------------------------------

export function moodChart() {
  const HEIGHT = 190;
  const margin = { top: 12, right: 12, bottom: 26, left: 34 };
  let series = [];
  let width = 640;
  let activeIndex = null;

  const tooltip = h('div', { class: 'chart-tooltip', hidden: true });
  const stage = h('div', {
    class: 'chart-stage',
    tabindex: '0',
    role: 'group',
    'aria-label': 'Mood chart. Use the left and right arrow keys to read each day.',
  });
  const el = h('div', { class: 'chart' }, stage, tooltip);

  const xFor = (i) => {
    const plot = width - margin.left - margin.right;
    return margin.left + (series.length > 1 ? (i / (series.length - 1)) * plot : plot / 2);
  };
  const yFor = (mood) => margin.top + ((5 - mood) / 4) * (HEIGHT - margin.top - margin.bottom);

  function draw() {
    const root = svg('svg', {
      viewBox: `0 0 ${width} ${HEIGHT}`, width, height: HEIGHT, role: 'img', 'aria-hidden': 'true', class: 'chart-svg',
    });

    for (const mood of MOODS) {
      root.append(svg('line', {
        class: 'chart-grid', x1: margin.left, x2: width - margin.right, y1: yFor(mood.value), y2: yFor(mood.value),
      }));
      const label = svg('text', { class: 'chart-emoji', x: margin.left - 10, y: yFor(mood.value) + 5, 'text-anchor': 'end' });
      label.textContent = mood.emoji;
      root.append(label);
    }

    const tickCount = width < 480 ? 3 : 5;
    for (let t = 0; t < tickCount; t += 1) {
      const i = Math.round((t / (tickCount - 1)) * (series.length - 1));
      let anchor = 'middle';
      if (t === 0) anchor = 'start';
      else if (t === tickCount - 1) anchor = 'end';
      const label = svg('text', {
        class: 'chart-tick', x: xFor(i), y: HEIGHT - 6, 'text-anchor': anchor,
      });
      label.textContent = formatDay(series[i].date, { month: 'short', day: 'numeric' });
      root.append(label);
    }

    // The line only joins neighbouring days. A day without a mood leaves a gap.
    let segment = '';
    series.forEach((point, i) => {
      if (point.mood === null) return;
      segment += `${series[i - 1]?.mood != null ? 'L' : 'M'}${xFor(i).toFixed(1)} ${yFor(point.mood).toFixed(1)} `;
    });
    if (segment) root.append(svg('path', { class: 'chart-line', d: segment }));

    // Dots show on every point when there is room, and always on points with no neighbours.
    const roomy = (width - margin.left - margin.right) / Math.max(series.length - 1, 1) >= 12;
    series.forEach((point, i) => {
      if (point.mood === null) return;
      const alone = series[i - 1]?.mood == null && series[i + 1]?.mood == null;
      if (roomy || alone) root.append(svg('circle', { class: 'chart-dot', cx: xFor(i), cy: yFor(point.mood), r: 4 }));
    });

    const crosshair = svg('line', {
      class: 'chart-crosshair', y1: margin.top, y2: HEIGHT - margin.bottom, visibility: 'hidden',
    });
    const activeDot = svg('circle', { class: 'chart-dot chart-dot-active', r: 5, visibility: 'hidden' });
    root.append(crosshair, activeDot);
    stage.replaceChildren(root);

    function show(index) {
      activeIndex = index;
      if (index === null) {
        crosshair.setAttribute('visibility', 'hidden');
        activeDot.setAttribute('visibility', 'hidden');
        tooltip.hidden = true;
        return;
      }
      const point = series[index];
      const x = xFor(index);
      crosshair.setAttribute('x1', x);
      crosshair.setAttribute('x2', x);
      crosshair.setAttribute('visibility', 'visible');
      if (point.mood === null) {
        activeDot.setAttribute('visibility', 'hidden');
      } else {
        activeDot.setAttribute('cx', x);
        activeDot.setAttribute('cy', yFor(point.mood));
        activeDot.setAttribute('visibility', 'visible');
      }
      const mood = point.mood === null ? null : moodFor(point.mood);
      fill(tooltip,
        h('strong', { class: 'chart-tooltip-value' }, mood ? `${mood.emoji} ${mood.label}` : 'No mood recorded'),
        h('span', { class: 'chart-tooltip-date' }, formatDay(point.date, { weekday: 'short', month: 'short', day: 'numeric' })));
      tooltip.hidden = false;
      const box = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(0, Math.min(x - box.width / 2, width - box.width))}px`;
      // Sits above the plot, unless that would cover the point being read.
      const pointY = point.mood === null ? HEIGHT : yFor(point.mood);
      tooltip.style.top = `${pointY < box.height + 10 ? pointY + 12 : 0}px`;
    }

    stage.onpointermove = (event) => {
      const rect = stage.getBoundingClientRect();
      const plot = width - margin.left - margin.right;
      const ratio = (event.clientX - rect.left - margin.left) / plot;
      show(Math.max(0, Math.min(series.length - 1, Math.round(ratio * (series.length - 1)))));
    };
    stage.onpointerleave = () => show(null);
    stage.onblur = () => show(null);
    stage.onkeydown = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      const from = activeIndex ?? series.length;
      show(Math.max(0, Math.min(series.length - 1, from + step)));
    };
  }

  const observer = new ResizeObserver((entries) => {
    const next = Math.round(entries[0].contentRect.width);
    if (next && next !== width && series.length) {
      width = next;
      activeIndex = null;
      tooltip.hidden = true;
      draw();
    }
  });
  observer.observe(el);

  return {
    el,
    setSeries(next) {
      series = next;
      width = Math.round(el.getBoundingClientRect().width) || width;
      draw();
    },
    destroy: () => observer.disconnect(),
  };
}

export function moodTable(series) {
  const rows = series.filter((p) => p.mood !== null).reverse();
  return h('details', { class: 'chart-table' },
    h('summary', null, 'Show as a table'),
    h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Mood'))),
      h('tbody', null, rows.map((point) => h('tr', null,
        h('td', null, formatDay(point.date)),
        h('td', null, `${moodFor(point.mood).emoji} ${moodFor(point.mood).label}`))))));
}

// -- Page ---------------------------------------------------------------------------------

export function journalView({ collectionId, type, target }) {
  const { db } = app;
  const today = toDateStr();
  const start = parseDate(today);
  let year = start.getFullYear();
  let month = start.getMonth();
  let selected = null;
  let subview = 'calendar';
  let range = 30;
  let timelineShown = TIMELINE_PAGE;

  const chart = moodChart();

  const getEntries = () => db.listNotes({ collectionId })
    .filter((note) => note.typeId === type.id)
    .sort((a, b) => entryDate(b).localeCompare(entryDate(a)) || b.created - a.created);

  const statsEl = h('div', { class: 'stat-row' });
  const onThisDayEl = h('div');
  const chartHead = h('div', { class: 'section-head' });
  const chartNote = h('div');
  const tableEl = h('div');
  const chartSection = h('section', { class: 'section journal-chart' }, chartHead, chartNote, chart.el, tableEl);
  const entriesEl = h('div');

  const newEntry = (date) => newNote({ ...target, typeId: type.id, fields: { date } });

  function openOrCreate(date, entries) {
    const existing = entries.find((note) => entryDate(note) === date);
    if (existing) app.navigate(`note/${existing.id}`);
    else newEntry(date);
  }

  function entryRow(note) {
    const mood = entryMood(note);
    const date = entryDate(note);
    return h('li', { class: 'entry-row' },
      h('a', { class: 'entry-link', href: `#/note/${encodeURIComponent(note.id)}` },
        h('time', { class: 'entry-date', datetime: date }, formatDay(date, { weekday: 'short', day: 'numeric' })),
        h('span', { class: 'entry-mood', title: mood ? MOODS[mood - 1].label : 'No mood' },
          mood ? h('span', { 'aria-hidden': 'true' }, MOODS[mood - 1].emoji) : null,
          mood ? h('span', { class: 'sr-only' }, MOODS[mood - 1].label) : null),
        h('span', { class: 'entry-text' },
          h('span', { class: 'entry-snippet' }, snippet(entrySnippet(note), 110) || note.title || 'Empty entry'),
          h('span', { class: 'entry-words' }, plural(noteWords(note, type), 'word')))));
  }

  function entrySnippet(note) {
    if (note.text) return note.text;
    for (const key of ['wentWell', 'wasHard', 'grateful']) {
      if (note.fields?.[key]) return String(note.fields[key]);
    }
    return '';
  }

  function renderStats(entries) {
    const { current, longest } = streaks(entries, today);
    const stat = (label, value, hint) => h('div', { class: 'stat' },
      h('span', { class: 'stat-value' }, value),
      h('span', { class: 'stat-label' }, label),
      hint && h('span', { class: 'stat-hint' }, hint));
    let hint = null;
    if (current > 0 && !entries.some((n) => entryDate(n) === today)) hint = 'Write today to keep it going';
    fill(statsEl,
      stat('Current streak', plural(current, 'day'), hint),
      stat('Longest streak', plural(longest, 'day')),
      stat('Entries', entries.length.toLocaleString()),
      stat('Words written', totalWords(entries, type).toLocaleString()));
  }

  function renderOnThisDay(entries) {
    const past = onThisDay(entries, today);
    fill(onThisDayEl, past.length > 0 && h('section', { class: 'on-this-day' },
      h('h2', { class: 'section-title' }, 'On this day'),
      h('ul', { class: 'entry-list' }, past.map((note) => {
        const years = Number(today.slice(0, 4)) - Number(entryDate(note).slice(0, 4));
        return h('li', { class: 'entry-row' },
          h('a', { class: 'entry-link', href: `#/note/${encodeURIComponent(note.id)}` },
            h('span', { class: 'entry-date' }, years === 1 ? '1 year ago' : `${years} years ago`),
            h('span', { class: 'entry-mood' }, entryMood(note) ? h('span', { 'aria-hidden': 'true' }, MOODS[entryMood(note) - 1].emoji) : null),
            h('span', { class: 'entry-text' }, h('span', { class: 'entry-snippet' }, snippet(entrySnippet(note), 110) || note.title))));
      }))));
  }

  function renderChart(entries) {
    const series = moodSeries(entries, range, today);
    const average = averageMood(series);
    const count = series.filter((p) => p.mood !== null).length;
    fill(chartHead,
      h('h2', { class: 'section-title' }, 'Mood',
        average !== null && h('span', { class: 'section-title-note' }, ` · average ${average.toFixed(1)} of 5 over ${plural(count, 'day')}`)),
      h('div', { class: 'tabs tabs-small', role: 'group', 'aria-label': 'Time range' },
        [30, 90].map((days) => h('button', {
          class: 'tab',
          type: 'button',
          'aria-pressed': String(range === days),
          onClick: () => {
            range = days;
            renderChart(getEntries());
          },
        }, `${days} days`))));
    const hasData = count > 0;
    chart.el.hidden = !hasData;
    fill(chartNote, !hasData && h('p', { class: 'empty-line' }, `No moods recorded in the last ${range} days. Choose a mood in an entry and it shows up here.`));
    if (hasData) chart.setSeries(series);
    fill(tableEl, hasData && moodTable(series));
  }

  function renderCalendar(entries) {
    const byDay = new Map();
    for (const note of entries) {
      const date = entryDate(note);
      byDay.set(date, [...(byDay.get(date) ?? []), note]);
    }
    const weekStart = firstDayOfWeek(db.getSettings().weekStart);
    const weeks = monthGrid(year, month, weekStart);
    const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const weekdayNames = weeks[0].map((date) => ({
      short: formatDay(date, { weekday: 'narrow' }), long: formatDay(date, { weekday: 'long' }),
    }));

    function shift(step) {
      const next = new Date(year, month + step, 1);
      year = next.getFullYear();
      month = next.getMonth();
      selected = null;
      renderEntries(getEntries());
    }

    const cell = (date) => {
      const notes = byDay.get(date) ?? [];
      const moods = notes.map(entryMood).filter(Boolean);
      const mood = moods.length ? moodFor(moods.reduce((a, b) => a + b, 0) / moods.length) : null;
      const inMonth = date.startsWith(monthPrefix);
      const classes = ['cal-day'];
      if (!inMonth) classes.push('is-outside');
      if (date === today) classes.push('is-today');
      if (date === selected) classes.push('is-selected');
      if (notes.length) classes.push('has-entry');
      let description = formatDay(date, { weekday: 'long', month: 'long', day: 'numeric' });
      if (date === today) description += ', today';
      if (notes.length) description += `, ${plural(notes.length, 'entry', 'entries')}`;
      if (mood) description += `, mood ${mood.label}`;
      return h('td', { role: 'gridcell' }, h('button', {
        class: classes.join(' '),
        type: 'button',
        dataset: { date },
        tabindex: date === (selected ?? (monthPrefix === today.slice(0, 7) ? today : `${monthPrefix}-01`)) ? '0' : '-1',
        'aria-label': description,
        'aria-pressed': String(date === selected),
        onClick: () => {
          selected = date;
          if (!inMonth) {
            const parsed = parseDate(date);
            year = parsed.getFullYear();
            month = parsed.getMonth();
          }
          renderEntries(getEntries());
          entriesEl.querySelector(`[data-date="${date}"]`)?.focus();
        },
      },
      h('span', { class: 'cal-num', 'aria-hidden': 'true' }, String(parseDate(date).getDate())),
      h('span', { class: 'cal-mark', 'aria-hidden': 'true' }, mood ? mood.emoji : (notes.length ? '•' : ''))));
    };

    const grid = h('table', {
      class: 'calendar',
      role: 'grid',
      'aria-label': formatDay(`${monthPrefix}-01`, { month: 'long', year: 'numeric' }),
      onKeydown: (event) => {
        const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (!steps[event.key] || !event.target.dataset?.date) return;
        event.preventDefault();
        const buttons = [...grid.querySelectorAll('.cal-day')];
        const next = buttons[buttons.indexOf(event.target) + steps[event.key]];
        if (next) {
          buttons.forEach((b) => b.setAttribute('tabindex', '-1'));
          next.setAttribute('tabindex', '0');
          next.focus();
        }
      },
    },
    h('thead', null, h('tr', null, weekdayNames.map((day) => h('th', { scope: 'col', 'aria-label': day.long }, day.short)))),
    h('tbody', null, weeks.map((week) => h('tr', null, week.map(cell)))));

    const chosen = selected ? byDay.get(selected) ?? [] : [];
    return h('div', { class: 'calendar-wrap' },
      h('div', { class: 'cal-head' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Previous month', onClick: () => shift(-1) }, icon('chevronLeft', 18)),
        h('h3', { class: 'cal-title', 'aria-live': 'polite' }, formatDay(`${monthPrefix}-01`, { month: 'long', year: 'numeric' })),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Next month', onClick: () => shift(1) }, icon('chevronRight', 18)),
        monthPrefix !== today.slice(0, 7) && h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            const now = parseDate(today);
            year = now.getFullYear();
            month = now.getMonth();
            selected = today;
            renderEntries(getEntries());
          },
        }, 'This month')),
      grid,
      selected && h('div', { class: 'cal-selected' },
        h('div', { class: 'section-head' },
          h('h3', { class: 'section-title' }, relativeDay(selected, today)),
          h('button', { class: 'btn btn-small', type: 'button', onClick: () => newEntry(selected) }, icon('plus', 14), chosen.length ? 'Another entry' : 'Write an entry')),
        chosen.length > 0 && h('ul', { class: 'entry-list' }, chosen.map(entryRow))));
  }

  function renderTimeline(entries) {
    if (!entries.length) return h('p', { class: 'empty-line' }, 'No entries yet.');
    const shown = entries.slice(0, timelineShown);
    const groups = [];
    for (const note of shown) {
      const key = entryDate(note).slice(0, 7);
      if (groups.at(-1)?.key !== key) groups.push({ key, notes: [] });
      groups.at(-1).notes.push(note);
    }
    return h('div', { class: 'timeline' },
      groups.map((group) => h('section', { class: 'timeline-month' },
        h('h3', { class: 'timeline-title' }, formatDay(`${group.key}-01`, { month: 'long', year: 'numeric' })),
        h('ul', { class: 'entry-list' }, group.notes.map(entryRow)))),
      entries.length > shown.length && h('button', {
        class: 'btn btn-more',
        type: 'button',
        onClick: () => {
          timelineShown += TIMELINE_PAGE;
          renderEntries(getEntries());
        },
      }, `Show more (${(entries.length - shown.length).toLocaleString()} left)`));
  }

  function renderEntries(entries) {
    fill(entriesEl,
      h('div', { class: 'section-head' },
        h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show entries as' },
          [['calendar', 'Calendar'], ['timeline', 'Timeline']].map(([id, label]) => h('button', {
            class: 'tab',
            type: 'button',
            'aria-pressed': String(subview === id),
            onClick: () => {
              subview = id;
              renderEntries(getEntries());
            },
          }, label)))),
      subview === 'calendar' ? renderCalendar(entries) : renderTimeline(entries));
  }

  const introEl = h('div');
  const contentEl = h('div', null, statsEl, onThisDayEl, chartSection, entriesEl);

  function refresh() {
    const entries = getEntries();
    const isEmpty = !entries.length;
    contentEl.hidden = isEmpty;
    fill(introEl,
      isEmpty
        ? emptyState({
          emoji: '📔',
          title: 'Start your journal',
          text: 'Entries here are private: they stay off your Home screen, and out of search once that arrives.',
          action: h('button', { class: 'btn btn-primary', type: 'button', onClick: () => newEntry(today) }, icon('edit', 16), 'Write today’s entry'),
        })
        : h('div', { class: 'journal-actions' },
          h('button', { class: 'btn btn-primary', type: 'button', onClick: () => openOrCreate(today, getEntries()) }, icon('edit', 16), 'Today’s entry'),
          h('span', { class: 'journal-private' }, icon('lock', 14), 'Private: not shown on Home')));
    if (isEmpty) return;
    renderStats(entries);
    renderOnThisDay(entries);
    renderChart(entries);
    renderEntries(entries);
  }

  const el = h('div', { class: 'journal' }, introEl, contentEl);
  refresh();

  return {
    el,
    refresh,
    /** The chart can only measure itself once it is on the page. */
    mounted: refresh,
    destroy: () => chart.destroy(),
  };
}
