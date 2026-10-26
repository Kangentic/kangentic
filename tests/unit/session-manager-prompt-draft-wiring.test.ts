/**
 * Unit tests for the `PromptDraftLedger` WIRING behind `SessionManager`
 * (src/main/pty/session-manager.ts), not the ledger class itself.
 *
 * `tests/unit/prompt-draft-ledger.test.ts` already covers `PromptDraftLedger`
 * in isolation. The ledger runs in the pty host core (in process here), and
 * these pin the path that makes it matter in production:
 *
 *   - `write()`'s `origin: WriteOrigin = 'system'` default, carried to the
 *     host on its `enqueueWrite` command, where the ledger records it.
 *   - the host's `promptDraft` event feeding main's mirror, which
 *     `getPendingDraft` reads, and the mirror cleared when the PTY exits.
 *   - `readPendingDraft`, which keystroke injection reads: it asks the host's
 *     ledger (so a key typed on a renderer's own port just before an injection
 *     counts, though main has not heard of it yet) and falls back to the mirror
 *     when there is no live PTY or the host cannot answer.
 *
 * Every consumer test of auto_command injection mocks `SessionManager`
 * wholesale, so a break anywhere on that path passes the entire suite silently.
 * These tests instantiate a REAL `SessionManager` against a mocked
 * `node-pty`, following the harness established by
 * `session-manager-write-queue.test.ts` and `session-manager-data-tap.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

vi.mock('../../src/main/pty/spawn/shell-resolver', () => {
  class MockShellResolver {
    async getDefaultShell() { return '/bin/bash'; }
  }
  return { ShellResolver: MockShellResolver };
});

vi.mock('../../src/shared/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/paths')>()),
  adaptCommandForShell: (command: string) => command,
  buildSpawnClearPrelude: () => '',
  isUncPath: (pathString: string) => /^[\\/]{2}[^\\/]/.test(pathString),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

import * as nodePty from 'node-pty';
import { SessionManager } from '../../src/main/pty/session-manager';
import type { PtyHostClient } from '../../src/main/pty/host/pty-host-client';
import { createFakeRendererPort } from './helpers/fake-renderer-port';

function createMockPty() {
  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((event: { exitCode: number }) => void) | null = null;

  const mockPty = {
    pid: 12345,
    onData: vi.fn((callback: (data: string) => void) => {
      dataHandler = callback;
    }),
    onExit: vi.fn((callback: (event: { exitCode: number }) => void) => {
      exitHandler = callback;
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => {
      if (exitHandler) exitHandler({ exitCode: 0 });
    }),
  };

  return {
    mockPty,
    feedData: (data: string) => dataHandler?.(data),
    triggerExit: (exitCode = 0) => exitHandler?.({ exitCode }),
  };
}

let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-prompt-draft-wiring-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function spawnSessionWithMock(manager: SessionManager, taskId: string) {
  const mock = createMockPty();
  vi.mocked(nodePty.spawn).mockReturnValue(mock.mockPty as unknown as nodePty.IPty);
  // Spawn as a resume so the session starts idle, avoiding the fresh-spawn
  // 'thinking' seed and its stale-thinking watchdog timer - irrelevant to the
  // ledger wiring under test, and it only adds timer noise.
  const session = await manager.spawn({
    taskId,
    command: '',
    cwd: tmpDir,
    resuming: true,
  });
  return { session, ...mock };
}

describe('SessionManager - PromptDraftLedger wiring', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  it('write() with no explicit origin does NOT record a draft (default is "system")', async () => {
    // This is the safe direction: an unmarked caller (an injected keystroke,
    // an adapter settings write) must never be mistaken for something the
    // user was typing. Regresses if the default parameter is ever flipped to
    // 'user', or if a call site starts passing 'user' explicitly by mistake.
    const { session } = await spawnSessionWithMock(manager, 'task-draft-default-origin');

    manager.write(session.id, 'instead can we');

    expect(manager.getPendingDraft(session.id)).toBeNull();
  });

  it('write() with origin: "user" accumulates into the draft, retrievable via getPendingDraft', async () => {
    const { session } = await spawnSessionWithMock(manager, 'task-draft-user-origin');

    manager.write(session.id, 'instead can we', 'user');

    expect(manager.getPendingDraft(session.id)).toBe('instead can we');
  });

  it('a session exit clears that session\'s draft, so a later session cannot inherit it', async () => {
    const { session, triggerExit } = await spawnSessionWithMock(manager, 'task-draft-exit-clear');

    manager.write(session.id, 'half-written message', 'user');
    expect(manager.getPendingDraft(session.id)).toBe('half-written message');

    triggerExit(0);

    expect(manager.getPendingDraft(session.id)).toBeNull();
  });
});

describe('SessionManager - readPendingDraft', () => {
  // A renderer's keystrokes reach the host on the renderer's own port, so main
  // hears of a draft only from the host's `promptDraft` event. The in-process
  // host used here delivers that event synchronously, which a real utility
  // process never does: the mirror there trails the keystroke. Where a test
  // needs that trailing mirror, it empties the mirror after the keystroke (the
  // state of the event still being in flight) instead of racing real timing.
  const RENDERER_ID = 1;
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  afterEach(async () => {
    manager.killAll();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  function hostClientOf(target: SessionManager): PtyHostClient {
    return (target as unknown as { host: PtyHostClient }).host;
  }

  function draftMirrorOf(target: SessionManager): Map<string, string> {
    return (target as unknown as { promptDraftMirror: Map<string, string> }).promptDraftMirror;
  }

  /** A renderer's own port, attached, from which the test types as the user would. */
  function attachRendererPort() {
    const rendererPort = createFakeRendererPort();
    manager.attachRendererPort(RENDERER_ID, rendererPort.port);
    return rendererPort;
  }

  it('returns a draft typed on the renderer\'s own port', async () => {
    // The whole path in one: a keystroke on the port reaches the host's write
    // queue as user input, the ledger records it, and the request returns it.
    // A port write that skipped the ledger (origin not "user", or never queued)
    // leaves the draft empty here.
    const { session } = await spawnSessionWithMock(manager, 'task-read-draft-port');
    const rendererPort = attachRendererPort();

    rendererPort.send({ type: 'write', sessionId: session.id, data: 'half a thought' });

    await expect(manager.readPendingDraft(session.id)).resolves.toBe('half a thought');
  });

  it('counts a keystroke whose promptDraft event main has not received yet', async () => {
    const { session } = await spawnSessionWithMock(manager, 'task-read-draft-ahead-of-mirror');
    const rendererPort = attachRendererPort();
    const getPromptDraftSpy = vi.spyOn(hostClientOf(manager), 'getPromptDraft');

    rendererPort.send({ type: 'write', sessionId: session.id, data: 'half a thought' });
    draftMirrorOf(manager).clear();

    // The premise: main's mirror knows nothing of the keystroke yet.
    expect(manager.getPendingDraft(session.id)).toBeNull();
    // Keystroke injection must still see it, or it would clear the prompt without
    // reporting the text it discarded. Only the host's ledger holds it, so this
    // fails if readPendingDraft reads the mirror instead of asking the host.
    await expect(manager.readPendingDraft(session.id)).resolves.toBe('half a thought');
    expect(getPromptDraftSpy).toHaveBeenCalledWith(session.id);
  });

  it('takes the host\'s empty answer over a stale mirror entry', async () => {
    // The opposite lag: the user sent the draft and the host's ledger is empty,
    // but the mirror still holds the old text because the clearing event has not
    // landed. Injection must not report a draft the user already sent.
    const { session } = await spawnSessionWithMock(manager, 'task-read-draft-stale-mirror');
    draftMirrorOf(manager).set(session.id, 'sent a moment ago');

    expect(manager.getPendingDraft(session.id)).toBe('sent a moment ago');
    await expect(manager.readPendingDraft(session.id)).resolves.toBeNull();
  });

  it('falls back to the mirror, without asking the host, when the session has no live PTY', async () => {
    const { session } = await spawnSessionWithMock(manager, 'task-read-draft-no-live-pty');
    manager.kill(session.id, { immediate: true });
    const getPromptDraftSpy = vi.spyOn(hostClientOf(manager), 'getPromptDraft');
    // Set after the kill so the exit's own mirror clear cannot remove it, and read
    // in the same tick: readPendingDraft decides on the row's PTY synchronously.
    draftMirrorOf(manager).set(session.id, 'left in the mirror');

    await expect(manager.readPendingDraft(session.id)).resolves.toBe('left in the mirror');
    // The host would answer null for a dead PTY, so an implementation that asked
    // it anyway would return null here and show up as a call.
    expect(getPromptDraftSpy).not.toHaveBeenCalled();
  });

  it('resolves to null for a session id it has never seen', async () => {
    const getPromptDraftSpy = vi.spyOn(hostClientOf(manager), 'getPromptDraft');

    await expect(manager.readPendingDraft('no-such-session')).resolves.toBeNull();
    expect(getPromptDraftSpy).not.toHaveBeenCalled();
  });

  it('resolves to the mirror\'s value, not a rejection, when the host request fails', async () => {
    const { session } = await spawnSessionWithMock(manager, 'task-read-draft-host-rejects');
    const rendererPort = attachRendererPort();
    rendererPort.send({ type: 'write', sessionId: session.id, data: 'half a thought' });
    // The mirror holds the draft (the in-process host's event is synchronous).
    expect(manager.getPendingDraft(session.id)).toBe('half a thought');
    const getPromptDraftSpy = vi
      .spyOn(hostClientOf(manager), 'getPromptDraft')
      .mockRejectedValue(new Error('pty host is gone'));

    // A caller that propagated the rejection would abort an auto_command
    // injection over a transient host fault; one that returned null would clear
    // a prompt it never counted the draft of.
    await expect(manager.readPendingDraft(session.id)).resolves.toBe('half a thought');
    expect(getPromptDraftSpy).toHaveBeenCalledWith(session.id);
  });
});
