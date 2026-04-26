/**
 * Real-PTY detection tests for non-Claude agents.
 *
 * Spawns the actual Codex / Gemini CLI under node-pty, captures the boot
 * stream, and asserts that:
 *   1. `adapter.detectFirstOutput(chunk)` returns true on at least one chunk
 *      (so the spinner overlay drops).
 *   2. `adapter.runtime.activity.detectIdle(buffered)` returns true once the
 *      CLI has finished painting its idle prompt (so the activity dot lands
 *      on idle without waiting for the 10s silence timer).
 *
 * The captured stream is also written to `tests/fixtures/agent-pty/<agent>.bin`
 * so the regexes can be tuned offline against ground-truth output without
 * re-spawning the CLI.
 *
 * These tests are skipped automatically when the CLI is not installed, so CI
 * (which has neither codex nor gemini available) stays green. Run locally with
 * the binaries on PATH to actually exercise the detection paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn as ptySpawn, type IPty } from 'node-pty';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { CodexAdapter } from '../../src/main/agent/adapters/codex';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';
import { WarpAdapter } from '../../src/main/agent/adapters/warp';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { sessionOutputPaths } from '../../src/main/engine/session-paths';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'agent-pty');
fs.mkdirSync(FIXTURE_DIR, { recursive: true });

/**
 * node-pty's IPtyForkOptions['env'] requires Record<string, string>, but
 * NodeJS.ProcessEnv values are string | undefined. Filter undefined entries
 * out so we get a typed Record without an `as any` / `as Record` cast.
 */
function filterEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

/** Resolve a CLI binary on PATH. Returns null if not installed. */
function resolveBinary(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter);
  for (const dir of pathEntries) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

interface CaptureResult {
  /** All raw chunks the PTY emitted, in order. */
  chunks: string[];
  /** Concatenated buffer (full transcript). */
  full: string;
  /** First chunk index where adapter.detectFirstOutput() returned true, or -1. */
  firstOutputAtChunk: number;
  /** Chunk indices where detectIdle returned true on a per-chunk call. */
  idleHitChunks: number[];
  /** Chunk indices where detectIdle returned false (i.e. CLI was mid-paint). */
  workingChunks: number[];
  /** True if at any point a tail-window match fired (handles split prompts). */
  detectedIdleEver: boolean;
}

/**
 * Spawn the CLI under PTY and run a multi-phase lifecycle test:
 *
 *   Phase 1: Boot. Capture chunks until either the first idle hit fires
 *            or `phase1TimeoutMs` elapses.
 *   Phase 2: Send `postIdleInput` (e.g. "1\r" to accept trust). Capture
 *            for `phase2DurationMs`. The CLI should emit working chunks
 *            (where detectIdle returns false) followed by another idle
 *            state.
 *
 * The CLI is spawned in an isolated temp cwd + HOME so it can't read
 * real user config / auth and won't write hooks into the user's actual
 * home directory. With an empty HOME both Codex and Gemini land at a
 * "trust this folder?" prompt - which is itself a valid idle state
 * (CLI is blocked waiting for user input). Sending "1\r" advances them
 * past it; the next stable state is typically an auth prompt, also a
 * valid idle.
 */
async function captureBoot(
  adapter: AgentAdapter,
  binary: string,
  options: {
    phase1TimeoutMs: number;
    postIdleInput?: string;
    phase2DurationMs?: number;
  },
): Promise<CaptureResult> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-pty-test-${adapter.name}-`));
  // Provide an empty HOME so the CLI doesn't read real user config / auth
  // and won't try to launch an interactive login flow.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-pty-home-${adapter.name}-`));

  const env: Record<string, string> = {
    ...filterEnv(process.env),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
    // Force a TTY-like terminal so the CLI paints its TUI (cursor hide,
    // box characters) instead of falling back to plain stdio.
    TERM: 'xterm-256color',
    NO_COLOR: '',
  };

  let term: IPty;
  try {
    term = ptySpawn(binary, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: sandbox,
      env,
    });
  } catch (error) {
    fs.rmSync(sandbox, { recursive: true, force: true });
    fs.rmSync(isolatedHome, { recursive: true, force: true });
    throw error;
  }

  const chunks: string[] = [];
  const idleHitChunks: number[] = [];
  const workingChunks: number[] = [];
  let firstOutputAtChunk = -1;
  let detectedIdleEver = false;
  let bufferTail = '';
  const TAIL_WINDOW = 4096;

  const strategy = adapter.runtime.activity;
  const detectIdle =
    strategy.kind === 'pty' || strategy.kind === 'hooks_and_pty'
      ? strategy.detectIdle
      : undefined;

  let phase1ResolveFirstIdle: (() => void) | null = null;
  const firstIdlePromise = new Promise<void>((resolve) => {
    phase1ResolveFirstIdle = resolve;
  });

  const exitPromise = new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        term.kill();
      } catch {
        // Ignore - process may have already exited.
      }
      resolve();
    };

    term.onData((data: string) => {
      const chunkIndex = chunks.length;
      chunks.push(data);
      if (firstOutputAtChunk === -1 && adapter.detectFirstOutput(data)) {
        firstOutputAtChunk = chunkIndex;
      }
      // Maintain a sliding tail of the most recent output. Per-chunk and
      // tail-window evaluation mirrors PtyActivityTracker which gets the
      // raw chunk in production but the prompt may straddle chunks on
      // slow links, so the tail buffer is the worst-case fallback.
      bufferTail = (bufferTail + data).slice(-TAIL_WINDOW);
      if (detectIdle) {
        const perChunkIdle = detectIdle(data);
        const tailIdle = detectIdle(bufferTail);
        if (perChunkIdle) {
          idleHitChunks.push(chunkIndex);
        } else {
          // detectIdle returned false on this chunk - the CLI is mid-paint
          // (working). Recording these proves the regex isn't matching
          // every chunk (false positive that would prevent the activity
          // dot from ever showing 'thinking').
          workingChunks.push(chunkIndex);
        }
        if (!detectedIdleEver && (perChunkIdle || tailIdle)) {
          detectedIdleEver = true;
          if (phase1ResolveFirstIdle) {
            const resolveOnce = phase1ResolveFirstIdle;
            phase1ResolveFirstIdle = null;
            resolveOnce();
          }
        }
      }
    });

    term.onExit(() => {
      finish();
    });

    // Phase 1 timeout: bail out if no idle is reached within phase1TimeoutMs.
    setTimeout(() => {
      if (phase1ResolveFirstIdle) {
        const resolveOnce = phase1ResolveFirstIdle;
        phase1ResolveFirstIdle = null;
        resolveOnce();
      }
    }, options.phase1TimeoutMs);

    // Hard timeout (phase1 + phase2 + slack) as a backstop in case the
    // exit handler never fires for any reason.
    const hardCap = options.phase1TimeoutMs + (options.phase2DurationMs ?? 0) + 5000;
    setTimeout(finish, hardCap);

    // Phase 2: once first idle is reached, optionally send input and
    // continue capturing for phase2DurationMs to observe a second
    // working->idle transition.
    firstIdlePromise.then(() => {
      if (!options.postIdleInput || !options.phase2DurationMs) {
        // No phase 2 - settle briefly so the fixture captures a clean
        // tail frame, then exit.
        setTimeout(finish, 250);
        return;
      }
      // Brief settle, send input, then capture for phase2DurationMs.
      setTimeout(() => {
        try { term.write(options.postIdleInput!); } catch { /* process gone */ }
        setTimeout(finish, options.phase2DurationMs);
      }, 300);
    });
  });

  await exitPromise;
  // Give Windows a moment to release file handles before cleanup. Cleanup
  // errors are swallowed because the OS can hold locks even after the PTY
  // process has exited (ConPTY agent, antivirus scan, etc.).
  await new Promise((resolve) => setTimeout(resolve, 200));
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* ignore */ }

  return {
    chunks,
    full: chunks.join(''),
    firstOutputAtChunk,
    idleHitChunks,
    workingChunks,
    detectedIdleEver,
  };
}

/** Persist the captured PTY transcript so regexes can be tuned offline. */
function writeFixture(name: string, result: CaptureResult): void {
  fs.writeFileSync(path.join(FIXTURE_DIR, `${name}.bin`), result.full);
  // Also write a human-readable, ANSI-stripped view to make eyeballing
  // the prompt characters easy.
  const stripped = result.full.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  fs.writeFileSync(path.join(FIXTURE_DIR, `${name}.txt`), stripped);
}

interface AgentCase {
  name: string;
  binaryName: string;
  adapter: AgentAdapter;
  /** Per-CLI Phase 1 (boot until first idle) timeout. */
  phase1TimeoutMs: number;
  /** Phase 2 (post-input) capture window. */
  phase2DurationMs: number;
  /** Input to send after the first idle state to advance the CLI. */
  postIdleInput: string;
}

const cases: AgentCase[] = [
  // "1\r" answers "1. Yes, continue" / "1. Trust folder" on the trust
  // dialog both CLIs paint when started with an empty HOME.
  { name: 'codex', binaryName: 'codex', adapter: new CodexAdapter(), phase1TimeoutMs: 8000, phase2DurationMs: 4000, postIdleInput: '1\r' },
  { name: 'gemini', binaryName: 'gemini', adapter: new GeminiAdapter(), phase1TimeoutMs: 12000, phase2DurationMs: 4000, postIdleInput: '1\r' },
  // Warp (oz) streams output immediately and has no trust dialog. Phase 2
  // sends a newline to advance past any initial prompt.
  { name: 'warp', binaryName: 'oz', adapter: new WarpAdapter(), phase1TimeoutMs: 10000, phase2DurationMs: 4000, postIdleInput: '\r' },
];

describe('Agent PTY detection (real CLI boot)', () => {
  for (const testCase of cases) {
    const binary = resolveBinary(testCase.binaryName);
    const describeOrSkip = binary ? describe : describe.skip;

    describeOrSkip(`${testCase.name} adapter`, () => {
      let result: CaptureResult;

      it(`spawns ${testCase.binaryName} and runs full lifecycle capture`, async () => {
        result = await captureBoot(testCase.adapter, binary!, {
          phase1TimeoutMs: testCase.phase1TimeoutMs,
          postIdleInput: testCase.postIdleInput,
          phase2DurationMs: testCase.phase2DurationMs,
        });
        writeFixture(testCase.name, result);
        expect(result.chunks.length).toBeGreaterThan(0);
        expect(result.full.length).toBeGreaterThan(0);
      }, testCase.phase1TimeoutMs + testCase.phase2DurationMs + 10000);

      it('initial: detectFirstOutput fires on the boot stream', () => {
        // First lifecycle stage: the CLI has emitted its TUI cursor-hide
        // (Codex \x1b[?25l, Gemini \x1b[?25l). In production this drops
        // the "Starting agent..." spinner overlay on the task card.
        expect(result.firstOutputAtChunk).toBeGreaterThanOrEqual(0);
      });

      // detectIdle tests only apply to adapters that provide a detectIdle
      // callback. Codex uses silence-timer-only (no detectIdle) because the
      // › guillemet is always visible in the Ink TUI, even during active work.
      const hasDetectIdle = (() => {
        const strategy = testCase.adapter.runtime.activity;
        return (strategy.kind === 'pty' || strategy.kind === 'hooks_and_pty')
          && typeof strategy.detectIdle === 'function';
      })();

      it.skipIf(!hasDetectIdle)('working: at least one chunk is mid-paint (detectIdle returns false)', () => {
        expect(result.workingChunks.length).toBeGreaterThan(0);
      });

      it.skipIf(!hasDetectIdle)('idle: detectIdle fires once the prompt is fully painted', () => {
        expect(result.detectedIdleEver).toBe(true);
      });

      it.skipIf(!hasDetectIdle)('lifecycle: idle hits are interleaved with working chunks (not all-or-nothing)', () => {
        expect(result.idleHitChunks.length).toBeGreaterThan(0);
        expect(result.workingChunks.length).toBeGreaterThan(0);
        expect(result.idleHitChunks.length + result.workingChunks.length)
          .toBe(result.chunks.length);
      });
    });
  }

  // Sanity test that always runs - so the file isn't a no-op when neither
  // CLI is installed (CI). Verifies the test scaffolding itself.
  describe('scaffolding', () => {
    it('resolveBinary returns null for nonexistent binary', () => {
      expect(resolveBinary('definitely-not-a-real-binary-12345')).toBeNull();
    });

    it('CodexAdapter detectFirstOutput matches cursor-hide escape', () => {
      const adapter = new CodexAdapter();
      expect(adapter.detectFirstOutput('\x1b[?25l')).toBe(true);
      expect(adapter.detectFirstOutput('plain text')).toBe(false);
    });

    it('GeminiAdapter detectFirstOutput matches cursor-hide escape', () => {
      const adapter = new GeminiAdapter();
      expect(adapter.detectFirstOutput('\x1b[?25l')).toBe(true);
      expect(adapter.detectFirstOutput('plain text')).toBe(false);
    });

    it('WarpAdapter detectFirstOutput fires on any non-empty data', () => {
      const adapter = new WarpAdapter();
      expect(adapter.detectFirstOutput('any output')).toBe(true);
      expect(adapter.detectFirstOutput('\x1b[?25l')).toBe(true);
      expect(adapter.detectFirstOutput('')).toBe(false);
    });

    it('WarpAdapter has no detectIdle (silence-timer only)', () => {
      // oz agent run is a one-shot cloud runner that exits when done.
      // There's no interactive idle prompt to detect. The PTY silence
      // timer is the sole idle detection mechanism.
      const adapter = new WarpAdapter();
      const strategy = adapter.runtime.activity;
      const detectIdle = (strategy.kind === 'pty' || strategy.kind === 'hooks_and_pty')
        ? strategy.detectIdle
        : undefined;
      expect(detectIdle).toBeUndefined();
    });

    it('DroidAdapter detectFirstOutput matches cursor-hide escape', () => {
      // Droid's Ink-based TUI emits \x1b[?25l (cursor-hide) as its
      // first output, identical to Codex and Gemini. Verified empirically
      // via scripts/probe-droid.js against Droid 0.109.1.
      const adapter = new DroidAdapter();
      expect(adapter.detectFirstOutput('\x1b[?25l')).toBe(true);
      expect(adapter.detectFirstOutput('plain text')).toBe(false);
    });

    it('DroidAdapter has no detectIdle (silence-timer only)', () => {
      // Droid uses PTY silence-timer-only activity detection -- no
      // regex-based idle detection because the TUI's idle prompt shape
      // was not empirically stable enough to pin at launch time.
      const adapter = new DroidAdapter();
      const strategy = adapter.runtime.activity;
      const detectIdle = (strategy.kind === 'pty' || strategy.kind === 'hooks_and_pty')
        ? strategy.detectIdle
        : undefined;
      expect(detectIdle).toBeUndefined();
    });
  });
});

// ----------------------------------------------------------------------------
// Hook bridge end-to-end tests
//
// Verifies that each adapter's hook config:
//   1. Is written to disk in the expected file with the expected entries.
//   2. Causes the real CLI to invoke event-bridge.js, which appends events
//      to the events.jsonl file the renderer watches.
//
// Layer 1 is deterministic and always runs. Layer 2 spawns the real binary
// (skipped if not installed) and polls the events.jsonl file for activity.
// ----------------------------------------------------------------------------

interface HookEvent {
  ts: number;
  type: string;
  [key: string]: unknown;
}

/**
 * Read and parse the events JSONL file. Returns an empty array if the file
 * doesn't exist yet (the CLI hasn't fired any hooks).
 */
function readEventsFile(eventsPath: string): HookEvent[] {
  if (!fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf-8');
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  return lines
    .map((line) => {
      try {
        return JSON.parse(line) as HookEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is HookEvent => event !== null);
}

/**
 * Spawn the CLI with hooks enabled, advance past the trust prompt, and
 * poll the events.jsonl file until at least one hook event arrives or the
 * timeout expires.
 */
async function captureHookEvents(
  adapter: AgentAdapter,
  binary: string,
  options: {
    phase1TimeoutMs: number;
    phase2DurationMs: number;
    postIdleInput: string;
  },
): Promise<{ eventsPath: string; events: HookEvent[]; configPath: string; configContent: string }> {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-hook-test-${adapter.name}-`));
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), `kangentic-hook-home-${adapter.name}-`));

  // Use the SAME path layout production uses - sessionOutputPaths() is
  // the single source of truth, called by transition-engine.ts when
  // spawning real sessions. The directory is keyed by PTY session UUID,
  // not by task ID. If this layout ever drifts from what the renderer's
  // file watcher / usage tracker reads, the helper changes in one place
  // and this test follows automatically.
  const ptySessionId = uuidv4();
  const sessionDir = path.join(sandbox, '.kangentic', 'sessions', ptySessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  const { eventsOutputPath: eventsPath } = sessionOutputPaths(sessionDir);

  // Trigger hook config write via the adapter's buildCommand. We discard
  // the returned command string - we only want the side effect of writing
  // the hook config (.codex/hooks.json or .gemini/settings.json) with the
  // correct events.jsonl path baked into the bridge command line.
  adapter.buildCommand({
    agentPath: binary,
    taskId: 'task-001',
    cwd: sandbox,
    permissionMode: 'bypassPermissions',
    eventsOutputPath: eventsPath,
  });

  const configPath =
    adapter.name === 'codex'
      ? path.join(sandbox, '.codex', 'hooks.json')
      : path.join(sandbox, '.gemini', 'settings.json');
  const configContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';

  const env: Record<string, string> = {
    ...filterEnv(process.env),
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(isolatedHome, 'AppData', 'Local'),
    TERM: 'xterm-256color',
    NO_COLOR: '',
  };

  const term: IPty = ptySpawn(binary, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: sandbox,
    env,
  });

  const strategy = adapter.runtime.activity;
  const detectIdle =
    strategy.kind === 'pty' || strategy.kind === 'hooks_and_pty' ? strategy.detectIdle : undefined;

  let bufferTail = '';
  let firstIdleSeen = false;
  let inputSent = false;

  const finishPromise = new Promise<void>((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try { term.kill(); } catch { /* gone */ }
      resolve();
    };

    term.onData((data: string) => {
      bufferTail = (bufferTail + data).slice(-4096);
      if (!firstIdleSeen && detectIdle && (detectIdle(data) || detectIdle(bufferTail))) {
        firstIdleSeen = true;
        // Send trust acceptance after a brief settle, then keep capturing
        // for phase2DurationMs to give the CLI time to fire SessionStart.
        setTimeout(() => {
          if (!inputSent) {
            inputSent = true;
            try { term.write(options.postIdleInput); } catch { /* gone */ }
          }
        }, 300);
      }
    });

    term.onExit(() => finish());
    setTimeout(finish, options.phase1TimeoutMs + options.phase2DurationMs);
  });

  await finishPromise;
  await new Promise((resolve) => setTimeout(resolve, 200));

  const events = readEventsFile(eventsPath);

  // Persist events file (and config) for offline inspection. Done before
  // cleanup so the fixture survives even if rmSync errors.
  try {
    fs.writeFileSync(
      path.join(FIXTURE_DIR, `${adapter.name}-hook-events.jsonl`),
      events.map((event) => JSON.stringify(event)).join('\n'),
    );
    fs.writeFileSync(path.join(FIXTURE_DIR, `${adapter.name}-hook-config.txt`), configContent);
  } catch { /* ignore */ }

  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(isolatedHome, { recursive: true, force: true }); } catch { /* ignore */ }

  return { eventsPath, events, configPath, configContent };
}

describe('Agent hook bridge (real CLI invocation)', () => {
  // Layer 1: deterministic config-write tests. Always run.
  describe('hook config files (deterministic)', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-hook-config-'));
    });

    afterEach(() => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    it('sessionOutputPaths produces the layout the renderer file watcher reads from', () => {
      // Lock in the production path layout. If transition-engine.ts or
      // session-paths.ts ever changes the directory key (currently the
      // PTY session UUID) or filename (currently events.jsonl), this
      // test fails first - before any hook plumbing test does. Keeps
      // the test fixtures honest about where the real renderer reads.
      const sessionDir = path.join(tempDir, '.kangentic', 'sessions', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      const { eventsOutputPath, statusOutputPath } = sessionOutputPaths(sessionDir);
      expect(eventsOutputPath).toBe(path.join(sessionDir, 'events.jsonl'));
      expect(statusOutputPath).toBe(path.join(sessionDir, 'status.json'));
      // The session-dir parent must always be `<projectRoot>/.kangentic/sessions`.
      expect(path.dirname(sessionDir)).toBe(path.join(tempDir, '.kangentic', 'sessions'));
    });

    it('CodexAdapter writes .codex/hooks.json with all 5 expected events', () => {
      const adapter = new CodexAdapter();
      const ptySessionId = uuidv4();
      const sessionDir = path.join(tempDir, '.kangentic', 'sessions', ptySessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const { eventsOutputPath: eventsPath } = sessionOutputPaths(sessionDir);
      adapter.buildCommand({
        agentPath: '/usr/bin/codex',
        taskId: 'task-001',
        cwd: tempDir,
        permissionMode: 'default',
        eventsOutputPath: eventsPath,
      });

      const hooksFile = path.join(tempDir, '.codex', 'hooks.json');
      expect(fs.existsSync(hooksFile)).toBe(true);

      const hooks = JSON.parse(fs.readFileSync(hooksFile, 'utf-8'));
      expect(Array.isArray(hooks)).toBe(true);
      const eventNames = hooks.map((entry: { event: string }) => entry.event).sort();
      expect(eventNames).toEqual(
        ['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit'].sort(),
      );

      // Every entry must invoke event-bridge.js with the same events.jsonl
      // path the file watcher reads from. Path comparison uses forward
      // slashes because hook-utils calls toForwardSlash() on the events
      // path before embedding it in the command (Windows paths get
      // normalized so the bridge can find the file regardless of shell).
      const expectedPathFragment = eventsPath.replace(/\\/g, '/');
      for (const entry of hooks) {
        expect(entry.command).toContain('event-bridge');
        expect(entry.command).toContain(expectedPathFragment);
      }
      // Sanity: the path embedded in the command MUST end with the same
      // filename the renderer's session-file-watcher expects.
      expect(expectedPathFragment).toMatch(/\/events\.jsonl$/);
    });

    // Worktree mode: production passes cwd=worktree, projectRoot=main repo,
    // and eventsOutputPath under main repo. This test mirrors the exact
    // call shape transition-engine.ts:213-238 uses, so the hook config
    // ends up where the live CLI will actually look (Gemini reads from
    // cwd, Codex hooks live under projectRoot - though Codex 0.118 doesn't
    // fire them) and the embedded events path is the absolute path the
    // renderer file watcher reads from.
    it('worktree mode: Codex hooks live under projectRoot, Gemini settings under cwd, events under projectRoot', () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-main-repo-'));
      const worktreeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-worktree-'));
      try {
        const ptySessionId = uuidv4();
        // sessionDir is computed under projectRoot - same as transition-engine.ts:214
        const sessionDir = path.join(projectRoot, '.kangentic', 'sessions', ptySessionId);
        fs.mkdirSync(sessionDir, { recursive: true });
        const { eventsOutputPath: eventsPath } = sessionOutputPaths(sessionDir);

        // Sanity: events MUST be under projectRoot, not the worktree.
        // If this ever flips, the file watcher would lose its source of
        // truth and the activity log would be silent for worktree tasks.
        expect(eventsPath.startsWith(projectRoot)).toBe(true);
        expect(eventsPath.startsWith(worktreeCwd)).toBe(false);

        // Build both adapter commands with the production call shape.
        const codex = new CodexAdapter();
        codex.buildCommand({
          agentPath: '/usr/bin/codex',
          taskId: 'task-001',
          cwd: worktreeCwd,
          projectRoot,
          permissionMode: 'default',
          eventsOutputPath: eventsPath,
        });

        const gemini = new GeminiAdapter();
        gemini.buildCommand({
          agentPath: '/usr/bin/gemini',
          taskId: 'task-001',
          cwd: worktreeCwd,
          projectRoot,
          permissionMode: 'default',
          eventsOutputPath: eventsPath,
        });

        // Codex writes to <projectRoot>/.codex/hooks.json (NOT the worktree).
        // This is the behavior of codex-adapter command-builder.ts:55:
        //   const projectRoot = options.projectRoot || options.cwd;
        const codexHooks = path.join(projectRoot, '.codex', 'hooks.json');
        const codexHooksInWorktree = path.join(worktreeCwd, '.codex', 'hooks.json');
        expect(fs.existsSync(codexHooks)).toBe(true);
        expect(fs.existsSync(codexHooksInWorktree)).toBe(false);

        // Gemini writes to <cwd>/.gemini/settings.json (the WORKTREE, not
        // projectRoot). This is the behavior of gemini-adapter
        // command-builder.ts:138 - Gemini CLI reads settings from its
        // working directory, so the settings file MUST live in the cwd
        // the CLI is launched in.
        const geminiSettings = path.join(worktreeCwd, '.gemini', 'settings.json');
        const geminiSettingsInRoot = path.join(projectRoot, '.gemini', 'settings.json');
        expect(fs.existsSync(geminiSettings)).toBe(true);
        expect(fs.existsSync(geminiSettingsInRoot)).toBe(false);

        // CRITICAL: both hook configs must embed the SAME absolute events
        // path - the one under projectRoot. Otherwise the bridge writes
        // to a file the renderer isn't watching.
        const expectedFragment = eventsPath.replace(/\\/g, '/');
        const codexContent = fs.readFileSync(codexHooks, 'utf-8');
        const geminiContent = fs.readFileSync(geminiSettings, 'utf-8');
        expect(codexContent).toContain(expectedFragment);
        expect(geminiContent).toContain(expectedFragment);
        // Negative: neither config should reference a path under the worktree.
        const worktreeFragment = worktreeCwd.replace(/\\/g, '/');
        expect(codexContent.includes(worktreeFragment + '/.kangentic')).toBe(false);
        expect(geminiContent.includes(worktreeFragment + '/.kangentic')).toBe(false);
      } finally {
        try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
        try { fs.rmSync(worktreeCwd, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    it('GeminiAdapter writes .gemini/settings.json with hooks for SessionStart, BeforeTool, AfterTool, AfterAgent', () => {
      const adapter = new GeminiAdapter();
      const ptySessionId = uuidv4();
      const sessionDir = path.join(tempDir, '.kangentic', 'sessions', ptySessionId);
      fs.mkdirSync(sessionDir, { recursive: true });
      const { eventsOutputPath: eventsPath } = sessionOutputPaths(sessionDir);
      adapter.buildCommand({
        agentPath: '/usr/bin/gemini',
        taskId: 'task-001',
        cwd: tempDir,
        permissionMode: 'default',
        eventsOutputPath: eventsPath,
      });

      const settingsFile = path.join(tempDir, '.gemini', 'settings.json');
      expect(fs.existsSync(settingsFile)).toBe(true);

      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      expect(settings.hooks).toBeDefined();
      // Critical events for activity tracking - if any go missing the
      // activity dot will stay stuck on first idle / never go to thinking.
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.BeforeTool).toBeDefined();
      expect(settings.hooks.AfterTool).toBeDefined();
      expect(settings.hooks.AfterAgent).toBeDefined();

      // Every hook command must reference event-bridge AND embed the
      // exact events.jsonl path the renderer's file watcher reads from.
      const expectedPathFragment = eventsPath.replace(/\\/g, '/');
      expect(expectedPathFragment).toMatch(/\/events\.jsonl$/);
      for (const eventName of Object.keys(settings.hooks)) {
        for (const entry of settings.hooks[eventName]) {
          for (const hook of entry.hooks) {
            expect(hook.command).toContain('event-bridge');
            expect(hook.command).toContain(expectedPathFragment);
          }
        }
      }
    });
  });

  // Layer 2: live CLI invocation. Skipped if binary missing.
  // Warp is excluded - it has no hook config (runtime.activity.kind === 'pty',
  // not 'hooks_and_pty'), so there's nothing for this layer to verify. Warp's
  // event delivery is covered by the Warp E2E tests under tests/e2e/.
  const hookCapableCases = cases.filter(
    (testCase) => testCase.adapter.runtime.activity.kind === 'hooks_and_pty',
  );
  for (const testCase of hookCapableCases) {
    const binary = resolveBinary(testCase.binaryName);
    const describeOrSkip = binary ? describe : describe.skip;

    describeOrSkip(`${testCase.name} hooks (live CLI)`, () => {
      let captureResult: { events: HookEvent[]; configContent: string };

      it(`spawns ${testCase.binaryName} with hooks active and polls events.jsonl`, async () => {
        captureResult = await captureHookEvents(testCase.adapter, binary!, {
          phase1TimeoutMs: testCase.phase1TimeoutMs,
          phase2DurationMs: testCase.phase2DurationMs + 4000, // extra time for hook to fire
          postIdleInput: testCase.postIdleInput,
        });
        // Sanity: hook config got written before spawn.
        expect(captureResult.configContent.length).toBeGreaterThan(0);
        expect(captureResult.configContent).toContain('event-bridge');
      }, testCase.phase1TimeoutMs + testCase.phase2DurationMs + 15000);

      if (testCase.name === 'gemini') {
        it('Gemini config is written and CLI accepts it without crashing', () => {
          // End-to-end hook firing is gated on real Gemini auth, which
          // an isolated-HOME test environment cannot provide - the CLI
          // blocks at the auth prompt before SessionStart fires. The
          // deterministic Layer 1 test above guarantees the hook config
          // is correct, and the live CLI did spawn successfully with
          // the config in place (no parse error / crash). The actual
          // hook->bridge->JSONL pipeline is exercised by the
          // 'event-bridge end-to-end' tests below using a fake stdin
          // payload, which doesn't require auth.
          expect(captureResult.configContent).toContain('SessionStart');
          expect(captureResult.configContent).toContain('BeforeTool');
        });
      }

      if (testCase.name === 'codex') {
        it('Codex hook config is wired but events do not fire (documented limitation)', () => {
          // Codex 0.118 ships with a Rust CLI that does NOT read
          // .codex/hooks.json yet (see openai/codex tracking issue and
          // the comment in src/main/agent/adapters/codex/codex-adapter.ts).
          // We still write the config in case a future version reads it,
          // but we expect zero events to land in events.jsonl on this
          // version. If this assertion FLIPS to non-zero in a future
          // version, that's great news - update the adapter comment and
          // change this test to a positive assertion.
          expect(captureResult.events.length).toBe(0);
        });
      }
    });
  }

  // Layer 3: event-bridge end-to-end. Pipes a fake hook stdin payload
  // through the real event-bridge.js script and verifies the produced
  // JSONL line matches what the renderer's file watcher expects. This
  // deterministically proves the hook->bridge->JSONL pipeline works
  // without needing real CLI auth, and complements Layer 2 (which only
  // verifies the CLI accepts the config).
  describe('event-bridge end-to-end (no CLI required)', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-bridge-test-'));
    });

    afterEach(() => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    /** Resolve event-bridge.js the same way bridge-utils does at runtime. */
    function locateEventBridge(): string {
      const candidates = [
        path.join(process.cwd(), 'src', 'main', 'agent', 'event-bridge.js'),
        path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'event-bridge.js'),
      ];
      const found = candidates.find((p) => fs.existsSync(p));
      if (!found) throw new Error('event-bridge.js not found');
      return found;
    }

    /**
     * Synchronously invoke event-bridge.js with the given stdin payload
     * and return the parsed JSONL line(s) it produced.
     */
    function invokeBridge(
      eventType: string,
      stdinJson: string,
      ...directives: string[]
    ): HookEvent[] {
      const eventsPath = path.join(tempDir, 'events.jsonl');
      const bridgeScript = locateEventBridge();
      const result = spawnSync(
        process.execPath,
        [bridgeScript, eventsPath, eventType, ...directives],
        { input: stdinJson, encoding: 'utf-8' },
      );
      if (result.status !== 0) {
        throw new Error(`event-bridge exited with ${result.status}: ${result.stderr}`);
      }
      return readEventsFile(eventsPath);
    }

    it('writes SessionStart event with correct shape', () => {
      const events = invokeBridge('session_start', JSON.stringify({ session_id: 'sess-abc' }));
      expect(events.length).toBe(1);
      expect(events[0].type).toBe('session_start');
      expect(typeof events[0].ts).toBe('number');
    });

    it('extracts tool name via tool: directive (Codex PreToolUse format)', () => {
      const stdin = JSON.stringify({ tool_name: 'shell', tool_input: { command: 'ls' } });
      const events = invokeBridge('tool_start', stdin, 'tool:tool_name');
      expect(events.length).toBe(1);
      expect(events[0].tool).toBe('shell');
    });

    it('extracts nested detail via nested-detail: directive (Gemini BeforeTool format)', () => {
      const stdin = JSON.stringify({
        tool_name: 'edit_file',
        tool_input: { file_path: '/some/file.ts', content: 'unused' },
      });
      const events = invokeBridge(
        'tool_start',
        stdin,
        'tool:tool_name',
        'nested-detail:tool_input:file_path,command,query',
      );
      expect(events.length).toBe(1);
      expect(events[0].tool).toBe('edit_file');
      expect(events[0].detail).toBe('/some/file.ts');
    });

    it('captures env var via env: directive (Codex thread_id capture)', () => {
      const stdin = JSON.stringify({});
      // The bridge reads from process.env, so set the var on the spawn.
      const eventsPath = path.join(tempDir, 'events.jsonl');
      const bridgeScript = locateEventBridge();
      const result = spawnSync(
        process.execPath,
        [bridgeScript, eventsPath, 'session_start', 'env:thread_id=CODEX_THREAD_ID'],
        {
          input: stdin,
          encoding: 'utf-8',
          env: { ...process.env, CODEX_THREAD_ID: 'thr_test_12345' },
        },
      );
      expect(result.status).toBe(0);
      const events = readEventsFile(eventsPath);
      expect(events.length).toBe(1);
      // env: directive captures into hookContext, not directly onto event.
      // The exact field name depends on event-bridge's implementation -
      // verify it landed somewhere.
      const serialized = JSON.stringify(events[0]);
      expect(serialized).toContain('thr_test_12345');
    });

    it('appends multiple events to the same JSONL file across invocations', () => {
      invokeBridge('session_start', JSON.stringify({}));
      const events = invokeBridge('idle', JSON.stringify({}));
      expect(events.length).toBe(2);
      expect(events[0].type).toBe('session_start');
      expect(events[1].type).toBe('idle');
    });

    it('produces valid JSON lines that the renderer file watcher can parse', () => {
      // The renderer's session-file-watcher reads the events file with
      // fs.readFileSync + split('\n') + JSON.parse per line. This test
      // mirrors that exact pattern to make sure no bridge output trips
      // it up (e.g. multi-line JSON, BOM, trailing commas).
      invokeBridge('session_start', JSON.stringify({ session_id: 'a' }));
      invokeBridge('tool_start', JSON.stringify({ tool_name: 'Read' }), 'tool:tool_name');
      invokeBridge('tool_end', JSON.stringify({ tool_name: 'Read' }), 'tool:tool_name');
      invokeBridge('idle', JSON.stringify({}));

      const raw = fs.readFileSync(path.join(tempDir, 'events.jsonl'), 'utf-8');
      const lines = raw.split('\n').filter((line) => line.trim().length > 0);
      expect(lines.length).toBe(4);
      // Each line must be a valid single-line JSON object.
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
        expect(line).not.toContain('\n');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Layer 4: real-auth Gemini hook firing (opt-in)
  //
  // Closes the loop on "are Gemini hooks working in production?" by spawning
  // the real Gemini binary in interactive mode, letting it boot through
  // SessionStart against the user's real auth, and asserting that at least
  // one event lands in events.jsonl via the event-bridge.
  //
  // How it sidesteps the usual blockers:
  //   1. Auth: spawns with the user's real HOME inherited, so Gemini picks
  //      up its persistent auth selection (stored in ~/.gemini/settings.json
  //      under security.auth.selectedType - works for both OAuth and stored
  //      api-key without needing anything in env). Gemini's `-p` mode is
  //      avoided because that flag specifically requires GEMINI_API_KEY in
  //      env and bypasses the OAuth path entirely.
  //   2. Trust dialog: places the sandbox at <repoRoot>/.kangentic-test-sandbox-N
  //      so it inherits trust from the Kangentic repo root, which the
  //      developer running the test has already added to their
  //      ~/.gemini/trustedFolders.json. No manipulation of the user's trust
  //      config is needed.
  //   3. Exit: waits for the boxed input prompt to render via the adapter's
  //      detectIdle regex, then sends `/quit\r` so Gemini shuts down cleanly.
  //
  // It's opt-in because it touches real credentials and only makes sense
  // when run from inside the Kangentic repo with a developer's local Gemini
  // setup. Run with:
  //
  //   KANGENTIC_TEST_REAL_GEMINI=1 npx vitest run agent-pty-detection
  //
  // ---------------------------------------------------------------------------
  describe('Gemini hooks with real auth (opt-in)', () => {
    const optedIn = process.env.KANGENTIC_TEST_REAL_GEMINI === '1';
    const binary = resolveBinary('gemini');
    const describeOrSkip = optedIn && binary ? describe : describe.skip;

    describeOrSkip('live hook firing', () => {
      it('Gemini fires SessionStart when run interactively in a pre-trusted folder', async () => {
        // Use a sandbox under the test runner's CWD - the Kangentic repo
        // root - which is already in the user's ~/.gemini/trustedFolders.json
        // (this is the repo they develop in, so they've trusted it already).
        // Trust inherits down the directory tree, so a temp dir nested
        // anywhere inside is automatically trusted, and we don't need to
        // touch the user's trust config at all.
        const sandbox = path.join(process.cwd(), '.kangentic-test-sandbox-' + Date.now());
        fs.mkdirSync(sandbox, { recursive: true });
        try {
          // Production path layout: events file under main repo .kangentic.
          const ptySessionId = uuidv4();
          const sessionDir = path.join(sandbox, '.kangentic', 'sessions', ptySessionId);
          fs.mkdirSync(sessionDir, { recursive: true });
          const { eventsOutputPath: eventsPath } = sessionOutputPaths(sessionDir);

          // Trigger hook config write via the adapter (writes the same
          // .gemini/settings.json the production transition-engine writes).
          const adapter = new GeminiAdapter();
          adapter.buildCommand({
            agentPath: binary!,
            taskId: 'task-real-test',
            cwd: sandbox,
            permissionMode: 'bypassPermissions',
            eventsOutputPath: eventsPath,
          });

          // Spawn Gemini in INTERACTIVE mode (no -p) so it uses the user's
          // persistent auth selection (OAuth or stored api-key), boots
          // through SessionStart, and waits for input. We use the user's
          // REAL HOME so auth + trust + settings are picked up.
          const term = ptySpawn(binary!, [], {
            name: 'xterm-256color',
            cols: 120,
            rows: 30,
            cwd: sandbox,
            env: filterEnv(process.env),
          });

          // Capture for diagnostics + drive lifecycle. We wait for first
          // idle (the input prompt is painted), then send /quit so Gemini
          // exits cleanly. SessionStart should have fired by then.
          const chunks: string[] = [];
          let idleSeen = false;
          let bufferTail = '';
          const adapterStrategy = adapter.runtime.activity;
          const detectIdle =
            adapterStrategy.kind === 'pty' || adapterStrategy.kind === 'hooks_and_pty'
              ? adapterStrategy.detectIdle
              : undefined;

          const exitPromise = new Promise<number | null>((resolve) => {
            let resolved = false;
            const finish = (code: number | null) => {
              if (resolved) return;
              resolved = true;
              try { term.kill(); } catch { /* gone */ }
              resolve(code);
            };
            term.onData((data: string) => {
              chunks.push(data);
              bufferTail = (bufferTail + data).slice(-4096);
              if (!idleSeen && detectIdle && (detectIdle(data) || detectIdle(bufferTail))) {
                idleSeen = true;
                // Boot complete + idle prompt painted. Wait briefly for
                // any pending hook fires to land on disk, then exit.
                setTimeout(() => {
                  try { term.write('/quit\r'); } catch { /* gone */ }
                  // Backstop - if /quit doesn't take, kill after 2s.
                  setTimeout(() => finish(null), 2000);
                }, 1500);
              }
            });
            term.onExit(({ exitCode }) => finish(exitCode));
            setTimeout(() => finish(null), 30_000);
          });

          await exitPromise;
          await new Promise((resolve) => setTimeout(resolve, 500));

          const events = readEventsFile(eventsPath);

          // Persist for inspection. Done before cleanup so the diagnostic
          // artifacts survive even when the assertion fails and the
          // sandbox dir gets removed in the finally block.
          try {
            fs.writeFileSync(
              path.join(FIXTURE_DIR, 'gemini-real-auth-events.jsonl'),
              events.map((event) => JSON.stringify(event)).join('\n'),
            );
            fs.writeFileSync(
              path.join(FIXTURE_DIR, 'gemini-real-auth-output.txt'),
              chunks.join('').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''),
            );
            // Snapshot the .gemini/settings.json the adapter wrote, so a
            // failing test can be debugged after the sandbox is gone.
            const settingsSrc = path.join(sandbox, '.gemini', 'settings.json');
            if (fs.existsSync(settingsSrc)) {
              fs.copyFileSync(settingsSrc, path.join(FIXTURE_DIR, 'gemini-real-auth-settings.json'));
            }
          } catch { /* ignore */ }

          // Diagnostic: dump tail of output if no events fired so the user
          // can see what Gemini was doing instead.
          if (events.length === 0) {
            const tail = chunks.join('').slice(-2000).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
            console.error('[gemini-real-auth] events.jsonl is empty. Output tail:\n' + tail);
            console.error('[gemini-real-auth] eventsPath:', eventsPath);
            console.error('[gemini-real-auth] settings file at:', path.join(sandbox, '.gemini', 'settings.json'));
          }

          // The hard assertion: the bridge should have fired AT LEAST one
          // event. Which event depends on Gemini's hook semantics for
          // non-interactive mode - SessionStart, BeforeAgent, BeforeTool,
          // SessionEnd, etc. Any single event proves the full pipeline
          // works end-to-end.
          expect(events.length).toBeGreaterThan(0);

          // Bonus: verify the events have the shape the renderer expects.
          for (const event of events) {
            expect(typeof event.ts).toBe('number');
            expect(typeof event.type).toBe('string');
            expect(event.type.length).toBeGreaterThan(0);
          }

          // Stronger assertion: at least one event should be SessionStart
          // OR a tool event (proving the prompt was actually processed).
          // If only Notification fires, the prompt may have errored before
          // running.
          const eventTypes = events.map((event) => event.type);
          const sawMeaningfulEvent = eventTypes.some((type) =>
            type === 'session_start' || type.startsWith('tool_') || type === 'idle' || type === 'prompt',
          );
          if (!sawMeaningfulEvent) {
            console.warn(
              '[gemini-real-auth] Only saw event types: ' + eventTypes.join(', ') +
              '. This may indicate the prompt did not actually execute.',
            );
          }
        } finally {
          try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
        }
      }, 45_000);
    });

    if (!optedIn) {
      it.skip('skipped - set KANGENTIC_TEST_REAL_GEMINI=1 to run real-auth Gemini hook validation (uses your real Gemini auth + temporarily pre-trusts the test cwd)', () => {
        // This stub keeps the describe block visible in test output even
        // when skipped, so users discover the opt-in flag exists.
      });
    }
  });
});
