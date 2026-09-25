/**
 * How a substituted template value is made safe for the place it lands.
 *
 * This exists because substitution used to be context-blind. `{{title}}` went
 * raw into a shell script body and into a JSON webhook body alike, and a task
 * title is not always text the user wrote: a task imported from a GitHub issue
 * carries a stranger's title, and a title containing a quote breaks a JSON
 * payload while a title containing a semicolon is a second shell command.
 *
 * Which escape a field gets is declared on the field in `AUTOMATION_MANIFEST`,
 * never decided here and never decided by an adapter.
 */

/**
 * Remove the characters that can break out of a quote or chain a command.
 *
 * STRIPPING, not quoting, and that is the deliberate choice. Correct quoting
 * differs per shell (POSIX single quotes, PowerShell backticks, cmd carets),
 * and `SessionManager` caches one `configuredShell` keyed to the focused
 * project, so a quoting scheme picked from it is right on the machine that
 * picked it and wrong on a teammate's. Stripping is the same everywhere.
 *
 * It is lossy on purpose, and the lossless path is the one a script should
 * prefer anyway: every variable is also exported as a `KANGENTIC_*` environment
 * variable, so `"$KANGENTIC_TITLE"` gets the exact title on a POSIX shell or
 * PowerShell. NOT on cmd.exe: cmd expands `%KANGENTIC_TITLE%` while PARSING and
 * then re-tokenizes what came back, so a raw `&` inside the value chains a
 * second command. `%` is stripped below for exactly that reason, but a script
 * that spells out `%KANGENTIC_*%` itself is still reaching past this function.
 *
 * `%` is in the class because it is cmd.exe's expansion character and is always
 * live there, unlike `!VAR!`, which needs delayed expansion switched on. Without
 * it, a task title of `%KANGENTIC_LABELS%` survives this escape intact, lands in
 * a script body as a variable reference, and cmd expands it to the RAW label
 * text and re-parses that for metacharacters. Measured on Windows: the second
 * command runs. `$` and backtick already cover the POSIX and PowerShell forms.
 *
 * This is the same treatment `resolveShortcutCommand` has always given
 * `{{taskTitle}}`; it lives here so the two systems share one definition.
 */
export function stripShellMetacharacters(value: string): string {
  return value.replace(/[`$%\\!"&|;<>(){}[\]\r\n]/g, '');
}

/**
 * Escape for embedding inside a JSON string literal. `JSON.stringify` handles
 * quotes, backslashes, control characters and lone surrogates correctly; the
 * slice drops the quotes it adds, because the template already supplies them
 * (a body is written `{"title": "{{title}}"}`).
 */
export function escapeForJsonString(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Escape for a URL path segment or query value. */
export function escapeForUrl(value: string): string {
  return encodeURIComponent(value);
}

export type TemplateEscape = 'none' | 'shell' | 'json' | 'url';

export function applyTemplateEscape(value: string, escape: TemplateEscape): string {
  switch (escape) {
    case 'shell':
      return stripShellMetacharacters(value);
    case 'json':
      return escapeForJsonString(value);
    case 'url':
      return escapeForUrl(value);
    case 'none':
      return value;
  }
}
