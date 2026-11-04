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

// The parser itself never throws on a bad file (it reads through catch-all
// helpers), so the adapter's catch is reached only by making it throw here.
const parserFailure = vi.hoisted(() => ({ error: null as Error | null }));
vi.mock('../../src/main/agent/adapters/copilot/transcript-parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/adapters/copilot/transcript-parser')>();
  return {
    ...actual,
    parseCopilotTranscript: (...args: Parameters<typeof actual.parseCopilotTranscript>) => {
      if (parserFailure.error) return Promise.reject(parserFailure.error);
      return actual.parseCopilotTranscript(...args);
    },
  };
});

import { CopilotAdapter } from '../../src/main/agent/adapters/copilot';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';

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

  it('parseTranscript reads the path the agent reported, over a located log', async () => {
    kangenticLog([{ type: 'user.message', id: 'u-located', timestamp: TIMESTAMP, data: { content: 'located' } }]);
    const reportedPath = writeJsonl(path.join(tmpDir, 'reported', 'events.jsonl'), [
      { type: 'user.message', id: 'u-reported', timestamp: TIMESTAMP, data: { content: 'reported' } },
    ]);

    const parsed = await adapter.parseTranscript(SESSION_ID, projectRoot, null, reportedPath);

    expect(parsed.sourcePath).toBe(reportedPath);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ uuid: 'u-reported', text: 'reported' });
  });

  it('parseTranscript answers no entries but keeps the source path, and warns, when the parser throws', async () => {
    const eventsPath = kangenticLog([{ type: 'user.message', id: 'u-1', timestamp: TIMESTAMP, data: { content: 'hello' } }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    parserFailure.error = new Error('unreadable log');
    try {
      expect(await adapter.parseTranscript(SESSION_ID, projectRoot)).toEqual({ entries: [], sourcePath: eventsPath });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      parserFailure.error = null;
      warn.mockRestore();
    }
  });

  it('readTranscriptPage returns the located log\'s entries', async () => {
    kangenticLog([
      { type: 'user.message', id: 'u-1', timestamp: TIMESTAMP, data: { content: 'first' } },
      { type: 'user.message', id: 'u-2', timestamp: TIMESTAMP, data: { content: 'second' } },
    ]);

    const result = await adapter.readTranscriptPage(SESSION_ID, projectRoot, { direction: 'after', cursor: 'j:0', maxBytes: 64 * 1024 });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.page.entries.map((entry) => entry.uuid)).toEqual(['u-1', 'u-2']);
  });

  // The place is where the CLI runs: a log in a WSL distro's Copilot home is
  // found only when the adapter hands it on, since the host's home holds none.
  describe('with a Copilot in a WSL distro', () => {
    function distroPlace(): CliPlace {
      const distroHome = path.join(tmpDir, 'distro-home');
      writeJsonl(path.join(distroHome, '.copilot', 'session-state', SESSION_ID, 'events.jsonl'), [
        { type: 'user.message', id: 'u-distro', timestamp: TIMESTAMP, data: { content: 'in the distro' } },
      ]);
      return {
        kind: 'wsl',
        distro: 'Ubuntu',
        linuxCliPath: '/home/dev/.local/bin/copilot',
        facts: {
          distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: distroHome, uncRoot: '\\\\wsl.localhost\\Ubuntu',
          interactivePath: '/usr/bin', env: {}, networkingMode: 'nat',
        },
      };
    }

    it('parseTranscript looks in the distro\'s home', async () => {
      const parsed = await adapter.parseTranscript(SESSION_ID, projectRoot, distroPlace());
      expect(parsed.entries.map((entry) => entry.uuid)).toEqual(['u-distro']);
      expect(await adapter.parseTranscript(SESSION_ID, projectRoot)).toEqual({ entries: [], sourcePath: null });
    });

    it('readTranscriptPage looks in the distro\'s home', async () => {
      const request = { direction: 'after' as const, cursor: 'j:0', maxBytes: 64 * 1024 };
      const result = await adapter.readTranscriptPage(SESSION_ID, projectRoot, request, distroPlace());
      expect(result.status).toBe('ok');
      expect(await adapter.readTranscriptPage(SESSION_ID, projectRoot, request)).toEqual({ status: 'unavailable', reason: 'file_missing' });
    });
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
