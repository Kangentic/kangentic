/**
 * Unit tests for cleanKimiTranscript.
 *
 * The fixture mimics the empirical TUI rendering captured from the real
 * `kimi` v1.37.0 binary (see the screenshot referenced in this PR's
 * thread): welcome banner box, "Session: <uuid>", "Model: <...>", and
 * the bottom status bar with the context-percentage cell.
 */
import { describe, it, expect } from 'vitest';
import { cleanKimiTranscript } from '../../src/main/agent/adapters/kimi/transcript-cleanup';
import { cleanTranscriptForHandoff } from '../../src/main/agent/handoff/transcript-cleanup';

describe('cleanKimiTranscript', () => {
  it('strips welcome-banner metadata while keeping conversation body', () => {
    const raw = [
      'Welcome to Kimi Code CLI!',
      'Send /help for help information.',
      '',
      'Directory: ~/projects/foo',
      'Session: 73013240-b192-422f-99a3-7cf37eac045a',
      'Model: kimi-for-coding',
      '',
      'Tip: Spot a bug or have feedback? Type /feedback right in this session - every report makes Kimi better.',
      '',
      '> hello',
      'Hi! I can help with your code.',
      '',
      '____ input ______________________________________',
      '',
      '  agent  ~/projects/foo  main  ctrl-o: editor | ctrl-j: newline    context: 0.4%',
    ].join('\n');

    const cleaned = cleanKimiTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).not.toContain('Welcome to Kimi Code CLI');
    expect(cleaned).not.toContain('Session:');
    expect(cleaned).not.toContain('Model:');
    expect(cleaned).not.toContain('Directory:');
    expect(cleaned).not.toContain('context:');
    expect(cleaned).not.toContain('input');
    expect(cleaned).toContain('Hi! I can help with your code.');
  });

  it('strips the print-mode "To resume this session" footer', () => {
    const raw = [
      'Some assistant reply',
      'To resume this session: kimi -r bf6b28d4-58d1-4bd5-a892-7733ad7d054c',
    ].join('\n');
    const cleaned = cleanKimiTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).toContain('Some assistant reply');
    expect(cleaned).not.toContain('To resume this session');
  });

  it('returns null when only TUI noise remains', () => {
    const raw = [
      'Welcome to Kimi Code CLI!',
      'Session: 73013240-b192-422f-99a3-7cf37eac045a',
      'Model: not set, send /login to login',
    ].join('\n');
    expect(cleanKimiTranscript(raw)).toBeNull();
  });

  it('preserves multi-line assistant content unchanged', () => {
    const raw = [
      'Welcome to Kimi Code CLI!',
      'Session: 73013240-b192-422f-99a3-7cf37eac045a',
      '',
      '> what is 2+2',
      '4',
      'Let me know if you want a longer explanation.',
    ].join('\n');
    const cleaned = cleanKimiTranscript(raw);
    expect(cleaned).toContain('4');
    expect(cleaned).toContain('Let me know if you want a longer explanation.');
  });

  it('does NOT strip prose that starts with a slash-command token but has no help-table description following it', () => {
    // Regression guard: "/login is required to access the API" is
    // legitimate assistant prose. The allowlist regex anchors on
    // `/command SPACE non-whitespace-description` so this line must survive.
    const raw = [
      'Welcome to Kimi Code CLI!',
      'Session: 73013240-b192-422f-99a3-7cf37eac045a',
      '',
      '/login is required to access the API',
      '',
      'You can authenticate by running the login command from your terminal.',
    ].join('\n');
    const cleaned = cleanKimiTranscript(raw);
    expect(cleaned).not.toBeNull();
    expect(cleaned).toContain('/login is required to access the API');
    expect(cleaned).toContain('You can authenticate by running the login command');
  });

  it('does strip a real slash-command help-table row (command + space + description)', () => {
    // The filter SHOULD eat "/login   Log in to your Kimi account" (help-table format).
    const raw = [
      'Welcome to Kimi Code CLI!',
      'Session: 73013240-b192-422f-99a3-7cf37eac045a',
      '',
      '/login   Log in to your Kimi account',
      '',
      'Some assistant content here.',
    ].join('\n');
    const cleaned = cleanKimiTranscript(raw);
    expect(cleaned).not.toBeNull();
    // The help-table row should be gone.
    expect(cleaned).not.toContain('/login   Log in to your Kimi account');
    // The real content should remain.
    expect(cleaned).toContain('Some assistant content here.');
  });
});

describe('handoff dispatcher routes "kimi" to the Kimi cleaner', () => {
  it('produces the same result as calling cleanKimiTranscript directly', () => {
    const raw = [
      'Welcome to Kimi Code CLI!',
      'Session: 73013240-b192-422f-99a3-7cf37eac045a',
      '',
      'Hello world',
    ].join('\n');
    const direct = cleanKimiTranscript(raw);
    const dispatched = cleanTranscriptForHandoff(raw, 'kimi');
    expect(dispatched).toBe(direct);
  });
});
