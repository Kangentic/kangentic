import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCli, stopCli } from '../../shared/cli-print';
import type { CliChildProcess } from '../../../utility-process/off-main-cli';
import { codexHookDefinitions, codexHookStateOverride, type CodexHookDefinition, type CodexHookTrustEntry } from './hook-manager';

/**
 * Codex's hook trust, read from Codex itself (task #859).
 *
 * Codex runs a session-flags hook only when `hooks.state` holds the hash Codex
 * computes for it. In the TUI an untrusted hook opens a blocking "Hooks need
 * review" dialog before the session starts, so a wrong hash would stop every
 * Kangentic Codex session. Kangentic therefore never computes the hash: it asks
 * the binary's own `app-server` (`hooks/list`) for the key and `currentHash` of
 * the exact overrides it passes, and wires hooks only when that answer is whole.
 * Anything else (a failed run, a timeout, an error or warning, a hook missing
 * from the list) leaves the session without hooks, on the PTY tracker, as
 * before. Measured: the formula held from 0.154.0 to 0.163.0 and Codex clamps
 * a SessionEnd timeout to 3 s before hashing, which is the kind of change this
 * read absorbs.
 *
 * One read covers every session, because the overrides are the same for all of
 * them (`codexHookDefinitions`). The read also checks that Codex lists each
 * hook with exactly the command and timeout Kangentic passed: the read reaches
 * Codex through `spawnCli` and a session through the user's shell, and if the
 * two delivered different text, Codex would have hashed something the session
 * never sends. A mismatch therefore means no hooks, not a dialog.
 *
 * It is cached per binary file (path, size, modification time), so an
 * in-place update reads again. An npm install is the gap: an update replaces
 * the package behind the `.cmd` shim, not the shim, so the cache holds until
 * Kangentic restarts. The shim's `.ps1` and `#!/bin/sh` siblings, which a spawn
 * launches in its place (`resolveShimLaunch`), share the `.cmd`'s entry. A
 * read that failed to run (a timeout, a spawn error, an app-server that exited
 * first) is tried again by a later `start` once `FAILED_READ_RETRY_MS` has
 * passed, so one slow cold start does not leave hooks off for the whole run.
 */

/** Longest a read may take before the session goes without hooks. */
const TRUST_READ_TIMEOUT_MS = 20_000;

/** How long a read that failed to run is kept before a `start` reads again. */
const FAILED_READ_RETRY_MS = 5 * 60_000;

/** Longest the scratch folder waits for a stopped app-server to exit before it is removed anyway. */
const SCRATCH_RELEASE_WAIT_MS = 10_000;

/** One stdio JSON-RPC conversation with `codex app-server`. */
function listSessionFlagHooks(child: CliChildProcess, workingDirectory: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffered = '';
    // An app-server that exits before reading (a Codex without the
    // subcommand) fails the write with EPIPE; its exit rejects the read.
    child.stdin.on('error', () => undefined);
    const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
    const timer = setTimeout(() => reject(new Error('timed out')), TRUST_READ_TIMEOUT_MS);
    timer.unref?.();
    const finish = (settle: () => void): void => { clearTimeout(timer); settle(); };
    child.once('error', (error: Error) => finish(() => reject(error)));
    child.once('exit', () => finish(() => reject(new Error('app-server exited before answering'))));
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (!line) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(message)) continue;
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [workingDirectory] } });
        } else if (message.id === 2) {
          finish(() => (message.error ? reject(new Error('hooks/list failed')) : resolve(message.result)));
        }
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'kangentic', title: 'Kangentic', version: '0' } } });
  });
}

/**
 * The trust entries Codex reports for these hooks, or null when its answer
 * does not account for every one of them exactly: each must be listed once,
 * with the command and timeout Kangentic passed. Exported for tests.
 */
export function trustEntriesOf(result: unknown, definitions: readonly CodexHookDefinition[]): CodexHookTrustEntry[] | null {
  if (!isRecord(result) || !Array.isArray(result.data) || result.data.length !== 1) return null;
  const listing = result.data[0];
  if (!isRecord(listing) || !Array.isArray(listing.hooks)) return null;
  if (Array.isArray(listing.errors) && listing.errors.length > 0) return null;
  if (Array.isArray(listing.warnings) && listing.warnings.length > 0) return null;
  const unmatched = [...definitions];
  const entries: CodexHookTrustEntry[] = [];
  for (const hook of listing.hooks) {
    if (!isRecord(hook) || hook.source !== 'sessionFlags') continue;
    if (typeof hook.key !== 'string' || typeof hook.currentHash !== 'string') return null;
    const matchIndex = unmatched.findIndex((definition) =>
      definition.command === hook.command && definition.timeoutSeconds === hook.timeoutSec);
    if (matchIndex < 0) return null;
    unmatched.splice(matchIndex, 1);
    entries.push({ key: hook.key, hash: hook.currentHash });
  }
  return unmatched.length === 0 ? entries : null;
}

/**
 * Ask the binary at `codexPath` for the trust entries of these hooks. Resolves
 * null when Codex answered without confirming them, and rejects when the run
 * itself failed (a timeout, a spawn error, an app-server that exited first),
 * so `CodexHookTrustCheck` can tell a run worth trying again from an answer.
 */
export async function readCodexHookTrust(
  codexPath: string,
  definitions: readonly CodexHookDefinition[],
  spawn: typeof spawnCli = spawnCli,
): Promise<CodexHookTrustEntry[] | null> {
  const overrides = definitions.map((definition) => definition.override);
  // A scratch home and folder: the read touches neither the user's Codex state
  // nor a project, and the listing holds only the session-flags hooks.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-hooks-'));
  const codexHome = path.join(scratch, 'home');
  const workingDirectory = path.join(scratch, 'folder');
  let child: CliChildProcess | null = null;
  try {
    fs.mkdirSync(codexHome); // sync-write-ok: a scratch folder under os.tmpdir(); a throw rejects the read, which leaves the session without hooks.
    fs.mkdirSync(workingDirectory); // sync-write-ok: as above.
    child = spawn(codexPath, ['app-server', ...overrides.flatMap((override) => ['-c', override])], workingDirectory, { CODEX_HOME: codexHome });
    const result = await listSessionFlagHooks(child, workingDirectory);
    const entries = trustEntriesOf(result, definitions);
    if (!entries) console.warn('[codex] hook trust read did not list Kangentic\'s hooks as passed; sessions run without hooks');
    return entries;
  } catch (error) {
    console.warn(`[codex] hook trust read failed, sessions run without hooks: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    if (child) stopCli(child);
    removeScratchAfterExit(child, scratch);
  }
}

/**
 * Remove the read's scratch folder once nothing holds it. A stopped
 * app-server keeps the folder as its working directory until it exits, and
 * Windows refuses to remove a directory a live process works in, so the
 * removal waits for the exit, bounded, then tries anyway. The read's answer
 * never waits for it. A folder that still cannot go stays in the OS temp folder.
 * The removal runs off main's thread: synchronous, it held main 102 ms at a
 * launch's agent detection.
 */
function removeScratchAfterExit(child: CliChildProcess | null, scratch: string): void {
  const remove = (): void => {
    fs.promises.rm(scratch, { recursive: true, force: true }).catch(() => {
      // A held file; it stays in the OS temp folder.
    });
  };
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    remove();
    return;
  }
  let removed = false;
  const removeOnce = (): void => {
    if (removed) return;
    removed = true;
    clearTimeout(fallbackTimer);
    remove();
  };
  const fallbackTimer = setTimeout(removeOnce, SCRATCH_RELEASE_WAIT_MS);
  fallbackTimer.unref?.();
  child.once('exit', removeOnce);
}

/** Identity of the file at `filePath`, so an in-place update reads again. */
function binaryStampOf(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}|${stat.mtimeMs}`;
  } catch {
    return null;
  }
}

/**
 * A binary and its npm shim siblings under one key: same folder and base name,
 * without the `.cmd`, `.bat` or `.ps1` extension. A spawn may launch the
 * sibling `resolveShimLaunch` chose rather than the `.cmd` that `detect` found.
 */
export function shimFamilyKey(filePath: string): string {
  const withoutShimExtension = filePath.replace(/\.(cmd|bat|ps1)$/i, '');
  return process.platform === 'win32' ? withoutShimExtension.toLowerCase() : withoutShimExtension;
}

interface TrustRead {
  /** The path `detect` found, whose file the stamp describes. */
  detectedPath: string;
  stamp: string;
  pending: Promise<void>;
  /** Undefined while the read runs; null when Codex did not confirm the hooks. */
  stateOverride: string | null | undefined;
  /** When the read failed to run (the read rejected); null for an answer or a read in flight. */
  failedAt: number | null;
}

/**
 * The cached reads, one per binary. `start` begins one (from `detect`),
 * `settle` waits for any in flight (from `ensureTrust`, which every spawn path
 * awaits before `buildCommand`), and `stateOverrideFor` answers synchronously.
 */
export class CodexHookTrustCheck {
  private readonly reads = new Map<string, TrustRead>();

  constructor(
    private readonly read: (codexPath: string, definitions: readonly CodexHookDefinition[]) => Promise<CodexHookTrustEntry[] | null> = readCodexHookTrust,
    private readonly stampOf: (filePath: string) => string | null = binaryStampOf,
    private readonly now: () => number = Date.now,
  ) {}

  start(codexPath: string): void {
    const stamp = this.stampOf(codexPath);
    if (!stamp) return;
    const key = shimFamilyKey(codexPath);
    const existing = this.reads.get(key);
    if (existing && existing.detectedPath === codexPath && existing.stamp === stamp && !this.failedLongAgo(existing)) return;
    const trustRead: TrustRead = { detectedPath: codexPath, stamp, pending: Promise.resolve(), stateOverride: undefined, failedAt: null };
    trustRead.pending = this.read(codexPath, codexHookDefinitions())
      .then((entries) => (entries ? codexHookStateOverride(entries) : null))
      .catch(() => {
        trustRead.failedAt = this.now();
        return null;
      })
      .then((stateOverride) => {
        trustRead.stateOverride = stateOverride;
        console.log(`[codex] hook trust ${stateOverride ? 'read from Codex; sessions run with hooks' : 'not confirmed; sessions run without hooks'}`);
      });
    this.reads.set(key, trustRead);
  }

  /** A read that failed to run long enough ago to try again. */
  private failedLongAgo(trustRead: TrustRead): boolean {
    return trustRead.failedAt !== null && this.now() - trustRead.failedAt >= FAILED_READ_RETRY_MS;
  }

  /** Wait, at most `timeoutMs`, for every read in flight. */
  async settle(timeoutMs: number): Promise<void> {
    const pending = [...this.reads.values()].filter((trustRead) => trustRead.stateOverride === undefined).map((trustRead) => trustRead.pending);
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(pending),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /**
   * The `hooks.state` override for the binary at `codexPath` (or a shim
   * sibling of it), or null when its hooks are not confirmed, or the detected
   * file changed since the read.
   */
  stateOverrideFor(codexPath: string): string | null {
    const trustRead = this.reads.get(shimFamilyKey(codexPath));
    if (!trustRead || !trustRead.stateOverride) return null;
    return this.stampOf(trustRead.detectedPath) === trustRead.stamp ? trustRead.stateOverride : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
