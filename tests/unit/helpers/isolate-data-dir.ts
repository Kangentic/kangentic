/**
 * Every test file gets its own throwaway Kangentic data directory.
 *
 * `PATHS.configDir` (src/main/config/paths.ts) falls back to the real
 * per-user directory (`%APPDATA%/kangentic`, `~/.config/kangentic`) when
 * KANGENTIC_DATA_DIR is unset, and `getGlobalDb()` opens `index.db` there and
 * runs the global migrations on it. Many suites reach `getGlobalDb()` without
 * mocking it: touching a task reads the dev-port ledger, which lives in the
 * global database.
 *
 * That used to be harmless by accident. better-sqlite3 was built for
 * Electron's ABI, so under vitest's plain Node the open threw and the ledger
 * degraded. better-sqlite3 13 is a Node-API module that loads here, so without
 * this file those suites would open the developer's real global database and
 * migrate it to whatever schema the branch under test carries.
 *
 * Per FILE, not per run: test files run in parallel processes, and two of them
 * migrating one shared `index.db` at once can race on a column add. A test that
 * sets KANGENTIC_DATA_DIR itself still wins, since it overwrites this value
 * before importing anything that reads it.
 *
 * The model cache deliberately ignores KANGENTIC_DATA_DIR (`PATHS.modelCacheDir`
 * resolves from `getPlatformConfigDir()`, so a preview shares the real weights),
 * and `ensureDirs()` creates it on every global-database open. So the platform
 * config base is redirected too: `APPDATA` on Windows, `XDG_CONFIG_HOME` on
 * Linux, the two variables `getPlatformConfigDir()` reads. macOS derives it from
 * the home directory, which is too broad to redirect for every suite, so there a
 * suite that reaches `ensureDirs()` still creates the real (normally existing)
 * models folder. Every suite that touches model files mocks the model modules.
 *
 * The directory sits under the run's parent from unit-data-root.ts, whose
 * teardown removes whatever a locked file kept this `afterAll` from removing.
 *
 * Registered in vitest.config.ts `test.setupFiles`.
 */
import { afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const parent = process.env.KANGENTIC_UNIT_DATA_ROOT ?? os.tmpdir();
const dataDir = fs.mkdtempSync(path.join(parent, 'file-'));
process.env.KANGENTIC_DATA_DIR = path.join(dataDir, 'data');
fs.mkdirSync(process.env.KANGENTIC_DATA_DIR);
process.env.APPDATA = path.join(dataDir, 'platform-config');
process.env.XDG_CONFIG_HOME = path.join(dataDir, 'platform-config');

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Best effort. On Windows a database handle the suite left open locks the
    // file until the worker exits; unit-data-root.ts removes it after the run.
  }
});
