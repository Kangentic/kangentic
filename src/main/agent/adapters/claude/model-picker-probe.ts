/**
 * Model discovery via Claude Code's own `/model` picker.
 *
 * The CLI has no model enumeration surface (verified against `--help`:
 * no `models` subcommand, no list flag) and `claude auth status` exposes no
 * token that would let us call the Anthropic API on the user's behalf. The
 * one place the CLI does enumerate models - for every auth method, including
 * OAuth-only Pro/Max - is the interactive `/model` picker. So we spawn a
 * short-lived hidden PTY, open the picker, parse the rendered rows, press
 * Esc (never Enter - Enter would change the user's default model), and kill
 * the session.
 *
 * The probe runs `--safe-mode` so the user's hooks, plugins, MCP servers,
 * and CLAUDE.md never load (auth and model selection work normally there),
 * and uses a dedicated scratch cwd pre-trusted via trust-manager so the
 * workspace-trust dialog cannot appear.
 *
 * It also runs on the CLASSIC renderer (`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`,
 * the first row of Claude's documented renderer precedence, so it holds under
 * `--safe-mode` too). The fullscreen renderer keeps a boot canary in
 * `~/.claude.json` (`fullscreenBootPending[pid]`, withdrawn 10 s after the
 * first frame or on a graceful exit) and counts a pid that died inside that
 * window as a strike: one strike runs the next launch on the classic renderer,
 * two make it sticky for every Kangentic session on the machine. This probe
 * lives about two seconds and used to be hard-killed, so it was a strike
 * generator; the classic renderer never arms the canary. Belt and suspenders,
 * the teardown also exits Claude with `/exit` and waits for the process before
 * the fallback kill. The picker text is identical in both renderers, and the
 * parser predates fullscreen (2.1.170).
 *
 * Failure contract matches the rest of capability discovery: a failure (CLI
 * missing, layout change, timeout) is never surfaced to the user, and resolves
 * to the last good scan when there is one, else undefined. Results are cached:
 * a complete scan is reused for hours (models ship rarely; the spawn costs
 * seconds), while a failed or incomplete one is retried after a short backoff
 * (see `recordProbeResult`). The last good scan is also kept in the
 * app's config directory (see `lastScanFilePath`) so a restart starts from it.
 */
// The probe's PTY runs in the pty host; node-pty loads only there, or lazily
// here when no host is registered, so importing this module loads nothing.
import { spawnOffMainPty, type OffMainPty, type OffMainPtyOptions } from '../../../utility-process/off-main-pty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VirtualScreen } from '../../../pty/virtual-screen';
import { PATHS } from '../../../config/paths';
import { compareModelVersion, parseModelFamily, parseModelId } from '../../../../shared/model-id';
import type { ModelAliasOption } from '../../../../shared/types';
import { isWindowsBatchShim, shimSibling } from '../../shared/shim-launch';
import { ensureWorktreeTrust } from './trust-manager';

// The VT screen-grid renderer this probe parses through now lives in
// src/main/pty/virtual-screen.ts (shared with the mobile bridge's
// prompt-options probe); re-exported here so existing imports keep working.
export { VirtualScreen };

const PROBE_COLS = 200;
const PROBE_ROWS = 50;

const SUCCESS_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;

interface ProbeTimings {
  /** Interval between screen polls while waiting for a marker. */
  pollIntervalMs: number;
  /** Pause before typing and between `/model` and Enter, so the TUI keeps up. */
  typeDelayMs: number;
  /** Interval between identical-screen checks once the picker is visible. */
  settleIntervalMs: number;
  /** Hard cap on the whole probe, spawn to parse. */
  overallTimeoutMs: number;
  /**
   * After `/exit`, how long the teardown waits for the CLI's own exit before
   * the fallback kill. Same figure as SessionManager's exit-sequence grace.
   */
  exitGraceMs: number;
  /** Interval between identical-screen checks after each scroll keypress. */
  scrollSettleMs: number;
}

const DEFAULT_TIMINGS: ProbeTimings = {
  pollIntervalMs: 100,
  typeDelayMs: 400,
  settleIntervalMs: 250,
  overallTimeoutMs: 15000,
  exitGraceMs: 1500,
  scrollSettleMs: 80,
};

/**
 * The picker shows ten rows and scrolls the rest ("… +2 models"). Arrow Down
 * only moves the highlight, it never selects (Enter would change the user's
 * default model), so the probe walks the highlight down until the last row is
 * on screen.
 */
const ARROW_DOWN = '\x1b[B';
/** Cap on scroll keypresses, so a picker that wraps around cannot loop forever. */
const MAX_SCROLL_PRESSES = 40;
/** Rows remain below while the frame shows a `↓ N.` row marker or a `… +N models` line. */
const ROWS_BELOW_PATTERN = /^\s*(?:↓\s*\d+\.|…\s*\+\d+\s+models?\b)/mu;
/**
 * A picker row: an optional selection (`❯`) or scroll (`↑` / `↓`) marker, the
 * row number (group 1), then the row text (group 2: label column, a run of
 * spaces, description). One pattern for both the frame merge and the parser,
 * so a new marker glyph cannot reach one and not the other.
 */
const PICKER_ROW_PATTERN = /^\s*(?:[❯↑↓]\s*)?(\d+)\.\s+(.+)$/u;

/** The probe's scratch cwd, pre-trusted so no trust dialog renders. */
function probeScratchDirectory(): string {
  return path.join(os.tmpdir(), 'kangentic-model-probe');
}

const LAST_SCAN_FILE_NAME = 'model-picker-last-scan.json';

/** Forces Claude's classic renderer, which never arms the fullscreen boot canary. */
export const PROBE_CLASSIC_RENDERER_ENV_KEY = 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN';

let timings: ProbeTimings = DEFAULT_TIMINGS;

/** What one picker read yields: the model ids and the floating aliases derived from them. */
export interface ModelPickerScan {
  /** Exact model ids, one per recognized row, in picker order. */
  models: string[];
  /** One floating alias per model family the picker lists, in first-appearance order. */
  aliases: ModelAliasOption[];
}

/**
 * One probe run's result. `complete` is false when the scroll stopped with rows
 * still below (it ran out of time or presses): the scan is usable but may lack
 * the rows it never reached, so it is never persisted or kept for the success TTL.
 */
interface ProbeOutcome {
  scan: ModelPickerScan;
  complete: boolean;
}

interface ProbeCache {
  cliPath: string;
  fetchedAtMs: number;
  scan: ModelPickerScan | undefined;
  /**
   * Set when the latest probe failed but an earlier good scan was kept: the
   * next probe waits out the failure backoff from here, not the success TTL.
   */
  failedAtMs?: number;
}

let cache: ProbeCache | null = null;
let inFlight: { cliPath: string; promise: Promise<ModelPickerScan | undefined> } | null = null;

/**
 * Where the last good scan survives a restart; null turns that off. Without
 * it the first discovery after launch has no picker result yet, so the model
 * list lacks the aliases and a stored `opus` shows as the raw id until the
 * background probe lands. Read once per process, only to seed an empty cache.
 * It lives in the per-user config directory, not beside the scratch cwd: a
 * fixed name under a shared `/tmp` lets another local user plant a symlink
 * that the write would follow. Only the app keeps the file: under plain Node
 * (the unit tests) it starts off, so no test reads or writes a developer's
 * real config directory unless it points the file somewhere itself.
 */
let lastScanFilePath: string | null = process.versions.electron
  ? path.join(PATHS.configDir, LAST_SCAN_FILE_NAME)
  : null;
let lastScanFileRead = false;

/** Test-only: clear cache and restore default timings between cases. Also turns the last-scan file off. */
export function resetModelPickerProbeForTests(): void {
  cache = null;
  inFlight = null;
  timings = DEFAULT_TIMINGS;
  lastScanFilePath = null;
  lastScanFileRead = false;
}

/** Test-only: point the last-scan file somewhere under the test's own temp directory, or turn it off. */
export function setModelPickerProbeScanFileForTests(filePath: string | null): void {
  lastScanFilePath = filePath;
  lastScanFileRead = false;
}

/**
 * The id shapes a scan can hold: the characters the parser itself produces
 * (`EXPLICIT_MODEL_ID_PATTERN`, and lowercased family words). Anything else in
 * the file (a hand edit, another build's format) was not written by this code.
 */
const PERSISTED_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9.:-]*$/u;
const PERSISTED_ALIAS_ID_PATTERN = /^[a-z]+$/u;

function isPersistedModelId(value: unknown): value is string {
  return typeof value === 'string' && PERSISTED_MODEL_ID_PATTERN.test(value);
}

/** A persisted cache record read back from disk, or null when it is not one. */
function parsePersistedScan(value: unknown): ProbeCache | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { cliPath?: unknown; fetchedAtMs?: unknown; scan?: unknown };
  if (typeof record.cliPath !== 'string' || typeof record.fetchedAtMs !== 'number') return null;
  // A record from the future would read as fresh for as long as the clock lags it.
  if (record.fetchedAtMs > Date.now()) return null;
  const scan = record.scan as { models?: unknown; aliases?: unknown } | undefined;
  if (!scan || !Array.isArray(scan.models) || !Array.isArray(scan.aliases)) return null;
  if (scan.models.length === 0 || !scan.models.every(isPersistedModelId)) return null;
  const aliases: ModelAliasOption[] = [];
  for (const alias of scan.aliases) {
    const entry = alias as { id?: unknown; resolvesTo?: unknown } | null;
    if (!entry || typeof entry.id !== 'string' || !PERSISTED_ALIAS_ID_PATTERN.test(entry.id)) return null;
    if (entry.resolvesTo !== undefined && !isPersistedModelId(entry.resolvesTo)) return null;
    aliases.push(entry.resolvesTo !== undefined ? { id: entry.id, resolvesTo: entry.resolvesTo } : { id: entry.id });
  }
  return { cliPath: record.cliPath, fetchedAtMs: record.fetchedAtMs, scan: { models: scan.models as string[], aliases } };
}

/**
 * Seed an empty cache from the last good scan on disk, once per process, when
 * it was taken with the same CLI, or with any CLI when the caller has no path
 * (the live `/model` command). It is then subject to the normal TTL, so a
 * stale one is still served immediately while a fresh probe replaces it.
 * Any read or parse failure just leaves the cache empty.
 */
function seedCacheFromLastScan(cliPath: string | undefined): void {
  if (lastScanFileRead || cache !== null || lastScanFilePath === null) return;
  lastScanFileRead = true;
  try {
    const record = parsePersistedScan(JSON.parse(fs.readFileSync(lastScanFilePath, 'utf8')));
    if (record && (cliPath === undefined || isSameCli(record.cliPath, cliPath))) cache = record;
  } catch {
    // No file yet, or unreadable: the probe runs as it always has.
  }
}

/** Keep a good scan for the next launch. Async and best-effort: losing it costs one slow first discovery. */
function persistLastScan(record: ProbeCache): void {
  if (lastScanFilePath === null || record.scan === undefined) return;
  void fs.promises.writeFile(lastScanFilePath, JSON.stringify(record), 'utf8').catch(() => undefined);
}

/**
 * Combine the frames the probe read while scrolling into one picker screen:
 * each numbered row once, in row order, under the header. Rows keep their
 * number as they scroll, which is what lets frames overlap without doubling.
 */
export function mergePickerFrames(frames: readonly string[]): string {
  const rowsByNumber = new Map<number, string>();
  for (const frame of frames) {
    const lines = frame.split('\n');
    const headerIndex = lines.findIndex((line) => line.includes('Select model'));
    if (headerIndex === -1) continue;
    for (const line of lines.slice(headerIndex + 1)) {
      const rowMatch = line.match(PICKER_ROW_PATTERN);
      if (!rowMatch) continue;
      const rowNumber = Number(rowMatch[1]);
      if (!rowsByNumber.has(rowNumber)) rowsByNumber.set(rowNumber, line);
    }
  }
  if (rowsByNumber.size === 0) return frames[0] ?? '';
  const orderedRows = Array.from(rowsByNumber.entries())
    .sort((first, second) => first[0] - second[0])
    .map(([, line]) => line);
  return ['Select model', ...orderedRows].join('\n');
}

/** Test-only: shrink the waits so orchestration tests run in milliseconds. */
export function setModelPickerProbeTimingsForTests(overrides: Partial<ProbeTimings>): void {
  timings = { ...DEFAULT_TIMINGS, ...overrides };
}

const EXPLICIT_MODEL_ID_PATTERN = /\((claude-[a-z0-9][a-z0-9.:-]*)\)/u;
const VERSIONED_MODEL_NAME_PATTERN = /\b([A-Z][A-Za-z]*) (\d+(?:\.\d+)?)\b/u;
/** A label column that names a model family, alone ("Sonnet") or with its version ("Sonnet 5.5"). */
const FAMILY_LABEL_PATTERN = /^([A-Z][a-z]+)(?: \d+(?:\.\d+)*)?$/u;

/**
 * The row's exact model id: an explicit `(claude-...)` id when the row shows
 * one, otherwise derived from the first `<Capitalized> <number>` pair
 * (`Sonnet 4.6` -> `claude-sonnet-4-6`, `Fable 5` -> `claude-fable-5`), which
 * matches the Anthropic id scheme for every current model. Null when the row
 * fits neither pattern.
 */
function pickerRowModelId(rowText: string): string | null {
  const explicitId = rowText.match(EXPLICIT_MODEL_ID_PATTERN);
  if (explicitId) return explicitId[1];
  const derived = rowText.match(VERSIONED_MODEL_NAME_PATTERN);
  if (!derived) return null;
  return `claude-${derived[1].toLowerCase()}-${derived[2].replace(/\./gu, '-')}`;
}

/** A row whose label names its own family, with the row id's parsed base and version. */
interface FamilyRow {
  familyWord: string;
  baseId: string;
  version: number[];
}

/**
 * The family word a row's LABEL column names, when that label is the model's
 * own name and the row's id belongs to that family; otherwise null. The label
 * is the text before the first run of 2+ spaces, with the active row's `✔`
 * and a ` (1M context)` qualifier removed. Requiring the label to name the
 * row's own family is what rejects the Default row (its model is named only in
 * its description), `Opus Plan Mode`, and a custom label an environment
 * override supplies, without keeping a list of any of them.
 */
function pickerRowFamily(rowText: string, rowModelId: string): FamilyRow | null {
  const label = (rowText.split(/\s{2,}/u)[0] ?? '')
    .replace(/\s*✔\s*$/u, '')
    .replace(/ \(1M context\)$/u, '')
    .trim();
  const labelMatch = label.match(FAMILY_LABEL_PATTERN);
  if (!labelMatch) return null;
  const familyWord = labelMatch[1].toLowerCase();
  const baseId = parseModelId(rowModelId).baseId;
  const { family, version } = parseModelFamily(baseId);
  return family === `claude-${familyWord}` && version.length > 0 ? { familyWord, baseId, version } : null;
}

/**
 * Parse the rendered `/model` picker into model ids and floating aliases.
 *
 * Picker shape (empirical, Claude Code 2.1.284, a Claude Max account, probe
 * run 2026-09-28):
 *
 *   Select model
 *   Switch between Claude models. ...
 *   ❯ 1.  Default (recommended) ✔  Opus 5.5 · Best for everyday, complex tasks
 *     2.  Opus 5.5                 For complex work and everyday tasks
 *     3.  Fable 5.1                For your toughest challenges
 *     4.  Sonnet 5.5               Most efficient for simpler tasks
 *     5.  Haiku 4.5                Fastest for quick answers
 *     6.  Sonnet 5                 Efficient for routine tasks
 *     ...
 *   ↓ 10. Opus 4.7                 Best for everyday, complex tasks
 *      … +2 models
 *
 * Claude Code 2.1.170 labelled the family rows with the bare family name and
 * named the version in the description (`3. Sonnet   Sonnet 4.6 · ...`), and
 * marked the active row with an explicit id (`❯ 5. Opus 4.8 ✔ ... (claude-opus-4-8)`).
 * Both layouts parse.
 *
 * `models` holds every row's id (see `pickerRowModelId`); a row that yields
 * none is skipped rather than failing the probe.
 *
 * `aliases` holds one floating alias per model family whose own name labels a
 * row. The picker never shows an alias spelling, so the spelling is derived:
 * the lowercased family word, the CLI's documented "alias for the latest
 * model" (`--model` help: "e.g. 'fable', 'opus', or 'sonnet'"). What the alias
 * currently means is read from the picker, never guessed: the highest version
 * among that family's rows. No family name is listed anywhere here.
 */
export function parseModelPickerScreen(screenText: string): ModelPickerScan {
  const lines = screenText.split('\n');
  const headerIndex = lines.findIndex((line) => line.includes('Select model'));
  if (headerIndex === -1) return { models: [], aliases: [] };

  const models: string[] = [];
  const newestByFamilyWord = new Map<string, { baseId: string; version: number[] }>();
  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex++) {
    const rowMatch = lines[lineIndex].match(PICKER_ROW_PATTERN);
    if (!rowMatch) continue;
    const rowText = rowMatch[2];
    const rowModelId = pickerRowModelId(rowText);
    if (rowModelId === null) continue;
    if (!models.includes(rowModelId)) models.push(rowModelId);

    const familyRow = pickerRowFamily(rowText, rowModelId);
    if (familyRow === null) continue;
    const newest = newestByFamilyWord.get(familyRow.familyWord);
    if (!newest || compareModelVersion(familyRow.version, newest.version) > 0) {
      newestByFamilyWord.set(familyRow.familyWord, { baseId: familyRow.baseId, version: familyRow.version });
    }
  }

  const aliases = Array.from(newestByFamilyWord.entries(), ([familyWord, newest]) => ({
    id: familyWord,
    resolvesTo: newest.baseId,
  }));
  return { models, aliases };
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function spawnEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') environment[key] = value;
  }
  // Classic renderer: no alt screen, no boot canary to trip (see the module
  // comment). Set unconditionally - a user's `/tui fullscreen` is for their
  // sessions, and this hidden one has no renderer preference to honor.
  environment[PROBE_CLASSIC_RENDERER_ENV_KEY] = '1';
  return environment;
}

/**
 * Exit the probe's CLI the way a user would (`/exit`), then wait for the
 * process itself before falling back to a kill. Detached from the probe's
 * result on purpose: the models are already parsed, and the dropdown rescan
 * that awaits them must not pay the grace.
 *
 * The caller has just written Esc to close the picker. `/exit` must NOT follow
 * in the same input burst: the TUI reads `\x1b/` as an escape-prefixed key
 * sequence, the text never reaches the input box, and the fallback kill ends
 * up doing the whole teardown (measured with the canary rig: the CLI was still
 * in the picker's alt screen when the kill landed). The same type delay that
 * paces `/model` and Enter separates the two.
 */
async function exitProbeGracefully(
  probeProcess: OffMainPty,
  exited: Promise<void>,
  settleMs: number,
  graceMs: number,
): Promise<void> {
  await delay(settleMs);
  try {
    probeProcess.write('/exit\r');
  } catch {
    // Already dead.
  }
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const exitedInTime = await Promise.race([
    exited.then(() => true),
    new Promise<boolean>((resolve) => {
      graceTimer = setTimeout(() => resolve(false), graceMs);
    }),
  ]);
  if (graceTimer !== undefined) clearTimeout(graceTimer);
  if (exitedInTime) return;
  try {
    probeProcess.kill();
  } catch {
    // EACCES/ESRCH when the process exited between the race and the kill.
  }
}

/**
 * One full probe run: spawn, wait for the prompt, open `/model`, wait for
 * the picker to render and settle, scroll it with Arrow Down until no rows
 * remain below, parse the merged frames, Esc, kill. Never throws.
 */
async function runModelPickerProbe(cliPath: string): Promise<ProbeOutcome | undefined> {
  const scratchDirectory = probeScratchDirectory();
  try {
    fs.mkdirSync(scratchDirectory, { recursive: true });
    // Pre-trust the scratch cwd so the workspace-trust dialog never renders.
    // Belt and suspenders: if the dialog shows up anyway, the wait loop below
    // detects it and bails without sending a single keystroke.
    await ensureWorktreeTrust(scratchDirectory);
  } catch {
    return undefined;
  }

  const screen = new VirtualScreen(PROBE_COLS, PROBE_ROWS);
  let probeProcess: OffMainPty;
  try {
    // Spawned in the pty host (off-main-pty.ts): ConPTY creation is
    // synchronous, and node-pty loads only where a PTY actually runs.
    const spawnOptions: OffMainPtyOptions = {
      name: 'xterm-256color',
      cols: PROBE_COLS,
      rows: PROBE_ROWS,
      cwd: scratchDirectory,
      env: spawnEnvironment(),
    };
    // --safe-mode: hooks, plugins, MCP servers, CLAUDE.md all skipped; auth
    // and model selection work normally (verified empirically on 2.1.170).
    probeProcess = process.platform === 'win32'
      ? await spawnOffMainPty('cmd.exe', ['/c', cliPath, '--safe-mode'], spawnOptions)
      : await spawnOffMainPty(cliPath, ['--safe-mode'], spawnOptions);
  } catch {
    return undefined;
  }

  let exited = false;
  let resolveExited: () => void = () => undefined;
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExited = resolve;
  });
  // Set once the input box has rendered: only then is a typed `/exit` a
  // command rather than a keystroke into whatever dialog is showing.
  let promptSeen = false;
  probeProcess.onData((data) => screen.write(data));
  probeProcess.onExit(() => {
    exited = true;
    resolveExited();
  });

  const deadline = Date.now() + timings.overallTimeoutMs;
  const waitForScreen = async (marker: string): Promise<boolean> => {
    while (Date.now() < deadline) {
      const frame = screen.text();
      // Pre-trust failed and the workspace-trust dialog rendered (it also
      // contains a '❯' selector, so check before the marker): bail without
      // sending a keystroke - Enter on that dialog would accept trust.
      if (frame.includes('trust this folder')) return false;
      if (frame.includes(marker)) return true;
      if (exited) return false;
      await delay(timings.pollIntervalMs);
    }
    return false;
  };

  try {
    // The '❯' prompt marker appears when the input box is ready for keys.
    if (!(await waitForScreen('❯'))) return undefined;
    promptSeen = true;
    await delay(timings.typeDelayMs);
    probeProcess.write('/model');
    await delay(timings.typeDelayMs);
    probeProcess.write('\r');

    if (!(await waitForScreen('Select model'))) return undefined;

    // Let the picker finish painting: two identical consecutive frames. Parse
    // only frames we confirmed stable - if the deadline expires while the
    // picker is still mid-paint, treat it as a failure rather than caching a
    // half-rendered (truncated) model list as a 12-hour success.
    const waitForStableFrame = async (intervalMs: number): Promise<string | undefined> => {
      let previousFrame = '';
      while (Date.now() < deadline) {
        const currentFrame = screen.text();
        if (currentFrame === previousFrame) return currentFrame;
        previousFrame = currentFrame;
        await delay(intervalMs);
      }
      return undefined;
    };
    const stableFrame = await waitForStableFrame(timings.settleIntervalMs);
    if (stableFrame === undefined) return undefined;

    // Walk the highlight down until the picker has no rows left below
    // (see ARROW_DOWN), keeping every settled frame. A scroll that runs out of
    // time or presses still parses what it saw, the result every probe
    // returned before scrolling existed, but reports itself incomplete.
    const frames = [stableFrame];
    let latestFrame = stableFrame;
    for (let presses = 0; presses < MAX_SCROLL_PRESSES && ROWS_BELOW_PATTERN.test(latestFrame); presses++) {
      probeProcess.write(ARROW_DOWN);
      await delay(timings.scrollSettleMs);
      const settledFrame = await waitForStableFrame(timings.scrollSettleMs);
      if (settledFrame === undefined) break;
      latestFrame = settledFrame;
      frames.push(settledFrame);
    }

    const scan = parseModelPickerScreen(mergePickerFrames(frames));
    if (scan.models.length === 0) return undefined;
    return { scan, complete: !ROWS_BELOW_PATTERN.test(latestFrame) };
  } catch {
    return undefined;
  } finally {
    // Esc closes the picker without selecting (Enter would change the
    // user's default model), then tear the hidden session down.
    try {
      probeProcess.write('\x1b');
    } catch {
      // Already dead.
    }
    if (promptSeen && !exited) {
      // `/exit` then wait for the CLI's own exit (cmd exits with its child on
      // Windows; POSIX runs the CLI directly), kill only as the fallback. Not
      // awaited: the result above is final and the caller must not wait.
      void exitProbeGracefully(probeProcess, exitedPromise, timings.typeDelayMs, timings.exitGraceMs);
    } else {
      // No prompt was ever reached (trust dialog, early exit, timeout before
      // the input box): a typed Enter here could accept the trust dialog, so
      // this stays the plain kill. Nothing booted far enough to arm a canary.
      try {
        probeProcess.kill();
      } catch {
        // EACCES/ESRCH when the process already exited - nothing to clean up.
      }
    }
  }
}

/**
 * Store one probe's outcome. A failure or an incomplete scan after a good scan
 * for the same CLI (seeded from disk or from an earlier probe) keeps that scan
 * rather than blanking the pickers' aliases or truncating the list, and retries
 * after the failure backoff. An incomplete scan with nothing better to keep is
 * served until that backoff too. Only a complete scan is persisted.
 */
function recordProbeResult(cliPath: string, outcome: ProbeOutcome | undefined): void {
  const nowMs = Date.now();
  const complete = outcome?.complete === true;
  if (!complete && cache !== null && cache.cliPath === cliPath && cache.scan !== undefined) {
    // Degraded: keep the earlier good scan, retry after the failure backoff.
    cache = { ...cache, failedAtMs: nowMs };
    return;
  }
  if (outcome === undefined) {
    // Empty: nothing to serve, retry after the failure backoff.
    cache = { cliPath, fetchedAtMs: nowMs, scan: undefined };
    return;
  }
  if (!complete) {
    // Partial: serve what the scroll reached, retry after the failure backoff.
    cache = { cliPath, fetchedAtMs: nowMs, scan: outcome.scan, failedAtMs: nowMs };
    return;
  }
  // Fresh: reused for the success TTL and kept for the next launch.
  cache = { cliPath, fetchedAtMs: nowMs, scan: outcome.scan };
  persistLastScan(cache);
}

/**
 * How long a cache entry may be served without a new probe, measured from
 * when: a fresh scan for the success TTL from its fetch, anything else
 * (degraded, empty, partial) for the failure backoff from its last failure.
 */
function cacheReuseWindow(entry: ProbeCache): { startMs: number; durationMs: number } {
  const isFresh = entry.scan !== undefined && entry.failedAtMs === undefined;
  return isFresh
    ? { startMs: entry.fetchedAtMs, durationMs: SUCCESS_TTL_MS }
    : { startMs: entry.failedAtMs ?? entry.fetchedAtMs, durationMs: FAILURE_TTL_MS };
}

/**
 * The floating alias ids the last scan reported, read without starting a
 * probe (a spawn must never cost a PTY round trip). Seeds from the last-scan
 * file like the other accessors. With no `cliPath`, whatever the cache holds
 * is used (the live `/model` command has no CLI path at hand). Empty when no
 * scan is known yet, so callers degrade to passing values through unchanged.
 */
export function peekModelPickerAliasIds(cliPath?: string): ReadonlySet<string> {
  seedCacheFromLastScan(cliPath);
  if (!cache?.scan) return new Set();
  if (cliPath !== undefined && !isSameCli(cache.cliPath, cliPath)) return new Set();
  return new Set(cache.scan.aliases.map((alias) => alias.id));
}

/**
 * Whether two paths name the same CLI. Discovery probes the detected path,
 * but a spawn on Windows runs a batch shim's sibling instead (`claude.cmd` ->
 * `claude.ps1` or `claude`, see resolveShimLaunch), so a spawn's `cliPath`
 * must still match the scan its detection path produced.
 */
function isSameCli(scannedPath: string, cliPath: string): boolean {
  if (scannedPath === cliPath) return true;
  return isWindowsBatchShim(scannedPath)
    && (cliPath === shimSibling(scannedPath, '.ps1') || cliPath === shimSibling(scannedPath, ''));
}

/**
 * Non-blocking accessor for capability discovery. Returns whatever the cache
 * currently holds (undefined on the very first call) and kicks off a
 * background probe to warm it - it never awaits the PTY round trip, because
 * discovery sits on the `agents.list` path the renderer awaits and a 15s
 * picker timeout there would stall the model dropdown on first launch.
 *
 * Consequence: a newly shipped model surfaces on the *next* discovery call
 * after the background probe settles (~2s for the real CLI), not the first.
 * That matches how transcript-discovered models already accrue over time.
 * The renderer persists the model ids once seen, and the whole scan
 * (aliases included) is kept in the last-scan file, so both are there from
 * the first call on every subsequent launch.
 */
export function getCachedModelPickerModels(cliPath: string): ModelPickerScan | undefined {
  seedCacheFromLastScan(cliPath);
  // Fire-and-forget: probeModelPickerModels self-guards (no-op when the cache
  // is fresh or a probe is already in flight) and never rejects.
  void probeModelPickerModels(cliPath).catch(() => undefined);
  return cache && cache.cliPath === cliPath ? cache.scan : undefined;
}

/**
 * Awaitable cached probe. Concurrent callers share one in-flight probe;
 * results are reused per `cacheReuseWindow` (a complete scan for
 * SUCCESS_TTL_MS, a failed or incomplete one for FAILURE_TTL_MS) per CLI
 * path. Capability discovery uses getCachedModelPickerModels (non-blocking)
 * instead of awaiting this directly.
 *
 * `forceRefresh` bypasses the TTL early-return so a fresh probe runs even when
 * the cache is still warm - the on-demand rescan a model dropdown fires when it
 * opens, so a newly shipped model surfaces without a Kangentic restart. The
 * in-flight dedup is still honored (an already-running probe is a fresh result,
 * so we ride it rather than spawning a second PTY).
 */
export async function probeModelPickerModels(
  cliPath: string,
  forceRefresh = false,
): Promise<ModelPickerScan | undefined> {
  seedCacheFromLastScan(cliPath);
  if (!forceRefresh && cache && cache.cliPath === cliPath) {
    const reuseWindow = cacheReuseWindow(cache);
    if (Date.now() - reuseWindow.startMs < reuseWindow.durationMs) return cache.scan;
  }
  if (inFlight && inFlight.cliPath === cliPath) return inFlight.promise;

  const promise = runModelPickerProbe(cliPath).then(
    (outcome) => {
      recordProbeResult(cliPath, outcome);
      inFlight = null;
      return cache?.scan;
    },
    () => {
      // runModelPickerProbe is written never to reject, but guard the state
      // machine anyway: an unexpected throw must not strand `inFlight` and
      // wedge every future probe on a permanently-pending promise.
      recordProbeResult(cliPath, undefined);
      inFlight = null;
      return cache?.scan;
    },
  );
  inFlight = { cliPath, promise };
  return promise;
}
