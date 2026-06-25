/**
 * Unit tests for the MCP tool-result mappers in
 * src/main/agent/mcp-http/tool-result.ts.
 *
 * Pins four load-bearing behaviours:
 *   (a) errorToolResult: isError === true + text content block
 *   (b) screenshotToolResult inline: image content block with correct mimeType
 *   (c) screenshotToolResult file: resource_link (not image) + text metadata
 *   (d) driverToolResult ok:false: delegates to error shape (isError true)
 *
 * No Electron mocks needed: tool-result.ts imports DriverResult and
 * ScreenshotResponse as type-only imports, which are erased at runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  errorToolResult,
  driverToolResult,
  screenshotToolResult,
} from '../../src/main/agent/mcp-http/tool-result';
import type { DriverResult } from '../../src/main/browser/browser-pane-driver';
import type {
  InlineScreenshotResponse,
  FileScreenshotResponse,
} from '../../src/main/browser/cdp/screenshot';

// ---------------------------------------------------------------------------
// Minimal fixture values
// ---------------------------------------------------------------------------

const BASE_SCREENSHOT_FIELDS = {
  format: 'jpeg' as const,
  byteLength: 1000,
  width: 800,
  height: 600,
  viewportWidth: 800,
  viewportHeight: 600,
  deviceScaleFactor: 1,
  metricsAvailable: true,
  scale: 1,
  fullPage: false,
  elementClip: null,
  retries: 0,
} satisfies Omit<InlineScreenshotResponse, 'mode' | 'base64'>;

const INLINE_RESPONSE: InlineScreenshotResponse = {
  mode: 'inline',
  base64: 'aGVsbG8=',
  ...BASE_SCREENSHOT_FIELDS,
};

const FILE_RESPONSE: FileScreenshotResponse = {
  mode: 'file',
  filePath: '/mock/shot.jpg',
  fileUri: 'file:///mock/shot.jpg',
  reason: 'over-inline-ceiling',
  ...BASE_SCREENSHOT_FIELDS,
};

// ---------------------------------------------------------------------------
// errorToolResult
// ---------------------------------------------------------------------------

describe('errorToolResult', () => {
  it('sets isError to true', () => {
    const result = errorToolResult({ kind: 'eval-disabled', detail: 'Eval is off' });
    expect(result.isError).toBe(true);
  });

  it('includes exactly one text content block containing the error JSON', () => {
    const error = { kind: 'cdp-attach-failed', detail: 'no CDP' };
    const result = errorToolResult(error);
    expect(result.content).toHaveLength(1);
    const block = result.content[0];
    expect(block.type).toBe('text');
    // The text must include both fields so the agent can see what went wrong.
    // isError:true is load-bearing: dropping it makes the MCP SDK treat the
    // response as a success and the agent never learns the operation failed.
    if (block.type === 'text') {
      const parsed = JSON.parse(block.text) as Record<string, unknown>;
      expect(parsed.kind).toBe('cdp-attach-failed');
      expect(parsed.detail).toBe('no CDP');
    }
  });
});

// ---------------------------------------------------------------------------
// screenshotToolResult
// ---------------------------------------------------------------------------

describe('screenshotToolResult - inline mode', () => {
  it('returns an image content block with the base64 data and correct mimeType', () => {
    const result = screenshotToolResult({ ok: true, data: INLINE_RESPONSE });
    expect(result.isError).toBeUndefined();
    const imageBlock = result.content.find((block) => block.type === 'image');
    expect(imageBlock).toBeDefined();
    if (imageBlock && imageBlock.type === 'image') {
      expect(imageBlock.data).toBe('aGVsbG8=');
      expect(imageBlock.mimeType).toBe('image/jpeg');
    }
  });

  it('also returns a text metadata block alongside the image block', () => {
    const result = screenshotToolResult({ ok: true, data: INLINE_RESPONSE });
    const textBlock = result.content.find((block) => block.type === 'text');
    expect(textBlock).toBeDefined();
  });

  it('has no resource_link block in inline mode', () => {
    const result = screenshotToolResult({ ok: true, data: INLINE_RESPONSE });
    const resourceBlock = result.content.find((block) => block.type === 'resource_link');
    expect(resourceBlock).toBeUndefined();
  });
});

describe('screenshotToolResult - file mode', () => {
  it('returns a resource_link block (not an image block) with the file URI', () => {
    const result = screenshotToolResult({ ok: true, data: FILE_RESPONSE });
    expect(result.isError).toBeUndefined();
    // Must NOT have an image block - the file is too large for inline delivery.
    expect(result.content.find((block) => block.type === 'image')).toBeUndefined();
    const resourceBlock = result.content.find((block) => block.type === 'resource_link');
    expect(resourceBlock).toBeDefined();
    if (resourceBlock && resourceBlock.type === 'resource_link') {
      expect(resourceBlock.uri).toBe('file:///mock/shot.jpg');
      expect(resourceBlock.mimeType).toBe('image/jpeg');
      // Filename derived from the last path segment
      expect(resourceBlock.name).toBe('shot.jpg');
    }
  });

  it('also returns a text metadata block alongside the resource_link', () => {
    const result = screenshotToolResult({ ok: true, data: FILE_RESPONSE });
    expect(result.content.find((block) => block.type === 'text')).toBeDefined();
  });
});

describe('screenshotToolResult - error passthrough', () => {
  it('delegates to the error shape when result.ok is false (isError:true)', () => {
    const failResult: DriverResult<InlineScreenshotResponse> = {
      ok: false,
      error: { kind: 'pane-destroyed', detail: 'The pane was closed' },
    };
    const result = screenshotToolResult(failResult);
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// driverToolResult
// ---------------------------------------------------------------------------

describe('driverToolResult', () => {
  it('ok:false returns isError:true (delegates to errorToolResult)', () => {
    const failResult: DriverResult<unknown> = {
      ok: false,
      error: { kind: 'navigation-disabled', detail: 'Nav is off' },
    };
    const result = driverToolResult(failResult);
    expect(result.isError).toBe(true);
  });

  it('ok:true returns a text content block with no isError flag', () => {
    const successResult: DriverResult<unknown> = {
      ok: true,
      data: { clicked: true },
    };
    const result = driverToolResult(successResult);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe('text');
  });

  it('ok:true with object data includes structuredContent', () => {
    const successResult: DriverResult<unknown> = {
      ok: true,
      data: { selector: '#btn', found: true },
    };
    const result = driverToolResult(successResult);
    expect(result.structuredContent).toEqual({ selector: '#btn', found: true });
  });

  it('ok:true with string data uses it directly as the text block', () => {
    const successResult: DriverResult<unknown> = {
      ok: true,
      data: 'Dom snapshot here',
    };
    const result = driverToolResult(successResult);
    const textBlock = result.content[0];
    if (textBlock.type === 'text') {
      expect(textBlock.text).toBe('Dom snapshot here');
    }
  });
});
