import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces .claude/rules/project-scoped-ipc.md. Renderer-driven task-scoped and session
// MUTATION IPC must forward an explicit projectId (captured at interaction time) so a mutation
// always targets the project it was issued for, even across a mid-flight project switch. The
// main handler prefers it over the ambient context.currentProjectId.
//
// This test parses preload.ts and (1) asserts every mutation-set channel forwards a `projectId`
// argument to ipcRenderer.invoke, and (2) asserts every task/session invoke channel is
// classified as either a mutation or an explicit allowlist entry, so a NEW channel cannot ship
// unclassified. That forces a deliberate decision (stamp it, or justify the allowlist) the first
// time CI runs, covering the rule's read-trigger gap.

const REPO_ROOT = path.resolve(__dirname, '../..');
const PRELOAD_PATH = path.join(REPO_ROOT, 'src/preload/preload.ts');

// Mutation channels: must forward an explicit projectId. Keep in sync with the prose list in
// .claude/rules/project-scoped-ipc.md when the mutation set grows.
const MUTATION_CHANNELS = new Set([
  'TASK_CREATE',
  'TASK_UPDATE',
  'TASK_DELETE',
  'TASK_MOVE',
  'TASK_UNARCHIVE',
  'TASK_BULK_DELETE',
  'TASK_BULK_UNARCHIVE',
  'TASK_SWITCH_BRANCH',
  'TASK_SET_RUNTIME_OVERRIDE',
  'TASK_RESOLVE_PR',
  'TASK_SET_DETAIL_VIEW_STATE',
  'SESSION_SPAWN',
  'SESSION_SUSPEND',
  'SESSION_RESUME',
  'SESSION_RESET',
  'SESSION_RECONCILE',
]);

// Allowlisted channels: reads, by-session-id operations, or project-agnostic actions that do not
// route a project-scoped DB mutation. They are exempt from the projectId requirement on purpose.
const ALLOWLIST_CHANNELS = new Set([
  // Task reads / project-agnostic
  'TASK_LIST',
  'TASK_LIST_ARCHIVED',
  'TASK_LIST_ARCHIVED_PREVIEW',
  'TASK_GET_SPAWN_PROGRESS',
  'TASK_CANCEL_SPAWN', // aborts a global per-task controller; no project lookup
  // Session reads
  'SESSION_LIST',
  'SESSION_GET_SCROLLBACK',
  'SESSION_GET_FIRST_OUTPUT',
  'SESSION_GET_USAGE',
  'SESSION_GET_ACTIVITY',
  'SESSION_GET_ACTIVITY_REASON',
  'SESSION_GET_ACTIVITY_REASONS',
  'SESSION_GET_ACTIVITY_STATS',
  'SESSION_GET_EVENTS',
  'SESSION_GET_EVENTS_CACHE',
  'SESSION_GET_SUMMARY',
  'SESSION_LIST_SUMMARIES',
  'SESSION_GET_TOOL_BREAKDOWN',
  'SESSION_GET_PERIOD_STATS',
  // Session by-session-id / global / transient (separate ephemeral lifecycle)
  'SESSION_KILL',
  'SESSION_WRITE',
  'SESSION_RESIZE',
  'SESSION_SET_FOCUSED',
  'SESSION_NOTIFY_USER_INTERRUPT',
  'SESSION_INJECT_SETTINGS',
  'SESSION_SPAWN_TRANSIENT',
  'SESSION_KILL_TRANSIENT',
]);

interface InvokeCall {
  channel: string;
  /** The argument list passed to ipcRenderer.invoke after the channel constant. */
  args: string;
  line: number;
}

function extractTaskSessionInvokes(source: string): InvokeCall[] {
  const calls: InvokeCall[] = [];
  // Match ipcRenderer.invoke(IPC.TASK_* | IPC.SESSION_*, <args up to the closing paren>).
  // These invoke calls have no nested parens in their argument lists, so [^)]* is safe.
  const pattern = /ipcRenderer\.invoke\(\s*(IPC\.(?:TASK|SESSION)_[A-Z0-9_]+)((?:,\s*[^)]*)?)\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const channel = match[1].replace('IPC.', '');
    const args = match[2] ?? '';
    const line = source.slice(0, match.index).split('\n').length;
    calls.push({ channel, args, line });
  }
  return calls;
}

describe('project-scoped IPC parity', () => {
  const source = fs.readFileSync(PRELOAD_PATH, 'utf-8');
  const invokes = extractTaskSessionInvokes(source);

  it('finds task/session invoke calls in preload (sanity check the parser)', () => {
    // Guards against the regex silently matching nothing (e.g. after a preload refactor),
    // which would make the assertions below vacuously pass.
    expect(invokes.length).toBeGreaterThan(10);
  });

  it('every task/session mutation channel forwards an explicit projectId', () => {
    const offenders: string[] = [];
    for (const call of invokes) {
      if (!MUTATION_CHANNELS.has(call.channel)) continue;
      if (!/\bprojectId\b/.test(call.args)) {
        offenders.push(`${call.channel} (preload.ts:${call.line})`);
      }
    }
    expect(
      offenders,
      'These task/session mutation channels must forward an explicit projectId as the trailing '
        + 'ipcRenderer.invoke argument (see .claude/rules/project-scoped-ipc.md):\n'
        + offenders.join('\n'),
    ).toEqual([]);
  });

  it('every mutation channel is actually present in preload (catches a rename/removal)', () => {
    const present = new Set(invokes.map((call) => call.channel));
    const missing = [...MUTATION_CHANNELS].filter((channel) => !present.has(channel));
    expect(
      missing,
      'These channels are listed as mutations but no longer appear in preload. Update '
        + 'MUTATION_CHANNELS and the rule if they were renamed or removed:\n'
        + missing.join('\n'),
    ).toEqual([]);
  });

  it('every task/session invoke channel is classified as mutation or allowlist', () => {
    const unclassified: string[] = [];
    for (const call of invokes) {
      if (MUTATION_CHANNELS.has(call.channel) || ALLOWLIST_CHANNELS.has(call.channel)) continue;
      unclassified.push(`${call.channel} (preload.ts:${call.line})`);
    }
    expect(
      unclassified,
      'New task/session IPC channel(s) found in preload that are neither a stamped mutation nor '
        + 'allowlisted. Classify each: add to MUTATION_CHANNELS and forward projectId if it '
        + 'mutates project-scoped state, otherwise add to ALLOWLIST_CHANNELS (reads / by-id / '
        + 'project-agnostic). See .claude/rules/project-scoped-ipc.md:\n'
        + unclassified.join('\n'),
    ).toEqual([]);
  });
});
