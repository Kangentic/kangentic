import * as http from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { enumeratePreviewInstances } from '../main/instances';
import { readLockfile, isLockfilePidAlive } from '../main/lockfile';
import type { PreviewInstanceRecord } from '../shared/types';

/**
 * Dev-only MCP tools that wrap the localhost inspection bridge. Each
 * tool resolves a preview instance via its lockfile, calls the bridge's
 * HTTP endpoint over 127.0.0.1, and returns the response as the tool's
 * single text content block.
 *
 * Tool naming: every tool starts with `kangentic_devtools_` so the
 * dev-only surface is clearly separable from the product MCP tools
 * (`kangentic_*`) that ship in all builds.
 *
 * Instance resolution: each tool accepts an optional `instanceId` which
 * matches `WorktreePath`. When omitted, the tool defaults to the only
 * running responding instance and returns a structured error when
 * multiple are running (so the agent picks deliberately).
 *
 * Error envelope: every tool returns either
 *   { content: [{ type: 'text', text: <success body or stringified data> }] }
 * or
 *   { content: [{ type: 'text', text: '...' }], isError: true }
 * The error text is a JSON-encoded `{ kind, detail }` shape so callers
 * can program against it.
 */

const DEFAULT_TIMEOUT_MS = 5000;

interface CallBridgeOptions {
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  instanceId?: string;
  timeoutMs?: number;
}

/**
 * Per-call timing breakdown attached to every callBridge response. Helps
 * pinpoint where MCP latency is going without per-tool instrumentation:
 *   - resolveMs:       lockfile read + alive-pid check + responding-instance probe (only when instanceId omitted)
 *   - bridgeRoundTripMs: time-on-the-wire from request-end to response-end (HTTP + server-side handler)
 *   - parseMs:         JSON.parse on the response body
 *   - totalMs:         resolveMs + bridgeRoundTripMs + parseMs (wall clock observed by the MCP layer)
 */
interface CallTiming {
  resolveMs: number;
  bridgeRoundTripMs: number;
  parseMs: number;
  totalMs: number;
}

interface BridgeSuccess {
  ok: true;
  data: unknown;
  _timing?: CallTiming;
}

interface BridgeFailure {
  ok: false;
  error: { kind: string; detail: string };
  _timing?: CallTiming;
}

type BridgeResult = BridgeSuccess | BridgeFailure;

/**
 * Resolve a preview instance by its `worktreePath` (the stable id).
 * When `instanceId` is omitted, picks the unique responding instance
 * and errors when there are 0 or >1.
 */
async function resolveInstance(
  instanceId: string | undefined,
): Promise<{ port: number } | BridgeFailure> {
  if (instanceId) {
    const lockfile = readLockfile(instanceId);
    if (!lockfile) {
      return {
        ok: false,
        error: {
          kind: 'no-lockfile',
          detail: `No preview lockfile found at ${instanceId}/.kangentic/preview.lock.`,
        },
      };
    }
    if (!isLockfilePidAlive(lockfile)) {
      return {
        ok: false,
        error: {
          kind: 'stale-lockfile',
          detail: `Lockfile at ${instanceId} references PID ${lockfile.pid} which is no longer running.`,
        },
      };
    }
    return { port: lockfile.port };
  }

  const instances = await enumeratePreviewInstances();
  const responding = instances.filter((entry) => entry.lockfileStatus === 'responding');
  if (responding.length === 0) {
    return {
      ok: false,
      error: {
        kind: 'no-instance',
        detail: 'No responding preview instance. Make sure a kangentic dev session is running and `developer.previewInspectionServer` is on.',
      },
    };
  }
  if (responding.length > 1) {
    return {
      ok: false,
      error: {
        kind: 'multiple-instances',
        detail: `${responding.length} responding instances found. Pass instanceId (worktreePath) to disambiguate. Candidates: ${responding
          .map((entry: PreviewInstanceRecord) => entry.path)
          .join(', ')}.`,
      },
    };
  }
  return { port: responding[0].lockfile!.port };
}

async function callBridge(options: CallBridgeOptions): Promise<BridgeResult> {
  const callStart = performance.now();
  const resolved = await resolveInstance(options.instanceId);
  const resolveMs = performance.now() - callStart;
  if ('ok' in resolved && resolved.ok === false) {
    return {
      ...resolved,
      _timing: {
        resolveMs,
        bridgeRoundTripMs: 0,
        parseMs: 0,
        totalMs: resolveMs,
      },
    };
  }
  const port = (resolved as { port: number }).port;
  const queryString = options.query
    ? '?' +
      new URLSearchParams(
        Object.fromEntries(
          Object.entries(options.query)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, String(value)]),
        ),
      ).toString()
    : '';
  const body = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const httpStart = performance.now();

  return new Promise((resolve) => {
    const finalize = (result: BridgeResult, parseMs: number): void => {
      const bridgeRoundTripMs = performance.now() - httpStart - parseMs;
      const totalMs = performance.now() - callStart;
      resolve({
        ...result,
        _timing: {
          resolveMs,
          bridgeRoundTripMs,
          parseMs,
          totalMs,
        },
      });
    };
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `${options.path}${queryString}`,
        method: options.method,
        timeout: timeoutMs,
        headers: body
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const parseStart = performance.now();
          let parsed: unknown;
          try {
            parsed = raw.trim() ? JSON.parse(raw) : null;
          } catch {
            parsed = raw;
          }
          const parseMs = performance.now() - parseStart;
          if (response.statusCode && response.statusCode >= 400) {
            const detail =
              parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
                ? String((parsed as { error: { detail?: string } }).error?.detail ?? raw)
                : raw;
            finalize(
              {
                ok: false,
                error: {
                  kind:
                    parsed && typeof parsed === 'object' && parsed !== null && 'error' in parsed
                      ? String(
                          (parsed as { error: { kind?: string } }).error?.kind ?? `http-${response.statusCode}`,
                        )
                      : `http-${response.statusCode}`,
                  detail,
                },
              },
              parseMs,
            );
            return;
          }
          finalize({ ok: true, data: parsed }, parseMs);
        });
        response.on('error', (error) => {
          finalize({ ok: false, error: { kind: 'response-error', detail: error.message } }, 0);
        });
      },
    );
    request.on('error', (error) => {
      finalize({ ok: false, error: { kind: 'request-error', detail: error.message } }, 0);
    });
    request.on('timeout', () => {
      request.destroy();
      finalize(
        {
          ok: false,
          error: { kind: 'timeout', detail: `No response within ${timeoutMs}ms.` },
        },
        0,
      );
    });
    if (body) request.write(body);
    request.end();
  });
}

type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string };

interface McpToolResult {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
  [extraKey: string]: unknown;
}

function toolResult(result: BridgeResult): McpToolResult {
  if (result.ok) {
    const text = typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
    const structured = toStructuredContent(result.data);
    const merged: Record<string, unknown> = structured ? { ...structured } : {};
    if (result._timing) merged._timing = result._timing;
    const hasStructured = structured !== null || result._timing !== undefined;
    return hasStructured
      ? { content: [{ type: 'text', text }], structuredContent: merged }
      : { content: [{ type: 'text', text }] };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(result.error, null, 2) }],
    structuredContent: { error: result.error, ...(result._timing ? { _timing: result._timing } : {}) },
    isError: true,
  };
}

interface BridgeScreenshotResponse {
  mode: 'inline' | 'file';
  format: 'png' | 'jpeg';
  base64?: string;
  filePath?: string;
  fileUri?: string;
  byteLength: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  deviceScaleFactor: number;
  scale: number;
  fullPage: boolean;
  elementClip: { selector: string; box: unknown } | null;
  retries: number;
  reason?: 'over-inline-ceiling' | 'over-max-bytes';
}

/**
 * Screenshot-specific result shape. Returns a proper MCP image content
 * block (inline) or resource_link (file) instead of stringifying the
 * base64 into a text block. Without this, screenshots count against
 * the agent's text token budget and trip Claude Code's "saved to file"
 * fallback for what should be a cheap inline image.
 */
function screenshotToolResult(result: BridgeResult): McpToolResult {
  if (!result.ok) return toolResult(result);
  const data = result.data as BridgeScreenshotResponse;
  const mimeType = data.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const meta: Record<string, unknown> = {
    format: data.format,
    byteLength: data.byteLength,
    width: data.width,
    height: data.height,
    viewportWidth: data.viewportWidth,
    viewportHeight: data.viewportHeight,
    deviceScaleFactor: data.deviceScaleFactor,
    scale: data.scale,
    fullPage: data.fullPage,
    elementClip: data.elementClip,
    retries: data.retries,
  };
  if (result._timing) meta._timing = result._timing;
  if (data.mode === 'file') {
    meta.mode = 'file';
    meta.filePath = data.filePath;
    meta.fileUri = data.fileUri;
    meta.reason = data.reason;
    const summary = `Screenshot persisted to ${data.filePath} (${formatBytes(data.byteLength)}, ${data.width}x${data.height}, ${data.format}). Reason: ${data.reason ?? 'over-inline-ceiling'}. Use Read to view.`;
    const filename = data.filePath ? data.filePath.split(/[\\/]/).pop() : null;
    return {
      content: [
        {
          type: 'resource_link',
          uri: data.fileUri ?? '',
          mimeType,
          name: filename || 'screenshot',
          description: summary,
        },
        { type: 'text', text: JSON.stringify(meta, null, 2) },
      ],
      structuredContent: meta,
    };
  }
  meta.mode = 'inline';
  return {
    content: [
      { type: 'image', data: data.base64 ?? '', mimeType },
      { type: 'text', text: JSON.stringify(meta, null, 2) },
    ],
    structuredContent: meta,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * MCP `structuredContent` is required to be an object (`{ [key: string]: unknown }`).
 * Wrap arrays under `items` so the LLM still gets typed JSON access; pass plain
 * objects through; skip primitives (text-only response is sufficient there).
 */
function toStructuredContent(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) return { items: data };
  if (typeof data !== 'object') return null;
  return data as Record<string, unknown>;
}

/**
 * Standard annotations applied to read-only inspection tools. The LLM treats
 * tools with `readOnlyHint: true` and `idempotentHint: true` as safe to call
 * speculatively (e.g. parallel reads, retries) without worrying about side
 * effects.
 */
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
} as const;

/**
 * Annotations for tools that mutate UI / session / engine state. `readOnlyHint:
 * false` signals "this changes something visible"; `idempotentHint: false`
 * signals "calling twice is not the same as calling once" (e.g. clicking a
 * button advances state).
 */
const MUTATING_ANNOTATIONS = {
  readOnlyHint: false,
  idempotentHint: false,
} as const;

const INSTANCE_ARG_DESCRIPTION =
  'Optional instanceId - the absolute worktree path identifying the preview to target. Omit to use the single running instance; the call errors if more than one is running. Use kangentic_devtools_list_instances to discover instanceIds.';

export function registerDevtoolsPreviewTools(server: McpServer): void {
  // ── Discovery ────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_list_instances',
    {
      description:
        'Enumerate every kangentic worktree on this machine and report whether a /preview is currently bound to each. Each entry has worktree path, branch, dirty flag, lockfile presence, and lockfileStatus (responding | stale | absent). Use the worktree path as `instanceId` for any other devtools tool. Dev-only.',
      inputSchema: z.object({}),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const instances = await enumeratePreviewInstances();
        return {
          content: [{ type: 'text', text: JSON.stringify(instances, null, 2) }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  kind: 'enumerate-failed',
                  detail: error instanceof Error ? error.message : String(error),
                },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  // ── State ────────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_engine_state',
    {
      description:
        'Live ActivityStatsSnapshot for one or every running session in the inspected preview. Returns the in-memory engine state (counters, dominant reason, recent transitions) - strictly fresher than the disk dump. Dev-only.',
      inputSchema: z.object({
        sessionId: z.string().optional().describe('Limit to one session. Omit for all sessions.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/engine-state',
          query: { sessionId },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_renderer_state',
    {
      description:
        'Aggregated Zustand snapshot for the inspected preview: board, session, project, config, backlog, toast, transient, scroll, focus, plus ring buffers (recentToasts, dialogHistory, recentIpcErrors). Useful for "what does the renderer currently think is true". Dev-only.',
      inputSchema: z.object({
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ instanceId }) =>
      toolResult(await callBridge({ method: 'GET', path: '/renderer-state', instanceId })),
  );

  server.registerTool(
    'kangentic_devtools_store_state',
    {
      description:
        'Read a single renderer Zustand store by name, optionally drilling into a dot/bracket `path` (e.g. "dialogSessionIds[0]", "boardConfig.columns[0]", "sessionActivity[\'<id>\']"). Returns the sanitized state (Map -> object, Set -> array, large arrays + deep nesting truncated). Unlike kangentic_devtools_renderer_state (a fixed summary), this reads the FULL source-of-truth state for any registered store. Registered stores: backlog, board, config, project, session, toast. Unknown store names return an error plus the available list. Dev-only.',
      inputSchema: z.object({
        store: z
          .string()
          .describe('Store name: backlog | board | config | project | session | toast.'),
        path: z
          .string()
          .optional()
          .describe('Optional dot/bracket path into the store state. Omit to return the whole store.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ store, path, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/store-state',
          query: { store, path },
          instanceId,
        }),
      ),
  );

  // ── Performance diagnostics ──────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_event_loop_lag',
    {
      description:
        'Freeze flight recorder: event-loop lag for the MAIN process AND the RENDERER of the inspected instance. Each report carries the recorded recent stalls (UTC timestamp + duration ms), the worst stall, and the spike count, so a freeze is diagnosed RETROACTIVELY - call this AFTER a user reports lag/freezing to see exactly when and for how long each thread blocked, without having been probing at that instant. The renderer report also carries `recentLongFrames`, which answers WHAT ran rather than only when: each long animation frame lists its heaviest scripts with the source URL and function name that registered them, plus `forcedLayoutMs` (read/write thrash) and a `styleLayoutMs` vs script-time split that says whether the cost was JS, style/layout, or forced reflow. Long frames and lag spikes share a wall-clock stamp, so they line up by timestamp. The main report is always present; the renderer report needs an attached debugger (it reports `unavailable` otherwise), and `recentLongFrames` is `unavailable` where the runtime lacks the long-animation-frame entry type. Dev-only.',
      inputSchema: z.object({
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ instanceId }) =>
      toolResult(await callBridge({ method: 'GET', path: '/event-loop-lag', instanceId })),
  );

  server.registerTool(
    'kangentic_devtools_pty_pipeline',
    {
      description:
        'Per-session terminal output-pipeline stats for the inspected instance: pending (un-flushed) buffer size, scrollback size, backpressure state (paused + bytes in flight to the renderer), and whether each session is focused (emitting to the renderer). Diagnoses terminal-driven lag - a paused session with high in-flight bytes, or a ballooning pending buffer, is a flooding agent throttling the renderer. Pair with kangentic_devtools_event_loop_lag when a freeze coincides with heavy agent output. Dev-only.',
      inputSchema: z.object({
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ instanceId }) =>
      toolResult(await callBridge({ method: 'GET', path: '/pty-pipeline', instanceId })),
  );

  server.registerTool(
    'kangentic_devtools_terminal_state',
    {
      description:
        'Every layer\'s view of each live terminal, joined: the PTY grid main holds (ptyCols/ptyRows, the width the buffered bytes were DRAWN at, plus any stashed/desktop dimensions and whether a post-resize repaint is outstanding), each mounted xterm\'s grid and container geometry (cols/rows, host, viewport clientWidth vs offsetWidth, rendered screen size, wrapped-line count) and which surface hosts it, plus the derived invariants ptyMatchesGrid / colsDrift / gridOverflowPx. Use for any terminal that looks mis-sized, clipped, wrapped, blank, or frozen: a PTY whose width has drifted from the grid showing it cannot self-correct (xterm re-sends dimensions only when its OWN size changes), and that gap is invisible from either process alone. Also reports sessions main knows about that no xterm is mounted for, and the pty-pipeline backpressure stats. Dev-only.',
      inputSchema: z.object({
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ instanceId }) =>
      toolResult(await callBridge({ method: 'GET', path: '/terminal-state', instanceId })),
  );

  server.registerTool(
    'kangentic_devtools_terminal_forensics',
    {
      description:
        'Row-by-row forensics for ONE session, joining the three layers that can disagree: the renderer\'s xterm viewport (per-row text, cursor, alt-screen flag, DECSTBM margins), main\'s parsed grid (its own headless frame re-parsed to rows), and the tail of the raw PTY byte ring with control bytes escaped. Use when rows are MISSING or blank rather than mis-sized - kangentic_devtools_terminal_state reports how many rows have content, this reports which. Reading it: text absent from the raw tail means the agent never sent it (upstream); present in the raw tail and main\'s grid but not the renderer\'s means it was lost in the IPC/queue/write path; present in both grids means the data is fine and the fault is paint, which a same-instant kangentic_devtools_screenshot_element on .xterm-screen confirms. Caveat: main\'s grid comes from a bare serialize with no tail fold, so a capture taken MID-STREAM can trail the renderer by a frame - capture while the TUI is idle. Dev-only.',
      inputSchema: z.object({
        sessionId: z.string().describe('Session to dump. Get one from kangentic_devtools_terminal_state.'),
        rawTailBytes: z.number().int().min(1).max(262144).optional().describe('Raw ring tail to return, in bytes before escaping. Default 49152.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sessionId, rawTailBytes, instanceId }) =>
      toolResult(await callBridge({
        method: 'GET',
        path: '/terminal-forensics',
        query: { sessionId, rawTailBytes },
        instanceId,
      })),
  );

  // ── Visual / DOM ─────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_screenshot',
    {
      description:
        'Capture the inspected preview window. Returns an MCP image content block inline (under ~3.5MB) or a resource_link to a file when the capture exceeds the inline ceiling. The response also carries metadata: viewport dims, image dims, deviceScaleFactor (so image-space coords can be mapped to viewport-space). Defaults: jpeg q80 (q75 for fullPage); pass `format: "png"` for lossless. For specific components prefer kangentic_devtools_screenshot_element to clip down before capture. Dev-only.',
      inputSchema: z.object({
        format: z.enum(['png', 'jpeg']).optional().describe('Image format. Default jpeg.'),
        quality: z.number().int().min(1).max(100).optional().describe('JPEG quality 1-100. Ignored for PNG. Default 80 (75 fullPage).'),
        fullPage: z.boolean().optional().describe('Capture beyond the viewport. Default false.'),
        maxBytes: z.number().int().positive().optional().describe('Decoded byte budget. The server retries with lower quality / scale to fit, then falls back to a file when it cannot. Bounded by the 3.5MB inline ceiling.'),
        maxKb: z.number().int().positive().optional().describe('Convenience alias for maxBytes expressed in KB.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ format, quality, fullPage, maxBytes, maxKb, instanceId }) =>
      screenshotToolResult(
        await callBridge({
          method: 'GET',
          path: '/screenshot',
          query: {
            format,
            quality,
            fullPage: fullPage ? 'true' : undefined,
            maxBytes,
            maxKb,
          },
          instanceId,
          timeoutMs: 10000,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_screenshot_element',
    {
      description:
        'Capture only the element matching `selector`, clipped to its bounding box. Returns a PNG inline (default; small clips stay well under the inline ceiling) or a resource_link to a file when the capture is unusually large. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector. Defaults to clipping the matched element\'s box.'),
        format: z.enum(['png', 'jpeg']).optional().describe('Image format. Default png (element clips usually fit losslessly).'),
        quality: z.number().int().min(1).max(100).optional().describe('JPEG quality 1-100. Ignored for PNG.'),
        maxBytes: z.number().int().positive().optional().describe('Decoded byte budget; the server fits to size or falls back to a file.'),
        maxKb: z.number().int().positive().optional().describe('Convenience alias for maxBytes expressed in KB.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, format, quality, maxBytes, maxKb, instanceId }) =>
      screenshotToolResult(
        await callBridge({
          method: 'GET',
          path: '/screenshot-element',
          query: { selector, format, quality, maxBytes, maxKb },
          instanceId,
          timeoutMs: 10000,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_query_dom',
    {
      description:
        'Return the outer HTML of the first element matching `selector`. Useful to verify what is rendered: check whether a dialog opened, a button is enabled, an error banner is showing. Selector forms: standard CSS, or `text="Cancel"` (exact text), `text*="Cancel"` (substring), `aria="Cancel"` (accessible name) - the same forms work on every selector-taking tool. Pass `includeBox: true` to also get the {x,y,width,height} bounding box in one call. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector, or `text="..."` / `text*="..."` / `aria="..."`.'),
        includeBox: z.boolean().optional().describe('Include {x,y,width,height} bounding box in the response. Default false.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, includeBox, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/dom',
          query: { selector, includeBox: includeBox ? 'true' : undefined },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_query_all',
    {
      description:
        'Like kangentic_devtools_query_dom but returns EVERY element matching `selector`, each with its tag, attributes, and viewport-space box {x,y,width,height,top,right,bottom,left}. Use to measure N elements in one call (e.g. two docked window frames) instead of fragile :nth-child selectors. Set `includeHtml: true` to also get each element\'s outerHTML (clipped per element). `box` is getBoundingClientRect-based (viewport CSS px) - for the raw CDP box-model quads of a single element use kangentic_devtools_bounding_box. Selector forms: CSS, `text="..."`, `text*="..."`, `aria="..."`. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector, or `text="..."` / `text*="..."` / `aria="..."`.'),
        includeHtml: z.boolean().optional().describe('Include each element\'s (clipped) outerHTML. Default false.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max elements returned. Default 100.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, includeHtml, limit, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/query-all',
          query: { selector, includeHtml: includeHtml ? 'true' : undefined, limit },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_computed_style',
    {
      description:
        'Return the full computed CSS style for the first element matching `selector`. Useful for "is this rendered but invisible?" debugging. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/computed-style',
          query: { selector },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_bounding_box',
    {
      description:
        'Return the layout box (content / padding / border / margin quads + width / height) of the first element matching `selector`. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/bounding-box',
          query: { selector },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_bounding_box_all',
    {
      description:
        'Return the viewport-space box {x,y,width,height,top,right,bottom,left} and tag for EVERY element matching `selector`. The lean multi-element measurement tool (no attributes, no HTML). Use kangentic_devtools_query_all when you also need attributes/HTML, or kangentic_devtools_bounding_box for one element\'s raw CDP box-model quads. Selector forms: CSS, `text="..."`, `text*="..."`, `aria="..."`. Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector, or `text="..."` / `text*="..."` / `aria="..."`.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max elements returned. Default 100.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, limit, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/bounding-box-all',
          query: { selector, limit },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_accessibility_tree',
    {
      description:
        'Return the full accessibility tree for the inspected preview window. Semantic structure (roles + names + values) - much smaller and easier to reason about than the raw DOM. Dev-only.',
      inputSchema: z.object({
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ instanceId }) =>
      toolResult(
        await callBridge({ method: 'GET', path: '/accessibility-tree', instanceId, timeoutMs: 10000 }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_mutations',
    {
      description:
        'Return DOM mutations recorded in the last `sinceMs` milliseconds. Each mutation reports target (selector), kind (childList | attributes | characterData), counts of added / removed nodes. Useful for "what changed when I clicked X?". Dev-only.',
      inputSchema: z.object({
        sinceMs: z.number().int().positive().max(60000).optional().describe('Window in ms. Default 5000.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ sinceMs, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/mutations',
          query: { sinceMs },
          instanceId,
        }),
      ),
  );

  // ── React inspection ─────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_react_query',
    {
      description:
        'Find the nearest React component to the DOM element matching `selector`, return its name, source `file:line:column` (where available), props (sanitized), hook values, and ancestor chain. Useful for "why is this component rendering wrong props?". Dev-only.',
      inputSchema: z.object({
        selector: z.string().describe('CSS selector for the DOM node to start the fiber walk from.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/react-component',
          query: { selector },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_react_tree',
    {
      description:
        'Return a names-only tree of React components rooted at `rootSelector`. Useful for spotting "which component is mounted where". Dev-only.',
      inputSchema: z.object({
        rootSelector: z.string().optional().describe('CSS selector for the root. Default body.'),
        maxDepth: z.number().int().min(1).max(20).optional().describe('Recursion depth. Default 6.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ rootSelector, maxDepth, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/react-tree',
          query: { rootSelector, maxDepth },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_react_recent_renders',
    {
      description:
        'Return the most recent React commits captured by onCommitFiberRoot. Each entry has timestamp, root component name, source file (when available), and render duration. Useful for "what re-rendered when I did X?". Dev-only.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe('Max entries. Default 50.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ limit, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/react-recent-renders',
          query: { limit },
          instanceId,
        }),
      ),
  );

  // ── Console (CDP ring, separate from product log mirror) ──────────
  server.registerTool(
    'kangentic_devtools_console',
    {
      description:
        'Read the last N renderer Console messages captured by the CDP `Console.messageAdded` event. Separate from `kangentic_tail_logs` which reads the persistent product log file: the CDP ring is in-memory, lossy, and includes browser-emitted console messages that may not flow through console.*. Dev-only.',
      inputSchema: z.object({
        since: z.string().optional().describe('Filter to entries with ts >= since (ISO 8601).'),
        level: z
          .enum(['log', 'warn', 'error', 'info', 'debug', 'verbose', 'all'])
          .optional()
          .describe('Filter by level. Default all.'),
        limit: z.number().int().positive().max(500).optional().describe('Max entries. Default 100.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ since, level, limit, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'GET',
          path: '/console',
          query: { since, level, limit },
          instanceId,
        }),
      ),
  );

  // ── Drive (interaction) ──────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_click',
    {
      description:
        'Dispatch a real mouse click. Either pass `selector` to click the centroid of the matched element, or pass `x` and `y` for absolute coordinates. When picking coords from a screenshot, set `coordSpace: "image"` so the server divides by deviceScaleFactor before dispatching - skips the coord-scaling math the agent would otherwise have to do. For multi-step sequences, prefer kangentic_devtools_script - it cuts MCP overhead by ~10x. Dev-only.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector to click.'),
        x: z.number().optional().describe('X coordinate (alternative to selector). See coordSpace.'),
        y: z.number().optional().describe('Y coordinate. See coordSpace.'),
        coordSpace: z
          .enum(['viewport', 'image'])
          .optional()
          .describe('Coordinate space for x/y. "viewport" (default) is CSS pixels matching window.innerWidth. "image" is screenshot pixels - server divides by deviceScaleFactor.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ selector, x, y, coordSpace, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/click',
          body: { selector, x, y, coordSpace },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_type',
    {
      description:
        'Type text into the focused field. Pass `selector` to focus + click first (CSS, `text="..."`, or `aria="..."`); pass `clearFirst: true` to Ctrl+A then Backspace before typing. Use kangentic_devtools_keypress for chord shortcuts. For multi-step sequences, prefer kangentic_devtools_script - it cuts MCP overhead by ~10x. Dev-only.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector to focus before typing.'),
        text: z.string().describe('Literal text to type.'),
        clearFirst: z.boolean().optional().describe('Clear the field before typing. Default false.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ selector, text, clearFirst, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/type',
          body: { selector, text, clearFirst },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_keypress',
    {
      description:
        'Dispatch a keyboard chord like `Ctrl+Shift+P`, `Escape`, `Enter`, `Tab`, `ArrowUp`, etc. Modifiers: Ctrl, Shift, Alt, Meta (alias Cmd). Single-character keys like `a` work. For multi-step sequences, prefer kangentic_devtools_script - it cuts MCP overhead by ~10x. Dev-only.',
      inputSchema: z.object({
        keys: z.string().describe('Key combo (e.g. "Ctrl+Shift+P", "Escape").'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ keys, instanceId }) =>
      toolResult(
        await callBridge({ method: 'POST', path: '/keypress', body: { keys }, instanceId }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_drag',
    {
      description:
        'Simulate a drag: press at the centroid of `fromSelector`, smooth-move through `steps` intermediate positions to the centroid of `toSelector`, release. Selectors accept CSS, `text="..."`, or `aria="..."`. Use this to drag tasks between columns or reorder items. For multi-step sequences, prefer kangentic_devtools_script - it cuts MCP overhead by ~10x. Dev-only.',
      inputSchema: z.object({
        fromSelector: z.string().describe('CSS selector of the element to drag from.'),
        toSelector: z.string().describe('CSS selector of the drop target.'),
        steps: z.number().int().min(2).max(50).optional().describe('Number of intermediate mouseMove events. Default 10.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ fromSelector, toSelector, steps, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/drag',
          body: { fromSelector, toSelector, steps },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_wait',
    {
      description:
        'Block until a selector resolves, contains `domText`, or the timeout elapses. Replaces "click then poll DOM 5 times" round-trips with one server-side wait. Selector accepts CSS, `text="..."`, or `aria="..."`. For multi-step sequences, prefer kangentic_devtools_script - it cuts MCP overhead by ~10x. Dev-only.',
      inputSchema: z.object({
        selector: z.string().optional().describe('CSS selector that must resolve.'),
        domText: z.string().optional().describe('Substring that must appear in the DOM (or in selector, when both are given).'),
        timeoutMs: z.number().int().positive().max(60000).optional().describe('Hard timeout. Default 30000.'),
        intervalMs: z.number().int().min(50).max(1000).optional().describe('Polling cadence. Default 100.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async ({ selector, domText, timeoutMs, intervalMs, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/wait',
          body: { selector, domText, timeoutMs, intervalMs },
          instanceId,
          timeoutMs: (timeoutMs ?? 30000) + 1000,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_script',
    {
      description:
        'Execute an array of UI steps in order against the inspected preview. Each step: { type: "click" | "type" | "keypress" | "drag" | "wait" | "screenshot" | "eval", ...stepArgs }. Returns a step-by-step trace with ok/durationMs/error. `screenshot` steps persist to disk and the trace entry carries `screenshotPath` + `screenshotUri` (read via Read). `eval` steps carry the serialized return value as `value` on their trace entry (requires Settings -> Developer -> Allow Unsafe Operations). Selectors accept CSS, `text="..."`, or `aria="..."`. Cuts MCP latency dramatically vs. one tool call per step. Dev-only.',
      inputSchema: z.object({
        steps: z
          .array(
            z.object({
              type: z.enum(['click', 'type', 'keypress', 'drag', 'wait', 'screenshot', 'eval']),
              selector: z.string().optional(),
              text: z.string().optional(),
              keys: z.string().optional(),
              fromSelector: z.string().optional(),
              toSelector: z.string().optional(),
              ms: z.number().int().positive().optional(),
              expression: z.string().optional(),
            }),
          )
          .describe('Ordered step list.'),
        abortOnError: z.boolean().optional().describe('Stop on the first failed step. Default true.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ steps, abortOnError, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/script',
          body: { steps, abortOnError },
          instanceId,
          timeoutMs: 60000,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_eval',
    {
      description:
        'Evaluate a JavaScript expression in the inspected preview\'s renderer and return its serialized value (e.g. `{ value: 2 }` for "1 + 1", or an array of element measurements). The return value must be JSON-serializable - DOM nodes and functions do not round-trip; return their measured/string form instead. Requires Settings -> Developer -> Allow Unsafe Operations (returns an `eval-disabled` error otherwise). That toggle is NOT the same as Settings -> Agent Browser -> Allow Eval, which gates kangentic_browser_eval in a task\'s Browser pane. For reading store state prefer kangentic_devtools_store_state; for multi-element measurement prefer kangentic_devtools_query_all - both work without it. Dev-only.',
      inputSchema: z.object({
        expression: z.string().describe('JavaScript expression to evaluate. Its value is returned (awaited if a Promise).'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ expression, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/eval',
          body: { expression },
          instanceId,
        }),
      ),
  );

  // ── Cross-instance command proxy ─────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_run_command',
    {
      description:
        'Run a product MCP command (the same handlers used by kangentic_create_task, kangentic_list_tasks, etc.) inside a specific preview instance. Use this when an ephemeral worktree preview is running and you want to operate on its task list - the preview has its own data directory the outer agent\'s MCP server cannot see, so passing `instanceId` here is the bridge. `command` accepts handler names like "create_task", "list_tasks", "list_columns", "move_task", "list_projects". `params` is the raw params shape the handler expects (matches the kangentic_<command> tool inputs minus the `project` arg). Dev-only.',
      inputSchema: z.object({
        command: z.string().describe('Command name (e.g. "create_task", "list_tasks", "list_columns", "list_projects").'),
        params: z.record(z.string(), z.unknown()).optional().describe('Params object the handler expects.'),
        projectId: z.string().optional().describe('Optional project UUID to target inside the preview. Defaults to the preview\'s currently open project.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ command, params, projectId, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/command',
          body: { command, params, projectId },
          instanceId,
          timeoutMs: 30000,
        }),
      ),
  );

  // ── Sessions ─────────────────────────────────────────────────────────
  server.registerTool(
    'kangentic_devtools_pty_input',
    {
      description:
        'Send input to a session\'s PTY. `keys` accepts named-key vocabulary (Enter, Escape, Tab, Backspace, Ctrl+C, Ctrl+D, Up, Down, Left, Right) plus literal text. `bytes` (base64) requires `developer.previewEvalEnabled` and writes raw bytes verbatim. Use for typing into the Claude TUI inside a session. Dev-only.',
      inputSchema: z.object({
        sessionId: z.string().describe('Kangentic session id (UUID).'),
        keys: z.string().optional().describe('Named key or literal text (XOR with bytes).'),
        bytes: z.string().optional().describe('Base64-encoded raw bytes. Requires Settings -> Developer -> Allow Unsafe Operations.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, keys, bytes, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/pty-input',
          body: { sessionId, keys, bytes },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_inject_session_event',
    {
      description:
        'Synthesize a SessionEvent and feed it into the activity engine without spawning a real CLI. Use for stress-testing engine state machines (Idle / Interrupted / TurnEnd) without orchestrating a full session. Requires `developer.previewEvalEnabled`. Dev-only.',
      inputSchema: z.object({
        sessionId: z.string().describe('Kangentic session id to target.'),
        event: z.unknown().describe('SessionEvent shape (see src/shared/types.ts).'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, event, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/inject-session-event',
          body: { sessionId, event },
          instanceId,
        }),
      ),
  );

  server.registerTool(
    'kangentic_devtools_capture_trace',
    {
      description:
        'Bundle a session\'s passively-recorded input stream (events.jsonl + status-deltas.jsonl + pty-chunks.jsonl) plus the engine\'s current recent-transitions ring into .kangentic/traces/<ts>-<sessionId>/. The resulting directory can be copied into tests/fixtures/replay/ to pin engine behavior. Requires the session\'s recorder taps to have been active during the run (always-on in dev builds). Returns the absolute trace directory path. Dev-only.',
      inputSchema: z.object({
        sessionId: z.string().describe('Kangentic session id to capture.'),
        instanceId: z.string().optional().describe(INSTANCE_ARG_DESCRIPTION),
      }),
      annotations: MUTATING_ANNOTATIONS,
    },
    async ({ sessionId, instanceId }) =>
      toolResult(
        await callBridge({
          method: 'POST',
          path: '/capture-trace',
          body: { sessionId },
          instanceId,
        }),
      ),
  );
}
