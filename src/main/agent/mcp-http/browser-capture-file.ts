import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pruneShotsDir, type FileScreenshotResponse, type InlineScreenshotResponse } from '../../browser/cdp/screenshot';

/**
 * Where `saveToFile` on `kangentic_browser_screenshot`, `_screenshot_element`
 * and `_eval` writes, and how (task #977).
 *
 * An agent comparing a deployed page with its local build needed large DOM
 * captures and full-page PNGs as files to build an artifact from. The pane
 * tools returned everything inline, which would flood its context, so it drove
 * Playwright MCP instead. These files close that gap.
 *
 * Output goes only to a gitignored `.kangentic/` folder Kangentic owns, never
 * a path the agent names, so a screenshot that saves a file keeps its
 * read-only annotation honestly. And it goes inside the agent's own working
 * directory, because the agent reads the file back with its own Read tool,
 * and a read outside its working directories can stop on a permission prompt
 * nobody is there to answer.
 */

/** A folder name segment that cannot climb out of its parent. */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

/** True when `child` is `parent` or inside it. */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  const climbsOut = relative === '..' || relative.startsWith(`..${path.sep}`);
  return relative === '' || (!climbsOut && !path.isAbsolute(relative));
}

/**
 * The prefixes these files are written under. The session's `captures/` folder
 * also holds the pane's Send capture files, which a save must never prune.
 */
export const BROWSER_CAPTURE_FILE_PREFIXES = ['screenshot', 'element', 'dom', 'eval'] as const;
export type BrowserCaptureFilePrefix = typeof BROWSER_CAPTURE_FILE_PREFIXES[number];

function isBrowserCaptureFile(fileName: string): boolean {
  return BROWSER_CAPTURE_FILE_PREFIXES.some((prefix) => fileName.startsWith(`${prefix}-`));
}

export interface BrowserCaptureCaller {
  /** The project root, from the MCP URL's project. */
  projectPath: string | null;
  /** The caller's session id, from the MCP URL. */
  callerSessionId: string | undefined;
  /** The caller's working directory: the project root, or its task's worktree. */
  sessionCwd: string | null;
  projectId: string;
}

/**
 * The folder a caller's captures go to:
 * - the session's own `captures/` folder (`.kangentic/sessions/<id>/captures`,
 *   where the pane's Send capture writes, removed with the session) when that
 *   is inside its working directory, as for a task on the main checkout;
 * - `<cwd>/.kangentic/captures/<id>` for a worktree task, removed with the
 *   worktree;
 * - `<project>/.kangentic/captures/shared` for a caller with no session (a
 *   Command Terminal, which runs in the project root);
 * - a temp folder only when none of those is known.
 */
export function browserCaptureDirectory(caller: BrowserCaptureCaller): string {
  const { projectPath, callerSessionId, sessionCwd, projectId } = caller;
  const sessionSegment = callerSessionId && SAFE_SEGMENT.test(callerSessionId) ? callerSessionId : null;
  if (sessionSegment && sessionCwd) {
    if (projectPath) {
      const sessionCaptures = path.join(projectPath, '.kangentic', 'sessions', sessionSegment, 'captures');
      if (isInside(sessionCwd, sessionCaptures)) return sessionCaptures;
    }
    return path.join(sessionCwd, '.kangentic', 'captures', sessionSegment);
  }
  if (projectPath) return path.join(projectPath, '.kangentic', 'captures', 'shared');
  const projectSegment = SAFE_SEGMENT.test(projectId) ? projectId : 'project';
  return path.join(os.tmpdir(), 'kangentic-captures', projectSegment);
}

export interface SavedCaptureFile {
  filePath: string;
  fileUri: string;
  bytes: number;
}

/**
 * Write one capture under `directory` as `<prefix>-<time>-<random>.<extension>`.
 * Async, as the pane's Send capture writes, so the file is flushed and closed
 * (and on Windows past the antivirus open-on-create scan) before the agent is
 * handed its path.
 */
export async function writeBrowserCaptureFile(
  directory: string,
  prefix: BrowserCaptureFilePrefix,
  extension: string,
  content: Buffer | string,
): Promise<SavedCaptureFile> {
  await fs.promises.mkdir(directory, { recursive: true });
  // A long run of captures would otherwise grow the folder for as long as its
  // session or worktree lives: keep the newest 100, none older than a day, as
  // the dev screenshot folder does. Captures are scratch the agent reads at
  // once or copies into its own work. Only files written here count, so the
  // pane's Send captures in the same folder are left alone.
  pruneShotsDir(directory, isBrowserCaptureFile);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `${prefix}-${stamp}-${randomBytes(3).toString('hex')}.${extension}`);
  await fs.promises.writeFile(filePath, content);
  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
  return { filePath, fileUri: pathToFileURL(filePath).toString(), bytes };
}

/** Save an inline screenshot to a file and describe it as a file response. */
export async function saveScreenshotToFile(
  directory: string,
  prefix: BrowserCaptureFilePrefix,
  shot: InlineScreenshotResponse,
): Promise<FileScreenshotResponse> {
  const { base64, ...fields } = shot;
  const saved = await writeBrowserCaptureFile(
    directory,
    prefix,
    shot.format === 'jpeg' ? 'jpg' : 'png',
    Buffer.from(base64, 'base64'),
  );
  return { ...fields, mode: 'file', filePath: saved.filePath, fileUri: saved.fileUri, reason: 'requested' };
}

/**
 * An evaluated value as file text: a string as it is (HTML, CSS, a URL list),
 * anything else as indented JSON. `undefined` has no JSON form and saves as
 * empty text.
 */
export function evaluatedValueText(value: unknown): { text: string; extension: 'txt' | 'json' } {
  if (typeof value === 'string') return { text: value, extension: 'txt' };
  return { text: JSON.stringify(value, null, 2) ?? '', extension: 'json' };
}
