import type { DriverResult } from '../../browser/browser-pane-driver';
import type { ScreenshotResponse } from '../../browser/cdp/screenshot';

/**
 * MCP tool-result helpers for the in-process `kangentic_browser_*` family.
 * Maps the driver's `{ ok, data } | { ok: false, error }` envelope to the MCP
 * content-block shape, including proper image / resource_link blocks for
 * screenshots so they don't burn the agent's text token budget.
 */

type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; description?: string };

export interface McpToolResult {
  content: McpContentBlock[];
  structuredContent?: Record<string, unknown>;
  isError?: true;
  [extraKey: string]: unknown;
}

/** MCP `structuredContent` must be an object; wrap arrays, drop primitives. */
function toStructuredContent(data: unknown): Record<string, unknown> | null {
  if (data === null || data === undefined) return null;
  if (Array.isArray(data)) return { items: data };
  if (typeof data !== 'object') return null;
  return data as Record<string, unknown>;
}

export function errorToolResult(error: { kind: string; detail: string }): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(error, null, 2) }],
    structuredContent: { error },
    isError: true,
  };
}

/** Generic success/error mapper for non-screenshot tools. */
export function driverToolResult(result: DriverResult<unknown>): McpToolResult {
  if (!result.ok) return errorToolResult(result.error);
  const text =
    typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2);
  const structured = toStructuredContent(result.data);
  return structured
    ? { content: [{ type: 'text', text }], structuredContent: structured }
    : { content: [{ type: 'text', text }] };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/**
 * Screenshot result: a real MCP image block (inline) or a resource_link
 * (persisted file) plus a metadata text block.
 */
export function screenshotToolResult(result: DriverResult<ScreenshotResponse>): McpToolResult {
  if (!result.ok) return errorToolResult(result.error);
  const data = result.data;
  const mimeType = data.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const meta: Record<string, unknown> = {
    mode: data.mode,
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
  if (data.mode === 'file') {
    meta.filePath = data.filePath;
    meta.fileUri = data.fileUri;
    meta.reason = data.reason;
    const summary = `Screenshot persisted to ${data.filePath} (${formatBytes(data.byteLength)}, ${data.width}x${data.height}, ${data.format}). Use Read to view.`;
    const filename = data.filePath.split(/[\\/]/).pop() || 'screenshot';
    return {
      content: [
        { type: 'resource_link', uri: data.fileUri, mimeType, name: filename, description: summary },
        { type: 'text', text: JSON.stringify(meta, null, 2) },
      ],
      structuredContent: meta,
    };
  }
  return {
    content: [
      { type: 'image', data: data.base64, mimeType },
      { type: 'text', text: JSON.stringify(meta, null, 2) },
    ],
    structuredContent: meta,
  };
}
