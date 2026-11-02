import type Database from 'better-sqlite3';

export interface CommandTerminalHistoryRow {
  agent_session_id: string;
  agent_name: string;
  label: string | null;
  /** The first thing typed into the conversation, one line; null until something was. */
  first_prompt: string | null;
  cwd: string;
  started_at: string;
  touched_at: string | null;
  ended_at: string | null;
  updated_at: string;
  /** Where the conversation's CLI ran when it was not this machine (`StoredCliTarget` JSON), or null. */
  cli_target: string | null;
  /** 1 once a user chose or cleared this conversation's name, so the namer stays off. */
  named_by_user: number;
  /** The slot the terminal last held (`slot-N`), or null for a row from before the column. */
  slot: string | null;
  /** The `KANGENTIC_TASK_ID` the terminal last ran with, or null for a row from before the column. */
  task_tag: string | null;
  /** The grid the terminal last had on the desktop, or null until it had one. */
  last_pty_cols: number | null;
  last_pty_rows: number | null;
  /** What the terminal's context bar set, or null for the project's default. */
  model: string | null;
  effort: string | null;
}

const COLUMNS = 'agent_session_id, agent_name, label, first_prompt, cwd, started_at, touched_at, ended_at, updated_at, cli_target, named_by_user, slot, task_tag, last_pty_cols, last_pty_rows, model, effort';

/**
 * The conversations a project's Command Terminals held (migration 91). Written
 * from main as a terminal's agent reports its session id, is used, is named and
 * ends (`CommandTerminalHistory`), and read for the panel's Earlier list and a
 * resume.
 */
export class CommandTerminalHistoryRepository {
  constructor(private db: Database.Database) {}

  /**
   * Record a conversation when its terminal's agent reports its id. A row that
   * already exists (a resumed conversation reports the same id again) keeps its
   * start and touch, and takes the newest cwd, agent and CLI target. The slot,
   * tag, grid, model and effort take the new value when there is one: a resumed
   * terminal reports its id before anything seeds what it knows, so a null here
   * must not wipe what the row saved.
   */
  recordConversation(entry: {
    agentSessionId: string;
    agentName: string;
    cwd: string;
    label: string | null;
    touched: boolean;
    cliTarget?: string | null;
    slot?: string | null;
    taskTag?: string | null;
    grid?: { cols: number; rows: number } | null;
    model?: string | null;
    effort?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO command_terminal_history (${COLUMNS})
      VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_session_id) DO UPDATE SET
        agent_name = excluded.agent_name,
        cwd = excluded.cwd,
        label = COALESCE(command_terminal_history.label, excluded.label),
        touched_at = COALESCE(command_terminal_history.touched_at, excluded.touched_at),
        ended_at = NULL,
        updated_at = excluded.updated_at,
        cli_target = excluded.cli_target,
        slot = COALESCE(excluded.slot, command_terminal_history.slot),
        task_tag = COALESCE(excluded.task_tag, command_terminal_history.task_tag),
        last_pty_cols = COALESCE(excluded.last_pty_cols, command_terminal_history.last_pty_cols),
        last_pty_rows = COALESCE(excluded.last_pty_rows, command_terminal_history.last_pty_rows),
        model = COALESCE(excluded.model, command_terminal_history.model),
        effort = COALESCE(excluded.effort, command_terminal_history.effort)
    `).run(
      entry.agentSessionId,
      entry.agentName,
      entry.label,
      entry.cwd,
      now,
      entry.touched ? now : null,
      now,
      entry.cliTarget ?? null,
      entry.slot ?? null,
      entry.taskTag ?? null,
      entry.grid?.cols ?? null,
      entry.grid?.rows ?? null,
      entry.model ?? null,
      entry.effort ?? null,
    );
  }

  /** The terminal's grid changed on the desktop. */
  setGrid(agentSessionId: string, grid: { cols: number; rows: number }): void {
    this.db.prepare(
      'UPDATE command_terminal_history SET last_pty_cols = ?, last_pty_rows = ? WHERE agent_session_id = ?',
    ).run(grid.cols, grid.rows, agentSessionId);
  }

  /** The terminal's context bar set a model or an effort. A null leaves the saved value. */
  setRuntimeSettings(agentSessionId: string, settings: { model: string | null; effort: string | null }): void {
    this.db.prepare(
      'UPDATE command_terminal_history SET model = COALESCE(?, model), effort = COALESCE(?, effort) WHERE agent_session_id = ?',
    ).run(settings.model, settings.effort, agentSessionId);
  }

  /** The terminal was used: its conversation is worth offering back. */
  markTouched(agentSessionId: string): void {
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE command_terminal_history SET touched_at = COALESCE(touched_at, ?), updated_at = ? WHERE agent_session_id = ?',
    ).run(now, now, agentSessionId);
  }

  /**
   * The terminal's name, as it changed: the derived name when it arrives, or
   * the user's rename. Last write wins, and null clears it, so the row reads as
   * its first prompt again. `CommandTerminalHistory` writes only a CHANGE of the
   * live name, so a conversation `/resume`d into a terminal keeps its own name
   * until the terminal is renamed. `namedByUser` marks a user's choice, a clear
   * included, and a later write never takes the mark off.
   */
  setLabel(agentSessionId: string, label: string | null, namedByUser = false): void {
    this.db.prepare(
      'UPDATE command_terminal_history SET label = ?, named_by_user = MAX(named_by_user, ?) WHERE agent_session_id = ?',
    ).run(label, namedByUser ? 1 : 0, agentSessionId);
  }

  /** The conversation's first prompt. First write wins, so a resume keeps the original. */
  setFirstPrompt(agentSessionId: string, firstPrompt: string): void {
    this.db.prepare(
      'UPDATE command_terminal_history SET first_prompt = COALESCE(first_prompt, ?) WHERE agent_session_id = ?',
    ).run(firstPrompt, agentSessionId);
  }

  /**
   * The conversation ended: its terminal stopped, or the agent moved the
   * terminal to another conversation. A row nobody used is deleted, since there
   * is nothing in it to resume.
   */
  markEnded(agentSessionId: string, endedAt: string = new Date().toISOString()): void {
    this.db.prepare('DELETE FROM command_terminal_history WHERE agent_session_id = ? AND touched_at IS NULL').run(agentSessionId);
    this.db.prepare(
      'UPDATE command_terminal_history SET ended_at = ?, updated_at = ? WHERE agent_session_id = ?',
    ).run(endedAt, endedAt, agentSessionId);
  }

  delete(agentSessionId: string): void {
    this.db.prepare('DELETE FROM command_terminal_history WHERE agent_session_id = ?').run(agentSessionId);
  }

  /**
   * Delete the rows nobody used and no live terminal holds. An ended unused
   * row is deleted by `markEnded`, but a terminal open at a quit is never
   * ended (a quit removes no row), so its unused row would stay for good.
   */
  deleteUnusedExcept(liveAgentSessionIds: ReadonlySet<string>): void {
    const unused = this.db.prepare(
      'SELECT agent_session_id FROM command_terminal_history WHERE touched_at IS NULL AND ended_at IS NULL',
    ).all() as Array<{ agent_session_id: string }>;
    const remove = this.db.prepare('DELETE FROM command_terminal_history WHERE agent_session_id = ?');
    for (const row of unused) {
      if (!liveAgentSessionIds.has(row.agent_session_id)) remove.run(row.agent_session_id);
    }
  }

  get(agentSessionId: string): CommandTerminalHistoryRow | null {
    const row = this.db.prepare(
      `SELECT ${COLUMNS} FROM command_terminal_history WHERE agent_session_id = ?`,
    ).get(agentSessionId) as CommandTerminalHistoryRow | undefined;
    return row ?? null;
  }

  /**
   * Used conversations, newest first. A row with no `ended_at` belongs to a
   * terminal still open or one open at the last quit (a quit removes no row);
   * the caller leaves out the ones still live. No LIMIT: the caller deletes a
   * row whose transcript is gone, so the agent's own cleanup bounds the table.
   */
  listUsed(): CommandTerminalHistoryRow[] {
    return this.db.prepare(
      `SELECT ${COLUMNS} FROM command_terminal_history
       WHERE touched_at IS NOT NULL
       ORDER BY COALESCE(ended_at, updated_at) DESC, rowid DESC`,
    ).all() as CommandTerminalHistoryRow[];
  }

  /**
   * Used conversations no end was recorded for, newest first: what was running
   * at the last quit, crash or OS kill, which is what a restart brings back.
   */
  listOpenUsed(): CommandTerminalHistoryRow[] {
    return this.db.prepare(
      `SELECT ${COLUMNS} FROM command_terminal_history
       WHERE touched_at IS NOT NULL AND ended_at IS NULL
       ORDER BY updated_at DESC, rowid DESC`,
    ).all() as CommandTerminalHistoryRow[];
  }

  /**
   * Whether a board task or a workflow already owns this conversation. A
   * `/resume` inside a terminal can switch to one, and that conversation
   * belongs to its card, not to the terminal's history.
   */
  isOwnedElsewhere(agentSessionId: string): boolean {
    if (this.db.prepare('SELECT 1 FROM sessions WHERE agent_session_id = ? LIMIT 1').get(agentSessionId)) return true;
    return this.db.prepare('SELECT 1 FROM workflows WHERE agent_session_id = ? LIMIT 1').get(agentSessionId) !== undefined;
  }
}
