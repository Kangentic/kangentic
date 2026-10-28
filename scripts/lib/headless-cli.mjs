/**
 * One call to a headless agent CLI (`claude -p`) for the manual scripts that make
 * real model calls: the eval scripts and the translation harness's Claude engine.
 * Each call runs from an empty temp folder, so no project CLAUDE.md loads, takes
 * its prompt on stdin, and has its whole process tree stopped at a timeout.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

/** A temp folder removal that never throws: on Windows a CLI's leftover child can still hold it. */
export function removeDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left in the temp folder; the OS clears it.
  }
}

/** Stop the CLI and anything it started. On Windows `child.kill()` ends only the CLI. */
export function stopTree(child) {
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

/**
 * One call from an empty temp folder named `<tempPrefix>XXXXXX`, stopped after
 * `timeoutMs`. Never rejects: a CLI that cannot start resolves with code -1.
 */
export function runOnce(cli, argv, stdinText, env, { tempPrefix, timeoutMs }) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), tempPrefix));
    const started = performance.now();
    let child;
    try {
      child = spawn(cli, argv, { cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      removeDirectory(cwd);
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), wallMs: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeDirectory(cwd);
      resolve({ code, stdout, stderr: stderr.slice(-2000), wallMs: performance.now() - started });
    };
    const timer = setTimeout(() => stopTree(child), timeoutMs);
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      settle(-1);
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => settle(code));
    child.stdin.end(stdinText);
  });
}
