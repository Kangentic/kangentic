/**
 * The git dialogs and the shared work-state read, behind the Changes button, the
 * Changes panel's line and the window menu: what a dialog keeps while what is read
 * changes under it, how a failed or finished create reads, when an action is off and
 * why, and when the read runs. What git itself does is unit-tested on real
 * repositories; git-state-and-actions.spec.ts covers the badge, the line and the
 * happy path of each dialog. This spec is the edges of those.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { chromium, type Browser } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady, gotoVite, VITE_URL } from './helpers';

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const PROJECT_ID = 'proj-git';
const SESSION_ID = 'sess-git';
const WORKTREE = '/mock/git/.kangentic/worktrees/7';

interface Seed {
  workState?: Record<string, unknown>;
  task?: Record<string, unknown>;
  activity?: string;
  automationAgent?: boolean;
}

function preConfig(seed: Seed): string {
  return `
    window.__mockGitWorkState = ${JSON.stringify(seed.workState ?? {})};
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();
      state.projects.push({ id: '${PROJECT_ID}', name: 'Git', path: '/mock/git', github_url: null, default_agent: 'claude', default_model: null, default_effort: null, group_id: null, position: 0, last_opened: ts, created_at: ts });
      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, { id: 'lane-' + s.name.toLowerCase().replace(/\\s+/g, '-'), position: i, created_at: ts }));
      });
      var lane = state.swimlanes.find(function (l) { return l.name === 'Executing'; }) || state.swimlanes[2];
      state.tasks.push(Object.assign({
        id: 'task-git', title: 'Mark git state', description: 'Body', swimlane_id: lane.id, position: 0, agent: 'claude', session_id: '${SESSION_ID}',
        worktree_path: '${WORKTREE}', branch_name: 'task-branch', base_branch: null, use_worktree: 1, pushed_branch: null,
        pr_number: null, pr_url: null, pr_state: null, pr_merge_readiness: null, labels: [], priority: 0, attachment_count: 0, archived_at: null, created_at: ts, updated_at: ts, display_id: 7,
      }, ${JSON.stringify(seed.task ?? {})}));
      state.sessions.push({ id: '${SESSION_ID}', taskId: 'task-git', projectId: '${PROJECT_ID}', pid: 1, status: 'running', shell: 'bash', cwd: '${WORKTREE}', startedAt: ts, exitCode: null, resuming: false });
      state.activityCache['${SESSION_ID}'] = '${seed.activity ?? 'idle'}';
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

async function openMenu(dialog: Locator): Promise<Locator> {
  await dialog.getByRole('button', { name: 'Actions' }).click();
  const menu = dialog.page().getByRole('menu');
  await menu.waitFor({ state: 'visible' });
  return menu;
}

type Hooks = Record<string, unknown>;
const hooks = (page: Page, assign: Record<string, unknown>): Promise<void> => (
  page.evaluate((values) => { Object.assign(window as unknown as Hooks, values); }, assign)
);

/** What the mock answers for a checkout with nothing seeded, so a hand-resolved read is a whole GitWorkState. */
function workStateOf(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    branch: 'task-branch', onBaseBranch: false, uncommittedFileCount: 0, stagedFileCount: 0,
    conflictedFileCount: 0, unpushedCommitCount: 0, aheadOfBaseCount: 0, hasRemote: true,
    pushTarget: 'task-branch', canCreatePullRequest: false, ...partial,
  };
}

interface Probe { calls: number; mode: 'real' | 'null' | 'hold'; held: Array<(value: unknown) => void> }
type ProbeWindow = { __gws: Probe; electronAPI: { git: { workState: (request: unknown) => Promise<unknown> } } };

/** Count every work-state read, and answer it null or hold it until the test resolves it by hand. */
async function installProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as ProbeWindow;
    const git = target.electronAPI.git;
    const real = git.workState.bind(git);
    const probe: Probe = { calls: 0, mode: 'real', held: [] };
    target.__gws = probe;
    git.workState = (request) => {
      probe.calls += 1;
      if (probe.mode === 'hold') return new Promise((resolve) => { probe.held.push(resolve); });
      if (probe.mode === 'null') return Promise.resolve(null);
      return real(request);
    };
  });
}
const reads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as ProbeWindow).__gws.calls);
const heldReads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as ProbeWindow).__gws.held.length);
const readMode = (page: Page, mode: Probe['mode']): Promise<void> => page.evaluate((next) => { (window as unknown as ProbeWindow).__gws.mode = next; }, mode);
const answerHeld = (page: Page, index: number, state: Record<string, unknown>): Promise<void> => (
  page.evaluate(([position, value]) => { (window as unknown as ProbeWindow).__gws.held[position as number](value); }, [index, state] as const)
);
const fireDiff = (page: Page, folder = WORKTREE): Promise<void> => (
  page.evaluate((target) => (window as unknown as { __mockFireDiffChanged: (path: string) => void }).__mockFireDiffChanged(target), folder)
);
/** Time passing is the only thing a "nothing happened" claim can wait on: a read waits at most the 3 second gap. */
const letTimePass = (page: Page, milliseconds: number): Promise<void> => page.evaluate((delay) => new Promise<void>((resolve) => { setTimeout(resolve, delay); }), milliseconds);
const actionCalls = (page: Page): Promise<{ action: string }[]> => (
  page.evaluate(() => (window as unknown as { __mockGitActionCalls?: { action: string }[] }).__mockGitActionCalls ?? [])
);

const PR = { pr_number: 12, pr_url: 'https://github.com/example/repo/pull/12', pr_state: 'open', pr_merge_readiness: 'ready' };
const ANYTHING_TO_PUSH_AND_OPEN = { uncommittedFileCount: 1, unpushedCommitCount: 1, aheadOfBaseCount: 1, canCreatePullRequest: true };

const rekeyTask = (page: Page): Promise<void> => page.evaluate(() => {
  const board = (window as unknown as {
    __zustandStores: { board: { getState: () => { tasks: { id: string }[] }; setState: (partial: { tasks: unknown[] }) => void } };
  }).__zustandStores.board;
  board.setState({ tasks: board.getState().tasks.map((task) => (task.id === 'task-git' ? { ...task, pushed_branch: 'feature/pushed' } : task)) });
});

test.describe('a dialog keeps what the user typed when what is read changes', () => {
  test('Commit', async () => {
    const page = await boot({ workState: ANYTHING_TO_PUSH_AND_OPEN });
    await installProbe(page);
    const dialog = await openTask(page);
    await expect(dialog.getByTestId('changes-toggle-badge')).toHaveAttribute('data-badge', 'uncommitted');
    await (await openMenu(dialog)).getByTestId('kebab-git-commit').click();
    const commit = page.getByTestId('git-commit-dialog');
    const message = page.getByTestId('git-commit-message');
    await expect(message).toBeEditable();
    await message.fill('feat: typed by hand');

    await test.step('the task is re-keyed by a push', async () => {
      const before = await reads(page);
      await rekeyTask(page);
      await expect.poll(() => reads(page), { timeout: 10_000 }).toBeGreaterThan(before);
      await expect(commit).toBeVisible();
      await expect(message).toHaveValue('feat: typed by hand');
    });

    await test.step('git cannot say what the checkout is like', async () => {
      await readMode(page, 'null');
      const before = await reads(page);
      await fireDiff(page);
      await expect.poll(() => reads(page), { timeout: 10_000 }).toBeGreaterThan(before);
      // Unknown now: the header's badge, which reads the same state, has gone.
      await expect(dialog.getByTestId('changes-toggle-badge')).toHaveCount(0);
      await expect(commit).toBeVisible();
      await expect(message).toHaveValue('feat: typed by hand');
    });
    await page.context().close();
  });

  test('Create pull request', async () => {
    const page = await boot({ workState: ANYTHING_TO_PUSH_AND_OPEN });
    await installProbe(page);
    const dialog = await openTask(page);
    await expect(dialog.getByTestId('changes-toggle-badge')).toBeVisible();
    await (await openMenu(dialog)).getByTestId('kebab-git-create-pr').click();
    const create = page.getByTestId('git-create-pr-dialog');
    await page.getByTestId('git-create-pr-title').fill('Typed title');
    await page.getByTestId('git-create-pr-body').fill('Typed description');

    await test.step('the task is re-keyed by a push', async () => {
      const before = await reads(page);
      await rekeyTask(page);
      await expect.poll(() => reads(page), { timeout: 10_000 }).toBeGreaterThan(before);
      await expect(create).toBeVisible();
      await expect(page.getByTestId('git-create-pr-title')).toHaveValue('Typed title');
      await expect(page.getByTestId('git-create-pr-body')).toHaveValue('Typed description');
    });

    await test.step('git cannot say what the checkout is like', async () => {
      await readMode(page, 'null');
      const before = await reads(page);
      await fireDiff(page);
      await expect.poll(() => reads(page), { timeout: 10_000 }).toBeGreaterThan(before);
      await expect(dialog.getByTestId('changes-toggle-badge')).toHaveCount(0);
      await expect(create).toBeVisible();
      await expect(page.getByTestId('git-create-pr-title')).toHaveValue('Typed title');
      await expect(page.getByTestId('git-create-pr-body')).toHaveValue('Typed description');
    });
    await page.context().close();
  });
});

test('with no Automation agent, text typed before the opening draft answers is not replaced', async () => {
  const page = await boot({ workState: { uncommittedFileCount: 1 } });
  await hooks(page, { __mockGitDraftDeferred: true, __mockGitDraft: { text: 'Mark git state', drafted: false } });
  const dialog = await openTask(page);
  await (await openMenu(dialog)).getByTestId('kebab-git-commit').click();
  const message = page.getByTestId('git-commit-message');
  await expect(message).toBeEditable();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as Hooks).__mockGitDraftResolve)).toBe('function');
  await message.fill('typed before the draft');
  await page.evaluate(() => ((window as unknown as { __mockGitDraftResolve: () => void }).__mockGitDraftResolve)());
  // The answer sets state in a microtask: two frames is past it.
  await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => requestAnimationFrame(() => resolve())); }));
  await expect(message).toHaveValue('typed before the draft');
  await page.context().close();
});

test.describe('creating a pull request', () => {
  test('a failed create keeps the dialog and what was typed, and a task create shows no toast', async () => {
    const page = await boot({ workState: { aheadOfBaseCount: 1, canCreatePullRequest: true } });
    await hooks(page, { __mockGitActionResult: { outcome: 'failed', step: 'create-pull-request', message: 'The host refused it' } });
    const dialog = await openTask(page);
    await (await openMenu(dialog)).getByTestId('kebab-git-create-pr').click();
    const create = page.getByTestId('git-create-pr-dialog');
    await page.getByTestId('git-create-pr-title').fill('Typed title');
    await page.getByTestId('git-create-pr-body').fill('Typed description');
    await page.getByTestId('git-create-pr-confirm').click();
    await expect(page.getByTestId('toast')).toContainText("Couldn't create pull request");
    await expect(create).toBeVisible();
    await expect(page.getByTestId('git-create-pr-title')).toHaveValue('Typed title');
    await expect(page.getByTestId('git-create-pr-body')).toHaveValue('Typed description');
    await expect(page.getByTestId('git-create-pr-confirm')).toBeEnabled();

    // The task's own chip shows the pull request, so the same success raises no toast.
    await hooks(page, { __mockGitActionResult: { outcome: 'done', pullRequest: { number: 12, url: 'https://github.com/example/repo/pull/12' } } });
    await page.getByTestId('git-create-pr-confirm').click();
    await expect(create).toBeHidden();
    await expect(page.getByTestId('toast').filter({ hasText: 'Pull request created' })).toHaveCount(0);
    await page.context().close();
  });

  test('a terminal create says so in a toast, and its title starts as the last commit\'s subject', async () => {
    const page = await boot({ workState: { branch: 'feature/x', pushTarget: 'feature/x', aheadOfBaseCount: 1, canCreatePullRequest: true } });
    await hooks(page, {
      __mockBranchSummary: { currentBranch: 'feature/x', ahead: 1, behind: 0, lastCommit: { subject: 'fix: the last commit', hash: 'abc1234', date: new Date().toISOString() } },
      __mockGitActionResult: { outcome: 'done', pullRequest: { number: 31, url: 'https://github.com/example/repo/pull/31' } },
    });
    await page.keyboard.press('Control+Shift+P');
    const terminal = page.getByTestId('command-terminal-window');
    await terminal.waitFor({ state: 'visible' });
    await terminal.getByTestId('command-bar-changes-toggle').click();
    await expect(terminal.getByTestId('changes-next-step-button')).toHaveText('Create pull request');
    await terminal.getByTestId('changes-next-step-button').click();
    await expect(page.getByTestId('git-create-pr-title')).toHaveValue('fix: the last commit');
    await page.getByTestId('git-create-pr-confirm').click();
    await expect(page.getByTestId('git-create-pr-dialog')).toBeHidden();
    const toast = page.getByTestId('toast').filter({ hasText: 'Pull request created' });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('#31');
    await page.context().close();
  });

  test('a draft that lands after the base was changed is not written into the description', async () => {
    const page = await boot({ workState: { aheadOfBaseCount: 1, canCreatePullRequest: true }, automationAgent: true });
    const dialog = await openTask(page);
    await (await openMenu(dialog)).getByTestId('kebab-git-create-pr').click();
    const picker = page.getByTestId('git-create-pr-dialog').getByTestId('branch-picker-chip');
    const body = page.getByTestId('git-create-pr-body');
    await expect(picker).toHaveText('main');
    await hooks(page, { __mockGitDraftDeferred: true, __mockGitDraft: { text: 'A description of main', drafted: true } });
    await page.getByTestId('git-create-pr-body-draft').click();
    await expect(page.getByTestId('git-create-pr-body-drafting')).toBeVisible();
    await picker.click();
    await page.getByTestId('branch-picker-dropdown').getByText('develop', { exact: true }).click();
    await expect(picker).toHaveText('develop');
    await page.evaluate(() => ((window as unknown as { __mockGitDraftResolve: () => void }).__mockGitDraftResolve)());
    await expect(page.getByTestId('git-create-pr-body-drafting')).toBeHidden();
    await expect(body).toHaveValue('');

    // On the base it was drafted for, the same answer is written.
    await page.getByTestId('git-create-pr-body-draft').click();
    await expect(body).toHaveValue('A description of main');
    await page.context().close();
  });
});

test('a closed pull request does not stop Create pull request being offered', async () => {
  const page = await boot({
    task: { ...PR, pr_state: 'closed' },
    workState: { aheadOfBaseCount: 1, canCreatePullRequest: true },
  });
  const dialog = await openTask(page);
  await test.step('the window menu', async () => {
    const menu = await openMenu(dialog);
    await expect(menu.getByTestId('kebab-git-create-pr')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });
  await test.step('the panel line', async () => {
    await dialog.getByTestId('changes-toggle').click();
    await expect(dialog.getByTestId('changes-next-step-button')).toHaveText('Create pull request');
  });
  await page.context().close();
});

test.describe('when an action is off', () => {
  test('mid-turn, with conflicts, and for a background shell', async () => {
    const page = await boot({ workState: { uncommittedFileCount: 1, unpushedCommitCount: 1, conflictedFileCount: 1 } });
    const dialog = await openTask(page);
    const menu = await openMenu(dialog);
    const commit = menu.getByTestId('kebab-git-commit');
    const push = menu.getByTestId('kebab-git-push');
    const setActivity = (state: string, kind: 'permission' | 'background-shell'): Promise<void> => page.evaluate(([nextState, reasonKind]) => {
      const session = (window as unknown as {
        __zustandStores: { session: { getState: () => { updateActivity: (id: string, state: string, reason: unknown) => void } } };
      }).__zustandStores.session;
      // The shapes of ActivityReason in src/shared/types.ts.
      const reason = reasonKind === 'permission'
        ? { kind: 'permission', since: Date.now() }
        : { kind: 'background-shell', count: 1, ids: [] };
      session.getState().updateActivity('sess-git', nextState, reason);
    }, [state, kind] as const);

    await test.step('conflicts turn Commit off and leave Push on', async () => {
      await expect(commit).toBeDisabled();
      await expect(commit).toHaveAccessibleDescription('Resolve the conflicts first');
      await expect(push).toBeEnabled();
    });
    await test.step('a permission prompt is inside the turn', async () => {
      await setActivity('idle', 'permission');
      await expect(push).toBeDisabled();
      await expect(push).toHaveAccessibleDescription('Available when the agent finishes its turn');
      await expect(commit).toHaveAccessibleDescription('Available when the agent finishes its turn');
    });
    await test.step('a background shell is not', async () => {
      await setActivity('thinking', 'background-shell');
      await expect(push).toBeEnabled();
      await expect(commit).toHaveAccessibleDescription('Resolve the conflicts first');
    });
    await page.context().close();
  });

  test('while an action runs the panel button and the menu items are off, and two clicks send one push', async () => {
    const page = await boot({ workState: { unpushedCommitCount: 1 } });
    await hooks(page, { __mockGitActionDeferred: true });
    const dialog = await openTask(page);
    await dialog.getByTestId('changes-toggle').click();
    const button = dialog.getByTestId('changes-next-step-button');
    await expect(button).toBeEnabled();
    // Both clicks land in one task, before React can repaint the button as busy.
    await button.evaluate((element) => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAccessibleDescription('A git action is running');
    const push = (await openMenu(dialog)).getByTestId('kebab-git-push');
    await expect(push).toBeDisabled();
    await expect(push).toHaveAccessibleDescription('A git action is running');
    expect((await actionCalls(page)).map((call) => call.action)).toEqual(['push']);

    await page.evaluate(() => ((window as unknown as { __mockGitActionResolve: () => void }).__mockGitActionResolve)());
    await expect(push).toBeEnabled();
    await expect(button).toBeEnabled();
    expect((await actionCalls(page)).map((call) => call.action)).toEqual(['push']);
    await page.context().close();
  });
});

test.describe('the work-state read', () => {
  test('runs once for a burst of diff pushes, and again on a turn end and on window focus', async () => {
    test.setTimeout(60_000);
    const page = await boot({ workState: { unpushedCommitCount: 1 } });
    await installProbe(page);
    await openTask(page);
    await expect.poll(() => reads(page)).toBe(1);

    await test.step('several diff pushes inside the gap start one read', async () => {
      const before = await reads(page);
      for (let push = 0; push < 4; push += 1) await fireDiff(page);
      await expect.poll(() => reads(page), { timeout: 10_000 }).toBe(before + 1);
      // The gap is 3 seconds, so a second read would have started by now.
      await letTimePass(page, 500);
      expect(await reads(page)).toBe(before + 1);
    });

    const setActivity = (state: string): Promise<void> => page.evaluate((next) => {
      const session = (window as unknown as {
        __zustandStores: { session: { getState: () => { updateActivity: (id: string, state: string) => void } } };
      }).__zustandStores.session;
      session.getState().updateActivity('sess-git', next);
    }, state);

    await test.step('a turn that ends reads again', async () => {
      await setActivity('thinking');
      const before = await reads(page);
      await setActivity('idle');
      await expect.poll(() => reads(page), { timeout: 10_000 }).toBe(before + 1);
    });

    await test.step('the window getting focus reads again', async () => {
      const before = await reads(page);
      await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
      await expect.poll(() => reads(page), { timeout: 10_000 }).toBe(before + 1);
    });
    await page.context().close();
  });

  test('an action\'s end reads at once beside a read in flight, and the older answer does not overwrite it', async () => {
    test.setTimeout(60_000);
    const page = await boot({ workState: { unpushedCommitCount: 1 } });
    await installProbe(page);
    const dialog = await openTask(page);
    const badge = dialog.getByTestId('changes-toggle-badge');
    await expect(badge).toHaveAttribute('data-badge', 'unpushed');

    // A diff push starts a read that stays in flight.
    await readMode(page, 'hold');
    await fireDiff(page);
    await expect.poll(() => heldReads(page), { timeout: 10_000 }).toBe(1);

    // The push finishing reads at once, with the first still out.
    await (await openMenu(dialog)).getByTestId('kebab-git-push').click();
    await expect.poll(() => heldReads(page), { timeout: 2_000 }).toBe(2);

    await answerHeld(page, 1, workStateOf({ unpushedCommitCount: 1, uncommittedFileCount: 3 }));
    await expect(badge).toHaveAttribute('data-badge', 'uncommitted');
    // The older read answers last, with a clean checkout. It is dropped.
    await answerHeld(page, 0, workStateOf({}));
    await letTimePass(page, 300);
    await expect(badge).toHaveAttribute('data-badge', 'uncommitted');
    await page.context().close();
  });

  test('a parked window with Changes open reads nothing on a diff push', async () => {
    test.setTimeout(60_000);
    const page = await boot({ workState: { uncommittedFileCount: 1 } });
    await installProbe(page);
    const dialog = await openTask(page);
    await dialog.getByTestId('changes-toggle').click();
    await expect(dialog.getByTestId('changes-next-step')).toBeVisible();
    await expect.poll(() => reads(page)).toBeGreaterThan(0);

    await test.step('showing, a diff push reads', async () => {
      const before = await reads(page);
      await fireDiff(page);
      await expect.poll(() => reads(page), { timeout: 10_000 }).toBe(before + 1);
    });

    await test.step('parked, it does not', async () => {
      const windowId = await page.evaluate(() => {
        const stores = (window as unknown as {
          __zustandStores: {
            session: { setState: (partial: { browserGuestTasks: Set<string>; browserHeldTasks: Set<string> }) => void };
            window: { getState: () => { windows: Record<string, { id: string; kind: string; anchor: string }>; parkWindow: (id: string) => void } };
          };
        }).__zustandStores;
        const store = stores.window;
        // The park reaper drops a parked window that keeps no live guest. Stand one in, as park-on-close does.
        stores.session.setState({ browserGuestTasks: new Set(['task-git']), browserHeldTasks: new Set(['task-git']) });
        const match = Object.values(store.getState().windows).find((candidate) => candidate.kind === 'task-detail' && candidate.anchor === 'task-git');
        if (!match) throw new Error('no task window');
        store.getState().parkWindow(match.id);
        return match.id;
      });
      await expect.poll(() => page.evaluate((id) => (
        (window as unknown as { __zustandStores: { window: { getState: () => { windows: Record<string, { parked?: true }> } } } })
          .__zustandStores.window.getState().windows[id]?.parked === true
      ), windowId)).toBe(true);
      const before = await reads(page);
      await fireDiff(page);
      // A watching window would read within the 3 second gap.
      await letTimePass(page, 3_500);
      expect(await reads(page)).toBe(before);
    });
    await page.context().close();
  });
});

test('a refresh that finds no pull request names the branch the work was pushed to', async () => {
  const page = await boot({ task: { pr_number: 42, worktree_path: null, branch_name: null, pushed_branch: 'maint/foo' } });
  await page.evaluate(() => {
    (window as unknown as { __mockResolvePrResult: () => Promise<unknown> }).__mockResolvePrResult = () => (
      Promise.resolve({ task: null, linked: false, reason: 'not-found' })
    );
  });
  const menu = await openMenu(await openTask(page));
  await menu.getByText('Refresh pull request').click();
  const toast = page.getByTestId('toast').filter({ hasText: 'No PR found' });
  await expect(toast.getByTestId('toast-body')).toHaveText('Nothing matches branch "maint/foo".');
  await page.context().close();
});

test('the window menu stays inside a 900x600 window when its git items arrive after it opened', async () => {
  const page = await boot({ workState: ANYTHING_TO_PUSH_AND_OPEN }, { width: 900, height: 600 });
  await installProbe(page);
  await readMode(page, 'hold');
  const dialog = await openTask(page);
  await expect.poll(() => heldReads(page)).toBe(1);
  const menu = await openMenu(dialog);
  await expect(menu.getByTestId('kebab-git-commit')).toHaveCount(0);

  await answerHeld(page, 0, workStateOf(ANYTHING_TO_PUSH_AND_OPEN));
  await expect(menu.getByTestId('kebab-git-create-pr')).toBeVisible();
  const inside = async (): Promise<boolean> => {
    const box = await menu.boundingBox();
    // The menu keeps an 8px gap from the edge: a few pixels either way is rounding, not a menu cut off.
    return box !== null && box.y >= 0 && box.y + box.height <= 600;
  };
  await expect.poll(inside).toBe(true);
  await page.context().close();
});
