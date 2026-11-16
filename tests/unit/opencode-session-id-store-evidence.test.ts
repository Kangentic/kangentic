/**
 * OpenCode's answer to "does its session database exist", which the session-id
 * report sends as `id_store`. Runs the adapter's real check with os.homedir()
 * pointed at a temp folder, so no test reads or writes the developer's home.
 * A remote or WSL-targeted OpenCode keeps its database elsewhere, so the local
 * file says nothing about it and the answer is `unknown`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode/opencode-adapter';
import { openCodeDbPath } from '../../src/main/agent/adapters/opencode/session-history-parser';

describe('OpenCode session id store evidence', () => {
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-store-evidence-'));
    vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  const storeEvidenceFor = (adapter: OpenCodeAdapter, options: { cwd: string; cliTarget?: never }) => {
    const check = adapter.runtime.sessionId?.storeEvidence;
    if (!check) throw new Error('OpenCode declares no store evidence');
    return check(options);
  };

  it('reads absent when OpenCode has not created its database', async () => {
    await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: fakeHome })).resolves.toBe('absent');
  });

  it('reads present once the database file exists', async () => {
    fs.mkdirSync(path.dirname(openCodeDbPath()), { recursive: true });
    fs.writeFileSync(openCodeDbPath(), '');
    await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: fakeHome })).resolves.toBe('present');
  });

  it('reads absent when the database path is a directory, not a file', async () => {
    fs.mkdirSync(openCodeDbPath(), { recursive: true });
    await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: fakeHome })).resolves.toBe('absent');
  });

  it('answers unknown for a stored CLI target even when the local database exists', async () => {
    fs.mkdirSync(path.dirname(openCodeDbPath()), { recursive: true });
    fs.writeFileSync(openCodeDbPath(), '');
    const cliTarget = { kind: 'wsl', distro: 'Ubuntu' } as never;
    await expect(storeEvidenceFor(new OpenCodeAdapter(), { cwd: fakeHome, cliTarget })).resolves.toBe('unknown');
  });

  it('answers unknown for a cwd registered as remote, and present again for another cwd', async () => {
    fs.mkdirSync(path.dirname(openCodeDbPath()), { recursive: true });
    fs.writeFileSync(openCodeDbPath(), '');
    const adapter = new OpenCodeAdapter();
    const remoteCwd = path.join(fakeHome, 'remote-project');
    const executionTarget = { url: 'http://10.0.0.5:4096', auth: { kind: 'none' }, workingDirectory: '/srv/project' } as never;
    adapter.remoteExecution?.adoptTargets([[remoteCwd, executionTarget]]);
    await expect(storeEvidenceFor(adapter, { cwd: remoteCwd })).resolves.toBe('unknown');
    await expect(storeEvidenceFor(adapter, { cwd: fakeHome })).resolves.toBe('present');
  });
});
