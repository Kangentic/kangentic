/**
 * Jira import in the browser: the provider row, the Connect dialog per site
 * (Cloud opens straight on the API token steps; Data Center on two equal
 * choices), its error lines, the popover's own lines, and the Import dialog's
 * Jira rows and Reconnect banner. Driven against the headless mock
 * (`window.__mockJiraPreset`, `__mockImportCheckCli`, `__mockImportSourcesAddError`).
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject } from './helpers';

test.describe.configure({ mode: 'parallel' });

async function openJiraLinkStep(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.locator('[data-testid="add-import-source-btn"]').first().click();
  await page.getByRole('button', { name: /Jira/ }).click();
  await expect(page.locator('[data-testid="import-source-url-input"]')).toBeVisible();
}

async function pasteAndConnect(page: Page, text: string): Promise<void> {
  await page.locator('[data-testid="import-source-url-input"]').fill(text);
  await page.locator('[data-testid="import-source-connect-btn"]').click();
}

async function setJiraPreset(page: Page, preset: unknown): Promise<void> {
  await page.evaluate((value) => {
    (window as unknown as { __mockJiraPreset?: unknown }).__mockJiraPreset = value;
  }, preset);
}

test.describe('Jira in Add Source', () => {
  test('a Cloud link with no sign-in opens Connect on the API token steps, and connecting adds the source', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-cloud-connect');
    await openJiraLinkStep(page);
    await pasteAndConnect(page, 'https://acme.atlassian.net/jira/software/projects/ENG/boards/12');

    const dialog = page.locator('[data-testid="jira-connect-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(page.locator('[data-testid="jira-connect-site-input"]')).toHaveValue('acme.atlassian.net');
    // Cloud opens straight on its steps until the browser sign-in ships, so there is no Back.
    await expect(page.locator('[data-testid="jira-connect-back-btn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="jira-connect-connect-btn"]')).toBeDisabled();

    await page.locator('[data-testid="jira-connect-email-input"]').fill('dana@acme.example');
    await page.locator('[data-testid="jira-connect-secret-input"]').fill('cloud-token');
    await page.locator('[data-testid="jira-connect-connect-btn"]').click();

    await expect(dialog).toBeHidden();
    // The add continues once the sign-in is saved, and the Import dialog opens.
    await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
    const sent = await page.evaluate(() => (window as unknown as { __lastJiraConnectInput?: unknown }).__lastJiraConnectInput);
    expect(sent).toMatchObject({ site: 'acme.atlassian.net', method: 'api-token', email: 'dana@acme.example', secret: 'cloud-token' });
    await browser.close();
  });

  test('a Data Center link opens on two choices; password shows its fields, and Back returns', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-dc-connect');
    await openJiraLinkStep(page);
    await pasteAndConnect(page, 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=12');

    await expect(page.locator('[data-testid="jira-connect-choice-pat"]')).toBeVisible();
    await page.locator('[data-testid="jira-connect-choice-password"]').click();
    await expect(page.locator('[data-testid="jira-connect-username-input"]')).toBeVisible();
    await page.locator('[data-testid="jira-connect-back-btn"]').click();
    await expect(page.locator('[data-testid="jira-connect-choice-pat"]')).toBeVisible();

    await page.locator('[data-testid="jira-connect-choice-pat"]').click();
    await expect(page.locator('[data-testid="jira-connect-open-profile-btn"]')).toContainText('jira.example.com');
    await browser.close();
  });

  test('a refused token shows its line and keeps the dialog open with what was typed', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-rejected');
    await setJiraPreset(page, { rejectSecret: 'bad-token' });
    await openJiraLinkStep(page);
    await pasteAndConnect(page, 'https://acme.atlassian.net/browse/ENG');

    await page.locator('[data-testid="jira-connect-email-input"]').fill('dana@acme.example');
    await page.locator('[data-testid="jira-connect-secret-input"]').fill('bad-token');
    await page.locator('[data-testid="jira-connect-connect-btn"]').click();

    await expect(page.locator('[data-testid="jira-connect-error"]')).toHaveText('Jira rejected this email and token.');
    await expect(page.locator('[data-testid="jira-connect-email-input"]')).toHaveValue('dana@acme.example');
    await browser.close();
  });

  test('cancelling Connect from a pasted link stays on the link step with the link kept', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-cancel-connect');
    await openJiraLinkStep(page);
    const link = 'https://acme.atlassian.net/jira/software/projects/ENG/boards/12';
    await pasteAndConnect(page, link);

    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeVisible();
    await page.locator('[data-testid="jira-connect-cancel-btn"]').click();

    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeHidden();
    // Unlike an account-wide provider (Asana), which drops back to the provider list,
    // a link the user pasted is theirs to retry, so the step and its text stay.
    await expect(page.locator('[data-testid="import-source-url-input"]')).toHaveValue(link);
    await expect(page.locator('[data-testid="import-dialog"]')).toHaveCount(0);
    await browser.close();
  });

  test('typed JQL with two connected sites asks for a search link', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-two-sites');
    await setJiraPreset(page, {
      sites: {
        'acme.atlassian.net': { method: 'api-token', email: 'a@example.com', account: 'a@example.com' },
        'jira.example.com': { method: 'pat', account: 'dpark' },
      },
    });
    await openJiraLinkStep(page);
    await pasteAndConnect(page, 'project = ENG AND sprint in openSprints()');
    await expect(page.locator('[data-testid="import-source-error"]')).toHaveText('Paste a search link so the site is known.');
    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toHaveCount(0);
    await browser.close();
  });

  test("a source Jira refuses shows main's line without the IPC decoration", async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-no-board');
    await setJiraPreset(page, { sites: { 'acme.atlassian.net': { method: 'api-token', email: 'a@example.com', account: 'a@example.com' } } });
    await page.evaluate(() => {
      (window as unknown as { __mockImportSourcesAddError?: string }).__mockImportSourcesAddError = 'No board 12 that this account can open.';
    });
    await openJiraLinkStep(page);
    await pasteAndConnect(page, 'https://acme.atlassian.net/jira/software/projects/ENG/boards/12');
    await expect(page.locator('[data-testid="import-source-error"]')).toHaveText('No board 12 that this account can open.');
    await browser.close();
  });
});

function jiraIssue(id: string, key: string, title: string, state: string, stateOrder: number) {
  return {
    externalId: id,
    externalSource: 'jira',
    externalUrl: `https://acme.atlassian.net/browse/${key}`,
    title,
    body: '',
    labels: [],
    assignee: null,
    state,
    stateOrder,
    stateCategory: 'open',
    workItemType: 'Story',
    displayId: key,
    priority: 'High',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    alreadyImported: false,
    attachmentCount: 0,
  };
}

async function seedJiraSource(page: Page): Promise<void> {
  await page.evaluate((issues) => {
    const host = window as unknown as Record<string, unknown>;
    host.__mockImportSourcesPreset = [{
      id: 'jira-src',
      source: 'jira',
      label: 'ENG board',
      repository: 'https://acme.atlassian.net::board::12',
      url: 'https://acme.atlassian.net/jira/software/projects/ENG/boards/12',
      createdAt: new Date().toISOString(),
    }];
    host.__mockImportCached = { issues };
    host.__mockImportReconcile = { issues };
    host.__mockJiraPreset = { sites: { 'acme.atlassian.net': { method: 'api-token', email: 'dana@acme.example', account: 'dana@acme.example' } } };
  }, [
    jiraIssue('10003', 'ENG-150', 'Reviewed thing', 'In Review', 2),
    jiraIssue('10001', 'ENG-142', 'Todo thing', 'To Do', 0),
    jiraIssue('10002', 'ENG-145', 'Doing thing', 'In Progress', 1),
  ]);
}

async function openJiraSource(page: Page): Promise<void> {
  await page.locator('[data-testid="view-toggle-backlog"]').click();
  await page.locator('[data-testid="import-sources-btn"]').first().click();
  await page.getByText('ENG board').click();
  await expect(page.locator('[data-testid="import-dialog"]')).toBeVisible();
}

test.describe('Import dialog with a Jira source', () => {
  test('rows show the issue key and the Status filter lists board columns in board order', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-import-rows');
    await seedJiraSource(page);
    await openJiraSource(page);

    await expect(page.locator('[data-testid="import-issue-10001"]')).toContainText('ENG-142');
    const statusButton = page.getByRole('button', { name: 'Status' });
    await statusButton.click();
    const options = page.locator('[data-testid^="filter-option-status-"]');
    await expect(options).toHaveText(['To Do', 'In Progress', 'In Review']);
    // Close the menu with its own button: Escape would close the Import dialog.
    await statusButton.click();
    await expect(page.locator('[data-testid="filter-menu-status"]')).toBeHidden();

    // The import carries the priority name and the type to main.
    await page.locator('[data-testid="import-issue-10001"]').click();
    await page.locator('[data-testid="import-execute-btn"]').click();
    const sent = await page.evaluate(() => (window as unknown as { __lastImportExecuteInput?: { issues: unknown[] } }).__lastImportExecuteInput);
    expect(sent?.issues[0]).toMatchObject({ externalId: '10001', priority: 'High', itemType: 'Story' });
    await browser.close();
  });

  test('a refused saved token offers Connect Jira, which reopens with the site and email filled', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-reconnect');
    await seedJiraSource(page);
    await page.evaluate(() => {
      (window as unknown as { __mockImportCheckCli?: unknown }).__mockImportCheckCli = (source: string, repository: string) =>
        (source === 'jira' && repository.startsWith('https://acme.atlassian.net::')
          ? { available: true, authenticated: false, error: 'Jira rejected the saved token.' }
          : null);
    });
    await openJiraSource(page);

    await expect(page.locator('[data-testid="import-cli-error"]')).toContainText('Jira rejected the saved token.');
    await page.locator('[data-testid="import-connect-provider-btn"]').click();
    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="jira-connect-site-input"]')).toHaveValue('acme.atlassian.net');
    await expect(page.locator('[data-testid="jira-connect-email-input"]')).toHaveValue('dana@acme.example');
    await expect(page.locator('[data-testid="jira-connect-secret-input"]')).toHaveValue('');
    // Why the dialog opened, until the user's own try replaces it.
    await expect(page.locator('[data-testid="jira-connect-error"]')).toHaveText('Jira rejected the saved token.');

    // Connecting again clears the banner and syncs.
    await page.evaluate(() => {
      (window as unknown as { __mockImportCheckCli?: unknown }).__mockImportCheckCli = undefined;
    });
    await page.locator('[data-testid="jira-connect-secret-input"]').fill('new-token');
    await page.locator('[data-testid="jira-connect-connect-btn"]').click();
    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeHidden();
    await expect(page.locator('[data-testid="import-cli-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="import-issue-10001"]')).toBeVisible();
    await browser.close();
  });

  test('a failed sync shows the sign-in banner, not the error banner, when the sign-in check then fails', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-sync-auth');
    await seedJiraSource(page);
    await page.evaluate(() => {
      const host = window as unknown as Record<string, unknown>;
      host.__mockImportReconcileFailUntilCleared = true;
      // The check passes until a reconcile has been attempted, so the reconcile runs
      // and fails. The re-check after that failure finds the sign-in gone.
      host.__mockImportCheckCli = (source: string) => {
        const reconciled = ((host.__mockImportReconcileCallCount as number | undefined) ?? 0) > 0;
        return source === 'jira' && reconciled ? { available: true, authenticated: false } : null;
      };
    });
    await openJiraSource(page);
    await expect(page.locator('[data-testid="import-connect-provider-btn"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await browser.close();
  });

  test('a failed sync with a sign-in that still passes shows the error banner with Retry, not the sign-in banner', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-sync-error');
    await seedJiraSource(page);
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockImportReconcileFailUntilCleared = true;
    });
    await openJiraSource(page);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(page.locator('[data-testid="import-cli-error"]')).toHaveCount(0);
    await browser.close();
  });
});

/** Let any promise callbacks and the render they cause run. */
async function flushRender(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

test.describe('Jira Connect dialog site edits', () => {
  test('a late failure for a site since edited away shows no error and keeps the new site\'s steps', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-stale-detect');
    await page.evaluate(() => {
      const host = window as unknown as Record<string, unknown>;
      // Detection for site A hangs until the test rejects it. Site B answers at once.
      host.__mockJiraDetectSiteHook = (siteOrUrl: string) => (siteOrUrl === 'a.example.com'
        ? new Promise<void>((_resolve, reject) => { host.__rejectSiteA = () => reject(new Error('unreachable')); })
        : undefined);
    });
    await openJiraLinkStep(page);
    // Typed JQL with no site connected opens Connect with an empty Site field.
    await pasteAndConnect(page, 'project = ENG');
    const siteInput = page.locator('[data-testid="jira-connect-site-input"]');
    await expect(siteInput).toBeVisible();

    await siteInput.fill('a.example.com');
    await siteInput.blur();
    await siteInput.fill('b.example.com');
    await siteInput.blur();
    // B is Data Center, so the Site edit leaves the Cloud token steps for the profile steps.
    await expect(page.locator('[data-testid="jira-connect-open-profile-btn"]')).toContainText('b.example.com');

    await page.evaluate(() => (window as unknown as { __rejectSiteA: () => void }).__rejectSiteA());
    await flushRender(page);
    await expect(page.locator('[data-testid="jira-connect-error"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="jira-connect-open-profile-btn"]')).toContainText('b.example.com');
    await browser.close();
  });

  test('a Data Center password choice survives editing the Site to another Data Center host', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-dc-password-kept');
    await page.evaluate(() => {
      const host = window as unknown as Record<string, unknown>;
      host.__detectCalls = [];
      host.__mockJiraDetectSiteHook = (siteOrUrl: string) => {
        (host.__detectCalls as string[]).push(siteOrUrl);
        return undefined;
      };
    });
    await openJiraLinkStep(page);
    await pasteAndConnect(page, 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=12');
    await page.locator('[data-testid="jira-connect-choice-password"]').click();
    await expect(page.locator('[data-testid="jira-connect-username-input"]')).toBeVisible();

    const siteInput = page.locator('[data-testid="jira-connect-site-input"]');
    await siteInput.fill('jira.other.example.com');
    await siteInput.blur();
    await expect.poll(async () => page.evaluate(() => (window as unknown as { __detectCalls: string[] }).__detectCalls))
      .toContain('jira.other.example.com');
    await flushRender(page);

    await expect(page.locator('[data-testid="jira-connect-username-input"]')).toBeVisible();
    await expect(page.locator('[data-testid="jira-connect-open-profile-btn"]')).toHaveCount(0);
    await browser.close();
  });
});

const DATA_CENTER_LINK = 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=12';

const CONNECT_FAILURE_LINES: Array<{
  name: string;
  method: 'pat' | 'password';
  result: Record<string, unknown>;
  line: string;
}> = [
  { name: 'captcha', method: 'password', result: { ok: false, code: 'captcha' }, line: 'Jira wants a CAPTCHA before password sign-in.' },
  { name: 'password-off', method: 'password', result: { ok: false, code: 'password-off' }, line: 'This site turned off password sign-in.' },
  { name: 'invalid', method: 'pat', result: { ok: false, code: 'invalid' }, line: 'Check the site address.' },
  { name: 'unreachable with detail', method: 'pat', result: { ok: false, code: 'unreachable', site: 'jira.example.com', detail: 'timed out' }, line: "Couldn't reach jira.example.com: timed out." },
  { name: 'unreachable without detail', method: 'pat', result: { ok: false, code: 'unreachable', site: 'jira.example.com' }, line: "Couldn't reach jira.example.com." },
  { name: 'rejected pat', method: 'pat', result: { ok: false, code: 'rejected' }, line: 'Jira rejected this token.' },
  { name: 'rejected password', method: 'password', result: { ok: false, code: 'rejected' }, line: 'Jira rejected this username and password.' },
];

test.describe('Jira Connect dialog failure lines', () => {
  for (const failure of CONNECT_FAILURE_LINES) {
    test(`${failure.name} shows its line and keeps the dialog open`, async () => {
      const { browser, page } = await launchPage();
      await createProject(page, 'jira-failure-line');
      await setJiraPreset(page, { connectResult: failure.result });
      await openJiraLinkStep(page);
      await pasteAndConnect(page, DATA_CENTER_LINK);

      await page.locator(`[data-testid="jira-connect-choice-${failure.method === 'pat' ? 'pat' : 'password'}"]`).click();
      if (failure.method === 'password') {
        await page.locator('[data-testid="jira-connect-username-input"]').fill('dpark');
      }
      await page.locator('[data-testid="jira-connect-secret-input"]').fill('some-secret');
      await page.locator('[data-testid="jira-connect-connect-btn"]').click();

      await expect(page.locator('[data-testid="jira-connect-error"]')).toHaveText(failure.line);
      await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeVisible();
      await browser.close();
    });
  }
});

test.describe('Jira Connect dialog reopen and cancel', () => {
  test('a reopen for a rejected Data Center token lands on the token steps, not the two choices', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-reopen-pat');
    await page.evaluate(() => {
      const host = window as unknown as Record<string, unknown>;
      host.__mockImportSourcesPreset = [{
        id: 'jira-dc-src',
        source: 'jira',
        label: 'ENG board',
        repository: 'https://jira.example.com::board::12',
        url: 'https://jira.example.com/secure/RapidBoard.jspa?rapidView=12',
        createdAt: new Date().toISOString(),
      }];
      host.__mockImportCached = { issues: [] };
      host.__mockImportReconcile = { issues: [] };
      host.__mockJiraPreset = { sites: { 'jira.example.com': { method: 'pat', account: 'dpark' } } };
      host.__mockImportCheckCli = (source: string) => (source === 'jira'
        ? { available: true, authenticated: false, error: 'Jira rejected the saved token.' }
        : null);
    });
    await openJiraSource(page);
    await page.locator('[data-testid="import-connect-provider-btn"]').click();

    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="jira-connect-open-profile-btn"]')).toContainText('jira.example.com');
    await expect(page.locator('[data-testid="jira-connect-choice-pat"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="jira-connect-choice-password"]')).toHaveCount(0);
    await browser.close();
  });

  test('a Connect still in flight when the user cancels does not carry the add on once it lands', async () => {
    const { browser, page } = await launchPage();
    await createProject(page, 'jira-cancel-in-flight');
    await page.evaluate(() => {
      const host = window as unknown as Record<string, unknown>;
      host.__releaseConnects = [];
      // Every Connect hangs until the test releases it (the mock then answers ok).
      host.__mockJiraConnectHook = () => new Promise<void>((resolve) => {
        (host.__releaseConnects as Array<() => void>).push(resolve);
      });
    });
    await openJiraLinkStep(page);
    const link = 'https://acme.atlassian.net/jira/software/projects/ENG/boards/12';
    await pasteAndConnect(page, link);

    const fillAndConnect = async () => {
      await page.locator('[data-testid="jira-connect-email-input"]').fill('dana@acme.example');
      await page.locator('[data-testid="jira-connect-secret-input"]').fill('cloud-token');
      await page.locator('[data-testid="jira-connect-connect-btn"]').click();
    };
    const heldConnects = () => page.evaluate(() => (window as unknown as { __releaseConnects: unknown[] }).__releaseConnects.length);
    await fillAndConnect();
    await expect.poll(heldConnects).toBe(1);

    await page.locator('[data-testid="jira-connect-cancel-btn"]').click();
    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeHidden();
    // Cancel already ends the add's wait for the sign-in, so a late result alone has nothing to
    // resume. Starting a second Connect from the same link re-arms that wait, and the first
    // Connect landing then must not resume it: only the guard on the dialog that was closed stops that.
    await page.locator('[data-testid="import-source-connect-btn"]').click();
    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeVisible();
    await fillAndConnect();
    await expect.poll(heldConnects).toBe(2);

    await page.evaluate(() => (window as unknown as { __releaseConnects: Array<() => void> }).__releaseConnects[0]());
    await flushRender(page);

    await expect(page.locator('[data-testid="import-dialog"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="jira-connect-dialog"]')).toBeVisible();
    const added = await page.evaluate(() => (window as unknown as { __lastImportSourcesAddInput?: unknown }).__lastImportSourcesAddInput);
    expect(added).toBeUndefined();
    await browser.close();
  });
});
