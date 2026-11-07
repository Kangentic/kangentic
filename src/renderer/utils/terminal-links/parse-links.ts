/**
 * Finds URLs and file path candidates in one logical terminal line. Pure, so the
 * providers stay thin and the grammar is testable without a terminal.
 *
 * Every pattern here runs on agent-printed text when the pointer enters a row,
 * so each is linear: a negated character class with no nested repetition. The
 * trim of a run of closers is not, and a logical line's length bounds it.
 */

import { MAX_LINK_PATHS_PER_ROW, MAX_PRINTED_PATH_LENGTH } from '../../../shared/terminal-link-limits';

/** A half-open range of string indices in the text that was parsed. */
export interface TextSpan {
  start: number;
  end: number;
}

export interface ParsedUrl extends TextSpan {
  url: string;
}

export interface ParsedPath extends TextSpan {
  /** The path as printed, without its `:line:column` suffix. */
  path: string;
  line: number | null;
  column: number | null;
}

// Whitespace, quotes and angle brackets, and the box-drawing, block and geometric
// glyphs TUIs draw borders and bullets with (U+23A0-U+23FF, U+2500-U+25FF).
const NOT_IN_TOKEN = '\\s"\'`<>|\\u23a0-\\u23ff\\u2500-\\u25ff';
const URL_PATTERN = new RegExp(`https?://[^${NOT_IN_TOKEN}]+`, 'gi');
const PATH_TOKEN_PATTERN = new RegExp(`[^${NOT_IN_TOKEN}]+`, 'g');
const QUOTED_PATTERN = new RegExp(`"([^"\\n]{1,${MAX_PRINTED_PATH_LENGTH}})"|'([^'\\n]{1,${MAX_PRINTED_PATH_LENGTH}})'`, 'g');
const CALL_SHAPED_TOKEN = /^([\w-]*)\((.+)\)$/;
const LOCATION_SUFFIX = /:(\d{1,7})(?::(\d{1,7}))?$/;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const OPENERS = '([{';
const CLOSERS = ')]}';

function trimTrailing(text: string): string {
  let trimmed = text.replace(TRAILING_PUNCTUATION, '');
  // A closer with no opener in the text belongs to the prose around it.
  while (trimmed.length > 0) {
    const closerIndex = CLOSERS.indexOf(trimmed[trimmed.length - 1]);
    if (closerIndex === -1) break;
    const opener = OPENERS[closerIndex];
    const closer = CLOSERS[closerIndex];
    if (trimmed.split(opener).length >= trimmed.split(closer).length) break;
    trimmed = trimmed.slice(0, -1).replace(TRAILING_PUNCTUATION, '');
  }
  return trimmed;
}

/** The index just past the last opener with no closer, so `Update(src/a.ts` starts at `src`. */
function startAfterUnmatchedOpener(text: string): number {
  const stack: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (OPENERS.includes(text[index])) {
      stack.push(index);
    } else if (CLOSERS.includes(text[index])) {
      stack.pop();
    }
  }
  return stack.length > 0 ? stack[stack.length - 1] + 1 : 0;
}

export function parseUrls(text: string): ParsedUrl[] {
  const urls: ParsedUrl[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = trimTrailing(match[0]);
    // A bare scheme, or one whose host was all punctuation.
    if (!/^https?:\/\/[^/?#]/i.test(url)) continue;
    urls.push({ url, start: match.index, end: match.index + url.length });
  }
  return urls;
}

function looksLikePath(candidate: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(candidate)) return true;
  if (/^\\\\/.test(candidate) || candidate.startsWith('//')) return /^[\\/]{2}wsl(\$|\.localhost)[\\/]/i.test(candidate);
  if (candidate.startsWith('/')) return candidate.length > 1;
  if (/^~[\\/]/.test(candidate)) return true;
  if (/^\.{1,2}[\\/]/.test(candidate)) return candidate.length > 3;
  if (/[\\/]/.test(candidate)) return /[A-Za-z0-9_-]/.test(candidate) && !/^[\\/]+$/.test(candidate);
  // A bare name needs an extension: `package.json` yes, `done` no.
  return /^[\w.-]*[\w-]\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(candidate);
}

function overlapsAny(start: number, end: number, spans: readonly TextSpan[]): boolean {
  return spans.some((span) => start < span.end && span.start < end);
}

/** A token's path with any location suffix split off, or null when it is not a path. */
function parsePathToken(token: string, tokenStart: number): ParsedPath | null {
  let text = trimTrailing(token);
  let start = tokenStart;
  // An agent's tool line, `Update(src/app.ts)`. Balanced, so the trim above kept it.
  const callShape = CALL_SHAPED_TOKEN.exec(text);
  if (callShape) {
    start += callShape[1].length + 1;
    text = callShape[2];
  }
  const openerEnd = startAfterUnmatchedOpener(text);
  const lastEquals = text.lastIndexOf('=');
  // `--config=a/b.json` names a flag. `src/a=b/c.ts` has a folder before the `=`, so
  // the whole token is the path.
  const assignmentEnd = /[\\/]/.test(text.slice(openerEnd, Math.max(lastEquals, openerEnd))) ? 0 : lastEquals + 1;
  const skip = Math.max(openerEnd, assignmentEnd);
  if (skip > 0) {
    text = trimTrailing(text.slice(skip));
    start += skip;
  }
  const location = LOCATION_SUFFIX.exec(text);
  const path = location ? text.slice(0, location.index) : text;
  if (path.length === 0 || path.length > MAX_PRINTED_PATH_LENGTH || path.includes('://')) return null;
  if (!looksLikePath(path)) return null;
  return {
    path,
    line: location ? Number(location[1]) : null,
    column: location?.[2] ? Number(location[2]) : null,
    start,
    end: start + text.length,
  };
}

/** Path candidates that do not overlap a URL. Whether one exists is main's question. */
export function parsePaths(text: string, urls: readonly TextSpan[] = parseUrls(text)): ParsedPath[] {
  const paths: ParsedPath[] = [];
  const taken: TextSpan[] = [...urls];

  // A quoted path may hold spaces, so quotes go first and their span is taken.
  for (const match of text.matchAll(QUOTED_PATTERN)) {
    const inner = match[1] ?? match[2];
    if (!inner.includes(' ') || !/[\\/]/.test(inner)) continue;
    const start = match.index + 1;
    if (overlapsAny(start, start + inner.length, taken)) continue;
    const parsed = parsePathToken(inner, start);
    if (!parsed) continue;
    paths.push(parsed);
    taken.push({ start: match.index, end: match.index + match[0].length });
  }

  for (const match of text.matchAll(PATH_TOKEN_PATTERN)) {
    if (paths.length >= MAX_LINK_PATHS_PER_ROW) break;
    if (overlapsAny(match.index, match.index + match[0].length, taken)) continue;
    const parsed = parsePathToken(match[0], match.index);
    if (parsed) paths.push(parsed);
  }
  return paths.sort((first, second) => first.start - second.start).slice(0, MAX_LINK_PATHS_PER_ROW);
}
