/**
 * The environment for a program Kangentic starts on the user's behalf: a
 * terminal, an agent CLI run, git, a script, a shortcut.
 *
 * On Windows, Chromium's Crashpad (`components/crash/core/app/crashpad_win.cc`)
 * has the browser process put its handler's pipe in its own environment, as
 * `CHROME_CRASHPAD_PIPE_NAME`, so the processes Chromium starts can connect to
 * it. A non-initial Crashpad client that finds the variable registers with that
 * handler. So every child that inherited main's environment passed the pipe on
 * to whatever it started, and an Electron program among them (VS Code's `code`
 * CLI is Code.exe in Electron's node mode) wrote its crash into our database
 * and reached Sentry as the foreign-crash warning (DESKTOP-1S). macOS leaked
 * the same way through mach exception ports instead (see `resolveShellLaunch`
 * in `pty/spawn/shell-launch.ts`).
 *
 * Never delete the variable from main's own `process.env`. Kangentic's
 * renderer, GPU and utility processes (the pty host, retrieval, embed,
 * dictation) find the handler through it, and a global delete would silently
 * lose our own crash dumps. Strip it per launch, here, instead.
 * `tests/unit/child-env-parity.test.ts` fails on a `...process.env` spread
 * anywhere else in `src/main`.
 *
 * It runs on every platform. macOS and Linux never set the variable, so there
 * it changes no value.
 *
 * It imports nothing: the pty host bundles it, and
 * `tests/unit/pty-host-boundary.test.ts` keeps main-only modules out of that
 * bundle.
 */

/** The variable Chromium's Crashpad sets in the browser process on Windows. */
export const CRASHPAD_PIPE_NAME_ENV_KEY = 'CHROME_CRASHPAD_PIPE_NAME';

/**
 * A copy of `environment` without Crashpad's pipe name, matched
 * case-insensitively since Windows environment names are. Unset values are
 * dropped too, as a spawn drops them, so the result is plain data the pty host
 * can receive. Never changes `environment`.
 */
export function withoutCrashpadPipeName(environment: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    if (key.toUpperCase() === CRASHPAD_PIPE_NAME_ENV_KEY) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Main's environment with `overrides` on top, without Crashpad's pipe name: the
 * environment for any child that can run code Kangentic did not write.
 */
export function childProcessEnv(overrides?: NodeJS.ProcessEnv): Record<string, string> {
  return withoutCrashpadPipeName({ ...process.env, ...overrides });
}
