import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logDrive, type DriveTelemetryRecord } from '../../src/main/browser/drive-telemetry';

/**
 * The judgment call in this module is WHEN a drive is worth warning about, and
 * that is worth pinning: warn too eagerly and one agent's ordinary parallel tool
 * calls produce noise that trains the reader to ignore the line.
 */

function record(overrides: Partial<DriveTelemetryRecord> = {}): DriveTelemetryRecord {
  return {
    capability: 'observe',
    callerSessionId: 'caller-session-id',
    callerTaskId: 'caller-task-id',
    resolvedSessionId: 'resolved-session-id',
    resolvedTaskId: 'resolved-task-id',
    projectId: 'project-id',
    webContentsId: 7,
    queueDepthAtEntry: 1,
    waitedMs: 0,
    durationMs: 12,
    outcome: 'ok',
    ...overrides,
  };
}

let logs: string[] = [];
let warnings: string[] = [];

beforeEach(() => {
  logs = [];
  warnings = [];
  vi.spyOn(console, 'log').mockImplementation((message: string) => { logs.push(message); });
  vi.spyOn(console, 'warn').mockImplementation((message: string) => { warnings.push(message); });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logDrive', () => {
  it('records the caller, the resolved pane and the guest on every drive', () => {
    // Proving the diagnosis needs all three: the reported failure was N drives
    // with ONE callerSessionId landing on ONE webContentsId.
    logDrive(record());
    expect(warnings).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('caller=caller-s');
    expect(logs[0]).toContain('pane=resolved');
    expect(logs[0]).toContain('wc=7');
    expect(logs[0]).toContain('outcome=ok');
  });

  it('says "unattributed" rather than hiding a caller-less drive', () => {
    // A Command Terminal or hand-configured MCP client has no caller segment.
    logDrive(record({ callerSessionId: undefined }));
    expect(logs[0]).toContain('caller=unattributed');
  });

  it('does not warn about one agent making two parallel tool calls', () => {
    // Depth 2 is ordinary: a single agent can issue parallel calls in one turn,
    // so warning here would be noise, not signal.
    logDrive(record({ queueDepthAtEntry: 2 }));
    expect(warnings).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('warns once three drives share one pane', () => {
    logDrive(record({ queueDepthAtEntry: 3 }));
    expect(logs).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('CONTENTION');
    expect(warnings[0]).toContain('3 drives are sharing this Browser pane');
  });

  it('warns when a drive was materially delayed even at low depth', () => {
    // Depth can read low if earlier callers already drained; a long wait is the
    // other face of the same problem.
    logDrive(record({ queueDepthAtEntry: 2, waitedMs: 1500 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('waited=1500ms');
  });

  it('reports a busy refusal with the time actually spent queueing', () => {
    logDrive(record({ outcome: 'pane-busy', queueDepthAtEntry: 4, waitedMs: 30000 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('outcome=pane-busy');
    expect(warnings[0]).toContain('waited=30000ms');
  });
});
