/**
 * Kangentic in-process MCP HTTP server.
 *
 * Hosts the kangentic_* MCP tools directly inside Electron main via
 * Node's built-in `http` module + `@modelcontextprotocol/sdk` Streamable
 * HTTP transport. Tool handlers run synchronously against the project
 * DB via the `commandHandlers` map -- no subprocess, no file bridge,
 * no offset tracking.
 *
 * URL shape: http://127.0.0.1:<port>/mcp/<projectId>
 * Auth: random per-launch token, validated via `X-Kangentic-Token` header
 * Bind: 127.0.0.1 only -- loopback skips Windows Defender Firewall
 *       prompts and is unreachable from other machines.
 *
 * Tool registrations live under ./mcp-http/:
 *   - task-tools.ts     - board/task/column mutations + related reads
 *   - session-tools.ts  - session inspection, backlog, read-only SQL
 *   - handler-helpers.ts - runHandler/callHandler + TaskCounter primitive
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CommandContext } from './commands';
import { makeTaskCounter, type TaskCounter } from './mcp-http/handler-helpers';
import { registerTaskTools } from './mcp-http/task-tools';
import { registerSessionTools } from './mcp-http/session-tools';

const SERVER_NAME = 'kangentic';
const SERVER_VERSION = '1.0.0';
const MAX_TASKS_PER_SESSION = 50;

/**
 * Builds a CommandContext for a given project. The HTTP server calls this
 * once per request -- main process owns the project lifecycle and provides
 * the factory at startup time.
 */
export type ProjectContextFactory = (projectId: string) => CommandContext | null;

export interface McpHttpServerHandle {
  /** Full URL with port substituted in. Pass to claude --mcp-config or write into mcp.json. */
  baseUrl: string;
  /** Random per-launch token. Clients must send it as `X-Kangentic-Token`. */
  token: string;
  /** Build a project-scoped URL for the given project ID. */
  urlForProject(projectId: string): string;
  /** Synchronously stop accepting new connections and close the server. */
  close(): void;
}

/**
 * Start the HTTP server. Resolves once it's listening; the OS picks a
 * free port via `.listen(0)`.
 */
export async function startMcpHttpServer(
  buildContext: ProjectContextFactory,
): Promise<McpHttpServerHandle> {
  const token = randomBytes(32).toString('hex');
  const expectedTokenBuffer = Buffer.from(token, 'utf-8');
  const taskCounter = makeTaskCounter(MAX_TASKS_PER_SESSION);

  const httpServer: Server = createServer((req, res) => {
    handleHttpRequest(req, res, expectedTokenBuffer, buildContext, taskCounter)
      .catch((error) => {
        console.error('[mcp-http] Request handler crashed:', error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end();
        } else if (!res.writableEnded) {
          res.end();
        }
      });
  });

  // Permanent error listener so any post-listen server-level errors (e.g.,
  // EMFILE under heavy load, EADDRINUSE if a stale binding lingers) get
  // logged instead of crashing main with an unhandled "error" event.
  httpServer.on('error', (error) => {
    console.error('[mcp-http] Server error:', error);
  });

  // Bind 127.0.0.1 explicitly. NOT 'localhost' (which can resolve to ::1
  // on IPv6-preferring systems and miss the 127.0.0.1 binding) and NOT
  // 0.0.0.0 (which exposes the port to the network and triggers a Windows
  // Defender Firewall prompt). Loopback v4 works identically on Windows,
  // macOS, and Linux.
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    httpServer.close();
    throw new Error('[mcp-http] Failed to obtain HTTP server address after listen()');
  }
  const baseUrl = `http://127.0.0.1:${address.port}/mcp`;

  console.log(`[mcp-http] Listening on ${baseUrl}`);

  return {
    baseUrl,
    token,
    urlForProject: (projectId: string) => `${baseUrl}/${projectId}`,
    close: () => {
      try {
        httpServer.close();
      } catch (error) {
        console.error('[mcp-http] close() failed:', error);
      }
    },
  };
}

/** Validates the URL path and token, then dispatches to a per-request McpServer. */
async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedTokenBuffer: Buffer,
  buildContext: ProjectContextFactory,
  taskCounter: TaskCounter,
): Promise<void> {
  // Token check first -- cheapest reject path. Constant-time compare so a
  // local timing oracle can't byte-by-byte recover the token. Pure
  // belt-and-suspenders since we already bind 127.0.0.1 only and the
  // attacker would need same-machine code execution to even try.
  const headerToken = req.headers['x-kangentic-token'];
  if (typeof headerToken !== 'string') {
    res.statusCode = 401;
    res.end();
    return;
  }
  const headerTokenBuffer = Buffer.from(headerToken, 'utf-8');
  if (
    headerTokenBuffer.length !== expectedTokenBuffer.length ||
    !timingSafeEqual(headerTokenBuffer, expectedTokenBuffer)
  ) {
    res.statusCode = 401;
    res.end();
    return;
  }

  // Parse projectId from URL path. Expected: /mcp/<projectId>
  // (the SDK transport handles JSON-RPC body parsing -- we just route).
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== 'mcp') {
    res.statusCode = 404;
    res.end();
    return;
  }
  const projectId = segments[1];

  const context = buildContext(projectId);
  if (!context) {
    res.statusCode = 404;
    res.end();
    return;
  }

  // Per-request McpServer + transport. Stateless mode, plain JSON
  // responses (no SSE), built-in DNS rebinding protection on top of the
  // 127.0.0.1 bind for belt-and-suspenders.
  const mcpServer = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTaskTools(mcpServer, context, taskCounter, MAX_TASKS_PER_SESSION);
  registerSessionTools(mcpServer, context);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: ['127.0.0.1', `127.0.0.1:${req.socket.localPort ?? ''}`, 'localhost', '[::1]'],
  });

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    // If connect() or handleRequest() threw before the response was
    // committed, write a 500 so the client doesn't hang waiting for a
    // body that will never arrive.
    console.error('[mcp-http] Per-request dispatch failed:', error);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.end();
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    // Best-effort cleanup of the per-request transport. The McpServer
    // has no per-instance heavy state to release.
    try { await transport.close(); } catch { /* already closed */ }
  }
}
