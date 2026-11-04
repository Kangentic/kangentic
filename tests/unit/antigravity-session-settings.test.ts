/**
 * The per-session `--settings` file the Antigravity (agy) command builder
 * writes: which saved settings it repeats, whose settings.json it reads for an
 * agy in a WSL distro, when it is skipped, and what a failed write leaves. All
 * writes stay under os.tmpdir(); the host home is mocked per test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe('the saved guard settings in the --settings file', () => {
  // A truthiness check, or a key missing from the constant, would drop these and
  // let a user's `false` sandbox or empty rule list fall back to agy's default.
  const falsyValues: Record<(typeof AGY_SESSION_GUARD_KEYS)[number], unknown> = {
    trustedWorkspaces: [],
    permissions: {},
    toolPermission: '',
    enableTerminalSandbox: false,
    agentMode: '',
  };

  it('copies a falsy saved value of every guard key exactly', () => {
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

  it('carries enableTerminalSandbox: false', () => {
    writeSettingsAt(hostHome, { enableTerminalSandbox: false });
    setAntigravityHelpFeaturesForTests('/usr/bin/agy', FEATURES);
    build('/usr/bin/agy');
    expect(readSessionSettings().enableTerminalSandbox).toBe(false);
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
