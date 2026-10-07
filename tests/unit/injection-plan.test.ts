/**
 * Tests for prepareInjectionPlan - the central per-task helper that
 * task-move and column/profile edits (strategy-propagation) both use to decide
 * what a live session needs: a restart for a model/effort change, and/or the
 * column auto_command typed in with the right per-adapter verifier.
 *
 * The whole point of this helper is to keep IPC handlers agent-agnostic.
 * These tests verify that:
 * - The delta SOURCE is what the session is actually running at (the agent's
 *   reported effort, then the recorded applied_model / applied_effort), NOT the
 *   leaving column's config. A move into a column whose value the session
 *   already has does nothing.
 * - A MODEL or EFFORT change to a concrete value is never typed into the PTY:
 *   it sets `restartReason` ('model' wins when both change) for the caller to
 *   suspend + respawn with launch flags. A null ("Default") target is not a
 *   real change, so it never restarts.
 * - The adapter's getInjectionSequence is never consulted (it serves only the
 *   Command Terminal now), so the sequence carries the auto_command alone.
 * - The verifier is wired up only when the adapter declares one AND a
 *   captured agent_session_id is available
 * - auto_command is trimmed and verified under the `submitted` mode
 */
import { describe, it, expect, vi } from 'vitest';
import { buildCommandInjectionVerifier, prepareInjectionPlan, resolveReportedEffort, resolveRestartReason, resolveSourceEffort, resolveTargetSettings, restartPhaseFor } from '../../src/main/transition-engine/injection-plan';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { SessionRecord, Swimlane } from '../../src/shared/types';
import type { InjectionPlan } from '../../src/main/transition-engine/injection-plan';

/**
 * Command text only. The plan now carries per-command verify modes, so most
 * assertions care about WHAT is delivered; the modes themselves are asserted
 * explicitly in the verification describe below.
 */
function planTexts(plan: InjectionPlan | null): string[] | undefined {
  return plan?.sequence.map((command) => command.text);
}

function lane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-1',
    name: 'Lane',
    color: '#000',
    position: 0,
    role: null,
    auto_command: null,
    permission_mode: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function fakeAdapter(overrides: Partial<AgentAdapter>): AgentAdapter {
  return {
    name: 'fake',
    displayName: 'Fake',
    sessionType: 'claude_agent',
    supportsCallerSessionId: false,
    permissions: [],
    defaultPermission: 'projectSettings',
    detect: async () => ({ found: false, path: null, version: null }),
    invalidateDetectionCache: () => undefined,
    buildCommand: () => ({ command: '', args: [] }),
    locateSessionHistoryFile: async () => null,
    runtime: { activity: { kind: 'pty' }, sessionIdCapture: { kind: 'none' } },
    ...overrides,
  } as unknown as AgentAdapter;
}

/**
 * An adapter that WOULD emit `/model` and `/effort` the way Claude does, so a
 * test proves the plan never types them rather than passing because the
 * adapter had nothing to offer.
 */
function slashAdapter(): AgentAdapter {
  return fakeAdapter({
    getInjectionSequence: (spec) => {
      const out: string[] = [];
      if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
      if (spec.effortChanged && spec.effort) out.push(`/effort ${spec.effort}`);
      return out;
    },
  });
}

/**
 * A SessionRepository stub whose `getLatestForTask` returns the given record
 * (or null for "no session record"). Only the fields prepareInjectionPlan reads
 * (`applied_model`, `applied_effort`, and `agent_session_id` / `cwd` for the
 * verifier) need to be present.
 */
function sessionRepoWith(record: Partial<SessionRecord> | null): SessionRepository {
  return {
    getLatestForTask: () => record ?? undefined,
    // The verifier re-reads the record by primary key on every poll (see the
    // poll-time id re-resolution describe below).
    findByAnyId: () => record ?? undefined,
  } as unknown as SessionRepository;
}

describe('prepareInjectionPlan', () => {
  it('returns null when the session already runs at the target (no delta, no auto_command)', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
    });
    expect(plan).toBeNull();
  });

  it('does nothing when the session already has the target value and there is no leaving-column reference', () => {
    // The reported bug: every column is xhigh, the session was spawned at xhigh
    // (applied_effort), and the move had a null leaving-column. The old code
    // diffed null vs xhigh and acted on a change that was not there. Diffing
    // against the recorded applied value yields no change.
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'xhigh' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: 'opus', effort_override: 'xhigh' }),
    });
    expect(plan).toBeNull();
  });

  it('restarts for effort when the session runs at the agent default and the column pins a concrete value', () => {
    // applied_* null = the session was spawned with no --model/--effort flag
    // (agent default). Entering a configured column must apply it. This is the
    // legitimate case a naive "null source = no-op" guard would have wrongly
    // dropped. It restarts rather than typing `/effort xhigh`.
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: 'xhigh' }),
    });
    expect(plan?.restartReason).toBe('effort');
    expect(planTexts(plan)).toEqual([]);
  });

  it('never asks the adapter for a settings slash, even for an adapter that offers one', () => {
    // `getInjectionSequence` now serves only the Command Terminal. A task
    // session's settings change is a restart, so the plan must not consult it:
    // a live `/effort` mid-turn writes nothing the verifier can confirm.
    const getInjectionSequence = vi.fn(() => ['/model opus', '/effort high']);
    const plan = prepareInjectionPlan({
      adapter: fakeAdapter({ getInjectionSequence }),
      sessionRepo: sessionRepoWith({ applied_model: 'haiku', applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
    });
    expect(getInjectionSequence).not.toHaveBeenCalled();
    expect(planTexts(plan)).toEqual([]);
    expect(plan?.restartReason).toBe('model');
  });

  it('adapters without the hook still flag a restart for a model change', () => {
    const adapter = fakeAdapter({}); // no getInjectionSequence (e.g. Codex)
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
    });
    // The concrete model change (default -> opus) flags a restart for the
    // caller. Plan is non-null so the caller can act on it.
    expect(plan).not.toBeNull();
    expect(planTexts(plan)).toEqual([]);
    expect(plan?.restartReason).toBe('model');
  });

  it('adapters without the hook and no model delta return null', () => {
    const adapter = fakeAdapter({}); // no getInjectionSequence
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'opus' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
    });
    expect(plan).toBeNull(); // no auto_command, no settings delta, no restart -> null
  });

  it('a model change sets restartReason "model" and types nothing', () => {
    // model changes haiku -> opus (restart); effort stays high (no change).
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'haiku', applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
    });
    // Non-null plan even with an empty sequence, so the caller can restart.
    expect(plan).not.toBeNull();
    expect(planTexts(plan)).toEqual([]);
    expect(plan?.restartReason).toBe('model');
    // Nothing is recorded as applied: the respawn records its own flags.
    expect(plan).not.toHaveProperty('appliedSettings');
  });

  it('a model AND effort change reads "model" (the respawn applies both flags)', () => {
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'haiku', applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
    });
    expect(plan?.restartReason).toBe('model');
  });

  it('concrete->null target: a model change to "Default" does not restart, but the concrete effort change does', () => {
    // The session runs at 'opus' but the destination column has no
    // model_override (null = "Default"). `--resume` keeps the model the
    // session runs at, so that is not a real change. The effort field does
    // change (low -> xhigh), and that alone restarts.
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      // model_override: null = "Default" column (no concrete model)
      // effort_override: 'xhigh' = a real change
      toLane: lane({ model_override: null, effort_override: 'xhigh' }),
    });
    expect(plan?.restartReason).toBe('effort');
    expect(planTexts(plan)).toEqual([]);
  });

  it('a null effort target ("Default" column) never restarts', () => {
    // The session runs at xhigh; the destination column sets no effort.
    // `--resume` keeps the running effort, so there is nothing to apply.
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'xhigh' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: 'opus', effort_override: null }),
    });
    expect(plan).toBeNull();
  });

  it('a null effort target with a column message types the message and does not restart', () => {
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'xhigh' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: 'opus', effort_override: null }),
      autoCommand: 'review the diff',
    });
    expect(plan?.restartReason).toBeNull();
    expect(planTexts(plan)).toEqual(['review the diff']);
  });

  it('carries a trimmed auto_command alongside a restart, for the respawn to deliver', () => {
    // The caller restarts and hands the column message to the respawn as its
    // prompt; the plan still reports it so the caller can see what it carries.
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'haiku' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
      autoCommand: '   review the diff   ',
    });
    expect(planTexts(plan)).toEqual(['review the diff']);
    expect(plan?.restartReason).toBe('model');
  });

  it('returns just the auto_command when there are no settings deltas', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: null,
      task: { id: 't1', agent: 'fake' },
      toLane: lane(),
      autoCommand: 'do thing',
    });
    expect(plan).toEqual({
      sequence: [{ text: 'do thing', verify: 'submitted' }],
      verifier: null,
      restartReason: null,
    });
  });

  it('verifies the auto_command itself, under the weaker submitted mode', () => {
    // A single `verifiedPrefixLength` once covered a whole burst, so the
    // trailing user auto_command - the thing users actually care about - was
    // excluded from verification and settled on a fixed timer. The command is
    // now checked for the weaker, always-answerable question: did exactly this
    // text get submitted? No settings write rides along with it any more.
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
      autoCommand: '/review --strict',
    });
    expect(plan?.sequence).toEqual([
      { text: '/review --strict', verify: 'submitted' },
    ]);
  });

  it('marks a SLASH auto_command unverifiable when the adapter declares it cannot verify one', () => {
    // Codex is the measured case: it handles slash input in the TUI and never
    // writes it to the rollout file (an unrecognized `/...` printed
    // "Unrecognized command" and produced no record at all). Absence therefore
    // cannot distinguish "the CLI rejected it" from "the CLI ran it
    // client-side" - and treating the second as a failure escalates to a
    // session restart that destroys live work. `none` keeps the outcome
    // `unconfirmed`, which neither retries nor escalates.
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
      canVerifySlashSubmission: () => false,
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({}),
      autoCommand: '/compact',
    });
    expect(plan?.sequence).toEqual([{ text: '/compact', verify: 'none' }]);
  });

  it('still verifies PROSE on an adapter that cannot verify slash commands', () => {
    // The opt-out is scoped to slash text only. Prose auto_commands are exactly
    // what the verifier handles well, so declining them too would throw away
    // the retry-on-Enter recovery the verifier exists to provide.
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
      canVerifySlashSubmission: () => false,
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({}),
      autoCommand: 'review the diff',
    });
    expect(plan?.sequence).toEqual([{ text: 'review the diff', verify: 'submitted' }]);
  });

  it('keeps a slash auto_command verifiable when the adapter says nothing', () => {
    // Omitting the capability must not silently weaken existing adapters:
    // Claude and Qwen both record slash invocations and keep `submitted`.
    const adapter = fakeAdapter({ getInjectionSequence: () => [] });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({}),
      autoCommand: '/pull-request',
    });
    expect(plan?.sequence).toEqual([{ text: '/pull-request', verify: 'submitted' }]);
  });

  it('marks the auto_command non-escalatable for a CONFIRM-ONLY verifier', () => {
    // A confirm-only verifier is one whose adapter has not proven it end to end
    // in a running app (every adapter here except Claude and Codex). It may
    // confirm and it may drive retry-on-Enter, both pure upside. It must not
    // authorize escalation, because escalation restarts the session and destroys
    // live work, and a false negative from an unproven verifier is a guess.
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
      canEscalateOnVerificationFailure: () => false,
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({}),
      autoCommand: 'review the diff',
    });
    // Still `submitted`, so it is still verified and still retried.
    expect(plan?.sequence).toEqual([
      { text: 'review the diff', verify: 'submitted', escalatable: false },
    ]);
  });

  it('leaves the auto_command escalatable for a MEASURED verifier', () => {
    // The field is omitted rather than set to true: its contract is
    // "omitted or true means escalatable", so an ordinary command carries no
    // redundant key.
    const adapter = fakeAdapter({ getInjectionSequence: () => [] });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({}),
      autoCommand: 'review the diff',
    });
    expect(plan?.sequence).toEqual([{ text: 'review the diff', verify: 'submitted' }]);
    expect(plan?.sequence[0].escalatable).toBeUndefined();
  });

  it('still verifies a cwd-keyed adapter that has no agent_session_id', async () => {
    // Aider is the case: it declares no `sessionIdCapture` because it keeps ONE
    // `.aider.chat.history.md` per project directory, so a session never gets
    // an agent_session_id. Without the opt-out the wrapper short-circuits on
    // the missing id and the verifier can NEVER confirm - which is strictly
    // worse than having no verifier, because the burst still retries and then
    // reports `failed` where it used to stay silently `unconfirmed`.
    const seen: Array<{ agentSessionId?: string; cwd?: string }> = [];
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
      requiresAgentSessionIdForVerification: () => false,
      getSubmissionVerifier: () => async (context) => {
        if (context.type !== 'command-injection') return false;
        seen.push({ agentSessionId: context.agentSessionId, cwd: context.cwd });
        return true;
      },
    });
    const verifier = buildCommandInjectionVerifier(
      adapter,
      sessionRepoWith({ id: 's1', agent_session_id: null, cwd: '/mock/project' }),
      't1',
    );
    expect(verifier).not.toBeNull();
    expect(await verifier!('review the diff', Date.now(), 'submitted')).toBe(true);
    expect(seen).toEqual([{ agentSessionId: undefined, cwd: '/mock/project' }]);
  });

  it('still requires an agent_session_id for every other adapter', async () => {
    // The opt-out must not weaken the norm: without a session id, scanning
    // would read some other session's transcript.
    let called = false;
    const adapter = fakeAdapter({
      getInjectionSequence: () => [],
      getSubmissionVerifier: () => async () => { called = true; return true; },
    });
    const verifier = buildCommandInjectionVerifier(
      adapter,
      sessionRepoWith({ id: 's1', agent_session_id: null, cwd: '/mock/project' }),
      't1',
    );
    expect(await verifier!('review the diff', Date.now(), 'submitted')).toBe(false);
    expect(called).toBe(false);
  });

  it('verifier is null when adapter does not implement getSubmissionVerifier', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/x'],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, agent_session_id: 'abc', cwd: '/cwd' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
    });
    expect(plan?.verifier).toBeNull();
  });

  it('still builds a verifier when the agent session id is not captured YET', async () => {
    // A fresh spawn has no captured id at plan-build time. Returning null here
    // would leave fresh-spawn auto_commands permanently unverifiable - and that
    // is the delivery path that most needs the check, since it is the one that
    // runs without a leading clear. Delivery is deferred until the CLI comes
    // alive, and the id is re-resolved on every poll, so by the time
    // verification actually runs the id is there.
    const submissionVerifier = async (): Promise<boolean> => true;
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/x'],
      getSubmissionVerifier: () => submissionVerifier,
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, agent_session_id: null, cwd: '/cwd' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
    });

    expect(plan?.verifier).not.toBeNull();
    // With the id still missing at poll time there is no transcript to scan, so
    // the honest answer is "not confirmed" - which keeps the caller retrying
    // rather than declaring a hard failure.
    expect(await plan?.verifier?.('/x', Date.now(), 'command-match')).toBe(false);
  });

  it('wires the adapter verifier when both the hook and a captured session id are available', () => {
    const submissionVerifier = async (): Promise<boolean> => true;
    let capturedContextType: string | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/x'],
      getSubmissionVerifier: (contextType) => {
        capturedContextType = contextType;
        return submissionVerifier;
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, agent_session_id: 'sess-uuid', cwd: '/repo' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
    });
    expect(plan?.verifier).not.toBeNull();
    expect(capturedContextType).toBe('command-injection');
  });

  it('handles undefined adapter gracefully (no agent or unknown agent name)', () => {
    const plan = prepareInjectionPlan({
      adapter: undefined,
      sessionRepo: null,
      task: { id: 't1', agent: null },
      toLane: lane(),
      autoCommand: 'fallback',
    });
    expect(plan).toEqual({
      sequence: [{ text: 'fallback', verify: 'submitted' }],
      verifier: null,
      restartReason: null,
    });
  });

  it('verifier is null when sessionRepo is null even if adapter has getSubmissionVerifier', () => {
    // Regression guard: the null-sessionRepo short-circuit must fire BEFORE
    // calling adapter.getSubmissionVerifier, even when the adapter would return
    // a real verifier for the command-injection context.
    const submissionVerifier = async (): Promise<boolean> => true;
    let verifierCalled = false;
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/x'],
      getSubmissionVerifier: () => {
        verifierCalled = true;
        return submissionVerifier;
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: null,
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
    });
    expect(plan?.verifier).toBeNull();
    // The guard short-circuits before the adapter is consulted.
    expect(verifierCalled).toBe(false);
  });

  it('wrapper passes sentAt and text through to the inner SubmissionVerifier', async () => {
    // Regression guard for code-review #5: the plan.verifier wrapper must
    // forward both `command` (as context.text) and `sentAt` to the inner
    // SubmissionVerifier so the JSONL scan can bound its window.
    const capturedContexts: Array<{ text: string; sentAt: number | undefined }> = [];
    const submissionVerifier = async (context: { text: string; sentAt?: number }): Promise<boolean> => {
      capturedContexts.push({ text: context.text, sentAt: context.sentAt });
      return true;
    };
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/model opus'],
      getSubmissionVerifier: () => submissionVerifier as never,
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, agent_session_id: 'sess-abc', cwd: '/project' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
    });

    expect(plan?.verifier).not.toBeNull();

    const testSentAt = Date.now();
    await plan!.verifier!('/model opus', testSentAt, 'command-match');

    // The wrapper must have passed both the command text and sentAt through.
    expect(capturedContexts).toHaveLength(1);
    expect(capturedContexts[0].text).toBe('/model opus');
    expect(capturedContexts[0].sentAt).toBe(testSentAt);
  });
});

describe('prepareInjectionPlan -- project-level default_model / default_effort tier', () => {
  // The project default sits below the column override and above the CLI
  // default, and MUST be read on both the source and target sides of the
  // delta (see the header comment on prepareInjectionPlan). Without the `??
  // project?.default_model` / `?? project?.default_effort` fallback on the
  // TARGET side, an override-less column move on a project with a default
  // set would spuriously read source = the recorded applied project default
  // vs target = null, and wrongly restart / re-inject.

  it('no spurious restart: session applied_model already equals the project default, override-less lane', () => {
    const adapter = fakeAdapter({}); // no getInjectionSequence (model-only case)
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'opus' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: null }),
      project: { default_model: 'opus', default_effort: null },
    });
    // Nothing changed and nothing else to do -> null plan, no restart.
    expect(plan).toBeNull();
  });

  it('flags a model restart when the session has no applied_model but the project sets a default', () => {
    const adapter = fakeAdapter({});
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: null }),
      project: { default_model: 'opus', default_effort: null },
    });
    expect(plan).not.toBeNull();
    expect(plan?.restartReason).toBe('model');
  });

  it('no spurious effort restart: session applied_effort already equals the project default, override-less lane', () => {
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: null }),
      project: { default_model: null, default_effort: 'high' },
    });
    // effort source (project default 'high') === target (project default 'high') -> no delta, no plan.
    expect(plan).toBeNull();
  });

  it('restarts for effort when the session has no applied_effort but the project sets a default', () => {
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: null }),
      project: { default_model: null, default_effort: 'high' },
    });
    expect(plan?.restartReason).toBe('effort');
    expect(planTexts(plan)).toEqual([]);
  });
});

describe('prepareInjectionPlan -- project-level default gated by agent match (cross-agent)', () => {
  // Model/effort ids are adapter-specific: a project on `claude` with
  // `default_model: 'haiku'` must not be inherited by a destination that runs
  // a DIFFERENT agent (projectModelDefaultsApply, spawn-preamble.ts). Shipped
  // symptom: a column overriding the agent to `codex` injected
  // `/model haiku`, which Codex rejects outright. This mirrors the same gate
  // pinned for the spawn path (resolveSpawnOverrides, in
  // project-model-defaults-cross-agent.test.ts) and the first-spawn lock
  // (lockAdvancedOverridesOnFirstSpawn, in spawn-agent-lock-overrides.test.ts)
  // - all three must agree, or a move would inject a model the spawn never
  // applied.

  it('drops the project default model when the destination COLUMN overrides the agent', () => {
    const adapter = fakeAdapter({}); // no getInjectionSequence (model-only case)
    const plan = prepareInjectionPlan({
      adapter,
      // Fresh spawn: no applied_model recorded yet.
      sessionRepo: sessionRepoWith(null),
      task: { id: 't1', agent: 'fake', agent_override: null, model_override: null, effort_override: null },
      toLane: lane({ agent_override: 'codex' }),
      project: { default_agent: 'claude', default_model: 'haiku', default_effort: 'low' },
    });
    // Target resolves to null (NOT 'haiku'): the resolved agent is codex, which
    // differs from the project's default agent, so the project tier is gated
    // off. Source is also null (no applied_model), so there is no delta and no
    // restart - the plan is null rather than flagging a `--resume --model haiku`
    // restart for a Codex session.
    expect(plan).toBeNull();
  });

  it('control: inherits the project default model when no agent override is present', () => {
    const adapter = fakeAdapter({});
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith(null),
      task: { id: 't1', agent: 'fake', agent_override: null, model_override: null, effort_override: null },
      toLane: lane({ agent_override: null }),
      project: { default_agent: 'claude', default_model: 'haiku', default_effort: 'low' },
    });
    // The resolved agent (claude, via project.default_agent) matches the
    // project default, so the tier applies: target 'haiku' differs from the
    // null source, flagging a restart.
    expect(plan).not.toBeNull();
    expect(plan?.restartReason).toBe('model');
  });
});

describe('prepareInjectionPlan -- per-task override wins over column override', () => {
  // The ContextBar popover writes `tasks.model_override` / `tasks.effort_override`
  // and the user-confirmed semantic is "task override fully wins over column
  // override". The plan must respect this: if the task carries its own override
  // for a field, that field's source = target = task value, so the delta is
  // zero and that field never restarts the session on a column move. Without
  // this rule, every column transition would restart toward the column's value
  // and undo the user's pinned choice.

  it('does not restart when the task pins a model override (even if the column differs)', () => {
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      // The session was spawned at the pin (the applied value is irrelevant: the
      // pin wins for both source and target).
      sessionRepo: sessionRepoWith({ applied_model: 'opus' }),
      task: { id: 't1', agent: 'fake', model_override: 'opus', effort_override: null },
      toLane: lane({ model_override: 'sonnet' }),
    });
    // Task pinned 'opus', so source=target='opus' -> no model change.
    expect(plan).toBeNull();
  });

  it('does not restart when the task pins an effort override (even if the column differs)', () => {
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_effort: 'xhigh' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: 'xhigh' },
      toLane: lane({ effort_override: 'high' }),
    });
    expect(plan).toBeNull();
  });

  it('does not restart when a pinned effort differs from applied, column, and project defaults', () => {
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      // Source (applied), destination column, and project default are all
      // different from the pin - none of them may leak into the delta.
      sessionRepo: sessionRepoWith({ applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: 'xhigh' },
      toLane: lane({ effort_override: 'high' }),
      project: { default_model: null, default_effort: 'medium' },
    });
    expect(plan).toBeNull();
  });

  it('restarts for a model change while a pinned effort stays put (mixed override)', () => {
    // Session running at haiku/xhigh; effort pinned xhigh; column moves model to opus.
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'haiku', applied_effort: 'xhigh' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: 'xhigh' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
    });
    // model: applied haiku -> column opus is a real change, so it restarts.
    // effort: task-pinned xhigh wins on both sides, so the respawn keeps it.
    expect(planTexts(plan)).toEqual([]);
    expect(plan?.restartReason).toBe('model');
  });

  it('flags a model restart by diffing against the session applied value (no per-task override)', () => {
    const plan = prepareInjectionPlan({
      adapter: slashAdapter(),
      sessionRepo: sessionRepoWith({ applied_model: 'haiku' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: 'opus' }),
    });
    // The real haiku -> opus delta (against the session's applied value)
    // drives the restart.
    expect(plan?.restartReason).toBe('model');
  });
});

/**
 * `applied_effort` records what Kangentic ASKED for at spawn/resume. An
 * `/effort` the user types straight into the terminal never reaches it, so on
 * its own it goes stale and the delta is computed against a value the session
 * stopped running at. The agent's own reported level is preferred as the source.
 */
describe('prepareInjectionPlan - agent-reported effort is the delta source', () => {
  const claudeLike = slashAdapter;

  it('THE BUG: a manual /effort the record never saw no longer hides the change', () => {
    // applied=high (what we asked for at spawn), agent reports medium (the user
    // typed `/effort medium`), destination column requires high. Before the
    // live tier, source and target both read high, effortChanged was false,
    // nothing happened, and the session silently kept running at medium.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'high' }),
      liveEffort: 'medium',
    });
    expect(plan?.restartReason).toBe('effort');
    expect(planTexts(plan)).toEqual([]);
  });

  it('converges: once the restarted session reports the target, the next move does nothing', () => {
    // After a restart with `--effort high`, the respawn records applied=high
    // and the agent reports high. A second move into the same column must not
    // restart again.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'high' }),
      liveEffort: 'high',
    });
    expect(plan).toBeNull();
  });

  it('removes churn when the record is stale but the session already runs at the target', () => {
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'high' }),
      liveEffort: 'high',
    });
    expect(plan).toBeNull();
  });

  it('falls back to the record when the agent reports no effort (Haiku, or any agent without telemetry)', () => {
    // Claude Code omits `effort` for models with no effort levels, so liveEffort
    // is null and behaviour must be exactly what it was before.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'high' }),
      liveEffort: null,
    });
    expect(plan).toBeNull();
  });

  it('keeps a per-task pin ahead of live telemetry, so the pin still controls both sides', () => {
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: 'xhigh' },
      toLane: lane({ effort_override: 'low' }),
      liveEffort: 'medium',
    });
    // Pin wins on BOTH sides, so nothing fires - the ContextBar contract.
    expect(plan).toBeNull();
  });

  it('keeps the NULL applied_effort protection for records predating applied-settings recording', () => {
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: null }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: 'high' },
      toLane: lane({ effort_override: 'high' }),
    });
    expect(plan).toBeNull();
  });

  it('converges on a silently downgraded level: a session launched at the target and unmoved since does not restart', () => {
    // Claude Code silently downgrades `max`/`xhigh` to `high` on a model that
    // does not support them, and its status schema documents the reported level
    // as the one in force "after any silent downgrade for the selected model".
    // This session was launched with `--effort max` (applied) and reported
    // `high` from its first status write on. A restart would pass the same flag
    // and land on `high` again, so every move into a `max` column used to
    // restart for nothing. The first report is what tells this apart from a
    // manual `/effort high`, which moves the live level off it (next test).
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'max' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'max' }),
      liveEffort: 'high',
      firstReportedEffort: 'high',
    });
    expect(plan).toBeNull();
  });

  it('still restarts a downgraded session the user moved by hand with /effort', () => {
    // Launched at `max`, first reported `high`, then the user typed
    // `/effort medium`. The live level moved off its first report, so the
    // guard does not apply and the `max` column realigns it.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'max' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'max' }),
      liveEffort: 'medium',
      firstReportedEffort: 'high',
    });
    expect(plan?.restartReason).toBe('effort');
  });

  it('restarts once into a downgraded target the session was never launched at', () => {
    // The remaining cost: a session at `high` moved into a `max` column was
    // never asked for `max`, so nothing says the model would downgrade it. It
    // restarts once; the test above covers every move after that.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'max' }),
      liveEffort: 'high',
      firstReportedEffort: 'high',
    });
    expect(plan?.restartReason).toBe('effort');
  });

  it('reads applied_effort from the live session\'s own record, not the task\'s newest', () => {
    // The first report belongs to the task's live session, so the applied
    // level it is compared with must too. The task's newest record can be an
    // isolated track's, launched at something else.
    const sessionRepo = {
      getLatestForTask: () => ({ id: 'sess-isolated', applied_effort: 'low' }),
      findByAnyId: (id: string) => (id === 'sess-live' ? { id: 'sess-live', applied_effort: 'max' } : undefined),
    } as unknown as SessionRepository;
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo,
      task: { id: 't1', session_id: 'sess-live', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'max' }),
      liveEffort: 'high',
      firstReportedEffort: 'high',
    });
    expect(plan).toBeNull();
  });

  it('does not restart a downgraded session moved into a column asking for the level it runs at', () => {
    // Launched at `max`, running at `high`, moved into a `high` column. The
    // guard must not swap the live level for the applied one, or this would
    // read as max -> high and restart a session already at the target.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'max' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'high' }),
      liveEffort: 'high',
      firstReportedEffort: 'high',
    });
    expect(plan).toBeNull();
  });

  it('never lets live effort disturb the model delta', () => {
    // Model is deliberately not live-sourced: the agent reports a canonical id
    // while the configured values are flag strings, and a false "changed" here
    // would restart the PTY on every move. The effort delta restarts on its own
    // reason, and the model side stays unchanged.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
      liveEffort: 'medium',
    });
    expect(plan?.restartReason).toBe('effort');
    expect(planTexts(plan)).toEqual([]);
  });
});

describe('resolveSourceEffort', () => {
  it('prefers a per-task pin, then live telemetry, then the record', () => {
    // The target differs from applied in every row, so the downgrade guard
    // stays out of the way and only the tier order is under test.
    const levels = { firstReportedEffort: null, targetEffort: 'max' };
    expect(resolveSourceEffort({ ...levels, taskEffortOverride: 'xhigh', liveEffort: 'low', appliedEffort: 'high' })).toBe('xhigh');
    expect(resolveSourceEffort({ ...levels, taskEffortOverride: null, liveEffort: 'low', appliedEffort: 'high' })).toBe('low');
    expect(resolveSourceEffort({ ...levels, taskEffortOverride: null, liveEffort: null, appliedEffort: 'high' })).toBe('high');
    expect(resolveSourceEffort({ ...levels, taskEffortOverride: null, liveEffort: null, appliedEffort: null })).toBeNull();
    expect(resolveSourceEffort({ ...levels, taskEffortOverride: undefined, liveEffort: null, appliedEffort: undefined })).toBeNull();
  });

  // applied = what the launch asked for, first = the agent's first report,
  // live = its report now, target = what the move or pick wants.
  it.each([
    ['a downgrade of the target, unmoved since launch', { applied: 'max', first: 'high', live: 'high', target: 'max' }, 'max', null],
    ['a downgraded session moved to the level it runs at', { applied: 'max', first: 'high', live: 'high', target: 'high' }, 'high', null],
    ['a manual /effort off the launch level', { applied: 'high', first: 'high', live: 'medium', target: 'high' }, 'medium', 'effort'],
    ['a manual /effort on a downgraded session', { applied: 'max', first: 'high', live: 'medium', target: 'max' }, 'medium', 'effort'],
    ['a target the session was never launched at', { applied: 'high', first: 'high', live: 'high', target: 'max' }, 'high', 'effort'],
    ['no live report, so the record decides', { applied: 'high', first: null, live: null, target: 'high' }, 'high', null],
    ['no live report and a different target', { applied: 'high', first: null, live: null, target: 'max' }, 'high', 'effort'],
    ['a null target (Default) never takes the guard', { applied: 'max', first: 'high', live: 'high', target: null }, 'high', null],
  ] as const)('resolves %s', (_label, levels, expectedSource, expectedRestart) => {
    const sourceEffort = resolveSourceEffort({
      taskEffortOverride: null,
      liveEffort: levels.live,
      firstReportedEffort: levels.first,
      appliedEffort: levels.applied,
      targetEffort: levels.target,
    });
    expect(sourceEffort).toBe(expectedSource);
    expect(resolveRestartReason({
      sourceModel: 'opus',
      targetModel: 'opus',
      sourceEffort,
      targetEffort: levels.target,
    })).toBe(expectedRestart);
  });

  it('keeps a per-task pin ahead of the downgrade guard', () => {
    expect(resolveSourceEffort({
      taskEffortOverride: 'low',
      liveEffort: 'high',
      firstReportedEffort: 'high',
      appliedEffort: 'max',
      targetEffort: 'max',
    })).toBe('low');
  });
});

describe('resolveTargetSettings', () => {
  // The TARGET side of a settings delta, shared by prepareInjectionPlan and the
  // ContextBar pick. Order: task pin, then lane, then the project default. The
  // project tier applies only when the RESOLVED agent (task, then lane, then
  // project, then the built-in default) is the project's default agent, since
  // model and effort ids are adapter-specific. Model and effort resolve
  // independently of each other.
  const noTaskPins = { agent_override: null, model_override: null, effort_override: null };
  const noLanePins = { agent_override: null, model_override: null, effort_override: null };

  it('prefers the task pin over the lane and the project default, per field', () => {
    expect(resolveTargetSettings({
      task: { ...noTaskPins, model_override: 'task-model' },
      lane: { ...noLanePins, model_override: 'lane-model', effort_override: 'lane-effort' },
      project: { default_agent: 'claude', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: 'task-model', targetEffort: 'lane-effort' });
  });

  it('prefers the lane over the project default when the task pins nothing', () => {
    expect(resolveTargetSettings({
      task: noTaskPins,
      lane: { ...noLanePins, model_override: 'lane-model' },
      project: { default_agent: 'claude', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: 'lane-model', targetEffort: 'project-effort' });
  });

  it('falls back to the project default when neither task nor lane pins a value', () => {
    expect(resolveTargetSettings({
      task: noTaskPins,
      lane: noLanePins,
      project: { default_agent: 'claude', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: 'project-model', targetEffort: 'project-effort' });
  });

  it('resolves to null when nothing is set anywhere, including a missing lane and project', () => {
    expect(resolveTargetSettings({ task: noTaskPins, lane: null, project: null }))
      .toEqual({ targetModel: null, targetEffort: null });
    expect(resolveTargetSettings({ task: noTaskPins, lane: undefined, project: undefined }))
      .toEqual({ targetModel: null, targetEffort: null });
  });

  it('applies a task or lane pin even when it names a different agent than the project default', () => {
    expect(resolveTargetSettings({
      task: { agent_override: 'codex', model_override: 'task-model', effort_override: null },
      lane: { ...noLanePins, effort_override: 'lane-effort' },
      project: { default_agent: 'claude', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: 'task-model', targetEffort: 'lane-effort' });
  });

  it('drops the project defaults when the TASK overrides the agent to a different one', () => {
    expect(resolveTargetSettings({
      task: { ...noTaskPins, agent_override: 'codex' },
      lane: noLanePins,
      project: { default_agent: 'claude', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: null, targetEffort: null });
  });

  it('drops the project defaults when the LANE overrides the agent to a different one', () => {
    expect(resolveTargetSettings({
      task: noTaskPins,
      lane: { ...noLanePins, agent_override: 'codex' },
      project: { default_agent: 'claude', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: null, targetEffort: null });
  });

  it('lets the task agent override beat the lane agent override when deciding whether the project tier applies', () => {
    // Task agent matches the project's, lane's does not: the task wins, so the
    // project defaults apply.
    expect(resolveTargetSettings({
      task: { ...noTaskPins, agent_override: 'claude' },
      lane: { ...noLanePins, agent_override: 'codex' },
      project: { default_agent: 'claude', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: 'project-model', targetEffort: 'project-effort' });
    // And the reverse: task agent differs, lane's matches, so they are dropped.
    expect(resolveTargetSettings({
      task: { ...noTaskPins, agent_override: 'codex' },
      lane: { ...noLanePins, agent_override: 'claude' },
      project: { default_agent: 'claude', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: null, targetEffort: null });
  });

  it('keeps the project defaults when an override names the project default agent itself', () => {
    expect(resolveTargetSettings({
      task: noTaskPins,
      lane: { ...noLanePins, agent_override: 'codex' },
      project: { default_agent: 'codex', default_model: 'project-model', default_effort: 'project-effort' },
    })).toEqual({ targetModel: 'project-model', targetEffort: 'project-effort' });
  });

  it('treats a project with no default agent as the built-in default agent (claude)', () => {
    const project = { default_agent: null, default_model: 'project-model', default_effort: 'project-effort' };
    expect(resolveTargetSettings({ task: noTaskPins, lane: noLanePins, project }))
      .toEqual({ targetModel: 'project-model', targetEffort: 'project-effort' });
    expect(resolveTargetSettings({ task: noTaskPins, lane: { ...noLanePins, agent_override: 'codex' }, project }))
      .toEqual({ targetModel: null, targetEffort: null });
  });
});

describe('resolveRestartReason and restartPhaseFor', () => {
  it.each([
    ['a model change to a concrete value', { sourceModel: 'sonnet', targetModel: 'opus', sourceEffort: 'high', targetEffort: 'high' }, 'model'],
    ['a model and effort change together (model wins)', { sourceModel: 'sonnet', targetModel: 'opus', sourceEffort: 'low', targetEffort: 'high' }, 'model'],
    ['an effort-only change to a concrete value', { sourceModel: 'opus', targetModel: 'opus', sourceEffort: 'low', targetEffort: 'high' }, 'effort'],
    ['a null target model with a changed concrete effort', { sourceModel: 'opus', targetModel: null, sourceEffort: 'low', targetEffort: 'high' }, 'effort'],
    ['null targets on both fields', { sourceModel: 'opus', targetModel: null, sourceEffort: 'high', targetEffort: null }, null],
    ['equal model and effort', { sourceModel: 'opus', targetModel: 'opus', sourceEffort: 'high', targetEffort: 'high' }, null],
  ] as const)('resolves %s', (_label, input, expected) => {
    expect(resolveRestartReason(input)).toBe(expected);
  });

  it('labels a model restart switching-model and an effort restart applying-settings', () => {
    expect(restartPhaseFor('model')).toBe('switching-model');
    expect(restartPhaseFor('effort')).toBe('applying-settings');
  });
});

describe('resolveReportedEffort', () => {
  const readerWith = (
    entries: Record<string, string | undefined>,
    firstReported: Record<string, string> = {},
  ) => ({
    getUsageCache: () => Object.fromEntries(
      Object.entries(entries).map(([id, effort]) => [
        id,
        { model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort } },
      ]),
    ) as never,
    getFirstReportedEffort: (sessionId: string) => firstReported[sessionId] ?? null,
  });

  it('reads the live and the first reported effort for the session', () => {
    expect(resolveReportedEffort(readerWith({ 's1': 'medium' }, { 's1': 'high' }), 's1'))
      .toEqual({ liveEffort: 'medium', firstReportedEffort: 'high' });
  });

  it('returns nulls for a session with no id, no cache entry, or no reported effort', () => {
    expect(resolveReportedEffort(readerWith({ 's1': 'medium' }, { 's1': 'medium' }), null))
      .toEqual({ liveEffort: null, firstReportedEffort: null });
    expect(resolveReportedEffort(readerWith({ 's1': 'medium' }), 'other'))
      .toEqual({ liveEffort: null, firstReportedEffort: null });
    expect(resolveReportedEffort(readerWith({ 's1': undefined }), 's1'))
      .toEqual({ liveEffort: null, firstReportedEffort: null });
  });
});

describe('buildCommandInjectionVerifier: poll-time id re-resolution (mid-burst /clear fork)', () => {
  // A /clear during an in-flight injection forks the live conversation to a
  // NEW agent session id; the live status-file reconcile updates the SAME
  // session record. The verifier must poll the record's CURRENT id (re-read by
  // primary key on every call), and when the id changed mid-burst, also accept
  // a match under the plan-build-time id - otherwise verification can never
  // confirm and the retry ladder fires stray Enters + a Ctrl+C into the live
  // session.

  interface VerifierCall {
    agentSessionId: string | undefined;
    cwd: string | undefined;
  }

  function makeVerifierHarness(options: {
    currentRecord: Partial<SessionRecord> | undefined;
    verifyResult: (call: VerifierCall) => boolean;
  }) {
    const calls: VerifierCall[] = [];
    const submissionVerifier = vi.fn(async (context: { agentSessionId?: string; cwd?: string }) => {
      const call = { agentSessionId: context.agentSessionId, cwd: context.cwd };
      calls.push(call);
      return options.verifyResult(call);
    });
    const adapter = fakeAdapter({
      getSubmissionVerifier: () => submissionVerifier,
    } as unknown as Partial<AgentAdapter>);
    const sessionRepo = {
      getLatestForTask: () => undefined,
      findByAnyId: vi.fn(() => options.currentRecord),
    } as unknown as SessionRepository;
    const buildTimeRecord = {
      id: 'rec-1',
      agent_session_id: 'pre-fork-id',
      cwd: '/worktree',
    } as SessionRecord;
    const verifier = buildCommandInjectionVerifier(adapter, sessionRepo, 't1', buildTimeRecord);
    return { verifier, calls, sessionRepo };
  }

  it('polls the record CURRENT id, not the plan-build-time capture', async () => {
    const { verifier, calls, sessionRepo } = makeVerifierHarness({
      currentRecord: { id: 'rec-1', agent_session_id: 'post-fork-id', cwd: '/worktree' },
      verifyResult: () => true,
    });

    await expect(verifier!('/effort high', 123, 'command-match')).resolves.toBe(true);
    expect(calls).toEqual([{ agentSessionId: 'post-fork-id', cwd: '/worktree' }]);
    // Re-resolved by PRIMARY KEY (never latest-for-task, which could shadow an
    // isolated session's sibling row).
    expect(sessionRepo.findByAnyId).toHaveBeenCalledWith('rec-1');
  });

  it('falls back to the plan-build-time id when the fork happened after the command landed', async () => {
    const { verifier, calls } = makeVerifierHarness({
      currentRecord: { id: 'rec-1', agent_session_id: 'post-fork-id', cwd: '/worktree' },
      verifyResult: (call) => call.agentSessionId === 'pre-fork-id',
    });

    await expect(verifier!('/effort high', 123, 'command-match')).resolves.toBe(true);
    expect(calls.map((call) => call.agentSessionId)).toEqual(['post-fork-id', 'pre-fork-id']);
  });

  it('does not double-poll when the id has not changed', async () => {
    const { verifier, calls } = makeVerifierHarness({
      currentRecord: { id: 'rec-1', agent_session_id: 'pre-fork-id', cwd: '/worktree' },
      verifyResult: () => false,
    });

    await expect(verifier!('/effort high', 123, 'command-match')).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('degrades to the captured id when the record cannot be re-read', async () => {
    const { verifier, calls } = makeVerifierHarness({
      currentRecord: undefined,
      verifyResult: () => true,
    });

    await expect(verifier!('/effort high', 123, 'command-match')).resolves.toBe(true);
    expect(calls).toEqual([{ agentSessionId: 'pre-fork-id', cwd: '/worktree' }]);
  });
});
