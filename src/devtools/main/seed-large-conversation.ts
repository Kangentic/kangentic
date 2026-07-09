/**
 * Dev-only: seed a throwaway task + session backed by a REAL synthetic Claude
 * Code session JSONL transcript file on disk, thousands of turns long, so a
 * developer can open the Conversation viewer against a huge transcript and
 * exercise scrolling/search/performance without hand-running an agent for
 * hours to accumulate that much real history.
 *
 * The generated lines are shaped exactly like `parseClaudeTranscript`
 * (`src/main/agent/adapters/claude/transcript-parser.ts`) expects: plain-text
 * user turns, assistant text turns, assistant tool_use turns paired with a
 * user-role tool_result turn, occasional extended-thinking turns (two lines
 * sharing one `message.id`, usage attributed once), and occasional
 * `compact_boundary` system entries - so the viewer renders a realistic,
 * varied mix rather than a flat wall of identical lines.
 *
 * Re-clicking the harness button APPENDS more turns to the SAME file instead
 * of starting a new one, continuing the sequence numbering from where the
 * previous seed left off - this is deliberate: it gives the incremental-parse
 * code path (built separately) a real growing file to parse against, not just
 * a fresh one each time.
 *
 * Build-excluded from production: imported only behind `__KANGENTIC_DEV__`
 * guards (src/main/index.ts), so esbuild dead-code elimination drops this
 * module from prod bundles. See `.claude/rules/dev-tooling-build-exclusion.md`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipc-channels';
import { getProjectDb } from '../../main/db/database';
import { TaskRepository } from '../../main/db/repositories/task-repository';
import { SwimlaneRepository } from '../../main/db/repositories/swimlane-repository';
import { SessionRepository } from '../../main/db/repositories/session-repository';
import { locateClaudeTranscriptFile } from '../../main/agent/adapters/claude/transcript-parser';
import type { DevSeedLargeConversationResult } from '../../shared/types';
import type { IpcContext } from '../../main/ipc/ipc-context';

// Word banks for varied, meaningless-but-plausible prompt/response text. Cycled
// with the sequence number so nothing repeats exactly, without needing a real
// language model to generate filler.
const PROMPT_TOPICS = [
  'the retry backoff logic', 'the session lifecycle state machine', 'the terminal scrollback buffer',
  'the swimlane drag handler', 'the embedding backlog drain loop', 'the worktree cleanup path',
  'the IPC channel for task moves', 'the transcript parser', 'the activity engine heuristics',
  'the PTY resize debouncing', 'the board config round-trip', 'the settings panel tabs',
];
const PROMPT_ACTIONS = [
  'Can you look into', 'Please investigate', 'I noticed an issue with', 'Take a pass at fixing',
  'Can you refactor', 'Let us add a test for', 'Please review', 'I want to understand',
];
const RESPONSE_OPENERS = [
  'I looked into this and found', 'Here is what I found:', 'After tracing through the code,',
  'This turned out to be caused by', 'I made a small change to fix this:', 'The root cause was',
  'I have updated the implementation so that', 'Digging into the logs,',
];
const RESPONSE_DETAILS = [
  'a stale closure over the session id', 'a race between the resize handler and the reconnect path',
  'an off-by-one in the pagination cursor', 'a missing null guard on the swimlane lookup',
  'the debounce window firing before the last write flushed', 'a mismatched event name between the hook and the bridge',
  'the cache not invalidating after the project switch', 'an unhandled rejection swallowed by the retry wrapper',
];

const BASH_COMMANDS = ['npm run typecheck', 'git status', 'npx vitest run tests/unit/session-lifecycle.test.ts', 'git diff --stat'];
const EDIT_FILES = ['src/main/pty/session-manager.ts', 'src/renderer/stores/session-store.ts', 'src/main/transition-engine/engine.ts'];

function pick<T>(pool: T[], seed: number): T {
  return pool[seed % pool.length];
}

/** Deterministic, stable uuid-shaped id (the parser only requires a string). */
function seedUuid(runIndex: number, seq: number, suffix: string): string {
  return `dev-seed-${runIndex}-${seq}-${suffix}`;
}

/** ISO timestamp `secondsFromStart` seconds after `startMs`, backdated so the
 *  whole run reads as having happened over a realistic span rather than all
 *  landing in the same millisecond. */
function tsAt(startMs: number, secondsFromStart: number): string {
  return new Date(startMs + secondsFromStart * 1000).toISOString();
}

/**
 * Generate `turnCount` JSONL line strings shaped like a real Claude Code
 * session transcript, continuing sequence numbering from `startSeq` (so a
 * re-click's appended lines read as a continuation, not a restart).
 *
 * Cycles through a repeating pattern: a user prompt, an assistant text reply,
 * every third turn an assistant tool_use + a paired user tool_result, every
 * ~40th turn an extended-thinking pair (two lines sharing one message id, one
 * shared `usage`), and every ~200th turn a `system` compaction boundary.
 */
export function generateSyntheticClaudeJsonlLines(turnCount: number, runIndex: number, startSeq: number): string[] {
  const lines: string[] = [];
  // Backdate the whole run: turns land a few seconds apart, oldest first, so
  // the run reads as having happened over minutes/hours rather than instantly.
  const startMs = Date.now() - turnCount * 5000;

  for (let turnOffset = 0; turnOffset < turnCount; turnOffset += 1) {
    const seq = startSeq + turnOffset;
    const secondsFromStart = turnOffset * 5;

    if (seq > 0 && seq % 200 === 0) {
      lines.push(JSON.stringify({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: seedUuid(runIndex, seq, 'compact'),
        timestamp: tsAt(startMs, secondsFromStart),
        content: 'Conversation compacted',
        compactMetadata: { trigger: 'auto', preTokens: 150000 + seq },
      }));
      continue;
    }

    // User prompt.
    const promptText = `${pick(PROMPT_ACTIONS, seq)} ${pick(PROMPT_TOPICS, seq + 1)} (turn ${seq}).`;
    lines.push(JSON.stringify({
      type: 'user',
      uuid: seedUuid(runIndex, seq, 'user'),
      timestamp: tsAt(startMs, secondsFromStart),
      message: { role: 'user', content: promptText },
    }));

    if (seq > 0 && seq % 40 === 0) {
      // Extended-thinking turn: a thinking-only line and the text line share one
      // message.id; usage is attributed once, on the text line (the parser
      // drops empty thinking blocks, so the thinking line itself yields no
      // entry, but this still exercises the "one message id, two lines" path).
      const messageId = `msg-${seedUuid(runIndex, seq, 'thinking')}`;
      lines.push(JSON.stringify({
        type: 'assistant',
        uuid: seedUuid(runIndex, seq, 'thinking-block'),
        timestamp: tsAt(startMs, secondsFromStart + 1),
        message: {
          id: messageId,
          model: 'claude-opus-4-8',
          role: 'assistant',
          content: [{ type: 'thinking', thinking: `Weighing a few approaches to ${pick(PROMPT_TOPICS, seq)}.` }],
        },
      }));
      const responseText = `${pick(RESPONSE_OPENERS, seq)} ${pick(RESPONSE_DETAILS, seq + 2)}.`;
      lines.push(JSON.stringify({
        type: 'assistant',
        uuid: seedUuid(runIndex, seq, 'thinking-text'),
        timestamp: tsAt(startMs, secondsFromStart + 2),
        message: {
          id: messageId,
          model: 'claude-opus-4-8',
          role: 'assistant',
          content: [{ type: 'text', text: responseText }],
          usage: { input_tokens: 1800 + seq, output_tokens: 260 + seq, cache_creation_input_tokens: 0, cache_read_input_tokens: 4200 },
        },
      }));
      continue;
    }

    if (seq % 3 === 0) {
      // Assistant tool_use turn, paired with a user-role tool_result turn.
      const toolUseId = `toolu-${seedUuid(runIndex, seq, 'tool')}`;
      const useBashTool = seq % 2 === 0;
      const toolBlock = useBashTool
        ? { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: pick(BASH_COMMANDS, seq) } }
        : { type: 'tool_use', id: toolUseId, name: 'Edit', input: { file_path: pick(EDIT_FILES, seq), old_string: 'const previous = false;', new_string: 'const previous = true;' } };
      lines.push(JSON.stringify({
        type: 'assistant',
        uuid: seedUuid(runIndex, seq, 'assistant-tool'),
        timestamp: tsAt(startMs, secondsFromStart + 1),
        message: {
          id: `msg-${seedUuid(runIndex, seq, 'tool')}`,
          model: 'claude-opus-4-8',
          role: 'assistant',
          content: [toolBlock],
          usage: { input_tokens: 1200 + seq, output_tokens: 90 + seq, cache_creation_input_tokens: 0, cache_read_input_tokens: 3100 },
        },
      }));
      const resultText = useBashTool
        ? 'Command exited with code 0.'
        : `Applied 1 edit to ${pick(EDIT_FILES, seq)}.`;
      lines.push(JSON.stringify({
        type: 'user',
        uuid: seedUuid(runIndex, seq, 'tool-result'),
        timestamp: tsAt(startMs, secondsFromStart + 2),
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUseId, content: resultText, is_error: false }],
        },
      }));
      continue;
    }

    // Plain assistant text reply.
    const responseText = `${pick(RESPONSE_OPENERS, seq + 1)} ${pick(RESPONSE_DETAILS, seq)}.`;
    lines.push(JSON.stringify({
      type: 'assistant',
      uuid: seedUuid(runIndex, seq, 'assistant-text'),
      timestamp: tsAt(startMs, secondsFromStart + 1),
      message: {
        id: `msg-${seedUuid(runIndex, seq, 'text')}`,
        model: 'claude-opus-4-8',
        role: 'assistant',
        content: [{ type: 'text', text: responseText }],
        usage: { input_tokens: 900 + seq, output_tokens: 140 + seq, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 },
      },
    }));
  }

  return lines;
}

/** The task/session this process is currently seeding into, and how many
 *  turns have been written so far - replaced whenever the caller's current
 *  project changes, so a re-click after switching projects starts fresh
 *  rather than appending into the wrong project's stale file path. */
interface CurrentSeed {
  projectId: string;
  taskId: string;
  sessionId: string;
  agentSessionId: string;
  filePath: string;
  totalTurns: number;
}

let currentSeed: CurrentSeed | null = null;
// Module state; resets when the main process restarts. Distinguishes a fresh
// seed from a continuation so appended lines get non-colliding uuids/ids
// (paired with `totalTurns` as the starting sequence number).
let seedRunIndex = 0;

/**
 * Seed (or append to) a throwaway "[DEV SEED] Large conversation stress test"
 * task/session in the current project, writing `turnCount` more synthetic
 * transcript turns to its Claude JSONL file. Throws when no project is open.
 */
export async function seedLargeConversation(context: IpcContext, turnCount: number): Promise<DevSeedLargeConversationResult> {
  const projectId = context.currentProjectId;
  const projectPath = context.currentProjectPath;
  if (!projectId || !projectPath) {
    throw new Error('Open a project first to seed a large conversation');
  }

  const db = getProjectDb(projectId);

  if (!currentSeed || currentSeed.projectId !== projectId) {
    seedRunIndex += 1;
    const todoSwimlane = new SwimlaneRepository(db).list().find((lane) => lane.role === 'todo');
    if (!todoSwimlane) {
      throw new Error('No To Do column to seed a large conversation task into');
    }

    const task = new TaskRepository(db).create({
      title: '[DEV SEED] Large conversation stress test',
      description: 'Throwaway task backing a synthetic multi-thousand-turn Claude transcript, for '
        + 'exercising the Conversation viewer\'s scrolling/search/performance on a huge file. '
        + 'Created by the Test Harness "Seed Large Conversation" button.',
      swimlane_id: todoSwimlane.id,
    });

    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    const agentSessionId = crypto.randomUUID();
    new SessionRepository(db).insert({
      id: sessionId,
      task_id: task.id,
      session_type: 'claude_agent',
      isolated_swimlane_id: null,
      agent_session_id: agentSessionId,
      command: '',
      cwd: projectPath,
      permission_mode: null,
      prompt: null,
      status: 'exited',
      exit_code: 0,
      started_at: now,
      suspended_at: now,
      exited_at: now,
      suspended_by: null,
    });

    const filePath = locateClaudeTranscriptFile(agentSessionId, projectPath);
    currentSeed = { projectId, taskId: task.id, sessionId, agentSessionId, filePath, totalTurns: 0 };
  }

  const seed = currentSeed;
  const lines = generateSyntheticClaudeJsonlLines(turnCount, seedRunIndex, seed.totalTurns);
  const jsonlPayload = `${lines.join('\n')}\n`;

  await fs.promises.mkdir(path.dirname(seed.filePath), { recursive: true });
  let existingContent = '';
  try {
    existingContent = await fs.promises.readFile(seed.filePath, 'utf-8');
  } catch {
    // First write for this file.
  }
  const needsLeadingNewline = existingContent.length > 0 && !existingContent.endsWith('\n');
  await fs.promises.appendFile(seed.filePath, `${needsLeadingNewline ? '\n' : ''}${jsonlPayload}`, 'utf-8');

  seed.totalTurns += turnCount;

  return {
    sessionId: seed.sessionId,
    taskId: seed.taskId,
    turnsAdded: turnCount,
    totalTurns: seed.totalTurns,
    filePath: seed.filePath,
  };
}

let devIpcRegistered = false;

/**
 * Register the dev-only IPC behind the TestHarness "Seed Large Conversation"
 * button. Idempotent.
 */
export function registerSeedLargeConversationDevIpc(getContext: () => IpcContext | null): void {
  if (devIpcRegistered) return;
  devIpcRegistered = true;
  ipcMain.handle(IPC.DEV_SEED_LARGE_CONVERSATION, (_event, turnCount: number): Promise<DevSeedLargeConversationResult> => {
    const context = getContext();
    if (!context) throw new Error('IPC not initialized');
    return seedLargeConversation(context, turnCount);
  });
}
