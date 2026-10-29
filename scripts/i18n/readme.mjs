/**
 * The translated READMEs (`i18n/README.<locale>.md`): the language switcher
 * every README carries, the stamp each translation opens with, the checks a
 * translation passes before it is written, and the link rewrite that moves it
 * into its folder. translate-readme.mjs runs them;
 * docs/contributing/translations.md is the guide.
 *
 * Pure functions with no file or git access, so tests/unit/readme-translations.test.ts
 * drives them directly.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { glossaryErrors, relevantTerms } from './glossary.mjs';

/**
 * The folder the translations live in, from the repo root. One folder keeps 14
 * files out of the root listing GitHub shows above the README.
 */
export const TRANSLATIONS_DIRECTORY = 'i18n';
/** The English README as a translation links it. */
const ENGLISH_HREF = path.posix.relative(TRANSLATIONS_DIRECTORY, 'README.md');

const SWITCHER_START = '<!-- language-switcher -->';
const SWITCHER_END = '<!-- /language-switcher -->';
const STAMP_LINE = /^<!-- readme-translation source-blob=([0-9a-f]{40}) -->$/;
const SHORT_HASH_LENGTH = 7;

/** The notice every translation opens with, before translation. The script fills both tokens. */
export const ENGLISH_NOTICE = 'This is a machine translation of {readme} at {revision}. The English version is the canonical one.';
const NOTICE_TOKENS = ['{readme}', '{revision}'];

/**
 * Names the README uses that stay as written in every language, beyond the
 * glossary's kept names: the agent CLIs as the Supported agents list names them,
 * products, platforms and files. A name counts only where the English uses it.
 * The Settings path stays English because Kangentic starts in English, so that is
 * the menu a reader finds before switching.
 */
export const README_KEEP = [
  'Settings > Language',
  'Antigravity CLI',
  'Codex CLI',
  'Cursor CLI',
  'Cursor',
  'Factory Droid',
  'GitHub Copilot CLI',
  'Goose CLI',
  'Grok Build',
  'Kimi Code',
  'Warp (Oz CLI)',
  'Claude Desktop',
  'Kangentic Mobile',
  'GitHub Issues',
  'GitHub Projects',
  'GitHub Discussions',
  'App Store',
  'Google Play',
  'AGPL-3.0',
  'Aptabase',
  'SQLite',
  'Node.js',
  'macOS',
  'Linux',
  'Windows',
  'CLA',
  'CONTRIBUTING.md',
  'SECURITY.md',
];

export function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

/** The id git gives `text` as a blob, which is what `git hash-object README.md` prints for an LF file. */
export function gitBlobHash(text) {
  const content = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
}

/** The short form of a blob hash the notice shows. */
export function shortHash(blob) {
  return blob.slice(0, SHORT_HASH_LENGTH);
}

/** A README's path from the repo root, with `/` separators: README.md, or `i18n/README.<locale>.md`. */
export function readmeFileName(locale, sourceLocale) {
  return locale === sourceLocale ? 'README.md' : `${TRANSLATIONS_DIRECTORY}/README.${locale}.md`;
}

/** The href from one README to another, relative to the folder the first one sits in. */
function readmeHref(fromLocale, toLocale, sourceLocale) {
  const fromDirectory = path.posix.dirname(readmeFileName(fromLocale, sourceLocale));
  return path.posix.relative(fromDirectory, readmeFileName(toLocale, sourceLocale));
}

/**
 * The switcher for the README in `currentLocale`: every shipped language by its
 * own name, in `shippedLocales` order, separated by `|`. The current one is plain
 * text and the others link to their README, relative to this one's folder. HTML,
 * because a Markdown link does not render inside an HTML block.
 */
export function renderSwitcher(currentLocale, shippedLocales, nativeNames, sourceLocale) {
  const entries = shippedLocales.map((locale) => (
    locale === currentLocale ? nativeNames[locale] : `<a href="${readmeHref(currentLocale, locale, sourceLocale)}">${nativeNames[locale]}</a>`
  ));
  const lines = entries.map((entry, index) => `  ${entry}${index < entries.length - 1 ? ' |' : ''}`);
  return [SWITCHER_START, '<p align="center">', ...lines, '</p>', SWITCHER_END].join('\n');
}

/** Where the one switcher block starts and ends, or null unless there is exactly one, start marker first. */
function switcherBounds(markdown) {
  const start = markdown.indexOf(SWITCHER_START);
  const end = markdown.indexOf(SWITCHER_END);
  const isSingle = start !== -1 && end > start
    && markdown.indexOf(SWITCHER_START, start + 1) === -1
    && markdown.indexOf(SWITCHER_END, end + 1) === -1;
  return isSingle ? { start, end: end + SWITCHER_END.length } : null;
}

/** `markdown` with its one switcher block replaced by `block`. Throws when there is not exactly one. */
export function replaceSwitcher(markdown, block) {
  const bounds = switcherBounds(markdown);
  if (!bounds) throw new Error(`Expected exactly one ${SWITCHER_START} ... ${SWITCHER_END} block`);
  return markdown.slice(0, bounds.start) + block + markdown.slice(bounds.end);
}

/**
 * README.md as the model sees it: LF line endings and the switcher block emptied
 * to its two markers. Two READMEs that differ only in their switcher give the same
 * text, so a switcher change never makes a translation stale.
 */
export function translatableSource(readme) {
  return replaceSwitcher(normalizeNewlines(readme), `${SWITCHER_START}\n${SWITCHER_END}`);
}

function stampLine(blob) {
  return `<!-- readme-translation source-blob=${blob} -->`;
}

/**
 * A translation file: the stamp (a marker carrying README.md's blob, then the
 * notice as a quote line), a blank line, and the translated body.
 */
export function composeTranslation({ blob, notice, body }) {
  const filledNotice = notice
    .replace('{readme}', `[README.md](${ENGLISH_HREF})`)
    .replace('{revision}', `\`${shortHash(blob)}\``);
  return `${stampLine(blob)}\n> ${filledNotice}\n\n${body.replace(/\s+$/, '')}\n`;
}

/** The README.md blob a translation's stamp names, or null when it has none. */
export function readStamp(markdown) {
  const firstLine = normalizeNewlines(markdown).split('\n', 1)[0];
  return STAMP_LINE.exec(firstLine)?.[1] ?? null;
}

/**
 * A translation stamped with `blob` in place of its old one, with nothing else changed.
 * Throws when there is no stamp, or the notice no longer shows the old short hash.
 */
export function restamp(markdown, blob) {
  const lines = normalizeNewlines(markdown).split('\n');
  const oldBlob = readStamp(markdown);
  if (!oldBlob) throw new Error('The translation has no stamp to replace');
  const oldRevision = `\`${shortHash(oldBlob)}\``;
  if (!lines[1]?.includes(oldRevision)) throw new Error(`The notice on line 2 does not show ${oldRevision}, so the restamp cannot update it`);
  lines[0] = stampLine(blob);
  lines[1] = lines[1].replace(oldRevision, `\`${shortHash(blob)}\``);
  return lines.join('\n');
}

const FENCE = /^\s*```/;
const INLINE_CODE = /`[^`\n]+`/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// A quoted attribute value may hold < or >, as a translated alt text can.
const HTML_TAG = /<\/?[a-zA-Z](?:[^<>"']|"[^"\n]*"|'[^'\n]*')*>/g;
const ALT_ATTRIBUTE = /\balt="([^"]*)"/g;
const MARKDOWN_TARGET = /\]\(([^)\s]+)\)/g;
const BARE_URL = /https?:\/\/[^\s"'<>()\]]+/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const NUMBER = /\d+(?:\.\d+)*/g;

function documentLines(markdown) {
  return normalizeNewlines(markdown).replace(/\s+$/, '').split('\n');
}

/** A link target with a scheme (https:, mailto:), a fragment alone, or a site-absolute path. */
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|#|\/)/i;
const LINK_TARGET_IN_TEXT = /(\]\()([^)\s]+)(\))|(\b(?:href|src)=")([^"]+)(")/g;

function relocateTarget(target, directory) {
  if (NOT_RELATIVE.test(target)) return target;
  const fragmentStart = target.indexOf('#');
  const targetPath = fragmentStart === -1 ? target : target.slice(0, fragmentStart);
  const fragment = fragmentStart === -1 ? '' : target.slice(fragmentStart);
  return `${path.posix.relative(directory, targetPath)}${fragment}`;
}

/**
 * `markdown`, written against the repo root, with every relative link target
 * rewritten for a file in `directory`: `LICENSE` becomes `../LICENSE` in `i18n/`.
 * Markdown link targets and `href`/`src` attributes move, while URLs, fragments,
 * fenced blocks and inline code stay as written. The model translates against
 * README.md's own links, so the checks compare like with like, and the
 * translation moves into its folder only when it is written.
 */
export function relocateLinks(markdown, directory = TRANSLATIONS_DIRECTORY) {
  let inFence = false;
  return normalizeNewlines(markdown).split('\n').map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    // Odd parts are inline code spans, which keep their text.
    return line.split(/(`[^`\n]+`)/).map((part, index) => (index % 2 === 1 ? part : part.replace(
      LINK_TARGET_IN_TEXT,
      (match, markdownOpen, markdownTarget, markdownClose, attributeOpen, attributeTarget, attributeClose) => (markdownOpen
        ? `${markdownOpen}${relocateTarget(markdownTarget, directory)}${markdownClose}`
        : `${attributeOpen}${relocateTarget(attributeTarget, directory)}${attributeClose}`),
    ))).join('');
  }).join('\n');
}

function altTextsOf(tag) {
  return [...tag.matchAll(ALT_ATTRIBUTE)].map((match) => match[1]);
}

/**
 * What a translation must keep, and its prose for the glossary checks. Each kind
 * is cut out before the next is matched (code, comments, link targets, URLs,
 * emails, tags), so a URL inside a code span is counted once, as code.
 */
function documentParts(markdown) {
  const fencedBlocks = [];
  const outsideLines = [];
  let openBlock = null;
  for (const line of documentLines(markdown)) {
    if (FENCE.test(line)) {
      if (openBlock) {
        openBlock.push(line);
        fencedBlocks.push(openBlock.join('\n'));
        openBlock = null;
      } else {
        openBlock = [line];
      }
      outsideLines.push('');
    } else if (openBlock) {
      openBlock.push(line);
      outsideLines.push('');
    } else {
      outsideLines.push(line);
    }
  }
  if (openBlock) fencedBlocks.push(openBlock.join('\n'));
  const outside = outsideLines.join('\n');
  const codeSpans = outside.match(INLINE_CODE) ?? [];
  const withoutCode = outside.replace(INLINE_CODE, ' ');
  const comments = withoutCode.match(HTML_COMMENT) ?? [];
  const withoutComments = withoutCode.replace(HTML_COMMENT, ' ');
  const tags = withoutComments.match(HTML_TAG) ?? [];
  const altTexts = tags.flatMap(altTextsOf);
  const targets = [...withoutComments.matchAll(MARKDOWN_TARGET)].map((match) => match[1]);
  const withoutTargets = withoutComments.replace(MARKDOWN_TARGET, '] ');
  const urls = (withoutTargets.match(BARE_URL) ?? []).map((url) => url.replace(/[.,;:]+$/, ''));
  const withoutUrls = withoutTargets.replace(BARE_URL, ' ');
  const emails = withoutUrls.match(EMAIL) ?? [];
  const prose = withoutUrls
    .replace(EMAIL, ' ')
    .replace(HTML_TAG, (tag) => ` ${altTextsOf(tag).join(' ')} `);
  return {
    fencedBlocks,
    codeSpans,
    comments,
    tags: tags.map((tag) => tag.replace(ALT_ATTRIBUTE, 'alt=""')),
    altTexts,
    links: [...targets, ...urls, ...emails],
    prose,
  };
}

/** The Markdown or HTML a line starts with, which a line-for-line translation keeps. */
function lineLead(line) {
  const trimmed = line.trim();
  if (trimmed === '') return 'a blank line';
  if (FENCE.test(trimmed)) return 'a code fence';
  const heading = /^(#{1,6}) /.exec(trimmed);
  if (heading) return `a level ${heading[1].length} heading`;
  if (/^[-*] /.test(trimmed)) return 'a list item';
  const numbered = /^(\d+)\. /.exec(trimmed);
  if (numbered) return `list item ${numbered[1]}.`;
  if (trimmed.startsWith('>')) return 'a quote';
  if (trimmed.startsWith('<!--')) return 'an HTML comment';
  const tag = /^<(\/?[a-zA-Z][\w-]*)/.exec(trimmed);
  if (tag) return `<${tag[1]}>`;
  return 'text';
}

/** Items of `expected` that `actual` lacks, and items of `actual` that `expected` lacks, counting repeats. */
function multisetDifference(expected, actual) {
  const counts = new Map();
  for (const item of expected) counts.set(item, (counts.get(item) ?? 0) + 1);
  const extra = [];
  for (const item of actual) {
    const count = counts.get(item) ?? 0;
    if (count > 0) counts.set(item, count - 1);
    else extra.push(item);
  }
  const missing = [...counts].flatMap(([item, count]) => Array.from({ length: count }, () => item));
  return { missing, extra };
}

const LISTED_ITEMS = 5;

function listed(items) {
  const shown = items.slice(0, LISTED_ITEMS).map((item) => `"${item}"`).join(', ');
  return items.length > LISTED_ITEMS ? `${shown} and ${items.length - LISTED_ITEMS} more` : shown;
}

function keptDifference(problems, what, expected, actual) {
  const { missing, extra } = multisetDifference(expected, actual);
  if (missing.length > 0) problems.push(`copy every ${what} exactly as in the English; missing ${listed(missing)}`);
  if (extra.length > 0) problems.push(`the English has no ${what} ${listed(extra)}`);
}

/** The glossary entries the README's English uses, as the request sends them. */
export function documentTerms(source, locale, glossary) {
  const sourceProse = documentParts(source).prose;
  const { kept, fixed } = relevantTerms(sourceProse, locale, glossary);
  const readmeKept = README_KEEP.filter((name) => sourceProse.includes(name) && !kept.includes(name));
  return { keep: [...kept, ...readmeKept], terms: fixed.map((entry) => ({ english: entry.english, use: entry.term })) };
}

/**
 * What is wrong with a translation of `source` (README.md's translatable text)
 * and of the notice, as sentences the model can act on. Empty when it may be
 * written.
 */
export function readmeProblems({ source, translated, notice, locale, glossary }) {
  const problems = [];
  const sourceLines = documentLines(source);
  const translatedLines = documentLines(translated);
  if (sourceLines.length !== translatedLines.length) {
    problems.push(`keep the document line for line: the English has ${sourceLines.length} lines and the translation has ${translatedLines.length}`);
  }
  const leadMismatches = [];
  for (let index = 0; index < Math.min(sourceLines.length, translatedLines.length); index += 1) {
    const expected = lineLead(sourceLines[index]);
    const actual = lineLead(translatedLines[index]);
    if (expected !== actual) leadMismatches.push(`line ${index + 1} should start as ${expected}, not ${actual}`);
  }
  if (leadMismatches.length > 0) problems.push(`keep each line's Markdown: ${leadMismatches.slice(0, LISTED_ITEMS).join('; ')}`);
  const countHeadings = (lines) => lines.filter((line) => /^#{1,6} /.test(line.trim())).length;
  const sourceHeadings = countHeadings(sourceLines);
  const translatedHeadings = countHeadings(translatedLines);
  if (sourceHeadings !== translatedHeadings) {
    problems.push(`the English has ${sourceHeadings} headings and the translation has ${translatedHeadings}`);
  }

  const sourceParts = documentParts(source);
  const translatedParts = documentParts(translated);
  const blocksMatch = sourceParts.fencedBlocks.length === translatedParts.fencedBlocks.length
    && sourceParts.fencedBlocks.every((block, index) => block === translatedParts.fencedBlocks[index]);
  if (!blocksMatch) problems.push('copy every fenced code block exactly as in the English, in the same order');
  keptDifference(problems, 'inline code span', sourceParts.codeSpans, translatedParts.codeSpans);
  keptDifference(problems, 'URL, link target or email address', sourceParts.links, translatedParts.links);
  keptDifference(problems, 'HTML tag (only alt text is translated)', sourceParts.tags, translatedParts.tags);
  keptDifference(problems, 'HTML comment', sourceParts.comments, translatedParts.comments);
  // The comment check counts the two markers but not their order, and the script
  // renders the switcher between them.
  if (switcherBounds(source) && !switcherBounds(translated)) {
    problems.push(`keep the language switcher block as in the English: the ${SWITCHER_START} line, then the ${SWITCHER_END} line`);
  }
  if (translatedParts.altTexts.some((altText) => altText.trim() === '')) problems.push('translate every alt text; none may be empty');

  problems.push(...glossaryErrors({ english: sourceParts.prose, translated: translatedParts.prose, locale, glossary }));
  for (const name of README_KEEP) {
    if (sourceParts.prose.includes(name) && !translatedParts.prose.includes(name)) problems.push(`keep the name "${name}" exactly as written`);
  }
  // Only the missing direction: a translation may write a number the English spells out.
  const { missing: missingNumbers } = multisetDifference(sourceParts.prose.match(NUMBER) ?? [], translatedParts.prose.match(NUMBER) ?? []);
  if (missingNumbers.length > 0) problems.push(`keep every number and version as in the English; missing ${listed(missingNumbers)}`);

  if (/\n/.test(notice) || notice.trim() === '') problems.push('the notice must be one non-empty line');
  const noticeParts = documentParts(notice);
  if ([...noticeParts.codeSpans, ...noticeParts.links, ...noticeParts.tags, ...noticeParts.comments].length > 0) {
    problems.push('the notice holds only words and the two tokens: no link, URL, HTML or code');
  }
  for (const token of NOTICE_TOKENS) {
    const count = notice.split(token).length - 1;
    if (count !== 1) problems.push(`the notice must hold ${token} exactly once, as written`);
  }
  return problems;
}
