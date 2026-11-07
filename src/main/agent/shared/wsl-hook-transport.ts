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
 *   the user, as the bridges do when they cannot decide, and it removes its
 *   request, so Kangentic never answers one nobody waits on (a plan approval
 *   answered then would mark the plan approved while the CLI asks the user).
 * - `status`: the status line's JSON replaces `status.json` by a rename.
 * - `mcp`: a stdio MCP server for Kangentic's tools. Each JSON-RPC line goes
 *   into `requests/` with the session's MCP token, Kangentic relays it to its
 *   loopback MCP server over HTTP (`relayMcpMessage`), and the script prints
 *   the answer. A distro on WSL's default NAT network cannot reach Windows'
 *   loopback, and a listener on the WSL adapter would need a firewall rule:
 *   Windows treats that adapter as a Public network, blocks inbound there by
 *   default, and asks the user (an administrator, on Public) the first time an
 *   app listens on it.
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
export type WslHookReplyKind = 'plan-approval' | 'background-shell-hint' | 'browser-policy';

/** The head of an `mcp` request, whose argument line is `<token> <url>` and whose body is one JSON-RPC message. */
export const WSL_MCP_REQUEST_HEAD = 'mcp';

/**
 * The variable the `mcp` server reads the session's MCP token from. Every
 * adapter that gives its CLI the token by environment uses this name, and the
 * CLI hands it to the stdio server (Claude through the server's `env`, Codex
 * through `env_vars`), so the token never travels in argv.
 */
export const WSL_MCP_TOKEN_ENV = 'KANGENTIC_MCP_TOKEN';

/** How long the script waits for an answer, in 10 ms tries, before it prints nothing. */
const REPLY_WAIT_TRIES = 1000;

/** How long an MCP call waits for Kangentic to take it before the script gives up and says so. */
export const WSL_MCP_TAKE_WAIT_SECONDS = 30;
/** How long it then waits for the answer to a call Kangentic took. The longest tool call is a browser step. */
export const WSL_MCP_ANSWER_WAIT_SECONDS = 600;
/** The longest MCP request line (bytes) the script sends: a frame carries about 200 KB, escaped. */
export const WSL_MCP_REQUEST_MAX_BYTES = 150_000;
/** What the agent reads when nobody took its call. Holds no quote, backslash or newline: the script prints it as JSON. */
export const WSL_MCP_NOT_TAKEN_MESSAGE = `Kangentic did not take this call within ${WSL_MCP_TAKE_WAIT_SECONDS} seconds, so nothing ran. Its desktop app is not connected to this machine right now. Carry on without it, or call the tool again later.`;
/** What the agent reads when Kangentic took its call and then said nothing. */
export const WSL_MCP_NO_ANSWER_MESSAGE = `Kangentic took this call but sent no answer within ${WSL_MCP_ANSWER_WAIT_SECONDS / 60} minutes. It may still be running there, so check what it changed before calling it again.`;

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
  '    # A request can carry the MCP token on its third line, so on a shared host only its owner may read it.',
  '    umask 077',
  '    publish requests req "$1" "$2" || exit 0',
  '    response="$dir/responses/$name.res"',
  '    tries=0',
  '    while [ ! -f "$response" ]; do',
  '      tries=$((tries + 1))',
  `      [ "$tries" -gt ${REPLY_WAIT_TRIES} ] && { rm -f "$dir/requests/$name.req"; exit 0; }`,
  '      sleep 0.01',
  '    done',
  '    cat "$response"',
  '    rm -f "$response"',
  '    ;;',
  '  status)',
  '    target=$1',
  '    cat > "$target.$$.tmp" && mv -f "$target.$$.tmp" "$target"',
  '    ;;',
  `  ${WSL_MCP_REQUEST_HEAD})`,
  '    # A stdio MCP server: a JSON-RPC message per line in, the answer out. A',
  '    # tool call can run for minutes, so the wait slows after 2 s and again',
  '    # after 12 s, and ends once the CLI that started this server is gone.',
  '    # The line goes in by a here-document, not a pipe: a pipe would run',
  '    # publish in a subshell and lose the $name it sets.',
  '    #',
  '    # The wait is bounded, and always ends in an answer the agent can act on.',
  '    # Kangentic takes a request by removing its file; this script gives up on',
  '    # one nobody took by removing it itself. A removal happens once, so a call',
  '    # is either taken (and then answered, never reported as failed) or given',
  '    # up on (and then never run, even if it is delivered later).',
  '    url=$1',
  '    umask 077',
  '    # A length below is in bytes, as a frame\'s limit is. Without this, bash counts characters in a UTF-8 locale.',
  '    LC_ALL=C',
  '    answer_error() {',
  "      # $1 is the JSON-RPC line that was sent and $2 the message, which holds no quote or backslash.",
  '      # An error for that line\'s id, or nothing for a notification, which has none and waits on nothing. The id is the',
  '      # key at the top of the object wherever it sits (an MCP client may write it last), so an id inside a',
  '      # notification\'s parameters is never taken for the call\'s.',
  String.raw`      id=$(printf '%s' "$1" | awk '{ depth = 0; quoted = 0; for (i = 1; i <= length($0); i++) { c = substr($0, i, 1); if (quoted) { if (c == "\\") i++; else if (c == "\"") quoted = 0; continue } if (c == "\"") { if (depth == 1 && substr($0, i, 4) == "\"id\"") { s = substr($0, i + 4); if (sub(/^ *: */, "", s)) { if (s ~ /^"/) { sub(/^"/, "", s); sub(/".*/, "", s); printf "\"%s\"", s } else { sub(/[^0-9].*/, "", s); printf "%s", s } exit } } quoted = 1; continue } if (c == "{" || c == "[") depth++; else if (c == "}" || c == "]") depth-- } }')`,
  String.raw`      [ -n "$id" ] && printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"%s"}}\n' "$id" "$2"`,
  '    }',
  '    while IFS= read -r line || [ -n "$line" ]; do',
  '      [ -n "$line" ] || continue',
  `      if [ "\${#line}" -gt ${WSL_MCP_REQUEST_MAX_BYTES} ]; then`,
  `        answer_error "$line" "This request is $(( \${#line} / 1024 )) KB, more than the ${Math.floor(WSL_MCP_REQUEST_MAX_BYTES / 1024)} KB that can be sent to Kangentic from a host. Send less in one call."`,
  '        continue',
  '      fi',
  `      publish requests req ${WSL_MCP_REQUEST_HEAD} "\${${WSL_MCP_TOKEN_ENV}:-} $url" <<KANGENTIC_MCP_LINE || continue`,
  '$line',
  'KANGENTIC_MCP_LINE',
  '      request="$dir/requests/$name.req"',
  '      response="$dir/responses/$name.res"',
  '      started=$(date +%s 2>/dev/null)',
  '      case "$started" in ""|*[!0-9]*) started=0 ;; esac',
  '      tries=0',
  '      pause=0.01',
  '      taken=0',
  '      while [ ! -f "$response" ]; do',
  '        tries=$((tries + 1))',
  '        [ "$tries" -eq 200 ] && pause=0.05',
  '        [ "$tries" -eq 400 ] && pause=0.25',
  '        [ "$tries" -gt 400 ] && [ -d /proc/self ] && [ ! -d "/proc/$PPID" ] && { rm -f "$request"; exit 0; }',
  '        if [ "$tries" -ge 401 ]; then',
  '          now=$(date +%s 2>/dev/null)',
  '          case "$now" in ""|*[!0-9]*) now=$started ;; esac',
  '          elapsed=$((now - started))',
  '          [ "$taken" = 0 ] && [ ! -f "$request" ] && taken=1',
  `          if [ "$taken" = 0 ] && [ "$elapsed" -ge ${WSL_MCP_TAKE_WAIT_SECONDS} ]; then`,
  '            # Nobody took it. If the removal fails it was taken this instant, and its answer is on its way.',
  `            if rm "$request" 2>/dev/null; then answer_error "$line" "${WSL_MCP_NOT_TAKEN_MESSAGE}"; break; fi`,
  '            taken=1',
  '          fi',
  `          if [ "$taken" = 1 ] && [ "$elapsed" -ge ${WSL_MCP_ANSWER_WAIT_SECONDS} ]; then answer_error "$line" "${WSL_MCP_NO_ANSWER_MESSAGE}"; break; fi`,
  '        fi',
  '        sleep "$pause"',
  '      done',
  '      if [ -f "$response" ]; then',
  '        cat "$response"',
  '        rm -f "$response"',
  '      fi',
  '    done',
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

/**
 * Whether a distro reaches Windows' loopback, so its CLI dials Kangentic's MCP
 * URL itself: WSL's mirrored networking, where `127.0.0.1` in the distro is the
 * host's. On the default NAT network it is the distro's own, and the CLI gets
 * the stdio bridge (`wslMcpServerLaunch`) instead.
 */
export function wslReachesLoopback(place: CliPlace): boolean {
  // A host over SSH never reaches this computer's loopback: its CLI gets the stdio bridge, and the
  // helper carries the bridge's files back (see `remote-session-relay.ts`).
  if (place.kind === 'ssh') return false;
  return place.facts.networkingMode === 'mirrored';
}

/**
 * The stdio MCP server a distro CLI starts for Kangentic's tools: `sh <script>
 * mcp <url>`, the script in the distro's view. The token is not here: the CLI
 * passes it in the server's environment as `WSL_MCP_TOKEN_ENV`.
 */
export function wslMcpServerLaunch(paths: WslHookPaths, place: CliPlace, mcpServerUrl: string): { command: string; args: string[] } {
  return { command: 'sh', args: [cliPathForTarget(paths.script, place), WSL_MCP_REQUEST_HEAD, mcpServerUrl] };
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
