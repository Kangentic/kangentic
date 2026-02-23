import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectDb } from '../db/database';
import { SessionRepository } from '../db/repositories/session-repository';
import { TaskRepository } from '../db/repositories/task-repository';
import { SkillRepository } from '../db/repositories/skill-repository';
import { SessionManager } from '../pty/session-manager';
import { ClaudeDetector } from '../agent/claude-detector';
import { CommandBuilder } from '../agent/command-builder';
import { ConfigManager } from '../config/config-manager';
import type { SessionRecord, SkillConfig } from '../../shared/types';
import { ensureWorktreeTrust } from '../agent/trust-manager';

// ---------------------------------------------------------------------------
// Shared helper: determine which swimlane IDs should have active agents
// ---------------------------------------------------------------------------

/**
 * Return the set of swimlane IDs that should have active agent sessions.
 *
 * A swimlane is an "agent lane" if at least one transition with a
 * `spawn_agent` skill targets it (`to_swimlane_id`).
 *
 * Currently: Planning, Running.
 * Future:    A Review/PR column may be added.
 *
 * Both `recoverSessions` and `reconcileSessions` use this as their single
 * source of truth so the logic for "should this task have an agent?" is
 * defined in exactly one place.
 */
function getAgentSwimlaneIds(skillRepo: SkillRepository): Set<string> {
  const transitions = skillRepo.listTransitions();
  const skills = skillRepo.list();

  const ids = new Set<string>();
  for (const t of transitions) {
    const skill = skills.find((s) => s.id === t.skill_id);
    if (skill?.type === 'spawn_agent') {
      ids.add(t.to_swimlane_id);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Session recovery (resume suspended / orphaned sessions)
// ---------------------------------------------------------------------------

/**
 * Recover suspended and orphaned Claude agent sessions on project open.
 *
 * Steps:
 *  1. Mark any leftover 'running' DB records as 'orphaned' (crash recovery).
 *  2. Collect all suspended + orphaned `claude_agent` session records.
 *  3. Deduplicate: keep only the LATEST record per task_id.
 *     Mark all older duplicates as exited. This prevents compounding on
 *     repeated restarts.
 *  4. For each candidate, verify the task exists AND is in an agent-active
 *     column. Skip and mark exited otherwise.
 *  5. Spawn a new PTY with `--session-id` to let Claude CLI resume.
 *  6. Mark old records as exited; insert fresh records for the new PTYs.
 */
export async function recoverSessions(
  projectId: string,
  projectPath: string,
  sessionManager: SessionManager,
  claudeDetector: ClaudeDetector,
  commandBuilder: CommandBuilder,
  configManager: ConfigManager,
): Promise<void> {
  const db = getProjectDb(projectId);
  const sessionRepo = new SessionRepository(db);
  const taskRepo = new TaskRepository(db);
  const skillRepo = new SkillRepository(db);

  // 1. Mark leftover 'running' records as orphaned (crash case).
  //    SKIP records whose task already has a live PTY session — this prevents
  //    re-entrant calls (Vite hot-reload, duplicate PROJECT_OPEN) from
  //    orphaning sessions that were JUST created and are actively running.
  const liveTaskIds = new Set(
    sessionManager.listSessions()
      .filter(s => s.status === 'running' || s.status === 'queued')
      .map(s => s.taskId),
  );
  if (liveTaskIds.size > 0) {
    sessionRepo.markRunningAsOrphanedExcluding(liveTaskIds);
  } else {
    sessionRepo.markAllRunningAsOrphaned();
  }

  // 2. Gather ALL recoverable session records
  const suspended = sessionRepo.getResumable();
  const orphaned = sessionRepo.getOrphaned();
  const allRecords = [...suspended, ...orphaned];
  if (allRecords.length === 0) return;

  // 3. Deduplicate: for each task_id, keep only the most recent record.
  //    Mark all older duplicates as exited immediately.
  const now = new Date().toISOString();
  const latestByTask = new Map<string, SessionRecord>();

  for (const record of allRecords) {
    const existing = latestByTask.get(record.task_id);
    if (!existing) {
      latestByTask.set(record.task_id, record);
    } else {
      // Keep whichever has the later started_at; retire the other
      const existingTime = existing.started_at || '';
      const recordTime = record.started_at || '';
      if (recordTime > existingTime) {
        // New record is newer — retire the old one
        sessionRepo.updateStatus(existing.id, 'exited', { exited_at: now });
        latestByTask.set(record.task_id, record);
      } else {
        // Existing is newer — retire this one
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
      }
    }
  }

  const toRecover = Array.from(latestByTask.values());
  const duplicatesRetired = allRecords.length - toRecover.length;
  if (duplicatesRetired > 0) {
    console.log(
      `Session recovery: retired ${duplicatesRetired} duplicate record(s)`,
    );
  }

  // 4. Determine which columns should have active agents
  const agentLaneIds = getAgentSwimlaneIds(skillRepo);

  // Cache transitions and skills for prompt lookup during recovery
  const allTransitions = skillRepo.listTransitions();
  const allSkills = skillRepo.list();

  // Detect Claude CLI once
  const config = configManager.getEffectiveConfig(projectPath);
  const claude = await claudeDetector.detect(config.claude.cliPath);
  if (!claude.found || !claude.path) {
    console.warn(
      'Session recovery: Claude CLI not found — skipping',
      toRecover.length,
      'session(s)',
    );
    return;
  }

  let recovered = 0;
  let skipped = 0;

  for (const record of toRecover) {
    try {
      // --- Guard: task already has a live PTY session ---
      // Skip if the task is already being served by an active PTY process
      // (e.g. re-entrant call from Vite hot-reload or duplicate PROJECT_OPEN).
      if (liveTaskIds.has(record.task_id)) {
        skipped++;
        continue;
      }

      // --- Guard: task must still exist ---
      const task = taskRepo.getById(record.task_id);
      if (!task) {
        console.log(
          `Session recovery: task ${record.task_id} deleted — marking exited`,
        );
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
        skipped++;
        continue;
      }

      // --- Guard: task must be in an agent-active column ---
      // If the task is in a non-agent column but the session is 'suspended',
      // leave it as-is so that moving the task back into an agent column can
      // resume the conversation via --resume. Only orphaned records (crash
      // recovery) get marked exited when outside agent columns.
      if (!agentLaneIds.has(task.swimlane_id)) {
        if (record.status === 'suspended') {
          console.log(
            `Session recovery: task ${record.task_id} not in agent column — preserving suspended status for future resume`,
          );
        } else {
          console.log(
            `Session recovery: task ${record.task_id} not in agent column — marking exited`,
          );
          sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
        }
        skipped++;
        continue;
      }

      // --- Guard: CWD must still exist ---
      if (!fs.existsSync(record.cwd)) {
        console.log(
          `Session recovery: cwd ${record.cwd} missing — marking exited`,
        );
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
        skipped++;
        continue;
      }

      // Pre-populate trust for worktree paths
      if (record.cwd !== projectPath) {
        ensureWorktreeTrust(record.cwd);
      }

      // Always use the CURRENT config permission mode, not the stale value
      // from the old session record (which may be outdated after settings change).
      const permissionMode = config.claude.permissionMode;

      // Decide whether to resume or start fresh.
      // Both SUSPENDED (clean shutdown) and ORPHANED (crash) sessions can
      // attempt --resume as long as the claude_session_id is known — the
      // JSONL file is usually intact. If the file is missing or corrupt,
      // Claude CLI will error and the session exits; reconciliation will
      // create a fresh one on the next app launch.
      const canResume = (record.status === 'suspended' || record.status === 'orphaned')
        && !!record.claude_session_id;

      let prompt: string | undefined;
      let claudeSessionId: string;

      if (canResume) {
        // Resume existing Claude conversation — no extra prompt needed
        claudeSessionId = record.claude_session_id!;
        prompt = undefined;
      } else {
        // Fresh session (orphaned or no prior session ID)
        claudeSessionId = randomUUID();

        // Find the spawn_agent skill that targets this task's lane
        const incomingTransition = allTransitions.find(
          (t) =>
            t.to_swimlane_id === task.swimlane_id &&
            allSkills.find((s) => s.id === t.skill_id)?.type === 'spawn_agent',
        );
        const skill = incomingTransition
          ? allSkills.find((s) => s.id === incomingTransition.skill_id)
          : undefined;
        let skillConfig: SkillConfig | undefined;
        if (skill) {
          try {
            skillConfig = JSON.parse(skill.config_json) as SkillConfig;
          } catch {
            console.error(`Session recovery: malformed config for skill ${skill.id} — using defaults`);
          }
        }

        prompt = skillConfig?.promptTemplate
          ? commandBuilder.interpolateTemplate(skillConfig.promptTemplate, {
              title: task.title,
              description: task.description,
              taskId: task.id,
              worktreePath: task.worktree_path || '',
              branchName: task.branch_name || '',
            })
          : `Task: ${task.title}\n\n${task.description}`;
      }

      // Ensure the status output directory exists
      const statusDir = path.join(projectPath, '.kangentic', 'status');
      fs.mkdirSync(statusDir, { recursive: true });
      const statusOutputPath = path.join(statusDir, `${claudeSessionId}.json`);

      const command = commandBuilder.buildClaudeCommand({
        claudePath: claude.path,
        taskId: task.id,
        prompt,
        cwd: record.cwd,
        permissionMode: permissionMode as any,
        projectRoot: projectPath,
        sessionId: claudeSessionId,
        resume: canResume,
        statusOutputPath,
      });

      // Spawn a new PTY
      const newSession = await sessionManager.spawn({
        taskId: task.id,
        command,
        cwd: record.cwd,
        statusOutputPath,
      });

      // Mark old record as exited
      sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });

      // Insert new record for the resumed session
      sessionRepo.insert({
        task_id: task.id,
        session_type: 'claude_agent',
        claude_session_id: claudeSessionId,
        command,
        cwd: record.cwd,
        permission_mode: permissionMode,
        prompt: prompt ?? null,
        status: 'running',
        exit_code: null,
        started_at: now,
        suspended_at: null,
        exited_at: null,
      });

      // Update the task's session_id to point to the new PTY
      taskRepo.update({
        id: task.id,
        session_id: newSession.id,
      });

      recovered++;
    } catch (err) {
      console.error(
        `Session recovery failed for session ${record.id} (task ${record.task_id}):`,
        err,
      );
      try {
        sessionRepo.updateStatus(record.id, 'exited', { exited_at: now });
      } catch (updateErr) {
        console.error(`Failed to mark session ${record.id} as exited:`, updateErr);
      }
    }
  }

  if (recovered > 0 || skipped > 0) {
    console.log(
      `Session recovery: resumed ${recovered}, skipped ${skipped} (of ${toRecover.length} unique tasks, ${allRecords.length} total records)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Session reconciliation (spawn fresh agents for orphaned tasks)
// ---------------------------------------------------------------------------

/**
 * Reconcile sessions on project open: find tasks in agent-active columns
 * that don't have a running PTY session, and spawn one.
 *
 * This handles the case where a task is in Planning/Running but has no
 * session (e.g., session exited, app closed without suspend, or the task
 * was placed there manually).
 *
 * Only columns returned by `getAgentSwimlaneIds()` are considered.
 */
export async function reconcileSessions(
  projectId: string,
  projectPath: string,
  sessionManager: SessionManager,
  claudeDetector: ClaudeDetector,
  commandBuilder: CommandBuilder,
  configManager: ConfigManager,
): Promise<void> {
  const db = getProjectDb(projectId);
  const taskRepo = new TaskRepository(db);
  const skillRepo = new SkillRepository(db);
  const sessionRepo = new SessionRepository(db);
  const config = configManager.getEffectiveConfig(projectPath);

  // Determine which columns should have active agents
  const agentLaneIds = getAgentSwimlaneIds(skillRepo);
  if (agentLaneIds.size === 0) return;

  // Build set of task IDs that already have a running PTY session
  const activePtySessions = sessionManager.listSessions();
  const activeTaskIds = new Set(
    activePtySessions
      .filter((s) => s.status === 'running')
      .map((s) => s.taskId),
  );

  // Cache transitions and skills for building commands
  const allTransitions = skillRepo.listTransitions();
  const allSkills = skillRepo.list();

  let reconciled = 0;
  for (const laneId of agentLaneIds) {
    const tasks = taskRepo.list(laneId);
    for (const task of tasks) {
      if (activeTaskIds.has(task.id)) continue; // already has a session

      try {
        // Find a spawn_agent transition that targets this lane
        const incomingTransition = allTransitions.find(
          (t) =>
            t.to_swimlane_id === laneId &&
            allSkills.find((s) => s.id === t.skill_id)?.type === 'spawn_agent',
        );
        if (!incomingTransition) continue;

        const skill = allSkills.find(
          (s) => s.id === incomingTransition.skill_id,
        );
        if (!skill) continue;

        let skillConfig: SkillConfig;
        try {
          skillConfig = JSON.parse(skill.config_json);
        } catch {
          console.error(`Session reconciliation: malformed config for skill ${skill.id} — skipping`);
          continue;
        }
        const permissionMode =
          skillConfig.permissionMode || config.claude.permissionMode;
        const cwd = task.worktree_path || projectPath;

        // Guard: CWD must still exist
        if (!fs.existsSync(cwd)) {
          console.log(
            `Session reconciliation: cwd ${cwd} missing — skipping task ${task.id}`,
          );
          continue;
        }

        // Pre-populate trust for worktree paths
        if (cwd !== projectPath) {
          ensureWorktreeTrust(cwd);
        }

        const claude = await claudeDetector.detect(config.claude.cliPath);
        if (!claude.found || !claude.path) {
          console.warn(
            `Session reconciliation: Claude CLI not found — skipping task ${task.id}`,
          );
          continue;
        }

        // Generate a Claude session ID upfront so recovery can resume
        const claudeSessionId = randomUUID();
        const prompt = skillConfig.promptTemplate
          ? commandBuilder.interpolateTemplate(skillConfig.promptTemplate, {
              title: task.title,
              description: task.description,
              taskId: task.id,
              worktreePath: task.worktree_path || '',
              branchName: task.branch_name || '',
            })
          : `Task: ${task.title}\n\n${task.description}`;

        // Ensure the status output directory exists
        const statusDir = path.join(projectPath, '.kangentic', 'status');
        fs.mkdirSync(statusDir, { recursive: true });
        const statusOutputPath = path.join(statusDir, `${claudeSessionId}.json`);

        const command = commandBuilder.buildClaudeCommand({
          claudePath: claude.path,
          taskId: task.id,
          prompt,
          cwd,
          permissionMode: permissionMode as any,
          projectRoot: projectPath,
          sessionId: claudeSessionId,
          statusOutputPath,
        });

        const session = await sessionManager.spawn({
          taskId: task.id,
          command,
          cwd,
          statusOutputPath,
        });

        taskRepo.update({
          id: task.id,
          session_id: session.id,
          agent: skillConfig.agent || 'claude',
        });

        sessionRepo.insert({
          task_id: task.id,
          session_type: 'claude_agent',
          claude_session_id: claudeSessionId,
          command,
          cwd,
          permission_mode: permissionMode,
          prompt,
          status: 'running',
          exit_code: null,
          started_at: new Date().toISOString(),
          suspended_at: null,
          exited_at: null,
        });

        reconciled++;
      } catch (err) {
        console.error(
          `Session reconciliation failed for task ${task.id}:`,
          err,
        );
      }
    }
  }

  if (reconciled > 0) {
    console.log(
      `Session reconciliation: spawned ${reconciled} session(s) for tasks without agents`,
    );
  }
}
