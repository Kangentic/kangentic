/**
 * The OpenCode plugin load marker (`opencode-plugin.json`) and the reader that turns it into the
 * session-id report's `hook_load` value (Sentry DESKTOP-3A).
 *
 * What a user loses if a test here fails:
 * - the slack and distro tests: a plugin that did load reads as not loaded (or an earlier run's marker
 *   reads as this run's), so the report blames the wrong cause for a missing session id.
 * - the unknown tests: a marker or folder the reader cannot trust is reported as a definite answer.
 * - the real plugin tests: the plugins and the reader drift apart on the file name or a field name, and
 *   every session reads `none` or `unknown` however well the plugin ran.
 * - the reload and temporary-file tests: a rewritten plugin forgets that it already heard events, or a
 *   half-written marker is left in the session folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';
import {
  LOAD_MARKER_CLOCK_SLACK_MS,
  LOAD_MARKER_DISTRO_CLOCK_SLACK_MS,
  readPluginLoadEvidence,
} from '../../src/main/agent/adapters/opencode/hook-manager';

const MARKER_NAME = 'opencode-plugin.json';
const spawnedAt = new Date('2026-11-25T12:00:00.000Z');

let sessionFolder: string;
let eventsPath: string;

beforeEach(() => {
  sessionFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangtest-opencode-load-evidence-'));
  eventsPath = path.join(sessionFolder, 'events.jsonl');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  fs.rmSync(sessionFolder, { recursive: true, force: true });
});

function writeMarker(marker: unknown): void {
  fs.writeFileSync(path.join(sessionFolder, MARKER_NAME), typeof marker === 'string' ? marker : JSON.stringify(marker));
}

function readMarker(): { setupAt: number; firstEventAt: number | null } {
  return JSON.parse(fs.readFileSync(path.join(sessionFolder, MARKER_NAME), 'utf-8')) as { setupAt: number; firstEventAt: number | null };
}

describe('readPluginLoadEvidence clock slack', () => {
  it('keeps the slack constants the adapter relies on', () => {
    expect(LOAD_MARKER_CLOCK_SLACK_MS).toBe(1000);
    expect(LOAD_MARKER_DISTRO_CLOCK_SLACK_MS).toBe(30000);
  });

  it('reads a marker set up exactly one slack before the spawn as this run\'s, and 1 ms earlier as an earlier run\'s', async () => {
    writeMarker({ setupAt: spawnedAt.getTime() - 1000, firstEventAt: null });
    await expect(readPluginLoadEvidence(eventsPath, spawnedAt)).resolves.toBe('setup');
    writeMarker({ setupAt: spawnedAt.getTime() - 1000, firstEventAt: spawnedAt.getTime() });
    await expect(readPluginLoadEvidence(eventsPath, spawnedAt)).resolves.toBe('events');
    writeMarker({ setupAt: spawnedAt.getTime() - 1001, firstEventAt: null });
    await expect(readPluginLoadEvidence(eventsPath, spawnedAt)).resolves.toBe('none');
  });

  it('reads an old marker as set up when the spawn time is not known', async () => {
    writeMarker({ setupAt: spawnedAt.getTime() - 3_600_000, firstEventAt: null });
    await expect(readPluginLoadEvidence(eventsPath, undefined)).resolves.toBe('setup');
  });
});

describe('OpenCodeAdapter hookLoadEvidence in a WSL distro', () => {
  const adapter = new OpenCodeAdapter();
  const wslTarget = { kind: 'wsl', distro: 'TestDistro', homeLinux: '/home/dev' };

  function check(cliTarget?: unknown): Promise<string> {
    const hookLoadEvidence = adapter.runtime.sessionId?.hookLoadEvidence;
    if (!hookLoadEvidence) throw new Error('OpenCode declares no hookLoadEvidence');
    return hookLoadEvidence({ cwd: sessionFolder, eventsOutputPath: eventsPath, spawnedAt, cliTarget } as Parameters<typeof hookLoadEvidence>[0]);
  }

  it('reads a marker 5 s before the spawn as an earlier run\'s here, and as this run\'s in a distro', async () => {
    writeMarker({ setupAt: spawnedAt.getTime() - 5000, firstEventAt: null });
    await expect(check()).resolves.toBe('none');
    await expect(check(wslTarget)).resolves.toBe('setup');
  });

  it('reads a marker 31 s before the spawn as an earlier run\'s even in a distro', async () => {
    writeMarker({ setupAt: spawnedAt.getTime() - 31_000, firstEventAt: null });
    await expect(check(wslTarget)).resolves.toBe('none');
  });

  it('reads unknown for a spawn the adapter recorded as a remote OpenCode server', async () => {
    writeMarker({ setupAt: spawnedAt.getTime() + 1000, firstEventAt: null });
    await expect(check()).resolves.toBe('setup');
    adapter.buildCommand({
      agentPath: '/usr/bin/opencode',
      taskId: 'task-001',
      cwd: sessionFolder,
      permissionMode: 'default',
      executionTarget: { url: 'http://10.0.0.5:4096', auth: { kind: 'none' }, workingDirectory: '/srv' },
    });
    await expect(check()).resolves.toBe('unknown');
  });
});

describe('readPluginLoadEvidence unknown answers', () => {
  it('reads unknown for a directory at the marker path', async () => {
    fs.mkdirSync(path.join(sessionFolder, MARKER_NAME));
    await expect(readPluginLoadEvidence(eventsPath, spawnedAt)).resolves.toBe('unknown');
  });

  it.each([['null', 'null'], ['an array', '[]'], ['an object with no setupAt', '{}']])('reads unknown for a marker that is %s', async (_label, text) => {
    writeMarker(text);
    await expect(readPluginLoadEvidence(eventsPath, spawnedAt)).resolves.toBe('unknown');
  });

  it('reads unknown for a session folder that is gone, and none for one that exists with no marker', async () => {
    await expect(readPluginLoadEvidence(eventsPath, spawnedAt)).resolves.toBe('none');
    const goneEventsPath = path.join(sessionFolder, 'removed-session', 'events.jsonl');
    await expect(readPluginLoadEvidence(goneEventsPath, spawnedAt)).resolves.toBe('unknown');
  });
});

describe('the real plugins and the real reader agree on the marker', () => {
  interface V2Plugin { setup(ctx: unknown): Promise<(() => void) | undefined> }
  interface V1Hooks { event: (payload: { event: unknown }) => Promise<void> }

  async function loadV2(): Promise<V2Plugin> {
    vi.resetModules();
    const module = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity-v2.mjs');
    return module.default as unknown as V2Plugin;
  }

  async function loadV1(): Promise<() => Promise<V1Hooks>> {
    vi.resetModules();
    const module = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs');
    return module.KangenticActivity as unknown as () => Promise<V1Hooks>;
  }

  function oneEventContext(): unknown {
    return {
      app: { version: '2.4.1' },
      event: {
        subscribe: () => (async function* () {
          yield { type: 'session.execution.started', data: { sessionID: 'ses_v2_0123456789abcdef' } };
          await new Promise(() => undefined);
        })(),
      },
      tool: { hook: async () => undefined },
    };
  }

  function silentContext(): unknown {
    return {
      app: { version: '2.4.1' },
      event: { subscribe: () => (async function* () { await new Promise(() => undefined); })() },
      tool: { hook: async () => undefined },
    };
  }

  beforeEach(() => {
    vi.stubEnv('KANGENTIC_EVENTS_PATH', eventsPath);
  });

  it('V2: reads events after the plugin heard one, and setup when it heard none', async () => {
    const before = new Date(Date.now() - 10);
    const silentCleanup = await (await loadV2()).setup(silentContext());
    await expect(readPluginLoadEvidence(eventsPath, before)).resolves.toBe('setup');
    silentCleanup?.();

    fs.rmSync(path.join(sessionFolder, MARKER_NAME), { force: true });
    const cleanup = await (await loadV2()).setup(oneEventContext());
    await expect.poll(() => readPluginLoadEvidence(eventsPath, before), { timeout: 5000 }).toBe('events');
    cleanup?.();
  });

  it('V1: reads setup after the plugin loaded, and events after its first event hook', async () => {
    const before = new Date(Date.now() - 10);
    const hooks = await (await loadV1())();
    await expect(readPluginLoadEvidence(eventsPath, before)).resolves.toBe('setup');
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_2349b5c91ffeKd6qajuUTR4clq' } } } });
    await expect(readPluginLoadEvidence(eventsPath, before)).resolves.toBe('events');
  });

  it('V2: a reload in the same process keeps the first event of the earlier setup', async () => {
    const cleanup = await (await loadV2()).setup(oneEventContext());
    await expect.poll(() => typeof readMarker().firstEventAt, { timeout: 5000 }).toBe('number');
    const first = readMarker();
    cleanup?.();

    // A fixed wait so the reload's setup time differs from the first one's by a measurable amount.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reloadCleanup = await (await loadV2()).setup(silentContext());
    const reloaded = readMarker();
    reloadCleanup?.();

    expect(reloaded.firstEventAt).toBe(first.firstEventAt);
    expect(reloaded.setupAt).toBeGreaterThan(first.setupAt);
  });

  it('V2: a marker older than the process is an earlier run\'s and its first event is not carried', async () => {
    const processStartedAt = Date.now() - process.uptime() * 1000;
    writeMarker({ kangenticOpenCodePlugin: 1, major: 2, setupAt: processStartedAt - 60_000, firstEventAt: processStartedAt - 59_000 });
    const cleanup = await (await loadV2()).setup(silentContext());
    const marker = readMarker();
    cleanup?.();
    expect(marker.firstEventAt).toBeNull();
  });

  it('leaves no temporary file in the session folder after setup and the first event', async () => {
    const cleanup = await (await loadV2()).setup(oneEventContext());
    await expect.poll(() => typeof readMarker().firstEventAt, { timeout: 5000 }).toBe('number');
    cleanup?.();
    const hooks = await (await loadV1())();
    await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'ses_2349b5c91ffeKd6qajuUTR4clq' } } } });

    const temporaryFiles = fs.readdirSync(sessionFolder).filter((name) => name.endsWith('.tmp'));
    expect(temporaryFiles).toEqual([]);
    expect(fs.existsSync(path.join(sessionFolder, MARKER_NAME))).toBe(true);
  });
});
