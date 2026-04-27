/**
 * Unit tests for agentLoginCommand() in src/renderer/utils/agent-display-name.ts.
 *
 * agentLoginCommand() returns the shell command users run to authenticate an
 * agent CLI (e.g. 'kimi login'). Only Kimi exposes this; all other agents
 * (and null/undefined inputs) return undefined.
 *
 * These are purely pure-function tests - no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { agentLoginCommand } from '../../src/renderer/utils/agent-display-name';

describe('agentLoginCommand', () => {
  it('returns "kimi login" for the kimi agent', () => {
    expect(agentLoginCommand('kimi')).toBe('kimi login');
  });

  it('returns undefined for claude (no in-app auth UX)', () => {
    expect(agentLoginCommand('claude')).toBeUndefined();
  });

  it('returns undefined for codex', () => {
    expect(agentLoginCommand('codex')).toBeUndefined();
  });

  it('returns undefined for gemini', () => {
    expect(agentLoginCommand('gemini')).toBeUndefined();
  });

  it('returns undefined for aider', () => {
    expect(agentLoginCommand('aider')).toBeUndefined();
  });

  it('returns undefined for opencode', () => {
    expect(agentLoginCommand('opencode')).toBeUndefined();
  });

  it('returns undefined for qwen', () => {
    expect(agentLoginCommand('qwen')).toBeUndefined();
  });

  it('returns undefined for droid', () => {
    expect(agentLoginCommand('droid')).toBeUndefined();
  });

  it('returns undefined for an unknown agent identifier', () => {
    expect(agentLoginCommand('unknown-agent-xyz')).toBeUndefined();
  });

  it('returns undefined for null input', () => {
    expect(agentLoginCommand(null)).toBeUndefined();
  });

  it('returns undefined for undefined input', () => {
    expect(agentLoginCommand(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(agentLoginCommand('')).toBeUndefined();
  });
});
