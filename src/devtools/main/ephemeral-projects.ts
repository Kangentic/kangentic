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
import { agentRegistry } from '../../main/agent/agent-registry';
import { DEFAULT_AGENT } from '../../shared/types';
import type { BoardColumnConfig, PermissionMode, Project } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';

const execFileAsync = promisify(execFile);

// Module state; resets to 0 when the main process restarts (fresh preview boot).
let previewProjectIndex = 0;

export function previewProjectsRoot(): string {
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
 * The model + effort every preview column runs at.
 *
 * A preview clone inherits the REAL board's committed `kangentic.json`, which sets
 * per-column overrides like `claude-opus-5` / `xhigh`. That is correct for the
 * actual board and wrong for a throwaway preview: agents spawned while testing a
 * UI change bill the developer's subscription at the most expensive tier they own,
 * and a preview exists to exercise the app, not to do the work well. Forcing the
 * cheapest tier makes agent-driven preview testing effectively free.
 */
// The model FAMILY, not a pinned release id. `model_override` is documented as a
// free-form, adapter-specific identifier (`opus`, `sonnet`), and the agent CLI
// resolves the family to whatever the current release is - so this cannot rot the
// way `claude-haiku-4-5-20251001` would the moment a new Haiku ships.
const PREVIEW_MODEL = 'haiku';
const PREVIEW_EFFORT = 'low';

/**
 * What an `auto` column becomes in a preview.
 *
 * `auto` is not offered on the cheap tier, so a column carrying it would fail to
 * spawn against `PREVIEW_MODEL`. `acceptEdits` is the closest still-autonomous mode
 * (and the app's own `DEFAULT_PERMISSION`), so a preview agent keeps running
 * unattended. Only `auto` is rewritten: `plan` is a distinct workflow with a
 * `planExitTarget`, not an autonomy level, and rewriting it would break the
 * plan-exit hand-off the Planning column exists for.
 */
// Typed as PermissionMode, not bare strings: these are compared against and
// written into real board config, so a rename of a union member must fail
// `npm run typecheck` rather than silently stop matching at runtime.
const PREVIEW_PERMISSION_MODE: PermissionMode = 'acceptEdits';
const REPLACED_PERMISSION_MODE: PermissionMode = 'auto';

/**
 * The slice of a column we read out of the parsed `kangentic.json`. Derived from
 * `BoardColumnConfig` rather than hand-rolled, so `permissionMode` stays coupled
 * to the real `PermissionMode` union: type-safety otherwise stops at the
 * `JSON.parse` boundary, and this code dispatches on a string-literal
 * comparison against it.
 */
type PreviewTeamColumn = Pick<BoardColumnConfig, 'id' | 'permissionMode'>;

interface PreviewTeamConfig {
  columns?: PreviewTeamColumn[];
}

/**
 * Point every preview column at the cheap tier by writing the clone's LOCAL board
 * override (`kangentic.local.json`), which merges over the committed team config
 * per column by id.
 *
 * The local file, not the team file. Editing the checked-out `kangentic.json` was
 * tried and is wrong twice over: `fillPreviewClone` later runs `git reset --hard
 * HEAD`, which reverts the edit (so the columns quietly go back to Opus), and that
 * revert is a real content change on a watched file, so the board raises its
 * "Board configuration changed - apply?" prompt on every preview boot. The local
 * override is untracked, so `reset --hard` leaves it alone and the tracked file
 * stays byte-identical to HEAD, keeping the post-fill watch event the no-op
 * `checkoutTeamConfig` intends.
 *
 * Written before the project is registered, so it is on disk ahead of the first
 * board open and no watcher exists yet to fire on its creation. Best-effort: a
 * repo with no committed config keeps the agent defaults, which is already cheap.
 */
export async function forcePreviewCheapModels(cloneDir: string): Promise<void> {
  const teamPath = path.join(cloneDir, 'kangentic.json');
  const localPath = path.join(cloneDir, 'kangentic.local.json');
  try {
    if (!fs.existsSync(teamPath)) return;
    const team = JSON.parse(fs.readFileSync(teamPath, 'utf-8')) as PreviewTeamConfig;
    if (!Array.isArray(team.columns)) return;
    // Match by id: a local column whose id is absent from the team config is
    // treated as a NEW column and inserted, which would duplicate the board.
    const columns = team.columns
      .filter((column): column is PreviewTeamColumn & { id: string } => typeof column.id === 'string')
      .map((column) => ({
        id: column.id,
        modelOverride: PREVIEW_MODEL,
        effortOverride: PREVIEW_EFFORT,
        // Only rewrite `auto`; leave `plan` (and anything else) alone. Omitting the
        // key entirely lets the team value through the per-column merge.
        ...(column.permissionMode === REPLACED_PERMISSION_MODE
          ? { permissionMode: PREVIEW_PERMISSION_MODE }
          : {}),
      }));
    if (columns.length === 0) return;
    fs.writeFileSync(localPath, `${JSON.stringify({ version: 1, columns }, null, 2)}\n`);
  } catch (overrideError) {
    console.warn(`[DEV] Preview cheap-model override failed for ${cloneDir}:`, overrideError);
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
  // Immediately after the checkout and BEFORE the DB is seeded / the board opens,
  // so the columns reconcile straight to the cheap tier rather than briefly
  // adopting the committed Opus/xhigh values.
  await forcePreviewCheapModels(cloneDir);
  const project = context.projectRepo.create({
    name: projectName,
    path: cloneDir,
    default_agent: DEFAULT_AGENT,
    // The project-level floor, covering columns that carry no override of their
    // own (To Do, Done) and any column added during a preview session.
    default_model: PREVIEW_MODEL,
    default_effort: PREVIEW_EFFORT,
  });
  // Initialize the project DB (tables + default swimlanes) so it shows a real board.
  getProjectDb(project.id);
  // Pre-seed agent trust for the brand-new clone path BEFORE the board opens and any
  // agent (or capability-detection probe) runs there. Without this, the clone lives at a
  // path the agent CLI has never seen, so it treats the workspace as untrusted and ignores
  // the committed .claude/settings.json permissions.allow entries. Going through the generic
  // adapter (not a hardcoded Claude helper) keeps this agent-agnostic; each adapter merges into
  // its own trust store (e.g. Claude's ~/.claude.json) under a serial lock, idempotent with the
  // spawn-time call.
  try {
    await agentRegistry.get(project.default_agent)?.ensureTrust(cloneDir);
  } catch (trustError) {
    console.warn(`[DEV] Preview trust seeding failed for ${cloneDir}:`, trustError);
  }
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
