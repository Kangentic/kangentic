/**
 * The Changes button's git badge and tip, the Changes panel's next-step line, the
 * Commit and Create pull request dialogs, and the window menu's git group, in a
 * task window and a Command Terminal. What git itself does is unit-tested on real
 * repositories (git-work-state.test.ts, git-actions.test.ts).
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { chromium, type Browser } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, VITE_URL } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const PROJECT_ID = 'proj-git';
const SESSION_ID = 'sess-git';

interface Seed {
  workState?: Record<string, unknown>;
  task?: Record<string, unknown>;
  config?: Record<string, unknown>;
  activity?: string;
  prChecks?: Record<string, unknown>;
  automationAgent?: boolean;
}

function preConfig(seed: Seed): string {
  return `
    window.__mockGitWorkState = ${JSON.stringify(seed.workState ?? {})};
    ${seed.prChecks ? `window.__mockPrChecks = ${JSON.stringify(seed.prChecks)};` : ''}
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({ id: '${PROJECT_ID}', name: 'Git', path: '/mock/git', github_url: null, default_agent: 'claude', default_model: null, default_effort: null, group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-'), position: i, created_at: ts }));
      });
      var lane = state.swimlanes.find(function (l) { return l.name === 'Executing'; }) || state.swimlanes[2];
      state.tasks.push(Object.assign({
        id: 'task-git', title: 'Mark git state', description: 'Body', swimlane_id: lane.id, position: 0, agent: 'claude', session_id: '${SESSION_ID}',
        worktree_path: '/mock/git/.kangentic/worktrees/7', branch_name: 'task-branch', base_branch: null, use_worktree: 1, pushed_branch: null,
        pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, labels: [], priority: 0, attachment_count: 0, archived_at: null, created_at: ts, updated_at: ts, display_id: 7,
      }, ${JSON.stringify(seed.task ?? {})}));
      state.sessions.push({ id: '${SESSION_ID}', taskId: 'task-git', projectId: '${PROJECT_ID}', pid: 1, status: 'running', shell: 'bash', cwd: '/mock/git/.kangentic/worktrees/7', startedAt: ts, exitCode: null, resuming: false });
      state.activityCache['${SESSION_ID}'] = '${seed.activity ?? 'idle'}';
      Object.assign(state.config, ${JSON.stringify(seed.config ?? {})});
      ${seed.automationAgent ? "state.config.automation = { agent: 'claude', model: 'haiku', effort: null };" : ''}
      return { currentProjectId: '${PROJECT_ID}' };
    });
  `;
}

let browser: Browser;
test.beforeAll(async () => {
  await waitForViteReady(VITE_URL);
  browser = await chromium.launch({ headless: true });
});
test.afterAll(async () => { await browser.close(); });

async function boot(seed: Seed, viewport = { width: 1600, height: 1000 }): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfig(seed));
  await gotoVite(page, VITE_URL);
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  return page;
}

async function openTask(page: Page): Promise<Locator> {
  await page.locator('text=Mark git state').first().click();
  const dialog = page.getByTestId('task-detail-dialog');
  await dialog.waitFor({ state: 'visible' });
  return dialog;
}

const openMenu = async (dialog: Locator): Promise<Locator> => {
  await dialog.getByRole('button', { name: 'Actions' }).click();
  const menu = dialog.page().getByRole('menu');
  await menu.waitFor({ state: 'visible' });
  return menu;
};

const PR = { pr_number: 12, pr_url: 'https://github.com/example/repo/pull/12', pr_state: 'open', pr_merge_readiness: 'failing' };
const FAILED = { checks: [{ id: 'a', name: 'unit', group: null, url: null, status: 'failed', hasLog: false }], checksPageUrl: null };

test.describe('the Changes button', () => {
  test('marks one fact, the most important, and lists every one in its tip', async () => {
    const page = await boot({ task: PR, prChecks: { 'task-git': FAILED }, workState: { uncommittedFileCount: 4, unpushedCommitCount: 2 } });
    const dialog = await openTask(page);
    const badge = dialog.getByTestId('changes-toggle-badge');
    await expect(badge).toHaveAttribute('data-badge', 'problems');
    await expect(badge).toHaveCount(1);
    await dialog.getByTestId('changes-toggle').hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveAttribute('data-shape', 'stack');
    await expect(tip.locator('[data-tooltip-part="head"]')).toContainText('Show changes');
    await expect(tip.locator('kbd').first()).toBeVisible();
    await expect(tip.locator('[data-tooltip-row]')).toHaveText(['1 problem on the PR', '4 uncommitted files', '2 commits not pushed']);
    await expect(dialog.getByTestId('changes-toggle')).toHaveAccessibleDescription(/4 uncommitted files/);
    await page.context().close();
  });

  for (const [name, workState, expected] of [
    ['uncommitted before unpushed', { uncommittedFileCount: 1, unpushedCommitCount: 3 }, 'uncommitted'],
    ['unpushed on its own', { unpushedCommitCount: 3 }, 'unpushed'],
    ['nothing when clean and pushed', { aheadOfBaseCount: 3 }, null],
  ] as const) {
    test(`marks ${name}`, async () => {
      const page = await boot({ workState });
      const dialog = await openTask(page);
      const badge = dialog.getByTestId('changes-toggle-badge');
      if (expected === null) await expect(badge).toHaveCount(0);
      else await expect(badge).toHaveAttribute('data-badge', expected);
      await page.context().close();
    });
  }

  test('keeps its badge with the panel open, and reads again only for its own folder', async () => {
    const page = await boot({ workState: { uncommittedFileCount: 1 } });
    const dialog = await openTask(page);
    await dialog.getByTestId('changes-toggle').click();
    await expect(dialog.getByTestId('changes-next-step')).toBeVisible();
    await expect(dialog.getByTestId('changes-toggle-badge')).toBeVisible();
    const calls = () => page.evaluate(() => ((window as unknown as { __mockGitWorkStateCalls?: unknown[] }).__mockGitWorkStateCalls ?? []).length);
    // The opening reads are over once the count has held still for longer than the 3 second gap.
    let before = -1;
    let heldSince = Date.now();
    await expect.poll(async () => {
      const now = await calls();
      if (now !== before) {
        before = now;
        heldSince = Date.now();
      }
      return Date.now() - heldSince;
    }, { timeout: 30_000 }).toBeGreaterThan(3_500);
    const fire = (folder: string) => page.evaluate((target) => (window as unknown as { __mockFireDiffChanged: (path: string) => void }).__mockFireDiffChanged(target), folder);
    await fire('/mock/git/.kangentic/worktrees/99');
    // The gap is open, so a read for it would start on a 0 ms timer: later timers run after it.
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(() => setTimeout(resolve, 0), 0)));
    expect(await calls()).toBe(before);
    await fire('/mock/git/.kangentic/worktrees/7');
    await expect.poll(calls).toBe(before + 1);
    await page.context().close();
  });
});

test.describe('the next-step line', () => {
  for (const [name, workState, text, button] of [
    ['commit', { uncommittedFileCount: 1 }, '1 changed file', 'Commit'],
    ['publish', { unpushedCommitCount: 2, pushTarget: null }, 'Branch not published', 'Publish branch'],
    ['push', { unpushedCommitCount: 2 }, '2 local commits', 'Push'],
    ['create a pull request', { aheadOfBaseCount: 2, canCreatePullRequest: true }, 'No pull request', 'Create pull request'],
  ] as const) {
    test(`offers to ${name}`, async () => {
      const page = await boot({ workState });
      const dialog = await openTask(page);
      await dialog.getByTestId('changes-toggle').click();
      const line = dialog.getByTestId('changes-next-step');
      await expect(line).toContainText(text);
      await expect(line.getByTestId('changes-next-step-button')).toHaveText(button);
      await page.context().close();
    });
  }

  test('is absent with nothing to do, and with a linked pull request', async () => {
    const page = await boot({ task: PR, workState: { aheadOfBaseCount: 2, canCreatePullRequest: true } });
    const dialog = await openTask(page);
    await dialog.getByTestId('changes-toggle').click();
    await expect(dialog.getByTestId('changes-branch-name').first()).toBeVisible();
    await expect(dialog.getByTestId('changes-next-step')).toHaveCount(0);
    await page.context().close();
  });

  test('is off mid-turn and with conflicts, saying why', async () => {
    const page = await boot({ workState: { unpushedCommitCount: 1 }, activity: 'thinking' });
    const dialog = await openTask(page);
    await dialog.getByTestId('changes-toggle').click();
    const button = dialog.getByTestId('changes-next-step-button');
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription('Available when the agent finishes its turn');
    await page.context().close();

    const conflicted = await boot({ workState: { uncommittedFileCount: 1, conflictedFileCount: 1 } });
    const second = await openTask(conflicted);
    await second.getByTestId('changes-toggle').click();
    await expect(second.getByTestId('changes-next-step-button')).toHaveAccessibleDescription('Resolve the conflicts first');
    await conflicted.context().close();
  });

  test('pushes at once, showing a refusal of git\'s in a toast', async () => {
    const page = await boot({ workState: { unpushedCommitCount: 1 } });
    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__mockGitActionResult = { outcome: 'failed', step: 'push', message: 'Could not resolve host: example.com' }; });
    const dialog = await openTask(page);
    await dialog.getByTestId('changes-toggle').click();
    await dialog.getByTestId('changes-next-step-button').click();
    await expect(page.getByTestId('toast')).toContainText("Couldn't push");
    await expect(page.getByTestId('toast')).toContainText('Could not resolve host: example.com');
    await page.context().close();
  });
});

test.describe('Commit', () => {
  test('drafts as it opens with the field blocked, and commits what was edited', async () => {
    const page = await boot({ workState: { uncommittedFileCount: 2 }, automationAgent: true });
    await page.evaluate(() => {
      const hooks = window as unknown as Record<string, unknown>;
      hooks.__mockGitDraftDeferred = true;
      hooks.__mockGitDraft = { text: 'feat: drafted', drafted: true };
    });
    const dialog = await openTask(page);
    await dialog.getByTestId('changes-toggle').click();
    await dialog.getByTestId('changes-next-step-button').click();
    const commit = page.getByTestId('git-commit-dialog');
    await expect(commit).toContainText('2 files on task-branch');
    const field = page.getByTestId('git-commit-message');
    await expect(page.getByTestId('git-commit-message-drafting')).toHaveText('Drafting a message...');
    const sparkle = page.getByTestId('git-commit-message-drafting').locator('.kng-twinkle');
    await expect(sparkle).toHaveCSS('animation-name', 'twinkle');
    // With Animations off the sparkle rests and the label still says what is happening.
    await page.evaluate(() => document.documentElement.classList.add('no-motion'));
    await expect(sparkle).toHaveCSS('animation-duration', '0s');
    await expect(sparkle).toHaveCSS('transform', 'none');
    await expect(sparkle).toHaveCSS('opacity', '1');
    await page.evaluate(() => document.documentElement.classList.remove('no-motion'));
    // Blocked, and it keeps the dialog's focus: a disabled field could not hold it.
    await expect(field).not.toBeEditable();
    await expect(field).toBeFocused();
    await expect(page.getByTestId('git-commit-confirm')).toBeDisabled();
    await page.evaluate(() => (window as unknown as { __mockGitDraftResolve: () => void }).__mockGitDraftResolve());
    await expect(field).toHaveValue('feat: drafted');
    await field.fill('feat: edited');
    await page.getByTestId('git-commit-push-after').click();
    await page.getByTestId('git-commit-confirm').click();
    await expect(commit).toBeHidden();
    const calls = await page.evaluate(() => (window as unknown as { __mockGitActionCalls: unknown[] }).__mockGitActionCalls);
    expect(calls).toEqual([{ action: 'commit', target: { kind: 'task', taskId: 'task-git' }, input: { message: 'feat: edited', pushAfter: true }, projectId: PROJECT_ID }]);
    // The choice is remembered.
    await dialog.getByTestId('changes-next-step-button').click();
    await expect(page.getByTestId('git-commit-push-after')).toHaveAttribute('aria-checked', 'true');
    await page.context().close();
  });

  test('keeps the message when the user has to act, and closes when an agent has it', async () => {
    const page = await boot({ workState: { uncommittedFileCount: 1 } });
    await page.evaluate(() => {
      const hooks = window as unknown as Record<string, unknown>;
      hooks.__mockGitDraft = { text: 'Mark git state', drafted: false };
      hooks.__mockGitActionResult = { outcome: 'failed', step: 'commit', message: 'Please tell me who you are' };
    });
    const dialog = await openTask(page);
    await dialog.getByTestId('changes-toggle').click();
    await dialog.getByTestId('changes-next-step-button').click();
    await expect(page.getByTestId('git-commit-message')).toHaveValue('Mark git state');
    await page.getByTestId('git-commit-confirm').click();
    await expect(page.getByTestId('toast')).toContainText("Couldn't commit");
    await expect(page.getByTestId('git-commit-message')).toHaveValue('Mark git state');
    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__mockGitActionResult = { outcome: 'held' }; });
    await page.getByTestId('git-commit-confirm').click();
    await expect(page.getByTestId('git-commit-dialog')).toBeHidden();
    await expect(page.getByTestId('toast').filter({ hasText: 'Held for the next agent' })).toBeVisible();
    await page.context().close();
  });

  test('Escape closes the dialog and leaves the window open', async () => {
    const page = await boot({ workState: { uncommittedFileCount: 1 } });
    const dialog = await openTask(page);
    const menu = await openMenu(dialog);
    await menu.getByTestId('kebab-git-commit').click();
    await expect(page.getByTestId('git-commit-dialog')).toBeVisible();
    await expect(page.getByTestId('git-commit-message')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('git-commit-dialog')).toBeHidden();
    await expect(dialog).toBeVisible();
    await page.context().close();
  });

  test('Escape over the board\'s Changes dialog closes one dialog a press', async () => {
    const page = await boot({ workState: { uncommittedFileCount: 1 } });
    await page.locator('[data-task-id="task-git"]').first().click({ button: 'right' });
    await page.getByTestId('context-show-changes').click();
    const changes = page.getByTestId('task-changes-dialog');
    await changes.getByTestId('changes-next-step-button').click();
    const commit = page.getByTestId('git-commit-dialog');
    await expect(page.getByTestId('git-commit-message')).toBeEnabled();
    // A re-render of the dialog underneath re-registers its key listener after this one's.
    await page.evaluate(() => (window as unknown as { __mockFireDiffChanged: (path: string) => void }).__mockFireDiffChanged('/mock/git/.kangentic/worktrees/7'));
    await page.keyboard.press('Escape');
    await expect(commit).toBeHidden();
    await expect(changes).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(changes).toBeHidden();
    await page.context().close();
  });

  test('has no sparkle without an Automation agent', async () => {
    const page = await boot({ workState: { uncommittedFileCount: 1 } });
    const dialog = await openTask(page);
    await (await openMenu(dialog)).getByTestId('kebab-git-commit').click();
    await expect(page.getByTestId('git-commit-message')).toBeVisible();
    await expect(page.getByTestId('git-commit-message-draft')).toHaveCount(0);
    await page.context().close();
  });
});

test('Create pull request starts on the base, takes another, and remembers Draft PR', async () => {
  const page = await boot({ workState: { aheadOfBaseCount: 1, canCreatePullRequest: true, pushTarget: 'feature/pushed' } });
  const dialog = await openTask(page);
  await dialog.getByTestId('changes-toggle').click();
  await dialog.getByTestId('changes-next-step-button').click();
  const create = page.getByTestId('git-create-pr-dialog');
  await expect(create).toContainText('feature/pushed into');
  const picker = create.getByTestId('branch-picker-chip');
  await expect(picker).toHaveText('main');
  await expect(page.getByTestId('git-create-pr-title')).toHaveValue('Mark git state');
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__mockGitLocalBranches = ['only-here']; });
  await picker.click();
  const menu = page.getByTestId('branch-picker-dropdown');
  await expect(menu).toContainText('develop');
  await expect(menu).not.toContainText('only-here');
  await menu.getByText('develop', { exact: true }).click();
  await expect(picker).toHaveText('develop');
  await page.getByTestId('git-create-pr-draft').click();
  await page.getByTestId('git-create-pr-confirm').click();
  await expect(create).toBeHidden();
  const calls = await page.evaluate(() => (window as unknown as { __mockGitActionCalls: { action: string; input: unknown }[] }).__mockGitActionCalls);
  expect(calls[0]).toMatchObject({ action: 'createPullRequest', input: { title: 'Mark git state', body: '', baseBranch: 'develop', draft: true } });
  await page.context().close();
});

test.describe('the window menu', () => {
  const labels = (menu: Locator) => menu.evaluate((element) => Array.from(element.children).map((child) => (
    child.tagName === 'BUTTON' || child.querySelector('button') ? (child.textContent ?? '').trim() : '---'
  )));

  test('groups the task, the window, its git and removal', async () => {
    const page = await boot({ workState: { uncommittedFileCount: 1, unpushedCommitCount: 1, aheadOfBaseCount: 1, canCreatePullRequest: true } });
    const dialog = await openTask(page);
    const rows = await labels(await openMenu(dialog));
    const groups = rows.join('|').split('|---|').map((group) => group.split('|'));
    expect(groups[0].slice(0, 2)).toEqual(['Edit', 'Pause session']);
    expect(groups[1]).toEqual(expect.arrayContaining(['View conversation', 'Open worktree', 'Show changes', 'Show browser']));
    expect(groups[2]).toEqual(['Pull from main', 'Commit...', 'Push', 'Create pull request...']);
    expect(groups[3]).toEqual(['Send to Backlog', 'Archive', 'Delete']);
    await page.context().close();
  });

  test('offers no Link PR, and refreshes a linked one', async () => {
    const page = await boot({ task: PR });
    const menu = await openMenu(await openTask(page));
    const rows = await labels(menu);
    expect(rows).toEqual(expect.arrayContaining(['View pull request #12', 'Refresh pull request']));
    expect(rows.join('|')).not.toMatch(/Link PR|Commit\.\.\.|Create pull request/);
    await page.context().close();
  });

  test('fits a 900x600 window with every item showing', async () => {
    const page = await boot({
      task: PR,
      workState: { uncommittedFileCount: 1, unpushedCommitCount: 1 },
    }, { width: 900, height: 600 });
    const menu = await openMenu(await openTask(page));
    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.y ?? -1) + (box?.height ?? 9999)).toBeLessThanOrEqual(600);
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0);
    await page.context().close();
  });
});

test('a Command Terminal marks its checkout and pushes as its own terminal', async () => {
  const page = await boot({ workState: { branch: 'main', onBaseBranch: true, unpushedCommitCount: 2, pushTarget: 'main' } });
  await page.keyboard.press('Control+Shift+P');
  const terminal = page.getByTestId('command-terminal-window');
  await terminal.waitFor({ state: 'visible' });
  await expect(terminal.getByTestId('command-bar-changes-badge')).toHaveAttribute('data-badge', 'unpushed');
  await terminal.getByTestId('command-bar-changes-toggle').click();
  await expect(terminal.getByTestId('changes-next-step')).toContainText('2 local commits');
  await expect(terminal.getByTestId('changes-next-step-button')).toBeEnabled();
  await terminal.getByTestId('changes-next-step-button').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __mockGitActionCalls?: unknown[] }).__mockGitActionCalls ?? []))
    .toEqual([expect.objectContaining({ action: 'push', target: { kind: 'terminal', slot: 'slot-1' }, projectId: PROJECT_ID })]);
  await page.context().close();
});
