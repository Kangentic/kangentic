/**
 * The welcome screen's readiness rule: git plus one agent that works is ready, and a signed-out
 * agent beside a working one is an unused tool, not a blocker. Only when no found agent works does
 * signing in become the user's next step, which is when the setup panel opens and the signed-out
 * row leads with its attention mark. The component renders whatever this decides, so a regression here
 * would put "Sign in to OpenCode" back in front of someone whose Claude Code runs fine.
 */
import { describe, expect, it } from 'vitest';
import { deriveWelcomeReadiness } from '../../src/renderer/components/layout/welcome-readiness';
import type { AgentDetectionInfo } from '../../src/shared/types';

function agent(name: string, fields: Partial<AgentDetectionInfo> = {}): AgentDetectionInfo {
  return {
    name,
    displayName: name,
    found: true,
    path: `/usr/bin/${name}`,
    version: '1.0.0',
    permissions: [],
    defaultPermission: 'default',
    ...fields,
  };
}

const GIT_FOUND = { found: true };

function namesOf(agents: AgentDetectionInfo[]): string[] {
  return agents.map((entry) => entry.name);
}

describe('deriveWelcomeReadiness', () => {
  it('is ready when one agent works beside a signed-out one, and lists the working one first', () => {
    const readiness = deriveWelcomeReadiness({
      gitInfo: GIT_FOUND,
      agentList: [agent('opencode', { authenticated: false }), agent('claude', { authenticated: true })],
      agentListLoaded: true,
    });

    expect(readiness.readyToRun).toBe(true);
    expect(readiness.blockedReason).toBeNull();
    expect(readiness.signInAgent).toBeNull();
    expect(readiness.signInIsAction).toBe(false);
    expect(namesOf(readiness.orderedFoundAgents)).toEqual(['claude', 'opencode']);
  });

  it('counts only the agents that work as ready, so the header leaves a signed-out one out', () => {
    const readiness = deriveWelcomeReadiness({
      gitInfo: GIT_FOUND,
      agentList: [
        agent('claude'),
        agent('codex', { authenticated: null }),
        agent('opencode', { authenticated: false }),
        agent('aider', { found: false }),
      ],
      agentListLoaded: true,
    });

    expect(namesOf(readiness.readyAgents)).toEqual(['claude', 'codex']);
    expect(namesOf(readiness.signedOutAgents)).toEqual(['opencode']);
  });

  it('asks for sign-in when the only found agent is signed out, and leads with it', () => {
    const readiness = deriveWelcomeReadiness({
      gitInfo: GIT_FOUND,
      agentList: [agent('claude', { found: false }), agent('opencode', { authenticated: false })],
      agentListLoaded: true,
    });

    expect(readiness.readyToRun).toBe(false);
    expect(readiness.blockedReason).toBe('sign-in');
    expect(readiness.signInAgent?.name).toBe('opencode');
    expect(readiness.signInIsAction).toBe(true);
    expect(namesOf(readiness.orderedFoundAgents)).toEqual(['opencode']);
  });

  it('keeps several signed-out agents in list order and names the first', () => {
    const readiness = deriveWelcomeReadiness({
      gitInfo: GIT_FOUND,
      agentList: [agent('kimi', { authenticated: false }), agent('opencode', { authenticated: false })],
      agentListLoaded: true,
    });

    expect(readiness.signInAgent?.name).toBe('kimi');
    expect(namesOf(readiness.orderedFoundAgents)).toEqual(['kimi', 'opencode']);
  });

  it('reports a missing agent, a missing git, and both, before any sign-in', () => {
    const noAgent = deriveWelcomeReadiness({ gitInfo: GIT_FOUND, agentList: [agent('claude', { found: false })], agentListLoaded: true });
    expect(noAgent.blockedReason).toBe('no-agent');

    const noGit = deriveWelcomeReadiness({ gitInfo: { found: false }, agentList: [agent('claude')], agentListLoaded: true });
    expect(noGit.blockedReason).toBe('no-git');
    expect(noGit.readyToRun).toBe(false);

    const neither = deriveWelcomeReadiness({ gitInfo: { found: false }, agentList: [], agentListLoaded: true });
    expect(neither.blockedReason).toBe('no-git-no-agent');

    // A missing git outranks a sign-in, so the message asks for the step that blocks first.
    const noGitSignedOut = deriveWelcomeReadiness({
      gitInfo: { found: false },
      agentList: [agent('opencode', { authenticated: false })],
      agentListLoaded: true,
    });
    expect(noGitSignedOut.blockedReason).toBe('no-git');
    expect(noGitSignedOut.signInIsAction).toBe(true);
  });

  it('is detecting until both git and the agent list resolve', () => {
    expect(deriveWelcomeReadiness({ gitInfo: null, agentList: [agent('claude')], agentListLoaded: true }).blockedReason).toBe('detecting');
    const pendingAgents = deriveWelcomeReadiness({ gitInfo: GIT_FOUND, agentList: [], agentListLoaded: false });
    expect(pendingAgents.blockedReason).toBe('detecting');
    expect(pendingAgents.detectionResolved).toBe(false);
    expect(pendingAgents.readyToRun).toBe(false);
  });
});
