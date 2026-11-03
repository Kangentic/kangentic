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
 * The MCP token is never sent: the inbox relays each MCP message to the loopback server here.
 *
 * What the host sends is written synchronously, in the order it arrives (see `deliver`). Everything else
 * here is asynchronous.
 */

import * as fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { localPathToHost, type SshCliPlace } from '../agent/shared/cli-target';
import { wslHookPaths } from '../agent/shared/wsl-hook-transport';
import type { PtyHostEvent } from '../pty/host/protocol';
import type { HostFileWrite } from './protocol/messages';

/** The helper's file jobs, as `RemoteHostService` offers them. */
export interface RemoteSessionFiles {
  writeFiles(hostId: string, files: HostFileWrite[], directories?: string[]): Promise<unknown>;
  writeFileRaw(hostId: string, filePath: string, content: string, mode?: number): Promise<unknown>;
  watchHooks(hostId: string, sessionId: string, directory: string, statusFile?: string): Promise<unknown>;
  unwatchHooks(hostId: string, sessionId: string): Promise<unknown>;
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
}

type HookFileEvent = Extract<PtyHostEvent, { type: 'hookFile' }>;

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
const RESPONSE_POLL_MS = 100;

interface Registered extends RemoteSessionRegistration {
  localHooks: ReturnType<typeof wslHookPaths>;
  hostHooksDirectory: string;
  timer: ReturnType<typeof setInterval>;
  forwarding: boolean;
  /** Responses being sent, so a poll meanwhile never sends one twice. */
  inFlight: Set<string>;
  /** The last send failure logged, so one that repeats every poll is logged once. */
  lastFailure: string | null;
  /** A release has begun, so a second one waits on nothing and asks the host nothing. */
  releasing: boolean;
}

export interface RemoteSessionRelayOptions {
  files: RemoteSessionFiles;
  log?: (line: string) => void;
}

export class RemoteSessionRelay {
  private readonly sessions = new Map<string, Registered>();
  /** Registrations still pushing files, so a release that arrives meanwhile is kept, not lost. */
  private readonly registering = new Map<string, { released: boolean }>();

  constructor(private readonly options: RemoteSessionRelayOptions) {}

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Push the session's files to the host, start the host's watcher, and start forwarding answers.
   * Resolves once the host is watching, which is before the CLI is started. Rejects with the host's
   * own error when a push fails: a CLI whose hooks have nowhere to publish would run with no activity
   * and no plan approval, so the spawn must fail and say why.
   */
  async register(registration: RemoteSessionRegistration): Promise<void> {
    // A second registration of one id replaces the first rather than leaving its timer running.
    await this.release(registration.sessionId);
    const pending = { released: false };
    this.registering.set(registration.sessionId, pending);
    let hostHooksDirectory: string;
    let localHooks: ReturnType<typeof wslHookPaths>;
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
        if (relative.length === 0 || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some((part) => part === '' || part === '..')) {
          throw new Error(`${relative} is not a plain path inside the session folder, so it was not sent to the host.`);
        }
        const localFile = path.join(registration.localSessionDirectory, ...relative.split('/'));
        const content = await readIfPresent(localFile);
        if (content !== null) files.push({ path: toPosix(toHost(localFile)), content, mode: 0o600 });
      }
      const script = await readIfPresent(localHooks.script);
      if (script !== null) files.push({ path: toPosix(toHost(localHooks.script)), content: script, mode: 0o755 });
      await this.options.files.writeFiles(
        registration.hostId,
        files,
        ['inbox', 'requests', 'responses'].map((folder) => `${hostHooksDirectory}/${folder}`),
      );
      await this.options.files.watchHooks(registration.hostId, registration.sessionId, hostHooksDirectory, toPosix(toHost(registration.statusOutputPath)));
    } finally {
      this.registering.delete(registration.sessionId);
    }
    if (pending.released) {
      // Released while its files were being pushed (the spawn was torn down): the host stops watching now.
      await this.options.files.unwatchHooks(registration.hostId, registration.sessionId).catch(() => undefined);
      return;
    }

    const entry: Registered = {
      ...registration,
      localHooks,
      hostHooksDirectory,
      forwarding: false,
      inFlight: new Set(),
      lastFailure: null,
      releasing: false,
      timer: setInterval(() => void this.forwardResponses(registration.sessionId), RESPONSE_POLL_MS),
    };
    entry.timer.unref?.();
    this.sessions.set(registration.sessionId, entry);
  }

  /** Stop forwarding and ask the host to stop watching, after it sends what is published. Never throws. */
  async release(sessionId: string): Promise<void> {
    const pending = this.registering.get(sessionId);
    if (pending) {
      pending.released = true;
      return;
    }
    const entry = this.sessions.get(sessionId);
    if (!entry || entry.releasing) return;
    entry.releasing = true;
    clearInterval(entry.timer);
    // The registration stays until the host has answered: the records it flushes on the way out
    // arrive first, and `deliver` drops what it has no registration for.
    await this.options.files.unwatchHooks(entry.hostId, sessionId).catch((error: unknown) => {
      this.options.log?.(`could not stop the host watching ${sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
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
      const folder = event.folder === 'inbox' ? entry.localHooks.inbox : entry.localHooks.requests;
      writeAtomicallySync(path.join(folder, event.name), event.content);
      // The reader watches this file, as it does for a distro; a byte is what wakes it.
      try {
        // sync-write-ok: part of the ordered delivery above; the reader also polls, so a missed byte costs 250 ms.
        fsSync.appendFileSync(entry.localHooks.signal, 'x');
      } catch {
        // The polling reader still finds the file.
      }
    } catch (error) {
      this.options.log?.(`could not write a hook file for ${event.sessionId.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  dispose(): void {
    for (const entry of this.sessions.values()) clearInterval(entry.timer);
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
          const content = await fs.readFile(file, 'utf8');
          const target = `${entry.hostHooksDirectory}/responses/${name}`;
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
