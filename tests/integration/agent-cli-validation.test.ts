/**
 * Agent CLI validation: end-to-end checks against the locally-installed
 * agent CLIs. Two categories of regression are covered:
 *
 *  1. Command-builder flag emission - for every adapter and every
 *     PermissionMode (plus resume / model / effort overrides), assert
 *     the flags emitted by `adapter.buildCommand()` are documented in
 *     `<cli> --help`. Catches CLI flag renames / removals (e.g. the
 *     Codex `--full-auto` -> `--sandbox` migration).
 *
 *  2. Capability discovery - for every adapter that ships a
 *     `discoverCapabilities()` method, assert the returned shape lines
 *     up with what `<cli> --help` actually advertises. Specifically:
 *       - `supportsModelOverride` matches whether `--help` has `--model`
 *       - `effortLevels` (when present) matches the choices in `--help`
 *       - When session history exists locally, the JSONL/JSON scan
 *         finds at least one model (catches schema-drift bugs in the
 *         per-agent parser, e.g. a renamed `payload.model` key).
 *
 * Tests are auto-skipped when an agent's CLI is not installed locally,
 * so this same suite runs on any developer machine and only validates
 * the agents available there.
 *
 * Run: npx vitest run tests/integration/agent-cli-validation.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { CodexAdapter } from '../../src/main/agent/adapters/codex/codex-adapter';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini/gemini-adapter';
import { AiderAdapter } from '../../src/main/agent/adapters/aider/aider-adapter';
import { CursorAdapter } from '../../src/main/agent/adapters/cursor/cursor-adapter';
import { WarpAdapter } from '../../src/main/agent/adapters/warp/warp-adapter';
import { CopilotAdapter } from '../../src/main/agent/adapters/copilot/copilot-adapter';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode/opencode-adapter';
import { QwenAdapter } from '../../src/main/agent/adapters/qwen-code/qwen-adapter';
import { KimiAdapter } from '../../src/main/agent/adapters/kimi/kimi-adapter';
import { DroidAdapter } from '../../src/main/agent/adapters/droid/droid-adapter';
import { GrokAdapter } from '../../src/main/agent/adapters/grok/grok-adapter';
import type { AgentAdapter, SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

/** Every PermissionMode the renderer can dispatch. */
const ALL_PERMISSION_MODES: PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
  'auto',
];

/**
 * Flags emitted by adapters that we know are valid even if `--help` does
 * not list them. Most entries fall into two buckets:
 *   1. The flag is for a subcommand (e.g. Codex's `resume` subcommand has
 *      its own flag set distinct from the top-level help).
 *   2. The flag is intentionally undocumented but supported (e.g. test-
 *      mode flags, or flags only listed under `<cli> <subcommand> --help`).
 *
 * Adding an entry here is an explicit override - the test will accept it
 * without searching `--help`. Keep this list short; prefer fixing the
 * adapter to emit only documented flags.
 */
const KNOWN_UNDOCUMENTED_FLAGS: Record<string, Set<string>> = {
  codex: new Set([]),
  opencode: new Set([]),
  warp: new Set([
    // `oz agent run` is a subcommand; flags below live under
    // `oz agent run --help`, not the top-level `oz --help`.
    '-C', '--name', '--prompt',
  ]),
};

/** Build a SpawnCommandOptions with sensible defaults for the probe. */
function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/test-agent',
    taskId: 'probe-task',
    cwd: '/tmp/probe',
    permissionMode: 'default',
    prompt: 'noop',
    ...overrides,
  };
}

/**
 * Extract every `--flag` and `-x` token from a built command string.
 *
 * Handles the common shapes:
 *   - `--flag value`     -> `--flag`
 *   - `--flag=value`     -> `--flag`
 *   - `-x value`         -> `-x`
 *   - `--flag` (boolean) -> `--flag`
 *
 * Tokens inside single or double quotes are skipped (they are values,
 * not flags). Negative numbers (e.g. `-1`) are filtered by requiring
 * at least one alphabetic character after the leading dash.
 */
function extractFlags(command: string): string[] {
  const stripped = command
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""');

  const tokens = stripped.split(/\s+/);
  const flags = new Set<string>();
  for (const token of tokens) {
    if (!token.startsWith('-')) continue;
    if (!/^-{1,2}[a-zA-Z]/.test(token)) continue;
    const flag = token.split('=')[0];
    flags.add(flag);
  }
  return Array.from(flags);
}

/** Run `<cliPath> --help` and return stdout+stderr. */
function readHelpText(cliPath: string): string {
  try {
    if (process.platform === 'win32') {
      return execSync(`"${cliPath}" --help`, {
        timeout: 5000,
        encoding: 'utf-8',
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
    }
    return execFileSync(cliPath, ['--help'], {
      timeout: 5000,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const error = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout = error.stdout?.toString() ?? '';
    const stderr = error.stderr?.toString() ?? '';
    return stdout + stderr;
  }
}

/**
 * Validate that every flag emitted by the adapter for `mode` is documented
 * in the help text or is in the agent's known-undocumented allowlist.
 * Returns a list of unknown flag names (empty array means all good).
 */
function findUnknownFlags(
  agentName: string,
  helpText: string,
  command: string,
): string[] {
  const flags = extractFlags(command);
  const allowlist = KNOWN_UNDOCUMENTED_FLAGS[agentName] ?? new Set<string>();
  const unknown: string[] = [];
  for (const flag of flags) {
    if (allowlist.has(flag)) continue;
    const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match the flag at a word boundary - the flag must appear in help
    // followed by whitespace, comma, end-of-line, or `=`.
    const pattern = new RegExp(`(?:^|[\\s,])${escaped}(?:$|[\\s,=])`, 'm');
    if (!pattern.test(helpText)) {
      unknown.push(flag);
    }
  }
  return unknown;
}

interface ProbeAdapter {
  name: string;
  adapter: AgentAdapter;
}

const ADAPTERS: ProbeAdapter[] = [
  { name: 'claude', adapter: new ClaudeAdapter() },
  { name: 'codex', adapter: new CodexAdapter() },
  { name: 'gemini', adapter: new GeminiAdapter() },
  { name: 'aider', adapter: new AiderAdapter() },
  { name: 'cursor', adapter: new CursorAdapter() },
  { name: 'warp', adapter: new WarpAdapter() },
  { name: 'copilot', adapter: new CopilotAdapter() },
  { name: 'opencode', adapter: new OpenCodeAdapter() },
  { name: 'qwen', adapter: new QwenAdapter() },
  { name: 'kimi', adapter: new KimiAdapter() },
  { name: 'droid', adapter: new DroidAdapter() },
  { name: 'grok', adapter: new GrokAdapter() },
];

/**
 * Heuristic: does `<cli> --help` advertise a `--model` (or `-m, --model`)
 * flag? Used to cross-check `discoverCapabilities().supportsModelOverride`.
 * Mirrors the regex each adapter uses internally so the test does not
 * just re-implement the adapter's own logic - it asserts the *same*
 * conclusion against the same source of truth.
 */
function helpAdvertisesModelFlag(helpText: string): boolean {
  return /(?:^|\s|,)(-m,?\s*)?--model(?:\s|=|,|$)/m.test(helpText);
}

/**
 * Per-agent root directory holding session-history files, plus a flag
 * indicating whether sessions there are EXPECTED to surface model
 * identifiers. Used by the "session-history scan finds models when
 * sessions exist" assertion.
 *
 *   `root` - where the agent stores session files. When missing or
 *     empty, the test soft-passes.
 *   `expectModels` - true when the agent's session format reliably
 *     carries model strings (assistant messages, telemetry events,
 *     etc.). Agents like Kimi whose wire format only emits model on
 *     specific event types that test fixtures may not produce should
 *     set this to false: the adapter can still surface models when
 *     real sessions run, but the probe will not fail when the local
 *     fixtures happen to lack them.
 *
 * Adapters NOT in this table opt out of the scan check entirely. Add
 * an entry whenever you add a new adapter that scans local files.
 */
interface SessionRootSpec {
  root: string;
  expectModels: boolean;
}
const SESSIONS_ROOTS: Record<string, SessionRootSpec | undefined> = {
  claude: { root: path.join(os.homedir(), '.claude', 'projects'), expectModels: true },
  codex: { root: path.join(os.homedir(), '.codex', 'sessions'), expectModels: true },
  gemini: { root: path.join(os.homedir(), '.gemini', 'tmp'), expectModels: true },
  qwen: { root: path.join(os.homedir(), '.qwen', 'projects'), expectModels: true },
  cursor: { root: path.join(os.homedir(), '.cursor', 'sessions'), expectModels: true },
  // Kimi's wire.jsonl format only embeds the model on specific event
  // types (TurnEnd / StatusUpdate variants); test fixtures and
  // mid-session captures legitimately lack it. Keep the parser warmed
  // up but do not fail the probe when sessions exist without models.
  kimi: { root: path.join(os.homedir(), '.kimi', 'sessions'), expectModels: false },
  copilot: { root: path.join(os.homedir(), '.copilot'), expectModels: true },
  opencode: undefined, // session storage path varies; skip scan check
  droid: { root: path.join(os.homedir(), '.factory', 'sessions'), expectModels: true },
  aider: undefined, // .aider.chat.history.md lives per-project, not global
  warp: undefined, // no per-user session store
  // Grok's model list comes from its own `~/.grok/models_cache.json` (the
  // same source its /model picker uses), which the CLI writes on first use -
  // so an install with sessions on disk reliably has a populated cache.
  grok: { root: path.join(os.homedir(), '.grok', 'sessions'), expectModels: true },
};

/**
 * Agents whose effort levels are documented OUTSIDE `--help` (grok's ladder
 * comes from its own models cache metadata and the in-TUI `/effort` command;
 * `grok --help` shows only `--reasoning-effort <EFFORT>` with no choice
 * list). The effort-in-help assertion soft-passes for these; the source the
 * adapter reads IS the CLI's own.
 */
const EFFORT_LEVELS_DOCUMENTED_OUTSIDE_HELP = new Set(['grok']);

/**
 * Recursively check whether `root` (or any subdirectory up to depth 5)
 * contains at least one file matching `pattern`. Bounded so the test
 * does not stat tens of thousands of files on a heavily-used install.
 */
function directoryHasFiles(root: string, pattern: RegExp, depth = 5): boolean {
  if (depth < 0) return false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && pattern.test(entry.name)) return true;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (directoryHasFiles(path.join(root, entry.name), pattern, depth - 1)) {
      return true;
    }
  }
  return false;
}

describe('agent CLI validation (against live --help and disk state)', () => {
  for (const { name, adapter } of ADAPTERS) {
    describe(name, () => {
      let cliPath: string | null = null;
      let helpText = '';

      beforeAll(async () => {
        const info = await adapter.detect(null);
        if (!info.found || !info.path) {
          console.log(`[probe] ${name}: CLI not installed; skipping`);
          return;
        }
        cliPath = info.path;
        helpText = readHelpText(cliPath);
        if (helpText.length === 0) {
          console.log(`[probe] ${name}: --help returned empty output; skipping`);
          cliPath = null;
        }
      });

      for (const mode of ALL_PERMISSION_MODES) {
        it(`permissionMode=${mode}`, () => {
          if (!cliPath) return;
          const command = adapter.buildCommand(makeOptions({
            agentPath: cliPath,
            permissionMode: mode,
          }));
          const unknown = findUnknownFlags(name, helpText, command);
          if (unknown.length > 0) {
            console.error(
              `[probe] ${name} permissionMode=${mode}: unknown flags ${JSON.stringify(unknown)}\n  Command: ${command}`,
            );
          }
          expect(unknown).toEqual([]);
        });
      }

      it('resume', () => {
        if (!cliPath) return;
        const command = adapter.buildCommand(makeOptions({
          agentPath: cliPath,
          resume: true,
          sessionId: '00000000-0000-0000-0000-000000000000',
        }));
        const unknown = findUnknownFlags(name, helpText, command);
        if (unknown.length > 0) {
          console.error(
            `[probe] ${name} resume: unknown flags ${JSON.stringify(unknown)}\n  Command: ${command}`,
          );
        }
        expect(unknown).toEqual([]);
      });

      it('model override', () => {
        if (!cliPath) return;
        const command = adapter.buildCommand(makeOptions({
          agentPath: cliPath,
          model: 'test-model-id',
        }));
        const unknown = findUnknownFlags(name, helpText, command);
        if (unknown.length > 0) {
          console.error(
            `[probe] ${name} model: unknown flags ${JSON.stringify(unknown)}\n  Command: ${command}`,
          );
        }
        expect(unknown).toEqual([]);
      });

      it('effort override', () => {
        if (!cliPath) return;
        const command = adapter.buildCommand(makeOptions({
          agentPath: cliPath,
          effort: 'high',
        }));
        const unknown = findUnknownFlags(name, helpText, command);
        if (unknown.length > 0) {
          console.error(
            `[probe] ${name} effort: unknown flags ${JSON.stringify(unknown)}\n  Command: ${command}`,
          );
        }
        expect(unknown).toEqual([]);
      });

      // -------- Capability discovery --------

      it('discoverCapabilities returns a usable shape', async () => {
        if (!cliPath) return;
        if (!adapter.discoverCapabilities) {
          // Adapters without a discovery method are fine; just skip.
          return;
        }
        const capabilities = await adapter.discoverCapabilities(cliPath);
        // Must be a defined object - never undefined / null. The renderer
        // unwraps via `?? {}` but a thrown promise would propagate to the
        // IPC handler and surface as a missing agent in the dropdown.
        expect(capabilities).toBeDefined();
        expect(typeof capabilities).toBe('object');
      });

      it('supportsModelOverride matches --help', async () => {
        if (!cliPath) return;
        if (!adapter.discoverCapabilities) return;
        const capabilities = await adapter.discoverCapabilities(cliPath);
        const reportedSupport = capabilities.supportsModelOverride === true;
        const helpHasModelFlag = helpAdvertisesModelFlag(helpText);
        if (reportedSupport !== helpHasModelFlag) {
          console.error(
            `[probe] ${name}: supportsModelOverride=${reportedSupport}, but --help model flag=${helpHasModelFlag}`,
          );
        }
        // Hard assertion: the adapter's claim must match what the CLI
        // actually documents. A mismatch hides the model dropdown
        // (false negative) or shows a broken one (false positive).
        expect(reportedSupport).toBe(helpHasModelFlag);
      });

      it('effortLevels (when present) match --help', async () => {
        if (!cliPath) return;
        if (!adapter.discoverCapabilities) return;
        const capabilities = await adapter.discoverCapabilities(cliPath);
        const levels = capabilities.effortLevels;
        if (!levels || levels.length === 0) {
          // Soft pass: most adapters legitimately have no effort levels.
          return;
        }
        if (EFFORT_LEVELS_DOCUMENTED_OUTSIDE_HELP.has(name)) {
          // The ladder is real but documented in the CLI's own config/cache,
          // not in --help - see the set's doc comment.
          return;
        }
        // Each declared level must appear somewhere in the help text.
        // We do not invert (help -> levels) because some CLIs document
        // the choices in JSON config rather than --help.
        for (const level of levels) {
          const escaped = level.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const pattern = new RegExp(`\\b${escaped}\\b`, 'i');
          if (!pattern.test(helpText)) {
            console.error(
              `[probe] ${name}: declared effort level "${level}" not found in --help`,
            );
          }
          expect(helpText).toMatch(pattern);
        }
      });

      it('session-history scan finds models when sessions exist', async () => {
        if (!cliPath) return;
        if (!adapter.discoverCapabilities) return;
        const capabilities = await adapter.discoverCapabilities(cliPath);
        // We can only assert "scan worked" when:
        //  1. The agent claims model-override support (otherwise it
        //     skips the scan entirely - intentional).
        //  2. The agent's session-history directory exists locally
        //     and contains at least one session file (proxy for "the
        //     user has run this agent before").
        //  3. The agent's session format is expected to carry model
        //     identifiers (some agents write models only on event
        //     types that test fixtures may not produce).
        // When any of these are false, we soft-pass.
        if (capabilities.supportsModelOverride !== true) return;
        const spec = SESSIONS_ROOTS[name];
        if (!spec) return; // adapter not in the table - opt out
        const hasSessions = directoryHasFiles(spec.root, /\.(jsonl|json)$/i);
        if (!hasSessions) {
          console.log(
            `[probe] ${name}: no session files under ${spec.root}, skipping scan assertion`,
          );
          return;
        }
        if (!spec.expectModels) {
          // The session format does not reliably carry model strings,
          // so we cannot assert that a populated dir produces models.
          // The static `--help`-derived `supportsModelOverride` check
          // already validates that the agent itself accepts a model.
          return;
        }
        // When sessions exist on disk AND the format is expected to
        // carry model strings, the adapter must surface at least one.
        // A false-negative here is exactly the bug pattern that hides
        // "gpt-5.5" from the dropdown after a real Codex session ran
        // (the JSONL parser missed the schema).
        if (!capabilities.models || capabilities.models.length === 0) {
          console.error(
            `[probe] ${name}: ${spec.root} contains session files but discoverCapabilities returned no models. Likely a JSONL/JSON schema drift in the adapter's parser.`,
          );
        }
        expect(capabilities.models).toBeDefined();
        expect(capabilities.models!.length).toBeGreaterThan(0);
      });
    });
  }
});
