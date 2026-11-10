/**
 * Where Kangentic finds Claude's home and its state file. A user who runs Claude with
 * `CLAUDE_CONFIG_DIR` keeps `.claude.json` inside that folder, and Kangentic used to write
 * `~/.claude.json` whatever the variable said: trust and the diff-panel key landed in a file that
 * user's Claude never read, and a run pointed at a temp home still wrote the real one. What a user
 * loses if this goes: a trust prompt on every Kangentic session, and writes to a home they did
 * not point Kangentic at.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeHomeDir, claudeJsonPath, claudeStatePathForHome } from '../../src/main/agent/adapters/claude/claude-json-lock';
import { ensureDiffPanelClosed } from '../../src/main/agent/adapters/claude/diff-panel';

let configDir: string;
let previous: string | undefined;

beforeEach(() => {
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-home-'));
  previous = process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  fs.rmSync(configDir, { recursive: true, force: true });
});

describe('Claude\'s home on this machine', () => {
  it('is ~/.claude with its state file beside it when no config dir is inherited', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeHomeDir()).toBe(path.join(os.homedir(), '.claude'));
    expect(claudeJsonPath()).toBe(path.join(os.homedir(), '.claude.json'));
  });

  it('is the inherited config dir, with the state file inside it', () => {
    process.env.CLAUDE_CONFIG_DIR = configDir;
    expect(claudeHomeDir()).toBe(path.resolve(configDir));
    expect(claudeJsonPath()).toBe(path.join(path.resolve(configDir), '.claude.json'));
  });

  it('keeps the state file beside ~/.claude when the variable names that folder itself', () => {
    expect(claudeStatePathForHome(path.join(os.homedir(), '.claude'))).toBe(path.join(os.homedir(), '.claude.json'));
  });

  it('writes the diff-panel key into the inherited config dir\'s state file', async () => {
    process.env.CLAUDE_CONFIG_DIR = configDir;
    await ensureDiffPanelClosed();
    const written = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8')) as { diffSidebarOpen?: boolean };
    expect(written.diffSidebarOpen).toBe(false);
  });
});
