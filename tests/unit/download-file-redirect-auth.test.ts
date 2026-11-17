/**
 * The shared attachment download drops the sign-in header on a redirect it
 * cannot trust. A board adapter (Jira, Azure DevOps, Asana) hands it an
 * Authorization header for the provider's own host; a redirect to another host
 * must not carry it, and neither may an https to http hop on the same host,
 * which would send the token in the clear.
 */
import { describe, expect, it } from 'vitest';
import { redirectKeepsSignIn } from '../../src/main/boards/shared/download-file';

describe('redirectKeepsSignIn', () => {
  it('keeps the sign-in for the same scheme and host', () => {
    expect(redirectKeepsSignIn('https://acme.atlassian.net/a.png', 'https://acme.atlassian.net/b.png')).toBe(true);
  });

  it('drops it for another host', () => {
    expect(redirectKeepsSignIn('https://acme.atlassian.net/a.png', 'https://media.example.com/a.png')).toBe(false);
  });

  it('drops it for an https to http hop on the same host', () => {
    expect(redirectKeepsSignIn('https://jira.example.com/a.png', 'http://jira.example.com/a.png')).toBe(false);
  });

  it('drops it for a redirect target that does not parse as a URL', () => {
    expect(redirectKeepsSignIn('https://jira.example.com/a.png', '/relative/a.png')).toBe(false);
  });
});
