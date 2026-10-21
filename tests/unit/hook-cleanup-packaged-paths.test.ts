/**
 * Kangentic's hooks are recognized by the bridge they run, wherever the app is
 * installed. A packaged macOS or Linux build runs its bridges from
 * `/Applications/Kangentic.app/...` or `/opt/Kangentic/...`, paths with neither
 * `.kangentic` nor `/kangentic/` in them, and a Gemini hook (and any CLI's
 * background shell hint hook) names its events path from the environment, so
 * the bridge path is the only part of the command that says the hook is ours.
 * When it went unrecognized there, `removeHooks()` left the hooks behind and a
 * main-repo spawn, which reads the settings file the last spawn wrote, added
 * another full set every time. The same holds for hooks an earlier install
 * wrote from a path the app no longer runs from (an AppImage remount, a moved
 * app), which are recognized by what the command carries, not where it points.
 *
 * `resolveBridgeScript` is mocked to answer a packaged macOS path, which the
 * checkout path this suite runs from (a source tree) can never reproduce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { PACKAGED_BUILD_DIRECTORY } = vi.hoisted(() => ({
  PACKAGED_BUILD_DIRECTORY: '/Applications/Kangentic.app/Contents/Resources/app.asar.unpacked/.vite/build',
}));

vi.mock('../../src/main/agent/shared/bridge-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/bridge-utils')>();
  return { ...actual, resolveBridgeScript: (name: string) => `${PACKAGED_BUILD_DIRECTORY}/${name}.js` };
});

import { isKangenticHookCommand, EVENTS_PATH_FROM_ENVIRONMENT } from '../../src/main/agent/shared/hook-utils';
import { GeminiCommandBuilder } from '../../src/main/agent/adapters/gemini';
import { removeHooks as removeGeminiHooks } from '../../src/main/agent/adapters/gemini/hook-manager';
import { QwenCommandBuilder } from '../../src/main/agent/adapters/qwen-code';
import { removeHooks as removeQwenHooks } from '../../src/main/agent/adapters/qwen-code/hook-manager';
import { buildBackgroundShellHintCommand } from '../../src/main/agent/shared/background-shell-hint-hook';
import { CLAUDE_BACKGROUND_SHELL_HINT_SPEC, CLAUDE_BRIDGE_SHELL } from '../../src/main/agent/adapters/claude/hook-manager';
import { buildForPlatform } from './helpers/shell-argv-probe';

/** An MCP URL that names a task session, so the session is offered the background shell hint. */
const SESSION_MCP_URL = 'http://127.0.0.1:5555/mcp/project-123/session-456';

function hookCommands(settingsPath: string): string[] {
  if (!fs.existsSync(settingsPath)) return [];
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as { hooks?: Record<string, unknown> };
  return Object.values(settings.hooks ?? {})
    .flatMap((entries) => (Array.isArray(entries) ? entries : []))
    .flatMap((entry: { hooks?: Array<{ command?: string }> }) => (entry.hooks ?? []).map((hook) => hook.command ?? ''));
}

function packagedBridgeCommands(settingsPath: string): string[] {
  return hookCommands(settingsPath).filter((command) => command.includes(PACKAGED_BUILD_DIRECTORY));
}

describe('isKangenticHookCommand on a packaged install', () => {
  it('recognizes a hook that runs this app\'s own bridge from an install path with no kangentic marker', () => {
    expect(isKangenticHookCommand(`node '${PACKAGED_BUILD_DIRECTORY}/event-bridge.js' ${EVENTS_PATH_FROM_ENVIRONMENT} tool_start`)).toBe(true);
    expect(isKangenticHookCommand(`node '${PACKAGED_BUILD_DIRECTORY}/background-shell-hint-bridge.js' eyJsYXVuY2giOnt9fQ==`)).toBe(true);
    expect(isKangenticHookCommand(`node '${PACKAGED_BUILD_DIRECTORY}/plan-approval-bridge.js' 'decision.json'`)).toBe(true);
  });

  it('does not take a same-named bridge another app ships for this app\'s own', () => {
    const otherApp = '/Applications/Other.app/Contents/Resources/app.asar.unpacked/.vite/build';
    expect(isKangenticHookCommand(`node '${otherApp}/event-bridge.js' '/tmp/other-events.jsonl' tool_start`)).toBe(false);
    // A hint spec that does not name Kangentic's MCP tool (`e30=` is `{}`).
    expect(isKangenticHookCommand(`node '${otherApp}/background-shell-hint-bridge.js' e30=`)).toBe(false);
  });

  it('recognizes hooks an earlier install wrote from a path this one no longer runs from', () => {
    // An AppImage mounts at a new /tmp/.mount_* path on every launch, and a user can move the
    // app. What such a hook still carries: the events path named through Kangentic's own
    // variable, or a hint spec that names Kangentic's MCP tool.
    const earlierInstall = '/tmp/.mount_KangenAbC123/resources/app.asar.unpacked/.vite/build';
    expect(isKangenticHookCommand(`node '${earlierInstall}/event-bridge.js' ${EVENTS_PATH_FROM_ENVIRONMENT} tool_start`)).toBe(true);
    const hintCommand = buildBackgroundShellHintCommand(
      CLAUDE_BRIDGE_SHELL,
      `${earlierInstall}/background-shell-hint-bridge.js`,
      CLAUDE_BACKGROUND_SHELL_HINT_SPEC,
    );
    expect(isKangenticHookCommand(hintCommand)).toBe(true);
  });
});

describe('main-repo spawns on a packaged install keep one set of Kangentic hooks', () => {
  let projectDirectory: string;

  beforeEach(() => {
    projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-packaged-hooks-'));
  });

  afterEach(() => {
    fs.rmSync(projectDirectory, { recursive: true, force: true });
  });

  it('Gemini: a second spawn in the same folder writes no second set, and removeHooks strips them all', () => {
    const settingsPath = path.join(projectDirectory, '.gemini', 'settings.json');
    const builder = new GeminiCommandBuilder();
    const options = {
      geminiPath: '/usr/local/bin/gemini',
      taskId: 'task-1',
      cwd: projectDirectory,
      projectRoot: projectDirectory,
      permissionMode: 'default' as const,
      eventsOutputPath: path.join(projectDirectory, '.kangentic', 'sessions', 's1', 'events.jsonl'),
      mcpServerEnabled: true,
      mcpServerUrl: SESSION_MCP_URL,
      mcpServerToken: 'token-1',
    };

    buildForPlatform('darwin', () => builder.buildGeminiCommand(options));
    const firstCount = packagedBridgeCommands(settingsPath).length;
    expect(firstCount).toBeGreaterThan(0);

    buildForPlatform('darwin', () => builder.buildGeminiCommand(options));
    expect(packagedBridgeCommands(settingsPath)).toHaveLength(firstCount);

    removeGeminiHooks(projectDirectory);
    expect(packagedBridgeCommands(settingsPath)).toEqual([]);
  });

  it('Gemini: hooks an earlier install wrote from another path are replaced, not kept beside the new set', () => {
    const settingsPath = path.join(projectDirectory, '.gemini', 'settings.json');
    const earlierInstall = '/tmp/.mount_KangenAbC123/resources/app.asar.unpacked/.vite/build';
    const builder = new GeminiCommandBuilder();
    const options = {
      geminiPath: '/usr/local/bin/gemini',
      taskId: 'task-1',
      cwd: projectDirectory,
      projectRoot: projectDirectory,
      permissionMode: 'default' as const,
      eventsOutputPath: path.join(projectDirectory, '.kangentic', 'sessions', 's1', 'events.jsonl'),
      mcpServerEnabled: true,
      mcpServerUrl: SESSION_MCP_URL,
      mcpServerToken: 'token-1',
    };
    buildForPlatform('darwin', () => builder.buildGeminiCommand(options));
    const hookCount = packagedBridgeCommands(settingsPath).length;
    // The same hooks as an install at another path (the last launch's AppImage mount) wrote them.
    fs.writeFileSync(settingsPath, fs.readFileSync(settingsPath, 'utf-8').replaceAll(PACKAGED_BUILD_DIRECTORY, earlierInstall));
    const earlierInstallCommands = () => hookCommands(settingsPath).filter((command) => command.includes(earlierInstall));
    expect(earlierInstallCommands()).toHaveLength(hookCount);

    buildForPlatform('darwin', () => builder.buildGeminiCommand(options));

    expect(earlierInstallCommands()).toEqual([]);
    expect(packagedBridgeCommands(settingsPath)).toHaveLength(hookCount);
  });

  it('Qwen: the background shell hint is written once across spawns, and removeHooks strips it', () => {
    const settingsPath = path.join(projectDirectory, '.qwen', 'settings.json');
    const builder = new QwenCommandBuilder();
    const options = {
      qwenPath: '/usr/local/bin/qwen',
      taskId: 'task-1',
      cwd: projectDirectory,
      projectRoot: projectDirectory,
      permissionMode: 'default' as const,
      statusOutputPath: path.join(projectDirectory, '.kangentic', 'sessions', 's1', 'status.json'),
      eventsOutputPath: path.join(projectDirectory, '.kangentic', 'sessions', 's1', 'events.jsonl'),
      mcpServerEnabled: true,
      mcpServerUrl: SESSION_MCP_URL,
      mcpServerToken: 'token-1',
    };

    buildForPlatform('darwin', () => builder.buildQwenCommand(options));
    const hintCommands = () => packagedBridgeCommands(settingsPath).filter((command) => command.includes('background-shell-hint-bridge'));
    expect(hintCommands()).toHaveLength(1);

    buildForPlatform('darwin', () => builder.buildQwenCommand(options));
    expect(hintCommands()).toHaveLength(1);

    removeQwenHooks(projectDirectory);
    expect(packagedBridgeCommands(settingsPath)).toEqual([]);
  });
});
