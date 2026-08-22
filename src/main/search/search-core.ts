import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import type Database from 'better-sqlite3';
import { getProjectDb } from '../db/database';
import { sessionOutputPaths } from '../transition-engine/session-paths';
import { agentRegistry } from '../agent/agent-registry';
import type {
  SessionEvent,
  SearchHit,
  Project,
} from '../../shared/types';
import { searchConversationMemory, type TranscriptSearchHit } from '../retrieval/memory-search';
import type { Embedder } from '../retrieval/types';
import { parseTicketQuery, matchesTicketPrefix } from '../../shared/ticket-query';

/** Map an engine transcript hit to the `conversation` SearchHit surfaced to the
 *  palette and MCP. Shared by the unified search and the similar-sessions IPC.
 *  `sessionActive` (does the session have a live agent right now) drives the
 *  palette's open-terminal-vs-open-history routing and row badge; callers without
 *  liveness context (similar-sessions) leave it false. */
export function toConversationSearchHit(
  hit: TranscriptSearchHit,
  sessionActive = false,
): Extract<SearchHit, { kind: 'conversation' }> {
  return {
    kind: 'conversation',
    projectId: hit.projectId,
    projectName: hit.projectName,
    taskId: hit.taskId,
    taskTitle: hit.taskTitle,
    sessionId: hit.sessionId,
    agentName: hit.agentName,
    chunkId: hit.chunkId,
    turnUuid: hit.turnUuid,
    turnKind: hit.role,
    turnTs: hit.turnTs,
    score: hit.score,
    matchKind: hit.matchKind,
    snippet: hit.snippet,
    matchStart: hit.matchStart,
    matchEnd: hit.matchEnd,
    sessionActive,
    matchCount: hit.matchCount,
  };
}

// Unified search across tasks, backlog, session events, and projects. Scan
// strategy per source:
//   - tasks/backlog/projects: small tables, scan in JS after a SELECT.
//   - session events: stream the on-disk events.jsonl per session via
//     readline. Async; we run all projects' event scans concurrently via
//     Promise.all so cross-project I/O overlaps.
//
// The RAW `session_transcripts` scrollback blob (written by TranscriptWriter)
// is still NOT searched: for TUI agents like Claude Code it is mostly
// inline-redraw frames (cursor positioning + screen clears), so it produces
// duplicate hits and noisy snippets. Instead, the STRUCTURED transcript
// (TranscriptEntry-derived chunks in the memory index) is searched as
// `kind: 'conversation'` when conversation memory is enabled - see
// `searchConversationMemory`. The `events.jsonl` hook stream remains the
// telemetry "what happened" surface (`kind: 'session_event'`).
// Per-kind hit budgets keep one slow source from starving the others.

export const PER_KIND_CAP = {
  task: 30,
  backlog: 20,
  session_event: 50,
  project: 10,
  conversation: 20,
} as const;

const SNIPPET_RADIUS = 60;

/** Map a sessions.session_type DB value (e.g. "claude_agent") to a human
 *  display name (e.g. "Claude Code"). Falls back to the raw value for
 *  unknown / legacy session types. */
function agentDisplayName(sessionType: string): string {
  return agentRegistry.getBySessionType(sessionType)?.displayName ?? sessionType;
}

interface SessionRow {
  id: string;
  task_id: string;
  session_type: string;
  started_at: string;
}

interface TaskRow {
  id: string;
  display_id: number;
  title: string;
  description: string;
  archived_at: string | null;
}

interface BacklogRow {
  id: string;
  title: string;
  description: string;
}

export function buildSnippet(
  haystack: string,
  matchStart: number,
  matchEnd: number,
): { snippet: string; matchStart: number; matchEnd: number } {
  const start = Math.max(0, matchStart - SNIPPET_RADIUS);
  const end = Math.min(haystack.length, matchEnd + SNIPPET_RADIUS);
  let snippet = haystack.slice(start, end);
  let adjustedStart = matchStart - start;
  let adjustedEnd = matchEnd - start;
  if (start > 0) {
    snippet = `…${snippet}`;
    adjustedStart += 1;
    adjustedEnd += 1;
  }
  if (end < haystack.length) {
    snippet = `${snippet}…`;
  }
  // Collapse runs of whitespace/newlines so multiline event details (file
  // paths broken across lines, multiline tool output) and task descriptions
  // render as a single readable line in the result row.
  snippet = snippet.replace(/\s+/g, ' ');
  return { snippet, matchStart: adjustedStart, matchEnd: adjustedEnd };
}

export function findFirstMatch(
  text: string,
  needleLower: string,
): { start: number; end: number } | null {
  const haystackLower = text.toLowerCase();
  const start = haystackLower.indexOf(needleLower);
  if (start < 0) return null;
  return { start, end: start + needleLower.length };
}

async function searchEventsFile(
  filePath: string,
  needleLower: string,
  emit: (event: SessionEvent, matchStart: number, matchEnd: number, haystack: string) => boolean,
): Promise<void> {
  // Silent no-op for missing files (the common case: a fresh session has no
  // events.jsonl yet, or the directory was cleaned). Doing this before
  // createReadStream avoids a stream 'error' event that would throw inside
  // the for-await loop and spam console.warn for every cleaned-up session.
  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
  } catch {
    return;
  }
  const stream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  // Suppress unexpected stream errors (file disappears mid-read, EBUSY on
  // Windows, etc.) so they don't reject the for-await loop. The pre-check
  // above handles ENOENT; this is a backstop for races.
  stream.on('error', (streamError) => {
    console.warn(`[search:everything] events.jsonl stream error for ${filePath}:`, streamError);
  });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let stopped = false;
  try {
    for await (const line of rl) {
      if (!line) continue;
      let event: SessionEvent;
      try {
        event = JSON.parse(line) as SessionEvent;
      } catch {
        continue;
      }
      const tool = typeof event.tool === 'string' ? event.tool : '';
      const detail = typeof event.detail === 'string' ? event.detail : '';
      const haystack = tool && detail ? `${tool}: ${detail}` : tool || detail;
      if (!haystack) continue;
      const match = findFirstMatch(haystack, needleLower);
      if (!match) continue;
      const keepGoing = emit(event, match.start, match.end, haystack);
      if (!keepGoing) {
        stopped = true;
        break;
      }
    }
  } finally {
    rl.close();
    if (stopped && !stream.destroyed) stream.destroy();
  }
}

interface Budget {
  task: number;
  backlog: number;
  session_event: number;
  project: number;
  conversation: number;
}

function pushTaskHits(
  project: Project,
  needleLower: string,
  budget: Budget,
  hits: SearchHit[],
  getDb: (projectId: string) => Database.Database,
): void {
  if (budget.task <= 0) return;
  const db = getDb(project.id);
  const rows = db
    .prepare('SELECT id, display_id, title, description, archived_at FROM tasks ORDER BY archived_at IS NOT NULL, display_id DESC')
    .all() as TaskRow[];
  // Buffer title and description matches separately so titles win within
  // the per-project run regardless of DB order.
  const titleHits: SearchHit[] = [];
  const descHits: SearchHit[] = [];
  for (const row of rows) {
    if (titleHits.length + descHits.length >= budget.task) break;
    const titleMatch = findFirstMatch(row.title ?? '', needleLower);
    let snippetField: 'title' | 'description' = 'title';
    let match = titleMatch;
    let haystack = row.title ?? '';
    if (!match) {
      const descMatch = findFirstMatch(row.description ?? '', needleLower);
      if (descMatch) {
        match = descMatch;
        snippetField = 'description';
        haystack = row.description ?? '';
      }
    }
    if (!match) continue;
    const snippet = buildSnippet(haystack, match.start, match.end);
    const hit: SearchHit = {
      kind: 'task',
      projectId: project.id,
      projectName: project.name,
      taskId: row.id,
      displayId: row.display_id,
      taskTitle: row.title ?? '',
      archived: row.archived_at != null,
      snippetField,
      snippet: snippet.snippet,
      matchStart: snippet.matchStart,
      matchEnd: snippet.matchEnd,
    };
    (snippetField === 'title' ? titleHits : descHits).push(hit);
  }
  for (const hit of titleHits) {
    if (budget.task <= 0) return;
    hits.push(hit);
    budget.task -= 1;
  }
  for (const hit of descHits) {
    if (budget.task <= 0) return;
    hits.push(hit);
    budget.task -= 1;
  }
}

/**
 * Match tasks by ticket number for a `#<digits>` query. Prefix-matches
 * `display_id` (so `#4` -> 4, 40, 41, ...) and ranks non-archived before
 * archived, the exact hit first, then remaining prefix hits by ascending
 * `display_id`. That ranking holds WITHIN one project: the caller drains the
 * shared `budget.task` cap project by project, so under `scope: 'all'` an
 * earlier project with enough prefix matches can exhaust the budget and drop a
 * later project's hits entirely, exact match included. (The text-search path
 * has the same per-project shape.) Each hit carries a zero-width match (`matchStart === matchEnd`)
 * with the title as its snippet, which the palette renders plainly; the
 * `#{displayId}` badge in the result row header is what signals the match.
 */
function pushTaskHitsByDisplayId(
  project: Project,
  ticketDigits: string,
  budget: Budget,
  hits: SearchHit[],
  getDb: (projectId: string) => Database.Database,
): void {
  if (budget.task <= 0) return;
  const db = getDb(project.id);
  const rows = db
    .prepare('SELECT id, display_id, title, description, archived_at FROM tasks')
    .all() as TaskRow[];
  const exactValue = Number(ticketDigits);
  const matched = rows.filter((row) => matchesTicketPrefix(row.display_id, ticketDigits));
  matched.sort((first, second) => {
    // Non-archived tasks rank ahead of archived ones.
    const firstArchived = first.archived_at != null ? 1 : 0;
    const secondArchived = second.archived_at != null ? 1 : 0;
    if (firstArchived !== secondArchived) return firstArchived - secondArchived;
    // The exact-number match wins within the same archived group.
    const firstExact = first.display_id === exactValue ? 0 : 1;
    const secondExact = second.display_id === exactValue ? 0 : 1;
    if (firstExact !== secondExact) return firstExact - secondExact;
    // Remaining prefix matches ascend by number (#4, #40, #41, ...).
    return first.display_id - second.display_id;
  });
  for (const row of matched) {
    if (budget.task <= 0) return;
    const title = row.title ?? '';
    const snippet = buildSnippet(title, 0, 0);
    hits.push({
      kind: 'task',
      projectId: project.id,
      projectName: project.name,
      taskId: row.id,
      displayId: row.display_id,
      taskTitle: title,
      archived: row.archived_at != null,
      snippetField: 'title',
      snippet: snippet.snippet,
      matchStart: snippet.matchStart,
      matchEnd: snippet.matchEnd,
    });
    budget.task -= 1;
  }
}

function pushBacklogHits(
  project: Project,
  needleLower: string,
  budget: Budget,
  hits: SearchHit[],
  getDb: (projectId: string) => Database.Database,
): void {
  if (budget.backlog <= 0) return;
  const db = getDb(project.id);
  const rows = db
    .prepare('SELECT id, title, description FROM backlog_tasks ORDER BY position ASC')
    .all() as BacklogRow[];
  const titleHits: SearchHit[] = [];
  const descHits: SearchHit[] = [];
  for (const row of rows) {
    if (titleHits.length + descHits.length >= budget.backlog) break;
    const titleMatch = findFirstMatch(row.title ?? '', needleLower);
    let snippetField: 'title' | 'description' = 'title';
    let match = titleMatch;
    let haystack = row.title ?? '';
    if (!match) {
      const descMatch = findFirstMatch(row.description ?? '', needleLower);
      if (descMatch) {
        match = descMatch;
        snippetField = 'description';
        haystack = row.description ?? '';
      }
    }
    if (!match) continue;
    const snippet = buildSnippet(haystack, match.start, match.end);
    const hit: SearchHit = {
      kind: 'backlog',
      projectId: project.id,
      projectName: project.name,
      backlogId: row.id,
      backlogTitle: row.title ?? '',
      snippetField,
      snippet: snippet.snippet,
      matchStart: snippet.matchStart,
      matchEnd: snippet.matchEnd,
    };
    (snippetField === 'title' ? titleHits : descHits).push(hit);
  }
  for (const hit of titleHits) {
    if (budget.backlog <= 0) return;
    hits.push(hit);
    budget.backlog -= 1;
  }
  for (const hit of descHits) {
    if (budget.backlog <= 0) return;
    hits.push(hit);
    budget.backlog -= 1;
  }
}

async function pushSessionEventHits(
  project: Project,
  needleLower: string,
  budget: Budget,
  hits: SearchHit[],
  getDb: (projectId: string) => Database.Database,
): Promise<void> {
  if (budget.session_event <= 0) return;
  const db = getDb(project.id);
  const sessions = db
    .prepare('SELECT id, task_id, session_type, started_at FROM sessions ORDER BY started_at DESC')
    .all() as SessionRow[];
  if (sessions.length === 0) return;
  const taskTitles = new Map<string, string>(
    (db.prepare('SELECT id, title FROM tasks').all() as Array<{ id: string; title: string }>)
      .map((row) => [row.id, row.title]),
  );

  for (const session of sessions) {
    if (budget.session_event <= 0) return;
    const sessionDir = path.join(project.path, '.kangentic', 'sessions', session.id);
    const { eventsOutputPath } = sessionOutputPaths(sessionDir);
    await searchEventsFile(eventsOutputPath, needleLower, (event, matchStart, matchEnd, haystack) => {
      const snippet = buildSnippet(haystack, matchStart, matchEnd);
      hits.push({
        kind: 'session_event',
        projectId: project.id,
        projectName: project.name,
        taskId: session.task_id,
        taskTitle: taskTitles.get(session.task_id) ?? '(unknown task)',
        sessionId: session.id,
        agentName: agentDisplayName(session.session_type),
        eventTs: event.ts,
        eventKey: `${session.id}-${event.ts}`,
        eventType: event.type,
        snippet: snippet.snippet,
        matchStart: snippet.matchStart,
        matchEnd: snippet.matchEnd,
      });
      budget.session_event -= 1;
      return budget.session_event > 0;
    });
  }
}

function pushProjectHits(
  projects: Project[],
  needleLower: string,
  budget: Budget,
  hits: SearchHit[],
): void {
  if (budget.project <= 0) return;
  for (const project of projects) {
    if (budget.project <= 0) return;
    const nameMatch = findFirstMatch(project.name, needleLower);
    const pathMatch = findFirstMatch(project.path, needleLower);
    if (!nameMatch && !pathMatch) continue;
    let haystack = project.path;
    let match = pathMatch;
    if (nameMatch) {
      haystack = project.name;
      match = nameMatch;
    }
    if (!match) continue;
    const snippet = buildSnippet(haystack, match.start, match.end);
    hits.push({
      kind: 'project',
      projectId: project.id,
      projectName: project.name,
      projectPath: project.path,
      snippet: snippet.snippet,
      matchStart: snippet.matchStart,
      matchEnd: snippet.matchEnd,
    });
    budget.project -= 1;
  }
}

export interface SearchEverythingInput {
  /** Already-trimmed search query. Empty string short-circuits to []. */
  query: string;
  /** Projects to scan for tasks/backlog/session events. */
  projects: Project[];
  /**
   * When true, also produce `kind: 'project'` hits matched against
   * `projectsForProjectHits`. When false, project hits are skipped
   * entirely (the user is already in a project context).
   */
  includeProjectHits: boolean;
  /**
   * Project list used only for `kind: 'project'` matching. Defaults to
   * `projects` when omitted. The IPC handler passes the full registered
   * project list here so a global "switch to project" hit can surface
   * even when `projects` is filtered to a single project.
   */
  projectsForProjectHits?: Project[];
  /** Optional DB-factory injection for tests. Defaults to `getProjectDb`. */
  getDb?: (projectId: string) => Database.Database;
  /**
   * Conversation-memory (structured transcript) search. Omitted or
   * `enabled: false` skips it entirely - existing callers and tests are
   * unaffected. The IPC handler and MCP tool set `enabled` from
   * `memory.indexingEnabled`. `embedder` enables the semantic/hybrid path;
   * absent = lexical-only. `embedWaitMs` is the query-embed budget: the palette
   * uses a short one (latency-sensitive), the MCP tool a generous one.
   */
  conversationSearch?: {
    enabled: boolean;
    embedder?: Embedder | null;
    embedWaitMs?: number;
    /** Restrict conversation hits to one task's history (internal id). */
    taskId?: string;
  };
}

/**
 * Pure-logic entry point for the unified search. Used by the IPC handler
 * (`search:everything`) and by the MCP tool (`kangentic_search`).
 * Returns the full `SearchHit[]` with per-kind caps applied; ordering
 * within a kind is project-by-project, and tasks/backlog prioritise title
 * matches over description matches within each project.
 *
 * A `#<digits>` query is a special case: it short-circuits to a ticket
 * lookup that returns only `task` hits matched by `display_id` prefix (ranked
 * non-archived first, the exact number first, then ascending `display_id`)
 * and skips every other source. See `pushTaskHitsByDisplayId`.
 */
export async function runSearchEverything(input: SearchEverythingInput): Promise<SearchHit[]> {
  const query = input.query.trim();
  if (!query) return [];

  const getDb = input.getDb ?? getProjectDb;
  const hits: SearchHit[] = [];
  const budget: Budget = { ...PER_KIND_CAP };

  // A `#<digits>` query is unambiguously a ticket lookup: match tasks by
  // `display_id` (prefix) and skip every other source. Backlog rows have no
  // display_id, and projects / session events / conversations are not tickets,
  // so returning them here would only be noise.
  const ticketDigits = parseTicketQuery(query);
  if (ticketDigits !== null) {
    for (const project of input.projects) {
      pushTaskHitsByDisplayId(project, ticketDigits, budget, hits, getDb);
    }
    return hits;
  }

  const needleLower = query.toLowerCase();

  if (input.includeProjectHits) {
    pushProjectHits(
      input.projectsForProjectHits ?? input.projects,
      needleLower,
      budget,
      hits,
    );
  }

  // Synchronous sources (tasks, backlog) hit SQLite serially because
  // better-sqlite3 is sync; doing them up-front per project also ensures
  // the project's DB is opened (migrations run) before we start the async
  // event-file scans below.
  for (const project of input.projects) {
    pushTaskHits(project, needleLower, budget, hits, getDb);
    pushBacklogHits(project, needleLower, budget, hits, getDb);
  }

  // Async event-file streams in parallel across projects. Each project's
  // own session loop is still sequential (so the per-project scan stops
  // at its first event-budget exhaustion), but cross-project I/O overlaps.
  //
  // Known race: the `Budget` object is shared across projects. Two parallel
  // projects can both observe `budget.session_event > 0`, both push, both
  // decrement, exceeding the cap by up to (numProjects - 1) hits per kind.
  // Acceptable for v1 - the over-shoot is a handful of extra rows, never
  // unbounded. Tighten by serializing or atomicizing push+decrement if it
  // becomes user-visible.
  const eventScans = Promise.all(input.projects.map(async (project) => {
    try {
      await pushSessionEventHits(project, needleLower, budget, hits, getDb);
    } catch (err) {
      console.warn(`[search:everything] event scan failed for project ${project.id}:`, err);
    }
  }));

  // Structured-transcript (conversation memory) search runs concurrently as a
  // single cross-project call. Isolated in try/catch so a missing index or a
  // malformed FTS query never fails the whole search.
  // Per-project set of session ids with a live agent (running/queued), so a
  // conversation hit whose session is still active routes to the live terminal
  // instead of the read-only viewer. Cached per project for the call.
  const liveSessionsByProject = new Map<string, Set<string>>();
  const liveSessionIdsFor = (projectId: string): Set<string> => {
    const cached = liveSessionsByProject.get(projectId);
    if (cached) return cached;
    let live = new Set<string>();
    try {
      const rows = getDb(projectId)
        .prepare("SELECT id FROM sessions WHERE status IN ('running', 'queued')")
        .all() as Array<{ id: string }>;
      live = new Set(rows.map((row) => row.id));
    } catch {
      // Project DB unavailable: treat as no live sessions (routes to history).
    }
    liveSessionsByProject.set(projectId, live);
    return live;
  };

  const conversationScan = (async () => {
    if (!input.conversationSearch?.enabled) return;
    try {
      const conversationHits = await searchConversationMemory({
        query,
        projects: input.projects,
        k: budget.conversation,
        embedWaitMs: input.conversationSearch.embedWaitMs ?? 400,
        getDb,
        embedder: input.conversationSearch.embedder ?? null,
        taskId: input.conversationSearch.taskId,
      });
      for (const hit of conversationHits) {
        const sessionActive = liveSessionIdsFor(hit.projectId).has(hit.sessionId);
        hits.push(toConversationSearchHit(hit, sessionActive));
      }
    } catch (error) {
      console.warn('[search:everything] conversation scan failed:', error);
    }
  })();

  await Promise.all([eventScans, conversationScan]);

  return hits;
}
