/**
 * Unit coverage for deriveOnboardingProgress, the pure five-step derivation the
 * onboarding checklist renders from, plus the two resolvers it depends on.
 * Exported directly from useOnboardingProgress.ts (not hook-private), so no jsdom /
 * React rendering is needed here - see use-browser-url-logic.test.ts for why this
 * repo's vitest config avoids that.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveOnboardingProgress,
  buildSwimlaneSignature,
  resolveAutoSpawnLane,
  type OnboardingDefaults,
} from '../../src/renderer/hooks/useOnboardingProgress';
import { resolveNextStep } from '../../src/renderer/components/onboarding/walkthrough-steps';
import type { OnboardingBaseline, OnboardingStepKey, Task, Swimlane } from '../../src/shared/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    display_id: 1,
    title: 'Untitled',
    description: '',
    swimlane_id: 'lane-todo',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    head_sha: null,
    external_id: null,
    external_source: null,
    external_url: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    model_override: null,
    effort_override: null,
    agent_override: null,
    permission_mode: null,
    auto_command: null,
    profile_id: null,
    attachment_count: 0,
    detail_view_state: null,
    archived_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-todo',
    name: 'To Do',
    description: null,
    role: 'todo',
    position: 0,
    color: '#6b7280',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: false,
    auto_command: null,
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const TODO = makeSwimlane({ id: 'lane-todo', name: 'To Do', role: 'todo', auto_spawn: false });
const PLANNING = makeSwimlane({
  id: 'lane-planning',
  name: 'Planning',
  role: null,
  position: 1,
  auto_spawn: true,
  permission_mode: 'plan',
});
const EXECUTING = makeSwimlane({
  id: 'lane-executing',
  name: 'Executing',
  role: null,
  position: 2,
  auto_spawn: true,
});

const SEED_LANES = [TODO, PLANNING, EXECUTING];

const DEFAULTS: OnboardingDefaults = {
  defaultAgent: 'claude',
  defaultModel: null,
  defaultEffort: null,
  permissionMode: 'acceptEdits',
};

/** A baseline that matches DEFAULTS + SEED_LANES exactly, i.e. an untouched project. */
const UNTOUCHED_BASELINE: OnboardingBaseline = {
  ...DEFAULTS,
  swimlaneSignature: buildSwimlaneSignature(SEED_LANES),
};

describe('buildSwimlaneSignature', () => {
  it('changes when a column is renamed, recolored, or given a different icon', () => {
    const base = buildSwimlaneSignature(SEED_LANES);
    expect(buildSwimlaneSignature([TODO, { ...PLANNING, name: 'Plan' }, EXECUTING])).not.toBe(base);
    expect(buildSwimlaneSignature([TODO, { ...PLANNING, color: '#ff0000' }, EXECUTING])).not.toBe(base);
    expect(buildSwimlaneSignature([TODO, { ...PLANNING, icon: 'rocket' }, EXECUTING])).not.toBe(base);
  });

  it('changes when a column is added or removed', () => {
    const base = buildSwimlaneSignature(SEED_LANES);
    expect(buildSwimlaneSignature([TODO, PLANNING])).not.toBe(base);
    expect(buildSwimlaneSignature([...SEED_LANES, makeSwimlane({ id: 'lane-new', name: 'QA', position: 3 })]))
      .not.toBe(base);
  });

  it('changes when columns are reordered', () => {
    const reordered = [
      { ...TODO, position: 0 },
      { ...EXECUTING, position: 1 },
      { ...PLANNING, position: 2 },
    ];
    expect(buildSwimlaneSignature(reordered)).not.toBe(buildSwimlaneSignature(SEED_LANES));
  });

  it('is STABLE when positions are renumbered but the order is unchanged', () => {
    // The false-tick guard. Board writes renumber positions (collapsing gaps, or
    // rewriting every row on an unrelated save) with no user edit behind it. Hashing
    // the raw position would flip the signature and wrongly tick "Shape your board".
    const renumbered = [
      { ...TODO, position: 0 },
      { ...PLANNING, position: 10 },
      { ...EXECUTING, position: 20 },
    ];
    expect(buildSwimlaneSignature(renumbered)).toBe(buildSwimlaneSignature(SEED_LANES));
  });

  it('ignores ghost and archived lanes, which the user did not shape', () => {
    const withNoise = [
      ...SEED_LANES,
      makeSwimlane({ id: 'lane-ghost', name: 'Ghost', position: 9, is_ghost: true }),
      makeSwimlane({ id: 'lane-old', name: 'Archived', position: 8, is_archived: true }),
    ];
    expect(buildSwimlaneSignature(withNoise)).toBe(buildSwimlaneSignature(SEED_LANES));
  });
});

describe('resolveAutoSpawnLane', () => {
  it('prefers the plan-mode lane over other agent-starting lanes', () => {
    expect(resolveAutoSpawnLane(SEED_LANES)?.id).toBe('lane-planning');
  });

  it('resolves a RENAMED plan column, since step 2 invites exactly that rename', () => {
    const renamed = [TODO, { ...PLANNING, name: 'Design first' }, EXECUTING];
    const lane = resolveAutoSpawnLane(renamed);
    expect(lane?.id).toBe('lane-planning');
    expect(lane?.name).toBe('Design first');
  });

  it('falls back to the first agent-starting lane when none is plan-mode', () => {
    expect(resolveAutoSpawnLane([TODO, EXECUTING])?.id).toBe('lane-executing');
  });

  it('returns null when no column starts an agent', () => {
    expect(resolveAutoSpawnLane([TODO])).toBeNull();
  });
});

describe('resolveNextStep', () => {
  const nothingDone: Record<OnboardingStepKey, boolean> = {
    defaultsChosen: false,
    boardShaped: false,
    taskCreated: false,
    draggedToAutoSpawnLane: false,
    taskDetailOpened: false,
  };

  it('starts at the first step when nothing has been done', () => {
    expect(resolveNextStep(nothingDone, null)?.key).toBe('defaultsChosen');
  });

  it('takes the one after the current step', () => {
    expect(resolveNextStep(nothingDone, 'defaultsChosen')?.key).toBe('boardShaped');
  });

  it('skips steps already done rather than re-offering them', () => {
    const progress = { ...nothingDone, boardShaped: true, taskCreated: true };
    expect(resolveNextStep(progress, 'defaultsChosen')?.key).toBe('draggedToAutoSpawnLane');
  });

  it('wraps to an earlier unfinished step instead of claiming the flow is over', () => {
    // Someone who took the steps out of order and finished on the last one still has work
    // left; telling them they are done would strand it.
    const progress = { ...nothingDone, taskCreated: true, draggedToAutoSpawnLane: true, taskDetailOpened: true };
    expect(resolveNextStep(progress, 'taskDetailOpened')?.key).toBe('defaultsChosen');
  });

  it('returns null only when every step is done', () => {
    const allDone: Record<OnboardingStepKey, boolean> = {
      defaultsChosen: true,
      boardShaped: true,
      taskCreated: true,
      draggedToAutoSpawnLane: true,
      taskDetailOpened: true,
    };
    expect(resolveNextStep(allDone, 'draggedToAutoSpawnLane')).toBeNull();
  });
});

describe('deriveOnboardingProgress', () => {
  it('reports nothing done for a freshly created project', () => {
    expect(deriveOnboardingProgress([], SEED_LANES, UNTOUCHED_BASELINE, DEFAULTS)).toEqual({
      defaultsChosen: false,
      boardShaped: false,
      taskCreated: false,
      draggedToAutoSpawnLane: false,
      taskDetailOpened: false,
      doneCount: 0,
      complete: false,
    });
  });

  it('treats a MISSING baseline as not-yet-configured, never as complete', () => {
    // A project that predates the feature has no baseline. Steps 1 and 2 must read as
    // outstanding work rather than silently claiming credit the user never earned.
    const progress = deriveOnboardingProgress([], SEED_LANES, undefined, DEFAULTS);
    expect(progress.defaultsChosen).toBe(false);
    expect(progress.boardShaped).toBe(false);
  });

  it.each([
    ['agent', { defaultAgent: 'codex' }],
    ['model', { defaultModel: 'opus' }],
    ['effort', { defaultEffort: 'high' }],
    ['permission mode', { permissionMode: 'plan' as const }],
  ])('ticks step 1 when the default %s changes', (_label, change) => {
    const progress = deriveOnboardingProgress(
      [], SEED_LANES, UNTOUCHED_BASELINE, { ...DEFAULTS, ...change },
    );
    expect(progress.defaultsChosen).toBe(true);
  });

  it('does NOT tick step 1 when the settings screen was merely opened and closed', () => {
    const progress = deriveOnboardingProgress([], SEED_LANES, UNTOUCHED_BASELINE, DEFAULTS);
    expect(progress.defaultsChosen).toBe(false);
  });

  it('ticks step 2 when the board no longer matches the shape captured at creation', () => {
    const renamed = [TODO, { ...PLANNING, name: 'Design' }, EXECUTING];
    const progress = deriveOnboardingProgress([], renamed, UNTOUCHED_BASELINE, DEFAULTS);
    expect(progress.boardShaped).toBe(true);
  });

  it('ticks step 3 as soon as any task exists', () => {
    const progress = deriveOnboardingProgress([makeTask()], SEED_LANES, UNTOUCHED_BASELINE, DEFAULTS);
    expect(progress.taskCreated).toBe(true);
    expect(progress.draggedToAutoSpawnLane).toBe(false);
  });

  it('ticks step 4 for a task in an agent-starting lane, even after that lane is renamed', () => {
    const renamed = [TODO, { ...PLANNING, name: 'Design first' }, EXECUTING];
    const progress = deriveOnboardingProgress(
      [makeTask({ swimlane_id: 'lane-planning' })], renamed, UNTOUCHED_BASELINE, DEFAULTS,
    );
    expect(progress.draggedToAutoSpawnLane).toBe(true);
  });

  it('counts all five independently and reports complete', () => {
    const shaped = [TODO, { ...PLANNING, name: 'Design' }, EXECUTING];
    const progress = deriveOnboardingProgress(
      [makeTask({ swimlane_id: 'lane-planning' })],
      shaped,
      UNTOUCHED_BASELINE,
      { ...DEFAULTS, defaultAgent: 'codex' },
      new Set(['taskDetailOpened']),
    );
    expect(progress.doneCount).toBe(5);
    expect(progress.complete).toBe(true);
  });

  it('ticks step 5 only once a task detail has been opened', () => {
    // A recorded signal, not a derived one - a task existing in an agent-starting lane is
    // step 4, and says nothing about whether the user ever opened it.
    const args = [
      [makeTask({ swimlane_id: 'lane-planning' })],
      SEED_LANES,
      UNTOUCHED_BASELINE,
      DEFAULTS,
    ] as const;
    expect(deriveOnboardingProgress(...args, new Set()).taskDetailOpened).toBe(false);
    expect(deriveOnboardingProgress(...args, new Set(['taskDetailOpened'])).taskDetailOpened).toBe(true);
  });

  it.each([
    'defaultsChosen',
    'boardShaped',
    'taskCreated',
    'draggedToAutoSpawnLane',
    'taskDetailOpened',
  ] as const)('ticks %s when the user takes it with "Next step" instead of doing it', (stepKey) => {
    // The checklist demonstrates the app, it does not gate it: pressing Next is a deliberate
    // act and counts. Every step accepts the manual route, so a user can walk all five.
    const progress = deriveOnboardingProgress(
      [], SEED_LANES, UNTOUCHED_BASELINE, DEFAULTS, new Set([stepKey]),
    );
    expect(progress[stepKey]).toBe(true);
    expect(progress.doneCount).toBe(1);
  });

  it('still ticks a step from the real thing, with nothing recorded', () => {
    // The manual route is OR-ed in, never a replacement: doing the work is the primary
    // signal and must keep working on its own.
    const progress = deriveOnboardingProgress(
      [makeTask({ swimlane_id: 'lane-planning' })], SEED_LANES, UNTOUCHED_BASELINE, DEFAULTS, new Set(),
    );
    expect(progress.taskCreated).toBe(true);
    expect(progress.draggedToAutoSpawnLane).toBe(true);
  });

  it('treats the steps as independent, not as sequential gates', () => {
    // A task dropped straight into an agent-starting lane satisfies step 4 without any
    // configuration having happened first.
    const progress = deriveOnboardingProgress(
      [makeTask({ swimlane_id: 'lane-executing' })], SEED_LANES, UNTOUCHED_BASELINE, DEFAULTS,
    );
    expect(progress.draggedToAutoSpawnLane).toBe(true);
    expect(progress.defaultsChosen).toBe(false);
    expect(progress.boardShaped).toBe(false);
  });

  it('reports nothing configured when there is no current project', () => {
    const progress = deriveOnboardingProgress([], SEED_LANES, UNTOUCHED_BASELINE, null);
    expect(progress.defaultsChosen).toBe(false);
  });

  it('does NOT tick step 2 for an empty (not-yet-loaded) board, even though its signature differs from the baseline', () => {
    // buildSwimlaneSignature([]) is necessarily != UNTOUCHED_BASELINE.swimlaneSignature (which
    // was built from SEED_LANES), so without the swimlanes.length > 0 guard this would read as
    // "the user reshaped their board" the instant the board store is empty mid-load.
    const progress = deriveOnboardingProgress([], [], UNTOUCHED_BASELINE, DEFAULTS);
    expect(progress.boardShaped).toBe(false);
    expect(progress.doneCount).toBe(0);
  });
});
