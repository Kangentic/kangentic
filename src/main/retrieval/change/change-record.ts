import crypto from 'node:crypto';
import { estimateTokens } from '../token-estimate';
import type { ChunkInput } from '../types';

/**
 * The files a session changed, as the memory index holds them: the `change`
 * corpus, one document per conversation.
 *
 * Read from the conversation's own indexed text rather than its transcript.
 * The chunker writes every tool call as `Tool: <name> <json input>`, cut at 200
 * characters, and that text outlives the transcript, which most indexed
 * conversations have lost. Which tools change files, and which input field
 * names the file, is the adapter's knowledge (`fileChangeTools`).
 *
 * Each path is followed by the words it is made of, so a question that says
 * "terminal pane" finds `src/renderer/components/terminal/TerminalPane.tsx` by
 * keyword as well as by meaning.
 */

/** Bump when the text or chunking changes, so every session re-derives. */
export const CHANGE_RECORD_VERSION = 1;

/** Characters of file lines per chunk, near the other corpora's chunk size. */
const CHANGE_CHUNK_CHARS = 1_600;
const CHANGE_HEADER = 'Files changed:';
/** Folders whose files are not the repository's work: Kangentic's own runtime
 *  scratch (commit messages, PR bodies), git's internals, installed packages. */
const IGNORED_ROOTS = ['.kangentic/', '.git/', 'node_modules/'];

export interface FileChangeTool {
  tool: string;
  pathField: string;
}

function sha1(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every file a set of chunk texts records a change to, with how many changes.
 * A path the 200-character cut left without its closing quote is skipped
 * rather than guessed at.
 */
export function changedFilesFromChunkTexts(
  texts: ReadonlyArray<string>,
  tools: ReadonlyArray<FileChangeTool>,
): Map<string, number> {
  const files = new Map<string, number>();
  if (tools.length === 0) return files;
  const fieldByTool = new Map(tools.map((entry) => [entry.tool, entry.pathField]));
  const toolLine = /^Tool: (\S+) (.*)$/gm;
  for (const text of texts) {
    for (const match of text.matchAll(toolLine)) {
      const field = fieldByTool.get(match[1]);
      if (!field) continue;
      const found = match[2].match(new RegExp(`"${escapeRegExp(field)}":"((?:[^"\\\\]|\\\\.)*)"`));
      if (!found) continue;
      let filePath: string;
      try {
        filePath = JSON.parse(`"${found[1]}"`) as string;
      } catch {
        continue;
      }
      if (filePath) files.set(filePath, (files.get(filePath) ?? 0) + 1);
    }
  }
  return files;
}

/**
 * A changed file's path relative to its repository, or null for a file outside
 * it (a scratch file, a plan under the home directory).
 *
 * A task worktree lives at `<repo>/.kangentic/worktrees/<slug>/`, so the path
 * after that marker is the repository path whichever worktree it was. Otherwise
 * the project root is stripped. Case folds only on Windows, where the file
 * system is case-insensitive.
 */
export function repoRelativePath(rawPath: string, projectPath: string | null): string | null {
  const relative = stripToRepository(rawPath.replace(/\\/g, '/'), projectPath);
  if (!relative || IGNORED_ROOTS.some((root) => relative.startsWith(root))) return null;
  return relative;
}

function stripToRepository(forward: string, projectPath: string | null): string | null {
  const worktree = forward.match(/\/\.kangentic\/worktrees\/[^/]+\/(.+)$/);
  if (worktree) return worktree[1];
  if (projectPath) {
    const root = `${projectPath.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
    const fold = (value: string): string => (process.platform === 'win32' ? value.toLowerCase() : value);
    if (fold(forward).startsWith(fold(root))) return forward.slice(root.length) || null;
  }
  // Already relative: nothing to strip. One that climbs out of the repository
  // names no file in it.
  if (!/^([A-Za-z]:\/|\/)/.test(forward) && !/^\.\.(\/|$)/.test(forward)) return forward;
  return null;
}

/** The words a path is made of, lower-cased: folders, file name, and the parts
 *  of a camelCase or kebab-case name. The extension and `src` say nothing. */
export function pathWords(filePath: string): string[] {
  const withoutExtension = filePath.replace(/\.[A-Za-z0-9]+$/, '');
  const words = withoutExtension
    .split(/[/._\-\s]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 1 && word !== 'src');
  return [...new Set(words)];
}

/** A session's changed files as chunks, most-changed first. None when it changed nothing. */
export function changeRecordChunks(files: ReadonlyArray<{ path: string; changes: number }>, at: number | null): ChunkInput[] {
  const lines = [...files]
    .sort((left, right) => right.changes - left.changes || left.path.localeCompare(right.path))
    .map((file) => {
      const words = pathWords(file.path);
      return words.length > 0 ? `${file.path} (${words.join(' ')})` : file.path;
    });
  const texts: string[] = [];
  let buffer = CHANGE_HEADER;
  for (const line of lines) {
    if (buffer !== CHANGE_HEADER && buffer.length + 1 + line.length > CHANGE_CHUNK_CHARS) {
      texts.push(buffer);
      buffer = CHANGE_HEADER;
    }
    buffer = `${buffer}\n${line}`;
  }
  if (buffer !== CHANGE_HEADER) texts.push(buffer);
  return texts.map((text, seq) => ({
    seq,
    text,
    contentHash: sha1(text),
    tokenEstimate: estimateTokens(text),
    role: 'record',
    tsStart: at,
    tsEnd: at,
    turnUuidStart: null,
    turnUuidEnd: null,
  }));
}
