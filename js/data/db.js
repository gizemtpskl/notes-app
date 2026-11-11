/**
 * db.js: the data layer. All reads and writes of app data go through this class.
 *
 * HOW IT WORKS
 *   - On open, every store except assets is loaded into memory. Reads are synchronous and
 *     instant, which keeps lists and search fast with thousands of notes.
 *   - Writes update memory immediately, then a short timer groups them into one storage
 *     transaction. Call flush() to wait until everything is on disk.
 *   - Records are frozen. To change one, call an update method, which replaces the record.
 *     Old versions stay valid, and undo relies on that.
 *   - Other open tabs receive changes over a BroadcastChannel. Without this, a second tab
 *     would keep stale copies in memory and could overwrite newer notes.
 *
 * LISTENING FOR CHANGES
 *   db.on((change) => ...) fires once per finished batch with:
 *     { stores: Set, ids: Set, structural: boolean, source: 'local' | 'remote' }
 *   structural is true when something that lists or the sidebar show has changed (a note moved,
 *   was pinned, archived and so on). Typing in a note is not structural.
 *
 * UNDO
 *   const { result, undo } = db.undoable(() => db.deleteSpace(id));
 *   Every record touched inside the callback is restored when undo() is called.
 *
 * ADDING AN OPERATION
 *   Wrap the writes in this.batch(...) and use _put/_remove. Journal, persistence,
 *   tab sync and events then all work with no extra code.
 */
import {
  BACKUP_REMINDER_DAYS, BACKUP_SNOOZE_DAYS, DAY_MS, DEFAULT_TYPE_ID, MAX_VERSIONS, MEMORY_STORES,
  RuleError, TRASH_DAYS, cleanTagName, createCollection, createNote, createSavedView, createSpace, createTag, uid,
} from './schema.js';
import { compareValues, fieldValue, isEmptyValue } from './fieldKinds.js';
import { assetIds, htmlToText, sanitizeHtml } from './html.js';
import { emptyModel, learn, suggest } from './filing.js';
import { collectLinks, renameLinkText, sameIds } from './links.js';
import { BUILTIN_TEMPLATES, notePropsFromTemplate, templateFromNote } from './templates.js';
import { fold } from './text.js';
import { blockProblem, createSemester, createTimeBlock, toMinutes } from './timetable.js';
import { createHabit, toggleHabitDay } from './habits.js';
import { syncsRecord } from './syncScope.js';
import { isDateStr, toDateStr } from './dates.js';
import {
  BUILTIN_TYPES, autoTitleFor, createCustomType, defaultFieldValues, fieldsToHtml, noteDueDate, stampedFields,
} from './types.js';

const FLUSH_DELAY_MS = 250;
const TOMBSTONES_KEY = 'syncDeleted';
/** Changing any of these changes what lists or the sidebar show. */
const STRUCTURAL_NOTE_KEYS = ['spaceId', 'collectionId', 'archived', 'trashedAt', 'pinned', 'favorite', 'typeId', 'tagIds'];
/** Changing any of these counts as editing, and bumps the note's `updated` time. */
const CONTENT_NOTE_KEYS = ['title', 'body', 'fields', 'tagIds', 'typeId'];

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

export class NotesDb {
  constructor(storage, { channelName = 'personal-notes' } = {}) {
    this.storage = storage;
    this.channelName = channelName;
    this.data = Object.fromEntries(MEMORY_STORES.map((store) => [store, new Map()]));
    this.listeners = new Set();
    this.persistErrorListeners = new Set();

    this._pending = new Map();
    this._flushTimer = null;
    this._writeChain = Promise.resolve();
    this._batchDepth = 0;
    this._change = null;
    this._journal = null;
    this._structureVersion = 0;
    this._counts = null;
    this._channel = null;
    this._linksVersion = 0;
    this._backlinks = null;
  }

  /** Loads everything into memory. Call once, before anything else. */
  async open({ now = Date.now() } = {}) {
    for (const store of MEMORY_STORES) {
      const records = await this.storage.getAll(store);
      for (const record of records) this.data[store].set(record.id, Object.freeze(record));
    }
    // Built-in types come from the code, so they update with the app and are never stored.
    for (const type of BUILTIN_TYPES) this.data.noteTypes.set(type.id, type);
    this.purgeExpiredTrash(now);
    // Links typed as plain web addresses before wiki links existed still count, once.
    if (!this.getMeta('linksIndexed')) {
      this.rebuildLinks();
      this.setMeta('linksIndexed', true);
    }
    this._openChannel();
    return this;
  }

  close() {
    clearTimeout(this._flushTimer);
    this._channel?.close();
    this._channel = null;
    this.storage.close();
  }

  // -- Plumbing --------------------------------------------------------------------------

  /** Subscribes to changes. Returns the unsubscribe function. */
  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Subscribes to failed saves, so the UI can warn instead of losing data silently. */
  onPersistError(listener) {
    this.persistErrorListeners.add(listener);
    return () => this.persistErrorListeners.delete(listener);
  }

  /** Groups writes so listeners fire once and they all land in one storage transaction. */
  batch(fn) {
    this._batchDepth += 1;
    this._change ??= { stores: new Set(), ids: new Set(), structural: false, source: 'local' };
    try {
      return fn();
    } finally {
      // Deletions noted during the batch are saved once, as one record.
      if (this._batchDepth === 1 && this._tombDirty) {
        this._tombDirty = false;
        this._put('meta', { id: TOMBSTONES_KEY, value: Object.fromEntries(this._tombstones()) });
      }
      this._batchDepth -= 1;
      if (this._batchDepth === 0) {
        const change = this._change;
        this._change = null;
        if (change.ids.size) this._emit(change);
      }
    }
  }

  /** Runs fn and returns { result, undo }. undo() restores every record fn touched. */
  undoable(fn) {
    if (this._journal) return { result: fn(), undo: () => {} };
    this._journal = new Map();
    let result;
    let journal;
    try {
      result = this.batch(fn);
    } finally {
      journal = this._journal;
      this._journal = null;
    }
    const entries = [...journal.values()].map((entry) => ({
      ...entry, next: this.data[entry.store].get(entry.id) ?? null,
    }));
    const undo = () => this.batch(() => entries.forEach((entry) => this._revert(entry)));
    return { result, undo };
  }

  /**
   * Undoes one record. An Undo toast stays clickable for a few seconds, so the record may have
   * changed again since. Only what the operation itself changed is put back: undoing a move
   * must not throw away text typed after the move.
   */
  _revert({ store, id, previous, next }) {
    const current = this.data[store].get(id) ?? null;
    if (current === next) {
      if (previous) this._put(store, previous);
      else this._remove(store, id);
    } else if (previous) {
      if (!current || !next) {
        this._put(store, previous);
      } else {
        const patch = {};
        for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
          if (previous[key] !== next[key]) patch[key] = previous[key];
        }
        this._put(store, { ...current, ...patch });
      }
    }
    // Otherwise it was created by the operation and edited since, so it is kept.
  }

  // -- Change times, for sync ------------------------------------------------------------
  //
  // Every record that syncs carries syncAt: when it last changed on any device. Deletions are
  // remembered in one meta record, { "store:id": time }, so a deleted note isn't brought back by a
  // device that still has it. Sync (sync.js) compares these times. Imports and sync itself keep
  // the times records already have: see withSyncTimes().

  _tombstones() {
    this._tombCache ??= new Map(Object.entries(this.getMeta(TOMBSTONES_KEY) ?? {}));
    return this._tombCache;
  }

  /** Deletions remembered for sync: { "store:id": time }. */
  syncTombstones() {
    return Object.fromEntries(this._tombstones());
  }

  /**
   * Runs fn as one batch, keeping the change times records already carry instead of stamping
   * them now. deletedAt gives the time to remember for deletions ("store:id" => time).
   */
  withSyncTimes(fn, deletedAt = new Map()) {
    const previous = this._syncTimes;
    this._syncTimes = deletedAt;
    try {
      return this.batch(fn);
    } finally {
      this._syncTimes = previous;
    }
  }

  /** Remembers deletions made on other devices, for records this one never had. */
  adoptTombstones(deleted) {
    this.batch(() => {
      const map = this._tombstones();
      for (const [key, at] of Object.entries(deleted)) {
        const store = key.slice(0, key.indexOf(':'));
        const id = key.slice(key.indexOf(':') + 1);
        if (this.data[store]?.has(id)) continue;
        if (!map.has(key) || map.get(key) < at) {
          map.set(key, at);
          this._tombDirty = true;
        }
      }
    });
  }

  /** Forgets deletions older than a cutoff, so the list doesn't grow forever. */
  pruneTombstones(before) {
    this.batch(() => {
      for (const [key, at] of this._tombstones()) {
        if (at < before) {
          this._tombstones().delete(key);
          this._tombDirty = true;
        }
      }
    });
  }

  _stamp(store, record) {
    if (!syncsRecord(store, record)) return record;
    const key = `${store}:${record.id}`;
    if (this._tombstones().has(key)) {
      this._tombstones().delete(key);
      this._tombDirty = true;
    }
    if (this._syncTimes) return record.syncAt ? record : { ...record, syncAt: record.updated ?? record.created ?? 0 };
    return { ...record, syncAt: Date.now() };
  }

  _put(store, record) {
    record = this._stamp(store, record);
    const frozen = Object.isFrozen(record) ? record : Object.freeze(record);
    this._record(store, record.id, this.data[store].get(record.id) ?? null, frozen);
    this.data[store].set(record.id, frozen);
    return frozen;
  }

  _remove(store, id) {
    const previous = this.data[store].get(id);
    if (!previous) return;
    if (syncsRecord(store, previous)) {
      const key = `${store}:${id}`;
      this._tombstones().set(key, this._syncTimes?.get(key) ?? Date.now());
      this._tombDirty = true;
    }
    this._record(store, id, previous, null);
    this.data[store].delete(id);
  }

  _record(store, id, previous, next) {
    const key = `${store}\u0000${id}`;
    if (this._journal && !this._journal.has(key)) this._journal.set(key, { store, id, previous });
    this._pending.set(key, { store, id, value: next });
    this._change.stores.add(store);
    this._change.ids.add(id);
    if (store === 'notes' && previous?.links !== next?.links) this._linksVersion += 1;
    if (this._isStructural(store, previous, next)) {
      this._change.structural = true;
      this._structureVersion += 1;
    }
    this._scheduleFlush();
  }

  _isStructural(store, previous, next) {
    if (store === 'meta' || store === 'timeBlocks' || store === 'semesters' || store === 'habits') return false;
    if (store !== 'notes') return true;
    if (!previous || !next) return true;
    return STRUCTURAL_NOTE_KEYS.some((key) => previous[key] !== next[key]);
  }

  _emit(change) {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (error) {
        console.error('Change listener failed:', error);
      }
    }
  }

  _scheduleFlush() {
    if (this._flushTimer === null) {
      this._flushTimer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
    }
  }

  /** Writes all pending changes. Resolves once they are stored, or the save has been reported as failed. */
  flush() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    const pending = this._pending;
    this._pending = new Map();
    this._writeChain = this._writeChain.then(async () => {
      if (!pending.size) return;
      const ops = [...pending.values()];
      try {
        await this.storage.commit(ops);
        this._broadcast(ops);
      } catch (error) {
        console.error('Save failed:', error);
        // Keep the changes queued, without overwriting anything newer, so the next save retries them.
        for (const [key, op] of pending) {
          if (!this._pending.has(key)) this._pending.set(key, op);
        }
        for (const listener of this.persistErrorListeners) listener(error);
      }
    });
    return this._writeChain;
  }

  _openChannel() {
    if (typeof BroadcastChannel === 'undefined') return;
    this._channel = new BroadcastChannel(this.channelName);
    this._channel.onmessage = (event) => {
      if (event.data === 'erased' || event.data === 'reload') this.onRemoteErase?.();
      else this._applyRemote(event.data);
    };
  }

  /** Asks other tabs to reload, such as when the lock is switched on or the app is locked. */
  broadcastReload() {
    this._channel?.postMessage('reload');
  }

  _broadcast(ops) {
    const memoryOps = ops.filter((op) => this.data[op.store]);
    if (memoryOps.length) this._channel?.postMessage(memoryOps);
  }

  _applyRemote(ops) {
    const change = { stores: new Set(), ids: new Set(), structural: false, source: 'remote' };
    for (const { store, id, value } of ops) {
      if (store === 'meta' && id === TOMBSTONES_KEY) this._tombCache = null;
      const previous = this.data[store].get(id) ?? null;
      if (value === null) this.data[store].delete(id);
      else this.data[store].set(id, Object.freeze(value));
      change.stores.add(store);
      change.ids.add(id);
      if (store === 'notes' && previous?.links !== value?.links) this._linksVersion += 1;
      if (this._isStructural(store, previous, value)) {
        change.structural = true;
        this._structureVersion += 1;
      }
    }
    this._emit(change);
  }

  // -- Meta and settings -----------------------------------------------------------------

  getMeta(key, fallback = null) {
    const record = this.data.meta.get(key);
    return record ? record.value : fallback;
  }

  setMeta(key, value) {
    this.batch(() => this._put('meta', { id: key, value }));
  }

  getSettings() {
    return this.getMeta('settings', { theme: 'system' });
  }

  updateSettings(patch) {
    this.setMeta('settings', { ...this.getSettings(), ...patch });
  }

  // -- Spaces ----------------------------------------------------------------------------

  listSpaces() {
    return [...this.data.spaces.values()].sort((a, b) => a.order - b.order);
  }

  getSpace(id) {
    return this.data.spaces.get(id) ?? null;
  }

  createSpace(props) {
    const order = this.data.spaces.size;
    return this.batch(() => this._put('spaces', createSpace({ ...props, order })));
  }

  updateSpace(id, patch, now = Date.now()) {
    const space = this._require('spaces', id);
    return this.batch(() => this._put('spaces', { ...space, ...patch, id, updated: now }));
  }

  /** Moves a space to a position in the sidebar. */
  moveSpace(id, index) {
    this._require('spaces', id);
    this.batch(() => {
      const others = this.listSpaces().filter((s) => s.id !== id);
      others.splice(clamp(index, 0, others.length), 0, this.getSpace(id));
      others.forEach((space, order) => {
        if (space.order !== order) this._put('spaces', { ...space, order });
      });
    });
  }

  /** Deletes a space and its collections. Its notes are never deleted: they return to the Inbox. */
  deleteSpace(id) {
    this._require('spaces', id);
    this.batch(() => {
      for (const note of this.data.notes.values()) {
        if (note.spaceId === id) this._put('notes', { ...note, spaceId: null, collectionId: null });
      }
      for (const col of this.data.collections.values()) {
        if (col.spaceId === id) this._remove('collections', col.id);
      }
      this._remove('spaces', id);
    });
  }

  // -- Collections -----------------------------------------------------------------------

  getCollection(id) {
    return this.data.collections.get(id) ?? null;
  }

  /** Siblings in display order. parentId null means the top level of the space. */
  listCollections(spaceId, parentId = null) {
    return [...this.data.collections.values()]
      .filter((c) => c.spaceId === spaceId && c.parentId === parentId)
      .sort((a, b) => a.order - b.order);
  }

  allCollections() {
    return [...this.data.collections.values()];
  }

  createCollection({ spaceId, parentId = null, ...props }) {
    this._require('spaces', spaceId);
    if (parentId) this._assertCanNestUnder(parentId, null, spaceId);
    const order = this.listCollections(spaceId, parentId).length;
    return this.batch(() => this._put('collections', createCollection({ ...props, spaceId, parentId, order })));
  }

  updateCollection(id, patch, now = Date.now()) {
    const col = this._require('collections', id);
    // Location changes must go through moveCollection, which keeps notes consistent.
    const { spaceId: _s, parentId: _p, ...safe } = patch;
    return this.batch(() => this._put('collections', { ...col, ...safe, id, updated: now }));
  }

  _assertCanNestUnder(parentId, movingId, spaceId) {
    const parent = this._require('collections', parentId);
    if (parent.parentId) throw new RuleError('Collections can only be nested one level deep.');
    if (parent.id === movingId) throw new RuleError('A collection cannot be placed inside itself.');
    if (spaceId && parent.spaceId !== spaceId) throw new RuleError('A sub-collection must be in the same space as its parent.');
    if (movingId && this.listCollections(parent.spaceId, movingId).length) {
      throw new RuleError('This collection has sub-collections, so it cannot be nested inside another.');
    }
  }

  /** Reorders, nests, un-nests, or moves a collection to another space, along with its contents. */
  moveCollection(id, { spaceId, parentId = null, index = Infinity }) {
    const col = this._require('collections', id);
    let targetSpace = spaceId ?? col.spaceId;
    if (parentId) {
      this._assertCanNestUnder(parentId, id, null);
      targetSpace = this.getCollection(parentId).spaceId;
    }
    this._require('spaces', targetSpace);

    this.batch(() => {
      const siblings = this.listCollections(targetSpace, parentId).filter((c) => c.id !== id);
      const moved = { ...col, spaceId: targetSpace, parentId };
      siblings.splice(clamp(index, 0, siblings.length), 0, moved);
      siblings.forEach((sibling, order) => {
        if (sibling === moved || sibling.order !== order) this._put('collections', { ...sibling, order });
      });

      if (targetSpace !== col.spaceId) {
        const moving = new Set([id]);
        for (const child of this.listCollections(col.spaceId, id)) {
          moving.add(child.id);
          this._put('collections', { ...child, spaceId: targetSpace });
        }
        for (const note of this.data.notes.values()) {
          if (moving.has(note.collectionId)) this._put('notes', { ...note, spaceId: targetSpace });
        }
      }
    });
  }

  /** Deletes a collection. Notes move up one level and sub-collections become top-level. */
  deleteCollection(id) {
    const col = this._require('collections', id);
    this.batch(() => {
      for (const note of this.data.notes.values()) {
        if (note.collectionId === id) this._put('notes', { ...note, collectionId: col.parentId });
      }
      let order = this.listCollections(col.spaceId, null).length;
      for (const child of this.listCollections(col.spaceId, id)) {
        this._put('collections', { ...child, parentId: null, order });
        order += 1;
      }
      this._remove('collections', id);
    });
  }

  // -- Notes -----------------------------------------------------------------------------

  getNote(id) {
    return this.data.notes.get(id) ?? null;
  }

  getType(id) {
    return this.data.noteTypes.get(id) ?? this.data.noteTypes.get(DEFAULT_TYPE_ID);
  }

  /** A note's type comes from its collection's default, when that type exists. */
  _resolveTypeId(typeId, collectionId) {
    const candidate = typeId ?? this.getCollection(collectionId)?.defaultTypeId;
    return candidate && this.data.noteTypes.has(candidate) ? candidate : DEFAULT_TYPE_ID;
  }

  /** Creates a note. With no location it lands in the Inbox. Its type supplies starting values. */
  createNote({
    title = '', body = '', spaceId = null, collectionId = null, typeId, fields, private: isPrivate, now = Date.now(), ...rest
  } = {}) {
    const target = this._resolveLocation({ spaceId, collectionId });
    const clean = sanitizeHtml(body);
    const resolved = this._resolveTypeId(typeId, target.collectionId);
    const type = this.getType(resolved);
    const values = { ...defaultFieldValues(type, now), ...fields };
    // A "Collection" field starts as the course this note was made in: the top-level collection.
    for (const field of type.fields) {
      if (field.kind === 'collection' && !values[field.id] && target.collectionId) {
        values[field.id] = this.getCollection(target.collectionId).parentId ?? target.collectionId;
      }
    }
    const id = rest.id ?? uid();
    return this.batch(() => this._put('notes', createNote({
      ...rest,
      id,
      now,
      title: title || autoTitleFor(type, values),
      body: clean,
      text: htmlToText(clean),
      ...target,
      typeId: resolved,
      fields: values,
      links: collectLinks({ id, body: clean, fields: values }, type),
      private: isPrivate ?? Boolean(type.privateByDefault),
    })));
  }

  /**
   * What changes when a note becomes another type. Existing values are kept, even ones the new
   * type has no field for, so changing back restores them.
   */
  _typePatch(note, typeId, now = Date.now()) {
    if (note.typeId === typeId) return {};
    const type = this.getType(typeId);
    const fields = { ...defaultFieldValues(type, now), ...note.fields };
    const wasPrivateType = this.getType(note.typeId).privateByDefault;
    let isPrivate = note.private;
    if (type.privateByDefault) isPrivate = true;
    else if (wasPrivateType) isPrivate = false;
    return {
      typeId: type.id, fields, private: isPrivate, title: note.title || autoTitleFor(type, fields),
    };
  }

  setNoteType(id, typeId) {
    const note = this._require('notes', id);
    this._require('noteTypes', typeId);
    return this.updateNote(id, this._typePatch(note, typeId));
  }

  /** Changes a task list with a pure function from tasks.js. */
  updateTasks(noteId, fieldId, change) {
    const note = this._require('notes', noteId);
    const field = this.getType(note.typeId).fields.find((f) => f.id === fieldId);
    if (!field) throw new RuleError('That task list no longer exists.');
    return this.updateNote(noteId, { fields: { ...note.fields, [fieldId]: change(fieldValue(note, field)) } });
  }

  /**
   * Updates a note. `updated` is only bumped for content changes, so pinning or moving does not
   * reorder a "recently updated" list. The stored body is always sanitized here.
   */
  updateNote(id, patch, { now = Date.now() } = {}) {
    const note = this._require('notes', id);
    const next = { ...note, ...patch, id };
    if ('fields' in patch) {
      // A status that names a date to fill in, like "Applied" filling "Applied on".
      const stamps = stampedFields(this.getType(next.typeId), note.fields ?? {}, next.fields ?? {}, toDateStr(new Date(now)));
      if (Object.keys(stamps).length) next.fields = { ...next.fields, ...stamps };
    }
    if ('body' in patch) {
      next.body = sanitizeHtml(patch.body);
      next.text = htmlToText(next.body);
    }
    if ('body' in patch || 'fields' in patch || 'typeId' in patch) {
      const links = collectLinks(next, this.getType(next.typeId));
      next.links = sameIds(links, note.links ?? []) ? note.links : links;
    }
    if (CONTENT_NOTE_KEYS.some((key) => key in patch && next[key] !== note[key])) next.updated = now;
    return this.batch(() => {
      const saved = this._put('notes', next);
      if ('title' in patch && note.title && next.title && note.title !== next.title) this._renameLinks(id, note.title, next.title);
      return saved;
    });
  }

  /** Links that still show a note's old title follow its new one. This doesn't count as editing those notes. */
  _renameLinks(id, oldTitle, newTitle) {
    for (const sourceId of this._backlinkMap().get(id) ?? []) {
      const source = this.getNote(sourceId);
      if (source) {
        const body = renameLinkText(source.body, id, oldTitle, newTitle);
        if (body !== source.body) this._put('notes', { ...source, body, text: htmlToText(body) });
      }
    }
  }

  /** Checks a destination and returns a consistent { spaceId, collectionId }. */
  _resolveLocation({ spaceId = null, collectionId = null }) {
    if (collectionId) {
      const col = this._require('collections', collectionId);
      if (spaceId && spaceId !== col.spaceId) throw new RuleError('That collection belongs to a different space.');
      return { spaceId: col.spaceId, collectionId };
    }
    if (spaceId) this._require('spaces', spaceId);
    return { spaceId, collectionId: null };
  }

  /** Moves notes. An empty target ({}) sends them to the Inbox. */
  moveNotes(ids, target) {
    const location = this._resolveLocation(target);
    this.batch(() => {
      for (const id of ids) {
        const note = this._require('notes', id);
        if (note.spaceId !== location.spaceId || note.collectionId !== location.collectionId) {
          this._put('notes', { ...note, ...location });
        }
      }
    });
  }

  setPinned(id, pinned) {
    return this.updateNote(id, { pinned });
  }

  setFavorite(id, favorite) {
    return this.updateNote(id, { favorite });
  }

  archiveNotes(ids) {
    this.batch(() => ids.forEach((id) => this.updateNote(id, { archived: true, pinned: false })));
  }

  unarchiveNotes(ids) {
    this.batch(() => ids.forEach((id) => this.updateNote(id, { archived: false })));
  }

  /** Soft delete. The note can be restored for TRASH_DAYS. */
  trashNotes(ids, now = Date.now()) {
    this.batch(() => ids.forEach((id) => this.updateNote(id, { trashedAt: now, pinned: false })));
  }

  restoreNotes(ids) {
    this.batch(() => ids.forEach((id) => this.updateNote(id, { trashedAt: null })));
  }

  /** Permanent delete. */
  purgeNotes(ids) {
    this.batch(() => ids.forEach((id) => {
      this._remove('notes', id);
      // Old versions go too, or "delete forever" wouldn't really mean forever.
      this._pending.set(`versions\u0000${id}`, { store: 'versions', id, value: null });
    }));
    this._scheduleFlush();
  }

  purgeExpiredTrash(now = Date.now()) {
    const cutoff = now - TRASH_DAYS * DAY_MS;
    const expired = [...this.data.notes.values()].filter((n) => n.trashedAt && n.trashedAt < cutoff);
    this.purgeNotes(expired.map((n) => n.id));
    return expired.length;
  }

  /**
   * Finds notes. Only active notes are returned unless status says otherwise.
   *   status           'active' | 'archived' | 'trash' | 'all'
   *   inbox            true: only notes in the Inbox
   *   spaceId          within a space, plus rootOnly: true for notes outside any collection
   *   collectionId     within a collection, plus includeChildren: true for its sub-collections
   *   pinned, favorite true: only those notes
   *   sort             { key: 'updated' | 'created' | 'title' | 'opened' | 'trashedAt', dir: 'asc' | 'desc' }
   *   pinnedFirst      true: pinned notes go on top
   *   limit            maximum number of results
   */
  listNotes({
    status = 'active', inbox, spaceId, rootOnly, collectionId, includeChildren, pinned, favorite,
    sort = { key: 'updated', dir: 'desc' }, pinnedFirst = false, limit,
  } = {}) {
    let collectionIds = null;
    if (collectionId) {
      collectionIds = new Set([collectionId]);
      const col = this.getCollection(collectionId);
      if (includeChildren && col) {
        for (const child of this.listCollections(col.spaceId, collectionId)) collectionIds.add(child.id);
      }
    }
    const results = [];
    for (const note of this.data.notes.values()) {
      if (noteStatus(note) !== status && status !== 'all') continue;
      if (inbox && note.spaceId !== null) continue;
      if (spaceId && note.spaceId !== spaceId) continue;
      if (rootOnly && note.collectionId !== null) continue;
      if (collectionIds && !collectionIds.has(note.collectionId)) continue;
      if (pinned && !note.pinned) continue;
      if (favorite && !note.favorite) continue;
      results.push(note);
    }
    const sorted = this._sortNotes(results, sort, pinnedFirst);
    return limit ? sorted.slice(0, limit) : sorted;
  }

  /** Sorts an existing list, for callers that found the notes themselves. */
  sortNotes(notes, sort = { key: 'updated', dir: 'desc' }, pinnedFirst = false) {
    return this._sortNotes(notes, sort, pinnedFirst);
  }

  _sortNotes(notes, { key, dir }, pinnedFirst) {
    if (key !== 'due' && !key.startsWith('field:')) return notes.sort(noteComparator({ key, dir }, pinnedFirst));

    // Field values are calculated once per note instead of on every comparison.
    const fieldId = key.startsWith('field:') ? key.slice(6) : null;
    const sign = dir === 'asc' ? 1 : -1;
    const dueField = { kind: 'date' };
    const rows = notes.map((note) => {
      const type = this.getType(note.typeId);
      if (!fieldId) return { note, field: dueField, value: noteDueDate(note, type) || null };
      const field = type.fields.find((f) => f.id === fieldId);
      const value = field ? fieldValue(note, field) : null;
      return { note, field, value: value === null || (field && isEmptyValue(field, value)) ? null : value };
    });
    rows.sort((a, b) => {
      if (pinnedFirst && a.note.pinned !== b.note.pinned) return a.note.pinned ? -1 : 1;
      // Notes without a value go last in either direction.
      if (a.value === null || b.value === null) {
        if (a.value !== b.value) return a.value === null ? 1 : -1;
      } else {
        const order = compareValues(a.field, a.value, b.value);
        if (order) return sign * order;
      }
      return b.note.updated - a.note.updated;
    });
    return rows.map((row) => row.note);
  }

  /** Values already used in a field, so typed-in options can be suggested again. */
  usedFieldValues(typeId, fieldId) {
    const field = this.getType(typeId).fields.find((f) => f.id === fieldId);
    if (!field) return [];
    const values = new Set();
    for (const note of this.data.notes.values()) {
      if (note.typeId === typeId && !note.trashedAt) {
        const value = fieldValue(note, field);
        for (const item of Array.isArray(value) ? value : [value]) {
          if (typeof item === 'string' && item) values.add(item);
        }
      }
    }
    return [...values].sort((a, b) => collator.compare(a, b));
  }

  /** Counts for the sidebar, cached until the structure changes. */
  counts() {
    if (this._counts?.version === this._structureVersion) return this._counts;
    const counts = {
      version: this._structureVersion, inbox: 0, favorites: 0, archive: 0, trash: 0, spaces: new Map(), collections: new Map(), tags: new Map(),
    };
    const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
    for (const note of this.data.notes.values()) {
      if (!note.trashedAt) for (const tagId of note.tagIds ?? []) bump(counts.tags, tagId);
      if (note.trashedAt) {
        counts.trash += 1;
      } else if (note.archived) {
        counts.archive += 1;
      } else {
        if (note.favorite) counts.favorites += 1;
        if (note.spaceId === null) {
          counts.inbox += 1;
        } else {
          bump(counts.spaces, note.spaceId);
          if (note.collectionId) {
            bump(counts.collections, note.collectionId);
            const parent = this.getCollection(note.collectionId)?.parentId;
            if (parent) bump(counts.collections, parent);
          }
        }
      }
    }
    this._counts = counts;
    return counts;
  }

  // -- Note types ------------------------------------------------------------------------

  /** Built-in types in their defined order, then custom types by name. */
  listTypes() {
    const custom = [...this.data.noteTypes.values()].filter((t) => !t.builtin).sort((a, b) => collator.compare(a.name, b.name));
    return [...BUILTIN_TYPES, ...custom];
  }

  typeUsage(id) {
    let count = 0;
    for (const note of this.data.notes.values()) if (note.typeId === id) count += 1;
    return count;
  }

  createType(props) {
    return this.batch(() => this._put('noteTypes', createCustomType(props)));
  }

  /** Copies a type. Field ids stay the same, so moving a note to the copy keeps its values. */
  duplicateType(id, now = Date.now()) {
    const source = this._require('noteTypes', id);
    const { builtin: _b, id: _i, ...rest } = source;
    return this.batch(() => this._put('noteTypes', {
      ...rest, id: uid(), builtin: false, name: `${source.name} copy`, fields: source.fields.map((f) => ({ ...f })), created: now, updated: now,
    }));
  }

  updateType(id, patch, now = Date.now()) {
    const type = this._require('noteTypes', id);
    if (type.builtin) throw new RuleError('Built-in types cannot be changed. Duplicate it to make your own version.');
    return this.batch(() => this._put('noteTypes', { ...type, ...patch, id, updated: now }));
  }

  /**
   * Deletes a custom type. Its notes become Free notes, with their field values written into
   * the body so they stay readable. Collections that defaulted to it fall back to Free note.
   */
  deleteType(id) {
    const type = this._require('noteTypes', id);
    if (type.builtin) throw new RuleError('Built-in types cannot be deleted.');
    this.batch(() => {
      for (const note of this.data.notes.values()) {
        if (note.typeId === id) {
          const body = `${fieldsToHtml(note, type, (value) => this.getCollection(value)?.name ?? value)}${note.body}`;
          this._put('notes', {
            ...note, typeId: DEFAULT_TYPE_ID, body, text: htmlToText(body), links: collectLinks({ id: note.id, body, fields: {} }, this.getType(DEFAULT_TYPE_ID)),
          });
        }
      }
      for (const col of this.data.collections.values()) {
        if (col.defaultTypeId === id) this._put('collections', { ...col, defaultTypeId: DEFAULT_TYPE_ID });
      }
      this._remove('noteTypes', id);
    });
  }

  // -- Tags ------------------------------------------------------------------------------

  /** Tags by name. */
  listTags() {
    return [...this.data.tags.values()].sort((a, b) => collator.compare(a.name, b.name));
  }

  getTag(id) {
    return this.data.tags.get(id) ?? null;
  }

  /** Names are unique, ignoring case and accents, so "Thesis" and "thesis" are one tag. */
  findTagByName(name) {
    const key = fold(cleanTagName(name));
    if (!key) return null;
    for (const tag of this.data.tags.values()) if (fold(tag.name) === key) return tag;
    return null;
  }

  /** Returns the tag with this name, creating it if needed. Returns null for a blank name. */
  ensureTag(name) {
    const clean = cleanTagName(name);
    if (!clean) return null;
    return this.findTagByName(clean) ?? this.batch(() => this._put('tags', createTag({ name: clean })));
  }

  addTag(noteId, name) {
    const note = this._require('notes', noteId);
    return this.batch(() => {
      const tag = this.ensureTag(name);
      if (tag && !note.tagIds.includes(tag.id)) this.updateNote(noteId, { tagIds: [...note.tagIds, tag.id] });
      return tag;
    });
  }

  removeTag(noteId, tagId) {
    const note = this._require('notes', noteId);
    return this.updateNote(noteId, { tagIds: note.tagIds.filter((id) => id !== tagId) });
  }

  addTagToNotes(ids, tagId) {
    this.batch(() => ids.forEach((id) => {
      const note = this._require('notes', id);
      if (!note.tagIds.includes(tagId)) this.updateNote(id, { tagIds: [...note.tagIds, tagId] });
    }));
  }

  /** Renames a tag. Taking the name of another tag merges the two. Returns the tag that remains. */
  renameTag(id, name, now = Date.now()) {
    const tag = this._require('tags', id);
    const clean = cleanTagName(name);
    if (!clean) throw new RuleError('A tag needs a name.');
    const other = this.findTagByName(clean);
    if (other && other.id !== id) {
      this.mergeTags([id], other.id);
      return other;
    }
    return this.batch(() => this._put('tags', { ...tag, name: clean, updated: now }));
  }

  /** Replaces source tags with the target on every note, then removes them. */
  mergeTags(sourceIds, targetId) {
    this._require('tags', targetId);
    const sources = new Set(sourceIds.filter((id) => id !== targetId));
    this.batch(() => {
      for (const note of this.data.notes.values()) {
        if (note.tagIds.some((id) => sources.has(id))) {
          const tagIds = [...new Set(note.tagIds.map((id) => (sources.has(id) ? targetId : id)))];
          this._put('notes', { ...note, tagIds });
        }
      }
      for (const id of sources) this._remove('tags', id);
    });
  }

  /** Removes a tag from every note, including trashed ones. The notes themselves stay. */
  deleteTag(id) {
    this._require('tags', id);
    this.batch(() => {
      for (const note of this.data.notes.values()) {
        if (note.tagIds.includes(id)) this._put('notes', { ...note, tagIds: note.tagIds.filter((t) => t !== id) });
      }
      this._remove('tags', id);
    });
  }

  /** Tags no note outside the Trash uses. */
  orphanTags() {
    const { tags } = this.counts();
    return this.listTags().filter((tag) => !tags.get(tag.id));
  }

  // -- Links -----------------------------------------------------------------------------

  /** Map of note id to the ids of notes pointing at it, rebuilt only after links change. */
  _backlinkMap() {
    if (this._backlinks?.version === this._linksVersion) return this._backlinks.map;
    const map = new Map();
    for (const note of this.data.notes.values()) {
      for (const target of note.links ?? []) {
        if (!map.has(target)) map.set(target, []);
        map.get(target).push(note.id);
      }
    }
    this._backlinks = { version: this._linksVersion, map };
    return map;
  }

  /** Notes that link to this one, most recently updated first. Trashed notes don't count. */
  backlinks(id) {
    return (this._backlinkMap().get(id) ?? [])
      .map((sourceId) => this.getNote(sourceId))
      .filter((note) => note && !note.trashedAt)
      .sort((a, b) => b.updated - a.updated);
  }

  /**
   * Notes sharing tags with this one, best first. A rare shared tag counts for more than a
   * common one. Private notes are only suggested from other private notes.
   */
  relatedNotes(note, limit = 5) {
    if (!note.tagIds?.length) return [];
    const mine = new Set(note.tagIds);
    const { tags } = this.counts();
    const scored = [];
    for (const other of this.data.notes.values()) {
      if (other.id !== note.id && !other.trashedAt && !other.archived && (!other.private || note.private)) {
        let score = 0;
        for (const tagId of other.tagIds) {
          if (mine.has(tagId)) score += 1 / Math.log2(2 + (tags.get(tagId) ?? 1));
        }
        if (score) scored.push({ note: other, score });
      }
    }
    scored.sort((a, b) => b.score - a.score || b.note.updated - a.note.updated);
    return scored.slice(0, limit).map((entry) => entry.note);
  }

  /** Recalculates every note's links. Used after imports, whose links can't be trusted. */
  rebuildLinks() {
    this.batch(() => {
      for (const note of this.data.notes.values()) {
        const links = collectLinks(note, this.getType(note.typeId));
        if (!sameIds(links, note.links ?? [])) this._put('notes', { ...note, links });
      }
    });
  }

  // -- Saved views -----------------------------------------------------------------------

  listSavedViews() {
    return [...this.data.savedViews.values()].sort((a, b) => a.order - b.order);
  }

  getSavedView(id) {
    return this.data.savedViews.get(id) ?? null;
  }

  createSavedView(props) {
    const order = this.data.savedViews.size;
    return this.batch(() => this._put('savedViews', createSavedView({ ...props, order })));
  }

  updateSavedView(id, patch, now = Date.now()) {
    const view = this._require('savedViews', id);
    return this.batch(() => this._put('savedViews', { ...view, ...patch, id, updated: now }));
  }

  deleteSavedView(id) {
    this._require('savedViews', id);
    this.batch(() => this._remove('savedViews', id));
  }

  moveSavedView(id, index) {
    this._require('savedViews', id);
    this.batch(() => {
      const others = this.listSavedViews().filter((v) => v.id !== id);
      others.splice(clamp(index, 0, others.length), 0, this.getSavedView(id));
      others.forEach((view, order) => {
        if (view.order !== order) this._put('savedViews', { ...view, order });
      });
    });
  }

  // -- Timetable -------------------------------------------------------------------------
  // The rules for repeats, exceptions and semesters live in timetable.js. These only store.

  listBlocks() {
    return [...this.data.timeBlocks.values()];
  }

  getBlock(id) {
    return this.data.timeBlocks.get(id) ?? null;
  }

  /** A block linked to a collection belongs to that collection's space, for its color and summary. */
  _blockPlace(block) {
    const collection = block.collectionId && this.getCollection(block.collectionId);
    return collection ? { ...block, spaceId: collection.spaceId } : block;
  }

  createBlock(props, now = Date.now()) {
    const block = this._blockPlace(createTimeBlock({ ...props, now }));
    const problem = blockProblem(block);
    if (problem) throw new RuleError(problem);
    return this.batch(() => this._put('timeBlocks', block));
  }

  /** Changes the whole series. Single-occurrence changes go through setOccurrence. */
  updateBlock(id, patch, now = Date.now()) {
    const block = this._require('timeBlocks', id);
    const { id: _id, created: _created, ...rest } = createTimeBlock({ ...block, ...patch, id, now });
    const next = this._blockPlace({ ...block, ...rest, updated: now });
    const problem = blockProblem(next);
    if (problem) throw new RuleError(problem);
    return this.batch(() => this._put('timeBlocks', next));
  }

  deleteBlock(id) {
    this._require('timeBlocks', id);
    this.batch(() => this._remove('timeBlocks', id));
  }

  /**
   * Changes one occurrence of a series, found by the day it originally fell on.
   * change: { cancelled: true }, or values that differ from the series; null or {} puts it back.
   */
  setOccurrence(id, originalDate, change, now = Date.now()) {
    const block = this._require('timeBlocks', id);
    const exceptions = { ...block.exceptions };
    if (change && Object.keys(change).length) {
      const start = change.start ?? block.start;
      const end = change.end ?? block.end;
      if (!change.cancelled && toMinutes(end) <= toMinutes(start)) throw new RuleError('The end time needs to be after the start time.');
      exceptions[originalDate] = { ...change };
    } else {
      delete exceptions[originalDate];
    }
    return this.batch(() => this._put('timeBlocks', { ...block, exceptions, updated: now }));
  }

  listSemesters() {
    return [...this.data.semesters.values()].sort((a, b) => a.start.localeCompare(b.start));
  }

  getSemester(id) {
    return this.data.semesters.get(id) ?? null;
  }

  createSemester(props, now = Date.now()) {
    const semester = createSemester({ ...props, now });
    if (!isDateStr(semester.start) || !isDateStr(semester.end) || semester.end < semester.start) {
      throw new RuleError('A semester needs a start date and an end date after it.');
    }
    return this.batch(() => this._put('semesters', semester));
  }

  updateSemester(id, patch, now = Date.now()) {
    const semester = this._require('semesters', id);
    const next = { ...semester, ...patch, id, updated: now };
    next.name = String(next.name ?? '').trim() || 'Semester';
    if (!isDateStr(next.start) || !isDateStr(next.end) || next.end < next.start) {
      throw new RuleError('A semester needs a start date and an end date after it.');
    }
    return this.batch(() => this._put('semesters', next));
  }

  /** Series in the semester keep stopping on its last day, so deleting it changes no week. */
  deleteSemester(id, now = Date.now()) {
    const semester = this._require('semesters', id);
    this.batch(() => {
      for (const block of this.listBlocks()) {
        if (block.semesterId === id) {
          const until = block.repeat?.until && block.repeat.until < semester.end ? block.repeat.until : semester.end;
          const date = block.date < semester.start ? semester.start : block.date;
          this._put('timeBlocks', {
            ...block, date, semesterId: '', repeat: block.repeat && { ...block.repeat, until }, updated: now,
          });
        }
      }
      this._remove('semesters', id);
    });
  }

  // -- Habits ----------------------------------------------------------------------------

  listHabits() {
    return [...this.data.habits.values()].sort((a, b) => a.order - b.order);
  }

  getHabit(id) {
    return this.data.habits.get(id) ?? null;
  }

  createHabit(props, now = Date.now()) {
    if (!String(props?.name ?? '').trim()) throw new RuleError('Give the habit a name.');
    const order = this.listHabits().reduce((max, h) => Math.max(max, h.order + 1), 0);
    return this.batch(() => this._put('habits', createHabit({ ...props, order, now })));
  }

  updateHabit(id, patch, now = Date.now()) {
    const habit = this._require('habits', id);
    const name = 'name' in patch ? String(patch.name).trim() : habit.name;
    if (!name) throw new RuleError('Give the habit a name.');
    return this.batch(() => this._put('habits', {
      ...habit, ...patch, name: name.slice(0, 80), id, updated: now,
    }));
  }

  toggleHabit(id, date, now = Date.now()) {
    const habit = this._require('habits', id);
    return this.batch(() => this._put('habits', toggleHabitDay(habit, date, now)));
  }

  moveHabit(id, index) {
    this._require('habits', id);
    this.batch(() => {
      const others = this.listHabits().filter((h) => h.id !== id);
      others.splice(clamp(index, 0, others.length), 0, this.getHabit(id));
      others.forEach((habit, order) => {
        if (habit.order !== order) this._put('habits', { ...habit, order });
      });
    });
  }

  deleteHabit(id) {
    this._require('habits', id);
    this.batch(() => this._remove('habits', id));
  }

  // -- Templates -------------------------------------------------------------------------

  /** Built-in templates in their defined order, then your own by name. */
  listTemplates() {
    const own = [...this.data.templates.values()].sort((a, b) => collator.compare(a.name, b.name));
    return [...BUILTIN_TEMPLATES, ...own];
  }

  getTemplate(id) {
    return this.data.templates.get(id) ?? BUILTIN_TEMPLATES.find((t) => t.id === id) ?? null;
  }

  saveNoteAsTemplate(noteId, { name, icon }) {
    const note = this._require('notes', noteId);
    return this.batch(() => this._put('templates', templateFromNote(note, this.getType(note.typeId), { name: String(name).trim() || 'Untitled template', icon })));
  }

  updateTemplate(id, patch, now = Date.now()) {
    const template = this._require('templates', id);
    return this.batch(() => this._put('templates', { ...template, ...patch, id, updated: now }));
  }

  deleteTemplate(id) {
    this._require('templates', id);
    this.batch(() => this._remove('templates', id));
  }

  /**
   * Makes a note from a template. Notes made in a collection stay there. A template whose type has
   * gone falls back to a Free note, and tags that no longer exist are skipped.
   */
  createFromTemplate(templateId, target = {}, now = Date.now()) {
    const template = this.getTemplate(templateId);
    if (!template) throw new RuleError('That template no longer exists.');
    const type = this.getType(template.typeId);
    const props = notePropsFromTemplate(template, type, now);
    props.tagIds = props.tagIds.filter((id) => this.data.tags.has(id));
    return this.createNote({ ...target, ...props, typeId: type.id });
  }

  // -- Version history -------------------------------------------------------------------

  /** A note's saved versions, newest first. Read from storage on demand. */
  async listVersions(noteId) {
    const record = await this.storage.get('versions', noteId);
    return [...(record?.items ?? [])].reverse();
  }

  /**
   * Keeps a copy of a note as it is now, or as given. Nothing is stored when it's the same as the
   * last copy. The oldest copies go once there are more than MAX_VERSIONS.
   */
  snapshotNote(noteId, source = null, now = Date.now()) {
    // One at a time, or two quick copies could each overwrite the other.
    this._versionChain = (this._versionChain ?? Promise.resolve())
      .then(() => this._snapshot(noteId, source, now))
      .catch((error) => {
        console.warn('Version not saved:', error);
        return false;
      });
    return this._versionChain;
  }

  async _snapshot(noteId, source, now) {
    const note = source ?? this.getNote(noteId);
    if (!note) return false;
    const record = await this.storage.get('versions', noteId);
    const items = record?.items ?? [];
    const copy = {
      at: now, title: note.title, body: note.body, fields: note.fields, tagIds: note.tagIds, typeId: note.typeId,
    };
    const last = items.at(-1);
    if (last && last.title === copy.title && last.body === copy.body && last.typeId === copy.typeId && JSON.stringify(last.fields) === JSON.stringify(copy.fields)) return false;
    const next = [...items, copy].slice(-MAX_VERSIONS);
    await this.storage.commit([{ store: 'versions', id: noteId, value: { id: noteId, items: next } }]);
    return true;
  }

  /** Brings back an old version. The current state is saved first, so this can always be reversed. */
  async restoreVersion(noteId, at) {
    const note = this._require('notes', noteId);
    const record = await this.storage.get('versions', noteId);
    const version = record?.items.find((item) => item.at === at);
    if (!version) throw new RuleError('That version no longer exists.');
    await this.snapshotNote(noteId, note);
    return this.updateNote(noteId, {
      title: version.title,
      body: version.body,
      fields: version.fields,
      typeId: this.data.noteTypes.has(version.typeId) ? version.typeId : note.typeId,
      tagIds: (version.tagIds ?? []).filter((id) => this.data.tags.has(id)),
    });
  }

  /** Removes versions of notes that are gone, such as after an import replaced everything. */
  async collectOrphanVersions() {
    const ids = await this.storage.keys('versions');
    const ops = ids.filter((id) => !this.data.notes.has(id)).map((id) => ({ store: 'versions', id, value: null }));
    await this.storage.commit(ops);
    return ops.length;
  }

  // -- Filing (Inbox review) -------------------------------------------------------------

  /** Moves an Inbox note to its destination and learns from the choice. */
  fileNote(id, target) {
    const note = this._require('notes', id);
    const location = this._resolveLocation(target);
    if (!location.spaceId) throw new RuleError('Choose a space to file this note.');
    this.batch(() => {
      const typeId = target.typeId ?? (this.getCollection(location.collectionId) ? this._resolveTypeId(null, location.collectionId) : note.typeId);
      this._put('notes', { ...note, ...location, ...this._typePatch(note, this.data.noteTypes.has(typeId) ? typeId : DEFAULT_TYPE_ID) });
      this.setMeta('filing', learn(this.getMeta('filing', emptyModel()), note, location.spaceId, location.collectionId));
    });
  }

  suggestFiling(note, limit = 3) {
    return suggest(this.getMeta('filing', emptyModel()), note, this.listSpaces(), this.allCollections(), limit);
  }

  // -- Assets (images) -------------------------------------------------------------------

  /** Stores an image as a data URL. Goes straight to storage and is not kept in memory. */
  async putAsset({ id = uid(), mime, dataUrl, created = Date.now() }) {
    await this.storage.commit([{ store: 'assets', id, value: { id, mime, dataUrl, created } }]);
    return id;
  }

  getAsset(id) {
    return this.storage.get('assets', id);
  }

  /**
   * Deletes images no note refers to. Runs at startup rather than on delete, which keeps undo simple.
   * Recent assets are skipped: their note may not have been saved yet, possibly in another tab.
   */
  async collectOrphanAssets(now = Date.now()) {
    const ids = await this.storage.keys('assets');
    if (!ids.length) return 0;
    const used = new Set();
    for (const note of this.data.notes.values()) for (const id of assetIds(note.body)) used.add(id);
    // Templates and old versions can show an image the current note no longer has.
    for (const template of this.data.templates.values()) for (const id of assetIds(template.body)) used.add(id);
    for (const record of await this.storage.getAll('versions')) {
      for (const item of record.items ?? []) for (const id of assetIds(item.body)) used.add(id);
    }
    const ops = [];
    for (const id of ids) {
      if (!used.has(id)) {
        const asset = await this.storage.get('assets', id);
        if (asset && now - asset.created > DAY_MS) ops.push({ store: 'assets', id, value: null });
      }
    }
    await this.storage.commit(ops);
    return ops.length;
  }

  // -- Backup reminder -------------------------------------------------------------------

  /** Whether the backup reminder should show. Depends only on stored dates and `now`. */
  backupDue(now = Date.now()) {
    if (!this.data.notes.size) return false;
    if (this.getMeta('backupSnoozedUntil', 0) > now) return false;
    const since = this.getMeta('lastExportAt') ?? this.getMeta('firstUsedAt') ?? now;
    return now - since >= BACKUP_REMINDER_DAYS * DAY_MS;
  }

  snoozeBackup(now = Date.now()) {
    this.setMeta('backupSnoozedUntil', now + BACKUP_SNOOZE_DAYS * DAY_MS);
  }

  markExported(now = Date.now()) {
    this.setMeta('lastExportAt', now);
  }

  // -- Integrity -------------------------------------------------------------------------

  /**
   * Makes all references consistent. Used after imports, whose data can come from anywhere.
   *   - collection in a missing space: removed
   *   - collection with a missing, foreign or nested parent: moved to the top level
   *   - note in a missing collection: moved to the space root
   *   - note in a missing space: moved to the Inbox
   *   - note's space differs from its collection's: the collection wins
   *   - note with a tag that doesn't exist: the tag is dropped
   */
  repairIntegrity() {
    this.batch(() => {
      for (const col of this.allCollections()) {
        if (!this.getSpace(col.spaceId)) this._remove('collections', col.id);
      }
      for (const col of this.allCollections()) {
        const parent = col.parentId ? this.getCollection(col.parentId) : null;
        const validParent = parent && parent.id !== col.id && !parent.parentId && parent.spaceId === col.spaceId;
        if (col.parentId && !validParent) this._put('collections', { ...col, parentId: null });
      }
      for (const note of this.data.notes.values()) {
        const col = note.collectionId ? this.getCollection(note.collectionId) : null;
        let { spaceId, collectionId } = note;
        if (collectionId && !col) collectionId = null;
        if (col) spaceId = col.spaceId;
        if (spaceId && !this.getSpace(spaceId)) {
          spaceId = null;
          collectionId = null;
        }
        const tagIds = note.tagIds.filter((id) => this.data.tags.has(id));
        if (spaceId !== note.spaceId || collectionId !== note.collectionId || tagIds.length !== note.tagIds.length) {
          this._put('notes', { ...note, spaceId, collectionId, tagIds });
        }
      }
      // A block's links are only shortcuts, so ones that point nowhere are simply cleared.
      for (const block of this.listBlocks()) {
        const patch = {};
        if (block.spaceId && !this.getSpace(block.spaceId)) patch.spaceId = null;
        if (block.collectionId && !this.getCollection(block.collectionId)) patch.collectionId = null;
        if (block.noteId && !this.data.notes.has(block.noteId)) patch.noteId = null;
        if (block.semesterId && !this.data.semesters.has(block.semesterId)) patch.semesterId = '';
        if (block.task && !this.data.notes.has(block.task.noteId)) patch.task = null;
        const sessions = Object.entries(block.sessions ?? {}).filter(([, id]) => this.data.notes.has(id));
        if (sessions.length !== Object.keys(block.sessions ?? {}).length) patch.sessions = Object.fromEntries(sessions);
        if (Object.keys(patch).length) this._put('timeBlocks', { ...block, ...patch });
      }
    });
  }

  /** Permanently deletes everything on this device, including images. */
  async eraseAll() {
    clearTimeout(this._flushTimer);
    this._flushTimer = null;
    this._pending = new Map();
    await this._writeChain;
    await this.storage.clear();
    for (const store of MEMORY_STORES) this.data[store].clear();
    this._tombCache = null;
    this._channel?.postMessage('erased');
    this._structureVersion += 1;
  }

  _require(store, id) {
    const record = this.data[store].get(id);
    if (!record) throw new RuleError(`That item no longer exists (${store}).`);
    return record;
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function noteStatus(note) {
  if (note.trashedAt) return 'trash';
  return note.archived ? 'archived' : 'active';
}

function noteComparator({ key, dir }, pinnedFirst) {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    if (pinnedFirst && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (key === 'title') return sign * collator.compare(a.title || '￿', b.title || '￿');
    return sign * ((a[key] ?? 0) - (b[key] ?? 0));
  };
}
