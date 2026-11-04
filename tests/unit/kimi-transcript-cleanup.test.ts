/**
 * Unit tests for cleanKimiTranscript. The input follows the 2.4.1 welcome box
 * (`apps/kimi-code/src/tui/components/chrome/welcome.ts`), since no real
 * capture of the 2.x TUI exists yet.
 */
import { describe, it, expect } from 'vitest';
import { cleanKimiTranscript } from '../../src/main/agent/adapters/kimi/transcript-cleanup';
import { cleanTranscriptForHandoff } from '../../src/main/agent/handoff/transcript-cleanup';

const WELCOME = [
  'Welcome to Kimi Code!',
  'Send /help for help information.',
  'Directory: ~/projects/foo',
  'Session:   session_73013240-b192-422f-99a3-7cf37eac045a',
  'Model:     kimi-code/k3',
  'Version:   2.4.1',
  'MCP:       1 connected',
];

describe('cleanKimiTranscript', () => {
  it('strips the welcome box while keeping the conversation', () => {
    const cleaned = cleanKimiTranscript([...WELCOME, '', '> hello', 'Hi! I can help with your code.'].join('\n'));
    expect(cleaned).not.toBeNull();
    for (const noise of ['Welcome to Kimi Code', 'Session:', 'Model:', 'Directory:', 'Version:', 'MCP:']) {
      expect(cleaned).not.toContain(noise);
    }
    expect(cleaned).toContain('Hi! I can help with your code.');
  });

  it('strips a new session\'s empty id line, its notice, and the sign-in hint', () => {
    const cleaned = cleanKimiTranscript([
      'Run /login or /provider to get started.',
      'Session:   ',
      'No session yet - one will be created on your first message.',
      'A real reply',
    ].join('\n'));
    expect(cleaned).toBe('A real reply');
  });

  it('strips the exit hint', () => {
    const cleaned = cleanKimiTranscript('Some reply\n Bye!\nTo resume this session: kimi -r session_bf6b28d4-58d1-4bd5-a892-7733ad7d054c');
    expect(cleaned).toContain('Some reply');
    expect(cleaned).not.toContain('To resume this session');
    expect(cleaned).not.toContain('Bye');
  });

  it('strips a version line and the indented goodbye, and keeps prose that only starts like them', () => {
    const cleaned = cleanKimiTranscript(['Version: 2.4.1', ' Bye!', 'Version: see the notes', 'Bye', 'A real reply'].join('\n'));
    expect(cleaned).toBe('Version: see the notes\nBye\nA real reply');
  });

  it('returns null when only TUI noise remains', () => {
    expect(cleanKimiTranscript(WELCOME.join('\n'))).toBeNull();
  });

  it('keeps prose that merely mentions a slash command or a session', () => {
    const cleaned = cleanKimiTranscript([...WELCOME, '/login is required to access the API', 'Session: this word starts a sentence.'].join('\n'));
    expect(cleaned).toContain('/login is required to access the API');
    expect(cleaned).toContain('Session: this word starts a sentence.');
  });
});

describe('handoff dispatcher routes "kimi" to the Kimi cleaner', () => {
  it('produces the same result as calling cleanKimiTranscript directly', () => {
    const raw = [...WELCOME, '', 'Hello world'].join('\n');
    expect(cleanTranscriptForHandoff(raw, 'kimi')).toBe(cleanKimiTranscript(raw));
  });
});
