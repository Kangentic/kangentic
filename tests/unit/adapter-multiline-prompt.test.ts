/**
 * Regression guard: every adapter that accepts a `prompt` argument must pass
 * `{ multiline: true }` to `quoteArg` so multi-line XML task envelopes
 * survive shell delivery under bash/zsh/fish.
 *
 * History: prior to this branch, all adapters stripped newlines before shell
 * quoting because `quoteArg` defaults to sanitization mode. The fix adds a
 * `{ multiline?: boolean }` option to `quoteArg` and opts the prompt arg in
 * to multiline mode. Dropping the option from any adapter regresses prompt
 * delivery for tasks with multi-line descriptions.
 *
 * Coverage: codex, aider, opencode, kimi, droid, warp, ollama, grok.
 * (claude, gemini, copilot, qwen-code are covered in their own test files.)
 *
 * Strategy: build the command with `shell: 'bash'` and a multi-line XML
 * prompt, then assert that the built command still contains a newline from
 * inside the XML. If `{ multiline: true }` is missing, `quoteArg` calls
 * `sanitizeForPty` first, which collapses all newlines to spaces - so the
 * newline assertion fails immediately on regression.
 *
 * File writes are suppressed by vi.mock for hook-managers that have side
 * effects. Adapters without hook side effects (warp, droid, opencode) need
 * no mocking.
 */
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Suppress hook-manager file I/O for adapters that write settings on spawn
// ---------------------------------------------------------------------------

// Codex builds hooks into a projectRoot directory on spawn - mock to skip it.
vi.mock('../../src/main/agent/adapters/codex/hook-manager', () => ({
  buildHooks: vi.fn(),
  removeHooks: vi.fn(),
}));

// OpenCode installs a plugin file on spawn - mock to skip it.
vi.mock('../../src/main/agent/adapters/opencode/hook-manager', () => ({
  buildHooks: vi.fn(),
  removeHooks: vi.fn(),
  OPENCODE_HOOK_EVENTS: {},
}));

// bridge-utils is used by some adapters during hook injection - stub the path.
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn((name: string) => `/fake/scripts/${name}.js`),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { CodexCommandBuilder } from '../../src/main/agent/adapters/codex';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';
import { OpenCodeCommandBuilder } from '../../src/main/agent/adapters/opencode';
import { KimiCommandBuilder } from '../../src/main/agent/adapters/kimi';
import { DroidCommandBuilder } from '../../src/main/agent/adapters/droid';
import { WarpAdapter } from '../../src/main/agent/adapters/warp';
import { OllamaAdapter } from '../../src/main/agent/adapters/ollama';
import { GrokCommandBuilder } from '../../src/main/agent/adapters/grok';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

/**
 * Multi-line XML task envelope - simulates a real task with markdown
 * description. Mirrors the format buildTaskXml emits today: the open and
 * close <description> tags sit on their own lines for readability when the
 * body is multi-line.
 */
const MULTILINE_XML = '<task>\n  <title>Fix login</title>\n  <description>\nStep 1.\n\nStep 2.\n  </description>\n</task>';

/** The embedded newline we expect to survive quoting under bash. */
const EXPECTED_FRAGMENT = '\n  <title>Fix login</title>';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Adapter multiline prompt - regression guard for { multiline: true }', () => {
  it('CodexCommandBuilder preserves newlines in prompt under bash', () => {
    const builder = new CodexCommandBuilder();
    const command = builder.buildCodexCommand({
      codexPath: '/usr/bin/codex',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      prompt: MULTILINE_XML,
    });
    expect(command).toContain(EXPECTED_FRAGMENT);
  });

  it('AiderAdapter.buildCommand preserves newlines in prompt under bash', () => {
    const adapter = new AiderAdapter();
    const command = adapter.buildCommand({
      agentPath: '/usr/bin/aider',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      prompt: MULTILINE_XML,
    });
    expect(command).toContain(EXPECTED_FRAGMENT);
  });

  it('OpenCodeCommandBuilder preserves newlines in prompt under bash', () => {
    const builder = new OpenCodeCommandBuilder();
    const command = builder.buildOpenCodeCommand({
      opencodePath: '/usr/bin/opencode',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      prompt: MULTILINE_XML,
    });
    expect(command).toContain(EXPECTED_FRAGMENT);
  });

  it('KimiCommandBuilder preserves newlines in prompt under bash', () => {
    const builder = new KimiCommandBuilder();
    const command = builder.buildKimiCommand({
      kimiPath: '/usr/bin/kimi',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      prompt: MULTILINE_XML,
    });
    expect(command).toContain(EXPECTED_FRAGMENT);
  });

  it('DroidCommandBuilder preserves newlines in prompt under bash', () => {
    const builder = new DroidCommandBuilder();
    const command = builder.buildDroidCommand({
      droidPath: '/usr/bin/droid',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      prompt: MULTILINE_XML,
    });
    expect(command).toContain(EXPECTED_FRAGMENT);
  });

  it('WarpAdapter.buildCommand preserves newlines in prompt under bash', () => {
    const adapter = new WarpAdapter();
    const command = adapter.buildCommand({
      agentPath: '/usr/bin/oz',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      prompt: MULTILINE_XML,
    });
    expect(command).toContain(EXPECTED_FRAGMENT);
  });

  it('OllamaAdapter.buildCommand preserves newlines in prompt under bash', () => {
    const adapter = new OllamaAdapter();
    const command = adapter.buildCommand({
      agentPath: '/usr/bin/ollama',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      prompt: MULTILINE_XML,
    });
    expect(command).toContain(EXPECTED_FRAGMENT);
  });

  it('GrokCommandBuilder preserves newlines in prompt under bash', () => {
    // No eventsOutputPath / MCP options, so the builder's gated file writes
    // (hooks file, config block) are never reached - no mocking needed.
    const builder = new GrokCommandBuilder();
    const command = builder.buildGrokCommand({
      grokPath: '/usr/bin/grok',
      taskId: 'task-1',
      cwd: '/project',
      permissionMode: 'default',
      shell: 'bash',
      prompt: MULTILINE_XML,
    });
    expect(command).toContain(EXPECTED_FRAGMENT);
  });
});
