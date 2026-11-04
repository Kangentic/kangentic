/**
 * Kangentic's entry in a folder's `.kimi-code/mcp.json`. The file is the user's
 * as well as ours, so what a user loses if this breaks is their own MCP servers,
 * or a dead entry left behind after the last session ends.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  kimiKangenticMcpEntry,
  kimiProjectMcpConfigProblem,
  removeKimiProjectMcpConfig,
  writeKimiProjectMcpConfig,
} from '../../src/main/agent/adapters/kimi/mcp-config';
import { kimiMcpWiringEnabled } from '../../src/main/agent/adapters/kimi/command-builder';
import { KimiAdapter } from '../../src/main/agent/adapters/kimi';
import type { SpawnCommandOptions } from '../../src/main/agent/agent-adapter';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

const ENTRY = { url: 'http://127.0.0.1:9000/mcp/project', bearerTokenEnvVar: 'KANGENTIC_MCP_TOKEN' };

let directory: string;
let configPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-kimi-mcp-'));
  configPath = path.join(directory, '.kimi-code', 'mcp.json');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function readConfig(): { mcpServers?: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

describe('kimiKangenticMcpEntry', () => {
  it('gives a CLI on this machine an HTTP server that names the token\'s variable', () => {
    expect(kimiKangenticMcpEntry({ url: ENTRY.url, token: 'token-1', place: null, sessionDirectory: directory })).toEqual(ENTRY);
  });

  // The file is the user's, sits in their project and outlives a crash, so the
  // token must not be in it on either path.
  it('keeps the token out of the file, for HTTP and for the WSL bridge', () => {
    const httpEntry = kimiKangenticMcpEntry({ url: ENTRY.url, token: 'token-1', place: null, sessionDirectory: directory });
    const natPlace = { kind: 'wsl', facts: { networkingMode: 'nat' } } as unknown as CliPlace;
    const bridgeEntry = kimiKangenticMcpEntry({ url: ENTRY.url, token: 'token-1', place: natPlace, sessionDirectory: directory });
    expect(JSON.stringify(httpEntry)).not.toContain('token-1');
    expect(JSON.stringify(bridgeEntry)).not.toContain('token-1');
  });
});

describe('writeKimiProjectMcpConfig', () => {
  it('creates the file when there is none', () => {
    expect(writeKimiProjectMcpConfig(directory, ENTRY)).toBe(true);
    expect(readConfig().mcpServers?.kangentic).toEqual(ENTRY);
  });

  it('keeps the user\'s servers and other keys', () => {
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ note: 'mine', mcpServers: { linear: { url: 'https://example.invalid/mcp' } } }));
    writeKimiProjectMcpConfig(directory, ENTRY);
    const config = readConfig() as { note: string; mcpServers: Record<string, unknown> };
    expect(config.note).toBe('mine');
    expect(Object.keys(config.mcpServers)).toEqual(['linear', 'kangentic']);
  });

  it('leaves a file it cannot read alone, and says so', () => {
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, '{ "mcpServers": { // a comment\n } }');
    expect(writeKimiProjectMcpConfig(directory, ENTRY)).toBe(false);
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('a comment');
    expect(kimiProjectMcpConfigProblem(directory)).toContain('not JSON');
  });

  it('reports no problem for a folder with no file', () => {
    expect(kimiProjectMcpConfigProblem(directory)).toBeNull();
  });

  it('leaves a file sitting where the folder would go alone, and says so', () => {
    // POSIX reads this as ENOTDIR and Windows as ENOENT. Taken for an absent
    // file, Windows reached the mkdir and blocked the spawn.
    fs.writeFileSync(path.dirname(configPath), 'not a folder');
    expect(writeKimiProjectMcpConfig(directory, ENTRY)).toBe(false);
    expect(fs.readFileSync(path.dirname(configPath), 'utf-8')).toBe('not a folder');
    expect(kimiProjectMcpConfigProblem(directory)).toContain('not JSON');
  });
});

describe('removeKimiProjectMcpConfig', () => {
  it('removes a file holding only our entry', () => {
    writeKimiProjectMcpConfig(directory, ENTRY);
    removeKimiProjectMcpConfig(directory);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('keeps the user\'s servers', () => {
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { linear: { url: 'https://example.invalid/mcp' } } }));
    writeKimiProjectMcpConfig(directory, ENTRY);
    removeKimiProjectMcpConfig(directory);
    expect(Object.keys(readConfig().mcpServers ?? {})).toEqual(['linear']);
  });

  it('does nothing to a file with no entry of ours', () => {
    fs.mkdirSync(path.dirname(configPath));
    const original = JSON.stringify({ mcpServers: { linear: {} } });
    fs.writeFileSync(configPath, original);
    removeKimiProjectMcpConfig(directory);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('rewrites the file without mcpServers when other keys remain', () => {
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ note: 'mine', mcpServers: { kangentic: ENTRY } }));
    removeKimiProjectMcpConfig(directory);
    expect(readConfig()).toEqual({ note: 'mine' });
  });
});

describe('the local git exclude', () => {
  let excludePath: string;

  beforeEach(() => {
    fs.mkdirSync(path.join(directory, '.git'));
    excludePath = path.join(directory, '.git', 'info', 'exclude');
  });

  it('lists a file Kangentic created', () => {
    writeKimiProjectMcpConfig(directory, ENTRY);
    expect(fs.readFileSync(excludePath, 'utf-8')).toContain('.kimi-code/mcp.json');
  });

  it('does not list a file the user already had', () => {
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { linear: {} } }));
    writeKimiProjectMcpConfig(directory, ENTRY);
    expect(fs.existsSync(excludePath)).toBe(false);
  });
});

describe('writing the same entry again', () => {
  it('leaves the file unwritten', () => {
    writeKimiProjectMcpConfig(directory, ENTRY);
    const pinnedSeconds = 1_000_000;
    fs.utimesSync(configPath, pinnedSeconds, pinnedSeconds);
    expect(writeKimiProjectMcpConfig(directory, ENTRY)).toBe(true);
    expect(fs.statSync(configPath).mtimeMs).toBe(pinnedSeconds * 1000);
  });

  it('replaces a different entry a second session wrote', () => {
    writeKimiProjectMcpConfig(directory, ENTRY);
    const secondEntry = { url: 'http://127.0.0.1:9001/mcp/other', bearerTokenEnvVar: 'KANGENTIC_MCP_TOKEN' };
    writeKimiProjectMcpConfig(directory, secondEntry);
    expect(readConfig().mcpServers?.kangentic).toEqual(secondEntry);
  });
});

describe('a write that fails', () => {
  function failWrites(): void {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    });
  }

  it('throws from writeKimiProjectMcpConfig, so the spawn is reported', () => {
    failWrites();
    expect(() => writeKimiProjectMcpConfig(directory, ENTRY)).toThrow('permission denied');
  });

  it('throws from buildCommand, so the spawn is reported', () => {
    failWrites();
    expect(() => new KimiAdapter().buildCommand(wiredOptions('session-1'))).toThrow('permission denied');
  });
});

function wiredOptions(ptySessionId: string, url = ENTRY.url): SpawnCommandOptions {
  return {
    agentPath: '/usr/bin/kimi',
    taskId: 'task-1',
    cwd: directory,
    permissionMode: 'default',
    shell: 'bash',
    ptySessionId,
    mcpServerEnabled: true,
    mcpServerUrl: url,
    mcpServerToken: 'token-1',
    statusOutputPath: path.join(directory, 'session', 'status.json'),
  };
}

describe('KimiAdapter MCP wiring', () => {
  it('warns and writes no file when the status path is missing', () => {
    const options = { ...wiredOptions('session-1'), statusOutputPath: undefined };
    new KimiAdapter().buildCommand(options);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('statusOutputPath is missing'));
    expect(fs.existsSync(path.join(directory, '.kimi-code'))).toBe(false);
  });

  it('lets a second session\'s different URL replace the first\'s', () => {
    const adapter = new KimiAdapter();
    adapter.buildCommand(wiredOptions('session-1'));
    const secondUrl = 'http://127.0.0.1:9001/mcp/other';
    adapter.buildCommand(wiredOptions('session-2', secondUrl));
    expect(readConfig().mcpServers?.kangentic).toEqual({ url: secondUrl, bearerTokenEnvVar: 'KANGENTIC_MCP_TOKEN' });
  });

  it('strips the entry for a release with no session id, whoever holds it', () => {
    const adapter = new KimiAdapter();
    adapter.buildCommand(wiredOptions('session-1'));
    adapter.buildCommand(wiredOptions('session-2'));
    adapter.removeHooks(directory);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('reports a file it cannot merge into, and nothing for a clean folder', () => {
    const adapter = new KimiAdapter();
    expect(adapter.kangenticMcpBlockedReason(directory)).toBeNull();
    fs.mkdirSync(path.dirname(configPath));
    fs.writeFileSync(configPath, '{ not json');
    expect(adapter.kangenticMcpBlockedReason(directory)).toContain('not JSON');
  });
});

describe('kimiMcpWiringEnabled', () => {
  const wired = { mcpServerUrl: ENTRY.url, mcpServerToken: 'token-1' };

  it('treats an unset mcpServerEnabled as enabled', () => {
    expect(kimiMcpWiringEnabled({ ...wired, mcpServerEnabled: undefined })).toBe(true);
  });

  it('is off when disabled, or without a URL or a token', () => {
    expect(kimiMcpWiringEnabled({ ...wired, mcpServerEnabled: false })).toBe(false);
    expect(kimiMcpWiringEnabled({ mcpServerToken: 'token-1' })).toBe(false);
    expect(kimiMcpWiringEnabled({ mcpServerUrl: ENTRY.url })).toBe(false);
  });
});
