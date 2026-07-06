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
 * Failure contract matches the rest of capability discovery: any failure
 * (CLI missing, layout change, timeout) resolves to undefined and is never
 * surfaced to the user. Results are cached: a successful probe is reused for
 * hours (models ship rarely; the spawn costs seconds), a failed one is
 * retried after a short backoff.
 */
// Type-only: erased at compile time so merely importing this module (e.g. via
// the agent-adapter graph during capability discovery) does NOT load node-pty's
// native bindings. The runtime module is pulled in lazily inside the probe.
import type * as pty from 'node-pty';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWorktreeTrust } from './trust-manager';

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
}

const DEFAULT_TIMINGS: ProbeTimings = {
  pollIntervalMs: 100,
  typeDelayMs: 400,
  settleIntervalMs: 250,
  overallTimeoutMs: 15000,
};

let timings: ProbeTimings = DEFAULT_TIMINGS;

interface ProbeCache {
  cliPath: string;
  fetchedAtMs: number;
  models: string[] | undefined;
}

let cache: ProbeCache | null = null;
let inFlight: { cliPath: string; promise: Promise<string[] | undefined> } | null = null;

/** Test-only: clear cache and restore default timings between cases. */
export function resetModelPickerProbeForTests(): void {
  cache = null;
  inFlight = null;
  timings = DEFAULT_TIMINGS;
}

/** Test-only: shrink the waits so orchestration tests run in milliseconds. */
export function setModelPickerProbeTimingsForTests(overrides: Partial<ProbeTimings>): void {
  timings = { ...DEFAULT_TIMINGS, ...overrides };
}

/**
 * Minimal VT100 screen-grid renderer. Claude Code's TUI repaints with
 * absolute cursor positioning, cursor-forward gaps, and erase-character
 * sequences, so a regex strip of the raw stream drops characters mid-word.
 * Interpreting the stream into a fixed grid reproduces what the terminal
 * actually shows, which is the only reliable thing to parse.
 *
 * Handles the sequences Claude Code emits for the picker (CUP, CUU/CUD/
 * CUF/CUB, CHA, VPA, ED, EL, ECH, CR, LF, BS); everything else (SGR colors,
 * OSC titles, mode toggles) is consumed and ignored.
 */
export class VirtualScreen {
  private readonly cols: number;
  private readonly rows: number;
  private readonly grid: string[][];
  private cursorRow = 0;
  private cursorColumn = 0;

  constructor(cols: number = PROBE_COLS, rows: number = PROBE_ROWS) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => new Array<string>(cols).fill(' '));
  }

  write(data: string): void {
    let index = 0;
    while (index < data.length) {
      const char = data[index];
      if (char === '\x1b') {
        index += this.consumeEscape(data, index);
        continue;
      }
      if (char === '\r') {
        this.cursorColumn = 0;
      } else if (char === '\n') {
        this.lineFeed();
      } else if (char === '\b') {
        this.cursorColumn = Math.max(0, this.cursorColumn - 1);
      } else if (char >= ' ') {
        this.putChar(char);
      }
      index++;
    }
  }

  /** The visible screen, one line per row, trailing whitespace trimmed. */
  text(): string {
    return this.grid.map((row) => row.join('').replace(/\s+$/u, '')).join('\n');
  }

  private putChar(char: string): void {
    if (this.cursorColumn >= this.cols) {
      this.cursorColumn = 0;
      this.lineFeed();
    }
    this.grid[this.cursorRow][this.cursorColumn] = char;
    this.cursorColumn++;
  }

  private lineFeed(): void {
    if (this.cursorRow >= this.rows - 1) {
      this.grid.shift();
      this.grid.push(new Array<string>(this.cols).fill(' '));
    } else {
      this.cursorRow++;
    }
  }

  private clampRow(row: number): number {
    return Math.min(Math.max(row, 0), this.rows - 1);
  }

  private clampColumn(column: number): number {
    return Math.min(Math.max(column, 0), this.cols - 1);
  }

  private eraseInLine(mode: number): void {
    const row = this.grid[this.cursorRow];
    if (mode === 1) {
      for (let column = 0; column <= this.cursorColumn && column < this.cols; column++) row[column] = ' ';
    } else if (mode === 2) {
      row.fill(' ');
    } else {
      for (let column = this.cursorColumn; column < this.cols; column++) row[column] = ' ';
    }
  }

  private eraseInDisplay(mode: number): void {
    if (mode === 1) {
      for (let row = 0; row < this.cursorRow; row++) this.grid[row].fill(' ');
      this.eraseInLine(1);
    } else if (mode === 2 || mode === 3) {
      for (const row of this.grid) row.fill(' ');
    } else {
      this.eraseInLine(0);
      for (let row = this.cursorRow + 1; row < this.rows; row++) this.grid[row].fill(' ');
    }
  }

  /** Consume one escape sequence starting at `start`; returns chars consumed. */
  private consumeEscape(data: string, start: number): number {
    const next = data[start + 1];
    if (next === '[') {
      // CSI: ESC [ <params> <final byte in @-~>
      let end = start + 2;
      while (end < data.length && !(data[end] >= '@' && data[end] <= '~')) end++;
      if (end >= data.length) return data.length - start; // truncated chunk tail
      const params = data.slice(start + 2, end).replace(/^[?<>=!]/u, '');
      const final = data[end];
      this.applyCsi(params, final);
      return end - start + 1;
    }
    if (next === ']') {
      // OSC: ESC ] ... terminated by BEL or ST (ESC \)
      let end = start + 2;
      while (end < data.length) {
        if (data[end] === '\x07') return end - start + 1;
        if (data[end] === '\x1b' && data[end + 1] === '\\') return end - start + 2;
        end++;
      }
      return data.length - start;
    }
    if (next === '(' || next === ')' || next === '#') return 3; // charset / line attr
    return 2; // ESC + single byte (=, >, 7, 8, ...)
  }

  private applyCsi(params: string, final: string): void {
    const numbers = params.split(';').map((part) => parseInt(part, 10));
    const first = Number.isFinite(numbers[0]) ? numbers[0] : undefined;
    const count = first !== undefined && first > 0 ? first : 1;
    switch (final) {
      case 'H':
      case 'f': {
        const second = Number.isFinite(numbers[1]) ? numbers[1] : undefined;
        this.cursorRow = this.clampRow((first ?? 1) - 1);
        this.cursorColumn = this.clampColumn((second ?? 1) - 1);
        break;
      }
      case 'A': this.cursorRow = this.clampRow(this.cursorRow - count); break;
      case 'B': this.cursorRow = this.clampRow(this.cursorRow + count); break;
      case 'C': this.cursorColumn = this.clampColumn(this.cursorColumn + count); break;
      case 'D': this.cursorColumn = this.clampColumn(this.cursorColumn - count); break;
      case 'G': this.cursorColumn = this.clampColumn((first ?? 1) - 1); break;
      case 'd': this.cursorRow = this.clampRow((first ?? 1) - 1); break;
      case 'J': this.eraseInDisplay(first ?? 0); break;
      case 'K': this.eraseInLine(first ?? 0); break;
      case 'X': {
        const row = this.grid[this.cursorRow];
        for (let offset = 0; offset < count && this.cursorColumn + offset < this.cols; offset++) {
          row[this.cursorColumn + offset] = ' ';
        }
        break;
      }
      default: break; // SGR (m), mode toggles, cursor save/restore - ignored
    }
  }
}

/**
 * Parse the rendered `/model` picker into model ids.
 *
 * Picker shape (empirical, Claude Code 2.1.170):
 *
 *   Select model
 *   Switch between Claude models. ...
 *     1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday, complex tasks
 *     2. Fable                  Fable 5 · Most capable for your hardest and longest-running tasks
 *     3. Sonnet                 Sonnet 4.6 · Efficient for routine tasks
 *     4. Haiku                  Haiku 4.5 · Fastest for quick answers
 *   ❯ 5. Opus 4.8 ✔             Best for everyday, complex tasks (claude-opus-4-8)
 *
 * Only the currently-active row carries a parenthesized full id; every other
 * row names the model as `<Family> <version>` in its description. We take an
 * explicit `(claude-...)` id when present, otherwise derive the id from the
 * first `<Capitalized> <number>` pair: `Sonnet 4.6` -> `claude-sonnet-4-6`,
 * `Fable 5` -> `claude-fable-5`. That matches the Anthropic id scheme for
 * every current model; a row that fits neither pattern is skipped rather
 * than failing the probe.
 */
export function parseModelPickerScreen(screenText: string): string[] {
  const lines = screenText.split('\n');
  const headerIndex = lines.findIndex((line) => line.includes('Select model'));
  if (headerIndex === -1) return [];

  const modelIds: string[] = [];
  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex++) {
    const rowMatch = lines[lineIndex].match(/^\s*(?:❯\s*)?\d+\.\s+(.+)$/u);
    if (!rowMatch) continue;
    const rowText = rowMatch[1];

    const explicitId = rowText.match(/\((claude-[a-z0-9][a-z0-9.:-]*)\)/u);
    if (explicitId) {
      if (!modelIds.includes(explicitId[1])) modelIds.push(explicitId[1]);
      continue;
    }

    const derived = rowText.match(/\b([A-Z][A-Za-z]*) (\d+(?:\.\d+)?)\b/u);
    if (derived) {
      const derivedId = `claude-${derived[1].toLowerCase()}-${derived[2].replace(/\./gu, '-')}`;
      if (!modelIds.includes(derivedId)) modelIds.push(derivedId);
    }
  }
  return modelIds;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function spawnEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') environment[key] = value;
  }
  return environment;
}

/**
 * One full probe run: spawn, wait for the prompt, open `/model`, wait for
 * the picker to render and settle, parse, Esc, kill. Never throws.
 */
async function runModelPickerProbe(cliPath: string): Promise<string[] | undefined> {
  const scratchDirectory = path.join(os.tmpdir(), 'kangentic-model-probe');
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
  let probeProcess: pty.IPty;
  try {
    // Load node-pty here, not at module top level, so the native bindings
    // initialize only when a probe actually runs - importing this module
    // (e.g. through the agent-adapter graph) stays side-effect-free.
    const nodePty = await import('node-pty');
    const spawnOptions: pty.IPtyForkOptions = {
      name: 'xterm-256color',
      cols: PROBE_COLS,
      rows: PROBE_ROWS,
      cwd: scratchDirectory,
      env: spawnEnvironment(),
    };
    // --safe-mode: hooks, plugins, MCP servers, CLAUDE.md all skipped; auth
    // and model selection work normally (verified empirically on 2.1.170).
    probeProcess = process.platform === 'win32'
      ? nodePty.spawn('cmd.exe', ['/c', cliPath, '--safe-mode'], spawnOptions)
      : nodePty.spawn(cliPath, ['--safe-mode'], spawnOptions);
  } catch {
    return undefined;
  }

  let exited = false;
  probeProcess.onData((data) => screen.write(data));
  probeProcess.onExit(() => {
    exited = true;
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
    await delay(timings.typeDelayMs);
    probeProcess.write('/model');
    await delay(timings.typeDelayMs);
    probeProcess.write('\r');

    if (!(await waitForScreen('Select model'))) return undefined;

    // Let the picker finish painting: two identical consecutive frames. Parse
    // only the frame we confirmed stable - if the deadline expires while the
    // picker is still mid-paint, treat it as a failure rather than caching a
    // half-rendered (truncated) model list as a 12-hour success.
    let previousFrame = '';
    let stableFrame: string | undefined;
    while (Date.now() < deadline) {
      const currentFrame = screen.text();
      if (currentFrame === previousFrame) {
        stableFrame = currentFrame;
        break;
      }
      previousFrame = currentFrame;
      await delay(timings.settleIntervalMs);
    }
    if (stableFrame === undefined) return undefined;

    const models = parseModelPickerScreen(stableFrame);
    return models.length > 0 ? models : undefined;
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
    try {
      probeProcess.kill();
    } catch {
      // EACCES/ESRCH when the process already exited - nothing to clean up.
    }
  }
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
 * That matches how transcript-discovered models already accrue over time,
 * and the result is persisted by the renderer once seen, so it is immediate
 * on every subsequent launch.
 */
export function getCachedModelPickerModels(cliPath: string): string[] | undefined {
  // Fire-and-forget: probeModelPickerModels self-guards (no-op when the cache
  // is fresh or a probe is already in flight) and never rejects.
  void probeModelPickerModels(cliPath).catch(() => undefined);
  return cache && cache.cliPath === cliPath ? cache.models : undefined;
}

/**
 * Awaitable cached probe. Concurrent callers share one in-flight probe;
 * results are reused for SUCCESS_TTL_MS (failures for FAILURE_TTL_MS) per CLI
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
): Promise<string[] | undefined> {
  if (!forceRefresh && cache && cache.cliPath === cliPath) {
    const ttl = cache.models ? SUCCESS_TTL_MS : FAILURE_TTL_MS;
    if (Date.now() - cache.fetchedAtMs < ttl) return cache.models;
  }
  if (inFlight && inFlight.cliPath === cliPath) return inFlight.promise;

  const promise = runModelPickerProbe(cliPath).then(
    (models) => {
      cache = { cliPath, fetchedAtMs: Date.now(), models };
      inFlight = null;
      return models;
    },
    () => {
      // runModelPickerProbe is written never to reject, but guard the state
      // machine anyway: an unexpected throw must not strand `inFlight` and
      // wedge every future probe on a permanently-pending promise.
      cache = { cliPath, fetchedAtMs: Date.now(), models: undefined };
      inFlight = null;
      return undefined;
    },
  );
  inFlight = { cliPath, promise };
  return promise;
}
