/**
 * The resume check's branches `resume-conversation-guard.test.ts` does not
 * reach, plus `resolveResumeLineage`, the shared lineage builder both spawn
 * chokepoints call.
 *
 * `assessResumeConversation` degrades to `unknown` (resume as before) on
 * anything short of proof. Three of those degradations were unpinned:
 *
 *  - turns on the row but no reported path anywhere: nothing to prove gone;
 *  - an adapter proof that throws: logged, never allowed to fail the spawn;
 *  - the same path reported twice: handed to the proof once.
 *
 * The cases that need a "would have been expired" signal use a stub proof that
 * answers true, not Claude's real one. Claude's returns false for an empty path
 * list on its own, so against it a missing guard would still read `unknown`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessResumeConversation,
  assessResumeConversationWithEvidence,
  folderOnlyRecord,
  resolveResumeLineage,
  type ResumeLineageRecord,
} from '../../src/main/transition-engine/resume-conversation-guard';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { CliPlace } from '../../src/main/agent/shared/cli-target';
import { makeSessionRecord } from './helpers/session-record-fixture';

const RECORD_ID = '6fc5d715-77ca-47d6-9c50-8f27ad05e4a7';
const AGENT_SESSION_ID = '935a5611-0f79-4f34-a5ea-62f2a4bd7894';

type ProveConversationGone = NonNullable<AgentAdapter['proveConversationGone']>;

let projectPath: string;
let transcriptPath: string;
let cwd: string;

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-resume-guard-branches-'));
  transcriptPath = path.join(projectPath, 'claude-projects', '-work-project', `${AGENT_SESSION_ID}.jsonl`);
  cwd = path.join(projectPath, 'never-a-claude-project');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectPath, { recursive: true, force: true });
});

/** A status pipeline that parses real Claude status JSON, and the given proof. */
function adapterWithProof(proveConversationGone: ProveConversationGone): AgentAdapter {
  return {
    runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } },
    proveConversationGone,
  } as unknown as AgentAdapter;
}

/** A row that ran: the totals prove turns. */
function rowWithTurns(overrides: Partial<ResumeLineageRecord> = {}): ResumeLineageRecord {
  return {
    id: RECORD_ID,
    transcript_path: transcriptPath,
    total_input_tokens: 9100,
    total_output_tokens: 300,
    total_cost_usd: 0.4,
    ...overrides,
  };
}

/** The status line's report, in the real captured shape, for one record's folder. */
function writeStatusFile(options: { recordId?: string; reportedPath: string }): void {
  const sessionDir = path.join(projectPath, '.kangentic', 'sessions', options.recordId ?? RECORD_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
    session_id: AGENT_SESSION_ID,
    transcript_path: options.reportedPath,
    model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
    cost: { total_cost_usd: 0, total_duration_ms: 1388, total_api_duration_ms: 0 },
    context_window: {
      total_input_tokens: 4200,
      total_output_tokens: 0,
      context_window_size: 200000,
      current_usage: { input_tokens: 4200, output_tokens: 130, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      used_percentage: null,
    },
  }), 'utf8');
}

function assess(adapter: AgentAdapter, records: ReadonlyArray<ResumeLineageRecord | null>) {
  return assessResumeConversation({ adapter, agentSessionId: AGENT_SESSION_ID, records, cwd, projectPath });
}

describe('assessResumeConversation - turns but no reported path', () => {
  it.each([
    ['input tokens', { total_input_tokens: 9100, total_output_tokens: 0, total_cost_usd: 0 }],
    ['output tokens', { total_input_tokens: 0, total_output_tokens: 300, total_cost_usd: 0 }],
    ['cost', { total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0.4 }],
  ])('is unknown, and never asks the adapter, when the row shows %s but names no transcript', async (_label, totals) => {
    const proveConversationGone = vi.fn<ProveConversationGone>().mockResolvedValue(true);
    expect(fs.existsSync(path.join(projectPath, '.kangentic', 'sessions', RECORD_ID))).toBe(false);

    const verdict = await assess(
      adapterWithProof(proveConversationGone),
      [rowWithTurns({ transcript_path: null, ...totals })],
    );

    expect(verdict).toBe('unknown');
    expect(proveConversationGone).not.toHaveBeenCalled();
  });

  it('asks the adapter once the same row names a transcript (the control)', async () => {
    // Same row, same stub, same missing session folder: the only difference is
    // the path, and now the stub's true becomes the verdict.
    const proveConversationGone = vi.fn<ProveConversationGone>().mockResolvedValue(true);

    const verdict = await assess(adapterWithProof(proveConversationGone), [rowWithTurns()]);

    expect(verdict).toBe('expired');
    expect(proveConversationGone).toHaveBeenCalledTimes(1);
  });
});

describe('assessResumeConversation - an adapter proof that fails', () => {
  it.each([
    ['rejects', (failure: Error) => vi.fn<ProveConversationGone>().mockRejectedValue(failure)],
    ['throws synchronously', (failure: Error) => vi.fn<ProveConversationGone>().mockImplementation(() => { throw failure; })],
  ])('is unknown, and the failure does not escape, when the proof %s', async (_label, makeProof) => {
    const failure = new Error('proof exploded');
    const proveConversationGone = makeProof(failure);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const verdict = await assess(adapterWithProof(proveConversationGone), [rowWithTurns()]);

    expect(verdict).toBe('unknown');
    expect(proveConversationGone).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('Conversation-gone probe failed');
    expect(warnSpy.mock.calls[0][1]).toBe(failure);
  });
});

describe('assessResumeConversation - what the adapter is asked about', () => {
  it('passes a path reported by both the row and the status file once', async () => {
    writeStatusFile({ reportedPath: transcriptPath });
    const proveConversationGone = vi.fn<ProveConversationGone>().mockResolvedValue(false);

    const verdict = await assess(adapterWithProof(proveConversationGone), [rowWithTurns()]);

    expect(verdict).toBe('unknown');
    expect(proveConversationGone).toHaveBeenCalledTimes(1);
    // Array equality, so a doubled entry fails.
    expect(proveConversationGone).toHaveBeenCalledWith({
      agentSessionId: AGENT_SESSION_ID,
      reportedPaths: [transcriptPath],
      cwd,
      // The record ran its CLI on this machine.
      place: null,
    });
  });

  it('passes a path reported by two records of the lineage once', async () => {
    const olderRecordId = '2fec0dab-99d2-407a-8782-2a748dfc935e';
    writeStatusFile({ recordId: olderRecordId, reportedPath: transcriptPath });
    const proveConversationGone = vi.fn<ProveConversationGone>().mockResolvedValue(false);

    await assess(adapterWithProof(proveConversationGone), [rowWithTurns(), folderOnlyRecord(olderRecordId)]);

    expect(proveConversationGone).toHaveBeenCalledTimes(1);
    expect(proveConversationGone.mock.calls[0][0].reportedPaths).toEqual([transcriptPath]);
  });

  it('passes every distinct path the row and the status file report', async () => {
    const statusFilePath = path.join(projectPath, 'claude-projects', '-work-project-renamed', `${AGENT_SESSION_ID}.jsonl`);
    writeStatusFile({ reportedPath: statusFilePath });
    const proveConversationGone = vi.fn<ProveConversationGone>().mockResolvedValue(false);

    await assess(adapterWithProof(proveConversationGone), [rowWithTurns()]);

    expect(proveConversationGone).toHaveBeenCalledTimes(1);
    const reportedPaths = [...proveConversationGone.mock.calls[0][0].reportedPaths].sort();
    expect(reportedPaths).toEqual([transcriptPath, statusFilePath].sort());
  });
});

/**
 * What the check saw, beside its verdict. A launch report for a resume that
 * found no conversation sends it (DESKTOP-2M answered `unknown` and could not say
 * whether it had no agent report to read or saw turns and a transcript it could
 * not prove gone). Fixed values only: no path leaves the machine.
 */
describe('assessResumeConversationWithEvidence - the summary', () => {
  function assessWithEvidence(
    adapter: AgentAdapter,
    records: ReadonlyArray<ResumeLineageRecord | null>,
    extra: { resumeFromCwd?: string | null; place?: CliPlace | null } = {},
  ) {
    return assessResumeConversationWithEvidence({ adapter, agentSessionId: AGENT_SESSION_ID, records, cwd, projectPath, ...extra });
  }

  /** A row with no totals: nothing on it proves a turn. */
  function rowWithoutTurns(overrides: Partial<ResumeLineageRecord> = {}): ResumeLineageRecord {
    return { id: RECORD_ID, transcript_path: null, total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0, ...overrides };
  }

  function writeZeroTurnStatusFile(reportedPath: string): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
      session_id: AGENT_SESSION_ID,
      transcript_path: reportedPath,
      model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
      cost: { total_cost_usd: 0, total_duration_ms: 0, total_api_duration_ms: 0 },
      context_window: {
        total_input_tokens: 0,
        total_output_tokens: 0,
        context_window_size: 200000,
        current_usage: null,
        used_percentage: null,
      },
    }), 'utf8');
  }

  function writeSessionStartEvent(reportedPath: string): void {
    const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
    fs.mkdirSync(sessionDir, { recursive: true });
    const event = { type: 'session_start', hookContext: JSON.stringify({ transcript_path: reportedPath }) };
    fs.writeFileSync(path.join(sessionDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, 'utf8');
  }

  function writeTranscript(): void {
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
    fs.writeFileSync(transcriptPath, '{}\n', 'utf8');
  }

  const neverAsked = (): ProveConversationGone => vi.fn<ProveConversationGone>().mockResolvedValue(false);

  const UBUNTU_PLACE: CliPlace = {
    kind: 'wsl',
    distro: 'Ubuntu',
    facts: {
      distro: 'Ubuntu',
      homeLinux: '/home/dev',
      homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
      uncRoot: '\\\\wsl.localhost\\Ubuntu',
      interactivePath: '/usr/bin',
      env: {},
      networkingMode: 'nat',
    },
  };

  it('no agent report: no turns, no report, nothing reported', async () => {
    const result = await assessWithEvidence(adapterWithProof(neverAsked()), [rowWithoutTurns()]);

    expect(result.verdict).toBe('unknown');
    expect(result.evidence).toEqual({ turns: 'no', agentReport: 'none', transcript: 'not_reported', cwd: 'unknown' });
  });

  it('no turns, and the status line named a transcript that is not on disk', async () => {
    writeZeroTurnStatusFile(transcriptPath);

    const result = await assessWithEvidence(adapterWithProof(neverAsked()), [rowWithoutTurns()]);

    expect(result.verdict).toBe('never-started');
    expect(result.evidence).toEqual({ turns: 'no', agentReport: 'status', transcript: 'missing', cwd: 'unknown' });
  });

  it('turns, and the transcript the agent reported is on disk', async () => {
    writeStatusFile({ reportedPath: transcriptPath });
    writeTranscript();

    const result = await assessWithEvidence(adapterWithProof(neverAsked()), [rowWithTurns()]);

    expect(result.verdict).toBe('unknown');
    expect(result.evidence).toEqual({ turns: 'yes', agentReport: 'status', transcript: 'on_disk', cwd: 'unknown' });
  });

  it('a transcript stat that fails for a reason other than ENOENT is unknown, and never proves a launch that never ran', async () => {
    writeZeroTurnStatusFile(transcriptPath);
    const realStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (target, ...rest) => {
      if (target === transcriptPath) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return realStat(target, ...(rest as []));
    });

    const result = await assessWithEvidence(adapterWithProof(neverAsked()), [rowWithoutTurns()]);

    // Only ENOENT is proof of absence: the same status file reads never-started when the stat says ENOENT.
    expect(result.verdict).toBe('unknown');
    expect(result.evidence).toEqual({ turns: 'no', agentReport: 'status', transcript: 'unknown', cwd: 'unknown' });
  });

  it('names the SessionStart hook when that is the only report', async () => {
    writeSessionStartEvent(transcriptPath);

    const result = await assessWithEvidence(adapterWithProof(neverAsked()), [rowWithoutTurns()]);

    expect(result.evidence).toMatchObject({ turns: 'no', agentReport: 'session_start', transcript: 'missing' });
  });

  it('carries the summary on the branch where the CLI moved place, and reads no transcript there', async () => {
    writeTranscript();

    const result = await assessWithEvidence(
      adapterWithProof(neverAsked()),
      [rowWithTurns({ cli_target: null })],
      // The record ran its CLI on this machine; this spawn's runs in a distro.
      { place: UBUNTU_PLACE },
    );

    expect(result.verdict).toBe('expired');
    // The transcript is on disk, and the summary says unknown: it was never read.
    expect(result.evidence).toEqual({ turns: 'yes', agentReport: 'none', transcript: 'unknown', cwd: 'unknown' });
  });

  it.each([
    ['same', () => cwd],
    ['moved', () => path.join(projectPath, 'an-older-worktree-name')],
  ])('reads the cwd the conversation last ran in as %s', async (expected, resumeFromCwd) => {
    const result = await assessWithEvidence(adapterWithProof(neverAsked()), [rowWithoutTurns()], { resumeFromCwd: resumeFromCwd() });

    expect(result.evidence?.cwd).toBe(expected);
  });

  it('gives no summary and no verdict but unknown with no project path', async () => {
    const result = await assessResumeConversationWithEvidence({
      adapter: adapterWithProof(neverAsked()), agentSessionId: AGENT_SESSION_ID, records: [rowWithTurns()], cwd, projectPath: null,
    });

    expect(result).toEqual({ verdict: 'unknown', evidence: null });
  });
});

describe('resolveResumeLineage', () => {
  const RESUMED_ID = 'conversation-resumed';
  const OTHER_ID = 'conversation-other';

  it('puts the retiring record first, then the rest of its conversation in the list order, once each', () => {
    // The list is newest first, as the repository returns it, and the retiring
    // record is deliberately not the newest.
    const newestSameConversation = makeSessionRecord({ id: 'rec-5', agent_session_id: RESUMED_ID });
    const otherConversation = makeSessionRecord({ id: 'rec-4', agent_session_id: OTHER_ID });
    const retiring = makeSessionRecord({ id: 'rec-3', agent_session_id: RESUMED_ID });
    const noAgentSessionId = makeSessionRecord({ id: 'rec-2', agent_session_id: null });
    const oldestSameConversation = makeSessionRecord({ id: 'rec-1', agent_session_id: RESUMED_ID });

    const { lineage } = resolveResumeLineage({
      taskRecords: [newestSameConversation, otherConversation, retiring, noAgentSessionId, oldestSameConversation],
      retiringRecordId: 'rec-3',
      resumedAgentSessionId: RESUMED_ID,
    });

    expect(lineage).toHaveLength(3);
    expect(lineage[0]).toBe(retiring);
    expect(lineage[1]).toBe(newestSameConversation);
    expect(lineage[2]).toBe(oldestSameConversation);
  });

  it('keys on the reconciled id: the retiring record stays, older records with its stale id do not', () => {
    // After a /clear fork the retiring record still holds the id it was spawned
    // with. The records that share THAT id ran another conversation.
    const forkedLater = makeSessionRecord({ id: 'rec-4', agent_session_id: RESUMED_ID });
    const retiring = makeSessionRecord({ id: 'rec-3', agent_session_id: 'conversation-stale' });
    const sharesStaleId = makeSessionRecord({ id: 'rec-2', agent_session_id: 'conversation-stale' });
    const forkedEarlier = makeSessionRecord({ id: 'rec-1', agent_session_id: RESUMED_ID });

    const { lineage } = resolveResumeLineage({
      taskRecords: [forkedLater, retiring, sharesStaleId, forkedEarlier],
      retiringRecordId: 'rec-3',
      resumedAgentSessionId: RESUMED_ID,
    });

    expect(lineage).toEqual([retiring, forkedLater, forkedEarlier]);
    expect(lineage).not.toContain(sharesStaleId);
  });

  it('turns a retiring id missing from the list into a folder-only record, with no last-active time', () => {
    const sameConversation = makeSessionRecord({ id: 'rec-2', agent_session_id: RESUMED_ID });
    const otherConversation = makeSessionRecord({ id: 'rec-1', agent_session_id: OTHER_ID });

    const { lineage, lastActiveAt } = resolveResumeLineage({
      taskRecords: [sameConversation, otherConversation],
      retiringRecordId: 'rec-gone',
      resumedAgentSessionId: RESUMED_ID,
    });

    expect(lineage).toHaveLength(2);
    expect(lineage[0]).toEqual(folderOnlyRecord('rec-gone'));
    // Known by id alone: nothing on it can prove turns or a path.
    expect(lineage[0]).toEqual({
      id: 'rec-gone',
      transcript_path: null,
      total_input_tokens: null,
      total_output_tokens: null,
      total_cost_usd: null,
    });
    expect(lineage[1]).toBe(sameConversation);
    expect(lastActiveAt).toBeNull();
  });

  it('starts the lineage with null when there is no retiring record id', () => {
    const sameConversation = makeSessionRecord({ id: 'rec-2', agent_session_id: RESUMED_ID });
    const otherConversation = makeSessionRecord({ id: 'rec-1', agent_session_id: OTHER_ID });

    const { lineage, lastActiveAt } = resolveResumeLineage({
      taskRecords: [sameConversation, otherConversation],
      retiringRecordId: null,
      resumedAgentSessionId: RESUMED_ID,
    });

    expect(lineage).toEqual([null, sameConversation]);
    expect(lastActiveAt).toBeNull();
  });

  it('gives a folder-only record, or null, for an empty list', () => {
    expect(resolveResumeLineage({ taskRecords: [], retiringRecordId: 'rec-1', resumedAgentSessionId: RESUMED_ID }))
      .toEqual({ lineage: [folderOnlyRecord('rec-1')], lastActiveAt: null });
    expect(resolveResumeLineage({ taskRecords: [], retiringRecordId: null, resumedAgentSessionId: RESUMED_ID }))
      .toEqual({ lineage: [null], lastActiveAt: null });
  });

  describe('lastActiveAt is the retiring record\'s suspended_at, else exited_at, else started_at', () => {
    const STARTED_AT = '2026-03-01T08:00:00.000Z';
    const EXITED_AT = '2026-03-01T09:00:00.000Z';
    const SUSPENDED_AT = '2026-03-01T10:00:00.000Z';
    const NEWER_RECORD_TIME = '2026-04-01T00:00:00.000Z';

    it.each([
      ['suspended_at when set', { suspended_at: SUSPENDED_AT, exited_at: EXITED_AT }, SUSPENDED_AT],
      ['exited_at when it was never suspended', { suspended_at: null, exited_at: EXITED_AT }, EXITED_AT],
      ['started_at when it neither suspended nor exited', { suspended_at: null, exited_at: null }, STARTED_AT],
    ])('is %s', (_label, endTimes, expected) => {
      // A newer sibling in the same conversation carries later times of its own:
      // the answer must come from the retiring record, not from the newest one.
      const newerSibling = makeSessionRecord({
        id: 'rec-2',
        agent_session_id: RESUMED_ID,
        started_at: NEWER_RECORD_TIME,
        suspended_at: NEWER_RECORD_TIME,
        exited_at: NEWER_RECORD_TIME,
      });
      const retiring = makeSessionRecord({ id: 'rec-1', agent_session_id: RESUMED_ID, started_at: STARTED_AT, ...endTimes });

      const { lastActiveAt } = resolveResumeLineage({
        taskRecords: [newerSibling, retiring],
        retiringRecordId: 'rec-1',
        resumedAgentSessionId: RESUMED_ID,
      });

      expect(lastActiveAt).toBe(expected);
    });
  });
});
