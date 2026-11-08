/**
 * The task base picker takes a branch, a tag or a commit (BranchPicker with
 * `acceptsTypedRef`, mounted by TaskBranchRow). What only a browser proves: the
 * "Use" row and its Enter, git's error shown inline with the menu still open,
 * the segment's icon and short SHA, the local rows, and the field error that
 * holds Create for a tag base in the project folder.
 *
 * Each test types a ref no other test types: the picker keeps what main
 * answered for a ref, per page.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

const PROJECT_NAME = `Base Ref Picker ${Date.now()}`;
const TAGGED_SHA = 'b'.repeat(40);
let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  // Seeded before the first branch fetch, which the picker caches for 15s.
  await page.evaluate((taggedSha) => {
    const seeded = window as unknown as { __mockGitRefs: Record<string, unknown>; __mockGitLocalBranches: string[] };
    seeded.__mockGitRefs = {
      'v2.4.0': { kind: 'tag', sha: taggedSha },
      'v3.0.0': { kind: 'tag', sha: taggedSha },
      'v9.9.9': { error: 'fatal: Needed a single revision' },
      'v4.0.0': { kind: 'tag', sha: taggedSha },
      'v4.1.0': { kind: 'tag', sha: taggedSha },
      'v5.0.0': { kind: 'tag', sha: taggedSha },
      'main~1': { reason: 'not-a-base', error: "'main~1' is not a branch, tag or commit SHA." },
    };
    seeded.__mockGitLocalBranches = ['wip/cache-spike'];
  }, TAGGED_SHA);
  await createProject(page, PROJECT_NAME);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openNewTaskDialog(): Promise<void> {
  await page.locator('[data-swimlane-name="To Do"]').locator('text=Add task').click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'visible' });
}

async function closeDialog(): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
}

async function openPickerAndType(ref: string): Promise<void> {
  await page.locator('[data-testid="branch-picker-chip"]').click();
  const search = page.locator('[data-testid="branch-picker-search"]');
  await expect(search).toHaveAttribute('placeholder', 'Search, or type a tag or commit');
  // The list has loaded once the default branch row is there.
  await expect(page.locator('[data-testid="branch-picker-dropdown"] button', { hasText: 'develop' })).toBeVisible();
  await search.fill(ref);
}

test('a typed tag offers a Use row, Enter takes it, and the segment draws it as a tag', async () => {
  await openNewTaskDialog();
  await openPickerAndType('v2.4.0');

  const useRow = page.locator('[data-testid="branch-picker-use-typed"]');
  await expect(useRow).toContainText('Use v2.4.0');
  await page.keyboard.press('Enter');

  await expect(page.locator('[data-testid="branch-picker-dropdown"]')).toBeHidden();
  const segment = page.locator('[data-testid="branch-picker-chip"]');
  await expect(segment).toContainText('v2.4.0');
  await expect(segment).toHaveAttribute('data-base-kind', 'tag');
  await expect(page.locator('[data-testid="task-branch-row"]').locator('..')).toContainText('created from v2.4.0');

  await closeDialog();
});

test('a ref that names nothing shows git\'s own error inline, keeps the menu open and the base unchanged', async () => {
  await openNewTaskDialog();
  await openPickerAndType('v9.9.9');
  await page.locator('[data-testid="branch-picker-use-typed"]').click();

  const error = page.locator('[data-testid="branch-picker-ref-error"]');
  await expect(error).toHaveText('fatal: Needed a single revision');
  await expect(page.locator('[data-testid="branch-picker-dropdown"]')).toBeVisible();
  await expect(page.locator('[data-testid="branch-picker-chip"]')).toContainText('main');

  // Editing the query clears it.
  await page.locator('[data-testid="branch-picker-search"]').fill('v9.9');
  await expect(error).toBeHidden();

  // Escape closes the menu, not the dialog under it.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="branch-picker-dropdown"]')).toBeHidden();
  await expect(page.locator('input[placeholder="Task title"]')).toBeVisible();

  await closeDialog();
});

test('a typed commit reads as its short SHA, with the whole SHA in the tip', async () => {
  await openNewTaskDialog();
  await openPickerAndType('3f9c2a1e8b04d7c6a5f1e2d3c4b5a69788d0e1f2');
  await page.keyboard.press('Enter');

  const segment = page.locator('[data-testid="branch-picker-chip"]');
  await expect(segment).toHaveAttribute('data-base-kind', 'commit');
  await expect(segment).toHaveText('3f9c2a1');
  await expect(segment).toHaveAccessibleDescription('Base commit: 3f9c2a1e8b04d7c6a5f1e2d3c4b5a69788d0e1f2');

  await closeDialog();
});

test('local-only branches follow origin\'s, marked local, and an exact name needs no Use row', async () => {
  await openNewTaskDialog();
  await openPickerAndType('wip/cache-spike');

  const localRow = page.locator('[data-testid="branch-picker-dropdown"] button', { hasText: 'wip/cache-spike' });
  await expect(localRow.locator('[data-testid="branch-picker-local"]')).toHaveText('local');
  await expect(page.locator('[data-testid="branch-picker-use-typed"]')).toHaveCount(0);

  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="branch-picker-chip"]')).toContainText('wip/cache-spike');

  await closeDialog();
});

interface ResolveRefCall { ref: string; projectId: string | null; fetchTag: boolean }
interface HeldChecksWindow {
  __mockGitResolveRefCalls?: ResolveRefCall[];
  __heldReleases: Array<() => Promise<void>>;
  __restoreResolveRef: () => void;
}

/** Holds every typed-ref check (fetchTag true) until releaseHeldChecks; passive reads pass through. */
async function holdTypedRefChecks(): Promise<void> {
  await page.evaluate(() => {
    const held = window as unknown as HeldChecksWindow;
    const gitApi = window.electronAPI.git;
    const original = gitApi.resolveRef.bind(gitApi);
    held.__heldReleases = [];
    held.__restoreResolveRef = () => { gitApi.resolveRef = original; };
    gitApi.resolveRef = (ref, projectId, options) => {
      if (!options?.fetchTag) return original(ref, projectId, options);
      return new Promise((resolve) => {
        held.__heldReleases.push(async () => { resolve(await original(ref, projectId, options)); });
      });
    };
  });
}

async function releaseHeldChecks(): Promise<void> {
  await page.evaluate(async () => {
    const held = window as unknown as HeldChecksWindow;
    await Promise.all(held.__heldReleases.splice(0).map((release) => release()));
    // Let the picker's continuation run before the caller looks.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function restoreResolveRef(): Promise<void> {
  await page.evaluate(() => (window as unknown as HeldChecksWindow).__restoreResolveRef());
}

async function heldCheckCount(): Promise<number> {
  return page.evaluate(() => (window as unknown as HeldChecksWindow).__heldReleases.length);
}

test('a typed-ref answer that lands after the query was edited does not take the base', async () => {
  await openNewTaskDialog();
  await holdTypedRefChecks();
  try {
    await openPickerAndType('v4.0.0');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="branch-picker-use-typed"]')).toContainText('Checking');
    await expect.poll(heldCheckCount).toBe(1);

    await page.locator('[data-testid="branch-picker-search"]').fill('v4.0');
    await releaseHeldChecks();

    // A committed base would close the menu and relabel the segment.
    await expect(page.locator('[data-testid="branch-picker-dropdown"]')).toBeVisible();
    await expect(page.locator('[data-testid="branch-picker-chip"]')).toHaveText('main');
    await expect(page.locator('[data-testid="branch-picker-chip"]')).toHaveAttribute('data-base-kind', 'branch');
  } finally {
    await restoreResolveRef();
  }
  // The first Escape closes the menu, the second the dialog.
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid="branch-picker-dropdown"]')).toBeHidden();
  await closeDialog();
});

test('a typed-ref answer that lands after Escape closed the menu does not take the base', async () => {
  await openNewTaskDialog();
  await holdTypedRefChecks();
  try {
    await openPickerAndType('v4.1.0');
    await page.keyboard.press('Enter');
    await expect.poll(heldCheckCount).toBe(1);

    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="branch-picker-dropdown"]')).toBeHidden();
    await releaseHeldChecks();

    await expect(page.locator('[data-testid="branch-picker-chip"]')).toHaveText('main');
    await expect(page.locator('[data-testid="branch-picker-chip"]')).toHaveAttribute('data-base-kind', 'branch');
  } finally {
    await restoreResolveRef();
  }
  await closeDialog();
});

test('the Use row asks main with fetchTag, and the segment then reads the answer without asking again', async () => {
  await openNewTaskDialog();
  await page.evaluate(() => { (window as unknown as HeldChecksWindow).__mockGitResolveRefCalls = []; });
  await openPickerAndType('v5.0.0');
  await page.keyboard.press('Enter');

  const segment = page.locator('[data-testid="branch-picker-chip"]');
  await expect(segment).toHaveAttribute('data-base-kind', 'tag');
  const fetchTagFlags = () => page.evaluate(
    () => ((window as unknown as HeldChecksWindow).__mockGitResolveRefCalls ?? [])
      .filter((call) => call.ref === 'v5.0.0')
      .map((call) => call.fetchTag),
  );
  // Only the Use row may fetch; the segment's passive lookup is cached or local.
  expect(await fetchTagFlags()).toEqual([true]);

  await closeDialog();
});

test('a miss worded by main shows our text, a leading dash shows the option text, and the Enter hint stays', async () => {
  await openNewTaskDialog();
  await openPickerAndType('main~1');
  await page.keyboard.press('Enter');

  const error = page.locator('[data-testid="branch-picker-ref-error"]');
  await expect(error).toHaveText('Not a branch, tag or commit SHA');
  const useRow = page.locator('[data-testid="branch-picker-use-typed"]');
  await expect(useRow.getByText('Enter', { exact: true })).toBeVisible();

  await page.locator('[data-testid="branch-picker-search"]').fill('-x');
  await page.keyboard.press('Enter');
  await expect(error).toHaveText('Starts with a dash, so git would read it as an option');
  await expect(useRow.getByText('Enter', { exact: true })).toBeVisible();

  await page.keyboard.press('Escape');
  await closeDialog();
});

test('a commit base in the project folder with no branch name shows the commit error and holds Create', async () => {
  await openNewTaskDialog();
  await page.locator('input[placeholder="Task title"]').fill('Bisect the flaky export');
  await openPickerAndType('c0ffee1234567');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-testid="branch-picker-chip"]')).toHaveAttribute('data-base-kind', 'commit');
  await page.locator('[data-testid="worktree-option-project"]').click();

  await expect(page.getByText('Name a branch to start from a commit in the project folder')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeDisabled();

  await page.locator('[data-testid="custom-branch-name-input"]').fill('bisect/export');
  await expect(page.getByText('Name a branch to start from a commit in the project folder')).toBeHidden();
  await expect(page.locator('button[type="submit"]')).toBeEnabled();

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
});

test('a custom branch name that is a local-only listed branch reads as checked out, not created', async () => {
  await openNewTaskDialog();
  await page.locator('[data-testid="custom-branch-name-input"]').fill('wip/cache-spike');
  const hint = page.locator('[data-testid="task-branch-row"]').locator('..');
  await expect(hint).toContainText('exists and will be checked out');
  await expect(hint).not.toContainText('will be created');

  await page.locator('[data-testid="custom-branch-name-input"]').fill('wip/not-a-real-branch');
  await expect(hint).toContainText('will be created from');

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
});

test('the Settings > Git default base picker takes branches only: no Use row, and Enter does nothing', async () => {
  const settingsPage = await launchPage();
  try {
    await createProject(settingsPage.page, `Base Ref Settings ${Date.now()}`);
    await settingsPage.page.locator('[data-testid="settings-button"]').click();
    await settingsPage.page.getByRole('button', { name: 'Git', exact: true }).click();

    const trigger = settingsPage.page.locator('[data-testid="branch-picker-input"]');
    await trigger.click();
    const search = settingsPage.page.locator('[data-testid="branch-picker-search"]');
    await expect(search).toHaveAttribute('placeholder', 'Search branches...');
    await expect(settingsPage.page.locator('[data-testid="branch-picker-dropdown"] button', { hasText: 'develop' })).toBeVisible();

    const before = await trigger.textContent();
    await search.fill('deadbeef1');
    await expect(settingsPage.page.locator('[data-testid="branch-picker-use-typed"]')).toHaveCount(0);
    await search.press('Enter');

    // Nothing was taken or asked: the menu is still open on the same setting.
    await expect(settingsPage.page.locator('[data-testid="branch-picker-dropdown"]')).toBeVisible();
    await expect(trigger).toHaveText(before ?? '');
    const asked = await settingsPage.page.evaluate(
      () => ((window as unknown as HeldChecksWindow).__mockGitResolveRefCalls ?? []).map((call) => call.ref),
    );
    expect(asked).not.toContain('deadbeef1');
  } finally {
    await settingsPage.browser.close();
  }
});

test('a tag base in the project folder with no branch name holds Create until a branch is named', async () => {
  await openNewTaskDialog();
  await page.locator('input[placeholder="Task title"]').fill('Reproduce the export crash');
  await openPickerAndType('v3.0.0');
  await page.keyboard.press('Enter');
  await page.locator('[data-testid="worktree-option-project"]').click();

  await expect(page.getByText('Name a branch to start from a tag in the project folder')).toBeVisible();
  await expect(page.locator('button[type="submit"]')).toBeDisabled();

  await page.locator('[data-testid="custom-branch-name-input"]').fill('hotfix/export-crash');
  await expect(page.getByText('Name a branch to start from a tag in the project folder')).toBeHidden();
  await expect(page.locator('button[type="submit"]')).toBeEnabled();

  // The dialog has a title now, so closing it asks to discard.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Discard' }).click();
  await page.locator('input[placeholder="Task title"]').waitFor({ state: 'hidden', timeout: 2000 });
});
