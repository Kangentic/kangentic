/**
 * Shell quoting primitives with no Node dependency, so the renderer can share
 * them with the main process.
 *
 * `src/shared/paths.ts` re-exports the shell predicates and owns `quoteArg`,
 * but it imports `node:path` at module scope and therefore cannot be pulled
 * into the renderer bundle. Everything here is pure string work.
 */

/**
 * True when the shell is cmd.exe (Windows native).
 *
 * cmd terminates the command line on a literal newline mid-quote, so
 * multi-line quoted args have to be flattened before delivery.
 *
 * Match is anchored on the basename (stripped of `.exe`) to avoid false
 * positives on unrelated paths that contain the substring `cmd` (e.g. a
 * tool installed under `/usr/local/cmd-something/`).
 */
export function isCmdShell(shellName: string): boolean {
  const basename = shellName.toLowerCase().split(/[\\/]/).pop() ?? '';
  return basename.replace(/\.exe$/, '') === 'cmd';
}

/**
 * True for the PowerShell family: Windows PowerShell 5.1 (`powershell.exe`)
 * and PowerShell 7 (`pwsh.exe`), whether the shell spec is a bare picker
 * name or a full path.
 *
 * A substring match on purpose, not the basename anchor `isCmdShell` uses:
 * this is the exact test `isUnixLikeShell` negates, and the two must agree
 * on every input or a spec could be neither unix-like nor PowerShell. Keep
 * them in step if one ever tightens.
 */
export function isPowerShellShell(shellName: string): boolean {
  const lower = shellName.toLowerCase();
  return lower.includes('powershell') || lower.includes('pwsh');
}

/**
 * True when the shell is Unix-like (bash, zsh, fish, nu, wsl) and
 * expects POSIX-style paths.
 *
 * False for cmd.exe (Windows native); PowerShell is handled separately
 * because it needs the `& ` call operator rather than path conversion.
 */
export function isUnixLikeShell(shellName: string): boolean {
  const lower = shellName.toLowerCase();
  return !lower.includes('cmd') && !isPowerShellShell(lower);
}

/**
 * Sanitise text before writing to a PTY.
 *
 * Newlines are interpreted as Enter (submit) by terminal emulators,
 * tabs can trigger autocomplete, and consecutive whitespace is noise.
 * This function collapses all of these into tidy single spaces.
 */
export function sanitizeForPty(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
}

/**
 * Escape text for insertion inside a double-quoted argument, per the rules of
 * the shell that will parse it.
 *
 * cmd.exe and PowerShell have OPPOSITE rules for the backslash, so the branch
 * is load-bearing rather than cosmetic. Measured on pwsh 7.6.6, Windows
 * PowerShell 5.1.26100 and cmd.exe, round-tripped through node's argv:
 *
 *   emitted                 pwsh 7.6           PS 5.1             cmd.exe
 *   "C:\path\"              C:\path\           C:\path\           C:\path"
 *   "C:\path\\"             C:\path\\          C:\path\\          C:\path\
 *   "C:\Program Files\"     C:\Program Files\  C:\Program Files"  C:\Program Files"
 *   "C:\Program Files\\"    C:\Program Files\\ C:\Program Files\  C:\Program Files\
 *   "use ``code``"          use `code`         use `code`         use ``code``
 *
 * The PowerShell column is left alone rather than "fixed", and rows three and
 * four are why. pwsh 7.3+ passes arguments to a native command verbatim, so it
 * is correct for both shapes today and doubling would break both. Windows
 * PowerShell 5.1 re-quotes any argument containing a SPACE before handing it
 * over, so its answer flips with the space: no form is right on both hosts.
 * pwsh 7.6 correct twice beats 5.1 correct once, and the only reachable input
 * shape is a task prompt whose last character is a backslash.
 *
 * Runs BEFORE `quoteArg`'s backtick-n / backtick-t conversion, which is why
 * the backtick doubling belongs here: the escapes that block injects afterwards
 * are NEW backticks the parser must read as escapes, so any literal backtick
 * already in the text has to be doubled first. The cmd branch can never precede
 * that block (`preserveNewlines` requires a non-cmd shell), so a doubled
 * backslash run is never followed by an injected backtick-n.
 */
export function escapeForDoubleQuotedShell(text: string, isCmd: boolean): string {
  if (isCmd) {
    // cmd hands the raw command line to the target executable's C runtime,
    // which reads `\` as an escape ONLY in a run immediately before a quote.
    // Double each such run (interior quotes first, then the closing one), so a
    // trailing backslash cannot swallow the quote that ends the argument.
    // Interior backslashes are untouched, so a path is delivered unchanged.
    // Backtick and `$` are literal to both cmd and the CRT: escaping them the
    // PowerShell way delivers them DOUBLED to the agent.
    return text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  }
  // PowerShell: ` is the escape character and $ starts an expansion. A
  // backslash is NOT special inside "..." - `"C:\path\"` already reaches a
  // native command as `C:\path\` on both hosts, and escaping it would deliver
  // `C:\path\\`. The `\"` below is a cmd/CRT escape that PowerShell rejects as
  // a parse error on both hosts. It is unreachable in production (every
  // prompt-carrying builder pre-replaces `"` with `'` for double-quote shells,
  // and no other quoteArg input can contain a quote on Windows), and no single
  // form works on both hosts - pwsh 7.3+ native argument passing wants `` ` `` +
  // quote, while 5.1's legacy passing drops that quote and wants `\` + backtick
  // + quote. Changing it would pick a loser silently, so it stays as it is.
  return text.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '\\"');
}
