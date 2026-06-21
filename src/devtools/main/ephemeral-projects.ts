/**
 * Dev-only: create isolated CLONE projects for the `/preview` so project-switch
 * AND real agent workflows can be exercised against the real app. The preview
 * runs the worktree's current working state (Vite/HMR); these clones are the
 * boards/sandboxes you switch between.
 *
 * Hard guarantee: `/preview` must never change the repo it runs from. So a clone
 * is an INDEPENDENT local git clone of the worktree (`git clone --local` -
 * hardlinked objects, fast; a separate repo), giving full `CLAUDE.md` / `.claude/`
 * / source context an agent can read, edit, even commit, without ever touching the
 * source worktree. It is SOURCE-ONLY (no `node_modules` junction) on purpose: with
 * no link anywhere under `.kangentic/`, the ephemeral cleanup can never follow one
 * into the shared deps. Clones live under the ephemeral data dir and are removed
 * with it (fresh on every boot + on close).
 *
 * Boot speed: cloning is split into a fast `--no-checkout` step (just the hardlinked
 * .git) done synchronously, and the slow working-tree checkout (`fillPreviewClone`)
 * deferred until AFTER the board is open, so the checkout never contends with the
 * project open or delays the board appearing.
 *
 * Build-excluded from production: imported only behind `__KANGENTIC_DEV__` guards
 * (src/main/index.ts), so esbuild dead-code elimination drops this module from prod
 * bundles. See `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getProjectDb } from '../../main/db/database';
import { DEFAULT_AGENT } from '../../shared/types';
import type { Project } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';

const execFileAsync = promisify(execFile);

// Module state; resets to 0 when the main process restarts (fresh preview boot).
let previewProjectIndex = 0;

function previewProjectsRoot(): string {
  // KANGENTIC_DATA_DIR is <worktree>/.kangentic/data in ephemeral mode (gitignored
  // + removed on boot and on close); fall back to the OS temp dir otherwise.
  return path.join(process.env.KANGENTIC_DATA_DIR ?? os.tmpdir(), 'preview-projects');
}

/**
 * Check out the committed team board config (kangentic.json) into the clone's working
 * tree right after the --no-checkout clone, BEFORE the DB is seeded and the board opens.
 * Without it, the default-seed columns (random uuids) exist before the team config is on
 * disk, so the deferred fillPreviewClone applies the config too late and ghosts the
 * config-id columns that already accumulated tasks. Checking out HEAD (not copying the
 * possibly-dirty worktree file) keeps the content identical to what fillPreviewClone later
 * restores, so the post-fill file-watch event is a no-op. Best-effort: a repo with no
 * committed kangentic.json just falls back to prior behavior.
 */
export async function checkoutTeamConfig(cloneDir: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', cloneDir, 'checkout', 'HEAD', '--', 'kangentic.json']);
  } catch (checkoutError) {
    console.warn(`[DEV] Preview team-config checkout failed for ${cloneDir}:`, checkoutError);
  }
}

/**
 * Clone the worktree into an isolated preview project ("Project N") and register
 * it. FAST: `--no-checkout` copies only the hardlinked .git (~instant), so the
 * working tree is empty until fillPreviewClone() runs - except kangentic.json, which
 * is checked out eagerly so the board reconciles to the committed config at open. Does
 * NOT open/switch to it.
 */
export async function createPreviewClone(context: IpcContext, worktreePath: string): Promise<Project> {
  previewProjectIndex += 1;
  const projectName = `Project ${previewProjectIndex}`;
  const cloneDir = path.join(previewProjectsRoot(), `project-${previewProjectIndex}`);
  // Independent local clone, --no-checkout: hardlinked objects only, no working-tree
  // checkout (the slow part on Windows). A SEPARATE repo, so edits/commits here never
  // reach the source worktree. node_modules is gitignored (not cloned) and NOT
  // junctioned - keeping cleanup safe. ADOPT an existing clone if one is already on
  // disk: the /preview script pre-clones Project 1 before launch to overlap the build,
  // so on boot the main process just creates the project rather than cloning again.
  // On-demand projects (the button) have no pre-clone and are cloned here.
  if (!fs.existsSync(path.join(cloneDir, '.git'))) {
    await execFileAsync('git', ['clone', '--no-checkout', '--local', worktreePath, cloneDir]);
  }
  // Put the committed team board config on disk BEFORE seeding the DB / opening the board,
  // so the default-seed columns get cleanly reconciled (deleted/adopted by config id) at
  // open instead of being ghosted by the late, post-task reconciliation. Runs on the adopt
  // path too (the pre-clone is also --no-checkout). The slow full-tree checkout stays deferred.
  await checkoutTeamConfig(cloneDir);
  const project = context.projectRepo.create({ name: projectName, path: cloneDir, default_agent: DEFAULT_AGENT });
  // Initialize the project DB (tables + default swimlanes) so it shows a real board.
  getProjectDb(project.id);
  // create() prepends at position 0; append so the sidebar keeps creation order.
  const orderedIds = context.projectRepo
    .list()
    .filter((existing) => existing.id !== project.id)
    .map((existing) => existing.id);
  orderedIds.push(project.id);
  context.projectRepo.reorder(orderedIds);
  return project;
}

/**
 * Populate a preview clone's working tree from HEAD (the slow checkout, ~seconds on
 * Windows). Call this AFTER the board is open so it never contends with the project
 * open or delays boot. Resolves when done; swallows errors (best-effort).
 */
export async function fillPreviewClone(clonePath: string): Promise<void> {
  try {
    await execFileAsync('git', ['-C', clonePath, 'reset', '--hard', 'HEAD']);
  } catch (fillError) {
    console.warn(`[DEV] Background working-tree fill failed for ${clonePath}:`, fillError);
  }
}

let devIpcRegistered = false;

/**
 * Register the dev-only IPC behind the TestHarness "Create Project" button: each
 * click clones the worktree into another isolated preview project and fills its
 * working tree in the background. Idempotent.
 */
export function registerEphemeralProjectDevIpc(getContext: () => IpcContext | null, worktreePath: string): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(IPC.DEV_CREATE_EPHEMERAL_PROJECT, async () => {
    const context = getContext();
    if (!context) throw new Error('Cannot create preview clone: no IPC context');
    const project = await createPreviewClone(context, worktreePath);
    // Fill the working tree in the background; the project is already usable.
    void fillPreviewClone(project.path);
    return project;
  });
}
