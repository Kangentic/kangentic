/**
 * How the Claude, Gemini and Qwen command builders read the user's own settings
 * files, and what the Gemini and Qwen hook managers strip from them.
 *
 * Each builder reads its settings from disk on every spawn. In the main repo the
 * Gemini and Qwen read finds the file the previous spawn wrote, so two things
 * must hold. A file that is not a plain JSON object must never reach the
 * object spread that builds the merged settings. And the strip that runs on the
 * read, and on `removeHooks`, must take out Kangentic's entries and nothing
 * else, and must say truthfully whether it changed anything.
 *
 * Every filesystem write goes under a temp directory made with
 * `fs.mkdtempSync(path.join(os.tmpdir(), ...))`, removed after each test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommandBuilder } from '../../src/main/agent/adapters/claude/command-builder';
import { GeminiCommandBuilder } from '../../src/main/agent/adapters/gemini';
import type { GeminiCommandOptions } from '../../src/main/agent/adapters/gemini';
import { QwenCommandBuilder } from '../../src/main/agent/adapters/qwen-code';
import type { QwenCommandOptions } from '../../src/main/agent/adapters/qwen-code';
import {
  buildHooks as buildGeminiHooks,
  removeHooks as removeGeminiHooks,
  stripKangenticEntries as stripGeminiEntries,
} from '../../src/main/agent/adapters/gemini/hook-manager';
import {
  buildHooks as buildQwenHooks,
  removeHooks as removeQwenHooks,
  stripKangenticEntries as stripQwenEntries,
} from '../../src/main/agent/adapters/qwen-code/hook-manager';
import type { QwenSettingsWithKangenticEntries } from '../../src/main/agent/adapters/qwen-code/hook-manager';
import { EVENTS_PATH_FROM_ENVIRONMENT, isKangenticHookCommand } from '../../src/main/agent/shared/hook-utils';
import type { CommandOptions } from '../../src/main/agent/agent-adapter';

/** A hook entry in the nested shape Gemini and Qwen share. */
interface HookEntryShape {
  matcher: string;
  hooks: Array<{ name: string; type: string; command: string }>;
}

/** A parsed settings file, read back from disk. */
interface ParsedSettings {
  hooks?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The settings an in-memory strip works on, with the keys a test adds beside the two Kangentic writes into. */
interface StrippableSettings {
  hooks?: Record<string, HookEntryShape[]>;
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A project URL that names no session, so the build adds no background shell hint. */
const PROJECT_MCP_URL = 'http://127.0.0.1:51234/mcp/project-123';

/** A bridge path inside a `.kangentic` folder, bare-token safe for Qwen's Windows hook shell. */
const MOCK_BRIDGE_PATH = '/mock/project/.kangentic/event-bridge.js';

const USER_HOOK_COMMAND = 'echo user-hook';

const USER_HOOK_ENTRY: HookEntryShape = {
  matcher: '*',
  hooks: [{ name: 'user-hook', type: 'command', command: USER_HOOK_COMMAND }],
};

const USER_MCP_SERVER = { httpUrl: 'http://example.test/mcp' };

function numericKeys(settings: Record<string, unknown>): string[] {
  return Object.keys(settings).filter((key) => /^\d+$/.test(key));
}

function hookEntriesIn(settings: ParsedSettings): HookEntryShape[] {
  return Object.values(settings.hooks ?? {})
    .flatMap((entries) => (Array.isArray(entries) ? (entries as HookEntryShape[]) : []));
}

function hookCommandsIn(settings: ParsedSettings): string[] {
  return hookEntriesIn(settings).flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ''));
}

function kangenticHookCommandsIn(settings: ParsedSettings): string[] {
  return hookCommandsIn(settings).filter((command) => isKangenticHookCommand(command));
}

function writeSettingsText(directory: string, settingsFolder: string, content: string): string {
  const settingsPath = path.join(directory, settingsFolder, 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, content);
  return settingsPath;
}

function readSettings(directory: string, settingsFolder: string): ParsedSettings {
  return JSON.parse(fs.readFileSync(path.join(directory, settingsFolder, 'settings.json'), 'utf-8')) as ParsedSettings;
}

function geminiSpawnOptions(directory: string): GeminiCommandOptions {
  return {
    geminiPath: '/usr/bin/gemini',
    taskId: 'task-1',
    cwd: directory,
    projectRoot: directory,
    permissionMode: 'default',
    eventsOutputPath: path.join(directory, '.kangentic', 'sessions', 's1', 'events.jsonl'),
    mcpServerEnabled: true,
    mcpServerUrl: PROJECT_MCP_URL,
    mcpServerToken: 'token-1',
  };
}

function qwenSpawnOptions(directory: string): QwenCommandOptions {
  return {
    qwenPath: '/usr/bin/qwen',
    taskId: 'task-1',
    cwd: directory,
    projectRoot: directory,
    permissionMode: 'default',
    statusOutputPath: path.join(directory, '.kangentic', 'sessions', 's1', 'status.json'),
    eventsOutputPath: path.join(directory, '.kangentic', 'sessions', 's1', 'events.jsonl'),
    mcpServerEnabled: true,
    mcpServerUrl: PROJECT_MCP_URL,
    mcpServerToken: 'token-1',
    // A Qwen before 0.16 has no --mcp-config, so its Kangentic MCP entry goes
    // into the folder's settings file, the file these tests read back.
    cliVersion: '0.15.3',
  };
}

function lastBridgeEntry(entries: HookEntryShape[] | undefined): HookEntryShape {
  const entry = entries?.at(-1);
  if (!entry) throw new Error('buildHooks wrote no entry for the event');
  return entry;
}

/** The two folder-shared settings adapters, driven through the same cases. */
interface FolderSettingsAdapter {
  name: string;
  settingsFolder: string;
  /** An event key the builder writes and a user may also use. */
  eventKey: string;
  /** A second event key, for a case that keeps one key while another is emptied. */
  otherEventKey: string;
  /** One builder, kept for as long as the returned function is, building as the main repo with events and MCP on. */
  createSpawner: () => (directory: string) => void;
  /** A hook entry the adapter's own `buildHooks` writes, as a built settings file carries it. */
  kangenticEntry: () => HookEntryShape;
  strip: (settings: StrippableSettings) => boolean;
  removeHooks: (directory: string) => void;
}

const FOLDER_ADAPTERS: FolderSettingsAdapter[] = [
  {
    name: 'Gemini',
    settingsFolder: '.gemini',
    eventKey: 'BeforeTool',
    otherEventKey: 'AfterTool',
    createSpawner: () => {
      const builder = new GeminiCommandBuilder();
      return (directory) => {
        builder.buildGeminiCommand(geminiSpawnOptions(directory));
      };
    },
    kangenticEntry: () => lastBridgeEntry(buildGeminiHooks(MOCK_BRIDGE_PATH, EVENTS_PATH_FROM_ENVIRONMENT, {}).BeforeTool),
    strip: stripGeminiEntries,
    removeHooks: removeGeminiHooks,
  },
  {
    name: 'Qwen',
    settingsFolder: '.qwen',
    eventKey: 'PreToolUse',
    otherEventKey: 'Stop',
    createSpawner: () => {
      const builder = new QwenCommandBuilder();
      return (directory) => {
        builder.buildQwenCommand(qwenSpawnOptions(directory));
      };
    },
    kangenticEntry: () => lastBridgeEntry(buildQwenHooks(MOCK_BRIDGE_PATH, EVENTS_PATH_FROM_ENVIRONMENT, {}).PreToolUse),
    strip: stripQwenEntries,
    removeHooks: removeQwenHooks,
  },
];

let projectDirectory: string;

beforeEach(() => {
  projectDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-settings-reads-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectDirectory, { recursive: true, force: true });
});

// Pins the plain-object guard in readBaseSettings of
// src/main/agent/adapters/qwen-code/command-builder.ts (`parsed && typeof parsed
// === 'object' && !Array.isArray(parsed)`) and its twin in the Gemini builder.
// Taking `parsed` unconditionally fails this test twice over: `null` makes
// stripKangenticEntries read `.hooks` of null and the build throws, and `["leak"]`
// or `"leak"` spreads into the merged settings as a `"0"` key that is written to
// disk. A bare number spreads to nothing either way, so it is in the loop as a
// documented input and does not itself discriminate.
describe('a folder settings.json that parses to something other than an object (H1)', () => {
  it.each(FOLDER_ADAPTERS)('$name: the build does not throw, writes no index keys, and still writes Kangentic\'s hooks', (adapter) => {
    for (const rawContent of ['["leak"]', 'null', '"leak"', '7']) {
      writeSettingsText(projectDirectory, adapter.settingsFolder, rawContent);
      const spawn = adapter.createSpawner();

      expect(() => spawn(projectDirectory), `build over ${rawContent}`).not.toThrow();

      const written = readSettings(projectDirectory, adapter.settingsFolder);
      expect(numericKeys(written), `index keys written over ${rawContent}`).toEqual([]);
      expect(Object.keys(written.hooks ?? {}), `hook events written over ${rawContent}`).toContain(adapter.eventKey);
      expect(kangenticHookCommandsIn(written).length, `Kangentic hooks written over ${rawContent}`).toBeGreaterThan(0);
    }
  });
});

// Pins the plain-object guard (`isPlainSettingsObject`) in readBaseSettings of
// src/main/agent/adapters/claude/command-builder.ts, for .claude/settings.json
// and .claude/settings.local.json. Without it a `null` project file is returned
// as the base settings: fullscreenByDefault then reads `.tui` of null and
// throws, and a build with events reads `.hooks` of null and throws. An array or
// a string is returned too and spreads into the written session settings as
// `"0"` keys. A local file destructured without the guard leaks the same keys.
describe('Claude readBaseSettings over a settings file that is not an object (H2)', () => {
  let temporaryHome: string;

  const claudeOptions = (): CommandOptions => ({
    cliPath: '/usr/bin/claude',
    taskId: 'task-1',
    cwd: projectDirectory,
    permissionMode: 'default',
    sessionId: 'sess-1',
    statusOutputPath: path.join(projectDirectory, '.kangentic', 'sessions', 'sess-1', 'status.json'),
    // Events make the build read `baseSettings.hooks`, which is where a null base throws.
    eventsOutputPath: path.join(projectDirectory, '.kangentic', 'sessions', 'sess-1', 'events.jsonl'),
  });

  const readSessionSettings = (): ParsedSettings => JSON.parse(
    fs.readFileSync(path.join(projectDirectory, '.kangentic', 'sessions', 'sess-1', 'settings.json'), 'utf-8'),
  ) as ParsedSettings;

  const writeClaudeFile = (fileName: 'settings.json' | 'settings.local.json', content: string): void => {
    const filePath = path.join(projectDirectory, '.claude', fileName);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  beforeEach(() => {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-settings-reads-home-'));
    // fullscreenByDefault falls through to the user's own ~/.claude/settings.json.
    vi.spyOn(os, 'homedir').mockReturnValue(temporaryHome);
  });

  afterEach(() => {
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  });

  it('a project settings.json of null, an array or a string: the build does not throw and writes no index keys', () => {
    for (const rawContent of ['null', '["leak"]', '"leak"']) {
      writeClaudeFile('settings.json', rawContent);

      expect(() => new CommandBuilder().buildClaudeCommand(claudeOptions()), `build over ${rawContent}`).not.toThrow();

      const written = readSessionSettings();
      expect(numericKeys(written), `index keys written over ${rawContent}`).toEqual([]);
      expect(written.statusLine, `statusLine written over ${rawContent}`).toBeDefined();
      expect(Object.keys(written.hooks ?? {}).length, `hooks written over ${rawContent}`).toBeGreaterThan(0);
    }
  });

  it('a project settings.json of null, an array or a string: fullscreenByDefault does not throw and treats it as no choice', () => {
    for (const rawContent of ['null', '["leak"]', '"leak"']) {
      writeClaudeFile('settings.json', rawContent);
      const builder = new CommandBuilder();

      expect(() => builder.fullscreenByDefault({ cwd: projectDirectory, projectRoot: projectDirectory }), `gate over ${rawContent}`).not.toThrow();
      // No project choice and no user choice: Kangentic turns fullscreen on.
      expect(builder.fullscreenByDefault({ cwd: projectDirectory, projectRoot: projectDirectory }), `gate over ${rawContent}`).toBe(true);
    }
  });

  it('a project settings.json that is not an object falls through to the user\'s own tui choice', () => {
    writeSettingsText(temporaryHome, '.claude', JSON.stringify({ tui: 'default' }));
    for (const rawContent of ['null', '["leak"]']) {
      writeClaudeFile('settings.json', rawContent);

      expect(new CommandBuilder().fullscreenByDefault({ cwd: projectDirectory, projectRoot: projectDirectory }), `gate over ${rawContent}`).toBe(false);
    }
  });

  it('a valid project settings.json beside a settings.local.json that is an array or a string keeps the project env and adds no index keys', () => {
    for (const rawLocal of ['["leak"]', '"leak"']) {
      writeClaudeFile('settings.json', JSON.stringify({ env: { A: '1' } }));
      writeClaudeFile('settings.local.json', rawLocal);

      new CommandBuilder().buildClaudeCommand(claudeOptions());

      const written = readSessionSettings();
      expect(written.env, `project env beside local ${rawLocal}`).toEqual({ A: '1' });
      expect(numericKeys(written), `index keys written beside local ${rawLocal}`).toEqual([]);
    }
  });
});

// Pins the read-time strip, stripKangenticEntries, that readBaseSettings in the
// Gemini and Qwen command builders calls. A strip that dropped every hook, or
// `mcpServers` wholesale, loses the user's own entry on the first build, so the
// user hook count is 0 instead of 1 and `mcpServers.docs` is gone. The second
// build runs over the file the first one wrote, with Kangentic's entries in it,
// which is the read a long-lived builder makes in the main repo.
describe('the read-time strip keeps the user\'s own entries (H3)', () => {
  it.each(FOLDER_ADAPTERS)('$name: after two builds the user hook appears once and mcpServers.docs sits beside mcpServers.kangentic', (adapter) => {
    writeSettingsText(projectDirectory, adapter.settingsFolder, JSON.stringify({
      hooks: { [adapter.eventKey]: [USER_HOOK_ENTRY] },
      mcpServers: { docs: USER_MCP_SERVER },
    }));
    const spawn = adapter.createSpawner();

    spawn(projectDirectory);
    spawn(projectDirectory);

    const second = readSettings(projectDirectory, adapter.settingsFolder);
    expect(hookCommandsIn(second).filter((command) => command === USER_HOOK_COMMAND)).toHaveLength(1);
    expect((second.hooks?.[adapter.eventKey] as HookEntryShape[])[0]).toEqual(USER_HOOK_ENTRY);
    expect(second.mcpServers?.docs).toEqual(USER_MCP_SERVER);
    expect(second.mcpServers?.kangentic).toBeDefined();
    expect(Object.keys(second.mcpServers ?? {}).sort()).toEqual(['docs', 'kangentic']);
  });
});

// Pins the return value and the key cleanup of stripKangenticEntries in
// src/main/agent/adapters/gemini/hook-manager.ts and
// src/main/agent/adapters/qwen-code/hook-manager.ts. `return changed` is what
// removeHooks reads to skip the write: a strip that always returned true
// rewrites a user-only file re-serialized, so the byte comparison fails, and one
// that returned false for a stripped entry fails the `true` cases. Removing the
// `delete` of an emptied event key, of an emptied `hooks`, or of an emptied
// `mcpServers` leaves the empty container behind, which `'hooks' in` and
// toStrictEqual both catch. For Qwen, dropping the HOOK_CONFIG_KEYS skip makes
// the `disabled: []` config value read as an emptied event key and get deleted.
describe('stripKangenticEntries return value and key cleanup (H4)', () => {
  describe.each(FOLDER_ADAPTERS)('$name', (adapter) => {
    it('returns false and leaves the object deep-equal for user-only hooks and user-only mcpServers', () => {
      const userOnlyInputs: StrippableSettings[] = [
        { hooks: { [adapter.eventKey]: [USER_HOOK_ENTRY] } },
        { mcpServers: { user: {} } },
        { ui: { theme: 'x' }, hooks: { [adapter.eventKey]: [USER_HOOK_ENTRY] }, mcpServers: { user: USER_MCP_SERVER } },
      ];
      for (const original of userOnlyInputs) {
        const settings = structuredClone(original);

        expect(adapter.strip(settings), JSON.stringify(original)).toBe(false);
        expect(settings, JSON.stringify(original)).toStrictEqual(original);
      }
    });

    it('returns true for a Kangentic hook entry alone and deletes the emptied event key and the emptied hooks object', () => {
      const kangenticEntry = adapter.kangenticEntry();
      // The entry must be one the strip recognizes, or the `true` below fails for the wrong reason.
      expect(isKangenticHookCommand(kangenticEntry.hooks[0].command)).toBe(true);
      const settings: StrippableSettings = { hooks: { [adapter.eventKey]: [kangenticEntry] } };

      expect(adapter.strip(settings)).toBe(true);

      expect('hooks' in settings).toBe(false);
      expect(settings).toStrictEqual({});
    });

    it('deletes only the emptied event key while another event key still holds a user entry', () => {
      const settings: StrippableSettings = {
        ui: { theme: 'x' },
        hooks: { [adapter.eventKey]: [adapter.kangenticEntry()], [adapter.otherEventKey]: [USER_HOOK_ENTRY] },
      };

      expect(adapter.strip(settings)).toBe(true);

      expect(settings.hooks).toBeDefined();
      expect(adapter.eventKey in (settings.hooks ?? {})).toBe(false);
      expect(settings).toStrictEqual({ ui: { theme: 'x' }, hooks: { [adapter.otherEventKey]: [USER_HOOK_ENTRY] } });
    });

    it('returns true for mcpServers.kangentic alone and deletes the emptied mcpServers', () => {
      const settings: StrippableSettings = { mcpServers: { kangentic: { httpUrl: '${KANGENTIC_MCP_URL}' } } };

      expect(adapter.strip(settings)).toBe(true);

      expect('mcpServers' in settings).toBe(false);
      expect(settings).toStrictEqual({});
    });

    it('returns true for mcpServers.kangentic beside a user server and keeps the user server', () => {
      const settings: StrippableSettings = { mcpServers: { kangentic: { httpUrl: 'x' }, user: USER_MCP_SERVER } };

      expect(adapter.strip(settings)).toBe(true);

      expect(settings).toStrictEqual({ mcpServers: { user: USER_MCP_SERVER } });
    });

    it('removeHooks leaves a user-only settings file byte for byte as it was, in a compact format', () => {
      // No whitespace, which the 2-space rewrite in safelyUpdateSettingsFile would change.
      const compact = JSON.stringify({
        ui: { theme: 'x' },
        hooks: { [adapter.eventKey]: [USER_HOOK_ENTRY] },
        mcpServers: { user: USER_MCP_SERVER },
      });
      const settingsPath = writeSettingsText(projectDirectory, adapter.settingsFolder, compact);

      adapter.removeHooks(projectDirectory);

      expect(fs.readFileSync(settingsPath, 'utf-8')).toBe(compact);
    });

    it('removeHooks does rewrite a compact file that carries a Kangentic entry, keeping the user\'s', () => {
      // The counterpart of the byte-for-byte case, so it cannot pass by removeHooks doing nothing.
      const compact = JSON.stringify({
        hooks: { [adapter.eventKey]: [USER_HOOK_ENTRY, adapter.kangenticEntry()] },
        mcpServers: { user: USER_MCP_SERVER },
      });
      const settingsPath = writeSettingsText(projectDirectory, adapter.settingsFolder, compact);

      adapter.removeHooks(projectDirectory);

      const rewritten = readSettings(projectDirectory, adapter.settingsFolder);
      expect(kangenticHookCommandsIn(rewritten)).toEqual([]);
      expect(hookCommandsIn(rewritten)).toEqual([USER_HOOK_COMMAND]);
      expect(rewritten.mcpServers).toEqual({ user: USER_MCP_SERVER });
      expect(fs.readFileSync(settingsPath, 'utf-8')).not.toBe(compact);
    });
  });

  it('Qwen: a key in HOOK_CONFIG_KEYS passes through untouched, an empty disabled list included', () => {
    const configOnly = { hooks: { enabled: true, disabled: [], notifications: false } };
    const untouched = structuredClone(configOnly) as unknown as QwenSettingsWithKangenticEntries;

    expect(stripQwenEntries(untouched)).toBe(false);
    expect(untouched).toStrictEqual(configOnly);

    const kangenticEntry = lastBridgeEntry(buildQwenHooks(MOCK_BRIDGE_PATH, EVENTS_PATH_FROM_ENVIRONMENT, {}).PreToolUse);
    const beside = {
      hooks: { enabled: true, disabled: [], PreToolUse: [kangenticEntry] },
    } as unknown as QwenSettingsWithKangenticEntries;

    expect(stripQwenEntries(beside)).toBe(true);
    expect(beside).toStrictEqual({ hooks: { enabled: true, disabled: [] } });
  });
});
