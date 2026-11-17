import type { AgentDetectionInfo } from '../../../shared/types';

/** Why the welcome screen cannot run a task yet, or null when it can. */
export type WelcomeBlockedReason =
  | 'detecting'
  | 'no-git-no-agent'
  | 'no-git'
  | 'no-agent'
  | 'sign-in';

export interface WelcomeReadinessInput {
  /** Null until git detection resolves. */
  gitInfo: { found: boolean } | null;
  agentList: AgentDetectionInfo[];
  agentListLoaded: boolean;
}

export interface WelcomeReadiness {
  detectionResolved: boolean;
  /** Found and not signed out: the agents the user can run today. */
  readyAgents: AgentDetectionInfo[];
  /** Found, but their sign-in probe says signed out. */
  signedOutAgents: AgentDetectionInfo[];
  readyToRun: boolean;
  blockedReason: WelcomeBlockedReason | null;
  /** The agent the "Sign in to ..." message names. Set only for `'sign-in'`. */
  signInAgent: AgentDetectionInfo | null;
  /**
   * True when signing in is the user's next step: no found agent is ready and at least one is
   * signed out. Only then does a signed-out row ask for attention. With another agent ready, a
   * signed-out one is most likely a tool the user tried and dropped, so it reads like an
   * uninstalled one.
   */
  signInIsAction: boolean;
  /** Found agents in grid order: the rows to act on first, otherwise the ready ones first. */
  orderedFoundAgents: AgentDetectionInfo[];
}

/**
 * Decides what the welcome screen's setup panel says and in what order it lists the found agents.
 *
 * Ready means git plus one agent that works. Detection is a PATH probe that can false-negative, so
 * none of this gates the Open a project button: the caller waits only for `detectionResolved`.
 */
export function deriveWelcomeReadiness({ gitInfo, agentList, agentListLoaded }: WelcomeReadinessInput): WelcomeReadiness {
  const detectionResolved = gitInfo !== null && agentListLoaded;
  const gitReady = gitInfo?.found ?? false;
  const foundAgents = agentList.filter((agent) => agent.found);
  const readyAgents = foundAgents.filter((agent) => agent.authenticated !== false);
  const signedOutAgents = foundAgents.filter((agent) => agent.authenticated === false);
  const signInIsAction = readyAgents.length === 0 && signedOutAgents.length > 0;
  const readyToRun = detectionResolved && gitReady && readyAgents.length > 0;

  let blockedReason: WelcomeBlockedReason | null = null;
  if (!detectionResolved) {
    blockedReason = 'detecting';
  } else if (!gitReady && foundAgents.length === 0) {
    blockedReason = 'no-git-no-agent';
  } else if (!gitReady) {
    blockedReason = 'no-git';
  } else if (foundAgents.length === 0) {
    blockedReason = 'no-agent';
  } else if (signInIsAction) {
    blockedReason = 'sign-in';
  }

  return {
    detectionResolved,
    readyAgents,
    signedOutAgents,
    readyToRun,
    blockedReason,
    signInAgent: blockedReason === 'sign-in' ? signedOutAgents[0] : null,
    signInIsAction,
    orderedFoundAgents: signInIsAction
      ? [...signedOutAgents, ...readyAgents]
      : [...readyAgents, ...signedOutAgents],
  };
}
