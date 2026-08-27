/**
 * Kangentic in-process MCP HTTP server.
 *
 * Hosts the kangentic_* MCP tools directly inside Electron main via
 * Node's built-in `http` module + `@modelcontextprotocol/sdk` Streamable
 * HTTP transport. Tool handlers run synchronously against the project
 * DB via the `commandHandlers` map -- no subprocess, no file bridge,
 * no offset tracking.
 *
 * URL shape: http://127.0.0.1:<port>/mcp/<projectId>[/<callerSessionId>]
 *       The optional third segment identifies WHICH session is calling. It is
 *       stamped into that session's own mcp.json at spawn, so it is correct by
 *       construction and not settable through any tool parameter. It is not a
 *       cryptographic identity: the bearer token is shared per launch and the
 *       segment is not validated, so a process holding the token can dial any
 *       id (see caller-url.ts). Absent for a human-driven client, the
 *       per-project `.kangentic/mcp-config.json`, or a Command Terminal
 *       session; steering then degrades to an unattributed caller rather than
 *       refusing.
 * Auth: random per-launch token, validated via `X-Kangentic-Token` header
 * Bind: 127.0.0.1 by default -- loopback skips Windows Defender Firewall
 *       prompts and is unreachable from other machines. A user can widen
 *       this by hand-editing `mcpServer.bindAddress` in the global
 *       config.json (there is no Settings UI for it) to expose the server
 *       on a LAN/VPN interface; `mcpServer.callbackHost` is allowlisted
 *       alongside it so a real external request is not rejected by
 *       DNS-rebinding protection. Both are opt-in and read once at
 *       startup. `urlForProject`/`baseUrl` always stay loopback, which
 *       keeps local consumers working for the default and for a wildcard
 *       bind ('0.0.0.0' / '::' bind loopback too). A bind to one SPECIFIC
 *       non-loopback interface does NOT bind loopback, so local agents
 *       would get an unreachable URL - see docs/mcp-server.md's Network
 *       Access section.
 *
 * Tool registrations live under ./mcp-http/, one `register*Tools` file per
 * family - see the `register*Tools` imports below for the current set rather
 * than an enumeration here, which drifts every time a family is added.
 * `handler-helpers.ts` holds the shared runHandler/callHandler + TaskCounter
 * primitives, and `session-send.ts` the delivery coordinator behind
 * `steering-tools.ts`.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { makeTaskCounter, type TaskCounter } from './mcp-http/handler-helpers';
import { registerTaskTools } from './mcp-http/task-tools';
import { registerProfileTools } from './mcp-http/profile-tools';
import { registerSessionTools } from './mcp-http/session-tools';
import { registerProjectTools } from './mcp-http/project-tools';
import { registerSearchTools } from './mcp-http/search-tools';
import { registerDiagnosticsTools } from './mcp-http/diagnostics-tools';
import { registerUsageTools } from './mcp-http/usage-tools';
import {
  registerBrowserTools,
  type AutomationConfigReader,
  type BrowserToolDependencies,
} from './mcp-http/browser-tools';
import { registerSteeringTools, type SteeringToolDependencies, type SteeringSessionLookup } from './mcp-http/steering-tools';
import {
  createSessionSendCoordinator,
  type SessionSendCoordinator,
  type SessionSendSessionManager,
  type SessionSendTerminalSubmit,
} from './mcp-http/session-send';
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

/** Network config for the MCP HTTP server, read once at startup. */
export interface McpServerNetworkConfig {
  /** Interface to bind. Default '127.0.0.1' (loopback only). */
  bindAddress: string;
  /**
   * Host allowlisted alongside `bindAddress` for DNS-rebinding protection (see
   * `buildAllowedHosts`), so a legitimate LAN/VPN request naming this host in its `Host`
   * header is not rejected. There is no delivery mechanism that reads this to build a URL
   * for an external client - the user reads their own reachable address from
   * `.kangentic/mcp-config.json` (already written for every project) and substitutes it
   * for that file's `127.0.0.1`.
   */
  callbackHost?: string;
}

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
 * Main-process singletons the steering tools need. `CommandContext` carries
 * only the project DB and board callbacks, so these are threaded in at
 * registration time instead (the `browser-tools.ts` precedent). Read lazily
 * per request because the MCP server starts before `createWindow`, so the IPC
 * context does not exist yet at `startMcpHttpServer` time.
 */
export interface McpSteeringContext {
  sessionManager: SessionSendSessionManager & SteeringSessionLookup;
  terminalSubmit: SessionSendTerminalSubmit;
}

export type SteeringContextReader = () => McpSteeringContext | null;

/**
 * Start the HTTP server. Resolves once it's listening; the OS picks a
 * free port via `.listen(0)`.
 */
export async function startMcpHttpServer(
  buildContext: ProjectContextFactory,
  getBrowserAutomationConfig: AutomationConfigReader,
  networkConfig: McpServerNetworkConfig,
  getSteeringContext: SteeringContextReader = () => null,
): Promise<McpHttpServerHandle> {
  const token = randomBytes(32).toString('hex');
  const expectedTokenBuffer = Buffer.from(token, 'utf-8');
  const taskCounter = makeTaskCounter();

  // One coordinator per server launch (its rate-limit windows, steer-chain
  // depths and pending deferred deliveries are launch-scoped state), built on
  // first use because the IPC context does not exist yet at startup.
  let sessionSendCoordinator: SessionSendCoordinator | null = null;
  const resolveSteering = (callerSessionId?: string): SteeringToolDependencies | null => {
    const steeringContext = getSteeringContext();
    if (!steeringContext) return null;
    if (!sessionSendCoordinator) {
      sessionSendCoordinator = createSessionSendCoordinator({
        sessionManager: steeringContext.sessionManager,
        terminalSubmit: steeringContext.terminalSubmit,
      });
    }
    return { coordinator: sessionSendCoordinator, sessions: steeringContext.sessionManager, callerSessionId };
  };

  // Caller scope for the browser family. Mirrors resolveSteering: both read the
  // same parseMcpRequestPath result, so the two cannot disagree about who is
  // calling. projectId is always present (buildContext already 404'd an unknown
  // one); the session lookup is read lazily for the same reason as above.
  const resolveBrowser = (
    projectId: string,
    callerSessionId?: string,
  ): BrowserToolDependencies => {
    const sessionManager = getSteeringContext()?.sessionManager ?? null;
    return {
      projectId,
      callerSessionId,
      // A narrow adapter over SessionManager: these tools only need to resolve
      // the caller's own task id. The lane's cookie jar is keyed by that task
      // id, so no worktree path lookup is needed here.
      sessions: sessionManager && {
        getSessionTaskId: (sessionId: string) => sessionManager.getSessionTaskId(sessionId),
      },
    };
  };

  const httpServer: Server = createServer((req, res) => {
    handleHttpRequest(req, res, expectedTokenBuffer, buildContext, taskCounter, getBrowserAutomationConfig, networkConfig, resolveSteering, resolveBrowser)
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

  // Bind the configured interface. Default '127.0.0.1' - NOT 'localhost'
  // (which can resolve to ::1 on IPv6-preferring systems and miss the
  // 127.0.0.1 binding) and NOT '0.0.0.0' unless the user explicitly opts
  // in by hand-editing config.json (widening the bind triggers a Windows
  // Defender Firewall prompt and makes the port LAN-reachable). Loopback
  // v4 works identically on Windows, macOS, and Linux.
  const bindAddress = networkConfig.bindAddress;
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, bindAddress, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    httpServer.close();
    throw new Error('[mcp-http] Failed to obtain HTTP server address after listen()');
  }
  // baseUrl / urlForProject stay on loopback regardless of bindAddress. That
  // holds for the default and for a wildcard bind ('0.0.0.0' / '::' bind
  // loopback too), so every locally-spawned agent still reaches the server
  // over 127.0.0.1. Known limitation: it does NOT hold for a bind to one
  // specific non-loopback interface, which leaves loopback unbound and hands
  // every local agent a URL nothing is listening on.
  const baseUrl = `http://127.0.0.1:${address.port}/mcp`;

  console.log(`[mcp-http] Listening on ${baseUrl} (bind ${bindAddress})`);

  return {
    baseUrl,
    token,
    urlForProject: (projectId: string) => `${baseUrl}/${projectId}`,
    close: () => {
      // Detach the SessionManager listeners the coordinator holds before the
      // socket teardown, so a shutdown never leaves a live 'activity'/'exit'
      // subscriber pointing at a disposed server.
      sessionSendCoordinator?.dispose();
      sessionSendCoordinator = null;
      closeMcpHttpServerSafely(httpServer);
    },
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

/**
 * Parse the request path into `{ projectId, callerSessionId }`. Expected shape:
 * `/mcp/<projectId>` or, when the client is a Kangentic-spawned agent,
 * `/mcp/<projectId>/<callerSessionId>`.
 *
 * `callerSessionId` (the third segment) is OPTIONAL by design and its absence
 * is never an error: a human running `claude` outside Kangentic, an older
 * session whose mcp.json predates the third segment, and the per-project
 * `.kangentic/mcp-config.json` all legitimately dial the two-segment form.
 * Steering degrades gracefully to an unattributed caller rather than refusing
 * (see caller-url.ts). A fourth-and-later segment is ignored, matching the
 * behavior before this was extracted (only segments[1]/segments[2] were ever
 * read).
 *
 * Returns null when the path does not match `/mcp/<projectId>[/...]` at all.
 *
 * Exported as a pure function for unit-test isolation, mirroring
 * `buildAllowedHosts` below - testing the URL-segment contract via a real HTTP
 * request through `startMcpHttpServer` would require booting the full MCP
 * module graph just to observe string parsing.
 */
export function parseMcpRequestPath(pathname: string): { projectId: string; callerSessionId?: string } | null {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length < 2 || segments[0] !== 'mcp') return null;
  return { projectId: segments[1], callerSessionId: segments[2] };
}

/**
 * Build the DNS-rebinding-protection allowlist for one request. Loopback and
 * `req.socket.localPort` are always allowed. Widening `bindAddress` or
 * configuring `callbackHost` expands who can legitimately dial in, so both
 * must be allowlisted too - otherwise a real LAN/VPN request would bind
 * successfully but still get rejected by DNS-rebinding protection.
 *
 * Entries are matched by the SDK against the raw `Host` header with an exact
 * string compare, so an IPv6 literal has to be stored bracketed the way a
 * client actually sends it (`Host: [2001:db8::1]:51234`, per RFC 3986 /
 * RFC 7230). Hostnames and IPv4 literals never contain a colon, so the
 * colon test below is a safe discriminator.
 *
 * Exported as a pure function for unit-test isolation - testing this via a
 * real HTTP request through startMcpHttpServer would require booting the
 * full MCP module graph.
 */
export function buildAllowedHosts(localPort: number | string, networkConfig: McpServerNetworkConfig): string[] {
  const allowedHosts = ['127.0.0.1', `127.0.0.1:${localPort}`, 'localhost', '[::1]'];
  for (const host of [networkConfig.bindAddress, networkConfig.callbackHost]) {
    if (host && host !== '127.0.0.1') {
      const hostAsSentInHeader = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      allowedHosts.push(hostAsSentInHeader, `${hostAsSentInHeader}:${localPort}`);
    }
  }
  return allowedHosts;
}

/**
 * Build a fully-configured per-request McpServer: instructions + every tool
 * family registered. Exported so the registration and policy gating are
 * unit-testable without booting the HTTP server.
 *
 * The kangentic_browser_* family is registered (and its instructions section
 * emitted) ONLY when browser automation is enabled in settings. When it is off,
 * every CDP-driving browser tool is already blocked by the withGuest capability
 * gate, and the one non-gated tool (kangentic_browser_list_panes) could only
 * report panes the agent cannot act on, so advertising the ~14 unusable tools
 * would just inject ~3.6k tokens of dead schema into every agent's context. The
 * policy is read once here, per request, so a Settings toggle takes effect on
 * the next agent session.
 */
export function buildConfiguredMcpServer(
  resolver: RequestResolver,
  taskCounter: TaskCounter,
  getBrowserAutomationConfig: AutomationConfigReader,
  steering: SteeringToolDependencies | null | undefined,
  // Required, unlike `steering`: a browser tool family built without caller
  // scope is the cross-project pane leak this parameter exists to prevent, so
  // there is deliberately no way to omit it.
  browser: BrowserToolDependencies,
): McpServer {
  const browserAutomationEnabled = getBrowserAutomationConfig().enabled;
  const instructions = buildServerInstructions(resolver, browserAutomationEnabled);
  const mcpServer = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions },
  );
  registerTaskTools(mcpServer, resolver, taskCounter);
  registerProfileTools(mcpServer, resolver);
  registerSessionTools(mcpServer, resolver);
  registerProjectTools(mcpServer, resolver);
  registerSearchTools(mcpServer, resolver);
  registerUsageTools(mcpServer, resolver);
  registerDiagnosticsTools(mcpServer, resolver);
  if (browserAutomationEnabled) {
    registerBrowserTools(mcpServer, getBrowserAutomationConfig, browser);
  }
  // Steering needs live main-process singletons. They are absent only before
  // the IPC context exists (the server starts ahead of createWindow), which is
  // strictly before any agent can be running to be steered.
  if (steering) {
    registerSteeringTools(mcpServer, resolver, steering);
  }

  // Dev-only: register the kangentic_devtools_* tools that drive the localhost
  // inspection bridge. Production builds drop both the import (top of file) and
  // this call via `__KANGENTIC_DEV__` dead-code elimination.
  if (__KANGENTIC_DEV__) {
    registerDevtoolsMcpTools(mcpServer);
  }

  return mcpServer;
}

/** Validates the URL path and token, then dispatches to a per-request McpServer. */
async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  expectedTokenBuffer: Buffer,
  buildContext: ProjectContextFactory,
  taskCounter: TaskCounter,
  getBrowserAutomationConfig: AutomationConfigReader,
  networkConfig: McpServerNetworkConfig,
  resolveSteering: (callerSessionId?: string) => SteeringToolDependencies | null,
  resolveBrowser: (projectId: string, callerSessionId?: string) => BrowserToolDependencies,
): Promise<void> {
  // Token check first -- cheapest reject path. Constant-time compare so a
  // local timing oracle can't byte-by-byte recover the token. When bound to
  // loopback only (the default), this is pure belt-and-suspenders since the
  // attacker would need same-machine code execution to even try; it becomes
  // the primary defense once a user opts into a wider `bindAddress`.
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

  // Parse the URL path (see parseMcpRequestPath's doc comment for the shape
  // and the caller-segment-optional rationale). The SDK transport handles
  // JSON-RPC body parsing -- we just route.
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const parsedPath = parseMcpRequestPath(url.pathname);
  if (!parsedPath) {
    res.statusCode = 404;
    res.end();
    return;
  }
  const { projectId, callerSessionId } = parsedPath;

  const resolver = buildContext(projectId);
  if (!resolver) {
    res.statusCode = 404;
    res.end();
    return;
  }

  // Per-request McpServer + transport. Stateless mode, plain JSON responses
  // (no SSE), built-in DNS rebinding protection on top of the 127.0.0.1 bind
  // for belt-and-suspenders. The server is rebuilt per request so the
  // instructions (active-project name, registered-project list) and the
  // browser-tool gating reflect current DB / settings state (see
  // buildConfiguredMcpServer).
  const mcpServer = buildConfiguredMcpServer(
    resolver,
    taskCounter,
    getBrowserAutomationConfig,
    resolveSteering(callerSessionId),
    resolveBrowser(projectId, callerSessionId),
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    enableDnsRebindingProtection: true,
    allowedHosts: buildAllowedHosts(req.socket.localPort ?? '', networkConfig),
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

