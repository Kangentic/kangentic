import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type {
  PlanApproval,
  Workflow,
  WorkflowDraft,
  WorkflowDraftLink,
  WorkflowDraftTask,
  WorkflowState,
  WorkflowSupersession,
} from '../../../shared/types';
import { readRunSettings } from '../../../shared/workflow-run-settings';
import { isPlanApproval } from '../../../shared/plan-approval';
import { cachedStatement } from '../statement-cache';

/**
 * The `workflows` table: a set of linked tasks with its own agent, stored in
 * its home project's database.
 *
 * A workflow that has not started holds its planned tasks in `draft_json`
 * rather than as rows on the board, so every board read stays free of planned
 * work; Start validates the draft and creates the tasks (`startWorkflow` in
 * `src/main/workflows/workflow-service.ts`).
 *
 * `revision` goes up on every write that changes what the workflow is, which is
 * what lets `kangentic_save_workflow` refuse a save built on a stale read.
 */
interface WorkflowRow {
  id: string;
  title: string;
  brief: string | null;
  source_task_id: string | null;
  state: string;
  draft_json: string | null;
  color_slot: number;
  revision: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  paused_at?: string | null;
  agent_name: string | null;
  agent_session_id: string | null;
  agent_cwd?: string | null;
  agent_read_project_ids?: string | null;
  plan_approval?: string | null;
}

/** How many colors the categorical palette has (`--kng-chart-1..6`). */
export const WORKFLOW_COLOR_SLOTS = 6;

export const UNTITLED_WORKFLOW = 'Untitled workflow';

/**
 * How the `task_moves` row Start writes for the task a workflow was made from
 * begins (`supersedeSourceTask`), followed by the workflow's title at Start.
 * `listSupersessions` matches on this prefix, never on the title, which a
 * rename changes.
 */
export const SUPERSEDED_MOVE_REASON_PREFIX = 'Superseded by ';

const WORKFLOW_STATES: ReadonlySet<string> = new Set<WorkflowState>(['draft', 'running', 'paused', 'done']);

/** A save carrying a revision the workflow has moved past. */
export class StaleWorkflowRevisionError extends Error {
  constructor(public readonly currentRevision: number) {
    super(`The workflow changed since it was read (now revision ${currentRevision}).`);
    this.name = 'StaleWorkflowRevisionError';
  }
}

export class WorkflowRepository {
  constructor(private db: Database.Database) {}

  getById(id: string): Workflow | undefined {
    const row = this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) as WorkflowRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** Every workflow, newest first. */
  listAll(): Workflow[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY created_at DESC, rowid DESC').all() as WorkflowRow[];
    return rows.map(mapRow);
  }

  /** The workflows the picker lists: every one not finished, newest first. */
  listOpen(): Workflow[] {
    const rows = this.db
      .prepare("SELECT * FROM workflows WHERE state != 'done' ORDER BY created_at DESC, rowid DESC")
      .all() as WorkflowRow[];
    return rows.map(mapRow);
  }

  /**
   * Every task a workflow of this database replaced at Start, by its current
   * title and color, finished workflows included.
   *
   * Read from the move history, not from `source_task_id` alone: Start leaves
   * a source that had left To Do where it is, so a source completed by hand is
   * not superseded. A source is superseded when its LATEST move into a Done
   * column is the one Start wrote: origin `workflow`, the reason prefix, at or
   * after the workflow's start (the two can share a millisecond). That move is
   * credited to the workflow that started last at or before it, since two
   * drafts can share one To Do source and only the first Start moves it. A
   * source moved out of Done and finished again by hand has a newer row and
   * reads as not superseded.
   */
  listSupersessions(): WorkflowSupersession[] {
    const rows = this.db.prepare(`
      SELECT w.id AS workflow_id, w.source_task_id AS source_task_id, w.title AS title, w.color_slot AS color_slot
      FROM workflows w
      JOIN task_moves moves ON moves.rowid = (
        SELECT latest.rowid FROM task_moves latest
        JOIN swimlanes lane ON lane.id = latest.to_swimlane_id
        WHERE latest.task_id = w.source_task_id AND lane.role = 'done'
        ORDER BY latest.at DESC, latest.rowid DESC
        LIMIT 1
      )
      WHERE w.state != 'draft'
        AND w.started_at IS NOT NULL
        AND moves.origin = 'workflow'
        AND substr(moves.reason, 1, ?) = ?
        AND moves.at >= w.started_at
      ORDER BY w.started_at DESC, w.rowid DESC
    `).all(SUPERSEDED_MOVE_REASON_PREFIX.length, SUPERSEDED_MOVE_REASON_PREFIX) as Array<{
      workflow_id: string;
      source_task_id: string;
      title: string;
      color_slot: number;
    }>;
    const bySource = new Map<string, WorkflowSupersession>();
    // Newest start first, so the first row for a source is its superseder.
    for (const row of rows) {
      if (bySource.has(row.source_task_id)) continue;
      bySource.set(row.source_task_id, {
        sourceTaskId: row.source_task_id,
        workflowId: row.workflow_id,
        title: row.title,
        colorSlot: row.color_slot,
      });
    }
    return [...bySource.values()];
  }

  /**
   * Any workflow running or paused: what the engine has to read at all. One
   * indexed probe, so a board with no active workflow pays nothing more. Its
   * statement is prepared once per connection: the engine asks it of every open
   * board on every pass, and compiling it each time cost twice what running it
   * did (50 boards: 0.59 ms against 0.27 ms).
   */
  hasActive(): boolean {
    return cachedStatement(this.db, "SELECT 1 FROM workflows WHERE state IN ('running', 'paused') LIMIT 1").get() !== undefined;
  }

  create(input: { title?: string | null; brief?: string | null; sourceTaskId?: string | null }): Workflow {
    const now = new Date().toISOString();
    const id = uuidv4();
    const title = input.title?.trim() || UNTITLED_WORKFLOW;
    const colorSlot = this.nextColorSlot();
    const emptyDraft: WorkflowDraft = { tasks: [], links: [] };
    this.db.prepare(`
      INSERT INTO workflows (id, title, brief, source_task_id, state, draft_json, color_slot, revision, created_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, 1, ?)
    `).run(id, title, input.brief ?? null, input.sourceTaskId ?? null, JSON.stringify(emptyDraft), colorSlot, now);
    return this.getById(id)!;
  }

  /**
   * Replace a not-started workflow's planned tasks and links (and its title,
   * when given). `expectedRevision`, when given, must be the current one, or
   * the save is refused: the user's edits since the caller read it win.
   */
  saveDraft(id: string, draft: WorkflowDraft, options: { title?: string | null; expectedRevision?: number | null } = {}): Workflow {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Workflow ${id} not found`);
    if (existing.state !== 'draft') throw new Error('Only a workflow that has not started has a plan to replace.');
    if (options.expectedRevision != null && options.expectedRevision !== existing.revision) {
      throw new StaleWorkflowRevisionError(existing.revision);
    }
    const title = options.title?.trim() || existing.title;
    this.db.prepare('UPDATE workflows SET title = ?, draft_json = ?, revision = revision + 1 WHERE id = ?')
      .run(title, JSON.stringify(draft), id);
    return this.getById(id)!;
  }

  /**
   * Store where hands placed a not-started workflow's cards, and nothing else.
   * The revision stays as it is: moving a card changes no plan, so a save the
   * workflow agent built on its last read must still go through (#732 board 2c).
   */
  writeDraftLayout(id: string, draft: WorkflowDraft): void {
    this.db.prepare("UPDATE workflows SET draft_json = ? WHERE id = ? AND state = 'draft'").run(JSON.stringify(draft), id);
  }

  rename(id: string, title: string): Workflow {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('A workflow needs a name.');
    this.db.prepare('UPDATE workflows SET title = ?, revision = revision + 1 WHERE id = ?').run(trimmed, id);
    const workflow = this.getById(id);
    if (!workflow) throw new Error(`Workflow ${id} not found`);
    return workflow;
  }

  /** Started: the draft is spent (its tasks now exist), and the start is stamped. */
  markStarted(id: string): void {
    this.db.prepare(
      "UPDATE workflows SET state = 'running', draft_json = NULL, started_at = ?, revision = revision + 1 WHERE id = ?",
    ).run(new Date().toISOString(), id);
  }

  /** Done stamps `finished_at`; paused stamps `paused_at`, which any other state clears. */
  setState(id: string, state: Exclude<WorkflowState, 'draft'>): void {
    const now = new Date().toISOString();
    const finishedAt = state === 'done' ? now : null;
    const pausedAt = state === 'paused' ? now : null;
    this.db.prepare('UPDATE workflows SET state = ?, finished_at = ?, paused_at = ?, revision = revision + 1 WHERE id = ?')
      .run(state, finishedAt, pausedAt, id);
  }

  /** Any change to a started workflow's tasks, links or routes. */
  bumpRevision(id: string): void {
    this.db.prepare('UPDATE workflows SET revision = revision + 1 WHERE id = ?').run(id);
  }

  /**
   * The agent conversation the workflow's agent resumes by. Changes no plan, so
   * the revision stays; null forgets it, so the next open starts a new one. A
   * null `agentSessionId` records an agent that ran whose own id is not known
   * yet: its next start continues from the saved plan unless the id arrives.
   */
  setAgentConversation(id: string, conversation: { agentName: string; agentSessionId: string | null; cwd: string } | null): void {
    this.db.prepare('UPDATE workflows SET agent_name = ?, agent_session_id = ?, agent_cwd = ? WHERE id = ?')
      .run(conversation?.agentName ?? null, conversation?.agentSessionId ?? null, conversation?.cwd ?? null, id);
  }

  /**
   * Forget the conversation id only, keeping the agent and checkout that ran:
   * the CLI could not find the conversation, so the next start begins a new
   * one from the saved plan, whichever start that turns out to be.
   */
  forgetAgentSessionId(id: string): void {
    this.db.prepare('UPDATE workflows SET agent_session_id = NULL WHERE id = ?').run(id);
  }

  /**
   * Who approves plans for this workflow's tasks; null follows its plan columns.
   * Changes no plan, so the revision stays, like the agent conversation above: a
   * save the workflow agent built on its last read must still go through.
   */
  setPlanApproval(id: string, planApproval: PlanApproval | null): void {
    this.db.prepare('UPDATE workflows SET plan_approval = ? WHERE id = ?').run(planApproval, id);
  }

  /** The agent's PTY grid, on every resize the desktop makes. Changes no plan, so the revision stays. */
  setAgentGrid(id: string, grid: { cols: number; rows: number }): void {
    this.db.prepare('UPDATE workflows SET agent_pty_cols = ?, agent_pty_rows = ? WHERE id = ?').run(grid.cols, grid.rows, id);
  }

  /** The agent's last recorded PTY grid, or null before it has one. */
  getAgentGrid(id: string): { cols: number; rows: number } | null {
    const row = this.db.prepare('SELECT agent_pty_cols, agent_pty_rows FROM workflows WHERE id = ?')
      .get(id) as { agent_pty_cols: number | null; agent_pty_rows: number | null } | undefined;
    if (row?.agent_pty_cols == null || row.agent_pty_rows == null) return null;
    return { cols: row.agent_pty_cols, rows: row.agent_pty_rows };
  }

  /**
   * Let the workflow agent read another registered project, from now on. Changes
   * no plan, so the revision stays. Returns false when it already could.
   */
  addAgentReadProject(id: string, projectId: string): boolean {
    const current = this.getById(id);
    if (!current || current.agent_read_project_ids.includes(projectId)) return false;
    this.db.prepare('UPDATE workflows SET agent_read_project_ids = ? WHERE id = ?')
      .run(JSON.stringify([...current.agent_read_project_ids, projectId]), id);
    return true;
  }

  /** Its links cascade with it (`task_links.workflow_id`). */
  delete(id: string): void {
    this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id);
  }

  /**
   * The first palette slot no unfinished workflow holds; with all six taken,
   * the one whose latest holder is oldest. Stable per workflow once chosen.
   */
  private nextColorSlot(): number {
    const rows = this.db
      .prepare('SELECT color_slot, state, created_at FROM workflows')
      .all() as Array<{ color_slot: number; state: string; created_at: string }>;
    const held = new Set(rows.filter((row) => row.state !== 'done').map((row) => row.color_slot));
    for (let slot = 1; slot <= WORKFLOW_COLOR_SLOTS; slot++) {
      if (!held.has(slot)) return slot;
    }
    const latestUse = new Map<number, string>();
    for (const row of rows) {
      const previous = latestUse.get(row.color_slot);
      if (!previous || row.created_at > previous) latestUse.set(row.color_slot, row.created_at);
    }
    let chosen = 1;
    let oldest: string | null = null;
    for (let slot = 1; slot <= WORKFLOW_COLOR_SLOTS; slot++) {
      const used = latestUse.get(slot) ?? '';
      if (oldest === null || used < oldest) {
        oldest = used;
        chosen = slot;
      }
    }
    return chosen;
  }
}

function mapRow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    source_task_id: row.source_task_id,
    // An unknown state read by this build (a newer one wrote it) is left alone
    // by the engine rather than run: it reads as paused.
    state: WORKFLOW_STATES.has(row.state) ? (row.state as WorkflowState) : 'paused',
    draft: parseDraft(row.draft_json),
    color_slot: row.color_slot,
    revision: row.revision,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    paused_at: row.paused_at ?? null,
    agent_name: row.agent_name ?? null,
    agent_session_id: row.agent_session_id ?? null,
    agent_cwd: row.agent_cwd ?? null,
    agent_read_project_ids: parseProjectIds(row.agent_read_project_ids),
    // Narrowed: anything this build does not know follows the columns.
    plan_approval: isPlanApproval(row.plan_approval) ? row.plan_approval : null,
  };
}

/** A stored list of project ids; anything malformed reads as none. */
function parseProjectIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/** Read a stored draft defensively: a malformed entry is dropped, never thrown. */
export function parseDraft(raw: string | null): WorkflowDraft | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { tasks: [], links: [] };
  }
  if (typeof parsed !== 'object' || parsed === null) return { tasks: [], links: [] };
  const record = parsed as { tasks?: unknown; links?: unknown };
  const tasks = Array.isArray(record.tasks) ? record.tasks.flatMap(readDraftTask) : [];
  const links = Array.isArray(record.links) ? record.links.flatMap(readDraftLink) : [];
  return { tasks, links };
}

function readDraftTask(value: unknown): WorkflowDraftTask[] {
  if (typeof value !== 'object' || value === null) return [];
  const entry = value as Record<string, unknown>;
  if (typeof entry.key !== 'string' || typeof entry.title !== 'string') return [];
  const stringOrNull = (field: unknown): string | null => (typeof field === 'string' && field ? field : null);
  const numberOrNull = (field: unknown): number | null => (typeof field === 'number' && Number.isFinite(field) ? field : null);
  return [{
    key: entry.key,
    title: entry.title,
    description: typeof entry.description === 'string' ? entry.description : '',
    project_id: stringOrNull(entry.project_id),
    existing_task_id: stringOrNull(entry.existing_task_id),
    route_start_swimlane_id: stringOrNull(entry.route_start_swimlane_id),
    route_last_swimlane_id: stringOrNull(entry.route_last_swimlane_id),
    skipped_swimlane_ids: Array.isArray(entry.skipped_swimlane_ids)
      ? entry.skipped_swimlane_ids.filter((id): id is string => typeof id === 'string')
      : [],
    labels: Array.isArray(entry.labels) ? entry.labels.filter((label): label is string => typeof label === 'string') : [],
    priority: typeof entry.priority === 'number' ? entry.priority : 0,
    canvas_x: numberOrNull(entry.canvas_x),
    canvas_y: numberOrNull(entry.canvas_y),
    // A draft saved before a planned task had run settings reads as the default.
    ...readRunSettings(entry),
  }];
}

function readDraftLink(value: unknown): WorkflowDraftLink[] {
  if (typeof value !== 'object' || value === null) return [];
  const entry = value as Record<string, unknown>;
  if (typeof entry.blocker !== 'string' || typeof entry.blocked !== 'string') return [];
  return [{ blocker: entry.blocker, blocked: entry.blocked }];
}
