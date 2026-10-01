import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as esbuild from 'esbuild';

/**
 * Enforces .claude/rules/pty-host-out-of-process.md: every PTY runs in the
 * `kangentic-pty-host` utility process, and main reaches it only through the
 * pty host client.
 *
 * The host runs where `electron`'s main-only modules do not exist (`app`,
 * `ipcMain`, `BrowserWindow`), so a module in its graph that reaches for them
 * kills the host on every fork, and with it every terminal. Analytics and
 * Sentry are main-only for the same reason. So the host's bundle, built the
 * way scripts/build.js builds it, must hold none of them.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const HOST_ENTRY = 'src/main/pty/host/pty-host-entry.ts';
const HOST_OUTPUT = '.vite/build/pty-host.js';

function readEsbuildExternals(): string[] {
  const buildSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf-8');
  const match = buildSource.match(/external:\s*\[([^\]]*)\]/);
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

async function bundleInputs(entry: string, devBuild: boolean): Promise<esbuild.Metafile['inputs']> {
  const result = await esbuild.build({
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external: readEsbuildExternals(),
    conditions: ['require'],
    define: {
      MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(''),
      MAIN_WINDOW_VITE_NAME: JSON.stringify('main_window'),
      __KANGENTIC_DEV__: devBuild ? 'true' : 'false',
    },
    entryPoints: [path.join(REPO_ROOT, entry)],
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return result.metafile.inputs;
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectSourceFiles(fullPath));
    else if (entry.name.endsWith('.ts')) files.push(fullPath);
  }
  return files;
}

/** Every `file:line` of code under src/main matching `pattern`, outside
 *  `allowed`. Comment lines are skipped: prose may name what code may not do. */
function findOutside(pattern: RegExp, allowed: ReadonlySet<string>): string[] {
  const offenders: string[] = [];
  for (const filePath of collectSourceFiles(path.join(REPO_ROOT, 'src/main'))) {
    const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
    if (allowed.has(relativePath)) continue;
    fs.readFileSync(filePath, 'utf-8').split('\n').forEach((line, index) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (pattern.test(line)) offenders.push(`${relativePath}:${index + 1}`);
    });
  }
  return offenders;
}

describe('pty host out-of-process boundary', () => {
  it('builds the pty host as its own entry in both build.js and dev.js', () => {
    for (const scriptName of ['build.js', 'dev.js']) {
      const source = fs.readFileSync(path.join(REPO_ROOT, 'scripts', scriptName), 'utf-8');
      expect(source, `scripts/${scriptName} must build ${HOST_ENTRY} as its own entry`).toContain(HOST_ENTRY);
      expect(source, `scripts/${scriptName} must output ${HOST_OUTPUT}`).toContain(HOST_OUTPUT);
    }
  });

  it('keeps electron, analytics, Sentry and the IPC layer out of the host bundle', async () => {
    for (const devBuild of [false, true]) {
      const inputs = await bundleInputs(HOST_ENTRY, devBuild);
      const offenders: string[] = [];
      for (const [input, info] of Object.entries(inputs)) {
        const normalized = input.replace(/\\/g, '/');
        if (/src\/main\/(analytics|ipc|pop-out|retrieval)\//.test(normalized)) offenders.push(`${normalized} (main-only module)`);
        if (/src\/devtools\//.test(normalized)) offenders.push(`${normalized} (dev tooling)`);
        if (/node_modules\/(@sentry|@aptabase)\//.test(normalized)) offenders.push(`${normalized} (main-only package)`);
        for (const imported of info.imports) {
          if (imported.path === 'electron') offenders.push(`${normalized} imports electron`);
        }
      }
      expect(
        offenders,
        `The pty host's ${devBuild ? 'dev' : 'production'} graph reaches main-only code. Trace each from `
          + `${HOST_ENTRY} and keep the main-only part behind the client:\n${offenders.join('\n')}`,
      ).toEqual([]);
      // Not vacuous: the host does bundle the core and the headless buffer.
      const inputNames = Object.keys(inputs).map((input) => input.replace(/\\/g, '/'));
      expect(inputNames.some((input) => input.endsWith('src/main/pty/host/pty-host-core.ts'))).toBe(true);
      expect(inputNames.some((input) => input.endsWith('src/main/pty/buffer/pty-buffer-manager.ts'))).toBe(true);
    }
  }, 60_000);

  it('forks the utility host only from register-all.ts, and runs the core in main only as the fallback', () => {
    expect(
      findOutside(/\bnew UtilityPtyHostTransport\s*\(/, new Set(['src/main/ipc/register-all.ts'])),
      'The pty host is one process for the app, forked once in register-all.ts.',
    ).toEqual([]);
    // The in-process core runs every chunk's work on main's event loop: it is
    // the unit tests' host and the fallback after repeated host crashes, both
    // built by SessionManager.createInProcessHost.
    expect(
      findOutside(/\bnew InProcessPtyHostTransport\s*\(/, new Set(['src/main/pty/session-manager.ts'])),
      'Only SessionManager.createInProcessHost may run the host core in main.',
    ).toEqual([]);
    expect(
      findOutside(/\bnew PtyHostCore\s*\(/, new Set(['src/main/pty/host/pty-host-entry.ts', 'src/main/pty/host/pty-host-client.ts'])),
      'PtyHostCore is built by the utility host entry or the in-process transport, nowhere else.',
    ).toEqual([]);
  });

  it('runs one-shot children through the drop-in, and the host never forks or launches itself', () => {
    // A packaged Kangentic.exe started as a child, with RunAsNode off, boots a
    // second app. The exec service uses exec/execFile only and checks the path.
    const hostExec = fs.readFileSync(path.join(REPO_ROOT, 'src/main/pty/host/host-exec.ts'), 'utf-8');
    expect(hostExec).not.toMatch(/\bfork\s*\(/);
    expect(hostExec).toMatch(/launchesOwnBinary\(request\)/);
    // Every promisified exec on main goes through off-main-exec.ts, so its
    // spawn runs in the host. The exceptions run where no host is reachable.
    const allowed = new Set([
      'src/main/utility-process/off-main-exec.ts',
      // Captures the login shell's environment at startup, before the host exists.
      'src/main/shell-env.ts',
      // Runs in the retrieval worker, which spawns on its own thread.
      'src/main/retrieval/branch-git.ts',
    ]);
    expect(
      findOutside(/promisify\((exec|execFile)\)/, allowed),
      'Import execAsync / execFileAsync from src/main/utility-process/off-main-exec.ts instead.',
    ).toEqual([]);
  });

  it('spawns session PTYs only in the host core', () => {
    // node-pty's value import is the host core's alone. The probe PTYs run
    // short, rare processes of their own (the Claude model picker, the
    // Antigravity print runner) and load node-pty lazily with `import()`.
    const allowed = new Set([
      'src/main/pty/host/pty-host-core.ts',
      'src/main/pty/spawn/conpty-console-list.ts',
    ]);
    expect(findOutside(/^import\s+(?!type\b).*from\s+'node-pty/, allowed)).toEqual([]);
  });
});
