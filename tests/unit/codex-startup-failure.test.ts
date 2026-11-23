/**
 * Codex's startup-failure notice (`describeStartupFailure`).
 *
 * Codex runs under a shell that outlives it, so a Codex that exits at launch is
 * found by the agent-absence sweep, and the sweep's notice comes only from this
 * method. Without it the card went quiet, and the launch report never read the
 * output, so a user's own broken config reached Sentry as a death at start
 * (measured on 0.171.0 in a preview, task #1182). The fixture is that run's ring.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CodexAdapter } from '../../src/main/agent/adapters/codex/codex-adapter';
import { classifyLaunchOutput } from '../../src/main/pty/launch-output-class';

const refusedRing = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-0.171.0-project-config-refused.txt'), 'utf-8');
/** `codex resume <id>` of a conversation that does not exist, in a PTY on 0.171.0: exit 1 after 1.9 s. */
const resumeMissRing = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'codex-0.171.0-resume-missing.txt'), 'utf-8');
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

describe('Codex describeStartupFailure', () => {
  const adapter = new CodexAdapter();

  it('names a project config Codex refused, with where its parser stopped', () => {
    expect(adapter.describeStartupFailure(refusedRing, 0)).toBe(
      'Codex could not read this project\'s .codex/config.toml (TOML parse error at line 1, column 6). Fix the file, then start the task again.',
    );
  });

  it('still names it when the terminal wrapped the position off the line', () => {
    const wrapped = 'PS C:\\repo> codex\r\nError: Error parsing project config file C:\\Users\\dev\\repo\\.codex\\conf\r\nig.toml: TOML parse error at line 1, column 6\r\nPS C:\\repo> ';
    expect(adapter.describeStartupFailure(wrapped, 0)).toBe(
      'Codex could not read this project\'s .codex/config.toml. Fix the file, then start the task again.',
    );
  });

  it('names a login Codex can no longer refresh, in its own words', () => {
    const sentence = 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.';
    expect(adapter.describeStartupFailure(`PS C:\\repo> codex\r\n${sentence}\r\nPS C:\\repo> `, 1)).toBe(`Codex needs a new sign-in. ${sentence}`);
  });

  it('names a resume of a conversation Codex has no record of', () => {
    expect(adapter.describeStartupFailure(resumeMissRing, 1)).toBe(
      'Codex found no conversation to resume (session 00000000). Its history was cleaned up or moved. Move the task to To Do and back to start fresh.',
    );
  });

  it('names nothing for a normal end, or a failure Codex did not word', () => {
    expect(adapter.describeStartupFailure('PS C:\\repo> codex\r\nGoodbye!\r\nPS C:\\repo> ', 0)).toBeNull();
    expect(adapter.describeStartupFailure('PS C:\\repo> codex\r\nError loading config.toml: invalid type\r\nPS C:\\repo> ', 1)).toBeNull();
  });
});

describe('Codex namesMissingConversation', () => {
  const adapter = new CodexAdapter();

  it('reads the refusal for the id it was told to resume, through the cursor escape inside it', () => {
    expect(adapter.namesMissingConversation(resumeMissRing, MISSING_ID)).toBe(true);
    expect(classifyLaunchOutput(resumeMissRing, adapter, MISSING_ID)).toBe('conversation_missing');
  });

  it('reads it when a narrow terminal wrapped the advice off the line', () => {
    const wrapped = `PS C:\\repo> codex resume ${MISSING_ID}\r\nERROR: No saved session found with ID ${MISSING_ID}. Run \`codex resume\` without an ID to\r\n choose from existing sessions.\r\nPS C:\\repo> `;
    expect(adapter.namesMissingConversation(wrapped, MISSING_ID)).toBe(true);
  });

  it('does not read another conversation\'s refusal, or the sentence quoted in a prompt', () => {
    expect(adapter.namesMissingConversation(resumeMissRing, '11111111-1111-4111-8111-111111111111')).toBe(false);
    const quoted = `PS C:\\repo> codex "why does it say ERROR: No saved session found with ID ${MISSING_ID}."\r\nPS C:\\repo> `;
    expect(adapter.namesMissingConversation(quoted, MISSING_ID)).toBe(false);
  });
});
