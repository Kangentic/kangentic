/**
 * The safety gates of the Windows task-process reader
 * (src/main/pty/process-tag/win32-reader.ts), against a fake Win32Api. No koffi
 * loads, so this runs on every OS and in CI's Linux unit tier.
 *
 * The gates pinned here:
 * - `scan` never opens a process outside the caller's Windows session, nor a
 *   pid at or below 4, and opens none at all when the caller's own session
 *   cannot be read (it would otherwise compare against session 0, where
 *   services run).
 * - `scan` opens PROCESS_VM_READ only on a same-session process whose token
 *   user is the caller's, and never when the caller's own token is unreadable
 *   (it will not open, or opens and its user cannot be read or is not a SID),
 *   which fails the scan and still closes the token it opened.
 * - `kill` terminates only through a handle whose creation time still matches
 *   the scan's start key, and closes that handle on every path.
 * - Every handle a call opens is closed, including when a memory read fails or
 *   throws partway through the PEB walk.
 * - `describe` opens only a target that carries a tag (a start key alone is set
 *   before the user check, so it proves nothing about the owner).
 * - A 32-bit (WOW64) process is read through its 32-bit PEB, whose offsets the
 *   fake takes from Windows' own layout, not from the reader. When that walk
 *   fails, the reader falls back to the native PEB and still closes every handle.
 * - `scan` marks a process with a visible window `visible-app` (ahead of its
 *   image name), and a `conhost.exe` or `OpenConsole.exe` row `console-host`.
 * - An environment read stops at 1 MiB however large a size the PEB claims,
 *   and a working directory longer than any Windows path is never read.
 * - An 8.3 working directory is expanded to its long form, and kept short
 *   when the expansion fails.
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
// NtQueryInformationProcess classes (winternl.h, and 26 from the public symbols).
const PROCESS_BASIC_INFORMATION_CLASS = 0;
const PROCESS_WOW64_INFORMATION_CLASS = 26;

const TASK = '7a1f2c3d-4b5e-4f60-8a71-92b3c4d5e6f7';
const OWN_SESSION = 1;
const SERVICES_SESSION = 0;
/** The sub-authority of the caller's user SID; another user's differs. */
const OWN_SID = 1001;
const OTHER_SID = 2002;
const CREATION_BASE = 133_500_000_000_000_000n;
const CURRENT_PROCESS_HANDLE_ID = 1_000_000;
const WORKING_DIRECTORY = 'C:\\work\\project';

type OwnTokenFault = 'query' | 'revision' | 'truncated' | 'overrun' | 'too-many-sub-authorities';

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
  /** A 32-bit process under WOW64: only its 32-bit PEB is laid out, so nothing reads through the 64-bit one. */
  wow64?: boolean;
  /**
   * A 32-bit process under WOW64 whose 32-bit PEB cannot be walked, with the
   * native PEB laid out instead (`wow64` stays off, which is what lays it out).
   * `query`: ProcessWow64Information fails. `memory`: it answers a 32-bit PEB
   * address that holds nothing readable.
   */
  wow64WalkFails?: 'query' | 'memory';
  /** The process owns a visible top-level window, as the reader's window enumeration reports it. */
  visible?: boolean;
  /** The EnvironmentSize its PEB claims, when not the block's real length. */
  claimedEnvironmentSize?: number;
  /** The byte length its CurrentDirectory claims, when not the text's real length. */
  claimedWorkingDirectoryLength?: number;
}

function creationOf(pid: number): bigint {
  return CREATION_BASE + BigInt(pid);
}

/** Per-process addresses; every one stays under 4 GB for pids below 4096, so a 32-bit PEB can point at it. */
function addressesOf(pid: number) {
  const base = BigInt(pid) * 0x100000n;
  return {
    peb: base,
    parameters: base + 0x1000n,
    workingDirectoryText: base + 0x2000n,
    environmentBlock: base + 0x3000n,
    imageText: base + 0x4000n,
    commandText: base + 0x5000n,
    peb32: base + 0x8000n,
    parameters32: base + 0x9000n,
  };
}

function unsigned64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value, 0);
  return buffer;
}

function unsigned32(value: bigint | number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(Number(value), 0);
  return buffer;
}

/** A UNICODE_STRING as the reader reads it: a 16-bit byte length, then the buffer pointer at offset 8. */
function unicodeStringHeader(byteLength: number, pointer: bigint): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeUInt16LE(byteLength, 0);
  buffer.writeBigUInt64LE(pointer, 8);
  return buffer;
}

/** A UNICODE_STRING32: a 16-bit byte length, a 16-bit maximum, then a 32-bit buffer pointer at offset 4. */
function unicodeString32Header(byteLength: number, pointer: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt16LE(byteLength, 0);
  buffer.writeUInt16LE(byteLength, 2);
  buffer.writeUInt32LE(Number(pointer), 4);
  return buffer;
}

/** The longest a fake region grows, so a claimed size of many megabytes stays cheap. */
const MAX_FAKE_REGION_BYTES = 2 * 1024 * 1024;
/** The reader's cap on an environment read, as a number this test states rather than imports. */
const ENVIRONMENT_READ_CAP_BYTES = 1024 * 1024;

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
  /** Every ReadProcessMemory call, in order. */
  readonly reads: Array<{ pid: number; address: bigint; size: number }> = [];
  /** Every NtQueryInformationProcess call, in order. */
  readonly processInformationQueries: Array<{ pid: number; infoClass: number }> = [];
  /** Every GetLongPathNameW call's input. */
  readonly longPathLookups: string[] = [];
  /** What GetLongPathNameW answers for a short path; anything else fails. */
  readonly longPaths = new Map<string, string>();
  readonly failingReads = new Set<string>();
  failedReads = 0;
  throwOnFailingRead = false;
  ownTokenReadable = true;
  /**
   * The caller's own token opens, but reading its user fails or comes back
   * malformed (other processes' tokens are never affected). `query`:
   * GetTokenInformation reports failure, with a valid SID already in the
   * buffer so nothing but its result shows the failure. The rest are TOKEN_USER buffers the
   * reader must refuse: a SID revision other than 1, a returned length too
   * short to hold a SID header, a sub-authority count that overruns the
   * returned length, and a count past the 15 a SID can carry.
   */
  ownTokenFault: OwnTokenFault | null = null;
  /** ProcessIdToSessionId reports failure for the caller's own pid. */
  ownSessionLookupFails = false;

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
        if (this.ownSessionLookupFails) return 0;
        sessionOut[0] = OWN_SESSION;
        return 1;
      }
      const fakeProcess = this.byPid.get(pid);
      if (!fakeProcess || fakeProcess.sessionLookupFails) return 0;
      sessionOut[0] = fakeProcess.session ?? OWN_SESSION;
      return 1;
    },
    isWow64Process: (handle, wowOut) => {
      const fakeProcess = this.byPid.get(handleOf(handle).pid);
      wowOut[0] = (fakeProcess?.wow64 || fakeProcess?.wow64WalkFails) ? 1 : 0;
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
      this.reads.push({ pid, address, size });
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
      const ownerIsCaller = owner === process.pid;
      const authority = ownerIsCaller ? OWN_SID : (this.byPid.get(owner)?.sid ?? OWN_SID);
      // TOKEN_USER: 16 bytes of header, then the SID (revision, count, 6-byte authority, sub-authorities).
      buffer[16] = 1;
      buffer[17] = 1;
      buffer.set([0, 0, 0, 0, 0, 5], 18);
      buffer.writeUInt32LE(authority, 24);
      returnLength[0] = 28;
      if (ownerIsCaller) {
        if (this.ownTokenFault === 'revision') buffer[16] = 2;
        // Under 16 + 8 bytes, so not even a SID with no sub-authorities fits.
        if (this.ownTokenFault === 'truncated') returnLength[0] = 20;
        // Claims 5 sub-authorities (44 bytes of TOKEN_USER) in the 28 it returns.
        if (this.ownTokenFault === 'overrun') buffer[17] = 5;
        // 16 sub-authorities fit the 100 bytes returned, so only the count itself is wrong.
        if (this.ownTokenFault === 'too-many-sub-authorities') {
          buffer[17] = 16;
          returnLength[0] = 100;
        }
        // Reports failure after the buffer holds a valid SID, so only the call's own result says it failed.
        if (this.ownTokenFault === 'query') return 0;
      }
      return 1;
    },
    // 0 is STATUS_SUCCESS, unlike the BOOL calls around it. Class 0 is
    // ProcessBasicInformation (PebBaseAddress at offset 8); class 26 is
    // ProcessWow64Information (the 32-bit PEB's address, 0 for a 64-bit process).
    queryInformationProcess: (handle, infoClass, buffer) => {
      const pid = handleOf(handle).pid;
      this.processInformationQueries.push({ pid, infoClass });
      const fakeProcess = this.byPid.get(pid);
      if (infoClass === 0) {
        buffer.writeBigUInt64LE(addressesOf(pid).peb, 8);
        return 0;
      }
      if (infoClass === 26) {
        if (fakeProcess?.wow64WalkFails === 'query') return 1;
        buffer.writeBigUInt64LE((fakeProcess?.wow64 || fakeProcess?.wow64WalkFails) ? addressesOf(pid).peb32 : 0n, 0);
        return 0;
      }
      return 1;
    },
    getLongPathName: (shortPath, buffer, characters) => {
      this.longPathLookups.push(shortPath);
      const long = this.longPaths.get(shortPath);
      if (!long) return 0;
      // Too small a buffer answers the size it needs, counting the terminator.
      if (long.length + 1 > characters) return long.length + 1;
      buffer.write(`${long}\u0000`, 0, 'utf16le');
      return long.length;
    },
    visibleWindowPids: () => new Set(this.processes.filter((fakeProcess) => fakeProcess.visible).map((fakeProcess) => fakeProcess.pid)),
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
    const block = Buffer.from(`${entries.join('\u0000')}\u0000\u0000`, 'utf16le');
    const environmentSize = fakeProcess.claimedEnvironmentSize ?? block.length;
    // A region as long as the claim (up to the fake's limit), so a read the
    // reader did not cap would ask for more than exists and fail.
    const environment = Buffer.concat([block, Buffer.alloc(Math.max(0, Math.min(environmentSize, MAX_FAKE_REGION_BYTES) - block.length))]);
    const workingDirectoryLength = fakeProcess.claimedWorkingDirectoryLength ?? workingDirectory.length;
    const imagePath = Buffer.from(fakeProcess.imagePath ?? 'C:\\Tools\\tool.exe', 'utf16le');
    const commandLine = Buffer.from(fakeProcess.commandLine ?? 'tool.exe', 'utf16le');
    this.put(pid, addresses.workingDirectoryText, workingDirectory);
    this.put(pid, addresses.environmentBlock, environment);
    this.put(pid, addresses.imageText, imagePath);
    this.put(pid, addresses.commandText, commandLine);

    if (fakeProcess.wow64) {
      // PEB32.ProcessParameters at 0x10, then RTL_USER_PROCESS_PARAMETERS32 as
      // Windows lays it out: CurrentDirectory.DosPath 0x24, ImagePathName 0x38,
      // CommandLine 0x40, Environment 0x48, EnvironmentSize 0x290.
      this.put(pid, addresses.peb32 + 0x10n, unsigned32(addresses.parameters32));
      this.put(pid, addresses.parameters32 + 0x24n, unicodeString32Header(workingDirectoryLength, addresses.workingDirectoryText));
      this.put(pid, addresses.parameters32 + 0x38n, unicodeString32Header(imagePath.length, addresses.imageText));
      this.put(pid, addresses.parameters32 + 0x40n, unicodeString32Header(commandLine.length, addresses.commandText));
      this.put(pid, addresses.parameters32 + 0x48n, unsigned32(addresses.environmentBlock));
      this.put(pid, addresses.parameters32 + 0x290n, unsigned32(environmentSize));
      return;
    }
    // PEB.ProcessParameters at 0x20, then RTL_USER_PROCESS_PARAMETERS:
    // CurrentDirectory.DosPath 0x38, ImagePathName 0x60, CommandLine 0x70,
    // Environment 0x80, EnvironmentSize 0x3f0.
    this.put(pid, addresses.peb + 0x20n, unsigned64(addresses.parameters));
    this.put(pid, addresses.parameters + 0x38n, unicodeStringHeader(workingDirectoryLength, addresses.workingDirectoryText));
    this.put(pid, addresses.parameters + 0x80n, unsigned64(addresses.environmentBlock));
    this.put(pid, addresses.parameters + 0x3f0n, unsigned64(BigInt(environmentSize)));
    this.put(pid, addresses.parameters + 0x60n, unicodeStringHeader(imagePath.length, addresses.imageText));
    this.put(pid, addresses.parameters + 0x70n, unicodeStringHeader(commandLine.length, addresses.commandText));
  }

  /** The sizes of every read at one pid's environment block. */
  environmentReadSizes(pid: number): number[] {
    const address = addressesOf(pid).environmentBlock;
    return this.reads.filter((read) => read.pid === pid && read.address === address).map((read) => read.size);
  }

  /** Whether anything read one pid's working-directory text. */
  readWorkingDirectoryText(pid: number): boolean {
    const address = addressesOf(pid).workingDirectoryText;
    return this.reads.some((read) => read.pid === pid && read.address === address);
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

  it('fails the scan, opening no process, when its own session cannot be read, and never takes session 0 for its own', async () => {
    // Session 0 is where services run, and what the gate would compare against with the lookup's answer left at 0.
    const table: FakeProcess[] = [
      { pid: 300, session: SERVICES_SESSION, tag: TASK },
      { pid: 400, tag: TASK },
    ];

    // Positive control: with the lookup answering, the caller's own session's process is opened and read.
    const control = new FakeWin32(table);
    const controlScan = await readerFor(control).scan();
    expect(control.openedPids()).toContain(400);
    expect(control.openedPids()).not.toContain(300);
    expect(scanned(controlScan, 400).tagValue).toBe(TASK);

    const fake = new FakeWin32(table);
    fake.ownSessionLookupFails = true;
    // A scan that could see no process would read as clean; it fails, so the reap reports it.
    await expect(readerFor(fake).scan()).rejects.toThrow('could not read its own session');

    // The lookup was asked, so the empty ledger is the gate and not a scan that never ran.
    expect(fake.sessionLookups).toContain(process.pid);
    expect(fake.opens).toEqual([]);
    // It fails before the process snapshot too, so no handle was ever created to leak.
    expect(fake.createdHandleIds).toEqual([]);
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

  it('fails the scan, opening no process, when the caller\'s own token cannot be read', async () => {
    const table: FakeProcess[] = [{ pid: 500, tag: TASK }, { pid: 510, tag: TASK }];

    // Positive control: with its own token readable, the caller's processes are opened and read.
    const control = new FakeWin32(table);
    const controlScan = await readerFor(control).scan();
    expect(control.openedPids(PROCESS_VM_READ)).toEqual(expect.arrayContaining([500, 510]));
    expect(scanned(controlScan, 500).tagValue).toBe(TASK);

    const fake = new FakeWin32(table);
    fake.ownTokenReadable = false;
    // No process could be told apart as the caller's, so the scan would read as clean; it fails instead.
    await expect(readerFor(fake).scan()).rejects.toThrow('could not read its own user');
    expect(fake.opens).toEqual([]);
    expect(fake.createdHandleIds).toEqual([]);
  });

  // The other two ways the caller's own user comes back null: its token OPENS,
  // then GetTokenInformation fails, or the TOKEN_USER it fills is not a SID.
  it.each(['query', 'revision', 'truncated', 'overrun', 'too-many-sub-authorities'] as const)(
    'fails the scan, opening no process and closing the token it did open, when the caller\'s own token user is unreadable (%s)',
    async (fault) => {
      const table: FakeProcess[] = [{ pid: 500, tag: TASK }, { pid: 510, tag: TASK }];

      // Positive control: the same table with a well-formed token user is opened and read.
      const control = new FakeWin32(table);
      const controlScan = await readerFor(control).scan();
      expect(control.openedPids(PROCESS_VM_READ)).toEqual(expect.arrayContaining([500, 510]));
      expect(scanned(controlScan, 500).tagValue).toBe(TASK);

      const fake = new FakeWin32(table);
      fake.ownTokenFault = fault;
      // Without the caller's user no process could be told apart as its own, so the scan would read as clean.
      await expect(readerFor(fake).scan()).rejects.toThrow('could not read its own user');
      expect(fake.opens).toEqual([]);
      // Unlike an unopenable token, this one was created: it is the call's only handle, and it was closed.
      expect(fake.createdHandleIds).toHaveLength(1);
      expectEveryHandleClosedOnce(fake);
    },
  );
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

  it('rejects the scan, and closes every handle, when a memory read throws', async () => {
    const fake = new FakeWin32([{ pid: 600, tag: TASK }]);
    fake.failEnvironmentRead(600);
    fake.throwOnFailingRead = true;
    // A throw is not a failed read: the scan does not turn it into an unreadable process, it fails.
    await expect(readerFor(fake).scan()).rejects.toThrow('access violation');

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

describe('Win32TaggedProcessReader: a 32-bit (WOW64) process', () => {
  it('reads the tag and working directory through the 32-bit PEB', async () => {
    const fake = new FakeWin32([{ pid: 900, wow64: true, tag: TASK, workingDirectory: 'C:\\work\\x86' }]);
    const scan = await readerFor(fake).scan();

    expect(scanned(scan, 900)).toMatchObject({ tagValue: TASK, workingDirectory: 'C:\\work\\x86' });
    expect(scanned(scan, 900).environmentUnreadable).toBeUndefined();
    expect(scan.unreadableCount).toBe(0);
    expectEveryHandleClosedOnce(fake);
  });

  it('labels it from the 32-bit command line', async () => {
    const fake = new FakeWin32([{ pid: 910, wow64: true, tag: TASK, imagePath: 'C:\\Windows\\SysWOW64\\ping.exe', commandLine: 'ping.exe -n 300 127.0.0.1' }]);
    const labels = await readerFor(fake).describe([targetFor(fake, 910)]);

    expect([...labels]).toEqual([[910, 'ping']]);
    expectEveryHandleClosedOnce(fake);
  });

  it.each(['query', 'memory'] as const)('falls back to the native PEB, and closes every handle, when the 32-bit walk fails at its %s step', async (failure) => {
    const fake = new FakeWin32([{ pid: 990, wow64WalkFails: failure, tag: TASK, workingDirectory: 'C:\\work\\native' }]);
    const scan = await readerFor(fake).scan();

    // Positive controls: the 32-bit PEB was asked for first and the native one second, and the
    // native PEB's parameters pointer was read, so the tag below came through the fallback.
    expect(fake.processInformationQueries.filter((query) => query.pid === 990).map((query) => query.infoClass))
      .toEqual([PROCESS_WOW64_INFORMATION_CLASS, PROCESS_BASIC_INFORMATION_CLASS]);
    expect(fake.reads.some((read) => read.pid === 990 && read.address === addressesOf(990).peb + 0x20n)).toBe(true);
    expect(fake.openedPids(PROCESS_VM_READ)).toEqual([990]);

    expect(scanned(scan, 990)).toMatchObject({ tagValue: TASK, workingDirectory: 'C:\\work\\native' });
    expect(scanned(scan, 990).environmentUnreadable).toBeUndefined();
    expect(scan.unreadableCount).toBe(0);
    expectEveryHandleClosedOnce(fake);
  });
});

describe('Win32TaggedProcessReader.scan: the role of a process the reap must not read as shared', () => {
  it('marks a visible window and a console host, lets the window win, and marks nothing else', async () => {
    const fake = new FakeWin32([
      { pid: 1000, image: 'chrome.exe', visible: true },
      { pid: 1010, image: 'conhost.exe' },
      // The mixed case is what the image match has to fold, since the set holds lower case.
      { pid: 1020, image: 'OpenConsole.exe' },
      // A console host that owns a visible window is reported as the window, whichever check runs first.
      { pid: 1030, image: 'conhost.exe', visible: true },
      { pid: 1040, image: 'node.exe' },
    ]);
    const scan = await readerFor(fake).scan();

    expect(scanned(scan, 1000).role).toBe('visible-app');
    expect(scanned(scan, 1010).role).toBe('console-host');
    expect(scanned(scan, 1020).role).toBe('console-host');
    expect(scanned(scan, 1030).role).toBe('visible-app');
    expect(scanned(scan, 1040).role).toBeUndefined();
    expectEveryHandleClosedOnce(fake);
  });
});

describe('Win32TaggedProcessReader.scan: size caps', () => {
  it('reads at most 1 MiB of an environment whose size claims more, still finds the tag, and closes the handle', async () => {
    const fake = new FakeWin32([{ pid: 920, tag: TASK, claimedEnvironmentSize: 50 * 1024 * 1024 }]);
    const scan = await readerFor(fake).scan();

    expect(fake.environmentReadSizes(920)).toEqual([ENVIRONMENT_READ_CAP_BYTES]);
    expect(scanned(scan, 920).tagValue).toBe(TASK);
    expectEveryHandleClosedOnce(fake);
  });

  it('caps a 32-bit process\'s environment read the same way', async () => {
    const fake = new FakeWin32([{ pid: 930, wow64: true, tag: TASK, claimedEnvironmentSize: 0xFFFFFFF0 }]);
    const scan = await readerFor(fake).scan();

    expect(fake.environmentReadSizes(930)).toEqual([ENVIRONMENT_READ_CAP_BYTES]);
    expect(scanned(scan, 930).tagValue).toBe(TASK);
    expectEveryHandleClosedOnce(fake);
  });

  it('never reads a working directory whose length is past the longest Windows path, and still reads the tag', async () => {
    const fake = new FakeWin32([{ pid: 940, tag: TASK, claimedWorkingDirectoryLength: 65535 }, { pid: 950, tag: TASK }]);
    const scan = await readerFor(fake).scan();

    // Positive control: an ordinary process's directory text is read.
    expect(fake.readWorkingDirectoryText(950)).toBe(true);
    expect(fake.readWorkingDirectoryText(940)).toBe(false);
    expect(scanned(scan, 940)).toMatchObject({ tagValue: TASK, workingDirectory: null });
    expectEveryHandleClosedOnce(fake);
  });
});

describe('Win32TaggedProcessReader.scan: an 8.3 working directory', () => {
  const SHORT = 'C:\\Users\\RUNNER~1\\work';
  const LONG = 'C:\\Users\\runneradmin\\work';

  it('expands it to its long form, which is the form a task directory is compared in', async () => {
    const fake = new FakeWin32([{ pid: 960, tag: TASK, workingDirectory: SHORT }]);
    fake.longPaths.set(SHORT, LONG);
    const scan = await readerFor(fake).scan();

    expect(fake.longPathLookups).toEqual([SHORT]);
    expect(scanned(scan, 960).workingDirectory).toBe(LONG);
    expectEveryHandleClosedOnce(fake);
  });

  it('keeps the short form when the expansion fails, and never asks for a path with no tilde', async () => {
    const fake = new FakeWin32([{ pid: 970, tag: TASK, workingDirectory: SHORT }, { pid: 980, tag: TASK }]);
    const scan = await readerFor(fake).scan();

    expect(fake.longPathLookups).toEqual([SHORT]);
    expect(scanned(scan, 970).workingDirectory).toBe(SHORT);
    expect(scanned(scan, 980).workingDirectory).toBe(WORKING_DIRECTORY);
  });
});
