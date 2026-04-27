import { useEffect, useRef, useState } from 'react';
import { FolderOpen, FileText, GitBranch, Terminal, CheckCircle, CircleAlert, Copy, Loader2, RefreshCw, ExternalLink } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { agentInstallUrl, agentLoginCommand } from '../../utils/agent-display-name';
import logoSrc from '../../assets/logo-32.png';

/** Reusable detection card used for both Git and agent entries */
function DetectionCard({ name, testId, found, version, installUrl, loading, authenticated, loginCommand }: {
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

  const borderClass = !loading && found
    ? unauthenticated
      ? 'border-edge border-l-2 border-l-amber-500'
      : 'border-edge border-l-2 border-l-green-500'
    : 'border-edge';

  return (
    <div className={`border rounded-lg p-3 ${borderClass}`} data-testid={testId}>
      <div className="flex items-start gap-2">
        <div className="w-4 h-5 flex items-center justify-center shrink-0">
          {loading ? (
            <Loader2 size={14} className="animate-spin text-fg-faint" />
          ) : unauthenticated ? (
            <CircleAlert size={14} className="text-amber-400" />
          ) : found ? (
            <CheckCircle size={14} className="text-green-400" />
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
                <span className="text-xs text-amber-400">Not signed in</span>
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
              <span className="text-xs text-green-400">
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

/** Skeleton placeholder for a detection card while loading */
function DetectionCardSkeleton() {
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
  const openProjectByPath = useProjectStore((state) => state.openProjectByPath);
  const appVersion = useConfigStore((state) => state.appVersion);
  const agentList = useConfigStore((state) => state.agentList);
  const gitInfo = useConfigStore((state) => state.gitInfo);
  const detectGit = useConfigStore((state) => state.detectGit);
  const loadAgentList = useConfigStore((state) => state.loadAgentList);

  const [refreshing, setRefreshing] = useState(false);

  const anyAgentFound = agentList.length > 0 && agentList.some((agent) => agent.found);
  const prerequisitesMet = gitInfo !== null && gitInfo.found && anyAgentFound;
  const agentListLoaded = agentList.length > 0;

  const handleOpenProject = async () => {
    const selectedPath = await window.electronAPI.dialog.selectFolder();
    if (!selectedPath) return;
    await openProjectByPath(selectedPath);
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    const minimumDelay = new Promise((resolve) => setTimeout(resolve, 800));
    await Promise.all([minimumDelay, detectGit(), loadAgentList()]);
    setRefreshing(false);
  };

  return (
    <div className="flex-1 flex justify-center items-start pt-[12vh] text-fg-faint overflow-y-auto">
      <div className="text-center max-w-md">
        <div className="flex items-center justify-center gap-2.5 mb-1">
          <img src={logoSrc} alt="" className="w-9 h-9" />
          <span className="text-3xl font-bold text-fg leading-none">Kangentic</span>
          {appVersion && <span className="text-xs text-fg-faint/50 self-end mb-0.5">v{appVersion}</span>}
        </div>
        <p className="text-lg text-fg-muted mb-0">Kanban for AI coding agents</p>

        <div className="mt-8 border-t border-edge pt-5 text-left">
          <div className="text-xs text-fg-faint uppercase tracking-wider mb-3">When you open a project</div>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <FileText size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium">Picks up your project settings</div>
                <div className="text-fg-faint text-xs">Agents work within your codebase's conventions and config</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <GitBranch size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium">Isolates work per task</div>
                <div className="text-fg-faint text-xs">Each task gets its own agent session and optional worktree branch</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <Terminal size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium">Run agents in real terminals</div>
                <div className="text-fg-faint text-xs">Watch, interact with, and guide agents as they work</div>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-5 border-t border-edge text-center">
            <button
              onClick={handleOpenProject}
              disabled={!prerequisitesMet}
              className={`inline-flex items-center gap-2 px-8 py-3 rounded-full font-medium shadow-md transition-opacity ${
                prerequisitesMet
                  ? 'bg-accent text-white hover:opacity-90 cursor-pointer'
                  : 'bg-accent/40 text-white/60 cursor-not-allowed'
              }`}
              data-testid="welcome-open-project"
            >
              <FolderOpen size={20} />
              Open a Project
            </button>
          </div>
        </div>

        <div className="mt-6 border-t border-edge pt-5 text-left">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs text-fg-faint uppercase tracking-wider">Requirements</div>
            <button
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs text-fg-muted bg-surface-raised hover:bg-surface-hover hover:text-fg cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="welcome-refresh"
              title="Re-check requirements"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>

          {/* Git status */}
          <div className="mb-3" data-testid="welcome-git-status">
            {gitInfo === null ? (
              <DetectionCardSkeleton />
            ) : (
              <DetectionCard
                name="Git"
                found={gitInfo.found}
                version={gitInfo.version}
                installUrl="https://git-scm.com/downloads"
                loading={refreshing}
              />
            )}
          </div>

          {/* Agent grid */}
          <div className="text-xs text-fg-faint uppercase tracking-wider mb-2">Supported Agents</div>
          <div className="grid grid-cols-2 gap-2" data-testid="welcome-agent-grid">
            {agentListLoaded ? (
              agentList.map((agent) => (
                <DetectionCard
                  key={agent.name}
                  name={agent.displayName}
                  testId={`welcome-agent-${agent.name}`}
                  found={agent.found}
                  version={agent.version}
                  installUrl={agentInstallUrl(agent.name)}
                  loading={refreshing}
                  authenticated={agent.authenticated}
                  loginCommand={agentLoginCommand(agent.name)}
                />
              ))
            ) : (
              <>
                <DetectionCardSkeleton />
                <DetectionCardSkeleton />
                <DetectionCardSkeleton />
                <DetectionCardSkeleton />
              </>
            )}
          </div>
          {/* Always reserve space for the warning to prevent layout shift */}
          <p className={`text-xs mt-2 h-4 select-none ${agentListLoaded && !anyAgentFound ? 'text-amber-400' : 'invisible'}`}>
            At least one agent is required to use Kangentic
          </p>
        </div>
      </div>
    </div>
  );
}
