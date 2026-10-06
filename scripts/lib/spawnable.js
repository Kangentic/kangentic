/**
 * Resolve an agent CLI to a file a child process can start. node-pty and child_process both need a
 * real path on Windows, and several CLIs install as .ps1 or .cmd shims that cannot start directly,
 * so the CLI is resolved through PATH and a shim is wrapped in its interpreter.
 *
 * Shared by scripts/capture-agent-scrollback.js (a recording in a PTY) and
 * scripts/capture-demo-archived-runs.mjs (a headless run), with the environment both runs get.
 */
const { execFileSync } = require('node:child_process');

function toSpawnable(exe, args) {
  let resolved = exe;
  if (process.platform === 'win32') {
    let lookup = [];
    try {
      lookup = execFileSync('where.exe', [exe], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      // where.exe exits non-zero when nothing matches: reported below.
    }
    if (lookup.length === 0) throw new Error(`Could not find ${exe} on PATH`);
    // npm installs three shims side by side (an extensionless shell script, .cmd, .ps1). Prefer
    // a native executable, then .cmd (or .bat, which cmd.exe runs the same way), then .ps1; the
    // shell script cannot start as a process.
    const rank = (candidate) => (/\.exe$/i.test(candidate) ? 0 : /\.(cmd|bat)$/i.test(candidate) ? 1 : /\.ps1$/i.test(candidate) ? 2 : 3);
    resolved = lookup.slice().sort((left, right) => rank(left) - rank(right))[0];
  }
  if (/\.ps1$/i.test(resolved)) {
    return { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved, ...args], shell: 'powershell' };
  }
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return { file: 'cmd.exe', args: ['/d', '/c', resolved, ...args], shell: 'cmd' };
  }
  return { file: resolved, args, shell: null };
}

/**
 * Characters each shim's interpreter re-parses after Node has quoted the argument: cmd.exe expands
 * %VAR% even inside quotes, and a quote or a newline breaks either shell's quoting.
 */
const SHELL_REPARSED = { cmd: /[%"^&|<>\r\n]/, powershell: /["$`\r\n]/ };

/** Node quotes an argument that is empty or holds a space or a tab. */
const nodeQuotes = (argument) => argument === '' || /[ \t]/.test(argument);

/**
 * The first argument the shim's interpreter would re-parse, or null when it starts directly or none
 * would be. For cmd.exe that includes the shim's own path when the line would lose its quotes: Node
 * quotes a path that holds a space, so the line after `/c` opens with a quote, and when any later
 * argument is quoted too, `/c` strips the line's first and last quote and cmd.exe runs the path cut
 * at its first space.
 */
function shellReparsedArgument(spawnable) {
  if (spawnable.shell === null) return null;
  const pattern = SHELL_REPARSED[spawnable.shell];
  const reparsed = spawnable.args.find((argument) => pattern.test(argument));
  if (reparsed !== undefined) return reparsed;
  if (spawnable.shell === 'cmd') {
    const [, , shimPath, ...callerArgs] = spawnable.args;
    if (shimPath !== undefined && nodeQuotes(shimPath) && callerArgs.some(nodeQuotes)) return shimPath;
  }
  return null;
}

/**
 * The environment an agent run gets: this process's, less the variables a Claude Code session sets
 * for itself (CLAUDECODE, CLAUDE_CODE_*), which would otherwise leak into the run.
 */
function childAgentEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) continue;
    env[key] = value;
  }
  return env;
}

module.exports = { toSpawnable, shellReparsedArgument, childAgentEnv };
