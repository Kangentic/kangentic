import fs from 'node:fs';
import path from 'node:path';
import { cliPathForTarget, type CliPlace } from './cli-target';
import { quoteBridgePath } from './hook-utils';

/**
 * How the hooks of an agent CLI installed in a WSL distro reach Kangentic.
 *
 * The bridges Kangentic gives a CLI on this machine are node scripts, and a
 * distro may have no node (a native-installed Claude brings none). So a distro
 * hook runs one POSIX `sh` script instead, which only publishes files, and
 * Kangentic does the bridges' work on them (`WslHookInbox`, which runs the
 * bridges' own exported logic):
 *
 * - `event`: the call's type, its directives and its stdin go into one file in
 *   `inbox/`, written under a temporary name and renamed into place.
 * - `reply`: a request goes into `requests/` the same way, and the script waits
 *   for its answer in `responses/` and prints it (plan approval, the background
 *   shell hint). It prints nothing if no answer comes in time, so the CLI asks
 *   the user, as the bridges do when they cannot decide.
 * - `status`: the status line's JSON replaces `status.json` by a rename.
 *
 * Never an append to a shared file: measured over the Windows drive from WSL,
 * sixteen parallel hooks appending to one file kept 158 of 640 records whole,
 * where a file per call kept 640 of 640 (about 13 ms a hook). After each file
 * the script writes one byte to `signal`, which Kangentic watches as a file.
 *
 * The script lives in the session's own folder, written at spawn, so a session
 * never runs a script another session rewrote, and the session folder's own
 * cleanup removes it. It is a constant here, not a shipped file: a checkout
 * with CRLF line endings would break `sh`, and a packaged file would sit in the
 * asar archive, where the distro cannot read it.
 */

/** The folder inside a session's directory that holds the script and its files. */
export const WSL_HOOK_DIRECTORY_NAME = 'wsl-hooks';

/**
 * The variable every distro CLI session carries: its hook folder, as the
 * distro sees it (`performSpawn` lists it in `WSLENV` with `/up`). A script
 * run from anywhere but its own folder finds the folder through it: Codex's
 * hooks run one workspace copy shared by every session in the folder, since
 * Codex trusts a hook by a hash of its command, which must not change per
 * session.
 */
export const WSL_HOOK_DIRECTORY_ENV = 'KANGENTIC_WSL_HOOK_DIR';

/** The header line every published file starts with: the format's version. */
export const WSL_HOOK_RECORD_VERSION = 'K1';

/** What a `reply` request asks for. Kangentic answers each with the matching bridge's logic. */
export type WslHookReplyKind = 'plan-approval' | 'background-shell-hint';

/** How long the script waits for an answer, in 10 ms tries, before it prints nothing. */
const REPLY_WAIT_TRIES = 1000;

/**
 * The script. The hook folder is `$KANGENTIC_WSL_HOOK_DIR`, else `$0`'s own
 * folder, so no path is written into it.
 * A file is named `<epoch ns>-<pid>`, stamped once stdin is read, as the node
 * bridge times its event: names sort in the order the files appear, which is
 * the order Kangentic reads them, and Kangentic takes each event's time from
 * its name. A pid is unique among hooks running at once. A `date` without `%N`
 * (busybox) falls back to whole seconds. Stdin goes straight to the file,
 * never through a shell variable.
 */
export const WSL_HOOK_SCRIPT = [
  '# Kangentic hook transport for an agent CLI in WSL. Written by Kangentic for',
  '# one session; Kangentic reads what it publishes. Do not edit.',
  `dir=\${${WSL_HOOK_DIRECTORY_ENV}:-$(dirname "$0")}`,
  'stamp() {',
  '  s=$(date +%s%N 2>/dev/null)',
  '  case "$s" in ""|*[!0-9]*) s="$(date +%s)000000000" ;; esac',
  '  printf \'%s-%s\' "$s" "$$"',
  '}',
  'publish() {',
  '  # $1 folder, $2 extension, $3 second line, $4 third line; stdin is the rest.',
  '  # Sets $name, the published file\'s name without its extension.',
  '  tmp="$dir/$1/.$$.tmp"',
  `  { printf '${WSL_HOOK_RECORD_VERSION}\\n%s\\n%s\\n' "$3" "$4"; cat; } > "$tmp" || return 1`,
  '  name=$(stamp)',
  '  mv -f "$tmp" "$dir/$1/$name.$2" || return 1',
  '  printf x > "$dir/signal" 2>/dev/null',
  '  return 0',
  '}',
  'mode=$1',
  '[ $# -gt 0 ] && shift',
  'case "$mode" in',
  '  event)',
  '    type=$1',
  '    [ $# -gt 0 ] && shift',
  '    publish inbox rec "$type" "$*"',
  '    ;;',
  '  reply)',
  '    publish requests req "$1" "$2" || exit 0',
  '    response="$dir/responses/$name.res"',
  '    tries=0',
  '    while [ ! -f "$response" ]; do',
  '      tries=$((tries + 1))',
  `      [ "$tries" -gt ${REPLY_WAIT_TRIES} ] && exit 0`,
  '      sleep 0.01',
  '    done',
  '    cat "$response"',
  '    rm -f "$response"',
  '    ;;',
  '  status)',
  '    target=$1',
  '    cat > "$target.$$.tmp" && mv -f "$target.$$.tmp" "$target"',
  '    ;;',
  'esac',
  'exit 0',
  '',
].join('\n');

/** The transport's paths inside one session directory, as Kangentic reaches them. */
export interface WslHookPaths {
  directory: string;
  script: string;
  inbox: string;
  requests: string;
  responses: string;
  /** The file every published call writes a byte to, which `WslHookInbox` watches. */
  signal: string;
}

export function wslHookPaths(sessionDirectory: string): WslHookPaths {
  const directory = path.join(sessionDirectory, WSL_HOOK_DIRECTORY_NAME);
  return {
    directory,
    script: path.join(directory, 'wsl-hook.sh'),
    inbox: path.join(directory, 'inbox'),
    requests: path.join(directory, 'requests'),
    responses: path.join(directory, 'responses'),
    signal: path.join(directory, 'signal'),
  };
}

/**
 * Create the transport's folders, its signal file and its script in a
 * session directory, before the CLI is built and started. Throws on a failed
 * write: a distro CLI whose hooks have nowhere to publish would run with no
 * activity and no plan approval, so the spawn fails and says why.
 */
export function prepareWslHookTransport(sessionDirectory: string): WslHookPaths {
  const paths = wslHookPaths(sessionDirectory);
  for (const folder of [paths.inbox, paths.requests, paths.responses]) {
    // sync-write-ok: the CLI's hooks publish here from its first call; a throw
    // reaches the spawn's catch (spawnAgent reports it, startup recovery skips
    // the record), the same as the settings file the builder writes beside it.
    fs.mkdirSync(folder, { recursive: true });
  }
  // sync-write-ok: as above. Written before the watcher arms, so it watches
  // the file itself rather than its folder.
  fs.writeFileSync(paths.signal, '');
  // sync-write-ok: as above. A new file per session: `sh` reads a script as it
  // runs it, so one rewritten under a running hook would break that hook.
  fs.writeFileSync(paths.script, WSL_HOOK_SCRIPT);
  return paths;
}

/**
 * Write the script into `<directory>/.kangentic/<copyName>` and return the
 * copy's path, for a CLI whose hook command must be the same for every session
 * (Codex, which trusts a hook by a hash of its command): the command names the
 * copy relative to the hook's working directory, and the copy finds the
 * session's folder through `WSL_HOOK_DIRECTORY_ENV`. Written only when its
 * bytes differ, so a hook another session is running never reads a script
 * rewritten under it. `copyName` must end in `wsl-hook.sh`, which is how
 * `isKangenticHookCommand` recognizes a command naming it. Throws when the
 * write fails.
 */
export function copyWslHookScriptInto(directory: string, copyName: string): string {
  if (!copyName.endsWith('wsl-hook.sh')) {
    throw new Error(`workspace copy ${copyName} must end in wsl-hook.sh, or hook cleanup cannot recognize it`);
  }
  const copyPath = path.join(directory, '.kangentic', copyName);
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(copyPath, 'utf-8');
  } catch {
    // Not written yet.
  }
  if (existing === WSL_HOOK_SCRIPT) return copyPath;
  // sync-write-ok: the CLI's hook commands name this copy; a throw reaches the
  // builder's caller, which spawns without hooks.
  fs.mkdirSync(path.dirname(copyPath), { recursive: true });
  // sync-write-ok: as above.
  fs.writeFileSync(copyPath, WSL_HOOK_SCRIPT);
  return copyPath;
}

/** `sh '<script>'` in the distro's view, quoted for the `sh -c` a Linux CLI runs hooks with. */
function scriptHead(paths: WslHookPaths, place: CliPlace): string {
  return `sh ${quoteBridgePath(cliPathForTarget(paths.script, place), 'sh-or-powershell', 'linux')}`;
}

/**
 * The hook command that reports an event, the distro's counterpart of
 * `buildBridgeCommand`: the same event type and directives, which Kangentic
 * hands the event bridge's logic unchanged. Directives are single shell
 * tokens already (`directive-builders.ts`).
 */
export function wslHookEventCommand(paths: WslHookPaths, place: CliPlace, eventType: string, ...directives: string[]): string {
  return [scriptHead(paths, place), 'event', eventType, ...directives].join(' ');
}

/**
 * The hook command that asks Kangentic for an answer and prints it: plan
 * approval (`buildPlanApprovalCommand`'s counterpart) or the background shell
 * hint. `encodedSpec` is the same base64 spec those commands carry. The
 * session's decision file and events file are Kangentic's to find, so no path
 * travels in the command.
 */
export function wslHookReplyCommand(paths: WslHookPaths, place: CliPlace, kind: WslHookReplyKind, encodedSpec: string): string {
  return [scriptHead(paths, place), 'reply', kind, encodedSpec].join(' ');
}

/** The status line command: the CLI's status JSON replaces `statusOutputPath` by a rename. */
export function wslStatusLineCommand(paths: WslHookPaths, place: CliPlace, statusOutputPath: string): string {
  return `${scriptHead(paths, place)} status ${quoteBridgePath(cliPathForTarget(statusOutputPath, place), 'sh-or-powershell', 'linux')}`;
}

/** One published file, read back: its kind or event type, its argument line, and the hook's stdin. */
export interface WslHookRecord {
  /** The event type (`event`) or the request kind (`reply`). */
  head: string;
  /** The directives, space separated (`event`), or the base64 spec (`reply`). */
  argument: string;
  stdin: string;
}

/** Parse a published file, or null when it is not one this format wrote. */
export function parseWslHookRecord(content: string): WslHookRecord | null {
  const firstBreak = content.indexOf('\n');
  const secondBreak = firstBreak < 0 ? -1 : content.indexOf('\n', firstBreak + 1);
  const thirdBreak = secondBreak < 0 ? -1 : content.indexOf('\n', secondBreak + 1);
  if (thirdBreak < 0 || content.slice(0, firstBreak) !== WSL_HOOK_RECORD_VERSION) return null;
  return {
    head: content.slice(firstBreak + 1, secondBreak),
    argument: content.slice(secondBreak + 1, thirdBreak),
    stdin: content.slice(thirdBreak + 1),
  };
}

/** The epoch ms a published file's name records, or null for a name this format did not write. */
export function wslHookRecordTime(fileName: string): number | null {
  const match = /^(\d{19})-\d+\./.exec(fileName);
  return match ? Number(match[1].slice(0, 13)) : null;
}
