import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { FileWatcher } from './file-watcher';
import { transformHookEvent } from '../../agent/event-bridge';
import { planApprovalAnswer } from '../../agent/plan-approval-bridge';
import { backgroundShellHintReply } from '../../agent/background-shell-hint-bridge';
import { planApprovalDecisionPath } from '../../agent/shared/plan-approval-hook';
import {
  WSL_MCP_REQUEST_HEAD,
  parseWslHookRecord,
  wslHookPaths,
  wslHookRecordTime,
  type WslHookPaths,
  type WslHookRecord,
  type WslHookReplyKind,
} from '../../agent/shared/wsl-hook-transport';
import { relayMcpMessage, type McpRelayInput } from './wsl-mcp-relay';

/**
 * Kangentic's half of the WSL hook transport (`wsl-hook-transport.ts`): reads
 * what a distro CLI's hooks published in its session's `wsl-hooks/` folder and
 * does what the node bridges do on this machine, with their own exported logic.
 *
 * - Each event file becomes the events.jsonl lines `transformHookEvent` makes
 *   of it, timed by its name (when the hook ran, not when it was read), in name
 *   order. This is the only writer of that events file for the session.
 * - Each request is answered: plan approval writes its marker to the events
 *   file first, then the answer (`planApprovalAnswer`); the background shell
 *   hint answers alone (`backgroundShellHintReply`). An answer of nothing is an
 *   empty response, which ends the hook's wait at once.
 * - Each MCP message from the stdio bridge is relayed to Kangentic's loopback
 *   MCP server (`relayMcpMessage`), each on its own: a tool call can run for
 *   minutes, and the hooks' answers and the events must not wait behind it.
 *
 * Watched through the `signal` file every published call writes a byte to (a
 * file watch, not a folder watch, which on Windows spins once its folder is
 * deleted), with a 250 ms poll of the folders behind it.
 */

export interface WslHookInboxOptions {
  sessionDirectory: string;
  eventsOutputPath: string;
  /** Lines were appended to the events file. */
  onAppended: () => void;
  /** Relays one MCP message; `relayMcpMessage` unless a test replaces it. */
  relayMcp?: (input: McpRelayInput) => Promise<string>;
}

const POLL_INTERVAL_MS = 250;

/** The bridge's error log for this session, as the node bridge names it. */
function bridgeErrorLogPath(eventsOutputPath: string): string {
  return path.join(path.dirname(eventsOutputPath), 'events-bridge.error.log');
}

/** Event and request files, in the order their hooks ran. Names start with a dot while written. */
function publishedNames(names: string[], extension: string): string[] {
  return names.filter((name) => !name.startsWith('.') && name.endsWith(extension)).sort();
}

export class WslHookInbox {
  private readonly paths: WslHookPaths;
  private watcher: FileWatcher | null = null;
  private closed = false;
  private draining = false;
  private drainAgain = false;
  /** Bumped by the synchronous exit drain, which supersedes a drain in flight. */
  private generation = 0;
  /** MCP requests being relayed, by file name, so a drain meanwhile never sends one twice. */
  private readonly relaysInFlight = new Set<string>();
  /** Ends the relays still running when the session ends. */
  private readonly relayAbort = new AbortController();

  constructor(private readonly options: WslHookInboxOptions) {
    this.paths = wslHookPaths(options.sessionDirectory);
  }

  /** Start watching, if the session's builder prepared the transport. */
  start(): void {
    if (this.closed || this.watcher) return;
    // sync-read-ok: once per spawn of a distro CLI; an adapter that wired no
    // hooks prepared no folder, and gets no watcher polling for one.
    if (!fs.existsSync(this.paths.signal)) return;
    this.watcher = new FileWatcher({
      filePath: this.paths.signal,
      onChange: () => this.scheduleDrain(),
      debounceMs: 0,
      pollIntervalMs: POLL_INTERVAL_MS,
      isStale: () => this.hasPending(),
    });
    this.scheduleDrain();
  }

  close(): void {
    this.closed = true;
    this.relayAbort.abort();
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * Ingest every event file now, synchronously, for the exit flush: the exit
   * handling reads the events file right after, and a SessionEnd or last
   * tool_end published as the CLI exited must be in it. Supersedes a drain in
   * flight, which then commits nothing. Requests are left: nobody waits on an
   * answer once the CLI has exited.
   */
  drainSync(): void {
    if (!this.watcher) return;
    this.generation += 1;
    let names: string[];
    try {
      // sync-read-ok: the exit flush, as above.
      names = publishedNames(fs.readdirSync(this.paths.inbox), '.rec');
    } catch {
      return;
    }
    const batch: Array<{ file: string; lines: string[] }> = [];
    for (const name of names) {
      const file = path.join(this.paths.inbox, name);
      try {
        // sync-read-ok: the exit flush, as above.
        batch.push({ file, lines: this.linesFor(name, fs.readFileSync(file, 'utf-8')) });
      } catch {
        // Gone already, or unreadable: nothing to add.
      }
    }
    this.commit(batch);
  }

  private scheduleDrain(): void {
    if (this.closed) return;
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    void this.runDrains();
  }

  private async runDrains(): Promise<void> {
    try {
      do {
        this.drainAgain = false;
        await this.answerRequests();
        await this.ingestEvents();
      } while (this.drainAgain && !this.closed);
    } catch (error) {
      console.warn(`[wsl-hooks] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.draining = false;
    }
  }

  private async hasPending(): Promise<boolean> {
    const [events, requests] = await Promise.all([
      fsPromises.readdir(this.paths.inbox).catch(() => []),
      fsPromises.readdir(this.paths.requests).catch(() => []),
    ]);
    return publishedNames(events, '.rec').length > 0
      || publishedNames(requests, '.req').some((name) => !this.relaysInFlight.has(name));
  }

  private async ingestEvents(): Promise<void> {
    const generation = this.generation;
    const names = publishedNames(await fsPromises.readdir(this.paths.inbox).catch(() => []), '.rec');
    if (names.length === 0) return;
    const batch: Array<{ file: string; lines: string[] }> = [];
    for (const name of names) {
      const file = path.join(this.paths.inbox, name);
      const content = await fsPromises.readFile(file, 'utf-8').catch(() => null);
      if (content !== null) batch.push({ file, lines: this.linesFor(name, content) });
    }
    // The exit drain ran meanwhile and took these files itself.
    if (this.closed || generation !== this.generation) return;
    this.commit(batch);
  }

  /**
   * Append a batch's lines and remove its files, in one synchronous step, so
   * the exit drain can never see a file whose lines are already appended.
   * A batch is a few hook calls, a few KB.
   */
  private commit(batch: Array<{ file: string; lines: string[] }>): void {
    if (batch.length === 0) return;
    const lines = batch.flatMap((entry) => entry.lines);
    if (lines.length > 0) {
      try {
        // sync-write-ok: one append per batch, atomic with the removals below
        // against the synchronous exit drain; an events file that cannot be
        // written keeps the files, which the next drain tries again.
        fs.appendFileSync(this.options.eventsOutputPath, lines.join('\n') + '\n');
      } catch (error) {
        this.logError('ingest', error instanceof Error ? error.message : String(error));
        return;
      }
    }
    for (const entry of batch) {
      try {
        // sync-write-ok: as above.
        fs.rmSync(entry.file, { force: true });
      } catch (error) {
        // A file that cannot be removed is read again next drain, and its
        // event lands twice. Logged, since nothing else would show it.
        this.logError('ingest', `could not remove ${path.basename(entry.file)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (lines.length > 0) this.options.onAppended();
  }

  private linesFor(name: string, content: string): string[] {
    const record = parseWslHookRecord(content);
    if (!record) {
      this.logError('ingest', `not a hook record: ${name}`);
      return [];
    }
    return transformHookEvent({
      eventType: record.head || 'idle',
      directives: record.argument.split(' ').filter((directive) => directive.length > 0),
      input: record.stdin,
      now: wslHookRecordTime(name) ?? Date.now(),
      logError: (message: string) => this.logError(record.head, message),
    });
  }

  private async answerRequests(): Promise<void> {
    const names = publishedNames(await fsPromises.readdir(this.paths.requests).catch(() => []), '.req');
    for (const name of names) {
      if (this.closed) return;
      if (this.relaysInFlight.has(name)) continue;
      const file = path.join(this.paths.requests, name);
      const content = await fsPromises.readFile(file, 'utf-8').catch(() => null);
      if (content === null) continue;
      const record = parseWslHookRecord(content);
      if (record?.head === WSL_MCP_REQUEST_HEAD) {
        this.relaysInFlight.add(name);
        void this.relay(name, file, record);
        continue;
      }
      const reply = await this.answer(name, record);
      if (this.closed) return;
      await this.writeResponse(name, reply, 'reply');
      await fsPromises.rm(file, { force: true }).catch(() => undefined);
    }
  }

  /** Relay one MCP message and leave its answer for the bridge. Never throws. */
  private async relay(name: string, file: string, record: WslHookRecord): Promise<void> {
    try {
      const answer = await (this.options.relayMcp ?? relayMcpMessage)({
        argument: record.argument,
        body: record.stdin,
        signal: this.relayAbort.signal,
      });
      if (!this.closed) await this.writeResponse(name, answer, 'mcp');
    } catch (error) {
      this.logError('mcp', error instanceof Error ? error.message : String(error));
    } finally {
      await fsPromises.rm(file, { force: true }).catch(() => undefined);
      this.relaysInFlight.delete(name);
    }
  }

  /** Publish a request's answer under the name the hook waits for, by a rename. */
  private async writeResponse(requestName: string, text: string, subject: string): Promise<void> {
    const responseName = requestName.replace(/\.req$/, '.res');
    const temporary = path.join(this.paths.responses, `.${responseName}.tmp`);
    try {
      await fsPromises.writeFile(temporary, text);
      await fsPromises.rename(temporary, path.join(this.paths.responses, responseName));
    } catch (error) {
      this.logError(subject, error instanceof Error ? error.message : String(error));
    }
  }

  /** The text the hook prints for one request: an answer, or nothing. */
  private async answer(name: string, record: WslHookRecord | null): Promise<string> {
    if (!record) {
      this.logError('reply', `not a hook request: ${name}`);
      return '';
    }
    const kind = record.head as WslHookReplyKind;
    if (kind === 'background-shell-hint') {
      return backgroundShellHintReply(record.argument, record.stdin) ?? '';
    }
    if (kind === 'plan-approval') {
      const decisionPath = planApprovalDecisionPath(this.options.sessionDirectory);
      const decision: unknown = await fsPromises.readFile(decisionPath, 'utf-8')
        .then((raw) => JSON.parse(raw) as unknown)
        .catch(() => null);
      try {
        const approval = planApprovalAnswer({
          encodedSpec: record.argument,
          input: record.stdin,
          readDecision: () => decision,
          now: Date.now(),
        });
        if (!approval) return '';
        // The marker first, then the answer, as the bridge does: an answer the
        // pipeline has no marker for would read as "needs you".
        // sync-write-ok: one line, before the answer it must precede.
        fs.appendFileSync(this.options.eventsOutputPath, JSON.stringify(approval.marker) + '\n');
        this.options.onAppended();
        return approval.reply;
      } catch (error) {
        this.logError('plan-approval', error instanceof Error ? error.message : String(error));
        return '';
      }
    }
    this.logError('reply', `unknown request kind: ${record.head}`);
    return '';
  }

  /** Append to the session's bridge error log, as the node bridge does. Never throws. */
  private logError(subject: string, message: string): void {
    void fsPromises.appendFile(
      bridgeErrorLogPath(this.options.eventsOutputPath),
      `${new Date().toISOString()} ${subject} ${message}\n`,
    ).catch(() => undefined);
  }
}
