import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractSessionEvent,
  extractToolDetail,
  extractToolStartEvent,
  extractToolEndEvent,
  extractWaitEvent,
} from '../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs';
import { ActivityEngine } from '../../src/main/activity-engine/engine';
import type { SessionEvent } from '../../src/shared/types';

const fixturePath = path.join(__dirname, '..', 'fixtures', 'opencode-plugin-events.json');
const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));

const FIXED_TIMESTAMP = 1717000000000;

interface PluginHooks {
  event: (payload: { event: unknown }) => Promise<void>;
}

interface PluginModule {
  KangenticActivity: () => Promise<PluginHooks>;
}

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

  describe('extractWaitEvent', () => {
    it('maps question.asked to a question wait', () => {
      expect(extractWaitEvent(fixtures.event_question_asked, FIXED_TIMESTAMP))
        .toEqual({ ts: FIXED_TIMESTAMP, type: 'idle', detail: 'permission', waitKind: 'question' });
    });

    it('maps permission.asked to an approval wait', () => {
      expect(extractWaitEvent(fixtures.event_permission_asked, FIXED_TIMESTAMP))
        .toEqual({ ts: FIXED_TIMESTAMP, type: 'idle', detail: 'permission', waitKind: 'approval' });
    });

    it('logs each answer as a notification, never as an idle a turn end would read', () => {
      for (const fixture of [fixtures.event_question_replied, fixtures.event_question_rejected, fixtures.event_permission_replied]) {
        expect(extractWaitEvent(fixture, FIXED_TIMESTAMP)).toEqual({ ts: FIXED_TIMESTAMP, type: 'notification', detail: fixture.type });
      }
    });

    it('returns null for every other event, and for a non-object', () => {
      expect(extractWaitEvent(fixtures.event_session_idle, FIXED_TIMESTAMP)).toBeNull();
      expect(extractWaitEvent(null, FIXED_TIMESTAMP)).toBeNull();
      expect(extractWaitEvent('question.asked', FIXED_TIMESTAMP)).toBeNull();
    });

    it('a session event is never read as a wait, so the event hook writes one line at most', () => {
      for (const fixture of [fixtures.event_session_created, fixtures.event_session_idle, fixtures.event_session_error]) {
        expect(extractWaitEvent(fixture, FIXED_TIMESTAMP)).toBeNull();
      }
    });

    it('in OpenCode\'s order (tool start, wait, tool end) the wait shows and its tool\'s end clears it', () => {
      // OpenCode 1.18.31 triggers tool.execute.before, then runs the tool, whose `ask`
      // publishes the request, then triggers tool.execute.after (also after a throw).
      const engine = new ActivityEngine({ onActivityChange() { /* unused */ } }, { idleStabilityWindowMs: 0 });
      const sessionId = 'opencode-session';
      engine.initSession(sessionId);
      const feed = (event: SessionEvent | null): void => { if (event) engine.processEvent(sessionId, event); };

      feed(extractToolStartEvent({ tool: 'question' }, { args: {} }, FIXED_TIMESTAMP) as SessionEvent);
      feed(extractWaitEvent(fixtures.event_question_asked, FIXED_TIMESTAMP + 1) as SessionEvent);
      expect(engine.getState(sessionId)?.activity).toBe('permission');
      expect(engine.getState(sessionId)?.permissionWaitKind).toBe('question');

      feed(extractWaitEvent(fixtures.event_question_replied, FIXED_TIMESTAMP + 2) as SessionEvent);
      expect(engine.getState(sessionId)?.activity).toBe('permission');

      feed(extractToolEndEvent({ tool: 'question' }, FIXED_TIMESTAMP + 3) as SessionEvent);
      expect(engine.getState(sessionId)?.activity).toBe('thinking');
      expect(engine.getState(sessionId)?.permissionWaitKind).toBeNull();
      engine.dispose();
    });
  });

  describe('the KangenticActivity event hook', () => {
    // The module reads KANGENTIC_EVENTS_PATH once, at load, so each test points
    // it at its own temp file and loads a fresh copy of the plugin after.
    let eventsDirectory: string;
    let eventsFilePath: string;
    let previousEventsPath: string | undefined;

    beforeEach(() => {
      previousEventsPath = process.env.KANGENTIC_EVENTS_PATH;
      eventsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-plugin-events-'));
      eventsFilePath = path.join(eventsDirectory, 'events.jsonl');
      process.env.KANGENTIC_EVENTS_PATH = eventsFilePath;
      vi.resetModules();
    });

    afterEach(() => {
      if (previousEventsPath === undefined) {
        delete process.env.KANGENTIC_EVENTS_PATH;
      } else {
        process.env.KANGENTIC_EVENTS_PATH = previousEventsPath;
      }
      fs.rmSync(eventsDirectory, { recursive: true, force: true });
      vi.resetModules();
    });

    async function loadHooks(): Promise<PluginHooks> {
      const pluginModule = await import('../../src/main/agent/adapters/opencode/plugin/kangentic-activity.mjs') as unknown as PluginModule;
      return pluginModule.KangenticActivity();
    }

    function readEvents(): unknown[] {
      if (!fs.existsSync(eventsFilePath)) return [];
      return fs.readFileSync(eventsFilePath, 'utf-8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as unknown);
    }

    it('writes a question wait, an approval wait, and a plain idle as one line each, in order', async () => {
      const hooks = await loadHooks();

      await hooks.event({ event: fixtures.event_question_asked });
      await hooks.event({ event: fixtures.event_permission_asked });
      await hooks.event({ event: fixtures.event_session_idle });

      // Exact shapes: the idle line must carry no detail or waitKind of its own.
      expect(readEvents()).toEqual([
        { ts: expect.any(Number), type: 'idle', detail: 'permission', waitKind: 'question' },
        { ts: expect.any(Number), type: 'idle', detail: 'permission', waitKind: 'approval' },
        { ts: expect.any(Number), type: 'idle' },
      ]);
    });

    it('writes nothing for an event that is neither a session event nor a wait', async () => {
      const hooks = await loadHooks();

      await hooks.event({ event: fixtures.event_session_unknown });

      expect(readEvents()).toEqual([]);
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
