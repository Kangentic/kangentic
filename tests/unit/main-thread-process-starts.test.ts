import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { builtinModules } from 'node:module';
import * as esbuild from 'esbuild';
import * as ts from 'typescript';

/**
 * Enforces .claude/rules/main-starts-no-process.md: main-process code starts no
 * child process on main's thread.
 *
 * On Windows `child_process.spawn` runs CreateProcess on the calling thread. A
 * start on main during the boot burst held the window for 3,850 ms, and an
 * ordinary one costs 17 to 71 ms. Every start goes through the drop-ins in
 * `src/main/utility-process/`, which run it on the pty host's spawn worker.
 *
 * The scan is main's own import graph, bundled the way scripts/build.js bundles
 * it. A worker's or the pty host's entry is a different graph, so nothing has
 * to list what to leave out. Any module in main's graph that imports
 * `child_process` is a start that can land on main's thread, and each one is
 * classified below with the reason it does not, or the reason it may.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const MAIN_ENTRY = 'src/main/index.ts';
const CHILD_PROCESS_MODULE = /^(node:)?child_process$/;

interface ClassifiedStart {
  /** The `child_process` exports the file may import. `*` is the whole module. */
  bindings: string[];
  /** Why a start here is not on main's thread, or why it is allowed to be. */
  reason: string;
}

/**
 * Every file of ours in main's graph that imports `child_process`. A new one
 * fails until it routes through a drop-in (`execFileAsync` / `execAsync` in
 * off-main-exec.ts, `spawnOffMain` in off-main-spawn.ts) or is classified here.
 * None of these starts a process on main's thread while a pty host is up,
 * except the two that say so: the quit, and a stop after the host died.
 */
const CLASSIFIED_STARTS: Record<string, ClassifiedStart> = {
  // The drop-ins' own fallbacks, which run only where no pty host is registered.
  'src/main/utility-process/off-main-exec.ts': {
    bindings: ['exec', 'execFile'],
    reason: 'the drop-in itself: a child runs here only when no pty host is registered (unit tests, startup before the host)',
  },
  'src/main/utility-process/off-main-spawn.ts': {
    bindings: ['spawn'],
    reason: 'the drop-in for a streamed child: it asks spawnOffMainCli first and spawns here only when no pty host is registered',
  },
  'src/main/agent/shared/cli-print.ts': {
    bindings: ['spawn'],
    reason: 'spawnCli asks spawnOffMainCli first and spawns here only when no pty host is registered',
  },
  'src/main/git/spawn-with-abort.ts': {
    bindings: ['spawn'],
    reason: 'git and a project script go through spawnOffMainCli; the spawn here is the no-host fallback',
  },
  'src/main/shared/child-tree-stop.ts': {
    bindings: ['spawn'],
    reason: 'taskkill for a run main has to stop itself: one whose host died, a fallback child, and every CLI run at quit',
  },

  // Before the host exists, and after it is gone.
  'src/main/shell-env.ts': {
    bindings: ['execFile'],
    reason: 'reads the login shell environment at startup, before the pty host exists, on macOS and Linux only',
  },
  'src/main/shutdown.ts': {
    bindings: ['*'],
    reason: 'the hard quit failsafe: a synchronous taskkill of this process tree, the last thing main does',
  },

  // The pty host's own modules. Main bundles them for the in-process host core,
  // which runs only as the unit tests' host and the fallback after five host crashes.
  'src/main/pty/host/host-exec.ts': {
    bindings: ['exec', 'execFile'],
    reason: 'the host exec runner: on the spawn worker in production, on main only inside the in-process host core',
  },
  'src/main/pty/host/host-cli-processes.ts': {
    bindings: ['spawn'],
    reason: 'the host CLI runner: on the spawn worker in production, on main only inside the in-process host core',
  },
  'src/main/activity-engine/background-shell/process-tree.ts': {
    bindings: ['spawn'],
    reason: 'the process table probe: production reads the table through the host, and this one runs only inside the in-process core',
  },
  'src/main/pty/process-tag/darwin-reader.ts': {
    bindings: ['spawn'],
    reason: 'ps and lsappinfo for the task reap: the host passes its spawn service, and this default runs only inside the in-process core',
  },
  'src/main/retrieval/branch-git.ts': {
    bindings: ['spawn'],
    reason: 'readBlobs runs git cat-file where the code indexer runs, in the retrieval worker; what main calls here goes through execFileAsync',
  },

  // Dev tooling.
  'src/devtools/main/spawn-tracer.ts': {
    bindings: ['ChildProcess'],
    reason: 'wraps ChildProcess.prototype.spawn to time every start for the lag report, and starts nothing itself',
  },
};

/**
 * Bundled third-party packages in main's graph that import `child_process`.
 * Their starts are the package's own code, which no drop-in reaches.
 */
const CLASSIFIED_PACKAGES: Record<string, string> = {
  '@aptabase/electron': 'reads the macOS version with /usr/bin/sw_vers once at start, and starts nothing on Windows or Linux',
  '@sentry/electron': 'additionalContext runs PowerShell or system_profiler only with deviceModelManufacturer on, which main never sets (pinned below)',
  '@sentry/node': 'nodeContextIntegration runs /usr/bin/sw_vers once at init, on macOS only',
  'electron-updater': 'the installer launch at quit-and-install, and one PowerShell signature check after an update downloads when the feed names a publisher',
};

/**
 * Every esbuild external main's graph reaches. An external is loaded from
 * node_modules at run time, so its own imports are not in the graph: each is
 * read once and classified by whether it starts a process.
 */
const EXTERNAL_PACKAGES: Record<string, { startsProcess: boolean; reason: string }> = {
  electron: {
    startsProcess: true,
    reason: 'renderers and utility processes, which Chromium launches on its own launcher thread; every utilityProcess.fork site is pinned by stderr-tail.test.ts',
  },
  'node-pty': {
    startsProcess: true,
    reason: 'PTYs: main loads it only inside the in-process host core and the off-main-pty.ts no-host fallback (pty-host-boundary.test.ts)',
  },
  'better-sqlite3': { startsProcess: false, reason: 'the native SQLite addon, which starts no process' },
  koffi: { startsProcess: false, reason: 'a foreign function interface, which starts no process' },
  'original-fs': { startsProcess: false, reason: 'Electron\'s unpatched fs module, which starts no process' },
  'sqlite-vec': { startsProcess: false, reason: 'resolves the vec0 extension\'s path, and starts no process' },
};

/**
 * Packages that start a process from the thread that calls them, each replaced
 * by code of ours: `font-list` by src/preload/local-fonts.ts, `node-machine-id`
 * by src/main/analytics/machine-id.ts. Never in main's graph, never declared.
 */
const BANNED_PACKAGES = ['font-list', 'node-machine-id'];

/**
 * Never in main's graph, though still installed. simple-git starts every git
 * command on its caller's thread and has no hook for another spawn, so the app
 * reads git through `gitAt` (src/main/git/git-client.ts). It stays a
 * devDependency for tests/unit/git-client.test.ts, which checks that client
 * against it.
 */
const BANNED_FROM_MAIN = [...BANNED_PACKAGES, 'simple-git'];

function readEsbuildExternals(): string[] {
  const buildSource = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'build.js'), 'utf-8');
  const match = buildSource.match(/external:\s*\[([^\]]*)\]/);
  return [...(match?.[1] ?? '').matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

async function bundleMainInputs(devBuild: boolean): Promise<esbuild.Metafile['inputs']> {
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
    entryPoints: [path.join(REPO_ROOT, MAIN_ENTRY)],
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  return result.metafile.inputs;
}

/** `node_modules/@scope/name/x.js` and `node_modules/a/node_modules/name/x.js` both name their innermost package. */
function packageOfInput(input: string): string | null {
  const marker = 'node_modules/';
  const at = input.lastIndexOf(marker);
  if (at === -1) return null;
  const segments = input.slice(at + marker.length).split('/');
  return segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

/** `pkg/sub/path` and `@scope/pkg/sub` name their package. */
function packageOfSpecifier(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

/** Every TypeScript file under `root`, repo-relative with forward slashes. */
function ownSourceFiles(root: string): string[] {
  return fs.readdirSync(path.join(REPO_ROOT, root), { recursive: true, encoding: 'utf-8' })
    .filter((relative) => /\.tsx?$/.test(relative))
    .map((relative) => path.posix.join(root, relative.split(path.sep).join('/')));
}

function isNodeBuiltin(specifier: string): boolean {
  return specifier.startsWith('node:') || builtinModules.includes(specifier);
}

/**
 * The `child_process` exports a source file imports as values. A namespace or
 * default import, a `require` and a dynamic import each reach the whole module,
 * so they read `*`. Type-only imports bundle nothing and are left out.
 */
function childProcessBindings(sourceText: string, fileName = 'file.ts'): string[] {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const bindings = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && CHILD_PROCESS_MODULE.test(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause && !clause.isTypeOnly) {
        if (clause.name) bindings.add('*');
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named)) bindings.add('*');
        if (named && ts.isNamedImports(named)) {
          for (const element of named.elements) {
            if (!element.isTypeOnly) bindings.add((element.propertyName ?? element.name).text);
          }
        }
      }
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamicImport) && ts.isStringLiteral(argument) && CHILD_PROCESS_MODULE.test(argument.text)) {
        bindings.add('*');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...bindings].sort();
}

interface MainGraph {
  /** Our own files that import `child_process`, in either build. */
  ownImporters: Set<string>;
  /** Bundled packages that import `child_process`, in either build. */
  packageImporters: Set<string>;
  /** Externals main's graph reaches, in either build. */
  externals: Set<string>;
  /** Every package bundled into main, in either build. */
  bundledPackages: Set<string>;
  inputCount: number;
}

let graph: MainGraph;

beforeAll(async () => {
  const collected: MainGraph = {
    ownImporters: new Set(),
    packageImporters: new Set(),
    externals: new Set(),
    bundledPackages: new Set(),
    inputCount: 0,
  };
  for (const devBuild of [false, true]) {
    const inputs = await bundleMainInputs(devBuild);
    collected.inputCount = Math.max(collected.inputCount, Object.keys(inputs).length);
    for (const [input, info] of Object.entries(inputs)) {
      const normalized = input.replace(/\\/g, '/');
      const ownerPackage = packageOfInput(normalized);
      if (ownerPackage) collected.bundledPackages.add(ownerPackage);
      for (const imported of info.imports) {
        if (CHILD_PROCESS_MODULE.test(imported.path)) {
          if (ownerPackage) collected.packageImporters.add(ownerPackage);
          else collected.ownImporters.add(normalized);
        } else if (imported.external && !imported.path.startsWith('.') && !isNodeBuiltin(imported.path)) {
          // A relative specifier marked external is a type-only import esbuild never resolved.
          collected.externals.add(packageOfSpecifier(imported.path));
        }
      }
    }
  }
  graph = collected;
}, 120_000);

describe('main starts no process on its own thread', () => {
  it('bundles main the way the build does', () => {
    // Not vacuous: the graph holds main's own code and the drop-in every start goes through.
    expect(graph.inputCount).toBeGreaterThan(500);
    expect(graph.ownImporters.has('src/main/utility-process/off-main-exec.ts')).toBe(true);
    expect(graph.externals.has('electron')).toBe(true);
  });

  it('classifies every file of ours in main that imports child_process', () => {
    const unclassified = [...graph.ownImporters].filter((file) => !(file in CLASSIFIED_STARTS)).sort();
    expect(
      unclassified,
      'A child process started here runs CreateProcess on main\'s thread on Windows. Start it through '
        + 'execFileAsync / execAsync (src/main/utility-process/off-main-exec.ts) or spawnOffMainCli '
        + '(off-main-cli.ts), or classify the file in CLASSIFIED_STARTS with the reason '
        + '(.claude/rules/main-starts-no-process.md).',
    ).toEqual([]);
  });

  it('imports only the child_process exports each classified file is classified for', () => {
    const mismatched: string[] = [];
    for (const [file, classified] of Object.entries(CLASSIFIED_STARTS)) {
      const absolute = path.join(REPO_ROOT, file);
      if (!fs.existsSync(absolute)) continue;
      const actual = childProcessBindings(fs.readFileSync(absolute, 'utf-8'), file);
      const expected = [...classified.bindings].sort();
      if (actual.join(',') !== expected.join(',')) {
        mismatched.push(`${file}: imports [${actual.join(', ')}], classified for [${expected.join(', ')}]`);
      }
    }
    expect(mismatched, 'A classified file imports a different set of child_process exports than its entry lists.').toEqual([]);
  });

  it('keeps every classified entry real, so the list cannot go stale', () => {
    for (const [file, classified] of Object.entries(CLASSIFIED_STARTS)) {
      expect(fs.existsSync(path.join(REPO_ROOT, file)), `${file} no longer exists`).toBe(true);
      expect(graph.ownImporters.has(file), `${file} no longer imports child_process in main's graph: remove its entry`).toBe(true);
      expect(classified.reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
    for (const [packageName, reason] of Object.entries(CLASSIFIED_PACKAGES)) {
      expect(graph.packageImporters.has(packageName), `${packageName} no longer imports child_process in main's graph: remove its entry`).toBe(true);
      expect(reason.length, `${packageName} needs a reason`).toBeGreaterThan(20);
    }
    for (const [packageName, classified] of Object.entries(EXTERNAL_PACKAGES)) {
      expect(graph.externals.has(packageName), `main no longer reaches the external ${packageName}: remove its entry`).toBe(true);
      expect(classified.reason.length, `${packageName} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('classifies every bundled package in main that imports child_process', () => {
    const unclassified = [...graph.packageImporters].filter((packageName) => !(packageName in CLASSIFIED_PACKAGES)).sort();
    expect(
      unclassified,
      'A package bundled into main imports child_process. Read where it starts a process, replace the '
        + 'call with one of ours through a drop-in if main reaches it, or classify the package with what '
        + 'starts and when.',
    ).toEqual([]);
  });

  it('classifies every external main reaches by whether it starts a process', () => {
    const unclassified = [...graph.externals].filter((packageName) => !(packageName in EXTERNAL_PACKAGES)).sort();
    expect(
      unclassified,
      'An external is loaded from node_modules at run time, so this scan cannot see what it imports. '
        + 'Read the package and classify it in EXTERNAL_PACKAGES.',
    ).toEqual([]);
  });

  it('keeps packages that start a process on the calling thread out of main and out of package.json', () => {
    const inGraph = BANNED_FROM_MAIN.filter((packageName) => graph.bundledPackages.has(packageName) || graph.externals.has(packageName));
    expect(inGraph, 'These packages start a process from the thread that calls them.').toEqual([]);
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = { ...manifest.dependencies, ...manifest.devDependencies };
    expect(BANNED_PACKAGES.filter((packageName) => packageName in declared)).toEqual([]);
  });

  it('never turns on the Sentry option that starts PowerShell from main', () => {
    // @sentry/electron's additionalContext starts `powershell Get-CimInstance`
    // (system_profiler on macOS) on the first event, from main, only when
    // deviceModelManufacturer is set. Its default is off.
    const offenders = ownSourceFiles('src/main').filter((file) => /\bdeviceModelManufacturer\b/.test(fs.readFileSync(path.join(REPO_ROOT, file), 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('reads a file\'s child_process imports the way the bundler does', () => {
    // The detector over known source: a scan that stopped matching would pass everything.
    expect(childProcessBindings("import { spawn, type SpawnOptions } from 'node:child_process';")).toEqual(['spawn']);
    expect(childProcessBindings("import { execFile as run, exec } from 'child_process';")).toEqual(['exec', 'execFile']);
    expect(childProcessBindings("import * as childProcess from 'node:child_process';")).toEqual(['*']);
    expect(childProcessBindings("import childProcess from 'child_process';")).toEqual(['*']);
    expect(childProcessBindings("const { execSync } = require('child_process');")).toEqual(['*']);
    expect(childProcessBindings("const loaded = await import('node:child_process');")).toEqual(['*']);
    expect(childProcessBindings("import type { ChildProcess } from 'node:child_process';")).toEqual([]);
    expect(childProcessBindings("import { type ChildProcess } from 'node:child_process';")).toEqual([]);
    expect(childProcessBindings("// import { spawn } from 'node:child_process';\nimport fs from 'node:fs';")).toEqual([]);
  });
});
