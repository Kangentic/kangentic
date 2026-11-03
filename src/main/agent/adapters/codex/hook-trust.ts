import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCli, stopCli } from '../../shared/cli-print';
import { cliPathForTarget, type CliTarget, type SshCliPlace } from '../../shared/cli-target';
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

/** The JSON-RPC requests of the read: Codex's handshake, then the hook listing for one folder. */
const INITIALIZE_REQUEST = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'kangentic', title: 'Kangentic', version: '0' } } };
const INITIALIZED_NOTIFICATION = { jsonrpc: '2.0', method: 'initialized' };
const hooksListRequest = (workingDirectory: string): unknown => ({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [workingDirectory] } });

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
          send(INITIALIZED_NOTIFICATION);
          send(hooksListRequest(workingDirectory));
        } else if (message.id === 2) {
          finish(() => (message.error ? reject(new Error('hooks/list failed')) : resolve(message.result)));
        }
      }
    });
    send(INITIALIZE_REQUEST);
  });
}

/** Longest a read on a host may take. The spawn waits for it no longer than `HOOK_TRUST_SETTLE_MS`. */
const HOST_TRUST_READ_TIMEOUT_MS = 20_000;

/** The program `codex --version` and the read run as on a host: the CLI's name, found by the host's own shell. */
const HOST_CODEX_PROGRAM = 'codex';

/**
 * Makes the read's scratch folders on the host and prints the folder. Under the host's temporary
 * folder, not its home: the read must touch neither the user's Codex state nor a project, and the
 * helper's file jobs would leave the empty folders behind.
 */
const MAKE_SCRATCH_SCRIPT = 'scratch=$(mktemp -d "${TMPDIR:-/tmp}/kangentic-codex-hooks-XXXXXX") && mkdir "$scratch/home" "$scratch/folder" && printf %s "$scratch"';

/** The scratch folder the script above prints: absolute, no quote or space, named by the script. */
const SCRATCH_FOLDER = /^\/[^\s'"]*kangentic-codex-hooks-[A-Za-z0-9]+$/;

/**
 * The answer to the `hooks/list` request in everything the app-server printed. Throws when there is
 * none, which a host's run can produce when the app-server ends at the end of its input before it
 * answered, and when Codex answered with an error.
 */
export function hooksListResultOf(output: string): unknown {
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(message) || message.id !== 2) continue;
    if (message.error) throw new Error('hooks/list failed');
    return message.result;
  }
  throw new Error('app-server did not answer hooks/list');
}

/**
 * The version of the Codex on a host, or null when the host has none: the key of the host's trust
 * read, since the file behind `codex` cannot be stat'ed from here.
 */
export async function readHostCodexVersion(place: SshCliPlace): Promise<string | null> {
  const files = place.files;
  if (!files) return null;
  const result = await files.runCommand({ file: HOST_CODEX_PROGRAM, args: ['--version'], timeoutMs: 15_000 });
  if (result.error || result.timedOut || result.code !== 0) return null;
  const version = result.stdout.trim();
  return version.length > 0 ? version : null;
}

/**
 * `readCodexHookTrust` for a Codex on an SSH host: the same `app-server` conversation, run on the
 * host through the helper, which starts a program, writes its standard input and closes it. So the
 * whole conversation (handshake, then the listing) is sent as one input, and the answer is read from
 * what the program printed afterwards, whether it ended by itself or was stopped at the bound.
 * The scratch folders are made and removed on the host.
 */
export async function readCodexHookTrustOnHost(
  place: SshCliPlace,
  definitions: readonly CodexHookDefinition[],
): Promise<CodexHookTrustEntry[] | null> {
  const files = place.files;
  if (!files) throw new Error('This host has no connection to run a command through.');
  const made = await files.runCommand({ file: 'sh', args: ['-c', MAKE_SCRATCH_SCRIPT], timeoutMs: 10_000 });
  const scratch = made.stdout.trim();
  if (made.error || made.code !== 0 || !SCRATCH_FOLDER.test(scratch)) {
    throw new Error('could not make a scratch folder on the host');
  }
  try {
    const overrides = definitions.map((definition) => definition.override);
    const result = await files.runCommand({
      file: HOST_CODEX_PROGRAM,
      args: ['app-server', ...overrides.flatMap((override) => ['-c', override])],
      env: { CODEX_HOME: `${scratch}/home` },
      stdin: [INITIALIZE_REQUEST, INITIALIZED_NOTIFICATION, hooksListRequest(`${scratch}/folder`)].map((message) => `${JSON.stringify(message)}\n`).join(''),
      timeoutMs: HOST_TRUST_READ_TIMEOUT_MS,
    });
    if (result.error) throw new Error(result.error);
    const entries = trustEntriesOf(hooksListResultOf(result.stdout), definitions);
    if (!entries) console.warn('[codex] hook trust read on the host did not list Kangentic\'s hooks as passed; sessions run without hooks');
    return entries;
  } catch (error) {
    console.warn(`[codex] hook trust read on the host failed, sessions run without hooks: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  } finally {
    // Best effort: a folder left in the host's temporary folder is cleared with it.
    await files.runCommand({ file: 'rm', args: ['-rf', '--', scratch], timeoutMs: 10_000 }).catch(() => undefined);
  }
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
  target: CliTarget | null = null,
): Promise<CodexHookTrustEntry[] | null> {
  const overrides = definitions.map((definition) => definition.override);
  // A scratch home and folder: the read touches neither the user's Codex state
  // nor a project, and the listing holds only the session-flags hooks. A Codex
  // in a WSL distro reads them as the distro sees them, under /mnt.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-hooks-'));
  const codexHome = path.join(scratch, 'home');
  const workingDirectory = path.join(scratch, 'folder');
  const cliPath = (windowsPath: string): string => (target ? cliPathForTarget(windowsPath, target) : windowsPath);
  let child: CliChildProcess | null = null;
  try {
    fs.mkdirSync(codexHome); // sync-write-ok: a scratch folder under os.tmpdir(); a throw rejects the read, which leaves the session without hooks.
    fs.mkdirSync(workingDirectory); // sync-write-ok: as above.
    child = spawn(
      codexPath,
      ['app-server', ...overrides.flatMap((override) => ['-c', override])],
      workingDirectory,
      { CODEX_HOME: cliPath(codexHome) },
      target,
    );
    const result = await listSessionFlagHooks(child, cliPath(workingDirectory));
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

/** The cache key of a host's read. A path never starts with `ssh:`, so it cannot meet a binary's key. */
function hostReadKey(hostId: string): string {
  return `ssh:${hostId}`;
}

interface TrustRead {
  /** The path `detect` found, whose file the stamp describes. */
  detectedPath: string;
  stamp: string;
  /** True when the stamp is the detected version of a Codex in a WSL distro, not the file's. */
  stampedByVersion: boolean;
  pending: Promise<void>;
  /** Undefined while the read runs; null when Codex did not confirm the hooks. */
  stateOverride: string | null | undefined;
  /** When the read failed to run (the read rejected); null for an answer or a read in flight. */
  failedAt: number | null;
}

/** A Codex installed in a WSL distro, for a trust read run there. */
export interface CodexTrustReadTarget {
  target: CliTarget;
  /** The version detection read, which keys the read: the binary's file cannot be stat'ed through the share. */
  version: string;
}

/**
 * The cached reads, one per binary. `start` begins one (from `detect`),
 * `settle` waits for any in flight (from `ensureTrust`, which every spawn path
 * awaits before `buildCommand`), and `stateOverrideFor` answers synchronously.
 */
export class CodexHookTrustCheck {
  private readonly reads = new Map<string, TrustRead>();

  constructor(
    private readonly read: (
      codexPath: string,
      definitions: readonly CodexHookDefinition[],
      target: CliTarget | null,
    ) => Promise<CodexHookTrustEntry[] | null> = (codexPath, definitions, target) => readCodexHookTrust(codexPath, definitions, spawnCli, target),
    private readonly stampOf: (filePath: string) => string | null = binaryStampOf,
    private readonly now: () => number = Date.now,
    private readonly readOnHost: (
      place: SshCliPlace,
      definitions: readonly CodexHookDefinition[],
    ) => Promise<CodexHookTrustEntry[] | null> = readCodexHookTrustOnHost,
  ) {}

  /**
   * Begin a read for the binary at `codexPath`. A Codex in a WSL distro
   * (`wsl`) is read there, for the hooks it runs (the transport script), and
   * keyed by its detected version.
   */
  start(codexPath: string, wsl: CodexTrustReadTarget | null = null): void {
    const stamp = wsl ? `version:${wsl.version}` : this.stampOf(codexPath);
    if (!stamp) return;
    this.begin(
      shimFamilyKey(codexPath),
      codexPath,
      stamp,
      wsl !== null,
      () => this.read(codexPath, codexHookDefinitions(wsl ? 'wsl' : 'node'), wsl?.target ?? null),
    );
  }

  /**
   * Begin a read for the Codex on an SSH host, keyed by the host and by the version it reports, since
   * its binary cannot be stat'ed from here: an update on the host reads again. The hooks are the
   * transport script's, as in a distro. Nothing is read when the host has no Codex.
   */
  startOnHost(place: SshCliPlace, version: string): void {
    this.begin(hostReadKey(place.hostId), HOST_CODEX_PROGRAM, `version:${version}`, true, () => this.readOnHost(place, codexHookDefinitions('wsl')));
  }

  /** The `hooks.state` override confirmed for the Codex on this host, or null when it is not. */
  stateOverrideForHost(hostId: string): string | null {
    return this.reads.get(hostReadKey(hostId))?.stateOverride ?? null;
  }

  private begin(
    key: string,
    detectedPath: string,
    stamp: string,
    stampedByVersion: boolean,
    run: () => Promise<CodexHookTrustEntry[] | null>,
  ): void {
    const existing = this.reads.get(key);
    if (existing && existing.detectedPath === detectedPath && existing.stamp === stamp && !this.failedLongAgo(existing)) return;
    const trustRead: TrustRead = {
      detectedPath, stamp, stampedByVersion, pending: Promise.resolve(), stateOverride: undefined, failedAt: null,
    };
    trustRead.pending = run()
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
    // A version stamp was checked when detection started the read.
    if (trustRead.stampedByVersion) return trustRead.stateOverride;
    return this.stampOf(trustRead.detectedPath) === trustRead.stamp ? trustRead.stateOverride : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
