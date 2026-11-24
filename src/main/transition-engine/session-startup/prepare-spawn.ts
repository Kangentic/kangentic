import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { conversationAccountOf, resolveSpawnAccount, resumeAccountMatch } from '../../accounts/account-service';
import { buildSessionEnv } from '../../accounts/account-env';
import { agentRegistry } from '../../agent/agent-registry';
import { trackEvent } from '../../analytics/analytics';
import type { AgentAdapter } from '../../agent/agent-adapter';
import type { McpHttpServerHandle } from '../../agent/mcp-http-server';
import { appendCallerSession } from '../../agent/mcp-http/caller-url';
import { resolveBrowserAutomationConfig } from '../../browser/browser-automation-config';
import type { AppConfig, BoardProfile, PermissionMode, ResumeEvidenceSummary, SessionIdCreationOutcome, SessionRecord, SpawnRemote, StoredCliTarget, Swimlane, Task } from '../../../shared/types';
import { pullHostFilesFor, pushHostFilesForSpawn, withHostFilePull, type HostFilePull } from '../../remote/host-file-sync';
import { resolveSpawnCli } from '../../remote/remote-launch';
import type { TaskRepository } from '../../db/repositories/task-repository';
import { runSpawnPreamble, resolveEffectivePermissionMode, keepsSessionPermissionMode, projectModelDefaultsApply } from '../spawn-preamble';
import { applyProfileToLane, findTaskProfile } from '../column-strategy';
import { sessionOutputPaths } from '../session-paths';
import { notePlanApprovalSpawn, planSpawnNeedsBypass } from '../../plan-approval/plan-approval-spawns';
import { reconcileResumeAgentSessionId } from '../resume-id-reconcile';
import { isResumeEligible } from '../spawn-intent';
import { assessResumeConversationWithEvidence, owedPromptOf, resolveResumeLineage, type StartOverReason } from '../resume-conversation-guard';
import type { SessionRepository } from '../../db/repositories/session-repository';
import {
  buildExpiredConversationRecap,
  type ExpiredConversationRecapSources,
} from '../../agent/shared/expired-conversation-recap';
import { resolveExecutionTarget } from '../../agent/shared/execution-target';
import { resolveLaunchOptions } from '../../agent/shared/launch-options';
import { resolveShimLaunch } from '../../agent/shared/shim-launch';
import { resolveFreshAgentSessionId } from '../../agent/shared/fresh-agent-session-id';
import { shellForTarget, toStoredCliTarget } from '../../agent/shared/cli-target';
import { releaseCommandHold } from '../../pty/lifecycle/adapter-lifecycle';

/**
 * Fully-prepared agent spawn: the adapter has been resolved, the CLI
 * detected, the session directory created, and the command built. The
 * caller hands this to `SessionManager.spawn()` with minimal extra work.
 */
export interface PreparedSpawn {
  adapter: AgentAdapter;
  agent: string;
  command: string;
  cwd: string;
  /** PTY session UUID. Also used as the on-disk session directory name. */
  sessionRecordId: string;
  /** Agent-CLI-side session identifier. Null for agents that don't accept caller-specified IDs (Codex/Gemini). */
  agentSessionId: string | null;
  /** How a fresh start got `agentSessionId` before launch; `not_asked` for a resume. Read only by the session-id report. */
  sessionIdCreation: SessionIdCreationOutcome;
  /** Effective permission mode after lane override + global fallback. */
  permissionMode: PermissionMode;
  statusOutputPath: string;
  eventsOutputPath: string;
  /**
   * Adapter-specific env vars to merge into the PTY spawn env, from
   * `adapter.buildEnv?.(...)`: MCP wiring (OpenCode `OPENCODE_CONFIG_CONTENT`)
   * or a hook's events path (Cursor). Null when the adapter sets none.
   */
  extraEnv: Record<string, string> | null;
  /**
   * The agent account the session runs on (`SessionRecord.account_id`): the `default` row's id for
   * the agent's own login. Null only when no account was resolved (an agent without accounts, a
   * CLI in WSL).
   */
  accountId: string | null;
  /**
   * The model/effort this command actually applies via `--model` / `--effort`
   * (null = agent default, no flag). The caller persists these to the session
   * record's `applied_model` / `applied_effort` so a later column transition
   * diffs against the session's true running value. See `prepareInjectionPlan`.
   */
  appliedModel: string | null;
  appliedEffort: string | null;
  /**
   * The shell the command was built for: `input.resolvedShell`, or the WSL
   * distro's shell for a CLI installed there. The caller spawns in it.
   */
  shell: string;
  /** Where the CLI runs when it is not this machine (a WSL distro or a host), for the spawn and the session row. */
  cliTarget: StoredCliTarget | null;
  /** Set when the agent runs on a remote host (#913): the spawn descriptor `performSpawn` takes. */
  remote: SpawnRemote | null;
  /** Whether the command resumes the agent's conversation (`--resume`). */
  resumed: boolean;
  /**
   * The record whose conversation the command resumes, when it is not the one
   * the caller passed (`resumeForAgent` found the agent's own). The caller
   * retires it with its own record. Null otherwise.
   */
  rematchedRecordId: string | null;
  /**
   * The command's opening prompt. Null on every startup spawn but two: a
   * resume whose conversation the agent deleted starts fresh with a recap, and
   * a launch that never started starts fresh with the prompt it never ran.
   */
  prompt: string | null;
  /** Why a requested resume became a fresh spawn; null when it did not. */
  startOver: StartOverReason | null;
  /** When the deleted conversation last ran (UTC ISO), for an `expired` start-over's notice. */
  expiredLastActiveAt: string | null;
  /**
   * The agent draws its input box in the alternate screen and any screen before
   * it outside (`firstPromptMayBeTyped` answered true for this launch), so a
   * background paste waits for the box (`SpawnSessionInput.inputInAlternateScreen`).
   */
  inputInAlternateScreen: boolean;
  /** The agent CLI's version as detection read it (`SpawnSessionInput.agentCliVersion`). */
  agentCliVersion: string | null;
  /** The CLI path the command was built with (`SpawnSessionInput.agentCliPath`). */
  agentCliPath: string;
  /** What the resume check read, on a spawn that still resumes (`SpawnSessionInput.resumeEvidence`). */
  resumeEvidence: ResumeEvidenceSummary | null;
}

export type PrepareResult =
  | { ok: true; data: PreparedSpawn }
  | { ok: false; reason: 'unknown-agent' | 'cli-not-found' };

/**
 * Shared pre-flight for both session recovery and reconciliation. This is
 * the STARTUP spawn chokepoint (see .claude/rules/spawn-entry-point-parity.md);
 * board-driven spawns go through `spawnAgent` instead.
 *
 *   1. Run the shared spawn preamble (`runSpawnPreamble`): lock the Advanced
 *      overrides on a first-ever spawn, then resolve which agent adapter
 *      applies (task override → column override → project default).
 *   2. Detect the agent CLI binary (skipped or errored → skip signal).
 *   3. Ensure the CLI trusts the working directory so no trust prompt
 *      blocks the spawn.
 *   4. Resolve the effective permission mode via
 *      `resolveEffectivePermissionMode` (lane 'plan' always wins, else
 *      task → lane → global).
 *   5. Generate a session record UUID (used as the PTY session ID and
 *      the on-disk session directory name).
 *   6. Generate the agent CLI session UUID - only for adapters that
 *      accept a caller-specified value (Claude). Others get null; their
 *      real ID is captured from hooks or PTY output later.
 *   7. Build the agent command line.
 *
 * Resume semantics are delegated to the caller via `resume`: pass
 * `{ agentSessionId }` to produce a `--resume <uuid>` command, or null
 * for a fresh spawn.
 */
export function prepareAgentSpawn(input: Parameters<typeof prepareSpawnWithPull>[1]): Promise<PrepareResult> {
  return withHostFilePull((hostFilePull) => prepareSpawnWithPull(hostFilePull, input));
}

async function prepareSpawnWithPull(hostFilePull: HostFilePull, input: {
  task: Task;
  swimlane: Swimlane | null;
  cwd: string;
  projectId: string;
  projectPath: string;
  effectiveConfig: AppConfig;
  projectDefaultAgent: string | null;
  projectDefaultModel: string | null;
  projectDefaultEffort: string | null;
  resolvedShell: string;
  mcpServerHandle: McpHttpServerHandle | null | undefined;
  /**
   * Non-null → build a resume command with the given agent session ID, unless
   * the record is another agent's: then the spawn resumes this agent's own
   * conversation on the track, or starts fresh (`resumeForAgent`).
   */
  resume: StartupResume | null;
  /**
   * Persists a reconciled agent session id (only consulted when
   * `resume.recordId` is set), lists the task's records so the conversation
   * check reads the whole lineage, and finds the agent's own conversation when
   * the record to resume is another agent's.
   */
  sessionRepo?: StartupSessionRepo;
  /** Where an expired conversation's recap reads its optional parts. Absent, it carries the task alone. */
  recapSources?: ExpiredConversationRecapSources;
  /**
   * The team-shared default base branch (`kangentic.json`), ahead of the
   * config's, as the board path resolves `{{baseBranch}}`
   * (`resolveDefaultBaseBranch`). The recap lists the branch's commits past it.
   */
  boardDefaultBaseBranch?: string | null;
  /**
   * Whether any session row exists for the task. First-ever-spawn detection
   * for the override lock: recovery resumes pass `true` (a record is in hand,
   * the lock no-ops by construction); the startup reconcile derives it from
   * the session repository.
   */
  hasSessionRecord: boolean;
  tasks: Pick<TaskRepository, 'update'>;
  /**
   * The board's Board Profiles, so a task riding one resumes under that
   * profile's rung for its current column rather than the column's base
   * settings. Omitted (or empty) means every task runs the columns' own
   * settings, which is the pre-profile behavior.
   */
  boardProfiles?: ReadonlyArray<BoardProfile>;
}): Promise<PrepareResult> {
  const { task, cwd, projectId, projectPath, effectiveConfig: config } = input;

  // Fold the task's profile over its column once, then shadow `swimlane` so
  // every read below (the preamble, permission mode, model/effort) sees the
  // profile-resolved strategy. Startup recovery must agree with the board path
  // here: a task that spawned under a profile and is then resumed after a crash
  // has to come back on the same rung.
  const swimlane = applyProfileToLane(
    input.swimlane,
    findTaskProfile({ profiles: input.boardProfiles, profileId: task.profile_id, taskId: task.id }),
  );

  // The task sits in the lane it is spawning into on the startup paths, so
  // the settings lane and the destination lane are the same lane here: the
  // lane whose inherited values the Edit dialog displays for the task now.
  const { agent } = runSpawnPreamble({
    task,
    hasSessionRecord: input.hasSessionRecord,
    settingsLane: swimlane,
    destinationLane: swimlane,
    project: {
      default_agent: input.projectDefaultAgent,
      default_model: input.projectDefaultModel,
      default_effort: input.projectDefaultEffort,
    },
    globalPermissionMode: () => config.agent.permissionMode,
    tasks: input.tasks,
  });
  const adapter = agentRegistry.get(agent);
  if (!adapter) {
    trackEvent('spawn_failed', { agent, reason: 'unknown_agent' });
    return { ok: false, reason: 'unknown-agent' };
  }
  const { resume, rematchedRecordId } = resumeForAgent(input.resume, adapter, task.id, input.sessionRepo);

  // Model/effort ids are adapter-specific, so the project-level default only
  // applies when this spawn actually runs the project's default agent.
  const projectFallback = projectModelDefaultsApply(agent, input.projectDefaultAgent);

  const cliPathOverride = config.agent.cliPaths[agent] ?? null;
  // The CLI and where it runs, decided as the board path decides it (`resolveSpawnCli`): a remote
  // project's is the host's own (#913), never detected here; a distro CLI runs in that distro's shell,
  // whatever the Terminal setting says.
  const spawnCli = await resolveSpawnCli({ projectPath, cwd, adapter, cliPathOverride });
  if (!spawnCli) {
    trackEvent('spawn_failed', { agent, reason: 'cli_not_found' });
    return { ok: false, reason: 'cli-not-found' };
  }
  const { remoteLaunch, cliTarget } = spawnCli;
  const detectedCliPath = spawnCli.cliPath;
  const shell = shellForTarget(cliTarget) ?? input.resolvedShell;

  // A CLI on a host edits its trust and hook files there: pulled into the folders the adapter edits
  // before it runs, pushed back after the command is built (#913). Null for any other spawn.
  const hostFiles = await pullHostFilesFor(adapter, cwd, cliTarget);
  hostFilePull.sync = hostFiles;
  await adapter.ensureTrust(cwd, cliTarget);

  // "Plan always wins, else task -> lane -> global" - the rule lives in
  // resolveEffectivePermissionMode (spawn-preamble.ts).
  const permissionMode = resolveEffectivePermissionMode(
    task.permission_mode, swimlane?.permission_mode, config.agent.permissionMode,
  );

  // Reconcile the resumed id against the retiring record's own status.json:
  // a mid-session fork (Claude /clear) in the final seconds before suspend
  // can leave the DB one id behind. Best-effort; missing file or recordId
  // keeps the stored id unchanged. Before the conversation check, which needs
  // the id actually being resumed.
  const resumedAgentSessionId = resume
    ? await reconcileResumeAgentSessionId({
        adapter,
        recordId: resume.recordId ?? null,
        storedAgentSessionId: resume.agentSessionId,
        cwd: resume.recordCwd ?? cwd,
        projectPath,
        sessionRepo: input.sessionRepo,
        // The conversation resumes where this spawn's CLI runs.
        place: cliTarget,
        // Stops the CLI's own background session holding the conversation, if any. Not for a
        // host's CLI: that would run a command on this computer, where the session is not.
        cliPath: remoteLaunch ? undefined : detectedCliPath,
      })
    : null;

  // Same check the board spawn path runs (resume-conversation-guard.ts): a
  // conversation that never had a turn, or one the agent deleted, must not be
  // recovered with `--resume`, or startup hands the user a dead CLI. Anything
  // the check cannot prove resumes as before.
  let canResume = resume !== null;
  let startOver: PreparedSpawn['startOver'] = null;
  let prompt: string | null = null;
  let expiredLastActiveAt: string | null = null;
  let resumeEvidence: ResumeEvidenceSummary | null = null;
  if (resume && resumedAgentSessionId) {
    // With no repository to list from, the recovered record is read by its
    // folder alone (it ran until the crash, so it normally has its own status
    // report).
    const { lineage, lastActiveAt } = resolveResumeLineage({
      taskRecords: input.sessionRepo?.listForTaskNewestFirst?.(task.id) ?? [],
      retiringRecordId: resume.recordId ?? null,
      resumedAgentSessionId,
    });
    const { verdict, evidence, promptOwed } = await assessResumeConversationWithEvidence({
      adapter,
      agentSessionId: resumedAgentSessionId,
      records: lineage,
      cwd,
      projectPath,
      place: cliTarget,
      resumeFromCwd: resume.recordCwd ?? null,
    });
    resumeEvidence = evidence;
    if (verdict === 'never-started') {
      console.log(
        `[SESSION_RECOVERY] Resume downgraded to fresh for task ${task.id.slice(0, 8)}:`
        + ` agent session ${resumedAgentSessionId.slice(0, 8)} never wrote a conversation`,
      );
      canResume = false;
      startOver = 'never-started';
      // The prompt of a launch that never ran is still owed, and this path types
      // nothing, so a CLI that takes no starting prompt opens idle. A launch never
      // ran when a launch check marked it, or when the check proved it from the
      // row alone because a quit deleted its report (`promptOwed`).
      const failedLaunch = lineage.find(Boolean);
      const owedPrompt = (failedLaunch?.launch_failed_at || promptOwed) ? owedPromptOf(lineage) : null;
      if (owedPrompt && adapter.freshPromptDelivery !== 'typed') prompt = owedPrompt;
    } else if (verdict === 'expired') {
      canResume = false;
      startOver = 'expired';
      expiredLastActiveAt = lastActiveAt;
      console.log(
        `[SESSION_RECOVERY] Resume replaced by a fresh session for task ${task.id.slice(0, 8)}:`
        + ` agent session ${resumedAgentSessionId.slice(0, 8)} was deleted by ${adapter.displayName}`,
      );
      // Startup carries no column message and no task template on any
      // session, main or isolated, so the recap is the whole prompt for both:
      // there is nothing else for the agent to act on. A CLI that takes no
      // starting prompt gets none: this path types nothing, and a prompt here
      // would seed a turn that never starts. It opens idle for the user.
      if (adapter.freshPromptDelivery !== 'typed') {
        prompt = await buildExpiredConversationRecap({
          task,
          agentDisplayName: adapter.displayName,
          previousAgentSessionId: resumedAgentSessionId,
          lastActiveAt: expiredLastActiveAt,
          cwd,
          baseBranch: task.base_branch || input.boardDefaultBaseBranch || config.git?.defaultBaseBranch || 'main',
          mode: 'whole-prompt',
        }, input.recapSources);
      }
    }
  }

  // Same shim resolution as the board path (shim-launch.ts): a `.cmd` head
  // under a PowerShell or Git Bash host is swapped for the sibling shim that
  // shell can run, or the prompt is flattened. After the check, since an
  // expired conversation's recap is the one prompt this path ever carries.
  const launch = await resolveShimLaunch({
    agentPath: detectedCliPath,
    shell,
    prompt: prompt ?? undefined,
  });

  // Same id rule as the board spawn. This path's command carries no
  // nonInteractive flag, so the decision follows the permission mode and the
  // prompt, which here is an owed prompt or a recap, and usually none.
  const freshId = canResume
    ? null
    : await resolveFreshAgentSessionId(adapter, {
        cliPath: detectedCliPath,
        workingDirectory: cwd,
        permissionMode,
        prompt: launch.prompt,
        place: cliTarget,
      });
  const agentSessionId = canResume ? resumedAgentSessionId : freshId?.agentSessionId ?? null;
  const sessionIdCreation: SessionIdCreationOutcome = freshId?.sessionIdCreation ?? 'not_asked';

  const sessionRecordId = randomUUID();
  const sessionDir = path.join(projectPath, '.kangentic', 'sessions', sessionRecordId);
  // sync-write-ok: this must throw, not degrade - a spawn with no session
  // directory has nowhere to write status/events, so the CLI would come up
  // with no activity tracking and no way to tell the renderer it is ready.
  // Both callers (resume-suspended.ts, auto-spawn.ts) already wrap their
  // per-record prepareAgentSpawn() call in a try/catch that logs, retires or
  // skips just that one record, and continues the batch - a throw here never
  // aborts recovery for every other task.
  fs.mkdirSync(sessionDir, { recursive: true });
  const { statusOutputPath, eventsOutputPath } = sessionOutputPaths(sessionDir);
  // As the board path does: a plan approved into a bypass column needs bypass
  // available at launch, and the writer reads the directory and that fact here.
  const bypassAvailable = planSpawnNeedsBypass({
    permissionMode,
    agentApprovesPlans: adapter.supportsPlanAutoApproval === true,
    projectId,
    taskId: task.id,
  });

  // The account the resumed conversation was written on, which the spawn asks for
  // and the launch report compares with the account it got. A WSL CLI has no accounts.
  const conversationAccountId = cliTarget ? undefined : conversationAccountOf(
    canResume ? input.sessionRepo?.listForTaskNewestFirst?.(task.id) ?? [] : [],
    agentSessionId,
    canResume,
  );
  const commandOptions = {
    agentPath: launch.agentPath,
    taskId: task.id,
    prompt: launch.prompt,
    cwd,
    permissionMode,
    projectRoot: projectPath,
    sessionId: agentSessionId ?? undefined,
    resume: canResume,
    statusOutputPath,
    eventsOutputPath,
    shell,
    mcpServerEnabled: config.mcpServer?.enabled ?? true,
    browserAutomationEnabled: resolveBrowserAutomationConfig(config.browserAutomation).enabled,
    // Carries this session's own id so the MCP server can identify the caller
    // (see appendCallerSession). Stamped, never looked up, so it cannot drift.
    mcpServerUrl: appendCallerSession(input.mcpServerHandle?.urlForProject(projectId), sessionRecordId),
    mcpServerToken: input.mcpServerHandle?.token,
    // Task-level override (set by the ContextBar popover) wins over the
    // swimlane override, which wins over the project-level default - once a
    // user has expressed an explicit per-task preference, it sticks across
    // column moves until they clear it.
    //
    // The project-level tier is gated on the resolved agent, exactly as the
    // board spawn path does (resolveSpawnOverrides) and the column-move
    // injection plan does (prepareInjectionPlan). All three must agree, or a
    // crash-recovery respawn would apply a model the board spawn never did.
    model: task.model_override ?? swimlane?.model_override
      ?? (projectFallback ? input.projectDefaultModel : undefined) ?? undefined,
    effort: task.effort_override ?? swimlane?.effort_override
      ?? (projectFallback ? input.projectDefaultEffort : undefined) ?? undefined,
    executionTarget: resolveExecutionTarget(agent, config.agent.executionServers, config.agent.execution) ?? undefined,
    launchOptions: resolveLaunchOptions(adapter, config.agent.launchOptions),
    taskProcessTag: task.id,
    // The id the caller spawns under, which a folder-shared adapter file is
    // held under. A caller that does not spawn this command releases it
    // (releaseCommandHold).
    ptySessionId: sessionRecordId,
    bypassAvailable,
    // A startup resume brings a session back in the column it was running in.
    keepSessionPermissionMode: keepsSessionPermissionMode({
      isResume: canResume,
      sameColumnResume: true,
      adapterRestores: adapter.restoresPermissionModeOnResume === true,
      columnMode: permissionMode,
      lastLaunchedMode: resume?.recordPermissionMode,
    }),
    cliTarget,
    // The account a recovered session runs on (task #1057): the top account with room, as for a
    // board spawn. A WSL CLI keeps its single login.
    // A resume also hands over its conversation, whose plan file may sit in another account's home.
    account: cliTarget ? null : await resolveSpawnAccount(
      agent,
      undefined,
      conversationAccountId,
      canResume && agentSessionId ? { agentSessionId, cwd } : undefined,
    ),
  };

  const command = adapter.buildCommand(commandOptions);
  notePlanApprovalSpawn(sessionRecordId, { sessionDir, bypassAvailable });
  let extraEnv: Record<string, string> | null;
  try {
    extraEnv = buildSessionEnv(adapter, commandOptions);
  } catch (error) {
    // No caller will spawn this command, so nothing else releases its hold.
    releaseCommandHold(adapter, cwd, sessionRecordId);
    throw error;
  }
  // A push that fails means no caller will spawn this command.
  await pushHostFilesForSpawn(hostFiles, sessionRecordId, () => releaseCommandHold(adapter, cwd, sessionRecordId));

  return {
    ok: true,
    data: {
      adapter,
      agent,
      command,
      cwd,
      sessionRecordId,
      agentSessionId,
      sessionIdCreation,
      permissionMode,
      statusOutputPath,
      eventsOutputPath,
      extraEnv,
      appliedModel: commandOptions.model ?? null,
      appliedEffort: commandOptions.effort ?? null,
      shell,
      cliTarget: toStoredCliTarget(cliTarget),
      remote: remoteLaunch?.remote ?? null,
      resumed: canResume,
      rematchedRecordId,
      prompt,
      startOver,
      expiredLastActiveAt,
      inputInAlternateScreen: adapter.firstPromptMayBeTyped?.(commandOptions) === true,
      agentCliVersion: spawnCli.version,
      agentCliPath: launch.agentPath,
      resumeEvidence: canResume && resumeEvidence
        ? { ...resumeEvidence, account: resumeAccountMatch(conversationAccountId, commandOptions.account) }
        : null,
      accountId: commandOptions.account?.id ?? null,
    },
  };
}

/**
 * The resume command's source record. `recordId` (the resume-eligible record's
 * id) additionally enables the resume-time id reconcile against that record's
 * own status.json (see resume-id-reconcile.ts); omit it to skip the reconcile.
 * `recordCwd` is that record's own cwd for the reconcile's transcript probe, in
 * case it differs from the spawn `cwd` (falls back to the spawn cwd).
 */
export interface StartupResume {
  agentSessionId: string;
  recordId?: string;
  recordCwd?: string;
  /**
   * The permission mode on the record being resumed. A startup resume is in
   * the column the session was running in, so with this in hand the agent
   * keeps the mode its conversation was last in (`keepsSessionPermissionMode`).
   */
  recordPermissionMode?: string | null;
  /**
   * The record's `session_type` and track. When the agent this spawn runs has
   * another session type (the column's agent changed, or a record of the wrong
   * agent was left behind), its own latest conversation on that track is
   * resumed instead (`resumeForAgent`). Omitted, the resume is taken as given.
   */
  sessionType?: string;
  isolatedSwimlaneId?: string | null;
}

type StartupSessionRepo = Pick<SessionRepository, 'updateAgentSessionId'>
  & Partial<Pick<SessionRepository, 'listForTaskNewestFirst' | 'getLatestForTaskByTypeAndIsolation'>>;

/**
 * The resume a session record supports: its conversation, folder, mode and
 * track, or null when it has no conversation to resume (`isResumeEligible`).
 */
function startupResumeOf(record: SessionRecord | undefined): StartupResume | null {
  const agentSessionId = record?.agent_session_id;
  if (!record || !agentSessionId || !isResumeEligible(record)) return null;
  return {
    agentSessionId,
    recordId: record.id,
    recordCwd: record.cwd,
    recordPermissionMode: record.permission_mode,
    sessionType: record.session_type,
    isolatedSwimlaneId: record.isolated_swimlane_id,
  };
}

/**
 * The conversation a startup spawn resumes, matched to the agent it runs.
 *
 * Recovery picks the record by its own `session_type`, while the agent comes
 * from the task and its column. The two differ when the column's agent changed
 * while the task was paused, or when a record of the project default agent was
 * left in a column set to another (#821). Resuming that record would hand one
 * CLI another's session id. The agent's own latest conversation on the same
 * track is resumed instead, as the board path's intent lookup does
 * (`resolveSpawnIntent`), and with none the spawn starts fresh.
 * `rematchedRecordId` names that conversation's record, for the caller to
 * retire with its own.
 */
function resumeForAgent(
  resume: StartupResume | null,
  adapter: AgentAdapter,
  taskId: string,
  sessionRepo: StartupSessionRepo | undefined,
): { resume: StartupResume | null; rematchedRecordId: string | null } {
  if (!resume || resume.sessionType === undefined || resume.sessionType === adapter.sessionType) {
    return { resume, rematchedRecordId: null };
  }
  const ownAgentResume = startupResumeOf(
    sessionRepo?.getLatestForTaskByTypeAndIsolation?.(taskId, adapter.sessionType, resume.isolatedSwimlaneId ?? null),
  );
  const outcome = ownAgentResume ? `resuming ${adapter.name}'s own conversation on that track` : 'starting fresh';
  console.log(`[SESSION_RECOVERY] Task ${taskId.slice(0, 8)} runs ${adapter.name}, but its record is ${resume.sessionType}: ${outcome}`);
  return { resume: ownAgentResume, rematchedRecordId: ownAgentResume?.recordId ?? null };
}
