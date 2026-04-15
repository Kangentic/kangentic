/**
 * Maps agent identifiers (e.g. 'claude') to human-readable display names.
 * Modeled after shell-display-name.ts.
 */

interface AgentMeta {
  /** Full product name, e.g. "Claude Code". */
  display: string;
  /** Short name for model/context fallbacks, e.g. "Claude". */
  short: string;
  /** URL to install documentation. */
  installUrl: string;
}

const AGENT_META: Record<string, AgentMeta> = {
  claude: {
    display: 'Claude Code',
    short: 'Claude',
    installUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
  },
  codex: {
    display: 'Codex CLI',
    short: 'Codex',
    installUrl: 'https://github.com/openai/codex',
  },
  gemini: {
    display: 'Gemini CLI',
    short: 'Gemini',
    installUrl: 'https://github.com/google-gemini/gemini-cli',
  },
  aider: {
    display: 'Aider',
    short: 'Aider',
    installUrl: 'https://aider.chat',
  },
  warp: {
    display: 'Oz CLI',
    short: 'Oz',
    installUrl: 'https://docs.warp.dev/reference/cli/cli',
  },
  copilot: {
    display: 'GitHub Copilot CLI',
    short: 'Copilot',
    installUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
  },
};

/** Full product name for an agent identifier (e.g. 'claude' -> 'Claude Code'). */
export function agentDisplayName(agentId: string | null | undefined): string {
  if (!agentId) return 'Agent';
  return AGENT_META[agentId]?.display ?? agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

/** Short name for model/context fallbacks (e.g. 'claude' -> 'Claude'). */
export function agentShortName(agentId: string | null | undefined): string {
  if (!agentId) return 'Agent';
  return AGENT_META[agentId]?.short ?? agentId.charAt(0).toUpperCase() + agentId.slice(1);
}

/** Install URL for an agent CLI. Returns null if unknown. */
export function agentInstallUrl(agentId: string | null | undefined): string | null {
  if (!agentId) return null;
  return AGENT_META[agentId]?.installUrl ?? null;
}
