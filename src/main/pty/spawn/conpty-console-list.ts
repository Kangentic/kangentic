/**
 * Stops node-pty's ConPTY kill from forking a helper process.
 *
 * On Windows, node-pty's `kill()` forks `conpty_console_list_agent.js` with
 * `child_process.fork` to list the processes on the PTY's console, then kills
 * each one when the helper answers. Here the helper never answers:
 *
 * - A packaged build turns the RunAsNode fuse off (`build/afterPack.js`), and
 *   Electron documents that `fork` then does not work. The child is a second
 *   Kangentic.exe. Measured: the packaged exe ignores `ELECTRON_RUN_AS_NODE`
 *   and boots a full app. In a normal install that instance finds the
 *   single-instance lock taken and exits, and the running app's
 *   `second-instance` handler restores and focuses its window. That happened on
 *   every PTY kill: a task moved to Done, a suspend, a quit.
 * - Where the helper does run as Node (a dev build), it starts after `kill()`
 *   has already closed the pseudoconsole, so its `AttachConsole` fails and it
 *   exits without a reply (node-pty 1.1.0, Electron 41).
 *
 * Either way node-pty waited out its 5 s timeout and then killed the shell's
 * pid alone. This returns that same list at once, with no child process.
 * A terminal transition's `reapTaskLeftovers` still kills what the task's
 * agents left running, by their `KANGENTIC_TASK_ID` tag.
 */
import { WindowsPtyAgent } from 'node-pty/lib/windowsPtyAgent';

let installed = false;

/** Install the shortcut once per process, before the first PTY is killed. */
export function skipConsoleListHelper(): void {
  if (installed || process.platform !== 'win32') return;
  installed = true;
  WindowsPtyAgent.prototype._getConsoleProcessList = function shellPidOnly(this: WindowsPtyAgent): Promise<number[]> {
    return Promise.resolve([this._innerPid]);
  };
}
