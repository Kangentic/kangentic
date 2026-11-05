/**
 * The resume check for a conversation that lives on a remote host (#913).
 *
 * Only the host can prove a file there is gone. The path a status line reports is a path on the host, so
 * a test of this computer's disk finds nothing and would read as proof: the resume would be replaced by a
 * fresh conversation and the old one abandoned. Phase 0 measured this shape at 279 false "expired"
 * verdicts in 500 resumes when a local mirror stood in for the host.
 *
 * What a user loses if it breaks: a long conversation silently replaced by a new one on every resume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assessResumeConversation, type ResumeLineageRecord } from '../../src/main/transition-engine/resume-conversation-guard';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import { serializeCliTarget, type SshCliPlace } from '../../src/main/agent/shared/cli-target';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';

const RECORD_ID = '6fc5d715-77ca-47d6-9c50-8f27ad05e4a7';
const AGENT_SESSION_ID = '935a5611-0f79-4f34-a5ea-62f2a4bd7894';
const HOST_TRANSCRIPT = '/home/dev/.claude/projects/-home-dev-api/935a5611-0f79-4f34-a5ea-62f2a4bd7894.jsonl';

let projectPath: string;

function sshPlace(hostId: string): SshCliPlace {
  return { kind: 'ssh', hostId, home: '/home/dev', shellName: 'bash', localHome: path.join(projectPath, 'mirror'), roots: [{ local: projectPath, host: '/home/dev/api' }] };
}

function adapterWithProof(proveConversationGone: NonNullable<AgentAdapter['proveConversationGone']>): AgentAdapter {
  return { runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } }, proveConversationGone } as unknown as AgentAdapter;
}

function recordOn(hostId: string, overrides: Partial<ResumeLineageRecord> = {}): ResumeLineageRecord {
  return {
    id: RECORD_ID,
    transcript_path: HOST_TRANSCRIPT,
    total_input_tokens: 9100,
    total_output_tokens: 300,
    total_cost_usd: 0.4,
    cli_target: serializeCliTarget(sshPlace(hostId)),
    ...overrides,
  };
}

function writeStatusReport(reportedPath: string, withTurns: boolean): void {
  const sessionDir = path.join(projectPath, '.kangentic', 'sessions', RECORD_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, 'status.json'), JSON.stringify({
    session_id: AGENT_SESSION_ID,
    transcript_path: reportedPath,
    model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku 4.5' },
    cost: { total_cost_usd: 0, total_duration_ms: 1388, total_api_duration_ms: 0 },
    context_window: {
      total_input_tokens: withTurns ? 4200 : 0,
      total_output_tokens: 0,
      context_window_size: 200000,
      current_usage: { input_tokens: withTurns ? 4200 : 0, output_tokens: withTurns ? 130 : 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      used_percentage: null,
    },
  }), 'utf8');
}

beforeEach(() => {
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-resume-guard-ssh-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectPath, { recursive: true, force: true });
});

describe('a conversation that ran on a host', () => {
  it('is never called expired because its transcript is not on this computer\'s disk, and never asks the adapter to prove it', async () => {
    const proveConversationGone = vi.fn<NonNullable<AgentAdapter['proveConversationGone']>>().mockResolvedValue(true);
    expect(fs.existsSync(HOST_TRANSCRIPT)).toBe(false);

    const verdict = await assessResumeConversation({
      adapter: adapterWithProof(proveConversationGone),
      agentSessionId: AGENT_SESSION_ID,
      records: [recordOn('host-a')],
      cwd: projectPath,
      projectPath,
      place: sshPlace('host-a'),
    });

    expect(verdict).toBe('unknown');
    expect(proveConversationGone).not.toHaveBeenCalled();
  });

  it('is never called never-started because a transcript the agent named is missing here', async () => {
    writeStatusReport(HOST_TRANSCRIPT, false);

    const verdict = await assessResumeConversation({
      adapter: adapterWithProof(vi.fn().mockResolvedValue(true)),
      agentSessionId: AGENT_SESSION_ID,
      records: [recordOn('host-a', { total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 })],
      cwd: projectPath,
      projectPath,
      place: sshPlace('host-a'),
    });

    expect(verdict).toBe('unknown');
  });

  it('reads the same whatever copy this computer holds: empty, stale, or none, since only the host can say', async () => {
    const copy = path.join(projectPath, 'mirror', '.kangentic', 'transcripts', 'agent', `${AGENT_SESSION_ID}.json`);
    const assess = (): ReturnType<typeof assessResumeConversation> => assessResumeConversation({
      adapter: adapterWithProof(vi.fn().mockResolvedValue(true)),
      agentSessionId: AGENT_SESSION_ID,
      records: [recordOn('host-a', { transcript_path: copy })],
      cwd: projectPath,
      projectPath,
      place: sshPlace('host-a'),
    });

    await expect(assess()).resolves.toBe('unknown');

    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, '');
    await expect(assess()).resolves.toBe('unknown');

    fs.writeFileSync(copy, '{"conversation":"an old export"}');
    await expect(assess()).resolves.toBe('unknown');
  });

  it('still cannot be resumed on a different host, where its files are not: that needs no file to decide', async () => {
    const verdict = await assessResumeConversation({
      adapter: adapterWithProof(vi.fn().mockResolvedValue(false)),
      agentSessionId: AGENT_SESSION_ID,
      records: [recordOn('host-a')],
      cwd: projectPath,
      projectPath,
      place: sshPlace('host-b'),
    });

    expect(verdict).toBe('expired');
  });

  it('cannot be resumed on this computer either', async () => {
    const verdict = await assessResumeConversation({
      adapter: adapterWithProof(vi.fn().mockResolvedValue(false)),
      agentSessionId: AGENT_SESSION_ID,
      records: [recordOn('host-a')],
      cwd: projectPath,
      projectPath,
      place: null,
    });

    expect(verdict).toBe('expired');
  });
});
