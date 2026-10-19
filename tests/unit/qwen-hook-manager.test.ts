import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildHooks,
  removeHooks,
  type QwenHookEntry,
} from '../../src/main/agent/adapters/qwen-code';
import { AgentTool, EventType } from '../../src/shared/types';
import {
  extractPlanMode,
  extractSubagentId,
  extractTool,
  extractToolId,
  setDetail,
  setToolWhen,
  setTypeWhen,
} from '../../src/main/agent/shared/directive-builders';

let tmpDir: string;
const EVENT_BRIDGE = '/fake/.kangentic/event-bridge.js';
const EVENTS_PATH = '/fake/.kangentic/sessions/abc/events.jsonl';

/** Every event name Qwen Code 0.24.0 loads that Kangentic wires. */
const QWEN_EVENTS = [
  'Notification',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'PreToolUse',
  'SessionEnd',
  'SessionStart',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'UserPromptSubmit',
];

/** The Gemini names older Kangentic builds wrote, which Qwen never loaded. */
const LEGACY_GEMINI_EVENTS = [
  'BeforeTool',
  'AfterTool',
  'BeforeAgent',
  'AfterAgent',
  'BeforeModel',
  'AfterModel',
  'BeforeToolSelection',
  'PreCompress',
];

/** A Kangentic entry as an older build wrote it under a Gemini name. */
function legacyKangenticEntry(eventType: string): QwenHookEntry {
  return {
    matcher: '*',
    hooks: [{ name: `kangentic-${eventType}`, type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" ${eventType}` }],
  };
}

/** The single Kangentic command under a hook event. */
function kangenticCommand(hooks: Record<string, QwenHookEntry[]>, hookEvent: string): string {
  const entries = hooks[hookEvent];
  return entries[entries.length - 1].hooks[0].command;
}

function readSettings(): Record<string, unknown> {
  const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
  return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
}

function settingsExists(): boolean {
  return fs.existsSync(path.join(tmpDir, '.qwen', 'settings.json'));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-hookman-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('qwen-hook-manager', () => {
  describe('buildHooks', () => {
    it('wires every event Qwen loads, under the names its HookEventName declares', () => {
      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, {});

      expect(Object.keys(hooks).sort()).toEqual(QWEN_EVENTS);
      for (const legacyName of LEGACY_GEMINI_EVENTS) {
        expect(hooks[legacyName]).toBeUndefined();
      }
      for (const hookEvent of QWEN_EVENTS) {
        expect(hooks[hookEvent]).toHaveLength(1);
        expect(hooks[hookEvent][0].matcher).toBe('*');
        expect(hooks[hookEvent][0].hooks[0].command).toContain('event-bridge');
      }
    });

    it('maps each event to the Kangentic event type Claude maps it to', () => {
      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, {});
      const eventTypeOf = (hookEvent: string) => kangenticCommand(hooks, hookEvent).split(' ')[3];

      expect(eventTypeOf('PreToolUse')).toBe(EventType.ToolStart);
      expect(eventTypeOf('PostToolUse')).toBe(EventType.ToolEnd);
      expect(eventTypeOf('PostToolUseFailure')).toBe(EventType.ToolEnd);
      expect(eventTypeOf('UserPromptSubmit')).toBe(EventType.Prompt);
      expect(eventTypeOf('Stop')).toBe(EventType.Idle);
      expect(eventTypeOf('StopFailure')).toBe(EventType.TurnFailed);
      expect(eventTypeOf('SubagentStart')).toBe(EventType.SubagentStart);
      expect(eventTypeOf('SubagentStop')).toBe(EventType.SubagentStop);
      expect(eventTypeOf('PermissionRequest')).toBe(EventType.Idle);
      expect(eventTypeOf('Notification')).toBe(EventType.Notification);
      expect(eventTypeOf('PreCompact')).toBe(EventType.Compact);
      expect(eventTypeOf('SessionStart')).toBe(EventType.SessionStart);
      expect(eventTypeOf('SessionEnd')).toBe(EventType.SessionEnd);
    });

    it('carries the directives that name the tool, pair its start and end, and report plan exit and permission', () => {
      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, {});
      const toolCorrelation = [extractTool('tool_name'), extractToolId(['tool_use_id'])];

      for (const hookEvent of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
        for (const directive of toolCorrelation) {
          expect(kangenticCommand(hooks, hookEvent)).toContain(directive);
        }
      }
      expect(kangenticCommand(hooks, 'PostToolUse')).toContain(setToolWhen({
        whenTool: 'exit_plan_mode',
        nested: ['tool_response', 'llmContent'],
        startsWith: 'User approved.',
        to: AgentTool.ExitPlanMode,
      }));
      expect(kangenticCommand(hooks, 'PostToolUseFailure')).toContain(
        setTypeWhen({ field: 'is_interrupt', equals: 'true', to: EventType.Interrupted }),
      );
      expect(kangenticCommand(hooks, 'PermissionRequest')).toContain(setDetail('permission'));
      expect(kangenticCommand(hooks, 'PermissionRequest')).toContain(extractTool('tool_name'));
      const planMode = extractPlanMode('permission_mode', ['plan'], { unlessField: 'agent_id' });
      expect(kangenticCommand(hooks, 'UserPromptSubmit')).toContain(planMode);
      expect(kangenticCommand(hooks, 'Stop')).toContain(planMode);
      for (const hookEvent of ['SubagentStart', 'SubagentStop']) {
        expect(kangenticCommand(hooks, hookEvent)).toContain(extractSubagentId(['agent_id']));
      }
    });

    it('preserves existing user hooks', () => {
      const existing = {
        PreToolUse: [
          { matcher: 'write_file', hooks: [{ name: 'security', type: 'command', command: 'echo user-check' }] },
        ],
        UserPromptSubmit: [
          { matcher: '*', hooks: [{ name: 'memory', type: 'command', command: 'echo inject-memory' }] },
        ],
      };

      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, existing);

      // PreToolUse: 1 user + 1 event-bridge
      expect(hooks.PreToolUse).toHaveLength(2);
      expect(hooks.PreToolUse[0].hooks[0].command).toBe('echo user-check');

      // UserPromptSubmit: 1 user + 1 event-bridge
      expect(hooks.UserPromptSubmit).toHaveLength(2);
      expect(hooks.UserPromptSubmit[0].hooks[0].command).toBe('echo inject-memory');
    });

    it('strips the Gemini-named entries an older build left, keeping the user\'s own under those names', () => {
      const userEntry = { matcher: 'write_file', hooks: [{ name: 'security', type: 'command', command: 'echo user-check' }] };
      const existing: Record<string, QwenHookEntry[]> = {};
      for (const legacyName of LEGACY_GEMINI_EVENTS) {
        existing[legacyName] = [legacyKangenticEntry('tool_start')];
      }
      existing.BeforeTool = [userEntry, legacyKangenticEntry('tool_start')];

      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, existing);

      // A key holding only a stale Kangentic entry is dropped outright.
      for (const legacyName of LEGACY_GEMINI_EVENTS.filter((name) => name !== 'BeforeTool')) {
        expect(hooks[legacyName]).toBeUndefined();
      }
      // The user's own entry survives, alone.
      expect(hooks.BeforeTool).toEqual([userEntry]);
      expect(Object.keys(hooks).sort()).toEqual([...QWEN_EVENTS, 'BeforeTool'].sort());
    });

    it('strips a stale entry under a current name, leaving exactly one Kangentic entry', () => {
      const stale = buildHooks(EVENT_BRIDGE, '/fake/.kangentic/sessions/old/events.jsonl', {});
      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, stale);

      for (const hookEvent of QWEN_EVENTS) {
        expect(hooks[hookEvent]).toHaveLength(1);
        expect(hooks[hookEvent][0].hooks[0].command).toContain(EVENTS_PATH);
      }
    });

    it('passes the hook system\'s config keys through untouched', () => {
      const existing = {
        enabled: true,
        disabled: ['user-hook'],
        notifications: { enabled: false },
      } as unknown as Record<string, QwenHookEntry[]>;

      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, existing) as unknown as Record<string, unknown>;

      expect(hooks.enabled).toBe(true);
      expect(hooks.disabled).toEqual(['user-hook']);
      expect(hooks.notifications).toEqual({ enabled: false });
    });

    it('replaces a hand-edited event value that is not an entry list with the bridge entry alone', () => {
      // Qwen rejects such a value. Spreading an object throws and spreading a
      // string splits it into one entry per character, so the list for the event
      // is just Kangentic's bridge entry. Keyed on events buildHooks writes, since
      // a non-event key with a non-list value passes through by design.
      const existing = {
        PreToolUse: {},
        Stop: 'echo user-stop',
      } as unknown as Record<string, QwenHookEntry[]>;

      let hooks: Record<string, QwenHookEntry[]> = {};
      expect(() => { hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, existing); }).not.toThrow();

      for (const hookEvent of ['PreToolUse', 'Stop']) {
        expect(hooks[hookEvent]).toHaveLength(1);
        expect(hooks[hookEvent][0].hooks[0].name).toMatch(/^kangentic-/);
        expect(hooks[hookEvent][0].hooks[0].command).toContain('event-bridge');
      }
      // The other events are untouched by the bad neighbours.
      for (const hookEvent of QWEN_EVENTS.filter((name) => name !== 'PreToolUse' && name !== 'Stop')) {
        expect(hooks[hookEvent]).toHaveLength(1);
      }
    });

    it('hook entries carry a kangentic- name (Qwen dedupes hooks by name)', () => {
      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, {});

      for (const entries of Object.values(hooks)) {
        for (const entry of entries) {
          for (const hook of entry.hooks) {
            expect(hook.name).toBeDefined();
            expect(hook.name).toMatch(/^kangentic-/);
          }
        }
      }
    });
  });

  describe('removeHooks', () => {
    it('removes what the current build writes and what an older build left under Gemini names', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const userEntry = { matcher: '*', hooks: [{ name: 'memory', type: 'command', command: 'echo inject-memory' }] };
      const current = buildHooks(EVENT_BRIDGE, EVENTS_PATH, { UserPromptSubmit: [userEntry] });
      const settings = {
        theme: 'dark',
        hooks: {
          ...current,
          AfterAgent: [legacyKangenticEntry('idle')],
          BeforeModel: [legacyKangenticEntry('model_start')],
          disabled: ['memory'],
        },
      };
      fs.writeFileSync(path.join(qwenDir, 'settings.json'), JSON.stringify(settings, null, 2));

      removeHooks(tmpDir);

      const result = readSettings();
      expect(result.theme).toBe('dark');
      expect(result.hooks).toEqual({ UserPromptSubmit: [userEntry], disabled: ['memory'] });
    });

    it('removes kangentic hooks, preserves user hooks', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const settings = {
        hooks: {
          BeforeTool: [
            { matcher: '*', hooks: [{ name: 'kangentic-tool_start', type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_start` }] },
            { matcher: 'write_file', hooks: [{ name: 'security', type: 'command', command: 'echo user-check' }] },
          ],
          AfterTool: [
            { matcher: '*', hooks: [{ name: 'kangentic-tool_end', type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_end` }] },
          ],
          BeforeAgent: [
            { matcher: '*', hooks: [{ name: 'memory', type: 'command', command: 'echo inject-memory' }] },
          ],
        },
      };
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      const result = readSettings();
      const hooks = result.hooks as Record<string, unknown[]>;
      // BeforeTool: only user hook remains
      expect(hooks.BeforeTool).toHaveLength(1);
      expect((hooks.BeforeTool[0] as { hooks: Array<{ command: string }> }).hooks[0].command).toBe('echo user-check');
      // AfterTool had only kangentic hooks - key removed
      expect(hooks.AfterTool).toBeUndefined();
      // BeforeAgent: user hook preserved
      expect(hooks.BeforeAgent).toHaveLength(1);
    });

    it('cleans up empty settings file', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const settings = {
        hooks: {
          BeforeTool: [
            { matcher: '*', hooks: [{ name: 'kangentic-tool_start', type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_start` }] },
          ],
        },
      };
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      expect(settingsExists()).toBe(false);
    });

    it('handles missing file', () => {
      expect(() => removeHooks(tmpDir)).not.toThrow();
    });

    it('preserves non-hook settings', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const settings = {
        theme: 'dark',
        hooks: {
          BeforeTool: [
            { matcher: '*', hooks: [{ name: 'kangentic-tool_start', type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_start` }] },
          ],
        },
      };
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      const result = readSettings();
      expect(result.theme).toBe('dark');
      expect(result.hooks).toBeUndefined();
    });

    it('strips mcpServers.kangentic, preserves user-defined mcp servers', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const settings = {
        mcpServers: {
          kangentic: {
            httpUrl: 'http://127.0.0.1:51234/mcp/proj-1',
            headers: { 'X-Kangentic-Token': 'stale-token' },
          },
          'user-server': { httpUrl: 'http://example.com/mcp' },
        },
      };
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      const result = readSettings();
      const mcpServers = result.mcpServers as Record<string, unknown>;
      expect(mcpServers.kangentic).toBeUndefined();
      expect(mcpServers['user-server']).toBeDefined();
    });

    it('removes mcpServers key entirely when only kangentic was present', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const settings = {
        theme: 'dark',
        mcpServers: {
          kangentic: {
            httpUrl: 'http://127.0.0.1:51234/mcp/proj-1',
            headers: { 'X-Kangentic-Token': 'stale-token' },
          },
        },
      };
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      const result = readSettings();
      expect(result.theme).toBe('dark');
      expect(result.mcpServers).toBeUndefined();
    });

    it('strips kangentic hooks AND mcpServers.kangentic in a single pass', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const settings = {
        hooks: {
          BeforeTool: [
            { matcher: '*', hooks: [{ name: 'kangentic-tool_start', type: 'command', command: `node "${EVENT_BRIDGE}" "${EVENTS_PATH}" tool_start` }] },
          ],
        },
        mcpServers: {
          kangentic: {
            httpUrl: 'http://127.0.0.1:51234/mcp/proj-1',
            headers: { 'X-Kangentic-Token': 'stale-token' },
          },
        },
      };
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      // Both keys removed - whole settings object is empty - file is deleted.
      expect(settingsExists()).toBe(false);
    });

    it('is a no-op when no kangentic entries exist (idempotent)', () => {
      const qwenDir = path.join(tmpDir, '.qwen');
      fs.mkdirSync(qwenDir, { recursive: true });
      const settings = {
        theme: 'dark',
        mcpServers: {
          'user-server': { httpUrl: 'http://example.com/mcp' },
        },
        hooks: {
          BeforeAgent: [
            { matcher: '*', hooks: [{ name: 'memory', type: 'command', command: 'echo inject-memory' }] },
          ],
        },
      };
      fs.writeFileSync(
        path.join(qwenDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
      );

      removeHooks(tmpDir);

      const result = readSettings();
      expect(result).toEqual(settings);
    });
  });
});
