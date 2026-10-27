import type { I18n, MessageDescriptor } from '@lingui/core';

/**
 * A user-facing string a shared list or registry carries: a Lingui message
 * descriptor (`msg` from `@lingui/core/runtime-macro`) once converted, or a plain
 * string still waiting for its area's extraction. Resolve it where it renders,
 * never at module load, so it reads the active catalog.
 */
export type LocalizedText = string | MessageDescriptor;

/** Values for a descriptor's named placeholders, merged over its own. */
export type TextValues = Record<string, unknown>;

/** Resolve `text` through `i18n`; a plain string passes through untranslated. */
export function resolveText(i18n: I18n, text: LocalizedText, values?: TextValues): string {
  if (typeof text === 'string') return text;
  if (!values) return i18n._(text);
  // Built first, not passed as an object literal: `lingui extract` reads a literal
  // argument to `i18n._` as a message to extract.
  const withValues: MessageDescriptor = { ...text, values: { ...text.values, ...values } };
  return i18n._(withValues);
}
