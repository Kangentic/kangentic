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
import { makeTaskCounter, type TaskCounter } from './mcp-http/handler-helpers';
import { registerTaskTools } from './mcp-http/task-tools';
import { registerSessionTools } from './mcp-http/session-tools';
import { registerProjectTools } from './mcp-http/project-tools';
import { registerSearchTools } from './mcp-http/search-tools';
import { registerDiagnosticsTools } from './mcp-http/diagnostics-tools';
import { registerBrowserTools, type AutomationConfigReader } from './mcp-http/browser-tools';
import { registerDevtoolsMcpTools } from '../../devtools/mcp/register';
import { buildServerInstructions } from './mcp-http/server-instructions';
import { logMcpToolArguments } from './mcp-http/tool-call-logging';
import type { RequestResolver } from './mcp-http/project-resolver';

const SERVER_NAME = 'kangentic';
const SERVER_VERSION = '1.0.0';

/**
 * Builds a `RequestResolver` bound to the given URL-path project. The
 * HTTP server calls this once per request -- main process owns the
 * project lifecycle and provides the factory at startup time.
 *
 * Returning null causes the server to respond 404 (unknown project, or
 * MCP server globally disabled, etc.). A non-null resolver exposes the
 * URL-path project as its default context and can also build contexts
 * for any other project on demand (used by tools that accept an
 * optional `project` argument).
 */
export type ProjectContextFactory = (projectId: string) => RequestResolver | null;

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
  getBrowserAutomationConfig: AutomationConfigReader,
  getMaxTaskCreateCount: () => number,
): Promise<McpHttpServerHandle> {
  const token = randomBytes(32).toString('hex');
  const expectedTokenBuffer = Buffer.from(token, 'utf-8');
  const taskCounter = makeTaskCounter(getMaxTaskCreateCount);

  const httpServer: Server = createServer((req, res) => {
    handleHttpRequest(req, res, expectedTokenBuffer, buildContext, taskCounter, getBrowserAutomationConfig)
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
    close: () => closeMcpHttpServerSafely(httpServer),
  };
}

/**
 * Synchronous, best-effort shutdown for the MCP HTTP server.
 *
 * Terminates keep-alive sockets via `closeAllConnections()` BEFORE calling
 * `close()`. Without that order, an attached agent holding an idle
 * keep-alive against the MCP endpoint keeps the underlying socket alive
 * past Electron's 6s hard-failsafe and the main process becomes a zombie.
 *
 * Only invoked from the synchronous shutdown path, so any in-flight
 * request is going to lose its connection in under 6s anyway; this just
 * makes the truncation deterministic. closeAllConnections is Node 18.2+.
 *
 * Exported for unit-test isolation -- testing the close-handle behavior
 * via startMcpHttpServer would require booting the full MCP module graph.
 */
export function closeMcpHttpServerSafely(httpServer: Pick<Server, 'closeAllConnections' | 'close'>): void {
  try {
    httpServer.closeAllConnections();
    httpServer.close();
  } catch (error) {
    console.error('[mcp-http] close() failed:', error);
  }
}

/** Validates the URL path and token, then dispatches to a per-request McpServer. */
async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedTokenBuffer: Buffer,
  buildContext: ProjectContextFactory,
  taskCounter: TaskCounter,
  getBrowserAutomationConfig: AutomationConfigReader,
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

  const resolver = buildContext(projectId);
  if (!resolver) {
    res.statusCode = 404;
    res.end();
    return;
  }

  // Per-request McpServer + transport. Stateless mode, plain JSON
  // responses (no SSE), built-in DNS rebinding protection on top of the
  // 127.0.0.1 bind for belt-and-suspenders.
  //
  // `instructions` is surfaced to the agent at initialize time (Claude
  // Code renders it as `## kangentic` in its system prompt). We build it
  // per-request so the active-project name and registered-project list
  // reflect the current DB state, not whatever was true at launch.
  const instructions = buildServerInstructions(resolver);
  const mcpServer = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions },
  );
  registerTaskTools(mcpServer, resolver, taskCounter);
  registerSessionTools(mcpServer, resolver);
  registerProjectTools(mcpServer, resolver);
  registerSearchTools(mcpServer, resolver);
  registerDiagnosticsTools(mcpServer, resolver);
  // Shipped: the user-facing kangentic_browser_* family that drives the
  // embedded Browser pane in-process. Registered unconditionally (NOT gated
  // by __KANGENTIC_DEV__) - this targets the user's own dev server.
  registerBrowserTools(mcpServer, getBrowserAutomationConfig);

  // Dev-only: register the kangentic_devtools_* tools that drive the
  // localhost inspection bridge. Production builds drop both the import
  // (above) and this call via `__KANGENTIC_DEV__` dead-code elimination.
  if (__KANGENTIC_DEV__) {
    registerDevtoolsMcpTools(mcpServer);
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: ['127.0.0.1', `127.0.0.1:${req.socket.localPort ?? ''}`, 'localhost', '[::1]'],
  });

  try {
    await mcpServer.connect(transport);
    if (req.method === 'POST') {
      // Own the POST body read instead of delegating to the SDK's Node to Web
      // Request conversion. Node-native buffering is reliable for multi-chunk
      // bodies, lets us capture the raw tool-call arguments for the labels-drop
      // diagnostic (task #229), and we hand the parsed value back to the SDK
      // via its supported `parsedBody` parameter so nothing downstream changes.
      let parsedBody: unknown;
      try {
        parsedBody = JSON.parse(await readRequestBody(req));
      } catch {
        // Malformed or empty JSON body. Emit the JSON-RPC parse error
        // ourselves rather than re-reading the now-consumed stream.
        if (!res.headersSent) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
        }
        return;
      }
      // Diagnostics must never break dispatch.
      try { logMcpToolArguments(parsedBody); } catch { /* ignore logging failure */ }
      await transport.handleRequest(req, res, parsedBody);
    } else {
      // GET (SSE stream) and DELETE (session teardown) carry no JSON body.
      await transport.handleRequest(req, res);
    }
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

/**
 * Buffer the full request body as a UTF-8 string. Node-native chunk
 * assembly handles multi-chunk bodies correctly; the caller JSON.parses the
 * result and hands it to the SDK via `handleRequest(req, res, parsedBody)`.
 */
function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

