/**
 * Unit tests for copilot hook-manager - buildHooks structure,
 * writeSessionConfig, and removeSessionConfig.
 *
 * Copilot hooks are arrays-per-event (NOT single objects).
 * Events use camelCase: preToolUse, postToolUse, agentStop, preCompact.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildHooks,
  writeSessionConfig,
  removeSessionConfig,
  COPILOT_HOOK_EVENTS,
} from '../../src/main/agent/adapters/copilot';

// Mock bridge-utils so tests don't require built script assets.
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn((name: string) => `/fake/scripts/${name}.js`),
}));

// Mock hook-utils buildBridgeCommand to a deterministic output for assertions.
vi.mock('../../src/main/agent/shared/hook-utils', () => ({
  isKangenticHookCommand: vi.fn((cmd: string) => cmd.includes('/fake/scripts/event-bridge.js')),
  buildBridgeCommand: vi.fn((bridge: string, eventsPath: string, type: string, ...directives: string[]) => {
    const directivePart = directives.length ? ' ' + directives.join(' ') : '';
    return `node "${bridge}" "${eventsPath}" ${type}${directivePart}`;
  }),
}));

let tmpDir: string;
const EVENTS_PATH = '/fake/.kangentic/sessions/abc/events.jsonl';
const STATUS_PATH = '/fake/.kangentic/sessions/abc/status.json';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-hookman-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('copilot-hook-manager', () => {
  describe('COPILOT_HOOK_EVENTS', () => {
    it('defines 4 hook events', () => {
      expect(COPILOT_HOOK_EVENTS).toHaveLength(4);
    });

    it('maps preToolUse to tool_start', () => {
      const entry = COPILOT_HOOK_EVENTS.find((e) => e.event === 'preToolUse');
      expect(entry).toBeDefined();
      expect(entry!.bridgeEventType).toBe('tool_start');
    });

    it('maps postToolUse to tool_end', () => {
      const entry = COPILOT_HOOK_EVENTS.find((e) => e.event === 'postToolUse');
      expect(entry).toBeDefined();
      expect(entry!.bridgeEventType).toBe('tool_end');
    });

    it('maps agentStop to idle', () => {
      const entry = COPILOT_HOOK_EVENTS.find((e) => e.event === 'agentStop');
      expect(entry).toBeDefined();
      expect(entry!.bridgeEventType).toBe('idle');
    });

    it('maps preCompact to compact', () => {
      const entry = COPILOT_HOOK_EVENTS.find((e) => e.event === 'preCompact');
      expect(entry).toBeDefined();
      expect(entry!.bridgeEventType).toBe('compact');
    });
  });

  describe('buildHooks', () => {
    it('returns an object with 4 keys (one per event)', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(Object.keys(hooks)).toHaveLength(4);
    });

    it('each hook value is an array (not a single object)', () => {
      // Copilot CLI v1.0.24 requires arrays - single objects are rejected with
      // "Expected array, received object".
      const hooks = buildHooks(EVENTS_PATH);
      for (const value of Object.values(hooks)) {
        expect(Array.isArray(value)).toBe(true);
      }
    });

    it('each array contains exactly one hook entry', () => {
      const hooks = buildHooks(EVENTS_PATH);
      for (const value of Object.values(hooks)) {
        expect(value).toHaveLength(1);
      }
    });

    it('each hook entry has command and timeout properties', () => {
      const hooks = buildHooks(EVENTS_PATH);
      for (const entries of Object.values(hooks)) {
        const entry = entries[0];
        expect(entry).toHaveProperty('command');
        expect(entry).toHaveProperty('timeout');
        expect(typeof entry.command).toBe('string');
        expect(typeof entry.timeout).toBe('number');
      }
    });

    it('timeout is 10 seconds on all entries', () => {
      const hooks = buildHooks(EVENTS_PATH);
      for (const entries of Object.values(hooks)) {
        expect(entries[0].timeout).toBe(10);
      }
    });

    it('hook commands reference the event-bridge script', () => {
      const hooks = buildHooks(EVENTS_PATH);
      for (const entries of Object.values(hooks)) {
        expect(entries[0].command).toContain('event-bridge');
      }
    });

    it('hook commands reference the events output path', () => {
      const hooks = buildHooks(EVENTS_PATH);
      for (const entries of Object.values(hooks)) {
        expect(entries[0].command).toContain(EVENTS_PATH);
      }
    });

    it('preToolUse hook command contains tool_start and tool:toolName directive', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(hooks.preToolUse[0].command).toContain('tool_start');
      expect(hooks.preToolUse[0].command).toContain('tool:toolName');
    });

    it('postToolUse hook command contains tool_end and tool:toolName directive', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(hooks.postToolUse[0].command).toContain('tool_end');
      expect(hooks.postToolUse[0].command).toContain('tool:toolName');
    });

    it('agentStop hook command contains idle and detail:stopReason directive', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(hooks.agentStop[0].command).toContain('idle');
      expect(hooks.agentStop[0].command).toContain('detail:stopReason');
    });

    it('preCompact hook command contains compact', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(hooks.preCompact[0].command).toContain('compact');
    });
  });

  describe('writeSessionConfig', () => {
    it('creates config.json in the specified directory', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(true);
    });

    it('creates the directory if it does not exist', () => {
      const configDir = path.join(tmpDir, 'new-dir', 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(fs.existsSync(configDir)).toBe(true);
    });

    it('written config has hooks object with 4 event keys', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH);
      const raw = fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8');
      const config = JSON.parse(raw);
      expect(config.hooks).toBeDefined();
      expect(Object.keys(config.hooks)).toHaveLength(4);
    });

    it('written config has hooks as arrays (not single objects)', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH);
      const raw = fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8');
      const config = JSON.parse(raw);
      for (const value of Object.values(config.hooks as Record<string, unknown>)) {
        expect(Array.isArray(value)).toBe(true);
      }
    });

    it('written config sets banner to "never"', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH);
      const raw = fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8');
      const config = JSON.parse(raw);
      expect(config.banner).toBe('never');
    });

    it('injects statusLine when statusOutputPath is provided', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH, STATUS_PATH);
      const raw = fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8');
      const config = JSON.parse(raw);
      expect(config.statusLine).toBeDefined();
      expect(config.statusLine.type).toBe('command');
      expect(config.statusLine.command).toContain('status-bridge');
      expect(config.statusLine.command).toContain(STATUS_PATH);
    });

    it('omits statusLine when statusOutputPath is not provided', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH);
      const raw = fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8');
      const config = JSON.parse(raw);
      expect(config.statusLine).toBeUndefined();
    });

    it('preserves user config properties (theme, model, etc.)', () => {
      // Write a fake user config to the expected location
      const homeDir = os.homedir();
      const userCopilotDir = path.join(homeDir, '.copilot');
      const userConfigPath = path.join(userCopilotDir, 'config.json');

      // Only inject if the user does not already have a copilot config
      // (avoid clobbering real user config in CI/dev environments)
      const hadExistingConfig = fs.existsSync(userConfigPath);
      if (!hadExistingConfig) {
        fs.mkdirSync(userCopilotDir, { recursive: true });
        fs.writeFileSync(userConfigPath, JSON.stringify({ theme: 'dark', model: 'gpt-4' }, null, 2));
      }

      try {
        const configDir = path.join(tmpDir, 'copilot-config');
        writeSessionConfig(configDir, EVENTS_PATH);
        const raw = fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8');
        const config = JSON.parse(raw);

        if (!hadExistingConfig) {
          // We injected user config - verify it was preserved
          expect(config.theme).toBe('dark');
          expect(config.model).toBe('gpt-4');
        }

        // Regardless of user config, hooks must be present and overridden
        expect(config.hooks).toBeDefined();
        expect(config.banner).toBe('never');
      } finally {
        if (!hadExistingConfig) {
          // Clean up injected user config
          try { fs.unlinkSync(userConfigPath); } catch { /* best effort */ }
          try { fs.rmdirSync(userCopilotDir); } catch { /* might not be empty */ }
        }
      }
    });
  });

  describe('removeSessionConfig', () => {
    it('removes config.json from the session config dir', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(true);

      removeSessionConfig(configDir);
      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
    });

    it('removes mcp-config.json if it exists', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), '{}');
      fs.writeFileSync(path.join(configDir, 'mcp-config.json'), '{}');

      removeSessionConfig(configDir);

      expect(fs.existsSync(path.join(configDir, 'mcp-config.json'))).toBe(false);
    });

    it('removes the directory if empty after cleanup', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      writeSessionConfig(configDir, EVENTS_PATH);

      removeSessionConfig(configDir);

      expect(fs.existsSync(configDir)).toBe(false);
    });

    it('does not throw when config.json does not exist', () => {
      const configDir = path.join(tmpDir, 'empty-dir');
      fs.mkdirSync(configDir, { recursive: true });
      expect(() => removeSessionConfig(configDir)).not.toThrow();
    });

    it('does not throw when directory does not exist', () => {
      const configDir = path.join(tmpDir, 'nonexistent-dir');
      expect(() => removeSessionConfig(configDir)).not.toThrow();
    });

    it('leaves directory intact if it contains extra files', () => {
      const configDir = path.join(tmpDir, 'copilot-config');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), '{}');
      fs.writeFileSync(path.join(configDir, 'extra-file.txt'), 'keep me');

      removeSessionConfig(configDir);

      // config.json removed, directory stays (not empty)
      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
      expect(fs.existsSync(path.join(configDir, 'extra-file.txt'))).toBe(true);
    });
  });
});
