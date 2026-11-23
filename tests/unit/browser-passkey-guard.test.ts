/**
 * The passkey guard: while an agent controls a Browser surface, its passkey
 * (WebAuthn) requests go to a CDP virtual authenticator instead of the OS.
 *
 * A sign-in page asks for a passkey as it LOADS, and in Electron
 * that request opened Windows' "Choose a passkey" dialog at once, on an agent's
 * surface with nobody to answer it. Measured on Electron 45 on Windows with a
 * live `<webview>` (decision 47): unarmed, the dialog's process
 * (`CredentialUIBroker.exe`) came up 2s after load; armed at construction it
 * never appeared, across a cross-origin navigation too, and after the
 * authenticator was removed a new request reached Windows again.
 *
 * What a user loses if these go: the dialog comes back on unattended runs
 * (an arm that drifts after the first load, or from `attachDebugger` into the
 * dev bridge), or their own passkey sign-in in a pane stops reaching Windows
 * Hello (a release that never disarms).
 *
 * Tier: Unit. The debugger is a spy and the guard runs against the REAL cdp.ts.
 * Whether Chromium honours the arm is Windows-only and lives in
 * `scripts/probe-passkey-dialog.js`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebContents } from 'electron';

const hoisted = vi.hoisted(() => {
  const sessions = new Map<string, object>();
  /** One object per partition, as `session.fromPartition` returns. */
  const sessionFor = (partition: string): object => {
    let found = sessions.get(partition);
    if (!found) {
      found = { partition };
      sessions.set(partition, found);
    }
    return found;
  };
  return {
    sessionFor,
    driving: new Set<number>(),
    reports: [] as { error: unknown; tags: unknown }[],
  };
});

vi.mock('electron', () => ({
  session: {
    fromPartition: (partition: string) => hoisted.sessionFor(partition),
  },
}));
vi.mock('../../src/main/browser/agent-input-signal', () => ({
  isAgentDriving: (guestId: number) => hoisted.driving.has(guestId),
}));
vi.mock('../../src/main/analytics/handled-report', () => ({
  createChokepointReporter: () => ({
    report: (error: unknown, options?: { tags?: unknown }) => {
      hoisted.reports.push({ error, tags: options?.tags });
      return true;
    },
  }),
}));

import {
  attachDebugger,
  detachDebugger,
  ensureVirtualAuthenticator,
  hasVirtualAuthenticator,
  removeVirtualAuthenticator,
  VIRTUAL_AUTHENTICATOR_OPTIONS,
} from '../../src/main/browser/cdp/cdp';
import {
  armAttachedGuest,
  armGuest,
  forgetAgentControl,
  isUnderAgentControl,
  markAgentControl,
  releaseAgentControl,
  resetPasskeyGuardForTests,
} from '../../src/main/browser/passkey-guard';
import { browserPartitionForCommandTerminals, browserPartitionForOwner } from '../../src/shared/browser-partition';
import { commandTerminalBrowserOwner } from '../../src/shared/browser-owner';

interface SentCommand {
  method: string;
  params: Record<string, unknown> | undefined;
}

let nextGuestId = 100;

/**
 * A guest whose debugger records every command. `failing` rejects those
 * methods. `held` leaves those methods pending until `release` settles the
 * oldest one, so a test can act while an install is in flight. `attachFails`
 * makes `debugger.attach` throw.
 */
function fakeGuest(options: { partition?: string; failing?: string[]; held?: string[]; attachFails?: boolean } = {}) {
  const sent: SentCommand[] = [];
  const listeners: Record<string, ((...args: never[]) => void)[]> = {};
  const pending: Record<string, { resolve: () => void; reject: (error: Error) => void }[]> = {};
  let destroyed = false;
  const id = (nextGuestId += 1);
  const attach = vi.fn(() => {
    if (options.attachFails) throw new Error('attach refused');
  });
  const guest = {
    id,
    isDestroyed: () => destroyed,
    session: options.partition ? hoisted.sessionFor(options.partition) : {},
    debugger: {
      attach,
      detach: vi.fn(() => {
        for (const handler of listeners.detach ?? []) {
          (handler as unknown as (event: unknown, reason: string) => void)({}, 'target closed');
        }
      }),
      sendCommand: vi.fn((method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        if (options.failing?.includes(method)) return Promise.reject(new Error(`${method} refused`));
        if (options.held?.includes(method)) {
          return new Promise((resolve, reject) => {
            (pending[method] ??= []).push({ resolve: () => resolve({ authenticatorId: 'virtual-1' }), reject });
          });
        }
        return Promise.resolve({ authenticatorId: 'virtual-1' });
      }),
      on: (event: string, handler: (...args: never[]) => void) => {
        (listeners[event] ??= []).push(handler);
      },
      removeListener: () => {},
    },
  };
  return {
    id,
    guest: guest as unknown as WebContents,
    attach,
    webAuthn: () => sent.filter((entry) => entry.method.startsWith('WebAuthn.')),
    destroy: () => { destroyed = true; },
    /** Settle the oldest pending call of a held method. */
    release: (method: string, outcome: 'resolve' | 'reject') => {
      const next = pending[method]?.shift();
      if (!next) throw new Error(`no pending ${method}`);
      if (outcome === 'resolve') next.resolve();
      else next.reject(new Error(`${method} refused`));
    },
  };
}

/** Let every queued microtask and the sends they make run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const ADD = 'WebAuthn.addVirtualAuthenticator';
const methodsOf = (commands: SentCommand[]): string[] => commands.map((entry) => entry.method);

beforeEach(() => {
  resetPasskeyGuardForTests();
  hoisted.driving.clear();
  hoisted.reports.length = 0;
});

describe('ensureVirtualAuthenticator', () => {
  it('is never sent by attachDebugger alone', () => {
    // The dev inspection bridge attaches through `attachDebugger` against
    // Kangentic's own window, and a person's own pane must keep reaching the OS.
    const { guest, webAuthn } = fakeGuest();
    attachDebugger(guest);
    expect(webAuthn()).toEqual([]);
  });

  it('enables WebAuthn with no UI, then adds one authenticator, once per session', async () => {
    const { guest, webAuthn } = fakeGuest();
    attachDebugger(guest);
    const [first, second] = await Promise.all([
      ensureVirtualAuthenticator(guest),
      ensureVirtualAuthenticator(guest),
    ]);
    await ensureVirtualAuthenticator(guest);
    expect(first && second).toBe(true);
    expect(webAuthn()).toEqual([
      { method: 'WebAuthn.enable', params: { enableUI: false } },
      { method: 'WebAuthn.addVirtualAuthenticator', params: { options: VIRTUAL_AUTHENTICATOR_OPTIONS } },
    ]);
    // Presence answered by the authenticator itself, so a request fails or
    // completes rather than waiting for a touch that never comes.
    expect(VIRTUAL_AUTHENTICATOR_OPTIONS.automaticPresenceSimulation).toBe(true);
  });

  it('arms again after a detach, which drops the virtual environment', async () => {
    const { guest, webAuthn } = fakeGuest();
    attachDebugger(guest);
    await ensureVirtualAuthenticator(guest);
    detachDebugger(guest);
    expect(hasVirtualAuthenticator(guest)).toBe(false);
    attachDebugger(guest);
    await ensureVirtualAuthenticator(guest);
    expect(webAuthn().filter((entry) => entry.method === 'WebAuthn.enable')).toHaveLength(2);
  });

  it('resolves false without a debugger, and forgets a refused install so the next call retries', async () => {
    const unattached = fakeGuest();
    expect(await ensureVirtualAuthenticator(unattached.guest)).toBe(false);

    const refusing = fakeGuest({ failing: ['WebAuthn.enable'] });
    attachDebugger(refusing.guest);
    expect(await ensureVirtualAuthenticator(refusing.guest)).toBe(false);
    expect(hasVirtualAuthenticator(refusing.guest)).toBe(false);
    await ensureVirtualAuthenticator(refusing.guest);
    expect(refusing.webAuthn().filter((entry) => entry.method === 'WebAuthn.enable')).toHaveLength(2);
  });
});

describe('removeVirtualAuthenticator', () => {
  it('disables WebAuthn once, and is a no-op when nothing is armed', async () => {
    const { guest, webAuthn } = fakeGuest();
    attachDebugger(guest);
    await removeVirtualAuthenticator(guest);
    expect(webAuthn()).toEqual([]);

    await ensureVirtualAuthenticator(guest);
    await removeVirtualAuthenticator(guest);
    await removeVirtualAuthenticator(guest);
    expect(webAuthn().map((entry) => entry.method)).toEqual([
      'WebAuthn.enable',
      'WebAuthn.addVirtualAuthenticator',
      'WebAuthn.disable',
    ]);
    expect(hasVirtualAuthenticator(guest)).toBe(false);
  });

  it('sends the disable in the same tick as the call once the install has settled', async () => {
    // The person's press is the call, and the click right after it is what
    // asks for a passkey. A disable that waited a microtask would race it.
    const { guest, webAuthn } = fakeGuest();
    attachDebugger(guest);
    await ensureVirtualAuthenticator(guest);
    await Promise.resolve();
    void removeVirtualAuthenticator(guest);
    expect(webAuthn().map((entry) => entry.method)).toContain('WebAuthn.disable');
  });

  it('leaves alone an authenticator a drive armed again while the removal waited', async () => {
    const { guest, webAuthn } = fakeGuest();
    attachDebugger(guest);
    void ensureVirtualAuthenticator(guest);
    const removal = removeVirtualAuthenticator(guest);
    const rearm = ensureVirtualAuthenticator(guest);
    await removal;
    await rearm;
    expect(webAuthn().map((entry) => entry.method)).not.toContain('WebAuthn.disable');
    expect(hasVirtualAuthenticator(guest)).toBe(true);
  });
});

describe('passkey guard', () => {
  const projectId = 'project-1';
  const taskId = 'task-1';
  const partition = browserPartitionForOwner(projectId, taskId);

  it('marks an owner by partition, so a new guest on that jar is under agent control', () => {
    const { guest } = fakeGuest({ partition });
    const other = fakeGuest({ partition: browserPartitionForOwner(projectId, 'task-2') });
    expect(isUnderAgentControl(guest.session)).toBe(false);
    markAgentControl(projectId, taskId);
    expect(isUnderAgentControl(guest.session)).toBe(true);
    expect(isUnderAgentControl(other.guest.session)).toBe(false);
  });

  // A user loses the passkey cover on a Command Terminal's Browser surface: its owner key is not a
  // task id, so a mark keyed like a task's would name a jar no guest uses and its sign-in page would
  // open the OS dialog on an unattended run.
  it('marks a Command Terminal owner by the project\'s shared terminals jar, and a task ending leaves it', () => {
    const terminalOwner = commandTerminalBrowserOwner(projectId, 'slot-1');
    const terminalGuest = fakeGuest({ partition: browserPartitionForCommandTerminals(projectId) });
    const otherProjectGuest = fakeGuest({ partition: browserPartitionForCommandTerminals('project-2') });
    markAgentControl(projectId, terminalOwner);
    expect(isUnderAgentControl(terminalGuest.guest.session)).toBe(true);
    expect(isUnderAgentControl(otherProjectGuest.guest.session)).toBe(false);

    forgetAgentControl(projectId, taskId);
    expect(isUnderAgentControl(terminalGuest.guest.session)).toBe(true);
  });

  // A user loses another project's pane to the guard (or this project's to the OS dialog): the same
  // task id can exist in two projects, and only the partition tells them apart.
  it('keeps one task id in two projects apart', () => {
    const here = fakeGuest({ partition });
    const there = fakeGuest({ partition: browserPartitionForOwner('project-2', taskId) });
    markAgentControl(projectId, taskId);
    expect(isUnderAgentControl(here.guest.session)).toBe(true);
    expect(isUnderAgentControl(there.guest.session)).toBe(false);
    forgetAgentControl('project-2', taskId);
    expect(isUnderAgentControl(here.guest.session)).toBe(true);
  });

  it('ignores a mark with no project or owner', () => {
    markAgentControl(null, taskId);
    markAgentControl(projectId, null);
    expect(isUnderAgentControl(fakeGuest({ partition }).guest.session)).toBe(false);
  });

  it('armGuest attaches the debugger and installs the authenticator', async () => {
    const { guest, webAuthn } = fakeGuest({ partition });
    expect(await armGuest(guest, 'lane')).toBe(true);
    expect(webAuthn().map((entry) => entry.method)).toEqual(['WebAuthn.enable', 'WebAuthn.addVirtualAuthenticator']);
    expect(hoisted.reports).toEqual([]);
  });

  it('reports a refused install with a fixed error and an enum tag', async () => {
    const { guest } = fakeGuest({ partition, failing: ['WebAuthn.addVirtualAuthenticator'] });
    expect(await armGuest(guest, 'created')).toBe(false);
    expect(hoisted.reports).toHaveLength(1);
    expect((hoisted.reports[0].error as Error).name).toBe('VirtualAuthenticatorInstallFailed');
    expect(hoisted.reports[0].tags).toEqual({ surface: 'created' });
  });

  it('the person pressing in the page outside a drive releases the mark and disarms the guest', async () => {
    const { guest, webAuthn } = fakeGuest({ partition });
    markAgentControl(projectId, taskId);
    await armGuest(guest, 'drive');
    releaseAgentControl(guest);
    await vi.waitFor(() => expect(webAuthn().map((entry) => entry.method)).toContain('WebAuthn.disable'));
    expect(isUnderAgentControl(guest.session)).toBe(false);
  });

  it('an input event during a drive releases nothing', async () => {
    const { id, guest, webAuthn } = fakeGuest({ partition });
    markAgentControl(projectId, taskId);
    await armGuest(guest, 'drive');
    hoisted.driving.add(id);
    releaseAgentControl(guest);
    await Promise.resolve();
    expect(webAuthn().map((entry) => entry.method)).not.toContain('WebAuthn.disable');
    expect(isUnderAgentControl(guest.session)).toBe(true);
  });

  it('drops a task\'s mark when its work ends, so a later guest starts as a person\'s pane', () => {
    const { guest } = fakeGuest({ partition });
    markAgentControl(projectId, taskId);
    forgetAgentControl(projectId, taskId);
    expect(isUnderAgentControl(guest.session)).toBe(false);
  });

  it('looks a marked partition\'s session up once, not on every press', async () => {
    const lookups = vi.spyOn((await import('electron')).session, 'fromPartition');
    markAgentControl(projectId, taskId);
    const other = fakeGuest({ partition: browserPartitionForOwner(projectId, 'task-2') });
    for (let press = 0; press < 5; press += 1) releaseAgentControl(other.guest);
    expect(lookups).toHaveBeenCalledTimes(1);
    lookups.mockRestore();
  });

  it('a destroyed guest is neither armed nor released', async () => {
    const created = fakeGuest({ partition });
    created.destroy();
    expect(await armGuest(created.guest, 'created')).toBe(false);
    markAgentControl(projectId, taskId);
    releaseAgentControl(created.guest);
    expect(isUnderAgentControl(created.guest.session)).toBe(true);
    expect(created.webAuthn()).toEqual([]);
  });

  // A user loses the guarantee that forgetting one task's work never strips another task's guard
  // (its pane would reach the OS dialog again mid-run), or that a missing project id drops a mark.
  it('forgetAgentControl with no project id leaves the mark, and forgetting one task leaves another\'s', () => {
    const taskA = fakeGuest({ partition });
    const taskB = fakeGuest({ partition: browserPartitionForOwner(projectId, 'task-2') });
    markAgentControl(projectId, taskId);
    markAgentControl(projectId, 'task-2');

    forgetAgentControl(null, taskId);
    forgetAgentControl(undefined, taskId);
    expect(isUnderAgentControl(taskA.guest.session)).toBe(true);

    forgetAgentControl(projectId, taskId);
    expect(isUnderAgentControl(taskA.guest.session)).toBe(false);
    expect(isUnderAgentControl(taskB.guest.session)).toBe(true);
  });

  // A user loses a quiet failure: a guest that cannot attach CDP must not be reported as an install
  // defect nor sent WebAuthn commands, and the lane must still load.
  it('armGuest returns false, sends nothing and reports nothing when the debugger cannot attach', async () => {
    const { guest, webAuthn, attach } = fakeGuest({ partition, attachFails: true });
    expect(await armGuest(guest, 'lane')).toBe(false);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(webAuthn()).toEqual([]);
    expect(hoisted.reports).toEqual([]);
  });

  // A user loses a false defect report on every guest that closes mid-install (a pane closed or a
  // task moved while the agent was arming it).
  it.each([
    ['armGuest', async (guest: WebContents) => armGuest(guest, 'drive')],
    ['armAttachedGuest', async (guest: WebContents) => {
      attachDebugger(guest);
      return armAttachedGuest(guest, 'drive');
    }],
  ])('%s reports nothing when the guest is destroyed while the install is in flight and then fails', async (_name, arm) => {
    const { guest, destroy, release } = fakeGuest({ partition, held: [ADD] });
    const armed = arm(guest);
    await flush();
    destroy();
    release(ADD, 'reject');
    expect(await armed).toBe(false);
    expect(hoisted.reports).toEqual([]);
  });
});

describe('removeVirtualAuthenticator with an install in flight', () => {
  // A user loses their own passkey sign-in: a disable sent before the install's add lands is undone
  // by the add, leaving the person's pane on the virtual authenticator.
  it('waits for the install, then sends the disable, when nothing re-armed', async () => {
    const { guest, webAuthn, release } = fakeGuest({ held: [ADD] });
    attachDebugger(guest);
    void ensureVirtualAuthenticator(guest);
    const removal = removeVirtualAuthenticator(guest);
    await flush();
    expect(methodsOf(webAuthn())).toEqual(['WebAuthn.enable', ADD]);

    release(ADD, 'resolve');
    await removal;
    expect(methodsOf(webAuthn())).toEqual(['WebAuthn.enable', ADD, 'WebAuthn.disable']);
  });

  // A user loses nothing but a stray command on a dead debugger, so this pins only the early exit
  // after the wait.
  it('sends no disable when the guest is destroyed during the wait', async () => {
    const { guest, webAuthn, release, destroy } = fakeGuest({ held: [ADD] });
    attachDebugger(guest);
    void ensureVirtualAuthenticator(guest);
    const removal = removeVirtualAuthenticator(guest);
    await flush();
    destroy();
    release(ADD, 'resolve');
    await removal;
    expect(methodsOf(webAuthn())).toEqual(['WebAuthn.enable', ADD]);
  });

  // A user loses the agent's passkey cover mid-drive: a stale install settling must not clear the
  // re-armed install's state, or the next drive sees no authenticator and the dialog returns.
  it('keeps a re-armed install when the stale install fails, and a later removal still disables', async () => {
    const { guest, webAuthn, release } = fakeGuest({ held: [ADD] });
    attachDebugger(guest);
    void ensureVirtualAuthenticator(guest);
    const removal = removeVirtualAuthenticator(guest);
    const rearm = ensureVirtualAuthenticator(guest);
    await flush();

    release(ADD, 'reject');
    await removal;
    await flush();
    expect(hasVirtualAuthenticator(guest)).toBe(true);

    release(ADD, 'resolve');
    expect(await rearm).toBe(true);
    await flush();
    await removeVirtualAuthenticator(guest);
    expect(methodsOf(webAuthn())).toContain('WebAuthn.disable');
  });

  // A user loses the guarantee that a removal waits for the install that is really in flight: a
  // stale success marking the new install ready sends the disable ahead of its add.
  it('does not treat a pending re-armed install as ready when the stale install succeeds', async () => {
    const { guest, webAuthn, release } = fakeGuest({ held: [ADD] });
    attachDebugger(guest);
    void ensureVirtualAuthenticator(guest);
    const firstRemoval = removeVirtualAuthenticator(guest);
    void ensureVirtualAuthenticator(guest);
    await flush();

    release(ADD, 'resolve');
    await firstRemoval;
    await flush();

    const secondRemoval = removeVirtualAuthenticator(guest);
    expect(methodsOf(webAuthn()), 'the disable must wait for the second install').not.toContain('WebAuthn.disable');

    release(ADD, 'resolve');
    await secondRemoval;
    expect(methodsOf(webAuthn()).filter((method) => method === 'WebAuthn.disable')).toHaveLength(1);
  });

  // A user loses nothing visible: it pins the early exit so a closed guest is never sent a command.
  it('sends nothing to an armed guest that was destroyed before the call', async () => {
    const { guest, webAuthn, destroy } = fakeGuest();
    attachDebugger(guest);
    await ensureVirtualAuthenticator(guest);
    destroy();
    await removeVirtualAuthenticator(guest);
    expect(methodsOf(webAuthn())).toEqual(['WebAuthn.enable', ADD]);
  });
});
