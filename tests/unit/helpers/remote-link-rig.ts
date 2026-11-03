/**
 * Shared pieces for the #913 link tests: a fake node-pty, a real `HelperServer` around the real
 * `PtyHostCore`, and a dial function that joins a link to a helper with an in-memory pair the way a
 * socket would (ending one end ends the other, which `duplexPair` alone does not do).
 */
import { vi } from 'vitest';
import { duplexPair, type Duplex } from 'node:stream';
import type * as nodePty from 'node-pty';
import { HelperServer } from '../../../src/main/remote/helper/helper-server';
import type { PtyHostSpawnParams } from '../../../src/main/pty/host/protocol';

export interface FakePty {
  pty: nodePty.IPty;
  feed(data: string): void;
  exit(exitCode: number): void;
  kill: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
}

export function createFakePty(pid: number): FakePty {
  let dataListener: ((data: string) => void) | null = null;
  let exitListener: ((event: { exitCode: number }) => void) | null = null;
  const kill = vi.fn();
  const write = vi.fn();
  const pty = {
    pid,
    cols: 120,
    rows: 30,
    onData: (listener: (data: string) => void) => {
      dataListener = listener;
      return { dispose: () => { dataListener = null; } };
    },
    onExit: (listener: (event: { exitCode: number }) => void) => {
      exitListener = listener;
      return { dispose: () => { exitListener = null; } };
    },
    write,
    resize: vi.fn(),
    kill,
    pause: vi.fn(),
    resume: vi.fn(),
  } as unknown as nodePty.IPty;
  return { pty, feed: (data) => dataListener?.(data), exit: (exitCode) => exitListener?.({ exitCode }), kill, write };
}

export function spawnParams(sessionId: string, taskId: string, hostId?: string): Omit<PtyHostSpawnParams, 'ptyId' | 'sentAtMs'> {
  return {
    sessionId,
    projectId: 'project-1',
    agentName: null,
    transient: false,
    file: 'mock-agent',
    args: [],
    cwd: '/home/dev/project',
    env: {},
    cols: 120,
    rows: 30,
    carryoverFromSessionId: null,
    agentSessionIdKnown: false,
    taskId,
    hostId,
  };
}

export interface HelperRig {
  helper: HelperServer;
  fakes: FakePty[];
  /** node-pty's spawn as the helper called it: the file, the args and the options each PTY got. */
  spawnPty: ReturnType<typeof vi.fn>;
  /** The link's end of every connection dialed to this helper, oldest first. */
  linkStreams: Duplex[];
}

export interface HelperRigOptions {
  firstPid?: number;
  endpoint?: ConstructorParameters<typeof HelperServer>[0]['endpoint'];
  homeDirectory?: string;
  baseEnv?: NodeJS.ProcessEnv;
}

/** A helper whose node-pty hands out the queued fakes in order. */
export function makeHelperRig(fakeCount = 1, options: HelperRigOptions = {}): HelperRig {
  const fakes = Array.from({ length: fakeCount }, (_, index) => createFakePty((options.firstPid ?? 4242) + index));
  const queue = [...fakes];
  const spawnPty = vi.fn(() => {
    const next = queue.shift();
    if (!next) throw new Error('no fake PTY queued');
    return next.pty;
  });
  const helper = new HelperServer({
    homeDirectory: options.homeDirectory,
    baseEnv: options.baseEnv,
    coreDeps: {
      resolveAgent: () => undefined,
      transcriptSinkFor: () => null,
      coalesceMs: 0,
      platform: 'linux',
      spawnPty: spawnPty as unknown as typeof nodePty.spawn,
    },
    endpoint: options.endpoint,
  });
  return { helper, fakes, spawnPty, linkStreams: [] };
}

/** Join a link to the helper. The returned stream is the link's end. */
export function dialHelper(rig: Pick<HelperRig, 'helper' | 'linkStreams'>): Duplex {
  const [linkSide, helperSide] = duplexPair();
  linkSide.on('close', () => helperSide.destroy());
  helperSide.on('close', () => linkSide.destroy());
  rig.helper.accept(helperSide);
  rig.linkStreams.push(linkSide);
  return linkSide;
}

export async function settle(milliseconds = 60): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}
