/**
 * porting.js: everything that crosses the device boundary.
 *   - JSON backup: buildExport(), parseImport(), applyImport()
 *   - Markdown:    noteToMarkdown(), markdownExport()
 *
 * Imported files are treated as untrusted. Each record is rebuilt field by field, bodies are
 * sanitized, and references are repaired, so a damaged or malicious file cannot break the app
 * or inject scripts.
 */
import {
  EXPORT_FORMAT, MAX_VERSIONS, MEMORY_STORES, SCHEMA_VERSION, SPACE_COLORS, cleanTagName, createCollection, createNote, createSavedView, createSpace, createTag, DEFAULT_TYPE_ID, isSortKey,
} from './schema.js';
import { fieldValue, isEmptyValue, valueToText } from './fieldKinds.js';
import { normalizeFilter } from './filters.js';
import { fold, safeFileName } from './text.js';
import { assetIds, escapeMd, htmlToMarkdown, htmlToText, sanitizeHtml } from './html.js';
import { REPEATS, PRIORITIES } from './tasks.js';
import { cleanTemplate } from './templates.js';
import { cleanType, displayTitle } from './types.js';
import { cleanSemester, cleanTimeBlock } from './timetable.js';
import { cleanHabit } from './habits.js';
import { createZip } from './zip.js';

/** Meta entries that travel with a backup. Device-specific state such as backup dates stays behind. */
const PORTABLE_META = new Set(['settings', 'filing']);
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i;

// ---------------------------------------------------------------------------------------
// JSON export
// ---------------------------------------------------------------------------------------

/** Builds the full backup object. Reads images from storage, so it is async. */
export async function buildExport(db, now = Date.now()) {
  await db.flush();
  const data = {};
  for (const store of MEMORY_STORES) {
    if (store !== 'meta') data[store] = [...db.data[store].values()];
  }
  // `text` is derived from body, so it is recomputed on import instead of doubling the file size.
  data.notes = data.notes.map(({ text: _text, ...note }) => note);
  data.noteTypes = data.noteTypes.filter((type) => !type.builtin);
  data.meta = [...db.data.meta.values()].filter((entry) => PORTABLE_META.has(entry.id));
  data.assets = await db.storage.getAll('assets');
  data.versions = await db.storage.getAll('versions');
  return {
    format: EXPORT_FORMAT, version: SCHEMA_VERSION, exportedAt: new Date(now).toISOString(), data,
  };
}

// ---------------------------------------------------------------------------------------
// JSON import
// ---------------------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 128;
const asTime = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
const asString = (value, max = Infinity) => (typeof value === 'string' ? value.slice(0, max) : '');

function cleanSpace(raw, now) {
  if (!isObject(raw) || !isId(raw.id) || typeof raw.name !== 'string') return null;
  return {
    ...createSpace({
      id: raw.id,
      name: raw.name.slice(0, 200),
      icon: asString(raw.icon, 16) || '📁',
      color: SPACE_COLORS.includes(raw.color) ? raw.color : 'slate',
      order: Number.isFinite(raw.order) ? raw.order : 0,
      now,
    }),
    created: asTime(raw.created, now),
    updated: asTime(raw.updated, now),
  };
}

/** How a list is shown: view mode, sort, grouping, date field and filter. */
function cleanViewSettings(raw) {
  if (!isObject(raw) || !isSortKey(raw.sort)) return undefined;
  return {
    sort: raw.sort,
    dir: raw.dir === 'asc' ? 'asc' : 'desc',
    ...(typeof raw.mode === 'string' ? { mode: raw.mode } : {}),
    ...(typeof raw.groupBy === 'string' ? { groupBy: raw.groupBy } : {}),
    ...(typeof raw.dateKey === 'string' ? { dateKey: raw.dateKey } : {}),
    ...(isObject(raw.filter) ? { filter: normalizeFilter(raw.filter) } : {}),
  };
}

function cleanCollection(raw, now) {
  if (!isObject(raw) || !isId(raw.id) || !isId(raw.spaceId) || typeof raw.name !== 'string') return null;
  const view = cleanViewSettings(raw.view);
  return {
    ...createCollection({
      id: raw.id,
      name: raw.name.slice(0, 200),
      spaceId: raw.spaceId,
      parentId: isId(raw.parentId) ? raw.parentId : null,
      icon: asString(raw.icon, 16),
      defaultTypeId: isId(raw.defaultTypeId) ? raw.defaultTypeId : DEFAULT_TYPE_ID,
      order: Number.isFinite(raw.order) ? raw.order : 0,
      view,
      now,
    }),
    created: asTime(raw.created, now),
    updated: asTime(raw.updated, now),
  };
}

function cleanNote(raw, now) {
  if (!isObject(raw) || !isId(raw.id)) return null;
  if (raw.title !== undefined && typeof raw.title !== 'string') return null;
  if (raw.body !== undefined && typeof raw.body !== 'string') return null;
  const body = sanitizeHtml(raw.body ?? '');
  const stringIds = (value) => (Array.isArray(value) ? value.filter(isId) : []);
  return {
    ...createNote({
      id: raw.id,
      title: asString(raw.title),
      body,
      text: htmlToText(body),
      spaceId: isId(raw.spaceId) ? raw.spaceId : null,
      collectionId: isId(raw.collectionId) ? raw.collectionId : null,
      typeId: isId(raw.typeId) ? raw.typeId : DEFAULT_TYPE_ID,
      fields: isObject(raw.fields) ? raw.fields : {},
      tagIds: stringIds(raw.tagIds),
      pinned: raw.pinned === true,
      favorite: raw.favorite === true,
      archived: raw.archived === true,
      private: raw.private === true,
      now,
    }),
    trashedAt: Number.isFinite(raw.trashedAt) ? raw.trashedAt : null,
    created: asTime(raw.created, now),
    updated: asTime(raw.updated, now),
    opened: asTime(raw.opened, now),
  };
}

function cleanTag(raw, now) {
  if (!isObject(raw) || !isId(raw.id) || !cleanTagName(raw.name)) return null;
  return {
    ...createTag({ id: raw.id, name: raw.name, now }),
    created: asTime(raw.created, now),
    updated: asTime(raw.updated, now),
  };
}

function cleanSavedView(raw, now) {
  if (!isObject(raw) || !isId(raw.id) || typeof raw.name !== 'string') return null;
  return {
    ...createSavedView({
      id: raw.id,
      name: raw.name.slice(0, 200),
      icon: asString(raw.icon, 16) || '🔖',
      filter: normalizeFilter(raw.filter),
      view: cleanViewSettings(raw.view),
      pinned: raw.pinned !== false,
      order: Number.isFinite(raw.order) ? raw.order : 0,
      now,
    }),
    created: asTime(raw.created, now),
    updated: asTime(raw.updated, now),
  };
}

/** Old versions of a note. Bodies are sanitized like any other body. */
function cleanVersions(raw) {
  if (!isObject(raw) || !isId(raw.id) || !Array.isArray(raw.items)) return null;
  const items = raw.items
    .filter((item) => isObject(item) && Number.isFinite(item.at))
    .slice(-MAX_VERSIONS)
    .map((item) => ({
      at: item.at,
      title: asString(item.title),
      body: sanitizeHtml(asString(item.body)),
      fields: isObject(item.fields) ? item.fields : {},
      tagIds: Array.isArray(item.tagIds) ? item.tagIds.filter(isId) : [],
      typeId: isId(item.typeId) ? item.typeId : DEFAULT_TYPE_ID,
    }));
  return items.length ? { id: raw.id, items } : null;
}

function cleanAsset(raw, now) {
  if (!isObject(raw) || !isId(raw.id) || typeof raw.dataUrl !== 'string') return null;
  if (!IMAGE_DATA_URL.test(raw.dataUrl)) return null;
  return { id: raw.id, mime: asString(raw.mime, 40), dataUrl: raw.dataUrl, created: asTime(raw.created, now) };
}

function cleanMeta(raw) {
  if (!isObject(raw) || !PORTABLE_META.has(raw.id) || !isObject(raw.value)) return null;
  if (raw.id === 'filing' && !(isObject(raw.value.tokens) && isObject(raw.value.totals))) return null;
  return { id: raw.id, value: raw.value };
}

const CLEANERS = {
  habits: cleanHabit,
  timeBlocks: cleanTimeBlock,
  semesters: cleanSemester,
  spaces: cleanSpace,
  collections: cleanCollection,
  notes: cleanNote,
  noteTypes: cleanType,
  tags: cleanTag,
  savedViews: cleanSavedView,
  templates: cleanTemplate,
  assets: cleanAsset,
  versions: cleanVersions,
  meta: cleanMeta,
};

/**
 * Parses and validates a backup file's text. Never throws.
 * Returns { ok: false, error } or { ok: true, data, summary, warnings }.
 */
export function parseImport(text, now = Date.now()) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'This file is not valid JSON, so it cannot be a notes backup.' };
  }
  if (!isObject(parsed) || parsed.format !== EXPORT_FORMAT) {
    return { ok: false, error: 'This JSON file is not a backup from this app.' };
  }
  if (!Number.isInteger(parsed.version) || parsed.version < 1) {
    return { ok: false, error: 'This backup has no valid version number.' };
  }
  if (parsed.version > SCHEMA_VERSION) {
    return { ok: false, error: `This backup was made by a newer version of the app (format ${parsed.version}). Update the app, then import it again.` };
  }
  if (!isObject(parsed.data)) {
    return { ok: false, error: 'This backup contains no data section.' };
  }

  const data = {};
  const warnings = [];
  for (const [store, clean] of Object.entries(CLEANERS)) {
    const raw = parsed.data[store] ?? [];
    if (!Array.isArray(raw)) {
      return { ok: false, error: `The "${store}" section of this backup is damaged.` };
    }
    const byId = new Map();
    let skipped = 0;
    for (const item of raw) {
      const record = clean(item, now);
      if (record) byId.set(record.id, record);
      else skipped += 1;
    }
    if (skipped) warnings.push(`Skipped ${skipped} invalid item${skipped === 1 ? '' : 's'} in "${store}".`);
    data[store] = [...byId.values()];
  }
  dedupeTags(data);

  return {
    ok: true,
    data,
    warnings,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : null,
    summary: {
      spaces: data.spaces.length,
      collections: data.collections.length,
      notes: data.notes.length,
      images: data.assets.length,
      timeBlocks: data.timeBlocks.length,
    },
  };
}

/**
 * Applies a validated import.
 *   merge    keeps existing notes. When an id exists on both sides, the newer `updated` wins.
 *   replace  removes current notes and organization first. Settings on this device stay.
 * Returns an undo function. Images are only ever added here: unused ones are cleaned up at a
 * later startup, which is what makes replace undoable.
 */
export async function applyImport(db, data, mode) {
  await db.storage.commit([
    ...data.assets.map((asset) => ({ store: 'assets', id: asset.id, value: asset })),
    ...data.versions.map((record) => ({ store: 'versions', id: record.id, value: record })),
  ]);
  const incoming = mode === 'replace' ? data : mergeTagsByName(db, data);
  const { undo } = db.undoable(() => {
    const stores = MEMORY_STORES.filter((store) => store !== 'meta');
    if (mode === 'replace') {
      for (const store of stores) {
        for (const record of [...db.data[store].values()]) {
          if (!record.builtin) db._remove(store, record.id);
        }
      }
    }
    for (const store of stores) {
      for (const record of incoming[store]) {
        const existing = db.data[store].get(record.id);
        if (existing?.builtin) continue;
        if (!existing || (record.updated ?? 0) >= (existing.updated ?? 0)) db._put(store, record);
      }
    }
    // Settings and learned filing choices on this device win, unless everything is being replaced.
    for (const entry of data.meta) {
      if (!db.getMeta(entry.id) || (mode === 'replace' && entry.id === 'filing')) db._put('meta', entry);
    }
    db.repairIntegrity();
    db.rebuildLinks();
    db._put('meta', { id: 'onboarded', value: true });
  });
  await db.flush();
  return undo;
}

/** A tag in the file with the same name as one here becomes that one, so names stay unique. */
function mergeTagsByName(db, data) {
  const remap = new Map();
  const tags = data.tags.filter((tag) => {
    const existing = db.findTagByName(tag.name);
    if (existing && existing.id !== tag.id) {
      remap.set(tag.id, existing.id);
      return false;
    }
    return true;
  });
  if (!remap.size) return data;
  const swap = (ids) => [...new Set(ids.map((id) => remap.get(id) ?? id))];
  return {
    ...data,
    tags,
    notes: data.notes.map((note) => ({ ...note, tagIds: swap(note.tagIds) })),
    savedViews: data.savedViews.map((view) => ({ ...view, filter: { ...view.filter, tags: swap(view.filter.tags) } })),
  };
}

/** Two tags in one file can't share a name: later ones fold into the first. */
function dedupeTags(data) {
  const byName = new Map();
  const remap = new Map();
  for (const tag of data.tags) {
    const key = fold(tag.name);
    if (byName.has(key)) remap.set(tag.id, byName.get(key));
    else byName.set(key, tag.id);
  }
  if (!remap.size) return;
  data.tags = data.tags.filter((tag) => !remap.has(tag.id));
  data.notes = data.notes.map((note) => ({ ...note, tagIds: [...new Set(note.tagIds.map((id) => remap.get(id) ?? id))] }));
}

// ---------------------------------------------------------------------------------------
// Markdown export
// ---------------------------------------------------------------------------------------

const yamlString = (value) => JSON.stringify(String(value));

function tasksToMarkdown(items, indent = '') {
  return items.map((item) => {
    const details = [];
    if (item.due) details.push(`due ${item.due}${item.time ? ` ${item.time}` : ''}`);
    if (item.priority) details.push(`${PRIORITIES.find((p) => p.value === item.priority).label.toLowerCase()} priority`);
    if (item.repeat) details.push(REPEATS.find((r) => r.value === item.repeat).label.toLowerCase());
    const suffix = details.length ? ` (${details.join(', ')})` : '';
    const line = `${indent}- [${item.done ? 'x' : ' '}] ${escapeMd(item.text)}${suffix}`;
    return item.children.length ? `${line}\n${tasksToMarkdown(item.children, `${indent}  `)}` : line;
  }).join('\n');
}

/** Short values go in the YAML header. Long text and task lists become sections of their own. */
function fieldsToMarkdown(note, type, db) {
  const header = [];
  const sections = [];
  for (const field of type.fields) {
    const value = fieldValue(note, field);
    if (!isEmptyValue(field, value)) {
      if (field.kind === 'tasks') {
        sections.push(`## ${field.name}\n\n${tasksToMarkdown(value)}`);
      } else if (field.kind === 'longtext') {
        sections.push(`## ${field.name}\n\n${escapeMd(value)}`);
      } else if (field.kind === 'flashcards') {
        sections.push(`## ${field.name}\n\n${value.map((card) => `- **${escapeMd(card.term)}**: ${escapeMd(card.def)}`).join('\n')}`);
      } else if (field.kind === 'collection') {
        header.push(`${yamlString(field.name)}: ${yamlString(db.getCollection(value)?.name ?? value)}`);
      } else if (field.kind === 'relation') {
        const target = db.getNote(value);
        if (target) header.push(`${yamlString(field.name)}: ${yamlString(displayTitle(target, db.getType(target.typeId)) || 'Untitled')}`);
      } else if (field.kind === 'number' || field.kind === 'checkbox') {
        header.push(`${yamlString(field.name)}: ${value}`);
      } else if (field.kind === 'multiselect') {
        header.push(`${yamlString(field.name)}: ${JSON.stringify(value)}`);
      } else {
        header.push(`${yamlString(field.name)}: ${yamlString(valueToText(field, value))}`);
      }
    }
  }
  return { header, sections };
}

/** Note as Markdown with a YAML header. imageSrc maps asset ids to paths. */
export function noteToMarkdown(note, db, { imageSrc } = {}) {
  const space = db.getSpace(note.spaceId);
  const collection = db.getCollection(note.collectionId);
  const type = db.getType(note.typeId);
  const fields = fieldsToMarkdown(note, type, db);
  const header = [
    '---',
    `title: ${yamlString(displayTitle(note, type) || 'Untitled')}`,
    `space: ${space ? yamlString(space.name) : yamlString('Inbox')}`,
    collection ? `collection: ${yamlString(collection.name)}` : null,
    `type: ${yamlString(type.name)}`,
    note.tagIds?.length ? `tags: ${JSON.stringify(note.tagIds.map((id) => db.getTag(id)?.name).filter(Boolean))}` : null,
    ...fields.header,
    `created: ${new Date(note.created).toISOString()}`,
    `updated: ${new Date(note.updated).toISOString()}`,
    note.pinned ? 'pinned: true' : null,
    note.favorite ? 'favorite: true' : null,
    note.archived ? 'archived: true' : null,
    note.private ? 'private: true' : null,
    '---',
  ].filter(Boolean).join('\n');
  const body = htmlToMarkdown(note.body, { imageSrc }).trim();
  const parts = [...fields.sections];
  if (body) parts.push(fields.sections.length ? `## ${type.bodyLabel ?? 'Notes'}\n\n${body}` : body);
  return `${header}\n\n${parts.join('\n\n')}\n`;
}

function folderFor(note, db) {
  const space = db.getSpace(note.spaceId);
  const parts = note.archived ? ['Archive'] : [];
  if (!space) return [...parts, 'Inbox'];
  parts.push(safeFileName(space.name));
  const col = db.getCollection(note.collectionId);
  if (col) {
    const parent = db.getCollection(col.parentId);
    if (parent) parts.push(safeFileName(parent.name));
    parts.push(safeFileName(col.name));
  }
  return parts;
}

const EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Builds a Markdown download.
 *   scope  { kind: 'all' } | { kind: 'collection', id } | { kind: 'note', id }
 * A single note with no images is a plain .md file. Everything else is a zip, with images
 * in an assets folder. Trashed notes are not included.
 * Returns { blob, filename }.
 */
export async function markdownExport(db, scope, now = new Date()) {
  await db.flush();
  let notes;
  let baseName;
  if (scope.kind === 'note') {
    notes = [db.getNote(scope.id)].filter(Boolean);
    baseName = notes[0] ? safeFileName(displayTitle(notes[0], db.getType(notes[0].typeId))) : 'Untitled';
  } else if (scope.kind === 'collection') {
    notes = db.listNotes({ status: 'all', collectionId: scope.id, includeChildren: true }).filter((n) => !n.trashedAt);
    baseName = safeFileName(db.getCollection(scope.id)?.name, 'Collection');
  } else {
    notes = db.listNotes({ status: 'all' }).filter((n) => !n.trashedAt);
    baseName = `notes-${now.toISOString().slice(0, 10)}`;
  }

  // Loaded up front so paths are known before the Markdown is written.
  const assets = new Map();
  for (const note of notes) {
    for (const id of assetIds(note.body)) {
      if (!assets.has(id)) {
        const asset = await db.getAsset(id);
        if (asset) assets.set(id, asset);
      }
    }
  }
  const assetPath = (id) => `assets/${id}.${EXTENSIONS[assets.get(id)?.mime] ?? 'img'}`;

  if (scope.kind === 'note' && notes[0] && !assets.size) {
    return {
      blob: new Blob([noteToMarkdown(notes[0], db)], { type: 'text/markdown;charset=utf-8' }),
      filename: `${baseName}.md`,
    };
  }

  const usedPaths = new Set();
  const files = [];
  for (const note of notes) {
    const folders = scope.kind === 'note' ? [] : folderFor(note, db);
    const stem = safeFileName(displayTitle(note, db.getType(note.typeId)));
    let path = [...folders, `${stem}.md`].join('/');
    for (let n = 2; usedPaths.has(path.toLocaleLowerCase()); n += 1) {
      path = [...folders, `${stem} (${n}).md`].join('/');
    }
    usedPaths.add(path.toLocaleLowerCase());
    const up = '../'.repeat(folders.length);
    files.push({ path, data: noteToMarkdown(note, db, { imageSrc: (id) => up + assetPath(id) }) });
  }
  for (const [id, asset] of assets) files.push({ path: assetPath(id), data: dataUrlToBytes(asset.dataUrl) });

  return { blob: createZip(files, now), filename: `${baseName}.zip` };
}
