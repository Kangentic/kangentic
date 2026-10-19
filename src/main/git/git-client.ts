import fs from 'node:fs';
import { execFileAsync } from '../utility-process/off-main-exec';

/**
 * `gitAt(directory)`: the git client for the task lifecycle's git calls, with
 * the method names, arguments and results of the simple-git calls it
 * replaced, run through `execFileAsync` so the child starts in the pty host.
 *
 * simple-git spawns every command on the calling thread and has no hook for
 * another spawn: its `spawnOptions` passes only uid and gid through, and a
 * custom binary is still spawned here. On Windows that spawn is CreateProcess,
 * 15 to 30 ms on main each. A 20-task workflow stalled main 19 times over
 * 75 ms (worst 152 ms) on those spawns, which overlap when lifecycles do
 * (`tests/unit/git-lifecycle-off-main.test.ts` counts them).
 *
 * Behavior kept from simple-git, because callers read it:
 * - A non-zero exit fails only when git wrote to stderr. A non-zero exit with
 *   an empty stderr resolves with stdout (an unset `config --get`, a
 *   `rev-parse --verify --quiet` miss, a `merge-base` with no common commit).
 * - A failure's message is stdout followed by stderr, untrimmed: "Worktree
 *   setup failed: <first line>" and the path-length hint read it.
 * - `raw` is untrimmed and `revparse` is trimmed.
 * - The directory is checked when the client is made, and a missing one
 *   throws then, with simple-git's message.
 * - No cap on output (simple-git has none; execFile's default is 1 MiB).
 *
 * With no pty host registered (unit tests, startup) `execFileAsync` runs the
 * child here instead, as simple-git did.
 */

/** Larger than any output these calls produce; simple-git has no cap at all. */
export const GIT_OUTPUT_MAX_BUFFER = 512 * 1024 * 1024;

/** One file in `status()`, as simple-git's `FileStatusResult` names it. */
export interface GitFileStatus {
  path: string;
  index: string;
  working_dir: string;
  /** The source path of a rename. */
  from?: string;
}

/** The parts of simple-git's `StatusResult` the lifecycle reads. */
export interface GitStatusSummary {
  files: GitFileStatus[];
  not_added: string[];
}

export interface GitDiffTextFile {
  file: string;
  changes: number;
  insertions: number;
  deletions: number;
  binary: false;
}

export interface GitDiffBinaryFile {
  file: string;
  before: number;
  after: number;
  binary: true;
}

/** simple-git's `DiffResult` for the default `--stat` format. */
export interface GitDiffSummary {
  changed: number;
  insertions: number;
  deletions: number;
  files: Array<GitDiffTextFile | GitDiffBinaryFile>;
}

export interface GitClient {
  raw(commands: string[]): Promise<string>;
  revparse(options: string[]): Promise<string>;
  status(): Promise<GitStatusSummary>;
  diff(options: string[]): Promise<string>;
  /** `git diff --stat=4096 <options>`, parsed. The default format only. */
  diffSummary(options: string[]): Promise<GitDiffSummary>;
  show(options: string[]): Promise<string>;
  checkout(ref: string): Promise<string>;
  merge(options: string[]): Promise<string>;
}

/** What `execFileAsync` rejects with: promisify's Error, or the host's copy of it. */
type ExecFailure = Error & {
  code?: number | string | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
};

/**
 * Run `git <args>` in `directory` with simple-git's success rule: a non-zero
 * exit is a failure only when stderr is not empty, and its message is stdout
 * then stderr. A child that could not start rejects with its own error.
 */
export async function runGitCommand(directory: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: directory,
      windowsHide: true,
      maxBuffer: GIT_OUTPUT_MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    const failure = error as ExecFailure;
    const stdout = failure.stdout ?? '';
    const stderr = failure.stderr ?? '';
    if (typeof failure.code === 'number') {
      if (stderr.length === 0) return stdout;
      throw new Error(`${stdout}${stderr}`, { cause: error });
    }
    // Killed by a signal: no exit code, which simple-git never counted as a failure.
    if (failure.code == null && typeof failure.signal === 'string') return stdout;
    throw error;
  }
}

function directoryExists(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** simple-git's `logFormatRegex`: a flag that picks a diff output format. */
const DIFF_FORMAT_FLAG = /^--(stat|numstat|name-only|name-status)(=|$)/;

function asNumber(source: string | undefined): number {
  if (source == null) return 0;
  const parsed = Number.parseInt(source, 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const STAT_TEXT_LINE = /^(.+)\s+\|\s+(\d+)(\s+[+-]+)?$/;
const STAT_BINARY_LINE = /^(.+) \|\s+Bin ([0-9.]+) -> ([0-9.]+) ([a-z]+)/;
const STAT_TOTALS_LINE = /(\d+) files? changed\s*((?:, \d+ [^,]+){0,2})/;

/**
 * Parse `git diff --stat` output as simple-git's stat parser does: every
 * non-empty line, untrimmed, against the text, binary and totals patterns in
 * that order, the first that matches wins. Insertions and deletions per file
 * are the `+` and `-` counts of the graph, as there.
 */
export function parseDiffStatSummary(output: string): GitDiffSummary {
  const summary: GitDiffSummary = { changed: 0, insertions: 0, deletions: 0, files: [] };
  // `\r?\n`, as diff-service and git-remotes split: git writes `\n`, but a
  // wrapper on PATH can hand back CRLF, which would fail every pattern.
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const textMatch = STAT_TEXT_LINE.exec(line);
    if (textMatch) {
      const alterations = textMatch[3] ?? '';
      summary.files.push({
        file: textMatch[1].trim(),
        changes: asNumber(textMatch[2]),
        insertions: alterations.replace(/[^+]/g, '').length,
        deletions: alterations.replace(/[^-]/g, '').length,
        binary: false,
      });
      continue;
    }
    const binaryMatch = STAT_BINARY_LINE.exec(line);
    if (binaryMatch) {
      summary.files.push({
        file: binaryMatch[1].trim(),
        before: asNumber(binaryMatch[2]),
        after: asNumber(binaryMatch[3]),
        binary: true,
      });
      continue;
    }
    const totalsMatch = STAT_TOTALS_LINE.exec(line);
    if (totalsMatch) {
      const totals = totalsMatch[2] ?? '';
      summary.changed = asNumber(totalsMatch[1]);
      summary.insertions = asNumber(/(\d+) i/.exec(totals)?.[1]);
      summary.deletions = asNumber(/(\d+) d/.exec(totals)?.[1]);
    }
  }
  return summary;
}

function toFileStatus(filePath: string, index: string, workingDirectory: string): GitFileStatus {
  if (index !== 'R' && workingDirectory !== 'R') return { path: filePath, index, working_dir: workingDirectory };
  // A rename's entry is `<to>\0<from>`.
  const renamed = /^(.+)\0(.+)$/.exec(filePath);
  return {
    path: renamed?.[1] ?? filePath,
    index,
    working_dir: workingDirectory,
    from: renamed?.[2] ?? filePath,
  };
}

/**
 * Parse `git status --porcelain -b -u --null` as simple-git's status parser
 * does, for the two fields read here: every file entry, and the untracked
 * paths. A rename takes the entry after it as its source path.
 */
export function parseStatusSummary(output: string): GitStatusSummary {
  const summary: GitStatusSummary = { files: [], not_added: [] };
  const entries = output.split('\0');
  for (let entryIndex = 0; entryIndex < entries.length;) {
    let line = entries[entryIndex++].trim();
    if (!line) continue;
    if (line.charAt(0) === 'R') line += `\0${entries[entryIndex++] ?? ''}`;
    const trimmed = line.trim();
    let index: string;
    let workingDirectory: string;
    let filePath: string;
    if (trimmed.charAt(2) === ' ') {
      index = trimmed.charAt(0);
      workingDirectory = trimmed.charAt(1);
      filePath = trimmed.slice(3);
    } else if (trimmed.charAt(1) === ' ') {
      index = ' ';
      workingDirectory = trimmed.charAt(0);
      filePath = trimmed.slice(2);
    } else {
      continue;
    }
    const code = `${index}${workingDirectory}`;
    if (code === '??') summary.not_added.push(filePath);
    if (code !== '##' && code !== '!!') summary.files.push(toFileStatus(filePath, index, workingDirectory));
  }
  return summary;
}

class OffMainGitClient implements GitClient {
  constructor(private readonly directory: string) {}

  raw(commands: string[]): Promise<string> {
    return runGitCommand(this.directory, commands);
  }

  async revparse(options: string[]): Promise<string> {
    return (await this.raw(['rev-parse', ...options])).trim();
  }

  async status(): Promise<GitStatusSummary> {
    return parseStatusSummary(await this.raw(['status', '--porcelain', '-b', '-u', '--null']));
  }

  diff(options: string[]): Promise<string> {
    return this.raw(['diff', ...options]);
  }

  async diffSummary(options: string[]): Promise<GitDiffSummary> {
    if (options.some((option) => DIFF_FORMAT_FLAG.test(option))) {
      throw new Error('diffSummary parses the default --stat format only');
    }
    return parseDiffStatSummary(await this.raw(['diff', '--stat=4096', ...options]));
  }

  show(options: string[]): Promise<string> {
    return this.raw(['show', ...options]);
  }

  checkout(ref: string): Promise<string> {
    return this.raw(['checkout', ref]);
  }

  merge(options: string[]): Promise<string> {
    return this.raw(['merge', ...options]);
  }
}

/**
 * A git client for `directory`. Throws at once when the directory does not
 * exist, as `simpleGit(directory)` did, so a caller that built one outside a
 * try still fails where it failed before.
 */
export function gitAt(directory: string): GitClient {
  if (!directoryExists(directory)) {
    throw new Error('Cannot use simple-git on a directory that does not exist');
  }
  return new OffMainGitClient(directory);
}
