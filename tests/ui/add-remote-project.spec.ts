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
    for (const status of await api.listHosts()) await api.removeHost(status.host.id);
    delete (window as unknown as Record<string, unknown>).__mockSshFolders;
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
  await expect(confirmDialog).toContainText('1 project');
  await confirmDialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(0);

  // The removed project was the open one and the panel was editing it. With no project left the
  // panel lists only the system tabs, as it does for a window with none open, rather than keeping
  // the project tabs over a removed project's overrides while the app paints the global config.
  await expect(page.locator('[data-testid="settings-tab-ssh"]')).toBeVisible();
  await expect(page.locator('[data-testid="settings-tab-theme"]')).toHaveCount(0);

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
