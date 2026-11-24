/**
 * Drafting a commit message or a pull request description (src/main/git-actions/draft-text.ts):
 * what the agent is shown, what a reopened dialog spends, and what stands in with no agent. The
 * diff comes from real git; the agent's answer path is the one thing replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  answer: vi.fn(async (_prompt: string, ..._rest: unknown[]): Promise<string> => 'feat: drafted'),
  agentOk: true,
  recorded: [] as Array<{ job: string; taskId: string | null }>,
}));

vi.mock('../../src/main/automations/automation-agent', () => ({
  resolveAutomationAgent: async () => (mocks.agentOk
    ? { ok: true, agentName: 'claude', cliPath: '/cli', model: 'small', effort: null, adapter: { answerFromContext: mocks.answer } }
    : { ok: false, reason: 'none', cause: 'unavailable' }),
}));
vi.mock('../../src/main/ipc/helpers/automation-agent-deps', () => ({ automationAgentDeps: () => ({}) }));
vi.mock('../../src/main/ipc/helpers/background-call-sink', () => ({ backgroundCallSink: () => () => undefined }));
vi.mock('../../src/main/background-calls/record-background-call', () => ({
  startRecordedCall: (_sink: unknown, meta: { job: string; taskId: string | null }, run: (onUsage: () => void) => Promise<string>) => {
    mocks.recorded.push({ job: meta.job, taskId: meta.taskId });
    return { done: run(() => undefined) };
  },
}));
vi.mock('../../src/main/agent/shared/answer-run-directory', () => ({
  ensureAnswerHomeDirectory: async () => '/answer-home',
  withAnswerRunDirectory: (run: (directory: string) => Promise<string>) => run('/answer-run'),
}));
vi.mock('../../src/main/pr/pr-registry', () => ({ canCreatePullRequest: async () => false }));

import { draftGitText, resetGitDraftsForTests } from '../../src/main/git-actions/draft-text';
import { buildDraftPrompt, cleanDraft, DRAFT_PROMPT_MAX_CHARS } from '../../src/main/git-actions/draft-prompt';
import type { ResolvedGitTarget } from '../../src/main/git-actions/action-target';
import type { IpcContext } from '../../src/main/ipc/ipc-context';
import type { GitDraftInput } from '../../src/shared/git-work-state';

let root: string;
let checkout: string;

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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-draft-'));
  checkout = path.join(root, 'repo');
  fs.mkdirSync(checkout);
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Dev');
  git('config', 'user.email', 'dev@example.com');
  fs.writeFileSync(path.join(checkout, 'base.txt'), 'before\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: the house style');
  git('checkout', '-q', '-b', 'task-branch');
  mocks.agentOk = true;
  mocks.recorded.length = 0;
  mocks.answer.mockReset();
  mocks.answer.mockResolvedValue('feat: drafted');
  resetGitDraftsForTests();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a commit message', () => {
  it('is written from the change, new files included, the repository\'s style and the task', async () => {
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'after\n');
    fs.writeFileSync(path.join(checkout, 'new.txt'), 'brand new line\n');
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'feat: drafted', drafted: true });
    expect(lastPrompt()).toContain('+after');
    expect(lastPrompt()).toContain('brand new line');
    expect(lastPrompt()).toContain('chore: the house style');
    expect(lastPrompt()).toContain('Say what is not pushed');
    expect(mocks.recorded).toEqual([{ job: 'git_draft', taskId: 'task-1' }]);
  });

  it('is written from what is staged alone when anything is', async () => {
    fs.writeFileSync(path.join(checkout, 'staged.txt'), 'goes in\n');
    git('add', 'staged.txt');
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'stays out\n');
    await draft({ kind: 'commit-message' });
    expect(lastPrompt()).toContain('goes in');
    expect(lastPrompt()).not.toContain('stays out');
  });

  it('spends nothing when the dialog reopens on the same change, and again on a new one or when asked', async () => {
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'after\n');
    await draft({ kind: 'commit-message' });
    await draft({ kind: 'commit-message' });
    expect(mocks.answer).toHaveBeenCalledTimes(1);
    await draft({ kind: 'commit-message', force: true });
    expect(mocks.answer).toHaveBeenCalledTimes(2);
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'after again\n');
    await draft({ kind: 'commit-message' });
    expect(mocks.answer).toHaveBeenCalledTimes(3);
  });

  it('falls back to the task\'s title with no agent, and when the agent fails, without keeping the failure', async () => {
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'after\n');
    mocks.agentOk = false;
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'Mark git state', drafted: false });
    expect(mocks.answer).not.toHaveBeenCalled();
    mocks.agentOk = true;
    mocks.answer.mockRejectedValueOnce(new Error('timed out'));
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'Mark git state', drafted: false });
    expect(await draft({ kind: 'commit-message' })).toEqual({ text: 'feat: drafted', drafted: true });
  });
});

describe('a pull request description', () => {
  it('is written from the branch\'s commits and change against the branch it goes into', async () => {
    fs.writeFileSync(path.join(checkout, 'base.txt'), 'after\n');
    git('commit', '-q', '-am', 'feat: the work');
    await draft({ kind: 'pull-request-description', baseBranch: 'main' });
    expect(lastPrompt()).toContain('feat: the work');
    expect(lastPrompt()).toContain('+after');
  });

  it('starts empty when there is nothing to describe or the base cannot be passed to git', async () => {
    expect(await draft({ kind: 'pull-request-description', baseBranch: 'main' })).toEqual({ text: '', drafted: false });
    expect(await draft({ kind: 'pull-request-description', baseBranch: '--output=x' })).toEqual({ text: '', drafted: false });
    expect(mocks.answer).not.toHaveBeenCalled();
  });
});

describe('the prompt and the reply', () => {
  it('keeps a huge change inside the budget and says it was cut', () => {
    const prompt = buildDraftPrompt({
      kind: 'commit-message', diff: 'x'.repeat(500_000), commits: '', recentSubjects: ['a'], taskTitle: 'T', taskDescription: 'd'.repeat(90_000),
    });
    expect(prompt.length).toBeLessThanOrEqual(DRAFT_PROMPT_MAX_CHARS);
    expect(prompt).toContain('[diff cut]');
  });

  it.each([
    ['```\nfeat: x\n\nbody\n```', 'feat: x\n\nbody'],
    ['"feat: x"', 'feat: x'],
    ['feat: quote "x"\n', 'feat: quote "x"'],
    ['`a` and `b`', '`a` and `b`'],
  ])('unwraps %j', (reply, text) => {
    expect(cleanDraft(reply)).toBe(text);
  });
});
