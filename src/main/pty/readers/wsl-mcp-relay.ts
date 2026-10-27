/**
 * Kangentic's half of the stdio MCP bridge a distro CLI runs (the `mcp` mode of
 * the WSL hook transport, `wsl-hook-transport.ts`): one JSON-RPC message,
 * posted to Kangentic's loopback MCP server exactly as an HTTP client sends it,
 * with the token the request carried. The server's own token and host checks
 * decide, as they do for every client. The relay posts only the caller's own
 * JSON-RPC body, and only to a `/mcp/` path on `127.0.0.1`; it does not pin the
 * port, so the URL in the request names which loopback server that is.
 *
 * Returns the text the bridge prints: the server's answer on one line, nothing
 * for a notification (which gets no answer), or a JSON-RPC error carrying the
 * raw failure (the HTTP status and body, or the connection error), so the
 * agent reports what went wrong instead of waiting on an answer that never
 * comes.
 */

export interface McpRelayInput {
  /** The request's argument line: `<token> <url>`. */
  argument: string;
  /** One JSON-RPC message, as the CLI wrote it. */
  body: string;
  signal?: AbortSignal;
  /** Test seam; `fetch` by default. */
  fetchImplementation?: typeof fetch;
}

/** JSON-RPC's internal error, which the spec gives a transport failure. */
const INTERNAL_ERROR_CODE = -32603;

export async function relayMcpMessage(input: McpRelayInput): Promise<string> {
  const separator = input.argument.indexOf(' ');
  const token = separator < 0 ? '' : input.argument.slice(0, separator);
  const url = separator < 0 ? input.argument : input.argument.slice(separator + 1);
  const refusal = refuseUrl(url);
  if (refusal) return errorAnswer(input.body, refusal);

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
      signal: input.signal,
    });
  } catch (error) {
    return errorAnswer(input.body, describeFetchFailure(error));
  }
  const text = await response.text().catch(() => '');
  const answer = answerLines(text, response.headers.get('content-type') ?? '');
  if (response.ok || answer) return answer;
  return errorAnswer(input.body, `HTTP ${response.status}${text.trim() ? `: ${text.trim()}` : ''}`);
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
