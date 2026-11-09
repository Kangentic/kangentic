import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * scripts/dev.js - the restart channel the Graphics acceleration toggle uses
 * under `npm start`, and the console-signal wait.
 *
 * A static scan, because dev.js writes its PID file and starts a watcher at
 * module load, so it cannot be required into a test. What it pins:
 *
 *   - Electron is told where the restart request goes (`--dev-restart-file=`),
 *     as an argument rather than an env var;
 *   - the 'close' handler honours a restart request BEFORE cleanup(), which
 *     closes Vite and, for an ephemeral preview, deletes .kangentic/ with the
 *     preview's data in it. After cleanup() a restart has nothing to restart
 *     into;
 *   - Ctrl+C and a closed terminal wait for Electron to exit on its own, since
 *     Electron gets the same console event and records a clean exit itself.
 *     Killing it at once raced that write and made the run read as abrupt.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEV_JS = fs.readFileSync(path.join(REPO_ROOT, 'scripts/dev.js'), 'utf-8');

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/** Comment-only lines removed, so prose that names a call cannot satisfy a scan. */
const DEV_JS_CODE = DEV_JS.split('\n').filter((line) => !isCommentLine(line)).join('\n');

function extractFunctionBody(source: string, functionName: string): string {
  const declarationPattern = new RegExp(`function\\s+${functionName}\\s*\\(`, 'g');
  const declarationMatches = [...source.matchAll(declarationPattern)];
  expect(declarationMatches.length, `expected exactly one 'function ${functionName}(' in scripts/dev.js`).toBe(1);
  const openBraceIndex = source.indexOf('{', declarationMatches[0].index);
  let braceDepth = 0;
  for (let sourceIndex = openBraceIndex; sourceIndex < source.length; sourceIndex++) {
    const character = source[sourceIndex];
    if (character === '{') braceDepth += 1;
    else if (character === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return source.slice(openBraceIndex, sourceIndex + 1);
    }
  }
  throw new Error(`unbalanced braces in function '${functionName}'`);
}

describe('scripts/dev.js restart channel', () => {
  it('passes the restart-request path to Electron as an argument', () => {
    const spawnBody = extractFunctionBody(DEV_JS_CODE, 'spawnElectron');
    expect(spawnBody).toContain('`--dev-restart-file=${restartFilePath}`');
    expect(DEV_JS_CODE, 'the channel must not ride an env var').not.toContain('KANGENTIC_DEV_RESTART');
  });

  it('removes a stale restart request at startup, so a crashed instance cannot turn the next first exit into a restart', () => {
    const declarationIndex = DEV_JS_CODE.indexOf('const restartFilePath =');
    expect(declarationIndex).toBeGreaterThan(-1);
    expect(DEV_JS_CODE.indexOf('fs.rmSync(restartFilePath', declarationIndex)).toBeGreaterThan(declarationIndex);
  });

  it("honours a restart request in the 'close' handler before cleanup(), and returns instead of cleaning up", () => {
    const spawnBody = extractFunctionBody(DEV_JS_CODE, 'spawnElectron');
    // `awaitingElectronExit`: a Ctrl+C or closed terminal during a pending
    // restart must stop the dev server, not bring the app back.
    const restartCheckIndex = spawnBody.indexOf('if (!cleaningUp && !awaitingElectronExit && consumeRestartRequest())');
    const respawnIndex = spawnBody.indexOf('restartElectron(electronArgs, spawnEnv);', restartCheckIndex);
    const returnIndex = spawnBody.indexOf('return;', respawnIndex);
    const cleanupIndex = spawnBody.indexOf('cleanup(code || 0)');
    expect(restartCheckIndex, 'the close handler must check for a restart request').toBeGreaterThan(-1);
    expect(respawnIndex, 'a restart request must rebuild and spawn Electron again').toBeGreaterThan(restartCheckIndex);
    expect(returnIndex, 'and return, so cleanup() never runs for a restart').toBeGreaterThan(respawnIndex);
    expect(cleanupIndex, 'cleanup() must come after the restart branch').toBeGreaterThan(returnIndex);
  });

  // Without the rebuild a restart came back on the build `npm start` made at
  // boot, so a merge that changed main or preload stayed out of reach and the
  // renderer kept calling a preload method that did not exist.
  it('rebuilds main, preload and the workers before it launches Electron again, and lets a stop during the rebuild win', () => {
    const restartBody = extractFunctionBody(DEV_JS_CODE, 'restartElectron');
    const rebuildIndex = restartBody.indexOf('await buildMainBundles();');
    const scriptsIndex = restartBody.indexOf('copyExternalScripts(projectDir);');
    const catalogsIndex = restartBody.indexOf('await compileCatalogsForMainInBackground(projectDir);');
    const stopCheckIndex = restartBody.indexOf('if (cleaningUp || awaitingElectronExit)');
    const spawnIndex = restartBody.indexOf('spawnElectron(electronArgs, spawnEnv);');
    expect(rebuildIndex, 'the restart must rebuild the bundles').toBeGreaterThan(-1);
    expect(scriptsIndex, 'and copy the external scripts, as a boot does').toBeGreaterThan(-1);
    expect(catalogsIndex, 'and compile main\'s catalogs, as a boot does').toBeGreaterThan(-1);
    expect(stopCheckIndex, 'a stop that landed during the awaits must be checked after them').toBeGreaterThan(Math.max(rebuildIndex, catalogsIndex));
    expect(spawnIndex, 'Electron starts only after the rebuild and the stop check').toBeGreaterThan(stopCheckIndex);
  });

  it('clears the stale notice only after a rebuild that landed', () => {
    const restartBody = extractFunctionBody(DEV_JS_CODE, 'restartElectron');
    expect(restartBody).toContain('if (rebuilt) mainStaleness.markCurrent();');
    const rebuiltAssignment = restartBody.indexOf('rebuilt = true;');
    expect(rebuiltAssignment, 'rebuilt is set after the build and its hashes, inside the try').toBeGreaterThan(restartBody.indexOf('await buildMainBundles();'));
    expect(rebuiltAssignment).toBeLessThan(restartBody.indexOf('catch (buildError)'));
  });

  it('checks staleness with an in-memory build, never by writing over the bundles a live app loads', () => {
    expect(DEV_JS_CODE).toContain('buildFreshHashes: () => buildMainBundles(false)');
  });

  it('launches Electron only through spawnElectron, so every child gets the restart argument and handler', () => {
    const spawnCalls = [...DEV_JS_CODE.matchAll(/spawn\(electronExe/g)];
    expect(spawnCalls.length).toBe(1);
    expect(extractFunctionBody(DEV_JS_CODE, 'spawnElectron')).toContain('spawn(electronExe');
  });
});

describe('scripts/dev.js main-stale notice wiring', () => {
  const DEV_RESTART_TS = fs.readFileSync(path.join(REPO_ROOT, 'src/renderer/utils/dev-restart.ts'), 'utf-8');

  it('names the two Vite events the same on both sides of the channel', () => {
    for (const eventName of ['kangentic:main-stale', 'kangentic:main-stale-query']) {
      expect(DEV_JS_CODE, `scripts/dev.js must carry '${eventName}'`).toContain(`'${eventName}'`);
      expect(DEV_RESTART_TS, `dev-restart.ts must carry '${eventName}'`).toContain(`'${eventName}'`);
    }
  });

  it('answers the renderer query with the current answer and feeds source changes to the checker', () => {
    const watchBody = extractFunctionBody(DEV_JS_CODE, 'watchMainSources');
    expect(watchBody).toMatch(/ws\.on\(\s*MAIN_STALE_QUERY_EVENT/);
    expect(watchBody).toMatch(/client\.send\(\s*MAIN_STALE_EVENT,[^)]*mainStaleness\.current\(\)/);
    expect(watchBody).toMatch(/fs\.watch\([^)]*\)?[^;]*mainStaleness\.noteSourceChange\(\)/);
  });

  it('hashes the running build only after the external scripts are copied, on a restart and at boot', () => {
    const restartBody = extractFunctionBody(DEV_JS_CODE, 'restartElectron');
    const restartCopyIndex = restartBody.indexOf('copyExternalScripts(projectDir);');
    const restartHashIndex = restartBody.indexOf('runningBundleHashes = hashRunningBuild();');
    expect(restartCopyIndex).toBeGreaterThan(-1);
    expect(restartHashIndex, 'a restart must hash after its copy').toBeGreaterThan(restartCopyIndex);

    const bootCopyLogIndex = DEV_JS_CODE.indexOf("console.log('[dev] Copied external scripts");
    expect(bootCopyLogIndex).toBeGreaterThan(-1);
    const bootCopyCallIndex = DEV_JS_CODE.lastIndexOf('copyExternalScripts(projectDir);', bootCopyLogIndex);
    const bootHashIndex = DEV_JS_CODE.indexOf('runningBundleHashes = hashRunningBuild();', bootCopyLogIndex);
    expect(bootCopyCallIndex, 'the boot copy call sits before its log line').toBeGreaterThan(-1);
    expect(bootHashIndex, 'the boot hash comes after the boot copy').toBeGreaterThan(bootCopyCallIndex);
  });
});

describe('scripts/dev.js console signals', () => {
  it('waits for Electron on SIGINT and SIGHUP, and keeps the immediate cleanup for SIGTERM', () => {
    expect(DEV_JS_CODE).toContain("process.on('SIGINT', () => cleanupOnceElectronExits());");
    expect(DEV_JS_CODE).toContain("process.on('SIGHUP', () => cleanupOnceElectronExits());");
    expect(DEV_JS_CODE).toContain("process.on('SIGTERM', () => cleanup(0));");
  });

  it('bounds the wait, and a second signal skips it', () => {
    const waitBody = extractFunctionBody(DEV_JS_CODE, 'cleanupOnceElectronExits');
    expect(waitBody).toContain('setTimeout(');
    expect(waitBody).toContain('CONSOLE_SIGNAL_ELECTRON_EXIT_WAIT_MS');
    // The early return that cleans up at once: nothing to wait for, or this is
    // the second press.
    expect(waitBody).toContain('if (awaitingElectronExit || !electronProc || electronProc.exitCode !== null)');
  });
});
