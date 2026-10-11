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
 *   Only a tagged process or one below it gets the window role, never an
 *   ancestor (Windows Terminal, whose tabs' shells are its children), and a
 *   zero-area window (the pseudo console window Terminal shows for each tab's
 *   shell) is no visible app; a minimized one is. Fed to the real plan, a
 *   Terminal tab's processes are reaped. `windowSize` and
 *   `userVisibleWindowPids`, which decide "with area", are pinned directly too:
 *   one zero dimension is no area, and an unreadable rect is no area.
 * - An environment read stops at 1 MiB however large a size the PEB claims,
 *   and a working directory longer than any Windows path is never read.
 * - An 8.3 working directory is expanded to its long form, and kept short
 *   when the expansion fails.
 * - `connections` reads the TCP table (both families, owner pids) without
 *   opening any process, and fails as `connection_list`, never as an empty
 *   read, when the call fails or the table keeps outgrowing its buffer.
 * - The dead-shell orphan stop (`loadWin32OrphanApi`) reads a creation time
 *   only for a same-session, same-user process above pid 4, never opens
 *   PROCESS_VM_READ, terminates only through a handle whose creation time still
 *   matches, and fails to load when the caller's own session cannot be read.
 *
 * Each refusal is asserted next to a positive control (the open that the gate
 * does allow), so a fake that silently stopped answering cannot pass for free.
 * The one exception is the empty start key in `kill`, where the refusal is that
 * nothing is opened at all.
 */

import { describe, it, expect } from 'vitest';
import {
  Win32TaggedProcessReader,
  loadWin32OrphanApi,
  userVisibleWindowPids,
  windowSize,
  type WindowRect,
} from '../../src/main/pty/process-tag/win32-reader';
import { planReapDetailed } from '../../src/main/pty/process-tag/reap-plan';
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
  /** The process owns one ordinary visible top-level window (800 by 600). */
  visible?: boolean;
  /** Visible top-level windows of a given size, as `GetWindowRect` reports them, besides the one `visible` adds. */
  windows?: Array<{ width: number; height: number }>;
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

interface TcpRowSpec {
  /** MIB_TCP_STATE: 2 LISTEN, 5 ESTAB. */
  state: number;
  local: number[];
  localPort: number;
  remote: number[];
  remotePort: number;
  pid: number;
}

/** A port's DWORD as Windows stores it: the port in network order in the first two bytes. */
function portDword(port: number): Buffer {
  return Buffer.from([port >> 8, port & 0xff, 0, 0]);
}

/**
 * A MIB_TCPTABLE_OWNER_PID (24-byte rows: state, local address, local port,
 * remote address, remote port, pid) or a MIB_TCP6TABLE_OWNER_PID (56-byte
 * rows: local address, scope id, local port, remote address, scope id, remote
 * port, state, pid), laid out from iphlpapi's headers rather than the reader.
 */
function tcpTable(rows: TcpRowSpec[], family: 'ipv4' | 'ipv6' = 'ipv4'): Buffer {
  const parts: Buffer[] = [unsigned32(rows.length)];
  for (const spec of rows) {
    if (family === 'ipv4') {
      parts.push(unsigned32(spec.state), Buffer.from(spec.local), portDword(spec.localPort), Buffer.from(spec.remote), portDword(spec.remotePort), unsigned32(spec.pid));
    } else {
      parts.push(Buffer.from(spec.local), unsigned32(0), portDword(spec.localPort), Buffer.from(spec.remote), unsigned32(0), portDword(spec.remotePort), unsigned32(spec.state), unsigned32(spec.pid));
    }
  }
  return Buffer.concat(parts);
}

const LOOPBACK = [127, 0, 0, 1];
const ANY = [0, 0, 0, 0];
const ANY6 = new Array<number>(16).fill(0);
const MAPPED_LOOPBACK6 = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 127, 0, 0, 1];

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
  /** What GetExtendedTcpTable answers, per family (`AF_INET` 2, `AF_INET6` 23). */
  readonly tcpTables = new Map<number, Buffer>([[2, tcpTable([])], [23, tcpTable([], 'ipv6')]]);
  /** Every GetExtendedTcpTable call: the family, the table class, and the buffer it was given. */
  readonly tcpTableCalls: Array<{ family: number; tableClass: number; bufferBytes: number }> = [];
  /** Calls still to answer ERROR_INSUFFICIENT_BUFFER with a size past the buffer given, as a table growing between calls does. */
  tcpTableGrowths = 0;
  /** A status GetExtendedTcpTable fails with every time. */
  tcpTableFailure: number | null = null;

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
    visibleWindows: () => this.processes.flatMap((fakeProcess) => [
      ...(fakeProcess.visible ? [{ width: 800, height: 600 }] : []),
      ...(fakeProcess.windows ?? []),
    ].map((size) => ({ pid: fakeProcess.pid, ...size }))),
    // NO_ERROR 0; ERROR_INSUFFICIENT_BUFFER 122 with the size it needs.
    getExtendedTcpTable: (table, size, _order, family, tableClass) => {
      this.tcpTableCalls.push({ family, tableClass, bufferBytes: table.length });
      if (this.tcpTableFailure !== null) return this.tcpTableFailure;
      if (this.tcpTableGrowths > 0) {
        this.tcpTableGrowths -= 1;
        size[0] = table.length + 1;
        return 122;
      }
      const contents = this.tcpTables.get(family) ?? tcpTable([]);
      if (contents.length > table.length) {
        size[0] = contents.length;
        return 122;
      }
      contents.copy(table);
      return 0;
    },
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
    // An empty string is a cleared tag: the variable is there with no value.
    if (typeof fakeProcess.tag === 'string') entries.push(`${TASK_PROCESS_TAG_ENV}=${fakeProcess.tag}`);
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
      { pid: 1000, image: 'chrome.exe', tag: TASK, visible: true },
      { pid: 1010, image: 'conhost.exe' },
      // The mixed case is what the image match has to fold, since the set holds lower case.
      { pid: 1020, image: 'OpenConsole.exe' },
      // A console host that owns a visible window is reported as the window, whichever check runs first.
      { pid: 1030, image: 'conhost.exe', tag: TASK, visible: true },
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

  // Measured on Windows 11 with Windows Terminal 1.24 (EnumWindows, IsWindowVisible,
  // GetWindowRect, GetWindow, GetWindowLong) while a /preview survived a Done move:
  // WindowsTerminal.exe owns a real window and is the parent of every tab's shell, and
  // each tab's shell is attributed a visible `PseudoConsoleWindow` at 0,0,0,0, owned by
  // Terminal's window, with WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE (0x8000080). Either read
  // as a visible app protects everything the tab runs.
  const WINDOWS_TERMINAL_TAB: FakeProcess[] = [
    { pid: 1100, image: 'WindowsTerminal.exe', visible: true, workingDirectory: 'C:\\WINDOWS\\system32' },
    { pid: 1110, ppid: 1100, image: 'cmd.exe', tag: TASK, windows: [{ width: 0, height: 0 }] },
    { pid: 1120, ppid: 1110, image: 'PING.EXE', tag: TASK },
  ];

  it('never reads a Windows Terminal tab, its terminal or its zero-area pseudo console window as a visible app', async () => {
    const fake = new FakeWin32([
      ...WINDOWS_TERMINAL_TAB,
      // A classic console window (ConsoleWindowClass) is a real window and still counts.
      { pid: 1130, image: 'cmd.exe', tag: TASK, windows: [{ width: 993, height: 519 }] },
      // A real window beside a zero-area one counts.
      { pid: 1140, image: 'electron.exe', tag: TASK, windows: [{ width: 0, height: 0 }, { width: 1280, height: 800 }] },
      // A minimized window keeps its area (measured: 160 by 28 at -32000,-32000).
      { pid: 1150, image: 'charmap.exe', tag: TASK, windows: [{ width: 160, height: 28 }] },
      // A node-pty shell: its pseudo console window is never shown, so it is never listed.
      { pid: 1160, image: 'pwsh.exe', tag: TASK },
    ]);
    const scan = await readerFor(fake).scan();

    // Positive controls: tagged windows with area are read, so the fake reports windows at all.
    expect(scanned(scan, 1130).role).toBe('visible-app');
    expect(scanned(scan, 1140).role).toBe('visible-app');
    expect(scanned(scan, 1150).role).toBe('visible-app');

    expect(scanned(scan, 1100).role).toBeUndefined();
    expect(scanned(scan, 1110).role).toBeUndefined();
    expect(scanned(scan, 1120).role).toBeUndefined();
    expect(scanned(scan, 1160).role).toBeUndefined();
    expectEveryHandleClosedOnce(fake);
  });

  it('reads a window only for a tagged process and what runs under it, never for an ancestor or a stranger', async () => {
    const fake = new FakeWin32([
      // An untagged app with a window above a tagged process: a terminal, a desktop shell.
      { pid: 1200, image: 'explorer.exe', visible: true },
      { pid: 1210, ppid: 1200, image: 'node.exe', tag: TASK },
      // An untagged child of a tagged process still counts: it runs under the task.
      { pid: 1220, ppid: 1210, image: 'app.exe', tag: null, visible: true },
      // An untagged window with no tagged process anywhere above it.
      { pid: 1230, image: 'notepad.exe', visible: true },
      // A cleared tag (the documented opt-out) is not a seed.
      { pid: 1240, image: 'paint.exe', tag: '', visible: true },
    ]);
    const scan = await readerFor(fake).scan();

    // Positive controls: a window under a tagged process is read, and the cleared tag was read as one.
    expect(scanned(scan, 1220).role).toBe('visible-app');
    expect(scanned(scan, 1240).tagValue).toBe('');
    expect(scanned(scan, 1200).role).toBeUndefined();
    expect(scanned(scan, 1210).role).toBeUndefined();
    expect(scanned(scan, 1230).role).toBeUndefined();
    expect(scanned(scan, 1240).role).toBeUndefined();
  });

  // The bug lived between the reader and the plan: each was right about its own
  // fixtures, and together they protected the tab. So the scan feeds the real plan.
  it('lets the plan reap what a Windows Terminal tab runs, and keep a window the agent opened', async () => {
    const fake = new FakeWin32([
      ...WINDOWS_TERMINAL_TAB,
      { pid: 1300, image: 'notepad.exe', tag: TASK, visible: true },
    ]);
    const scan = await readerFor(fake).scan();
    const plan = planReapDetailed({
      processes: scan.processes,
      tasks: new Map([[TASK, { directories: [WORKING_DIRECTORY], worktreePath: WORKING_DIRECTORY }]]),
      mainPid: 1,
      liveRootPids: [],
      caseInsensitivePaths: true,
    });

    expect(plan.targets.map((target) => target.pid).sort((left, right) => left - right)).toEqual([1110, 1120]);
    expect(plan.kept).toEqual([expect.objectContaining({ process: expect.objectContaining({ pid: 1300 }), reason: 'window' })]);
  });
});

describe('the window helpers: what counts as a window with area', () => {
  it('counts a window only when both its width and its height are positive', () => {
    const visiblePids = userVisibleWindowPids([
      { pid: 1, width: 0, height: 600 },
      { pid: 2, width: 800, height: 0 },
      { pid: 3, width: 0, height: 0 },
      // Positive control: the smallest window with area is the only one counted.
      { pid: 4, width: 1, height: 1 },
    ]);

    expect(visiblePids).toEqual(new Set([4]));
  });

  it('sizes a rect that could not be read as no area, whatever the out parameter holds', () => {
    const largeRect: WindowRect = { left: 0, top: 0, right: 1280, bottom: 800 };

    expect(windowSize(false, largeRect)).toEqual({ width: 0, height: 0 });
    // Positive controls: the same rect read successfully is its real size, so the zero above
    // comes from the guard and not from the rect.
    expect(windowSize(true, largeRect)).toEqual({ width: 1280, height: 800 });
    // A minimized window (measured: 160 by 28 at -32000,-32000) keeps its area.
    expect(windowSize(true, { left: -32000, top: -32000, right: -31840, bottom: -31972 })).toEqual({ width: 160, height: 28 });
    // A field koffi left unset reads as 0, so an empty rect is no area.
    expect(windowSize(true, {})).toEqual({ width: 0, height: 0 });
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

describe('Win32TaggedProcessReader.connections: the TCP table', () => {
  const listener = (pid: number): ScannedProcess => ({ pid, ppid: 1, startKey: String(creationOf(pid)), startedAtMs: null, tagValue: TASK });

  it('reads both families with owner pids, reads each port in network order, pairs across the tables, and opens no process', async () => {
    const fake = new FakeWin32([]);
    fake.tcpTables.set(2, tcpTable([
      { state: 2, local: ANY, localPort: 5037, remote: ANY, remotePort: 0, pid: 2001 },
      { state: 5, local: LOOPBACK, localPort: 5037, remote: LOOPBACK, remotePort: 52000, pid: 2001 },
      { state: 5, local: LOOPBACK, localPort: 52000, remote: LOOPBACK, remotePort: 5037, pid: 3001 },
      // The IPv4 client of 2002's dual-stack listener.
      { state: 5, local: LOOPBACK, localPort: 52001, remote: LOOPBACK, remotePort: 8080, pid: 3002 },
    ]));
    fake.tcpTables.set(23, tcpTable([
      { state: 2, local: ANY6, localPort: 8080, remote: ANY6, remotePort: 0, pid: 2002 },
      { state: 5, local: MAPPED_LOOPBACK6, localPort: 8080, remote: MAPPED_LOOPBACK6, remotePort: 52001, pid: 2002 },
    ], 'ipv6'));
    const read = await readerFor(fake).connections([listener(2001), listener(2002)], [listener(3001), listener(3002)]);

    expect(read.pairs).toEqual([{ listenerPid: 2001, clientPid: 3001 }, { listenerPid: 2002, clientPid: 3002 }]);
    expect(read.listeningPids).toEqual([2001, 2002]);
    // TCP_TABLE_OWNER_PID_ALL, AF_INET then AF_INET6.
    expect(fake.tcpTableCalls.map((call) => [call.family, call.tableClass])).toEqual([[2, 5], [23, 5]]);
    expect(fake.opens).toEqual([]);
  });

  it('pairs only sockets in ESTABLISHED: a connection winding down is no connection', async () => {
    // MIB_TCP_STATE (iphlpapi.h): 2 LISTEN, 5 ESTAB, 7 FIN_WAIT2, 8 CLOSE_WAIT.
    const fake = new FakeWin32([]);
    fake.tcpTables.set(2, tcpTable([
      { state: 2, local: ANY, localPort: 5037, remote: ANY, remotePort: 0, pid: 2001 },
      // The client closed first: the server's accepted socket waits to close, the client's end waits for the FIN.
      { state: 8, local: LOOPBACK, localPort: 5037, remote: LOOPBACK, remotePort: 52000, pid: 2001 },
      { state: 7, local: LOOPBACK, localPort: 52000, remote: LOOPBACK, remotePort: 5037, pid: 3001 },
      // The server closed first: the same two states, the other way round.
      { state: 7, local: LOOPBACK, localPort: 5037, remote: LOOPBACK, remotePort: 52001, pid: 2001 },
      { state: 8, local: LOOPBACK, localPort: 52001, remote: LOOPBACK, remotePort: 5037, pid: 3002 },
      // Positive control: a live connection pairs.
      { state: 5, local: LOOPBACK, localPort: 5037, remote: LOOPBACK, remotePort: 52002, pid: 2001 },
      { state: 5, local: LOOPBACK, localPort: 52002, remote: LOOPBACK, remotePort: 5037, pid: 3003 },
    ]));
    const read = await readerFor(fake).connections([listener(2001)], [listener(3001), listener(3002), listener(3003)]);
    expect(read.pairs).toEqual([{ listenerPid: 2001, clientPid: 3003 }]);
    expect(read.listeningPids).toEqual([2001]);
  });

  it('asks again with the size the table needs when it outgrew the buffer', async () => {
    const fake = new FakeWin32([]);
    fake.tcpTableGrowths = 2;
    await readerFor(fake).connections([listener(2001)], []);
    const ipv4Calls = fake.tcpTableCalls.filter((call) => call.family === 2);
    expect(ipv4Calls).toHaveLength(3);
    expect(ipv4Calls[1].bufferBytes).toBeGreaterThan(ipv4Calls[0].bufferBytes);
  });

  it('fails as connection_list, never as a clean read, when the call fails or the table keeps outgrowing its buffer', async () => {
    const failing = new FakeWin32([]);
    failing.tcpTableFailure = 87;
    await expect(readerFor(failing).connections([listener(2001)], [])).rejects.toMatchObject({ code: 'connection_list' });
    const growing = new FakeWin32([]);
    growing.tcpTableGrowths = 100;
    await expect(readerFor(growing).connections([listener(2001)], [])).rejects.toMatchObject({ code: 'connection_list' });
    expect(growing.tcpTableCalls.length).toBeLessThan(10);
  });
});

describe('loadWin32OrphanApi: what a dead shell left running', () => {
  it('reads an identity only for a same-session, same-user process above pid 4, and never opens PROCESS_VM_READ', async () => {
    const fake = new FakeWin32([
      { pid: 4, image: 'System' },
      { pid: 300, session: SERVICES_SESSION },
      { pid: 310, sessionLookupFails: true },
      { pid: 320, sid: OTHER_SID },
      { pid: 330, creationUnreadable: true },
      { pid: 700, image: 'claude.exe' },
    ]);
    const api = await loadWin32OrphanApi(async () => fake.api);

    for (const refused of [4, 300, 310, 320, 330]) expect(api.identityOf(refused)).toBeNull();
    // Positive control: the same process shape in the caller's session and user is read.
    expect(api.identityOf(700)).toEqual({ startKey: fake.startKeyOf(700), startedAtMs: expect.any(Number) });

    expect(fake.openedPids()).not.toContain(4);
    expect(fake.openedPids()).not.toContain(300);
    expect(fake.openedPids()).not.toContain(310);
    expect(fake.openedPids()).toContain(320);
    expect(fake.openedPids(PROCESS_VM_READ)).toEqual([]);
    expect(fake.leakedHandleIds()).toEqual([]);
  });

  it('lists every process with its parent and image, opening none', async () => {
    const fake = new FakeWin32([{ pid: 700, ppid: 500, image: 'claude.exe' }, { pid: 710, ppid: 700, image: 'node.exe' }]);
    const api = await loadWin32OrphanApi(async () => fake.api);
    const processOpensBefore = fake.openedPids().length;
    await expect(api.listProcesses()).resolves.toEqual([
      { pid: 700, ppid: 500, image: 'claude.exe' },
      { pid: 710, ppid: 700, image: 'node.exe' },
    ]);
    expect(fake.openedPids().length).toBe(processOpensBefore);
  });

  it('terminates only through a handle whose creation time still matches, and closes it either way', async () => {
    const fake = new FakeWin32([{ pid: 700, image: 'claude.exe' }]);
    const api = await loadWin32OrphanApi(async () => fake.api);
    const identity = api.identityOf(700);
    expect(identity).not.toBeNull();
    const target = { pid: 700, ppid: 500, image: 'claude.exe', ...(identity as { startKey: string; startedAtMs: number }) };

    expect(api.terminate({ ...target, startKey: (creationOf(700) - 1n).toString() })).toBe(false);
    // Positive control: the refusal came after a terminate-capable open, so it is the creation check.
    expect(fake.openedPids(PROCESS_TERMINATE)).toEqual([700]);
    expect(fake.terminatedHandleIds).toEqual([]);

    expect(api.terminate(target)).toBe(true);
    expect(fake.terminatedHandleIds).toHaveLength(1);
    expect(api.terminate({ ...target, startKey: '' })).toBe(false);
    expect(fake.leakedHandleIds()).toEqual([]);
  });

  it('fails to load, opening no process, when its own session cannot be read', async () => {
    const fake = new FakeWin32([{ pid: 700 }]);
    fake.ownSessionLookupFails = true;
    await expect(loadWin32OrphanApi(async () => fake.api)).rejects.toThrow('could not read its own session');
    expect(fake.openedPids()).toEqual([]);
  });

  it('fails to load, opening no process, when its own user cannot be read', async () => {
    // Positive control: with its own user readable, the same table loads and reads the caller's process.
    const control = new FakeWin32([{ pid: 700 }]);
    const controlApi = await loadWin32OrphanApi(async () => control.api);
    expect(controlApi.identityOf(700)).not.toBeNull();
    expect(control.openedPids()).toEqual([700]);

    const fake = new FakeWin32([{ pid: 700 }]);
    fake.ownTokenReadable = false;
    // Without its own user no process can be told apart as the caller's, so the load fails instead of handing out an API that cannot compare owners.
    await expect(loadWin32OrphanApi(async () => fake.api)).rejects.toThrow('could not read its own user');
    // The own session was read first and passed, so this is the user gate and not the session gate.
    expect(fake.sessionLookups).toContain(process.pid);
    expect(fake.opens).toEqual([]);
    // The token never opened, so no handle was ever created to leak.
    expect(fake.createdHandleIds).toEqual([]);
  });

  // The other ways its own user comes back null: its token OPENS, then
  // GetTokenInformation fails, or the TOKEN_USER it fills is not a SID.
  it.each(['query', 'revision', 'truncated', 'overrun', 'too-many-sub-authorities'] as const)(
    'fails to load, opening no process and closing the token it did open, when its own token user is unreadable (%s)',
    async (fault) => {
      const fake = new FakeWin32([{ pid: 700 }]);
      fake.ownTokenFault = fault;
      await expect(loadWin32OrphanApi(async () => fake.api)).rejects.toThrow('could not read its own user');
      expect(fake.opens).toEqual([]);
      // Unlike an unopenable token, this one was created: it is the load's only handle, and it was closed.
      expect(fake.createdHandleIds).toHaveLength(1);
      expect(fake.leakedHandleIds()).toEqual([]);
    },
  );
});
