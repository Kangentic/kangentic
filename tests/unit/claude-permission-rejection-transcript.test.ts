/**
 * Unit tests for the Claude permission-rejection transcript detector (task
 * #640). Locks the two real rejection content variants captured from real
 * sessions plus the defensive array-of-blocks fallback, the `is_error` +
 * prefix double-signal (so an ordinary tool failure never counts), id
 * filtering to the caller's tracked `toolIds`, and the `sinceMs` freshness
 * guard that keeps a bounded tail re-scan from matching a stale historical
 * rejection after a `--resume`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { reportRejectedPromptTools } from '../../src/main/agent/adapters/claude/permission-rejection-transcript';
import { claudeProjectSlug } from '../../src/main/agent/adapters/claude/transcript-parser';

const cwd = 'C:\\Users\\dev\\repo';
const agentSessionId = '790dfef5-8325-48fd-bd0f-bd6789a48871';
const toolId = 'toolu_01AnwL9uExampleToolId';

/** A real-shape captured rejection line: a plain deny, no user feedback. */
function plainDenyLine(rejectedToolId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: '11e75685-8e19-4522-9a07-af0ebe89727e',
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: rejectedToolId,
          is_error: true,
          content:
            "The user doesn't want to proceed with this tool use. The tool use was rejected " +
            '(eg. if it was a file edit, the new_string was NOT written to the file). ' +
            'STOP what you are doing and wait for the user to tell you how to proceed.',
        },
      ],
    },
  });
}

/** A real-shape captured rejection line carrying the user's typed feedback. */
function denyWithFeedbackLine(rejectedToolId: string, timestamp: string, feedback: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'd4e5f6a7-8b9c-4d0e-1f2a-3b4c5d6e7f80',
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: rejectedToolId,
          is_error: true,
          content:
            "The user doesn't want to proceed with this tool use. The tool use was rejected " +
            `(eg. if it was a file edit, the new_string was NOT written to the file). To tell you ` +
            `how to proceed, the user said:\n${feedback}`,
        },
      ],
    },
  });
}

/** An ordinary (non-rejection) tool failure - is_error, but no rejection prefix. */
function ordinaryToolFailureLine(failedToolId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'a2c9c7e0-1c3f-4c39-9f6b-2a2f4e9b6d7a',
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: failedToolId,
          is_error: true,
          content: 'ENOENT: no such file or directory',
        },
      ],
    },
  });
}

/**
 * A rejection whose `tool_result.content` is an array of content blocks
 * (the SDK's general shape for tool_result content, per
 * `transcript-parser.ts`'s `stringifyToolResultContent`) rather than the
 * plain string every real captured session actually used. Defensive-only:
 * no real capture has been observed in this shape, but the detector
 * supports it in case a future Claude Code version wraps it this way.
 */
function plainDenyLineWithBlockContent(rejectedToolId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'f1a2b3c4-d5e6-4f70-8192-a3b4c5d6e7f8',
    timestamp,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: rejectedToolId,
          is_error: true,
          content: [
            {
              type: 'text',
              text:
                "The user doesn't want to proceed with this tool use. The tool use was rejected " +
                '(eg. if it was a file edit, the new_string was NOT written to the file). ' +
                'STOP what you are doing and wait for the user to tell you how to proceed.',
            },
          ],
        },
      ],
    },
  });
}

/** A normal (non-error) tool_result for the same id - the tool actually ran. */
function approvedToolResultLine(approvedToolId: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    timestamp,
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: approvedToolId, is_error: false, content: 'File written.' },
      ],
    },
  });
}

describe('reportRejectedPromptTools', () => {
  let tempHome: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-permission-rejection-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    const dir = path.join(tempHome, '.claude', 'projects', claudeProjectSlug(cwd));
    fs.mkdirSync(dir, { recursive: true });
    transcriptPath = path.join(dir, `${agentSessionId}.jsonl`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('reports a plain-deny rejection matching a tracked toolId', () => {
    fs.writeFileSync(transcriptPath, `${plainDenyLine(toolId, '2026-09-12T00:25:19.438Z')}\n`);

    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([toolId]);
  });

  it('reports a deny-with-feedback rejection matching a tracked toolId', () => {
    fs.writeFileSync(
      transcriptPath,
      `${denyWithFeedbackLine(toolId, '2026-09-12T00:25:19.438Z', 'Lets talk about the plan first')}\n`,
    );

    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([toolId]);
  });

  it('reports a rejection whose content is an array of blocks, not a plain string (defensive fallback)', () => {
    fs.writeFileSync(transcriptPath, `${plainDenyLineWithBlockContent(toolId, '2026-09-12T00:25:19.438Z')}\n`);

    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([toolId]);
  });

  it('does not report an ordinary tool failure (is_error without the rejection prefix)', () => {
    fs.writeFileSync(transcriptPath, `${ordinaryToolFailureLine(toolId, '2026-09-12T00:25:19.438Z')}\n`);

    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([]);
  });

  it('does not report a normal (non-error) tool_result for the same id (the tool was approved and ran)', () => {
    fs.writeFileSync(transcriptPath, `${approvedToolResultLine(toolId, '2026-09-12T00:25:19.438Z')}\n`);

    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([]);
  });

  it('does not report a rejection for an untracked id (structural rejection of unrelated denials)', () => {
    fs.writeFileSync(transcriptPath, `${plainDenyLine('toolu_someOtherId', '2026-09-12T00:25:19.438Z')}\n`);

    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([]);
  });

  it('reports only the matching subset when several ids are tracked and only one was rejected', () => {
    fs.writeFileSync(transcriptPath, `${plainDenyLine(toolId, '2026-09-12T00:25:19.438Z')}\n`);

    const result = reportRejectedPromptTools({
      cwd,
      agentSessionId,
      toolIds: [toolId, 'toolu_stillPending'],
      sinceMs: 0,
    });

    expect(result).toEqual([toolId]);
  });

  it('does not report a rejection whose timestamp predates sinceMs (stale-history guard across a --resume)', () => {
    // A --resume keeps appending to the SAME transcript file, so an ancient
    // rejection for a reused toolId (however unlikely) must not clear a
    // brand-new, unrelated prompt awaiting the same id.
    fs.writeFileSync(transcriptPath, `${plainDenyLine(toolId, '2026-01-01T00:00:00.000Z')}\n`);

    const sinceMs = Date.parse('2026-09-12T00:00:00.000Z');
    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs });

    expect(result).toEqual([]);
  });

  it('reports a rejection whose timestamp is exactly at sinceMs (inclusive boundary)', () => {
    const timestamp = '2026-09-12T00:25:19.438Z';
    fs.writeFileSync(transcriptPath, `${plainDenyLine(toolId, timestamp)}\n`);

    const result = reportRejectedPromptTools({
      cwd,
      agentSessionId,
      toolIds: [toolId],
      sinceMs: Date.parse(timestamp),
    });

    expect(result).toEqual([toolId]);
  });

  it('returns [] when the transcript file does not exist', () => {
    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([]);
  });

  it('returns [] when toolIds is empty (no candidates to ask about)', () => {
    fs.writeFileSync(transcriptPath, `${plainDenyLine(toolId, '2026-09-12T00:25:19.438Z')}\n`);

    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [], sinceMs: 0 });

    expect(result).toEqual([]);
  });

  it('returns [] for an unparseable line without throwing', () => {
    fs.writeFileSync(transcriptPath, `not valid json\n${plainDenyLine(toolId, '2026-09-12T00:25:19.438Z')}\n`);

    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([toolId]);
  });

  it('re-reads the file on every call (no stale cache): a later rejection lands on the next poll', () => {
    fs.writeFileSync(transcriptPath, '');
    expect(reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 })).toEqual([]);

    fs.appendFileSync(transcriptPath, `${plainDenyLine(toolId, '2026-09-12T00:25:19.438Z')}\n`);
    const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

    expect(result).toEqual([toolId]);
  });

  describe('the 256KB tail-read path (TAIL_BYTES boundary)', () => {
    /**
     * Cheap, deterministic filler: valid JSONL lines that never mention any
     * tracked toolId, so the pre-filter in reportRejectedPromptTools skips
     * them all before paying for JSON.parse. Every generated line has the
     * SAME byte length, which is what makes the byte-offset arithmetic in
     * the two tests below (targeting a total size comfortably above or
     * below the tail window) predictable without hand-computing an exact
     * byte count.
     */
    function paddingBlock(totalBytes: number): string {
      const line = `${JSON.stringify({
        type: 'user',
        timestamp: '2020-01-01T00:00:00.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(900) }] },
      })}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf-8');
      const linesNeeded = Math.ceil(totalBytes / lineBytes);
      return line.repeat(linesNeeded);
    }

    it('finds a genuine rejection near the END of a transcript well past 256KB', () => {
      // 300KB of filler comfortably exceeds TAIL_BYTES (256KB) on its own,
      // so the file's total size forces the fs.openSync/fs.readSync tail
      // path (every other test in this file writes a tiny transcript that
      // never leaves the `stat.size <= TAIL_BYTES` branch).
      const padding = paddingBlock(300 * 1024);
      const timestamp = '2026-09-12T00:25:19.438Z';
      fs.writeFileSync(transcriptPath, `${padding}${plainDenyLine(toolId, timestamp)}\n`);
      expect(fs.statSync(transcriptPath).size).toBeGreaterThan(256 * 1024);

      const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

      expect(result).toEqual([toolId]);
    });

    it('does not find a rejection pushed OUTSIDE the tail window by trailing padding (window boundary, not just the happy path)', () => {
      // The rejection is the FIRST line; 300KB of filler AFTER it (itself
      // comfortably larger than the 256KB tail window) guarantees the last
      // TAIL_BYTES of the file never reach back far enough to include it,
      // regardless of exact line-boundary alignment.
      const timestamp = '2026-09-12T00:25:19.438Z';
      const padding = paddingBlock(300 * 1024);
      fs.writeFileSync(transcriptPath, `${plainDenyLine(toolId, timestamp)}\n${padding}`);
      const stat = fs.statSync(transcriptPath);
      expect(stat.size).toBeGreaterThan(256 * 1024);
      // The tail window starts well past byte 0, where the rejection line lives.
      expect(stat.size - 256 * 1024).toBeGreaterThan(0);

      const result = reportRejectedPromptTools({ cwd, agentSessionId, toolIds: [toolId], sinceMs: 0 });

      expect(result).toEqual([]);
    });
  });
});
