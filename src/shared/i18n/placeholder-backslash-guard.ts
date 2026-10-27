import type { I18n, MessageDescriptor } from '@lingui/core';

/**
 * Keeps a placeholder's value exactly as given.
 *
 * Lingui decodes `\xHH` and `\uHHHH` escape sequences across a message's whole
 * interpolated result, so it also rewrites them inside the VALUES it placed:
 * a Windows path like `C:\build\x64\app` in `{projectPath}` came out as
 * `C:\buildd\app`, and a task title or an error reason carrying a backslash was
 * open to the same. Before text went through Lingui these were plain template
 * literals, which left a value alone.
 *
 * The guard stands each backslash in a string value in for a private-use
 * character before the translator runs and puts it back after, so the decoding
 * still applies to the translation's own text and never to a value. Install it
 * on every I18n instance at creation: the session's, the English one, and each
 * extra locale instance. `t` is rebound too, because `useLingui()` binds
 * `i18n.t`, which Lingui bound to the original `_` when it built the instance.
 */

const BACKSLASH = '\\';
/** A private-use character, which no real task title, path or reason carries. */
const BACKSLASH_STAND_IN = '\uE000';
const GUARDED = Symbol.for('kangentic.i18n.placeholder-backslash-guard');

type TranslateValues = Record<string, unknown>;

function shieldValues(values: TranslateValues | undefined): TranslateValues | undefined {
  if (!values) return values;
  let shielded: TranslateValues | undefined;
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.includes(BACKSLASH)) {
      shielded ??= { ...values };
      shielded[name] = value.split(BACKSLASH).join(BACKSLASH_STAND_IN);
    }
  }
  return shielded ?? values;
}

export function guardPlaceholderBackslashes(instance: I18n): void {
  const marked = instance as I18n & { [GUARDED]?: true };
  if (marked[GUARDED]) return;
  marked[GUARDED] = true;

  const translate = instance._.bind(instance) as (
    id: string | MessageDescriptor,
    values?: TranslateValues,
    options?: Record<string, unknown>,
  ) => string;

  const guarded = (
    id: string | MessageDescriptor,
    values?: TranslateValues,
    options?: Record<string, unknown>,
  ): string => {
    let shielded = false;
    let nextId = id;
    if (typeof id === 'object' && id !== null) {
      const descriptorValues = shieldValues(id.values);
      if (descriptorValues !== id.values) {
        nextId = { ...id, values: descriptorValues };
        shielded = true;
      }
    }
    const nextValues = shieldValues(values);
    if (nextValues !== values) shielded = true;
    const result = translate(nextId, nextValues, options);
    return shielded ? result.split(BACKSLASH_STAND_IN).join(BACKSLASH) : result;
  };

  instance._ = guarded as I18n['_'];
  instance.t = guarded as I18n['t'];
}
