/**
 * Gemini CLI's `--output-format stream-json`, read for a Knowledge Graph answer.
 *
 * One JSON object per line. Read from the bundled CLI (0.61.0) and captured:
 *
 *   init         { session_id, model }
 *   message      { role, content, delta? }   assistant text as written, `delta: true`
 *   tool_use     { tool_name, tool_id, parameters }
 *   tool_result  { tool_id, status, output, error? }
 *   result       { status: 'success' | 'error', error?: { type, message }, stats }   the last line
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AnswerStreamEvent } from '../../shared/auto-name';

interface GeminiRecord {
  type?: unknown;
  role?: unknown;
  content?: unknown;
  tool_name?: unknown;
  status?: unknown;
  error?: { message?: unknown } | null;
}

function parse(line: string): GeminiRecord | null {
  if (!line.startsWith('{')) return null;
  try {
    const record = JSON.parse(line) as unknown;
    return record && typeof record === 'object' ? record as GeminiRecord : null;
  } catch {
    return null;
  }
}

/** The events one line carries: assistant text as it is written, and a tool call as it starts. */
export function geminiAnswerEvents(line: string): AnswerStreamEvent[] {
  const record = parse(line);
  if (!record) return [];
  if (record.type === 'message' && record.role === 'assistant' && typeof record.content === 'string' && record.content) {
    return [{ kind: 'text', text: record.content }];
  }
  if (record.type === 'tool_use' && typeof record.tool_name === 'string' && record.tool_name) {
    return [{ kind: 'tool', name: record.tool_name }];
  }
  return [];
}

/**
 * The answer: the assistant's text after its last tool call (the text before
 * one is narration of what it is about to do), or all of it when it called
 * none. Throws the CLI's own error text when the run failed, even after some
 * text: the `result` line is the last one, so a failure there is final, and the
 * text before it is a partial answer that read as a whole one. Claude's reader
 * does the same with `is_error`.
 */
export function extractGeminiAnswer(stdout: string): string {
  let sinceLastTool = '';
  let errorText = '';
  let failed = false;
  for (const line of stdout.split(/\r?\n/)) {
    const record = parse(line);
    if (!record) continue;
    if (record.type === 'message' && record.role === 'assistant' && typeof record.content === 'string') {
      sinceLastTool += record.content;
    } else if (record.type === 'tool_use' || record.type === 'tool_result') {
      sinceLastTool = '';
    } else if (record.type === 'result') {
      failed = record.status === 'error';
      if (typeof record.error?.message === 'string') errorText = record.error.message;
    }
  }
  if (failed) throw new Error(errorText || 'the agent reported an error');
  return sinceLastTool.trim();
}

/** Fold a path for comparison with Gemini's project registry keys. */
function registryKey(value: string): string {
  const forward = value.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

/**
 * Remove the chat a headless run saved, so an answer never appears in the
 * user's Gemini history. Gemini keeps chats for 30 days with no switch to turn
 * them off, under `~/.gemini/tmp/<slug>/chats/` as
 * `session-<time>-<first 8 of the id>.jsonl`, with a folder named by the id
 * for any subagent it ran. The slug is the working directory's entry in
 * `~/.gemini/projects.json`, else its folder name. Best effort.
 */
export async function removeGeminiChat(cwd: string, sessionId: string): Promise<void> {
  const geminiHome = path.join(os.homedir(), '.gemini');
  let slug = path.basename(cwd);
  try {
    const registry = JSON.parse(await fs.promises.readFile(path.join(geminiHome, 'projects.json'), 'utf-8')) as { projects?: Record<string, string> };
    const wanted = registryKey(cwd);
    const entry = Object.entries(registry.projects ?? {}).find(([key]) => registryKey(key) === wanted);
    if (entry) slug = entry[1];
  } catch {
    // No registry yet: the folder name is what Gemini would have used.
  }
  const chats = path.join(geminiHome, 'tmp', slug, 'chats');
  const shortId = sessionId.slice(0, 8);
  let names: string[];
  try {
    names = await fs.promises.readdir(chats);
  } catch {
    return;
  }
  await Promise.all(names
    .filter((name) => name === sessionId || (name.startsWith('session-') && name.includes(shortId)))
    .map((name) => fs.promises.rm(path.join(chats, name), { recursive: true, force: true }).catch(() => undefined)));
}
