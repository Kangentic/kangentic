/**
 * The edges of drafting a commit message or a pull request description
 * (src/main/git-actions/draft-text.ts), beside git-draft-text.test.ts: what a new
 * file that is not a plain file may put in the prompt, drafts of one folder that
 * must not trade places, and a reply that says nothing. Real git; only the agent's
 * answer path is replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  answer: vi.fn(async (_prompt: string, ..._rest: unknown[]): Promise<string> => 'feat: drafted'),
}));

vi.mock('../../src/main/automations/automation-agent', () => ({
  resolveAutomationAgent: async () => ({
    ok: true, agentName: 'claude', cliPath: '/cli', model: 'small', effort: null, adapter: { answerFromContext: mocks.answer },
  }),
}));
vi.mock('../../src/main/ipc/helpers/automation-agent-deps', () => ({ automationAgentDeps: () => ({}) }));
vi.mock('../../src/main/ipc/helpers/background-call-sink', () => ({ backgroundCallSink: () => () => undefined }));
vi.mock('../../src/main/background-calls/record-background-call', () => ({
  startRecordedCall: (_sink: unknown, _meta: unknown, run: (onUsage: () => void) => Promise<string>) => ({ done: run(() => undefined) }),
}));
vi.mock('../../src/main/agent/shared/answer-run-directory', () => ({
  ensureAnswerHomeDirectory: async () => '/answer-home',
  withAnswerRunDirectory: (run: (directory: string) => Promise<string>) => run('/answer-run'),
}));
vi.mock('../../src/main/pr/pr-registry', () => ({ canCreatePullRequest: async () => false }));

import { draftGitText, resetGitDraftsForTests } from '../../src/main/git-actions/draft-text';
import type { ResolvedGitTarget } from '../../src/main/git-actions/action-target';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { GitDraftInput } from '../../src/shared/git-work-state';

const SECRET = 'SECRET-OUTSIDE-THE-CHECKOUT';

let root: string;
let checkout: string;
let outside: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function target(): ResolvedGitTarget {
  return {
    target: { kind: 'task', taskId: 'task-1' },
    projectId: 'project-1',
    projectPath: checkout,
    directory: checkout,
    task: { id: 'task-1', title: 'Mark git state', description: 'Say what is not pushed', swimlane_id: 'lane-1' } as ResolvedGitTarget['task'],
    baseBranch: 'main',
    sessionId: null,
  };
}

const draft = (input: GitDraftInput) => draftGitText({} as IpcContext, target(), input);
const lastPrompt = (): string => String(mocks.answer.mock.calls.at(-1)?.[0]);

/** A link to `linked`, or false where this account may not make one (Windows without developer mode). */
function link(linked: string, name: string, type: 'file' | 'dir' | 'junction'): boolean {
  try {
    // 'file' and 'dir' are real symbolic links on every platform, and 'junction' is one off Windows.
    // On Windows a junction is a folder to git, which lists what is inside it.
    fs.symlinkSync(linked, path.join(checkout, name), type);
    return true;
  } catch (error) {
    // A test that cannot make a link is skipped by its caller.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
    throw error;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-draft-edges-'));
  checkout = path.join(root, 'repo');
  outside = path.join(root, 'outside');
  fs.mkdirSync(checkout);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), `${SECRET}\n`);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Dev');
  git('config', 'user.email', 'dev@example.com');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(checkout, 'base.txt'), 'before\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: the house style');
  git('checkout', '-q', '-b', 'task-branch');
  mocks.answer.mockReset();
  mocks.answer.mockResolvedValue('feat: drafted');
  resetGitDraftsForTests();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a new file that is not a plain file', () => {
  it('is named but never quoted when it is a link to a file outside the checkout', async ({ skip }) => {
    if (!link(path.join(outside, 'secret.txt'), 'linked-key.txt', 'file')) skip();
    fs.writeFileSync(path.join(checkout, 'plain.txt'), 'a plain new line\n');
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'feat: drafted', drafted: true });
    expect(lastPrompt()).toContain('linked-key.txt');
    expect(lastPrompt()).toContain('a plain new line');
    expect(lastPrompt()).not.toContain(SECRET);
  });

  it('answers for a link to a directory without reading into it', async ({ skip }) => {
    if (!link(outside, 'linked-folder', 'dir')) skip();
    fs.writeFileSync(path.join(checkout, 'plain.txt'), 'a plain new line\n');
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'feat: drafted', drafted: true });
    expect(lastPrompt()).toContain('a plain new line');
    expect(lastPrompt()).not.toContain(SECRET);
  });

  it('is never quoted from behind a folder junction that leads outside the checkout', async ({ skip }) => {
    if (!link(outside, 'junction', 'junction')) skip();
    fs.writeFileSync(path.join(checkout, 'plain.txt'), 'a plain new line\n');
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'feat: drafted', drafted: true });
    expect(lastPrompt()).toContain('a plain new line');
    expect(lastPrompt()).not.toContain(SECRET);
  });

  it.runIf(process.platform !== 'win32')('answers with a named pipe in the folder, which would never be read to its end', async () => {
    execFileSync('mkfifo', [path.join(checkout, 'pipe')]);
    fs.writeFileSync(path.join(checkout, 'plain.txt'), 'a plain new line\n');
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'feat: drafted', drafted: true });
    expect(lastPrompt()).toContain('a plain new line');
  }, 10_000);
});

describe('drafts kept for one folder', () => {
  it('keeps a commit message and a pull request description apart', async () => {
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'after\n');
    git('commit', '-q', '-am', 'feat: the work');
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'after again\n');
    mocks.answer.mockImplementation(async (prompt: string) => (
      prompt.startsWith('Write the commit message') ? 'feat: the commit text' : 'The pull request text'
    ));
    const commitInput: GitDraftInput = { kind: 'commit-message' };
    const pullRequestInput: GitDraftInput = { kind: 'pull-request-description', baseBranch: 'main' };

    expect(await draft(commitInput)).toEqual({ text: 'feat: the commit text', drafted: true });
    expect(await draft(pullRequestInput)).toEqual({ text: 'The pull request text', drafted: true });
    expect(mocks.answer).toHaveBeenCalledTimes(2);

    // Reopening either dialog spends nothing and still gets its own text.
    expect(await draft(commitInput)).toEqual({ text: 'feat: the commit text', drafted: true });
    expect(await draft(pullRequestInput)).toEqual({ text: 'The pull request text', drafted: true });
    expect(mocks.answer).toHaveBeenCalledTimes(2);
  });
});

describe('a reply with nothing in it', () => {
  it('falls back to the task\'s title, and is asked again rather than kept', async () => {
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'after\n');
    mocks.answer.mockResolvedValueOnce('  \n```\n\n```\n ');
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'Mark git state', drafted: false });
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'feat: drafted', drafted: true });
    expect(mocks.answer).toHaveBeenCalledTimes(2);
  });
});
