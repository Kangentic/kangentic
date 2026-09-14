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
import { stableAutomationTypes } from '../../src/shared/automation-manifest';

interface EmittedPreviewAutomation {
  name: string;
  type: string;
  enabled?: boolean;
}

interface EmittedPreviewColumn {
  id: string;
  modelOverride: string;
  effortOverride: string;
  permissionMode?: string;
  automations?: { onEnter?: EmittedPreviewAutomation[]; onExit?: EmittedPreviewAutomation[] };
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

  it('puts one switched-off automation of every stable type on the variety column, and spreads the rest', async () => {
    // The preview's display fixtures. They ride this file rather than being
    // written to the database because `apply-config` runs on every project open
    // and owns each column's list, so a direct write is replaced before anyone
    // sees it. Asserted here because nothing else can: typecheck and lint both
    // pass against a fixture that silently stopped being emitted, which is
    // exactly how the first attempt failed.
    fs.writeFileSync(teamConfigPath, JSON.stringify({
      version: 1,
      columns: [
        { id: 'col-todo', name: 'To Do', role: 'todo', permissionMode: null },
        { id: 'col-executing', name: 'Executing', role: null, permissionMode: 'auto' },
        { id: 'col-planning', name: 'Planning', role: null, permissionMode: 'plan' },
        { id: 'col-review', name: 'Code Review', role: null, permissionMode: 'auto', autoCommand: '/code-review' },
      ],
    }, null, 2));

    await forcePreviewCheapModels(cloneDir);

    const emitted = JSON.parse(fs.readFileSync(localConfigPath, 'utf-8')) as EmittedPreviewLocalConfig;
    const byId = new Map(emitted.columns.map((column) => [column.id, column]));
    const rowsOf = (id: string) => {
      const fixtures = byId.get(id)?.automations;
      return [...(fixtures?.onEnter ?? []), ...(fixtures?.onExit ?? [])];
    };

    // Every stable type across the seeded columns, so adding an adapter without
    // a fixture goes red here rather than showing up as a preview that cannot
    // demonstrate the new type.
    const allRows = [...rowsOf('col-executing'), ...rowsOf('col-planning'), ...rowsOf('col-todo')];
    expect([...new Set(allRows.map((row) => row.type))].sort()).toEqual([...stableAutomationTypes()].sort());

    // Executing is the variety column: one of every type, both groups.
    const executing = byId.get('col-executing')?.automations;
    expect([...new Set(rowsOf('col-executing').map((row) => row.type))].sort())
      .toEqual([...stableAutomationTypes()].sort());
    expect(executing?.onEnter?.length).toBeGreaterThan(0);
    expect(executing?.onExit?.length).toBeGreaterThan(0);

    // Planning populates both group headings without running long, which is the
    // shape the rail lands on most often.
    expect(byId.get('col-planning')?.automations?.onEnter?.length).toBe(1);
    expect(byId.get('col-planning')?.automations?.onExit?.length).toBe(1);

    // To Do is exit-only (an enter row can never fire on a role column) and
    // carries the CANNOT-RUN state on purpose: a `send_message` where no agent
    // starts renders with its switch disabled and the reason in the tooltip.
    expect(byId.get('col-todo')?.automations?.onEnter).toBeUndefined();
    expect(byId.get('col-todo')?.automations?.onExit?.[0]?.type).toBe('send_message');

    // OFF, every one, on every column. These are display fixtures, not
    // behavior: a preview move must not POST to example.com or run a package
    // install.
    for (const row of allRows) expect(row.enabled).toBe(false);

    // Never a column the committed config already gives automations to. A
    // column's list REPLACES on merge, so seeding Code Review / Testing / Merge
    // would silently delete the `autoCommand` message the team board runs.
    expect('automations' in (byId.get('col-review') as object)).toBe(false);
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
