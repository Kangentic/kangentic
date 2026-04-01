import { FolderOpen, FileText, GitBranch, Terminal, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useConfigStore } from '../../stores/config-store';
import { agentDisplayName, agentInstallUrl } from '../../utils/agent-display-name';
import logoSrc from '../../assets/logo-32.png';

/** Pulsing skeleton line shown while detection is in progress */
function DetectionSkeleton({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5 text-sm text-fg-faint">
      <Loader2 size={14} className="animate-spin" />
      <span>Checking {label}...</span>
    </div>
  );
}

export function WelcomeScreen() {
  const openProjectByPath = useProjectStore((state) => state.openProjectByPath);
  const appVersion = useConfigStore((state) => state.appVersion);
  const agentInfo = useConfigStore((state) => state.agentInfo);
  const agentVersionNumber = useConfigStore((state) => state.agentVersionNumber);
  const gitInfo = useConfigStore((state) => state.gitInfo);

  // Hide the button until both detections complete and both pass
  const prerequisitesMet = agentInfo !== null && gitInfo !== null && gitInfo.found !== false && agentInfo.found !== false;

  const handleOpenProject = async () => {
    const selectedPath = await window.electronAPI.dialog.selectFolder();
    if (!selectedPath) return;
    await openProjectByPath(selectedPath);
  };

  return (
    <div className="flex-1 flex items-center justify-center text-fg-faint">
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
                <div className="text-fg text-sm font-medium">Loads your CLAUDE.md and settings</div>
                <div className="text-fg-faint text-xs">Agents get the right context for your codebase</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <GitBranch size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium">Each task gets its own agent session</div>
                <div className="text-fg-faint text-xs">Optional worktree branches keep changes isolated</div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 text-fg-muted">
                <Terminal size={18} />
              </div>
              <div>
                <div className="text-fg text-sm font-medium">Drag tasks to start agents</div>
                <div className="text-fg-faint text-xs">Sessions run in real terminals you can watch and interact with</div>
              </div>
            </div>
          </div>

          <div className="mt-5 pt-5 border-t border-edge text-center">
            {prerequisitesMet ? (
              <button
                onClick={handleOpenProject}
                className="inline-flex items-center gap-2 px-8 py-3 rounded-full bg-accent text-white font-medium hover:opacity-90 transition-opacity cursor-pointer shadow-md"
                data-testid="welcome-open-project"
              >
                <FolderOpen size={20} />
                Open a Project
              </button>
            ) : (
              <div className="h-12" /> // Reserve space for button to prevent layout shift
            )}
          </div>
        </div>

        <div className="mt-6 border-t border-edge pt-5 text-left">
          <div className="text-xs text-fg-faint uppercase tracking-wider mb-3">Requirements</div>
          <div className="space-y-1.5">
            {/* Git status */}
            <div data-testid="welcome-git-status">
              {gitInfo === null ? (
                <DetectionSkeleton label="Git" />
              ) : gitInfo.found ? (
                <div className="flex items-center gap-1.5 text-sm text-green-400">
                  <CheckCircle size={14} />
                  <span>Git {gitInfo.version ? `v${gitInfo.version}` : ''}</span>
                </div>
              ) : (
                <div className="space-y-1 text-left">
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle size={14} />
                    <span>Git not found</span>
                  </div>
                  <p className="text-xs text-fg-faint pl-5">
                    Required for worktree isolation.{' '}
                    <button
                      className="underline text-amber-400 hover:opacity-80 cursor-pointer"
                      onClick={() => window.electronAPI.shell.openExternal('https://git-scm.com/downloads')}
                    >
                      Install Git
                    </button>
                  </p>
                </div>
              )}
            </div>

            {/* Claude Code status */}
            <div data-testid="welcome-claude-status">
              {agentInfo === null ? (
                <DetectionSkeleton label={agentDisplayName('claude')} />
              ) : agentInfo.found ? (
                <div className="flex items-center gap-1.5 text-sm text-green-400">
                  <CheckCircle size={14} />
                  <span>{agentDisplayName('claude')} {agentVersionNumber ? `v${agentVersionNumber}` : ''}</span>
                </div>
              ) : (
                <div className="space-y-1 text-left">
                  <div className="flex items-center gap-1.5 text-sm text-amber-400">
                    <AlertTriangle size={14} />
                    <span>{agentDisplayName('claude')} not found</span>
                  </div>
                  <p className="text-xs text-fg-faint pl-5">
                    Required for AI agents.{' '}
                    <button
                      className="underline text-amber-400 hover:opacity-80 cursor-pointer"
                      onClick={() => window.electronAPI.shell.openExternal(agentInstallUrl('claude')!)}
                    >
                      Install {agentDisplayName('claude')}
                    </button>
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
