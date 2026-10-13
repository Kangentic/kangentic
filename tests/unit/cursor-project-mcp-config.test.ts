/**
 * Kangentic's MCP server in a Cursor session's working folder
 * (`src/main/agent/adapters/cursor/project-mcp-config.ts`): a static entry
 * whose url and token are `${env:...}` references, merged into the project's
 * `.cursor/mcp.json` beside the user's own servers, and taken out again
 * without touching them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CURSOR_KANGENTIC_MCP_ENTRY,
  cursorProjectMcpConfigProblem,
  removeCursorProjectMcpConfig,
  writeCursorProjectMcpConfig,
} from '../../src/main/agent/adapters/cursor/project-mcp-config';

let folder: string;
const configPath = () => path.join(folder, '.cursor', 'mcp.json');
const readConfig = () => JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Record<string, unknown> & { mcpServers?: Record<string, unknown> };
const readRawConfig = () => fs.readFileSync(configPath(), 'utf-8');
const writeRawConfig = (text: string): void => {
  fs.mkdirSync(path.join(folder, '.cursor'), { recursive: true });
  fs.writeFileSync(configPath(), text);
};

const USER_SERVER = { url: 'http://localhost:1/mcp' };

/** JSONC, which `JSON.parse` rejects: a comment and trailing commas, around a server the user keeps. */
const JSONC_CONFIG = [
  '{',
  '  // my servers',
  '  "mcpServers": {',
  '    "mine": { "url": "http://localhost:1/mcp" },',
  '  },',
  '}',
  '',
].join('\n');

beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-cursor-mcp-'));
});

afterEach(() => {
  fs.rmSync(folder, { recursive: true, force: true });
});

describe('writeCursorProjectMcpConfig', () => {
  it('writes a static entry whose url and token are environment references', () => {
    writeCursorProjectMcpConfig(folder);

    expect(readConfig().mcpServers?.kangentic).toEqual({
      url: '${env:KANGENTIC_MCP_URL}',
      headers: { 'X-Kangentic-Token': '${env:KANGENTIC_MCP_TOKEN}' },
    });
    expect(CURSOR_KANGENTIC_MCP_ENTRY.url).toBe('${env:KANGENTIC_MCP_URL}');
  });

  it('keeps the user\'s own servers and other settings', () => {
    fs.mkdirSync(path.join(folder, '.cursor'));
    fs.writeFileSync(configPath(), JSON.stringify({ mcpServers: { mine: { url: 'http://localhost:1/mcp' } }, other: true }));

    writeCursorProjectMcpConfig(folder);

    const config = readConfig();
    expect(config.mcpServers?.mine).toEqual({ url: 'http://localhost:1/mcp' });
    expect(config.mcpServers?.kangentic).toEqual(CURSOR_KANGENTIC_MCP_ENTRY);
    expect(config.other).toBe(true);
  });

  it('writes the same file for a second session in the folder, so neither sees the other\'s URL', () => {
    writeCursorProjectMcpConfig(folder);
    const first = fs.readFileSync(configPath(), 'utf-8');
    writeCursorProjectMcpConfig(folder);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(first);
  });
});

describe('removeCursorProjectMcpConfig', () => {
  it('removes the file when Kangentic\'s entry was all it held', () => {
    writeCursorProjectMcpConfig(folder);
    removeCursorProjectMcpConfig(folder);
    expect(fs.existsSync(configPath())).toBe(false);
  });

  it('removes only Kangentic\'s entry when the user has servers of their own', () => {
    fs.mkdirSync(path.join(folder, '.cursor'));
    fs.writeFileSync(configPath(), JSON.stringify({ mcpServers: { mine: { url: 'http://localhost:1/mcp' } } }));
    writeCursorProjectMcpConfig(folder);

    removeCursorProjectMcpConfig(folder);

    expect(readConfig()).toEqual({ mcpServers: { mine: { url: 'http://localhost:1/mcp' } } });
  });

  it('leaves a file with no Kangentic entry alone', () => {
    fs.mkdirSync(path.join(folder, '.cursor'));
    const userFile = JSON.stringify({ mcpServers: { mine: { url: 'http://localhost:1/mcp' } } });
    fs.writeFileSync(configPath(), userFile);
    removeCursorProjectMcpConfig(folder);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe(userFile);
  });
});

describe('a config with a kangentic server entry', () => {
  // Formatted differently from the `JSON.stringify(value, null, 2)` a rewrite
  // would produce, so a rewrite shows up as changed bytes.
  it.each<[string, (value: unknown) => string]>([
    ['compact', (value) => JSON.stringify(value)],
    ['four-space indented with a trailing newline', (value) => `${JSON.stringify(value, null, 4)}\n`],
  ])('is not rewritten when it is %s, and the write reports the entry is there', (_format, serialize) => {
    const text = serialize({ mcpServers: { mine: USER_SERVER, kangentic: CURSOR_KANGENTIC_MCP_ENTRY } });
    writeRawConfig(text);

    expect(writeCursorProjectMcpConfig(folder)).toBe(true);

    expect(readRawConfig()).toBe(text);
  });

  it('is rewritten when the entry differs, keeping the user\'s servers', () => {
    writeRawConfig(JSON.stringify({ mcpServers: { mine: USER_SERVER, kangentic: { url: 'http://localhost:9/old' } } }));

    expect(writeCursorProjectMcpConfig(folder)).toBe(true);

    const config = readConfig();
    expect(config.mcpServers?.kangentic).toEqual(CURSOR_KANGENTIC_MCP_ENTRY);
    expect(config.mcpServers?.mine).toEqual(USER_SERVER);
  });
});

// A config Kangentic cannot merge into holds servers the user keeps there, and
// a rewrite would drop every one. It is never written to, and the session
// starts without Kangentic's tools instead.
describe('a config Kangentic cannot merge into', () => {
  let restoreWarn: () => void;
  beforeEach(() => {
    // The refusal is logged; keep that out of the test output.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    restoreWarn = () => warnSpy.mockRestore();
  });
  afterEach(() => {
    restoreWarn();
  });

  it('is left byte for byte as it is by the write, which reports the entry is not there', () => {
    writeRawConfig(JSONC_CONFIG);

    expect(writeCursorProjectMcpConfig(folder)).toBe(false);

    expect(readRawConfig()).toBe(JSONC_CONFIG);
  });

  it('is left byte for byte as it is by the removal, even when it names a kangentic server', () => {
    const jsoncWithEntry = [
      '{',
      '  // my servers',
      '  "mcpServers": {',
      '    "mine": { "url": "http://localhost:1/mcp" },',
      '    "kangentic": { "url": "${env:KANGENTIC_MCP_URL}" },',
      '  },',
      '}',
      '',
    ].join('\n');
    writeRawConfig(jsoncWithEntry);

    removeCursorProjectMcpConfig(folder);

    expect(readRawConfig()).toBe(jsoncWithEntry);
  });

  it.each([
    ['mcpServers is an array', JSON.stringify({ mcpServers: [USER_SERVER] })],
    ['mcpServers is a string', JSON.stringify({ mcpServers: 'none' })],
    ['the top level is an array', JSON.stringify([{ mcpServers: { mine: USER_SERVER } }])],
    ['the top level is null', 'null'],
  ])('is unusable, and left as it is, when %s', (_shape, text) => {
    writeRawConfig(text);

    expect(writeCursorProjectMcpConfig(folder)).toBe(false);

    expect(readRawConfig()).toBe(text);
    expect(cursorProjectMcpConfigProblem(folder)).toEqual(expect.any(String));
  });
});

describe('cursorProjectMcpConfigProblem', () => {
  it('is null when the folder has no config', () => {
    expect(cursorProjectMcpConfigProblem(folder)).toBeNull();
  });

  it.each([
    ['one with no servers', JSON.stringify({ other: true })],
    ['one with the user\'s servers', JSON.stringify({ mcpServers: { mine: USER_SERVER } })],
    ['one that already holds the entry', JSON.stringify({ mcpServers: { kangentic: CURSOR_KANGENTIC_MCP_ENTRY } })],
  ])('is null for a config Kangentic can merge into: %s', (_shape, text) => {
    writeRawConfig(text);
    expect(cursorProjectMcpConfigProblem(folder)).toBeNull();
  });

  it('names the config path for a config it cannot merge into', () => {
    writeRawConfig(JSONC_CONFIG);

    const problem = cursorProjectMcpConfigProblem(folder);

    expect(problem).toEqual(expect.any(String));
    expect(problem).toContain(configPath());
  });
});

// The local exclude keeps a file Kangentic created out of `git status` and a
// stray `git add -A`. A file the user already had stays visible to git: it may
// be theirs to commit.
describe('the local git exclude', () => {
  const excludePath = () => path.join(folder, '.git', 'info', 'exclude');
  const excludeLines = () => fs.readFileSync(excludePath(), 'utf-8').split('\n').map((line) => line.trim());

  beforeEach(() => {
    // A checkout as `resolveGitCommonDir` reads one: a `.git` directory, no git run.
    fs.mkdirSync(path.join(folder, '.git', 'info'), { recursive: true });
  });

  it('lists the config when the write creates it', () => {
    expect(writeCursorProjectMcpConfig(folder)).toBe(true);

    expect(excludeLines()).toContain('.cursor/mcp.json');
  });

  it('does not list a config that was there before the write', () => {
    const existingExclude = 'node_modules/\n';
    fs.writeFileSync(excludePath(), existingExclude);
    writeRawConfig(JSON.stringify({ mcpServers: { mine: USER_SERVER } }));

    expect(writeCursorProjectMcpConfig(folder)).toBe(true);

    expect(readConfig().mcpServers?.kangentic).toEqual(CURSOR_KANGENTIC_MCP_ENTRY);
    expect(fs.readFileSync(excludePath(), 'utf-8')).toBe(existingExclude);
  });
});
