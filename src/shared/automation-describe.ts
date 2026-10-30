import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { AUTOMATION_MANIFEST, automationFieldUnavailableReason, automationMoveTargetName } from './automation-manifest';
import { resolveText } from './i18n/text';
import type { AutomationConfig, AutomationTrigger, AutomationType } from './types';

/**
 * The most of a value a row sentence carries.
 *
 * A bound for the run log, which writes the sentence too, and not the row's
 * look: the column panel ends a long value where the row ends, with CSS, and
 * no realistic row is wide enough to reach this. Tooltips and mark labels hold
 * the value whole.
 */
export const AUTOMATION_VALUE_MAX = 300;

/**
 * Every sentence, label and phrase below is its own message. They were built
 * by lower-casing a sentence's first letter and trimming its full stop, which
 * no translation can follow. Each function takes the `I18n` to speak with,
 * because the same sentence has two audiences: the Board Manager draws it in
 * the session's language, and the run log and the MCP list (an agent reads
 * both) write it in English through `englishI18n`.
 */
const SENTENCES = {
  sendsMessage: msg({ message: 'Sends "{message}"' }),
  noMessage: msg`No message yet.`,
  runsScript: msg({ message: 'Runs {script}' }),
  noScript: msg`No script yet.`,
  webhookTo: msg({ message: '{method} to {host}' }),
  noUrl: msg`No URL yet.`,
  notifies: msg({ message: 'Notifies "{title}"' }),
  showsNotification: msg`Notifies you on the desktop and your phone.`,
  movesTo: msg({ message: 'Moves the task to {column}' }),
  movesToNext: msg`Moves the task to the next column`,
  startsWithPrompt: msg({ message: 'Starts the agent with "{prompt}"' }),
  startsAgent: msg`Starts the agent.`,
};

const GUARDS = {
  onlyIf: msg({ message: 'Only if {condition}.' }),
  onlyIfLabel: msg({ message: 'Condition: only if {condition}.' }),
  onlyIfPhrase: msg({ message: 'only if {condition}' }),
  textMatch: msg({ message: 'Only if the last line reads "{line}".' }),
  textMatchLabel: msg({ message: 'Condition: only if the last line reads "{line}".' }),
  textMatchPhrase: msg({ message: 'only if the last line reads "{line}"' }),
  frequency: msg({ message: '{maxRuns, plural, =1 {At most once until you move the task.} other {At most # times until you move the task.}}' }),
  frequencyLabel: msg({ message: '{maxRuns, plural, =1 {Frequency: at most once until you move the task.} other {Frequency: at most # times until you move the task.}}' }),
  frequencyPhrase: msg({ message: '{maxRuns, plural, =1 {at most once until you move the task} other {at most # times until you move the task}}' }),
};

const ACTION_MARKS = {
  deliveryLabel: msg`Delivery: waits for the current turn to end.`,
  deliveryPhrase: msg`waits for the current turn to end`,
  messageLabel: msg({ message: 'Message: {message}' }),
  messagePhrase: msg`with a message`,
};

/** A row's second line, its tooltip, and whether the value it quotes is code. */
export interface AutomationSentence {
  text: string;
  /**
   * The same sentence with its value whole, every line kept: the row's
   * tooltip, since the row shows a multi-line message or script's first line
   * only. Equal to `text` for a one-line value, and always for a webhook, whose
   * URL is never printed in full.
   */
  tooltip: string;
  /** The value is a script's first line, which the column panel sets in the mono font. */
  code: boolean;
}

/**
 * The one-line sentence an automation's row shows: the verb and the type's one
 * required value, and nothing optional. Timing and the other options are marks
 * beside the row's name (`describeAutomationMarks`), not words here.
 *
 * Shared rather than per-adapter because BOTH sides need it: the main process
 * writes it into a run's log line, and the renderer draws it on every row in
 * Board setup. The plan called for the renderer to keep its own copy pinned
 * equal by a test, which is a worse version of just having one function.
 *
 * Renderer-safe by contract: no Node imports. Every adapter's `describe`
 * delegates here.
 *
 * Must never throw, on any input including `{}` and a config full of
 * unsubstituted `{{variables}}`. A half-built draft renders through it: the
 * picker adds an automation before it has a name or a value.
 */
export function describeAutomation(type: AutomationType, config: AutomationConfig, i18n: I18n): string {
  return describeAutomationSentence(type, config, i18n).text;
}

/** `describeAutomation`'s sentence, plus its tooltip and whether it quotes code, for the column panel. */
export function describeAutomationSentence(type: AutomationType, config: AutomationConfig, i18n: I18n): AutomationSentence {
  switch (type) {
    case 'send_message': {
      // `command` is the legacy `send_command` key a migrated row may carry.
      const message = (config.message ?? config.command ?? '').trim();
      return message
        ? prose(
          resolveText(i18n, SENTENCES.sendsMessage, { message: wholeFirstLine(message) }),
          resolveText(i18n, SENTENCES.sendsMessage, { message: wholeValue(message) }),
        )
        : prose(resolveText(i18n, SENTENCES.noMessage));
    }

    case 'run_script': {
      const script = (config.script ?? '').trim();
      // Only a script is code. The empty state is prose, so it keeps the prose font.
      return script
        ? {
          text: resolveText(i18n, SENTENCES.runsScript, { script: wholeFirstLine(script) }),
          tooltip: resolveText(i18n, SENTENCES.runsScript, { script: wholeValue(script) }),
          code: true,
        }
        : prose(resolveText(i18n, SENTENCES.noScript));
    }

    case 'webhook': {
      // Host only, in the tooltip too: a signed URL is a secret.
      const url = (config.url ?? '').trim();
      return prose(url
        ? resolveText(i18n, SENTENCES.webhookTo, { method: config.method ?? 'POST', host: hostOf(url) })
        : resolveText(i18n, SENTENCES.noUrl));
    }

    case 'notify': {
      const title = (config.title ?? '').trim();
      return title
        ? prose(
          resolveText(i18n, SENTENCES.notifies, { title: wholeFirstLine(title) }),
          resolveText(i18n, SENTENCES.notifies, { title: wholeValue(title) }),
        )
        : prose(resolveText(i18n, SENTENCES.showsNotification));
    }

    case 'move_to_column': {
      // The Message is optional, so it is a mark, not part of the sentence.
      const column = automationMoveTargetName(type, config) ?? '';
      return prose(column
        ? resolveText(i18n, SENTENCES.movesTo, { column: wholeFirstLine(column) })
        : resolveText(i18n, SENTENCES.movesToNext));
    }

    case 'spawn_agent': {
      const prompt = (config.promptTemplate ?? '').trim();
      return prompt
        ? prose(
          resolveText(i18n, SENTENCES.startsWithPrompt, { prompt: wholeFirstLine(prompt) }),
          resolveText(i18n, SENTENCES.startsWithPrompt, { prompt: wholeValue(prompt) }),
        )
        : prose(resolveText(i18n, SENTENCES.startsAgent));
    }
  }
}

function prose(text: string, tooltip: string = text): AutomationSentence {
  return { text, tooltip, code: false };
}

/**
 * What a row's mark stands for, in the Edit automation dialog's card order.
 * The Condition marks by its kind: `condition` for an Agent evaluation,
 * `text-match` for a Text match, so a row says without a hover whether its
 * check costs an agent call.
 */
export type AutomationRowMarkKind = 'condition' | 'text-match' | 'frequency' | 'delivery' | 'message';

/** One mark beside a row's name: an option that is switched on. */
export interface AutomationRowMark {
  kind: AutomationRowMarkKind;
  /**
   * "<card or field name>: <value>", the mark's tooltip and its accessible
   * name. A Message or a Condition is whole here, every line kept: the mark is
   * the one place the row names it.
   */
  label: string;
  /**
   * The option as words that follow the row's sentence, on one line: "with a
   * message", "only if the review is clean". For a listing that prints one row
   * per line, such as the MCP list (`describeAutomationMarksInWords`).
   */
  phrase: string;
  /** What the mark prints beside its icon: the Frequency's run limit. */
  count?: number;
}

/**
 * The marks a row shows after its name, in the editor's card order: the
 * Condition, the Frequency, then the action's own. Each says an option is on,
 * and its label says which card and what value: "Condition: only if the review
 * is clean."
 *
 * Here rather than in the column panel for the reason the sentence is: what a
 * type marks is a question about the type, and this module is where the row's
 * words already switch on it, so the renderer never branches on a type name.
 */
export function describeAutomationMarks(row: {
  type: AutomationType;
  trigger: AutomationTrigger;
  config: AutomationConfig;
  condition: string | null;
  final_line: string | null;
  max_runs: number | null;
}, i18n: I18n): AutomationRowMark[] {
  const marks: AutomationRowMark[] = [];
  // One Condition kind per row. A Text match is matched only at a turn end, so
  // a draft that still holds one on another trigger earns no mark: it would
  // promise a check that never runs.
  const line = row.trigger === 'turn_end' ? textMatchLine(row.final_line) : null;
  const condition = conditionText(row.condition, 'keep-lines');
  const conditionOneLine = conditionText(row.condition, 'one-line');
  if (line !== null) {
    marks.push({
      kind: 'text-match',
      label: resolveText(i18n, GUARDS.textMatchLabel, { line }),
      phrase: resolveText(i18n, GUARDS.textMatchPhrase, { line }),
    });
  } else if (condition !== null && conditionOneLine !== null) {
    marks.push({
      kind: 'condition',
      label: resolveText(i18n, GUARDS.onlyIfLabel, { condition }),
      phrase: resolveText(i18n, GUARDS.onlyIfPhrase, { condition: conditionOneLine }),
    });
  }
  if (row.max_runs !== null) {
    marks.push({
      kind: 'frequency',
      label: resolveText(i18n, GUARDS.frequencyLabel, { maxRuns: row.max_runs }),
      phrase: resolveText(i18n, GUARDS.frequencyPhrase, { maxRuns: row.max_runs }),
      count: row.max_runs,
    });
  }
  marks.push(...actionMarks(row.type, row.trigger, row.config, i18n));
  return marks;
}

/**
 * A row's marks as words after its sentence, or null when it has none: "with a
 * message; only if the review is clean; at most 3 times until you move the task". The
 * MCP list prints this, since an agent reads text and cannot hover a mark.
 *
 * The action's own options lead, unlike the marks' card order, because they
 * finish the sentence's verb ("Moves the task to Executing, with a message")
 * and the guards then say when it runs.
 */
export function describeAutomationMarksInWords(row: Parameters<typeof describeAutomationMarks>[0], i18n: I18n): string | null {
  const marks = describeAutomationMarks(row, i18n);
  const isGuard = (mark: AutomationRowMark): boolean => mark.kind === 'condition' || mark.kind === 'text-match' || mark.kind === 'frequency';
  const ordered = [...marks.filter((mark) => !isGuard(mark)), ...marks.filter(isGuard)];
  return ordered.length > 0 ? ordered.map((mark) => mark.phrase).join('; ') : null;
}

/** The marks an action's own options earn. */
function actionMarks(type: AutomationType, trigger: AutomationTrigger, config: AutomationConfig, i18n: I18n): AutomationRowMark[] {
  switch (type) {
    case 'send_message': {
      // Run immediately is the default, so only waiting is marked, and only
      // where Delivery applies. The manifest says where it does not (at a turn
      // end the turn is already over and the message goes at once), and a mark
      // there would promise a wait that never happens.
      const delivery = AUTOMATION_MANIFEST.send_message.fields.find((field) => field.key === 'mode');
      const applies = delivery !== undefined && automationFieldUnavailableReason(delivery, trigger) === null;
      return applies && config.mode === 'deferred'
        ? [{
          kind: 'delivery',
          label: resolveText(i18n, ACTION_MARKS.deliveryLabel),
          phrase: resolveText(i18n, ACTION_MARKS.deliveryPhrase),
        }]
        : [];
    }

    case 'move_to_column': {
      const message = typeof config.message === 'string' ? config.message.trim() : '';
      return message
        ? [{
          kind: 'message',
          label: resolveText(i18n, ACTION_MARKS.messageLabel, { message: wholeValue(message) }),
          phrase: resolveText(i18n, ACTION_MARKS.messagePhrase),
        }]
        : [];
    }

    // A webhook's body and headers and a notification's body only shape what is
    // sent, so they earn no mark: open the row for those.
    case 'run_script':
    case 'webhook':
    case 'notify':
    case 'spawn_agent':
      return [];
  }
}

/**
 * A value whole, every line kept: trimmed, with Windows line breaks made plain.
 * What a tooltip holds where the row shows only the first line.
 */
export function wholeValue(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/**
 * A value's first line, whole: everything before its first line break, with
 * inner whitespace collapsed, bounded only by `AUTOMATION_VALUE_MAX`. A row is
 * one line, so a multi-line script or message shows its first line.
 */
export function wholeFirstLine(text: string): string {
  const [first = ''] = text.trim().split(/\r?\n/, 1);
  return firstLine(first, AUTOMATION_VALUE_MAX);
}

/**
 * A row's Condition as one sentence on one line, or null when it has none:
 * "Only if the review is clean." Never cut short. The Condition mark's tooltip
 * keeps the condition's own line breaks instead (`describeAutomationMarks`).
 */
export function describeAutomationCondition(condition: string | null, i18n: I18n): string | null {
  const text = conditionText(condition, 'one-line');
  return text === null ? null : resolveText(i18n, GUARDS.onlyIf, { condition: text });
}

/**
 * The user's condition as it continues "Only if": its line breaks kept for a
 * tooltip, or folded into one line for a sentence or a listing, with its own
 * closing punctuation dropped, or null when it has none. The text is the
 * user's, so it keeps the English rule it always had: a first letter that
 * starts a word is lower-cased, one that starts an acronym or a name ("CI is
 * green") stays.
 */
function conditionText(condition: string | null, lines: 'keep-lines' | 'one-line'): string | null {
  const plain = (condition ?? '').replace(/\r\n?/g, '\n');
  const sentence = lines === 'one-line'
    ? plain.replace(/\s+/g, ' ').trim()
    : plain.split('\n').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line !== '').join('\n');
  if (!sentence) return null;
  const continued = /^[A-Z][a-z]/.test(sentence) ? sentence[0].toLowerCase() + sentence.slice(1) : sentence;
  return continued.replace(/[.!?]+$/, '');
}

/** A Text match's pattern on one line, quoted whole and as written, or null when it has none. */
function textMatchLine(finalLine: string | null): string | null {
  const line = (finalLine ?? '').replace(/\s+/g, ' ').trim();
  return line || null;
}

/**
 * A row's Text match as one sentence, or null when it has none: "Only if the
 * last line reads "Verdict: Ready"." The pattern is quoted whole and as
 * written, its wildcards included, since the exact text is the whole point.
 */
export function describeAutomationTextMatch(finalLine: string | null, i18n: I18n): string | null {
  const line = textMatchLine(finalLine);
  return line === null ? null : resolveText(i18n, GUARDS.textMatch, { line });
}

/**
 * A row's Frequency as one sentence, or null when it has none: "At most 3 times
 * until you move the task." The tooltip of the Frequency mark, whose visible
 * part is the bare count. "You" is the rule: a person's move starts the count
 * over, and the board's own moves do not, except a move out of Done, which
 * starts it over whoever makes it (`AutomationRunRepository.countRuns`).
 */
export function describeAutomationFrequency(maxRuns: number | null, i18n: I18n): string | null {
  return maxRuns === null ? null : resolveText(i18n, GUARDS.frequency, { maxRuns });
}

/**
 * A row's guards as one string, or null when it has none, read in the order
 * the rule runs: "Only if the review is clean. At most 3 times until you move the task."
 * A row holds one Condition kind, so a Text match stands in for the prose, on
 * a turn end only, as `describeAutomationMarks` reads it. Built from the
 * sentences above, so the wording lives in one place.
 */
export function describeAutomationGuards(guards: {
  trigger: AutomationTrigger;
  condition: string | null;
  final_line: string | null;
  max_runs: number | null;
}, i18n: I18n): string | null {
  const textMatch = guards.trigger === 'turn_end' ? describeAutomationTextMatch(guards.final_line, i18n) : null;
  const condition = textMatch ?? describeAutomationCondition(guards.condition, i18n);
  const parts = [condition, describeAutomationFrequency(guards.max_runs, i18n)]
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** Collapse to one line and cut at `max`, so a multi-line script stays a row. */
export function firstLine(text: string, max = 60): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}...`;
}

/** The host of a URL, so a row does not print a signed webhook URL in full. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    // A URL carrying an unsubstituted template variable is not parseable, and a
    // half-built draft renders through describeAutomation, so this must not throw.
    return firstLine(url, 40);
  }
}
