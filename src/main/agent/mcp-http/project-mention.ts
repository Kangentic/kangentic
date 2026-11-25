/**
 * Finds where a task's title and description name another registered
 * project, for kangentic_create_task's routing check. Pure: it imports
 * nothing from Electron, the resolver or the database, so tests import it
 * directly.
 *
 * A mention counts only where a person would read it as the project's name.
 * Code spans, fenced code, URLs and path tokens are blanked out first. A hit
 * must be a standalone token, so a name inside `no-garden-rules.md`,
 * `foo/Garden/bar` or `garden.json` does not count. A name made of ordinary
 * capitalized words ("Garden", "Field Notes") matches only in its own case,
 * because the lowercase word is everyday prose.
 *
 * Each hit has a strength. A hit inside a targeting phrase ("on X's board",
 * "add it to X") is strong: the task is probably meant for that project. So is
 * any title hit of a name that reads as an identifier ("orbit-api"). A title
 * hit of a common-word name is strong only inside a targeting phrase, because
 * a capitalized title word ("Garden party invites") is as often prose as the
 * project. Any other hit is weak: "ported from X" or "see X PR 12" names a
 * source, not a destination.
 */

/**
 * How a user names a target project inside a request. The PROJECT ROUTING
 * RULE in the server instructions prints this list, and the matcher below
 * classifies each phrase as strong. tests/unit/project-mention.test.ts checks
 * that every listed phrase is strong and that the instructions print the list;
 * the matcher also rates a few shapes strong that the list does not name. The
 * one exception is the bare "in X": in a task description it is as often a
 * source ("the script in X") as a target, so it is strong only in the title.
 */
export const PROJECT_TARGETING_PHRASES = [
  'in X',
  'in the X board',
  "on X's board",
  'the X to do',
  "X's backlog",
  'add it to X',
] as const;

/**
 * Project names shorter than this are skipped. A one or two character name
 * (e.g. "QA") is too likely to collide with ordinary prose.
 */
export const MIN_PROJECT_NAME_MATCH_LENGTH = 3;

export type ProjectMentionStrength = 'strong' | 'weak';

/** Where the strongest hit for a project was found. */
export type ProjectMentionSource = 'title' | 'phrase' | 'mention';

export interface ProjectMention {
  /** The name as matched: trimmed, with runs of whitespace collapsed. */
  name: string;
  /** The name exactly as registered: the selector a re-run or a move must pass. */
  registeredName: string;
  strength: ProjectMentionStrength;
  where: ProjectMentionSource;
}

export interface MentionCandidate {
  name: string;
  isActive: boolean;
}

/** A line that opens or closes a fenced code block, and its marker. */
const FENCE_LINE = /^\s*(`{3,}|~{3,})/;
/**
 * An inline code span: a backtick run, then text on the same line, then a run
 * of the same length. Each run must be whole (no backtick on either side), so
 * a long run of backticks is scanned once rather than from every position.
 */
const INLINE_CODE = /(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g;
/**
 * A URL with a scheme, or a bare www. host. The scheme is capped at 32
 * characters, so a long dotted or hyphenated run is not rescanned from every
 * word boundary in it.
 */
const URL_TOKEN = /\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/\S+|\bwww\.\S+/g;
/** A whitespace-delimited token; blanked when it holds a path separator. */
const NON_SPACE_TOKEN = /\S+/g;
const PATH_SEPARATOR = /[\\/]/;

/** "X board", "X's backlog": a board noun right after a name makes it a destination. */
const BOARD_NOUN_AFTER = /^(?:'s|\u2019s)?\s(?:board|backlog)\b/i;
/**
 * "the X to do", "X's todo". Only with "the" before or a possessive, because
 * a bare "X to do" is ordinary English ("copied from X to do the parsing").
 */
const TODO_AFTER = /^\s(?:to do|todo)\b/i;
const POSSESSIVE_TODO_AFTER = /^(?:'s|\u2019s)\s(?:to do|todo)\b/i;
const THE_BEFORE = /\bthe\s$/i;
/**
 * "add it to X", "put a card under X", "move this task into X". Not "file",
 * which in a task description is far more often the noun ("the rules file in
 * X"). The words between the verb and the preposition stop at sentence
 * punctuation, so "add it. Then ported to X" is not a placement.
 */
const PLACING_VERB_BEFORE = /\b(?:add|put|move|create)\b(?:\s[^\s.!?]+){0,3}?\s(?:to|into|onto|under)\s$/i;
/**
 * "create a task in X", "add a new card in X". "in" places only a board item:
 * "add the helper in X" or "move the logic in X" names where code lives.
 */
const PLACING_ITEM_IN_BEFORE = /\b(?:add|put|move|create)\s(?:[^\s.!?]+\s){0,2}?(?:task|card|item|ticket|bug|issue)s?\sin\s$/i;
/** The bare "in X", a targeting phrase in a title only. */
const IN_BEFORE = /\bin\s$/i;

/**
 * Replace fenced code, inline code, URLs and path tokens with a space, so a
 * name inside them never matches. A space, not an empty string, so the text on
 * either side cannot join into a new token. Every pattern here runs in linear
 * time: a description is up to 27,500 characters and this runs on the main
 * thread for every create that omits `project`.
 */
function blankNonProse(text: string): string {
  const keptLines: string[] = [];
  let openFence: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fence = FENCE_LINE.exec(line);
    if (openFence !== null) {
      // A fence closes on a run of the same character at least as long.
      if (fence && fence[1][0] === openFence[0] && fence[1].length >= openFence.length) openFence = null;
      keptLines.push(' ');
      continue;
    }
    if (fence) {
      openFence = fence[1];
      keptLines.push(' ');
      continue;
    }
    keptLines.push(line);
  }
  return keptLines
    .join('\n')
    .replace(INLINE_CODE, ' ')
    .replace(URL_TOKEN, ' ')
    .replace(NON_SPACE_TOKEN, (token) => (PATH_SEPARATOR.test(token) ? ' ' : token))
    .replace(/\s+/g, ' ');
}

/**
 * True for a name made only of capitalized ordinary words ("Garden", "Field
 * Notes", "Éclair"). Such a name is also everyday prose, so it matches only in
 * its own case. A lowercase slug, camelCase, ALLCAPS, or a name with a digit,
 * hyphen or dot reads as an identifier and matches in any case.
 */
export function isCommonWordName(name: string): boolean {
  return name.split(' ').every((word) => /^\p{Lu}\p{Ll}+$/u.test(word));
}

/**
 * A regex that finds `name` as a standalone token. The left side must not
 * touch a letter, digit, `_` or `- . / \ @`; the right side must not touch a
 * letter, digit, `_` or `- / \`, nor a `.` that continues into a word (a
 * filename extension). Letters include accented ones. A sentence-final "X."
 * and the possessive "X's" still match.
 */
function buildNameRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s');
  const flags = isCommonWordName(name) ? 'gu' : 'giu';
  return new RegExp(`(?<![\\p{L}\\p{N}_\\-./\\\\@])${escaped}(?![\\p{L}\\p{N}_\\-/\\\\])(?!\\.[\\p{L}\\p{N}_])`, flags);
}

/** Whether the hit at `index` (length `length`) in `text` sits inside a targeting phrase. */
function isInTargetingPhrase(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 80), index);
  const after = text.slice(index + length, index + length + 20);
  if (BOARD_NOUN_AFTER.test(after) || POSSESSIVE_TODO_AFTER.test(after)) return true;
  if (THE_BEFORE.test(before) && TODO_AFTER.test(after)) return true;
  return PLACING_VERB_BEFORE.test(before) || PLACING_ITEM_IN_BEFORE.test(before);
}

/**
 * The strength of the title's hits on `name`, or null for none. Any hit of an
 * identifier-like name is strong. A common-word name is strong only inside a
 * targeting phrase, the bare "in X" included.
 */
function titleStrength(titleText: string, name: string): ProjectMentionStrength | null {
  const commonWord = isCommonWordName(name);
  let strength: ProjectMentionStrength | null = null;
  for (const match of titleText.matchAll(buildNameRegex(name))) {
    if (!commonWord) return 'strong';
    const before = titleText.slice(Math.max(0, match.index - 80), match.index);
    if (IN_BEFORE.test(before) || isInTargetingPhrase(titleText, match.index, match[0].length)) return 'strong';
    strength = 'weak';
  }
  return strength;
}

/** Whether a description hit on `name` is a targeting phrase, a bare mention, or absent. */
function descriptionStrength(descriptionText: string, name: string): ProjectMentionStrength | null {
  let strength: ProjectMentionStrength | null = null;
  for (const match of descriptionText.matchAll(buildNameRegex(name))) {
    if (isInTargetingPhrase(descriptionText, match.index, match[0].length)) return 'strong';
    strength = 'weak';
  }
  return strength;
}

/**
 * Return the registered projects, other than the active one, that the title
 * or description names, one entry per project in registration order, each
 * with its strongest hit: a strong title hit, then a targeting phrase in the
 * description, then a weak title hit, then a bare description mention.
 */
export function findProjectMentions(
  projects: readonly MentionCandidate[],
  title: string,
  description: string,
): ProjectMention[] {
  const titleText = blankNonProse(title);
  const descriptionText = blankNonProse(description);
  const mentions: ProjectMention[] = [];
  const seen = new Set<string>();
  for (const project of projects) {
    if (project.isActive) continue;
    // Match on the trimmed, whitespace-normalized name, and report the
    // registered name beside it for the selector the caller must pass.
    const name = project.name.trim().replace(/\s+/g, ' ');
    if (name.length < MIN_PROJECT_NAME_MATCH_LENGTH || seen.has(name)) continue;
    const inTitle = titleStrength(titleText, name);
    const base = { name, registeredName: project.name };
    let found: ProjectMention | null = null;
    if (inTitle === 'strong') {
      found = { ...base, strength: 'strong', where: 'title' };
    } else {
      const inDescription = descriptionStrength(descriptionText, name);
      if (inDescription === 'strong') found = { ...base, strength: 'strong', where: 'phrase' };
      else if (inTitle === 'weak') found = { ...base, strength: 'weak', where: 'title' };
      else if (inDescription === 'weak') found = { ...base, strength: 'weak', where: 'mention' };
    }
    if (found) {
      seen.add(name);
      mentions.push(found);
    }
  }
  return mentions;
}
