/**
 * The phone-side trust boundary for desktop-originated payloads: the wire
 * guards in events/payloads.ts + events/event.ts and the read-* response
 * parsers in wire/payloads.ts. Mirrors payloads.test.ts, which covers the
 * opposite direction (desktop validating phone-originated requests).
 */
import { describe, expect, it } from 'vitest';
import {
  isBridgeEvent,
  parseActivityEventPayload,
} from '../../../packages/protocol/src/events/event';
import {
  isActivityReasonWire,
  isDoneRole,
  isPermissionWaitKindWire,
  isTodoRole,
  parseActivityReasonWire,
  PERMISSION_WAIT_KINDS,
  parseBacklogItemWire,
  parseBoardColumnWire,
  parseBoardTaskWire,
  parseDiffFileContentWire,
  parseDiffFileListWire,
  parseSessionEventWire,
  parseSessionUsageWire,
  parseTerminalDimensionsWire,
  parseTranscriptEntriesWire,
  parseTranscriptEventPayload,
} from '../../../packages/protocol/src/events/payloads';
import {
  parseReadBoardResponsePayload,
  parseReadDiffResponsePayload,
  parseReadStreamResponsePayload,
  parsePauseSessionResponsePayload,
  parseStartSessionResponsePayload,
  parseTranscriptWindowResponsePayload,
  parseCommandTerminalStartResponsePayload,
  parseCommandTerminalEarlierResponsePayload,
} from '../../../packages/protocol/src/wire/payloads';
import type { JsonValue } from '../../../packages/protocol/src/wire/messages';

const usageFixture: JsonValue = {
  contextWindow: { usedPercentage: 42, usedTokens: 1000, cacheTokens: 500, totalInputTokens: 1500, totalOutputTokens: 300, contextWindowSize: 200000 },
  cost: { totalCostUsd: 1.25, totalDurationMs: 60000 },
  model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8' },
};

const boardTaskFixture: JsonValue = {
  id: 't-1',
  display_id: 7,
  title: 'Fix the bug',
  description: '',
  swimlane_id: 'lane-1',
  position: 0,
  agent: null,
  session_id: 'sess-1',
  worktree_path: null,
  branch_name: null,
  pr_number: null,
  pr_url: null,
  pr_state: null,
  pr_merge_readiness: null,
  base_branch: 'main',
  labels: ['bug'],
  priority: 1,
  attachment_count: 0,
  archived_at: null,
  created_at: '2026-07-13T00:00:00.000Z',
  updated_at: '2026-07-13T00:00:00.000Z',
  spawn_progress: null,
  resumable: false,
  paused: false,
  paused_session_id: null,
  pausable: true,
  automations_disabled: false,
  workflow: null,
};

const workflowFixture: JsonValue = {
  id: 'wf-1',
  title: 'Usage budgets',
  project_id: 'p-1',
  state: 'running',
  color_slot: 3,
  route: ['lane-2', 'lane-4'],
  waiting_for: ['#413'],
  lock_reason: '#7 is locked while Usage budgets runs.',
  gate_target_id: null,
  automations_pausable: true,
};

describe('parseTranscriptEntriesWire', () => {
  it('parses every entry kind', () => {
    const entries: JsonValue = [
      { kind: 'user', uuid: 'u-1', ts: 1, text: 'hello' },
      {
        kind: 'assistant',
        uuid: 'a-1',
        ts: 2,
        model: 'claude-opus-4-8',
        blocks: [
          { type: 'text', text: 'hi' },
          { type: 'thinking', text: 'hmm' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
        ],
      },
      { kind: 'tool_result', uuid: 'r-1', ts: 3, toolUseId: 'tool-1', content: 'ok', isError: false },
      { kind: 'system', uuid: 's-1', ts: 4, subtype: 'session_boundary', text: 'new session' },
    ];
    expect(parseTranscriptEntriesWire(entries)).toEqual(entries);
  });

  it('rejects a non-array payload', () => {
    expect(() => parseTranscriptEntriesWire({ entries: [] })).toThrow(/array/);
  });

  it('rejects an entry with an unknown kind', () => {
    expect(() => parseTranscriptEntriesWire([{ kind: 'note', uuid: 'x', ts: 1 }])).toThrow(/entry 0/);
  });

  it('rejects an assistant entry with a malformed block', () => {
    expect(() =>
      parseTranscriptEntriesWire([{ kind: 'assistant', uuid: 'a-1', ts: 1, blocks: [{ type: 'tool_use', name: 'Bash' }] }]),
    ).toThrow(/entry 0/);
  });

  it('rejects a system entry with an unknown subtype', () => {
    expect(() => parseTranscriptEntriesWire([{ kind: 'system', uuid: 's-1', ts: 1, subtype: 'banner', text: 'x' }])).toThrow(/entry 0/);
  });
});

describe('the permission wait kind', () => {
  it('isPermissionWaitKindWire accepts exactly the known kinds', () => {
    expect([...PERMISSION_WAIT_KINDS]).toEqual(['question', 'approval']);
    for (const kind of PERMISSION_WAIT_KINDS) expect(isPermissionWaitKindWire(kind)).toBe(true);
    expect(isPermissionWaitKindWire('unknown')).toBe(false);
    expect(isPermissionWaitKindWire(undefined)).toBe(false);
  });

  it('isActivityReasonWire stays strict about the kind; parseActivityReasonWire drops one it does not know', () => {
    const fromNewerDesktop = { kind: 'permission', since: 5, waitKind: 'future-kind' };
    expect(isActivityReasonWire(fromNewerDesktop)).toBe(false);
    expect(parseActivityReasonWire(fromNewerDesktop)).toStrictEqual({ kind: 'permission', since: 5 });
    expect(parseActivityReasonWire({ kind: 'permission', waitKind: 'question' })).toStrictEqual({ kind: 'permission', waitKind: 'question' });
  });

  it('parseActivityReasonWire still answers null for a malformed reason', () => {
    expect(parseActivityReasonWire({ kind: 'permission', since: 'soon', waitKind: 'future-kind' })).toBeNull();
    expect(parseActivityReasonWire({ kind: 'nope' })).toBeNull();
    expect(parseActivityReasonWire(null)).toBeNull();
  });
});

describe('parseActivityEventPayload', () => {
  it('parses an activity payload', () => {
    const payload: JsonValue = { type: 'activity', state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } };
    expect(parseActivityEventPayload(payload)).toEqual(payload);
  });

  it('parses idle/permission reasons carrying the optional since field', () => {
    const idlePayload: JsonValue = { type: 'activity', state: 'idle', reason: { kind: 'idle', since: 1700000000000 } };
    expect(parseActivityEventPayload(idlePayload)).toEqual(idlePayload);
    const permissionPayload: JsonValue = { type: 'activity', state: 'permission', reason: { kind: 'permission', since: 1700000000000 } };
    expect(parseActivityEventPayload(permissionPayload)).toEqual(permissionPayload);
  });

  it('parses idle/permission reasons with since OMITTED - additive-field compatibility with an older desktop', () => {
    const payload: JsonValue = { type: 'activity', state: 'idle', reason: { kind: 'idle' } };
    expect(parseActivityEventPayload(payload)).toEqual(payload);
  });

  it('rejects an idle/permission reason whose since is not a number', () => {
    expect(() => parseActivityEventPayload({ type: 'activity', state: 'idle', reason: { kind: 'idle', since: '1700000000000' } })).toThrow(/reason/);
  });

  it('carries a permission reason\'s known wait kind (protocol 0.26.0)', () => {
    for (const waitKind of PERMISSION_WAIT_KINDS) {
      const payload: JsonValue = { type: 'activity', state: 'permission', reason: { kind: 'permission', since: 1700000000000, waitKind } };
      expect(parseActivityEventPayload(payload)).toEqual(payload);
    }
  });

  it('drops a wait kind it does not know, and the event still parses', () => {
    // A newer desktop may add a kind: the event must not be lost for it.
    const parsed = parseActivityEventPayload({ type: 'activity', state: 'permission', reason: { kind: 'permission', since: 1700000000000, waitKind: 'future-kind' } });
    expect(parsed).toStrictEqual({ type: 'activity', state: 'permission', reason: { kind: 'permission', since: 1700000000000 } });
  });

  it('parses a usage payload', () => {
    expect(parseActivityEventPayload({ type: 'usage', usage: usageFixture })).toEqual({ type: 'usage', usage: usageFixture });
  });

  it('parses a session-event payload and drops unknown extras from the event', () => {
    const parsed = parseActivityEventPayload({ type: 'event', event: { ts: 5, type: 'tool_start', tool: 'Bash', costUsd: 0.1 } });
    expect(parsed).toEqual({ type: 'event', event: { ts: 5, type: 'tool_start', tool: 'Bash' } });
  });

  it('parses a permission payload', () => {
    const payload: JsonValue = { type: 'permission', promptId: 'sess-1:tool-1', pending: true };
    expect(parseActivityEventPayload(payload)).toEqual(payload);
  });

  it('parses a permission payload with option labels, preserving their keystroke order', () => {
    const payload: JsonValue = {
      type: 'permission',
      promptId: 'sess-1:tool-1',
      pending: true,
      options: ['Yes', "Yes, and don't ask again for this command", 'No, and tell Claude what to do differently'],
    };
    expect(parseActivityEventPayload(payload)).toEqual(payload);
  });

  it('a permission payload without options stays options-less (pre-0.6.0 desktop)', () => {
    const parsed = parseActivityEventPayload({ type: 'permission', promptId: 'sess-1:tool-1', pending: true });
    expect('options' in parsed).toBe(false);
  });

  it('rejects a permission payload with malformed options', () => {
    expect(() => parseActivityEventPayload({ type: 'permission', promptId: 'p', pending: true, options: 'Yes' })).toThrow(/options/);
    expect(() => parseActivityEventPayload({ type: 'permission', promptId: 'p', pending: true, options: [1, 2] })).toThrow(/options/);
    expect(() => parseActivityEventPayload({ type: 'permission', promptId: 'p', pending: true, options: ['Yes', null] })).toThrow(/options/);
    expect(() => parseActivityEventPayload({ type: 'permission', promptId: 'p', pending: true, options: null })).toThrow(/options/);
  });

  it('parses a session-ended payload with either intentional value', () => {
    expect(parseActivityEventPayload({ type: 'session-ended', intentional: true })).toEqual({ type: 'session-ended', intentional: true });
    expect(parseActivityEventPayload({ type: 'session-ended', intentional: false })).toEqual({ type: 'session-ended', intentional: false });
  });

  it('rejects a session-ended payload with a missing or non-boolean intentional', () => {
    expect(() => parseActivityEventPayload({ type: 'session-ended' })).toThrow(/intentional/);
    expect(() => parseActivityEventPayload({ type: 'session-ended', intentional: 'yes' })).toThrow(/intentional/);
    expect(() => parseActivityEventPayload({ type: 'session-ended', intentional: 0 })).toThrow(/intentional/);
  });

  it('parses a session-ended payload carrying a spawnProgressLabel', () => {
    const payload: JsonValue = { type: 'session-ended', intentional: true, spawnProgressLabel: 'Switching model...' };
    expect(parseActivityEventPayload(payload)).toEqual(payload);
  });

  it('a session-ended payload without spawnProgressLabel stays label-less (pre-0.14.0 desktop)', () => {
    const parsed = parseActivityEventPayload({ type: 'session-ended', intentional: true });
    expect('spawnProgressLabel' in parsed).toBe(false);
  });

  it('rejects a session-ended payload with a non-string spawnProgressLabel', () => {
    expect(() => parseActivityEventPayload({ type: 'session-ended', intentional: true, spawnProgressLabel: 42 })).toThrow(/spawnProgressLabel/);
    expect(() => parseActivityEventPayload({ type: 'session-ended', intentional: true, spawnProgressLabel: null })).toThrow(/spawnProgressLabel/);
  });

  it('parses a session-ended payload naming a successor, alone or with a label', () => {
    const successorOnly: JsonValue = { type: 'session-ended', intentional: true, successorSessionId: 'sess-2' };
    expect(parseActivityEventPayload(successorOnly)).toEqual(successorOnly);
    const both: JsonValue = { type: 'session-ended', intentional: true, spawnProgressLabel: 'Starting agent...', successorSessionId: 'sess-2' };
    expect(parseActivityEventPayload(both)).toEqual(both);
    expect('successorSessionId' in parseActivityEventPayload({ type: 'session-ended', intentional: true })).toBe(false);
  });

  it('rejects a session-ended payload with a non-string successorSessionId', () => {
    expect(() => parseActivityEventPayload({ type: 'session-ended', intentional: true, successorSessionId: 7 })).toThrow(/successorSessionId/);
    expect(() => parseActivityEventPayload({ type: 'session-ended', intentional: true, successorSessionId: null })).toThrow(/successorSessionId/);
  });

  it('parses a status payload for every lifecycle status', () => {
    for (const status of ['running', 'queued', 'suspended', 'exited']) {
      expect(parseActivityEventPayload({ type: 'status', status, resuming: false, resumable: false })).toEqual({ type: 'status', status, resuming: false, resumable: false });
    }
    expect(parseActivityEventPayload({ type: 'status', status: 'running', resuming: true, resumable: false })).toEqual({ type: 'status', status: 'running', resuming: true, resumable: false });
  });

  it('carries resumable true on a status payload for a paused session the desktop would offer Resume for', () => {
    expect(parseActivityEventPayload({ type: 'status', status: 'suspended', resuming: false, resumable: true })).toEqual({
      type: 'status',
      status: 'suspended',
      resuming: false,
      resumable: true,
    });
  });

  it('rejects a status payload with an unknown status, or a missing resuming or resumable', () => {
    expect(() => parseActivityEventPayload({ type: 'status', status: 'zombie', resuming: false, resumable: false })).toThrow(/status/);
    expect(() => parseActivityEventPayload({ type: 'status', resuming: false, resumable: false })).toThrow(/status/);
    expect(() => parseActivityEventPayload({ type: 'status', status: 'running', resumable: false })).toThrow(/resuming/);
    expect(() => parseActivityEventPayload({ type: 'status', status: 'running', resuming: 'yes', resumable: false })).toThrow(/resuming/);
    // The status payload is new in 0.16.0 alongside resumable, so no desktop
    // ever sends one without it: absence is malformed, not an older peer.
    expect(() => parseActivityEventPayload({ type: 'status', status: 'suspended', resuming: false })).toThrow(/resumable/);
    expect(() => parseActivityEventPayload({ type: 'status', status: 'suspended', resuming: false, resumable: 'yes' })).toThrow(/resumable/);
  });

  it('rejects an invalid state', () => {
    expect(() => parseActivityEventPayload({ type: 'activity', state: 'busy', reason: { kind: 'idle' } })).toThrow(/state/);
  });

  it('rejects an unknown payload type', () => {
    expect(() => parseActivityEventPayload({ type: 'telemetry' })).toThrow(/unknown/);
  });
});

describe('parseSessionUsageWire', () => {
  it('parses a full usage snapshot and keeps optional fields', () => {
    const withOptionals: JsonValue = {
      ...(usageFixture as Record<string, JsonValue>),
      toolCallCount: 12,
      model: { id: 'claude-opus-4-8', displayName: 'Opus 4.8', effort: 'high' },
    };
    expect(parseSessionUsageWire(withOptionals)).toEqual(withOptionals);
  });

  it('strips desktop-internal extras the wire does not carry', () => {
    const parsed = parseSessionUsageWire({ ...(usageFixture as Record<string, JsonValue>), transcriptPath: 'C:/somewhere/session.jsonl' });
    expect(parsed).not.toHaveProperty('transcriptPath');
  });

  it('rejects a missing contextWindow', () => {
    expect(() => parseSessionUsageWire({ cost: { totalCostUsd: 0, totalDurationMs: 0 }, model: { id: 'm', displayName: 'M' } })).toThrow(
      /contextWindow/,
    );
  });
});

describe('parseSessionEventWire', () => {
  it('requires ts and type', () => {
    expect(() => parseSessionEventWire({ type: 'tool_start' })).toThrow(/ts/);
    expect(() => parseSessionEventWire({ ts: 1 })).toThrow(/type/);
  });
});

describe('parseTerminalDimensionsWire', () => {
  it('parses a valid grid', () => {
    expect(parseTerminalDimensionsWire({ cols: 48, rows: 26 })).toEqual({ cols: 48, rows: 26 });
  });

  it('rejects non-integers, out-of-range axes, and missing fields', () => {
    expect(() => parseTerminalDimensionsWire({ cols: 48.5, rows: 26 })).toThrow(/cols/);
    expect(() => parseTerminalDimensionsWire({ cols: 1, rows: 26 })).toThrow(/cols/);
    expect(() => parseTerminalDimensionsWire({ cols: 1001, rows: 26 })).toThrow(/cols/);
    expect(() => parseTerminalDimensionsWire({ cols: 48, rows: 0 })).toThrow(/rows/);
    expect(() => parseTerminalDimensionsWire({ cols: 48 })).toThrow(/rows/);
    expect(() => parseTerminalDimensionsWire('48x26')).toThrow(/object/);
  });
});

describe('board row guards', () => {
  it('parses a full task row', () => {
    expect(parseBoardTaskWire(boardTaskFixture)).toEqual(boardTaskFixture);
  });

  it('rejects a task without an id', () => {
    expect(() => parseBoardTaskWire({ title: 'x' })).toThrow(/id/);
  });

  it('reads a board task missing pr_merge_readiness entirely as null (pre-readiness desktop)', () => {
    const withoutReadiness = { ...(boardTaskFixture as Record<string, JsonValue>) };
    delete withoutReadiness.pr_merge_readiness;
    expect(parseBoardTaskWire(withoutReadiness).pr_merge_readiness).toBeNull();
  });

  it('reads a board task from a desktop that predates workflows as in no workflow', () => {
    const withoutWorkflow = { ...(boardTaskFixture as Record<string, JsonValue>) };
    delete withoutWorkflow.workflow;
    expect(parseBoardTaskWire(withoutWorkflow).workflow).toBeNull();
  });

  it('parses a workflow task\'s strip, wait and lock', () => {
    const inWorkflow = { ...(boardTaskFixture as Record<string, JsonValue>), workflow: workflowFixture };
    expect(parseBoardTaskWire(inWorkflow).workflow).toEqual(workflowFixture);
  });

  it('costs a malformed workflow only its strip, never the task', () => {
    const malformed = { ...(boardTaskFixture as Record<string, JsonValue>), workflow: { title: 'No id' } };
    const parsed = parseBoardTaskWire(malformed);
    expect(parsed.id).toBe('t-1');
    expect(parsed.workflow).toBeNull();
  });

  it('fills a workflow\'s unreadable details with what draws safely', () => {
    const sparse = { ...(boardTaskFixture as Record<string, JsonValue>), workflow: { id: 'wf-1', title: 'Usage budgets', project_id: 'p-1', route: ['lane-2', 4], waiting_for: 'x' } };
    expect(parseBoardTaskWire(sparse).workflow).toEqual({
      id: 'wf-1', title: 'Usage budgets', project_id: 'p-1', state: 'running', color_slot: 1,
      route: ['lane-2'], waiting_for: [], lock_reason: null, gate_target_id: null, automations_pausable: null,
    });
  });

  // Only a real boolean counts: anything else reads null, which hides the phone's
  // control on a workflow task (a desktop that refuses the hold sends no field).
  it.each([
    ['a true boolean keeps true', true, true],
    ['a false boolean keeps false', false, false],
    ['a string reads null', 'true', null],
    ['a number reads null', 1, null],
    ['a null reads null', null, null],
  ])('automations_pausable: %s', (_label, sent, parsed) => {
    const withFlag = { ...(boardTaskFixture as Record<string, JsonValue>), workflow: { ...(workflowFixture as Record<string, JsonValue>), automations_pausable: sent as JsonValue } };
    expect(parseBoardTaskWire(withFlag).workflow?.automations_pausable).toBe(parsed);
  });

  it('reads a workflow fact from a desktop that predates automations_pausable as null, so the control stays hidden', () => {
    const { automations_pausable: _omitted, ...oldFact } = workflowFixture as Record<string, JsonValue>;
    const withOldFact = { ...(boardTaskFixture as Record<string, JsonValue>), workflow: oldFact };
    expect(parseBoardTaskWire(withOldFact).workflow?.automations_pausable).toBeNull();
  });

  it('passes through a present pr_merge_readiness value', () => {
    const withReadiness = { ...(boardTaskFixture as Record<string, JsonValue>), pr_merge_readiness: 'blocked' };
    expect(parseBoardTaskWire(withReadiness).pr_merge_readiness).toBe('blocked');
  });

  it('passes through a spawn_progress label, and reads an absent or non-string one as null (pre-0.16.0 desktop)', () => {
    const withLabel = { ...(boardTaskFixture as Record<string, JsonValue>), spawn_progress: 'Waiting (2 ahead)' };
    expect(parseBoardTaskWire(withLabel).spawn_progress).toBe('Waiting (2 ahead)');
    const withoutLabel = { ...(boardTaskFixture as Record<string, JsonValue>) };
    delete withoutLabel.spawn_progress;
    expect(parseBoardTaskWire(withoutLabel).spawn_progress).toBeNull();
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), spawn_progress: 42 }).spawn_progress).toBeNull();
  });

  it('passes resumable through as true or false, and reads an absent or non-boolean one as null (pre-0.16.0 desktop)', () => {
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), resumable: true }).resumable).toBe(true);
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), resumable: false }).resumable).toBe(false);
    // Null, not false: an older desktop answers start-session by starting the
    // column, so "no promise" must stay distinguishable from "not resumable"
    // and a client offers no Resume for either.
    const withoutResumable = { ...(boardTaskFixture as Record<string, JsonValue>) };
    delete withoutResumable.resumable;
    expect(parseBoardTaskWire(withoutResumable).resumable).toBeNull();
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), resumable: 'yes' }).resumable).toBeNull();
  });

  it('passes paused through as true or false, and reads an absent or non-boolean one as null (pre-0.17.0 desktop)', () => {
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), paused: true }).paused).toBe(true);
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), paused: false }).paused).toBe(false);
    // Null, not false: a client reads "unknown" and falls back to resumable
    // alone, rather than taking an older desktop's silence as "not paused".
    const withoutPaused = { ...(boardTaskFixture as Record<string, JsonValue>) };
    delete withoutPaused.paused;
    expect(parseBoardTaskWire(withoutPaused).paused).toBeNull();
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), paused: 'yes' }).paused).toBeNull();
  });

  it('passes paused_session_id through, and reads an absent or non-string one as null (pre-0.27.0 desktop)', () => {
    const pausedRow = { ...(boardTaskFixture as Record<string, JsonValue>), session_id: null, paused: true, paused_session_id: 'sess-paused' };
    const parsed = parseBoardTaskWire(pausedRow);
    expect(parsed.paused_session_id).toBe('sess-paused');
    // session_id keeps its meaning: the parse never copies the paused id there.
    expect(parsed.session_id).toBeNull();
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), paused_session_id: null }).paused_session_id).toBeNull();
    const withoutPausedSessionId = { ...(boardTaskFixture as Record<string, JsonValue>) };
    delete withoutPausedSessionId.paused_session_id;
    expect(parseBoardTaskWire(withoutPausedSessionId).paused_session_id).toBeNull();
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), paused_session_id: 7 }).paused_session_id).toBeNull();
  });

  it('passes pausable through as true or false, and reads an absent or non-boolean one as null (pre-0.18.0 desktop)', () => {
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), pausable: true }).pausable).toBe(true);
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), pausable: false }).pausable).toBe(false);
    // Null, not false: an older desktop refuses pause-session (or never
    // answers it), so a client offers no Pause for an unknown answer either.
    const withoutPausable = { ...(boardTaskFixture as Record<string, JsonValue>) };
    delete withoutPausable.pausable;
    expect(parseBoardTaskWire(withoutPausable).pausable).toBeNull();
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), pausable: 1 }).pausable).toBeNull();
  });

  it('passes automations_disabled through as true or false, and reads an absent or non-boolean one as null (pre-0.22.0 desktop)', () => {
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), automations_disabled: true }).automations_disabled).toBe(true);
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), automations_disabled: false }).automations_disabled).toBe(false);
    // Null, not false. The phone gates its menu row on this, and an older
    // desktop cannot say what the switch reads.
    const withoutSwitch = { ...(boardTaskFixture as Record<string, JsonValue>) };
    delete withoutSwitch.automations_disabled;
    expect(parseBoardTaskWire(withoutSwitch).automations_disabled).toBeNull();
    expect(parseBoardTaskWire({ ...(boardTaskFixture as Record<string, JsonValue>), automations_disabled: 1 }).automations_disabled).toBeNull();
  });

  it('parses a column row', () => {
    const column: JsonValue = {
      id: 'lane-1',
      name: 'To Do',
      description: null,
      role: 'todo',
      position: 0,
      color: '#00ff00',
      icon: null,
      is_archived: false,
      is_ghost: false,
      spawns_session: false,
    };
    expect(parseBoardColumnWire(column)).toEqual(column);
  });

  it('reads a column missing spawns_session entirely as null (pre-field desktop)', () => {
    const column: JsonValue = {
      id: 'lane-1',
      name: 'To Do',
      description: null,
      role: 'todo',
      position: 0,
      color: '#00ff00',
      icon: null,
      is_archived: false,
      is_ghost: false,
    };
    expect(parseBoardColumnWire(column).spawns_session).toBeNull();
  });

  it('passes through a present spawns_session value', () => {
    const column: JsonValue = {
      id: 'lane-1',
      name: 'Executing',
      description: null,
      role: null,
      position: 2,
      color: '#0000ff',
      icon: null,
      is_archived: false,
      is_ghost: false,
      spawns_session: true,
    };
    expect(parseBoardColumnWire(column).spawns_session).toBe(true);
  });

  it('reads a present but non-boolean spawns_session as null rather than coercing it', () => {
    const column: JsonValue = {
      id: 'lane-1',
      name: 'Executing',
      description: null,
      role: null,
      position: 2,
      color: '#0000ff',
      icon: null,
      is_archived: false,
      is_ghost: false,
      spawns_session: 'true',
    };
    expect(parseBoardColumnWire(column).spawns_session).toBeNull();
  });

  it('passes through an unrecognized role rather than throwing', () => {
    const column: JsonValue = {
      id: 'lane-1',
      name: 'Archive',
      description: null,
      role: 'archive',
      position: 3,
      color: '#888888',
      icon: null,
      is_archived: false,
      is_ghost: false,
      spawns_session: null,
    };
    const parsed = parseBoardColumnWire(column);
    expect(parsed.role).toBe('archive');
    expect(isTodoRole(parsed.role)).toBe(false);
    expect(isDoneRole(parsed.role)).toBe(false);
  });

  it('isTodoRole and isDoneRole return false rather than throwing on null or undefined', () => {
    expect(isTodoRole(null)).toBe(false);
    expect(isTodoRole(undefined)).toBe(false);
    expect(isDoneRole(null)).toBe(false);
    expect(isDoneRole(undefined)).toBe(false);
    expect(isTodoRole('todo')).toBe(true);
    expect(isDoneRole('done')).toBe(true);
  });

  it('parses a backlog row', () => {
    const item: JsonValue = {
      id: 'b-1',
      title: 'Later',
      description: '',
      priority: 0,
      labels: [],
      position: 1,
      item_type: null,
      external_url: null,
      attachment_count: 0,
      created_at: '2026-07-13T00:00:00.000Z',
      updated_at: '2026-07-13T00:00:00.000Z',
    };
    expect(parseBacklogItemWire(item)).toEqual(item);
  });
});

describe('diff guards', () => {
  const fileList: JsonValue = {
    files: [
      { path: 'src/a.ts', status: 'M', insertions: 3, deletions: 1, binary: false },
      { path: 'src/b.ts', status: 'R', insertions: 0, deletions: 0, oldPath: 'src/old-b.ts', binary: false },
    ],
    totalInsertions: 3,
    totalDeletions: 1,
  };

  it('parses a file list', () => {
    expect(parseDiffFileListWire(fileList)).toEqual(fileList);
  });

  it('rejects an invalid file status', () => {
    expect(() => parseDiffFileListWire({ files: [{ path: 'x', status: 'Z', insertions: 0, deletions: 0, binary: false }], totalInsertions: 0, totalDeletions: 0 })).toThrow(/status/);
  });

  it('parses file content', () => {
    const content: JsonValue = { original: 'a', modified: 'b', language: 'typescript' };
    expect(parseDiffFileContentWire(content)).toEqual(content);
  });
});

describe('read-* response parsers', () => {
  it('parses a read-stream response with a null activity state', () => {
    const parsed = parseReadStreamResponsePayload({
      scrollback: 'output',
      activity: { state: null, reason: null },
      usage: null,
      awaitedPromptId: null,
    });
    expect(parsed).toEqual({ scrollback: 'output', activity: { state: null, reason: null }, usage: null, awaitedPromptId: null });
  });

  it('parses a read-stream response with a pending prompt and usage', () => {
    const parsed = parseReadStreamResponsePayload({
      scrollback: '',
      activity: { state: 'permission', reason: { kind: 'permission' } },
      usage: usageFixture,
      awaitedPromptId: 'sess-1:tool-1',
    });
    expect(parsed.awaitedPromptId).toBe('sess-1:tool-1');
    expect(parsed.activity.state).toBe('permission');
    expect(parsed.usage).toEqual(usageFixture);
  });

  it('keeps a read-stream reason\'s known wait kind and drops an unknown one', () => {
    const base = { scrollback: '', usage: null, awaitedPromptId: null };
    const known = parseReadStreamResponsePayload({ ...base, activity: { state: 'permission', reason: { kind: 'permission', waitKind: 'approval' } } });
    expect(known.activity.reason).toStrictEqual({ kind: 'permission', waitKind: 'approval' });
    const unknown = parseReadStreamResponsePayload({ ...base, activity: { state: 'permission', reason: { kind: 'permission', waitKind: 'future-kind' } } });
    expect(unknown.activity.reason).toStrictEqual({ kind: 'permission' });
  });

  it('rejects a read-stream response without scrollback', () => {
    expect(() => parseReadStreamResponsePayload({ activity: { state: null, reason: null }, usage: null, awaitedPromptId: null })).toThrow(
      /scrollback/,
    );
  });

  it('carries awaitedPromptOptions (array or explicit null), tolerates absence (pre-0.6.0 desktop), and rejects malformed values', () => {
    const base: Record<string, JsonValue> = {
      scrollback: '',
      activity: { state: 'permission', reason: { kind: 'permission' } },
      usage: null,
      awaitedPromptId: 'sess-1:tool-1',
    };
    const options = ['Yes', "Yes, and don't ask again for this command", 'No, and tell Claude what to do differently'];
    expect(parseReadStreamResponsePayload({ ...base, awaitedPromptOptions: options }).awaitedPromptOptions).toEqual(options);

    // Explicit null (a pending prompt whose dialog could not be parsed) survives.
    expect(parseReadStreamResponsePayload({ ...base, awaitedPromptOptions: null }).awaitedPromptOptions).toBeNull();

    const withoutOptions = parseReadStreamResponsePayload(base);
    expect('awaitedPromptOptions' in withoutOptions).toBe(false);

    expect(() => parseReadStreamResponsePayload({ ...base, awaitedPromptOptions: 'Yes' })).toThrow(/awaitedPromptOptions/);
    expect(() => parseReadStreamResponsePayload({ ...base, awaitedPromptOptions: [1, 2] })).toThrow(/awaitedPromptOptions/);
    expect(() => parseReadStreamResponsePayload({ ...base, awaitedPromptOptions: ['Yes', null] })).toThrow(/awaitedPromptOptions/);
    expect(() => parseReadStreamResponsePayload({ ...base, awaitedPromptOptions: { first: 'Yes' } })).toThrow(/awaitedPromptOptions/);
  });

  it('carries ptyDimensions when present and omits the field when absent (pre-0.4.0 desktop)', () => {
    const withDims = parseReadStreamResponsePayload({
      scrollback: '',
      activity: { state: null, reason: null },
      usage: null,
      awaitedPromptId: null,
      ptyDimensions: { cols: 120, rows: 30 },
    });
    expect(withDims.ptyDimensions).toEqual({ cols: 120, rows: 30 });

    const withoutDims = parseReadStreamResponsePayload({
      scrollback: '',
      activity: { state: null, reason: null },
      usage: null,
      awaitedPromptId: null,
    });
    expect('ptyDimensions' in withoutDims).toBe(false);

    expect(() =>
      parseReadStreamResponsePayload({
        scrollback: '',
        activity: { state: null, reason: null },
        usage: null,
        awaitedPromptId: null,
        ptyDimensions: { cols: 0, rows: 30 },
      }),
    ).toThrow(/cols/);
  });

  it('carries sessionStatus when present, tolerates absence (pre-0.5.0 desktop), and rejects unknown values', () => {
    const base: Record<string, JsonValue> = {
      scrollback: '',
      activity: { state: null, reason: null },
      usage: null,
      awaitedPromptId: null,
    };
    for (const status of ['running', 'queued', 'suspended', 'exited']) {
      expect(parseReadStreamResponsePayload({ ...base, sessionStatus: status }).sessionStatus).toBe(status);
    }

    const withoutStatus = parseReadStreamResponsePayload(base);
    expect('sessionStatus' in withoutStatus).toBe(false);

    expect(() => parseReadStreamResponsePayload({ ...base, sessionStatus: 'zombie' })).toThrow(/sessionStatus/);
    expect(() => parseReadStreamResponsePayload({ ...base, sessionStatus: 3 })).toThrow(/sessionStatus/);
  });

  it('carries resuming when present, tolerates absence (pre-0.16.0 desktop), and rejects a non-boolean', () => {
    const base: Record<string, JsonValue> = {
      scrollback: '',
      activity: { state: null, reason: null },
      usage: null,
      awaitedPromptId: null,
    };
    expect(parseReadStreamResponsePayload({ ...base, resuming: true }).resuming).toBe(true);
    expect(parseReadStreamResponsePayload({ ...base, resuming: false }).resuming).toBe(false);
    expect('resuming' in parseReadStreamResponsePayload(base)).toBe(false);
    expect(() => parseReadStreamResponsePayload({ ...base, resuming: 'yes' })).toThrow(/resuming/);
  });

  it('carries resumable true and false, leaves it absent for a pre-0.16.0 desktop, and rejects a non-boolean', () => {
    const base: Record<string, JsonValue> = {
      scrollback: '',
      activity: { state: null, reason: null },
      usage: null,
      awaitedPromptId: null,
      sessionStatus: 'suspended',
    };
    expect(parseReadStreamResponsePayload({ ...base, resumable: true }).resumable).toBe(true);
    expect(parseReadStreamResponsePayload({ ...base, resumable: false }).resumable).toBe(false);
    // Absent, never defaulted: an older desktop answers start-session by
    // starting the column, so a phone must be able to tell "no promise" apart
    // from false, and offer no Resume.
    expect('resumable' in parseReadStreamResponsePayload(base)).toBe(false);
    expect(() => parseReadStreamResponsePayload({ ...base, resumable: 'yes' })).toThrow(/resumable/);
    expect(() => parseReadStreamResponsePayload({ ...base, resumable: null })).toThrow(/resumable/);
  });

  it('parses a read-board project list', () => {
    expect(parseReadBoardResponsePayload({ projects: [{ id: 'p-1', name: 'Alpha' }] })).toEqual({ projects: [{ id: 'p-1', name: 'Alpha' }] });
  });

  it('parses a read-board snapshot', () => {
    const snapshot: JsonValue = {
      projectId: 'p-1',
      columns: [],
      tasks: [boardTaskFixture],
      backlog: [],
    };
    const parsed = parseReadBoardResponsePayload(snapshot);
    expect(parsed).toEqual(snapshot);
  });

  it('rejects a read-board snapshot missing columns', () => {
    expect(() => parseReadBoardResponsePayload({ projectId: 'p-1', tasks: [], backlog: [] })).toThrow(/columns/);
  });

  it('carries per-project color and snapshot projectColor when present, tolerating absence (pre-0.5.0 desktop)', () => {
    expect(parseReadBoardResponsePayload({ projects: [{ id: 'p-1', name: 'Alpha', color: '#D97706' }] })).toEqual({
      projects: [{ id: 'p-1', name: 'Alpha', color: '#D97706' }],
    });
    const withoutColor = parseReadBoardResponsePayload({ projects: [{ id: 'p-1', name: 'Alpha' }] }) as {
      projects: Array<Record<string, unknown>>;
    };
    expect('color' in withoutColor.projects[0]).toBe(false);

    const snapshot = parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], backlog: [], projectColor: '#3b82f6' });
    expect(snapshot).toEqual({ projectId: 'p-1', columns: [], tasks: [], backlog: [], projectColor: '#3b82f6' });
    const bareSnapshot = parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], backlog: [] });
    expect('projectColor' in bareSnapshot).toBe(false);
  });

  it('carries showTicketNumbers when present, tolerating absence (pre-0.6.0 desktop)', () => {
    const snapshot = parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], backlog: [], showTicketNumbers: false });
    expect(snapshot).toEqual({ projectId: 'p-1', columns: [], tasks: [], backlog: [], showTicketNumbers: false });
    const bareSnapshot = parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], backlog: [] });
    expect('showTicketNumbers' in bareSnapshot).toBe(false);
    expect(() =>
      parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], backlog: [], showTicketNumbers: 'yes' }),
    ).toThrow(/showTicketNumbers/);
  });

  it('rejects a malformed accent color on either read-board shape', () => {
    expect(() => parseReadBoardResponsePayload({ projects: [{ id: 'p-1', name: 'Alpha', color: 'amber' }] })).toThrow(/accent color/);
    expect(() => parseReadBoardResponsePayload({ projects: [{ id: 'p-1', name: 'Alpha', color: '#12345' }] })).toThrow(/accent color/);
    expect(() => parseReadBoardResponsePayload({ projects: [{ id: 'p-1', name: 'Alpha', color: 42 }] })).toThrow(/accent color/);
    expect(() =>
      parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], backlog: [], projectColor: 'rgb(1,2,3)' }),
    ).toThrow(/accent color/);
  });

  it('parses a read-diff response by discriminating on "files"', () => {
    expect(parseReadDiffResponsePayload({ files: [], totalInsertions: 0, totalDeletions: 0 })).toEqual({ files: [], totalInsertions: 0, totalDeletions: 0 });
    expect(parseReadDiffResponsePayload({ original: 'a', modified: 'b', language: 'ts' })).toEqual({ original: 'a', modified: 'b', language: 'ts' });
  });

  it('parses a start-session response to exactly its two fields, on both outcomes', () => {
    // The two accepted shapes ask different things of the phone: `starting`
    // waits for the successor's board / stream event, `live` refreshes at once
    // because nothing was spawned and no event is coming.
    expect(parseStartSessionResponsePayload({ ok: true, outcome: 'starting', extra: 1 })).toEqual({ ok: true, outcome: 'starting' });
    expect(parseStartSessionResponsePayload({ ok: true, outcome: 'live' })).toEqual({ ok: true, outcome: 'live' });
  });

  it('rejects a start-session response with a missing ok or an unknown outcome', () => {
    expect(() => parseStartSessionResponsePayload({ outcome: 'starting' })).toThrow(/ok/);
    expect(() => parseStartSessionResponsePayload({ ok: true })).toThrow(/outcome/);
    expect(() => parseStartSessionResponsePayload({ ok: true, outcome: 'restarted' })).toThrow(/outcome/);
    expect(() => parseStartSessionResponsePayload('ok' as unknown as JsonValue)).toThrow(/object/);
  });

  it('parses a pause-session response to exactly its ok field', () => {
    expect(parsePauseSessionResponsePayload({ ok: true, extra: 1 })).toEqual({ ok: true });
  });

  it('rejects a pause-session response with a missing or non-boolean ok', () => {
    expect(() => parsePauseSessionResponsePayload({})).toThrow(/ok/);
    expect(() => parsePauseSessionResponsePayload({ ok: 'yes' })).toThrow(/ok/);
    expect(() => parsePauseSessionResponsePayload(null)).toThrow(/object/);
  });

  it('parses a command-terminal start response to exactly its four fields', () => {
    expect(parseCommandTerminalStartResponsePayload({ ok: true, sessionId: 's-1', slot: 2, name: 'Command Terminal 2', extra: 1 }))
      .toEqual({ ok: true, sessionId: 's-1', slot: 2, name: 'Command Terminal 2' });
  });

  it('rejects a command-terminal start response with a missing id or name, or a slot that is not a positive integer', () => {
    expect(() => parseCommandTerminalStartResponsePayload({ ok: true, slot: 1, name: 'x' })).toThrow(/sessionId/);
    expect(() => parseCommandTerminalStartResponsePayload({ ok: true, sessionId: 's', slot: 1 })).toThrow(/name/);
    expect(() => parseCommandTerminalStartResponsePayload({ ok: true, sessionId: 's', slot: 0, name: 'x' })).toThrow(/slot/);
    expect(() => parseCommandTerminalStartResponsePayload({ ok: true, sessionId: 's', slot: 1.5, name: 'x' })).toThrow(/slot/);
    expect(() => parseCommandTerminalStartResponsePayload({ ok: false, sessionId: 's', slot: 1, name: 'x' })).toThrow(/ok/);
  });

  it('parses a snapshot\'s Command Terminals and the offered flag (protocol 0.20.0)', () => {
    const parsed = parseReadBoardResponsePayload({
      projectId: 'p-1',
      columns: [],
      tasks: [],
      commandTerminals: [
        {
          sessionId: 's-1',
          projectId: 'p-1',
          slot: 1,
          name: 'Audit Unused Feature Flags',
          named: true,
          activity: { state: 'permission', reason: { kind: 'permission', since: 10 } },
        },
        { sessionId: 's-2', projectId: 'p-1', slot: 2, name: 'Command Terminal 2', named: false, activity: { state: null, reason: null } },
      ],
      commandTerminalsOffered: true,
    });
    expect(parsed).toMatchObject({
      commandTerminalsOffered: true,
      commandTerminals: [
        { sessionId: 's-1', slot: 1, named: true, activity: { state: 'permission', reason: { kind: 'permission', since: 10 } } },
        { sessionId: 's-2', slot: 2, named: false, activity: { state: null, reason: null } },
      ],
    });
  });

  it('reads an unknown activity state or reason on a Command Terminal as null rather than failing the snapshot', () => {
    const parsed = parseReadBoardResponsePayload({
      projectId: 'p-1',
      columns: [],
      tasks: [],
      commandTerminals: [{ sessionId: 's-1', projectId: 'p-1', slot: 1, name: 'x', named: false, activity: { state: 'dreaming', reason: { kind: 'future-kind' } } }],
    });
    expect(parsed).toMatchObject({ commandTerminals: [{ activity: { state: null, reason: null } }] });
  });

  it('keeps a Command Terminal\'s permission reason and drops only a wait kind this version does not know', () => {
    // A newer desktop may add a wait kind. The reason must survive as a wait of
    // unknown kind, not collapse to null the way an unknown reason kind does.
    const parsed = parseReadBoardResponsePayload({
      projectId: 'p-1',
      columns: [],
      tasks: [],
      commandTerminals: [{
        sessionId: 's-1',
        projectId: 'p-1',
        slot: 1,
        name: 'x',
        named: false,
        activity: { state: 'permission', reason: { kind: 'permission', waitKind: 'future-kind' } },
      }],
    });
    expect(parsed.commandTerminals?.[0]?.activity.reason).toStrictEqual({ kind: 'permission' });
  });

  it('keeps a Command Terminal permission reason\'s known wait kind', () => {
    const parsed = parseReadBoardResponsePayload({
      projectId: 'p-1',
      columns: [],
      tasks: [],
      commandTerminals: [{
        sessionId: 's-1',
        projectId: 'p-1',
        slot: 1,
        name: 'x',
        named: false,
        activity: { state: 'permission', reason: { kind: 'permission', waitKind: 'question' } },
      }],
    });
    expect(parsed.commandTerminals?.[0]?.activity.reason).toStrictEqual({ kind: 'permission', waitKind: 'question' });
  });

  it('leaves both Command Terminal fields absent for an older desktop, and rejects malformed ones', () => {
    const parsed = parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [] });
    expect('commandTerminals' in parsed).toBe(false);
    expect('commandTerminalsOffered' in parsed).toBe(false);
    expect(() => parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], commandTerminals: {} })).toThrow(/commandTerminals/);
    expect(() => parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], commandTerminalsOffered: 'yes' })).toThrow(/commandTerminalsOffered/);
    expect(() => parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], commandTerminals: [{ sessionId: 's-1' }] })).toThrow(/command terminal/);
  });

  /**
   * protocol 0.24.0: the phone's Earlier list. The flag is what keeps a phone
   * from sending `list-earlier` or `resume` to an older desktop, so absent
   * must stay absent (read as false), never default to true.
   */
  it('parses the Earlier flag, leaves it absent for an older desktop, and rejects a non-boolean', () => {
    expect(parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], earlierConversationsOffered: true }))
      .toMatchObject({ earlierConversationsOffered: true });
    expect('earlierConversationsOffered' in parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [] })).toBe(false);
    expect(() => parseReadBoardResponsePayload({ projectId: 'p-1', columns: [], tasks: [], earlierConversationsOffered: 1 }))
      .toThrow(/earlierConversationsOffered/);
  });

  it('parses a list-earlier answer to exactly its fields, dropping a malformed conversation on its own', () => {
    expect(parseCommandTerminalEarlierResponsePayload({
      ok: true,
      projectId: 'p-1',
      conversations: [
        { agentSessionId: 'conv-2', name: 'Profile the diff panel', endedAt: '2026-10-24T10:00:00.000Z', agentName: 'claude' },
        { agentSessionId: 'conv-1', name: null, endedAt: '2026-10-23T09:00:00.000Z' },
        { agentSessionId: 'conv-bad', name: 7, endedAt: '2026-10-22T09:00:00.000Z' },
        { agentSessionId: '', name: null, endedAt: '2026-10-21T09:00:00.000Z' },
        { name: 'no id', endedAt: '2026-10-20T09:00:00.000Z' },
        { agentSessionId: 'conv-no-time', name: null },
      ],
    })).toEqual({
      ok: true,
      projectId: 'p-1',
      conversations: [
        { agentSessionId: 'conv-2', name: 'Profile the diff panel', endedAt: '2026-10-24T10:00:00.000Z' },
        { agentSessionId: 'conv-1', name: null, endedAt: '2026-10-23T09:00:00.000Z' },
      ],
    });
  });

  it('rejects a list-earlier answer with no ok, project or list', () => {
    expect(() => parseCommandTerminalEarlierResponsePayload({ projectId: 'p-1', conversations: [] })).toThrow(/ok/);
    expect(() => parseCommandTerminalEarlierResponsePayload({ ok: true, conversations: [] })).toThrow(/projectId/);
    expect(() => parseCommandTerminalEarlierResponsePayload({ ok: true, projectId: 'p-1' })).toThrow(/conversations/);
    expect(() => parseCommandTerminalEarlierResponsePayload(null)).toThrow(/object/);
  });
});

describe('parseTranscriptEventPayload', () => {
  const userEntry = { kind: 'user', uuid: 'u', ts: 1, text: 'x' };

  it('parses a delta payload with indexed upserts', () => {
    const payload: JsonValue = { mode: 'delta', revision: 3, totalEntries: 12, upserts: [{ index: 11, entry: userEntry }] };
    expect(parseTranscriptEventPayload(payload)).toEqual(payload);
  });

  it('parses a reset payload', () => {
    expect(parseTranscriptEventPayload({ mode: 'reset', revision: 4, totalEntries: 0 })).toEqual({ mode: 'reset', revision: 4, totalEntries: 0 });
  });

  it('rejects a legacy whole-array payload, an unknown mode, and malformed upserts', () => {
    expect(() => parseTranscriptEventPayload([userEntry] as unknown as JsonValue)).toThrow(/object/);
    expect(() => parseTranscriptEventPayload({ mode: 'replace', revision: 1, totalEntries: 1 })).toThrow(/mode/);
    expect(() => parseTranscriptEventPayload({ mode: 'delta', revision: 1, totalEntries: 1 })).toThrow(/upserts/);
    expect(() => parseTranscriptEventPayload({ mode: 'delta', revision: 1, totalEntries: 1, upserts: [{ index: -1, entry: userEntry }] })).toThrow(/index/);
    expect(() => parseTranscriptEventPayload({ mode: 'delta', revision: 1, totalEntries: 1, upserts: [{ index: 0, entry: { kind: 'user' } }] })).toThrow(/entry/);
    expect(() => parseTranscriptEventPayload({ mode: 'delta', revision: 1.5, totalEntries: 1, upserts: [] })).toThrow(/revision/);
  });
});

describe('parseTranscriptWindowResponsePayload', () => {
  const userEntry = { kind: 'user', uuid: 'u', ts: 1, text: 'x' };

  it('parses a windowed-history page', () => {
    const payload: JsonValue = { revision: 9, totalEntries: 500, startIndex: 440, entries: [userEntry] };
    expect(parseTranscriptWindowResponsePayload(payload)).toEqual(payload);
  });

  it('rejects malformed windows', () => {
    expect(() => parseTranscriptWindowResponsePayload({ revision: 9, totalEntries: 500, startIndex: -1, entries: [] })).toThrow(/startIndex/);
    expect(() => parseTranscriptWindowResponsePayload({ revision: 9, totalEntries: 500, startIndex: 0, entries: [{ kind: 'user' }] })).toThrow(/malformed/);
    expect(() => parseTranscriptWindowResponsePayload({ revision: 9, startIndex: 0, entries: [] })).toThrow(/totalEntries/);
  });
});

describe('isBridgeEvent', () => {
  it('accepts every well-formed event kind', () => {
    expect(
      isBridgeEvent({
        kind: 'transcript',
        sessionId: 's',
        taskId: 't',
        payload: { mode: 'delta', revision: 1, totalEntries: 1, upserts: [{ index: 0, entry: { kind: 'user', uuid: 'u', ts: 1, text: 'x' } }] },
      }),
    ).toBe(true);
    expect(isBridgeEvent({ kind: 'transcript', sessionId: 's', taskId: 't', payload: { mode: 'reset', revision: 2, totalEntries: 0 } })).toBe(true);
    expect(isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'permission', promptId: 'p', pending: true } })).toBe(true);
    expect(
      isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'permission', promptId: 'p', pending: true, options: ['Yes', 'No'] } }),
    ).toBe(true);
    expect(isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'session-ended', intentional: false } })).toBe(true);
    expect(
      isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Switching model...' } }),
    ).toBe(true);
    expect(
      isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'session-ended', intentional: true, successorSessionId: 's-2' } }),
    ).toBe(true);
    expect(isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'status', status: 'queued', resuming: false, resumable: false } })).toBe(true);
    expect(isBridgeEvent({ kind: 'terminal', sessionId: 's', taskId: 't', payload: { data: 'bytes' } })).toBe(true);
    expect(isBridgeEvent({ kind: 'terminal-resize', sessionId: 's', taskId: 't', payload: { cols: 48, rows: 26 } })).toBe(true);
    expect(isBridgeEvent({ kind: 'board', projectId: 'p', payload: { change: 'task-updated', ids: ['t-1'] } })).toBe(true);
    expect(isBridgeEvent({ kind: 'board', projectId: 'p', payload: { change: 'command-terminals-changed', ids: ['s-1'] } })).toBe(true);
    expect(isBridgeEvent({ kind: 'diff', taskId: 't', payload: null })).toBe(true);
    // A project-folder diff (protocol 0.20.0) names the project instead.
    expect(isBridgeEvent({ kind: 'diff', projectId: 'p', payload: null })).toBe(true);
  });

  it('rejects a diff event that names neither or both of task and project', () => {
    expect(isBridgeEvent({ kind: 'diff', payload: null })).toBe(false);
    expect(isBridgeEvent({ kind: 'diff', taskId: 't', projectId: 'p', payload: null })).toBe(false);
    expect(isBridgeEvent({ kind: 'diff', projectId: 7, payload: null })).toBe(false);
  });

  it('rejects malformed events', () => {
    expect(isBridgeEvent(null)).toBe(false);
    expect(isBridgeEvent({ kind: 'transcript', sessionId: 's', taskId: 't', payload: 'not-a-delta' })).toBe(false);
    expect(isBridgeEvent({ kind: 'transcript', sessionId: 's', taskId: 't', payload: [{ kind: 'user', uuid: 'u', ts: 1, text: 'x' }] })).toBe(false);
    expect(isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'activity', state: 'busy', reason: { kind: 'idle' } } })).toBe(false);
    expect(
      isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'permission', promptId: 'p', pending: true, options: [1] } }),
    ).toBe(false);
    expect(
      isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 42 } }),
    ).toBe(false);
    expect(isBridgeEvent({ kind: 'activity', sessionId: 's', taskId: 't', payload: { type: 'status', status: 'paused', resuming: false, resumable: true } })).toBe(false);
    expect(isBridgeEvent({ kind: 'terminal', sessionId: 's', taskId: 't', payload: { data: 42 } })).toBe(false);
    expect(isBridgeEvent({ kind: 'terminal-resize', sessionId: 's', taskId: 't', payload: { cols: 0, rows: 26 } })).toBe(false);
    expect(isBridgeEvent({ kind: 'terminal-resize', sessionId: 's', payload: { cols: 48, rows: 26 } })).toBe(false);
    expect(isBridgeEvent({ kind: 'board', projectId: 'p', payload: { change: 'exploded', ids: [] } })).toBe(false);
    expect(isBridgeEvent({ kind: 'diff', taskId: 't', payload: { stale: true } })).toBe(false);
    expect(isBridgeEvent({ kind: 'metrics', sessionId: 's', taskId: 't', payload: null })).toBe(false);
  });
});
