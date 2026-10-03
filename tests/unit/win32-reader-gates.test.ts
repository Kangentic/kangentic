/**
 * The safety gates of the Windows task-process reader
 * (src/main/pty/process-tag/win32-reader.ts), against a fake Win32Api. No koffi
 * loads, so this runs on every OS and in CI's Linux unit tier.
 *
 * The gates pinned here:
 * - `scan` never opens a process outside the caller's Windows session, nor a
 *   pid at or below 4.
 * - `scan` opens PROCESS_VM_READ only on a same-session process whose token
 *   user is the caller's, and never when the caller's own token is unreadable.
 * - `kill` terminates only through a handle whose creation time still matches
 *   the scan's start key, and closes that handle on every path.
 * - Every handle a call opens is closed, including when a memory read fails or
 *   throws partway through the PEB walk.
 * - `describe` opens only a target that carries a tag (a start key alone is set
 *   before the user check, so it proves nothing about the owner).
 *
 * Each refusal is asserted next to a positive control (the open that the gate
 * does allow), so a fake that silently stopped answering cannot pass for free.
 * The one exception is the empty start key in `kill`, where the refusal is that
 * nothing is opened at all.
 */

import { describe, it, expect } from 'vitest';
import { Win32TaggedProcessReader } from '../../src/main/pty/process-tag/win32-reader';
import { TASK_PROCESS_TAG_ENV } from '../../src/main/pty/process-tag/task-process-tag';
import type { ProcessScan, ScannedProcess } from '../../src/main/pty/process-tag/process-scan';

/** The reader's injected API surface; the interface itself is not exported. */
type Win32Api = Awaited<ReturnType<NonNullable<ConstructorParameters<typeof Win32TaggedProcessReader>[0]>>>;
type ProcessEntry = Parameters<Win32Api['processFirst']>[1];

// Access rights as Windows defines them (winnt.h), not read back from the reader.
const PROCESS_TERMINATE = 0x0001;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const OWN_SESSION = 1;
const SERVICES_SESSION = 0;
/** The sub-authority of the caller's user SID; another user's differs. */
const OWN_SID = 1001;
const OTHER_SID = 2002;
const CREATION_BASE = 133_500_000_000_000_000n;
const CURRENT_PROCESS_HANDLE_ID = 1_000_000;
const WORKING_DIRECTORY = 'C:\\work\\project';

interface FakeHandle {
  id: number;
  pid: number;
}

interface FakeProcess {
  pid: number;
  ppid?: number;
  image?: string;
  session?: number;
  /** ProcessIdToSessionId reports failure for this pid. */
  sessionLookupFails?: boolean;
  sid?: number;
  /** The tag in the process's environment block; absent means the block holds none. */
  tag?: string | null;
  workingDirectory?: string;
  imagePath?: string;
  commandLine?: string;
  /** GetProcessTimes reports failure for this pid. */
  creationUnreadable?: boolean;
}

function creationOf(pid: number): bigint {
  return CREATION_BASE + BigInt(pid);
}

function addressesOf(pid: number) {
  const base = BigInt(pid) * 0x100000n;
  return {
    peb: base,
    parameters: base + 0x1000n,
    workingDirectoryText: base + 0x2000n,
    environmentBlock: base + 0x3000n,
    imageText: base + 0x4000n,
    commandText: base + 0x5000n,
  };
}

function unsigned64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value, 0);
  return buffer;
}

/** A UNICODE_STRING as the reader reads it: a 16-bit byte length, then the buffer pointer at offset 8. */
function unicodeStringHeader(byteLength: number, pointer: bigint): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt16LE(byteLength, 0);
  buffer.writeBigUInt64LE(pointer, 8);
  return buffer;
}

function handleOf(handle: unknown): FakeHandle {
  return handle as FakeHandle;
}

/**
 * An in-memory Win32: a process table, per-process memory laid out the way the
 * reader walks a 64-bit PEB, and a ledger of every open, close, and terminate.
 */
class FakeWin32 {
  readonly opens: Array<{ pid: number; access: number }> = [];
  /** Every handle the reader was given that it must close. */
  readonly createdHandleIds: number[] = [];
  readonly closedHandleIds: number[] = [];
  readonly terminatedHandleIds: number[] = [];
  readonly sessionLookups: number[] = [];
  readonly failingReads = new Set<string>();
  failedReads = 0;
  throwOnFailingRead = false;
  ownTokenReadable = true;

  private nextHandleId = 1;
  private snapshotCursor = 0;
  private readonly processes: FakeProcess[];
  private readonly byPid = new Map<number, FakeProcess>();
  private readonly memory = new Map<string, Buffer>();

  constructor(processes: readonly FakeProcess[]) {
    this.processes = [...processes];
    for (const fakeProcess of this.processes) {
      this.byPid.set(fakeProcess.pid, fakeProcess);
      this.layOutMemory(fakeProcess);
    }
  }

  readonly api: Win32Api = {
    koffi: { address: (handle: unknown) => BigInt(handleOf(handle).id) } as unknown as Win32Api['koffi'],
    processEntrySize: 568,
    createSnapshot: async () => this.create(0),
    processFirst: (_snapshot, entry) => {
      this.snapshotCursor = 0;
      return this.fillEntry(entry) ? 1 : 0;
    },
    processNext: (_snapshot, entry) => {
      this.snapshotCursor += 1;
      return this.fillEntry(entry) ? 1 : 0;
    },
    openProcess: (access, _inherit, pid) => {
      this.opens.push({ pid, access });
      return this.byPid.has(pid) ? this.create(pid) : null;
    },
    closeHandle: (handle) => {
      this.closedHandleIds.push(handleOf(handle).id);
      return 1;
    },
    getCurrentProcess: () => ({ id: CURRENT_PROCESS_HANDLE_ID, pid: process.pid }),
    processIdToSessionId: (pid, sessionOut) => {
      this.sessionLookups.push(pid);
      if (pid === process.pid) {
        sessionOut[0] = OWN_SESSION;
        return 1;
      }
      const fakeProcess = this.byPid.get(pid);
      if (!fakeProcess || fakeProcess.sessionLookupFails) return 0;
      sessionOut[0] = fakeProcess.session ?? OWN_SESSION;
      return 1;
    },
    isWow64Process: (_handle, wowOut) => {
      wowOut[0] = 0;
      return 1;
    },
    getProcessTimes: (handle, creation) => {
      const fakeProcess = this.byPid.get(handleOf(handle).pid);
      if (!fakeProcess || fakeProcess.creationUnreadable) return 0;
      creation[0] = creationOf(fakeProcess.pid);
      return 1;
    },
    readProcessMemory: (handle, address, buffer, size) => {
      const pid = handleOf(handle).pid;
      const key = `${pid}:${address}`;
      if (this.failingReads.has(key)) {
        this.failedReads += 1;
        if (this.throwOnFailingRead) throw new Error('access violation');
        return 0;
      }
      const region = this.memory.get(key);
      if (!region || region.length < size) return 0;
      region.copy(buffer, 0, 0, size);
      return 1;
    },
    terminateProcess: (handle) => {
      this.terminatedHandleIds.push(handleOf(handle).id);
      return 1;
    },
    openProcessToken: (processHandle, _access, tokenOut) => {
      const owner = handleOf(processHandle);
      if (owner.pid === process.pid && !this.ownTokenReadable) return 0;
      tokenOut[0] = this.create(owner.pid);
      return 1;
    },
    getTokenInformation: (token, _infoClass, buffer, _length, returnLength) => {
      const owner = handleOf(token).pid;
      const authority = owner === process.pid ? OWN_SID : (this.byPid.get(owner)?.sid ?? OWN_SID);
      // TOKEN_USER: 16 bytes of header, then the SID (revision, count, 6-byte authority, sub-authorities).
      buffer[16] = 1;
      buffer[17] = 1;
      buffer.set([0, 0, 0, 0, 0, 5], 18);
      buffer.writeUInt32LE(authority, 24);
      returnLength[0] = 28;
      return 1;
    },
    // 0 is STATUS_SUCCESS, unlike the BOOL calls around it.
    queryInformationProcess: (handle, infoClass, buffer) => {
      if (infoClass !== 0) return 1;
      buffer.writeBigUInt64LE(addressesOf(handleOf(handle).pid).peb, 8);
      return 0;
    },
    getLongPathName: () => 0,
    visibleWindowPids: () => new Set<number>(),
  };

  startKeyOf(pid: number): string {
    return creationOf(pid).toString();
  }

  /** The pids a handle was opened for, optionally only those opened with an access bit. */
  openedPids(requiredAccess = 0): number[] {
    return this.opens.filter((open) => (open.access & requiredAccess) === requiredAccess).map((open) => open.pid);
  }

  /** Every handle created but not closed. */
  leakedHandleIds(): number[] {
    return this.createdHandleIds.filter((id) => !this.closedHandleIds.includes(id));
  }

  /** The memory read for one pid's environment block fails (or throws). */
  failEnvironmentRead(pid: number): void {
    this.failingReads.add(`${pid}:${addressesOf(pid).environmentBlock}`);
  }

  private create(pid: number): FakeHandle {
    const handle: FakeHandle = { id: this.nextHandleId, pid };
    this.nextHandleId += 1;
    this.createdHandleIds.push(handle.id);
    return handle;
  }

  private fillEntry(entry: ProcessEntry): boolean {
    const row = this.processes[this.snapshotCursor];
    if (!row) return false;
    entry.th32ProcessID = row.pid;
    entry.th32ParentProcessID = row.ppid ?? 0;
    entry.szExeFile = row.image ?? 'tool.exe';
    return true;
  }

  private put(pid: number, address: bigint, contents: Buffer): void {
    this.memory.set(`${pid}:${address}`, contents);
  }

  private layOutMemory(fakeProcess: FakeProcess): void {
    const { pid } = fakeProcess;
    const addresses = addressesOf(pid);
    const workingDirectory = Buffer.from(fakeProcess.workingDirectory ?? WORKING_DIRECTORY, 'utf16le');
    const entries = ['PATH=C:\\Windows'];
    if (fakeProcess.tag) entries.push(`${TASK_PROCESS_TAG_ENV}=${fakeProcess.tag}`);
    const environment = Buffer.from(`${entries.join('\u0000')}\u0000\u0000`, 'utf16le');
    const imagePath = Buffer.from(fakeProcess.imagePath ?? 'C:\\Tools\\tool.exe', 'utf16le');
    const commandLine = Buffer.from(fakeProcess.commandLine ?? 'tool.exe', 'utf16le');

    this.put(pid, addresses.peb + 0x20n, unsigned64(addresses.parameters));
    this.put(pid, addresses.parameters + 0x38n, unicodeStringHeader(workingDirectory.length, addresses.workingDirectoryText));
    this.put(pid, addresses.workingDirectoryText, workingDirectory);
    this.put(pid, addresses.parameters + 0x80n, unsigned64(addresses.environmentBlock));
    this.put(pid, addresses.parameters + 0x3f0n, unsigned64(BigInt(environment.length)));
    this.put(pid, addresses.environmentBlock, environment);
    this.put(pid, addresses.parameters + 0x60n, unicodeStringHeader(imagePath.length, addresses.imageText));
    this.put(pid, addresses.imageText, imagePath);
    this.put(pid, addresses.parameters + 0x70n, unicodeStringHeader(commandLine.length, addresses.commandText));
    this.put(pid, addresses.commandText, commandLine);
  }
}

function readerFor(fake: FakeWin32): Win32TaggedProcessReader {
  return new Win32TaggedProcessReader(async () => fake.api);
}

function scanned(scan: ProcessScan, pid: number): ScannedProcess {
  const found = scan.processes.find((candidate) => candidate.pid === pid);
  if (!found) throw new Error(`pid ${pid} is missing from the scan`);
  return found;
}

function targetFor(fake: FakeWin32, pid: number, overrides: Partial<ScannedProcess> = {}): ScannedProcess {
  return { pid, ppid: 1, startKey: fake.startKeyOf(pid), startedAtMs: null, tagValue: TASK, workingDirectory: WORKING_DIRECTORY, ...overrides };
}

/** No handle left open, and none closed twice (a second close could hit a reused handle value). */
function expectEveryHandleClosedOnce(fake: FakeWin32): void {
  expect(fake.createdHandleIds.length).toBeGreaterThan(0);
  expect(fake.leakedHandleIds()).toEqual([]);
  expect(new Set(fake.closedHandleIds).size).toBe(fake.closedHandleIds.length);
}

describe('Win32TaggedProcessReader.scan: which processes are opened at all', () => {
  it('never opens a process in another Windows session, one whose session is unknown, or a pid at or below 4', async () => {
    const fake = new FakeWin32([
      // In the caller's session, so only the pid guard keeps these closed.
      { pid: 0, image: 'System Idle Process' },
      { pid: 4, image: 'System' },
      { pid: 300, session: SERVICES_SESSION },
      { pid: 310, sessionLookupFails: true },
      { pid: 400, tag: TASK },
    ]);
    const scan = await readerFor(fake).scan();

    // Positive control: the same-session process above 4 is opened.
    expect(fake.openedPids()).toContain(400);
    expect(fake.openedPids()).not.toContain(0);
    expect(fake.openedPids()).not.toContain(4);
    expect(fake.openedPids()).not.toContain(300);
    expect(fake.openedPids()).not.toContain(310);
    // They stay in the table, with no start key and no tag, so a kill refuses them.
    for (const pid of [0, 4, 300, 310]) {
      expect(scanned(scan, pid)).toMatchObject({ pid, startKey: '', tagValue: null });
    }
    expect(scanned(scan, 400)).toMatchObject({ startKey: fake.startKeyOf(400), tagValue: TASK });
    expectEveryHandleClosedOnce(fake);
  });
});

describe('Win32TaggedProcessReader.scan: who may be read with PROCESS_VM_READ', () => {
  it('never opens PROCESS_VM_READ on a same-session process owned by another user', async () => {
    const fake = new FakeWin32([
      { pid: 500, tag: TASK },
      // The tag is in its environment, so a read would show up as a non-null tagValue.
      { pid: 510, sid: OTHER_SID, tag: TASK },
    ]);
    const scan = await readerFor(fake).scan();

    // Positive controls: the other user's process was opened for its creation time and token,
    // and the caller's own process was opened with PROCESS_VM_READ and read.
    expect(fake.openedPids(PROCESS_QUERY_LIMITED_INFORMATION)).toContain(510);
    expect(fake.openedPids(PROCESS_VM_READ)).toContain(500);
    expect(scanned(scan, 500)).toMatchObject({ tagValue: TASK, workingDirectory: WORKING_DIRECTORY });

    expect(fake.openedPids(PROCESS_VM_READ)).not.toContain(510);
    const foreign = scanned(scan, 510);
    expect(foreign.tagValue).toBeNull();
    expect(foreign.startKey).toBe(fake.startKeyOf(510));
    expect(foreign.workingDirectory).toBeUndefined();
    expect(foreign.environmentUnreadable).toBeUndefined();
    expect(scan.unreadableCount).toBe(0);
    expectEveryHandleClosedOnce(fake);
  });

  it('opens PROCESS_VM_READ on nothing when the caller\'s own token cannot be read', async () => {
    const fake = new FakeWin32([{ pid: 500, tag: TASK }, { pid: 510, tag: TASK }]);
    fake.ownTokenReadable = false;
    const scan = await readerFor(fake).scan();

    // Positive control: both were still opened for the limited query.
    expect(fake.openedPids(PROCESS_QUERY_LIMITED_INFORMATION)).toEqual(expect.arrayContaining([500, 510]));
    expect(fake.openedPids(PROCESS_VM_READ)).toEqual([]);
    expect(scanned(scan, 500).tagValue).toBeNull();
    expect(scanned(scan, 510).tagValue).toBeNull();
    expectEveryHandleClosedOnce(fake);
  });
});

describe('Win32TaggedProcessReader.scan: handles close when a read goes wrong', () => {
  it('closes every handle when a memory read fails partway through the PEB walk', async () => {
    const fake = new FakeWin32([{ pid: 600, tag: TASK }]);
    // The parameters pointer and the working directory read fine; the environment block does not.
    fake.failEnvironmentRead(600);
    const scan = await readerFor(fake).scan();

    // Positive controls: the failure fired and was counted, so the failing path really ran.
    expect(fake.failedReads).toBe(1);
    expect(scan.unreadableCount).toBe(1);
    expect(scanned(scan, 600)).toMatchObject({ tagValue: null, environmentUnreadable: true, workingDirectory: WORKING_DIRECTORY });
    expect(fake.openedPids(PROCESS_VM_READ)).toEqual([600]);
    expectEveryHandleClosedOnce(fake);
  });

  it('closes every handle when a memory read throws', async () => {
    const fake = new FakeWin32([{ pid: 600, tag: TASK }]);
    fake.failEnvironmentRead(600);
    fake.throwOnFailingRead = true;
    // Whether scan rejects or recovers is not the contract here; leaking a handle is.
    await readerFor(fake).scan().catch(() => undefined);

    expect(fake.failedReads).toBe(1);
    expect(fake.openedPids(PROCESS_VM_READ)).toEqual([600]);
    expectEveryHandleClosedOnce(fake);
  });
});

describe('Win32TaggedProcessReader.kill', () => {
  it('terminates through the handle it verified, and closes it, when the creation time matches', async () => {
    const fake = new FakeWin32([{ pid: 700 }]);
    const killed = await readerFor(fake).kill(targetFor(fake, 700), 'force');

    expect(killed).toBe(true);
    expect(fake.opens).toEqual([{ pid: 700, access: PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION }]);
    expect(fake.terminatedHandleIds).toHaveLength(1);
    expect(fake.terminatedHandleIds[0]).toBe(fake.createdHandleIds[0]);
    expectEveryHandleClosedOnce(fake);
  });

  it('refuses and closes the handle when the pid now names a process created at another time', async () => {
    const fake = new FakeWin32([{ pid: 700 }]);
    const staleKey = (creationOf(700) - 1n).toString();
    const killed = await readerFor(fake).kill(targetFor(fake, 700, { startKey: staleKey }), 'force');

    expect(killed).toBe(false);
    // Positive control: the handle was opened for the terminate, so the refusal is the creation check.
    expect(fake.openedPids(PROCESS_TERMINATE)).toEqual([700]);
    expect(fake.terminatedHandleIds).toEqual([]);
    expectEveryHandleClosedOnce(fake);
  });

  it('refuses and closes the handle when the creation time cannot be read', async () => {
    const fake = new FakeWin32([{ pid: 700, creationUnreadable: true }]);
    const killed = await readerFor(fake).kill(targetFor(fake, 700), 'graceful');

    expect(killed).toBe(false);
    expect(fake.openedPids(PROCESS_TERMINATE)).toEqual([700]);
    expect(fake.terminatedHandleIds).toEqual([]);
    expectEveryHandleClosedOnce(fake);
  });

  it('opens nothing for a target the scan gave no start key', async () => {
    const fake = new FakeWin32([{ pid: 700 }]);
    const killed = await readerFor(fake).kill(targetFor(fake, 700, { startKey: '' }), 'force');

    expect(killed).toBe(false);
    expect(fake.opens).toEqual([]);
    expect(fake.terminatedHandleIds).toEqual([]);
  });
});

describe('Win32TaggedProcessReader.describe', () => {
  const RUNNING = { imagePath: 'C:\\Tools\\ping.exe', commandLine: 'ping.exe -t host' };

  it('opens a tagged target with a matching start key, and never an untagged one', async () => {
    const fake = new FakeWin32([{ pid: 800, ...RUNNING }, { pid: 810, ...RUNNING }]);
    // 800 has a start key that matches its process, but no tag: scan sets the key before it checks the owner.
    const labels = await readerFor(fake).describe([
      targetFor(fake, 800, { tagValue: null }),
      targetFor(fake, 810),
    ]);

    expect(fake.openedPids()).toEqual([810]);
    expect(fake.openedPids(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ)).toEqual([810]);
    expect([...labels]).toEqual([[810, 'ping']]);
    expectEveryHandleClosedOnce(fake);
  });

  it('closes the handle and gives no label when the tagged target is no longer the process the scan saw', async () => {
    const fake = new FakeWin32([{ pid: 810, ...RUNNING }]);
    const labels = await readerFor(fake).describe([targetFor(fake, 810, { startKey: (creationOf(810) + 1n).toString() })]);

    // Positive control: it was opened, so the missing label is the creation check.
    expect(fake.openedPids(PROCESS_VM_READ)).toEqual([810]);
    expect(labels.size).toBe(0);
    expectEveryHandleClosedOnce(fake);
  });
});
