/**
 * `TerminalSubmit` records every text Kangentic types itself, before it is delivered (#1078).
 *
 * What a user loses if this goes: a Text match on their message (a turn-end row that waits for
 * "signed off") reads a column message or a nudge Kangentic typed as the user's own words, and a
 * card moves before anyone signed it off. And if a person's own text were recorded, their real
 * "signed off" would be dropped as Kangentic's and the row would never run.
 */
import { describe, it, expect, vi } from 'vitest';
import { TerminalSubmit, type TypedTextRecorder } from '../../src/main/pty/terminal-submit';
import type { PasteEngine, PasteOptions } from '../../src/main/pty/paste-engine';
import type { SessionManager } from '../../src/main/pty/session-manager';
import { SimulatedSessionManager } from './injection-tui-simulator';

const SESSION_ID = 's1';

class RecordingPasteEngine implements PasteEngine {
  calls: Array<{ sessionId: string; text: string; options?: PasteOptions }> = [];

  pasteAndSubmit(sessionId: string, text: string, options?: PasteOptions): Promise<void> {
    this.calls.push({ sessionId, text, options });
    return Promise.resolve();
  }
}

function makeSubmit(recorder: TypedTextRecorder) {
  const sessionManager = new SimulatedSessionManager(SESSION_ID);
  const pasteEngine = new RecordingPasteEngine();
  const submit = new TerminalSubmit(sessionManager as unknown as SessionManager, pasteEngine, recorder);
  return { submit, sessionManager, pasteEngine };
}

describe('TerminalSubmit typed-text record', () => {
  describe('submitContent', () => {
    it('records the text once, under the session, by default', async () => {
      const recorder = vi.fn();
      const { submit, sessionManager } = makeSubmit(recorder);

      await submit.submitContent(SESSION_ID, 'Continue with the canvas.', { source: 'test' });

      expect(recorder).toHaveBeenCalledTimes(1);
      expect(recorder).toHaveBeenCalledWith(SESSION_ID, 'Continue with the canvas.');
      sessionManager.dispose();
    });

    it('records the text before it is delivered, so a turn that ends at once still finds it', async () => {
      const order: string[] = [];
      const { submit, sessionManager, pasteEngine } = makeSubmit(() => { order.push('recorded'); });
      const originalPaste = pasteEngine.pasteAndSubmit.bind(pasteEngine);
      pasteEngine.pasteAndSubmit = (sessionId, text, options) => {
        order.push('delivered');
        return originalPaste(sessionId, text, options);
      };

      await submit.submitContent(SESSION_ID, 'hello', {});

      expect(order).toEqual(['recorded', 'delivered']);
      sessionManager.dispose();
    });

    it('records nothing for a person\'s text, and still delivers it', async () => {
      const recorder = vi.fn();
      const { submit, sessionManager, pasteEngine } = makeSubmit(recorder);

      await submit.submitContent(SESSION_ID, 'Looks great, signed off', { origin: 'person' });

      expect(recorder).not.toHaveBeenCalled();
      expect(pasteEngine.calls).toHaveLength(1);
      expect(pasteEngine.calls[0].text).toBe('Looks great, signed off');
      sessionManager.dispose();
    });

    it('records an explicit kangentic origin', async () => {
      const recorder = vi.fn();
      const { submit, sessionManager } = makeSubmit(recorder);

      await submit.submitContent(SESSION_ID, 'nudge', { origin: 'kangentic' });

      expect(recorder).toHaveBeenCalledWith(SESSION_ID, 'nudge');
      sessionManager.dispose();
    });

    it('does not forward origin to the paste engine, and keeps the other options', async () => {
      const { submit, sessionManager, pasteEngine } = makeSubmit(vi.fn());

      await submit.submitContent(SESSION_ID, 'text', { origin: 'person', bracketed: true, source: 'test' });

      expect(pasteEngine.calls[0].options).toEqual({ bracketed: true, source: 'test' });
      expect(pasteEngine.calls[0].options).not.toHaveProperty('origin');
      sessionManager.dispose();
    });

    it('swallows a recorder that throws, and still delivers', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const recorder = vi.fn(() => { throw new Error('disk full'); });
        const { submit, sessionManager, pasteEngine } = makeSubmit(recorder);

        await expect(submit.submitContent(SESSION_ID, 'text', {})).resolves.toBeUndefined();

        expect(recorder).toHaveBeenCalledTimes(1);
        expect(pasteEngine.calls).toHaveLength(1);
        expect(warnSpy).toHaveBeenCalled();
        sessionManager.dispose();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('delivers with no recorder at all', async () => {
      const sessionManager = new SimulatedSessionManager(SESSION_ID);
      const pasteEngine = new RecordingPasteEngine();
      const submit = new TerminalSubmit(sessionManager as unknown as SessionManager, pasteEngine);

      await submit.submitContent(SESSION_ID, 'text', {});

      expect(pasteEngine.calls).toHaveLength(1);
      sessionManager.dispose();
    });
  });

  describe('submitKeystrokes', () => {
    it('records each command once, as sanitized, in order', async () => {
      const recorder = vi.fn();
      const { submit, sessionManager } = makeSubmit(recorder);

      await submit.submitKeystrokes(SESSION_ID, [
        { text: '/effort high', verify: 'none' },
        'line\none\ttwo',
      ]);

      expect(recorder.mock.calls).toEqual([
        [SESSION_ID, '/effort high'],
        [SESSION_ID, 'line one two'],
      ]);
      sessionManager.dispose();
    });

    it('does not record a command that sanitizes to nothing', async () => {
      const recorder = vi.fn();
      const { submit, sessionManager } = makeSubmit(recorder);

      await submit.submitKeystrokes(SESSION_ID, ['', '  \n\t', 'carry on']);

      expect(recorder.mock.calls).toEqual([[SESSION_ID, 'carry on']]);
      sessionManager.dispose();
    });

    it('records before the first key is written', async () => {
      const order: string[] = [];
      const { submit, sessionManager } = makeSubmit(() => { order.push('recorded'); });
      const originalWrite = sessionManager.write.bind(sessionManager);
      sessionManager.write = (writeSessionId: string, data: string): void => {
        order.push(`write:${data.length === 1 ? 'key' : 'text'}`);
        originalWrite(writeSessionId, data);
      };

      await submit.submitKeystrokes(SESSION_ID, ['carry on']);

      expect(order[0]).toBe('recorded');
      sessionManager.dispose();
    });

    it('records nothing for a person\'s keystrokes, and still types them', async () => {
      const recorder = vi.fn();
      const { submit, sessionManager } = makeSubmit(recorder);

      await submit.submitKeystrokes(SESSION_ID, ['signed off'], { origin: 'person' });

      expect(recorder).not.toHaveBeenCalled();
      expect(sessionManager.writes).toContain('signed off');
      sessionManager.dispose();
    });

    it('swallows a recorder that throws, and still types the command', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const { submit, sessionManager } = makeSubmit(() => { throw new Error('disk full'); });

        const result = await submit.submitKeystrokes(SESSION_ID, ['carry on']);

        expect(sessionManager.writes).toContain('carry on');
        expect(result.outcome).toBe('unconfirmed');
        expect(warnSpy).toHaveBeenCalled();
        sessionManager.dispose();
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
