/**
 * Unit tests for logMcpToolArguments and LARGE_DESCRIPTION_WARN_THRESHOLD
 * in src/main/agent/mcp-http/tool-call-logging.ts.
 *
 * Purpose: lock the diagnostic observability logic added for the "labels
 * dropped on a large description" bug (task #229). The function is
 * module-private in mcp-http-server.ts conceptually, but extracted into
 * a focused module so it can be tested without importing the heavy server
 * module graph (@modelcontextprotocol/sdk, all register*Tools modules,
 * devtools/mcp/register).
 *
 * Coverage:
 *   Silent-skip conditions (no console call, no throw):
 *     - parsedBody is null
 *     - parsedBody is a primitive (number, string)
 *     - message is null inside an array
 *     - message.method is not 'tools/call'
 *     - params is missing
 *     - params is not an object (is a string)
 *     - params.name is an unrecognized tool ('kangentic_list_tasks')
 *
 *   Log path (console.log, no warn):
 *     - create_task with small description (length 0) and no labels
 *     - create_task with description exactly 999 chars (below threshold) and no labels
 *     - create_task with large description but WITH labels present
 *     - update_task with large description but WITH labels present
 *     - create_task with no arguments at all (rawArguments missing)
 *     - create_task with rawArguments that is not an object (a string)
 *
 *   Warn path (console.warn, no log):
 *     - create_task with description exactly 1000 chars (at threshold) and no labels
 *     - create_task with description 2048 chars and no labels
 *     - update_task with description 2048 chars and no labels
 *     - message nested inside an array body is still detected
 *
 *   Threshold export:
 *     - LARGE_DESCRIPTION_WARN_THRESHOLD equals 1000
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  logMcpToolArguments,
  createToolArgumentNotices,
  LARGE_DESCRIPTION_WARN_THRESHOLD,
} from '../../src/main/agent/mcp-http/tool-call-logging';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid tools/call message for the given tool name. */
function makeToolCall(
  toolName: string,
  argumentsValue: Record<string, unknown> | string | undefined,
): unknown {
  return {
    method: 'tools/call',
    params: {
      name: toolName,
      ...(argumentsValue !== undefined ? { arguments: argumentsValue } : {}),
    },
  };
}

/** Build a tools/call message with params missing entirely. */
function makeToolCallNoParams(): unknown {
  return { method: 'tools/call' };
}

/** Build a tools/call message where params is a primitive (not an object). */
function makeToolCallStringParams(): unknown {
  return { method: 'tools/call', params: 'not-an-object' };
}

// ---------------------------------------------------------------------------
// Console spy setup
// ---------------------------------------------------------------------------

let warnSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Suppress output during test runs while capturing calls.
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Threshold constant
// ---------------------------------------------------------------------------

describe('LARGE_DESCRIPTION_WARN_THRESHOLD', () => {
  it('is 1000', () => {
    expect(LARGE_DESCRIPTION_WARN_THRESHOLD).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Silent-skip conditions
// ---------------------------------------------------------------------------

describe('logMcpToolArguments - silent skip conditions (no console call, no throw)', () => {
  it('does nothing when parsedBody is null', () => {
    logMcpToolArguments(null);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when parsedBody is a number', () => {
    logMcpToolArguments(42);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when parsedBody is a string', () => {
    logMcpToolArguments('not-json');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when parsedBody is an array containing null', () => {
    logMcpToolArguments([null]);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when parsedBody is an array containing a primitive', () => {
    logMcpToolArguments([42, 'hello']);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when message.method is not tools/call', () => {
    logMcpToolArguments({ method: 'initialize', params: { name: 'kangentic_create_task', arguments: {} } });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when message has no method field', () => {
    logMcpToolArguments({ params: { name: 'kangentic_create_task', arguments: {} } });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when params is missing', () => {
    logMcpToolArguments(makeToolCallNoParams());
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when params is a string (not an object)', () => {
    logMcpToolArguments(makeToolCallStringParams());
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('does nothing when params.name is an unrecognized tool', () => {
    logMcpToolArguments(makeToolCall('kangentic_list_tasks', { description: 'x'.repeat(2000) }));
    expect(warnSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Log path (console.log, no console.warn)
// ---------------------------------------------------------------------------

describe('logMcpToolArguments - log path', () => {
  it('emits console.log for kangentic_create_task with empty description and no labels', () => {
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'Test task', description: '' }));
    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
    const logMessage = logSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('kangentic_create_task');
    expect(logMessage).toContain('hasLabels=false');
    expect(logMessage).toContain('descriptionLength=0');
  });

  it('emits console.log for kangentic_create_task with description exactly 999 chars and no labels', () => {
    // One below threshold - must take the log path, not the warn path.
    const description = 'x'.repeat(999);
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'Almost big', description }));
    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
    const logMessage = logSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('descriptionLength=999');
  });

  it('emits console.log (not warn) for kangentic_create_task with large description when labels ARE present', () => {
    // The decisive edge: large description + labels = log path, not warn.
    const description = 'x'.repeat(2048);
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'Big', description, labels: ['bug'] }));
    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
    const logMessage = logSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('hasLabels=true');
    expect(logMessage).toContain('descriptionLength=2048');
  });

  it('emits console.log (not warn) for kangentic_update_task with large description when labels ARE present', () => {
    const description = 'y'.repeat(1500);
    logMcpToolArguments(makeToolCall('kangentic_update_task', { taskId: 'abc', description, labels: ['feature'] }));
    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
    const logMessage = logSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('kangentic_update_task');
    expect(logMessage).toContain('hasLabels=true');
    expect(logMessage).toContain('descriptionLength=1500');
  });

  it('emits console.log when params.arguments is missing entirely (treated as empty object)', () => {
    // No arguments field at all - hasLabels=false, descriptionLength=0 -> log path
    logMcpToolArguments(makeToolCall('kangentic_create_task', undefined));
    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
    const logMessage = logSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('hasLabels=false');
    expect(logMessage).toContain('descriptionLength=0');
  });

  it('emits console.log when params.arguments is a string (non-object, treated as empty)', () => {
    // Non-object rawArguments falls through to the {} default.
    const message = {
      method: 'tools/call',
      params: { name: 'kangentic_create_task', arguments: 'not-an-object' },
    };
    logMcpToolArguments(message);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).not.toHaveBeenCalled();
    const logMessage = logSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('hasLabels=false');
    expect(logMessage).toContain('descriptionLength=0');
  });

  it('includes the received argument keys in the log message', () => {
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'T', description: 'short', priority: 2 }));
    expect(logSpy).toHaveBeenCalledOnce();
    const logMessage = logSpy.mock.calls[0][0] as string;
    expect(logMessage).toContain('title');
    expect(logMessage).toContain('description');
    expect(logMessage).toContain('priority');
  });
});

// ---------------------------------------------------------------------------
// Warn path (console.warn, no console.log)
// ---------------------------------------------------------------------------

describe('logMcpToolArguments - warn path', () => {
  it('emits console.warn for kangentic_create_task with description exactly 1000 chars and no labels', () => {
    // Exactly at threshold - must take the warn path.
    const description = 'x'.repeat(1000);
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'At threshold', description }));
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0][0] as string;
    expect(warnMessage).toContain('kangentic_create_task');
    expect(warnMessage).toContain("'labels' absent");
    expect(warnMessage).toContain('1000-char description');
  });

  it('emits console.warn for kangentic_create_task with 2048 char description and no labels', () => {
    const description = 'x'.repeat(2048);
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'Big task', description }));
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0][0] as string;
    expect(warnMessage).toContain('kangentic_create_task');
    expect(warnMessage).toContain('2048-char description');
    expect(warnMessage).toContain('kangentic_update_task');
  });

  it('emits console.warn for kangentic_update_task with 2048 char description and no labels', () => {
    const description = 'z'.repeat(2048);
    logMcpToolArguments(makeToolCall('kangentic_update_task', { taskId: 'task-1', description }));
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0][0] as string;
    expect(warnMessage).toContain('kangentic_update_task');
    expect(warnMessage).toContain('2048-char description');
  });

  it('includes the received argument keys in the warn message', () => {
    const description = 'x'.repeat(1500);
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'T', description }));
    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMessage = warnSpy.mock.calls[0][0] as string;
    expect(warnMessage).toContain('title');
    expect(warnMessage).toContain('description');
  });

  it('detects a matching tool call nested inside an array body', () => {
    // Batch request shape: parsedBody is an array of JSON-RPC messages.
    const description = 'x'.repeat(1200);
    const batchBody = [
      { method: 'initialize', params: {} },
      makeToolCall('kangentic_create_task', { title: 'Batch', description }),
    ];
    logMcpToolArguments(batchBody);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(logSpy).not.toHaveBeenCalled();
    const warnMessage = warnSpy.mock.calls[0][0] as string;
    expect(warnMessage).toContain('kangentic_create_task');
    expect(warnMessage).toContain('1200-char description');
  });
});

// ---------------------------------------------------------------------------
// Array body with multiple matching calls
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Notices: the same detection, carried out to the tool layer so the CALLING
// AGENT learns about the drop. The console warn never reached it.
//
// The predicate under test is `labels` ABSENT, never `labels` empty: a caller
// who deliberately sent no labels must get no notice, or agents learn to
// ignore the line. That distinction only survives here, on the raw body -
// downstream, a missing field has already been normalized to null.
// ---------------------------------------------------------------------------

describe('logMcpToolArguments - ToolArgumentNotices', () => {
  it('records the description length for a create whose arguments lack labels', () => {
    const notices = createToolArgumentNotices();
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'Big', description: 'x'.repeat(1500) }), notices);
    expect(notices.labelsAbsentWithLargeDescription).toEqual({ kangentic_create_task: 1500 });
  });

  it('records under the update key for an update', () => {
    const notices = createToolArgumentNotices();
    logMcpToolArguments(makeToolCall('kangentic_update_task', { taskId: 'abc', description: 'y'.repeat(2048) }), notices);
    expect(notices.labelsAbsentWithLargeDescription).toEqual({ kangentic_update_task: 2048 });
  });

  it('records nothing when labels ARE present alongside a large description', () => {
    // The decisive edge: this is a healthy call, and a notice here would be a
    // false positive on every correctly-labelled long create.
    const notices = createToolArgumentNotices();
    logMcpToolArguments(
      makeToolCall('kangentic_create_task', { title: 'Big', description: 'x'.repeat(2048), labels: ['bug'] }),
      notices,
    );
    expect(notices.labelsAbsentWithLargeDescription).toEqual({});
  });

  it('records nothing for an EXPLICITLY EMPTY labels array with a large description', () => {
    // `labels: []` is a caller saying "no labels, deliberately". The key is
    // present, so this must not trip - absent is not the same as empty.
    const notices = createToolArgumentNotices();
    logMcpToolArguments(
      makeToolCall('kangentic_create_task', { title: 'Big', description: 'x'.repeat(2048), labels: [] }),
      notices,
    );
    expect(notices.labelsAbsentWithLargeDescription).toEqual({});
  });

  it('records nothing when the description is below the threshold', () => {
    const notices = createToolArgumentNotices();
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'Small', description: 'x'.repeat(999) }), notices);
    expect(notices.labelsAbsentWithLargeDescription).toEqual({});
  });

  it('records at exactly the threshold', () => {
    const notices = createToolArgumentNotices();
    logMcpToolArguments(
      makeToolCall('kangentic_create_task', { title: 'At threshold', description: 'x'.repeat(LARGE_DESCRIPTION_WARN_THRESHOLD) }),
      notices,
    );
    expect(notices.labelsAbsentWithLargeDescription.kangentic_create_task).toBe(LARGE_DESCRIPTION_WARN_THRESHOLD);
  });

  it('keys per tool so one batch body can carry both a create and an update', () => {
    const notices = createToolArgumentNotices();
    logMcpToolArguments([
      makeToolCall('kangentic_create_task', { title: 'A', description: 'x'.repeat(1100) }),
      makeToolCall('kangentic_update_task', { taskId: 't', description: 'y'.repeat(1200) }),
    ], notices);
    expect(notices.labelsAbsentWithLargeDescription).toEqual({
      kangentic_create_task: 1100,
      kangentic_update_task: 1200,
    });
  });

  it('starts empty and stays empty for an unrelated tool call', () => {
    const notices = createToolArgumentNotices();
    expect(notices.labelsAbsentWithLargeDescription).toEqual({});
    logMcpToolArguments(makeToolCall('kangentic_list_tasks', { description: 'x'.repeat(2000) }), notices);
    expect(notices.labelsAbsentWithLargeDescription).toEqual({});
  });

  it('still logs to the console when no notices object is passed (back-compat)', () => {
    logMcpToolArguments(makeToolCall('kangentic_create_task', { title: 'Big', description: 'x'.repeat(1500) }));
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});

describe('logMcpToolArguments - array body with multiple matching calls', () => {
  it('logs once per matching message when the batch contains both create and update calls', () => {
    const smallDescription = 'short';
    const largeDescription = 'x'.repeat(1500);
    const batchBody = [
      makeToolCall('kangentic_create_task', { title: 'Small', description: smallDescription }),
      makeToolCall('kangentic_update_task', { taskId: 'task-2', description: largeDescription }),
    ];
    logMcpToolArguments(batchBody);
    // First call: small description, no labels -> log path
    // Second call: large description, no labels -> warn path
    expect(logSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
