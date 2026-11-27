/**
 * The `sh` scripts an update of a host's program runs through `runCommand` (`program-update.ts`). Each takes
 * every value as an argument, never as script text. They read `/proc`, which a supported host (Linux) has.
 * Kept free of imports, so a test can run the real text on a Linux shell.
 */

/**
 * Stop an older daemon by its pid: `$1` the pid, `$2` its version. The pid must still be that daemon (its
 * command line names `.kangentic/host/<version>/app/host.js` and `daemon`), checked again before each
 * signal, since a pid can be reused. The stop runs in the background and the script returns at once: the
 * daemon is this command's parent, and its exit would take the answer with it. TERM after a second, KILL
 * when it has not taken after 10 s more.
 */
export const STOP_DAEMON_SCRIPT = [
  'pid=$1; version=$2',
  `case "$pid" in ''|*[!0-9]*) echo kangentic-stop:bad-pid; exit 3;; esac`,
  'if [ "$pid" -le 1 ]; then echo kangentic-stop:bad-pid; exit 3; fi',
  'same() {',
  `  tr '\\000' '\\n' < "/proc/$pid/cmdline" 2>/dev/null | {`,
  '    program=no; role=no',
  '    while IFS= read -r arg; do',
  '      case "$arg" in */.kangentic/host/"$version"/app/host.js) program=yes;; daemon) role=yes;; esac',
  '    done',
  '    [ "$program" = yes ] && [ "$role" = yes ]',
  '  }',
  '}',
  'same || { echo kangentic-stop:not-the-program; exit 5; }',
  '( sleep 1; same && kill -TERM "$pid" 2>/dev/null; i=0; while same && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i+1)); done; same && kill -KILL "$pid" 2>/dev/null ) </dev/null >/dev/null 2>&1 &',
  'echo kangentic-stop:scheduled',
].join('\n');

/**
 * The pids whose parent is one of the arguments: the agents each terminal's shell started. A process's
 * name in `stat` can hold spaces and parentheses, so the fields are read after its last `) `.
 */
export const LIST_CHILDREN_SCRIPT = [
  'wanted=" $* "',
  'for dir in /proc/[0-9]*; do',
  '  set -f',
  '  stat=$(cat "$dir/stat" 2>/dev/null) || continue',
  '  rest=${stat##*) }',
  '  set -- $rest',
  '  case "$wanted" in *" $2 "*) echo "${dir#/proc/}";; esac',
  'done',
  'exit 0',
].join('\n');

/** Wait up to 10 s for every argument pid to be gone. Prints how many are left. */
export const WAIT_FOR_EXIT_SCRIPT = [
  'i=0; alive=0',
  'while [ "$i" -lt 100 ]; do',
  '  alive=0',
  '  for pid in "$@"; do kill -0 "$pid" 2>/dev/null && alive=$((alive+1)); done',
  '  if [ "$alive" -eq 0 ]; then echo 0; exit 0; fi',
  '  sleep 0.1; i=$((i+1))',
  'done',
  'echo "$alive"',
].join('\n');
