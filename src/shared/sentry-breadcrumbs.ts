/**
 * The breadcrumb policy for Sentry error reporting. Both processes install
 * `filterBreadcrumb` as the SDK's `beforeBreadcrumb`: the main process in
 * src/main/analytics/error-reporting.ts and the renderer in
 * src/renderer/error-reporting.ts.
 *
 * It exists because every event carried up to 200 breadcrumbs (main's 100-slot
 * ring plus the renderer's) and nothing filtered them. normalizePathsIntegration
 * rewrites stack frames, never breadcrumbs. Production events carried home
 * paths, agent command lines, task titles, column prompt text, branch names,
 * project paths inside click selectors, and a Browser pane search URL.
 *
 * Both processes run it because the SDK applies `beforeBreadcrumb` only inside
 * core's top-level addBreadcrumb(). A renderer crumb reaches main through the
 * ScopeToMain integration, and main adds it with `scope.addBreadcrumb`
 * (@sentry/electron/esm/main/ipc.js, handleScope), which never calls main's
 * hook. So the renderer has to apply the same policy before it forwards.
 *
 * It runs at the source rather than in beforeSend for two reasons. A dropped
 * crumb never takes a slot in the ring, so the crumbs worth keeping are not
 * evicted by the ones thrown away. And the SDK's internal-exception re-capture
 * skips beforeSend entirely, but never sees a crumb that was not added.
 *
 * The policy denies by default: a category not handled below is dropped, so a
 * new SDK integration or version cannot start sending a new kind of crumb
 * unreviewed. It also fails CLOSED, the opposite of beforeSendEvent's fail-open:
 * a throw drops the crumb, because losing one crumb is the safe failure for a
 * privacy filter.
 *
 * No node or electron imports: the renderer bundles this module.
 * docs/analytics.md ("Breadcrumbs are filtered at the source") is the prose.
 */

/**
 * The breadcrumb fields this policy reads or writes. Sentry's own `Breadcrumb`
 * fits it, so `filterBreadcrumb` drops straight into `beforeBreadcrumb` in
 * either process without this module importing either SDK.
 */
export interface BreadcrumbShape {
  category?: string;
  message?: string;
  level?: string;
  data?: { [key: string]: unknown };
}

/**
 * Console lines kept as breadcrumbs, by leading tag. Every other console line
 * is dropped. Each entry is a promise that the tag's lines carry no user
 * content: counts, ids, fixed text, and Error arguments, which are reduced to
 * name and code below. tests/unit/sentry-breadcrumbs.test.ts scans every string
 * literal that starts with one of these for interpolated user content, so
 * adding a tag here puts its lines under that scan.
 *
 * - `[UPDATER]`, and `[electron-updater]` for the library's own lines (tagged by
 *   the logger in src/main/updater.ts): the updater's state machine.
 * - `[SHUTDOWN]`: the quit sequence and the PTY exit drain. A native crash with
 *   no `pty-drain:start` is read through these
 *   (.claude/rules/synchronous-shutdown.md).
 * - `[terminal-webgl]`, `[gpu]`, `[GPU-HEALTH]`: WebGL and GPU recovery.
 * - `[APP]`: uncaught errors and startup faults.
 */
export const CONSOLE_BREADCRUMB_TAGS: readonly string[] = [
  '[UPDATER]',
  '[electron-updater]',
  '[SHUTDOWN]',
  '[terminal-webgl]',
  '[gpu]',
  '[GPU-HEALTH]',
  '[APP]',
];

/**
 * Kept console lines that Electron writes itself, so no file in this repo holds
 * them. `ipcMain.handle` logs a rejected handler as
 * `Error occurred in handler for '<channel>':` plus the Error. The channel is
 * one of ours, and the Error is reduced like any other.
 */
export const EXTERNAL_CONSOLE_BREADCRUMB_PREFIXES: readonly string[] = [
  "Error occurred in handler for '",
];

/**
 * Request URLs that are Kangentic's own, so a request crumb may keep their path
 * (never the query or fragment). Any other URL is removed and the crumb keeps
 * only its method and status. Main's fetch also reaches the board adapters,
 * where a Jira or Azure DevOps URL names the user's organization, the webhook
 * automation, where a URL can hold its secret in the path, and a remote
 * transcription server. Compared in lower case.
 */
export const KANGENTIC_URL_PREFIXES: readonly string[] = [
  'https://github.com/kangentic/',
  'https://api.github.com/repos/kangentic/',
  'https://raw.githubusercontent.com/kangentic/',
  'https://release-assets.githubusercontent.com/',
  'https://objects.githubusercontent.com/',
  'https://us.aptabase.com/',
];

const REDACTED_PATH = '<path>';

// No lookbehind: the renderer bundle is also the web demo, and Safari before
// 16.4 rejects a lookbehind at parse time, which would take the whole module
// down. The two patterns that need a boundary capture the character before the
// path instead (`$1`) and put it back.

// A file URL first, since its `///` hides the path from the POSIX pattern below.
const FILE_URL = /file:\/\/[^\s"'<>)\]]*/gi;
// Then an extended-length or device path (`\\?\C:\...`, `\\?\UNC\server\share\...`,
// `\\.\C:\...`). The `?` stops the UNC pattern, and the drive pattern alone
// would leave the `\\?\` prefix behind.
const EXTENDED_LENGTH_PATH = /\\\\[?.]\\(?:UNC\\|[A-Za-z]:[\\/])(?:[^\\/\r\n"'<>|*?:]*[\\/])*[^\s\\/"'<>|*?:,;)\]]*/g;
// Each inner segment may hold spaces (`C:\Users\First Last\`). The last segment
// stops at whitespace, a quote, or `:`, so `<file>:12:5` keeps its position.
const WINDOWS_DRIVE_PATH = /(^|[^A-Za-z0-9])[A-Za-z]:[\\/](?:[^\\/\r\n"'<>|*?:]*[\\/])*[^\s\\/"'<>|*?:,;)\]]*/g;
const UNC_PATH = /\\\\(?:[^\\/\r\n"'<>|*?:]*[\\/])+[^\s\\/"'<>|*?:,;)\]]*/g;
// At least two segments, and never inside a URL: a `/` right after a word
// character, `.` or `/` is part of something else (`n/a`, `host/path`), and so
// is a `//` (`https://`). A `/` right after `:` does start a path, which is how
// the second entry of `/usr/bin:/home/<name>/bin` is caught.
const POSIX_PATH = /(^|[^\w.~/\\-])\/(?!\/)(?:[^/\r\n"'<>|*?:]*\/)+[^\s/"'<>|*?:,;)\]]*/g;

/**
 * Replace every absolute filesystem path in `text` with `<path>`: drive paths
 * with either separator, UNC paths, extended-length (`\\?\`) paths, file URLs,
 * and POSIX paths of two or more
 * segments. Not only the home directory, because a project path outside it
 * (`D:\clients\<name>\repo`) names the project just as well. URLs are left
 * alone. Errs toward redacting too much, since a path segment can hold spaces
 * and the pattern cannot tell where a sentence resumes.
 */
export function redactPaths(text: string): string {
  return text
    .replace(FILE_URL, REDACTED_PATH)
    .replace(EXTENDED_LENGTH_PATH, REDACTED_PATH)
    .replace(WINDOWS_DRIVE_PATH, `$1${REDACTED_PATH}`)
    .replace(UNC_PATH, REDACTED_PATH)
    .replace(POSIX_PATH, `$1${REDACTED_PATH}`);
}

/** A class name: `TypeError`, `HttpError`. No hyphens or dots, so a slug cannot pass. */
const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
/** An upper-case constant (`ENOENT`, `ERR_UPDATER_INVALID_RELEASE_FEED`,
 *  `SQLITE_BUSY`) or an integer exit status. A code shaped like a branch slug
 *  (`fix-the-login-redirect`) is omitted. */
const ERROR_CODE = /^(?:[A-Z][A-Z0-9_]{0,63}|-?\d{1,10})$/;

/** `TypeError`, or `Error(ENOENT)` when the error carries a code. */
function describeError(error: Error): string {
  const name = ERROR_NAME.test(error.name) ? error.name : 'Error';
  const code = (error as { code?: unknown }).code;
  const codeText = typeof code === 'string' || typeof code === 'number' ? String(code) : '';
  return ERROR_CODE.test(codeText) ? `${name}(${codeText})` : name;
}

function isKeptConsoleLine(line: string): boolean {
  return (
    CONSOLE_BREADCRUMB_TAGS.some((tag) => line.startsWith(tag))
    || EXTERNAL_CONSOLE_BREADCRUMB_PREFIXES.some((prefix) => line.startsWith(prefix))
  );
}

/**
 * Keep an allowlisted console line, rebuilt from its arguments rather than from
 * the SDK's joined message. The first argument (the tagged line) keeps its text
 * with paths redacted. An Error argument becomes its name and code, so its
 * message and stack go: git and fs error text can hold a branch named after a
 * task. Numbers and booleans stay. Every other argument, including a trailing
 * string, is dropped, and so is `data.arguments`. A single-string line such as
 * `[SHUTDOWN] pty-drain:start n=2 blind=0` comes through byte-identical.
 *
 * `debug` is dropped whatever the tag, which keeps electron-updater's
 * blockmap chatter out of the ring while the terminal still shows it.
 */
function keepConsoleCrumb(crumb: BreadcrumbShape): boolean {
  if (crumb.level === 'debug') return false;
  const consoleArguments = crumb.data?.arguments;
  if (!Array.isArray(consoleArguments) || consoleArguments.length === 0) return false;
  const [firstArgument, ...restArguments] = consoleArguments;
  if (typeof firstArgument !== 'string' || !isKeptConsoleLine(firstArgument)) return false;

  const parts = [redactPaths(firstArgument)];
  for (const argument of restArguments) {
    if (argument instanceof Error) {
      parts.push(describeError(argument));
    } else if (typeof argument === 'number' || typeof argument === 'boolean') {
      parts.push(String(argument));
    }
  }
  crumb.message = parts.join(' ');
  crumb.data = { logger: 'console' };
  return true;
}

// The SDK writes a selector attribute as `[name="value"]` without escaping the
// value, so the lazy match ends at the first `"]`. These four are the ones it
// always appends, and their values held project paths, task slugs, file paths
// and project names in production.
const STRIPPED_SELECTOR_ATTRIBUTE = /\[(title|aria-label|name|alt)="[\s\S]*?"\]/g;
const KEPT_SELECTOR_ATTRIBUTE = /\[type="[^"]*"\]/g;

/**
 * Keep a click or keypress crumb's selector, with the values of `title`,
 * `aria-label`, `name` and `alt` removed (`[title]`). `type` keeps its value.
 * Tag names, ids and classes are code, so they stay. If any quote survives
 * outside a `[type="..."]`, a value ended early or an attribute we did not
 * expect is present, and the whole crumb is dropped.
 */
function keepUiCrumb(crumb: BreadcrumbShape): boolean {
  if (typeof crumb.message !== 'string') return false;
  const stripped = crumb.message.replace(STRIPPED_SELECTOR_ATTRIBUTE, '[$1]');
  if (stripped.replace(KEPT_SELECTOR_ATTRIBUTE, '').includes('"')) return false;
  crumb.message = stripped;
  delete crumb.data;
  return true;
}

/**
 * Electron's lifecycle crumbs (`app.ready`, `window.focus`, `renderer.dom-ready`)
 * keep their message and the webContents id. A URL stays only when it is the
 * app's own page (`app:///`), without its query. A Browser pane guest reports
 * the real page it is on, which is how a search query reached Sentry.
 */
function keepElectronCrumb(crumb: BreadcrumbShape): boolean {
  const data = crumb.data;
  if (!data) return true;
  const kept: { [key: string]: unknown } = {};
  if (typeof data.id === 'number') kept.id = data.id;
  if (typeof data.url === 'string' && data.url.startsWith('app:///')) {
    kept.url = data.url.split(/[?#]/)[0];
  }
  if (Object.keys(kept).length > 0) crumb.data = kept;
  else delete crumb.data;
  return true;
}

function basename(value: string): string {
  const segments = value.split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}

/**
 * Node's child-process crumbs: `Child process exited with code '1'`, or
 * `Child process errored with 'spawn pwsh.exe ENOENT'`. The spawned file can be
 * an absolute path under the home directory, so the message is path-redacted
 * and `spawnfile` keeps only its file name.
 */
function keepNodeChildProcessCrumb(crumb: BreadcrumbShape): boolean {
  if (typeof crumb.message === 'string') crumb.message = redactPaths(crumb.message);
  const spawnfile = crumb.data?.spawnfile;
  if (typeof spawnfile === 'string') crumb.data = { spawnfile: basename(spawnfile) };
  else delete crumb.data;
  return true;
}

function kangenticUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  // `origin` never carries credentials, and the pathname never carries the query.
  const bareUrl = `${parsed.origin}${parsed.pathname}`;
  const lowerCaseUrl = bareUrl.toLowerCase();
  return KANGENTIC_URL_PREFIXES.some((prefix) => lowerCaseUrl.startsWith(prefix)) ? bareUrl : null;
}

const KEPT_REQUEST_FIELDS = ['method', 'http.method', 'status_code'];

/**
 * A request crumb (`http` from main's fetch, `electron.net`, and the renderer's
 * `fetch` / `xhr`) keeps its method and status. The URL stays only when it is
 * one of Kangentic's own, and never with its query or fragment. `http.query`
 * and `http.fragment`, which the SDK splits out on purpose, always go.
 */
function keepRequestCrumb(crumb: BreadcrumbShape): boolean {
  const data = crumb.data ?? {};
  const kept: { [key: string]: unknown } = {};
  for (const field of KEPT_REQUEST_FIELDS) {
    const value = data[field];
    if (typeof value === 'string' || typeof value === 'number') kept[field] = value;
  }
  const url = typeof data.url === 'string' ? kangenticUrl(data.url) : null;
  if (url) kept.url = url;
  crumb.data = kept;
  delete crumb.message;
  return true;
}

/**
 * The `beforeBreadcrumb` for both processes. Returns the crumb, rewritten in
 * place, or null to drop it. See the module comment for the policy.
 */
export function filterBreadcrumb<T extends BreadcrumbShape>(breadcrumb: T): T | null {
  try {
    const crumb: BreadcrumbShape = breadcrumb;
    let keep: boolean;
    switch (crumb.category) {
      case 'console':
        keep = keepConsoleCrumb(crumb);
        break;
      case 'ui.click':
      case 'ui.input':
        keep = keepUiCrumb(crumb);
        break;
      case 'electron':
        keep = keepElectronCrumb(crumb);
        break;
      case 'child-process':
        // Electron's own child-process-gone details: type, reason, exitCode,
        // serviceName. No path, URL or user text.
        keep = true;
        break;
      case 'child_process':
        keep = keepNodeChildProcessCrumb(crumb);
        break;
      case 'http':
      case 'electron.net':
      case 'fetch':
      case 'xhr':
        keep = keepRequestCrumb(crumb);
        break;
      // `sentry.event` repeats an earlier event's message and stack, and that
      // event already reached Sentry on its own. `navigation` carries page URLs,
      // which in the renderer are file paths.
      case 'sentry.event':
      case 'navigation':
      default:
        keep = false;
    }
    return keep ? breadcrumb : null;
  } catch {
    return null;
  }
}
