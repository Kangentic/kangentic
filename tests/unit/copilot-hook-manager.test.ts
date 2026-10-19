/**
 * Unit tests for copilot hook-manager - buildHooks structure,
 * writeSessionConfig, and removeSessionConfig.
 *
 * Copilot hooks are arrays-per-event (NOT single objects).
 * Events use camelCase: preToolUse, postToolUse, agentStop, preCompact.
 *
 * The hooks live in `<session config home>/hooks/kangentic.json`, the user
 * hooks folder every Copilot version since 0.0.422 reads. Copilot 1.0.93 stopped
 * reading user settings (hooks, statusLine, banner) from config.json, which is
 * where Kangentic used to put them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The user's home is a temp dir, so the "user config" fixtures below never
// touch the real ~/.copilot.
let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

// Mock bridge-utils so tests don't require built script assets.
vi.mock('../../src/main/agent/shared/bridge-utils', () => ({
  resolveBridgeScript: vi.fn((name: string) => `/fake/scripts/${name}.js`),
}));

import {
  buildHooks,
  writeSessionConfig,
  removeSessionConfig,
  COPILOT_HOOK_EVENTS,
} from '../../src/main/agent/adapters/copilot';
import { extractTool, extractDetail } from '../../src/main/agent/shared/directive-builders';
import { resolveBridgeScript } from '../../src/main/agent/shared/bridge-utils';

let tmpDir: string;
let configDir: string;
const EVENTS_PATH = '/fake/.kangentic/sessions/abc/events.jsonl';
const STATUS_PATH = '/fake/.kangentic/sessions/abc/status.json';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-hookman-'));
  tmpHome = path.join(tmpDir, 'home');
  fs.mkdirSync(tmpHome, { recursive: true });
  configDir = path.join(tmpDir, 'session', 'copilot-config');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
}

function hooksFilePath(): string {
  return path.join(configDir, 'hooks', 'kangentic.json');
}

function writeUserFile(fileName: string, content: string): string {
  const userCopilotDir = path.join(tmpHome, '.copilot');
  fs.mkdirSync(userCopilotDir, { recursive: true });
  const filePath = path.join(userCopilotDir, fileName);
  fs.writeFileSync(filePath, content);
  return filePath;
}

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

    it('preToolUse hook command contains tool_start and the extractTool directive', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(hooks.preToolUse[0].command).toContain('tool_start');
      expect(hooks.preToolUse[0].command).toContain(extractTool('toolName'));
    });

    it('postToolUse hook command contains tool_end and the extractTool directive', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(hooks.postToolUse[0].command).toContain('tool_end');
      expect(hooks.postToolUse[0].command).toContain(extractTool('toolName'));
    });

    it('agentStop hook command contains idle and the extractDetail directive', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(hooks.agentStop[0].command).toContain('idle');
      expect(hooks.agentStop[0].command).toContain(extractDetail(['stopReason']));
    });

    it('preCompact hook command contains compact', () => {
      const hooks = buildHooks(EVENTS_PATH);
      expect(hooks.preCompact[0].command).toContain('compact');
    });
  });

  describe('writeSessionConfig', () => {
    it('writes the hooks to hooks/kangentic.json as a version 1 hook config', () => {
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(readJson(hooksFilePath())).toEqual({ version: 1, hooks: buildHooks(EVENTS_PATH) });
    });

    it('creates the config directory and its hooks folder when missing', () => {
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(fs.statSync(path.join(configDir, 'hooks')).isDirectory()).toBe(true);
    });

    it('puts no hooks in config.json or settings.json, so no version reads them twice', () => {
      // Copilot 1.0.8 through 1.0.92 read config.json hooks AND the hooks folder.
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(readJson(path.join(configDir, 'config.json')).hooks).toBeUndefined();
      expect(readJson(path.join(configDir, 'settings.json')).hooks).toBeUndefined();
    });

    it('writes banner "never" to settings.json, where Copilot 1.0.93+ reads it', () => {
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(readJson(path.join(configDir, 'settings.json')).banner).toBe('never');
    });

    it('injects the statusLine bridge into settings.json when statusOutputPath is provided', () => {
      writeSessionConfig(configDir, EVENTS_PATH, STATUS_PATH);
      const settings = readJson(path.join(configDir, 'settings.json'));
      const statusLine = settings.statusLine as { type: string; command: string };
      expect(statusLine.type).toBe('command');
      expect(statusLine.command).toContain('status-bridge');
      expect(statusLine.command).toContain(STATUS_PATH);
    });

    it('omits statusLine when statusOutputPath is not provided', () => {
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(readJson(path.join(configDir, 'settings.json')).statusLine).toBeUndefined();
    });

    it('keeps statusLine and banner in config.json too, for versions before 1.0.93', () => {
      writeSessionConfig(configDir, EVENTS_PATH, STATUS_PATH);
      const config = readJson(path.join(configDir, 'config.json'));
      expect(config.banner).toBe('never');
      expect((config.statusLine as { command: string }).command).toContain(STATUS_PATH);
    });

    it('escapes $, a backtick and a double quote in both status line paths for a POSIX shell', () => {
      // Copilot hands the statusLine command to a POSIX shell on macOS and Linux,
      // where all three stay special inside double quotes: an unescaped `$work`
      // expanded to an empty string, so the bridge was handed the wrong path.
      //
      // quoteBridgePath reads process.platform at call time and this suite also runs
      // on win32, where it escapes nothing. Pin it to linux for the write only.
      //
      // The builder only embeds both paths in a string, never creates them, so the
      // specials can sit anywhere. The bridge is keyed by name: buildHooks asks for
      // event-bridge first and each of settings.json and config.json asks for
      // status-bridge, so a once-only override would hit the wrong call. The status
      // path starts as a Windows path: toForwardSlash runs before the quoting, so its
      // separators arrive as `/` and are not read as escapes and doubled.
      const defaultBridgePath = (name: string): string => `/fake/scripts/${name}.js`;
      vi.mocked(resolveBridgeScript).mockImplementation((name: string) => (
        name === 'status-bridge' ? '/fake/$scripts/st"atus-bridge.js' : defaultBridgePath(name)
      ));
      const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      try {
        writeSessionConfig(configDir, EVENTS_PATH, 'C:\\fake\\$work\\`tick`\\q"uote\\status.json');
      } finally {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor);
        vi.mocked(resolveBridgeScript).mockImplementation(defaultBridgePath);
      }

      const expectedCommand = 'node "/fake/\\$scripts/st\\"atus-bridge.js" "C:/fake/\\$work/\\`tick\\`/q\\"uote/status.json"';
      for (const fileName of ['settings.json', 'config.json']) {
        const statusLine = readJson(path.join(configDir, fileName)).statusLine as { command: string };
        expect(statusLine.command, fileName).toBe(expectedCommand);
      }
    });

    it('preserves the user settings.json, including the user\'s own hooks', () => {
      const userHooks = { postToolUse: [{ type: 'command', bash: './format.sh', powershell: './format.ps1' }] };
      writeUserFile('settings.json', JSON.stringify({ model: 'example-model', theme: 'dim', hooks: userHooks }));

      writeSessionConfig(configDir, EVENTS_PATH);

      const settings = readJson(path.join(configDir, 'settings.json'));
      expect(settings.model).toBe('example-model');
      expect(settings.theme).toBe('dim');
      expect(settings.hooks).toEqual(userHooks);
    });

    it('preserves the user config.json through the comment header Copilot 1.0.97 writes', () => {
      writeUserFile('config.json', [
        '// User settings belong in settings.json.',
        '// This file is managed automatically.',
        JSON.stringify({ lastLoggedInUser: { login: 'dev' }, trustedFolders: ['C:\\Users\\dev\\repo'] }, null, 2),
      ].join('\n'));

      writeSessionConfig(configDir, EVENTS_PATH);

      const config = readJson(path.join(configDir, 'config.json'));
      expect(config.lastLoggedInUser).toEqual({ login: 'dev' });
      expect(config.trustedFolders).toEqual(['C:\\Users\\dev\\repo']);
    });

    it('never merges config.json state into settings.json', () => {
      writeUserFile('config.json', JSON.stringify({ lastLoggedInUser: { login: 'dev' } }));
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(readJson(path.join(configDir, 'settings.json')).lastLoggedInUser).toBeUndefined();
    });

    it('cleans the hooks an older Kangentic left in the session config.json', () => {
      // The pre-1.0.93 layout: Kangentic's hooks inline in config.json.
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
        hooks: buildHooks(EVENTS_PATH),
        banner: 'never',
      }));

      writeSessionConfig(configDir, EVENTS_PATH);

      expect(readJson(path.join(configDir, 'config.json')).hooks).toBeUndefined();
      expect(readJson(hooksFilePath()).hooks).toEqual(buildHooks(EVENTS_PATH));
    });

    it('drops a Kangentic event-bridge entry from user hooks and keeps the user\'s own', () => {
      const kangenticEntry = buildHooks(EVENTS_PATH).postToolUse[0];
      const userEntry = { type: 'command', command: 'node ./lint.js' };
      const nestedKangenticGroup = { matcher: '.*', hooks: [{ type: 'command', command: kangenticEntry.command }] };
      writeUserFile('config.json', JSON.stringify({
        hooks: { postToolUse: [kangenticEntry, userEntry, nestedKangenticGroup], agentStop: [kangenticEntry] },
      }));

      writeSessionConfig(configDir, EVENTS_PATH);

      expect(readJson(path.join(configDir, 'config.json')).hooks).toEqual({ postToolUse: [userEntry] });
    });

    it('keeps the user\'s own empty hook list but drops a key whose only entries were Kangentic\'s', () => {
      const kangenticEntry = buildHooks(EVENTS_PATH).agentStop[0];
      writeUserFile('settings.json', JSON.stringify({
        hooks: { postToolUse: [], agentStop: [kangenticEntry] },
      }));

      writeSessionConfig(configDir, EVENTS_PATH);

      // The user wrote `postToolUse: []` themselves, so it stays. `agentStop`
      // held nothing but Kangentic's own entry, so the sweep empties it and it goes.
      expect(readJson(path.join(configDir, 'settings.json')).hooks).toEqual({ postToolUse: [] });
    });

    describe('a user settings.json or config.json that is not valid JSON', () => {
      it('starts each session copy from an empty object and warns once per file, naming it', () => {
        // A truncated write, as an editor crash or a full disk leaves it.
        writeUserFile('settings.json', '{"model":"example-model",');
        writeUserFile('config.json', '{"lastLoggedInUser":');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          writeSessionConfig(configDir, EVENTS_PATH);

          // Only the session's own `banner: never` is left; nothing from the broken files.
          expect(readJson(path.join(configDir, 'settings.json'))).toEqual({ banner: 'never' });
          expect(readJson(path.join(configDir, 'config.json'))).toEqual({ banner: 'never' });
          const warnings = warnSpy.mock.calls.map((callArguments) => String(callArguments[0]));
          expect(warnings).toHaveLength(2);
          expect(warnings.filter((warning) => warning.includes('settings.json'))).toHaveLength(1);
          expect(warnings.filter((warning) => warning.includes('config.json'))).toHaveLength(1);
        } finally {
          warnSpy.mockRestore();
        }
      });

      it('warns for a file that holds valid JSON which is not an object', () => {
        writeUserFile('settings.json', '["not", "an", "object"]');
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          writeSessionConfig(configDir, EVENTS_PATH);

          expect(readJson(path.join(configDir, 'settings.json'))).toEqual({ banner: 'never' });
          expect(warnSpy.mock.calls.map((callArguments) => String(callArguments[0]))
            .filter((warning) => warning.includes('settings.json'))).toHaveLength(1);
        } finally {
          warnSpy.mockRestore();
        }
      });
    });

    it('logs nothing when the user has no settings.json or config.json', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        writeSessionConfig(configDir, EVENTS_PATH);

        expect(readJson(path.join(configDir, 'settings.json'))).toEqual({ banner: 'never' });
        expect(warnSpy).not.toHaveBeenCalled();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('warns once, naming the file, when a user file exists but cannot be read, and still writes the session config', () => {
      // A directory where settings.json should be: readFileSync fails with EISDIR on
      // Windows and Linux alike. config.json is absent, which stays silent (ENOENT).
      fs.mkdirSync(path.join(tmpHome, '.copilot', 'settings.json'), { recursive: true });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        writeSessionConfig(configDir, EVENTS_PATH);

        const warnings = warnSpy.mock.calls.map((callArguments) => String(callArguments[0]));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('settings.json');
        expect(warnings[0]).toContain('could not be read');
        // The session starts without the unreadable file, and with everything else.
        expect(readJson(path.join(configDir, 'settings.json'))).toEqual({ banner: 'never' });
        expect(readJson(path.join(configDir, 'config.json'))).toEqual({ banner: 'never' });
        expect(readJson(hooksFilePath()).hooks).toEqual(buildHooks(EVENTS_PATH));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('copies the user mcp-config.json', () => {
      writeUserFile('mcp-config.json', JSON.stringify({ mcpServers: { example: { type: 'http', url: 'https://example.com/mcp' } } }));
      writeSessionConfig(configDir, EVENTS_PATH);
      expect(readJson(path.join(configDir, 'mcp-config.json')).mcpServers).toHaveProperty('example');
    });

    it('never modifies the user\'s own ~/.copilot files', () => {
      const settingsContent = JSON.stringify({ model: 'example-model' });
      const configContent = JSON.stringify({ lastLoggedInUser: { login: 'dev' } });
      const userSettingsPath = writeUserFile('settings.json', settingsContent);
      const userConfigPath = writeUserFile('config.json', configContent);

      writeSessionConfig(configDir, EVENTS_PATH, STATUS_PATH);

      expect(fs.readFileSync(userSettingsPath, 'utf-8')).toBe(settingsContent);
      expect(fs.readFileSync(userConfigPath, 'utf-8')).toBe(configContent);
      expect(fs.existsSync(path.join(tmpHome, '.copilot', 'hooks'))).toBe(false);
    });
  });

  describe('removeSessionConfig', () => {
    it('removes the hooks file, settings.json, config.json and mcp-config.json, then the empty directory', () => {
      writeUserFile('mcp-config.json', '{}');
      writeSessionConfig(configDir, EVENTS_PATH, STATUS_PATH);

      removeSessionConfig(configDir);

      expect(fs.existsSync(configDir)).toBe(false);
    });

    it('cleans an older Kangentic session directory whose hooks were inline in config.json', () => {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ hooks: buildHooks(EVENTS_PATH) }));

      removeSessionConfig(configDir);

      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
      expect(fs.existsSync(configDir)).toBe(false);
    });

    it('keeps the session-state Copilot stores in the same config home, for --resume', () => {
      writeSessionConfig(configDir, EVENTS_PATH);
      const sessionStateFile = path.join(configDir, 'session-state', 'abc', 'events.jsonl');
      fs.mkdirSync(path.dirname(sessionStateFile), { recursive: true });
      fs.writeFileSync(sessionStateFile, '{}\n');

      removeSessionConfig(configDir);

      expect(fs.existsSync(hooksFilePath())).toBe(false);
      expect(fs.existsSync(path.join(configDir, 'hooks'))).toBe(false);
      expect(fs.existsSync(path.join(configDir, 'settings.json'))).toBe(false);
      expect(fs.existsSync(path.join(configDir, 'config.json'))).toBe(false);
      expect(fs.existsSync(sessionStateFile)).toBe(true);
    });

    it('does not throw when config.json does not exist', () => {
      fs.mkdirSync(configDir, { recursive: true });
      expect(() => removeSessionConfig(configDir)).not.toThrow();
    });

    it('does not throw when directory does not exist', () => {
      expect(() => removeSessionConfig(path.join(tmpDir, 'nonexistent-dir'))).not.toThrow();
    });

    it('leaves directory intact if it contains extra files', () => {
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
