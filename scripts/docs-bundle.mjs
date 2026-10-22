/**
 * Helpers for docs/ as an Open Knowledge Format v0.2 bundle (see docs/index.md): frontmatter, the
 * GitHub heading slug, heading and link extraction, and the concept list. The conformance test
 * (tests/unit/okf-docs-conformance.test.ts) and /sync-docs read the bundle through these, so the
 * two cannot disagree about what a heading's anchor is or what a concept's sources are.
 *
 *   node scripts/docs-bundle.mjs sources <repo path>...
 *
 * prints, for each path, the concepts whose `sources:` cover it: an entry that names the file, or a
 * directory the file sits under. /sync-docs uses it to map a changed source file to its docs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');
export const DOCS_ROOT = path.join(PROJECT_ROOT, 'docs');
/** The two names OKF reserves at every level. Neither is a concept. */
export const RESERVED_NAMES = new Set(['index.md', 'log.md']);
/** The `type` values a concept may carry. */
export const CONCEPT_TYPES = ['Guide', 'Reference', 'Design', 'Audit', 'Research'];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
const FENCE = /^\s*(```|~~~)/;

/** A scalar as YAML writes it here: bare, or double or single quoted. */
function parseScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  if (value.length >= 2 && value.startsWith('\'') && value.endsWith('\'')) {
    return value.slice(1, -1).replace(/''/g, '\'');
  }
  return value;
}

/** `[a, "b c"]` as a list of strings. */
function parseInlineList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner.length === 0) return [];
  return inner.split(',').map(parseScalar);
}

/**
 * The frontmatter of a markdown file, or null when it has none. Reads the subset this bundle writes:
 * scalar keys, inline lists, and block lists of scalars or of flat mappings (`sources:`). Anything
 * else throws, so a hand edit the parser would misread fails loudly instead of passing as empty.
 */
export function parseFrontmatter(text) {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const data = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1;
      continue;
    }
    const keyMatch = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!keyMatch) throw new Error(`frontmatter line ${index + 1} is not a top-level key: ${line}`);
    const [, key, rest] = keyMatch;
    const value = rest.trim();
    index += 1;
    if (value.startsWith('[')) {
      data[key] = parseInlineList(value);
      continue;
    }
    if (value !== '') {
      data[key] = parseScalar(value);
      continue;
    }
    const items = [];
    while (index < lines.length && /^\s+-\s/.test(lines[index])) {
      const first = lines[index].replace(/^\s+-\s+/, '');
      index += 1;
      const pair = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(first);
      if (!pair) {
        items.push(parseScalar(first));
        continue;
      }
      const item = { [pair[1]]: parseScalar(pair[2]) };
      while (index < lines.length && /^\s{4,}[A-Za-z_][\w-]*:/.test(lines[index]) && !/^\s+-\s/.test(lines[index])) {
        const more = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index]);
        item[more[1]] = parseScalar(more[2]);
        index += 1;
      }
      items.push(item);
    }
    data[key] = items;
  }
  return data;
}

/** The text after the frontmatter block, or the whole text when there is none. */
export function stripFrontmatter(text) {
  const match = FRONTMATTER.exec(text);
  return match ? text.slice(match[0].length) : text;
}

function quoteIfNeeded(value) {
  const text = String(value);
  const needsQuotes = text === '' || /^[\s[\]{}>|*&!%@`'"#,?-]/.test(text) || /:\s|\s#|:$|^\s|\s$/.test(text);
  return needsQuotes ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : text;
}

/** Frontmatter in the shape `parseFrontmatter` reads back, keys in the order given. */
export function formatFrontmatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.every((item) => typeof item === 'string')) {
        lines.push(`${key}: [${value.map(quoteIfNeeded).join(', ')}]`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) {
        const entries = Object.entries(item);
        entries.forEach(([itemKey, itemValue], position) => {
          lines.push(`${position === 0 ? '  - ' : '    '}${itemKey}: ${quoteIfNeeded(itemValue)}`);
        });
      }
      continue;
    }
    lines.push(`${key}: ${quoteIfNeeded(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

/**
 * A heading's rendered text: links to their text, emphasis markers and HTML tags dropped, and inline
 * code kept as written (GitHub renders `<id>` inside backticks as text).
 */
export function headingText(raw) {
  const withoutLinks = raw.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  return withoutLinks
    .split(/(`+[^`]*`+)/)
    .map((part) => (part.startsWith('`')
      ? part.replace(/^`+|`+$/g, '')
      : part.replace(/<[^>]+>/g, '').replace(/\*/g, '').replace(/(^|\s)_+|_+(\s|$)/g, '$1$2')))
    .join('')
    .trim();
}

/** GitHub's anchor for a heading's text, before the duplicate suffix. */
export function githubSlug(text) {
  return headingText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/**
 * Every ATX heading outside a code fence, with GitHub's anchor including the `-1`, `-2` suffix a
 * repeated heading gets: `{ level, text, line, slug }`.
 */
export function headingsOf(text) {
  const headings = [];
  // github-slugger's dedupe: a taken slug gets the next free `-N` counted on its base.
  const occurrences = new Map();
  let fenced = false;
  stripFrontmatter(text).split(/\r?\n/).forEach((line, lineIndex) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) return;
    const base = githubSlug(match[2]);
    let slug = base;
    while (occurrences.has(slug)) {
      occurrences.set(base, occurrences.get(base) + 1);
      slug = `${base}-${occurrences.get(base)}`;
    }
    occurrences.set(slug, 0);
    headings.push({ level: match[1].length, text: match[2], line: lineIndex, slug });
  });
  return headings;
}

/** Every heading anchor in a file's text. */
export function anchorsOf(text) {
  return new Set(headingsOf(text).map((heading) => heading.slug));
}

/**
 * Every inline markdown link or image outside code fences and inline code:
 * `{ url, path, fragment, line }`, with `path` empty for a same-file `#fragment` link.
 */
export function linksOf(text) {
  const links = [];
  let fenced = false;
  text.split(/\r?\n/).forEach((line, lineIndex) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const outsideCode = line.replace(/(`+)[\s\S]*?\1/g, (span) => ' '.repeat(span.length));
    for (const match of outsideCode.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const url = match[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
      const hash = url.indexOf('#');
      links.push({
        url,
        path: hash === -1 ? url : url.slice(0, hash),
        fragment: hash === -1 ? null : decodeURIComponent(url.slice(hash + 1)),
        line: lineIndex + 1,
        column: match.index,
        length: match[0].length,
      });
    }
  });
  return links;
}

/** Every markdown file under docs/, as '/'-separated paths relative to the repo root. */
export function listDocsMarkdown(docsRoot = DOCS_ROOT) {
  const root = path.dirname(docsRoot);
  return fs.readdirSync(docsRoot, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => path.relative(root, path.join(docsRoot, entry)).replace(/\\/g, '/'))
    .sort();
}

/** Whether a docs path is a concept (any markdown file but the two reserved names). */
export function isConceptPath(docPath) {
  return !RESERVED_NAMES.has(path.posix.basename(docPath));
}

/** Every concept with its frontmatter: `{ path, frontmatter }`. */
export function listConcepts(docsRoot = DOCS_ROOT) {
  const root = path.dirname(docsRoot);
  return listDocsMarkdown(docsRoot)
    .filter(isConceptPath)
    .map((docPath) => ({ path: docPath, frontmatter: parseFrontmatter(fs.readFileSync(path.join(root, docPath), 'utf8')) }));
}

/** A `sources:` entry's repo path: an entry is `{ resource, title? }`, or a bare string. */
export function sourcePathOf(entry) {
  return typeof entry === 'string' ? entry : entry?.resource ?? '';
}

/** The concepts whose sources cover `repoPath`: the file itself, or a directory above it. */
export function conceptsForSource(repoPath, concepts) {
  const target = repoPath.replace(/\\/g, '/').replace(/^\.\//, '');
  return concepts.filter((concept) => (concept.frontmatter?.sources ?? []).some((entry) => {
    const source = sourcePathOf(entry).replace(/\\/g, '/');
    if (source.length === 0) return false;
    if (source.endsWith('/')) return target.startsWith(source);
    return target === source || target.startsWith(`${source}/`);
  }));
}

function main(argv) {
  const [mode, ...paths] = argv;
  if (mode !== 'sources' || paths.length === 0) {
    console.error('usage: node scripts/docs-bundle.mjs sources <repo path>...');
    return 2;
  }
  const concepts = listConcepts();
  for (const repoPath of paths) {
    const covering = conceptsForSource(repoPath, concepts);
    console.log(`${repoPath}: ${covering.length === 0 ? '(no concept lists it)' : covering.map((concept) => concept.path).join(', ')}`);
  }
  return 0;
}

if (isEntrypoint(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
