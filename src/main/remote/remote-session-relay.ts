/**
 * Everything that moves between this computer and a remote agent's session folder (#913).
 *
 * Kangentic's half of the WSL hook transport (`wsl-hook-inbox.ts`) reads a folder on this disk: events
 * the hooks published, requests to answer, the status line's JSON, and it writes its answers beside
 * them. For an agent on a host that folder exists twice, and this keeps the two in step:
 *
 * - At spawn, the files the builder wrote locally (settings, MCP config, the hook script) are pushed to
 *   the matching folder on the host, which the path map of the session's `ssh` place names. The hook
 *   folders are made there empty, and the helper starts watching them.
 * - What the helper sends back (`hookFile` events) is written into the same place on this disk, and the
 *   inbox's `signal` file gets its byte, so the existing reader finds it as it would for a distro.
 * - What the inbox answers (`responses/`) is sent to the host, where the hook script is waiting for it.
 *
 * Nothing the host sends picks a path: a record's name must have the exact shape the hook script
 * writes and the folder comes from the registration, so a host cannot write elsewhere on this disk.
 * MCP never crosses the link as a connection: the inbox relays each MCP message to the loopback server
 * here, at the server's address and with the token it has now, whatever the request names (`wsl-mcp-relay.ts`).
 * The agent's MCP config (owner-only, in the session folder) still carries a token, because the bridge sends
 * one with every request, but it is no longer the one that is checked, so it opens nothing off this computer
 * and goes stale harmlessly when the app restarts. A host is trusted like this computer, and what a host's
 * agents can reach is the same either way.
 *
 * A request is claimed on the host before it is acted on (`claimRequest`), so a call the script already gave up
 * on is never run, and an answer too large for a frame becomes an error that says so (`forwardResponses`).
 *
 * What the host sends is written synchronously, in the order it arrives (see `deliver`). Everything else
 * here is asynchronous.
 */

import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { localPathToHost, mirrorPathToHost, rootPathToHost, type SshCliPlace } from '../agent/shared/cli-target';
import { isPlainRelativePath } from '../agent/shared/remote-files';
import { wslHookPaths } from '../agent/shared/wsl-hook-transport';
import { oversizeAnswer } from '../pty/readers/wsl-mcp-relay';
import { MAX_FRAME_RAW_BYTES } from './protocol/frame-codec';
import type { PtyHostEvent } from '../pty/host/protocol';
import type { AgentParser, RemoteProgramRunner, RemoteResumeSeed, RemoteTranscriptFile, RemoteTranscriptIndex, RemoteTranscriptSearch, RemoteTranscriptSnapshot, StoredCliTarget } from '../../shared/types';
import type { HostCommandRequest, HostCommandResult, HostFileSearch, HostFileWrite } from './protocol/messages';

/** The helper's file jobs, as `RemoteHostService` offers them. */
export interface RemoteSessionFiles {
  writeFiles(hostId: string, files: HostFileWrite[], directories?: string[]): Promise<unknown>;
  writeFileRaw(hostId: string, filePath: string, content: string, mode?: number): Promise<unknown>;
  watchHooks(hostId: string, sessionId: string, directory: string, statusFile?: string): Promise<unknown>;
  unwatchHooks(hostId: string, sessionId: string): Promise<unknown>;
  /** `sizes` is what each file holds now, by key, and `searching` that `searches` is looked for. An older program answers neither. */
  watchFiles(hostId: string, sessionId: string, files: Array<{ key: string; path: string }>, searches?: HostFileSearch[]): Promise<{ sizes?: Record<string, number>; searching?: boolean } | undefined>;
  unwatchFiles(hostId: string, sessionId: string): Promise<unknown>;
  removeFiles(hostId: string, paths: string[]): Promise<unknown>;
  removeEmptyDirectories(hostId: string, paths: string[]): Promise<unknown>;
  runCommand(hostId: string, request: HostCommandRequest): Promise<HostCommandResult>;
}

/**
 * What a session's adapter says about its transcript, asked again as more is known. A registration's
 * `transcriptFiles` is the same answer at spawn; this is how it changes afterwards.
 */
export interface RemoteTranscriptSource {
  /** The files tailed by offset for this id, each by its path or a search. Empty while none can be named. */
  files(agentSessionId: string): readonly RemoteTranscriptFile[];
  /** Tailed from the start, with or without an id. Its growth asks `files` again and can name the id. */
  index?: RemoteTranscriptIndex;
  /** How to export a transcript that is no plain file. Null while none can be named. */
  snapshot?(agentSessionId: string, runProgram: RemoteProgramRunner): Promise<RemoteTranscriptSnapshot | null>;
}

/**
 * What a session's adapter says about its transcript on a host, asked again once the session's id or an index
 * entry arrives. A remote task works in one folder for its whole life, so `cwd` and the target hold.
 */
export function remoteTranscriptSource(parser: AgentParser | undefined, cwd: string, cliTarget: StoredCliTarget, sessionDirectory: string): RemoteTranscriptSource {
  const index = parser?.remoteTranscriptIndex?.({ cwd, cliTarget }) ?? null;
  const snapshotOf = parser?.remoteTranscriptSnapshot?.bind(parser);
  return {
    files: (agentSessionId) => parser?.remoteTranscriptFiles?.({ agentSessionId, cwd, cliTarget, sessionDirectory }) ?? [],
    ...(index ? { index } : {}),
    ...(snapshotOf ? { snapshot: (agentSessionId, runProgram) => snapshotOf({ agentSessionId, cwd, cliTarget, runProgram }) } : {}),
  };
}

export interface RemoteSessionRegistration {
  hostId: string;
  sessionId: string;
  place: SshCliPlace;
  /** The session's own folder on this computer (`<shell folder>/.kangentic/sessions/<id>`). */
  localSessionDirectory: string;
  /** Where the status line's JSON goes on this computer. */
  statusOutputPath: string;
  /**
   * More files of the session folder to send, relative to it (`AgentParser.remoteSessionFiles`). A
   * name that is not a plain relative path is refused, so an adapter cannot reach outside the folder.
   */
  extraFiles?: readonly string[];
  /**
   * Files the agent keeps appending to on the host, as the path its reader builds here, in this computer's
   * mirror of the host's home or under the project's shell folder (`AgentParser.remoteTranscriptFiles`). The
   * host sends each one's bytes as they are written, and they are written at the same offset here. A path
   * in neither place is refused.
   */
  transcriptFiles?: readonly RemoteTranscriptFile[];
  /** The conversation's id when the spawn has it. One that arrives later comes through `setAgentSessionId`. */
  agentSessionId?: string | null;
  /** How the transcript changes after spawn: a file found late, an index, an export. */
  transcripts?: RemoteTranscriptSource;
  /** A folder to copy on the host before the agent starts (`AgentParser.remoteResumeSeed`). */
  resumeSeed?: RemoteResumeSeed | null;
  /**
   * The agent is already running on the host, left there by a quit (#913). Its settings, MCP config and hook
   * script are in place and are not written again, since a CLI reads some of them as it runs; the host
   * watches its hooks and tails its files again, and the paths are still tracked so a release removes them.
   */
  reattach?: boolean;
}

/** A file opened to be written anywhere in, made when it is not there. */
function openForWriteAt(filePath: string): number {
  try {
    return fsSync.openSync(filePath, 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return fsSync.openSync(filePath, 'w+');
  }
}

type HookFileEvent = Extract<PtyHostEvent, { type: 'hookFile' }>;
type FileChunkEvent = Extract<PtyHostEvent, { type: 'fileChunk' }>;

/** The shape of a file name the hook script publishes: epoch nanoseconds, a pid, an extension. */
const INBOX_NAME = /^\d{19}-\d+\.rec$/;
const REQUEST_NAME = /^\d{19}-\d+\.req$/;
const RESPONSE_NAME = /^\d{19}-\d+\.res$/;
/**
 * Above this many bytes of JSON-encoded text a response goes in the frame's raw part, not its JSON
 * body. Counted in bytes after escaping, as the frame's cap is: three-byte text of 100k characters
 * would otherwise be 300 KB in a body capped at 256 KiB.
 */
const RESPONSE_JSON_LIMIT_BYTES = 100_000;
/** The most a raw frame carries (`MAX_FRAME_RAW_BYTES`), less what the request around it takes. */
const RESPONSE_RAW_LIMIT_BYTES = MAX_FRAME_RAW_BYTES - 4096;
const RESPONSE_POLL_MS = 100;
/** How long stored hook records wait to be removed from the host together. */
const CLAIM_BATCH_MS = 50;
/** The record names remembered per session. A host that sends one again does so within one attach. */
const STORED_RECORD_LIMIT = 2_000;

/** How soon after the start or an id's arrival the first export runs: a session has nothing to export before. */
const SNAPSHOT_FIRST_DELAY_MS = 5_000;
/** The shortest gap between exports. An unchanged export sends nothing, so an idle session costs one CLI run. */
const SNAPSHOT_MIN_INTERVAL_MS = 30_000;
/**
 * The gap grows with the export, so sending the whole file again never takes more than a sixth of the time.
 * The tail's backfill runs at about 1.2 MB a second, and a 100 MB export would otherwise never finish arriving.
 */
const SNAPSHOT_BYTES_PER_SECOND = 200_000;
/** An export of 100 MB measured about a second, so one past this is a host in trouble, and the next tick tries again. */
const SNAPSHOT_TIMEOUT_MS = 12_000;
/** The most a reader waits for an ending session's last export: the export's bound, its last pass, and a margin. */
const SETTLE_WAIT_MS = 30_000;

/**
 * Copies a folder an earlier session left on the host to where the new session reads it, as `cp -R` and a rename,
 * so a copy cut short is never taken for a whole one. It collects beside the target's parent, not in it: a CLI can
 * read every folder there as a session, and a timeout stops this script before it cleans up. A target already
 * there is left alone. Every value is an argument.
 */
const RESUME_SEED_SCRIPT = [
  'source=$1; target=$2',
  '[ -e "$target" ] && exit 0',
  '[ -d "$source" ] || { echo "the earlier session\'s folder is not on the host" >&2; exit 71; }',
  'mkdir -p "${target%/*}" || exit 70',
  'staged="${target%/*}.seed-$$"',
  'if cp -R "$source" "$staged" && mv "$staged" "$target"; then exit 0; fi',
  'rm -rf "$staged"',
  'exit 72',
].join('\n');

/**
 * Exports to a temporary file, then swaps it in only when it differs, so a host's tail sees a new file (and
 * sends it whole) exactly when there is something new. The export never crosses the link as output: a reply
 * is one frame, capped at 256 KiB. Every value is an argument, and the script holds none of the caller's text.
 * A `cmp` that is missing reads as a difference, which only costs one send. stderr is kept for the reason.
 *
 * The folder and the files are owner-only, because a CLI keeps these conversations in a folder that is, and a
 * host may be shared. The mask is put back before the CLI runs, so it writes its own store with its own modes.
 */
const SNAPSHOT_SCRIPT = [
  'target=$1; shift',
  'mask=$(umask); umask 077',
  'mkdir -p "${target%/*}" || exit 70',
  'staged="$target.$$.tmp"',
  ': > "$staged" && : > "$staged.err" || exit 70',
  'umask "$mask"',
  '"$@" > "$staged" 2> "$staged.err"',
  'status=$?',
  'if [ "$status" -eq 0 ] && [ ! -s "$staged" ]; then status=71; fi',
  'if [ "$status" -ne 0 ]; then head -c 400 "$staged.err" >&2; rm -f "$staged" "$staged.err"; exit "$status"; fi',
  'rm -f "$staged.err"',
  'if cmp -s "$staged" "$target"; then rm -f "$staged"; printf \'unchanged %s\\n\' "$(wc -c < "$target")"; exit 0; fi',
  'mv -f "$staged" "$target" || { rm -f "$staged"; exit 72; }',
  'printf \'replaced %s\\n\' "$(wc -c < "$target")"',
].join('\n');

/** What an export's script printed: its size, and whether a new file went up for the tail to send. */
export function readSnapshotAnswer(stdout: string): { replaced: boolean; bytes: number } | null {
  const match = /^(replaced|unchanged) +(\d+)\s*$/m.exec(stdout);
  return match ? { replaced: match[1] === 'replaced', bytes: Number(match[2]) } : null;
}

/** How long to wait before the next export, given the size of the last one. */
export function nextSnapshotDelayMs(lastBytes: number): number {
  return Math.max(SNAPSHOT_MIN_INTERVAL_MS, (lastBytes / SNAPSHOT_BYTES_PER_SECOND) * 1000);
}

type TailKind = 'file' | 'index' | 'snapshot';

interface Tail {
  localPath: string;
  kind: TailKind;
  /** How the host finds the file, when its name is not known here. */
  search?: RemoteTranscriptSearch;
  /** A chunk of this file has landed, so what the copy holds is this session's. */
  started?: boolean;
  /** Where an export's staged bytes end while none are missing. Null once a chunk could not be written. */
  stagedEnd?: number | null;
}

/** What one `watchFiles` asks of the host. */
interface TailRequest {
  files: Array<{ key: string; path: string }>;
  searches: HostFileSearch[];
}

function tailOfFile(file: RemoteTranscriptFile): Tail {
  return typeof file === 'string' ? { localPath: file, kind: 'file' } : { localPath: file.localPath, kind: 'file', search: file };
}

/** A search was asked for and the host's program did not say it looks. */
function programCannotSearch(request: TailRequest, answer: { searching?: boolean } | undefined): boolean {
  return request.searches.length > 0 && !answer?.searching;
}

/** Whether a session was told its program cannot search. The session entry holds it, once there is an entry. */
interface SearchWarning {
  warnedNoSearch: boolean;
}

/** Whether a chunk's offset is one the tail sends: a whole number, zero on a reset, and never past the size it reports. */
function isPlausibleOffset(event: FileChunkEvent): boolean {
  if (!Number.isSafeInteger(event.offset) || event.offset < 0) return false;
  if (event.reset && event.offset !== 0) return false;
  return typeof event.size !== 'number' || event.offset <= event.size;
}

interface SnapshotState {
  spec: RemoteTranscriptSnapshot;
  hostPath: string;
  /** A whole copy staged here that a rename could not put in place yet (a reader held the file on Windows). */
  pendingPromotion: boolean;
}

interface Registered extends RemoteSessionRegistration {
  localHooks: ReturnType<typeof wslHookPaths>;
  hostHooksDirectory: string;
  /** The files pushed to the host's session folder, removed when the session is released. */
  pushedPaths: string[];
  timer: ReturnType<typeof setInterval>;
  forwarding: boolean;
  /** Responses being sent, so a poll meanwhile never sends one twice. */
  inFlight: Set<string>;
  /** The last send failure logged, so one that repeats every poll is logged once. */
  lastFailure: string | null;
  /** The release under way, so a second one waits on it and asks the host nothing. */
  releaseDone: Promise<void> | null;
  /**
   * Hook records already stored on this computer, so a record the host sends again is acknowledged and not
   * written twice. Bounded: the oldest names go first, and a name this old is long gone from the host.
   */
  storedRecords: Set<string>;
  /** Stored records whose host copy is still to be removed, sent in one batch a moment after the first. */
  claimQueue: Set<string>;
  claimTimer: ReturnType<typeof setTimeout> | null;
  /** The transcript files the host sends, by the key it names them with, to where each is written here. */
  tails: Map<string, Tail>;
  /** The next key to hand out. A key is never reused, so a chunk still on its way cannot land in another file. */
  nextTailKey: number;
  /** The conversation's id, once known. */
  currentAgentSessionId: string | null;
  /** Changes to `tails` run one at a time, in order. */
  tailUpdate: Promise<void>;
  /** The host has been told to stop, so what is tailed no longer changes. */
  tailsClosed: boolean;
  /** The index's size before this session's agent ran, or null when new lines cannot be told from old. */
  indexBaseline: number | null;
  /** A read of the index is running, and whether it has grown since that read began. */
  indexRead: { running: boolean; again: boolean };
  /** The export this session is copying, once one can be named. */
  snapshot: SnapshotState | null;
  snapshotTimer: ReturnType<typeof setTimeout> | null;
  /** The export running now, so a tick never overlaps one and a release can wait for it. */
  snapshotRunning: Promise<void> | null;
  /** Resolves when the release has finished, so a reader of the last export can wait for it. */
  released: Promise<void>;
  markReleased: () => void;
  /** The last export failure logged, so one that repeats every tick is logged once. */
  lastSnapshotFailure: string | null;
  /** An export's chunk came with no size, which has been logged. */
  warnedNoSize: boolean;
  /** The host's program does not search for a file, which has been logged. */
  warnedNoSearch: boolean;
}

export interface RemoteSessionRelayOptions {
  files: RemoteSessionFiles;
  log?: (line: string) => void;
}

interface PendingRegistration {
  released: boolean;
  /** Resolves once this registration has finished, whichever way, cleanup included. */
  settled: Promise<void>;
  /** An id that arrived while the files were being pushed, for the entry to start from. */
  agentSessionId?: string;
}

export class RemoteSessionRelay {
  private readonly sessions = new Map<string, Registered>();
  /** Registrations still pushing files, so a release that arrives meanwhile is kept, not lost. */
  private readonly registering = new Map<string, PendingRegistration>();
  private sessionIdFound: (sessionId: string, agentSessionId: string) => void = () => undefined;

  constructor(private readonly options: RemoteSessionRelayOptions) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Told when a CLI's index names a fresh session's id, for an agent that prints none while it runs. */
  onSessionIdFound(listener: (sessionId: string, agentSessionId: string) => void): void {
    this.sessionIdFound = listener;
  }

  /**
   * The session's conversation id arrived after the start, or the agent moved to a new one. Repeat-safe: the
   * same id changes nothing. The transcript is asked for again, and a new id replaces what it names.
   */
  setAgentSessionId(sessionId: string, agentSessionId: string): void {
    const pending = this.registering.get(sessionId);
    if (pending) pending.agentSessionId = agentSessionId;
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.releaseDone || entry.currentAgentSessionId === agentSessionId) return;
    entry.currentAgentSessionId = agentSessionId;
    void this.refreshTails(entry);
    this.scheduleSnapshot(entry, SNAPSHOT_FIRST_DELAY_MS);
  }

  /**
   * Push the session's files to the host, start the host's watcher, and start forwarding answers.
   * Resolves once the host is watching, which is before the CLI is started. Rejects with the host's
   * own error when a push fails: a CLI whose hooks have nowhere to publish would run with no activity
   * and no plan approval, so the spawn must fail and say why.
   */
  async register(registration: RemoteSessionRegistration): Promise<void> {
    const { sessionId } = registration;
    // A second registration of one id replaces the first. The slot is claimed before the first await, so
    // two calls in one tick queue too. The earlier one is told to stop and waited for: both write the
    // same host paths, and its write landing last would leave its files in place.
    let settle = (): void => undefined;
    const pending: PendingRegistration = { released: false, settled: new Promise((resolve) => { settle = resolve; }) };
    const earlier = this.registering.get(sessionId);
    this.registering.set(sessionId, pending);
    try {
      if (earlier) {
        earlier.released = true;
        await earlier.settled;
      }
      await this.releaseSession(sessionId);
      // Released, or replaced by a newer registration, while it waited its turn: there is nothing to undo.
      if (pending.released) return;
      await this.pushSession(registration, pending);
    } finally {
      if (this.registering.get(sessionId) === pending) this.registering.delete(sessionId);
      settle();
    }
  }

  private async pushSession(registration: RemoteSessionRegistration, pending: PendingRegistration): Promise<void> {
    let hostHooksDirectory = '';
    let localHooks: ReturnType<typeof wslHookPaths>;
    const pushedPaths: string[] = [];
    const tails = new Map<string, Tail>();
    // A reattach is a new app process. The helper may still hold the previous watch of this
    // session, at the end of a file that has not grown. A key the helper has not seen makes that
    // watch a new tail from byte 0, so an older program that does not mark a drop still copies.
    let nextTailKey = registration.reattach ? Date.now() : 0;
    let indexBaseline: number | null = null;
    const searchWarning: SearchWarning = { warnedNoSearch: false };
    try {
      localHooks = wslHookPaths(registration.localSessionDirectory);
      const toHost = (localPath: string): string => localPathToHost(localPath, registration.place.roots);
      const hostHooks = wslHookPaths(toHost(registration.localSessionDirectory));
      hostHooksDirectory = toPosix(hostHooks.directory);

      const files: HostFileWrite[] = [];
      for (const [name, mode] of [['settings.json', 0o600], ['mcp.json', 0o600]] as const) {
        const content = await readIfPresent(path.join(registration.localSessionDirectory, name));
        if (content !== null) files.push({ path: toHost(path.join(registration.localSessionDirectory, name)), content, mode });
      }
      for (const relative of registration.extraFiles ?? []) {
        if (!isPlainRelativePath(relative)) {
          throw new Error(`${relative} is not a plain path inside the session folder, so it was not sent to the host.`);
        }
        const localFile = path.join(registration.localSessionDirectory, ...relative.split('/'));
        const content = await readIfPresent(localFile);
        if (content !== null) files.push({ path: toPosix(toHost(localFile)), content, mode: 0o600 });
      }
      const script = await readIfPresent(localHooks.script);
      if (script !== null) files.push({ path: toPosix(toHost(localHooks.script)), content: script, mode: 0o755 });
      pushedPaths.push(...files.map((file) => file.path));
      await this.options.files.writeFiles(
        registration.hostId,
        registration.reattach ? [] : files,
        ['inbox', 'requests', 'responses'].map((folder) => `${hostHooksDirectory}/${folder}`),
      );
      await this.options.files.watchHooks(registration.hostId, registration.sessionId, hostHooksDirectory, toPosix(toHost(registration.statusOutputPath)));
      if (registration.resumeSeed) await this.copyResumeSeed(registration, registration.resumeSeed);
      // The transcript is extra: an agent with no transcript here still runs. A host that cannot tail it
      // costs the conversation viewer, not the session.
      const wanted: Tail[] = [
        ...(registration.transcripts?.index ? [{ localPath: registration.transcripts.index.path, kind: 'index' as const }] : []),
        ...(registration.transcriptFiles ?? []).map(tailOfFile),
      ];
      const tailRequest: TailRequest = { files: [], searches: [] };
      for (const tail of wanted) {
        const key = String(nextTailKey);
        nextTailKey += 1;
        if (this.addToRequest(registration, key, tail, tailRequest)) tails.set(key, tail);
      }
      if (tails.size > 0) {
        try {
          const answer = await this.options.files.watchFiles(registration.hostId, registration.sessionId, tailRequest.files, tailRequest.searches);
          // Read before the agent starts, so what lies past it is what this session's agent adds. A file with
          // no entry is not there yet. No sizes at all is an older program on the host, and with nothing to
          // tell new lines from old, no id is taken: a wrong one would stick, and resume someone else's.
          const indexKey = [...tails].find(([, tail]) => tail.kind === 'index')?.[0];
          if (indexKey !== undefined) indexBaseline = answer?.sizes ? answer.sizes[indexKey] ?? 0 : null;
          this.noteSearchAnswer(registration.sessionId, searchWarning, tailRequest, answer);
        } catch (error) {
          tails.clear();
          this.options.log?.(`could not tail the transcript for ${registration.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
          // The host may have started before its answer was lost, and with no tails no release would stop it.
          void this.options.files.unwatchFiles(registration.hostId, registration.sessionId).catch(() => undefined);
        }
      }
    } catch (error) {
      // The spawn fails, so nothing releases a session that was never registered: what was pushed (the
      // settings and the MCP config, which holds the token) is removed here, as a release would. A reattach
      // pushed nothing, and the running agent still reads those files.
      if (pushedPaths.length > 0) {
        await this.options.files.unwatchHooks(registration.hostId, registration.sessionId).catch(() => undefined);
        if (!registration.reattach) await this.removePushedFiles(registration.hostId, registration.sessionId, pushedPaths, hostHooksDirectory).catch(() => undefined);
      }
      throw error;
    }
    if (pending.released) {
      // Released while its files were being pushed (the spawn was torn down): the host stops watching now.
      await this.options.files.unwatchHooks(registration.hostId, registration.sessionId).catch(() => undefined);
      if (tails.size > 0) await this.options.files.unwatchFiles(registration.hostId, registration.sessionId).catch(() => undefined);
      if (!registration.reattach) await this.removePushedFiles(registration.hostId, registration.sessionId, pushedPaths, hostHooksDirectory);
      return;
    }

    let markReleased = (): void => undefined;
    const released = new Promise<void>((resolve) => { markReleased = resolve; });
    const entry: Registered = {
      ...registration,
      released,
      markReleased,
      localHooks,
      hostHooksDirectory,
      pushedPaths,
      forwarding: false,
      inFlight: new Set(),
      lastFailure: null,
      releaseDone: null,
      storedRecords: new Set(),
      claimQueue: new Set(),
      claimTimer: null,
      tails,
      nextTailKey,
      currentAgentSessionId: pending.agentSessionId ?? registration.agentSessionId ?? null,
      tailUpdate: Promise.resolve(),
      tailsClosed: false,
      indexBaseline,
      indexRead: { running: false, again: false },
      snapshot: null,
      snapshotTimer: null,
      snapshotRunning: null,
      lastSnapshotFailure: null,
      warnedNoSize: false,
      warnedNoSearch: searchWarning.warnedNoSearch,
      timer: setInterval(() => void this.forwardResponses(registration.sessionId), RESPONSE_POLL_MS),
    };
    entry.timer.unref?.();
    this.sessions.set(registration.sessionId, entry);
    // An id that came in while the files were being pushed, or a file its id names only now.
    if (entry.currentAgentSessionId !== (registration.agentSessionId ?? null)) void this.refreshTails(entry);
    if (entry.transcripts?.snapshot) this.scheduleSnapshot(entry, SNAPSHOT_FIRST_DELAY_MS);
  }

  /**
   * Copy what the agent's resume needs into the session's new folder on the host, before the agent starts. A
   * failure costs the earlier conversation, not the session, which starts empty and says why in the log.
   */
  private async copyResumeSeed(registration: RemoteSessionRegistration, seed: RemoteResumeSeed): Promise<void> {
    const source = rootPathToHost(seed.source, registration.place);
    const target = rootPathToHost(seed.target, registration.place);
    try {
      if (source === null || target === null) throw new Error('the folder is outside the project');
      const result = await this.options.files.runCommand(registration.hostId, {
        file: 'sh',
        args: ['-c', RESUME_SEED_SCRIPT, 'sh', source, target],
        timeoutMs: SNAPSHOT_TIMEOUT_MS,
      });
      if (result.code !== 0) throw new Error(result.error ?? (result.timedOut ? 'the copy timed out' : (lastLine(result.stderr) || `the copy exited ${String(result.code)}`)));
    } catch (error) {
      this.options.log?.(`could not bring the earlier conversation over for ${registration.sessionId.slice(0, 8)}, so it starts empty: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * A path here as the host names it: in the mirror of the host's home, or under a root (a session or working
   * folder). Any other is refused here, so it never reaches the host and nothing is written to it.
   */
  private hostPathOf(registration: RemoteSessionRegistration, localPath: string): string | null {
    const hostPath = mirrorPathToHost(localPath, registration.place) ?? rootPathToHost(localPath, registration.place);
    if (hostPath === null) {
      this.options.log?.(`not tailing ${path.basename(localPath)} for ${registration.sessionId.slice(0, 8)}: it is in neither the mirror of the host's home nor the project's folder`);
    }
    return hostPath;
  }

  /** Add one tail to what the host is asked. False when either of its paths is refused. */
  private addToRequest(registration: RemoteSessionRegistration, key: string, tail: Tail, request: TailRequest): boolean {
    // Asked of a search too, as the check that its copy lands where a copy may. Only a plain file goes by this path.
    const hostPath = this.hostPathOf(registration, tail.localPath);
    if (hostPath === null) return false;
    if (!tail.search) {
      request.files.push({ key, path: hostPath });
      return true;
    }
    const directory = this.hostPathOf(registration, tail.search.directory);
    if (directory === null) return false;
    request.searches.push({ key, directory, depth: tail.search.depth, fileName: tail.search.fileName });
    return true;
  }

  /** Say once, per session, that an older program on the host ignored a search. */
  private noteSearchAnswer(sessionId: string, warning: SearchWarning, request: TailRequest, answer: { searching?: boolean } | undefined): void {
    if (warning.warnedNoSearch || !programCannotSearch(request, answer)) return;
    warning.warnedNoSearch = true;
    this.options.log?.(`the host's program cannot search for a transcript, so the one of ${sessionId.slice(0, 8)} is not copied. Restart the program on the host.`);
  }

  /** Bring what the host tails in line with what is known now. One at a time, and a failure keeps what was tailing. */
  private refreshTails(entry: Registered): Promise<void> {
    entry.tailUpdate = entry.tailUpdate.then(() => this.applyTails(entry)).catch((error: unknown) => {
      this.options.log?.(`could not change what is tailed for ${entry.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return entry.tailUpdate;
  }

  private async applyTails(entry: Registered): Promise<void> {
    if (entry.tailsClosed) return;
    const agentSessionId = entry.currentAgentSessionId;
    const wanted = new Map<string, Tail>();
    const want = (tail: Tail): void => void wanted.set(tail.localPath, tail);
    if (entry.transcripts?.index) want({ localPath: entry.transcripts.index.path, kind: 'index' });
    if (entry.transcripts && agentSessionId) {
      for (const file of entry.transcripts.files(agentSessionId)) want(tailOfFile(file));
    } else if (!entry.transcripts) {
      for (const file of entry.transcriptFiles ?? []) want(tailOfFile(file));
    }
    if (entry.snapshot) want({ localPath: entry.snapshot.spec.localPath, kind: 'snapshot' });

    const held = [...entry.tails.values()].map((tail) => tail.localPath);
    if (held.length === wanted.size && held.every((localPath) => wanted.has(localPath))) return;

    const tails = new Map<string, Tail>();
    const request: TailRequest = { files: [], searches: [] };
    let nextTailKey = entry.nextTailKey;
    for (const [localPath, tail] of wanted) {
      const kept = [...entry.tails].find(([, heldTail]) => heldTail.localPath === localPath);
      const key = kept ? kept[0] : String(nextTailKey);
      if (!this.addToRequest(entry, key, tail, request)) continue;
      if (!kept) nextTailKey += 1;
      tails.set(key, kept ? kept[1] : tail);
    }
    // The tail keys are set first: a chunk can land before the host's answer does, and an unknown key is dropped.
    const previous = entry.tails;
    entry.tails = tails;
    entry.nextTailKey = nextTailKey;
    try {
      const answer = await this.options.files.watchFiles(entry.hostId, entry.sessionId, request.files, request.searches);
      this.noteSearchAnswer(entry.sessionId, entry, request, answer);
    } catch (error) {
      entry.tails = previous;
      throw error;
    }
  }

  /** Run the export after `delayMs`, in place of any tick already waiting. */
  private scheduleSnapshot(entry: Registered, delayMs: number): void {
    // Checked against the map too: after a dispose nothing else stops a tick that was running from starting the next.
    if (!entry.transcripts?.snapshot || entry.releaseDone || this.sessions.get(entry.sessionId) !== entry) return;
    if (entry.snapshotTimer) clearTimeout(entry.snapshotTimer);
    entry.snapshotTimer = setTimeout(() => void this.snapshotTick(entry), delayMs);
    entry.snapshotTimer.unref?.();
  }

  private async snapshotTick(entry: Registered): Promise<void> {
    entry.snapshotTimer = null;
    let delayMs = SNAPSHOT_MIN_INTERVAL_MS;
    if (entry.currentAgentSessionId && !entry.snapshotRunning) {
      const bytes = await this.runSnapshot(entry);
      if (bytes !== null) delayMs = nextSnapshotDelayMs(bytes);
    }
    this.scheduleSnapshot(entry, delayMs);
  }

  /** One export, with its size as the answer. Null when it could not run: the copy here stays as it was. */
  private runSnapshot(entry: Registered): Promise<number | null> {
    let finish = (): void => undefined;
    entry.snapshotRunning = new Promise((resolve) => { finish = resolve; });
    return this.exportAndTail(entry).catch((error: unknown) => {
      this.noteSnapshotFailure(entry, error instanceof Error ? error.message : String(error));
      return null;
    }).finally(() => {
      entry.snapshotRunning = null;
      finish();
      this.retryPromotion(entry);
    });
  }

  private async exportAndTail(entry: Registered): Promise<number | null> {
    const agentSessionId = entry.currentAgentSessionId;
    if (!agentSessionId || !entry.transcripts?.snapshot) return null;
    await this.earlierReleases(entry, agentSessionId);
    const spec = await entry.transcripts.snapshot(agentSessionId, async (file, args) => {
      const result = await this.options.files.runCommand(entry.hostId, { file, args: [...args], timeoutMs: SNAPSHOT_TIMEOUT_MS });
      return { code: result.code, stdout: result.stdout };
    });
    if (!spec) return null;
    const hostPath = this.hostPathOf(entry, spec.localPath);
    if (hostPath === null) return null;
    let supersededSnapshot: SnapshotState | null = null;
    if (entry.snapshot?.spec.localPath !== spec.localPath) {
      supersededSnapshot = entry.snapshot;
      entry.snapshot = { spec, hostPath, pendingPromotion: false };
      if (!entry.pushedPaths.includes(hostPath)) entry.pushedPaths.push(hostPath);
    }
    // Asked on every export, not only the first: a watch that failed keeps the file off this computer, and an
    // export that changed nothing gives the host no other reason to send it.
    if (![...entry.tails.values()].some((tail) => tail.localPath === spec.localPath)) await this.refreshTails(entry);
    // An id that moved on. Its copy stays, but nothing finishes what it left staged.
    if (supersededSnapshot && (!supersededSnapshot.pendingPromotion || this.promoteSnapshot(entry, supersededSnapshot.spec.localPath))) this.dropStagedSnapshot(supersededSnapshot);
    const result = await this.options.files.runCommand(entry.hostId, {
      file: 'sh',
      args: ['-c', SNAPSHOT_SCRIPT, 'sh', hostPath, spec.file, ...spec.args],
      cwd: spec.cwd,
      timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    const answer = result.code === 0 ? readSnapshotAnswer(result.stdout) : null;
    if (!answer) {
      this.noteSnapshotFailure(entry, result.error ?? (result.timedOut ? 'the export timed out' : (lastLine(result.stderr) || `the export exited ${String(result.code)}`)));
      return null;
    }
    entry.lastSnapshotFailure = null;
    return answer.bytes;
  }

  /**
   * A resume is a new session on the same conversation, so it shares the export's paths on both computers with
   * the session it replaces, which may still be in its last export and removes those paths after it. The older
   * one finishes first. Only older entries, in the map's order, so two ending together never wait on each other.
   */
  private async earlierReleases(entry: Registered, agentSessionId: string): Promise<void> {
    for (const other of this.sessions.values()) {
      if (other === entry) return;
      if (other.releaseDone && other.hostId === entry.hostId && other.currentAgentSessionId === agentSessionId) await other.released;
    }
  }

  /** Before a session's first turn there is nothing to export, so a failure is ordinary and is logged only once. */
  private noteSnapshotFailure(entry: Registered, message: string): void {
    if (message !== entry.lastSnapshotFailure) {
      this.options.log?.(`could not export the transcript for ${entry.sessionId.slice(0, 8)}: ${message}`);
    }
    entry.lastSnapshotFailure = message;
  }

  /** Stop forwarding and ask the host to stop watching, after it sends what is published. Never throws. */
  async release(sessionId: string): Promise<void> {
    // With a session running, this is that session ending. A registration queued behind it is a newer spawn
    // of the id, and it goes on: cancelled here it would start an agent with no hooks.
    if (!this.sessions.has(sessionId)) {
      const pending = this.registering.get(sessionId);
      if (pending) pending.released = true;
    }
    await this.releaseSession(sessionId);
  }

  private async releaseSession(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    // A repeat waits for the first: `register` must not push this id's files until the old ones are gone,
    // or the release still running deletes what it just wrote.
    entry.releaseDone ??= this.finishRelease(sessionId, entry);
    await entry.releaseDone;
  }

  private async finishRelease(sessionId: string, entry: Registered): Promise<void> {
    clearInterval(entry.timer);
    if (entry.snapshotTimer) clearTimeout(entry.snapshotTimer);
    entry.snapshotTimer = null;
    // The registration stays until the host has answered: the records it flushes on the way out
    // arrive first, and `deliver` drops what it has no registration for.
    await this.options.files.unwatchHooks(entry.hostId, sessionId).catch((error: unknown) => {
      this.options.log?.(`could not stop the host watching ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    });
    // The records that flush stored are removed from the host now, not a moment later.
    if (entry.claimTimer) clearTimeout(entry.claimTimer);
    entry.claimTimer = null;
    await this.flushClaims(entry);
    // A last export, for what the session did since the one before. Bounded by the run's own timeout, and a
    // failure leaves the last whole copy. It can be the first one: a session shorter than the first tick.
    if (entry.transcripts?.snapshot && entry.currentAgentSessionId) {
      await entry.snapshotRunning;
      await this.runSnapshot(entry);
    }
    await entry.tailUpdate;
    entry.tailsClosed = true;
    // The host's last pass arrives before this answers, so a tail that had caught up leaves the whole
    // transcript in the copy here. One still backfilling can stop short, and the next session here starts over.
    if (entry.tails.size > 0) {
      await this.options.files.unwatchFiles(entry.hostId, sessionId).catch((error: unknown) => {
        this.options.log?.(`could not stop the host tailing ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    this.retryPromotion(entry);
    this.dropStagedSnapshot(entry.snapshot);
    // The session is over: its settings and MCP config (which holds the MCP token) leave the host's session folder.
    await this.removePushedFiles(entry.hostId, sessionId, entry.pushedPaths, entry.hostHooksDirectory);
    if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
    entry.markReleased();
  }

  /**
   * For a reader of a session that is ending: resolves once the last export is in the copy, or after
   * `SETTLE_WAIT_MS` if the release is held up. Null when there is nothing to wait for: a transcript tailed
   * by offset is already here, and a session already released has its last export in place.
   */
  transcriptSettled(sessionId: string): Promise<void> | null {
    const entry = this.sessions.get(sessionId);
    if (!entry?.transcripts?.snapshot) return null;
    return new Promise((resolve) => {
      const giveUp = setTimeout(resolve, SETTLE_WAIT_MS);
      giveUp.unref?.();
      void entry.released.then(() => {
        clearTimeout(giveUp);
        resolve();
      });
    });
  }

  /**
   * Best-effort: a host out of reach keeps the files until the next session there, and nothing else
   * depends on them. The folders the session made go too when nothing is left in them: the hook
   * folders, then the session's own (a folder with anything in it stays).
   */
  private async removePushedFiles(hostId: string, sessionId: string, paths: string[], hooksDirectory?: string): Promise<void> {
    // A session with no files of its own (an agent without a hook script) still made the hook folders.
    if (paths.length === 0 && !hooksDirectory) return;
    try {
      // The hook script's own marker file is not one this relay pushed, so it is named here.
      await this.options.files.removeFiles(hostId, hooksDirectory ? [...paths, `${hooksDirectory}/signal`] : paths);
      if (hooksDirectory) {
        const sessionFolder = hooksDirectory.replace(/\/wsl-hooks$/, '');
        const folders = ['inbox', 'requests', 'responses'].map((folder) => `${hooksDirectory}/${folder}`);
        // Deepest first, so a parent is empty by the time it is asked for. Each pushed file's own
        // folder (an agent's config folder) goes the same way.
        const fileFolders = [...new Set(paths.map((filePath) => filePath.slice(0, filePath.lastIndexOf('/'))))]
          .filter((folder) => folder.startsWith(`${sessionFolder}/`))
          .sort((left, right) => right.length - left.length);
        await this.options.files.removeEmptyDirectories(hostId, [...folders, ...fileFolders, hooksDirectory, sessionFolder]);
      }
    } catch (error) {
      this.options.log?.(`could not remove the session files from the host for ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Write one file the host sent into the hook folder on this disk. A file of any other shape is dropped.
   *
   * Synchronous, so a record is on disk before the next event of the stream is handled: the host sends
   * a session's last records ahead of its exit, and the exit handling flushes the inbox, which must
   * already hold them. A record is a few KB, written once per hook call.
   */
  deliver(event: HookFileEvent): void {
    const entry = this.sessions.get(event.sessionId);
    if (!entry) return;
    try {
      if (event.folder === 'status') {
        if (event.name !== 'status.json') return;
        writeAtomicallySync(entry.statusOutputPath, event.content);
        return;
      }
      const pattern = event.folder === 'inbox' ? INBOX_NAME : REQUEST_NAME;
      if (!pattern.test(event.name)) {
        this.options.log?.(`dropped a hook file with an unexpected name for ${event.sessionId.slice(0, 8)}`);
        return;
      }
      // A request is claimed on the host before anything here acts on it, and handed on only if this computer
      // won: the script that wrote it may have given up and told the agent so, and the call must not run then.
      if (event.folder === 'requests' && event.claim === true) {
        void this.claimRequest(entry, event);
        return;
      }
      // A record the host keeps until it is told it is stored: written here first, then the host's copy is
      // removed. One it sends again (a new app process attached before the removal landed) is only removed.
      // A write that failed stored nothing, so the host keeps its copy and the next attach sends it again.
      if (event.folder === 'inbox' && event.claim === true) {
        if (!entry.storedRecords.has(event.name)) {
          if (!this.writeHookFile(entry, entry.localHooks.inbox, event)) return;
          entry.storedRecords.add(event.name);
          if (entry.storedRecords.size > STORED_RECORD_LIMIT) entry.storedRecords.delete(entry.storedRecords.values().next().value as string);
        }
        this.queueClaim(entry, event.name);
        return;
      }
      this.writeHookFile(entry, event.folder === 'inbox' ? entry.localHooks.inbox : entry.localHooks.requests, event);
    } catch (error) {
      this.options.log?.(`could not write a hook file for ${event.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Remove the host's copy of the stored records, a batch at a time. A failure keeps them queued for the next batch. */
  private queueClaim(entry: Registered, name: string): void {
    entry.claimQueue.add(name);
    if (entry.claimTimer) return;
    entry.claimTimer = setTimeout(() => {
      entry.claimTimer = null;
      void this.flushClaims(entry);
    }, CLAIM_BATCH_MS);
    entry.claimTimer.unref?.();
  }

  private async flushClaims(entry: Registered): Promise<void> {
    if (entry.claimQueue.size === 0) return;
    const names = [...entry.claimQueue];
    entry.claimQueue.clear();
    try {
      await this.options.files.removeFiles(entry.hostId, names.map((name) => `${entry.hostHooksDirectory}/inbox/${name}`));
    } catch (error) {
      // Still on the host, so it is sent again on the next attach and acknowledged then.
      for (const name of names) entry.claimQueue.add(name);
      this.options.log?.(`could not remove stored records from the host for ${entry.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Write one delivered file into the local hook folder and wake the reader that watches it. False when it was not written. */
  private writeHookFile(entry: Registered, folder: string, event: HookFileEvent): boolean {
    try {
      writeAtomicallySync(path.join(folder, event.name), event.content);
    } catch (error) {
      this.options.log?.(`could not write a hook file for ${event.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    // The reader watches this file, as it does for a distro; a byte is what wakes it.
    try {
      // sync-write-ok: the reader also polls, so a missed byte costs 250 ms.
      fsSync.appendFileSync(entry.localHooks.signal, 'x');
    } catch {
      // The polling reader still finds the file.
    }
    return true;
  }

  /**
   * Take a request off the host, and hand it to the reader only when the removal was ours. The host's copy is
   * the one the script waits beside: when it is gone the call is ours (the script waits for the answer), and
   * when it was already gone the script gave up and told the agent, so the call is dropped. A failed removal
   * (the link went down between the frame and here) drops it too: the script ends the wait with its own error.
   */
  private async claimRequest(entry: Registered, event: HookFileEvent): Promise<void> {
    const hostFile = `${entry.hostHooksDirectory}/requests/${event.name}`;
    try {
      const answer = await this.options.files.removeFiles(entry.hostId, [hostFile]) as { removed?: number } | undefined;
      if (answer?.removed !== 1) return;
    } catch (error) {
      this.options.log?.(`could not claim a request from the host for ${event.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    // The session may have been released while the claim was on its way.
    if (this.sessions.get(event.sessionId) !== entry) return;
    this.writeHookFile(entry, entry.localHooks.requests, event);
  }

  /**
   * Write a piece of a file the host is tailing (a transcript) at its offset in this computer's copy. A key
   * the session did not register is dropped, so a host cannot name a path here: it names only what the app
   * asked it to send. Synchronous and in the stream's order, like `deliver`, so the copy is whole before the
   * session's exit is handled, and a chunk is at most a couple of hundred KB.
   */
  deliverChunk(event: FileChunkEvent): void {
    const entry = this.sessions.get(event.sessionId);
    const tail = entry?.tails.get(event.key);
    if (!entry || !tail) return;
    // The tail never sends these. A host that did would leave a hole in the copy, or a huge sparse file here.
    if (!isPlausibleOffset(event)) {
      this.options.log?.(`dropped a transcript chunk with an impossible offset for ${event.sessionId.slice(0, 8)}`);
      return;
    }
    const isSnapshot = tail.kind === 'snapshot';
    const startsOver = event.reset || event.offset === 0;
    // Nothing resends a chunk, so one that does not follow the last means this export has a piece missing: a
    // write failed here, or the staged file went. The size would still come out right and a hole would read as
    // whole, so this transfer stops here, the last whole copy stands, and the next export starts over.
    if (isSnapshot && !startsOver && tail.stagedEnd !== event.offset) return;
    // An export is one document, so the copy a reader opens is only ever a whole one. The last whole copy
    // stays in place until the next is complete: a stale copy never reads as an empty one.
    const target = isSnapshot ? stagedPath(tail.localPath) : tail.localPath;
    let written = -1;
    let chunkEnd = event.offset;
    try {
      // Inside this try: a failure is logged and the next chunk tries again.
      fsSync.mkdirSync(path.dirname(target), { recursive: true });
      // Read and write without append mode, which would put every write at the end whatever its offset.
      // Only an export's first chunk may make its staged file: a later one that makes it starts with a hole.
      const descriptor = isSnapshot && !startsOver ? fsSync.openSync(target, 'r+') : openForWriteAt(target);
      try {
        // The first chunk of an export empties what an earlier one left that never finished arriving. So does
        // this session's first chunk of a copy longer than the host's file, which is what an earlier session
        // left of a file that has since got shorter: nothing else would remove the bytes past its end. Only a
        // conversation's own file: every session tails a shared index, and two can read its size out of order.
        const staleCopy = tail.kind === 'file' && !tail.started && typeof event.size === 'number' && fsSync.fstatSync(descriptor).size > event.size;
        if (isSnapshot ? startsOver : event.reset || staleCopy) fsSync.ftruncateSync(descriptor, 0);
        tail.started = true;
        const bytes = Buffer.from(event.data, 'base64');
        if (bytes.length > 0) fsSync.writeSync(descriptor, bytes, 0, bytes.length, event.offset);
        chunkEnd += bytes.length;
        if (isSnapshot) {
          written = fsSync.fstatSync(descriptor).size;
          tail.stagedEnd = chunkEnd;
        }
      } finally {
        fsSync.closeSync(descriptor);
      }
    } catch (error) {
      if (isSnapshot) tail.stagedEnd = null;
      this.options.log?.(`could not write the transcript for ${event.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (isSnapshot) {
      if (typeof event.size !== 'number') {
        // An older program on the host: the daemon outlives an update of the app, and joins under one version.
        if (!entry.warnedNoSize) this.options.log?.(`the host's program sends no file size, so the transcript of ${entry.sessionId.slice(0, 8)} cannot be told whole. Restart the program on the host.`);
        entry.warnedNoSize = true;
      } else if (event.size > 0 && written === event.size) {
        this.promoteSnapshot(entry, tail.localPath);
      }
    }
    if (tail.kind === 'index') {
      // A reset means a line past the baseline need not be new, so the id is left to the agent's exit.
      if (event.reset) entry.indexBaseline = null;
      // An index lists every project on the host, and a backfill of it arrives in many chunks. One read at the
      // end does for all of them: each read parses the whole copy, on this thread.
      if (typeof event.size !== 'number' || chunkEnd >= event.size) void this.readIndex(entry);
    }
  }

  /**
   * Put a whole staged export in place, and say whether it went. A reader holding the copy on Windows fails
   * this, and it is tried again.
   */
  private promoteSnapshot(entry: Registered, localPath: string): boolean {
    const pending = entry.snapshot?.spec.localPath === localPath ? entry.snapshot : null;
    try {
      fsSync.renameSync(stagedPath(localPath), localPath);
      if (pending) pending.pendingPromotion = false;
      return true;
    } catch (error) {
      if (pending) pending.pendingPromotion = true;
      this.options.log?.(`could not put the transcript in place for ${entry.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private retryPromotion(entry: Registered): void {
    if (entry.snapshot?.pendingPromotion) this.promoteSnapshot(entry, entry.snapshot.spec.localPath);
  }

  /** What is left staged when nothing more will arrive for it never finished. The last whole copy stands. */
  private dropStagedSnapshot(snapshot: SnapshotState | null): void {
    if (!snapshot) return;
    try {
      fsSync.rmSync(stagedPath(snapshot.spec.localPath), { force: true });
    } catch {
      // A leftover is emptied by the next export's first chunk.
    }
  }

  /**
   * The index grew: its transcript may be named now, and a fresh session's id may be in the lines past the
   * baseline. A chunk arrives at a time, so a read that is running is asked to go round once more.
   */
  private async readIndex(entry: Registered): Promise<void> {
    if (entry.indexRead.running) {
      entry.indexRead.again = true;
      return;
    }
    entry.indexRead.running = true;
    try {
      do {
        entry.indexRead.again = false;
        await this.refreshTails(entry);
        await this.findSessionId(entry);
      } while (entry.indexRead.again && !entry.releaseDone);
    } catch (error) {
      this.options.log?.(`could not read the session index for ${entry.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      entry.indexRead.running = false;
    }
  }

  /**
   * Name a fresh session's id from the lines its agent added. Assigned only when it can be nothing else: a
   * wrong id would resume another conversation, so two sessions waiting in one folder get none, and each keeps
   * the agent's own report at exit.
   */
  private async findSessionId(entry: Registered): Promise<void> {
    const index = entry.transcripts?.index;
    if (!index || entry.currentAgentSessionId !== null || entry.indexBaseline === null) return;
    const content = await fs.readFile(index.path).catch(() => null);
    if (!content || content.length <= entry.indexBaseline) return;
    const others = [...this.sessions.values()].filter((other) => other !== entry && other.hostId === entry.hostId && other.transcripts?.index?.path === index.path);
    if (others.some((other) => other.currentAgentSessionId === null && other.transcripts?.index?.folder === index.folder)) return;
    const claimed = new Set(others.map((other) => other.currentAgentSessionId));
    const candidates = index.sessionIdsIn(content.subarray(entry.indexBaseline).toString('utf8')).filter((id) => !claimed.has(id));
    if (candidates.length === 1 && entry.currentAgentSessionId === null) this.sessionIdFound(entry.sessionId, candidates[0]);
  }

  dispose(): void {
    // A push still running ends in its own released path instead of starting a timer on a shut-down link.
    for (const pending of this.registering.values()) pending.released = true;
    for (const entry of this.sessions.values()) {
      clearInterval(entry.timer);
      if (entry.snapshotTimer) clearTimeout(entry.snapshotTimer);
      // Nothing will finish a release now, and a reader waiting on one should not sit out its bound.
      entry.markReleased();
    }
    this.sessions.clear();
  }

  /** Send each answer the inbox wrote to the host, where the hook script is waiting for it, then remove it here. */
  private async forwardResponses(sessionId: string): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.forwarding) return;
    entry.forwarding = true;
    try {
      const names = (await fs.readdir(entry.localHooks.responses).catch(() => [] as string[])).filter((name) => RESPONSE_NAME.test(name)).sort();
      for (const name of names) {
        if (entry.inFlight.has(name)) continue;
        entry.inFlight.add(name);
        const file = path.join(entry.localHooks.responses, name);
        try {
          let content = await fs.readFile(file, 'utf8');
          const target = `${entry.hostHooksDirectory}/responses/${name}`;
          // A raw body over the frame cap is refused by the link on every try, so the agent would wait for it
          // for good. An error with the request's id says what happened and ends the wait.
          const rawBytes = Buffer.byteLength(content, 'utf8');
          if (rawBytes > RESPONSE_RAW_LIMIT_BYTES) {
            const replacement = oversizeAnswer(content, rawBytes, RESPONSE_RAW_LIMIT_BYTES);
            this.options.log?.(`an answer of ${rawBytes} bytes is too large to send to the host for ${sessionId.slice(0, 8)}`);
            if (replacement === null) {
              // A notification's answer: nobody waits on it.
              await fs.rm(file, { force: true });
              continue;
            }
            content = replacement;
          }
          if (Buffer.byteLength(JSON.stringify(content), 'utf8') > RESPONSE_JSON_LIMIT_BYTES) {
            await this.options.files.writeFileRaw(entry.hostId, target, content, 0o600);
          } else {
            await this.options.files.writeFiles(entry.hostId, [{ path: target, content, mode: 0o600 }]);
          }
          await fs.rm(file, { force: true });
          entry.lastFailure = null;
        } catch (error) {
          // Kept, so the next poll sends it again. A failure that repeats is logged once.
          const message = error instanceof Error ? error.message : String(error);
          if (message !== entry.lastFailure) this.options.log?.(`could not send an answer to the host: ${message}`);
          entry.lastFailure = message;
        } finally {
          entry.inFlight.delete(name);
        }
      }
    } finally {
      entry.forwarding = false;
    }
  }
}

/**
 * What a failed export said last, which is the reason. An interactive shell opens stderr with its own lines
 * (`cannot set terminal process group (1199)`), which can hold a pid, so all of it would never repeat.
 */
function lastLine(text: string): string {
  return text.trim().split('\n').at(-1)?.trim() ?? '';
}

/** Where an export collects as it arrives, beside the copy a reader opens. */
function stagedPath(localPath: string): string {
  return `${localPath}.part`;
}

/** A host path in forward slashes. The path map yields them; this guards the places that join one. */
function toPosix(hostPath: string): string {
  return hostPath.replace(/\\/g, '/');
}

async function readIfPresent(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

let stagingCounter = 0;

/**
 * Write beside the file and rename in: a reader never sees half of one, and a name with a leading dot
 * is skipped by it. Throws on failure; the caller logs it, and the host's copy is already gone, so a
 * failure here loses one record, as a failed append to the events file does on this computer.
 */
function writeAtomicallySync(target: string, content: string): void {
  stagingCounter += 1;
  const staging = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${stagingCounter}.tmp`);
  try {
    // sync-write-ok: ordered delivery (see `deliver`); a throw is caught there and logged.
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    // sync-write-ok: as above.
    fsSync.writeFileSync(staging, content, 'utf8');
    // sync-write-ok: as above.
    fsSync.renameSync(staging, target);
  } finally {
    fsSync.rmSync(staging, { force: true });
  }
}
