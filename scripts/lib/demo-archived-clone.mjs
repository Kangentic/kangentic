/**
 * Where an archived task's run happened: its own throwaway clone beside the project's scratch
 * clone (`~\work\contoso-web-cw-done-deploy` beside `~\work\contoso-web`).
 *
 * One rule, read by the script that makes the run (scripts/capture-demo-archived-runs.mjs) and the
 * one that points main's indexer at its history (scripts/capture-demo-knowledge-graph.mjs). It is
 * not stored in the run's record: the sanitizer rewrites anything that looks like the project's
 * scratch path to the sample install's, which is right for every other field and wrong for this one.
 */
import os from 'node:os';
import path from 'node:path';

/**
 * The scratch root both scripts take from `--root`, or the home directory. Shared so the graph
 * capture looks for a run's history under the root the run was given. A `--root` with no
 * directory after it is refused rather than read as the home directory.
 */
export function scratchRootFromArgv(argv) {
  const flagIndex = argv.indexOf('--root');
  if (flagIndex === -1) return os.homedir();
  const root = argv[flagIndex + 1];
  if (!root || root.startsWith('--')) throw new Error('--root needs a directory after it');
  return root;
}

/**
 * The project's scratch clone relative to the home directory, as segments. `projectPath` is the
 * dataset's `C:\Users\dev\<group>\<name>`; everything after the user's directory is kept.
 */
export function scratchCloneSegments(projectPath) {
  return projectPath.split(/[\\/]+/).slice(3);
}

/** The project's scratch clone under `root`, where its recordings ran. */
export function scratchClonePath(root, projectPath) {
  return path.join(root, ...scratchCloneSegments(projectPath));
}

/**
 * The archived clone's directory relative to the home directory, as segments: the scratch clone's,
 * with the task's id, less its `task-` prefix, appended to the last one.
 */
export function archivedCloneSegments(projectPath, taskId) {
  const segments = scratchCloneSegments(projectPath);
  segments[segments.length - 1] = `${segments[segments.length - 1]}-${taskId.replace(/^task-/, '')}`;
  return segments;
}

/** The clone's absolute path under `root` (the home directory unless the run moved it). */
export function archivedClonePath(root, projectPath, taskId) {
  return path.join(root, ...archivedCloneSegments(projectPath, taskId));
}
