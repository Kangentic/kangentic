/**
 * Resolve an agent CLI to a file a child process can start. node-pty and child_process both need a
 * real path on Windows, and several CLIs install as .ps1 or .cmd shims that cannot start directly,
 * so the CLI is resolved through PATH and a shim is wrapped in its interpreter.
 *
 * Shared by scripts/capture-agent-scrollback.js (a recording in a PTY) and
 * scripts/capture-demo-archived-runs.mjs (a headless run).
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
    // a native executable, then .cmd, then .ps1; the shell script cannot start as a process.
    const rank = (candidate) => (/\.exe$/i.test(candidate) ? 0 : /\.cmd$/i.test(candidate) ? 1 : /\.ps1$/i.test(candidate) ? 2 : 3);
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

/** The first argument the shim's interpreter would re-parse, or null when it starts directly or none would be. */
function shellReparsedArgument(spawnable) {
  if (spawnable.shell === null) return null;
  const pattern = SHELL_REPARSED[spawnable.shell];
  return spawnable.args.find((argument) => pattern.test(argument)) ?? null;
}

module.exports = { toSpawnable, shellReparsedArgument };
