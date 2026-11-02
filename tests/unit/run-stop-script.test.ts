/**
 * The Stop script's runner (src/main/stop-script/run-stop-script.ts) with a real
 * stub script through the real platform shell. Stubs only: a real stack's stop
 * can reach past its own tree, so nothing here runs one.
 *
 * Pinned: the script's working directory, that it gets no task tag even when main
 * carries one, how each failure reads, the bound, a superseding move's abort, and
 * one run per task.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyStopScriptError, isStopScriptRunning, runStopScript } from '../../src/main/stop-script/run-stop-script';
import { TASK_PROCESS_TAG_ENV } from '../../src/main/pty/process-tag/task-process-tag';

const TASK_ID = 'task-run-0001';

let folder: string;
const originalTag = process.env[TASK_PROCESS_TAG_ENV];

function stub(name: string, body: string): string {
  const file = path.join(folder, name);
  fs.writeFileSync(file, body);
  return `node "${file}"`;
}

beforeEach(() => {
  folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kng-stop-script-')));
});

afterEach(() => {
  if (originalTag === undefined) delete process.env[TASK_PROCESS_TAG_ENV];
  else process.env[TASK_PROCESS_TAG_ENV] = originalTag;
  try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* held */ }
});

describe('runStopScript', () => {
  it('runs in the folder it is given', async () => {
    const script = stub('cwd.js', "require('fs').writeFileSync('where.txt', process.cwd());");

    expect(await runStopScript({ taskId: TASK_ID, script, cwd: folder, timeoutMs: 20_000 })).toEqual({ status: 'ok' });

    expect(fs.realpathSync.native(fs.readFileSync(path.join(folder, 'where.txt'), 'utf8'))).toBe(folder);
  }, 30_000);

  it('gives the script no task tag, whatever main carries', async () => {
    process.env[TASK_PROCESS_TAG_ENV] = 'a-parent-task';
    const script = stub('tag.js', `require('fs').writeFileSync('tag.txt', String(process.env.${TASK_PROCESS_TAG_ENV}));`);

    await runStopScript({ taskId: TASK_ID, script, cwd: folder, timeoutMs: 20_000 });

    expect(fs.readFileSync(path.join(folder, 'tag.txt'), 'utf8')).toBe('undefined');
  }, 30_000);

  it('reads a non-zero exit as its code and the last line it printed', async () => {
    const script = stub('fail.js', "console.error('first line'); console.error('the last line'); process.exit(3);");

    expect(await runStopScript({ taskId: TASK_ID, script, cwd: folder, timeoutMs: 20_000 })).toEqual({
      status: 'failed',
      failure: { kind: 'exit-code', exitCode: 3, detail: 'the last line' },
    });
  }, 30_000);

  it('ends a script that runs past its bound and reads it as a timeout', async () => {
    const script = stub('hang.js', 'setTimeout(() => {}, 60000);');

    expect(await runStopScript({ taskId: TASK_ID, script, cwd: folder, timeoutMs: 1_500 })).toEqual({
      status: 'failed',
      failure: { kind: 'timeout', timeoutMs: 1_500 },
    });
    expect(isStopScriptRunning(TASK_ID)).toBe(false);
  }, 30_000);

  it('reads a superseding move\'s abort as no failure of the script', async () => {
    const script = stub('hang-abort.js', 'setTimeout(() => {}, 60000);');
    const controller = new AbortController();

    const run = runStopScript({ taskId: TASK_ID, script, cwd: folder, timeoutMs: 20_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 200);

    expect(await run).toEqual({ status: 'aborted' });
  }, 30_000);

  it('runs one script per task, and a second caller waits for it within its own bound', async () => {
    const script = stub('count.js', "const fs = require('fs'); fs.appendFileSync('runs.txt', 'x'); setTimeout(() => {}, 700);");

    const first = runStopScript({ taskId: TASK_ID, script, cwd: folder, timeoutMs: 20_000 });
    const joined = runStopScript({ taskId: TASK_ID, script, cwd: folder, timeoutMs: 20_000 });
    const outlasted = runStopScript({ taskId: TASK_ID, script, cwd: folder, timeoutMs: 1 });

    expect(isStopScriptRunning(TASK_ID)).toBe(true);
    expect(await outlasted).toEqual({ status: 'aborted' });
    expect(await joined).toEqual(await first);
    expect(fs.readFileSync(path.join(folder, 'runs.txt'), 'utf8')).toBe('x');
  }, 30_000);
});

describe('classifyStopScriptError', () => {
  it('falls back to the raw error for a run that never got that far', () => {
    expect(classifyStopScriptError(new Error('spawn ENOENT'), 1000, undefined)).toEqual({
      status: 'failed',
      failure: { kind: 'error', detail: 'spawn ENOENT' },
    });
  });

  it('caps what reaches a toast', () => {
    const outcome = classifyStopScriptError(new Error(`stop script exited with code 1: ${'x'.repeat(2000)}`), 1000, undefined);

    expect(outcome.status === 'failed' && outcome.failure.kind === 'exit-code' ? outcome.failure.detail.length : 0).toBe(300);
  });
});
