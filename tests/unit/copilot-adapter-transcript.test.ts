/**
 * CopilotAdapter's transcript wiring: how the adapter locates a session's
 * event log and hands it to the transcript parser. The parser's own cases live
 * in copilot-transcript-parser.test.ts and the locator's in
 * copilot-session-state.test.ts; these pin the adapter between them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The user's home is a temp folder, so a lookup that falls through to
// `~/.copilot` can never find a real log.
let tmpHome: string;
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, default: { ...actual, homedir: () => tmpHome }, homedir: () => tmpHome };
});

import { CopilotAdapter } from '../../src/main/agent/adapters/copilot';

const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const TIMESTAMP = '2026-10-30T10:00:00.000Z';

let tmpDir: string;
let projectRoot: string;
let savedCopilotHome: string | undefined;
let adapter: CopilotAdapter;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-adapter-transcript-'));
  tmpHome = path.join(tmpDir, 'home');
  projectRoot = path.join(tmpDir, 'repo');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  savedCopilotHome = process.env.COPILOT_HOME;
  delete process.env.COPILOT_HOME;
  adapter = new CopilotAdapter();
});

afterEach(() => {
  if (savedCopilotHome === undefined) delete process.env.COPILOT_HOME;
  else process.env.COPILOT_HOME = savedCopilotHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filePath: string, records: unknown[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  return filePath;
}

/** The event log of a Kangentic session record's config home, where the locator looks. */
function kangenticLog(records: unknown[]): string {
  return writeJsonl(
    path.join(projectRoot, '.kangentic', 'sessions', 'record-1', 'copilot-config', 'session-state', SESSION_ID, 'events.jsonl'),
    records,
  );
}

function shutdownEvent(inputTokens: number, outputTokens: number): unknown {
  return { type: 'session.shutdown', id: 'shutdown', timestamp: TIMESTAMP, data: { modelMetrics: { 'model-a': { usage: { inputTokens, outputTokens } } } } };
}

function toolStartEvent(toolCallId: string, toolName: string): unknown {
  return { type: 'tool.execution_start', id: `start-${toolCallId}`, timestamp: TIMESTAMP, data: { toolCallId, toolName } };
}

describe('CopilotAdapter transcript wiring', () => {
  it('parseTranscript answers no entries and no source when no log is found', async () => {
    expect(await adapter.parseTranscript(SESSION_ID, projectRoot)).toEqual({ entries: [], sourcePath: null });
  });

  it('parseTranscript returns the located log\'s entries with its path', async () => {
    const eventsPath = kangenticLog([{ type: 'user.message', id: 'u-1', timestamp: TIMESTAMP, data: { content: 'hello' } }]);

    const parsed = await adapter.parseTranscript(SESSION_ID, projectRoot);

    expect(parsed.sourcePath).toBe(eventsPath);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ kind: 'user', uuid: 'u-1', text: 'hello' });
  });

  it('readTranscriptPage reports the file missing when no log is found', async () => {
    const result = await adapter.readTranscriptPage(SESSION_ID, projectRoot, { direction: 'earlier' } as never);
    expect(result).toEqual({ status: 'unavailable', reason: 'file_missing' });
  });

  it('locateResumeHistoryFile never answers, even when the log exists', async () => {
    kangenticLog([{ type: 'user.message', id: 'u-1', timestamp: TIMESTAMP, data: { content: 'hello' } }]);
    expect(await adapter.locateResumeHistoryFile()).toBeNull();
  });

  describe('transcriptUsage', () => {
    it('prefers transcriptPath over a located log', async () => {
      kangenticLog([shutdownEvent(99, 9)]);
      const explicitPath = writeJsonl(path.join(tmpDir, 'explicit', 'events.jsonl'), [shutdownEvent(10, 2)]);

      const usage = await adapter.transcriptUsage({ transcriptPath: explicitPath, agentSessionId: SESSION_ID, cwd: projectRoot });

      expect(usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    });

    it('locates the log by session id and cwd when no transcriptPath is given', async () => {
      kangenticLog([shutdownEvent(99, 9)]);
      expect(await adapter.transcriptUsage({ agentSessionId: SESSION_ID, cwd: projectRoot })).toEqual({ inputTokens: 99, outputTokens: 9 });
    });

    it('answers null without a transcriptPath or both a session id and a cwd', async () => {
      kangenticLog([shutdownEvent(99, 9)]);
      expect(await adapter.transcriptUsage({})).toBeNull();
      expect(await adapter.transcriptUsage({ agentSessionId: SESSION_ID })).toBeNull();
      expect(await adapter.transcriptUsage({ cwd: projectRoot })).toBeNull();
    });
  });

  describe('transcriptToolCounts', () => {
    it('prefers transcriptPath over a located log', async () => {
      kangenticLog([toolStartEvent('call-1', 'view'), toolStartEvent('call-2', 'view')]);
      const explicitPath = writeJsonl(path.join(tmpDir, 'explicit', 'events.jsonl'), [toolStartEvent('call-9', 'edit')]);

      const counts = await adapter.transcriptToolCounts({ transcriptPath: explicitPath, agentSessionId: SESSION_ID, cwd: projectRoot });

      expect(counts?.toolCallCount).toBe(1);
      expect(counts?.toolBreakdown.map((stat) => stat.toolName)).toEqual(['edit']);
    });

    it('locates the log by session id and cwd when no transcriptPath is given', async () => {
      kangenticLog([toolStartEvent('call-1', 'view'), toolStartEvent('call-2', 'view')]);

      const counts = await adapter.transcriptToolCounts({ agentSessionId: SESSION_ID, cwd: projectRoot });

      expect(counts?.toolCallCount).toBe(2);
    });

    it('answers null without a transcriptPath or both a session id and a cwd', async () => {
      kangenticLog([toolStartEvent('call-1', 'view')]);
      expect(await adapter.transcriptToolCounts({})).toBeNull();
      expect(await adapter.transcriptToolCounts({ agentSessionId: SESSION_ID })).toBeNull();
      expect(await adapter.transcriptToolCounts({ cwd: projectRoot })).toBeNull();
    });
  });
});
