/**
 * Task #1070: Claude refuses a plan file Write, and prompts for an auto memory Write, through an
 * account folder's link into `~/.claude` (measured on 2.1.322). So an account keeps its own
 * `plans` folder, a resume carries the conversation's plan file into the home it runs on, and an
 * account session names its memory folder by its real path in the default home.
 *
 * What a user loses without these: a plan the board cannot approve after a Switch to or a
 * continuation (ExitPlanMode opened with no plan), an older plan overwriting the newer one, or
 * memory split across accounts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAUDE_ACCOUNT_SUPPORT } from '../../src/main/agent/adapters/claude/accounts';
import { carryClaudePlanFiles, readTranscriptSlug } from '../../src/main/agent/adapters/claude/plan-carry';
import { accountAutoMemoryDirectory, claudeMemoryProjectFolder } from '../../src/main/agent/adapters/claude/auto-memory-folder';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';
import { claudeHomeDir } from '../../src/main/agent/adapters/claude/claude-json-lock';
import { CommandBuilder } from '../../src/main/agent/adapters/claude';
import type { CommandOptions } from '../../src/main/agent/agent-adapter';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';

/**
 * A sanitized transcript in the shape Claude Code 2.1.322 writes (key order measured from a real
 * transcript, every value synthetic): the slug sits on the message lines, and a request-body line
 * carries a `slug` only as a tool call's input.
 */
const SLUG_TRANSCRIPT_FIXTURE = path.join(__dirname, '..', 'fixtures', 'claude-transcript-slug.jsonl');

let root: string;
let defaultHome: string;
let accountTwo: string;
let accountThree: string;
let cwd: string;

const SESSION_ID = 'b1f0c3a2-0000-4000-8000-000000000001';

function write(filePath: string, content: string, modifiedSeconds?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  if (modifiedSeconds !== undefined) fs.utimesSync(filePath, modifiedSeconds, modifiedSeconds);
}

function writeTranscript(slug: string): void {
  const line = (type: string): string => JSON.stringify({ type, sessionId: SESSION_ID, slug });
  write(path.join(defaultHome, 'projects', claudeProjectSlug(cwd), `${SESSION_ID}.jsonl`), `${line('user')}\n${line('assistant')}\n`);
}

function carryInto(toHome: string): Promise<void> {
  return carryClaudePlanFiles({ agentSessionId: SESSION_ID, cwd, defaultHome, toHome, homes: [defaultHome, accountTwo, accountThree] });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-plans-memory-'));
  defaultHome = path.join(root, 'home');
  accountTwo = path.join(root, 'accounts', 'claude', '2');
  accountThree = path.join(root, 'accounts', 'claude', '3');
  cwd = path.join(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the Claude account folder', () => {
  it('keeps plans as its own folder and links every other conversation folder', () => {
    const plans = CLAUDE_ACCOUNT_SUPPORT.sharedEntries.filter((entry) => entry.name === 'plans');
    expect(plans).toEqual([{ name: 'plans', how: 'own-dir' }]);
    const projects = CLAUDE_ACCOUNT_SUPPORT.sharedEntries.find((entry) => entry.name === 'projects');
    expect(projects).toEqual({ name: 'projects', how: 'link-dir', conversationBearing: true });
  });
});

describe('carryClaudePlanFiles', () => {
  it('copies the newest copy of the plan and its subagent plans into the account a resume lands on', async () => {
    writeTranscript('calm-river');
    write(path.join(defaultHome, 'plans', 'calm-river.md'), 'older', 1_000);
    write(path.join(accountThree, 'plans', 'calm-river.md'), 'newer', 2_000);
    write(path.join(accountThree, 'plans', 'calm-river-agent-a1.md'), 'subagent', 2_000);
    write(path.join(accountThree, 'plans', 'other-plan.md'), 'not this conversation', 2_000);

    await carryInto(accountTwo);

    expect(fs.readFileSync(path.join(accountTwo, 'plans', 'calm-river.md'), 'utf8')).toBe('newer');
    expect(fs.readFileSync(path.join(accountTwo, 'plans', 'calm-river-agent-a1.md'), 'utf8')).toBe('subagent');
    expect(fs.existsSync(path.join(accountTwo, 'plans', 'other-plan.md'))).toBe(false);
  });

  it('replaces an older copy in an account folder and keeps a newer one', async () => {
    writeTranscript('calm-river');
    write(path.join(defaultHome, 'plans', 'calm-river.md'), 'from home', 2_000);
    write(path.join(accountTwo, 'plans', 'calm-river.md'), 'stale', 1_000);
    await carryInto(accountTwo);
    expect(fs.readFileSync(path.join(accountTwo, 'plans', 'calm-river.md'), 'utf8')).toBe('from home');

    write(path.join(accountThree, 'plans', 'calm-river.md'), 'newest', 3_000);
    write(path.join(defaultHome, 'plans', 'calm-river.md'), 'older again', 2_500);
    await carryInto(accountThree);
    expect(fs.readFileSync(path.join(accountThree, 'plans', 'calm-river.md'), 'utf8')).toBe('newest');
  });

  it('adds a missing plan to the default home but never replaces one there', async () => {
    writeTranscript('calm-river');
    write(path.join(accountThree, 'plans', 'calm-river.md'), 'from account', 2_000);
    await carryInto(defaultHome);
    expect(fs.readFileSync(path.join(defaultHome, 'plans', 'calm-river.md'), 'utf8')).toBe('from account');

    write(path.join(accountThree, 'plans', 'calm-river.md'), 'revised on the account', 3_000);
    await carryInto(defaultHome);
    expect(fs.readFileSync(path.join(defaultHome, 'plans', 'calm-river.md'), 'utf8')).toBe('from account');
  });

  it('copies nothing for a conversation with no transcript or no slug', async () => {
    write(path.join(accountThree, 'plans', 'calm-river.md'), 'plan', 2_000);
    await carryInto(accountTwo);
    expect(fs.existsSync(path.join(accountTwo, 'plans'))).toBe(false);

    write(path.join(defaultHome, 'projects', claudeProjectSlug(cwd), `${SESSION_ID}.jsonl`), '{"type":"user"}\n');
    await carryInto(accountTwo);
    expect(fs.existsSync(path.join(accountTwo, 'plans'))).toBe(false);
  });

  it('reads the last slug from the transcript tail and refuses one that is not a plain name', async () => {
    const transcript = path.join(root, 'transcript.jsonl');
    write(transcript, `${JSON.stringify({ slug: 'first-name' })}\n${JSON.stringify({ slug: 'second-name' })}\n`);
    expect(await readTranscriptSlug(transcript)).toBe('second-name');
    write(transcript, `${JSON.stringify({ slug: '../../escape' })}\n`);
    expect(await readTranscriptSlug(transcript)).toBeNull();
  });

  it('reads the conversation slug from a real-shape transcript, not the slug a tool call carried', async () => {
    expect(await readTranscriptSlug(SLUG_TRANSCRIPT_FIXTURE)).toBe('quiet-harbor-maple');
  });

  it('finds the slug behind a last line larger than the first tail window', async () => {
    const transcript = path.join(root, 'big-tail.jsonl');
    const slugLine = JSON.stringify({ type: 'assistant', sessionId: SESSION_ID, slug: 'calm-river' });
    const blobLine = JSON.stringify({ type: 'api-request-blob', sessionId: SESSION_ID, body: 'x'.repeat(300 * 1024) });
    write(transcript, `${slugLine}\n${blobLine}\n`);
    expect(await readTranscriptSlug(transcript)).toBe('calm-river');
  });

  it('does not look for a slug beyond the second tail window', async () => {
    const transcript = path.join(root, 'too-deep.jsonl');
    const slugLine = JSON.stringify({ type: 'assistant', sessionId: SESSION_ID, slug: 'calm-river' });
    const fillerLine = JSON.stringify({ type: 'api-request-blob', sessionId: SESSION_ID, body: 'x'.repeat(1024 * 1024) });
    write(transcript, `${slugLine}\n${`${fillerLine}\n`.repeat(5)}`);
    expect(await readTranscriptSlug(transcript)).toBeNull();
  });

  it('copies only the conversation plan and its subagent plans, not look-alike names or folders', async () => {
    writeTranscript('calm-river');
    write(path.join(defaultHome, 'plans', 'calm-river.md'), 'the plan', 1_000);
    write(path.join(accountThree, 'plans', 'calm-river-2.md'), 'sibling', 2_000);
    write(path.join(accountThree, 'plans', 'calm-rivers.md'), 'sibling', 2_000);
    write(path.join(accountThree, 'plans', 'calm-river-agent-a1.txt'), 'wrong extension', 2_000);
    // A folder with the plan's name, newer than the real file, must not win or be copied.
    fs.mkdirSync(path.join(accountThree, 'plans', 'calm-river.md'), { recursive: true });
    fs.utimesSync(path.join(accountThree, 'plans', 'calm-river.md'), 3_000, 3_000);

    await carryInto(accountTwo);

    expect(fs.readdirSync(path.join(accountTwo, 'plans'))).toEqual(['calm-river.md']);
    expect(fs.readFileSync(path.join(accountTwo, 'plans', 'calm-river.md'), 'utf8')).toBe('the plan');
  });

  it('does not rewrite an account copy whose modified time equals the source', async () => {
    writeTranscript('calm-river');
    write(path.join(defaultHome, 'plans', 'calm-river.md'), 'from home', 2_000);
    write(path.join(accountTwo, 'plans', 'calm-river.md'), 'already here', 2_000);
    await carryInto(accountTwo);
    expect(fs.readFileSync(path.join(accountTwo, 'plans', 'calm-river.md'), 'utf8')).toBe('already here');
  });

  it('gives a copy its source modified time so a later carry picks the right winner', async () => {
    writeTranscript('calm-river');
    write(path.join(defaultHome, 'plans', 'calm-river.md'), 'from home', 2_000);
    await carryInto(accountTwo);
    const copiedMs = fs.statSync(path.join(accountTwo, 'plans', 'calm-river.md')).mtimeMs;
    expect(Math.abs(copiedMs - 2_000_000)).toBeLessThan(5);

    // The source is newer than the copy's source but older than a stamp of "now": only a copy
    // that kept the source time is replaced.
    write(path.join(defaultHome, 'plans', 'calm-river.md'), 'revised', 3_000);
    await carryInto(accountTwo);
    expect(fs.readFileSync(path.join(accountTwo, 'plans', 'calm-river.md'), 'utf8')).toBe('revised');
  });

  it('still carries the other plan files when one vanishes between the listing and the read', async () => {
    writeTranscript('calm-river');
    write(path.join(accountThree, 'plans', 'calm-river.md'), 'the plan', 2_000);
    const vanishing = path.join(accountThree, 'plans', 'calm-river-agent-a1.md');
    write(vanishing, 'gone before the read', 2_000);
    const realStat = fs.promises.stat.bind(fs.promises);
    const statSpy = vi.spyOn(fs.promises, 'stat').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => (
      String(target) === vanishing
        ? Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
        : (realStat as (...args: unknown[]) => Promise<fs.Stats>)(target, ...rest)
    )) as typeof fs.promises.stat);
    try {
      await carryInto(accountTwo);
    } finally {
      statSpy.mockRestore();
    }
    expect(fs.readdirSync(path.join(accountTwo, 'plans'))).toEqual(['calm-river.md']);
  });

  it('finds a transcript stored under another project folder', async () => {
    write(path.join(defaultHome, 'projects', 'some-other-project', `${SESSION_ID}.jsonl`), `${JSON.stringify({ type: 'user', slug: 'calm-river' })}\n`);
    write(path.join(accountThree, 'plans', 'calm-river.md'), 'plan', 2_000);
    await carryInto(accountTwo);
    expect(fs.readFileSync(path.join(accountTwo, 'plans', 'calm-river.md'), 'utf8')).toBe('plan');
  });

  it('copies nothing for a path-like conversation id', async () => {
    // Joined under projects/<slug>/, this id names projects/escape.jsonl, which exists.
    write(path.join(defaultHome, 'projects', 'escape.jsonl'), `${JSON.stringify({ type: 'user', slug: 'calm-river' })}\n`);
    write(path.join(accountThree, 'plans', 'calm-river.md'), 'plan', 2_000);
    await carryClaudePlanFiles({ agentSessionId: '../escape', cwd, defaultHome, toHome: accountTwo, homes: [defaultHome, accountTwo, accountThree] });
    expect(fs.existsSync(path.join(accountTwo, 'plans'))).toBe(false);
  });
});

describe('claudeMemoryProjectFolder', () => {
  it('names a folder outside git after itself, and a folder inside a repository after the repository', () => {
    expect(claudeMemoryProjectFolder(cwd)).toBe(path.resolve(cwd));
    fs.mkdirSync(path.join(cwd, '.git'));
    fs.mkdirSync(path.join(cwd, 'packages', 'app'), { recursive: true });
    expect(claudeMemoryProjectFolder(path.join(cwd, 'packages', 'app'))).toBe(path.resolve(cwd));
  });

  it('names a linked worktree after the main checkout, as Claude does', () => {
    const commonGit = path.join(cwd, '.git');
    const worktreeGit = path.join(commonGit, 'worktrees', 'feature');
    write(path.join(worktreeGit, 'commondir'), '../..\n');
    const worktree = path.join(root, 'worktrees', 'feature');
    write(path.join(worktree, '.git'), `gitdir: ${worktreeGit}\n`);
    expect(claudeMemoryProjectFolder(worktree)).toBe(path.resolve(cwd));
  });

  it('names a checkout whose git directory sits apart after the checkout, as Claude does', () => {
    const separate = path.join(root, 'separate.git');
    fs.mkdirSync(separate, { recursive: true });
    write(path.join(cwd, '.git'), `gitdir: ${separate}\n`);
    fs.mkdirSync(path.join(cwd, 'src'));
    expect(claudeMemoryProjectFolder(cwd)).toBe(path.resolve(cwd));
    expect(claudeMemoryProjectFolder(path.join(cwd, 'src'))).toBe(path.resolve(cwd));
  });

  it('cannot tell for a linked worktree of a repository whose git directory sits apart', () => {
    const separate = path.join(root, 'separate.git');
    const worktreeGit = path.join(separate, 'worktrees', 'feature');
    write(path.join(worktreeGit, 'commondir'), '../..\n');
    const worktree = path.join(root, 'worktrees', 'feature');
    write(path.join(worktree, '.git'), `gitdir: ${worktreeGit}\n`);
    expect(claudeMemoryProjectFolder(worktree)).toBeNull();
  });
});

describe('accountAutoMemoryDirectory', () => {
  it('names the default home memory folder for an account session, and nothing for the agent own home', () => {
    const expected = path.join(defaultHome, 'projects', claudeProjectSlug(path.resolve(cwd)), 'memory');
    expect(accountAutoMemoryDirectory({ accountFolder: accountTwo, defaultHome, cwd, baseSettings: {} })).toBe(expected);
    expect(accountAutoMemoryDirectory({ accountFolder: null, defaultHome, cwd, baseSettings: {} })).toBeNull();
  });

  it('leaves a memory folder the project or the user named alone', () => {
    expect(accountAutoMemoryDirectory({ accountFolder: accountTwo, defaultHome, cwd, baseSettings: { autoMemoryDirectory: '~/notes' } })).toBeNull();
    write(path.join(accountTwo, 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/my-memory' }));
    expect(accountAutoMemoryDirectory({ accountFolder: accountTwo, defaultHome, cwd, baseSettings: {} })).toBeNull();
  });

  it('still names the memory folder when the account settings.json cannot be read as JSON', () => {
    const expected = path.join(defaultHome, 'projects', claudeProjectSlug(path.resolve(cwd)), 'memory');
    // A half-written file, valid JSON that is not an object, and a folder where the file goes.
    write(path.join(accountTwo, 'settings.json'), '{"autoMemoryDirectory": ');
    expect(accountAutoMemoryDirectory({ accountFolder: accountTwo, defaultHome, cwd, baseSettings: {} })).toBe(expected);
    write(path.join(accountTwo, 'settings.json'), '[]');
    expect(accountAutoMemoryDirectory({ accountFolder: accountTwo, defaultHome, cwd, baseSettings: {} })).toBe(expected);
    fs.rmSync(path.join(accountTwo, 'settings.json'));
    fs.mkdirSync(path.join(accountTwo, 'settings.json'));
    expect(accountAutoMemoryDirectory({ accountFolder: accountTwo, defaultHome, cwd, baseSettings: {} })).toBe(expected);
  });

  it('reaches the session settings file through the real command builder only for a folder account', () => {
    const build = (sessionName: string, account: { id: string; agent: string; kind: 'folder' | 'default'; env: Record<string, string> }): Record<string, unknown> => {
      const sessionDir = path.join(cwd, '.kangentic', 'sessions', sessionName);
      new CommandBuilder().buildClaudeCommand({
        cliPath: 'claude',
        taskId: 'memory-task',
        cwd,
        permissionMode: 'acceptEdits',
        sessionId: sessionName,
        statusOutputPath: path.join(sessionDir, 'status.json'),
        account,
      });
      return JSON.parse(fs.readFileSync(path.join(sessionDir, 'settings.json'), 'utf-8')) as Record<string, unknown>;
    };
    const onAccount = build('on-account', { id: 'account-2', agent: 'claude', kind: 'folder', env: { CLAUDE_CONFIG_DIR: accountTwo } });
    expect(onAccount.autoMemoryDirectory).toBe(path.join(claudeHomeDir(), 'projects', claudeProjectSlug(path.resolve(cwd)), 'memory'));
    const onOwnHome = build('on-home', { id: 'account-1', agent: 'claude', kind: 'default', env: {} });
    expect(onOwnHome.autoMemoryDirectory).toBeUndefined();
  });

  describe('through the real command builder, it sets none', () => {
    const buildSettings = (sessionName: string, overrides: Partial<CommandOptions>): Record<string, unknown> => {
      const sessionDir = path.join(cwd, '.kangentic', 'sessions', sessionName);
      new CommandBuilder().buildClaudeCommand({
        cliPath: 'claude',
        taskId: 'memory-skip-task',
        cwd,
        permissionMode: 'acceptEdits',
        sessionId: sessionName,
        statusOutputPath: path.join(sessionDir, 'status.json'),
        ...overrides,
      });
      return JSON.parse(fs.readFileSync(path.join(sessionDir, 'settings.json'), 'utf-8')) as Record<string, unknown>;
    };
    const folderAccount = (env: Record<string, string>): NonNullable<CommandOptions['account']> => ({ id: 'account-2', agent: 'claude', kind: 'folder', env });

    it('for a Claude running in a WSL distro', () => {
      const distroHome = path.join(root, 'distro-home');
      fs.mkdirSync(distroHome, { recursive: true });
      const place: CliTarget = {
        kind: 'wsl',
        distro: 'Ubuntu',
        linuxCliPath: '/home/dev/.local/bin/claude',
        facts: {
          distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome,
          uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
        },
      };
      const settings = buildSettings('on-wsl', { account: folderAccount({ CLAUDE_CONFIG_DIR: accountTwo }), cliTarget: place });
      expect(settings.autoMemoryDirectory).toBeUndefined();
    });

    it('over a memory folder the project settings name', () => {
      write(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({ autoMemoryDirectory: '~/project-notes' }));
      const settings = buildSettings('project-names-one', { account: folderAccount({ CLAUDE_CONFIG_DIR: accountTwo }) });
      expect(settings.autoMemoryDirectory).toBe('~/project-notes');
    });

    it('for a folder account whose environment has no config directory', () => {
      const settings = buildSettings('no-config-dir', { account: folderAccount({}) });
      expect(settings.autoMemoryDirectory).toBeUndefined();
    });
  });
});
