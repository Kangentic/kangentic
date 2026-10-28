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
 * Shared, not main-only: the runner, the eval harness
 * (`scripts/eval-condition-check.mjs`) and the tests all match through this
 * one function, so they cannot disagree about what a line means.
 */
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';

/**
 * The Text match field's placeholder, and the line its wildcard examples are
 * built on. English: it stands for a line the agent writes, and the examples
 * are matched against it.
 */
export const TEXT_MATCH_PLACEHOLDER = 'Ready for review';

/** One row of the field's wildcard tip: a pattern, what it means, and a line it matches. */
export interface TextMatchWildcardExample {
  pattern: string;
  /** What the pattern means. Resolve it where it shows. */
  rule: MessageDescriptor;
  /** A line the pattern matches other than the placeholder itself, or null. */
  sample: string | null;
}

/**
 * The wildcard tip's rows, each built on the placeholder so the tip reads the
 * same on every row whatever was typed. Data rather than markup so a unit test
 * can hold each pattern to its sample through the real matcher.
 */
export const TEXT_MATCH_WILDCARD_EXAMPLES: readonly TextMatchWildcardExample[] = [
  { pattern: TEXT_MATCH_PLACEHOLDER, rule: msg`Exactly this line`, sample: null },
  { pattern: 'Ready for *', rule: msg`Starts with it`, sample: 'Ready for testing' },
  { pattern: '* for review', rule: msg`Ends with it`, sample: 'The fix is ready for review' },
  { pattern: '*review*', rule: msg`Contains it`, sample: 'Review passed' },
];

/**
 * Why Text match is unavailable on enter and exit. One line: it is the hover
 * tip on the dialog's disabled option (`translateText`), and the MCP and file
 * refusals reuse it in English (`englishText`).
 */
export const TEXT_MATCH_UNAVAILABLE_REASON = msg`Text match reads the agent's last message, so it runs on agent turn end only.`;

/** The reason when there is no line to read: no reply, or one with no words. */
export const TEXT_MATCH_NO_REPLY_REASON = 'The turn ended without a message Kangentic could read.';

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
  const parts = pattern.split('*').map(spaced);
  parts[0] = parts[0].trimStart();
  parts[parts.length - 1] = parts[parts.length - 1].trimEnd();
  const text = normalizeForMatch(line);
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

/**
 * Whether any line could match a pattern: it has a wildcard, or a letter or
 * number once normalized. The line read is always one with words in it, so a
 * pattern of only punctuation (`---`, `...`) never matches, and its row never
 * runs.
 */
export function textMatchCanMatch(pattern: string): boolean {
  return pattern.includes('*') || normalizeForMatch(pattern) !== '';
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
  trigger: string;
}): { condition: string | null; final_line: string | null } {
  const finalLine = row.trigger === 'turn_end' ? trimmedOrNull(row.final_line) : null;
  return { condition: finalLine === null ? trimmedOrNull(row.condition) : null, final_line: finalLine };
}

function trimmedOrNull(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/**
 * Match a Text match pattern against an agent's final message.
 *
 * The reason names the line that was read either way ("The final line reads
 * ..."), so a run row says what the agent actually ended on, which is the
 * thing to look at when a row did not run.
 */
export function matchFinalLine(pattern: string, reply: string | null | undefined): FinalLineMatch {
  const line = finalMatchLine(reply);
  if (line === null) return { met: false, reason: TEXT_MATCH_NO_REPLY_REASON };
  return { met: lineMatchesPattern(pattern, line), reason: `The final line reads "${shownFinalLine(line)}".` };
}

/** A final line as a reason quotes it: cut after `REASON_LINE_MAX` characters. */
export function shownFinalLine(line: string): string {
  return line.length > REASON_LINE_MAX ? `${line.slice(0, REASON_LINE_MAX)}...` : line;
}
