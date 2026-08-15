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

// Mock hook-manager to prevent real file I/O from writeSessionConfig.
// Tests that want the --config-dir flag must supply eventsOutputPath,
// but we use a tmp dir and real fs in those cases.
vi.mock('../../src/main/agent/adapters/copilot/hook-manager', () => ({
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

    it('acceptEdits maps to --allow-all-tools', () => {
      const command = buildCommand({ permissionMode: 'acceptEdits' });
      expect(command).toContain('--allow-all-tools');
      expect(command).not.toContain('--plan');
      expect(command).not.toContain('--yolo');
    });

    it('auto maps to --allow-all-tools', () => {
      const command = buildCommand({ permissionMode: 'auto' });
      expect(command).toContain('--allow-all-tools');
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
    it('sessionId produces --resume <id>', () => {
      const command = buildCommand({ sessionId: 'abc-123-def' });
      expect(command).toContain('--resume');
      expect(command).toContain('abc-123-def');
    });

    it('sessionId with resume: true still uses --resume', () => {
      // Copilot uses --resume for both new and existing sessions
      const command = buildCommand({ sessionId: 'abc-123-def', resume: true });
      expect(command).toContain('--resume');
      expect(command).toContain('abc-123-def');
    });

    it('no sessionId produces no --resume flag', () => {
      const command = buildCommand();
      expect(command).not.toContain('--resume');
    });

    it('sessionId comes before permission mode flags', () => {
      const command = buildCommand({
        sessionId: 'abc-123',
        permissionMode: 'plan',
      });
      const resumeIndex = command.indexOf('--resume');
      const planIndex = command.indexOf('--plan');
      expect(resumeIndex).toBeGreaterThan(-1);
      expect(planIndex).toBeGreaterThan(-1);
      // --resume appears before --plan in the command
      expect(resumeIndex).toBeLessThan(planIndex);
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
      expect(command).not.toContain('-i');
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
