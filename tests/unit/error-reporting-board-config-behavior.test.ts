/**
 * The board's export to `kangentic.json` runs from a debounce timer and from a
 * project open, and both drop the line it returns. So a write-back that threw
 * left a board edit out of the file the team shares and told nobody. This runs
 * the real `BoardConfigManager` over a real folder, makes the database read
 * throw, and checks the report: its stage, and nothing a user wrote.
 *
 * The repositories are stubbed the way `board-config-cache.test.ts` stubs them,
 * so there is no database behind the manager.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reportHandledError = vi.hoisted(() => vi.fn());
vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));

const swimlanes = vi.hoisted(() => ({ list: (): unknown[] => [] }));
vi.mock('../../src/main/db/database', () => ({ getProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/swimlane-repository', () => ({
  SwimlaneRepository: class { list() { return swimlanes.list(); } },
}));
vi.mock('../../src/main/db/repositories/action-repository', () => ({
  ActionRepository: class { list() { return []; } listTransitions() { return []; } },
}));
vi.mock('../../src/main/db/repositories/automation-repository', () => ({
  AutomationRepository: class { listAll() { return []; } listForColumn() { return []; } },
}));

import { BoardConfigManager } from '../../src/main/config/board-config-manager';
import { TEAM_FILE } from '../../src/main/config/board-config/config-helpers';

describe('a board write-back that throws', () => {
  let projectFolder: string;

  beforeEach(() => {
    reportHandledError.mockReset();
    swimlanes.list = () => [];
    projectFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'board-config-report-'));
    fs.writeFileSync(
      path.join(projectFolder, TEAM_FILE),
      JSON.stringify({ version: 1, columns: [{ id: 'lane-1', name: 'Acme intake' }], actions: [], transitions: [] }, null, 2),
    );
  });

  afterEach(() => {
    fs.rmSync(projectFolder, { recursive: true, force: true });
  });

  it('reports the stage, keeps the file as it was, and still answers its caller', () => {
    swimlanes.list = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'Acme intake')");
    };
    const before = fs.readFileSync(path.join(projectFolder, TEAM_FILE), 'utf8');

    const answer = new BoardConfigManager({ ephemeral: false }).writeBackForProject('project-1', projectFolder);

    expect(answer).toContain(TEAM_FILE);
    expect(fs.readFileSync(path.join(projectFolder, TEAM_FILE), 'utf8')).toBe(before);
    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({
      source: 'board_config',
      stage: 'write_back',
      error_name: 'TypeError',
    });
    const sent = JSON.stringify(reportHandledError.mock.calls.map(([error, tags]) => [String(error), tags]));
    expect(sent).not.toMatch(/acme/i);
    expect(sent).not.toContain(projectFolder);
  });

  it('reports nothing for a write-back that succeeds', () => {
    expect(new BoardConfigManager({ ephemeral: false }).writeBackForProject('project-1', projectFolder)).toBeNull();
    expect(reportHandledError).not.toHaveBeenCalled();
  });
});
