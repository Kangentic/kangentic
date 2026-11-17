/**
 * Obsidian note properties: the YAML block at the top of a note.
 *
 * Obsidian's Properties editor writes a small, regular subset of YAML: a
 * top-level `key: value` per line, a value that is a scalar, a quoted string,
 * a flow list (`[a, b]`) or a block list (`- a` lines), and now and then a
 * block scalar (`|` or `>`). This parser reads that subset and nothing more,
 * so the import carries no YAML library. A shape it does not know (a nested
 * mapping) keeps its raw text, and a block it cannot split reads as a note
 * with no properties, so the note still imports.
 */

export type PropertyValue = string | string[];

export interface NoteProperty {
  key: string;
  value: PropertyValue;
}

export interface SplitNote {
  /** The note's properties in the order written. Empty when it has none. */
  properties: NoteProperty[];
  /** The note's text after the property block. */
  body: string;
}

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/;
const TOP_LEVEL_KEY = /^([^\s#'"-][^:]*?|"[^"]*"|'[^']*'):(?:[ \t]+(.*))?$/;

export function splitNote(text: string): SplitNote {
  const match = FRONTMATTER.exec(text);
  if (!match) return { properties: [], body: text.replace(/^\uFEFF/, '') };
  return { properties: parseProperties(match[1] ?? ''), body: text.slice(match[0].length) };
}

/** The first property with this key, compared without case, as Obsidian does. */
export function propertyValue(properties: NoteProperty[], key: string): PropertyValue | undefined {
  const wanted = key.toLowerCase();
  return properties.find((property) => property.key.toLowerCase() === wanted)?.value;
}

/** A property as one string: a list's first entry, or undefined when empty. */
export function propertyText(properties: NoteProperty[], key: string): string | undefined {
  const value = propertyValue(properties, key);
  const text = Array.isArray(value) ? value[0] : value;
  return text && text.trim() !== '' ? text.trim() : undefined;
}

/** A Kanban plugin board file: its checklist lines are cards, and the file itself is not one piece of work. */
export function isKanbanBoard(properties: NoteProperty[]): boolean {
  return propertyValue(properties, 'kanban-plugin') !== undefined;
}

/** A property as a list: a scalar becomes one entry, split on commas. */
export function propertyList(properties: NoteProperty[], key: string): string[] {
  const value = propertyValue(properties, key);
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : value.split(',');
  return entries.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

function parseProperties(block: string): NoteProperty[] {
  const lines = block.split(/\r?\n/);
  const properties: NoteProperty[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    index += 1;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const keyMatch = TOP_LEVEL_KEY.exec(line);
    if (!keyMatch) continue;
    const key = unquote(keyMatch[1].trim());
    const rest = stripComment((keyMatch[2] ?? '').trim());

    // The indented lines that belong to this key: a block list, a block
    // scalar, or a nested mapping.
    const childLines: string[] = [];
    while (index < lines.length && (lines[index].trim() === '' || /^[ \t]/.test(lines[index]) || lines[index].startsWith('- '))) {
      childLines.push(lines[index]);
      index += 1;
    }
    while (childLines.length > 0 && childLines[childLines.length - 1].trim() === '') childLines.pop();

    properties.push({ key, value: parseValue(rest, childLines) });
  }
  return properties;
}

function parseValue(rest: string, childLines: string[]): PropertyValue {
  if (/^[|>][+-]?$/.test(rest)) {
    const texts = dedent(childLines);
    return rest.startsWith('|') ? texts.join('\n') : texts.join(' ').replace(/\s+/g, ' ').trim();
  }
  if (rest !== '') {
    // An unquoted `[[Link]]` is a wiki-link Obsidian wrote, not a nested list.
    if (rest.startsWith('[') && rest.endsWith(']') && !rest.startsWith('[[')) return splitFlowList(rest.slice(1, -1));
    return unquote(rest);
  }
  const itemLines = childLines.filter((line) => line.trim() !== '');
  if (itemLines.length === 0) return '';
  if (itemLines.every((line) => /^\s*-(\s|$)/.test(line))) {
    return itemLines
      .map((line) => unquote(stripComment(line.replace(/^\s*-\s?/, '').trim())))
      .filter((entry) => entry !== '');
  }
  return dedent(childLines).join('\n');
}

function splitFlowList(inner: string): string[] {
  const entries: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const character of inner) {
    if (quote) {
      current += character;
      if (character === quote) quote = null;
    } else if (character === '"' || character === '\'') {
      quote = character;
      current += character;
    } else if (character === ',') {
      entries.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  entries.push(current);
  return entries.map((entry) => unquote(entry.trim())).filter((entry) => entry !== '');
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\(["\\nt])/g, (_whole, escaped: string) => {
      if (escaped === 'n') return '\n';
      if (escaped === 't') return '\t';
      return escaped;
    });
  }
  if (text.length >= 2 && text.startsWith('\'') && text.endsWith('\'')) {
    return text.slice(1, -1).replace(/''/g, '\'');
  }
  return text;
}

/** A trailing ` # comment` on an unquoted value. */
function stripComment(text: string): string {
  if (text.startsWith('"') || text.startsWith('\'')) return text;
  const commentAt = text.search(/\s#/);
  return commentAt === -1 ? text : text.slice(0, commentAt).trimEnd();
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((line) => line.trim() !== '').map((line) => /^[ \t]*/.exec(line)?.[0].length ?? 0);
  const shared = indents.length > 0 ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(shared));
}
