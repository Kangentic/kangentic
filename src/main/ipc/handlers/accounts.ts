import { accountsReporter, reportAccountProblem, scrubFailureDetail } from '../../accounts/account-report';
import { dialog, ipcMain } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import {
  DEFAULT_AGENT_ACCOUNTS_CONFIG,
  accountDisplayName,
  type AgentAccountKeyFileResult,
  type AgentAccountLoginEnded,
  type AgentAccountLoginRequest,
  type AgentAccountLoginStart,
  type AgentAccountSwitched,
  type AgentAccountSwitchResult,
  type AgentAccountsAllFull,
  type AgentAccountsCard,
} from '../../../shared/agent-accounts';
import { EventType, type SessionEvent, type SessionUsage } from '../../../shared/types';
import { AccountContinuation } from '../../accounts/account-continuation';
import { AccountLoginRunner } from '../../accounts/account-login';
import { AccountLoginWatch } from '../../accounts/account-login-watch';
import { createTaskAccountSwitcher, setTaskAccountSwitcher, type TaskAccountSwitcherHandle } from '../../accounts/account-task-switch';
import { moveRunningSessions } from '../../accounts/account-session-move';
import { AccountService, setAccountService } from '../../accounts/account-service';
import { AccountUsageRefresher } from '../../accounts/account-usage';
import { multiAccountAgents } from '../../accounts/account-order';
import { setAccountsConfigListener } from '../../accounts/accounts-config-changed';
import { agentRegistry } from '../../agent/agent-registry';
import { resolveCliTarget } from '../../agent/shared/cli-target';
import { PATHS } from '../../config/paths';
import { AgentAccountRepository } from '../../db/repositories/agent-account-repository';
import { getProjectRepos } from '../helpers';
import type { IpcContext } from '../ipc-context';
import { withTaskLock } from '../task-lifecycle-lock';
import { restartSessionForSettingsChange } from './session-reconcile';
import { sendToRenderer } from '../send-to-renderer';

let usageRefresher: AccountUsageRefresher | null = null;
let loginRunner: AccountLoginRunner | null = null;
let loginWatch: AccountLoginWatch | null = null;
let syncLoginWatch: (() => void) | null = null;
let taskSwitcher: TaskAccountSwitcherHandle | null = null;

/** Synchronous: clears the usage timers and ends any sign-in still open (app quit). */
export function stopAccounts(): void {
  usageRefresher?.dispose();
  loginRunner?.dispose();
  loginWatch?.dispose();
  taskSwitcher?.dispose();
  setTaskAccountSwitcher(null);
  usageRefresher = null;
  loginRunner = null;
  loginWatch = null;
  syncLoginWatch = null;
  taskSwitcher = null;
  setAccountsConfigListener(null);
}

/** How long after an account move a failed turn still counts as the move's. */
const TURN_AFTER_MOVE_WINDOW_MS = 10 * 60 * 1000;
/**
 * How long `kangentic_switch_account` waits for the calling agent's turn to end before it
 * restarts the session anyway: the tool tells the agent to end its turn, and one that keeps
 * working is moved once this runs out.
 */
const SWITCH_TOOL_TURN_END_BOUND_MS = 2 * 60 * 1000;

/** A sign-in request as the renderer may send it: a new account of an agent, or an existing account again. */
function parseLoginRequest(request: unknown): AgentAccountLoginRequest | null {
  if (!request || typeof request !== 'object') return null;
  const { accountId, agent } = request as { accountId?: unknown; agent?: unknown };
  if (typeof accountId === 'string') return { accountId };
  if (typeof agent === 'string') return { agent };
  return null;
}

/**
 * Agent accounts (task #1057): builds the account service every spawn asks, keeps each account's
 * usage current, and serves Settings > Accounts. Called once, before anything can spawn.
 */
export function registerAccountHandlers(context: IpcContext): AccountService {
  const repository = new AgentAccountRepository();
  const readConfig = () => context.configManager.load().agent.accounts ?? DEFAULT_AGENT_ACCOUNTS_CONFIG;
  const resolveCliPath = async (agent: string): Promise<string | null> => {
    const adapter = agentRegistry.get(agent);
    if (!adapter) return null;
    const detection = await adapter.detect(context.configManager.load().agent.cliPaths[agent] ?? null);
    return detection.found && detection.path ? detection.path : null;
  };
  // Assigned below, once the service it reads exists. A change before then has nothing waiting.
  let continuation: AccountContinuation | null = null;
  const notifyChanged = (): void => {
    sendToRenderer(context.mainWindow, IPC.ACCOUNTS_CHANGED);
    // An account added, removed or moved to another folder changes which login files are watched.
    syncLoginWatch?.();
    // A reset or a read may have freed an account a waiting session can continue on.
    void continuation?.recheck();
  };

  const service = new AccountService({
    repository,
    getAdapter: (agent) => agentRegistry.get(agent),
    listAdapters: () => agentRegistry.list().flatMap((name) => agentRegistry.get(name) ?? []),
    configDir: PATHS.configDir,
    readConfig,
    writeConfig: (next) => {
      context.configManager.save({ agent: { ...context.configManager.load().agent, accounts: next } });
    },
    resolveCliPath,
    usesRemoteTarget: async (agent) => {
      const adapter = agentRegistry.get(agent);
      const cliPath = await resolveCliPath(agent);
      return (await resolveCliTarget(cliPath, adapter?.supportsWslCli === true)) !== null;
    },
    onChanged: notifyChanged,
    reportProblem: reportAccountProblem,
    // The refresher is made below; a spawn only asks once registration is done.
    readBeforeRanking: async (accounts) => {
      await usageRefresher?.readBeforeRanking(accounts);
    },
    // A `/login` replaced the login in a home: the sessions running there now run as the row that
    // names it, so their usage and the continuation follow the login (task #1113). Their records
    // keep the home they started in, which a background-session stop and a resume reach it by.
    repointSessions: (homeAccountId, toAccountId) => {
      const moved = context.sessionManager.repointAccount(homeAccountId, toAccountId);
      if (moved > 0) console.log(`[ACCOUNTS] ${moved} session(s) follow the login their home now holds`);
    },
  });
  setAccountService(service);
  // A saved Order mode changes the order main lists: the tab lists again once the write landed.
  setAccountsConfigListener(notifyChanged);

  // Each account keeps its latest windows, so its usage shows with no session running on it.
  context.sessionManager.on('usage', (_sessionId: string, usage: SessionUsage) => {
    try {
      service.recordUsage(usage.rateLimits);
    } catch (error) {
      console.warn('[ACCOUNTS] Could not record usage:', error);
    }
  });

  const refresher = new AccountUsageRefresher(service, { listAccounts: () => repository.list(), failureReporter: accountsReporter });
  refresher.start();
  usageRefresher = refresher;

  // A login replaced in a home, by a `/login` in a session or a sign-in in a terminal, is noticed
  // when the home's login file changes, at each turn end and when a session ends (task #1113).
  // Each compares the home's own record with the row, and the CLI runs only when they differ.
  const checkHome = (accountId: string | null): void => {
    if (!accountId) return;
    // An agent with one account has nothing to reconcile: its row is whatever its CLI is signed
    // in to, so a one-account user's turn ends read no file.
    const agent = repository.getById(accountId)?.agent;
    if (!agent || !multiAccountAgents(repository.listForAgent(agent)).has(agent)) return;
    void refresher.checkHome(accountId);
  };
  const watch = new AccountLoginWatch((accountId) => checkHome(accountId));
  loginWatch = watch;
  /**
   * Watches the login file of every home of an agent with two or more accounts. For a CLI in a WSL
   * distro the check a change asks for reads nothing (`checkHomeIdentity` skips a remote target).
   */
  syncLoginWatch = (): void => {
    const accounts = repository.list();
    const multiAccount = multiAccountAgents(accounts);
    watch.sync(accounts.flatMap((account) => {
      if (!multiAccount.has(account.agent) || account.kind === 'key-file') return [];
      const support = agentRegistry.get(account.agent)?.accounts;
      if (support?.kind !== 'folder' || !support.loginFiles) return [];
      if (account.kind === 'folder' && !account.folderPath) return [];
      return support.loginFiles(account.kind === 'folder' ? account.folderPath : null)
        .map((filePath) => ({ accountId: account.id, filePath }));
    }));
  };
  syncLoginWatch();
  context.sessionManager.on('turn-ended', (payload: { sessionId: string }) => {
    checkHome(context.sessionManager.getSessionHomeAccountId(payload.sessionId));
  });

  /** When each task's session was last moved to another account, to tell a refused resume from any other failure. */
  const movedTasks = new Map<string, number>();

  /** A task's live session: running, and not a Command Terminal's. */
  const liveSessionOf = (taskId: string) => context.sessionManager.listSessions()
    .find((candidate) => candidate.taskId === taskId && !candidate.transient && candidate.status === 'running') ?? null;

  /** The account a task's live session runs on, or null when it has none. */
  const liveAccountOf = (taskId: string): string | null => liveSessionOf(taskId)?.accountId ?? null;

  /** Restarts a task's session in place on `accountId`, resuming its conversation. */
  const restartTaskOn = (
    session: { sessionId: string; taskId: string; projectId: string },
    accountId: string,
    prompt: string | undefined,
  ): Promise<boolean> => withTaskLock(session.taskId, async () => {
    // Decided before the lock: a move or a restart may have replaced the session since.
    const task = getProjectRepos(context, session.projectId).tasks.getById(session.taskId);
    const projectPath = context.projectRepo.getById(session.projectId)?.path;
    if (!task || !projectPath) return false;
    // Replaced by another pass that already put the task on this account: nothing left to do.
    if (task.session_id !== session.sessionId) return liveAccountOf(session.taskId) === accountId;
    const restart = await restartSessionForSettingsChange(context, session.projectId, projectPath, session.taskId, {
      phase: 'switching-account',
      resumePrompt: prompt,
      accountId,
    });
    // The restart cleared task.session_id before its suspend, so the board holds a stale id.
    sendToRenderer(context.mainWindow, IPC.TASK_SESSION_RESYNC, session.projectId);
    if (!restart.ok) {
      console.warn(`[ACCOUNTS] Could not restart task ${session.taskId.slice(0, 8)} on another account: ${restart.reason}`);
      return false;
    }
    movedTasks.set(session.taskId, Date.now());
    // The account could not be prepared and the session came back on the agent's own login: the
    // session restarted, the move did not happen.
    if (liveAccountOf(session.taskId) !== accountId) {
      console.warn(`[ACCOUNTS] Task ${session.taskId.slice(0, 8)} restarted, but not on the account it was moved to`);
      return false;
    }
    return true;
  });

  // `kangentic_switch_account` (task #1113): a task's agent moves its own session to another
  // listed account, so it never needs a `/login`. The call answers first; the restart waits for
  // the turn to end (or a bound, for an agent that keeps working), then resumes the conversation.
  const switcher = createTaskAccountSwitcher({
    liveSession: (taskId) => {
      const live = liveSessionOf(taskId);
      return live ? { id: live.id, projectId: live.projectId, accountId: live.accountId ?? null } : null;
    },
    agentOf: (sessionId) => context.sessionManager.getSessionAgentName(sessionId),
    sessionsCanMove: (agent) => {
      const support = agentRegistry.get(agent)?.accounts;
      if (!support) return null;
      return !(support.kind === 'folder' && support.conversationsStayOnAccount);
    },
    ordered: (agent) => service.ordered(agent),
    onTurnEnded: (listener) => {
      const onTurnEnded = (payload: { sessionId: string }): void => listener(payload.sessionId);
      context.sessionManager.on('turn-ended', onTurnEnded);
      return () => { context.sessionManager.off('turn-ended', onTurnEnded); };
    },
    restartOn: restartTaskOn,
    reportFailure: (error) => { accountsReporter.report(error, { tags: { stage: 'switch_tool' } }); },
    turnEndBoundMs: SWITCH_TOOL_TURN_END_BOUND_MS,
  });
  taskSwitcher = switcher;
  setTaskAccountSwitcher(switcher.switchAccount);

  // The continuation at a usage limit (account-continuation.ts): a task session whose turn
  // failed on a limit, on an account a fresh read shows full, restarts on the next with room.
  continuation = new AccountContinuation({
    readConfig,
    findTaskSession: (sessionId) => {
      const session = context.sessionManager.listSessions().find((candidate) => candidate.id === sessionId);
      const agent = context.sessionManager.getSessionAgentName(sessionId);
      if (!session || session.transient || session.status !== 'running' || !session.accountId || !agent) return null;
      return { sessionId, taskId: session.taskId, projectId: session.projectId, agent, accountId: session.accountId };
    },
    isUsageLimitFailure: (agent, detail) => {
      const support = agentRegistry.get(agent)?.accounts;
      // A conversation that can only be resumed on its own account is never moved to another.
      if (!support || (support.kind === 'folder' && support.conversationsStayOnAccount)) return false;
      return support.isUsageLimitFailure?.(detail) ?? false;
    },
    ordered: (agent) => service.ordered(agent),
    readUsageNow: (accountId) => refresher.refreshAccount(accountId, true),
    continueOn: restartTaskOn,
    notifySwitched: (session, account) => {
      const switched: AgentAccountSwitched = {
        projectId: session.projectId,
        taskId: session.taskId,
        agent: session.agent,
        accountName: accountDisplayName(account),
      };
      sendToRenderer(context.mainWindow, IPC.ACCOUNTS_SWITCHED, switched);
    },
    notifyAllFull: (agent, firstFree) => {
      const allFull: AgentAccountsAllFull = { agent, resetsAt: firstFree?.resetsAt ?? null };
      sendToRenderer(context.mainWindow, IPC.ACCOUNTS_ALL_FULL, allFull);
    },
  });
  /**
   * What a failed turn says about the account it ran on: a conversation the provider refuses
   * there, in the adapter's own words, or any failure soon after the session was moved to another
   * account, which is how a refused resume first shows on an agent nobody could test.
   */
  const reportTurnFailure = (sessionId: string, detail: string): void => {
    try {
      const session = context.sessionManager.listSessions().find((candidate) => candidate.id === sessionId);
      const agent = context.sessionManager.getSessionAgentName(sessionId);
      if (!session || session.transient || !session.accountId || !agent) return;
      const support = agentRegistry.get(agent)?.accounts;
      if (support?.kind === 'folder' && support.isConversationRefusal?.(detail)) {
        service.reportProblem('conversation-refused', agent, { detail: scrubFailureDetail(detail) });
        return;
      }
      const movedAt = movedTasks.get(session.taskId);
      if (movedAt === undefined) return;
      movedTasks.delete(session.taskId);
      if (Date.now() - movedAt <= TURN_AFTER_MOVE_WINDOW_MS) {
        service.reportProblem('turn-failed-after-move', agent, { detail: scrubFailureDetail(detail) });
      }
    } catch (error) {
      console.warn('[ACCOUNTS] Could not report a failed turn:', error);
    }
  };

  const activeContinuation = continuation;
  context.sessionManager.on('event', (sessionId: string, event: SessionEvent) => {
    if (event.type !== EventType.TurnFailed && event.type !== EventType.TurnRetrying) return;
    if (event.type === EventType.TurnFailed) reportTurnFailure(sessionId, event.detail ?? '');
    // Off the event's stack: the decision reads usage through the CLI.
    setImmediate(() => { void activeContinuation.onTurnFailure(sessionId, event.detail ?? ''); });
  });
  context.sessionManager.on('session-removed', (sessionId: string) => {
    activeContinuation.forgetSession(sessionId);
    // Read while the row is still in the registry: the session ended on this home.
    checkHome(context.sessionManager.getSessionHomeAccountId(sessionId));
  });

  const runner = new AccountLoginRunner({
    // Sent directly, never through `sendToRenderer`: that records each push in the IPC log, and a
    // sign-in's screen carries the provider's sign-in address.
    onOutput: (loginId, data) => {
      if (!context.mainWindow.isDestroyed()) context.mainWindow.webContents.send(IPC.ACCOUNTS_LOGIN_OUTPUT, loginId, data);
    },
    onEnded: (loginId, accountId, cancelled) => {
      const signedInAgent = repository.getById(accountId)?.agent;
      void service.completeLogin(accountId)
        .then(({ account, duplicateOf }): AgentAccountLoginEnded => {
          // The CLI ended by itself and no login reads back. On an agent whose accounts nobody
          // could run, that may be a login Kangentic looks for in the wrong place.
          if (!cancelled && !account && !duplicateOf && signedInAgent && service.isUnproven(signedInAgent)) {
            service.reportProblem('sign-in-not-recognized', signedInAgent);
          }
          return { loginId, account, duplicateOf, cancelled };
        })
        .catch((error): AgentAccountLoginEnded => {
          console.warn('[ACCOUNTS] Could not read who signed in:', error);
          return { loginId, account: null, duplicateOf: null, cancelled };
        })
        .then((ended) => {
          sendToRenderer(context.mainWindow, IPC.ACCOUNTS_LOGIN_ENDED, ended);
          // A new account starts with its usage read, so its row is not empty.
          if (ended.account) void refresher.refreshAccount(ended.account.id, true);
        });
    },
  });
  loginRunner = runner;

  ipcMain.handle(IPC.ACCOUNTS_LIST, (): Promise<AgentAccountsCard[]> => service.cards());

  ipcMain.handle(IPC.ACCOUNTS_START_LOGIN, async (_event, rawRequest: unknown): Promise<AgentAccountLoginStart> => {
    const request = parseLoginRequest(rawRequest);
    if (!request) return { ok: false, reason: 'unsupported' };
    // The row this sign-in made, if it made one: it goes with a sign-in that never started.
    let createdAccountId: string | null = null;
    try {
      const account = 'accountId' in request
        ? repository.getById(request.accountId)
        : await service.createFolderAccount(request.agent);
      // A folder account, or the agent's own home signed in again (its row set aside or signed out).
      if (!account || account.kind === 'key-file') return { ok: false, reason: 'unsupported' };
      if (!('accountId' in request)) createdAccountId = account.id;
      const command = await service.loginCommand(account.id);
      if (!command) {
        // A row made for this sign-in goes with it; a signed-out row asked to sign in again stays.
        if (createdAccountId) service.remove(createdAccountId);
        return { ok: false, reason: 'no-cli' };
      }
      const loginId = await runner.start(account.id, command);
      return { ok: true, loginId, accountId: account.id };
    } catch (error) {
      console.warn('[ACCOUNTS] Could not start a sign-in:', error);
      if (createdAccountId) service.remove(createdAccountId);
      return { ok: false, reason: 'failed', message: error instanceof Error ? error.message.split('\n')[0] : String(error) };
    }
  });
  ipcMain.handle(IPC.ACCOUNTS_LOGIN_BACKLOG, (_event, loginId: unknown): string =>
    (typeof loginId === 'string' ? runner.backlog(loginId) : ''));
  ipcMain.on(IPC.ACCOUNTS_LOGIN_INPUT, (_event, loginId: unknown, data: unknown) => {
    if (typeof loginId === 'string' && typeof data === 'string') runner.write(loginId, data);
  });
  ipcMain.on(IPC.ACCOUNTS_LOGIN_RESIZE, (_event, loginId: unknown, cols: unknown, rows: unknown) => {
    if (typeof loginId === 'string' && typeof cols === 'number' && typeof rows === 'number') runner.resize(loginId, cols, rows);
  });
  ipcMain.handle(IPC.ACCOUNTS_CANCEL_LOGIN, (_event, loginId: unknown): void => {
    if (typeof loginId === 'string') runner.cancel(loginId);
  });

  ipcMain.handle(IPC.ACCOUNTS_ADD_KEY_FILE, async (_event, agent: unknown): Promise<AgentAccountKeyFileResult | null> => {
    if (typeof agent !== 'string') return { ok: false, reason: 'unsupported' };
    const picked = await dialog.showOpenDialog(context.mainWindow, { properties: ['openFile', 'showHiddenFiles'] });
    if (picked.canceled || picked.filePaths.length === 0) return null;
    return service.addKeyFileAccount(agent, picked.filePaths[0]);
  });
  ipcMain.handle(IPC.ACCOUNTS_REMOVE, (_event, accountId: unknown): boolean =>
    (typeof accountId === 'string' ? service.remove(accountId) : false));
  ipcMain.handle(IPC.ACCOUNTS_REORDER, (_event, agent: unknown, orderedIds: unknown): void => {
    if (typeof agent !== 'string' || !Array.isArray(orderedIds)) return;
    service.reorder(agent, orderedIds.filter((id): id is string => typeof id === 'string'));
  });
  // Switch to is a deliberate switch: the account goes to #1 and the agent's running task sessions
  // move to it now. A switch that left them where they were would only matter at a limit, and the
  // automatic switch already covers that. A drag only reorders, for new sessions.
  ipcMain.handle(IPC.ACCOUNTS_SWITCH_TO, async (_event, accountId: unknown): Promise<AgentAccountSwitchResult> => {
    if (typeof accountId !== 'string' || !service.switchTo(accountId)) {
      return { ok: false, agent: null, accountName: null, moved: 0, failed: 0 };
    }
    const switchedAccount = repository.getById(accountId);
    const agent = switchedAccount?.agent;
    let outcome = { moved: 0, failed: 0 };
    const agentSupport = agent ? agentRegistry.get(agent)?.accounts : undefined;
    // An agent whose conversations stay on their account keeps its running sessions where they are.
    if (agent && !(agentSupport?.kind === 'folder' && agentSupport.conversationsStayOnAccount)) {
      // Each running session restarts in place, one at a time, and the board shows each as it
      // goes. The list has already changed (the service pushed it); the answer waits for the
      // sessions, so the renderer can say how the switch ended.
      const activity = context.sessionManager.getActivityCache();
      outcome = await moveRunningSessions({
        listRunning: (ofAgent) => context.sessionManager.listSessions()
          .filter((session) => !session.transient && session.status === 'running'
            && context.sessionManager.getSessionAgentName(session.id) === ofAgent)
          .map((session) => ({
            sessionId: session.id,
            taskId: session.taskId,
            projectId: session.projectId,
            accountId: session.accountId ?? null,
            // Anything but a settled idle is work the restart cuts.
            working: activity[session.id] !== undefined && activity[session.id] !== 'idle',
          })),
        restartOn: restartTaskOn,
      }, agent, accountId);
    }
    return {
      ok: true,
      agent: agent ?? null,
      accountName: switchedAccount ? accountDisplayName(switchedAccount) : null,
      ...outcome,
    };
  });
  // One refresh at a time: a tab that mounts twice, or two windows, share the one in flight
  // rather than doubling the CLI runs on a machine that is already busy.
  let refreshInFlight: Promise<void> | null = null;
  ipcMain.handle(IPC.ACCOUNTS_REFRESH_USAGE, (): Promise<void> => {
    refreshInFlight ??= (async () => {
      // Who is signed in first (a login can expire while the app is closed), then the usage. Each
      // account is its own CLI run against its own home, so they are asked together.
      await Promise.all(repository.list()
        .filter((account) => account.kind !== 'key-file')
        // The service handles a sign-in read with no answer, so what reaches here is a defect. The
        // account keeps its status, and its usage is still read below.
        .map((account) => service.refreshIdentity(account.id).catch((error: unknown) => {
          accountsReporter.report(error, { tags: { stage: 'sign_in_read' } });
          return null;
        })));
      await refresher.refreshAll('requested');
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  });

  return service;
}
