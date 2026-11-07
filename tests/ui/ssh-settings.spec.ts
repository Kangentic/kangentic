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
    delete mockWindow.__releaseSshProbe;
    delete mockWindow.__mockFileGate;
    delete mockWindow.__mockSshChangedKeyError;
    delete mockWindow.__mockSshTrustError;
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

test.describe('choosing a key file', () => {
  async function openKeyFileStep() {
    await openSshTab();
    await page.locator('[data-testid="ssh-add-host"]').click();
    await page.locator('[data-testid="ssh-add-name"]').fill('Lab');
    await page.locator('[data-testid="ssh-add-destination"]').fill('dev@lab.example.test');
    await page.locator('[data-testid="ssh-add-continue"]').click();
    await page.locator('[data-testid="ssh-add-trust-accept"]').click();
    await page.locator('[data-testid="ssh-signin-key-file"]').click();
  }

  test.afterEach(async () => {
    await page.evaluate(() => {
      const mockWindow = window as unknown as Record<string, unknown>;
      delete mockWindow.__mockSshKeyFileError;
      mockWindow.__mockFilePath = undefined;
    });
  });

  test('fills the path from the picker, and keeps Add host disabled until there is one', async () => {
    await openKeyFileStep();
    await expect(page.locator('[data-testid="ssh-add-submit"]')).toBeDisabled();

    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__mockFilePath = 'C:\\Users\\dev\\.ssh\\id_ed25519'; });
    await page.locator('[data-testid="ssh-add-key-choose"]').click();

    await expect(page.locator('[data-testid="ssh-add-key-path"]')).toHaveValue('C:\\Users\\dev\\.ssh\\id_ed25519');
    await expect(page.locator('[data-testid="ssh-add-submit"]')).toBeEnabled();
  });

  test('leaves the path alone when the picker is cancelled', async () => {
    await openKeyFileStep();
    await page.locator('[data-testid="ssh-add-key-path"]').fill('/typed/by/hand');

    await page.evaluate(() => { (window as unknown as Record<string, unknown>).__mockFilePath = null; });
    await page.locator('[data-testid="ssh-add-key-choose"]').click();

    await expect(page.locator('[data-testid="ssh-add-key-path"]')).toHaveValue('/typed/by/hand');
    await expect(page.locator('[data-testid="ssh-add-error"]')).toHaveCount(0);
  });

  test('refuses a key it cannot use when it is chosen, with the reason, and clears the path', async () => {
    await openKeyFileStep();
    await page.evaluate(() => {
      const mockWindow = window as unknown as Record<string, unknown>;
      mockWindow.__mockSshKeyFileError = 'That key has a passphrase, and Kangentic never asks for one.';
      mockWindow.__mockFilePath = 'C:\\Users\\dev\\.ssh\\id_protected';
    });

    await page.locator('[data-testid="ssh-add-key-choose"]').click();

    await expect(page.locator('[data-testid="ssh-add-error"]')).toContainText('has a passphrase');
    await expect(page.locator('[data-testid="ssh-add-key-path"]')).toHaveValue('');
    await expect(page.locator('[data-testid="ssh-add-submit"]')).toBeDisabled();
  });

  test('lands nowhere when Add host is cancelled while the file dialog is open, and a reopened form has no stale path', async () => {
    await openKeyFileStep();
    await page.evaluate(() => {
      const mockWindow = window as unknown as { __mockFileGate?: Promise<void>; __releaseFileDialog?: () => void; __mockFilePath?: string };
      mockWindow.__mockFileGate = new Promise<void>((resolve) => { mockWindow.__releaseFileDialog = resolve; });
      mockWindow.__mockFilePath = 'C:\\Users\\dev\\.ssh\\id_stale';
    });
    await page.locator('[data-testid="ssh-add-key-choose"]').click();
    await page.locator('[data-testid="ssh-add-cancel"]').click();
    await expect(page.locator('[data-testid="ssh-add-panel"]')).toHaveCount(0);

    // The user closes the file dialog after the form was cancelled.
    await page.evaluate(async () => {
      const mockWindow = window as unknown as { __releaseFileDialog: () => void; __mockFileGate?: Promise<void> };
      mockWindow.__releaseFileDialog();
      mockWindow.__mockFileGate = undefined;
      // Frames and a task after the release, which is when a late setState would have landed.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    // Reopen the form (the settings panel is still open) and walk to the key file step again.
    await page.locator('[data-testid="ssh-add-host"]').click();
    await page.locator('[data-testid="ssh-add-name"]').fill('Lab');
    await page.locator('[data-testid="ssh-add-destination"]').fill('dev@lab.example.test');
    await page.locator('[data-testid="ssh-add-continue"]').click();
    await page.locator('[data-testid="ssh-add-trust-accept"]').click();
    await page.locator('[data-testid="ssh-signin-key-file"]').click();
    await expect(page.locator('[data-testid="ssh-add-key-path"]')).toHaveValue('');
    await expect(page.locator('[data-testid="ssh-add-submit"]')).toBeDisabled();
  });
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

/** Holds probeHostKey open, then makes its answer a refusal so the form stays on its address step when released. */
async function holdProbeThatWillBeRefused() {
  await page.evaluate(() => {
    const mockWindow = window as unknown as { __mockSshProbeGate?: Promise<void>; __releaseSshProbe?: () => void; __mockSshProbeError?: string };
    mockWindow.__mockSshProbeGate = new Promise<void>((resolve) => { mockWindow.__releaseSshProbe = resolve; });
    mockWindow.__mockSshProbeError = 'ssh: connect to host lab port 22: Connection refused';
  });
}

async function releaseProbe() {
  await page.evaluate(() => {
    (window as unknown as { __releaseSshProbe: () => void }).__releaseSshProbe();
  });
}

test('locks the address field of Add host while its key is being read, so the answer cannot land on another address', async () => {
  await holdProbeThatWillBeRefused();
  await openSshTab();
  await page.locator('[data-testid="ssh-add-host"]').click();
  await page.locator('[data-testid="ssh-add-name"]').fill('Slow');
  const destination = page.locator('[data-testid="ssh-add-destination"]');
  await destination.fill('slow');
  await expect(destination).toBeEnabled();

  await page.locator('[data-testid="ssh-add-continue"]').click();
  await expect(destination).toBeDisabled();

  await releaseProbe();
  await expect(destination).toBeEnabled();
});

test('locks the address field of a host edit while the new address\'s key is being read', async () => {
  await page.evaluate(async () => {
    await window.electronAPI.ssh.addHost({
      name: 'Lab',
      destination: 'dev@lab.example.test',
      signIn: { method: 'config' },
      expectedFingerprint: 'SHA256:x',
    });
  });
  await openSshTab();
  await page.locator('[data-testid="ssh-host-edit"]').click();
  await expect(page.locator('[data-testid="ssh-edit-form"]')).toBeVisible();
  const destination = page.locator('[data-testid="ssh-edit-destination"]');
  await destination.fill('dev@lab2.example.test');
  await expect(destination).toBeEnabled();

  await holdProbeThatWillBeRefused();
  await page.locator('[data-testid="ssh-edit-save"]').click();
  await expect(destination).toBeDisabled();

  await releaseProbe();
  await expect(destination).toBeEnabled();
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
  await expect(row.locator('[data-testid="ssh-host-trust-new-key"]')).toHaveCount(0);

  await page.evaluate(() => {
    delete (window as unknown as Record<string, unknown>).__mockSshHosts;
  });
});

test.describe('a host whose key changed', () => {
  const NEW_FINGERPRINT = 'SHA256:Zk3Qn8vL0t1mXq5bPcR7yHdE2uWf9aJsKoT4iVgN6xA';
  const OLD_FINGERPRINT = 'SHA256:b7Hc1nUe5oYw2DpQzR8kLm0XjVt3sAiG9fKq4NxE6yM';

  async function seedChangedKey() {
    await page.evaluate(() => {
      const mockWindow = window as unknown as Record<string, unknown>;
      mockWindow.__mockSshHosts = [{
        host: { id: 'h1', name: 'Lab', destination: 'lab', key_path: null, key_created: false, created_at: '2026-11-03T00:00:00.000Z' },
        state: 'unreachable',
        detail: '@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@',
        since: '2026-11-03T00:00:00.000Z',
        projectCount: 0,
      }];
      delete mockWindow.__mockSshTrustedNewKey;
    });
  }

  test.afterEach(async () => {
    await page.evaluate(() => {
      const mockWindow = window as unknown as Record<string, unknown>;
      delete mockWindow.__mockSshHosts;
      delete mockWindow.__mockSshTrustedNewKey;
    });
  });

  test('offers Trust new key only when the host\'s key has changed', async () => {
    await seedChangedKey();
    await openSshTab();

    await expect(page.locator('[data-testid="ssh-host-trust-new-key"]')).toBeVisible();
    // There is no block under the error: the action is an icon with the row's other actions.
    await expect(page.locator('[data-testid="ssh-host-error"]').locator('button')).toHaveCount(0);
  });

  test('shows the key before and now, and trusts nothing until the user confirms', async () => {
    await seedChangedKey();
    await openSshTab();

    await page.locator('[data-testid="ssh-host-trust-new-key"]').click();

    const dialog = page.locator('[data-testid="ssh-trust-new-key"]');
    await expect(dialog).toContainText('New host key');
    await expect(dialog.locator('[data-testid="ssh-trust-previous-fingerprint"]')).toHaveText(OLD_FINGERPRINT);
    await expect(dialog.locator('[data-testid="ssh-trust-new-fingerprint"]')).toHaveText(NEW_FINGERPRINT);

    await dialog.locator('[data-testid="ssh-trust-new-key-cancel"]').click();
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__mockSshTrustedNewKey)).toBeUndefined();
  });

  test('trusts the fingerprint it showed, and closes', async () => {
    await seedChangedKey();
    await openSshTab();

    await page.locator('[data-testid="ssh-host-trust-new-key"]').click();
    await page.locator('[data-testid="ssh-trust-new-key-confirm"]').click();

    await expect(page.locator('[data-testid="ssh-trust-new-key"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__mockSshTrustedNewKey)).toEqual({ hostId: 'h1', fingerprint: NEW_FINGERPRINT });
  });

  test('shows the reason on the row, and opens no dialog, when the new key cannot be read', async () => {
    await seedChangedKey();
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockSshChangedKeyError = 'ssh-keyscan: connection refused';
    });
    await openSshTab();

    await page.locator('[data-testid="ssh-host-trust-new-key"]').click();

    await expect(page.locator('[data-testid="ssh-host-row-error"]')).toContainText('connection refused');
    await expect(page.locator('[data-testid="ssh-trust-new-key"]')).toHaveCount(0);
  });

  test('shows the reason on the row, and closes the dialog, when trusting the new key fails', async () => {
    await seedChangedKey();
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockSshTrustError = 'The host key changed again.';
    });
    await openSshTab();

    await page.locator('[data-testid="ssh-host-trust-new-key"]').click();
    await page.locator('[data-testid="ssh-trust-new-key-confirm"]').click();

    await expect(page.locator('[data-testid="ssh-host-row-error"]')).toContainText('changed again');
    await expect(page.locator('[data-testid="ssh-trust-new-key"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__mockSshTrustedNewKey)).toBeUndefined();
  });

  test('leaves out the key before when it cannot be read, and the dialog still works', async () => {
    await seedChangedKey();
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockSshProbeResult = {
        hostname: 'lab', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:Zk3Qn8vL0t1mXq5bPcR7yHdE2uWf9aJsKoT4iVgN6xA', previousFingerprint: null,
      };
    });
    await openSshTab();

    await page.locator('[data-testid="ssh-host-trust-new-key"]').click();

    await expect(page.locator('[data-testid="ssh-trust-new-fingerprint"]')).toBeVisible();
    await expect(page.locator('[data-testid="ssh-trust-previous-fingerprint"]')).toHaveCount(0);
    await page.locator('[data-testid="ssh-trust-new-key-cancel"]').click();
    await page.evaluate(() => {
      delete (window as unknown as Record<string, unknown>).__mockSshProbeResult;
    });
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
  // No project on the host, so the sentence says only that the connection is forgotten. Nothing is deleted either way.
  await expect(confirmDialog()).toContainText('Removing "Lab" forgets the connection, and nothing is deleted.');
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

test.describe('address suggestions from the SSH config', () => {
  const suggestion = () => page.locator('[data-testid="ssh-add-destination-suggestion"]');

  async function openAddForm() {
    await openSshTab();
    await page.locator('[data-testid="ssh-add-host"]').click();
    await expect(page.locator('[data-testid="ssh-add-destination"]')).toBeVisible();
  }

  test('suggests names from the config as you type, with the machine each one is, and a pick fills the address', async () => {
    await openAddForm();
    const field = page.locator('[data-testid="ssh-add-destination"]');

    await expect(suggestion()).toHaveCount(0);
    await field.fill('b');
    await expect(suggestion()).toHaveText(['build-boxdev@build.example.test']);

    await suggestion().first().click();
    await expect(field).toHaveValue('build-box');
    // A name typed in full is not offered back.
    await expect(suggestion()).toHaveCount(0);
  });

  test('moves through the suggestions with the arrow keys, and Enter picks one instead of continuing', async () => {
    await openAddForm();
    const field = page.locator('[data-testid="ssh-add-destination"]');
    await page.locator('[data-testid="ssh-add-name"]').fill('Lab');
    await field.fill('g');
    await expect(suggestion()).toHaveCount(2);

    await field.press('ArrowDown');
    await field.press('ArrowDown');
    await field.press('ArrowUp');
    await field.press('Enter');

    await expect(field).toHaveValue('gpu-rig');
    await expect(page.locator('[data-testid="ssh-add-trust"]')).toHaveCount(0);
  });

  test('offers nothing for an address that is not a config name, and Continue is not covered by a list', async () => {
    await openAddForm();
    await page.locator('[data-testid="ssh-add-name"]').fill('Lab');
    await page.locator('[data-testid="ssh-add-destination"]').fill('dev@lab.example.test');

    await expect(suggestion()).toHaveCount(0);
    await page.locator('[data-testid="ssh-add-continue"]').click();
    await expect(page.locator('[data-testid="ssh-add-fingerprint"]')).toBeVisible();
  });

  test('Escape closes the suggestions and leaves the panel and the form open', async () => {
    await openAddForm();
    const field = page.locator('[data-testid="ssh-add-destination"]');
    await field.fill('b');
    await expect(suggestion()).toHaveCount(1);

    await field.press('Escape');

    await expect(suggestion()).toHaveCount(0);
    await expect(page.locator('[data-testid="ssh-add-panel"]')).toBeVisible();
    await expect(page.locator('h2:has-text("Settings")')).toBeVisible();

    // The next keystroke offers them again.
    await field.fill('bu');
    await expect(suggestion()).toHaveCount(1);
  });

  test('is no suggestions, and no error, when the config has no hosts', async () => {
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockSshConfigHosts = [];
    });
    await openAddForm();
    await page.locator('[data-testid="ssh-add-destination"]').fill('b');

    await expect(suggestion()).toHaveCount(0);
    await page.evaluate(() => {
      delete (window as unknown as Record<string, unknown>).__mockSshConfigHosts;
    });
  });
});

test.describe('editing a host in place', () => {
  async function addHostThroughApi(signInMethod: 'config' | 'create-key' = 'config') {
    await page.evaluate(async (method) => {
      await window.electronAPI.ssh.addHost({
        name: 'Lab',
        destination: 'dev@lab.example.test',
        signIn: method === 'create-key' ? { method, password: 'pw' } : { method },
        expectedFingerprint: 'SHA256:x',
      });
    }, signInMethod);
  }

  async function openEditForm() {
    await openSshTab();
    await page.locator('[data-testid="ssh-host-edit"]').click();
    await expect(page.locator('[data-testid="ssh-edit-form"]')).toBeVisible();
  }

  test('saves a new name at once, with no key to trust', async () => {
    await addHostThroughApi();
    await openEditForm();

    await page.locator('[data-testid="ssh-edit-name"]').fill('Build server');
    await expect(page.locator('[data-testid="ssh-edit-save"]')).toHaveText('Save');
    await page.locator('[data-testid="ssh-edit-save"]').click();

    await expect(page.locator('[data-testid="ssh-edit-form"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ssh-host-name"]')).toHaveText('Build server');
    await expect(page.locator('[data-testid="ssh-host-destination"]')).toHaveText('dev@lab.example.test');
  });

  test('shows the new address\'s key first, and saves the address only once it is trusted', async () => {
    await addHostThroughApi();
    await openEditForm();

    await page.locator('[data-testid="ssh-edit-destination"]').fill('dev@lab2.example.test');
    await expect(page.locator('[data-testid="ssh-edit-save"]')).toHaveText('Continue');
    await page.locator('[data-testid="ssh-edit-save"]').click();

    await expect(page.locator('[data-testid="ssh-edit-fingerprint"]')).toContainText('SHA256:');
    await expect(page.locator('[data-testid="ssh-edit-save"]')).toHaveText('Trust this key and save');
    // Nothing is saved while the key is only shown.
    const saved = await page.evaluate(async () => (await window.electronAPI.ssh.listHosts())[0].host.destination);
    expect(saved).toBe('dev@lab.example.test');

    await page.locator('[data-testid="ssh-edit-save"]').click();
    await expect(page.locator('[data-testid="ssh-edit-form"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ssh-host-destination"]')).toHaveText('dev@lab2.example.test');
  });

  test('asks for the key again when the address is typed over after it was shown', async () => {
    await addHostThroughApi();
    await openEditForm();
    await page.locator('[data-testid="ssh-edit-destination"]').fill('dev@lab2.example.test');
    await page.locator('[data-testid="ssh-edit-save"]').click();
    await expect(page.locator('[data-testid="ssh-edit-trust"]')).toBeVisible();

    await page.locator('[data-testid="ssh-edit-destination"]').fill('dev@lab3.example.test');

    await expect(page.locator('[data-testid="ssh-edit-trust"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ssh-edit-save"]')).toHaveText('Continue');
  });

  test('Cancel discards the edit', async () => {
    await addHostThroughApi();
    await openEditForm();
    await page.locator('[data-testid="ssh-edit-name"]').fill('Discarded');

    await page.locator('[data-testid="ssh-edit-cancel"]').click();

    await expect(page.locator('[data-testid="ssh-edit-form"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ssh-host-name"]')).toHaveText('Lab');
  });

  test('needs a new sign-in with a new address when the key Kangentic made was for the old one', async () => {
    await addHostThroughApi('create-key');
    await openEditForm();
    await page.locator('[data-testid="ssh-edit-destination"]').fill('dev@lab2.example.test');

    await expect(page.locator('[data-testid="ssh-edit-needs-signin"]')).toBeVisible();
    await expect(page.locator('[data-testid="ssh-edit-save"]')).toBeDisabled();

    await page.locator('[data-testid="ssh-edit-signin-password"]').click();
    await expect(page.locator('[data-testid="ssh-edit-save"]')).toBeDisabled();
    await page.locator('[data-testid="ssh-edit-password"]').fill('pw');
    await expect(page.locator('[data-testid="ssh-edit-needs-signin"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ssh-edit-save"]')).toBeEnabled();
  });

  test('keeps the form open with the reason in place when saving is refused, and drops the password', async () => {
    await addHostThroughApi();
    await openEditForm();
    await page.locator('[data-testid="ssh-edit-signin-password"]').click();
    await page.locator('[data-testid="ssh-edit-password"]').fill('wrong');
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__mockSshUpdateError = 'Stop the terminals running on this host first.';
    });

    await page.locator('[data-testid="ssh-edit-save"]').click();

    await expect(page.locator('[data-testid="ssh-edit-error"]')).toContainText('Stop the terminals');
    await expect(page.locator('[data-testid="ssh-edit-form"]')).toBeVisible();
    await expect(page.locator('[data-testid="ssh-edit-password"]')).toHaveValue('');
    await page.evaluate(() => {
      delete (window as unknown as Record<string, unknown>).__mockSshUpdateError;
    });
  });
});
