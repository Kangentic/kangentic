/**
 * UI tests for Add project once an SSH host exists (#913).
 *
 * What only a browser proves: with no host, Add project goes straight to the folder picker and shows no
 * chooser (nobody who never adds a host sees a new step); with a host, a chooser lists This computer and
 * each host with its state; a host opens a folder form that checks the folder on the host and shows the
 * reason in place when it is missing, then adds the project. The main process is the mock bridge, so the
 * folder check and the shell folder are stand-ins; `ssh-host-admin.test.ts` covers the real ones.
 */
import { test, expect } from '@playwright/test';
import { launchPage, createProject } from './helpers';
import type { Browser, Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

let browser: Browser;
let page: Page;

test.beforeAll(async () => {
  const result = await launchPage();
  browser = result.browser;
  page = result.page;
  await createProject(page, `Remote Add ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

test.beforeEach(async () => {
  // The worker's page is shared, so a dialog a previous test left open would cover the sidebar.
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await expect(page.locator('[data-testid="add-project-chooser"], [data-testid="add-remote-project"]')).toHaveCount(0);
  await page.evaluate(async () => {
    const api = window.electronAPI.ssh;
    // Clear the host's data first: Remove only hides its projects, and the same address added again by the
    // next test would bring a previous test's projects back.
    for (const status of await api.listHosts()) {
      await api.clearHostData(status.host.id);
      await api.removeHost(status.host.id);
    }
    (window as unknown as { __mockSshForgetRemoved: () => void }).__mockSshForgetRemoved();
    delete (window as unknown as Record<string, unknown>).__mockSshFolders;
    delete (window as unknown as Record<string, unknown>).__mockSshDirectories;
    delete (window as unknown as Record<string, unknown>).__mockSshFolderError;
  });
});

async function addHost(name: string) {
  await page.evaluate(async (hostName) => {
    await window.electronAPI.ssh.addHost({
      name: hostName,
      destination: 'dev@host.example.test',
      signIn: { method: 'config' },
      expectedFingerprint: 'SHA256:x',
    });
  }, name);
  // The host store hears the push and reloads.
  await expect.poll(() => page.evaluate(async () => (await window.electronAPI.ssh.listHosts()).length)).toBeGreaterThan(0);
}

async function projectPaths(): Promise<string[]> {
  return page.evaluate(async () => (await window.electronAPI.projects.list()).map((project) => project.path));
}

test('goes straight to the folder picker when no host exists', async () => {
  const pickedPath = `/mock/path/direct-${Date.now()}`;
  await page.evaluate((folderPath) => {
    (window as unknown as Record<string, unknown>).__mockFolderPath = folderPath;
  }, pickedPath);

  await page.locator('[data-testid="sidebar-new-project-button"]').click();

  // The picker's answer became a project, with no chooser in between.
  await expect.poll(projectPaths).toContain(pickedPath);
  await expect(page.locator('[data-testid="add-project-chooser"]')).toHaveCount(0);
});

test('This computer in the chooser opens the folder picker', async () => {
  await addHost('Build server');
  const pickedPath = `/mock/path/chooser-${Date.now()}`;
  await page.evaluate((folderPath) => {
    (window as unknown as Record<string, unknown>).__mockFolderPath = folderPath;
  }, pickedPath);

  await page.locator('[data-testid="sidebar-new-project-button"]').click();
  await page.locator('[data-testid="add-project-this-computer"]').click();

  await expect.poll(projectPaths).toContain(pickedPath);
  await expect(page.locator('[data-testid="add-project-chooser"]')).toHaveCount(0);
});

test('lists This computer and each host with its state', async () => {
  await addHost('Build server');
  await expect.poll(() => page.locator('[data-testid="sidebar-new-project-button"]').count()).toBeGreaterThan(0);

  await page.locator('[data-testid="sidebar-new-project-button"]').click();

  const chooser = page.locator('[data-testid="add-project-chooser"]');
  await expect(chooser).toBeVisible();
  await expect(chooser.locator('[data-testid="add-project-this-computer"]')).toBeVisible();
  const hostRow = chooser.locator('[data-testid="add-project-host"]');
  await expect(hostRow).toHaveCount(1);
  await expect(hostRow).toContainText('Build server');
  await expect(hostRow).toContainText('Connected');
});

test('shows the reason in place when the folder is not on the host, and adds the project when it is', async () => {
  await addHost('Build server');
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockSshFolders = { '/srv/missing': { exists: false, isGitRepo: false } };
  });
  await page.locator('[data-testid="sidebar-new-project-button"]').click();
  await page.locator('[data-testid="add-project-host"]').click();

  const form = page.locator('[data-testid="add-remote-project"]');
  await expect(form).toBeVisible();
  await form.locator('[data-testid="add-remote-project-folder"]').fill('/srv/missing');
  await form.locator('[data-testid="add-remote-project-submit"]').click();
  await expect(form.locator('[data-testid="add-remote-project-error"]')).toContainText('does not exist on Build server');

  // The name follows the folder until the user types their own.
  const projectName = `api-${Date.now()}`;
  await form.locator('[data-testid="add-remote-project-folder"]').fill(`/srv/${projectName}`);
  await expect(form.locator('[data-testid="add-remote-project-name"]')).toHaveValue(projectName);
  await form.locator('[data-testid="add-remote-project-submit"]').click();

  await expect(form).toHaveCount(0);
  const created = await page.evaluate(async (name) => {
    const projects = await window.electronAPI.projects.list();
    return projects.find((project) => project.name === name)?.remote ?? null;
  }, projectName);
  expect(created).toMatchObject({ path: `/srv/${projectName}` });
});

test('marks a remote project with its host, and warns above the board only while the host is down', async () => {
  await addHost('Build server');
  const projectName = `chip-${Date.now()}`;
  await page.locator('[data-testid="sidebar-new-project-button"]').click();
  await page.locator('[data-testid="add-project-host"]').click();
  const form = page.locator('[data-testid="add-remote-project"]');
  await form.locator('[data-testid="add-remote-project-folder"]').fill(`/srv/${projectName}`);
  await form.locator('[data-testid="add-remote-project-submit"]').click();
  await expect(form).toHaveCount(0);

  const row = page.locator('[data-testid^="project-row-"]', { hasText: projectName });
  const chip = row.locator('[data-testid="project-host-chip"]');
  await expect(chip).toHaveAttribute('data-host-state', 'connected');
  await expect(page.locator('[data-testid="host-degraded-strip"]')).toHaveCount(0);

  // The host drops: a spinner and a neutral strip. The agents on it are not touched.
  const setHostState = (state: string) => page.evaluate(async (hostState) => {
    const hosts = await window.electronAPI.ssh.listHosts();
    (window as unknown as Record<string, unknown>).__mockSshHosts = hosts.map((status) => ({ ...status, state: hostState }));
    (window as unknown as { __mockFireSshHostsChanged: () => void }).__mockFireSshHostsChanged();
  }, state);
  await setHostState('reconnecting');
  await expect(chip).toHaveAttribute('data-host-state', 'reconnecting');
  const strip = page.locator('[data-testid="host-degraded-strip"]');
  await expect(strip).toContainText('Reconnecting to Build server');
  await expect(strip.locator('[data-testid="host-degraded-reconnect"]')).toHaveCount(0);

  // Once it is unreachable the strip offers Reconnect, and reconnecting clears both.
  await setHostState('unreachable');
  await expect(chip).toHaveAttribute('data-host-state', 'unreachable');
  await expect(strip).toContainText('Build server is unreachable');
  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__mockSshHosts;
  });
  await strip.locator('[data-testid="host-degraded-reconnect"]').click();
  await expect(chip).toHaveAttribute('data-host-state', 'connected');
  await expect(strip).toHaveCount(0);
});

test('removing the host in Settings takes its projects out of the sidebar', async () => {
  await addHost('Build server');
  const projectName = `gone-${Date.now()}`;
  await page.locator('[data-testid="sidebar-new-project-button"]').click();
  await page.locator('[data-testid="add-project-host"]').click();
  const form = page.locator('[data-testid="add-remote-project"]');
  await form.locator('[data-testid="add-remote-project-folder"]').fill(`/srv/${projectName}`);
  await form.locator('[data-testid="add-remote-project-submit"]').click();
  await expect(form).toHaveCount(0);
  const row = page.locator('[data-testid^="project-row-"]', { hasText: projectName });
  await expect(row).toHaveCount(1);

  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('[data-testid="settings-tab-ssh"]').click();
  await page.locator('[data-testid="ssh-host-remove"]').click();
  const confirmDialog = page.locator('h3:has-text("Remove host")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');
  await expect(confirmDialog).toContainText('hides its projects and suspends their agents until it is added again, and nothing is deleted.');
  await confirmDialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(0);

  // The removed project was the open one. The most recently opened project left opens in its place, so
  // the panel keeps its project tabs, now for that one (`ssh-host-removal-next-project.spec.ts` covers
  // the theme, and the empty state when none is left).
  await expect(page.locator('[data-testid="settings-tab-ssh"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-tab-theme"]')).toBeVisible();
  expect(await page.evaluate(async () => (await window.electronAPI.projects.getCurrent())?.name ?? null)).not.toBe(projectName);

  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await expect(row).toHaveCount(0);
});

test('a remote project\'s Agent tab shows what the host has installed, and never says Not found for a host it could not ask', async () => {
  await addHost('Build server');
  const projectName = `agents-${Date.now()}`;
  await page.locator('[data-testid="sidebar-new-project-button"]').click();
  await page.locator('[data-testid="add-project-host"]').click();
  const form = page.locator('[data-testid="add-remote-project"]');
  await form.locator('[data-testid="add-remote-project-folder"]').fill(`/srv/${projectName}`);
  await form.locator('[data-testid="add-remote-project-submit"]').click();
  await expect(form).toHaveCount(0);

  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('[data-testid="settings-tab-agent"]').click();

  // Claude is on the host, with the host's version, and the path is the host's own PATH lookup: nothing to type.
  const claudeStatus = page.locator('[data-testid="agent-cli-status-claude"]');
  await expect(claudeStatus).toContainText('v2.1.80');
  await expect(page.locator('[data-testid="agent-cli-path-claude"]')).toBeDisabled();
  await expect(page.locator('[data-testid="agent-cli-path-claude"]')).toHaveAttribute('placeholder', 'claude');

  // The host's agents carry no capabilities, so the model row has no list to offer. It stays, as a
  // field to type into, and does not disappear as it did before.
  const defaultModel = page.locator('[data-testid="project-default-model"]');
  await expect(defaultModel).toBeVisible();
  await defaultModel.fill('claude-opus-5-5');
  await expect(defaultModel).toHaveValue('claude-opus-5-5');

  // Another agent that this computer might have is judged by the host alone.
  const codex = await page.evaluate(async () => (await window.electronAPI.agents.list()).find((agent) => agent.name === 'codex'));
  expect(codex).toMatchObject({ found: false, hostStatus: 'missing', path: 'codex' });
  expect(codex?.capabilities).toBeUndefined();

  // A host that could not be asked is not a host without the CLI.
  await page.evaluate(() => {
    (window as unknown as { __mockHostAgents: Record<string, string> }).__mockHostAgents = { claude: 'unknown' };
  });
  await page.locator('[data-testid="agent-cli-status-claude"]').locator('xpath=ancestor::*[.//button[@aria-label="Re-detect agent"]][1]').getByRole('button', { name: 'Re-detect agent' }).click();
  await expect(claudeStatus).toContainText('Not checked');
  await expect(claudeStatus).not.toContainText('Not found');
  await expect(page.locator('[data-testid="agent-cli-detail-claude"]')).toContainText('Connection timed out');

  await page.evaluate(() => {
    delete (window as unknown as { __mockHostAgents?: unknown }).__mockHostAgents;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

/** Adds a project on the host through the Add project dialog and waits for its sidebar row. */
async function addRemoteProject(projectName: string) {
  await page.locator('[data-testid="sidebar-new-project-button"]').click();
  await page.locator('[data-testid="add-project-host"]').click();
  const form = page.locator('[data-testid="add-remote-project"]');
  await form.locator('[data-testid="add-remote-project-folder"]').fill(`/srv/${projectName}`);
  await form.locator('[data-testid="add-remote-project-submit"]').click();
  await expect(form).toHaveCount(0);
  const row = page.locator('[data-testid^="project-row-"]', { hasText: projectName });
  await expect(row).toHaveCount(1);
  return row;
}

async function openSshSettings() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('[data-testid="settings-tab-ssh"]').click();
  await expect(page.locator('[data-testid="ssh-hosts-card"]')).toBeVisible();
}

async function closeSettings() {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await expect(page.locator('[data-testid="ssh-hosts-card"]')).toHaveCount(0);
}

test('removing a host hides its projects, and adding the same address again brings them back', async () => {
  await addHost('Build server');
  const projectName = `back-${Date.now()}`;
  const row = await addRemoteProject(projectName);

  await openSshSettings();
  await page.locator('[data-testid="ssh-host-remove"]').click();
  await page.locator('[data-testid="ssh-remove-host-confirm-confirm"]').click();
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ssh-no-hosts"]')).toBeVisible();
  await closeSettings();
  await expect(row).toHaveCount(0);

  // The same address, through the normal Add host steps. Nothing else is asked, and the project is back.
  await openSshSettings();
  await page.locator('[data-testid="ssh-add-host"]').click();
  await page.locator('[data-testid="ssh-add-name"]').fill('Build server');
  await page.locator('[data-testid="ssh-add-destination"]').fill('dev@host.example.test');
  await page.locator('[data-testid="ssh-add-continue"]').click();
  await page.locator('[data-testid="ssh-add-trust-accept"]').click();
  await page.locator('[data-testid="ssh-add-submit"]').click();
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="ssh-host-project-count"]')).toHaveText('1 project');
  await closeSettings();
  await expect(row).toHaveCount(1);
});

test('a different address after Remove is a new host, and the hidden project stays hidden', async () => {
  await addHost('Build server');
  const projectName = `stays-${Date.now()}`;
  const row = await addRemoteProject(projectName);
  await openSshSettings();
  await page.locator('[data-testid="ssh-host-remove"]').click();
  await page.locator('[data-testid="ssh-remove-host-confirm-confirm"]').click();
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(0);

  await page.locator('[data-testid="ssh-add-host"]').click();
  await page.locator('[data-testid="ssh-add-name"]').fill('Elsewhere');
  await page.locator('[data-testid="ssh-add-destination"]').fill('dev@other.example.test');
  await page.locator('[data-testid="ssh-add-continue"]').click();
  await page.locator('[data-testid="ssh-add-trust-accept"]').click();
  await page.locator('[data-testid="ssh-add-submit"]').click();
  await expect(page.locator('[data-testid="ssh-host-project-count"]')).toHaveText('0 projects');
  await closeSettings();
  await expect(row).toHaveCount(0);
});

test('Clear data lists the projects and their directories, deletes them, and the host stays with none', async () => {
  await addHost('Build server');
  const projectName = `clear-${Date.now()}`;
  const row = await addRemoteProject(projectName);

  await openSshSettings();
  await expect(page.locator('[data-testid="ssh-host-project-count"]')).toHaveText('1 project');
  await page.locator('[data-testid="ssh-host-clear-data"]').click();
  const list = page.locator('[data-testid="ssh-clear-data-projects"]');
  await expect(list).toContainText(projectName);
  await expect(list).toContainText(`/srv/${projectName}`);
  await page.locator('[data-testid="ssh-clear-data-confirm-confirm"]').click();

  // The host stays, with no projects, and nothing is left to clear.
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="ssh-host-project-count"]')).toHaveText('0 projects');
  await expect(page.locator('[data-testid="ssh-host-clear-data"]')).toHaveCount(0);
  await closeSettings();
  await expect(row).toHaveCount(0);
});

test('a host with no projects has no Clear data, and Cancel on the confirm deletes nothing', async () => {
  await addHost('Build server');
  const projectName = `keep-${Date.now()}`;
  await openSshSettings();
  await expect(page.locator('[data-testid="ssh-host-clear-data"]')).toHaveCount(0);
  await closeSettings();

  await addRemoteProject(projectName);
  await openSshSettings();
  await page.locator('[data-testid="ssh-host-clear-data"]').click();
  await page.locator('[data-testid="ssh-clear-data-confirm-cancel"]').click();
  await expect(page.locator('[data-testid="ssh-host-project-count"]')).toHaveText('1 project');
});

test.describe('the Directory field', () => {
  async function openRemoteForm() {
    await addHost('Build server');
    await page.locator('[data-testid="sidebar-new-project-button"]').click();
    await page.locator('[data-testid="add-project-host"]').click();
    const form = page.locator('[data-testid="add-remote-project"]');
    await expect(form).toBeVisible();
    return form;
  }

  test('is named Directory, and its explanation is a tip on an info icon rather than a standing line', async () => {
    const form = await openRemoteForm();

    await expect(form.getByText('Directory', { exact: true })).toBeVisible();
    await expect(form.locator('[data-testid="field-hint"]')).toHaveCount(0);
    await expect(form.getByRole('button', { name: 'About Directory' })).toHaveAccessibleDescription(/inside your home/);
  });

  test('suggests the folders of the directory typed so far, narrowed as you type, and a pick opens the next level', async () => {
    const form = await openRemoteForm();
    const field = form.locator('[data-testid="add-remote-project-folder"]');

    await field.fill('~/co');
    // The suggestions are a popover on the page, outside the dialog's own tree.
    const suggestions = page.locator('[data-testid="add-remote-project-suggestion"]');
    await expect(suggestions).toHaveText(['code']);

    await suggestions.first().click();
    await expect(field).toHaveValue('~/code/');
    await expect(suggestions).toHaveText(['api' + 'git', 'web' + 'git']);

    // The name follows the chosen folder, as it does for a typed one.
    await field.fill('~/code/ap');
    await expect(suggestions).toHaveText(['apigit']);
    await suggestions.first().click();
    await expect(form.locator('[data-testid="add-remote-project-name"]')).toHaveValue('api');
  });

  test('moves through suggestions with the arrow keys, and Enter picks the highlighted one instead of adding', async () => {
    const form = await openRemoteForm();
    const field = form.locator('[data-testid="add-remote-project-folder"]');
    await field.fill('~/');
    await expect(page.locator('[data-testid="add-remote-project-suggestion"]')).toHaveCount(2);

    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await field.press('Enter');

    await expect(field).toHaveValue('~/notes/');
    await expect(form).toBeVisible();
  });

  test('Escape closes the suggestions and leaves the dialog open, and the next one closes the dialog', async () => {
    const form = await openRemoteForm();
    const field = form.locator('[data-testid="add-remote-project-folder"]');
    await field.fill('~/');
    await expect(page.locator('[data-testid="add-remote-project-suggestion"]')).toHaveCount(2);
    await expect(field).toHaveAttribute('aria-controls', 'add-remote-project-suggestions');
    await expect(page.locator('#add-remote-project-suggestions')).toBeVisible();

    await field.press('Escape');

    await expect(page.locator('[data-testid="add-remote-project-suggestion"]')).toHaveCount(0);
    await expect(form).toBeVisible();

    await field.press('Escape');
    await expect(form).toHaveCount(0);
  });

  test('drops a stale reason once the host is back, without the path being edited', async () => {
    const form = await openRemoteForm();
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockSshFolderError = 'The link to the host is down.';
    });
    const field = form.locator('[data-testid="add-remote-project-folder"]');
    await field.fill('~/code/');
    const reason = form.locator('[data-testid="add-remote-project-suggestions-error"]');
    await expect(reason).toContainText('link to the host is down');

    await page.evaluate(async () => {
      const mockWindow = window as unknown as Record<string, unknown> & { __mockFireSshHostsChanged: () => void };
      delete mockWindow.__mockSshFolderError;
      const [status] = await window.electronAPI.ssh.listHosts();
      mockWindow.__mockSshHosts = [{ ...status, state: 'reconnecting' }];
      mockWindow.__mockFireSshHostsChanged();
    });
    await expect(reason).toHaveCount(0);
    await page.evaluate(() => {
      delete (window as unknown as Record<string, unknown>).__mockSshHosts;
    });
  });

  test('says nothing when a half-typed path matches no directory', async () => {
    const form = await openRemoteForm();
    await form.locator('[data-testid="add-remote-project-folder"]').fill('~/nowhere/sub');

    // Wait for the answer for the typed directory, so an empty popover is not just a list not asked yet.
    await expect(form.locator('[data-testid="add-remote-project-folder"]')).toHaveValue('~/nowhere/sub');
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="add-remote-project-suggestions"]')).toHaveCount(0);
    await expect(form.locator('[data-testid="add-remote-project-suggestions-error"]')).toHaveCount(0);
  });

  test('shows the reason in place when the host cannot be asked, and keeps what was typed', async () => {
    const form = await openRemoteForm();
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockSshFolderError = 'The link to the host is down.';
    });
    const field = form.locator('[data-testid="add-remote-project-folder"]');

    await field.fill('~/code/');

    await expect(form.locator('[data-testid="add-remote-project-suggestions-error"]')).toContainText('link to the host is down');
    await expect(field).toHaveValue('~/code/');
  });

  test('Browse lists the host\'s folders from home, goes down and back up by the breadcrumb, and Choose fills the field', async () => {
    const form = await openRemoteForm();
    const browse = form.locator('[data-testid="add-remote-project-browse"]');
    await expect(browse).toBeEnabled();
    // The press must land while the suggestions are open: their closing must not move the button under the pointer.
    await expect(page.locator('[data-testid="add-remote-project-suggestion"]')).toHaveCount(2);
    await browse.click();

    const entries = form.locator('[data-testid="add-remote-project-browse-entry"]');
    await expect(entries).toHaveText(['code', 'notes']);
    await entries.filter({ hasText: 'code' }).click();
    await expect(form.locator('[data-testid="add-remote-project-crumb"]')).toHaveText(['~', 'code']);
    await expect(entries).toHaveText(['apigit', 'webgit']);

    await form.locator('[data-testid="add-remote-project-crumb"]').first().click();
    await expect(entries).toHaveText(['code', 'notes']);

    await entries.filter({ hasText: 'code' }).click();
    await entries.filter({ hasText: 'api' }).click();
    await form.locator('[data-testid="add-remote-project-browse-choose"]').click();

    await expect(form.locator('[data-testid="add-remote-project-browser"]')).toHaveCount(0);
    await expect(form.locator('[data-testid="add-remote-project-folder"]')).toHaveValue('/home/dev/code/api');
  });

  test('Cancel in Browse goes back to the form with the field as it was', async () => {
    const form = await openRemoteForm();
    const field = form.locator('[data-testid="add-remote-project-folder"]');
    await field.fill('~/notes');
    await form.locator('[data-testid="add-remote-project-browse"]').click();
    await form.locator('[data-testid="add-remote-project-browse-entry"]').first().click();

    await form.locator('[data-testid="add-remote-project-browse-cancel"]').click();

    await expect(field).toHaveValue('~/notes');
  });
});

test('shows a host that cannot be reached as its own reason, never as a missing folder', async () => {
  await addHost('Build server');
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockSshFolderError = 'Kangentic has no connection set up for that host';
  });
  await page.locator('[data-testid="sidebar-new-project-button"]').click();
  await page.locator('[data-testid="add-project-host"]').click();
  const form = page.locator('[data-testid="add-remote-project"]');
  await form.locator('[data-testid="add-remote-project-folder"]').fill('/srv/api');
  await form.locator('[data-testid="add-remote-project-submit"]').click();

  await expect(form.locator('[data-testid="add-remote-project-error"]')).toContainText('no connection set up');
  await expect(form.locator('[data-testid="add-remote-project-error"]')).not.toContainText('does not exist');
});
