/**
 * Warm answering sessions, one per Knowledge Graph chat.
 *
 * The graph prewarms a session when it opens, so the first question skips the
 * CLI's start-up, and a chat keeps its session so a follow-up skips resending
 * the task table. A session is bound to what it was started with (agent, CLI,
 * model, effort, search URL), summed up as its `key`: asking under a different
 * key replaces it. It ends on the chat's end, the graph closing, 10 idle
 * minutes, a failed turn, or the app quitting.
 *
 * Agent-agnostic: the caller supplies `open`, which asks the adapter for a
 * session and returns null for an agent that has none.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AnswerSession } from '../agent/agent-adapter';
import { ANSWER_RUN_DIRECTORY_PREFIX, sweepStaleAnswerRunDirectories } from '../agent/shared/answer-run-directory';
import type { AnswerTaskTable } from './answer-tasks';

/** A session with nothing asked of it this long is ended; the next question
 *  opens a fresh one carrying the chat so far. */
export const ANSWER_SESSION_IDLE_MS = 10 * 60 * 1000;

export interface PooledAnswerSession<Primed> {
  readonly chatId: string;
  readonly key: string;
  readonly session: AnswerSession;
  /** What the session's first answered turn was built from; null until then. */
  primed: Primed | null;
}

interface PoolEntry<Primed> extends PooledAnswerSession<Primed> {
  readonly directory: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface AnswerSessionPoolDeps {
  idleMs?: number;
  /**
   * Live sessions at most; opening one past this ends the least recently used.
   * One by default: the Knowledge Graph is a single surface app-wide (the
   * in-app graph and its detached window never show at once), so only one
   * chat is ever active, and any other session is one nobody can reach.
   */
  maxSessions?: number;
  makeDirectory?: () => string;
  removeDirectory?: (directory: string) => void;
  /** Runs once, on the first session opened this launch. */
  sweepStaleDirectories?: () => Promise<unknown>;
}

function makeRunDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), ANSWER_RUN_DIRECTORY_PREFIX));
}

/** Synchronous, because the quit path disposes the pool. Best-effort: a
 *  leftover temp directory is not worth failing anything over. */
function removeRunDirectory(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows can hold a handle for a beat after the child exits.
  }
}

export function createAnswerSessionPool<Primed>(deps: AnswerSessionPoolDeps = {}) {
  const idleMs = deps.idleMs ?? ANSWER_SESSION_IDLE_MS;
  const makeDirectory = deps.makeDirectory ?? makeRunDirectory;
  const removeDirectory = deps.removeDirectory ?? removeRunDirectory;
  const sweepStaleDirectories = deps.sweepStaleDirectories ?? (() => sweepStaleAnswerRunDirectories());
  const maxSessions = Math.max(1, deps.maxSessions ?? 1);
  // Insertion order is recency: a session that is used again moves to the end.
  const entries = new Map<string, PoolEntry<Primed>>();
  /** Bumped each time a chat ends, so a prewarm that resolves late can tell. */
  const endGenerations = new Map<string, number>();
  let swept = false;

  function drop(chatId: string): void {
    const entry = entries.get(chatId);
    if (!entry) return;
    entries.delete(chatId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.session.dispose();
    // Now, for the files (the MCP config carries a live token), and again once
    // the process is gone: on Windows a live process holds its working
    // directory, so the first pass leaves the empty directory behind.
    removeDirectory(entry.directory);
    void entry.session.exited.then(() => removeDirectory(entry.directory));
  }

  function touch(entry: PoolEntry<Primed>): void {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => {
      if (entries.get(entry.chatId) === entry) drop(entry.chatId);
    }, idleMs);
    entry.idleTimer.unref?.();
  }

  return {
    /**
     * A live, idle session for this chat under this key, opening one when
     * there is none. A session under another key, a dead one, or one still
     * busy with a turn the user has moved past is replaced. Null when `open`
     * returns none (the agent has no session).
     */
    take(
      chatId: string,
      key: string,
      open: (directory: string) => AnswerSession | null,
      options: { endGeneration?: number } = {},
    ): PooledAnswerSession<Primed> | null {
      // A prewarm resolves its agent asynchronously, and the chat can end in
      // that gap (a graph opened and closed at once). Opening now would leave
      // a session for a chat nothing will ask in again.
      if (options.endGeneration !== undefined && options.endGeneration !== (endGenerations.get(chatId) ?? 0)) return null;
      const existing = entries.get(chatId);
      if (existing && existing.key === key && existing.session.alive && !existing.session.busy) {
        entries.delete(chatId);
        entries.set(chatId, existing);
        touch(existing);
        return existing;
      }
      if (existing) drop(chatId);
      while (entries.size >= maxSessions) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
      if (!swept) {
        swept = true;
        void sweepStaleDirectories().catch(() => undefined);
      }
      const directory = makeDirectory();
      let session: AnswerSession | null;
      try {
        session = open(directory);
      } catch (error) {
        removeDirectory(directory);
        throw error;
      }
      if (!session) {
        removeDirectory(directory);
        return null;
      }
      const entry: PoolEntry<Primed> = { chatId, key, session, primed: null, directory, idleTimer: null };
      entries.set(chatId, entry);
      touch(entry);
      return entry;
    },

    /** Restart the idle clock, after a turn that ran long. */
    touch(pooled: PooledAnswerSession<Primed>): void {
      const entry = entries.get(pooled.chatId);
      if (entry === pooled) touch(entry);
    },

    /** Drop a session after a failed turn, so the next question starts clean. */
    discard(pooled: PooledAnswerSession<Primed>): void {
      if (entries.get(pooled.chatId) === pooled) drop(pooled.chatId);
    },

    /** The chat no longer needs its session: ended, or its graph closed. */
    end(chatId: string): void {
      endGenerations.set(chatId, (endGenerations.get(chatId) ?? 0) + 1);
      drop(chatId);
    },

    /** How many times this chat has ended; a prewarm reads it before it awaits. */
    endGeneration(chatId: string): number {
      return endGenerations.get(chatId) ?? 0;
    },

    /** Every session, now. Synchronous for the quit path. */
    disposeAll(): void {
      for (const chatId of [...entries.keys()]) drop(chatId);
    },

    get size(): number {
      return entries.size;
    },
  };
}

/** What a chat's session was first asked with. A follow-up under the same scope
 *  reuses the table, so its refs mean what they meant in the session's context. */
export interface PrimedAnswerChat {
  scopeSignature: string;
  table: AnswerTaskTable;
}

export const answerSessionPool = createAnswerSessionPool<PrimedAnswerChat>();
