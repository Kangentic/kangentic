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
import {
  assessResumeConversation,
  assessResumeConversationWithEvidence,
  type ResumeConversationAssessment,
  type ResumeLineageRecord,
} from '../../src/main/transition-engine/resume-conversation-guard';
import { proveClaudeConversationGoneOnHost } from '../../src/main/agent/adapters/claude/conversation-gone';
import type { HostCommandRequest, HostCommandResult } from '../../src/main/remote/protocol/messages';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';
import { ClaudeStatusParser } from '../../src/main/agent/adapters/claude/status-parser';
import { CodexAdapter } from '../../src/main/agent/adapters/codex';
import { CopilotAdapter } from '../../src/main/agent/adapters/copilot/copilot-adapter';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini';
import { serializeCliTarget, type SshCliPlace, type SshPlaceFiles } from '../../src/main/agent/shared/cli-target';
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

  describe('that never ran and left no report, with a transcript path missing from this disk', () => {
    const noTurns = { total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 };

    it('is unknown when the spawn is on the host, and never asks the adapter to prove it', async () => {
      const proveConversationGone = vi.fn<NonNullable<AgentAdapter['proveConversationGone']>>().mockResolvedValue(true);
      expect(fs.existsSync(path.join(projectPath, '.kangentic', 'sessions', RECORD_ID))).toBe(false);
      expect(fs.existsSync(HOST_TRANSCRIPT)).toBe(false);

      const verdict = await assessResumeConversation({
        adapter: adapterWithProof(proveConversationGone),
        agentSessionId: AGENT_SESSION_ID,
        records: [recordOn('host-a', noTurns)],
        cwd: projectPath,
        projectPath,
        place: sshPlace('host-a'),
      });

      expect(verdict).toBe('unknown');
      expect(proveConversationGone).not.toHaveBeenCalled();
    });

    it('is unknown when only the record ran on the host, and never asks the adapter to prove it', async () => {
      const proveConversationGone = vi.fn<NonNullable<AgentAdapter['proveConversationGone']>>().mockResolvedValue(true);
      expect(fs.existsSync(path.join(projectPath, '.kangentic', 'sessions', RECORD_ID))).toBe(false);

      const verdict = await assessResumeConversation({
        adapter: adapterWithProof(proveConversationGone),
        agentSessionId: AGENT_SESSION_ID,
        records: [recordOn('host-a', noTurns)],
        cwd: projectPath,
        projectPath,
        // No spawn place is given, so the place check is skipped and only the record's own host decides.
        place: undefined,
      });

      expect(verdict).toBe('unknown');
      expect(proveConversationGone).not.toHaveBeenCalled();
    });
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

  describe.each([
    ['Codex', () => new CodexAdapter()],
    ['Gemini', () => new GeminiAdapter()],
    ['Copilot', () => new CopilotAdapter()],
    ['Aider', () => new AiderAdapter()],
    ['Droid', () => new DroidAdapter()],
  ])('with %s, whose real adapter answers', (_name, makeAdapter) => {
    const assess = (transcriptPath: string): ReturnType<typeof assessResumeConversation> => assessResumeConversation({
      adapter: makeAdapter(),
      agentSessionId: AGENT_SESSION_ID,
      records: [recordOn('host-a', { transcript_path: transcriptPath })],
      cwd: projectPath,
      projectPath,
      place: sshPlace('host-a'),
    });

    it('reads the same with no copy, an empty copy and an old copy, so a mirror never decides a resume', async () => {
      const copy = path.join(projectPath, 'mirror', 'copy.jsonl');

      await expect(assess(copy)).resolves.toBe('unknown');

      fs.mkdirSync(path.dirname(copy), { recursive: true });
      fs.writeFileSync(copy, '');
      await expect(assess(copy)).resolves.toBe('unknown');

      fs.writeFileSync(copy, '{"type":"an old line"}\n');
      await expect(assess(copy)).resolves.toBe('unknown');
    });
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

  // Sentry DESKTOP-2M on 0.64.0: a resume on a host answered "No conversation found", and every later
  // Resume ran the same `--resume`. The marks and the host's own look are what can end that.
  describe('decided by Kangentic\'s own launch marks, which read no file', () => {
    const noTurns = { total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 };

    it('starts fresh when the retiring record\'s launch check marked it and no record shows a turn', async () => {
      const assessment = await assessResumeConversationWithEvidence({
        adapter: adapterWithProof(vi.fn().mockResolvedValue(false)),
        agentSessionId: AGENT_SESSION_ID,
        records: [recordOn('host-a', { ...noTurns, launch_failed_at: '2026-11-27T10:00:00.000Z' })],
        cwd: projectPath,
        projectPath,
        place: sshPlace('host-a'),
      });

      expect(assessment.verdict).toBe('never-started');
    });

    it('starts fresh, owing its prompt, when the record that minted the id never ran its CLI', async () => {
      const assessment = await assessResumeConversationWithEvidence({
        adapter: adapterWithProof(vi.fn().mockResolvedValue(false)),
        agentSessionId: AGENT_SESSION_ID,
        records: [recordOn('host-a', { ...noTurns, agent_session_id: AGENT_SESSION_ID, agent_never_ran_at: '2026-11-27T10:00:00.000Z' })],
        cwd: projectPath,
        projectPath,
        place: sshPlace('host-a'),
      });

      expect(assessment).toMatchObject({ verdict: 'never-started', promptOwed: true });
    });

    it('keeps resuming a lineage with turns, whatever a mark says', async () => {
      const verdict = await assessResumeConversation({
        adapter: adapterWithProof(vi.fn().mockResolvedValue(false)),
        agentSessionId: AGENT_SESSION_ID,
        records: [recordOn('host-a', { launch_failed_at: '2026-11-27T10:00:00.000Z' })],
        cwd: projectPath,
        projectPath,
        place: sshPlace('host-a'),
      });

      expect(verdict).toBe('unknown');
    });
  });

  describe('decided by the host\'s own look, through the spawn\'s helper', () => {
    const noTurns = { total_input_tokens: 0, total_output_tokens: 0, total_cost_usd: 0 };
    const answered = (stdout: string, extra: Partial<HostCommandResult> = {}): HostCommandResult => ({ code: 0, stdout, stderr: '', timedOut: false, ...extra });

    /** The real Claude proof, so the script's answer is read as it is in the app. */
    function claudeOnHost(): AgentAdapter {
      return {
        runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } },
        proveConversationGoneOnHost: proveClaudeConversationGoneOnHost,
      } as unknown as AgentAdapter;
    }

    function placeWithHost(runCommand: (request: HostCommandRequest) => Promise<HostCommandResult>): SshCliPlace {
      return { ...sshPlace('host-a'), files: { runCommand } as unknown as SshPlaceFiles };
    }

    async function assessOnHost(runCommand: (request: HostCommandRequest) => Promise<HostCommandResult>, overrides: Partial<ResumeLineageRecord> = {}): Promise<ResumeConversationAssessment> {
      return assessResumeConversationWithEvidence({
        adapter: claudeOnHost(),
        agentSessionId: AGENT_SESSION_ID,
        records: [recordOn('host-a', overrides)],
        cwd: projectPath,
        projectPath,
        place: placeWithHost(runCommand),
      });
    }

    it('starts fresh, owing its prompt, when the host finds the file nowhere and no record shows a turn', async () => {
      const runCommand = vi.fn(async () => answered('KG:absent\n'));

      expect(await assessOnHost(runCommand, noTurns)).toMatchObject({ verdict: 'never-started', promptOwed: true });
      // The projects folder comes from the path the agent reported, and the id is an argument.
      const [request] = runCommand.mock.calls[0] as unknown as [HostCommandRequest];
      expect(request.file).toBe('sh');
      expect(request.args.slice(2)).toEqual(['kangentic-claude-conversation', '/home/dev/.claude/projects', AGENT_SESSION_ID]);
    });

    it('calls a conversation with turns expired when the host finds its file nowhere', async () => {
      expect((await assessOnHost(async () => answered('KG:absent\n'))).verdict).toBe('expired');
    });

    it('never judges a conversation by the default folder when no path was reported, with turns or without', async () => {
      const runCommand = vi.fn(async () => answered('KG:absent\n'));

      expect((await assessOnHost(runCommand, { transcript_path: null })).verdict).toBe('unknown');
      // No turns on the copy here proves nothing on a host, and the agent's folder may not be the default.
      expect((await assessOnHost(runCommand, { ...noTurns, transcript_path: null })).verdict).toBe('unknown');
      expect(runCommand).not.toHaveBeenCalled();
    });

    it('takes the projects folder from the agent\'s status report when the record holds no path', async () => {
      // The record's column is empty, as before its first status tick was stored; the report names the path.
      writeStatusReport(HOST_TRANSCRIPT, false);
      const runCommand = vi.fn(async () => answered('KG:absent\n'));

      expect(await assessOnHost(runCommand, { ...noTurns, transcript_path: null })).toMatchObject({ verdict: 'never-started', promptOwed: true });
      const [request] = runCommand.mock.calls[0] as unknown as [HostCommandRequest];
      expect(request.args.slice(2)).toEqual(['kangentic-claude-conversation', '/home/dev/.claude/projects', AGENT_SESSION_ID]);
    });

    it.each<[string, () => Promise<HostCommandResult>]>([
      ['finds the file', async () => answered('KG:present\n')],
      ['cannot read its folders', async () => answered('KG:unknown\n')],
      ['cannot be asked', async () => { throw Object.assign(new Error('the link stopped'), { name: 'HostRequestUnansweredError' }); }],
      ['runs out of time', async () => answered('', { code: null, timedOut: true })],
      ['cannot start the script', async () => answered('', { code: null, error: 'spawn sh ENOENT' })],
      ['exits with an error', async () => answered('KG:absent\n', { code: 2 })],
    ])('keeps resuming when the host %s', async (_label, runCommand) => {
      expect((await assessOnHost(runCommand, noTurns)).verdict).toBe('unknown');
    });

    // The Claude proof catches its own failures, so only an adapter that throws reaches the guard's own catch.
    it.each<[string, () => Promise<boolean>]>([
      ['throws at once', () => { throw new Error('the probe blew up'); }],
      ['returns a promise that rejects', () => Promise.reject(new Error('the probe rejected'))],
    ])('keeps resuming when the adapter\'s host proof %s', async (_label, probe) => {
      const proveConversationGoneOnHost = vi.fn(probe);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const assessment = await assessResumeConversationWithEvidence({
        adapter: {
          runtime: { statusFile: { parseStatus: ClaudeStatusParser.parseStatus } },
          proveConversationGoneOnHost,
        } as unknown as AgentAdapter,
        agentSessionId: AGENT_SESSION_ID,
        records: [recordOn('host-a', noTurns)],
        cwd: projectPath,
        projectPath,
        place: placeWithHost(async () => answered('KG:absent\n')),
      });

      expect(proveConversationGoneOnHost).toHaveBeenCalledTimes(1);
      expect(assessment.verdict).toBe('unknown');
    });

    it('keeps resuming when the place has no helper to ask, as a place read back from a record has none', async () => {
      const verdict = await assessResumeConversation({
        adapter: claudeOnHost(),
        agentSessionId: AGENT_SESSION_ID,
        records: [recordOn('host-a', noTurns)],
        cwd: projectPath,
        projectPath,
        place: sshPlace('host-a'),
      });

      expect(verdict).toBe('unknown');
    });
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
