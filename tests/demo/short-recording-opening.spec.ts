/**
 * A working session whose recording is shorter than its live tail opens at its first byte.
 *
 * The seed (tests/captures/helpers/demo-dataset.ts) used to finish such a session on the spot when
 * the recording ran to the agent's own end, so a still showed the finished end while the live frame
 * opened working with an empty terminal, and the card, the sidebar count and the Monitor changed at
 * the poster lift (kangentic.com #137). The still now paints that same opening moment: working,
 * nothing in the terminal, an empty Monitor peek.
 *
 * Which sessions qualify is read from the sample install and its recordings, not hardcoded, so the
 * test names a precondition rather than a session that could stop qualifying unnoticed.
 */
import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { startDemoServer } from '../../demo/static-server.mjs';
import DEMO_MANIFEST from '../captures/fixtures/demo/manifest.json';
import { DEMO_SESSIONS, SESSION_MIDDLEWARE } from '../captures/helpers/demo-dataset';

const DIST_DIR = path.resolve(__dirname, '..', '..', 'dist', 'demo');
const FIXTURE_DIR = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo');
const READY_TIMEOUT_MS = 20_000;

interface Recording { durationMs: number; stopReason: string; openFrame?: unknown }

interface ManifestCapture { sessionId?: string; file?: string; liveTailMs?: number }

function recordingOf(sessionId: string): { recording: Recording; tailMs: number } {
  const capture = (DEMO_MANIFEST.captures as ManifestCapture[]).find((candidate) => candidate.sessionId === sessionId);
  if (!capture?.file) throw new Error(`no manifest capture for ${sessionId}`);
  const recording = JSON.parse(readFileSync(path.join(FIXTURE_DIR, capture.file), 'utf8')) as Recording;
  const session = DEMO_SESSIONS.find((candidate) => candidate.id === sessionId) as { liveTailMs?: number } | undefined;
  return { recording, tailMs: session?.liveTailMs ?? capture.liveTailMs ?? DEMO_MANIFEST.liveTailMs };
}

const WORKING_SESSIONS = DEMO_SESSIONS.filter((session) => session.activity === 'thinking');

/** A working session that ran to the agent's own end in less time than its tail, with no open frame. */
const SHORT_SESSIONS = WORKING_SESSIONS.filter((session) => {
  const { recording, tailMs } = recordingOf(session.id);
  return (recording.stopReason === 'idle' || recording.stopReason === 'exited')
    && recording.durationMs <= tailMs
    && !recording.openFrame;
}).map((session) => session.id);

interface MonitorWindow {
  __mockMonitorRows?: Array<{ sessionId: string; activity: string; outputPeek?: string[] }>;
  __demoScrollback?: Record<string, string>;
}

type DemoServer = Awaited<ReturnType<typeof startDemoServer>>;
let server: DemoServer;

test.use({ viewport: { width: 1600, height: 1000 } });

test.beforeAll(async () => {
  server = await startDemoServer({ distDir: DIST_DIR, port: 0 });
});

test.afterAll(async () => {
  if (server) await server.close();
});

async function openMonitorStill(page: Page): Promise<void> {
  const url = new URL(server.url);
  url.searchParams.set('stage', '0');
  url.searchParams.set('view', 'monitor');
  url.searchParams.set('embed', '1');
  url.searchParams.set('still', '1');
  await page.goto(url.toString());
  await expect(page.locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
  await expect(page.locator('[data-testid="monitor-page"]')).toBeVisible();
}

function monitorState(page: Page, sessionId: string): Promise<{ activity: string; peekLines: number; scrollbackLength: number | null } | null> {
  return page.evaluate((id) => {
    const demoWindow = window as unknown as MonitorWindow;
    const row = (demoWindow.__mockMonitorRows ?? []).find((candidate) => candidate.sessionId === id);
    if (!row) return null;
    const scrollback = demoWindow.__demoScrollback?.[id];
    return { activity: row.activity, peekLines: (row.outputPeek ?? []).length, scrollbackLength: typeof scrollback === 'string' ? scrollback.length : null };
  }, sessionId);
}

test('the sample install has a working session whose recording is shorter than its tail', () => {
  // Without one, the test below proves nothing, so say so instead of passing on an empty loop.
  expect(SHORT_SESSIONS.length).toBeGreaterThan(0);
});

test('a still opens a short recording at its first byte, working with an empty terminal and peek', async ({ page }) => {
  await openMonitorStill(page);
  for (const sessionId of SHORT_SESSIONS) {
    const state = await monitorState(page, sessionId);
    expect(state, `${sessionId} is a Monitor row`).not.toBeNull();
    // Finished would read idle: the card, the count and the Monitor would change at the lift.
    expect(state?.activity, `${sessionId} is still working`).toBe('thinking');
    expect(state?.peekLines, `${sessionId} peek is empty at its first byte`).toBe(0);
    expect(state?.scrollbackLength, `${sessionId} terminal is empty at its first byte`).toBe(0);
  }
});

test('a long recording that opens mid-run keeps its own opening frame and peek', async ({ page }) => {
  const { recording, tailMs } = recordingOf(SESSION_MIDDLEWARE);
  expect(recording.durationMs).toBeGreaterThan(tailMs);
  await openMonitorStill(page);
  const state = await monitorState(page, SESSION_MIDDLEWARE);
  expect(state?.activity).toBe('thinking');
  expect(state?.peekLines).toBeGreaterThan(0);
  expect(state?.scrollbackLength).toBeGreaterThan(0);
});
