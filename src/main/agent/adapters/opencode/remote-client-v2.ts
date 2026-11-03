import type {
  AgentExecutionServer,
  AgentExecutionServerAuth,
  RemoteServerStatus,
  TranscriptBlock,
  TranscriptEntry,
} from '../../../../shared/types';
import { parseWindowBytes } from '../../shared/transcript-truncation';

/**
 * Client for an OpenCode 2 server's API, the remote-mode counterpart of
 * `remote-client.ts` (OpenCode 1). OpenCode 2 replaced the V1 server API and
 * removed `opencode attach`, so a V2 remote session is a TUI started with
 * `opencode --server <url>`, and Kangentic reads its transcript from here.
 *
 * Shapes are from `@opencode/client` 2.2.5 (`dist/promise/generated/types.d.ts`)
 * and were checked against a live `opencode serve` 2.2.5 on 2026-11-03. The
 * fixtures in `tests/fixtures/opencode-v2/` are that server's own responses.
 * What the probe found:
 *
 * - Auth is HTTP Basic and the username is always `opencode`. Any other
 *   username gets a 401, and a V2 server always has a password (`opencode
 *   serve` generates one when none is set). The TUI reads it from
 *   `OPENCODE_PASSWORD` for `--server`, and exits with "requires a password;
 *   set OPENCODE_PASSWORD" without it.
 * - `GET /api/info` answers a bare `ServerInfo` (no `data` envelope, no
 *   `healthy` field). The V1 health path `/global/health` answers 200 with the
 *   web app's HTML on a V2 server, so the V1 probe cannot tell the two apart.
 * - `GET /api/session/{id}/message` answers `{ data, cursor }`. With
 *   `order=desc` the first page is the newest, and `cursor.next` walks to older
 *   pages; a cursor is not combined with `order`. `cursor.next` is set even on
 *   the last page with data, and the page after it is empty with null cursors.
 * - `POST /api/session` takes an optional `id` and a `location.directory`, and
 *   answers `{ data: SessionInfo }`. The server does not check that the
 *   directory exists.
 * - The TUI started with `--server` creates its session in the CLIENT's local
 *   working directory (`location.directory` is the local cwd), and its
 *   positional `[directory]` is a local `chdir`. It prints the session id only
 *   when it exits (`Continue  opencode -s ses_...`). A session created first
 *   through `POST /api/session` and then opened with `--session <id>
 *   --prompt <text>` keeps its own directory and receives the prompt.
 */

/** The parts of the global `fetch` this module uses, injectable for tests. */
export interface OpenCodeV2Fetch {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/** OpenCode 2's fixed Basic auth username (`migrate-v1.mdx`, "Server authentication"). */
export const OPENCODE_V2_USERNAME = 'opencode';

const REQUEST_TIMEOUT_MS = 10_000;
const MESSAGE_PAGE_LIMIT = 100;
const MAX_MESSAGE_PAGES = 20;

interface OpenCodeV2ToolContent {
  type: string;
  text?: string;
  uri?: string;
  name?: string | null;
}

interface OpenCodeV2ToolState {
  status: string;
  input?: unknown;
  content?: OpenCodeV2ToolContent[];
  error?: { message?: string };
}

interface OpenCodeV2AssistantContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  state?: OpenCodeV2ToolState;
}

/** One entry of `SessionMessageInfo`. Only the fields the transcript reads are typed. */
export interface OpenCodeV2Message {
  id: string;
  type: string;
  time?: { created?: number };
  text?: string;
  model?: { id?: string };
  content?: OpenCodeV2AssistantContent[];
  [key: string]: unknown;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Basic auth as `opencode:<password>`. The configured username is ignored,
 * because a V2 server rejects every other one. No password sends no header,
 * which the server answers with a 401.
 */
export function openCodeV2AuthHeaders(auth: AgentExecutionServerAuth): Record<string, string> {
  if (auth.kind !== 'basic' || !auth.password) return {};
  const token = Buffer.from(`${OPENCODE_V2_USERNAME}:${auth.password}`, 'utf8').toString('base64');
  return { Authorization: `Basic ${token}` };
}

function majorVersion(version: string): number | null {
  const match = /^v?(\d+)\./i.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/**
 * Reachability and credential check for an OpenCode 2 server: `GET /api/info`.
 * Never throws: every failure resolves to `{ reachable: false, reason }`.
 */
export async function probeOpenCodeV2Server(
  server: AgentExecutionServer,
  fetchImpl: OpenCodeV2Fetch = fetch,
): Promise<RemoteServerStatus> {
  if (!server.url) return { reachable: false, reason: 'No server URL configured' };
  try {
    const response = await fetchImpl(`${trimTrailingSlash(server.url)}/api/info`, {
      method: 'GET',
      headers: openCodeV2AuthHeaders(server.auth),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      const hasPassword = server.auth.kind === 'basic' && Boolean(server.auth.password);
      return {
        reachable: false,
        reason: hasPassword ? 'Authentication failed - check the password' : 'The server requires a password',
      };
    }
    if (response.status === 404) {
      return { reachable: false, reason: 'The server does not serve the OpenCode 2 API. It may run OpenCode 1' };
    }
    if (!response.ok) return { reachable: false, reason: `Server responded with HTTP ${response.status}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { reachable: false, reason: 'The server did not answer as an OpenCode 2 server' };
    }
    const version = body && typeof body === 'object' ? (body as { version?: unknown }).version : undefined;
    if (typeof version !== 'string') {
      return { reachable: false, reason: 'The server did not answer as an OpenCode 2 server' };
    }
    if (majorVersion(version) === 1) {
      return { reachable: false, reason: `The server runs OpenCode ${version}, and the local OpenCode is version 2` };
    }
    return { reachable: true, version };
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Create an empty session on the server, in `directory` when one is given, and
 * return its id. The TUI then opens it with `--session <id>`, which is how a
 * remote session gets a directory on the server rather than this machine's cwd,
 * and how Kangentic knows its id before launch. Null on any failure.
 */
export async function createOpenCodeV2Session(
  server: AgentExecutionServer,
  options: { directory?: string | null },
  fetchImpl: OpenCodeV2Fetch = fetch,
): Promise<string | null> {
  if (!server.url) return null;
  const body = options.directory ? { location: { directory: options.directory } } : {};
  try {
    const response = await fetchImpl(`${trimTrailingSlash(server.url)}/api/session`, {
      method: 'POST',
      headers: { ...openCodeV2AuthHeaders(server.auth), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const parsed = (await response.json()) as { data?: { id?: unknown } } | null;
    const id = parsed?.data?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

interface MessagesPage {
  data: OpenCodeV2Message[];
  next: string | null;
}

async function fetchMessagesPage(
  server: AgentExecutionServer & { url: string },
  sessionId: string,
  cursor: string | null,
  fetchImpl: OpenCodeV2Fetch,
): Promise<MessagesPage | null> {
  const query = cursor
    ? `limit=${MESSAGE_PAGE_LIMIT}&cursor=${encodeURIComponent(cursor)}`
    : `order=desc&limit=${MESSAGE_PAGE_LIMIT}`;
  const response = await fetchImpl(
    `${trimTrailingSlash(server.url)}/api/session/${encodeURIComponent(sessionId)}/message?${query}`,
    { method: 'GET', headers: openCodeV2AuthHeaders(server.auth), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { data?: unknown; cursor?: { next?: unknown } } | null;
  if (!body || !Array.isArray(body.data)) return null;
  const next = typeof body.cursor?.next === 'string' && body.cursor.next.length > 0 ? body.cursor.next : null;
  return { data: body.data as OpenCodeV2Message[], next };
}

/**
 * A session's newest messages, oldest first: pages newest to oldest until the
 * pages hold `budgetBytes` of JSON (the transcript window the caller caps to),
 * the history ends, or `MAX_MESSAGE_PAGES` pages were read. A failure on the
 * first page returns `[]`, per `parseTranscript`'s must-not-throw contract; a
 * failure on a later page keeps the newer pages already read.
 */
export async function fetchOpenCodeV2SessionMessages(
  server: AgentExecutionServer,
  sessionId: string,
  options: { budgetBytes?: number; maxPages?: number } = {},
  fetchImpl: OpenCodeV2Fetch = fetch,
): Promise<OpenCodeV2Message[]> {
  if (!server.url) return [];
  const target = { ...server, url: server.url };
  const budget = options.budgetBytes ?? parseWindowBytes();
  const maxPages = options.maxPages ?? MAX_MESSAGE_PAGES;
  const newestFirst: OpenCodeV2Message[] = [];
  let bytes = 0;
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    let result: MessagesPage | null;
    try {
      result = await fetchMessagesPage(target, sessionId, cursor, fetchImpl);
    } catch {
      result = null;
    }
    if (!result) break;
    for (const message of result.data) {
      newestFirst.push(message);
      bytes += JSON.stringify(message).length;
    }
    if (result.data.length === 0 || !result.next || bytes >= budget) break;
    cursor = result.next;
  }
  return newestFirst.reverse();
}

function toolInput(state: OpenCodeV2ToolState): unknown {
  // A tool still streaming its arguments carries them as raw JSON text.
  if (state.status === 'streaming' && typeof state.input === 'string') {
    try {
      return JSON.parse(state.input);
    } catch {
      return state.input;
    }
  }
  return state.input;
}

function toolContentText(content: OpenCodeV2ToolContent[] | undefined): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (part.type === 'text' && typeof part.text === 'string') return part.text;
      if (part.type === 'file') return part.name ?? part.uri ?? '';
      return '';
    })
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * Map an OpenCode 2 session's messages into Kangentic's `TranscriptEntry[]`,
 * the same entries `mapOpenCodeRemoteEntries` makes from a V1 server. A `user`
 * message is the user's text. An `assistant` message's content becomes text,
 * thinking and tool_use blocks, and each finished tool also a tool_result
 * entry after it. Every other message type (agent and model switches,
 * synthetic and system text, shell, compaction, idle) is the agent's own
 * bookkeeping and maps to nothing, as V1's non-user, non-assistant roles do.
 * The caller bounds the result with `capOpenCodeRemoteEntries`.
 */
export function mapOpenCodeV2Messages(messages: OpenCodeV2Message[]): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (!message || typeof message.id !== 'string') continue;
    const uuid = message.id;
    const ts = typeof message.time?.created === 'number' ? message.time.created : Date.now();

    if (message.type === 'user') {
      const text = typeof message.text === 'string' ? message.text.trim() : '';
      if (text.length > 0) entries.push({ kind: 'user', uuid, ts, text });
      continue;
    }
    if (message.type !== 'assistant' || !Array.isArray(message.content)) continue;

    const model = typeof message.model?.id === 'string' ? message.model.id : undefined;
    const blocks: TranscriptBlock[] = [];
    const toolResults: TranscriptEntry[] = [];
    for (const part of message.content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        if (part.text.trim().length > 0) blocks.push({ type: 'text', text: part.text });
      } else if (part.type === 'reasoning' && typeof part.text === 'string') {
        if (part.text.trim().length > 0) blocks.push({ type: 'thinking', text: part.text });
      } else if (part.type === 'tool' && part.state) {
        const toolUseId = typeof part.id === 'string' ? part.id : '';
        const name = typeof part.name === 'string' ? part.name : 'tool';
        blocks.push({ type: 'tool_use', id: toolUseId, name, input: toolInput(part.state) });
        if (part.state.status === 'completed') {
          toolResults.push({ kind: 'tool_result', uuid, ts, toolUseId, content: toolContentText(part.state.content), isError: false });
        } else if (part.state.status === 'error') {
          const errorText = part.state.error?.message ?? toolContentText(part.state.content);
          toolResults.push({ kind: 'tool_result', uuid, ts, toolUseId, content: errorText, isError: true });
        }
      }
    }
    if (blocks.length > 0) entries.push({ kind: 'assistant', uuid, ts, model, blocks });
    for (const result of toolResults) entries.push(result);
  }
  return entries;
}
