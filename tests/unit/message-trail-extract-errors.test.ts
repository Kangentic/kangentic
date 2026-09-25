/**
 * Direct unit coverage for extractMessageTrail's early failure paths, other than the OpenCode
 * candidate-selection logic already covered by message-trail-extract-opencode-candidates.test.ts.
 *
 * chooseCandidate itself is not exported (and stays that way, per the task that added this file),
 * so its "zero matches is an error rather than an empty trail" contract is driven through the
 * exported extractMessageTrail surface instead, matching the docblock's own words: "the caller
 * reports and stops". This file only exercises the three branches that resolve before any
 * candidate is ever read: the AGENTS_WITHOUT_TRANSCRIPTS short-circuit, the unwired-agent branch
 * of the candidate switch, and the unparseable capturedAt guard. All three throw or return before
 * touching a transcript reader, so this file needs no filesystem and no real transcripts.
 */
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import {
  extractMessageTrail,
  TranscriptMatchError,
  AGENTS_WITHOUT_TRANSCRIPTS,
  type RecordingFacts,
} from '../captures/helpers/message-trail-extract';

const cwd = '/home/dev/project';
const capturedAt = '2026-01-01T00:20:00.000Z';
const durationMs = 10 * 60 * 1000; // 10 minutes

describe('extractMessageTrail - agents with no transcript', () => {
  it('returns null for an agent listed in AGENTS_WITHOUT_TRANSCRIPTS, without touching the filesystem', async () => {
    expect(Object.keys(AGENTS_WITHOUT_TRANSCRIPTS)).toContain('cursor');
    const readdirSpy = vi.spyOn(fs, 'readdirSync');
    const facts: RecordingFacts = { agent: 'cursor', prompt: 'fix the pagination bug', capturedAt, durationMs };

    const trail = await extractMessageTrail(facts, cwd);

    expect(trail).toBeNull();
    expect(readdirSpy).not.toHaveBeenCalled();
    readdirSpy.mockRestore();
  });
});

describe('extractMessageTrail - agent with no wired transcript reader', () => {
  it('throws TranscriptMatchError naming the agent', async () => {
    const facts: RecordingFacts = { agent: 'some-future-agent', prompt: 'fix the pagination bug', capturedAt, durationMs };

    let thrown: unknown = null;
    try {
      await extractMessageTrail(facts, cwd);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TranscriptMatchError);
    expect((thrown as Error).message).toContain('some-future-agent');
  });
});

describe('extractMessageTrail - unparseable capturedAt', () => {
  it('throws TranscriptMatchError when capturedAt cannot be parsed as a date', async () => {
    const facts: RecordingFacts = {
      agent: 'claude',
      prompt: 'fix the pagination bug',
      capturedAt: 'not-a-real-timestamp',
      durationMs,
    };

    let thrown: unknown = null;
    try {
      await extractMessageTrail(facts, cwd);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TranscriptMatchError);
    expect((thrown as Error).message).toContain('not-a-real-timestamp');
  });
});
