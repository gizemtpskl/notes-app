/**
 * picker.js: the random picker behind "Pick something for tonight" and "Surprise me". Types opt
 * in with a `picker` setting:
 *   field, from  only notes with one of these values in this field, such as status "To watch"
 *   moveTo       offers to change that field once chosen
 *   filters      the choices on offer: [{ field, label, choices, unit, also, emptyPasses }]
 *                also: { Indoors: ['Either'] } means choosing Indoors also matches Either
 *                emptyPasses: a note with no value stays in, since it's only unknown
 *   done         { count, date }: offers "Mark as done", counting up and noting the day
 *
 * filters given to pickerCandidates: { fieldId: selected } where selected is an option name, or a
 * number for a limit ("up to 90 minutes"). Notes with no value in a limit field stay in too.
 */
import { toDateStr } from './dates.js';
import { fieldValue, isEmptyValue } from './fieldKinds.js';

export function pickerCandidates(notes, type, filters = {}) {
  const { picker } = type;
  const statusField = type.fields.find((f) => f.id === picker.field);
  const active = Object.entries(filters).filter(([, wanted]) => wanted !== '' && wanted !== null && wanted !== undefined);
  return notes.filter((note) => {
    if (statusField && !picker.from?.includes(fieldValue(note, statusField))) return false;
    return active.every(([fieldId, wanted]) => {
      const field = type.fields.find((f) => f.id === fieldId);
      if (!field) return true;
      const value = fieldValue(note, field);
      if (field.kind === 'number') return value === null || value <= Number(wanted);
      const config = picker.filters?.find((f) => f.field === fieldId);
      if (config?.emptyPasses && isEmptyValue(field, value)) return true;
      if (config?.also?.[wanted]?.includes(value)) return true;
      return Array.isArray(value) ? value.includes(wanted) : value === wanted;
    });
  });
}

/** A random candidate, avoiding the last pick when there is another choice. */
export function pickOne(candidates, { excludeId = null, random = Math.random } = {}) {
  if (!candidates.length) return null;
  const pool = candidates.length > 1 ? candidates.filter((n) => n.id !== excludeId) : candidates;
  return pool[Math.floor(random() * pool.length)];
}

/** The field changes for "Mark as done": one more time done, on today's date. */
export function donePatch(note, type, now = Date.now()) {
  const { count, date } = type.picker.done;
  const countField = type.fields.find((f) => f.id === count);
  return {
    fields: {
      ...note.fields,
      [count]: (countField ? fieldValue(note, countField) ?? 0 : 0) + 1,
      [date]: toDateStr(new Date(now)),
    },
  };
}
