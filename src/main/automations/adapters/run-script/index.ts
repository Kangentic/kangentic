import { spawn } from 'node:child_process';
import { AUTOMATION_MANIFEST, DEFAULT_SCRIPT_TIMEOUT_MINUTES } from '../../../../shared/automation-manifest';
import type { AutomationConfig } from '../../../../shared/types';
import { describeAutomation } from '../../../../shared/automation-describe';
import { resolveScriptInvocation } from '../../../pty/spawn/script-invocation';
import { resolveShellLaunch } from '../../../pty/spawn/shell-launch';
import type { AutomationAdapter, AutomationContext } from '../../shared/automation-adapter';
import { AutomationTimeoutError } from '../../shared/automation-errors';

/**
 * Run script. Three things changed from the action it replaces, and all three
 * were bugs rather than features.
 *
 * It AWAITS the process and records its exit code. The old `run_script` awaited
 * the spawn DISPATCH and nothing else, so a non-zero exit was undetectable. An
 * automation that says "run setup, then message the agent" has to mean it,
 * which is only true if the script finishes first.
 *
 * It is a CHILD PROCESS, not a PTY. The first attempt reused
 * `SessionManager.spawn`, which opens an interactive shell and TYPES the
 * command into it; the shell then returns to its prompt and lives forever, so
 * the script's completion is unobservable and its exit code unobtainable. That
 * shipped and was caught in a preview: a script that finished in under a second
 * was recorded as "Gave up after 60s". Nobody watches a script's terminal, so
 * the PTY bought nothing and cost exactly the thing the adapter exists to do.
 * `resolveScriptInvocation` gives the same shell its non-interactive form.
 *
 * And there is no working-directory setting any more. A script always runs
 * task-relative, in the task's worktree or the project checkout when it has
 * none, so the one thing a user needed the setting for is now the default and
 * the legacy `workingDir` key is ignored.
 */
export const runScriptAdapter: AutomationAdapter = {
  id: 'run_script',
  manifest: AUTOMATION_MANIFEST.run_script,

  // Delegated so the row sentence has ONE definition: the renderer draws it
  // on every row in the Column Manager and cannot import this file.
  describe(config: AutomationConfig): string {
    return describeAutomation('run_script', config);
  },

  async execute(config, context) {
    const script = (config.script ?? '').trim();
    if (!script) return { detail: 'No script to run.' };

    const timeoutMs = resolveTimeoutMs(config);
    // The SAME shell the user's terminals run, in its non-interactive form, so
    // a script behaves the way it does when they test it by hand.
    const { exe, args } = resolveScriptInvocation(await context.sessionHost.getShell(), script);

    const exitCode = await runToCompletion({ exe, args, context, timeoutMs });
    if (exitCode !== 0) {
      throw new Error(`Script exited with code ${exitCode}.`);
    }
    return { detail: 'exit 0' };
  },
};

function resolveTimeoutMs(config: AutomationConfig): number {
  const minutes = config.timeoutMinutes;
  if (typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0) {
    return Math.min(minutes, 120) * 60_000;
  }
  return DEFAULT_SCRIPT_TIMEOUT_MINUTES * 60_000;
}

/**
 * Every template variable, also passed as an environment variable.
 *
 * This is the path a script SHOULD use. The field's `escape: 'shell'` handling
 * makes `{{title}}` safe to substitute, but it does that by STRIPPING the
 * characters that could break out, which is lossy; an environment variable is
 * not, so `"$KANGENTIC_TITLE"` gets the exact title on every shell.
 */
function scriptEnvironment(context: AutomationContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(context.templateVars)) {
    env[`KANGENTIC_${toScreamingSnakeCase(name)}`] = value;
  }
  return env;
}

function toScreamingSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
}

/**
 * Run the script to completion, bounded by the automation's own budget.
 *
 * The budget is a real bound, not a bound on how long we watch: on expiry the
 * process TREE is killed. A bare `child.kill()` reaches the shell only, and a
 * shell that has spawned `npm ci` leaves the install running with nothing left
 * to stop it.
 */
function runToCompletion(options: {
  exe: string;
  args: string[];
  context: AutomationContext;
  timeoutMs: number;
}): Promise<number> {
  const { exe, args, context, timeoutMs } = options;

  return new Promise<number>((resolve, reject) => {
    // On macOS this runs the shell through the spawn-helper, so nothing the
    // script starts holds Crashpad's exception port. The pid stays the shell's,
    // which the group kill below relies on.
    const launch = resolveShellLaunch({ file: exe, args });
    const child = spawn(launch.file, launch.args, {
      cwd: context.cwd,
      env: { ...process.env, ...scriptEnvironment(context) },
      // No shell: the invocation is already `<shell> -c <script>`, and letting
      // Node add a second one would re-parse the script through cmd.exe.
      shell: false,
      windowsHide: true,
      // Nothing reads the output, and an unread pipe fills and blocks a chatty
      // script. `ignore` closes stdin too, so a script that prompts fails fast
      // instead of waiting out its whole budget.
      stdio: 'ignore',
      // Windows has no process groups; `detached` there changes console
      // attachment rather than grouping, so the tree kill below is platform-
      // specific either way.
      detached: process.platform !== 'win32',
    });

    let settled = false;
    const finish = (apply: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
      apply();
    };

    const killTree = (): void => {
      if (child.pid === undefined) return;
      try {
        if (process.platform === 'win32') {
          // `taskkill /T` is the only way to reach a Windows child tree.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          // Negative pid targets the process GROUP `detached` created.
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        // Already gone between the deadline and the kill. Nothing to do.
      }
    };

    const onAbort = (): void => {
      killTree();
      finish(() => reject(new Error('The move was superseded before the script finished.')));
    };

    const timer = setTimeout(() => {
      killTree();
      finish(() => reject(new AutomationTimeoutError(
        `Script did not finish within ${Math.round(timeoutMs / 60_000)} min and was stopped.`,
      )));
    }, timeoutMs);

    // `error` fires instead of `close` when the shell itself cannot be started
    // (a missing executable, an unreadable cwd), so both paths settle.
    child.on('error', (spawnError) => finish(() => reject(spawnError)));
    // `close`, not `exit`: with stdio ignored they coincide, but `close` is the
    // one that waits for the streams in every other configuration.
    child.on('close', (code, signal) => {
      // A signalled death reports a null code. Report it as a failure rather
      // than as the success a `?? 0` would invent.
      finish(() => resolve(code ?? (signal ? 1 : 0)));
    });

    context.signal.addEventListener('abort', onAbort, { once: true });
  });
}
