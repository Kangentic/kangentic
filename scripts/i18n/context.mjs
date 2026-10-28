/**
 * The context a model gets beside each string: the messages near it in the same
 * source file, and the previous version of a reworded string.
 *
 * Neighbours come from the source file, not the PO file. The PO sorts by message
 * and its origins carry no line numbers (lingui.config.ts says why), so a
 * message's place in its file is found by searching the file for its text.
 */

/** The longest run of plain text in an ICU message: what a source file most likely holds verbatim. */
export function longestPlainFragment(message) {
  return message
    .split(/[{}<>#]/)
    .map((fragment) => fragment.trim())
    .reduce((longest, fragment) => (fragment.length > longest.length ? fragment : longest), '');
}

/** The first origin file of a catalog message, or null. */
export function firstOriginFile(message) {
  return message.origin?.[0]?.[0] ?? null;
}

/**
 * A neighbour lookup over one locale's catalog: `(id) => neighbours`, up to
 * `count` messages before and after `id` in its source file, each with the
 * translation it already has in this locale (or none). A message whose text is
 * not found sorts after the ones that are. Each file's order is worked out once,
 * on its first lookup, so make one finder per catalog and locale.
 *
 * - `messages`: the catalog, `{ id: message }`.
 * - `readSource(file)`: the file's text, or null when it cannot be read.
 */
export function createNeighbourFinder(messages, readSource, count = 4) {
  const orderByFile = new Map();
  const fileOrder = (file) => {
    if (!orderByFile.has(file)) {
      const source = readSource(file) ?? '';
      const sameFile = Object.entries(messages).filter(([, message]) => message.origin?.some(([origin]) => origin === file));
      const positioned = sameFile.map(([messageId, message]) => {
        const fragment = longestPlainFragment(message.message ?? '');
        const position = fragment ? source.indexOf(fragment) : -1;
        return { messageId, message, position: position === -1 ? Number.MAX_SAFE_INTEGER : position };
      });
      positioned.sort((left, right) => left.position - right.position || (left.message.message ?? '').localeCompare(right.message.message ?? ''));
      orderByFile.set(file, positioned);
    }
    return orderByFile.get(file);
  };
  return (id) => {
    const file = firstOriginFile(messages[id]);
    if (!file) return [];
    const positioned = fileOrder(file);
    const index = positioned.findIndex((entry) => entry.messageId === id);
    return [...positioned.slice(Math.max(0, index - count), index), ...positioned.slice(index + 1, index + 1 + count)]
      .map(({ message }) => ({ english: message.message, translation: message.translation || null }));
  };
}

/** The neighbours of one message; `createNeighbourFinder` for many in the same catalog. */
export function neighbourMessages(id, messages, readSource, count = 4) {
  return createNeighbourFinder(messages, readSource, count)(id);
}

/** Levenshtein distance, two rows at a time. */
export function editDistance(left, right) {
  let previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const currentRow = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previousRow[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      currentRow.push(Math.min(previousRow[rightIndex] + 1, currentRow[rightIndex - 1] + 1, substitution));
    }
    previousRow = currentRow;
  }
  return previousRow[right.length];
}

/** 1 for identical text, 0 for nothing in common. */
export function similarity(left, right) {
  const longest = Math.max(left.length, right.length);
  return longest === 0 ? 1 : 1 - editDistance(left, right) / longest;
}

/** How alike a reworded string and its previous version must be to offer the old translation. */
export const HINT_SIMILARITY = 0.5;

/**
 * The previous version of a reworded string. A reworded message gets a new ID, so
 * `lingui extract --clean` drops the old entry and its translation; the base
 * branch's catalog still has it. A candidate must share an origin file with the
 * new message and be similar enough; the most similar one wins.
 *
 * - `removed`: `[{ english, translation, origin }]` from `removedEntries`.
 */
export function findHint(message, removed) {
  const files = new Set((message.origin ?? []).map(([file]) => file));
  const english = message.message ?? '';
  let best = null;
  for (const candidate of removed) {
    if (!candidate.origin.some(([file]) => files.has(file))) continue;
    // The edit distance is at least the length difference, so this bound skips
    // a candidate that cannot reach the threshold without computing it.
    const longest = Math.max(english.length, candidate.english.length);
    if (longest > 0 && 1 - Math.abs(english.length - candidate.english.length) / longest < HINT_SIMILARITY) continue;
    const score = similarity(english, candidate.english);
    if (score >= HINT_SIMILARITY && (!best || score > best.score)) best = { ...candidate, score };
  }
  return best ? { english: best.english, translation: best.translation } : null;
}

/**
 * Entries the base catalog had, with a translation, that the current catalog no
 * longer has: the candidates `findHint` picks from.
 */
export function removedEntries(baseMessages, currentMessages) {
  return Object.entries(baseMessages)
    .filter(([id, message]) => !(id in currentMessages) && message.translation && !message.obsolete)
    .map(([, message]) => ({ english: message.message ?? '', translation: message.translation, origin: message.origin ?? [] }));
}
