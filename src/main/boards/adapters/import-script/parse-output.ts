import { RefusalError } from '../../../../shared/refusal';

/** One item a script printed. `body` is empty when the script omitted it. */
export interface ScriptImportItem {
  id: string;
  title: string;
  body: string;
}

/** Past this many items the Import dialog cannot usefully show them. */
export const MAX_SCRIPT_IMPORT_ITEMS = 500;

/**
 * Parse a script's stdout as a JSON array of `{id, title, body}`. A UTF-8 BOM
 * (PowerShell sometimes writes one) is stripped. Anything else is a refusal
 * the Import UI shows: not JSON, not an array, a missing id or title, a
 * repeated id, or more than `MAX_SCRIPT_IMPORT_ITEMS` items.
 */
export function parseScriptOutput(stdout: string): ScriptImportItem[] {
  const text = stdout.replace(/^\uFEFF/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RefusalError('The script did not print a JSON array.');
  }
  if (!Array.isArray(parsed)) throw new RefusalError('The script did not print a JSON array.');
  if (parsed.length > MAX_SCRIPT_IMPORT_ITEMS) {
    throw new RefusalError(`The script printed more than ${String(MAX_SCRIPT_IMPORT_ITEMS)} items.`);
  }
  const seenIds = new Set<string>();
  const items: ScriptImportItem[] = [];
  for (const [itemIndex, entry] of parsed.entries()) {
    const item = readItem(entry, itemIndex);
    if (seenIds.has(item.id)) throw new RefusalError(`The script printed the id ${item.id} twice.`);
    seenIds.add(item.id);
    items.push(item);
  }
  return items;
}

function readItem(entry: unknown, itemIndex: number): ScriptImportItem {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new RefusalError(`Item ${String(itemIndex + 1)} is not an object with id and title.`);
  }
  const record = entry as Record<string, unknown>;
  const id = readRequiredString(record.id, 'id', itemIndex);
  const title = readRequiredString(record.title, 'title', itemIndex);
  if (record.body === undefined || record.body === null) return { id, title, body: '' };
  if (typeof record.body !== 'string') {
    throw new RefusalError(`Item ${String(itemIndex + 1)} has a body that is not a string.`);
  }
  return { id, title, body: record.body };
}

function readRequiredString(value: unknown, field: string, itemIndex: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RefusalError(`Item ${String(itemIndex + 1)} is missing a ${field}.`);
  }
  return value;
}
