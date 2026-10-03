/**
 * The reap for a task whose shell is WSL. The agent and everything it starts
 * are Linux processes inside the distro, invisible to the Windows process
 * table, so a scan-and-kill runs inside the distro instead, through
 * `wsl.exe -d <distro> -e sh -c <script> sh <arguments>`. The tag reaches the
 * distro because the spawn lists it in `WSLENV` (`task-process-tag.ts`).
 *
 * It applies the same two signals as `reap-plan.ts`: a process carries the
 * task's tag AND works inside the task's directories, each translated with
 * `wslpath -u` inside the distro. It does not apply the shared-subtree,
 * visible-app or tmux rules; a WSL agent leaves those rarely, and the gaps are
 * documented in docs/worktree-strategy.md.
 *
 * One `grep -z` per task finds the tagged processes, so a scan forks a few
 * processes rather than several per process in /proc (8 ms against 280 ms
 * with 140 processes, measured in Ubuntu on WSL 2). A directory from a drive
 * letter is compared without case, as the Windows drive behind it is: a
 * process that changed into `/mnt/c/users/...` is inside `C:\Users\...`. The
 * tag is still required, so that can only find more of the task's processes.
 * A grep without `-z` (an old BusyBox) fails the reap loudly instead of
 * finding nothing.
 *
 * A reap never boots the WSL VM: it runs only while the distro is running,
 * which it is whenever an agent in it could have left something behind.
 *
 * Task ids are validated before they enter the script text. Directories never
 * do: they arrive as positional arguments, which `sh` does not interpret.
 */

import { TASK_PROCESS_TAG_ENV, isValidTaskTagValue, type WslShellSpec } from './task-process-tag';

export type WslExec = (file: string, args: string[], options: { timeoutMs: number; env: Record<string, string> }) => Promise<string>;

const WSL_TIMEOUT_MS = 15_000;

/** One task to reap in the distro: its id and its Windows-side directories. */
export interface WslReapTask {
  taskId: string;
  directories: readonly string[];
}

/**
 * The POSIX sh script and its positional arguments. Arguments come in groups:
 * a task id, the count of its directories, then the directories.
 */
export function buildWslReapInvocation(tasks: readonly WslReapTask[]): { script: string; args: string[] } | null {
  const directoriesByTask = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!isValidTaskTagValue(task.taskId) || task.directories.length === 0) continue;
    const directories = directoriesByTask.get(task.taskId) ?? new Set<string>();
    for (const directory of task.directories) directories.add(directory);
    directoriesByTask.set(task.taskId, directories);
  }
  if (directoriesByTask.size === 0) return null;
  const args: string[] = [];
  for (const [taskId, directories] of directoriesByTask) args.push(taskId, String(directories.size), ...directories);
  const script = [
    // Nothing this script starts may carry a tag: grep reads its own environ.
    `unset ${TASK_PROCESS_TAG_ENV}`,
    "printf 'x\\0' | grep -qzx x 2>/dev/null || { echo 'grep has no -z' >&2; exit 3; }",
    'self=$$',
    // Each argument group becomes lines "id<TAB>fold<TAB>/linux/path" in
    // $pairs, where fold=1 marks a drive-letter directory, kept lower case.
    'pairs=""',
    'ids=""',
    'while [ $# -gt 0 ]; do',
    '  id=$1; count=$2; shift 2',
    '  ids="$ids $id"',
    '  while [ "$count" -gt 0 ]; do',
    '    fold=0',
    '    case "$1" in [A-Za-z]:*) fold=1;; esac',
    '    dir=$(wslpath -u "$1" 2>/dev/null) || dir=$1',
    '    dir=${dir%/}',
    '    [ "$fold" = 1 ] && dir=$(printf %s "$dir" | tr "[:upper:]" "[:lower:]")',
    '    [ -n "$dir" ] && pairs="$pairs$id\t$fold\t$dir',
    '"',
    '    shift; count=$((count - 1))',
    '  done',
    'done',
    // Whether working directory $2 (lower case $3) is inside a directory of task $1.
    'inside() {',
    '  printf %s "$pairs" | while IFS="\t" read -r pairId fold dir; do',
    '    [ "$pairId" = "$1" ] || continue',
    '    subject=$2; [ "$fold" = 1 ] && subject=$3',
    '    case "$subject/" in "$dir"/*) echo yes; break;; esac',
    '  done',
    '}',
    'scan() {',
    '  found=""',
    '  for id in $ids; do',
    `    for file in $(grep -lsxzF "${TASK_PROCESS_TAG_ENV}=$id" /proc/[0-9]*/environ); do`,
    '      pid=${file#/proc/}; pid=${pid%/environ}',
    '      [ "$pid" = "$self" ] && continue',
    '      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue',
    '      [ -n "$cwd" ] || continue',
    '      lower=$(printf %s "$cwd" | tr "[:upper:]" "[:lower:]")',
    '      [ -n "$(inside "$id" "$cwd" "$lower")" ] && found="$found $pid"',
    '    done',
    '  done',
    '  echo $found',
    '}',
    'first=$(scan)',
    '[ -z "$first" ] && exit 0',
    'kill -TERM $first 2>/dev/null',
    'sleep 1',
    'second=$(scan)',
    '[ -n "$second" ] && kill -KILL $second 2>/dev/null',
    'echo "$first $second"',
  ].join('\n');
  return { script, args };
}

/** Distro names from `wsl.exe -l --running -q`, which older WSL prints as UTF-16. */
export function parseRunningDistros(output: string): string[] {
  return output
    .replace(/\u0000/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * The default distro's name from `wsl.exe -l -v`, whose default row starts
 * with `*`, or null when no row is marked. The marker is not translated, and a
 * distro name holds no spaces, so the first word after it is the name.
 */
export function parseDefaultDistro(output: string): string | null {
  for (const line of output.replace(/\u0000/g, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('*')) continue;
    return trimmed.slice(1).trim().split(/\s+/)[0] || null;
  }
  return null;
}

/**
 * Run the reap inside the shell's distro. Returns the pids it killed. Never
 * throws: a failure (wsl.exe missing or refusing, a timeout) kills nothing and
 * is handed to `onFailure`, so the caller can log and report it.
 */
export async function reapTaggedProcessesInWsl(
  spec: WslShellSpec,
  tasks: readonly WslReapTask[],
  exec: WslExec,
  onFailure: (error: unknown) => void = () => {},
): Promise<number[]> {
  const invocation = buildWslReapInvocation(tasks);
  if (!invocation) return [];
  const env = { WSL_UTF8: '1' };
  try {
    const running = parseRunningDistros(await exec('wsl.exe', ['-l', '--running', '-q'], { timeoutMs: WSL_TIMEOUT_MS, env }));
    if (running.length === 0) return [];
    // A shell with no `-d` runs in the default distro, which can be stopped
    // while another one runs; naming it keeps the reap from booting it.
    const distro = spec.distro ?? parseDefaultDistro(await exec('wsl.exe', ['-l', '-v'], { timeoutMs: WSL_TIMEOUT_MS, env }));
    if (!distro || !running.some((name) => name.toLowerCase() === distro.toLowerCase())) return [];
    const output = await exec('wsl.exe', ['-d', distro, '-e', 'sh', '-c', invocation.script, 'sh', ...invocation.args], { timeoutMs: WSL_TIMEOUT_MS * 2, env });
    return [...new Set(output.split(/\s+/).filter((token) => /^\d+$/.test(token)).map(Number))];
  } catch (error) {
    onFailure(error);
    return [];
  }
}
