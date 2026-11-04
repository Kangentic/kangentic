/**
 * The per-session `--settings` file the Antigravity (agy) command builder
 * writes: which saved settings it repeats, whose settings.json it reads for an
 * agy in a WSL distro, when it is skipped, and what a failed write leaves. All
 * writes stay under os.tmpdir(); the host home is mocked per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type TestContext } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let hostHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => hostHome },
    homedir: () => hostHome,
  };
});

import {
  AntigravityCommandBuilder,
  AGY_SESSION_GUARD_KEYS,
  AGY_SESSION_SETTINGS_FILE,
} from '../../src/main/agent/adapters/antigravity/command-builder';
import { resetAntigravityCapabilityCacheForTests, setAntigravityHelpFeaturesForTests } from '../../src/main/agent/adapters/antigravity/capability-discovery';
import { cliPathForTarget, type CliTarget } from '../../src/main/agent/shared/cli-target';
import { wslHookPaths, wslStatusLineCommand } from '../../src/main/agent/shared/wsl-hook-transport';
import { resolveBridgeScript } from '../../src/main/agent/shared/bridge-utils';
import { isBareShellToken } from '../../src/shared/shell-quote';
import { toForwardSlash } from '../../src/shared/paths';

const FEATURES = { sessionSettings: true, modes: ['accept-edits', 'auto', 'plan'] };

let scratch: string;
let workspace: string;
let sessionDirectory: string;
let statusOutputPath: string;
const builder = new AntigravityCommandBuilder();

function writeSettingsAt(dataHome: string, contents: Record<string, unknown>): void {
  const file = path.join(dataHome, '.gemini', 'antigravity-cli', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(contents));
}

function readSessionSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(sessionDirectory, AGY_SESSION_SETTINGS_FILE), 'utf-8')) as Record<string, unknown>;
}

function wslTarget(distroHome: string): CliTarget {
  return {
    kind: 'wsl', distro: 'Ubuntu', linuxCliPath: '/home/dev/.local/bin/agy',
    facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome, uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' },
  };
}

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-session-settings-'));
  hostHome = path.join(scratch, 'host-home');
  workspace = path.join(scratch, 'workspace');
  sessionDirectory = path.join(workspace, '.kangentic', 'sessions', 's1');
  statusOutputPath = path.join(sessionDirectory, 'status.json');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(hostHome, { recursive: true });
});

afterEach(() => {
  resetAntigravityCapabilityCacheForTests();
  vi.restoreAllMocks();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function build(agyPath: string): string {
  return builder.buildAntigravityCommand({ agyPath, taskId: 't1', cwd: workspace, permissionMode: 'default', shell: 'bash', statusOutputPath });
}

/**
 * On Windows every status-line token stays bare, so a temp folder or bridge
 * path a bare token cannot carry writes no file (antigravity-adapter.test.ts
 * pins that). A case that reads the file skips there.
 */
function skipWithoutBarePaths(context: TestContext): void {
  if (process.platform === 'win32'
    && !(isBareShellToken(toForwardSlash(sessionDirectory)) && isBareShellToken(toForwardSlash(resolveBridgeScript('status-bridge'))))) {
    context.skip();
  }
}

describe('the saved guard settings in the --settings file', () => {
  // Whether agy merges a --settings file over the saved settings.json or
  // replaces it is undocumented. Replaced, a statusLine-only file would drop
  // the saved trust (every spawn would stop at the folder trust prompt) and the
  // user's permission rules, so the file repeats those keys and nothing else.
  it('repeats the saved trust and guard settings, and never copies other keys', (context) => {
    skipWithoutBarePaths(context);
    writeSettingsAt(hostHome, {
      trustedWorkspaces: [workspace],
      permissions: { deny: ['command(rm -rf)'] },
      toolPermission: 'strict',
      agentMode: 'plan',
      customModels: [{ name: 'my-model', apiKey: 'secret-key' }],
    });
    setAntigravityHelpFeaturesForTests('/usr/bin/agy', FEATURES);
    expect(build('/usr/bin/agy')).toContain('--settings');
    const sessionSettings = readSessionSettings();
    expect(Object.keys(sessionSettings).sort()).toEqual(['agentMode', 'permissions', 'statusLine', 'toolPermission', 'trustedWorkspaces']);
    expect(sessionSettings.trustedWorkspaces).toEqual([workspace]);
    expect(sessionSettings.permissions).toEqual({ deny: ['command(rm -rf)'] });
    expect(JSON.stringify(sessionSettings)).not.toContain('secret-key');
  });

  it('holds only the status line when there are no saved settings', (context) => {
    skipWithoutBarePaths(context);
    setAntigravityHelpFeaturesForTests('/usr/bin/agy', FEATURES);
    build('/usr/bin/agy');
    expect(Object.keys(readSessionSettings())).toEqual(['statusLine']);
  });

  // A throw here would be caught by writeSessionSettings and drop the session's
  // live telemetry, so a bad saved file must still yield the status-line file.
  it('holds only the status line when the saved settings.json is not JSON', (context) => {
    skipWithoutBarePaths(context);
    const settingsFile = path.join(hostHome, '.gemini', 'antigravity-cli', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, 'not json');
    setAntigravityHelpFeaturesForTests('/usr/bin/agy', FEATURES);
    build('/usr/bin/agy');
    expect(Object.keys(readSessionSettings())).toEqual(['statusLine']);
  });

  // A truthiness check, or a key missing from the constant, would drop these and
  // let a user's `false` sandbox or empty rule list fall back to agy's default.
  const falsyValues: Record<(typeof AGY_SESSION_GUARD_KEYS)[number], unknown> = {
    trustedWorkspaces: [],
    permissions: {},
    toolPermission: '',
    enableTerminalSandbox: false,
    agentMode: '',
  };

  it('copies a falsy saved value of every guard key exactly', (context) => {
    skipWithoutBarePaths(context);
    expect(Object.keys(falsyValues).sort()).toEqual([...AGY_SESSION_GUARD_KEYS].sort());
    writeSettingsAt(hostHome, falsyValues);
    setAntigravityHelpFeaturesForTests('/usr/bin/agy', FEATURES);
    expect(build('/usr/bin/agy')).toContain('--settings');
    const sessionSettings = readSessionSettings();
    for (const key of AGY_SESSION_GUARD_KEYS) {
      expect(sessionSettings, key).toHaveProperty(key);
      expect(sessionSettings[key], key).toEqual(falsyValues[key]);
    }
  });

  it('for an agy in a WSL distro reads the distro\'s settings.json, not the host\'s', () => {
    const distroHome = path.join(scratch, 'distro-home');
    writeSettingsAt(hostHome, { trustedWorkspaces: ['/host/only'], permissions: { deny: ['host-rule'] } });
    writeSettingsAt(distroHome, { trustedWorkspaces: ['/distro/only'], permissions: { deny: ['distro-rule'] } });
    const agyPath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\agy';
    setAntigravityHelpFeaturesForTests(agyPath, FEATURES);
    builder.buildAntigravityCommand({
      agyPath, taskId: 't1', cwd: workspace, permissionMode: 'default', shell: 'wsl -d Ubuntu',
      statusOutputPath, cliTarget: wslTarget(distroHome),
    });
    const sessionSettings = readSessionSettings();
    expect(sessionSettings.trustedWorkspaces).toEqual(['/distro/only']);
    expect(sessionSettings.permissions).toEqual({ deny: ['distro-rule'] });
    expect(JSON.stringify(sessionSettings)).not.toContain('host-rule');
    expect(JSON.stringify(sessionSettings)).not.toContain('/host/only');
  });
});

describe('when no --settings file is written', () => {
  it('skips it for a CLI whose --help was never read, and warns once per CLI path', () => {
    const agyPath = '/opt/undiscovered-agy-for-session-settings-test/agy';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    resetAntigravityCapabilityCacheForTests();
    const first = build(agyPath);
    const second = build(agyPath);
    expect(first).not.toContain('--settings');
    expect(second).not.toContain('--settings');
    expect(fs.existsSync(path.join(sessionDirectory, AGY_SESSION_SETTINGS_FILE))).toBe(false);
    const undiscoveredWarnings = warn.mock.calls.filter((call) => String(call[0]).includes(agyPath));
    expect(undiscoveredWarnings).toHaveLength(1);
  });

  it('skips it, and does not throw, when the session directory path is a regular file', () => {
    fs.mkdirSync(path.dirname(sessionDirectory), { recursive: true });
    fs.writeFileSync(sessionDirectory, 'not a directory');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setAntigravityHelpFeaturesForTests('/usr/bin/agy', FEATURES);
    let command = '';
    expect(() => { command = build('/usr/bin/agy'); }).not.toThrow();
    expect(command).not.toContain('--settings');
  });
});

describe('an agy in a WSL distro with a status file and no events file', () => {
  it('still writes the --settings file, its transport prepared beside the status file', () => {
    const distroHome = path.join(scratch, 'distro-home');
    const target = wslTarget(distroHome);
    const agyPath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\bin\\agy';
    setAntigravityHelpFeaturesForTests(agyPath, FEATURES);
    const command = builder.buildAntigravityCommand({
      agyPath, taskId: 't1', cwd: workspace, permissionMode: 'default', shell: 'wsl -d Ubuntu',
      statusOutputPath, cliTarget: target,
    });
    const settingsPath = path.join(sessionDirectory, AGY_SESSION_SETTINGS_FILE);
    expect(command).toContain(cliPathForTarget(settingsPath, target));
    const statusLine = (readSessionSettings().statusLine as { command: string });
    expect(statusLine.command).toBe(wslStatusLineCommand(wslHookPaths(sessionDirectory), target, statusOutputPath));
    expect(fs.existsSync(wslHookPaths(sessionDirectory).script)).toBe(true);
  });
});
