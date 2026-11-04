import type { CliPlace } from '../../shared/cli-target';
import { cachedFileReader } from './cached-file';
import { kimiConfigPath } from './kimi-home';

/**
 * The parts of Kimi Code CLI's `config.toml` Kangentic reads: the default
 * model and each configured model alias.
 *
 * Source: `docs/en/configuration/config-files.md` (Kimi Code CLI 2.4.1, read
 * 2026-11-03). `default_model` is "Default model alias; must be defined in
 * `models`", each `[models."<alias>"]` entry may set `display_name`,
 * `max_context_size`, `support_efforts` and `default_effort`, and
 * `[models."<alias>".overrides]` carries user overrides that win over the
 * entry's own fields. An alias may hold `/` or `.`, so it is quoted
 * (`[models."kimi-code/k3"]`). `-m <alias>` takes the alias.
 *
 * Kangentic keeps no model list of its own (`cli-features-over-custom-layers`):
 * the aliases are whatever the user's CLI has configured, including what
 * `/login` provisions.
 *
 * No TOML library ships with Kangentic, so this reads only the shapes those
 * fields use: table headers and keys, bare or quoted and dotted, and string,
 * integer and string-array values (a multi-line array included). Anything else,
 * an inline table or a multi-line string among them, is skipped, never an error.
 */
export interface KimiModelEntry {
  alias: string;
  displayName: string | null;
  maxContextSize: number | null;
  supportEfforts: string[];
  defaultEffort: string | null;
}

export interface KimiCodeConfig {
  defaultModel: string | null;
  models: KimiModelEntry[];
}

const EMPTY_CONFIG: KimiCodeConfig = { defaultModel: null, models: [] };

const readParsedConfig = cachedFileReader<KimiCodeConfig>(parseKimiCodeConfig, EMPTY_CONFIG);

/** Read the user's `config.toml`, or an empty config when it cannot be read. */
export function readKimiCodeConfig(place: CliPlace | null = null): KimiCodeConfig {
  return readParsedConfig(kimiConfigPath(place));
}

/**
 * A model alias's entry in the host's `config.toml`. A Kimi Code in a WSL distro
 * gets none from it (its config is the distro's), so its context bar shows
 * tokens with no percentage.
 */
export function kimiModelByAlias(alias: string): KimiModelEntry | undefined {
  return readKimiCodeConfig(null).models.find((model) => model.alias === alias);
}

type TomlScalar = string | number | boolean | string[];

/** Parse the default model and model aliases out of `config.toml` text. */
export function parseKimiCodeConfig(text: string): KimiCodeConfig {
  let defaultModel: string | null = null;
  const fieldsByAlias = new Map<string, Map<string, TomlScalar>>();
  const overridesByAlias = new Map<string, Map<string, TomlScalar>>();
  let tablePath: string[] | null = [];

  // A Windows editor may save the file with a BOM.
  const lines = (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripComment(lines[index]).trim();
    if (line.length === 0) continue;

    if (line.startsWith('[[')) {
      // An array of tables (`[[hooks]]`): none of its keys are read here.
      tablePath = null;
      continue;
    }
    if (line.startsWith('[')) {
      const close = line.lastIndexOf(']');
      tablePath = close > 0 ? parseDottedKey(line.slice(1, close)) : null;
      // An alias exists from its header, even with no field of its own.
      if (tablePath?.[0] === 'models' && tablePath.length >= 2) fieldsOf(fieldsByAlias, tablePath[1]);
      continue;
    }
    if (tablePath === null) continue;

    const equals = findUnquoted(line, '=');
    if (equals <= 0) continue;
    const keyPath = parseDottedKey(line.slice(0, equals));
    if (!keyPath) continue;
    let rawValue = line.slice(equals + 1).trim();
    // A multi-line string holds no field this reads, and its lines are not keys.
    const stringDelimiter = rawValue.startsWith('"""') ? '"""' : rawValue.startsWith("'''") ? "'''" : null;
    if (stringDelimiter) {
      if (!rawValue.slice(3).includes(stringDelimiter)) {
        while (index + 1 < lines.length && !lines[index + 1].includes(stringDelimiter)) index += 1;
        index += 1;
      }
      continue;
    }
    // A multi-line array runs until its closing bracket.
    if (rawValue.startsWith('[') && !arrayClosed(rawValue)) {
      while (index + 1 < lines.length && !arrayClosed(rawValue)) {
        index += 1;
        rawValue += ' ' + stripComment(lines[index]).trim();
      }
    }
    const value = parseValue(rawValue);
    if (value === undefined) continue;
    // A dotted key is the table path written on the key's own line.
    const fullPath = [...tablePath, ...keyPath];
    const key = fullPath[fullPath.length - 1];
    const table = fullPath.slice(0, -1);

    if (table.length === 0) {
      if (key === 'default_model' && typeof value === 'string' && value.length > 0) defaultModel = value;
      continue;
    }
    if (table[0] !== 'models' || table.length < 2) continue;
    const alias = table[1];
    if (table.length === 2) {
      fieldsOf(fieldsByAlias, alias).set(key, value);
    } else if (table.length === 3 && table[2] === 'overrides') {
      fieldsOf(fieldsByAlias, alias);
      fieldsOf(overridesByAlias, alias).set(key, value);
    }
  }

  const models: KimiModelEntry[] = [];
  for (const [alias, fields] of fieldsByAlias) {
    const overrides = overridesByAlias.get(alias);
    const field = (name: string): TomlScalar | undefined => overrides?.get(name) ?? fields.get(name);
    const displayName = field('display_name');
    const maxContextSize = field('max_context_size');
    const supportEfforts = field('support_efforts');
    const defaultEffort = field('default_effort');
    models.push({
      alias,
      displayName: typeof displayName === 'string' && displayName.trim().length > 0 ? displayName.trim() : null,
      maxContextSize: typeof maxContextSize === 'number' && maxContextSize > 0 ? maxContextSize : null,
      supportEfforts: Array.isArray(supportEfforts) ? supportEfforts.filter((effort) => effort.length > 0) : [],
      defaultEffort: typeof defaultEffort === 'string' && defaultEffort.length > 0 ? defaultEffort : null,
    });
  }
  return { defaultModel, models };
}

function fieldsOf(map: Map<string, Map<string, TomlScalar>>, alias: string): Map<string, TomlScalar> {
  let fields = map.get(alias);
  if (!fields) {
    fields = new Map();
    map.set(alias, fields);
  }
  return fields;
}

/** The line up to a `#` that is not inside a string. */
function stripComment(line: string): string {
  const hash = findUnquoted(line, '#');
  return hash === -1 ? line : line.slice(0, hash);
}

/** Index of `target` outside any quoted string, or -1. */
function findUnquoted(text: string, target: string): number {
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (quote === '"' && character === '\\') {
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === target) return index;
  }
  return -1;
}

/** Split a dotted key (`models."kimi-code/k3".overrides`) into its parts, or null. */
function parseDottedKey(text: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  const source = text.trim();
  while (index < source.length) {
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    const character = source[index];
    let part: string;
    if (character === '"' || character === "'") {
      const close = findClosingQuote(source, index);
      if (close === -1) return null;
      part = character === '"' ? unescapeBasic(source.slice(index + 1, close)) : source.slice(index + 1, close);
      index = close + 1;
    } else {
      const match = /^[A-Za-z0-9_-]+/.exec(source.slice(index));
      if (!match) return null;
      part = match[0];
      index += part.length;
    }
    parts.push(part);
    while (source[index] === ' ' || source[index] === '\t') index += 1;
    if (index >= source.length) break;
    if (source[index] !== '.') return null;
    index += 1;
  }
  return parts.length > 0 ? parts : null;
}

function findClosingQuote(text: string, openIndex: number): number {
  const quote = text[openIndex];
  for (let index = openIndex + 1; index < text.length; index += 1) {
    if (quote === '"' && text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return -1;
}

function unescapeBasic(text: string): string {
  return text.replace(/\\(["\\/bfnrt])/g, (_match, escaped: string) => {
    switch (escaped) {
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      default: return escaped;
    }
  });
}

function arrayClosed(rawValue: string): boolean {
  return findUnquoted(rawValue, ']') !== -1;
}

/** A string, integer, boolean or string array; undefined for anything else. */
function parseValue(raw: string): TomlScalar | undefined {
  const value = raw.trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const close = findClosingQuote(value, 0);
    if (close === -1) return undefined;
    const inner = value.slice(1, close);
    return value[0] === '"' ? unescapeBasic(inner) : inner;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d[\d_]*$/.test(value)) return Number(value.replaceAll('_', ''));
  if (value.startsWith('[')) {
    const close = findUnquoted(value, ']');
    if (close === -1) return undefined;
    const items: string[] = [];
    let rest = value.slice(1, close);
    while (rest.trim().length > 0) {
      rest = rest.trim();
      if (rest.startsWith(',')) {
        rest = rest.slice(1);
        continue;
      }
      if (rest[0] !== '"' && rest[0] !== "'") return undefined;
      const end = findClosingQuote(rest, 0);
      if (end === -1) return undefined;
      const inner = rest.slice(1, end);
      items.push(rest[0] === '"' ? unescapeBasic(inner) : inner);
      rest = rest.slice(end + 1);
    }
    return items;
  }
  return undefined;
}
