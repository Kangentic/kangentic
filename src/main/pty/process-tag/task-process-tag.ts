/**
 * The environment tag that marks every process a task's agent starts.
 *
 * A task session's PTY is spawned with `KANGENTIC_TASK_ID=<taskId>`. Every
 * descendant inherits it at exec: a backgrounded dev server, a `nohup`, a
 * `Start-Process`, a `setsid`, a process reparented to init after its launcher
 * exited. That makes the tag the one membership signal that survives every way
 * a process can leave its parent tree, which a parent-pid walk does not, and it
 * survives an app restart because it lives in the processes themselves. A
 * terminal transition (Done, To Do, Backlog, delete) kills the processes that
 * carry the task's tag and are the task's: working in its directories, not
 * shared, not a visible app or a tmux server. See `reap-plan.ts`.
 *
 * Jenkins' ProcessTreeKiller has used the same mechanism (`BUILD_ID`) since
 * 1.260, including its opt-out: a process started with the tag cleared
 * (`KANGENTIC_TASK_ID= npm run dev`) no longer belongs to the task.
 *
 * Bundled by the pty host, so it imports nothing main-only.
 */

export const TASK_PROCESS_TAG_ENV = 'KANGENTIC_TASK_ID';

/**
 * Task ids are uuid v4 strings. Anything else is refused before it reaches a
 * scan, and before it is interpolated into the WSL reap script.
 */
const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidTaskTagValue(value: string): boolean {
  return TASK_ID_PATTERN.test(value);
}

/** The distro a WSL shell spec names, or null for the default distro. */
export interface WslShellSpec {
  distro: string | null;
}

/**
 * Parse a user-facing shell spec (`wsl -d Ubuntu`, `wsl.exe`, `wsl`) as a WSL
 * shell. Returns null for any other shell. Mirrors the spec form
 * `resolveShellArgs` (pty-spawn.ts) splits.
 */
export function parseWslShellSpec(shell: string): WslShellSpec | null {
  const parts = shell.trim().split(/\s+/);
  const executable = (parts[0] ?? '').toLowerCase();
  if (executable !== 'wsl' && executable !== 'wsl.exe') return null;
  for (let index = 1; index < parts.length - 1; index += 1) {
    if (parts[index] === '-d' || parts[index] === '--distribution') {
      return { distro: parts[index + 1] };
    }
  }
  return { distro: null };
}

/**
 * Add the task tag to a session's spawn env. On a WSL shell the tag is also
 * listed in `WSLENV`, which is how a Windows variable crosses into the distro
 * (`/u`: only when a Win32 process launches WSL).
 */
export function addTaskProcessTag(
  env: Record<string, string>,
  taskId: string,
  options: { wslShell: boolean; inheritedWslEnv?: string },
): Record<string, string> {
  const tagged: Record<string, string> = { ...env, [TASK_PROCESS_TAG_ENV]: taskId };
  if (options.wslShell) {
    const existing = env.WSLENV ?? options.inheritedWslEnv ?? '';
    const entries = existing.split(':').filter((entry) => entry.length > 0);
    const alreadyListed = entries.some((entry) => entry.split('/')[0] === TASK_PROCESS_TAG_ENV);
    if (!alreadyListed) entries.push(`${TASK_PROCESS_TAG_ENV}/u`);
    tagged.WSLENV = entries.join(':');
  }
  return tagged;
}
