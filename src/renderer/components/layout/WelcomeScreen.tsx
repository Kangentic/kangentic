import { useEffect, useRef, useState } from 'react';
import { FolderOpen, FileText, GitBranch, Terminal, CircleCheckBig, CircleExclamationPoint, Copy, LoaderCircle, RefreshCw, ExternalLink, ChevronDown } from 'lucide-react';
import { plural } from '@lingui/core/macro';
import { Plural, Trans, useLingui } from '@lingui/react/macro';
import { DOCS_URLS } from '../../../shared/docs-links';
import { MINIMUM_GIT_VERSION_DISPLAY } from '../../../shared/git-minimum-version';
import { useConfigStore } from '../../stores/config-store';
import { agentInstallUrl, agentLoginCommand, RECOMMENDED_AGENT_ORDER } from '../../utils/agent-display-name';
import { useAddProject } from '../../hooks/useAddProject';
import { Tooltip } from '../Tooltip';
import { OverseerMascot } from '../onboarding/OverseerMascot';
import { deriveWelcomeReadiness } from './welcome-readiness';

const CURATED_NOT_FOUND_LIMIT = 3;

// One accent on this screen: the Open a project fill. Every other link is neutral text, and the
// underline (not a hue) is what marks it as a link.
const TEXT_LINK_CLASS = 'text-fg-muted underline underline-offset-2 decoration-fg-faint hover:text-fg cursor-pointer transition-colors';

/** Reusable detection row used for both the Git and agent entries */
function DetectionRow({ name, testId, found, version, installUrl, loading, authenticated, loginCommand, signInIsAction = false, className }: {
  name: string;
  testId?: string;
  found: boolean;
  version: string | null;
  installUrl: string | null;
  loading: boolean;
  authenticated?: boolean | null;
  loginCommand?: string;
  /** True when no agent is ready, so signing this one in is the user's next step. */
  signInIsAction?: boolean;
  /** Extra classes for the row's root, such as a grid span. */
  className?: string;
}) {
  const { t } = useLingui();
  const [copied, setCopied] = useState(false);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unauthenticated = !loading && found && authenticated === false;
  // A signed-out agent asks for attention only when nothing else can run. Beside a ready agent it is
  // most likely a tool the user tried and dropped, so it reads like an uninstalled one.
  const signInRow = unauthenticated && signInIsAction;
  const quietSignedOut = unauthenticated && !signInIsAction;
  const ready = !loading && found && !unauthenticated;

  useEffect(() => () => {
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
  }, []);

  const handleCopy = () => {
    if (!loginCommand) return;
    navigator.clipboard.writeText(loginCommand).catch(() => {
      // report-ok: a refused clipboard write is a browser permission outcome, and the user can retry
    });
    setCopied(true);
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
    copyTimeout.current = setTimeout(() => setCopied(false), 2000);
  };

  // The sign-in button and the quiet link differ only in look: both copy the command, carry it in
  // their name, and answer to the same test id.
  const copyLoginProps = {
    type: 'button' as const,
    onClick: handleCopy,
    'aria-label': t`Copy "${loginCommand}" to clipboard`,
    'data-testid': testId ? `${testId}-copy-login` : undefined,
  };

  return (
    <div className={`border border-edge rounded-lg p-3${className ? ` ${className}` : ''}`} data-testid={testId}>
      <div className="flex items-start gap-2">
        <div className="w-4 h-5 flex items-center justify-center shrink-0">
          {loading ? (
            <LoaderCircle size={14} className="animate-spin text-fg-faint" />
          ) : signInRow ? (
            <CircleExclamationPoint size={14} className="text-attention" />
          ) : ready ? (
            // Ready is the normal state, so it takes the name's own color rather than a hue.
            // --kng-active means "an agent is working" everywhere else in the app.
            <CircleCheckBig size={14} className="text-fg" />
          ) : (
            <div className="w-3.5 h-3.5 rounded-full border border-fg-faint/30" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`text-sm font-medium leading-5 ${ready || signInRow ? 'text-fg' : 'text-fg-muted'}`}>
            {name}
          </div>
          <div className="h-4 flex items-center min-w-0">
            {loading ? (
              <span className="text-xs text-fg-faint"><Trans>Checking...</Trans></span>
            ) : signInRow ? (
              <span className="text-xs text-fg-muted"><Trans>Not signed in</Trans></span>
            ) : quietSignedOut ? (
              <div className="flex items-center gap-1 min-w-0">
                {/* Truncates rather than wrapping: a long translation must not push the line
                    over the agent's name in a one-third card. */}
                <span className="text-xs text-fg-faint truncate"><Trans>Not signed in</Trans></span>
                {loginCommand && (
                  <>
                    <span className="text-xs text-fg-faint shrink-0">-</span>
                    <Tooltip label={copied ? '' : loginCommand}>
                      <button {...copyLoginProps} className={`inline-flex items-center gap-0.5 shrink-0 text-xs ${TEXT_LINK_CLASS}`}>
                        {/* No icon: in a third of the grid the status and the link only just fit
                            one line, and the underline already says it is a link. */}
                        {copied ? <Trans>Copied!</Trans> : <Trans>Copy login</Trans>}
                      </button>
                    </Tooltip>
                  </>
                )}
              </div>
            ) : found ? (
              <span className="text-xs text-fg-muted">
                {version ? <Trans>v{version}</Trans> : <Trans>Installed</Trans>}
              </span>
            ) : (
              <div className="flex items-center gap-1">
                <span className="text-xs text-fg-faint"><Trans>Not installed</Trans></span>
                {installUrl && (
                  <>
                    <span className="text-xs text-fg-faint">-</span>
                    <button
                      type="button"
                      className={`inline-flex items-center gap-0.5 text-xs ${TEXT_LINK_CLASS}`}
                      onClick={() => window.electronAPI.shell.openExternal(installUrl)}
                    >
                      <Trans>Install</Trans>
                      <ExternalLink size={10} />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
        {signInRow && loginCommand && (
          // The one action the panel asks for, so it is a real button with the command in full.
          // Neutral like every other control here: the row's attention icon carries the warning.
          <button
            {...copyLoginProps}
            className="self-center shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-edge bg-surface-raised text-xs text-fg-muted hover:bg-surface-hover hover:text-fg cursor-pointer transition-colors"
          >
            {!copied && <Copy size={12} />}
            {copied ? <Trans>Copied!</Trans> : <Trans>Copy <code className="font-mono text-fg">{loginCommand}</code></Trans>}
          </button>
        )}
      </div>
    </div>
  );
}

/** Skeleton placeholder for a detection row while loading */
function DetectionRowSkeleton() {
  return (
    <div className="border border-edge rounded-lg p-3 animate-pulse">
      <div className="flex items-start gap-2">
        <div className="w-4 h-5 flex items-center justify-center shrink-0">
          <div className="w-3.5 h-3.5 rounded-full bg-fg-faint/20" />
        </div>
        <div className="min-w-0">
          <div className="h-5 flex items-center"><div className="h-4 w-20 bg-fg-faint/20 rounded" /></div>
          <div className="h-4 flex items-center"><div className="h-3 w-16 bg-fg-faint/20 rounded" /></div>
        </div>
      </div>
    </div>
  );
}

export function WelcomeScreen() {
  const { t } = useLingui();
  const { startAddProject } = useAddProject();
  const appVersion = useConfigStore((state) => state.appVersion);
  const agentList = useConfigStore((state) => state.agentList);
  const agentListLoaded = useConfigStore((state) => state.agentListLoaded);
  const gitInfo = useConfigStore((state) => state.gitInfo);
  const detectGit = useConfigStore((state) => state.detectGit);
  const loadAgentList = useConfigStore((state) => state.loadAgentList);

  const [refreshing, setRefreshing] = useState(false);
  // null = the user has not manually toggled the panel yet, so it tracks
  // `blocked` live; once they click, their choice sticks for the session.
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const [showAllAgents, setShowAllAgents] = useState(false);

  // Detection is a PATH probe that can false-negative (a custom CLI path, a macOS GUI
  // launch with no login-shell PATH). Gating the CTA on a successful detection bricks the
  // app in that case: the Agent settings tab (where CLI Paths lives) is project-scoped and
  // hidden with no project open, so there is no way back in. The CTA only waits for
  // detection to finish, never for it to succeed.
  const readiness = deriveWelcomeReadiness({ gitInfo, agentList, agentListLoaded });
  const { detectionResolved, readyToRun, readyAgents, signInIsAction, orderedFoundAgents } = readiness;
  const blocked = detectionResolved && !readyToRun;
  const expanded = manualExpanded ?? blocked;

  const notFoundAgents = agentList.filter((agent) => !agent.found);
  const orderedNotFound = [...notFoundAgents].sort((a, b) => {
    const aRank = RECOMMENDED_AGENT_ORDER.indexOf(a.name);
    const bRank = RECOMMENDED_AGENT_ORDER.indexOf(b.name);
    return (aRank === -1 ? RECOMMENDED_AGENT_ORDER.length : aRank) - (bRank === -1 ? RECOMMENDED_AGENT_ORDER.length : bRank);
  });
  const visibleNotFound = showAllAgents ? orderedNotFound : orderedNotFound.slice(0, CURATED_NOT_FOUND_LIMIT);
  const hiddenNotFoundCount = orderedNotFound.length - visibleNotFound.length;

  // Blocked / detecting states are instructions, so they stay plain prose. The
  // ready state is two scannable FACTS, set in the foreground color so the eye can
  // pick "Git 2.51.0" and "9 agents" out without reading a sentence.
  let readinessMessage: string | null = null;
  switch (readiness.blockedReason) {
    case 'detecting':
      readinessMessage = t`Checking your setup`;
      break;
    case 'no-git-no-agent':
      readinessMessage = t`Install git and one agent CLI to run tasks.`;
      break;
    case 'no-git':
      readinessMessage = t`Install git to run tasks.`;
      break;
    case 'no-agent':
      readinessMessage = t`Install one agent CLI to run tasks.`;
      break;
    case 'sign-in': {
      const signedOutAgentName = readiness.signInAgent?.displayName ?? '';
      readinessMessage = t`Sign in to ${signedOutAgentName} to run tasks.`;
      break;
    }
    case null:
      break;
  }

  // The tool's own name and version, not prose. The agent fact counts only the agents that
  // work: a signed-out one is not part of the user's stack.
  const gitFact = gitInfo?.version ? `Git ${gitInfo.version}` : 'Git';
  // The found agents that work. The name is the plural message's placeholder, so it stays as
  // shipped and the message keeps its translations.
  const foundAgentCount = readyAgents.length;
  const agentFact = foundAgentCount === 1
    ? (readyAgents[0].version ? `${readyAgents[0].displayName} ${readyAgents[0].version}` : readyAgents[0].displayName)
    // One agent reads as its name above, so this branch never shows one.
    : plural(foundAgentCount, { one: '# agent', other: '# agents' });
  const gitVersion = gitInfo?.version ?? '';
  const minimumGitVersion = MINIMUM_GIT_VERSION_DISPLAY;
  const agentCount = agentList.length;

  const handleRefresh = async () => {
    setRefreshing(true);
    const minimumDelay = new Promise((resolve) => setTimeout(resolve, 800));
    await Promise.all([minimumDelay, detectGit(true), loadAgentList(true)]);
    setRefreshing(false);
  };

  return (
    <div className="flex-1 flex justify-center items-start pt-[10vh] text-fg-faint overflow-y-auto">
      <div className="text-center w-full max-w-2xl px-4">
        {/* Waves hello on arrival, then settles into an idle blink so the hero
            is never a frozen sprite. The handoff is animationend-driven, so the
            wave's duration stays owned by the branding package. The mascot is the
            brand on this screen, so the wordmark carries no second mark beside it. */}
        <OverseerMascot scale={7} intro="wave-once" sequence="blink-loop" className="mx-auto mb-6" />
        <div className="flex items-center justify-center gap-2.5 mb-1">
          {/* i18n-ok: the product name alone */}
          <h1 className="text-4xl font-bold text-fg leading-none">Kangentic</h1>
          {/* Centered on the wordmark's CAP band rather than its line box: with
              `leading-none` the box includes descender space ("g"), so a plain
              items-center sits the version visibly high. Nudging by half the
              descender re-centers it against the letters the eye actually reads. */}
          {appVersion && (
            <span
              className="self-center translate-y-[3px] text-xs font-medium text-fg-muted"
              data-testid="welcome-app-version"
            >
              <Trans>v{appVersion}</Trans>
            </span>
          )}
        </div>
        <p className="text-lg text-fg-muted mb-0"><Trans>Kanban for AI coding agents</Trans></p>

        {/* The action comes first: opening a project is the point of this screen.
            Setup status is supporting detail, so it sits below, behind a rule. */}
        <div className="mt-8 text-center">
          <button
            onClick={startAddProject}
            disabled={!detectionResolved}
            className={`inline-flex items-center gap-2 px-8 py-3 rounded-lg font-medium shadow-md transition-opacity ${
              detectionResolved
                ? 'bg-accent text-accent-on hover:opacity-90 cursor-pointer'
                : 'bg-accent/40 text-accent-on/60 cursor-not-allowed'
            }`}
            data-testid="welcome-open-project"
          >
            {detectionResolved ? <FolderOpen size={20} /> : <LoaderCircle size={20} className="animate-spin" />}
            {detectionResolved ? <Trans>Open a project</Trans> : <Trans>Checking your setup</Trans>}
          </button>
          {/* Only the blocked case gets subtext. When ready, "Open a project" plus
              a folder icon already says it, and the native picker repeats the same
              sentence one click later. */}
          {detectionResolved && !readyToRun && (
            <p className="text-sm text-fg-faint mt-2">
              <Trans>You can look around now and install an agent later.</Trans>
            </p>
          )}
        </div>

        {/* Full width, always. Opening the setup grid then changes height only,
            never width, so the expand does not shove the layout sideways. */}
        <div className="mt-8 pt-8 border-t border-edge">
        {/* No padding on the card: the toggle button owns it, so its hover tint
            reaches the card's edges and reads as "this whole strip is one
            control". overflow-hidden keeps that tint inside the rounded corners. */}
        <div className="w-full border border-edge rounded-lg text-left overflow-hidden">
          {/* The whole row is the toggle, not just the label: it is a ~600px
              strip whose only affordance sat in the far corner. Disabled while
              detection runs, since there is nothing to reveal yet. */}
          <button
            type="button"
            onClick={() => setManualExpanded(!expanded)}
            disabled={!detectionResolved}
            className={`w-full flex items-center justify-between gap-4 px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
              detectionResolved ? 'cursor-pointer group hover:bg-surface-hover/50' : 'cursor-default'
            }`}
            data-testid="welcome-setup-toggle"
            aria-expanded={expanded}
            aria-controls="welcome-setup-panel"
          >
            <span role="status" aria-live="polite" className="flex items-center gap-2 text-sm text-fg min-w-0" data-testid="welcome-readiness">
              {!detectionResolved ? (
                <LoaderCircle size={14} className="animate-spin text-fg-faint shrink-0" />
              ) : blocked ? (
                <CircleExclamationPoint size={14} className="text-attention shrink-0" />
              ) : (
                <CircleCheckBig size={14} className="text-fg shrink-0" />
              )}
              {/* Ready state is plain text with no hue: being set up is the
                  normal state, and --kng-active means "an agent is working" on
                  every other surface. The facts get weight, the joining words recede. */}
              {readinessMessage !== null ? (
                <span className="truncate">{readinessMessage}</span>
              ) : (
                <span className="flex items-center gap-1.5 min-w-0">
                  {/* One sentence, one message: the flex gap spaces its parts. */}
                  <Trans>
                    <span className="shrink-0 text-fg-muted">Found</span>
                    <span className="shrink-0 text-fg font-medium">
                      {gitFact}
                    </span>
                    <span className="shrink-0 text-fg-muted">and</span>
                    <span className="flex min-w-0 text-fg font-medium">
                      <span className="truncate">{agentFact}</span>
                    </span>
                  </Trans>
                </span>
              )}
            </span>
            {detectionResolved && (
              <span className="inline-flex items-center gap-1 text-xs text-fg-muted group-hover:text-fg transition-colors shrink-0">
                {expanded ? <Trans>Hide setup</Trans> : <Trans>Show setup</Trans>}
                <ChevronDown size={12} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
              </span>
            )}
          </button>

          {expanded && (
            <div id="welcome-setup-panel" className="px-3 pt-3 pb-3 border-t border-edge space-y-3">
              {/* No "Setup" heading here: the row above already reads "Hide
                  setup", and Core / Agents are the real sections - a third level
                  of labelling just to repeat the toggle is noise. Refresh rides
                  the first section header; it re-probes both sections.

                  Core tooling is a different KIND of prerequisite from the agent
                  CLIs - it is not interchangeable, and the list will grow beyond
                  git - so it gets its own labelled band instead of being tiled in
                  among fourteen agents where it reads as just another one. */}
              <div className="flex items-center justify-between">
                <div className="text-xs text-fg-faint uppercase tracking-wider"><Trans>Core</Trans></div>
                <Tooltip label={t`Check again for git and agent CLIs`}>
                  <button
                    onClick={handleRefresh}
                    disabled={refreshing}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-fg-muted bg-surface-raised hover:bg-surface-hover hover:text-fg cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    data-testid="welcome-refresh"
                  >
                    <RefreshCw size={12} />
                    <Trans>Refresh</Trans>
                  </button>
                </Tooltip>
              </div>
              <div className="grid grid-cols-3 gap-2 text-left">
                {gitInfo === null ? (
                  <DetectionRowSkeleton />
                ) : (
                  <DetectionRow
                    name="Git"
                    testId="welcome-git-status"
                    found={gitInfo.found}
                    version={gitInfo.version}
                    installUrl="https://git-scm.com/downloads"
                    loading={refreshing}
                  />
                )}
              </div>

              {gitInfo?.found && !gitInfo.meetsMinimum && (
                <p className="flex items-center gap-2 text-xs text-fg-muted text-left">
                  <CircleExclamationPoint size={14} className="text-attention shrink-0" />
                  <span><Trans>Git {gitVersion} is older than the recommended {minimumGitVersion} - worktrees may not work.</Trans></span>
                </p>
              )}

              <div className="text-xs text-fg-faint uppercase tracking-wider pt-1"><Trans>Agents</Trans></div>
              <div className="grid grid-cols-3 gap-2 text-left" data-testid="welcome-agent-grid">
                {!agentListLoaded ? (
                  <>
                    <DetectionRowSkeleton />
                    <DetectionRowSkeleton />
                    <DetectionRowSkeleton />
                  </>
                ) : (
                  <>
                    {orderedFoundAgents.map((agent) => {
                      // A sign-in row the user must act on carries the full login command, which
                      // is wider than a third of the grid, so it leads the grid at full width.
                      const signInRow = signInIsAction && agent.authenticated === false;
                      return (
                        <DetectionRow
                          key={agent.name}
                          name={agent.displayName}
                          testId={`welcome-agent-${agent.name}`}
                          found
                          version={agent.version}
                          installUrl={agentInstallUrl(agent.name)}
                          loading={refreshing}
                          authenticated={agent.authenticated}
                          loginCommand={agentLoginCommand(agent.name)}
                          signInIsAction={signInIsAction}
                          className={signInRow ? 'col-span-full' : undefined}
                        />
                      );
                    })}
                    {visibleNotFound.map((agent) => (
                      <DetectionRow
                        key={agent.name}
                        name={agent.displayName}
                        testId={`welcome-agent-${agent.name}`}
                        found={false}
                        version={agent.version}
                        installUrl={agentInstallUrl(agent.name)}
                        loading={refreshing}
                      />
                    ))}
                  </>
                )}
              </div>

              {agentListLoaded && hiddenNotFoundCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowAllAgents(true)}
                  className={`text-xs ${TEXT_LINK_CLASS}`}
                >
                  {/* Shown only past the curated three, so never for one. */}
                  <Plural value={agentCount} one="Show all # agent" other="Show all # agents" />
                </button>
              )}
            </div>
          )}
        </div>
        </div>

        <div className="mt-8 border-t border-edge pt-5 text-left">
          <div className="text-xs text-fg-faint uppercase tracking-wider mb-3"><Trans>When you open a project</Trans></div>
          {/* All three headings describe what Kangentic does, in the same
              third-person voice, and each body states one checkable fact. */}
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <FileText size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium"><Trans>Reads your project's setup</Trans></div>
                <div className="text-fg-faint text-sm"><Trans>Agents run inside your repo, so they pick up the instructions and config already there</Trans></div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <GitBranch size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium"><Trans>Isolates every task</Trans></div>
                <div className="text-fg-faint text-sm"><Trans>Each task runs on its own branch, so two agents never edit the same files</Trans></div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <Terminal size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium"><Trans>Runs real terminals</Trans></div>
                <div className="text-fg-faint text-sm"><Trans>Watch an agent work and type back to steer it</Trans></div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 mb-8 flex items-center justify-center gap-4 text-sm">
          <Tooltip label={DOCS_URLS.gettingStarted}>
            <button
              type="button"
              onClick={() => window.electronAPI.shell.openExternal(DOCS_URLS.gettingStarted)}
              className={`inline-flex items-center gap-1 ${TEXT_LINK_CLASS}`}
              data-testid="welcome-setup-guide"
            >
              <Trans>Read the setup guide</Trans>
              <ExternalLink size={12} />
            </button>
          </Tooltip>
          <Tooltip label={DOCS_URLS.mobilePairing}>
            <button
              type="button"
              onClick={() => window.electronAPI.shell.openExternal(DOCS_URLS.mobilePairing)}
              className={`inline-flex items-center gap-1 ${TEXT_LINK_CLASS}`}
              data-testid="welcome-pair-phone"
            >
              <Trans>Pair a phone</Trans>
              <ExternalLink size={12} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
