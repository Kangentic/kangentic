/**
 * browser-servers.ts, how a Claude session's browser MCP servers are found
 * (task #977). The browser policy hook denies a server by the name its tools
 * carry, so a server missed here is a server the agent can still drive.
 *
 * What it pins, against real files: the local-scope server in a realistic
 * `~/.claude.json` is found under Claude's own project key (forward slashes on
 * Windows, compared without case there; the distro's Linux path in WSL, read
 * from the distro's home), another project's servers are not, and an edit to
 * the file is seen on the next call despite the per-file cache.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeBrowserServerNames } from '../../src/main/agent/adapters/claude/browser-servers';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

const REALISTIC_CLAUDE_JSON = path.resolve(__dirname, '../fixtures/claude-json-realistic.json');
const SITE_KEY = 'C:/Users/dev/Documents/GitHub/site';

let workspace: string;
let homeDir: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-browser-servers-'));
  homeDir = path.join(workspace, 'home');
  fs.mkdirSync(homeDir, { recursive: true });
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(workspace, { recursive: true, force: true });
});

function wslPlace(homeUnc: string): CliPlace {
  return {
    kind: 'wsl',
    distro: 'Ubuntu',
    facts: {
      distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc,
      uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
    },
  };
}

function browserServerJson(command: string): { command: string; args: string[] } {
  return { command: 'npx', args: [command] };
}

describe('claudeBrowserServerNames: a realistic ~/.claude.json', () => {
  beforeEach(() => {
    fs.copyFileSync(REALISTIC_CLAUDE_JSON, path.join(homeDir, '.claude.json'));
  });

  it.runIf(process.platform === 'win32')('finds the local-scope server for a backslash cwd in a different drive-letter case', () => {
    const names = claudeBrowserServerNames({ cwd: 'c:\\Users\\dev\\Documents\\GitHub\\site', place: null });
    expect(names).toContain('e2e-browser');
    // Another project's browser server, and a non-browser user server, are not this session's.
    expect(names).not.toContain('old-browser');
    expect(names).not.toContain('context7');
  });

  it.skipIf(process.platform === 'win32')('finds the local-scope server under its exact key, and not under a different case', () => {
    expect(claudeBrowserServerNames({ cwd: SITE_KEY, place: null })).toContain('e2e-browser');
    expect(claudeBrowserServerNames({ cwd: SITE_KEY.replace('C:', 'c:'), place: null })).not.toContain('e2e-browser');
    expect(claudeBrowserServerNames({ cwd: SITE_KEY, place: null })).not.toContain('old-browser');
  });

  it('adds nothing for a project the file has no server for', () => {
    expect(claudeBrowserServerNames({ cwd: 'C:/Users/dev/Documents/GitHub/other-app', place: null })).toEqual(['claude-in-chrome']);
  });
});

describe('claudeBrowserServerNames: a WSL place', () => {
  it('reads the distro\'s home and keys the project by the path the distro sees', () => {
    const distroHome = path.join(workspace, 'distro-home');
    fs.mkdirSync(distroHome, { recursive: true });
    fs.writeFileSync(path.join(distroHome, '.claude.json'), JSON.stringify({
      projects: {
        '/mnt/c/Users/dev/site': { mcpServers: { 'wsl-browser': browserServerJson('@playwright/mcp@latest') } },
        '/mnt/C/Users/dev/site': { mcpServers: { 'wrong-case': browserServerJson('@playwright/mcp@latest') } },
      },
    }));
    // The Windows home holds a browser server too: a WSL Claude never reads it.
    fs.writeFileSync(path.join(homeDir, '.claude.json'), JSON.stringify({
      mcpServers: { 'windows-browser': browserServerJson('@playwright/mcp@latest') },
    }));

    const names = claudeBrowserServerNames({ cwd: 'C:\\Users\\dev\\site', place: wslPlace(distroHome) });

    expect(names).toContain('wsl-browser');
    expect(names).not.toContain('windows-browser');
    // A WSL key is compared exactly, as Linux paths are.
    expect(names).not.toContain('wrong-case');
  });
});

describe('claudeBrowserServerNames: edits to ~/.claude.json', () => {
  it('returns the new list after the file is rewritten with a different size', () => {
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { first: browserServerJson('@playwright/mcp') } }));
    expect(claudeBrowserServerNames({ cwd: workspace, place: null })).toContain('first');

    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      mcpServers: { second: browserServerJson('chrome-devtools-mcp'), third: browserServerJson('@playwright/mcp') },
    }));

    const names = claudeBrowserServerNames({ cwd: workspace, place: null });
    expect(names).toEqual(expect.arrayContaining(['second', 'third']));
    expect(names).not.toContain('first');
  });

  it('returns the new list when only the modification time changed', () => {
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    const startTime = new Date('2026-01-01T00:00:00Z');
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { alpha: browserServerJson('@playwright/mcp') } }));
    fs.utimesSync(claudeJsonPath, startTime, startTime);
    expect(claudeBrowserServerNames({ cwd: workspace, place: null })).toContain('alpha');

    // Same byte length, so only the modification time tells the two apart.
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { omega: browserServerJson('@playwright/mcp') } }));
    const laterTime = new Date(startTime.getTime() + 60_000);
    fs.utimesSync(claudeJsonPath, laterTime, laterTime);

    const names = claudeBrowserServerNames({ cwd: workspace, place: null });
    expect(names).toContain('omega');
    expect(names).not.toContain('alpha');
  });

  it('drops the servers when the file is deleted', () => {
    const claudeJsonPath = path.join(homeDir, '.claude.json');
    fs.writeFileSync(claudeJsonPath, JSON.stringify({ mcpServers: { gone: browserServerJson('@playwright/mcp') } }));
    expect(claudeBrowserServerNames({ cwd: workspace, place: null })).toContain('gone');

    fs.rmSync(claudeJsonPath);

    expect(claudeBrowserServerNames({ cwd: workspace, place: null })).toEqual(['claude-in-chrome']);
  });
});
