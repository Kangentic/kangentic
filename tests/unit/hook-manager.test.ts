import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  injectActivityHooks,
  injectEventHooks,
  stripActivityHooks,
} from '../../src/main/agent/hook-manager';

let tmpDir: string;
const ACTIVITY_BRIDGE = '/fake/.kangentic/activity-bridge.js';
const EVENT_BRIDGE = '/fake/.kangentic/event-bridge.js';
const ACTIVITY_PATH = '/fake/.kangentic/sessions/abc/activity.json';
const EVENTS_PATH = '/fake/.kangentic/sessions/abc/events.jsonl';

function readSettings(): any {
  const p = path.join(tmpDir, '.claude', 'settings.local.json');
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function settingsExists(): boolean {
  return fs.existsSync(path.join(tmpDir, '.claude', 'settings.local.json'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hookman-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('hook-manager', () => {
  it('injectActivityHooks creates settings file with correct hooks', () => {
    injectActivityHooks(tmpDir, ACTIVITY_BRIDGE, ACTIVITY_PATH);

    const settings = readSettings();
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('activity-bridge');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('idle');
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toContain('activity-bridge');
    expect(settings.hooks.Stop[0].hooks[0].command).toContain('activity-bridge');
  });

  it('injectEventHooks creates settings file with correct hooks', () => {
    injectEventHooks(tmpDir, EVENT_BRIDGE, EVENTS_PATH);

    const settings = readSettings();
    expect(settings.hooks.PreToolUse).toHaveLength(3);
    expect(settings.hooks.PostToolUse).toHaveLength(1);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
    // First entry: catch-all tool_start
    expect(settings.hooks.PreToolUse[0].matcher).toBe('');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('event-bridge');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain('tool_start');
    // Second entry: AskUserQuestion → idle
    expect(settings.hooks.PreToolUse[1].matcher).toBe('AskUserQuestion');
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toContain('event-bridge');
    expect(settings.hooks.PreToolUse[1].hooks[0].command).toContain('idle');
    // Third entry: ExitPlanMode → idle
    expect(settings.hooks.PreToolUse[2].matcher).toBe('ExitPlanMode');
    expect(settings.hooks.PreToolUse[2].hooks[0].command).toContain('event-bridge');
    expect(settings.hooks.PreToolUse[2].hooks[0].command).toContain('idle');
  });

  it('injectActivityHooks preserves event-bridge hooks', () => {
    // First inject event hooks
    injectEventHooks(tmpDir, EVENT_BRIDGE, EVENTS_PATH);
    // Then inject activity hooks
    injectActivityHooks(tmpDir, ACTIVITY_BRIDGE, ACTIVITY_PATH);

    const settings = readSettings();
    // UserPromptSubmit should have both event-bridge and activity-bridge entries
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    const upsCommands = settings.hooks.UserPromptSubmit.map(
      (e: any) => e.hooks[0].command,
    );
    expect(upsCommands.some((c: string) => c.includes('event-bridge'))).toBe(true);
    expect(upsCommands.some((c: string) => c.includes('activity-bridge'))).toBe(true);

    // PreToolUse should have event-bridge entries (3) + activity-bridge AskUserQuestion (1)
    expect(settings.hooks.PreToolUse).toHaveLength(4);
    const ptuCommands = settings.hooks.PreToolUse.map(
      (e: any) => e.hooks[0].command,
    );
    expect(ptuCommands.filter((c: string) => c.includes('event-bridge'))).toHaveLength(3);
    expect(ptuCommands.filter((c: string) => c.includes('activity-bridge'))).toHaveLength(1);
  });

  it('injectEventHooks preserves activity-bridge hooks', () => {
    injectActivityHooks(tmpDir, ACTIVITY_BRIDGE, ACTIVITY_PATH);
    injectEventHooks(tmpDir, EVENT_BRIDGE, EVENTS_PATH);

    const settings = readSettings();
    // Stop should have both bridge types
    expect(settings.hooks.Stop).toHaveLength(2);
    const stopCommands = settings.hooks.Stop.map(
      (e: any) => e.hooks[0].command,
    );
    expect(stopCommands.some((c: string) => c.includes('activity-bridge'))).toBe(true);
    expect(stopCommands.some((c: string) => c.includes('event-bridge'))).toBe(true);

    // PreToolUse should have activity-bridge AskUserQuestion (1) + event-bridge entries (3)
    expect(settings.hooks.PreToolUse).toHaveLength(4);
    const ptuCommands = settings.hooks.PreToolUse.map(
      (e: any) => e.hooks[0].command,
    );
    expect(ptuCommands.filter((c: string) => c.includes('activity-bridge'))).toHaveLength(1);
    expect(ptuCommands.filter((c: string) => c.includes('event-bridge'))).toHaveLength(3);
  });

  it('injectActivityHooks preserves user hooks', () => {
    // Pre-create settings with a user hook
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const userSettings = {
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo user-hook' }] },
        ],
      },
    };
    fs.writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify(userSettings, null, 2),
    );

    injectActivityHooks(tmpDir, ACTIVITY_BRIDGE, ACTIVITY_PATH);

    const settings = readSettings();
    expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
    const commands = settings.hooks.UserPromptSubmit.map(
      (e: any) => e.hooks[0].command,
    );
    expect(commands).toContain('echo user-hook');
    expect(commands.some((c: string) => c.includes('activity-bridge'))).toBe(true);
  });

  it('stripActivityHooks removes ALL kangentic hooks, preserves user hooks', () => {
    // Set up: user hook + both kangentic bridge types across multiple hook events
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settings = {
      hooks: {
        PreToolUse: [
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `node "${ACTIVITY_BRIDGE}" "${ACTIVITY_PATH}" idle` }] },
          { matcher: '', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_start` }] },
          { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" idle` }] },
          { matcher: '', hooks: [{ type: 'command', command: 'echo user-pretool' }] },
        ],
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          { matcher: '', hooks: [{ type: 'command', command: `node "${ACTIVITY_BRIDGE}" "${ACTIVITY_PATH}" thinking` }] },
          { matcher: '', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" prompt` }] },
        ],
      },
    };
    fs.writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify(settings, null, 2),
    );

    stripActivityHooks(tmpDir);

    const result = readSettings();
    expect(result.hooks.UserPromptSubmit).toHaveLength(1);
    expect(result.hooks.UserPromptSubmit[0].hooks[0].command).toBe('echo user-hook');
    expect(result.hooks.PreToolUse).toHaveLength(1);
    expect(result.hooks.PreToolUse[0].hooks[0].command).toBe('echo user-pretool');
  });

  it('stripActivityHooks cleans up empty settings file', () => {
    // Create settings with only kangentic hooks
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settings = {
      hooks: {
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: `node "${ACTIVITY_BRIDGE}" "${ACTIVITY_PATH}" thinking` }] },
        ],
      },
    };
    fs.writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify(settings, null, 2),
    );

    stripActivityHooks(tmpDir);

    expect(settingsExists()).toBe(false);
  });

  it('stripActivityHooks handles missing file', () => {
    // No .claude/ directory at all — should not throw
    expect(() => stripActivityHooks(tmpDir)).not.toThrow();
  });
});
