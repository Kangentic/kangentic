/**
 * UI tests for the SSH settings tab (#913).
 *
 * What only a browser proves here: the Add host flow's steps run inline in the card in order (details,
 * the fingerprint the user must trust, how to sign in), a failed probe or add shows the system's words
 * in place and keeps the form, a host row shows its live state and counts, and Remove asks first. The
 * main process is the mock bridge, so the host key and the connection are stand-ins; the real flows are
 * covered by the unit tier (`ssh-host-admin.test.ts`, `ssh-setup.test.ts`).
 *
 * What a user loses if it breaks: a host added without ever seeing its fingerprint, a password field
 * that survives a failed attempt, or a host removed with one click.
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
  await createProject(page, `SSH Test ${Date.now()}`);
});

test.afterAll(async () => {
  await browser?.close();
});

async function openSshTab() {
  await page.locator('[data-testid="settings-button"]').click();
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'visible', timeout: 3000 });
  await page.locator('[data-testid="settings-tab-ssh"]').click();
  await expect(page.locator('[data-testid="ssh-hosts-card"]')).toBeVisible();
}

async function closeSettings() {
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.locator('h2:has-text("Settings")').waitFor({ state: 'hidden', timeout: 2000 });
}

async function resetMock() {
  await page.evaluate(async () => {
    const api = window.electronAPI.ssh;
    for (const status of await api.listHosts()) await api.removeHost(status.host.id);
    const mockWindow = window as unknown as Record<string, unknown>;
    delete mockWindow.__mockSshProbeError;
    delete mockWindow.__mockSshAddError;
    delete mockWindow.__mockSshProbeGate;
  });
}

test.beforeEach(async () => {
  await resetMock();
});

test.afterEach(async () => {
  await closeSettings();
});

test('shows an empty list and the ssh client it found', async () => {
  await openSshTab();

  await expect(page.locator('[data-testid="ssh-no-hosts"]')).toBeVisible();
  await expect(page.locator('[data-testid="ssh-add-host"]')).toBeVisible();
  await expect(page.locator('[data-testid="ssh-client-status-label"]')).toHaveText('ssh found');
  await expect(page.locator('[data-testid="ssh-client-status-text"]')).toContainText('OpenSSH');
});

test('says the list could not be read, and not that there are no hosts, when listing fails', async () => {
  // Its own page: the failure has to be the very first answer, or an earlier list would already have
  // told the store there are no hosts.
  const failing = await launchPage({
    beforeLoad: async (failingPage) => {
      await failingPage.addInitScript(() => {
        (window as unknown as Record<string, unknown>).__mockSshListError = 'The list of hosts could not be read.';
      });
    },
  });
  try {
    await failing.page.locator('[data-testid="settings-button"]').click();
    await failing.page.locator('[data-testid="settings-tab-ssh"]').click();
    await expect(failing.page.locator('[data-testid="ssh-hosts-card"]')).toBeVisible();

    await expect(failing.page.locator('[data-testid="ssh-hosts-load-error"]')).toContainText('could not be read');
    await expect(failing.page.locator('[data-testid="ssh-no-hosts"]')).toHaveCount(0);
  } finally {
    await failing.browser.close();
  }
});

test('adds a host through the fingerprint step and shows it connected', async () => {
  await openSshTab();
  await page.locator('[data-testid="ssh-add-host"]').click();
  await page.locator('[data-testid="ssh-add-name"]').fill('Build server');
  await page.locator('[data-testid="ssh-add-destination"]').fill('dev@build.example.test');
  await page.locator('[data-testid="ssh-add-continue"]').click();

  // The user sees the key before anything is trusted or added.
  await expect(page.locator('[data-testid="ssh-add-fingerprint"]')).toContainText('SHA256:');
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(0);

  await page.locator('[data-testid="ssh-add-trust-accept"]').click();
  await expect(page.locator('[data-testid="ssh-add-signin"]')).toBeVisible();
  await page.locator('[data-testid="ssh-add-submit"]').click();

  const row = page.locator('[data-testid="ssh-host-row"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-testid="ssh-host-name"]')).toHaveText('Build server');
  await expect(row.locator('[data-testid="ssh-host-destination"]')).toHaveText('dev@build.example.test');
  await expect(row.locator('[data-testid="ssh-host-connection"]')).toHaveText('Connected');
  await expect(row.locator('[data-testid="ssh-host-project-count"]')).toHaveText('0 projects');
  // The panel closes once the host is added.
  await expect(page.locator('[data-testid="ssh-add-panel"]')).toHaveCount(0);
});

test('keeps the form and shows the reason when the host cannot be reached', async () => {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockSshProbeError = 'ssh: connect to host lab port 22: Connection timed out';
  });
  await openSshTab();
  await page.locator('[data-testid="ssh-add-host"]').click();
  await page.locator('[data-testid="ssh-add-name"]').fill('Lab');
  await page.locator('[data-testid="ssh-add-destination"]').fill('lab');
  await page.locator('[data-testid="ssh-add-continue"]').click();

  await expect(page.locator('[data-testid="ssh-add-error"]')).toContainText('Connection timed out');
  await expect(page.locator('[data-testid="ssh-add-name"]')).toHaveValue('Lab');
  await expect(page.locator('[data-testid="ssh-add-trust"]')).toHaveCount(0);
});

test('stays closed when Cancel is pressed while the host key is still being read', async () => {
  await page.evaluate(() => {
    const mockWindow = window as unknown as { __mockSshProbeGate?: Promise<void>; __releaseSshProbe?: () => void };
    mockWindow.__mockSshProbeGate = new Promise<void>((resolve) => { mockWindow.__releaseSshProbe = resolve; });
  });
  await openSshTab();
  await page.locator('[data-testid="ssh-add-host"]').click();
  await page.locator('[data-testid="ssh-add-name"]').fill('Slow');
  await page.locator('[data-testid="ssh-add-destination"]').fill('slow');
  await page.locator('[data-testid="ssh-add-continue"]').click();
  await page.locator('[data-testid="ssh-add-cancel"]').click();
  await expect(page.locator('[data-testid="ssh-add-panel"]')).toHaveCount(0);

  // The probe answers after the form was closed: the answer must land nowhere.
  await page.evaluate(async () => {
    (window as unknown as { __releaseSshProbe: () => void }).__releaseSshProbe();
    // Two frames after the release, which is when a late setState would have repainted the form.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  await expect(page.locator('[data-testid="ssh-add-panel"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ssh-add-trust"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ssh-add-host"]')).toBeVisible();
});

test('clears the password after a refused add, and keeps the rest of the form', async () => {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockSshAddError = 'Permission denied (password).';
  });
  await openSshTab();
  await page.locator('[data-testid="ssh-add-host"]').click();
  await page.locator('[data-testid="ssh-add-name"]').fill('Lab');
  await page.locator('[data-testid="ssh-add-destination"]').fill('lab');
  await page.locator('[data-testid="ssh-add-continue"]').click();
  await page.locator('[data-testid="ssh-add-trust-accept"]').click();
  await page.locator('[data-testid="ssh-signin-password"]').click();
  await page.locator('[data-testid="ssh-add-password"]').fill('wrong');
  await page.locator('[data-testid="ssh-add-submit"]').click();

  await expect(page.locator('[data-testid="ssh-add-error"]')).toContainText('Permission denied (password).');
  await expect(page.locator('[data-testid="ssh-add-password"]')).toHaveValue('');
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(0);
});

test('shows an unreachable host with ssh\'s words, and reconnecting clears it', async () => {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockSshHosts = [{
      host: { id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '2026-11-03T00:00:00.000Z' },
      state: 'unreachable',
      detail: 'ssh: connect to host lab port 22: Connection timed out',
      since: '2026-11-03T00:00:00.000Z',
      projectCount: 2,
    }];
  });
  await openSshTab();

  const row = page.locator('[data-testid="ssh-host-row"]');
  await expect(row.locator('[data-testid="ssh-host-connection"]')).toHaveText('Unreachable');
  await expect(row.locator('[data-testid="ssh-host-error"]')).toContainText('Connection timed out');
  await expect(row.locator('[data-testid="ssh-host-project-count"]')).toHaveText('2 projects');
  await expect(row.locator('[data-testid="ssh-host-reconnect"]')).toBeVisible();
  await expect(row.locator('[data-testid="ssh-host-forget-key"]')).toHaveCount(0);

  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__mockSshHosts;
  });
});

test('offers Forget old key only when the host\'s key has changed', async () => {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockSshHosts = [{
      host: { id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '2026-11-03T00:00:00.000Z' },
      state: 'unreachable',
      detail: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
      since: '2026-11-03T00:00:00.000Z',
      projectCount: 0,
    }];
  });
  await openSshTab();

  await expect(page.locator('[data-testid="ssh-host-forget-key"]')).toBeVisible();

  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__mockSshHosts;
  });
});

test('asks before removing a host, and removing takes the row away', async () => {
  await page.evaluate(async () => {
    await window.electronAPI.ssh.addHost({
      name: 'Lab',
      destination: 'lab',
      signIn: { method: 'config' },
      expectedFingerprint: 'SHA256:x',
    });
  });
  await openSshTab();
  const row = page.locator('[data-testid="ssh-host-row"]');
  await expect(row).toHaveCount(1);

  const confirmDialog = () => page.locator('h3:has-text("Remove host")').locator('xpath=ancestor::*[contains(@class, "z-[60]")][1]');

  await row.locator('[data-testid="ssh-host-remove"]').click();
  await expect(confirmDialog()).toContainText('Remove "Lab"?');
  await confirmDialog().getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmDialog()).toHaveCount(0);
  await expect(row).toHaveCount(1);

  await row.locator('[data-testid="ssh-host-remove"]').click();
  await confirmDialog().getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(row).toHaveCount(0);
});

test('shows the program version and its terminal count on a connected host, and says when it is older than the app', async () => {
  await page.evaluate(async () => {
    await window.electronAPI.ssh.addHost({
      name: 'Build',
      destination: 'build',
      signIn: { method: 'config' },
      expectedFingerprint: 'SHA256:x',
    });
  });
  await openSshTab();
  const row = page.locator('[data-testid="ssh-host-row"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-testid="ssh-host-program-version"]')).toHaveText('Program 0.53.0');
  await expect(row.locator('[data-testid="ssh-host-program-sessions"]')).toHaveText('2 terminals running');
  await closeSettings();

  // A daemon that outlived an app update keeps running its own version, and one terminal reads singular.
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__mockSshHostProgram = {
      version: '0.52.0',
      appVersion: '0.53.0',
      startedAt: new Date().toISOString(),
      liveSessions: 1,
      installedVersions: ['0.52.0', '0.53.0'],
    };
  });
  await openSshTab();
  await expect(row.locator('[data-testid="ssh-host-program-version"]')).toHaveText('Program 0.52.0 (this app is 0.53.0)');
  await expect(row.locator('[data-testid="ssh-host-program-sessions"]')).toHaveText('1 terminal running');
  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__mockSshHostProgram;
  });
});

test('shows no program line for a host that is not connected', async () => {
  await page.evaluate(async () => {
    (window as unknown as Record<string, unknown>).__mockSshHosts = [{
      host: { id: 'h-down', name: 'Down', destination: 'down', key_path: null, key_created: false, created_at: new Date().toISOString() },
      state: 'unreachable',
      detail: 'ssh: connect to host down port 22: Connection timed out',
      since: new Date().toISOString(),
      projectCount: 0,
    }];
  });
  await openSshTab();
  await expect(page.locator('[data-testid="ssh-host-row"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="ssh-host-program"]')).toHaveCount(0);
  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__mockSshHosts;
  });
});
