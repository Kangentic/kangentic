/**
 * Unit tests for CopilotAdapter - identity, registry integration,
 * removeHooks tracking (session config dirs keyed by project root),
 * CopilotStatusParser, and agent-display-name entries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';

// Mock which so detect() works without a real copilot binary.
vi.mock('which', () => ({
  default: vi.fn().mockResolvedValue('/usr/local/bin/copilot'),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn().mockReturnValue(true) } };
});

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn().mockResolvedValue({
    stdout: 'GitHub Copilot CLI 1.0.24.\n',
    stderr: '',
  }),
}));

// Mock hook-manager to avoid file I/O in adapter-level tests.
// copilot-hook-manager.test.ts covers the real file operations.
vi.mock('../../src/main/agent/adapters/copilot/hook-manager', () => ({
  writeSessionConfig: vi.fn(),
  removeSessionConfig: vi.fn(),
  buildHooks: vi.fn(() => ({})),
  COPILOT_HOOK_EVENTS: [],
}));

vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn((name: string) => `/fake/scripts/${name}.js`),
}));

import { CopilotAdapter } from '../../src/main/agent/adapters/copilot';
import { CopilotStatusParser } from '../../src/main/agent/adapters/copilot/status-parser';
import { removeSessionConfig } from '../../src/main/agent/adapters/copilot/hook-manager';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/local/bin/copilot',
    taskId: 'task-001',
    cwd: '/home/dev/project',
    permissionMode: 'acceptEdits',
    ...overrides,
  };
}

// ── CopilotAdapter identity ──────────────────────────────────────────────────

describe('CopilotAdapter - identity', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    adapter = new CopilotAdapter();
  });

  it('has name "copilot"', () => {
    expect(adapter.name).toBe('copilot');
  });

  it('has displayName "GitHub Copilot CLI"', () => {
    expect(adapter.displayName).toBe('GitHub Copilot CLI');
  });

  it('has sessionType "copilot_agent"', () => {
    expect(adapter.sessionType).toBe('copilot_agent');
  });

  it('supportsCallerSessionId is true', () => {
    // Copilot --resume <uuid> creates new sessions with a given UUID,
    // same semantics as Claude --session-id.
    expect(adapter.supportsCallerSessionId).toBe(true);
  });

  it('defaultPermission is "acceptEdits"', () => {
    expect(adapter.defaultPermission).toBe('acceptEdits');
  });

  it('permissions array includes all 6 modes', () => {
    const modes = adapter.permissions.map((p) => p.mode);
    expect(modes).toContain('plan');
    expect(modes).toContain('dontAsk');
    expect(modes).toContain('default');
    expect(modes).toContain('acceptEdits');
    expect(modes).toContain('auto');
    expect(modes).toContain('bypassPermissions');
  });
});

// ── CopilotAdapter detection ─────────────────────────────────────────────────

describe('CopilotAdapter - detection', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    adapter = new CopilotAdapter();
  });

  it('detect returns found: true with override path', async () => {
    const result = await adapter.detect('/custom/copilot');
    expect(result.found).toBe(true);
    expect(result.path).toBe('/custom/copilot');
  });

  it('invalidateDetectionCache does not throw', () => {
    expect(() => adapter.invalidateDetectionCache()).not.toThrow();
  });

  it('ensureTrust resolves without error', async () => {
    await expect(adapter.ensureTrust('/some/dir')).resolves.toBeUndefined();
  });
});

// ── CopilotAdapter buildCommand ──────────────────────────────────────────────

describe('CopilotAdapter - buildCommand', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    adapter = new CopilotAdapter();
  });

  it('returns a non-empty string', () => {
    const command = adapter.buildCommand(makeOptions());
    expect(typeof command).toBe('string');
    expect(command.length).toBeGreaterThan(0);
  });

  it('command contains the agent path', () => {
    const command = adapter.buildCommand(makeOptions({ agentPath: '/usr/local/bin/copilot' }));
    expect(command).toContain('copilot');
  });

  it('command contains --allow-all-tools for acceptEdits', () => {
    const command = adapter.buildCommand(makeOptions({ permissionMode: 'acceptEdits' }));
    expect(command).toContain('--allow-all-tools');
  });
});

// ── CopilotAdapter removeHooks tracking ─────────────────────────────────────

describe('CopilotAdapter - removeHooks', () => {
  let adapter: CopilotAdapter;
  let tmpDir: string;

  beforeEach(() => {
    adapter = new CopilotAdapter();
    // Re-enable the real fs.existsSync for this describe block
    // (the vi.mock above stubs it, but removeSessionConfig is also mocked)
    tmpDir = os.tmpdir();
    vi.mocked(removeSessionConfig).mockClear();
  });

  it('removeHooks does not throw when no sessions tracked', () => {
    expect(() => adapter.removeHooks('/some/project')).not.toThrow();
  });

  it('removeHooks calls removeSessionConfig for tracked task', () => {
    const projectRoot = '/home/dev/project';
    const eventsOutputPath = path.join(tmpDir, 'sessions', 'task-001', 'events.jsonl');

    // buildCommand with eventsOutputPath triggers session config tracking
    adapter.buildCommand(makeOptions({
      taskId: 'task-001',
      cwd: projectRoot,
      projectRoot,
      eventsOutputPath,
    }));

    adapter.removeHooks(projectRoot, 'task-001');

    expect(removeSessionConfig).toHaveBeenCalledTimes(1);
    // The config dir is derived from the events dir + 'copilot-config'
    const expectedConfigDir = path.resolve(path.dirname(eventsOutputPath), 'copilot-config');
    expect(removeSessionConfig).toHaveBeenCalledWith(expectedConfigDir);
  });

  it('removeHooks with taskId removes only that task, not others', () => {
    const projectRoot = '/home/dev/project';

    const eventsPath1 = path.join(tmpDir, 'sessions', 'task-001', 'events.jsonl');
    const eventsPath2 = path.join(tmpDir, 'sessions', 'task-002', 'events.jsonl');

    adapter.buildCommand(makeOptions({ taskId: 'task-001', cwd: projectRoot, projectRoot, eventsOutputPath: eventsPath1 }));
    adapter.buildCommand(makeOptions({ taskId: 'task-002', cwd: projectRoot, projectRoot, eventsOutputPath: eventsPath2 }));

    adapter.removeHooks(projectRoot, 'task-001');

    // Only task-001's config dir should be cleaned
    expect(removeSessionConfig).toHaveBeenCalledTimes(1);
    const firstCall = vi.mocked(removeSessionConfig).mock.calls[0][0];
    expect(firstCall).toContain('task-001');
  });

  it('removeHooks without taskId removes all sessions for that directory', () => {
    const projectRoot = '/home/dev/project';

    const eventsPath1 = path.join(tmpDir, 'sessions', 'task-001', 'events.jsonl');
    const eventsPath2 = path.join(tmpDir, 'sessions', 'task-002', 'events.jsonl');

    adapter.buildCommand(makeOptions({ taskId: 'task-001', cwd: projectRoot, projectRoot, eventsOutputPath: eventsPath1 }));
    adapter.buildCommand(makeOptions({ taskId: 'task-002', cwd: projectRoot, projectRoot, eventsOutputPath: eventsPath2 }));

    adapter.removeHooks(projectRoot);

    expect(removeSessionConfig).toHaveBeenCalledTimes(2);
  });

  it('clearSettingsCache does not throw', () => {
    expect(() => adapter.clearSettingsCache()).not.toThrow();
  });
});

// ── CopilotAdapter runtime strategy ─────────────────────────────────────────

describe('CopilotAdapter - runtime strategy', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    adapter = new CopilotAdapter();
  });

  it('runtime.statusFile has parseStatus and parseEvent', () => {
    expect(adapter.runtime.statusFile).toBeDefined();
    expect(typeof adapter.runtime.statusFile!.parseStatus).toBe('function');
    expect(typeof adapter.runtime.statusFile!.parseEvent).toBe('function');
  });

  it('runtime.statusFile.isFullRewrite is true', () => {
    expect(adapter.runtime.statusFile!.isFullRewrite).toBe(true);
  });

  it('runtime.activity is defined', () => {
    expect(adapter.runtime.activity).toBeDefined();
  });
});

// ── CopilotAdapter exit sequence ─────────────────────────────────────────────

describe('CopilotAdapter - exit sequence', () => {
  it('getExitSequence returns Ctrl+C followed by /exit', () => {
    const adapter = new CopilotAdapter();
    const sequence = adapter.getExitSequence();
    expect(sequence).toContain('\x03'); // Ctrl+C
    expect(sequence.some((s) => s.includes('/exit'))).toBe(true);
  });
});

// ── CopilotAdapter detectFirstOutput ────────────────────────────────────────

describe('CopilotAdapter - detectFirstOutput', () => {
  let adapter: CopilotAdapter;

  beforeEach(() => {
    adapter = new CopilotAdapter();
  });

  it('returns true when data contains hide-cursor escape sequence', () => {
    expect(adapter.detectFirstOutput('\x1b[?25l')).toBe(true);
  });

  it('returns false when data does not contain hide-cursor sequence', () => {
    expect(adapter.detectFirstOutput('normal output text')).toBe(false);
    expect(adapter.detectFirstOutput('')).toBe(false);
  });

  it('returns true when hide-cursor is embedded in larger output', () => {
    expect(adapter.detectFirstOutput('Welcome to Copilot\x1b[?25l more text')).toBe(true);
  });
});

// ── CopilotAdapter interpolateTemplate ──────────────────────────────────────

describe('CopilotAdapter - interpolateTemplate', () => {
  it('replaces {{key}} placeholders', () => {
    const adapter = new CopilotAdapter();
    const result = adapter.interpolateTemplate(
      'Fix {{issue}} in {{file}}',
      { issue: 'bug-123', file: 'main.ts' },
    );
    expect(result).toBe('Fix bug-123 in main.ts');
  });
});

// ── CopilotStatusParser ──────────────────────────────────────────────────────

describe('CopilotStatusParser', () => {
  describe('parseStatus', () => {
    it('returns null (format not yet empirically verified)', () => {
      // The TODO comment in status-parser.ts documents this is intentional.
      // parseStatus returns null until a real Copilot statusLine sample
      // is captured and a fixture test pins the expected shape.
      expect(CopilotStatusParser.parseStatus('{}')).toBeNull();
      expect(CopilotStatusParser.parseStatus('{"context_window":{}}')).toBeNull();
      expect(CopilotStatusParser.parseStatus('')).toBeNull();
    });
  });

  describe('parseEvent', () => {
    it('parses a valid JSONL event line', () => {
      const event = CopilotStatusParser.parseEvent(
        '{"ts":1234567890,"type":"tool_start","tool":"WriteFile"}',
      );
      expect(event).toEqual({
        ts: 1234567890,
        type: 'tool_start',
        tool: 'WriteFile',
      });
    });

    it('parses an idle event', () => {
      const event = CopilotStatusParser.parseEvent(
        '{"ts":9999,"type":"idle"}',
      );
      expect(event).toEqual({ ts: 9999, type: 'idle' });
    });

    it('returns null for malformed JSON', () => {
      expect(CopilotStatusParser.parseEvent('not json')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(CopilotStatusParser.parseEvent('')).toBeNull();
    });
  });
});

// ── agent-display-name ───────────────────────────────────────────────────────

describe('agent-display-name - copilot entry', () => {
  it('agentDisplayName returns "GitHub Copilot CLI" for "copilot"', () => {
    expect(agentDisplayName('copilot')).toBe('GitHub Copilot CLI');
  });

  it('agentShortName returns "Copilot" for "copilot"', () => {
    expect(agentShortName('copilot')).toBe('Copilot');
  });

  it('agentInstallUrl returns the GitHub Copilot CLI docs URL for "copilot"', () => {
    expect(agentInstallUrl('copilot')).toBe(
      'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    );
  });

  it('agentDisplayName falls back gracefully for unknown agents', () => {
    expect(agentDisplayName('unknown-agent')).toBe('Unknown-agent');
  });

  it('agentDisplayName returns "Agent" for null', () => {
    expect(agentDisplayName(null)).toBe('Agent');
  });
});

// ── Agent Registry ───────────────────────────────────────────────────────────

describe('Agent Registry - copilot', () => {
  it('has copilot adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('copilot')).toBe(true);
  });

  it('getOrThrow returns CopilotAdapter instance', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('copilot');
    expect(adapter.name).toBe('copilot');
    expect(adapter.sessionType).toBe('copilot_agent');
  });

  it('lists copilot among registered adapters', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('copilot');
  });
});
