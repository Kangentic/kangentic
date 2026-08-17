/**
 * Unit tests for DroidAdapter -- command building (new + resume),
 * permission-mode no-op behaviour, session id capture, runtime
 * strategy wiring, and CLI lifecycle helpers (first-output detection,
 * exit sequence, hook removal).
 *
 * Empirical contract is locked in by scripts/probe-droid.js, which
 * runs the real `droid` binary and asserts the same shape this
 * adapter emits.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { DroidDetector } from '../../src/main/agent/adapters/droid/detector';
import {
  cwdToSessionSlug,
  captureSessionIdFromFilesystem,
  locateSessionFile,
} from '../../src/main/agent/adapters/droid/session-id-capture';
import {
  agentDisplayName,
  agentShortName,
  agentInstallUrl,
} from '../../src/renderer/utils/agent-display-name';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { PermissionMode } from '../../src/shared/types';

function makeOptions(overrides: Partial<SpawnCommandOptions> = {}): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/droid',
    taskId: 'task-001',
    cwd: '/home/dev/project',
    permissionMode: 'default',
    projectRoot: '/home/dev/project',
    ...overrides,
  };
}

describe('Droid Adapter', () => {
  let adapter: DroidAdapter;
  let tempDir: string;

  beforeEach(() => {
    adapter = new DroidAdapter();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-droid-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('adapter identity', () => {
    it('has correct name, displayName, and sessionType', () => {
      expect(adapter.name).toBe('droid');
      expect(adapter.displayName).toBe('Droid');
      expect(adapter.sessionType).toBe('droid_agent');
    });

    it('does not accept caller-specified session ids (Droid generates them)', () => {
      expect(adapter.supportsCallerSessionId).toBe(false);
    });

    it('exposes a permissions list with a default mode', () => {
      expect(adapter.permissions.length).toBeGreaterThan(0);
      expect(adapter.permissions.some((entry) => entry.mode === adapter.defaultPermission)).toBe(true);
    });
  });

  describe('buildCommand - new session', () => {
    it('emits `droid --cwd <cwd> "<prompt>"` with no Kangentic-side overrides', () => {
      const command = adapter.buildCommand(makeOptions({
        cwd: tempDir,
        projectRoot: tempDir,
        prompt: 'fix the bug',
      }));
      expect(command).toContain('/usr/bin/droid');
      expect(command).toContain('--cwd');
      expect(command).toContain('fix the bug');
      expect(command).not.toContain('--resume');
      // Adapter intentionally does not shadow Droid's native TUI controls:
      // no exec-only flags, no per-task --settings file, no model pin.
      expect(command).not.toContain('--auto');
      expect(command).not.toContain('-m ');
      expect(command).not.toContain('--model');
      expect(command).not.toContain('--settings');
    });

    it('does not write any per-task settings file under <projectRoot>/.kangentic/', () => {
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        projectRoot: tempDir,
        taskId: 'task-xyz',
        prompt: 'go',
      }));
      const settingsFile = path.join(tempDir, '.kangentic', 'sessions', 'task-xyz', 'droid-settings.json');
      expect(fs.existsSync(settingsFile)).toBe(false);
    });
  });

  describe('buildCommand - resume session', () => {
    it('appends --resume <uuid> for a resume spawn', () => {
      const command = adapter.buildCommand(makeOptions({
        cwd: tempDir,
        projectRoot: tempDir,
        resume: true,
        sessionId: 'c3470f37-a5c0-49f7-9115-1964d0dcf7f4',
        prompt: 'continue',
      }));
      expect(command).toContain('--resume');
      expect(command).toContain('c3470f37-a5c0-49f7-9115-1964d0dcf7f4');
      expect(command).toContain('continue');
    });

    it('does NOT use the exec-only -s flag', () => {
      const command = adapter.buildCommand(makeOptions({
        cwd: tempDir,
        projectRoot: tempDir,
        resume: true,
        sessionId: 'abc',
        prompt: 'continue',
      }));
      expect(command).not.toMatch(/(^|\s)-s\s/);
      expect(command).not.toContain('--session-id');
    });
  });

  describe('buildCommand - permission mode is ignored (Droid TUI handles it)', () => {
    // Droid's TUI exposes shift+tab to cycle autonomy modes. The
    // adapter does not translate Kangentic's PermissionMode into any
    // flag or settings override -- the user owns autonomy in the TUI.
    const cases: PermissionMode[] = ['plan', 'default', 'acceptEdits', 'bypassPermissions'];
    for (const mode of cases) {
      it(`'${mode}' produces the same bare command as default`, () => {
        const command = adapter.buildCommand(makeOptions({
          cwd: tempDir,
          projectRoot: tempDir,
          permissionMode: mode,
          prompt: 'go',
        }));
        expect(command).not.toContain('--auto');
        expect(command).not.toContain('--skip-permissions-unsafe');
        expect(command).not.toContain('--settings');
      });
    }

    it('exposes a single "Default" permission entry in the adapter', () => {
      expect(adapter.permissions.length).toBe(1);
      expect(adapter.permissions[0].mode).toBe('default');
    });
  });

  describe('buildCommand - shell-aware quoting', () => {
    it('replaces double quotes in prompt for PowerShell', () => {
      const command = adapter.buildCommand(makeOptions({
        cwd: tempDir,
        projectRoot: tempDir,
        prompt: 'fix the "bug" here',
        shell: 'powershell',
      }));
      expect(command).not.toContain('"bug"');
      expect(command).toContain("'bug'");
    });

    it('preserves double quotes in prompt for bash', () => {
      const command = adapter.buildCommand(makeOptions({
        cwd: tempDir,
        projectRoot: tempDir,
        prompt: 'fix the "bug" here',
        shell: 'bash',
      }));
      expect(command).toContain('"bug"');
    });
  });

  describe('runtime strategy', () => {
    it('uses PTY-only activity detection (no hooks in v1)', () => {
      expect(adapter.runtime.activity.kind).toBe('pty');
    });

    it('exposes fromFilesystem session id capture (no fromHook)', () => {
      expect(adapter.runtime.sessionId).toBeDefined();
      expect(adapter.runtime.sessionId!.fromFilesystem).toBeTypeOf('function');
      expect(adapter.runtime.sessionId!.fromHook).toBeUndefined();
    });

    it('omits statusFile (no events.jsonl pipeline today)', () => {
      expect(adapter.runtime.statusFile).toBeUndefined();
    });
  });

  describe('detectFirstOutput', () => {
    it('returns true on cursor-hide ANSI sequence', () => {
      expect(adapter.detectFirstOutput('\x1b[?25l')).toBe(true);
      expect(adapter.detectFirstOutput('prefix\x1b[?25lsuffix')).toBe(true);
    });

    it('returns false on plain text', () => {
      expect(adapter.detectFirstOutput('hello world')).toBe(false);
      expect(adapter.detectFirstOutput('')).toBe(false);
    });
  });

  describe('exit sequence', () => {
    it('emits Ctrl+C followed by /quit', () => {
      const sequence = adapter.getExitSequence();
      expect(sequence).toEqual(['\x03', '/quit\r']);
    });
  });

  describe('removeHooks / clearSettingsCache / ensureTrust', () => {
    it('all run without throwing on a directory with no Kangentic config', async () => {
      expect(() => adapter.removeHooks(tempDir)).not.toThrow();
      expect(() => adapter.removeHooks(tempDir, 'task-x')).not.toThrow();
      expect(() => adapter.clearSettingsCache()).not.toThrow();
      await expect(adapter.ensureTrust(tempDir)).resolves.toBeUndefined();
    });
  });

  describe('Kangentic MCP wiring', () => {
    const URL = 'http://127.0.0.1:5555/mcp/project-123/sess-xyz';
    const TOKEN = 'secret-token';

    const configPath = () => path.join(tempDir, '.factory', 'mcp.json');
    const readConfig = () => JSON.parse(fs.readFileSync(configPath(), 'utf-8'));

    const build = (overrides: Partial<SpawnCommandOptions> = {}) =>
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        mcpServerEnabled: true,
        mcpServerUrl: URL,
        mcpServerToken: TOKEN,
        ...overrides,
      }));

    it('writes a project-scoped .factory/mcp.json http entry', () => {
      // Verified against droid 0.189.0: `droid mcp list` in a directory
      // carrying this file reports "kangentic http connected [project]".
      build();
      expect(readConfig().mcpServers.kangentic).toEqual({
        type: 'http',
        url: URL,
        headers: { 'X-Kangentic-Token': '${KANGENTIC_MCP_TOKEN}' },
      });
    });

    it('references the token by env var and never writes its value', () => {
      // .factory/mcp.json lives inside the user's repo, so the secret must
      // not land there. Droid expands ${NAME} at connect time and never
      // rewrites the file with the expanded value.
      build();
      expect(fs.readFileSync(configPath(), 'utf-8')).not.toContain(TOKEN);
      expect(adapter.buildEnv(makeOptions({
        cwd: tempDir,
        mcpServerEnabled: true,
        mcpServerUrl: URL,
        mcpServerToken: TOKEN,
      }))).toEqual({ KANGENTIC_MCP_TOKEN: TOKEN });
    });

    it('keeps the token out of the command line too', () => {
      expect(build()).not.toContain(TOKEN);
    });

    it('preserves user-defined servers and restores them on cleanup', () => {
      fs.mkdirSync(path.join(tempDir, '.factory'), { recursive: true });
      fs.writeFileSync(
        configPath(),
        JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'http://example.test/mcp' } } }),
      );
      build();
      expect(readConfig().mcpServers.linear).toBeDefined();

      adapter.removeHooks(tempDir);
      expect(readConfig().mcpServers).toEqual({
        linear: { type: 'http', url: 'http://example.test/mcp' },
      });
    });

    it('removes the file entirely when only our entry was in it', () => {
      build();
      adapter.removeHooks(tempDir);
      expect(fs.existsSync(configPath())).toBe(false);
    });

    it('keeps the config alive until the last task in the same cwd releases', () => {
      // .factory/mcp.json is project-shared. A project with no worktree
      // configured runs every task in the project root, so an exiting task
      // must not strip the entry out from under a running sibling.
      build({ taskId: 'task-a' });
      build({ taskId: 'task-b' });

      adapter.removeHooks(tempDir, 'task-a');
      expect(fs.existsSync(configPath())).toBe(true);

      adapter.removeHooks(tempDir, 'task-b');
      expect(fs.existsSync(configPath())).toBe(false);
    });

    it('is idempotent when the same task releases twice', () => {
      // session-manager calls removeHooks explicitly in suspend() and again
      // from the PTY onExit handler.
      build({ taskId: 'task-a' });
      adapter.removeHooks(tempDir, 'task-a');
      expect(() => adapter.removeHooks(tempDir, 'task-a')).not.toThrow();
      expect(fs.existsSync(configPath())).toBe(false);
    });

    it('writes nothing when disabled or incompletely configured', () => {
      for (const overrides of [
        { mcpServerEnabled: false },
        { mcpServerUrl: undefined },
        { mcpServerToken: undefined },
      ]) {
        build(overrides);
        expect(fs.existsSync(configPath())).toBe(false);
      }
    });

    it('buildEnv returns null when disabled or incompletely configured', () => {
      for (const overrides of [
        { mcpServerEnabled: false },
        { mcpServerUrl: undefined },
        { mcpServerToken: undefined },
      ]) {
        expect(adapter.buildEnv(makeOptions({
          cwd: tempDir,
          mcpServerEnabled: true,
          mcpServerUrl: URL,
          mcpServerToken: TOKEN,
          ...overrides,
        }))).toBeNull();
      }
    });
  });

  describe('git-exclude seeding', () => {
    const excludePath = () => path.join(tempDir, '.git', 'info', 'exclude');

    const build = (overrides: Partial<SpawnCommandOptions> = {}) =>
      adapter.buildCommand(makeOptions({
        cwd: tempDir,
        mcpServerEnabled: true,
        mcpServerUrl: 'http://127.0.0.1:5555/mcp/project-123/sess-xyz',
        mcpServerToken: 'secret-token',
        ...overrides,
      }));

    beforeEach(() => {
      fs.mkdirSync(path.join(tempDir, '.git'), { recursive: true });
    });

    it('seeds .factory/mcp.json and .kangentic/ when Kangentic creates the file', () => {
      build();
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).toContain('.factory/mcp.json');
      expect(content).toContain('.kangentic/');
    });

    it('never excludes a pre-existing user mcp.json (created-by-us carve-out)', () => {
      // Also pins the seed-BEFORE-write ordering: after the build the merged
      // file always exists, so a post-write existence check could never
      // distinguish the user's file from ours.
      fs.mkdirSync(path.join(tempDir, '.factory'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.factory', 'mcp.json'),
        JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'http://example.test/mcp' } } }),
      );
      build();
      const content = fs.readFileSync(excludePath(), 'utf-8');
      expect(content).not.toContain('.factory/mcp.json');
      expect(content).toContain('.kangentic/');
    });

    it('seeds nothing when MCP wiring is disabled', () => {
      build({ mcpServerEnabled: false });
      expect(fs.existsSync(excludePath())).toBe(false);
    });
  });

  describe('interpolateTemplate', () => {
    it('replaces {{key}} placeholders', () => {
      const result = adapter.interpolateTemplate(
        'Fix {{issue}} in {{file}}',
        { issue: 'bug-123', file: 'main.ts' },
      );
      expect(result).toBe('Fix bug-123 in main.ts');
    });
  });
});

describe('Droid session-id capture', () => {
  describe('cwdToSessionSlug', () => {
    it('replaces Windows drive colon and backslashes with dashes', () => {
      const slug = cwdToSessionSlug('C:\\Users\\dev\\project');
      expect(slug).toBe('-C-Users-dev-project');
    });

    it('produces a leading-dash slug for POSIX absolute paths', () => {
      const slug = cwdToSessionSlug('/home/dev/project');
      expect(slug).toBe('-home-dev-project');
    });

    it('matches the empirical Droid 0.109 layout for nested temp paths', () => {
      // Empirically confirmed via probe-droid.js:
      //   `~/.factory/sessions/-C-Users-dev-AppData-Local-Temp-...-project-c/`
      const slug = cwdToSessionSlug('C:\\Users\\dev\\AppData\\Local\\Temp\\foo\\project-c');
      expect(slug).toBe('-C-Users-dev-AppData-Local-Temp-foo-project-c');
    });
  });

  describe('captureSessionIdFromFilesystem', () => {
    let fakeHome: string;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-droid-fakehome-'));
      // Redirect os.homedir() so the capture helper looks under
      // <fakeHome>/.factory/sessions/ instead of the user's real
      // home dir. vi.spyOn keeps the typed surface intact and
      // restores cleanly via vi.restoreAllMocks().
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    });

    it('captures the UUID from a fresh <uuid>.jsonl in the cwd-keyed dir', async () => {
      const cwd = path.join(os.tmpdir(), 'project-alpha');
      const slugDir = path.join(fakeHome, '.factory', 'sessions', cwdToSessionSlug(cwd));
      fs.mkdirSync(slugDir, { recursive: true });
      const uuid = 'aaaa1111-bbbb-cccc-dddd-eeeeeeeeeeee';
      fs.writeFileSync(path.join(slugDir, `${uuid}.jsonl`), '{"type":"session_start"}\n');

      const captured = await captureSessionIdFromFilesystem({
        spawnedAt: new Date(Date.now() - 1000),
        cwd,
        maxAttempts: 2,
      });
      expect(captured).toBe(uuid);
    });

    it('ignores sidecar files like <uuid>.settings.json', async () => {
      const cwd = path.join(os.tmpdir(), 'project-beta');
      const slugDir = path.join(fakeHome, '.factory', 'sessions', cwdToSessionSlug(cwd));
      fs.mkdirSync(slugDir, { recursive: true });
      const uuid = 'bbbb2222-bbbb-cccc-dddd-eeeeeeeeeeee';
      fs.writeFileSync(path.join(slugDir, `${uuid}.jsonl`), '{}\n');
      fs.writeFileSync(path.join(slugDir, `${uuid}.settings.json`), '{}');
      // A non-UUID file should also be ignored.
      fs.writeFileSync(path.join(slugDir, 'README.md'), 'noise');

      const captured = await captureSessionIdFromFilesystem({
        spawnedAt: new Date(Date.now() - 1000),
        cwd,
        maxAttempts: 2,
      });
      expect(captured).toBe(uuid);
    });

    it('returns null when no candidate file exists in time', async () => {
      const cwd = path.join(os.tmpdir(), 'project-empty');
      const captured = await captureSessionIdFromFilesystem({
        spawnedAt: new Date(),
        cwd,
        maxAttempts: 2,
      });
      expect(captured).toBeNull();
    });

    it('rejects files older than (spawnedAt - 30s)', async () => {
      const cwd = path.join(os.tmpdir(), 'project-stale');
      const slugDir = path.join(fakeHome, '.factory', 'sessions', cwdToSessionSlug(cwd));
      fs.mkdirSync(slugDir, { recursive: true });
      const uuid = 'cccc3333-bbbb-cccc-dddd-eeeeeeeeeeee';
      const filePath = path.join(slugDir, `${uuid}.jsonl`);
      fs.writeFileSync(filePath, '{}');
      const past = new Date(Date.now() - 5 * 60_000);
      fs.utimesSync(filePath, past, past);

      const captured = await captureSessionIdFromFilesystem({
        spawnedAt: new Date(),
        cwd,
        maxAttempts: 1,
      });
      expect(captured).toBeNull();
    });
  });

  describe('locateSessionFile', () => {
    let fakeHome: string;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-droid-locate-home-'));
      vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    });

    it('returns the absolute path when <uuid>.jsonl exists in the cwd-keyed dir', async () => {
      const cwd = path.join(os.tmpdir(), 'project-locate');
      const slugDir = path.join(fakeHome, '.factory', 'sessions', cwdToSessionSlug(cwd));
      fs.mkdirSync(slugDir, { recursive: true });
      const uuid = 'dddd4444-bbbb-cccc-dddd-eeeeeeeeeeee';
      const expected = path.join(slugDir, `${uuid}.jsonl`);
      fs.writeFileSync(expected, '{}');

      const located = await locateSessionFile({ agentSessionId: uuid, cwd, maxAttempts: 1 });
      expect(located).toBe(expected);
    });

    it('returns null when the file never appears within the polling budget', async () => {
      const cwd = path.join(os.tmpdir(), 'project-missing');
      const located = await locateSessionFile({
        agentSessionId: 'eeee5555-bbbb-cccc-dddd-eeeeeeeeeeee',
        cwd,
        maxAttempts: 1,
      });
      expect(located).toBeNull();
    });
  });
});

// ── DroidDetector.parseVersion ───────────────────────────────────────────────
//
// DroidDetector passes a parseVersion callback to AgentDetector that strips
// the optional "droid " product prefix from raw --version output. The lambda
// is inline in the constructor but its behaviour is the contract we lock in
// here. We test it via the exported DroidDetector class's internal config,
// accessed by casting to the known private field shape, rather than reaching
// for module-level vi.mock (which warns when called inside it() blocks).
//
// The cast approach is a deliberate tradeoff: it couples the test to the
// private field name, but that field is stable across all AgentDetector
// subclasses (it's always `config.parseVersion`). The alternative of mocking
// `execVersion` at the module level would pull in 3 extra describe blocks
// with hoisted mocks that affect other tests in the file.

type DetectorPrivate = {
  config: {
    parseVersion(raw: string): string | null;
  };
};

describe('DroidDetector - parseVersion', () => {
  let parseVersion: (raw: string) => string | null;

  beforeEach(() => {
    const detector = new DroidDetector();
    parseVersion = (detector as unknown as DetectorPrivate).config.parseVersion;
  });

  it('strips the "droid " prefix from "droid 1.2.3"', () => {
    expect(parseVersion('droid 1.2.3')).toBe('1.2.3');
  });

  it('strips prefix case-insensitively ("Droid 0.109.1")', () => {
    expect(parseVersion('Droid 0.109.1')).toBe('0.109.1');
  });

  it('passes a bare semver "1.2.3" through unchanged', () => {
    expect(parseVersion('1.2.3')).toBe('1.2.3');
  });

  it('returns null for an empty string', () => {
    expect(parseVersion('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(parseVersion('   ')).toBeNull();
  });
});

// ── Agent Registry - droid ───────────────────────────────────────────────────

describe('Agent Registry - droid', () => {
  it('has droid adapter registered', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.has('droid')).toBe(true);
  });

  it('getOrThrow returns a DroidAdapter instance with correct name and sessionType', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getOrThrow('droid');
    expect(adapter.name).toBe('droid');
    expect(adapter.sessionType).toBe('droid_agent');
  });

  it('getBySessionType("droid_agent") resolves to the droid adapter', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    const adapter = agentRegistry.getBySessionType('droid_agent');
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe('droid');
  });

  it('list() contains "droid"', async () => {
    const { agentRegistry } = await import('../../src/main/agent/agent-registry');
    expect(agentRegistry.list()).toContain('droid');
  });
});

// ── liveTelemetryUnsupported capability ─────────────────────────────────────
//
// Droid 0.109.x has no per-session telemetry channel Kangentic can subscribe
// to. The adapter declares a static `liveTelemetryUnsupported` affordance so
// ContextBar can render a static pill instead of an indefinite spinner.
// These assertions lock in: (a) the field is defined, (b) the label is a
// non-empty string, (c) the tooltip title contains the "Droid" product-name
// marker so an accidental field-clear is caught.

describe('DroidAdapter - liveTelemetryUnsupported', () => {
  it('is defined on the adapter instance', () => {
    const adapter = new DroidAdapter();
    expect(adapter.liveTelemetryUnsupported).toBeDefined();
  });

  it('unavailableLabel is a non-empty string', () => {
    const adapter = new DroidAdapter();
    const label = adapter.liveTelemetryUnsupported?.unavailableLabel;
    expect(typeof label).toBe('string');
    expect(label!.length).toBeGreaterThan(0);
  });

  it('unavailableTitle contains "Droid" so an empty-field refactor is caught', () => {
    const adapter = new DroidAdapter();
    const title = adapter.liveTelemetryUnsupported?.unavailableTitle;
    expect(typeof title).toBe('string');
    expect(title).toContain('Droid');
  });
});

// ── agent-display-name - droid entry ────────────────────────────────────────

describe('agent-display-name - droid entry', () => {
  it('agentDisplayName returns "Droid" for "droid"', () => {
    expect(agentDisplayName('droid')).toBe('Droid');
  });

  it('agentShortName returns "Droid" for "droid"', () => {
    expect(agentShortName('droid')).toBe('Droid');
  });

  it('agentInstallUrl returns the Factory docs URL for "droid"', () => {
    expect(agentInstallUrl('droid')).toBe('https://docs.factory.ai/cli/getting-started/overview');
  });
});
