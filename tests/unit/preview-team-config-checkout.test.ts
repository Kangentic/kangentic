import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// ephemeral-projects.ts pulls in electron's ipcMain and the project DB at import time;
// neither is exercised by checkoutTeamConfig, so stub them so the module loads under vitest.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

import { checkoutTeamConfig } from '../../src/devtools/main/ephemeral-projects';

const execFileAsync = promisify(execFile);

async function initRepo(repoDir: string): Promise<void> {
  fs.mkdirSync(repoDir, { recursive: true });
  await execFileAsync('git', ['-C', repoDir, 'init']);
  await execFileAsync('git', ['-C', repoDir, 'config', 'user.email', 'dev@example.com']);
  await execFileAsync('git', ['-C', repoDir, 'config', 'user.name', 'Dev']);
}

// Regression guard for the preview ghost-column race: the committed team board config must be
// on disk in the clone BEFORE the DB is seeded and the board opens. Without the eager checkout
// the default-seed columns (random uuids) exist before kangentic.json lands, and the deferred
// fillPreviewClone applies the config too late, ghosting the config-id columns. See the module
// doc on checkoutTeamConfig.
describe('checkoutTeamConfig (preview team-config eager checkout)', () => {
  let tempDir: string;
  let sourceRepo: string;
  let cloneDir: string;
  const config = { version: 1, columns: [{ id: 'e6350e8a', name: 'To Do', role: 'todo' }] };

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-config-checkout-'));
    sourceRepo = path.join(tempDir, 'source');
    cloneDir = path.join(tempDir, 'clone');
    await initRepo(sourceRepo);
    fs.writeFileSync(path.join(sourceRepo, 'kangentic.json'), JSON.stringify(config, null, 2));
    // A second tracked file mirrors a real tree, so we can assert the rest stays deferred.
    fs.writeFileSync(path.join(sourceRepo, 'README.md'), '# sample\n');
    await execFileAsync('git', ['-C', sourceRepo, 'add', '.']);
    await execFileAsync('git', ['-C', sourceRepo, 'commit', '-m', 'init']);
    await execFileAsync('git', ['clone', '--no-checkout', '--local', sourceRepo, cloneDir]);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('the --no-checkout clone has no working-tree kangentic.json (race precondition)', () => {
    expect(fs.existsSync(path.join(cloneDir, 'kangentic.json'))).toBe(false);
  });

  it('checks out the committed kangentic.json into the clone, leaving the rest of the tree deferred', async () => {
    await checkoutTeamConfig(cloneDir);

    const checkedOut = path.join(cloneDir, 'kangentic.json');
    expect(fs.existsSync(checkedOut)).toBe(true);
    // Parse rather than byte-compare so git CRLF normalization can't make this flaky cross-platform.
    expect(JSON.parse(fs.readFileSync(checkedOut, 'utf-8'))).toEqual(config);
    // The slow full-tree checkout stays deferred to fillPreviewClone.
    expect(fs.existsSync(path.join(cloneDir, 'README.md'))).toBe(false);
  });

  it('is best-effort: a repo with no committed kangentic.json resolves without throwing', async () => {
    const otherSource = path.join(tempDir, 'other-source');
    const otherClone = path.join(tempDir, 'other-clone');
    await initRepo(otherSource);
    fs.writeFileSync(path.join(otherSource, 'README.md'), '# other\n');
    await execFileAsync('git', ['-C', otherSource, 'add', '.']);
    await execFileAsync('git', ['-C', otherSource, 'commit', '-m', 'init']);
    await execFileAsync('git', ['clone', '--no-checkout', '--local', otherSource, otherClone]);

    await expect(checkoutTeamConfig(otherClone)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(otherClone, 'kangentic.json'))).toBe(false);
  });
});
