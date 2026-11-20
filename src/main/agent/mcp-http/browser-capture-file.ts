import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { pruneShotsDir, type FileScreenshotResponse, type InlineScreenshotResponse } from '../../browser/cdp/screenshot';
import { agentPathsForProjectPath } from '../../remote/host-paths';
import { HOST_NOT_AVAILABLE, hostAccessFor, readHostBytes, writeHostBytes } from '../../remote/host-transfer';
import type { ValueLocation } from '../../../shared/types';

/** What one dropped file may weigh. The same bound as an attachment fetched from a host. */
const MAX_DROPPED_FILE_BYTES = 50 * 1024 * 1024;
/** As long as a capture is kept, the rule the dev screenshot folder set. */
const MAX_DROP_AGE_MS = 24 * 60 * 60 * 1000;

/** What a Windows file name cannot hold, or holds as more than a name: `\` is a separator and `:` opens a data stream. */
const UNSAFE_NAME_CHARACTERS = /[\\/:*?"<>|\p{Cc}]/gu;
/** Names Windows gives to a device, with or without an extension. */
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

/**
 * Where `saveToFile` on `kangentic_browser_screenshot`, `_screenshot_element`
 * and `_eval` writes, and how (task #977). The copy every screenshot gets
 * goes to a `copies` folder inside it (`copyScreenshotForCaller`, task #1136).
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
 *
 * On a remote project that directory is on the host, and the Browser pane is on
 * this computer. So a capture is written here, into the stand-in, and then copied
 * to the same place on the host (`deliverCapture`), and the agent is given the
 * path it can open. A copy that fails is a failed save: an agent told a path that
 * names nothing on its machine finds out one tool call later, with no reason.
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
  /** The file names the rolling prune took from the folder as this one was written. */
  pruned: string[];
}

/** A capture as the agent is told it. */
export interface DeliveredCapture {
  /** Where the agent opens it. */
  filePath: string;
  fileUri: string;
  bytes: number;
  location: ValueLocation;
  /** This computer's copy of a capture delivered to a host. */
  localFilePath?: string;
}

/** Puts a capture where its agent reads it. */
export type CaptureDelivery = (saved: SavedCaptureFile) => Promise<DeliveredCapture>;

/** What a text capture's result reports. */
export function captureFileFields(delivered: DeliveredCapture): Omit<DeliveredCapture, 'fileUri'> {
  const { filePath, bytes, location, localFilePath } = delivered;
  return { filePath, bytes, location, ...(localFilePath ? { localFilePath } : {}) };
}

/** A capture for an agent on this computer, which needs nothing more. */
export const deliverLocally: CaptureDelivery = async ({ filePath, fileUri, bytes }) => ({ filePath, fileUri, bytes, location: 'local' });

/** A `file:` URI for a path on a host, built by hand: `pathToFileURL` would resolve it onto this computer's drive. */
function hostFileUri(hostPath: string): string {
  return `file://${hostPath.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * The delivery for a project: copied to the host for a remote one, with the rolling prune applied there too, so the
 * host's folder holds what this one does. Rejects when the copy fails.
 */
export function deliverCapture(saved: SavedCaptureFile, projectPath: string | null): Promise<DeliveredCapture> {
  const paths = projectPath ? agentPathsForProjectPath(projectPath) : null;
  if (!paths?.hostId) return deliverLocally(saved);
  const { hostId } = paths;
  return (async () => {
    const access = hostAccessFor(hostId);
    if (!access) throw new Error(HOST_NOT_AVAILABLE);
    const hostPath = paths.toAgent(saved.filePath);
    await writeHostBytes(access, hostPath, await fs.promises.readFile(saved.filePath));
    if (saved.pruned.length > 0) {
      const directory = path.dirname(saved.filePath);
      // Best effort, as the local prune is: a capture left behind costs a little disk, and the next save tries again.
      void access.removeFiles(saved.pruned.map((name) => paths.toAgent(path.join(directory, name)))).catch(() => undefined);
    }
    return { filePath: hostPath, fileUri: hostFileUri(hostPath), bytes: saved.bytes, location: 'host', localFilePath: saved.filePath };
  })();
}

/**
 * A host's file name as one name on this computer. POSIX lets a name hold `\`, `:` and `..`, and the agent picks both
 * the name and the bytes, so on Windows a name left as it is writes wherever it walks to. The same on every platform,
 * so a test on Linux proves what Windows needs.
 */
export function droppedFileName(hostPath: string): string {
  const name = (hostPath.split('/').pop() ?? '').replace(UNSAFE_NAME_CHARACTERS, '_').replace(/[. ]+$/, '');
  if (!name) return 'file';
  return WINDOWS_DEVICE_NAME.test(name) ? `_${name}` : name;
}

/**
 * Remove the folders of drops a day old. A page reads a dropped file when it uses it, which can be at a form's submit
 * much later, so a folder cannot go with its drop. The rolling prune never reaches these: it counts files in one folder.
 */
async function pruneOldDrops(directory: string): Promise<void> {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
  const oldest = Date.now() - MAX_DROP_AGE_MS;
  await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('drop-')).map(async (entry) => {
    const folder = path.join(directory, entry.name);
    const stat = await fs.promises.stat(folder).catch(() => null);
    if (stat && stat.mtimeMs < oldest) await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }));
}

/**
 * Bring the files an agent names to this computer, for a drop into the pane. Null for a project on this computer,
 * whose agent names files here. On a remote project they are the host's, and Chromium reads only this disk.
 */
export async function fetchFilesFromHost(
  hostPaths: readonly string[],
  directory: string,
  projectPath: string | null,
): Promise<{ localPaths: string[]; failures: string[] } | null> {
  const paths = projectPath ? agentPathsForProjectPath(projectPath) : null;
  if (!paths?.hostId) return null;
  const access = hostAccessFor(paths.hostId);
  if (!access) return { localPaths: [], failures: hostPaths.map((hostPath) => `${hostPath}: ${HOST_NOT_AVAILABLE}`) };
  await pruneOldDrops(directory);
  const target = path.join(directory, `drop-${randomBytes(3).toString('hex')}`);
  const localPaths: string[] = [];
  const failures: string[] = [];
  for (const [index, hostPath] of hostPaths.entries()) {
    try {
      const read = await readHostBytes(access, hostPath, MAX_DROPPED_FILE_BYTES);
      if (read.kind !== 'bytes') {
        failures.push(`${hostPath}: ${read.kind === 'missing' ? 'no such file on the host' : `${Math.round(read.size / 1024 / 1024)}MB, past the ${MAX_DROPPED_FILE_BYTES / 1024 / 1024}MB a drop carries`}`);
        continue;
      }
      // Each in its own folder, so two files of one name both keep it, and the page sees the name the agent gave.
      const folder = path.join(target, String(index));
      await fs.promises.mkdir(folder, { recursive: true });
      const localPath = path.join(folder, droppedFileName(hostPath));
      await fs.promises.writeFile(localPath, read.bytes);
      localPaths.push(localPath);
    } catch (error) {
      failures.push(`${hostPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { localPaths, failures };
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
  const before = fs.readdirSync(directory);
  pruneShotsDir(directory, isBrowserCaptureFile);
  const remaining = new Set(fs.readdirSync(directory));
  const pruned = before.filter((name) => !remaining.has(name));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `${prefix}-${stamp}-${randomBytes(3).toString('hex')}.${extension}`);
  await fs.promises.writeFile(filePath, content);
  const bytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
  return { filePath, fileUri: pathToFileURL(filePath).toString(), bytes, pruned };
}

/** Where a screenshot's copy in the caller's folder was written, as the result reports it. */
export interface CaptureCopy {
  filePath: string;
  fileUri: string;
  /** Always this computer's: a remote project gets no copy (`copiesInlineCaptures`). */
  location: 'local';
}

/**
 * What a screenshot tool's description says about the copy (task #1136). One string for the
 * browser tools and the dev-only devtools tools, so the two families cannot drift apart.
 */
export const CAPTURE_COPY_DESCRIPTION =
  ' On a project on this computer the image is also written to a Kangentic captures folder inside your working directory, and `filePath` in the metadata names it. To copy or publish the image, copy `filePath`, never the path your client names for the image, which can need approval to read.';

/** The folder a capture folder keeps its screenshot copies in. */
const CAPTURE_COPIES_FOLDER = 'copies';

/**
 * Where a caller's screenshot copies go: a folder of their own inside its capture folder. Each
 * folder runs its own rolling prune, so a long run of screenshots never prunes a file the agent
 * saved with `saveToFile` beside them.
 */
export function captureCopiesFolder(captureDirectory: string): string {
  return path.join(captureDirectory, CAPTURE_COPIES_FOLDER);
}

/**
 * Whether a project's screenshots get a copy on disk: a project on this computer only. On a
 * remote one the copy would be an SSH write on every screenshot, and its agent's tool-results
 * folder is on the host, out of this computer's reach. `saveToFile` still delivers there. Null
 * (no project path) has no folder inside the agent's working directory to write to.
 */
export function copiesInlineCaptures(projectPath: string | null): boolean {
  return projectPath !== null && !agentPathsForProjectPath(projectPath)?.hostId;
}

/** Null when the write fails. The image still reaches the agent, and the copy only spares a later prompt. */
async function writeCaptureCopy(
  directory: string,
  prefix: BrowserCaptureFilePrefix,
  format: 'png' | 'jpeg',
  bytes: Buffer,
): Promise<CaptureCopy | null> {
  try {
    const saved = await writeBrowserCaptureFile(directory, prefix, format === 'jpeg' ? 'jpg' : 'png', bytes);
    return { filePath: saved.filePath, fileUri: saved.fileUri, location: 'local' };
  } catch {
    // report-ok: the screenshot still returns; a missing copy costs the agent a prompt on a later copy, never the image.
    return null;
  }
}

/** The fields of a screenshot response the copy reads. Both the browser and the devtools responses have them. */
interface CopyableScreenshot {
  mode: 'inline' | 'file';
  format: 'png' | 'jpeg';
  base64?: string;
  filePath?: string;
}

/**
 * Write a screenshot's bytes to the caller's copies folder too (task #1136), and return the copy,
 * or null when there is none.
 *
 * Claude Code saves every MCP image block under its config folder's
 * `projects/<project>/<session>/tool-results/` and names that file to the agent. A copy out of it
 * stops on a permission prompt that auto mode and allow rules do not answer. `~/.claude` is a
 * protected path, and on an account its `projects` is a link that resolves there (measured with
 * `scripts/probe-claude-plan-tool-approval.js --target tool-results`). A copy from this folder,
 * inside the agent's working directory, runs with no prompt.
 *
 * An inline capture is copied from its base64. A capture past the inline ceiling is copied from the
 * file the capture wrote under the inspected checkout's `.kangentic/devtools-shots`
 * (`persistShot`). For a worktree task that folder is outside the agent's working directory, so a
 * copy from it prompts as a tool-results copy does. A source outside a `devtools-shots` folder, or
 * one that cannot be read, gets no copy, and its result keeps the original path.
 */
export async function copyScreenshotForCaller(
  directory: string,
  prefix: BrowserCaptureFilePrefix,
  shot: CopyableScreenshot,
): Promise<CaptureCopy | null> {
  if (shot.mode === 'inline') {
    return shot.base64 ? writeCaptureCopy(directory, prefix, shot.format, Buffer.from(shot.base64, 'base64')) : null;
  }
  if (!shot.filePath || path.basename(path.dirname(shot.filePath)) !== 'devtools-shots') return null;
  const bytes = await fs.promises.readFile(shot.filePath).catch(() => null); // report-ok: an unreadable source keeps its own path in the result.
  return bytes ? writeCaptureCopy(directory, prefix, shot.format, bytes) : null;
}

/** Save an inline screenshot to a file, put it where its agent reads it, and describe it as a file response. */
export async function saveScreenshotToFile(
  directory: string,
  prefix: BrowserCaptureFilePrefix,
  shot: InlineScreenshotResponse,
  deliver: CaptureDelivery = deliverLocally,
): Promise<FileScreenshotResponse> {
  const { base64, ...fields } = shot;
  const saved = await writeBrowserCaptureFile(
    directory,
    prefix,
    shot.format === 'jpeg' ? 'jpg' : 'png',
    Buffer.from(base64, 'base64'),
  );
  const delivered = await deliver(saved);
  return {
    ...fields,
    mode: 'file',
    filePath: delivered.filePath,
    fileUri: delivered.fileUri,
    reason: 'requested',
    location: delivered.location,
    ...(delivered.localFilePath ? { localFilePath: delivered.localFilePath } : {}),
  };
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
