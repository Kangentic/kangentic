import os from 'node:os';
import type { ErrorEvent } from '@sentry/electron/main';
import { pathPattern, trimTrailingSeparators } from '../utility-process/stderr-tail';
import { knownProjectRoots } from '../shared/project-roots';

/**
 * Rewrite every known project root to `[project]`, then this machine's home directory to `~`, in
 * every string of a Sentry event, before the event leaves the machine.
 *
 * Why this exists: an OS username is often a person's real name, and it sits inside the home
 * directory path. A project's folder name can name a client or employer. The SDK's
 * `normalizePathsIntegration` rewrites stack-frame paths only. An exception message is free text,
 * so a path in it (Monaco's rethrown diff-editor error carried about 48 of them, DESKTOP-19)
 * reached Sentry as typed. A project on another drive was out of the home rewrite's reach. A spawn
 * that failed on a full disk sent its session directory whole, issue title included (DESKTOP-21).
 * Those events are then read by agents that write task descriptions on a board mirrored to a
 * public repo.
 *
 * Project roots run first, longest first, so a project under the home directory loses its folder
 * name too rather than becoming `~/projects/<name>`. The roots come from an in-memory ledger
 * (src/main/shared/project-roots.ts), never from the database, because this runs inside
 * `beforeSend`, which can fire before the global database opens and after shutdown closes it.
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
 * rule (docs/telemetry/error-reporting.md, "Native crash fields").
 *
 * Mutates and returns the event. Never drops one, and never throws out of `redactEventPaths`.
 */

/** What a project root becomes. Not `~`, because a project on another drive shown as the home
 *  directory would mislead whoever triages the event. */
export const PROJECT_ROOT_PLACEHOLDER = '[project]';

/** Deepest nesting walked. Events are plain JSON a few levels deep; the cap is only a guard against a cycle. */
const MAX_DEPTH = 24;

interface PathRewrite {
  pattern: RegExp;
  replacement: string;
}

/** A path's named segments, for comparing one path's prefix with another's. Empty segments are
 *  dropped, so `/home/dev` and `home/dev` compare equal. `pathPattern` keeps a POSIX path's leading
 *  empty segment instead, because there it anchors the pattern on the leading separator. */
function pathSegments(rawPath: string): string[] {
  return rawPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/** Whether `segments` begins with every one of `prefix`, case-folded when `caseInsensitive`. */
function startsWithSegments(segments: string[], prefix: string[], caseInsensitive: boolean): boolean {
  if (prefix.length > segments.length) return false;
  const normalizeCase = (segment: string): string => (caseInsensitive ? segment.toLowerCase() : segment);
  return prefix.every((segment, index) => normalizeCase(segment) === normalizeCase(segments[index]));
}

/** A drive root (`D:\`, `/`, or an empty root): no separator left once the trailing ones are cut.
 *  A one-segment root such as `/client-app` keeps its leading separator and is not one. */
function isDriveRoot(root: string): boolean {
  return !/[\\/]/.test(trimTrailingSeparators(root));
}

/**
 * A root that would do harm as a rewrite. A drive root would rewrite every path on the drive. A
 * root that is the home directory or above it (`C:\Users`) would turn `C:\Users\dev` into
 * `[project]\dev` before the home rewrite runs, leaving the username in the event. The home rewrite
 * covers both.
 */
function isUnsafeProjectRoot(root: string, homeSegments: string[], caseInsensitive: boolean): boolean {
  if (isDriveRoot(root)) return true;
  return startsWithSegments(homeSegments, pathSegments(root), caseInsensitive);
}

/**
 * The patterns for one root: its own spelling, and for a root inside the home directory its
 * `~`-relative spelling too. Text redacted at its capture site arrives already rewritten (a
 * worker's stderr tail, `StderrTail.snapshot`), so a project under home reaches this pass as
 * `~/projects/<name>`, which the absolute pattern no longer matches.
 */
function rootPatterns(root: string, homeSegments: string[], caseInsensitive: boolean): RegExp[] {
  const patterns: RegExp[] = [];
  const absolute = pathPattern(root, caseInsensitive);
  if (absolute) patterns.push(absolute);
  const rootSegments = pathSegments(root);
  if (homeSegments.length > 0 && startsWithSegments(rootSegments, homeSegments, caseInsensitive)) {
    const homeRelative = pathPattern(['~', ...rootSegments.slice(homeSegments.length)].join('/'), caseInsensitive);
    if (homeRelative) patterns.push(homeRelative);
  }
  return patterns;
}

/** Project roots longest first, so a nested project is matched before the one around it, then the home directory. */
function buildRewrites(
  homeDirectory: string,
  caseInsensitive: boolean,
  projectRoots: Iterable<string>,
): PathRewrite[] {
  const homeSegments = pathSegments(homeDirectory);
  const roots = [...projectRoots]
    .filter((root) => !isUnsafeProjectRoot(root, homeSegments, caseInsensitive))
    .sort((first, second) => second.length - first.length);
  const rewrites: PathRewrite[] = [];
  for (const root of roots) {
    for (const pattern of rootPatterns(root, homeSegments, caseInsensitive)) {
      rewrites.push({ pattern, replacement: PROJECT_ROOT_PLACEHOLDER });
    }
  }
  const homePattern = pathPattern(homeDirectory, caseInsensitive);
  if (homePattern) rewrites.push({ pattern: homePattern, replacement: '~' });
  return rewrites;
}

/**
 * Redact one slot of a container. A string is replaced only when it changed, and each slot has its
 * own guard: a frozen object, a read-only property or a throwing getter aborts that slot and
 * nothing else. Letting it abort the whole walk would leave every later field (a `message` after
 * a frozen `extra`) unredacted, and a privacy filter must fail toward redacting more.
 */
function redactSlot(
  container: Record<string, unknown> | unknown[],
  key: string | number,
  rewrites: PathRewrite[],
  depth: number,
): void {
  try {
    const slots = container as Record<string | number, unknown>;
    const original = slots[key];
    const redacted = redactValue(original, rewrites, depth);
    if (redacted !== original) slots[key] = redacted;
  } catch {
    // This one slot cannot be read or written; the rest of the event still gets redacted.
  }
}

function redactValue(value: unknown, rewrites: PathRewrite[], depth: number): unknown {
  if (typeof value === 'string') {
    return rewrites.reduce((text, rewrite) => text.replace(rewrite.pattern, rewrite.replacement), value);
  }
  if (value === null || typeof value !== 'object' || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      redactSlot(value, index, rewrites, depth + 1);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    redactSlot(record, key, rewrites, depth + 1);
  }
  return record;
}

export function redactEventPaths(
  event: ErrorEvent,
  homeDirectory: string = os.homedir(),
  caseInsensitive: boolean = process.platform === 'win32',
  projectRoots: Iterable<string> = knownProjectRoots(),
): ErrorEvent {
  try {
    const rewrites = buildRewrites(homeDirectory, caseInsensitive, projectRoots);
    if (rewrites.length > 0) redactValue(event, rewrites, 0);
  } catch {
    // A privacy rewrite must not cost the event: a throwing `beforeSend` makes the SDK drop it.
  }
  return event;
}
