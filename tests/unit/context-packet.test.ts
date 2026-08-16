import { describe, it, expect } from 'vitest';
import {
  buildSessionHistoryReference,
} from '../../src/main/agent/handoff/session-history-reference';

describe('buildSessionHistoryReference', () => {
  it('includes source agent display name', () => {
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'claude',
      sessionFilePath: '/path/to/session.jsonl',
      targetHasMcpAccess: false,
    });

    expect(prompt).toContain('Claude Code');
  });

  it('includes session file path when available', () => {
    const filePath = '/home/user/.claude/projects/slug/session-id.jsonl';
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'codex',
      sessionFilePath: filePath,
      targetHasMcpAccess: false,
    });

    expect(prompt).toContain(filePath);
    expect(prompt).toContain('Read the prior session history');
  });

  it('wraps structured fields in a <handoff_context> envelope', () => {
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'claude',
      sessionFilePath: '/path/to/session.jsonl',
      targetHasMcpAccess: false,
    });

    expect(prompt).toContain('<handoff_context>');
    expect(prompt).toContain('<source_agent>Claude Code</source_agent>');
    expect(prompt).toContain('<session_history_path>/path/to/session.jsonl</session_history_path>');
    expect(prompt).toContain('</handoff_context>');
  });

  it('self-closes session_history_path when no file is available', () => {
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'aider',
      sessionFilePath: null,
      targetHasMcpAccess: false,
    });

    expect(prompt).toContain('<session_history_path />');
  });

  it('escapes XML special chars in session file path', () => {
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'claude',
      sessionFilePath: '/tmp/foo & <bar>/"baz".jsonl',
      targetHasMcpAccess: false,
    });

    expect(prompt).toContain('&amp;');
    expect(prompt).toContain('&lt;bar&gt;');
    expect(prompt).toContain('&quot;baz&quot;');
  });

  it('adds MCP hint when target has MCP access', () => {
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'codex',
      sessionFilePath: '/path/to/session.jsonl',
      targetHasMcpAccess: true,
    });

    expect(prompt).toContain('kangentic_get_session_history');
  });

  it('does not add MCP hint when target lacks MCP access', () => {
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'claude',
      sessionFilePath: '/path/to/session.jsonl',
      targetHasMcpAccess: false,
    });

    expect(prompt).not.toContain('kangentic_get_session_history');
  });

  it('handles null session file path (no session history)', () => {
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'aider',
      sessionFilePath: null,
      targetHasMcpAccess: false,
    });

    expect(prompt).toContain('Aider');
    expect(prompt).toContain('No session history file');
    expect(prompt).toContain('git log');
  });

  it('maps all known agent names to display labels', () => {
    const agents = [
      { name: 'claude', display: 'Claude Code' },
      { name: 'gemini', display: 'Gemini CLI' },
      { name: 'codex', display: 'Codex CLI' },
      { name: 'aider', display: 'Aider' },
      { name: 'kimi', display: 'Kimi Code' },
      { name: 'droid', display: 'Droid' },
      { name: 'grok', display: 'Grok Build' },
    ];

    for (const { name, display } of agents) {
      const prompt = buildSessionHistoryReference({
        sourceAgent: name,
        sessionFilePath: '/path/to/file',
        targetHasMcpAccess: false,
      });
      expect(prompt).toContain(display);
    }
  });

  it('uses raw agent name for unknown agents', () => {
    const prompt = buildSessionHistoryReference({
      sourceAgent: 'custom-agent',
      sessionFilePath: '/path/to/file',
      targetHasMcpAccess: false,
    });

    expect(prompt).toContain('custom-agent');
  });
});
