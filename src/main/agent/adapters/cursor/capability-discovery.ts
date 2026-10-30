/**
 * Cursor CLI capability discovery: model override support and the live model list.
 *
 * Verified against cursor-agent on 2026-09-13:
 * - `cursor-agent --help` documents `--model <model>`, parsed from the live help
 *   text so a future CLI that drops the flag degrades automatically.
 * - `cursor-agent --list-models` prints an `Available models` header, one
 *   `<id> - <Display Name>` line per model, then a `Tip:` footer. 224 models in
 *   1.3 s: it is a NETWORK fetch, hence the longer timeout and the cache. An
 *   invalid credential exits non-zero with a stderr warning and no model lines.
 *
 * Two lines carry a state marker that is not part of the name - `auto - Auto
 * (default)` and `<id> - <Name> (current)`, the latter tracking whatever the
 * user last selected. `(NO ZDR)` IS part of the name, so the strip enumerates
 * the two markers by word rather than dropping any trailing parenthetical.
 *
 * Nothing is hardcoded here. A CLI that cannot be asked yields no list and the
 * renderer falls back to a free-form model input, which is the honest failure:
 * a wrong model list is worse than an empty one, because the user acts on it.
 */

import { execAsync, execFileAsync } from '../../../utility-process/off-main-exec';
import { quoteArg } from '../../../../shared/paths';
import { quoteCmdExecutable } from '../../../../shared/shell-quote';
import { execCliForTarget, resolveCliTarget, type CliTarget } from '../../shared/cli-target';
import type { AgentCapabilities } from '../../../../shared/types';


const HELP_TIMEOUT_MS = 5000;
const MODELS_TIMEOUT_MS = 10000;

let cache: { cliPath: string; capabilities: AgentCapabilities } | null = null;

/** Test-only: reset the discovery cache between cases. */
export function resetCursorCapabilityCacheForTests(): void {
  cache = null;
}

/**
 * Run the Cursor CLI and capture both streams.
 *
 * On Windows, npm/installer shims (.cmd / .CMD) cannot be invoked via
 * `execFile` because Node's CVE-2024-27980 mitigation refuses to execute
 * .cmd/.bat without a shell, so we use `exec` with a quoted command string
 * (same pattern as the codex/claude/gemini adapters). Other platforms keep
 * `execFile`, which is safer and faster for native binaries.
 *
 * Both streams are returned so each caller can decide: help detection wants
 * stderr too (a CLI is free to print help there), while the models parse wants
 * stdout only, so a stderr warning can never be mistaken for a model row.
 *
 * Each arg is quoted on the win32 path. Today's callers pass bare literal flags,
 * which `quoteArg` returns untouched, so this costs nothing now. It is here
 * because the win32 branch builds a SHELL STRING: the moment a caller threads a
 * path or a model id through `args`, an unquoted join is a command injection,
 * and the non-win32 `execFile` branch would not share the bug to reveal it.
 *
 * A Cursor installed in a WSL distro (`target`) runs there, through `wsl.exe`.
 */
async function runCursorCli(
  cliPath: string,
  args: string[],
  timeoutMs: number,
  target: CliTarget | null,
): Promise<{ stdout: string; stderr: string }> {
  if (target) return execCliForTarget(target, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
  if (process.platform === 'win32') {
    // `exec` runs the line through cmd.exe here, so both the head and the args
    // take cmd's escaping. With no shell hint, quoteArg would apply PowerShell's.
    return execAsync(`${quoteCmdExecutable(cliPath)} ${args.map((arg) => quoteArg(arg, 'cmd.exe')).join(' ')}`, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  }
  return execFileAsync(cliPath, args, {
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Parse `cursor-agent --help` to detect whether `--model` is supported.
 *
 * Kept deliberately separate from the model listing. `supportsModelOverride` is
 * what keeps the renderer's free-form model input alive when the list is empty
 * (see `AgentCapabilities` in shared/types), so deriving it from a successful
 * listing would take the input away on an auth failure - a worse degradation
 * than the empty list it would be reporting.
 */
async function detectModelFlagSupport(cliPath: string, target: CliTarget | null): Promise<boolean> {
  try {
    const { stdout, stderr } = await runCursorCli(cliPath, ['--help'], HELP_TIMEOUT_MS, target);
    // Look for exact flag pattern: --model followed by whitespace and arg description.
    return /--model\s+<|--model\s+[A-Za-z]/.test(stdout + stderr);
  } catch {
    // If help fails, assume no model support.
    return false;
  }
}

/** Trailing state markers the CLI appends to a display name; not part of it. */
const MODEL_STATE_MARKER = /\s*\((?:current|default)\)$/;

/**
 * Parse `cursor-agent --list-models` output into id -> display-name pairs.
 *
 * A model id never contains a space, so anchoring on `^(\S+)` makes the
 * `Available models` header and the `Tip:` footer fall out for free: neither
 * matches, and anything that does not match is skipped. That way a partial or
 * unauthenticated fetch degrades to "no list" rather than garbage entries.
 */
export function parseCursorModelsOutput(
  stdout: string,
): { models: string[]; displayNames: Record<string, string> } {
  const models: string[] = [];
  const seen = new Set<string>();
  const displayNames: Record<string, string> = {};
  // Split tolerates CRLF: a trailing \r would make `(.+)$` unmatchable
  // (`.` excludes \r and `$` only anchors at end of input), silently
  // dropping every line of a Windows-emitted models list.
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+-\s+(.+)$/);
    if (!match) continue;
    const modelId = match[1].trim();
    if (!modelId || seen.has(modelId)) continue;
    seen.add(modelId);
    models.push(modelId);
    const displayName = match[2].trim().replace(MODEL_STATE_MARKER, '').trim();
    if (displayName) displayNames[modelId] = displayName;
  }
  return { models, displayNames };
}

/**
 * Discover Cursor's capabilities. Best-effort and never throws: a failed help
 * read yields no override support, a failed listing yields override support
 * with no list (the renderer falls back to a free-form input). Cached per
 * cliPath because the listing is a network fetch; `forceRefresh` (the model
 * dropdown's rescan-on-open) bypasses it.
 */
export async function discoverCursorCapabilities(
  cliPath: string,
  forceRefresh = false,
): Promise<AgentCapabilities> {
  if (!forceRefresh && cache && cache.cliPath === cliPath) return cache.capabilities;

  // A distro whose facts cannot be read cannot be asked either: no override
  // support, as for a help read that failed. Not cached, since the facts read
  // keeps no failure either: a distro still booting answers the next ask.
  const target = await resolveCliTarget(cliPath, true).catch(() => undefined);
  if (target === undefined) return { supportsModelOverride: false, effortLevels: [] };
  const supportsModelOverride = await detectModelFlagSupport(cliPath, target);

  let models: string[] = [];
  let displayNames: Record<string, string> = {};
  if (supportsModelOverride) {
    try {
      const { stdout } = await runCursorCli(cliPath, ['--list-models'], MODELS_TIMEOUT_MS, target);
      const parsed = parseCursorModelsOutput(stdout);
      models = parsed.models;
      displayNames = parsed.displayNames;
    } catch {
      // Network/auth failure - free-form input fallback.
    }
  }

  const capabilities: AgentCapabilities = {
    supportsModelOverride,
    models: models.length > 0 ? models : undefined,
    modelDisplayNames: Object.keys(displayNames).length > 0 ? displayNames : undefined,
    // Effort levels are not a separate concept in Cursor - reasoning is encoded
    // in the model id (e.g. `claude-sonnet-5-thinking-high` vs `claude-sonnet-5-high`).
    effortLevels: [],
  };
  cache = { cliPath, capabilities };
  return capabilities;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Lowercase, dashes and underscores as spaces, so `cursor-grok-4.6-high` and `grok 4.6 high` compare. */
function normalizeCursorModelToken(value: string): string {
  return collapseWhitespace(value.toLowerCase().replace(/[-_]+/g, ' '));
}

export interface CursorModelCatalog {
  models: readonly string[];
  displayNames: Record<string, string>;
}

/**
 * The value `--model` accepts for a stored picker value. The combobox shows
 * Cursor's display names ("Grok 4.6") and a live session reports those names
 * as its model (stream-json init and `agent about`), so a column can hold
 * `grok 4.6 high` rather than `cursor-grok-4.6-high`. The CLI rejects the
 * display spelling. Resolve against the last `--list-models` catalog:
 * exact id, then display name, then the id with dashes read as spaces, then a
 * unique `cursor-` prefix or unique suffix of a normalized id. Unresolved
 * input is returned trimmed, so a genuinely unknown value still reaches the CLI.
 */
export function resolveCursorModelId(input: string, catalog: CursorModelCatalog): string {
  const trimmed = input.trim();
  if (!trimmed || catalog.models.length === 0) return trimmed;
  if (catalog.models.includes(trimmed)) return trimmed;

  const collapsedLower = collapseWhitespace(trimmed).toLowerCase();
  const byDisplayName = catalog.models.filter(
    (modelId) => collapseWhitespace(catalog.displayNames[modelId] ?? '').toLowerCase() === collapsedLower,
  );
  if (byDisplayName.length === 1) return byDisplayName[0];

  const normalized = normalizeCursorModelToken(trimmed);
  const byNormalizedId = catalog.models.filter((modelId) => normalizeCursorModelToken(modelId) === normalized);
  if (byNormalizedId.length === 1) return byNormalizedId[0];

  const byCursorPrefix = catalog.models.filter(
    (modelId) => normalizeCursorModelToken(modelId) === `cursor ${normalized}`,
  );
  if (byCursorPrefix.length === 1) return byCursorPrefix[0];

  const bySuffix = catalog.models.filter((modelId) => {
    const normalizedId = normalizeCursorModelToken(modelId);
    return normalizedId === normalized || normalizedId.endsWith(` ${normalized}`);
  });
  if (bySuffix.length === 1) return bySuffix[0];

  return trimmed;
}

/**
 * Resolve against the catalog `discoverCursorCapabilities` last stored for
 * `cliPath`, or the most recent catalog if that path has not been probed.
 * Trimmed input when nothing is cached, so a spawn before discovery still
 * passes what was stored.
 */
export function resolveCachedCursorModel(input: string, cliPath?: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  const capabilities = (cliPath && cache?.cliPath === cliPath ? cache.capabilities : null)
    ?? cache?.capabilities
    ?? null;
  if (!capabilities?.models?.length) return trimmed;
  return resolveCursorModelId(trimmed, {
    models: capabilities.models,
    displayNames: capabilities.modelDisplayNames ?? {},
  });
}
