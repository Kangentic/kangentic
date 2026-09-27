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
    const respawnIndex = spawnBody.indexOf('spawnElectron(electronArgs, spawnEnv);', restartCheckIndex);
    const returnIndex = spawnBody.indexOf('return;', respawnIndex);
    const cleanupIndex = spawnBody.indexOf('cleanup(code || 0)');
    expect(restartCheckIndex, 'the close handler must check for a restart request').toBeGreaterThan(-1);
    expect(respawnIndex, 'a restart request must spawn Electron again').toBeGreaterThan(restartCheckIndex);
    expect(returnIndex, 'and return, so cleanup() never runs for a restart').toBeGreaterThan(respawnIndex);
    expect(cleanupIndex, 'cleanup() must come after the restart branch').toBeGreaterThan(returnIndex);
  });

  it('launches Electron only through spawnElectron, so every child gets the restart argument and handler', () => {
    const spawnCalls = [...DEV_JS_CODE.matchAll(/spawn\(electronExe/g)];
    expect(spawnCalls.length).toBe(1);
    expect(extractFunctionBody(DEV_JS_CODE, 'spawnElectron')).toContain('spawn(electronExe');
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
