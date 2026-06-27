import { describe, it, expect } from 'vitest';
import {
  isDirty,
  hasOverride,
  isNewDraftId,
  buildUpdateInput,
  buildCreateInput,
} from '../../src/renderer/components/dialogs/BoardManagerDialog';
import type { Swimlane } from '../../src/shared/types';

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-1',
    name: 'Code Review',
    description: null,
    role: null,
    position: 2,
    color: '#3b82f6',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: '',
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    created_at: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isNewDraftId', () => {
  it('returns true for the temporary "new:" prefix', () => {
    expect(isNewDraftId('new:abc-123')).toBe(true);
  });

  it('returns false for persisted ids', () => {
    expect(isNewDraftId('lane-1')).toBe(false);
    expect(isNewDraftId('todo')).toBe(false);
  });
});

describe('isDirty', () => {
  it('returns false when draft equals original', () => {
    const original = makeSwimlane();
    const draft = makeSwimlane();
    expect(isDirty(draft, original)).toBe(false);
  });

  it('returns true when draft differs from original', () => {
    const original = makeSwimlane({ name: 'Code Review' });
    const draft = makeSwimlane({ name: 'Reviews' });
    expect(isDirty(draft, original)).toBe(true);
  });

  it('returns true when original is undefined (a brand new draft)', () => {
    const draft = makeSwimlane();
    expect(isDirty(draft, undefined)).toBe(true);
  });

  it('detects changes deep inside the row', () => {
    const original = makeSwimlane({ permission_mode: null });
    const draft = makeSwimlane({ permission_mode: 'plan' });
    expect(isDirty(draft, original)).toBe(true);
  });
});

describe('hasOverride', () => {
  // Currently always returns false - the override dot was dropped from the
  // section nav because its semantics ended up too fuzzy. Per-field Reset
  // buttons cover the same information unambiguously inside each section.
  // The export is kept so a future revival has a stable contract.
  it('returns false for every section regardless of draft state', () => {
    const variants = [
      makeSwimlane(),
      makeSwimlane({ name: 'Renamed', color: '#ff0000', icon: 'pencil' }),
      makeSwimlane({ permission_mode: 'plan' }),
      makeSwimlane({ agent_override: 'codex' }),
      makeSwimlane({ model_override: 'gpt-5' }),
      makeSwimlane({ effort_override: 'high' }),
      makeSwimlane({ auto_command: '/review' }),
      makeSwimlane({ handoff_context: true }),
    ];
    for (const draft of variants) {
      for (const section of ['general', 'agent', 'auto', 'handoff'] as const) {
        expect(hasOverride(draft, section)).toBe(false);
      }
    }
  });
});

describe('buildUpdateInput', () => {
  it('forwards all fields for a custom column', () => {
    const original = makeSwimlane();
    const draft = makeSwimlane({
      name: '  Renamed  ',
      description: '  Documents the column  ',
      color: '#ff0000',
      icon: 'pencil',
      permission_mode: 'plan',
      auto_spawn: false,
      auto_command: '  /review  ',
      plan_exit_target_id: 'tests',
      agent_override: 'codex',
      model_override: '  gpt-5  ',
      effort_override: 'high',
      handoff_context: true,
    });
    const input = buildUpdateInput(draft, original);
    expect(input).toEqual({
      id: 'lane-1',
      name: 'Renamed',
      description: 'Documents the column',
      color: '#ff0000',
      icon: 'pencil',
      permission_mode: 'plan',
      auto_spawn: false,
      auto_command: '/review',
      plan_exit_target_id: 'tests',
      agent_override: 'codex',
      model_override: 'gpt-5',
      effort_override: 'high',
      handoff_context: true,
    });
  });

  it('strips agent fields for role-pinned columns (todo)', () => {
    const original = makeSwimlane({ id: 'todo', role: 'todo' });
    const draft = makeSwimlane({
      id: 'todo',
      role: 'todo',
      name: 'Backlog',
      permission_mode: 'plan',
      auto_command: '/should-be-stripped',
      handoff_context: true,
      agent_override: 'codex',
    });
    const input = buildUpdateInput(draft, original);
    expect(input.permission_mode).toBeUndefined();
    expect(input.auto_spawn).toBeUndefined();
    expect(input.auto_command).toBeUndefined();
    expect(input.agent_override).toBeUndefined();
    expect(input.model_override).toBeUndefined();
    expect(input.effort_override).toBeUndefined();
    expect(input.handoff_context).toBeUndefined();
    // General fields still flow through.
    expect(input.name).toBe('Backlog');
  });

  it('omits plan_exit_target_id when permission_mode is not plan', () => {
    const original = makeSwimlane();
    const draft = makeSwimlane({ permission_mode: null, plan_exit_target_id: 'tests' });
    expect(buildUpdateInput(draft, original).plan_exit_target_id).toBeUndefined();
  });

  it('coerces empty strings to null on save', () => {
    const draft = makeSwimlane({
      auto_command: '   ',
      agent_override: '',
      model_override: '',
      effort_override: '',
    });
    const input = buildUpdateInput(draft, makeSwimlane());
    expect(input.auto_command).toBeNull();
    expect(input.agent_override).toBeNull();
    expect(input.model_override).toBeNull();
    expect(input.effort_override).toBeNull();
  });
});

describe('buildCreateInput', () => {
  it('produces a SwimlaneCreateInput from a new draft', () => {
    const draft = makeSwimlane({
      id: 'new:abc',
      name: 'New stage',
      color: '#10b981',
      permission_mode: 'plan',
      plan_exit_target_id: 'review',
      auto_command: '/start',
      handoff_context: true,
    });
    const input = buildCreateInput(draft);
    expect(input.name).toBe('New stage');
    expect(input.color).toBe('#10b981');
    expect(input.permission_mode).toBe('plan');
    expect(input.plan_exit_target_id).toBe('review');
    expect(input.auto_command).toBe('/start');
    expect(input.handoff_context).toBe(true);
  });

  it('coerces empty auto_command to null', () => {
    const draft = makeSwimlane({ id: 'new:abc', auto_command: '' });
    expect(buildCreateInput(draft).auto_command).toBeNull();
  });

  it('omits plan_exit_target_id when not in plan mode', () => {
    const draft = makeSwimlane({ id: 'new:abc', permission_mode: null, plan_exit_target_id: 'tests' });
    expect(buildCreateInput(draft).plan_exit_target_id).toBeUndefined();
  });
});
