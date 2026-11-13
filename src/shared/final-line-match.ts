/**
 * Text match: a Condition checked in code against the last line of the
 * agent's final message, with no Automation agent call.
 *
 * The board routes tasks on exact lines the agent writes last ("Findings:
 * applied", "Verdict: Ready"). Judged by a model, such a rule is a
 * measurement, never a guarantee; matched here, it is right by construction.
 *
 * The comparison forgives what an agent varies without meaning anything by it,
 * and nothing else:
 *
 *  - Case.
 *  - Punctuation and symbols, markdown marks included, so `**Verdict: Ready**`,
 *    `Verdict: Ready.` and `- Verdict: Ready` all read as `verdict ready`.
 *  - Characters that draw nothing on their own: zero-width spaces and joiners,
 *    a byte order mark, emoji variation selectors and keycaps. A check mark
 *    emoji before `Verdict: Ready` still reads as `verdict ready`, and a
 *    trailing zero-width space is not a line.
 *  - Runs of spaces.
 *
 * The line is the LAST one that still has a word in it after that, so a
 * closing code fence or a `---` rule after the real last line is skipped
 * rather than read as the answer. A line that appears only mid-message never
 * matches: the agent quoting the line it means to write is the miss this
 * check exists to rule out.
 *
 * In the pattern, `*` is a wildcard for any text, and the pattern still has to
 * cover the whole line: `Ready for *` starts with, `* for review` ends with,
 * `*review*` contains. The match walks the line once per wildcard, with no
 * regular expression, so no pattern a team file or an agent writes can stall
 * the main process on a long line.
 *
 * A Text match holds one pattern per line (stored joined by a line break). A
 * pattern that starts with `!` rules a line out. The row runs when the last
 * line matches any plain pattern and no `!` pattern; with only `!` patterns it
 * runs on any line but those. Order does not matter. The `!` is safe to read
 * as syntax because punctuation never reaches the comparison, so no line can
 * contain one; the one-time upgrade in `project-schema.ts` took a leading `!`
 * off every pattern saved before, when it meant nothing.
 *
 * Shared, not main-only: the runner, the eval harness
 * (`scripts/eval-condition-check.mjs`) and the tests all match through this
 * one function, so they cannot disagree about what a line means.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { TextMatchSource } from './types';

/**
 * The Text match field's placeholder, and the line the Patterns tip's examples
 * are built on. English: it stands for a line the agent writes, and the
 * examples are matched against it.
 */
export const TEXT_MATCH_PLACEHOLDER = 'Ready for review';

/**
 * The Your message tab's placeholder: a message a person types to move a card
 * on. English, as `TEXT_MATCH_PLACEHOLDER` is: it stands for text matched as
 * typed.
 */
export const TEXT_MATCH_USER_PLACEHOLDER = 'Signed off';

/**
 * The most patterns one Text match holds, and the longest one, as the MCP tools
 * refuse them. The board file and the dialog keep every pattern instead: cutting
 * one could drop a `!` line and run the row on lines it ruled out.
 */
export const TEXT_MATCH_MAX_PATTERNS = 20;
export const TEXT_MATCH_MAX_PATTERN_LENGTH = 500;

/** The longest Agent evaluation sentence the MCP tools take. */
export const AGENT_CONDITION_MAX_LENGTH = 2000;

/**
 * One example in the field's Patterns tip: the patterns (one per line, as the
 * field holds them), what they mean, and lines they must and must not match.
 */
export interface TextMatchExample {
  patterns: readonly string[];
  /** What the patterns mean. Resolve it where it shows. */
  rule: MessageDescriptor;
  /** Lines the patterns match. Never shown: a unit test holds the rule to the matcher. */
  matches: readonly string[];
  /** Lines the patterns do not match. Never shown, as `matches`. */
  misses: readonly string[];
}

/**
 * The Patterns tip's examples, each built on the placeholder so the tip reads
 * the same whatever was typed, and generic, never one board's own lines. Data
 * rather than markup so a unit test can hold each one to the real matcher.
 */
export const TEXT_MATCH_EXAMPLES: readonly TextMatchExample[] = [
  {
    patterns: ['Ready for *'],
    rule: msg`Starts with "Ready for"`,
    matches: ['Ready for testing', TEXT_MATCH_PLACEHOLDER],
    misses: ['Ready forever', 'Done'],
  },
  {
    patterns: ['!Ready for review'],
    rule: msg`Any line but this one`,
    matches: ['Still testing', 'Done'],
    misses: [TEXT_MATCH_PLACEHOLDER],
  },
  {
    patterns: ['Ready for *', 'Done'],
    rule: msg`Starts with "Ready for", or is "Done"`,
    matches: ['Ready for testing', 'Done'],
    misses: ['Still testing'],
  },
  {
    patterns: ['Ready for *', '!Ready for review'],
    rule: msg`Starts with "Ready for", but is not "Ready for review"`,
    matches: ['Ready for testing'],
    misses: [TEXT_MATCH_PLACEHOLDER, 'Done'],
  },
];

/**
 * Why Text match is unavailable on enter and exit. One line: it is the hover
 * tip on the dialog's disabled option (`translateText`), and the MCP and file
 * refusals reuse it in English (`englishText`).
 */
export const TEXT_MATCH_UNAVAILABLE_REASON = msg`Matching a message runs on agent turn end only.`;

/**
 * Why the Your message tab is off for a column's agent: Kangentic cannot read
 * the user's messages back from that agent's transcript. Resolve it where it
 * shows, with the agent's display name and the column's name.
 */
export const TEXT_MATCH_USER_UNSUPPORTED_REASON = msg({ message: "{agentName} doesn't report the messages you send, so this can't run in {columnName}." });

/** The reason when there is no line to read: no reply, or one with no words. */
export const TEXT_MATCH_NO_REPLY_REASON = 'The turn ended without a message Kangentic could read.';

/**
 * The run reasons for a Text match on the user's message. English, as every
 * run reason is (agents read them through `kangentic_get_automation_runs`),
 * and none of them quotes the message: the user's words are read for the
 * match and never stored.
 */
export const USER_TEXT_MATCH_MET_REASON = 'Your message matched.';
export const USER_TEXT_MATCH_NOT_MET_REASON = 'Your message matched no pattern.';
export const USER_TEXT_MATCH_NO_MESSAGE_REASON = 'No message from you in this turn.';
export const USER_TEXT_MATCH_UNREADABLE_REASON = "Kangentic couldn't read your messages for this turn, so the row did not run.";

/** How much of the final line a reason quotes. */
const REASON_LINE_MAX = 120;

/**
 * A run of what the comparison drops, read as one space: whitespace,
 * punctuation and symbols (markdown marks and `*` included), control and
 * format characters (a zero-width space, a joiner, a byte order mark),
 * enclosing marks (a keycap) and variation selectors (an emoji's U+FE0F).
 */
const SEPARATORS = /[\s\p{P}\p{S}\p{C}\p{Me}\p{Variation_Selector}]+/gu;

/** What Text match decided, and the line it read, for the run row. */
export interface FinalLineMatch {
  met: boolean;
  reason: string;
}

/** Lower case, each run of separators one space, ends untouched. */
function spaced(text: string): string {
  return text.toLowerCase().replace(SEPARATORS, ' ');
}

/** Lower case, punctuation, symbols and invisible characters to spaces, spaces collapsed, ends trimmed. */
export function normalizeForMatch(text: string): string {
  return spaced(text).trim();
}

/**
 * The reply's last line that has a word in it once normalized, trimmed but
 * otherwise as written, or null when no line does.
 */
export function finalMatchLine(reply: string | null | undefined): string | null {
  const lines = (reply ?? '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (normalizeForMatch(lines[index]) !== '') return lines[index].trim();
  }
  return null;
}

/**
 * Whether a line matches a pattern, `*` being any text. The pattern's literal
 * parts are normalized as a line is, except that a space beside a wildcard is
 * kept, as a glob keeps it: `Ready for *` needs the space after `for`.
 *
 * Linear: the first part must start the line and the last must end it, and
 * each part between takes its leftmost place after the one before, which is
 * the only placement a wildcard-only pattern ever needs.
 */
export function lineMatchesPattern(pattern: string, line: string): boolean {
  return normalizedLineMatchesPattern(pattern, normalizeForMatch(line));
}

/** `lineMatchesPattern` on a line already through `normalizeForMatch`, so several patterns share one pass over it. */
function normalizedLineMatchesPattern(pattern: string, text: string): boolean {
  const parts = pattern.split('*').map(spaced);
  parts[0] = parts[0].trimStart();
  parts[parts.length - 1] = parts[parts.length - 1].trimEnd();
  if (parts.length === 1) return text === parts[0];

  const head = parts[0];
  const tail = parts[parts.length - 1];
  const end = text.length - tail.length;
  if (end < head.length || !text.startsWith(head) || !text.endsWith(tail)) return false;
  let cursor = head.length;
  for (const middle of parts.slice(1, -1)) {
    const at = text.indexOf(middle, cursor);
    if (at === -1 || at + middle.length > end) return false;
    cursor = at + middle.length;
  }
  return true;
}

/** A Text match's patterns, read from its stored text: plain ones, and the `!` ones without their `!`. */
export interface TextMatchPatterns {
  plain: string[];
  negated: string[];
}

/** The `!` that starts a pattern, and any spaces after it. */
const NOT_MARK = /^!\s*/;

/** A line break in pattern text: CRLF, LF, or a lone CR. */
export const PATTERN_LINE_BREAK = /\r\n|\r|\n/;

/** A Text match's pattern lines, each trimmed, blank ones dropped. */
export function textMatchLines(value: string | null | undefined): string[] {
  return (value ?? '').split(PATTERN_LINE_BREAK).map((line) => line.trim()).filter((line) => line !== '');
}

/**
 * A Text match as `kangentic.json` and the MCP tools write it: one pattern as
 * a string, several as a list, or null when it has none.
 */
export function textMatchFileValue(value: string | null | undefined): string | string[] | null {
  const patterns = textMatchLines(value);
  if (patterns.length === 0) return null;
  return patterns.length === 1 ? patterns[0] : patterns;
}

/** Split a Text match into its plain patterns and its `!` patterns. */
export function parseTextMatch(value: string | null | undefined): TextMatchPatterns {
  const plain: string[] = [];
  const negated: string[] = [];
  for (const line of textMatchLines(value)) {
    if (line.startsWith('!')) negated.push(line.replace(NOT_MARK, ''));
    else plain.push(line);
  }
  return { plain, negated };
}

/**
 * Whether any line could match one pattern: it has a wildcard, or a letter or
 * number once normalized. The line read is always one with words in it, so a
 * pattern of only punctuation (`---`, `...`) never matches.
 */
export function patternCanMatch(pattern: string): boolean {
  return pattern.includes('*') || normalizeForMatch(pattern) !== '';
}

/**
 * Whether a Text match can ever let its row run. With plain patterns, one of
 * them has to be able to match. With only `!` patterns, one of them has to be
 * able to rule a line out; otherwise there is no rule at all. A pattern of
 * only punctuation (`---`, a bare `!`) therefore leaves its row never running,
 * as it always has.
 */
export function textMatchCanMatch(value: string | null | undefined): boolean {
  const { plain, negated } = parseTextMatch(value);
  return plain.length > 0 ? plain.some(patternCanMatch) : negated.some(patternCanMatch);
}

/**
 * The first pattern line, as written, that can never match a line with words
 * in it (`---`, `!...`), or null when every line can. For the warnings and
 * refusals that name the line to fix.
 */
export function unmatchablePattern(value: string | null | undefined): string | null {
  for (const line of textMatchLines(value)) {
    if (!patternCanMatch(line.replace(NOT_MARK, ''))) return line;
  }
  return null;
}

/**
 * Whether a line meets a Text match: it matches a plain pattern (or there are
 * none) and no `!` pattern. A Text match that can never run
 * (`textMatchCanMatch`) never matches, so a stored `!` alone still runs
 * nothing rather than everything.
 */
export function textMatchMatches(value: string | null | undefined, line: string): boolean {
  const { plain, negated } = parseTextMatch(value);
  const text = normalizeForMatch(line);
  const included = plain.length > 0
    ? plain.some((pattern) => normalizedLineMatchesPattern(pattern, text))
    : negated.some(patternCanMatch);
  return included && !negated.some((pattern) => normalizedLineMatchesPattern(pattern, text));
}

/**
 * A pattern written before `!` meant "not" (the board file's old `finalLine`
 * key, the MCP tools' old `finalLine` parameter): a leading `!` was ignored as
 * punctuation then, so it is taken off now. A pattern that is nothing but `!`
 * is kept as written: it never ran, and it still cannot.
 */
export function legacyTextMatch(value: string): string {
  const stripped = value.replace(/^[!\s]+/, '');
  return stripped.trim() === '' ? value : stripped;
}

/**
 * A Text match as stored: each line trimmed, blank lines dropped, joined by a
 * line break, or null when no pattern is left. The repository, the dialog,
 * the board file and the MCP tools all store through this. The UI tier's mock
 * bridge (`mockNormalizeTextMatch` in `tests/ui/mock-electron-api.js`) is a
 * plain-JS copy of it, so a change here goes there too.
 */
export function normalizeTextMatch(value: string | null | undefined): string | null {
  const lines = textMatchLines(value);
  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * A row's two Condition kinds as stored: one kind per row, a Text match on a
 * turn end only (the one trigger with a final message), and a blank of either
 * kind none. A Text match wins, being the kind that costs nothing and cannot
 * be judged wrong. The repository stores every row through this and the Edit
 * automation dialog saves its draft through it, so the row the dialog saved is
 * the row a read gives back.
 */
export function conditionKindsAsStored(row: {
  condition?: string | null;
  final_line?: string | null;
  text_match_source?: TextMatchSource | null;
  trigger: string;
}): { condition: string | null; final_line: string | null; text_match_source: TextMatchSource } {
  const finalLine = row.trigger === 'turn_end' && typeof row.final_line === 'string' ? normalizeTextMatch(row.final_line) : null;
  return {
    condition: finalLine === null ? trimmedOrNull(row.condition) : null,
    final_line: finalLine,
    // A source means nothing without a Text match, so a row with none reads
    // as the agent's, the default.
    text_match_source: finalLine !== null ? textMatchSourceOf(row) : 'agent',
  };
}

/**
 * Whose message a row's Text match reads. Only an exact `'user'` is the
 * user's: a row built without the field (an older main process, an older
 * fixture) reads the agent's line.
 */
export function textMatchSourceOf(row: { text_match_source?: TextMatchSource | null }): TextMatchSource {
  return row.text_match_source === 'user' ? 'user' : 'agent';
}

function trimmedOrNull(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/**
 * Match a Text match (one pattern per line) against an agent's final message.
 *
 * The reason names the line that was read either way ("The final line reads
 * ..."), so a run row says what the agent actually ended on, which is the
 * thing to look at when a row did not run. With no line to read, nothing is
 * met, `!` patterns included: there is nothing to compare.
 */
export function matchFinalLine(value: string, reply: string | null | undefined): FinalLineMatch {
  const line = finalMatchLine(reply);
  if (line === null) return { met: false, reason: TEXT_MATCH_NO_REPLY_REASON };
  return { met: textMatchMatches(value, line), reason: `The final line reads "${shownFinalLine(line)}".` };
}

/**
 * What the turn-end read found of the user's messages: their last message in
 * the turn (null when they sent none Kangentic did not type itself), or
 * `unreadable` when the read failed or the agent cannot report them.
 */
export type UserMessageRead = { readable: true; message: string | null } | { readable: false };

/**
 * Match a Text match against the user's last message in the turn, the WHOLE
 * message, with the same forgiveness as a final line (case, punctuation,
 * markdown, runs of spaces and line breaks).
 *
 * Fails closed: a read that failed, and a turn with no message from the user,
 * meet nothing, `!` patterns included. The reasons never quote the message:
 * the user's words are read for the match and never stored.
 */
export function matchUserMessage(value: string, read: UserMessageRead): FinalLineMatch {
  if (!read.readable) return { met: false, reason: USER_TEXT_MATCH_UNREADABLE_REASON };
  if (read.message === null || normalizeForMatch(read.message) === '') {
    return { met: false, reason: USER_TEXT_MATCH_NO_MESSAGE_REASON };
  }
  const met = textMatchMatches(value, read.message);
  return { met, reason: met ? USER_TEXT_MATCH_MET_REASON : USER_TEXT_MATCH_NOT_MET_REASON };
}

/** A final line as a reason quotes it: cut after `REASON_LINE_MAX` characters. */
export function shownFinalLine(line: string): string {
  return line.length > REASON_LINE_MAX ? `${line.slice(0, REASON_LINE_MAX)}...` : line;
}
