// Persistent partitions (cookie jars) for the embedded browser pane.
//
// The pane's jar is keyed by TASK IDENTITY (project id + task id), not by the
// worktree path. That is deliberate: a jar keyed by path is dropped whenever the
// path changes (a relocate, a rename, a Done round-trip landing on a different
// folder), which logged the user out for no reason. Keyed by the task, the jar
// follows the task through any of those - the id never changes.
//
// The names are also SELF-DESCRIBING (`kng-<projectId>-<taskId>` and the
// project's `kng-<projectId>-identity` jar), so the orphan sweep can parse a jar
// directory back to its project and task and check existence, instead of hashing
// every task's possible paths to reverse an opaque hash.
//
// `browserPartitionForTask` / `browserPartitionForProjectIdentity` are imported
// by both the renderer (`<webview partition>`, from the pane's task+project) and
// the main process (the offscreen lane, the jar seeder, the clear-storage and
// sweep passes), so the two derive the same name from the same ids. Pure (no
// Node/Electron) so it runs identically in both.

/**
 * Legacy single shared partition. Pre-dates per-task keying. Kept as the
 * fallback when no project id is known (a pane with a null project), and
 * allowlisted by the sweep so its data is never reclaimed out from under a
 * no-project pane. The pre-task-keying `kngbrowser-<hash>` jars are a DIFFERENT,
 * now-abandoned scheme and ARE reclaimed (see isLegacyWorktreeJarDirName).
 */
export const BROWSER_PARTITION = 'persist:kangentic-browser';

/** On-disk directory name of the legacy shared jar (partition minus `persist:`). */
export const LEGACY_BROWSER_PARTITION_DIR_NAME = 'kangentic-browser';

/**
 * Normalize a uuid to a 32-char lowercase hex segment (hyphens stripped) so it
 * can sit in a partition name with no internal separators, making the name
 * unambiguously parseable back into its two ids. Exported so the sweep and the
 * clear-storage pass can match a parsed jar's ids (which are in this form)
 * against live project / task row ids.
 */
export function normalizePartitionId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

/**
 * Persistent partition for a task's embedded browser pane. Keyed by project +
 * task so it survives any worktree path change. Falls back to the legacy shared
 * jar only when a project or task id is missing (a pane with no project).
 */
export function browserPartitionForTask(
  projectId: string | null | undefined,
  taskId: string | null | undefined,
): string {
  if (!projectId || !taskId) return BROWSER_PARTITION;
  return `persist:kng-${normalizePartitionId(projectId)}-${normalizePartitionId(taskId)}`;
}

/**
 * The project's IDENTITY jar: the durable, project-wide store for non-localhost
 * (identity-provider) cookies that every task's jar seeds from and mirrors back
 * into. One per project. Falls back to the legacy jar when no project is known.
 */
export function browserPartitionForProjectIdentity(projectId: string | null | undefined): string {
  if (!projectId) return BROWSER_PARTITION;
  return `persist:kng-${normalizePartitionId(projectId)}-identity`;
}

/**
 * On-disk directory name Chromium uses for a `persist:` partition under
 * `<userData>/Partitions/`. Electron strips the `persist:` prefix and uses the
 * remainder verbatim; our names are filesystem-safe, so this is a literal strip.
 */
export function partitionDirName(partition: string): string {
  return partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition;
}

const KNG_TASK_DIR_RE = /^kng-([0-9a-f]{32})-([0-9a-f]{32})$/;
const KNG_IDENTITY_DIR_RE = /^kng-([0-9a-f]{32})-identity$/;
/** The pre-task-keying scheme, abandoned. Reclaimed once by the sweep. */
const LEGACY_WORKTREE_JAR_DIR_RE = /^kngbrowser-[0-9a-f]{8}$/;

/** What a `kng-...` jar directory belongs to, parsed back from its name. */
export type ParsedPartitionDir =
  | { kind: 'task'; projectId: string; taskId: string }
  | { kind: 'identity'; projectId: string };

/**
 * Parse a jar directory name back into the project (and task) it belongs to, or
 * null if it is not one of this feature's jars. The ids are the normalized
 * (hyphen-stripped, lowercase) forms - compare against `normalizePartitionId(row.id)`.
 */
export function parseKngPartitionDir(name: string): ParsedPartitionDir | null {
  const identity = KNG_IDENTITY_DIR_RE.exec(name);
  if (identity) return { kind: 'identity', projectId: identity[1] };
  const task = KNG_TASK_DIR_RE.exec(name);
  if (task) return { kind: 'task', projectId: task[1], taskId: task[2] };
  return null;
}

/** True for a current-scheme jar directory (`kng-<proj>-<task>` or `-identity`). */
export function isKngPartitionDirName(name: string): boolean {
  return parseKngPartitionDir(name) !== null;
}

/** True for a jar from the abandoned pre-task-keying scheme (reclaim target). */
export function isLegacyWorktreeJarDirName(name: string): boolean {
  return LEGACY_WORKTREE_JAR_DIR_RE.test(name);
}
