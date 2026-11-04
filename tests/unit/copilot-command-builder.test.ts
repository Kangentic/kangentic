/**
 * Unit tests for CopilotCommandBuilder - permission mode flag mapping,
 * session resume, prompt delivery, shell quoting, and MCP config generation.
 *
 * Omits eventsOutputPath on most tests to skip writeSessionConfig file writes
 * (same side-effect-avoidance pattern as gemini-command-builder.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { quoteArg } from '../../src/shared/paths';
import { CopilotCommandBuilder } from '../../src/main/agent/adapters/copilot';
import type { CopilotCommandOptions } from '../../src/main/agent/adapters/copilot';
import { copilotModelFlagValue } from '../../src/main/agent/adapters/copilot/command-builder';
import { COPILOT_BACKGROUND_COMMAND_SPEC, writeSessionConfig } from '../../src/main/agent/adapters/copilot/hook-manager';
import { backgroundShellHintSpecOf } from '../../src/main/agent/shared/background-command-hooks';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';

// Mock hook-manager to prevent real file I/O from writeSessionConfig.
// Tests that want the --config-dir flag must supply eventsOutputPath,
// but we use a tmp dir and real fs in those cases.
vi.mock('../../src/main/agent/adapters/copilot/hook-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent/adapters/copilot/hook-manager')>()),
  writeSessionConfig: vi.fn(),
}));

// Mock bridge-utils to avoid requiring built assets during unit tests.
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn((name: string) => `/fake/scripts/${name}.js`),
}));

/** Minimal options with sensible defaults. Omits eventsOutputPath by default. */
function baseOptions(overrides: Partial<CopilotCommandOptions> = {}): CopilotCommandOptions {
  return {
    copilotPath: '/usr/local/bin/copilot',
    taskId: 'task-1',
    cwd: '/projects/my-app',
    permissionMode: 'default',
    ...overrides,
  };
}

function buildCommand(overrides: Partial<CopilotCommandOptions> = {}): string {
  const builder = new CopilotCommandBuilder();
  return builder.buildCopilotCommand(baseOptions(overrides));
}

describe('copilotModelFlagValue', () => {
  it('reads the --model=value form', () => {
    expect(copilotModelFlagValue('copilot --model=gpt-5-mini -p x')).toBe('gpt-5-mini');
  });

  it('answers null when --model is the final token', () => {
    expect(copilotModelFlagValue('copilot --model')).toBeNull();
  });

  it('answers null for an empty quoted value', () => {
    expect(copilotModelFlagValue('copilot --model ""')).toBeNull();
  });

  it('reads a --model value the POSIX way quotes', () => {
    expect(copilotModelFlagValue("copilot --model 'it'\\''s-model' -i x")).toBe("it's-model");
  });

  it('stops at the prompt, so nothing after -p or -i is read as a flag', () => {
    expect(copilotModelFlagValue("copilot -i 'use --model x' --model late")).toBeNull();
    expect(copilotModelFlagValue('copilot -p --model late')).toBeNull();
  });

  it('reads the --model before the prompt in -p mode', () => {
    const command = buildCommand({ nonInteractive: true, shell: 'bash', model: 'gpt-5-mini', effort: 'high', prompt: 'go' });
    expect(command.indexOf('--model')).toBeLessThan(command.indexOf(' -p '));
    expect(command.indexOf('--reasoning-effort')).toBeLessThan(command.indexOf(' -p '));
    expect(copilotModelFlagValue(command)).toBe('gpt-5-mini');
  });
});

describe('CopilotCommandBuilder', () => {
  // ── Basic command ────────────────────────────────────────────────────────

  describe('basic command', () => {
    it('starts with the copilot path', () => {
      const command = buildCommand();
      expect(command.startsWith('/usr/local/bin/copilot')).toBe(true);
    });

    it('quotes copilot path with spaces', () => {
      const command = buildCommand({ copilotPath: '/path with spaces/copilot' });
      expect(command).toContain(quoteArg('/path with spaces/copilot'));
    });

    it('default mode produces no extra flags', () => {
      const command = buildCommand({ permissionMode: 'default' });
      expect(command).toBe('/usr/local/bin/copilot');
    });
  });

  // ── Permission mode mapping ──────────────────────────────────────────────

  describe('permission modes', () => {
    it('plan maps to --plan', () => {
      const command = buildCommand({ permissionMode: 'plan' });
      expect(command).toContain('--plan');
      expect(command).not.toContain('--no-ask-user');
      expect(command).not.toContain('--allow-all-tools');
      expect(command).not.toContain('--yolo');
    });

    it('dontAsk maps to --plan --no-ask-user', () => {
      const command = buildCommand({ permissionMode: 'dontAsk' });
      expect(command).toContain('--plan');
      expect(command).toContain('--no-ask-user');
    });

    // GitHub's docs: the `write` kind is "file creation or modification", so a
    // shell command still asks, as under Claude's acceptEdits.
    it('acceptEdits allows file writes only (--allow-tool=write)', () => {
      const command = buildCommand({ permissionMode: 'acceptEdits' });
      expect(command).toContain('--allow-tool=write');
      expect(command).not.toContain('--allow-all-tools');
      expect(command).not.toContain('--plan');
      expect(command).not.toContain('--yolo');
    });

    // Assisted permissions: `--assisted-approval` errors in an interactive
    // session, so an interactive auto session gets the settings.json key
    // (writeSessionConfig) and no flag.
    it('auto adds no flag to an interactive session', () => {
      const command = buildCommand({ permissionMode: 'auto' });
      expect(command).toBe('/usr/local/bin/copilot');
    });

    it('auto passes --assisted-approval to a non-interactive run', () => {
      const command = buildCommand({ permissionMode: 'auto', nonInteractive: true, prompt: 'Fix it' });
      expect(command).toContain('--assisted-approval');
      expect(command).not.toContain('--allow-all-tools');
    });

    it('asks the session config for assisted approvals only in auto mode', () => {
      vi.mocked(writeSessionConfig).mockClear();
      buildCommand({ permissionMode: 'auto', eventsOutputPath: path.join(os.tmpdir(), 'copilot-auto', 'events.jsonl') });
      buildCommand({ permissionMode: 'acceptEdits', eventsOutputPath: path.join(os.tmpdir(), 'copilot-edits', 'events.jsonl') });
      const calls = vi.mocked(writeSessionConfig).mock.calls;
      expect(calls[0][3]).toMatchObject({ assistedApprovals: true });
      expect(calls[1][3]).toMatchObject({ assistedApprovals: false });
    });

    it('hands capturePromptText to the session config only when asked', () => {
      vi.mocked(writeSessionConfig).mockClear();
      buildCommand({ capturePromptText: true, eventsOutputPath: path.join(os.tmpdir(), 'copilot-capture', 'events.jsonl') });
      buildCommand({ eventsOutputPath: path.join(os.tmpdir(), 'copilot-no-capture', 'events.jsonl') });
      const calls = vi.mocked(writeSessionConfig).mock.calls;
      expect(calls[0][3]).toMatchObject({ capturePromptText: true });
      expect(calls[1][3]).toMatchObject({ capturePromptText: false });
    });

    // A Copilot in a WSL distro builds its hook options apart from the host's;
    // the session settings must ride both.
    it('hands a WSL Copilot\'s session config the same settings beside its event command', () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-wsl-settings-'));
      try {
        const sessionDirectory = path.join(projectRoot, '.kangentic', 'sessions', 'record-1');
        const cliTarget: CliTarget = {
          kind: 'wsl',
          distro: 'Ubuntu',
          linuxCliPath: '/home/dev/.local/bin/copilot',
          facts: {
            distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: path.join(projectRoot, 'distro-home'), uncRoot: '\\\\wsl.localhost\\Ubuntu',
            interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
          },
        };
        vi.mocked(writeSessionConfig).mockClear();

        buildCommand({
          permissionMode: 'auto',
          capturePromptText: true,
          cliTarget,
          eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
        });

        const sessionOptions = vi.mocked(writeSessionConfig).mock.calls[0][3];
        expect(sessionOptions).toMatchObject({ assistedApprovals: true, capturePromptText: true, place: cliTarget });
        expect(typeof sessionOptions?.eventCommand).toBe('function');
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('bypassPermissions maps to --yolo', () => {
      const command = buildCommand({ permissionMode: 'bypassPermissions' });
      expect(command).toContain('--yolo');
      expect(command).not.toContain('--plan');
      expect(command).not.toContain('--allow-all-tools');
    });

    it('default mode adds no permission flags', () => {
      const command = buildCommand({ permissionMode: 'default' });
      expect(command).not.toContain('--plan');
      expect(command).not.toContain('--allow-all-tools');
      expect(command).not.toContain('--yolo');
      expect(command).not.toContain('--no-ask-user');
    });
  });

  // ── Session ID / resume ──────────────────────────────────────────────────

  describe('session ID and resume', () => {
    // Copilot 1.0.97 exits on `--resume <id>` for an id it has not seen ("No
    // session, task, or name matched"), so a new session needs `--session-id`,
    // which starts a session with that id or resumes it (1.0.51+).
    it('sessionId produces --session-id <id>, never --resume', () => {
      const command = buildCommand({ sessionId: 'abc-123-def' });
      expect(command).toContain('--session-id');
      expect(command).toContain('abc-123-def');
      expect(command).not.toContain('--resume');
    });

    // Each spawn gets a new session folder and so a new --config-dir; the
    // conversation lives in the previous one's session-state/<id>/.
    it('a resume brings the session folder into its new config home', () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-resume-'));
      const sessionsDir = path.join(projectRoot, '.kangentic', 'sessions');
      try {
        const previous = path.join(sessionsDir, 'record-1', 'copilot-config', 'session-state', 'abc-123-def');
        fs.mkdirSync(previous, { recursive: true });
        fs.writeFileSync(path.join(previous, 'events.jsonl'), '{}\n');
        const eventsOutputPath = path.join(sessionsDir, 'record-2', 'events.jsonl');

        buildCommand({ sessionId: 'abc-123-def', resume: true, eventsOutputPath });
        expect(fs.existsSync(path.join(sessionsDir, 'record-2', 'copilot-config', 'session-state', 'abc-123-def', 'events.jsonl'))).toBe(true);

        // A fresh start under a new id brings nothing over.
        buildCommand({ sessionId: 'new-id', eventsOutputPath: path.join(sessionsDir, 'record-3', 'events.jsonl') });
        expect(fs.existsSync(path.join(sessionsDir, 'record-3', 'copilot-config', 'session-state'))).toBe(false);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('a resume with no session id copies nothing into the new config home', () => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-resume-noid-'));
      const sessionsDir = path.join(projectRoot, '.kangentic', 'sessions');
      try {
        const previous = path.join(sessionsDir, 'record-1', 'copilot-config', 'session-state', 'abc-123-def');
        fs.mkdirSync(previous, { recursive: true });
        fs.writeFileSync(path.join(previous, 'events.jsonl'), '{}\n');

        const eventsOutputPath = path.join(sessionsDir, 'record-2', 'events.jsonl');
        expect(() => buildCommand({ resume: true, eventsOutputPath })).not.toThrow();
        expect(fs.existsSync(path.join(sessionsDir, 'record-2', 'copilot-config', 'session-state'))).toBe(false);
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true });
      }
    });

    it('sessionId with resume: true also uses --session-id', () => {
      const command = buildCommand({ sessionId: 'abc-123-def', resume: true });
      expect(command).toContain('--session-id');
      expect(command).toContain('abc-123-def');
      expect(command).not.toContain('--resume');
    });

    it('no sessionId produces no session flag', () => {
      const command = buildCommand();
      expect(command).not.toContain('--session-id');
      expect(command).not.toContain('--resume');
    });

    it('sessionId comes before permission mode flags', () => {
      const command = buildCommand({
        sessionId: 'abc-123',
        permissionMode: 'plan',
      });
      const sessionIndex = command.indexOf('--session-id');
      const planIndex = command.indexOf('--plan');
      expect(sessionIndex).toBeGreaterThan(-1);
      expect(planIndex).toBeGreaterThan(-1);
      expect(sessionIndex).toBeLessThan(planIndex);
    });
  });

  // ── Prompt delivery ──────────────────────────────────────────────────────

  describe('prompt delivery', () => {
    it('interactive prompt uses -i flag', () => {
      const command = buildCommand({ prompt: 'Fix the bug' });
      expect(command).toContain('-i');
      expect(command).toContain('Fix the bug');
      expect(command).not.toContain('-p');
    });

    it('non-interactive prompt uses -p flag', () => {
      const command = buildCommand({ nonInteractive: true, prompt: 'Run tests' });
      expect(command).toContain('-p');
      expect(command).toContain('Run tests');
      expect(command).not.toContain('-i');
    });

    it('non-interactive without prompt still emits -p (flag is always present in non-interactive mode)', () => {
      // The builder always emits -p when nonInteractive: true, even without a prompt.
      // Copilot treats -p with no following argument as "non-interactive with no initial prompt".
      const command = buildCommand({ nonInteractive: true });
      expect(command).toContain('-p');
    });

    it('resume with prompt omits -i (resumed sessions do not re-deliver prompt)', () => {
      // When resume: true, prompt is NOT sent as -i (resuming an existing session)
      const command = buildCommand({ resume: true, sessionId: 'abc-123', prompt: 'Fix the bug' });
      // A token check: `--session-id` contains the characters "-i".
      expect(command.split(' ')).not.toContain('-i');
      expect(command).not.toContain('Fix the bug');
    });

    it('no prompt produces no -i or -p flag', () => {
      const command = buildCommand();
      expect(command).not.toContain(' -i ');
      expect(command).not.toContain(' -p ');
    });
  });

  // ── Shell quoting ────────────────────────────────────────────────────────

  describe('shell quoting - preparePrompt', () => {
    it('replaces double quotes in prompt with single quotes for powershell', () => {
      const command = buildCommand({
        prompt: 'Fix the "broken" test',
        shell: 'powershell',
      });
      expect(command).not.toContain('"broken"');
      expect(command).toContain("'broken'");
    });

    it('replaces double quotes for cmd shell', () => {
      const command = buildCommand({
        prompt: 'Fix the "broken" test',
        shell: 'cmd',
      });
      expect(command).toContain("'broken'");
    });

    it('preserves double quotes for bash', () => {
      const command = buildCommand({
        prompt: 'Fix the "broken" test',
        shell: 'bash',
      });
      expect(command).toContain('"broken"');
    });

    it('preserves double quotes for zsh', () => {
      const command = buildCommand({
        prompt: 'Fix the "broken" test',
        shell: 'zsh',
      });
      expect(command).toContain('"broken"');
    });
  });

  // ── --config-dir flag ────────────────────────────────────────────────────

  describe('--config-dir flag', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-cmd-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('emits --config-dir when eventsOutputPath is provided', () => {
      const eventsOutputPath = path.join(tmpDir, 'events.jsonl');
      const command = buildCommand({ eventsOutputPath });
      expect(command).toContain('--config-dir');
    });

    it('omits --config-dir when eventsOutputPath is not provided', () => {
      const command = buildCommand();
      expect(command).not.toContain('--config-dir');
    });

    it('config dir path is derived from events dir + copilot-config', () => {
      const eventsOutputPath = path.join(tmpDir, 'events.jsonl');
      const command = buildCommand({ eventsOutputPath });
      // The config dir should be adjacent to the events file
      const expectedConfigDirSuffix = 'copilot-config';
      expect(command).toContain(expectedConfigDirSuffix);
    });
  });

  // ── --additional-mcp-config flag ─────────────────────────────────────────

  describe('--additional-mcp-config flag', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-mcp-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes a config with type:"http" so Copilot CLI accepts it', () => {
      // Regression: Copilot CLI's --additional-mcp-config schema is a
      // discriminated union on `type`. Without it the entry is rejected
      // as "mcpServers.kangentic: Invalid input" and Copilot exits.
      const eventsOutputPath = path.join(tmpDir, 'events.jsonl');
      buildCommand({
        eventsOutputPath,
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123',
        mcpServerToken: 'secret-token',
      });
      const mcpConfigPath = path.join(tmpDir, 'copilot-mcp.json');
      expect(fs.existsSync(mcpConfigPath)).toBe(true);
      const written = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
      expect(written).toEqual({
        mcpServers: {
          kangentic: {
            type: 'http',
            url: 'http://127.0.0.1:5555/mcp/project-123',
            headers: { 'X-Kangentic-Token': 'secret-token' },
          },
        },
      });
    });

    it('passes --additional-mcp-config @<path> to Copilot when MCP is enabled', () => {
      const eventsOutputPath = path.join(tmpDir, 'events.jsonl');
      const command = buildCommand({
        eventsOutputPath,
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123',
        mcpServerToken: 'secret-token',
      });
      expect(command).toContain('--additional-mcp-config');
      expect(command).toContain('@');
      expect(command).toContain('copilot-mcp.json');
    });

    // Kangentic's own tools never wait on an approval (Claude's mcp__kangentic
    // allow rule). A workflow agent that waits on one stalls unattended.
    it('approves Kangentic\'s own server outside the plan modes and YOLO', () => {
      const mcp = {
        eventsOutputPath: path.join(tmpDir, 'events.jsonl'),
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123',
        mcpServerToken: 'secret-token',
      };
      const allowsKangentic = (command: string) => command.includes('--allow-tool kangentic');
      for (const permissionMode of ['default', 'acceptEdits', 'auto'] as const) {
        expect(allowsKangentic(buildCommand({ ...mcp, permissionMode }))).toBe(true);
      }
      for (const permissionMode of ['plan', 'dontAsk', 'bypassPermissions'] as const) {
        expect(allowsKangentic(buildCommand({ ...mcp, permissionMode }))).toBe(false);
      }
      expect(allowsKangentic(buildCommand({ ...mcp, mcpServerEnabled: false, permissionMode: 'acceptEdits' }))).toBe(false);
    });

    it('omits --additional-mcp-config when MCP is disabled', () => {
      const eventsOutputPath = path.join(tmpDir, 'events.jsonl');
      const command = buildCommand({
        eventsOutputPath,
        mcpServerEnabled: false,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123',
        mcpServerToken: 'secret-token',
      });
      expect(command).not.toContain('--additional-mcp-config');
    });

    it('passes --additional-mcp-config in non-interactive mode', () => {
      // Regression: the nonInteractive branch returns early, and the MCP
      // block used to sit below it, so every non-interactive Copilot spawn
      // silently lost the Kangentic MCP server.
      const eventsOutputPath = path.join(tmpDir, 'events.jsonl');
      const command = buildCommand({
        eventsOutputPath,
        nonInteractive: true,
        prompt: 'do the thing',
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123',
        mcpServerToken: 'secret-token',
      });
      expect(command).toContain('--additional-mcp-config');
      expect(command).toContain('copilot-mcp.json');
      expect(fs.existsSync(path.join(tmpDir, 'copilot-mcp.json'))).toBe(true);
    });

    // --- Flag-order invariant ---
    //
    // This is a STRUCTURAL claim about command-builder.ts, not a claim about
    // how the Copilot CLI's parser handles flag order (unverified, unlike
    // Codex's documented `codex [OPTIONS] [PROMPT]` grammar). What the prior
    // tests above prove is that --additional-mcp-config is PRESENT in
    // non-interactive mode; they do not prove it stayed ahead of the
    // `nonInteractive` early return that used to make it disappear entirely.
    // A future edit could reintroduce the same bug in a subtler form -
    // hoisting `-p`/`-i` above the MCP block, or splitting buildMcpConfigArgs
    // across both branches - without any of the existing assertions
    // noticing, because `toContain` alone cannot see where in the string the
    // flag landed. Pinning the position keeps that regression class caught.
    //
    // shell: 'bash' pinned explicitly per the command-builder test convention
    // (CI runs unit tests on Linux; quoteArg's own quote character is
    // platform-dependent, but flag ORDER is not, so any fixed shell proves
    // the invariant).

    // Exact-token matching (split on whitespace, look for the whole flag)
    // rather than command.indexOf('-i' / '-p'): the temp mcp-config path
    // embedded later in the command is not guaranteed free of a "-i"
    // substring, which would make a plain indexOf comparison flaky.
    const flagTokenIndex = (command: string, flag: string): number =>
      command.split(' ').indexOf(flag);

    it('emits --additional-mcp-config before -p in non-interactive mode', () => {
      const eventsOutputPath = path.join(tmpDir, 'events.jsonl');
      const command = buildCommand({
        eventsOutputPath,
        shell: 'bash',
        nonInteractive: true,
        prompt: 'do the thing',
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123',
        mcpServerToken: 'secret-token',
      });
      const mcpFlagIndex = flagTokenIndex(command, '--additional-mcp-config');
      const promptFlagIndex = flagTokenIndex(command, '-p');
      expect(mcpFlagIndex).toBeGreaterThan(-1);
      expect(promptFlagIndex).toBeGreaterThan(-1);
      expect(mcpFlagIndex).toBeLessThan(promptFlagIndex);
    });

    it('emits --additional-mcp-config before -i in interactive mode', () => {
      const eventsOutputPath = path.join(tmpDir, 'events.jsonl');
      const command = buildCommand({
        eventsOutputPath,
        shell: 'bash',
        prompt: 'do the thing',
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123',
        mcpServerToken: 'secret-token',
      });
      const mcpFlagIndex = flagTokenIndex(command, '--additional-mcp-config');
      const promptFlagIndex = flagTokenIndex(command, '-i');
      expect(mcpFlagIndex).toBeGreaterThan(-1);
      expect(promptFlagIndex).toBeGreaterThan(-1);
      expect(mcpFlagIndex).toBeLessThan(promptFlagIndex);
    });
  });

  // ── background shell hint ────────────────────────────────────────────────

  /**
   * The background shell hint (task #859) names kangentic_mark_background_service,
   * so only a session offered that tool gets the hook: the MCP server on (not
   * switched off), a token, and an MCP URL that names a task session as its
   * caller (`/mcp/<project>/<session>`). writeSessionConfig is mocked above, so
   * the command the builder hands it is what these tests read.
   */
  describe('background shell hint', () => {
    const SESSION_MCP_URL = 'http://127.0.0.1:5555/mcp/project-123/sess-xyz';
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-hint-test-'));
      vi.mocked(writeSessionConfig).mockClear();
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /** The hint command the builder passed to writeSessionConfig (null when the session gets none). */
    function hintCommandPassed(overrides: Partial<CopilotCommandOptions>): string | null | undefined {
      buildCommand({ eventsOutputPath: path.join(tmpDir, 'events.jsonl'), ...overrides });
      const calls = vi.mocked(writeSessionConfig).mock.calls;
      expect(calls).toHaveLength(1);
      return calls[0][3]?.backgroundShellHintCommand;
    }

    it.each([true, undefined])('passes the hint, built from the Copilot spec, for a session URL and a token (mcpServerEnabled %s)', (mcpServerEnabled) => {
      const command = hintCommandPassed({ mcpServerEnabled, mcpServerUrl: SESSION_MCP_URL, mcpServerToken: 'secret-token' });

      expect(typeof command).toBe('string');
      expect(command!.startsWith('node ')).toBe(true);
      expect(command).toContain('background-shell-hint-bridge');
      // The last token is the base64 of the JSON spec the bridge reads.
      const encodedSpec = command!.split(' ').pop() ?? '';
      expect(JSON.parse(Buffer.from(encodedSpec, 'base64').toString('utf8'))).toEqual(backgroundShellHintSpecOf(COPILOT_BACKGROUND_COMMAND_SPEC));
    });

    it.each([
      ['a project URL that names no session', { mcpServerEnabled: true, mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123', mcpServerToken: 'secret-token' }],
      ['a Knowledge Graph answer run URL', { mcpServerEnabled: true, mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123/answer-chat-1', mcpServerToken: 'secret-token' }],
      ['a workflow agent URL', { mcpServerEnabled: true, mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123/workflow-wf-1', mcpServerToken: 'secret-token' }],
      ['no URL', { mcpServerEnabled: true, mcpServerUrl: undefined, mcpServerToken: 'secret-token' }],
      ['no token', { mcpServerEnabled: true, mcpServerUrl: SESSION_MCP_URL, mcpServerToken: undefined }],
      ['the MCP server switched off', { mcpServerEnabled: false, mcpServerUrl: SESSION_MCP_URL, mcpServerToken: 'secret-token' }],
    ] as Array<[string, Partial<CopilotCommandOptions>]>)('passes no hint with %s', (_label, overrides) => {
      expect(hintCommandPassed(overrides)).toBeNull();
    });
  });

  // ── interpolateTemplate ──────────────────────────────────────────────────

  describe('interpolateTemplate', () => {
    it('replaces {{key}} placeholders', () => {
      const builder = new CopilotCommandBuilder();
      const result = builder.interpolateTemplate(
        'Fix {{issue}} in {{file}}',
        { issue: 'bug-123', file: 'main.ts' },
      );
      expect(result).toBe('Fix bug-123 in main.ts');
    });

    it('leaves unmatched placeholders unchanged', () => {
      const builder = new CopilotCommandBuilder();
      const result = builder.interpolateTemplate('{{name}} - {{unknown}}', { name: 'test' });
      expect(result).toBe('test - {{unknown}}');
    });

    it('replaces multiple occurrences of same placeholder', () => {
      const builder = new CopilotCommandBuilder();
      const result = builder.interpolateTemplate(
        '{{x}} plus {{x}} equals two {{x}}',
        { x: 'value' },
      );
      expect(result).toBe('value plus value equals two value');
    });
  });

  // ── Multiline prompt preservation (regression guard) ─────────────────────
  // Regression guard: `{ multiline: true }` must be passed to quoteArg so
  // multi-line XML task envelopes survive shell delivery under bash.

  describe('multiline XML prompt under bash', () => {
    it('preserves newlines in the built command when shell is bash', () => {
      const xml = '<task>\n  <title>Fix login</title>\n  <description>\nStep 1.\n\nStep 2.\n  </description>\n</task>';
      const command = buildCommand({ prompt: xml, shell: 'bash' });
      expect(command).toContain('\n  <title>Fix login</title>');
    });
  });
});
