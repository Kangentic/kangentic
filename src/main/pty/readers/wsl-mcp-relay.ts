/**
 * Kangentic's half of the stdio MCP bridge a distro CLI runs (the `mcp` mode of
 * the WSL hook transport, `wsl-hook-transport.ts`): one JSON-RPC message,
 * posted to Kangentic's loopback MCP server exactly as an HTTP client sends it.
 * The server's own token and host checks decide, as they do for every client.
 * The relay posts only the caller's own JSON-RPC body, and only to a `/mcp/`
 * path on `127.0.0.1`.
 *
 * Which server, and with which token, is Kangentic's own: the one that is
 * running now. The request names a project path, and the address and token the
 * CLI was started with are not trusted for anything else. A CLI that outlives
 * the app's restart (a remote agent a quit left running, #913) holds the old
 * port and token, and would otherwise lose every tool until it was restarted.
 * Nor can a message from a host steer the relay at another loopback service or
 * make it send a token of the host's choosing.
 *
 * Returns the text the bridge prints: the server's answer on one line, nothing
 * for a notification (which gets no answer), or a JSON-RPC error that says what
 * went wrong and what to do about it, with the raw failure in it (the HTTP
 * status and body, or the connection error), so the agent can recover instead
 * of waiting on an answer that never comes.
 */

export interface McpRelayServer {
  /** The running server's address, `http://127.0.0.1:<port>/mcp`. */
  baseUrl: string;
  /** The running server's token. */
  token: string;
}

export interface McpRelayInput {
  /** The request's argument line: `<token> <url>`. */
  argument: string;
  /** One JSON-RPC message, as the CLI wrote it. */
  body: string;
  signal?: AbortSignal;
  /** Test seam; `fetch` by default. */
  fetchImplementation?: typeof fetch;
  /** The server to post to. By default the one registered with `setMcpRelayServer`. */
  server?: McpRelayServer | null;
  /** How long one call may take before the relay gives up on it. */
  timeoutMs?: number;
}

/** JSON-RPC's internal error, which the spec gives a transport failure. */
const INTERNAL_ERROR_CODE = -32603;

/** A call that takes longer than this is reported as unanswered; the longest tool call is a browser step. */
export const MCP_RELAY_TIMEOUT_MS = 120_000;

let currentServer: (() => McpRelayServer | null) | null = null;

/** Tell the relay which server is running now. Cleared with null at quit. */
export function setMcpRelayServer(provider: (() => McpRelayServer | null) | null): void {
  currentServer = provider;
}

export async function relayMcpMessage(input: McpRelayInput): Promise<string> {
  const separator = input.argument.indexOf(' ');
  const requestedToken = separator < 0 ? '' : input.argument.slice(0, separator);
  const requestedUrl = separator < 0 ? input.argument : input.argument.slice(separator + 1);
  const refusal = refuseUrl(requestedUrl);
  if (refusal) return errorAnswer(input.body, refusal);

  const server = input.server === undefined ? currentServer?.() ?? null : input.server;
  const url = server ? onServer(requestedUrl, server.baseUrl) : requestedUrl;
  const token = server ? server.token : requestedToken;
  const timeoutMs = input.timeoutMs ?? MCP_RELAY_TIMEOUT_MS;

  let response: Response;
  try {
    response = await (input.fetchImplementation ?? fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-Kangentic-Token': token,
      },
      body: input.body,
      signal: input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isTimeout(error)) {
      return errorAnswer(input.body, `Kangentic did not answer within ${Math.round(timeoutMs / 1000)} seconds. The call may still be running there, so check what it changed before calling it again.`);
    }
    return errorAnswer(input.body, `Kangentic's MCP server could not be reached (${describeFetchFailure(error)}). Retry in a moment. If it keeps failing, the Kangentic app may be restarting.`);
  }
  const text = await response.text().catch(() => '');
  const answer = answerLines(text, response.headers.get('content-type') ?? '');
  if (response.ok || answer) return answer;
  return errorAnswer(input.body, describeHttpFailure(response.status, text));
}

/** The request's own path and query, on the running server's address. */
function onServer(requestedUrl: string, serverBaseUrl: string): string {
  const requested = new URL(requestedUrl);
  const server = new URL(serverBaseUrl);
  requested.protocol = server.protocol;
  requested.host = server.host;
  return requested.toString();
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || (error.name === 'AbortError' && error.cause instanceof Error && error.cause.name === 'TimeoutError'));
}

/** What a status from the server means for the agent, with the status and body as given. */
function describeHttpFailure(status: number, body: string): string {
  const raw = `HTTP ${status}${body.trim() ? `: ${body.trim()}` : ''}`;
  if (status === 401) return `${raw}. Kangentic refused this session's token. Restart this session so it starts with the current one.`;
  if (status === 404) return `${raw}. Kangentic's MCP server is turned off, or this project is not open in it. Turn it on under Settings, MCP Server, then call the tool again.`;
  if (status >= 500) return `${raw}. Kangentic's MCP server failed on this call. Retry once. If it repeats, tell the user.`;
  return raw;
}

/**
 * The error that stands for an answer too large to cross the link to a host: one JSON-RPC error with the
 * request's own id, so the agent's call ends with a reason instead of waiting for bytes that cannot come.
 * Null when `answer` carries no id to answer (a notification's, which nobody waits on).
 */
export function oversizeAnswer(answer: string, sizeBytes: number, limitBytes: number): string | null {
  let id: string | number | null = null;
  try {
    const parsed: unknown = JSON.parse(answer.split('\n')[0]);
    const candidate = (Array.isArray(parsed) ? parsed[0] : parsed) as { id?: unknown } | null;
    if (candidate && (typeof candidate.id === 'string' || typeof candidate.id === 'number')) id = candidate.id;
  } catch {
    // An answer that is not one JSON line has no id to take.
  }
  if (id === null) return null;
  const message = `The result is ${Math.round(sizeBytes / 1024)} KB, more than the ${Math.round(limitBytes / 1024)} KB that can reach this host. Ask for less of it, or have the tool save it to a file (the browser tools take saveToFile) and read the file.`;
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR_CODE, message } })}\n`;
}

/** Why a URL is not the one the relay posts to, or null when it is. */
function refuseUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Not a URL: ${url}`;
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.pathname.startsWith('/mcp/')) {
    return `Not Kangentic's MCP server: ${url}`;
  }
  return null;
}

/**
 * The server's answer as the lines a stdio client reads: one JSON-RPC message
 * per line. A JSON body is re-written on one line (a JSON string escapes its
 * line breaks); a stream gives one line per event. Empty when the body holds
 * no message, as a notification's 202 does.
 */
function answerLines(text: string, contentType: string): string {
  const messages = contentType.includes('text/event-stream') ? streamMessages(text) : [text];
  const lines: string[] = [];
  for (const message of messages) {
    if (message.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(message);
      if (isJsonRpcPayload(parsed)) lines.push(JSON.stringify(parsed));
    } catch {
      // Not JSON: the caller reports the status instead.
    }
  }
  return lines.map((line) => `${line}\n`).join('');
}

/** The `data:` payloads of a server-sent event stream, one per event. */
function streamMessages(text: string): string[] {
  const messages: string[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''));
    if (data.length > 0) messages.push(data.join('\n'));
  }
  return messages;
}

function isJsonRpcPayload(value: unknown): boolean {
  const items = Array.isArray(value) ? value : [value];
  return items.length > 0 && items.every((item) => typeof item === 'object' && item !== null && (item as { jsonrpc?: unknown }).jsonrpc === '2.0');
}

/**
 * A JSON-RPC error for each request in `body` (a message with a method and an
 * id), on one line; nothing for a notification, which expects no answer.
 */
function errorAnswer(body: string, message: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  const requests = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRequest);
  if (requests.length === 0) return '';
  const errors = requests.map((request) => ({ jsonrpc: '2.0', id: request.id, error: { code: INTERNAL_ERROR_CODE, message } }));
  return `${JSON.stringify(Array.isArray(parsed) ? errors : errors[0])}\n`;
}

function isRequest(value: unknown): value is { id: string | number } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { id?: unknown; method?: unknown };
  return typeof record.method === 'string' && (typeof record.id === 'string' || typeof record.id === 'number');
}

/** A failed fetch's own message and its cause's (undici reports `fetch failed`, the cause says why). */
function describeFetchFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause: unknown = error.cause;
  return cause instanceof Error && cause.message && cause.message !== error.message
    ? `${error.message}: ${cause.message}`
    : error.message;
}
