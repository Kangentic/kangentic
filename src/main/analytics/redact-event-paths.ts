import os from 'node:os';
import type { ErrorEvent } from '@sentry/electron/main';
import { redactHomeDirectory } from '../utility-process/stderr-tail';

/**
 * Rewrite this machine's home directory to `~` in every string of a Sentry event, before the
 * event leaves the machine.
 *
 * Why this exists: an OS username is often a person's real name, and it sits inside the home
 * directory path. The SDK's `normalizePathsIntegration` rewrites stack-frame paths only. An
 * exception message is free text, so a path in it (Monaco's rethrown diff-editor error carried
 * about 48 of them, DESKTOP-19) reached Sentry as typed. Those events are then read by agents
 * that write task descriptions on a board mirrored to a public repo.
 *
 * It walks the whole event rather than a list of fields, because the leaks turned up in
 * `exception.values[].value`, `message`, `contexts`, `extra` and `tags`, and the next one will be
 * somewhere nobody listed. Breadcrumbs have their own deny-by-default policy
 * (src/shared/sentry-breadcrumbs.ts) and pass through here a second time harmlessly.
 *
 * The home directory is the machine's own (`os.homedir()`), which is exact: every event this
 * process reports, renderer events included, comes from the same user profile. A native crash is
 * the case this cannot reach. Its stack, module paths and crashpad annotations are built on
 * Sentry's servers from the minidump after upload, so those need a Sentry Advanced Data Scrubbing
 * rule (docs/analytics.md, "Native crash fields").
 *
 * Mutates and returns the event. Never drops one, and never throws out of `redactEventHomeDirectory`.
 */

/** Deepest nesting walked. Events are plain JSON a few levels deep; the cap is only a guard against a cycle. */
const MAX_DEPTH = 24;

/**
 * Redact one slot of a container. A string is replaced only when it changed, and each slot has its
 * own guard: a frozen object, a read-only property or a throwing getter aborts that slot and
 * nothing else. Letting it abort the whole walk would leave every later field (a `message` after
 * a frozen `extra`) unredacted, and a privacy filter must fail toward redacting more.
 */
function redactSlot(
  container: Record<string, unknown> | unknown[],
  key: string | number,
  homeDirectory: string,
  caseInsensitive: boolean,
  depth: number,
): void {
  try {
    const slots = container as Record<string | number, unknown>;
    const original = slots[key];
    const redacted = redactValue(original, homeDirectory, caseInsensitive, depth);
    if (redacted !== original) slots[key] = redacted;
  } catch {
    // This one slot cannot be read or written; the rest of the event still gets redacted.
  }
}

function redactValue(
  value: unknown,
  homeDirectory: string,
  caseInsensitive: boolean,
  depth: number,
): unknown {
  if (typeof value === 'string') return redactHomeDirectory(value, homeDirectory, caseInsensitive);
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      redactSlot(value, index, homeDirectory, caseInsensitive, depth + 1);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    redactSlot(record, key, homeDirectory, caseInsensitive, depth + 1);
  }
  return record;
}

export function redactEventHomeDirectory(
  event: ErrorEvent,
  homeDirectory: string = os.homedir(),
  caseInsensitive: boolean = process.platform === 'win32',
): ErrorEvent {
  try {
    redactValue(event, homeDirectory, caseInsensitive, 0);
  } catch {
    // A privacy rewrite must not cost the event: a throwing `beforeSend` makes the SDK drop it.
  }
  return event;
}
