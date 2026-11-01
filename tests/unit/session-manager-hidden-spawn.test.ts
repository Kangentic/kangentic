/**
 * The spawn side of a session hidden until adopted (#955): how
 * `SessionManager.spawn` launches one (`spawnHidden`), how it fails, and how a
 * task's own spawn supersedes one (`discardHiddenForTask`).
 * session-manager-hidden-session.test.ts pins what a hidden row looks like
 * once it exists; this file pins the paths that create and end it.
 *
 * Pins, against a real SessionManager with `doSpawn` stubbed and registry rows
 * seeded directly:
 *   - a refused early launch (no slot free) is never queued, releases the
 *     command hold, and leaves no mark behind;
 *   - the hidden mark is set before the spawn runs, so none of its events can
 *     reach a listener;
 *   - a spawn that throws or resolves a dead session leaves no row, and a
 *     failure that left a PTY ends it while the row is still hidden;
 *   - a non-hidden spawn for a task first ends that task's hidden row (the kill,
 *     the exit wait taken while the row exists, the removal) and waits for its
 *     exit before it starts, telling no listener of it.
 *
 * Modelled on session-manager-hidden-session.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

const { releaseCommandHoldSpy } = vi.hoisted(() => ({ releaseCommandHoldSpy: vi.fn() }));

vi.mock('node-pty', () => ({ spawn: vi.fn() }));

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
  isUncPath: (candidatePath: string) => /^[\\/]{2}[^\\/]/.test(candidatePath),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: vi.fn(),
  sanitizeErrorMessage: (message: string) => message,
}));

// Only the hold release is observed; everything else in the module is real.
vi.mock('../../src/main/pty/lifecycle/adapter-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/pty/lifecycle/adapter-lifecycle')>()),
  releaseCommandHold: releaseCommandHoldSpy,
}));

import { SessionManager } from '../../src/main/pty/session-manager';
import type { ManagedSession, SessionRegistry } from '../../src/main/pty/session-registry';
import type { Session, SpawnSessionInput } from '../../src/shared/types';

const TASK_ID = 'task-hidden-spawn';
const OTHER_TASK_ID = 'task-elsewhere';
const PROJECT_ID = 'project-hidden-spawn';
const HIDDEN_ID = 'sess-hidden';
const NEW_ID = 'sess-new';
/** Old enough that kill() closes the PTY at once instead of parking it for the exit grace. */
const LONG_AGO = '2000-01-01T00:00:00.000Z';
/** Every event a listener could hear about a session. */
const LISTENER_EVENTS = ['session-removed', 'session-changed', 'exit', 'activity', 'usage', 'event', 'first-output'];

interface QueueInternals {
  sessionQueue: {
    shouldQueue(): boolean;
    notifySlotFreed(): void;
    enqueue(input: SpawnSessionInput): void;
  };
}

interface DoSpawnInternals {
  doSpawn(input: SpawnSessionInput): Promise<Session>;
}

describe('SessionManager: spawning a session hidden until adopted', () => {
  let manager: SessionManager;
  let registry: SessionRegistry;
  let queue: QueueInternals['sessionQueue'];
  let shouldQueue: Mock<() => boolean>;
  let doSpawn: Mock<(input: SpawnSessionInput) => Promise<Session>>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionManager();
    registry = (manager as unknown as { registry: SessionRegistry }).registry;
    queue = (manager as unknown as QueueInternals).sessionQueue;
    shouldQueue = vi.spyOn(queue, 'shouldQueue').mockReturnValue(false);
    doSpawn = vi.spyOn(manager as unknown as DoSpawnInternals, 'doSpawn');
  });

  function buildInput(overrides: Partial<SpawnSessionInput> = {}): SpawnSessionInput {
    return {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      command: 'mock-agent',
      cwd: '/mock/cwd',
      ...overrides,
    };
  }

  function runningSession(id: string): Session {
    return { id, taskId: TASK_ID, projectId: PROJECT_ID, status: 'running' } as unknown as Session;
  }

  /** A registry row as doSpawn leaves it. With a PTY it is a running agent whose kill() is observable. */
  function seedRow(
    id: string,
    options: { taskId?: string; withPty: boolean; status?: ManagedSession['status'] },
  ): { ptyKill: Mock } {
    const ptyKill = vi.fn();
    registry.set(id, {
      id,
      taskId: options.taskId ?? TASK_ID,
      projectId: PROJECT_ID,
      pty: options.withPty
        ? ({ sealUserInput: vi.fn(), kill: ptyKill, pid: 4242 } as unknown as ManagedSession['pty'])
        : null,
      status: options.status ?? 'running',
      shell: '',
      cwd: '/mock/cwd',
      startedAt: LONG_AGO,
      exitCode: null,
      resuming: false,
      transient: false,
      exitSequence: ['\x03'],
    } as ManagedSession);
    return { ptyKill };
  }

  function hide(id: string): void {
    (manager as unknown as { hiddenUntilAdopted: Set<string> }).hiddenUntilAdopted.add(id);
  }

  function altScreenInputIds(): Set<string> {
    return (manager as unknown as { inputInAlternateScreen: Set<string> }).inputInAlternateScreen;
  }

  function spawningCount(): number {
    return (manager as unknown as { spawningCount: number }).spawningCount;
  }

  /** What listeners hear, as "event:sessionId". */
  function recordListenerEvents(): string[] {
    const heard: string[] = [];
    for (const eventName of LISTENER_EVENTS) {
      manager.on(eventName, (sessionId: string) => heard.push(`${eventName}:${sessionId}`));
    }
    return heard;
  }

  /**
   * A fixed budget for asserting that something has NOT happened yet, which
   * cannot be polled for: the work under test is microtasks plus a synchronous
   * kill, so this is far longer than it needs.
   */
  function allowPendingWorkToRun(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 30));
  }

  describe('an early launch with no agent slot free', () => {
    it('is refused, never queued, releases the command hold, and leaves no mark behind', async () => {
      shouldQueue.mockReturnValue(true);
      const enqueue = vi.spyOn(queue, 'enqueue');
      const markAltScreenInput = vi.spyOn(altScreenInputIds(), 'add');
      const agentParser = { marker: 'parser' } as unknown as SpawnSessionInput['agentParser'];

      await expect(manager.spawn(buildInput({
        id: HIDDEN_ID,
        hiddenUntilAdopted: true,
        inputInAlternateScreen: true,
        agentParser,
      }))).rejects.toThrow('No agent slot is free for an early launch');

      expect(doSpawn).not.toHaveBeenCalled();
      // Never queued: no placeholder row and nothing handed to the queue.
      expect(enqueue).not.toHaveBeenCalled();
      expect(registry.get(HIDDEN_ID)).toBeUndefined();
      // Red: dropping releaseCommandHold from the refusal strands the hold its build took.
      expect(releaseCommandHoldSpy).toHaveBeenCalledWith(agentParser, '/mock/cwd', HIDDEN_ID);
      // Red: marking it hidden before the slot check leaves this true.
      expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(false);
      // Red: spawn() marked it before handing over, and only this refusal clears it.
      // The mark is observed going in, so the clear is not vacuous.
      expect(markAltScreenInput).toHaveBeenCalledWith(HIDDEN_ID);
      expect(altScreenInputIds().has(HIDDEN_ID)).toBe(false);
    });
  });

  describe('a hidden spawn that goes ahead', () => {
    it('marks the id hidden, and as an alternate-screen input, before doSpawn runs', async () => {
      let hiddenWhenSpawnRan: boolean | undefined;
      let altScreenWhenSpawnRan: boolean | undefined;
      let spawningWhenSpawnRan: number | undefined;
      doSpawn.mockImplementation(async (input) => {
        hiddenWhenSpawnRan = manager.isHiddenUntilAdopted(input.id as string);
        altScreenWhenSpawnRan = altScreenInputIds().has(input.id as string);
        spawningWhenSpawnRan = spawningCount();
        seedRow(input.id as string, { withPty: true });
        return runningSession(input.id as string);
      });

      const session = await manager.spawn(buildInput({
        id: HIDDEN_ID,
        hiddenUntilAdopted: true,
        inputInAlternateScreen: true,
      }));

      // Red: adding the mark after doSpawn lets the spawn's own events reach listeners.
      expect(hiddenWhenSpawnRan).toBe(true);
      // Red: spawn() no longer recording an alternate-screen input id.
      expect(altScreenWhenSpawnRan).toBe(true);
      // The slot is reserved for the length of the spawn, and released after it.
      expect(spawningWhenSpawnRan).toBe(1);
      expect(spawningCount()).toBe(0);
      // A running session is returned still hidden, for its task's spawn to adopt.
      expect(session.id).toBe(HIDDEN_ID);
      expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(true);
      expect(registry.get(HIDDEN_ID)).toBeDefined();
      expect(altScreenInputIds().has(HIDDEN_ID)).toBe(true);
    });

    it('gives an input with no id one, and hides that id', async () => {
      let idDoSpawnGot: string | undefined;
      let hiddenWhenSpawnRan: boolean | undefined;
      doSpawn.mockImplementation(async (input) => {
        idDoSpawnGot = input.id;
        hiddenWhenSpawnRan = manager.isHiddenUntilAdopted(input.id as string);
        seedRow(input.id as string, { withPty: true });
        return runningSession(input.id as string);
      });

      await manager.spawn(buildInput({ hiddenUntilAdopted: true }));

      expect(typeof idDoSpawnGot).toBe('string');
      expect(hiddenWhenSpawnRan).toBe(true);
      expect(manager.isHiddenUntilAdopted(idDoSpawnGot as string)).toBe(true);
    });

    it('removes the exited placeholder a failed spawn leaves, since nothing shows it', async () => {
      const heard = recordListenerEvents();
      const notifySlotFreed = vi.spyOn(queue, 'notifySlotFreed');
      const exitedSession = { ...runningSession(HIDDEN_ID), status: 'exited' } as Session;
      doSpawn.mockImplementation(async (input) => {
        seedRow(input.id as string, { withPty: false, status: 'exited' });
        return exitedSession;
      });

      const session = await manager.spawn(buildInput({ id: HIDDEN_ID, hiddenUntilAdopted: true }));

      expect(session).toBe(exitedSession);
      // Red: dropping the remove leaves an exited row nobody can see or end.
      expect(registry.get(HIDDEN_ID)).toBeUndefined();
      expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(false);
      // The removal was of a hidden row, so it told no listener.
      expect(heard).toEqual([]);
      expect(spawningCount()).toBe(0);
      expect(notifySlotFreed).toHaveBeenCalled();
    });
  });

  describe('a hidden spawn that throws', () => {
    it('ends a PTY the failed spawn left, killing it and removing the row while it is still hidden', async () => {
      const heard = recordListenerEvents();
      const kill = vi.spyOn(manager, 'kill');
      const remove = vi.spyOn(manager, 'remove');
      const spawnFailure = new Error('the host failed after it started the PTY');
      let ptyKill: Mock | undefined;
      doSpawn.mockImplementation(async (input) => {
        ptyKill = seedRow(input.id as string, { withPty: true }).ptyKill;
        throw spawnFailure;
      });
      let settled = false;

      const spawning = manager.spawn(buildInput({
        id: HIDDEN_ID,
        hiddenUntilAdopted: true,
        inputInAlternateScreen: true,
      }));
      const outcome = spawning.then(() => 'resolved', (error: unknown) => { settled = true; return error; });

      await vi.waitFor(() => expect(ptyKill).toHaveBeenCalledTimes(1));
      // Kill, then remove. remove() kills too, so the PTY's kill alone cannot
      // tell the cleanup's own kill() from remove()'s.
      // Red: deleting the cleanup's `this.kill(id)` leaves remove()'s inner kill
      // as the first, which starts after remove() does.
      expect(Math.min(...kill.mock.invocationCallOrder)).toBeLessThan(Math.min(...remove.mock.invocationCallOrder));
      // Red: without the cleanup the row stays in the registry with a live PTY.
      expect(registry.get(HIDDEN_ID)).toBeUndefined();
      // The row is gone but its PTY's exit is still on its way: the id stays
      // hidden until that exit lands, and the launcher is still waiting on it.
      // Red: un-hiding it first sent session-removed to every listener.
      expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(true);
      await allowPendingWorkToRun();
      // Red: dropping `await exited` rejects before the PTY has exited.
      expect(settled).toBe(false);

      manager.emit('exit', HIDDEN_ID, 0, true);

      await expect(outcome).resolves.toBe(spawnFailure);
      expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(false);
      expect(altScreenInputIds().has(HIDDEN_ID)).toBe(false);
      // Nobody was ever told of the session: no removal, no status, no exit.
      expect(heard).toEqual([]);
      expect(spawningCount()).toBe(0);
    });

    it('removes a row the failed spawn left without a PTY, with no kill', async () => {
      const heard = recordListenerEvents();
      const kill = vi.spyOn(manager, 'kill');
      const spawnFailure = new Error('the spawn failed before the PTY started');
      doSpawn.mockImplementation(async (input) => {
        seedRow(input.id as string, { withPty: false });
        throw spawnFailure;
      });

      await expect(manager.spawn(buildInput({ id: HIDDEN_ID, hiddenUntilAdopted: true })))
        .rejects.toBe(spawnFailure);

      expect(registry.get(HIDDEN_ID)).toBeUndefined();
      expect(heard).toEqual([]);
      // remove() itself calls kill() once; the cleanup's own kill-first path is not taken.
      expect(kill).toHaveBeenCalledTimes(1);
    });

    it('clears the mark and the slot when it died before registering any row', async () => {
      const notifySlotFreed = vi.spyOn(queue, 'notifySlotFreed');
      const spawnFailure = new Error('the spawn failed before a row existed');
      doSpawn.mockRejectedValue(spawnFailure);

      await expect(manager.spawn(buildInput({
        id: HIDDEN_ID,
        hiddenUntilAdopted: true,
        inputInAlternateScreen: true,
      }))).rejects.toBe(spawnFailure);

      // Red: with no row to remove, nothing else would drop the mark.
      expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(false);
      expect(altScreenInputIds().has(HIDDEN_ID)).toBe(false);
      // The `finally` runs on the failure path: kill() is never reached here, so
      // only the spawn's own release can have notified the queue.
      expect(spawningCount()).toBe(0);
      expect(notifySlotFreed).toHaveBeenCalledTimes(1);
    });
  });

  describe("a task's own spawn supersedes the hidden row of that task", () => {
    it('kills it, waits for its exit, and only then starts, telling no listener', async () => {
      const { ptyKill } = seedRow(HIDDEN_ID, { withPty: true });
      hide(HIDDEN_ID);
      const heard = recordListenerEvents();
      const kill = vi.spyOn(manager, 'kill');
      const remove = vi.spyOn(manager, 'remove');
      doSpawn.mockResolvedValue(runningSession(NEW_ID));

      const spawning = manager.spawn(buildInput({ id: NEW_ID }));

      // Red: without discardHiddenForTask the hidden agent keeps running in the folder.
      expect(kill).toHaveBeenCalledWith(HIDDEN_ID);
      expect(remove).toHaveBeenCalledWith(HIDDEN_ID);
      expect(ptyKill).toHaveBeenCalledTimes(1);
      // Kill, then remove. remove() kills too, so "kill was called" alone cannot
      // tell the discard's own kill() from remove()'s.
      // Red: deleting the discard's `this.kill(session.id)` leaves remove()'s
      // inner kill as the first, which starts after remove() does.
      expect(Math.min(...kill.mock.invocationCallOrder)).toBeLessThan(Math.min(...remove.mock.invocationCallOrder));
      // The row is removed at once (the exit wait was taken before that).
      expect(registry.get(HIDDEN_ID)).toBeUndefined();
      await allowPendingWorkToRun();
      // Red: dropping `await Promise.all(exits)`, or taking awaitExit after the
      // remove (which finds no row and resolves at once), starts the new agent
      // while the old one still holds the folder.
      expect(doSpawn).not.toHaveBeenCalled();

      manager.emit('exit', HIDDEN_ID, 0, true);

      await expect(spawning).resolves.toMatchObject({ id: NEW_ID });
      expect(doSpawn).toHaveBeenCalledTimes(1);
      // The kill came before the spawn.
      expect(Math.min(...kill.mock.invocationCallOrder)).toBeLessThan(doSpawn.mock.invocationCallOrder[0]);
      expect(registry.get(HIDDEN_ID)).toBeUndefined();
      // It stayed hidden through the removal and the exit, then the mark was dropped with the exit.
      expect(manager.isHiddenUntilAdopted(HIDDEN_ID)).toBe(false);
      // Red: un-hiding it before the removal sent session-removed to every listener.
      expect(heard).toEqual([]);
    });

    it('ends only the hidden row of that task, not a visible sibling or the hidden row of another task', async () => {
      seedRow('sess-visible', { withPty: true });
      const hiddenElsewhere = seedRow('sess-hidden-elsewhere', { taskId: OTHER_TASK_ID, withPty: true });
      hide('sess-hidden-elsewhere');
      const kill = vi.spyOn(manager, 'kill');
      doSpawn.mockResolvedValue(runningSession(NEW_ID));

      await manager.spawn(buildInput({ id: NEW_ID }));

      // Red: dropping the hidden check kills the visible sibling; dropping the
      // task filter kills the other task's hidden agent.
      expect(kill).not.toHaveBeenCalled();
      expect(hiddenElsewhere.ptyKill).not.toHaveBeenCalled();
      expect(registry.get('sess-visible')).toBeDefined();
      expect(registry.get('sess-hidden-elsewhere')).toBeDefined();
      expect(manager.isHiddenUntilAdopted('sess-hidden-elsewhere')).toBe(true);
      expect(doSpawn).toHaveBeenCalledTimes(1);
    });

    it('does not kill anything when no session is hidden (the fast path)', async () => {
      const visible = seedRow('sess-visible', { withPty: true });
      const kill = vi.spyOn(manager, 'kill');
      doSpawn.mockResolvedValue(runningSession(NEW_ID));

      await manager.spawn(buildInput({ id: NEW_ID }));

      // Red: only if a plain spawn starts killing a visible row of its own task.
      // (The `hiddenUntilAdopted.size > 0` guard only saves a registry walk, so
      // dropping it changes nothing observable here.)
      expect(kill).not.toHaveBeenCalled();
      expect(visible.ptyKill).not.toHaveBeenCalled();
      expect(doSpawn).toHaveBeenCalledTimes(1);
    });
  });
});
