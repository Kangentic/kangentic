/**
 * Tests for `parseClaudeTranscriptUsage` - the cumulative lifetime token parser
 * that reads Claude's own session JSONL (the authoritative token source, since
 * the live statusLine `context_window` counts are a current-context snapshot on
 * Claude Code 2.1.132+).
 *
 * Cross-checked against a pinned transcript fixture
 * (tests/fixtures/transcripts/claude-usage-sample.jsonl) so the dedup-by-
 * message.id math and the cache-token accounting are locked.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseClaudeTranscriptUsage,
  claudeProjectSlug,
} from '../../src/main/agent/adapters/claude/transcript-parser';
import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'transcripts', 'claude-usage-sample.jsonl');

describe('parseClaudeTranscriptUsage', () => {
  it('sums per-message usage deduped by message.id, including cache tokens', async () => {
    const usage = await parseClaudeTranscriptUsage(FIXTURE_PATH);
    expect(usage).not.toBeNull();
    // The fixture has:
    //   msg_01ABC (appears TWICE, same id -> counted once):
    //     input 100 + cache_creation 20 + cache_read 30 = 150, output 50
    //   msg_02DEF: input 200 + cache_creation 0 + cache_read 1000 = 1200, output 80
    //   msg_03GHI: no usage object -> skipped
    //   a user line, a compact_boundary system line, a malformed line -> all skipped
    expect(usage!.inputTokens).toBe(150 + 1200);
    expect(usage!.outputTokens).toBe(50 + 80);
  });

  it('returns null for a missing transcript file (caller falls back to the snapshot)', async () => {
    const missing = path.join(os.tmpdir(), 'kangentic-no-such-transcript-12345.jsonl');
    expect(await parseClaudeTranscriptUsage(missing)).toBeNull();
  });

  it('returns null for a transcript with no assistant usage', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-transcript-'));
    const filePath = path.join(dir, 'empty.jsonl');
    try {
      // Only a user line and a system line - no assistant usage to total.
      fs.writeFileSync(
        filePath,
        '{"type":"user","message":{"content":"hi"}}\n{"type":"system","subtype":"compact_boundary"}\n',
      );
      expect(await parseClaudeTranscriptUsage(filePath)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Hole 2: ClaudeAdapter.transcriptUsage - three input-path branches
//
// (a) explicit transcriptPath provided -> reads that file directly
// (b) no transcriptPath but agentSessionId + cwd provided -> derives the
//     canonical ~/.claude/projects/<slug>/<id>.jsonl path via
//     locateClaudeTranscriptFile and reads it
// (c) neither transcriptPath nor agentSessionId+cwd -> returns null
//     without touching the filesystem
// ---------------------------------------------------------------------------

describe('ClaudeAdapter.transcriptUsage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(branch a) reads and parses usage from an explicit transcriptPath', async () => {
    const adapter = new ClaudeAdapter();
    const usage = await adapter.transcriptUsage({ transcriptPath: FIXTURE_PATH });

    expect(usage).not.toBeNull();
    // The fixture has:
    //   msg_01ABC (deduped, counted once): input 150, output 50
    //   msg_02DEF: input 1200, output 80
    //   msg_03GHI: no usage object -> skipped
    expect(usage!.inputTokens).toBe(150 + 1200);
    expect(usage!.outputTokens).toBe(50 + 80);
  });

  it('(branch b) derives the path from agentSessionId + cwd and reads it when the file exists', async () => {
    // Create a temp home and point os.homedir() there so locateClaudeTranscriptFile
    // resolves to a path we control (avoids writing into the real ~/.claude/ dir).
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-claude-adapter-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);

    try {
      const agentSessionId = 'branch-b-session';
      const cwd = '/mock/project';
      const slug = claudeProjectSlug(cwd);
      const transcriptDir = path.join(tempHome, '.claude', 'projects', slug);
      const transcriptFile = path.join(transcriptDir, `${agentSessionId}.jsonl`);
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.copyFileSync(FIXTURE_PATH, transcriptFile);

      const adapter = new ClaudeAdapter();
      const usage = await adapter.transcriptUsage({ agentSessionId, cwd });

      expect(usage).not.toBeNull();
      expect(usage!.inputTokens).toBe(150 + 1200);
      expect(usage!.outputTokens).toBe(50 + 80);
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it('(branch c) returns null when neither transcriptPath nor agentSessionId+cwd is provided', async () => {
    const adapter = new ClaudeAdapter();

    // All inputs absent
    expect(await adapter.transcriptUsage({})).toBeNull();

    // agentSessionId without cwd
    expect(await adapter.transcriptUsage({ agentSessionId: 'some-id', cwd: null })).toBeNull();

    // cwd without agentSessionId
    expect(await adapter.transcriptUsage({ agentSessionId: null, cwd: '/some/path' })).toBeNull();
  });
});
