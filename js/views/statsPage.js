/**
 * statsPage.js: statistics. Only counts, computed here on this device.
 *
 * Charts follow the app's rules: one validated color, columns at most 24px wide with a rounded
 * top and a square base, hairline grid, tooltips on hover and keyboard, and a table with the same
 * numbers for anyone not using the chart.
 */
import { app } from '../context.js';
import { addDays, firstDayOfWeek, toDateStr } from '../data/dates.js';
import { startOfWeek, weekSummary } from '../data/timetable.js';
import { loadOccurrences } from './timetable.js';
import { averageMood, moodSeries, streaks } from '../data/journal.js';
import { niceScale, notesPerSpace, tasksPerWeek, watchedPerMonth } from '../data/stats.js';
import { fill, h, plural } from '../ui/dom.js';
import { moodChart, moodTable } from './journal.js';
import { emptyState } from './noteList.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLUMN_MAX = 24;
const COLUMN_RADIUS = 4;

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

/** A column with a rounded top and a square base. */
function columnPath(x, y, width, height) {
  const radius = Math.min(COLUMN_RADIUS, height, width / 2);
  return `M${x} ${y + height}V${y + radius}Q${x} ${y} ${x + radius} ${y}H${x + width - radius}Q${x + width} ${y} ${x + width} ${y + radius}V${y + height}Z`;
}

/** A column chart for one series. rows: [{ label, detail, value }] */
function columnChart({ rows, unit, ariaLabel }) {
  const HEIGHT = 190;
  const margin = {
    top: 12, right: 8, bottom: 26, left: 30,
  };
  let width = 640;
  let activeIndex = null;
  const tooltip = h('div', { class: 'chart-tooltip', hidden: true });
  const stage = h('div', {
    class: 'chart-stage', tabindex: '0', role: 'group', 'aria-label': `${ariaLabel}. Use the left and right arrow keys to read each column.`,
  });
  const el = h('div', { class: 'chart' }, stage, tooltip);

  const { top, ticks } = niceScale(Math.max(...rows.map((row) => row.value)));
  const yFor = (value) => margin.top + (1 - value / top) * (HEIGHT - margin.top - margin.bottom);

  function draw() {
    const band = (width - margin.left - margin.right) / rows.length;
    const columnWidth = Math.min(COLUMN_MAX, Math.max(3, band - 4));
    const root = svg('svg', {
      viewBox: `0 0 ${width} ${HEIGHT}`, width, height: HEIGHT, class: 'chart-svg', 'aria-hidden': 'true',
    });
    for (const tick of ticks) {
      root.append(svg('line', {
        class: 'chart-grid', x1: margin.left, x2: width - margin.right, y1: yFor(tick), y2: yFor(tick),
      }));
      const label = svg('text', {
        class: 'chart-tick', x: margin.left - 8, y: yFor(tick) + 4, 'text-anchor': 'end',
      });
      label.textContent = tick.toLocaleString();
      root.append(label);
    }
    const xFor = (i) => margin.left + band * i + band / 2;
    const marks = rows.map((row, i) => {
      if (!row.value) return null;
      const height = yFor(0) - yFor(row.value);
      const mark = svg('path', { class: 'chart-column', d: columnPath(xFor(i) - columnWidth / 2, yFor(row.value), columnWidth, height) });
      root.append(mark);
      return mark;
    });
    // Every other label when they'd otherwise run together.
    const every = Math.ceil(46 / band);
    rows.forEach((row, i) => {
      if ((rows.length - 1 - i) % every === 0) {
        const label = svg('text', {
          class: 'chart-tick', x: xFor(i), y: HEIGHT - 6, 'text-anchor': 'middle',
        });
        label.textContent = row.label;
        root.append(label);
      }
    });
    stage.replaceChildren(root);

    function show(index) {
      if (activeIndex !== null) marks[activeIndex]?.classList.remove('is-active');
      activeIndex = index;
      if (index === null) {
        tooltip.hidden = true;
        return;
      }
      marks[index]?.classList.add('is-active');
      const row = rows[index];
      fill(tooltip,
        h('strong', { class: 'chart-tooltip-value' }, plural(row.value, unit)),
        h('span', { class: 'chart-tooltip-date' }, row.detail));
      tooltip.hidden = false;
      const box = tooltip.getBoundingClientRect();
      tooltip.style.left = `${Math.max(0, Math.min(xFor(index) - box.width / 2, width - box.width))}px`;
      tooltip.style.top = `${Math.max(0, yFor(row.value) - box.height - 8)}px`;
    }

    // The whole band answers to the pointer, not only the column, so low values are easy to hit.
    stage.onpointermove = (event) => {
      const rect = stage.getBoundingClientRect();
      const index = Math.floor((event.clientX - rect.left - margin.left) / band);
      show(index >= 0 && index < rows.length ? index : null);
    };
    stage.onpointerleave = () => show(null);
    stage.onblur = () => show(null);
    stage.onkeydown = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const step = event.key === 'ArrowLeft' ? -1 : 1;
      show(Math.max(0, Math.min(rows.length - 1, (activeIndex ?? rows.length) + step)));
    };
  }

  const observer = new ResizeObserver((entries) => {
    const next = Math.round(entries[0].contentRect.width);
    if (next && next !== width) {
      width = next;
      activeIndex = null;
      tooltip.hidden = true;
      draw();
    }
  });
  observer.observe(el);
  draw();

  return { el, destroy: () => observer.disconnect() };
}

function tableTwin(rows, head) {
  return h('details', { class: 'chart-table' },
    h('summary', null, 'Show as a table'),
    h('table', { class: 'data-table' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, head[0]), h('th', { scope: 'col' }, head[1]))),
      h('tbody', null, [...rows].reverse().map((row) => h('tr', null, h('td', null, row.detail ?? row.label), h('td', null, row.value.toLocaleString()))))));
}

/** Bars for categories. Every value is written beside its bar, so it needs no table. */
function spaceBars(rows) {
  const max = Math.max(1, ...rows.map((row) => row.value));
  return h('ul', { class: 'hbars' }, rows.map((row) => h('li', { class: 'hbar' },
    h('span', { class: 'hbar-label' }, row.label),
    h('span', { class: 'hbar-track' }, row.value > 0 && h('span', { class: 'hbar-fill', cssVars: { '--share': `${(row.value / max) * 100}%` } })),
    h('span', { class: 'hbar-value' }, row.value.toLocaleString()))));
}

export function statsPageView() {
  const { db } = app;
  const body = h('div', { class: 'stats' });
  const charts = [];

  const stat = (value, label) => h('div', { class: 'stat' }, h('span', { class: 'stat-value' }, value), h('span', { class: 'stat-label' }, label));
  const section = (title, sub, ...content) => h('section', { class: 'section stats-section' },
    h('h2', { class: 'section-title' }, title, sub && h('span', { class: 'section-title-note' }, ` · ${sub}`)),
    content);

  /** Hours on the timetable this week, by space. Every value is written beside its bar. */
  function timetableSection(today) {
    const from = startOfWeek(today, 1);
    const to = addDays(from, 6);
    const { bySpace } = weekSummary(loadOccurrences(db, from, to), { from, to });
    if (!bySpace.length) return null;
    const rows = bySpace.map((row) => {
      const space = row.spaceId && db.getSpace(row.spaceId);
      return { label: space ? `${space.icon} ${space.name}` : 'No space', value: Math.round(row.minutes / 6) / 10 };
    });
    return section('Timetable hours per space', 'this week, Monday to Sunday', spaceBars(rows), h('p', { class: 'field-hint' }, 'In hours.'));
  }

  function refresh() {
    charts.splice(0).forEach((chart) => chart.destroy());
    const today = toDateStr();
    const allNotes = db.listNotes({ status: 'all' }).filter((note) => !note.trashedAt);
    const journal = allNotes.filter((note) => note.typeId === 'journal');
    const { current, longest } = streaks(journal, today);
    const series = moodSeries(journal, 30, today);
    const average = averageMood(series);
    const tasks = tasksPerWeek(db, { today, weekStart: firstDayOfWeek(db.getSettings().weekStart) });
    const watched = watchedPerMonth(db, { today });
    const tasksDone = tasks.reduce((sum, row) => sum + row.value, 0);
    const watchedCount = watched.reduce((sum, row) => sum + row.value, 0);

    const taskChart = tasksDone > 0 ? columnChart({ rows: tasks, unit: 'task', ariaLabel: 'Tasks completed per week' }) : null;
    const watchChart = watchedCount > 0 ? columnChart({ rows: watched, unit: 'title', ariaLabel: 'Titles watched per month' }) : null;
    const mood = series.some((point) => point.mood !== null) ? moodChart() : null;
    charts.push(...[taskChart, watchChart, mood].filter(Boolean));

    fill(body,
      allNotes.length === 0 && emptyState({ emoji: '📊', title: 'Nothing to count yet', text: 'Numbers appear here as your notes grow.' }),
      allNotes.length > 0 && h('div', { class: 'stat-row' },
        stat(allNotes.length.toLocaleString(), 'Notes'),
        stat(tasksDone.toLocaleString(), 'Tasks done in 12 weeks'),
        stat(plural(current, 'day'), 'Journal streak'),
        stat(plural(longest, 'day'), 'Longest streak')),
      allNotes.length > 0 && section('Notes per space', null, spaceBars(notesPerSpace(db))),
      allNotes.length > 0 && section('Tasks completed per week', 'last 12 weeks',
        taskChart ? [taskChart.el, tableTwin(tasks, ['Week', 'Tasks'])] : h('p', { class: 'empty-line' }, 'Tick off some tasks, and each week adds up here.')),
      allNotes.length > 0 && section('Mood', average === null ? 'last 30 days' : `last 30 days, average ${average.toFixed(1)} of 5`,
        mood ? [mood.el, moodTable(series)] : h('p', { class: 'empty-line' }, 'Pick a mood in your journal entries to see a trend.')),
      timetableSection(today),
      allNotes.length > 0 && section('Watched per month', 'last 12 months',
        watchChart ? [watchChart.el, tableTwin(watched, ['Month', 'Titles'])] : h('p', { class: 'empty-line' }, 'Mark something Watched in a watchlist to see it here.')));
    // The mood chart needs to be on the page to know its width.
    mood?.setSeries(series);
  }

  return {
    title: 'Statistics',
    el: h('div', { class: 'page' },
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Statistics'),
        h('p', { class: 'page-sub' }, 'Counted here, on this device.')),
      body),
    mounted: refresh,
    update: (change) => {
      if (change.stores.has('notes') || change.stores.has('timeBlocks') || change.stores.has('semesters')) refresh();
    },
    destroy: () => charts.forEach((chart) => chart.destroy()),
  };
}
