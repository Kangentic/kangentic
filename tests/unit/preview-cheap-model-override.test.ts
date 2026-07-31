import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ephemeral-projects.ts pulls in electron's ipcMain and the project DB at import time;
// neither is exercised by forcePreviewCheapModels, so stub them so the module loads
// under vitest. Mirrors preview-team-config-checkout.test.ts, the other unit-test
// consumer of this module.
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));

import { forcePreviewCheapModels } from '../../src/devtools/main/ephemeral-projects';

interface EmittedPreviewColumn {
  id: string;
  modelOverride: string;
  effortOverride: string;
  permissionMode?: string;
}

interface EmittedPreviewLocalConfig {
  version: number;
  columns: EmittedPreviewColumn[];
}

// Points every preview column at the cheap tier by writing kangentic.local.json.
// See the JSDoc above forcePreviewCheapModels in ephemeral-projects.ts for the
// full rationale (a preview must never bill the developer's real agent tier).
describe('forcePreviewCheapModels (preview cheap-model local override)', () => {
  let cloneDir: string;
  let teamConfigPath: string;
  let localConfigPath: string;

  beforeEach(() => {
    cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-cheap-model-'));
    teamConfigPath = path.join(cloneDir, 'kangentic.json');
    localConfigPath = path.join(cloneDir, 'kangentic.local.json');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    fs.rmSync(cloneDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rewrites a mixed column set to the cheap tier: auto -> acceptEdits, plan left untouched, id-less column dropped', async () => {
    const teamConfig = {
      version: 1,
      columns: [
        { id: 'col-auto-1', name: 'Doing', role: null, permissionMode: 'auto' },
        { id: 'col-auto-2', name: 'Review', role: null, permissionMode: 'auto' },
        { id: 'col-plan', name: 'Planning', role: null, permissionMode: 'plan' },
        { id: 'col-none', name: 'To Do', role: 'todo' },
        // No `id` at all - matching by id is required, so a fallback that
        // invents one here would insert a NEW column and duplicate the board.
        { name: 'Ghost Column', role: null, permissionMode: 'auto' },
      ],
    };
    fs.writeFileSync(teamConfigPath, JSON.stringify(teamConfig, null, 2));

    await forcePreviewCheapModels(cloneDir);

    expect(fs.existsSync(localConfigPath)).toBe(true);
    const emitted = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8')) as EmittedPreviewLocalConfig;

    expect(emitted.version).toBe(1);
    // The id-less "Ghost Column" is dropped: 5 team columns in, 4 emitted.
    expect(emitted.columns).toHaveLength(4);
    expect(emitted.columns.map((column) => column.id).sort()).toEqual(
      ['col-auto-1', 'col-auto-2', 'col-none', 'col-plan'],
    );

    for (const column of emitted.columns) {
      expect(column.modelOverride).toBe('haiku');
      expect(column.effortOverride).toBe('low');
    }

    const byId = new Map(emitted.columns.map((column) => [column.id, column]));

    expect(byId.get('col-auto-1')?.permissionMode).toBe('acceptEdits');
    expect(byId.get('col-auto-2')?.permissionMode).toBe('acceptEdits');

    // 'plan' is left untouched: the key must be ABSENT (not re-set to 'plan'),
    // so the team value passes through the per-column merge in
    // config-helpers.ts ({ ...team, ...local }). This is the assertion that
    // goes red if someone widens the rewrite to always set permissionMode.
    expect('permissionMode' in (byId.get('col-plan') as object)).toBe(false);
    // A column with no permissionMode at all in the team config is likewise
    // left alone.
    expect('permissionMode' in (byId.get('col-none') as object)).toBe(false);
  });

  it('is a no-op (no throw, no kangentic.local.json) when kangentic.json does not exist', async () => {
    await expect(forcePreviewCheapModels(cloneDir)).resolves.toBeUndefined();
    expect(fs.existsSync(localConfigPath)).toBe(false);
  });

  it('is a no-op (no throw, no kangentic.local.json) when kangentic.json is malformed JSON', async () => {
    fs.writeFileSync(teamConfigPath, '{ this is not valid json');

    await expect(forcePreviewCheapModels(cloneDir)).resolves.toBeUndefined();
    expect(fs.existsSync(localConfigPath)).toBe(false);
  });

  it('is a no-op (no throw, no kangentic.local.json) when columns is not an array', async () => {
    fs.writeFileSync(teamConfigPath, JSON.stringify({ version: 1, columns: 'not-an-array' }));

    await expect(forcePreviewCheapModels(cloneDir)).resolves.toBeUndefined();
    expect(fs.existsSync(localConfigPath)).toBe(false);
  });

  it('is a no-op (no throw, no kangentic.local.json) when every column is id-less', async () => {
    // Every column gets filtered out by the id match, leaving an empty
    // columns array - the early return this guards depends on the same
    // id-required filtering as the drop assertion above.
    fs.writeFileSync(
      teamConfigPath,
      JSON.stringify({
        version: 1,
        columns: [
          { name: 'Ghost A', role: null, permissionMode: 'auto' },
          { name: 'Ghost B', role: null },
        ],
      }),
    );

    await expect(forcePreviewCheapModels(cloneDir)).resolves.toBeUndefined();
    expect(fs.existsSync(localConfigPath)).toBe(false);
  });
});
