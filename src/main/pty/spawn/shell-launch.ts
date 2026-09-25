import fs from 'node:fs';
import { spawnHelperCandidatePaths } from './spawn-helper-permissions';

/**
 * What to hand `child_process.spawn` or `execFile` to run a shell, with
 * `shell` as that call's own option.
 */
export interface ShellLaunch {
  file: string;
  args: string[];
  shell: boolean;
}

/**
 * A shell launch as its caller would write it without this module: either a
 * full command string for `shell: true`, or a shell and its argv
 * (`/bin/zsh ['-ilc', script]`).
 */
export type ShellLaunchTarget = { command: string } | { file: string; args: readonly string[] };

/**
 * The shell Node's own `shell: true` runs on macOS, used when a command string
 * has to be spelled out for the helper.
 */
const POSIX_SHELL = '/bin/sh';

/**
 * The first spawn-helper candidate this process may execute, or null.
 *
 * `restoreShellEnv` runs before `ensureSpawnHelperPermissions` at startup, so in
 * dev the stock helper can still be missing its execute bit here. Falling back
 * to a direct spawn then is the same as not having a helper at all, which beats
 * an EACCES that would break the login-shell probe.
 */
export function findExecutableSpawnHelper(): string | null {
  for (const candidate of spawnHelperCandidatePaths()) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Missing or not executable. Try the next one.
    }
  }
  return null;
}

/**
 * Launch a shell so that, on macOS, it and everything it starts has no task
 * exception port.
 *
 * On macOS a child inherits its parent's mach exception ports across exec, and
 * Crashpad owns Kangentic's. So a program started from a shell we launch writes
 * its crashes into our crash database and reaches Sentry as the foreign-crash
 * warning. Four `child_process` paths launch a shell that can run anything:
 * the login-shell env probe (`shell-env.ts`, on every macOS launch, whose
 * startup files can leave daemons running), `SHELL_EXEC` shortcuts, run-script
 * automations, and the post-worktree init script. Each goes through here, and
 * tests/unit/shell-launch-parity.test.ts fails on a `shell: true` launch that
 * does not.
 *
 * On macOS this routes the shell through node-pty's spawn-helper, the same
 * binary every PTY already runs through, with its argv layout
 * `[helper, cwd, file, ...args]`. The packaged app ships Kangentic's own build
 * of it, which clears the task's exception ports before exec. An empty cwd
 * means the helper does not change directory, so the spawn's own `cwd` option
 * still applies. In dev, node-pty's stock helper resolves: the same argv
 * contract without the reset, which keeps dev and packaged on one code path
 * (dev has no Crashpad port to inherit unless KANGENTIC_ERROR_REPORTING=1).
 *
 * What the helper changes, and why each is safe here:
 * - It execs the shell in place, so the pid is the shell's. A process-group
 *   kill, a returned pid, and an `execFile` timeout all still reach the shell.
 * - It calls `ttyname` on stdin and opens that terminal, and the open fails
 *   harmlessly when stdin is a pipe or /dev/null. Stdin must NOT be a terminal:
 *   a `detached` child has no controlling terminal and would adopt it. Every
 *   caller passes `ignore` or a pipe.
 * - A target that cannot be exec'd exits 1 instead of emitting ENOENT. The
 *   target is always a shell, which exists. Do not route a launch of an agent
 *   binary through here as it stands: a missing CLI must keep surfacing as
 *   ENOENT. If one ever has to be (the headless auto-name runs in
 *   agent/shared/auto-name.ts are the likely next source of foreign crashes,
 *   since agent hooks run there too), resolve the binary to an absolute path
 *   and check it with `fs.accessSync(path, X_OK)` first, so a missing CLI still
 *   fails as ENOENT before the helper is involved.
 *
 * Everywhere else, and on macOS with no executable helper, the launch is
 * exactly what the caller would have written: a command string with
 * `shell: true` (an empty args array raises no DEP0190), or the file and args
 * unchanged.
 */
export function resolveShellLaunch(
  target: ShellLaunchTarget,
  findHelper: () => string | null = findExecutableSpawnHelper,
): ShellLaunch {
  const helperPath = process.platform === 'darwin' ? findHelper() : null;
  if ('command' in target) {
    if (!helperPath) return { file: target.command, args: [], shell: true };
    return { file: helperPath, args: ['', POSIX_SHELL, '-c', target.command], shell: false };
  }
  if (!helperPath) return { file: target.file, args: [...target.args], shell: false };
  return { file: helperPath, args: ['', target.file, ...target.args], shell: false };
}
