import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SPAWN_PROMPT_TEMPLATE } from '../../../shared/task-template-vars';
import { isRetiredActionType } from '../../../shared/automation-manifest';
import type { AutomationConfig, AutomationTrigger, AutomationType, AutoCommandMode } from '../../../shared/types';
import { migrateSpawnAgentConfig } from './spawn-agent-config-migration';

/**
 * One-way migration from named actions plus transitions to per-column
 * automations.
 *
 * Split into a pure planner and a thin DB runner, the same way
 * `spawn-agent-config-migration.ts` is: the native `better-sqlite3` binding is
 * rebuilt for Electron, so DB-level tests skip under plain Node vitest, and the
 * decisions worth testing are all in the planner.
 *
 * Three things happen, and the second is the one worth reading:
 *
 * 1. Every transition row becomes an automation on its DESTINATION column. An
 *    action referenced N times becomes N independent automations, because an
 *    automation belongs to exactly one column now.
 * 2. Retired types are DROPPED, rows and all. `kill_session` at Priority 4
 *    suspends a session the task does not have, `create_worktree` repeats what
 *    the move path's `ensureTaskWorktree` already did, and `cleanup_worktree`
 *    repeats a To Do move. Nothing stops happening. The seeded default-prompt
 *    `spawn_agent` is skipped for the same reason: the fallback spawn already
 *    does exactly that. A `spawn_agent` carrying any OTHER prompt survives as
 *    the one legacy automation, because a custom prompt has no other home.
 * 3. A column's `auto_command` becomes a `send_message` automation on enter,
 *    appended after the migrated rows because that is when it ran: every
 *    transition action ran before the fallback spawn, and the message was
 *    delivered after it.
 *
 * Source rows in `actions` and `swimlane_transitions` are left INTACT, so an
 * older build still reads them. `auto_command` is the exception and is cleared,
 * because a message that stayed in both places would have two homes and the
 * board-config writer would have to pick one.
 */

export interface LegacyActionRow {
  id: string;
  name: string;
  type: string;
  config_json: string;
}

export interface LegacyTransitionRow {
  from_swimlane_id: string;
  to_swimlane_id: string;
  action_id: string;
  execution_order: number;
}

export interface LegacyLaneRow {
  id: string;
  name: string;
  auto_command: string | null;
  auto_command_mode: string | null;
}

export interface PlannedAutomation {
  swimlaneId: string;
  name: string;
  type: AutomationType;
  trigger: AutomationTrigger;
  position: number;
  enabled: boolean;
  config: AutomationConfig;
}

export interface AutomationsMigrationPlan {
  automations: PlannedAutomation[];
  /** Retired-type rows dropped, keyed by column name, for the log line. */
  droppedByColumn: Record<string, number>;
  /** Seeded default-prompt `spawn_agent` rows skipped, keyed by column name. */
  skippedSeededSpawnByColumn: Record<string, number>;
  /** Columns whose `auto_command` became a message automation. */
  messageColumnIds: string[];
}

export interface AutomationsMigrationInput {
  lanes: LegacyLaneRow[];
  actions: LegacyActionRow[];
  transitions: LegacyTransitionRow[];
}

/**
 * Decide what the migration will do, without touching the database.
 *
 * Ordering is deliberate and load-bearing: wildcard (`'*'`) rows first, then
 * exact pairs, each set by `execution_order`. Both can name the same action on
 * the same destination, and running the wildcard order first matches what
 * `getTransitionsFor` did, which returned the exact pair's rows if any existed
 * and the wildcard rows otherwise.
 */
export function planAutomationsMigration(input: AutomationsMigrationInput): AutomationsMigrationPlan {
  const actionsById = new Map(input.actions.map((action) => [action.id, action]));
  const laneById = new Map(input.lanes.map((lane) => [lane.id, lane]));

  const plan: AutomationsMigrationPlan = {
    automations: [],
    droppedByColumn: {},
    skippedSeededSpawnByColumn: {},
    messageColumnIds: [],
  };

  /** Per column: the action ids already copied, so a doubly-referenced action lands once. */
  const copiedActionIds = new Map<string, Set<string>>();
  /** Per column: names already used, lowercased, so the unique index can be created after. */
  const usedNames = new Map<string, Set<string>>();

  const ordered = [...input.transitions].sort(compareTransitions);

  for (const transition of ordered) {
    const lane = laneById.get(transition.to_swimlane_id);
    if (!lane) continue; // a transition pointing at a deleted column
    const action = actionsById.get(transition.action_id);
    if (!action) continue;

    if (isRetiredActionType(action.type)) {
      plan.droppedByColumn[lane.name] = (plan.droppedByColumn[lane.name] ?? 0) + 1;
      continue;
    }

    const alreadyCopied = copiedActionIds.get(lane.id) ?? new Set<string>();
    if (alreadyCopied.has(action.id)) continue;

    const converted = convertAction(action);
    if (!converted) {
      if (action.type === 'spawn_agent') {
        plan.skippedSeededSpawnByColumn[lane.name] = (plan.skippedSeededSpawnByColumn[lane.name] ?? 0) + 1;
      }
      continue;
    }

    alreadyCopied.add(action.id);
    copiedActionIds.set(lane.id, alreadyCopied);

    plan.automations.push({
      swimlaneId: lane.id,
      name: uniqueName(usedNames, lane.id, action.name),
      type: converted.type,
      trigger: 'enter',
      position: countFor(plan.automations, lane.id, 'enter'),
      enabled: true,
      config: converted.config,
    });
  }

  // The column's message, appended last, because that is when it ran.
  for (const lane of input.lanes) {
    const message = (lane.auto_command ?? '').trim();
    if (!message) continue;

    plan.automations.push({
      swimlaneId: lane.id,
      name: uniqueName(usedNames, lane.id, 'Message'),
      type: 'send_message',
      trigger: 'enter',
      position: countFor(plan.automations, lane.id, 'enter'),
      enabled: true,
      config: {
        message,
        mode: (lane.auto_command_mode === 'deferred' ? 'deferred' : 'immediate') satisfies AutoCommandMode,
      },
    });
    plan.messageColumnIds.push(lane.id);
  }

  return plan;
}

/** Wildcard source first, then exact pairs, each by its own execution order. */
function compareTransitions(left: LegacyTransitionRow, right: LegacyTransitionRow): number {
  const leftWildcard = left.from_swimlane_id === '*' ? 0 : 1;
  const rightWildcard = right.from_swimlane_id === '*' ? 0 : 1;
  if (leftWildcard !== rightWildcard) return leftWildcard - rightWildcard;
  if (left.execution_order !== right.execution_order) return left.execution_order - right.execution_order;
  return left.action_id.localeCompare(right.action_id);
}

function countFor(automations: PlannedAutomation[], swimlaneId: string, trigger: AutomationTrigger): number {
  return automations.filter((row) => row.swimlaneId === swimlaneId && row.trigger === trigger).length;
}

/**
 * Turn one legacy action into an automation, or null when it should not become
 * one at all.
 */
function convertAction(action: LegacyActionRow): { type: AutomationType; config: AutomationConfig } | null {
  const config = parseConfig(action.config_json);

  switch (action.type) {
    case 'send_command': {
      // The type is renamed: a row whose field is `message` should not be typed
      // `command`. The legacy key is carried so the adapter still reads it.
      const message = (config.command ?? config.message ?? '').trim();
      return { type: 'send_message', config: { message, mode: 'immediate' } };
    }

    case 'run_script': {
      // A script now always runs task-relative, so the setting is dropped
      // rather than translated: 'project' was the default and the reason it
      // existed was to opt INTO the worktree, which is now what happens.
      const next: AutomationConfig = { script: config.script ?? '' };
      return { type: 'run_script', config: next };
    }

    case 'webhook':
      return {
        type: 'webhook',
        config: {
          url: config.url ?? '',
          method: config.method,
          body: config.body,
          headers: config.headers,
        },
      };

    case 'spawn_agent': {
      const migrated = migrateSpawnAgentConfig(config).config;
      const prompt = (migrated.promptTemplate ?? '').trim();
      // The seeded "Start Planning Agent": the fallback spawn already uses this
      // exact template, so keeping it would spawn the agent twice as loudly and
      // teach a new user that starting an agent is an automation, which it is
      // not. Any OTHER prompt is a real customization with no other home.
      if (prompt === DEFAULT_SPAWN_PROMPT_TEMPLATE && migrated.nonInteractive !== true) return null;
      return {
        type: 'spawn_agent',
        config: { agent: migrated.agent, promptTemplate: migrated.promptTemplate, nonInteractive: migrated.nonInteractive },
      };
    }

    default:
      // An action type nothing recognizes. Dropping it matches what
      // `apply-config.ts` already does with an unknown action in a hand-written
      // file: warn and skip, never fail.
      return null;
  }
}

function parseConfig(configJson: string): AutomationConfig {
  try {
    const parsed: unknown = JSON.parse(configJson);
    if (parsed && typeof parsed === 'object') return parsed as AutomationConfig;
  } catch {
    // A malformed config is not worth failing an app launch over.
  }
  return {};
}

/** Names are unique per column, so the unique index can be created after this runs. */
function uniqueName(used: Map<string, Set<string>>, swimlaneId: string, wanted: string): string {
  const taken = used.get(swimlaneId) ?? new Set<string>();
  const base = wanted.trim() || 'Automation';
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base} (${suffix})`;
    suffix += 1;
  }
  taken.add(candidate.toLowerCase());
  used.set(swimlaneId, taken);
  return candidate;
}

const MIGRATION_FLAG = 'automations_migrated_at';

/** Has this database already been migrated? */
export function hasRunAutomationsMigration(db: Database.Database): boolean {
  const row = db.prepare('SELECT value FROM schema_meta WHERE key = ?').get(MIGRATION_FLAG) as
    | { value: string }
    | undefined;
  return row !== undefined;
}

/**
 * Read the legacy rows, plan, write, and flag. Idempotent through
 * `schema_meta`: a second run does nothing, which matters because the source
 * rows are deliberately left in place for an older build to read.
 */
export function runAutomationsMigration(db: Database.Database): AutomationsMigrationPlan | null {
  if (hasRunAutomationsMigration(db)) return null;

  const lanes = db.prepare('SELECT id, name, auto_command, auto_command_mode FROM swimlanes').all() as LegacyLaneRow[];
  const actions = db.prepare('SELECT id, name, type, config_json FROM actions').all() as LegacyActionRow[];
  const transitions = db
    .prepare('SELECT from_swimlane_id, to_swimlane_id, action_id, execution_order FROM swimlane_transitions')
    .all() as LegacyTransitionRow[];

  const plan = planAutomationsMigration({ lanes, actions, transitions });
  const now = new Date().toISOString();

  const insert = db.prepare(`
    INSERT INTO column_automations
      (id, swimlane_id, name, type, trigger, position, enabled, config_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clearMessage = db.prepare(
    "UPDATE swimlanes SET auto_command = NULL, auto_command_mode = 'immediate' WHERE id = ?",
  );
  const flag = db.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)');

  db.transaction(() => {
    for (const automation of plan.automations) {
      insert.run(
        randomUUID(),
        automation.swimlaneId,
        automation.name,
        automation.type,
        automation.trigger,
        automation.position,
        automation.enabled ? 1 : 0,
        JSON.stringify(automation.config),
        now,
        now,
      );
    }
    for (const swimlaneId of plan.messageColumnIds) {
      clearMessage.run(swimlaneId);
    }
    flag.run(MIGRATION_FLAG, now);
  })();

  logPlan(plan);
  return plan;
}

function logPlan(plan: AutomationsMigrationPlan): void {
  if (plan.automations.length > 0) {
    console.log(`[automations] migrated ${plan.automations.length} automation(s) from actions and transitions`);
  }
  for (const [column, count] of Object.entries(plan.droppedByColumn)) {
    console.log(`[automations] dropped ${count} retired action row(s) on "${column}" (each was a no-op or a duplicate of the move path)`);
  }
  for (const [column, count] of Object.entries(plan.skippedSeededSpawnByColumn)) {
    console.log(`[automations] skipped ${count} seeded Start agent row(s) on "${column}" (the column's own setting does this)`);
  }
}
