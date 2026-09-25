import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ErrorEvent, EventHint } from '@sentry/electron/main';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A foreign process's minidump holds that program's memory, so it must never
 * upload. filterNativeCrashEvent keeps it off by removing it from
 * `hint.attachments` inside `beforeSend`, which works only because the SDK
 * builds the envelope from that same hint AFTER `beforeSend` returns. That is an
 * SDK internal, so this suite proves it against the real client rather than a
 * stub: it runs our real `beforeSendEvent` inside the `NodeClient` that
 * `@sentry/electron/main` itself constructs, replays the exact capture call the
 * SDK's minidump integration makes, and reads the envelope the client builds.
 *
 * `@sentry/electron/main` cannot load outside Electron (it reads `electron.app`
 * at import), and vitest.config.ts aliases it to a stub anyway. So the client
 * classes are required from the copy of `@sentry/node` and `@sentry/core` that
 * `@sentry/electron` resolves, which is the copy the app bundles. The source
 * guard at the bottom fails if the SDK stops using that client or that call, so
 * this replay cannot quietly drift from what ships.
 */

const hostInstall = vi.hoisted(() => {
  // Native to the HOST: resolveNativeCrashContext derives the install root with
  // node:path, so a Windows path on CI's Linux runner would make every module
  // foreign and the control below meaningless.
  const executablePath =
    process.platform === 'win32'
      ? 'C:\\Users\\dev\\AppData\\Local\\Programs\\Kangentic\\Kangentic.exe'
      : process.platform === 'darwin'
        ? '/Applications/Kangentic.app/Contents/MacOS/Kangentic'
        : '/opt/Kangentic/kangentic';
  return { executablePath };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string) => (name === 'exe' ? hostInstall.executablePath : '/home/dev/.config/kangentic'),
    getVersion: () => '0.39.0',
  },
}));

import { beforeSendEvent } from '../../src/main/analytics/error-reporting';
import {
  buildMinidump,
  FFPROBE_MODULES,
  LINUX_APP_MODULES,
  MACOS_APP_MODULES,
  WINDOWS_APP_MODULES,
} from '../fixtures/minidump-fixture';

const OUR_APP_MODULES =
  process.platform === 'win32'
    ? WINDOWS_APP_MODULES
    : process.platform === 'darwin'
      ? MACOS_APP_MODULES
      : LINUX_APP_MODULES;

type EnvelopeItem = [Record<string, unknown>, unknown];
type Envelope = [Record<string, unknown>, EnvelopeItem[]];

interface TransportRequest {
  body: string | Uint8Array;
}

interface RealClient {
  on(hook: 'beforeEnvelope', callback: (envelope: Envelope) => void): void;
  captureEvent(event: ErrorEvent, hint: EventHint): string;
  flush(timeoutMs: number): Promise<boolean>;
  close(timeoutMs: number): Promise<boolean>;
}

interface SentryNodeModule {
  NodeClient: new (options: Record<string, unknown>) => RealClient;
  defaultStackParser: unknown;
}

interface SentryCoreModule {
  createTransport(
    options: unknown,
    makeRequest: (request: TransportRequest) => Promise<{ statusCode: number }>
  ): unknown;
}

const requireFromTest = createRequire(import.meta.url);
const electronMainEntry = requireFromTest.resolve('@sentry/electron/main');
const requireFromSentryElectron = createRequire(electronMainEntry);
const sentryNode = requireFromSentryElectron('@sentry/node') as SentryNodeModule;
const sentryCore = requireFromSentryElectron('@sentry/core') as SentryCoreModule;

const openClients: RealClient[] = [];

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close(2000)));
});

/** What `@sentry/electron`'s minidump integration builds for a dump found at startup. */
function startupFoundMinidumpEvent(): ErrorEvent {
  return {
    level: 'fatal',
    platform: 'native',
    release: 'Kangentic@0.39.0',
    tags: { 'event.environment': 'native', 'event.process': 'unknown' },
    contexts: { electron: { 'crashpad.prod': 'SomeoneElse' } },
  } as ErrorEvent;
}

/**
 * Captures one event through a real client wired with our `beforeSend`, the
 * way the integration does (`captureEvent(event, { attachments: [attachment] })`),
 * plus a second, unrelated attachment of the kind a renderer's scope carries.
 * Returns the one envelope the client built.
 */
async function captureThroughRealClient(modules: string[]): Promise<Envelope> {
  const envelopes: Envelope[] = [];
  const client = new sentryNode.NodeClient({
    dsn: 'https://public@o0.ingest.sentry.io/0',
    integrations: [],
    stackParser: sentryNode.defaultStackParser,
    beforeSend: beforeSendEvent,
    transport: (transportOptions: unknown) =>
      sentryCore.createTransport(transportOptions, async () => ({ statusCode: 200 })),
  });
  openClients.push(client);
  client.on('beforeEnvelope', (envelope) => envelopes.push(envelope));

  client.captureEvent(startupFoundMinidumpEvent(), {
    attachments: [
      { attachmentType: 'event.minidump', filename: 'crash.dmp', data: buildMinidump({ modules }) },
      { filename: 'renderer-log.txt', data: new Uint8Array([1, 2, 3]) },
    ],
  });
  await client.flush(2000);

  expect(envelopes).toHaveLength(1);
  return envelopes[0];
}

function itemsOfType(envelope: Envelope, type: string): EnvelopeItem[] {
  return envelope[1].filter(([itemHeaders]) => itemHeaders.type === type);
}

function minidumpItems(envelope: Envelope): EnvelopeItem[] {
  return itemsOfType(envelope, 'attachment').filter(
    ([itemHeaders]) => itemHeaders.attachment_type === 'event.minidump'
  );
}

describe('a foreign minidump through the real Sentry client', () => {
  it('sends one grouped warning and no dump', async () => {
    const envelope = await captureThroughRealClient(FFPROBE_MODULES);

    const events = itemsOfType(envelope, 'event');
    expect(events).toHaveLength(1);
    expect(events[0][1]).toMatchObject({
      level: 'warning',
      message: "Foreign process crash reached Kangentic's crash database",
      fingerprint: ['foreign-process-crash'],
      tags: { module: 'ffprobe' },
    });
    expect(minidumpItems(envelope)).toHaveLength(0);
    // Only the dump goes: the unrelated attachment still rides along.
    expect(itemsOfType(envelope, 'attachment').map(([itemHeaders]) => itemHeaders.filename)).toEqual([
      'renderer-log.txt',
    ]);
  });

  it('still uploads the dump of a crash that is ours', async () => {
    const envelope = await captureThroughRealClient(OUR_APP_MODULES);

    const events = itemsOfType(envelope, 'event');
    expect(events).toHaveLength(1);
    // native_crash is added only by the ownership check, so a beforeSend that
    // failed open (which also keeps the dump) cannot pass this control.
    expect(events[0][1]).toMatchObject({ level: 'fatal', contexts: { native_crash: { found_at_startup: true } } });
    expect(minidumpItems(envelope)).toHaveLength(1);
  });
});

describe('the replay above matches the installed @sentry/electron', () => {
  const mainEntryDir = path.dirname(electronMainEntry);

  it('still builds its client as @sentry/node\'s NodeClient', () => {
    const sdkSource = fs.readFileSync(path.join(mainEntryDir, 'sdk.js'), 'utf-8');

    expect(sdkSource).toContain("const node = require('@sentry/node');");
    expect(sdkSource).toContain('new node.NodeClient(options)');
  });

  it('still captures a minidump with the dump in the capture hint', () => {
    const minidumpDir = path.join(mainEntryDir, 'integrations', 'sentry-minidump');
    const integrationSource = fs.readFileSync(path.join(minidumpDir, 'index.js'), 'utf-8');
    const loaderSource = fs.readFileSync(path.join(minidumpDir, 'minidump-loader.js'), 'utf-8');

    expect(integrationSource).toContain('captureEvent(event, { attachments: [attachment] })');
    expect(loaderSource).toContain("attachmentType: 'event.minidump'");
  });

  it('still prefixes the dump\'s own Crashpad annotations with `crashpad.`, the keys the foreign rewrite strips', () => {
    const minidumpDir = path.join(mainEntryDir, 'integrations', 'sentry-minidump');
    const integrationSource = fs.readFileSync(path.join(minidumpDir, 'index.js'), 'utf-8');

    expect(integrationSource).toContain('`crashpad.${key}`');
  });
});
