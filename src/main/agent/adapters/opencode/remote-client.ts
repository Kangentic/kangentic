import type { AgentExecutionServer, AgentExecutionServerAuth, RemoteServerStatus } from '../../../../shared/types';

/**
 * Minimal shape of the global `fetch` this module needs, injectable for unit
 * tests (mirrors `FetchLike` in `mobile-bridge/push/expo-push-client.ts`) so
 * no real network call happens under test.
 */
export interface FetchLike {
  (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
  }>;
}

/** OpenCode 2's fixed Basic auth username (`migrate-v1.mdx`, "Server authentication"). */
export const OPENCODE_V2_USERNAME = 'opencode';

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

export function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/** The major of an OpenCode version string (`2.2.5`, `v1.18.31`), or null when it has none. */
export function openCodeMajorVersion(version: string): number | null {
  const match = /^v?(\d+)\./i.exec(version.trim());
  return match ? Number(match[1]) : null;
}

/** Basic auth with the configured username, as an OpenCode 1 server expects. */
export function authHeaders(auth: AgentExecutionServerAuth): Record<string, string> {
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
      // An OpenCode 2 server rejects every username but `opencode`.
      if (server.auth.kind === 'basic' && server.auth.username !== OPENCODE_V2_USERNAME) {
        const openCode2Version = await openCode2ServerVersion(server, fetchImpl);
        if (openCode2Version !== null) return openCode2MismatchStatus(openCode2Version);
      }
      return { reachable: false, reason: 'Authentication failed - check the username and password' };
    }
    if (!response.ok) {
      return { reachable: false, reason: `Server responded with HTTP ${response.status}` };
    }
    let body: { healthy?: boolean; version?: string };
    try {
      body = (await response.json()) as { healthy?: boolean; version?: string };
    } catch {
      // An OpenCode 2 server answers this route with its web app's HTML and a
      // 200. The local CLI and the server must be the same major, so the
      // probe names the server's version from its own /api/info.
      const openCode2Version = await openCode2ServerVersion(server, fetchImpl);
      if (openCode2Version !== null) return openCode2MismatchStatus(openCode2Version);
      return { reachable: false, reason: 'The server did not answer as an OpenCode server' };
    }
    if (!body.healthy) return { reachable: false, reason: 'Server reported unhealthy' };
    return { reachable: true, version: body.version ?? null };
  } catch (error) {
    return { reachable: false, reason: error instanceof Error ? error.message : 'Unknown error' };
  }
}

function openCode2MismatchStatus(openCode2Version: string): RemoteServerStatus {
  return { reachable: false, reason: `The server runs OpenCode ${openCode2Version}, and the local OpenCode is version 1` };
}

/**
 * The version an OpenCode 2 server reports on `GET /api/info`, or null for
 * anything else. A V2 server's username is always `opencode`, so the request
 * sends that with the configured password, and no header without one, as
 * `openCodeV2AuthHeaders` does.
 */
async function openCode2ServerVersion(server: AgentExecutionServer, fetchImpl: FetchLike): Promise<string | null> {
  if (!server.url) return null;
  try {
    const headers = server.auth.kind === 'basic' && server.auth.password
      ? authHeaders({ kind: 'basic', username: OPENCODE_V2_USERNAME, password: server.auth.password })
      : {};
    const response = await fetchImpl(`${trimTrailingSlash(server.url)}/api/info`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown } | null;
    const version = body?.version;
    if (typeof version !== 'string') return null;
    const major = openCodeMajorVersion(version);
    return major !== null && major >= 2 ? version : null;
  } catch {
    return null;
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
