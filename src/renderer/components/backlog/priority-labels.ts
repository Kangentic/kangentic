/**
 * Display names for the seeded priority labels.
 *
 * A priority's label is persisted data: it is saved to the project config, shared
 * through `kangentic.json` and read by MCP (`BACKLOG_PRIORITY_LABELS`), so it
 * stays English however the UI is translated. These helpers translate it on
 * DISPLAY only, and only when the stored text is exactly one of the English names
 * Kangentic seeds ("None", "Low", "Medium", "High", "Urgent") or the "Priority N"
 * the Priorities popover writes for a new one. A name the user typed shows as
 * typed. `storedPriorityLabel` does the reverse for the rename field, so saving
 * an untouched or translated default writes English again.
 *
 * Plain descriptors read through `i18n._` at call time (never at module load), so
 * they follow the session's catalog. Every one carries the context `priority`,
 * because "None", "Low" and "High" read differently elsewhere.
 */
import { i18n } from '@lingui/core';
import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { translateText } from '../../i18n/translate';

/** The seeded names, keyed by their stored English text. */
const SEEDED_PRIORITY_MESSAGES: ReadonlyMap<string, MessageDescriptor> = new Map([
  ['None', msg({ message: 'None', context: 'priority' })],
  ['Low', msg({ message: 'Low', context: 'priority' })],
  ['Medium', msg({ message: 'Medium', context: 'priority' })],
  ['High', msg({ message: 'High', context: 'priority' })],
  ['Urgent', msg({ message: 'Urgent', context: 'priority' })],
]);

/** The name the Priorities popover gives a new priority. Takes `number`. */
const NUMBERED_PRIORITY_MESSAGE: MessageDescriptor = msg({ message: 'Priority {number}', context: 'priority' });

const STORED_NUMBERED_PATTERN = /^Priority (\d+)$/;

/** The stored English label as the session's language reads it. */
export function displayPriorityLabel(label: string): string {
  const seeded = SEEDED_PRIORITY_MESSAGES.get(label);
  if (seeded) return i18n._(seeded);
  const numbered = STORED_NUMBERED_PATTERN.exec(label);
  if (numbered) return translateText(NUMBERED_PRIORITY_MESSAGE, { number: numbered[1] });
  return label;
}

/** A character no translation contains, standing in for the number while the pattern is built. */
const NUMBER_SENTINEL = '\u0001';

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * What to save for a name typed in the rename field: the English default when the
 * text is a seeded name or a "Priority N" as the session's language reads it, and
 * the text unchanged otherwise (a name the user chose, or English typed as is).
 */
export function storedPriorityLabel(input: string): string {
  for (const [english, descriptor] of SEEDED_PRIORITY_MESSAGES) {
    if (i18n._(descriptor) === input) return english;
  }
  const translatedTemplate = translateText(NUMBERED_PRIORITY_MESSAGE, { number: NUMBER_SENTINEL });
  const [prefix, suffix] = translatedTemplate.split(NUMBER_SENTINEL);
  if (prefix !== undefined && suffix !== undefined) {
    const numbered = new RegExp(`^${escapeForPattern(prefix)}(\\d+)${escapeForPattern(suffix)}$`).exec(input);
    if (numbered) return `Priority ${numbered[1]}`;
  }
  return input;
}
