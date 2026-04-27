import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildHooks,
  removeHooks,
} from '../../src/main/agent/adapters/qwen-code';

let tmpDir: string;
const EVENT_BRIDGE = '/fake/.kangentic/event-bridge.js';
const EVENTS_PATH = '/fake/.kangentic/sessions/abc/events.jsonl';

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
    it('produces correct hook entries for all 11 mapped event types', () => {
      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, {});

      // BeforeTool: tool_start
      expect(hooks.BeforeTool).toHaveLength(1);
      expect(hooks.BeforeTool[0].matcher).toBe('*');
      expect(hooks.BeforeTool[0].hooks[0].command).toContain('event-bridge');
      expect(hooks.BeforeTool[0].hooks[0].command).toContain('tool_start');
      expect(hooks.BeforeTool[0].hooks[0].name).toBe('kangentic-tool_start');

      // AfterTool: tool_end
      expect(hooks.AfterTool).toHaveLength(1);
      expect(hooks.AfterTool[0].hooks[0].command).toContain('tool_end');

      // SessionStart: session_start
      expect(hooks.SessionStart).toHaveLength(1);
      expect(hooks.SessionStart[0].hooks[0].command).toContain('session_start');

      // SessionEnd: session_end
      expect(hooks.SessionEnd).toHaveLength(1);
      expect(hooks.SessionEnd[0].hooks[0].command).toContain('session_end');

      // AfterAgent: idle
      expect(hooks.AfterAgent).toHaveLength(1);
      expect(hooks.AfterAgent[0].hooks[0].command).toContain('idle');

      // BeforeAgent: prompt
      expect(hooks.BeforeAgent).toHaveLength(1);
      expect(hooks.BeforeAgent[0].hooks[0].command).toContain('prompt');

      // Notification: notification
      expect(hooks.Notification).toHaveLength(1);
      expect(hooks.Notification[0].hooks[0].command).toContain('notification');

      // PreCompress: compact
      expect(hooks.PreCompress).toHaveLength(1);
      expect(hooks.PreCompress[0].hooks[0].command).toContain('compact');

      // BeforeModel: model_start, model name extracted from llm_request.model
      expect(hooks.BeforeModel).toHaveLength(1);
      expect(hooks.BeforeModel[0].hooks[0].command).toContain('model_start');
      expect(hooks.BeforeModel[0].hooks[0].command).toContain('nested-detail:llm_request:model');

      // AfterModel: model_end, model name extracted from llm_request.model
      expect(hooks.AfterModel).toHaveLength(1);
      expect(hooks.AfterModel[0].hooks[0].command).toContain('model_end');
      expect(hooks.AfterModel[0].hooks[0].command).toContain('nested-detail:llm_request:model');

      // BeforeToolSelection: tool_selection_start
      expect(hooks.BeforeToolSelection).toHaveLength(1);
      expect(hooks.BeforeToolSelection[0].hooks[0].command).toContain('tool_selection_start');

      // Total: 11 hook event keys
      expect(Object.keys(hooks)).toHaveLength(11);
    });

    it('preserves existing user hooks', () => {
      const existing = {
        BeforeTool: [
          { matcher: 'write_file', hooks: [{ name: 'security', type: 'command', command: 'echo user-check' }] },
        ],
        BeforeAgent: [
          { matcher: '*', hooks: [{ name: 'memory', type: 'command', command: 'echo inject-memory' }] },
        ],
      };

      const hooks = buildHooks(EVENT_BRIDGE, EVENTS_PATH, existing);

      // BeforeTool: 1 user + 1 event-bridge
      expect(hooks.BeforeTool).toHaveLength(2);
      expect(hooks.BeforeTool[0].hooks[0].command).toBe('echo user-check');

      // BeforeAgent: 1 user + 1 event-bridge
      expect(hooks.BeforeAgent).toHaveLength(2);
      expect(hooks.BeforeAgent[0].hooks[0].command).toBe('echo inject-memory');
    });

    it('hook entries include name field (Qwen requirement, inherited from Gemini)', () => {
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
  });
});
