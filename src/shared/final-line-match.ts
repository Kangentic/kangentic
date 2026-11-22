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
import type { BoardAutomationCondition, ColumnAutomation, TextMatchSource } from './types';

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
export const USER_TEXT_MATCH_RULED_OUT_REASON = 'Your message matched a ! pattern.';
export const USER_TEXT_MATCH_NO_MESSAGE_REASON = 'No message from you in this turn.';
export const USER_TEXT_MATCH_UNREADABLE_REASON = "Kangentic couldn't read your messages for this turn, so the row did not run.";

/**
 * The reasons for a turn with several messages from the user, naming the one
 * that decided by its place among them, oldest first. Never its words.
 */
export function userTextMatchMetAtReason(position: number, count: number): string {
  return `Your message ${position} of ${count} in this turn matched.`;
}

export function userTextMatchRuledOutAtReason(position: number, count: number): string {
  return `Your message ${position} of ${count} in this turn matched a ! pattern.`;
}

export function userTextMatchNoneOfReason(count: number): string {
  return `None of your ${count} messages in this turn matched a pattern.`;
}

/**
 * The reasons for a read that reached back to a turn a restart cut off before
 * its Stop (`carried-owner-turn.ts`): the owner's message there, and any after
 * it, decided at this turn end. Worded apart so the run log says why a turn
 * with no message of the owner's ran the row.
 */
export const CARRIED_USER_TEXT_MATCH_MET_REASON = 'Your message in the turn a restart cut off matched.';
export const CARRIED_USER_TEXT_MATCH_NOT_MET_REASON = 'Your message in the turn a restart cut off matched no pattern.';
export const CARRIED_USER_TEXT_MATCH_RULED_OUT_REASON = 'Your message in the turn a restart cut off matched a ! pattern.';
export const CARRIED_USER_TEXT_MATCH_NO_MESSAGE_REASON = 'No message from you in this turn or the one a restart cut off.';

export function carriedUserTextMatchMetAtReason(position: number, count: number): string {
  return `Your message ${position} of ${count} since the turn a restart cut off matched.`;
}

export function carriedUserTextMatchRuledOutAtReason(position: number, count: number): string {
  return `Your message ${position} of ${count} since the turn a restart cut off matched a ! pattern.`;
}

export function carriedUserTextMatchNoneOfReason(count: number): string {
  return `None of your ${count} messages since the turn a restart cut off matched a pattern.`;
}

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

/**
 * A row's Condition text kinds as `kangentic.json` and the MCP tools write
 * them, or null when it has neither: each kind inside `condition`, both when
 * the row has both (#872). A Text match on the user's message takes the long
 * form, which says so (#1078); the agent's line keeps the short form.
 */
export function boardConditionOf(
  row: Pick<ColumnAutomation, 'final_line' | 'text_match_source' | 'condition'>,
): BoardAutomationCondition | null {
  const text = textMatchFileValue(row.final_line);
  const agent = row.condition ? row.condition : null;
  if (text === null) return agent !== null ? { agent } : null;
  const textCondition: BoardAutomationCondition = row.text_match_source === 'user'
    ? { text: { from: 'user', patterns: text } }
    : { text };
  return agent !== null ? { ...textCondition, agent } : textCondition;
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
 * Whether a line meets a Text match: its `textMatchVerdict` is `matched`,
 * which holds the rule. A Text match that can never run
 * (`textMatchCanMatch`) never matches, so a stored `!` alone still runs
 * nothing rather than everything.
 */
export function textMatchMatches(value: string | null | undefined, line: string): boolean {
  return textMatchVerdict(value, line) === 'matched';
}

/**
 * What a Text match makes of one line or message:
 *
 *  - `ruled-out`: it matches a `!` pattern. A `!` wins within one text, so
 *    "not signed off" is ruled out by `!*not signed off*` even though it also
 *    matches `*signed off*`.
 *  - `matched`: no `!` pattern, and a plain pattern matches (or there are
 *    none, and some `!` pattern can rule a text out at all).
 *  - `silent`: neither. Only a Text match with plain patterns, or one that can
 *    never run (`textMatchCanMatch`), leaves a text silent.
 */
export type TextMatchVerdict = 'matched' | 'ruled-out' | 'silent';

export function textMatchVerdict(value: string | null | undefined, line: string): TextMatchVerdict {
  const { plain, negated } = parseTextMatch(value);
  const text = normalizeForMatch(line);
  if (negated.some((pattern) => normalizedLineMatchesPattern(pattern, text))) return 'ruled-out';
  const included = plain.length > 0
    ? plain.some((pattern) => normalizedLineMatchesPattern(pattern, text))
    : negated.some(patternCanMatch);
  return included ? 'matched' : 'silent';
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
 * A row's two Condition kinds as stored: a Text match on a turn end only (the
 * one trigger with a final message), an Agent evaluation on any trigger, both
 * at once when both are given (#872: every Condition line must hold), and a
 * blank of either kind none. The repository stores every row through this and
 * the Edit automation dialog saves its draft through it, so the row the dialog
 * saved is the row a read gives back.
 */
export function conditionKindsAsStored(row: {
  condition?: string | null;
  final_line?: string | null;
  text_match_source?: TextMatchSource | null;
  trigger: string;
}): { condition: string | null; final_line: string | null; text_match_source: TextMatchSource } {
  const finalLine = row.trigger === 'turn_end' && typeof row.final_line === 'string' ? normalizeTextMatch(row.final_line) : null;
  return {
    condition: trimmedOrNull(row.condition),
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
 * What the turn-end read found of the user's messages: every message they sent
 * in the turn, oldest first, less what Kangentic typed itself (empty when
 * they sent none), or `unreadable` when the read failed or the agent cannot
 * report them. `carriedAcrossRestart` marks a read that began at a turn a
 * restart cut off before its Stop, so the reasons say so.
 */
export type UserMessageRead =
  | { readable: true; messages: readonly string[]; carriedAcrossRestart?: boolean }
  | { readable: false };

/**
 * Match a Text match against the user's messages in the turn, each one WHOLE,
 * with the same forgiveness as a final line (case, punctuation, markdown, runs
 * of spaces and line breaks).
 *
 * Each message is judged on its own (`textMatchVerdict`), and the newest one
 * that matches any pattern decides: a plain match runs the row, a `!` match
 * rules it out, and a message that matches nothing leaves the decision to the
 * ones before it. So a sign-off followed by a question still runs the row (a
 * person who asks something while the agent works, kangentic.com #145), and a sign-off
 * followed by "not signed off" does not. With only `!` patterns every message
 * matches something, so the newest one decides.
 *
 * Fails closed: a read that failed, and a turn with no message from the user,
 * meet nothing, `!` patterns included. The reasons never quote a message: the
 * user's words are read for the match and never stored. With several
 * messages, a reason names the one that decided by its place.
 */
export function matchUserMessage(value: string, read: UserMessageRead): FinalLineMatch {
  if (!read.readable) return { met: false, reason: USER_TEXT_MATCH_UNREADABLE_REASON };
  // The ledger's read already drops a message with no words (`typedMessageKey`
  // is null exactly when this is empty). The same rule runs here for a read
  // built without it, so the positions a reason names count the same messages.
  const messages = read.messages.filter((message) => normalizeForMatch(message) !== '');
  const reasons = read.carriedAcrossRestart === true ? CARRIED_REASONS : TURN_REASONS;
  if (messages.length === 0) return { met: false, reason: reasons.noMessage };
  const count = messages.length;
  for (let index = count - 1; index >= 0; index -= 1) {
    const verdict = textMatchVerdict(value, messages[index]);
    if (verdict === 'silent') continue;
    const met = verdict === 'matched';
    if (count === 1) return { met, reason: met ? reasons.met : reasons.ruledOut };
    return {
      met,
      reason: met ? reasons.metAt(index + 1, count) : reasons.ruledOutAt(index + 1, count),
    };
  }
  return { met: false, reason: count === 1 ? reasons.notMet : reasons.noneOf(count) };
}

/** One set of the user's-message reasons: this turn's, or a read carried across a restart. */
interface UserMessageReasons {
  met: string;
  notMet: string;
  ruledOut: string;
  noMessage: string;
  metAt(position: number, count: number): string;
  ruledOutAt(position: number, count: number): string;
  noneOf(count: number): string;
}

const TURN_REASONS: UserMessageReasons = {
  met: USER_TEXT_MATCH_MET_REASON,
  notMet: USER_TEXT_MATCH_NOT_MET_REASON,
  ruledOut: USER_TEXT_MATCH_RULED_OUT_REASON,
  noMessage: USER_TEXT_MATCH_NO_MESSAGE_REASON,
  metAt: userTextMatchMetAtReason,
  ruledOutAt: userTextMatchRuledOutAtReason,
  noneOf: userTextMatchNoneOfReason,
};

const CARRIED_REASONS: UserMessageReasons = {
  met: CARRIED_USER_TEXT_MATCH_MET_REASON,
  notMet: CARRIED_USER_TEXT_MATCH_NOT_MET_REASON,
  ruledOut: CARRIED_USER_TEXT_MATCH_RULED_OUT_REASON,
  noMessage: CARRIED_USER_TEXT_MATCH_NO_MESSAGE_REASON,
  metAt: carriedUserTextMatchMetAtReason,
  ruledOutAt: carriedUserTextMatchRuledOutAtReason,
  noneOf: carriedUserTextMatchNoneOfReason,
};

/** A final line as a reason quotes it: cut after `REASON_LINE_MAX` characters. */
export function shownFinalLine(line: string): string {
  return line.length > REASON_LINE_MAX ? `${line.slice(0, REASON_LINE_MAX)}...` : line;
}
