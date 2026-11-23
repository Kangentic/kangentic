import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

/**
 * What is lost if this goes: on a CPU the OS keeps throttling, Electron emits
 * `powerMonitor.speed-limit-change` every 1 to 2 s. On DESKTOP-46's 0.62.0 event
 * about 100 of them filled main's 100-slot breadcrumb ring and evicted every
 * other crumb from the five minutes before the failure. error-reporting.ts swaps
 * the SDK's Electron breadcrumbs integration for one whose `powerMonitor` option
 * skips that event (keepPowerMonitorBreadcrumb, src/shared/sentry-breadcrumbs.ts).
 *
 * This runs the real thing end to end: the `integrations` callback main passes to
 * `Sentry.init`, the installed SDK's integration it builds, and a real client's
 * breadcrumb ring with main's `beforeBreadcrumb`. Only Electron is a fake, so the
 * test can emit power events. `@sentry/electron/main` cannot load outside Electron
 * and vitest aliases it to a stub, so the integration is required from the CJS
 * build that package resolves, with a fake `electron` seeded into the require
 * cache first (the same approach as foreign-crash-real-client.test.ts).
 */

interface RealIntegration {
  name: string;
  setup(client: unknown): void;
}

interface RealClient {
  close(timeoutMs: number): Promise<boolean>;
}

interface BreadcrumbRecord {
  category?: string;
  message?: string;
}

interface ScopeLike {
  setClient(client: unknown): void;
  clearBreadcrumbs(): void;
  getScopeData(): { breadcrumbs: BreadcrumbRecord[] };
}

const requireFromTest = createRequire(import.meta.url);
const electronMainEntry = requireFromTest.resolve('@sentry/electron/main');
const requireFromSentryElectron = createRequire(electronMainEntry);

/** A powerMonitor the test can emit on. Kept so its `emit` can be restored after the integration patches it. */
const powerMonitor = new EventEmitter();
const originalPowerMonitorEmit = powerMonitor.emit;

function seedFakeElectron(): void {
  const app = Object.assign(new EventEmitter(), {
    whenReady: () => Promise.resolve(),
    getAppPath: () => '/opt/Kangentic/resources/app.asar',
  });
  const electron = { app, powerMonitor, screen: new EventEmitter(), autoUpdater: new EventEmitter() };
  const electronPath = requireFromSentryElectron.resolve('electron');
  const cache = requireFromSentryElectron.cache;
  cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: electron,
  } as unknown as NodeJS.Module;
}

seedFakeElectron();

const breadcrumbsModulePath = requireFromSentryElectron.resolve('./integrations/electron-breadcrumbs.js');
const realBreadcrumbsModule = requireFromSentryElectron(breadcrumbsModulePath) as {
  electronBreadcrumbsIntegration: (options?: Record<string, unknown>) => RealIntegration;
};
const sentryNode = requireFromSentryElectron('@sentry/node') as {
  NodeClient: new (options: Record<string, unknown>) => RealClient;
  defaultStackParser: unknown;
};
const sentryCore = requireFromSentryElectron('@sentry/core') as {
  createTransport(options: unknown, makeRequest: () => Promise<{ statusCode: number }>): unknown;
  getCurrentScope(): ScopeLike;
  getIsolationScope(): ScopeLike;
};

const sentryInit = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/home/dev/.config/kangentic', getVersion: () => '0.0.0' },
}));

// Main's module under test reaches the SDK through this mock. Its integration
// factory is the installed SDK's real one, required above.
vi.mock('@sentry/electron/main', () => ({
  init: sentryInit,
  addBreadcrumb: vi.fn(),
  electronBreadcrumbsIntegration: (options?: Record<string, unknown>) =>
    realBreadcrumbsModule.electronBreadcrumbsIntegration(options),
}));

interface InitOptions {
  integrations: (defaultIntegrations: Array<{ name: string }>) => Array<{ name: string }>;
  beforeBreadcrumb: (breadcrumb: BreadcrumbRecord) => BreadcrumbRecord | null;
}

const openClients: RealClient[] = [];

beforeEach(() => {
  sentryInit.mockReset();
  vi.stubEnv('KANGENTIC_TELEMETRY', undefined);
  vi.stubEnv('KANGENTIC_ERROR_REPORTING', undefined);
  sentryCore.getIsolationScope().clearBreadcrumbs();
});

// Node's CJS cache belongs to the process, not to vitest's module registry, so the
// fake and the modules loaded against it are removed rather than left for a later file.
afterAll(() => {
  const cache = requireFromSentryElectron.cache;
  delete cache[requireFromSentryElectron.resolve('electron')];
  delete cache[breadcrumbsModulePath];
  delete cache[requireFromSentryElectron.resolve('./renderers.js')];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  powerMonitor.emit = originalPowerMonitorEmit;
  sentryCore.getCurrentScope().setClient(undefined);
  sentryCore.getIsolationScope().clearBreadcrumbs();
  await Promise.all(openClients.splice(0).map((client) => client.close(2000)));
});

async function mainInitOptions(): Promise<InitOptions> {
  vi.resetModules();
  const { initErrorReporting } = await import('../../src/main/analytics/error-reporting');
  initErrorReporting();
  expect(sentryInit).toHaveBeenCalledTimes(1);
  return sentryInit.mock.calls[0][0] as InitOptions;
}

/** Sets an integration up on a real client with main's `beforeBreadcrumb`, then waits for its `whenReady` patch. */
async function setUpOnRealClient(integration: RealIntegration, beforeBreadcrumb: InitOptions['beforeBreadcrumb']): Promise<void> {
  const client = new sentryNode.NodeClient({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    integrations: [],
    stackParser: sentryNode.defaultStackParser,
    beforeBreadcrumb,
    transport: (transportOptions: unknown) =>
      sentryCore.createTransport(transportOptions, async () => ({ statusCode: 200 })),
  });
  openClients.push(client);
  sentryCore.getCurrentScope().setClient(client);
  integration.setup(client);
  // The powerMonitor patch runs in `app.whenReady().then(...)`.
  await new Promise((resolve) => setImmediate(resolve));
}

function ringMessages(): Array<string | undefined> {
  return sentryCore.getIsolationScope().getScopeData().breadcrumbs.map((breadcrumb) => breadcrumb.message);
}

/** A suspend, then a throttled machine's run of speed-limit changes, then the rest of the power events. */
function emitThrottledRun(): void {
  powerMonitor.emit('suspend');
  for (let changeIndex = 0; changeIndex < 150; changeIndex++) {
    powerMonitor.emit('speed-limit-change', { limit: 60 });
  }
  powerMonitor.emit('resume');
  powerMonitor.emit('lock-screen');
  powerMonitor.emit('unlock-screen');
}

describe('powerMonitor breadcrumbs through the real Electron breadcrumbs integration', () => {
  it('keeps a run of speed-limit-change out of the ring, and every other power event in it', async () => {
    const options = await mainInitOptions();
    const integrations = options.integrations([
      { name: 'MainProcessSession' },
      { name: 'ElectronBreadcrumbs' },
      { name: 'Console' },
    ]);
    const breadcrumbIntegrations = integrations.filter((integration) => integration.name === 'ElectronBreadcrumbs');
    expect(breadcrumbIntegrations).toHaveLength(1);

    await setUpOnRealClient(breadcrumbIntegrations[0] as RealIntegration, options.beforeBreadcrumb);
    emitThrottledRun();

    expect(ringMessages()).toEqual([
      'powerMonitor.suspend',
      'powerMonitor.resume',
      'powerMonitor.lock-screen',
      'powerMonitor.unlock-screen',
    ]);
  });

  // The control: the SDK's default integration on the same fake and the same
  // ring records the run and evicts the suspend, which is DESKTOP-46's trail. If
  // this stops failing that way, the fake no longer reaches the SDK's gate and
  // the case above proves nothing.
  it('fills the ring and evicts the suspend with the SDK default, on the same fake', async () => {
    const options = await mainInitOptions();
    await setUpOnRealClient(realBreadcrumbsModule.electronBreadcrumbsIntegration(), options.beforeBreadcrumb);
    emitThrottledRun();

    const messages = ringMessages();
    expect(messages).toHaveLength(100);
    expect(messages).not.toContain('powerMonitor.suspend');
    expect(messages.filter((message) => message === 'powerMonitor.speed-limit-change')).toHaveLength(97);
  });
});
