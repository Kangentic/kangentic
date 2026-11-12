import fs from 'node:fs';
import path from 'node:path';
import { isSamePath } from '../../../../shared/paths';
import type { ConversationCarryInput } from '../../../accounts/account-support';
import { claudeProjectSlug } from './transcript-parser';

/**
 * A resumed conversation's plan file, carried into the home the resume runs on (task #1070).
 *
 * Each account keeps its own `plans` folder: Claude refuses a plan file write through a link
 * (measured on 2.1.322, `scripts/probe-claude-plan-tool-approval.js --layouts`). A plan file is
 * named after the conversation's slug, which a resume keeps, and Claude looks for it only in the
 * home it runs on. Resumed on an account without the file, ExitPlanMode opened its bare "Exit plan
 * mode?" with no plan; with the file copied in, it opened the plan as usual (`--carry`).
 */

/**
 * How much of a transcript's end is read for its slug, first and at most. Claude writes the slug
 * on its message lines (user, assistant, attachment, system) and not on the others; measured on
 * 2.1.322, a request-body line between two messages ran to 150KB.
 */
const TRANSCRIPT_TAIL_WINDOWS = [256 * 1024, 4 * 1024 * 1024];

/** A slug as Claude makes one: words joined by dashes. Anything else is not used as a file name. */
const SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** A conversation id as Claude makes one (a UUID). Anything else is not used as a file name. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** The slug a transcript line carries at its top level, or null. */
function slugOfLine(line: string): string | null {
  if (!line.includes('"slug"')) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null || !('slug' in parsed)) return null;
    return typeof parsed.slug === 'string' ? parsed.slug : null;
  } catch {
    return null;
  }
}

/**
 * The conversation's slug, read from the last message line of its transcript, or null when it has
 * none. Each line is parsed, so a `slug` key inside a recorded tool call is not taken for it.
 */
export async function readTranscriptSlug(transcriptPath: string): Promise<string | null> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(transcriptPath, 'r');
    const { size } = await handle.stat();
    for (const window of TRANSCRIPT_TAIL_WINDOWS) {
      const length = Math.min(size, window);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, size - length);
      const lines = buffer.toString('utf8').split('\n');
      // A window that starts mid-file starts mid-line.
      if (length < size) lines.shift();
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const slug = slugOfLine(lines[index]);
        if (slug !== null) return SLUG_PATTERN.test(slug) ? slug : null;
      }
      if (length === size) break;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Where the conversation's transcript is. Every account's `projects` links to the default home's,
 * so it is there: under the folder for `cwd`, or, for a conversation that last ran in another
 * folder, under whichever project folder holds that id.
 */
async function findTranscript(defaultHome: string, cwd: string, agentSessionId: string): Promise<string | null> {
  const fileName = `${agentSessionId}.jsonl`;
  const projectsFolder = path.join(defaultHome, 'projects');
  const expected = path.join(projectsFolder, claudeProjectSlug(cwd), fileName);
  if (await fs.promises.stat(expected).then((stats) => stats.isFile(), () => false)) return expected;
  let projectFolders: string[];
  try {
    projectFolders = await fs.promises.readdir(projectsFolder);
  } catch {
    return null;
  }
  for (const projectFolder of projectFolders) {
    const candidate = path.join(projectsFolder, projectFolder, fileName);
    if (await fs.promises.stat(candidate).then((stats) => stats.isFile(), () => false)) return candidate;
  }
  return null;
}

/** The conversation's plan file and its subagents' (`<slug>-agent-<id>.md`). */
function isPlanFileOf(slug: string, fileName: string): boolean {
  return fileName === `${slug}.md` || (fileName.startsWith(`${slug}-agent-`) && fileName.endsWith('.md'));
}

interface PlanCopy {
  filePath: string;
  stats: fs.Stats;
}

/**
 * Copies the conversation's newest plan files into `toHome/plans`. Into an account folder a copy
 * replaces an older one. Into the default home it only adds a missing file, since Kangentic never
 * rewrites what is there (`account-folder.ts`); a stale copy there is what is left, and the plan's
 * text is still in the transcript. A copy keeps its source's modified time, so "newest" means the
 * same on every platform (POSIX `copyFile` stamps the copy with the time of the copy).
 */
export async function carryClaudePlanFiles(input: ConversationCarryInput): Promise<void> {
  if (!SESSION_ID_PATTERN.test(input.agentSessionId)) return;
  const transcriptPath = await findTranscript(input.defaultHome, input.cwd, input.agentSessionId);
  if (!transcriptPath) return;
  const slug = await readTranscriptSlug(transcriptPath);
  if (!slug) return;

  const newest = new Map<string, PlanCopy>();
  for (const home of input.homes) {
    if (isSamePath(home, input.toHome)) continue;
    const plansFolder = path.join(home, 'plans');
    let names: string[];
    try {
      names = await fs.promises.readdir(plansFolder);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!isPlanFileOf(slug, name)) continue;
      const filePath = path.join(plansFolder, name);
      try {
        const stats = await fs.promises.stat(filePath);
        if (!stats.isFile()) continue;
        const known = newest.get(name);
        if (!known || stats.mtimeMs > known.stats.mtimeMs) newest.set(name, { filePath, stats });
      } catch {
        // Gone between the listing and the read.
      }
    }
  }
  if (newest.size === 0) return;

  const targetFolder = path.join(input.toHome, 'plans');
  const intoDefaultHome = isSamePath(input.toHome, input.defaultHome);
  await fs.promises.mkdir(targetFolder, { recursive: true });
  for (const [name, source] of newest) {
    const target = path.join(targetFolder, name);
    // A link an older version left in place reaches the source itself, whose time is the same.
    const targetStats = await fs.promises.stat(target).catch(() => null);
    if (targetStats && (intoDefaultHome || targetStats.mtimeMs >= source.stats.mtimeMs)) continue;
    try {
      await fs.promises.copyFile(source.filePath, target, intoDefaultHome ? fs.constants.COPYFILE_EXCL : 0);
      await fs.promises.utimes(target, source.stats.atime, source.stats.mtime);
    } catch (error) {
      // A file another resume wrote into the default home a moment ago stays as it is.
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}
