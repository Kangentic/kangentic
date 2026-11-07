import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { slugify, computeAutoBranchName } from '../../shared/slugify';
import { isAbortError } from '../../shared/abort-utils';
import { isShuttingDown } from '../shutdown-state';
import { WorktreeManager, GitQueuePriority, type WorktreeCreateResult } from './worktree-manager';
import { worktreesRootFor } from './task-worktree-folder';
import { isWorktreeCreationInFlight, pathKey, tryHoldWorktreeCreation, waitForWorktreeCreation } from './worktree-creation-registry';
import { resolveWorktreeBase } from './base-branch';
import { whenNoInitScriptRuns } from './run-init-script';
import { scheduleRemovedWorktreeDeletion } from './removed-worktrees';
import { gitAt } from './git-client';
import type { FetchIfStaleOutcome } from './fetch-throttle';

/**
 * One pre-installed spare worktree per project with a Post-Worktree Script.
 *
 * A task that starts in a new worktree waits for the project's init script
 * (`git.initScript`), a 25 to 30 s `pnpm install` on the workspace measured in
 * docs/audits/spare-worktree-audit.md. A spare has that script already run.
 * The next eligible task adopts it where it is (`claim`): a new branch onto the
 * fetched base, the copied files again, the script again (a 3 to 4 s catch-up),
 * and the task records the spare's folder as its own for good.
 *
 * A spare is adopted IN PLACE and never `git worktree move`d. pnpm links
 * packages with junctions that hold absolute targets, and `.modules.yaml`
 * records the folder, so a moved spare has every package link dangling, and
 * `pnpm install --frozen-lockfile` then exits 0 over the broken tree.
 *
 * Names: `spare_<8 hex>`, unique per build, because the task that adopts one
 * keeps its folder for good (`worktree_folder` is write-once). slugify never
 * writes `_`, so the name cannot collide with a legacy `<slug>-<id8>` folder,
 * it is never all digits (a display number), and it does not end in
 * `-<8 hex>` (the `/preview` title's id-prefix lookup).
 *
 * Ready marker: `.kangentic/spare-worktrees/<folder>.json`, written only after
 * the spare's script succeeded, holding the inputs it was built from. A spare
 * folder with no record was cut off mid-build and is deleted by the startup
 * pass (`sweep`). A record whose inputs no longer match the project's (another
 * base, script, link or copy list) is stale, and stale spares are discarded,
 * never claimed. Not a git config key: `writeWorktreeBaseBranch` falls back to
 * the shared `.git/config` when `--worktree` fails, and a shared key would mark
 * every checkout ready.
 *
 * A spare that saves nothing is not refilled. The record keeps how long the
 * spare's own install took, and a claim whose catch-up took at least half of
 * that (`NO_SAVING_RATIO`; an `npm ci` deletes node_modules and installs it
 * all again) writes `no-saving.json` for that init script (`noteCatchUp`).
 * The loop builds no spare while that finding names the project's script.
 *
 * Building a spare runs the init script outside any session. Nothing here calls
 * an agent adapter, so no `ensureTrust` entry is written for the spare's path,
 * and a process the script leaves running carries no task tag (the task reap
 * does not stop it).
 */

/** What a spare is built from, and what a claim checks it against. */
export interface SpareInputs {
  baseBranch: string;
  initScript: string;
  linkNodeModules: boolean;
  copyFiles: string[];
  linkFolders: string[];
}

/** A spare's ready record: the inputs it was built from, and when and how long its install took. */
export interface SpareRecord extends SpareInputs {
  folder: string;
  builtAt: string;
  /** How long the build's own run of the init script took, or null when unknown. */
  installMs: number | null;
}

/** What `claim` gives the task: its worktree, and the hold to release once the claim settles. */
export interface ClaimedSpare {
  result: WorktreeCreateResult;
  release: () => void;
  /** How long the spare's own install took, to compare the claim's catch-up against. */
  buildInstallMs: number | null;
}

/**
 * A claim's catch-up taking at least this share of the spare's own install
 * means the spare saved nothing, and the pool stops refilling for that script.
 * Measured on a pnpm workspace, the catch-up took 3.0 to 3.9 s against a 25 to
 * 30 s cold install, 12 to 16%. `npm ci` deletes node_modules before it
 * installs, so its catch-up is a whole install, near 100%.
 */
export const NO_SAVING_RATIO = 0.5;

/** The pool's finding that a spare saves nothing for this init script. */
interface NoSavingVerdict {
  initScript: string;
  buildInstallMs: number;
  catchUpMs: number;
  decidedAt: string;
}

const NO_SAVING_VERDICT_FILE = 'no-saving.json';

/**
 * Every worktree folder a task row names (its `worktree_folder` or
 * `worktree_path`), read when called. A claim, a check for a usable spare and
 * each pass of the sweep read it once, not once per folder.
 */
export type ReferencedFolders = () => ReadonlySet<string>;

/** What the scheduler and the sweep ask of the project they serve. */
export interface SpareProjectHooks {
  /** The inputs a spare is built from now, or null when the project should have none. */
  inputs: () => SpareInputs | null;
  referencedFolders: ReferencedFolders;
}

const SPARE_FOLDER_PREFIX = 'spare_';
const SPARE_FOLDER_PATTERN = /^spare_[0-9a-f]{8}$/;
const SPARE_RECORDS_FOLDER = 'spare-worktrees';

/** True for a folder name only a spare worktree takes. */
export function isSpareWorktreeFolder(folderName: string): boolean {
  return SPARE_FOLDER_PATTERN.test(folderName);
}

export function spareRecordsRootFor(projectPath: string): string {
  return path.join(projectPath, '.kangentic', SPARE_RECORDS_FOLDER);
}

function spareRecordPathFor(projectPath: string, folder: string): string {
  return path.join(spareRecordsRootFor(projectPath), `${folder}.json`);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

/** The spare's ready record, or null when it has none or it does not parse. */
export async function readSpareRecord(projectPath: string, folder: string): Promise<SpareRecord | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(spareRecordPathFor(projectPath, folder), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (record.folder !== folder) return null;
    if (typeof record.baseBranch !== 'string' || typeof record.initScript !== 'string') return null;
    if (typeof record.linkNodeModules !== 'boolean' || !isStringArray(record.copyFiles)) return null;
    // A record from before the field is a spare built with no linked folders.
    const linkFolders = record.linkFolders === undefined ? [] : record.linkFolders;
    if (!isStringArray(linkFolders)) return null;
    if (typeof record.builtAt !== 'string') return null;
    return {
      folder,
      baseBranch: record.baseBranch,
      initScript: record.initScript,
      linkNodeModules: record.linkNodeModules,
      copyFiles: record.copyFiles,
      linkFolders,
      builtAt: record.builtAt,
      installMs: typeof record.installMs === 'number' ? record.installMs : null,
    };
  } catch {
    return null;
  }
}

/**
 * Write one of the pool's JSON files under the records folder, through a temp
 * file and a rename, so a reader never sees half of it. A quit mid-write leaves
 * only the temp file, which the sweep deletes.
 */
async function writeJsonAtomically(projectPath: string, finalPath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(spareRecordsRootFor(projectPath), { recursive: true });
  const temporaryPath = `${finalPath}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.promises.writeFile(temporaryPath, JSON.stringify(value, null, 2));
  await fs.promises.rename(temporaryPath, finalPath);
}

/** Write the ready record. */
export async function writeSpareRecord(projectPath: string, record: SpareRecord): Promise<void> {
  await writeJsonAtomically(projectPath, spareRecordPathFor(projectPath, record.folder), record);
}

async function deleteSpareRecord(projectPath: string, folder: string): Promise<void> {
  await fs.promises.rm(spareRecordPathFor(projectPath, folder), { force: true });
}

function noSavingVerdictPathFor(projectPath: string): string {
  return path.join(spareRecordsRootFor(projectPath), NO_SAVING_VERDICT_FILE);
}

/** The pool's no-saving finding for this project, or null when it has none. */
export async function readNoSavingVerdict(projectPath: string): Promise<NoSavingVerdict | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(noSavingVerdictPathFor(projectPath), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const verdict = parsed as Record<string, unknown>;
    if (typeof verdict.initScript !== 'string' || typeof verdict.buildInstallMs !== 'number') return null;
    if (typeof verdict.catchUpMs !== 'number' || typeof verdict.decidedAt !== 'string') return null;
    return {
      initScript: verdict.initScript,
      buildInstallMs: verdict.buildInstallMs,
      catchUpMs: verdict.catchUpMs,
      decidedAt: verdict.decidedAt,
    };
  } catch {
    return null;
  }
}

function sameList(first: string[], second: string[]): boolean {
  return first.length === second.length && first.every((entry, index) => entry === second[index]);
}

/** True when a spare built from `record` is still what the project would build now. */
export function spareInputsMatch(record: SpareInputs, inputs: SpareInputs): boolean {
  return record.baseBranch === inputs.baseBranch
    && record.initScript === inputs.initScript
    && record.linkNodeModules === inputs.linkNodeModules
    && sameList(record.copyFiles, inputs.copyFiles)
    && sameList(record.linkFolders, inputs.linkFolders);
}

async function listSpareFolders(projectPath: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(worktreesRootFor(projectPath), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory() && isSpareWorktreeFolder(entry.name)).map((entry) => entry.name);
}

async function newSpareFolderName(projectPath: string): Promise<string> {
  for (;;) {
    const folder = `${SPARE_FOLDER_PREFIX}${randomBytes(4).toString('hex')}`;
    const taken = fs.existsSync(path.join(worktreesRootFor(projectPath), folder))
      || fs.existsSync(spareRecordPathFor(projectPath, folder));
    if (!taken) return folder;
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The spare worktree build was stopped', 'AbortError');
}

/** Resolves once no init script runs, or rejects once `signal` aborts. */
function whenNoInitScriptRunsOrAborted(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void whenNoInitScriptRuns().then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });
}

/** The first line of an error's message, trimmed, for a one-line log. */
export function firstLineOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n')[0] ?? '').trim();
}

interface ProjectSpareState {
  /** A request arrived since the loop last looked. */
  wanted: boolean;
  hooks: SpareProjectHooks | null;
  loop: Promise<void> | null;
  /**
   * Aborted by `stop` and the quit. It ends a loop waiting for no init script
   * to run, which can otherwise wait as long as any task's script runs.
   */
  loopController: AbortController | null;
  build: { controller: AbortController; stopReason: 'yield' | 'stop' | null } | null;
}

/**
 * The spares of every project: their builds, claims, discards and the startup
 * pass. One instance for the app (`spareWorktreePool`), put on the IPC context
 * as `spareWorktrees`, which is what turns spares on for `ensureTaskWorktree`.
 */
export class SpareWorktreePool {
  private readonly projects = new Map<string, ProjectSpareState>();

  private stateFor(projectPath: string): ProjectSpareState {
    const key = pathKey(projectPath);
    let state = this.projects.get(key);
    if (!state) {
      state = { wanted: false, hooks: null, loop: null, loopController: null, build: null };
      this.projects.set(key, state);
    }
    return state;
  }

  /**
   * Take a ready spare for `task`, inside the project's git queue: pick the
   * newest one no task names and nothing holds, check its record against
   * `inputs`, create the task's auto branch on the fetched base there, and
   * record the base. Returns null when there is none to take, or when the take
   * failed, with nothing left half-claimed (a spare it changed is discarded):
   * the caller then creates a worktree as before. Rejects only on an abort.
   */
  async claim(input: {
    projectPath: string;
    task: { id: string; title: string };
    inputs: SpareInputs;
    referencedFolders: ReferencedFolders;
    signal?: AbortSignal;
    onProgress?: (phase: string) => void;
    onFetchOutcome?: (outcome: FetchIfStaleOutcome) => void;
  }): Promise<ClaimedSpare | null> {
    const { projectPath, task, inputs, signal } = input;
    const shortId = task.id.slice(0, 8);
    const manager = new WorktreeManager(projectPath);
    return manager.withLock(async () => {
      input.onProgress?.('fetching');
      signal?.throwIfAborted();
      const candidates = await this.readySpares(projectPath, input.referencedFolders);
      for (const candidate of candidates) {
        const release = tryHoldWorktreeCreation(candidate.sparePath);
        if (!release) continue;
        let spent = false;
        try {
          if (!spareInputsMatch(candidate.record, inputs)) {
            console.log(`[SPARE] ${candidate.folder} was built from other settings than the project's now; discarding it`);
            await this.discardInQueue(manager, projectPath, candidate.sparePath);
            release();
            continue;
          }
          const branchName = computeAutoBranchName(slugify(task.title) || 'task', shortId);
          // An earlier creation for this task left its branch. The fresh
          // creation attaches to it, so leave the spare as it is.
          if (await manager.localBranchExists(branchName)) {
            release();
            return null;
          }
          const resolution = await resolveWorktreeBase(projectPath, null, inputs.baseBranch, { signal });
          if (resolution.kind !== 'resolved') {
            release();
            return null;
          }
          const startPoint = await manager.resolveCreationStartPoint(resolution.baseBranch, {
            signal,
            verifiedStartPoint: resolution.startPoint,
            onFetchOutcome: input.onFetchOutcome,
          });
          input.onProgress?.('creating-worktree');
          // From here the spare is spent: a crash leaves a spare folder with no
          // record, which the startup pass deletes.
          spent = true;
          await deleteSpareRecord(projectPath, candidate.folder);
          const forkPointSha = await manager.switchSpareToNewBranch(candidate.sparePath, branchName, startPoint, resolution.baseBranch);
          console.log(`[SPARE] task ${shortId} took ${candidate.folder} on ${branchName} at ${startPoint}`);
          return {
            result: {
              worktreePath: candidate.sparePath,
              branchName,
              worktreeFolder: candidate.folder,
              baseBranch: resolution.baseBranch,
              forkPointSha,
            },
            release,
            buildInstallMs: candidate.record.installMs,
          };
        } catch (error) {
          if (spent) await this.discardInQueue(manager, projectPath, candidate.sparePath);
          release();
          if (isAbortError(error) || signal?.aborted) throw error;
          console.warn(`[SPARE] task ${shortId} could not take ${candidate.folder}: ${firstLineOf(error)}`);
          return null;
        }
      }
      return null;
    }, { label: `claim-spare:${shortId}` });
  }

  /**
   * Discard a spare the caller holds (a claim whose copy or script failed), in
   * the project's git queue. The caller releases its hold afterwards. Never
   * rejects.
   */
  async discard(projectPath: string, sparePath: string): Promise<void> {
    const manager = new WorktreeManager(projectPath);
    try {
      await manager.withLock(() => this.discardInQueue(manager, projectPath, sparePath), { label: `discard-spare:${path.basename(sparePath)}` });
    } catch (error) {
      console.warn(`[SPARE] Could not discard ${sparePath}: ${firstLineOf(error)}`);
    }
  }

  /**
   * Take the spare off its path, inside the queue the caller already holds:
   * moved aside (which prunes git's record, freeing a branch a claim checked
   * out there), or removed in place when the move fails. Then its record goes,
   * and the batched deleter takes the files.
   */
  private async discardInQueue(manager: WorktreeManager, projectPath: string, sparePath: string): Promise<void> {
    const folder = path.basename(sparePath);
    // Detach HEAD first. A claim that got as far as `switch -c` has the task's
    // auto branch checked out here, and the fresh creation that follows a
    // failed claim adds that branch to a new worktree, which git refuses while
    // any worktree still has it out. A removal can fail on Windows (a held
    // file, antivirus) and leave git's record behind; a detached spare then
    // holds no branch either way.
    if (fs.existsSync(path.join(sparePath, '.git'))) {
      try {
        await gitAt(sparePath).raw(['switch', '--detach']);
      } catch (error) {
        console.warn(`[SPARE] Could not detach ${folder} before discarding it: ${firstLineOf(error)}`);
      }
    }
    let removed = false;
    try {
      removed = await manager.moveWorktreeAside(sparePath, { ownCreation: true, timeoutMs: 5_000 });
    } catch (error) {
      console.warn(`[SPARE] Could not move ${folder} aside: ${firstLineOf(error)}`);
    }
    if (!removed) {
      try {
        removed = await manager.removeWorktree(sparePath, { removalProfile: 'fast', ownCreation: true });
      } catch (error) {
        console.warn(`[SPARE] Could not remove ${folder}: ${firstLineOf(error)}`);
      }
    }
    await deleteSpareRecord(projectPath, folder).catch(() => undefined);
    scheduleRemovedWorktreeDeletion(projectPath);
    console.log(`[SPARE] discarded ${folder} (removed=${removed})`);
  }

  /** Ready spares no task names and nothing holds, newest first. */
  private async readySpares(
    projectPath: string,
    referencedFolders: ReferencedFolders,
  ): Promise<Array<{ folder: string; sparePath: string; record: SpareRecord }>> {
    const ready: Array<{ folder: string; sparePath: string; record: SpareRecord }> = [];
    const folders = await listSpareFolders(projectPath);
    if (folders.length === 0) return ready;
    const referenced = referencedFolders();
    for (const folder of folders) {
      if (referenced.has(folder)) continue;
      const sparePath = path.join(worktreesRootFor(projectPath), folder);
      if (isWorktreeCreationInFlight(sparePath)) continue;
      const record = await readSpareRecord(projectPath, folder);
      if (record) ready.push({ folder, sparePath, record });
    }
    return ready.sort((first, second) => second.record.builtAt.localeCompare(first.record.builtAt));
  }

  /**
   * Build one spare: a detached checkout of the base in the queue at
   * BACKGROUND priority, then (once no init script runs) the copied files, the
   * node_modules link and the script, as a task's new worktree gets them, then
   * the ready record. Holds the spare's path for the whole build. A failure or
   * an abort discards what was made. Resolves true once the spare is ready,
   * false on a failure, and rejects on an abort.
   */
  async build(projectPath: string, inputs: SpareInputs, signal: AbortSignal): Promise<boolean> {
    const folder = await newSpareFolderName(projectPath);
    const sparePath = path.join(worktreesRootFor(projectPath), folder);
    const release = tryHoldWorktreeCreation(sparePath);
    if (!release) return false;
    const manager = new WorktreeManager(projectPath);
    const startedAt = Date.now();
    try {
      await manager.withLock(async () => {
        signal.throwIfAborted();
        const resolution = await resolveWorktreeBase(projectPath, null, inputs.baseBranch, { signal });
        if (resolution.kind !== 'resolved') {
          throw new Error(`no base branch to cut it from (${resolution.kind})`);
        }
        await manager.createSpareCheckout(folder, resolution.baseBranch, { signal, verifiedStartPoint: resolution.startPoint });
      }, { priority: GitQueuePriority.BACKGROUND, label: `build-spare:${folder}` });
      console.log(`[SPARE] build step=git done in ${Date.now() - startedAt}ms (${folder})`);
      // Asked again here, not only before the git phase: a task's script may
      // have started while the checkout was made.
      await whenNoInitScriptRunsOrAborted(signal);
      const setupStartedAt = Date.now();
      await manager.prepareWorktreeFiles(sparePath, inputs, { signal });
      const scriptStartedAt = Date.now();
      await manager.runWorktreeInitScript(sparePath, inputs, { signal });
      const installMs = Date.now() - scriptStartedAt;
      console.log(`[SPARE] build step=setup done in ${Date.now() - setupStartedAt}ms (${folder})`);
      signal.throwIfAborted();
      await writeSpareRecord(projectPath, { ...inputs, folder, builtAt: new Date().toISOString(), installMs });
      console.log(`[SPARE] ${folder} is ready, built in ${Date.now() - startedAt}ms`);
      return true;
    } catch (error) {
      const aborted = signal.aborted || isAbortError(error);
      // A quit leaves the folder for the startup pass: it has no record.
      if (!isShuttingDown() && fs.existsSync(sparePath)) {
        try {
          await manager.withLock(
            () => this.discardInQueue(manager, projectPath, sparePath),
            { priority: GitQueuePriority.BACKGROUND, label: `discard-spare:${folder}` },
          );
        } catch (discardError) {
          console.warn(`[SPARE] Could not discard ${folder}: ${firstLineOf(discardError)}`);
        }
      }
      if (aborted) {
        console.log(`[SPARE] build of ${folder} stopped after ${Date.now() - startedAt}ms`);
        throw error instanceof Error ? error : abortReason(signal);
      }
      console.warn(`[SPARE] build of ${folder} failed after ${Date.now() - startedAt}ms: ${firstLineOf(error)}`);
      return false;
    } finally {
      release();
    }
  }

  /**
   * Ask for a spare in this project: one loop per project waits until no init
   * script runs, stops when a usable spare exists or the project should have
   * none, and otherwise builds one. A yield (a task's setup started) aborts the
   * build and loops back to the wait. A failed build ends the loop until the
   * next request, so a broken script never retries on its own.
   */
  request(projectPath: string, hooks: SpareProjectHooks): void {
    const state = this.stateFor(projectPath);
    state.hooks = hooks;
    state.wanted = true;
    this.startLoop(projectPath, state);
  }

  private startLoop(projectPath: string, state: ProjectSpareState): void {
    if (state.loop) return;
    const controller = new AbortController();
    state.loopController = controller;
    state.loop = this.runLoop(projectPath, state, controller.signal).finally(() => {
      state.loop = null;
      if (state.loopController === controller) state.loopController = null;
      // A request that came after the loop's last look at `wanted` found the
      // loop still running and left it the work. Start again for it.
      if (state.wanted && state.hooks && !controller.signal.aborted && !isShuttingDown()) {
        this.startLoop(projectPath, state);
      }
    });
  }

  private async runLoop(projectPath: string, state: ProjectSpareState, signal: AbortSignal): Promise<void> {
    while (state.wanted && !signal.aborted && !isShuttingDown()) {
      state.wanted = false;
      try {
        await whenNoInitScriptRunsOrAborted(signal);
      } catch {
        return;
      }
      if (isShuttingDown() || !state.hooks) return;
      let inputs: SpareInputs | null;
      try {
        inputs = state.hooks.inputs();
        if (!inputs) return;
        if (await this.hasUsableSpare(projectPath, inputs, state.hooks.referencedFolders)) return;
        const verdict = await readNoSavingVerdict(projectPath);
        if (verdict && verdict.initScript === inputs.initScript) {
          console.log(
            `[SPARE] not building a spare in ${projectPath}: the last claim's catch-up took ${verdict.catchUpMs}ms `
            + `of the spare's ${verdict.buildInstallMs}ms install, so a spare saves nothing for this script`,
          );
          return;
        }
      } catch (error) {
        console.warn(`[SPARE] Could not check for a spare in ${projectPath}: ${firstLineOf(error)}`);
        return;
      }
      // Asked again after the reads above: a stop or the quit that came during
      // them found no build to abort.
      if (signal.aborted || isShuttingDown() || !state.hooks) return;
      const build = { controller: new AbortController(), stopReason: null as 'yield' | 'stop' | null };
      state.build = build;
      try {
        const built = await this.build(projectPath, inputs, build.controller.signal);
        if (!built) return;
      } catch (error) {
        if (build.stopReason === 'yield') {
          state.wanted = true;
          continue;
        }
        if (!isAbortError(error)) console.warn(`[SPARE] build loop for ${projectPath} ended: ${firstLineOf(error)}`);
        return;
      } finally {
        if (state.build === build) state.build = null;
      }
    }
  }

  /**
   * After a claim's catch-up script succeeded: when it took at least
   * `NO_SAVING_RATIO` of the spare's own install, the spare saved nothing (an
   * `npm ci` deletes node_modules and installs it all again), so record that
   * for this init script and stop refilling. A claim that did save clears an
   * older finding. Keyed by the script, so changing it starts spares again.
   * Never rejects.
   */
  async noteCatchUp(projectPath: string, initScript: string, catchUpMs: number, buildInstallMs: number | null): Promise<void> {
    if (buildInstallMs === null || buildInstallMs <= 0) return;
    const verdictPath = noSavingVerdictPathFor(projectPath);
    try {
      if (catchUpMs < buildInstallMs * NO_SAVING_RATIO) {
        await fs.promises.rm(verdictPath, { force: true });
        return;
      }
      const verdict: NoSavingVerdict = { initScript, buildInstallMs, catchUpMs, decidedAt: new Date().toISOString() };
      await writeJsonAtomically(projectPath, verdictPath, verdict);
      console.log(
        `[SPARE] the catch-up took ${catchUpMs}ms of the spare's ${buildInstallMs}ms install in ${projectPath}; `
        + 'no more spares for this init script',
      );
    } catch (error) {
      console.warn(`[SPARE] Could not record the claim's catch-up time: ${firstLineOf(error)}`);
    }
  }

  private async hasUsableSpare(
    projectPath: string,
    inputs: SpareInputs,
    referencedFolders: ReferencedFolders,
  ): Promise<boolean> {
    const ready = await this.readySpares(projectPath, referencedFolders);
    return ready.some((candidate) => spareInputsMatch(candidate.record, inputs));
  }

  /**
   * A task's init script is about to run: stop every spare build, in any
   * project, so its install does not share the disk with the task's. Each loop
   * waits until no init script runs, then builds again. The caller asks only
   * when the task's project has a script; a setup with none shares nothing.
   */
  yieldBuilds(): void {
    for (const state of this.projects.values()) {
      if (!state.build || state.build.controller.signal.aborted) continue;
      state.build.stopReason = 'yield';
      state.build.controller.abort();
    }
  }

  /**
   * Stop this project's spare builds and its loop, for a project delete or
   * relocate. Resolves once the loop has ended, so the caller's discard of the
   * spares comes after a build's own, and once no claim holds a spare: a claim
   * holds its spare from its git step through its catch-up script, and the
   * caller's discard, delete or move must not land inside that. Waits outside
   * the git queue, so a caller must not hold it. A claim's wait is bounded by
   * the init script's timeout, as a removal's wait for a creation is.
   */
  async stop(projectPath: string): Promise<void> {
    const state = this.projects.get(pathKey(projectPath));
    if (state) {
      state.wanted = false;
      state.hooks = null;
      state.loopController?.abort();
      if (state.build && !state.build.controller.signal.aborted) {
        state.build.stopReason = 'stop';
        state.build.controller.abort();
      }
      await this.idle(projectPath);
    }
    for (const folder of await listSpareFolders(projectPath)) {
      await waitForWorktreeCreation(path.join(worktreesRootFor(projectPath), folder));
    }
  }

  /** Resolves once this project's build loop, if one runs, has ended. The tests' wait for a refill. */
  async idle(projectPath: string): Promise<void> {
    const state = this.projects.get(pathKey(projectPath));
    if (!state) return;
    // A loop that ends with a request pending starts the next one in its own
    // `finally`, so look again until none runs.
    while (state.loop) await state.loop.catch(() => undefined);
  }

  /** The quit: abort every build at once. Synchronous: an abort kills the script's tree in place. */
  abortAllBuilds(): void {
    for (const state of this.projects.values()) {
      state.wanted = false;
      state.loopController?.abort();
      if (!state.build || state.build.controller.signal.aborted) continue;
      state.build.stopReason = 'stop';
      state.build.controller.abort();
    }
  }

  /**
   * The startup pass, also the discard-everything of a project delete or
   * relocate (`inputs` null). Discards every spare folder no task names and
   * nothing holds that has no ready record (its build was cut off) or whose
   * record does not match `inputs`, and deletes records whose folder is gone.
   * Each discard runs in the queue at BACKGROUND priority. Never rejects.
   */
  async sweep(projectPath: string, inputs: SpareInputs | null, referencedFolders: ReferencedFolders): Promise<void> {
    const manager = new WorktreeManager(projectPath);
    const folders = await listSpareFolders(projectPath);
    const referenced = folders.length > 0 ? referencedFolders() : new Set<string>();
    for (const folder of folders) {
      if (referenced.has(folder)) continue;
      const sparePath = path.join(worktreesRootFor(projectPath), folder);
      if (isWorktreeCreationInFlight(sparePath)) continue;
      const record = await readSpareRecord(projectPath, folder);
      if (record && inputs && spareInputsMatch(record, inputs)) continue;
      try {
        await manager.withLock(async () => {
          const release = tryHoldWorktreeCreation(sparePath);
          if (!release) return;
          try {
            console.log(`[SPARE] startup pass: discarding ${folder} (${record ? 'stale settings' : 'no ready record'})`);
            await this.discardInQueue(manager, projectPath, sparePath);
          } finally {
            release();
          }
        }, { priority: GitQueuePriority.BACKGROUND, label: `sweep-spare:${folder}` });
      } catch (error) {
        console.warn(`[SPARE] startup pass could not discard ${folder}: ${firstLineOf(error)}`);
      }
    }

    // Records whose folder is gone or that a task now names, and temp files a
    // quit left mid-write. A file of a spare still being built is left alone:
    // its build is writing it.
    let recordFiles: string[];
    try {
      recordFiles = await fs.promises.readdir(spareRecordsRootFor(projectPath));
    } catch {
      return;
    }
    // Read again: a task may have adopted a spare while the discards ran.
    const referencedNow = recordFiles.length > 0 ? referencedFolders() : new Set<string>();
    for (const fileName of recordFiles) {
      // Only a spare's own files; the no-saving finding outlives every spare.
      if (!fileName.startsWith(SPARE_FOLDER_PREFIX)) continue;
      const folder = fileName.split('.')[0] ?? '';
      const folderPath = path.join(worktreesRootFor(projectPath), folder);
      if (isSpareWorktreeFolder(folder) && isWorktreeCreationInFlight(folderPath)) continue;
      const orphan = !fileName.endsWith('.json')
        || fileName !== `${folder}.json`
        || !isSpareWorktreeFolder(folder)
        || referencedNow.has(folder)
        || !fs.existsSync(folderPath);
      if (!orphan) continue;
      await fs.promises.rm(path.join(spareRecordsRootFor(projectPath), fileName), { force: true }).catch(() => undefined);
    }
  }
}

/** The app's one pool. */
export const spareWorktreePool = new SpareWorktreePool();
