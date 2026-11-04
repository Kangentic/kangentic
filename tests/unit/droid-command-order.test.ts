/**
 * The order of Droid's launch flags on a resume, and the hook settings
 * `buildDroidHookSettings` writes with and without options.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { buildDroidHookSettings, DROID_HOOK_SHELL } from '../../src/main/agent/adapters/droid/hook-manager';
import { buildBridgeCommand } from '../../src/main/agent/shared/hook-utils';
import { EventType } from '../../src/shared/types';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('Droid resume command order', () => {
  it('puts --settings, --auto, --append-system-prompt and --resume in that order, prompt last', () => {
    const sessionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-droid-order-session-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-droid-order-cwd-'));
    temporaryDirectories.push(sessionDirectory, cwd);
    const sessionId = '0b7c1a52-3f4e-4d6a-9a1c-2e8f5b6d7c90';

    const command = new DroidAdapter().buildCommand({
      agentPath: '/usr/bin/droid',
      taskId: 'task-1',
      cwd,
      permissionMode: 'acceptEdits',
      shell: 'bash',
      resume: true,
      sessionId,
      browserAutomationEnabled: true,
      eventsOutputPath: path.join(sessionDirectory, 'events.jsonl'),
      prompt: 'go',
    });

    const settingsIndex = command.indexOf('--settings');
    const autoIndex = command.indexOf('--auto low');
    const policyIndex = command.indexOf('--append-system-prompt');
    const resumeIndex = command.indexOf(`--resume ${sessionId}`);
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(autoIndex).toBeGreaterThan(settingsIndex);
    expect(policyIndex).toBeGreaterThan(autoIndex);
    expect(resumeIndex).toBeGreaterThan(policyIndex);
    expect(command).toMatch(/go'?$/);
    expect(command.lastIndexOf('go')).toBeGreaterThan(resumeIndex + `--resume ${sessionId}`.length);
  });
});

describe('buildDroidHookSettings options', () => {
  const bridge = '/opt/kangentic/event-bridge.js';
  const events = '/home/dev/session/events.jsonl';

  it('registers no browser policy entry and does not extract the prompt without options', () => {
    const { hooks } = buildDroidHookSettings(bridge, events);
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.UserPromptSubmit[0].hooks[0].command)
      .toBe(buildBridgeCommand(DROID_HOOK_SHELL, bridge, events, EventType.Prompt));
  });

  it('builds every event hook\'s command with the injected eventCommand', () => {
    const { hooks } = buildDroidHookSettings(bridge, events, {
      eventCommand: (eventType: string) => `stub-hook ${eventType}`,
    });
    const commands = Object.values(hooks).flatMap((entries) => entries.flatMap((entry) => entry.hooks.map((hook) => hook.command)));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(command).toMatch(/^stub-hook \S+$/);
  });
});
