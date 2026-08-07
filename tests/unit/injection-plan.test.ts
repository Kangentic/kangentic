/**
 * Tests for prepareInjectionPlan - the central per-task helper that
 * task-move and SWIMLANE_UPDATE both use to translate column-level
 * model/effort/auto_command changes into a chained sequence (with the
 * right per-adapter verifier) for TerminalSubmitScheduler.scheduleKeystrokes to push onto the PTY.
 *
 * The whole point of this helper is to keep IPC handlers agent-agnostic.
 * These tests verify that:
 * - The delta SOURCE is the session's recorded applied_model / applied_effort
 *   (what it is actually running at), NOT the leaving column's config. A move
 *   into a column whose value the session already has injects nothing - this is
 *   the redundant-`/effort` bug the helper now avoids.
 * - Adapters without getInjectionSequence contribute no settings writes
 * - A MODEL change is never live-swapped here: prepareInjectionPlan passes
 *   `modelChanged: false` to the adapter (so no `/model` is emitted) and instead
 *   sets `needsRestartForModel` for the caller to suspend + respawn. A null
 *   ("Default") target is not a real change, so it never sets the flag.
 * - Adapters that DO implement getInjectionSequence own the EFFORT slash syntax
 *   (Claude returns `/effort Y`)
 * - The verifier is wired up only when the adapter declares one AND a
 *   captured agent_session_id is available
 * - auto_command is appended after settings writes and trimmed
 * - appliedSettings reports the new running effort for a concrete effort change
 */
import { describe, it, expect, vi } from 'vitest';
import { buildCommandInjectionVerifier, prepareInjectionPlan, resolveLiveEffort, resolveSourceEffort } from '../../src/main/transition-engine/injection-plan';
import type { AgentAdapter, SettingsChangeSpec } from '../../src/main/agent/agent-adapter';
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

  it('does not re-inject when the session already has the target value and there is no leaving-column reference', () => {
    // The reported bug: every column is xhigh, the session was spawned at xhigh
    // (applied_effort), and the move had a null leaving-column. The old code
    // diffed null vs xhigh and injected `/effort xhigh` redundantly. Diffing
    // against the recorded applied value yields no change.
    let capturedSpec: SettingsChangeSpec | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        capturedSpec = spec;
        const out: string[] = [];
        if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
        if (spec.effortChanged && spec.effort) out.push(`/effort ${spec.effort}`);
        return out;
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'xhigh' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: 'opus', effort_override: 'xhigh' }),
    });
    expect(capturedSpec).toMatchObject({ modelChanged: false, effortChanged: false });
    expect(plan).toBeNull();
  });

  it('injects once when the session runs at the agent default and the column pins a concrete value', () => {
    // applied_* null = the session was spawned with no --model/--effort flag
    // (agent default). Entering a configured column must live-switch it. This is
    // the legitimate case a naive "null source = no-op" guard would have wrongly
    // dropped.
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => (spec.effortChanged && spec.effort ? [`/effort ${spec.effort}`] : []),
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: 'xhigh' }),
    });
    expect(planTexts(plan)).toEqual(['/effort xhigh']);
    expect(plan?.appliedSettings).toEqual({ effort: 'xhigh' });
  });

  it('adapters without the hook contribute no live writes, but a model change still flags a restart', () => {
    const adapter = fakeAdapter({}); // no getInjectionSequence (e.g. Codex)
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
    });
    // No live writes (the adapter has no slash), but the concrete model change
    // (default -> opus) flags a restart for the caller. Plan is non-null so the
    // caller can act on it.
    expect(plan).not.toBeNull();
    expect(planTexts(plan)).toEqual([]);
    expect(plan?.needsRestartForModel).toBe(true);
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

  it('passes modelChanged: false to the adapter (model never live-swapped) but flags needsRestartForModel', () => {
    let capturedSpec: SettingsChangeSpec | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        capturedSpec = spec;
        return ['/x'];
      },
    });
    // Session running at haiku/low; destination column is opus/low.
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'haiku', applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus', effort_override: 'low' }),
    });
    // The model DID change (haiku -> opus), but the adapter is always told
    // modelChanged: false so it never emits a live `/model`. The real change
    // surfaces as needsRestartForModel for the caller to suspend + respawn.
    expect(capturedSpec).toEqual({
      model: 'opus',
      modelChanged: false,
      effort: 'low',
      effortChanged: false,
    });
    expect(plan?.needsRestartForModel).toBe(true);
  });

  it('a model change emits no slash, sets needsRestartForModel, and records no appliedSettings', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        const out: string[] = [];
        // Mirrors Claude: only effort is live-swappable. modelChanged is always
        // false from prepareInjectionPlan, so this never pushes a `/model`.
        if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
        if (spec.effortChanged && spec.effort) out.push(`/effort ${spec.effort}`);
        return out;
      },
    });
    // model changes haiku -> opus (restart); effort stays high (no change).
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'haiku', applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
    });
    // Non-null plan even with an empty sequence, so the caller can restart.
    expect(plan).not.toBeNull();
    expect(planTexts(plan)).toEqual([]);
    expect(plan?.needsRestartForModel).toBe(true);
    // Model is applied by the respawn flag, not recorded here; effort unchanged.
    expect(plan?.appliedSettings).toBeUndefined();
  });

  it('concrete->null target: model field is NOT recorded in appliedSettings when the destination is null (Default)', () => {
    // Gap 5: when the session is running at 'opus' but the destination column has no
    // model_override (null = "Default"), the adapter emits no `/model` slash (there is
    // no `/model <agent-default>` slash command). Because no slash was emitted, the
    // applied_model should NOT be overwritten with null in the DB - the session keeps
    // running at opus until the user explicitly picks something. Concretely,
    // plan.appliedSettings must not include a `model` key.
    //
    // The plan is still non-null because the effort field changes (low -> xhigh).
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        const out: string[] = [];
        // model: no slash when target is null (no concrete value to set)
        if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
        if (spec.effortChanged && spec.effort) out.push(`/effort ${spec.effort}`);
        return out;
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      // model_override: null = "Default" column (no concrete model)
      // effort_override: 'xhigh' = a real change that produces a slash
      toLane: lane({ model_override: null, effort_override: 'xhigh' }),
    });
    // The plan is non-null because effort changed.
    expect(plan).not.toBeNull();
    expect(planTexts(plan)).toEqual(['/effort xhigh']);
    // model changed (opus -> null) but a null ("Default") target is not a real
    // change: no restart, and model is ABSENT from appliedSettings. Only the
    // concrete effort change is recorded.
    expect(plan?.needsRestartForModel).toBe(false);
    expect(plan?.appliedSettings).toEqual({ effort: 'xhigh' });
    expect(plan?.appliedSettings).not.toHaveProperty('model');
  });

  it('appends a trimmed auto_command after the adapter-supplied settings commands', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/model opus'],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'haiku' }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus' }),
      autoCommand: '   review the diff   ',
    });
    expect(planTexts(plan)).toEqual(['/model opus', 'review the diff']);
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
    // appliedSettings is absent: no settings field changed to a concrete value.
    expect(plan).toEqual({
      sequence: [{ text: 'do thing', verify: 'submitted' }],
      verifier: null,
      needsRestartForModel: false,
    });
  });

  it('verifies the auto_command itself, under the weaker submitted mode', () => {
    // This is the hole the rebuild closes. A single `verifiedPrefixLength`
    // could express only ONE semantic for a whole burst, so the trailing user
    // auto_command - the thing users actually care about - was excluded from
    // verification entirely and settled on a fixed timer. Per-command modes
    // let the settings writes keep strict command-matching while the user's
    // command is checked for the weaker, always-answerable question: did
    // exactly this text get submitted?
    const adapter = fakeAdapter({
      getInjectionSequence: () => ['/model opus', '/effort high'],
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
      autoCommand: '/review --strict',
    });
    expect(plan?.sequence).toEqual([
      { text: '/model opus', verify: 'command-match' },
      { text: '/effort high', verify: 'command-match' },
      { text: '/review --strict', verify: 'submitted' },
    ]);
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
      needsRestartForModel: false,
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
    await plan!.verifier!('/model opus', testSentAt);

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

  it('flags needsRestartForModel when the session has no applied_model but the project sets a default', () => {
    const adapter = fakeAdapter({});
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: null }),
      project: { default_model: 'opus', default_effort: null },
    });
    expect(plan).not.toBeNull();
    expect(plan?.needsRestartForModel).toBe(true);
  });

  it('no spurious effort injection: session applied_effort already equals the project default, override-less lane', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => (spec.effortChanged && spec.effort ? [`/effort ${spec.effort}`] : []),
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: null }),
      project: { default_model: null, default_effort: 'high' },
    });
    // effort source (project default 'high') === target (project default 'high') -> no delta, no plan.
    expect(plan).toBeNull();
  });

  it('injects /effort when the session has no applied_effort but the project sets a default', () => {
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => (spec.effortChanged && spec.effort ? [`/effort ${spec.effort}`] : []),
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: null, applied_effort: null }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: null, effort_override: null }),
      project: { default_model: null, default_effort: 'high' },
    });
    expect(planTexts(plan)).toEqual(['/effort high']);
    expect(plan?.appliedSettings).toEqual({ effort: 'high' });
  });
});

describe('prepareInjectionPlan -- per-task override wins over column override', () => {
  // The ContextBar popover writes `tasks.model_override` / `tasks.effort_override`
  // and the user-confirmed semantic is "task override fully wins over column
  // override". The injection plan must respect this: if the task carries its
  // own override for a field, that field's source = target = task value, so the
  // delta is zero and no slash command fires for that field on column move.
  // Without this rule, every column transition would re-inject /model X /effort Y
  // and undo the user's pinned choice.

  it('does not emit /model when the task pins a model override (even if the column differs)', () => {
    let capturedSpec: SettingsChangeSpec | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        capturedSpec = spec;
        return spec.modelChanged ? [`/model ${spec.model}`] : [];
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      // The session was spawned at the pin (haiku applied is irrelevant: the pin
      // wins for both source and target).
      sessionRepo: sessionRepoWith({ applied_model: 'opus' }),
      task: { id: 't1', agent: 'fake', model_override: 'opus', effort_override: null },
      toLane: lane({ model_override: 'sonnet' }),
    });
    // Task pinned 'opus', so source=target='opus' -> modelChanged is false.
    expect(capturedSpec).toMatchObject({ model: 'opus', modelChanged: false });
    expect(plan).toBeNull();
  });

  it('does not emit /effort when the task pins an effort override (even if the column differs)', () => {
    let capturedSpec: SettingsChangeSpec | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        capturedSpec = spec;
        return spec.effortChanged ? [`/effort ${spec.effort}`] : [];
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_effort: 'xhigh' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: 'xhigh' },
      toLane: lane({ effort_override: 'high' }),
    });
    expect(capturedSpec).toMatchObject({ effort: 'xhigh', effortChanged: false });
    expect(plan).toBeNull();
  });

  it('does not emit /effort when a pinned effort differs from applied, column, and project defaults', () => {
    let capturedSpec: SettingsChangeSpec | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        capturedSpec = spec;
        return spec.effortChanged ? [`/effort ${spec.effort}`] : [];
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      // Source (applied), destination column, and project default are all
      // different from the pin - none of them may leak into the delta.
      sessionRepo: sessionRepoWith({ applied_effort: 'low' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: 'xhigh' },
      toLane: lane({ effort_override: 'high' }),
      project: { default_model: null, default_effort: 'medium' },
    });
    expect(capturedSpec).toMatchObject({ effort: 'xhigh', effortChanged: false });
    expect(plan).toBeNull();
  });

  it('restarts for a model change while a pinned effort fires no slash (mixed override)', () => {
    let capturedSpec: SettingsChangeSpec | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        capturedSpec = spec;
        const out: string[] = [];
        if (spec.modelChanged && spec.model) out.push(`/model ${spec.model}`);
        if (spec.effortChanged && spec.effort) out.push(`/effort ${spec.effort}`);
        return out;
      },
    });
    // Session running at haiku/xhigh; effort pinned xhigh; column moves model to opus.
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'haiku', applied_effort: 'xhigh' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: 'xhigh' },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
    });
    // model: applied haiku -> column opus is a real change, but it restarts
    // (modelChanged is forced false to the adapter, so no `/model` slash).
    // effort: task-pinned xhigh wins, no slash fires.
    expect(capturedSpec).toMatchObject({
      model: 'opus',
      modelChanged: false,
      effort: 'xhigh',
      effortChanged: false,
    });
    expect(planTexts(plan)).toEqual([]);
    expect(plan?.needsRestartForModel).toBe(true);
  });

  it('flags needsRestartForModel by diffing against the session applied value (no per-task override)', () => {
    let capturedSpec: SettingsChangeSpec | null = null;
    const adapter = fakeAdapter({
      getInjectionSequence: (spec) => {
        capturedSpec = spec;
        return spec.modelChanged && spec.model ? [`/model ${spec.model}`] : [];
      },
    });
    const plan = prepareInjectionPlan({
      adapter,
      sessionRepo: sessionRepoWith({ applied_model: 'haiku' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: 'opus' }),
    });
    // The adapter is told modelChanged: false, but the real haiku -> opus delta
    // (against the session's applied value) drives the restart flag.
    expect(capturedSpec).toMatchObject({ model: 'opus', modelChanged: false });
    expect(plan?.needsRestartForModel).toBe(true);
  });
});

/**
 * `applied_effort` records what Kangentic ASKED for at spawn/resume/live-switch.
 * An `/effort` the user types straight into the terminal never reaches it, so on
 * its own it goes stale and the delta is computed against a value the session
 * stopped running at. The agent's own reported level is preferred as the source.
 */
describe('prepareInjectionPlan - agent-reported effort is the delta source', () => {
  const claudeLike = () => fakeAdapter({
    // Mirrors ClaudeAdapter.getInjectionSequence.
    getInjectionSequence: (spec: SettingsChangeSpec) => {
      const sequence: string[] = [];
      if (spec.modelChanged && spec.model) sequence.push(`/model ${spec.model}`);
      if (spec.effortChanged && spec.effort) sequence.push(`/effort ${spec.effort}`);
      return sequence;
    },
  });

  it('THE BUG: a manual /effort the record never saw no longer suppresses the injection', () => {
    // applied=high (what we asked for at spawn), agent reports medium (the user
    // typed `/effort medium`), destination column requires high. Before this,
    // source and target both read high, effortChanged was false, nothing was
    // injected, and the session silently kept running at medium.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'high' }),
      liveEffort: 'medium',
    });
    expect(planTexts(plan)).toEqual(['/effort high']);
    expect(plan?.appliedSettings).toEqual({ effort: 'high' });
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

  it('ACCEPTED TRADE: a silently downgraded level re-asserts the configured target on each move', () => {
    // Claude Code silently downgrades `max`/`xhigh` to `high` on a model that
    // does not support them, and its status schema documents the reported level
    // as the one in force "after any silent downgrade for the selected model".
    // So live can legitimately differ from what we asked for, and that is
    // indistinguishable from the user having typed `/effort high` by hand.
    // We favour correctness: re-assert the target. Never a restart - but the
    // cost is more than one idempotent slash. The live tier outranks
    // `applied_effort`, and the agent's reported level never becomes the target,
    // so the delta never clears: it re-fires on EVERY qualifying move rather
    // than converging after the first. And a live-injection burst leads with
    // Ctrl+C (`terminal-submit-scheduler.ts` passes `sendCtrlC: !freshlySpawned`,
    // `terminal-submit.ts` writes `\x03` before the first command), so each
    // re-assertion interrupts the agent's current turn.
    // Do NOT "fix" this by dropping the live tier - that reintroduces the bug
    // the sibling tests above pin. Converging needs an emit-side guard that can
    // tell "we already asked this session for this target and its reported level
    // has not moved since" apart from a genuine manual `/effort`.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_effort: 'max' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ effort_override: 'max' }),
      liveEffort: 'high',
    });
    expect(planTexts(plan)).toEqual(['/effort max']);
  });

  it('never lets live effort disturb the model delta', () => {
    // Model is deliberately not live-sourced: the agent reports a canonical id
    // while the configured values are flag strings, and a false "changed" here
    // would restart the PTY on every move.
    const plan = prepareInjectionPlan({
      adapter: claudeLike(),
      sessionRepo: sessionRepoWith({ applied_model: 'opus', applied_effort: 'high' }),
      task: { id: 't1', agent: 'fake', model_override: null, effort_override: null },
      toLane: lane({ model_override: 'opus', effort_override: 'high' }),
      liveEffort: 'medium',
    });
    expect(plan?.needsRestartForModel).toBe(false);
    expect(planTexts(plan)).toEqual(['/effort high']);
  });
});

describe('resolveSourceEffort', () => {
  it('prefers a per-task pin, then live telemetry, then the record', () => {
    expect(resolveSourceEffort({ taskEffortOverride: 'xhigh', liveEffort: 'low', appliedEffort: 'high' })).toBe('xhigh');
    expect(resolveSourceEffort({ taskEffortOverride: null, liveEffort: 'low', appliedEffort: 'high' })).toBe('low');
    expect(resolveSourceEffort({ taskEffortOverride: null, liveEffort: null, appliedEffort: 'high' })).toBe('high');
    expect(resolveSourceEffort({ taskEffortOverride: null, liveEffort: null, appliedEffort: null })).toBeNull();
    expect(resolveSourceEffort({ taskEffortOverride: undefined, liveEffort: undefined, appliedEffort: undefined })).toBeNull();
  });
});

describe('resolveLiveEffort', () => {
  const cacheWith = (entries: Record<string, string | undefined>) => ({
    getUsageCache: () => Object.fromEntries(
      Object.entries(entries).map(([id, effort]) => [
        id,
        { model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort } },
      ]),
    ) as never,
  });

  it('reads the reported effort for the session', () => {
    expect(resolveLiveEffort(cacheWith({ 's1': 'medium' }), 's1')).toBe('medium');
  });

  it('returns null for a session with no id, no cache entry, or no reported effort', () => {
    expect(resolveLiveEffort(cacheWith({ 's1': 'medium' }), null)).toBeNull();
    expect(resolveLiveEffort(cacheWith({ 's1': 'medium' }), 'other')).toBeNull();
    expect(resolveLiveEffort(cacheWith({ 's1': undefined }), 's1')).toBeNull();
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

    await expect(verifier!('/effort high', 123)).resolves.toBe(true);
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

    await expect(verifier!('/effort high', 123)).resolves.toBe(true);
    expect(calls.map((call) => call.agentSessionId)).toEqual(['post-fork-id', 'pre-fork-id']);
  });

  it('does not double-poll when the id has not changed', async () => {
    const { verifier, calls } = makeVerifierHarness({
      currentRecord: { id: 'rec-1', agent_session_id: 'pre-fork-id', cwd: '/worktree' },
      verifyResult: () => false,
    });

    await expect(verifier!('/effort high', 123)).resolves.toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('degrades to the captured id when the record cannot be re-read', async () => {
    const { verifier, calls } = makeVerifierHarness({
      currentRecord: undefined,
      verifyResult: () => true,
    });

    await expect(verifier!('/effort high', 123)).resolves.toBe(true);
    expect(calls).toEqual([{ agentSessionId: 'pre-fork-id', cwd: '/worktree' }]);
  });
});
