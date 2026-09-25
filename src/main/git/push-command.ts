/**
 * Read the destination branch out of an agent's own `git push` command.
 *
 * This is the per-task PR anchor for a task with no worktree. Every other anchor
 * the PR ladder resolves from (`branch_name`, `head_sha`, a Tier 6 remote-tip
 * inference) is written behind a `worktree_path` read, so a task created with
 * `useWorktree: false` never had one. Reading the shared checkout's live HEAD at
 * resolve time is not an option either: every concurrent no-worktree task shares
 * that HEAD, so they would all resolve to the same branch. The agent's own push
 * command is the one moment that belongs to exactly this task and names exactly
 * this task's branch, and the hook pipeline already forwards it as the `detail`
 * of a Bash `tool_start` event.
 *
 * Pure and dependency-free so it can be exercised exhaustively in a unit test.
 * Only an EXPLICIT destination is trusted: `git push` / `git push -u origin HEAD`
 * push whatever is checked out, which is the shared state this exists to avoid,
 * so both parse as "unknown" rather than as a guess.
 */

/**
 * The cap the hook bridge applies to `tool_input.command` before it becomes
 * `event.detail` (`FIELD_CAP` in `event-bridge.js`). The bridge is unbundled
 * CommonJS, so the value is duplicated here by hand, the same way
 * `src/shared/background-shell-hold.ts` carries its sentinel;
 * `tests/unit/hook-detail-cap-parity.test.ts` keeps the two equal.
 */
export const HOOK_DETAIL_CAP = 2000;

/** Options that consume the following token as their value. */
const VALUE_OPTIONS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

/**
 * Options under which the command names no single destination branch, or pushes
 * nothing at all. A dry run is not a push; a delete removes the branch a PR
 * would be looked up by; the multi-ref forms push every branch.
 */
const NO_SINGLE_BRANCH_OPTIONS = new Set([
  '--dry-run', '-n', '--delete', '-d', '--tags', '--all', '--branches', '--mirror',
]);

/** Global git options (before the subcommand) that take a separate value. */
const GLOBAL_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

/**
 * Whether `name` can be handed to git (and to a PR host) as a branch name
 * without being read as an option or a revision expression. Mirrors the
 * `check-ref-format` rules that matter here plus the leading-dash refusal the
 * PR ladder applies to remote-supplied refs, since a name that starts with a
 * dash is parsed as an option by every git verb that receives it.
 */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 255) return false;
  if (name === '@' || name.startsWith('-')) return false;
  for (const character of name) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (/[\s~^:?*[\\]/.test(name)) return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.endsWith('.lock') || name.endsWith('.')) return false;
  if (name.startsWith('/') || name.endsWith('/')) return false;
  return true;
}

/** One whitespace-delimited word, with its quoting removed and as typed. */
interface CommandToken {
  value: string;
  raw: string;
}

/**
 * Split a shell command into segments at unquoted `&&`, `||`, `|`, `;`, and
 * newlines, tokenizing each segment with single and double quotes honored, so a
 * commit message containing `&&` does not split the command in half.
 */
function splitIntoSegments(command: string): CommandToken[][] {
  const segments: CommandToken[][] = [];
  let tokens: CommandToken[] = [];
  let value = '';
  let raw = '';
  let quote: '"' | '\'' | null = null;

  const endToken = (): void => {
    if (raw.length > 0) tokens.push({ value, raw });
    value = '';
    raw = '';
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      raw += character;
      if (character === quote) {
        quote = null;
      } else if (
        character === '\\'
        && quote === '"'
        && index + 1 < command.length
        && '$`"\\'.includes(command[index + 1])
      ) {
        // Inside double quotes bash escapes only these four; any other
        // backslash is literal, which is what keeps a quoted Windows path whole.
        index += 1;
        raw += command[index];
        value += command[index];
      } else {
        value += character;
      }
      continue;
    }
    if (character === '"' || character === '\'') {
      quote = character;
      raw += character;
      continue;
    }
    if (character === '\\' && index + 1 < command.length) {
      index += 1;
      raw += `\\${command[index]}`;
      value += command[index];
      continue;
    }
    if (character === '\n' || character === ';') {
      endSegment();
      continue;
    }
    if (character === '&' || character === '|') {
      const pair = command.slice(index, index + 2);
      if (pair === '&&' || pair === '||') {
        endSegment();
        index += 1;
        continue;
      }
      if (character === '|') {
        endSegment();
        continue;
      }
      // A lone `&`: PowerShell's call operator when it leads a segment, a
      // background operator when it trails one. Either way it ends the word.
      endToken();
      tokens.push({ value: '&', raw: '&' });
      continue;
    }
    if (/\s/.test(character)) {
      endToken();
      continue;
    }
    raw += character;
    value += character;
  }
  endSegment();
  return segments;
}

/** `git`, `git.exe`, or an absolute path to either. */
function isGitExecutable(token: string): boolean {
  const basename = token.split(/[\\/]/).pop() ?? token;
  return basename === 'git' || basename.toLowerCase() === 'git.exe';
}

function isRedirect(token: string): boolean {
  return /^\d*[<>]/.test(token) || token === '&>';
}

/**
 * The destination branch named by the first `git push` in `command`, or null
 * when the command names none it can be sure of. See the module comment for
 * why "sure" is the bar.
 *
 * `possiblyTruncated` says the input may have been cut at the hook bridge's cap
 * (defaults to `command.length >= HOOK_DETAIL_CAP`). A refspec that runs to the
 * very end of a capped input may be a prefix of the real name, so it is refused
 * rather than recorded wrong.
 */
export function parsePushedBranch(
  command: string,
  options: { possiblyTruncated?: boolean } = {},
): string | null {
  const possiblyTruncated = options.possiblyTruncated ?? command.length >= HOOK_DETAIL_CAP;

  for (const segment of splitIntoSegments(command)) {
    const refspec = findPushRefspec(segment);
    if (refspec === undefined) continue;
    if (refspec === null) return null;
    const branch = destinationBranch(refspec.value);
    if (!branch) return null;
    if (possiblyTruncated && /\S$/.test(command) && command.endsWith(refspec.raw)) return null;
    return branch;
  }
  return null;
}

/**
 * The first refspec token of a segment that is a `git push`, `undefined` when
 * the segment is not one, and `null` when it is one that names no usable
 * destination (no refspec, or an option that rules a single branch out).
 */
function findPushRefspec(segment: CommandToken[]): CommandToken | null | undefined {
  let index = 0;
  if (segment[index]?.value === '&') index += 1;
  if (!segment[index] || !isGitExecutable(segment[index].value)) return undefined;
  index += 1;

  while (index < segment.length && segment[index].value.startsWith('-')) {
    const option = segment[index].value;
    index += GLOBAL_VALUE_OPTIONS.has(option) ? 2 : 1;
  }
  if (segment[index]?.value !== 'push') return undefined;
  index += 1;

  let remote: string | null = null;
  let optionsEnded = false;
  while (index < segment.length) {
    const token = segment[index];
    const word = token.value;
    if (!optionsEnded) {
      if (word === '--') {
        optionsEnded = true;
        index += 1;
        continue;
      }
      if (NO_SINGLE_BRANCH_OPTIONS.has(word)) return null;
      if (VALUE_OPTIONS.has(word)) {
        index += 2;
        continue;
      }
      if (word.startsWith('-')) {
        index += 1;
        continue;
      }
    }
    if (isRedirect(word)) {
      index += /^\d*[<>]+$/.test(word) || word === '&>' ? 2 : 1;
      continue;
    }
    if (word === '&') {
      index += 1;
      continue;
    }
    if (remote === null) {
      remote = word;
      index += 1;
      continue;
    }
    return token;
  }
  return null;
}

/** The branch a single refspec pushes TO, or null when that is not knowable. */
function destinationBranch(refspec: string): string | null {
  const withoutForce = refspec.startsWith('+') ? refspec.slice(1) : refspec;
  if (withoutForce.startsWith(':')) return null;
  const separator = withoutForce.indexOf(':');
  const source = separator === -1 ? withoutForce : withoutForce.slice(0, separator);
  const explicitDestination = separator === -1 ? null : withoutForce.slice(separator + 1);

  let target: string;
  if (explicitDestination !== null) {
    target = explicitDestination;
  } else {
    // A bare source pushes to a branch of the same name, but only when the
    // source IS a branch name. `HEAD`, `@`, `@{-1}`, `main~2`, and a raw sha all
    // resolve to whatever is checked out or to a commit, never to a name.
    if (source === 'HEAD' || source === '@' || source.startsWith('@{')) return null;
    if (/[~^]/.test(source) || /^[0-9a-f]{7,64}$/i.test(source)) return null;
    target = source;
  }

  if (target.startsWith('refs/')) {
    if (!target.startsWith('refs/heads/')) return null;
    target = target.slice('refs/heads/'.length);
  }
  if (target === 'HEAD') return null;
  return isSafeBranchName(target) ? target : null;
}
