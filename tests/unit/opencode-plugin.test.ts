import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractSessionEvent,
  extractToolDetail,
  extractToolStartEvent,
  extractToolEndEvent,
} from '../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs';

const fixturePath = path.join(__dirname, '..', 'fixtures', 'opencode-plugin-events.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

const FIXED_TIMESTAMP = 1717000000000;

describe('opencode-plugin', () => {
  describe('extractSessionEvent', () => {
    it('maps session.created to session_start with sessionID hookContext', () => {
      const result = extractSessionEvent(fixtures.event_session_created, FIXED_TIMESTAMP);

      expect(result).toEqual({
        ts: FIXED_TIMESTAMP,
        type: 'session_start',
        hookContext: JSON.stringify({ sessionID: 'ses_2349b5c91ffeKd6qajuUTR4clq' }),
      });
    });

    it('maps session.idle to idle', () => {
      const result = extractSessionEvent(fixtures.event_session_idle, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'idle' });
    });

    it('maps session.error to idle with detail=error', () => {
      const result = extractSessionEvent(fixtures.event_session_error, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'idle', detail: 'error' });
    });

    it('returns null for unrecognized session event types', () => {
      const result = extractSessionEvent(fixtures.event_session_unknown, FIXED_TIMESTAMP);

      expect(result).toBeNull();
    });

    it('returns null when event is null/undefined/non-object', () => {
      expect(extractSessionEvent(null, FIXED_TIMESTAMP)).toBeNull();
      expect(extractSessionEvent(undefined, FIXED_TIMESTAMP)).toBeNull();
      expect(extractSessionEvent('string', FIXED_TIMESTAMP)).toBeNull();
    });

    it('handles session.created without properties.info gracefully', () => {
      const event = { type: 'session.created', properties: {} };
      const result = extractSessionEvent(event, FIXED_TIMESTAMP);

      // No sessionID anywhere -> session_start without hookContext
      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'session_start' });
    });

    it('falls back to properties.sessionID when properties.info.id is missing', () => {
      const event = {
        type: 'session.created',
        properties: { sessionID: 'ses_fallback123' },
      };
      const result = extractSessionEvent(event, FIXED_TIMESTAMP);

      expect(result?.hookContext).toBe(JSON.stringify({ sessionID: 'ses_fallback123' }));
    });
  });

  describe('extractToolDetail', () => {
    it('extracts command for shell tools', () => {
      expect(extractToolDetail(fixtures.tool_before_bash.output.args)).toBe('ls -la /tmp');
    });

    it('extracts filePath for file-read tools', () => {
      expect(extractToolDetail(fixtures.tool_before_read.output.args)).toBe('/repo/src/main.ts');
    });

    it('extracts path for glob/grep tools (preferred over pattern)', () => {
      expect(extractToolDetail(fixtures.tool_before_glob.output.args)).toBe('/repo');
    });

    it('keeps a long command whole below the field cap, and truncates at 2000 characters', () => {
      // The cap is sized for a Bash command, which the git push capture reads
      // for its content (a chained commit-and-push lost its push at the old
      // 200). tests/unit/hook-detail-cap-parity.test.ts pins the value against
      // the hook bridge's.
      const longCommand = extractToolDetail(fixtures.tool_before_long_command.output.args);
      expect(longCommand).toBe(fixtures.tool_before_long_command.output.args.command);
      expect(longCommand!.length).toBeGreaterThan(200);

      const capped = extractToolDetail({ command: 'a'.repeat(2500) });
      expect(capped).toBeDefined();
      expect(capped!.length).toBe(2000);
    });

    it('returns undefined for empty args', () => {
      expect(extractToolDetail(fixtures.tool_before_no_args.output.args)).toBeUndefined();
    });

    it('returns undefined for null/non-object args', () => {
      expect(extractToolDetail(null)).toBeUndefined();
      expect(extractToolDetail(undefined)).toBeUndefined();
      expect(extractToolDetail('string')).toBeUndefined();
    });
  });

  describe('extractToolStartEvent', () => {
    it('builds tool_start with tool name and detail from a bash invocation', () => {
      const fixture = fixtures.tool_before_bash;
      const result = extractToolStartEvent(fixture.input, fixture.output, FIXED_TIMESTAMP);

      expect(result).toEqual({
        ts: FIXED_TIMESTAMP,
        type: 'tool_start',
        tool: 'bash',
        detail: 'ls -la /tmp',
      });
    });

    it('omits detail when args contain no recognized field', () => {
      const fixture = fixtures.tool_before_no_args;
      const result = extractToolStartEvent(fixture.input, fixture.output, FIXED_TIMESTAMP);

      expect(result).toEqual({
        ts: FIXED_TIMESTAMP,
        type: 'tool_start',
        tool: 'list',
      });
      expect('detail' in result).toBe(false);
    });

    it('omits tool when input.tool is missing', () => {
      const result = extractToolStartEvent({}, { args: { command: 'echo hi' } }, FIXED_TIMESTAMP);

      expect(result).toEqual({
        ts: FIXED_TIMESTAMP,
        type: 'tool_start',
        detail: 'echo hi',
      });
    });
  });

  describe('extractToolEndEvent', () => {
    it('builds tool_end with tool name', () => {
      const result = extractToolEndEvent(fixtures.tool_after_bash.input, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'tool_end', tool: 'bash' });
    });

    it('omits tool when input.tool is missing', () => {
      const result = extractToolEndEvent({}, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'tool_end' });
    });

    it('handles undefined input', () => {
      const result = extractToolEndEvent(undefined, FIXED_TIMESTAMP);

      expect(result).toEqual({ ts: FIXED_TIMESTAMP, type: 'tool_end' });
    });
  });
});
