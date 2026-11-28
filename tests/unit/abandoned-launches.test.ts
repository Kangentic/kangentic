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

  // Sentry DESKTOP-2N: the launch an update's install ended was reported as a
  // person giving up, and only a timestamp match against another issue showed
  // otherwise. The quit says what began it, and the next start reports that.
  it.each(['update', 'os', 'user'] as const)('reports what began the quit as quit_by=%s on the next start', (quitBy) => {
    recordAbandonedLaunches(filePath, [{ ...LAUNCH, quit_by: quitBy }]);
    reportAbandonedLaunches(filePath);

    expect(reportHandledError).toHaveBeenCalledTimes(1);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ stage: 'abandoned', ended_by: 'quit', quit_by: quitBy });
  });

  it('sends nothing that is not a fixed value as quit_by', () => {
    fs.writeFileSync(filePath, JSON.stringify([{ ...LAUNCH, quit_by: 'update to /Users/dev/secret-project' }]));
    reportAbandonedLaunches(filePath);
    expect(reportHandledError).not.toHaveBeenCalled();
  });

  // Sentry DESKTOP-2N: five quit events, every one `not_read`. The quit now records
  // the class the start bound read before it, and that class names the cause as a kill's does.
  it('reports the class the quit recorded, under the cause it names', () => {
    recordAbandonedLaunches(filePath, [{ ...LAUNCH, output_class: 'no_such_file' }]);
    reportAbandonedLaunches(filePath);

    const [error, tags, , fingerprint] = reportHandledError.mock.calls[0];
    expect(tags).toMatchObject({ stage: 'abandoned', cause: 'no_such_file', output_class: 'no_such_file' });
    expect(fingerprint).toEqual(['agent-launch', 'abandoned', 'no_such_file']);
    expect((error as Error).name).toBe('AgentLaunchAbandonedError');
  });

  it('files a class that named no cause as other, as a kill does, and keeps the user\'s own setup out of the defects', () => {
    recordAbandonedLaunches(filePath, [{ ...LAUNCH, output_class: 'other', other_from: 'shell' }, { ...LAUNCH, agent: 'codex', output_class: 'login_required' }]);
    reportAbandonedLaunches(filePath);

    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ cause: 'other', output_class: 'other', other_from: 'shell' });
    expect((reportHandledError.mock.calls[1][0] as Error).name).toBe('AgentUserSetupError');
  });

  it('reads a class it does not know as not_read, since anything can edit the file', () => {
    recordAbandonedLaunches(filePath, [{ ...LAUNCH, output_class: 'made_up' }]);
    reportAbandonedLaunches(filePath);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ cause: 'unknown', output_class: 'not_read' });
  });

  it.each(['constructor', 'toString', '__proto__'])('reads the inherited object key %s as not_read, not as a class', (inheritedKey) => {
    recordAbandonedLaunches(filePath, [{ ...LAUNCH, output_class: inheritedKey }]);
    reportAbandonedLaunches(filePath);
    expect(reportHandledError.mock.calls[0][1]).toMatchObject({ cause: 'unknown', output_class: 'not_read' });
  });

  it('keeps a quit with many broken launches to a few', () => {
    recordAbandonedLaunches(filePath, Array.from({ length: 50 }, () => LAUNCH));
    expect(JSON.parse(fs.readFileSync(filePath, 'utf-8'))).toHaveLength(8);
  });
});
