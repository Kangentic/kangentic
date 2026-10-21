/**
 * scripts/preview-isolation.js and its two callers: the GIT_CEILING_DIRECTORIES
 * value scripts/dev.js gives a preview's Electron process, and the launcher's
 * one-preview-per-worktree rule. Background is in that module's header: a
 * relaunch that overlapped the previous preview's exit cleanup ended with a
 * `reset --hard` on the worktree the preview runs from.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

import { previewProjectsRoot } from '../../src/devtools/main/ephemeral-projects';
import {
  PREVIEW_STOP_FOR_WORKTREE_REMOVAL,
  previewPidFilePath,
  stopWorktreePreviews,
} from '../../src/devtools/main/worktree-preview-stop';

// CJS scripts (run by node directly, not bundled), loaded the way the other script tests do.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const isolation = require('../../scripts/preview-isolation.js') as {
  previewGitCeilingDirectories: (ephemeralDataDir: string, existingValue?: string) => string;
  findOtherPreviewInstances: (worktreeDir: string) => Array<{ port: number; pid: number; shuttingDown: boolean }>;
  stoppingMarkerPathFor: (worktreeDir: string, port: number) => string;
  moveIntoTrash: (sourcePaths: string[], trashDir: string) => string[];
  listTrashDirs: (kangenticDir: string) => string[];
  spawnTrashDeleter: (trashDir: string) => void;
  isWorktreeRemovalStop: (stopFilePath: string) => boolean;
};
const {
  previewGitCeilingDirectories,
  findOtherPreviewInstances,
  stoppingMarkerPathFor,
  moveIntoTrash,
  listTrashDirs,
  spawnTrashDeleter,
  isWorktreeRemovalStop,
} = isolation;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isPreviewTrashDir, deletePreviewTrash } = require('../../scripts/preview-trash-delete.js') as {
  isPreviewTrashDir: (candidate: string) => boolean;
  deletePreviewTrash: (trashDir: string) => void;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { waitForOtherPreviews, stopFilePathFor } = require('../../scripts/worktree-preview.js') as {
  waitForOtherPreviews: (worktreeDir: string) => Promise<void>;
  stopFilePathFor: (worktreeDir: string, port: number) => string;
};

const REPO_ROOT = path.resolve(__dirname, '../..');

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf-8', env: { ...process.env, ...env } }).trim();
}

function startIdleProcess(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('exit', () => resolve());
  });
}

describe('previewGitCeilingDirectories', () => {
  let tempDir: string;

  beforeEach(() => {
    // Canonical, because git reports real paths: macOS's tmpdir is a symlink into
    // /private, and a Windows tmpdir can be an 8.3 short name.
    tempDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'preview-ceiling-')));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('is the preview-projects folder ephemeral-projects.ts clones into', () => {
    const dataDir = path.join(tempDir, '.kangentic', 'data');
    const previousDataDir = process.env.KANGENTIC_DATA_DIR;
    process.env.KANGENTIC_DATA_DIR = dataDir;
    try {
      expect(previewGitCeilingDirectories(dataDir)).toBe(previewProjectsRoot());
    } finally {
      if (previousDataDir === undefined) delete process.env.KANGENTIC_DATA_DIR;
      else process.env.KANGENTIC_DATA_DIR = previousDataDir;
    }
  });

  it('keeps a ceiling the developer already set', () => {
    const dataDir = path.join(tempDir, 'data');
    expect(previewGitCeilingDirectories(dataDir, path.join(tempDir, 'mine')))
      .toBe([path.join(tempDir, 'mine'), path.join(dataDir, 'preview-projects')].join(path.delimiter));
  });

  it('stops git inside a preview project from reaching the worktree, and nothing else', () => {
    const worktree = path.join(tempDir, 'worktree');
    fs.mkdirSync(worktree);
    git(worktree, ['init', '-b', 'main']);
    git(worktree, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '--allow-empty', '-m', 'init']);
    const dataDir = path.join(worktree, '.kangentic', 'data');
    const emptyProject = path.join(dataDir, 'preview-projects', 'project-1');
    fs.mkdirSync(path.join(emptyProject, 'src'), { recursive: true });
    const realClone = path.join(dataDir, 'preview-projects', 'project-2');
    git(tempDir, ['clone', '--local', worktree, realClone]);
    const env = { GIT_CEILING_DIRECTORIES: previewGitCeilingDirectories(dataDir) };

    // Control: without the ceiling, git from the empty project lands on the worktree.
    expect(path.resolve(git(emptyProject, ['rev-parse', '--show-toplevel']))).toBe(path.resolve(worktree));
    expect(() => git(emptyProject, ['rev-parse', '--show-toplevel'], env)).toThrow();
    expect(() => git(path.join(emptyProject, 'src'), ['rev-parse', '--show-toplevel'], env)).toThrow();
    expect(path.resolve(git(realClone, ['rev-parse', '--show-toplevel'], env))).toBe(path.resolve(realClone));
    expect(path.resolve(git(worktree, ['rev-parse', '--show-toplevel'], env))).toBe(path.resolve(worktree));
  });
});

describe('findOtherPreviewInstances and the launcher\'s one-preview rule', () => {
  let worktreeDir: string;
  let idleProcess: ChildProcess | null = null;
  const port = 5199;

  beforeEach(() => {
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-instances-'));
    fs.mkdirSync(path.join(worktreeDir, '.kangentic'));
  });

  afterEach(async () => {
    if (idleProcess) {
      idleProcess.kill();
      await waitForExit(idleProcess);
      idleProcess = null;
    }
    await fs.promises.rm(worktreeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function writePidFile(pid: number): void {
    fs.writeFileSync(path.join(worktreeDir, '.kangentic', `preview-${port}.pid`), String(pid));
  }

  it('finds nothing when the worktree has no .kangentic folder', () => {
    fs.rmSync(path.join(worktreeDir, '.kangentic'), { recursive: true, force: true });
    expect(findOtherPreviewInstances(worktreeDir)).toEqual([]);
  });

  it('reports a live preview with no stop request or stopping marker as running', () => {
    idleProcess = startIdleProcess();
    writePidFile(idleProcess.pid!);
    expect(findOtherPreviewInstances(worktreeDir)).toEqual([{ port, pid: idleProcess.pid, shuttingDown: false }]);
  });

  it('reports a live preview with a stopping marker as shutting down', () => {
    // dev.js writes the marker the moment a closed terminal or window, or a stop, reaches it.
    idleProcess = startIdleProcess();
    writePidFile(idleProcess.pid!);
    fs.writeFileSync(stoppingMarkerPathFor(worktreeDir, port), String(idleProcess.pid));
    expect(findOtherPreviewInstances(worktreeDir)).toEqual([{ port, pid: idleProcess.pid, shuttingDown: true }]);
  });

  it('reports a live preview with a pending stop request as shutting down', () => {
    // The window between `--stop` and the cleanup's exit record, while Electron quits.
    idleProcess = startIdleProcess();
    writePidFile(idleProcess.pid!);
    fs.writeFileSync(path.join(worktreeDir, '.kangentic', `preview-${port}.stop`), String(Date.now()));
    expect(findOtherPreviewInstances(worktreeDir)).toEqual([{ port, pid: idleProcess.pid, shuttingDown: true }]);
  });

  it('skips a PID file whose process is gone', async () => {
    const exited = startIdleProcess();
    const exitedPid = exited.pid!;
    exited.kill();
    await waitForExit(exited);
    writePidFile(exitedPid);
    expect(findOtherPreviewInstances(worktreeDir)).toEqual([]);
  });

  it('refuses to launch beside a running preview of the same worktree', async () => {
    idleProcess = startIdleProcess();
    writePidFile(idleProcess.pid!);
    await expect(waitForOtherPreviews(worktreeDir)).rejects.toThrow(/already running on port 5199/);
  });

  it('waits for a preview that is shutting down, then lets the launch go ahead', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    idleProcess = startIdleProcess();
    const outgoing = idleProcess;
    writePidFile(outgoing.pid!);
    fs.writeFileSync(stoppingMarkerPathFor(worktreeDir, port), String(outgoing.pid));
    let settled = false;
    const waiting = waitForOtherPreviews(worktreeDir).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(settled).toBe(false);
    outgoing.kill();
    await waitForExit(outgoing);
    await waiting;
    expect(settled).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('fast exit: move into trash, delete in the background', () => {
  let worktreeDir: string;
  let kangenticDir: string;

  beforeEach(() => {
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-trash-'));
    kangenticDir = path.join(worktreeDir, '.kangentic');
    fs.mkdirSync(path.join(kangenticDir, 'data', 'preview-projects', 'project-1'), { recursive: true });
    fs.writeFileSync(path.join(kangenticDir, 'data', 'preview-projects', 'project-1', 'file.txt'), 'x');
    fs.writeFileSync(path.join(kangenticDir, 'preview.lock'), '{}');
  });

  afterEach(async () => {
    await fs.promises.rm(worktreeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('moves entries into the trash folder and reports none left behind', () => {
    const trashDir = path.join(kangenticDir, 'trash-123-1');
    const leftBehind = moveIntoTrash([path.join(kangenticDir, 'data'), path.join(kangenticDir, 'preview.lock'), path.join(kangenticDir, 'missing')], trashDir);

    expect(leftBehind).toEqual([]);
    expect(fs.existsSync(path.join(kangenticDir, 'data'))).toBe(false);
    expect(fs.existsSync(path.join(trashDir, 'data', 'preview-projects', 'project-1', 'file.txt'))).toBe(true);
    expect(fs.existsSync(path.join(trashDir, 'preview.lock'))).toBe(true);
    expect(listTrashDirs(kangenticDir)).toEqual([trashDir]);
  });

  it('the deleter removes the trash, then .kangentic/ only when nothing else is in it', () => {
    const trashDir = path.join(kangenticDir, 'trash-123-1');
    moveIntoTrash([path.join(kangenticDir, 'data'), path.join(kangenticDir, 'preview.lock')], trashDir);
    fs.writeFileSync(path.join(kangenticDir, 'preview-5174.pid'), '1');

    deletePreviewTrash(trashDir);
    expect(fs.existsSync(trashDir)).toBe(false);
    // A preview that started meanwhile owns .kangentic/: left alone.
    expect(fs.existsSync(path.join(kangenticDir, 'preview-5174.pid'))).toBe(true);

    fs.rmSync(path.join(kangenticDir, 'preview-5174.pid'));
    const secondTrash = path.join(kangenticDir, 'trash-123-2');
    fs.mkdirSync(secondTrash);
    deletePreviewTrash(secondTrash);
    expect(fs.existsSync(kangenticDir)).toBe(false);
  });

  it('the deleter refuses anything that is not a .kangentic/trash-* folder', () => {
    expect(isPreviewTrashDir(path.join(kangenticDir, 'trash-1-2'))).toBe(true);
    expect(isPreviewTrashDir(path.join(kangenticDir, 'data'))).toBe(false);
    expect(isPreviewTrashDir(path.join(worktreeDir, 'trash-1-2'))).toBe(false);
    expect(() => deletePreviewTrash(path.join(kangenticDir, 'data'))).toThrow(/Refusing/);
    expect(fs.existsSync(path.join(kangenticDir, 'data', 'preview-projects', 'project-1', 'file.txt'))).toBe(true);
  });

  it('the detached deleter finishes the job after its parent has moved on', async () => {
    const trashDir = path.join(kangenticDir, 'trash-123-3');
    moveIntoTrash([path.join(kangenticDir, 'data'), path.join(kangenticDir, 'preview.lock')], trashDir);
    spawnTrashDeleter(trashDir);
    await expect.poll(() => fs.existsSync(kangenticDir), { timeout: 15000, interval: 100 }).toBe(false);
  });
});

/**
 * dev.js reads its stop file through `isWorktreeRemovalStop` to decide whether the worktree is
 * removed next (skip the ephemeral cleanup) or the preview is merely stopping (keep it). The
 * payloads here are the two real writers': the launcher's `--stop` and the task reap's.
 */
describe('isWorktreeRemovalStop: what dev.js reads from a stop file', () => {
  const port = 5198;
  let worktreeDir: string;
  let stopFilePath: string;
  let idleProcess: ChildProcess | null = null;

  beforeEach(() => {
    worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-stop-reason-'));
    fs.mkdirSync(path.join(worktreeDir, '.kangentic'));
    // The path the launcher's --stop and dev.js's watcher both use.
    stopFilePath = stopFilePathFor(worktreeDir, port);
  });

  afterEach(async () => {
    if (idleProcess) {
      idleProcess.kill();
      await waitForExit(idleProcess);
      idleProcess = null;
    }
    await fs.promises.rm(worktreeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('reads false for the launcher\'s --stop payload, a timestamp, so dev.js keeps its cleanup', () => {
    // scripts/worktree-preview.js writes String(Date.now()) inline in stopPreview, which it does
    // not export (calling it would need a live pid and waits up to 45 s), so this writes the same payload.
    fs.writeFileSync(stopFilePath, String(Date.now()));

    expect(isWorktreeRemovalStop(stopFilePath)).toBe(false);
  });

  it('reads true for the reap\'s payload, so dev.js skips its cleanup', () => {
    fs.writeFileSync(stopFilePath, PREVIEW_STOP_FOR_WORKTREE_REMOVAL);

    expect(isWorktreeRemovalStop(stopFilePath)).toBe(true);
  });

  it('reads true for the file the reap\'s own writer leaves behind', async () => {
    // A live process that never answers, so the stop gives up unacknowledged and leaves the file it wrote.
    idleProcess = startIdleProcess();
    fs.writeFileSync(previewPidFilePath(worktreeDir, port), String(idleProcess.pid));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const results = await stopWorktreePreviews([worktreeDir], { acknowledgeMs: 300, boundMs: 3000 });

      // Positive control: the stop ran against this preview and wrote the file.
      expect(results).toEqual([expect.objectContaining({ port, pid: idleProcess.pid, outcome: 'unacknowledged' })]);
      expect(fs.existsSync(stopFilePath)).toBe(true);
      expect(isWorktreeRemovalStop(stopFilePath)).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('reads true when the reason is followed by a newline', () => {
    fs.writeFileSync(stopFilePath, `${PREVIEW_STOP_FOR_WORKTREE_REMOVAL}\n`);

    expect(isWorktreeRemovalStop(stopFilePath)).toBe(true);
  });

  it('reads false for an empty file', () => {
    fs.writeFileSync(stopFilePath, '');

    expect(isWorktreeRemovalStop(stopFilePath)).toBe(false);
  });

  it('reads false for a file that does not exist', () => {
    expect(fs.existsSync(stopFilePath)).toBe(false);

    expect(isWorktreeRemovalStop(stopFilePath)).toBe(false);
  });
});

describe('scripts/dev.js wiring', () => {
  const devJs = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'dev.js'), 'utf-8');

  function functionBody(functionName: string): string {
    const start = devJs.indexOf(`function ${functionName}(`);
    expect(start, `scripts/dev.js declares function ${functionName}()`).toBeGreaterThan(-1);
    const open = devJs.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < devJs.length; index += 1) {
      if (devJs[index] === '{') depth += 1;
      else if (devJs[index] === '}') {
        depth -= 1;
        if (depth === 0) {
          return devJs.slice(open, index + 1)
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
        }
      }
    }
    throw new Error(`unbalanced braces in ${functionName}()`);
  }

  function cleanupBody(): string {
    return functionBody('cleanup');
  }

  it('gives the ephemeral Electron process the preview git ceiling, keeping an inherited one', () => {
    expect(devJs).toContain('GIT_CEILING_DIRECTORIES: previewGitCeilingDirectories(ephemeralDataDir, process.env.GIT_CEILING_DIRECTORIES)');
  });

  it('marks itself stopping on every way a preview ends', () => {
    const body = cleanupBody();
    expect(body.indexOf('markStopping()')).toBeGreaterThan(-1);
    expect(body.indexOf('markStopping()')).toBeLessThan(body.indexOf('electronProc.kill()'));
    const signalPath = devJs.slice(devJs.indexOf('function cleanupOnceElectronExits('));
    expect(signalPath.slice(0, signalPath.indexOf('}\n')).trim()).toMatch(/\{\s*markStopping\(\);/);
    const stopWatcher = devJs.slice(devJs.indexOf('const stopWatcher = setInterval('), devJs.indexOf('stopWatcher.unref()'));
    expect(stopWatcher).toContain('markStopping()');
  });

  it('moves .kangentic/ and .vite/ into trash instead of deleting the clones in place', () => {
    const body = cleanupBody();
    expect(body).toContain('moveIntoTrash([...kangenticEntries, viteDir], trashDir)');
    // The PID file and marker stay out of the move, and so does trash an earlier deleter owns.
    // So does the worktree's own Vite dependency cache: a relaunch then starts warm
    // instead of bundling every dependency again (2.8 GB of commit cold, 0.5 GB warm).
    expect(body).toContain('new Set([path.basename(pidFilePath), path.basename(stoppingMarkerPath), path.basename(worktreeViteCacheDir(projectDir))])');
    expect(body).toContain("!entryName.startsWith('trash-')");
  });

  it('removes the PID file and marker last, then hands the trash to the deleter', () => {
    const body = cleanupBody();
    const moved = body.indexOf('moveIntoTrash(');
    const pidRemoved = body.lastIndexOf('fs.rmSync(pidFilePath');
    const markerRemoved = body.lastIndexOf('fs.rmSync(stoppingMarkerPath');
    const deleterStarted = body.indexOf('spawnTrashDeleter(trashDir)');
    expect(moved).toBeGreaterThan(-1);
    expect(pidRemoved).toBeGreaterThan(moved);
    expect(markerRemoved).toBeGreaterThan(moved);
    expect(deleterStarted).toBeGreaterThan(pidRemoved);
  });

  it('sweeps leftover trash at boot through the deleter', () => {
    expect(devJs).toMatch(/for \(const leftoverTrashDir of listTrashDirs\(path\.dirname\(ephemeralDataDir\)\)\) \{\s*spawnTrashDeleter\(leftoverTrashDir\);/);
  });

  it('ends a dependency pre-bundle that is still running, before it clears the worktree', () => {
    // A stop that lands during the pre-bundle would otherwise exit dev.js and leave the child
    // bundling into the worktree, with the cleanup below moving .kangentic/ and .vite/ around it.
    const body = cleanupBody();
    const killedAt = body.search(/if \(prebundleProc\) \{\s*prebundleProc\.kill\(\);/);
    const movedAt = body.indexOf('moveIntoTrash(');
    expect(killedAt, 'cleanup() kills the pre-bundle child').toBeGreaterThan(-1);
    expect(movedAt, 'cleanup() moves the ephemeral tree into trash').toBeGreaterThan(-1);
    expect(killedAt).toBeLessThan(movedAt);
    // At the top level of cleanup(), not inside the ephemeral branch: a worktree-removal stop and a
    // plain `npm start` both skip that branch and would exit with the child still bundling.
    const textBeforeKill = body.slice(0, killedAt);
    const openBlocks = textBeforeKill.split('{').length - textBeforeKill.split('}').length;
    expect(openBlocks, 'only the function body is open at the kill').toBe(1);
  });

  it('keeps the pre-bundle child in the module-level variable cleanup() reads, and clears it when the child ends', () => {
    expect(devJs).toMatch(/^let prebundleProc = null;/m);
    const body = functionBody('runDependencyPrebundle');
    // A local of the same name would shadow the variable, and cleanup() would find null.
    expect(body).not.toMatch(/\b(?:const|let|var) prebundleProc\b/);
    const spawned = /const (\w+) = spawn\(/.exec(body);
    expect(spawned, 'runDependencyPrebundle() keeps the spawned child in a local').not.toBeNull();
    expect(body).toContain(`prebundleProc = ${spawned?.[1]};`);
    // Cleared on close and on a failed start, so cleanup() never kills a child that is already gone.
    expect(body).toMatch(/\.on\('close',[\s\S]*?prebundleProc = null;[\s\S]*?\.on\('error',[\s\S]*?prebundleProc = null;/);
  });
});
