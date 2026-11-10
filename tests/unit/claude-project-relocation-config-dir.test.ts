/**
 * With `CLAUDE_CONFIG_DIR` set (the home of a Claude run on one account), a project relocation
 * moves that folder's transcripts under `projects/` and rewrites that folder's `.claude.json`.
 * The user's own `~/.claude` and `~/.claude.json` are left untouched. What a user loses if this
 * goes: a relocated project's conversations on that Claude home fail to resume, while the home
 * they did not point Kangentic at is edited.
 *
 * Red-green: reading `~/.claude.json` or `~/.claude/projects` instead of the inherited folder
 * fails both cases, because the fixture seeds only the inherited folder with something to move
 * and seeds the real-home stand-in with a sentinel that must not change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...actual,
    default: { ...actual, homedir: () => tmpHome },
    homedir: () => tmpHome,
  };
});

import { migrateClaudeProjectData } from '../../src/main/agent/adapters/claude/project-relocation';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import { toForwardSlash } from '../../src/shared/paths';

let configDir: string;
let projectsParent: string;
let previousConfigDir: string | undefined;
let oldPath: string;
let newPath: string;

function projectKey(projectPath: string): string {
  return toForwardSlash(path.resolve(projectPath));
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relocate-home-'));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relocate-account-'));
  projectsParent = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-relocate-proj-'));
  oldPath = path.join(projectsParent, 'old-app');
  newPath = path.join(projectsParent, 'new-app');
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectsParent, { recursive: true, force: true });
});

describe('migrateClaudeProjectData with CLAUDE_CONFIG_DIR set', () => {
  it('renames the transcript folder under the inherited config dir, not under ~/.claude', async () => {
    const oldSlug = claudeProjectSlug(path.resolve(oldPath));
    const newSlug = claudeProjectSlug(path.resolve(newPath));
    fs.mkdirSync(path.join(configDir, 'projects', oldSlug), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'projects', oldSlug, 'session.jsonl'), '{"a":1}\n');
    // The same project's transcripts on the real home: they belong to another Claude and stay put.
    fs.mkdirSync(path.join(tmpHome, '.claude', 'projects', oldSlug), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.claude', 'projects', oldSlug, 'session.jsonl'), '{"b":2}\n');

    await migrateClaudeProjectData(oldPath, newPath);

    expect(fs.readFileSync(path.join(configDir, 'projects', newSlug, 'session.jsonl'), 'utf-8')).toBe('{"a":1}\n');
    expect(fs.existsSync(path.join(configDir, 'projects', oldSlug))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'projects', oldSlug, 'session.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.claude', 'projects', newSlug))).toBe(false);
  });

  it('rewrites the project key in the config dir\'s .claude.json and leaves ~/.claude.json alone', async () => {
    fs.writeFileSync(
      path.join(configDir, '.claude.json'),
      JSON.stringify({ projects: { [projectKey(oldPath)]: { hasTrustDialogAccepted: true } } }),
    );
    const homeJson = JSON.stringify({ projects: { [projectKey(oldPath)]: { hasTrustDialogAccepted: false } } });
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), homeJson);

    await migrateClaudeProjectData(oldPath, newPath);

    const rewritten = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf-8')) as { projects: Record<string, unknown> };
    expect(Object.keys(rewritten.projects)).toEqual([projectKey(newPath)]);
    expect(rewritten.projects[projectKey(newPath)]).toEqual({ hasTrustDialogAccepted: true });
    expect(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8')).toBe(homeJson);
  });
});
