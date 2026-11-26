/**
 * The Script import source: a command in the project folder that prints JSON
 * tasks. Fetch maps each item, refusals cover bad JSON, a BOM, a non-zero
 * exit, a timeout, a repeated id, and a remote run that goes to the host
 * instead of this computer. The local start uses resolveScriptInvocation
 * (POSIX `-c`, cmd `/c`, PowerShell `-Command`), never `shell: true`.
 */
import { describe, it, expect, vi } from 'vitest';
import { ImportScriptAdapter } from '../../src/main/boards/adapters/import-script';
import { parseScriptOutput } from '../../src/main/boards/adapters/import-script/parse-output';
import type { ImportScriptRunner, ImportScriptRunResult } from '../../src/main/boards/adapters/import-script/runner';
import { RefusalError } from '../../src/shared/refusal';
import type { ImportFetchInput } from '../../src/shared/types';

const PROJECT_PATH = '/mock/project';
const SCRIPT = 'node scripts/list-changes.js';

function fetchInput(repository = SCRIPT): ImportFetchInput {
  return { source: 'script', repository, page: 1, perPage: 100, state: 'all' };
}

function okResult(stdout: string): ImportScriptRunResult {
  return { code: 0, stdout, timedOut: false };
}

function makeRunner(overrides: Partial<ImportScriptRunner> = {}): ImportScriptRunner {
  return {
    getShell: vi.fn(async () => '/bin/zsh'),
    isRemote: vi.fn(() => false),
    runLocal: vi.fn(async () => okResult('[]')),
    runOnHost: vi.fn(async () => okResult('[]')),
    ...overrides,
  };
}

const noneImported = () => new Set<string>();
const project = { path: PROJECT_PATH, baseBranch: 'main' };

describe('parseScriptOutput', () => {
  it('maps a JSON array of id, title and body', () => {
    expect(parseScriptOutput('[{"id":"add-login","title":"Add login","body":"Why."}]')).toEqual([
      { id: 'add-login', title: 'Add login', body: 'Why.' },
    ]);
  });

  it('treats a missing body as empty', () => {
    expect(parseScriptOutput('[{"id":"a","title":"A"}]')).toEqual([{ id: 'a', title: 'A', body: '' }]);
  });

  it('strips a UTF-8 BOM', () => {
    expect(parseScriptOutput('\uFEFF[{"id":"a","title":"A","body":""}]')).toEqual([
      { id: 'a', title: 'A', body: '' },
    ]);
  });

  it('refuses non-JSON', () => {
    expect(() => parseScriptOutput('not json')).toThrow(RefusalError);
  });

  it('refuses a non-array', () => {
    expect(() => parseScriptOutput('{"id":"a","title":"A"}')).toThrow(RefusalError);
  });

  it('refuses a repeated id', () => {
    expect(() => parseScriptOutput('[{"id":"a","title":"One"},{"id":"a","title":"Two"}]')).toThrow(/twice/);
  });

  it('refuses a missing title', () => {
    expect(() => parseScriptOutput('[{"id":"a"}]')).toThrow(/title/);
  });
});

describe('ImportScriptAdapter', () => {
  it('maps a successful local run to ExternalIssue rows', async () => {
    const runner = makeRunner({
      runLocal: vi.fn(async () => okResult('[{"id":"add-login","title":"Add login","body":"Why."}]')),
    });
    const adapter = new ImportScriptAdapter(runner);
    const result = await adapter.fetch(fetchInput(), noneImported, project);

    expect(result.hasNextPage).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      externalId: 'add-login',
      externalSource: 'script',
      title: 'Add login',
      body: 'Why.',
      stateCategory: 'open',
      labels: [],
      alreadyImported: false,
    });
    expect(runner.runOnHost).not.toHaveBeenCalled();
  });

  it('marks items already imported', async () => {
    const runner = makeRunner({
      runLocal: vi.fn(async () => okResult('[{"id":"add-login","title":"Add login"}]')),
    });
    const adapter = new ImportScriptAdapter(runner);
    const result = await adapter.fetch(fetchInput(), () => new Set(['add-login']), project);
    expect(result.issues[0]?.alreadyImported).toBe(true);
  });

  it('returns nothing on page 2', async () => {
    const runner = makeRunner();
    const adapter = new ImportScriptAdapter(runner);
    const result = await adapter.fetch({ ...fetchInput(), page: 2 }, noneImported, project);
    expect(result).toEqual({ issues: [], totalCount: 0, hasNextPage: false });
    expect(runner.runLocal).not.toHaveBeenCalled();
  });

  it('runs a POSIX shell as -c, not shell: true', async () => {
    const runner = makeRunner({ getShell: vi.fn(async () => '/bin/zsh') });
    const adapter = new ImportScriptAdapter(runner);
    await adapter.fetch(fetchInput(), noneImported, project);
    expect(runner.runLocal).toHaveBeenCalledWith(expect.objectContaining({
      exe: '/bin/zsh',
      args: ['-c', SCRIPT],
      cwd: PROJECT_PATH,
    }));
  });

  it('runs cmd as /c', async () => {
    const runner = makeRunner({ getShell: vi.fn(async () => 'cmd.exe') });
    const adapter = new ImportScriptAdapter(runner);
    await adapter.fetch(fetchInput(), noneImported, project);
    const invocation = vi.mocked(runner.runLocal).mock.calls[0]?.[0];
    expect(invocation?.exe).toBe('cmd.exe');
    expect(invocation?.args).toContain('/c');
    expect(invocation?.args).toContain(SCRIPT);
  });

  it('runs PowerShell as -Command', async () => {
    const runner = makeRunner({ getShell: vi.fn(async () => 'powershell.exe') });
    const adapter = new ImportScriptAdapter(runner);
    await adapter.fetch(fetchInput(), noneImported, project);
    const invocation = vi.mocked(runner.runLocal).mock.calls[0]?.[0];
    expect(invocation?.exe).toBe('powershell.exe');
    expect(invocation?.args).toContain('-Command');
  });

  it('hands a remote project to the host, not this computer', async () => {
    const runner = makeRunner({
      isRemote: vi.fn(() => true),
      runOnHost: vi.fn(async () => okResult('[{"id":"a","title":"A"}]')),
    });
    const adapter = new ImportScriptAdapter(runner);
    const result = await adapter.fetch(fetchInput(), noneImported, project);
    expect(result.issues[0]?.externalId).toBe('a');
    expect(runner.runOnHost).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: PROJECT_PATH,
      script: SCRIPT,
    }));
    expect(runner.runLocal).not.toHaveBeenCalled();
  });

  it('refuses a non-zero exit', async () => {
    const runner = makeRunner({
      runLocal: vi.fn(async () => ({ code: 7, stdout: '', timedOut: false })),
    });
    const adapter = new ImportScriptAdapter(runner);
    await expect(adapter.fetch(fetchInput(), noneImported, project)).rejects.toThrow(/code 7/);
  });

  it('refuses a timeout', async () => {
    const runner = makeRunner({
      runLocal: vi.fn(async () => ({ code: null, stdout: '', timedOut: true })),
    });
    const adapter = new ImportScriptAdapter(runner);
    await expect(adapter.fetch(fetchInput(), noneImported, project)).rejects.toThrow(/15 s/);
  });

  it('refuses bad JSON from a successful run', async () => {
    const runner = makeRunner({
      runLocal: vi.fn(async () => okResult('oops')),
    });
    const adapter = new ImportScriptAdapter(runner);
    await expect(adapter.fetch(fetchInput(), noneImported, project)).rejects.toThrow(/JSON array/);
  });

  it('prepareSource refuses a blank script and does not run it', async () => {
    const runner = makeRunner();
    const adapter = new ImportScriptAdapter(runner);
    await expect(adapter.prepareSource('  ')).rejects.toThrow(/No script/);
    expect(runner.runLocal).not.toHaveBeenCalled();
  });

  it('prepareSource keeps the script as the repository', async () => {
    const adapter = new ImportScriptAdapter(makeRunner());
    await expect(adapter.prepareSource(`  ${SCRIPT}  `)).resolves.toEqual({
      label: SCRIPT,
      repository: SCRIPT,
    });
  });
});
