import { useEffect, useRef, useState } from 'react';
import { FolderOpen, FileText, GitBranch, Terminal, CheckCircle, CircleAlert, Copy, Loader2, RefreshCw, ExternalLink, ChevronDown } from 'lucide-react';
import { useConfigStore } from '../../stores/config-store';
import { agentInstallUrl, agentLoginCommand, RECOMMENDED_AGENT_ORDER } from '../../utils/agent-display-name';
import { useAddProject } from '../../hooks/useAddProject';
import { Pill } from '../Pill';
import { OverseerMascot } from '../onboarding/OverseerMascot';
// The full-color mark (rust disc, amber card) rather than the theme-tinted
// BrandMark the title bar uses. This is the app's identity moment and the
// first-launch default theme is dark, so the fixed palette is safe here.
// Rendered as <img> (not inlined) because the asset carries a mask with a
// fixed id, which would collide if inlined more than once per document.
import brandLogoUrl from '@kangentic/branding/assets/brandmark-small.svg?url';

const SETUP_GUIDE_URL = 'https://www.kangentic.com/getting-started/';
const CURATED_NOT_FOUND_LIMIT = 3;

/** Reusable detection row used for both the Git and agent entries */
function DetectionRow({ name, testId, found, version, installUrl, loading, authenticated, loginCommand }: {
  name: string;
  testId?: string;
  found: boolean;
  version: string | null;
  installUrl: string | null;
  loading: boolean;
  authenticated?: boolean | null;
  loginCommand?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unauthenticated = !loading && found && authenticated === false;

  useEffect(() => () => {
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
  }, []);

  const handleCopy = () => {
    if (!loginCommand) return;
    navigator.clipboard.writeText(loginCommand).catch(() => { /* leave Copied! state alone; user can retry */ });
    setCopied(true);
    if (copyTimeout.current) clearTimeout(copyTimeout.current);
    copyTimeout.current = setTimeout(() => setCopied(false), 2000);
  };

  // Only a state that wants the user's attention earns a colored edge. "Found and
  // signed in" is the expected case, so it stays neutral - otherwise a fully
  // configured machine paints a wall of green down the whole panel, and
  // --kng-active (which means "an agent is working" everywhere else in the app)
  // stops carrying that meaning.
  const borderClass = !loading && found && unauthenticated
    ? 'border-edge border-l-2 border-l-attention'
    : 'border-edge';

  return (
    <div className={`border rounded-lg p-3 ${borderClass}`} data-testid={testId}>
      <div className="flex items-start gap-2">
        <div className="w-4 h-5 flex items-center justify-center shrink-0">
          {loading ? (
            <Loader2 size={14} className="animate-spin text-fg-faint" />
          ) : unauthenticated ? (
            <CircleAlert size={14} className="text-attention" />
          ) : found ? (
            <CheckCircle size={14} className="text-active" />
          ) : (
            <div className="w-3.5 h-3.5 rounded-full border border-fg-faint/30" />
          )}
        </div>
        <div className="min-w-0">
          <div className={`text-sm font-medium leading-5 ${!loading && found ? 'text-fg' : 'text-fg-muted'}`}>
            {name}
          </div>
          <div className="h-4 flex items-center">
            {loading ? (
              <span className="text-xs text-fg-faint">Checking...</span>
            ) : unauthenticated ? (
              <div className="flex items-center gap-1">
                <span className="text-xs text-attention">Not signed in</span>
                {loginCommand && (
                  <>
                    <span className="text-xs text-fg-faint">-</span>
                    <button
                      className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline cursor-pointer"
                      onClick={handleCopy}
                      title={`Copy "${loginCommand}" to clipboard`}
                      data-testid={testId ? `${testId}-copy-login` : undefined}
                    >
                      {copied ? 'Copied!' : <>Copy <code className="font-mono">{loginCommand}</code></>}
                      {!copied && <Copy size={10} />}
                    </button>
                  </>
                )}
              </div>
            ) : found ? (
              <span className="text-xs text-fg-muted">
                {version ? `v${version}` : 'Installed'}
              </span>
            ) : (
              <div className="flex items-center gap-1">
                <span className="text-xs text-fg-faint">Not installed</span>
                {installUrl && (
                  <>
                    <span className="text-xs text-fg-faint">-</span>
                    <button
                      className="inline-flex items-center gap-0.5 text-xs text-accent hover:underline cursor-pointer"
                      onClick={() => window.electronAPI.shell.openExternal(installUrl)}
                    >
                      Install
                      <ExternalLink size={10} />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
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
  const detectionResolved = gitInfo !== null && agentListLoaded;

  const foundAgents = agentList.filter((agent) => agent.found);
  const signedOutAgent = foundAgents.find((agent) => agent.authenticated === false);
  const gitReady = gitInfo?.found ?? false;
  const readyToRun = detectionResolved && gitReady && foundAgents.length > 0 && !signedOutAgent;
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
  // ready state is two scannable FACTS, so each gets its own pill - the eye can
  // pick "git 2.51.0" and "9 agents" out without reading a sentence.
  let readinessMessage: string | null = null;
  if (!detectionResolved) {
    readinessMessage = 'Checking your setup';
  } else if (!gitReady && foundAgents.length === 0) {
    readinessMessage = 'Install git and one agent CLI to run tasks.';
  } else if (!gitReady) {
    readinessMessage = 'Install git to run tasks.';
  } else if (foundAgents.length === 0) {
    readinessMessage = 'Install one agent CLI to run tasks.';
  } else if (signedOutAgent) {
    readinessMessage = `Sign in to ${signedOutAgent.displayName} to run tasks.`;
  }

  const gitFact = gitInfo?.version ? `Git ${gitInfo.version}` : 'Git';
  const agentFact = foundAgents.length === 1
    ? (foundAgents[0].version ? `${foundAgents[0].displayName} ${foundAgents[0].version}` : foundAgents[0].displayName)
    : `${foundAgents.length} agents`;

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
            wave's duration stays owned by the branding package. */}
        <OverseerMascot scale={7} intro="wave-once" sequence="blink-loop" className="mx-auto mb-6" />
        {/* The mark is sized to the wordmark's CAP HEIGHT, not its line box.
            text-4xl is a 36px box but only ~26px of that is capital letters -
            the rest is descender space for the "g" - so a 36px disc reads as
            taller than the word. 28px matches the caps with the slight extra a
            circle needs to look equal beside flat-topped letters, and the same
            3px nudge as the version pill sits it on the cap band. */}
        <div className="flex items-center justify-center gap-3 mb-1">
          <img src={brandLogoUrl} alt="" aria-hidden="true" draggable={false} className="block w-7 h-7 translate-y-[3px]" />
          <h1 className="text-4xl font-bold text-fg leading-none">Kangentic</h1>
          {/* Centered on the wordmark's CAP band rather than its line box: with
              `leading-none` the box includes descender space ("g"), so a plain
              items-center sits the pill visibly high. Nudging by half the
              descender re-centers it against the letters the eye actually reads. */}
          {appVersion && (
            <Pill
              size="xs"
              shape="square"
              className="self-center translate-y-[3px] bg-surface-hover text-fg-muted font-medium"
              data-testid="welcome-app-version"
            >
              v{appVersion}
            </Pill>
          )}
        </div>
        <p className="text-lg text-fg-muted mb-0">Kanban for AI coding agents</p>

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
            {detectionResolved ? <FolderOpen size={20} /> : <Loader2 size={20} className="animate-spin" />}
            {detectionResolved ? 'Open a project' : 'Checking your setup'}
          </button>
          {/* Only the blocked case gets subtext. When ready, "Open a project" plus
              a folder icon already says it, and the native picker repeats the same
              sentence one click later. */}
          {detectionResolved && !readyToRun && (
            <p className="text-sm text-fg-faint mt-2">
              You can look around now and install an agent later.
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
                <Loader2 size={14} className="animate-spin text-fg-faint shrink-0" />
              ) : blocked ? (
                <CircleAlert size={14} className="text-attention shrink-0" />
              ) : (
                <CheckCircle size={14} className="text-active shrink-0" />
              )}
              {/* Ready state renders neutral chips, not green: the check icon
                  already carries the verdict, and --kng-active means "an agent is
                  working" on every other surface. Facts get weight, not hue. */}
              {readinessMessage !== null ? (
                <span className="truncate">{readinessMessage}</span>
              ) : (
                <span className="flex items-center gap-1.5 min-w-0">
                  <span className="shrink-0">Found</span>
                  <Pill size="xs" shape="square" className="bg-surface-hover text-fg font-medium shrink-0">
                    {gitFact}
                  </Pill>
                  <span className="shrink-0">and</span>
                  <Pill size="xs" shape="square" className="bg-surface-hover text-fg font-medium min-w-0">
                    <span className="truncate">{agentFact}</span>
                  </Pill>
                </span>
              )}
            </span>
            {detectionResolved && (
              <span className="inline-flex items-center gap-1 text-xs text-fg-muted group-hover:text-fg transition-colors shrink-0">
                {expanded ? 'Hide setup' : 'Show setup'}
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
                  among twelve agents where it reads as just another one. */}
              <div className="flex items-center justify-between">
                <div className="text-xs text-fg-faint uppercase tracking-wider">Core</div>
                <button
                  onClick={handleRefresh}
                  disabled={refreshing}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-fg-muted bg-surface-raised hover:bg-surface-hover hover:text-fg cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  data-testid="welcome-refresh"
                  title="Check again for git and agent CLIs"
                >
                  <RefreshCw size={12} />
                  Refresh
                </button>
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
                <p className="text-xs text-warning text-left">
                  Git {gitInfo.version} is older than the recommended 2.25 - worktrees may not work.
                </p>
              )}

              <div className="text-xs text-fg-faint uppercase tracking-wider pt-1">Agents</div>
              <div className="grid grid-cols-3 gap-2 text-left" data-testid="welcome-agent-grid">
                {!agentListLoaded ? (
                  <>
                    <DetectionRowSkeleton />
                    <DetectionRowSkeleton />
                    <DetectionRowSkeleton />
                  </>
                ) : (
                  <>
                    {foundAgents.map((agent) => (
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
                      />
                    ))}
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
                  className="text-xs text-accent-fg hover:underline cursor-pointer"
                >
                  Show all {agentList.length} agents
                </button>
              )}
            </div>
          )}
        </div>
        </div>

        <div className="mt-8 border-t border-edge pt-5 text-left">
          <div className="text-xs text-fg-faint uppercase tracking-wider mb-3">When you open a project</div>
          {/* All three headings describe what Kangentic does, in the same
              third-person voice, and each body states one checkable fact. */}
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <FileText size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium">Reads your project's setup</div>
                <div className="text-fg-faint text-sm">Agents run inside your repo, so they pick up the instructions and config already there</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <GitBranch size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium">Isolates every task</div>
                <div className="text-fg-faint text-sm">Each task runs on its own branch, so two agents never edit the same files</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <Terminal size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium">Runs real terminals</div>
                <div className="text-fg-faint text-sm">Watch an agent work and type back to steer it</div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer link row: laid out to accept a second low-weight link later
            (e.g. a Kangentic Mobile mention, tracked separately) without a relayout. */}
        <div className="mt-6 mb-8 flex items-center justify-center gap-4 text-sm">
          <button
            type="button"
            onClick={() => window.electronAPI.shell.openExternal(SETUP_GUIDE_URL)}
            className="inline-flex items-center gap-1 text-accent-fg underline underline-offset-2 hover:opacity-80 cursor-pointer"
            title={SETUP_GUIDE_URL}
          >
            Read the setup guide
            <ExternalLink size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}
