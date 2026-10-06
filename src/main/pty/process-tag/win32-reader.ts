/**
 * Windows reader: no Windows API exposes another process's environment, so the
 * tag is read out of the target's PEB with koffi (an FFI with prebuilt
 * binaries, loaded only here and only on win32).
 *
 * Per process: Toolhelp gives pid and ppid; a process outside the caller's
 * Windows session (services, lsass, other users) is never opened, since the
 * session check needs no handle; one inside gets a limited-rights handle for
 * its creation time and token user; and only one owned by the caller's user is
 * opened again with `PROCESS_VM_READ`, so no read is ever attempted against an
 * antivirus, system, or other user's process. The environment block is read into a
 * Buffer this module allocates, searched for the tag, and dropped: only the
 * tag's value leaves this file. A 32-bit (WOW64) target is read through its
 * 32-bit PEB. The offsets (ProcessParameters 0x20, Environment 0x80,
 * EnvironmentSize 0x3f0; 32-bit 0x10, 0x48, 0x290) are unchanged from Windows
 * 10 through 11 24H2. The block read is the LIVE one, and `EnvironmentSize`
 * stays current when the process rewrites it (measured on Windows 11 after a
 * 200 KB grow, a 150 KB shrink, and 500 writes), so a process that deletes the
 * tag from itself reads as untagged. Same-user processes that refuse the
 * `PROCESS_VM_READ` open are elevated, or harden their own DACL, and are
 * counted as unreadable.
 *
 * The same read takes the working directory (`CurrentDirectory.DosPath`,
 * 0x38 on 64-bit and 0x24 on 32-bit; both measured on a Windows runner,
 * including a 32-bit adb). A path in 8.3 form (`RUNNER~1`) is expanded with
 * `GetLongPathNameW`, since the task's directories are compared in long form.
 * The roles (`process-scan.ts`): `EnumWindows` once per scan for the pids that
 * own a visible top-level window, and the console hosts by image name.
 *
 * `describe` reads `ImagePathName` and `CommandLine` (0x60 and 0x70 on 64-bit,
 * 0x38 and 0x40 on 32-bit) for the few processes a reap reports, splits the
 * command line in place, and returns only the label `process-label.ts` derives.
 *
 * A kill reopens the pid with `PROCESS_TERMINATE`, re-checks the creation time
 * on that handle, and terminates through the same handle, so a pid reused since
 * the scan is never touched.
 *
 * The loop yields to the event loop every few processes: a full scan measured
 * ~30 ms for ~460 processes, and the pty host carries every terminal byte.
 * `CreateToolhelp32Snapshot` itself is one native call of about 5.7 ms (410
 * processes), so it runs on the thread pool through koffi's async call; the
 * longest stretch the listing then holds the loop measured 0.36 ms (median of
 * 20) and 0.66 ms at most.
 *
 * `listWin32Processes` is that listing alone, and answers the background-shell
 * watcher's process table in the pty host (`host-process-table.ts`).
 *
 * `connections` reads the machine's TCP table with `GetExtendedTcpTable`
 * (`TCP_TABLE_OWNER_PID_ALL`, IPv4 and IPv6), which names each socket's owning
 * pid and needs no process handle at all. The pairing is `local-connections.ts`;
 * no address or port leaves this file.
 */

import { TASK_PROCESS_TAG_ENV } from './task-process-tag';
import { isFileFrom, labelProcess, splitWindowsCommandLine } from './process-label';
import { ipv4FromBytes, ipv6FromBytes, listeningPidsOf, pairLocalConnections, type SocketRow } from './local-connections';
import { ScanStepError, type KillStrength, type LocalConnectionRead, type ProcessScan, type ScannedProcess, type TaggedProcessReader } from './process-scan';

/** The part of koffi this reader uses. */
type KoffiApi = Pick<typeof import('koffi'), 'load' | 'struct' | 'array' | 'sizeof' | 'address' | 'proto' | 'register' | 'unregister' | 'pointer'>;
type NativeHandle = unknown;

const TH32CS_SNAPPROCESS = 0x2;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_VM_READ = 0x0010;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_USER_CLASS = 1;
const PROCESS_BASIC_INFORMATION_CLASS = 0;
const PROCESS_WOW64_INFORMATION_CLASS = 26;
const INVALID_HANDLE_ADDRESS = 0xFFFFFFFFFFFFFFFFn;
const MAX_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 32767 * 2;
const YIELD_EVERY_PROCESSES = 16;
const CONSOLE_HOST_IMAGES = new Set(['conhost.exe', 'openconsole.exe']);
/** 100 ns FILETIME ticks between 1601-01-01 and the Unix epoch. */
const FILETIME_UNIX_EPOCH_TICKS = 116444736000000000n;
const AF_INET = 2;
const AF_INET6 = 23;
const TCP_TABLE_OWNER_PID_ALL = 5;
const NO_ERROR = 0;
const ERROR_INSUFFICIENT_BUFFER = 122;
const MIB_TCP_STATE_LISTEN = 2;
const MIB_TCP_STATE_ESTAB = 5;
/** `MIB_TCPROW_OWNER_PID` and `MIB_TCP6ROW_OWNER_PID`, after the table's 4-byte count. */
const TCP4_ROW_BYTES = 24;
const TCP6_ROW_BYTES = 56;
const INITIAL_TCP_TABLE_BYTES = 64 * 1024;
/** Calls to size the table before giving up: it can grow between two calls. */
const TCP_TABLE_ATTEMPTS = 4;

interface Win32Api {
  koffi: KoffiApi;
  processEntrySize: number;
  /** `CreateToolhelp32Snapshot` on the thread pool, off the event loop. */
  createSnapshot(flags: number, pid: number): Promise<NativeHandle>;
  processFirst(snapshot: NativeHandle, entry: ProcessEntry): number;
  processNext(snapshot: NativeHandle, entry: ProcessEntry): number;
  openProcess(access: number, inherit: number, pid: number): NativeHandle;
  closeHandle(handle: NativeHandle): number;
  getCurrentProcess(): NativeHandle;
  processIdToSessionId(pid: number, sessionOut: number[]): number;
  isWow64Process(handle: NativeHandle, wowOut: number[]): number;
  getProcessTimes(handle: NativeHandle, creation: bigint[], exit: bigint[], kernel: bigint[], user: bigint[]): number;
  readProcessMemory(handle: NativeHandle, address: bigint, buffer: Buffer, size: number, bytesRead: null): number;
  terminateProcess(handle: NativeHandle, exitCode: number): number;
  openProcessToken(handle: NativeHandle, access: number, tokenOut: NativeHandle[]): number;
  getTokenInformation(token: NativeHandle, infoClass: number, buffer: Buffer, length: number, returnLength: number[]): number;
  queryInformationProcess(handle: NativeHandle, infoClass: number, buffer: Buffer, length: number, returnLength: number[]): number;
  getLongPathName(shortPath: string, buffer: Buffer, characters: number): number;
  /** Pids that own a visible top-level window. */
  visibleWindowPids(): Set<number>;
  /** `GetExtendedTcpTable`: fills `table`, or returns `ERROR_INSUFFICIENT_BUFFER` with the size it needs in `size[0]`. */
  getExtendedTcpTable(table: Buffer, size: number[], order: number, family: number, tableClass: number, reserved: number): number;
}

interface ProcessEntry {
  dwSize: number;
  th32ProcessID?: number;
  th32ParentProcessID?: number;
  szExeFile?: string;
}

let apiPromise: Promise<Win32Api> | null = null;

async function loadWin32Api(): Promise<Win32Api> {
  // A CommonJS package imported dynamically from the CJS bundle arrives as its
  // namespace with the exports under `default`; vitest hands the exports over
  // directly. Either way the functions below are the same ones.
  const imported = await import('koffi');
  const koffi: KoffiApi = imported.default ?? imported;
  const kernel32 = koffi.load('kernel32.dll');
  const advapi32 = koffi.load('advapi32.dll');
  const ntdll = koffi.load('ntdll.dll');
  const user32 = koffi.load('user32.dll');
  const iphlpapi = koffi.load('iphlpapi.dll');
  const processEntry = koffi.struct('KANGENTIC_PROCESSENTRY32W', {
    dwSize: 'uint32',
    cntUsage: 'uint32',
    th32ProcessID: 'uint32',
    th32DefaultHeapID: 'uintptr_t',
    th32ModuleID: 'uint32',
    cntThreads: 'uint32',
    th32ParentProcessID: 'uint32',
    pcPriClassBase: 'int32',
    dwFlags: 'uint32',
    szExeFile: koffi.array('char16_t', 260, 'String'),
  });
  const enumWindowsProc = koffi.proto('bool __stdcall KangenticEnumWindowsProc(void *hwnd, intptr_t lparam)');
  const enumWindows = user32.func('bool __stdcall EnumWindows(KangenticEnumWindowsProc *callback, intptr_t lparam)');
  const isWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
  const getWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)');
  const visibleWindowPids = (): Set<number> => {
    const pids = new Set<number>();
    const callback = koffi.register((hwnd: unknown) => {
      if (isWindowVisible(hwnd)) {
        const pid = [0];
        getWindowThreadProcessId(hwnd, pid);
        if (pid[0] > 0) pids.add(pid[0]);
      }
      return true;
    }, koffi.pointer(enumWindowsProc));
    try {
      enumWindows(callback, 0);
    } finally {
      koffi.unregister(callback);
    }
    return pids;
  };
  const createToolhelpSnapshot = kernel32.func('void *CreateToolhelp32Snapshot(uint32 flags, uint32 pid)');
  return {
    koffi,
    processEntrySize: koffi.sizeof(processEntry),
    createSnapshot: (flags, pid) => new Promise((resolve, reject) => {
      createToolhelpSnapshot.async(flags, pid, (error: unknown, snapshot: NativeHandle) => {
        if (error) reject(error);
        else resolve(snapshot);
      });
    }),
    processFirst: kernel32.func('int Process32FirstW(void *snapshot, _Inout_ KANGENTIC_PROCESSENTRY32W *entry)'),
    processNext: kernel32.func('int Process32NextW(void *snapshot, _Inout_ KANGENTIC_PROCESSENTRY32W *entry)'),
    openProcess: kernel32.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
    closeHandle: kernel32.func('int CloseHandle(void *handle)'),
    getCurrentProcess: kernel32.func('void *GetCurrentProcess()'),
    processIdToSessionId: kernel32.func('int ProcessIdToSessionId(uint32 pid, _Out_ uint32 *sessionId)'),
    isWow64Process: kernel32.func('int IsWow64Process(void *handle, _Out_ int *isWow64)'),
    getProcessTimes: kernel32.func('int GetProcessTimes(void *handle, _Out_ uint64_t *creation, _Out_ uint64_t *exit, _Out_ uint64_t *kernel, _Out_ uint64_t *user)'),
    readProcessMemory: kernel32.func('int ReadProcessMemory(void *handle, uintptr_t address, _Out_ uint8_t *buffer, size_t size, void *bytesRead)'),
    terminateProcess: kernel32.func('int TerminateProcess(void *handle, uint32 exitCode)'),
    openProcessToken: advapi32.func('int OpenProcessToken(void *process, uint32 access, _Out_ void **token)'),
    getTokenInformation: advapi32.func('int GetTokenInformation(void *token, int32 infoClass, _Out_ uint8_t *buffer, uint32 length, _Out_ uint32 *returnLength)'),
    queryInformationProcess: ntdll.func('int32 NtQueryInformationProcess(void *handle, int32 infoClass, _Out_ uint8_t *buffer, uint32 length, _Out_ uint32 *returnLength)'),
    getLongPathName: kernel32.func('uint32 GetLongPathNameW(const char16_t *shortPath, _Out_ uint8_t *buffer, uint32 characters)'),
    visibleWindowPids,
    getExtendedTcpTable: iphlpapi.func('uint32 __stdcall GetExtendedTcpTable(_Out_ uint8_t *table, _Inout_ uint32 *size, int order, uint32 family, int tableClass, uint32 reserved)'),
  };
}

function isNullHandle(api: Win32Api, handle: NativeHandle): boolean {
  if (handle === null || handle === undefined) return true;
  const address = api.koffi.address(handle);
  return address === 0n || address === INVALID_HANDLE_ADDRESS;
}

/**
 * The tag's value in a UTF-16LE environment block, or null. Windows variable
 * names are case-insensitive. Only the value is copied out.
 */
export function findTagInWindowsEnvironment(block: Buffer): string | null {
  const text = block.toString('utf16le');
  const terminator = text.indexOf('\u0000\u0000');
  const usable = terminator >= 0 ? text.slice(0, terminator) : text;
  const wanted = `${TASK_PROCESS_TAG_ENV}=`;
  let entryStart = 0;
  while (entryStart < usable.length) {
    let entryEnd = usable.indexOf('\u0000', entryStart);
    if (entryEnd < 0) entryEnd = usable.length;
    if (
      entryEnd - entryStart >= wanted.length
      && usable.slice(entryStart, entryStart + wanted.length).toUpperCase() === wanted
    ) {
      return usable.slice(entryStart + wanted.length, entryEnd);
    }
    entryStart = entryEnd + 1;
  }
  return null;
}

/** The SID bytes a TOKEN_USER buffer carries after its 16-byte header (x64). */
function sidBytesFromTokenUser(buffer: Buffer, length: number): Buffer | null {
  const sidOffset = 16;
  if (length < sidOffset + 8) return null;
  const revision = buffer[sidOffset];
  const subAuthorityCount = buffer[sidOffset + 1];
  if (revision !== 1 || subAuthorityCount > 15) return null;
  const sidLength = 8 + 4 * subAuthorityCount;
  if (sidOffset + sidLength > length) return null;
  return Buffer.from(buffer.subarray(sidOffset, sidOffset + sidLength));
}

function readTokenUserSid(api: Win32Api, processHandle: NativeHandle): Buffer | null {
  const tokenOut: NativeHandle[] = [null];
  if (!api.openProcessToken(processHandle, TOKEN_QUERY, tokenOut) || isNullHandle(api, tokenOut[0])) return null;
  try {
    const buffer = Buffer.alloc(256);
    const returned = [0];
    if (!api.getTokenInformation(tokenOut[0], TOKEN_USER_CLASS, buffer, buffer.length, returned)) return null;
    return sidBytesFromTokenUser(buffer, returned[0]);
  } finally {
    api.closeHandle(tokenOut[0]);
  }
}

function readCreationTime(api: Win32Api, handle: NativeHandle): bigint | null {
  const creation = [0n];
  const unused = [0n];
  if (!api.getProcessTimes(handle, creation, unused, unused, unused)) return null;
  return creation[0] > 0n ? creation[0] : null;
}

function readRemote(api: Win32Api, handle: NativeHandle, address: bigint, size: number): Buffer | null {
  if (address === 0n || size <= 0) return null;
  const buffer = Buffer.alloc(size);
  return api.readProcessMemory(handle, address, buffer, size, null) ? buffer : null;
}

/** The environment block and working directory a PEB read returns. */
interface ProcessParameters {
  environment: Buffer | null;
  workingDirectory: string | null;
}

/**
 * Read a UNICODE_STRING's text: a 16-bit byte length at `address`, and the
 * buffer pointer `pointerOffset` bytes in (8 on 64-bit, 4 on 32-bit).
 */
function readUnicodeString(api: Win32Api, handle: NativeHandle, address: bigint, pointerOffset: number, pointerSize: number): string | null {
  const header = readRemote(api, handle, address, pointerOffset + pointerSize);
  if (!header) return null;
  const length = header.readUInt16LE(0);
  if (length === 0 || length > MAX_PATH_BYTES) return null;
  const pointer = pointerSize === 8 ? header.readBigUInt64LE(pointerOffset) : BigInt(header.readUInt32LE(pointerOffset));
  const text = readRemote(api, handle, pointer, length);
  return text ? text.toString('utf16le') : null;
}

/** Read through the native (64-bit) PEB. */
function readNativeParameters(api: Win32Api, handle: NativeHandle): ProcessParameters | null {
  const basicInformation = Buffer.alloc(48);
  const returned = [0];
  if (api.queryInformationProcess(handle, PROCESS_BASIC_INFORMATION_CLASS, basicInformation, 48, returned) !== 0) return null;
  const pebAddress = basicInformation.readBigUInt64LE(8);
  const parametersPointer = readRemote(api, handle, pebAddress + 0x20n, 8);
  if (!parametersPointer) return null;
  const parametersAddress = parametersPointer.readBigUInt64LE(0);
  const workingDirectory = readUnicodeString(api, handle, parametersAddress + 0x38n, 8, 8);
  const environmentPointer = readRemote(api, handle, parametersAddress + 0x80n, 8);
  const environmentSize = readRemote(api, handle, parametersAddress + 0x3f0n, 8);
  if (!environmentPointer || !environmentSize) return { environment: null, workingDirectory };
  const size = Math.min(Number(environmentSize.readBigUInt64LE(0)), MAX_ENVIRONMENT_BYTES);
  return { environment: readRemote(api, handle, environmentPointer.readBigUInt64LE(0), size), workingDirectory };
}

/** Read through a WOW64 process's 32-bit PEB. */
function readWow64Parameters(api: Win32Api, handle: NativeHandle): ProcessParameters | null {
  const wowInformation = Buffer.alloc(8);
  const returned = [0];
  if (api.queryInformationProcess(handle, PROCESS_WOW64_INFORMATION_CLASS, wowInformation, 8, returned) !== 0) return null;
  const peb32Address = wowInformation.readBigUInt64LE(0);
  const parametersPointer = readRemote(api, handle, peb32Address + 0x10n, 4);
  if (!parametersPointer) return null;
  const parametersAddress = BigInt(parametersPointer.readUInt32LE(0));
  const workingDirectory = readUnicodeString(api, handle, parametersAddress + 0x24n, 4, 4);
  const environmentPointer = readRemote(api, handle, parametersAddress + 0x48n, 4);
  const environmentSize = readRemote(api, handle, parametersAddress + 0x290n, 4);
  if (!environmentPointer || !environmentSize) return { environment: null, workingDirectory };
  const size = Math.min(environmentSize.readUInt32LE(0), MAX_ENVIRONMENT_BYTES);
  return { environment: readRemote(api, handle, BigInt(environmentPointer.readUInt32LE(0)), size), workingDirectory };
}

/** The image path and command line, read only by `describe` and parsed in place. */
interface ProcessCommand {
  imagePath: string | null;
  commandLine: string | null;
}

/** ImagePathName (0x60) and CommandLine (0x70) through the native PEB. */
function readNativeCommand(api: Win32Api, handle: NativeHandle): ProcessCommand | null {
  const basicInformation = Buffer.alloc(48);
  const returned = [0];
  if (api.queryInformationProcess(handle, PROCESS_BASIC_INFORMATION_CLASS, basicInformation, 48, returned) !== 0) return null;
  const parametersPointer = readRemote(api, handle, basicInformation.readBigUInt64LE(8) + 0x20n, 8);
  if (!parametersPointer) return null;
  const parametersAddress = parametersPointer.readBigUInt64LE(0);
  return {
    imagePath: readUnicodeString(api, handle, parametersAddress + 0x60n, 8, 8),
    commandLine: readUnicodeString(api, handle, parametersAddress + 0x70n, 8, 8),
  };
}

/** ImagePathName (0x38) and CommandLine (0x40) through a WOW64 process's 32-bit PEB. */
function readWow64Command(api: Win32Api, handle: NativeHandle): ProcessCommand | null {
  const wowInformation = Buffer.alloc(8);
  const returned = [0];
  if (api.queryInformationProcess(handle, PROCESS_WOW64_INFORMATION_CLASS, wowInformation, 8, returned) !== 0) return null;
  const parametersPointer = readRemote(api, handle, wowInformation.readBigUInt64LE(0) + 0x10n, 4);
  if (!parametersPointer) return null;
  const parametersAddress = BigInt(parametersPointer.readUInt32LE(0));
  return {
    imagePath: readUnicodeString(api, handle, parametersAddress + 0x38n, 4, 4),
    commandLine: readUnicodeString(api, handle, parametersAddress + 0x40n, 4, 4),
  };
}

/** Expand an 8.3 path (`C:\\Users\\RUNNER~1`) to its long form; others pass through. */
function longPath(api: Win32Api, directory: string): string {
  if (!directory.includes('~')) return directory;
  const buffer = Buffer.alloc(MAX_PATH_BYTES + 2);
  const characters = api.getLongPathName(directory, buffer, MAX_PATH_BYTES / 2);
  if (characters === 0 || characters > MAX_PATH_BYTES / 2) return directory;
  return buffer.toString('utf16le', 0, characters * 2);
}

function readTagAndDirectory(api: Win32Api, pid: number): { tagValue: string | null; workingDirectory: string | null; readable: boolean } {
  const handle = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
  if (isNullHandle(api, handle)) return { tagValue: null, workingDirectory: null, readable: false };
  try {
    const isWow64 = [0];
    api.isWow64Process(handle, isWow64);
    const parameters = isWow64[0] ? (readWow64Parameters(api, handle) ?? readNativeParameters(api, handle)) : readNativeParameters(api, handle);
    const workingDirectory = parameters?.workingDirectory ? longPath(api, parameters.workingDirectory) : null;
    if (!parameters?.environment) return { tagValue: null, workingDirectory, readable: false };
    return { tagValue: findTagInWindowsEnvironment(parameters.environment), workingDirectory, readable: true };
  } finally {
    api.closeHandle(handle);
  }
}

function filetimeToEpochMs(filetime: bigint): number {
  return Number((filetime - FILETIME_UNIX_EPOCH_TICKS) / 10000n);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function sharedWin32Api(): Promise<Win32Api> {
  apiPromise ??= loadWin32Api();
  return apiPromise;
}

/** One process as Toolhelp lists it: pid, parent pid, and image file name (`node.exe`). */
export interface Win32ProcessRow {
  pid: number;
  ppid: number;
  image: string;
}

/** Every process in a Toolhelp snapshot, or [] when the snapshot fails (it can, under heavy process churn). */
async function enumerateProcesses(api: Win32Api): Promise<Win32ProcessRow[]> {
  const snapshot = await api.createSnapshot(TH32CS_SNAPPROCESS, 0);
  if (isNullHandle(api, snapshot)) return [];
  const rows: Win32ProcessRow[] = [];
  try {
    const entry: ProcessEntry = { dwSize: api.processEntrySize };
    if (!api.processFirst(snapshot, entry)) return rows;
    do {
      rows.push({ pid: entry.th32ProcessID ?? 0, ppid: entry.th32ParentProcessID ?? 0, image: entry.szExeFile ?? '' });
      entry.dwSize = api.processEntrySize;
      if (rows.length % (YIELD_EVERY_PROCESSES * 4) === 0) await yieldToEventLoop();
    } while (api.processNext(snapshot, entry));
  } finally {
    api.closeHandle(snapshot);
  }
  return rows;
}

/**
 * Every process on the machine as pid, parent pid and image name, with no
 * handle opened on any of them. Rejects when koffi cannot load. Measured on
 * 410 processes: 8 ms, against 140 ms (median of 10) for the warm
 * `Get-CimInstance Win32_Process` query this replaced in the watcher, with
 * the same pids, parents and names.
 */
export async function listWin32Processes(loadApi: () => Promise<Win32Api> = sharedWin32Api): Promise<Win32ProcessRow[]> {
  return enumerateProcesses(await loadApi());
}

function tcpStateOf(state: number): SocketRow['state'] {
  if (state === MIB_TCP_STATE_LISTEN) return 'listen';
  if (state === MIB_TCP_STATE_ESTAB) return 'established';
  return 'other';
}

/**
 * Rows of a `MIB_TCPTABLE_OWNER_PID` (`ipv4`) or `MIB_TCP6TABLE_OWNER_PID`
 * (`ipv6`): a 4-byte count, then fixed-size rows. Each port sits in the low
 * 16 bits of its DWORD in network order, so it reads big-endian from the
 * DWORD's first two bytes. Exported for fixture tests.
 */
export function parseTcpOwnerPidTable(table: Buffer, family: 'ipv4' | 'ipv6'): SocketRow[] {
  if (table.length < 4) return [];
  const count = table.readUInt32LE(0);
  const rowBytes = family === 'ipv4' ? TCP4_ROW_BYTES : TCP6_ROW_BYTES;
  const rows: SocketRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * rowBytes;
    if (offset + rowBytes > table.length) break;
    if (family === 'ipv4') {
      rows.push({
        state: tcpStateOf(table.readUInt32LE(offset)),
        localAddress: ipv4FromBytes(table, offset + 4),
        localPort: table.readUInt16BE(offset + 8),
        remoteAddress: ipv4FromBytes(table, offset + 12),
        remotePort: table.readUInt16BE(offset + 16),
        ownerPids: [table.readUInt32LE(offset + 20)],
      });
    } else {
      rows.push({
        state: tcpStateOf(table.readUInt32LE(offset + 48)),
        localAddress: ipv6FromBytes(table, offset),
        localPort: table.readUInt16BE(offset + 20),
        remoteAddress: ipv6FromBytes(table, offset + 24),
        remotePort: table.readUInt16BE(offset + 44),
        ownerPids: [table.readUInt32LE(offset + 52)],
      });
    }
  }
  return rows;
}

/** One family's TCP table, sized as the call asks. Throws when the call fails or the table keeps outgrowing its buffer. */
function readTcpTable(api: Win32Api, family: 'ipv4' | 'ipv6'): SocketRow[] {
  const size = [INITIAL_TCP_TABLE_BYTES];
  for (let attempt = 0; attempt < TCP_TABLE_ATTEMPTS; attempt += 1) {
    // Room for rows that arrive between the sizing call and this one.
    const table = Buffer.alloc(size[0] + 4096);
    size[0] = table.length;
    const status = api.getExtendedTcpTable(table, size, 0, family === 'ipv4' ? AF_INET : AF_INET6, TCP_TABLE_OWNER_PID_ALL, 0);
    if (status === NO_ERROR) return parseTcpOwnerPidTable(table, family);
    if (status !== ERROR_INSUFFICIENT_BUFFER) throw new Error(`GetExtendedTcpTable failed with ${status}`);
  }
  throw new Error('GetExtendedTcpTable outgrew its buffer');
}

export class Win32TaggedProcessReader implements TaggedProcessReader {
  private readonly loadApi: () => Promise<Win32Api>;

  constructor(loadApi?: () => Promise<Win32Api>) {
    this.loadApi = loadApi ?? sharedWin32Api;
  }

  async ready(): Promise<void> {
    await this.loadApi();
  }

  async scan(): Promise<ProcessScan> {
    const api = await this.loadApi();
    // Both gates below need the caller's own session and user. Without the
    // session every process would be compared against session 0, where
    // services run; without the user no process could be read. Either way the
    // scan would see nothing and look clean, so it fails instead, and the reap
    // reports it rather than quietly stopping nothing.
    const ownSession = [0];
    if (api.processIdToSessionId(process.pid, ownSession) === 0) {
      throw new Error('the Windows reader could not read its own session');
    }
    const ownSid = readTokenUserSid(api, api.getCurrentProcess());
    if (ownSid === null) throw new Error('the Windows reader could not read its own user');

    const rows = await enumerateProcesses(api);
    const windowPids = api.visibleWindowPids();
    const processes: ScannedProcess[] = [];
    let unreadableCount = 0;
    for (let index = 0; index < rows.length; index += 1) {
      if (index > 0 && index % YIELD_EVERY_PROCESSES === 0) await yieldToEventLoop();
      const row = rows[index];
      const scanned: ScannedProcess = { pid: row.pid, ppid: row.ppid, startKey: '', startedAtMs: null, tagValue: null };
      if (windowPids.has(row.pid)) scanned.role = 'visible-app';
      else if (CONSOLE_HOST_IMAGES.has(row.image.toLowerCase())) scanned.role = 'console-host';
      processes.push(scanned);
      if (row.pid <= 4) continue;
      // The session check needs no handle, so a process in another Windows
      // session (services, lsass, other users) is never opened at all. It
      // stays in the table with an unknown start key, which the kill refuses
      // and the protection walk treats permissively, so nothing is lost.
      const sessionId = [0];
      if (api.processIdToSessionId(row.pid, sessionId) === 0 || sessionId[0] !== ownSession[0]) continue;
      const limited = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, row.pid);
      if (isNullHandle(api, limited)) continue;
      let sameUser: boolean;
      try {
        const creation = readCreationTime(api, limited);
        if (creation !== null) {
          scanned.startKey = creation.toString();
          scanned.startedAtMs = filetimeToEpochMs(creation);
        }
        const sid = readTokenUserSid(api, limited);
        sameUser = sid !== null && sid.equals(ownSid);
      } finally {
        api.closeHandle(limited);
      }
      if (!sameUser) continue;
      const { tagValue, workingDirectory, readable } = readTagAndDirectory(api, row.pid);
      if (!readable) {
        unreadableCount += 1;
        scanned.environmentUnreadable = true;
      }
      scanned.tagValue = tagValue;
      scanned.workingDirectory = workingDirectory;
    }
    return { processes, unreadableCount };
  }

  async kill(target: ScannedProcess, strength: KillStrength): Promise<boolean> {
    // Windows has no polite signal for a windowless process: both strengths
    // terminate, which is what `taskkill /F` did before this reader existed.
    void strength;
    if (!target.startKey) return false;
    const api = await this.loadApi();
    const handle = api.openProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, target.pid);
    if (isNullHandle(api, handle)) return false;
    try {
      const creation = readCreationTime(api, handle);
      if (creation === null || creation.toString() !== target.startKey) return false;
      return api.terminateProcess(handle, 1) !== 0;
    } finally {
      api.closeHandle(handle);
    }
  }

  async describe(targets: readonly ScannedProcess[]): Promise<Map<number, string>> {
    const labels = new Map<number, string>();
    let api: Win32Api;
    try {
      api = await this.loadApi();
    } catch {
      return labels;
    }
    for (const target of targets) {
      // A tag is read only from a same-user process in this session, so a
      // tagged target is one `scan` already cleared for PROCESS_VM_READ. A
      // start key alone is not: scan sets it before the user check.
      if (!target.startKey || target.tagValue === null) continue;
      const handle = api.openProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, target.pid);
      if (isNullHandle(api, handle)) continue;
      try {
        const creation = readCreationTime(api, handle);
        if (creation === null || creation.toString() !== target.startKey) continue;
        const isWow64 = [0];
        api.isWow64Process(handle, isWow64);
        const command = isWow64[0] ? (readWow64Command(api, handle) ?? readNativeCommand(api, handle)) : readNativeCommand(api, handle);
        if (!command?.commandLine) continue;
        const workingDirectory = target.workingDirectory ?? null;
        labels.set(target.pid, await labelProcess({
          executablePath: command.imagePath,
          argv: splitWindowsCommandLine(command.commandLine),
          isFile: (candidate) => isFileFrom(workingDirectory, candidate),
        }));
      } catch {
        /* gone mid-read */
      } finally {
        api.closeHandle(handle);
      }
    }
    return labels;
  }

  async connections(listeners: readonly ScannedProcess[], clients: readonly ScannedProcess[]): Promise<LocalConnectionRead> {
    const api = await this.loadApi();
    let rows: SocketRow[];
    try {
      // The whole table, one call per family: it names every socket's owner,
      // so there is nothing to narrow by reading fewer processes.
      rows = [...readTcpTable(api, 'ipv4'), ...readTcpTable(api, 'ipv6')];
    } catch (error) {
      throw new ScanStepError('connection_list', error instanceof Error ? error.message : String(error));
    }
    const listenerPids = new Set(listeners.map((scanned) => scanned.pid));
    return {
      pairs: pairLocalConnections(rows, listenerPids, new Set(clients.map((scanned) => scanned.pid))),
      listeningPids: listeningPidsOf(rows, listenerPids),
    };
  }
}
