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
import { describe, it, expect } from 'vitest';
import { prepareInjectionPlan } from '../../src/main/transition-engine/injection-plan';
import type { AgentAdapter, SettingsChangeSpec } from '../../src/main/agent/agent-adapter';
import type { SessionRepository } from '../../src/main/db/repositories/session-repository';
import type { SessionRecord, Swimlane } from '../../src/shared/types';

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
    expect(plan?.sequence).toEqual(['/effort xhigh']);
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
    expect(plan?.sequence).toEqual([]);
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
    expect(plan?.sequence).toEqual([]);
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
    expect(plan?.sequence).toEqual(['/effort xhigh']);
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
    expect(plan?.sequence).toEqual(['/model opus', 'review the diff']);
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
    // verifiedPrefixLength = 0 because settings sequence is empty.
    // The auto_command sits at index 0 and is fire-and-forget.
    // appliedSettings is absent: no settings field changed to a concrete value.
    expect(plan).toEqual({ sequence: ['do thing'], verifier: null, verifiedPrefixLength: 0, needsRestartForModel: false });
  });

  it('verifiedPrefixLength excludes the trailing auto_command so it stays fire-and-forget', () => {
    // The whole point of the prefix split: a `/`-prefixed user auto_command
    // must NOT be subjected to verification (it might not produce a JSONL
    // entry the verifier recognizes, and retry exhaustion would drop it).
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
    expect(plan?.sequence).toEqual(['/model opus', '/effort high', '/review --strict']);
    // First two (settings) are verified; auto_command is not.
    expect(plan?.verifiedPrefixLength).toBe(2);
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

  it('verifier is null when no session record has a captured agent_session_id', () => {
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
    expect(plan?.verifier).toBeNull();
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
    expect(plan).toEqual({ sequence: ['fallback'], verifier: null, verifiedPrefixLength: 0, needsRestartForModel: false });
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
    expect(plan?.sequence).toEqual(['/effort high']);
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
    expect(plan?.sequence).toEqual([]);
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
