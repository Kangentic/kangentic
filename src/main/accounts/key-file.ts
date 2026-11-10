import fs from 'node:fs';

/**
 * A key-file account points at a file the user owns. Kangentic stores only its path
 * and the variable names in it; the key itself is read at spawn into that session's env and is
 * never written to config, the database, a log, the mobile bridge or a crash report.
 */

export interface KeyFileContents {
  /** The names found, in file order. Safe to store and show. */
  names: string[];
  /** Name to value, for the spawn env only. Never log or persist this. */
  values: Record<string, string>;
}

/**
 * A line's value as a `.env` reader takes it: the text inside matching quotes, with anything
 * after the closing quote dropped, or for an unquoted value everything up to a ` #` comment.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closing = trimmed.indexOf(quote, 1);
    if (closing > 0) return trimmed.slice(1, closing);
  }
  return trimmed.replace(/\s+#.*$/, '');
}

/**
 * Parses `.env` lines (`NAME=value`, an optional `export `, `#` comments), keeping only `allowed`
 * names. An allowed name ending in `*` takes every name with that prefix, for a CLI that makes up
 * a variable per provider.
 */
export function parseKeyFileText(text: string, allowed: readonly string[]): KeyFileContents {
  const allowedNames = new Set(allowed.filter((name) => !name.endsWith('*')));
  const allowedPrefixes = allowed.filter((name) => name.endsWith('*')).map((name) => name.slice(0, -1));
  const names: string[] = [];
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (!allowedNames.has(name) && !allowedPrefixes.some((prefix) => prefix !== '' && name.startsWith(prefix))) continue;
    const value = unquote(rawValue);
    if (!value) continue;
    if (!(name in values)) names.push(name);
    values[name] = value;
  }
  return { names, values };
}

/** Reads a key file. Null when it is gone, unreadable, or holds none of the agent's variables. */
export function readKeyFile(filePath: string, allowed: readonly string[]): KeyFileContents | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  const contents = parseKeyFileText(text, allowed);
  return contents.names.length > 0 ? contents : null;
}
