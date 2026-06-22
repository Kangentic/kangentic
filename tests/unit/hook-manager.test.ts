import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildHooks,
  removeHooks,
} from '../../src/main/agent/adapters/claude';
import { EventType } from '../../src/shared/types';
import { extractDetail, setTypeWhen, setTypeWhenDetailContains, setTypeWhenDetailMatches, emitOnlyWhenDetailMatches } from '../../src/main/agent/shared/directive-builders';

let tmpDir: string;
const EVENT_BRIDGE = '/fake/.kangentic/event-bridge.js';
const EVENTS_PATH = '/fake/.kangentic/sessions/abc/events.jsonl';

function readSettings(): Record<string, unknown> {
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
  describe('buildHooks', () => {
    it('produces correct hook entries for all 18 event types', () => {
      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, {});

      // PreToolUse: tool_start only (blank matcher)
      expect(hooks.PreToolUse).toHaveLength(1);
      expect(hooks.PreToolUse[0].matcher).toBe('');
      expect(hooks.PreToolUse[0].hooks[0].command).toContain('event-bridge');
      expect(hooks.PreToolUse[0].hooks[0].command).toContain('tool_start');
      // ...and the background-shell remaps: Bash(run_in_background) -> start,
      // KillBash -> end. Asserted against the builder output so a drift
      // between the adapter and the bridge-level remap tests is caught here.
      expect(hooks.PreToolUse[0].hooks[0].command).toContain(
        setTypeWhen({ whenTool: 'Bash', nested: ['tool_input', 'run_in_background'], equals: 'true', to: EventType.BackgroundShellStart }),
      );
      expect(hooks.PreToolUse[0].hooks[0].command).toContain(
        setTypeWhen({ field: 'tool_name', equals: 'KillBash', to: EventType.BackgroundShellEnd }),
      );

      // PostToolUse: tool_end, plus the backgrounded-Bash promotion (shell id
      // extracted from tool_response, re-emitted as background_shell_start).
      // The remap keys on the EXTRACTED shell-id detail (not run_in_background)
      // so a foreground Bash auto-backgrounded on timeout still promotes (#187).
      expect(hooks.PostToolUse).toHaveLength(1);
      expect(hooks.PostToolUse[0].matcher).toBe('');
      expect(hooks.PostToolUse[0].hooks[0].command).toContain('tool_end');
      expect(hooks.PostToolUse[0].hooks[0].command).toContain(
        extractDetail(['shellId', 'shell_id', 'backgroundTaskId', 'bash_id'], { nested: 'tool_response' }),
      );
      expect(hooks.PostToolUse[0].hooks[0].command).toContain(
        setTypeWhenDetailMatches('^[\\w-]{1,64}$', EventType.BackgroundShellStart),
      );

      // PostToolUseFailure: tool_end with a setTypeWhen directive for interrupts
      expect(hooks.PostToolUseFailure).toHaveLength(1);
      expect(hooks.PostToolUseFailure[0].matcher).toBe('');
      expect(hooks.PostToolUseFailure[0].hooks[0].command).toContain('tool_end');
      expect(hooks.PostToolUseFailure[0].hooks[0].command).toContain(
        setTypeWhen({ field: 'is_interrupt', equals: 'true', to: EventType.Interrupted }),
      );

      // UserPromptSubmit: bare prompt (entry 0), plus the task-notification
      // bg-shell-end entry (entry 1) that drains a NAMED shell on terminal
      // status via the injected <task-notification> message (Incident A).
      expect(hooks.UserPromptSubmit).toHaveLength(2);
      expect(hooks.UserPromptSubmit[0].hooks[0].command).toContain('prompt');
      expect(hooks.UserPromptSubmit[1].hooks[0].command).toContain('background_shell_end');
      expect(hooks.UserPromptSubmit[1].hooks[0].command).toContain(
        emitOnlyWhenDetailMatches('^[\\w-]{1,64}$'),
      );

      // Stop: idle
      expect(hooks.Stop).toHaveLength(1);
      expect(hooks.Stop[0].hooks[0].command).toContain('idle');

      // StopFailure: turn_failed (fires INSTEAD of Stop on an API-error abort),
      // carrying the error type so the activity engine can reset stale counters.
      expect(hooks.StopFailure).toHaveLength(1);
      expect(hooks.StopFailure[0].hooks[0].command).toContain('turn_failed');
      expect(hooks.StopFailure[0].hooks[0].command).toContain(extractDetail(['error', 'error_details']));

      // PermissionRequest: idle
      expect(hooks.PermissionRequest).toHaveLength(1);
      expect(hooks.PermissionRequest[0].hooks[0].command).toContain('idle');

      // SessionStart: session_start
      expect(hooks.SessionStart).toHaveLength(1);
      expect(hooks.SessionStart[0].hooks[0].command).toContain('session_start');

      // SessionEnd: session_end
      expect(hooks.SessionEnd).toHaveLength(1);
      expect(hooks.SessionEnd[0].hooks[0].command).toContain('session_end');

      // SubagentStart: subagent_start
      expect(hooks.SubagentStart).toHaveLength(1);
      expect(hooks.SubagentStart[0].hooks[0].command).toContain('subagent_start');

      // SubagentStop: subagent_stop
      expect(hooks.SubagentStop).toHaveLength(1);
      expect(hooks.SubagentStop[0].hooks[0].command).toContain('subagent_stop');

      // Notification: notification, with a "waiting for your input" -> idle_hint
      // classification directive (Claude-specific string lives here, not the engine)
      expect(hooks.Notification).toHaveLength(1);
      expect(hooks.Notification[0].hooks[0].command).toContain('notification');
      expect(hooks.Notification[0].hooks[0].command).toContain(
        setTypeWhenDetailContains('waiting for your input', EventType.IdleHint),
      );

      // PreCompact: compact
      expect(hooks.PreCompact).toHaveLength(1);
      expect(hooks.PreCompact[0].hooks[0].command).toContain('compact');

      // TeammateIdle: teammate_idle
      expect(hooks.TeammateIdle).toHaveLength(1);
      expect(hooks.TeammateIdle[0].hooks[0].command).toContain('teammate_idle');

      // TaskCompleted: task_completed
      expect(hooks.TaskCompleted).toHaveLength(1);
      expect(hooks.TaskCompleted[0].hooks[0].command).toContain('task_completed');

      // ConfigChange: config_change
      expect(hooks.ConfigChange).toHaveLength(1);
      expect(hooks.ConfigChange[0].hooks[0].command).toContain('config_change');

      // WorktreeCreate: worktree_create
      expect(hooks.WorktreeCreate).toHaveLength(1);
      expect(hooks.WorktreeCreate[0].hooks[0].command).toContain('worktree_create');

      // WorktreeRemove: worktree_remove
      expect(hooks.WorktreeRemove).toHaveLength(1);
      expect(hooks.WorktreeRemove[0].hooks[0].command).toContain('worktree_remove');

      // Total: 18 hook event keys
      expect(Object.keys(hooks)).toHaveLength(18);
    });

    it('preserves existing user hooks', () => {
      const existing = {
        PreToolUse: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo user-pretool' }] },
        ],
        UserPromptSubmit: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo user-hook' }] },
        ],
      };

      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, existing);

      // PreToolUse: 1 user + 1 event-bridge
      expect(hooks.PreToolUse).toHaveLength(2);
      expect(hooks.PreToolUse[0].hooks[0].command).toBe('echo user-pretool');

      // UserPromptSubmit: 1 user + 2 event-bridge (bare prompt + bg-shell-end)
      expect(hooks.UserPromptSubmit).toHaveLength(3);
      expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe('echo user-hook');
    });
  });

  describe('removeHooks', () => {
    it('removes ALL kangentic hooks, preserves user hooks', () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settings = {
        hooks: {
          PreToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_start` }] },
            { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" idle` }] },
            { matcher: '', hooks: [{ type: 'command', command: 'echo user-pretool' }] },
          ],
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'echo user-hook' }] },
            { matcher: '', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" prompt` }] },
          ],
          PermissionRequest: [
            { matcher: '', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" idle` }] },
          ],
          PostToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_end` }] },
          ],
          PostToolUseFailure: [
            { matcher: '', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_failure` }] },
          ],
        },
      };
      fs.writeFileSync(
        path.join(claudeDir, 'settings.local.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      const result = readSettings();
      const hooks = result.hooks as Record<string, unknown[]>;
      expect(hooks.UserPromptSubmit).toHaveLength(1);
      expect((hooks.UserPromptSubmit[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe('echo user-hook');
      expect(hooks.PreToolUse).toHaveLength(1);
      expect((hooks.PreToolUse[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe('echo user-pretool');
      // PermissionRequest, PostToolUse, PostToolUseFailure had only kangentic hooks -- keys removed
      expect(hooks.PermissionRequest).toBeUndefined();
      expect(hooks.PostToolUse).toBeUndefined();
      expect(hooks.PostToolUseFailure).toBeUndefined();
    });

    it('also removes legacy activity-bridge hooks', () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const ACTIVITY_BRIDGE = '/fake/.kangentic/activity-bridge.js';
      const ACTIVITY_PATH = '/fake/.kangentic/sessions/abc/activity.json';
      const settings = {
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: `node "${ACTIVITY_BRIDGE}" "${ACTIVITY_PATH}" thinking` }] },
            { matcher: '', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          ],
        },
      };
      fs.writeFileSync(
        path.join(claudeDir, 'settings.local.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      const result = readSettings();
      const hooks = result.hooks as Record<string, unknown[]>;
      expect(hooks.UserPromptSubmit).toHaveLength(1);
      expect((hooks.UserPromptSubmit[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe('echo user-hook');
    });

    it('cleans up empty settings file', () => {
      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settings = {
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" prompt` }] },
          ],
        },
      };
      fs.writeFileSync(
        path.join(claudeDir, 'settings.local.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      expect(settingsExists()).toBe(false);
    });

    it('handles missing file', () => {
      expect(() => removeHooks(tmpDir)).not.toThrow();
    });
  });
});
