import { isCmdShell, isPowerShellShell } from '../../../shared/paths';
import { resolveShellArgs, type ShellInvocation } from './pty-spawn';

/**
 * Resolve a shell spec plus a script into the argv that RUNS the script and
 * then exits.
 *
 * The sibling `resolveShellArgs` answers a different question: how to open an
 * INTERACTIVE shell for a person to type into. Its argv deliberately keeps the
 * shell alive (`--login`, `-NoLogo`), and a command is typed into the live PTY
 * afterwards, followed by a carriage return. That is right for an agent session
 * and for the Command Terminal, and it is wrong for an automation: the shell
 * returns to its prompt and sits there forever, so the script's completion is
 * unobservable and its exit code is unobtainable.
 *
 * That shipped. A `run_script` automation whose script finished in under a
 * second was recorded as "Gave up after 60s", because nothing it could listen
 * for ever happened: the script was done, the shell was not.
 *
 * So a script automation takes the non-interactive form of the same shell, runs
 * as an ordinary child process, and its exit code is the process's own.
 */
/**
 * PowerShell's `-Command` reports its OWN success as 0 or 1 and swallows the
 * child's exit code, so `node -e "process.exit(7)"` comes back as 1 and the run
 * record reads "exited with code 1" for a script that exited 7. cmd's `/c` and
 * a POSIX `-c` both propagate natively and need nothing.
 *
 * Measured, all three cases: a native command exiting 7 reports 7 with this and
 * 1 without; a failing CMDLET (which never sets `$LASTEXITCODE`) still reports
 * 1, because the guard falls through to PowerShell's own semantics; and a
 * succeeding cmdlet still reports 0.
 */
const POWERSHELL_EXIT_CODE_PROPAGATION = '\nif ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }';

export function resolveScriptInvocation(shell: string, script: string): ShellInvocation {
  const shellName = shell.toLowerCase();

  // WSL: `wsl.exe -d <distro> -- <command>` runs inside the distro and exits.
  // The login shell is explicit (`-lc`) so the user's rc files load, matching
  // what the interactive form gets from `--login`.
  if (shellName.startsWith('wsl ') || shellName.startsWith('wsl.exe ')) {
    const { exe, args } = resolveShellArgs(shell);
    return { exe, args: [...args, '--', 'bash', '-lc', script] };
  }

  if (isCmdShell(shellName)) return { exe: shell, args: ['/d', '/s', '/c', script] };

  // `-NoProfile` as well as `-NoLogo`: a profile can print banners, change the
  // working directory, or fail outright, none of which a script asked for. The
  // interactive form keeps profiles deliberately, because a person expects
  // their own shell.
  if (isPowerShellShell(shellName)) {
    return { exe: shell, args: ['-NoLogo', '-NoProfile', '-Command', script + POWERSHELL_EXIT_CODE_PROPAGATION] };
  }

  // Every POSIX shell in the picker (bash, zsh, fish, nu) takes `-c`.
  return { exe: shell, args: ['-c', script] };
}
