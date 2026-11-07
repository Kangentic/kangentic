/**
 * What the link and the helper say to each other (#913), carried as the JSON body of a
 * sequenced frame (`frame-codec.ts`, `resume-endpoint.ts`). It is the pty host's own
 * vocabulary (`pty/host/protocol.ts`) with the two things a remote host adds:
 *
 * - A PTY id on the wire is the link's id for it, never the helper's. The helper maps it
 *   (`helper-server.ts`), so a link that restarts and counts from 1 again cannot route an old
 *   exit to a new handle.
 * - `snapshot` and `rebind`, which let a link that lost frames to a drop, or came back after
 *   a restart, rebuild what it missed from what the helper holds now.
 *
 * Terminal text never travels as JSON. A port message's `data` moves into the frame's raw
 * part (`splitPortMessage`), so output is not escaped on the way.
 */

import type { PtyHostCommand, PtyHostError, PtyHostEvent, PtyHostMethod, PtyHostRequestMap } from '../../pty/host/protocol';
import type { FromPtyHostPortMessage, ToPtyHostPortMessage } from '../../../shared/pty-port-protocol';
import type { ExitSequenceStep } from '../../../shared/types';

/** One PTY the helper holds, as the link needs it to rebuild its own state. */
export interface HelperSessionRecord {
  sessionId: string;
  taskId: string | null;
  projectId: string;
  pid: number;
  alive: boolean;
  /** Null while the PTY runs. */
  exitCode: number | null;
  /** The link's id for it while one is bound, else null. */
  wirePtyId: number | null;
  inAltScreen: boolean;
}

export interface HelperSnapshot {
  /** Counts up each time a connection is accepted as the owner. */
  ownerEpoch: number;
  daemonPid: number;
  daemonStartedAt: string;
  sessions: HelperSessionRecord[];
}

/** How one session ends at quit, which only the app knows (it holds the adapters). */
export interface SuspendPlan {
  sessionId: string;
  /** The adapter's keys and pauses, for an agent that is typed into. */
  exitSequence?: ExitSequenceStep[];
  /** The agent's console close or hangup is its own graceful exit, so nothing is typed into it. */
  consoleCloseIsGraceful: boolean;
}

export interface SuspendAllParams {
  /** The owner epoch the link last saw. A frame from an earlier quit that arrives late carries an old one. */
  ownerEpoch: number;
  sessions: SuspendPlan[];
}

/**
 * A spawn's `file` that means "the host's own login shell": the helper puts in the shell the user has
 * there, run as a login shell so their PATH and rc files apply. The app never guesses a host's shell.
 */
export const HOST_LOGIN_SHELL = '$LOGIN_SHELL';

/** A path into a JSON object: each segment is an object key. */
export type JsonPointer = string[];

/** One declarative edit of a JSON file the helper applies under a lock (`helper/json-patch.ts`). */
export type JsonPatchOp =
  /** Set the value, replacing any other. */
  | { op: 'set'; at: JsonPointer; value: unknown }
  /** Set the value only where nothing is. */
  | { op: 'setDefault'; at: JsonPointer; value: unknown }
  /** Add the value to the array there, making it, unless it is already in it. */
  | { op: 'addToArray'; at: JsonPointer; value: unknown }
  /** Where nothing is, copy the array at `from`, or `fallback` when `from` holds none. */
  | { op: 'copyIfAbsent'; from: JsonPointer; at: JsonPointer; fallback: unknown };

export interface JsonPatchRequest {
  /** Absolute, beneath the user's home (the helper checks). */
  path: string;
  ops: JsonPatchOp[];
  /** A directory taken with `mkdir` for the edit's length, as the CLI takes its own lock. */
  lockDirectory?: string;
}

export type JsonPatchResult =
  | { applied: true; changed: boolean }
  | { applied: false; changed: false; reason: 'locked' | 'not-an-object' | 'unreadable' | 'bad-patch' };

/**
 * A file a session's CLI writes under a name only the host can say. The helper walks `directory`, newest name
 * first and at most `depth` levels down, for a file whose name `fileName` (a regular expression's source)
 * matches. It sends the file as `key` and never says what it found, so the app decides where the bytes go.
 */
export interface HostFileSearch {
  key: string;
  /** Absolute, on the host. The helper checks it is beneath the user's home before it is searched. */
  directory: string;
  depth: number;
  fileName: string;
}

export interface HostFileWrite {
  /** An absolute path on the host, under the user's home. */
  path: string;
  /** The file's text, UTF-8. */
  content: string;
  /** Unix permission bits, such as 0o755 for a script. Defaults to owner read and write. */
  mode?: number;
  /**
   * The text the file must hold when it is replaced (null: it must not exist). The helper checks it
   * right before it renames the new file in, and leaves a file that differs alone, naming it in the
   * answer's `conflicts`. Absent: the file is written whatever it holds.
   */
  expect?: string | null;
  /** An existing file keeps the permission bits it has, and `mode` applies only when the file is new. */
  keepExistingMode?: boolean;
}

export interface HostWriteResult {
  written: number;
  /** Paths whose `expect` did not match, so they were not written. Absent when there were none. */
  conflicts?: string[];
}

export interface HostCommandRequest {
  /** The program: a name the user's shell finds on its PATH (such as `codex`), or an absolute path. */
  file: string;
  args: string[];
  /** An absolute folder beneath the user's home. The user's home when absent. */
  cwd?: string;
  /** Added to the host's own environment for this run. */
  env?: Record<string, string>;
  /** Written to the program's standard input, which is then closed. */
  stdin?: string;
  /** The run is stopped, its whole process group, after this long. */
  timeoutMs: number;
}

export interface HostCommandResult {
  /** The exit code, or null when the run was stopped (`timedOut`) or never started (`error`). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Why the program was not run to its end: it could not start, the folder is not there, its output was capped. */
  error?: string;
}

/**
 * Whether a command's `error` means the program could not be started. Its other errors (a missing folder, capped
 * output, a shell that ended first) ran no program, so they say nothing about whether it is installed.
 */
export function isHostCommandNotStarted(error: string): boolean {
  return /\bENOENT\b/.test(error);
}

/**
 * What main cannot know of a host and must not guess: where the user's files are and which shell a
 * login shell spawn lands in. The shell decides how a typed command is quoted and cleared.
 */
export interface HostInfo {
  /** The user's home folder on the host. */
  home: string;
  /** The login shell's path, such as /usr/bin/zsh. */
  shellPath: string;
  /** Its program name, such as zsh, fish or nu. */
  shellName: string;
}

/** Requests only the helper answers, beside the pty host's own. */
export interface HelperRequestMap {
  hostInfo: { params: Record<string, never>; result: HostInfo };
  /** Bind the link's id to a session the helper already holds. */
  rebind: { params: { sessionId: string; ptyId: number }; result: { ok: boolean } };
  snapshot: { params: Record<string, never>; result: HelperSnapshot };
  /**
   * The app is quitting: end every live session the way its adapter ends it, on the helper's own
   * clock. One frame, because the app may be gone before a second one could be sent. Refused, with
   * `ignored`, when the epoch is not the helper's current one.
   */
  suspendAll: { params: SuspendAllParams; result: { suspended: number; ignored: boolean } };
  /**
   * Write files the agent's command needs (its settings, its hook scripts), making their folders, and
   * make `directories` that hold no file of their own (a hook folder the script publishes into).
   */
  writeFiles: { params: { files: HostFileWrite[]; directories?: string[] }; result: HostWriteResult };
  /** Write one file whose bytes ride the frame's raw part (up to 1 MiB), for content too large for the JSON body. */
  writeFileRaw: { params: { path: string; mode?: number }; result: { written: number } };
  /** Edit a JSON file a CLI shares with Kangentic, under the CLI's own lock (`json-patch.ts`). */
  jsonPatch: { params: JsonPatchRequest; result: JsonPatchResult };
  /**
   * Start sending a session's hook files (`hook-watcher.ts`) as `hookFile` events. `directory` is the
   * folder holding `inbox/` and `requests/`, and `statusFile` the status line's JSON.
   */
  watchHooks: { params: { sessionId: string; directory: string; statusFile?: string }; result: { watching: true } };
  /**
   * Start sending the growing files of a session (its transcript) as `fileChunk` events, from their
   * first byte (`file-tail.ts`). Paths are absolute and beneath the user's home. A file that is not
   * there yet is sent once it exists. A later call names the whole set: a file in both keeps its place.
   * `sizes` is each file's size as the host answers, by key, so what was there before the agent ran can be
   * told from what it adds. A file that is not there has no entry.
   *
   * `searches` names files by a pattern, for a CLI that puts a timestamp in the name (`HostFileSearch`). The
   * field is separate so a program older than it ignores it and keeps the plain files. `searching` says this
   * program looks for them: with no such answer the copy is not made, and the app says so in its log.
   */
  watchFiles: {
    params: { sessionId: string; files: Array<{ key: string; path: string }>; searches?: HostFileSearch[] };
    result: { watching: true; sizes: Record<string, number>; searching?: true };
  };
  /** Stop, after one last pass that sends the end of each file. */
  unwatchFiles: { params: { sessionId: string }; result: { watching: false } };
  /** Stop, after sending what is already published. */
  unwatchHooks: { params: { sessionId: string }; result: { watching: false } };
  /** Remove files the app wrote and a CLI should no longer find (its hooks, its MCP entry). A missing file is not an error. */
  removeFiles: { params: { paths: string[]; expect?: Record<string, string> }; result: { removed: number; conflicts?: string[] } };
  /** Remove folders that hold nothing, deepest first as given. A folder with anything in it, or not there, is left. */
  removeEmptyDirectories: { params: { paths: string[] }; result: { removed: number } };
  /**
   * Run a program on the host to completion and return what it printed, for a CLI's own probe (its
   * trust check, a chat id, a listing). It runs where the CLI is found, through the user's own shell,
   * and is bounded by `timeoutMs`; a non-zero exit is an answer, not an error.
   */
  runCommand: { params: HostCommandRequest; result: HostCommandResult };
  /** Read one text file, for the files the app must see before it writes its own beside them. */
  readFile: { params: { path: string; maxBytes?: number }; result: { exists: boolean; content: string | null } };
  /** Whether each path is there. Only the helper may say a path is absent: this computer's copy proves nothing. */
  pathPresence: { params: { paths: string[] }; result: Array<'present' | 'absent'> };
  /**
   * The TCP ports a server on the host is listening on at loopback or the wildcard address, sorted. A
   * failed read is an error, never an empty list: an empty list says nothing is listening.
   */
  listeningPorts: { params: Record<string, never>; result: { ports: number[] } };
  /** Which program this is, how long it has run, how many terminals it holds, and which versions sit on the host. */
  programInfo: { params: Record<string, never>; result: HostProgramInfo };
  /**
   * Remove installed versions that are not in `keep` and were installed more than `olderThanDays` ago. The
   * running version is always kept. Best effort: a version that cannot be removed is left.
   */
  pruneVersions: { params: { keep: string[]; olderThanDays: number }; result: { removed: string[] } };
}

export interface HostProgramInfo {
  /** The version of the program this daemon is running, or null when it cannot tell (a development run). */
  version: string | null;
  /** UTC ISO time the daemon started. */
  startedAt: string;
  /** Terminals the program holds that are still running. */
  liveSessions: number;
  /** Every complete version on the host, oldest first. */
  installedVersions: string[];
}

/** Where one forwarded dev-server port stands (`link/port-forward.ts`). */
export interface PortForwardStatus {
  port: number;
  /** `waiting`: nothing listens on the host yet. `forwarding`: reachable at 127.0.0.1 here. `blocked`: ssh could not forward it. */
  state: 'waiting' | 'forwarding' | 'blocked';
  /** For `blocked`, ssh's own words. */
  detail?: string;
}

/** What the process that holds the links needs to dial one SSH host. Plain data: it crosses a process boundary. */
export interface RemoteHostConnection {
  /** The `ssh` program, by full path where the platform has more than one. */
  sshPath: string;
  /** Everything before the remote command: options, then the destination. */
  args: string[];
  /** What runs on the host and speaks frames on its stdio (`InstalledHost.relayCommand`). */
  remoteCommand: string;
  /** This install, so the helper tells a reconnect from a stranger. */
  installId: string;
  /** How this computer names itself to the host's log, such as its hostname. */
  label: string;
}

/** A remote PTY main holds a handle for: its session and the PTY id main gave it. */
export interface RemoteSessionRoute {
  sessionId: string;
  ptyId: number;
}

/** The operations on the links, as the single `remote` request of the pty host carries them. */
export type RemoteHostRequest =
  /**
   * Dial a host. A host already dialing or connected keeps its link and redials now. `sessions` are
   * the PTYs main already holds on that host, sent when the process holding the links restarted, so
   * their routes and the link's reconcile carry over instead of reading as adoptable.
   */
  | { op: 'addHost'; hostId: string; connection: RemoteHostConnection; sessions?: RemoteSessionRoute[] }
  | { op: 'removeHost'; hostId: string }
  /**
   * Take on sessions the host kept running while this app was closed (#913). Each is routed under the
   * PTY id main just made for it and the helper is asked to rebind it, so its output and exit reach that
   * PTY. The answer lists the sessions the host still holds alive; one it no longer has, or that has
   * exited, comes back `false` and is not routed.
   */
  | { op: 'adopt'; hostId: string; sessions: RemoteSessionRoute[] }
  /**
   * The dev-server ports of a host's projects that should reach this computer. The full set each time:
   * a port left out stops being forwarded. Each is forwarded to the same number here once a server
   * listens on it there.
   */
  | { op: 'setForwards'; hostId: string; ports: number[] }
  | { op: 'listForwards'; hostId: string }
  /** `timeoutMs` replaces the link's default wait, for a request that runs longer than a file job. */
  | { op: 'helper'; hostId: string; method: HelperMethod; params: unknown; raw?: Uint8Array; timeoutMs?: number };

export type HelperMethod = keyof HelperRequestMap;
export type RemoteMethod = PtyHostMethod | HelperMethod;

export type RemoteRequestParams<M extends RemoteMethod> = M extends HelperMethod
  ? HelperRequestMap[M]['params']
  : M extends PtyHostMethod
    ? PtyHostRequestMap[M]['params']
    : never;

export type RemoteRequestResult<M extends RemoteMethod> = M extends HelperMethod
  ? HelperRequestMap[M]['result']
  : M extends PtyHostMethod
    ? PtyHostRequestMap[M]['result']
    : never;

/** The body of a port message once its text is split out. */
type WithoutData<T> = T extends { data: string } ? Omit<T, 'data'> : T;
export type PortBody = WithoutData<ToPtyHostPortMessage | FromPtyHostPortMessage>;

export type LinkToHelperMessage =
  | { t: 'command'; command: PtyHostCommand }
  | { t: 'request'; id: number; method: RemoteMethod; params: unknown }
  | { t: 'port'; message: PortBody };

export type HelperToLinkMessage =
  | { t: 'event'; event: PtyHostEvent }
  | { t: 'reply'; id: number; ok: true; result: unknown }
  | { t: 'reply'; id: number; ok: false; error: PtyHostError }
  | { t: 'port'; message: PortBody };

/** Move a port message's text into the raw part. */
export function splitPortMessage(message: ToPtyHostPortMessage | FromPtyHostPortMessage): { body: PortBody; raw: Buffer | undefined } {
  if ('data' in message) {
    const { data, ...body } = message;
    return { body: body as PortBody, raw: Buffer.from(data, 'utf8') };
  }
  return { body: message as PortBody, raw: undefined };
}

/** The reverse of `splitPortMessage`. */
export function joinPortMessage<Message extends ToPtyHostPortMessage | FromPtyHostPortMessage>(body: PortBody, raw: Buffer): Message {
  const type = (body as { type?: string }).type;
  if (type === 'write' || type === 'data' || type === 'scrollback') {
    return { ...body, data: raw.toString('utf8') } as unknown as Message;
  }
  return body as unknown as Message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A message from the link, or null when it is not one. A frame of an unknown kind is ignored, never thrown. */
export function parseLinkMessage(json: unknown): LinkToHelperMessage | null {
  if (!isRecord(json)) return null;
  if (json.t === 'command' && isRecord(json.command) && typeof json.command.type === 'string') return json as unknown as LinkToHelperMessage;
  if (json.t === 'request' && typeof json.id === 'number' && typeof json.method === 'string') return json as unknown as LinkToHelperMessage;
  if (json.t === 'port' && isRecord(json.message)) return json as unknown as LinkToHelperMessage;
  return null;
}

/** A message from the helper, or null when it is not one. */
export function parseHelperMessage(json: unknown): HelperToLinkMessage | null {
  if (!isRecord(json)) return null;
  if (json.t === 'event' && isRecord(json.event) && typeof json.event.type === 'string') return json as unknown as HelperToLinkMessage;
  if (json.t === 'reply' && typeof json.id === 'number') {
    // A failure must carry an error with a message: the link turns it into an Error for the caller.
    if (json.ok === true) return json as unknown as HelperToLinkMessage;
    if (json.ok === false && isRecord(json.error) && typeof json.error.message === 'string') return json as unknown as HelperToLinkMessage;
    return null;
  }
  if (json.t === 'port' && isRecord(json.message) && typeof json.message.type === 'string') return json as unknown as HelperToLinkMessage;
  return null;
}
