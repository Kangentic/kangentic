import { setupI18n } from '@lingui/core';
import { SOURCE_LOCALE } from './locales';
import { resolveText, type LocalizedText, type TextValues } from './text';
import { guardPlaceholderBackslashes } from './placeholder-backslash-guard';

/**
 * An i18n instance that always speaks English, whatever language the UI runs in.
 *
 * Text an agent reads stays English: MCP tool output, agent prompts, reasons
 * stored for `kangentic_get_automation_runs`. When that text comes from a list
 * whose entries are message descriptors, resolve it with `englishText`, never with
 * the UI's translator and never with `descriptor.message`, which is raw ICU
 * (`{count, plural, ...}`) and is stripped from production renderer builds.
 * Main and the renderer each load the English catalog into it at startup.
 */
export const englishI18n = setupI18n({
  locale: SOURCE_LOCALE,
  messages: { [SOURCE_LOCALE]: {} },
});
guardPlaceholderBackslashes(englishI18n);

export function englishText(text: LocalizedText, values?: TextValues): string {
  return resolveText(englishI18n, text, values);
}
