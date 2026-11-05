/**
 * The launches a quit ended, written on the way out and reported by the next
 * launch. Quitting a terminal that never started is how a person gives up, and
 * nothing sent from the quit path lands, so without this that ending never
 * reaches Sentry.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const reportHandledError = vi.hoisted(() => vi.fn());

vi.mock('../../src/main/analytics/error-reporting', () => ({ reportHandledError }));
vi.mock('../../src/main/analytics/analytics', () => ({ trackEvent: vi.fn() }));

import { recordAbandonedLaunches, reportAbandonedLaunches } from '../../src/main/pty/abandoned-launches';
import { resetLaunchReports } from '../../src/main/pty/agent-launch-report';

const LAUNCH = {
  agent: 'claude',
  agent_cli_version: '2.1.302',
  start_path: 'board',
  shell: 'zsh',
  attempt: '1',
  session_age_s: '15-30',
  ended_by: 'quit',
  output_class: 'not_read',
};

describe('abandoned launches', () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'abandoned-launches-'));
    filePath = path.join(directory, 'abandoned-launches.json');
    reportHandledError.mockClear();
    resetLaunchReports();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reports what the last run wrote, then forgets it', () => {
    recordAbandonedLaunches(filePath, [LAUNCH]);
    expect(reportHandledError).not.toHaveBeenCalled();

    reportAbandonedLaunches(filePath);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    const [error, tags] = reportHandledError.mock.calls[0];
    expect((error as Error).name).toBe('AgentLaunchAbandonedError');
    expect(tags).toMatchObject({ stage: 'abandoned', ended_by: 'quit', agent: 'claude', shell: 'zsh' });
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('writes nothing for a quit with nothing to report', () => {
    recordAbandonedLaunches(filePath, []);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('does nothing when no file is there', () => {
    expect(() => reportAbandonedLaunches(filePath)).not.toThrow();
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('drops a corrupt file instead of failing every start', () => {
    fs.writeFileSync(filePath, '{ not json');
    expect(() => reportAbandonedLaunches(filePath)).not.toThrow();
    expect(reportHandledError).not.toHaveBeenCalled();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('sends nothing that is not a fixed value, whatever the file holds', () => {
    fs.writeFileSync(filePath, JSON.stringify([
      { ...LAUNCH, shell: '/Users/dev/secret-project/zsh' },
      { ...LAUNCH, agent: 'claude --prompt ship the Acme migration' },
      'a string',
      null,
    ]));
    reportAbandonedLaunches(filePath);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  it('sends one event for three launches of one agent, and logs all three', () => {
    recordAbandonedLaunches(filePath, [LAUNCH, LAUNCH, LAUNCH]);
    reportAbandonedLaunches(filePath);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(3);
  });

  it('sends one event per agent when a file holds two', () => {
    recordAbandonedLaunches(filePath, [LAUNCH, { ...LAUNCH, agent: 'codex' }, LAUNCH]);
    reportAbandonedLaunches(filePath);

    expect(reportHandledError).toHaveBeenCalledTimes(2);
    const agents = reportHandledError.mock.calls.map((call) => call[1].agent).sort();
    expect(agents).toEqual(['claude', 'codex']);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(3);
  });

  it('keeps a quit with many broken launches to a few', () => {
    recordAbandonedLaunches(filePath, Array.from({ length: 50 }, () => LAUNCH));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toHaveLength(8);
  });
});
