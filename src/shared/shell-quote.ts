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
 * The curly double quotes PowerShell's tokenizer treats exactly like `"`:
 * U+201C, U+201D and U+201E. U+201F is not one of them (measured), and the
 * curly single quotes are literal inside a double-quoted string. Built from
 * code points so the source holds no curly quote characters.
 * `stripShellMetacharacters` strips this same set, so a later measurement
 * changes both.
 */
export const POWERSHELL_CURLY_DOUBLE_QUOTE_CHARACTERS = String.fromCodePoint(0x201c, 0x201d, 0x201e);

const POWERSHELL_CURLY_DOUBLE_QUOTES = new RegExp(`[${POWERSHELL_CURLY_DOUBLE_QUOTE_CHARACTERS}]`, 'g');

/** `'` plus the curly single quotes PowerShell's tokenizer treats exactly like it. */
const POWERSHELL_SINGLE_QUOTES = new RegExp(`['${String.fromCodePoint(0x2018, 0x2019, 0x201a, 0x201b)}]`, 'g');

/**
 * Escape text for the inside of a PowerShell single-quoted string.
 *
 * PowerShell ends a single-quoted string at `'` and also at the curly single
 * quotes U+2018, U+2019, U+201A and U+201B, and each is escaped by doubling
 * it. Measured on pwsh 7.6.6 and Windows PowerShell 5.1.26100, doubling only
 * `'` left a path holding a curly apostrophe as a parse error ("The string is
 * missing the terminator"), and doubling all five reached the directory.
 */
export function escapeForPowerShellSingleQuoted(text: string): string {
  return text.replace(POWERSHELL_SINGLE_QUOTES, '$&$&');
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
 * Called from `quoteArg`, this runs BEFORE its backtick-n / backtick-t
 * conversion, which is why the backtick doubling belongs here: the escapes that
 * block injects afterwards are NEW backticks the parser must read as escapes,
 * so any literal backtick already in the text has to be doubled first. The cmd
 * branch can never precede that block (`preserveNewlines` requires a non-cmd
 * shell), so a doubled backslash run is never followed by an injected
 * backtick-n. The other caller, `quoteForShell` in the renderer, has no such
 * conversion step and takes this output as the finished cell.
 *
 * `%` is left alone here on purpose. `quoteArg` breaks it out for cmd with
 * `escapePercentForCmd` below, which says why `quoteForShell` must not.
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
  //
  // PowerShell also reads the curly double quotes as string delimiters, so each
  // is doubled, the in-string escape PowerShell gives every double quote. Left
  // bare at a pwsh 7.6.6 prompt over ConPTY, a prompt saying Run (U+201C)tests;
  // Write-Output X(U+201D) please reached the agent split in two and ran
  // Write-Output X as a second command. A task description can come from an
  // imported GitHub issue, so that was an injection. Doubled, it arrives intact
  // with the original curly characters. Windows PowerShell 5.1.26100 at a
  // ConPTY prompt drops these characters from typed input before its parser
  // sees them (as it drops U+2713, while e-acute and CJK survive), so there the
  // doubled pair vanishes exactly as a single one did. A backtick escape was
  // measured too and rejected: on 5.1 the dropped quote leaves the backtick
  // bare, and `t, `n or `b then reaches the agent as a tab, newline or
  // backspace in place of the next letter.
  return text
    .replace(/`/g, '``')
    .replace(/\$/g, '`$')
    .replace(POWERSHELL_CURLY_DOUBLE_QUOTES, '$&$&')
    .replace(/"/g, '\\"');
}

/**
 * Break every `%` out of a double-quoted cmd.exe argument, so cmd cannot
 * expand a `%NAME%` that the text happens to contain.
 *
 * cmd expands `%NAME%` before it looks at quotes, so `"fix %PATH%"` reaches the
 * agent with the PATH value spliced in. Doubling to `%%` does not help. That is
 * a batch-file rule (`for /?` says "in a batch program, specify %%variable"),
 * and both routes here type a command line instead: the interactive prompt the
 * PTY spawn writes into, and the `cmd /d /s /c` that node's `shell: true` runs.
 * Measured on cmd.exe 10.0.26200 with KNG_PROBE=EXPANDED and argv read by node.
 * The result was the same over piped stdin, a ConPTY prompt and `shell: true`,
 * and again through an npm-style `.cmd` shim whose `%*` line parses the
 * arguments a second time:
 *
 *   inside the quotes        delivered
 *   %KNG_PROBE%              EXPANDED
 *   %%KNG_PROBE%%            %EXPANDED%
 *   %^KNG_PROBE%             %^KNG_PROBE%
 *   "^%"KNG_PROBE"^%"        %KNG_PROBE%
 *
 * Each `%` becomes `"^%"`: close the quote, caret-escape the percent, reopen.
 * Every `%` is then followed by a `"`, so any `%name%` pair cmd forms names a
 * variable that starts with `"`. None does, and a command line leaves an
 * undefined name as typed. The caret sits outside the quotes, where cmd removes
 * it, and the C runtime joins `"a "%"b"` back into one argument. The backslash
 * run before each `%` is doubled, because the runtime would otherwise read it
 * and the inserted quote as an escaped `\"`. CommandLineToArgvW, the parser a
 * native agent binary may use instead, reads every form here the same way
 * (measured): the output never puts two quotes in a row inside a quoted run,
 * which is where the two parsers disagree.
 *
 * The input is text already escaped for the inside of `"..."`, and the caret
 * only works where cmd sees the quotes closed. cmd also toggles on the `\"`
 * content escape that `escapeForDoubleQuotedShell` writes for cmd, so an odd
 * number of content quotes delivers stray carets (`say "hi ^%X^%`), though
 * still unexpanded. That input is unreachable, because every prompt builder
 * replaces `"` with `'` for double-quote shells and a Windows path cannot hold
 * `"`. `quoteForCmdShell` writes content quotes as `""`, which keeps cmd's
 * quote state in step, so it has no such case.
 *
 * `escapeForDoubleQuotedShell` does not do this, because its other caller is
 * the renderer's `quoteForShell`. A dropped or pasted path usually lands in an
 * agent's input box rather than at the cmd prompt, where `"^%"` would be
 * literal text inside the path. Its PowerShell branch does escape the curly
 * double quotes for that same caller, and the trade is different there. `%` is
 * common in real filenames (a URL-encoded `%20` download, `100%.png`), so the
 * escape would garble many drops. A curly quote in a filename is rare, the
 * drop path already carries PowerShell's backtick and `$` escapes, and left
 * bare at a PowerShell prompt it is an injection rather than an expansion.
 */
export function escapePercentForCmd(quotedContent: string): string {
  return quotedContent.replace(/(\\*)%/g, '$1$1"^%"');
}

/**
 * Quote an executable path as the head of a command line that cmd.exe parses:
 * node's `exec` and `shell: true` on Windows, which run `cmd /d /s /c`.
 *
 * cmd expands a `%NAME%` in the head as it does anywhere else, and the expanded
 * path does not exist ("The system cannot find the path specified", measured
 * through an npm-style `.cmd` shim). A Windows path cannot hold `"`, so the
 * `%` escape is the only one the head needs.
 */
export function quoteCmdExecutable(executablePath: string): string {
  return `"${escapePercentForCmd(executablePath)}"`;
}
