/**
 * tidyPage.js: the tidy-up assistant. Rules find things worth a look: near-duplicate titles, empty
 * notes, unused tags and notes not opened for a long time. Cleaning up takes one click, moves
 * notes to the Trash or Archive rather than deleting them, and can be undone.
 */
import { app } from '../context.js';
import { findDuplicateGroups, findEmptyNotes, findStaleNotes } from '../data/tidy.js';
import { displayTitle } from '../data/types.js';
import { fill, h, plural, shortDate } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { locationName, withUndo } from './actions.js';

const STALE_CHOICES = [
  { days: 90, label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: 'a year' },
  { days: 730, label: 'two years' },
];
const LIST_LIMIT = 20;

export function tidyPageView() {
  const { db } = app;
  const body = h('div');
  let staleDays = db.getMeta('ui', {}).tidyDays ?? 180;
  const typeOf = (id) => db.getType(id);
  const titleOf = (note) => displayTitle(note, typeOf(note.typeId)) || 'Untitled';

  const noteRow = (note, detail) => h('li', null,
    h('a', { class: 'link-row', href: `#/note/${encodeURIComponent(note.id)}` },
      h('span', { class: 'link-row-title' }, titleOf(note)),
      h('span', { class: 'link-row-where' }, detail ?? locationName(note))));

  const section = (title, count, hint, action, ...content) => h('section', { class: `tidy-section${count ? '' : ' is-clear'}` },
    h('div', { class: 'section-head' },
      h('h2', { class: 'tidy-title' },
        count ? null : h('span', { class: 'tidy-check', 'aria-hidden': 'true' }, icon('check', 14)),
        title,
        count > 0 && h('span', { class: 'review-step-count' }, count.toLocaleString())),
      count > 0 && action),
    h('p', { class: 'settings-text' }, count ? hint : 'All clear.'),
    count > 0 && content);

  const tooMany = (total) => total > LIST_LIMIT && h('p', { class: 'view-foot' }, `Showing ${LIST_LIMIT} of ${total.toLocaleString()}.`);

  function refresh() {
    // Pinned and favorite notes are wanted on purpose, and journal entries repeat by nature.
    const notes = db.listNotes();
    const groups = findDuplicateGroups(notes, typeOf);
    const empties = findEmptyNotes(notes, typeOf);
    const orphans = db.orphanTags();
    const stale = findStaleNotes(notes.filter((note) => !note.private), staleDays);
    const duplicates = groups.reduce((sum, group) => sum + group.length - 1, 0);
    const allClear = !groups.length && !empties.length && !orphans.length && !stale.length;

    fill(body,
      allClear && h('div', { class: 'callout' }, icon('check'), h('span', { class: 'callout-text' }, 'Everything looks tidy.')),
      section('Near-duplicate titles', duplicates,
        'These look like the same note. Keeping the newest moves the others to the Trash.',
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => {
            withUndo(`Moved ${plural(duplicates, 'duplicate')} to Trash`, () => db.trashNotes(groups.flatMap((group) => group.slice(1).map((n) => n.id))));
          },
        }, 'Keep the newest of each'),
        h('div', { class: 'tidy-groups' }, groups.slice(0, LIST_LIMIT).map((group) => h('div', { class: 'tidy-group', dataset: { id: group[0].id } },
          h('ul', { class: 'link-rows' }, group.map((note, index) => noteRow(note, index === 0 ? `Newest · ${shortDate(note.updated)}` : shortDate(note.updated)))),
          h('button', {
            class: 'btn-link',
            type: 'button',
            onClick: () => withUndo(`Moved ${plural(group.length - 1, 'note')} to Trash`, () => db.trashNotes(group.slice(1).map((n) => n.id))),
          }, 'Keep the newest')))),
        tooMany(groups.length)),
      section('Empty notes', empties.length,
        'Nothing is written in these.',
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => withUndo(`Moved ${plural(empties.length, 'note')} to Trash`, () => db.trashNotes(empties.map((n) => n.id))),
        }, `Move ${empties.length} to Trash`),
        h('ul', { class: 'link-rows' }, empties.slice(0, LIST_LIMIT).map((note) => noteRow(note))),
        tooMany(empties.length)),
      section('Unused tags', orphans.length,
        'No note uses these any more.',
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => withUndo(`Deleted ${plural(orphans.length, 'tag')}`, () => orphans.forEach((tag) => db.deleteTag(tag.id))),
        }, `Delete ${orphans.length}`),
        h('div', { class: 'recent-searches' }, orphans.map((tag) => h('span', { class: 'chip' }, `#${tag.name}`)))),
      section('Not opened for a while', stale.length,
        'Archiving hides these from your lists but keeps them searchable.',
        h('button', {
          class: 'btn btn-small',
          type: 'button',
          onClick: () => withUndo(`Archived ${plural(stale.length, 'note')}`, () => db.archiveNotes(stale.map((n) => n.id))),
        }, `Archive ${stale.length}`),
        h('ul', { class: 'link-rows' }, stale.slice(0, LIST_LIMIT).map((note) => noteRow(note, `Opened ${shortDate(note.opened ?? note.updated)}`))),
        tooMany(stale.length)));
  }

  refresh();

  return {
    title: 'Tidy up',
    el: h('div', { class: 'page page-narrow' },
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Tidy up'),
        h('p', { class: 'page-sub' }, 'Nothing changes until you choose it, and everything can be undone.')),
      h('label', { class: 'inline-field tidy-age' }, 'Count a note as old after',
        h('select', {
          class: 'select',
          onChange: (event) => {
            staleDays = Number(event.target.value);
            db.setMeta('ui', { ...db.getMeta('ui', {}), tidyDays: staleDays });
            refresh();
          },
        }, STALE_CHOICES.map((choice) => h('option', { value: choice.days, selected: choice.days === staleDays }, choice.label)))),
      body),
    update: (change) => {
      if (change.stores.has('notes') || change.stores.has('tags')) refresh();
    },
  };
}
