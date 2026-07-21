import type { AgentExecutionServer, AgentExecutionServerAuth, RemoteServerStatus } from '../../../../shared/types';

/**
 * Minimal shape of the global `fetch` this module needs, injectable for unit
 * tests (mirrors `FetchLike` in `mobile-bridge/push/expo-push-client.ts`) so
 * no real network call happens under test.
 */
export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

const REQUEST_TIMEOUT_MS = 10_000;

/** OpenCode server message row - `GET /session/:id/message` entry.
 *  UNVERIFIED against a live server (no running instance was available while
 *  building this): field names are inferred from the OpenCode SDK's Message/Part
 *  shapes (id, role, time, modelID for messages; id, type, text, callID, tool,
 *  state for parts). If a real server's response differs, adjust
 *  `mapOpenCodeRemoteEntries` in transcript-parser.ts - this module only owns
 *  the transport, not the schema. */
export interface OpenCodeRemoteMessage {
  id: string;
  role: string;
  time?: { created?: number; completed?: number };
  modelID?: string;
  [key: string]: unknown;
}
export interface OpenCodeRemotePart {
  id?: string;
  messageID?: string;
  type: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: { input?: unknown; output?: unknown; status?: string };
  [key: string]: unknown;
}
export interface OpenCodeRemoteMessageEntry {
  info: OpenCodeRemoteMessage;
  parts: OpenCodeRemotePart[];
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function authHeaders(auth: AgentExecutionServerAuth): Record<string, string> {
  if (auth.kind === 'basic') {
    const token = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  // 'bearerEnv' is declared on the shared type for Codex-shaped adapters but is
  // not used by OpenCode's own auth (HTTP basic only) - unreachable here today.
  return {};
}

/**
 * Reachability probe for an OpenCode remote server: `GET /global/health` ->
 * `{ healthy: boolean, version: string }`. Never throws - every failure mode
 * (network error, non-2xx, malformed body, missing URL) resolves to
 * `{ reachable: false, reason }` so callers (the IPC handler, the adapter's
 * `remoteExecution.probeServer`) can surface it directly.
 */
export async function probeOpenCodeServer(
  server: AgentExecutionServer,
  fetchImpl: FetchLike = fetch,
): Promise<RemoteServerStatus> {
  if (!server.url) return { reachable: false, reason: 'No server URL configured' };
  try {
    const response = await fetchImpl(`${trimTrailingSlash(server.url)}/global/health`, {
      method: 'GET',
      headers: authHeaders(server.auth),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      // Distinct from a generic non-2xx: the server IS reachable, but the
      // configured username/password (or the absence of any) was rejected.
      // Surfacing this separately is what makes "Test connection" actually
      // test credentials, not just reachability.
      return { reachable: false, reason: 'Authentication failed - check the username and password' };
    }
    if (!response.ok) {
      return { reachable: false, reason: `Server responded with HTTP ${response.status}` };
    }
    const body = (await response.json()) as { healthy?: boolean; version?: string };
    if (!body.healthy) return { reachable: false, reason: 'Server reported unhealthy' };
    return { reachable: true, version: body.version ?? null };
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * Fetch a remote OpenCode session's messages: `GET /session/:id/message`.
 * Returns `[]` on any failure (unreachable server, non-2xx, malformed body) -
 * callers treat a missing/unreachable remote transcript identically to a
 * missing local file, per `AgentAdapter.parseTranscript`'s "must not throw"
 * contract.
 */
export async function fetchOpenCodeSessionMessages(
  server: AgentExecutionServer,
  sessionId: string,
  fetchImpl: FetchLike = fetch,
): Promise<OpenCodeRemoteMessageEntry[]> {
  if (!server.url) return [];
  try {
    const response = await fetchImpl(
      `${trimTrailingSlash(server.url)}/session/${encodeURIComponent(sessionId)}/message`,
      { method: 'GET', headers: authHeaders(server.auth), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body) ? (body as OpenCodeRemoteMessageEntry[]) : [];
  } catch {
    return [];
  }
}
